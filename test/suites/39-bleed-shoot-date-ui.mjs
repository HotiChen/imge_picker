// Browser suites: the operator's bleed_mm (product form, list, the photographer's read-only list) and the
// project shoot date (admin create + detail, the 完成頁 hero). docs/products-orders.md "bleed_mm",
// docs/delivery.md "Shoot date". Fakes mirror the Worker (orders-fake.mjs bleedWrite, pick-fake.mjs shoot_date).
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { openCreateForm } from '../lib/project-helpers.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { MOBILE } from '../lib/env.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { albumWorld } from '../lib/album-world.mjs';
import { SEED_TOKEN, dashSettingsMock } from '../lib/dashboard-mocks.mjs';
import { OP_SEED, PLAT_ALBUM, PLAT_PRINT, PROD_ALBUM, RED, T, clone, disp, ordersFake, waitText } from '../lib/orders-fake.mjs';

export default async function register() {

const okFn = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const platAlbum = extra => ({ ...clone(PLAT_ALBUM), ...extra });
const platPrint = extra => ({ ...clone(PLAT_PRINT), ...extra });
const posts = o => o.st.calls.filter(c => c.method === 'POST' && c.path === '/api/operator/products');
const puts = o => o.st.calls.filter(c => c.method === 'PUT' && /^\/api\/operator\/products\/[^/]+$/.test(c.path));
async function fillRow(page, name) {
  await page.fill('#opf-name', name);
  await page.fill('#opf-options .opt-row:nth-child(1) .opt-vendor', '1400');
  await page.fill('#opf-options .opt-row:nth-child(1) .opt-plat', '1500');
}
const bleedErr = page => page.$eval('#opf-bleed-mm-err', e => e.textContent.trim());
const shown = (page, sel) => page.$eval(sel, e => e.offsetParent !== null && e.getBoundingClientRect().height > 0);

// ═══ operator form: the bleed field ═══════════════════════════════════════
{
  const o = ordersFake({ platform: [], products: [] });
  await suite('bleed ui — 表單：出血欄位相本與輸出品都顯示，0–10 step 0.5，預設空白；空白送 null、數字照送',
    `${base}/operator.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#op-list .hint', { timeout: 5000 });
      await page.click('#op-add-btn');
      await page.waitForSelector('#op-form');
      const f = await page.$eval('#opf-bleed-mm', e => ({ type: e.type, min: e.min, max: e.max, step: e.step, value: e.value }));
      ok('a number input, min 0, max 10, step 0.5, blank by default', f.type === 'number' && f.min === '0' && f.max === '10' && f.step === '0.5' && f.value === '', JSON.stringify(f));
      ok('the label says 出血（mm…）', (await T(page, 'label[for="opf-bleed-mm"]')).startsWith('出血（mm'));
      ok('shown for an album (really on screen)', await shown(page, '#opf-bleed-mm'));
      await page.selectOption('#opf-kind', 'print');
      ok('and still shown for a print (while the page fields are hidden — positive for both)',
        (await shown(page, '#opf-bleed-mm')) && (await disp(page, '#opf-pages-group')) === 'none');
      await page.selectOption('#opf-kind', 'album');

      // blank → null, key present
      await fillRow(page, '相本書');
      await page.click('#opf-save');
      await page.waitForSelector('#op-form[data-mode="edit"]', { timeout: 3000 });
      ok('blank bleed is sent as null (key present, so an edit can clear it)', posts(o).length === 1 && 'bleed_mm' in posts(o)[0].body && posts(o)[0].body.bleed_mm === null, JSON.stringify(posts(o)[0]?.body));
      await page.click('#opf-cancel');

      // an album with 3
      await page.click('#op-add-btn');
      await page.waitForSelector('#op-form');
      await fillRow(page, '相本三');
      await page.fill('#opf-bleed-mm', '3');
      await page.click('#opf-save');
      await page.waitForSelector('#op-form[data-mode="edit"]', { timeout: 3000 });
      ok('an album with 3 → POST bleed_mm: 3 (a number)', posts(o)[1].body.bleed_mm === 3 && o.st.platform[1].bleed_mm === 3, JSON.stringify(posts(o)[1]?.body));
      await page.click('#opf-cancel');

      // a print with 2.5
      await page.click('#op-add-btn');
      await page.waitForSelector('#op-form');
      await page.selectOption('#opf-kind', 'print');
      await fillRow(page, '無框畫');
      await page.fill('#opf-bleed-mm', '2.5');
      await page.click('#opf-save');
      await page.waitForSelector('#op-form[data-mode="edit"]', { timeout: 3000 });
      const pb = posts(o)[2].body;
      ok('a print with 2.5 → bleed_mm: 2.5 is sent (and still no page bounds)', pb.kind === 'print' && pb.bleed_mm === 2.5 && !('min_pages' in pb), JSON.stringify(pb));
      ok('the stored print carries 2.5', o.st.platform[2].bleed_mm === 2.5);
      ok('the edit form shows the stored value back', (await page.inputValue('#opf-bleed-mm')) === '2.5');
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

{
  const o = ordersFake({ platform: [], products: [] });
  await suite('bleed ui — 驗證：超出 0–10、非數字不送出，欄位下方顯示訊息；0 與 10 可存',
    `${base}/operator.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#op-list .hint', { timeout: 5000 });
      await page.click('#op-add-btn');
      await page.waitForSelector('#op-form');
      await fillRow(page, '相本書');
      const MSG = '出血需為 0–10 mm 的數字（或留空）';
      for (const bad of ['10.5', '11', '-1', 'abc', '1e1', '2,5']) {
        // a type=number input drops text it cannot parse: set the raw value through the DOM
        await page.$eval('#opf-bleed-mm', (e, v) => { e.type = 'text'; e.value = v; }, bad);
        await page.click('#opf-save');
        ok(`"${bad}" is refused inline, nothing sent`, (await bleedErr(page)) === MSG && (await page.$eval('#opf-bleed-mm', e => e.getAttribute('aria-invalid'))) === 'true' && posts(o).length === 0, `${await bleedErr(page)} / ${posts(o).length}`);
      }
      ok('the message is visible red text', (await page.$eval('#opf-bleed-mm-err', e => getComputedStyle(e).color)) === RED);
      await page.fill('#opf-bleed-mm', '4');
      ok('typing clears the message', (await bleedErr(page)) === '');
      await page.fill('#opf-bleed-mm', '10');
      await page.click('#opf-save');
      await page.waitForSelector('#op-form[data-mode="edit"]', { timeout: 3000 });
      ok('10 (the upper bound) is accepted', posts(o).length === 1 && posts(o)[0].body.bleed_mm === 10, JSON.stringify(posts(o)[0]?.body));
      await page.click('#opf-cancel');
      await page.click('#op-add-btn');
      await page.waitForSelector('#op-form');
      await fillRow(page, '相本零');
      await page.fill('#opf-bleed-mm', '0');
      await page.click('#opf-save');
      await page.waitForSelector('#op-form[data-mode="edit"]', { timeout: 3000 });
      ok('0 is accepted and sent as the number 0', posts(o).length === 2 && posts(o)[1].body.bleed_mm === 0, JSON.stringify(posts(o)[1]?.body));
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

{
  const o = ordersFake({ platform: [], products: [], pageColumns: { bleed_mm: false } });
  await suite('bleed ui — migration 還沒跑：500 bleed_mm_unavailable → 「尚未啟用，請先執行 migration」，留空仍可存',
    `${base}/operator.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#op-list .hint', { timeout: 5000 });
      await page.click('#op-add-btn');
      await page.waitForSelector('#op-form');
      await fillRow(page, '相本書');
      await page.fill('#opf-bleed-mm', '3');
      await page.click('#opf-save');
      await waitText(page, '#opf-err', t => t.includes('尚未啟用'));
      ok('the plain-language message names the migration, nothing stored', (await T(page, '#opf-err')).includes('尚未啟用，請先執行 migration') && o.st.platform.length === 0, await T(page, '#opf-err'));
      await page.fill('#opf-bleed-mm', '');
      await page.click('#opf-save');
      await page.waitForSelector('#op-form[data-mode="edit"]', { timeout: 3000 });
      ok('with the field blank the save goes through (null never needs the column)', o.st.platform.length === 1, JSON.stringify(o.st.platform));
      ok('the list shows no bleed (the column reads null)', (await page.$('#op-list [data-bleed]')) === null);
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

{
  const o = ordersFake({ platform: [], products: [] });
  o.st.inject = (method, path) => (method === 'POST' && path === '/api/operator/products' ? { status: 400, body: { error: 'invalid bleed mm', code: 'invalid_bleed_mm' } } : null);
  await suite('bleed ui — Worker 回 invalid_bleed_mm → 中文訊息，不是英文錯誤字串',
    `${base}/operator.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#op-list .hint', { timeout: 5000 });
      await page.click('#op-add-btn');
      await page.waitForSelector('#op-form');
      await fillRow(page, '相本書');
      await page.click('#opf-save');
      await waitText(page, '#opf-err', t => t.length > 0);
      ok('「出血需為 0–10 mm 的數字（或留空）」', (await T(page, '#opf-err')) === '出血需為 0–10 mm 的數字（或留空）', await T(page, '#opf-err'));
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

// ═══ operator list + the photographer's read-only list ════════════════════
{
  const fx = [
    platAlbum({ id: 'pa-3', name: '三毫米', bleed_mm: 3, sort: 0 }),
    platAlbum({ id: 'pa-frac', name: '小數', bleed_mm: 2.5, sort: 1 }),
    platAlbum({ id: 'pa-null', name: '沒設', bleed_mm: null, sort: 2 }),
    platAlbum({ id: 'pa-zero', name: '零', bleed_mm: 0, sort: 3 }),
    platPrint({ id: 'pp-2', name: '輸出二毫米', bleed_mm: 2, sort: 4 }),
  ];
  const o = ordersFake({ platform: fx, products: [] });
  await suite('bleed ui — 營運者清單：「出血 3 mm」「出血 2.5 mm」，沒設或 0 不顯示，輸出品也顯示；編輯表單帶入值',
    `${base}/operator.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#op-list .prod-row', { timeout: 5000 });
      const bleed = id => page.$eval(`[data-product-id="${id}"]`, e => { const b = e.querySelector('[data-bleed]'); return b ? { text: b.textContent, shown: getComputedStyle(b).display !== 'none', main: e.querySelector('.prod-main').contains(b) } : null; });
      const a = await bleed('pa-3');
      ok('3 → 「出血 3 mm」 visible inside the product block', a && a.text === '出血 3 mm' && a.shown && a.main, JSON.stringify(a));
      ok('2.5 → 「出血 2.5 mm」', (await bleed('pa-frac'))?.text === '出血 2.5 mm');
      ok('a print shows it too: 「出血 2 mm」', (await bleed('pp-2'))?.text === '出血 2 mm');
      ok('null shows nothing (positive: the row is listed)', (await bleed('pa-null')) === null && (await T(page, '[data-product-id="pa-null"]')).includes('沒設'));
      ok('0 shows nothing (positive: the row is listed)', (await bleed('pa-zero')) === null && (await T(page, '[data-product-id="pa-zero"]')).includes('零'));
      await page.click('[data-product-id="pa-frac"] [data-edit]');
      await page.waitForSelector('#op-form[data-mode="edit"]');
      ok('editing 小數 shows 2.5 in the field', (await page.inputValue('#opf-bleed-mm')) === '2.5');
      await page.fill('#opf-bleed-mm', '');
      await page.click('#opf-save');
      await page.waitForFunction(() => !document.querySelector('[data-product-id="pa-frac"] [data-bleed]'), null, { timeout: 3000 });
      ok('clearing it sends null on the PUT and the list drops the label', puts(o).length === 1 && puts(o)[0].body.bleed_mm === null, JSON.stringify(puts(o)[0]?.body));
      return out;
    },
    { before: o.attach, initScript: OP_SEED });
}

{
  const platA = platAlbum({ bleed_mm: 3 });
  const prodAlbum = clone(PROD_ALBUM);
  const o = ordersFake({ platform: [platA], products: [prodAlbum] });
  const dm = dashSettingsMock();
  await suite('bleed ui — 攝影師商品清單：平台商品唯讀顯示「出血 3 mm」，編輯表單沒有出血欄位',
    `${base}/settings.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('.prod-row', { timeout: 5000 });
      const b = await page.$eval('[data-product-id="prod-album"]', e => { const x = e.querySelector('[data-bleed]'); return x ? { text: x.textContent, shown: getComputedStyle(x).display !== 'none' } : null; });
      ok('the adopted album reads 「出血 3 mm」', b && b.text === '出血 3 mm' && b.shown, JSON.stringify(b));
      ok('settings has no bleed input anywhere', (await page.$('#opf-bleed-mm, [name="bleed_mm"], #prod-bleed')) === null);
      return out;
    },
    { before: async p => { await dm.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });}

// ═══ admin: shoot date on create and in the detail ════════════════════════
{
  const m = pickFakeWorker({ pickFiles: [] });
  await suite('shoot date ui — 建立專案：拍攝日期欄位的值一併送出 shoot_date（同時是資料夾名稱的日期）',
    `${base}/admin.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#admin-view', { state: 'visible', timeout: 5000 });
      await openCreateForm(page);
      await page.fill('#proj-date', '2026-10-04');
      await page.fill('#proj-title', '王小明');
      await page.click('#proj-create-btn');
      await page.waitForSelector('#proj-create-result', { state: 'visible', timeout: 5000 });
      const req = m.requests.find(r => r.method === 'POST' && r.path === '/api/admin/projects');
      ok('POST body carries shoot_date: "2026-10-04"', req && req.body.shoot_date === '2026-10-04', JSON.stringify(req?.body));
      ok('the date field is still a date input (positive)', (await page.$eval('#proj-date', e => e.type)) === 'date');
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ pickFiles: [], shootDateColumn: false });
  await suite('shoot date ui — 建立專案遇到 shoot_date_unavailable：中文訊息（請先執行 migration），不顯示英文錯誤',
    `${base}/admin.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#admin-view', { state: 'visible', timeout: 5000 });
      await openCreateForm(page);
      await page.fill('#proj-date', '2026-10-04');
      await page.fill('#proj-title', '王小明');
      await page.click('#proj-create-btn');
      await page.waitForFunction(() => document.getElementById('proj-create-err').textContent.length > 0, null, { timeout: 5000 });
      const t = await T(page, '#proj-create-err');
      ok('「拍攝日期尚未啟用，請先執行 migration…」', t.includes('尚未啟用，請先執行 migration'), t);
      ok('no link was shown', (await page.$eval('#proj-create-result', e => getComputedStyle(e).display)) === 'none');
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-sd', ownerName: 'Grace', folders: ['shoot/毛片/'], pickFiles: ['shoot/毛片/a.jpg'], shootDate: '2026-09-21' });
  const patches = () => m.requests.filter(r => r.method === 'PATCH' && r.path === '/api/admin/projects/proj-sd');
  await suite('shoot date ui — 專案詳情：標題列顯示拍攝日期，可改、可清除（PATCH shoot_date，空白 → null）',
    `${base}/admin.html#project=proj-sd`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#pd-shoot-input', { timeout: 5000 });
      const head = () => page.$eval('#pd-shoot-text', e => ({ text: e.textContent, shown: e.getClientRects().length > 0, inHead: !!e.closest('.pd-head') }));
      let h = await head();
      ok('the header shows 「拍攝日期 2026-09-21」, on screen, inside the header row', h.text === '拍攝日期 2026-09-21' && h.shown && h.inHead, JSON.stringify(h));
      ok('the input is a date input holding the stored day', (await page.$eval('#pd-shoot-input', e => e.type + '|' + e.value)) === 'date|2026-09-21');
      await page.fill('#pd-shoot-input', '2026-10-05');
      await page.click('#pd-shoot-save');
      await page.waitForFunction(() => document.getElementById('pd-shoot-text').textContent.includes('2026-10-05'), null, { timeout: 3000 });
      ok('PATCH {shoot_date: "2026-10-05"} and the header follows', patches().length === 1 && JSON.stringify(patches()[0].body) === '{"shoot_date":"2026-10-05"}', JSON.stringify(patches()[0]?.body));
      ok('the fake stored it', m.state.project.shoot_date === '2026-10-05');
      await page.fill('#pd-shoot-input', '');
      await page.click('#pd-shoot-save');
      await page.waitForFunction(() => document.getElementById('pd-shoot-text').getClientRects().length === 0, null, { timeout: 3000 });
      ok('an emptied field sends null and the header text goes away', JSON.stringify(patches()[1].body) === '{"shoot_date":null}' && m.state.project.shoot_date === null, JSON.stringify(patches()[1]?.body));
      ok('the input is empty again', (await page.inputValue('#pd-shoot-input')) === '');
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-sd2', ownerName: 'Grace', folders: ['shoot/毛片/'], pickFiles: ['shoot/毛片/a.jpg'], shootDateColumn: false });
  await suite('shoot date ui — 專案詳情：migration 還沒跑 → 儲存顯示中文訊息，頁面不變；沒有日期時標題列不顯示',
    `${base}/admin.html#project=proj-sd2`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#pd-shoot-input', { timeout: 5000 });
      ok('no date: the header text is not on screen (positive: the input is)', (await page.$eval('#pd-shoot-text', e => e.getClientRects().length)) === 0 && (await shown(page, '#pd-shoot-input')));
      await page.fill('#pd-shoot-input', '2026-10-05');
      await page.click('#pd-shoot-save');
      await waitText(page, '#pd-shoot-err', t => t.length > 0);
      const t = await T(page, '#pd-shoot-err');
      ok('「拍攝日期尚未啟用，請先執行 migration…」', t.includes('尚未啟用，請先執行 migration'), t);
      ok('the header still shows nothing', (await page.$eval('#pd-shoot-text', e => e.getClientRects().length)) === 0);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ═══ the 完成頁: 拍攝日期 ═════════════════════════════════════════════════
const T0 = '2026-09-21T03:00:00.000Z';
const OWNER = "localStorage.setItem('pick_key:TOK', 'ZOE-KEY');";
const cpWorld = fake => albumWorld({ n: 6, sub: 0, fake: { title: '婚禮精修', confirmedAt: T0, ...fake } });
const cpReady = async page => {
  await page.waitForSelector('#completionPage', { timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll('#completionPage .fg-tile').length === 6, null, { timeout: 5000 });
};
const heroLook = page => page.evaluate(() => {
  const e = document.getElementById('cpShootDate');
  const hero = document.getElementById('cpHero');
  const r = e.getBoundingClientRect();
  return { text: e.textContent, shown: e.getClientRects().length > 0 && r.height > 0, inHero: hero.contains(e), h: hero.getBoundingClientRect().height, tag: e.tagName };
});
for (const [who, co] of [['390px', MOBILE], ['1280px', { viewport: { width: 1280, height: 800 } }]]) {
  const w = cpWorld({ shootDate: '2026-09-21' });
  await suite(`shoot date ui — 完成頁（${who}）：有拍攝日期 → 「拍攝日期 2026.09.21」在 hero 內`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = okFn(out);
      await cpReady(page);
      const s = await heroLook(page);
      ok('text is exactly 「拍攝日期 2026.09.21」, displayed, inside the hero', s.text === '拍攝日期 2026.09.21' && s.shown && s.inHero, JSON.stringify(s));
      ok('it sits after the confirmed line (same text block)', await page.evaluate(() => { const c = document.getElementById('cpConfirmed'), d = document.getElementById('cpShootDate'); return c.parentElement === d.parentElement && !!(c.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING); }));
      ok('it is not horizontally clipped on this width', await page.evaluate(() => { const r = document.getElementById('cpShootDate').getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; }));
      ok('the state read carried shoot_date (the fake mirrors the Worker: confirmed only)', w.m.requests.some(r => r.path === '/api/pick/state'));
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: co });
}

{
  const w = cpWorld({ shootDate: null });
  await suite('shoot date ui — 完成頁：沒有拍攝日期 → 沒有那一行（不佔位、不顯示），頁面其餘照常',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = okFn(out);
      await cpReady(page);
      const s = await heroLook(page);
      ok('the line is empty and takes no box (not shown, height 0)', s.text === '' && !s.shown, JSON.stringify(s));
      ok('display is none, so its margin takes no room either (no layout shift)', (await disp(page, '#cpShootDate')) === 'none');
      ok('positive: the rest of the hero is there (title and confirmed line)', (await T(page, '#cpTitle')) === '婚禮精修' && (await T(page, '#cpConfirmed')).startsWith('已確認完成'));
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}

{
  const w = cpWorld({ shootDate: '2026-09-21', confirmedAt: null });
  await suite('shoot date ui — 完成頁：沒確認的交件（驗收頁）不顯示拍攝日期，Worker 也不會送',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#deliveryDone', { timeout: 5000 });
      ok('positive: the 驗收頁 is up', (await page.$('#doneConfirmBtn')) !== null);
      ok('no completion page and no 拍攝日期 text anywhere', (await page.$('#completionPage')) === null && !(await page.evaluate(() => document.body.textContent.includes('拍攝日期'))));
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}

{
  const w = cpWorld({ shootDate: '2026-09-21' });
  await suite('shoot date ui — 完成頁：shootDateText 只接受 YYYY-MM-DD，其餘（HTML、其他格式、非字串）都不顯示',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = okFn(out);
      await cpReady(page);
      const r = await page.evaluate(() => ['2026-09-21', '2026-9-21', '<img src=x onerror=window.__xss=1>', '2026-09-21<b>', ' 2026-09-21', '', null, undefined, 20260921, {}].map(v => CompletionPage.shootDateText(v)));
      ok('only the exact day yields text', r[0] === '拍攝日期 2026.09.21' && r.slice(1).every(x => x === null), JSON.stringify(r));
      ok('and nothing was executed', (await page.evaluate(() => window.__xss)) === undefined);
      return out;
    },
    { before: w.before, initScript: OWNER, contextOptions: MOBILE });
}

}
