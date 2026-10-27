// Browser suites: 匯入 book editor, the button in the photographer's layout viewer (js/album-layout-view.js) that turns a guest's
// Layout JSON v2 into a NEW editable book (book_editor/js/import_layout.js, PUT /api/books/<new id>) and opens it.
// The fake Worker's album routes are test/lib/books-fake.mjs (Bearer required, the real book check on the body); the order and
// the thumbnails come from orders-fake and the same photo fake as 99u. The last suite opens the produced book in the REAL
// book_editor page and checks that the first spread draws the guest's slots (the end-to-end "looks the same").
// Node tests of the converter: test/unit/import-layout.test.mjs. Chromium only; a printed export and a real phone are not covered.
import { createRequire } from 'node:module';
import { base, suite } from '../lib/harness.mjs';
import { MOBILE, BIG_PHOTO } from '../lib/env.mjs';
import { dashSettingsMock } from '../lib/dashboard-mocks.mjs';
import { ordersFake, layoutV2 } from '../lib/orders-fake.mjs';
import { booksFake } from '../lib/books-fake.mjs';

const ST = createRequire(import.meta.url)('../../book_editor/js/spread_templates.js');

export default async function register() {
const line = () => { const out = []; return { out, ok: (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`) }; };

const GOOD = layoutV2({
  cover: 'd/COVER.jpg',
  spreads: [
    { template: 'pair-portraits', slots: ['d/IMG_002.jpg', 'd/IMG_003.jpg'] },
    { template: 'one-two-right', mirrored: true, slots: ['d/IMG_004.jpg', { key: 'd/IMG_005.jpg', fit: 'cover', crop: { x: 0.2, y: -0.1 } }, 'd/IMG_006.jpg'] },
    { template: 'hero-bleed', slots: [{ key: 'd/IMG_007.jpg', fit: 'cover', crop: { x: 0.1, y: 0 } }] },
  ],
  back: {},
});
const album = layout => ({ kind: 'album', name: '相本書', option_label: '8×8 吋', unit_price: 4200, list_price: 4200, qty: 1, photo_keys: [], layout });
const UNSAFE_KEY = 'd/x" onerror="window.__pwn=1"<img src=x>.jpg';
const ODD_KEY = "d/x onerror=window.__pwn=1 '&#.jpg";   // spaces, =, an apostrophe, & and #: all legal in a key
const HOSTILE_CONTACT = '<img src=x onerror=window.__pwn=1>客人"';
const BAD_UNKNOWN = { v: 2, mode: 'auto', cover: null, spreads: [{ template: 'no-such-template', slots: [{ photo_key: 'd/a.jpg', fit: 'cover', crop: { x: 0, y: 0, scale: 1 } }] }], back: null };

function fixtures() {
  const o = ordersFake({ products: [], titles: { 'proj-1': '海邊系列' } });
  const guest = (id, items, name = `客人${id}`) => o.st.addOrder({ id, source: 'guest', status: 'requested', project_id: 'proj-1', delivery_method: 'pickup', consent_version: 'v1',
    contact: { name, phone: '0912-345-678', line: null, erased_at: null }, items });
  guest('v2', [album(GOOD)], '王小明');
  guest('unsafe', [album(layoutV2({ cover: 'd/COVER.jpg', spreads: [{ template: 'solo-right', slots: [UNSAFE_KEY] }] }))]);
  guest('odd', [album(layoutV2({ cover: ODD_KEY, spreads: [{ template: 'solo-right', slots: [ODD_KEY] }] }))], HOSTILE_CONTACT);
  guest('unknown', [album(BAD_UNKNOWN)]);
  guest('noname', [album(GOOD)], '');
  return o;
}

function photoFake() {
  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      if (u.pathname === '/api/auth/studio-token') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: 'STUDIO-TOK', expires_at: new Date(Date.now() + 12 * 3600000).toISOString() }) });
      if (u.pathname.startsWith('/api/')) return route.fallback();
      route.fulfill({ status: 200, contentType: 'image/png', body: BIG_PHOTO });
    });
  };
  return { attach };
}

// serialised into the page: self-contained. The token is seeded once per tab (the marker), so a tab opened by window.open that
// finds studio_token there got it from the opener's copy of sessionStorage only when the marker came with it.
const init = () => {
  try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) { /* ignore */ }
  if (!location.pathname.endsWith('/home.html') && !sessionStorage.getItem('__seeded')) { sessionStorage.setItem('studio_token', 'adm'); sessionStorage.setItem('__seeded', '1'); }
};
const wiring = (m, o, ph, b) => async page => {
  await b.attach(page.context());                 // the new tab (the editor) is served by the context
  await m.attach(page); await o.attach(page); await ph.attach(page);
  await b.attach(page, { images: false });        // the viewer page: the album routes first, its own thumbnails after
};
const openViewer = async (page, orderId) => {
  await page.waitForSelector('.ord-row', { timeout: 5000 });
  await page.click(`[data-order-id="${orderId}"] [data-view-layout]`);
  await page.waitForSelector('[data-layout-viewer]');
};
const status = page => page.$eval('[data-alv-import-status]', e => ({ text: e.textContent, err: e.classList.contains('alv-import-err'), link: e.querySelector('[data-alv-import-link]')?.textContent ?? null, children: e.children.length }));
const btn = page => page.$eval('[data-alv-import]', b => { const r = b.getBoundingClientRect(); return { text: b.textContent, disabled: b.disabled, w: r.width, h: r.height, shown: getComputedStyle(b).display !== 'none' && r.width > 0 }; });
const near = (a, b) => Math.abs(a - b) < 1e-6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ═════════════════════ 1. the happy path, once ═════════════════════
{
  const m = dashSettingsMock(), o = fixtures(), ph = photoFake(), b = booksFake();
  await suite('import layout — 按鈕、確認、一次 PUT、新分頁開 ?id=、書的內容與客人排的一致',
    `${base}/orders.html`,
    async page => {
      const { out, ok } = line();
      const ctx = page.context();
      await openViewer(page, 'v2');
      const b0 = await btn(page);
      ok('the viewer has 匯入 book editor: visible, enabled, >= 44px high', b0.text === '匯入 book editor' && b0.shown && !b0.disabled && b0.h >= 44, JSON.stringify(b0));
      ok('nothing is sent just by opening the viewer', b.st.puts.length === 0);

      // 1. refuse the confirm: nothing happens
      let dlg = null;
      page.once('dialog', d => { dlg = d.message(); d.dismiss(); });
      await page.click('[data-alv-import]');
      await page.waitForTimeout(150);
      ok('the confirm says it makes a NEW album and the order is unchanged', dlg === '會建立一本新的相本，客人的訂單不會改變', String(dlg));
      ok('cancelled: no PUT, button enabled again, no link', b.st.puts.length === 0 && !(await btn(page)).disabled && (await status(page)).link === null);

      // 2. accept: one PUT, one new tab
      await page.evaluate(() => sessionStorage.setItem('__opener_marker', 'yes'));
      page.once('dialog', d => d.accept());
      const [tab] = await Promise.all([ctx.waitForEvent('page'), page.click('[data-alv-import]')]);
      await page.waitForFunction(() => document.querySelector('[data-alv-import-link]'), null, { timeout: 5000 });
      ok('exactly one PUT', b.st.puts.length === 1, String(b.st.puts.length));
      const put = b.st.puts[0];
      ok('PUT /api/books/<uuid> with the photographer\'s Bearer and a JSON body', UUID.test(put.id) && put.auth === 'Bearer adm' && /application\/json/.test(put.contentType), JSON.stringify([put.id, put.auth, put.contentType]));
      const book = JSON.parse(put.text);
      ok('stored by the fake after the real check (200), under that id', b.st.books.get(put.id) === put.text);
      ok('name = 客人名 — 專案名', book.name === '王小明 — 海邊系列', book.name);
      ok('pages: cover, three inner, back-cover; every page unlocked; ids unique',
        book.pages.map(p => p.type).join() === 'cover,inner,inner,inner,back-cover' && book.pages.every(p => p.locked === false) && new Set(book.pages.map(p => p.id)).size === 5, JSON.stringify(book.pages.map(p => p.type)));
      ok('settings: A4 spread 42x29.7 cm, 300 dpi, pagesPerSheet 2; cover A4 21x29.7; no client folders, no notify URL',
        book.settings.width === 42 && book.settings.height === 29.7 && book.settings.unit === 'cm' && book.settings.dpi === 300 && book.settings.pagesPerSheet === 2 &&
        book.coverSettings.width === 21 && book.coverSettings.height === 29.7 && book.clientFolders.length === 0 && book.notifyUrl === '', JSON.stringify([book.settings, book.coverSettings]));
      ok('cover: full-bleed with the cover photo', book.pages[0].layout === 'full-bleed' && book.pages[0].slots[0].photoId === 'd/COVER.jpg');
      const inner = book.pages.filter(p => p.type === 'inner');
      ok('inner layouts are custom-<template>[-m], all embedded in _customLayouts (and nothing else is)',
        inner.map(p => p.layout).join() === 'custom-pair-portraits,custom-one-two-right-m,custom-hero-bleed' && Object.keys(book._customLayouts).sort().join() === 'custom-hero-bleed,custom-one-two-right-m,custom-pair-portraits', JSON.stringify(inner.map(p => p.layout)));
      const geomOk = inner.every((p, i) => {
        const t = ST.byId(GOOD.spreads[i].template);
        const mir = GOOD.spreads[i].mirrored === true;
        const L = book._customLayouts[p.layout];
        return L.slots.length === t.slots.length && t.slots.every((g, j) => near(L.slots[j].x, (mir ? 1 - g.x - g.w : g.x) * 100) && near(L.slots[j].y, g.y * 100) && near(L.slots[j].w, g.w * 100) && near(L.slots[j].h, g.h * 100));
      });
      ok('every slot rectangle equals the template slot x100 (the second spread mirrored)', geomOk);
      ok('photo ids, fit and crop are the guest\'s, slot by slot',
        inner.every((p, i) => p.slots.length === GOOD.spreads[i].slots.length && p.slots.every((s, j) => s.photoId === GOOD.spreads[i].slots[j].photo_key && s.fit === GOOD.spreads[i].slots[j].fit && s.crop.x === GOOD.spreads[i].slots[j].crop.x && s.crop.y === GOOD.spreads[i].slots[j].crop.y && s.crop.scale === 1)) &&
        inner[1].slots[1].fit === 'cover' && inner[1].slots[0].fit === 'contain' && inner[1].slots[1].crop.x === 0.2);
      ok('the order was not touched: no write to any order route', o.st.calls.every(c => c.method === 'GET'), JSON.stringify(o.st.calls.map(c => c.method + c.path)));

      const s = await status(page);
      ok('after success: 「已匯入，開啟」 link, the button reads 已匯入 and stays disabled', s.link === '已匯入，開啟' && (await btn(page)).text === '已匯入' && (await btn(page)).disabled, JSON.stringify([s, await btn(page)]));
      ok('the link points at book_editor/index.html?id=<the same id>', await page.$eval('[data-alv-import-link]', (a, id) => { const u = new URL(a.href); return /\/book_editor\/index\.html$/.test(u.pathname) && u.searchParams.get('id') === id && [...u.searchParams.keys()].length === 1; }, put.id));
      await tab.waitForLoadState('load');
      ok('the new tab is the editor on ?id=<same id>', (() => { const u = new URL(tab.url()); return /\/book_editor\/index\.html$/.test(u.pathname) && u.searchParams.get('id') === put.id; })(), tab.url());
      ok('and it carries a copy of the opener\'s sessionStorage (window.open without noopener): the editor finds studio_token',
        await tab.evaluate(() => sessionStorage.getItem('studio_token') === 'adm' && sessionStorage.getItem('__opener_marker') === 'yes'));
      await tab.close();

      // 3. pressing again does nothing
      await page.evaluate(() => { const b = document.querySelector('[data-alv-import]'); b.disabled = false; b.click(); });
      await page.waitForTimeout(250);
      ok('pressing again (even with the disabled flag forced off) creates nothing: still one PUT, one book', b.st.puts.length === 1 && b.st.books.size === 1, String(b.st.puts.length));
      return out;
    },
    { before: wiring(m, o, ph, b), initScript: init });
}

// ═════════════════════ 2. double press while the PUT is in flight ═════════════════════
{
  const m = dashSettingsMock(), o = fixtures(), ph = photoFake(), b = booksFake();
  b.st.putDelay = 700;
  await suite('import layout — 連按兩次只送一次（PUT 還在路上時）',
    `${base}/orders.html`,
    async page => {
      const { out, ok } = line();
      await openViewer(page, 'v2');
      let dialogs = 0;
      page.on('dialog', d => { dialogs++; d.accept(); });
      await page.evaluate(() => { const x = document.querySelector('[data-alv-import]'); x.click(); x.click(); });
      await page.waitForFunction(() => document.querySelector('[data-alv-import]').disabled, null, { timeout: 2000 });
      const busy = await btn(page);
      ok('while busy the button is disabled and the status says 匯入中…', busy.disabled && (await status(page)).text === '匯入中…', JSON.stringify([busy, await status(page)]));
      // even with the disabled flag removed by force, the handler refuses (no second confirm, no second PUT)
      await page.evaluate(() => { const x = document.querySelector('[data-alv-import]'); x.disabled = false; x.click(); x.click(); });
      await page.waitForFunction(() => document.querySelector('[data-alv-import-link]'), null, { timeout: 6000 });
      await page.waitForTimeout(300);
      ok('one confirm, one PUT, one book after 4 presses', dialogs === 1 && b.st.puts.length === 1 && b.st.books.size === 1, JSON.stringify([dialogs, b.st.puts.length, b.st.books.size]));
      return out;
    },
    { before: wiring(m, o, ph, b), initScript: init });
}

// ═════════════════════ 3. failures: nothing half-saved, the button comes back ═════════════════════
{
  const m = dashSettingsMock(), o = fixtures(), ph = photoFake(), b = booksFake();
  await suite('import layout — 失敗：清楚的訊息、按鈕恢復、沒有存半本；之後可以再按',
    `${base}/orders.html`,
    async page => {
      const { out, ok } = line();
      const ctx = page.context();
      page.on('dialog', d => d.accept());
      const press = () => page.click('[data-alv-import]');
      const settled = () => page.waitForFunction(() => { const t = document.querySelector('[data-alv-import-status]').textContent; return t && t !== '匯入中…'; }, null, { timeout: 5000 });
      const tabsBefore = ctx.pages().length;

      // a layout the converter refuses (unknown template): no request at all
      await openViewer(page, 'unknown');
      await press(); await settled();
      let s = await status(page);
      ok('unknown template: 「這份排版無法匯入：…」 with the reason, shown as an error, no PUT, button enabled',
        /^這份排版無法匯入：第1跨頁的版型不認得$/.test(s.text) && s.err && b.st.puts.length === 0 && !(await btn(page)).disabled && s.link === null, JSON.stringify(s));
      await page.keyboard.press('Escape');

      // a key the Worker would refuse (quote): refused before any request, and shown as text
      await page.click('[data-order-id="unsafe"] [data-view-layout]');
      await page.waitForSelector('[data-layout-viewer]');
      await press(); await settled();
      s = await status(page);
      ok('hostile key (quote, <, onerror): refused with a message, no PUT, no element was made from it',
        /第1跨頁第1格的照片路徑不正確/.test(s.text) && b.st.puts.length === 0 && s.children === 0 && await page.evaluate(() => window.__pwn === undefined && !document.querySelector('[data-layout-viewer] img[src="x"]')), JSON.stringify(s));
      await page.keyboard.press('Escape');

      // the server fails: 500, then 401, then a dropped connection
      await page.click('[data-order-id="v2"] [data-view-layout]');
      await page.waitForSelector('[data-layout-viewer]');
      b.st.putStatus = 500;
      await press(); await settled();
      s = await status(page);
      ok('HTTP 500: 「儲存失敗（HTTP 500），沒有建立相本，可以再按一次」, button enabled, no link, nothing stored, no new tab',
        s.text === '儲存失敗（HTTP 500），沒有建立相本，可以再按一次' && s.err && !(await btn(page)).disabled && s.link === null && b.st.books.size === 0 && ctx.pages().length === tabsBefore, JSON.stringify([s, b.st.books.size, ctx.pages().length]));
      b.st.putStatus = 401;
      await press(); await page.waitForFunction(() => /登入已過期/.test(document.querySelector('[data-alv-import-status]').textContent), null, { timeout: 5000 });
      ok('HTTP 401: 「登入已過期，請重新登入後再試」', (await status(page)).text === '登入已過期，請重新登入後再試' && !(await btn(page)).disabled);
      b.st.putStatus = 400;
      await press(); await page.waitForFunction(() => /伺服器拒絕/.test(document.querySelector('[data-alv-import-status]').textContent), null, { timeout: 5000 });
      ok('HTTP 400: 「伺服器拒絕了這份排版，沒有建立相本」', (await status(page)).text === '伺服器拒絕了這份排版，沒有建立相本');
      b.st.putStatus = null;
      const tries = b.st.puts.length;
      ok('three failed attempts were three requests, each under its own new id, none stored', tries === 3 && new Set(b.st.puts.map(p => p.id)).size === 3 && b.st.books.size === 0, JSON.stringify(b.st.puts.map(p => p.id)));
      await page.evaluate(() => sessionStorage.removeItem('studio_token'));
      await press(); await settled();
      ok('no photographer credential: 「請先登入攝影師帳號再匯入」 and no request', (await status(page)).text === '請先登入攝影師帳號再匯入' && b.st.puts.length === tries && !(await btn(page)).disabled);
      await page.evaluate(() => sessionStorage.setItem('studio_token', 'adm'));
      await page.route('**/api/books/**', r => r.request().method() === 'PUT' ? r.abort() : r.fallback());
      await press(); await settled();
      s = await status(page);
      ok('connection dropped: 「儲存失敗（連不上伺服器）…」, button enabled', /^儲存失敗（連不上伺服器）/.test(s.text) && !(await btn(page)).disabled && b.st.books.size === 0, JSON.stringify(s));
      await page.unroute('**/api/books/**');

      // recovery: now it works, once
      const [tab] = await Promise.all([ctx.waitForEvent('page'), press()]);
      await page.waitForFunction(() => document.querySelector('[data-alv-import-link]'), null, { timeout: 5000 });
      ok('after the failures the next press succeeds: one stored book, the link shows, the error styling is gone', b.st.books.size === 1 && (await status(page)).link === '已匯入，開啟' && !(await status(page)).err);
      await tab.close();
      return out;
    },
    { before: wiring(m, o, ph, b), initScript: init });
}

// ═════════════════════ 4. guest strings stay text; the name ═════════════════════
{
  const m = dashSettingsMock(), o = fixtures(), ph = photoFake(), b = booksFake();
  await suite('import layout — 客人的名字與檔名是純文字：不產生元素、書名被清乾淨、沒有名字時用預設',
    `${base}/orders.html`,
    async page => {
      const { out, ok } = line();
      const ctx = page.context();
      page.on('dialog', d => d.accept());
      await openViewer(page, 'odd');
      const [tab] = await Promise.all([ctx.waitForEvent('page'), page.click('[data-alv-import]')]);
      await page.waitForFunction(() => document.querySelector('[data-alv-import-link]'), null, { timeout: 5000 });
      const book = JSON.parse(b.st.puts[0].text);
      ok('a legal but nasty key (spaces, =, \', &, #) goes through as a plain photoId, unchanged', book.pages[1].slots[0].photoId === ODD_KEY && book.pages[0].slots[0].photoId === ODD_KEY, JSON.stringify(book.pages[1].slots));
      ok('the hostile contact name is cleaned of < > " ` in the book name (the order card keeps the real name)', !/[<>"`]/.test(book.name) && book.name.includes('客人') && book.name.endsWith(' — 海邊系列'), book.name);
      const probe = await page.evaluate(() => ({ pwn: window.__pwn, imgX: document.querySelectorAll('img[src="x"]').length, st: document.querySelector('[data-alv-import-status]').children.length, onAttrs: [...document.querySelectorAll('[data-layout-viewer] *')].flatMap(e => [...e.attributes].map(a => a.name)).filter(n => /^on/i.test(n)).length }));
      ok('no markup was made from guest text in the viewer: no img[src=x], no on* attribute, the status holds only the link', probe.pwn === undefined && probe.imgX === 0 && probe.st === 1 && probe.onAttrs === 0, JSON.stringify(probe));
      await tab.waitForLoadState('load');
      await tab.waitForTimeout(500);
      ok('the editor tab ran nothing from the names either', await tab.evaluate(() => window.__pwn === undefined));
      await tab.close();
      await page.keyboard.press('Escape');
      await page.click('[data-order-id="noname"] [data-view-layout]');
      await page.waitForSelector('[data-layout-viewer]');
      const [tab2] = await Promise.all([ctx.waitForEvent('page'), page.click('[data-alv-import]')]);
      await page.waitForFunction(() => document.querySelector('[data-alv-import-link]'), null, { timeout: 5000 });
      ok('客人名 empty but a project title: the name is the project title alone', JSON.parse(b.st.puts[1].text).name === '海邊系列', JSON.parse(b.st.puts[1].text).name);
      await tab2.close();
      return out;
    },
    { before: wiring(m, o, ph, b), initScript: init });
}

// ═════════════════════ 5. phone ═════════════════════
{
  const m = dashSettingsMock(), o = fixtures(), ph = photoFake(), b = booksFake();
  await suite('import layout — 390px 手機：按鈕與連結 44px、不橫向捲動',
    `${base}/orders.html`,
    async page => {
      const { out, ok } = line();
      page.on('dialog', d => d.accept());
      await openViewer(page, 'v2');
      const b0 = await btn(page);
      ok('the button is >= 44px high and wide on a phone', b0.shown && b0.h >= 44 && b0.w >= 44, JSON.stringify(b0));
      await page.click('[data-alv-import]');
      await page.waitForFunction(() => document.querySelector('[data-alv-import-link]'), null, { timeout: 5000 });
      const l = await page.$eval('[data-alv-import-link]', a => { const r = a.getBoundingClientRect(); return { w: r.width, h: r.height }; });
      const geo = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.querySelector('.alv-body').scrollWidth, bc: document.querySelector('.alv-body').clientWidth }));
      ok('the link is a >= 44px target and nothing scrolls sideways', l.h >= 44 && geo.sw <= geo.cw && geo.bw <= geo.bc, JSON.stringify([l, geo]));
      return out;
    },
    { before: wiring(m, o, ph, b), initScript: init, contextOptions: MOBILE });
}

// ═════════════════════ 6. end to end: the imported book in the REAL editor ═════════════════════
{
  const m = dashSettingsMock(), o = fixtures(), ph = photoFake(), b = booksFake();
  await suite('import layout — 匯入的書在真正的 book editor 裡：頁數、格數、照片、格子位置與客人排的相同',
    `${base}/orders.html`,
    async page => {
      const { out, ok } = line();
      const ctx = page.context();
      page.on('dialog', d => d.accept());
      await openViewer(page, 'v2');
      const [tab] = await Promise.all([ctx.waitForEvent('page'), page.click('[data-alv-import]')]);
      await page.waitForFunction(() => document.querySelector('[data-alv-import-link]'), null, { timeout: 5000 });
      const id = b.st.puts[0].id;
      await tab.waitForSelector('.page-thumb', { timeout: 10000 });
      ok('the editor fetched THAT book from the cloud (GET /api/books/<id> with the Bearer)', b.st.gets.some(g => g.id === id && g.auth === 'Bearer adm'), JSON.stringify(b.st.gets));
      const thumbs = await tab.$$eval('.page-thumb', els => els.map(e => e.querySelector('.page-thumb-label')?.textContent ?? ''));
      ok('the page list: 封面, P1–2, P3–4, P5–6, 封底 (pagesPerSheet 2)', thumbs.join('|') === '封面|P1–2|P3–4|P5–6|封底', thumbs.join('|'));
      ok('the book name and the A4 sheet came through', await tab.evaluate(() => window.bookEditor.book.name === '王小明 — 海邊系列' && window.bookEditor.book.settings.width === 42 && window.bookEditor.book.coverSettings.width === 21));

      const spreadRects = async idx => {
        await tab.click(`.page-thumb[data-page-idx="${idx}"]`);
        await tab.waitForFunction(i => window.bookEditor.currentPageIndex === i && document.querySelectorAll('.page-canvas .page-slot').length > 0, idx, { timeout: 5000 });
        return tab.evaluate(() => {
          const c = document.querySelector('.page-canvas').getBoundingClientRect();
          return { w: c.width, h: c.height, slots: [...document.querySelectorAll('.page-canvas .page-slot')].map(s => {
            const r = s.getBoundingClientRect();
            const img = s.querySelector('img');
            return { idx: s.dataset.slotIdx, x: (r.left - c.left) / c.width, y: (r.top - c.top) / c.height, w: r.width / c.width, h: r.height / c.height,
              src: img ? decodeURIComponent(img.getAttribute('src') || '') : null, fit: img ? getComputedStyle(img).objectFit : null }; }) };
        });
      };
      const compare = async (idx, sp, label) => {
        const t = ST.byId(sp.template);
        const mir = sp.mirrored === true;
        const r = await spreadRects(idx);
        ok(`${label}: ${t.slots.length} slots drawn, aspect of the canvas is the spread's (420:297)`, r.slots.length === t.slots.length && Math.abs(r.w / r.h - 420 / 297) < 0.02, JSON.stringify([r.slots.length, r.w, r.h]));
        ok(`${label}: every slot rectangle is the template's (x,y,w,h fractions of the spread${mir ? ', mirrored' : ''}) within 0.5%`,
          t.slots.every((g, j) => Math.abs(r.slots[j].x - (mir ? 1 - g.x - g.w : g.x)) < 0.005 && Math.abs(r.slots[j].y - g.y) < 0.005 && Math.abs(r.slots[j].w - g.w) < 0.005 && Math.abs(r.slots[j].h - g.h) < 0.005), JSON.stringify(r.slots));
        ok(`${label}: slot ${sp.slots.map((_, j) => j).join('/')} hold the guest's photos in order`, sp.slots.every((s, j) => r.slots[j].src && r.slots[j].src.includes(s.photo_key)), JSON.stringify(r.slots.map(s => s.src)));
        return r;
      };
      await compare(1, GOOD.spreads[0], 'spread 1');
      const r2 = await compare(2, GOOD.spreads[1], 'spread 2 (mirrored)');
      ok('spread 2: the big slot is on the RIGHT page (mirrored) and the contain/cover fits arrive (slot 0 contain, slot 1 cover)', r2.slots[0].x > 0.5 && r2.slots[0].fit === 'contain' && r2.slots[1].fit === 'cover', JSON.stringify(r2.slots));
      const r3 = await compare(3, GOOD.spreads[2], 'spread 3 (hero, one wide slot)');
      ok('spread 3: the single span slot covers the whole spread', r3.slots.length === 1 && r3.slots[0].w > 0.99 && r3.slots[0].h > 0.99, JSON.stringify(r3.slots));
      await tab.click('.page-thumb[data-page-idx="0"]');
      await tab.waitForFunction(() => window.bookEditor.currentPageIndex === 0 && document.querySelectorAll('.page-canvas .page-slot').length === 1, null, { timeout: 5000 });
      ok('the cover: one full slot with the cover photo', await tab.evaluate(() => { const s = document.querySelector('.page-canvas .page-slot img'); return !!s && decodeURIComponent(s.getAttribute('src')).includes('d/COVER.jpg'); }));
      await tab.click('.page-thumb[data-page-idx="4"]');
      await tab.waitForFunction(() => window.bookEditor.currentPageIndex === 4, null, { timeout: 5000 });
      ok('the back: a blank page with no slot', await tab.evaluate(() => document.querySelectorAll('.page-canvas .page-slot').length === 0));
      await tab.close();
      return out;
    },
    { before: wiring(m, o, ph, b), initScript: init });
}
}
