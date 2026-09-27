// Browser-based tests, for the parts that only have meaning in a real engine:
// CSS-driven crop geometry, and canvas thumbnail generation.
//
//   node test/run.mjs
//
// Needs Playwright's chromium (npx playwright install chromium). The Worker's
// own tests need none of this — run those with:
//
//   node --test "worker/test/*.test.mjs"
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
};

const server = createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(ROOT, rel));
    res.writeHead(200, { 'Content-Type': TYPES[extname(rel)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

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

const browser = await pw.chromium.launch();
let failed = 0;

// shared by the preview suite: what the page asked the Worker for
const asked = [];
const PREVIEW_Q = '?w=1200';
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

// Mobile task: a phone-shaped context — real Touch/TouchEvent construction
// needs hasTouch, and DPR3 is what makes the responsive-width formula ask
// for something other than the desktop bucket.
const MOBILE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 };

// Dispatches real TouchEvents on `selector` inside the page — Playwright has
// no built-in swipe/pinch, so gestures are driven with synthetic touches
// exactly as the task calls for. `sequence` is [{type, points: [{x,y,id}]}].
async function touchSequence(page, selector, sequence) {
  await page.evaluate(({ selector, sequence }) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error('touch target not found: ' + selector);
    for (const step of sequence) {
      const touches = (step.points || []).map(p => new Touch({
        identifier: p.id ?? 0, target: el, clientX: p.x, clientY: p.y, pageX: p.x, pageY: p.y,
      }));
      const ev = new TouchEvent(step.type, {
        touches: step.type === 'touchend' ? [] : touches,
        targetTouches: step.type === 'touchend' ? [] : touches,
        changedTouches: touches,
        bubbles: true, cancelable: true,
      });
      el.dispatchEvent(ev);
    }
  }, { selector, sequence });
}

// One-finger swipe from (x1,y1) to (x2,y2).
async function swipeTouch(page, selector, x1, y1, x2, y2, steps = 6) {
  const seq = [{ type: 'touchstart', points: [{ x: x1, y: y1 }] }];
  for (let i = 1; i <= steps; i++) {
    seq.push({ type: 'touchmove', points: [{ x: x1 + (x2 - x1) * i / steps, y: y1 + (y2 - y1) * i / steps }] });
  }
  seq.push({ type: 'touchend', points: [{ x: x2, y: y2 }] });
  await touchSequence(page, selector, seq);
}

async function tapTouch(page, selector, x, y) {
  await touchSequence(page, selector, [
    { type: 'touchstart', points: [{ x, y }] },
    { type: 'touchend', points: [{ x, y }] },
  ]);
}

async function doubleTapTouch(page, selector, x, y, gapMs = 100) {
  await tapTouch(page, selector, x, y);
  await page.waitForTimeout(gapMs);
  await tapTouch(page, selector, x, y);
}

// Two-finger pinch, centred on (cx,cy), from startDist to endDist apart.
async function pinchTouch(page, selector, cx, cy, startDist, endDist, steps = 6) {
  const half0 = startDist / 2;
  const seq = [{ type: 'touchstart', points: [{ x: cx - half0, y: cy, id: 0 }, { x: cx + half0, y: cy, id: 1 }] }];
  for (let i = 1; i <= steps; i++) {
    const half = (startDist + (endDist - startDist) * i / steps) / 2;
    seq.push({ type: 'touchmove', points: [{ x: cx - half, y: cy, id: 0 }, { x: cx + half, y: cy, id: 1 }] });
  }
  seq.push({ type: 'touchend', points: [] });
  await touchSequence(page, selector, seq);
}

// ONLY=<text> runs just the suites whose name contains that text, for quick
// iterations while developing; run everything before a commit or merge.
const ONLY = process.env.ONLY || '';
let ran = 0;

async function suite(name, url, run, { initScript, before, contextOptions } = {}) {
  if (ONLY && !name.includes(ONLY)) return;
  ran++;
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, ...contextOptions });
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
    if (l.startsWith('FAIL')) failed++;
    console.log('  ' + l);
  }
  if (pageErrors.length) {
    failed++;
    console.log('  FAIL  page errors: ' + pageErrors.join(' | '));
  }
  await context.close();
}

await suite('crop geometry — preview must match the exported JPEG',
  `${base}/book_editor/test/crop-geometry.test.html`,
  async page => (await page.evaluate(() => window.runTests()))
    .map(r => `${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.pass ? '' : `   [${r.detail}]`}`));

// Driven from here rather than from a test page, so no test code ships in
// upload.html — the functions under test are already globals on that page.
await suite('upload thumbnails — generation, key layout and error reporting',
  `${base}/upload.html`,
  page => page.evaluate(async () => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

    const c = document.createElement('canvas');
    c.width = 2400; c.height = 1600;
    const x = c.getContext('2d');
    x.fillStyle = '#48c'; x.fillRect(0, 0, 2400, 1600);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
    const file = new File([blob], 'test.jpg', { type: 'image/jpeg' });
    CONFIG.PHOTOGRAPHER_TOKEN = 'tok';

    const thumbs = await buildThumbnails(file);
    // one per configured size, whatever that list currently is
    ok('produces one thumbnail per configured size',
      thumbs.length === THUMB_SIZES.length &&
      THUMB_SIZES.every(sz => thumbs.some(t => t.size === sz)),
      `${thumbs.map(t => t.size).join(',')} vs ${THUMB_SIZES.join(',')}`);
    ok('thumbnails are far smaller than the original',
      thumbs.every(t => t.blob.size < blob.size / 4),
      thumbs.map(t => `${t.size}:${t.blob.size}B of ${blob.size}B`).join(', '));

    const realFetch = window.fetch;
    const seen = [];
    window.fetch = async (url, opt) => { seen.push({ url, method: opt.method }); return { ok: true, status: 200 }; };
    let warn = await uploadThumbnails({ file }, '20260819/合照/a.jpg');
    window.fetch = realFetch;

    ok('no warning when every upload succeeds', warn === null, String(warn));
    ok('writes every size', seen.length === THUMB_SIZES.length, String(seen.length));
    const keys = seen.map(s => decodeURIComponent(s.url.split('/').pop()));
    // the exact keys worker.js looks up for ?w=
    ok('keys match what the Worker reads back',
      THUMB_SIZES.every(sz => keys.includes(`_thumbs/${sz}/20260819/合照/a.jpg.thumb`)),
      keys.join(' | '));
    ok('uploads with PUT', seen.every(s => s.method === 'PUT'));

    // a silently swallowed failure is what hid missing thumbnails before
    window.fetch = async () => ({ ok: false, status: 401 });
    warn = await uploadThumbnails({ file }, 'k.jpg');
    window.fetch = realFetch;
    ok('a rejected upload is reported', /401/.test(warn || ''), String(warn));
    ok('the queue row shows it', itemStatusText({ state: 'done', thumbWarning: warn }) === '完成 · 無縮圖',
      itemStatusText({ state: 'done', thumbWarning: warn }));

    window.fetch = async () => { throw new Error('Failed to fetch'); };
    warn = await uploadThumbnails({ file }, 'k.jpg');
    window.fetch = realFetch;
    ok('a network error is reported', !!warn, String(warn));

    warn = await uploadThumbnails({ file: new File(['not an image'], 'x.heic', { type: 'image/heic' }) }, 'k.heic');
    ok('an undecodable file is reported, not thrown', !!warn, String(warn));

    ok('a clean upload stays quiet', itemStatusText({ state: 'done' }) === '完成');
    return out;
  }));

// The preview modal is the one place a photographer looks closely, so it has
// to stay cheap to page through and still able to show the real pixels.
await suite('photo preview — size, neighbour preloading and the original',
  `${base}/book_editor/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

    await page.evaluate(() => {
      bookEditor.libraryPhotos = Array.from({ length: 5 }, (_, i) =>
        ({ id: `2026/p${i}.jpg`, name: `p${i}.jpg`, rating: 0 }));
      bookEditor._showPreviewAt(2);
      document.getElementById('photoPreviewModal').classList.add('open');
      document.getElementById('tourCard')?.remove();
    });
    await page.waitForTimeout(500);

    const r = await page.evaluate(() => ({
      shown: document.getElementById('photoPreviewImg').getAttribute('src'),
      dl: document.getElementById('photoPreviewDownload')?.getAttribute('href'),
      btn: document.getElementById('photoPreviewOriginalBtn')?.textContent,
    }));
    ok('preview asks for a downscaled copy, not the original', /\?w=\d+$/.test(r.shown || ''), r.shown);
    ok('preloads the next photo', asked.includes('/2026/p3.jpg' + PREVIEW_Q), asked.join(' '));
    ok('preloads the previous photo', asked.includes('/2026/p1.jpg' + PREVIEW_Q), asked.join(' '));
    ok('does not preload the whole strip', !asked.some(u => u.startsWith('/2026/p0')), asked.join(' '));
    ok('download offers the original', /\/2026\/p2\.jpg$/.test(r.dl || ''), r.dl);
    ok('the original button is offered', r.btn === '看原圖', r.btn);

    await page.click('#photoPreviewOriginalBtn');
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => ({
      src: document.getElementById('photoPreviewImg').getAttribute('src'),
      btn: document.getElementById('photoPreviewOriginalBtn').textContent,
    }));
    ok('看原圖 swaps in the un-resized image', /\/2026\/p2\.jpg$/.test(after.src || ''), after.src);
    ok('and says so', after.btn === '已是原圖', after.btn);
    return out;
  },
  {
    initScript: () => {
      sessionStorage.setItem('studio_token', 'x');
      try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) {}
    },
    before: async page => {
      asked.length = 0;
      // stand in for the Worker so the test records what was requested
      await page.route('**/imagepicker.hotichen.workers.dev/**', route => {
        const u = new URL(route.request().url());
        if (u.pathname.startsWith('/api/') || u.searchParams.has('list')) {
          return route.fulfill({ status: 200, contentType: 'application/json',
            body: JSON.stringify({ status: 'success', data: [], folders: [] }) });
        }
        asked.push(decodeURIComponent(u.pathname) + (u.search || ''));
        route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
      });
    },
  });

// A photo grid must never stack its own tiles on top of each other, and its
// scrollable height must actually reach the last photo. Both broke when the
// container handed the grid a definite height: the rows were squeezed to fit
// while the tiles kept the height their aspect-ratio gave them.
const GRID_CHECK = sel => {
  const g = document.querySelector(sel);
  if (!g) return { missing: true };
  const items = [...g.querySelectorAll('[data-photo-id]')];
  const box = items.map(i => i.getBoundingClientRect());
  let overlap = 0;
  for (let i = 0; i < box.length; i++) {
    for (let j = i + 1; j < box.length; j++) {
      const oy = Math.min(box[i].bottom, box[j].bottom) - Math.max(box[i].top, box[j].top);
      const ox = Math.min(box[i].right, box[j].right) - Math.max(box[i].left, box[j].left);
      if (oy > 1 && ox > 1) overlap = Math.max(overlap, Math.round(oy));
    }
  }
  g.scrollTop = g.scrollHeight;
  const last = items[items.length - 1].getBoundingClientRect();
  const gb = g.getBoundingClientRect();
  return {
    count: items.length,
    overlap,
    scrollH: g.scrollHeight,
    clientH: g.clientHeight,
    lastReachable: last.top >= gb.top - 1 && last.bottom <= gb.bottom + 1,
  };
};

const PHOTOS = n => Array.from({ length: n }, (_, i) =>
  ({ id: `20260819/p${i}.jpg`, name: `p${i}.jpg`, size: 9e6, rating: 0 }));

function mockWorker(count, extraSettings = {}) {
  return async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', route => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith('/status'))
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"approved":false}' });
      if (u.pathname.includes('/api/books/'))
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          name: 'T', clientFolders: ['20260819/'],
          settings: { width: 57, height: 21, dpi: 300, ...extraSettings },
          coverSettings: { width: 20, height: 20, dpi: 300 },
          pages: [{ type: 'inner', layout: '2-up-h', textLayers: [],
            slots: [{ photoId: '20260819/p0.jpg', crop: { x: 0, y: 0, scale: 1 } },
                    { photoId: '20260819/p1.jpg', crop: { x: 0, y: 0, scale: 1 } }] }] }) });
      if (u.searchParams.has('list'))
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ status: 'success', folders: [], data: PHOTOS(count) }) });
      route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
    });
  };
}

function gridAssertions(r, label) {
  const out = [];
  const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
  ok(`${label} — 所有照片都在`, r.count === 52, String(r.count));
  ok(`${label} — 格子沒有互相重疊`, r.overlap === 0, `重疊 ${r.overlap}px`);
  ok(`${label} — 內容高於容器，捲軸有意義`, r.scrollH > r.clientH + 10, `${r.scrollH}/${r.clientH}`);
  ok(`${label} — 捲到底看得到最後一張`, r.lastReachable === true, String(r.lastReachable));
  return out;
}

await suite('client picker grid — tiles must not overlap and scroll must reach the end',
  `${base}/book_editor/view.html?id=test&t=tok`,
  async page => {
    // Viewer is a top-level const, so it is not a window property
    await page.waitForFunction(() => typeof Viewer !== 'undefined' && !!Viewer.book, null, { timeout: 5000 });
    await page.evaluate(() => { Viewer.pickerSlotIdx = 0; Viewer._openPhotoPicker(); });
    await page.waitForTimeout(1200);
    const r = await page.evaluate(GRID_CHECK, '#viewerPickerGrid');
    return r.missing ? ['FAIL  grid not found'] : gridAssertions(r, '客戶選圖');
  },
  { before: mockWorker(52) });

await suite('editor picker grid — tiles must not overlap and scroll must reach the end',
  `${base}/book_editor/index.html`,
  async page => {
    await page.waitForFunction(() => !!window.bookEditor, null, { timeout: 5000 });
    await page.evaluate(n => {
      bookEditor.libraryPhotos = Array.from({ length: n }, (_, i) =>
        ({ id: `20260819/p${i}.jpg`, name: `p${i}.jpg`, rating: 0 }));
      bookEditor.renderPhotoStrip();
      bookEditor.openPhotoModal(0);
    }, 52);
    await page.waitForTimeout(1200);
    const r = await page.evaluate(GRID_CHECK, '#modalLibraryGrid');
    return r.missing ? ['FAIL  grid not found'] : gridAssertions(r, '編輯器選圖');
  },
  {
    initScript: () => {
      sessionStorage.setItem('studio_token', 'x');
      try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) {}
    },
    before: mockWorker(52),
  });

// The client sees the same guides the photographer works to, so both pages
// must draw them from the one implementation in layouts.js.
const GUIDE_READ = () => {
  const c = document.querySelector('.page-canvas');
  const ov = c?.querySelector('.guide-overlay');
  if (!ov) return { on: false, shadow: c ? getComputedStyle(c).boxShadow : null };
  const cb = c.getBoundingClientRect();
  const spine = [...ov.children].find(e => e.tagName === 'DIV' && e.style.left === '50%');
  const sb = spine?.getBoundingClientRect();
  return {
    on: true,
    shadow: getComputedStyle(c).boxShadow,
    labels: [...ov.querySelectorAll('span')].map(s => s.textContent.trim()),
    spineCentred: sb ? Math.abs((sb.left + sb.width / 2) - (cb.left + cb.width / 2)) < 1.5 : null,
    spineFullHeight: sb ? Math.abs(sb.height - cb.height) < 1.5 : null,
  };
};

let clientLabels = null;

await suite('client preview guides — spine, bleed and safe margin',
  `${base}/book_editor/view.html?id=t&t=tok`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => typeof Viewer !== 'undefined' && !!Viewer.book, null, { timeout: 5000 });
    await page.waitForTimeout(300);

    ok('off by default', !(await page.evaluate(GUIDE_READ)).on);

    await page.click('#guideToggleBtn');
    await page.waitForTimeout(350);
    const on = await page.evaluate(GUIDE_READ);
    clientLabels = on.labels;
    ok('the button turns them on', on.on);
    ok('spine sits on the centre', on.spineCentred === true, String(on.spineCentred));
    ok('spine runs the full page height', on.spineFullHeight === true, String(on.spineFullHeight));
    ok('bleed is drawn', /rgba?\(220, 50, 50/.test(on.shadow || ''), on.shadow);
    ok('all three are labelled',
      ['出血', '安全邊距', '書脊'].every(t => (on.labels || []).some(l => l.includes(t))),
      (on.labels || []).join(' / '));

    // a re-render must not drop them, and turning them off must clean up
    await page.evaluate(() => Viewer.renderPage());
    await page.waitForTimeout(350);
    ok('survive a re-render', (await page.evaluate(GUIDE_READ)).on);

    await page.click('#guideToggleBtn');
    await page.waitForTimeout(350);
    const off = await page.evaluate(GUIDE_READ);
    ok('the button turns them off again', !off.on);
    ok('bleed is cleared too', !/rgba?\(220, 50, 50/.test(off.shadow || ''), off.shadow);
    return out;
  },
  { before: mockWorker(8) });

await suite('editor guides — unchanged after moving them into layouts.js',
  `${base}/book_editor/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!window.bookEditor, null, { timeout: 5000 });
    await page.waitForTimeout(500);
    await page.evaluate(() => document.getElementById('tourCard')?.remove());
    await page.click('#guideToggleBtn');
    await page.waitForTimeout(450);
    const ed = await page.evaluate(GUIDE_READ);
    ok('editor still draws guides', ed.on, JSON.stringify(ed));
    ok('spine sits on the centre', ed.spineCentred === true, String(ed.spineCentred));
    ok('identical labels to the client preview',
      JSON.stringify(ed.labels) === JSON.stringify(clientLabels),
      `${JSON.stringify(ed.labels)} vs ${JSON.stringify(clientLabels)}`);
    return out;
  },
  {
    initScript: () => {
      sessionStorage.setItem('studio_token', 'x');
      try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) {}
    },
    before: mockWorker(8),
  });

// Every print shop asks for a different bleed, so it is a per-book setting —
// and the client's preview has to show the photographer's number, not a
// default that quietly disagrees with what is being sent to print.
const RING_PX = () => {
  const c = document.querySelector('.page-canvas');
  // computed form is "rgba(...) 0px 0px 0px <spread>px" — the spread is last
  const px = (getComputedStyle(c).boxShadow || '').match(/-?\d+(?:\.\d+)?px/g);
  return px ? parseFloat(px[px.length - 1]) : 0;
};

await suite('bleed is a book setting the editor can change',
  `${base}/book_editor/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!window.bookEditor, null, { timeout: 5000 });
    await page.waitForTimeout(500);
    await page.evaluate(() => document.getElementById('tourCard')?.remove());

    ok('defaults to 3mm', (await page.inputValue('#bookBleed')) === '3');
    await page.click('#guideToggleBtn');
    await page.waitForTimeout(400);
    const at3 = await page.evaluate(RING_PX);
    ok('3mm draws a ring', at3 > 0, String(at3));

    await page.fill('#bookBleed', '10');
    await page.dispatchEvent('#bookBleed', 'change');
    await page.waitForTimeout(450);
    const at10 = await page.evaluate(RING_PX);
    ok('the ring follows the number', Math.abs(at10 / at3 - 10 / 3) < 0.35,
      `${at3} → ${at10}, ratio ${(at10 / at3).toFixed(2)}`);
    ok('the label follows too',
      /10\s*mm/.test(await page.evaluate(() =>
        [...document.querySelectorAll('.guide-overlay span')].map(s => s.textContent).find(t => t.includes('出血')) || '')));
    ok('it is stored on the book', (await page.evaluate(() => bookEditor.book.settings.bleed)) === 10);

    await page.fill('#bookBleed', '0');
    await page.dispatchEvent('#bookBleed', 'change');
    await page.waitForTimeout(400);
    ok('0mm is allowed', (await page.evaluate(RING_PX)) === 0);
    return out;
  },
  {
    initScript: () => {
      sessionStorage.setItem('studio_token', 'x');
      try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) {}
    },
    before: mockWorker(8),
  });

await suite("client preview uses the photographer's bleed, not a default",
  `${base}/book_editor/view.html?id=t&t=tok`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => typeof Viewer !== 'undefined' && !!Viewer.book, null, { timeout: 5000 });
    await page.click('#guideToggleBtn');
    await page.waitForTimeout(400);
    const { px, mmPx } = await page.evaluate(() => {
      const c = document.querySelector('.page-canvas');
      const all = (getComputedStyle(c).boxShadow || '').match(/-?\d+(?:\.\d+)?px/g) || ['0px'];
      return {
        px: parseFloat(all[all.length - 1]),
        mmPx: c.getBoundingClientRect().width / (Viewer.book.settings.width * 10),
      };
    });
    ok('renders the book\'s 8mm rather than the 3mm default',
      Math.abs(px / mmPx - 8) < 1.2, `${px.toFixed(1)}px = ${(px / mmPx).toFixed(1)}mm`);
    return out;
  },
  { before: mockWorker(8, { bleed: 8 }) });

// Bleed is print output: if this is wrong the photographer finds out from a
// printed book. Check the actual pixels, not just that the canvas grew.
await suite('export extends artwork into the bleed',
  `${base}/book_editor/test/crop-geometry.test.html`,
  async page => {
    await page.addScriptTag({ url: '/book_editor/js/exporter.js' });
    return page.evaluate(async () => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

      // blue only in the outer 5%, red in the middle, so "the photo's edge"
      // is distinguishable from "the photo's middle stretched outwards"
      const c0 = document.createElement('canvas');
      c0.width = 2000; c0.height = 1000;
      const x0 = c0.getContext('2d');
      x0.fillStyle = '#0000ff'; x0.fillRect(0, 0, 2000, 1000);
      x0.fillStyle = '#ff0000'; x0.fillRect(100, 50, 1800, 900);
      const src = c0.toDataURL('image/png');
      BookExporter._loadImage = () => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = src; });

      const render = async (layout, bleed) => {
        const url = await BookExporter._renderPage(
          { type: 'inner', layout, bg: '#00ff00', textLayers: [],
            slots: [{ photoId: 'p', fit: 'cover', crop: { x: 0, y: 0, scale: 1 } }] },
          { width: 57, height: 21, unit: 'cm', dpi: 50, bleed });
        const img = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = url; });
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        const g = c.getContext('2d');
        return { w: c.width, h: c.height, px: (x, y) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3) };
      };

      const trim = await render('full-bleed', 0);
      const bled = await render('full-bleed', 5);
      const mmPx = trim.w / 570;

      ok('no bleed leaves the size alone', trim.w === 1122, `${trim.w}×${trim.h}`);
      ok('5mm adds 5mm to each side, across', Math.abs((bled.w - trim.w) / 2 / mmPx - 5) < 0.6, `${trim.w} → ${bled.w}`);
      ok('5mm adds 5mm to each side, down', Math.abs((bled.h - trim.h) / 2 / mmPx - 5) < 0.6, `${trim.h} → ${bled.h}`);

      const corners = [[2, 2], [bled.w - 3, 2], [2, bled.h - 3], [bled.w - 3, bled.h - 3]];
      const bare = corners.filter(([x, y]) => { const [r, g, b] = bled.px(x, y); return g > 200 && r < 100 && b < 100; });
      ok('the bleed is covered — no page colour at the corners', bare.length === 0, `${bare.length}/4 corners bare`);

      const [er, , eb] = bled.px(4, Math.round(bled.h / 2));
      ok("the bleed carries the photo's own edge, not its middle", eb > 150 && er < 120, `rgb(${er},_,${eb})`);
      const [cr, , cb] = bled.px(Math.round(bled.w / 2), Math.round(bled.h / 2));
      ok('the middle is still the middle', cr > 150 && cb < 120, `rgb(${cr},_,${cb})`);

      // A layout with its own margin must not be dragged outwards on any
      // side — only edges that actually sit on the page boundary grow.
      const inset = await render('1-up', 5);
      const bleedPx = (inset.w - trim.w) / 2;
      // 1-up is inset 8% all round, so just outside each slot edge is page
      const probes = {
        '左': [bleedPx + 0.08 * trim.w - 8, Math.round(inset.h / 2)],
        '右': [bleedPx + 0.92 * trim.w + 8, Math.round(inset.h / 2)],
        '上': [Math.round(inset.w / 2), bleedPx + 0.08 * trim.h - 8],
        '下': [Math.round(inset.w / 2), bleedPx + 0.92 * trim.h + 8],
      };
      const spilled = Object.entries(probes).filter(([, [x, y]]) => {
        const [r, g, b] = inset.px(Math.round(x), Math.round(y));
        return !(g > 200 && r < 100 && b < 100);
      }).map(([side]) => side);
      ok('an inset layout keeps its margin on every side',
        spilled.length === 0, `照片溢出到：${spilled.join('、') || '無'}`);
      return out;
    });
  });

// A sheet of this book is a spread, so naming it by its printed page numbers
// is what lets the photographer and the client talk about the same thing.
const LABEL_PAGES = [
  { type: 'cover', layout: 'full-bleed', slots: [{}], textLayers: [] },
  ...Array.from({ length: 4 }, () => ({ type: 'inner', layout: '2-up-h', slots: [{}, {}], textLayers: [] })),
  { type: 'back-cover', layout: 'blank', slots: [], textLayers: [] },
];

function mockBook(settingsExtra) {
  return async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', route => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith('/status'))
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"approved":false}' });
      if (u.pathname.includes('/api/books/'))
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          name: 'T', clientFolders: ['f/'],
          settings: { width: 57, height: 21, dpi: 300, ...settingsExtra },
          coverSettings: { width: 28.5, height: 21, dpi: 300 },
          pages: LABEL_PAGES }) });
      if (u.searchParams.has('list'))
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: '{"status":"success","folders":[],"data":[]}' });
      route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
    });
  };
}

const readLabels = async page => {
  await page.waitForFunction(() => typeof Viewer !== 'undefined' && !!Viewer.book, null, { timeout: 5000 });
  const got = [];
  for (let i = 0; i < 6; i++) {
    await page.evaluate(n => { Viewer.currentPageIndex = n; Viewer.renderPage(); }, i);
    await page.waitForTimeout(100);
    got.push((await page.textContent('#pageCounter')).split('（')[0].replace(/[🔒🔓]/g, '').trim());
  }
  return got;
};

await suite('page labels — a spread is named by the pages it prints as',
  `${base}/book_editor/view.html?id=t&t=tok`,
  async page => {
    const got = await readLabels(page);
    const want = ['封面', 'P1–2', 'P3–4', 'P5–6', 'P7–8', '封底'];
    return [JSON.stringify(got) === JSON.stringify(want)
      ? `ok    ${got.join(' · ')}`
      : `FAIL  labels   [${got.join(' · ')} vs ${want.join(' · ')}]`];
  },
  { before: mockBook({}) });

await suite('page labels — a single-page book counts pages, not spreads',
  `${base}/book_editor/view.html?id=t&t=tok`,
  async page => {
    const got = await readLabels(page);
    const want = ['封面', '第 1 頁', '第 2 頁', '第 3 頁', '第 4 頁', '封底'];
    return [JSON.stringify(got) === JSON.stringify(want)
      ? `ok    ${got.join(' · ')}`
      : `FAIL  labels   [${got.join(' · ')} vs ${want.join(' · ')}]`];
  },
  { before: mockBook({ pagesPerSheet: 1 }) });

// Stacking order is now explicit data, and two renderers read it. The pair
// that must never disagree is the preview and the exported file.
await suite('layer order — one order, honoured by preview and export alike',
  `${base}/book_editor/test/crop-geometry.test.html`,
  async page => {
    await page.addScriptTag({ url: '/book_editor/js/exporter.js' });
    return page.evaluate(async () => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

      const solid = colour => {
        const c = document.createElement('canvas');
        c.width = 400; c.height = 400;
        const x = c.getContext('2d');
        x.fillStyle = colour; x.fillRect(0, 0, 400, 400);
        return c.toDataURL('image/png');
      };
      const RED = solid('#ff0000'), BLUE = solid('#0000ff');
      BookExporter._loadImage = src => new Promise(r => {
        const i = new Image(); i.onload = () => r(i); i.src = /p1/.test(src) ? BLUE : RED;
      });
      window._thumbUrl = id => (/p1/.test(id) ? BLUE : RED);

      // two slots deliberately overlapping, so which is in front is visible
      const mkPage = (extra = {}) => ({
        type: 'inner', layout: '2-up-h', bg: '#00ff00',
        slots: [
          { photoId: 'p0.jpg', fit: 'cover', crop: { x: 0, y: 0, scale: 1 }, override: { x: 10, y: 10, w: 60, h: 60 }, ...(extra.s0 || {}) },
          { photoId: 'p1.jpg', fit: 'cover', crop: { x: 0, y: 0, scale: 1 }, override: { x: 30, y: 30, w: 60, h: 60 }, ...(extra.s1 || {}) },
        ],
        textLayers: [{ id: 't1', text: 'HELLO', x: 50, y: 50, w: 80, size: 10, font: 'Inter',
                       color: '#ffffff', align: 'center', layer: 'above', ...(extra.t0 || {}) }],
      });

      const keys = page => pageZOrder(page).map(i => `${i.kind}:${i.idx}`);
      const legacy = mkPage();

      // an album saved before z existed must stack exactly as it did
      ok('legacy default is photos in order, text on top',
        JSON.stringify(keys(legacy)) === JSON.stringify(['slot:0', 'slot:1', 'text:0']), keys(legacy).join(' → '));
      ok('text flagged below still goes behind the photos',
        JSON.stringify(keys(mkPage({ t0: { layer: 'below' } }))) === JSON.stringify(['text:0', 'slot:0', 'slot:1']));

      const stage = document.getElementById('stage');
      const domOrder = pg => {
        stage.innerHTML = renderPageHTML(pg, 600, 300, -1);
        return [...stage.querySelectorAll('.page-slot, .page-text-layer')]
          .map(el => ({ el, z: +getComputedStyle(el).zIndex }))
          .sort((a, b) => a.z - b.z)
          .map(x => x.el.classList.contains('page-slot') ? `slot:${x.el.dataset.slotIdx}` : 'text:0');
      };
      ok('the preview paints in that order',
        JSON.stringify(domOrder(legacy)) === JSON.stringify(keys(legacy)), domOrder(legacy).join(' → '));

      const swapped = mkPage({ s0: { z: 50 }, s1: { z: 20 }, t0: { z: 10 } });
      ok('explicit z reorders', JSON.stringify(keys(swapped)) === JSON.stringify(['text:0', 'slot:1', 'slot:0']));
      ok('the preview follows', JSON.stringify(domOrder(swapped)) === JSON.stringify(keys(swapped)));

      // the pixel where both slots overlap says who won in the actual file
      const overlapPixel = async pg => {
        const url = await BookExporter._renderPage(pg, { width: 20, height: 10, unit: 'cm', dpi: 50, bleed: 0 });
        const img = await new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = url; });
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        const d = c.getContext('2d').getImageData(Math.round(c.width * 0.5), Math.round(c.height * 0.5), 1, 1).data;
        return [d[0], d[2]];
      };
      const [lr, lb] = await overlapPixel(legacy);
      ok('export agrees: the later photo is in front', lb > 150 && lr < 100, `rgb(${lr},_,${lb})`);
      const [sr, sb] = await overlapPixel(swapped);
      ok('export follows a reorder too', sr > 150 && sb < 100, `rgb(${sr},_,${sb})`);
      return out;
    });
  });

// The guides have to sit above the artwork to be any use, but the canvas is
// not the whole app: raising them once let them paint over the photo preview
// modal. The canvas owns its own stacking context so that cannot recur.
await suite('guides stay inside the canvas, under any modal',
  `${base}/book_editor/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!window.bookEditor, null, { timeout: 5000 });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      document.getElementById('tourCard')?.remove();
      const pg = bookEditor.book.pages[bookEditor.currentPageIndex];
      pg.layout = '2-up-h';
      pg.slots = [{ photoId: 'a.jpg', fit: 'cover', crop: { x: 0, y: 0, scale: 1 } },
                  { photoId: 'b.jpg', fit: 'cover', crop: { x: 0, y: 0, scale: 1 } }];
      bookEditor.libraryPhotos = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}.jpg`, name: `p${i}.jpg`, rating: 0 }));
      bookEditor.renderAll();
    });
    await page.waitForTimeout(300);
    await page.click('#guideToggleBtn');
    await page.waitForTimeout(350);

    const state = await page.evaluate(() => {
      const g = document.querySelector('.guide-overlay');
      const slot = document.querySelector('.page-slot');
      return g && slot ? {
        isolated: getComputedStyle(g.parentElement).isolation,
        aboveContent: +getComputedStyle(g).zIndex > +getComputedStyle(slot).zIndex,
      } : null;
    });
    ok('the canvas isolates its own stacking', state?.isolated === 'isolate', JSON.stringify(state));
    ok('guides still sit above the page content', state?.aboveContent === true);

    const topmost = () => page.evaluate(() => {
      const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      if (!el) return 'none';
      return el.closest('.guide-overlay') ? 'guide'
        : el.closest('#photoPreviewModal') ? 'previewModal'
        : el.closest('.modal-overlay') ? 'modal'
        : el.closest('.page-canvas') ? 'canvas' : 'other';
    });

    await page.evaluate(() => {
      bookEditor._showPreviewAt(0);
      document.getElementById('photoPreviewModal').classList.add('open');
    });
    await page.waitForTimeout(400);
    let hit = await topmost();
    ok('the photo preview covers them', hit === 'previewModal', hit);

    await page.evaluate(() => {
      document.getElementById('photoPreviewModal').classList.remove('open');
      bookEditor.openPhotoModal(0);
    });
    await page.waitForTimeout(400);
    hit = await topmost();
    ok('so does the photo picker', hit === 'modal' || hit === 'previewModal', hit);
    return out;
  },
  {
    initScript: () => {
      sessionStorage.setItem('studio_token', 'x');
      try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) {}
    },
    before: mockWorker(5),
  });

// ─── 檔名 escaping ───────────────────────────────────────────────────────────
// Every name on screen comes from an R2 key, and keys are whatever the
// uploader called the file. These pages used to write names straight into
// innerHTML, so a filename could decide what the page rendered — both by
// opening a tag and by breaking out of an attribute with a quote.
const XSS = '"><img src=x onerror="window.__xss=1">';

// Counts markup the name should never have produced. Reading it back as text
// is checked separately: escaping must not mangle what the photographer sees.
const XSS_PROBE = () => ({
  fired: !!window.__xss,
  injected: document.querySelectorAll('img[src="x"]').length,
});

function xssAssertions(r, label, shownSelector) {
  const out = [];
  const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
  ok(`${label} — 惡意檔名沒有變成元素`, r.injected === 0, `注入了 ${r.injected} 個 img`);
  ok(`${label} — onerror 沒有執行`, r.fired === false, String(r.fired));
  if (shownSelector) ok(`${label} — 名稱仍照原樣顯示`, r.shown === XSS, JSON.stringify(r.shown));
  return out;
}

await suite('檔名 escaping — 主選圖頁（照片名、資料夾名、麵包屑）',
  `${base}/index.html`,
  async page => {
    await page.waitForFunction(() => !!window.app, null, { timeout: 5000 });
    const r = await page.evaluate(async payload => {
      app.filteredPhotos = [{ id: '20260819/a.jpg', name: payload, rating: 0 }];
      app.renderPhotoGrid();
      const shown = document.querySelector('.photo-name')?.textContent;

      app.currentFolders = [{ id: '20260819/sub/', name: payload }];
      app.renderFolderGrid();
      const folderShown = document.querySelector('.folder-name')?.textContent;

      app.folderStack = [{ path: '20260819/', name: payload }];
      app.updateFolderNav();
      const crumbShown = document.querySelector('.breadcrumb-item')?.textContent;

      await new Promise(r => setTimeout(r, 400));
      return {
        fired: !!window.__xss,
        injected: document.querySelectorAll('img[src="x"]').length,
        shown, folderShown, crumbShown,
      };
    }, XSS);
    const out = xssAssertions(r, '主選圖頁', true);
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    ok('主選圖頁 — 資料夾名仍照原樣顯示', r.folderShown === XSS, JSON.stringify(r.folderShown));
    ok('主選圖頁 — 麵包屑仍照原樣顯示', r.crumbShown === XSS, JSON.stringify(r.crumbShown));
    return out;
  },
  {
    initScript: () => sessionStorage.setItem('studio_token', 'x'),
    before: mockWorker(1),
  });

await suite('檔名 escaping — 相本編輯器的分享資料夾清單',
  `${base}/book_editor/index.html`,
  async page => {
    await page.waitForFunction(() => !!window.bookEditor, null, { timeout: 5000 });
    const r = await page.evaluate(async payload => {
      bookEditor.libFolderStack = ['20260819/'];
      // the folder list the Worker would hand back, with a hostile name in it
      bookEditor._fetchFolderDirect = async () => ({
        photos: [], folders: [`20260819/${payload}/`],
      });
      await bookEditor._renderShareFolders();
      await new Promise(r => setTimeout(r, 400));
      const cb = document.querySelector('.share-folder-cb');
      return {
        fired: !!window.__xss,
        injected: document.querySelectorAll('img[src="x"]').length,
        // a quote in the name used to end the value attribute early
        value: cb?.value,
        boxes: document.querySelectorAll('.share-folder-cb').length,
      };
    }, XSS);
    const out = xssAssertions(r, '分享資料夾');
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    ok('分享資料夾 — checkbox 的 value 完整保留路徑',
      r.value === `20260819/${XSS}/`, JSON.stringify(r.value));
    ok('分享資料夾 — 只長出一個 checkbox', r.boxes === 1, String(r.boxes));
    return out;
  },
  {
    initScript: () => {
      sessionStorage.setItem('studio_token', 'x');
      try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) {}
    },
    before: mockWorker(1),
  });

await suite('檔名 escaping — 客戶預覽的選圖 modal',
  `${base}/book_editor/view.html?id=test&t=tok`,
  async page => {
    await page.waitForFunction(() => typeof Viewer !== 'undefined' && !!Viewer.book, null, { timeout: 5000 });
    const r = await page.evaluate(async payload => {
      Viewer.pickerSlotIdx = 0;
      Viewer._loadFolderRecursive = async () => [{ id: `20260819/${payload}.jpg`, name: payload }];
      await Viewer._openPhotoPicker();
      // let any injected <img src=x> finish failing, so onerror is a real check
      await new Promise(r => setTimeout(r, 400));
      const tile = document.querySelector('.viewer-picker-photo');
      return {
        fired: !!window.__xss,
        injected: document.querySelectorAll('img[src="x"]').length,
        title: tile?.getAttribute('title'),
        photoId: tile?.dataset.photoId,
        tiles: document.querySelectorAll('.viewer-picker-photo').length,
      };
    }, XSS);
    const out = xssAssertions(r, '客戶選圖 modal');
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    ok('客戶選圖 modal — title 屬性完整保留檔名', r.title === XSS, JSON.stringify(r.title));
    ok('客戶選圖 modal — data-photo-id 完整保留 key',
      r.photoId === `20260819/${XSS}.jpg`, JSON.stringify(r.photoId));
    ok('客戶選圖 modal — 只長出一個格子', r.tiles === 1, String(r.tiles));
    return out;
  },
  { before: mockWorker(1) });


// ═══════════════════════════════════════════════════════════════════════════
// Share tokens — the client album is gated, so the token has to ride along on
// every single request, and the photographer needs a way to issue and kill
// links. Clients open these links from a LINE chat message, so the token lives
// in the URL: it must survive a reload and must not be consumed on first load.
// ═══════════════════════════════════════════════════════════════════════════

const SHARE_BOOK = {
  name: 'T', clientFolders: ['20260819/'],
  settings: { width: 57, height: 21, dpi: 300 },
  coverSettings: { width: 20, height: 20, dpi: 300 },
  pages: [{ type: 'inner', layout: '2-up-h', textLayers: [],
    slots: [{ photoId: '20260819/p0.jpg', crop: { x: 0, y: 0, scale: 1 } },
            { photoId: '20260819/p1.jpg', crop: { x: 0, y: 0, scale: 1 } }] }],
};

// Records what credential each request actually carried, which is the whole
// point: a src string that looks right but never reaches the Worker is
// exactly the bug this is here to catch.
function shareMock(opts = {}) {
  const seen = [];
  const state = { shares: opts.shares ?? [], minted: opts.minted ?? 'MINT-TOKEN' };
  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const h = await req.allHeaders();
      seen.push({
        path: decodeURIComponent(u.pathname), method: req.method(),
        t: u.searchParams.get('t'),
        share: h['x-share-token'] ?? null,
        auth: h['authorization'] ?? null,
        list: u.searchParams.get('list'),
        body: req.postData(),
      });
      const json = (body, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body });

      if (u.pathname === '/api/auth/studio-token')
        return json(JSON.stringify({ token: 'STUDIO-TOK',
          expires_at: new Date(Date.now() + 12 * 3600000).toISOString() }));
      if (req.method() === 'GET' && u.pathname.endsWith('/shares'))
        return json(JSON.stringify(state.shares));
      if (req.method() === 'POST' && u.pathname.endsWith('/share'))
        return json(JSON.stringify({ token: state.minted, expires_at: '2027-01-01T12:00:00.000Z' }));
      if (req.method() === 'POST' && /\/api\/shares\/.+\/revoke$/.test(u.pathname))
        return json('{"ok":true}');
      if (u.pathname.endsWith('/status')) return json('{"approved":false}');
      if (u.pathname.endsWith('/approve')) return json('{"ok":true}');
      if (u.pathname.includes('/api/books/')) {
        if (req.method() === 'GET') return json(JSON.stringify(SHARE_BOOK));
        return json('{"ok":true}');
      }
      if (u.searchParams.has('list'))
        return json(JSON.stringify({ status: 'success', folders: [], data: PHOTOS(3) }));
      route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
    });
  };
  return { seen, state, attach };
}

const authorised = (r, tok) => !!r && (r.share === tok || r.t === tok);

{
  const m = shareMock();
  await suite('share token — the client album carries it on every request',
    `${base}/book_editor/view.html?id=test&t=SHARE-TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => typeof Viewer !== 'undefined' && !!Viewer.book, null, { timeout: 5000 });
      await page.waitForTimeout(400);

      const bookReq = m.seen.find(r => r.method === 'GET' && r.path === '/api/books/test');
      ok('book GET is authorised', authorised(bookReq, 'SHARE-TOK'), JSON.stringify(bookReq));
      ok('status GET is authorised',
        authorised(m.seen.find(r => r.path.endsWith('/status')), 'SHARE-TOK'),
        JSON.stringify(m.seen.find(r => r.path.endsWith('/status'))));

      const srcs = await page.$$eval('.page-canvas img', els => els.map(e => e.getAttribute('src')));
      ok('every canvas <img> carries ?t= (an element cannot send a header)',
        srcs.length === 2 && srcs.every(s => /[?&]t=SHARE-TOK(&|$)/.test(s)), JSON.stringify(srcs));
      ok('and the photo request really reached the Worker with it',
        m.seen.some(r => r.path === '/20260819/p0.jpg' && r.t === 'SHARE-TOK'),
        JSON.stringify(m.seen.filter(r => r.path.includes('p0.jpg'))));

      await page.evaluate(() => { Viewer.pickerSlotIdx = 0; return Viewer._openPhotoPicker(); });
      await page.waitForTimeout(300);
      const listReq = m.seen.find(r => r.list !== null);
      ok('?list= is authorised', authorised(listReq, 'SHARE-TOK'), JSON.stringify(listReq));
      const tiles = await page.$$eval('.viewer-picker-photo img', els => els.map(e => e.getAttribute('src')));
      ok('picker tiles carry ?t= too',
        tiles.length === 3 && tiles.every(s => /[?&]t=SHARE-TOK(&|$)/.test(s)), JSON.stringify(tiles));

      await page.evaluate(() => { Viewer.changedPages.add(0); return Viewer.saveChanges(); });
      ok('PATCH is authorised',
        authorised(m.seen.find(r => r.method === 'PATCH'), 'SHARE-TOK'),
        JSON.stringify(m.seen.find(r => r.method === 'PATCH')));

      await page.evaluate(() => Viewer.approve());
      ok('approve is authorised',
        authorised(m.seen.find(r => r.path.endsWith('/approve')), 'SHARE-TOK'),
        JSON.stringify(m.seen.find(r => r.path.endsWith('/approve'))));

      ok('the URL is left alone, so the LINE message still works',
        /[?&]t=SHARE-TOK(&|$)/.test(await page.evaluate(() => location.search)),
        await page.evaluate(() => location.search));

      // the token is in the URL, so the URL must not ride along to anyone
      ok('the page refuses to put its own URL in a Referer',
        (await page.getAttribute('meta[name="referrer"]', 'content')) === 'no-referrer',
        String(await page.getAttribute('meta[name="referrer"]', 'content')));
      return out;
    },
    { before: async page => { page.on('dialog', d => d.accept()); await m.attach(page); } });
}

{
  const m = shareMock();
  await suite('share token — reopening the same LINE link keeps working',
    `${base}/book_editor/view.html?id=test&t=SHARE-TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => typeof Viewer !== 'undefined' && !!Viewer.book, null, { timeout: 5000 });
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => typeof Viewer !== 'undefined' && !!Viewer.book, null, { timeout: 5000 });
      await page.waitForTimeout(200);

      const gets = m.seen.filter(r => r.method === 'GET' && r.path === '/api/books/test');
      ok('the book was fetched on both visits', gets.length === 2, String(gets.length));
      ok('both carried the same token — nothing was consumed',
        gets.length === 2 && gets.every(r => authorised(r, 'SHARE-TOK')), JSON.stringify(gets));
      ok('the second visit rendered the album, not the error screen',
        (await page.textContent('#bookTitle')) === 'T', await page.textContent('#bookTitle'));
      return out;
    },
    { before: m.attach });
}

{
  const m = shareMock();
  await suite('share token — the photographer previews with their own token',
    `${base}/book_editor/view.html?id=test`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => typeof Viewer !== 'undefined' && !!Viewer.book, null, { timeout: 5000 });
      await page.waitForTimeout(600);

      const bookReq = m.seen.find(r => r.method === 'GET' && r.path === '/api/books/test');
      ok('book GET falls back to the bearer token', bookReq?.auth === 'Bearer adm', JSON.stringify(bookReq));
      ok('and sends no share token', !bookReq?.share && !bookReq?.t, JSON.stringify(bookReq));
      ok('the album rendered', (await page.textContent('#bookTitle')) === 'T',
        await page.textContent('#bookTitle'));
      ok('minting the studio token used the bearer token',
        m.seen.find(r => r.path === '/api/auth/studio-token')?.auth === 'Bearer adm',
        JSON.stringify(m.seen.find(r => r.path === '/api/auth/studio-token')));
      const photoReqs = m.seen.filter(r => r.path === '/20260819/p0.jpg');
      ok('the photo was fetched with it, and never without a credential first',
        photoReqs.length === 1 && photoReqs[0].t === 'STUDIO-TOK', JSON.stringify(photoReqs));
      const srcs = await page.$$eval('.page-canvas img', els => els.map(e => e.src));
      ok('and the <img> loads it itself — no blob swap, no wasted 401',
        srcs.length === 2 && srcs.every(s => /[?&]t=STUDIO-TOK(&|$)/.test(s)), JSON.stringify(srcs));
      return out;
    },
    { before: m.attach, initScript: () => sessionStorage.setItem('studio_token', 'adm') });
}

{
  const m = shareMock();
  await suite('share token — a link with no credential says so instead of going blank',
    `${base}/book_editor/view.html?id=test`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForTimeout(700);
      ok('a visible error is on screen', await page.isVisible('#pageArea .state-msg.error'),
        await page.textContent('#pageArea'));
      const msg = (await page.textContent('#pageArea')).trim();
      ok('it names the missing token rather than a generic failure', /權杖/.test(msg), JSON.stringify(msg));
      ok('the header does not still say 載入中', (await page.textContent('#bookTitle')) !== '載入中...',
        await page.textContent('#bookTitle'));
      ok('nothing was asked of the Worker', m.seen.length === 0, JSON.stringify(m.seen));
      return out;
    },
    { before: m.attach });
}

const SHARE_ROWS = [
  { token: 'LIVE1', label: '王先生 婚紗', created_at: '2026-03-05T12:00:00.000Z',
    expires_at: '2027-06-03T12:00:00.000Z', revoked_at: null, last_seen_at: '2026-09-18T12:00:00.000Z' },
  { token: 'REV1', label: '寄錯群組', created_at: '2026-02-01T12:00:00.000Z',
    expires_at: '2027-05-02T12:00:00.000Z', revoked_at: '2026-02-02T12:00:00.000Z', last_seen_at: null },
  { token: 'EXP1', label: '去年試拍', created_at: '2025-01-01T12:00:00.000Z',
    expires_at: '2025-04-01T12:00:00.000Z', revoked_at: null, last_seen_at: '2025-02-01T12:00:00.000Z' },
];

const OPEN_SHARE_MODAL = async () => {
  bookEditor.libFolderStack = ['20260819/'];
  bookEditor.currentBookId = 'test';
  bookEditor.book.cloudId = 'test';
  await bookEditor.openShareModal();
  await new Promise(r => setTimeout(r, 400));
};

{
  const m = shareMock({ shares: SHARE_ROWS });
  await suite('分享連結 — 發出一條帶 token 的連結',
    `${base}/book_editor/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => !!window.bookEditor, null, { timeout: 5000 });
      await page.evaluate(OPEN_SHARE_MODAL);

      await page.fill('#shareLabelInput', '王先生 婚紗');
      await page.click('#shareConfirmBtn');
      await page.waitForTimeout(700);

      const mint = m.seen.find(r => r.method === 'POST' && r.path === '/api/books/test/share');
      ok('a token was minted for this book', !!mint, JSON.stringify(m.seen.map(r => r.method + ' ' + r.path)));
      ok('minting used the photographer token', mint?.auth === 'Bearer x', JSON.stringify(mint));
      ok('the label the photographer typed was sent',
        JSON.parse(mint?.body || '{}').label === '王先生 婚紗', String(mint?.body));

      const url = await page.inputValue('#shareUrl');
      ok('the client link carries the minted token',
        /\/view\.html\?id=test&t=MINT-TOKEN$/.test(url), JSON.stringify(url));
      ok('and the copy step is showing', await page.isVisible('#shareUrlStep'));
      return out;
    },
    {
      before: m.attach,
      initScript: () => {
        sessionStorage.setItem('studio_token', 'x');
        try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) {}
      },
    });
}

{
  const m = shareMock({ shares: SHARE_ROWS });
  await suite('分享連結 — 已發出的連結清單與撤銷',
    `${base}/book_editor/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => !!window.bookEditor, null, { timeout: 5000 });
      await page.evaluate(OPEN_SHARE_MODAL);

      const listReq = m.seen.find(r => r.method === 'GET' && r.path === '/api/books/test/shares');
      ok('the list was fetched with the photographer token', listReq?.auth === 'Bearer x',
        JSON.stringify(listReq));

      const rows = await page.$$eval('.share-link-row', els => els.map(e => ({
        token: e.dataset.token,
        cls: e.className,
        text: e.textContent.replace(/\s+/g, ' ').trim(),
        opacity: parseFloat(getComputedStyle(e).opacity),
        strike: getComputedStyle(e.querySelector('.share-link-label')).textDecorationLine,
        hasRevoke: !!e.querySelector('.share-revoke-btn'),
      })));
      ok('one row per issued link', rows.length === 3, JSON.stringify(rows.map(r => r.token)));

      const by = t => rows.find(r => r.token === t);
      ok('the label is what identifies a link', by('LIVE1')?.text.includes('王先生 婚紗'),
        JSON.stringify(by('LIVE1')?.text));
      ok('the issue date is shown', /2026\/3\/5/.test(by('LIVE1')?.text || ''), by('LIVE1')?.text);
      ok('the expiry is shown', /2027\/6\/3/.test(by('LIVE1')?.text || ''), by('LIVE1')?.text);
      ok('last opened is shown', /2026\/9\/18/.test(by('LIVE1')?.text || ''), by('LIVE1')?.text);
      ok('a link nobody opened says so', /尚未開啟/.test(by('REV1')?.text || ''), by('REV1')?.text);

      ok('the revoked link is marked revoked', /\brevoked\b/.test(by('REV1')?.cls || ''), by('REV1')?.cls);
      ok('the expired link is marked expired', /\bexpired\b/.test(by('EXP1')?.cls || ''), by('EXP1')?.cls);
      ok('the live link is marked live', /\blive\b/.test(by('LIVE1')?.cls || ''), by('LIVE1')?.cls);
      ok('a dead link is visibly dimmer than a live one',
        by('REV1')?.opacity < by('LIVE1')?.opacity && by('EXP1')?.opacity < by('LIVE1')?.opacity,
        `live ${by('LIVE1')?.opacity} revoked ${by('REV1')?.opacity} expired ${by('EXP1')?.opacity}`);
      ok('a dead link is struck through, a live one is not',
        by('REV1')?.strike.includes('line-through') && by('EXP1')?.strike.includes('line-through')
        && !by('LIVE1')?.strike.includes('line-through'),
        `live ${by('LIVE1')?.strike} revoked ${by('REV1')?.strike}`);
      ok('only a live link offers revoke',
        by('LIVE1')?.hasRevoke === true && by('REV1')?.hasRevoke === false,
        JSON.stringify(rows.map(r => [r.token, r.hasRevoke])));

      // revoking is not undoable, so it must ask first
      await page.click('.share-link-row[data-token="LIVE1"] .share-revoke-btn');
      await page.waitForTimeout(250);
      ok('it asks before revoking', await page.isVisible('#confirmModal.active'));
      ok('the question names the link being killed',
        /王先生 婚紗/.test(await page.textContent('#confirmMessage')),
        await page.textContent('#confirmMessage'));
      await page.click('#confirmCancelBtn');
      await page.waitForTimeout(250);
      ok('saying no revokes nothing',
        !m.seen.some(r => r.path.includes('/revoke')), JSON.stringify(m.seen.map(r => r.path)));

      m.state.shares = SHARE_ROWS.map(r =>
        r.token === 'LIVE1' ? { ...r, revoked_at: '2026-09-21T12:00:00.000Z' } : r);
      await page.click('.share-link-row[data-token="LIVE1"] .share-revoke-btn');
      await page.waitForTimeout(250);
      await page.click('#confirmOkBtn');
      await page.waitForTimeout(600);

      const rev = m.seen.find(r => r.path === '/api/shares/LIVE1/revoke');
      ok('confirming posts to the revoke endpoint', !!rev, JSON.stringify(m.seen.map(r => r.path)));
      ok('with the photographer token', rev?.auth === 'Bearer x', JSON.stringify(rev));
      ok('and the row goes dead in front of them',
        /\brevoked\b/.test(await page.getAttribute('.share-link-row[data-token="LIVE1"]', 'class') || ''),
        await page.getAttribute('.share-link-row[data-token="LIVE1"]', 'class'));
      return out;
    },
    {
      before: m.attach,
      initScript: () => {
        sessionStorage.setItem('studio_token', 'x');
        try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) {}
      },
    });
}

{
  const m = shareMock();
  await suite('編輯器是攝影師的頁面 — 讀取相本時要帶 admin token',
    `${base}/book_editor/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => !!window.bookEditor, null, { timeout: 5000 });
      await page.evaluate(async () => {
        bookEditor.currentBookId = 'test';
        await bookEditor._loadFromCloud();
        bookEditor.book.cloudId = 'test';
        await bookEditor.checkCloudStatus();
      });
      const get = m.seen.find(r => r.method === 'GET' && r.path === '/api/books/test');
      ok('the cloud load is authenticated', get?.auth === 'Bearer x', JSON.stringify(get));
      const st = m.seen.find(r => r.path === '/api/books/test/status');
      ok('so is the approval check', st?.auth === 'Bearer x', JSON.stringify(st));

      // the share modal's folder picker is built from this listing, so an
      // unauthenticated one means the photographer cannot choose what to open
      await page.evaluate(() => bookEditor._fetchFolderDirect('20260819/'));
      const ls = m.seen.find(r => r.list !== null);
      ok('and so is the photo library listing', ls?.auth === 'Bearer x', JSON.stringify(ls));
      return out;
    },
    {
      before: m.attach,
      initScript: () => {
        sessionStorage.setItem('studio_token', 'x');
        try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) {}
      },
    });
}

// ═══════════════════════════════════════════════════════════════════════════
// Studio tokens — gating GET /<key> broke every photographer-facing page,
// because an <img> cannot send an Authorization header. The photographer now
// trades their real credential for a short-lived, read-only token that fits
// in a URL, and it rides in ?t= exactly like a client's.
//
// Everything below asserts on what actually reached the Worker. A src string
// that looks right but never arrives — or arrives naked and 401s before the
// "fixed" one goes out — is precisely the bug this is here to catch.
// ═══════════════════════════════════════════════════════════════════════════

const STUDIO_BOOK = {
  name: 'T', clientFolders: ['20260819/'],
  settings: { width: 57, height: 21, dpi: 300 },
  coverSettings: { width: 20, height: 20, dpi: 300 },
  pages: [{ type: 'inner', layout: '2-up-h', textLayers: [],
    slots: [{ photoId: '20260819/p0.jpg', crop: { x: 0, y: 0, scale: 1 } },
            { photoId: '20260819/p1.jpg', crop: { x: 0, y: 0, scale: 1 } }] }],
};

// `ttlHours` is what the Worker says the minted token is good for; `mintStatus`
// stands in for a wrong PHOTOGRAPHER_TOKEN; `failPhotos` makes object reads
// 401 the way a dead token would.
function studioMock(opts = {}) {
  const seen = [];
  const state = {
    ttlHours: opts.ttlHours ?? 12,
    mintStatus: opts.mintStatus ?? 200,
    // mints past this many succeed no more — 500, not 401, so it reads as
    // transient and nothing is allowed to remember it as a refusal
    mintFailAfter: opts.mintFailAfter ?? Infinity,
    // 'none' | 'first' (only the first read of each key) | 'all'
    failPhotos: opts.failPhotos ?? 'none',
    photos: opts.photos ?? 3,
    minted: [],
    reads: new Map(),
  };
  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const h = await req.allHeaders();
      seen.push({
        path: decodeURIComponent(u.pathname), method: req.method(),
        t: u.searchParams.get('t'),
        share: h['x-share-token'] ?? null,
        auth: h['authorization'] ?? null,
        list: u.searchParams.get('list'),
        w: u.searchParams.get('w'),
      });
      const json = (body, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body });

      if (u.pathname === '/api/auth/studio-token') {
        if (state.mintStatus !== 200) return json('{"error":"Unauthorized"}', state.mintStatus);
        if (state.minted.length >= state.mintFailAfter) {
          state.minted.push(null);
          return json('{"error":"DB not configured"}', 500);
        }
        const token = `STUDIO-${state.minted.length + 1}`;
        state.minted.push(token);
        return json(JSON.stringify({
          token,
          expires_at: new Date(Date.now() + state.ttlHours * 3600000).toISOString(),
        }));
      }
      if (u.pathname.endsWith('/status')) return json('{"approved":false}');
      if (u.pathname.includes('/api/books/')) {
        if (req.method() === 'GET') return json(JSON.stringify(STUDIO_BOOK));
        return json('{"ok":true}');
      }
      if (u.searchParams.has('list'))
        return json(JSON.stringify({ status: 'success', folders: [], data: PHOTOS(state.photos) }));

      const n = (state.reads.get(u.pathname) || 0) + 1;
      state.reads.set(u.pathname, n);
      if (state.failPhotos === 'all' || (state.failPhotos === 'first' && n === 1))
        return json('{"error":"Unauthorized"}', 401);
      route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
    });
  };
  return { seen, state, attach };
}

const CONFIG_WORKER = 'https://imagepicker.hotichen.workers.dev/';
const mints = m => m.seen.filter(r => r.path === '/api/auth/studio-token');
const tileReqs = m => m.seen.filter(r => r.method === 'GET' && /^\/20260819\/p\d+\.jpg$/.test(r.path));
const ADMIN = () => sessionStorage.setItem('studio_token', 'adm');

{
  const m = studioMock();
  await suite('studio token — the main picker mints one and every tile carries it',
    `${base}/index.html?folder=${encodeURIComponent('20260819/')}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(400);

      const mint = mints(m)[0];
      ok('a studio token was minted', !!mint, JSON.stringify(m.seen.map(r => r.method + ' ' + r.path)));
      ok('minting used the real credential in a header', mint?.auth === 'Bearer adm', JSON.stringify(mint));
      ok('and POSTed, with nothing in the query string',
        mint?.method === 'POST' && mint?.t === null, JSON.stringify(mint));

      const list = m.seen.find(r => r.list !== null);
      ok('the folder listing reached the Worker', !!list, JSON.stringify(m.seen.map(r => r.path + '?' + r.list)));
      ok('and it is a fetch, so it carries the real credential as a header',
        list?.auth === 'Bearer adm', JSON.stringify(list));

      const tiles = tileReqs(m);
      ok('every tile the browser asked for carried the studio token',
        tiles.length >= 3 && tiles.every(r => r.t === 'STUDIO-1'), JSON.stringify(tiles));
      ok('and asked for a thumbnail, not the original',
        tiles.length >= 3 && tiles.every(r => r.w === '400'), JSON.stringify(tiles.map(r => r.w)));

      const srcs = await page.$$eval('.photo-card img', els => els.map(e => e.getAttribute('src')));
      ok('the rendered <img> src carries it too',
        srcs.length >= 3 && srcs.every(s => /[?&]t=STUDIO-1(&|$)/.test(s)), JSON.stringify(srcs.slice(0, 3)));

      // the sidebar tree is a second listing call, on a different code path
      await page.evaluate(() => app._fetchNodeChildren(
        { path: '20260819/tree/', isLoaded: false, isLoading: false, children: [] }));
      await page.waitForTimeout(300);
      const tree = m.seen.find(r => r.list === '20260819/tree/');
      ok('the sidebar folder tree is authenticated too', tree?.auth === 'Bearer adm', JSON.stringify(tree));

      // the ZIP download is a fetch, so it sends the header and has no reason
      // to put a token in the URL — and it wants the original, not a thumbnail
      await page.evaluate(() => {
        window.JSZip = function () { this.file = () => {}; this.generateAsync = async () => new Blob(['z']); };
        return driveManager.downloadPhotos([{ id: '20260819/p9.jpg', name: 'p9.jpg' }], 'x.zip');
      });
      await page.waitForTimeout(400);
      const dl = m.seen.find(r => r.path === '/20260819/p9.jpg');
      ok('the ZIP download sends the real credential as a header',
        dl?.auth === 'Bearer adm', JSON.stringify(dl));
      ok('and asks for the original with no token in the URL',
        dl?.t === null && dl?.w === null, JSON.stringify(dl));

      // a second folder must not cost another credential — the Worker reuses
      // one server-side, but a mint per listing is still a round trip per click
      await page.evaluate(() => app.handleLoadPhotos('20260819/sub/'));
      await page.waitForTimeout(500);
      ok('browsing to another folder reuses the token it already has',
        mints(m).length === 1, `${mints(m).length} mints`);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = studioMock();
  await suite('studio token — the editor canvas, strip and preview all carry it',
    `${base}/book_editor/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => !!window.bookEditor, null, { timeout: 5000 });
      await page.evaluate(async () => {
        bookEditor.currentBookId = 'test';
        await bookEditor._loadFromCloud();
        bookEditor.renderAll();
      });
      await page.waitForTimeout(500);

      const mint = mints(m)[0];
      ok('a studio token was minted', !!mint, JSON.stringify(m.seen.map(r => r.method + ' ' + r.path)));
      ok('with the real credential', mint?.auth === 'Bearer x', JSON.stringify(mint));

      const book = m.seen.find(r => r.method === 'GET' && r.path === '/api/books/test');
      ok('the book itself is still fetched with the real credential, not the studio token',
        book?.auth === 'Bearer x' && book?.t === null && book?.share === null, JSON.stringify(book));

      const canvas = await page.$$eval('.page-canvas img', els => els.map(e => e.getAttribute('src')));
      ok('every canvas <img> carries ?t=',
        canvas.length === 2 && canvas.every(s => /[?&]t=STUDIO-1(&|$)/.test(s)), JSON.stringify(canvas));

      await page.evaluate(() => {
        bookEditor.libraryPhotos = [{ id: '20260819/p0.jpg', name: 'p0.jpg', rating: 0 },
                                    { id: '20260819/p1.jpg', name: 'p1.jpg', rating: 0 }];
        bookEditor.renderPhotoStrip();
        bookEditor._showPreviewAt(0);
      });
      await page.waitForTimeout(400);

      const strip = await page.$$eval('.strip-photo img', els => els.map(e => e.getAttribute('src')));
      ok('the library strip carries it',
        strip.length === 2 && strip.every(s => /[?&]t=STUDIO-1(&|$)/.test(s)), JSON.stringify(strip));

      const prev = await page.evaluate(() => ({
        img: document.getElementById('photoPreviewImg').getAttribute('src'),
        dl: document.getElementById('photoPreviewDownload')?.getAttribute('href'),
      }));
      ok('the preview modal carries it', /[?&]t=STUDIO-1(&|$)/.test(prev.img || ''), prev.img);
      // an <a download> navigates; it cannot send a header either
      ok('the original-download link carries it', /[?&]t=STUDIO-1(&|$)/.test(prev.dl || ''), prev.dl);
      ok('and the download link is still the original, not a thumbnail',
        /\/20260819\/p0\.jpg\?t=/.test(prev.dl || ''), prev.dl);

      await page.evaluate(() => bookEditor.openBgPicker('library'));
      await page.waitForTimeout(400);
      const bg = await page.$$eval('.bg-picker-photo img', els => els.map(e => e.getAttribute('src')));
      ok('the background picker carries it',
        bg.length === 2 && bg.every(s => /[?&]t=STUDIO-1(&|$)/.test(s)), JSON.stringify(bg));

      const tiles = tileReqs(m);
      ok('every photo request that reached the Worker was authorised',
        tiles.length >= 2 && tiles.every(r => r.t === 'STUDIO-1'), JSON.stringify(tiles));
      return out;
    },
    {
      before: m.attach,
      initScript: () => {
        sessionStorage.setItem('studio_token', 'x');
        try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) {}
      },
    });
}

{
  const m = studioMock();
  await suite('studio token — previewing an album needs no blob-URL workaround',
    `${base}/book_editor/view.html?id=test`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => typeof Viewer !== 'undefined' && !!Viewer.book, null, { timeout: 5000 });
      await page.waitForTimeout(600);

      ok('a studio token was minted with the real credential',
        mints(m)[0]?.auth === 'Bearer adm', JSON.stringify(mints(m)[0]));
      const book = m.seen.find(r => r.method === 'GET' && r.path === '/api/books/test');
      ok('the book GET still uses the header credential, which the Worker demands',
        book?.auth === 'Bearer adm' && book?.t === null && book?.share === null, JSON.stringify(book));

      const srcs = await page.$$eval('.page-canvas img', els => els.map(e => e.getAttribute('src')));
      ok('the canvas images are real Worker URLs, not blob: swaps',
        srcs.length === 2 && srcs.every(s => s.startsWith(CONFIG_WORKER)), JSON.stringify(srcs));
      ok('and they carry ?t=',
        srcs.length === 2 && srcs.every(s => /[?&]t=STUDIO-1(&|$)/.test(s)), JSON.stringify(srcs));

      const tiles = tileReqs(m);
      // the band-aid fired one naked <img> request that 401'd before the
      // authenticated fetch went out; nothing may 401 first any more
      ok('no photo was ever asked for without a credential',
        tiles.length >= 2 && tiles.every(r => r.t === 'STUDIO-1'), JSON.stringify(tiles));
      ok('and each photo was asked for exactly once',
        tiles.length === new Set(tiles.map(r => r.path + r.w)).size,
        JSON.stringify(tiles.map(r => r.path)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = studioMock();
  await suite('studio token — a client link neither mints one nor loses its own',
    `${base}/book_editor/view.html?id=test&t=SHARE-TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => typeof Viewer !== 'undefined' && !!Viewer.book, null, { timeout: 5000 });
      await page.waitForTimeout(500);

      ok('the client never asks the Worker to mint anything',
        mints(m).length === 0, JSON.stringify(m.seen.map(r => r.method + ' ' + r.path)));
      const tiles = tileReqs(m);
      ok('and its own token is what reached the Worker',
        tiles.length >= 2 && tiles.every(r => r.t === 'SHARE-TOK'), JSON.stringify(tiles));
      return out;
    },
    { before: m.attach });
}

{
  // 12 hours outlives a working session but not a tab left open overnight
  const m = studioMock({ ttlHours: 0.05 });
  await suite('studio token — one near its deadline is replaced before it is used',
    `${base}/index.html?folder=${encodeURIComponent('20260819/')}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(300);
      ok('the first load minted one', mints(m).length === 1, `${mints(m).length} mints`);

      await page.evaluate(() => app.handleLoadPhotos('20260819/sub/'));
      await page.waitForTimeout(600);
      ok('the next listing replaced it rather than reusing a dying one',
        mints(m).length === 2, `${mints(m).length} mints`);

      const late = tileReqs(m).filter(r => r.t !== 'STUDIO-1');
      ok('and the tiles drawn after it carry the new token',
        late.length >= 3 && late.every(r => r.t === 'STUDIO-2'), JSON.stringify(late.slice(0, 4)));
      const srcs = await page.$$eval('.photo-card img', els => els.map(e => e.getAttribute('src')));
      ok('as do the rendered elements',
        srcs.length >= 3 && srcs.every(s => /[?&]t=STUDIO-2(&|$)/.test(s)), JSON.stringify(srcs.slice(0, 3)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  // the known trap: a mistyped PHOTOGRAPHER_TOKEN gets the user in anyway, and
  // then everything 401s. That must stay one refused mint, not a flood.
  const m = studioMock({ mintStatus: 401 });
  await suite('studio token — a refused credential does not become a mint storm',
    `${base}/index.html?folder=${encodeURIComponent('20260819/')}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForTimeout(700);
      for (const f of ['20260819/a/', '20260819/b/', '20260819/c/']) {
        await page.evaluate(p => app.handleLoadPhotos(p), f);
      }
      await page.waitForTimeout(700);
      ok('the Worker was asked to mint exactly once', mints(m).length === 1, `${mints(m).length} mints`);
      ok('the page still listed folders instead of giving up',
        m.seen.filter(r => r.list !== null).length >= 4,
        JSON.stringify(m.seen.filter(r => r.list !== null).map(r => r.list)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  // a tab left open overnight: the tiles are the first thing to notice
  const m = studioMock({ failPhotos: 'first' });
  await suite('studio token — a tile that 401s re-mints once and retries',
    `${base}/index.html?folder=${encodeURIComponent('20260819/')}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(900);

      ok('the dead token was replaced', mints(m).length === 2, `${mints(m).length} mints`);
      ok('every tile that 401d was asked for again',
        tileReqs(m).filter(r => r.t === 'STUDIO-2').length >= 3,
        JSON.stringify(tileReqs(m).map(r => r.path + ':' + r.t)));
      const srcs = await page.$$eval('.photo-card img', els => els.map(e => e.getAttribute('src')));
      ok('and the elements now point at the new token',
        srcs.length >= 3 && srcs.every(s => /[?&]t=STUDIO-2(&|$)/.test(s)), JSON.stringify(srcs.slice(0, 3)));
      const loaded = await page.$$eval('.photo-card img', els => els.map(e => e.naturalWidth));
      ok('the tiles actually loaded in the end',
        loaded.length >= 3 && loaded.every(w => w > 0), JSON.stringify(loaded.slice(0, 3)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = studioMock({ failPhotos: 'all' });
  await suite('studio token — tiles that keep failing retry once, then stop',
    `${base}/index.html?folder=${encodeURIComponent('20260819/')}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(1500);

      ok('the whole page cost one extra mint, not one per tile',
        mints(m).length === 2, `${mints(m).length} mints`);
      const counts = {};
      for (const r of tileReqs(m)) counts[r.path] = (counts[r.path] || 0) + 1;
      const paths = Object.keys(counts);
      ok('and no tile was asked for more than twice',
        paths.length >= 3 && paths.every(p => counts[p] <= 2), JSON.stringify(counts));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  // The replacement mint itself fails, transiently — a 500, not a refusal, so
  // nothing may write it off as a wrong credential. The token on the page is
  // now known-dead and stays known-dead, and tiles keep arriving one at a
  // time: lazily loaded rows scrolling into view, a modal opening. Each one
  // reports the same corpse. That must buy one replacement attempt in total,
  // not one per tile — the case where two tiles failing at the same instant
  // share a single request says nothing, because they share it by accident.
  const m = studioMock({ failPhotos: 'all', mintFailAfter: 1 });
  await suite('studio token — a failed replacement is not retried by the next tile',
    `${base}/index.html?folder=${encodeURIComponent('20260819/')}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(900);
      const afterFirstRound = mints(m).length;
      ok('the first round of dead tiles tried to replace the token once',
        afterFirstRound === 2, `${afterFirstRound} mints`);

      // one new tile at a time, each well after the previous attempt settled
      for (const id of ['20260819/q0.jpg', '20260819/q1.jpg', '20260819/q2.jpg']) {
        await page.evaluate(photoId => {
          app.filteredPhotos = [{ id: photoId, name: photoId, rating: 0, annotations: [] }];
          app.renderPhotoGrid();
        }, id);
        await page.waitForTimeout(450);
      }

      const late = m.seen.filter(r => /^\/20260819\/q\d\.jpg$/.test(r.path));
      ok('the new tiles really did reach the Worker and really did fail',
        late.length === 3 && late.every(r => r.t === 'STUDIO-1'), JSON.stringify(late));
      ok('and not one of them bought another mint',
        mints(m).length === afterFirstRound, `${mints(m).length} mints, was ${afterFirstRound}`);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ═══════════════════════════════════════════════════════════════════════════
// SESSION TOKEN — the client's half of index.html.
//
// index.html is dual-mode. The photographer's half mints a studio token above;
// this is the other one. A client signs in with a D1 account and holds neither
// an admin token nor a share link, so before this every tile and every listing
// 401'd — which is the photo-picking flow, the thing the product exists for.
//
// Two of these assertions exist because the Worker's rules cannot be inferred
// from its responses. The bucket root is a 401 by design, so the tree has to be
// seeded from the folder the mint names; and that folder has to be listed
// exactly as the mint spells it, because the admin-typed `20260819` is not the
// prefix `20260819/` and would also have reached `20260819-other/`.
// ═══════════════════════════════════════════════════════════════════════════

// The folder_path inside the session is the one the client logged in with —
// snapshotted then, typed by an admin, and here deliberately BOTH stale and
// missing its trailing slash. Listing it would reach the wrong wedding, and
// `2026/去年` without the slash would also reach `2026/去年二訪/`. Only the
// Worker's answer is current, so every assertion below that says "the mint's
// folder" dies if the page falls back to this one.
const CLIENT_FOLDER_TYPED = '2026/去年';
const CLIENT_FOLDER = '20260819/';

// Seeded once per browser context, not once per document: addInitScript runs
// on every navigation, and a session that grows back after the page deletes it
// would make client-login.html bounce straight back to index.html forever —
// a loop in the harness that says nothing about the product.
// (self-contained: an init script is serialised into the page, so it cannot
// close over anything defined out here)
const CLIENT = () => {
  if (sessionStorage.getItem('seeded')) return;
  sessionStorage.setItem('seeded', '1');
  sessionStorage.setItem('client_session', JSON.stringify({
    token: 'sess',
    user: { id: 7, email: 'c@example.com', name: '陳小姐', folder_path: '2026/去年' },
    permissions: { can_book: true, can_upload: true },
  }));
};

// The row a client sits on before the photographer assigns them anything.
// '' is the default on a fresh user record, and the old client bar rendered it
// as 所有資料夾 — telling someone with no folder that they had the bucket.
const CLIENT_NO_FOLDER = () => {
  if (sessionStorage.getItem('seeded')) return;
  sessionStorage.setItem('seeded', '1');
  sessionStorage.setItem('client_session', JSON.stringify({
    token: 'sess',
    user: { id: 8, email: 'n@example.com', name: '林先生', folder_path: '' },
    permissions: { can_book: false, can_upload: false },
  }));
};

// A mock that refuses what the Worker refuses, so a tile cannot render and a
// listing cannot succeed on a credential the real thing would have thrown out.
function clientMock(opts = {}) {
  const seen = [];
  const state = {
    mintStatus: opts.mintStatus ?? 200,
    mintError: opts.mintError ?? 'Unauthorized',
    folders: opts.folders ?? [CLIENT_FOLDER],
    ttlMinutes: opts.ttlMinutes ?? 60,
    // sessions the Worker knows; anything else is a 401 before mintStatus is
    // even consulted, exactly as an unknown token is
    sessions: opts.sessions ?? ['sess'],
    // which of those it refuses with mintStatus/mintError. A second, accepted
    // session is how a test tells "never asks again" from "never asks again
    // about this one".
    refuse: opts.refuse ?? ((opts.mintStatus && opts.mintStatus !== 200) ? ['sess'] : []),
    // mints past this many fail with a 500 — transient, so nothing may write
    // it off as a refusal
    mintFailAfter: opts.mintFailAfter ?? Infinity,
    // …and past this many, 401: the session died under a page that already
    // has a token, which is the only way to reach that branch without the
    // redirect the first-mint case triggers
    refuseAfter: opts.refuseAfter ?? Infinity,
    // 'none' | 'first' (only the first read of each key) | 'all'
    failPhotos: opts.failPhotos ?? 'none',
    photos: opts.photos ?? 3,
    minted: [],
    reads: new Map(),
  };
  const covers = p => typeof p === 'string' &&
    state.folders.some(f => p === f || p.startsWith(f));
  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const h = await req.allHeaders();
      const rec = {
        path: decodeURIComponent(u.pathname), method: req.method(),
        t: u.searchParams.get('t'),
        share: h['x-share-token'] ?? null,
        auth: h['authorization'] ?? null,
        list: u.searchParams.get('list'),
        w: u.searchParams.get('w'),
      };
      seen.push(rec);
      const json = (body, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body });

      if (u.pathname === '/api/auth/session-token') {
        // the Worker reads the session from a header and refuses ?t=
        const cred = /^Bearer (.+)$/.exec(rec.auth || '')?.[1] || '';
        if (!state.sessions.includes(cred)) return json('{"error":"Unauthorized"}', 401);
        if (state.refuse.includes(cred))
          return json(JSON.stringify({ error: state.mintError }), state.mintStatus);
        if (state.minted.filter(Boolean).length >= state.refuseAfter)
          return json('{"error":"Unauthorized"}', 401);
        if (state.minted.length >= state.mintFailAfter) {
          state.minted.push(null);
          return json('{"error":"DB not configured"}', 500);
        }
        const token = `SESSION-${state.minted.length + 1}`;
        state.minted.push(token);
        return json(JSON.stringify({
          token,
          expires_at: new Date(Date.now() + state.ttlMinutes * 60000).toISOString(),
          folders: state.folders,
        }));
      }
      if (u.pathname === '/api/auth/logout') return json('{"ok":true}');

      if (rec.list !== null) {
        if (!rec.share || !state.minted.includes(rec.share) || !covers(rec.list))
          return json('{"error":"Unauthorized"}', 401);
        // Distinct photos per folder, when a test needs to prove which one
        // actually loaded rather than just which sidebar row looks active.
        const data = opts.photosByFolder ? (opts.photosByFolder[rec.list] || []) : PHOTOS(state.photos);
        return json(JSON.stringify({ status: 'success', folders: [], data }));
      }

      const source = rec.path.replace(/^\//, '');
      if (!rec.t || !state.minted.includes(rec.t) || !covers(source))
        return json('{"error":"Unauthorized"}', 401);
      const n = (state.reads.get(rec.path) || 0) + 1;
      state.reads.set(rec.path, n);
      if (state.failPhotos === 'all' || (state.failPhotos === 'first' && n === 1))
        return json('{"error":"Unauthorized"}', 401);
      route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
    });
  };
  return { seen, state, attach };
}

const sessionMints = m => m.seen.filter(r => r.path === '/api/auth/session-token');
const clientLists = m => m.seen.filter(r => r.list !== null);
const barText = page => page.evaluate(() => document.getElementById('client-bar')?.textContent || '');

{
  const m = clientMock();
  await suite('session token — a signed-in client mints one and lists only their own folder',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(400);

      const mint = sessionMints(m);
      ok('a session token was minted', mint.length === 1,
        JSON.stringify(m.seen.map(r => r.method + ' ' + r.path)));
      ok('minting sent the D1 session in a header', mint[0]?.auth === 'Bearer sess', JSON.stringify(mint[0]));
      ok('and POSTed it, with nothing in the query string',
        mint[0]?.method === 'POST' && mint[0]?.t === null && mint[0]?.share === null, JSON.stringify(mint[0]));

      const lists = clientLists(m);
      ok('the bucket root was never listed', lists.length > 0 && lists.every(r => r.list !== ''),
        JSON.stringify(lists.map(r => r.list)));
      ok('the prefix listed is the one the mint spelled, not the folder_path an admin typed',
        lists.length > 0 && lists.every(r => r.list === CLIENT_FOLDER),
        JSON.stringify(lists.map(r => r.list)) + ` typed=${CLIENT_FOLDER_TYPED}`);
      ok('the listing carried the minted token as a header, never in the URL',
        lists.every(r => r.share === 'SESSION-1' && r.t === null), JSON.stringify(lists));
      ok('and the D1 session never left the page except to the mint',
        m.seen.filter(r => r.path !== '/api/auth/session-token').every(r => r.auth === null),
        JSON.stringify(m.seen.filter(r => r.auth !== null).map(r => r.path)));

      const tiles = m.seen.filter(r => r.method === 'GET' && /^\/20260819\/p\d+\.jpg$/.test(r.path));
      ok('every tile the browser asked for carried the minted token in the URL',
        tiles.length >= 3 && tiles.every(r => r.t === 'SESSION-1'), JSON.stringify(tiles));
      ok('and asked for a thumbnail, not the original',
        tiles.length >= 3 && tiles.every(r => r.w === '400'), JSON.stringify(tiles.map(r => r.w)));

      const srcs = await page.$$eval('.photo-card img', els => els.map(e => e.getAttribute('src')));
      ok('the rendered <img> src carries it too',
        srcs.length >= 3 && srcs.every(s => /[?&]t=SESSION-1(&|$)/.test(s)), JSON.stringify(srcs.slice(0, 3)));
      const loaded = await page.$$eval('.photo-card img', els => els.map(e => e.naturalWidth));
      ok('and the tiles actually loaded', loaded.length >= 3 && loaded.every(w => w > 0),
        JSON.stringify(loaded.slice(0, 3)));

      const rootPath = await page.evaluate(() => app.folderTreeRoot && app.folderTreeRoot.path);
      ok('the folder tree is seeded at that folder rather than the bucket root',
        rootPath === CLIENT_FOLDER, String(rootPath));

      // the sidebar tree is a second listing call, on a different code path
      await page.evaluate(() => app._fetchNodeChildren(
        { path: '20260819/tree/', isLoaded: false, isLoading: false, children: [] }));
      await page.waitForTimeout(300);
      const tree = m.seen.find(r => r.list === '20260819/tree/');
      ok('the sidebar folder tree sends the minted token as a header too',
        tree?.share === 'SESSION-1' && tree?.t === null, JSON.stringify(tree));

      const bar = await barText(page);
      ok('the client bar names the folder they actually have', bar.includes(CLIENT_FOLDER), bar);
      ok('and no longer claims they have every folder', !bar.includes('所有資料夾'), bar);

      // The path box is gone outright now — the left 資料夾 panel is the
      // single source of truth for which folder the client is in.
      ok('the old path box is gone from the DOM',
        await page.evaluate(() => document.getElementById('driveUrl') === null));
      const activeFolder = await page.evaluate(() =>
        document.querySelector('#folderTree .tree-row.tree-active')?.dataset.folder);
      ok('the left panel shows the same folder, not the stale one in the session',
        activeFolder === CLIENT_FOLDER, String(activeFolder));

      // a second folder must not cost another credential
      await page.evaluate(() => app.handleLoadPhotos('20260819/sub/'));
      await page.waitForTimeout(500);
      ok('browsing to another folder reuses the token it already has',
        sessionMints(m).length === 1, `${sessionMints(m).length} mints`);
      return out;
    },
    { before: m.attach, initScript: CLIENT });
}

{
  // 403 is terminal. A spinner or an empty grid would read as a bug; this is
  // an account state only the photographer can change.
  const m = clientMock({ mintStatus: 403, mintError: '帳號待審核，請聯繫攝影師' });
  await suite('session token — an unapproved account is told why, and nothing is retried',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() =>
        (document.getElementById('client-bar')?.textContent || '').includes('待審核'),
        null, { timeout: 5000 });
      await page.waitForTimeout(600);

      ok('the mint was attempted once and the 403 was not retried',
        sessionMints(m).length === 1, `${sessionMints(m).length} mints`);
      ok('no listing was attempted at all', clientLists(m).length === 0,
        JSON.stringify(clientLists(m).map(r => r.list)));
      const bar = await barText(page);
      ok("the Worker's own wording is what the client reads",
        bar.includes('帳號待審核，請聯繫攝影師'), bar);
      ok('and the folder they used to have is not still offered to them',
        !bar.includes(CLIENT_FOLDER_TYPED), bar);
      ok('no spinner is left turning',
        await page.evaluate(() => !document.getElementById('loadingModal')?.classList.contains('active')));
      ok('and they were not bounced to the login page', page.url().includes('index.html'), page.url());
      return out;
    },
    { before: m.attach, initScript: CLIENT });
}

{
  // The bug this replaces: an unset folder_path was rendered as 所有資料夾,
  // telling a client they had the whole bucket.
  const m = clientMock({ mintStatus: 403, mintError: '尚未設定資料夾，請聯繫攝影師' });
  await suite('session token — a client with no folder is told so, not shown the whole bucket',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() =>
        (document.getElementById('client-bar')?.textContent || '').includes('尚未設定資料夾'),
        null, { timeout: 5000 });
      await page.waitForTimeout(600);

      ok('no listing was attempted', clientLists(m).length === 0,
        JSON.stringify(clientLists(m).map(r => r.list)));
      ok('the mint was not retried', sessionMints(m).length === 1, `${sessionMints(m).length} mints`);
      const body = await page.evaluate(() => document.body.textContent || '');
      ok('nowhere on the page is 所有資料夾 still claimed', !body.includes('所有資料夾'),
        body.slice(0, 200));
      const empty = await page.evaluate(() => document.getElementById('emptyState')?.textContent || '');
      ok('the empty state says what to do about it instead of how to type a path',
        empty.includes('尚未設定資料夾，請聯繫攝影師'), empty);
      return out;
    },
    { before: m.attach, initScript: CLIENT_NO_FOLDER });
}

{
  // 401 is a dead or unknown session — nothing on this page can fix it.
  const m = clientMock({ mintStatus: 401 });
  await suite('session token — a dead session sends the client back to log in',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      // the login form itself, so the assertions below run on the new document
      await page.waitForSelector('#login-btn', { timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(300);
      ok('the browser was sent to the client login page',
        page.url().includes('client-login.html'), page.url());
      // same origin, so the storage the login page reads is the storage we set
      const left = await page.evaluate(() => sessionStorage.getItem('client_session'));
      ok('and the dead session was cleared, so the login page does not bounce them straight back',
        left === null, String(left));
      ok('nothing was listed on a session the Worker had already refused',
        clientLists(m).length === 0, JSON.stringify(clientLists(m).map(r => r.list)));
      ok('and the mint was asked once, not once per attempt',
        sessionMints(m).length === 1, `${sessionMints(m).length} mints`);
      return out;
    },
    { before: m.attach, initScript: CLIENT });
}

{
  // An hour is short enough that a tab left open over lunch outlives it.
  const m = clientMock({ failPhotos: 'first' });
  await suite('session token — a tile that 401s re-mints once and retries',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(1200);

      ok('the dead token was replaced', sessionMints(m).length === 2, `${sessionMints(m).length} mints`);
      const tiles = m.seen.filter(r => r.method === 'GET' && /^\/20260819\/p\d+\.jpg$/.test(r.path));
      ok('every tile that 401d was asked for again with the new one',
        tiles.filter(r => r.t === 'SESSION-2').length >= 3,
        JSON.stringify(tiles.map(r => r.path + ':' + r.t)));
      const srcs = await page.$$eval('.photo-card img', els => els.map(e => e.getAttribute('src')));
      ok('and the elements now point at the new token',
        srcs.length >= 3 && srcs.every(s => /[?&]t=SESSION-2(&|$)/.test(s)), JSON.stringify(srcs.slice(0, 3)));
      const loaded = await page.$$eval('.photo-card img', els => els.map(e => e.naturalWidth));
      ok('the tiles actually loaded in the end', loaded.length >= 3 && loaded.every(w => w > 0),
        JSON.stringify(loaded.slice(0, 3)));
      return out;
    },
    { before: m.attach, initScript: CLIENT });
}

{
  // An hour does not survive a long lunch, and a token with three minutes on it
  // must not be handed to a grid that is about to start loading.
  const m = clientMock({ ttlMinutes: 3 });
  await suite('session token — one near its deadline is replaced before it is used',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(400);
      const first = clientLists(m).find(r => r.list === CLIENT_FOLDER);

      await page.evaluate(() => app.handleLoadPhotos('20260819/sub/'));
      await page.waitForTimeout(700);
      const second = clientLists(m).find(r => r.list === '20260819/sub/');
      ok('both folders were listed', !!first?.share && !!second?.share,
        JSON.stringify(clientLists(m)));
      ok('a token this close to its deadline is not handed to the next listing',
        first?.share !== second?.share, `${first?.share} then ${second?.share}`);
      const srcs = await page.$$eval('.photo-card img', els => els.map(e => e.getAttribute('src')));
      ok('and the tiles drawn after it carry the newer one',
        srcs.length >= 3 && srcs.every(s => s.includes(`t=${second?.share}`)),
        JSON.stringify(srcs.slice(0, 3)));
      return out;
    },
    { before: m.attach, initScript: CLIENT });
}

{
  // Two tokens on the page at once is the failure this rules out: a client's
  // mint must not also be handed to a photographer's Authorization header, and
  // an admin session must not mint a client token off a stale client_session.
  // studioMock, not clientMock: a clientMock has no /api/auth/studio-token, so
  // the photographer's own mint would 401, CONFIG.SHARE_TOKEN would stay empty,
  // and "sends one credential, not two" would hold for the wrong reason.
  const m = studioMock();
  await suite('session token — an admin on the same browser sends one credential, not two',
    `${base}/index.html?folder=${encodeURIComponent('20260819/')}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(400);
      ok('the photographer really does hold a URL token by now',
        await page.evaluate(() => CONFIG.SHARE_TOKEN) === 'STUDIO-1',
        String(await page.evaluate(() => CONFIG.SHARE_TOKEN)));
      ok('no session token was minted for them',
        sessionMints(m).length === 0, JSON.stringify(sessionMints(m)));
      const lists = clientLists(m);
      ok('and their listing carries the real credential and only that',
        lists.length > 0 && lists.every(r => r.auth === 'Bearer adm' && r.share === null),
        JSON.stringify(lists));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  // Three mutations survived the first sweep here, all the same shape: the
  // "don't ask again" guard only fires on a SECOND call, and every suite above
  // calls ensure() once. client-auth-check.js and app.js both await it in the
  // same tick, so they share one in-flight request — which made "exactly one
  // mint" true whether the guard existed or not.
  //
  // A guard like this has two ways to be wrong, so both are pinned: asking
  // again when it must not, and refusing to ask when it must. A flat latch
  // passes the first and fails the second.
  const m = clientMock({
    mintStatus: 403, mintError: '帳號待審核，請聯繫攝影師',
    sessions: ['sess', 'sess2'], refuse: ['sess'],
  });
  await suite('session token — a refused session is not asked about twice, but a new one is',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

      // the first call has to get all the way to the refusal, or the guard
      // under test is never armed and everything below proves nothing
      await page.waitForFunction(() =>
        (document.getElementById('client-bar')?.textContent || '').includes('待審核'),
        null, { timeout: 5000 });
      const first = sessionMints(m);
      ok('the first trade reached the Worker and came back 403',
        first.length === 1 && first[0].auth === 'Bearer sess', JSON.stringify(first));

      // two more calls, each awaited on its own, so nothing can be folded into
      // the first request the way the page's own two callers were
      await page.evaluate(() => window.SessionToken.ensure());
      await page.evaluate(() => window.SessionToken.ensure());
      await page.evaluate(() => window.SessionToken.scope());
      await page.waitForTimeout(300);
      ok('asking again on the same session never reaches the Worker',
        sessionMints(m).length === 1, JSON.stringify(sessionMints(m).map(r => r.auth)));

      // …and the refusal must not outlive the session it was about. Signing in
      // again hands the page a different credential; a latched guard would go
      // on refusing it for as long as the tab stayed open.
      await page.evaluate(() => {
        const s = JSON.parse(sessionStorage.getItem('client_session'));
        s.token = 'sess2';
        sessionStorage.setItem('client_session', JSON.stringify(s));
      });
      const token = await page.evaluate(() => window.SessionToken.ensure());
      await page.waitForTimeout(300);
      const second = sessionMints(m);
      ok('a different session is traded, not refused on the strength of the old one',
        second.length === 2 && second[1].auth === 'Bearer sess2', JSON.stringify(second.map(r => r.auth)));
      ok('and the token it returns is the one the Worker just minted',
        token === 'SESSION-1', String(token));
      const scope = await page.evaluate(() => window.SessionToken.scope());
      ok('with the folder that came with it', scope === CLIENT_FOLDER, String(scope));
      ok('and the 403 it was carrying is cleared',
        await page.evaluate(() => window.SessionToken.error) === '', 
        String(await page.evaluate(() => window.SessionToken.error)));
      return out;
    },
    { before: m.attach, initScript: CLIENT });
}

{
  // The same guard on the 401 path. A 401 on the FIRST mint sends the page to
  // the login form, and the navigation is what hid this — nothing gets to call
  // ensure() a second time. So the session dies later instead: the page is
  // already up with a working token when the Worker stops recognising it, so
  // applyScope has had its one run and there is no redirect to fight.
  const m = clientMock({ refuseAfter: 1 });
  await suite('session token — a dead session is not re-offered to the Worker either',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(300);
      ok('the page came up on a token that worked', sessionMints(m).length === 1,
        JSON.stringify(sessionMints(m)));

      // the session dies; the token on the page ages out and is asked to renew
      const dead = await page.evaluate(async () => {
        window.SessionToken.expiresAt = 0;
        return window.SessionToken.ensure();
      });
      await page.waitForTimeout(300);
      ok('the renewal reached the Worker and came back 401',
        sessionMints(m).length === 2 && dead === '', `${sessionMints(m).length} mints, got ${JSON.stringify(dead)}`);
      ok('and the module knows the session, not the token, is what died',
        await page.evaluate(() => window.SessionToken.expired) === true);

      await page.evaluate(() => window.SessionToken.ensure());
      await page.evaluate(() => window.SessionToken.ensure());
      await page.evaluate(() => window.SessionToken.scope());
      await page.waitForTimeout(300);
      ok('and asking again never reaches it',
        sessionMints(m).length === 2, JSON.stringify(sessionMints(m).map(r => r.auth)));
      return out;
    },
    { before: m.attach, initScript: CLIENT });
}

{
  // The replacement mint itself fails, transiently — a 500, not a refusal, so
  // nothing may write it off as a dead session. Tiles keep arriving one at a
  // time and each reports the same corpse. That must buy one replacement
  // attempt in total, not one per tile: two tiles failing at the same instant
  // share a request by accident, which says nothing.
  const m = clientMock({ failPhotos: 'all', mintFailAfter: 1 });
  await suite('session token — a failed replacement is not retried by the next tile',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(1000);
      const afterFirstRound = sessionMints(m).length;
      ok('the first round of dead tiles tried to replace the token once',
        afterFirstRound === 2, `${afterFirstRound} mints`);

      // one new tile at a time, each well after the previous attempt settled
      for (const id of ['20260819/q0.jpg', '20260819/q1.jpg', '20260819/q2.jpg']) {
        await page.evaluate(photoId => {
          app.filteredPhotos = [{ id: photoId, name: photoId, rating: 0, annotations: [] }];
          app.renderPhotoGrid();
        }, id);
        await page.waitForTimeout(450);
      }
      const late = m.seen.filter(r => /^\/20260819\/q\d\.jpg$/.test(r.path));
      ok('the new tiles really did reach the Worker and really did fail',
        late.length === 3 && late.every(r => r.t === 'SESSION-1'), JSON.stringify(late));
      ok('and not one of them bought another mint',
        sessionMints(m).length === afterFirstRound,
        `${sessionMints(m).length} mints, was ${afterFirstRound}`);
      return out;
    },
    { before: m.attach, initScript: CLIENT });
}

{
  // A client following a link to a subfolder of their own album. The seed must
  // not then drag them back to the root: two listings for one page load is a
  // wasted round trip and a tree that jumps under them.
  const m = clientMock();
  await suite('session token — a client opening a subfolder link is not yanked back to their root',
    `${base}/index.html?folder=${encodeURIComponent('20260819/sub/')}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('.photo-card img').length > 0,
        null, { timeout: 5000 });
      await page.waitForTimeout(700);
      const lists = clientLists(m);
      ok('the subfolder they asked for was listed, on their minted token',
        lists.some(r => r.list === '20260819/sub/' && r.share === 'SESSION-1'), JSON.stringify(lists));
      ok('and it was the only listing — the seed did not fire on top of it',
        lists.length === 1, JSON.stringify(lists.map(r => r.list)));
      const rootPath = await page.evaluate(() => app.folderTreeRoot && app.folderTreeRoot.path);
      ok('the tree is rooted where the link pointed', rootPath === '20260819/sub/', String(rootPath));
      return out;
    },
    { before: m.attach, initScript: CLIENT });
}

// ═══════════════════════════════════════════════════════════════════════════
// REVOKE ALL — the photographer's answer to "I think my password leaked".
// Rotating PHOTOGRAPHER_TOKEN does not reach a studio token already minted, so
// this is the only control that kills one. It deliberately spares the album
// links already sitting in clients' chats, and the page has to say so.
// ═══════════════════════════════════════════════════════════════════════════

const MINTED_ROWS = [
  { token: 'STUDIO-aaa', kind: 'studio', user_id: null, folders: '[]',
    created_at: '2026-09-21T00:00:00.000Z', expires_at: '2026-09-21T12:00:00.000Z' },
  { token: 'STUDIO-bbb', kind: 'studio', user_id: null, folders: '[]',
    created_at: '2026-09-21T05:00:00.000Z', expires_at: '2026-09-21T17:00:00.000Z' },
  { token: 'SESSION-ccc', kind: 'session', user_id: 7, folders: '["20260819/"]',
    created_at: '2026-09-21T06:00:00.000Z', expires_at: '2026-09-21T07:00:00.000Z' },
];

function adminMock(opts = {}) {
  const seen = [];
  const state = {
    rows: opts.rows ?? MINTED_ROWS, revoked: opts.revoked ?? 2,
    clients: opts.clients ?? [],
    tree: opts.tree ?? { '': ['20260819/', '20260901/'], '20260819/': ['20260819/Anita/'] },
  };
  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const h = await req.allHeaders();
      const rec = { path: u.pathname, method: req.method(), auth: h['authorization'] ?? null,
                    list: u.searchParams.get('list'), body: req.postData() };
      seen.push(rec);
      const json = (body, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body });
      if (rec.auth !== 'Bearer adm') return json('{"error":"Unauthorized"}', 401);
      if (rec.list !== null) {
        // the folder picker browses the bucket through the listing route
        const kids = state.tree[rec.list] || [];
        return json(JSON.stringify({ status: 'success', data: [], folders: kids }));
      }
      if (u.pathname === '/api/admin/clients') return json(JSON.stringify(state.clients));
      if (u.pathname === '/api/shares/minted') return json(JSON.stringify(state.rows));
      if (u.pathname === '/api/shares/minted/revoke-all')
        return json(JSON.stringify({ ok: true, revoked: state.revoked }));
      return json('{}');
    });
  };
  return { seen, state, attach };
}

const revokeCalls = m => m.seen.filter(r =>
  r.method === 'POST' && r.path === '/api/shares/minted/revoke-all');

{
  const m = adminMock();
  await suite('revoke all — the control is on the admin page, reads the live tokens, and warns before firing',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const dialogs = [];
      page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });

      await page.waitForSelector('#revoke-all-btn', { timeout: 5000 });
      await page.waitForTimeout(400);

      const listed = m.seen.filter(r => r.method === 'GET' && r.path === '/api/shares/minted');
      ok('the live minted tokens were fetched', listed.length >= 1,
        JSON.stringify(m.seen.map(r => r.method + ' ' + r.path)));
      ok('with the real credential in a header', listed[0]?.auth === 'Bearer adm', JSON.stringify(listed[0]));

      const summary = await page.evaluate(() => document.getElementById('minted-summary')?.textContent || '');
      ok('the panel counts what is live, split by whose it is',
        /3/.test(summary) && /攝影師 2/.test(summary) && /客戶 1/.test(summary), summary);
      const panel = await page.evaluate(() => document.getElementById('minted-panel')?.textContent || '');
      ok('and says album links already sent to clients survive this',
        panel.includes('分享連結') && panel.includes('不會'), panel);
      // revoking without rotating is undone by the next page load that still
      // has the old password, so the order matters and the page has to say so
      ok('and that the password itself has to be changed first',
        panel.includes('PHOTOGRAPHER_TOKEN') && panel.includes('先改密碼'), panel);

      await page.click('#revoke-all-btn');
      await page.waitForTimeout(400);
      ok('clicking it asks for confirmation first', dialogs.length === 1, JSON.stringify(dialogs));
      ok('the confirmation spells out what survives',
        (dialogs[0] || '').includes('分享連結'), dialogs[0]);
      ok('and warns that the password has to go first',
        (dialogs[0] || '').includes('先換掉攝影師密碼'), dialogs[0]);
      ok('and dismissing it fires nothing at the Worker', revokeCalls(m).length === 0,
        JSON.stringify(revokeCalls(m)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  // deliberately not the number of rows the listing returned, so "已撤銷 3"
  // cannot be read off the summary that is already on the page
  const m = adminMock({ revoked: 7 });
  await suite('revoke all — confirming it kills the minted tokens and says how many',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      page.on('dialog', d => d.accept());

      await page.waitForSelector('#revoke-all-btn', { timeout: 5000 });
      await page.waitForTimeout(400);
      await page.click('#revoke-all-btn');
      await page.waitForTimeout(600);

      const posts = revokeCalls(m);
      ok('exactly one revoke-all reached the Worker', posts.length === 1, JSON.stringify(m.seen));
      ok('and it carried the real credential, not a minted token',
        posts[0]?.auth === 'Bearer adm', JSON.stringify(posts[0]));
      const result = await page.evaluate(() => document.getElementById('revoke-result')?.textContent || '');
      ok('the count the Worker returned is reported back, not the one already on screen',
        result.includes('7'), result);
      ok('and the photographer is told it is done', /已撤銷|已登出/.test(result), result);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// A changed script served under an unchanged ?v= leaves returning browsers on
// the old code, which has bitten this project before. The number itself is not
// pinned here — what is checked is that nothing was left behind when it moved.
{
  console.log('\n# asset versions — every local asset on a page moves together');
  const PAGES = ['index.html', 'upload.html', 'tutorial.html', 'admin.html', 'client-login.html',
                 'book_editor/index.html', 'book_editor/view.html', 'r2_designer/index.html'];
  const lines = [];
  const seenVersions = new Set();
  for (const rel of PAGES) {
    const html = await readFile(join(ROOT, rel), 'utf8');
    const local = [...html.matchAll(/(?:src|href)="((?!https?:|\/\/|data:)[^"]*\.(?:js|css)[^"]*)"/g)]
      .map(m => m[1]);
    const missing = local.filter(u => !/[?&]v=/.test(u));
    const versions = [...new Set(local.map(u => (/[?&]v=([^&"]+)/.exec(u) || [])[1]).filter(Boolean))];
    versions.forEach(v => seenVersions.add(v));
    const good = local.length > 0 && missing.length === 0 && versions.length === 1;
    lines.push(`${good ? 'ok  ' : 'FAIL'}  ${rel} — ${versions.join(',') || '(none)'}` +
      (good ? '' : `   [unversioned ${JSON.stringify(missing)}]`));
  }
  lines.push(seenVersions.size === 1
    ? `ok    every page is on the same version (${[...seenVersions][0]})`
    : `FAIL  pages disagree on the version   [${[...seenVersions].join(', ')}]`);
  for (const l of lines) { if (l.startsWith('FAIL')) failed++; console.log('  ' + l); }
}

await suite('studio token — the book list thumbnails carry it too',
  `${base}/book_editor/index.html`,
  async page => {
    await page.waitForFunction(() => !!window.bookEditor, null, { timeout: 5000 });
    const r = await page.evaluate(async () => {
      // a saved book with a cover photo is what puts an <img> in this modal
      bookEditor._getBooksList = () => ([{
        id: 'b-cover', name: 'T', status: 'draft', pages: 4,
        coverPhotoId: '20260819/p0.jpg', clientFolder: '20260819/',
        updatedAt: '2026-09-22',
      }]);
      await window.StudioToken.ensure();
      bookEditor._renderBooksModalList();
      await new Promise(r => setTimeout(r, 200));
      const img = document.querySelector('#booksModalList img');
      return { src: img ? img.src : null, token: CONFIG.SHARE_TOKEN || '' };
    });
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    ok('the cover thumbnail is rendered at all', !!r.src, String(r.src));
    ok('a studio token is in hand', r.token.length > 0, String(r.token.length));
    // the one the six other builders were routed through; this one was missed
    ok('and the thumbnail carries it, like every other <img> on the page',
      !!r.src && r.src.includes(`t=${encodeURIComponent(r.token)}`), String(r.src));
    return out;
  },
  {
    initScript: () => {
      sessionStorage.setItem('studio_token', 'x');
      try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) {}
    },
    before: shareMock().attach,
  });

await suite('a client is not shown the photographer\u2019s pages at all',
  `${base}/index.html`,
  async page => {
    await page.waitForFunction(() => !!document.getElementById('client-bar'), null, { timeout: 5000 });
    const r = await page.evaluate(() => {
      // Three ways this assertion has already passed for the wrong reason:
      // `!== 'shown'` passed when the id was missing, a computed display check
      // passed because the harness hides these anyway, and a `hidden`
      // attribute check passed while .btn's display:inline-flex kept them on
      // screen. Gone from the DOM is the only state none of those reach.
      const vis = id => document.getElementById(id) ? 'shown' : 'gone';
      return {
        upload: vis('uploadPageBtn'),
        book: vis('openBookEditorBtn'),
        // the red "no permission" labels are redundant once the buttons are gone
        bar: document.getElementById('client-bar').textContent,
      };
    });
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    // clicking these asked a client for the photographer's password
    // 'gone' would pass a looser check while meaning the id was wrong
    ok('the upload button is not in the page for a client', r.upload === 'gone', r.upload);
    ok('nor is the album editor', r.book === 'gone', r.book);
    ok('and the bar does not explain a button that is gone',
      !r.bar.includes('\u7121\u6b0a\u9650'), r.bar.trim().slice(0, 60));
    return out;
  },
  {
    initScript: () => {
      sessionStorage.setItem('client_session', JSON.stringify({
        token: 'CS', user: { name: 'A', email: 'a@b.c', folder_path: '20260819/' },
        permissions: { can_book: 0, can_upload: 0 },
      }));
    },
    before: shareMock().attach,
  });

await suite('the photographer still gets those buttons',
  `${base}/index.html`,
  async page => {
    await page.waitForFunction(() => !!window.app, null, { timeout: 5000 });
    const r = await page.evaluate(() => ({
      upload: !!document.getElementById('uploadPageBtn'),
      book: !!document.getElementById('openBookEditorBtn'),
      clientBar: !!document.getElementById('client-bar'),
    }));
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    // without this, a typo in either id would remove nothing and the client
    // suite would still read 'gone'
    ok('the upload button is there for the photographer', r.upload === true, String(r.upload));
    ok('and so is the album editor', r.book === true, String(r.book));
    ok('and no client bar is shown', r.clientBar === false, String(r.clientBar));
    return out;
  },
  {
    initScript: () => sessionStorage.setItem('studio_token', 'adm'),
    before: shareMock().attach,
  });

await suite('a share link cannot be issued for folders nobody opened',
  `${base}/book_editor/index.html`,
  async page => {
    await page.waitForFunction(() => !!window.bookEditor, null, { timeout: 5000 });
    const r = await page.evaluate(async () => {
      bookEditor.book.clientFolders = [];
      let minted = false;
      bookEditor._mintShareToken = async () => { minted = true; return 'TOK'; };
      let told = '';
      const origToast = window.toast;
      window.toast = { error: m => { told = String(m); }, success: () => {}, info: () => {} };
      try { await bookEditor.saveToCloud(); } catch (e) { told = told || String(e.message || e); }
      window.toast = origToast;
      return { minted, told };
    });
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    // a link with an empty snapshot opens the album and not one photo, and
    // neither side is told why
    ok('no token is minted for an empty folder set', r.minted === false, String(r.minted));
    ok('and the photographer is told to pick folders first',
      /\u8cc7\u6599\u593e/.test(r.told), JSON.stringify(r.told));
    return out;
  },
  {
    initScript: () => {
      sessionStorage.setItem('studio_token', 'x');
      try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) {}
    },
    before: shareMock().attach,
  });

await suite('the photographer can sign out of this browser',
  `${base}/index.html`,
  async page => {
    await page.waitForFunction(() => !!document.getElementById('studio-logout'),
      null, { timeout: 5000 }).catch(() => {});
    const present = await page.evaluate(() => !!document.getElementById('studio-logout'));
    const inTopBar = await page.evaluate(() =>
      !!document.querySelector('.header-right #studio-logout'));

    // the handler reloads; location.reload cannot be stubbed, so follow it
    // through and assert on the page that comes back
    // click without awaiting the evaluate: the navigation tears the context
    // down before it can resolve, which is a throw, not a failure
    page.evaluate(() => document.getElementById('studio-logout')?.click()).catch(() => {});
    await page.waitForFunction(() => !sessionStorage.getItem('studio_token'),
      null, { timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('load');
    const after = await page.evaluate(() => ({
      cleared: !sessionStorage.getItem('studio_token'),
      token: (typeof CONFIG !== 'undefined' && CONFIG.PHOTOGRAPHER_TOKEN) || '',
      logoutGone: !document.getElementById('studio-logout'),
    }));

    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    ok('there is a sign-out control', present === true, String(present));
    // it first landed in .header-actions, the download row above the grid,
    // where it was present, passing, and invisible to the person using it
    ok('and it sits in the top bar, not among the download buttons',
      inTopBar === true, String(inTopBar));
    ok('it forgets the stored credential', after.cleared === true, String(after.cleared));
    ok('the reloaded page holds no token', after.token === '', String(after.token.length));
    ok('and does not offer sign-out to someone already signed out',
      after.logoutGone === true, String(after.logoutGone));
    return out;
  },
  {
    // addInitScript runs on EVERY navigation, so seeding unconditionally would
    // put the token back after the reload and quietly un-test the logout
    initScript: () => {
      try {
        if (!localStorage.getItem('__seeded_studio')) {
          localStorage.setItem('__seeded_studio', '1');
          sessionStorage.setItem('studio_token', 'adm');
        }
      } catch (e) { /* private mode */ }
    },
    before: shareMock().attach,
  });

// A token opening several folders that shows only the first is worse than one
// that shows none: the client has no way to know the rest exist. The switcher
// now lives in the left 資料夾 panel, not a bottom-bar chip row, and the old
// path box + LOAD button are gone outright.
await suite('multi-folder — a client sees every folder their token opens, in the left panel',
  `${base}/index.html`,
  async page => {
    await page.waitForFunction(
      () => document.querySelectorAll('#folderTree .tree-row').length > 0,
      null, { timeout: 6000 }).catch(() => {});
    const r = await page.evaluate(() => ({
      inputGone: document.getElementById('driveUrl') === null,
      loadBtnGone: document.getElementById('loadPhotosBtn') === null,
      bottomChips: document.querySelectorAll('#client-scope [data-folder]').length,
      rows: [...document.querySelectorAll('#folderTree .tree-row')].map(el => el.dataset.folder),
      activeRows: [...document.querySelectorAll('#folderTree .tree-row.tree-active')].map(el => el.dataset.folder),
      landed: (typeof CONFIG !== 'undefined' && CONFIG.DEFAULT_FOLDER) || '',
      cards: document.querySelectorAll('.photo-card').length,
    }));
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    ok('the old path input is gone from the DOM entirely', r.inputGone === true);
    ok('and so is the LOAD button', r.loadBtnGone === true);
    ok('no bottom-bar chips are left behind', r.bottomChips === 0, String(r.bottomChips));
    ok('both folders are listed in the left panel, not just the first',
      JSON.stringify(r.rows) === JSON.stringify(['20260819/', '20260901/']), JSON.stringify(r.rows));
    ok('the first is where the page lands', r.landed === '20260819/', JSON.stringify(r.landed));
    ok('and it is the one highlighted',
      JSON.stringify(r.activeRows) === JSON.stringify(['20260819/']), JSON.stringify(r.activeRows));
    ok('its (distinct) photos actually loaded', r.cards === 3, String(r.cards));

    // switching must actually reload that folder, not just relabel a row
    await page.click('#folderTree .tree-row[data-folder="20260901/"]');
    await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 1,
      null, { timeout: 5000 });
    const after = await page.evaluate(() => ({
      folder: (typeof CONFIG !== 'undefined' && CONFIG.DEFAULT_FOLDER) || '',
      rows: [...document.querySelectorAll('#folderTree .tree-row')].map(el => el.dataset.folder),
      activeRows: [...document.querySelectorAll('#folderTree .tree-row.tree-active')].map(el => el.dataset.folder),
      cardName: document.querySelector('.photo-card .photo-name')?.textContent,
    }));
    ok('picking the second one switches to it and loads its own photos',
      after.folder === '20260901/' && after.cardName === 'r0.jpg', JSON.stringify(after));
    ok('and the highlight follows, off the first',
      JSON.stringify(after.activeRows) === JSON.stringify(['20260901/']), JSON.stringify(after.activeRows));
    ok('the list is repainted, not appended to — still exactly the two folders',
      JSON.stringify(after.rows) === JSON.stringify(['20260819/', '20260901/']), JSON.stringify(after.rows));
    return out;
  },
  {
    initScript: () => {
      sessionStorage.setItem('client_session', JSON.stringify({
        token: 'sess', user: { name: 'A', email: 'a@b.c' },
        permissions: { can_book: 0, can_upload: 0 },
      }));
    },
    before: clientMock({
      folders: ['20260819/', '20260901/'],
      photosByFolder: {
        '20260819/': PHOTOS(3),
        '20260901/': [{ id: '20260901/r0.jpg', name: 'r0.jpg', size: 9e6, rating: 0 }],
      },
    }).attach,
  });


{
  const m = adminMock({ clients: [
    { id: 1, name: 'A', email: 'a@b.c', approved: 1, can_book: 1, can_upload: 0,
      folder_path: '["20260819/"]', folders: ['20260819/'] },
    { id: 2, name: 'B', email: 'b@b.c', approved: 1, can_book: 0, can_upload: 0,
      folder_path: '["oops', folders: null },
  ] });
  await suite('admin — folders are picked from the bucket, not typed',
    `${base}/admin.html`,
    async page => {
      await page.waitForFunction(() => document.querySelectorAll('#clients-tbody tr').length >= 2,
        null, { timeout: 6000 }).catch(() => {});
      const before = await page.evaluate(() => ({
        chips: [...document.querySelectorAll('tr[data-id="1"] [data-folder-chip]')]
          .map(el => el.dataset.folderChip),
        addBtn: !!document.querySelector('tr[data-id="1"] [data-add-folder]'),
        // folders:null is a broken account only the photographer can repair
        brokenFlagged: !!document.querySelector('tr[data-id="2"] [data-folders-broken]'),
        brokenShowsRaw: (document.querySelector('tr[data-id="2"]')?.textContent || '')
          .includes('["oops'),
      }));
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      ok('the current folders show as a list', JSON.stringify(before.chips) === '["20260819/"]',
        JSON.stringify(before.chips));
      ok('there is a way to add one', before.addBtn === true, String(before.addBtn));
      ok('an unparseable column is flagged, not shown as empty',
        before.brokenFlagged === true, String(before.brokenFlagged));
      ok('and the raw text is there to repair it from',
        before.brokenShowsRaw === true, String(before.brokenShowsRaw));

      // pick a second folder through the browser modal
      const picked = await page.evaluate(async () => {
        document.querySelector('tr[data-id="1"] [data-add-folder]')?.click();
        await new Promise(r => setTimeout(r, 400));
        const opt = [...document.querySelectorAll('[data-pick-folder]')]
          .find(el => el.dataset.pickFolder === '20260901/');
        if (!opt) return { opened: false };
        opt.click();
        await new Promise(r => setTimeout(r, 100));
        document.querySelector('[data-confirm-folders]')?.click();
        await new Promise(r => setTimeout(r, 400));
        return { opened: true };
      });
      ok('the modal lists what is in the bucket', picked.opened === true, String(picked.opened));

      const puts = m.seen.filter(r => r.method === 'PUT' && /permissions$/.test(r.path));
      const last = puts.length ? JSON.parse(puts[puts.length - 1].body || '{}') : null;
      ok('saving sends the set, not a typed string',
        !!last && JSON.stringify(last.folders) === '["20260819/","20260901/"]',
        JSON.stringify(last));
      ok('and does not also send folder_path, which would win a tie the wrong way',
        !!last && last.folder_path === undefined, JSON.stringify(last && last.folder_path));
      return out;
    },
    { initScript: () => sessionStorage.setItem('studio_token', 'adm'), before: m.attach });
}

// ═══════════════════════════════════════════════════════════════════════════
// 拍攝日期 / 拍攝類型 — collected at registration so the photographer stops
// guessing which R2 folder a new account belongs to, and editable afterwards
// because clients fill them in wrong.
// ═══════════════════════════════════════════════════════════════════════════

function registerMock() {
  const seen = [];
  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      seen.push({ path: new URL(req.url()).pathname, method: req.method(), body: req.postData() });
      return route.fulfill({ status: 201, contentType: 'application/json',
        body: '{"success":true,"message":"等待管理員審核"}' });
    });
  };
  return { seen, attach };
}

const lastRegister = m => {
  const posts = m.seen.filter(r => r.method === 'POST' && r.path === '/api/auth/register');
  return posts.length ? JSON.parse(posts[posts.length - 1].body || '{}') : null;
};

// Opens the register form and fills the three fields that already existed, so
// each test below only has to say what it does differently. Returns nothing —
// what it did is asserted through what reaches the Worker.
const fillBasics = async page => {
  await page.click('.register-toggle');
  await page.fill('#reg-name', '王小明');
  await page.fill('#reg-email', 'w@example.com');
  await page.fill('#reg-password', 'secret1');
};

{
  const m = registerMock();
  await suite('registration — the shoot date and type are asked for and sent',
    `${base}/client-login.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await fillBasics(page);

      // Both controls have to be on screen, not merely in the document: this
      // form spends its life display:none behind the login panel.
      const shown = await page.evaluate(() => {
        const box = id => {
          const el = document.getElementById(id);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { w: r.width, h: r.height, display: getComputedStyle(el).display };
        };
        return { date: box('reg-shoot-date'), type: box('reg-shoot-type'), tbd: box('reg-shoot-tbd') };
      });
      ok('the date picker is on screen', !!shown.date && shown.date.h > 0, JSON.stringify(shown.date));
      ok('so is the type control', !!shown.type && shown.type.h > 0, JSON.stringify(shown.type));
      ok('and the 未定 option', !!shown.tbd && shown.tbd.h > 0, JSON.stringify(shown.tbd));

      // every category, in the order the constant lists them, and nothing else
      const opts = await page.evaluate(() => ({
        shown: [...document.querySelectorAll('#reg-shoot-type option')]
          .map(o => o.value).filter(Boolean),
        constant: typeof SHOOT_TYPES === 'undefined' ? null : SHOOT_TYPES,
      }));
      ok('the type list is exactly the shared constant',
        JSON.stringify(opts.shown) === JSON.stringify(opts.constant || []),
        `${JSON.stringify(opts.shown)} vs ${JSON.stringify(opts.constant)}`);
      ok('and it holds the six categories asked for',
        JSON.stringify(opts.shown) === JSON.stringify(['婚紗', '婚禮', '親子', '個人', '活動', '其他']),
        JSON.stringify(opts.shown));

      await page.selectOption('#reg-shoot-type', '婚紗');
      await page.fill('#reg-shoot-date', '2026-08-19');
      await page.click('#reg-btn');
      await page.waitForTimeout(400);

      const body = lastRegister(m);
      ok('registering reached the Worker', !!body, JSON.stringify(m.seen));
      ok('carrying the shoot date', body?.shoot_date === '2026-08-19', JSON.stringify(body));
      ok('and the shoot type', body?.shoot_type === '婚紗', JSON.stringify(body));
      ok('alongside what it always carried',
        body?.name === '王小明' && body?.email === 'w@example.com' && body?.password === 'secret1',
        JSON.stringify(body));
      return out;
    },
    { before: m.attach });
}

{
  const m = registerMock();
  await suite('registration — 未定 is an answer, and 其他 can be typed',
    `${base}/client-login.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await fillBasics(page);

      // 其他 is the only entry that opens a box, so the box must not be there
      // before it is chosen
      const beforeOther = await page.evaluate(() => {
        const el = document.getElementById('reg-shoot-type-other');
        return el ? el.getBoundingClientRect().height : 0;
      });
      ok('the free-text box is hidden until 其他 is chosen', beforeOther === 0, String(beforeOther));

      await page.selectOption('#reg-shoot-type', '其他');
      await page.waitForTimeout(100);
      const afterOther = await page.evaluate(() => {
        const el = document.getElementById('reg-shoot-type-other');
        return el ? el.getBoundingClientRect().height : 0;
      });
      ok('choosing 其他 opens it', afterOther > 0, String(afterOther));

      await page.fill('#reg-shoot-type-other', '寵物寫真');
      await page.check('#reg-shoot-tbd');
      await page.waitForTimeout(100);
      const dateDisabled = await page.evaluate(() =>
        document.getElementById('reg-shoot-date')?.disabled);
      ok('ticking 未定 takes the date picker out of play', dateDisabled === true, String(dateDisabled));

      await page.click('#reg-btn');
      await page.waitForTimeout(400);
      const body = lastRegister(m);
      // '' would be indistinguishable from the accounts that were never asked,
      // and the photographer would chase a client who has already answered
      ok('未定 is sent as itself, not as an empty date', body?.shoot_date === '未定', JSON.stringify(body));
      ok('and the typed category is sent as the type', body?.shoot_type === '寵物寫真', JSON.stringify(body));
      return out;
    },
    { before: m.attach });
}

{
  const m = registerMock();
  await suite('registration — an unanswered shoot question is refused, not sent blank',
    `${base}/client-login.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await fillBasics(page);
      await page.click('#reg-btn');
      await page.waitForTimeout(300);
      ok('nothing reached the Worker', lastRegister(m) === null, JSON.stringify(m.seen));
      const err = await page.evaluate(() => document.getElementById('reg-err')?.textContent || '');
      ok('and the client is told which answer is missing',
        err.includes('拍攝日期') || err.includes('拍攝類型'), err);

      // one answer at a time, or the other guard covers for the missing one
      await page.selectOption('#reg-shoot-type', '婚紗');
      await page.click('#reg-btn');
      await page.waitForTimeout(300);
      ok('answering only the type is still refused', lastRegister(m) === null, JSON.stringify(m.seen));
      const errDate = await page.evaluate(() => document.getElementById('reg-err')?.textContent || '');
      ok('and the missing date is the one named', errDate.includes('拍攝日期'), errDate);

      // 其他 with nothing typed is the same gap wearing a different hat
      await page.fill('#reg-shoot-date', '2026-08-19');
      await page.selectOption('#reg-shoot-type', '其他');
      await page.click('#reg-btn');
      await page.waitForTimeout(300);
      ok('choosing 其他 without typing one is refused too', lastRegister(m) === null, JSON.stringify(m.seen));
      const err2 = await page.evaluate(() => document.getElementById('reg-err')?.textContent || '');
      ok('and says so', err2.includes('拍攝類型'), err2);
      return out;
    },
    { before: m.attach });
}

const SHOOT_CLIENTS = [
  { id: 1, name: '王小明', email: 'w@b.c', approved: 1, can_book: 1, can_upload: 0,
    folder_path: '["20260819/"]', folders: ['20260819/'],
    shoot_date: '2026-08-19', shoot_type: '婚紗' },
  // every account that exists today: the columns are new, so both are empty
  { id: 2, name: '林先生', email: 'l@b.c', approved: 1, can_book: 0, can_upload: 0,
    folder_path: '', folders: [], shoot_date: '', shoot_type: '' },
  { id: 3, name: '陳小姐', email: 'c@b.c', approved: 1, can_book: 0, can_upload: 0,
    folder_path: '', folders: [], shoot_date: '未定', shoot_type: '寵物寫真' },
  // typed straight into the D1 console: neither a date nor 未定, and close
  // enough to one that a loose parse would read it as 2026-08-19
  { id: 4, name: '張太太', email: 'z@b.c', approved: 1, can_book: 0, can_upload: 0,
    folder_path: '', folders: [], shoot_date: '2026-08-19 上午', shoot_type: '' },
];

{
  const m = adminMock({ clients: SHOOT_CLIENTS });
  await suite('admin — the shoot date and type are on the row, and an empty one says 未填',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('#clients-tbody tr').length >= 3,
        null, { timeout: 6000 }).catch(() => {});

      const seen = await page.evaluate(() => {
        const q = (id, sel) => document.querySelector(`tr[data-id="${id}"] ${sel}`);
        // height, not merely presence: a control in the wrong container, or
        // behind a display:none, is one the photographer cannot use
        const tall = el => (el ? el.getBoundingClientRect().height > 0 : false);
        const dateCell = id => {
          const input = q(id, '[data-shoot-date]');
          const tbd = q(id, '[data-shoot-tbd]');
          return {
            value: input ? input.value : null,
            shown: tall(input),
            tbd: tbd ? tbd.checked : null,
            // 未填 is rendered on every row and shown on the empty ones, so
            // this is the state of the mark and not whether it exists
            unfilled: tall(q(id, '[data-shoot-date-unfilled]')),
            raw: q(id, '[data-shoot-date-raw]')?.textContent ?? null,
          };
        };
        const typeCell = id => {
          const sel = q(id, '[data-shoot-type]');
          const other = q(id, '[data-shoot-type-other]');
          return {
            value: sel ? sel.value : null,
            label: sel?.selectedOptions[0]?.textContent ?? null,
            shown: tall(sel),
            other: other ? other.value : null,
            otherShown: tall(other),
          };
        };
        return {
          d1: dateCell(1), t1: typeCell(1),
          d2: dateCell(2), t2: typeCell(2),
          d3: dateCell(3), t3: typeCell(3),
          d4: dateCell(4),
          options: [...document.querySelectorAll('tr[data-id="1"] [data-shoot-type] option')]
            .map(o => o.value).filter(Boolean),
          constant: typeof SHOOT_TYPES === 'undefined' ? null : SHOOT_TYPES,
          headers: [...document.querySelectorAll('#clients-table thead th')].map(th => th.textContent.trim()),
          bodyCols: document.querySelector('#clients-tbody tr')?.children.length ?? 0,
        };
      });

      ok('the table has a 拍攝日期 column', seen.headers.includes('拍攝日期'), JSON.stringify(seen.headers));
      ok('and a 拍攝類型 column', seen.headers.includes('拍攝類型'), JSON.stringify(seen.headers));
      ok('and every row has a cell for each header',
        seen.bodyCols === seen.headers.length, `${seen.bodyCols} cells vs ${seen.headers.length} headers`);
      // the same one line adds a category to both pages, or it is not one line
      ok('the admin list is the shared constant too',
        JSON.stringify(seen.options) === JSON.stringify(seen.constant || []),
        `${JSON.stringify(seen.options)} vs ${JSON.stringify(seen.constant)}`);

      ok('a filled date is shown on the row, and on screen',
        seen.d1.value === '2026-08-19' && seen.d1.shown, JSON.stringify(seen.d1));
      ok('a filled type is shown on the row, and on screen',
        seen.t1.value === '婚紗' && seen.t1.shown, JSON.stringify(seen.t1));
      ok('a filled account is neither marked 未填 nor ticked 未定',
        seen.d1.unfilled === false && seen.d1.tbd === false, JSON.stringify(seen.d1));
      ok('and its free-text box stays shut', seen.t1.otherShown === false, JSON.stringify(seen.t1));

      // The point of 未填: an account nobody asked must look different from an
      // account that answered, and different from one that answered 未定.
      ok('an account with neither is marked 未填 on the date',
        seen.d2.unfilled === true, JSON.stringify(seen.d2));
      ok('and reads 未填 on the type', seen.t2.value === '' && seen.t2.label === '未填',
        JSON.stringify(seen.t2));
      ok('with the date control empty rather than defaulted to today',
        seen.d2.value === '' && seen.d2.tbd === false, JSON.stringify(seen.d2));

      ok('an account that answered 未定 is ticked, not marked 未填',
        seen.d3.tbd === true && seen.d3.unfilled === false, JSON.stringify(seen.d3));
      ok('and 未定 is not passed off as a date', seen.d3.value === '', JSON.stringify(seen.d3));
      // 寵物寫真 is not in the list, so it has to come back through 其他
      ok('a typed category comes back as 其他 plus the text, box open',
        seen.t3.value === '其他' && seen.t3.other === '寵物寫真' && seen.t3.otherShown,
        JSON.stringify(seen.t3));

      // hand-written into D1 and parseable as neither: shown, not swallowed
      ok('a date that is neither is still put in front of the photographer',
        seen.d4.raw === '2026-08-19 上午' && seen.d4.unfilled === false, JSON.stringify(seen.d4));
      ok('and is not fed to the date input as if it parsed',
        seen.d4.value === '', JSON.stringify(seen.d4));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

const permPuts = m => m.seen.filter(r => r.method === 'PUT' && /permissions$/.test(r.path));
const lastPut = m => {
  const puts = permPuts(m);
  return puts.length ? { path: puts[puts.length - 1].path, body: JSON.parse(puts[puts.length - 1].body || '{}') } : null;
};

{
  const m = adminMock({ clients: SHOOT_CLIENTS });
  await suite('admin — the photographer can correct both fields',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('#clients-tbody tr').length >= 3,
        null, { timeout: 6000 }).catch(() => {});

      await page.selectOption('tr[data-id="1"] [data-shoot-type]', '親子');
      await page.waitForTimeout(400);
      let put = lastPut(m);
      ok('changing the type saves it', put?.body.shoot_type === '親子', JSON.stringify(put));
      ok('against that client', put?.path === '/api/admin/clients/1/permissions', JSON.stringify(put));
      ok('and does not send folders, which would be read as "none"',
        put?.body.folders === undefined, JSON.stringify(put?.body));
      // the route writes permissions from whatever body it is handed, so a
      // partial save has to carry the toggles as they stand
      ok('and carries the toggles as they stand, rather than clearing them',
        put?.body.can_book === true && put?.body.can_upload === false, JSON.stringify(put?.body));

      await page.fill('tr[data-id="2"] [data-shoot-date]', '2026-09-01');
      await page.waitForTimeout(400);
      put = lastPut(m);
      ok('setting a date on an unfilled account saves it',
        put?.body.shoot_date === '2026-09-01', JSON.stringify(put));
      ok('against that client', put?.path === '/api/admin/clients/2/permissions', JSON.stringify(put));

      await page.check('tr[data-id="2"] [data-shoot-tbd]');
      await page.waitForTimeout(400);
      put = lastPut(m);
      ok('ticking 未定 saves the answer rather than a blank',
        put?.body.shoot_date === '未定', JSON.stringify(put));
      const dateEl = () => page.evaluate(() =>
        document.querySelector('tr[data-id="2"] [data-shoot-date]')?.disabled);
      ok('and takes the date control out of play, so the two cannot disagree',
        (await dateEl()) === true, String(await dateEl()));
      await page.uncheck('tr[data-id="2"] [data-shoot-tbd]');
      await page.waitForTimeout(400);
      ok('unticking it hands the date control back', (await dateEl()) === false, String(await dateEl()));

      const before = permPuts(m).length;
      await page.selectOption('tr[data-id="1"] [data-shoot-type]', '其他');
      await page.waitForTimeout(400);
      // 其他 on its own is not a category, and saving it would put an empty
      // string over whatever the client had said
      ok('choosing 其他 with nothing typed saves nothing yet',
        permPuts(m).length === before, JSON.stringify(permPuts(m).map(r => r.body)));

      await page.fill('tr[data-id="1"] [data-shoot-type-other]', '謝師宴');
      // a text box commits when the photographer leaves it, the way every
      // other text box in a browser does
      await page.keyboard.press('Tab');
      await page.waitForTimeout(400);
      put = lastPut(m);
      ok('a typed category is saved as the text, not as 其他',
        put?.body.shoot_type === '謝師宴', JSON.stringify(permPuts(m).map(r => r.body)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  // Folder names are typed by hand, so the rule keys on the whole date and
  // nothing less: 20260901/ is a different day and 2026/ is half the bucket.
  const m = adminMock({
    clients: SHOOT_CLIENTS,
    tree: {
      // 120260819 and 20260819000 carry the eight digits inside a longer
      // number, which is not this date and not a date at all
      '': ['20260901/', '20260819/', '2026/', '2026-08-19 王小明/', '20260819-other/',
           '120260819/', '20260819000/'],
      '20260819/': ['20260819/Anita/', '20260819/20260819 二進/'],
    },
  });
  await suite('admin — the folder picker puts the shoot date’s folders first',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('#clients-tbody tr').length >= 3,
        null, { timeout: 6000 }).catch(() => {});

      const read = async id => {
        await page.evaluate(i => {
          document.querySelector(`tr[data-id="${i}"] [data-add-folder]`)?.click();
        }, id);
        await page.waitForTimeout(500);
        return page.evaluate(() => ({
          order: [...document.querySelectorAll('[data-pick-folder]')].map(el => el.dataset.pickFolder),
          marked: [...document.querySelectorAll('.folder-pick-row')]
            .filter(r => r.hasAttribute('data-date-match'))
            .map(r => r.querySelector('[data-pick-folder]')?.dataset.pickFolder),
          // a marker nobody can read is not a hint
          markText: [...document.querySelectorAll('.folder-pick-row[data-date-match]')]
            .map(r => r.textContent.trim()),
          // nothing may be hidden — a folder the rule missed is still the one
          // the photographer wants
          sizes: [...document.querySelectorAll('.folder-pick-row')].map(r => {
            const b = r.getBoundingClientRect();
            return { w: Math.round(b.width), h: Math.round(b.height), display: getComputedStyle(r).display };
          }),
          head: document.getElementById('folder-picker-head-hint')?.textContent || '',
        }));
      };
      const close = () => page.click('#folder-picker-close');

      const one = await read(1);
      ok('every folder in the bucket is still offered', one.order.length === 7, JSON.stringify(one.order));
      ok('and none of them is hidden',
        one.sizes.length === 7 && one.sizes.every(s => s.h > 0 && s.display !== 'none'),
        JSON.stringify(one.sizes));
      ok('the folders naming the shoot date come first',
        JSON.stringify(one.order.slice(0, 3).sort()) ===
          JSON.stringify(['20260819-other/', '20260819/', '2026-08-19 王小明/'].sort()),
        JSON.stringify(one.order));
      ok('and exactly those are marked',
        JSON.stringify([...one.marked].sort()) ===
          JSON.stringify(['20260819-other/', '20260819/', '2026-08-19 王小明/'].sort()),
        JSON.stringify(one.marked));
      ok('a folder naming another day is neither first nor marked',
        one.order.slice(3).includes('20260901/') && !one.marked.includes('20260901/'),
        JSON.stringify(one.order));
      ok('and a year-only folder is not treated as a match',
        !one.marked.includes('2026/'), JSON.stringify(one.marked));
      ok('nor is the date buried inside a longer number',
        !one.marked.includes('120260819/') && !one.marked.includes('20260819000/'),
        JSON.stringify(one.marked));
      ok('the mark says what it means', one.markText.length === 3 &&
        one.markText.every(t => t.includes('拍攝日')), JSON.stringify(one.markText));
      ok('and the picker says which date it is keying on',
        one.head.includes('2026-08-19'), one.head);

      // Stepping inside a matching folder: every child sits under the date, so
      // a rule reading the whole path would mark the lot and say nothing.
      await page.click('[data-browse="20260819/"]');
      await page.waitForTimeout(500);
      const inside = await page.evaluate(() => ({
        order: [...document.querySelectorAll('[data-pick-folder]')].map(el => el.dataset.pickFolder),
        marked: [...document.querySelectorAll('.folder-pick-row[data-date-match]')]
          .map(r => r.querySelector('[data-pick-folder]')?.dataset.pickFolder),
      }));
      ok('inside a matching folder, both children are offered',
        inside.order.length === 2, JSON.stringify(inside.order));
      ok('and only the one whose own name carries the date is marked',
        JSON.stringify(inside.marked) === JSON.stringify(['20260819/20260819 二進/']),
        JSON.stringify(inside.marked));
      await close();

      // no date is no hint — and the order stays as the bucket gave it
      const two = await read(2);
      ok('an account with no shoot date gets no marks', two.marked.length === 0, JSON.stringify(two.marked));
      ok('and the bucket order is left alone',
        JSON.stringify(two.order) === JSON.stringify(['20260901/', '20260819/', '2026/',
          '2026-08-19 王小明/', '20260819-other/', '120260819/', '20260819000/']),
        JSON.stringify(two.order));
      await close();

      // 未定 is an answer, but it is not a date, and it must not be read as one
      const three = await read(3);
      ok('「未定」 suggests nothing', three.marked.length === 0, JSON.stringify(three.marked));
      ok('and leaves every folder on offer', three.order.length === 7, JSON.stringify(three.order));
      await close();

      // 2026-08-19 上午 is not a date. Reading one out of it would suggest
      // folders off a value the photographer has been told to go and fix.
      const four = await read(4);
      ok('a date with anything else in it suggests nothing',
        four.marked.length === 0, JSON.stringify(four.marked));
      await close();

      // A correction has to reach the picker, or it keeps suggesting folders
      // for the date the client got wrong.
      await page.fill('tr[data-id="2"] [data-shoot-date]', '2026-09-01');
      await page.waitForTimeout(400);
      const fixed = await read(2);
      ok('a corrected date is the one the picker keys on',
        fixed.head.includes('2026-09-01') && JSON.stringify(fixed.marked) === '["20260901/"]',
        `${fixed.head} / ${JSON.stringify(fixed.marked)}`);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ═══════════════════════════════════════════════════════════════════════════
// Guest picking (docs/guest-picking.md) — index.html?t=<pick token> and the
// admin.html project panel. The fake below mirrors the real routes' request
// and response shapes exactly (field names, status codes, error bodies) as
// worker.js implements them — see resolvePick/claim/selections/submit and
// the /api/admin/projects* routes — so a fake that drifts from the real API
// is the failure mode this suite exists to catch.
// ═══════════════════════════════════════════════════════════════════════════

const PICK_RELATIONSHIPS = ['本人', '伴侶', '家人', '朋友', '其他'];
// Mirrors worker.js's own constants exactly (docs/guest-picking.md) — a photo
// key's shape, and the two caps a save is checked against.
const PICK_PHOTO_KEY_MAX = 256;
const PICK_KEY_CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
const PICK_MAX_SELECTIONS = 500;
const PICK_MAX_ROWS = 1000;
function pickKeyValidFake(key) {
  return typeof key === 'string' && [...key].length <= PICK_PHOTO_KEY_MAX &&
    !PICK_KEY_CONTROL.test(key) && !key.endsWith('/');
}
// How many of `subs` (oldest first) are newer than the last one flagged
// notified:1 — every one of them if none was. Mirrors PICK_UNNOTIFIED_SQL.
function unnotifiedCountFake(subs) {
  let lastNotified = -1;
  subs.forEach((s, i) => { if (s.notified) lastNotified = i; });
  return subs.length - 1 - lastNotified;
}
function pickTokenStatusFake(t, now = Date.now()) {
  if (t.revoked_at) return 'revoked';
  if (!Number.isFinite(Date.parse(t.expires_at)) || Date.parse(t.expires_at) <= now) return 'expired';
  return 'live';
}

function pickFakeWorker(opts = {}) {
  const state = {
    project: {
      id: opts.projectId || 'proj-1',
      title: opts.title ?? 'T 專案',
      pick_limit: opts.pickLimit ?? null,
      extra_price: opts.extraPrice ?? null,
      folders: opts.folders || ['20260819/'],
      owner_picker_id: null,
      phase: 'picking',
      modified_after_submit: 0,
      archived_at: opts.archivedAt || null,
    },
    deleted: false,
    pickers: new Map(),        // id -> {id, name, key, relationship, email}
    selections: new Map(),     // photo_key -> {rating, note, updated_by, updated_at}
    submissions: [],           // oldest first internally; served newest-first
    // every pick link the project ever had, oldest first internally, exactly
    // like worker.js's share_tokens rows (docs/guest-picking.md, "re-minting
    // a link"). opts.listToken === null means the project starts with none.
    tokens: opts.listToken === null ? [] : [{
      token: opts.listToken !== undefined ? opts.listToken : 'PICK-TOKEN',
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2027-01-01T00:00:00.000Z',
      revoked_at: null,
    }],
  };
  if (opts.ownerName) {
    const id = 'picker-0';
    state.pickers.set(id, { id, name: opts.ownerName, key: opts.ownerKey || 'OWNER-KEY' });
    state.project.owner_picker_id = id;
  }
  const requests = [];

  function findByKey(key) {
    for (const p of state.pickers.values()) if (p.key === key) return p;
    return null;
  }
  function liveToken() {
    return state.tokens.find(t => pickTokenStatusFake(t) === 'live') || null;
  }

  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const method = req.method();
      const h = await req.allHeaders();
      const shareTok = u.searchParams.get('t') || h['x-share-token'] || '';
      const pickerKey = h['x-picker-key'] || '';
      let body = null;
      try { body = JSON.parse(req.postData() || 'null'); } catch (e) { /* not JSON */ }
      requests.push({ method, path: u.pathname, search: u.search, t: shareTok, key: pickerKey, body });
      const json = (data, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });

      if (u.pathname === '/api/pick/state' && method === 'GET') {
        const picker = pickerKey ? findByKey(pickerKey) : null;
        const isOwner = !!picker && state.project.owner_picker_id === picker.id;
        const ownerPicker = state.project.owner_picker_id ? state.pickers.get(state.project.owner_picker_id) : null;
        const subs = state.submissions;
        const resp = {
          project: {
            id: state.project.id, title: state.project.title,
            pick_limit: state.project.pick_limit, extra_price: state.project.extra_price,
          },
          folders: state.project.folders,
          owner: ownerPicker ? ownerPicker.name : null,
          is_owner: isOwner,
          phase: state.project.phase,
          submitted_at: subs.length ? subs[subs.length - 1].created_at : null,
          // notes are the owner's own words to the photographer — a viewer
          // gets {photo_key, rating} only (docs/guest-picking.md)
          selections: Array.from(state.selections.entries())
            .map(([photo_key, s]) => isOwner ? { photo_key, rating: s.rating, note: s.note } : { photo_key, rating: s.rating }),
        };
        if (isOwner) resp.modified_after_submit = state.project.modified_after_submit;
        return json(resp);
      }

      if (u.pathname === '/api/pick/claim' && method === 'POST') {
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        if (!name || name.length > 50) return json({ error: '請輸入 1–50 字的名字' }, 400);
        if (state.project.owner_picker_id) {
          const owner = state.pickers.get(state.project.owner_picker_id);
          return json({ error: '已有人在挑選', owner: owner ? owner.name : null }, 409);
        }
        const id = 'picker-' + (state.pickers.size + 1);
        const key = 'KEY-' + id;
        state.pickers.set(id, { id, name, key });
        state.project.owner_picker_id = id;
        return json({ picker_key: key, picker_id: id, owner: name });
      }

      if (u.pathname === '/api/pick/selections' && method === 'PUT') {
        if (!['picking', 'submitted'].includes(state.project.phase))
          return json({ error: '攝影師已開始修圖，無法再修改或送出', code: 'retouching' }, 409);
        const picker = pickerKey ? findByKey(pickerKey) : null;
        const isOwner = !!picker && state.project.owner_picker_id === picker.id;
        if (!isOwner) return json({ error: '只有挑選人可以修改' }, 403);
        const upsert = body?.upsert || [];
        const del = body?.delete || [];
        // shape first (docs/guest-picking.md rule 7), same as worker.js —
        // checked before anything about caps, and before any write
        for (const item of upsert) {
          if (!pickKeyValidFake(item.photo_key)) return json({ error: '照片名稱不正確', code: 'invalid_photo_key' }, 400);
        }
        for (const k of del) {
          if (!pickKeyValidFake(k)) return json({ error: '照片名稱不正確', code: 'invalid_photo_key' }, 400);
        }
        // the caps: what this save would leave, against the current count —
        // whichever of PICK_MAX_SELECTIONS/current-count is bigger, mirroring
        // worker.js's MAX(?, current) so a project already over a lowered cap
        // can still re-rate/un-star/delete
        const byKey = new Map(upsert.map(it => [it.photo_key, it]));
        const removed = new Set(del);
        const resultKeys = new Set([...state.selections.keys(), ...byKey.keys()]);
        for (const k of removed) resultKeys.delete(k);
        let starCount = 0;
        for (const k of resultKeys) {
          const rating = byKey.has(k) ? byKey.get(k).rating : state.selections.get(k)?.rating;
          if (rating > 0) starCount++;
        }
        const priorStars = Array.from(state.selections.values()).filter(s => s.rating > 0).length;
        const priorRows = state.selections.size;
        if (starCount > Math.max(PICK_MAX_SELECTIONS, priorStars)) {
          return json({ error: `最多只能選 ${PICK_MAX_SELECTIONS} 張`, code: 'selection_cap', max: PICK_MAX_SELECTIONS }, 409);
        }
        if (resultKeys.size > Math.max(PICK_MAX_ROWS, priorRows)) {
          return json({ error: `最多只能保留 ${PICK_MAX_ROWS} 筆`, code: 'row_cap', max: PICK_MAX_ROWS }, 409);
        }
        const now = new Date().toISOString();
        if (state.project.phase === 'submitted') state.project.modified_after_submit = 1;
        upsert.forEach(item => {
          state.selections.set(item.photo_key,
            { rating: item.rating, note: item.note || '', updated_by: picker.id, updated_at: now });
        });
        del.forEach(k => state.selections.delete(k));
        return json({ ok: true });
      }

      if (u.pathname === '/api/pick/submit' && method === 'POST') {
        if (!['picking', 'submitted'].includes(state.project.phase))
          return json({ error: '攝影師已開始修圖，無法再修改或送出', code: 'retouching' }, 409);
        const picker = pickerKey ? findByKey(pickerKey) : null;
        const isOwner = !!picker && state.project.owner_picker_id === picker.id;
        if (!isOwner) return json({ error: '只有挑選人可以送出' }, 403);
        if (!PICK_RELATIONSHIPS.includes(body?.relationship)) return json({ error: '請選擇與新人的關係' }, 400);
        let mail = null;
        if (body.email !== undefined && body.email !== null && body.email !== '') {
          if (!/^[^\s@]+@[^\s@]+$/.test(body.email)) return json({ error: 'Email 格式不正確' }, 400);
          mail = body.email;
        }
        const photo_keys = Array.from(state.selections.entries())
          .filter(([, s]) => s.rating > 0).map(([k]) => k).sort();
        const submission = {
          id: 'sub-' + (state.submissions.length + 1), picker_id: picker.id,
          relationship: body.relationship, email: mail, photo_keys, count: photo_keys.length,
          pick_limit: state.project.pick_limit, extra_price: state.project.extra_price,
          created_at: new Date(Date.now() + state.submissions.length).toISOString(),
          // the fake never actually mails (the throttle/diff logic is
          // worker.js's own, pinned by worker/test/pick-hardening.test.mjs) —
          // every submission starts unnotified, exactly like a project with
          // no mail configured
          notified: 0,
        };
        state.submissions.push(submission);
        state.project.phase = 'submitted';
        state.project.modified_after_submit = 0;
        picker.relationship = body.relationship;
        picker.email = mail;
        const limit = state.project.pick_limit;
        return json({
          ok: true, phase: 'submitted', submission_id: submission.id, submitted_at: submission.created_at,
          count: submission.count, limit, price: state.project.extra_price,
          over: limit == null ? 0 : Math.max(0, submission.count - limit),
        });
      }

      if (u.pathname === '/api/admin/projects' && method === 'GET') {
        const owner = state.project.owner_picker_id ? state.pickers.get(state.project.owner_picker_id) : null;
        const subs = state.submissions;
        const live = liveToken();
        const wantArchived = u.searchParams.get('archived') === '1';
        const isArchived = !!state.project.archived_at;
        const projects = (!state.deleted && (wantArchived ? isArchived : !isArchived)) ? [{
          id: state.project.id,
          title: state.project.title,
          phase: state.project.phase,
          modified_after_submit: state.project.modified_after_submit,
          owner_name: owner ? owner.name : null,
          created_at: '2026-01-01T00:00:00.000Z',
          archived_at: state.project.archived_at,
          submission_count: subs.length,
          last_submitted_at: subs.length ? subs[subs.length - 1].created_at : null,
          unnotified_submissions: unnotifiedCountFake(subs),
          token: live ? live.token : null,
        }] : [];
        return json({ projects });
      }

      if (u.pathname === '/api/admin/projects' && method === 'POST') {
        return json({
          project: {
            id: state.project.id, title: body.title || '', folders: body.folders,
            pick_limit: body.pick_limit ?? null, extra_price: body.extra_price ?? null,
            photographer_id: 'default',
          },
          token: 'PICK-TOKEN', expires_at: '2027-01-01T00:00:00.000Z',
        }, 201);
      }
      if (/^\/api\/admin\/projects\/[^/]+$/.test(u.pathname) && method === 'GET') {
        const pickers = Array.from(state.pickers.values()).map(p => ({
          id: p.id, name: p.name, relationship: p.relationship || null,
          email: p.email || null, user_id: null, created_at: '2026-01-01T00:00:00.000Z',
        }));
        const selections = Array.from(state.selections.entries())
          .map(([photo_key, s]) => ({ photo_key, rating: s.rating, note: s.note, updated_by: s.updated_by, updated_at: s.updated_at }));
        const submissions = state.submissions.slice().reverse();
        const owner = state.project.owner_picker_id ? state.pickers.get(state.project.owner_picker_id) : null;
        const tokens = state.tokens.slice().reverse().map(t => ({ ...t, status: pickTokenStatusFake(t) }));
        return json({
          project: { ...state.project },
          owner: owner ? { id: owner.id, name: owner.name } : null,
          pickers, selections, tokens, submissions,
          unnotified_submissions: unnotifiedCountFake(state.submissions),
        });
      }
      if (/^\/api\/admin\/projects\/[^/]+$/.test(u.pathname) && method === 'DELETE') {
        if (state.submissions.length)
          return json({ error: '已有送出紀錄，無法刪除（可改為封存）', code: 'has_submissions' }, 409);
        state.deleted = true;
        return json({ ok: true });
      }
      if (/\/api\/admin\/projects\/[^/]+\/links$/.test(u.pathname) && method === 'POST') {
        if (state.project.archived_at)
          return json({ error: 'Project is archived; unarchive it first', code: 'archived' }, 409);
        const token = 'PICK-TOKEN-' + (state.tokens.length + 1);
        const created_at = new Date().toISOString();
        const expires_at = new Date(Date.now() + 90 * 86400000).toISOString();
        state.tokens.push({ token, created_at, expires_at, revoked_at: null });
        return json({ token, expires_at, created_at, status: 'live' }, 201);
      }
      if (/\/api\/admin\/projects\/[^/]+\/archive$/.test(u.pathname) && method === 'POST') {
        let revoked = 0;
        if (!state.project.archived_at) {
          const at = new Date().toISOString();
          state.project.archived_at = at;
          for (const t of state.tokens) {
            if (pickTokenStatusFake(t) === 'live') { t.revoked_at = at; revoked++; }
          }
        }
        return json({ ok: true, archived_at: state.project.archived_at, revoked });
      }
      if (/\/api\/admin\/projects\/[^/]+\/unarchive$/.test(u.pathname) && method === 'POST') {
        state.project.archived_at = null;
        return json({ ok: true, archived_at: null });
      }
      if (/^\/api\/shares\/[^/]+\/revoke$/.test(u.pathname) && method === 'POST') {
        const tok = decodeURIComponent(u.pathname.split('/')[3]);
        const row = state.tokens.find(t => t.token === tok);
        if (!row || row.revoked_at) return json({ error: 'Not found' }, 404);
        row.revoked_at = new Date().toISOString();
        return json({ ok: true });
      }
      if (/\/api\/admin\/projects\/[^/]+\/reset-seat$/.test(u.pathname) && method === 'POST') {
        state.project.owner_picker_id = null;
        return json({ ok: true });
      }
      if (/\/api\/admin\/projects\/[^/]+\/start-retouch$/.test(u.pathname) && method === 'POST') {
        if (state.project.phase === 'picking')
          return json({ error: '客人尚未送出，無法開始修圖', code: 'not_submitted', phase: 'picking' }, 409);
        state.project.phase = 'retouching';
        return json({ ok: true, phase: 'retouching' });
      }
      if (/\/api\/admin\/projects\/[^/]+\/reopen$/.test(u.pathname) && method === 'POST') {
        state.project.phase = 'picking';
        state.project.modified_after_submit = 0;
        return json({ ok: true, phase: 'picking' });
      }

      if (u.searchParams.has('list')) {
        // the admin create-project folder picker browses the bucket itself,
        // not a pick token's own (single-folder) grid — a distinct fixture
        if (opts.bucketFolders) {
          const prefix = u.searchParams.get('list') || '';
          const folders = opts.bucketFolders.filter(f => f.startsWith(prefix) && f !== prefix);
          return json({ status: 'success', folders, data: [] });
        }
        // Multi-folder pick projects: distinct photos per permitted folder,
        // so a test can tell which one is actually on screen rather than
        // just which one the sidebar claims is active.
        if (opts.photosByFolder) {
          const prefix = u.searchParams.get('list') || '';
          return json({ status: 'success', folders: [], data: opts.photosByFolder[prefix] || [] });
        }
        return json({ status: 'success', folders: [], data: opts.photos || PHOTOS(3) });
      }
      route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
    });
  };
  return { state, attach, requests, findByKey };
}

await suite('guest picking — a free seat blocks on a name, then loads an editable grid',
  `${base}/index.html?t=TOK`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

    await page.waitForSelector('#pickClaimOverlay:not([hidden])', { timeout: 5000 });
    ok('the claim overlay is shown while the seat is free', true);
    ok('the submit button stays hidden until claimed',
      await page.evaluate(() => getComputedStyle(document.getElementById('submitJobBtn')).display === 'none'));

    await page.fill('#pickNameInput', 'Alice');
    await page.click('#pickClaimBtn');
    await page.waitForSelector('#pickClaimOverlay', { state: 'hidden', timeout: 5000 });
    await page.waitForSelector('.photo-card', { timeout: 5000 });
    // the `hidden` IDL property passing is not enough on its own — this
    // codebase has a real case of a same-specificity CSS rule beating
    // [hidden] { display: none }, so the actual computed style is what
    // has to be checked (see .btn / display:inline-flex, and this overlay
    // hit the identical bug during development)
    ok('and it is actually invisible, not just carrying the attribute',
      await page.evaluate(() => getComputedStyle(document.getElementById('pickClaimOverlay')).display === 'none'));
    // and provably not intercepting clicks either, by actually using a
    // control underneath it
    await page.locator('.photo-card').first().locator('.pick-heart-btn').click({ timeout: 3000 });

    const storedKey = await page.evaluate(() => localStorage.getItem('pick_key:TOK'));
    ok('the picker key is stored in localStorage, keyed by the link', storedKey === 'KEY-picker-1', String(storedKey));

    const r = await page.evaluate(() => ({
      cards: document.querySelectorAll('.photo-card').length,
      stars: document.querySelectorAll('.photo-card .star-rating').length,
      selectBtns: document.querySelectorAll('.photo-card .select-toggle-btn').length,
      hearts: document.querySelectorAll('.photo-card button.pick-heart-btn').length,
      submitShown: getComputedStyle(document.getElementById('submitJobBtn')).display !== 'none',
    }));
    ok('the grid loaded', r.cards === 3, String(r.cards));
    ok('no star rating control exists — the guest heart replaces it', r.stars === 0, String(r.stars));
    ok('no select checkbox exists either — the guest heart replaces it too', r.selectBtns === 0, String(r.selectBtns));
    ok('the owner gets one clickable ♥ toggle on every card', r.hearts === 3, String(r.hearts));
    ok('完成挑圖 is shown once this browser owns the seat', r.submitShown === true);
    return out;
  },
  { before: pickFakeWorker().attach });

{
  const m = pickFakeWorker({ ownerName: 'Rhea', ownerKey: 'RHEA-KEY' });
  await suite('guest picking — the modal also gets one ♥ toggle instead of the star rating, and stays in sync with the grid',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      await page.click('.photo-card');
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const before = await page.evaluate(() => ({
        stars: document.querySelectorAll('#modalPhotoRating .star-rating').length,
        hearts: document.querySelectorAll('#modalPhotoRating .pick-heart-btn').length,
      }));
      ok('no star rating in the modal', before.stars === 0, String(before.stars));
      ok('one ♥ toggle in the modal instead', before.hearts === 1, String(before.hearts));

      await page.click('#modalPhotoRating .pick-heart-btn');
      await page.waitForTimeout(1000);
      const put = m.requests.filter(r => r.method === 'PUT').pop();
      ok('picking from the modal autosaves the real key',
        put && JSON.stringify(put.body) === JSON.stringify({ upsert: [{ photo_key: '20260819/p0.jpg', rating: 1, note: '' }], delete: [] }),
        JSON.stringify(put));

      await page.click('#closeModal');
      const gridOn = await page.locator('.photo-card').first().locator('.pick-heart-btn.on').count();
      ok('closing the modal shows the grid card already carrying the same ♥ state', gridOn === 1, String(gridOn));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'RHEA-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Bob' });
  await suite('guest picking — someone else’s seat is view-only: no rating or selecting controls, banner names them',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

      ok('no claim overlay — the seat is already taken',
        await page.evaluate(() => document.getElementById('pickClaimOverlay').hidden === true));
      ok('and it is actually invisible, not just carrying the attribute',
        await page.evaluate(() => getComputedStyle(document.getElementById('pickClaimOverlay')).display === 'none'));
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      const r = await page.evaluate(() => ({
        bannerHidden: document.getElementById('pickBanner').hidden,
        bannerText: document.getElementById('pickBannerLines').textContent,
        hintHidden: document.getElementById('pickBannerHint').hidden,
        hintText: document.getElementById('pickBannerHintText').textContent,
        cards: document.querySelectorAll('.photo-card').length,
        stars: document.querySelectorAll('.photo-card .star-rating').length,
        selectBtns: document.querySelectorAll('.photo-card .select-toggle-btn').length,
        clickableHearts: document.querySelectorAll('.photo-card button.pick-heart-btn').length,
        readonlyHearts: document.querySelectorAll('.photo-card span.pick-heart-btn').length,
        submitShown: getComputedStyle(document.getElementById('submitJobBtn')).display !== 'none',
      }));
      ok('the banner names the current owner', !r.bannerHidden && r.bannerText.includes('此相簿由 Bob 選片中'), r.bannerText);
      ok('and offers the "is this you" hint', !r.hintHidden && r.hintText === '你是 Bob 嗎？', r.hintText);
      ok('no login option — only 請攝影師重設 is offered',
        !(await page.evaluate(() => !!document.getElementById('pickBannerLoginBtn'))) &&
        r.hintText === '你是 Bob 嗎？' &&
        (await page.evaluate(() => document.getElementById('pickBannerHint').textContent)).includes('請攝影師重設'));
      ok('browsing still works — the grid loads', r.cards === 3, String(r.cards));
      ok('but no star rating control exists in the DOM (removed, not hidden)', r.stars === 0, String(r.stars));
      ok('and no select control either', r.selectBtns === 0, String(r.selectBtns));
      ok('no clickable ♥ toggle — a viewer cannot pick', r.clickableHearts === 0, String(r.clickableHearts));
      ok('the ♥ state is shown read-only instead', r.readonlyHearts === 3, String(r.readonlyHearts));
      ok('完成挑圖 stays hidden for a viewer', r.submitShown === false);
      return out;
    },
    { before: m.attach });
}

{
  const m = pickFakeWorker({ ownerName: 'Alice', ownerKey: 'ALICE-KEY', pickLimit: 1, extraPrice: 50 });
  await suite('guest picking — ratings autosave debounced and batched, and the counter warns over the limit',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      const card = i => page.locator('.photo-card').nth(i);
      await card(0).locator('.pick-heart-btn').click();
      // still inside the debounce window — nothing sent yet
      await page.waitForTimeout(200);
      ok('a ♥ toggle is debounced, not sent immediately',
        !m.requests.some(r => r.method === 'PUT'), JSON.stringify(m.requests.filter(r => r.method === 'PUT')));

      await page.waitForTimeout(900);
      const put1 = m.requests.filter(r => r.method === 'PUT' && r.path === '/api/pick/selections');
      ok('the batched PUT lands after the debounce window carrying the picker key, rating 1',
        put1.length === 1 && put1[0].key === 'ALICE-KEY' &&
        JSON.stringify(put1[0].body) === JSON.stringify({ upsert: [{ photo_key: '20260819/p0.jpg', rating: 1, note: '' }], delete: [] }),
        JSON.stringify(put1));
      ok('the card now shows the heart on',
        await card(0).locator('.pick-heart-btn.on').count() === 1);

      const counter1 = await page.evaluate(() => document.getElementById('pickCounterMain').textContent);
      ok('the counter shows the plan’s limit', counter1 === '已選 1 / 1', counter1);
      ok('no over-limit warning yet',
        await page.evaluate(() => document.getElementById('pickCounterWarn').hidden === true));

      await card(1).locator('.pick-heart-btn').click();
      await page.waitForTimeout(1000);
      const counter2 = await page.evaluate(() => document.getElementById('pickCounterMain').textContent);
      ok('the counter now reads 2', counter2 === '已選 2 / 1', counter2);
      const warn = await page.evaluate(() => ({
        hidden: document.getElementById('pickCounterWarn').hidden,
        text: document.getElementById('pickCounterWarn').textContent,
      }));
      ok('warns over the limit, with the per-photo fee, and never blocks anything',
        !warn.hidden && warn.text === '方案 1 張精修，您已選 2 張，多 1 張，每張 NT$50 加挑費', warn.text);

      const badge1 = await page.evaluate(() => document.getElementById('pickFilterSelectedCount').textContent);
      ok('the ♥ 已選 filter badge tracks the same count', badge1 === '2', badge1);

      // clicking an already-on heart turns it back off — rating 0, not 1
      await card(0).locator('.pick-heart-btn').click();
      await page.waitForTimeout(1000);
      const put2 = m.requests.filter(r => r.method === 'PUT' && r.path === '/api/pick/selections');
      ok('un-picking sends rating 0',
        JSON.stringify(put2[put2.length - 1].body) === JSON.stringify({ upsert: [{ photo_key: '20260819/p0.jpg', rating: 0, note: '' }], delete: [] }),
        JSON.stringify(put2[put2.length - 1]));
      ok('the heart is off again', await card(0).locator('.pick-heart-btn.on').count() === 0);
      const counter3 = await page.evaluate(() => document.getElementById('pickCounterMain').textContent);
      ok('the counter drops back to 1', counter3 === '已選 1 / 1', counter3);
      return out;
    },
    {
      before: m.attach,
      initScript: () => localStorage.setItem('pick_key:TOK', 'ALICE-KEY'),
    });
}

{
  const m = pickFakeWorker({ ownerName: 'Carol', ownerKey: 'CAROL-KEY' });
  await suite('guest picking — submit shows the server’s real errors, then a real success, then the submitted phase',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      await page.click('#submitJobBtn');
      await page.waitForSelector('#pickSubmitModal.active', { timeout: 5000 });
      const nameVal = await page.inputValue('#pickSubmitName');
      ok('the name is prefilled from the claimed seat', nameVal === 'Carol', nameVal);

      // relationship left unset — the server, not a made-up client message,
      // is what says so
      await page.click('#pickSubmitConfirmBtn');
      await page.waitForTimeout(300);
      const err1 = await page.textContent('#pickSubmitErr');
      ok('a missing relationship is refused with the server’s own message',
        err1 === '請選擇與新人的關係', err1);

      await page.selectOption('#pickSubmitRelationship', '朋友');
      await page.fill('#pickSubmitEmail', 'not-an-email');
      await page.click('#pickSubmitConfirmBtn');
      await page.waitForTimeout(300);
      const err2 = await page.textContent('#pickSubmitErr');
      ok('a malformed email is refused with the server’s own message',
        err2 === 'Email 格式不正確', err2);

      await page.fill('#pickSubmitEmail', '');
      await page.click('#pickSubmitConfirmBtn');
      await page.waitForTimeout(300);
      const closed = await page.evaluate(() => !document.getElementById('pickSubmitModal').classList.contains('active'));
      ok('a valid submit closes the modal', closed);

      // the last one — the two refused attempts before it posted too
      const submitReqs = m.requests.filter(r => r.method === 'POST' && r.path === '/api/pick/submit');
      const submitReq = submitReqs[submitReqs.length - 1];
      ok('and the successful attempt actually posted relationship + no email',
        submitReq && submitReq.body.relationship === '朋友' && !submitReq.body.email,
        JSON.stringify(submitReq));

      const banner = await page.evaluate(() => document.getElementById('pickBannerLines').textContent);
      ok('the phase banner now says 已送出', banner.includes('已送出'), banner);

      // saving again while submitted must not block, and must raise the
      // "modified since submit" notice (docs/guest-picking.md)
      await page.locator('.photo-card').nth(0).locator('.pick-heart-btn').click();
      await page.waitForTimeout(1000);
      const banner2 = await page.evaluate(() => document.getElementById('pickBannerLines').textContent);
      ok('a save after submit shows 已修改，請重新送出', banner2.includes('已修改，請重新送出'), banner2);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'CAROL-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Dora', ownerKey: 'DORA-KEY' });
  await suite('guest picking — retouching starting mid-session locks the owner out and removes the controls',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      ok('editable at first', await page.evaluate(() =>
        document.querySelectorAll('.photo-card button.pick-heart-btn').length === 3));

      // the photographer starts retouching in another tab while this one is
      // mid-session; the next save is refused with 409 retouching
      m.state.project.phase = 'retouching';
      await page.locator('.photo-card').nth(0).locator('.pick-heart-btn').click();
      await page.waitForTimeout(1000);

      const r = await page.evaluate(() => ({
        banner: document.getElementById('pickBannerLines').textContent,
        stars: document.querySelectorAll('.photo-card .star-rating').length,
        selectBtns: document.querySelectorAll('.photo-card .select-toggle-btn').length,
        clickableHearts: document.querySelectorAll('.photo-card button.pick-heart-btn').length,
        submitShown: getComputedStyle(document.getElementById('submitJobBtn')).display !== 'none',
      }));
      ok('shows the LINE-contact notice', r.banner.includes('攝影師已安排精修，如需修改請透過 LINE 聯絡攝影師'), r.banner);
      ok('no star rating control (never existed in pick mode)', r.stars === 0, String(r.stars));
      ok('no select control either', r.selectBtns === 0, String(r.selectBtns));
      ok('every clickable ♥ toggle is gone from the DOM', r.clickableHearts === 0, String(r.clickableHearts));

      // submitJob() itself must also refuse, not just the autosave path
      await page.evaluate(() => window.app.submitJob());
      await page.waitForTimeout(200);
      ok('and the submit modal does not open',
        await page.evaluate(() => !document.getElementById('pickSubmitModal').classList.contains('active')));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'DORA-KEY') });
}

await suite('guest picking — the studio/client choice overlay and other modes are untouched without ?t=',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    ok('PickController exists but is inactive', await page.evaluate(() =>
      !!window.PickController && window.PickController.active === false));
    ok('the pick counter never appears in a mode that never turns it on',
      await page.evaluate(() => getComputedStyle(document.getElementById('pickCounter')).display === 'none'));
    ok('the ♥ filter bar stays hidden too — no pick mode to unhide it',
      await page.evaluate(() => getComputedStyle(document.getElementById('pickFilterBar')).display === 'none'));
    ok('the star filter and 只看選取 are untouched, still in the DOM',
      await page.evaluate(() => !!document.querySelector('.star-filter') && !!document.getElementById('filterSelectedBtn')));
    ok('the studio/client choice overlay still appears',
      await page.waitForSelector('#auth-overlay', { timeout: 5000 }).then(() => true, () => false));
    return out;
  },
  { before: mockWorker(1) });

{
  const XSS_NAME = '"><img src=x onerror="window.__xss=1">';
  const m = pickFakeWorker({ ownerName: XSS_NAME });
  await suite('guest picking — 惡意姓名 escaping（seat-holder banner）',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await new Promise(r => setTimeout(r, 300));
      const r = await page.evaluate(payload => ({
        fired: !!window.__xss,
        injected: document.querySelectorAll('img[src="x"]').length,
        bannerText: document.getElementById('pickBannerLines').textContent,
        hintText: document.getElementById('pickBannerHintText').textContent,
      }), XSS_NAME);
      ok('惡意姓名沒有變成元素', r.injected === 0, `注入了 ${r.injected} 個 img`);
      ok('onerror 沒有執行', r.fired === false, String(r.fired));
      ok('banner 仍照原樣顯示姓名', r.bannerText.includes(XSS_NAME), JSON.stringify(r.bannerText));
      ok('hint 仍照原樣顯示姓名', r.hintText.includes(XSS_NAME), JSON.stringify(r.hintText));
      return out;
    },
    { before: m.attach });
}

{
  // Distinct photos per folder, so 'which folder is on screen' is provable
  // from the grid itself, not just from which sidebar row is marked active.
  const m = pickFakeWorker({
    ownerName: 'Fiona', ownerKey: 'FIONA-KEY',
    folders: ['20260819/', '20260901/'],
    photosByFolder: {
      '20260819/': PHOTOS(3),
      '20260901/': [{ id: '20260901/q0.jpg', name: 'q0.jpg', size: 9e6, rating: 0 }],
    },
  });
  await suite('guest picking — multi-folder: the left 資料夾 panel lists every folder, switches between them, and the old path box/LOAD are gone',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      ok('the old path input is gone from the DOM entirely',
        await page.evaluate(() => document.getElementById('driveUrl') === null));
      ok('and so is the LOAD button',
        await page.evaluate(() => document.getElementById('loadPhotosBtn') === null));

      const r1 = await page.evaluate(() => ({
        rows: [...document.querySelectorAll('#folderTree .tree-row')].map(el => el.dataset.folder),
        activeRows: [...document.querySelectorAll('#folderTree .tree-row.tree-active')].map(el => el.dataset.folder),
        cards: document.querySelectorAll('.photo-card').length,
        panelShown: getComputedStyle(document.getElementById('folderTreeContainer')).display !== 'none',
      }));
      ok('the panel is shown', r1.panelShown === true);
      ok('both permitted folders are listed, in the token’s order',
        JSON.stringify(r1.rows) === JSON.stringify(['20260819/', '20260901/']), JSON.stringify(r1.rows));
      ok('the first folder loaded automatically', r1.cards === 3, String(r1.cards));
      ok('and it is the one highlighted',
        JSON.stringify(r1.activeRows) === JSON.stringify(['20260819/']), JSON.stringify(r1.activeRows));

      await page.click('#folderTree .tree-row[data-folder="20260901/"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 1,
        null, { timeout: 5000 });
      const r2 = await page.evaluate(() => ({
        rows: [...document.querySelectorAll('#folderTree .tree-row')].map(el => el.dataset.folder),
        activeRows: [...document.querySelectorAll('#folderTree .tree-row.tree-active')].map(el => el.dataset.folder),
        cardName: document.querySelector('.photo-card .photo-name')?.textContent,
      }));
      ok('clicking the other folder actually loads its (different) photos',
        r2.cardName === 'q0.jpg', String(r2.cardName));
      ok('and moves the highlight to it, off the first',
        JSON.stringify(r2.activeRows) === JSON.stringify(['20260901/']), JSON.stringify(r2.activeRows));
      ok('the list is repainted, not appended to — still exactly the two folders',
        JSON.stringify(r2.rows) === JSON.stringify(['20260819/', '20260901/']), JSON.stringify(r2.rows));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'FIONA-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Gary', ownerKey: 'GARY-KEY' });
  await suite('guest picking — the annotation toolbox is removed from the DOM (no server storage for it); notes and the photo canvas stay',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.click('.photo-card');
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });

      const r = await page.evaluate(() => ({
        toolButtons: document.querySelectorAll('.tool-btn').length,
        colorPicker: document.querySelector('.color-picker'),
        brushSlider: document.getElementById('brushSize'),
        clearAllBtn: document.getElementById('clearAnnotationBtn'),
        noteBox: document.getElementById('noteInputGroup'),
        canvas: document.getElementById('photoCanvas'),
      }));
      ok('no tool buttons (select/pan/circle/eraser/undo/redo/delete) remain',
        r.toolButtons === 0, String(r.toolButtons));
      ok('the colour picker is gone', r.colorPicker === null);
      ok('the brush-size slider is gone', r.brushSlider === null);
      ok('the 清除全部 button is gone', r.clearAllBtn === null);
      ok('the note box stays — notes are stored server-side (selections.note)',
        r.noteBox !== null);
      ok('the photo canvas itself stays — it is still the photo viewer',
        r.canvas !== null);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'GARY-KEY') });
}

{
  // Distinct photos per folder again, so the cross-folder ♥ 已選 view is
  // provably pulling from both, not just repainting the current one.
  const m = pickFakeWorker({
    ownerName: 'Iris', ownerKey: 'IRIS-KEY',
    folders: ['20260819/', '20260901/'],
    photosByFolder: {
      '20260819/': PHOTOS(3),
      '20260901/': [{ id: '20260901/q0.jpg', name: 'q0.jpg', size: 9e6, rating: 0 }],
    },
  });
  m.state.selections.set('20260819/p0.jpg', { rating: 1, note: '', updated_by: 'picker-0', updated_at: 't' });
  m.state.selections.set('20260901/q0.jpg', { rating: 1, note: '', updated_by: 'picker-0', updated_at: 't' });
  await suite('guest picking — the 全部/♥已選/未選 filter bar replaces the star filter; 已選 reaches across every folder',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      ok('the star filter is gone from the DOM entirely',
        await page.evaluate(() => document.querySelector('.star-filter') === null));
      ok('so is 只看選取',
        await page.evaluate(() => document.getElementById('filterSelectedBtn') === null));
      const barShown = await page.evaluate(() =>
        getComputedStyle(document.getElementById('pickFilterBar')).display !== 'none');
      ok('the ♥ filter bar is shown instead', barShown);

      const all1 = await page.evaluate(() => [...document.querySelectorAll('.photo-card .photo-name')].map(e => e.textContent));
      ok('全部 (default) shows the current folder’s own 3 photos',
        JSON.stringify(all1) === JSON.stringify(['p0.jpg', 'p1.jpg', 'p2.jpg']), JSON.stringify(all1));
      ok('the picked one already shows its heart on',
        await page.locator('.photo-card').first().locator('.pick-heart-btn.on').count() === 1);

      await page.click('#pickFilterBar [data-pick-filter="unselected"]');
      const unsel = await page.evaluate(() => [...document.querySelectorAll('.photo-card .photo-name')].map(e => e.textContent));
      ok('未選 drops the already-picked one, current folder only',
        JSON.stringify(unsel) === JSON.stringify(['p1.jpg', 'p2.jpg']), JSON.stringify(unsel));

      await page.click('#pickFilterBar [data-pick-filter="selected"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 2, null, { timeout: 5000 });
      const sel = await page.evaluate(() => ({
        names: [...document.querySelectorAll('.photo-card .photo-name')].map(e => e.textContent),
        // the thumbnail for the OTHER folder's photo, loaded the same way the
        // grid loads any thumbnail — with the pick token on the URL
        otherSrc: document.querySelector('.photo-card[data-photo-id="20260901/q0.jpg"] img')?.getAttribute('src'),
      }));
      ok('♥ 已選 lists the pick from both folders, one page, sorted by key',
        JSON.stringify(sel.names) === JSON.stringify(['p0.jpg', 'q0.jpg']), JSON.stringify(sel.names));
      ok('the other folder’s thumbnail is fetched straight from its key + the pick token',
        !!sel.otherSrc && sel.otherSrc.includes('20260901/q0.jpg') && sel.otherSrc.includes('t=TOK'), sel.otherSrc);

      // un-picking from inside the cross-folder view removes it from the list
      // right there, and still autosaves the real key
      await page.locator('.photo-card[data-photo-id="20260901/q0.jpg"] .pick-heart-btn').click();
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 1, null, { timeout: 5000 });
      await page.waitForTimeout(1000);
      const lastPut = m.requests.filter(r => r.method === 'PUT').pop();
      ok('the real full-path key was sent, rating 0',
        lastPut && JSON.stringify(lastPut.body) === JSON.stringify({ upsert: [{ photo_key: '20260901/q0.jpg', rating: 0, note: '' }], delete: [] }),
        JSON.stringify(lastPut));

      await page.click('#pickFilterBar [data-pick-filter="all"]');
      const backToAll = await page.evaluate(() => [...document.querySelectorAll('.photo-card .photo-name')].map(e => e.textContent));
      ok('全部 goes back to the current folder', JSON.stringify(backToAll) === JSON.stringify(['p0.jpg', 'p1.jpg', 'p2.jpg']), JSON.stringify(backToAll));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'IRIS-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Kelly', ownerKey: 'KELLY-KEY' });
  for (let i = 0; i < 500; i++) m.state.selections.set(`20260819/extra${i}.jpg`, { rating: 1, note: '', updated_by: 'picker-0', updated_at: 't' });
  await suite('guest picking — 409 selection_cap reverts the ♥ toggle and warns with the plan’s wording',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      await page.locator('.photo-card').first().locator('.pick-heart-btn').click();
      await page.waitForFunction(() => {
        const t = document.querySelector('.toast.error .toast-message');
        return t && t.textContent.length > 0;
      }, null, { timeout: 5000 });
      const msg = await page.evaluate(() => document.querySelector('.toast.error .toast-message').textContent);
      ok('shows 最多可選 500 張', msg === '最多可選 500 張', msg);
      const revertedOk = await page.waitForFunction(() =>
        document.querySelectorAll('.photo-card').length &&
        !document.querySelector('.photo-card').querySelector('.pick-heart-btn.on'), null, { timeout: 5000 })
        .then(() => true, () => false);
      ok('the heart reverts to off — nothing was actually saved', revertedOk);
      const put = m.requests.filter(r => r.method === 'PUT').pop();
      ok('the refused save did carry the attempted upsert',
        put && put.body.upsert[0].rating === 1, JSON.stringify(put));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'KELLY-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Quinn', ownerKey: 'QUINN-KEY' });
  // exactly PICK_MAX_ROWS existing rows, rating 0 (un-starred, so they cost
  // nothing against the star cap) and none of them the folder’s own 3 photos
  // — so the very first ♥ click adds a brand-new row and tips the row cap.
  for (let i = 0; i < 1000; i++) m.state.selections.set(`20260819/row${i}.jpg`, { rating: 0, note: '', updated_by: 'picker-0', updated_at: 't' });
  await suite('guest picking — 409 row_cap reverts the ♥ toggle too, with the server’s own wording',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      await page.locator('.photo-card').first().locator('.pick-heart-btn').click();
      await page.waitForFunction(() => {
        const t = document.querySelector('.toast.error .toast-message');
        return t && t.textContent.length > 0;
      }, null, { timeout: 5000 });
      const msg = await page.evaluate(() => document.querySelector('.toast.error .toast-message').textContent);
      ok('shows the server’s row-cap wording, not a made-up one',
        msg === '最多只能保留 1000 筆', msg);
      const revertedOk = await page.waitForFunction(() =>
        document.querySelectorAll('.photo-card').length &&
        !document.querySelector('.photo-card').querySelector('.pick-heart-btn.on'), null, { timeout: 5000 })
        .then(() => true, () => false);
      ok('the heart reverts to off here too', revertedOk);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'QUINN-KEY') });
}

{
  // A key this odd never comes from a real folder listing, but the client
  // has to survive the server refusing it anyway rather than crash or lie
  // about what got saved (docs/guest-picking.md rule 7).
  const BAD_PHOTO = { id: '20260819/bad\u0000name.jpg', name: 'bad\u0000name.jpg', size: 1, rating: 0 };
  const m = pickFakeWorker({ ownerName: 'Leo', ownerKey: 'LEO-KEY', photos: [BAD_PHOTO] });
  await suite('guest picking — 400 invalid_photo_key reverts the ♥ toggle too, without crashing',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      await page.locator('.pick-heart-btn').click();
      await page.waitForFunction(() => {
        const t = document.querySelector('.toast.error .toast-message');
        return t && t.textContent.length > 0;
      }, null, { timeout: 5000 });
      const msg = await page.evaluate(() => document.querySelector('.toast.error .toast-message').textContent);
      ok('shows the server’s own message, not "undefined"',
        msg === '照片名稱不正確', msg);
      const revertedOk = await page.waitForFunction(() =>
        document.querySelectorAll('.pick-heart-btn.on').length === 0, null, { timeout: 5000 })
        .then(() => true, () => false);
      ok('the heart reverts to off', revertedOk);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'LEO-KEY') });
}

{
  // A viewer's own /api/pick/state response carries no `note` field at all
  // (docs/guest-picking.md) — the client must not crash or print "undefined".
  const m = pickFakeWorker({ ownerName: 'Mona' });
  m.state.selections.set('20260819/p0.jpg', { rating: 4, note: '放大這張', updated_by: 'picker-0', updated_at: 't' });
  await suite('guest picking — a viewer’s state has no note field; nothing crashes or shows "undefined"',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const text = await page.evaluate(() => document.body.textContent);
      ok('no stray "undefined" anywhere on the page', !/undefined/.test(text), text.slice(0, 200));
      ok('the viewer still sees the ♥ state (read-only)',
        await page.locator('.photo-card').first().locator('span.pick-heart-btn.on').count() === 1);
      return out;
    },
    { before: m.attach });
}

// A studio session (photographer, via studio_token) must be completely
// unaffected: the same path box + LOAD that guests and clients lose here is
// still how a photographer opens an arbitrary folder in the bucket.
await suite('photographer mode — the path box, LOAD button and folder tree are untouched',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!document.getElementById('studio-logout'),
      null, { timeout: 5000 }).catch(() => {});

    const r = await page.evaluate(() => ({
      inputPresent: !!document.getElementById('driveUrl'),
      loadBtnPresent: !!document.getElementById('loadPhotosBtn'),
      loadBtnShown: (() => {
        const el = document.getElementById('loadPhotosBtn');
        return !!el && getComputedStyle(el).display !== 'none';
      })(),
    }));
    ok('the path input is still there', r.inputPresent === true);
    ok('the LOAD button is still there', r.loadBtnPresent === true);
    ok('and actually shown, not just present', r.loadBtnShown === true);

    await page.fill('#driveUrl', '20260819/');
    await page.click('#loadPhotosBtn');
    await page.waitForSelector('.photo-card', { timeout: 5000 });
    const cards = await page.evaluate(() => document.querySelectorAll('.photo-card').length);
    ok('typing a path and clicking LOAD still loads photos, exactly as before',
      cards === 3, String(cards));

    const controls = await page.evaluate(() => ({
      stars: document.querySelectorAll('.photo-card .star-rating').length,
      selectBtns: document.querySelectorAll('.photo-card .select-toggle-btn').length,
      hearts: document.querySelectorAll('.photo-card .pick-heart-btn').length,
    }));
    ok('the star rating and select checkbox are exactly what a photographer still gets',
      controls.stars === 3 && controls.selectBtns === 3, JSON.stringify(controls));
    ok('the guest-only ♥ toggle never appears here', controls.hearts === 0, String(controls.hearts));
    return out;
  },
  {
    initScript: () => {
      try {
        if (!localStorage.getItem('__seeded_studio2')) {
          localStorage.setItem('__seeded_studio2', '1');
          sessionStorage.setItem('studio_token', 'adm');
        }
      } catch (e) { /* private mode */ }
    },
    before: pickFakeWorker().attach,
  });

// ═══════════════════════════════════════════════════════════════════════════
// Admin — the guest-picking project panel (docs/guest-picking.md)
// ═══════════════════════════════════════════════════════════════════════════

{
  const m = pickFakeWorker({ bucketFolders: ['20260819/', '20260901/'] });
  await suite('admin — create a pick project via the existing folder picker, and get a link back',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#admin-view', { state: 'visible', timeout: 5000 });

      await page.fill('#proj-title', 'Wei & Lin 婚紗');
      await page.click('#proj-pick-folders-btn');
      await page.waitForSelector('#folder-picker', { state: 'visible' });
      await page.waitForSelector('[data-pick-folder]');
      await page.click('[data-pick-folder]');
      await page.click('[data-confirm-folders]');
      await page.waitForSelector('#folder-picker', { state: 'hidden' });

      const chipCount = await page.locator('#proj-folders-cell .folder-chip').count();
      ok('the chosen folder is shown as a chip', chipCount === 1, String(chipCount));

      await page.fill('#proj-pick-limit', '40');
      await page.fill('#proj-extra-price', '300');
      await page.click('#proj-create-btn');
      await page.waitForSelector('#proj-create-result', { state: 'visible', timeout: 5000 });

      const createReq = m.requests.find(r => r.method === 'POST' && r.path === '/api/admin/projects');
      ok('posted title, folders and the plan',
        createReq && createReq.body.title === 'Wei & Lin 婚紗' &&
        Array.isArray(createReq.body.folders) && createReq.body.folders.length === 1 &&
        createReq.body.pick_limit === 40 && createReq.body.extra_price === 300,
        JSON.stringify(createReq));

      const link = await page.inputValue('#proj-link-output');
      ok('the guest link carries the pick token', /[?&]t=PICK-TOKEN(&|$)/.test(link), link);
      ok('and points at index.html', /index\.html\?/.test(link), link);

      const projectPanelShown = await page.evaluate(() =>
        document.getElementById('project-detail-panel').style.display !== 'none');
      ok('the new project opens its detail view right away', projectPanelShown);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  // GET /api/admin/projects replaces the per-browser localStorage cache —
  // this project is never seeded into this browser at all, only served by
  // the fake Worker's list route, which is the point.
  const XSS_TITLE = '"><img src=x onerror="window.__xssTitle=1">';
  const XSS_OWNER = '"><img src=x onerror="window.__xssOwner=1">';
  const m = pickFakeWorker({ title: XSS_TITLE, ownerName: XSS_OWNER });
  m.state.submissions.push(
    { id: 's1', picker_id: 'picker-0', relationship: '本人', email: null,
      photo_keys: ['20260819/p0.jpg'], count: 1, pick_limit: null, extra_price: null,
      created_at: '2026-01-01T00:00:00Z' },
  );
  m.state.project.phase = 'submitted';
  m.state.project.modified_after_submit = 1;
  await suite('admin — project list: read from GET /api/admin/projects, not a localStorage cache; phase/owner/modified/submission badges, a copy-link, and escaping',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-project-row]', { timeout: 5000 });

      ok('no localStorage cache is written or read',
        await page.evaluate(() => localStorage.getItem('admin_recent_projects') === null));

      const r = await page.evaluate(() => {
        const row = document.querySelector('[data-project-row]');
        return {
          text: row.textContent,
          injected: document.querySelectorAll('img[src="x"]').length,
          hasCopyBtn: !!row.querySelector('[data-copy-link]'),
        };
      });
      ok('惡意標題／認領人姓名沒有變成元素', r.injected === 0, `注入了 ${r.injected} 個 img`);
      ok('title shown as text, unescaped payload intact', r.text.includes(XSS_TITLE), r.text);
      ok('owner shown as text, unescaped payload intact', r.text.includes(XSS_OWNER), r.text);
      ok('the phase badge is shown', r.text.includes('已送出'), r.text);
      ok('the modified-since-submit badge is shown', r.text.includes('已修改'), r.text);
      ok('the submission count is shown', r.text.includes('1'), r.text);
      ok('a copy-link button is offered when the project has a live token', r.hasCopyBtn === true);

      await page.click('[data-open-project]');
      await page.waitForSelector('#project-detail-panel', { state: 'visible', timeout: 5000 });
      ok('clicking it opens the existing detail view',
        await page.evaluate(() => document.getElementById('project-detail-panel').style.display !== 'none'));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  // No live pick link (revoked/expired/never minted): no copy-link button.
  const m = pickFakeWorker({ listToken: null });
  await suite('admin — project list: no copy-link button when the project has no live token',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-project-row]', { timeout: 5000 });
      const hasCopyBtn = await page.evaluate(() => !!document.querySelector('[data-copy-link]'));
      ok('no copy-link button is rendered', hasCopyBtn === false);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Grace' });
  m.state.selections.set('20260819/p0.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  m.state.selections.set('20260819/p1.jpg', { rating: 0, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  m.state.submissions.push(
    { id: 's1', picker_id: 'picker-0', relationship: '本人', email: null,
      photo_keys: ['20260819/p2.jpg'], count: 1, pick_limit: null, extra_price: null,
      created_at: '2026-01-01T00:00:00Z' },
    { id: 's2', picker_id: 'picker-0', relationship: '本人', email: 'a@b.com',
      photo_keys: ['20260819/p0.jpg'], count: 1, pick_limit: null, extra_price: null,
      created_at: '2026-01-02T00:00:00Z' },
  );
  m.state.project.phase = 'submitted'; // a real submit is what moves the phase; seeding submissions directly does not
  await suite('admin — project detail: owner, phase, submissions newest-first with a diff, current selections, actions',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#admin-view', { state: 'visible', timeout: 5000 });
      // opened straight from the real GET /api/admin/projects list — no
      // localStorage cache and no reload needed for it to show up
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#project-detail-panel', { state: 'visible' });
      await page.waitForSelector('#pd-submissions .pd-submission');

      const r = await page.evaluate(() => ({
        owner: document.querySelector('.pd-owner').textContent,
        phaseBadge: document.querySelector('.pd-head .badge').textContent,
        submissionBlocks: [...document.querySelectorAll('.pd-submission')].map(b => b.textContent),
        selectionRows: document.querySelectorAll('#project-detail-body table tbody tr').length,
      }));
      ok('shows the current owner', r.owner.includes('Grace'), r.owner);
      ok('shows the phase', r.phaseBadge === '已送出', r.phaseBadge);
      // times render in Asia/Taipei (task: 時間格式), not the raw UTC ISO —
      // 2026-01-0{1,2}T00:00:00Z is 08:00 Taipei the same calendar day
      ok('submissions are newest first', /1\/2 08:00/.test(r.submissionBlocks[0]) && /1\/1 08:00/.test(r.submissionBlocks[1]),
        JSON.stringify(r.submissionBlocks));
      ok('the newest submission’s diff names what changed since the previous one',
        r.submissionBlocks[0].includes('新增') && r.submissionBlocks[0].includes('p0.jpg') &&
        r.submissionBlocks[0].includes('移除') && r.submissionBlocks[0].includes('p2.jpg'),
        r.submissionBlocks[0]);
      ok('current selections only lists rating > 0 (one row, not the zero-rated one)',
        r.selectionRows === 1, String(r.selectionRows));

      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

await suite('admin — escHtml(0): a project with zero submissions shows 送出 0 次, not blank',
  `${base}/admin.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForSelector('[data-project-row]', { timeout: 5000 });
    const text = await page.evaluate(() => document.querySelector('[data-project-row]').textContent);
    ok('shows 送出 0 次, the digit is there', /送出\s*0\s*次/.test(text), text);
    return out;
  },
  { before: pickFakeWorker().attach, initScript: ADMIN });

{
  const m = pickFakeWorker({ ownerName: 'Nora', ownerKey: 'NORA-KEY' });
  await suite('admin — 重設主人 warns that the new owner inherits and can change or delete every pick',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-reset-seat-btn', { timeout: 5000 });

      let dialogMsg = '';
      page.once('dialog', d => { dialogMsg = d.message(); d.dismiss(); });
      await page.click('#pd-reset-seat-btn');
      await page.waitForTimeout(200);
      ok('warns that the new owner takes over every current pick and can change or delete it',
        dialogMsg.includes('新的主人會接手目前所有選片，並可修改或刪除'), dialogMsg);
      ok('dismissing it does not reset the seat',
        !m.requests.some(r => r.method === 'POST' && r.path.endsWith('/reset-seat')));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Oscar', ownerKey: 'OSCAR-KEY' });
  await suite('admin — project detail: pick links with status, 撤銷, and 產生新連結 with copy',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('[data-token-row]', { timeout: 5000 });

      const before = await page.evaluate(() => ({
        rows: document.querySelectorAll('[data-token-row]').length,
        status: document.querySelector('[data-token-row] .badge')?.textContent,
        revokeBtn: !!document.querySelector('[data-revoke-token]'),
      }));
      ok('the live link is listed with its status', before.rows === 1 && before.status === '有效', JSON.stringify(before));
      ok('a live link offers 撤銷', before.revokeBtn);

      page.once('dialog', d => d.accept());
      await page.click('[data-revoke-token]');
      await page.waitForFunction(() =>
        document.querySelector('[data-token-row] .badge')?.textContent === '已撤銷', null, { timeout: 5000 });
      const afterRevoke = await page.evaluate(() => ({
        rows: document.querySelectorAll('[data-token-row]').length,
        revokeBtn: !!document.querySelector('[data-revoke-token]'),
      }));
      ok('撤銷 flips it to 已撤銷 and drops its own 撤銷/複製連結 buttons',
        afterRevoke.rows === 1 && afterRevoke.revokeBtn === false, JSON.stringify(afterRevoke));
      ok('the real revoke endpoint was called',
        m.requests.some(r => r.method === 'POST' && /\/api\/shares\/.+\/revoke$/.test(r.path)));

      await page.click('#pd-new-link-btn');
      await page.waitForFunction(() => document.querySelectorAll('[data-token-row]').length === 2, null, { timeout: 5000 });
      const afterMint = await page.evaluate(() => ({
        rows: document.querySelectorAll('[data-token-row]').length,
        liveCount: [...document.querySelectorAll('[data-token-row] .badge')].filter(b => b.textContent === '有效').length,
      }));
      ok('產生新連結 adds a fresh live one, the old one stays revoked',
        afterMint.rows === 2 && afterMint.liveCount === 1, JSON.stringify(afterMint));
      ok('the mint endpoint was posted to',
        m.requests.some(r => r.method === 'POST' && r.path.endsWith('/links')));
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      ok('the new link is copied to the clipboard', /index\.html\?t=PICK-TOKEN-2/.test(clip), clip);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Paula' });
  m.state.submissions.push(
    { id: 's1', picker_id: 'picker-0', relationship: '本人', email: null,
      photo_keys: ['20260819/p0.jpg'], count: 1, pick_limit: null, extra_price: null,
      created_at: '2026-01-01T00:00:00Z', notified: 1 },
    { id: 's2', picker_id: 'picker-0', relationship: '本人', email: null,
      photo_keys: ['20260819/p0.jpg', '20260819/p1.jpg'], count: 2, pick_limit: null, extra_price: null,
      created_at: '2026-01-02T00:00:00Z', notified: 0 },
  );
  await suite('admin — badge "N 次送出未寄信" in the list and detail, and a per-submission 未寄信 marker',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-project-row]', { timeout: 5000 });
      const listText = await page.evaluate(() => document.querySelector('[data-project-row]').textContent);
      ok('the list shows 1 次送出未寄信', listText.includes('1 次送出未寄信'), listText);

      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-submissions .pd-submission', { timeout: 5000 });
      const r = await page.evaluate(() => ({
        headText: document.querySelector('.pd-head').textContent,
        blocks: [...document.querySelectorAll('.pd-submission')].map(b => b.textContent),
      }));
      ok('the detail head shows the same badge', r.headText.includes('1 次送出未寄信'), r.headText);
      ok('the newest (unmailed) submission carries its own 未寄信 marker', r.blocks[0].includes('未寄信'), r.blocks[0]);
      ok('the older, already-mailed one does not', !r.blocks[1].includes('未寄信'), r.blocks[1]);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Henry' });
  m.state.selections.set('20260819/p0.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('admin — 下載選片 asks whether to start retouching too',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#admin-view', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-download-btn');

      // Playwright/headless Chromium does not reliably report a blob: URL
      // download's real filename through suggestedFilename() (reproduced in
      // isolation: it comes back as the literal string "download" even for a
      // plain ASCII name), so the anchor's own `download` attribute — what
      // the app actually set — is captured directly instead.
      await page.evaluate(() => {
        window.__lastDownloadName = null;
        const orig = document.body.appendChild.bind(document.body);
        document.body.appendChild = (el) => {
          if (el.tagName === 'A' && el.download) window.__lastDownloadName = el.download;
          return orig(el);
        };
      });

      let dialogMsg = '';
      page.once('dialog', d => { dialogMsg = d.message(); d.accept(); });
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.click('#pd-download-btn'),
      ]);
      ok('asks about starting retouching', dialogMsg.includes('要同時標記為開始精修嗎'), dialogMsg);
      const namedFile = await page.evaluate(() => window.__lastDownloadName);
      ok('offers a .txt file', (namedFile || '').endsWith('.txt'), namedFile);
      const path = await download.path();
      const content = readFileSync(path, 'utf8');
      ok('the file lists the selected key(s)', content.includes('20260819/p0.jpg'), content);

      await page.waitForTimeout(300);
      const startReq = m.requests.find(r => r.method === 'POST' && r.path.endsWith('/start-retouch'));
      ok('accepting the dialog also starts retouching', !!startReq, JSON.stringify(m.requests));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const XSS_NAME = '"><img src=x onerror="window.__xss=1">';
  const m = pickFakeWorker({ ownerName: XSS_NAME });
  m.state.pickers.get('picker-0').relationship = XSS_NAME;
  m.state.pickers.get('picker-0').email = XSS_NAME;
  m.state.selections.set('20260819/p0.jpg', { rating: 3, note: XSS_NAME, updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  m.state.submissions.push({ id: 's1', picker_id: 'picker-0', relationship: XSS_NAME, email: XSS_NAME,
    photo_keys: ['20260819/p0.jpg'], count: 1, pick_limit: null, extra_price: null, created_at: '2026-01-01T00:00:00Z' });
  await suite('admin — 惡意姓名／關係／Email／備註 escaping（專案詳細頁）',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#admin-view', { state: 'visible', timeout: 5000 });
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#project-detail-body table');
      await new Promise(r => setTimeout(r, 300));

      const r = await page.evaluate(payload => ({
        fired: !!window.__xss,
        injected: document.querySelectorAll('img[src="x"]').length,
        ownerShown: document.querySelector('.pd-owner').textContent.includes(payload),
        pickersShown: document.getElementById('pd-pickers').textContent.includes(payload),
        submissionsShown: document.getElementById('pd-submissions').textContent.includes(payload),
        selectionsShown: document.querySelector('#project-detail-body table').textContent.includes(payload),
      }), XSS_NAME);
      ok('惡意字串沒有變成元素', r.injected === 0, `注入了 ${r.injected} 個 img`);
      ok('onerror 沒有執行', r.fired === false, String(r.fired));
      ok('owner 仍照原樣顯示', r.ownerShown);
      ok('pickers 清單仍照原樣顯示', r.pickersShown);
      ok('送出紀錄仍照原樣顯示', r.submissionsShown);
      ok('目前選取（備註）仍照原樣顯示', r.selectionsShown);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ═══════════════════════════════════════════════════════════════════════════
// Mobile picking gestures — the preview modal on a phone (task: mobile
// gestures). Guests use phones, often LINE's in-app browser or iOS Safari,
// so the full-size preview needs touch-native swipe/pinch/pan/double-tap on
// top of the existing mouse+keyboard behaviour, which must keep working too.
// ═══════════════════════════════════════════════════════════════════════════

{
  const m = pickFakeWorker({ ownerName: 'Mia', ownerKey: 'MIA-KEY', photos: PHOTOS(5) });
  await suite('mobile preview — swipe left/right navigates, swipe down closes; short/diagonal moves do neither',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const counter = () => page.textContent('#photoCounter');
      const isActive = () => page.evaluate(() => document.getElementById('photoModal').classList.contains('active'));

      ok('opens on the first photo', (await counter()) === '1 / 5', await counter());

      await swipeTouch(page, '#photoCanvas', 300, 400, 60, 410); // dx=-240 dy=10 — a clean swipe left
      await page.waitForTimeout(50);
      ok('swipe left → next photo', (await counter()) === '2 / 5', await counter());

      await swipeTouch(page, '#photoCanvas', 60, 400, 300, 410); // swipe right
      await page.waitForTimeout(50);
      ok('swipe right → previous photo', (await counter()) === '1 / 5', await counter());

      await swipeTouch(page, '#photoCanvas', 150, 400, 210, 470); // dx=60 dy=70 — vertical-dominant
      await page.waitForTimeout(50);
      ok('a mostly-vertical move past the 50px horizontal threshold does not navigate',
        (await counter()) === '1 / 5', await counter());
      ok('and does not close either (below the 80px close threshold)', await isActive());

      await swipeTouch(page, '#photoCanvas', 150, 300, 160, 460); // dx=10 dy=160 — down, well past 80px
      await page.waitForTimeout(50);
      ok('swipe down past threshold closes the preview', !(await isActive()));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'MIA-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Nia', ownerKey: 'NIA-KEY', photos: PHOTOS(5) });
  await suite('mobile preview — pinch zooms in; once zoomed, a one-finger drag pans instead of navigating',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const zoomPct = () => page.evaluate(() => parseInt(document.getElementById('zoomLevel').textContent, 10));

      ok('starts at 100%', (await zoomPct()) === 100, String(await zoomPct()));

      await pinchTouch(page, '#photoCanvas', 195, 400, 60, 300);
      await page.waitForTimeout(50);
      ok('pinching outward zooms in', (await zoomPct()) > 100, String(await zoomPct()));

      const panBefore = await page.evaluate(() => annotationManager.panX);
      await swipeTouch(page, '#photoCanvas', 300, 400, 100, 410); // would navigate at 100% zoom
      await page.waitForTimeout(50);
      ok('stays on the same photo — the one-finger drag panned instead of navigating',
        (await page.textContent('#photoCounter')) === '1 / 5', await page.textContent('#photoCounter'));
      const panAfter = await page.evaluate(() => annotationManager.panX);
      ok('and the pan actually moved the image', panAfter !== panBefore, `${panBefore} -> ${panAfter}`);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'NIA-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Owen', ownerKey: 'OWEN-KEY', photos: PHOTOS(3) });
  await suite('mobile preview — double-tap toggles ♥ for the owner while editable, pulses on, and never navigates',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });

      const state = () => page.evaluate(() => ({
        heartOn: document.querySelector('#modalPhotoRating .pick-heart-btn')?.classList.contains('on') ?? null,
        pulsing: document.querySelector('#modalPhotoRating .pick-heart-btn')?.classList.contains('pick-heart-pulse') ?? false,
        cardPicked: document.querySelector('.photo-card')?.classList.contains('pick-picked') ?? false,
        counter: document.getElementById('photoCounter').textContent,
        rating: app.filteredPhotos[0].rating,
      }));

      let s = await state();
      ok('starts unpicked', s.heartOn === false && s.rating === 0, JSON.stringify(s));

      await doubleTapTouch(page, '#photoCanvas', 195, 400);
      s = await state();
      ok('double-tap turns it on (same code path as the ♥ button)', s.heartOn === true && s.rating === 1, JSON.stringify(s));
      ok('a brief pulse plays on toggle-on', s.pulsing === true, JSON.stringify(s));
      ok('the grid card gets the thick-border highlight too', s.cardPicked === true, JSON.stringify(s));
      ok('the two taps of a double-tap never navigate', s.counter === '1 / 3', s.counter);

      await doubleTapTouch(page, '#photoCanvas', 195, 400);
      s = await state();
      ok('a second double-tap toggles it back off', s.heartOn === false && s.rating === 0, JSON.stringify(s));
      ok('and the highlight goes with it', s.cardPicked === false, JSON.stringify(s));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'OWEN-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Pat', ownerKey: 'PAT-KEY', photos: PHOTOS(3) });
  await suite('mobile preview — a viewer double-tapping the preview changes nothing',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 }); // seat already taken → straight to the grid
      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      ok('a viewer gets no clickable heart in the modal at all',
        await page.evaluate(() => document.querySelectorAll('#modalPhotoRating .pick-heart-btn').length === 0));
      await doubleTapTouch(page, '#photoCanvas', 195, 400);
      const rating = await page.evaluate(() => app.filteredPhotos[0].rating);
      ok('and double-tapping the image changes the rating not at all', rating === 0, String(rating));
      return out;
    },
    { before: m.attach, contextOptions: MOBILE }); // no picker key stored → a plain viewer
}

{
  const m = pickFakeWorker({ ownerName: 'Ray', ownerKey: 'RAY-KEY', photos: PHOTOS(3) });
  m.state.project.phase = 'retouching';
  await suite('mobile preview — double-tap does nothing once retouching has started, even for the seat holder',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      await doubleTapTouch(page, '#photoCanvas', 195, 400);
      const rating = await page.evaluate(() => app.filteredPhotos[0].rating);
      ok('the seat holder double-tapping while retouching changes nothing', rating === 0, String(rating));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'RAY-KEY'), contextOptions: MOBILE });
}

await suite('mobile preview — outside pick mode, double-tap changes nothing (there is no ♥ to toggle)',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!window.app, null, { timeout: 5000 });
    await page.evaluate(() => {
      app.filteredPhotos = Array.from({ length: 3 }, (_, i) => ({ id: `20260819/p${i}.jpg`, name: `p${i}.jpg`, rating: 0 }));
      app.openModal(0);
    });
    await page.waitForSelector('#photoModal.active', { timeout: 5000 });
    await doubleTapTouch(page, '#photoCanvas', 195, 400);
    const r = await page.evaluate(() => ({
      hearts: document.querySelectorAll('.pick-heart-btn').length,
      counter: document.getElementById('photoCounter').textContent,
      rating: app.filteredPhotos[0].rating,
    }));
    ok('no heart control exists outside pick mode', r.hearts === 0, String(r.hearts));
    ok('rating is untouched', r.rating === 0, String(r.rating));
    ok('and the two taps did not navigate either', r.counter === '1 / 3', r.counter);
    return out;
  },
  { initScript: () => sessionStorage.setItem('studio_token', 'x'), before: mockWorker(3), contextOptions: MOBILE });

{
  const m = pickFakeWorker({ ownerName: 'Uma', ownerKey: 'UMA-KEY', photos: PHOTOS(5) });
  await suite('mobile preview — preloads i±1/i±2 at the responsive width, and never past either end of the list',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      const reset = async () => { m.requests.length = 0; await page.evaluate(() => app._preloadedUrls.clear()); };
      const distinctPaths = () => [...new Set(m.requests
        .filter(r => r.method === 'GET' && /^\/20260819\/p\d\.jpg$/.test(r.path))
        .map(r => r.path))].sort();
      const widthOf = path => {
        const r = m.requests.find(r => r.path === path);
        const match = /[?&]w=(\d+)/.exec((r && r.search) || '');
        return match ? match[1] : null;
      };

      await reset();
      await page.evaluate(() => app.openModal(2)); // middle: all four neighbours exist
      await page.waitForTimeout(150);
      ok('preloads both photos before and both after the current one',
        JSON.stringify(distinctPaths()) ===
          JSON.stringify(['/20260819/p0.jpg', '/20260819/p1.jpg', '/20260819/p2.jpg', '/20260819/p3.jpg', '/20260819/p4.jpg']),
        distinctPaths().join(','));
      ok('at the responsive width bucket (1200 on a 390px/DPR3 phone)',
        widthOf('/20260819/p1.jpg') === '1200', String(widthOf('/20260819/p1.jpg')));

      await reset();
      await page.evaluate(() => app.openModal(0)); // first photo: no i-1/i-2 to ask for
      await page.waitForTimeout(150);
      ok('at the first photo, nothing before it is requested',
        JSON.stringify(distinctPaths()) === JSON.stringify(['/20260819/p0.jpg', '/20260819/p1.jpg', '/20260819/p2.jpg']),
        distinctPaths().join(','));

      await reset();
      await page.evaluate(() => app.openModal(4)); // last photo: no i+1/i+2 to ask for
      await page.waitForTimeout(150);
      ok('at the last photo, nothing past it is requested',
        JSON.stringify(distinctPaths()) === JSON.stringify(['/20260819/p2.jpg', '/20260819/p3.jpg', '/20260819/p4.jpg']),
        distinctPaths().join(','));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'UMA-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Vic', ownerKey: 'VIC-KEY', photos: PHOTOS(10) });
  await suite('mobile preview — a fast burst of navigation only preloads around where it settles',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      m.requests.length = 0;
      // fire three preload requests back-to-back, faster than the debounce
      // settles — only the last one should ever reach the network
      await page.evaluate(() => { app.schedulePreload(1); app.schedulePreload(4); app.schedulePreload(8); });
      await page.waitForTimeout(150);
      const got = [...new Set(m.requests
        .filter(r => r.method === 'GET' && /^\/20260819\/p\d\.jpg$/.test(r.path))
        .map(r => r.path))];
      ok('only the final index (8)\'s neighbours are fetched',
        got.length === 3 && ['/20260819/p6.jpg', '/20260819/p7.jpg', '/20260819/p9.jpg'].every(p => got.includes(p)),
        got.join(','));
      ok('the superseded, stale indices (1 and 4) preloaded nothing',
        !got.some(p => ['/20260819/p0.jpg', '/20260819/p2.jpg', '/20260819/p3.jpg', '/20260819/p5.jpg'].includes(p)),
        got.join(','));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'VIC-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Will', ownerKey: 'WILL-KEY', photos: PHOTOS(2) });
  await suite('responsive preview width — 1200 on a 390px/DPR3 phone; grid thumbnails always stay 400',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const width = await page.evaluate(() => driveManager.previewWidth());
      ok('a 390px/DPR3 phone asks for the 1200 bucket', width === 1200, String(width));
      const thumb = await page.evaluate(() => document.querySelector('.photo-card img').getAttribute('src'));
      ok('grid thumbnails still ask for 400 regardless', /[?&]w=400(&|$)/.test(thumb), thumb);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'WILL-KEY'), contextOptions: MOBILE });
}

await suite('responsive preview width — a desktop viewport keeps the 1600 bucket',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!window.driveManager, null, { timeout: 5000 });
    const width = await page.evaluate(() => driveManager.previewWidth());
    ok('desktop (1500px, DPR1) keeps the largest bucket', width === 1600, String(width));
    return out;
  });

{
  const m = pickFakeWorker({ ownerName: 'Xin', ownerKey: 'XIN-KEY', photos: PHOTOS(2) });
  await suite('selected highlight (pick mode) — thick coloured border + solid ♥ badge, never a dimming overlay',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      const cardStyle = () => page.evaluate(() => {
        const card = document.querySelector('.photo-card');
        const cs = getComputedStyle(card);
        return { picked: card.classList.contains('pick-picked'), borderWidth: cs.borderWidth, borderColor: cs.borderColor };
      });
      let s = await cardStyle();
      ok('an unselected card is not marked picked', s.picked === false, JSON.stringify(s));

      await page.locator('.photo-card').first().locator('.pick-heart-btn').click();
      s = await cardStyle();
      ok('a selected card gets the pick-picked class', s.picked === true, JSON.stringify(s));
      ok('with a clearly thick border', parseFloat(s.borderWidth) >= 3, s.borderWidth);

      // A fresh render (e.g. switching the filter and back) rebuilds the card
      // from scratch via createPhotoCard — the highlight has to come from
      // the photo's own rating there too, not only from the live toggle's
      // direct classList write above.
      await page.evaluate(() => app.renderPhotoGrid());
      s = await cardStyle();
      ok('a freshly re-rendered card is picked-highlighted too, from the start',
        s.picked === true, JSON.stringify(s));

      const overlayCheck = await page.evaluate(() => {
        const container = document.querySelector('.photo-image-container');
        const overlay = container.querySelector('.photo-overlay');
        const img = container.querySelector('.photo-image');
        return {
          overlayIsTransparent: !overlay || getComputedStyle(overlay).backgroundColor === 'rgba(0, 0, 0, 0)',
          imgFilter: getComputedStyle(img).filter,
          imgOpacity: getComputedStyle(img).opacity,
        };
      });
      ok('no semi-transparent overlay dims the photo', overlayCheck.overlayIsTransparent, JSON.stringify(overlayCheck));
      ok('the image itself carries no dimming filter', overlayCheck.imgFilter === 'none', overlayCheck.imgFilter);
      ok('nor any reduced opacity', overlayCheck.imgOpacity === '1', overlayCheck.imgOpacity);

      // same treatment in the preview
      await page.locator('.photo-card').first().click({ position: { x: 5, y: 5 } }); // avoid the ♥ itself
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const modalStyle = await page.evaluate(() => {
        const c = document.querySelector('.canvas-container');
        const cs = getComputedStyle(c);
        return { picked: c.classList.contains('pick-picked'), borderWidth: cs.borderWidth };
      });
      ok('the preview frame is highlighted the same way', modalStyle.picked === true, JSON.stringify(modalStyle));
      ok('with a thick border there too', parseFloat(modalStyle.borderWidth) >= 3, modalStyle.borderWidth);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'XIN-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', photos: PHOTOS(2) });
  await suite('tap targets on a mobile viewport — ♥, the filter buttons, and 完成挑圖/確認送出 are all >= 44x44 CSS px',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      const box = sel => page.evaluate(s => {
        const el = document.querySelector(s);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height };
      }, sel);

      let b = await box('.pick-heart-btn');
      ok('the ♥ toggle is >= 44x44', !!b && b.w >= 44 && b.h >= 44, JSON.stringify(b));

      b = await box('[data-pick-filter="selected"]');
      ok('a filter button is >= 44 tall', !!b && b.h >= 44, JSON.stringify(b));

      b = await box('#submitJobBtn');
      ok('完成挑圖 is >= 44 tall', !!b && b.h >= 44, JSON.stringify(b));

      await page.click('#submitJobBtn');
      await page.waitForSelector('#pickSubmitModal.active', { timeout: 5000 });
      b = await box('#pickSubmitConfirmBtn');
      ok('確認送出 is >= 44 tall', !!b && b.h >= 44, JSON.stringify(b));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: MOBILE });
}

await suite('desktop preview — arrow keys and mouse click still navigate/open exactly as before',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!window.app, null, { timeout: 5000 });
    await page.evaluate(() => {
      app.filteredPhotos = Array.from({ length: 3 }, (_, i) => ({ id: `20260819/p${i}.jpg`, name: `p${i}.jpg`, rating: 0 }));
      app.renderPhotoGrid();
    });
    await page.click('.photo-card:nth-child(2)');
    await page.waitForSelector('#photoModal.active', { timeout: 5000 });
    ok('mouse click opens the modal on the clicked photo',
      (await page.textContent('#photoCounter')) === '2 / 3', await page.textContent('#photoCounter'));

    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(50);
    ok('ArrowRight still navigates to the next photo',
      (await page.textContent('#photoCounter')) === '3 / 3', await page.textContent('#photoCounter'));

    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(50);
    ok('ArrowLeft still navigates back',
      (await page.textContent('#photoCounter')) === '2 / 3', await page.textContent('#photoCounter'));

    await page.keyboard.press('Escape');
    await page.waitForTimeout(50);
    ok('Escape still closes it', !(await page.evaluate(() =>
      document.getElementById('photoModal').classList.contains('active'))));
    return out;
  },
  { initScript: () => sessionStorage.setItem('studio_token', 'x'), before: mockWorker(3) });

{
  const m = pickFakeWorker({ ownerName: 'Amy', ownerKey: 'AMY-KEY' });
  await suite('admin — 封存: confirm text, then 已封存 badge, 取消封存, and 產生新連結 hidden',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-archive-btn', { timeout: 5000 });

      let dialogMsg = '';
      page.once('dialog', d => { dialogMsg = d.message(); d.dismiss(); });
      await page.click('#pd-archive-btn');
      await page.waitForTimeout(200);
      ok('confirm warns links go dead immediately, data is kept',
        dialogMsg.includes('封存後連結會立即失效，資料會保留'), dialogMsg);
      ok('dismissing the confirm does not call archive',
        !m.requests.some(r => r.method === 'POST' && r.path.endsWith('/archive')));

      page.once('dialog', d => d.accept());
      await page.click('#pd-archive-btn');
      await page.waitForSelector('#pd-unarchive-btn', { timeout: 5000 });
      const after = await page.evaluate(() => ({
        badge: document.querySelector('.pd-head')?.textContent.includes('已封存'),
        newLinkBtn: !!document.getElementById('pd-new-link-btn'),
        unarchiveBtn: !!document.getElementById('pd-unarchive-btn'),
      }));
      ok('shows 已封存 badge after archiving', after.badge);
      ok('產生新連結 is hidden once archived', after.newLinkBtn === false);
      ok('取消封存 replaces the 封存 button', after.unarchiveBtn);
      ok('the archive endpoint was actually called',
        m.requests.some(r => r.method === 'POST' && r.path.endsWith('/archive')));
      ok('the live pick link is revoked in the same batch as the archive',
        (await page.textContent('[data-token-row] .badge')) === '已撤銷',
        await page.textContent('[data-token-row] .badge'));

      await page.click('#pd-unarchive-btn');
      await page.waitForSelector('#pd-archive-btn', { timeout: 5000 });
      const restored = await page.evaluate(() => ({
        badge: document.querySelector('.pd-head')?.textContent.includes('已封存'),
        newLinkBtn: !!document.getElementById('pd-new-link-btn'),
      }));
      ok('取消封存 drops the 已封存 badge', restored.badge === false);
      ok('產生新連結 comes back', restored.newLinkBtn);
      ok('the unarchive endpoint was actually called',
        m.requests.some(r => r.method === 'POST' && r.path.endsWith('/unarchive')));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Ben', ownerKey: 'BEN-KEY' });
  await suite('admin — 封存 on an archived project: POST links 409s, and archived shows in the toggled list',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-archive-btn', { timeout: 5000 });
      page.once('dialog', d => d.accept());
      await page.click('#pd-archive-btn');
      await page.waitForSelector('#pd-unarchive-btn', { timeout: 5000 });

      const listEmpty = await page.evaluate(() =>
        document.getElementById('proj-recent-list').textContent.includes('尚未建立過專案'));
      ok('the default project list no longer shows the archived project', listEmpty);

      await page.click('#proj-show-archived-toggle');
      await page.waitForFunction(() =>
        document.querySelectorAll('[data-project-row]').length === 1, null, { timeout: 5000 });
      const shown = await page.evaluate(() => ({
        badge: document.querySelector('[data-project-row]')?.textContent.includes('已封存'),
      }));
      ok('顯示已封存 toggle brings the archived project back with its badge', shown.badge);

      await page.uncheck('#proj-show-archived-toggle');
      await page.waitForFunction(() =>
        document.getElementById('proj-recent-list').textContent.includes('尚未建立過專案'), null, { timeout: 5000 });
      ok('unchecking it hides the archived project again', true);

      // The button is hidden once archived, but the endpoint itself must
      // still refuse a mint the way the real Worker does (docs/guest-picking.md).
      const linkAttempt = await page.evaluate(async id => {
        const r = await fetch(`https://imagepicker.hotichen.workers.dev/api/admin/projects/${id}/links`, {
          method: 'POST', headers: { 'Authorization': 'Bearer adm' },
        });
        return { status: r.status, body: await r.json() };
      }, m.state.project.id);
      ok('POST .../links on an archived project is refused with 409 code:archived',
        linkAttempt.status === 409 && linkAttempt.body.code === 'archived', JSON.stringify(linkAttempt));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Cara', ownerKey: 'CARA-KEY' });
  await suite('admin — 封存／刪除: 刪除 only offered with 0 submissions, confirms, and clears the panel',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-reset-seat-btn', { timeout: 5000 });
      ok('刪除 is offered when the project has 0 submissions', !!(await page.$('#pd-delete-btn')));

      let dialogMsg = '';
      page.once('dialog', d => { dialogMsg = d.message(); d.dismiss(); });
      await page.click('#pd-delete-btn');
      await page.waitForTimeout(200);
      ok('confirm says it cannot be undone', dialogMsg.includes('確定刪除？此動作無法復原'), dialogMsg);
      ok('dismissing the confirm does not call DELETE',
        !m.requests.some(r => r.method === 'DELETE'));

      page.once('dialog', d => d.accept());
      await page.click('#pd-delete-btn');
      await page.waitForSelector('#project-detail-panel', { state: 'hidden', timeout: 5000 });
      ok('the panel is hidden after a successful delete', true);
      ok('the DELETE endpoint was actually called',
        m.requests.some(r => r.method === 'DELETE' && /\/api\/admin\/projects\/[^/]+$/.test(r.path)));
      await page.waitForFunction(() =>
        document.getElementById('proj-recent-list').textContent.includes('尚未建立過專案'), null, { timeout: 5000 });
      ok('the project list refreshes to empty', true);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Dan', ownerKey: 'DAN-KEY' });
  m.state.submissions.push(
    { id: 's1', picker_id: 'picker-0', relationship: '本人', email: null,
      photo_keys: ['20260819/p0.jpg'], count: 1, pick_limit: null, extra_price: null,
      created_at: '2026-01-01T00:00:00Z', notified: 1 },
  );
  await suite('admin — 封存／刪除: 刪除 is hidden with submissions, and 409 has_submissions shows the fallback message',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-submissions .pd-submission', { timeout: 5000 });
      ok('刪除 is not offered once the project has a submission', !(await page.$('#pd-delete-btn')));
      return out;
    },
    { before: m.attach, initScript: ADMIN });

  // Exercise the 409 fallback message directly against the real endpoint
  // shape (a submission landing between the button render and the click).
  const m2 = pickFakeWorker({ ownerName: 'Eli', ownerKey: 'ELI-KEY' });
  await suite('admin — 刪除 409 has_submissions shows 請改用封存',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-delete-btn', { timeout: 5000 });
      // race a submission in right before the delete lands, like the real
      // Worker's own gate re-check
      m2.state.submissions.push({
        id: 's1', picker_id: 'picker-0', relationship: '本人', email: null,
        photo_keys: ['20260819/p0.jpg'], count: 1, pick_limit: null, extra_price: null,
        created_at: '2026-01-01T00:00:00Z', notified: 1,
      });
      page.once('dialog', d => d.accept());
      await page.click('#pd-delete-btn');
      await page.waitForSelector('#pd-action-err:not(:empty)', { timeout: 5000 });
      const errText = await page.textContent('#pd-action-err');
      ok('shows the 已有送出紀錄，無法刪除，請改用封存 fallback', errText.includes('已有送出紀錄，無法刪除，請改用封存'), errText);
      ok('the panel stays open (delete did not go through)',
        await page.evaluate(() => getComputedStyle(document.getElementById('project-detail-panel')).display !== 'none'));
      return out;
    },
    { before: m2.attach, initScript: ADMIN });
}

// ═══════════════════════════════════════════════════════════════════════════
// Admin → photos — admin.html's project detail links to index.html?project=,
// index.html shows just that project's picks, and same-tab Back returns to
// the same detail (task: 專案選片).
// ═══════════════════════════════════════════════════════════════════════════

{
  const m = pickFakeWorker({ ownerName: 'Grace' });
  m.state.selections.set('20260819/a.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  m.state.selections.set('20260901/b.jpg', { rating: 3, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  m.state.selections.set('20260819/zero.jpg', { rating: 0, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('admin — 專案選片：「目前選取」標題與每張照片都連到 index.html?project=（同分頁的純 <a>）',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#project-detail-body table tbody tr');

      const r = await page.evaluate(() => {
        const headingLink = document.querySelector('#project-detail-body h4 a');
        const rowLinks = [...document.querySelectorAll('#project-detail-body table tbody tr a')];
        return {
          headingHref: headingLink && headingLink.getAttribute('href'),
          headingTarget: headingLink && headingLink.getAttribute('target'),
          headingText: headingLink && headingLink.textContent,
          rowHrefs: rowLinks.map(a => a.getAttribute('href')),
          rowCount: rowLinks.length,
        };
      });
      ok('the heading links to index.html?project=<id>', r.headingHref === 'index.html?project=proj-1', r.headingHref);
      ok('the heading still shows the count', /目前選取（2 張）/.test(r.headingText || ''), r.headingText);
      ok('it is a plain same-tab link (no target=_blank)', !r.headingTarget, String(r.headingTarget));
      ok('exactly the 2 rating>0 rows are links (not the zero-rated one)', r.rowCount === 2, String(r.rowCount));
      ok('one row links to its own photo key, encoded',
        r.rowHrefs.includes('index.html?project=proj-1&photo=20260819%2Fa.jpg'), JSON.stringify(r.rowHrefs));
      ok('the other, in a different folder, does too',
        r.rowHrefs.includes('index.html?project=proj-1&photo=20260901%2Fb.jpg'), JSON.stringify(r.rowHrefs));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Henry', projectId: 'proj-42' });
  await suite('admin — 專案選片：開啟詳細頁會把 id 寫進網址的 #project=',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#project-detail-panel', { state: 'visible' });
      const hash = await page.evaluate(() => location.hash);
      ok('opening the detail sets #project=<id>', hash === '#project=proj-42', hash);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Henry', projectId: 'proj-42' });
  await suite('admin — 專案選片：admin.html#project=<id> 開啟時自動重開該專案（模擬從 index.html 上一頁回來）',
    `${base}/admin.html#project=proj-42`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#project-detail-panel', { state: 'visible', timeout: 5000 });
      const text = await page.evaluate(() => document.getElementById('project-detail-body').textContent);
      ok('the right project’s detail opened without clicking anything', text.includes('Henry'), text);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Ivy', projectId: 'proj-7' });
  m.state.selections.set('20260819/a.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  m.state.selections.set('20260901/b.jpg', { rating: 3, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  m.state.selections.set('20260819/zero.jpg', { rating: 0, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('index.html — 專案選片模式（?project=）：只顯示已選相片，橫跨資料夾，並顯示 banner',
    `${base}/index.html?project=proj-7`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const r = await page.evaluate(() => ({
        cardCount: document.querySelectorAll('.photo-card').length,
        ids: [...document.querySelectorAll('.photo-card')].map(c => c.dataset.photoId),
        bannerHidden: document.getElementById('projectViewBanner').hidden,
        bannerText: document.getElementById('pvBannerText').textContent,
        backHref: document.getElementById('pvBackLink').getAttribute('href'),
      }));
      ok('only the 2 rating>0 selections are shown, not the zero-rated one', r.cardCount === 2, String(r.cardCount));
      ok('one is from each folder', r.ids.includes('20260819/a.jpg') && r.ids.includes('20260901/b.jpg'), JSON.stringify(r.ids));
      ok('the banner is shown', r.bannerHidden === false);
      ok('names the owner and the count', r.bannerText.includes('Ivy') && r.bannerText.includes('2'), r.bannerText);
      ok('links back to the same project on admin.html', r.backHref === 'admin.html#project=proj-7', r.backHref);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Jack', projectId: 'proj-8' });
  m.state.selections.set('20260819/pick-me.jpg', { rating: 4, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('index.html — 專案選片模式：?photo= 直接開啟該張的預覽',
    `${base}/index.html?project=proj-8&photo=${encodeURIComponent('20260819/pick-me.jpg')}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.waitForFunction(
        () => document.getElementById('photoModal').classList.contains('active'),
        null, { timeout: 5000 });
      const name = await page.evaluate(() => document.getElementById('modalPhotoName').textContent);
      ok('the preview modal opens directly on that photo', name === 'pick-me.jpg', name);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

await suite('index.html — 專案選片：沒有 ?project= 時，攝影師模式完全不受影響',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!window.app, null, { timeout: 5000 });
    const active = await page.evaluate(() => !!(window.ProjectViewController && ProjectViewController.active));
    ok('ProjectViewController is not active', active === false);
    const bannerHidden = await page.evaluate(() => document.getElementById('projectViewBanner').hidden);
    ok('its banner stays hidden', bannerHidden === true);

    await page.fill('#driveUrl', '20260819/');
    await page.click('#loadPhotosBtn');
    await page.waitForSelector('.photo-card', { timeout: 5000 });
    const cards = await page.evaluate(() => document.querySelectorAll('.photo-card').length);
    ok('the ordinary path box + LOAD flow is untouched', cards === 3, String(cards));
    return out;
  },
  { initScript: ADMIN, before: pickFakeWorker().attach });

{
  const XSS_OWNER = '"><img src=x onerror="window.__xssPV=1">';
  const m = pickFakeWorker({ ownerName: XSS_OWNER, projectId: 'proj-9' });
  m.state.selections.set('20260819/p0.jpg', { rating: 1, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('index.html — 專案選片模式：banner 裡的認領人姓名沒有變成元素',
    `${base}/index.html?project=proj-9`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const r = await page.evaluate(() => ({
        fired: !!window.__xssPV,
        injected: document.querySelectorAll('img[src="x"]').length,
        shown: document.getElementById('pvBannerText').textContent,
      }));
      ok('沒有變成元素', r.injected === 0, `注入了 ${r.injected} 個 img`);
      ok('onerror 沒有執行', r.fired === false);
      ok('姓名仍照原樣顯示在文字裡', r.shown.includes(XSS_OWNER), r.shown);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Kelly' });
  m.state.project.phase = 'submitted';
  await suite('admin — 專案選片：開始精修後，列表徽章也一起更新（不是只有詳細頁）',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-start-retouch-btn', { timeout: 5000 });
      await page.click('#pd-start-retouch-btn');
      await page.waitForFunction(
        () => document.querySelector('.pd-head .badge')?.textContent === '精修中',
        null, { timeout: 5000 });
      const listText = await page.evaluate(() => document.querySelector('[data-project-row]').textContent);
      ok('the list row picks up 精修中 too, not just the detail panel', listText.includes('精修中'), listText);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Leo' });
  m.state.submissions.push({
    id: 's1', picker_id: 'picker-0', relationship: '本人', email: null,
    photo_keys: ['20260819/p0.jpg'], count: 1, pick_limit: null, extra_price: null,
    created_at: '2026-09-27T14:52:00.000Z',
  });
  m.state.selections.set('20260819/p0.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-09-27T14:52:00.000Z' });
  await suite('admin — 專案選片：時間顯示轉為 Asia/Taipei（9/27 22:52，不是原始 ISO）',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-submissions .pd-submission');
      const r = await page.evaluate(() => ({
        submission: document.querySelector('.pd-submission').textContent,
        selectionRow: document.querySelector('#project-detail-body table tbody tr').textContent,
      }));
      ok('the submission time is shown in Taipei time, not raw ISO',
        r.submission.includes('9/27 22:52') && !r.submission.includes('2026-09-27T'), r.submission);
      ok('the selection’s updated time is too', r.selectionRow.includes('9/27 22:52'), r.selectionRow);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Mona' });
  m.state.selections.set('20260819/p0.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('admin — 專案選片：選取表格的「星等」欄改成 ♥',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#project-detail-body table tbody tr');
      const r = await page.evaluate(() => ({
        headers: [...document.querySelectorAll('#project-detail-body table thead th')].map(th => th.textContent),
        cell: document.querySelectorAll('#project-detail-body table tbody tr td')[1]?.textContent,
      }));
      ok('the header is ♥, not 星等', r.headers.includes('♥') && !r.headers.includes('星等'), JSON.stringify(r.headers));
      ok('the cell shows ♥', r.cell === '♥', r.cell);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

await suite('版本號 — admin shows the asset version it loaded',
  `${base}/admin.html`,
  async page => {
    await page.waitForFunction(() => (document.getElementById('buildVersion') || {}).textContent, null, { timeout: 5000 }).catch(() => {});
    const text = await page.evaluate(() => { const el = document.getElementById('buildVersion'); return el ? el.textContent : null; });
    const inHeader = await page.evaluate(() => !!document.querySelector('header #buildVersion'));
    return [
      `${/^v\d{8}[a-z]?$/.test(text || '') ? 'ok  ' : 'FAIL'}  the header names the version   [${text}]`,
      `${inHeader ? 'ok  ' : 'FAIL'}  and it sits in the header`,
    ];
  });

await browser.close();
server.close();
// A filter that matches nothing must not read as a pass.
if (!ran) { failed++; console.log(`\nFAIL  ONLY=${JSON.stringify(ONLY)} matched no suite`); }
if (ONLY) console.log(`\n(ONLY=${JSON.stringify(ONLY)}: ${ran} suites ran, the rest were skipped)`);
console.log(failed ? `\n${failed} failing` : '\nall passed');
process.exit(failed ? 1 : 0);
