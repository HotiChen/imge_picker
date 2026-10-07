// The browser-test harness: one static file server for the repo, one Playwright
// chromium, and suite(), which opens a fresh context per suite and prints its lines.
// Importing this module starts the server and the browser; test/run.mjs closes both.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { ROOT } from './env.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
};

export const server = createServer(async (req, res) => {
  let rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  // a directory URL serves its index.html, like the real host (imhoti.tw/studio/)
  if (rel.endsWith('/')) rel += 'index.html';
  try {
    const body = await readFile(join(ROOT, rel));
    res.writeHead(200, { 'Content-Type': TYPES[extname(rel)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
export const base = `http://127.0.0.1:${server.address().port}`;

// prefer a local install, fall back to a global one
async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* try global */ }
  try {
    const { execSync } = await import('node:child_process');
    const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return await import(join(root, 'playwright', 'index.mjs'));
  } catch { return null; }
}
const pw = await loadPlaywright();
if (!pw) {
  console.error('playwright not found — run: npm i -D playwright && npx playwright install chromium');
  server.close();
  process.exit(2);
}

export const browser = await pw.chromium.launch();

export const stats = { failed: 0, ran: 0 };


// ONLY=<text>[|<text>…] runs just the suites whose name contains that text, for quick
// iterations while developing; run everything before a commit or merge.
export const ONLY = process.env.ONLY || '';

export async function suite(name, url, run, { initScript, before, contextOptions, tour } = {}) {
  if (ONLY && !ONLY.split('|').some(t => t && name.includes(t))) return;
  stats.ran++;
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, ...contextOptions });
  // the first-visit guest tour (js/guest-tour.js) is marked seen in every suite, or its card would sit over the
  // page the suite drives; a suite that tests the tour passes `tour: true` and seeds the keys itself
  if (!tour) await context.addInitScript(() => { try { localStorage.setItem('guestTourPickingV1', '1'); localStorage.setItem('guestTourDeliveredV1', '1'); } catch (e) { /* ignore */ } });
  if (initScript) await context.addInitScript(initScript);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e).split('\n')[0]));
  if (before) await before(page);
  await page.goto(url, { waitUntil: 'load' });

  console.log(`\n# ${name}`);
  let lines;
  try {
    lines = await run(page);
  } catch (e) {
    lines = [`FAIL  suite threw: ${e.message}`];
  }
  for (const l of lines) {
    if (l.startsWith('FAIL')) stats.failed++;
    console.log('  ' + l);
  }
  if (pageErrors.length) {
    stats.failed++;
    console.log('  FAIL  page errors: ' + pageErrors.join(' | '));
  }
  await context.close();
}
