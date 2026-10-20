// The full browser suite in parallel: JOBS worker processes (default 3), each with its own static server
// and chromium (lib/harness.mjs listens on port 0, so they never collide), pull suite files from one queue
// (the slow files do not pile up in one group) until it is empty.
//
//   NODE_PATH=/opt/node-tools/node_modules node test/run-parallel.mjs
//   JOBS=2 ONLY=<text>[|<text>…] NODE_PATH=… node test/run-parallel.mjs
//
// Each file's output is printed in one block when that file is done (never interleaved), then a summary of
// the failing files and suites. Each of these is a FAIL and the run goes on:
//   - a file whose register() throws;
//   - a file that runs longer than FILE_TIMEOUT_S (default 600): its worker is killed, a fresh one takes the rest;
//   - a worker that dies while running a file: that file fails once, a fresh worker takes the rest;
//   - a worker that is not ready within START_TIMEOUT_S (default 120): it is dropped, not replaced.
// A worker that dies while idle (between files) is not replaced either. Whatever the dropped workers leave in the
// queue, the others still run it; with no worker left, every file nobody ran is listed as a "never ran" FAIL, so
// the run can never pass silently. ONLY= works as in run.mjs (a filter that matches no suite fails the run).
// test/run.mjs stays the one-process runner; this file only runs the same suite files.
import { readdirSync } from 'node:fs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SUITES_DIR = new URL('./suites/', import.meta.url);

// ── worker: one harness, runs the files the parent hands it ─────────────────────────────
if (process.argv[2] === '--worker') {
  let buf = [];
  const orig = console.log;
  console.log = (...a) => { buf.push(a.map(String).join(' ')); };
  console.error = console.log;
  const { stats, browser, server } = await import('./lib/harness.mjs');
  const runFile = async f => {
    buf = [];
    const failed0 = stats.failed, ran0 = stats.ran, t0 = Date.now();
    try {
      const { default: register } = await import(new URL(f, SUITES_DIR));
      if (typeof register !== 'function') throw new Error('must export default an async function that registers its suites');
      await register();
    } catch (e) {
      stats.failed++;
      console.log(`\nFAIL  test/suites/${f} aborted: ${String(e && e.message).split('\n')[0]}`);
    }
    // the failing suites by name: the last "# name" header before each FAIL line
    const names = [];
    let cur = '(no suite header)';
    for (const l of buf.join('\n').split('\n')) {
      if (l.startsWith('# ')) cur = l.slice(2);
      else if (/^\s*FAIL/.test(l) && !names.includes(cur)) names.push(l.includes(' aborted: ') ? `${cur} -> ${l.trim()}` : cur);
    }
    return { file: f, failed: stats.failed - failed0, ran: stats.ran - ran0, ms: Date.now() - t0, out: buf.join('\n'), names };
  };
  process.on('message', async msg => {
    if (msg.file) { process.send({ result: await runFile(msg.file) }); return; }
    if (msg.done) {
      await browser.close().catch(() => {});
      server.close();
      console.log = orig;
      process.disconnect();
      process.exit(0);
    }
  });
  process.send({ ready: true });
} else {
  // ── parent ────────────────────────────────────────────────────────────────────────────
  const JOBS = Math.max(1, parseInt(process.env.JOBS, 10) || 3);
  const FILE_TIMEOUT_MS = (parseInt(process.env.FILE_TIMEOUT_S, 10) || 600) * 1000;
  const START_TIMEOUT_MS = (parseInt(process.env.START_TIMEOUT_S, 10) || 120) * 1000;
  let startFailures = 0;
  const files = readdirSync(SUITES_DIR).filter(f => f.endsWith('.mjs')).sort();
  const queue = [...files];
  const results = [];
  const t0 = Date.now();
  const self = fileURLToPath(import.meta.url);
  const live = new Set();
  // never leave a worker (and its chromium) behind, whatever way this process ends
  // A worker's chromium is playwright's own child, driven over a pipe (--remote-debugging-pipe): it quits when the pipe
  // closes, i.e. when its worker dies, so killing the worker is enough (checked: no headless_shell left after a timeout).
  const kill = c => { try { c.kill('SIGKILL'); } catch { /* gone */ } };
  process.on('exit', () => { for (const c of live) kill(c); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130));

  const startWorker = () => new Promise(resolve => {
    const child = fork(self, ['--worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    live.add(child);
    let current = null, timer = null, finished = false, handedOver = false;
    const end = () => { if (!finished) { finished = true; clearTimeout(timer); resolve(); } };
    const feed = () => {
      current = queue.shift();
      if (!current) { child.send({ done: true }); return; }
      child.send({ file: current });
      timer = setTimeout(() => {
        results.push({ file: current, failed: 1, ran: 0, ms: FILE_TIMEOUT_MS, names: [`(file timed out after ${FILE_TIMEOUT_MS / 1000}s; its worker was killed)`],
          out: `\nFAIL  test/suites/${current} timed out after ${FILE_TIMEOUT_MS / 1000}s` });
        console.log(`\n## test/suites/${current}  (TIMED OUT)`);
        current = null;
        handedOver = true;
        kill(child);
        // a fresh worker carries on with the rest of the queue
        startWorker().then(end);
      }, FILE_TIMEOUT_MS);
    };
    // a worker that never gets ready (chromium does not start, ...) is dropped after START_TIMEOUT_MS, not replaced
    // (a replacement would most likely hang the same way); files nobody ran are reported as "never ran" FAILs
    const startTimer = setTimeout(() => {
      console.log(`\nFAIL  a worker did not start within ${START_TIMEOUT_MS / 1000}s; dropped`);
      startFailures++;
      handedOver = true;
      kill(child);
      end();
    }, START_TIMEOUT_MS);
    child.on('message', msg => {
      if (msg.ready) { clearTimeout(startTimer); feed(); return; }
      if (msg.result) {
        clearTimeout(timer);
        const r = msg.result;
        results.push(r);
        console.log(`\n## test/suites/${r.file}  (${(r.ms / 1000).toFixed(1)}s${r.failed ? `, ${r.failed} failing` : ''})${r.out}`);
        current = null;
        feed();
      }
    });
    child.on('exit', code => {
      live.delete(child);
      clearTimeout(startTimer);
      if (handedOver) return;                       // the timeout path already started the replacement
      if (current) {
        // died mid-file (a crash, or between being handed the file and answering; not our timeout kill, which set
        // handedOver): that file is recorded once as a FAIL and a fresh worker carries on with the rest of the queue
        clearTimeout(timer);
        results.push({ file: current, failed: 1, ran: 0, ms: 0, names: [`(worker exited with code ${code})`], out: '' });
        console.log(`\n## test/suites/${current}  (WORKER EXITED ${code})`);
        current = null;
        handedOver = true;
        startWorker().then(end);
        return;
      }
      if (code === 2 && !finished && !results.length) { console.error('worker could not start (playwright missing?)'); process.exit(2); }
      end();
    });
  });

  await Promise.all(Array.from({ length: Math.min(JOBS, files.length) }, startWorker));

  const ONLY = process.env.ONLY || '';
  const failedFiles = results.filter(r => r.failed).sort((a, b) => a.file.localeCompare(b.file));
  let failed = results.reduce((n, r) => n + r.failed, 0) + startFailures;
  const ran = results.reduce((n, r) => n + r.ran, 0);
  const missing = files.filter(f => !results.some(r => r.file === f));
  if (missing.length) { failed += missing.length; console.log(`\nFAIL  never ran: ${missing.join(', ')}`); }
  if (!ran) { failed++; console.log(`\nFAIL  ONLY=${JSON.stringify(ONLY)} matched no suite`); }
  const wall = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n════ summary: ${files.length} files, ${ran} suites ran, JOBS=${JOBS}, ${wall}s wall`);
  if (ONLY) console.log(`(ONLY=${JSON.stringify(ONLY)}: ${ran} suites ran, the rest were skipped)`);
  for (const r of failedFiles) {
    console.log(`  FAIL  test/suites/${r.file}  (${r.failed})`);
    for (const n of r.names) console.log(`          ${n}`);
  }
  const slow = [...results].sort((a, b) => b.ms - a.ms).slice(0, 5).map(r => `${r.file} ${(r.ms / 1000).toFixed(0)}s`);
  console.log(`  slowest: ${slow.join(', ')}`);
  console.log(failed ? `\n${failed} failing` : '\nall passed');
  process.exit(failed ? 1 : 0);
}
