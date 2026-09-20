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

async function suite(name, url, run, { initScript, before } = {}) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
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
  `${base}/book_editor/view.html?id=test`,
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
  `${base}/book_editor/view.html?id=t`,
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
  `${base}/book_editor/view.html?id=t`,
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

await browser.close();
server.close();
console.log(failed ? `\n${failed} failing` : '\nall passed');
process.exit(failed ? 1 : 0);
