// Browser suites: upload.html on a phone (390x844, DPR 3) and the retry path for failed uploads.
//  Layout: below 769px the folder tree is a full-width panel ABOVE the drop zone (own scroll, max 40vh), the page
//   scrolls as a document, taps are >= 44px, nothing overflows sideways; the back link goes to dashboard.html
//   without a project. At 1280 every computed style listed in lib/upload-desktop-baseline.json stays as it was.
//  Retry: network errors / timeouts / 5xx / 429 retry by themselves twice (2 s, 5 s); 401, 403, 413, other 4xx
//   never do; a failed row has 重試, the queue header has 重試全部失敗項目; counters are never double counted;
//   offline waits instead of burning retries.
// Chromium only, not real iOS Safari or a real cellular network. Registered by test/run.mjs; see test/README.md.
import { readFileSync } from 'node:fs';
import { base, suite } from '../lib/harness.mjs';
import { MOBILE, PIXEL } from '../lib/env.mjs';
import { ADMIN_PLAIN, adminMock } from '../lib/auth-mocks.mjs';
import { uploadFake } from '../lib/upload-fake.mjs';

export default async function register() {
const lines = () => { const out = []; return { out, ok: (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`) }; };
const DESKTOP = { viewport: { width: 1280, height: 900 } };
const BASE = JSON.parse(readFileSync(new URL('../lib/upload-desktop-baseline.json', import.meta.url), 'utf8'));
const LOCKED = `${base}/upload.html?folder=${encodeURIComponent('shoot/')}&lock=1`;
const png = name => ({ name, mimeType: 'image/png', buffer: PIXEL });

// Backoff waits (2 s / 5 s) are recorded and then run in 10 ms, so the suite stays fast but still sees the delays.
const RETRY_INIT = () => {
  sessionStorage.setItem('studio_token', 'adm');
  window.__delays = [];
  const st = window.setTimeout;
  window.setTimeout = (fn, ms, ...a) => { if (ms >= 1500 && ms <= 6000) { window.__delays.push(ms); ms = 10; } return st(fn, ms, ...a); };
};

const settle = async (page, timeout = 15000) => {
  await page.waitForFunction(() => queue.length > 0 && queue.every(q => q.state === 'done' || q.state === 'error') && activeCount === 0, null, { timeout });
  await page.waitForTimeout(250);   // renderOverall runs on the next animation frame
};
const snap = page => page.evaluate(() => {
  const shown = id => { const e = document.getElementById(id); return !!e && !e.hidden && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0; };
  return {
    states: Object.fromEntries(queue.map(q => [q.path, q.state])),
    status: Object.fromEntries([...document.querySelectorAll('.queue-item')].map(e => [e.querySelector('.qi-name').textContent, e.querySelector('.qi-status').textContent])),
    nQueue: queue.length, nRows: document.querySelectorAll('.queue-item').length, nRetry: document.querySelectorAll('.queue-item .qi-retry').length,
    label: document.getElementById('overallLabel').textContent, pct: document.getElementById('overallPct').textContent,
    barClass: document.getElementById('overallBar').className,
    retryAll: shown('retryAllBtn'), retryAllText: (document.getElementById('retryAllBtn') || {}).textContent,
    delays: window.__delays || [], thumbN: THUMB_SIZES.length,
  };
});

// ───────────────────────── JOB B: retry ─────────────────────────
{
  const f = uploadFake({ plan: { 'shoot/a.png': ['abort', 'abort', 'ok'] } });
  await suite('upload retry — network error twice then ok: 3 PUTs, waits 2 s then 5 s, ends all-success, thumbnails once',
    LOCKED, async page => {
      const { out, ok } = lines();
      await page.setInputFiles('#fileInput', [png('a.png')]);
      await settle(page);
      const s = await snap(page);
      ok('the original was PUT 3 times (2 failures + 1 success)', f.puts.filter(p => p.key === 'shoot/a.png').length === 3, JSON.stringify(f.puts));
      ok('backoff 2000 ms then 5000 ms', JSON.stringify(s.delays) === '[2000,5000]', JSON.stringify(s.delays));
      ok('the row ends done (positive: the rows exist)', s.nRows === 1 && s.states['a.png'] === 'done', JSON.stringify(s));
      ok('label is all-success', s.label === '全部上傳完成（1 張）' && s.pct === '100%', s.label);
      ok('bar is the success colour, not red', /complete/.test(s.barClass) && !/has-error/.test(s.barClass), s.barClass);
      ok('thumbnails are uploaded once, after the success (not per attempt)', f.thumbs.length === s.thumbN, JSON.stringify(f.thumbs));
      ok('no retry buttons and 重試全部 hidden when nothing failed (positive: queue visible)', s.nRetry === 0 && !s.retryAll && s.nRows === 1, JSON.stringify(s));
      return out;
    }, { before: f.attach, initScript: RETRY_INIT, contextOptions: MOBILE });
}

{
  const f = uploadFake({ plan: { 'shoot/a.png': [503], 'shoot/b.png': [429], 'shoot/c.png': [500, 502] } });
  await suite('upload retry — 503 / 429 / 500 / 502 are retried (positive control for the no-retry suite)',
    LOCKED, async page => {
      const { out, ok } = lines();
      await page.setInputFiles('#fileInput', [png('a.png'), png('b.png'), png('c.png')]);
      await settle(page);
      const s = await snap(page);
      const n = k => f.puts.filter(p => p.key === k).length;
      ok('503 -> 2 PUTs, 429 -> 2 PUTs, 500+502 -> 3 PUTs', n('shoot/a.png') === 2 && n('shoot/b.png') === 2 && n('shoot/c.png') === 3, JSON.stringify(f.puts));
      ok('delays: 2000 for a, 2000 for b, 2000 + 5000 for c', JSON.stringify([...s.delays].sort((x, y) => x - y)) === '[2000,2000,2000,5000]', JSON.stringify(s.delays));
      ok('all three done, label 3 張', Object.values(s.states).length === 3 && Object.values(s.states).every(v => v === 'done') && s.label === '全部上傳完成（3 張）', JSON.stringify(s));
      return out;
    }, { before: f.attach, initScript: RETRY_INIT, contextOptions: MOBILE });
}

{
  const f = uploadFake({ plan: { 'shoot/x.png': [503, 503, 503] } });
  await suite('upload retry — gives up after 2 auto retries; 重試 re-queues the SAME row, counters never double count, thumbnails sent then',
    LOCKED, async page => {
      const { out, ok } = lines();
      await page.setInputFiles('#fileInput', [png('x.png'), png('y.png')]);
      await settle(page);
      let s = await snap(page);
      const n = k => f.puts.filter(p => p.key === k).length;
      ok('x was tried 3 times (1 + 2 auto retries), not more', n('shoot/x.png') === 3, JSON.stringify(f.puts));
      ok('x is error, y is done', s.states['x.png'] === 'error' && s.states['y.png'] === 'done', JSON.stringify(s.states));
      ok('the failed row says why and how many retries: 伺服器忙碌 + 已重試 2 次', /伺服器忙碌/.test(s.status['x.png']) && /已重試 2 次/.test(s.status['x.png']), s.status['x.png']);
      ok('label counts once: 完成（1 成功 · 1 失敗）, 100%', s.label === '完成（1 成功 · 1 失敗）' && s.pct === '100%', s.label);
      ok('bar is red (has-error) only when everything finished', /has-error/.test(s.barClass), s.barClass);
      ok('exactly one 重試 button, on the failed row only', s.nRetry === 1 && (await page.$$eval('.queue-item.error .qi-retry', e => e.length)) === 1 && (await page.$$eval('.queue-item.done .qi-retry', e => e.length)) === 0, JSON.stringify(s));
      ok('the 重試全部失敗項目 button is shown while a row failed', s.retryAll && s.retryAllText === '重試全部失敗項目', JSON.stringify([s.retryAll, s.retryAllText]));
      ok('no thumbnails for x yet (it never got uploaded); y has its own', !f.thumbs.some(k => k.includes('x.png')) && f.thumbs.filter(k => k.includes('y.png')).length === s.thumbN, JSON.stringify(f.thumbs));
      const idsBefore = await page.evaluate(() => queue.map(q => q.id).join());
      await page.click('.queue-item.error .qi-retry');
      await settle(page);
      s = await snap(page);
      ok('x PUT a 4th time to the same key and is done', n('shoot/x.png') === 4 && s.states['x.png'] === 'done', JSON.stringify(f.puts));
      ok('still ONE queue entry per file: 2 entries, 2 rows, same ids', s.nQueue === 2 && s.nRows === 2 && (await page.evaluate(() => queue.map(q => q.id).join())) === idsBefore, JSON.stringify(s));
      ok('y was NOT re-uploaded by x\'s retry', n('shoot/y.png') === 1, JSON.stringify(f.puts));
      ok('label turned all-success: 全部上傳完成（2 張） 100%', s.label === '全部上傳完成（2 張）' && s.pct === '100%' && /complete/.test(s.barClass), s.label + ' ' + s.barClass);
      ok('x\'s row lost its error text and retry button; 重試全部 hidden', !/伺服器忙碌|已重試/.test(s.status['x.png']) && s.nRetry === 0 && !s.retryAll, JSON.stringify(s));
      ok('thumbnails of x were generated and uploaded after the retry (all sizes, once)', f.thumbs.filter(k => k.includes('x.png')).length === s.thumbN, JSON.stringify(f.thumbs));
      return out;
    }, { before: f.attach, initScript: RETRY_INIT, contextOptions: MOBILE });
}

{
  const f = uploadFake({ plan: { 'shoot/a413.png': [413], 'shoot/a403.png': [403], 'shoot/a400.png': [400], 'shoot/a404.png': [404], 'shoot/b503.png': [503] } });
  await suite('upload retry — 413 / 403 / 400 / 404 are NOT retried (reason shown); 重試全部 re-queues them without duplicates',
    LOCKED, async page => {
      const { out, ok } = lines();
      await page.setInputFiles('#fileInput', [png('a413.png'), png('a403.png'), png('a400.png'), png('a404.png'), png('b503.png')]);
      await settle(page);
      let s = await snap(page);
      const n = k => f.puts.filter(p => p.key === k).length;
      ok('positive control: the 503 file WAS retried (2 PUTs) and is done', n('shoot/b503.png') === 2 && s.states['b503.png'] === 'done', JSON.stringify(f.puts));
      ok('each 4xx file was PUT exactly once', ['a413', 'a403', 'a400', 'a404'].every(k => n(`shoot/${k}.png`) === 1), JSON.stringify(f.puts));
      ok('the only wait was the 503 one', JSON.stringify(s.delays) === '[2000]', JSON.stringify(s.delays));
      ok('413 says the file is too big', /檔案太大/.test(s.status['a413.png']), s.status['a413.png']);
      ok('403 says no permission', /沒有權限/.test(s.status['a403.png']), s.status['a403.png']);
      ok('other 4xx shows HTTP code', /HTTP 400/.test(s.status['a400.png']) && /HTTP 404/.test(s.status['a404.png']), JSON.stringify(s.status));
      ok('no "已重試" text on rows that never retried', !/已重試/.test(s.status['a413.png'] + s.status['a403.png']), JSON.stringify(s.status));
      ok('4 failed rows, 4 重試 buttons, label 1 成功 · 4 失敗', s.nRetry === 4 && s.label === '完成（1 成功 · 4 失敗）', s.label + ' ' + s.nRetry);
      await page.click('#retryAllBtn');
      await settle(page);
      s = await snap(page);
      ok('重試全部失敗項目 re-queued the 4 (second PUT each succeeds); the done one untouched', ['a413', 'a403', 'a400', 'a404'].every(k => n(`shoot/${k}.png`) === 2) && n('shoot/b503.png') === 2, JSON.stringify(f.puts));
      ok('5 entries, 5 rows (no duplicates), all done, label 5 張, button gone', s.nQueue === 5 && s.nRows === 5 && Object.values(s.states).every(v => v === 'done') && s.label === '全部上傳完成（5 張）' && !s.retryAll, JSON.stringify(s));
      ok('thumbnails for every file exactly once', f.thumbs.length === 5 * s.thumbN, String(f.thumbs.length));
      return out;
    }, { before: f.attach, initScript: RETRY_INIT, contextOptions: MOBILE });
}

{
  const f = uploadFake({ plan: { 'shoot/a.png': [401] } });
  await suite('upload retry — 401 is never retried; the row says 未登入; 重試 does not send anything without a token',
    LOCKED, async page => {
      const { out, ok } = lines();
      await page.setInputFiles('#fileInput', [png('a.png')]);
      await settle(page);
      let s = await snap(page);
      ok('one PUT, no backoff', f.puts.length === 1 && s.delays.length === 0, JSON.stringify([f.puts, s.delays]));
      ok('the row says 未登入', /未登入/.test(s.status['a.png']) && s.states['a.png'] === 'error', JSON.stringify(s.status));
      ok('it has a 重試 button (positive)', s.nRetry === 1, String(s.nRetry));
      await page.click('.qi-retry');
      await page.waitForTimeout(400);
      s = await snap(page);
      ok('retry with the token gone sends nothing and says 未登入 again', f.puts.length === 1 && s.states['a.png'] === 'error' && /未登入/.test(s.status['a.png']), JSON.stringify([f.puts.length, s.status]));
      return out;
    }, { before: f.attach, initScript: RETRY_INIT, contextOptions: MOBILE });
}

{
  const f = uploadFake({ plan: Object.fromEntries(['a', 'b', 'c'].map(k => [`shoot/${k}.png`, [503, 503, 503]])) });
  await suite('upload retry — 重試全部失敗項目: only the failed rows, one entry each, mixed with a done row',
    LOCKED, async page => {
      const { out, ok } = lines();
      await page.setInputFiles('#fileInput', [png('a.png'), png('b.png'), png('c.png'), png('d.png')]);
      await settle(page);
      let s = await snap(page);
      ok('3 failed + 1 done, label 完成（1 成功 · 3 失敗）', s.label === '完成（1 成功 · 3 失敗）' && s.retryAll, JSON.stringify(s));
      const before = await page.evaluate(() => queue.map(q => q.id));
      await page.click('#retryAllBtn');
      await settle(page);
      s = await snap(page);
      const n = k => f.puts.filter(p => p.key === k).length;
      ok('the 3 failed were PUT a 4th time; d (done) was PUT once', ['a', 'b', 'c'].every(k => n(`shoot/${k}.png`) === 4) && n('shoot/d.png') === 1, JSON.stringify(f.puts.map(p => p.key + p.n)));
      ok('same 4 entries, same ids, 4 rows', s.nQueue === 4 && s.nRows === 4 && (await page.evaluate(() => queue.map(q => q.id))).join() === before.join(), JSON.stringify(s));
      ok('all-success label 4 張; the button is gone', s.label === '全部上傳完成（4 張）' && !s.retryAll, s.label);
      ok('each file\'s thumbnails exactly once (4 x sizes)', f.thumbs.length === 4 * s.thumbN, String(f.thumbs.length));
      return out;
    }, { before: f.attach, initScript: RETRY_INIT, contextOptions: MOBILE });
}

{
  const f = uploadFake({ delayMs: 150 });
  await suite('upload retry — concurrency still 4 at a time (8 files)',
    LOCKED, async page => {
      const { out, ok } = lines();
      await page.setInputFiles('#fileInput', Array.from({ length: 8 }, (_, i) => png(`p${i}.png`)));
      await settle(page);
      const s = await snap(page);
      ok('all 8 uploaded', Object.values(s.states).length === 8 && Object.values(s.states).every(v => v === 'done') && f.puts.length === 8, JSON.stringify(s.states));
      ok('never more than 4 PUTs in flight, and at least 3 were (floor: the pump ran in parallel)', f.maxInflight <= 4 && f.maxInflight >= 3, String(f.maxInflight));
      return out;
    }, { before: f.attach, initScript: RETRY_INIT, contextOptions: MOBILE });
}

{
  const f = uploadFake();
  await suite('upload retry — offline: nothing is sent, the page says 離線，恢復網路後自動重試, online resumes',
    LOCKED, async page => {
      const { out, ok } = lines();
      await page.context().setOffline(true);
      await page.waitForFunction(() => navigator.onLine === false);
      await page.setInputFiles('#fileInput', [png('a.png'), png('b.png')]);
      await page.waitForTimeout(600);
      let s = await snap(page);
      ok('no request left the page while offline', f.puts.length === 0, JSON.stringify(f.puts));
      ok('both rows are still waiting (pending), none failed', s.nRows === 2 && Object.values(s.states).every(v => v === 'pending'), JSON.stringify(s.states));
      ok('the overall label says 離線，恢復網路後自動重試', /離線，恢復網路後自動重試/.test(s.label), s.label);
      await page.context().setOffline(false);
      await settle(page);
      s = await snap(page);
      ok('back online: both uploaded, all-success, offline text gone', f.puts.length === 2 && s.label === '全部上傳完成（2 張）' && Object.values(s.states).every(v => v === 'done'), JSON.stringify([f.puts.length, s.label]));
      ok('no retries were burned and no backoff waited', s.delays.length === 0 && Object.values(s.status).every(t => !/已重試/.test(t)), JSON.stringify([s.delays, s.status]));
      return out;
    }, { before: f.attach, initScript: RETRY_INIT, contextOptions: MOBILE });
}

{
  let page0;
  const f = uploadFake({ plan: { 'shoot/a.png': ['abort'] } });
  f.hook = async (key, outcome) => { if (outcome === 'abort') await page0.context().setOffline(true); };
  await suite('upload retry — going offline mid-upload: waits for the network, does NOT use up a retry, finishes once online',
    LOCKED, async page => {
      page0 = page;
      const { out, ok } = lines();
      await page.setInputFiles('#fileInput', [png('a.png')]);
      await page.waitForTimeout(800);
      let s = await snap(page);
      ok('exactly one PUT so far (the one that died), no second attempt while offline', f.puts.length === 1, JSON.stringify(f.puts));
      ok('the row is not failed; the page says 離線，恢復網路後自動重試', s.states['a.png'] !== 'error' && /離線，恢復網路後自動重試/.test(s.label), JSON.stringify([s.states, s.label]));
      ok('no backoff wait was scheduled for it', s.delays.length === 0, JSON.stringify(s.delays));
      await page.context().setOffline(false);
      await settle(page);
      s = await snap(page);
      ok('online again: PUT #2 succeeded, row done, all-success, no "已重試" shown', f.puts.length === 2 && s.states['a.png'] === 'done' && s.label === '全部上傳完成（1 張）' && !/已重試/.test(s.status['a.png']), JSON.stringify([f.puts, s.label, s.status]));
      ok('still no backoff, so the retry budget was untouched', s.delays.length === 0, JSON.stringify(s.delays));
      return out;
    }, { before: f.attach, initScript: RETRY_INIT, contextOptions: MOBILE });
}

// ───────────────────────── JOB A: phone layout ─────────────────────────
const TREE = { '': Array.from({ length: 30 }, (_, i) => `2026${String(i + 1).padStart(2, '0')}/`), '202601/': ['202601/Anita/', '202601/毛片/'] };
const fixture = () => {
  const mk = (name, path, state, extra = {}) => ({ id: 'q' + Math.random().toString(36).slice(2), file: { name, size: 3.2 * 1024 * 1024 }, path, state, progress: 0, error: null, ...extra });
  queue.push(mk('IMG_0001.jpg', 'IMG_0001.jpg', 'done', { progress: 100 }),
    mk('IMG_0003.jpg', 'IMG_0003.jpg', 'pending'),
    mk('IMG_0004.heic', 'IMG_0004.heic', 'error', { error: '網路錯誤', attempts: 2 }),
    mk('IMG_0006.jpg', '毛片/IMG_0006.jpg', 'done', { progress: 100 }));
  renderQueue();
  document.getElementById('overallWrap').classList.add('visible');
  document.getElementById('queueSection').style.display = '';
  renderOverall();
};

{
  const m = adminMock({ tree: TREE });
  await suite('upload phone 390x844 — tree first, drop zone readable, no sideways scroll, page scrolls, taps >= 44px',
    `${base}/upload.html`, async page => {
      const { out, ok } = lines();
      await page.waitForSelector('.sb-node', { timeout: 5000 });
      await page.click('.sb-node[data-path="202601/"] > .sb-row > .sb-toggle');
      await page.waitForSelector('.sb-node[data-path="202601/Anita/"]');
      await page.evaluate(fixture);
      await page.waitForTimeout(300);
      const g = await page.evaluate(() => {
        const R = s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
        const vis = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
        const lineCount = el => { const rg = document.createRange(); rg.selectNodeContents(el); return new Set([...rg.getClientRects()].map(r => Math.round(r.top))).size; };
        const title = document.querySelector('.drop-title');
        const tp = document.querySelector('.target-path');
        const tree = document.querySelector('.sidebar-tree'), sb = document.querySelector('.sidebar');
        const taps = [...document.querySelectorAll('button, a[href], summary, input:not([type=file]), select')].filter(vis)
          .map(e => { const r = e.getBoundingClientRect(); return { n: (e.id || e.className || e.tagName) + ':' + (e.textContent || '').trim().slice(0, 8), w: Math.round(r.width), h: Math.round(r.height) }; });
        const header = R('.header');
        const hk = [...document.querySelectorAll('.header .btn-back, .header .header-logo')].filter(vis).map(e => e.getBoundingClientRect());
        return {
          sw: document.documentElement.scrollWidth, iw: innerWidth, ih: innerHeight,
          sb: R('.sidebar'), main: R('.main'), dz: R('.drop-zone'), tb: R('.target-bar'), header,
          titleChars: title.textContent.length, titleLines: lineCount(title), titleW: title.getBoundingClientRect().width,
          tpText: tp.textContent, tpTrunc: tp.scrollWidth > tp.clientWidth,
          treeOy: getComputedStyle(tree).overflowY, treeScrollable: tree.scrollHeight > tree.clientHeight + 1, treeH: tree.getBoundingClientRect().height, sbH: sb.getBoundingClientRect().height,
          bodyOv: getComputedStyle(document.body).overflowY, htmlOv: getComputedStyle(document.documentElement).overflowY,
          layoutDir: getComputedStyle(document.querySelector('.layout')).flexDirection, layoutOv: getComputedStyle(document.querySelector('.layout')).overflow,
          mainPad: [getComputedStyle(document.querySelector('.main')).paddingLeft, getComputedStyle(document.querySelector('.main')).paddingRight],
          docH: document.documentElement.scrollHeight,
          headerRowTops: hk.map(r => Math.round(r.top)), headerRight: Math.max(...hk.map(r => r.right)), headerBottom: Math.max(...hk.map(r => r.bottom)),
          taps, nSbRows: document.querySelectorAll('.sb-row').length,
          queueOver: [...document.querySelectorAll('.queue-list *, .queue-header *, .overall-stats *')].filter(e => vis(e) && e.getBoundingClientRect().right > innerWidth + 0.5).map(e => e.className).slice(0, 4),
          queueScanned: document.querySelectorAll('.queue-list *, .queue-header *').length,
          wide: [...document.querySelectorAll('body *')].filter(e => vis(e) && !e.closest('.sidebar-tree') && e.getBoundingClientRect().right > innerWidth + 1).map(e => (e.id || e.className || e.tagName) + ':' + Math.round(e.getBoundingClientRect().right)).slice(0, 5),
          backText: document.querySelector('.header .btn-back').textContent.trim(), backHref: document.querySelector('.header .btn-back').getAttribute('href'),
        };
      });
      ok(`no horizontal page scroll (${g.sw} <= ${g.iw})`, g.sw <= g.iw, `${g.sw} > ${g.iw}`);
      ok('nothing visible (outside the tree\'s own scroll) sticks out past the viewport', g.wide.length === 0, JSON.stringify(g.wide));
      ok('queue rows / header / overall stats stay inside (floor: >= 30 elements scanned)', g.queueScanned >= 30 && g.queueOver.length === 0, JSON.stringify([g.queueScanned, g.queueOver]));
      ok('layout is a column and no longer clips', g.layoutDir === 'column' && g.layoutOv !== 'hidden', JSON.stringify([g.layoutDir, g.layoutOv]));
      ok('the folder tree comes FIRST (above the target bar and drop zone)', g.sb.b <= g.main.t + 1 && g.sb.t < g.dz.t, JSON.stringify([g.sb, g.main]));
      ok('tree panel is >= 80% of the viewport width', g.sb.w >= g.iw * 0.8, String(g.sb.w));
      ok('drop zone is >= 80% of the viewport width', g.dz.w >= g.iw * 0.8, String(g.dz.w));
      ok('main has 16px padding both sides', g.mainPad[0] === '16px' && g.mainPad[1] === '16px', JSON.stringify(g.mainPad));
      ok('tree panel is at most 40vh tall and scrolls on its own (30+ folders: content taller than box)', g.sbH <= g.ih * 0.4 + 2 && /auto|scroll/.test(g.treeOy) && g.treeScrollable, JSON.stringify([g.sbH, g.ih, g.treeOy, g.treeScrollable]));
      ok(`headline is not squeezed: >= 8 chars per line (${g.titleChars} chars in ${g.titleLines} line(s))`, g.titleLines >= 1 && g.titleChars / g.titleLines >= 8, JSON.stringify([g.titleChars, g.titleLines, g.titleW]));
      ok('target bar does not say 左側 on a phone (the tree is above), and is not cut', !/左側/.test(g.tpText) && !g.tpTrunc && /點選/.test(g.tpText), JSON.stringify([g.tpText, g.tpTrunc]));
      ok('page scrolls as a document: body/html not overflow:hidden, content taller than the screen', g.bodyOv !== 'hidden' && g.htmlOv !== 'hidden' && g.docH > g.ih, JSON.stringify([g.bodyOv, g.htmlOv, g.docH, g.ih]));
      ok('header stays one row (<= 56px, back link and logo on the same line)', g.header.h <= 56 && g.headerRowTops.length === 2 && Math.max(...g.headerRowTops) - Math.min(...g.headerRowTops) <= 2 && g.headerRight <= g.iw, JSON.stringify([g.header, g.headerRowTops, g.headerRight]));
      const small = g.taps.filter(t => t.h < 44 || t.w < 44);
      ok(`every tap target >= 44x44 (floor: >= 14 scanned, saw ${g.taps.length})`, g.taps.length >= 14 && small.length === 0, JSON.stringify(small));
      ok('the named ones are in the scan: 選擇檔案, 選擇資料夾, 清除已完成, 重試, 重試全部失敗項目, back link', ['選擇檔案', '選擇資料夾', '清除已完成', '重試', '重試全部失', '← 返回後台'].every(n => g.taps.some(t => t.n.includes(n.slice(0, 8)))), JSON.stringify(g.taps.map(t => t.n)));
      ok('back link without a project: 「← 返回後台」 -> dashboard.html', g.backText === '← 返回後台' && g.backHref === 'dashboard.html', JSON.stringify([g.backText, g.backHref]));
      await page.evaluate(() => window.scrollTo(0, 400));
      ok('scrolling the page actually moves it (not trapped)', (await page.evaluate(() => window.scrollY)) > 100);
      // picking a folder from the panel
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.tap('.sb-node[data-path="202601/"] > .sb-row .sb-name');
      const after = await page.evaluate(() => { const tp = document.querySelector('.target-path'); return { t: tp.textContent, trunc: tp.scrollWidth > tp.clientWidth, dz: document.getElementById('dropZone').classList.contains('no-target'), over: document.documentElement.scrollWidth <= innerWidth }; });
      ok('tapping a folder selects it: target shown whole, drop zone active, still no overflow', after.t === '202601/' && !after.trunc && !after.dz && after.over, JSON.stringify(after));
      return out;
    }, { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: MOBILE });
}

{
  const m = adminMock({ tree: TREE });
  await suite('upload phone — back link with ?project=: 「← 返回專案」 -> admin.html#project=<id> (unchanged)',
    `${base}/upload.html?project=${encodeURIComponent('a b&c#d')}`, async page => {
      const { out, ok } = lines();
      const r = await page.$eval('.header .btn-back', a => ({ t: a.textContent.trim(), h: a.getAttribute('href'), n: document.querySelectorAll('.btn-back').length }));
      ok('text and href', r.t === '← 返回專案' && r.h === 'admin.html#project=' + encodeURIComponent('a b&c#d') && r.n === 1, JSON.stringify(r));
      const box = await page.$eval('.header .btn-back', a => { const x = a.getBoundingClientRect(); return { h: x.height, r: x.right }; });
      ok('>= 44px tall, header one row', box.h >= 44 && (await page.$eval('.header', h => h.getBoundingClientRect().height)) <= 56, JSON.stringify(box));
      return out;
    }, { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: MOBILE });
}

{
  const m = adminMock({ tree: TREE });
  await suite('upload phone — folder-locked (?folder=…&lock=1): no tree, target locked, drop zone full width, no overflow',
    `${base}/upload.html?folder=${encodeURIComponent('20260819/客戶A/')}&lock=1&project=p1`, async page => {
      const { out, ok } = lines();
      await page.evaluate(fixture);
      await page.waitForTimeout(300);
      const g = await page.evaluate(() => {
        const R = s => { const r = document.querySelector(s).getBoundingClientRect(); return { l: r.left, r: r.right, w: r.width, t: r.top }; };
        const tp = document.querySelector('.target-path');
        const lc = el => { const rg = document.createRange(); rg.selectNodeContents(el); return new Set([...rg.getClientRects()].map(r => Math.round(r.top))).size; };
        return { sw: document.documentElement.scrollWidth, iw: innerWidth, sbDisplay: getComputedStyle(document.querySelector('.sidebar')).display, main: R('.main'), dz: R('.drop-zone'), tb: R('.target-bar'),
          tp: tp.textContent, trunc: tp.scrollWidth > tp.clientWidth, hint: document.getElementById('targetHint').textContent, locked: document.getElementById('targetBar').dataset.locked,
          tl: lc(document.querySelector('.drop-title')), tc: document.querySelector('.drop-title').textContent.length, dzActive: !document.getElementById('dropZone').classList.contains('no-target'),
          small: [...document.querySelectorAll('button, a[href], summary')].filter(e => e.getClientRects().length).filter(e => e.getBoundingClientRect().height < 44).map(e => e.id || e.className) };
      });
      ok('no sidebar at all, no sideways scroll', g.sbDisplay === 'none' && g.sw <= g.iw, JSON.stringify(g));
      ok('target is the locked folder, whole, with the 🔒 hint', g.tp === '20260819/客戶A/' && !g.trunc && g.hint === '🔒 已鎖定' && g.locked === '1', JSON.stringify([g.tp, g.trunc, g.hint]));
      ok('target bar and drop zone use the full width (>= 80%), drop zone active', g.tb.w >= g.iw * 0.8 && g.dz.w >= g.iw * 0.8 && g.dzActive, JSON.stringify([g.tb, g.dz]));
      ok('headline >= 8 chars per line', g.tc / g.tl >= 8, `${g.tc}/${g.tl}`);
      ok('taps >= 44px tall', g.small.length === 0, JSON.stringify(g.small));
      return out;
    }, { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: MOBILE });
}

{
  const m = adminMock({ tree: TREE });
  await suite('upload desktop 1280 — computed styles and boxes equal the pre-change baseline (JOB A must not touch >768px)',
    `${base}/upload.html`, async page => {
      const { out, ok } = lines();
      await page.waitForSelector('.sb-node', { timeout: 5000 });
      await page.evaluate(() => { queue.push({ id: 'x1', file: { name: 'a.jpg', size: 1000 }, path: 'a.jpg', state: 'pending', progress: 0, error: null }); renderQueue(); document.getElementById('queueSection').style.display = ''; });
      const now = await page.evaluate(([SEL, PROPS]) => Object.fromEntries(SEL.map(s => { const e = document.querySelector(s); const c = getComputedStyle(e); const r = e.getBoundingClientRect(); return [s, { ...Object.fromEntries(PROPS.map(p => [p, c[p]])), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }]; })), [BASE.SEL, BASE.PROPS]);
      let cmp = 0; const diffs = [];
      for (const s of BASE.SEL) for (const p of [...BASE.PROPS, 'rect']) {
        // the back link's text (and so its width and the logo's x) changes on purpose
        if (s === '.back-btn' && (p === 'width' || p === 'rect')) continue;
        cmp++;
        if (JSON.stringify(now[s][p]) !== JSON.stringify(BASE.out[s][p])) diffs.push(`${s} ${p}: ${JSON.stringify(BASE.out[s][p])} -> ${JSON.stringify(now[s][p])}`);
      }
      ok(`${cmp} (floor >= 300) computed values compared, all equal`, cmp >= 300 && diffs.length === 0, diffs.slice(0, 6).join(' | '));
      ok('tree is a 230px column left of main (positive)', now['.sidebar'].width === '230px' && now['.sidebar'].rect[0] === 0 && now['.main'].rect[0] === 230, JSON.stringify([now['.sidebar'].rect, now['.main'].rect]));
      ok('target text on desktop still points left', /左側/.test(await page.textContent('#targetDisplay')));
      return out;
    }, { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: DESKTOP });
}
}
