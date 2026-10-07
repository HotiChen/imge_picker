// Browser suites: 「我有興趣」 on the 完成頁 product cards (docs/guest-shop.md, "Product interest") and the
// photographer's 客人興趣 list in admin.html. The fake Worker (test/lib/pick-fake.mjs, POST /api/pick/interest)
// mirrors the Worker's status codes and order of checks. Registered by test/run.mjs in file-name order.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { ALB_DESK, albumWorld } from '../lib/album-world.mjs';
import { shopProductsFake } from '../lib/pick-fake.mjs';

export default async function register() {

const T0 = '2026-09-21T03:00:00.000Z';
const STUDIO = { name: '光影工作室', booking_url: 'https://studio.example/book', has_logo: true };
const OWNER = "localStorage.setItem('pick_key:TOK', 'ZOE-KEY');";
const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const sx = (name, url, run, opts) => suite(name, url, async page => {
  const out = [], ok = line(out);
  try { await run(page, ok); } catch (e) { out.push(`FAIL  threw after ${out.length} lines: ${String(e.message).split('\n')[0]}`); }
  return out;
}, opts);
const world = (o = {}) => {
  const products = o.products || shopProductsFake();
  const w = albumWorld({ n: 12, fake: { title: '婚禮精修', confirmedAt: T0, studio: STUDIO, shopProducts: products, ...(o.fake || {}) } });
  w.products = products;
  return w;
};
const interestPosts = w => w.m.requests.filter(r => r.path === '/api/pick/interest');
const ready = async page => { await page.waitForSelector('#cpShop .cp-product', { timeout: 6000 }); };
// the visible state of one card's button: text, disabled, and the line under it
const card = (page, id) => page.evaluate(i => {
  const b = document.querySelector(`#cpShop .cp-interest-btn[data-product-id="${i}"]`);
  if (!b) return null;
  return { text: b.textContent, disabled: b.disabled, msg: b.parentElement.querySelector('.cp-interest-msg').textContent, display: getComputedStyle(b).display };
}, id);
const click = (page, id) => page.evaluate(i => document.querySelector(`#cpShop .cp-interest-btn[data-product-id="${i}"]`).click(), id);

// ── 1. owner: heading, a button on every card, one POST, the right shape, key only in the header
{
  const w = world();
  await sx('product interest — owner 390px: heading 把這段回憶留下來, a 我有興趣 button on each card, one tap = one POST with the id, key in the header only; the tapped card turns into a disabled 已通知攝影師',
    `${base}/index.html?t=TOK`, async (page, ok) => {
      await ready(page);
      const h = await page.evaluate(() => ({ h: document.querySelector('#cpShop .cp-h2').textContent, sub: document.querySelector('#cpShop .cp-sub').textContent, cards: document.querySelectorAll('#cpShop .cp-product').length, btns: document.querySelectorAll('#cpShop .cp-interest-btn').length, all: document.getElementById('completionPage').textContent }));
      ok('heading is 把這段回憶留下來 and the sub line is 有些照片，值得變成真正的作品。', h.h === '把這段回憶留下來' && h.sub === '有些照片，值得變成真正的作品。', JSON.stringify(h));
      ok('the old heading 商品與加購 is gone', !h.all.includes('商品與加購'));
      ok('positive: 2 cards, 2 buttons (print and album), both labelled 我有興趣 and displayed',
        h.cards === 2 && h.btns === 2 && (await card(page, 'prod-print')).text === '我有興趣' && (await card(page, 'prod-album')).display !== 'none', JSON.stringify(h));
      ok('no price pressure and no cart: no input / select / textarea, and the only buttons are the two 我有興趣',
        await page.evaluate(() => !document.querySelector('#cpShop input, #cpShop select, #cpShop textarea') && document.querySelectorAll('#cpShop button').length === 2));
      ok('no request before the tap', interestPosts(w).length === 0);
      await click(page, 'prod-album');
      await page.waitForFunction(() => document.querySelector('.cp-interest-btn[data-product-id="prod-album"]').textContent === '已通知攝影師', null, { timeout: 3000 });
      const posts = interestPosts(w);
      ok('exactly one POST, method POST, body {product_id:"prod-album"}', posts.length === 1 && posts[0].method === 'POST' && JSON.stringify(posts[0].body) === '{"product_id":"prod-album"}', JSON.stringify(posts));
      ok('token in the query (?t=TOK), the key ZOE-KEY only as the X-Picker-Key header, never in the URL', posts[0].t === 'TOK' && posts[0].key === 'ZOE-KEY' && posts[0].search === '?t=TOK' && !posts[0].search.includes('ZOE'), JSON.stringify(posts[0]));
      const a = await card(page, 'prod-album'), p = await card(page, 'prod-print');
      ok('the album button now reads 已通知攝影師 and is disabled; the print button is untouched (我有興趣, enabled)', a.text === '已通知攝影師' && a.disabled && p.text === '我有興趣' && !p.disabled, JSON.stringify([a, p]));
      await click(page, 'prod-album');
      await page.waitForTimeout(250);
      ok('a further click on the disabled button sends nothing', interestPosts(w).length === 1);
      ok('the Worker recorded one tap', w.m.state.interests.length === 1 && w.m.state.interests[0].product_id === 'prod-album' && w.m.state.interests[0].tap_count === 1);
      ok('no horizontal scroll at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    }, { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}

// ── 2. a viewer: no button, no call
{
  const w = world();
  await sx('product interest — viewer (no seat key): the cards are there, no 我有興趣 button, no POST ever',
    `${base}/index.html?t=TOK`, async (page, ok) => {
      await ready(page);
      ok('positive: the shop shows its 2 cards', (await page.$$('#cpShop .cp-product')).length === 2);
      ok('no interest button in the DOM and no button text 我有興趣 anywhere', await page.evaluate(() => !document.querySelector('.cp-interest-btn, .cp-interest') && !document.getElementById('completionPage').textContent.includes('我有興趣')));
      await page.waitForTimeout(300);
      ok('no POST /api/pick/interest', interestPosts(w).length === 0);
    }, { before: w.before, contextOptions: ALB_DESK });
}

// ── 3. double tap: one request while in flight, the button is disabled and busy meanwhile
{
  const w = world({ fake: { interestDelay: 500 } });
  await sx('product interest — a double tap sends one request; the button is disabled while it is in flight',
    `${base}/index.html?t=TOK`, async (page, ok) => {
      await ready(page);
      await page.evaluate(() => { const b = document.querySelector('.cp-interest-btn[data-product-id="prod-print"]'); b.click(); b.click(); b.click(); });
      const mid = await card(page, 'prod-print');
      ok('in flight: disabled', mid.disabled, JSON.stringify(mid));
      await page.waitForFunction(() => document.querySelector('.cp-interest-btn[data-product-id="prod-print"]').textContent === '已通知攝影師', null, { timeout: 4000 });
      ok('exactly one POST for three taps', interestPosts(w).length === 1, String(interestPosts(w).length));
      ok('the tap counted once in the Worker', w.m.state.interests[0].tap_count === 1);
    }, { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}

// ── 4. already:true reads the same
{
  const w = world({ fake: { interests: [{ product_id: 'prod-album', product_name: '相本書', product_kind: 'album', first_at: T0, last_at: T0, tap_count: 2 }] } });
  await sx('product interest — the Worker answers already:true: the same 已通知攝影師 disabled state, nothing different shown',
    `${base}/index.html?t=TOK`, async (page, ok) => {
      await ready(page);
      ok('fixture: the page does not know about the earlier tap (button says 我有興趣)', (await card(page, 'prod-album')).text === '我有興趣');
      await click(page, 'prod-album');
      await page.waitForFunction(() => document.querySelector('.cp-interest-btn[data-product-id="prod-album"]').textContent === '已通知攝影師', null, { timeout: 3000 });
      const a = await card(page, 'prod-album');
      ok('same text 已通知攝影師, disabled, no message', a.text === '已通知攝影師' && a.disabled && a.msg === '', JSON.stringify(a));
      ok('the Worker counted it as a repeat (tap_count 3)', w.m.state.interests[0].tap_count === 3);
    }, { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}

// ── 5. every error: plain Chinese under the button, the button usable again, retry works
{
  const w = world();
  const S = w.m.state;
  await sx('product interest — errors (401 / 403 / 409 / 404 / cap): a plain Chinese line under the button, the button usable again, and a retry succeeds',
    `${base}/index.html?t=TOK`, async (page, ok) => {
      await ready(page);
      const tryTap = async id => {
        const before = interestPosts(w).length;
        await click(page, id);
        for (let i = 0; i < 40 && interestPosts(w).length === before; i++) await page.waitForTimeout(50);
        await page.waitForFunction(i => !document.querySelector(`.cp-interest-btn[data-product-id="${i}"]`).disabled || document.querySelector(`.cp-interest-btn[data-product-id="${i}"]`).textContent === '已通知攝影師', id, { timeout: 3000 });
        return card(page, id);
      };
      const failCase = async (label, arm, disarm, expect) => {
        arm();
        const c = await tryTap('prod-print');
        ok(`${label}: message "${expect}", button enabled and still 我有興趣`, c.msg === expect && !c.disabled && c.text === '我有興趣', JSON.stringify(c));
        disarm();
      };
      const owner = S.project.owner_picker_id;
      await failCase('403 not_owner (seat reset)', () => { S.project.owner_picker_id = null; }, () => { S.project.owner_picker_id = owner; }, '只有挑選人可以通知攝影師');
      await failCase('409 not_confirmed (reopened)', () => { S.project.client_confirmed_at = null; }, () => { S.project.client_confirmed_at = T0; }, '請先確認完成後再試');
      await failCase('401 (link dead)', () => { S.project.archived_at = T0; }, () => { S.project.archived_at = null; }, '連結已失效');
      const idx = w.products.findIndex(x => x.id === 'prod-print'), removed = w.products[idx];
      await failCase('404 not_found (product no longer offered)', () => { w.products.splice(idx, 1); }, () => { w.products.splice(idx, 0, removed); }, '這個商品目前不提供');
      const seeded = S.interests;
      await failCase('409 interest_cap (20 other products)', () => { S.interests = Array.from({ length: 20 }, (_, i) => ({ product_id: `x${i}`, product_name: 'x', product_kind: 'print', first_at: T0, last_at: T0, tap_count: 1 })); }, () => { S.interests = seeded; }, '已通知多項商品，請直接聯絡攝影師');
      ok('none of the failed taps was recorded', S.interests.length === 0);
      const c = await tryTap('prod-print');
      ok('retry on the same button, everything healthy again: 已通知攝影師 and the message is cleared', c.text === '已通知攝影師' && c.disabled && c.msg === '', JSON.stringify(c));
      ok('the Worker has the row now', S.interests.length === 1 && S.interests[0].product_id === 'prod-print');
    }, { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}

for (const [name, fake] of [['a dropped connection', { interestFail: 'net' }], ['500 interest_unavailable (migration not run)', { interestUnavailable: true }]]) {
  const w = world({ fake });
  await sx(`product interest — ${name}: 暫時無法通知，請稍後再試 under the button, the button usable, nothing marked as notified`,
    `${base}/index.html?t=TOK`, async (page, ok) => {
      await ready(page);
      await click(page, 'prod-album');
      await page.waitForFunction(() => document.querySelector('.cp-interest-btn[data-product-id="prod-album"]').parentElement.querySelector('.cp-interest-msg').textContent !== '', null, { timeout: 3000 });
      const c = await card(page, 'prod-album');
      ok('message and usable button', c.msg === '暫時無法通知，請稍後再試' && !c.disabled && c.text === '我有興趣', JSON.stringify(c));
      ok('positive: the request was really sent', name.startsWith('a dropped') ? true : interestPosts(w).length === 1);
      ok('the message sits under the button (same card, after it)', await page.evaluate(() => { const b = document.querySelector('.cp-interest-btn'); const m = b.parentElement.querySelector('.cp-interest-msg'); return !!(b.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING); }));
      await click(page, 'prod-album');
      await page.waitForTimeout(300);
      ok('a second tap is allowed (a retry request goes out)', name.startsWith('a dropped') ? true : interestPosts(w).length === 2);
    }, { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}

// ── 6. a product without a usable id gets no button (the Worker could not find it anyway)
{
  const w = world({ products: shopProductsFake({ print: { id: 12 } }) });
  await sx('product interest — a product whose id is not a string has no button; the other card keeps its own',
    `${base}/index.html?t=TOK`, async (page, ok) => {
      await ready(page);
      ok('print card (numeric id): no button; album card: has one', await page.evaluate(() => { const c = [...document.querySelectorAll('#cpShop .cp-product')]; return c.length === 2 && !c[0].querySelector('button') && !!c[1].querySelector('.cp-interest-btn'); }));
    }, { before: w.before, initScript: OWNER, contextOptions: ALB_DESK });
}

// ── 7. admin: the 客人興趣 list
{
  const EVIL = '<img src=x onerror="window.__pwned=1"><b>x</b>';
  const w = world({ fake: { projectId: 'proj-1', interests: [
    { product_id: 'a', product_name: '相本書', product_kind: 'album', first_at: '2026-09-22T01:00:00.000Z', last_at: '2026-09-22T01:00:00.000Z', tap_count: 1 },
    { product_id: 'b', product_name: EVIL, product_kind: 'print', first_at: '2026-09-23T01:00:00.000Z', last_at: '2026-09-25T04:30:00.000Z', tap_count: 3 },
    { product_id: 'c', product_name: '謝卡', product_kind: 'service', first_at: '2026-09-23T01:00:00.000Z', last_at: '2026-09-24T01:00:00.000Z', tap_count: 2 },
  ] } });
  await sx('admin 客人興趣 — the detail lists each product (name as text, kind 相本 / 無框畫 / 其他, 最近 時間・點 N 次), newest first',
    `${base}/admin.html#project=proj-1`, async (page, ok) => {
      await page.waitForSelector('#pd-interests', { timeout: 6000 });
      const r = await page.evaluate(() => ({ head: document.querySelector('#pd-interests h4').textContent, rows: [...document.querySelectorAll('#pd-interests li')].map(li => ({ name: li.querySelector('strong').textContent, kind: li.querySelector('.pd-int-kind').textContent, meta: li.querySelector('.pd-int-meta').textContent })),
        title: !!document.getElementById('pd-title'), rename: !!document.getElementById('pd-rename-btn'), delivery: !!document.getElementById('pd-delivery'), pwned: window.__pwned, inj: !!document.querySelector('#pd-interests img, #pd-interests b') }));
      ok('block titled 客人興趣, three rows, newest tap first (b, c, a)', r.head === '客人興趣' && r.rows.map(x => x.name).join('|') === [EVIL, '謝卡', '相本書'].join('|'), JSON.stringify(r.rows));
      ok('kinds: 無框畫 / 其他 / 相本', r.rows.map(x => x.kind).join('|') === '無框畫|其他|相本', JSON.stringify(r.rows));
      ok('meta: 最近 09/25 12:30・點 3 次 (Taipei), 點 2 次, 點 1 次', /^最近 .*12:30・點 3 次$/.test(r.rows[0].meta) && r.rows[1].meta.endsWith('・點 2 次') && r.rows[2].meta.endsWith('・點 1 次'), JSON.stringify(r.rows.map(x => x.meta)));
      ok('a hostile product name stayed text: no <img> / <b> built, window.__pwned unset', !r.inj && r.pwned === undefined);
      ok('the rest of the detail is intact (title, 改名, delivery block)', r.title && r.rename && r.delivery, JSON.stringify(r));
    }, { before: w.before, initScript: ADMIN, contextOptions: ALB_DESK });
}
{
  const w = world({ fake: { projectId: 'proj-1' } });
  await sx('admin 客人興趣 — no interests: the block is not in the DOM, the detail is otherwise there',
    `${base}/admin.html#project=proj-1`, async (page, ok) => {
      await page.waitForSelector('#pd-title', { timeout: 6000 });
      await page.waitForSelector('#pd-delivery', { timeout: 3000 });
      ok('positive: the detail rendered (title + delivery block) and the Worker answered interests: []', !!(await page.$('#pd-delivery')) && Array.isArray(w.m.state.interests) && w.m.state.interests.length === 0);
      ok('no #pd-interests and no 客人興趣 text', (await page.$('#pd-interests')) === null && !(await page.textContent('#project-detail-body')).includes('客人興趣'));
    }, { before: w.before, initScript: ADMIN, contextOptions: ALB_DESK });
}

}
