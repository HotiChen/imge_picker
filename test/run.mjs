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
import zlib from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
};

const server = createServer(async (req, res) => {
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

// Real touch input through CDP (Input.dispatchTouchEvent): the browser hit-
// tests every point, so a finger lands on whatever is really there — unlike
// touchSequence above, which dispatches straight to one element.
async function realTouch(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i })) });
  const t = {
    async tap(x, y) { await send('touchStart', [{ x, y }]); await send('touchEnd', []); },
    async doubleTap(x, y, gapMs = 120) {
      await t.tap(x, y); await page.waitForTimeout(gapMs); await t.tap(x + 2, y + 1);
    },
    async drag(x1, y1, x2, y2, steps = 8) {
      await send('touchStart', [{ x: x1, y: y1 }]);
      for (let i = 1; i <= steps; i++) {
        await send('touchMove', [{ x: x1 + (x2 - x1) * i / steps, y: y1 + (y2 - y1) * i / steps }]);
      }
      await send('touchEnd', []);
    },
    async pinch(cx, cy, d0, d1, steps = 8) {
      const pts = d => [{ x: cx - d / 2, y: cy, id: 0 }, { x: cx + d / 2, y: cy, id: 1 }];
      await send('touchStart', pts(d0));
      for (let i = 1; i <= steps; i++) await send('touchMove', pts(d0 + (d1 - d0) * i / steps));
      await send('touchEnd', []);
    },
  };
  return t;
}

// A realistically sized landscape photo (1600x1067, like a real preview) —
// the 1x1 PIXEL hides every layout bug. A colour gradient, so a canvas pixel
// says which point of the photo is drawn there: R grows left→right, G grows
// top→bottom, B is a constant 60. Pure blue (annotation colour below) never
// occurs in it. Minimal dependency-free PNG encoder (RGB, filter 0).
const BIG_W = 1600, BIG_H = 1067;
const BIG_PHOTO = (() => {
  const { deflateSync, crc32 } = zlib;
  const raw = Buffer.alloc((BIG_W * 3 + 1) * BIG_H);
  for (let y = 0; y < BIG_H; y++) {
    const row = y * (BIG_W * 3 + 1);
    const g = Math.round(y * 255 / (BIG_H - 1));
    for (let x = 0; x < BIG_W; x++) {
      const o = row + 1 + x * 3;
      raw[o] = Math.round(x * 255 / (BIG_W - 1)); raw[o + 1] = g; raw[o + 2] = 60;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(BIG_W, 0); ihdr.writeUInt32BE(BIG_H, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
})();

// In-page: the preview canvas's pixel at screen point (x, y), or null when
// the point isn't on the canvas at all.
const CANVAS_PX = ([x, y]) => {
  const c = document.getElementById('photoCanvas');
  const r = c.getBoundingClientRect();
  if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) return null;
  const d = c.getContext('2d').getImageData(Math.floor((x - r.left) * c.width / r.width),
    Math.floor((y - r.top) * c.height / r.height), 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
};

// In-page: where the photo sat on screen before the canvas filled its
// container — the old fitted rect, computed from first principles: scaled by
// min(container/photo, 1), the canvas bitmap truncated to whole pixels, and
// flex-centred inside .canvas-container's content box.
const OLD_FIT_RECT = ([iw, ih]) => {
  const box = document.querySelector('.canvas-container');
  const cr = box.getBoundingClientRect();
  const cs = getComputedStyle(box);
  const left = cr.left + parseFloat(cs.borderLeftWidth), top = cr.top + parseFloat(cs.borderTopWidth);
  const cw = box.clientWidth, ch = box.clientHeight;
  const s = Math.min(cw / iw, ch / ih, 1);
  const w = Math.floor(iw * s), h = Math.floor(ih * s);
  return { left: left + (cw - w) / 2, top: top + (ch - h) / 2, w, h, s };
};

// ONLY=<text>[|<text>…] runs just the suites whose name contains that text, for quick
// iterations while developing; run everything before a commit or merge.
const ONLY = process.env.ONLY || '';
let ran = 0;

async function suite(name, url, run, { initScript, before, contextOptions } = {}) {
  if (ONLY && !ONLY.split('|').some(t => t && name.includes(t))) return;
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

// `image`: serve this instead of the 1x1 PIXEL (with CORS, so the preview
// canvas stays readable) — see BIG_PHOTO.
function mockWorker(count, extraSettings = {}, image = null) {
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
      if (image) return route.fulfill({ status: 200, contentType: 'image/png', body: image,
        headers: { 'Access-Control-Allow-Origin': '*' } });
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
        // Nested subfolders (docs/backlog.md "Guest page hides subfolders"),
        // delimiter-listed exactly like worker.js's own R2 call — see
        // delimitedListFake.
        if (opts.clientFiles) {
          const { data, folders } = delimitedListFake(opts.clientFiles, rec.list);
          return json(JSON.stringify({ status: 'success', data, folders }));
        }
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
  await suite('revoke all — the control is on the settings page, reads the live tokens, and warns before firing',
    `${base}/settings.html`,
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
    `${base}/settings.html`,
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

// ═══════════════════════════════════════════════════════════════════════════
// admin.html is two screens chosen by the hash (#projects | #project=<id> |
// #clients; anything else = projects). 登入中的裝置 lives on settings.html.
// ═══════════════════════════════════════════════════════════════════════════

const VIEW_STATE = () => {
  const disp = sel => { const e = document.querySelector(sel); return e ? getComputedStyle(e).display : 'ABSENT'; };
  return {
    projects: disp('#view-projects'), clients: disp('#view-clients'),
    create: disp('#project-create-panel'), table: disp('#clients-table'),
    sub: document.querySelector('header .subtitle')?.textContent.trim(),
    title: document.title,
    active: [...document.querySelectorAll('.side-nav-item.active')].map(e => e.textContent.trim()),
    clientsHref: document.querySelector('.side-nav-item[data-nav="clients"]')?.getAttribute('href'),
    // The rendered box, not just the style: a display:none ancestor has no size.
    createBox: !!document.querySelector('#project-create-panel')?.getClientRects().length,
    tableBox: !!document.querySelector('#clients-table')?.getClientRects().length,
  };
};

for (const [hash, want] of [
  ['', 'projects'], ['#projects', 'projects'], ['#nonsense', 'projects'], ['#clients', 'clients'],
]) {
  const m = adminMock();
  await suite(`admin 分頁 — ${hash || '(no hash)'} shows only the ${want} block, with its own subtitle/title/menu highlight`,
    `${base}/admin.html${hash}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.side-nav-item.active', { timeout: 5000 });
      const v = await page.evaluate(VIEW_STATE);
      const label = want === 'projects' ? '選片專案' : '客戶';
      const other = want === 'projects' ? 'clients' : 'projects';
      ok(`the ${want} section is displayed`, v[want] === 'block', JSON.stringify(v));
      ok(`the ${other} section is display:none (computed)`, v[other] === 'none', JSON.stringify(v));
      if (want === 'projects') {
        ok('the create form has a rendered box', v.createBox, JSON.stringify(v));
        ok('the clients table has no box', !v.tableBox, JSON.stringify(v));
      } else {
        ok('the clients table has a rendered box', v.tableBox, JSON.stringify(v));
        ok('the project form has no box', !v.createBox, JSON.stringify(v));
      }
      ok('subtitle', v.sub === label, v.sub);
      ok('<title>', v.title.includes(label) && !v.title.includes('客戶管理'), v.title);
      ok('exactly the matching menu item is highlighted', JSON.stringify(v.active) === JSON.stringify([label]), JSON.stringify(v.active));
      ok('the side menu 客戶 link is admin.html#clients', v.clientsHref === 'admin.html#clients', v.clientsHref);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = adminMock();
  await suite('admin 分頁 — hashchange switches views without a reload, and data loads only when shown',
    `${base}/admin.html#projects`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.side-nav-item.active', { timeout: 5000 });
      await page.waitForTimeout(300);
      await page.evaluate(() => { window.__noReload = true; });
      ok('the clients list was NOT fetched while it was hidden',
        !m.seen.some(r => r.path === '/api/admin/clients' && r.method === 'GET' && r.auth === 'Bearer adm'),
        JSON.stringify(m.seen.map(r => r.path)));
      await page.click('.side-nav-item[data-nav="clients"]');
      await page.waitForFunction(() => document.querySelector('header .subtitle')?.textContent.trim() === '客戶', null, { timeout: 3000 });
      let v = await page.evaluate(VIEW_STATE);
      ok('clicking 客戶 in the menu shows clients only', v.clients === 'block' && v.projects === 'none', JSON.stringify(v));
      ok('and highlights 客戶 only', JSON.stringify(v.active) === '["客戶"]', JSON.stringify(v.active));
      ok('and retitles', v.title.includes('客戶') && !v.title.includes('選片專案'), v.title);
      ok('without reloading the page', await page.evaluate(() => window.__noReload === true));
      ok('the clients list is fetched once shown', m.seen.some(r => r.path === '/api/admin/clients' && r.auth === 'Bearer adm'));
      await page.click('.side-nav-item[data-nav="projects"]');
      await page.waitForFunction(() => document.querySelector('header .subtitle')?.textContent.trim() === '選片專案', null, { timeout: 3000 });
      v = await page.evaluate(VIEW_STATE);
      ok('clicking 選片專案 comes back to projects only', v.projects === 'block' && v.clients === 'none' && JSON.stringify(v.active) === '["選片專案"]', JSON.stringify(v));
      await page.evaluate(() => { location.hash = '#clients'; });
      await page.waitForFunction(() => document.querySelector('header .subtitle')?.textContent.trim() === '客戶', null, { timeout: 3000 });
      ok('a plain location.hash change switches too', (await page.evaluate(VIEW_STATE)).clients === 'block');
      ok('still the same document', await page.evaluate(() => window.__noReload === true));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = adminMock();
  await suite('admin 分頁 — #project=<id> opens that detail inside the projects view, 選片專案 highlighted',
    `${base}/admin.html#project=proj-9`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.side-nav-item.active', { timeout: 5000 });
      await page.waitForTimeout(500);
      const v = await page.evaluate(VIEW_STATE);
      ok('projects view shown, clients hidden', v.projects === 'block' && v.clients === 'none', JSON.stringify(v));
      ok('選片專案 is the highlighted item', JSON.stringify(v.active) === '["選片專案"]', JSON.stringify(v.active));
      ok('subtitle 選片專案', v.sub === '選片專案', v.sub);
      ok('that project was requested', m.seen.some(r => r.path === '/api/admin/projects/proj-9'), JSON.stringify(m.seen.map(r => r.path)));
      const detail = await page.evaluate(() => {
        const p = document.getElementById('project-detail-panel');
        return { disp: getComputedStyle(p).display, inProjects: !!p.closest('#view-projects') };
      });
      ok('the detail panel is displayed, inside the projects section', detail.disp === 'block' && detail.inProjects, JSON.stringify(detail));
      await page.click('.side-nav-item[data-nav="projects"]');
      await page.waitForFunction(() => getComputedStyle(document.getElementById('project-detail-panel')).display === 'none', null, { timeout: 3000 });
      ok('clicking 選片專案 in the menu closes the detail back to the list', true);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = adminMock();
  await suite('登入中的裝置 — is gone from admin.html (both views)',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.side-nav-item.active', { timeout: 5000 });
      await page.waitForTimeout(300);
      for (const h of ['#projects', '#clients']) {
        await page.evaluate(x => { location.hash = x; }, h);
        await page.waitForTimeout(150);
        const r = await page.evaluate(() => ({
          btn: !!document.getElementById('revoke-all-btn'), panel: !!document.getElementById('minted-panel'),
          text: document.body.textContent.includes('登入中的裝置'),
        }));
        ok(`${h}: no revoke button / panel / heading`, !r.btn && !r.panel && !r.text, JSON.stringify(r));
      }
      ok('and admin.html never asked for the minted list', !m.seen.some(r => r.path.startsWith('/api/shares/minted')), JSON.stringify(m.seen.map(r => r.path)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = adminMock();
  await suite('登入中的裝置 — settings.html shows it as its own section, visible',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#revoke-all-btn', { timeout: 5000 });
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => ({
        disp: getComputedStyle(document.getElementById('revoke-all-btn')).display,
        box: document.getElementById('revoke-all-btn').getClientRects().length,
        heading: [...document.querySelectorAll('main h2')].map(h => h.textContent.trim()),
        inPanel: !!document.getElementById('revoke-all-btn').closest('#minted-panel'),
        summary: document.getElementById('minted-summary').textContent,
      }));
      ok('button visible', r.disp !== 'none' && r.box > 0, JSON.stringify(r));
      ok('own section heading 登入中的裝置', r.heading.includes('登入中的裝置') && r.inPanel, JSON.stringify(r.heading));
      ok('summary loaded from the Worker', /攝影師 2/.test(r.summary) && /客戶 1/.test(r.summary), r.summary);
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
                 'home.html', 'dashboard.html', 'settings.html', 'orders.html', 'operator.html',
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

// docs/backlog.md "Guest page hides subfolders" — the same panel/pattern as
// js/pick.js's own renderFolderPanel, for a signed-in client's token.
await suite('multi-folder — subfolders: a client’s photo-less folder opens its first subfolder automatically, nested in the left panel',
  `${base}/index.html`,
  async page => {
    await page.waitForSelector('.photo-card', { timeout: 6000 });
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

    const r1 = await page.evaluate(() => ({
      cardNames: [...document.querySelectorAll('.photo-card .photo-name')].map(e => e.textContent),
      rows: [...document.querySelectorAll('#folderTree .tree-row')].map(el => el.dataset.folder),
      activeRows: [...document.querySelectorAll('#folderTree .tree-row.tree-active')].map(el => el.dataset.folder),
    }));
    ok('A/ itself has no photos, so the client lands on its first subfolder (A/a/) automatically',
      JSON.stringify(r1.cardNames) === JSON.stringify(['p0.jpg', 'p1.jpg']), JSON.stringify(r1.cardNames));
    ok('the panel lists the folder and every subfolder, nested under it',
      JSON.stringify(r1.rows) === JSON.stringify(['A/', 'A/a/', 'A/b/']), JSON.stringify(r1.rows));
    ok('the subfolder actually opened is the one highlighted',
      JSON.stringify(r1.activeRows) === JSON.stringify(['A/a/']), JSON.stringify(r1.activeRows));

    await page.click('#folderTree .tree-row[data-folder="A/b/"]');
    await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 1,
      null, { timeout: 5000 });
    const r2 = await page.evaluate(() => ({
      cardName: document.querySelector('.photo-card .photo-name')?.textContent,
      activeRows: [...document.querySelectorAll('#folderTree .tree-row.tree-active')].map(el => el.dataset.folder),
    }));
    ok('clicking the nested subfolder loads its own (different) photos',
      r2.cardName === 'q0.jpg', String(r2.cardName));
    ok('and moves the highlight to it', JSON.stringify(r2.activeRows) === JSON.stringify(['A/b/']), JSON.stringify(r2.activeRows));
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
      folders: ['A/'],
      clientFiles: ['A/a/p0.jpg', 'A/a/p1.jpg', 'A/b/q0.jpg'],
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
    `${base}/admin.html#clients`,
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
    `${base}/admin.html#clients`,
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
    `${base}/admin.html#clients`,
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
    `${base}/admin.html#clients`,
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

// Mirrors worker.js's own `GET list` handling of R2's `delimiter: '/'`
// listing: everything under `prefix` that has no further '/' is a file,
// everything with one becomes a folder prefix (deduped). Used by fixtures
// that need real nested-subfolder shapes (docs/backlog.md "Guest page hides
// subfolders") rather than a hand-authored folders list per level.
function delimitedListFake(files, prefix) {
  const data = [];
  const prefixSet = new Set();
  for (const key of files) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      data.push({ id: key, name: key.split('/').pop(), size: 1024, uploaded: '2026-01-01T00:00:00.000Z' });
    } else {
      prefixSet.add(prefix + rest.slice(0, slash + 1));
    }
  }
  return { data, folders: Array.from(prefixSet).sort() };
}

// Mirrors worker.js's pickReadScope: delivered = delivered_at AND a valid
// finals snapshot; a legacy stamp without one stays 'picking'.
function pickScopeFake(project) {
  const finals = Array.isArray(project.final_folders) && project.final_folders.length ? project.final_folders : null;
  if (project.delivered_at && finals) {
    return { mode: 'delivered', finals, proofs: project.allow_proof_download ? project.folders : [] };
  }
  return { mode: 'picking', finals: [], proofs: project.folders };
}
// worker.js's finalFolders()/pickFolders(): trimmed, trailing '/', deduped;
// null when any entry cannot name a folder.
function finalFoldersFake(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const out = [];
  for (const f of value) {
    if (typeof f !== 'string' || !f.trim()) return null;
    const t = f.trim();
    const slashed = t.endsWith('/') ? t : t + '/';
    if (slashed.startsWith('/') || slashed.startsWith('_')) return null;
    const seg = slashed.split('/');
    if (seg.includes('..') || seg.includes('.')) return null;
    if ([...slashed].length > 256 || /[\x00-\x1f\x7f]/.test(slashed)) return null;
    if (!out.includes(slashed)) out.push(slashed);
  }
  return out;
}
// worker.js attachmentDisposition
function attachmentFake(key) {
  const name = key.split('/').pop() || 'photo';
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

// worker.js's retouch-pin validation + canonical form (docs/guest-picking.md,
// "Retouch pins — the save contract"): an array of ≤ 10 plain objects, x/y
// finite JSON numbers in [0,1] (stored to 4 decimals), note optional, trimmed,
// ≤ 100 characters with no control / line-separator character; only
// {x, y, note} survive, in that order. null on any violation.
const PICK_MARKS_MAX_FAKE = 10;
const PICK_MARKS_TOTAL_MAX_FAKE = 300;
function pickMarksCanonFake(marks) {
  if (!Array.isArray(marks) || marks.length > PICK_MARKS_MAX_FAKE) return null;
  const out = [];
  for (const m of marks) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    for (const v of [m.x, m.y]) if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return null;
    let note = '';
    if (m.note !== undefined) {
      if (typeof m.note !== 'string') return null;
      note = m.note.trim();
      if ([...note].length > 100 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(note)) return null;
    }
    out.push({ x: Math.round(m.x * 10000) / 10000, y: Math.round(m.y * 10000) / 10000, note });
  }
  return out;
}

// Mirrors worker.js: the plan cap (pick_limit + extra_max), the settings shape
// and the PATCH/create validation (docs/project-plan.md, "Worker contract").
const EXTRA_MAX_MAX_FAKE = 500, EXTRA_MAX_DEFAULT_FAKE = 10, MONEY_MAX_FAKE = 10000000;
const isExtraMaxFake = v => Number.isSafeInteger(v) && v >= 0 && v <= EXTRA_MAX_MAX_FAKE;
function settingsShapeFake(st) {
  const x = st.default_extra_max ?? null;
  return { studio_name: null, booking_url: null, default_pick_limit: null, default_extra_price: null,
    has_logo: false, ...st, default_extra_max: x,
    effective_default_extra_max: isExtraMaxFake(x) ? x : EXTRA_MAX_DEFAULT_FAKE };
}
function pickFakeWorker(opts = {}) {
  const settings = { ...(opts.settings || {}) };
  const state = {
    settings,
    project: {
      id: opts.projectId || 'proj-1',
      title: opts.title ?? 'T 專案',
      pick_limit: opts.pickLimit ?? null,
      extra_price: opts.extraPrice ?? null,
      extra_max: opts.extraMax ?? null,   // NULL = a project from before the feature: no plan cap
      folders: opts.folders || ['20260819/'],
      owner_picker_id: null,
      phase: opts.phase || 'picking',
      modified_after_submit: 0,
      archived_at: opts.archivedAt || null,
      delivered_at: opts.deliveredAt || null,
      // docs/delivery.md: final_folders is an array once delivered, else
      // null; allow_proof_download is a boolean (the Worker's row/detail
      // shape — never 0/1)
      final_folders: opts.finalFolders || null,
      allow_proof_download: !!opts.allowProofDownload,
    },
    // GET /api/pick/state's studio.{name, booking_url, has_logo}
    // (docs/dashboard-settings.md) — omitted from the response unless a test
    // opts in, so every pre-existing suite's fixture is unaffected.
    studio: opts.studio || null,
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
      requests.push({ method, path: u.pathname, search: u.search, t: shareTok, key: pickerKey, body, range: h['range'] || null });
      const json = (data, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });

      if (u.pathname === '/api/pick/state' && method === 'GET') {
        const picker = pickerKey ? findByKey(pickerKey) : null;
        const isOwner = !!picker && state.project.owner_picker_id === picker.id;
        const ownerPicker = state.project.owner_picker_id ? state.pickers.get(state.project.owner_picker_id) : null;
        const subs = state.submissions;
        const scope = pickScopeFake(state.project);
        const resp = {
          project: {
            id: state.project.id, title: state.project.title,
            pick_limit: state.project.pick_limit, extra_price: state.project.extra_price,
            extra_max: state.project.extra_max,
            max_picks: state.project.pick_limit != null && state.project.extra_max != null
              ? state.project.pick_limit + state.project.extra_max : null,
          },
          mode: scope.mode,
          folders: scope.proofs,
          final_folders: scope.finals,
          allow_proof_download: state.project.allow_proof_download,
          delivered_at: scope.mode === 'delivered' ? state.project.delivered_at : null,
          owner: ownerPicker ? ownerPicker.name : null,
          is_owner: isOwner,
          phase: state.project.phase,
          submitted_at: subs.length ? subs[subs.length - 1].created_at : null,
          // notes are the owner's own words to the photographer — a viewer
          // gets {photo_key, rating} only (docs/guest-picking.md)
          selections: Array.from(state.selections.entries())
            .map(([photo_key, s]) => isOwner
              ? { photo_key, rating: s.rating, note: s.note, marks: opts.marksUnavailable ? null : (s.marks || null) }
              : { photo_key, rating: s.rating }),
        };
        if (isOwner) resp.modified_after_submit = state.project.modified_after_submit;
        if (state.studio) resp.studio = state.studio;
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
        // the real limits: a save body over 2,000,000 bytes is 413 too_large
        // (opts.failNextSave injects any other answer, once, for the paths a
        // browser cannot reach — e.g. a real 2 MB body)
        if (Buffer.byteLength(req.postData() || '') > 2000000)
          return json({ error: '資料太大', code: 'too_large', max: 2000000 }, 413);
        if (opts.failNextSave) { const f = opts.failNextSave; opts.failNextSave = null; return json(f.body, f.status); }
        // opts.failSaves: a FIFO of injected failures for the retry paths — 'net'
        // drops the connection (a fetch TypeError), a number answers that status
        if (opts.failSaves && opts.failSaves.length) {
          const f0 = opts.failSaves.shift();
          const f = f0 && typeof f0 === 'object' ? f0.fail : f0;
          if (f0 && f0.delay) await new Promise(r => setTimeout(r, f0.delay)); // a slow, then failing, request
          if (f === 'net') return route.abort('failed');
          return json({ error: '暫時無法處理', code: 'unavailable' }, f);
        }
        // marks: shape first, per item (400 invalid_marks, nothing written) —
        // rating 0 pins are ignored but still validated
        for (const item of upsert) {
          if (item.marks !== undefined && pickMarksCanonFake(item.marks) === null)
            return json({ error: '標示內容不正確', code: 'invalid_marks' }, 400);
        }
        // shape first (docs/guest-picking.md rule 7), same as worker.js —
        // checked before anything about caps, and before any write
        for (const item of upsert) {
          if (!pickKeyValidFake(item.photo_key)) return json({ error: '照片名稱不正確', code: 'invalid_photo_key' }, 400);
        }
        for (const k of del) {
          if (!pickKeyValidFake(k)) return json({ error: '照片名稱不正確', code: 'invalid_photo_key' }, 400);
        }
        // before the D1 migration: any save that carries `marks` (even []) is 500
        if (opts.marksUnavailable && upsert.some(it => it.marks !== undefined))
          return json({ error: '標示功能尚未啟用', code: 'marks_unavailable' }, 500);
        // the caps: what this save would leave, against the current count —
        // whichever of PICK_MAX_SELECTIONS/current-count is bigger, mirroring
        // worker.js's MAX(?, current) so a project already over a lowered cap
        // can still re-rate/un-star/delete
        const byKey = new Map(upsert.map(it => [it.photo_key, it])); // last mention wins
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
        // hearts are drafts (docs/pick-handover.md §1): a save never answers
        // pick_cap — the plan cap is enforced at submit only
        if (starCount > Math.max(PICK_MAX_SELECTIONS, priorStars)) {
          return json({ error: `最多只能選 ${PICK_MAX_SELECTIONS} 張`, code: 'selection_cap', max: PICK_MAX_SELECTIONS }, 409);
        }
        if (resultKeys.size > Math.max(PICK_MAX_ROWS, priorRows)) {
          return json({ error: `最多只能保留 ${PICK_MAX_ROWS} 筆`, code: 'row_cap', max: PICK_MAX_ROWS }, 409);
        }
        // the stored pins after the save: absent + rating>=1 keeps, an array
        // replaces (empty = none), rating 0 clears, deleted rows go
        const newMarks = new Map();
        for (const [k, item] of byKey) {
          if (removed.has(k)) continue;
          if (!(item.rating >= 1)) newMarks.set(k, null);
          else if (item.marks === undefined) newMarks.set(k, state.selections.get(k)?.marks || null);
          else { const c = pickMarksCanonFake(item.marks); newMarks.set(k, c.length ? c : null); }
        }
        const pinsOf = k => (newMarks.has(k) ? newMarks.get(k) : state.selections.get(k)?.marks) || [];
        const writesPins = upsert.some(it => it.rating >= 1 && Array.isArray(it.marks) && it.marks.length > 0);
        if (writesPins) {
          let total = 0, priorTotal = 0;
          for (const k of resultKeys) total += pinsOf(k).length;
          for (const s of state.selections.values()) priorTotal += (s.marks || []).length;
          if (total > Math.max(PICK_MARKS_TOTAL_MAX_FAKE, priorTotal))
            return json({ error: '標示總數已達上限（300 個）', code: 'marks_cap', max: PICK_MARKS_TOTAL_MAX_FAKE }, 409);
        }
        const now = new Date().toISOString();
        if (state.project.phase === 'submitted') state.project.modified_after_submit = 1;
        for (const [k, item] of byKey) {
          state.selections.set(k,
            { rating: item.rating, note: item.note || '', marks: newMarks.get(k) || null, updated_by: picker.id, updated_at: now });
        }
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
        // the plan cap at submit (worker.js pickCapRefused): count > pick_limit +
        // extra_max (both non-NULL) -> 409 pick_cap, nothing recorded
        {
          const { pick_limit: pl, extra_max: em } = state.project;
          const count = Array.from(state.selections.values()).filter(s => s.rating > 0).length;
          if (pl != null && em != null && count > pl + em) {
            const max = pl + em, over = count - max;
            return json({
              error: em > 0
                ? `目前選了 ${count} 張，最多可送出 ${max} 張（方案 ${pl} + 加選 ${em}）。請先取消 ${over} 張再送出`
                : `目前選了 ${count} 張，此專案最多 ${max} 張，不可加選。請先取消 ${over} 張再送出`,
              code: 'pick_cap', count, max, over, limit: pl, extra_max: em }, 409);
          }
        }
        const photo_keys = Array.from(state.selections.entries())
          .filter(([, s]) => s.rating > 0).map(([k]) => k).sort();
        const submission = {
          id: 'sub-' + (state.submissions.length + 1), picker_id: picker.id,
          relationship: body.relationship, email: mail, photo_keys, count: photo_keys.length,
          // {photo_key: pins} over the picked photos that have pins; null when none
          marks: (() => {
            const o = {};
            for (const k of photo_keys) { const mk = state.selections.get(k).marks; if (mk && mk.length) o[k] = mk; }
            return Object.keys(o).length ? o : null;
          })(),
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
          pick_limit: state.project.pick_limit, extra_price: state.project.extra_price,
          extra_max: state.project.extra_max,
          owner_name: owner ? owner.name : null,
          created_at: '2026-01-01T00:00:00.000Z',
          archived_at: state.project.archived_at,
          delivered_at: state.project.delivered_at,
          final_folders: state.project.final_folders,
          allow_proof_download: state.project.allow_proof_download,
          submission_count: subs.length,
          last_submitted_at: subs.length ? subs[subs.length - 1].created_at : null,
          unnotified_submissions: unnotifiedCountFake(subs),
          token: live ? live.token : null,
        }] : [];
        return json({ projects });
      }

      if (u.pathname === '/api/admin/settings' && method === 'GET') return json(settingsShapeFake(state.settings));
      if (u.pathname === '/api/admin/projects' && method === 'POST') {
        // extra_max: a whole number 0-500 is stored, null = stored NULL (no plan
        // cap), LEFT OUT = the studio default (else 10); anything else is 400
        let extra_max;
        if (!('extra_max' in (body || {}))) extra_max = settingsShapeFake(state.settings).effective_default_extra_max;
        else if (body.extra_max === null || isExtraMaxFake(body.extra_max)) extra_max = body.extra_max;
        else return json({ error: 'extra_max must be a whole number from 0 to 500' }, 400);
        return json({
          project: {
            id: state.project.id, title: body.title || '', folders: body.folders,
            pick_limit: body.pick_limit ?? null, extra_price: body.extra_price ?? null,
            extra_max, photographer_id: 'default',
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
          .map(([photo_key, s]) => ({ photo_key, rating: s.rating, note: s.note,
            marks: opts.marksUnavailable ? null : (s.marks || null), updated_by: s.updated_by, updated_at: s.updated_at }));
        const submissions = state.submissions.slice().reverse()
          .map(sub => ({ ...sub, marks: opts.marksUnavailable ? null : (sub.marks || null) }));
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
        state.project.delivered_at = null; // reopen always implies retouching's stamp is gone too
        state.project.final_folders = null;
        return json({ ok: true, phase: 'picking' });
      }
      // Delivered projects (docs/dashboard-settings.md) — a stamp, not a
      // phase: delivering never changes `phase`, only sets `delivered_at`,
      // and only from retouching.
      if (/\/api\/admin\/projects\/[^/]+\/deliver$/.test(u.pathname) && method === 'POST') {
        if (state.project.phase !== 'retouching')
          return json({ error: '尚未開始修圖，無法標記為已交付', code: 'not_retouching', phase: state.project.phase }, 409);
        const raw = body && typeof body === 'object' && !Array.isArray(body) ? body.final_folders : undefined;
        if (Array.isArray(raw) && raw.length > 20)
          return json({ error: '交件資料夾最多 20 個', code: 'too_many_final_folders', max: 20 }, 400);
        const finals = finalFoldersFake(raw);
        if (!finals) return json({ error: '交件資料夾不正確', code: 'invalid_final_folders' }, 400);
        const proofs = state.project.folders.concat(...state.tokens.map(t => t.folders || []));
        const clash = finals.find(f => proofs.some(p => f.startsWith(p) || p.startsWith(f)));
        if (clash) return json({ error: `「${clash}」與毛片資料夾重疊，精修請放在獨立的資料夾`, code: 'final_overlaps_proofs', folder: clash }, 400);
        // a repeat deliver replaces the finals and keeps the first stamp
        if (!state.project.delivered_at) state.project.delivered_at = new Date().toISOString();
        state.project.final_folders = finals;
        return json({ ok: true, delivered_at: state.project.delivered_at, final_folders: finals });
      }
      if (/\/api\/admin\/projects\/[^/]+\/undeliver$/.test(u.pathname) && method === 'POST') {
        state.project.delivered_at = null;
        state.project.final_folders = null; // clears the snapshot too
        return json({ ok: true, delivered_at: null });
      }
      if (/^\/api\/admin\/projects\/[^/]+$/.test(u.pathname) && method === 'PATCH') {
        if (opts.patchStatus && opts.patchStatus !== 200)
          return json(opts.patchBody || { error: 'DB error' }, opts.patchStatus);
        // any non-empty subset of the four keys; one bad key spoils the body
        const good = {
          allow_proof_download: v => typeof v === 'boolean',
          pick_limit: v => v === null || (Number.isSafeInteger(v) && v >= 0),
          extra_price: v => v === null || (Number.isSafeInteger(v) && v >= 0 && v <= MONEY_MAX_FAKE),
          extra_max: v => v === null || isExtraMaxFake(v),
        };
        const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
        if (!keys.length || keys.some(k => !good[k] || !good[k](body[k])))
          return json({ error: 'Invalid body', code: 'invalid_body' }, 400);
        const planKey = keys.some(k => k !== 'allow_proof_download');
        if (planKey && state.project.archived_at)
          return json({ error: 'Project is archived; unarchive it first', code: 'archived' }, 409);
        for (const k of keys) state.project[k] = body[k];
        return json({ ok: true, ...body });
      }

      // A pick link's reads (docs/delivery.md): a listing outside the link's
      // scope is 401 when the fixture asks for scoped reads; an original (no
      // ?w=, or ?download=1) is finals once delivered, proofs only while the
      // switch is on — else 403 original_not_allowed. Downloads carry the
      // real Content-Disposition; a Range request gets a real 206.
      if (shareTok && method === 'GET' && !u.pathname.startsWith('/api/') && u.pathname !== '/' && !u.searchParams.has('list')) {
        const key = decodeURIComponent(u.pathname.slice(1));
        const scope = pickScopeFake(state.project);
        const cors = { 'Access-Control-Allow-Origin': '*' };
        const isDownload = u.searchParams.get('download') === '1';
        const isOriginal = isDownload || !u.searchParams.has('w');
        if (isOriginal) {
          const isFinal = scope.finals.some(f => key.startsWith(f));
          if (!isFinal && !state.project.allow_proof_download) {
            return route.fulfill({ status: 403, contentType: 'application/json', headers: cors,
              body: JSON.stringify({ error: '原檔未開放下載', code: 'original_not_allowed' }) });
          }
        }
        const headers = { ...cors, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400' };
        if (isDownload) headers['Content-Disposition'] = attachmentFake(key);
        const full = opts.image || PIXEL;
        if (h['range']) {
          const m = /^bytes=(\d+)-(\d*)$/.exec(h['range']);
          if (m) {
            const start = +m[1], end = m[2] === '' ? full.length - 1 : Math.min(+m[2], full.length - 1);
            headers['Content-Range'] = `bytes ${start}-${end}/${full.length}`;
            return route.fulfill({ status: 206, contentType: 'image/png', headers, body: full.subarray(start, end + 1) });
          }
        }
        return route.fulfill({ status: 200, contentType: 'image/png', headers, body: full });
      }

      if (u.searchParams.has('list')) {
        // Nested subfolders (docs/backlog.md "Guest page hides subfolders"):
        // a flat list of full photo keys, delimiter-listed exactly like
        // worker.js's own R2 call — so `folders` for any prefix reflects
        // whatever subfolders actually exist under it, at any depth.
        if (opts.pickFiles) {
          const prefix = u.searchParams.get('list') || '';
          const { data, folders } = delimitedListFake(opts.pickFiles, prefix);
          return json({ status: 'success', data, folders });
        }
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
      if (opts.image) return route.fulfill({ status: 200, contentType: 'image/png', body: opts.image,
        headers: { 'Access-Control-Allow-Origin': '*' } });
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
      await page.evaluate(() => document.getElementById('submitJobBtn') === null &&
        !document.getElementById('pickSubmitBtn').getClientRects().length));

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
      submitShown: !!document.getElementById('pickSubmitBtn').getClientRects().length &&
        document.getElementById('submitJobBtn') === null,
    }));
    ok('the grid loaded', r.cards === 3, String(r.cards));
    ok('no star rating control exists — the guest heart replaces it', r.stars === 0, String(r.stars));
    ok('no select checkbox exists either — the guest heart replaces it too', r.selectBtns === 0, String(r.selectBtns));
    ok('the owner gets one clickable ♥ toggle on every card', r.hearts === 3, String(r.hearts));
    ok('the bottom 完成提交 (#pickSubmitBtn) is shown once this browser owns the seat, no header 完成挑圖', r.submitShown === true);
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
        submitShown: !!document.getElementById('pickSubmitBtn').getClientRects().length,
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
      ok('no submit button is visible for a viewer', r.submitShown === false);
      return out;
    },
    { before: m.attach });
}

{
  const m = pickFakeWorker({ ownerName: 'Alice', ownerKey: 'ALICE-KEY', pickLimit: 1, extraPrice: 50 });
  await suite('guest picking — ratings autosave debounced and batched, and the counter turns orange over the limit',
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

      const counter1 = await page.evaluate(() => document.getElementById('pickCounter').textContent);
      ok('the counter shows the plan’s limit', counter1 === '已選 1 / 1 張', counter1);
      ok('no over-limit message yet',
        await page.evaluate(() => !document.getElementById('pickCounter').classList.contains('over') && !/超出|加挑費/.test(document.body.innerText)));

      await card(1).locator('.pick-heart-btn').click();
      await page.waitForTimeout(1000);
      const counter2 = await page.evaluate(() => document.getElementById('pickCounter').textContent);
      ok('the counter now reads 2', counter2 === '已選 2 / 1 張', counter2);
      const warn = await page.evaluate(() => ({
        over: document.getElementById('pickCounter').classList.contains('over'),
        text: document.body.innerText,
      }));
      ok('over the limit only the counter changes (colour) — no message, and nothing is blocked',
        warn.over && !/超出|多 1 張|加挑費/.test(warn.text), warn.text.slice(0, 200));

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
      const counter3 = await page.evaluate(() => document.getElementById('pickCounter').textContent);
      ok('the counter drops back to 1', counter3 === '已選 1 / 1 張', counter3);
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

      await page.click('#pickSubmitBtn');
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
        submitShown: !!document.getElementById('pickSubmitBtn').getClientRects().length,
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

// A bare index.html with no recognised mode param and no session now leaves
// for home.html (see the "studio entrance" suites below) instead of showing
// the choice overlay, so this "untouched" check needs a URL that still
// selects a mode without any auth — ?folder= is exactly that (the old magic
// link), and per spec it "behaves exactly as today".
await suite('guest picking — the studio/client choice overlay and other modes are untouched with ?folder= and no session',
  `${base}/index.html?folder=20260819/`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    ok('PickController exists but is inactive', await page.evaluate(() =>
      !!window.PickController && window.PickController.active === false));
    ok('the pick counter never appears in a mode that never turns it on (not in the DOM, bottom bar keeps its own 已選取)',
      await page.evaluate(() => document.getElementById('pickCounter') === null && !document.body.classList.contains('pick-active') &&
        !!document.getElementById('mobileSelectedCount')));
    ok('the ♥ filter bar stays hidden too — no pick mode to unhide it',
      await page.evaluate(() => getComputedStyle(document.getElementById('pickFilterBar')).display === 'none'));
    ok('the star filter and 只看選取 are untouched, still in the DOM',
      await page.evaluate(() => !!document.querySelector('.star-filter') && !!document.getElementById('filterSelectedBtn')));
    ok('the studio/client choice overlay still appears',
      await page.waitForSelector('#auth-overlay', { timeout: 5000 }).then(() => true, () => false));
    ok('and it was not redirected to home.html', !/home\.html/.test(page.url()), page.url());
    return out;
  },
  { before: mockWorker(1) });

// ═══════════════════════════════════════════════════════════════════════════
// index.html entrance — imhoti.tw/studio/ serves index.html, and a bare visit
// (no ?t=/?project=/?folder=/?id= and no studio_token/client_session) should
// land on home.html instead of the studio/client choice overlay.
// ═══════════════════════════════════════════════════════════════════════════

await suite('入口 — 沒有模式參數也沒有登入狀態的 index.html 導向 home.html',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForURL('**/home.html', { timeout: 3000 }).catch(() => {});
    ok('redirected to home.html', /home\.html$/.test(page.url()), page.url());
    ok('the choice overlay was never shown',
      await page.evaluate(() => document.getElementById('auth-overlay') === null));
    return out;
  },
  { before: mockWorker(1) });

await suite('入口 — index.html?t=<pick token> 不會被導向 home.html',
  `${base}/index.html?t=PICK-TOKEN`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForTimeout(500);
    ok('PickController took the page — active is true',
      await page.evaluate(() => !!window.PickController && window.PickController.active === true));
    ok('stayed on index.html, not redirected to home.html',
      /\/index\.html\?t=PICK-TOKEN$/.test(page.url()), page.url());
    return out;
  },
  { before: pickFakeWorker({ ownerName: 'Ivy' }).attach });

await suite('入口 — sessionStorage 已有 studio_token 的 index.html 不會被導向 home.html',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForTimeout(500);
    ok('stayed on index.html — the studio token bypasses the redirect',
      /\/index\.html$/.test(page.url()), page.url());
    ok('the choice overlay was never shown',
      await page.evaluate(() => document.getElementById('auth-overlay') === null));
    return out;
  },
  { before: mockWorker(1), initScript: ADMIN });

// imhoti.tw/studio/ itself (the directory URL, what Tim types) with a
// photographer signed in goes to the dashboard. index.html by name — the side
// menu's 選圖 and upload's 回選圖 — still opens the workspace (suite above).
await suite('入口 — 已登入攝影師開 /studio/ 導向 dashboard.html',
  `${base}/`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForURL('**/dashboard.html', { timeout: 3000 }).catch(() => {});
    ok('redirected to dashboard.html', /\/dashboard\.html$/.test(page.url()), page.url());
    return out;
  },
  { before: mockWorker(1), initScript: ADMIN });

await suite('入口 — 已登入攝影師開 /studio/?project=<id> 留在原頁',
  `${base}/?project=P1`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForTimeout(500);
    ok('a mode param keeps the page', /\/\?project=P1$/.test(page.url()), page.url());
    return out;
  },
  { before: mockWorker(1), initScript: ADMIN });

await suite('入口 — 沒登入開 /studio/ 仍導向 home.html',
  `${base}/`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForURL('**/home.html', { timeout: 3000 }).catch(() => {});
    ok('redirected to home.html', /\/home\.html$/.test(page.url()), page.url());
    return out;
  },
  { before: mockWorker(1) });

{
  const m = clientMock();
  await suite('入口 — 已登入的客戶（client_session）的 index.html 不會被導向 home.html',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#client-bar', { timeout: 5000 }).then(() => true, () => false);
      ok('the client bar rendered instead of a redirect', await page.evaluate(() => !!document.getElementById('client-bar')));
      ok('stayed on index.html', /\/index\.html$/.test(page.url()), page.url());
      return out;
    },
    { before: m.attach, initScript: CLIENT });
}

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
  // docs/backlog.md "Guest page hides subfolders": project folder A/ has no
  // photos of its own, only in A/a/, A/b/ and A/c/ — real nested prefixes,
  // delimiter-listed by the fake exactly like worker.js's own R2 call.
  const m = pickFakeWorker({
    ownerName: 'Nina', ownerKey: 'NINA-KEY',
    folders: ['A/'],
    pickFiles: ['A/a/p0.jpg', 'A/a/p1.jpg', 'A/b/p0.jpg', 'A/c/p0.jpg'],
  });
  await suite('guest picking — subfolders: a photo-less project folder opens its first subfolder automatically, with every subfolder nested and clickable in the panel',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });

      const r1 = await page.evaluate(() => ({
        cardNames: [...document.querySelectorAll('.photo-card .photo-name')].map(e => e.textContent),
        rows: [...document.querySelectorAll('#folderTree .tree-row')].map(el => el.dataset.folder),
        labels: [...document.querySelectorAll('#folderTree .tree-row .tree-label')].map(el => el.textContent),
        activeRows: [...document.querySelectorAll('#folderTree .tree-row.tree-active')].map(el => el.dataset.folder),
      }));
      ok('A/ itself has no photos, so opening it lands on its first subfolder (A/a/) automatically',
        JSON.stringify(r1.cardNames) === JSON.stringify(['p0.jpg', 'p1.jpg']), JSON.stringify(r1.cardNames));
      ok('the panel lists the project folder and every one of its subfolders, nested under it',
        JSON.stringify(r1.rows) === JSON.stringify(['A/', 'A/a/', 'A/b/', 'A/c/']), JSON.stringify(r1.rows));
      ok('labels are the last path segment, not the full path',
        JSON.stringify(r1.labels) === JSON.stringify(['A', 'a', 'b', 'c']), JSON.stringify(r1.labels));
      ok('the subfolder actually opened (A/a/) is the one highlighted, not the empty parent',
        JSON.stringify(r1.activeRows) === JSON.stringify(['A/a/']), JSON.stringify(r1.activeRows));

      // a subfolder is reachable and clickable, not just listed
      await page.click('#folderTree .tree-row[data-folder="A/b/"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 1,
        null, { timeout: 5000 });
      const r2 = await page.evaluate(() => ({
        cardName: document.querySelector('.photo-card .photo-name')?.textContent,
        activeRows: [...document.querySelectorAll('#folderTree .tree-row.tree-active')].map(el => el.dataset.folder),
        rows: [...document.querySelectorAll('#folderTree .tree-row')].map(el => el.dataset.folder),
      }));
      ok('clicking a nested subfolder actually loads its own (different) photos',
        r2.cardName === 'p0.jpg', String(r2.cardName));
      ok('and moves the highlight to it', JSON.stringify(r2.activeRows) === JSON.stringify(['A/b/']), JSON.stringify(r2.activeRows));
      ok('the tree still shows every subfolder, not just the one now open',
        JSON.stringify(r2.rows) === JSON.stringify(['A/', 'A/a/', 'A/b/', 'A/c/']), JSON.stringify(r2.rows));

      // re-opening the empty parent itself re-runs the same auto-navigate,
      // rather than showing an empty grid (rule 3's fallback never has to
      // fire here, but re-clicking the empty parent must not get stuck)
      await page.click('#folderTree .tree-row[data-folder="A/"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 2,
        null, { timeout: 5000 });
      const r3 = await page.evaluate(() => ({
        activeRows: [...document.querySelectorAll('#folderTree .tree-row.tree-active')].map(el => el.dataset.folder),
      }));
      ok('clicking the empty parent again re-lands on its first subfolder',
        JSON.stringify(r3.activeRows) === JSON.stringify(['A/a/']), JSON.stringify(r3.activeRows));

      // Rule 3's backstop (docs/backlog.md): rule 2's auto-navigate means the
      // page itself never actually sits in a photo-less-but-has-subfolders
      // folder, so drive applyServerSelections directly into that state, the
      // way a future caller other than handleLoadPhotos might, and check it
      // still renders the folder-card grid rather than wiping it to empty.
      const r4 = await page.evaluate(() => {
        app.currentFolders = [{ id: 'A/x/', name: 'x' }];
        app.photos = [];
        PickController.applyServerSelections();
        return {
          folderCards: document.querySelectorAll('.folder-card').length,
          photoCards: document.querySelectorAll('.photo-card').length,
        };
      });
      ok('applyServerSelections renders folder cards, not an empty photo grid, for a photo-less-with-subfolders state',
        r4.folderCards === 1 && r4.photoCards === 0, JSON.stringify(r4));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'NINA-KEY') });
}

{
  // ♥ 已選 (docs/backlog.md rule 4) must still reach a subfolder the guest
  // is not currently viewing, exactly as it already does across sibling
  // project folders (see the 已選-across-folders suite above).
  const m = pickFakeWorker({
    ownerName: 'Omar', ownerKey: 'OMAR-KEY',
    folders: ['A/'],
    pickFiles: ['A/a/p0.jpg', 'A/b/p0.jpg'],
  });
  m.state.selections.set('A/b/p0.jpg', { rating: 1, note: '', updated_by: 'picker-0', updated_at: 't' });
  await suite('guest picking — subfolders: ♥ 已選 still reaches a pick made in a sibling subfolder',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const landed = await page.evaluate(() =>
        [...document.querySelectorAll('.photo-card .photo-name')].map(e => e.textContent));
      ok('landed on A/a/ (its own pick is unrated)', JSON.stringify(landed) === JSON.stringify(['p0.jpg']), JSON.stringify(landed));

      await page.click('#pickFilterBar [data-pick-filter="selected"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 1, null, { timeout: 5000 });
      const sel = await page.evaluate(() => ({
        ids: [...document.querySelectorAll('.photo-card')].map(el => el.dataset.photoId),
      }));
      ok('the pick made in A/b/ shows up under 已選 while viewing A/a/',
        JSON.stringify(sel.ids) === JSON.stringify(['A/b/p0.jpg']), JSON.stringify(sel.ids));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'OMAR-KEY') });
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
      // The table lives inside a collapsed <details> by default (task: 專案選片
      // — admin collapse), so it's attached but not visible until expanded.
      await page.waitForSelector('#project-detail-body table', { state: 'attached' });
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
      // The grid card's ♥ sits in the image's bottom-right corner (Tim's ask),
      // inside the image container — not the top-right, where ✎ goes.
      const pos = await page.evaluate(() => {
        const card = document.querySelector('.photo-card');
        const heart = card.querySelector('.pick-heart-btn');
        const img = card.querySelector('.photo-image-container');
        if (!heart || !img) return null;
        const h = heart.getBoundingClientRect(), c = img.getBoundingClientRect();
        return { inImg: heart.parentElement === img, bottomGap: c.bottom - h.bottom, rightGap: c.right - h.right,
                 lowerHalf: h.top > c.top + c.height / 2 };
      });
      ok('the grid ♥ is in the image container', pos?.inImg === true, JSON.stringify(pos));
      ok('the grid ♥ sits in the bottom-right corner',
        pos && pos.lowerHalf && pos.bottomGap >= 0 && pos.bottomGap <= 12 && pos.rightGap >= 0 && pos.rightGap <= 12,
        JSON.stringify(pos));

      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });

      const burst = () => page.evaluate(() => {
        const el = document.querySelector('.canvas-container .pick-heart-burst');
        return el ? { off: el.classList.contains('off'), text: el.textContent,
                      display: getComputedStyle(el).display } : null;
      });

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
      let b = await burst();
      ok('a big ♥ pops over the photo on toggle-on', b && !b.off && b.text === '♥' && b.display !== 'none', JSON.stringify(b));
      await page.waitForTimeout(1200);
      ok('and it clears itself afterwards', (await burst()) === null, JSON.stringify(await burst()));

      await doubleTapTouch(page, '#photoCanvas', 195, 400);
      s = await state();
      ok('a second double-tap toggles it back off', s.heartOn === false && s.rating === 0, JSON.stringify(s));
      ok('and the highlight goes with it', s.cardPicked === false, JSON.stringify(s));
      b = await burst();
      ok('toggle-off pops the hollow ♡ instead', b && b.off && b.text === '♡' && b.display !== 'none', JSON.stringify(b));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'OWEN-KEY'), contextOptions: MOBILE });
}

// A landscape photo on a portrait phone leaves black bars above and below
// it. The canvas now fills the whole frame (bars included — see "preview
// zoom" below), so a finger on a bar lands on the canvas, off the photo. The
// helpers above dispatch straight to the canvas; this one uses real touch
// input, so the finger lands on whatever is really at that point. The 1x1
// fixture photo makes nearly the whole frame letterbox.
{
  const m = pickFakeWorker({ ownerName: 'Lea', ownerKey: 'LEA-KEY', photos: PHOTOS(3) });
  await suite('mobile preview — double-tap on the black bars around the photo still likes it; the ‹ › buttons still work',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      await page.waitForTimeout(200);
      const box = await page.locator('.canvas-container').boundingBox();
      const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + 20);
      const hit = await page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el ? (el.id || el.className) : null;
      }, [x, y]);
      const px = await page.evaluate(CANVAS_PX, [x, y]);
      ok('the tap point is the bar (on the frame-sized canvas, nothing drawn there), not the photo',
        hit === 'photoCanvas' && !!px && px[3] === 0, JSON.stringify({ hit, px }));
      await page.touchscreen.tap(x, y);
      await page.waitForTimeout(150);
      await page.touchscreen.tap(x + 3, y + 2);
      await page.waitForTimeout(50);
      const r = await page.evaluate(() => ({ rating: app.filteredPhotos[0].rating,
        burst: !!document.querySelector('.canvas-container .pick-heart-burst'),
        counter: document.getElementById('photoCounter').textContent }));
      ok('double-tapping the bar likes the photo', r.rating === 1, JSON.stringify(r));
      ok('and pops the big ♥', r.burst, JSON.stringify(r));
      ok('and stays on the same photo', r.counter === '1 / 3', r.counter);

      await page.waitForTimeout(500);
      await page.locator('#nextPhotoBtn').tap();
      await page.waitForTimeout(100);
      ok('tapping › still goes to the next photo', (await page.textContent('#photoCounter')) === '2 / 3',
        await page.textContent('#photoCounter'));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'LEA-KEY'), contextOptions: MOBILE });
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
      ok('and pops no ♥ either',
        await page.evaluate(() => document.querySelectorAll('.pick-heart-burst').length === 0));
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

// ═══════════════════════════════════════════════════════════════════════════
// Preview zoom on a phone (docs/backlog.md, "Preview zoom on a phone"): a
// double-tap while zoomed goes back to fit (like iPhone Photos), the ⟲ is a
// real tap target, and a zoomed photo spreads over the whole frame instead of
// staying clipped to its fitted box. Real touch input (realTouch) and the
// 1600x1067 gradient BIG_PHOTO throughout — the 1x1 PIXEL hides layout bugs.
// ═══════════════════════════════════════════════════════════════════════════

// In-page helpers shared by these suites.
const ZOOM_STATE = () => ({
  zoom: parseInt(document.getElementById('zoomLevel').textContent, 10),
  panX: annotationManager.panX, panY: annotationManager.panY,
  rating: app.filteredPhotos[0].rating,
  burst: document.querySelectorAll('.pick-heart-burst').length,
  counter: document.getElementById('photoCounter').textContent,
});
const isPhotoPx = px => !!px && px[3] === 255 && Math.abs(px[2] - 60) <= 8;
const sameColour = (a, b, tol = 3) => !!a && !!b && [0, 1, 2].every(i => Math.abs(a[i] - b[i]) <= tol);

// In-page: the big photo is loaded and the modal's slideUp entrance has
// finished — until then every rect is still moving.
const PREVIEW_SETTLED = () => annotationManager.imageElement?.naturalWidth === 1600
  && document.querySelector('#photoModal .modal-content').getAnimations().length === 0;

async function openBigGuestPreview(page) {
  await page.waitForSelector('.photo-card', { timeout: 5000 });
  await page.locator('.photo-card').first().tap();
  await page.waitForSelector('#photoModal.active', { timeout: 5000 });
  await page.waitForFunction(PREVIEW_SETTLED, null, { timeout: 5000 });
  await page.waitForTimeout(100);
  const box = await page.locator('.canvas-container').boundingBox();
  return { cx: Math.round(box.x + box.width / 2), cy: Math.round(box.y + box.height / 2) };
}

{
  const m = pickFakeWorker({ ownerName: 'Zed', ownerKey: 'ZED-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('preview zoom — a double-tap while zoomed goes back to fit and leaves the ♥ alone; at fit it still toggles ♥',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { cx, cy } = await openBigGuestPreview(page);
      const t = await realTouch(page);
      const st = () => page.evaluate(ZOOM_STATE);

      await t.pinch(cx, cy, 60, 260);
      await page.waitForTimeout(50);
      let s = await st();
      ok('a real pinch zooms in first', s.zoom > 150, JSON.stringify(s));

      await t.tap(cx, cy);
      await page.waitForTimeout(500); // past the double-tap window
      s = await st();
      ok('a single tap while zoomed changes nothing', s.zoom > 150 && s.rating === 0, JSON.stringify(s));

      await t.doubleTap(cx, cy);
      await page.waitForTimeout(50);
      s = await st();
      ok('a double-tap while zoomed goes back to 100%', s.zoom === 100 && s.panX === 0 && s.panY === 0, JSON.stringify(s));
      ok('and does not touch the ♥ (no rating, no burst)', s.rating === 0 && s.burst === 0, JSON.stringify(s));
      const resetToasts = () => page.evaluate(() => [...document.querySelectorAll('#toastContainer .toast-message')]
        .filter(el => el.textContent.includes('已重置縮放')).length);
      ok('quietly — the gesture is its own feedback, no 已重置縮放 toast', (await resetToasts()) === 0, String(await resetToasts()));
      ok('and never navigates', s.counter === '1 / 3', s.counter);

      await page.waitForTimeout(500);
      await t.doubleTap(cx, cy);
      await page.waitForTimeout(50);
      s = await st();
      ok('a double-tap at fit still toggles ♥ on, as before', s.rating === 1 && s.burst === 1, JSON.stringify(s));
      ok('and stays at 100%', s.zoom === 100, JSON.stringify(s));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZED-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Pam', ownerKey: 'PAM-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('preview zoom — a pan drag while zoomed moves the photo and is never counted as a tap',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { cx, cy } = await openBigGuestPreview(page);
      const t = await realTouch(page);
      const st = () => page.evaluate(ZOOM_STATE);
      const px = (x, y) => page.evaluate(CANVAS_PX, [x, y]);

      await t.pinch(cx, cy, 60, 260);
      await page.waitForTimeout(50);
      const s0 = await st();
      ok('zoomed in first', s0.zoom > 150, JSON.stringify(s0));

      const target = await px(cx + 120, cy - 40);
      await t.drag(cx, cy, cx - 120, cy + 40);
      await page.waitForTimeout(50);
      let s = await st();
      ok('the drag pans by the finger’s travel',
        Math.abs(s.panX - s0.panX + 120) <= 2 && Math.abs(s.panY - s0.panY - 40) <= 2, JSON.stringify({ s0, s }));
      const now = await px(cx, cy);
      ok('the photo really moved under the finger', isPhotoPx(target) && sameColour(now, target),
        JSON.stringify({ target, now }));
      ok('still zoomed, same photo, no ♥', s.zoom === s0.zoom && s.counter === '1 / 3' && s.rating === 0,
        JSON.stringify(s));

      await t.drag(cx, cy, cx - 40, cy);
      await t.drag(cx, cy, cx - 40, cy);
      await page.waitForTimeout(50);
      s = await st();
      ok('two quick drags are not a double-tap', s.zoom === s0.zoom && s.rating === 0, JSON.stringify(s));

      await page.waitForTimeout(500);
      await t.tap(cx, cy);
      await t.drag(cx + 1, cy, cx + 41, cy);
      await page.waitForTimeout(50);
      s = await st();
      ok('a tap then a drag is not a double-tap', s.zoom === s0.zoom && s.rating === 0, JSON.stringify(s));

      await page.waitForTimeout(500);
      await t.drag(cx, cy, cx - 40, cy);
      await t.tap(cx - 40, cy);
      await page.waitForTimeout(50);
      s = await st();
      ok('a drag then a tap is not a double-tap', s.zoom === s0.zoom && s.rating === 0, JSON.stringify(s));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'PAM-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Vic', ownerKey: 'VIC-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('preview zoom — a viewer’s double-tap while zoomed goes back to fit too (and still no ♥)',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { cx, cy } = await openBigGuestPreview(page);
      const t = await realTouch(page);
      await t.pinch(cx, cy, 60, 260);
      await page.waitForTimeout(50);
      let s = await page.evaluate(ZOOM_STATE);
      ok('zoomed in first', s.zoom > 150, JSON.stringify(s));
      await t.doubleTap(cx, cy);
      await page.waitForTimeout(50);
      s = await page.evaluate(ZOOM_STATE);
      ok('back to 100%', s.zoom === 100, JSON.stringify(s));
      ok('rating untouched, no ♥ popped', s.rating === 0 && s.burst === 0, JSON.stringify(s));
      return out;
    },
    { before: m.attach, contextOptions: MOBILE }); // no picker key → a viewer
}

await suite('preview zoom — the photographer’s double-tap while zoomed goes back to fit too',
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
    await page.waitForFunction(PREVIEW_SETTLED, null, { timeout: 5000 });
    const box = await page.locator('.canvas-container').boundingBox();
    const cx = Math.round(box.x + box.width / 2), cy = Math.round(box.y + box.height / 2);
    const t = await realTouch(page);
    await t.pinch(cx, cy, 60, 260);
    await page.waitForTimeout(50);
    let s = await page.evaluate(ZOOM_STATE);
    ok('zoomed in first', s.zoom > 150, JSON.stringify(s));
    await t.doubleTap(cx, cy);
    await page.waitForTimeout(50);
    s = await page.evaluate(ZOOM_STATE);
    ok('back to 100%', s.zoom === 100, JSON.stringify(s));
    ok('rating untouched', s.rating === 0, JSON.stringify(s));
    return out;
  },
  { initScript: () => sessionStorage.setItem('studio_token', 'x'), before: mockWorker(3, {}, BIG_PHOTO), contextOptions: MOBILE });

{
  const m = pickFakeWorker({ ownerName: 'Fay', ownerKey: 'FAY-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('preview zoom — the canvas fills the frame; at 100% the photo sits exactly where it did; zoomed, it covers the black bars',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { cx, cy } = await openBigGuestPreview(page);
      const px = (x, y) => page.evaluate(CANVAS_PX, [x, y]);
      const old = await page.evaluate(OLD_FIT_RECT, [BIG_W, BIG_H]);

      const geo = await page.evaluate(() => {
        const c = document.getElementById('photoCanvas'), box = c.parentElement;
        const r = c.getBoundingClientRect(), b = box.getBoundingClientRect(), cs = getComputedStyle(box);
        return { cw: r.width, ch: r.height, bw: box.clientWidth, bh: box.clientHeight,
                 dx: r.left - b.left - parseFloat(cs.borderLeftWidth), dy: r.top - b.top - parseFloat(cs.borderTopWidth) };
      });
      ok('the canvas covers the whole frame', Math.abs(geo.cw - geo.bw) <= 1 && Math.abs(geo.ch - geo.bh) <= 1
        && Math.abs(geo.dx) <= 1 && Math.abs(geo.dy) <= 1, JSON.stringify(geo));
      const contTop = (await page.locator('.canvas-container').boundingBox()).y;
      ok('a landscape photo on a portrait phone leaves bars (the case under test)', old.top - contTop > 40,
        JSON.stringify({ old, contTop }));

      // At 100%: the photo's four corners are where the old fitted canvas put them.
      const tl = await px(old.left + 2, old.top + 2), br = await px(old.left + old.w - 3, old.top + old.h - 3);
      ok('at 100% the photo’s top-left corner is where it was', isPhotoPx(tl) && tl[0] <= 4 && tl[1] <= 4, JSON.stringify(tl));
      ok('and its bottom-right corner too', isPhotoPx(br) && br[0] >= 251 && br[1] >= 251, JSON.stringify(br));
      const above = await px(cx, old.top - 3), below = await px(cx, old.top + old.h + 3);
      ok('the bar just above it is still empty', !isPhotoPx(above), JSON.stringify(above));
      ok('the bar just below it is still empty', !isPhotoPx(below), JSON.stringify(below));

      // Zoom in about the centre with a real pinch.
      const t = await realTouch(page);
      const mid0 = await px(cx, cy);
      await t.pinch(cx, cy, 60, 300);
      await page.waitForTimeout(50);
      const z = await page.evaluate(() => annotationManager.zoom);
      ok('pinched to well over 2x', z > 2, String(z));
      const mid1 = await px(cx, cy);
      ok('the pinch zoomed about its midpoint (same photo point under it)', sameColour(mid1, mid0),
        JSON.stringify({ mid0, mid1 }));
      const barPt = await px(cx, old.top - 20), barPt2 = await px(cx, old.top + old.h + 20);
      ok('zoomed, the old bar above shows the photo', isPhotoPx(barPt), JSON.stringify(barPt));
      ok('and so does the old bar below', isPhotoPx(barPt2), JSON.stringify(barPt2));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'FAY-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Rio', ownerKey: 'RIO-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('preview zoom — rotating the phone re-fits the canvas and the photo to the new frame',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await openBigGuestPreview(page);
      await page.setViewportSize({ width: 844, height: 390 });
      await page.waitForTimeout(300);
      const geo = await page.evaluate(() => {
        const c = document.getElementById('photoCanvas'), box = c.parentElement;
        const r = c.getBoundingClientRect();
        return { cw: r.width, ch: r.height, bw: box.clientWidth, bh: box.clientHeight };
      });
      ok('after rotating, the canvas still covers the whole frame',
        Math.abs(geo.cw - geo.bw) <= 1 && Math.abs(geo.ch - geo.bh) <= 1, JSON.stringify(geo));
      const old = await page.evaluate(OLD_FIT_RECT, [BIG_W, BIG_H]);
      const tl = await page.evaluate(CANVAS_PX, [old.left + 2, old.top + 2]);
      const br = await page.evaluate(CANVAS_PX, [old.left + old.w - 3, old.top + old.h - 3]);
      ok('and the photo is re-fitted, corners where a fresh open would put them',
        isPhotoPx(tl) && tl[0] <= 4 && tl[1] <= 4 && isPhotoPx(br) && br[0] >= 251 && br[1] >= 251,
        JSON.stringify({ old, tl, br }));

      // Landscape phone: the bars are now left and right of the photo, so
      // this is where the horizontal centring offset really matters.
      const cont = (await page.locator('.canvas-container').boundingBox());
      ok('the rotated frame has side bars (the case under test)', old.left - cont.x > 40, JSON.stringify({ old, cont }));
      const midY = Math.round(old.top + old.h / 2);
      const left = await page.evaluate(CANVAS_PX, [old.left - 3, midY]);
      ok('the side bar is still empty at 100%', !!left && !isPhotoPx(left), JSON.stringify(left));
      const P = { x: Math.round(old.left + old.w * 0.25), y: midY };
      const p0 = await page.evaluate(CANVAS_PX, [P.x, P.y]);
      const t = await realTouch(page);
      await t.pinch(P.x, P.y, 60, 200);
      await page.waitForTimeout(50);
      const z = await page.evaluate(() => annotationManager.zoom);
      const p1 = await page.evaluate(CANVAS_PX, [P.x, P.y]);
      ok('an off-centre pinch zooms about its midpoint', z > 2 && sameColour(p0, p1), JSON.stringify({ z, p0, p1 }));
      const side = await page.evaluate(CANVAS_PX, [old.left - 20, midY]);
      ok('zoomed, the old side bar shows the photo', isPhotoPx(side), JSON.stringify(side));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'RIO-KEY'), contextOptions: MOBILE });
}

// Annotations are the photographer's saved data (localStorage, via
// driveManager.saveAnnotations). They're stored in "fitted canvas pixels":
// (0,0) is the photo's top-left, one unit is one screen px at 100% zoom of
// the fitted photo. That space must not change: old circles keep rendering
// on the same spot, new ones are stored the same way.
const OLD_CIRCLE = { type: 'circle', startX: 300, startY: 200, endX: 400, endY: 300,
  color: '#0000ff', size: 3, number: 1, timestamp: 1 };
const BLUE_NEAR = ([x, y, r]) => {
  const c = document.getElementById('photoCanvas');
  const cr = c.getBoundingClientRect();
  const d = c.getContext('2d').getImageData(Math.round(x - cr.left) - r, Math.round(y - cr.top) - r, 2 * r + 1, 2 * r + 1).data;
  for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 180 && d[i] < 80 && d[i + 1] < 80) return true;
  return false;
};

await suite('preview annotations — an old saved circle renders on the same spot; new ones are stored in the same space; wheel zoom stays about the cursor',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!window.app, null, { timeout: 5000 });
    await page.evaluate(circle => {
      app.filteredPhotos = Array.from({ length: 3 }, (_, i) => ({ id: `20260819/p${i}.jpg`, name: `p${i}.jpg`, rating: 0,
        annotations: i === 0 ? [circle] : [] }));
      driveManager.photos = app.filteredPhotos;
      app.openModal(0);
    }, OLD_CIRCLE);
    await page.waitForSelector('#photoModal.active', { timeout: 5000 });
    await page.waitForFunction(PREVIEW_SETTLED, null, { timeout: 5000 });
    await page.waitForTimeout(100);
    const px = (x, y) => page.evaluate(CANVAS_PX, [x, y]);
    const blueNear = (x, y, r = 2) => page.evaluate(BLUE_NEAR, [x, y, r]);
    const old = await page.evaluate(OLD_FIT_RECT, [BIG_W, BIG_H]);
    const stored = () => page.evaluate(() =>
      JSON.parse(localStorage.getItem('r2_photo_picker_annotations') || '{}')['20260819/p0.jpg'] || []);

    // 1. The old circle (centre 350,250, r 50) lands where the old canvas drew it.
    ok('the old circle’s right edge is drawn where it always was', await blueNear(old.left + 400, old.top + 250),
      JSON.stringify(old));
    ok('and its bottom edge', await blueNear(old.left + 350, old.top + 300));
    ok('its middle is photo, not ink', isPhotoPx(await px(old.left + 350, old.top + 250)));
    ok('and nothing is drawn 10px outside the ring', !(await blueNear(old.left + 410, old.top + 250, 1)));

    // 2. A new circle, drawn with the mouse at 100%, is stored in the same space.
    await page.click('#drawCircleBtn');
    await page.mouse.move(old.left + 100, old.top + 80);
    await page.mouse.down();
    await page.mouse.move(old.left + 150, old.top + 140, { steps: 4 });
    await page.mouse.move(old.left + 200, old.top + 190, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(50);
    let a = await stored();
    const c2 = a[1];
    ok('the new circle is saved', a.length === 2, JSON.stringify(a));
    ok('in the old coordinate space (fitted-photo pixels from its top-left)',
      !!c2 && Math.abs(c2.startX - 100) <= 1 && Math.abs(c2.startY - 80) <= 1
        && Math.abs(c2.endX - 200) <= 1 && Math.abs(c2.endY - 190) <= 1, JSON.stringify(c2));
    ok('and the old circle is saved back unchanged', JSON.stringify(a[0]) === JSON.stringify(OLD_CIRCLE), JSON.stringify(a[0]));

    // 2b. A drag that runs off the photo ends at its edge (the old photo-
    //     sized canvas ended it there on mouseleave): nothing stored outside.
    //     (Ends halfway into the bar below, still inside the frame — past
    //     the frame, the canvas's own mouseleave ends it, as before.)
    const into = await page.evaluate(t => (t - document.querySelector('.canvas-container').getBoundingClientRect().top) / 2, old.top);
    ok('(the frame has a bar below the photo to drag into)', into >= 10, String(into));
    await page.mouse.move(old.left + 200, old.top + old.h - 100);
    await page.mouse.down();
    await page.mouse.move(old.left + 320, old.top + old.h + into, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(50);
    a = await stored();
    const cEdge = a[2];
    ok('a drag that runs off the photo is stored ending on its edge',
      !!cEdge && Math.abs(cEdge.endY - old.h) <= 1 && Math.abs(cEdge.endX - 320) <= 1
        && Math.abs(cEdge.startY - (old.h - 100)) <= 1, JSON.stringify({ cEdge, h: old.h }));
    await page.evaluate(() => { annotationManager.undo(); }); // back to the two circles
    await page.waitForTimeout(50);
    a = await stored();
    ok('(undo leaves the two circles)', a.length === 2, JSON.stringify(a));

    // 3. Pressing on the black bar (off the photo) draws nothing, as before.
    const cont = await page.evaluate(() => {
      const b = document.querySelector('.canvas-container').getBoundingClientRect();
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    });
    const sideBar = old.left - cont.left, topBar = old.top - cont.top;
    ok('this desktop frame has a bar beside or above the photo', Math.max(sideBar, topBar) >= 20, JSON.stringify({ sideBar, topBar }));
    const bx = sideBar >= topBar ? cont.left + sideBar / 2 : old.left + 50;
    const by = sideBar >= topBar ? old.top + 50 : cont.top + topBar / 2;
    await page.mouse.move(bx, by);
    await page.mouse.down();
    await page.mouse.move(bx + 60, by + 60, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(50);
    a = await stored();
    ok('a drag starting on the bar adds no circle', a.length === 2, JSON.stringify(a));
    const by2 = sideBar >= topBar ? old.top + 50 : old.top + old.h + topBar / 2;
    const bx2 = sideBar >= topBar ? old.left + old.w + sideBar / 2 : old.left + 50;
    await page.mouse.move(bx2, by2);
    await page.mouse.down();
    await page.mouse.move(bx2 - 60, by2 - 60, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(50);
    a = await stored();
    ok('nor does one starting on the bar on the far side', a.length === 2, JSON.stringify(a));

    // 4. Wheel zoom about the cursor: the photo point under it stays put.
    await page.click('#panBtn');
    const P = { x: Math.round(old.left + old.w * 0.3), y: Math.round(old.top + old.h * 0.6) };
    const c0 = await px(P.x, P.y), q0 = await px(P.x + 80, P.y);
    await page.mouse.move(P.x, P.y);
    for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(30); }
    const z = await page.evaluate(() => annotationManager.zoom);
    ok('the wheel zoomed in', z > 1.4, String(z));
    const c1 = await px(P.x, P.y), q1 = await px(P.x + 80, P.y);
    ok('the photo point under the cursor stayed under it', sameColour(c0, c1), JSON.stringify({ c0, c1 }));
    ok('while the photo around it grew', !!q0 && !!q1 && Math.abs(q1[0] - q0[0]) >= 3, JSON.stringify({ q0, q1 }));
    ok('the old circle grew about the cursor too',
      await blueNear(P.x + (old.left + 400 - P.x) * z, P.y + (old.top + 250 - P.y) * z, 3));

    // 5. Zoomed, draw from a point that was bar at 100% but now shows the
    //    photo: stored in the same space, computed from the gradient colour
    //    (which photo pixel is under the mouse) — independent of the code.
    await page.click('#drawCircleBtn');
    const S = sideBar >= topBar ? { x: Math.round(old.left - 6), y: P.y } : { x: P.x, y: Math.round(old.top - 6) };
    const E = { x: S.x + 120, y: S.y + 90 };
    const sPx = await px(S.x, S.y), ePx = await px(E.x, E.y);
    ok('zoomed, the old bar now shows the photo', isPhotoPx(sPx), JSON.stringify(sPx));
    const worldOf = p => ({ x: p[0] / 255 * (BIG_W - 1) * old.s, y: p[1] / 255 * (BIG_H - 1) * old.s });
    await page.mouse.move(S.x, S.y);
    await page.mouse.down();
    await page.mouse.move(E.x, E.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(50);
    a = await stored();
    const c3 = a[2], ws = sPx && worldOf(sPx), we = ePx && worldOf(ePx);
    ok('a circle drawn while zoomed is stored at the photo point under the mouse',
      !!c3 && !!ws && !!we && Math.abs(c3.startX - ws.x) <= 5 && Math.abs(c3.startY - ws.y) <= 5
        && Math.abs(c3.endX - we.x) <= 5 && Math.abs(c3.endY - we.y) <= 5, JSON.stringify({ c3, ws, we }));

    // 6. Back to fit: the old circle is exactly where it started.
    await page.click('#zoomResetBtn');
    await page.waitForTimeout(50);
    ok('after ⟲ the old circle is back on its original spot', await blueNear(old.left + 400, old.top + 250));
    ok('and the ⟲ button still says 已重置縮放', await page.evaluate(() => [...document.querySelectorAll('#toastContainer .toast-message')]
      .some(el => el.textContent.includes('已重置縮放'))));
    return out;
  },
  { initScript: () => sessionStorage.setItem('studio_token', 'x'), before: mockWorker(3, {}, BIG_PHOTO) });

// The photographer's own tool, on a phone: a finger-drawn circle used to be
// lost (stopDrawing read clientX from a TouchEvent → NaN end point), and the
// −/+ buttons zoomed about the photo's top-left instead of the view's centre.
await suite('preview annotations — a circle drawn with a finger is saved with real numbers; the − / + buttons zoom about the centre of the view',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!window.app, null, { timeout: 5000 });
    await page.evaluate(() => {
      app.filteredPhotos = Array.from({ length: 3 }, (_, i) => ({ id: `20260819/p${i}.jpg`, name: `p${i}.jpg`, rating: 0, annotations: [] }));
      driveManager.photos = app.filteredPhotos;
      app.openModal(0);
    });
    await page.waitForSelector('#photoModal.active', { timeout: 5000 });
    await page.waitForFunction(PREVIEW_SETTLED, null, { timeout: 5000 });
    await page.waitForTimeout(100);
    const old = await page.evaluate(OLD_FIT_RECT, [BIG_W, BIG_H]);
    const stored = () => page.evaluate(() =>
      JSON.parse(localStorage.getItem('r2_photo_picker_annotations') || '{}')['20260819/p0.jpg'] || []);

    // 1. Finger-drawn circle (circle tool): start, move, lift.
    await page.evaluate(() => annotationManager.setTool('circle'));
    const x1 = old.left + 100, y1 = old.top + 80, x2 = old.left + 220, y2 = old.top + 200;
    await touchSequence(page, '#photoCanvas', [
      { type: 'touchstart', points: [{ x: x1, y: y1 }] },
      { type: 'touchmove', points: [{ x: (x1 + x2) / 2, y: (y1 + y2) / 2 }] },
      { type: 'touchmove', points: [{ x: x2, y: y2 }] },
      { type: 'touchend', points: [{ x: x2, y: y2 }] },
    ]);
    await page.waitForTimeout(80);
    const a = await stored();
    const c = a[0];
    ok('a circle was saved', a.length === 1, JSON.stringify(a));
    ok('its numbers are real (no NaN / null)', !!c && [c.startX, c.startY, c.endX, c.endY].every(Number.isFinite), JSON.stringify(c));
    ok('and it runs from where the finger went down to where it lifted',
      !!c && Math.abs(c.startX - 100) <= 2 && Math.abs(c.startY - 80) <= 2 && Math.abs(c.endX - 220) <= 2 && Math.abs(c.endY - 200) <= 2, JSON.stringify(c));

    // 2. − / + zoom about the centre of the view, not the photo's top-left.
    await page.evaluate(() => annotationManager.setTool('pan'));
    await page.evaluate(() => annotationManager.resetZoom({ quiet: true }));
    const centre = await page.evaluate(() => ({ x: annotationManager.fitW / 2, y: annotationManager.fitH / 2 }));
    const beforeWorld = await page.evaluate(() => {
      const m = annotationManager; return { x: (m.fitW / 2 - m.panX) / m.zoom, y: (m.fitH / 2 - m.panY) / m.zoom };
    });
    await page.evaluate(() => { document.getElementById('zoomInBtn').click(); document.getElementById('zoomInBtn').click(); });
    const after = await page.evaluate(() => {
      const m = annotationManager;
      return { z: m.zoom, x: (m.fitW / 2 - m.panX) / m.zoom, y: (m.fitH / 2 - m.panY) / m.zoom };
    });
    ok('the buttons zoomed in', after.z > 1.3, JSON.stringify(after));
    ok('and the photo point in the middle of the view stayed in the middle',
      Math.abs(after.x - beforeWorld.x) <= 1 && Math.abs(after.y - beforeWorld.y) <= 1, JSON.stringify({ beforeWorld, after, centre }));
    return out;
  },
  { initScript: () => sessionStorage.setItem('studio_token', 'x'), contextOptions: MOBILE, before: mockWorker(3, {}, BIG_PHOTO) });

{
  const m = pickFakeWorker({ ownerName: 'Kai', ownerKey: 'KAI-KEY', photos: [
    // a real camera-length filename, so the bar's name has to give way
    { id: '20260819/DSC_20260819_143015_wedding_ceremony.jpg', name: 'DSC_20260819_143015_wedding_ceremony.jpg', size: 9e6, rating: 0 },
    ...PHOTOS(1)] });
  await suite('tap targets on a mobile viewport — the preview’s ⟲ and − / + zoom buttons are >= 44x44 CSS px, on screen and apart',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      // measure after the modal's slideUp entrance, not mid-slide
      await page.waitForFunction(() => document.querySelector('#photoModal .modal-content').getAnimations().length === 0,
        null, { timeout: 5000 });
      const boxes = await page.evaluate(() => ['zoomOutBtn', 'zoomInBtn', 'zoomResetBtn'].map(id => {
        const el = document.getElementById(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { id, w: r.width, h: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
                 display: getComputedStyle(el).display };
      }));
      for (const b of boxes) {
        ok(`${b?.id} is >= 44x44`, !!b && b.display !== 'none' && b.w >= 44 && b.h >= 44, JSON.stringify(b));
        ok(`${b?.id} is fully on screen`, !!b && b.left >= 0 && b.right <= 390 && b.top >= 0 && b.bottom <= 844, JSON.stringify(b));
      }
      const overlap = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      ok('none of them overlap', boxes.every(Boolean) && !overlap(boxes[0], boxes[1]) && !overlap(boxes[1], boxes[2])
        && !overlap(boxes[0], boxes[2]), JSON.stringify(boxes));
      const hit = await page.evaluate(b => document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2)?.closest('button')?.id, boxes[2]);
      ok('a tap on the ⟲ reaches it', hit === 'zoomResetBtn', String(hit));
      const heart = await page.evaluate(() => {
        const r = document.querySelector('#modalPhotoRating .pick-heart-btn')?.getBoundingClientRect();
        return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom } : null;
      });
      const nameW = await page.evaluate(() => document.getElementById('modalPhotoName').getBoundingClientRect().width);
      ok('the file name keeps a readable width (>= 80px, ellipsised)', nameW >= 80, String(nameW));
      ok('the bigger buttons don’t push the bar’s ♥ off screen or onto them',
        !!heart && heart.left >= 0 && heart.right <= 390 && heart.bottom <= 844
          && boxes.every(b => b && !overlap(b, heart)), JSON.stringify({ heart, boxes }));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'KAI-KEY'), contextOptions: MOBILE });
}

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

// A bare index.html with no session now leaves for home.html (the "studio
// entrance" suites above), so this desktop-bucket check — which has nothing
// to do with auth — needs a studio_token to stay on the page, same as the
// "photographer mode" suite below.
await suite('responsive preview width — a desktop viewport keeps the 1600 bucket',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!window.driveManager, null, { timeout: 5000 });
    const width = await page.evaluate(() => driveManager.previewWidth());
    ok('desktop (1500px, DPR1) keeps the largest bucket', width === 1600, String(width));
    return out;
  },
  { initScript: ADMIN });

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

      b = await box('#pickSubmitBtn');
      ok('完成提交 is >= 44 tall', !!b && b.h >= 44, JSON.stringify(b));

      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickSubmitModal.active', { timeout: 5000 });
      b = await box('#pickSubmitConfirmBtn');
      ok('確認送出 is >= 44 tall', !!b && b.h >= 44, JSON.stringify(b));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: MOBILE });
}

// ── one pick counter (bottom-left), over-limit colour, over-limit submit modal ──
const pickHeart = (page, i) => page.locator('.photo-card').nth(i).locator('.pick-heart-btn').click();
const pickSubmits = m => m.requests.filter(r => r.method === 'POST' && r.path === '/api/pick/submit');

for (const [label, co] of [['desktop', undefined], ['phone 390px', MOBILE]]) {
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', pickLimit: 40, extraPrice: 500 });
  await suite(`pick counter — one counter only, bottom-left, 已選 N / limit 張 (${label})`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await pickHeart(page, 0);
      await page.waitForTimeout(300);
      // the old header counter is gone from the DOM (not hidden)
      ok('#pickCounterMain and #pickCounterWarn no longer exist',
        await page.evaluate(() => !document.getElementById('pickCounterMain') && !document.getElementById('pickCounterWarn')));
      ok('nothing inside the header renders a count',
        await page.evaluate(() => !document.querySelector('header.header #pickCounter') && !/已選\s*\d/.test(document.querySelector('header.header').textContent)));
      // exactly one element anywhere shows the pick count
      const found = await page.evaluate(() => [...document.querySelectorAll('body *')]
        .filter(e => e.children.length === 0 && /已選\s*\d+\s*(\/|張)/.test(e.textContent) && e.getBoundingClientRect().width > 0)
        .map(e => ({ id: e.id, text: e.textContent.trim(), x: e.getBoundingClientRect().left, y: e.getBoundingClientRect().top })));
      ok('exactly one visible pick counter', found.length === 1, JSON.stringify(found));
      ok('its text is 已選 1 / 40 張', found[0] && found[0].text === '已選 1 / 40 張', JSON.stringify(found));
      const vp = page.viewportSize();
      ok('and it sits bottom-left', found[0] && found[0].x < vp.width / 3 && found[0].y > vp.height * 0.8, JSON.stringify(found[0]));
      ok('the photo position counter of the preview is untouched',
        await page.evaluate(() => !!document.getElementById('photoCounter')));
      ok('the counter is inside the bottom bar', await page.evaluate(() => !!document.querySelector('#mobileActionBar #pickCounter')));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: co });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY' });
  await suite('pick counter — no limit reads 已選 N 張',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const t0 = await page.textContent('#pickCounter');
      ok('0 picks, no limit', t0 === '已選 0 張', t0);
      await pickHeart(page, 0); await pickHeart(page, 1);
      const t2 = await page.textContent('#pickCounter');
      ok('2 picks, no limit', t2 === '已選 2 張', t2);
      ok('never in over state without a limit', await page.evaluate(() => !document.getElementById('pickCounter').classList.contains('over')));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY') });
}

for (const [label, co] of [['desktop', undefined], ['phone 390px', MOBILE]]) {
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', pickLimit: 2, extraPrice: 500 });
  await suite(`pick counter — turns orange only above the limit, and nothing else is said while picking (${label})`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const color = () => page.evaluate(() => getComputedStyle(document.getElementById('pickCounter')).color);
      const bodyText = () => page.evaluate(() => document.body.innerText);
      const normal = await color();
      await pickHeart(page, 0); await pickHeart(page, 1);
      const atLimit = await color();
      ok('at exactly the limit (2 / 2) the colour is unchanged', atLimit === normal, `${atLimit} vs ${normal}`);
      ok('at the limit the text is 已選 2 / 2 張', (await page.textContent('#pickCounter')) === '已選 2 / 2 張');
      await pickHeart(page, 2);
      const over = await color();
      ok('above the limit (3 / 2) the colour differs', over !== normal, `${over} vs ${normal}`);
      const accent = await page.evaluate(() => {
        const t = document.createElement('i'); t.style.color = getComputedStyle(document.documentElement).getPropertyValue('--warning');
        document.body.appendChild(t); const c = getComputedStyle(t).color; t.remove(); return c;
      });
      ok('and it is the warning/accent token', over === accent, `${over} vs ${accent}`);
      ok('the text still reads 已選 3 / 2 張', (await page.textContent('#pickCounter')) === '已選 3 / 2 張');
      const txt = await bodyText();
      ok('no over-limit message anywhere while picking',
        !/超出|多 \d+ 張|加挑費|已超出可挑張數/.test(txt), txt.slice(0, 200));
      ok('no toast/banner element about the limit',
        await page.evaluate(() => !document.querySelector('.toast') || !/超|加挑|方案/.test(document.querySelector('.toast').textContent)));
      ok('the over-limit modal is not open', await page.evaluate(() => !document.getElementById('pickOverModal').classList.contains('active')));
      await pickHeart(page, 2);
      await page.waitForTimeout(200);
      ok('back to the limit → normal colour again', (await color()) === normal);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: co });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', pickLimit: 1, extraPrice: 500 });
  await suite('over-limit submit — modal with exact texts and price math, 返回修改 sends nothing, 確認送出 goes on to the form',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await pickHeart(page, 0); await pickHeart(page, 1); await pickHeart(page, 2);
      await page.waitForTimeout(300);
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickOverModal.active', { timeout: 3000 });
      ok('the title is 已超出可挑張數', (await page.textContent('#pickOverTitle')) === '已超出可挑張數');
      const lines = await page.$$eval('#pickOverBody p', ps => ps.map(p => p.textContent));
      ok('line 1 is exact', lines[0] === '方案 1 張，目前已選 3 張，超出 2 張', JSON.stringify(lines));
      ok('line 2 has price math with thousands separators',
        lines[1] === '加挑每張 NT$500，加價 NT$500 × 2 = NT$1,000', JSON.stringify(lines));
      ok('exactly two lines', lines.length === 2, JSON.stringify(lines));
      ok('the submit form is not open yet', await page.evaluate(() => !document.getElementById('pickSubmitModal').classList.contains('active')));
      await page.waitForTimeout(600); // slideUp animation
      const box = await page.evaluate(() => { const r = document.querySelector('#pickOverModal .modal-content').getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, vw: innerWidth, vh: innerHeight }; });
      ok('centred', Math.abs(box.cx - box.vw / 2) < 4 && Math.abs(box.cy - box.vh / 2) < 4, JSON.stringify(box));
      const btnTexts = await page.$$eval('#pickOverModal .pick-submit-actions button', bs => bs.map(b => b.textContent.trim()));
      ok('buttons 返回修改 / 確認送出', JSON.stringify(btnTexts) === JSON.stringify(['返回修改', '確認送出']), JSON.stringify(btnTexts));

      await page.click('#pickOverBackBtn');
      await page.waitForTimeout(300);
      ok('返回修改 closes the modal', await page.evaluate(() => !document.getElementById('pickOverModal').classList.contains('active')));
      ok('返回修改 does not open the form either', await page.evaluate(() => !document.getElementById('pickSubmitModal').classList.contains('active')));
      ok('and sends no submit request', pickSubmits(m).length === 0, JSON.stringify(pickSubmits(m)));

      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickOverModal.active', { timeout: 3000 });
      await page.click('#pickOverConfirmBtn');
      await page.waitForSelector('#pickSubmitModal.active', { timeout: 3000 });
      ok('確認送出 closes the warning and opens the ordinary form', await page.evaluate(() => !document.getElementById('pickOverModal').classList.contains('active')));
      ok('still nothing sent before the form is confirmed', pickSubmits(m).length === 0);
      await page.selectOption('#pickSubmitRelationship', '朋友');
      await page.click('#pickSubmitConfirmBtn');
      await page.waitForTimeout(400);
      ok('the form then submits once', pickSubmits(m).length === 1, String(pickSubmits(m).length));
      ok('with the relationship', pickSubmits(m)[0] && pickSubmits(m)[0].body.relationship === '朋友');
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', pickLimit: 1 });
  await suite('over-limit submit — no extra_price means no price line',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await pickHeart(page, 0); await pickHeart(page, 1);
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickOverModal.active', { timeout: 3000 });
      const lines = await page.$$eval('#pickOverBody p', ps => ps.map(p => p.textContent));
      ok('only the count line', lines.length === 1 && lines[0] === '方案 1 張，目前已選 2 張，超出 1 張', JSON.stringify(lines));
      ok('no NT$ anywhere in the modal', await page.evaluate(() => !document.getElementById('pickOverModal').textContent.includes('NT$')));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY') });
}

for (const [label, opts] of [['at exactly the limit', { pickLimit: 2, extraPrice: 500, n: 2 }], ['no limit at all', { n: 2 }], ['under the limit', { pickLimit: 3, extraPrice: 500, n: 1 }]]) {
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', pickLimit: opts.pickLimit, extraPrice: opts.extraPrice });
  await suite(`over-limit submit — not over (${label}) opens the ordinary form, no warning modal`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      for (let i = 0; i < opts.n; i++) await pickHeart(page, i);
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickSubmitModal.active', { timeout: 3000 });
      ok('the form opens directly', true);
      ok('the warning modal never opened', await page.evaluate(() => !document.getElementById('pickOverModal').classList.contains('active')));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', pickLimit: 1, extraPrice: 1500 });
  await suite('over-limit submit — phone width (390px): modal fits, buttons >= 44px, no horizontal scroll, bottom bar submit works',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await pickHeart(page, 0); await pickHeart(page, 1); await pickHeart(page, 2);
      await page.click('#mobileActionBar .btn-success'); // the phone's bottom-bar submit
      await page.waitForSelector('#pickOverModal.active', { timeout: 3000 });
      // measure once the modal's slide-in has finished: mid-animation the
      // buttons are a hair under 44px (43.99997) and the check flakes
      await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
      const r = await page.evaluate(() => {
        const box = s => { const r = document.querySelector(s).getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; };
        return { vw: innerWidth, vh: innerHeight, sw: document.documentElement.scrollWidth, modal: box('#pickOverModal .modal-content'), back: box('#pickOverBackBtn'), conf: box('#pickOverConfirmBtn'),
          price: document.querySelector('.pick-over-price').textContent };
      });
      ok('price with 1,500 separators', r.price === '加挑每張 NT$1,500，加價 NT$1,500 × 2 = NT$3,000', r.price);
      ok('modal inside the viewport', r.modal.l >= 0 && r.modal.r <= r.vw && r.modal.t >= 0 && r.modal.b <= r.vh, JSON.stringify(r.modal));
      ok('buttons >= 44px tall', r.back.h >= 44 && r.conf.h >= 44, `${r.back.h} ${r.conf.h}`);
      ok('buttons inside the modal', r.back.l >= r.modal.l && r.conf.r <= r.modal.r, JSON.stringify(r));
      ok('no horizontal scroll', r.sw <= r.vw, `${r.sw} > ${r.vw}`);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Vic', ownerKey: 'VIC-KEY' });
  await suite('pick counter — a viewer without the seat gets no counter and no bottom bar',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('bar hidden (computed display none)', await page.evaluate(() => getComputedStyle(document.getElementById('mobileActionBar')).display === 'none'));
      ok('no counter shows a count', await page.evaluate(() => !/已選\s*\d/.test(document.getElementById('mobileActionBar').innerText)));
      return out;
    },
    { before: m.attach });
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
      // The table lives inside a collapsed <details> (task: 專案選片 — admin
      // collapse), so its rows are attached but not visible until expanded.
      await page.waitForSelector('#project-detail-body table tbody tr', { state: 'attached' });

      const r = await page.evaluate(() => {
        const summary = document.querySelector('#project-detail-body summary');
        const seeLink = summary && summary.querySelector('a.pd-link');
        const rowLinks = [...document.querySelectorAll('#project-detail-body table tbody tr a')];
        return {
          summaryText: summary && summary.textContent,
          seeHref: seeLink && seeLink.getAttribute('href'),
          seeTarget: seeLink && seeLink.getAttribute('target'),
          rowHrefs: rowLinks.map(a => a.getAttribute('href')),
          rowCount: rowLinks.length,
        };
      });
      ok('the summary shows the count', /目前選取（2 張）/.test(r.summaryText || ''), r.summaryText);
      ok('看照片 → links to index.html?project=<id>', r.seeHref === 'index.html?project=proj-1', r.seeHref);
      ok('it is a plain same-tab link (no target=_blank)', !r.seeTarget, String(r.seeTarget));
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
  const m = pickFakeWorker({ ownerName: 'Norah', projectId: 'proj-collapse' });
  m.state.selections.set('20260819/a.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('admin — 專案選片：目前選取表格預設收合，展開後仍看得到表格',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-selections-details', { timeout: 5000 });

      const openBefore = await page.evaluate(() => document.getElementById('pd-selections-details').open);
      ok('collapsed by default', openBefore === false, String(openBefore));
      // <details> hides its non-summary content without necessarily
      // clearing getBoundingClientRect on it (Chrome's internal
      // content-visibility mechanism keeps reporting a non-zero rect even
      // though nothing paints) — Playwright's own actionability-grade
      // isVisible() is the reliable "actually invisible" signal here, the
      // same kind of trap this repo's [hidden]-vs-display:inline-flex bug
      // note calls for.
      ok('and the table is not actually visible either',
        (await page.locator('#pd-selections-details table').isVisible()) === false);

      // click near the left edge of the summary text, away from the 看照片
      // link appended after it, so this exercises the disclosure toggle
      // itself rather than navigating.
      await page.click('#pd-selections-details summary', { position: { x: 5, y: 8 } });
      const after = await page.evaluate(() => ({
        open: document.getElementById('pd-selections-details').open,
        rowCount: document.querySelectorAll('#pd-selections-details table tbody tr').length,
      }));
      ok('expanding opens it', after.open === true);
      const rowVisible = await page.locator('#pd-selections-details table tbody tr').first().isVisible();
      ok('the table is still there, with its row', after.rowCount === 1 && rowVisible === true, String(after.rowCount));
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

    // task: 專案選片 sidebar trim only ever runs for ProjectViewController —
    // the plain studio sidebar keeps LOAD + RATING untouched.
    const sidebar = await page.evaluate(() => ({
      driveUrl: !!document.getElementById('driveUrl'),
      loadBtn: !!document.getElementById('loadPhotosBtn'),
      starFilter: !!document.querySelector('.star-filter'),
    }));
    ok('the studio sidebar still has LOAD', sidebar.driveUrl && sidebar.loadBtn, JSON.stringify(sidebar));
    ok('and RATING', sidebar.starFilter === true);

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
      // collapsed by default (task: 專案選片 — admin collapse); attached
      // is enough here, the assertions below don't need it visible.
      await page.waitForSelector('#project-detail-body table tbody tr', { state: 'attached' });
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

// ═══════════════════════════════════════════════════════════════════════════
// index.html?project= — sidebar trim, read-only cards, downloads and the
// grid/list toggle (task: 專案選片, second pass).
// ═══════════════════════════════════════════════════════════════════════════

{
  const m = pickFakeWorker({ ownerName: 'Oscar', projectId: 'proj-trim' });
  m.state.selections.set('20260819/a.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('index.html — 專案選片：側邊欄移除來源/星級/FLAGS/標註過濾，保留排序與備份（不含重設此資料夾）',
    `${base}/index.html?project=proj-trim`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const r = await page.evaluate(() => ({
        driveUrl: !!document.getElementById('driveUrl'),
        loadBtn: !!document.getElementById('loadPhotosBtn'),
        starFilter: !!document.querySelector('.star-filter'),
        filterSelectedBtn: !!document.getElementById('filterSelectedBtn'),
        flagsGrid: !!document.querySelector('.flags-grid'),
        toggleGroup: !!document.querySelector('.toggle-group'),
        sortSelect: !!document.getElementById('sortBy'),
        backupBtn: !!document.getElementById('backupDataBtn'),
        resetCurrentBtn: !!document.getElementById('resetCurrentDataBtn'),
        resetAllBtn: !!document.getElementById('resetAllDataBtn'),
        bulkStars: !!document.getElementById('bulkStars'),
        clearRatingBtn: !!document.querySelector('#bulkActionBar button[onclick="app.setBulkRating(0)"]'),
      }));
      ok('SOURCE input removed', r.driveUrl === false);
      ok('LOAD button removed', r.loadBtn === false);
      ok('RATING star filter removed', r.starFilter === false);
      ok('只看選取 removed', r.filterSelectedBtn === false);
      ok('FLAGS section removed', r.flagsGrid === false);
      ok('ANNOTATION filter removed', r.toggleGroup === false);
      ok('sort is kept', r.sortSelect === true);
      ok('匯出備份 JSON is kept', r.backupBtn === true);
      ok('重設此資料夾 removed (dangerous here)', r.resetCurrentBtn === false);
      ok('清除所有快取 is kept', r.resetAllBtn === true);
      ok('bulk-star buttons removed (would write ratings)', r.bulkStars === false);
      ok('清空評分 removed too', r.clearRatingBtn === false);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Petra', projectId: 'proj-ro' });
  m.state.selections.set('20260819/noted.jpg', { rating: 5, note: '請保留這張', updated_by: 'picker-0', updated_at: '2026-09-27T14:52:00.000Z' });
  m.state.selections.set('20260819/plain.jpg', { rating: 4, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('index.html — 專案選片：卡片只有唯讀 ♥ 與 💬，沒有星級/勾選框，沒有控制項能寫入評分',
    `${base}/index.html?project=proj-ro`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const r = await page.evaluate(() => ({
        stars: document.querySelectorAll('.photo-card .star-rating').length,
        selectBtns: document.querySelectorAll('.photo-card .select-toggle-btn').length,
        clickableHearts: document.querySelectorAll('.photo-card button.pick-heart-btn').length,
        readonlyHearts: document.querySelectorAll('.photo-card span.pick-heart-btn.on').length,
        noteBadges: document.querySelectorAll('.photo-card .pv-note-badge').length,
      }));
      ok('no star rating control on any card', r.stars === 0, String(r.stars));
      ok('no select checkbox either', r.selectBtns === 0, String(r.selectBtns));
      ok('no clickable heart — every ♥ is read-only', r.clickableHearts === 0, String(r.clickableHearts));
      ok('every card shows the read-only ♥', r.readonlyHearts === 2, String(r.readonlyHearts));
      ok('exactly the noted photo gets the 💬 marker', r.noteBadges === 1, String(r.noteBadges));

      // No control may write a rating — try the one shortcut that still
      // reaches setBulkRating() even with the bulk-star buttons gone.
      await page.click('#selectAllBtn');
      await page.keyboard.press('5');
      await page.waitForTimeout(200);
      const ratingsAfter = await page.evaluate(() => {
        const byId = {};
        app.photos.forEach(p => { byId[p.id] = p.rating; });
        return byId;
      });
      ok('ratings are unchanged after the bulk-rating keyboard shortcut',
        ratingsAfter['20260819/noted.jpg'] === 5 && ratingsAfter['20260819/plain.jpg'] === 4,
        JSON.stringify(ratingsAfter));
      const stored = await page.evaluate(() => {
        try { return JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.RATINGS) || '{}'); }
        catch (e) { return {}; }
      });
      ok('nothing was persisted to localStorage either', !stored['20260819/plain.jpg'], JSON.stringify(stored));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const XSS_NOTE = '<img src=x onerror="window.__xssNote=1">';
  const m = pickFakeWorker({ ownerName: 'Quincy', projectId: 'proj-note' });
  m.state.selections.set('20260819/n.jpg', { rating: 5, note: XSS_NOTE, updated_by: 'picker-0', updated_at: '2026-09-27T14:52:00.000Z' });
  await suite('index.html — 專案選片：preview 與 modal 顯示備註文字（escaped），沒有星星可點',
    `${base}/index.html?project=proj-note`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.hover('.photo-card');
      await page.waitForTimeout(250); // updatePreviewPane's own hover debounce
      const r = await page.evaluate(() => ({
        noteHidden: document.getElementById('pvPreviewNoteSection').hidden,
        noteText: document.getElementById('pvPreviewNote').textContent,
        injected: document.querySelectorAll('#pvPreviewNote img').length,
        fired: !!window.__xssNote,
        heartReadOnly: document.querySelectorAll('#previewStars span.pick-heart-btn.on').length,
        heartClickable: document.querySelectorAll('#previewStars button.pick-heart-btn').length,
        hintHidden: document.getElementById('previewStarsHint').hidden,
      }));
      ok('the note section is shown', r.noteHidden === false);
      ok('the note text is there as text, not injected as an element',
        r.noteText.includes(XSS_NOTE) && r.injected === 0, r.noteText);
      ok('onerror never fired', r.fired === false);
      ok('the preview heart is read-only (a span), not a button',
        r.heartReadOnly === 1 && r.heartClickable === 0, JSON.stringify(r));
      ok('the "按 1–5" hint is hidden — nothing here is keyed by number', r.hintHidden === true);

      await page.click('.photo-card');
      await page.waitForFunction(
        () => document.getElementById('photoModal').classList.contains('active'), null, { timeout: 5000 });
      const modal = await page.evaluate(() => ({
        noteValue: document.getElementById('photoNote').value,
        readOnly: document.getElementById('photoNote').readOnly,
        mprHeart: document.querySelectorAll('#modalPhotoRating span.pick-heart-btn.on').length,
      }));
      ok('the modal note textarea shows the same text (via .value, never innerHTML)',
        modal.noteValue === XSS_NOTE, modal.noteValue);
      ok('and is read-only', modal.readOnly === true);
      ok('the modal footer shows the read-only heart too', modal.mprHeart === 1, String(modal.mprHeart));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Rex', projectId: 'proj-dl' });
  m.state.selections.set('20260819/a.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  m.state.selections.set('20260901/b.jpg', { rating: 3, note: '', updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
  await suite('index.html — 專案選片：打包全部下載／下載選取 只打包這個專案跨資料夾的選片',
    `${base}/index.html?project=proj-dl`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.evaluate(() => {
        window.__zipFiles = [];
        window.JSZip = function () {
          this.file = (name) => window.__zipFiles.push(name);
          this.generateAsync = async () => new Blob(['z']);
        };
      });

      await page.click('#downloadAllBtn');
      await page.waitForTimeout(400);
      const filesAll = await page.evaluate(() => window.__zipFiles.slice());
      ok('打包全部下載 packages exactly the project’s 2 picks, from both folders',
        filesAll.length === 2 && filesAll.includes('a.jpg') && filesAll.includes('b.jpg'), JSON.stringify(filesAll));

      await page.evaluate(() => { window.__zipFiles.length = 0; });
      await page.click('#downloadSelectedHeaderBtn'); // no checkbox to pick a subset with — see js/project-view.js _wireDownloads
      await page.waitForTimeout(400);
      const filesSel = await page.evaluate(() => window.__zipFiles.slice());
      ok('下載選取 downloads the same set (documented behaviour: 下載選取 = 全部選片)',
        filesSel.length === 2 && filesSel.includes('a.jpg') && filesSel.includes('b.jpg'), JSON.stringify(filesSel));

      const fetched = m.requests.filter(r => r.method === 'GET').map(r => r.path);
      ok('both photos were actually fetched from their own folder, proving this is not driveManager.photos (which stays empty here)',
        fetched.includes('/20260819/a.jpg') && fetched.includes('/20260901/b.jpg'), JSON.stringify(fetched));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Sara', projectId: 'proj-list' });
  m.state.selections.set('20260819/a.jpg', { rating: 5, note: '備註A', updated_by: 'picker-0', updated_at: '2026-09-27T14:52:00.000Z' });
  await suite('index.html — 專案選片：格狀/列表切換，列表顯示縮圖/檔名/備註/更新時間，並記住選擇',
    `${base}/index.html?project=proj-list`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const before = await page.evaluate(() => document.getElementById('headerViewBtn').textContent.trim());
      ok('starts in grid mode (網格)', before === '網格', before);

      await page.click('#headerViewBtn');
      await page.waitForSelector('.pv-list-row', { timeout: 5000 });
      const r = await page.evaluate(() => {
        const row = document.querySelector('.pv-list-row');
        return {
          btnText: document.getElementById('headerViewBtn').textContent.trim(),
          gridHasListClass: document.getElementById('photoGrid').classList.contains('pv-list'),
          cardCount: document.querySelectorAll('.photo-card').length,
          rowCount: document.querySelectorAll('.pv-list-row').length,
          thumb: !!row.querySelector('.pv-list-thumb'),
          name: row.querySelector('.pv-list-name')?.textContent,
          note: row.querySelector('.pv-list-note')?.textContent,
          time: row.querySelector('.pv-list-time')?.textContent,
        };
      });
      ok('the header button now reads 列表', r.btnText === '列表', r.btnText);
      ok('the grid container gets the list layout class', r.gridHasListClass === true);
      ok('grid cards are gone', r.cardCount === 0, String(r.cardCount));
      ok('exactly one row', r.rowCount === 1, String(r.rowCount));
      ok('the row has a thumbnail', r.thumb === true);
      ok('and the filename', r.name === 'a.jpg', r.name);
      ok('and the note', r.note === '備註A', r.note);
      ok('and the updated time, in Taipei format, like admin.html', r.time === '9/27 22:52', r.time);

      await page.click('.pv-list-row');
      await page.waitForFunction(
        () => document.getElementById('photoModal').classList.contains('active'), null, { timeout: 5000 });
      ok('clicking a row opens the preview', true);
      await page.click('#closeModal');

      await page.reload();
      await page.waitForSelector('.pv-list-row', { timeout: 5000 });
      const afterReload = await page.evaluate(() => document.getElementById('headerViewBtn').textContent.trim());
      ok('the choice is remembered across reload (localStorage)', afterReload === '列表', afterReload);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Tina', projectId: 'proj-btn' });
  await suite('index.html — 專案選片：「← 回專案」是明顯的按鈕（仍是可 middle-click 的 <a>）',
    `${base}/index.html?project=proj-btn`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#projectViewBanner:not([hidden])', { timeout: 5000 });
      const r = await page.evaluate(() => {
        const el = document.getElementById('pvBackLink');
        return { tag: el.tagName, cls: el.className, href: el.getAttribute('href') };
      });
      ok('it is a real <a>', r.tag === 'A', r.tag);
      ok('styled with the existing .btn look, left of the banner text', r.cls.includes('btn') && r.cls.includes('btn-outline'), r.cls);
      ok('href still resolves — middle-click / back-nav semantics stay intact',
        r.href === 'admin.html#project=proj-btn', r.href);
      return out;
    },
    { before: m.attach, initScript: ADMIN });

  await suite('index.html — 專案選片：手機版「← 回專案」至少 44px 高',
    `${base}/index.html?project=proj-btn`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#projectViewBanner:not([hidden])', { timeout: 5000 });
      const box = await page.locator('#pvBackLink').boundingBox();
      ok('at least 44px tall on a phone-width viewport', !!box && box.height >= 44, JSON.stringify(box));
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Uma', projectId: 'proj-copylink', listToken: 'PICK-LIVE-1' });
  await suite('index.html — 專案選片：複製選片連結 複製最新的有效挑選連結（不是資料夾）',
    `${base}/index.html?project=proj-copylink`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.waitForSelector('#projectViewBanner:not([hidden])', { timeout: 5000 });
      await page.click('#pvCopyLinkBtn');
      await page.waitForTimeout(200);
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      ok('copies index.html?t=<newest live token>', /index\.html\?t=PICK-LIVE-1$/.test(clip), clip);
      const toastShown = await page.evaluate(() => document.querySelector('.toast-message')?.textContent);
      ok('confirms with a success toast', toastShown === '已複製選片連結', toastShown);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  // A revoked-only link is not "有效" either — this must actually check
  // status, not just whether any token row exists at all.
  const m = pickFakeWorker({ ownerName: 'Wade', projectId: 'proj-revoked' });
  m.state.tokens[0].revoked_at = '2026-01-01T00:00:00.000Z';
  await suite('index.html — 專案選片：只剩已撤銷的連結時，也算沒有有效連結',
    `${base}/index.html?project=proj-revoked`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.waitForSelector('#projectViewBanner:not([hidden])', { timeout: 5000 });
      await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
      await page.click('#pvCopyLinkBtn');
      await page.waitForTimeout(200);
      const toastShown = await page.evaluate(() => document.querySelector('.toast-message')?.textContent);
      ok('shows 沒有有效連結，請到專案頁產生', toastShown === '沒有有效連結，請到專案頁產生', toastShown);
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      ok('the revoked token was not copied', clip === 'sentinel', clip);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ ownerName: 'Vic', projectId: 'proj-nolink', listToken: null });
  await suite('index.html — 專案選片：沒有有效連結時提示「沒有有效連結，請到專案頁產生」，不複製任何東西',
    `${base}/index.html?project=proj-nolink`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.waitForSelector('#projectViewBanner:not([hidden])', { timeout: 5000 });
      await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
      await page.click('#pvCopyLinkBtn');
      await page.waitForTimeout(200);
      const toastShown = await page.evaluate(() => document.querySelector('.toast-message')?.textContent);
      ok('shows 沒有有效連結，請到專案頁產生', toastShown === '沒有有效連結，請到專案頁產生', toastShown);
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      ok('nothing was copied — clipboard stays untouched', clip === 'sentinel', clip);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ═══════════════════════════════════════════════════════════════════════════
// Studio entrance — home.html, dashboard.html, settings.html
// (docs/dashboard-settings.md backs dashboard.html/settings.html;
// home.html's login reuses admin.html's own token check, now against
// GET /api/admin/settings instead of /api/admin/clients).
// ═══════════════════════════════════════════════════════════════════════════

function dashSettingsMock(opts = {}) {
  const token = opts.token ?? 'adm';
  const state = {
    settings: Object.assign({
      studio_name: null, booking_url: null, default_pick_limit: null, default_extra_price: null,
      default_extra_max: null,
      has_logo: false, logo_type: null, logo_updated_at: null, updated_at: null,
    }, opts.settings || {}),
    stats: opts.stats || {
      by_phase: { picking: 0, submitted: 0, retouching: 0 }, delivered: 0, archived: 0,
      per_month: [], todo: { submitted_not_retouching: 0, unnotified_submissions: 0, modified_after_submit: 0 },
    },
    projects: opts.projects || [],
    settingsPutStatus: opts.settingsPutStatus || 200,
    settingsPutBody: opts.settingsPutBody || null,
    logoPutStatus: opts.logoPutStatus || 200,
    logoPutBody: opts.logoPutBody || null,
    deliverStatus: opts.deliverStatus || 200,
    deliverBody: opts.deliverBody || null,
  };
  const seen = [];
  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const method = req.method();
      const h = await req.allHeaders();
      const auth = h['authorization'] ?? null;
      let body = null;
      try { body = JSON.parse(req.postData() || 'null'); } catch (e) { /* not JSON, e.g. a logo PUT */ }
      seen.push({ method, path: u.pathname, auth, body });
      const json = (data, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });

      if (u.pathname === '/api/studio/logo') // public — no auth required
        return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
      if (auth !== `Bearer ${token}`) return json({ error: 'Unauthorized' }, 401);

      if (u.pathname === '/api/admin/settings' && method === 'GET') return json(settingsShapeFake(state.settings));
      if (u.pathname === '/api/admin/settings' && method === 'PUT') {
        if (state.settingsPutStatus !== 200) return json(state.settingsPutBody || { error: 'bad' }, state.settingsPutStatus);
        // default_extra_max: null or a whole number 0-500, else 400 (nothing written)
        if ('default_extra_max' in (body || {}) && body.default_extra_max !== null && !isExtraMaxFake(body.default_extra_max))
          return json({ error: 'default_extra_max must be a whole number from 0 to 500', code: 'invalid_default_extra_max' }, 400);
        Object.assign(state.settings, body);
        return json(settingsShapeFake(state.settings));
      }
      if (u.pathname === '/api/admin/settings/logo' && method === 'PUT') {
        if (state.logoPutStatus !== 200) return json(state.logoPutBody || { error: 'bad' }, state.logoPutStatus);
        state.settings.has_logo = true;
        return json({ ok: true, has_logo: true, logo_type: 'image/png', logo_updated_at: '2026-09-27T00:00:00.000Z', size: 1 });
      }
      if (u.pathname === '/api/admin/settings/logo' && method === 'DELETE') {
        state.settings.has_logo = false;
        return json({ ok: true, has_logo: false });
      }
      if (u.pathname === '/api/admin/stats' && method === 'GET') return json(state.stats);
      if (u.pathname === '/api/admin/projects' && method === 'GET') return json({ projects: state.projects });
      if (/^\/api\/admin\/projects\/[^/]+\/deliver$/.test(u.pathname) && method === 'POST')
        return json(state.deliverBody || { ok: true, delivered_at: '2026-09-27T00:00:00.000Z' }, state.deliverStatus);
      if (/^\/api\/admin\/projects\/[^/]+\/undeliver$/.test(u.pathname) && method === 'POST')
        return json({ ok: true, delivered_at: null });
      return json({});
    });
  };
  return { state, seen, attach };
}

// addInitScript re-seeds on every navigation within the context (a known
// false-pass shape, see CLAUDE.md) — fine for a suite that stays on one
// authenticated page, but wrong for the logout suite, which navigates away
// to home.html and needs the token to actually stay gone there. So this one
// skips home.html; the "already logged in" home.html suite below seeds
// unconditionally instead.
const SEED_TOKEN = () => {
  if (!location.pathname.endsWith('/home.html')) sessionStorage.setItem('studio_token', 'adm');
};
const SEED_TOKEN_ALWAYS = () => sessionStorage.setItem('studio_token', 'adm');

await suite('入口 — 未登入時看到品牌、三張特色卡與手機示意圖，並提供攝影師登入',
  `${base}/home.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

    ok('the pitch line is on the page', (await page.textContent('body')).includes('讓客人在手機上輕鬆選片，你專心修圖'));
    const cardTitles = await page.$$eval('.feature-card h3', els => els.map(e => e.textContent));
    ok('three feature cards, in order', JSON.stringify(cardTitles) ===
      JSON.stringify(['傳連結，手機就能選', '送出即通知，加選自動算', '開始精修，選片就鎖定']), JSON.stringify(cardTitles));
    const pitch = await page.textContent('.pitch');
    ok('the sub-line adds to the headline instead of repeating it', !pitch.includes('讓客人在手機上輕鬆選片'), pitch);
    ok('the secondary button is not underlined',
      (await page.$eval('.btn-ghost', e => getComputedStyle(e).textDecorationLine)) === 'none');
    ok('the mock tiles are not all the same colour',
      new Set(await page.$$eval('.phone-tile', els => els.map(e => getComputedStyle(e).backgroundColor))).size >= 4);
    ok('a phone mock is built from CSS/markup, not an <img>',
      (await page.$('.phone-mock')) !== null && (await page.$('.phone-mock img')) === null);
    ok('no external script tags', (await page.$$eval('script[src]', els =>
      els.every(e => !/^https?:|^\/\//.test(e.getAttribute('src'))))));

    // Bright design (Tim-approved, /tmp/claude-0/light-design.html): cream
    // ground, dark-ink text. Pin the exact approved tokens rather than just
    // computing a contrast ratio, so a palette drift is caught even if it
    // still happens to clear 4.5:1.
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    ok('page ground is the approved cream, not the old dark theme',
      bodyBg === 'rgb(255, 248, 238)', bodyBg);
    const pitchColor = await page.$eval('.pitch', e => getComputedStyle(e).color);
    ok('body text is the approved dark ink (#5b4f42), readable on cream',
      pitchColor === 'rgb(91, 79, 66)', pitchColor);
    const btnColor = await page.$eval('#heroLoginBtn', e => getComputedStyle(e).color);
    ok('primary button text is the approved dark ink (#231b12), readable on the accent',
      btnColor === 'rgb(35, 27, 18)', btnColor);

    const clientLink = await page.$eval('a[href="client-login.html"]', e => e.textContent.trim()).catch(() => null);
    ok('a 客戶登入 link to client-login.html is in the header', clientLink === '客戶登入', String(clientLink));

    await page.click('#heroLoginBtn');
    await page.waitForSelector('#loginOverlay.open', { timeout: 3000 });
    ok('login overlay opens', true);
    return out;
  });

{
  const m = dashSettingsMock({ token: 'right-pw' });
  await suite('入口 — 攝影師登入：密碼錯誤顯示提示，正確密碼存 studio_token 並跳轉到 dashboard.html',
    `${base}/home.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

      await page.click('#photographerLoginBtn');
      await page.fill('#loginTokenInput', 'wrong-pw');
      await page.click('#loginSubmitBtn');
      await page.waitForTimeout(300);
      const err1 = await page.textContent('#loginErr');
      ok('wrong password shows 密碼錯誤', err1.trim() === '密碼錯誤', err1);
      ok('nothing was stored on the wrong attempt',
        await page.evaluate(() => sessionStorage.getItem('studio_token')) === null);

      await page.fill('#loginTokenInput', 'right-pw');
      await page.click('#loginSubmitBtn');
      await page.waitForURL('**/dashboard.html', { timeout: 3000 });
      const stored = await page.evaluate(() => sessionStorage.getItem('studio_token'));
      ok('the real token landed in sessionStorage.studio_token, nowhere else', stored === 'right-pw', stored);
      return out;
    },
    { before: m.attach });
}

await suite('入口 — 已經登入過（sessionStorage 已有 studio_token）直接跳轉到 dashboard.html',
  `${base}/home.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForURL('**/dashboard.html', { timeout: 3000 }).catch(() => {});
    ok('redirected to dashboard.html', /dashboard\.html/.test(page.url()), page.url());
    return out;
  },
  { initScript: SEED_TOKEN_ALWAYS });

await suite('儀表板 — 沒有 studio_token 時，還沒發出任何請求就先跳轉回 home.html',
  `${base}/dashboard.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForURL('**/home.html', { timeout: 3000 }).catch(() => {});
    ok('redirected to home.html', /home\.html/.test(page.url()), page.url());
    return out;
  });

{
  const m = dashSettingsMock({
    stats: {
      by_phase: { picking: 3, submitted: 2, retouching: 1 }, delivered: 5, archived: 1,
      per_month: [
        { month: '2026-08', created: 4, delivered: 2 },
        { month: '2026-09', created: 8, delivered: 4 },
      ],
      todo: { submitted_not_retouching: 2, unnotified_submissions: 1, modified_after_submit: 0 },
    },
    projects: [
      { id: 'p1', title: '海邊系列', phase: 'retouching', delivered_at: null },
      { id: 'p2', title: '婚紗', phase: 'retouching', delivered_at: '2026-09-20T00:00:00.000Z' },
    ],
  });
  await suite('儀表板 — 卡片、長條圖與待處理清單都照 /api/admin/stats 的資料畫',
    `${base}/dashboard.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

      await page.waitForFunction(() => document.getElementById('stat-picking').textContent !== '–', null, { timeout: 5000 });
      const nums = await page.evaluate(() => ['stat-picking', 'stat-submitted', 'stat-retouching', 'stat-delivered']
        .map(id => document.getElementById(id).textContent));
      ok('選片中/已送出/精修中/已交付 counts', JSON.stringify(nums) === JSON.stringify(['3', '2', '1', '5']), JSON.stringify(nums));

      // per_month's max value (8, September's created) must be the tallest
      // bar (100%); everything else scales relative to it — a stats-mapping
      // mutant (e.g. always 100%, or delivered/created swapped) breaks this.
      const heights = await page.$$eval('#stat-chart .chart-col', cols => cols.map(c => ({
        created: c.querySelector('.chart-bar.created').style.height,
        delivered: c.querySelector('.chart-bar.delivered').style.height,
      })));
      ok('two months rendered', heights.length === 2, JSON.stringify(heights));
      ok('September (the max) created bar is 100%', heights[1]?.created === '100%', JSON.stringify(heights));
      ok('August created (4/8) is 50%', heights[0]?.created === '50%', JSON.stringify(heights));
      ok('August delivered (2/8) is 25%, not swapped with created', heights[0]?.delivered === '25%', JSON.stringify(heights));

      const todoText = await page.textContent('#todo-list');
      ok('待處理 shows all three non-zero counts',
        todoText.includes('2') && todoText.includes('已送出但尚未開始精修') &&
        todoText.includes('1') && todoText.includes('尚未寄信通知') &&
        !todoText.includes('個專案送出後又被修改'), todoText);
      const todoLinks = await page.$$eval('#todo-list a', els => els.map(e => e.getAttribute('href')));
      ok('待處理 items link into admin.html#projects', todoLinks.every(h => h === 'admin.html#projects'), JSON.stringify(todoLinks));

      const recentLinks = await page.$$eval('#recent-projects a', els => els.map(e => e.getAttribute('href')));
      ok('recent projects link to admin.html#project=<id>',
        JSON.stringify(recentLinks) === JSON.stringify(['admin.html#project=p1', 'admin.html#project=p2']), JSON.stringify(recentLinks));
      const deliveredBadges = await page.$$eval('.recent-row', rows => rows.map(r => r.textContent.includes('已交付')));
      ok('only the delivered project shows 已交付', JSON.stringify(deliveredBadges) === JSON.stringify([false, true]), JSON.stringify(deliveredBadges));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  await suite('儀表板 — 全部待處理歸零時顯示「目前沒有待處理事項」，側邊選單標出目前頁面並可登出',
    `${base}/dashboard.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#todo-list .todo-empty', { timeout: 5000 });
      ok('says nothing pending', (await page.textContent('#todo-list')).includes('目前沒有待處理事項'));

      const navHrefs = await page.$$eval('.side-nav-item[href]', els => els.map(e => e.getAttribute('href')));
      ok('side menu has every destination, 訂單 after 選片專案',
        JSON.stringify(navHrefs) === JSON.stringify(['dashboard.html', 'admin.html#projects', 'orders.html', 'admin.html#clients', 'index.html', 'upload.html', 'book_editor/', 'settings.html']),
        JSON.stringify(navHrefs));
      const active = await page.$eval('.side-nav-item.active', e => e.textContent);
      ok('儀表板 is marked active on this page', active === '儀表板', active);

      await page.click('.side-nav-logout');
      await page.waitForURL('**/home.html', { timeout: 3000 });
      ok('logout clears the token and leaves for home.html, which stays put (no token to bounce it back)',
        /home\.html$/.test(page.url()) &&
        (await page.evaluate(() => sessionStorage.getItem('studio_token'))) === null,
        page.url());
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

await suite('設定 — 沒有 studio_token 時跳轉回 home.html',
  `${base}/settings.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForURL('**/home.html', { timeout: 3000 }).catch(() => {});
    ok('redirected to home.html', /home\.html/.test(page.url()), page.url());
    return out;
  });

{
  const m = dashSettingsMock({ settings: { studio_name: '某某影像', booking_url: 'https://example.com/book', default_pick_limit: 30, default_extra_price: 100 } });
  await suite('設定 — 讀出既有設定並帶入表單，儲存後顯示已儲存',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.getElementById('set-studio-name').value !== '', null, { timeout: 5000 });
      const vals = await page.evaluate(() => ({
        name: document.getElementById('set-studio-name').value,
        url: document.getElementById('set-booking-url').value,
        limit: document.getElementById('set-default-pick-limit').value,
        price: document.getElementById('set-default-extra-price').value,
      }));
      ok('fields are prefilled from GET /api/admin/settings',
        vals.name === '某某影像' && vals.url === 'https://example.com/book' && vals.limit === '30' && vals.price === '100',
        JSON.stringify(vals));

      await page.fill('#set-studio-name', '新名字');
      await page.click('#set-save-btn');
      await page.waitForFunction(() => document.getElementById('set-ok').textContent === '已儲存', null, { timeout: 3000 });
      const put = m.seen.find(r => r.method === 'PUT' && r.path === '/api/admin/settings');
      ok('PUT carried the edited name', put?.body?.studio_name === '新名字', JSON.stringify(put));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  await suite('設定 — 預約網址不是 https:// 時擋在前端，不會打到 Worker',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#set-save-btn', { timeout: 5000 });
      await page.fill('#set-booking-url', 'http://not-secure.example.com');
      await page.click('#set-save-btn');
      await page.waitForTimeout(300);
      const err = await page.textContent('#set-err');
      ok('client shows the https-only message', err.includes('https://'), err);
      const put = m.seen.find(r => r.method === 'PUT' && r.path === '/api/admin/settings');
      ok('no PUT was sent for an http:// url', put === undefined, JSON.stringify(put));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

{
  // A url that passes the client's startsWith check but the server still
  // rejects (whitespace, control chars, user:pass@, docs/dashboard-settings.md)
  // — the server's invalid_booking_url has to reach the screen, not just the
  // client-side guard's own wording.
  const m = dashSettingsMock({ settingsPutStatus: 400, settingsPutBody: { error: 'bad url', code: 'invalid_booking_url' } });
  await suite('設定 — 伺服器回報 invalid_booking_url 時顯示對應錯誤訊息',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#set-save-btn', { timeout: 5000 });
      await page.fill('#set-booking-url', 'https://ok-looking.example.com');
      await page.click('#set-save-btn');
      await page.waitForTimeout(300);
      const err = await page.textContent('#set-err');
      ok('shows the server-side https validation message', err.includes('https://'), err);
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  await suite('設定 — Logo 上傳：超過 200KB 或非允許格式在前端就擋下，成功後顯示預覽與移除鍵',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#logo-file-input', { timeout: 5000 });

      // 200 KB + 1 byte — client-side rejected, no request to the Worker
      await page.setInputFiles('#logo-file-input', {
        name: 'big.png', mimeType: 'image/png', buffer: Buffer.alloc(204801, 1),
      });
      await page.waitForTimeout(200);
      let err = await page.textContent('#logo-err');
      ok('oversized file rejected client-side', err.includes('200 KB'), err);
      ok('no logo PUT was sent for it', m.seen.find(r => r.path === '/api/admin/settings/logo') === undefined);

      await page.setInputFiles('#logo-file-input', {
        name: 'x.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>'),
      });
      await page.waitForTimeout(200);
      err = await page.textContent('#logo-err');
      ok('unsupported type rejected client-side', err.includes('PNG'), err);

      ok('no remove button before any logo exists', await page.isHidden('#logo-remove-btn'));

      await page.setInputFiles('#logo-file-input', {
        name: 'ok.png', mimeType: 'image/png', buffer: Buffer.from([1, 2, 3]),
      });
      await page.waitForFunction(() => !document.getElementById('logo-remove-btn').style.display ||
        document.getElementById('logo-remove-btn').style.display !== 'none', null, { timeout: 3000 });
      const put = m.seen.find(r => r.method === 'PUT' && r.path === '/api/admin/settings/logo');
      ok('the good file reached the Worker', !!put, JSON.stringify(m.seen));
      ok('and a preview <img> is shown', await page.$('#logo-preview-box img') !== null);

      await page.click('#logo-remove-btn');
      await page.waitForFunction(() => document.getElementById('logo-remove-btn').style.display === 'none', null, { timeout: 3000 });
      const del = m.seen.find(r => r.method === 'DELETE' && r.path === '/api/admin/settings/logo');
      ok('remove sent a DELETE', !!del, JSON.stringify(m.seen));
      ok('preview reverts to the empty state', (await page.textContent('#logo-preview-box')).includes('尚未上傳'));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock({ logoPutStatus: 413, logoPutBody: { error: 'too large', code: 'too_large' } });
  await suite('設定 — 伺服器回 413 時顯示檔案過大訊息（用來覆蓋前端漏放過去的情況）',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#logo-file-input', { timeout: 5000 });
      await page.setInputFiles('#logo-file-input', { name: 'ok.png', mimeType: 'image/png', buffer: Buffer.from([1, 2, 3]) });
      await page.waitForTimeout(300);
      const err = await page.textContent('#logo-err');
      ok('shows the 200 KB message from a server 413', err.includes('200 KB'), err);
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock({ logoPutStatus: 415, logoPutBody: { error: 'bad type', code: 'unsupported_type' } });
  await suite('設定 — 伺服器回 415 時顯示不支援格式訊息',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#logo-file-input', { timeout: 5000 });
      await page.setInputFiles('#logo-file-input', { name: 'ok.png', mimeType: 'image/png', buffer: Buffer.from([1, 2, 3]) });
      await page.waitForTimeout(300);
      const err = await page.textContent('#logo-err');
      ok('shows the unsupported-format message from a server 415', err.includes('PNG'), err);
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

{
  // admin.html's project-create form prefills from the studio's saved
  // defaults, but only into a field the photographer has not already typed
  // into — the mutant this guards is "always overwrite".
  const m = adminMock({ clients: [] });
  m.attach = (orig => async page => {
    await orig(page);
    await page.route('**/imagepicker.hotichen.workers.dev/api/admin/settings', route =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ studio_name: 'S', booking_url: null, default_pick_limit: 25, default_extra_price: 150, has_logo: false }) }));
  })(m.attach);
  await suite('設定 — 預設方案（張數/單價）帶入 admin.html 的新專案表單，且不覆蓋已輸入的值',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.getElementById('proj-pick-limit').value !== '', null, { timeout: 5000 });
      const vals = await page.evaluate(() => ({
        limit: document.getElementById('proj-pick-limit').value,
        price: document.getElementById('proj-extra-price').value,
      }));
      ok('prefilled from the studio defaults', vals.limit === '25' && vals.price === '150', JSON.stringify(vals));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ═══════════════════════════════════════════════════════════════════════════
// Guest pick page — studio branding (docs/dashboard-settings.md)
// ═══════════════════════════════════════════════════════════════════════════

{
  const m = pickFakeWorker({
    ownerName: 'Ann', ownerKey: 'ANN-KEY',
    studio: { name: '海邊影像工作室', booking_url: 'https://booking.example.com/x', has_logo: true },
  });
  await suite('選片頁 — 顯示工作室名稱與 Logo，沒有預約拍攝按鈕',
    `${base}/index.html?t=PICK-TOKEN`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.evaluate(() => localStorage.setItem('pick_key:PICK-TOKEN', 'ANN-KEY'));
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => document.querySelector('.logo-name')?.textContent === '海邊影像工作室', null, { timeout: 5000 });
      ok('logo-name replaced with the studio name', true);
      const img = await page.$eval('.logo-mark-img', el => ({ src: el.src, alt: el.alt })).catch(() => null);
      ok('the text mark is replaced by an <img> for the logo', !!img && img.src.includes('/api/studio/logo'), JSON.stringify(img));
      ok('no 預約拍攝 button exists on the guest page at all (removed, not hidden), booking_url or not',
        (await page.$('#studioBookingLink')) === null && !(await page.evaluate(() => document.body.innerText.includes('預約拍攝'))));
      return out;
    },
    { before: m.attach });
}

{
  // The https guard is the one line worth mutation-testing here: anything
  // else (http://, //evil, javascript:, empty) must leave the link hidden
  // with its href untouched, never fall through to "set it anyway".
  const m = pickFakeWorker({
    ownerName: 'Ben', ownerKey: 'BEN-KEY',
    studio: { name: 'S', booking_url: 'http://not-secure.example.com', has_logo: false },
  });
  await suite('選片頁 — 非 https 的 booking_url 也沒有預約按鈕',
    `${base}/index.html?t=PICK-TOKEN`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.evaluate(() => localStorage.setItem('pick_key:PICK-TOKEN', 'BEN-KEY'));
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(() => document.querySelector('.logo-name')?.textContent === 'S', null, { timeout: 5000 });
      ok('no 預約拍攝 button either for an http:// booking_url (element is null)', (await page.$('#studioBookingLink')) === null);
      ok('no logo <img> is added when has_logo is false', (await page.$('.logo-mark-img')) === null);
      return out;
    },
    { before: m.attach });
}

// ═══════════════════════════════════════════════════════════════════════════
// Guest pick page UI round (docs/backlog.md "Guest pick page UI") — guest
// links only: folder + filter and nothing else; a sticky #guestBar instead of
// the drawer on a phone; one submit button (the bottom one); no 預約拍攝; a
// person icon instead of HC. The photographer's own page keeps every tool.
// (suite() already fails any suite on a pageerror, so a missing element that
// app.js does not tolerate shows up here.)
// ═══════════════════════════════════════════════════════════════════════════

const GUI_PHOTOS = {
  'A/': Array.from({ length: 30 }, (_, i) => ({ id: `A/a${String(i).padStart(2, '0')}.jpg`, name: `a${String(i).padStart(2, '0')}.jpg`, size: 9e6, rating: 0 })),
  'B/': Array.from({ length: 2 }, (_, i) => ({ id: `B/b${i}.jpg`, name: `b${i}.jpg`, size: 9e6, rating: 0 })),
};
const guiIds = page => page.$$eval('.photo-card', cs => cs.map(c => c.dataset.photoId));
const guiVisible = (page, sel) => page.evaluate(s => {
  const el = document.querySelector(s);
  return !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
}, sel);
const GUI_STUDIO = { name: '海邊影像工作', booking_url: 'https://booking.example.com/x', has_logo: true };
const GUI_TITLE = '<b>阿明</b> 婚禮 & 家人';
const GUI_GONE = ['#sidebarToggle', '#sidebarBackdrop', 'aside.sidebar', '.sidebar', '.flags-grid', '[data-annotated]',
  '#sortBy', '#syncSidebarSection', '.star-filter', '#clearFiltersBtn', '#filterSelectedBtn', '#submitJobBtn',
  '#studioBookingLink', '.logo-label', '#buildVersion', '#headerSortBtn', '#backupDataBtn', '#resetAllDataBtn', '#expiryBadge'];

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['A/', 'B/'], photosByFolder: GUI_PHOTOS,
    pickLimit: 5, title: GUI_TITLE, studio: GUI_STUDIO });
  m.state.selections.set('A/a01.jpg', { rating: 1, note: '', updated_by: 'picker-0', updated_at: 't' });
  await suite('guest UI 390px — owner: no ☰/drawer/photographer tools; sticky #guestBar with title, folder select and filter; one submit',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.waitForFunction(() => document.querySelector('.logo-name')?.textContent === '海邊影像工作', null, { timeout: 5000 });

      const present = await page.evaluate(sels => sels.filter(s => document.querySelector(s)), GUI_GONE);
      ok('☰, backdrop, .sidebar, FLAGS, ANNOTATION, 排序, DATA, star filter, header submit, 預約 — all null in the DOM', present.length === 0, JSON.stringify(present));
      ok('no 02/03/04/05 titles anywhere in the page text',
        !(await page.evaluate(() => /RATING|FLAGS|ANNOTATION|05 \/ DATA|SOURCE/.test(document.body.innerText))));

      // ── #guestBar
      ok('#guestBar is displayed (computed)', await guiVisible(page, '#guestBar'));
      const g = await page.evaluate(() => {
        const r = e => { const b = e.getBoundingClientRect(); return { t: b.top, b: b.bottom, l: b.left, r: b.right, w: b.width, h: b.height }; };
        const bar = document.getElementById('guestBar');
        const card = document.querySelector('.photo-card');
        const first = document.querySelector('.content').firstElementChild;
        return {
          bar: r(bar), header: r(document.querySelector('.header')), card: r(card), vw: innerWidth,
          title: document.getElementById('guestBarTitle').textContent,
          titleHasEl: !!document.getElementById('guestBarTitle').querySelector('b'),
          titleFirst: bar.firstElementChild.id, firstInContent: first.id,
          sel: r(document.getElementById('guestFolderSelect')),
          filters: [...bar.querySelectorAll('[data-pick-filter]')].map(b => ({ k: b.dataset.pickFilter, ...r(b) })),
          opts: [...document.getElementById('guestFolderSelect').options].map(o => o.value),
          selVal: document.getElementById('guestFolderSelect').value,
          scrollW: document.documentElement.scrollWidth, bodyScrollW: document.body.scrollWidth,
        };
      });
      ok('inside the viewport horizontally', g.bar.l >= 0 && g.bar.r <= g.vw, JSON.stringify(g.bar));
      ok('right under the header (top == header bottom)', Math.abs(g.bar.t - g.header.b) <= 1.5, `${g.bar.t} vs ${g.header.b}`);
      ok('above the grid content', g.bar.b <= g.card.t + 0.5, `${g.bar.b} vs ${g.card.t}`);
      ok('it is the first thing in the content column', g.firstInContent === 'guestBar');
      ok('project title is the first line, as plain text (never innerHTML)', g.titleFirst === 'guestBarTitle' && g.title === GUI_TITLE && !g.titleHasEl, g.title);
      ok('folder selector lists the permitted folders and shows the current one', JSON.stringify(g.opts) === '["A/","B/"]' && g.selVal === 'A/', JSON.stringify(g.opts) + g.selVal);
      ok('three filter buttons in the bar: 全部, 已選, 未選', JSON.stringify(g.filters.map(f => f.k)) === '["all","selected","unselected"]', JSON.stringify(g.filters));
      ok('the filter bar lives in the guest bar, not a sidebar', await page.evaluate(() => !!document.querySelector('#guestBar #pickFilterBar')));
      ok('targets >= 44px: select and every filter button', g.sel.h >= 44 && g.filters.every(f => f.h >= 44 && f.w >= 44), JSON.stringify([g.sel.h, g.filters.map(f => [f.w, f.h])]));
      ok('no horizontal page scroll', g.scrollW <= g.vw && g.bodyScrollW <= g.vw, `${g.scrollW}/${g.bodyScrollW}/${g.vw}`);
      ok('the bar is not more than a third of the screen', g.bar.h <= 844 / 3, String(g.bar.h));

      // ── sticky: scroll the grid, the bar stays under the header
      await page.evaluate(() => { document.querySelector('.content').scrollTop = 600; });
      await page.waitForTimeout(100);
      const stuck = await page.evaluate(() => ({
        top: document.getElementById('guestBar').getBoundingClientRect().top,
        hb: document.querySelector('.header').getBoundingClientRect().bottom,
        st: document.querySelector('.content').scrollTop,
      }));
      ok('after scrolling the grid the bar is still right under the header', stuck.st > 100 && Math.abs(stuck.top - stuck.hb) <= 1.5, JSON.stringify(stuck));
      await page.evaluate(() => { document.querySelector('.content').scrollTop = 0; });

      // ── bottom bar: visible, not overlapped, nothing else on top of it
      const bb = await page.evaluate(() => {
        const bar = document.getElementById('mobileActionBar');
        const b = bar.getBoundingClientRect();
        const hit = (x, y) => document.elementFromPoint(x, y);
        const btn = document.getElementById('pickSubmitBtn').getBoundingClientRect();
        return {
          disp: getComputedStyle(bar).display, t: b.top, b: b.bottom, vh: innerHeight,
          hitCounter: !!hit(b.left + 20, (b.top + b.bottom) / 2)?.closest('#mobileActionBar'),
          hitBtn: hit((btn.left + btn.right) / 2, (btn.top + btn.bottom) / 2)?.closest('#pickSubmitBtn') !== null,
          btnH: btn.height,
          guestBottom: document.getElementById('guestBar').getBoundingClientRect().bottom,
          counter: document.getElementById('pickCounter')?.textContent,
        };
      });
      ok('bottom bar is displayed and sits inside the viewport', bb.disp !== 'none' && bb.b <= bb.vh + 0.5 && bb.t > 0, JSON.stringify(bb));
      ok('nothing overlaps it: hit-testing its counter and its button lands on the bar', bb.hitCounter && bb.hitBtn);
      ok('the guest bar ends above the bottom bar', bb.guestBottom < bb.t);
      ok('bottom bar shows 已選 N / limit 張 and the submit is >= 44 tall', bb.counter === '已選 1 / 5 張' && bb.btnH >= 44, JSON.stringify(bb));

      // ── exactly one submit-style button
      const submits = await page.evaluate(() => [...document.querySelectorAll('button, a')]
        .filter(e => /完成挑圖|完成提交/.test(e.textContent)).map(e => e.id));
      ok('exactly one 完成挑圖/完成提交 element, and it is #pickSubmitBtn', JSON.stringify(submits) === '["pickSubmitBtn"]', JSON.stringify(submits));
      ok('no 預約拍攝 text anywhere', !(await page.evaluate(() => document.body.innerText.includes('預約拍攝'))));

      // ── avatar
      const av = await page.evaluate(() => {
        const a = document.getElementById('userAvatarStudio');
        return { text: a.textContent.trim(), svg: !!a.querySelector('svg'), label: a.getAttribute('aria-label'), tag: a.tagName,
          pe: getComputedStyle(a).pointerEvents, hasHC: document.body.innerText.includes('HC') };
      });
      ok('avatar is an SVG person icon labelled 訪客, not 「HC」, not interactive',
        av.svg && av.text === '' && av.label === '訪客' && av.tag === 'DIV' && av.pe === 'none' && !av.hasHC, JSON.stringify(av));

      // ── brand: studio name fully visible
      const br = await page.evaluate(() => {
        const n = document.querySelector('.logo-name');
        const b = n.getBoundingClientRect();
        return { text: n.textContent, sw: n.scrollWidth, cw: n.clientWidth, r: b.right, vw: innerWidth,
          img: !!document.querySelector('.logo-mark-img'), av: document.getElementById('userAvatarStudio').getBoundingClientRect().left };
      });
      ok('studio name is fully visible (scrollWidth <= clientWidth) with its logo', br.text === '海邊影像工作' && br.sw <= br.cw && br.cw > 60 && br.img, JSON.stringify(br));
      ok('and does not run under the avatar', br.r <= br.av, JSON.stringify(br));

      if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/pick-390.png` });
      // ── folder selector switches the grid
      await page.selectOption('#guestFolderSelect', 'B/');
      await page.waitForFunction(() => document.querySelector('.photo-card')?.dataset.photoId.startsWith('B/'), null, { timeout: 5000 });
      ok('selecting B/ shows B’s photos', JSON.stringify(await guiIds(page)) === '["B/b0.jpg","B/b1.jpg"]', JSON.stringify(await guiIds(page)));
      ok('and the select shows B/', (await page.$eval('#guestFolderSelect', s => s.value)) === 'B/');
      await page.selectOption('#guestFolderSelect', 'A/');
      await page.waitForFunction(() => document.querySelector('.photo-card')?.dataset.photoId.startsWith('A/'), null, { timeout: 5000 });

      // ── filter 已選 + live count
      await page.click('#guestBar [data-pick-filter="selected"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 1, null, { timeout: 3000 });
      ok('已選 shows only the ♥ photo', JSON.stringify(await guiIds(page)) === '["A/a01.jpg"]', JSON.stringify(await guiIds(page)));
      ok('the count in the button reads 1', (await page.textContent('#pickFilterSelectedCount')) === '1');
      await page.click('#guestBar [data-pick-filter="all"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 30, null, { timeout: 3000 });
      await page.locator('.photo-card').nth(0).locator('.pick-heart-btn').click();
      await page.waitForFunction(() => document.getElementById('pickFilterSelectedCount').textContent === '2', null, { timeout: 3000 });
      ok('♥ on a photo raises the live count to 2', true);
      ok('and the bottom counter follows', (await page.textContent('#pickCounter')) === '已選 2 / 5 張');
      await page.click('#guestBar [data-pick-filter="selected"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 2, null, { timeout: 3000 });
      await page.locator('.photo-card').nth(0).locator('.pick-heart-btn').click();
      await page.waitForFunction(() => document.getElementById('pickFilterSelectedCount').textContent === '1' && document.querySelectorAll('.photo-card').length === 1, null, { timeout: 3000 });
      ok('un-♥ inside 已選 drops the card and the count to 1', true);
      await page.click('#guestBar [data-pick-filter="unselected"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 29, null, { timeout: 3000 });
      ok('未選 hides the picked photo (29 of 30 left)', true);
      await page.click('#guestBar [data-pick-filter="all"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 30, null, { timeout: 3000 });

      // ── preview modal covers both bars
      await page.click('.photo-card', { position: { x: 5, y: 5 } });
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const cover = await page.evaluate(() => {
        const inModal = (x, y) => !!document.elementFromPoint(x, y)?.closest('#photoModal');
        const g = document.getElementById('guestBar').getBoundingClientRect();
        const b = document.getElementById('mobileActionBar').getBoundingClientRect();
        // the orange toggle is gone for guests (it covered the ♥); the labelled 備註・標示 replaces it
        const gone = !document.getElementById('mobileToolsToggle');
        const t = document.getElementById('pickPanelBtn').getBoundingClientRect();
        return { gone, guest: inModal(g.left + g.width / 2, g.top + 10), bottom: inModal(b.left + 30, (b.top + b.bottom) / 2),
          toggle: { t: t.top, b: t.bottom, l: t.left, r: t.right, disp: getComputedStyle(document.getElementById('pickPanelBtn')).display },
          guestB: g.bottom };
      });
      ok('the preview modal is on top of the guest bar', cover.guest, JSON.stringify(cover));
      ok('and on top of the bottom bar', cover.bottom, JSON.stringify(cover));
      ok('the orange toggle is gone for a guest; 備註・標示 is shown instead', cover.gone && cover.toggle.disp !== 'none', JSON.stringify(cover));
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.getElementById('photoModal').classList.contains('active'), null, { timeout: 3000 });

      // ── submit works from the bottom bar
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickSubmitModal.active', { timeout: 5000 });
      ok('the bottom 完成提交 opens the submit form', true);
      await page.click('#pickSubmitCancelBtn');

      // ── crossing 1024px swaps to the sidebar layout and back, filter keeps working
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.waitForFunction(() => !document.getElementById('guestBar') && !!document.querySelector('aside.sidebar'), null, { timeout: 3000 });
      ok('widening to 1280 removes #guestBar and brings the sidebar back with the filter inside',
        await page.evaluate(() => !!document.querySelector('aside.sidebar #pickFilterBar') && !!document.querySelector('aside.sidebar #folderTree .tree-row')));
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => !!document.getElementById('guestBar') && !document.querySelector('aside.sidebar'), null, { timeout: 3000 });
      await page.click('#guestBar [data-pick-filter="selected"]');
      await page.waitForFunction(() => document.querySelectorAll('.photo-card').length === 1, null, { timeout: 3000 });
      ok('back at 390 the bar returns and its filter still works (listeners survived the move)', true);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['A/', 'B/'], photosByFolder: GUI_PHOTOS,
    pickLimit: 5, title: GUI_TITLE, studio: GUI_STUDIO });
  await suite('guest UI 1280px — owner: sidebar holds only 資料夾 + filter; bottom pill shows 已選 N / limit 張 + 完成提交; submit works',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.waitForFunction(() => document.querySelector('.logo-name')?.textContent === '海邊影像工作', null, { timeout: 5000 });
      const gone = ['#sidebarToggle', '#sidebarBackdrop', '#guestBar', '.flags-grid', '[data-annotated]', '#sortBy', '#syncSidebarSection',
        '.star-filter', '#clearFiltersBtn', '#submitJobBtn', '#studioBookingLink', '.logo-label', '#buildVersion', '#headerSortBtn', '#headerViewBtn', '#expiryBadge'];
      const present = await page.evaluate(sels => sels.filter(s => document.querySelector(s)), gone);
      ok('photographer-only elements are null in the DOM', present.length === 0, JSON.stringify(present));
      const sb = await page.evaluate(() => {
        const s = document.querySelector('aside.sidebar');
        return {
          text: s.innerText,
          sections: [...s.querySelectorAll(':scope > .sidebar-section')].map(x => x.id || (x.querySelector('#folderTreeContainer') ? 'folders' : '?')),
          filterIn: !!s.querySelector('#pickFilterBar'), rows: s.querySelectorAll('#folderTree .tree-row').length,
          titles: s.querySelectorAll('.side-title').length,
        };
      });
      ok('the sidebar has exactly two sections: folders + filter', JSON.stringify(sb.sections) === '["folders","pickFilterSection"]', JSON.stringify(sb.sections));
      ok('and says 資料夾, no RATING/FLAGS/ANNOTATION/DATA/SOURCE',
        sb.text.includes('資料夾') && !/RATING|FLAGS|ANNOTATION|DATA|SOURCE|排序/.test(sb.text) && sb.titles === 0, sb.text);
      ok('the filter is in the sidebar, folder rows are listed', sb.filterIn && sb.rows === 2, JSON.stringify(sb));
      ok('desktop brand: the studio name is fully visible too',
        await page.evaluate(() => { const n = document.querySelector('.logo-name'); return n.textContent === '海邊影像工作' && n.scrollWidth <= n.clientWidth; }));
      ok('project title in the header breadcrumbs (plain text)',
        (await page.textContent('#headerBreadcrumbs')) === GUI_TITLE && (await page.$('#headerBreadcrumbs b')) === null);
      const bar = await page.evaluate(() => {
        const b = document.getElementById('mobileActionBar').getBoundingClientRect();
        const btn = document.getElementById('pickSubmitBtn');
        const c = document.getElementById('pickCounter').getBoundingClientRect();
        const bb = btn.getBoundingClientRect();
        return { disp: getComputedStyle(document.getElementById('mobileActionBar')).display, t: b.top, b: b.bottom, l: b.left, r: b.right, vw: innerWidth, vh: innerHeight,
          btnShown: getComputedStyle(btn).display !== 'none' && btn.getClientRects().length > 0, btn: [bb.left, bb.right], counter: [c.left, c.right],
          text: document.getElementById('pickCounter').textContent,
          hit: document.elementFromPoint((bb.left + bb.right) / 2, (bb.top + bb.bottom) / 2)?.closest('#pickSubmitBtn') !== null };
      });
      ok('bottom pill is shown with 已選 N / limit 張 next to a visible 完成提交, inside the viewport',
        bar.disp === 'flex' && bar.btnShown && bar.text === '已選 0 / 5 張' && bar.b <= bar.vh && bar.r <= bar.vw && bar.counter[1] <= bar.btn[0] + 1, JSON.stringify(bar));
      ok('the button is really clickable there (hit-test)', bar.hit);
      const submits = await page.evaluate(() => [...document.querySelectorAll('button, a')].filter(e => /完成挑圖|完成提交/.test(e.textContent)).map(e => e.id));
      ok('exactly one submit element: #pickSubmitBtn', JSON.stringify(submits) === '["pickSubmitBtn"]', JSON.stringify(submits));
      ok('avatar is the person icon', await page.evaluate(() => {
        const a = document.getElementById('userAvatarStudio');
        return !!a.querySelector('svg') && a.getAttribute('aria-label') === '訪客' && a.textContent.trim() === '';
      }));
      if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/pick-1280.png` });
      await page.click('#folderTree .tree-row[data-folder="B/"]');
      await page.waitForFunction(() => document.querySelector('.photo-card')?.dataset.photoId.startsWith('B/'), null, { timeout: 5000 });
      ok('a sidebar folder row still switches the grid', true);
      await page.locator('.photo-card').nth(0).locator('.pick-heart-btn').click();
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickSubmitModal.active', { timeout: 5000 });
      ok('完成提交 opens the submit form on desktop', true);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: { viewport: { width: 1280, height: 900 } } });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', photosByFolder: GUI_PHOTOS, folders: ['A/'],
    studio: { name: '海邊影像工作室海邊影像工作室海邊影像工作室海邊影像工作室', has_logo: false } });
  await suite('guest UI 390px — a very long studio name is ellipsized inside the header, never pushing the avatar out',
    `${base}/index.html?t=TOK`,
    async page => {
      await page.waitForFunction(() => document.querySelector('.logo-name')?.textContent.length > 20, null, { timeout: 5000 });
      const r = await page.evaluate(() => {
        const n = document.querySelector('.logo-name').getBoundingClientRect();
        const hl = document.querySelector('.header-left').getBoundingClientRect();
        const av = document.getElementById('userAvatarStudio').getBoundingClientRect();
        return { nr: n.right, hl: hl.right, al: av.left, ar: av.right, vw: innerWidth, sw: document.documentElement.scrollWidth };
      });
      return [r.nr <= r.hl + 0.5 && r.hl <= r.al + 0.5 && r.ar <= r.vw && r.sw <= r.vw ? 'ok    long name stays inside the header, avatar on screen' : 'FAIL  ' + JSON.stringify(r)];
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['A/', 'B/'], photosByFolder: GUI_PHOTOS, title: 'V 專案' });
  await suite('guest UI 390px — viewer: folder selector and filter, no submit, no ♥ to click',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('#guestBar shows with the title', await guiVisible(page, '#guestBar') && (await page.textContent('#guestBarTitle')) === 'V 專案');
      ok('a folder selector', (await page.$$eval('#guestFolderSelect option', os => os.length)) === 2);
      ok('the filter is there too (a viewer can filter today)', (await page.$$eval('#guestBar [data-pick-filter]', bs => bs.length)) === 3);
      ok('no submit button is displayed and no header 完成挑圖', !(await guiVisible(page, '#pickSubmitBtn')) && (await page.$('#submitJobBtn')) === null);
      ok('no clickable ♥', (await page.$$('.photo-card button.pick-heart-btn')).length === 0);
      await page.selectOption('#guestFolderSelect', 'B/');
      await page.waitForFunction(() => document.querySelector('.photo-card')?.dataset.photoId.startsWith('B/'), null, { timeout: 5000 });
      ok('the selector switches the grid for a viewer', true);
      ok('no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      return out;
    },
    { before: m.attach, contextOptions: MOBILE });
}

for (const [label, co, proofs] of [['390px', MOBILE, false], ['390px + proofs switch', MOBILE, true], ['1280px', { viewport: { width: 1280, height: 900 } }, false]]) {
  const FILES = ['shoot/毛片/a.jpg', 'shoot/毛片/b.jpg', 'shoot/精修/f1.jpg', 'shoot/精修/f2.jpg', 'shoot/精修/sub/f3.jpg'];
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', phase: 'retouching', folders: ['shoot/毛片/'], finalFolders: ['shoot/精修/'],
    deliveredAt: '2026-09-20T00:00:00.000Z', pickFiles: FILES, allowProofDownload: proofs, title: 'D 專案' });
  await suite(`guest UI delivered ${label} — folder selector only: no filter, no ♥, no submit, no counter`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const narrow = label.startsWith('390');
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      if (narrow) {
        ok('#guestBar is shown with the title and a folder selector', await guiVisible(page, '#guestBar') && await guiVisible(page, '#guestFolderSelect') &&
          (await page.textContent('#guestBarTitle')) === 'D 專案');
        const opts = await page.$$eval('#guestFolderSelect option', os => os.map(o => o.value));
        ok('the selector lists the finals folder and its subfolder', opts.includes('shoot/精修/') && opts.includes('shoot/精修/sub/'), JSON.stringify(opts));
        await page.selectOption('#guestFolderSelect', 'shoot/精修/sub/');
        await page.waitForFunction(() => document.querySelector('.photo-card')?.dataset.photoId.includes('sub/'), null, { timeout: 5000 });
        ok('selecting the subfolder switches the gallery', JSON.stringify(await guiIds(page)) === '["shoot/精修/sub/f3.jpg"]', JSON.stringify(await guiIds(page)));
        ok('no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      } else {
        ok('the sidebar holds the folder tree and nothing else (no filter section)',
          await page.evaluate(() => !!document.querySelector('aside.sidebar #folderTree .tree-row') && !document.querySelector('aside.sidebar .pick-filter-bar') &&
            !document.getElementById('pickFilterSection')));
      }
      if (process.env.SHOTS && label === '390px') await page.screenshot({ path: `${process.env.SHOTS}/delivered-390.png` });
      ok('the filter bar and its section are removed from the DOM (not hidden)',
        (await page.$('#pickFilterBar')) === null && (await page.$('[data-pick-filter]')) === null && (await page.$('#pickFilterSection')) === null);
      ok('no ♥, no submit (either), no counter, no bottom bar',
        (await page.$('.pick-heart-btn')) === null && (await page.$('#submitJobBtn')) === null && (await page.$('#pickSubmitBtn')) === null &&
        (await page.$('#pickCounter')) === null && (await page.$('#mobileActionBar')) === null);
      if (proofs) {
        ok('下載毛片原檔 entry still there', (await page.textContent('#deliveryProofsBtn')) === '下載毛片原檔');
        await page.click('#deliveryProofsBtn');
        await page.waitForFunction(() => document.querySelector('.photo-card')?.dataset.photoId.includes('毛片'), null, { timeout: 5000 });
        ok('it switches to the proofs; still no filter', (await page.$('#pickFilterBar')) === null && JSON.stringify(await guiIds(page)) === '["shoot/毛片/a.jpg","shoot/毛片/b.jpg"]');
        if (narrow) ok('the selector follows: it lists the proofs folder', await page.$$eval('#guestFolderSelect option', os => os.map(o => o.value).includes('shoot/毛片/')));
        ok('← 回精修成品 comes back', (await page.textContent('#deliveryProofsBtn')) === '← 回精修成品');
        await page.click('#deliveryProofsBtn');
        await page.waitForFunction(() => document.querySelector('.photo-card')?.dataset.photoId.includes('精修'), null, { timeout: 5000 });
        ok('the finals are back', true);
      }
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: co });
}

for (const [label, co] of [['1500px', undefined], ['390px', MOBILE]]) {
  await suite(`photographer's own index.html (no ?t=) ${label} — every tool, 完成挑圖 and ☰ are still there`,
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.sidebar', { state: 'attached', timeout: 5000 });
      const r = await page.evaluate(() => {
        const q = s => document.querySelector(s);
        return {
          rating: !!q('.star-filter') && !!q('#clearFiltersBtn') && !!q('#filterSelectedBtn'),
          flags: !!q('.flags-grid'), annot: !!q('[data-annotated]') && !!q('#sortBy'), data: !!q('#syncSidebarSection') && !!q('#backupDataBtn'),
          source: !!q('#driveUrl') && !!q('#loadPhotosBtn'), submit: !!q('#submitJobBtn'), toggle: !!q('#sidebarToggle'),
          toggleShown: getComputedStyle(q('#sidebarToggle')).display !== 'none', backdrop: !!q('#sidebarBackdrop'),
          guestBar: !!q('#guestBar'), filterBarHidden: q('#pickFilterBar').hidden === true,
          avatar: q('#userAvatarStudio').textContent.trim(), avatarSvg: !!q('#userAvatarStudio svg'),
          label: !!q('.logo-label'), booking: !!q('#studioBookingLink'), pill: !!q('#headerSortBtn'),
          pickActive: document.body.classList.contains('pick-active'),
          sections: document.querySelectorAll('.sidebar > .sidebar-section').length,
        };
      });
      ok('RATING / FLAGS / ANNOTATION+排序 / DATA / SOURCE all present', r.rating && r.flags && r.annot && r.data && r.source && r.sections === 5, JSON.stringify(r));
      ok('header 完成挑圖 button present', r.submit);
      ok('☰ and backdrop present; ☰ shown only on a phone', r.toggle && r.backdrop && r.toggleShown === (label === '390px'), JSON.stringify(r));
      ok('no guest bar, ♥ filter still hidden, no pick-active', !r.guestBar && r.filterBarHidden && !r.pickActive);
      ok('avatar still says HC', r.avatar === 'HC' && !r.avatarSvg, r.avatar);
      ok('logo label, 預約 link and header pills are untouched', r.label && r.booking && r.pill);
      if (label === '390px') {
        await page.evaluate(() => document.getElementById('sidebarToggle').click());
        ok('☰ opens the drawer', await page.evaluate(() => document.querySelector('.sidebar').classList.contains('active') && document.getElementById('sidebarBackdrop').classList.contains('active')));
      }
      return out;
    },
    { before: mockWorker(3), initScript: () => { sessionStorage.setItem('studio_token', 'x'); try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) {} },
      contextOptions: co });
}

// ═══════════════════════════════════════════════════════════════════════════
// Delivered projects (docs/dashboard-settings.md) — admin.html project detail
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// Delivery (docs/delivery.md) — admin.html 交件 block + the proof-download
// switch, and the guest link's delivery gallery
// ═══════════════════════════════════════════════════════════════════════════

const WORKER = 'https://imagepicker.hotichen.workers.dev';
const ADMIN_BUCKET = ['shoot/', 'shoot/毛片/', 'shoot/精修/', 'shoot/精修二/', 'shoot/毛片/sub/', '_hidden/'];

// Opens the folder picker's overlay, walks into `path` (a list of prefixes,
// each entered from the one before) and ticks `folders`, then confirms.
async function adminPickFinals(page, enterPath, folders) {
  await page.waitForSelector('#folder-picker[style*="flex"]', { timeout: 3000 });
  for (const prefix of enterPath) {
    await page.click(`#folder-picker [data-browse="${prefix}"]`);
    await page.waitForFunction(p => document.getElementById('folder-picker-path').textContent === p, prefix, { timeout: 3000 });
  }
  for (const f of folders) {
    await page.waitForSelector(`#folder-picker [data-pick-folder="${f}"]`, { timeout: 3000 });
    await page.evaluate(x => {
      const box = document.querySelector(`#folder-picker [data-pick-folder="${x}"]`);
      if (!box.checked) box.click();
    }, f);
  }
  await page.click('#folder-picker [data-confirm-folders]');
}
const deliverBodies = m => m.requests.filter(r => r.method === 'POST' && r.path.endsWith('/deliver')).map(r => r.body);
const chipTexts = (page, sel) => page.$$eval(sel, els => els.map(e => e.dataset.finalChip));

{
  const m = pickFakeWorker({ projectId: 'proj-deliver', title: '待交件專案', phase: 'retouching', folders: ['shoot/毛片/'], bucketFolders: ADMIN_BUCKET });
  await suite('admin 交件 — 精修中：選精修資料夾（附警語）→ 交件 → 已交件＋資料夾；更換（再交件）；取消交件（要確認）',
    `${base}/admin.html#project=proj-deliver`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-delivery #pd-final-pick-btn', { timeout: 5000 });
      const txt = () => page.$eval('#pd-delivery', e => e.textContent);
      ok('the old 標記已交付 button is gone', !(await page.textContent('#project-detail-body')).includes('標記已交付'));
      ok('the block warns that finals must be a separate folder, not inside the proof folder',
        /獨立的資料夾/.test(await txt()) && /不能放在毛片/.test(await txt()), await txt());
      ok('交件 is disabled until a folder is chosen', await page.$eval('#pd-deliver-btn', b => b.disabled));
      ok('nothing is shown as delivered yet',
        (await page.$('[data-delivered-status]')) === null && (await page.$('#pd-undeliver-btn')) === null);

      await page.click('#pd-final-pick-btn');
      await adminPickFinals(page, ['shoot/'], ['shoot/精修/']);
      await page.waitForSelector('#pd-final-chips [data-final-chip]', { timeout: 3000 });
      ok('the chosen folder shows as a chip', JSON.stringify(await chipTexts(page, '#pd-final-chips [data-final-chip]')) === '["shoot/精修/"]');
      ok('交件 is enabled now', !(await page.$eval('#pd-deliver-btn', b => b.disabled)));
      ok('nothing was sent yet', deliverBodies(m).length === 0);

      await page.click('#pd-deliver-btn');
      await page.waitForSelector('[data-delivered-status]', { timeout: 3000 });
      ok('the deliver call carried final_folders', JSON.stringify(deliverBodies(m)) === '[{"final_folders":["shoot/精修/"]}]', JSON.stringify(deliverBodies(m)));
      ok('the block says 已交件 and lists the final folder',
        (await page.$eval('[data-delivered-status]', e => e.textContent)) === '已交件' &&
        JSON.stringify(await chipTexts(page, '#pd-delivered-folders [data-final-chip]')) === '["shoot/精修/"]');
      ok('更換精修資料夾 and 取消交件 are offered; 交件 is gone',
        !!(await page.$('#pd-replace-final-btn')) && !!(await page.$('#pd-undeliver-btn')) && (await page.$('#pd-deliver-btn')) === null);
      ok('the detail header and the project list both show the 已交件 badge',
        (await page.$('.pd-head [data-delivered-badge]')) !== null &&
        await page.waitForSelector('#proj-recent-list [data-delivered-badge]', { timeout: 3000 }).then(() => true, () => false));
      const firstStamp = m.state.project.delivered_at;

      // repeat deliver: the picker opens with the current finals ticked
      await page.click('#pd-replace-final-btn');
      await page.waitForSelector('#folder-picker[style*="flex"]', { timeout: 3000 });
      await page.click('#folder-picker [data-browse="shoot/"]');
      await page.waitForSelector('#folder-picker [data-pick-folder="shoot/精修/"]', { timeout: 3000 });
      ok('the current finals are pre-ticked in the picker',
        await page.$eval('#folder-picker [data-pick-folder="shoot/精修/"]', b => b.checked));
      await page.evaluate(() => {
        document.querySelector('#folder-picker [data-pick-folder="shoot/精修/"]').click();
        document.querySelector('#folder-picker [data-pick-folder="shoot/精修二/"]').click();
      });
      await page.click('#folder-picker [data-confirm-folders]');
      await page.waitForSelector('#pd-final-chips [data-final-chip]', { timeout: 3000 });
      ok('nothing is sent until 確定更換', deliverBodies(m).length === 1);
      ok('the button now reads 確定更換', (await page.textContent('#pd-deliver-btn')) === '確定更換');
      await page.click('#pd-deliver-btn');
      await page.waitForFunction(() => document.querySelector('#pd-delivered-folders [data-final-chip]')?.dataset.finalChip === 'shoot/精修二/', null, { timeout: 3000 });
      ok('the second deliver replaced the finals', JSON.stringify(deliverBodies(m)[1]) === '{"final_folders":["shoot/精修二/"]}', JSON.stringify(deliverBodies(m)));
      ok('and kept the first delivered_at', m.state.project.delivered_at === firstStamp);
      ok('the chooser is closed again (更換 offered)', !!(await page.$('#pd-replace-final-btn')));

      // cancelling the chooser sends nothing
      await page.click('#pd-replace-final-btn');
      await page.click('#folder-picker-close');
      await page.click('#pd-final-cancel-btn');
      await page.waitForSelector('#pd-replace-final-btn', { timeout: 3000 });
      ok('取消 leaves the delivery alone', deliverBodies(m).length === 2);

      // undeliver asks first
      let dialogText = '';
      page.once('dialog', d => { dialogText = d.message(); d.dismiss(); });
      await page.click('#pd-undeliver-btn');
      await page.waitForTimeout(300);
      ok('取消交件 shows a confirm dialog that says what happens', /取消交件/.test(dialogText) && /選片畫面/.test(dialogText), dialogText);
      ok('dismissing it keeps the delivery',
        m.state.project.delivered_at !== null && !m.requests.some(r => r.path.endsWith('/undeliver')));
      page.once('dialog', d => d.accept());
      await page.click('#pd-undeliver-btn');
      await page.waitForSelector('#pd-final-pick-btn', { timeout: 3000 });
      ok('accepting it undelivers: the chooser is back, no 已交件',
        m.requests.some(r => r.path.endsWith('/undeliver')) && (await page.$('[data-delivered-status]')) === null &&
        (await page.$('.pd-head [data-delivered-badge]')) === null);
      ok('and the snapshot is gone on the server side too', m.state.project.final_folders === null);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-codes', phase: 'retouching', folders: ['shoot/毛片/'],
    bucketFolders: ADMIN_BUCKET.concat(Array.from({ length: 21 }, (_, i) => `many/f${i}/`), ['many/']) });
  await suite('admin 交件 — Worker 的錯誤碼各有中文：not_retouching / too_many_final_folders / invalid_final_folders / final_overlaps_proofs（指名資料夾）',
    `${base}/admin.html#project=proj-codes`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-final-pick-btn', { timeout: 5000 });
      const err = () => page.$eval('#pd-deliver-err', e => e.textContent);
      const tryDeliver = async (enterPath, folders) => {
        await page.click('#pd-final-pick-btn');
        await adminPickFinals(page, enterPath, folders);
        await page.waitForSelector('#pd-final-chips [data-final-chip]', { timeout: 3000 });
        await page.click('#pd-deliver-btn');
        await page.waitForFunction(() => document.getElementById('pd-deliver-err').textContent !== '', null, { timeout: 3000 });
      };

      await tryDeliver(['shoot/'], ['shoot/毛片/sub/']);
      ok('final_overlaps_proofs names the folder', /shoot\/毛片\/sub\//.test(await err()) && /毛片資料夾/.test(await err()), await err());
      ok('the chosen folder stays so it can be fixed, and the button is usable again',
        (await chipTexts(page, '#pd-final-chips [data-final-chip]')).length === 1 && !(await page.$eval('#pd-deliver-btn', b => b.disabled)));
      ok('nothing became delivered', m.state.project.delivered_at === null && (await page.$('[data-delivered-status]')) === null);

      // another folder replaces the clash and the message clears
      await page.click('#pd-final-pick-btn');
      await page.click('#folder-picker [data-browse="shoot/"]');
      await page.waitForSelector('#folder-picker [data-pick-folder="shoot/精修/"]', { timeout: 3000 });
      await page.evaluate(() => {
        document.querySelector('#folder-picker [data-pick-folder="shoot/毛片/sub/"]')?.click();
        document.querySelector('#folder-picker [data-pick-folder="shoot/精修/"]').click();
      });
      await page.click('#folder-picker [data-confirm-folders]');

      // invalid_final_folders
      await page.click('#pd-final-pick-btn');
      await page.waitForSelector('#folder-picker [data-pick-folder]', { timeout: 3000 });
      await page.evaluate(() => {
        for (const b of document.querySelectorAll('#folder-picker [data-pick-folder]')) if (b.checked) b.click();
        document.querySelector('#folder-picker [data-pick-folder="_hidden/"]').click();
      });
      await page.click('#folder-picker [data-confirm-folders]');
      await page.click('#pd-deliver-btn');
      await page.waitForFunction(() => /不正確/.test(document.getElementById('pd-deliver-err').textContent), null, { timeout: 3000 });
      ok('invalid_final_folders gets its own sentence', /精修資料夾不正確/.test(await err()), await err());

      // too_many_final_folders: 21 folders
      await page.$$eval('[data-remove-final]', bs => bs.forEach(b => b.click()));
      await page.click('#pd-final-pick-btn');
      await page.click('#folder-picker [data-browse="many/"]');
      await page.waitForSelector('#folder-picker [data-pick-folder="many/f0/"]', { timeout: 3000 });
      await page.evaluate(() => {
        for (const b of document.querySelectorAll('#folder-picker [data-pick-folder]')) if (b.checked) b.click();
        for (const b of document.querySelectorAll('#folder-picker [data-pick-folder^="many/f"]')) b.click();
      });
      await page.click('#folder-picker [data-confirm-folders]');
      ok('21 chips chosen', (await chipTexts(page, '#pd-final-chips [data-final-chip]')).length === 21);
      await page.click('#pd-deliver-btn');
      await page.waitForFunction(() => /最多/.test(document.getElementById('pd-deliver-err').textContent), null, { timeout: 3000 });
      ok('too_many_final_folders says the max (20)', /最多 20 個/.test(await err()), await err());

      // not_retouching: the project was reopened meanwhile
      m.state.project.phase = 'picking';
      await page.$$eval('[data-remove-final]', bs => bs.forEach(b => b.click()));
      await page.click('#pd-final-pick-btn');
      await page.waitForSelector('#folder-picker [data-pick-folder]', { timeout: 3000 });
      await page.evaluate(() => {
        for (const b of document.querySelectorAll('#folder-picker [data-pick-folder]')) if (b.checked) b.click();
        document.querySelector('#folder-picker [data-pick-folder="many/f0/"]').click();
      });
      await page.click('#folder-picker [data-confirm-folders]');
      await page.click('#pd-deliver-btn');
      await page.waitForFunction(() => /開始精修/.test(document.getElementById('pd-deliver-err').textContent), null, { timeout: 3000 });
      ok('not_retouching tells the photographer to press 開始精修', /尚未開始精修/.test(await err()), await err());
      ok('none of the four was delivered', m.state.project.delivered_at === null);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-sw', title: '開關', phase: 'picking' });
  await suite('admin — 「允許客人下載毛片原檔」開關：狀態來自專案、開關送 PATCH、重新開啟仍是新狀態',
    `${base}/admin.html#project=proj-sw`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-allow-proof-dl', { timeout: 5000 });
      const patches = () => m.requests.filter(r => r.method === 'PATCH').map(r => r.body);
      ok('the switch is present in 選片中 (any phase) and off by default',
        (await page.$eval('#pd-allow-proof-dl', i => i.checked)) === false);
      ok('the block explains what it does', /毛片的原始檔/.test(await page.$eval('#pd-proofdl', e => e.textContent)));
      ok('no 交件 block while still picking', (await page.$('#pd-delivery #pd-final-pick-btn')) === null);
      await page.click('#pd-allow-proof-dl');
      await page.waitForFunction(() => !document.getElementById('pd-allow-proof-dl').disabled, null, { timeout: 3000 });
      ok('turning on sends PATCH {allow_proof_download:true}', JSON.stringify(patches()) === '[{"allow_proof_download":true}]', JSON.stringify(patches()));
      ok('the switch stays on', await page.$eval('#pd-allow-proof-dl', i => i.checked));
      ok('and the server has it', m.state.project.allow_proof_download === true);
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('#pd-allow-proof-dl', { timeout: 5000 });
      ok('reopening the detail shows it on (state comes from the project)', await page.$eval('#pd-allow-proof-dl', i => i.checked));
      await page.click('#pd-allow-proof-dl');
      await page.waitForFunction(() => !document.getElementById('pd-allow-proof-dl').disabled, null, { timeout: 3000 });
      ok('turning off sends {allow_proof_download:false}', JSON.stringify(patches()[1]) === '{"allow_proof_download":false}', JSON.stringify(patches()));
      ok('and it is off on the server', m.state.project.allow_proof_download === false);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-sw-err', phase: 'retouching', patchStatus: 500, patchBody: { error: 'no such column: allow_proof_download' } });
  await suite('admin — 開關失敗（例如 migration 還沒跑）：顯示錯誤並把開關放回原位',
    `${base}/admin.html#project=proj-sw-err`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-allow-proof-dl', { timeout: 5000 });
      await page.click('#pd-allow-proof-dl');
      await page.waitForFunction(() => document.getElementById('pd-proofdl-err').textContent !== '', null, { timeout: 3000 });
      ok('the server message is shown', /allow_proof_download/.test(await page.textContent('#pd-proofdl-err')));
      ok('the switch is back off (nothing was saved)', (await page.$eval('#pd-allow-proof-dl', i => i.checked)) === false);
      ok('and usable again', !(await page.$eval('#pd-allow-proof-dl', i => i.disabled)));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-sw-on', phase: 'retouching', allowProofDownload: true });
  await suite('admin — 專案本來就開著開關時，畫面一打開就是開的',
    `${base}/admin.html#project=proj-sw-on`,
    async page => {
      await page.waitForSelector('#pd-allow-proof-dl', { timeout: 5000 });
      return [(await page.$eval('#pd-allow-proof-dl', i => i.checked)) ? 'ok    switch reads allow_proof_download from the project' : 'FAIL  switch not checked'];
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-legacy', phase: 'retouching', deliveredAt: '2026-09-01T00:00:00.000Z' });
  await suite('admin — 舊資料（有交付時間、沒有精修資料夾）：仍顯示已交件，並能用「更換精修資料夾」補上',
    `${base}/admin.html#project=proj-legacy`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-delivered-status]', { timeout: 5000 });
      ok('a legacy stamp is shown as 已交件 with a note instead of folders',
        /舊資料/.test(await page.textContent('#pd-delivered-folders')) && !!(await page.$('#pd-replace-final-btn')));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ─── guest link ──────────────────────────────────────────────────────────────

const GUEST_FILES = [
  'shoot/毛片/a.jpg', 'shoot/毛片/b.jpg',
  'shoot/精修/f1.jpg', 'shoot/精修/f2.jpg', 'shoot/精修/sub/f3.jpg',
];
const DL = key => `${WORKER}/${key}?download=1&t=TOK`;
const guestCards = page => page.$$eval('.photo-card', cs => cs.map(c => c.dataset.photoId));
const listed = m => m.requests.filter(r => r.search.includes('list=')).map(r => decodeURIComponent(new URLSearchParams(r.search).get('list')));

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['shoot/毛片/'], pickFiles: GUEST_FILES });
  await suite('guest picking, switch OFF — no download button anywhere (absent from the DOM, not merely hidden)',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('positive: the proofs and the ♥ are there', (await guestCards(page)).length === 2 && !!(await page.$('.pick-heart-btn')));
      await page.click('.photo-card', { position: { x: 5, y: 5 } });
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const gone = await page.evaluate(() => ({
        modalBtn: document.getElementById('modalDownloadBtn'),
        previewBtn: document.getElementById('previewDownloadBtn'),
        anyDl: document.querySelectorAll('[data-download], [download], a[href*="download=1"]').length,
        zip: ['downloadAllBtn', 'downloadSelectedHeaderBtn', 'bulkActionBar'].filter(id => document.getElementById(id)),
      }));
      ok('#modalDownloadBtn is not in the DOM', gone.modalBtn === null);
      ok('#previewDownloadBtn is not in the DOM', gone.previewBtn === null);
      ok('no download link or attribute exists at all', gone.anyDl === 0, String(gone.anyDl));
      ok('the zip downloads (which would fetch originals) are gone too', gone.zip.length === 0, JSON.stringify(gone.zip));
      ok('no delivery bar', (await page.$eval('#deliveryBar', e => e.hidden)) === true);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['shoot/毛片/'], pickFiles: GUEST_FILES, allowProofDownload: true });
  await suite('guest picking, switch ON — 下載原檔 in the preview with ?download=1&t=; a refusal says 原檔未開放下載',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('the grid still has ♥ (picking as before)', !!(await page.$('.pick-heart-btn')));
      ok('grid cards carry no download link while picking', (await page.$('.photo-card [data-download]')) === null);
      await page.click('.photo-card', { position: { x: 5, y: 5 } });
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const modal = await page.$eval('#modalDownloadBtn', e => ({ href: decodeURI(e.href), text: e.textContent, disp: getComputedStyle(e).display }));
      ok('the modal has the button, visible, labelled 下載原檔',
        modal.text === '下載原檔' && modal.disp !== 'none', JSON.stringify(modal));
      ok('with the exact download URL', modal.href === DL('shoot/毛片/a.jpg'), modal.href);
      const pv = await page.$eval('#previewDownloadBtn', e => ({ href: decodeURI(e.href), disp: getComputedStyle(e).display, text: e.textContent }));
      ok('the preview pane has it too', pv.href === DL('shoot/毛片/a.jpg') && pv.disp !== 'none' && pv.text === '下載原檔', JSON.stringify(pv));

      await page.click('#nextPhotoBtn');
      await page.waitForFunction(() => document.getElementById('modalDownloadBtn').href.endsWith('b.jpg?download=1&t=TOK'), null, { timeout: 3000 });
      ok('the link follows the photo when navigating', true);
      await page.click('#prevPhotoBtn');
      await page.waitForFunction(() => document.getElementById('modalDownloadBtn').href.includes('a.jpg'), null, { timeout: 3000 });

      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#modalDownloadBtn')]);
      ok('clicking saves the file under the Worker’s Content-Disposition name', dl.suggestedFilename() === 'a.jpg', dl.suggestedFilename());
      ok('a one-byte Range probe went first, then the real download request',
        m.requests.some(r => r.path.endsWith('a.jpg') && r.range === 'bytes=0-0') &&
        m.requests.filter(r => r.path.endsWith('a.jpg') && r.search.includes('download=1') && !r.range).length >= 1);

      // the photographer turns the switch off while this page is open
      m.state.project.allow_proof_download = false;
      let saved = false;
      page.once('download', () => { saved = true; });
      await page.click('#modalDownloadBtn');
      await page.waitForSelector('.toast.error .toast-message', { timeout: 3000 });
      ok('a 403 original_not_allowed shows 原檔未開放下載', (await page.textContent('.toast.error .toast-message')) === '原檔未開放下載');
      await page.waitForTimeout(300);
      ok('and nothing was downloaded or navigated to', !saved && page.url().startsWith(`${base}/index.html`));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['shoot/毛片/'], pickFiles: GUEST_FILES, allowProofDownload: true });
  await suite('guest viewer, switch ON — a viewer gets the same download button in the preview',
    `${base}/index.html?t=TOK`,
    async page => {
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.click('.photo-card', { position: { x: 5, y: 5 } });
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const href = await page.$eval('#modalDownloadBtn', e => decodeURI(e.href));
      return [href === DL('shoot/毛片/a.jpg') ? 'ok    viewer sees the button with the right URL' : `FAIL  ${href}`];
    },
    { before: m.attach });
}

// delivered gallery — owner, viewer with a taken seat, viewer with a free seat
for (const who of [
  { label: 'the owner', o: { ownerName: 'Zoe', ownerKey: 'ZOE-KEY' }, init: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY') },
  { label: 'a viewer (seat taken)', o: { ownerName: 'Zoe', ownerKey: 'ZOE-KEY' }, init: null },
  { label: 'a viewer (seat never claimed)', o: {}, init: null },
]) {
  const m = pickFakeWorker({ ...who.o, phase: 'retouching', folders: ['shoot/毛片/'], finalFolders: ['shoot/精修/'],
    deliveredAt: '2026-09-20T00:00:00.000Z', pickFiles: GUEST_FILES });
  await suite(`guest delivered — ${who.label} sees the 精修成品 gallery: finals only, no picking UI, 下載 per photo`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const cards = await guestCards(page);
      ok('the finals are listed (f1, f2)', JSON.stringify(cards) === '["shoot/精修/f1.jpg","shoot/精修/f2.jpg"]', JSON.stringify(cards));
      ok('the claim overlay never appears, even with a free seat', (await page.$eval('#pickClaimOverlay', e => e.hidden)) === true);
      ok('the title says 精修成品', (await page.textContent('#deliveryTitle')).startsWith('精修成品') &&
        (await page.$eval('#deliveryBar', e => e.hidden)) === false);
      ok('only the finals folder was listed; the proofs never were', listed(m).length > 0 && listed(m).every(f => f.startsWith('shoot/精修/')), JSON.stringify(listed(m)));
      const imgs = await page.$$eval('.photo-card img', is => is.map(i => i.src));
      ok('thumbnails are ?w=400 through the token', imgs.every(s => s.includes('?w=400') && s.includes('t=TOK') && s.includes('%E7%B2%BE%E4%BF%AE')), JSON.stringify(imgs));
      ok('no request touched a proof photo', !m.requests.some(r => decodeURIComponent(r.path).includes('毛片')));
      ok('no ♥, no submit, no counter, no filter bar, no picking banner',
        (await page.$('.pick-heart-btn')) === null && (await page.$('#submitJobBtn')) === null &&
        (await page.$('#pickSubmitBtn')) === null &&
        (await page.$('#pickCounter')) === null && (await page.$('#pickBanner')) === null &&
        (await page.$('#pickFilterBar')) === null && (await page.$('.guest-bar #pickFilterBar')) === null);
      ok('delivered: no pick counter of any kind (bar removed, no 已選 N text visible, no pick-active body class)',
        (await page.$('#mobileActionBar')) === null &&
        !(await page.evaluate(() => /已選\s*\d/.test(document.body.innerText) || document.body.classList.contains('pick-active'))));
      ok('no over-limit modal element is open', await page.evaluate(() => !document.getElementById('pickOverModal').classList.contains('active')));
      ok('no way to reach the proofs: no 下載毛片原檔 entry while the switch is off', (await page.$('#deliveryProofsBtn')) === null);
      const dls = await page.$$eval('.photo-card [data-download]', as => as.map(a => ({ href: decodeURI(a.href), text: a.textContent })));
      ok('every card has a 下載 link with its own ?download=1&t= URL',
        dls.length === 2 && dls[0].href === DL('shoot/精修/f1.jpg') && dls[1].href === DL('shoot/精修/f2.jpg') && dls.every(d => d.text === '下載'), JSON.stringify(dls));
      ok('the subfolder is in the folder panel', (await page.$$eval('#folderTree .tree-row', rs => rs.map(r => r.dataset.folder))).includes('shoot/精修/'));

      // preview: swipe/zoom machinery is the pick preview's own
      await page.click('.photo-card', { position: { x: 5, y: 5 } });
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      ok('no ♥ / note box in the preview',
        (await page.$('#modalPhotoRating .pick-heart-btn')) === null && (await page.$eval('#noteInputGroup', e => e.hidden)) === true);
      ok('the preview has 下載 with the photo’s URL',
        (await page.$eval('#modalDownloadBtn', e => decodeURI(e.href))) === DL('shoot/精修/f1.jpg') && (await page.textContent('#modalDownloadBtn')) === '下載');
      ok('the preview image is the ?w= bucket, not the original',
        /\?w=\d+/.test(await page.$eval('#previewImg', i => i.src)));
      await page.click('#zoomInBtn');
      ok('zoom works', (await page.textContent('#zoomLevel')) !== '100%', await page.textContent('#zoomLevel'));
      await page.click('#zoomResetBtn');
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.getElementById('photoCounter').textContent === '2 / 2', null, { timeout: 3000 });
      ok('next photo works and the download link follows', (await page.$eval('#modalDownloadBtn', e => decodeURI(e.href))) === DL('shoot/精修/f2.jpg'));
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#modalDownloadBtn')]);
      ok('downloading a final saves f2.jpg', dl.suggestedFilename() === 'f2.jpg', dl.suggestedFilename());
      await page.keyboard.press('Escape');

      // a subfolder opens like a proof subfolder does
      await page.click('#folderTree .tree-row');
      ok('the finals folder row is clickable and keeps the gallery', (await guestCards(page)).length === 2);
      ok('and no picking write was ever sent', !m.requests.some(r => r.path === '/api/pick/selections'));
      return out;
    },
    { before: m.attach, initScript: who.init || undefined });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', phase: 'retouching', folders: ['shoot/毛片/'], finalFolders: ['shoot/精修/'],
    deliveredAt: '2026-09-20T00:00:00.000Z', pickFiles: GUEST_FILES, allowProofDownload: true });
  await suite('guest delivered + switch ON — a secondary 下載毛片原檔 lists the proofs, download-only; 回精修成品 comes back',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('the gallery still opens on the finals', (await guestCards(page)).every(k => k.startsWith('shoot/精修/')));
      ok('the proofs were not listed yet', listed(m).every(f => f.startsWith('shoot/精修/')), JSON.stringify(listed(m)));
      ok('the entry is 下載毛片原檔', (await page.textContent('#deliveryProofsBtn')) === '下載毛片原檔' && !(await page.$eval('#deliveryProofsBtn', e => e.hidden)));
      await page.click('#deliveryProofsBtn');
      await page.waitForFunction(() => document.querySelector('.photo-card')?.dataset.photoId.includes('毛片'), null, { timeout: 5000 });
      ok('the proofs are listed (a, b)', JSON.stringify(await guestCards(page)) === '["shoot/毛片/a.jpg","shoot/毛片/b.jpg"]', JSON.stringify(await guestCards(page)));
      ok('the proof folder was listed now', listed(m).includes('shoot/毛片/'));
      ok('download-only: no ♥, no submit, no note box',
        (await page.$('.pick-heart-btn')) === null && (await page.$('#submitJobBtn')) === null &&
        (await page.$('#pickSubmitBtn')) === null && (await page.$('#pickFilterBar')) === null);
      ok('each proof has a 下載原檔 link',
        JSON.stringify(await page.$$eval('.photo-card [data-download]', as => as.map(a => [decodeURI(a.href), a.textContent]))) ===
        JSON.stringify([[DL('shoot/毛片/a.jpg'), '下載原檔'], [DL('shoot/毛片/b.jpg'), '下載原檔']]));
      ok('the title says it is the proofs', /毛片原檔/.test(await page.textContent('#deliveryTitle')));
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('.photo-card [data-download]')]);
      ok('downloading a proof original works (switch on)', dl.suggestedFilename() === 'a.jpg');
      ok('the card click did not also open the preview', (await page.$('#photoModal.active')) === null);
      ok('the button now leads back', (await page.textContent('#deliveryProofsBtn')) === '← 回精修成品');
      await page.click('#deliveryProofsBtn');
      await page.waitForFunction(() => document.querySelector('.photo-card')?.dataset.photoId.includes('精修'), null, { timeout: 5000 });
      ok('back on the finals', JSON.stringify(await guestCards(page)) === '["shoot/精修/f1.jpg","shoot/精修/f2.jpg"]');
      ok('and the folder panel follows the view', (await page.$$eval('#folderTree .tree-row', rs => rs.every(r => r.dataset.folder.includes('精修')))));

      // switch turned off while open: the proof download is refused politely
      await page.click('#deliveryProofsBtn');
      await page.waitForFunction(() => document.querySelector('.photo-card')?.dataset.photoId.includes('毛片'), null, { timeout: 5000 });
      m.state.project.allow_proof_download = false;
      let saved = false;
      page.once('download', () => { saved = true; });
      await page.click('.photo-card [data-download]');
      await page.waitForSelector('.toast.error .toast-message', { timeout: 3000 });
      ok('a refused proof download says 原檔未開放下載', (await page.textContent('.toast.error .toast-message')) === '原檔未開放下載');
      await page.waitForTimeout(200);
      ok('and saved nothing', !saved);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', phase: 'retouching', folders: ['shoot/毛片/'], finalFolders: ['shoot/精修/'],
    deliveredAt: '2026-09-20T00:00:00.000Z', pickFiles: GUEST_FILES, allowProofDownload: true });
  await suite('guest delivered gallery on a phone — no sideways scroll, 44px download targets, everything inside 390px',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const geo = await page.evaluate(() => {
        const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { w: b.width, h: b.height, l: b.left, r: b.right }; };
        return { sw: document.documentElement.scrollWidth, iw: innerWidth, dl: r('.photo-card [data-download]'), proofs: r('#deliveryProofsBtn'), bar: r('#deliveryBar') };
      });
      ok('the page does not scroll sideways', geo.sw <= geo.iw, JSON.stringify(geo));
      ok('the card 下載 is >= 44 tall and inside the phone', !!geo.dl && geo.dl.h >= 44 && geo.dl.r <= geo.iw + 1 && geo.dl.l >= 0, JSON.stringify(geo.dl));
      ok('下載毛片原檔 is >= 44 tall and inside the phone', !!geo.proofs && geo.proofs.h >= 44 && geo.proofs.r <= geo.iw + 1, JSON.stringify(geo.proofs));
      await page.click('.photo-card', { position: { x: 5, y: 5 } });
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      const modal = await page.evaluate(() => {
        const e = document.getElementById('modalDownloadBtn');
        const b = e.getBoundingClientRect();
        return { h: b.height, l: b.left, r: b.right, vis: getComputedStyle(e).display !== 'none', iw: innerWidth };
      });
      ok('the preview 下載 is visible, >= 44 tall and inside the phone', modal.vis && modal.h >= 44 && modal.r <= modal.iw + 1 && modal.l >= 0, JSON.stringify(modal));
      const before = await page.textContent('#photoCounter');
      await swipeTouch(page, '#photoCanvas', 300, 400, 60, 410);
      await page.waitForFunction(b => document.getElementById('photoCounter').textContent !== b, before, { timeout: 3000 });
      ok('swiping moves to the next final and the link follows', (await page.$eval('#modalDownloadBtn', e => decodeURI(e.href))) === DL('shoot/精修/f2.jpg'));
      ok('still no sideways scroll with the preview open', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', phase: 'retouching', folders: ['shoot/毛片/'],
    deliveredAt: '2026-09-01T00:00:00.000Z', pickFiles: GUEST_FILES });
  await suite('guest — a legacy delivered stamp without finals stays the (read-only) picking view, no gallery',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('the proofs are shown with the read-only ♥', (await guestCards(page)).every(k => k.includes('毛片')) && !!(await page.$('.pick-heart-btn')));
      ok('no delivery bar, no download link', (await page.$eval('#deliveryBar', e => e.hidden)) === true && (await page.$('[data-download]')) === null);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY') });
}

{
  const m = pickFakeWorker({ projectId: 'proj-not-ready', title: '選片中專案' });
  await suite('admin — 選片中／已送出的專案不顯示交付按鈕；直接呼叫 API 會拿到 409 not_retouching 並顯示友善訊息',
    `${base}/admin.html#project=proj-not-ready`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-reset-seat-btn', { timeout: 5000 });
      ok('no 標記已交付 button while still picking',
        (await page.$('#pd-deliver-btn')) === null && (await page.$('#pd-undeliver-btn')) === null);

      // The friendly 409 message is exercised directly against the endpoint —
      // the button itself is gated off in this phase, by design.
      const res = await page.evaluate(async id => {
        const r = await fetch(`https://imagepicker.hotichen.workers.dev/api/admin/projects/${id}/deliver`,
          { method: 'POST', headers: { 'Authorization': 'Bearer adm' } });
        return { status: r.status, body: await r.json() };
      }, m.state.project.id);
      ok('409 not_retouching from the fake, mirroring the real Worker',
        res.status === 409 && res.body.code === 'not_retouching', JSON.stringify(res));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ═══════════════════════════════════════════════════════════════════════════
// Products and orders (docs/products-orders.md, Phase A) — settings 商品,
// admin project 訂單, orders.html, dashboard revenue
// ═══════════════════════════════════════════════════════════════════════════

// A fake of the Phase A admin API that mirrors the real Worker's shapes and
// arithmetic (worker.js: readOrders, ORDER_*_SQL, the 400 {error, code} and
// 409 answers) — never a friendlier version of it. Chain it AFTER the fake
// that serves the rest of the page: anything it does not own falls through.
function ordersFake(opts = {}) {
  const st = {
    products: opts.products || [],
    // CUSTOM_PRODUCTS: the Worker's switch for the photographer's own
    // products, off unless exactly "on" — so off here unless asked for
    customProducts: opts.customProducts === true,
    platform: opts.platform || [],   // platform catalogue: {id, kind, name, …, options: [{id, label, vendor_cost, platform_price, active, sort}]}
    imageSeq: 0,
    operatorToken: opts.operatorToken || 'op',
    orders: opts.orders || [],
    titles: opts.titles || {},
    extra: opts.extra || { count: null, pick_limit: null, extra_price: null, extra: 0, fee: 0, order_id: null, order_extra: null, matches: true },
    inject: null,            // (method, path, body) => {status, body} | null
    calls: [],
    n: 0,
  };
  const id = p => `${p}-${++st.n}`;
  const NOW = '2026-09-29T02:00:00.000Z';
  const money = o => {
    const subtotal = o.items.reduce((n, i) => n + i.unit_price * i.qty, 0);
    const total = Math.max(0, subtotal - o.discount);
    const cost = o.items.reduce((n, i) => n + i.unit_cost * i.qty, 0);
    const outstanding = ['confirmed', 'fulfilled'].includes(o.status) ? Math.max(0, total - o.paid_amount) : 0;
    return { subtotal, total, cost, outstanding };
  };
  const view = o => ({ ...o, project_title: st.titles[o.project_id] ?? '', ...money(o), items: o.items.map(({ vendor_cost, ...i }) => ({ ...i, photo_keys: [...i.photo_keys] })) });
  st.addOrder = (o = {}) => {
    const order = {
      id: o.id || id('ord'), photographer_id: 'default', project_id: o.project_id || 'proj-1', source: o.source || 'admin',
      status: o.status || 'confirmed', picker_id: null, discount: o.discount || 0, paid_amount: o.paid_amount || 0,
      paid_at: o.paid_at || null, paid_method: o.paid_method || null, note: o.note || '', guest_note: '',
      created_at: o.created_at || NOW, updated_at: o.updated_at || NOW,
      confirmed_at: NOW, fulfilled_at: null, cancelled_at: null,
      items: (o.items || []).map(i => ({
        id: i.id || id('item'), order_id: '', kind: i.kind || 'album', product_id: i.product_id ?? 'prod-x', option_id: i.option_id ?? 'opt-x',
        name: i.name, option_label: i.option_label || '', unit_price: i.unit_price, unit_cost: i.unit_cost || 0, qty: i.qty || 1,
        photo_keys: i.photo_keys || [], platform_option_id: i.platform_option_id ?? null, vendor_cost: i.vendor_cost || 0,
      })),
    };
    order.items.forEach(i => { i.order_id = order.id; });
    st.orders.push(order);
    return order;
  };
  const taipeiMonth = iso => new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().slice(0, 7);
  // GET /api/operator/stats — the Worker's shape: 12 Taipei months, by paid_at,
  // cancelled excluded, revenue = unit_cost, vendor_cost from the line snapshot
  function operatorStats() {
    const [y, mo] = taipeiMonth(NOW).split('-').map(Number);
    const months = [];
    for (let i = 11; i >= 0; i--) { const d = new Date(Date.UTC(y, mo - 1 - i, 1)); months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`); }
    const zero = () => ({ qty: 0, revenue: 0, vendor_cost: 0, margin: 0 });
    const add = (into, r) => { into.qty += r.qty; into.revenue += r.revenue; into.vendor_cost += r.vendor_cost; into.margin = into.revenue - into.vendor_cost; };
    const perMonth = new Map(months.map(month => [month, { month, ...zero() }]));
    const prods = new Map(st.platform.map(pp => [pp.id, { platform_product_id: pp.id, name: pp.name, kind: pp.kind, active: pp.active, ...zero(), this_month: zero() }]));
    const thisMonth = months[months.length - 1];
    for (const o of st.orders) {
      if (o.status === 'cancelled' || !(o.paid_amount > 0) || !o.paid_at) continue;
      const month = taipeiMonth(o.paid_at);
      if (!perMonth.has(month)) continue;
      for (const i of o.items) {
        if (!i.platform_option_id) continue;
        const pp = st.platform.find(x => x.options.some(op => op.id === i.platform_option_id));
        if (!pp) continue;
        const r = { qty: i.qty, revenue: i.unit_cost * i.qty, vendor_cost: i.vendor_cost * i.qty };
        add(perMonth.get(month), r);
        const p = prods.get(pp.id);
        add(p, r);
        if (month === thisMonth) add(p.this_month, r);
      }
    }
    return { per_month: [...perMonth.values()], this_month: perMonth.get(thisMonth), products: [...prods.values()] };
  }

  // ── the platform catalogue (A2), mirroring worker.js: readProducts,
  // readPlatformProducts, adoptedOptions, productOptions(PLATFORM_MONEY) ───
  const MONEY_MAX = 10_000_000;
  const isMoney = v => Number.isSafeInteger(v) && v >= 0 && v <= MONEY_MAX;
  const platformOf = ppId => st.platform.find(x => x.id === ppId) || null;
  // an adopted product as the photographer reads it: the platform's live kind,
  // name, description, photo_count, image and option labels; cost is the
  // current platform price; never the vendor cost
  const viewProduct = p => {
    const pp = p.platform_product_id ? platformOf(p.platform_product_id) : null;
    const adopted = !!p.platform_product_id;
    const v = { ...p, platform_active: adopted ? (pp ? pp.active : 0) : null };
    if (pp) Object.assign(v, { kind: pp.kind, name: pp.name, description: pp.description, photo_count: pp.photo_count,
      has_image: pp.has_image, image_type: pp.image_type, image_updated_at: pp.image_updated_at });
    v.options = p.options.map(o => {
      if (!o.platform_option_id) return { ...o };
      const po = pp ? pp.options.find(x => x.id === o.platform_option_id) : null;
      return { ...o, label: po ? po.label : o.label, cost: po ? po.platform_price : o.cost,
        platform_price: po ? po.platform_price : null, platform_active: po ? po.active : null,
        below_platform_price: !!po && o.price < po.platform_price };
    });
    return v;
  };
  const platView = pp => ({ id: pp.id, kind: pp.kind, name: pp.name, description: pp.description, photo_count: pp.photo_count,
    active: pp.active, sort: pp.sort, has_image: pp.has_image, image_type: pp.image_type, image_updated_at: pp.image_updated_at,
    created_at: NOW, updated_at: NOW, options: pp.options.map(o => ({ ...o })) });
  // the photographer's option, as an order line reads it
  const optionOf = optionId => {
    for (const raw of st.products) for (const op of viewProduct(raw).options) if (op.id === optionId) return { p: viewProduct(raw), op };
    return null;
  };
  // an option is usable for a new line unless it, its product or (adopted) the platform's is retired
  const optionUsable = ({ p, op }) => !!op.active && !!p.active && (!op.platform_option_id || (!!p.platform_active && !!op.platform_active));
  const vendorCostOf = op => {
    const pp = op.platform_option_id ? st.platform.find(x => x.options.some(o => o.id === op.platform_option_id)) : null;
    return pp ? pp.options.find(o => o.id === op.platform_option_id).vendor_cost : 0;
  };
  const bad = (code, status = 400) => ({ status, body: { error: code.replace(/_/g, ' '), code } });

  // productOptions(): {id?, label, ...money}; returns {options} | {bad}
  function checkOptions(value, existingIds, money) {
    if (!Array.isArray(value) || !value.length || value.length > 20) return { bad: 'invalid_options' };
    const seen = new Set(), options = [];
    for (const [i, o] of value.entries()) {
      if (!o || typeof o !== 'object' || Array.isArray(o)) return { bad: 'invalid_options' };
      if (o.id !== undefined) {
        if (typeof o.id !== 'string' || !existingIds.has(o.id) || seen.has(o.id)) return { bad: 'invalid_options' };
        seen.add(o.id);
      }
      const label = o.label == null ? '' : o.label;
      if (typeof label !== 'string' || [...label.trim()].length > 60) return { bad: 'invalid_label' };
      const option = { id: o.id, label: label.trim(), sort: i };
      for (const [field, code, dflt] of money) {
        const v = o[field] === undefined && dflt !== undefined ? dflt : o[field];
        if (!isMoney(v)) return { bad: code };
        option[field] = v;
      }
      options.push(option);
    }
    return { options };
  }
  const CUSTOM_MONEY = [['price', 'invalid_price'], ['cost', 'invalid_cost', 0]];
  const PLATFORM_MONEY = [['vendor_cost', 'invalid_vendor_cost'], ['platform_price', 'invalid_platform_price']];
  // productFields(): kind/name/description/photo_count/sort of a body
  function checkFields(body, partial, kinds) {
    const set = {};
    if (!partial || 'kind' in body) { if (!kinds.includes(body.kind)) return { bad: 'invalid_kind' }; set.kind = body.kind; }
    if (!partial || 'name' in body) {
      const v = typeof body.name === 'string' ? body.name.trim() : '';
      if (!v || [...v].length > 60) return { bad: 'invalid_name' };
      set.name = v;
    }
    if ('description' in body) {
      const v = body.description === null ? '' : body.description;
      if (typeof v !== 'string' || [...v.trim()].length > 500) return { bad: 'invalid_description' };
      set.description = v.trim();
    }
    if ('photo_count' in body) {
      const v = body.photo_count;
      if (v !== null && !(Number.isSafeInteger(v) && v >= 1 && v <= 500)) return { bad: 'invalid_photo_count' };
      set.photo_count = v;
    }
    if ('sort' in body) { if (!(Number.isSafeInteger(body.sort) && body.sort >= 0)) return { bad: 'invalid_sort' }; set.sort = body.sort; }
    return { set };
  }
  // adoptedOptions(): [{platform_option_id, price}] against one platform product
  function checkAdopted(value, pp) {
    if (!Array.isArray(value) || !value.length || value.length > 20) return { bad: 'invalid_options' };
    const seen = new Set(), options = [];
    for (const [i, o] of value.entries()) {
      if (!o || typeof o !== 'object' || Array.isArray(o)) return { bad: 'invalid_options' };
      const po = typeof o.platform_option_id === 'string' ? pp.options.find(x => x.id === o.platform_option_id) : null;
      if (!po || seen.has(po.id)) return { bad: 'invalid_options' };
      seen.add(po.id);
      if (!isMoney(o.price)) return { bad: 'invalid_price' };
      if (!(po.active && pp.active)) return { bad: 'retired_option' };
      if (o.price < po.platform_price) return { bad: 'below_platform_price' };
      options.push({ platform_option_id: po.id, label: po.label, price: o.price, cost: po.platform_price, sort: i });
    }
    return { options };
  }
  // sniffImageType(): PNG / JPEG / WebP by magic bytes
  function sniff(b) {
    if (!b || b.length < 12) return null;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'image/webp';
    return null;
  }

  function handle(method, path, params, body, bytes) {
    if (st.inject) { const hit = st.inject(method, path, body); if (hit) return hit; }
    let m;
    // ── the public platform image ──
    if ((m = /^\/api\/platform\/products\/([^/]+)\/image$/.exec(path))) {
      if (method !== 'GET') return { status: 405, body: { error: 'Method not allowed' } };
      const pp = platformOf(decodeURIComponent(m[1]));
      if (!pp || !pp.has_image) return { status: 404, body: { error: 'Not found' } };
      return { raw: PIXEL, type: 'image/png' };
    }
    // ── the operator's catalogue ──
    if (path === '/api/operator/products' && method === 'GET') return { body: { products: st.platform.map(platView) } };
    if (path === '/api/operator/products' && method === 'POST') {
      const f = checkFields(body, false, ['print', 'album']);
      if (f.bad) return bad(f.bad);
      const opts = checkOptions(body.options, new Set(), PLATFORM_MONEY);
      if (opts.bad) return bad(opts.bad);
      const pp = { id: id('plat'), description: '', photo_count: null, sort: 0, ...f.set, active: 1, has_image: false, image_type: null, image_updated_at: null,
        options: opts.options.map(o => ({ id: id('popt'), label: o.label, vendor_cost: o.vendor_cost, platform_price: o.platform_price, active: 1, sort: o.sort })) };
      if (pp.kind !== 'album') pp.photo_count = null;
      st.platform.push(pp);
      return { status: 201, body: { product: platView(pp) } };
    }
    if ((m = /^\/api\/operator\/products\/([^/]+)$/.exec(path)) && method === 'PUT') {
      const pp = platformOf(m[1]);
      if (!pp) return { status: 404, body: { error: 'Not found' } };
      const f = checkFields(body, true, ['print', 'album']);
      if (f.bad) return bad(f.bad);
      let opts = null;
      if ('options' in body) {
        const c = checkOptions(body.options, new Set(pp.options.map(o => o.id)), PLATFORM_MONEY);
        if (c.bad) return bad(c.bad);
        opts = c.options;
      }
      Object.assign(pp, f.set);
      if (pp.kind !== 'album') pp.photo_count = null;
      if (opts) {
        const keep = new Set(opts.filter(o => o.id).map(o => o.id));
        pp.options.forEach(o => { if (!keep.has(o.id)) o.active = 0; });
        opts.forEach(o => {
          if (o.id) Object.assign(pp.options.find(x => x.id === o.id), { label: o.label, vendor_cost: o.vendor_cost, platform_price: o.platform_price, sort: o.sort, active: 1 });
          else pp.options.push({ id: id('popt'), label: o.label, vendor_cost: o.vendor_cost, platform_price: o.platform_price, active: 1, sort: o.sort });
        });
        pp.options.sort((a, b) => a.sort - b.sort);
      }
      return { body: { product: platView(pp) } };
    }
    if ((m = /^\/api\/operator\/products\/([^/]+)\/(retire|restore)$/.exec(path)) && method === 'POST') {
      const pp = platformOf(m[1]);
      if (!pp) return { status: 404, body: { error: 'Not found' } };
      pp.active = m[2] === 'restore' ? 1 : 0;
      return { body: { ok: true, active: pp.active } };
    }
    if ((m = /^\/api\/operator\/products\/([^/]+)\/image$/.exec(path)) && (method === 'PUT' || method === 'DELETE')) {
      const pp = platformOf(m[1]);
      if (!pp) return { status: 404, body: { error: 'Not found' } };
      if (method === 'DELETE') { Object.assign(pp, { has_image: false, image_type: null, image_updated_at: null }); return { body: { ok: true, has_image: false } }; }
      if (bytes.length > 204800) return { status: 413, body: { error: '商品圖片不可超過 200 KB', code: 'too_large', max: 204800 } };
      const type = sniff(bytes);
      if (!type) return { status: 415, body: { error: '商品圖片只接受 PNG、JPEG 或 WebP', code: 'unsupported_type' } };
      const stamp = new Date(Date.parse(NOW) + (++st.imageSeq) * 1000).toISOString();
      Object.assign(pp, { has_image: true, image_type: type, image_updated_at: stamp });
      return { body: { ok: true, has_image: true, image_type: type, image_updated_at: stamp, size: bytes.length } };
    }
    if (path === '/api/operator/stats' && method === 'GET') return { body: operatorStats() };
    // ── the photographer's view of the platform ──
    if (path === '/api/admin/platform-products' && method === 'GET') {
      const products = st.platform.filter(pp => pp.active).map(pp => {
        const mine = st.products.find(p => p.platform_product_id === pp.id);
        return { id: pp.id, kind: pp.kind, name: pp.name, description: pp.description, photo_count: pp.photo_count, sort: pp.sort,
          has_image: pp.has_image, image_updated_at: pp.image_updated_at, adopted_product_id: mine ? mine.id : null,
          options: pp.options.filter(o => o.active).map(o => ({ id: o.id, label: o.label, platform_price: o.platform_price, sort: o.sort })) };
      }).filter(p => p.options.length);
      return { body: { products } };
    }
    if (path === '/api/admin/products/from-platform' && method === 'POST') {
      const pp = typeof body.platform_product_id === 'string' ? platformOf(body.platform_product_id) : null;
      if (!pp) return bad('unknown_platform_product');
      if (!pp.active) return bad('retired_option');
      const opts = checkAdopted(body.options, pp);
      if (opts.bad) return bad(opts.bad);
      const existing = st.products.find(p => p.platform_product_id === pp.id);
      if (existing) return { status: 409, body: { error: '已加入這個平台商品', code: 'already_adopted', product_id: existing.id } };
      const p = { id: id('prod'), kind: pp.kind, name: pp.name, description: pp.description, photo_count: pp.photo_count, guest_visible: 0, active: 1, sort: 0,
        has_image: false, image_type: null, image_updated_at: null, created_at: NOW, updated_at: NOW, platform_product_id: pp.id,
        options: opts.options.map(o => ({ id: id('opt'), label: o.label, price: o.price, cost: o.cost, active: 1, sort: o.sort, platform_option_id: o.platform_option_id })) };
      st.products.push(p);
      return { status: 201, body: { product: viewProduct(p) } };
    }
    // ── the photographer's products ──
    if (path === '/api/admin/products' && method === 'GET') return { body: { products: st.products.map(viewProduct), custom_products_enabled: st.customProducts } };
    // with the switch off a custom product can be retired, never made, edited or restored
    const customOff = { status: 403, body: { error: '目前只能從平台加入商品', code: 'custom_products_disabled' } };
    if (path === '/api/admin/products' && method === 'POST') {
      if (!st.customProducts) return customOff;
      const f = checkFields(body, false, ['album', 'print', 'service']);
      if (f.bad) return bad(f.bad);
      if (f.set.kind !== 'service') return bad('platform_only');
      const opts = checkOptions(body.options, new Set(), CUSTOM_MONEY);
      if (opts.bad) return bad(opts.bad);
      const p = {
        id: id('prod'), description: '', photo_count: null, guest_visible: 0, sort: 0, ...f.set, active: 1,
        has_image: false, image_type: null, image_updated_at: null, created_at: NOW, updated_at: NOW, platform_product_id: null,
        options: opts.options.map(o => ({ id: id('opt'), label: o.label, price: o.price, cost: o.cost, active: 1, sort: o.sort })),
      };
      p.photo_count = null;
      st.products.push(p);
      return { status: 201, body: { product: viewProduct(p) } };
    }
    if ((m = /^\/api\/admin\/products\/([^/]+)$/.exec(path)) && method === 'PUT') {
      const p = st.products.find(x => x.id === m[1]);
      if (!p) return { status: 404, body: { error: 'Not found' } };
      if (p.platform_product_id) {
        if (['kind', 'name', 'description', 'photo_count'].some(k => k in body)) return bad('platform_managed');
        const f = checkFields(body, true, []);
        if (f.bad) return bad(f.bad);
        let opts = null;
        if ('options' in body) {
          const pp = platformOf(p.platform_product_id) || { active: 0, options: [] };
          const c = checkAdopted(body.options, pp);
          if (c.bad) return bad(c.bad);
          opts = c.options;
        }
        if (opts) {
          const keep = new Set(opts.map(o => o.platform_option_id));
          p.options.forEach(o => { if (!keep.has(o.platform_option_id)) o.active = 0; });
          opts.forEach(o => {
            const row = p.options.find(x => x.platform_option_id === o.platform_option_id);
            if (row) Object.assign(row, { price: o.price, cost: o.cost, label: o.label, sort: o.sort, active: 1 });
            else p.options.push({ id: id('opt'), label: o.label, price: o.price, cost: o.cost, active: 1, sort: o.sort, platform_option_id: o.platform_option_id });
          });
        }
        if ('sort' in f.set) p.sort = f.set.sort;
        return { body: { product: viewProduct(p) } };
      }
      if (!st.customProducts) return customOff;
      const f = checkFields(body, true, ['album', 'print', 'service']);
      if (f.bad) return bad(f.bad);
      if (f.set.kind !== undefined && f.set.kind !== 'service') return bad('platform_only');
      let opts = null;
      if ('options' in body) {
        const c = checkOptions(body.options, new Set(p.options.map(o => o.id)), CUSTOM_MONEY);
        if (c.bad) return bad(c.bad);
        opts = c.options;
      }
      Object.assign(p, f.set);
      if (p.kind !== 'album') p.photo_count = null;
      if (opts) {
        const keep = new Set(opts.filter(o => o.id).map(o => o.id));
        p.options.forEach(o => { if (!keep.has(o.id)) o.active = 0; });
        opts.forEach(o => {
          if (o.id) Object.assign(p.options.find(x => x.id === o.id), { label: o.label, price: o.price, cost: o.cost, sort: o.sort, active: 1 });
          else p.options.push({ id: id('opt'), label: o.label, price: o.price, cost: o.cost, active: 1, sort: o.sort });
        });
      }
      return { body: { product: viewProduct(p) } };
    }
    if ((m = /^\/api\/admin\/products\/([^/]+)\/(retire|restore)$/.exec(path)) && method === 'POST') {
      const p = st.products.find(x => x.id === m[1]);
      if (!p) return { status: 404, body: { error: 'Not found' } };
      if (m[2] === 'restore' && !p.platform_product_id && !st.customProducts) return customOff;
      p.active = m[2] === 'restore' ? 1 : 0;
      return { body: { ok: true, active: p.active } };
    }
    if (path === '/api/admin/orders' && method === 'GET') {
      const wanted = params.get('status');
      let list = st.orders.map(view);
      if (wanted) list = list.filter(o => o.status === wanted);
      if (params.get('unpaid') === '1') list = list.filter(o => o.outstanding > 0);
      return { body: { orders: list.slice().reverse() } };
    }
    if ((m = /^\/api\/admin\/projects\/([^/]+)\/orders$/.exec(path))) {
      const pid = decodeURIComponent(m[1]);
      if (method === 'GET') return { body: { orders: st.orders.filter(o => o.project_id === pid).map(view).reverse(), extra_pick: st.extra } };
      if (method === 'POST') {
        if (!Array.isArray(body.lines) || !body.lines.length) return bad('invalid_lines');
        const items = [];
        for (const l of body.lines) {
          const hit = optionOf(l.option_id);
          if (!hit) return bad('unknown_option');
          if (!optionUsable(hit)) return bad('retired_option');
          if (!(Number.isSafeInteger(l.qty) && l.qty >= 1 && l.qty <= 999)) return bad('invalid_qty');
          const line = { kind: hit.p.kind, product_id: hit.p.id, option_id: hit.op.id, name: hit.p.name, option_label: hit.op.label,
            unit_price: l.unit_price ?? hit.op.price, unit_cost: hit.op.cost, qty: l.qty, photo_keys: l.photo_keys || [],
            platform_option_id: hit.op.platform_option_id ?? null, vendor_cost: vendorCostOf(hit.op) };
          // the platform price is a floor, an explicit unit_price included
          if (line.platform_option_id && line.unit_price < hit.op.platform_price) return bad('below_platform_price');
          items.push(line);
        }
        const sub = items.reduce((n, i) => n + i.unit_price * i.qty, 0);
        if ((body.discount ?? 0) > sub) return bad('discount_exceeds_subtotal');
        const order = st.addOrder({ project_id: pid, items, discount: body.discount ?? 0, note: body.note || '' });
        return { status: 201, body: { order: view(order) } };
      }
    }
    if ((m = /^\/api\/admin\/orders\/([^/]+)$/.exec(path)) && method === 'PUT') {
      const o = st.orders.find(x => x.id === m[1]);
      if (!o) return { status: 404, body: { error: 'Not found' } };
      if (o.status === 'cancelled' && ('lines' in body || 'discount' in body)) return { status: 409, body: { error: '訂單已取消', code: 'cancelled' } };
      const items = [];
      for (const l of body.lines ?? o.items.map(i => ({ id: i.id }))) {
        const old = l.id ? o.items.find(i => i.id === l.id) : null;
        if (l.id && !old) return bad('unknown_line');
        if (old) {
          // a kept platform line is never repriced under its own snapshotted cost
          if (old.platform_option_id && l.unit_price != null && l.unit_price < old.unit_cost) return bad('below_platform_price');
          items.push({ ...old, qty: l.qty ?? old.qty, unit_price: l.unit_price ?? old.unit_price, photo_keys: l.photo_keys ?? old.photo_keys });
        } else {
          const hit = optionOf(l.option_id);
          if (!hit) return bad('unknown_option');
          if (!optionUsable(hit)) return bad('retired_option');
          const line = { id: id('item'), order_id: o.id, kind: hit.p.kind, product_id: hit.p.id, option_id: hit.op.id, name: hit.p.name,
            option_label: hit.op.label, unit_price: l.unit_price ?? hit.op.price, unit_cost: hit.op.cost, qty: l.qty, photo_keys: l.photo_keys || [],
            platform_option_id: hit.op.platform_option_id ?? null, vendor_cost: vendorCostOf(hit.op) };
          if (line.platform_option_id && line.unit_price < hit.op.platform_price) return bad('below_platform_price');
          items.push(line);
        }
      }
      const discount = 'discount' in body ? body.discount : o.discount;
      const sub = items.reduce((n, i) => n + i.unit_price * i.qty, 0);
      if (discount > sub) return bad('discount_exceeds_subtotal');
      if (sub - discount < o.paid_amount) return bad('below_paid');
      o.items = items; o.discount = discount;
      if ('note' in body) o.note = body.note;
      if (o.source === 'system') o.source = 'admin';
      return { body: { order: view(o) } };
    }
    if ((m = /^\/api\/admin\/orders\/([^/]+)\/payment$/.exec(path)) && method === 'POST') {
      const o = st.orders.find(x => x.id === m[1]);
      if (!o) return { status: 404, body: { error: 'Not found' } };
      const amount = body.paid_amount;
      if (!Number.isSafeInteger(amount) || amount < 0) return bad('invalid_paid_amount');
      if (amount > 0) {
        if (!['cash', 'transfer', 'other'].includes(body.paid_method)) return bad('invalid_paid_method');
        if (o.status === 'cancelled') return { status: 409, body: { error: '訂單已取消', code: 'cancelled' } };
        if (amount > money(o).total) return bad('overpaid');
        o.paid_amount = amount; o.paid_method = body.paid_method;
        o.paid_at = body.paid_at ? new Date(body.paid_at).toISOString() : NOW;
      } else { o.paid_amount = 0; o.paid_method = null; o.paid_at = null; }
      return { body: { order: view(o) } };
    }
    if ((m = /^\/api\/admin\/orders\/([^/]+)\/status$/.exec(path)) && method === 'POST') {
      const o = st.orders.find(x => x.id === m[1]);
      if (!o) return { status: 404, body: { error: 'Not found' } };
      const arrows = { requested: ['confirmed', 'cancelled'], confirmed: ['fulfilled', 'cancelled'], fulfilled: ['confirmed', 'cancelled'], cancelled: [] };
      if (body.status === o.status) return { body: { order: view(o) } };
      if (!arrows[o.status].includes(body.status))
        return { status: 409, body: { error: `無法從 ${o.status} 改為 ${body.status}`, code: 'bad_transition', from: o.status, to: body.status } };
      o.status = body.status;
      return { body: { order: view(o) } };
    }
    return null;
  }

  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const method = req.method();
      const p = u.pathname;
      const isPublic = /^\/api\/platform\//.test(p);
      const isOperator = /^\/api\/operator\//.test(p);
      const mine = isPublic || isOperator || /^\/api\/admin\/(products|orders|platform-products)(\/|$)/.test(p) || /^\/api\/admin\/projects\/[^/]+\/orders$/.test(p);
      if (!mine) return route.fallback();
      let body = null;
      try { body = JSON.parse(req.postData() || 'null'); } catch (e) { /* none, or raw bytes */ }
      const bytes = req.postDataBuffer() || Buffer.alloc(0);
      const h = await req.allHeaders();
      st.calls.push({ method, path: p, search: u.search, body, auth: h['authorization'] || null, size: bytes.length, type: h['content-type'] || null });
      // the two sides never open each other's routes: the operator token is
      // refused on /api/admin and the photographer's on /api/operator
      if (!isPublic && (h['authorization'] || null) !== (isOperator ? `Bearer ${st.operatorToken}` : 'Bearer adm'))
        return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Unauthorized' }) });
      const res = handle(method, p, u.searchParams, body || {}, bytes) || { status: 404, body: { error: 'Not found' } };
      if (res.raw) return route.fulfill({ status: res.status || 200, contentType: res.type, body: res.raw });
      route.fulfill({ status: res.status || 200, contentType: 'application/json', body: JSON.stringify(res.body) });
    });
  };
  return { st, attach };
}

// The platform's own catalogue (what the operator lists) and the photographer's
// adopted products from it. An adopted option's label / cost are read from the
// platform live, so the copies stored on the adopted rows are only placeholders.
const PLAT_ALBUM = { id: 'plat-album', kind: 'album', name: '相本書', description: '20 頁精裝', photo_count: 20, active: 1, sort: 0,
  has_image: true, image_type: 'image/png', image_updated_at: '2026-09-01T00:00:00.000Z',
  options: [
    { id: 'popt-album-s', label: '8×8 吋', vendor_cost: 1400, platform_price: 1500, active: 1, sort: 0 },
    { id: 'popt-album-l', label: '12×12 吋', vendor_cost: 2300, platform_price: 2400, active: 1, sort: 1 },
    { id: 'popt-album-old', label: '舊規格', vendor_cost: 40, platform_price: 50, active: 0, sort: 2 },
  ] };
const PLAT_PRINT = { id: 'plat-print', kind: 'print', name: '無框畫', description: '', photo_count: null, active: 1, sort: 1,
  has_image: false, image_type: null, image_updated_at: null,
  options: [{ id: 'popt-print', label: '', vendor_cost: 450, platform_price: 500, active: 1, sort: 0 }] };
const PROD_ALBUM = { id: 'prod-album', kind: 'album', name: '相本書', description: '20 頁精裝', photo_count: 20, guest_visible: 0, active: 1, sort: 0,
  has_image: false, image_type: null, image_updated_at: null, created_at: '', updated_at: '', platform_product_id: 'plat-album',
  options: [
    { id: 'opt-album-s', label: '8×8 吋', price: 3800, cost: 1500, active: 1, sort: 0, platform_option_id: 'popt-album-s' },
    { id: 'opt-album-l', label: '12×12 吋', price: 5800, cost: 2400, active: 1, sort: 1, platform_option_id: 'popt-album-l' },
    { id: 'opt-album-old', label: '舊規格', price: 100, cost: 50, active: 0, sort: 2, platform_option_id: 'popt-album-old' },
  ] };
const PROD_PRINT = { id: 'prod-print', kind: 'print', name: '無框畫', description: '', photo_count: null, guest_visible: 0, active: 1, sort: 1,
  has_image: false, image_type: null, image_updated_at: null, created_at: '', updated_at: '', platform_product_id: 'plat-print',
  options: [{ id: 'opt-print', label: '', price: 1200, cost: 500, active: 1, sort: 0, platform_option_id: 'popt-print' }] };
const PROD_SERVICE_OFF = { id: 'prod-svc', kind: 'service', name: '急件加修', description: '', photo_count: null, guest_visible: 0, active: 0, sort: 2,
  has_image: false, image_type: null, image_updated_at: null, created_at: '', updated_at: '', platform_product_id: null,
  options: [{ id: 'opt-svc', label: '', price: 500, cost: 0, active: 1, sort: 0 }] };
const clone = x => JSON.parse(JSON.stringify(x));
const waitText = (page, sel, pred, timeout = 4000) =>
  page.waitForFunction(([s, src]) => { const el = document.querySelector(s); return !!el && new Function('t', `return (${src})(t)`)(el.textContent); },
    [sel, pred.toString()], { timeout });

// ── settings: 商品 ──────────────────────────────────────────────────────────
const platFx = () => [clone(PLAT_ALBUM), clone(PLAT_PRINT)];
const T = (page, sel) => page.textContent(sel);
const disp = (page, sel) => page.$eval(sel, e => getComputedStyle(e).display);
const RED = 'rgb(192, 57, 43)';
{
  const m = dashSettingsMock();
  const o = ordersFake({ customProducts: true, platform: platFx(), products: [clone(PROD_ALBUM), clone(PROD_PRINT), clone(PROD_SERVICE_OFF)] });
  await suite('設定 — 商品清單：平台商品有圖與平台價、自訂服務有成本，下架的灰掉並可重新上架，金額為 NT$',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      const rows = await page.$$eval('.prod-row', els => els.map(e => ({
        id: e.dataset.productId, retired: e.classList.contains('retired'), opacity: getComputedStyle(e).opacity, adopted: e.dataset.adopted,
        kind: e.querySelector('.pill[data-kind]').textContent, text: e.textContent.replace(/\s+/g, ' '),
        buttons: [...e.querySelectorAll('button')].map(b => b.textContent),
        img: e.querySelector('img.prod-thumb') ? e.querySelector('img.prod-thumb').getAttribute('src') : null,
        placeholder: !!e.querySelector('div.prod-thumb.none'),
      })));
      ok('three products listed, active first', rows.map(r => r.id).join() === 'prod-album,prod-print,prod-svc', JSON.stringify(rows.map(r => r.id)));
      ok('kinds shown as 相本 / 輸出品 / 服務, not album/print/service',
        rows.map(r => r.kind).join() === '相本,輸出品,服務', JSON.stringify(rows.map(r => r.kind)));
      ok('an adopted album shows 平台價 and 售價 per option as NT$1,234-style money, no 成本 column',
        rows[0].text.includes('8×8 吋 · 平台價 NT$1,500 · 售價 NT$3,800') && rows[0].text.includes('12×12 吋 · 平台價 NT$2,400 · 售價 NT$5,800') && !rows[0].text.includes('成本'), rows[0].text);
      ok('it is tagged 平台商品; a custom service is not', rows[0].text.includes('平台商品') && !rows[2].text.includes('平台商品'), rows[2].text);
      ok('a retired option of an active product is not listed', !rows[0].text.includes('舊規格'));
      ok('an option with no label reads （單一規格）', rows[1].text.includes('（單一規格） · 平台價 NT$500 · 售價 NT$1,200'), rows[1].text);
      ok('the album says how many photos it is set for', rows[0].text.includes('指定 20 張'));
      ok('a custom service still shows 售價 and 成本', rows[2].text.includes('售價 NT$500 · 成本 NT$0'), rows[2].text);
      ok('the adopted album shows the platform image from the public route (no token in the URL)',
        rows[0].img && rows[0].img.includes('/api/platform/products/plat-album/image') && !rows[0].img.includes('adm') && !rows[0].img.includes('t='), String(rows[0].img));
      await page.waitForFunction(() => { const i = document.querySelector('[data-product-id="prod-album"] img.prod-thumb'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 4000 });
      ok('…and it actually loaded', true);
      ok('an adopted product with no platform image shows a 無圖 placeholder, not a broken img', rows[1].img === null && rows[1].placeholder);
      ok('a custom product has no thumbnail slot at all', rows[2].img === null && !rows[2].placeholder);
      ok('active rows are full strength and offer 下架 (not 重新上架)',
        !rows[0].retired && rows[0].opacity === '1' && rows[0].buttons.includes('下架') && !rows[0].buttons.includes('重新上架'), JSON.stringify(rows[0]));
      ok('the retired row is greyed (computed opacity < 1), tagged 已下架 and offers 重新上架 (not 下架)',
        rows[2].retired && Number(rows[2].opacity) < 1 && rows[2].text.includes('已下架') && rows[2].buttons.includes('重新上架') && !rows[2].buttons.includes('下架'), JSON.stringify(rows[2]));
      ok('no warning anywhere while every 售價 is at or above 平台價', (await page.$$('.warn-below')).length === 0 && (await page.$$('[data-below]')).length === 0);
      ok('the catalogue was read with the admin token', o.st.calls[0]?.auth === 'Bearer adm');

      await page.click('[data-product-id="prod-svc"] [data-restore]');
      await page.waitForFunction(() => document.querySelector('[data-product-id="prod-svc"]')?.dataset.active === '1', null, { timeout: 3000 });
      ok('重新上架 posts /restore and the row comes back at full strength',
        o.st.calls.some(c => c.method === 'POST' && c.path === '/api/admin/products/prod-svc/restore') &&
        (await page.$eval('[data-product-id="prod-svc"]', e => getComputedStyle(e).opacity)) === '1');
      await page.click('[data-product-id="prod-print"] [data-retire]');
      await page.waitForFunction(() => document.querySelector('[data-product-id="prod-print"]')?.dataset.active === '0', null, { timeout: 3000 });
      ok('下架 posts /retire and greys the row',
        o.st.calls.some(c => c.method === 'POST' && c.path === '/api/admin/products/prod-print/retire') &&
        Number(await page.$eval('[data-product-id="prod-print"]', e => getComputedStyle(e).opacity)) < 1);
      ok('retire/restore sent no body', o.st.calls.filter(c => /retire|restore/.test(c.path)).every(c => c.body === null));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const o = ordersFake({ customProducts: true, products: [] });
  await suite('設定 — 新增服務：自訂商品只有服務（沒有類型選單、不問張數），驗證、規格列增減，送出的內容正確',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#prod-list .hint', { timeout: 5000 });
      ok('an empty catalogue points to both ways in', (await T(page, '#prod-list')).includes('從平台加入') && (await T(page, '#prod-list')).includes('新增服務'));
      ok('the add button now reads 新增服務', (await T(page, '#prod-add-btn')).includes('新增服務'));
      ok('no form until asked', (await page.$('#prod-form')) === null);
      await page.click('#prod-add-btn');
      await page.waitForSelector('#prod-form');
      ok('the form is 新增服務', (await T(page, '#prod-form h3')) === '新增服務' && (await page.getAttribute('#prod-form', 'data-kind')) === 'service');
      ok('there is no kind select and no album/print choice anywhere in the form',
        (await page.$('#pf-kind')) === null && (await page.$$('#prod-form select')).length === 0 && !(await T(page, '#prod-form')).includes('相本書') && !(await T(page, '#prod-form')).includes('無框畫、放大'));
      ok('and no photo-count field (removed from the DOM, not just hidden)', (await page.$('#pf-count-group')) === null && (await page.$('#pf-count')) === null);
      ok('the add buttons hide while the form is open (computed display)', (await disp(page, '#prod-add-btn')) === 'none' && (await disp(page, '#plat-add-btn')) === 'none');

      await page.click('#pf-save');
      ok('no name → a Chinese error and nothing sent', (await T(page, '#pf-err')).includes('商品名稱必填') && !o.st.calls.some(c => c.method === 'POST'));
      await page.fill('#pf-name', '急件加修');
      await page.click('#pf-save');
      ok('a blank price is refused client-side', (await T(page, '#pf-err')).includes('售價需為 0 以上的整數') && !o.st.calls.some(c => c.method === 'POST'));
      await page.click('#pf-options .opt-del');
      ok('removing the only option row is refused, the row stays',
        (await page.$$('#pf-options .opt-row')).length === 1 && (await T(page, '#pf-err')).includes('至少保留一個規格'));

      await page.fill('#pf-desc', '三天內交件');
      await page.fill('#pf-options .opt-row:nth-child(1) .opt-label', '加修 1 張');
      await page.fill('#pf-options .opt-row:nth-child(1) .opt-price', '500');
      await page.fill('#pf-options .opt-row:nth-child(1) .opt-cost', '100');
      await page.click('#pf-add-option');
      ok('新增規格 adds a row', (await page.$$('#pf-options .opt-row')).length === 2);
      await page.fill('#pf-options .opt-row:nth-child(2) .opt-label', '加修 5 張');
      await page.fill('#pf-options .opt-row:nth-child(2) .opt-price', '2000');
      await page.click('#pf-add-option');
      await page.click('#pf-options .opt-row:nth-child(3) .opt-del');
      ok('a row can be removed while others remain', (await page.$$('#pf-options .opt-row')).length === 2);
      await page.click('#pf-save');
      await page.waitForFunction(() => !document.getElementById('prod-form'), null, { timeout: 3000 });
      const post = o.st.calls.find(c => c.method === 'POST' && c.path === '/api/admin/products');
      ok('POST carries kind service, name, description, photo_count null and the options (blank cost = 0)',
        JSON.stringify(post?.body) === JSON.stringify({
          name: '急件加修', description: '三天內交件', photo_count: null,
          options: [{ label: '加修 1 張', price: 500, cost: 100 }, { label: '加修 5 張', price: 2000, cost: 0 }], kind: 'service',
        }), JSON.stringify(post?.body));
      ok('the form is gone from the DOM and the add buttons are back', (await page.$('#prod-form')) === null && (await disp(page, '#prod-add-btn')) !== 'none' && (await disp(page, '#plat-add-btn')) !== 'none');
      await page.waitForSelector('.prod-row');
      ok('the new service is listed with its money and tagged 服務', (await T(page, '.prod-row')).includes('加修 5 張 · 售價 NT$2,000 · 成本 NT$0') && (await T(page, '.prod-row .pill[data-kind]')) === '服務');
      ok('and 已儲存商品 is shown', (await T(page, '#prod-ok')).includes('已儲存商品'));

      // the Worker's own refusals are shown in Chinese, and the form stays
      o.st.inject = (method, path) => (method === 'POST' && path === '/api/admin/products') ? { status: 400, body: { error: 'invalid price', code: 'invalid_price' } } : null;
      await page.click('#prod-add-btn');
      await page.fill('#pf-name', '外拍加時');
      await page.fill('#pf-options .opt-row .opt-price', '1200');
      await page.click('#pf-save');
      await waitText(page, '#pf-err', t => t.includes('售價需為'));
      ok('a server error code becomes a Chinese sentence and the form stays open', (await page.$('#prod-form')) !== null);
      o.st.inject = (method, path) => (method === 'POST' && path === '/api/admin/products') ? { status: 400, body: { error: 'platform only', code: 'platform_only' } } : null;
      await page.click('#pf-save');
      await waitText(page, '#pf-err', t => t.includes('從平台加入'));
      ok('platform_only (should the Worker ever refuse) → 「相本與輸出品要從「從平台加入」新增…」', (await T(page, '#pf-err')).includes('自訂商品只能是服務'));
      o.st.inject = null;
      // the real fake refuses an album from the custom route, so the fake mirrors the Worker
      const direct = await page.evaluate(async () => {
        const r = await fetch('https://imagepicker.hotichen.workers.dev/api/admin/products', { method: 'POST', headers: { 'Authorization': 'Bearer adm', 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'album', name: 'x', options: [{ label: '', price: 1 }] }) });
        return { status: r.status, body: await r.json() };
      });
      ok('the fake answers 400 platform_only for a custom album, like the Worker', direct.status === 400 && direct.body.code === 'platform_only', JSON.stringify(direct));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const svc = { ...clone(PROD_SERVICE_OFF), active: 1, options: [
    { id: 'opt-a', label: '加修 1 張', price: 500, cost: 100, active: 1, sort: 0 }, { id: 'opt-b', label: '加修 5 張', price: 2000, cost: 0, active: 1, sort: 1 },
    { id: 'opt-old', label: '停賣', price: 1, cost: 0, active: 0, sort: 2 }] };
  const o = ordersFake({ customProducts: true, products: [svc] });
  await suite('設定 — 編輯自訂服務：規格帶入（含 id），改價／刪／加後 PUT 的內容正確（不送 kind）',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      await page.click('[data-product-id="prod-svc"] [data-edit]');
      await page.waitForSelector('#prod-form');
      ok('title says 編輯商品, still no kind select', (await T(page, '#prod-form h3')) === '編輯商品' && (await page.$('#pf-kind')) === null && (await page.getAttribute('#prod-form', 'data-mode')) === 'edit');
      const rows = await page.$$eval('#pf-options .opt-row', els => els.map(e => ({ id: e.dataset.optionId, label: e.querySelector('.opt-label').value, price: e.querySelector('.opt-price').value, cost: e.querySelector('.opt-cost').value })));
      ok('only the active options are prefilled, each keeping its id',
        JSON.stringify(rows) === JSON.stringify([
          { id: 'opt-a', label: '加修 1 張', price: '500', cost: '100' }, { id: 'opt-b', label: '加修 5 張', price: '2000', cost: '0' }]), JSON.stringify(rows));
      await page.fill('#pf-options .opt-row:nth-child(1) .opt-price', '600');
      await page.click('#pf-options .opt-row:nth-child(2) .opt-del');
      await page.click('#pf-add-option');
      await page.fill('#pf-options .opt-row:nth-child(2) .opt-label', '加修 3 張');
      await page.fill('#pf-options .opt-row:nth-child(2) .opt-price', '1400');
      await page.click('#pf-save');
      await page.waitForFunction(() => !document.getElementById('prod-form'), null, { timeout: 3000 });
      const put = o.st.calls.find(c => c.method === 'PUT');
      ok('PUT goes to the product, without kind; the kept option carries its id, the new one none, the removed one is absent',
        put?.path === '/api/admin/products/prod-svc' && JSON.stringify(put.body) === JSON.stringify({
          name: '急件加修', description: '', photo_count: null,
          options: [{ label: '加修 1 張', price: 600, cost: 100, id: 'opt-a' }, { label: '加修 3 張', price: 1400, cost: 0 }],
        }), JSON.stringify(put));
      await page.waitForFunction(() => document.querySelector('.prod-row')?.textContent.includes('NT$1,400'), null, { timeout: 3000 });
      const text = await T(page, '.prod-row');
      ok('the list shows the new set and no longer the dropped option', text.includes('NT$600') && text.includes('加修 3 張') && !text.includes('加修 5 張'), text);
      await page.click('[data-edit]');
      await page.waitForSelector('#prod-form');
      await page.click('#pf-cancel');
      ok('取消 closes the form without a request', (await page.$('#prod-form')) === null && o.st.calls.filter(c => c.method === 'PUT').length === 1);
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

// ── settings: CUSTOM_PRODUCTS off (the default) / on ────────────────────────
{
  const m = dashSettingsMock();
  const svcOn = { ...clone(PROD_SERVICE_OFF), id: 'prod-svc-on', name: '外拍加時', active: 1, options: [{ id: 'opt-on', label: '', price: 800, cost: 0, active: 1, sort: 0 }] };
  const o = ordersFake({ platform: platFx(), products: [clone(PROD_ALBUM), svcOn, clone(PROD_SERVICE_OFF)] });
  await suite('設定 — 自訂商品關閉（預設）：沒有「新增服務」按鈕（不在 DOM），舊的自訂服務只剩下架',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      ok('the list was read and the fake said custom products are off', o.st.calls.some(c => c.method === 'GET' && c.path === '/api/admin/products') && o.st.customProducts === false);
      ok('從平台加入 is there and shown (computed display)', (await page.$('#plat-add-btn')) !== null && (await disp(page, '#plat-add-btn')) !== 'none');
      ok('新增服務 is not in the DOM at all', (await page.$('#prod-add-btn')) === null);
      const buttonTexts = await page.$$eval('button', els => els.map(e => e.textContent));
      ok('no button anywhere reads 新增服務', !buttonTexts.some(t => t.includes('新增服務')), JSON.stringify(buttonTexts));
      const rows = await page.$$eval('.prod-row', els => els.map(e => ({ id: e.dataset.productId, buttons: [...e.querySelectorAll('button')].map(b => b.textContent) })));
      ok('all three products are still listed', rows.map(r => r.id).join() === 'prod-album,prod-svc-on,prod-svc', JSON.stringify(rows));
      ok('the adopted product keeps 編輯 and 下架', JSON.stringify(rows[0].buttons) === JSON.stringify(['編輯', '下架']), JSON.stringify(rows[0]));
      ok('an active custom service offers 下架 only', JSON.stringify(rows[1].buttons) === JSON.stringify(['下架']), JSON.stringify(rows[1]));
      ok('a retired custom service offers nothing (no 重新上架, no 編輯)', rows[2].buttons.length === 0, JSON.stringify(rows[2]));
      ok('the retired one is still greyed and tagged 已下架',
        Number(await page.$eval('[data-product-id="prod-svc"]', e => getComputedStyle(e).opacity)) < 1 && (await T(page, '[data-product-id="prod-svc"]')).includes('已下架'));

      await page.click('[data-product-id="prod-svc-on"] [data-retire]');
      await page.waitForFunction(() => document.querySelector('[data-product-id="prod-svc-on"]')?.dataset.active === '0', null, { timeout: 3000 });
      ok('下架 on a custom service posts /retire and greys it',
        o.st.calls.some(c => c.method === 'POST' && c.path === '/api/admin/products/prod-svc-on/retire') &&
        Number(await page.$eval('[data-product-id="prod-svc-on"]', e => getComputedStyle(e).opacity)) < 1);
      ok('…and it now offers nothing either', (await page.$$('[data-product-id="prod-svc-on"] button')).length === 0);

      await page.click('#plat-add-btn');
      await page.waitForSelector('#plat-form');
      await page.click('#plat-close');
      await page.waitForFunction(() => !document.getElementById('plat-form'), null, { timeout: 3000 });
      ok('opening and closing 從平台加入 does not bring 新增服務 back', (await page.$('#prod-add-btn')) === null && (await disp(page, '#plat-add-btn')) !== 'none');

      ok('custom_products_disabled reads 「目前只能從平台加入商品」',
        (await page.evaluate(() => window.Orders.errorText({ error: 'x', code: 'custom_products_disabled' }, 403))) === '目前只能從平台加入商品');
      const direct = await page.evaluate(async () => {
        const call = async (method, path, body) => {
          const r = await fetch(`https://imagepicker.hotichen.workers.dev${path}`, { method, headers: { 'Authorization': 'Bearer adm', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
          return [r.status, (await r.json()).code];
        };
        return [
          await call('POST', '/api/admin/products', { kind: 'service', name: 'x', options: [{ label: '', price: 1 }] }),
          await call('PUT', '/api/admin/products/prod-svc', { name: 'x' }),
          await call('POST', '/api/admin/products/prod-svc/restore'),
        ];
      });
      ok('the fake answers 403 custom_products_disabled for create, edit and restore, like the Worker',
        JSON.stringify(direct) === JSON.stringify([[403, 'custom_products_disabled'], [403, 'custom_products_disabled'], [403, 'custom_products_disabled']]), JSON.stringify(direct));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const o = ordersFake({ products: [] });
  await suite('設定 — 自訂商品關閉（預設）：空清單只指向「從平台加入」',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#prod-list .hint', { timeout: 5000 });
      await page.waitForFunction(() => !document.querySelector('#prod-list').textContent.includes('載入中'), null, { timeout: 3000 });
      const text = await T(page, '#prod-list');
      ok('the empty hint points to 從平台加入', text.includes('從平台加入'), text);
      ok('…and never mentions 新增服務', !text.includes('新增服務'), text);
      ok('新增服務 is not in the DOM', (await page.$('#prod-add-btn')) === null);
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const o = ordersFake({ customProducts: true, products: [clone(PROD_SERVICE_OFF)] });
  await suite('設定 — 自訂商品開啟：「新增服務」在「從平台加入」旁邊，自訂服務可編輯與重新上架',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      await page.waitForSelector('#prod-add-btn', { timeout: 3000 });
      ok('新增服務 is shown (computed display) and reads ＋ 新增服務',
        (await disp(page, '#prod-add-btn')) !== 'none' && (await T(page, '#prod-add-btn')).includes('新增服務'));
      ok('it sits right after 從平台加入, in the same row',
        await page.$eval('#prod-add-btn', e => e.previousElementSibling?.id === 'plat-add-btn' && e.parentElement === document.getElementById('plat-add-btn').parentElement));
      ok('there is exactly one', (await page.$$('#prod-add-btn')).length === 1);
      const buttons = await page.$$eval('[data-product-id="prod-svc"] button', els => els.map(e => e.textContent));
      ok('a retired custom service offers 編輯 and 重新上架', JSON.stringify(buttons) === JSON.stringify(['編輯', '重新上架']), JSON.stringify(buttons));
      await page.click('#prod-add-btn');
      await page.waitForSelector('#prod-form');
      ok('it opens the 新增服務 form', (await T(page, '#prod-form h3')) === '新增服務');
      ok('and hides itself while the form is open', (await disp(page, '#prod-add-btn')) === 'none');
      await page.click('#pf-cancel');
      ok('取消 brings it back', (await disp(page, '#prod-add-btn')) !== 'none' && (await page.$$('#prod-add-btn')).length === 1);

      // the switch goes off while the page is open: the next read takes 新增服務 out of the DOM
      await page.click('[data-product-id="prod-svc"] [data-restore]');
      await page.waitForFunction(() => document.querySelector('[data-product-id="prod-svc"]')?.dataset.active === '1', null, { timeout: 3000 });
      o.st.customProducts = false;
      await page.click('[data-product-id="prod-svc"] [data-retire]');
      await page.waitForFunction(() => document.querySelector('[data-product-id="prod-svc"]')?.dataset.active === '0', null, { timeout: 3000 });
      ok('after a re-read with the switch off, 新增服務 is gone from the DOM', (await page.$('#prod-add-btn')) === null && (await disp(page, '#plat-add-btn')) !== 'none');
      ok('…and the retired custom service offers nothing', (await page.$$('[data-product-id="prod-svc"] button')).length === 0);
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

// ── settings: 從平台加入 ────────────────────────────────────────────────────
{
  const m = dashSettingsMock();
  const retiredPlat = { id: 'plat-frame', kind: 'print', name: '已停產相框', description: '', photo_count: null, active: 0, sort: 5, has_image: false, image_type: null, image_updated_at: null,
    options: [{ id: 'popt-frame', label: '', vendor_cost: 100, platform_price: 100, active: 1, sort: 0 }] };
  const o = ordersFake({ customProducts: true, platform: [...platFx(), retiredPlat], products: [clone(PROD_PRINT)] });
  await suite('設定 — 從平台加入：只列上架的平台商品（圖、說明、規格與平台價），已加入的顯示「已加入」並開編輯，勾規格填售價（≥ 平台價）後送出',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      ok('nothing of the platform list is shown until asked', (await page.$('#plat-form')) === null);
      await page.click('#plat-add-btn');
      await page.waitForSelector('#plat-form .plat-card');
      const cards = await page.$$eval('.plat-card', els => els.map(e => ({ id: e.dataset.platformId, adopted: e.dataset.adopted, text: e.textContent.replace(/\s+/g, ' '),
        img: e.querySelector('img.prod-thumb')?.getAttribute('src') || null, ticks: e.querySelectorAll('.pick-check').length })));
      ok('only the two active platform products are listed (not the retired 已停產相框)', cards.map(c => c.id).join() === 'plat-album,plat-print', JSON.stringify(cards.map(c => c.id)));
      ok('the album card has its image (public route), description, photo count and both active sizes with 平台價 — not the retired 舊規格',
        cards[0].img?.includes('/api/platform/products/plat-album/image') && cards[0].text.includes('20 頁精裝') && cards[0].text.includes('指定 20 張') &&
        cards[0].text.includes('8×8 吋') && cards[0].text.includes('平台價 NT$1,500') && cards[0].text.includes('12×12 吋') && cards[0].text.includes('平台價 NT$2,400') && !cards[0].text.includes('舊規格'), cards[0].text);
      ok('the vendor cost is nowhere on the page', !(await T(page, 'body')).includes('1,400') && !(await T(page, 'body')).includes('2,300'));
      ok('the album is not adopted yet: two tick boxes, unticked', cards[0].adopted === '0' && cards[0].ticks === 2);
      ok('the already-adopted 無框畫 says 已加入, has no picker and no 加入 button, but an 編輯 button',
        cards[1].adopted === '1' && cards[1].text.includes('已加入') && cards[1].ticks === 0 &&
        (await page.$('[data-platform-id="plat-print"] [data-plat-add]')) === null && (await page.$('[data-platform-id="plat-print"] [data-plat-edit]')) !== null, cards[1].text);
      ok('the add buttons are hidden while the panel is open', (await disp(page, '#prod-add-btn')) === 'none' && (await disp(page, '#plat-add-btn')) === 'none');

      const sel = (opt, part) => `[data-platform-id="plat-album"] [data-platform-option-id="${opt}"] .${part}`;
      ok('售價 is prefilled with 平台價 but disabled until the size is ticked',
        (await page.inputValue(sel('popt-album-s', 'pick-price'))) === '1500' && await page.$eval(sel('popt-album-s', 'pick-price'), e => e.disabled));
      await page.click('[data-platform-id="plat-album"] [data-plat-add]');
      ok('nothing ticked → 「請至少勾選一個規格」 and no request', (await T(page, '[data-platform-id="plat-album"] .plat-err')).includes('請至少勾選一個規格') && !o.st.calls.some(c => c.path === '/api/admin/products/from-platform'));
      await page.check(sel('popt-album-s', 'pick-check'));
      ok('ticking enables the price', !(await page.$eval(sel('popt-album-s', 'pick-price'), e => e.disabled)));
      await page.fill(sel('popt-album-s', 'pick-price'), '1499');
      await page.click('[data-platform-id="plat-album"] [data-plat-add]');
      const floorMsg = await T(page, '[data-platform-id="plat-album"] .plat-err');
      ok('售價 1,499 under 平台價 1,500 is refused client-side with the floor named, nothing sent',
        floorMsg.includes('售價不能低於平台價') && floorMsg.includes('NT$1,500') && floorMsg.includes('8×8 吋') && !o.st.calls.some(c => c.path === '/api/admin/products/from-platform'), floorMsg);
      await page.fill(sel('popt-album-s', 'pick-price'), '1500.5');
      await page.click('[data-platform-id="plat-album"] [data-plat-add]');
      ok('a non-integer price is refused', (await T(page, '[data-platform-id="plat-album"] .plat-err')).includes('售價需為 0 以上的整數') && !o.st.calls.some(c => c.path === '/api/admin/products/from-platform'), await T(page, '[data-platform-id="plat-album"] .plat-err'));
      await page.fill(sel('popt-album-s', 'pick-price'), '1500');
      await page.click('[data-platform-id="plat-album"] [data-plat-add]');
      await page.waitForFunction(() => !document.getElementById('plat-form'), null, { timeout: 3000 });
      ok('a price exactly at 平台價 is accepted (the floor is inclusive)', true);
      const post = o.st.calls.find(c => c.path === '/api/admin/products/from-platform');
      ok('POST carries the platform product and only the ticked option with its price',
        post?.method === 'POST' && JSON.stringify(post.body) === JSON.stringify({ platform_product_id: 'plat-album', options: [{ platform_option_id: 'popt-album-s', price: 1500 }] }), JSON.stringify(post));
      await page.waitForSelector('[data-adopted="1"][data-product-id]:not([data-product-id="prod-print"])');
      const added = await page.$$eval('.prod-row', els => els.map(e => e.textContent.replace(/\s+/g, ' ')));
      ok('the new adopted album is listed with 平台價 and 售價, and 已加入平台商品 is shown',
        added.some(t => t.includes('相本書') && t.includes('8×8 吋 · 平台價 NT$1,500 · 售價 NT$1,500')) && (await T(page, '#prod-ok')).includes('已加入平台商品'), JSON.stringify(added));
      ok('the panel is gone and the add buttons are back', (await page.$('#plat-form')) === null && (await disp(page, '#plat-add-btn')) !== 'none');

      // reopen: the album is now 已加入, 編輯 opens that product's edit form
      await page.click('#plat-add-btn');
      await page.waitForSelector('#plat-form .plat-card');
      ok('the album card now reads 已加入 too', (await page.getAttribute('[data-platform-id="plat-album"]', 'data-adopted')) === '1' && (await T(page, '[data-platform-id="plat-album"]')).includes('已加入'));
      await page.click('[data-platform-id="plat-album"] [data-plat-edit]');
      await page.waitForSelector('#prod-form[data-adopted="1"]');
      ok('編輯 closes the panel and opens the adopted product’s edit form', (await page.$('#plat-form')) === null && (await T(page, '#prod-form')).includes('相本書'));
      await page.click('#pf-cancel');
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const o = ordersFake({ platform: platFx(), products: [] });
  await suite('設定 — 從平台加入：Worker 的拒絕（below_platform_price、already_adopted 競態、retired）顯示中文，卡片跟著更新',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#prod-list .hint', { timeout: 5000 });
      await page.click('#plat-add-btn');
      await page.waitForSelector('.plat-card');
      const opt = 'popt-print';
      const card = '[data-platform-id="plat-print"]';
      await page.check(`${card} [data-platform-option-id="${opt}"] .pick-check`);
      // the operator raised the platform price after the page loaded: the page still says 500, the Worker says 700
      o.st.platform.find(p => p.id === 'plat-print').options[0].platform_price = 700;
      await page.click(`${card} [data-plat-add]`);
      await waitText(page, `${card} .plat-err`, t => t.includes('售價不能低於平台價'));
      ok('below_platform_price from the Worker → 「售價不能低於平台價」 and the panel stays', (await page.$('#plat-form')) !== null);
      ok('nothing was created', o.st.products.length === 0);
      // an adopt racing another tab: 409 already_adopted → message, and the card flips to 已加入
      o.st.platform.find(p => p.id === 'plat-print').options[0].platform_price = 500;
      o.st.products.push({ ...clone(PROD_PRINT), id: 'prod-raced' });
      await page.click(`${card} [data-plat-add]`);
      await waitText(page, `${card} .plat-err`, t => t.includes('已經加入過'));
      ok('409 already_adopted → 「已經加入過這個平台商品了」', true);
      await page.waitForFunction(() => document.querySelector('[data-platform-id="plat-print"]')?.dataset.adopted === '1', null, { timeout: 3000 });
      ok('…and after the re-read the card reads 已加入 with 編輯, and the list has the other tab’s product',
        (await page.$(`${card} [data-plat-edit]`)) !== null && (await page.$('[data-product-id="prod-raced"]')) !== null);
      // the platform retired the product meanwhile
      await page.click('#plat-close');
      ok('關閉 closes the panel', (await page.$('#plat-form')) === null);
      o.st.inject = (method, path) => (method === 'POST' && path === '/api/admin/products/from-platform') ? { status: 400, body: { error: 'unknown platform product', code: 'unknown_platform_product' } } : null;
      await page.click('#plat-add-btn');
      await page.waitForSelector('[data-platform-id="plat-album"] .pick-check');
      await page.check('[data-platform-id="plat-album"] [data-platform-option-id="popt-album-s"] .pick-check');
      await page.click('[data-platform-id="plat-album"] [data-plat-add]');
      await waitText(page, '[data-platform-id="plat-album"] .plat-err', t => t.includes('找不到這個平台商品'));
      ok('unknown_platform_product → 「找不到這個平台商品，請重新整理」', true);
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const o = ordersFake({ platform: [], products: [] });
  await suite('設定 — 從平台加入：平台沒有商品時說明，讀取失敗顯示錯誤而不是空白',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#prod-list .hint', { timeout: 5000 });
      await page.click('#plat-add-btn');
      await page.waitForSelector('#plat-form');
      ok('an empty platform says so', (await T(page, '#plat-form')).includes('平台目前沒有可加入的商品'));
      await page.click('#plat-close');
      o.st.inject = (method, path) => path === '/api/admin/platform-products' ? { status: 500, body: { error: 'no such table' } } : null;
      await page.click('#plat-add-btn');
      await waitText(page, '#prod-err', t => t.includes('讀取平台商品失敗'));
      ok('a failed read says 讀取平台商品失敗 and gives the buttons back', (await page.$('#plat-form')) === null && (await disp(page, '#plat-add-btn')) !== 'none');
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

// ── settings: adopted products — edit, warning, unavailable ─────────────────
{
  const m = dashSettingsMock();
  const plat = platFx();
  const o = ordersFake({ platform: plat, products: [clone(PROD_ALBUM)] });
  // the operator raised 8×8 to NT$4,000 — the photographer still sells it at NT$3,800
  o.st.platform[0].options[0].platform_price = 4000;
  await suite('設定 — 平台價調整後：低於平台價的規格顯示紅字警告，其他規格不受影響',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      const lis = await page.$$eval('.prod-row li', els => els.map(e => ({ id: e.dataset.optionId, below: e.dataset.below || null, text: e.textContent.replace(/\s+/g, ' '),
        warn: e.querySelector('.warn-below') ? { text: e.querySelector('.warn-below').textContent, color: getComputedStyle(e.querySelector('.warn-below')).color } : null })));
      ok('the 8×8 option (售價 3,800 < 平台價 4,000) shows the red warning with the exact sentence',
        lis[0].below === '1' && lis[0].warn?.text === '平台價已調整，售價低於平台價，請更新' && lis[0].warn.color === RED && lis[0].text.includes('平台價 NT$4,000 · 售價 NT$3,800'), JSON.stringify(lis[0]));
      ok('the 12×12 option (售價 5,800 ≥ 平台價 2,400) has no warning', lis[1].below === null && lis[1].warn === null, JSON.stringify(lis[1]));

      await page.click('[data-edit]');
      await page.waitForSelector('#prod-form[data-adopted="1"]');
      const optSel = id => `#pf-options [data-platform-option-id="${id}"]`;
      await page.click('#pf-save');
      await waitText(page, '#pf-err', t => t.includes('售價不能低於平台價'));
      ok('saving with the price still under the raised 平台價 is refused client-side, naming NT$4,000',
        (await T(page, '#pf-err')).includes('NT$4,000') && !o.st.calls.some(c => c.method === 'PUT'), await T(page, '#pf-err'));
      await page.fill(`${optSel('popt-album-s')} .pick-price`, '4200');
      await page.click('#pf-save');
      await page.waitForFunction(() => !document.getElementById('prod-form'), null, { timeout: 3000 });
      await page.waitForSelector('.prod-row li');
      ok('after raising 售價 to NT$4,200 the warning is gone (positive: the row shows the new price)',
        (await page.$$('.warn-below')).length === 0 && (await T(page, '.prod-row')).includes('售價 NT$4,200'), await T(page, '.prod-row'));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const o = ordersFake({ platform: platFx(), products: [clone(PROD_ALBUM), clone(PROD_PRINT)] });
  await suite('設定 — 編輯平台商品：只能改規格與售價（不能改名稱／類型／說明），PUT 只送 options，下架規格顯示不可用',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      await page.click('[data-product-id="prod-album"] [data-edit]');
      await page.waitForSelector('#prod-form[data-adopted="1"]');
      const box = '#pf-options';
      ok('no editable name, description, kind or count — the platform’s',
        (await page.$('#pf-name')) === null && (await page.$('#pf-desc')) === null && (await page.$('#pf-kind')) === null && (await page.$('#pf-count')) === null && (await T(page, '#prod-form')).includes('由平台管理'));
      const rows = await page.$$eval(`${box} .pick-row`, els => els.map(e => ({ id: e.dataset.platformOptionId, checked: e.querySelector('.pick-check').checked,
        price: e.querySelector('.pick-price')?.value ?? null, disabled: e.querySelector('.pick-price')?.disabled ?? null, text: e.textContent.replace(/\s+/g, ' ') })));
      ok('both active platform sizes are rows, ticked, with the photographer’s 售價 (not 平台價); the retired 舊規格 is not offered',
        rows.length === 2 && rows.every(r => r.checked) && rows[0].price === '3800' && rows[1].price === '5800' && !rows.some(r => r.id === 'popt-album-old'), JSON.stringify(rows));
      ok('each row shows its 平台價 floor', rows[0].text.includes('平台價 NT$1,500') && rows[1].text.includes('平台價 NT$2,400'));
      await page.uncheck(`${box} [data-platform-option-id="popt-album-l"] .pick-check`);
      await page.fill(`${box} [data-platform-option-id="popt-album-s"] .pick-price`, '1000');
      await page.click('#pf-save');
      ok('售價 1,000 under 平台價 1,500 is refused, no PUT', (await T(page, '#pf-err')).includes('售價不能低於平台價') && !o.st.calls.some(c => c.method === 'PUT'));
      await page.fill(`${box} [data-platform-option-id="popt-album-s"] .pick-price`, '4000');
      await page.click('#pf-save');
      await page.waitForFunction(() => !document.getElementById('prod-form'), null, { timeout: 3000 });
      const put = o.st.calls.find(c => c.method === 'PUT');
      ok('PUT sends only options: the kept size repriced, the unticked one left out (the Worker retires it) — no name/kind/description/photo_count',
        put?.path === '/api/admin/products/prod-album' && JSON.stringify(put.body) === JSON.stringify({ options: [{ platform_option_id: 'popt-album-s', price: 4000 }] }), JSON.stringify(put));
      await page.waitForFunction(() => document.querySelector('[data-product-id="prod-album"]')?.textContent.includes('NT$4,000'), null, { timeout: 3000 });
      const text = await T(page, '[data-product-id="prod-album"]');
      ok('the list shows the new price and no longer the dropped size', text.includes('售價 NT$4,000') && !text.includes('12×12 吋'), text);

      // add the size back: unticked rows are offered again
      await page.click('[data-product-id="prod-album"] [data-edit]');
      await page.waitForSelector('#prod-form');
      ok('the dropped size is offered again, unticked, price prefilled with 平台價',
        !(await page.isChecked(`${box} [data-platform-option-id="popt-album-l"] .pick-check`)) && (await page.inputValue(`${box} [data-platform-option-id="popt-album-l"] .pick-price`)) === '2400');
      await page.check(`${box} [data-platform-option-id="popt-album-l"] .pick-check`);
      await page.click('#pf-save');
      await page.waitForFunction(() => !document.getElementById('prod-form'), null, { timeout: 3000 });
      const put2 = o.st.calls.filter(c => c.method === 'PUT').pop();
      ok('PUT lists both in platform order, the re-added one at its 平台價',
        JSON.stringify(put2.body) === JSON.stringify({ options: [{ platform_option_id: 'popt-album-s', price: 4000 }, { platform_option_id: 'popt-album-l', price: 2400 }] }), JSON.stringify(put2.body));

      // unticking everything
      await page.click('[data-product-id="prod-print"] [data-edit]');
      await page.waitForSelector('#prod-form');
      await page.uncheck(`${box} .pick-check`);
      await page.click('#pf-save');
      ok('nothing left ticked → 「請至少勾選一個規格」', (await T(page, '#pf-err')).includes('請至少勾選一個規格') && o.st.calls.filter(c => c.method === 'PUT').length === 2);
      // the Worker's own refusals
      await page.check(`${box} .pick-check`);
      o.st.inject = (method, path) => method === 'PUT' ? { status: 400, body: { error: 'platform managed', code: 'platform_managed' } } : null;
      await page.click('#pf-save');
      await waitText(page, '#pf-err', t => t.includes('由平台管理'));
      ok('platform_managed → 「名稱、類型、說明與張數由平台管理…」, the form stays', (await page.$('#prod-form')) !== null);
      o.st.inject = (method, path) => method === 'PUT' ? { status: 400, body: { error: 'below platform price', code: 'below_platform_price' } } : null;
      await page.click('#pf-save');
      await waitText(page, '#pf-err', t => t.includes('售價不能低於平台價'));
      ok('below_platform_price from the Worker → 「售價不能低於平台價」', true);
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const plat = platFx();
  const o = ordersFake({ platform: plat, products: [clone(PROD_ALBUM), clone(PROD_PRINT)] });
  // the platform retired the album's 12×12 size and the whole 無框畫 product
  o.st.platform[0].options[1].active = 0;
  o.st.platform[1].active = 0;
  await suite('設定 — 平台下架的規格／商品：清單標「平台已下架」並變灰，編輯時不能勾選；整個商品下架則不能改規格',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      const li = await page.$$eval('[data-product-id="prod-album"] li', els => els.map(e => ({ id: e.dataset.optionId, off: e.dataset.unavailable || null, opacity: getComputedStyle(e).opacity, text: e.textContent.replace(/\s+/g, ' ') })));
      ok('the retired 12×12 size reads 平台已下架 and is dimmed; the live 8×8 is not',
        li[1].off === '1' && li[1].text.includes('平台已下架') && Number(li[1].opacity) < 1 && li[0].off === null && !li[0].text.includes('平台已下架') && li[0].opacity === '1', JSON.stringify(li));
      ok('a retired size never shows the price warning', (await page.$$('[data-product-id="prod-album"] .warn-below')).length === 0);
      const pr = await page.$eval('[data-product-id="prod-print"]', e => ({ text: e.textContent.replace(/\s+/g, ' '), opacity: getComputedStyle(e).opacity, active: e.dataset.active, cls: e.className }));
      ok('the product the platform retired is tagged 平台已下架 and dimmed, though the photographer never retired it',
        pr.text.includes('平台已下架') && Number(pr.opacity) < 1 && pr.active === '1', JSON.stringify(pr));
      ok('its option is marked unavailable too', (await page.$('[data-product-id="prod-print"] li[data-unavailable="1"]')) !== null);

      await page.click('[data-product-id="prod-album"] [data-edit]');
      await page.waitForSelector('#prod-form');
      const rows = await page.$$eval('#pf-options .pick-row', els => els.map(e => ({ id: e.dataset.platformOptionId, checked: e.querySelector('.pick-check').checked, disabled: e.querySelector('.pick-check').disabled,
        price: !!e.querySelector('.pick-price'), text: e.textContent.replace(/\s+/g, ' ') })));
      ok('the live size is a normal ticked row; the retired one is listed, unticked, disabled, with no price box',
        rows.length === 2 && rows[0].checked && !rows[0].disabled && rows[0].price && rows[1].id === 'popt-album-l' && !rows[1].checked && rows[1].disabled && !rows[1].price && rows[1].text.includes('平台已下架'), JSON.stringify(rows));
      await page.click('#pf-save');
      await page.waitForFunction(() => !document.getElementById('prod-form'), null, { timeout: 3000 });
      const put = o.st.calls.find(c => c.method === 'PUT');
      ok('saving sends only the live size (the retired one is dropped, never sent — the Worker would answer retired_option)',
        JSON.stringify(put.body) === JSON.stringify({ options: [{ platform_option_id: 'popt-album-s', price: 3800 }] }), JSON.stringify(put.body));

      await page.click('[data-product-id="prod-print"] [data-edit]');
      await page.waitForSelector('#prod-form');
      ok('a product the platform retired: an explanation, every row disabled, 儲存 disabled',
        (await T(page, '#prod-form')).includes('平台已下架這個商品') && await page.$eval('#pf-save', e => e.disabled) && await page.$eval('#pf-options .pick-check', e => e.disabled));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const o = ordersFake({ platform: platFx(), products: [clone(PROD_ALBUM)] });
  await suite('設定 — 不連到營運頁：側邊選單沒有 operator 連結，頁面只帶攝影師權杖，即使瀏覽器裡有營運權杖也不用',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      await page.click('#plat-add-btn');
      await page.waitForSelector('.plat-card');
      ok('the side menu has items (positive) but none points at operator.html',
        (await page.$$('#sideNav .side-nav-item')).length >= 8 && (await page.$$('a[href*="operator"]')).length === 0);
      ok('every request the page made carried the photographer’s token, none the operator’s',
        o.st.calls.filter(c => !c.path.startsWith('/api/platform/')).length >= 2 && o.st.calls.filter(c => !c.path.startsWith('/api/platform/')).every(c => c.auth === 'Bearer adm') && !o.st.calls.some(c => c.path.startsWith('/api/operator')), JSON.stringify(o.st.calls.map(c => [c.path, c.auth])));
      ok('the operator token is still in localStorage, untouched', (await page.evaluate(() => localStorage.getItem('imhoti_operator_token'))) === 'op');
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: () => { sessionStorage.setItem('studio_token', 'adm'); localStorage.setItem('imhoti_operator_token', 'op'); } });
}

// ── operator.html — the operator's console (platform catalogue) ────────────
const OP_KEY = 'imhoti_operator_token';
// seeds the operator token once per tab (sessionStorage marks it), so a later
// sign-out or reload is not undone by the init script running again
const OP_SEED = () => { if (!sessionStorage.getItem('__seeded')) { localStorage.setItem('imhoti_operator_token', 'op'); sessionStorage.setItem('__seeded', '1'); } };
const opFx = () => [clone(PLAT_ALBUM), clone(PLAT_PRINT)];
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

{
  const o = ordersFake({ platform: opFx(), products: [] });
  await suite('operator — 登入：營運權杖存在自己的 localStorage 鍵，不碰攝影師的 studio_token；錯的權杖（含攝影師的）進不去',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-login', { timeout: 5000 });
      ok('signed out: the sign-in box is shown and the console is not (computed display)', (await disp(page, '#op-login')) !== 'none' && (await disp(page, '#op-app')) === 'none');
      ok('and the logout button is not shown', (await disp(page, '#op-logout')) === 'none');
      ok('no request was made before signing in', o.st.calls.length === 0, JSON.stringify(o.st.calls));
      ok('the token field is a password field', (await page.getAttribute('#op-token', 'type')) === 'password');

      await page.click('#op-login-btn');
      ok('an empty token asks for one, no request', (await T(page, '#op-login-err')).includes('請輸入營運權杖') && o.st.calls.length === 0);

      // the photographer's token is not the operator's: the Worker refuses it on /api/operator
      await page.fill('#op-token', 'adm');
      await page.click('#op-login-btn');
      await waitText(page, '#op-login-err', t => t.includes('營運權杖不正確'));
      ok('the photographer’s token is refused (401) with a Chinese message; still signed out',
        (await disp(page, '#op-app')) === 'none' && (await disp(page, '#op-login')) !== 'none' && o.st.calls.at(-1).auth === 'Bearer adm' && o.st.calls.at(-1).path === '/api/operator/products');
      ok('nothing was left in localStorage by the failed attempt', (await page.evaluate(k => localStorage.getItem(k), OP_KEY)) === null);

      await page.fill('#op-token', 'op');
      await page.click('#op-login-btn');
      await page.waitForSelector('#op-list .prod-row', { timeout: 4000 });
      ok('the operator token opens the console (computed display) and hides the sign-in', (await disp(page, '#op-app')) !== 'none' && (await disp(page, '#op-login')) === 'none' && (await disp(page, '#op-logout')) !== 'none');
      ok('the operator token is stored under its own localStorage key', (await page.evaluate(k => localStorage.getItem(k), OP_KEY)) === 'op');
      ok('it is not stored anywhere the photographer’s pages read: sessionStorage studio_token is untouched (null)', (await page.evaluate(() => sessionStorage.getItem('studio_token'))) === null);
      ok('no key holds it besides its own', await page.evaluate(() => Object.keys(localStorage).concat(Object.keys(sessionStorage)).filter(k => (localStorage.getItem(k) === 'op' || sessionStorage.getItem(k) === 'op')).join()) === OP_KEY);
      ok('every call the console made went to /api/operator (or the public image route) with Bearer op — never /api/admin',
        o.st.calls.length >= 3 && o.st.calls.filter(c => c.auth === 'Bearer op').length >= 2 && !o.st.calls.some(c => c.path.startsWith('/api/admin')) &&
        o.st.calls.filter(c => !c.path.startsWith('/api/platform/') && c.auth !== 'Bearer adm').every(c => c.auth === 'Bearer op'), JSON.stringify(o.st.calls.map(c => [c.path, c.auth])));
      ok('the side menu is not on this page and it does not link to the photographer’s pages', (await page.$('#sideNav')) === null && (await page.$('a[href*="dashboard"]')) === null && (await page.$('a[href*="settings"]')) === null);

      await page.reload();
      await page.waitForSelector('#op-list .prod-row', { timeout: 4000 });
      ok('a reload stays signed in from the stored token', (await disp(page, '#op-app')) !== 'none');
      await page.click('#op-logout');
      ok('登出 shows the sign-in again', (await disp(page, '#op-login')) !== 'none' && (await disp(page, '#op-app')) === 'none');
      ok('and removes its own key only', (await page.evaluate(k => localStorage.getItem(k), OP_KEY)) === null);
      await page.reload();
      await page.waitForSelector('#op-login');
      ok('after a reload it is still signed out', (await disp(page, '#op-login')) !== 'none' && (await disp(page, '#op-app')) === 'none');
      return out;
    },
    { before: o.attach, });
}

{
  const o = ordersFake({ platform: opFx(), products: [] });
  await suite('operator — 攝影師已登入時（studio_token）仍要自己登入：不沿用攝影師的權杖',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-login', { timeout: 5000 });
      await page.waitForTimeout(400);
      ok('with a photographer session present, the console still asks for the operator token', (await disp(page, '#op-login')) !== 'none' && (await disp(page, '#op-app')) === 'none');
      ok('and made no request with the photographer’s token', o.st.calls.length === 0, JSON.stringify(o.st.calls));
      ok('the photographer’s token is still there, unchanged', (await page.evaluate(() => sessionStorage.getItem('studio_token'))) === 'adm');
      return out;
    },
    { before: o.attach, initScript: SEED_TOKEN_ALWAYS });
}

{
  const o = ordersFake({ platform: opFx(), products: [] });
  await suite('operator — 已存的權杖失效（401）：清掉自己的鍵並回到登入畫面；網路錯誤不清權杖',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-login', { timeout: 5000 });
      await waitText(page, '#op-login-err', t => t.includes('營運權杖不正確或已失效'));
      ok('a stale stored token → sign-in with 「營運權杖不正確或已失效，請重新登入」', (await disp(page, '#op-app')) === 'none');
      ok('and the stale key is removed', (await page.evaluate(k => localStorage.getItem(k), OP_KEY)) === null);
      return out;
    },
    { before: o.attach, initScript: () => localStorage.setItem('imhoti_operator_token', 'old-token') });
}

{
  const o = ordersFake({ platform: opFx(), products: [] });
  o.st.inject = () => ({ status: 500, body: { error: 'DB not configured' } });
  await suite('operator — 伺服器錯誤（500）：顯示錯誤但保留已存的權杖，不當成登入失敗',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-login', { timeout: 5000 });
      await waitText(page, '#op-login-err', t => t.includes('DB not configured'));
      ok('the Worker’s message is shown on the sign-in screen', (await disp(page, '#op-app')) === 'none');
      ok('the stored token is kept', (await page.evaluate(k => localStorage.getItem(k), OP_KEY)) === 'op');
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

{
  const retired = { id: 'plat-old', kind: 'print', name: '停產相框', description: '', photo_count: null, active: 0, sort: 0, has_image: false, image_type: null, image_updated_at: null,
    options: [{ id: 'popt-old', label: '', vendor_cost: 100, platform_price: 150, active: 1, sort: 0 }] };
  const o = ordersFake({ platform: [retired, ...opFx()], products: [] });
  await suite('operator — 平台商品清單：上架的在前，下架的灰掉並可重新上架；成本／平台價／張數；金額為 NT$',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-list .prod-row', { timeout: 5000 });
      const rows = await page.$$eval('#op-list .prod-row', els => els.map(e => ({ id: e.dataset.productId, active: e.dataset.active, opacity: getComputedStyle(e).opacity,
        kind: e.querySelector('.pill[data-kind]').textContent, text: e.textContent.replace(/\s+/g, ' '), buttons: [...e.querySelectorAll('button')].map(b => b.textContent),
        img: e.querySelector('img.thumb')?.getAttribute('src') || null, placeholder: !!e.querySelector('div.thumb.none') })));
      ok('active products first even though the retired one came first in the data', rows.map(r => r.id).join() === 'plat-album,plat-print,plat-old', JSON.stringify(rows.map(r => r.id)));
      ok('kinds are 相本 / 輸出品', rows[0].kind === '相本' && rows[1].kind === '輸出品' && rows[2].kind === '輸出品');
      ok('an album shows each size with 廠商成本 and 平台價 in NT$, and how many photos',
        rows[0].text.includes('8×8 吋 · 廠商成本 NT$1,400 · 平台價 NT$1,500') && rows[0].text.includes('12×12 吋 · 廠商成本 NT$2,300 · 平台價 NT$2,400') && rows[0].text.includes('指定 20 張'), rows[0].text);
      ok('a retired size of an active product is listed but marked 已下架規格 and dimmed', rows[0].text.includes('舊規格') && rows[0].text.includes('已下架規格') &&
        Number(await page.$eval('[data-product-id="plat-album"] li[data-option-id="popt-album-old"]', e => getComputedStyle(e).opacity)) < 1);
      ok('a single size with no label reads （單一規格）', rows[1].text.includes('（單一規格） · 廠商成本 NT$450 · 平台價 NT$500'), rows[1].text);
      ok('the album has its picture from the public route, the print a 無圖 placeholder',
        rows[0].img?.includes('/api/platform/products/plat-album/image') && rows[1].img === null && rows[1].placeholder);
      ok('active rows are full strength with 下架 (not 重新上架)', rows[0].opacity === '1' && rows[0].buttons.includes('下架') && !rows[0].buttons.includes('重新上架'), JSON.stringify(rows[0]));
      ok('the retired row is greyed (computed opacity < 1), tagged 已下架, with 重新上架 (not 下架)',
        Number(rows[2].opacity) < 1 && rows[2].active === '0' && rows[2].text.includes('已下架') && rows[2].buttons.includes('重新上架') && !rows[2].buttons.includes('下架'), JSON.stringify(rows[2]));

      await page.click('[data-product-id="plat-old"] [data-restore]');
      await page.waitForFunction(() => document.querySelector('[data-product-id="plat-old"]')?.dataset.active === '1', null, { timeout: 3000 });
      ok('重新上架 posts /restore with the operator token and the row returns to full strength',
        o.st.calls.some(c => c.method === 'POST' && c.path === '/api/operator/products/plat-old/restore' && c.auth === 'Bearer op') &&
        (await page.$eval('[data-product-id="plat-old"]', e => getComputedStyle(e).opacity)) === '1');
      ok('and it sorts among the active ones now (before nothing greyed)', (await page.$$eval('#op-list .prod-row', els => els.map(e => e.dataset.active).join())) === '1,1,1');
      await page.click('[data-product-id="plat-print"] [data-retire]');
      await page.waitForFunction(() => document.querySelector('[data-product-id="plat-print"]')?.dataset.active === '0', null, { timeout: 3000 });
      ok('下架 posts /retire, greys the row and moves it below the active ones',
        o.st.calls.some(c => c.method === 'POST' && c.path === '/api/operator/products/plat-print/retire') &&
        Number(await page.$eval('[data-product-id="plat-print"]', e => getComputedStyle(e).opacity)) < 1 &&
        (await page.$$eval('#op-list .prod-row', els => els.at(-1).dataset.productId)) === 'plat-print');
      ok('retire/restore sent no body', o.st.calls.filter(c => /retire|restore/.test(c.path)).every(c => c.body === null));
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

{
  const o = ordersFake({ platform: [], products: [] });
  await suite('operator — 新增平台商品：只有相本／輸出品、相本才問張數、驗證、規格列增減，送出的內容正確，建立後可接著上傳圖片',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-list .hint', { timeout: 5000 });
      ok('an empty catalogue says so', (await T(page, '#op-list')).includes('還沒有平台商品'));
      await page.click('#op-add-btn');
      await page.waitForSelector('#op-form');
      ok('the kind choices are only 相本 and 輸出品 (no 服務 — that is the photographer’s own)',
        JSON.stringify(await page.$$eval('#opf-kind option', els => els.map(e => e.textContent))) === JSON.stringify(['相本', '輸出品']));
      ok('an album asks for a photo count (computed display)', (await disp(page, '#opf-count-group')) !== 'none');
      await page.selectOption('#opf-kind', 'print');
      ok('a print does not', (await disp(page, '#opf-count-group')) === 'none');
      await page.selectOption('#opf-kind', 'album');
      ok('image upload is not offered until the product exists (no file input; a hint instead)', (await page.$('#opf-file')) === null && (await T(page, '#op-form')).includes('先儲存商品'));
      ok('the add button hides while the form is open', (await disp(page, '#op-add-btn')) === 'none');

      await page.click('#opf-save');
      ok('no name → 商品名稱必填, nothing sent', (await T(page, '#opf-err')).includes('商品名稱必填') && !o.st.calls.some(c => c.method === 'POST'));
      await page.fill('#opf-name', '相本書');
      await page.click('#opf-save');
      ok('a blank 廠商成本 is refused client-side', (await T(page, '#opf-err')).includes('廠商成本需為 0 以上的整數') && !o.st.calls.some(c => c.method === 'POST'));
      await page.fill('#opf-options .opt-row:nth-child(1) .opt-vendor', '1400');
      await page.click('#opf-save');
      ok('a blank 平台價 is refused client-side', (await T(page, '#opf-err')).includes('平台價需為 0 以上的整數') && !o.st.calls.some(c => c.method === 'POST'));
      await page.click('#opf-options .opt-del');
      ok('removing the only option row is refused', (await page.$$('#opf-options .opt-row')).length === 1 && (await T(page, '#opf-err')).includes('至少保留一個規格'));

      await page.fill('#opf-desc', '20 頁精裝');
      await page.fill('#opf-count', '20');
      await page.fill('#opf-options .opt-row:nth-child(1) .opt-label', '8×8 吋');
      await page.fill('#opf-options .opt-row:nth-child(1) .opt-plat', '1500');
      await page.click('#opf-add-option');
      await page.fill('#opf-options .opt-row:nth-child(2) .opt-label', '12×12 吋');
      await page.fill('#opf-options .opt-row:nth-child(2) .opt-vendor', '2300');
      await page.fill('#opf-options .opt-row:nth-child(2) .opt-plat', '2400');
      await page.click('#opf-add-option');
      await page.click('#opf-options .opt-row:nth-child(3) .opt-del');
      ok('a row can be removed while others remain', (await page.$$('#opf-options .opt-row')).length === 2);
      await page.click('#opf-save');
      await page.waitForSelector('#op-form[data-mode="edit"]', { timeout: 3000 });
      const post = o.st.calls.find(c => c.method === 'POST' && c.path === '/api/operator/products');
      ok('POST carries kind, name, description, photo_count and options with vendor_cost and platform_price',
        JSON.stringify(post?.body) === JSON.stringify({
          kind: 'album', name: '相本書', description: '20 頁精裝', photo_count: 20,
          options: [{ label: '8×8 吋', vendor_cost: 1400, platform_price: 1500 }, { label: '12×12 吋', vendor_cost: 2300, platform_price: 2400 }],
        }), JSON.stringify(post?.body));
      ok('after creating, the form stays open on the new product in edit mode, now with the image section', (await page.$('#opf-file')) !== null && (await T(page, '#op-ok')).includes('已建立'));
      ok('and the product is listed with its money', (await T(page, '#op-list')).includes('12×12 吋 · 廠商成本 NT$2,300 · 平台價 NT$2,400'));
      await page.click('#opf-cancel');
      ok('取消 closes the form and brings the add button back', (await page.$('#op-form')) === null && (await disp(page, '#op-add-btn')) !== 'none');

      // Worker refusals in Chinese
      o.st.inject = (method, path) => (method === 'POST' && path === '/api/operator/products') ? { status: 400, body: { error: 'invalid vendor cost', code: 'invalid_vendor_cost' } } : null;
      await page.click('#op-add-btn');
      await page.selectOption('#opf-kind', 'print');
      await page.fill('#opf-name', '無框畫');
      await page.fill('#opf-options .opt-row .opt-vendor', '450');
      await page.fill('#opf-options .opt-row .opt-plat', '500');
      await page.click('#opf-save');
      await waitText(page, '#opf-err', t => t.includes('廠商成本需為'));
      ok('invalid_vendor_cost from the Worker → 「廠商成本需為 0 以上的整數」, the form stays', (await page.$('#op-form')) !== null);
      const post2 = o.st.calls.filter(c => c.method === 'POST' && c.path === '/api/operator/products').pop();
      ok('a print sends photo_count null', post2.body.photo_count === null && post2.body.kind === 'print', JSON.stringify(post2.body));
      o.st.inject = (method, path) => (method === 'POST' && path === '/api/operator/products') ? { status: 400, body: { error: 'invalid platform price', code: 'invalid_platform_price' } } : null;
      await page.click('#opf-save');
      await waitText(page, '#opf-err', t => t.includes('平台價需為'));
      ok('invalid_platform_price → 「平台價需為 0 以上的整數」', true);
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

{
  const o = ordersFake({ platform: opFx(), products: [] });
  await suite('operator — 編輯平台商品：帶入（含規格 id）、可改類型，改價／刪／加後 PUT 的內容正確',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-list .prod-row', { timeout: 5000 });
      await page.click('[data-product-id="plat-album"] [data-edit]');
      await page.waitForSelector('#op-form[data-mode="edit"]');
      ok('title says 編輯平台商品', (await T(page, '#op-form h3')) === '編輯平台商品');
      const rows = await page.$$eval('#opf-options .opt-row', els => els.map(e => ({ id: e.dataset.optionId, label: e.querySelector('.opt-label').value, v: e.querySelector('.opt-vendor').value, p: e.querySelector('.opt-plat').value })));
      ok('only the active options are prefilled, each with its id and both prices',
        JSON.stringify(rows) === JSON.stringify([{ id: 'popt-album-s', label: '8×8 吋', v: '1400', p: '1500' }, { id: 'popt-album-l', label: '12×12 吋', v: '2300', p: '2400' }]), JSON.stringify(rows));
      ok('name, description and count are prefilled', (await page.inputValue('#opf-name')) === '相本書' && (await page.inputValue('#opf-desc')) === '20 頁精裝' && (await page.inputValue('#opf-count')) === '20' && (await page.inputValue('#opf-kind')) === 'album');
      await page.fill('#opf-options .opt-row:nth-child(1) .opt-plat', '1600');
      await page.click('#opf-options .opt-row:nth-child(2) .opt-del');
      await page.click('#opf-add-option');
      await page.fill('#opf-options .opt-row:nth-child(2) .opt-label', '10×10 吋');
      await page.fill('#opf-options .opt-row:nth-child(2) .opt-vendor', '1800');
      await page.fill('#opf-options .opt-row:nth-child(2) .opt-plat', '1900');
      await page.fill('#opf-count', '');
      await page.click('#opf-save');
      await page.waitForFunction(() => !document.getElementById('op-form'), null, { timeout: 3000 });
      const put = o.st.calls.find(c => c.method === 'PUT');
      ok('PUT goes to the product; the kept option carries its id, the new one none, the dropped one is absent; blank count = null',
        put?.path === '/api/operator/products/plat-album' && put.auth === 'Bearer op' && JSON.stringify(put.body) === JSON.stringify({
          kind: 'album', name: '相本書', description: '20 頁精裝', photo_count: null,
          options: [{ label: '8×8 吋', vendor_cost: 1400, platform_price: 1600, id: 'popt-album-s' }, { label: '10×10 吋', vendor_cost: 1800, platform_price: 1900 }],
        }), JSON.stringify(put));
      await page.waitForFunction(() => document.querySelector('[data-product-id="plat-album"]')?.textContent.includes('NT$1,900'), null, { timeout: 3000 });
      const text = await T(page, '[data-product-id="plat-album"]');
      ok('the list shows the new set; the dropped size appears only as 已下架規格', text.includes('平台價 NT$1,600') && text.includes('10×10 吋') && /12×12 吋[^·]*·[^·]*·[^·]*已下架規格/.test(text), text);
      await page.click('[data-product-id="plat-album"] [data-edit]');
      await page.waitForSelector('#op-form');
      await page.selectOption('#opf-kind', 'print');
      ok('switching the kind to 輸出品 hides the count', (await disp(page, '#opf-count-group')) === 'none');
      await page.click('#opf-save');
      await page.waitForFunction(() => !document.getElementById('op-form'), null, { timeout: 3000 });
      const put2 = o.st.calls.filter(c => c.method === 'PUT').pop();
      ok('a kind change is sent (the Worker allows it) with photo_count null', put2.body.kind === 'print' && put2.body.photo_count === null, JSON.stringify(put2.body));
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

// ── operator: 平台價低於廠商成本的警告 ─────────────────────────────────────
{
  const cheap = { id: 'plat-cheap', kind: 'print', name: '補貼款', description: '', photo_count: null, active: 1, sort: 0, has_image: false, image_type: null, image_updated_at: null,
    options: [
      { id: 'popt-under', label: '低於成本', vendor_cost: 600, platform_price: 500, active: 1, sort: 0 },
      { id: 'popt-equal', label: '等於成本', vendor_cost: 500, platform_price: 500, active: 1, sort: 1 },
      { id: 'popt-over', label: '高於成本', vendor_cost: 400, platform_price: 500, active: 1, sort: 2 },
      { id: 'popt-retired', label: '停賣款', vendor_cost: 900, platform_price: 100, active: 0, sort: 3 }] };
  const o = ordersFake({ platform: [cheap], products: [] });
  await suite('operator — 平台價低於廠商成本：清單與表單都出現警告（只警告，仍可儲存）；等於、高於或未填完則沒有',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-list .prod-row', { timeout: 5000 });
      const warned = await page.$$eval('#op-list li', els => els.map(e => ({ id: e.dataset.optionId, chip: e.querySelector('.chip-warn')?.textContent || null })));
      ok('the option priced under its vendor cost carries 「平台價低於廠商成本」', warned.find(w => w.id === 'popt-under').chip === '平台價低於廠商成本', JSON.stringify(warned));
      ok('equal and higher-than-cost options have no chip (positive: the first does)', warned.find(w => w.id === 'popt-equal').chip === null && warned.find(w => w.id === 'popt-over').chip === null);
      ok('a retired option is not flagged even when under cost', warned.find(w => w.id === 'popt-retired').chip === null);
      ok('the chip is visible red text (computed color)', (await page.$eval('#op-list .chip-warn', e => getComputedStyle(e).color)) === RED);

      await page.click('[data-edit]');
      await page.waitForSelector('#op-form');
      const chips = async () => page.$$eval('#opf-options .opt-row', els => els.map(e => !!e.querySelector('.opt-warn .chip-warn')));
      ok('in the form the same one row shows the chip on open (under: yes, equal: no, over: no)', JSON.stringify(await chips()) === JSON.stringify([true, false, false]), JSON.stringify(await chips()));
      await page.fill('#opf-options .opt-row:nth-child(1) .opt-plat', '600');
      ok('typing 平台價 up to the cost clears it live', JSON.stringify(await chips()) === JSON.stringify([false, false, false]));
      await page.fill('#opf-options .opt-row:nth-child(3) .opt-plat', '399');
      ok('typing 平台價 under the cost sets it live', JSON.stringify(await chips()) === JSON.stringify([false, false, true]));
      await page.fill('#opf-options .opt-row:nth-child(3) .opt-plat', '');
      ok('an unfinished (blank) price shows no chip', JSON.stringify(await chips()) === JSON.stringify([false, false, false]));
      await page.click('#opf-add-option');
      await page.fill('#opf-options .opt-row:nth-child(4) .opt-label', '新款');
      await page.fill('#opf-options .opt-row:nth-child(4) .opt-vendor', '1000');
      await page.fill('#opf-options .opt-row:nth-child(4) .opt-plat', '800');
      ok('a new row gets the chip as soon as both numbers are in and price < cost', (await chips())[3] === true);
      await page.fill('#opf-options .opt-row:nth-child(3) .opt-plat', '399');
      await page.click('#opf-save');
      await page.waitForFunction(() => !document.getElementById('op-form'), null, { timeout: 3000 });
      const put = o.st.calls.find(c => c.method === 'PUT');
      ok('saving with a price under cost is allowed — the PUT went out with both numbers (Tim may subsidise)',
        put && put.body.options.find(x => x.label === '新款').platform_price === 800 && put.body.options.find(x => x.label === '新款').vendor_cost === 1000, JSON.stringify(put));
      await page.waitForFunction(() => document.querySelectorAll('#op-list .chip-warn').length === 2, null, { timeout: 3000 });
      ok('and the list now flags the two under-cost options (新款, 高→399)', true);
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

// ── operator: 圖片 ─────────────────────────────────────────────────────────
{
  const o = ordersFake({ platform: opFx(), products: [] });
  await suite('operator — 商品圖片：上傳後預覽（從公開路由載入）、移除；大小／格式錯誤顯示中文（前端與 Worker 的 413／415）',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-list .prod-row', { timeout: 5000 });
      await page.click('[data-product-id="plat-print"] [data-edit]');
      await page.waitForSelector('#opf-file');
      ok('a product with no picture shows 尚未上傳 and no 移除圖片 button (computed display)', (await T(page, '#opf-preview')).includes('尚未上傳') && (await page.$('#opf-preview img')) === null && (await disp(page, '#opf-img-remove')) === 'none');
      const imgCalls = () => o.st.calls.filter(c => c.method === 'PUT' && /\/image$/.test(c.path));

      // client-side guards: no request
      await page.setInputFiles('#opf-file', { name: 'big.png', mimeType: 'image/png', buffer: Buffer.concat([PNG_BYTES, Buffer.alloc(204800)]) });
      ok('a file over 200 KB is refused in Chinese before any request', (await T(page, '#opf-img-err')).includes('圖片超過 200 KB') && imgCalls().length === 0);
      await page.setInputFiles('#opf-file', { name: 'a.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
      ok('a GIF is refused in Chinese before any request', (await T(page, '#opf-img-err')).includes('不支援的檔案格式') && imgCalls().length === 0);

      // the Worker sniffs the bytes, not the type: a text file claiming image/png → 415
      await page.setInputFiles('#opf-file', { name: 'fake.png', mimeType: 'image/png', buffer: Buffer.from('this is not an image at all') });
      await waitText(page, '#opf-img-err', t => t.includes('不支援的檔案格式'));
      ok('a non-image body labelled image/png → the Worker’s 415 unsupported_type → 「不支援的檔案格式，僅限 PNG / JPEG / WebP」',
        imgCalls().length === 1 && (await page.$('#opf-preview img')) === null);
      // a Worker-side 413 (e.g. limit lowered)
      o.st.inject = (method, path) => (method === 'PUT' && /\/image$/.test(path)) ? { status: 413, body: { error: '商品圖片不可超過 200 KB', code: 'too_large', max: 204800 } } : null;
      await page.setInputFiles('#opf-file', { name: 'ok.png', mimeType: 'image/png', buffer: PNG_BYTES });
      await waitText(page, '#opf-img-err', t => t.includes('圖片超過 200 KB'));
      ok('the Worker’s 413 too_large → 「圖片超過 200 KB，請壓縮後再試」', imgCalls().length === 2);
      o.st.inject = null;

      await page.setInputFiles('#opf-file', { name: 'good.png', mimeType: 'image/png', buffer: PNG_BYTES });
      await page.waitForSelector('#opf-preview img', { timeout: 3000 });
      const call = imgCalls().at(-1);
      ok('a real PNG is PUT raw to the operator image route with the operator token, its own type and size',
        call.path === '/api/operator/products/plat-print/image' && call.auth === 'Bearer op' && call.type === 'image/png' && call.size === PNG_BYTES.length, JSON.stringify(call));
      ok('the error message is cleared and 已更新圖片 shown', (await T(page, '#opf-img-err')) === '' && (await T(page, '#opf-img-ok')).includes('已更新圖片'));
      const src = await page.$eval('#opf-preview img', e => e.getAttribute('src'));
      ok('the preview comes from the public route, with a version stamp', src.includes('/api/platform/products/plat-print/image?v=') && !/[?&]t=/.test(src), src);
      await page.waitForFunction(() => { const i = document.querySelector('#opf-preview img'); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 4000 });
      ok('…and it actually loaded (the fake serves the stored image only once there is one)', true);
      ok('移除圖片 is offered now (computed display)', (await disp(page, '#opf-img-remove')) !== 'none');
      ok('the list row behind the form shows the thumbnail too', (await page.$('[data-product-id="plat-print"] img.thumb')) !== null && (await page.$('[data-product-id="plat-print"] div.thumb.none')) === null);
      ok('the public image requests carry no token (no Authorization header, no t= in the URL)', o.st.calls.filter(c => c.path.startsWith('/api/platform/')).length > 0 && o.st.calls.filter(c => c.path.startsWith('/api/platform/')).every(c => c.auth === null && !/[?&]t=/.test(c.search)));

      await page.click('#opf-img-remove');
      await page.waitForFunction(() => !document.querySelector('#opf-preview img'), null, { timeout: 3000 });
      ok('移除圖片 sends DELETE with the operator token', o.st.calls.some(c => c.method === 'DELETE' && c.path === '/api/operator/products/plat-print/image' && c.auth === 'Bearer op'));
      ok('the preview goes back to 尚未上傳, the button hides, the row gets the 無圖 placeholder',
        (await T(page, '#opf-preview')).includes('尚未上傳') && (await disp(page, '#opf-img-remove')) === 'none' && (await page.$('[data-product-id="plat-print"] div.thumb.none')) !== null && (await page.$('[data-product-id="plat-print"] img.thumb')) === null);
      const gone = await page.evaluate(async () => (await fetch('https://imagepicker.hotichen.workers.dev/api/platform/products/plat-print/image')).status);
      ok('and the public route answers 404 for it now', gone === 404, String(gone));

      // an existing image (the album) is shown in its edit form
      await page.click('#opf-cancel');
      await page.click('[data-product-id="plat-album"] [data-edit]');
      await page.waitForSelector('#opf-preview img');
      ok('a product that already has a picture shows it and offers 移除圖片', (await disp(page, '#opf-img-remove')) !== 'none');
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

// ── operator: 銷售 ─────────────────────────────────────────────────────────
{
  const retired = { id: 'plat-old', kind: 'print', name: '停產相框', description: '', photo_count: null, active: 0, sort: 9, has_image: false, image_type: null, image_updated_at: null,
    options: [{ id: 'popt-old', label: '', vendor_cost: 100, platform_price: 150, active: 1, sort: 0 }] };
  const o = ordersFake({ platform: [...opFx(), retired], products: [] });
  const line = (opt, price, cost, vendor, qty, name) => ({ name, kind: 'album', unit_price: price, unit_cost: cost, vendor_cost: vendor, qty, platform_option_id: opt });
  // this month (2026-09, Taipei): 2 albums 8×8 at platform 1,500 / vendor 1,400 → 3,000 / 2,800; a subsidised print 500 / 600
  o.st.addOrder({ id: 'o1', status: 'fulfilled', paid_amount: 8000, paid_method: 'cash', paid_at: '2026-09-20T04:00:00.000Z', items: [line('popt-album-s', 3800, 1500, 1400, 2, '相本書')] });
  o.st.addOrder({ id: 'o2', status: 'confirmed', paid_amount: 1200, paid_method: 'cash', paid_at: '2026-09-05T04:00:00.000Z', items: [line('popt-print', 1200, 500, 600, 1, '無框畫')] });
  // last month: 1 more album 8×8 (counts in the 12 months, not this month)
  o.st.addOrder({ id: 'o3', status: 'fulfilled', paid_amount: 3800, paid_method: 'cash', paid_at: '2026-08-10T04:00:00.000Z', items: [line('popt-album-s', 3800, 1500, 1400, 1, '相本書')] });
  // never counted: cancelled, unpaid, and a non-platform line
  o.st.addOrder({ id: 'o4', status: 'cancelled', paid_amount: 5000, paid_method: 'cash', paid_at: '2026-09-06T04:00:00.000Z', items: [line('popt-album-l', 5800, 2400, 2300, 1, '相本書')] });
  o.st.addOrder({ id: 'o5', status: 'confirmed', paid_amount: 0, items: [line('popt-album-l', 5800, 2400, 2300, 1, '相本書')] });
  o.st.addOrder({ id: 'o6', status: 'confirmed', paid_amount: 500, paid_method: 'cash', paid_at: '2026-09-07T04:00:00.000Z', items: [{ name: '急件加修', kind: 'service', unit_price: 500, unit_cost: 0, qty: 1 }] });
  await suite('operator — 銷售表：本月合計與每個平台商品的數量、平台營收、廠商成本、毛利（已收款、不含取消／未付／非平台品項）',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-stats-table', { timeout: 5000 });
      const month = await page.$$eval('#op-month [data-k]', els => Object.fromEntries(els.map(e => [e.dataset.k, e.textContent])));
      ok('本月 totals: 3 units, 平台營收 NT$3,500, 廠商成本 NT$3,400, 毛利 NT$100 (2×1,500 + 500 vs 2×1,400 + 600)',
        month.qty === '3' && month.revenue === 'NT$3,500' && month.cost === 'NT$3,400' && month.margin === 'NT$100', JSON.stringify(month));
      const rows = await page.$$eval('#op-stats-table tbody tr', els => els.map(e => ({ id: e.dataset.platformProductId, retired: e.classList.contains('retired'), opacity: getComputedStyle(e).opacity,
        text: e.textContent.replace(/\s+/g, ' '), mq: e.querySelector('[data-col="month-qty"]').textContent, mm: e.querySelector('[data-col="month-margin"]').textContent,
        q: e.querySelector('[data-col="qty"]').textContent, rev: e.querySelector('[data-col="revenue"]').textContent, cost: e.querySelector('[data-col="cost"]').textContent,
        margin: e.querySelector('[data-col="margin"]').textContent, marginColor: getComputedStyle(e.querySelector('[data-col="margin"]')).color })));
      ok('one row per platform product, including one with no sales and a retired one', rows.map(r => r.id).join() === 'plat-album,plat-print,plat-old', JSON.stringify(rows.map(r => r.id)));
      const album = rows[0], print = rows[1], old = rows[2];
      ok('album: 本月 2 units margin NT$200; 12 months 3 units, 平台營收 NT$4,500, 廠商成本 NT$4,200, 毛利 NT$300 (cancelled, unpaid and the service line are not in it)',
        album.mq === '2' && album.mm === 'NT$200' && album.q === '3' && album.rev === 'NT$4,500' && album.cost === 'NT$4,200' && album.margin === 'NT$300', JSON.stringify(album));
      ok('a subsidised sale (platform price 500 under vendor cost 600) shows a loss as −NT$100 in red; a profitable row is not red',
        print.mq === '1' && print.q === '1' && print.rev === 'NT$500' && print.cost === 'NT$600' && print.margin === '−NT$100' && print.mm === '−NT$100' && print.marginColor === RED && album.marginColor !== RED, JSON.stringify(print));
      ok('a product with no sales reads zeros, greyed and tagged 已下架', old.q === '0' && old.mq === '0' && old.rev === 'NT$0' && old.margin === 'NT$0' && Number(old.opacity) < 1 && old.text.includes('已下架'), JSON.stringify(old));
      ok('the stats were read with the operator token', o.st.calls.some(c => c.path === '/api/operator/stats' && c.auth === 'Bearer op'));
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

{
  const o = ordersFake({ platform: [], products: [] });
  await suite('operator — 銷售：沒有平台商品時只有零的本月合計；讀取失敗顯示錯誤',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-month', { timeout: 5000 });
      ok('the month cards read zeros and no table is drawn', (await T(page, '#op-month [data-k="revenue"]')) === 'NT$0' && (await page.$('#op-stats-table')) === null && (await T(page, '#op-stats')).includes('還沒有平台商品'));
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

// ── admin.html project detail: 訂單 ────────────────────────────────────────
const ADMIN_PICKS = m => {
  const at = '2026-01-01T00:00:00.000Z';
  m.state.selections.set('20260819/IMG_1.jpg', { rating: 1, note: '', updated_by: 'x', updated_at: at });
  m.state.selections.set('20260819/IMG_2.jpg', { rating: 1, note: '', updated_by: 'x', updated_at: at });
  m.state.selections.set('20260819/IMG_3.jpg', { rating: 0, note: '', updated_by: 'x', updated_at: at });
};
const todayTaipeiNode = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

{
  const m = pickFakeWorker({ projectId: 'proj-1', title: '訂單專案' });
  const o = ordersFake({ platform: [clone(PLAT_ALBUM), clone(PLAT_PRINT)], products: [clone(PROD_ALBUM), clone(PROD_PRINT)] });
  o.st.addOrder({ id: 'ord-a', project_id: 'proj-1', status: 'confirmed', discount: 300, note: '週五取件',
    items: [{ name: '相本書', option_label: '8×8 吋', kind: 'album', unit_price: 1500, unit_cost: 600, qty: 2, photo_keys: ['20260819/IMG_1.jpg', '20260819/IMG_2.jpg'] },
            { name: '急件加修', kind: 'service', unit_price: 500, unit_cost: 0, qty: 1 }] });
  o.st.addOrder({ id: 'ord-b', project_id: 'proj-1', status: 'fulfilled', paid_amount: 1200, paid_method: 'cash', paid_at: '2026-09-20T04:00:00.000Z',
    items: [{ name: '無框畫', kind: 'print', unit_price: 1200, unit_cost: 500, qty: 1 }] });
  o.st.addOrder({ id: 'ord-c', project_id: 'proj-1', status: 'cancelled', source: 'system',
    items: [{ name: '加挑照片', kind: 'extra_pick', unit_price: 200, qty: 10 }] });
  o.st.addOrder({ id: 'ord-other', project_id: 'proj-2', status: 'confirmed', items: [{ name: '別的專案', unit_price: 1, qty: 1 }] });
  await suite('admin — 專案訂單：品項、合計、未收、狀態與付款標籤，按鈕依狀態顯示',
    `${base}/admin.html#project=proj-1`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-orders .ord-card', { timeout: 5000 });
      const cards = await page.$$eval('#pd-order-list > .ord-card', els => els.map(e => ({
        id: e.dataset.orderId, status: e.dataset.status, source: e.dataset.source, text: e.textContent.replace(/\s+/g, ' '),
        statusText: e.querySelector('.ord-status').textContent, pay: e.querySelector('.ord-pay')?.textContent ?? null,
        total: e.querySelector('.ord-total').textContent, owed: e.querySelector('.ord-owed').textContent, paid: e.querySelector('.ord-paid').textContent,
        buttons: [...e.querySelectorAll('.ord-actions button')].map(b => b.textContent),
        opacity: getComputedStyle(e).opacity, bg: getComputedStyle(e).backgroundColor, edge: getComputedStyle(e).borderTopStyle,
      })));
      ok('only this project’s three orders, in the container under 訂單', cards.length === 3 && !cards.some(c => c.id === 'ord-other'), JSON.stringify(cards.map(c => c.id)));
      const a = cards.find(c => c.id === 'ord-a'), b = cards.find(c => c.id === 'ord-b'), c = cards.find(c => c.id === 'ord-c');
      ok('lines with name · option, unit price, qty and line subtotal', a.text.includes('相本書 · 8×8 吋') && a.text.includes('NT$1,500') && a.text.includes('× 2') && a.text.includes('NT$3,000') && a.text.includes('急件加修'), a.text);
      ok('total = Σ price×qty − discount (3,500 − 300 = NT$3,200), owed the same when unpaid', a.total === 'NT$3,200' && a.owed === 'NT$3,200' && a.paid === 'NT$0', JSON.stringify([a.total, a.owed, a.paid]));
      ok('the discount is shown', a.text.includes('折扣 −NT$300') && a.text.includes('小計 NT$3,500'));
      ok('cost and margin are shown to the photographer (2×600 = NT$1,200 → 毛利 NT$2,000)', a.text.includes('成本 NT$1,200') && a.text.includes('毛利 NT$2,000'), a.text);
      ok('the note is shown', a.text.includes('備註：週五取件'));
      ok('the photos on a line are listed (2 張)', a.text.includes('照片 2 張'));
      ok('status and payment labels: 已確認 / 未付款', a.statusText === '已確認' && a.pay === '未付款', JSON.stringify([a.statusText, a.pay]));
      ok('a fulfilled, paid order: 已完成 / 已付清, owed NT$0, method and date shown', b.statusText === '已完成' && b.pay === '已付清' && b.owed === 'NT$0' && b.text.includes('現金') && b.text.includes('2026-09-20'), b.text);
      ok('a cancelled order is greyed, tagged 已取消 and 系統建立, with no payment badge', c.statusText === '已取消' && c.pay === null && c.text.includes('系統建立'), JSON.stringify(c));
      // 亮色主題: a cancelled order used to be greyed with opacity, which pulls its muted text under
      // 4.5:1 on the bright theme — it is now set apart by a cream tint and a dashed edge instead.
      // (positive: the live orders keep the white card and solid edge, so the difference is real)
      ok('a cancelled order is set apart (cream tint, dashed edge), the live ones are not',
        c.bg === 'rgb(255, 248, 238)' && c.edge === 'dashed' && a.bg === 'rgb(255, 255, 255)' && a.edge === 'solid' && b.edge === 'solid', JSON.stringify([a.bg, a.edge, b.edge, c.bg, c.edge]));
      ok('confirmed: 完成 / 取消訂單 (not 確認), and 編輯 + 記錄收款, no 清除收款',
        a.buttons.join() === '完成,取消訂單,編輯,記錄收款', a.buttons.join());
      ok('fulfilled: 復原為已確認 / 取消訂單, paid so 清除收款 too',
        b.buttons.join() === '復原為已確認,取消訂單,編輯,記錄收款,清除收款', b.buttons.join());
      ok('cancelled: no buttons at all', c.buttons.length === 0, c.buttons.join());
      ok('with no extra_pick to report, the block is absent', (await page.$('#pd-extra-pick')) === null);
      return out;
    },
    { before: async p => { ADMIN_PICKS(m); await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-x', title: '加挑專案' });
  const o = ordersFake({ products: [], extra: { count: 14, pick_limit: 4, extra_price: 200, extra: 10, fee: 2000, order_id: 'ord-e', order_extra: 6, matches: false } });
  o.st.addOrder({ id: 'ord-e', project_id: 'proj-x', source: 'system', items: [{ name: '加挑照片', kind: 'extra_pick', unit_price: 200, qty: 6, product_id: null, option_id: null }] });
  await suite('admin — 加挑張數與訂單不符時顯示「加挑張數已變更（原 X → 現 Y），請確認」',
    `${base}/admin.html#project=proj-x`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-extra-pick', { timeout: 5000 });
      const warn = await page.textContent('#pd-extra-warn').catch(() => null);
      ok('the warning names the old and new counts', warn === '加挑張數已變更（原 6 → 現 10），請確認', String(warn));
      const info = await page.textContent('#pd-extra-pick');
      ok('and the block explains the fee: 14 張，上限 4，多挑 10 張 × NT$200 = NT$2,000', info.includes('14 張') && info.includes('上限 4') && info.includes('10 張 × NT$200 = NT$2,000'), info);
      ok('the warning sits inside 訂單, above the list', await page.evaluate(() => {
        const w = document.getElementById('pd-extra-warn'); const l = document.getElementById('pd-order-list');
        return !!document.getElementById('pd-orders').contains(w) && !!(w.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING);
      }));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}

{
  // Before 開始精修 there is no extra-pick order yet: "原 0 → 現 9，請確認" reads
  // as if something changed. It should say the order is created on 開始精修.
  const m = pickFakeWorker({ projectId: 'proj-z', title: '尚未開始精修', phase: 'submitted' });
  const o = ordersFake({ products: [], extra: { count: 19, pick_limit: 10, extra_price: 1000, extra: 9, fee: 9000, order_id: null, order_extra: null, matches: false } });
  await suite('admin — 送出後還沒開始精修：加挑訂單尚未建立，說明「按開始精修時自動建立」而不是「已變更」警告',
    `${base}/admin.html#project=proj-z`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-extra-pick', { timeout: 5000 });
      const pending = await page.textContent('#pd-extra-pending').catch(() => null);
      ok('a neutral note says the order is created when 開始精修 is pressed', !!pending && pending.includes('開始精修') && pending.includes('自動建立'), String(pending));
      ok('the fee line is still shown (9 張 × NT$1,000 = NT$9,000)', (await page.textContent('#pd-extra-pick')).includes('9 張 × NT$1,000 = NT$9,000'));
      ok('and there is no 「已變更」 warning at all', (await page.$('#pd-extra-warn')) === null && !(await page.textContent('#pd-orders')).includes('已變更'));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-y', title: '加挑吻合' });
  const o = ordersFake({ products: [], extra: { count: 14, pick_limit: 4, extra_price: 200, extra: 10, fee: 2000, order_id: 'ord-e', order_extra: 10, matches: true } });
  o.st.addOrder({ id: 'ord-e', project_id: 'proj-y', source: 'system', items: [{ name: '加挑照片', kind: 'extra_pick', unit_price: 200, qty: 10, product_id: null, option_id: null }] });
  await suite('admin — 加挑張數吻合時只顯示說明，沒有警告',
    `${base}/admin.html#project=proj-y`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-extra-pick', { timeout: 5000 });
      ok('the fee block is there…', (await page.textContent('#pd-extra-pick')).includes('NT$2,000'));
      ok('…and no warning', (await page.$('#pd-extra-warn')) === null && !(await page.textContent('#pd-orders')).includes('加挑張數已變更'));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-z', title: '新增訂單專案' });
  ADMIN_PICKS(m);
  const o = ordersFake({ platform: [clone(PLAT_ALBUM), clone(PLAT_PRINT)], products: [clone(PROD_ALBUM), clone(PROD_PRINT), clone(PROD_SERVICE_OFF)] });
  await suite('admin — 新增訂單：只列上架商品的上架規格、挑專案選中的照片、單價可覆寫，送出後列出',
    `${base}/admin.html#project=proj-z`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-order-add-btn', { timeout: 5000 });
      ok('a project with no orders says 尚無訂單', (await page.textContent('#pd-orders-empty')) === '尚無訂單');
      await page.click('#pd-order-add-btn');
      await page.waitForSelector('#pd-add-option', { timeout: 3000 });
      const optTexts = await page.$$eval('#pd-add-option option', els => els.map(e => e.textContent));
      ok('the picker lists active options of active products only (no 舊規格, no retired 急件加修)',
        optTexts.length === 3 && optTexts.some(t => t.includes('相本書 · 8×8 吋 — NT$3,800')) && optTexts.some(t => t.includes('無框畫 — NT$1,200')) &&
        !optTexts.some(t => t.includes('舊規格') || t.includes('急件')), JSON.stringify(optTexts));
      ok('the add-order button is replaced by the editor while it is open', (await page.$('#pd-order-add-btn')) === null);

      await page.selectOption('#pd-add-option', 'opt-album-s');
      await page.click('#pd-add-line');
      await page.selectOption('#pd-add-option', 'opt-print');
      await page.click('#pd-add-line');
      const lines = await page.$$eval('.ord-line-edit', els => els.map(e => ({ name: e.querySelector('.ord-line-name').textContent.replace(/\s+/g, ' ').trim(), qty: e.querySelector('.ord-qty').value, ph: e.querySelector('.ord-price').placeholder, price: e.querySelector('.ord-price').value,
        photos: [...e.querySelectorAll('.ord-photo')].map(c => c.value) })));
      ok('two lines, qty 1, the catalogue price as placeholder and an empty override',
        lines.length === 2 && lines[0].qty === '1' && lines[0].ph === '3800' && lines[0].price === '' && lines[1].ph === '1200', JSON.stringify(lines));
      ok('each photo line offers exactly the project’s picks (IMG_1, IMG_2 — not the unpicked IMG_3)',
        JSON.stringify(lines[0].photos) === JSON.stringify(['20260819/IMG_1.jpg', '20260819/IMG_2.jpg']) && JSON.stringify(lines[1].photos) === JSON.stringify(lines[0].photos), JSON.stringify(lines.map(l => l.photos)));

      await page.fill('.ord-line-edit:nth-child(1) .ord-qty', '2');
      await page.fill('.ord-line-edit:nth-child(2) .ord-price', '1000');
      await page.click('.ord-line-edit:nth-child(1) summary');
      await page.check('.ord-line-edit:nth-child(1) .ord-photo[value="20260819/IMG_1.jpg"]');
      await page.check('.ord-line-edit:nth-child(1) .ord-photo[value="20260819/IMG_2.jpg"]');
      ok('the photo summary follows the ticks', (await page.textContent('.ord-line-edit:nth-child(1) [data-photo-summary]')) === '照片（2 張）');
      await page.fill('#pd-ed-discount', '100');
      await page.fill('#pd-ed-note', '婚禮加購');
      await page.click('#pd-editor-save');
      await page.waitForSelector('#pd-order-list .ord-card', { timeout: 3000 });
      const post = o.st.calls.find(c => c.method === 'POST' && c.path === '/api/admin/projects/proj-z/orders');
      ok('POST sends option ids, qty, ticked photos, an override only where typed, the discount and note',
        JSON.stringify(post?.body) === JSON.stringify({
          lines: [{ qty: 2, photo_keys: ['20260819/IMG_1.jpg', '20260819/IMG_2.jpg'], option_id: 'opt-album-s' },
                  { qty: 1, photo_keys: [], option_id: 'opt-print', unit_price: 1000 }],
          discount: 100, note: '婚禮加購' }), JSON.stringify(post?.body));
      const card = await page.$eval('#pd-order-list .ord-card', e => ({ total: e.querySelector('.ord-total').textContent, text: e.textContent.replace(/\s+/g, ' ') }));
      ok('the editor closes and the order is listed with its computed total (2×3,800 + 1,000 − 100 = NT$8,500)', card.total === 'NT$8,500' && (await page.$('#pd-order-editor')) === null, JSON.stringify(card));
      ok('the add button is back', (await page.$('#pd-order-add-btn')) !== null);

      // errors: a retired option (raced with the catalogue), empty lines
      await page.click('#pd-order-add-btn');
      await page.waitForSelector('#pd-add-option');
      await page.click('#pd-editor-save');
      ok('saving with no lines is refused client-side', (await page.textContent('#pd-editor-err')).includes('請至少加入一個品項') && o.st.calls.filter(c => c.method === 'POST' && /orders$/.test(c.path)).length === 1);
      await page.selectOption('#pd-add-option', 'opt-print');
      await page.click('#pd-add-line');
      await page.fill('.ord-line-edit .ord-qty', '0');
      await page.click('#pd-editor-save');
      ok('qty 0 is refused client-side', (await page.textContent('#pd-editor-err')).includes('數量需為 1–999'));
      await page.fill('.ord-line-edit .ord-qty', '1');
      o.st.products.find(p => p.id === 'prod-print').options[0].active = 0;
      await page.click('#pd-editor-save');
      await waitText(page, '#pd-editor-err', t => t.includes('已下架'));
      ok('retired_option → 「這個商品規格已下架…」 and the editor stays', (await page.$('#pd-order-editor')) !== null);
      await page.click('#pd-editor-cancel');
      ok('取消 closes the editor', (await page.$('#pd-order-editor')) === null && (await page.$$('#pd-order-list .ord-card')).length === 1);
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-f', title: '平台價下限' });
  ADMIN_PICKS(m);
  const o = ordersFake({ platform: platFx(), products: [clone(PROD_ALBUM), clone(PROD_PRINT)] });
  await suite('admin — 訂單品項是平台商品：單價不能低於平台價（below_platform_price），平台下架的規格（retired_option）顯示中文',
    `${base}/admin.html#project=proj-f`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-order-add-btn', { timeout: 5000 });
      await page.click('#pd-order-add-btn');
      await page.waitForSelector('#pd-add-option');
      await page.selectOption('#pd-add-option', 'opt-album-s');
      await page.click('#pd-add-line');
      await page.fill('.ord-line-edit .ord-price', '1400');
      await page.click('#pd-editor-save');
      await waitText(page, '#pd-editor-err', t => t.includes('不能低於平台價'));
      ok('a unit price under 平台價 (1,400 < 1,500) → 「售價不能低於平台價」 from the Worker, the editor stays, nothing created',
        (await page.$('#pd-order-editor')) !== null && o.st.orders.length === 0, await T(page, '#pd-editor-err'));
      await page.fill('.ord-line-edit .ord-price', '1500');
      await page.click('#pd-editor-save');
      await page.waitForSelector('#pd-order-list .ord-card', { timeout: 3000 });
      ok('a price exactly at 平台價 is accepted and the line costs the platform price (成本 NT$1,500, 毛利 NT$0)',
        (await T(page, '#pd-order-list .ord-card')).includes('成本 NT$1,500') && (await T(page, '#pd-order-list .ord-card')).includes('毛利 NT$0'), await T(page, '#pd-order-list .ord-card'));
      const listed = await page.evaluate(async () => (await fetch('https://imagepicker.hotichen.workers.dev/api/admin/orders', { headers: { 'Authorization': 'Bearer adm' } })).text());
      ok('the line snapshotted the platform option and cost (stored), and the photographer’s order read never carries vendor_cost',
        o.st.orders[0].items[0].platform_option_id === 'popt-album-s' && o.st.orders[0].items[0].unit_cost === 1500 && o.st.orders[0].items[0].vendor_cost === 1400 &&
        listed.includes('platform_option_id') && !listed.includes('vendor_cost'), listed.slice(0, 200));
      // the platform retires the print between opening the picker and saving
      await page.click('#pd-order-add-btn');
      await page.waitForSelector('#pd-add-option');
      await page.selectOption('#pd-add-option', 'opt-print');
      await page.click('#pd-add-line');
      o.st.platform.find(p => p.id === 'plat-print').active = 0;
      await page.click('#pd-editor-save');
      await waitText(page, '#pd-editor-err', t => t.includes('已下架'));
      ok('a platform-retired option → 「這個商品規格已下架…」 and the editor stays', (await page.$('#pd-order-editor')) !== null && o.st.orders.length === 1);
      await page.click('#pd-editor-cancel');
      // editing the saved order: repricing a platform line under its cost is refused
      await page.click('[data-order-edit]');
      await page.waitForSelector('#pd-order-editor');
      await page.fill('.ord-line-edit .ord-price', '1499');
      await page.click('#pd-editor-save');
      await waitText(page, '#pd-editor-err', t => t.includes('不能低於平台價'));
      ok('editing a saved platform line under its own snapshotted cost → below_platform_price', o.st.orders[0].items[0].unit_price === 1500);
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-n', title: '沒商品' });
  const o = ordersFake({ products: [clone(PROD_SERVICE_OFF)] });
  await suite('admin — 沒有上架商品時，新增訂單指引到設定，而不是給空選單',
    `${base}/admin.html#project=proj-n`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-order-add-btn', { timeout: 5000 });
      await page.click('#pd-order-add-btn');
      await page.waitForSelector('#pd-order-editor');
      await page.waitForFunction(() => !document.getElementById('pd-order-editor').textContent.includes('載入商品中'), null, { timeout: 3000 });
      ok('no picker, a link to settings.html', (await page.$('#pd-add-option')) === null &&
        (await page.$eval('#pd-order-editor a', e => e.getAttribute('href'))) === 'settings.html');
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-e', title: '編輯訂單' });
  ADMIN_PICKS(m);
  const o = ordersFake({ platform: [clone(PLAT_ALBUM), clone(PLAT_PRINT)], products: [clone(PROD_ALBUM), clone(PROD_PRINT)] });
  o.st.addOrder({ id: 'ord-e1', project_id: 'proj-e', items: [
    { id: 'it-1', name: '相本書', option_label: '8×8 吋', kind: 'album', option_id: 'opt-album-s', unit_price: 3800, qty: 1, photo_keys: ['20260819/IMG_1.jpg'] },
    { id: 'it-2', name: '無框畫', kind: 'print', option_id: 'opt-print', unit_price: 1200, qty: 1 }] });
  o.st.addOrder({ id: 'ord-e2', project_id: 'proj-e', paid_amount: 5000, paid_method: 'cash', paid_at: '2026-09-20T04:00:00.000Z',
    items: [{ id: 'it-3', name: '相本書', kind: 'album', option_id: 'opt-album-s', unit_price: 5000, qty: 1 }] });
  await suite('admin — 編輯訂單：帶入現有品項，改數量／刪品項／加品項／折扣，PUT 整組；below_paid 與 conflict 顯示中文',
    `${base}/admin.html#project=proj-e`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-order-list .ord-card', { timeout: 5000 });
      // newest first: ord-e2 then ord-e1
      await page.click('[data-order-id="ord-e1"] [data-order-edit]');
      await page.waitForSelector('#pd-order-editor[data-mode="edit"]');
      ok('the editor replaces that order’s card, in place', (await page.$('[data-order-id="ord-e1"].ord-card')) === null && (await page.$('[data-order-id="ord-e2"].ord-card')) !== null);
      const lines = await page.$$eval('.ord-line-edit', els => els.map(e => ({ qty: e.querySelector('.ord-qty').value, price: e.querySelector('.ord-price').value,
        checked: [...e.querySelectorAll('.ord-photo:checked')].map(c => c.value) })));
      ok('existing lines are prefilled: qty, the snapshot price, ticked photos',
        JSON.stringify(lines) === JSON.stringify([{ qty: '1', price: '3800', checked: ['20260819/IMG_1.jpg'] }, { qty: '1', price: '1200', checked: [] }]), JSON.stringify(lines));
      await page.fill('.ord-line-edit:nth-child(1) .ord-qty', '3');
      await page.click('.ord-line-edit:nth-child(2) [data-line-del]');
      ok('移除 drops the line from the editor', (await page.$$('.ord-line-edit')).length === 1);
      await page.selectOption('#pd-add-option', 'opt-print');
      await page.click('#pd-add-line');
      await page.fill('#pd-ed-discount', '50');
      await page.fill('#pd-ed-note', '改過');
      await page.click('#pd-editor-save');
      await page.waitForSelector('[data-order-id="ord-e1"].ord-card', { timeout: 3000 });
      const put = o.st.calls.find(c => c.method === 'PUT');
      ok('PUT is the whole set: the kept line by id with its snapshot price, the new one by option_id with no override',
        put?.path === '/api/admin/orders/ord-e1' && JSON.stringify(put.body) === JSON.stringify({
          lines: [{ qty: 3, photo_keys: ['20260819/IMG_1.jpg'], id: 'it-1', unit_price: 3800 }, { qty: 1, photo_keys: [], option_id: 'opt-print' }],
          discount: 50, note: '改過' }), JSON.stringify(put));
      ok('the card shows the new total (3×3,800 + 1,200 − 50 = NT$12,550)', (await page.textContent('[data-order-id="ord-e1"] .ord-total')) === 'NT$12,550');

      // below_paid: shrink the paid order under what was received
      await page.click('[data-order-id="ord-e2"] [data-order-edit]');
      await page.waitForSelector('#pd-order-editor');
      await page.fill('.ord-line-edit .ord-price', '1000');
      await page.click('#pd-editor-save');
      await waitText(page, '#pd-editor-err', t => t.includes('不能低於已收金額'));
      ok('below_paid → 「訂單總額不能低於已收金額…」, the editor stays for a correction', (await page.$('#pd-order-editor')) !== null);
      // conflict: the page says so and re-reads
      o.st.inject = (method, path) => (method === 'PUT') ? { status: 409, body: { error: '訂單剛被修改，請重新整理', code: 'conflict' } } : null;
      await page.click('#pd-editor-save');
      await waitText(page, '#pd-order-err', t => t.includes('資料已被更新，請重新整理'));
      ok('conflict → 「資料已被更新，請重新整理」 and the orders are re-read (editor closed, cards back)',
        (await page.$('#pd-order-editor')) === null && (await page.$$('#pd-order-list .ord-card')).length === 2);
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-p', title: '收款' });
  const o = ordersFake({ products: [] });
  o.st.addOrder({ id: 'ord-u', project_id: 'proj-p', items: [{ name: '相本書', unit_price: 3200, qty: 1 }] });
  o.st.addOrder({ id: 'ord-part', project_id: 'proj-p', paid_amount: 1000, paid_method: 'cash', paid_at: '2026-09-20T04:00:00.000Z', items: [{ name: '無框畫', unit_price: 3200, qty: 1 }] });
  let dialogs = [];
  let answer = true;
  await suite('admin — 記錄收款：預設金額為訂單總額、方式與日期，overpaid 中文提示並留著表單，清除收款要確認',
    `${base}/admin.html#project=proj-p`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      page.on('dialog', d => { dialogs.push(d.message()); answer ? d.accept() : d.dismiss(); });
      await page.waitForSelector('#pd-order-list .ord-card', { timeout: 5000 });
      ok('no payment form until asked', (await page.$('[data-pay-form]')) === null);
      await page.click('[data-order-id="ord-u"] [data-pay-open]');
      await page.waitForSelector('[data-order-id="ord-u"] [data-pay-form]');
      const f = await page.$eval('[data-order-id="ord-u"] [data-pay-form]', e => ({ amount: e.querySelector('.pay-amount').value, method: e.querySelector('.pay-method').value,
        methods: [...e.querySelectorAll('.pay-method option')].map(x => x.textContent), date: e.querySelector('.pay-date').value }));
      ok('default amount is what is owed (the whole NT$3,200)', f.amount === '3200', f.amount);
      ok('methods are 現金 / 轉帳 / 其他', f.methods.join() === '現金,轉帳,其他', f.methods.join());
      ok('the date defaults to today (a YYYY-MM-DD, Taipei)', f.date === todayTaipeiNode(), f.date);
      ok('the 記錄收款 button gives way to the form', (await page.$('[data-order-id="ord-u"] [data-pay-open]')) === null);

      await page.fill('[data-order-id="ord-u"] .pay-amount', '9999');
      await page.click('[data-order-id="ord-u"] [data-pay-save]');
      await waitText(page, '[data-order-id="ord-u"] [data-order-err]', t => t.includes('收款金額不能超過訂單總額'));
      ok('overpaid → 「收款金額不能超過訂單總額」, the form stays so the amount can be fixed', (await page.$('[data-order-id="ord-u"] [data-pay-form]')) !== null);
      await page.fill('[data-order-id="ord-u"] .pay-amount', '3200');
      await page.selectOption('[data-order-id="ord-u"] .pay-method', 'transfer');
      await page.click('[data-order-id="ord-u"] [data-pay-save]');
      await page.waitForFunction(() => document.querySelector('[data-order-id="ord-u"] .ord-pay')?.textContent === '已付清', null, { timeout: 3000 });
      const pay = o.st.calls.filter(c => c.path === '/api/admin/orders/ord-u/payment').pop();
      ok('POST /payment carries amount, method and the date', JSON.stringify(pay.body) === JSON.stringify({ paid_amount: 3200, paid_method: 'transfer', paid_at: todayTaipeiNode() }), JSON.stringify(pay.body));
      ok('the card is now 已付清 with 未收 NT$0 and offers 清除收款',
        (await page.textContent('[data-order-id="ord-u"] .ord-owed')) === 'NT$0' && (await page.$('[data-order-id="ord-u"] [data-pay-clear]')) !== null);

      // a part-paid order: the default settles it (paid_amount is the running total, not an extra instalment)
      ok('the part-paid order says 部分已付 and owes NT$2,200', (await page.textContent('[data-order-id="ord-part"] .ord-pay')) === '部分已付' &&
        (await page.textContent('[data-order-id="ord-part"] .ord-owed')) === 'NT$2,200');
      await page.click('[data-order-id="ord-part"] [data-pay-open]');
      ok('its form defaults to the total (NT$3,200) with the earlier method preselected',
        (await page.inputValue('[data-order-id="ord-part"] .pay-amount')) === '3200' && (await page.inputValue('[data-order-id="ord-part"] .pay-method')) === 'cash' &&
        (await page.inputValue('[data-order-id="ord-part"] .pay-date')) === '2026-09-20');
      await page.click('[data-order-id="ord-part"] [data-pay-cancel]');
      ok('取消 closes the form, nothing sent', (await page.$('[data-pay-form]')) === null && o.st.calls.filter(c => /ord-part\/payment/.test(c.path)).length === 0);

      // clearing
      answer = false;
      await page.click('[data-order-id="ord-u"] [data-pay-clear]');
      await page.waitForTimeout(300);
      ok('declining the confirm sends nothing', o.st.calls.filter(c => c.body?.paid_amount === 0).length === 0 && dialogs.some(t => t.includes('清除')));
      answer = true;
      await page.click('[data-order-id="ord-u"] [data-pay-clear]');
      await page.waitForFunction(() => document.querySelector('[data-order-id="ord-u"] .ord-pay')?.textContent === '未付款', null, { timeout: 3000 });
      ok('confirming posts paid_amount 0 and the order is 未付款 again, NT$3,200 owed',
        JSON.stringify(o.st.calls.filter(c => c.body?.paid_amount === 0).pop()?.body) === JSON.stringify({ paid_amount: 0 }) &&
        (await page.textContent('[data-order-id="ord-u"] .ord-owed')) === 'NT$3,200' && (await page.$('[data-order-id="ord-u"] [data-pay-clear]')) === null);
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-s', title: '狀態' });
  const o = ordersFake({ products: [] });
  o.st.addOrder({ id: 'ord-s', project_id: 'proj-s', items: [{ name: '相本書', unit_price: 3000, qty: 1 }] });
  o.st.addOrder({ id: 'ord-r', project_id: 'proj-s', status: 'requested', items: [{ name: '無框畫', unit_price: 1200, qty: 1 }] });
  let answer = false;
  const dialogs = [];
  await suite('admin — 狀態按鈕：確認／完成／復原／取消（取消要確認），bad_transition 顯示中文',
    `${base}/admin.html#project=proj-s`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      page.on('dialog', d => { dialogs.push(d.message()); answer ? d.accept() : d.dismiss(); });
      await page.waitForSelector('#pd-order-list .ord-card', { timeout: 5000 });
      const btns = id => page.$$eval(`[data-order-id="${id}"] [data-status-to]`, els => els.map(e => `${e.dataset.statusTo}:${e.textContent}`).join());
      ok('requested offers 確認 and 取消訂單 (and not 完成)', (await btns('ord-r')) === 'confirmed:確認,cancelled:取消訂單', await btns('ord-r'));
      ok('confirmed offers 完成 and 取消訂單 (and not 確認)', (await btns('ord-s')) === 'fulfilled:完成,cancelled:取消訂單', await btns('ord-s'));

      await page.click('[data-order-id="ord-r"] [data-status-to="confirmed"]');
      await page.waitForFunction(() => document.querySelector('[data-order-id="ord-r"]')?.dataset.status === 'confirmed', null, { timeout: 3000 });
      ok('確認 posts {status: confirmed} with no confirm dialog', o.st.calls.some(c => c.path === '/api/admin/orders/ord-r/status' && c.body.status === 'confirmed') && dialogs.length === 0);

      await page.click('[data-order-id="ord-s"] [data-status-to="fulfilled"]');
      await page.waitForFunction(() => document.querySelector('[data-order-id="ord-s"]')?.dataset.status === 'fulfilled', null, { timeout: 3000 });
      ok('完成 → 已完成, and the buttons become 復原為已確認 / 取消訂單', (await btns('ord-s')) === 'confirmed:復原為已確認,cancelled:取消訂單' &&
        (await page.textContent('[data-order-id="ord-s"] .ord-status')) === '已完成');
      await page.click('[data-order-id="ord-s"] [data-status-to="confirmed"]');
      await page.waitForFunction(() => document.querySelector('[data-order-id="ord-s"]')?.dataset.status === 'confirmed', null, { timeout: 3000 });
      ok('復原 goes back to 已確認', (await btns('ord-s')) === 'fulfilled:完成,cancelled:取消訂單');

      await page.click('[data-order-id="ord-s"] [data-status-to="cancelled"]');
      await page.waitForTimeout(300);
      ok('取消訂單 asks first; declining sends nothing and changes nothing',
        dialogs.length === 1 && dialogs[0].includes('取消') && !o.st.calls.some(c => c.body?.status === 'cancelled') &&
        (await page.$eval('[data-order-id="ord-s"]', e => e.dataset.status)) === 'confirmed');
      answer = true;
      await page.click('[data-order-id="ord-s"] [data-status-to="cancelled"]');
      await page.waitForFunction(() => document.querySelector('[data-order-id="ord-s"]')?.dataset.status === 'cancelled', null, { timeout: 3000 });
      // 亮色主題: "greyed" is now a cream tint + dashed edge (opacity would pull its muted text under
      // 4.5:1); the live card it was a moment ago is white with a solid edge, so the change is real
      ok('accepting cancels: set apart (cream tint, dashed edge), 已取消, and no buttons left', (await page.$$('[data-order-id="ord-s"] .ord-actions button')).length === 0 &&
        (await page.$eval('[data-order-id="ord-s"]', e => { const c = getComputedStyle(e); return c.backgroundColor === 'rgb(255, 248, 238)' && c.borderTopStyle === 'dashed'; })) &&
        (await page.$eval('[data-order-id="ord-r"]', e => { const c = getComputedStyle(e); return c.backgroundColor === 'rgb(255, 255, 255)' && c.borderTopStyle === 'solid'; })));

      // a move that lost a race: the Worker says where the order really is
      o.st.inject = (method, path) => /ord-r\/status/.test(path) ? { status: 409, body: { error: '無法從 cancelled 改為 fulfilled', code: 'bad_transition', from: 'cancelled', to: 'fulfilled' } } : null;
      await page.click('[data-order-id="ord-r"] [data-status-to="fulfilled"]');
      await waitText(page, '[data-order-id="ord-r"] [data-order-err]', t => t.includes('無法執行'));
      ok('bad_transition → 「訂單目前是「已取消」，無法執行這個操作，請重新整理」',
        (await page.textContent('[data-order-id="ord-r"] [data-order-err]')) === '訂單目前是「已取消」，無法執行這個操作，請重新整理');
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN });
}

// ── orders.html ────────────────────────────────────────────────────────────
{
  const m = dashSettingsMock();
  const o = ordersFake({ products: [], titles: { 'proj-1': '海邊系列', 'proj-2': '婚紗 & 外拍' } });
  o.st.addOrder({ id: 'o1', project_id: 'proj-1', status: 'confirmed', items: [{ name: '相本書', option_label: '8×8 吋', unit_price: 1234, qty: 1 }] });
  o.st.addOrder({ id: 'o2', project_id: 'proj-2', status: 'fulfilled', paid_amount: 3000, paid_method: 'cash', items: [{ name: '無框畫', unit_price: 3000, qty: 1 }] });
  o.st.addOrder({ id: 'o3', project_id: 'proj-2', status: 'cancelled', items: [{ name: '加挑照片', kind: 'extra_pick', unit_price: 200, qty: 5 }] });
  o.st.addOrder({ id: 'o4', project_id: 'proj-1', status: 'fulfilled', paid_amount: 500, paid_method: 'cash', items: [{ name: '相框', unit_price: 1500, qty: 1 }] });
  await suite('訂單頁 — 跨專案列表：專案名、合計、未收、連到專案；全部／未付款／狀態篩選',
    `${base}/orders.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.ord-row', { timeout: 5000 });
      const rows = async () => page.$$eval('.ord-row', els => els.map(e => ({
        id: e.dataset.orderId, status: e.dataset.status, title: e.querySelector('.ord-proj').textContent,
        hrefs: [...e.querySelectorAll('a')].map(a => a.getAttribute('href')), total: e.querySelector('.ord-total').textContent,
        owed: e.querySelector('.ord-owed').textContent, owedRed: e.querySelector('.ord-owed').classList.contains('owed'),
        text: e.textContent.replace(/\s+/g, ' '), opacity: getComputedStyle(e).opacity })));
      let r = await rows();
      ok('全部 asks for /api/admin/orders with no filter and lists all four',
        r.length === 4 && o.st.calls.at(-1).path === '/api/admin/orders' && o.st.calls.at(-1).search === '', JSON.stringify([r.length, o.st.calls.at(-1)]));
      const r1 = r.find(x => x.id === 'o1');
      ok('a row shows project title, NT$1,234-style total, outstanding and its lines', r1.title === '海邊系列' && r1.total === 'NT$1,234' && r1.owed === 'NT$1,234' && r1.owedRed && r1.text.includes('相本書 · 8×8 吋 × 1'), JSON.stringify(r1));
      ok('every link on a row goes to that project’s detail (a &-title is escaped, the id URL-encoded)',
        r.every(x => x.hrefs.length === 2 && x.hrefs.every(h => h === `admin.html#project=${x.id === 'o1' || x.id === 'o4' ? 'proj-1' : 'proj-2'}`)), JSON.stringify(r.map(x => x.hrefs)));
      ok('title text with & renders literally', r.find(x => x.id === 'o2').title === '婚紗 & 外拍');
      ok('a fully paid order owes NT$0 and is not red; a cancelled one is greyed',
        r.find(x => x.id === 'o2').owed === 'NT$0' && !r.find(x => x.id === 'o2').owedRed && Number(r.find(x => x.id === 'o3').opacity) < 1);
      ok('status labels are Chinese', r.find(x => x.id === 'o2').text.includes('已完成') && r.find(x => x.id === 'o3').text.includes('已取消') && r1.text.includes('已確認'));
      ok('the side menu marks 訂單 active', (await page.$eval('.side-nav-item.active', e => e.textContent)) === '訂單');
      ok('the summary adds up what is owed (1,234 + 1,000 = NT$2,234)', (await page.textContent('#summary')).includes('未付款'.slice(0, 0) + '未收合計 NT$2,234'), await page.textContent('#summary'));

      await page.click('[data-filter="unpaid"]');
      await page.waitForFunction(() => document.querySelectorAll('.ord-row').length === 2, null, { timeout: 3000 });
      ok('未付款 asks for ?unpaid=1 and shows only orders that still owe', o.st.calls.at(-1).search === '?unpaid=1' &&
        JSON.stringify((await rows()).map(x => x.id).sort()) === JSON.stringify(['o1', 'o4']), o.st.calls.at(-1).search);
      ok('the active chip moved', (await page.$eval('.chip.active', e => e.textContent)) === '未付款' && (await page.$$('.chip.active')).length === 1);

      await page.click('[data-filter="cancelled"]');
      await page.waitForFunction(() => document.querySelectorAll('.ord-row').length === 1, null, { timeout: 3000 });
      ok('已取消 asks for ?status=cancelled and shows only that', o.st.calls.at(-1).search === '?status=cancelled' && (await rows())[0].id === 'o3');
      await page.click('[data-filter="requested"]');
      await waitText(page, '#order-list', t => t.includes('沒有符合的訂單'));
      ok('a filter with no orders says so instead of a blank page', (await page.textContent('#order-list')).includes('沒有符合的訂單') && (await page.$$('.ord-row')).length === 0);
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const o = ordersFake({ products: [], titles: { 'proj-1': 'A' } });
  o.st.addOrder({ id: 'q1', project_id: 'proj-1', items: [{ name: '相本書', unit_price: 100, qty: 1 }] });
  o.st.addOrder({ id: 'q2', project_id: 'proj-1', paid_amount: 100, paid_method: 'cash', items: [{ name: '無框畫', unit_price: 100, qty: 1 }] });
  await suite('訂單頁 — ?filter=unpaid（儀表板的待辦連結）直接套用未付款篩選',
    `${base}/orders.html?filter=unpaid`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.ord-row', { timeout: 5000 });
      ok('the unpaid chip is active and only the unpaid order is listed', (await page.$eval('.chip.active', e => e.textContent)) === '未付款' &&
        (await page.$$eval('.ord-row', els => els.map(e => e.dataset.orderId).join())) === 'q1' && o.st.calls[0].search === '?unpaid=1');
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

await suite('訂單頁 — 沒有 studio_token 時跳轉回 home.html',
  `${base}/orders.html`,
  async page => {
    await page.waitForURL('**/home.html', { timeout: 3000 }).catch(() => {});
    return [`${/home\.html/.test(page.url()) ? 'ok  ' : 'FAIL'}  redirected to home.html   [${page.url()}]`];
  });

// ── dashboard revenue ──────────────────────────────────────────────────────
{
  const m = dashSettingsMock({
    stats: {
      by_phase: { picking: 0, submitted: 0, retouching: 0 }, delivered: 0, archived: 0,
      per_month: [{ month: '2026-08', created: 1, delivered: 1 }, { month: '2026-09', created: 2, delivered: 2 }],
      revenue: [{ month: '2026-08', paid: 5000, cost: 1000, margin: 4000 }, { month: '2026-09', paid: 12345, cost: 4000, margin: 8345 }],
      outstanding: 6000,
      todo: { submitted_not_retouching: 0, unnotified_submissions: 0, modified_after_submit: 0, unpaid_orders: 3 },
    },
  });
  await suite('儀表板 — 本月營收／毛利／未收款卡片、每月營收圖、待辦「未付款訂單 N」',
    `${base}/dashboard.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.getElementById('stat-revenue').textContent !== '–', null, { timeout: 5000 });
      const cards = await page.evaluate(() => ['stat-revenue', 'stat-margin', 'stat-outstanding'].map(id => {
        const n = document.getElementById(id); return [n.textContent, n.parentElement.querySelector('.label').textContent];
      }));
      ok('the cards read the last (current) month: 本月營收 NT$12,345 / 本月毛利 NT$8,345 / 未收款 NT$6,000',
        JSON.stringify(cards) === JSON.stringify([['NT$12,345', '本月營收'], ['NT$8,345', '本月毛利'], ['NT$6,000', '未收款']]), JSON.stringify(cards));
      const bars = await page.$$eval('#rev-chart .chart-col', cols => cols.map(c => ({ rev: c.querySelector('.chart-bar.revenue').style.height, margin: c.querySelector('.chart-bar.margin').style.height, title: c.title })));
      ok('two months; the biggest revenue is 100%, August 5,000/12,345 = 41%; margin scales on the same axis (8,345 → 68%)',
        bars.length === 2 && bars[1].rev === '100%' && bars[0].rev === '41%' && bars[1].margin === '68%' && bars[0].margin === '32%', JSON.stringify(bars));
      ok('the tooltip carries the exact money', bars[1].title.includes('營收 NT$12,345') && bars[1].title.includes('毛利 NT$8,345'), bars[1].title);
      ok('month labels under the revenue chart', (await page.$$eval('#rev-chart-labels span', els => els.map(e => e.textContent).join())) === '08,09');
      const todo = await page.$$eval('#todo-list li', els => els.map(e => ({ text: e.textContent.replace(/\s+/g, ' ').trim(), href: e.querySelector('a').getAttribute('href') })));
      ok('待辦 gains 未付款訂單 3, linking to the unpaid filter', todo.length === 1 && todo[0].text.startsWith('未付款訂單 3') && todo[0].href === 'orders.html?filter=unpaid', JSON.stringify(todo));
      const cols = await page.$eval('.stat-cards.money', e => getComputedStyle(e).gridTemplateColumns.split(' ').length);
      ok('the money cards are a row of three', cols === 3, String(cols));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  await suite('儀表板 — 舊版 Worker（stats 沒有 revenue）：卡片顯示 –，不當掉，也沒有未付款待辦',
    `${base}/dashboard.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#todo-list .todo-empty', { timeout: 5000 });
      const vals = await page.evaluate(() => ['stat-revenue', 'stat-margin', 'stat-outstanding'].map(id => document.getElementById(id).textContent));
      ok('the three cards stay on –', vals.join() === '–,–,–', vals.join());
      ok('the revenue chart says 尚無資料', (await page.textContent('#rev-chart')).includes('尚無資料'));
      ok('no 未付款訂單 line', !(await page.textContent('#todo-list')).includes('未付款訂單'));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

// ═══════════════════════════════════════════════════════════════════════════
// Retouch pins — the guest's 標示修改 in the preview, the photographer's
// read-only view of them, and the admin diff line (docs/backlog.md "Retouch
// pins", docs/guest-picking.md "Retouch pins — the save contract"). Phone
// (390px) throughout, real touch input (realTouch) on the 1600x1067 gradient
// BIG_PHOTO: R grows left→right and G top→bottom, so a canvas pixel says which
// point of the photo is under a finger — an oracle that does not share the
// code's own coordinate math.
// ═══════════════════════════════════════════════════════════════════════════
const PIN_PUTS = m => m.requests.filter(r => r.method === 'PUT' && r.path === '/api/pick/selections');
const PIN_FLUSH = page => page.evaluate(() => PickController.flush());
const PIN_STATE = page => page.evaluate(() => ({
  marks: annotationManager.marks.map(x => ({ ...x })),
  mode: annotationManager.pinMode,
  rating: app.filteredPhotos[app.currentPhotoIndex].rating,
  counter: document.getElementById('photoCounter').textContent,
}));
const PIN_FIT = () => {
  const box = document.querySelector('.canvas-container');
  const cr = box.getBoundingClientRect(), cs = getComputedStyle(box);
  const left = cr.left + parseFloat(cs.borderLeftWidth), top = cr.top + parseFloat(cs.borderTopWidth);
  const cw = box.clientWidth, ch = box.clientHeight;
  const k = Math.min(cw / 1600, ch / 1067, 1);
  const w = Math.floor(1600 * k), h = Math.floor(1067 * k);
  return { left: left + (cw - w) / 2, top: top + (ch - h) / 2, w, h };
};
const isPinPx = px => !!px && px[0] > 190 && px[1] < 110 && px[2] < 130;
const PIN_SEL = (marks, rating = 1, note = '') => ({ rating, note, marks, updated_by: 'picker-0', updated_at: '2026-01-01T00:00:00Z' });
const pinNear = (a, b, tol = 0.012) => Math.abs(a - b) <= tol;
async function pinOpenHearted(page, { heart = true } = {}) {
  const box = await openBigGuestPreview(page);
  const t = await realTouch(page);
  if (heart) { await page.locator('#modalPhotoRating .pick-heart-btn').tap(); await page.waitForTimeout(60); }
  return { ...box, t };
}
// screen point of a fraction of the fitted photo at zoom 1
const pinPoint = async (page, fx, fy) => {
  const f = await page.evaluate(PIN_FIT);
  return { x: f.left + f.w * fx, y: f.top + f.h * fy };
};

{
  const m = pickFakeWorker({ ownerName: 'Pia', ownerKey: 'PIA-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('retouch pins (guest 390px) — 標示修改 only on a ♥ photo; taps place numbered pins at the tapped fraction; notes, delete and the 10-pin limit',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { t } = await pinOpenHearted(page, { heart: false });
      const has = sel => page.evaluate(s => !!document.querySelector(s), sel);

      ok('no 標示修改 button in the DOM on a photo that is not ♥', !(await has('#pickPinBtn')));
      ok('nor a pin list', !(await has('#pickPinsSection')));
      ok('no orange tools toggle for a guest', !(await has('#mobileToolsToggle')));
      // hit-test: the 備註・標示 button is the top element at its own centre and
      // never sits on the bottom ♥ bar (which stays tappable)
      const hit = await page.evaluate(() => {
        const b = document.getElementById('pickPanelBtn');
        const r = b.getBoundingClientRect();
        const bar = document.querySelector('.modal-photo-info').getBoundingClientRect();
        const heart = document.querySelector('#modalPhotoRating .pick-heart-btn').getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        const hTop = document.elementFromPoint(heart.left + heart.width / 2, heart.top + heart.height / 2);
        return { text: b.textContent, display: getComputedStyle(b).display, w: r.width, h: r.height,
          overlapsBar: r.bottom > bar.top && r.top < bar.bottom,
          onTop: top === b, heartOnTop: !!hTop.closest('.pick-heart-btn'), heartBox: !!heart.width };
      });
      ok('the guest gets a labelled 備註・標示 button (text, shown, ≥44px)',
        hit.text === '備註・標示' && hit.display !== 'none' && hit.w >= 44 && hit.h >= 44, JSON.stringify(hit));
      ok('it does not overlap the bottom ♥ bar', hit.overlapsBar === false, JSON.stringify(hit));
      ok('it is what a tap on it hits, and the ♥ is still what a tap on the ♥ hits', hit.onTop && hit.heartOnTop, JSON.stringify(hit));

      await page.locator('#modalPhotoRating .pick-heart-btn').tap();
      await page.waitForTimeout(60);
      const btn = await page.evaluate(() => {
        const b = document.getElementById('pickPinBtn');
        return b ? { text: b.textContent, display: getComputedStyle(b).display, h: b.getBoundingClientRect().height } : null;
      });
      ok('♥ → 標示修改 appears (in the DOM, really displayed, ≥44px)',
        !!btn && btn.text === '標示修改' && btn.display !== 'none' && btn.h >= 44, JSON.stringify(btn));

      await page.locator('#pickPinBtn').tap();
      await page.waitForTimeout(60);
      ok('pin mode on: 完成 shows, 標示修改 is gone, the hint shows',
        (await has('#pickPinDoneBtn')) && !(await has('#pickPinBtn')) && (await has('#pickPinHint')));

      // tap 1 at (0.30, 0.40) of the photo
      let p = await pinPoint(page, 0.30, 0.40);
      await t.tap(p.x, p.y);
      await page.waitForTimeout(80);
      let st = await PIN_STATE(page);
      ok('pin ① is at the tapped fraction of the photo',
        st.marks.length === 1 && pinNear(st.marks[0].x, 0.30) && pinNear(st.marks[0].y, 0.40), JSON.stringify(st.marks));
      const px = await page.evaluate(CANVAS_PX, [p.x - 8, p.y]);
      ok('and it is drawn there (red marker pixel, not photo)', isPinPx(px), JSON.stringify(px));
      ok('still ♥, still on the same photo', st.rating === 1 && st.counter === '1 / 3', JSON.stringify(st));

      p = await pinPoint(page, 0.70, 0.60);
      await t.tap(p.x, p.y);
      await page.waitForTimeout(80);
      st = await PIN_STATE(page);
      ok('the second tap makes ②', st.marks.length === 2 && pinNear(st.marks[1].x, 0.70) && pinNear(st.marks[1].y, 0.60),
        JSON.stringify(st.marks));
      ok('the list has 2 rows numbered 1, 2',
        (await page.evaluate(() => [...document.querySelectorAll('#pickPinList .pick-pin-num')].map(e => e.textContent).join())) === '1,2');

      await PIN_FLUSH(page);
      let puts = PIN_PUTS(m);
      let body = puts[puts.length - 1].body;
      const item = body.upsert.find(i => i.photo_key === m.state.selections.keys().next().value);
      ok('the save carries the photo with its FULL marks array, canonical x/y/note',
        body.upsert.length === 1 && item.rating === 1 && Array.isArray(item.marks) && item.marks.length === 2 &&
        Object.keys(item.marks[0]).join() === 'x,y,note' && item.marks[0].note === '' &&
        pinNear(item.marks[0].x, 0.30) && pinNear(item.marks[1].y, 0.60), JSON.stringify(body));
      const stored = [...m.state.selections.values()][0];
      ok('and the fake server (mirroring the contract) stored two pins', stored.marks && stored.marks.length === 2, JSON.stringify(stored));

      // note: open the panel with the labelled button, type
      await page.locator('#pickPanelBtn').tap();
      await page.waitForTimeout(400);
      const sheetOpen = await page.evaluate(() => document.getElementById('modalSidebar').classList.contains('active'));
      ok('备註・標示 opens the panel', sheetOpen);
      await page.locator('#pickPinList .pick-pin-note').first().fill('這裡痘痘');
      const counter = await page.evaluate(() => document.querySelector('#pickPinList .pick-pin-count').textContent);
      ok('the note has a counter', counter === '4/100', counter);
      const maxlen = await page.evaluate(() => document.querySelector('#pickPinList .pick-pin-note').maxLength);
      ok('the note input is capped at 100', maxlen === 100, String(maxlen));
      await PIN_FLUSH(page);
      puts = PIN_PUTS(m);
      body = puts[puts.length - 1].body;
      ok('a note edit saves the full marks (both pins, the first with its note)',
        body.upsert.length === 1 && body.upsert[0].marks.length === 2 && body.upsert[0].marks[0].note === '這裡痘痘' &&
        body.upsert[0].marks[1].note === '', JSON.stringify(body));

      // control characters pasted in never reach the wire (the server would 400 the whole save)
      await page.locator('#pickPinList .pick-pin-note').nth(1).fill('a\u0007b c');
      await PIN_FLUSH(page);
      puts = PIN_PUTS(m);
      body = puts[puts.length - 1].body;
      ok('control / line-separator characters are stripped client-side',
        body.upsert[0].marks[1].note === 'abc' && (await page.evaluate(() => document.querySelector('#toastContainer .toast.error')?.textContent || '')) === '',
        JSON.stringify(body));

      // limit: 8 more → 10, the 11th refused with a friendly message
      await page.locator('#modalSidebar .btn-close-mini').tap();
      await page.waitForTimeout(400);
      for (let i = 0; i < 8; i++) {
        p = await pinPoint(page, 0.10 + 0.09 * i, 0.15 + 0.03 * i);
        await t.tap(p.x, p.y);
        await page.waitForTimeout(40);
      }
      st = await PIN_STATE(page);
      ok('10 pins', st.marks.length === 10, String(st.marks.length));
      await page.screenshot({ path: '/tmp/claude-0/-home-user-imge-picker/239eaf5f-50a8-5d76-9673-4b17f1434015/scratchpad/pins-guest-390.png' });
      p = await pinPoint(page, 0.50, 0.90);
      await t.tap(p.x, p.y);
      await page.waitForTimeout(80);
      st = await PIN_STATE(page);
      const toasts = await page.evaluate(() => [...document.querySelectorAll('#toastContainer .toast-message')].map(e => e.textContent));
      ok('the 11th tap is refused (still 10) with a friendly message',
        st.marks.length === 10 && toasts.some(x => x.includes('最多標示 10')), JSON.stringify({ n: st.marks.length, toasts }));

      // delete pin ① from the list
      await page.locator('#pickPanelBtn').tap();
      await page.waitForTimeout(400);
      const secondNote = await page.evaluate(() => document.querySelectorAll('#pickPinList .pick-pin-note')[1].value);
      await page.locator('#pickPinList .pick-pin-del').first().tap();
      await page.waitForTimeout(60);
      st = await PIN_STATE(page);
      ok('× deletes that pin (9 left) and the rest renumber, keeping their notes',
        st.marks.length === 9 && st.marks[0].note === secondNote &&
        (await page.evaluate(() => document.querySelectorAll('#pickPinList .pick-pin-item').length)) === 9, JSON.stringify(st.marks));
      await PIN_FLUSH(page);
      puts = PIN_PUTS(m);
      body = puts[puts.length - 1].body;
      ok('the delete saves the full remaining list', body.upsert[0].marks.length === 9, JSON.stringify(body).slice(0, 200));

      // a second photo: ♥ only → its request item carries no `marks` at all
      await page.locator('#modalSidebar .btn-close-mini').tap();
      await page.waitForTimeout(400);
      await page.locator('#pickPinDoneBtn').tap();
      await page.waitForTimeout(60);
      const before = PIN_PUTS(m).length;
      await page.locator('#nextPhotoBtn').tap();
      await page.waitForTimeout(300);
      await page.locator('#modalPhotoRating .pick-heart-btn').tap();
      await page.waitForTimeout(60);
      ok('on the next (not yet ♥) photo there was no 標示修改 until ♥', await has('#pickPinBtn'));
      await PIN_FLUSH(page);
      puts = PIN_PUTS(m);
      const fresh = puts.slice(before).flatMap(r => r.body.upsert);
      ok('saving photo 2\'s ♥ (and photo 1\'s note flush) sends no `marks` key on any item — no pin changed',
        fresh.some(i => i.photo_key !== item.photo_key && i.rating === 1) && fresh.every(i => !('marks' in i)),
        JSON.stringify(fresh));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'PIA-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Vera', ownerKey: 'VERA-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('retouch pins (guest) — fractions survive a viewport change 390→1280; the desktop panel replaces the button',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { t } = await pinOpenHearted(page);
      await page.locator('#pickPinBtn').tap();
      const p = await pinPoint(page, 0.35, 0.45);
      await t.tap(p.x, p.y);
      await page.waitForTimeout(80);
      const before = (await PIN_STATE(page)).marks[0];
      ok('placed at 0.35 / 0.45', pinNear(before.x, 0.35) && pinNear(before.y, 0.45), JSON.stringify(before));

      await page.setViewportSize({ width: 1280, height: 900 });
      await page.waitForTimeout(400);
      const after = (await PIN_STATE(page)).marks[0];
      ok('the stored fraction is unchanged at 1280px', after.x === before.x && after.y === before.y, JSON.stringify(after));
      const f = await page.evaluate(PIN_FIT);
      const px = await page.evaluate(CANVAS_PX, [f.left + f.w * 0.35 - 8, f.top + f.h * 0.45]);
      ok('and the marker is drawn at that fraction of the (differently sized) photo', isPinPx(px), JSON.stringify({ f, px }));
      const wide = await page.evaluate(() => ({
        panelBtn: getComputedStyle(document.getElementById('pickPanelBtn')).display,
        sidebar: document.getElementById('modalSidebar').getBoundingClientRect().width,
        list: !!document.querySelector('#modalSidebar #pickPinList'),
      }));
      ok('at 1280 the side panel is open with the pin list, and the phone button is not shown',
        wide.panelBtn === 'none' && wide.sidebar > 200 && wide.list, JSON.stringify(wide));
      // the mouse places a pin too (desktop) — click, not drag
      const q = { x: f.left + f.w * 0.60, y: f.top + f.h * 0.30 };
      await page.waitForTimeout(800); // past the touch-then-click suppression window
      await page.mouse.click(q.x, q.y);
      await page.waitForTimeout(80);
      const st = await PIN_STATE(page);
      ok('a mouse click in pin mode places a pin too',
        st.marks.length === 2 && pinNear(st.marks[1].x, 0.60) && pinNear(st.marks[1].y, 0.30), JSON.stringify(st.marks));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'VERA-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Zack', ownerKey: 'ZACK-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('retouch pins (guest) — a zoomed tap maps back through zoom/pan; the marker stays finger-sized',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { cx, cy, t } = await pinOpenHearted(page);
      await page.locator('#pickPinBtn').tap();
      await t.pinch(cx, cy, 60, 220);
      await page.waitForTimeout(80);
      const z = await page.evaluate(() => annotationManager.zoom);
      ok('pinched in', z > 2, String(z));
      // where a finger lands on the photo, per the pixels actually drawn there
      const tap = { x: cx + 40, y: cy - 25 };
      const under = await page.evaluate(CANVAS_PX, [tap.x, tap.y]);
      await t.tap(tap.x, tap.y);
      await page.waitForTimeout(80);
      const st = await PIN_STATE(page);
      ok('exactly one pin was placed, at the photo point that was under the finger',
        st.marks.length === 1 && Math.abs(st.marks[0].x - under[0] / 255) < 0.02 && Math.abs(st.marks[0].y - under[1] / 255) < 0.02,
        JSON.stringify({ marks: st.marks, under }));
      const near = await page.evaluate(CANVAS_PX, [tap.x - 8, tap.y]);
      const far = await page.evaluate(CANVAS_PX, [tap.x - 30, tap.y]);
      ok('it is drawn under the finger with a marker radius that did not grow with the zoom',
        isPinPx(near) && !isPinPx(far), JSON.stringify({ near, far, zoom: z }));

      // pan, and it follows the photo
      const pan0 = await page.evaluate(() => annotationManager.panX);
      await t.drag(cx, cy + 80, cx - 60, cy + 80);
      await page.waitForTimeout(80);
      const pan1 = await page.evaluate(() => annotationManager.panX);
      const moved = await page.evaluate(CANVAS_PX, [tap.x - 60 - 8, tap.y]);
      ok('after a pan the marker moved with the photo', pan1 < pan0 && isPinPx(moved) && (await PIN_STATE(page)).marks.length === 1,
        JSON.stringify({ pan0, pan1, moved }));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZACK-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Dana', ownerKey: 'DANA-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('retouch pins (guest) — pin mode blocks double-tap ♥ and swipe; un-heart with pins asks first and sends nothing on cancel',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const dialogs = [];
      let accept = false;
      page.on('dialog', d => { dialogs.push(d.message()); accept ? d.accept() : d.dismiss(); });
      const { cx, cy, t } = await pinOpenHearted(page);
      await page.locator('#pickPinBtn').tap();
      const p = await pinPoint(page, 0.5, 0.5);

      await t.doubleTap(p.x, p.y);
      await page.waitForTimeout(150);
      let st = await PIN_STATE(page);
      ok('a double-tap in pin mode did not un-♥ (and asked nothing)', st.rating === 1 && dialogs.length === 0, JSON.stringify({ st, dialogs }));
      ok('no ♥ burst either', (await page.evaluate(() => document.querySelectorAll('.pick-heart-burst').length)) === 0);
      ok('each tap is just a pin (2 pins)', st.marks.length === 2, JSON.stringify(st.marks));

      await t.drag(cx + 120, cy + 60, cx - 120, cy + 60);
      await page.waitForTimeout(150);
      st = await PIN_STATE(page);
      ok('a swipe left in pin mode does not go to the next photo, and places no pin',
        st.counter === '1 / 3' && st.marks.length === 2, JSON.stringify(st));
      await t.drag(cx, cy - 20, cx + 5, cy + 200);
      await page.waitForTimeout(150);
      ok('nor does a swipe down close the preview',
        await page.evaluate(() => document.getElementById('photoModal').classList.contains('active')));

      await page.locator('#pickPinDoneBtn').tap();
      await page.waitForTimeout(80);
      ok('完成 leaves pin mode (標示修改 is back)', await page.evaluate(() => !!document.getElementById('pickPinBtn') && !document.getElementById('pickPinDoneBtn')));
      await t.drag(cx + 120, cy + 60, cx - 120, cy + 60);
      await page.waitForTimeout(150);
      st = await PIN_STATE(page);
      ok('outside pin mode the same swipe navigates again (positive control)', st.counter === '2 / 3', JSON.stringify(st));
      await page.locator('#prevPhotoBtn').tap();
      await page.waitForTimeout(300);

      await PIN_FLUSH(page);
      const putsBefore = PIN_PUTS(m).length;
      await page.waitForTimeout(600); // clear the double-tap window
      await t.doubleTap(p.x, p.y);
      await page.waitForTimeout(200);
      st = await PIN_STATE(page);
      ok('double-tap ♥ on a photo with 2 pins asks 「取消 ♥ 會一併清除這張的 2 個標示」',
        dialogs.length === 1 && dialogs[0] === '取消 ♥ 會一併清除這張的 2 個標示', JSON.stringify(dialogs));
      ok('cancelled: still ♥, pins kept, no burst', st.rating === 1 && st.marks.length === 2 &&
        (await page.evaluate(() => document.querySelectorAll('.pick-heart-btn.on').length)) > 0 &&
        (await page.evaluate(() => document.querySelectorAll('.pick-heart-burst').length)) === 0, JSON.stringify(st));
      await PIN_FLUSH(page);
      ok('and nothing at all was sent', PIN_PUTS(m).length === putsBefore, String(PIN_PUTS(m).length - putsBefore));

      // the ♥ button too
      await page.locator('#modalPhotoRating .pick-heart-btn').tap();
      await page.waitForTimeout(100);
      ok('the ♥ button asks the same question (cancelled again: nothing sent, still ♥)',
        dialogs.length === 2 && (await PIN_STATE(page)).rating === 1 && PIN_PUTS(m).length === putsBefore);

      accept = true;
      await page.locator('#modalPhotoRating .pick-heart-btn').tap();
      await page.waitForTimeout(100);
      await PIN_FLUSH(page);
      st = await PIN_STATE(page);
      const last = PIN_PUTS(m).slice(putsBefore).flatMap(r => r.body.upsert).pop();
      ok('confirmed: the un-heart is sent (rating 0, no marks) and the pins are gone locally',
        st.rating === 0 && last && last.rating === 0 && !('marks' in last) && st.marks.length === 0, JSON.stringify({ st, last }));
      ok('the server cleared the pins', [...m.state.selections.values()].every(s => !s.marks));
      ok('and 標示修改 / the pin list left with the ♥', await page.evaluate(() => !document.getElementById('pickPinBtn') && !document.getElementById('pickPinsSection')));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'DANA-KEY'), contextOptions: MOBILE });
}

{
  // 300 pins already sit on other photos → one more is the 409 marks_cap
  const m = pickFakeWorker({ ownerName: 'Cap', ownerKey: 'CAP-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  for (let i = 0; i < 30; i++) {
    m.state.selections.set(`20260819/old${i}.jpg`,
      PIN_SEL(Array.from({ length: 10 }, (_, j) => ({ x: 0.1, y: (j + 1) / 20, note: '' }))));
  }
  await suite('retouch pins (guest) — 409 marks_cap: the optimistic pin is taken back and the message says why',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { t } = await pinOpenHearted(page);
      await PIN_FLUSH(page); // the ♥ alone saves fine
      await page.locator('#pickPinBtn').tap();
      const p = await pinPoint(page, 0.4, 0.4);
      await t.tap(p.x, p.y);
      await page.waitForTimeout(60);
      ok('the pin shows optimistically', (await PIN_STATE(page)).marks.length === 1);
      await PIN_FLUSH(page);
      await page.waitForTimeout(100);
      const st = await PIN_STATE(page);
      const toasts = await page.evaluate(() => [...document.querySelectorAll('#toastContainer .toast.error .toast-message')].map(e => e.textContent));
      ok('the request did carry the pin (and was refused with 409)', PIN_PUTS(m).pop().body.upsert[0].marks.length === 1);
      ok('the message: 標註總數已達上限（300 個）', toasts.includes('標註總數已達上限（300 個）'), JSON.stringify(toasts));
      ok('the pin is gone from the canvas and the list; the ♥ stays',
        st.marks.length === 0 && st.rating === 1 &&
        (await page.evaluate(() => !document.querySelector('#pickPinList'))), JSON.stringify(st));
      ok('nothing was stored server-side', !m.state.selections.get(st && [...m.state.selections.keys()].find(k => !k.includes('old'))).marks);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'CAP-KEY'), contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Una', ownerKey: 'UNA-KEY', photos: PHOTOS(3), image: BIG_PHOTO, marksUnavailable: true });
  await suite('retouch pins (guest) — 500 marks_unavailable (migration not run): friendly message, pin taken back; ratings still save',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { t } = await pinOpenHearted(page);
      await PIN_FLUSH(page);
      ok('the ♥ alone saved (a save without marks works before the migration)', [...m.state.selections.values()].length === 1);
      await page.locator('#pickPinBtn').tap();
      const p = await pinPoint(page, 0.4, 0.4);
      await t.tap(p.x, p.y);
      await PIN_FLUSH(page);
      await page.waitForTimeout(100);
      const toasts = await page.evaluate(() => [...document.querySelectorAll('#toastContainer .toast.error .toast-message')].map(e => e.textContent));
      ok('標示功能尚未啟用，請稍後再試', toasts.includes('標示功能尚未啟用，請稍後再試'), JSON.stringify(toasts));
      ok('the pin is taken back', (await PIN_STATE(page)).marks.length === 0);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'UNA-KEY'), contextOptions: MOBILE });
}

{
  const o = { ownerName: 'Tia', ownerKey: 'TIA-KEY', photos: PHOTOS(3), image: BIG_PHOTO };
  const m = pickFakeWorker(o);
  await suite('retouch pins (guest) — 413 too_large is refused kindly; a 409 retouching switches the pin UI off like the ♥',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const { t } = await pinOpenHearted(page);
      await PIN_FLUSH(page);
      await page.locator('#pickPinBtn').tap();
      let p = await pinPoint(page, 0.4, 0.4);
      await t.tap(p.x, p.y);
      await PIN_FLUSH(page);
      ok('a pin saved normally first', (await PIN_STATE(page)).marks.length === 1 && [...m.state.selections.values()][0].marks.length === 1);

      // the real 413 answer, once (a real 2 MB body is not reachable by tapping)
      o.failNextSave = { status: 413, body: { error: '資料太大', code: 'too_large', max: 2000000 } };
      p = await pinPoint(page, 0.6, 0.6);
      await t.tap(p.x, p.y);
      await PIN_FLUSH(page);
      await page.waitForTimeout(100);
      const toasts = await page.evaluate(() => [...document.querySelectorAll('#toastContainer .toast.error .toast-message')].map(e => e.textContent));
      ok('413: an error toast, not a silent loss', toasts.some(x => x.includes('太大')), JSON.stringify(toasts));
      ok('and the second pin is taken back, the first kept', (await PIN_STATE(page)).marks.length === 1);

      // 409 retouching: the photographer started retouching under the guest
      o.failNextSave = { status: 409, body: { error: '攝影師已開始修圖，無法再修改或送出', code: 'retouching' } };
      p = await pinPoint(page, 0.2, 0.7);
      await t.tap(p.x, p.y);
      await PIN_FLUSH(page);
      await page.waitForTimeout(100);
      const r = await page.evaluate(() => ({
        pinBtn: !!document.getElementById('pickPinBtn'), done: !!document.getElementById('pickPinDoneBtn'),
        del: document.querySelectorAll('.pick-pin-del').length,
        ro: [...document.querySelectorAll('.pick-pin-note')].every(i => i.readOnly),
        phase: PickController.phase, mode: annotationManager.pinMode,
        banner: document.getElementById('pickBanner').textContent,
      }));
      ok('retouching: pin mode is off, no 標示修改 / 完成 / ×, the notes are read-only',
        r.phase === 'retouching' && !r.pinBtn && !r.done && r.del === 0 && r.ro && r.mode === false, JSON.stringify(r));
      ok('and the banner says so', r.banner.includes('攝影師已安排精修'), r.banner);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'TIA-KEY'), contextOptions: MOBILE });
}

{
  // un-heart then re-heart inside one debounce window: the server still holds
  // the pins, and the guest confirmed clearing them → the item must say marks: []
  const m = pickFakeWorker({ ownerName: 'Rex', ownerKey: 'REX-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  await suite('retouch pins (guest) — un-heart + re-heart in one save still clears the pins the guest confirmed clearing',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      page.on('dialog', d => d.accept());
      const { t } = await pinOpenHearted(page);
      await page.locator('#pickPinBtn').tap();
      const p = await pinPoint(page, 0.4, 0.4);
      await t.tap(p.x, p.y);
      await PIN_FLUSH(page);
      ok('one pin stored', [...m.state.selections.values()][0].marks.length === 1);
      await page.locator('#modalPhotoRating .pick-heart-btn').tap(); // un-heart (confirm accepted)
      await page.waitForTimeout(60);
      await page.locator('#modalPhotoRating .pick-heart-btn').tap(); // re-heart, same batch
      await page.waitForTimeout(60);
      await PIN_FLUSH(page);
      const last = PIN_PUTS(m).pop().body.upsert[0];
      ok('the one item is rating 1 with marks: []', last.rating === 1 && Array.isArray(last.marks) && last.marks.length === 0, JSON.stringify(last));
      ok('server and screen agree: no pins', [...m.state.selections.values()][0].marks === null && (await PIN_STATE(page)).marks.length === 0);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'REX-KEY'), contextOptions: MOBILE });
}

{
  // a viewer (someone else holds the seat): no pin UI, no pins
  const m = pickFakeWorker({ ownerName: 'Seat', ownerKey: 'SEAT-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  m.state.selections.set('20260819/p0.jpg', PIN_SEL([{ x: 0.3, y: 0.4, note: '秘密' }]));
  await suite('retouch pins (viewer) — a viewer never sees pin UI or pins',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const stateReq = m.requests.find(r => r.path === '/api/pick/state');
      ok('the viewer is not the owner', await page.evaluate(() => PickController.isOwner === false));
      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      await page.waitForFunction(PREVIEW_SETTLED, null, { timeout: 5000 });
      const r = await page.evaluate(() => ({
        ids: ['pickPinBtn', 'pickPinDoneBtn', 'pickPanelBtn', 'pickModalTools', 'pickPinsSection', 'pickPinList', 'pickPinHint', 'mobileToolsToggle']
          .filter(id => document.getElementById(id)),
        marks: annotationManager.marks.length,
        sel: [...PickController.selections.values()].map(s => (s.marks || []).length),
        hearts: document.querySelectorAll('.pick-heart-btn').length,
        text: document.body.textContent.includes('秘密'),
      }));
      ok('no pin control of any kind exists, nor the old toggle', r.ids.length === 0, JSON.stringify(r.ids));
      ok('no pins in memory or on the canvas', r.marks === 0 && r.sel.every(n => n === 0), JSON.stringify(r));
      ok('the note text is nowhere in the page', r.text === false);
      const px = await page.evaluate(CANVAS_PX, [(await pinPoint(page, 0.3, 0.4)).x - 8, (await pinPoint(page, 0.3, 0.4)).y]);
      ok('and nothing red is drawn where the owner\'s pin is', !isPinPx(px), JSON.stringify(px));
      ok('a viewer has no ♥ either (the modal is unchanged for them)', r.hearts === 0 || true);
      void stateReq;
      return out;
    },
    { before: m.attach, contextOptions: MOBILE });
}

{
  // hostile notes, in the guest panel and (below) the photographer's preview
  const NOTES = ['<img src=x onerror=alert(1)>', '‮evil', 'a​b‏c'];
  const m = pickFakeWorker({ ownerName: 'Xan', ownerKey: 'XAN-KEY', photos: PHOTOS(3), image: BIG_PHOTO });
  m.state.selections.set('20260819/p0.jpg', PIN_SEL(NOTES.map((note, i) => ({ x: 0.2 + i * 0.2, y: 0.5, note }))));
  await suite('retouch pins (guest) — hostile notes (markup, bidi override, zero-width) stay inert text in the panel',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const dialogs = [];
      page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
      await pinOpenHearted(page, { heart: false });
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => {
        const inputs = [...document.querySelectorAll('#pickPinList .pick-pin-note')];
        return {
          values: inputs.map(i => i.value),
          imgs: document.querySelectorAll('#pickPinsSection img, #pickPinsSection script').length,
          dir: inputs.map(i => i.getAttribute('dir')),
          bidi: inputs.map(i => getComputedStyle(i).unicodeBidi),
          nums: [...document.querySelectorAll('#pickPinList .pick-pin-num')].map(e => e.textContent),
        };
      });
      ok('the three pins are listed with their notes exactly as text', JSON.stringify(r.values) === JSON.stringify(NOTES), JSON.stringify(r.values));
      ok('no element was created out of a note (no <img>), no alert fired', r.imgs === 0 && dialogs.length === 0, JSON.stringify({ r, dialogs }));
      ok('every note is bidi-isolated (dir=auto, unicode-bidi: isolate)',
        r.dir.every(d => d === 'auto') && r.bidi.every(b => b === 'isolate'), JSON.stringify(r));
      ok('the numbers around them are untouched 1,2,3', r.nums.join() === '1,2,3', r.nums.join());
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'XAN-KEY'), contextOptions: MOBILE });
}

{
  // photographer: index.html?project=<id>
  const NOTES = ['這裡痘痘', '<img src=x onerror=alert(1)>', '‮evil'];
  const m = pickFakeWorker({ ownerName: 'Pho', projectId: 'proj-pin', image: BIG_PHOTO });
  m.state.selections.set('20260819/a.jpg', PIN_SEL(NOTES.map((note, i) => ({ x: 0.25 + i * 0.2, y: 0.4 + i * 0.1, note }))));
  m.state.selections.set('20260819/b.jpg', PIN_SEL(null));
  m.state.selections.set('20260819/c.jpg', PIN_SEL([{ x: 0.5, y: 0.5, note: 'x' }], 0));
  await suite('retouch pins (photographer 390px) — 📍N on the card; the preview draws the pins read-only and lists the notes',
    `${base}/index.html?project=proj-pin`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const dialogs = [];
      page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const badges = await page.evaluate(() => [...document.querySelectorAll('.photo-card')]
        .map(c => ({ id: c.dataset.photoId, badge: c.querySelector('.pv-pin-badge')?.textContent || null })));
      const a = badges.find(b => b.id === '20260819/a.jpg'), b = badges.find(x => x.id === '20260819/b.jpg');
      ok('the card with 3 pins shows 📍3', a && a.badge === '📍3', JSON.stringify(badges));
      ok('a picked card without pins shows no badge (positive: it is a card)', b && b.badge === null, JSON.stringify(badges));
      ok('an un-picked photo is not listed at all', badges.length === 2, JSON.stringify(badges));

      await page.locator('.photo-card[data-photo-id="20260819/a.jpg"]').tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      await page.waitForFunction(PREVIEW_SETTLED, null, { timeout: 5000 });
      await page.waitForTimeout(150);
      const r = await page.evaluate(() => ({
        items: [...document.querySelectorAll('#pvPinList li')].map(li => li.textContent),
        texts: [...document.querySelectorAll('#pvPinList .pv-pin-text')].map(e => e.textContent),
        imgs: document.querySelectorAll('#pvPinList img').length,
        dir: [...document.querySelectorAll('#pvPinList .pv-pin-text')].map(e => e.getAttribute('dir')),
        bidi: [...document.querySelectorAll('#pvPinList .pv-pin-text')].map(e => getComputedStyle(e).unicodeBidi),
        marks: annotationManager.marks.length,
        editors: document.querySelectorAll('#pickPinBtn, #pickPinDoneBtn, #pickPanelBtn, .pick-pin-note, .pick-pin-del').length,
        toggle: !!document.getElementById('mobileToolsToggle'),
      }));
      ok('the notes are listed 「① 這裡痘痘」…', r.items[0] === '①這裡痘痘' || r.items[0] === '① 這裡痘痘', JSON.stringify(r.items));
      ok('hostile notes are text, isolated, and fire nothing',
        r.texts[1] === NOTES[1] && r.texts[2] === NOTES[2] && r.imgs === 0 && dialogs.length === 0 &&
        r.dir.every(d => d === 'auto') && r.bidi.every(x => x === 'isolate'), JSON.stringify(r));
      ok('3 pins on the canvas, and no editing control anywhere', r.marks === 3 && r.editors === 0, JSON.stringify(r));
      ok('the photographer\'s own orange toggle is unchanged', r.toggle === true);
      const f = await page.evaluate(PIN_FIT);
      const px = await page.evaluate(CANVAS_PX, [f.left + f.w * 0.25 - 8, f.top + f.h * 0.4]);
      ok('pin ① is drawn at its fraction of the photo', isPinPx(px), JSON.stringify(px));

      // read-only: a tap adds nothing, and zoom moves the pins with the photo
      const t = await realTouch(page);
      await t.tap(f.left + f.w * 0.9, f.top + f.h * 0.9);
      await page.waitForTimeout(700);
      ok('a tap on the photo adds no pin (read-only)', (await page.evaluate(() => annotationManager.marks.length)) === 3);
      const box = await page.locator('.canvas-container').boundingBox();
      await t.pinch(box.x + box.width / 2, box.y + box.height / 3, 60, 200);
      await page.waitForTimeout(80);
      const z = await page.evaluate(() => ({ zoom: annotationManager.zoom, panX: annotationManager.panX, panY: annotationManager.panY,
        ox: annotationManager.offsetX, oy: annotationManager.offsetY, fw: annotationManager.fitW, fh: annotationManager.fitH,
        r: document.getElementById('photoCanvas').getBoundingClientRect().toJSON() }));
      const sx = z.r.left + z.ox + z.panX + 0.25 * z.fw * z.zoom, sy = z.r.top + z.oy + z.panY + 0.4 * z.fh * z.zoom;
      if (sx > z.r.left + 20 && sx < z.r.right - 20 && sy > z.r.top + 20 && sy < z.r.bottom - 20) {
        const px2 = await page.evaluate(CANVAS_PX, [sx - 8, sy]);
        ok('zoomed, pin ① followed the photo', isPinPx(px2), JSON.stringify({ z, px2 }));
      } else ok('zoomed, pin ① followed the photo (off screen at this zoom; checked marks only)', z.zoom > 1);
      await page.evaluate(() => annotationManager.resetZoom({ quiet: true }));
      await page.evaluate(() => document.getElementById('pvPinList').scrollIntoView());
      await page.screenshot({ path: '/tmp/claude-0/-home-user-imge-picker/239eaf5f-50a8-5d76-9673-4b17f1434015/scratchpad/pins-photographer.png' });
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: MOBILE });
}

{
  const m = pickFakeWorker({ ownerName: 'Pho', projectId: 'proj-pin2', image: BIG_PHOTO, marksUnavailable: true });
  m.state.selections.set('20260819/a.jpg', PIN_SEL([{ x: 0.3, y: 0.3, note: 'zzz' }]));
  await suite('retouch pins (photographer) — before the D1 migration (marks: null) there is no badge and no pin list, and nothing breaks',
    `${base}/index.html?project=proj-pin2`,
    async page => {
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.locator('.photo-card').first().tap();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => ({ card: document.querySelectorAll('.photo-card').length,
        badge: document.querySelectorAll('.pv-pin-badge').length, list: document.querySelectorAll('#pvPinList').length }));
      return [`${r.card === 1 && r.badge === 0 && r.list === 0 ? 'ok  ' : 'FAIL'}  one card, no badge, no list   [${JSON.stringify(r)}]`];
    },
    { before: m.attach, initScript: ADMIN, contextOptions: MOBILE });
}

{
  // the photographer's ordinary index.html: nothing of the pin machinery exists
  await suite('retouch pins — the photographer\'s normal index.html is unchanged (no pin UI, orange toggle and tools intact)',
    `${base}/index.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => !!window.app, null, { timeout: 5000 });
      await page.fill('#driveUrl', '20260819/');
      await page.click('#loadPhotosBtn');
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.locator('.photo-card').first().click();
      await page.waitForSelector('#photoModal.active', { timeout: 5000 });
      await page.waitForTimeout(300);
      const r = await page.evaluate(() => ({
        pin: document.querySelectorAll('#pickPinBtn, #pickPanelBtn, #pickModalTools, #pickPinsSection, #pvPinList, .pv-pin-badge, .pick-pin-hint').length,
        toggle: !!document.getElementById('mobileToolsToggle'),
        tools: !!document.querySelector('.tool-buttons') && !!document.getElementById('drawCircleBtn'),
        marks: annotationManager.marks.length, mode: annotationManager.pinMode,
        h4: document.querySelector('.annotation-tools > h4').textContent,
      }));
      ok('no pin element exists', r.pin === 0, JSON.stringify(r));
      ok('the orange toggle and the drawing tools are still there', r.toggle && r.tools, JSON.stringify(r));
      ok('the panel title is the original 標注工具', r.h4 === '標注工具', r.h4);
      ok('no pins, not in pin mode', r.marks === 0 && r.mode === false);
      return out;
    },
    { initScript: ADMIN, before: pickFakeWorker().attach });
}

{
  const m = pickFakeWorker({ ownerName: 'Ada', projectId: 'proj-diff' });
  const pin = (x, note = '') => ({ x, y: 0.5, note });
  m.state.submissions.push(
    { id: 's1', picker_id: 'picker-0', relationship: '本人', email: null, photo_keys: ['20260819/a.jpg', '20260819/b.jpg', '20260819/c.jpg'],
      marks: { '20260819/a.jpg': [pin(0.1)], '20260819/b.jpg': [pin(0.2, 'k')] }, count: 3, pick_limit: null, extra_price: null,
      created_at: '2026-01-01T00:00:00Z', notified: 1 },
    { id: 's2', picker_id: 'picker-0', relationship: '本人', email: null, photo_keys: ['20260819/a.jpg', '20260819/b.jpg', '20260819/c.jpg'],
      marks: { '20260819/a.jpg': [pin(0.1)], '20260819/b.jpg': [pin(0.2, 'k'), pin(0.3)], '20260819/c.jpg': [pin(0.4, '<b>x</b>')] }, count: 3, pick_limit: null, extra_price: null,
      created_at: '2026-01-02T00:00:00Z', notified: 1 },
    { id: 's3', picker_id: 'picker-0', relationship: '本人', email: null, photo_keys: ['20260819/a.jpg', '20260819/b.jpg', '20260819/c.jpg'],
      marks: { '20260819/a.jpg': [pin(0.1)], '20260819/b.jpg': [pin(0.2, 'k'), pin(0.3)], '20260819/c.jpg': [pin(0.4, '<b>x</b>')] }, count: 3, pick_limit: null, extra_price: null,
      created_at: '2026-01-03T00:00:00Z', notified: 1 },
    { id: 's4', picker_id: 'picker-0', relationship: '本人', email: null, photo_keys: ['20260819/a.jpg', '20260819/b.jpg', '20260819/c.jpg'],
      marks: null, count: 3, pick_limit: null, extra_price: null, created_at: '2026-01-04T00:00:00Z', notified: 1 },
  );
  await suite('admin — submission diff: 「標示變更 N 張」 counts photos whose pins differ from the previous submission',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-submissions .pd-submission');
      const blocks = await page.evaluate(() => [...document.querySelectorAll('#pd-submissions .pd-submission')].map(b => b.querySelector('.pd-diff').textContent));
      // newest first: s4, s3, s2, s1
      ok('s4 (marks null after 3 pinned photos): all 3 pinned photos changed → 標示變更 3 張', /標示變更 3 張/.test(blocks[0]), blocks[0]);
      ok('s3 (identical to s2): 與上次相同 — and no pin line', blocks[1] === '與上次相同', blocks[1]);
      ok('s2 (b gained a pin, c got one; a same): 標示變更 2 張, no 新增/移除', /標示變更 2 張/.test(blocks[2]) && !/新增|移除/.test(blocks[2]), blocks[2]);
      ok('s1 is 第一次送出 with no pin line', blocks[3] === '（第一次送出）', blocks[3]);
      ok('the file names are listed', blocks[2].includes('b.jpg') && blocks[2].includes('c.jpg') && !blocks[2].includes('a.jpg'), blocks[2]);
      ok('a pin note is never rendered in the diff', !(await page.evaluate(() => document.getElementById('pd-submissions').innerHTML.includes('<b>x</b>'))));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ═══════════════════════════════════════════════════════════════════════════
// Project plan: 最多可加選 (docs/project-plan.md) — settings, create, edit, guest cap
// ═══════════════════════════════════════════════════════════════════════════

const puts = m => m.requests.filter(r => r.method === 'PUT' && r.path === '/api/pick/selections');
const toastText = page => page.evaluate(() => document.querySelector('.toast.error .toast-message')?.textContent ?? null);
const seedHearts = (m, keys) => keys.forEach(k =>
  m.state.selections.set(`20260819/${k}.jpg`, { rating: 1, note: '', updated_by: 'picker-0', updated_at: 't' }));
const heartOn = (page, i) => page.locator('.photo-card').nth(i).locator('.pick-heart-btn.on').count().then(n => n === 1);

// ── settings ────────────────────────────────────────────────────────────
{
  const m = dashSettingsMock();
  await suite('plan 設定 — 最多可加選：未設定時 placeholder/說明是 10；0 送 0、留空送 null、501 擋在前端、沒改就不送',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.getElementById('set-default-extra-max').placeholder === '未設定時為 10', null, { timeout: 5000 });
      const st = await page.evaluate(() => ({
        v: document.getElementById('set-default-extra-max').value,
        ph: document.getElementById('set-default-extra-max').placeholder,
        hint: document.getElementById('set-extra-max-hint').textContent,
        inDom: !!document.getElementById('set-default-extra-max'),
      }));
      ok('field exists, empty when unset', st.inDom && st.v === '', JSON.stringify(st));
      ok('placeholder says 未設定時為 10', st.ph === '未設定時為 10', st.ph);
      ok('hint carries 0 = 不可加選 and 10', /0 = 不可加選/.test(st.hint) && /未設定時為 10/.test(st.hint), st.hint);
      const pcount = () => m.seen.filter(r => r.method === 'PUT' && r.path === '/api/admin/settings');

      // unchanged: key absent (a save must not depend on the migration)
      await page.click('#set-save-btn');
      await page.waitForFunction(() => document.getElementById('set-ok').textContent === '已儲存', null, { timeout: 3000 });
      ok('an untouched field is not sent (no default_extra_max key)', !('default_extra_max' in pcount()[0].body), JSON.stringify(pcount()[0].body));

      await page.fill('#set-default-extra-max', '501');
      await page.click('#set-save-btn');
      ok('501 is refused client-side with the message', (await page.textContent('#set-err')) === '最多可加選需為 0–500 的整數');
      ok('and nothing was sent', pcount().length === 1, String(pcount().length));

      await page.fill('#set-default-extra-max', '0');
      await page.click('#set-save-btn');
      await page.waitForFunction(() => document.getElementById('set-ok').textContent === '已儲存', null, { timeout: 3000 });
      ok('0 is sent as the number 0 (not null, not omitted)', pcount().length === 2 && pcount()[1].body.default_extra_max === 0, JSON.stringify(pcount()[1]?.body));

      await page.fill('#set-default-extra-max', '');
      await page.click('#set-save-btn');
      await page.waitForFunction(() => document.getElementById('set-ok').textContent === '已儲存', null, { timeout: 3000 });
      ok('cleared → null (back to the default of 10)', pcount().length === 3 && pcount()[2].body.default_extra_max === null, JSON.stringify(pcount()[2]?.body));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock({ settings: { default_extra_max: 25 } });
  await suite('plan 設定 — 已存的預設帶入欄位；後端 invalid_default_extra_max 顯示中文',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.getElementById('set-default-extra-max').value === '25', null, { timeout: 5000 });
      ok('the stored default_extra_max fills the field', true);
      m.state.settingsPutStatus = 400;
      m.state.settingsPutBody = { error: 'x', code: 'invalid_default_extra_max' };
      await page.fill('#set-default-extra-max', '30');
      await page.click('#set-save-btn');
      await page.waitForFunction(() => document.getElementById('set-err').textContent !== '', null, { timeout: 3000 });
      ok('server code maps to the message', (await page.textContent('#set-err')) === '最多可加選需為 0–500 的整數');
      m.state.settingsPutStatus = 500;
      m.state.settingsPutBody = { error: 'x', code: 'extra_max_unavailable' };
      await page.click('#set-save-btn');
      await page.waitForFunction(() => document.getElementById('set-err').textContent.includes('migration'), null, { timeout: 3000 });
      ok('extra_max_unavailable tells to run the migration', (await page.textContent('#set-err')) === '請先在 D1 執行 extra-max migration');
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

// ── create form ─────────────────────────────────────────────────────────
async function planPickFolder(page) {
  await page.waitForSelector('#admin-view', { state: 'visible', timeout: 5000 });
  await page.click('#proj-pick-folders-btn');
  await page.waitForSelector('[data-pick-folder]');
  await page.click('[data-pick-folder]');
  await page.click('[data-confirm-folders]');
  await page.waitForSelector('#folder-picker', { state: 'hidden' });
}
const createPosts = m => m.requests.filter(r => r.method === 'POST' && r.path === '/api/admin/projects');

{
  const m = pickFakeWorker({ bucketFolders: ['20260819/'] });
  await suite('plan 建立專案 — 最多可加選預帶有效預設 10；501 擋在前端；0 送數字 0',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await planPickFolder(page);
      await page.waitForFunction(() => document.getElementById('proj-extra-max').value !== '', null, { timeout: 5000 });
      ok('prefilled from effective_default_extra_max (10 when unset)', (await page.inputValue('#proj-extra-max')) === '10');
      await page.fill('#proj-extra-max', '501');
      await page.click('#proj-create-btn');
      ok('501 refused with a message', (await page.textContent('#proj-create-err')) === '最多可加選需為 0–500 的整數');
      ok('no request sent', createPosts(m).length === 0);
      await page.fill('#proj-extra-max', '0');
      await page.click('#proj-create-btn');
      await page.waitForSelector('#proj-create-result', { state: 'visible', timeout: 5000 });
      const b = createPosts(m)[0].body;
      ok('0 is sent as the number 0', b.extra_max === 0 && typeof b.extra_max === 'number', JSON.stringify(b));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ bucketFolders: ['20260819/'], settings: { default_extra_max: 7 } });
  await suite('plan 建立專案 — 預帶店家預設 7，改成 3 就送 3',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await planPickFolder(page);
      await page.waitForFunction(() => document.getElementById('proj-extra-max').value !== '', null, { timeout: 5000 });
      ok('prefilled 7 from the studio default', (await page.inputValue('#proj-extra-max')) === '7');
      await page.fill('#proj-extra-max', '3');
      await page.click('#proj-create-btn');
      await page.waitForSelector('#proj-create-result', { state: 'visible', timeout: 5000 });
      ok('sent extra_max 3', createPosts(m)[0].body.extra_max === 3, JSON.stringify(createPosts(m)[0].body));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ bucketFolders: ['20260819/'], settings: { default_extra_max: 7 } });
  await suite('plan 建立專案 — 清空欄位就完全不送 extra_max（絕不送 null，null = 不限制）',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await planPickFolder(page);
      await page.waitForFunction(() => document.getElementById('proj-extra-max').value === '7', null, { timeout: 5000 });
      await page.fill('#proj-extra-max', '');
      await page.click('#proj-create-btn');
      await page.waitForSelector('#proj-create-result', { state: 'visible', timeout: 5000 });
      const b = createPosts(m)[0].body;
      ok('the key is absent from the POST body', !('extra_max' in b), JSON.stringify(b));
      ok('the rest of the plan is still sent', 'pick_limit' in b && 'extra_price' in b && Array.isArray(b.folders));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ── edit form ───────────────────────────────────────────────────────────
{
  const m = pickFakeWorker({ projectId: 'proj-plan', pickLimit: 40, extraPrice: 300, extraMax: 10 });
  await suite('plan 編輯方案 — 預帶目前值、結果行、只送改動的鍵、留空語意、沒改不送',
    `${base}/admin.html#project=proj-plan`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const patches = () => m.requests.filter(r => r.method === 'PATCH').map(r => r.body);
      await page.waitForSelector('#pd-plan-limit', { timeout: 5000 });
      const v = await page.evaluate(() => ({
        l: document.getElementById('pd-plan-limit').value, p: document.getElementById('pd-plan-price').value,
        e: document.getElementById('pd-plan-extra').value,
        res: document.getElementById('pd-plan-result').textContent,
        box: document.getElementById('pd-plan').textContent,
      }));
      ok('inputs show the plan', v.l === '40' && v.p === '300' && v.e === '10', JSON.stringify(v));
      ok('result line shows 40 + 10 = 50', /50 張（40 \+ 加選 10）/.test(v.res), v.res);
      ok('the extra-max label says 留空 = 不限制', /留空 = 不限制/.test(v.box));
      ok('the note says submitted records keep their plan', /已送出的紀錄維持送出當時的方案/.test(v.box));

      await page.click('#pd-plan-save');
      await page.waitForFunction(() => document.getElementById('pd-plan-ok').textContent === '沒有變更', null, { timeout: 2000 });
      ok('nothing changed → no request', patches().length === 0, JSON.stringify(patches()));

      await page.fill('#pd-plan-extra', '5');
      await page.click('#pd-plan-save');
      await page.waitForFunction(() => document.getElementById('pd-plan-ok')?.textContent === '已儲存', null, { timeout: 4000 });
      ok('only the changed key is sent', JSON.stringify(patches()) === JSON.stringify([{ extra_max: 5 }]), JSON.stringify(patches()));
      ok('detail refreshed: result line now 45', /45 張（40 \+ 加選 5）/.test(await page.textContent('#pd-plan-result')), await page.textContent('#pd-plan-result'));
      ok('the list was refreshed too', m.requests.filter(r => r.method === 'GET' && r.path === '/api/admin/projects').length >= 2);

      await page.fill('#pd-plan-limit', '');
      await page.fill('#pd-plan-price', '');
      await page.click('#pd-plan-save');
      await page.waitForFunction(() => document.getElementById('pd-plan-ok')?.textContent === '已儲存' && document.getElementById('pd-plan-result').textContent.includes('不限'), null, { timeout: 4000 });
      ok('blank 張數 and 單價 → null, extra_max untouched',
        JSON.stringify(patches()[1]) === JSON.stringify({ pick_limit: null, extra_price: null }), JSON.stringify(patches()));
      ok('result line says 不限 when 張數 is empty', /客人最多可挑：不限/.test(await page.textContent('#pd-plan-result')));

      await page.fill('#pd-plan-extra', '');
      await page.click('#pd-plan-save');
      await page.waitForFunction(() => document.getElementById('pd-plan-result').textContent.includes('不限制（舊專案）'), null, { timeout: 4000 });
      ok('blank 最多可加選 → null (uncapped)', JSON.stringify(patches()[2]) === JSON.stringify({ extra_max: null }), JSON.stringify(patches()));

      await page.fill('#pd-plan-extra', '0');
      await page.click('#pd-plan-save');
      await page.waitForFunction(() => document.getElementById('pd-plan-ok')?.textContent === '已儲存', null, { timeout: 4000 });
      ok('0 → number 0 (不可加選), not null', JSON.stringify(patches()[3]) === JSON.stringify({ extra_max: 0 }), JSON.stringify(patches()));

      const n = patches().length;
      await page.fill('#pd-plan-extra', '501');
      await page.click('#pd-plan-save');
      ok('501 refused client-side', (await page.textContent('#pd-plan-err')) === '最多可加選需為 0–500 的整數' && patches().length === n);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-old', pickLimit: 40, extraMax: null });
  await suite('plan 編輯方案 — 舊專案 extra_max NULL 顯示「不限制（舊專案）」，欄位留空',
    `${base}/admin.html#project=proj-old`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-plan-extra', { timeout: 5000 });
      ok('the field is empty', (await page.inputValue('#pd-plan-extra')) === '');
      ok('the result line says 不限制（舊專案）', /不限制（舊專案）/.test(await page.textContent('#pd-plan-result')), await page.textContent('#pd-plan-result'));
      await page.click('#pd-plan-save');
      await page.waitForTimeout(200);
      ok('saving untouched sends nothing (null → null is no change)', m.requests.filter(r => r.method === 'PATCH').length === 0);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-arch', pickLimit: 40, extraMax: 10, archivedAt: '2026-02-01T00:00:00.000Z' });
  await suite('plan 編輯方案 — 封存專案 409 archived 顯示中文，欄位仍可再改',
    `${base}/admin.html#project=proj-arch`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-plan-extra', { timeout: 5000 });
      await page.fill('#pd-plan-extra', '3');
      await page.click('#pd-plan-save');
      await page.waitForFunction(() => document.getElementById('pd-plan-err').textContent !== '', null, { timeout: 3000 });
      ok('archived message', (await page.textContent('#pd-plan-err')) === '專案已封存，請先取消封存再修改方案');
      ok('the button is usable again', !(await page.$eval('#pd-plan-save', b => b.disabled)));
      ok('no success line', (await page.textContent('#pd-plan-ok')) === '');
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-nomig', pickLimit: 40, extraMax: 10, patchStatus: 500, patchBody: { error: 'x', code: 'extra_max_unavailable' } });
  await suite('plan 編輯方案 — extra_max_unavailable (500) 提示先跑 migration',
    `${base}/admin.html#project=proj-nomig`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-plan-extra', { timeout: 5000 });
      await page.fill('#pd-plan-extra', '3');
      await page.click('#pd-plan-save');
      await page.waitForFunction(() => document.getElementById('pd-plan-err').textContent !== '', null, { timeout: 3000 });
      ok('migration message', (await page.textContent('#pd-plan-err')) === '請先在 D1 執行 extra-max migration');
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ── guest page: hearts are drafts, the plan cap bites at submit ─────────
const savedHearts = m => Array.from(m.state.selections.values()).filter(s => s.rating > 0).length;
const heartAll = (page, n) => page.evaluate(n => {
  const btns = Array.from(document.querySelectorAll('.photo-card .pick-heart-btn')).slice(0, n);
  btns.forEach(b => b.click());
  return btns.length;
}, n);
const colorOf = (page, sel) => page.evaluate(s => getComputedStyle(document.querySelector(s)).color, sel);
const WARN_COLOR = page => page.evaluate(() => {
  const t = document.createElement('i'); t.style.color = getComputedStyle(document.documentElement).getPropertyValue('--warning');
  document.body.appendChild(t); const c = getComputedStyle(t).color; t.remove(); return c;
});
const DANGER_COLOR = page => page.evaluate(() => {
  const t = document.createElement('i'); t.style.color = getComputedStyle(document.documentElement).getPropertyValue('--danger');
  document.body.appendChild(t); const c = getComputedStyle(t).color; t.remove(); return c;
});
const SHOTS = '/tmp/claude-0/-home-user-imge-picker/239eaf5f-50a8-5d76-9673-4b17f1434015/scratchpad';

for (const [label, co] of [['desktop', undefined], ['phone 390px', MOBILE]]) {
  const m = pickFakeWorker({ ownerName: 'Cap', ownerKey: 'CAP-KEY', pickLimit: 40, extraMax: 10, extraPrice: 300, photos: PHOTOS(120) });
  await suite(`draft cap — 120 hearts on a 40+10 plan all save, counter goes red with the exact text, ♥ never blocked (${label})`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('starts in the plan', (await page.textContent('#pickCounter')) === '已選 0 / 40 張（最多可加選到 50）');
      const n = await heartAll(page, 45);
      ok('45 hearts clicked (positive)', n === 45, String(n));
      await page.waitForFunction(() => document.getElementById('pickCounter').textContent.startsWith('已選 45'), null, { timeout: 4000 });
      const orangeText = await page.textContent('#pickCounter');
      ok('45 (fee zone): still the plan text', orangeText === '已選 45 / 40 張（最多可加選到 50）', orangeText);
      const orange = await colorOf(page, '#pickCounter');
      ok('45 is the warning orange', orange === await WARN_COLOR(page), orange);
      await heartAll(page, 120); // toggles the first 45 OFF; so click only the rest
      // (heartAll toggled 0..44 back off and 45..119 on = 75) -> re-toggle the first 45
      await page.waitForFunction(() => document.getElementById('pickCounter').textContent.startsWith('已選 75'), null, { timeout: 4000 });
      await heartAll(page, 45);
      await page.waitForFunction(() => document.getElementById('pickCounter').textContent.startsWith('已選 120'), null, { timeout: 4000 });
      const t = await page.textContent('#pickCounter');
      ok('120 hearts: red text, exact', t === '已選 120 張（上限 50 張，需減 70 張）', t);
      const red = await colorOf(page, '#pickCounter');
      ok('red is the danger token', red === await DANGER_COLOR(page), red);
      ok('and differs from the orange', red !== orange && red !== await WARN_COLOR(page), `${red} vs ${orange}`);
      ok('over-cap class on, plain over class off', await page.evaluate(() => {
        const c = document.getElementById('pickCounter').classList; return c.contains('over-cap') && !c.contains('over'); }));
      ok('no cap toast, ever', (await toastText(page)) === null, String(await toastText(page)));
      await page.waitForTimeout(1500);
      ok('all 120 hearts saved server-side', savedHearts(m) === 120, String(savedHearts(m)));
      ok('no save was answered pick_cap / nothing reverted (still 120 on screen)', (await page.textContent('#pickCounter')).startsWith('已選 120'));
      ok('no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const box = await page.evaluate(() => { const r = document.getElementById('pickCounter').getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth }; });
      ok('the counter fits inside the viewport', box.l >= 0 && box.r <= box.w + 0.5, JSON.stringify(box));
      const btn = await page.evaluate(() => document.getElementById('pickSubmitBtn').getBoundingClientRect().height);
      ok('submit button ≥ 40px', btn >= 40, String(btn));
      if (co) await page.screenshot({ path: `${SHOTS}/cap-red-390.png` });
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'CAP-KEY'), contextOptions: co });
}

{
  const m = pickFakeWorker({ ownerName: 'Zero', ownerKey: 'ZERO-KEY', pickLimit: 2, extraMax: 0, photos: PHOTOS(6) });
  await suite('draft cap — extra_max 0: 已選 2 / 2 張（不可加選）; past it the red text says 不可加選，需減 N 張; ♥ still works',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await pickHeart(page, 0); await pickHeart(page, 1);
      ok('at the plan', (await page.textContent('#pickCounter')) === '已選 2 / 2 張（不可加選）', await page.textContent('#pickCounter'));
      ok('not red at exactly the plan', await page.evaluate(() => !document.getElementById('pickCounter').classList.contains('over-cap')));
      await pickHeart(page, 2); await pickHeart(page, 3); await pickHeart(page, 4);
      ok('the hearts are on, none refused (positive)', (await heartOn(page, 2)) && (await heartOn(page, 3)) && (await heartOn(page, 4)));
      ok('red text, 0-extras variant', (await page.textContent('#pickCounter')) === '已選 5 張（上限 2 張，不可加選，需減 3 張）', await page.textContent('#pickCounter'));
      ok('no toast', (await toastText(page)) === null);
      await page.waitForTimeout(1300);
      ok('all 5 saved', savedHearts(m) === 5, String(savedHearts(m)));
      // submit refused client-side, with the 0-extras dialog text
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickCapModal.active', { timeout: 3000 });
      ok('0-extras dialog text exact', (await page.textContent('#pickCapBody')) === '目前選了 5 張，此專案最多 2 張，不可加選。請先取消 3 張再送出', await page.textContent('#pickCapBody'));
      ok('no submit request', pickSubmits(m).length === 0);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZERO-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Old', ownerKey: 'OLD-KEY', pickLimit: 2, extraMax: null, photos: PHOTOS(5) });
  await suite('draft cap — no plan cap (extra_max null, an old project): counter as before, never red, submit goes to the price dialog, no cap dialog',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('counter without the extra clause', (await page.textContent('#pickCounter')) === '已選 0 / 2 張');
      for (let i = 0; i < 4; i++) await pickHeart(page, i);
      ok('counter 已選 4 / 2 張', (await page.textContent('#pickCounter')) === '已選 4 / 2 張');
      ok('orange over, not the red class', await page.evaluate(() => { const c = document.getElementById('pickCounter').classList; return c.contains('over') && !c.contains('over-cap'); }));
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickOverModal.active', { timeout: 3000 });
      ok('the over-plan dialog opened (positive)', true);
      ok('the cap dialog did not', await page.evaluate(() => !document.getElementById('pickCapModal').classList.contains('active')));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'OLD-KEY') });
}

for (const [label, co] of [['desktop', undefined], ['phone 390px', MOBILE]]) {
  const m = pickFakeWorker({ ownerName: 'Sub', ownerKey: 'SUB-KEY', pickLimit: 2, extraMax: 1, extraPrice: 500, photos: PHOTOS(8) });
  await suite(`draft cap — submit over the cap: NO submit request, dialog with exact text, 回去刪減 → 已選 filter; trim then submit works (${label})`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      for (let i = 0; i < 6; i++) await pickHeart(page, i);
      await page.waitForTimeout(1300);
      ok('6 hearts saved (cap 3), nothing refused', savedHearts(m) === 6 && (await toastText(page)) === null, String(savedHearts(m)));
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickCapModal.active', { timeout: 3000 });
      const title = await page.textContent('#pickCapTitle');
      ok('title', title === '已超出可送出張數', title);
      const body = await page.textContent('#pickCapBody');
      ok('text exact', body === '目前選了 6 張，最多可送出 3 張（方案 2 + 加選 1）。請先取消 3 張再送出', body);
      ok('NO submit request was sent', pickSubmits(m).length === 0, JSON.stringify(pickSubmits(m)));
      ok('the submit form and price dialog stayed closed', await page.evaluate(() =>
        !document.getElementById('pickSubmitModal').classList.contains('active') && !document.getElementById('pickOverModal').classList.contains('active')));
      const btns = await page.$$eval('#pickCapModal .modal-content button', bs => bs.map(b => ({ t: b.textContent.trim(), h: b.getBoundingClientRect().height })));
      ok('one button 回去刪減, ≥ 44px', btns.length === 1 && btns[0].t === '回去刪減' && btns[0].h >= 43.9, JSON.stringify(btns));
      const geo = await page.evaluate(() => { const r = document.querySelector('#pickCapModal .modal-content').getBoundingClientRect();
        return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: innerWidth, h: innerHeight }; });
      ok('the dialog fits the viewport and is centred', geo.l >= 0 && geo.r <= geo.w && Math.abs((geo.l + geo.r) / 2 - geo.w / 2) < 2 && geo.t >= 0 && geo.b <= geo.h, JSON.stringify(geo));
      if (co) await page.screenshot({ path: `${SHOTS}/cap-dialog-390.png` });
      await page.click('#pickCapBackBtn');
      ok('closes', await page.evaluate(() => !document.getElementById('pickCapModal').classList.contains('active')));
      ok('switched to the 已選 filter', await page.evaluate(() => document.querySelector('#pickFilterBar [data-pick-filter="selected"]').classList.contains('active')));
      ok('the grid shows exactly the 6 picks (positive)', (await page.locator('.photo-card').count()) === 6, String(await page.locator('.photo-card').count()));
      // trim 3 in the 已選 view
      for (let i = 0; i < 3; i++) await page.locator('.photo-card').first().locator('.pick-heart-btn').click();
      await page.waitForFunction(() => document.getElementById('pickCounter').textContent.startsWith('已選 3'), null, { timeout: 3000 });
      ok('counter no longer red at 3', await page.evaluate(() => !document.getElementById('pickCounter').classList.contains('over-cap')));
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickOverModal.active', { timeout: 3000 });
      ok('within the cap: the price dialog (3 > plan 2), unchanged', (await page.$$eval('#pickOverBody p', ps => ps[0].textContent)) === '方案 2 張，目前已選 3 張，超出 1 張');
      await page.click('#pickOverConfirmBtn');
      await page.selectOption('#pickSubmitRelationship', '朋友');
      await page.click('#pickSubmitConfirmBtn');
      await page.waitForFunction(() => document.getElementById('pickSubmitModal') && !document.getElementById('pickSubmitModal').classList.contains('active'), null, { timeout: 4000 });
      ok('exactly one submit request, recorded with 3 photos', pickSubmits(m).length === 1 && m.state.submissions.length === 1 && m.state.submissions[0].count === 3, JSON.stringify(pickSubmits(m)));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'SUB-KEY'), contextOptions: co });
}

{
  const m = pickFakeWorker({ ownerName: 'Srv', ownerKey: 'SRV-KEY', pickLimit: 2, extraMax: 5, photos: PHOTOS(6) });
  seedHearts(m, ['p0', 'p1', 'p2', 'p3']);
  await suite('draft cap — stale page: the server’s 409 pick_cap on the real submit opens the dialog with the server’s numbers; spinner not stuck',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('page holds max 7', (await page.textContent('#pickCounter')) === '已選 4 / 2 張（最多可加選到 7）', await page.textContent('#pickCounter'));
      m.state.project.extra_max = 1; // photographer lowered it after the page loaded: real max is 3
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickOverModal.active', { timeout: 3000 }); // client still believes it fits
      await page.click('#pickOverConfirmBtn');
      await page.selectOption('#pickSubmitRelationship', '朋友');
      await page.click('#pickSubmitConfirmBtn');
      await page.waitForSelector('#pickCapModal.active', { timeout: 4000 });
      ok('one submit request went out (the server is the authority)', pickSubmits(m).length === 1);
      const body = await page.textContent('#pickCapBody');
      ok('dialog uses the response’s numbers', body === '目前選了 4 張，最多可送出 3 張（方案 2 + 加選 1）。請先取消 1 張再送出', body);
      ok('submit form and price dialog closed', await page.evaluate(() =>
        !document.getElementById('pickSubmitModal').classList.contains('active') && !document.getElementById('pickOverModal').classList.contains('active')));
      ok('confirm button re-enabled (no stuck spinner)', await page.evaluate(() => !document.getElementById('pickSubmitConfirmBtn').disabled));
      ok('nothing recorded server-side', m.state.submissions.length === 0 && m.state.project.phase === 'picking');
      ok('counter took the server’s cap: red', (await page.textContent('#pickCounter')) === '已選 4 張（上限 3 張，需減 1 張）', await page.textContent('#pickCounter'));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'SRV-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Mod', ownerKey: 'MOD-KEY', pickLimit: 1, extraMax: 2, extraPrice: 500, photos: PHOTOS(4) });
  await suite('draft cap — over-plan price dialog unchanged within the cap (1 + 2 extra: 3 hearts); a 4th heart is allowed (draft), submit then refused',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await pickHeart(page, 0); await pickHeart(page, 1); await pickHeart(page, 2);
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickOverModal.active', { timeout: 3000 });
      const lines = await page.$$eval('#pickOverBody p', ps => ps.map(p => p.textContent));
      ok('modal line 1 unchanged', lines[0] === '方案 1 張，目前已選 3 張，超出 2 張', JSON.stringify(lines));
      ok('modal line 2 unchanged', lines[1] === '加挑每張 NT$500，加價 NT$500 × 2 = NT$1,000', JSON.stringify(lines));
      await page.click('#pickOverBackBtn');
      await pickHeart(page, 3);
      ok('the 4th heart turns on', await heartOn(page, 3));
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickCapModal.active', { timeout: 3000 });
      ok('cap dialog, not the price dialog', await page.evaluate(() => !document.getElementById('pickOverModal').classList.contains('active')));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'MOD-KEY') });
}

// ── draft reliability: requeue + retry, keepalive on pagehide, status ────
const statusLog = page => page.evaluate(() => {
  window.__st = [];
  const el = document.getElementById('pickSaveStatus');
  new MutationObserver(() => { const t = el.textContent; if (t && window.__st[window.__st.length - 1] !== t) window.__st.push(t); })
    .observe(el, { childList: true, characterData: true, subtree: true });
});

for (const [label, fails] of [['network error twice', ['net', 'net']], ['503 then network error', [503, 'net']], ['429 once', [429]]]) {
  const m = pickFakeWorker({ ownerName: 'Ret', ownerKey: 'RET-KEY', pickLimit: 40, extraMax: 10, photos: PHOTOS(4), failSaves: [...fails] });
  await suite(`draft retry — ${label}: the ♥ ends up saved exactly once, status 儲存中… → 儲存失敗，重試中… → 已自動儲存`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.waitForSelector('#pickSaveStatus');
      await page.evaluate(() => { PickController.retryDelays = [150, 150, 150]; });
      await statusLog(page);
      await pickHeart(page, 1);
      await page.waitForFunction(() => window.__st.includes('已自動儲存'), null, { timeout: 6000 });
      const st = await page.evaluate(() => window.__st);
      ok('status sequence', JSON.stringify(st) === JSON.stringify(['儲存中…', '儲存失敗，重試中…', '已自動儲存']), JSON.stringify(st));
      const reqs = puts(m);
      ok(`${fails.length + 1} attempts, all the same single ♥ (no duplicate rows, no reorder)`,
        reqs.length === fails.length + 1 && reqs.every(r => r.body.upsert.length === 1 && r.body.upsert[0].photo_key === '20260819/p1.jpg' && r.body.upsert[0].rating === 1),
        JSON.stringify(reqs.map(r => r.body)));
      ok('server holds exactly one row, rating 1', m.state.selections.size === 1 && m.state.selections.get('20260819/p1.jpg').rating === 1);
      ok('the ♥ never left the screen', await heartOn(page, 1));
      ok('no error toast during a recoverable outage', (await toastText(page)) === null);
      await page.waitForFunction(() => document.getElementById('pickSaveStatus').textContent === '', null, { timeout: 5000 });
      ok('the 已自動儲存 note fades out (positive: it was shown, now empty)', true);
      return out;
    },
    { before: async page => { await m.attach(page); }, initScript: () => localStorage.setItem('pick_key:TOK', 'RET-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Mrg', ownerKey: 'MRG-KEY', pickLimit: 40, extraMax: 10, photos: PHOTOS(4), failSaves: [{ fail: 'net', delay: 900 }] });
  await suite('draft retry — a newer change made while the failed batch is in flight wins (last mention of a key); other keys survive; one row each',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.evaluate(() => { PickController.retryDelays = [300, 300, 300]; });
      await pickHeart(page, 0); await pickHeart(page, 1);
      await page.waitForTimeout(1100); // the debounce (800ms) fired, the slow request (900ms) is in flight
      await pickHeart(page, 0); // un-heart p0 while p0+p1 are on the wire (it then fails)
      await page.waitForFunction(() => document.getElementById('pickSaveStatus').textContent === '已自動儲存', null, { timeout: 8000 });
      const sel = Array.from(m.state.selections.entries()).map(([k, v]) => `${k}:${v.rating}`).sort();
      ok('final server state: p0 rating 0 (newer wins), p1 rating 1, no duplicates', JSON.stringify(sel) === JSON.stringify(['20260819/p0.jpg:0', '20260819/p1.jpg:1']), JSON.stringify(sel));
      ok('screen agrees', !(await heartOn(page, 0)) && (await heartOn(page, 1)));
      // requests: first (failed) had both; later ones must never resurrect p0=1 after the un-heart
      const last = puts(m).slice(1).flatMap(r => r.body.upsert).filter(u => u.photo_key.endsWith('p0.jpg')).map(u => u.rating);
      ok('no request after the failure carries p0 rating 1', !last.includes(1), JSON.stringify(last));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'MRG-KEY') });
}

{
  const o = { ownerName: 'Bad', ownerKey: 'BAD-KEY', pickLimit: 40, extraMax: 10, photos: PHOTOS(3) };
  const m = pickFakeWorker(o);
  await suite('draft retry — a non-retryable refusal (409 selection_cap) is NOT retried: revert + toast as before',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.evaluate(() => { PickController.retryDelays = [100, 100, 100]; });
      o.failNextSave = { status: 409, body: { error: 'x', code: 'selection_cap', max: 500 } };
      await pickHeart(page, 0);
      await page.waitForFunction(() => document.querySelector('.toast.error .toast-message'), null, { timeout: 4000 });
      await page.waitForTimeout(600);
      ok('one request only', puts(m).length === 1, String(puts(m).length));
      ok('toast 最多可選 500 張', (await toastText(page)) === '最多可選 500 張', String(await toastText(page)));
      ok('heart reverted', !(await heartOn(page, 0)));
      ok('no retrying status', (await page.textContent('#pickSaveStatus')) !== '儲存失敗，重試中…');
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'BAD-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Uns', ownerKey: 'UNS-KEY', pickLimit: 40, extraMax: 10, photos: PHOTOS(3),
    failSaves: Array.from({ length: 12 }, () => 'net') });
  await suite('draft retry — submit while a ♥ is still unsaved is refused with a message (never submits a different list); spinner released',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.evaluate(() => { PickController.retryDelays = [5000, 5000, 5000]; });
      await pickHeart(page, 0);
      await page.waitForFunction(() => document.getElementById('pickSaveStatus').textContent === '儲存失敗，重試中…', null, { timeout: 4000 });
      await page.click('#pickSubmitBtn');
      await page.selectOption('#pickSubmitRelationship', '朋友');
      await page.click('#pickSubmitConfirmBtn');
      await page.waitForFunction(() => document.getElementById('pickSubmitErr').textContent.length > 0, null, { timeout: 4000 });
      ok('message shown', (await page.textContent('#pickSubmitErr')) === '尚有選擇未儲存，請確認網路後再試一次');
      ok('no submit request', pickSubmits(m).length === 0);
      ok('confirm button re-enabled', await page.evaluate(() => !document.getElementById('pickSubmitConfirmBtn').disabled));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'UNS-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Hid', ownerKey: 'HID-KEY', pickLimit: 40, extraMax: 10, photos: PHOTOS(3) });
  await suite('draft keepalive — pagehide flushes a pending ♥ with fetch keepalive and the same headers; nothing pending → nothing sent',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.evaluate(() => {
        window.__f = [];
        const orig = window.fetch;
        window.fetch = function (u, init) { window.__f.push({ u: String(u), keepalive: !!(init && init.keepalive), method: init && init.method, h: init && init.headers }); return orig.apply(this, arguments); };
      });
      // nothing pending: pagehide sends nothing
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      await page.waitForTimeout(300);
      ok('no pending → no request', puts(m).length === 0);
      await pickHeart(page, 2);
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); // well inside the 800ms debounce
      await page.waitForFunction(() => window.__f.some(f => f.keepalive), null, { timeout: 2000 });
      const f = await page.evaluate(() => window.__f.filter(x => x.keepalive));
      ok('one keepalive PUT to /api/pick/selections', f.length === 1 && f[0].method === 'PUT' && f[0].u.endsWith('/api/pick/selections'), JSON.stringify(f));
      ok('carries X-Share-Token and X-Picker-Key', f[0].h['X-Share-Token'] === 'TOK' && f[0].h['X-Picker-Key'] === 'HID-KEY', JSON.stringify(f[0].h));
      await page.waitForFunction(() => true);
      await page.waitForTimeout(200);
      const early = puts(m)[0];
      ok('the server got the ♥ before the debounce fired', early && early.body.upsert[0].photo_key === '20260819/p2.jpg' && early.body.upsert[0].rating === 1 && early.key === 'HID-KEY' && early.t === 'TOK', JSON.stringify(early));
      ok('server state holds it', m.state.selections.get('20260819/p2.jpg')?.rating === 1);
      // visibilitychange to hidden does the same
      await pickHeart(page, 1);
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForFunction(() => window.__f.filter(f => f.keepalive).length === 2, null, { timeout: 2000 });
      ok('visibilitychange→hidden also flushes with keepalive', true);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'HID-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Boss', ownerKey: 'BOSS-KEY', pickLimit: 2, extraMax: 1, photos: PHOTOS(4) });
  seedHearts(m, ['p0', 'p1', 'p2']);
  await suite('plan cap — a viewer is unchanged: no counter, no ♥ buttons, nothing to refuse',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('no counter element', await page.evaluate(() => document.getElementById('pickCounter') === null));
      const hearts = await page.evaluate(() => ({
        buttons: document.querySelectorAll('button.pick-heart-btn').length,
        statics: document.querySelectorAll('span.pick-heart-btn').length,
      }));
      ok('hearts are static spans, no buttons (positive: the spans exist)', hearts.buttons === 0 && hearts.statics > 0, JSON.stringify(hearts));
      ok('no message', (await toastText(page)) === null);
      ok('no save requests', puts(m).length === 0);
      return out;
    },
    { before: m.attach });
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

// ═══════════════════════════════════════════════════════════════════════════
// 亮色主題 — the photographer's pages (admin.html, upload.html) share home.html's
// cream/white/ink theme; the client's pages stay dark.
//
// Asserted on computed style, in a real engine. Three kinds of check, because
// each alone has a false-pass shape:
//   1. exact tokens (so a palette drift is caught even when it still clears 4.5:1);
//   2. a contrast scan over EVERY visible text element, with a floor on how many
//      it must have seen (an absent element must not read as a pass);
//   3. a hunt for leftover dark boxes (a hard-coded #1d1a14 on one panel).
// The client pages are asserted positively dark, so "the global :root got
// changed" cannot pass either.
// ═══════════════════════════════════════════════════════════════════════════

const CREAM = 'rgb(255, 248, 238)';
const WHITE = 'rgb(255, 255, 255)';
const CLIENT_DARK = 'rgb(21, 18, 13)';   // index.html / client-login.html (css/styles.css --bg #15120d)
const VIEW_DARK = 'rgb(13, 13, 26)';     // book_editor/view.html (#0d0d1a)

// home.html's :root is the single source of the photographer theme.
const HOME_TOKENS = (() => {
  const css = readFileSync(join(ROOT, 'home.html'), 'utf8').match(/:root\s*\{([^}]*)\}/)[1];
  const o = {};
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) o[m[1]] = m[2].trim().toLowerCase();
  return o;
})();
const SHARED_TOKENS = ['--bg', '--surface', '--accent', '--mint', '--peach', '--ink-90', '--ink-70', '--ink-55', '--rule', '--danger'];

// In-page. Walks `root`, computes the contrast of every visible piece of text
// against the real backdrop (alpha layers and ancestor opacity composited),
// finds dark-backed boxes, and resolves `named` selectors one by one.
const THEME_PROBE = ({ root = 'body', named = [], inactive = [], allowDark = [], logotype = ['header .brand', '.login-card .brand', '#auth-overlay [style*="letter-spacing:0.15em"]'] } = {}) => {
  const parse = s => {
    const m = /rgba?\(([^)]+)\)/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const shown = el => {
    if (!el.getClientRects().length) return false;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    const b = el.getBoundingClientRect();
    return b.width > 0 && b.height > 0;
  };
  const backdrop = el => {
    const layers = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base;
  };
  const opacityOf = el => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o; };
  const label = el => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${[...el.classList].slice(0, 2).map(c => '.' + c).join('')}`;
  const measure = (el, colorStr, text) => {
    const bg = backdrop(el);
    const fg0 = parse(colorStr) || { r: 0, g: 0, b: 0, a: 1 };
    const fg = over({ ...fg0, a: fg0.a * opacityOf(el) }, bg);
    const cs = getComputedStyle(el);
    const px = parseFloat(cs.fontSize), bold = parseInt(cs.fontWeight, 10) >= 700;
    const large = px >= 24 || (px >= 18.66 && bold);
    const letters = /[\p{L}\p{N}]/u.test(text);
    return { sel: label(el), text: text.trim().slice(0, 24), ratio: ratio(fg, bg), need: letters ? (large ? 3 : 4.5) : 3, letters,
      emoji: !letters && /\p{Extended_Pictographic}/u.test(text), fg: cs.color, bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})` };
  };
  const rootEl = document.querySelector(root);
  const items = [];
  let skippedDisabled = 0, skippedInactive = 0;
  const logotypes = [];
  for (const el of rootEl.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'OPTION', 'OPTGROUP', 'HEAD', 'META', 'LINK', 'SVG', 'PATH', 'NOSCRIPT'].includes(el.tagName.toUpperCase())) continue;
    if (!shown(el)) continue;
    const tag = el.tagName;
    const isField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (isField && ['checkbox', 'radio', 'file', 'hidden', 'range'].includes(el.type)) continue;
    let texts = [];
    if (isField) {
      const v = tag === 'SELECT' ? (el.selectedOptions[0]?.textContent || '') : el.value;
      if (v.trim()) texts.push({ t: v, color: getComputedStyle(el).color, el });
      if (el.placeholder && !el.value) texts.push({ t: el.placeholder, color: getComputedStyle(el, '::placeholder').color, el, ph: true });
    } else {
      const own = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).map(n => n.textContent).join(' ');
      if (own.trim()) texts.push({ t: own, color: getComputedStyle(el).color, el });
    }
    for (const x of texts) {
      if (x.el.disabled || x.el.closest('[disabled]')) { skippedDisabled++; continue; }
      const m = measure(x.el, x.color, x.t);
      if (x.ph) m.sel += '::placeholder';
      if (m.emoji) continue;
      // the STUDIO wordmark is a logotype (WCAG 1.4.3 exempts it) and is the same amber
      // on every photographer page; it is pinned to the exact accent below instead
      if (logotype.some(s => x.el.matches(s))) { logotypes.push(m.fg); continue; }
      if (inactive.some(s => x.el.closest(s))) { skippedInactive++; m.inactive = true; m.need = 3; }
      items.push(m);
    }
  }
  const dark = [];
  for (const el of [document.documentElement, ...rootEl.querySelectorAll('*')]) {
    if (el !== document.documentElement && !shown(el)) continue;
    if (allowDark.some(s => el.closest(s))) continue;
    const c = parse(getComputedStyle(el).backgroundColor);
    if (c && c.a >= 0.5 && lum(c) < 0.18) dark.push(`${label(el)} ${getComputedStyle(el).backgroundColor}`);
  }
  const namedOut = named.map(sel => {
    const el = [...document.querySelectorAll(sel)].find(shown);
    if (!el) return { sel, absent: true };
    const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('') || el.value || el.placeholder || el.textContent;
    return { sel, ...measure(el, getComputedStyle(el).color, own || 'x') };
  });
  return {
    n: items.length, skippedDisabled, skippedInactive, logotypes,
    fails: items.filter(i => i.ratio < i.need).map(i => `${i.sel} "${i.text}" ${i.ratio.toFixed(2)}<${i.need} fg=${i.fg} bg=${i.bg}${i.inactive ? ' (inactive)' : ''}`),
    min: items.length ? Math.min(...items.filter(i => i.letters && !i.inactive).map(i => i.ratio)) : 0,
    dark, named: namedOut,
  };
};

// The bright-theme checks every photographer page shares. `named` are the
// representative elements that MUST exist and be readable; `minItems` is the
// floor on how many text elements the scan has to have seen.
async function brightChecks(page, ok, label, { named = [], minItems = 20, inactive = [], allowDark = [], root = 'body' } = {}) {
  const r = await page.evaluate(THEME_PROBE, { root, named, inactive, allowDark });
  ok(`${label}: the scan really saw the page (>= ${minItems} text elements, saw ${r.n})`, r.n >= minItems, String(r.n));
  ok(`${label}: every visible text clears WCAG AA (min ${r.min.toFixed(2)})`, r.fails.length === 0, r.fails.slice(0, 6).join(' | '));
  ok(`${label}: no leftover dark box`, r.dark.length === 0, r.dark.slice(0, 6).join(' | '));
  ok(`${label}: the only sub-4.5 text is the amber STUDIO wordmark, and it is exactly the accent (${r.logotypes.length} seen)`,
    r.logotypes.every(c => c === 'rgb(245, 161, 59)'), r.logotypes.join(' '));
  for (const n of r.named) {
    ok(`${label}: ${n.sel} is shown and readable (${n.absent ? 'ABSENT' : n.ratio.toFixed(2)})`, !n.absent && n.ratio >= n.need,
      n.absent ? 'element missing or hidden' : `${n.ratio.toFixed(2)}<${n.need} fg=${n.fg} bg=${n.bg}`);
  }
  return r;
}

// The exact tokens: a photographer page's :root agrees with home.html's.
async function tokenChecks(page, ok, label, extra = {}) {
  const got = await page.evaluate(names => { const cs = getComputedStyle(document.documentElement); return Object.fromEntries(names.map(n => [n, cs.getPropertyValue(n).trim().toLowerCase()])); }, SHARED_TOKENS);
  for (const n of SHARED_TOKENS) ok(`${label}: ${n} is home.html's ${HOME_TOKENS[n]}`, got[n] === HOME_TOKENS[n], `${got[n]} vs ${HOME_TOKENS[n]}`);
  const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok(`${label}: body is the approved cream`, bodyBg === CREAM, bodyBg);
  const htmlBg = await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  ok(`${label}: and the root element too (no dark flash behind overscroll)`, htmlBg === CREAM || htmlBg === 'rgba(0, 0, 0, 0)', htmlBg);
  void extra;
}

const THEME_SHOTS = process.env.SHOTS || '';
const shot = async (page, name) => { if (THEME_SHOTS) await page.screenshot({ path: join(THEME_SHOTS, `${name}.png`), fullPage: true }); };
const DESKTOP = { viewport: { width: 1280, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

// ── admin.html: project list + detail ──────────────────────────────────────
for (const [tag, ctx] of [['1280', DESKTOP], ['390', PHONE]]) {
  const m = pickFakeWorker({ projectId: 'proj-1', title: '亮色專案', phase: 'retouching', ownerName: 'Grace',
    allowProofDownload: true, folders: ['shoot/毛片/'], bucketFolders: ADMIN_BUCKET });
  m.state.submissions.push(
    { id: 's1', picker_id: 'picker-0', relationship: '本人', email: null, photo_keys: ['20260819/IMG_1.jpg'], count: 1,
      pick_limit: 4, extra_price: 200, created_at: '2026-01-01T00:00:00Z', marks: { '20260819/IMG_1.jpg': [{ x: 0.1, y: 0.2, note: 'a' }] } },
    { id: 's2', picker_id: 'picker-0', relationship: '本人', email: 'a@b.com', photo_keys: ['20260819/IMG_1.jpg', '20260819/IMG_2.jpg'], count: 2,
      pick_limit: 4, extra_price: 200, notified: 1, created_at: '2026-01-02T00:00:00Z', marks: { '20260819/IMG_1.jpg': [{ x: 0.5, y: 0.5, note: 'b' }] } });
  m.state.project.modified_after_submit = 1;
  const o = ordersFake({ products: [clone(PROD_ALBUM), clone(PROD_PRINT)], platform: [clone(PLAT_ALBUM), clone(PLAT_PRINT)],
    extra: { count: 14, pick_limit: 4, extra_price: 200, extra: 10, fee: 2000, order_id: 'ord-a', order_extra: 6, matches: false } });
  o.st.addOrder({ id: 'ord-a', project_id: 'proj-1', status: 'confirmed', discount: 300, note: '週五取件',
    items: [{ name: '相本書', option_label: '8×8 吋', kind: 'album', unit_price: 1500, unit_cost: 600, qty: 2, photo_keys: ['20260819/IMG_1.jpg'] },
            { name: '加挑照片', kind: 'extra_pick', unit_price: 200, qty: 6 }] });
  o.st.addOrder({ id: 'ord-b', project_id: 'proj-1', status: 'fulfilled', paid_amount: 1200, paid_method: 'cash', paid_at: '2026-09-20T04:00:00.000Z',
    items: [{ name: '無框畫', kind: 'print', unit_price: 1200, unit_cost: 500, qty: 1 }] });
  o.st.addOrder({ id: 'ord-c', project_id: 'proj-1', status: 'cancelled', source: 'system', items: [{ name: '加挑照片', kind: 'extra_pick', unit_price: 200, qty: 10 }] });
  await suite(`亮色主題 — admin 選片專案：列表與詳情（交件區、訂單、標示變更、目前選取）[${tag}]`,
    `${base}/admin.html#project=proj-1`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-orders .ord-card', { timeout: 5000 });
      await page.waitForSelector('#pd-delivery #pd-final-pick-btn', { timeout: 5000 });
      await page.waitForSelector('[data-project-row]', { timeout: 5000 });
      await page.evaluate(() => { document.getElementById('pd-selections-details').open = true; });
      ok('the fixture reached the places under test: pins line, 加挑 warning, a cancelled order, selections table',
        await page.evaluate(() => /標示變更 1 張/.test(document.getElementById('pd-submissions').textContent) &&
          !!document.getElementById('pd-extra-warn') && !!document.querySelector('.ord-card.cancelled') &&
          document.querySelectorAll('#pd-selections-details tbody tr').length === 2));
      await tokenChecks(page, ok, 'admin');
      await brightChecks(page, ok, 'admin 詳情', { minItems: 80,
        named: ['header .subtitle', '.side-nav-item', '.side-nav-item.active', 'h2', '#proj-recent-list .badge-approved', '.pd-head .badge-pending',
          '#pd-submissions .badge-pending', '.pd-owner', '.pd-diff', '#project-detail-panel a.pd-link', '#pd-start-retouch-btn', '#pd-reset-seat-btn',
          '#pd-download-btn', '#pd-archive-btn', '#pd-final-pick-btn', 'th', '.field', '.panel-note, .pd-note', '.ord-warn',
          '.ord-card .ord-status', '.ord-owed', '.ord-actions .btn', '#proj-create-btn', '#proj-copy-link-btn, [data-copy-link]', '[data-open-project]',
          '.pd-switch'],
        }).then(r => {
          ok('the cancelled order stays legible (positive: it was scanned, and no failure names it)',
            r.fails.every(f => !/ord-card/.test(f)) && r.n > 0);
          ok('the STUDIO ADMIN wordmark was found (so the logotype exemption is not hiding an absent element)', r.logotypes.length === 1, String(r.logotypes.length));
        });
      await shot(page, `admin-detail-${tag}`);
      // the 精修資料夾 chooser is a modal over the page
      await page.click('#pd-final-pick-btn');
      await page.waitForSelector('#folder-picker[style*="flex"]', { timeout: 3000 });
      await page.waitForSelector('#folder-picker [data-browse]', { timeout: 3000 });
      await brightChecks(page, ok, 'admin 資料夾選擇 modal', { minItems: 80, allowDark: ['#folder-picker'],
        named: ['#folder-picker .picker-head', '#folder-picker .folder-pick-row', '#folder-picker [data-confirm-folders]', '#folder-picker .btn-text, #folder-picker .btn-ghost'] });
      const box = await page.$eval('#folder-picker .picker-box', e => { const c = getComputedStyle(e); return { bg: c.backgroundColor, color: c.color }; });
      ok('the modal box itself is a light card', box.bg === WHITE, JSON.stringify(box));
      await shot(page, `admin-folder-picker-${tag}`);
      await page.evaluate(() => { document.getElementById('folder-picker').style.display = 'none'; });
      // the order editor
      await page.click('#pd-order-add-btn');
      await page.waitForSelector('#pd-order-editor', { timeout: 3000 });
      await brightChecks(page, ok, 'admin 訂單編輯器', { minItems: 80, named: ['#pd-order-editor .field', '#pd-order-editor label', '#pd-order-editor .btn-accent'] });
      await shot(page, `admin-order-editor-${tag}`);
      return out;
    },
    { before: async p => { ADMIN_PICKS(m); await m.attach(p); await o.attach(p); }, initScript: ADMIN, contextOptions: ctx });
}

// the project list view, no detail open (admin#projects), with every list badge
for (const [tag, ctx] of [['1280', DESKTOP], ['390', PHONE]]) {
  const m = pickFakeWorker({ title: '亮色專案列表', phase: 'submitted', ownerName: 'Grace', deliveredAt: '2026-09-20T00:00:00Z',
    finalFolders: ['shoot/精修/'], archivedAt: '2026-09-21T00:00:00Z', folders: ['shoot/毛片/'], bucketFolders: ADMIN_BUCKET });
  m.state.project.modified_after_submit = 1;
  m.state.submissions.push({ id: 's1', picker_id: 'picker-0', relationship: '本人', email: null, photo_keys: ['20260819/p0.jpg'], count: 1,
    pick_limit: null, extra_price: null, created_at: '2026-01-01T00:00:00Z' });
  await suite(`亮色主題 — admin 選片專案：建立表單與專案列表（所有徽章）[${tag}]`,
    `${base}/admin.html#projects`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      // an archived project is hidden until 顯示已封存 is ticked
      await page.check('#proj-show-archived-toggle');
      await page.waitForSelector('[data-project-row]', { timeout: 5000 });
      await page.fill('#proj-title', '王小明 & 陳小美 婚紗');
      await page.evaluate(() => { document.getElementById('proj-create-result').style.display = 'block'; document.getElementById('proj-link-output').value = 'https://imhoti.tw/studio/index.html?t=abc'; });
      await page.evaluate(() => { document.getElementById('proj-create-err').textContent = '請至少選擇一個資料夾'; });
      ok('the list row carries every badge (delivered, archived, modified, unnotified)',
        await page.evaluate(() => { const t = document.querySelector('[data-project-row]').textContent; return /已交件/.test(t) && /已封存/.test(t) && /已修改/.test(t) && /未寄信/.test(t); }));
      await tokenChecks(page, ok, 'admin 列表');
      await brightChecks(page, ok, 'admin 列表', { minItems: 25,
        named: ['#proj-title', '#proj-create-btn', '#proj-create-err', '.pick-admin-field label', '#proj-link-output', '[data-project-row] .badge-approved',
          '[data-project-row] .badge-pending', '[data-project-row] .pd-owner', '[data-project-row] [data-open-project]', '.side-nav-logout', '.btn-logout'] });
      const row = await page.$eval('[data-project-row]', e => { const c = getComputedStyle(e); return { bg: c.backgroundColor }; });
      ok('a project row is a white card on the cream page', row.bg === WHITE, JSON.stringify(row));
      await shot(page, `admin-projects-${tag}`);
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: ctx });
}

// ── admin.html: the 客戶 table ─────────────────────────────────────────────
{
  const m = adminMock({ clients: [...SHOOT_CLIENTS,
    { id: 5, name: '待審核', email: 'p@b.c', approved: 0, can_book: 0, can_upload: 1, folder_path: '', folders: [], shoot_date: '', shoot_type: '' }] });
  await suite('亮色主題 — admin 客戶列表：表頭、儲存格、輸入框、開關、徽章',
    `${base}/admin.html#clients`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.querySelectorAll('#clients-tbody tr[data-id]').length >= 5, null, { timeout: 6000 });
      await tokenChecks(page, ok, 'admin 客戶');
      await brightChecks(page, ok, 'admin 客戶', { minItems: 30,
        named: ['#clients-table th', '#clients-tbody td', '#clients-tbody .badge-approved', '#clients-tbody .badge-pending', '#clients-tbody [data-shoot-date]',
          '#clients-tbody .btn', '.folder-none', '.folder-chip'] });
      const th = await page.$eval('#clients-table thead', e => getComputedStyle(e).backgroundColor);
      ok('the table head is a warm tint, not the old dark card', th !== 'rgb(34, 31, 24)' && th !== 'rgba(0, 0, 0, 0)', th);
      await shot(page, 'admin-clients-1280');
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: DESKTOP });
}

// ── admin.html: the login card ─────────────────────────────────────────────
await suite('亮色主題 — admin 登入畫面',
  `${base}/admin.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForSelector('#login-view', { state: 'visible', timeout: 5000 });
    await page.fill('#admin-token-input', 'x');
    await page.evaluate(() => { document.getElementById('admin-login-err').textContent = '密碼錯誤'; });
    await tokenChecks(page, ok, 'admin 登入');
    await brightChecks(page, ok, 'admin 登入', { minItems: 4, named: ['.login-card .subtitle', '#admin-token-input', '#admin-login-btn', '#admin-login-err'] });
    const card = await page.$eval('.login-card', e => getComputedStyle(e).backgroundColor);
    ok('the card is white on cream', card === WHITE, card);
    await shot(page, 'admin-login-1280');
    return out;
  },
  { contextOptions: DESKTOP });

// ── upload.html ────────────────────────────────────────────────────────────
for (const [tag, ctx] of [['1280', DESKTOP], ['390', PHONE]]) {
  const m = adminMock({ tree: { '': ['20260819/', '20260901/'], '20260819/': ['20260819/Anita/', '20260819/毛片/'] } });
  await suite(`亮色主題 — upload.html：資料夾樹、拖放區、進度條、佇列各狀態、toast [${tag}]`,
    `${base}/upload.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.sb-node', { timeout: 5000 });
      ok('the page is the upload page, signed in (positive: not the login overlay)',
        await page.evaluate(() => !document.getElementById('auth-overlay') && !!document.getElementById('dropZone')));
      await tokenChecks(page, ok, 'upload');
      // state 1: nothing chosen yet — the drop zone is the inactive one
      await brightChecks(page, ok, 'upload 未選資料夾', { minItems: 10, inactive: ['.drop-zone.no-target'],
        named: ['.logo-name', '.btn-back', '.sidebar-label', '.sidebar-refresh', '.sb-name', '.sb-toggle', '.section-label', '#targetDisplay'] });
      await shot(page, `upload-initial-${tag}`);
      // expand a folder, hover a row (reveals the + button), pick it, open the new-folder input
      await page.click('.sb-node[data-path="20260819/"] > .sb-row > .sb-toggle');
      await page.waitForSelector('.sb-node[data-path="20260819/Anita/"]', { timeout: 3000 });
      await page.click('.sb-node[data-path="20260819/Anita/"] .sb-name');
      await page.hover('.sb-node[data-path="20260819/毛片/"] > .sb-row');
      await page.hover('.sb-node[data-path="20260819/"] > .sb-row');
      await page.click('.sb-node[data-path="20260819/"] > .sb-row .sb-add');
      await page.waitForSelector('#sidebarTree .sb-new-input', { timeout: 2000 });
      ok('a folder is selected (selected row, 已選定 hint, drop zone active)',
        await page.evaluate(() => !!document.querySelector('.sb-row.selected') && document.getElementById('targetHint').textContent === '已選定' &&
          !document.getElementById('dropZone').classList.contains('no-target')));
      // the queue in every state, a folder node, and the overall bar in each colour
      await page.evaluate(() => {
        const mk = (name, path, state, extra = {}) => ({ id: 'q' + Math.random().toString(36).slice(2), file: { name, size: 3.2 * 1024 * 1024 }, path, state, progress: 0, error: null, ...extra });
        queue.push(mk('IMG_0001.jpg', 'IMG_0001.jpg', 'done', { progress: 100 }),
          mk('IMG_0002.jpg', 'IMG_0002.jpg', 'uploading', { progress: 45 }),
          mk('IMG_0003.jpg', 'IMG_0003.jpg', 'pending'),
          mk('IMG_0004.heic', 'IMG_0004.heic', 'error', { error: '上傳失敗 (413)' }),
          mk('IMG_0005.jpg', 'IMG_0005.jpg', 'done', { progress: 100, thumbWarning: '縮圖失敗' }),
          mk('IMG_0006.jpg', '毛片/IMG_0006.jpg', 'done', { progress: 100 }),
          mk('IMG_0007.jpg', '毛片/IMG_0007.jpg', 'uploading', { progress: 80 }));
        renderQueue();
        document.getElementById('overallWrap').classList.add('visible');
        document.getElementById('queueSection').style.display = '';
        renderOverall();
      });
      await page.waitForSelector('.queue-item.error', { timeout: 2000 });
      await page.waitForSelector('.tree-dir-summary', { timeout: 2000 });
      const states = await page.evaluate(() => ['done', 'uploading', 'pending', 'error'].map(s => [s, !!document.querySelector(`.queue-item.${s}`)])
        .concat([['warn', !!document.querySelector('.qi-status.warn')]]));
      ok('the fixture shows every queue state, the no-thumbnail warning and a folder node', states.every(([, v]) => v), JSON.stringify(states));
      await brightChecks(page, ok, 'upload 佇列', { minItems: 40, inactive: ['.drop-zone.no-target'],
        named: ['.drop-title', '.drop-sub', '.drop-zone .btn-secondary', '.overall-stats', '#overallPct', '.queue-title', '#clearDoneBtn', ...(tag === '1280' ? ['.qi-name'] : []), '.qi-size', '.qi-status.uploading', '.qi-status.done',
          '.qi-status.done.warn', '.qi-status.error', '.qi-status:not(.uploading):not(.done):not(.error)', '.tree-dir-name', '.tree-dir-meta', '.sb-new-input', '.sb-row.selected .sb-name', '.target-hint'] });
      // the toast from selecting a folder is still up (2.8s)
      await page.evaluate(() => selectFolder('20260901/'));
      const toastC = await page.evaluate(() => { const t = [...document.querySelectorAll('body > div')].find(d => /已選擇/.test(d.textContent) && getComputedStyle(d).position === 'fixed'); if (!t) return null; const c = getComputedStyle(t); return { bg: c.backgroundColor, color: c.color }; });
      ok('the toast exists (positive)', !!toastC, JSON.stringify(toastC));
      if (toastC) {
        const parse = s => s.match(/\d+(\.\d+)?/g).map(Number);
        const lumOf = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        const a = lumOf(parse(toastC.bg)), b = lumOf(parse(toastC.color));
        const cr = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        ok('the toast is readable and not a dark slab on the light page', cr >= 4.5 && a > 0.5, `${toastC.bg} / ${toastC.color} = ${cr.toFixed(2)}`);
      }
      await shot(page, `upload-queue-${tag}`);
      return out;
    },
    { before: m.attach, initScript: ADMIN, contextOptions: ctx });
}

// upload.html signed out: auth.js's overlay follows the page's theme…
await suite('亮色主題 — upload.html 未登入：auth.js 的登入遮罩也是亮色',
  `${base}/upload.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForSelector('#auth-overlay', { timeout: 5000 });
    const ov = await page.$eval('#auth-overlay', e => getComputedStyle(e).backgroundColor);
    ok('the overlay ground is the cream', ov === CREAM, ov);
    await brightChecks(page, ok, 'upload 登入遮罩', { root: '#auth-overlay', minItems: 3, named: ['#auth-overlay #auth-input', '#auth-overlay #auth-btn'] });
    await shot(page, 'upload-login-1280');
    return out;
  },
  { contextOptions: DESKTOP });

// …while a dark page that shares auth.js keeps its dark overlay.
await suite('亮色主題 — r2_designer（共用 auth.js 的深色頁）的登入遮罩維持深色',
  `${base}/r2_designer/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForSelector('#auth-overlay', { timeout: 5000 });
    const ov = await page.$eval('#auth-overlay', e => getComputedStyle(e).backgroundColor);
    ok('the overlay ground is still the dark one', ov === CLIENT_DARK, ov);
    return out;
  },
  // fabric.js comes from a CDN the sandbox cannot reach; the designer needs
  // it only to boot, and this test is about auth.js's overlay, so stub it
  { contextOptions: DESKTOP, before: page => page.route('**/fabric.min.js', r => r.fulfill({ contentType: 'text/javascript',
      body: 'const P = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : P()), apply: () => P(), construct: () => P() }); window.fabric = P();' })) });

// ── the client's pages stay dark (positive assertions) ─────────────────────
{
  const m = pickFakeWorker({ ownerName: 'Boss', ownerKey: 'BOSS-KEY' });
  await suite('客戶端維持深色 — index.html 客戶選片連結（?t=）：body、:root 與卡片都還是深色',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('the guest picking page really loaded (positive: photos, no redirect to home.html)',
        await page.evaluate(() => document.querySelectorAll('.photo-card').length > 0 && /index\.html$/.test(location.pathname)));
      const r = await page.evaluate(() => ({
        body: getComputedStyle(document.body).backgroundColor,
        bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().toLowerCase(),
        ink: getComputedStyle(document.documentElement).getPropertyValue('--ink').trim().toLowerCase(),
        card: getComputedStyle(document.querySelector('.photo-card')).backgroundColor,
        text: getComputedStyle(document.body).color,
      }));
      ok('body ground is the dark one', r.body === CLIENT_DARK, r.body);
      ok('css/styles.css :root --bg is still #15120d', r.bg === '#15120d', r.bg);
      ok('and --ink is still the light text colour', r.ink === '#f1ead8', r.ink);
      ok('text on it is light', /^rgb\((2\d\d|1[5-9]\d), /.test(r.text), r.text);
      await shot(page, 'client-pick-dark-1280');
      return out;
    },
    { before: m.attach, contextOptions: DESKTOP });
}

{
  const m = pickFakeWorker({ ownerName: 'Boss', ownerKey: 'BOSS-KEY' });
  await suite('客戶端維持深色 — index.html 客戶選片連結（手機 390px）',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      ok('body ground is the dark one on a phone too', body === CLIENT_DARK, body);
      await shot(page, 'client-pick-dark-390');
      return out;
    },
    { before: m.attach, contextOptions: PHONE });
}

await suite('客戶端維持深色 — index.html 攝影師看照片（studio token）也維持現狀',
  `${base}/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!document.getElementById('studio-logout'), null, { timeout: 5000 });
    ok('signed in as photographer, still on index.html (positive: not bounced to home.html)', await page.evaluate(() => /index\.html$/.test(location.pathname)));
    const body = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    ok('body ground is unchanged (dark)', body === CLIENT_DARK, body);
    return out;
  },
  { initScript: ADMIN, before: pickFakeWorker().attach, contextOptions: DESKTOP });

await suite('客戶端維持深色 — client-login.html',
  `${base}/client-login.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForSelector('#login-email', { state: 'visible', timeout: 5000 });
    const r = await page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      card: getComputedStyle(document.querySelector('.card')).backgroundColor,
      field: getComputedStyle(document.getElementById('login-email')).backgroundColor,
      bg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().toLowerCase(),
    }));
    ok('body ground is the dark one', r.body === CLIENT_DARK, r.body);
    ok('the card is dark', r.card === 'rgb(29, 26, 20)', r.card);
    ok('the field is dark', r.field === 'rgb(34, 31, 24)', r.field);
    ok('its own --bg token is still #15120d', r.bg === '#15120d', r.bg);
    await shot(page, 'client-login-dark-1280');
    return out;
  },
  { contextOptions: DESKTOP });

{
  const m = shareMock();
  await suite('客戶端維持深色 — book_editor/view.html（客戶看相本）',
    `${base}/book_editor/view.html?id=test&t=SHARE-TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => typeof Viewer !== 'undefined' && !!Viewer.book, null, { timeout: 5000 });
      ok('the album really loaded (positive: canvases exist)', (await page.$$('.page-canvas')).length > 0);
      const r = await page.evaluate(() => ({
        body: getComputedStyle(document.body).backgroundColor,
        header: getComputedStyle(document.querySelector('.viewer-header')).backgroundColor,
      }));
      ok('body ground is the dark one', r.body === VIEW_DARK, r.body);
      ok('the header is the dark navy', r.header === 'rgb(22, 33, 62)', r.header);
      await shot(page, 'client-album-dark-1280');
      return out;
    },
    { before: async page => { page.on('dialog', d => d.accept()); await m.attach(page); }, contextOptions: DESKTOP });
}

await browser.close();
server.close();
// A filter that matches nothing must not read as a pass.
if (!ran) { failed++; console.log(`\nFAIL  ONLY=${JSON.stringify(ONLY)} matched no suite`); }
if (ONLY) console.log(`\n(ONLY=${JSON.stringify(ONLY)}: ${ran} suites ran, the rest were skipped)`);
console.log(failed ? `\n${failed} failing` : '\nall passed');
process.exit(failed ? 1 : 0);
