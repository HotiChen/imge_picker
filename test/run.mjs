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
        return json(JSON.stringify({ status: 'success', folders: [], data: PHOTOS(state.photos) }));
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

      // the box is read-only, so whatever is in it is what the client believes
      // their album is called — and the stale folder_path is not it
      const box = await page.evaluate(() => {
        const el = document.getElementById('driveUrl');
        return { value: el?.value, readOnly: el?.readOnly };
      });
      ok('the locked path box shows the same folder, not the one in the session',
        box.value === CLIENT_FOLDER, JSON.stringify(box));
      ok('and it is locked', box.readOnly === true, JSON.stringify(box));

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
  const state = { rows: opts.rows ?? MINTED_ROWS, revoked: opts.revoked ?? 2 };
  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const h = await req.allHeaders();
      const rec = { path: u.pathname, method: req.method(), auth: h['authorization'] ?? null };
      seen.push(rec);
      const json = (body, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body });
      if (rec.auth !== 'Bearer adm') return json('{"error":"Unauthorized"}', 401);
      if (u.pathname === '/api/admin/clients') return json('[]');
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
  const PAGES = ['index.html', 'upload.html', 'tutorial.html',
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

await browser.close();
server.close();
console.log(failed ? `\n${failed} failing` : '\nall passed');
process.exit(failed ? 1 : 0);
