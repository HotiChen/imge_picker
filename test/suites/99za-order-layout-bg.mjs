// Browser suites: the whole-book background colour of a guest's album layout (docs/guest-shop.md, "S3 第一步 — 換版型（同張數）、
// 整本底色"): Layout JSON v2 `background: {type:'color', value:<id>}`. The photographer's viewer (js/album-layout-view.js) draws it
// behind the photos on the cover, every spread and the back, and says 「底色：奶油」 in the side panel; 匯入 book editor writes it as
// `bg` on every page (book_editor/js/import_layout.js) and the real editor page shows it. Garbage / type 'image' / unknown id =
// white, nothing injected. The id -> hex table is ImportLayout.BACKGROUND_COLORS (the single copy). Node tests: the end of
// test/unit/album-layout-view.test.mjs and test/unit/import-layout.test.mjs. Chromium only; a real phone still has to look at it.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE, BIG_PHOTO } from '../lib/env.mjs';
import { dashSettingsMock } from '../lib/dashboard-mocks.mjs';
import { ordersFake, layoutV2 } from '../lib/orders-fake.mjs';
import { booksFake } from '../lib/books-fake.mjs';

export default async function register() {
const line = () => { const out = []; return { out, ok: (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`) }; };

const NINE = { white: ['#ffffff', 'rgb(255, 255, 255)', '白'], cream: ['#fff8ee', 'rgb(255, 248, 238)', '奶油'], butter: ['#fff4cc', 'rgb(255, 244, 204)', '奶黃'],
  blush: ['#fde8ec', 'rgb(253, 232, 236)', '粉'], peach: ['#ffe5d4', 'rgb(255, 229, 212)', '蜜桃'], mint: ['#e3f4e8', 'rgb(227, 244, 232)', '薄荷'],
  sky: ['#e1effb', 'rgb(225, 239, 251)', '天空'], lavender: ['#eee8fa', 'rgb(238, 232, 250)', '薰衣草'], gray: ['#eeeeee', 'rgb(238, 238, 238)', '灰'] };
const WHITE_RGB = 'rgb(255, 255, 255)';
const base2 = () => layoutV2({
  cover: 'd/COVER.jpg',
  spreads: [{ template: 'pair-portraits', slots: ['d/IMG_002.jpg', 'd/IMG_003.jpg'] }, { template: 'solo-right', slots: ['d/IMG_004.jpg'] }],
  back: {},
});
const withBg = bg => (bg === undefined ? base2() : { ...base2(), background: bg });
const HOSTILE = [
  ['image', { type: 'image', value: 'cream' }], ['unknown-id', { type: 'color', value: 'red' }], ['hex', { type: 'color', value: '#ff0000' }],
  ['css', { type: 'color', value: 'red;background:url(javascript:window.__pwn=1)' }], ['proto', { type: 'color', value: '__proto__' }],
  ['markup', { type: 'color', value: '"><img src=x onerror=window.__pwn=2>' }], ['string', '"><img src=x onerror=window.__pwn=3>'], ['array', []],
];
const album = layout => ({ kind: 'album', name: '相本書', option_label: '8×8 吋', unit_price: 4200, list_price: 4200, qty: 1, photo_keys: [], layout });

function fixtures() {
  const o = ordersFake({ products: [], titles: { 'proj-1': '海邊系列' } });
  const guest = (id, layout, name = `客人${id}`) => o.st.addOrder({ id, source: 'guest', status: 'requested', project_id: 'proj-1', delivery_method: 'pickup', consent_version: 'v1',
    contact: { name, phone: '0912-345-678', line: null, erased_at: null }, items: [album(layout)] });
  for (const id of Object.keys(NINE)) guest(`c-${id}`, withBg({ type: 'color', value: id }));
  guest('none', withBg(undefined));
  guest('null', withBg(null));
  HOSTILE.forEach(([k, bg]) => guest(`h-${k}`, withBg(bg)));
  guest('cream', withBg({ type: 'color', value: 'cream' }), '王小明');
  return o;
}
function photoFake() {
  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const u = new URL(route.request().url());
      if (u.pathname === '/api/auth/studio-token') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: 'STUDIO-TOK', expires_at: new Date(Date.now() + 12 * 3600000).toISOString() }) });
      if (u.pathname.startsWith('/api/')) return route.fallback();
      route.fulfill({ status: 200, contentType: 'image/png', body: BIG_PHOTO });
    });
  };
  return { attach };
}
const init = () => {
  try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) { /* ignore */ }
  if (!location.pathname.endsWith('/home.html') && !sessionStorage.getItem('__seeded')) { sessionStorage.setItem('studio_token', 'adm'); sessionStorage.setItem('__seeded', '1'); }
};
const wiring = (m, o, ph, b) => async page => {
  await b.attach(page.context());
  await m.attach(page); await o.attach(page); await ph.attach(page);
  await b.attach(page, { images: false });
};
const open = async (page, id) => {
  await page.waitForSelector('.ord-row', { timeout: 5000 });
  await page.click(`[data-order-id="${id}"] [data-view-layout]`);
  await page.waitForSelector('[data-layout-viewer]');
  await page.waitForFunction(() => document.querySelector('.alv-page') && document.querySelector('[data-page-count]').textContent.endsWith('/ 4'), null, { timeout: 5000 });
};
const close = async page => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('[data-layout-viewer]')); };
// each page's frame colour (cover, spread 1, spread 2, back), the side label, and what could have been injected
const pagesColours = async page => {
  const out = [];
  for (let i = 0; i < 4; i++) {
    if (i) { await page.click('[data-alv-next]'); await page.waitForFunction(n => document.querySelector('[data-page-count]').textContent.startsWith(`${n} /`), i + 1); }
    out.push(await page.$eval('.alv-page', f => { const s = getComputedStyle(f); return { kind: f.dataset.kind, bg: s.backgroundColor, img: s.backgroundImage }; }));
  }
  return out;
};
const side = page => page.evaluate(() => {
  const r = document.querySelector('[data-layout-viewer]');
  const l = r.querySelector('[data-alv-bg]');
  return { text: l ? l.textContent : null, shown: !!l && !l.hidden && getComputedStyle(l).display !== 'none' && l.getClientRects().length > 0,
    pwn: window.__pwn ?? null, onerror: r.querySelectorAll('[onerror]').length, imgs: r.querySelectorAll('.alv-page img[onerror], .alv-page [style*="javascript"]').length };
});

{
  const m = dashSettingsMock(), o = fixtures(), ph = photoFake(), b = booksFake();
  await suite('order layout bg — 檢視器：九個底色 id 的封面、跨頁、封底都畫對的顏色，側欄寫「底色：名稱」',
    `${base}/orders.html`, async page => {
      const { out, ok } = line();
      let n = 0;
      for (const [id, [, rgb, zh]] of Object.entries(NINE)) {
        await open(page, `c-${id}`);
        const cs = await pagesColours(page);
        ok(`${id}: cover, both spreads and the back are ${rgb}`, cs.map(c => c.kind).join() === 'cover,spread,spread,back' && cs.every(c => c.bg === rgb && c.img === 'none'), JSON.stringify(cs));
        const sd = await side(page);
        ok(`${id}: the side panel says 底色：${zh}`, sd.text === `底色：${zh}` && sd.shown, JSON.stringify(sd));
        await close(page);
        n++;
      }
      ok('scanned all nine ids (a floor, so an empty loop cannot pass)', n === 9, String(n));
      return out;
    }, { before: wiring(m, o, ph, b), initScript: init });
}

{
  const m = dashSettingsMock(), o = fixtures(), ph = photoFake(), b = booksFake();
  await suite('order layout bg — 沒有底色、null、type image、亂寫的值：白色、側欄沒有底色那行、沒有任何東西被注入',
    `${base}/orders.html`, async page => {
      const { out, ok } = line();
      await page.waitForSelector('.ord-row', { timeout: 5000 });
      // positive control: a coloured one is NOT white and has the label
      await open(page, 'c-cream');
      const pos = await pagesColours(page);
      ok('positive control: cream really is not white and shows the label', pos.every(c => c.bg !== WHITE_RGB) && (await side(page)).shown);
      await close(page);
      const ids = ['none', 'null', ...HOSTILE.map(([k]) => `h-${k}`)];
      let n = 0;
      for (const id of ids) {
        await open(page, id);
        const cs = await pagesColours(page);
        const sd = await side(page);
        ok(`${id}: all four pages white`, cs.length === 4 && cs.every(c => c.bg === WHITE_RGB && c.img === 'none'), JSON.stringify(cs));
        ok(`${id}: no label, nothing injected, nothing ran`, !sd.shown && !(sd.text || '') && sd.pwn === null && sd.onerror === 0 && sd.imgs === 0, JSON.stringify(sd));
        await close(page);
        n++;
      }
      ok('scanned 10 layouts', n === 10, String(n));
      return out;
    }, { before: wiring(m, o, ph, b), initScript: init });
}

{
  const m = dashSettingsMock(), o = fixtures(), ph = photoFake(), b = booksFake();
  await suite('order layout bg — contain 的照片留白處露出底色（照片、格子本身不上色）；複製排版清單不變；390px 不橫向溢出',
    `${base}/orders.html`, async page => {
      const { out, ok } = line();
      await open(page, 'cream');
      await page.click('[data-alv-next]');
      await page.waitForFunction(() => document.querySelectorAll('.alv-img').length === 2 && [...document.querySelectorAll('.alv-img')].every(i => i.complete && i.naturalWidth > 0 && i.style.visibility !== 'hidden'), null, { timeout: 6000 });
      const r = await page.evaluate(() => {
        return [...document.querySelectorAll('.alv-slot')].map(s => {
          const i = s.querySelector('.alv-img'), sb = s.getBoundingClientRect(), ib = i.getBoundingClientRect();
          // a point in the slot but outside the photo (the letterbox), if there is one; the element there must be page-coloured
          const gap = Math.max(sb.width - ib.width, sb.height - ib.height);
          return { fit: s.dataset.fit || 'cover', slotBg: getComputedStyle(s).backgroundColor, imgBg: getComputedStyle(i).backgroundColor, gap };
        });
      });
      ok('two contain slots drawn; neither the slot nor the photo has its own fill', r.length === 2 && r.every(x => x.fit === 'contain' && x.slotBg === 'rgba(0, 0, 0, 0)' && x.imgBg === 'rgba(0, 0, 0, 0)'), JSON.stringify(r));
      ok('and at least one of them has a letterbox (the test photo is not the slot\'s shape), so the page colour shows there', r.some(x => x.gap > 2), JSON.stringify(r));
      const pgBg = await page.$eval('.alv-page', f => getComputedStyle(f).backgroundColor);
      ok('the frame behind them is cream', pgBg === NINE.cream[1], pgBg);

      await page.click('[data-alv-copy]');
      await page.waitForFunction(() => document.querySelector('.alv-copy-status').textContent !== '' || !document.querySelector('.alv-fallback').hidden, null, { timeout: 3000 });
      const txt = await page.$eval('.alv-fallback', t => t.hidden ? null : t.value).catch(() => null);
      if (txt !== null) ok('複製排版清單 unchanged (no 底色 in it)', txt === '封面: COVER.jpg / 第1跨頁: IMG_002.jpg, IMG_003.jpg / 第2跨頁: IMG_004.jpg' && !/底色/.test(txt), txt);
      else ok('複製排版清單 copied (clipboard path); the side label is not part of the names list', !(await page.$eval('[data-alv-names]', e => /底色/.test(e.textContent))));
      return out;
    }, { before: wiring(m, o, ph, b), initScript: init });
}

{
  const m = dashSettingsMock(), o = fixtures(), ph = photoFake(), b = booksFake();
  await suite('order layout bg — 390px 手機：側欄的底色行看得到、頁面不橫向溢出',
    `${base}/orders.html`, async page => {
      const { out, ok } = line();
      await open(page, 'cream');
      const r = await page.evaluate(() => {
        const l = document.querySelector('[data-alv-bg]');
        l.scrollIntoView();
        const q = l.getBoundingClientRect();
        return { text: l.textContent, left: q.left, right: q.right, h: q.height, vw: innerWidth, sw: document.documentElement.scrollWidth, rootSw: document.querySelector('[data-layout-viewer]').scrollWidth, rootCw: document.querySelector('[data-layout-viewer]').clientWidth };
      });
      ok('the 底色 line is visible and inside the 390px viewport', r.text === '底色：奶油' && r.h > 0 && r.left >= 0 && r.right <= r.vw, JSON.stringify(r));
      ok('no horizontal scroll (page or viewer)', r.sw <= r.vw && r.rootSw <= r.rootCw, JSON.stringify(r));
      return out;
    }, { before: wiring(m, o, ph, b), initScript: init, contextOptions: MOBILE });
}

// ═════════════ 匯入 book editor: bg on every page, and the real editor shows it ═════════════
{
  const m = dashSettingsMock(), o = fixtures(), ph = photoFake(), b = booksFake();
  await suite('order layout bg — 匯入：每一頁的 bg 是該色，真正的 book editor 的頁面畫布就是那個顏色（封面、跨頁、封底）',
    `${base}/orders.html`, async page => {
      const { out, ok } = line();
      const ctx = page.context();
      page.on('dialog', d => d.accept());
      await open(page, 'c-lavender');
      const [tab] = await Promise.all([ctx.waitForEvent('page'), page.click('[data-alv-import]')]);
      await page.waitForFunction(() => document.querySelector('[data-alv-import-link]'), null, { timeout: 5000 });
      const book = JSON.parse(b.st.puts[0].text);   // the first PUT of the run is the import itself
      ok('every page of the PUT book (cover, 2 inner, back-cover) has bg #eee8fa', book.pages.length === 4 && book.pages.every(p => p.bg === '#eee8fa'), JSON.stringify(book.pages.map(p => p.bg)));
      await tab.waitForSelector('.page-thumb', { timeout: 10000 });
      const seen = [];
      for (const idx of [0, 1, 2, 3]) {
        await tab.click(`.page-thumb[data-page-idx="${idx}"]`);
        await tab.waitForFunction(i => window.bookEditor.currentPageIndex === i && document.querySelector('.page-canvas'), idx, { timeout: 5000 });
        seen.push(await tab.$eval('.page-canvas', c => getComputedStyle(c).backgroundColor));
      }
      ok('the editor\'s page canvas is rgb(238, 232, 250) on all four pages', seen.length === 4 && seen.every(c => c === 'rgb(238, 232, 250)'), JSON.stringify(seen));
      await tab.close();

      // no background: the book is exactly as before (white pages), and the canvas is white
      await close(page);
      await open(page, 'none');
      const [tab2] = await Promise.all([ctx.waitForEvent('page'), page.click('[data-alv-import]')]);
      await page.waitForFunction(() => document.querySelector('[data-alv-import-link]'), null, { timeout: 5000 });
      const id2 = new URL(await page.$eval('[data-alv-import-link]', a => a.href)).searchParams.get('id');
      const plain = JSON.parse(b.st.puts.find(p => p.id === id2).text);
      ok('positive control: the second import PUT exists and a layout without background gives bg #ffffff on every page', plain.pages.length === 4 && plain.pages.every(p => p.bg === '#ffffff'), JSON.stringify(plain.pages.map(p => p.bg)));
      await tab2.waitForSelector('.page-thumb', { timeout: 10000 });
      await tab2.waitForSelector('.page-canvas');
      ok('and its canvas is white', (await tab2.$eval('.page-canvas', c => getComputedStyle(c).backgroundColor)) === WHITE_RGB);
      await tab2.close();
      return out;
    }, { before: wiring(m, o, ph, b), initScript: init });
}

{
  const m = dashSettingsMock(), o = fixtures(), ph = photoFake(), b = booksFake();
  await suite('order layout bg — 匯入亂寫的底色：一律白色、不報錯、書裡沒有亂寫的字串',
    `${base}/orders.html`, async page => {
      const { out, ok } = line();
      page.on('dialog', d => d.accept());
      let n = 0;
      for (const [k] of HOSTILE) {
        await open(page, `h-${k}`);
        await page.click('[data-alv-import]');
        await page.waitForFunction(c => document.querySelector('[data-alv-import-link]') && c, true, { timeout: 5000 });
        const bookId = new URL(await page.$eval('[data-alv-import-link]', a => a.href)).searchParams.get('id');
        const put = b.st.puts.find(p => p.id === bookId);     // the opened editor tabs may save too: pick THIS import's PUT
        const book = JSON.parse(put.text);
        ok(`${k}: imported, every page white, nothing of the garbage in the book text`, book.pages.length === 4 && book.pages.every(p => p.bg === '#ffffff') && !/javascript|onerror|__proto__|ff0000/.test(put.text), JSON.stringify(book.pages.map(p => p.bg)));
        n++;
        await close(page);
      }
      ok('imported 8 hostile layouts', n === 8, String(n));
      return out;
    }, { before: wiring(m, o, ph, b), initScript: init });
}
}
