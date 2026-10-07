// Browser suites: 加頁價格 (platform_products.extra_page_price) and the album default minimum of 10 spreads.
// Operator form + list, the photographer's read-only list, the 完成頁 product card. Fakes mirror the Worker
// (orders-fake.mjs extraWrite / extraRead, pick-fake.mjs shop products). Registered by test/run.mjs in
// file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { ALB_DESK, albumWorld } from '../lib/album-world.mjs';
import { SEED_TOKEN, dashSettingsMock } from '../lib/dashboard-mocks.mjs';
import { SHOP_ALBUM_FAKE, SHOP_PRINT_FAKE } from '../lib/pick-fake.mjs';
import { OP_SEED, PLAT_ALBUM, PLAT_PRINT, PROD_ALBUM, RED, T, clone, disp, ordersFake } from '../lib/orders-fake.mjs';

export default async function register() {

const okFn = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const platAlbum = extra => ({ ...clone(PLAT_ALBUM), ...extra });
const posts = o => o.st.calls.filter(c => c.method === 'POST' && c.path === '/api/operator/products');
const puts = o => o.st.calls.filter(c => c.method === 'PUT' && /^\/api\/operator\/products\/[^/]+$/.test(c.path));
const err = page => page.$eval('#opf-extra-page-price-err', e => e.textContent.trim());
const shown = (page, sel) => page.$eval(sel, e => e.offsetParent !== null && e.getBoundingClientRect().height > 0);
async function fillRow(page, name) {
  await page.fill('#opf-name', name);
  await page.fill('#opf-options .opt-row:nth-child(1) .opt-vendor', '1400');
  await page.fill('#opf-options .opt-row:nth-child(1) .opt-plat', '1500');
}

// ═══ operator form: create defaults, the field, what is sent ══════════════
{
  const o = ordersFake({ platform: [], products: [] });
  await suite('extra page price — 表單：新增相本最少頁數預設 10（可改可清空），加頁價格欄只在相本顯示，空白送 null、數字照送',
    `${base}/operator.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#op-list .hint', { timeout: 5000 });
      await page.click('#op-add-btn');
      await page.waitForSelector('#op-form');
      ok('a new album: 最少頁數 is prefilled with 10', (await page.inputValue('#opf-min-pages')) === '10');
      ok('max pages and extra price start blank', (await page.inputValue('#opf-max-pages')) === '' && (await page.inputValue('#opf-extra-page-price')) === '');
      ok('the 加頁價格 label and the hint are there', (await T(page, 'label[for="opf-extra-page-price"]')).startsWith('加頁價格')
        && (await T(page, '#opf-pages-group')).includes('超過最少頁數的每一頁加價（1 頁 = 1 個跨頁）'));
      ok('the field is really on screen for an album', await shown(page, '#opf-extra-page-price'));
      await page.selectOption('#opf-kind', 'print');
      ok('hidden for a print (group display none)', (await disp(page, '#opf-pages-group')) === 'none');
      await page.selectOption('#opf-kind', 'album');
      ok('and back for an album', await shown(page, '#opf-extra-page-price'));

      // untouched: min 10, extra null
      await fillRow(page, '相本書');
      await page.click('#opf-save');
      await page.waitForSelector('#op-form[data-mode="edit"]', { timeout: 3000 });
      let b = posts(o)[0]?.body;
      ok('untouched create sends min_pages 10, max_pages null, extra_page_price null (key present)',
        b && b.min_pages === 10 && b.max_pages === null && 'extra_page_price' in b && b.extra_page_price === null, JSON.stringify(b));
      await page.click('#opf-cancel');

      // cleared min + a price
      await page.click('#op-add-btn');
      await page.waitForSelector('#op-form');
      await fillRow(page, '相本二');
      await page.fill('#opf-min-pages', '');
      await page.fill('#opf-extra-page-price', '200');
      await page.click('#opf-save');
      await page.waitForSelector('#op-form[data-mode="edit"]', { timeout: 3000 });
      b = posts(o)[1]?.body;
      ok('clearing the minimum sends null (no minimum); 200 is sent as a number', b && b.min_pages === null && b.extra_page_price === 200, JSON.stringify(b));
      ok('the fake stored 200 and the list reads 加頁 NT$200／頁 (no 最少 part: min is null)',
        o.st.platform[1].extra_page_price === 200 && (await page.$eval('[data-product-id="' + o.st.platform[1].id + '"] [data-page-price]', e => e.textContent)) === '加頁 NT$200／頁');
      ok('the edit form shows the stored 200 back', (await page.inputValue('#opf-extra-page-price')) === '200');
      await page.click('#opf-cancel');

      // edited min, with the first product listed with both parts
      const first = o.st.platform[0].id;
      ok('the first album (min 10, no price) lists 最少 10 頁 only', (await page.$eval(`[data-product-id="${first}"] [data-page-price]`, e => e.textContent)) === '最少 10 頁');
      await page.click(`[data-product-id="${first}"] [data-edit]`);
      await page.waitForSelector('#op-form[data-mode="edit"]');
      await page.fill('#opf-extra-page-price', '1,5');
      await page.click('#opf-save');
      ok('a comma is refused inline with the Chinese message, nothing sent',
        (await err(page)) === '加頁價格需為 0–1,000,000 的整數（或留空）' && puts(o).length === 0, await err(page));
      await page.fill('#opf-extra-page-price', '350');
      await page.click('#opf-save');
      await page.waitForFunction(() => !document.getElementById('op-form'), null, { timeout: 3000 });
      ok('edit PUT carries min 10 and 350', puts(o)[0].body.min_pages === 10 && puts(o)[0].body.extra_page_price === 350, JSON.stringify(puts(o)[0]?.body));
      ok('the list now reads 最少 10 頁 · 加頁 NT$350／頁',
        (await page.$eval(`[data-product-id="${first}"] [data-page-price]`, e => e.textContent)) === '最少 10 頁 · 加頁 NT$350／頁');
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

// ═══ operator edit: stored values are shown untouched (null min is NOT turned into 10) ═══
{
  const pa = platAlbum({ min_pages: null, max_pages: null, extra_page_price: null });
  const o = ordersFake({ platform: [pa, { ...clone(PLAT_PRINT) }], products: [] });
  await suite('extra page price — 編輯既有商品：最少頁數為 null 就維持空白（不偷偷變 10），原樣送回；輸出品不送加頁價格',
    `${base}/operator.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#op-list .prod-row', { timeout: 5000 });
      ok('a product with neither min nor price shows no page-price text (positive: row exists)',
        (await page.$(`[data-product-id="${pa.id}"]`)) !== null && (await page.$(`[data-product-id="${pa.id}"] [data-page-price]`)) === null);
      await page.click(`[data-product-id="${pa.id}"] [data-edit]`);
      await page.waitForSelector('#op-form[data-mode="edit"]');
      ok('the edit form shows min blank', (await page.inputValue('#opf-min-pages')) === '' && (await page.inputValue('#opf-extra-page-price')) === '');
      await page.click('#opf-save');
      await page.waitForFunction(() => !document.getElementById('op-form'), null, { timeout: 3000 });
      const b = puts(o)[0].body;
      ok('saved unchanged: min_pages null, extra_page_price null', b.min_pages === null && b.extra_page_price === null, JSON.stringify(b));
      await page.click(`[data-product-id="${PLAT_PRINT.id}"] [data-edit]`);
      await page.waitForSelector('#op-form[data-mode="edit"]');
      await page.click('#opf-save');
      await page.waitForFunction(() => !document.getElementById('op-form'), null, { timeout: 3000 });
      const pb = puts(o)[1].body;
      ok('a print sends no page bounds and no extra_page_price', pb.kind === 'print' && !('min_pages' in pb) && !('extra_page_price' in pb), JSON.stringify(pb));
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

// ═══ validation + worker refusals ═════════════════════════════════════════
{
  const o = ordersFake({ platform: [], products: [] });
  await suite('extra page price — 驗證：負數、小數、非數字、超過 1,000,000 不送出（行內紅字）；0 與 1,000,000 可存',
    `${base}/operator.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#op-list .hint', { timeout: 5000 });
      await page.click('#op-add-btn');
      await page.waitForSelector('#op-form');
      await fillRow(page, '相本書');
      const MSG = '加頁價格需為 0–1,000,000 的整數（或留空）';
      for (const bad of ['-1', '1.5', 'abc', '1000001', '1e3', ' 1 2']) {
        await page.fill('#opf-extra-page-price', bad);
        await page.click('#opf-save');
        ok(`"${bad}" is refused inline, nothing sent`, (await err(page)) === MSG
          && (await page.$eval('#opf-extra-page-price', e => e.getAttribute('aria-invalid'))) === 'true' && posts(o).length === 0, `${await err(page)} / ${posts(o).length}`);
      }
      ok('the message is visible red text', (await page.$eval('#opf-extra-page-price-err', e => getComputedStyle(e).color)) === RED);
      await page.fill('#opf-extra-page-price', '4');
      ok('typing clears the message', (await err(page)) === '');
      await page.fill('#opf-extra-page-price', '0');
      await page.click('#opf-save');
      await page.waitForSelector('#op-form[data-mode="edit"]', { timeout: 3000 });
      ok('0 is accepted and sent as the number 0 (not null)', posts(o)[0].body.extra_page_price === 0 && o.st.platform[0].extra_page_price === 0, JSON.stringify(posts(o)[0]?.body));
      ok('the list reads 加頁 NT$0／頁 for 0', (await T(page, '#op-list')).includes('加頁 NT$0／頁'));
      await page.click('#opf-cancel');
      await page.click('#op-add-btn');
      await page.waitForSelector('#op-form');
      await fillRow(page, '相本最大');
      await page.fill('#opf-extra-page-price', '1000000');
      await page.click('#opf-save');
      await page.waitForSelector('#op-form[data-mode="edit"]', { timeout: 3000 });
      ok('1,000,000 is accepted', posts(o)[1].body.extra_page_price === 1000000);
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

{
  const o = ordersFake({ platform: [], products: [], pageColumns: { extra_page_price: false } });
  await suite('extra page price — Worker 回 extra_page_price_unavailable / invalid_extra_page_price：顯示中文訊息，不顯示英文',
    `${base}/operator.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#op-list .hint', { timeout: 5000 });
      await page.click('#op-add-btn');
      await page.waitForSelector('#op-form');
      await fillRow(page, '相本書');
      await page.fill('#opf-extra-page-price', '200');
      await page.click('#opf-save');
      await page.waitForFunction(() => document.getElementById('opf-err').textContent.length > 0, null, { timeout: 3000 });
      ok('pre-migration (500): 加頁價格尚未啟用，請先執行 migration（2026-10-07-product-extra-page-price.sql）',
        (await T(page, '#opf-err')) === '加頁價格尚未啟用，請先執行 migration（2026-10-07-product-extra-page-price.sql）', await T(page, '#opf-err'));
      ok('nothing was stored', o.st.platform.length === 0);
      o.st.inject = (method, path) => (method === 'POST' && path === '/api/operator/products') ? { status: 400, body: { error: 'invalid extra page price', code: 'invalid_extra_page_price' } } : null;
      await page.click('#opf-save');
      await page.waitForFunction(() => document.getElementById('opf-err').textContent.includes('0–1,000,000'), null, { timeout: 3000 });
      ok('a Worker 400 invalid_extra_page_price reads in Chinese', (await T(page, '#opf-err')) === '加頁價格需為 0–1,000,000 的整數（或留空）');
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

// ═══ photographer's settings list: read-only ══════════════════════════════
{
  const platA = platAlbum({ min_pages: 10, extra_page_price: 200 });
  const o = ordersFake({ platform: [platA], products: [clone(PROD_ALBUM)] });
  const dm = dashSettingsMock();
  await suite('extra page price — 攝影師商品清單：平台商品唯讀顯示「最少 10 頁 · 加頁 NT$200／頁」，沒有可編輯欄位',
    `${base}/settings.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      const b = await page.$eval('[data-product-id="prod-album"]', e => { const x = e.querySelector('[data-page-price]'); return x ? { text: x.textContent, shown: getComputedStyle(x).display !== 'none' } : null; });
      ok('the adopted album reads 最少 10 頁 · 加頁 NT$200／頁', b && b.text === '最少 10 頁 · 加頁 NT$200／頁' && b.shown, JSON.stringify(b));
      ok('settings has no extra-page-price input', (await page.$('#opf-extra-page-price, [name="extra_page_price"]')) === null);
      return out;
    },
    { before: async p => { await dm.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

// ═══ 完成頁 product cards ═════════════════════════════════════════════════
{
  const HOSTILE = '<img src=x onerror="window.__xss=1">';
  const products = [
    { ...SHOP_ALBUM_FAKE, id: 'a1', name: '相本 A', min_pages: 10, max_pages: 30, extra_page_price: 200 },
    { ...SHOP_ALBUM_FAKE, id: 'a2', name: '相本 B', min_pages: null, max_pages: null, extra_page_price: 1500, image_url: null },
    { ...SHOP_ALBUM_FAKE, id: 'a3', name: '相本 C', min_pages: 10, max_pages: 30, extra_page_price: null, image_url: null },
    { ...SHOP_ALBUM_FAKE, id: 'a4', name: '相本 D', extra_page_price: 0, image_url: null },
    { ...SHOP_ALBUM_FAKE, id: 'a5', name: '相本 E', extra_page_price: -5, image_url: null },
    { ...SHOP_ALBUM_FAKE, id: 'a6', name: '相本 F', extra_page_price: 12.5, image_url: null },
    { ...SHOP_ALBUM_FAKE, id: 'a7', name: '相本 G', extra_page_price: HOSTILE, image_url: null },
    { ...SHOP_PRINT_FAKE, id: 'p1', name: '加洗', extra_page_price: 300, image_url: null },
  ];
  const w = albumWorld({ n: 12, sub: 0, fake: { title: '婚禮精修', confirmedAt: '2026-09-21T03:00:00.000Z', studio: { name: '光影工作室', booking_url: 'https://studio.example/book', has_logo: true }, shopProducts: products } });
  await suite('extra page price — 完成頁相本卡：「加頁 NT$X／頁 · 含 N 頁」；null、負數、小數、字串、輸出品都不顯示',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#completionPage', { timeout: 5000 });
      await page.waitForSelector('#cpShop .cp-product', { timeout: 5000 });
      const cards = await page.evaluate(() => [...document.querySelectorAll('#cpShop .cp-product')].map(c => ({
        name: c.querySelector('.cp-product-name')?.textContent, extra: c.querySelector('.cp-product-extra')?.textContent ?? null,
        range: c.querySelector('.cp-product-range')?.textContent ?? null })));
      const by = n => cards.find(c => c.name === n);
      ok('eight cards rendered (positive)', cards.length === 8, JSON.stringify(cards));
      ok('min 10 + 200 → 加頁 NT$200／頁 · 含 10 頁 (range line unchanged)', by('相本 A').extra === '加頁 NT$200／頁 · 含 10 頁' && by('相本 A').range === '10–30 跨頁', JSON.stringify(by('相本 A')));
      ok('no min → only 加頁 NT$1,500／頁 (thousands separated)', by('相本 B').extra === '加頁 NT$1,500／頁', JSON.stringify(by('相本 B')));
      ok('null price → no line (positive: the card has its range)', by('相本 C').extra === null && by('相本 C').range === '10–30 跨頁');
      ok('0 is a price: 加頁 NT$0／頁 · 含 10 頁', by('相本 D').extra === '加頁 NT$0／頁 · 含 10 頁', JSON.stringify(by('相本 D')));
      ok('negative, fractional and string prices are dropped', by('相本 E').extra === null && by('相本 F').extra === null && by('相本 G').extra === null);
      ok('a print never shows it', by('加洗').extra === null);
      ok('nothing parsed or run', await page.evaluate(() => !document.querySelector('#cpShop img[src="x"]') && window.__xss === undefined));
      return out;
    },
    { before: w.before, initScript: "localStorage.setItem('pick_key:TOK', 'ZOE-KEY');", contextOptions: ALB_DESK });
}

}
