// Browser suites: admin project detail collapsible sections, orders list page, dashboard revenue
// cards.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { ADMIN_PLAIN } from '../lib/auth-mocks.mjs';
import { SEED_TOKEN, dashSettingsMock } from '../lib/dashboard-mocks.mjs';
import { ADMIN_BUCKET, ADM_REVS } from '../lib/delivery-helpers.mjs';
import { SEC_NAMES, ordersFake, secInfo, secOpen, secWait, waitText } from '../lib/orders-fake.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {
const SEC_TITLES = { delivery: '交件', settings: '設定', selections: '目前選取', orders: '訂單', submissions: '送出紀錄', people: '挑選人與連結' };
const secShut = i => i && i.expanded === 'false' && i.display === 'none' && i.caret === '▸';
const secFixture = (o = {}) => pickFakeWorker({ projectId: 'proj-sec', title: '收合專案', folders: ['shoot/毛片/'], bucketFolders: ADMIN_BUCKET, ...o });
const SEC_AT = '2026-01-01T00:00:00Z';
const secSub = (id, at, keys) => ({ id, picker_id: 'picker-0', relationship: '本人', email: null, photo_keys: keys, count: keys.length, pick_limit: null, extra_price: null, created_at: at });

// ── 1. titles, one-line summaries and the default open/closed state, per project state ──
for (const [label, build, want] of [
  ['選片中、什麼都還沒有', () => secFixture({ phase: 'picking' }), {
    delivery: { off: true }, settings: { sum: '不限張數 · 毛片下載：關', open: false }, selections: { sum: '0 張', open: false },
    orders: { sum: '尚無訂單', open: false }, submissions: { sum: '尚無送出', open: false }, people: { sum: '尚無人認領 · 連結有效 1 條', open: false } }],
  ['精修中、尚未交件', () => secFixture({ phase: 'retouching', pickLimit: 30, extraMax: 10, extraPrice: 500, allowProofDownload: true }), {
    delivery: { sum: '尚未交件', open: true }, settings: { sum: '30 張 + 加選 10 · 加選 NT$500 · 毛片下載：開', open: false } }],
  ['已交件、客戶尚未確認', () => secFixture({ phase: 'retouching', deliveredAt: '2026-09-20T00:00:00.000Z', finalFolders: ['shoot/精修/'] }), {
    delivery: { sum: '已交件 9/20 · 精修/ · 客戶尚未確認', open: true } }],
  ['已交件、兩個精修資料夾', () => secFixture({ phase: 'retouching', deliveredAt: '2026-09-20T00:00:00.000Z', finalFolders: ['shoot/精修/', 'shoot/精修二/'] }), {
    delivery: { sum: '已交件 9/20 · 精修/ 等 2 個 · 客戶尚未確認', open: true } }],
  ['已交件、客戶已確認', () => secFixture({ phase: 'retouching', deliveredAt: '2026-09-20T00:00:00.000Z', finalFolders: ['shoot/精修/'], confirmedAt: '2026-09-23T03:30:00.000Z', confirmedBy: 'guest' }), {
    delivery: { sum: '已交件 9/20 · 精修/ · 客戶已確認', open: true } }],
  ['已交件、攝影師標記完成', () => secFixture({ phase: 'retouching', deliveredAt: '2026-09-20T00:00:00.000Z', finalFolders: ['shoot/精修/'], confirmedAt: '2026-09-23T03:30:00.000Z', confirmedBy: 'photographer' }), {
    delivery: { sum: '已交件 9/20 · 精修/ · 已標記完成', open: true } }],
  ['已交件、客戶要求修改（2 則未處理、1 則已處理）', () => secFixture({ phase: 'retouching', deliveredAt: '2026-09-20T00:00:00.000Z', finalFolders: ['shoot/精修/'], ownerName: 'Zoe', revisions: ADM_REVS() }), {
    delivery: { sum: '已交件 9/20 · 精修/ · 待修改 2', open: true }, people: { sum: 'Zoe · 連結有效 1 條', open: false } }],
]) {
  const m = build();
  await suite(`區塊收合 — 摘要與預設：${label}`,
    `${base}/admin.html#project=proj-sec`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await secWait(page);
      const info = await secInfo(page);
      ok('all six sections exist, each with a title row', SEC_NAMES.every(n => info[n]), JSON.stringify(info));
      for (const n of SEC_NAMES) {
        const w = want[n] || {}, i = info[n];
        if (!i) continue;
        ok(`${SEC_TITLES[n]}: the title is ${SEC_TITLES[n]}, a <button type=button> wired to its body`,
          i.title === SEC_TITLES[n] && i.tag === 'BUTTON' && i.type === 'button' && i.controls === i.bodyId, JSON.stringify(i));
        if (w.off) { ok(`${SEC_TITLES[n]}: not shown at all (display:none) when there is nothing to deliver yet`, i.secDisplay === 'none', JSON.stringify(i)); continue; }
        ok(`${SEC_TITLES[n]}: the section is shown`, i.secDisplay !== 'none', JSON.stringify(i));
        if (w.sum !== undefined) ok(`${SEC_TITLES[n]}: summary "${w.sum}"`, i.sum === w.sum, JSON.stringify(i.sum));
        if (w.open !== undefined) ok(`${SEC_TITLES[n]}: starts ${w.open ? 'open' : 'closed'} (aria-expanded, ${w.open ? '▾' : '▸'}, body display ${w.open ? 'shown' : 'none'})`,
          w.open ? secOpen(i) : secShut(i), JSON.stringify(i));
      }
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

{
  // submitted: 目前選取 starts open, the 送出紀錄 summary counts and dates the latest
  const m = secFixture({ phase: 'submitted', ownerName: 'Grace' });
  m.state.selections.set('20260819/p0.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: SEC_AT });
  m.state.selections.set('20260819/p1.jpg', { rating: 1, note: '', updated_by: 'picker-0', updated_at: SEC_AT });
  m.state.selections.set('20260819/p2.jpg', { rating: 0, note: '', updated_by: 'picker-0', updated_at: SEC_AT });
  m.state.submissions.push(secSub('s1', '2026-01-01T00:00:00Z', ['20260819/p0.jpg']), secSub('s2', '2026-01-02T00:00:00Z', ['20260819/p0.jpg', '20260819/p1.jpg']));
  m.state.tokens.push({ token: 'OLD', created_at: SEC_AT, expires_at: '2027-01-01T00:00:00.000Z', revoked_at: SEC_AT });
  await suite('區塊收合 — 已送出：目前選取預設展開（只算 ♥ 的張數）；送出紀錄摘要「2 次，最近 1/2」；已撤銷的連結不算有效',
    `${base}/admin.html#project=proj-sec`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await secWait(page);
      const i = await secInfo(page);
      ok('目前選取: 2 張 (the rating-0 row is not counted), open', i.selections.sum === '2 張' && secOpen(i.selections), JSON.stringify(i.selections));
      ok('送出紀錄: 2 次，最近 1/2, closed', i.submissions.sum === '2 次，最近 1/2' && secShut(i.submissions), JSON.stringify(i.submissions));
      ok('挑選人與連結: Grace · 連結有效 1 條 (the revoked one is not counted), closed', i.people.sum === 'Grace · 連結有效 1 條' && secShut(i.people), JSON.stringify(i.people));
      ok('the 看照片 link is on the title row, so it works while the section is closed',
        await page.$eval('#pd-sec-selections .pd-sec-head a.pd-link', a => /index\.html\?project=proj-sec/.test(a.getAttribute('href')) && a.getBoundingClientRect().width > 20));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

// ── 2. 訂單: the summary, and open only when something is waiting ──
{
  const m = secFixture({ phase: 'picking' });
  const o = ordersFake({});
  o.st.addOrder({ id: 'o-req', project_id: 'proj-sec', status: 'requested', items: [{ name: '相本書', kind: 'album', unit_price: 3000, unit_cost: 0, qty: 1 }] });
  o.st.addOrder({ id: 'o-unpaid', project_id: 'proj-sec', status: 'confirmed', items: [{ name: '無框畫', kind: 'print', unit_price: 1200, unit_cost: 0, qty: 1 }] });
  o.st.addOrder({ id: 'o-part', project_id: 'proj-sec', status: 'confirmed', paid_amount: 500, paid_method: 'cash', items: [{ name: '輸出', kind: 'print', unit_price: 1500, unit_cost: 0, qty: 1 }] });
  o.st.addOrder({ id: 'o-paid', project_id: 'proj-sec', status: 'fulfilled', paid_amount: 800, paid_method: 'cash', items: [{ name: '急件', kind: 'service', unit_price: 800, unit_cost: 0, qty: 1 }] });
  o.st.addOrder({ id: 'o-gone', project_id: 'proj-sec', status: 'cancelled', items: [{ name: '取消的', kind: 'service', unit_price: 999, unit_cost: 0, qty: 1 }] });
  await suite('區塊收合 — 訂單：有待確認／未收款就預設展開；摘要「4 筆 · 待確認 1 · 未收 NT$2,200（另有 1 筆已取消）」',
    `${base}/admin.html#project=proj-sec`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await secWait(page);
      await page.waitForSelector('#pd-orders .ord-card', { state: 'attached', timeout: 5000 });
      await page.waitForFunction(() => document.getElementById('pd-sec-orders-btn').getAttribute('aria-expanded') === 'true', null, { timeout: 3000 }).catch(() => {});
      const i = (await secInfo(page)).orders;
      ok('open once the orders have loaded (there is a request and unpaid money)', secOpen(i), JSON.stringify(i));
      ok('summary counts the live orders, the requested one, what is owed (1,200 + 1,000 = 2,200) and the cancelled one',
        i.sum === '4 筆 · 待確認 1 · 未收 NT$2,200（另有 1 筆已取消）', JSON.stringify(i.sum));
      ok('the order cards are really on screen (positive)', await page.$eval('#pd-orders .ord-card', e => e.getBoundingClientRect().height > 40));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN_PLAIN });
}

{
  const m = secFixture({ phase: 'picking' });
  const o = ordersFake({});
  o.st.addOrder({ id: 'o-paid', project_id: 'proj-sec', status: 'fulfilled', paid_amount: 800, paid_method: 'cash', items: [{ name: '急件', kind: 'service', unit_price: 800, unit_cost: 0, qty: 1 }] });
  o.st.addOrder({ id: 'o-paid2', project_id: 'proj-sec', status: 'confirmed', paid_amount: 100, paid_method: 'cash', items: [{ name: '小物', kind: 'service', unit_price: 100, unit_cost: 0, qty: 2 }, { name: '別的', kind: 'service', unit_price: 100, unit_cost: 0, qty: 1 }], discount: 200 });
  await suite('區塊收合 — 訂單：全部收齊、沒有待確認就維持收合；摘要「2 筆 · 已收齊」',
    `${base}/admin.html#project=proj-sec`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await secWait(page);
      await page.waitForSelector('#pd-orders .ord-card', { state: 'attached', timeout: 5000 });
      await page.waitForTimeout(300);
      const i = (await secInfo(page)).orders;
      ok('closed', secShut(i), JSON.stringify(i));
      ok('summary 2 筆 · 已收齊', i.sum === '2 筆 · 已收齊', JSON.stringify(i.sum));
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN_PLAIN });
}

{
  // 訂單 opened by itself: the first click on its title row must close it (and the redraw must not flicker it shut)
  const m = secFixture({ phase: 'picking' });
  const o = ordersFake({});
  o.st.addOrder({ id: 'o-req', project_id: 'proj-sec', status: 'requested', items: [{ name: '相本書', kind: 'album', unit_price: 3000, unit_cost: 0, qty: 1 }] });
  await suite('區塊收合 — 訂單自動展開後：第一下點標題列就收合、再點又展開；封存等動作重畫後不會先收再開',
    `${base}/admin.html#project=proj-sec`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await secWait(page);
      await page.waitForFunction(() => document.getElementById('pd-sec-orders-btn').getAttribute('aria-expanded') === 'true', null, { timeout: 5000 });
      await page.click('#pd-sec-orders-btn');
      ok('one click closes the auto-opened 訂單', secShut((await secInfo(page)).orders), JSON.stringify((await secInfo(page)).orders));
      await page.click('#pd-sec-orders-btn');
      ok('the next click opens it again', secOpen((await secInfo(page)).orders));
      ok('a click is a choice: stored as 1', await page.evaluate(() => localStorage.getItem('pd_sec_orders')) === '1');
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN_PLAIN });
}

{
  // redraw: the auto-opened 訂單 is drawn open at once (no closed → open flicker)
  const m = secFixture({ phase: 'picking' });
  const o = ordersFake({});
  o.st.addOrder({ id: 'o-req', project_id: 'proj-sec', status: 'requested', items: [{ name: '相本書', kind: 'album', unit_price: 3000, unit_cost: 0, qty: 1 }] });
  await suite('區塊收合 — 訂單自動展開後頁面重畫（開始精修）：一畫出來就是展開的',
    `${base}/admin.html#project=proj-sec`,
    async page => {
      await secWait(page);
      await page.waitForFunction(() => document.getElementById('pd-sec-orders-btn').getAttribute('aria-expanded') === 'true', null, { timeout: 5000 });
      await page.evaluate(() => { window.__seen = []; new MutationObserver(() => { const b = document.getElementById('pd-sec-orders-btn'); if (b) window.__seen.push(b.getAttribute('aria-expanded')); })
        .observe(document.getElementById('project-detail-body'), { childList: true, subtree: true, attributes: true }); });
      m.state.project.phase = 'submitted';
      await page.click('#pd-start-retouch-btn');
      await page.waitForFunction(() => document.querySelector('.pd-head .badge')?.textContent === '精修中', null, { timeout: 5000 });
      await page.waitForTimeout(500);
      const seen = await page.evaluate(() => window.__seen);
      return [seen.length > 0 ? 'ok    the detail was redrawn (positive)' : 'FAIL  no redraw seen',
        seen.every(v => v === 'true') ? 'ok    the 訂單 button was never drawn closed' : `FAIL  ${JSON.stringify(seen)}`];
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN_PLAIN });
}

{
  const m = secFixture({ phase: 'picking' });
  const o = ordersFake({});
  o.st.addOrder({ id: 'o-unpaid', project_id: 'proj-sec', status: 'confirmed', items: [{ name: '無框畫', kind: 'print', unit_price: 1200, unit_cost: 0, qty: 1 }] });
  await suite('區塊收合 — 訂單：只有一筆已確認但未收款的訂單（沒有待確認）也預設展開；摘要「1 筆 · 未收 NT$1,200」',
    `${base}/admin.html#project=proj-sec`,
    async page => {
      await secWait(page);
      await page.waitForSelector('#pd-orders .ord-card', { state: 'attached', timeout: 5000 });
      await page.waitForFunction(() => document.getElementById('pd-sec-orders-btn').getAttribute('aria-expanded') === 'true', null, { timeout: 3000 }).catch(() => {});
      const i = (await secInfo(page)).orders;
      return [secOpen(i) ? 'ok    open' : `FAIL  ${JSON.stringify(i)}`, i.sum === '1 筆 · 未收 NT$1,200' ? 'ok    summary' : `FAIL  ${JSON.stringify(i.sum)}`];
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN_PLAIN });
}

{
  const m = secFixture({ phase: 'picking' });
  const o = ordersFake({});
  o.st.addOrder({ id: 'o-gone', project_id: 'proj-sec', status: 'cancelled', items: [{ name: '取消的', kind: 'service', unit_price: 999, unit_cost: 0, qty: 1 }] });
  await suite('區塊收合 — 訂單：只有已取消的訂單 → 收合，摘要「尚無有效訂單（1 筆已取消）」',
    `${base}/admin.html#project=proj-sec`,
    async page => {
      await secWait(page);
      await page.waitForSelector('#pd-orders .ord-card', { state: 'attached', timeout: 5000 });
      await page.waitForTimeout(300);
      const i = (await secInfo(page)).orders;
      return [secShut(i) ? 'ok    closed' : `FAIL  ${JSON.stringify(i)}`, i.sum === '尚無有效訂單（1 筆已取消）' ? 'ok    summary' : `FAIL  ${JSON.stringify(i.sum)}`];
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: ADMIN_PLAIN });
}

// ── 3. click, keyboard, computed display (not just the hidden attribute) ──
{
  const m = secFixture({ phase: 'picking', pickLimit: 30, extraMax: 10 });
  await suite('區塊收合 — 點標題列展開／收合：aria-expanded、▾/▸、body 的 computed display；內容仍在 DOM（id 都保留）；鍵盤也能操作',
    `${base}/admin.html#project=proj-sec`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await secWait(page);
      ok('設定 starts closed: the plan input is in the DOM but not displayed (computed display on the container, no hidden attribute)',
        await page.evaluate(() => { const b = document.getElementById('pd-sec-settings-body'), i = document.getElementById('pd-plan-limit');
          return getComputedStyle(b).display === 'none' && !b.hasAttribute('hidden') && !!i && i.getClientRects().length === 0; }));
      ok('all the ids inside survive: #pd-proofdl, #pd-plan, #pd-allow-proof-dl, #pd-plan-save', await page.evaluate(() => ['pd-proofdl', 'pd-plan', 'pd-allow-proof-dl', 'pd-plan-save'].every(id => !!document.getElementById(id))));
      await page.click('#pd-sec-settings-btn');
      let i = (await secInfo(page)).settings;
      ok('a click opens it: expanded, ▾, body shown', secOpen(i), JSON.stringify(i));
      ok('and the plan form is on screen with its values (positive: inputs have a size, the 30 is there)',
        await page.evaluate(() => { const l = document.getElementById('pd-plan-limit'); return l.getClientRects().length > 0 && l.value === '30'; }));
      await page.click('#pd-sec-settings-btn');
      i = (await secInfo(page)).settings;
      ok('a second click closes it again: not expanded, ▸, body display none, inputs have no box', secShut(i) &&
        await page.evaluate(() => document.getElementById('pd-plan-limit').getClientRects().length === 0), JSON.stringify(i));
      // keyboard: focus the button, Enter then Space
      await page.focus('#pd-sec-settings-btn');
      await page.keyboard.press('Enter');
      ok('Enter on the focused title row opens it', secOpen((await secInfo(page)).settings));
      await page.keyboard.press('Space');
      ok('Space closes it', secShut((await secInfo(page)).settings));
      ok('the title row shows a focus outline for keyboard users', await page.evaluate(() => { const b = document.getElementById('pd-sec-settings-btn'); b.focus(); return getComputedStyle(b).outlineStyle !== 'none' || getComputedStyle(b).boxShadow !== 'none'; }));
      // the other sections are not touched by it
      const rest = await secInfo(page);
      ok('the other sections kept their state', secShut(rest.selections) && secShut(rest.submissions) && secShut(rest.people), JSON.stringify(rest));
      // the top is not collapsible: its buttons are visible and not inside a section
      ok('the top (title, badges, owner, action buttons) is not a section: visible, and not inside .pd-sec', await page.evaluate(() => {
        const ids = ['pd-reset-seat-btn', 'pd-start-retouch-btn', 'pd-download-csv-btn'];
        return ids.every(id => { const e = document.getElementById(id); return e && e.getClientRects().length > 0 && !e.closest('.pd-sec'); }) && !!document.querySelector('.pd-head') && !document.querySelector('.pd-head').closest('.pd-sec'); }));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

{
  // the existing interactions still work once the section is opened: 允許下載 switch + the summary follows; 編輯方案 saves
  const m = secFixture({ phase: 'picking', pickLimit: 30, extraMax: 10, extraPrice: 500 });
  await suite('區塊收合 — 展開後既有互動照常：毛片下載開關（摘要跟著變）、編輯方案儲存',
    `${base}/admin.html#project=proj-sec`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await secWait(page);
      ok('before: 毛片下載：關', (await secInfo(page)).settings.sum === '30 張 + 加選 10 · 加選 NT$500 · 毛片下載：關', (await secInfo(page)).settings.sum);
      await page.click('#pd-sec-settings-btn');
      await page.check('#pd-allow-proof-dl');
      await page.waitForFunction(() => /毛片下載：開/.test(document.getElementById('pd-sec-settings-sum').textContent), null, { timeout: 3000 });
      ok('the switch PATCHed and the summary now says 毛片下載：開', m.requests.some(r => r.method === 'PATCH' && r.body && r.body.allow_proof_download === true));
      await page.fill('#pd-plan-limit', '35');
      await page.click('#pd-plan-save');
      await page.waitForFunction(() => /35 張/.test(document.getElementById('pd-sec-settings-sum').textContent), null, { timeout: 4000 });
      const patches = m.requests.filter(r => r.method === 'PATCH').map(r => r.body);
      ok('the plan PATCH carried only pick_limit, and the summary says 35 張', JSON.stringify(patches[patches.length - 1]) === '{"pick_limit":35}', JSON.stringify(patches));
      ok('the section is still open after the page re-read the project', secOpen((await secInfo(page)).settings));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

// ── 4. localStorage: remembered, per section name (not per project), and every access guarded ──
{
  const m = secFixture({ phase: 'picking' });
  await suite('區塊收合 — localStorage：展開狀態記住（重新整理後還在）、key 只看區塊名稱不看專案、其他區塊不受影響',
    `${base}/admin.html#project=proj-sec`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await secWait(page);
      await page.click('#pd-sec-settings-btn');
      await page.click('#pd-sec-people-btn');
      await page.click('#pd-sec-people-btn');
      const keys = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('pd_sec_')).map(k => [k, localStorage.getItem(k)])));
      ok('opened 設定 is stored as 1, a section opened then closed as 0, untouched ones are not written', keys.pd_sec_settings === '1' && keys.pd_sec_people === '0' && !('pd_sec_submissions' in keys), JSON.stringify(keys));
      ok('the keys carry the section name only — no project id', Object.keys(keys).every(k => !/proj/.test(k)), JSON.stringify(keys));
      await page.reload({ waitUntil: 'load' });
      await secWait(page);
      const i = await secInfo(page);
      ok('after a reload: 設定 is still open, 挑選人與連結 still closed, the rest at their defaults', secOpen(i.settings) && secShut(i.people) && secShut(i.submissions) && secShut(i.selections), JSON.stringify(i));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

for (const [label, seed, check] of [
  ['stored 0 beats the default-open 交件', { delivery: '0' }, i => secShut(i.delivery)],
  ['stored 1 opens a default-closed section', { submissions: '1', people: '1' }, i => secOpen(i.submissions) && secOpen(i.people) && secShut(i.settings)],
  ['a garbage value falls back to the default', { settings: 'maybe', delivery: '' }, i => secShut(i.settings) && secOpen(i.delivery)],
]) {
  const m = secFixture({ phase: 'retouching' });
  await suite(`區塊收合 — 已存的偏好 vs 預設：${label}`,
    `${base}/admin.html#project=proj-sec`,
    async page => {
      await secWait(page);
      const i = await secInfo(page);
      return [check(i) ? 'ok    as expected' : `FAIL  ${JSON.stringify(i)}`];
    },
    { before: m.attach, initScript: new Function(`sessionStorage.setItem('studio_token', 'adm'); try { const s = ${JSON.stringify(seed)}; for (const k in s) localStorage.setItem('pd_sec_' + k, s[k]); } catch (e) {}`) });
}

{
  // a stored "closed" for 訂單 is respected when pending orders load later
  const m = secFixture({ phase: 'picking' });
  const o = ordersFake({});
  o.st.addOrder({ id: 'o-req', project_id: 'proj-sec', status: 'requested', items: [{ name: '相本書', kind: 'album', unit_price: 3000, unit_cost: 0, qty: 1 }] });
  await suite('區塊收合 — 訂單：你收合過就不會因為有待確認訂單又自己展開',
    `${base}/admin.html#project=proj-sec`,
    async page => {
      await secWait(page);
      await page.waitForSelector('#pd-orders .ord-card', { state: 'attached', timeout: 5000 });
      await page.waitForTimeout(400);
      const i = (await secInfo(page)).orders;
      return [secShut(i) ? 'ok    stays closed' : `FAIL  ${JSON.stringify(i)}`, /待確認 1/.test(i.sum) ? 'ok    (positive: the order was loaded, the summary knows it)' : `FAIL  ${JSON.stringify(i.sum)}`];
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: () => { sessionStorage.setItem('studio_token', 'adm'); try { localStorage.setItem('pd_sec_orders', '0'); } catch (e) { /* none */ } } });
}

{
  // localStorage throws on every access (private window, blocked site data): defaults, and clicks still work
  const m = secFixture({ phase: 'submitted' });
  m.state.submissions.push(secSub('s1', SEC_AT, ['20260819/p0.jpg']));
  await suite('區塊收合 — localStorage 不可用（存取就丟例外）：頁面照常顯示預設、點標題列照常收合展開、重畫後維持你剛剛的選擇',
    `${base}/admin.html#project=proj-sec`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await secWait(page);
      ok('localStorage really throws here (the fixture is not a no-op)', await page.evaluate(() => { try { localStorage.getItem('x'); return false; } catch (e) { return true; } }));
      let i = await secInfo(page);
      ok('the defaults: 交件 closed (submitted, not retouching → no block), 目前選取 open, 設定 closed', i.delivery.secDisplay === 'none' && secOpen(i.selections) && secShut(i.settings), JSON.stringify(i));
      await page.click('#pd-sec-settings-btn');
      await page.click('#pd-sec-selections-btn');
      i = await secInfo(page);
      ok('clicking still toggles: 設定 open, 目前選取 closed', secOpen(i.settings) && secShut(i.selections), JSON.stringify(i));
      await page.click('#pd-start-retouch-btn');   // the page re-reads and redraws the whole detail
      await page.waitForFunction(() => document.querySelector('.pd-head .badge')?.textContent === '精修中', null, { timeout: 5000 });
      i = await secInfo(page);
      ok('after the redraw your choice is kept (kept in memory, since nothing can be stored)', secOpen(i.settings) && secShut(i.selections), JSON.stringify(i));
      ok('and the page threw nothing (the suite reports page errors)', true);
      return out;
    },
    { before: m.attach, initScript: () => { sessionStorage.setItem('studio_token', 'adm'); Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage blocked'); } }); } });
}

// ── 5. layout, 390 and 1280: nothing sticks out, no leftover blank space, screenshots ──
for (const [tag, ctx] of [['390', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }], ['1280', { viewport: { width: 1280, height: 900 } }]]) {
  const m = secFixture({ phase: 'retouching', ownerName: 'Grace', pickLimit: 30, extraMax: 10, extraPrice: 500, allowProofDownload: true,
    deliveredAt: '2026-09-20T00:00:00.000Z', finalFolders: ['shoot/精修/'], revisions: ADM_REVS() });
  m.state.submissions.push(secSub('s1', '2026-01-01T00:00:00Z', ['20260819/p0.jpg']), secSub('s2', '2026-01-02T00:00:00Z', ['20260819/p0.jpg', '20260819/p1.jpg']));
  m.state.selections.set('20260819/p0.jpg', { rating: 5, note: '', updated_by: 'picker-0', updated_at: SEC_AT });
  await suite(`區塊收合 — 版面 [${tag}]：標題列與摘要不超出畫面、收合後沒有一大段空白、展開前後的截圖`,
    `${base}/admin.html#project=proj-sec`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await secWait(page);
      await page.waitForSelector('#pd-revisions .pd-rev', { state: 'attached', timeout: 5000 });
      const geo = () => page.evaluate(names => { const iw = innerWidth;
        const rows = names.map(n => { const r = document.getElementById(`pd-sec-${n}-btn`).getBoundingClientRect(), s = document.getElementById(`pd-sec-${n}-sum`).getBoundingClientRect();
          return { n, left: r.left, right: r.right, h: r.height, w: r.width, sumRight: s.right, sumH: s.height, top: r.top, bottom: r.bottom }; });
        const panel = document.getElementById('project-detail-panel').getBoundingClientRect(), last = document.getElementById('pd-sec-people').getBoundingClientRect();
        return { iw, sw: document.documentElement.scrollWidth, rows, panelBottom: panel.bottom, lastBottom: last.bottom, panelH: panel.height }; }, SEC_NAMES);
      let g = await geo();
      ok('no horizontal scroll', g.sw <= g.iw, JSON.stringify([g.sw, g.iw]));
      ok('every title row and its summary is inside the screen and tall enough to tap (≥ 36px)', g.rows.every(r => r.left >= 0 && r.right <= g.iw && r.sumRight <= g.iw + 1 && r.h >= 36), JSON.stringify(g.rows));
      // (after 目前選取 the 看照片 link may wrap onto a second row on a phone: allow that row)
      ok('collapsed rows sit close together (≤ 16px between two title rows; ≤ 40px after 目前選取, which carries a link row)',
        g.rows.slice(1).every((r, k) => (g.rows[k].n === 'delivery' ? true : r.top - g.rows[k].bottom <= (g.rows[k].n === 'selections' ? 40 : 16))), JSON.stringify(g.rows.map(r => [r.n, Math.round(r.top), Math.round(r.bottom)])));
      ok('no big blank under the last section (≤ 40px to the card’s bottom edge)', g.panelBottom - g.lastBottom <= 40, JSON.stringify([g.panelBottom, g.lastBottom]));
      const shut = g.panelH;
      if (process.env.SHOTS_A) await page.screenshot({ path: `${process.env.SHOTS_A}/detail-collapsed-${tag}.png`, fullPage: true });
      for (const n of SEC_NAMES) { if (!secOpen((await secInfo(page))[n])) await page.click(`#pd-sec-${n}-btn`); }
      await page.waitForTimeout(200);
      g = await geo();
      ok('opening everything makes the card clearly taller (so "collapsed" really saved space)', g.panelH > shut + 300, JSON.stringify([shut, g.panelH]));
      ok('still no horizontal scroll with everything open', g.sw <= g.iw, JSON.stringify([g.sw, g.iw]));
      if (process.env.SHOTS_A) await page.screenshot({ path: `${process.env.SHOTS_A}/detail-expanded-${tag}.png`, fullPage: true });
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: ctx });
}

{
  // the empty error / ok lines leave no gap
  const m = secFixture({ phase: 'retouching' });
  await suite('區塊收合 — 空的錯誤／成功訊息列不佔高度（卡片下方不留大段空白）',
    `${base}/admin.html#project=proj-sec`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await secWait(page);
      for (const n of ['settings', 'people']) await page.click(`#pd-sec-${n}-btn`);   // measure them open: a closed section has no height at all
      const r = await page.evaluate(() => ['pd-action-err', 'pd-link-err', 'pd-deliver-err', 'pd-plan-err', 'pd-plan-ok', 'pd-proofdl-err'].map(id => {
        const e = document.getElementById(id); return [id, !!e, e && e.textContent === '', e && e.getBoundingClientRect().height]; }));
      ok('those lines exist and are empty (positive)', r.every(([, there, empty]) => there && empty), JSON.stringify(r));
      ok('and take no height', r.every(([, , , h]) => h === 0), JSON.stringify(r));
      await page.evaluate(() => { document.getElementById('pd-action-err').textContent = '失敗（500）'; });
      ok('a message in one of them is shown again', await page.$eval('#pd-action-err', e => e.getBoundingClientRect().height > 8));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN });
}

// ── orders.html ────────────────────────────────────────────────────────────
{
  const m = dashSettingsMock();
  const o = ordersFake({ products: [], titles: { 'proj-1': '海邊系列', 'proj-2': '婚紗 & 外拍' } });
  o.st.addOrder({ id: 'o1', project_id: 'proj-1', status: 'confirmed', items: [{ name: '相本書', option_label: '8×8 吋', unit_price: 1234, qty: 1 }] });
  o.st.addOrder({ id: 'o2', project_id: 'proj-2', status: 'fulfilled', paid_amount: 3000, paid_method: 'cash', items: [{ name: '無框畫', unit_price: 3000, qty: 1 }] });
  o.st.addOrder({ id: 'o3', project_id: 'proj-2', status: 'cancelled', items: [{ name: '加挑照片', kind: 'extra_pick', unit_price: 200, qty: 5 }] });
  o.st.addOrder({ id: 'o4', project_id: 'proj-1', status: 'fulfilled', paid_amount: 500, paid_method: 'cash', items: [{ name: '相框', unit_price: 1500, qty: 1 }] });
  await suite('訂單頁 — 跨專案列表：專案名、合計、未收、連到專案；全部／未付款／狀態篩選',
    `${base}/orders.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.ord-row', { timeout: 5000 });
      const rows = async () => page.$$eval('.ord-row', els => els.map(e => ({
        id: e.dataset.orderId, status: e.dataset.status, title: e.querySelector('.ord-proj').textContent,
        hrefs: [...e.querySelectorAll('a')].map(a => a.getAttribute('href')), total: e.querySelector('.ord-total').textContent,
        owed: e.querySelector('.ord-owed').textContent, owedRed: e.querySelector('.ord-owed').classList.contains('owed'),
        text: e.textContent.replace(/\s+/g, ' '), opacity: getComputedStyle(e).opacity })));
      let r = await rows();
      ok('全部 asks for /api/admin/orders with no filter and lists all four',
        r.length === 4 && o.st.calls.at(-1).path === '/api/admin/orders' && o.st.calls.at(-1).search === '', JSON.stringify([r.length, o.st.calls.at(-1)]));
      const r1 = r.find(x => x.id === 'o1');
      ok('a row shows project title, NT$1,234-style total, outstanding and its lines', r1.title === '海邊系列' && r1.total === 'NT$1,234' && r1.owed === 'NT$1,234' && r1.owedRed && r1.text.includes('相本書 · 8×8 吋 × 1'), JSON.stringify(r1));
      ok('every link on a row goes to that project’s detail (a &-title is escaped, the id URL-encoded)',
        r.every(x => x.hrefs.length === 2 && x.hrefs.every(h => h === `admin.html#project=${x.id === 'o1' || x.id === 'o4' ? 'proj-1' : 'proj-2'}`)), JSON.stringify(r.map(x => x.hrefs)));
      ok('title text with & renders literally', r.find(x => x.id === 'o2').title === '婚紗 & 外拍');
      ok('a fully paid order owes NT$0 and is not red; a cancelled one is greyed',
        r.find(x => x.id === 'o2').owed === 'NT$0' && !r.find(x => x.id === 'o2').owedRed && Number(r.find(x => x.id === 'o3').opacity) < 1);
      ok('status labels are Chinese', r.find(x => x.id === 'o2').text.includes('已完成') && r.find(x => x.id === 'o3').text.includes('已取消') && r1.text.includes('已確認'));
      ok('the side menu marks 訂單 active', (await page.$eval('.side-nav-item.active', e => e.textContent)) === '訂單');
      ok('the summary adds up what is owed (1,234 + 1,000 = NT$2,234)', (await page.textContent('#summary')).includes('未付款'.slice(0, 0) + '未收合計 NT$2,234'), await page.textContent('#summary'));

      await page.click('[data-filter="unpaid"]');
      await page.waitForFunction(() => document.querySelectorAll('.ord-row').length === 2, null, { timeout: 3000 });
      ok('未付款 asks for ?unpaid=1 and shows only orders that still owe', o.st.calls.at(-1).search === '?unpaid=1' &&
        JSON.stringify((await rows()).map(x => x.id).sort()) === JSON.stringify(['o1', 'o4']), o.st.calls.at(-1).search);
      ok('the active chip moved', (await page.$eval('.chip.active', e => e.textContent)) === '未付款' && (await page.$$('.chip.active')).length === 1);

      await page.click('[data-filter="cancelled"]');
      await page.waitForFunction(() => document.querySelectorAll('.ord-row').length === 1, null, { timeout: 3000 });
      ok('已取消 asks for ?status=cancelled and shows only that', o.st.calls.at(-1).search === '?status=cancelled' && (await rows())[0].id === 'o3');
      await page.click('[data-filter="requested"]');
      await waitText(page, '#order-list', t => t.includes('沒有符合的訂單'));
      ok('a filter with no orders says so instead of a blank page', (await page.textContent('#order-list')).includes('沒有符合的訂單') && (await page.$$('.ord-row')).length === 0);
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  const o = ordersFake({ products: [], titles: { 'proj-1': 'A' } });
  o.st.addOrder({ id: 'q1', project_id: 'proj-1', items: [{ name: '相本書', unit_price: 100, qty: 1 }] });
  o.st.addOrder({ id: 'q2', project_id: 'proj-1', paid_amount: 100, paid_method: 'cash', items: [{ name: '無框畫', unit_price: 100, qty: 1 }] });
  await suite('訂單頁 — ?filter=unpaid（儀表板的待辦連結）直接套用未付款篩選',
    `${base}/orders.html?filter=unpaid`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.ord-row', { timeout: 5000 });
      ok('the unpaid chip is active and only the unpaid order is listed', (await page.$eval('.chip.active', e => e.textContent)) === '未付款' &&
        (await page.$$eval('.ord-row', els => els.map(e => e.dataset.orderId).join())) === 'q1' && o.st.calls[0].search === '?unpaid=1');
      return out;
    },
    { before: async p => { await m.attach(p); await o.attach(p); }, initScript: SEED_TOKEN });
}

await suite('訂單頁 — 沒有 studio_token 時跳轉回 home.html',
  `${base}/orders.html`,
  async page => {
    await page.waitForURL('**/home.html', { timeout: 3000 }).catch(() => {});
    return [`${/home\.html/.test(page.url()) ? 'ok  ' : 'FAIL'}  redirected to home.html   [${page.url()}]`];
  });

// ── dashboard revenue ──────────────────────────────────────────────────────
{
  const m = dashSettingsMock({
    stats: {
      by_phase: { picking: 0, submitted: 0, retouching: 0 }, delivered: 0, archived: 0,
      per_month: [{ month: '2026-08', created: 1, delivered: 1 }, { month: '2026-09', created: 2, delivered: 2 }],
      revenue: [{ month: '2026-08', paid: 5000, cost: 1000, margin: 4000 }, { month: '2026-09', paid: 12345, cost: 4000, margin: 8345 }],
      outstanding: 6000,
      todo: { submitted_not_retouching: 0, unnotified_submissions: 0, modified_after_submit: 0, unpaid_orders: 3 },
    },
  });
  await suite('儀表板 — 本月營收／毛利／未收款卡片、每月營收圖、待辦「未付款訂單 N」',
    `${base}/dashboard.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.getElementById('stat-revenue').textContent !== '–', null, { timeout: 5000 });
      const cards = await page.evaluate(() => ['stat-revenue', 'stat-margin', 'stat-outstanding'].map(id => {
        const n = document.getElementById(id); return [n.textContent, n.parentElement.querySelector('.label').textContent];
      }));
      ok('the cards read the last (current) month: 本月營收 NT$12,345 / 本月毛利 NT$8,345 / 未收款 NT$6,000',
        JSON.stringify(cards) === JSON.stringify([['NT$12,345', '本月營收'], ['NT$8,345', '本月毛利'], ['NT$6,000', '未收款']]), JSON.stringify(cards));
      const bars = await page.$$eval('#rev-chart .chart-col', cols => cols.map(c => ({ rev: c.querySelector('.chart-bar.revenue').style.height, margin: c.querySelector('.chart-bar.margin').style.height, title: c.title })));
      ok('two months; the biggest revenue is 100%, August 5,000/12,345 = 41%; margin scales on the same axis (8,345 → 68%)',
        bars.length === 2 && bars[1].rev === '100%' && bars[0].rev === '41%' && bars[1].margin === '68%' && bars[0].margin === '32%', JSON.stringify(bars));
      ok('the tooltip carries the exact money', bars[1].title.includes('營收 NT$12,345') && bars[1].title.includes('毛利 NT$8,345'), bars[1].title);
      ok('month labels under the revenue chart', (await page.$$eval('#rev-chart-labels span', els => els.map(e => e.textContent).join())) === '08,09');
      const todo = await page.$$eval('#todo-list li', els => els.map(e => ({ text: e.textContent.replace(/\s+/g, ' ').trim(), href: e.querySelector('a').getAttribute('href') })));
      ok('待辦 gains 未付款訂單 3, linking to the unpaid filter', todo.length === 1 && todo[0].text.startsWith('未付款訂單 3') && todo[0].href === 'orders.html?filter=unpaid', JSON.stringify(todo));
      const cols = await page.$eval('.stat-cards.money', e => getComputedStyle(e).gridTemplateColumns.split(' ').length);
      ok('the money cards are a row of three', cols === 3, String(cols));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock();
  await suite('儀表板 — 舊版 Worker（stats 沒有 revenue）：卡片顯示 –，不當掉，也沒有未付款待辦',
    `${base}/dashboard.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#todo-list .todo-empty', { timeout: 5000 });
      const vals = await page.evaluate(() => ['stat-revenue', 'stat-margin', 'stat-outstanding'].map(id => document.getElementById(id).textContent));
      ok('the three cards stay on –', vals.join() === '–,–,–', vals.join());
      ok('the revenue chart says 尚無資料', (await page.textContent('#rev-chart')).includes('尚無資料'));
      ok('no 未付款訂單 line', !(await page.textContent('#todo-list')).includes('未付款訂單'));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}
}
