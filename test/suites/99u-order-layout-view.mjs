// Browser suites: the photographer's read-only viewer of a guest's album layout (docs/guest-shop.md, "S3 — 客人相本排版",
// work package 3): 「查看排版」 on a guest album line (orders.html, admin.html project detail) opens js/album-layout-view.js:
// cover then each spread, flip, file names, 複製排版清單, a missing photo, hostile keys as text, phone width.
// The fake Worker is test/lib/orders-fake.mjs (layout v2 in the real shape via layoutV2) plus, here, the thumbnail route and
// the studio-token mint. Chromium only; a real phone still has to look at it. Node tests of the pure part:
// test/unit/album-layout-view.test.mjs.
import { createRequire } from 'node:module';
import { base, suite } from '../lib/harness.mjs';
import { MOBILE, BIG_PHOTO, swipeTouch } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { SEED_TOKEN, dashSettingsMock } from '../lib/dashboard-mocks.mjs';
import { ADMIN_PICKS, ordersFake, layoutV2, waitText } from '../lib/orders-fake.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

const ST = createRequire(import.meta.url)('../../book_editor/js/spread_templates.js');

export default async function register() {
const line = () => { const out = []; return { out, ok: (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`) }; };

const HOSTILE_NAME = 'x" onerror="window.__pwn=1"<img src=x>.jpg';
const HOSTILE_KEY = `d/${HOSTILE_NAME}`;
const GOOD = layoutV2({
  cover: 'd/COVER.jpg',
  spreads: [
    { template: 'pair-portraits', slots: ['d/IMG_002.jpg', 'd/IMG_003.jpg'] },
    { template: 'one-two-right', mirrored: true, slots: ['d/IMG_004.jpg', 'd/IMG_005.jpg', 'd/MISSING_006.jpg'] },
    { template: 'solo-right', slots: [{ key: 'd/IMG_007.jpg', fit: 'cover', crop: { x: 0.1, y: 0 } }] },
  ],
  back: {},
});
const COPY_GOOD = '封面: COVER.jpg / 第1跨頁: IMG_002.jpg, IMG_003.jpg / 第2跨頁: IMG_004.jpg, IMG_005.jpg, MISSING_006.jpg / 第3跨頁: IMG_007.jpg';
const HOSTILE = layoutV2({
  cover: 'd/COVER.jpg',
  spreads: [
    { template: 'solo-right', slots: [HOSTILE_KEY] },
    { template: 'no-such-template"><img src=x onerror=window.__pwn=2>', slots: ['d/UNK_A.jpg', 'd/UNK_B.jpg'] },
    { template: 'pair-portraits', slots: ['d/ONLY_ONE.jpg'] },
  ],
});
const album = (layout, extra = {}) => ({ kind: 'album', name: '相本書', option_label: '8×8 吋', unit_price: 4200, list_price: 4200, qty: 1, photo_keys: [], layout, ...extra });
const printLine = { kind: 'print', name: '無框畫', unit_price: 900, list_price: 900, qty: 1, photo_keys: ['d/IMG_9.jpg'] };

function fixtures() {
  const o = ordersFake({ products: [], titles: { 'proj-1': '海邊系列' } });
  const guest = (id, items) => o.st.addOrder({ id, source: 'guest', status: 'requested', project_id: 'proj-1', delivery_method: 'pickup', consent_version: 'v1',
    contact: { name: `客人${id}`, phone: '0912-345-678', line: null, erased_at: null }, items });
  guest('v2', [printLine, album(GOOD)]);
  guest('v1', [album({ v: 1, mode: 'photographer', source: 'all_finals', spreads: 12 })]);
  guest('none', [printLine, album(null)]);
  guest('evil', [album(HOSTILE)]);
  guest('bad', [album({ v: 2, mode: 'auto', cover: null, spreads: 'nope', back: null })]);
  return o;
}

// The thumbnail route and the studio-token mint (the viewer's only POST). A key with MISSING in it is a photo that is not in R2.
function photoFake() {
  const st = { imgs: [], mints: [], other: [] };
  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      if (u.pathname === '/api/auth/studio-token') {
        const h = await req.allHeaders();
        st.mints.push({ method: req.method(), auth: h['authorization'] || null });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: 'STUDIO-TOK', expires_at: new Date(Date.now() + 12 * 3600000).toISOString() }) });
      }
      if (u.pathname.startsWith('/api/')) return route.fallback();
      const path = decodeURIComponent(u.pathname);
      st.imgs.push({ method: req.method(), path, search: u.search, t: u.searchParams.get('t'), w: u.searchParams.get('w') });
      if (req.method() !== 'GET') st.other.push(`${req.method()} ${u.pathname}`);
      if (path.includes('MISSING')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found"}' });
      route.fulfill({ status: 200, contentType: 'image/png', body: BIG_PHOTO });
    });
  };
  return { st, attach };
}

// What the open viewer shows, from the DOM.
const viewer = page => page.evaluate(() => {
  const root = document.querySelector('[data-layout-viewer]');
  if (!root) return null;
  const pg = root.querySelector('.alv-page');
  const pr = pg ? pg.getBoundingClientRect() : null;
  const rel = r => ({ x: (r.left - pr.left) / pr.width, y: (r.top - pr.top) / pr.height, w: r.width / pr.width, h: r.height / pr.height, px: r });
  return {
    title: root.querySelector('.alv-title')?.textContent ?? null,
    count: root.querySelector('[data-page-count]')?.textContent ?? null,
    names: [...root.querySelectorAll('[data-alv-names] li')].map(l => l.textContent),
    imgs: [...root.querySelectorAll('.alv-img')].map(i => ({ key: i.dataset.photoKey, src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0,
      r: (() => { const b = i.getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; })(),
      slot: (() => { const b = i.parentElement.getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height, fit: i.parentElement.dataset.fit || 'cover', rel: pr ? rel(b) : null }; })() })),
    missing: [...root.querySelectorAll('[data-missing]')].map(m => m.textContent),
    bad: root.querySelectorAll('.alv-bad').length,
    badText: root.querySelector('.alv-bad')?.textContent ?? null,
    kind: pg?.dataset.kind ?? null,
    prevDisabled: root.querySelector('[data-alv-prev]').disabled, nextDisabled: root.querySelector('[data-alv-next]').disabled,
    focusInside: root.contains(document.activeElement) || document.activeElement === root,
  };
});
const settle = (page, n) => page.waitForFunction(n => {
  const r = document.querySelector('[data-layout-viewer]');
  if (!r) return false;
  const imgs = [...r.querySelectorAll('.alv-img')];
  return imgs.length + r.querySelectorAll('[data-missing]').length >= n && imgs.every(i => i.complete && i.naturalWidth > 0 && i.style.visibility !== 'hidden' || !i.isConnected);
}, n, { timeout: 6000 });
const nextPage = async (page, n) => { await page.click('[data-alv-next]'); await page.waitForTimeout(60); await settle(page, n); };

// ═════════════════════ orders.html, desktop ═════════════════════
{
  const m = dashSettingsMock();
  const o = fixtures();
  const ph = photoFake();
  await suite('order layout view — orders.html：按鈕、翻頁、照片、鏡像、缺圖、複製清單、Esc 與焦點',
    `${base}/orders.html`,
    async page => {
      const { out, ok } = line();
      await page.waitForSelector('.ord-row', { timeout: 5000 });
      const btns = id => page.$$eval(`[data-order-id="${id}"] [data-view-layout]`, b => b.map(x => x.textContent));
      ok('a v2 album line has 查看排版 (exactly one; the print line next to it has none)', (await btns('v2')).join() === '查看排版', JSON.stringify(await btns('v2')));
      const lines = await page.$$eval('[data-order-id="v2"] .gc-item', els => els.map(e => ({ text: e.textContent.replace(/\s+/g, ' '), btn: !!e.querySelector('[data-view-layout]'), sp: e.querySelector('.gc-spreads')?.textContent ?? null })));
      ok('the v2 line reads 「3 跨頁・客人排的版面」; the print line has no spreads text and no button', lines.length === 2 && lines[0].sp === null && !lines[0].btn && lines[1].sp === '3 跨頁・客人排的版面' && lines[1].btn, JSON.stringify(lines));
      ok('a line with no layout: no button, no spreads text (positive control: the v2 order above has both)', (await btns('none')).length === 0 && (await page.$$eval('[data-order-id="none"] .gc-spreads', e => e.length)) === 0);
      const v1 = await page.$$eval('[data-order-id="v1"] .gc-item', els => els.map(e => ({ sp: e.querySelector('.gc-spreads')?.textContent ?? null, btn: !!e.querySelector('[data-view-layout]') })));
      ok('the v1 line is unchanged (「12 跨頁 · 請攝影師排版」) and has no viewer button', v1.length === 1 && v1[0].sp === '12 跨頁 · 請攝影師排版' && !v1[0].btn, JSON.stringify(v1));
      const calls0 = o.st.calls.length;

      await page.focus('[data-order-id="v2"] [data-view-layout]');
      await page.click('[data-order-id="v2"] [data-view-layout]');
      await page.waitForSelector('[data-layout-viewer]');
      await settle(page, 1);
      let v = await viewer(page);
      ok('the cover first: 「封面」, 1 / 5 (cover + 3 spreads + back), one photo, ‹ disabled and › enabled',
        v.title === '封面' && v.count === '1 / 5' && v.imgs.length === 1 && v.imgs[0].key === 'd/COVER.jpg' && v.prevDisabled && !v.nextDisabled && v.kind === 'cover', JSON.stringify(v));
      ok('the viewer is a dialog with the focus inside', await page.$eval('[data-layout-viewer]', r => r.getAttribute('role') === 'dialog' && r.getAttribute('aria-modal') === 'true') && v.focusInside);
      ok('file name list beside the cover: COVER.jpg', v.names.join() === 'COVER.jpg', JSON.stringify(v.names));
      ok('the photo is a thumbnail via the worker: ?w=1200 and the studio token, no original, no download',
        /^https:\/\/imagepicker\.hotichen\.workers\.dev\/d\/COVER\.jpg\?w=1200&t=STUDIO-TOK$/.test(v.imgs[0].src), v.imgs[0].src);
      ok('the cover (fit cover) fills its slot: image box contains the slot box', v.imgs[0].r.l <= v.imgs[0].slot.l + 1 && v.imgs[0].r.t <= v.imgs[0].slot.t + 1 && v.imgs[0].r.l + v.imgs[0].r.w >= v.imgs[0].slot.l + v.imgs[0].slot.w - 1 && v.imgs[0].r.t + v.imgs[0].r.h >= v.imgs[0].slot.t + v.imgs[0].slot.h - 1, JSON.stringify(v.imgs[0]));

      await nextPage(page, 2);
      v = await viewer(page);
      ok('spread 1: title, 2 / 5, its two photos in order, names in order',
        v.title === '第1跨頁' && v.count === '2 / 5' && v.imgs.map(i => i.key).join() === 'd/IMG_002.jpg,d/IMG_003.jpg' && v.names.join() === 'IMG_002.jpg,IMG_003.jpg' && !v.prevDisabled, JSON.stringify(v));
      const t1 = ST.byId('pair-portraits');
      ok('spread 1 geometry is the template\'s (x,y,w,h fractions of the spread)', v.imgs.every((im, i) => ['x', 'y', 'w', 'h'].every(k => Math.abs(im.slot.rel[k] - t1.slots[i][k]) < 0.01)), JSON.stringify(v.imgs.map(i => i.slot.rel)));
      const im0 = v.imgs[0];
      ok('a contain slot shows the WHOLE photo (inside its slot, aspect 1600:1067 kept)', im0.r.l >= im0.slot.l - 1 && im0.r.t >= im0.slot.t - 1 && im0.r.l + im0.r.w <= im0.slot.l + im0.slot.w + 1 && im0.r.t + im0.r.h <= im0.slot.t + im0.slot.h + 1 && Math.abs(im0.r.w / im0.r.h - 1600 / 1067) < 0.02, JSON.stringify(im0));

      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(60);
      await settle(page, 3);
      v = await viewer(page);
      const t2 = ST.byId('one-two-right');
      ok('ArrowRight → spread 2 (mirrored): 3 / 5, three slots drawn, the file names still in template slot order',
        v.title === '第2跨頁' && v.count === '3 / 5' && v.names.join() === 'IMG_004.jpg,IMG_005.jpg,MISSING_006.jpg', JSON.stringify([v.title, v.count, v.names]));
      ok('mirrored: the big slot (template slot 0, normally on the left) is on the right: x = 1-x-w', Math.abs(v.imgs[0].slot.rel.x - (1 - t2.slots[0].x - t2.slots[0].w)) < 0.01 && v.imgs[0].slot.rel.x > 0.5 && t2.slots[0].x < 0.5 && Math.abs(v.imgs[0].slot.rel.w - t2.slots[0].w) < 0.01, JSON.stringify([v.imgs[0].slot.rel, t2.slots[0]]));
      ok('a photo missing in R2: a clear placeholder with its name, and no broken <img> left (positive: the other two loaded)',
        v.missing.length === 1 && v.missing[0].includes('MISSING_006.jpg') && v.missing[0].includes('找不到這張照片') && v.imgs.length === 2 && v.imgs.every(i => i.ok), JSON.stringify([v.missing, v.imgs.length]));
      ok('the missing photo is still in the name list for the print shop', v.names.includes('MISSING_006.jpg'));

      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(60);
      await settle(page, 1);
      v = await viewer(page);
      ok('spread 3 (single, fit cover with a crop): 4 / 5, one photo, the box contains its slot and is shifted by crop.x',
        v.count === '4 / 5' && v.imgs.length === 1 && v.imgs[0].key === 'd/IMG_007.jpg' && v.imgs[0].slot.fit === 'cover' && v.imgs[0].r.t <= v.imgs[0].slot.t + 1 && v.imgs[0].r.t + v.imgs[0].r.h >= v.imgs[0].slot.t + v.imgs[0].slot.h - 1 &&
        v.imgs[0].r.l > (v.imgs[0].slot.l + v.imgs[0].slot.w / 2) - v.imgs[0].r.w / 2 + 1, JSON.stringify(v.imgs[0]));
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(60);
      v = await viewer(page);
      ok('the back: 5 / 5, a blank page with no photo, › disabled, no names but still the empty note', v.count === '5 / 5' && v.title === '封底' && v.imgs.length === 0 && v.nextDisabled && v.names.join() === '（沒有照片）', JSON.stringify(v));
      await page.keyboard.press('ArrowRight');
      ok('ArrowRight on the last page stays', (await viewer(page)).count === '5 / 5');
      await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(60);
      ok('ArrowLeft x3 goes back to spread 1 (2 / 5)', (await viewer(page)).count === '2 / 5');
      await page.click('[data-alv-prev]');
      await page.waitForTimeout(60);
      ok('the ‹ button goes back to the cover', (await viewer(page)).count === '1 / 5');
      ok('scanned a floor of photos across the pages (cover 1 + spread1 2 + spread2 2 loaded + spread3 1 requested)', ph.st.imgs.filter(i => !i.path.includes('MISSING')).length >= 6 && ph.st.imgs.some(i => i.path.includes('MISSING')), JSON.stringify(ph.st.imgs.map(i => i.path)));

      // copy
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.click('[data-alv-copy]');
      await page.waitForFunction(() => /已複製/.test(document.querySelector('.alv-copy-status').textContent), null, { timeout: 3000 });
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      ok('複製排版清單 copies one line per album in reading order', clip === COPY_GOOD, clip);
      ok('the textarea fallback stays hidden when the clipboard worked', await page.$eval('.alv-fallback', t => t.hidden));
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true }));
      await page.click('[data-alv-copy]');
      await page.waitForFunction(() => !document.querySelector('.alv-fallback').hidden, null, { timeout: 3000 });
      const fb = await page.$eval('.alv-fallback', t => ({ v: t.value, sel: t.selectionEnd - t.selectionStart, focused: document.activeElement === t, ro: t.readOnly }));
      ok('clipboard refused → a selectable textarea holds the same text, selected', fb.v === COPY_GOOD && fb.sel === COPY_GOOD.length && fb.focused && fb.ro, JSON.stringify(fb));

      // close: Esc, focus returns to the button; ✕ too
      await page.keyboard.press('Escape');
      await page.waitForTimeout(60);
      ok('Esc closes the viewer and the focus is back on 查看排版', (await viewer(page)) === null && await page.evaluate(() => document.activeElement?.matches('[data-order-id="v2"] [data-view-layout]')));
      await page.click('[data-order-id="v2"] [data-view-layout]');
      await page.waitForSelector('[data-layout-viewer]');
      await page.click('[data-alv-close]');
      await page.waitForTimeout(60);
      ok('✕ closes it and returns the focus to the button too', (await viewer(page)) === null && await page.evaluate(() => document.activeElement?.matches('[data-order-id="v2"] [data-view-layout]') && document.body.style.overflow === ''));
      await page.click('[data-order-id="v2"] [data-view-layout]');
      await page.waitForSelector('[data-layout-viewer]');
      await settle(page, 1);
      ok('opening again starts at the cover (no state kept)', (await viewer(page)).count === '1 / 5');
      await page.keyboard.press('Escape');

      ok('nothing was written: every fake-Worker call is a GET; the only POST anywhere is the studio-token mint (with the Bearer credential), photos are plain GETs',
        o.st.calls.slice(calls0).every(c => c.method === 'GET') && ph.st.other.length === 0 && ph.st.mints.length >= 1 && ph.st.mints.every(x => x.method === 'POST' && x.auth === 'Bearer adm') && ph.st.imgs.every(i => i.w === '1200' && i.t === 'STUDIO-TOK' && !/download/.test(i.search)), JSON.stringify([o.st.calls.slice(calls0).map(c => c.method + c.path), ph.st.other, ph.st.mints]));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); await ph.attach(p); }, initScript: SEED_TOKEN });
}

// ═════════════════════ hostile and malformed layouts ═════════════════════
{
  const m = dashSettingsMock();
  const o = fixtures();
  const ph = photoFake();
  await suite('order layout view — 客人的字串是純文字；未知版型、格數不符、壞掉的排版不會丟錯',
    `${base}/orders.html`,
    async page => {
      const { out, ok } = line();
      await page.waitForSelector('.ord-row', { timeout: 5000 });
      await page.click('[data-order-id="evil"] [data-view-layout]');
      await page.waitForSelector('[data-layout-viewer]');
      await settle(page, 1);
      let v = await viewer(page);
      ok('cover loads (positive control before the hostile page)', v.title === '封面' && v.imgs.length === 1 && v.count === '1 / 4', JSON.stringify(v));
      await nextPage(page, 1);
      v = await viewer(page);
      ok('the hostile key page: 1 img whose data-photo-key is exactly the hostile string, the name list shows it as text',
        v.imgs.length === 1 && v.imgs[0].key === HOSTILE_KEY && v.names.join() === HOSTILE_NAME, JSON.stringify([v.imgs.map(i => i.key), v.names]));
      const probe = await page.evaluate(() => {
        const r = document.querySelector('[data-layout-viewer]');
        return { onerror: r.querySelectorAll('[onerror]').length, imgsAll: r.querySelectorAll('img').length, xsrc: [...r.querySelectorAll('img')].filter(i => i.getAttribute('src') === 'x').length,
          attrs: [...r.querySelectorAll('*')].flatMap(e => [...e.attributes].map(a => a.name)).filter(n => /^on/i.test(n)), pwn: window.__pwn, li: r.querySelector('[data-alv-names] li').children.length };
      });
      ok('no element is built from the key: no on* attribute, exactly the one img, no src="x", the name <li> has no child elements, window.__pwn never set',
        probe.onerror === 0 && probe.imgsAll === 1 && probe.xsrc === 0 && probe.attrs.length === 0 && probe.pwn === undefined && probe.li === 0, JSON.stringify(probe));
      ok('the img src carries the key encoded (no raw quote or < in the URL)', !/["<> ]/.test(v.imgs[0].src) && v.imgs[0].src.includes('onerror%3D'), v.imgs[0].src);
      await nextPage(page, 0);
      v = await viewer(page);
      ok('unknown template id: 「這份排版無法預覽」, no photos drawn, the readable file names are still listed',
        v.title === '第2跨頁' && v.badText === '這份排版無法預覽' && v.imgs.length === 0 && v.names.join() === 'UNK_A.jpg,UNK_B.jpg', JSON.stringify(v));
      await nextPage(page, 0);
      v = await viewer(page);
      ok('wrong slot count (1 photo for a 2-slot template): the same notice and the one readable name', v.badText === '這份排版無法預覽' && v.imgs.length === 0 && v.names.join() === 'ONLY_ONE.jpg', JSON.stringify(v));
      ok('hostile template id never became markup', await page.evaluate(() => window.__pwn === undefined && !document.querySelector('[data-layout-viewer] img[src="x"]')));
      await page.click('[data-alv-copy]').catch(() => {});
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.click('[data-alv-copy]');
      await page.waitForFunction(() => /已複製/.test(document.querySelector('.alv-copy-status').textContent), null, { timeout: 3000 });
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      ok('the copied list has the hostile name literally and the unreadable pages\' names', clip === `封面: COVER.jpg / 第1跨頁: ${HOSTILE_NAME} / 第2跨頁: UNK_A.jpg, UNK_B.jpg / 第3跨頁: ONLY_ONE.jpg`, clip);
      await page.keyboard.press('Escape');

      // a layout that is not even a list of spreads
      await page.click('[data-order-id="bad"] [data-view-layout]');
      await page.waitForSelector('[data-layout-viewer]');
      await page.waitForFunction(() => document.querySelector('[data-layout-viewer] .alv-bad'), null, { timeout: 4000 });
      v = await viewer(page);
      ok('{v:2, spreads:"nope"}: the button is there, the viewer says 這份排版無法預覽 and has no photos or pages (no throw: a page error would fail the suite)',
        v.badText === '這份排版無法預覽' && v.imgs.length === 0 && v.count === '0 / 0' && v.prevDisabled && v.nextDisabled, JSON.stringify(v));
      const lbl = await page.$eval('[data-order-id="bad"] .gc-spreads', e => e.textContent);
      ok('and its line says 客人排的版面 without inventing a count', lbl === '客人排的版面', lbl);
      await page.keyboard.press('Escape');
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); await ph.attach(p); }, initScript: SEED_TOKEN, contextOptions: {} });
}

// ═════════════════════ phone (390px) ═════════════════════
{
  const m = dashSettingsMock();
  const o = fixtures();
  const ph = photoFake();
  await suite('order layout view — 390px 手機：44px 觸控目標、不橫向捲動、滑動翻頁',
    `${base}/orders.html`,
    async page => {
      const { out, ok } = line();
      await page.waitForSelector('.ord-row', { timeout: 5000 });
      const open = await page.$eval('[data-order-id="v2"] [data-view-layout]', b => { const r = b.getBoundingClientRect(); return { w: r.width, h: r.height }; });
      ok('the 查看排版 button is at least 44px high and wide', open.h >= 44 && open.w >= 44, JSON.stringify(open));
      await page.click('[data-order-id="v2"] [data-view-layout]');
      await page.waitForSelector('[data-layout-viewer]');
      await settle(page, 1);
      await nextPage(page, 2);
      const scan = await page.$$eval('[data-layout-viewer] button', bs => bs.filter(b => b.getClientRects().length).map(b => { const r = b.getBoundingClientRect(); return { t: b.textContent, w: Math.round(r.width), h: Math.round(r.height) }; }));
      ok('every visible control in the viewer is >= 44x44 (floor: ✕, ‹, ›, 複製排版清單 = 4)', scan.length >= 4 && scan.every(b => b.w >= 44 && b.h >= 44), JSON.stringify(scan));
      const geo = await page.evaluate(() => {
        const pg = document.querySelector('.alv-page').getBoundingClientRect();
        const side = document.querySelector('.alv-side').getBoundingClientRect();
        return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, pl: pg.left, pr: pg.right, pw: pg.width, ph: pg.height, sideR: side.right, bodyOverflow: document.body.style.overflow,
          alvSw: document.querySelector('.alv-body').scrollWidth, alvCw: document.querySelector('.alv-body').clientWidth };
      });
      ok('no sideways scroll: the page and the viewer body fit 390px, the spread is fully inside the screen and is wide enough to see (>= 300px)',
        geo.sw <= geo.cw && geo.alvSw <= geo.alvCw && geo.pl >= 0 && geo.pr <= 390 && geo.pw >= 300 && geo.sideR <= 390, JSON.stringify(geo));
      ok('page aspect is the spread\'s (420:297)', await page.$eval('.alv-page', p => Math.abs(p.getBoundingClientRect().width / p.getBoundingClientRect().height - 420 / 297) < 0.02));
      await swipeTouch(page, '.alv-stage', 300, 300, 80, 300);
      await page.waitForTimeout(80);
      ok('swipe left → next page (3 / 5)', (await viewer(page)).count === '3 / 5');
      await swipeTouch(page, '.alv-stage', 80, 300, 300, 300);
      await page.waitForTimeout(80);
      ok('swipe right → previous page (2 / 5)', (await viewer(page)).count === '2 / 5');
      await swipeTouch(page, '.alv-stage', 200, 300, 215, 420);
      await page.waitForTimeout(80);
      ok('a mostly-vertical short drag does not flip', (await viewer(page)).count === '2 / 5');
      const cover = await (async () => { await page.click('[data-alv-prev]'); await page.waitForTimeout(60); await settle(page, 1); return page.$eval('.alv-page', p => { const r = p.getBoundingClientRect(); return { w: r.width, h: r.height, l: r.left, r: r.right }; }); })();
      ok('the single-page cover also fits the width (aspect 210:297)', cover.l >= 0 && cover.r <= 390 && Math.abs(cover.w / cover.h - 210 / 297) < 0.02, JSON.stringify(cover));
      await page.keyboard.press('Escape');
      ok('closed, the page scrolls again', await page.evaluate(() => document.body.style.overflow === '' && !document.querySelector('[data-layout-viewer]')));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); await ph.attach(p); }, initScript: SEED_TOKEN, contextOptions: MOBILE });
}

// ═════════════════════ admin project detail ═════════════════════
{
  const m = pickFakeWorker({ projectId: 'proj-1', title: '海邊系列' });
  const o = fixtures();
  const ph = photoFake();
  await suite('order layout view — admin 專案詳情的訂單區也有 查看排版',
    `${base}/admin.html#project=proj-1`,
    async page => {
      const { out, ok } = line();
      await page.waitForSelector('#pd-order-list .ord-card', { timeout: 5000 });
      const n = await page.$$eval('#pd-order-list [data-view-layout]', b => b.length);
      ok('the v2 order, the hostile one and the malformed one each have a button; v1 and no-layout have none (floor: 3)', n === 3, String(n));
      ok('v1 / no-layout cards have no button', (await page.$$('[data-order-id="v1"] [data-view-layout], [data-order-id="none"] [data-view-layout]')).length === 0);
      await page.click('[data-order-id="v2"] [data-view-layout]');
      await page.waitForSelector('[data-layout-viewer]');
      await settle(page, 1);
      let v = await viewer(page);
      ok('opens on the cover with 1 / 5 and the cover photo', v.count === '1 / 5' && v.imgs[0]?.key === 'd/COVER.jpg', JSON.stringify(v));
      await page.click('[data-alv-next]');
      await page.waitForTimeout(60);
      await settle(page, 2);
      v = await viewer(page);
      ok('flips to spread 1 with its two photos', v.count === '2 / 5' && v.imgs.map(i => i.key).join() === 'd/IMG_002.jpg,d/IMG_003.jpg', JSON.stringify(v));
      await page.keyboard.press('Escape');
      ok('Esc closes and the focus returns to the button on this page too', await page.evaluate(() => !document.querySelector('[data-layout-viewer]') && document.activeElement?.matches('[data-order-id="v2"] [data-view-layout]')));
      ok('the other controls of the card still work: the status buttons are there and nothing was posted', (await page.$$('[data-order-id="v2"] [data-status-to]')).length === 2 && !o.st.calls.some(c => c.method !== 'GET'), JSON.stringify(o.st.calls.map(c => c.method + c.path)));
      return out;
    },
    { before: async p => { ADMIN_PICKS(m); await m.attach(p); await o.attach(p); await ph.attach(p); }, initScript: ADMIN });
}
}
