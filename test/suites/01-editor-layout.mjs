// Browser suites: crop geometry, upload thumbnails, preview modal, picker grids, auto layout,
// guides, bleed, page labels, layer order (book editor and the shared grid).
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { PIXEL } from '../lib/env.mjs';
import { mockWorker } from '../lib/editor-mocks.mjs';

export default async function register() {

// shared by the preview suite: what the page asked the Worker for
const asked = [];
const PREVIEW_Q = '?w=1200';

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

// AutoLayout in a real browser: the default loader (crossOrigin image) and the
// default pixel reader (canvas) are the one part the node tests cannot cover.
// Twelve SVG "photos" of mixed shape; p4 is a pixel-for-pixel copy of p3.
const svgPhoto = i => {
  const [w, h] = [[600, 400], [400, 600], [600, 400], [600, 400], [600, 400], [400, 600],
    [500, 500], [600, 400], [400, 600], [800, 400], [600, 400], [400, 600]][i];
  const src = i === 4 ? 3 : i;                       // p4 repeats p3's picture
  let seed = 7919 * (src + 1), rects = '';
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let k = 0; k < 14; k++) {
    rects += `<rect x="${Math.floor(rnd() * w * 0.8)}" y="${Math.floor(rnd() * h * 0.8)}" ` +
      `width="${Math.floor(30 + rnd() * w * 0.4)}" height="${Math.floor(30 + rnd() * h * 0.4)}" ` +
      `fill="hsl(${Math.floor(rnd() * 360)},70%,${Math.floor(25 + rnd() * 55)}%)"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="#888"/>${rects}</svg>`;
};
await suite('auto layout — the smart style and the old styles in the editor, on real pixels',
  `${base}/book_editor/index.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => !!window.bookEditor, null, { timeout: 5000 });
    const r = await page.evaluate(async () => {
      const ids = Array.from({ length: 12 }, (_, i) => `20260819/p${i}.jpg`);
      bookEditor.libraryPhotos = ids.map(id => ({ id, name: id.split('/')[1], rating: 0 }));
      bookEditor._confirm = async () => true;
      const sel = document.getElementById('autoLayoutStyle');
      const info = { values: [...sel.options].map(o => o.value), initial: sel.value };

      info.analysed = await AutoLayout.analyze(ids, {
        urlFor: id => driveManager.getImageUrl({ id }, 400),
      });

      sel.value = 'auto';
      await bookEditor.runAutoLayout();
      const pages = bookEditor.book.pages;
      const aspect = st => st.width / st.height;
      const expected = AutoLayout.plan(info.analysed, {
        pageAspect: aspect(bookEditor.book.settings),
        coverAspect: aspect(bookEditor.book.coverSettings || bookEditor.book.settings),
      });
      info.expectedCover = expected.cover;
      info.expectedInner = expected.pages.map(p => p.layout);
      info.auto = {
        types: pages.map(p => p.type),
        photos: pages.flatMap(p => p.slots.map(s => s.photoId)),
        cover: pages[0].slots[0],
        inner: pages.filter(p => p.type === 'inner').map(p => ({ layout: p.layout, n: p.slots.length })),
        idsUnique: new Set(pages.map(p => p.id)).size === pages.length,
        shown: !!document.querySelector('.page-canvas .slot-cover-img'),
      };

      sel.value = 'story';
      await bookEditor.runAutoLayout();
      const p2 = bookEditor.book.pages;
      info.story = { inner: p2.filter(p => p.type === 'inner').length, photos: p2.filter(p => p.type === 'inner').flatMap(p => p.slots.map(s => s.photoId)).filter(Boolean) };
      return { ...info, ids };
    });

    ok('the smart style is offered, as the last choice', r.values.at(-1) === 'auto' && r.values.includes('story'), r.values.join());
    ok('and the default is still an old style', r.initial !== 'auto', r.initial);

    const a = r.analysed;
    ok('analyze: every photo loaded with real pixels', a.length === 12 && a.every(x => x.ok && /^[0-9a-f]{16}$/.test(x.hash)), JSON.stringify(a.map(x => [x.ok, x.hash])));
    ok('analyze: shapes are read from the thumbnails', Math.abs(a[0].aspect - 1.5) < 0.01 && Math.abs(a[1].aspect - 2 / 3) < 0.01 && a[6].orientation === 'square',
      JSON.stringify(a.slice(0, 7).map(x => [x.aspect, x.orientation])));
    ok('analyze: the copy has the same hash, the others differ', a[3].hash === a[4].hash && new Set(a.map(x => x.hash)).size === 11, JSON.stringify(a.map(x => x.hash)));
    ok('analyze: textured pictures have sharpness, focus stays inside 0.2..0.8',
      a.every(x => x.sharpness > 0 && x.focus.x >= 0.2 && x.focus.x <= 0.8 && x.focus.y >= 0.2 && x.focus.y <= 0.8));

    const m = r.auto;
    ok('smart: cover + inner pages + back cover', m.types[0] === 'cover' && m.types.at(-1) === 'back-cover' && m.inner.length >= 3, m.types.join());
    ok('smart: the cover is the one plan() chose, with its focus crop',
      m.cover.photoId === r.expectedCover.photoId && JSON.stringify(m.cover.crop) === JSON.stringify(r.expectedCover.crop),
      JSON.stringify([m.cover, r.expectedCover]));
    ok('smart: the inner pages are plan()\'s pages', JSON.stringify(m.inner.map(p => p.layout)) === JSON.stringify(r.expectedInner), JSON.stringify([m.inner, r.expectedInner]));
    const used = new Set(m.photos.filter(Boolean));
    ok('smart: the repeated shot is left out, every other photo is used', used.size === 11 && !(used.has(r.ids[3]) && used.has(r.ids[4])), `${used.size} used`);
    ok('smart: no empty slots on inner pages', m.inner.every(p => p.n >= 1) && m.photos.every(Boolean), JSON.stringify(m.photos));
    ok('smart: the pages are drawn', m.shown && m.idsUnique);

    ok('story still works through run() with real Image loads', r.story.inner >= 3 && r.story.photos.length === 12, JSON.stringify(r.story));
    return out;
  },
  {
    initScript: () => {
      sessionStorage.setItem('studio_token', 'x');
      try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) {}
    },
    before: async page => {
      await mockWorker(12)(page);
      // later routes win: the photos themselves, with the CORS header the Worker sends
      await page.route('**/imagepicker.hotichen.workers.dev/**', route => {
        const u = new URL(route.request().url());
        const m = /\/p(\d+)\.jpg$/.exec(u.pathname);
        if (!m || u.searchParams.has('list')) return route.fallback();
        route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svgPhoto(Number(m[1])),
          headers: { 'Access-Control-Allow-Origin': '*' } });
      });
    },
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
}
