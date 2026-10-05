// Browser suites: album page range (min_pages / max_pages) on the operator's product form and list,
// and the photographer's products list (read-only range, 價格低於平台底價 warning).
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { SEED_TOKEN, dashSettingsMock } from '../lib/dashboard-mocks.mjs';
import { OP_SEED, PLAT_ALBUM, PLAT_PRINT, PROD_ALBUM, PROD_PRINT, PROD_SERVICE_OFF, RED, T, clone, disp, ordersFake, waitText } from '../lib/orders-fake.mjs';

export default async function register() {

const XSS = '"><img src=x onerror="window.__xss=1">';
const platAlbum = extra => ({ ...clone(PLAT_ALBUM), ...extra });
const platPrint = extra => ({ ...clone(PLAT_PRINT), ...extra });
const posts = o => o.st.calls.filter(c => c.method === 'POST' && c.path === '/api/operator/products');
const puts = o => o.st.calls.filter(c => c.method === 'PUT' && /^\/api\/operator\/products\/[^/]+$/.test(c.path));
// the first option row of a new-product form: both money fields filled, the rest is up to the test
async function fillRow(page, name) {
  await page.fill('#opf-name', name);
  await page.fill('#opf-options .opt-row:nth-child(1) .opt-vendor', '1400');
  await page.fill('#opf-options .opt-row:nth-child(1) .opt-plat', '1500');
}
const fieldErr = (page, which) => page.$eval(`#opf-${which}-pages-err`, e => e.textContent.trim());
// really on screen: no hidden ancestor (a child's own computed display stays 'block' inside a hidden group)
const shown = (page, sel) => page.$eval(sel, e => e.offsetParent !== null && e.getBoundingClientRect().height > 0);
const invalid = (page, which) => page.$eval(`#opf-${which}-pages`, e => e.getAttribute('aria-invalid'));

// ── the form: visible for album only, hidden fields are not sent ───────────
{
  const o = ordersFake({ platform: [], products: [] });
  await suite('operator pages — 表單：頁數欄位只在相本顯示（輸出品隱藏且不送出），標籤與預設空白',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-list .hint', { timeout: 5000 });
      await page.click('#op-add-btn');
      await page.waitForSelector('#op-form');
      ok('a new product starts as an album: both page fields are shown (computed display), blank',
        (await disp(page, '#opf-pages-group')) !== 'none' && (await shown(page, '#opf-min-pages')) && (await shown(page, '#opf-max-pages'))
        && (await page.inputValue('#opf-min-pages')) === '' && (await page.inputValue('#opf-max-pages')) === '');
      ok('the labels read 最少頁數（跨頁） and 最多頁數（跨頁）', (await T(page, 'label[for="opf-min-pages"]')) === '最少頁數（跨頁）' && (await T(page, 'label[for="opf-max-pages"]')) === '最多頁數（跨頁）');
      ok('they sit right after 相本指定張數 (same form, after the count group)',
        await page.evaluate(() => { const c = document.getElementById('opf-count-group'), g = document.getElementById('opf-pages-group'); return !!(c.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING) && c.parentElement === g.parentElement; }));
      ok('the unit is explained (1 跨頁 = 1 P, cover and back not counted)', (await T(page, '#opf-pages-group')).includes('1 跨頁 = 1 P') && (await T(page, '#opf-pages-group')).includes('封面與封底不算'));

      await page.selectOption('#opf-kind', 'print');
      ok('a print hides the page fields (computed display none) and the count group with them',
        (await disp(page, '#opf-pages-group')) === 'none' && !(await shown(page, '#opf-min-pages')) && !(await shown(page, '#opf-max-pages')) && (await disp(page, '#opf-count-group')) === 'none');
      await page.selectOption('#opf-kind', 'album');
      ok('back to album they are shown again', (await disp(page, '#opf-pages-group')) !== 'none' && (await shown(page, '#opf-min-pages')) && (await shown(page, '#opf-max-pages')));

      // a print: typed values (even invalid) in the hidden fields are neither judged nor sent
      await page.fill('#opf-min-pages', '12');
      await page.fill('#opf-max-pages', 'abc');
      await page.selectOption('#opf-kind', 'print');
      await fillRow(page, '無框畫');
      await page.click('#opf-save');
      await page.waitForSelector('#op-form[data-mode="edit"]', { timeout: 3000 });
      const post = posts(o)[0];
      ok('a print was created although the hidden max field holds "abc" (hidden fields are not validated)', !!post && post.body.kind === 'print', JSON.stringify(o.st.calls.map(c => [c.method, c.path])));
      ok('and its POST body has neither min_pages nor max_pages (keys absent, not null)', post && !('min_pages' in post.body) && !('max_pages' in post.body), JSON.stringify(post?.body));
      ok('the stored print carries no range', o.st.platform[0].min_pages == null && o.st.platform[0].max_pages == null, JSON.stringify(o.st.platform[0]));
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

// ── validation, inline ─────────────────────────────────────────────────────
{
  const o = ordersFake({ platform: [], products: [] });
  await suite('operator pages — 表單驗證：1–200 的整數、最多 ≥ 最少，欄位下方顯示訊息、不送出',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-list .hint', { timeout: 5000 });
      await page.click('#op-add-btn');
      await page.waitForSelector('#op-form');
      await fillRow(page, '相本書');
      const MIN_MSG = '最少頁數需為 1–200 的整數（或留空）', MAX_MSG = '最多頁數需為 1–200 的整數（或留空）', RANGE_MSG = '最多頁數不能小於最少頁數';

      for (const bad of ['0', '201', '1.5', '-3', 'abc', '1e2', '１０']) {
        await page.fill('#opf-min-pages', bad);
        await page.fill('#opf-max-pages', '');
        await page.click('#opf-save');
        ok(`最少 "${bad}" is refused inline under the min field, nothing sent`,
          (await fieldErr(page, 'min')) === MIN_MSG && (await invalid(page, 'min')) === 'true' && (await fieldErr(page, 'max')) === '' && posts(o).length === 0, `${await fieldErr(page, 'min')} / ${posts(o).length}`);
      }
      for (const bad of ['0', '201', '2.5', 'x']) {
        await page.fill('#opf-min-pages', '');
        await page.fill('#opf-max-pages', bad);
        await page.click('#opf-save');
        ok(`最多 "${bad}" is refused inline under the max field, nothing sent`,
          (await fieldErr(page, 'max')) === MAX_MSG && (await invalid(page, 'max')) === 'true' && (await fieldErr(page, 'min')) === '' && posts(o).length === 0, await fieldErr(page, 'max'));
      }
      ok('the message is visible red text (computed color, not empty)', (await page.$eval('#opf-max-pages-err', e => getComputedStyle(e).color)) === RED && (await disp(page, '#opf-max-pages-err')) !== 'none');

      await page.fill('#opf-min-pages', '30');
      await page.fill('#opf-max-pages', '10');
      await page.click('#opf-save');
      ok('最多 10 < 最少 30 → 「最多頁數不能小於最少頁數」 under the max field, nothing sent',
        (await fieldErr(page, 'max')) === RANGE_MSG && (await invalid(page, 'max')) === 'true' && (await fieldErr(page, 'min')) === '' && posts(o).length === 0, await fieldErr(page, 'max'));
      await page.fill('#opf-max-pages', '11');
      ok('typing in a field clears the messages', (await fieldErr(page, 'max')) === '' && (await invalid(page, 'max')) === null);

      // the boundaries are accepted (positive cases)
      await page.fill('#opf-min-pages', '1');
      await page.fill('#opf-max-pages', '200');
      await page.click('#opf-save');
      await page.waitForSelector('#op-form[data-mode="edit"]', { timeout: 3000 });
      ok('1 and 200 are accepted and sent as numbers', posts(o).length === 1 && posts(o)[0].body.min_pages === 1 && posts(o)[0].body.max_pages === 200, JSON.stringify(posts(o)[0]?.body));
      await page.click('#opf-cancel');

      await page.click('#op-add-btn');
      await page.waitForSelector('#op-form');
      await fillRow(page, '相本二');
      await page.fill('#opf-min-pages', '20');
      await page.fill('#opf-max-pages', '20');
      await page.click('#opf-save');
      await page.waitForSelector('#op-form[data-mode="edit"]', { timeout: 3000 });
      ok('equal bounds (20 = 20) are accepted', posts(o).length === 2 && posts(o)[1].body.min_pages === 20 && posts(o)[1].body.max_pages === 20, JSON.stringify(posts(o)[1]?.body));
      await page.click('#opf-cancel');

      await page.click('#op-add-btn');
      await page.waitForSelector('#op-form');
      await fillRow(page, '相本三');
      await page.fill('#opf-min-pages', ' 7 ');
      await page.click('#opf-save');
      await page.waitForSelector('#op-form[data-mode="edit"]', { timeout: 3000 });
      ok('spaces around a number are trimmed; a blank max is sent as null', posts(o).length === 3 && posts(o)[2].body.min_pages === 7 && posts(o)[2].body.max_pages === null, JSON.stringify(posts(o)[2]?.body));
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

{
  const o = ordersFake({ platform: [], products: [] });
  await suite('operator pages — 切到輸出品時，相本專用的錯誤訊息一併清掉',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-list .hint', { timeout: 5000 });
      await page.click('#op-add-btn');
      await page.waitForSelector('#op-form');
      await fillRow(page, '相本書');
      await page.fill('#opf-min-pages', '999');
      await page.click('#opf-save');
      ok('the album shows the min message first (positive)', (await fieldErr(page, 'min')) !== '' && (await invalid(page, 'min')) === 'true');
      await page.selectOption('#opf-kind', 'print');
      ok('switching to 輸出品 clears the message and the invalid mark', (await fieldErr(page, 'min')) === '' && (await invalid(page, 'min')) === null);
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

// ── the Worker's refusals ──────────────────────────────────────────────────
{
  const o = ordersFake({ platform: [], products: [] });
  await suite('operator pages — Worker 的錯誤碼各有清楚的中文（含 migration 尚未執行），表單保持開啟',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-list .hint', { timeout: 5000 });
      await page.click('#op-add-btn');
      await page.waitForSelector('#op-form');
      await fillRow(page, '相本書');
      await page.fill('#opf-min-pages', '10');
      await page.fill('#opf-max-pages', '30');
      const cases = [
        [400, 'invalid_min_pages', '最少頁數需為 1–200 的整數'],
        [400, 'invalid_max_pages', '最多頁數需為 1–200 的整數'],
        [400, 'invalid_page_range', '最多頁數不能小於最少頁數'],
        [500, 'min_pages_unavailable', '最少頁數還不能存'],
        [500, 'max_pages_unavailable', '最多頁數還不能存'],
      ];
      for (const [status, code, text] of cases) {
        o.st.inject = (method, path) => (method === 'POST' && path === '/api/operator/products') ? { status, body: { error: code.replace(/_/g, ' '), code } } : null;
        await page.click('#opf-save');
        await waitText(page, '#opf-err', t => t.trim() !== '');
        const msg = await T(page, '#opf-err');
        ok(`${status} ${code} → 「${text}…」`, msg.includes(text) && msg !== code && !msg.includes('_'), msg);
        if (status === 500) ok(`  and it says the D1 migration has not been run yet (${code})`, msg.includes('D1 migration') && msg.includes('尚未執行') && msg.includes(code.startsWith('min') ? 'product-min-pages' : 'product-max-pages'), msg);
        ok(`  the form stays open with the values kept (${code})`, (await page.$('#op-form')) !== null && (await page.inputValue('#opf-min-pages')) === '10' && (await page.inputValue('#opf-max-pages')) === '30');
        o.st.inject = null;
        await page.fill('#opf-name', '相本書');   // a no-op write: the error text is cleared only by the next save
        await page.evaluate(() => { document.getElementById('opf-err').textContent = ''; });
      }
      ok('every refused save was a POST carrying both numbers (the page really sent them)', posts(o).length === 5 && posts(o).every(c => c.body.min_pages === 10 && c.body.max_pages === 30), JSON.stringify(posts(o).map(c => c.body)));
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

{
  // the fake mirrors the Worker: a missing column refuses a number (500) and still takes null
  const o = ordersFake({ platform: [], products: [], pageColumns: { min_pages: false } });
  await suite('operator pages — min_pages 欄位還沒 migration：存數字得到 500 的說明，留空仍可儲存',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-list .hint', { timeout: 5000 });
      await page.click('#op-add-btn');
      await page.waitForSelector('#op-form');
      await fillRow(page, '相本書');
      await page.fill('#opf-min-pages', '10');
      await page.click('#opf-save');
      await waitText(page, '#opf-err', t => t.includes('最少頁數還不能存'));
      ok('a min number → 500 min_pages_unavailable → the migration message, nothing stored', (await T(page, '#opf-err')).includes('D1 migration') && o.st.platform.length === 0);
      await page.fill('#opf-min-pages', '');
      await page.fill('#opf-max-pages', '30');
      await page.click('#opf-save');
      await page.waitForSelector('#op-form[data-mode="edit"]', { timeout: 3000 });
      ok('with min blank (null) and a max, the save goes through (that column exists)', o.st.platform.length === 1 && o.st.platform[0].max_pages === 30, JSON.stringify(o.st.platform));
      ok('the list shows only what reads back: 最多 30 跨頁', (await T(page, '#op-list [data-page-range]')) === '最多 30 跨頁');
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

// ── the list ───────────────────────────────────────────────────────────────
{
  const hostile = platAlbum({ id: 'plat-xss', name: XSS, description: XSS, min_pages: 8, max_pages: 24, sort: 9,
    options: [{ id: 'popt-x', label: XSS, vendor_cost: 100, platform_price: 150, active: 1, sort: 0 }] });
  const fx = [
    platAlbum({ id: 'pa-both', name: '兩者', min_pages: 10, max_pages: 30, sort: 0 }),
    platAlbum({ id: 'pa-min', name: '只有最少', min_pages: 10, max_pages: null, sort: 1 }),
    platAlbum({ id: 'pa-max', name: '只有最多', min_pages: null, max_pages: 30, sort: 2 }),
    platAlbum({ id: 'pa-none', name: '都沒有', min_pages: null, max_pages: null, sort: 3 }),
    platAlbum({ id: 'pa-same', name: '相同', min_pages: 12, max_pages: 12, sort: 4 }),
    platPrint({ id: 'pp-stray', name: '輸出品殘值', min_pages: 5, max_pages: 9, sort: 5 }),
    hostile,
  ];
  const o = ordersFake({ platform: fx, products: [] });
  await suite('operator pages — 清單顯示頁數範圍：10–30 跨頁／至少 10 跨頁／最多 30 跨頁，沒有就不顯示，輸出品不顯示',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-list .prod-row', { timeout: 5000 });
      const range = id => page.$eval(`[data-product-id="${id}"]`, e => { const r = e.querySelector('[data-page-range]'); return r ? { text: r.textContent, shown: getComputedStyle(r).display !== 'none', main: e.querySelector('.prod-main').contains(r) } : null; });
      const both = await range('pa-both');
      ok('both bounds: 「10–30 跨頁」, visible, inside the product block', both && both.text === '10–30 跨頁' && both.shown && both.main, JSON.stringify(both));
      const min = await range('pa-min');
      ok('only min: 「至少 10 跨頁」', min && min.text === '至少 10 跨頁' && min.shown, JSON.stringify(min));
      const max = await range('pa-max');
      ok('only max: 「最多 30 跨頁」', max && max.text === '最多 30 跨頁' && max.shown, JSON.stringify(max));
      ok('neither: no range element at all, while the row still shows its 指定 20 張 (the row did render)',
        (await range('pa-none')) === null && (await T(page, '[data-product-id="pa-none"]')).includes('指定 20 張'));
      const same = await range('pa-same');
      ok('equal bounds read 「12 跨頁」, not 12–12', same && same.text === '12 跨頁', JSON.stringify(same));
      ok('a print never shows a range, even if the data carries one (positive: the print row is listed)',
        (await range('pp-stray')) === null && (await T(page, '[data-product-id="pp-stray"]')).includes('輸出品殘值'));
      ok('the count and the range sit side by side on an album that has both', (await T(page, '[data-product-id="pa-both"] .prod-main')).replace(/\s+/g, ' ').includes('指定 20 張'));

      // escaping: a hostile name / description / option label next to a range
      const probe = await page.evaluate(() => ({ fired: !!window.__xss, injected: document.querySelectorAll('img[src="x"]').length,
        name: document.querySelector('[data-product-id="plat-xss"] .prod-name')?.textContent, range: document.querySelector('[data-product-id="plat-xss"] [data-page-range]')?.textContent,
        li: document.querySelector('[data-product-id="plat-xss"] li')?.textContent }));
      ok('a hostile product name makes no element and fires no handler', probe.injected === 0 && probe.fired === false, JSON.stringify(probe));
      ok('and is shown as typed (text, not markup); the range beside it is intact', probe.name === XSS && probe.range === '8–24 跨頁' && probe.li.includes(XSS), JSON.stringify(probe));
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

// ── editing: pre-fill, clearing, leaving album ─────────────────────────────
{
  const o = ordersFake({ platform: [platAlbum({ min_pages: 10, max_pages: 30 }), platAlbum({ id: 'pa-none', name: '空白', min_pages: null, max_pages: null, sort: 1 })], products: [] });
  await suite('operator pages — 編輯：帶入既有頁數、清空送 null、改成輸出品不送、換回相本不還原',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-list .prod-row', { timeout: 5000 });
      await page.click('[data-product-id="pa-none"] [data-edit]');
      await page.waitForSelector('#op-form[data-mode="edit"]');
      ok('an album without a range opens with both fields blank (not "null", not "0")', (await page.inputValue('#opf-min-pages')) === '' && (await page.inputValue('#opf-max-pages')) === '');
      await page.click('#opf-cancel');

      await page.click('[data-product-id="plat-album"] [data-edit]');
      await page.waitForSelector('#op-form[data-mode="edit"]');
      ok('an album with 10–30 opens with 10 and 30 filled', (await page.inputValue('#opf-min-pages')) === '10' && (await page.inputValue('#opf-max-pages')) === '30'
        && (await shown(page, '#opf-min-pages')) && (await shown(page, '#opf-max-pages')));
      await page.fill('#opf-max-pages', '');
      await page.click('#opf-save');
      await page.waitForFunction(() => !document.getElementById('op-form'), null, { timeout: 3000 });
      const put = puts(o)[0];
      ok('clearing max sends max_pages null and keeps min_pages 10 in the same PUT', put && put.body.min_pages === 10 && put.body.max_pages === null, JSON.stringify(put?.body));
      await page.waitForFunction(() => document.querySelector('[data-product-id="plat-album"] [data-page-range]')?.textContent === '至少 10 跨頁', null, { timeout: 3000 });
      ok('the list now reads 「至少 10 跨頁」 (the 30 is gone)', (await T(page, '[data-product-id="plat-album"] [data-page-range]')) === '至少 10 跨頁' && o.st.platform[0].max_pages === null);

      await page.click('[data-product-id="plat-album"] [data-edit]');
      await page.waitForSelector('#op-form');
      ok('re-opening shows 10 and a blank max', (await page.inputValue('#opf-min-pages')) === '10' && (await page.inputValue('#opf-max-pages')) === '');
      await page.fill('#opf-min-pages', '40');
      await page.fill('#opf-max-pages', '15');
      await page.click('#opf-save');
      ok('max 15 < min 40 on an edit is refused inline, no second PUT', (await fieldErr(page, 'max')) === '最多頁數不能小於最少頁數' && puts(o).length === 1);
      await page.fill('#opf-min-pages', '12');
      await page.fill('#opf-max-pages', '15');
      await page.selectOption('#opf-kind', 'print');
      await page.click('#opf-save');
      await page.waitForFunction(() => !document.getElementById('op-form'), null, { timeout: 3000 });
      const put2 = puts(o)[1];
      ok('turning it into a 輸出品 sends neither page field (the Worker clears both)', put2 && put2.body.kind === 'print' && !('min_pages' in put2.body) && !('max_pages' in put2.body), JSON.stringify(put2?.body));
      ok('the print row shows no range', (await page.$('[data-product-id="plat-album"] [data-page-range]')) === null && (await T(page, '[data-product-id="plat-album"]')).includes('輸出品'));
      await page.click('[data-product-id="plat-album"] [data-edit]');
      await page.waitForSelector('#op-form');
      ok('as a print the page fields are hidden on open (group display none, inputs not on screen)', (await disp(page, '#opf-pages-group')) === 'none' && !(await shown(page, '#opf-min-pages')));
      await page.selectOption('#opf-kind', 'album');
      ok('and coming back to 相本 shows them blank: the old 12–15 is not restored', (await page.inputValue('#opf-min-pages')) === '' && (await page.inputValue('#opf-max-pages')) === '');
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

// ═══ the photographer's products list (settings.html) ═════════════════════
{
  const m = dashSettingsMock();
  const hostile = { ...clone(PROD_ALBUM), id: 'prod-xss', name: XSS, platform_product_id: 'plat-xss', sort: 7,
    options: [{ id: 'opt-x', label: XSS, price: 100, cost: 150, active: 1, sort: 0, platform_option_id: 'popt-x' }] };
  const platXss = platAlbum({ id: 'plat-xss', name: XSS, min_pages: 8, max_pages: 24,
    options: [{ id: 'popt-x', label: XSS, vendor_cost: 90, platform_price: 150, active: 1, sort: 0 }] });
  const retiredProd = { ...clone(PROD_ALBUM), id: 'prod-retired', name: '已下架相本', active: 0, platform_product_id: 'plat-ret', sort: 8,
    options: [{ id: 'opt-ret', label: '', price: 10, cost: 900, active: 1, sort: 0, platform_option_id: 'popt-ret' }] };
  const platRet = platAlbum({ id: 'plat-ret', name: '已下架相本', options: [{ id: 'popt-ret', label: '', vendor_cost: 800, platform_price: 900, active: 1, sort: 0 }] });
  const prodAlbum = clone(PROD_ALBUM);
  // 8×8: 售價 1,000 under the 1,500 floor; 12×12: 2,400 = floor; a third at 5,800 above (added below)
  prodAlbum.options[0].price = 1000;
  prodAlbum.options[1].price = 2400;
  prodAlbum.options.splice(2, 0, { id: 'opt-album-xl', label: '16×16 吋', price: 9000, cost: 3000, active: 1, sort: 2, platform_option_id: 'popt-album-xl' });
  const platA = platAlbum({ min_pages: 10, max_pages: 30 });
  platA.options.splice(2, 0, { id: 'popt-album-xl', label: '16×16 吋', vendor_cost: 2800, platform_price: 3000, active: 1, sort: 2 });
  const svc = { ...clone(PROD_SERVICE_OFF), id: 'prod-svc2', name: '賠本服務', active: 1, sort: 6, options: [{ id: 'opt-svc2', label: '', price: 100, cost: 500, active: 1, sort: 0 }] };
  const o = ordersFake({
    platform: [platA, platPrint({ min_pages: 5, max_pages: 9 }), platXss, platRet],
    products: [prodAlbum, clone(PROD_PRINT), svc, hostile, retiredProd],
  });
  await suite('settings pages — 商品清單：價格低於平台底價的規格顯示警告（等於、高於、自訂服務、已下架商品不顯示）',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      const WARN = '價格低於平台底價，客人看不到這個選項';
      const li = (prod, opt) => page.$eval(`[data-product-id="${prod}"] li[data-option-id="${opt}"]`, e => {
        const w = e.querySelectorAll('[data-warn="guest-hidden"]');
        return { n: w.length, text: w[0] ? w[0].textContent : null, color: w[0] ? getComputedStyle(w[0]).color : null, display: w[0] ? getComputedStyle(w[0]).display : null, li: e.textContent.replace(/\s+/g, ' ') };
      });
      const under = await li('prod-album', 'opt-album-s');
      ok('售價 1,000 < 平台價 1,500: the exact warning sentence, once, in the option’s own line',
        under.n === 1 && under.text === WARN && under.li.includes('平台價 NT$1,500 · 售價 NT$1,000'), JSON.stringify(under));
      ok('it is visible red text (computed color red, display not none)', under.color === RED && under.display !== 'none', JSON.stringify(under));
      const equal = await li('prod-album', 'opt-album-l');
      ok('售價 2,400 = 平台價 2,400: no warning (positive: the line is there with its prices)', equal.n === 0 && equal.li.includes('平台價 NT$2,400 · 售價 NT$2,400'), JSON.stringify(equal));
      const above = await li('prod-album', 'opt-album-xl');
      ok('售價 9,000 > 平台價 3,000: no warning (positive: the line is there)', above.n === 0 && above.li.includes('16×16 吋') && above.li.includes('售價 NT$9,000'), JSON.stringify(above));
      ok('exactly one warning in the whole album row', (await page.$$('[data-product-id="prod-album"] [data-warn="guest-hidden"]')).length === 1);
      const printLi = await li('prod-print', 'opt-print');
      ok('the print (售價 1,200 > 平台價 500) has none', printLi.n === 0 && printLi.li.includes('售價 NT$1,200'), JSON.stringify(printLi));
      const svcLi = await page.$eval('[data-product-id="prod-svc2"]', e => ({ warn: e.querySelectorAll('[data-warn="guest-hidden"]').length, text: e.textContent.replace(/\s+/g, ' ') }));
      ok('a custom service sold under its own 成本 gets no platform warning (not a platform floor) — positive: 售價 NT$100 · 成本 NT$500 is shown',
        svcLi.warn === 0 && svcLi.text.includes('售價 NT$100 · 成本 NT$500'), JSON.stringify(svcLi));
      const ret = await page.$eval('[data-product-id="prod-retired"]', e => ({ warn: e.querySelectorAll('[data-warn="guest-hidden"]').length, retired: e.dataset.active, text: e.textContent.replace(/\s+/g, ' ') }));
      ok('a retired product under the floor shows no guest warning (it is hidden anyway) — positive: it is listed as 已下架 with 售價 NT$10',
        ret.warn === 0 && ret.retired === '0' && ret.text.includes('已下架') && ret.text.includes('售價 NT$10'), JSON.stringify(ret));
      ok('the older 「平台價已調整…」 line is still there on the same option, once, next to the new one',
        (await page.$$eval('[data-product-id="prod-album"] li[data-option-id="opt-album-s"] .warn-below', els => els.map(e => e.textContent))).join() === '平台價已調整，售價低於平台價，請更新');
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const platA = platAlbum({ min_pages: 10, max_pages: 30 });
  const platMin = platAlbum({ id: 'plat-min', name: '只有最少', min_pages: 10, max_pages: null, sort: 1 });
  const platMax = platAlbum({ id: 'plat-max', name: '只有最多', min_pages: null, max_pages: 30, sort: 2 });
  const platNone = platAlbum({ id: 'plat-none', name: '無範圍', sort: 3 });
  const platXss = platAlbum({ id: 'plat-xss', name: XSS, min_pages: 8, max_pages: 24, sort: 4,
    options: [{ id: 'popt-x', label: XSS, vendor_cost: 90, platform_price: 150, active: 1, sort: 0 }] });
  const adopt = (id, plat, name, sort) => ({ ...clone(PROD_ALBUM), id, name, platform_product_id: plat, sort,
    options: [{ id: `opt-${id}`, label: '', price: 5000, cost: 1500, active: 1, sort: 0, platform_option_id: `popt-${plat}` }] });
  const fixOpts = pp => { pp.options = [{ id: `popt-${pp.id}`, label: '', vendor_cost: 1400, platform_price: 1500, active: 1, sort: 0 }]; return pp; };
  [platMin, platMax, platNone].forEach(fixOpts);
  const o = ordersFake({
    platform: [platA, platMin, platMax, platNone, platPrint({ min_pages: 5, max_pages: 9 }), platXss],
    products: [clone(PROD_ALBUM), adopt('prod-min', 'plat-min', '只有最少', 1), adopt('prod-max', 'plat-max', '只有最多', 2), adopt('prod-none', 'plat-none', '無範圍', 3),
      clone(PROD_PRINT), { ...clone(PROD_ALBUM), id: 'prod-xss', name: XSS, platform_product_id: 'plat-xss', sort: 5,
        options: [{ id: 'opt-x', label: XSS, price: 5000, cost: 150, active: 1, sort: 0, platform_option_id: 'popt-x' }] }],
  });
  await suite('settings pages — 商品清單：已加入相本的頁數範圍唯讀顯示，null 不顯示，名稱照字面不當 HTML',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      const range = id => page.$eval(`[data-product-id="${id}"]`, e => { const r = e.querySelector('[data-page-range]'); return r ? { text: r.textContent, shown: getComputedStyle(r).display !== 'none', inMain: e.querySelector('.prod-main').contains(r) } : null; });
      const both = await range('prod-album');
      ok('an adopted album with 10–30 shows 「10–30 跨頁」', both && both.text === '10–30 跨頁' && both.shown && both.inMain, JSON.stringify(both));
      ok('min only → 「至少 10 跨頁」', (await range('prod-min'))?.text === '至少 10 跨頁');
      ok('max only → 「最多 30 跨頁」', (await range('prod-max'))?.text === '最多 30 跨頁');
      ok('both null → nothing (positive: the row is listed with its name)', (await range('prod-none')) === null && (await T(page, '[data-product-id="prod-none"]')).includes('無範圍'));
      ok('an adopted print shows no range even when the platform data carries one (positive: listed)', (await range('prod-print')) === null && (await T(page, '[data-product-id="prod-print"]')).includes('無框畫'));
      const probe = await page.evaluate(() => ({ fired: !!window.__xss, injected: document.querySelectorAll('img[src="x"]').length,
        name: document.querySelector('[data-product-id="prod-xss"] .prod-name')?.textContent, range: document.querySelector('[data-product-id="prod-xss"] [data-page-range]')?.textContent }));
      ok('a hostile product name makes no element and fires nothing; shown as typed, range intact',
        probe.injected === 0 && probe.fired === false && probe.name === XSS && probe.range === '8–24 跨頁', JSON.stringify(probe));

      await page.click('[data-product-id="prod-album"] [data-edit]');
      await page.waitForSelector('#prod-form[data-adopted="1"]');
      ok('read-only: the adopted edit form has no page-range input at all', (await page.$('#opf-min-pages, #opf-max-pages, [id$="min-pages"], [id$="max-pages"]')) === null);
      await page.click('#pf-cancel');
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const prod = clone(PROD_ALBUM);
  prod.options = [{ id: 'opt-album-s', label: '8×8 吋', price: 1499, cost: 1500, active: 1, sort: 0, platform_option_id: 'popt-album-s' }];
  const o = ordersFake({ platform: [platAlbum({ min_pages: 10, max_pages: 30 })], products: [prod] });
  await suite('settings pages — 價格低於平台底價的警告在改價後更新：差 1 元有、補到平台價（相等）就消失',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.prod-row li', { timeout: 5000 });
      const warns = () => page.$$eval('[data-warn="guest-hidden"]', els => els.map(e => e.textContent));
      ok('NT$1,499 against a NT$1,500 floor (one under) is warned', JSON.stringify(await warns()) === JSON.stringify(['價格低於平台底價，客人看不到這個選項']), JSON.stringify(await warns()));
      await page.click('[data-edit]');
      await page.waitForSelector('#prod-form[data-adopted="1"]');
      await page.fill('#pf-options [data-platform-option-id="popt-album-s"] .pick-price', '1500');
      await page.click('#pf-save');
      await page.waitForFunction(() => !document.getElementById('prod-form'), null, { timeout: 3000 });
      await page.waitForFunction(() => document.querySelector('.prod-row li')?.textContent.includes('售價 NT$1,500'), null, { timeout: 3000 });
      ok('after repricing to NT$1,500 (= floor) the warning is gone (positive: the row shows 售價 NT$1,500)', (await warns()).length === 0 && (await T(page, '.prod-row')).includes('售價 NT$1,500'), await T(page, '.prod-row'));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

}
