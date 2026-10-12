// Browser suites: admin.html 選片專案 list — the two tabs 進行中 / 已完成 above the filters.
// 已完成 = client confirmation is in (客戶已確認 / 已標記完成); 進行中 = everything else (incl. 已交件 waiting
// for the client, and 待修改). The tab lives in the hash (`tab=done`, omitted for the default); a search
// looks at BOTH tabs. Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { ADMIN_PLAIN } from '../lib/auth-mocks.mjs';
import { MOBILE } from '../lib/env.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {
const ADMIN_URL = `${base}/admin.html`;
const iso = '2026-09-01T00:00:00.000Z';
// main = A (picking). Hand-written expectations:
//   進行中: A B C D F G H (7)    已完成: E I (2)    archived (only with the checkbox): J picking, K confirmed
const EXTRA = [
  { id: 'proj-B', title: 'Amy Wedding', phase: 'submitted', owner_name: 'Amy' },
  { id: 'proj-C', title: '親子寫真', phase: 'retouching' },
  { id: 'proj-D', title: 'Delivered Co', phase: 'retouching', delivered_at: iso },
  { id: 'proj-E', title: 'Confirmed Co', phase: 'retouching', delivered_at: iso, client_confirmed_at: iso, client_confirmed_by: 'guest' },
  { id: 'proj-F', title: 'Revising Co', phase: 'retouching', delivered_at: iso, open_revision_count: 2 },
  { id: 'proj-G', title: 'Plain Picking', phase: 'picking', owner_name: 'Bob' },
  { id: 'proj-H', title: 'Another Picking', phase: 'picking' },
  { id: 'proj-I', title: 'Marked Done Co', phase: 'retouching', delivered_at: iso, client_confirmed_at: iso, client_confirmed_by: 'photographer' },
  { id: 'proj-J', title: 'Archived Picking', phase: 'picking', archived_at: iso },
  { id: 'proj-K', title: 'Archived Done Co', phase: 'retouching', delivered_at: iso, client_confirmed_at: iso, client_confirmed_by: 'guest', archived_at: iso },
];
const ACTIVE = ['proj-A', 'proj-B', 'proj-C', 'proj-D', 'proj-F', 'proj-G', 'proj-H'];
const DONE = ['proj-E', 'proj-I'];
const fx = () => pickFakeWorker({ projectId: 'proj-A', title: '王小明 婚紗', phase: 'picking', folders: ['shoot/毛片/'], extraProjects: EXTRA });
const lines = () => { const out = []; return { out, ok: (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`) }; };
const rowIds = page => page.$$eval('[data-project-row]', els => els.map(e => e.dataset.projectRow));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = a => [...a].sort();
const waitRows = (page, n) => page.waitForFunction(k => document.querySelectorAll('[data-project-row]').length === k, n, { timeout: 4000 });
const waitList = page => page.waitForSelector('[data-project-row]', { state: 'visible', timeout: 5000 });
const hash = page => page.evaluate(() => location.hash);
const tabText = (page, t) => page.$eval(`[data-pl-tab="${t}"]`, e => e.textContent.replace(/\s+/g, ' ').trim());
const tabSelected = (page, t) => page.$eval(`[data-pl-tab="${t}"]`, e => e.getAttribute('aria-selected'));
const statusOpts = page => page.$$eval('#pl-status option', o => o.map(x => x.textContent.trim()));
const statusVisible = page => page.$eval('#pl-status', e => getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0);
const countText = page => page.$eval('#pl-count', e => e.textContent.trim());
const listText = page => page.$eval('#proj-recent-list', e => e.textContent.trim());
const clickTab = async (page, t) => { await page.click(`[data-pl-tab="${t}"]`); };

// ── 1. tabs: which projects, counts, default ──
{
  const m = fx();
  await suite('admin 列表分頁 — 預設「進行中」只列未確認的專案；「已完成」只列已確認／已標記完成；頁籤顯示數量',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await waitList(page);
      await waitRows(page, ACTIVE.length);
      ok('default tab is 進行中 (selected)', (await tabSelected(page, 'active')) === 'true' && (await tabSelected(page, 'done')) === 'false');
      ok('進行中 lists A B C D F G H (picking, submitted, retouching, 已交件 waiting, 待修改)', same(await rowIds(page), ACTIVE), JSON.stringify(await rowIds(page)));
      ok('confirmed E and photographer-marked I are NOT in the DOM on 進行中',
        (await page.$('[data-project-row="proj-E"]')) === null && (await page.$('[data-project-row="proj-I"]')) === null);
      ok('待修改 F and 已交件 D stay on 進行中 (positive)', (await page.$('[data-project-row="proj-F"][data-confirm="revising"]')) !== null && (await page.$('[data-project-row="proj-D"][data-delivered="1"]')) !== null);
      ok('tab labels carry counts: 進行中 7 / 已完成 2', (await tabText(page, 'active')) === '進行中 7' && (await tabText(page, 'done')) === '已完成 2', `${await tabText(page, 'active')} | ${await tabText(page, 'done')}`);
      ok('the hash stays empty on the default tab', (await hash(page)) === '', await hash(page));
      ok('status select on 進行中: 全部狀態 / 選片中 / 已送出 / 精修中 / 已交件（待客戶確認） / 待修改',
        same(await statusOpts(page), ['全部狀態', '選片中', '已送出', '精修中', '已交件（待客戶確認）', '待修改']), JSON.stringify(await statusOpts(page)));
      ok('no count line while nothing is filtered (the tab numbers say it)', (await countText(page)) === '', await countText(page));

      await clickTab(page, 'done');
      await waitRows(page, DONE.length);
      ok('已完成 lists exactly E and I', same(await rowIds(page), DONE), JSON.stringify(await rowIds(page)));
      ok('none of the 進行中 projects remain in the DOM', (await page.$$eval('[data-project-row]', els => els.filter(e => !['proj-E', 'proj-I'].includes(e.dataset.projectRow)).length)) === 0);
      ok('badges: E 客戶已確認, I 已標記完成', (await page.$eval('[data-project-row="proj-E"]', r => r.textContent.includes('客戶已確認'))) && (await page.$eval('[data-project-row="proj-I"]', r => r.textContent.includes('已標記完成'))));
      ok('已完成 tab is selected, 進行中 is not', (await tabSelected(page, 'done')) === 'true' && (await tabSelected(page, 'active')) === 'false');
      ok('hash is tab=done', (await hash(page)) === '#tab=done', await hash(page));
      ok('no status choices to make on 已完成: the select is hidden, or holds only 全部已完成',
        !(await statusVisible(page)) || same(await statusOpts(page), ['全部已完成']), JSON.stringify(await statusOpts(page)));
      ok('still no count line on 已完成', (await countText(page)) === '', await countText(page));

      await clickTab(page, 'active');
      await waitRows(page, ACTIVE.length);
      ok('back to 進行中: 7 rows again, hash empty again', same(await rowIds(page), ACTIVE) && (await hash(page)) === '', await hash(page));
      ok('status select is back and visible', await statusVisible(page));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

// ── 2. status select per tab, legacy keys ──
{
  const m = fx();
  await suite('admin 列表分頁 — 進行中的狀態篩選（含「已交件（待客戶確認）」不含已確認、「待修改」）、切換分頁重置狀態',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await waitList(page);
      await waitRows(page, 7);
      const pick = async (v, n) => { await page.selectOption('#pl-status', v); await waitRows(page, n); return rowIds(page); };
      ok('選片中 → A G H', same(await pick('picking', 3), ['proj-A', 'proj-G', 'proj-H']));
      ok('已送出 → B', same(await pick('submitted', 1), ['proj-B']));
      ok('精修中 → C only', same(await pick('retouching', 1), ['proj-C']));
      ok('已交件（待客戶確認） → D only (F is 待修改, E/I are done)', same(await pick('awaiting', 1), ['proj-D']));
      ok('待修改 → F', same(await pick('revising', 1), ['proj-F']));
      ok('hash carries status=revising only (no tab key)', (await hash(page)) === '#status=revising', await hash(page));
      await clickTab(page, 'done');
      await waitRows(page, 2);
      ok('switching tab resets the status to all (2 done rows, hash tab=done only)', same(await rowIds(page), DONE) && (await hash(page)) === '#tab=done', await hash(page));
      await clickTab(page, 'active');
      await waitRows(page, 7);
      ok('and coming back the status is all, not the old 待修改', (await page.inputValue('#pl-status')) === 'all');
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

// ── 3. hash round trip ──
{
  // main project A is itself confirmed here, so a 已完成 row has a detail behind it (list-only extra rows have none)
  const m = pickFakeWorker({ projectId: 'proj-A', title: '王小明 婚紗', phase: 'retouching', deliveredAt: iso, confirmedAt: iso, confirmedBy: 'guest', folders: ['shoot/毛片/'], extraProjects: EXTRA });
  const DONE3 = ['proj-A', ...DONE];
  await suite('admin 列表分頁 — 分頁在網址 hash：重新整理、開啟專案再返回、瀏覽器上一頁都回到同一分頁',
    `${ADMIN_URL}#tab=done`,
    async page => {
      const { out, ok } = lines();
      await waitList(page);
      await waitRows(page, 3);
      ok('opening #tab=done lands on 已完成 with A, E, I', same(await rowIds(page), DONE3) && (await tabSelected(page, 'done')) === 'true', JSON.stringify(await rowIds(page)));
      await page.reload({ waitUntil: 'load' });
      await waitList(page);
      await waitRows(page, 3);
      ok('after reload: still 已完成', same(await rowIds(page), DONE3) && (await tabSelected(page, 'done')) === 'true');
      await page.click('[data-project-row="proj-A"] [data-open-project]');
      await page.waitForSelector('#pd-sec-settings', { timeout: 5000 }).catch(() => null);
      const dh = new URLSearchParams((await hash(page)).slice(1));
      ok('the detail hash keeps tab=done next to project=', dh.get('project') === 'proj-A' && dh.get('tab') === 'done', await hash(page));
      await page.goBack();
      await waitList(page);
      await waitRows(page, 3);
      ok('browser Back returns to the 已完成 list', same(await rowIds(page), DONE3) && (await tabSelected(page, 'done')) === 'true' && (await hash(page)) === '#tab=done', await hash(page));
      // search + tab together round-trip
      await clickTab(page, 'active');
      await waitRows(page, 6);
      await page.fill('#pl-q', 'co');
      await page.waitForFunction(() => location.hash.includes('q=co'), null, { timeout: 2000 });
      const hp = new URLSearchParams((await hash(page)).slice(1));
      ok('active tab + search: hash has q=co and NO tab key', hp.get('q') === 'co' && !hp.has('tab'), await hash(page));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

{
  const m = fx();
  await suite('admin 列表分頁 — 舊連結與不一致的網址：status=confirmed → 已完成；status=delivered → 進行中「已交件（待客戶確認）」；status=picking&tab=done → 全部；tab=bogus → 進行中',
    `${ADMIN_URL}#status=confirmed`,
    async page => {
      const { out, ok } = lines();
      await waitList(page);
      await waitRows(page, 2);
      ok('old status=confirmed link → 已完成 tab, E and I', same(await rowIds(page), DONE) && (await tabSelected(page, 'done')) === 'true', JSON.stringify(await rowIds(page)));
      await page.goto(`${ADMIN_URL}#status=delivered`, { waitUntil: 'load' });
      await waitList(page);
      await waitRows(page, 1);
      ok('old status=delivered link → 進行中 + 已交件（待客戶確認）: D only', same(await rowIds(page), ['proj-D']) && (await tabSelected(page, 'active')) === 'true' && (await page.inputValue('#pl-status')) === 'awaiting', JSON.stringify(await rowIds(page)));
      await page.goto(`${ADMIN_URL}#status=picking&tab=done`, { waitUntil: 'load' });
      await waitList(page);
      await waitRows(page, 2);
      ok('status=picking with tab=done is inconsistent → 已完成 shows all (E, I), no picking rows', same(await rowIds(page), DONE), JSON.stringify(await rowIds(page)));
      await page.goto(`${ADMIN_URL}#tab=bogus`, { waitUntil: 'load' });
      await waitList(page);
      await waitRows(page, 7);
      ok('tab=bogus falls back to 進行中', (await tabSelected(page, 'active')) === 'true' && same(await rowIds(page), ACTIVE));
      await page.goto(`${ADMIN_URL}#status=revising&tab=active`, { waitUntil: 'load' });
      await waitList(page);
      await waitRows(page, 1);
      ok('explicit tab=active + status=revising → F', same(await rowIds(page), ['proj-F']));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

// ── 4. search spans both tabs ──
{
  const m = fx();
  await suite('admin 列表分頁 — 搜尋時兩個分頁一起找：顯示提示、每列保留自己的狀態徽章、計數 x / y；清空後回到原分頁',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await waitList(page);
      await waitRows(page, 7);
      const note = () => page.evaluate(() => { const n = document.querySelector('[data-pl-search-note]'); return n && n.getClientRects().length > 0 ? n.textContent.trim() : null; });
      ok('no note when the search box is empty', (await note()) === null);
      await page.fill('#pl-q', 'co');
      // matches: Delivered Co (D, active), Confirmed Co (E, done), Revising Co (F, active), Marked Done Co (I, done)
      await waitRows(page, 4);
      ok('"co" finds rows from BOTH tabs: D E F I', same(sorted(await rowIds(page)), ['proj-D', 'proj-E', 'proj-F', 'proj-I']), JSON.stringify(await rowIds(page)));
      ok('note 搜尋中：兩個分頁一起找 is shown', (await note()) === '搜尋中：兩個分頁一起找', String(await note()));
      ok('each result keeps its own badge: E 客戶已確認, F 待修改, D 已交件', (await page.$eval('[data-project-row="proj-E"]', r => r.querySelector('[data-confirm-badge="confirmed"]') !== null))
        && (await page.$eval('[data-project-row="proj-F"]', r => r.querySelector('[data-confirm-badge="revising"]') !== null))
        && (await page.$eval('[data-project-row="proj-D"]', r => r.querySelector('[data-delivered-badge]') !== null)));
      ok('count line 顯示 4 / 9', (await countText(page)) === '顯示 4 / 9 個專案', await countText(page));
      await page.fill('#pl-q', '');
      await waitRows(page, 7);
      await page.selectOption('#pl-status', 'picking');
      await waitRows(page, 3);
      ok('count line with a status filter: 顯示 3 / 9', (await countText(page)) === '顯示 3 / 9 個專案', await countText(page));
      await page.fill('#pl-q', 'co');
      await waitRows(page, 4);
      ok('a search ignores the status choice: with 選片中 selected, "co" still finds D E F I', same(sorted(await rowIds(page)), ['proj-D', 'proj-E', 'proj-F', 'proj-I']), JSON.stringify(await rowIds(page)));
      await page.fill('#pl-q', '');
      await waitRows(page, 3);
      ok('clearing the search brings the 選片中 filter back (A G H)', same(await rowIds(page), ['proj-A', 'proj-G', 'proj-H']));
      await page.selectOption('#pl-status', 'all');
      await waitRows(page, 7);
      await page.fill('#pl-q', 'archived');
      await waitRows(page, 0);
      ok('archived projects are still hidden from a search (no checkbox) → 沒有符合的專案', (await listText(page)) === '沒有符合的專案', await listText(page));
      await page.fill('#pl-q', 'confirmed');
      await waitRows(page, 1);
      ok('a done project is found from the 進行中 tab ("confirmed" → E)', same(await rowIds(page), ['proj-E']));
      await page.fill('#pl-q', '');
      await waitRows(page, 7);
      ok('clearing the search returns to the 進行中 list and removes the note', same(await rowIds(page), ACTIVE) && (await note()) === null);
      // from the 已完成 tab, a search finds active ones too and clearing returns to 已完成
      await clickTab(page, 'done');
      await waitRows(page, 2);
      await page.fill('#pl-q', 'amy');
      await waitRows(page, 1);
      ok('searching while on 已完成 finds B (active)', same(await rowIds(page), ['proj-B']));
      await page.fill('#pl-q', '');
      await waitRows(page, 2);
      ok('clearing returns to 已完成', same(await rowIds(page), DONE) && (await tabSelected(page, 'done')) === 'true');
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

// ── 5. sort, archived, empty tabs ──
{
  const m = fx();
  await suite('admin 列表分頁 — 待我處理排序與「顯示已封存」都在目前分頁內運作',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await waitList(page);
      await waitRows(page, 7);
      await page.selectOption('#pl-sort', 'me');
      await page.waitForFunction(() => document.querySelector('[data-project-row]').dataset.projectRow === 'proj-B', null, { timeout: 3000 });
      ok('待我處理 inside 進行中: B, F first then the rest in order', same(await rowIds(page), ['proj-B', 'proj-F', 'proj-A', 'proj-C', 'proj-D', 'proj-G', 'proj-H']), JSON.stringify(await rowIds(page)));
      await page.check('#proj-show-archived-toggle');
      await waitRows(page, 1);
      ok('顯示已封存 on 進行中 → the archived NON-confirmed project J only', same(await rowIds(page), ['proj-J']), JSON.stringify(await rowIds(page)));
      ok('tab counts follow the loaded (archived) set: 進行中 1 / 已完成 1', (await tabText(page, 'active')) === '進行中 1' && (await tabText(page, 'done')) === '已完成 1', `${await tabText(page, 'active')} | ${await tabText(page, 'done')}`);
      await clickTab(page, 'done');
      await waitRows(page, 1);
      ok('and on 已完成 → archived confirmed K only', same(await rowIds(page), ['proj-K']), JSON.stringify(await rowIds(page)));
      await page.uncheck('#proj-show-archived-toggle');
      await waitRows(page, 2);
      ok('unchecking brings back E and I on 已完成', same(await rowIds(page), DONE));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

{
  // only active projects exist → 已完成 is empty; and only done projects → 進行中 is empty
  const m = pickFakeWorker({ projectId: 'proj-A', title: 'Solo', phase: 'picking', folders: ['shoot/毛片/'], extraProjects: [] });
  await suite('admin 列表分頁 — 空分頁訊息：「沒有已完成的專案」；篩選造成的空結果仍是「沒有符合的專案」',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await waitList(page);
      await waitRows(page, 1);
      ok('baseline: one active row (positive control)', same(await rowIds(page), ['proj-A']) && (await tabText(page, 'done')) === '已完成 0', await tabText(page, 'done'));
      await clickTab(page, 'done');
      await waitRows(page, 0);
      ok('empty 已完成 → 沒有已完成的專案', (await listText(page)) === '沒有已完成的專案', await listText(page));
      await clickTab(page, 'active');
      await waitRows(page, 1);
      await page.selectOption('#pl-status', 'submitted');
      await waitRows(page, 0);
      ok('a status filter with no hit → 沒有符合的專案 (not the tab message)', (await listText(page)) === '沒有符合的專案', await listText(page));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-A', title: 'Done Solo', phase: 'retouching', deliveredAt: iso, confirmedAt: iso, confirmedBy: 'guest', folders: ['shoot/毛片/'], extraProjects: [] });
  await suite('admin 列表分頁 — 只有已確認專案時，進行中顯示「沒有進行中的專案」',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await page.waitForFunction(() => document.querySelectorAll('[data-pl-tab]').length === 2, null, { timeout: 5000 });
      await page.waitForFunction(() => /已完成 1/.test(document.querySelector('[data-pl-tab="done"]').textContent), null, { timeout: 5000 });
      ok('fixture is a confirmed project (tab count 已完成 1, positive control)', (await tabText(page, 'done')) === '已完成 1', await tabText(page, 'done'));
      ok('進行中 → 沒有進行中的專案, zero rows', (await listText(page)) === '沒有進行中的專案' && (await page.$$('[data-project-row]')).length === 0, await listText(page));
      await clickTab(page, 'done');
      await waitRows(page, 1);
      ok('已完成 shows the project', same(await rowIds(page), ['proj-A']));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

// ── 6. phone ──
{
  const m = fx();
  await suite('admin 列表分頁 — 手機 390px：兩個頁籤同一行、觸控高度 ≥ 40px、不橫向捲動',
    ADMIN_URL,
    async page => {
      const { out, ok } = lines();
      await waitList(page);
      await waitRows(page, 7);
      const r = await page.evaluate(() => {
        const a = document.querySelector('[data-pl-tab="active"]').getBoundingClientRect();
        const d = document.querySelector('[data-pl-tab="done"]').getBoundingClientRect();
        const de = document.documentElement;
        return { a: { t: a.top, h: a.height, l: a.left, r: a.right }, d: { t: d.top, h: d.height, l: d.left, r: d.right }, over: de.scrollWidth - de.clientWidth, vw: innerWidth };
      });
      ok('both tabs have a real box (floor)', r.a.h > 0 && r.d.h > 0);
      ok('same row (equal top)', Math.abs(r.a.t - r.d.t) < 2, JSON.stringify(r));
      ok('each is >= 40px tall', r.a.h >= 40 && r.d.h >= 40, `${r.a.h} ${r.d.h}`);
      ok('both inside the 390px viewport', r.a.l >= 0 && r.d.r <= r.vw, JSON.stringify(r));
      ok('no horizontal page scroll', r.over <= 0, `${r.over}`);
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: MOBILE });
}
}
