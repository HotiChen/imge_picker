// Browser suites: product 分類 (platform_products.category) — Util.groupByCategory, the operator catalogue
// (grouping, form, error texts), the photographer's 從平台加入 picker + adopted list, and the guest shop on the 完成頁.
// Fakes mirror the Worker: test/lib/orders-fake.mjs (category read / write / invalid_category / category_unavailable /
// platform_managed), pick-fake's shop products carry the field as the Worker sends it. Suite names start with "商品分類".
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { SEED_TOKEN, dashSettingsMock } from '../lib/dashboard-mocks.mjs';
import { ALB_DESK, albumWorld } from '../lib/album-world.mjs';
import { SHOP_ALBUM_FAKE, SHOP_PRINT_FAKE } from '../lib/pick-fake.mjs';
import { OP_SEED, PLAT_ALBUM, PLAT_PRINT, PROD_ALBUM, PROD_PRINT, clone, ordersFake } from '../lib/orders-fake.mjs';

export default async function register() {

const XSS = '<img src=x onerror=window.__pwn=1>';
const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const run = (name, url, fn, opts) => suite(`商品分類 — ${name}`, url, async page => {
  const out = [], ok = line(out);
  try { await fn(page, ok); } catch (e) { out.push(`FAIL  threw after ${out.length} lines: ${String(e.message).split('\n')[0]}`); }
  return out;
}, opts);
const noHScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

// platform catalogue: 婚紗相本 holds two (sorts 5 and 2 -> the group sorts as 2), 無框畫類 sort 1, one uncategorised (sort 0, still last)
const platform = (over = {}) => {
  const a = { ...clone(PLAT_ALBUM), category: '婚紗相本', sort: 5 };
  const p = { ...clone(PLAT_PRINT), category: '無框畫類', sort: 1, ...(over.print || {}) };
  const a2 = { ...clone(PLAT_ALBUM), id: 'plat-album2', name: '紀念相本', category: '婚紗相本', sort: 2, has_image: false,
    options: [{ id: 'popt-a2', label: '', vendor_cost: 100, platform_price: 200, active: 1, sort: 0 }] };
  const misc = { ...clone(PLAT_PRINT), id: 'plat-misc', name: '雜項', category: null, sort: 0, options: [{ id: 'popt-misc', label: '', vendor_cost: 10, platform_price: 20, active: 1, sort: 0 }] };
  return [a, p, misc, a2];
};

// ── Util.groupByCategory (unit-style, in the browser) ──
await run('Util.groupByCategory：依成員最小 sort 排組、未分類最後、組內保持原順序、分類當資料', `${base}/operator.html`, async (page, ok) => {
  const g = await page.evaluate(({ XSS }) => {
    const G = Util.groupByCategory;
    const P = (id, category, sort) => ({ id, category, ...(sort === undefined ? {} : { sort }) });
    const ids = r => r.map(x => `${x.name}:${x.items.map(i => i.id).join('')}`).join('|');
    return {
      main: ids(G([P('a', 'X', 5), P('b', null, 0), P('c', 'Y', 1), P('d', 'X', 2), P('e', 'X', 3)])),
      noSort: ids(G([P('a', 'X'), P('b', 'Y'), P('c', 'X'), P('d', null)])),
      trim: ids(G([P('a', ' X '), P('b', 'X'), P('c', '  '), P('d', ''), P('e', 5), P('f', undefined)])),
      empty: G([]).length, notArray: G(null).length,
      onlyNull: ids(G([P('a', null), P('b', null)])),
      tie: ids(G([P('a', 'Q', 1), P('b', 'R', 1)])),
      xss: G([P('a', XSS, 0)])[0].name === XSS,
      nullNameIsNull: G([P('a', null)])[0].name === null,
      sameRef: (() => { const it = P('a', 'X', 0); return G([it])[0].items[0] === it; })(),
    };
  }, { XSS });
  ok('groups ordered by the smallest sort of their members (Y=1 before X=2), 未分類 (sort 0) last; X keeps its input order a,d,e', g.main === 'Y:c|X:ade|null:b', g.main);
  ok('with no sort at all: by first appearance, null last', g.noSort === 'X:ac|Y:b|null:d', g.noSort);
  ok('the name is trimmed; blank, empty and non-string categories are 未分類', g.trim === 'X:ab|null:cdef', g.trim);
  ok('empty / non-array input gives no groups', g.empty === 0 && g.notArray === 0);
  ok('all-null is ONE group named null', g.onlyNull === 'null:ab', g.onlyNull);
  ok('equal sorts keep first appearance', g.tie === 'Q:a|R:b', g.tie);
  ok('a category with markup is returned as the plain string (not escaped, not parsed)', g.xss === true);
  ok('the uncategorised name is null (not the string 未分類)', g.nullNameIsNull === true);
  ok('items are the same objects, not copies', g.sameRef === true);
});

// ── operator list ──
{
  const o = ordersFake({ platform: platform(), products: [] });
  await run('營運：商品依分類分組（最小 sort 的組在前、未分類最後），標題與商品列的分類標籤', `${base}/operator.html`, async (page, ok) => {
    await page.waitForSelector('#op-list .prod-row', { timeout: 5000 });
    const r = await page.evaluate(() => ({
      heads: [...document.querySelectorAll('#op-list .cat-head')].map(h => h.firstChild.textContent),
      groups: [...document.querySelectorAll('#op-list .cat-group')].map(g => [...g.querySelectorAll('.prod-row')].map(x => x.dataset.productId).join()),
      pill: document.querySelector('[data-product-id="plat-print"] .pill[data-category]')?.textContent ?? null,
      miscPill: !!document.querySelector('[data-product-id="plat-misc"] .pill[data-category]'),
      rows: document.querySelectorAll('#op-list .prod-row').length,
    }));
    ok('three headings: 無框畫類 (sort 1), 婚紗相本 (min sort 2), 未分類 last', r.heads.join('|') === '無框畫類|婚紗相本|未分類', JSON.stringify(r.heads));
    ok('rows sit in their group, in the existing order', r.groups.join('|') === 'plat-print|plat-album,plat-album2|plat-misc', JSON.stringify(r.groups));
    ok('positive: all 4 rows are there and the category shows on its row; an uncategorised row has no tag', r.rows === 4 && r.pill === '無框畫類' && r.miscPill === false, JSON.stringify(r));
    await page.setViewportSize({ width: 390, height: 800 });
    ok('390px: no horizontal scroll', await noHScroll(page));
  }, { before: o.attach, initScript: OP_SEED });
}
{
  const o = ordersFake({ platform: platform().map(p => ({ ...p, category: null })), products: [] });
  await run('營運：全部未分類時清單和以前一樣（沒有標題、沒有分類標籤）', `${base}/operator.html`, async (page, ok) => {
    await page.waitForSelector('#op-list .prod-row', { timeout: 5000 });
    const r = await page.evaluate(() => ({ rows: document.querySelectorAll('#op-list > .prod-row').length, heads: document.querySelectorAll('#op-list .cat-head, #op-list .cat-group').length, pills: document.querySelectorAll('.pill[data-category]').length }));
    ok('positive: 4 rows directly under the list', r.rows === 4, JSON.stringify(r));
    ok('no headings, no groups, no category tags', r.heads === 0 && r.pills === 0, JSON.stringify(r));
  }, { before: o.attach, initScript: OP_SEED });
}
{
  const o = ordersFake({ platform: platform({ print: { category: XSS } }), products: [] });
  await run('營運：分類是資料——<img onerror> 當分類只顯示成文字（標題、標籤、datalist、輸入框）', `${base}/operator.html`, async (page, ok) => {
    await page.waitForSelector('#op-list .prod-row', { timeout: 5000 });
    await page.click('[data-product-id="plat-print"] [data-edit]');
    await page.waitForSelector('#op-form');
    const r = await page.evaluate(({ XSS }) => ({
      head: [...document.querySelectorAll('#op-list .cat-head')].map(h => h.firstChild.textContent).includes(XSS),
      pill: document.querySelector('[data-product-id="plat-print"] .pill[data-category]')?.textContent === XSS,
      imgs: document.querySelectorAll('#op-list img[src="x"], #op-form img[src="x"], datalist img').length,
      input: document.getElementById('opf-category').value === XSS,
      listed: [...document.querySelectorAll('#opf-category-list option')].map(x => x.value).includes(XSS),
      pwn: window.__pwn ?? null,
    }), { XSS });
    ok('positive: it shows as the literal text in the heading and the tag, and is in the input and the datalist', r.head && r.pill && r.input && r.listed, JSON.stringify(r));
    ok('no <img> was created and nothing ran', r.imgs === 0 && r.pwn === null, JSON.stringify(r));
  }, { before: o.attach, initScript: OP_SEED });
}

// ── operator form ──
{
  const o = ordersFake({ platform: platform(), products: [] });
  await run('營運：表單的分類欄（20 字、datalist 列出現有分類）；新增與編輯送出 category，清空送 null；改了分類清單重新分組', `${base}/operator.html`, async (page, ok) => {
    await page.waitForSelector('#op-list .prod-row', { timeout: 5000 });
    await page.click('[data-product-id="plat-misc"] [data-edit]');
    await page.waitForSelector('#op-form');
    const f = await page.evaluate(() => ({ max: document.getElementById('opf-category').maxLength, list: document.getElementById('opf-category').getAttribute('list'),
      opts: [...document.querySelectorAll('#opf-category-list option')].map(x => x.value).join('|'), val: document.getElementById('opf-category').value }));
    ok('maxlength 20, bound to the datalist, empty for an uncategorised product', f.max === 20 && f.list === 'opf-category-list' && f.val === '', JSON.stringify(f));
    ok('the datalist has each category in use once (無框畫類, 婚紗相本), not the empty one', f.opts === '婚紗相本|無框畫類' || f.opts === '無框畫類|婚紗相本', f.opts);
    await page.fill('#opf-category', '  婚紗相本 ');
    await page.click('#opf-save');
    await page.waitForFunction(() => !document.getElementById('op-form'), null, { timeout: 4000 });
    const put = o.st.calls.filter(c => c.method === 'PUT' && c.path === '/api/operator/products/plat-misc').at(-1);
    ok('PUT sends the trimmed category', put && put.body.category === '婚紗相本', JSON.stringify(put && put.body.category));
    const g = await page.evaluate(() => [...document.querySelectorAll('#op-list .cat-group')].map(x => x.dataset.categoryGroup + ':' + x.querySelectorAll('.prod-row').length).join('|'));
    ok('the list regrouped: 婚紗相本 now holds 3 and, with the sort-0 product in it, moves first; the uncategorised group is gone', g === '婚紗相本:3|無框畫類:1', g);
    await page.click('[data-product-id="plat-misc"] [data-edit]');
    await page.waitForSelector('#op-form');
    ok('positive: editing it again shows the stored category', (await page.inputValue('#opf-category')) === '婚紗相本');
    await page.fill('#opf-category', '   ');
    await page.click('#opf-save');
    await page.waitForFunction(() => !document.getElementById('op-form'), null, { timeout: 4000 });
    const put2 = o.st.calls.filter(c => c.method === 'PUT' && c.path === '/api/operator/products/plat-misc').at(-1);
    ok('blank sends category: null (clears it)', put2 && put2.body.category === null && 'category' in put2.body, JSON.stringify(put2 && put2.body.category));
    ok('and it is uncategorised again in the list', await page.evaluate(() => !document.querySelector('[data-product-id="plat-misc"] .pill[data-category]')));
    await page.click('#op-add-btn');
    await page.waitForSelector('#op-form');
    await page.fill('#opf-name', '新商品');
    await page.fill('#opf-category', '新分類');
    await page.fill('#opf-options .opt-vendor', '100');
    await page.fill('#opf-options .opt-plat', '150');
    await page.click('#opf-save');
    await page.waitForFunction(() => document.querySelector('#op-form')?.dataset.mode === 'edit', null, { timeout: 4000 });
    const post = o.st.calls.filter(c => c.method === 'POST' && c.path === '/api/operator/products').at(-1);
    ok('POST sends category too', post && post.body.category === '新分類', JSON.stringify(post && post.body));
    ok('the Worker-shaped answer put the new product in its own group', await page.evaluate(() => !!document.querySelector('[data-category-group="新分類"] [data-product-id]')));
    await page.click('#opf-cancel');
    await page.click('#op-add-btn');
    await page.waitForSelector('#op-form');
    await page.fill('#opf-name', '無分類');
    await page.fill('#opf-options .opt-vendor', '1');
    await page.fill('#opf-options .opt-plat', '2');
    await page.click('#opf-save');
    await page.waitForFunction(() => document.querySelector('#op-form')?.dataset.mode === 'edit', null, { timeout: 4000 });
    const post2 = o.st.calls.filter(c => c.method === 'POST' && c.path === '/api/operator/products').at(-1);
    ok('a new product with the field left empty sends category: null', post2 && post2.body.category === null && 'category' in post2.body, JSON.stringify(post2 && post2.body));
    await page.setViewportSize({ width: 390, height: 800 });
    // (the product-picture upload row of an existing product, #opf-file, is 2px wider than the phone on this base: not this change)
    ok('390px: the 分類 field fits the phone', await page.evaluate(() => { const r = document.getElementById('opf-category').getBoundingClientRect(); return r.left >= 0 && r.right <= document.documentElement.clientWidth; }));
    await page.click('#opf-cancel');
    ok('390px: the grouped list does not scroll sideways', await noHScroll(page));
  }, { before: o.attach, initScript: OP_SEED });
}
{
  const o = ordersFake({ platform: platform(), products: [], pageColumns: { category: false } });
  await run('營運：invalid_category 與 category_unavailable 顯示白話中文（伺服器碼，不是通用失敗）', `${base}/operator.html`, async (page, ok) => {
    await page.waitForSelector('#op-list .prod-row', { timeout: 5000 });
    await page.click('[data-product-id="plat-misc"] [data-edit]');
    await page.waitForSelector('#op-form');
    await page.fill('#opf-category', '新分類');
    await page.click('#opf-save');
    await page.waitForFunction(() => document.getElementById('opf-err').textContent.length > 0, null, { timeout: 4000 });
    const t1 = await page.textContent('#opf-err');
    ok('category_unavailable (migration not run): plain Chinese, and the form stays open', t1.includes('商品分類功能尚未啟用') && !!(await page.$('#op-form')), t1);
    await page.evaluate(() => { document.getElementById('opf-category').maxLength = 100; });
    await page.fill('#opf-category', '一二三四五六七八九十一二三四五六七八九十一');
    await page.click('#opf-save');
    await page.waitForFunction(() => document.getElementById('opf-err').textContent.includes('太長'), null, { timeout: 4000 });
    ok('invalid_category (21 characters, field maxlength bypassed): its own sentence', (await page.textContent('#opf-err')).includes('20 字以內'), await page.textContent('#opf-err'));
    ok('positive: an empty category is still saved when the column is missing (null is dropped by the Worker)', await (async () => {
      await page.fill('#opf-category', '');
      await page.click('#opf-save');
      await page.waitForFunction(() => !document.getElementById('op-form'), null, { timeout: 4000 }).catch(() => {});
      return !(await page.$('#op-form'));
    })());
  }, { before: o.attach, initScript: OP_SEED });
}

// ── photographer settings ──
{
  const m = dashSettingsMock();
  const o = ordersFake({ customProducts: true, platform: platform(), products: [clone(PROD_ALBUM), clone(PROD_PRINT)] });
  await run('設定：從平台加入的清單與已加入的商品都依分類分組（唯讀、同樣的順序）', `${base}/settings.html`, async (page, ok) => {
    await page.waitForSelector('.prod-row', { timeout: 5000 });
    const mine = await page.evaluate(() => [...document.querySelectorAll('#prod-list .cat-group, .cat-group')].map(g => g.dataset.categoryGroup + ':' + [...g.querySelectorAll('.prod-row')].map(x => x.dataset.productId).join()));
    ok('the adopted list follows the photographer products own order (album sort 0, print sort 1)', mine.join('|') === '婚紗相本:prod-album|無框畫類:prod-print', JSON.stringify(mine));
    ok('each adopted row shows the platform category', await page.evaluate(() => document.querySelector('[data-product-id="prod-album"] .pill[data-category]')?.textContent === '婚紗相本'));
    await page.click('#plat-add-btn');
    await page.waitForSelector('#plat-form .plat-card', { timeout: 5000 });
    const pick = await page.evaluate(() => ({
      heads: [...document.querySelectorAll('#plat-form .cat-head')].map(h => h.textContent),
      groups: [...document.querySelectorAll('#plat-form .cat-group')].map(g => [...g.querySelectorAll('.plat-card')].map(x => x.dataset.platformId).join()),
      inputs: document.querySelectorAll('#plat-form .cat-group input[type=text]').length,
    }));
    ok('the picker: 無框畫類, 婚紗相本 (plat-album2 sort 2), 未分類 last', pick.heads.join('|') === '無框畫類|婚紗相本|未分類', JSON.stringify(pick.heads));
    ok('cards in their group in the Worker order', pick.groups.join('|') === 'plat-print|plat-album,plat-album2|plat-misc', JSON.stringify(pick.groups));
    await page.setViewportSize({ width: 390, height: 800 });
    ok('390px: no horizontal scroll', await noHScroll(page));
    ok('the photographer has no category field anywhere (read-only)', await page.evaluate(() => !document.querySelector('#prod-form input[id*=categ], #plat-form input[id*=categ]')));
  }, { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}
{
  const m = dashSettingsMock();
  const o = ordersFake({ platform: platform().map(p => ({ ...p, category: null })), products: [clone(PROD_ALBUM)] });
  await run('設定：全部未分類時和以前一樣（沒有標題）', `${base}/settings.html`, async (page, ok) => {
    await page.waitForSelector('.prod-row', { timeout: 5000 });
    await page.click('#plat-add-btn');
    await page.waitForSelector('#plat-form .plat-card', { timeout: 5000 });
    const r = await page.evaluate(() => ({ cards: document.querySelectorAll('#plat-form .plat-card').length, heads: document.querySelectorAll('.cat-head, .cat-group').length, tags: document.querySelectorAll('.pill[data-category]').length }));
    ok('positive: the cards are there, no headings, groups or category tags', r.cards >= 3 && r.heads === 0 && r.tags === 0, JSON.stringify(r));
  }, { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}
{
  const m = dashSettingsMock();
  const o = ordersFake({ platform: platform({ print: { category: XSS } }), products: [clone(PROD_PRINT)] });
  await run('設定：分類是資料——<img onerror> 當分類在選擇清單和已加入清單都只是文字', `${base}/settings.html`, async (page, ok) => {
    await page.waitForSelector('.prod-row', { timeout: 5000 });
    await page.click('#plat-add-btn');
    await page.waitForSelector('#plat-form .plat-card', { timeout: 5000 });
    const r = await page.evaluate(({ XSS }) => ({
      picker: [...document.querySelectorAll('#plat-form .cat-head')].some(h => h.textContent === XSS),
      mine: document.querySelector('[data-product-id="prod-print"] .pill[data-category]')?.textContent === XSS,
      imgs: document.querySelectorAll('img[src="x"]').length, pwn: window.__pwn ?? null,
    }), { XSS });
    ok('positive: it is the literal text in the picker heading and on the adopted row', r.picker && r.mine, JSON.stringify(r));
    ok('no <img> created, nothing ran', r.imgs === 0 && r.pwn === null, JSON.stringify(r));
  }, { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

// ── guest shop on the 完成頁 ──
const T0 = '2026-09-21T03:00:00.000Z';
// the Worker sends the list already ordered by sort and without a sort field: order = first appearance
const shop = cats => [
  { ...SHOP_PRINT_FAKE, id: 'p1', name: '畫乙', category: cats[1], options: [{ id: 'o-p1', label: '', price: 3000 }] },
  { ...SHOP_ALBUM_FAKE, id: 'a1', name: '相本甲', category: cats[0] },
  { ...SHOP_PRINT_FAKE, id: 'p2', name: '畫丙', category: cats[2], options: [{ id: 'o-p2', label: '', price: 2000 }] },
];
const shopWorld = cats => albumWorld({ n: 6, fake: { title: '婚禮精修', confirmedAt: T0, shopProducts: shop(cats) } });
const guestUrl = `${base}/index.html?t=TOK`;
const cardsReady = page => page.waitForSelector('#cpShop .cp-product', { timeout: 6000 });
{
  const w = shopWorld(['婚紗相本', '無框畫類', '無框畫類']);
  await run('客人商品清單：超過一個分類才出標題，依第一次出現排（Worker 已排好 sort），同分類不相鄰的商品併成一組、組內保持 Worker 順序', guestUrl, async (page, ok) => {
    await cardsReady(page);
    const r = await page.evaluate(() => ({
      heads: [...document.querySelectorAll('#cpShop .cp-cat-head')].map(h => h.textContent),
      groups: [...document.querySelectorAll('#cpShop .cp-cat-group')].map(g => [...g.querySelectorAll('.cp-product-name')].map(x => x.textContent).join()),
      cards: document.querySelectorAll('#cpShop .cp-product').length,
    }));
    ok('headings 無框畫類 (first card) then 婚紗相本', r.heads.join('|') === '無框畫類|婚紗相本', JSON.stringify(r.heads));
    ok('cards under them in order, all 3 present', r.groups.join('|') === '畫乙,畫丙|相本甲' && r.cards === 3, JSON.stringify(r));
    ok('390px: no horizontal scroll', await noHScroll(page));
  }, { before: w.before, contextOptions: MOBILE });
}
{
  const w = shopWorld(['婚紗相本', null, null]);   // p1, p2 uncategorised, the album named
  await run('客人商品清單：未分類放最後，標題叫「未分類」', guestUrl, async (page, ok) => {
    await cardsReady(page);
    const heads = await page.$$eval('#cpShop .cp-cat-head', hs => hs.map(h => h.textContent));
    ok('婚紗相本 (the only named group) first, 未分類 last even though its card comes first', heads.join('|') === '婚紗相本|未分類', JSON.stringify(heads));
  }, { before: w.before, contextOptions: ALB_DESK });
}
for (const [label, cats] of [['全部沒有分類', [null, null, null]], ['全部同一個分類', ['同一類', '同一類', '同一類']]]) {
  const w = shopWorld(cats);
  await run(`客人商品清單：${label}時和以前一模一樣（一個 ul.cp-products、沒有標題）`, guestUrl, async (page, ok) => {
    await cardsReady(page);
    const r = await page.evaluate(() => ({ lists: document.querySelectorAll('#cpShop > ul.cp-products').length, nested: document.querySelectorAll('#cpShop .cp-cat-group, #cpShop .cp-cat-head').length,
      cards: document.querySelectorAll('#cpShop ul.cp-products > li.cp-product').length, names: [...document.querySelectorAll('#cpShop .cp-product-name')].map(x => x.textContent).join() }));
    ok('positive: 3 cards in one list directly under the section, in the Worker order', r.lists === 1 && r.cards === 3 && r.names === '畫乙,相本甲,畫丙', JSON.stringify(r));
    ok('no group wrappers, no headings', r.nested === 0, JSON.stringify(r));
  }, { before: w.before, contextOptions: ALB_DESK });
}
{
  const w = shopWorld([XSS, '無框畫類', null]);
  await run('客人商品清單：分類是資料——<img onerror> 當標題只顯示成文字', guestUrl, async (page, ok) => {
    await cardsReady(page);
    const r = await page.evaluate(({ XSS }) => ({ head: [...document.querySelectorAll('#cpShop .cp-cat-head')].some(h => h.textContent === XSS),
      imgs: document.querySelectorAll('#cpShop img[src="x"]').length, pwn: window.__pwn ?? null }), { XSS });
    ok('positive: shown as literal text', r.head, JSON.stringify(r));
    ok('no <img> created, nothing ran', r.imgs === 0 && r.pwn === null, JSON.stringify(r));
  }, { before: w.before, contextOptions: ALB_DESK });
}
{
  const w = shopWorld(['x'.repeat(80), 'ok', null]);
  await run('客人商品清單：不合格的分類（超過上限）不當標題，歸到未分類', guestUrl, async (page, ok) => {
    await cardsReady(page);
    const heads = await page.$$eval('#cpShop .cp-cat-head', hs => hs.map(h => h.textContent));
    ok('only the valid category and 未分類 are headings', heads.join('|') === 'ok|未分類', JSON.stringify(heads));
  }, { before: w.before, contextOptions: ALB_DESK });
}

}
