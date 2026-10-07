// Browser suites: the 完成頁 (docs/delivery.md, client confirmation): a delivered project the client has
// CONFIRMED shows a separate, light-themed page at the same URL (?t=<share token>) — hero, gallery, 下載全部精修,
// 商品／加購 (GET /api/pick/shop), the album preview with the product's spread bounds, share + contact footer.
// The unconfirmed delivered page (the 驗收頁 with the 確認完成 bar) is asserted unchanged.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { donePosts } from '../lib/delivery-helpers.mjs';
import { ALB_DESK, albKeys, albReady, albumWorld } from '../lib/album-world.mjs';
import { SHOP_ALBUM_FAKE, SHOP_PRINT_FAKE, shopProductsFake } from '../lib/pick-fake.mjs';

export default async function register() {

const WORKER = 'https://imagepicker.hotichen.workers.dev';
const T0 = '2026-09-21T03:00:00.000Z';                       // 2026/9/21 in Asia/Taipei
const STUDIO = { name: '光影工作室', booking_url: 'https://studio.example/book', has_logo: true };
const OWNER = "localStorage.setItem('pick_key:TOK', 'ZOE-KEY');";
const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);

// The album world (SVG photos, the real planner) with a confirmed, delivered project, a studio and a shop.
const world = (o = {}) => albumWorld({
  n: o.n ?? 12, sub: o.sub ?? 0,
  fake: { title: '婚禮精修', confirmedAt: T0, studio: STUDIO, shopProducts: shopProductsFake(), ...(o.fake || {}) },
});
// wait until the completion page is up with its gallery rows (n photos)
const cpReady = async (page, n = 12) => {
  await page.waitForSelector('#completionPage', { timeout: 5000 });
  await page.waitForFunction(k => document.querySelectorAll('#completionPage .fg-tile').length === k, n, { timeout: 5000 });
};
// what a person would see of the page chrome: gone (not in the DOM) or display:none
const CHROME_SELECTORS = ['header.header', '#deliveryBar', '#deliveryDone', '#pickBanner', 'main.main-content', 'aside.sidebar', '#mobileActionBar', 'footer.app-footer'];
const chromeLook = page => page.evaluate(sels => sels.map(s => {
  const e = document.querySelector(s);
  return { s, inDom: !!e, display: e ? getComputedStyle(e).display : null, w: e ? e.getBoundingClientRect().width : 0 };
}), CHROME_SELECTORS);
const chromeGone = looks => looks.every(l => !l.inDom || (l.display === 'none' && l.w === 0));
const lumOf = `(c => { const m = c.match(/[\\d.]+/g).map(Number); const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); })`;

// In-page: every visible text element under #completionPage with its contrast ratio against the real backdrop
// (alpha layers and ancestor opacity composited) and its font size.
const TEXT_SCAN = `(() => {
  const parse = s => { const m = /rgba?\\(([^)]+)\\)/.exec(s || ''); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (f, b) => ({ r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a), a: 1 });
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const shown = el => { if (!el.getClientRects().length) return false; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') return false; } const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const backdrop = el => { const layers = []; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; } } let base = { r: 255, g: 255, b: 255, a: 1 }; for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base); return base; };
  const opacityOf = el => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o; };
  const out = [];
  for (const el of document.querySelectorAll('#completionPage *')) {
    if (!shown(el)) continue;
    const own = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const cs = getComputedStyle(el);
    const fg0 = parse(cs.color) || { r: 0, g: 0, b: 0, a: 1 };
    const fg = over({ ...fg0, a: fg0.a * opacityOf(el) }, backdrop(el));
    out.push({ el: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 2).map(c => '.' + c).join(''), ratio: ratio(fg, backdrop(el)), size: parseFloat(cs.fontSize), text: el.textContent.trim().slice(0, 24) });
  }
  return out;
})()`;

// ── 1. the unconfirmed delivered page is exactly what it was
for (const [who, init, co] of [['owner 1280px', OWNER, ALB_DESK], ['viewer 390px', '', MOBILE]]) {
  const w = world({ fake: { confirmedAt: null } });
  await suite(`completion page — delivered but NOT confirmed (${who}): the 驗收頁 is unchanged, no completion page, no shop read`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('.fg-tile', { timeout: 5000 });
      await page.waitForSelector('#deliveryDone', { timeout: 5000 });
      const owner = who.startsWith('owner');
      const s = await page.evaluate(`(() => { const L = ${lumOf}; return {
        cp: !!document.getElementById('completionPage'), on: document.documentElement.classList.contains('cp-on'),
        confirm: !!document.getElementById('doneConfirmBtn'), revise: !!document.getElementById('doneReviseBtn'),
        confirmDisp: document.getElementById('doneConfirmBtn') ? getComputedStyle(document.getElementById('doneConfirmBtn')).display : null,
        state: document.getElementById('deliveryDone').dataset.state,
        hero: !!document.getElementById('fgHero'), body: L(getComputedStyle(document.body).backgroundColor),
        header: getComputedStyle(document.querySelector('header.header')).display,
        shopBox: !!document.getElementById('cpShop'), root: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() }; })()`);
      ok('no completion page root, no cp-on class, no shop section', !s.cp && !s.on && !s.shopBox, JSON.stringify(s));
      ok('positive: the 驗收頁 is up — state open, the gallery hero is there', s.state === 'open' && s.hero, JSON.stringify(s));
      ok(owner ? 'positive: 確認完成 and 需要修改 are in the DOM and displayed' : 'a viewer has the status line and no buttons',
        owner ? s.confirm && s.revise && s.confirmDisp !== 'none' : !s.confirm && !s.revise, JSON.stringify(s));
      ok('still the dark client page (body dark, header shown, global --bg untouched)', s.body < 0.2 && s.header !== 'none' && s.root === '#15120d', JSON.stringify(s));
      await page.waitForTimeout(300);
      ok('no GET /api/pick/shop was made (the shop is read for the completion page only)', !w.m.requests.some(r => r.path === '/api/pick/shop'), JSON.stringify(w.m.requests.map(r => r.path)));
      return out;
    },
    { before: w.before, initScript: init, contextOptions: co });
}

{
  const w = world({ fake: { deliveredAt: null, phase: 'retouching', finalFolders: ['shoot/精修/'] } });   // a confirmation stamp left on an undelivered project
  await suite('completion page — undelivered (finals kept, confirmation stamp left): never shown, picking page as before',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('fixture: the guard under test runs — the row still carries both final_folders and a confirmation', w.m.state.project.final_folders !== null && w.m.state.project.client_confirmed_at === T0);
      ok('positive: the picking page is really up (hearts, filter bar)', (await page.$$('.pick-heart-btn')).length > 0 && (await page.$('#pickFilterBar')) !== null);
      ok('no completion page, no cp-on', (await page.$('#completionPage')) === null && !(await page.evaluate(() => document.documentElement.classList.contains('cp-on'))));
      ok('no shop read', !w.m.requests.some(r => r.path === '/api/pick/shop'));
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}

// ── 2. confirmed: the completion page, owner and viewer, phone and desktop
for (const [who, init, co] of [['owner 390px', OWNER, MOBILE], ['viewer 390px', '', MOBILE], ['owner 1280px', OWNER, ALB_DESK], ['viewer 1280px', '', ALB_DESK]]) {
  const w = world();
  await suite(`completion page — confirmed (${who}): the page replaces the 驗收頁; the dark chrome is gone; hero, gallery, studio, date`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await cpReady(page);
      await page.waitForSelector('#cpShop', { timeout: 5000 });
      const chrome = await chromeLook(page);
      ok('the dark chrome (header, sidebar, delivery bar / status block, banner, mobile bar, app footer) is gone or display:none with no box', chromeGone(chrome), JSON.stringify(chrome));
      ok('positive: the page itself is there and shown', await page.evaluate(() => { const e = document.getElementById('completionPage'); return getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().height > 400; }));
      ok('the cp-on class is on <html>', await page.evaluate(() => document.documentElement.classList.contains('cp-on')));
      ok('確認完成 / 需要修改 and the status block are absent for the owner too', (await page.$('#doneConfirmBtn')) === null && (await page.$('#doneReviseBtn')) === null && (await page.$('#deliveryDone')) === null && (await page.$('#doneConfirmModal')) === null);
      ok('the gallery\'s own dark hero is not on this page', (await page.$('#fgHero')) === null && (await page.$('.fg-hero')) === null);
      const d = await page.evaluate(() => {
        const t = id => document.getElementById(id)?.textContent ?? null;
        const cover = document.getElementById('cpCover');
        const logo = document.querySelector('#cpStudio .cp-studio-logo');
        return { title: t('cpTitle'), studio: document.querySelector('#cpStudio .cp-studio-name')?.textContent ?? null, thanks: t('cpThanks'), confirmed: t('cpConfirmed'),
          cover: cover ? cover.src : null, logo: logo ? logo.src : null, count: t('cpCount'),
          tiles: document.querySelectorAll('#completionPage .fg-tile').length, inGallery: !!document.querySelector('#cpGalleryHost #finalsGallery'),
          h1: document.querySelectorAll('#completionPage h1').length };
      });
      ok('the title is the project title (one h1)', d.title === '婚禮精修' && d.h1 === 1, JSON.stringify(d));
      ok('studio name, and the logo through the existing logo URL', d.studio === '光影工作室' && d.logo === `${WORKER}/api/studio/logo`, JSON.stringify(d));
      ok('a one-line thank-you', typeof d.thanks === 'string' && d.thanks.length >= 6, JSON.stringify(d));
      ok('已確認完成（2026/9/21）', d.confirmed === '已確認完成（2026/9/21）', JSON.stringify(d));
      const cu = new URL(d.cover);
      ok('the hero is the first final, from a ?w= bucket (never the original), with the link token',
        decodeURIComponent(cu.pathname.slice(1)) === 'shoot/精修/IMG_0001.jpg' && ['400', '1200', '1600'].includes(cu.searchParams.get('w')) && cu.searchParams.get('t') === 'TOK', d.cover);
      ok('the hero image really loaded and is large (not a thumbnail box)', await page.evaluate(() => { const i = document.getElementById('cpCover'); return i.complete && i.naturalWidth > 0 && i.getBoundingClientRect().width > 300; }));
      ok('gallery: the justified rows are inside the page (one tile per final)', d.tiles === 12 && d.inGallery, JSON.stringify(d));
      ok('the photo count line', /12/.test(d.count || ''), JSON.stringify(d));
      const g = await page.evaluate(() => { const rows = [...document.querySelectorAll('#completionPage .fg-row')]; return { rows: rows.length, sw: document.documentElement.scrollWidth, iw: innerWidth }; });
      ok('rows exist (floor) and there is no horizontal scroll', g.rows >= 2 && g.sw <= g.iw, JSON.stringify(g));
      const own = who.startsWith('owner');
      ok('the seat holder and a viewer see the same page (the fixture asks as ' + (own ? 'owner' : 'viewer') + ')',
        w.m.requests.some(r => r.path === '/api/pick/state' && (own ? r.key === 'ZOE-KEY' : r.key === '')));
      return out;
    },
    { before: w.before, initScript: init, contextOptions: co });
}

// ── 3. light theme: tokens, backdrop, contrast, readable type, tap targets, composed desktop width
for (const [label, co] of [['390px', MOBILE], ['1280px', ALB_DESK]]) {
  const w = world({ fake: { shopProducts: shopProductsFake() } });
  await suite(`completion page — light theme at ${label}: cream backdrop, text contrast >= 4.5 on a scanned set, type >= 14px, taps >= 44px, no overflow`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await cpReady(page);
      await page.waitForSelector('#cpShop', { timeout: 5000 });
      await page.waitForTimeout(300);
      const s = await page.evaluate(`(() => { const L = ${lumOf}; const cs = e => getComputedStyle(e); const cp = document.getElementById('completionPage');
        return { cp: L(cs(cp).backgroundColor), cpRaw: cs(cp).backgroundColor, body: L(cs(document.body).backgroundColor), html: L(cs(document.documentElement).backgroundColor),
          rootBg: cs(document.documentElement).getPropertyValue('--bg').trim(), rootInk: cs(document.documentElement).getPropertyValue('--ink').trim(),
          cpBgVar: cs(cp).getPropertyValue('--cp-bg').trim(), serif: cs(document.getElementById('cpTitle')).fontFamily,
          sw: document.documentElement.scrollWidth, iw: innerWidth }; })()`);
      ok('the completion root is light (relative luminance >= 0.85) and so are <html> and <body> behind it', s.cp >= 0.85 && s.body >= 0.85 && s.html >= 0.85, JSON.stringify(s));
      ok('its tokens are its own: --cp-bg is the cream of home.html and the global :root is still the dark client theme', s.cpBgVar === '#fff8ee' && s.rootBg === '#15120d' && s.rootInk === '#f1ead8', JSON.stringify(s));
      ok('the title uses the site\'s serif display face', /Noto Serif TC/.test(s.serif), s.serif);
      const scan = await page.evaluate(TEXT_SCAN);
      const low = scan.filter(x => x.ratio < 4.5);
      ok(`contrast: every one of the ${scan.length} scanned text elements is >= 4.5 (floor: at least 20 scanned)`, scan.length >= 20 && low.length === 0, JSON.stringify(low.slice(0, 5)) + ' n=' + scan.length);
      const small = scan.filter(x => x.size < 14);
      ok('type: nothing under 14px', small.length === 0, JSON.stringify(small.slice(0, 5)));
      const taps = await page.evaluate(() => [...document.querySelectorAll('#completionPage button, #completionPage a[href]')].filter(e => e.getClientRects().length).map(e => ({ el: e.id || e.className, h: e.getBoundingClientRect().height })));
      ok(`tap targets: all ${taps.length} buttons / links are >= 44px tall (floor: at least 5, the tiles included)`, taps.length >= 5 && taps.every(t => t.h >= 43.5), JSON.stringify(taps.filter(t => t.h < 43.5)));
      ok('no horizontal scroll', s.sw <= s.iw, JSON.stringify(s));
      if (label === '1280px') {
        const m = await page.evaluate(() => { const r = document.querySelector('#completionPage .cp-wrap').getBoundingClientRect(); return { w: r.width, l: r.left, r: document.documentElement.clientWidth - r.right }; });
        ok('desktop: content is centred and at most 1200px wide', m.w <= 1200.5 && m.w >= 900 && Math.abs(m.l - m.r) <= 2, JSON.stringify(m));
      }
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: co });
}

// ── 4. pressing 確認完成 switches the page in place
{
  const w = world({ fake: { confirmedAt: null } });
  await suite('completion page — the owner presses 確認完成: the page switches in place (no reload) to the completion page',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('#doneConfirmBtn', { timeout: 5000 });
      await page.waitForSelector('.fg-tile', { timeout: 5000 });
      ok('before: the 驗收頁 (no completion page)', (await page.$('#completionPage')) === null && (await page.$('#fgHero')) !== null);
      await page.evaluate(() => { window.__marker = 'same-document'; window.scrollTo(0, 400); });
      await page.click('#doneConfirmBtn');
      await page.click('#doneConfirmSubmit');
      await cpReady(page);
      ok('the completion page is up with the confirmation date from the Worker', await page.evaluate(() => /^已確認完成（\d{4}\/\d{1,2}\/\d{1,2}）$/.test(document.getElementById('cpConfirmed').textContent)));
      ok('it was one confirm POST, and the document was not reloaded', donePosts(w.m, 'confirm').length === 1 && await page.evaluate(() => window.__marker) === 'same-document');
      const chrome = await chromeLook(page);
      ok('the dark chrome is gone, 確認完成 is gone, the done modal is gone', chromeGone(chrome) && (await page.$('#doneConfirmBtn')) === null && (await page.$('#doneConfirmModal')) === null, JSON.stringify(chrome));
      ok('the old gallery hero is gone and the rows are re-rendered inside the completion page (all 12)', (await page.$('#fgHero')) === null && await page.evaluate(() => document.querySelectorAll('#completionPage .fg-tile').length) === 12);
      ok('scrolled back to the top', await page.evaluate(() => window.scrollY) < 5);
      await page.waitForSelector('#cpShop', { timeout: 5000 });
      ok('the shop was read once, with the link token', w.m.requests.filter(r => r.path === '/api/pick/shop').length === 1 && w.m.requests.find(r => r.path === '/api/pick/shop').t === 'TOK');
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}
{
  const w = world({ fake: { confirmedAt: null, failNextPick: [{ status: 500, body: { error: '暫時無法處理', code: 'unavailable' } }] } });
  await suite('completion page — a failed 確認完成 keeps the 驗收頁 (nothing switches)',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('#doneConfirmBtn', { timeout: 5000 });
      await page.click('#doneConfirmBtn');
      await page.click('#doneConfirmSubmit');
      await page.waitForFunction(() => document.getElementById('doneConfirmErr')?.textContent.trim().length > 0, null, { timeout: 5000 });
      ok('positive: the modal shows the error', (await page.textContent('#doneConfirmErr')).length > 0);
      ok('no completion page, still the dark page with its 確認完成 button', (await page.$('#completionPage')) === null && (await page.$('#doneConfirmBtn')) !== null && !(await page.evaluate(() => document.documentElement.classList.contains('cp-on'))));
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}
{
  const w = world({ fake: { confirmedAt: null } });
  await suite('completion page — the photographer confirmed meanwhile (stamp there when the guard reads): the page still switches, no POST',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('#doneConfirmBtn', { timeout: 5000 });
      w.m.state.project.client_confirmed_at = T0;
      w.m.state.project.client_confirmed_by = 'photographer';
      await page.click('#doneConfirmBtn');
      await page.click('#doneConfirmSubmit');
      await cpReady(page);
      ok('the completion page is up with the stamp that was already there', await page.evaluate(() => document.getElementById('cpConfirmed').textContent) === '已確認完成（2026/9/21）');
      ok('the 驗收頁 is gone, and nothing was posted (the guard saw it)', (await page.$('#deliveryDone')) === null && (await page.$('#doneConfirmBtn')) === null && donePosts(w.m, 'confirm').length === 0);
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}
{
  const queue = [];
  const w = world({ fake: { confirmedAt: null, failNextPick: queue } });
  queue.push({ status: 409, body: { error: '已確認完成，無法再要求修改', code: 'already_confirmed' },
    effect: () => { w.m.state.project.client_confirmed_at = T0; w.m.state.project.client_confirmed_by = 'photographer'; } });
  await suite('completion page — already confirmed elsewhere (the POST answers 409 already_confirmed): the page switches after re-reading the state',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('#doneConfirmBtn', { timeout: 5000 });
      await page.click('#doneConfirmBtn');
      await page.click('#doneConfirmSubmit');
      await cpReady(page);
      ok('the completion page is up with the photographer\'s stamp', await page.evaluate(() => document.getElementById('cpConfirmed').textContent) === '已確認完成（2026/9/21）');
      ok('the 驗收頁 is gone', (await page.$('#deliveryDone')) === null && (await page.$('#doneConfirmBtn')) === null);
      ok('positive: the injected 409 was really consumed', queue.length === 0);
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}

// ── 5. the shop: cards, prices, ranges, inert strings, the image rule
{
  const HOSTILE = '<img src=x onerror="window.__xss=1">相本';
  const products = [
    { ...SHOP_PRINT_FAKE, id: 'p1', name: HOSTILE, description: '<script>window.__xss=2</script><b>粗體</b> 木框', options: [{ id: 'o1', label: '<i>16×20</i>', price: 3000 }, { id: 'o2', label: '', price: 12 }] },
    { ...SHOP_ALBUM_FAKE, id: 'a1', name: '相本 A', min_pages: 10, max_pages: 30 },
    { ...SHOP_ALBUM_FAKE, id: 'a2', name: '相本 B', min_pages: 10, max_pages: null, image_url: null },
    { ...SHOP_ALBUM_FAKE, id: 'a3', name: '相本 C', min_pages: null, max_pages: 30, image_url: '/api/other/steal.png' },
    { ...SHOP_ALBUM_FAKE, id: 'a4', name: '相本 D', min_pages: null, max_pages: null, image_url: 'https://evil.example/a.png' },
    { ...SHOP_ALBUM_FAKE, id: 'a5', name: '相本 E', image_url: '//evil.example/b.png' },
    { ...SHOP_ALBUM_FAKE, id: 'a6', name: '相本 F', image_url: '/api/platform/products/../../admin/x.png' },
    { ...SHOP_PRINT_FAKE, id: 'p2', name: '加洗相片', min_pages: 5, max_pages: 6, image_url: null },
  ];
  const w = world({ fake: { shopProducts: products } });
  const requested = [];
  await suite('completion page — shop cards: name, description, options with NT$ price, spread range; strings are inert; only product images from the Worker are loaded',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await cpReady(page);
      await page.waitForSelector('#cpShop', { timeout: 5000 });
      const cards = await page.evaluate(() => [...document.querySelectorAll('#cpShop .cp-product')].map(c => ({
        name: c.querySelector('.cp-product-name')?.textContent, desc: c.querySelector('.cp-product-desc')?.textContent ?? null,
        range: c.querySelector('.cp-product-range')?.textContent ?? null,
        options: [...c.querySelectorAll('.cp-option')].map(o => [o.querySelector('.cp-option-label')?.textContent ?? null, o.querySelector('.cp-option-price')?.textContent]),
        img: c.querySelector('img')?.src ?? null, imgOnly: c.querySelectorAll('img').length })));
      ok('one card per product, in the Worker\'s order', cards.length === 8 && cards[1].name === '相本 A' && cards[7].name === '加洗相片', JSON.stringify(cards.map(c => c.name)));
      ok('a hostile name / description / label is plain text, nothing parsed',
        cards[0].name === HOSTILE && cards[0].desc === '<script>window.__xss=2</script><b>粗體</b> 木框' && cards[0].options[0][0] === '<i>16×20</i>', JSON.stringify(cards[0]));
      ok('...and nothing ran or was built: no <b>, <i>, <script>, <img src=x> in the shop, window.__xss unset',
        await page.evaluate(() => !document.querySelector('#cpShop b, #cpShop i, #cpShop script, #cpShop img[src="x"]') && window.__xss === undefined));
      ok('options show their label and NT$ price (thousands separated); a single option (label "") shows the price only',
        JSON.stringify(cards[0].options) === JSON.stringify([['<i>16×20</i>', 'NT$3,000'], [null, 'NT$12']]) && cards[1].options.length === 2 && cards[1].options[1][1] === 'NT$7,000', JSON.stringify(cards[0].options) + JSON.stringify(cards[1].options));
      ok('album range (spreads): both bounds, only a minimum, only a maximum, neither',
        cards[1].range === '10–30 跨頁' && cards[2].range === '至少 10 跨頁' && cards[3].range === '最多 30 跨頁' && cards[4].range === null, JSON.stringify(cards.slice(1, 5).map(c => c.range)));
      ok('a print has no page range even if the Worker sent numbers', cards[0].range === null && cards[7].range === null, JSON.stringify([cards[0].range, cards[7].range]));
      ok('the product image is the Worker origin + the relative image_url, exactly',
        cards[1].img === `${WORKER}${SHOP_ALBUM_FAKE.image_url}`, cards[1].img);
      ok('positive: a product with no image has no <img>', cards[0].imgOnly === 0 && cards[2].imgOnly === 0);
      ok('an image path outside /api/platform/products/ (relative, https, protocol-relative, a ../ escape) is rejected: no <img> at all',
        [3, 4, 5, 6].every(i => cards[i].imgOnly === 0), JSON.stringify(cards.slice(3, 7).map(c => c.img)));
      await page.waitForTimeout(300);
      ok('and no request was ever made to a foreign host or to /api/other', !requested.some(u => /evil\.example|\/api\/other|\/admin\//.test(u)), JSON.stringify(requested.filter(u => /evil|other|admin/.test(u))));
      ok('control: the allowed product image WAS requested (the request log works)', requested.some(u => u.startsWith(`${WORKER}/api/platform/products/pp-album/image`)), JSON.stringify(requested.slice(-5)));
      ok('information only: no order UI in the shop (no input, no select, no textarea, no cart / add button; the owner\'s only buttons are 我有興趣, suite 45)', await page.evaluate(() => !document.querySelector('#cpShop input, #cpShop select, #cpShop textarea') && [...document.querySelectorAll('#cpShop button')].every(b => b.classList.contains('cp-interest-btn') && b.textContent === '我有興趣')));
      return out;
    },
    { before: async page => { page.on('request', r => requested.push(r.url())); await w.before(page); }, initScript: OWNER, contextOptions: ALB_DESK });
}

// invalid rows from a misbehaving Worker are skipped; a list with nothing valid is no section
for (const [name, products, expectCards] of [
  ['rows that are not products are skipped', [null, 7, { kind: 'print' }, { ...SHOP_PRINT_FAKE, name: 42 }, { ...SHOP_PRINT_FAKE, options: [{ label: 'x', price: 1.5 }, { label: 'y', price: -1 }, { label: 'z', price: '100' }] }, { ...SHOP_PRINT_FAKE, id: 'ok', name: '好的', options: [{ id: 'o', label: 'A', price: 100 }, { id: 'p', label: 'B', price: 99.5 }] }], 1],
  ['nothing valid at all', [null, { kind: 'print' }, { ...SHOP_PRINT_FAKE, options: [] }], 0],
]) {
  const w = world({ fake: { shopProducts: products } });
  await suite(`completion page — shop validation: ${name}`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await cpReady(page);
      await page.waitForSelector('#albumPreviewBtn', { timeout: 6000 });   // the album entry shows once the shop has settled
      await page.waitForTimeout(300);
      ok('positive: the shop was asked', w.m.requests.some(r => r.path === '/api/pick/shop'));
      const n = await page.evaluate(() => ({ cards: document.querySelectorAll('#cpShop .cp-product').length, sec: !!document.getElementById('cpShop'), opts: [...document.querySelectorAll('#cpShop .cp-option-price')].map(e => e.textContent) }));
      ok(`${expectCards} card(s)${expectCards ? ' and only the integer prices >= 0' : ' and the whole section removed from the DOM'}`,
        n.cards === expectCards && n.sec === !!expectCards && (!expectCards || JSON.stringify(n.opts) === '["NT$100"]'), JSON.stringify(n));
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}

// ── the section is simply absent when the shop does not answer; nothing else changes
for (const [name, fake] of [
  ['an empty list', { shopProducts: [] }],
  ['409 not_delivered', { shopFail: 409 }],
  ['500 shop_unavailable', { shopUnavailable: true }],
  ['a 500 error', { shopFail: 500 }],
  ['a dropped connection', { shopFail: 'net' }],
]) {
  const w = world({ fake });
  await suite(`completion page — shop answers ${name}: the section is absent from the DOM, the rest renders`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await cpReady(page);
      await page.waitForSelector('#albumPreviewBtn', { timeout: 6000 });   // the album entry waits for the shop to settle
      const s = await page.evaluate(() => ({ shop: !!document.getElementById('cpShop'), cards: document.querySelectorAll('.cp-product').length,
        cta: !!document.getElementById('cpShopCta'), hero: !!document.getElementById('cpCover'), dl: !!document.getElementById('cpDownloadAll'),
        foot: !!document.getElementById('cpShare'), tiles: document.querySelectorAll('#completionPage .fg-tile').length,
        sw: document.documentElement.scrollWidth <= innerWidth }));
      ok('positive: the shop WAS asked', w.m.requests.some(r => r.path === '/api/pick/shop'), JSON.stringify(w.m.requests.map(r => r.path)));
      ok('no shop section, no card, no CTA in the DOM', !s.shop && s.cards === 0 && !s.cta, JSON.stringify(s));
      ok('the hero, gallery rows, download button, album entry and footer are all there', s.hero && s.dl && s.foot && s.tiles === 12, JSON.stringify(s));
      ok('no horizontal scroll', s.sw);
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}

// ── the CTA: a link when the studio has an https booking URL, a plain line when it does not
for (const [name, studio, expectHref] of [
  ['https booking_url', { name: '光影工作室', booking_url: 'https://studio.example/book?x=1', has_logo: false }, 'https://studio.example/book?x=1'],
  ['no booking_url', { name: '光影工作室', booking_url: null, has_logo: false }, null],
  ['an http:// booking_url (a Worker that did not validate)', { name: '光影工作室', booking_url: 'http://studio.example/book', has_logo: false }, null],
  ['a javascript: booking_url (a misbehaving Worker)', { name: '光影工作室', booking_url: 'javascript:alert(1)', has_logo: false }, null],
]) {
  const w = world({ fake: { studio } });
  await suite(`completion page — CTA with ${name}`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await cpReady(page);
      await page.waitForSelector('#cpShop', { timeout: 5000 });
      const c = await page.evaluate(() => { const a = document.querySelector('#cpShopCta a'); const p = document.getElementById('cpShopNoLink');
        return { a: a ? { href: a.getAttribute('href'), target: a.target, rel: a.rel, text: a.textContent, h: a.getBoundingClientRect().height } : null, plain: p ? p.textContent : null,
          anchors: document.querySelectorAll('#cpShopCta a').length, footLink: document.querySelector('#cpFooterLink')?.getAttribute('href') ?? null }; });
      ok('positive: the shop section is there with cards', (await page.$$('#cpShop .cp-product')).length === 2);
      if (expectHref) {
        ok('one link 聯絡攝影師訂購 to the booking URL, new tab, rel noopener', c.anchors === 1 && c.a.href === expectHref && c.a.target === '_blank' && /noopener/.test(c.a.rel) && c.a.text === '聯絡攝影師訂購', JSON.stringify(c));
        ok('a tappable size, and no plain-line fallback next to it', c.a.h >= 44 && c.plain === null, JSON.stringify(c));
        ok('the footer carries the same booking link', c.footLink === expectHref, JSON.stringify(c));
      } else {
        ok('no link at all; the plain line 想訂購請直接聯絡攝影師', c.anchors === 0 && c.plain === '想訂購請直接聯絡攝影師', JSON.stringify(c));
        ok('and no booking link in the footer either', c.footLink === null, JSON.stringify(c));
      }
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}

// ── download: 下載全部精修
{
  const w = world({ n: 12, sub: 2, fake: { title: 'A/B:C 婚禮' } });
  await suite('completion page — 下載全部精修: every final (subfolders included, never a proof) goes to driveManager.downloadPhotos as <title>_精修_<N>張.zip',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('#completionPage', { timeout: 5000 });
      await page.waitForSelector('#cpDownloadAll', { timeout: 5000 });
      await page.evaluate(() => { window.__dl = []; driveManager.downloadPhotos = async (list, name) => { window.__dl.push({ ids: list.map(p => p.id), names: list.map(p => p.name), name }); }; });
      ok('the button is a tappable size and says 下載全部精修', await page.evaluate(() => { const b = document.getElementById('cpDownloadAll'); return b.textContent.includes('下載全部精修') && b.getBoundingClientRect().height >= 44; }));
      await page.click('#cpDownloadAll');
      await page.waitForFunction(() => window.__dl.length === 1, null, { timeout: 5000 });
      const dl = await page.evaluate(() => window.__dl[0]);
      const expected = albKeys(12, 2);
      ok('all 12 finals, subfolder ones too, and not the proof', dl.ids.length === 12 && expected.every(k => dl.ids.includes(k)) && !dl.ids.some(k => k.includes('毛片')), JSON.stringify(dl.ids));
      ok('each carries a file name for the zip', dl.names.every(n => /^IMG_\d{4}\.jpg$/.test(n)), JSON.stringify(dl.names));
      ok('zip name: sanitised title + _精修_ + the count + 張.zip', dl.name === 'ABC 婚禮_精修_12張.zip', dl.name);
      ok('the button is usable again afterwards', await page.evaluate(() => !document.getElementById('cpDownloadAll').disabled));
      ok('only a listing was requested for it (the zip itself is the drive manager\'s, stubbed here)', w.log.filter(r => r.download).length === 0);
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}
{
  const w = world({ n: 6 });
  await suite('completion page — 下載全部精修: a failing listing says so and downloads nothing',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await cpReady(page, 6);
      await page.evaluate(() => { window.__dl = 0; driveManager.downloadPhotos = async () => { window.__dl++; }; });
      w.ctl.failList = 99;
      await page.click('#cpDownloadAll');
      await page.waitForSelector('.toast.error', { timeout: 5000 });
      ok('an error toast, no download call, the button is usable again', await page.evaluate(() => window.__dl === 0 && !document.getElementById('cpDownloadAll').disabled));
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}

// ── share: the link token only
for (const [who, init, co] of [['owner (dirty URL, key in storage)', OWNER, ALB_DESK], ['viewer', '', MOBILE]]) {
  const w = world({ n: 6 });
  await suite(`completion page — share link (${who}): origin + path + ?t=<token> only`,
    `${base}/index.html?t=TOK${init ? '&k=ZOE-KEY&utm=x#h=ZOE-KEY' : ''}`,
    async page => {
      const out = [], ok = line(out);
      await cpReady(page, 6);
      await page.evaluate(() => { window.__copied = []; Object.defineProperty(navigator, 'share', { value: undefined, configurable: true, writable: true });
        Object.defineProperty(navigator, 'clipboard', { value: { writeText: async t => { window.__copied.push(t); } }, configurable: true }); });
      ok('the share button is in the footer, tappable', await page.evaluate(() => { const b = document.querySelector('#cpFooter #cpShare'); return !!b && b.getBoundingClientRect().height >= 44; }));
      await page.click('#cpShare');
      await page.waitForFunction(() => window.__copied.length > 0, null, { timeout: 3000 });
      const copied = await page.evaluate(() => window.__copied);
      ok('exactly one copy: origin + path + ?t=TOK', copied.length === 1 && copied[0] === `${base}/index.html?t=TOK`, JSON.stringify(copied));
      ok('no owner key, no extra query, no hash', !/ZOE-KEY|utm|#|[?&]k=/.test(copied[0]), copied[0]);
      return out;
    },
    { before: w.before, initScript: init, contextOptions: co });
}

// ── 6. album preview: the product's spread bounds go to the planner, and the guest is told when they cannot be met
const openAlbum = async page => {
  await page.waitForSelector('#albumPreviewBtn', { timeout: 6000 });
  await page.click('#albumPreviewBtn');
  await albReady(page);
};
const closeAlbum = page => page.click('#albumClose');
const PLAN_EXPECT = (page, optsExtra) => page.evaluate(async x => {
  const keys = (await (await fetch(`${CONFIG.WORKER_URL}/?list=${encodeURIComponent('shoot/精修/')}`, { headers: driveManager._authHeaders() })).json()).data.map(f => f.id).sort(AutoLayout.util.naturalCompare);
  const items = await AutoLayout.analyze(keys, { urlFor: id => driveManager.getImageUrl({ id }, 400) });
  const p = AutoLayout.planSpreads(items, { coverAspect: 210 / 297, spreadAspect: 420 / 297, fit: 'contain', ...x });
  return { spreads: p.spreads.length, min: p.minSpreads || null, max: p.maxSpreads || null, n: keys.length };
}, optsExtra);

{
  const w = world({ n: 8, fake: { shopProducts: shopProductsFake({ album: { min_pages: 10, max_pages: 30 } }) } });
  await suite('completion page — album bounds: min 10 with only 8 finals: PLAN_OPTS carries the bounds, the hint says it kindly with the real numbers, in the viewer and under the entry',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await cpReady(page, 8);
      await openAlbum(page);
      const opts = await page.evaluate(() => JSON.parse(JSON.stringify(AlbumPreview.PLAN_OPTS)));
      ok('PLAN_OPTS = { fit: contain, minSpreads: 10, maxSpreads: 30 } (the first album product\'s min_pages / max_pages)', JSON.stringify(opts) === JSON.stringify({ fit: 'contain', minSpreads: 10, maxSpreads: 30 }), JSON.stringify(opts));
      const exp = await PLAN_EXPECT(page, { minSpreads: 10, maxSpreads: 30 });
      ok('control: the planner really cannot reach 10 spreads with 8 photos (the fixture is not vacuous)', exp.min && exp.min.met === false && exp.min.achieved < 10 && exp.n === 8, JSON.stringify(exp));
      const hint = await page.evaluate(() => document.getElementById('albumBounds')?.textContent ?? null);
      const re = /^這本相本至少要 10 個跨頁，目前 8 張照片只排得出 (\d+) 個；建議至少 (\d+) 張。?$/;
      const m = re.exec(hint || '');
      ok('the viewer shows the hint with the wanted count, the photo count, what was achieved and the photos needed', !!m && +m[1] === exp.min.achieved && +m[2] === exp.min.photosNeeded, `${hint} :: ${JSON.stringify(exp.min)}`);
      ok('the planner was not cropped: fit stays contain on every slot', await page.evaluate(() => [...document.querySelectorAll('.album-img')].every(i => i.dataset.fit === 'contain')));
      await closeAlbum(page);
      const under = await page.evaluate(() => { const h = document.getElementById('cpAlbumHint'); const e = document.getElementById('albumPreviewEntry');
        return { text: h ? h.textContent : null, after: !!h && !!e && (e.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0, inSec: !!h && !!h.closest('#cpAlbum') }; });
      ok('after closing, the same hint stays under the preview entry, in the album section', under.text === hint && under.after && under.inSec, JSON.stringify(under));
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}
{
  const w = world({ n: 48, fake: { shopProducts: shopProductsFake({ album: { min_pages: 10, max_pages: 30 } }) } });
  await suite('completion page — album bounds: enough photos for min 10 / max 30: no hint anywhere, the plan is inside the window',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await cpReady(page, 48);
      await openAlbum(page);
      const exp = await PLAN_EXPECT(page, { minSpreads: 10, maxSpreads: 30 });
      ok('control: both bounds are in the plan result and both are met (48 photos)', exp.min && exp.max && exp.min.met === true && exp.max.met === true && exp.spreads >= 10 && exp.spreads <= 30, JSON.stringify(exp));
      ok('positive: the viewer is up with pages', await page.evaluate(() => /\d+ \/ \d+/.test(document.getElementById('albumLabel')?.textContent || '') || document.getElementById('albumLabel')?.textContent === '封面'));
      ok('no hint in the viewer', (await page.$('#albumBounds')) === null);
      await closeAlbum(page);
      ok('no hint under the entry', (await page.$('#cpAlbumHint')) === null);
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}
{
  const w = world({ n: 48, fake: { shopProducts: shopProductsFake({ album: { min_pages: null, max_pages: 2 } }) } });
  await suite('completion page — album bounds: max 2 with 48 photos: the hint says how many photos fit (8 a spread); only maxSpreads is passed (min is null)',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await cpReady(page, 48);
      await openAlbum(page);
      const opts = await page.evaluate(() => JSON.parse(JSON.stringify(AlbumPreview.PLAN_OPTS)));
      ok('PLAN_OPTS has maxSpreads 2 and no minSpreads key at all', JSON.stringify(opts) === JSON.stringify({ fit: 'contain', maxSpreads: 2 }), JSON.stringify(opts));
      const exp = await PLAN_EXPECT(page, { maxSpreads: 2 });
      ok('control: the planner cannot fit 48 photos in 2 spreads', exp.max && exp.max.met === false && exp.max.photosAllowed === 16, JSON.stringify(exp));
      const hint = await page.evaluate(() => document.getElementById('albumBounds')?.textContent ?? null);
      ok('照片超過這本相本能放的 16 張', /^照片超過這本相本能放的 16 張/.test(hint || ''), hint);
      ok('and it does not talk about a minimum', !/至少/.test(hint || ''), hint);
      await closeAlbum(page);
      ok('the hint stays under the entry', (await page.textContent('#cpAlbumHint')) === hint);
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}
for (const [name, fake] of [
  ['only a print in the shop', { shopProducts: [SHOP_PRINT_FAKE] }],
  ['an album with no bounds (both null)', { shopProducts: shopProductsFake({ album: { min_pages: null, max_pages: null } }) }],
  ['the shop unavailable (500)', { shopUnavailable: true }],
  ['an album whose bounds are junk (0, a string)', { shopProducts: shopProductsFake({ album: { min_pages: 0, max_pages: '30' } }) }],
]) {
  const w = world({ n: 8, fake });
  await suite(`completion page — album preview with ${name}: no bounds passed, no hint, the preview works as before`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await cpReady(page, 8);
      await openAlbum(page);
      const opts = await page.evaluate(() => JSON.parse(JSON.stringify(AlbumPreview.PLAN_OPTS)));
      ok('PLAN_OPTS has neither minSpreads nor maxSpreads', !('minSpreads' in opts) && !('maxSpreads' in opts), JSON.stringify(opts));
      ok('positive: the viewer is up with a cover page and 8 photos in play (8 finals is a real album)', await page.evaluate(() => document.getElementById('albumViewer').dataset.state === 'ready' && document.querySelectorAll('.album-slide').length >= 1));
      ok('no hint in the viewer, none under the entry', (await page.$('#albumBounds')) === null && (await page.$('#cpAlbumHint')) === null);
      await closeAlbum(page);
      ok('...still none after closing', (await page.$('#cpAlbumHint')) === null);
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}
{
  const w = world({ n: 8, fake: { shopDelay: 1200, shopProducts: shopProductsFake({ album: { min_pages: 10, max_pages: 30 } }) } });
  await suite('completion page — album entry waits for the shop: no entry while the shop is pending, and once it shows the bounds are already set',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await cpReady(page, 8);
      ok('positive: the page is up (rows, hero) while the shop is still pending', (await page.$('#cpCover')) !== null && (await page.$('#cpShop')) === null);
      ok('...and the album entry is not there yet', (await page.$('#albumPreviewBtn')) === null);
      await page.waitForSelector('#albumPreviewBtn', { timeout: 6000 });
      ok('when the entry shows, PLAN_OPTS already has the bounds', await page.evaluate(() => AlbumPreview.PLAN_OPTS.minSpreads === 10 && AlbumPreview.PLAN_OPTS.maxSpreads === 30));
      ok('the shop section is there too', (await page.$('#cpShop')) !== null);
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}
{
  const w = world({ n: 8 });
  await suite('completion page — AlbumPreview.boundsHint (pure): wording, null photosNeeded / photosAllowed, met = no hint, a caller error = no hint',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('#completionPage', { timeout: 5000 });
      const h = await page.evaluate(() => {
        const f = AlbumPreview.boundsHint;
        return {
          min: f({ minSpreads: { wanted: 10, achieved: 8, met: false, photosNeeded: 10 } }, 8),
          minNull: f({ minSpreads: { wanted: 10, achieved: 8, met: false, photosNeeded: null } }, 8),
          met: f({ minSpreads: { wanted: 10, achieved: 10, met: true, photosNeeded: 10 }, maxSpreads: { wanted: 30, achieved: 10, met: true, photosAllowed: 240 } }, 40),
          max: f({ maxSpreads: { wanted: 2, achieved: 6, met: false, photosAllowed: 16 } }, 48),
          maxNull: f({ maxSpreads: { wanted: 61, achieved: 70, met: false, photosAllowed: null } }, 400),
          err: f({ minSpreads: { wanted: 10, achieved: 8, met: false, photosNeeded: null, error: 'minSpreads-greater-than-maxSpreads', ignored: 'minSpreads' },
            maxSpreads: { wanted: 5, achieved: 5, met: false, photosAllowed: null, error: 'minSpreads-greater-than-maxSpreads' } }, 8),
          none: f({}, 8), nothing: f(null, 8),
        };
      });
      ok('min not met: the kind sentence with all four numbers', h.min === '這本相本至少要 10 個跨頁，目前 8 張照片只排得出 8 個；建議至少 10 張。', h.min);
      ok('min not met, photosNeeded null: the number is left out, nothing says null / NaN', h.minNull === '這本相本至少要 10 個跨頁，目前 8 張照片只排得出 8 個。', h.minNull);
      ok('both met: null', h.met === null);
      ok('max not met: the allowed photo count', h.max === '照片超過這本相本能放的 16 張。', h.max);
      ok('max not met, photosAllowed null: the sentence without the number', h.maxNull === '照片超過這本相本能放的數量。', h.maxNull);
      ok('a caller error (min > max) says nothing', h.err === null && h.none === null && h.nothing === null, JSON.stringify(h));
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}

}
