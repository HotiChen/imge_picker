// Browser suites: admin.html 選片專案 list — 攝影類別 (projects.project_type: create form, detail, list tag),
// search + status + category filter + 「待我處理」 sort, and the filter state living in the URL hash next to
// #project=<id>. The fake (pick-fake.mjs) mirrors the Worker contract: project_type nullable, '' / null clears,
// bad → 400 invalid_project_type, before the migration a write → 500 project_type_unavailable.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { ADMIN_PLAIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { openCreateForm } from '../lib/project-helpers.mjs';

export default async function register() {
const ADMIN_URL = `${base}/admin.html`;
const iso = '2026-09-01T00:00:00.000Z';
// 8 rows. main = A (picking, 婚紗). Expected status sets below are written out by hand.
const EXTRA = [
  { id: 'proj-B', title: 'Amy Wedding', phase: 'submitted', owner_name: 'Amy', project_type: '婚禮' },
  { id: 'proj-C', title: '親子寫真', phase: 'retouching', project_type: '親子' },
  { id: 'proj-D', title: 'Delivered Co', phase: 'retouching', delivered_at: iso, project_type: null },
  { id: 'proj-E', title: 'Confirmed Co', phase: 'retouching', delivered_at: iso, client_confirmed_at: iso, client_confirmed_by: 'guest', project_type: '嬰兒寫真' },
  { id: 'proj-F', title: 'Revising Co', phase: 'retouching', delivered_at: iso, open_revision_count: 2, project_type: '個人' },
  { id: 'proj-G', title: 'Plain Picking', phase: 'picking', owner_name: 'Bob', project_type: null },
  { id: 'proj-H', title: '<b>bold</b> tag', phase: 'picking', project_type: null },
];
const IDS = ['proj-A', ...EXTRA.map(x => x.id)];
const fx = (o = {}) => pickFakeWorker({ projectId: 'proj-A', title: '王小明 婚紗', phase: 'picking', projectType: '婚紗', folders: ['shoot/毛片/'], extraProjects: EXTRA, ...o });
const lines = () => { const out = []; return { out, ok: (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`) }; };
const rowIds = page => page.$$eval('[data-project-row]', els => els.map(e => e.dataset.projectRow));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const waitRows = (page, n) => page.waitForFunction(k => document.querySelectorAll('[data-project-row]').length === k, n, { timeout: 4000 });
const waitList = page => page.waitForSelector('[data-project-row]', { state: 'visible', timeout: 5000 });
const hash = page => page.evaluate(() => location.hash);
const shown = (page, sel) => page.$eval(sel, e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden');
const setStatus = async (page, v, n) => { await page.selectOption('#pl-status', v); await waitRows(page, n); return rowIds(page); };

// ── 1. list: category tag, search ──
{
  const m = fx();
  await suite('admin 列表篩選 — 搜尋：標題與客戶名、不分大小寫、即時；沒有結果顯示「沒有符合的專案」；類別標籤顯示在列上',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await waitList(page);
      await waitRows(page, 8);
      ok('baseline: all 8 rows are listed (floor)', same(await rowIds(page), IDS), JSON.stringify(await rowIds(page)));
      const tagOf = id => page.$eval(`[data-project-row="${id}"]`, r => { const t = r.querySelector('[data-project-type-tag]'); return t ? t.textContent.trim() : null; });
      ok('row A carries the 婚紗 tag', (await tagOf('proj-A')) === '婚紗', await tagOf('proj-A'));
      ok('row B carries 婚禮, row E carries the typed 嬰兒寫真', (await tagOf('proj-B')) === '婚禮' && (await tagOf('proj-E')) === '嬰兒寫真');
      ok('a row without a category has NO tag (positive controls above)', (await tagOf('proj-D')) === null && (await tagOf('proj-G')) === null);

      await page.fill('#pl-q', 'AMY');
      await waitRows(page, 1);
      ok('"AMY" (upper case) finds Amy Wedding by title, live (no Enter pressed)', same(await rowIds(page), ['proj-B']), JSON.stringify(await rowIds(page)));
      await page.fill('#pl-q', 'bob');
      await waitRows(page, 1);
      ok('"bob" finds the project whose client (owner) is Bob', same(await rowIds(page), ['proj-G']), JSON.stringify(await rowIds(page)));
      await page.fill('#pl-q', '婚');
      await waitRows(page, 1);
      ok('a Chinese title fragment "婚" matches the title 王小明 婚紗 only', same(await rowIds(page), ['proj-A']), JSON.stringify(await rowIds(page)));
      await page.fill('#pl-q', '  amy  ');
      await waitRows(page, 1);
      ok('surrounding spaces are ignored', same(await rowIds(page), ['proj-B']));
      await page.fill('#pl-q', '<b>');
      await waitRows(page, 1);
      ok('"<b>" matches the literal title and renders as text, not as markup', same(await rowIds(page), ['proj-H'])
        && (await page.$$eval('#proj-recent-list b', e => e.length)) === 0, JSON.stringify(await rowIds(page)));
      await page.fill('#pl-q', 'zzzz-nothing');
      await waitRows(page, 0);
      const txt = await page.$eval('#proj-recent-list', e => e.textContent.trim());
      ok('no match → 「沒有符合的專案」 (not the 尚未建立過專案 text)', txt === '沒有符合的專案', txt);
      await page.fill('#pl-q', '');
      await waitRows(page, 8);
      ok('clearing the box brings all 8 back', same(await rowIds(page), IDS));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

// ── 2. status filter, category filter, sort ──
{
  const m = fx();
  await suite('admin 列表篩選 — 狀態與類別篩選、待我處理排序（與列上徽章同一套狀態）',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await waitList(page);
      await waitRows(page, 8);
      const opts = await page.$$eval('#pl-status option', o => o.map(x => x.textContent.trim()));
      ok('status options: 全部, 選片中, 已送出, 精修中, 已交件, 客戶已確認, 待修改', same(opts, ['全部狀態', '選片中', '已送出', '精修中', '已交件', '客戶已確認', '待修改']), JSON.stringify(opts));
      let r = await setStatus(page, 'picking', 3);
      ok('選片中 → A, G, H', same(r, ['proj-A', 'proj-G', 'proj-H']), JSON.stringify(r));
      r = await setStatus(page, 'submitted', 1);
      ok('已送出 → B', same(r, ['proj-B']), JSON.stringify(r));
      r = await setStatus(page, 'retouching', 1);
      ok('精修中 → C only (a delivered project is 已交件, not still 精修中)', same(r, ['proj-C']), JSON.stringify(r));
      r = await setStatus(page, 'delivered', 3);
      ok('已交件 → D, E, F (delivered_at set)', same(r, ['proj-D', 'proj-E', 'proj-F']), JSON.stringify(r));
      r = await setStatus(page, 'confirmed', 1);
      ok('客戶已確認 → E', same(r, ['proj-E']), JSON.stringify(r));
      r = await setStatus(page, 'revising', 1);
      ok('待修改 → F (open revision requests)', same(r, ['proj-F']), JSON.stringify(r));
      // the filter agrees with the badges drawn on the same rows
      const badgeOk = await page.$eval('[data-project-row="proj-F"]', row => !!row.querySelector('[data-confirm-badge="revising"]'));
      ok('and that row really shows the 待修改 badge (same status source)', badgeOk);
      await page.selectOption('#pl-status', 'all'); await waitRows(page, 8);

      const types = await page.$$eval('#pl-type option', o => o.map(x => x.textContent.trim()));
      ok('category options: 全部類別, 未分類 + the SHOOT_TYPES list', same(types, ['全部類別', '未分類', '婚紗', '婚禮', '親子', '個人', '活動', '其他']), JSON.stringify(types));
      await page.selectOption('#pl-type', '婚禮'); await waitRows(page, 1);
      ok('婚禮 → B', same(await rowIds(page), ['proj-B']));
      await page.selectOption('#pl-type', 'none'); await waitRows(page, 3);
      ok('未分類 → D, G, H', same(await rowIds(page), ['proj-D', 'proj-G', 'proj-H']), JSON.stringify(await rowIds(page)));
      await page.selectOption('#pl-type', '其他'); await waitRows(page, 1);
      ok('其他 also catches a typed category (嬰兒寫真 → E)', same(await rowIds(page), ['proj-E']), JSON.stringify(await rowIds(page)));
      await page.selectOption('#pl-type', 'all'); await waitRows(page, 8);

      // combined: 已交件 AND 未分類 AND search
      await page.selectOption('#pl-status', 'delivered'); await page.selectOption('#pl-type', 'none'); await waitRows(page, 1);
      ok('status + category are ANDed: 已交件 + 未分類 → D', same(await rowIds(page), ['proj-D']), JSON.stringify(await rowIds(page)));
      await page.fill('#pl-q', 'nothing-here'); await waitRows(page, 0);
      ok('and search is ANDed on top (no row, still the 沒有符合 text)', (await page.$eval('#proj-recent-list', e => e.textContent.trim())) === '沒有符合的專案');
      await page.fill('#pl-q', ''); await page.selectOption('#pl-status', 'all'); await page.selectOption('#pl-type', 'all'); await waitRows(page, 8);

      ok('default order is the server order', same(await rowIds(page), IDS));
      await page.selectOption('#pl-sort', 'me');
      await page.waitForFunction(() => document.querySelector('[data-project-row]').dataset.projectRow === 'proj-B', null, { timeout: 3000 });
      r = await rowIds(page);
      ok('待我處理: B (submitted) and F (open revision) first, in their old relative order, rest keep order',
        same(r, ['proj-B', 'proj-F', 'proj-A', 'proj-C', 'proj-D', 'proj-E', 'proj-G', 'proj-H']), JSON.stringify(r));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

// ── 3. hash: reload, open + back ──
{
  const m = fx();
  await suite('admin 列表篩選 — 篩選狀態在網址 hash：重新整理保留、開啟專案再返回保留、與 #project=<id> 並存',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await waitList(page);
      await waitRows(page, 8);
      ok('no filters → the hash stays empty', (await hash(page)) === '', await hash(page));
      await page.fill('#pl-q', 'co');
      await page.selectOption('#pl-status', 'delivered');
      await page.selectOption('#pl-type', 'none');
      await waitRows(page, 1);
      const h = await hash(page);
      const hp = new URLSearchParams(h.slice(1));
      ok('hash carries q, status, type', hp.get('q') === 'co' && hp.get('status') === 'delivered' && hp.get('type') === 'none' && !hp.has('project'), h);
      await page.reload({ waitUntil: 'load' });
      await waitList(page);
      await waitRows(page, 1);
      ok('after reload: the controls show the same values', (await page.inputValue('#pl-q')) === 'co' && (await page.inputValue('#pl-status')) === 'delivered' && (await page.inputValue('#pl-type')) === 'none');
      ok('after reload: the list is filtered (D only)', same(await rowIds(page), ['proj-D']), JSON.stringify(await rowIds(page)));

      // open a project from the filtered list, then 返回
      await page.fill('#pl-q', ''); await page.selectOption('#pl-type', 'all'); await page.selectOption('#pl-status', 'picking');
      await waitRows(page, 3);
      await page.click('[data-project-row="proj-A"] [data-open-project]');
      await page.waitForSelector('#pd-sec-settings', { timeout: 5000 });
      const dh = new URLSearchParams((await hash(page)).slice(1));
      ok('detail hash has project=proj-A AND keeps status=picking', dh.get('project') === 'proj-A' && dh.get('status') === 'picking', await hash(page));
      ok('detail is up, list hidden', (await shown(page, '#project-detail-panel')) && !(await shown(page, '#proj-recent-list')));
      await page.click('#pd-back-btn');
      await waitList(page);
      await waitRows(page, 3);
      ok('after 返回: list back with the status filter still applied', (await page.inputValue('#pl-status')) === 'picking' && same(await rowIds(page), ['proj-A', 'proj-G', 'proj-H']), JSON.stringify(await rowIds(page)));
      ok('and the hash is the filter again, no project', new URLSearchParams((await hash(page)).slice(1)).get('status') === 'picking' && !/project=/.test(await hash(page)), await hash(page));

      // whole-row click + browser back
      await page.click('[data-project-row="proj-A"] .pd-owner');
      await page.waitForSelector('#pd-sec-settings', { timeout: 5000 });
      ok('the whole-row click still opens the detail', (await hash(page)).includes('project=proj-A'), await hash(page));
      await page.goBack();
      await waitList(page);
      await waitRows(page, 3);
      ok('browser Back returns to the filtered list', same(await rowIds(page), ['proj-A', 'proj-G', 'proj-H']) && (await page.inputValue('#pl-status')) === 'picking');
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

{
  const m = fx();
  await suite('admin 列表篩選 — 直接開啟 #project=<id>&status=… 連結：詳情開啟，返回後列表套用篩選；未知的篩選值被忽略',
    `${ADMIN_URL}#project=proj-A&status=picking&q=%E7%8E%8B`,
    async page => {
      const { out, ok } = lines();
      await page.waitForSelector('#pd-sec-settings', { timeout: 5000 });
      ok('the detail of proj-A opened from the combined hash', (await page.textContent('.pd-head h3')) === '王小明 婚紗');
      await page.click('#pd-back-btn');
      await waitList(page);
      await waitRows(page, 1);
      ok('返回 (no history entry behind it) lands on the list with q and status applied', (await page.inputValue('#pl-q')) === '王' && (await page.inputValue('#pl-status')) === 'picking' && same(await rowIds(page), ['proj-A']), JSON.stringify(await rowIds(page)));
      const hp = new URLSearchParams((await hash(page)).slice(1));
      ok('hash is the filters only', hp.get('q') === '王' && hp.get('status') === 'picking' && !hp.has('project'), await hash(page));
      await page.goto(`${ADMIN_URL}#status=bogus&type=bogus&sort=bogus`, { waitUntil: 'load' });
      await waitList(page);
      await waitRows(page, 8);
      ok('unknown status / type / sort values are ignored: all 8 rows, selects on their first option',
        (await page.inputValue('#pl-status')) === 'all' && (await page.inputValue('#pl-type')) === 'all' && (await page.inputValue('#pl-sort')) === 'default');
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

// ── 4. create form ──
{
  const m = fx();
  const posts = () => m.requests.filter(r => r.method === 'POST' && r.path === '/api/admin/projects');
  await suite('admin 攝影類別 — 建立表單：預設未分類（不送欄位）、選類別照送、其他 → 自行輸入、錯誤用中文顯示',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await waitList(page);
      await openCreateForm(page);   // the form is behind 「＋ 新增專案」; open it so the not-shown check below is a real one
      const o = await page.$$eval('#proj-type option', os => os.map(x => ({ v: x.value, t: x.textContent.trim() })));
      ok('select: 未分類 first (value ""), then the SHOOT_TYPES list', o[0].v === '' && o[0].t === '未分類' && same(o.slice(1).map(x => x.v), ['婚紗', '婚禮', '親子', '個人', '活動', '其他']), JSON.stringify(o));
      ok('default is 未分類; the typed-text box is not shown', (await page.inputValue('#proj-type')) === '' && !(await shown(page, '#proj-type-other')));
      await page.fill('#proj-title', '案一');
      await page.click('#proj-create-btn');
      await page.waitForFunction(() => document.getElementById('proj-create-result').style.display === 'block', null, { timeout: 4000 });
      ok('unset → the POST has no project_type key', posts().length === 1 && !('project_type' in posts()[0].body), JSON.stringify(posts()[0]?.body));

      await openCreateForm(page);
      await page.selectOption('#proj-type', '婚禮');
      await page.fill('#proj-title', '案二');
      await page.click('#proj-create-btn');
      await page.waitForFunction(() => document.getElementById('proj-title').value === '' , null, { timeout: 4000 });
      ok('婚禮 → POST project_type "婚禮"', posts().length === 2 && posts()[1].body.project_type === '婚禮', JSON.stringify(posts()[1]?.body));
      ok('the form resets the category to 未分類 after a create', (await page.inputValue('#proj-type')) === '');

      await openCreateForm(page);
      await page.selectOption('#proj-type', '其他');
      await page.fill('#proj-title', '案二b');
      await page.click('#proj-create-btn');
      await page.waitForFunction(() => document.getElementById('proj-title').value === '', null, { timeout: 4000 });
      ok('其他 with an empty box sends NO project_type (never the literal 其他)', posts().length === 3 && !('project_type' in posts()[2].body), JSON.stringify(posts()[2]?.body));
      await openCreateForm(page);
      await page.selectOption('#proj-type', '其他');
      ok('其他 reveals the typed-text box (maxlength 20)', (await shown(page, '#proj-type-other')) && (await page.getAttribute('#proj-type-other', 'maxlength')) === '20');
      await page.fill('#proj-title', '案三');
      await page.fill('#proj-type-other', '嬰兒寫真');
      await page.click('#proj-create-btn');
      await page.waitForFunction(() => document.getElementById('proj-title').value === '', null, { timeout: 4000 });
      ok('typed text is what gets sent', posts().length === 4 && posts()[3].body.project_type === '嬰兒寫真', JSON.stringify(posts()[3]?.body));
      ok('after the create the typed box is hidden again', !(await shown(page, '#proj-type-other')));

      // server refusal → plain Chinese. maxlength is lifted on purpose so the Worker's 400 is reachable.
      await openCreateForm(page);
      await page.selectOption('#proj-type', '其他');
      await page.$eval('#proj-type-other', e => e.removeAttribute('maxlength'));
      await page.fill('#proj-type-other', 'x'.repeat(21));
      await page.fill('#proj-title', '案四');
      await page.click('#proj-create-btn');
      await page.waitForFunction(() => document.getElementById('proj-create-err').textContent.trim() !== '', null, { timeout: 4000 });
      const e = await page.$eval('#proj-create-err', x => x.textContent.trim());
      ok('invalid_project_type → 攝影類別不正確（最多 20 字）', e === '攝影類別不正確（最多 20 字）', e);
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

{
  const m = fx({ projectTypeColumn: false });
  await suite('admin 攝影類別 — migration 還沒跑：建立與儲存顯示「攝影類別尚未啟用…」，未選類別仍可建立',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      const MSG = '攝影類別尚未啟用，請先執行 migration（2026-10-07-project-type.sql）';
      await waitList(page);
      await openCreateForm(page);
      await page.selectOption('#proj-type', '親子');
      await page.fill('#proj-title', '案五');
      await page.click('#proj-create-btn');
      await page.waitForFunction(() => document.getElementById('proj-create-err').textContent.trim() !== '', null, { timeout: 4000 });
      ok('create with a category → the migration message', (await page.$eval('#proj-create-err', x => x.textContent.trim())) === MSG);
      await page.selectOption('#proj-type', '');
      await page.click('#proj-create-btn');
      await page.waitForFunction(() => document.getElementById('proj-create-result').style.display === 'block', null, { timeout: 4000 });
      ok('create without one still works (positive control)', (await page.$eval('#proj-create-err', x => x.textContent.trim())) === '');
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-type-select', { timeout: 5000 });
      await page.selectOption('#pd-type-select', '親子');
      await page.click('#pd-type-save');
      await page.waitForFunction(() => document.getElementById('pd-type-err').textContent.trim() !== '', null, { timeout: 4000 });
      ok('detail save → the migration message', (await page.$eval('#pd-type-err', x => x.textContent.trim())) === MSG);
      ok('and the header tag shows nothing (nothing was stored)', (await page.$('#pd-type-tag')) === null || !(await shown(page, '#pd-type-tag')));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

// ── 5. detail edit ──
{
  const m = fx();
  const patches = () => m.requests.filter(r => r.method === 'PATCH' && /^\/api\/admin\/projects\/[^/]+$/.test(r.path));
  await suite('admin 攝影類別 — 詳情：顯示目前類別、可改、可清除（PATCH），列表標籤同步',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await waitList(page);
      await page.click('[data-project-row="proj-A"] [data-open-project]');
      await page.waitForSelector('#pd-type-select', { timeout: 5000 });
      ok('the select shows the stored 婚紗', (await page.inputValue('#pd-type-select')) === '婚紗');
      ok('header tag shows 婚紗', (await page.textContent('#pd-type-tag')).trim() === '婚紗');
      await page.selectOption('#pd-type-select', '親子');
      await page.click('#pd-type-save');
      await page.waitForFunction(() => document.getElementById('pd-type-tag')?.textContent.trim() === '親子', null, { timeout: 4000 });
      ok('PATCH { project_type: "親子" }', patches().length === 1 && same(patches()[0].body, { project_type: '親子' }), JSON.stringify(patches()[0]?.body));
      ok('stored in the fake and the header tag follows the echo', m.state.project.project_type === '親子');

      await page.selectOption('#pd-type-select', '其他');
      ok('其他 shows the typed box', await shown(page, '#pd-type-other'));
      await page.fill('#pd-type-other', '');
      await page.click('#pd-type-save');
      ok('其他 with an empty box: inline error, nothing sent', (await page.textContent('#pd-type-err')).trim() === '請輸入類別名稱' && patches().length === 1, `${patches().length}`);
      await page.fill('#pd-type-other', '寵物');
      await page.click('#pd-type-save');
      await page.waitForFunction(() => document.getElementById('pd-type-tag')?.textContent.trim() === '寵物', null, { timeout: 4000 });
      ok('typed 寵物 is sent and shown', patches()[1].body.project_type === '寵物', JSON.stringify(patches()[1]?.body));

      await page.click('#pd-back-btn');
      await waitList(page);
      const tag = await page.$eval('[data-project-row="proj-A"] [data-project-type-tag]', e => e.textContent.trim());
      ok('back on the list the row tag is the new category (no reload)', tag === '寵物', tag);

      await page.click('[data-project-row="proj-A"] [data-open-project]');
      await page.waitForSelector('#pd-type-select', { timeout: 5000 });
      ok('reopened: select is 其他 with the typed value in the box', (await page.inputValue('#pd-type-select')) === '其他' && (await page.inputValue('#pd-type-other')) === '寵物');
      await page.selectOption('#pd-type-select', '');
      await page.click('#pd-type-save');
      await page.waitForFunction(() => { const t = document.getElementById('pd-type-tag'); return !t || t.getClientRects().length === 0 || t.textContent.trim() === ''; }, null, { timeout: 4000 });
      ok('未分類 → PATCH { project_type: null } (clears)', patches().length === 3 && patches()[2].body.project_type === null, JSON.stringify(patches()[2]?.body));
      ok('stored cleared', m.state.project.project_type === null);
      await page.click('#pd-back-btn');
      await waitList(page);
      ok('the list row lost its tag', (await page.$('[data-project-row="proj-A"] [data-project-type-tag]')) === null);
      ok('other rows keep theirs (positive control)', (await page.$('[data-project-row="proj-B"] [data-project-type-tag]')) !== null);
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}
}
