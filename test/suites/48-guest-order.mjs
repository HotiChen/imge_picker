// Browser suites: guest ordering on the 完成頁 (js/guest-order.js, docs/guest-shop.md 「S2 — built (Worker, WP1)」).
// The fake Worker (test/lib/guest-orders-fake.mjs, on top of pick-fake.mjs) mirrors the Worker's status / code
// table in the doc's order and prices every line from the catalogue; the real Worker was only mirrored, never called.
// Registered by test/run.mjs in file-name order. Suite names start with "guest order" (ONLY="guest order").
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ALB_DESK, albumWorld } from '../lib/album-world.mjs';
import { shopProductsFake, SHOP_PRINT_FAKE, SHOP_ALBUM_FAKE } from '../lib/pick-fake.mjs';
import { ordersWorld, ORDERING } from '../lib/guest-orders-fake.mjs';

export default async function register() {

const T0 = '2026-09-21T03:00:00.000Z';
const STUDIO = { name: '光影工作室', booking_url: 'https://studio.example/book', has_logo: true };
const OWNER = "localStorage.setItem('pick_key:TOK', 'ZOE-KEY');";
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY1 = 'shoot/精修/IMG_0001.jpg';
const KEY2 = 'shoot/精修/IMG_0002.jpg';
const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const sx = (name, run, opts) => suite(`guest order — ${name}`, `${base}/index.html?t=TOK`, async page => {
  const out = [], ok = line(out);
  try { await run(page, ok); } catch (e) { out.push(`FAIL  threw after ${out.length} lines: ${String(e.message).split('\n')[0]}`); }
  return out;
}, opts);

// a print with two options, an album (10–30 spreads, 150 per extra spread, two options), an album with no min_pages
const catalogue = () => [
  { ...SHOP_PRINT_FAKE, options: [{ id: 'opt-print-1', label: '16×20', price: 3000 }, { id: 'opt-print-2', label: '20×30', price: 4500 }] },
  { ...SHOP_ALBUM_FAKE, extra_page_price: 150 },
  { ...SHOP_ALBUM_FAKE, id: 'prod-album-x', name: '無頁數相本', min_pages: null, max_pages: null, image_url: null, options: [{ id: 'opt-x-1', label: '', price: 9000 }] },
];
// o.ordering: undefined = the standard one, null = the switch is off
const world = (o = {}) => {
  const products = o.products || catalogue();
  const ordering = o.ordering === undefined ? { ...ORDERING } : o.ordering;
  const w = albumWorld({ n: 12, fake: { title: '婚禮精修', confirmedAt: T0, studio: STUDIO, shopProducts: products, ordering } });
  return ordersWorld(w, { products, ordering, ...(o.fake || {}) });
};
const $ = (page, sel) => page.evaluate(s => document.querySelector(s)?.textContent ?? null, sel);
const click = (page, sel) => page.evaluate(s => { const e = document.querySelector(s); if (!e) throw new Error('missing ' + s); e.click(); }, sel);
const step = (page, name) => page.waitForSelector(`#goSheet[data-step="${name}"]`, { timeout: 5000 });
const ready = page => page.waitForSelector('#cpShop .cp-product', { timeout: 6000 });
const count = (page, sel) => page.evaluate(s => document.querySelectorAll(s).length, sel);
const sheetText = page => page.evaluate(() => document.getElementById('goSheet')?.textContent ?? '');
const CONTACT = { name: '王小明', phone: '0912-345-678', line: '', note: '' };
const fillContact = async (page, c = {}) => {
  const v = { ...CONTACT, ...c };
  await page.fill('#goName', v.name);
  await page.fill('#goPhone', v.phone);
  await page.fill('#goLine', v.line);
  await page.fill('#goNote', v.note);
  if (v.consent !== false) await page.check('#goConsent');
};
// product card -> product step -> pick (option, photo, qty) -> add
async function addPrint(page, { option = 'opt-print-1', photo = KEY1, qty = 1 } = {}) {
  await click(page, '.go-order-btn[data-product-id="prod-print"]');
  await step(page, 'product');
  await page.waitForSelector('.go-photo', { timeout: 5000 });
  await click(page, `.go-opt[data-option-id="${option}"]`);
  await click(page, `.go-photo[data-photo-key="${photo}"]`);
  for (let i = 1; i < qty; i++) await click(page, '#goSheet .go-step-plus');
  await click(page, '#goAdd');
  await step(page, 'cart');
}
async function toReview(page, c) {
  await click(page, '#goToContact');
  await step(page, 'contact');
  await fillContact(page, c);
  await click(page, '#goToReview');
  await step(page, 'review');
}
const waitPosts = (w, n) => new Promise((res, rej) => { const t0 = Date.now(); const f = () => w.posts().length >= n ? res() : Date.now() - t0 > 5000 ? rej(new Error(`only ${w.posts().length} POSTs`)) : setTimeout(f, 30); f(); });
// the sheet is inside the viewport, the primary button is visible, nothing scrolls sideways, taps are 44px
const layout = (page, label, ok) => page.evaluate(() => {
  const s = document.getElementById('goSheet').getBoundingClientRect();
  const vw = window.innerWidth, vh = window.innerHeight;
  const prim = document.querySelector('#goSheet .go-primary');
  const p = prim ? prim.getBoundingClientRect() : null;
  const taps = [...document.querySelectorAll('#goSheet button')].filter(b => b.getClientRects().length).map(b => { const r = b.getBoundingClientRect(); return { h: r.height, w: r.width, t: b.className }; });
  return { inside: s.left >= -0.5 && s.right <= vw + 0.5 && s.top >= -0.5 && s.bottom <= vh + 0.5, prim: !!p && p.top >= 0 && p.bottom <= vh + 0.5 && p.width > 0,
    sw: document.documentElement.scrollWidth <= vw + 1, bodySw: document.getElementById('goSheet').scrollWidth <= s.width + 1, n: taps.length, small: taps.filter(t => t.h < 43.5 || t.w < 43.5).map(t => t.t) };
}).then(r => {
  ok(`${label}: sheet inside the 390px viewport, primary button visible, no horizontal scroll`, r.inside && r.prim && r.sw && r.bodySw, JSON.stringify(r));
  ok(`${label}: floor — at least 2 buttons scanned and every one is 44px or more`, r.n >= 2 && r.small.length === 0, JSON.stringify(r));
});

// ── 1. who sees what
{
  const w = world();
  await sx('owner of a confirmed project with ordering on: 訂購 replaces 我有興趣 on orderable cards; an album without min_pages is information + 我有興趣', async (page, ok) => {
    await ready(page);
    const r = await page.evaluate(() => ({
      orderBtns: [...document.querySelectorAll('#cpShop .go-order-btn')].map(b => b.dataset.productId),
      interest: [...document.querySelectorAll('#cpShop .cp-interest-btn')].map(b => b.dataset.productId),
      label: document.querySelector('#cpShop .go-order-btn')?.textContent, bar: !!document.getElementById('goBar'),
      mine: document.getElementById('goBarOrders')?.textContent, cartHidden: document.getElementById('goBarCart')?.hidden,
      note: document.querySelector('#cpShop .go-unorderable')?.textContent ?? null, cards: document.querySelectorAll('#cpShop .cp-product').length,
    }));
    ok('positive: 3 cards; 訂購 on the print and the priced album only', r.cards === 3 && JSON.stringify(r.orderBtns) === JSON.stringify(['prod-print', 'prod-album']) && r.label === '訂購', JSON.stringify(r));
    ok('the cards that have 訂購 have no 我有興趣; the album without min_pages has 我有興趣 and says it is not orderable online',
      JSON.stringify(r.interest) === JSON.stringify(['prod-album-x']) && !!r.note && r.note.includes('不開放線上訂購'), JSON.stringify(r));
    ok('the 我的訂單 button is there, 查看訂單內容 is hidden while the cart is empty', r.bar && r.mine === '我的訂單' && r.cartHidden === true, JSON.stringify(r));
    ok('no request to /api/pick/orders before any tap', w.reqs.length === 0);
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}
{
  const w = world();
  await sx('a viewer (no seat key): the cards, no 訂購, no 我有興趣, no 我的訂單, no request', async (page, ok) => {
    await ready(page);
    ok('positive: the shop shows 3 cards', await count(page, '#cpShop .cp-product') === 3);
    ok('no order / interest button, no bar, no sheet', await page.evaluate(() => !document.querySelector('.go-order-btn, .cp-interest-btn, #goBar, #goLayer')));
    await page.waitForTimeout(250);
    ok('nothing sent to /api/pick/orders', w.reqs.length === 0);
  }, { before: w.before, contextOptions: ALB_DESK });
}
{
  const w = world({ ordering: null });
  await sx('ordering null (switch off / migration not run): the page is exactly as before — 我有興趣 for the owner, no 訂購', async (page, ok) => {
    await ready(page);
    const r = await page.evaluate(() => ({ interest: document.querySelectorAll('#cpShop .cp-interest-btn').length, order: document.querySelectorAll('.go-order-btn, #goBar').length, un: !!document.querySelector('.go-unorderable') }));
    ok('positive: a 我有興趣 button on each of the 3 cards, no 訂購, no bar, no "not orderable" note', r.interest === 3 && r.order === 0 && !r.un, JSON.stringify(r));
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}

// ── 2. print: the whole flow at 390px
{
  const w = world();
  await sx('print at 390px: option + one final + 2 copies -> cart -> contact -> review -> one POST with the exact body -> receipt 待確認 without transfer info', async (page, ok) => {
    await ready(page);
    await click(page, '.go-order-btn[data-product-id="prod-print"]');
    await step(page, 'product');
    await page.waitForSelector('.go-photo', { timeout: 5000 });
    ok('positive: the finals thumbnails are shown (12 of them) and no option is chosen yet, 加入訂單 is disabled',
      await count(page, '.go-photo') === 12 && await page.evaluate(() => document.getElementById('goAdd').disabled), `${await count(page, '.go-photo')}`);
    ok('the thumbnails are the 400px finals the page already uses', await page.evaluate(() => [...document.querySelectorAll('.go-photo img')].every(i => /[?&]w=400/.test(i.src)) ), '');
    await layout(page, 'product step', ok);
    await click(page, '.go-opt[data-option-id="opt-print-2"]');
    await click(page, `.go-photo[data-photo-key="${KEY2}"]`);
    ok('the draft price follows: 單價 NT$4,500 小計 NT$4,500', (await $(page, '#goDraftPrice')) === '單價 NT$4,500　小計 NT$4,500', await $(page, '#goDraftPrice'));
    await click(page, '#goSheet .go-step-plus');
    ok('2 copies -> 小計 NT$9,000', (await $(page, '#goDraftPrice')).includes('NT$9,000'), await $(page, '#goDraftPrice'));
    await click(page, '#goAdd');
    await step(page, 'cart');
    ok('the cart has one line: the option, the file name, 2 × 4,500, total NT$9,000',
      await count(page, '#goLines .go-line') === 1 && (await sheetText(page)).includes('IMG_0002.jpg') && (await $(page, '#goCartTotal')) === '合計 NT$9,000', await sheetText(page));
    await layout(page, 'cart step', ok);
    await click(page, '#goToContact');
    await step(page, 'contact');
    await layout(page, 'contact step', ok);
    ok('the form has name, phone, LINE, note, the 面交 line, the consent notice with its version and no horizontal overflow',
      await page.evaluate(() => ['goName', 'goPhone', 'goLine', 'goNote', 'goConsent'].every(i => document.getElementById(i)) && document.getElementById('goSheet').textContent.includes('面交') && document.getElementById('goSheet').textContent.includes('版本 v1')));
    ok('the inputs are 16px (no iOS zoom) and typed for the phone keyboard (tel, autocomplete)', await page.evaluate(() => {
      const n = document.getElementById('goName'), p = document.getElementById('goPhone');
      return getComputedStyle(n).fontSize === '16px' && p.type === 'tel' && p.autocomplete === 'tel' && n.autocomplete === 'name';
    }));
    await fillContact(page, { line: 'zoe_line', note: '週末面交\n謝謝' });
    await click(page, '#goToReview');
    await step(page, 'review');
    await layout(page, 'review step', ok);
    ok('the review shows the total and the contact', (await $(page, '#goReviewTotal')) === '合計 NT$9,000' && (await sheetText(page)).includes('王小明') && (await sheetText(page)).includes('面交'));
    ok('nothing sent yet', w.posts().length === 0);
    await click(page, '#goSubmit');
    await step(page, 'receipt');
    const ps = w.posts();
    ok('exactly one POST', ps.length === 1, String(ps.length));
    const b = ps[0].body;
    ok('body: request_id is a UUID v4', UUID4.test(b.request_id), String(b.request_id));
    ok('body: lines = [{option_id, qty, photo_key}] and nothing money-related per line', JSON.stringify(b.lines) === JSON.stringify([{ option_id: 'opt-print-2', qty: 2, photo_key: KEY2 }]), JSON.stringify(b.lines));
    ok('body: contact, pickup, note, consent "v1"', JSON.stringify(b.contact) === JSON.stringify({ name: '王小明', phone: '0912-345-678', line: 'zoe_line' }) && JSON.stringify(b.delivery) === '{"method":"pickup"}' && b.note === '週末面交\n謝謝' && b.consent === 'v1', JSON.stringify(b));
    ok('body: expected_total 9000 = 2 × 4500 and no other money field anywhere', b.expected_total === 9000 && !/unit_price|"total"|"price"|"subtotal"/.test(ps[0].bodyText), ps[0].bodyText);
    ok('token in the query, the key only in the X-Picker-Key header, never in a URL', ps[0].t === 'TOK' && ps[0].key === 'ZOE-KEY' && ps[0].search === '?t=TOK' && w.reqs.every(r => !r.search.includes('ZOE') && !r.path.includes('ZOE')), JSON.stringify(ps[0].search));
    const rc = await sheetText(page);
    ok('receipt: 訂單已送出, 待確認, the line, NT$9,000, and no transfer block / text', rc.includes('訂單已送出') && rc.includes('待確認') && rc.includes('IMG_0002.jpg') && rc.includes('NT$9,000') && !rc.includes('轉帳') && await count(page, '.go-transfer') === 0, rc);
    ok('the Worker holds one requested order for the seat', w.orders.length === 1 && w.orders[0].status === 'requested' && w.orders[0].total === 9000);
    ok('the cart is empty after the order', await page.evaluate(() => document.getElementById('goBarCart').hidden === true));
    await layout(page, 'receipt step', ok);
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}

// ── 3. album: the price formula
{
  const w = world();
  await sx('album: spreads between min and max, price = option + (spreads − min) × extra_page_price per copy, the POST carries spreads (no photo_key)', async (page, ok) => {
    await ready(page);
    await click(page, '.go-order-btn[data-product-id="prod-album"]');
    await step(page, 'product');
    await click(page, '.go-opt[data-option-id="opt-album-2"]');
    ok('positive: spreads start at the minimum (10) and the draft price is the bare option price NT$7,000', (await $(page, '#goDraftPrice')) === '單價 NT$7,000　小計 NT$7,000' && (await $(page, '#goSheet .go-step-n')) === '10', await $(page, '#goDraftPrice'));
    ok('no photo grid for an album and the explanation names min, max and the extra-page price', await count(page, '.go-photo') === 0 && (await sheetText(page)).includes('含 10 跨頁，最多 30 跨頁') && (await sheetText(page)).includes('NT$150'));
    ok('the spreads stepper cannot go below the minimum', await page.evaluate(() => document.querySelector('#goSheet .go-sec .go-step-minus').disabled));
    for (let i = 0; i < 3; i++) await click(page, '#goSheet .go-sec .go-step-plus');
    ok('13 spreads: 7000 + (13 − 10) × 150 = NT$7,450', (await $(page, '#goDraftPrice')) === '單價 NT$7,450　小計 NT$7,450', await $(page, '#goDraftPrice'));
    await page.evaluate(() => { const s = [...document.querySelectorAll('#goSheet .go-sec--row .go-step-plus')]; s[0].click(); s[0].click(); });
    ok('2 copies -> 小計 NT$14,900', (await $(page, '#goDraftPrice')) === '單價 NT$7,450　小計 NT$14,900', await $(page, '#goDraftPrice'));
    await click(page, '#goAdd');
    await step(page, 'cart');
    ok('cart: 13 跨頁・全部精修, total NT$14,900', (await sheetText(page)).includes('13 跨頁') && (await $(page, '#goCartTotal')) === '合計 NT$14,900', await sheetText(page));
    await toReview(page);
    await click(page, '#goSubmit');
    await step(page, 'receipt');
    const b = w.posts()[0].body;
    ok('body line = {option_id, qty:2, spreads:13}, expected_total 14900', JSON.stringify(b.lines) === JSON.stringify([{ option_id: 'opt-album-2', qty: 2, spreads: 13 }]) && b.expected_total === 14900, JSON.stringify(b));
    ok('the fake Worker priced it the same (no price_changed): 201 and a stored total of 14900', w.orders.length === 1 && w.orders[0].total === 14900 && w.orders[0].items[0].spreads === 13);
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}
{
  const w = world({ products: [{ ...SHOP_PRINT_FAKE }, { ...SHOP_ALBUM_FAKE, extra_page_price: null, min_pages: 12, max_pages: 30 }] });
  await sx('album with no extra_page_price: fixed at min_pages spreads (no stepper above), priced at the bare option price', async (page, ok) => {
    await ready(page);
    await click(page, '.go-order-btn[data-product-id="prod-album"]');
    await step(page, 'product');
    await click(page, '.go-opt[data-option-id="opt-album-1"]');
    ok('positive: 12 跨頁 is shown as fixed, with no spreads stepper (only the quantity one) and price NT$5,000',
      (await sheetText(page)).includes('12 跨頁（此相本不能加頁）') && await count(page, '#goSheet .go-stepper') === 1 && (await $(page, '#goDraftPrice')).includes('NT$5,000'), await sheetText(page));
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}

// ── 4. cart rules and caps
{
  const w = world({ ordering: { ...ORDERING, max_lines: 2, print_qty_max: 3, album_qty_max: 2 } });
  await sx('caps from `ordering`: print qty max, album qty max, max_lines; the same option + photo twice is ONE line; remove works', async (page, ok) => {
    await ready(page);
    await addPrint(page, { photo: KEY1, qty: 1 });
    await page.evaluate(() => document.getElementById('goLayer')?.querySelector('.go-close')?.click());
    await addPrint(page, { photo: KEY1, qty: 2 });
    ok('positive: the same option + photo added again merges into one line, qty 1 + 2 = 3', await count(page, '#goLines .go-line') === 1 && (await $(page, '#goLines .go-step-n')) === '3', await sheetText(page));
    ok('the cart stepper stops at print_qty_max 3', await page.evaluate(() => document.querySelector('#goLines .go-step-plus').disabled));
    await page.evaluate(() => document.querySelector('#goLayer .go-close').click());
    await addPrint(page, { photo: KEY2, qty: 1 });
    ok('a second photo is a second line (2 lines)', await count(page, '#goLines .go-line') === 2);
    await page.evaluate(() => document.querySelector('#goLayer .go-close').click());
    await click(page, '.go-order-btn[data-product-id="prod-print"]');
    await step(page, 'product');
    await page.waitForSelector('.go-photo');
    await click(page, '.go-opt[data-option-id="opt-print-1"]');
    await click(page, `.go-photo[data-photo-key="shoot/精修/IMG_0003.jpg"]`);
    ok('a third line is refused at max_lines 2: 加入訂單 disabled and the reason is said', await page.evaluate(() => document.getElementById('goAdd').disabled) && (await sheetText(page)).includes('最多 2 個項目'), await sheetText(page));
    await page.evaluate(() => document.querySelector('#goLayer .go-close').click());
    ok('the 查看訂單內容 button on the page reads the count and total: 4 件・NT$12,000', (await $(page, '#goBarCart')) === '查看訂單內容（4 件・NT$12,000）', await $(page, '#goBarCart'));
    await click(page, '#goBarCart');
    await step(page, 'cart');
    await click(page, '#goLines .go-line:first-child .go-remove');
    ok('移除 drops the first line: 1 line left, total NT$3,000', await count(page, '#goLines .go-line') === 1 && (await $(page, '#goCartTotal')) === '合計 NT$3,000', await sheetText(page));
    await click(page, '#goLines .go-remove');
    ok('removing the last line shows the empty cart with no way forward', (await sheetText(page)).includes('還沒有加入任何項目') && await count(page, '#goToContact') === 0);
    // album qty cap
    await page.evaluate(() => document.querySelector('#goLayer .go-close').click());
    await click(page, '.go-order-btn[data-product-id="prod-album"]');
    await step(page, 'product');
    await click(page, '.go-opt[data-option-id="opt-album-1"]');
    await page.evaluate(() => { const s = document.querySelector('#goSheet .go-sec--row .go-step-plus'); s.click(); s.click(); s.click(); });
    ok('album qty stops at album_qty_max 2', (await $(page, '#goSheet .go-sec--row .go-step-n')) === '2' && await page.evaluate(() => document.querySelector('#goSheet .go-sec--row .go-step-plus').disabled));
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}

// ── 5. contact form validation (nothing is sent)
{
  const w = world();
  await sx('contact form: name required, phone or LINE ID (at least one), phone format, 個資告知 required, note ≤ 500 — nothing is sent until all pass', async (page, ok) => {
    await ready(page);
    await addPrint(page);
    await click(page, '#goToContact');
    await step(page, 'contact');
    const err = () => page.evaluate(() => { const e = document.getElementById('goContactError'); return e.hidden ? '' : e.textContent; });
    const next = async () => { await click(page, '#goToReview'); await page.waitForTimeout(60); };
    await next();
    ok('empty form: asks for the name, stays on the contact step', (await err()).includes('姓名') && (await page.evaluate(() => document.getElementById('goSheet').dataset.step)) === 'contact', await err());
    await page.fill('#goName', '王小明');
    await next();
    ok('name only: asks for phone or LINE ID', (await err()).includes('電話或 LINE ID'), await err());
    await page.fill('#goPhone', 'abc');
    await next();
    ok('a bad phone is refused', (await err()).includes('電話格式'), await err());
    await page.fill('#goPhone', '');
    await page.fill('#goLine', 'zoe_line');
    await next();
    ok('LINE ID alone is enough, but without the consent box it still stops', (await err()).includes('同意個資告知') && (await page.evaluate(() => document.getElementById('goSheet').dataset.step)) === 'contact', await err());
    ok('the consent box is unchecked by default', await page.evaluate(() => document.getElementById('goConsent').checked === false));
    ok('the note is capped at 500 characters by the textarea', await page.evaluate(() => document.getElementById('goNote').maxLength === 500));
    ok('still nothing sent to the Worker', w.posts().length === 0);
    await page.check('#goConsent');
    await next();
    await step(page, 'review');
    ok('positive control: name + LINE ID + consent reaches the review step', true);
    await click(page, '#goSubmit');
    await step(page, 'receipt');
    const b = w.posts()[0].body;
    ok('body: contact has only name and line (no empty phone key), no note key, consent v1', JSON.stringify(b.contact) === '{"name":"王小明","line":"zoe_line"}' && !('note' in b) && b.consent === 'v1', JSON.stringify(b));
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}

// ── 6. price_changed
{
  const products = catalogue();
  const w = world({ products });
  await sx('409 price_changed: the new quote is shown, nothing is written, a second confirm sends expected_total = the quote with a NEW request_id', async (page, ok) => {
    await ready(page);
    await addPrint(page, { option: 'opt-print-1', qty: 2 });
    await toReview(page);
    ok('before: total NT$6,000', (await $(page, '#goReviewTotal')) === '合計 NT$6,000');
    products[0].options[0].price = 3200;   // the Worker's catalogue moved (the fake reads this very list)
    await click(page, '#goSubmit');
    await page.waitForSelector('#goQuote', { timeout: 4000 });
    ok('the banner says the price changed and shows NT$6,400, the review total is NT$6,400', (await $(page, '#goQuote')).includes('NT$6,400') && (await $(page, '#goReviewTotal')) === '合計 NT$6,400', await $(page, '#goQuote'));
    ok('the line shows the new unit price 3,200', (await sheetText(page)).includes('NT$3,200 × 2'), await sheetText(page));
    ok('nothing was written and still on the review step', w.orders.length === 0 && w.posts().length === 1 && await page.evaluate(() => document.getElementById('goSheet').dataset.step) === 'review');
    ok('the submit button is usable again and shows the new total', await page.evaluate(() => { const b = document.getElementById('goSubmit'); return !b.disabled && b.textContent.includes('NT$6,400'); }));
    await click(page, '#goSubmit');
    await step(page, 'receipt');
    const [p1, p2] = w.posts();
    ok('the second POST carries expected_total 6400', p2.body.expected_total === 6400, JSON.stringify(p2.body));
    ok('a definitive answer (409) ended the first attempt: the second request_id is NEW and both are UUID v4', UUID4.test(p1.body.request_id) && UUID4.test(p2.body.request_id) && p1.body.request_id !== p2.body.request_id);
    ok('one order stored at 6400', w.orders.length === 1 && w.orders[0].total === 6400);
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}

{
  const w = world();
  await sx('price_changed whose quote lines do not map onto the cart: the Worker\'s quote total is what is shown and sent back as expected_total', async (page, ok) => {
    await ready(page);
    await addPrint(page, { qty: 2 });
    await toReview(page);
    w.ctl.force = { status: 409, body: { error: 'price_changed', code: 'price_changed', quote: { lines: [{ option_id: 'other', qty: 9, unit_price: 1 }], subtotal: 7777, total: 7777 } } };
    await click(page, '#goSubmit');
    await page.waitForSelector('#goQuote', { timeout: 4000 });
    ok('the banner and the review total show NT$7,777', (await $(page, '#goQuote')).includes('NT$7,777') && (await $(page, '#goReviewTotal')) === '合計 NT$7,777', await $(page, '#goReviewTotal'));
    await click(page, '#goSubmit');
    await waitPosts(w, 2);
    ok('the next POST sends expected_total 7777', w.posts()[1].body.expected_total === 7777, JSON.stringify(w.posts()[1].body.expected_total));
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}

// ── 7. network retry, replay, request_id
{
  const w = world();
  await sx('network error: the same request_id is reused on retry; the Worker had already written -> replay, ONE order; after a definitive answer the id is new', async (page, ok) => {
    await ready(page);
    await addPrint(page);
    await toReview(page);
    w.ctl.failNext = ['net'];
    await click(page, '#goSubmit');
    await page.waitForFunction(() => { const e = document.getElementById('goSubmitError'); return e && !e.hidden && e.textContent.length > 0; }, null, { timeout: 4000 });
    ok('a plain-Chinese network message, and the button is usable again', (await $(page, '#goSubmitError')).includes('無法連線') && await page.evaluate(() => !document.getElementById('goSubmit').disabled), await $(page, '#goSubmitError'));
    w.ctl.dropAfterWrite = true;
    await click(page, '#goSubmit');
    await page.waitForFunction(() => /無法連線/.test(document.getElementById('goSubmitError')?.textContent || ''), null, { timeout: 4000 });
    ok('the Worker wrote the order but the answer was lost: 1 stored order, the page still on review', w.orders.length === 1 && await page.evaluate(() => document.getElementById('goSheet').dataset.step) === 'review');
    await click(page, '#goSubmit');
    await step(page, 'receipt');
    const ps = w.posts();
    ok('3 POSTs, all with the SAME request_id', ps.length === 3 && ps.every(p => p.body.request_id === ps[0].body.request_id), JSON.stringify(ps.map(p => p.body.request_id)));
    ok('the replay answered 200 with the stored order: still ONE order, the receipt shows 待確認', w.orders.length === 1 && (await sheetText(page)).includes('待確認'));
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}
{
  const w = world();
  await sx('request_id is NEW after a definitive error and after an edit; a 5xx keeps it (the outcome is unknown)', async (page, ok) => {
    await ready(page);
    await addPrint(page);
    await toReview(page);
    w.ctl.force = { status: 409, body: { error: 'x', code: 'too_many_open_orders', max: 3 } };
    await click(page, '#goSubmit');
    await page.waitForFunction(() => /3 筆待確認/.test(document.getElementById('goSubmitError')?.textContent || ''), null, { timeout: 4000 });
    await click(page, '#goSubmit');
    await step(page, 'receipt').catch(() => {});
    await waitPosts(w, 2);
    const [a, b] = w.posts();
    ok('definitive 409: the retry has a different request_id', a.body.request_id !== b.body.request_id && UUID4.test(b.body.request_id), JSON.stringify([a.body.request_id, b.body.request_id]));
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}
{
  const w = world();
  await sx('a 500 with no code keeps the request_id for the retry; going back to edit the contact makes a new one', async (page, ok) => {
    await ready(page);
    await addPrint(page);
    await toReview(page);
    w.ctl.failNext = [502];
    await click(page, '#goSubmit');
    await page.waitForFunction(() => (document.getElementById('goSubmitError')?.textContent || '').length > 0, null, { timeout: 4000 });
    ok('a 502 shows a retry message that says the order will not be duplicated', (await $(page, '#goSubmitError')).includes('不會重複'), await $(page, '#goSubmitError'));
    w.ctl.failNext = [502];
    await click(page, '#goSubmit');
    await waitPosts(w, 2);
    ok('the second attempt reused the id', w.posts()[0].body.request_id === w.posts()[1].body.request_id);
    // edit: back to contact, change the name, forward, submit
    await click(page, '#goSheet .go-head .go-icon:not(.go-close)');
    await step(page, 'contact');
    await page.fill('#goName', '王大明');
    await click(page, '#goToReview');
    await step(page, 'review');
    await click(page, '#goSubmit');
    await step(page, 'receipt');
    const ps = w.posts();
    ok('after the edit the id is new (a replay must not swallow a changed order)', ps.length === 3 && ps[2].body.request_id !== ps[0].body.request_id && ps[2].body.contact.name === '王大明', JSON.stringify(ps.map(p => p.body.request_id)));
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}

// ── 8. double tap
{
  const w = world();
  await sx('double tap on 送出訂單: one request in flight, the button is disabled and busy meanwhile', async (page, ok) => {
    await ready(page);
    await addPrint(page);
    await toReview(page);
    w.ctl.delay = 500;
    await page.evaluate(() => { const b = document.getElementById('goSubmit'); b.click(); b.click(); setTimeout(() => b.click(), 100); });
    const mid = await page.evaluate(() => { const b = document.getElementById('goSubmit'); return { d: b.disabled, busy: b.getAttribute('aria-busy') }; });
    ok('disabled and aria-busy while in flight', mid.d && mid.busy === 'true', JSON.stringify(mid));
    await step(page, 'receipt');
    ok('exactly one POST and one order', w.posts().length === 1 && w.orders.length === 1, String(w.posts().length));
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}

// ── 9. every error code, plain Chinese
{
  const w = world();
  // [status, code, text that must appear, where the guest lands]
  const CODES = [
    [403, 'not_owner', '只有挑選人可以下單', 'review'], [409, 'not_confirmed', '確認完成', 'review'], [413, 'too_large', '太大', 'cart'],
    [400, 'invalid_body', '重新整理', 'review'], [400, 'invalid_request_id', '再按一次送出', 'review'], [400, 'invalid_lines', '項目有誤', 'cart'],
    [400, 'too_many_lines', '最多只能放 20', 'cart'], [400, 'invalid_qty', '數量不符', 'cart'], [400, 'invalid_photo_key', '無法使用', 'cart'],
    [400, 'duplicate_line', '重複', 'cart'], [400, 'invalid_spreads', '跨頁數不正確', 'cart'], [400, 'invalid_contact', '電話或 LINE ID', 'contact'],
    [400, 'invalid_delivery', '面交', 'review'], [400, 'consent_required', '同意個資告知', 'contact'], [400, 'invalid_note', '備註', 'contact'],
    [500, 'orders_unavailable', '暫時無法使用', 'review'], [500, 'shop_unavailable', '暫時無法使用', 'review'], [404, 'product_not_offered', '不提供', 'cart'],
    [403, 'not_in_finals', '不在精修成品', 'cart'], [404, 'photo_not_found', '找不到', 'cart'], [400, 'album_not_orderable', '無法線上訂購', 'cart'],
    [400, 'pages_below_min', '不足', 'cart'], [400, 'pages_above_max', '超過上限', 'cart'], [400, 'extra_pages_unpriced', '不能加頁', 'cart'],
    [409, 'delivery_changed', '重新整理', 'review'], [409, 'too_many_open_orders', '3 筆待確認', 'review'], [409, 'order_cap', '已達上限', 'review'],
    [409, 'duplicate_request', '再按一次送出', 'review'], [401, undefined, '連結已失效', 'review'],
  ];
  await sx('every Worker error code answers in plain Chinese (29 forced answers) and leaves the guest where the fix is; the cart survives all of them', async (page, ok) => {
    await ready(page);
    await addPrint(page, { qty: 2 });
    await toReview(page);
    const bad = [];
    let shown = 0;
    for (const [status, code, text, where] of CODES) {
      w.ctl.force = { status, body: code ? { error: code, code } : { error: 'Unauthorized' } };
      const n0 = w.posts().length;
      await click(page, '#goSubmit');
      await waitPosts(w, n0 + 1);
      await page.waitForFunction(() => { const s = document.getElementById('goSheet'); return s && !document.querySelector('#goSubmit[aria-busy="true"]'); }, null, { timeout: 4000 });
      await page.waitForTimeout(30);
      const got = await page.evaluate(() => ({ step: document.getElementById('goSheet').dataset.step, text: document.getElementById('goSheet').textContent, raw: /\b(not_owner|invalid_|orders_unavailable|price_changed|\[object)/.test(document.getElementById('goSheet').textContent) }));
      if (got.step !== where || !got.text.includes(text) || got.raw) bad.push(`${status}/${code}: step=${got.step} want ${where}; has "${text}"=${got.text.includes(text)}; raw=${got.raw}`);
      else shown++;
      // go back to the review step through the forward buttons (the cart and the contact data are kept)
      for (let i = 0; i < 3; i++) {
        const st = await page.evaluate(() => document.getElementById('goSheet').dataset.step);
        if (st === 'review') break;
        if (st === 'cart') await click(page, '#goToContact'); else if (st === 'contact') await click(page, '#goToReview');
        await page.waitForTimeout(40);
      }
    }
    ok(`positive: all ${CODES.length} answers were mapped (${shown} shown correctly)`, shown === CODES.length && bad.length === 0, bad.join(' | '));
    ok('floor: 29 codes were driven', CODES.length === 29);
    ok('the cart is intact after all those errors (one line, 2 copies, NT$6,000)', (await $(page, '#goReviewTotal')) === '合計 NT$6,000');
    ok('nothing was stored by the forced answers', w.orders.length === 0);
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}
{
  const w = world();
  await sx('ordering_disabled while ordering: the sheet closes and the cards fall back to 我有興趣 (no 訂購, no bar)', async (page, ok) => {
    await ready(page);
    await addPrint(page);
    await toReview(page);
    w.ctl.force = { status: 403, body: { error: 'ordering_disabled', code: 'ordering_disabled' } };
    await click(page, '#goSubmit');
    await page.waitForFunction(() => !document.getElementById('goLayer'), null, { timeout: 4000 });
    const r = await page.evaluate(() => ({ order: document.querySelectorAll('.go-order-btn, #goBar').length, interest: document.querySelectorAll('#cpShop .cp-interest-btn').length, locked: document.documentElement.classList.contains('go-open') }));
    ok('positive: a 我有興趣 on all 3 cards, no 訂購, no bar, the page scroll is unlocked', r.order === 0 && r.interest === 3 && !r.locked, JSON.stringify(r));
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}
{
  const w = world({ fake: { ordersUnavailable: true } });
  await sx('before the migration (500 orders_unavailable on every order route): a plain message, no crash, 我的訂單 says it too', async (page, ok) => {
    await ready(page);
    await addPrint(page);
    await toReview(page);
    await click(page, '#goSubmit');
    await page.waitForFunction(() => (document.getElementById('goSubmitError')?.textContent || '').includes('暫時無法使用'), null, { timeout: 4000 });
    ok('the submit error is shown and the button is usable again', await page.evaluate(() => !document.getElementById('goSubmit').disabled));
    await page.evaluate(() => document.querySelector('#goLayer .go-close').click());
    await click(page, '#goBarOrders');
    await page.waitForFunction(() => document.querySelector('#goSheet [role="alert"]'), null, { timeout: 4000 });
    ok('the list shows the same plain message and a retry button', (await sheetText(page)).includes('暫時無法使用') && (await sheetText(page)).includes('重新載入'), await sheetText(page));
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}
{
  const w = world({ fake: { missingKeys: [KEY1] } });
  await sx('natural 404 photo_not_found from the fake\'s own check, and 403 not_in_finals when a photo is not a final', async (page, ok) => {
    await ready(page);
    await addPrint(page, { photo: KEY1 });
    await toReview(page);
    await click(page, '#goSubmit');
    await step(page, 'cart');
    ok('photo_not_found: back on the cart with 找不到', (await sheetText(page)).includes('找不到'), await sheetText(page));
    ok('the Worker stored nothing', w.orders.length === 0);
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}

// ── 10. the Worker contract the fake mirrors (so the suites above mean something)
{
  const w = world();
  await sx('the fake mirrors the documented check order (direct calls: 401, 403, 409, 400 family, 404, 409 quote, replay)', async (page, ok) => {
    await ready(page);
    const call = (method, path, { key = 'ZOE-KEY', body, raw } = {}) => page.evaluate(async ([m, p, k, b, r]) => {
      const res = await fetch(`https://imagepicker.hotichen.workers.dev${p}`, { method: m, headers: { 'X-Share-Token': 'TOK', ...(k ? { 'X-Picker-Key': k } : {}), 'Content-Type': 'application/json' }, body: r ?? (b === undefined ? undefined : JSON.stringify(b)) });
      let d = null; try { d = await res.json(); } catch (e) { /* */ }
      return { s: res.status, c: d && d.code };
    }, [method, path, key, body, raw]);
    const good = () => ({ request_id: '11111111-1111-4111-8111-111111111111', lines: [{ option_id: 'opt-print-1', qty: 1, photo_key: KEY1 }], contact: { name: 'A', phone: '0912345678' }, expected_total: 3000, consent: 'v1' });
    const T = [
      ['viewer (no key) -> 403 not_owner', await call('POST', '/api/pick/orders', { key: '', body: good() }), 403, 'not_owner'],
      ['GET without key -> 403', await call('GET', '/api/pick/orders', { key: '' }), 403, 'not_owner'],
      ['unknown sub path -> 404 not_found', await call('GET', '/api/pick/orders/zzz'), 404, 'not_found'],
      ['DELETE -> 405', await call('DELETE', '/api/pick/orders'), 405, undefined],
      ['body not an object -> 400 invalid_body', await call('POST', '/api/pick/orders', { body: [1] }), 400, 'invalid_body'],
      ['request_id not a uuid -> invalid_request_id', await call('POST', '/api/pick/orders', { body: { ...good(), request_id: 'abc' } }), 400, 'invalid_request_id'],
      ['no lines -> invalid_lines', await call('POST', '/api/pick/orders', { body: { ...good(), lines: [] } }), 400, 'invalid_lines'],
      ['21 lines -> too_many_lines', await call('POST', '/api/pick/orders', { body: { ...good(), lines: Array.from({ length: 21 }, (_, i) => ({ option_id: 'o' + i, qty: 1, photo_key: 'k' })) } }), 400, 'too_many_lines'],
      ['qty 11 -> invalid_qty', await call('POST', '/api/pick/orders', { body: { ...good(), lines: [{ option_id: 'opt-print-1', qty: 11, photo_key: KEY1 }] } }), 400, 'invalid_qty'],
      ['print line without a photo -> invalid_spreads/photo (no spreads either)', await call('POST', '/api/pick/orders', { body: { ...good(), lines: [{ option_id: 'opt-print-1', qty: 1 }] } }), 400, 'invalid_photo_key'],
      ['same option + photo twice -> duplicate_line', await call('POST', '/api/pick/orders', { body: { ...good(), lines: [good().lines[0], good().lines[0]] } }), 400, 'duplicate_line'],
      ['no phone and no LINE -> invalid_contact', await call('POST', '/api/pick/orders', { body: { ...good(), contact: { name: 'A' } } }), 400, 'invalid_contact'],
      ['delivery ship -> invalid_delivery', await call('POST', '/api/pick/orders', { body: { ...good(), delivery: { method: 'ship' } } }), 400, 'invalid_delivery'],
      ['consent v0 -> consent_required', await call('POST', '/api/pick/orders', { body: { ...good(), consent: 'v0' } }), 400, 'consent_required'],
      ['note 501 chars -> invalid_note', await call('POST', '/api/pick/orders', { body: { ...good(), note: 'x'.repeat(501) } }), 400, 'invalid_note'],
      ['expected_total missing -> invalid_body', await call('POST', '/api/pick/orders', { body: { ...good(), expected_total: undefined } }), 400, 'invalid_body'],
      ['unknown option -> 404 product_not_offered', await call('POST', '/api/pick/orders', { body: { ...good(), lines: [{ option_id: 'nope', qty: 1, photo_key: KEY1 }] } }), 404, 'product_not_offered'],
      ['a photo outside the finals -> 403 not_in_finals', await call('POST', '/api/pick/orders', { body: { ...good(), lines: [{ option_id: 'opt-print-1', qty: 1, photo_key: 'shoot/毛片/a.jpg' }] } }), 403, 'not_in_finals'],
      ['print line with spreads -> invalid_lines', await call('POST', '/api/pick/orders', { body: { ...good(), lines: [{ option_id: 'opt-print-1', qty: 1, photo_key: KEY1, spreads: 3 }] } }), 400, 'invalid_lines'],
      ['album below min -> pages_below_min', await call('POST', '/api/pick/orders', { body: { ...good(), lines: [{ option_id: 'opt-album-1', qty: 1, spreads: 9 }], expected_total: 5000 } }), 400, 'pages_below_min'],
      ['album above max -> pages_above_max', await call('POST', '/api/pick/orders', { body: { ...good(), lines: [{ option_id: 'opt-album-1', qty: 1, spreads: 31 }], expected_total: 5000 } }), 400, 'pages_above_max'],
      ['album with no min_pages -> album_not_orderable', await call('POST', '/api/pick/orders', { body: { ...good(), lines: [{ option_id: 'opt-x-1', qty: 1, spreads: 10 }], expected_total: 9000 } }), 400, 'album_not_orderable'],
      ['album qty 4 -> invalid_qty (after the catalogue)', await call('POST', '/api/pick/orders', { body: { ...good(), lines: [{ option_id: 'opt-album-1', qty: 4, spreads: 10 }], expected_total: 20000 } }), 400, 'invalid_qty'],
      ['wrong expected_total -> 409 price_changed', await call('POST', '/api/pick/orders', { body: { ...good(), expected_total: 1 } }), 409, 'price_changed'],
      ['the good order -> 201', await call('POST', '/api/pick/orders', { body: good() }), 201, undefined],
      ['the same request_id again -> 200 replay (not a second order)', await call('POST', '/api/pick/orders', { body: { ...good(), expected_total: 1 } }), 200, undefined],
    ];
    const bad = T.filter(([, r, s, c]) => r.s !== s || (c !== undefined && r.c !== c)).map(([n, r]) => `${n}: ${r.s}/${r.c}`);
    ok(`all ${T.length} documented answers match`, bad.length === 0, bad.join(' | '));
    ok('floor: 26 cases ran and exactly one order exists', T.length === 26 && w.orders.length === 1);
    // the cap of 3 open orders and the cancel route
    for (let i = 2; i <= 4; i++) {
      const r = await call('POST', '/api/pick/orders', { body: { ...good(), request_id: `11111111-1111-4111-8111-11111111111${i}`, lines: [{ option_id: 'opt-print-1', qty: 1, photo_key: i === 2 ? KEY2 : `shoot/精修/IMG_000${i + 1}.jpg` }] } });
      if (i < 4 && r.s !== 201) bad.push(`order ${i}: ${r.s}`);
      if (i === 4) ok('the 4th open order -> 409 too_many_open_orders', r.s === 409 && r.c === 'too_many_open_orders', JSON.stringify(r));
    }
    const id = w.orders[0].id;
    const c1 = await call('POST', `/api/pick/orders/${id}/cancel`);
    const c2 = await call('POST', `/api/pick/orders/${id}/cancel`);
    w.confirm(w.orders[1].id);
    const c3 = await call('POST', `/api/pick/orders/${w.orders[1].id}/cancel`);
    ok('cancel: requested -> 200, again -> 200 (nothing written), confirmed -> 409 bad_transition', c1.s === 200 && c2.s === 200 && c3.s === 409 && c3.c === 'bad_transition', JSON.stringify([c1, c2, c3]));
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}

// ── 11. my orders: statuses, transfer info, cancel
{
  const w = world();
  w.seed({ status: 'requested' });
  const conf = w.seed({ status: 'confirmed', total: 4500, confirmed_at: '2026-10-02T03:00:00.000Z', items: [{ kind: 'album', name: '相本書', option_label: '20×20', qty: 1, unit_price: 4500, photo_name: null, spreads: 12 }] });
  w.seed({ status: 'fulfilled', total: 1000 });
  w.seed({ status: 'cancelled', total: 800 });
  await sx('我的訂單: 待確認 / 已確認 / 已完成 / 已取消; transfer info only where the Worker sent it (confirmed, fulfilled); 取消 only on requested', async (page, ok) => {
    await ready(page);
    await click(page, '#goBarOrders');
    await step(page, 'orders');
    await page.waitForSelector('#goOrders .go-order', { timeout: 4000 });
    const cards = await page.evaluate(() => [...document.querySelectorAll('#goOrders .go-order')].map(c => ({ st: c.dataset.status, label: c.querySelector('.go-status').textContent, transfer: !!c.querySelector('.go-transfer'), tt: c.querySelector('.go-transfer-text')?.textContent ?? null, cancel: !!c.querySelector('.go-cancel'), text: c.textContent })));
    ok('positive floor: 4 orders, newest first (cancelled, fulfilled, confirmed, requested)', cards.length === 4 && cards.map(c => c.st).join() === 'cancelled,fulfilled,confirmed,requested', cards.map(c => c.st).join());
    ok('labels: 已取消 / 已完成 / 已確認 / 待確認', cards.map(c => c.label).join() === '已取消,已完成,已確認,待確認', cards.map(c => c.label).join());
    ok('the transfer text appears on confirmed and fulfilled only, as the Worker wrote it (line break kept in text)', cards.map(c => c.transfer).join() === 'false,true,true,false' && cards[2].tt.includes('000-123 王小明') && cards[2].tt.includes('\n'), JSON.stringify(cards.map(c => [c.st, c.transfer])));
    ok('取消 is offered on the requested order only', cards.map(c => c.cancel).join() === 'false,false,false,true', cards.map(c => c.cancel).join());
    ok('the album line reads 12 跨頁', cards[2].text.includes('12 跨頁'));
    await layout(page, 'orders list', ok);
    // cancel: two taps, one request
    await page.evaluate(() => document.querySelector('#goOrders .go-cancel').click());
    ok('the first tap only asks 確定取消 (no request yet)', w.reqs.filter(r => r.path.endsWith('/cancel')).length === 0 && await page.evaluate(() => !document.querySelector('.go-cancel-sure').hidden));
    await page.evaluate(() => document.querySelector('.go-cancel-sure').click());
    await page.waitForFunction(() => document.querySelectorAll('#goOrders .go-cancel').length === 0, null, { timeout: 4000 });
    const cr = w.reqs.filter(r => r.path.endsWith('/cancel'));
    ok('one POST to /api/pick/orders/<id>/cancel, token in the query, key only in the header', cr.length === 1 && cr[0].method === 'POST' && cr[0].key === 'ZOE-KEY' && cr[0].search === '?t=TOK' && !cr[0].path.includes('ZOE'), JSON.stringify(cr));
    ok('the card now says 已取消 and the Worker agrees', await page.evaluate(() => [...document.querySelectorAll('#goOrders .go-status')].map(s => s.textContent).join()) === '已取消,已完成,已確認,已取消' && w.orders[0].status === 'cancelled');
    ok('the confirmed order is untouched', w.orders.find(o => o.id === conf.id).status === 'confirmed');
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}
{
  const w = world();
  const o = w.seed({ status: 'requested' });
  await sx('cancel races an admin confirm: 409 bad_transition -> plain message and the list is re-read (now 已確認 with the transfer text)', async (page, ok) => {
    await ready(page);
    await click(page, '#goBarOrders');
    await page.waitForSelector('#goOrders .go-cancel', { timeout: 4000 });
    w.confirm(o.id);   // the photographer confirmed after the list was loaded
    await page.evaluate(() => document.querySelector('#goOrders .go-cancel').click());
    await page.evaluate(() => document.querySelector('.go-cancel-sure').click());
    await page.waitForFunction(() => document.querySelector('#goOrders .go-status')?.textContent === '已確認', null, { timeout: 4000 });
    ok('the list re-read: 已確認, transfer text now visible, no 取消', await page.evaluate(() => !!document.querySelector('.go-transfer') && !document.querySelector('.go-cancel')));
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}
{
  const w = world();
  w.ctl.leakTransfer = true;
  w.seed({ status: 'requested' });
  await sx('a Worker that wrongly sends transfer_info on a 待確認 order: the page still does not show it', async (page, ok) => {
    await ready(page);
    await click(page, '#goBarOrders');
    await page.waitForSelector('#goOrders .go-order', { timeout: 4000 });
    ok('control: the fake really leaks it in the answer', w.view(w.orders[0]).transfer_info !== null);
    ok('positive: the requested card is there; no 付款方式, no transfer text', await count(page, '#goOrders .go-order--requested') === 1 && await page.evaluate(() => !document.querySelector('.go-transfer') && !document.getElementById('goSheet').textContent.includes('000-123')));
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}
{
  const w = world();
  await sx('no orders yet: 你還沒有訂單', async (page, ok) => {
    await ready(page);
    await click(page, '#goBarOrders');
    await page.waitForFunction(() => document.getElementById('goSheet')?.textContent.includes('你還沒有訂單'), null, { timeout: 4000 });
    ok('empty list message, GET /api/pick/orders sent once with the key in the header', w.reqs.filter(r => r.method === 'GET').length === 1 && w.reqs[0].key === 'ZOE-KEY' && w.reqs[0].search === '?t=TOK');
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}

// ── 12. escaping, theme, scope
{
  const evil = '<img src=x onerror="window.__xss=1">商品';
  const products = catalogue();
  products[0].name = evil;
  products[0].options[0].label = '<b id=pwn>x</b>';
  const w = world({ products });
  await sx('everything dynamic goes through textContent: a product name / option label / note with HTML stays text', async (page, ok) => {
    await ready(page);
    await click(page, '.go-order-btn[data-product-id="prod-print"]');
    await step(page, 'product');
    await page.waitForSelector('.go-photo');
    await click(page, '.go-opt[data-option-id="opt-print-1"]');
    await click(page, `.go-photo[data-photo-key="${KEY1}"]`);
    await click(page, '#goAdd');
    await step(page, 'cart');
    await toReview(page, { name: '<i id=nm>王</i>', note: '<script>window.__xss=2</script>' });
    ok('the sheet shows the text literally', (await sheetText(page)).includes(evil) && (await sheetText(page)).includes('<i id=nm>'));
    await click(page, '#goSubmit');
    await step(page, 'receipt');
    await page.waitForTimeout(150);
    ok('no element was injected, no script ran', await page.evaluate(() => !document.getElementById('pwn') && !document.getElementById('nm') && !window.__xss && !document.querySelector('#goSheet script, #goSheet img[src="x"]')));
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}
{
  const w = world();
  await sx('theme and scope: the sheet lives inside the light .cp page, is light, and does not touch the dark :root', async (page, ok) => {
    await ready(page);
    await click(page, '.go-order-btn[data-product-id="prod-print"]');
    await step(page, 'product');
    const r = await page.evaluate(() => {
      const s = document.getElementById('goSheet');
      const m = getComputedStyle(s).backgroundColor.match(/[\d.]+/g).map(Number);
      const lum = (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
      return { inCp: !!s.closest('.cp'), lum, rootBg: getComputedStyle(document.documentElement).getPropertyValue('--bg-primary') };
    });
    ok('inside .cp and light (luminance > 0.9)', r.inCp && r.lum > 0.9, JSON.stringify(r));
    ok('the page scroll is locked while open and unlocked on close', await page.evaluate(() => document.documentElement.classList.contains('go-open')));
    await click(page, '#goSheet .go-close');
    ok('closing removes the layer and the lock', await page.evaluate(() => !document.getElementById('goLayer') && !document.documentElement.classList.contains('go-open')));
    ok('Escape also closes it', await (async () => { await click(page, '.go-order-btn[data-product-id="prod-print"]'); await step(page, 'product'); await page.keyboard.press('Escape'); await page.waitForTimeout(80); return page.evaluate(() => !document.getElementById('goLayer')); })());
  }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}

}
