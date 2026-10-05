// Browser suites: file-name escaping on the picker pages, and album XSS on hostile book data.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { PIXEL } from '../lib/env.mjs';
import { mockWorker } from '../lib/editor-mocks.mjs';

export default async function register() {

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
// album XSS (audit FE-1) — a book in R2 is not trusted HTML. The share-link
// PATCH used to store a client's slot photoId / crop as sent, and the editor
// (the photographer's session, studio token in sessionStorage) and every
// viewer put them into innerHTML. The Worker now refuses such values
// (worker/test/book-content.test.mjs); books written before that may still
// hold them, so the renderer must be safe on its own. Every payload below
// writes a window.__xss* flag, and the photos it targets 404, so an injected
// onerror really runs if it got in.
// ═══════════════════════════════════════════════════════════════════════════

const AX_WORKER = 'https://imagepicker.hotichen.workers.dev';
const axTag = n => `"><img src=x onerror="window.__xss${n}=1">`;
// the audit's PoC, verbatim
const AX_BREAKOUT_ID = '20260819/a.jpg" onerror="window.__xss2=1" x="';
const AX_CROP_X = `"><img src=x onerror="window.__xss=sessionStorage.getItem('studio_token')">`;
// real file names: CJK, a space, parentheses; and an apostrophe, which must
// not end the one CSS url('…') the renderer builds
const AX_GOOD_ID = '20260819/新娘 (1).jpg';
const AX_GOOD_PATH = '/20260819/%E6%96%B0%E5%A8%98%20%281%29.jpg';
const AX_QUOTE_ID = "20260819/Tim's pick.jpg";
const AX_LOADABLE = new Set(['/' + AX_GOOD_ID, '/' + AX_QUOTE_ID, '/20260819/b.jpg', '/20260819/c.jpg', '/20260819/d.jpg']);

const AX_BOOK = {
  name: 'ax', clientFolders: ['20260819/'],
  settings: { width: 40, height: 20, dpi: 300 },
  coverSettings: { width: 20, height: 20, dpi: 300 },
  _customLayouts: { 'custom-ax': { name: 'ax', slots: [{ x: axTag(20), y: 0, w: 50, h: 50 }, { x: 50, y: 0, w: 50, h: 100 }] } },
  pages: [
    // 0: the PoC page, plus a text layer with a payload in every field
    { type: 'cover', layout: 'full-bleed', bg: '#fff;" onclick="window.__xss3=1',
      slots: [{ photoId: AX_BREAKOUT_ID, crop: { x: AX_CROP_X, y: axTag(4), scale: axTag(5), rotation: axTag(6) } }],
      textLayers: [{ id: axTag(7), text: '<img src=x onerror="window.__xss8=1">',
        font: 'x;}</style><img src=x onerror="window.__xss9=1">', color: 'red" onmouseover="window.__xss10=1',
        size: axTag(11), x: axTag(12), y: axTag(13), w: axTag(14), align: 'center;" onclick="window.__xss15=1' }] },
    // 1: an ordinary page — the positive control
    { type: 'inner', layout: '2-up-h', bg: '#ffeedd',
      slots: [{ photoId: AX_GOOD_ID, crop: { x: 0.1, y: -0.05, scale: 1.5, rotation: 0 } },
              { photoId: AX_QUOTE_ID, crop: { x: 0, y: 0, scale: 1 } }],
      textLayers: [{ id: 'tl-ok', text: '婚禮', font: '"Noto Serif TC", serif', size: 5, color: '#222222', x: 40, y: 60, w: 80, align: 'left' }] },
    // 2: fit-width / fit-height crops, override geometry, a contain slot with a tag breakout
    { type: 'inner', layout: '3-up',
      slots: [{ photoId: '20260819/b.jpg', fit: 'fit-width', crop: { x: axTag(16), y: 0, scale: axTag(17), rotation: axTag(18) },
                override: { x: axTag(19), y: 0, w: 50, h: 50, rotation: axTag(21) } },
              { photoId: '20260819/c.jpg', fit: 'fit-height', crop: { x: 0, y: axTag(22), scale: 1, rotation: 0 } },
              { photoId: '20260819/"><svg onload="window.__xss23=1">.jpg', fit: 'contain', crop: {} }] },
    // 3: a repeat background whose key closes the CSS url('…'); opacity / size injections
    { type: 'inner', layout: 'blank', bg: 'url(//evil.test/bg)',
      bgImage: { photoId: "20260819/bg.jpg');background:url('//evil.test/y", fit: 'repeat',
        opacity: '1;" onclick="window.__xss24=1', repeatSize: axTag(25) } },
    // 4: an image background with a hostile key and fit; the custom layout with a hostile slot
    { type: 'inner', layout: 'custom-ax',
      bgImage: { photoId: '20260819/bg2.jpg" onerror="window.__xss26=1', fit: 'cover;" onerror="window.__xss27=1', opacity: 1 },
      slots: [{ photoId: '20260819/d.jpg', crop: { x: 0, y: 0, scale: 1 } }, { photoId: null, crop: { x: 0, y: 0, scale: 1 } }] },
    // 5: a key encodeURIComponent throws on (a lone surrogate) must not take the page down
    { type: 'back-cover', layout: 'blank', bgImage: { photoId: '20260819/x' + String.fromCharCode(0xd800) + '.jpg', fit: 'cover', opacity: 1 } },
  ],
};

// Serves the hostile book; only the real photos load, everything else 404s
// (so an injected onerror fires). Records photo requests and anything that
// leaves for another host.
function axMock() {
  const photos = [], foreign = [];
  const attach = async page => {
    page.on('request', r => { const h = new URL(r.url()).hostname; if (h === 'evil.test' || h.endsWith('.evil.test')) foreign.push(r.url()); });
    await page.route('**/evil.test/**', r => r.fulfill({ status: 404, body: '' }));
    await page.route(/fonts\.(googleapis|gstatic)|cdnjs/, r => r.fulfill({ status: 200, body: '' }));
    await page.route('**/imagepicker.hotichen.workers.dev/**', route => {
      const u = new URL(route.request().url());
      const json = body => route.fulfill({ status: 200, contentType: 'application/json', body });
      if (u.pathname === '/api/auth/studio-token')
        return json(JSON.stringify({ token: 'minted', expires_at: new Date(Date.now() + 3600e3).toISOString() }));
      if (u.pathname.endsWith('/status')) return json('{"approved":false}');
      if (u.pathname.startsWith('/api/books/')) {
        if (route.request().method() === 'GET') return json(JSON.stringify(AX_BOOK));
        return json('{"ok":true}');
      }
      if (u.searchParams.has('list')) return json('{"status":"success","folders":[],"data":[]}');
      let key = null;
      try { key = decodeURIComponent(u.pathname); } catch {}
      photos.push({ key, raw: u.pathname, t: u.searchParams.get('t') });
      if (AX_LOADABLE.has(key)) return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
      return route.fulfill({ status: 404, body: 'nf' });
    });
  };
  return { photos, foreign, attach };
}

// In-page: what got through. The renderer's own onload="fitCoverImage(this)"
// is the one inline handler it writes on purpose.
const AX_PROBE = () => {
  const ownHandler = (e, a) => a.name === 'onload' && a.value === 'fitCoverImage(this)' && e.matches('img.slot-cover-img');
  const handlers = [];
  let fitImgs = 0;
  for (const e of document.querySelectorAll('*')) {
    for (const a of e.attributes) {
      if (!/^on/i.test(a.name)) continue;
      if (ownHandler(e, a)) fitImgs++; else handlers.push(`${e.tagName}[${a.name}=${a.value.slice(0, 50)}]`);
    }
  }
  const leaked = [];
  for (const e of document.querySelectorAll('[style], [data-scale], [data-cropx], [data-slot-w]')) {
    for (const a of e.attributes) {
      // src may carry the percent-encoded key, which is the point; a data-*
      // id keeps the stored id as data
      if (a.name !== 'style' && !a.name.startsWith('data-')) continue;
      if (a.name === 'data-text-layer-id' || a.name === 'data-layer-id') continue;
      if (/[<>]|on(error|click|load|mouseover)/i.test(a.value)) leaked.push(`${e.tagName}[${a.name}=${a.value.slice(0, 80)}]`);
    }
  }
  return {
    flags: Object.keys(window).filter(k => k.startsWith('__xss')).map(k => `${k}=${window[k]}`),
    handlers, fitImgs, leaked,
    stray: document.querySelectorAll('img[src="x"], svg[onload], iframe').length,
  };
};

function axAssert(out, r, label, minFit) {
  const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
  ok(`${label} — no payload ran (no window.__xss* flag)`, r.flags.length === 0, r.flags.join(' | '));
  ok(`${label} — no on* attribute besides the renderer's own fitCoverImage`, r.handlers.length === 0, r.handlers.join(' | '));
  ok(`${label} — no injected <img src=x> / <svg onload> / <iframe>`, r.stray === 0, String(r.stray));
  ok(`${label} — no markup or handler text inside a style / geometry attribute`, r.leaked.length === 0, r.leaked.join(' | '));
  // floor: an empty canvas would pass every check above
  ok(`${label} — the cover photos still rendered (${r.fitImgs} ≥ ${minFit})`, r.fitImgs >= minFit, String(r.fitImgs));
}

await suite('album XSS — renderPageHTML and the page thumbnails on hostile book data (unit, every field)',
  `${base}/book_editor/view.html?id=b1&t=TK`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.waitForFunction(() => typeof Viewer !== 'undefined' && !!Viewer.book, null, { timeout: 5000 });
    // the raw stored pages, not the viewer's sanitised copy: the editor renders them as stored
    const r = await page.evaluate(async book => {
      const box = document.createElement('div');
      box.id = 'axBox';
      box.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:400px;';
      document.body.appendChild(box);
      for (const [i, p] of book.pages.entries()) {
        const one = document.createElement('div');
        one.className = `ax-page-${i}`;
        one.innerHTML = renderPageHTML(p, 800, 400) + `<div class="ax-thumb" style="position:relative;width:200px;height:100px">${renderPageThumbnailHTML(p)}</div>`;
        box.appendChild(one);
      }
      await new Promise(res => setTimeout(res, 600));
      const q = (s, root = document) => root.querySelector(s);
      const p0 = q('.ax-page-0 .page-canvas img'), p1 = q('.ax-page-1 .page-canvas');
      const good = p1.querySelectorAll('img.slot-cover-img');
      const t0 = q('.ax-page-0 .page-text-layer'), t1 = q('.ax-page-1 .page-text-layer');
      const bgRep = q('.ax-page-3 .page-bgimage');
      return {
        p0: { src: p0?.getAttribute('src'), cropx: p0?.dataset.cropx, cropy: p0?.dataset.cropy, scale: p0?.dataset.scale, rot: p0?.dataset.rot },
        canvasBg0: getComputedStyle(q('.ax-page-0 .page-canvas')).backgroundColor,
        good0: { src: good[0]?.getAttribute('src'), cropx: good[0]?.dataset.cropx, cropy: good[0]?.dataset.cropy, scale: good[0]?.dataset.scale, width: good[0]?.style.width },
        good1src: good[1]?.getAttribute('src'),
        canvasBg1: getComputedStyle(p1).backgroundColor,
        t0: t0 && { id: t0.getAttribute('data-text-layer-id'), text: t0.textContent.trim(), font: t0.querySelector('span').style.fontFamily,
          color: getComputedStyle(t0.querySelector('span')).color, left: t0.style.left, align: t0.style.textAlign, spans: t0.querySelectorAll('*').length },
        t1: t1 && { id: t1.getAttribute('data-text-layer-id'), text: t1.textContent.trim(), font: t1.querySelector('span').style.fontFamily,
          color: getComputedStyle(t1.querySelector('span')).color, left: t1.style.left, top: t1.style.top, width: t1.style.width, align: t1.style.textAlign },
        bgRepeat: bgRep && getComputedStyle(bgRep).backgroundImage,
        bgRepeatOpacity: bgRep && getComputedStyle(bgRep).opacity,
        canvasBg3: getComputedStyle(q('.ax-page-3 .page-canvas')).backgroundImage,
        customSlots: document.querySelectorAll('.ax-page-4 .page-canvas .page-slot').length,
        containSrc: q('.ax-page-2 .page-canvas .page-slot[data-slot-idx="2"] img')?.getAttribute('src'),
      };
    }, AX_BOOK);
    const probe = await page.evaluate(AX_PROBE);
    axAssert(out, probe, 'unit', 8);

    ok('the PoC photoId stays one attribute: its src is the percent-encoded key on the Worker',
      r.p0.src === `${AX_WORKER}/20260819/a.jpg%22%20onerror%3D%22window.__xss2%3D1%22%20x%3D%22?w=1600&t=TK`, JSON.stringify(r.p0.src));
    ok('a markup crop falls back to the defaults (x 0, y 0, scale 1, rotation 0)',
      r.p0.cropx === '0' && r.p0.cropy === '0' && r.p0.scale === '1' && r.p0.rot === '0', JSON.stringify(r.p0));
    ok('a hostile page background falls back to white', r.canvasBg0 === 'rgb(255, 255, 255)', r.canvasBg0);
    ok('positive: a real CJK name with a space and parentheses gets its encoded src',
      r.good0.src === `${AX_WORKER}${AX_GOOD_PATH}?w=1600&t=TK`, JSON.stringify(r.good0.src));
    ok('positive: its crop is carried exactly', r.good0.cropx === '0.1' && r.good0.cropy === '-0.05' && r.good0.scale === '1.5', JSON.stringify(r.good0));
    ok('positive: and fitCoverImage sized it once it loaded (px, not the 100% placeholder)', /px$/.test(r.good0.width || ''), JSON.stringify(r.good0.width));
    ok("positive: an apostrophe in a real name is encoded as %27", r.good1src === `${AX_WORKER}/20260819/Tim%27s%20pick.jpg?w=1600&t=TK`, JSON.stringify(r.good1src));
    ok('positive: a real page background colour is kept', r.canvasBg1 === 'rgb(255, 238, 221)', r.canvasBg1);
    ok('a text layer id full of markup stays a data value, its text stays text, nothing nested',
      r.t0 && r.t0.id === axTag(7) && r.t0.text === '<img src=x onerror="window.__xss8=1">' && r.t0.spans === 1, JSON.stringify(r.t0));
    ok('a hostile font / colour / align / position falls back', r.t0 && !/style|img/.test(r.t0.font) && r.t0.left === '50%' && r.t0.align === 'center', JSON.stringify(r.t0));
    ok('positive: a real text layer keeps font, colour, position and alignment',
      r.t1 && r.t1.id === 'tl-ok' && r.t1.text === '婚禮' && r.t1.font === '"Noto Serif TC", serif' && r.t1.color === 'rgb(34, 34, 34)'
        && r.t1.left === '40%' && r.t1.top === '60%' && r.t1.width === '80%' && r.t1.align === 'left', JSON.stringify(r.t1));
    ok("a background key that closes url('…') stays inside it, on the Worker",
      typeof r.bgRepeat === 'string' && r.bgRepeat.startsWith(`url("${AX_WORKER}/20260819/bg.jpg%27%29%3Bbackground%3Aurl%28%27/`) && (r.bgRepeat.match(/url\(/g) || []).length === 1,
      JSON.stringify(r.bgRepeat));
    ok('a hostile opacity falls back to 1', r.bgRepeatOpacity === '1', JSON.stringify(r.bgRepeatOpacity));
    ok('a hostile page background is not a url()', r.canvasBg3 === 'none', JSON.stringify(r.canvasBg3));
    ok('the custom layout with a hostile slot still draws both slots', r.customSlots === 2, String(r.customSlots));
    ok('a contain slot with a tag breakout in its key gets one encoded src',
      r.containSrc === `${AX_WORKER}/20260819/%22%3E%3Csvg%20onload%3D%22window.__xss23%3D1%22%3E.jpg?w=1600&t=TK`, JSON.stringify(r.containSrc));
    return out;
  },
  { before: async page => { const m = axMock(); await m.attach(page); } });

{
  const m = axMock();
  await suite('album XSS — the editor opens a hostile book from R2 as the photographer and runs nothing',
    `${base}/book_editor/index.html?id=b1`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => !!window.bookEditor && bookEditor.book?.pages?.length === 6, null, { timeout: 8000 });
      // every page through the main canvas, the panels and the page list
      for (let i = 0; i < 6; i++) {
        await page.evaluate(n => { bookEditor.currentPageIndex = n; bookEditor.renderPageSwitch(); }, i);
        await page.waitForTimeout(250);
        if (i === 1) {
          out.push(...await (async () => {
            const o = [];
            const ok1 = (n, c, d = '') => o.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
            const src = await page.$eval('#pagePreviewArea .page-canvas img.slot-cover-img', e => e.getAttribute('src')).catch(() => null);
            ok1('positive: the ordinary page shows the real photo with its encoded src', src === `${AX_WORKER}${AX_GOOD_PATH}?w=1600&t=minted`, JSON.stringify(src));
            return o;
          })());
        }
        if (i === 0) {
          const panel = await page.evaluate(() => {
            const row = document.querySelector('#textLayerList .text-layer-item');
            return row && { id: row.dataset.layerId, text: row.querySelector('.text-layer-preview')?.textContent };
          });
          ok('the text layer panel keeps a markup id and text as data / text',
            panel && panel.id === axTag(7) && panel.text === '<img src=x onerror="window.__xss8=1">', JSON.stringify(panel));
        }
      }
      await page.waitForTimeout(800);
      axAssert(out, await page.evaluate(AX_PROBE), 'editor', 2);
      ok('positive: the photo request reached the Worker as the exact key, with the studio token',
        m.photos.some(p => p.key === '/' + AX_GOOD_ID && p.t === 'minted'), JSON.stringify(m.photos.filter(p => p.key && p.key.includes('新娘'))));
      ok('nothing was requested from another host', m.foreign.length === 0, m.foreign.join(' | '));
      ok('the studio token is still only in sessionStorage — no payload read it',
        (await page.evaluate(() => window.__xss)) === undefined, String(await page.evaluate(() => window.__xss)));
      return out;
    },
    {
      before: m.attach,
      initScript: () => {
        sessionStorage.setItem('studio_token', 'PHOTOGRAPHER-SECRET');
        try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) {}
      },
    });
}

for (const [label, url, initScript, token] of [
  ['the client opens the album link', `${base}/book_editor/view.html?id=b1&t=TK`, null, 'TK'],
  ['the photographer previews it (no ?t=, studio token injected into CONFIG)', `${base}/book_editor/view.html?id=b1`,
    () => sessionStorage.setItem('studio_token', 'PHOTOGRAPHER-SECRET'), 'minted'],
]) {
  const m = axMock();
  await suite(`album XSS — ${label}: a hostile book runs nothing`,
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => typeof Viewer !== 'undefined' && !!Viewer.book, null, { timeout: 5000 });
      let goodSrc = null;
      for (let i = 0; i < 6; i++) {
        await page.evaluate(n => { Viewer.currentPageIndex = n; Viewer.renderPage(); }, i);
        await page.waitForTimeout(250);
        if (i === 1) goodSrc = await page.$eval('#pageArea img.slot-cover-img', e => e.getAttribute('src')).catch(() => null);
      }
      await page.waitForTimeout(800);
      // the payload flags are global and outlive each page; the DOM checks
      // read the PoC page, which is what the canvas shows on open
      await page.evaluate(() => { Viewer.currentPageIndex = 0; Viewer.renderPage(); });
      await page.waitForTimeout(400);
      axAssert(out, await page.evaluate(AX_PROBE), 'viewer', 1);
      ok('positive: the ordinary page shows the real photo with its encoded src',
        goodSrc === `${AX_WORKER}${AX_GOOD_PATH}?w=1600&t=${token}`, JSON.stringify(goodSrc));
      ok('positive: and the Worker was asked for the exact key', m.photos.some(p => p.key === '/' + AX_GOOD_ID && p.t === token),
        JSON.stringify(m.photos.slice(0, 6)));
      ok('nothing was requested from another host', m.foreign.length === 0, m.foreign.join(' | '));
      return out;
    },
    { before: m.attach, ...(initScript ? { initScript } : {}) });
}
}
