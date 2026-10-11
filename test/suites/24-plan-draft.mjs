// Browser suites: plan extra_max settings, draft cap, draft retry and keepalive, version stamp.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { SEED_TOKEN, dashSettingsMock } from '../lib/dashboard-mocks.mjs';
import { PHOTOS } from '../lib/editor-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { pickHeart, pickSubmits, openCreateForm } from '../lib/project-helpers.mjs';

export default async function register() {

// ═══════════════════════════════════════════════════════════════════════════
// Project plan: 最多可加選 (docs/project-plan.md) — settings, create, edit, guest cap
// ═══════════════════════════════════════════════════════════════════════════

const puts = m => m.requests.filter(r => r.method === 'PUT' && r.path === '/api/pick/selections');
const toastText = page => page.evaluate(() => document.querySelector('.toast.error .toast-message')?.textContent ?? null);
const seedHearts = (m, keys) => keys.forEach(k =>
  m.state.selections.set(`20260819/${k}.jpg`, { rating: 1, note: '', updated_by: 'picker-0', updated_at: 't' }));
const heartOn = (page, i) => page.locator('.photo-card').nth(i).locator('.pick-heart-btn.on').count().then(n => n === 1);

// ── settings ────────────────────────────────────────────────────────────
{
  const m = dashSettingsMock();
  await suite('plan 設定 — 最多可加選：未設定時 placeholder/說明是 10；0 送 0、留空送 null、501 擋在前端、沒改就不送',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.getElementById('set-default-extra-max').placeholder === '未設定時為 10', null, { timeout: 5000 });
      const st = await page.evaluate(() => ({
        v: document.getElementById('set-default-extra-max').value,
        ph: document.getElementById('set-default-extra-max').placeholder,
        hint: document.getElementById('set-extra-max-hint').textContent,
        inDom: !!document.getElementById('set-default-extra-max'),
      }));
      ok('field exists, empty when unset', st.inDom && st.v === '', JSON.stringify(st));
      ok('placeholder says 未設定時為 10', st.ph === '未設定時為 10', st.ph);
      ok('hint carries 0 = 不可加選 and 10', /0 = 不可加選/.test(st.hint) && /未設定時為 10/.test(st.hint), st.hint);
      const pcount = () => m.seen.filter(r => r.method === 'PUT' && r.path === '/api/admin/settings');

      // unchanged: key absent (a save must not depend on the migration)
      await page.click('#set-save-btn');
      await page.waitForFunction(() => document.getElementById('set-ok').textContent === '已儲存', null, { timeout: 3000 });
      ok('an untouched field is not sent (no default_extra_max key)', !('default_extra_max' in pcount()[0].body), JSON.stringify(pcount()[0].body));

      await page.fill('#set-default-extra-max', '501');
      await page.click('#set-save-btn');
      ok('501 is refused client-side with the message', (await page.textContent('#set-err')) === '最多可加選需為 0–500 的整數');
      ok('and nothing was sent', pcount().length === 1, String(pcount().length));

      await page.fill('#set-default-extra-max', '0');
      await page.click('#set-save-btn');
      await page.waitForFunction(() => document.getElementById('set-ok').textContent === '已儲存', null, { timeout: 3000 });
      ok('0 is sent as the number 0 (not null, not omitted)', pcount().length === 2 && pcount()[1].body.default_extra_max === 0, JSON.stringify(pcount()[1]?.body));

      await page.fill('#set-default-extra-max', '');
      await page.click('#set-save-btn');
      await page.waitForFunction(() => document.getElementById('set-ok').textContent === '已儲存', null, { timeout: 3000 });
      ok('cleared → null (back to the default of 10)', pcount().length === 3 && pcount()[2].body.default_extra_max === null, JSON.stringify(pcount()[2]?.body));
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

{
  const m = dashSettingsMock({ settings: { default_extra_max: 25 } });
  await suite('plan 設定 — 已存的預設帶入欄位；後端 invalid_default_extra_max 顯示中文',
    `${base}/settings.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForFunction(() => document.getElementById('set-default-extra-max').value === '25', null, { timeout: 5000 });
      ok('the stored default_extra_max fills the field', true);
      m.state.settingsPutStatus = 400;
      m.state.settingsPutBody = { error: 'x', code: 'invalid_default_extra_max' };
      await page.fill('#set-default-extra-max', '30');
      await page.click('#set-save-btn');
      await page.waitForFunction(() => document.getElementById('set-err').textContent !== '', null, { timeout: 3000 });
      ok('server code maps to the message', (await page.textContent('#set-err')) === '最多可加選需為 0–500 的整數');
      m.state.settingsPutStatus = 500;
      m.state.settingsPutBody = { error: 'x', code: 'extra_max_unavailable' };
      await page.click('#set-save-btn');
      await page.waitForFunction(() => document.getElementById('set-err').textContent.includes('migration'), null, { timeout: 3000 });
      ok('extra_max_unavailable tells to run the migration', (await page.textContent('#set-err')) === '請先在 D1 執行 extra-max migration');
      return out;
    },
    { before: m.attach, initScript: SEED_TOKEN });
}

// ── create form ─────────────────────────────────────────────────────────
// (the folders come from the project name + shoot date now, so "pick a folder" became "name the project")
async function planPickFolder(page) {
  await page.waitForSelector('#admin-view', { state: 'visible', timeout: 5000 });
  await openCreateForm(page);
  await page.fill('#proj-title', '王小明');
}
const createPosts = m => m.requests.filter(r => r.method === 'POST' && r.path === '/api/admin/projects');

{
  const m = pickFakeWorker({ bucketFolders: ['20260819/'] });
  await suite('plan 建立專案 — 最多可加選預帶有效預設 10；501 擋在前端；0 送數字 0',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await planPickFolder(page);
      await page.waitForFunction(() => document.getElementById('proj-extra-max').value !== '', null, { timeout: 5000 });
      ok('prefilled from effective_default_extra_max (10 when unset)', (await page.inputValue('#proj-extra-max')) === '10');
      await page.fill('#proj-extra-max', '501');
      await page.click('#proj-create-btn');
      ok('501 refused with a message', (await page.textContent('#proj-create-err')) === '最多可加選需為 0–500 的整數');
      ok('no request sent', createPosts(m).length === 0);
      await page.fill('#proj-extra-max', '0');
      await page.click('#proj-create-btn');
      await page.waitForSelector('#proj-create-result', { state: 'visible', timeout: 5000 });
      const b = createPosts(m)[0].body;
      ok('0 is sent as the number 0', b.extra_max === 0 && typeof b.extra_max === 'number', JSON.stringify(b));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ bucketFolders: ['20260819/'], settings: { default_extra_max: 7 } });
  await suite('plan 建立專案 — 預帶店家預設 7，改成 3 就送 3',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await planPickFolder(page);
      await page.waitForFunction(() => document.getElementById('proj-extra-max').value !== '', null, { timeout: 5000 });
      ok('prefilled 7 from the studio default', (await page.inputValue('#proj-extra-max')) === '7');
      await page.fill('#proj-extra-max', '3');
      await page.click('#proj-create-btn');
      await page.waitForSelector('#proj-create-result', { state: 'visible', timeout: 5000 });
      ok('sent extra_max 3', createPosts(m)[0].body.extra_max === 3, JSON.stringify(createPosts(m)[0].body));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ bucketFolders: ['20260819/'], settings: { default_extra_max: 7 } });
  await suite('plan 建立專案 — 清空欄位就完全不送 extra_max（絕不送 null，null = 不限制）',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await planPickFolder(page);
      await page.waitForFunction(() => document.getElementById('proj-extra-max').value === '7', null, { timeout: 5000 });
      await page.fill('#proj-extra-max', '');
      await page.click('#proj-create-btn');
      await page.waitForSelector('#proj-create-result', { state: 'visible', timeout: 5000 });
      const b = createPosts(m)[0].body;
      ok('the key is absent from the POST body', !('extra_max' in b), JSON.stringify(b));
      ok('the rest of the plan is still sent', 'pick_limit' in b && 'extra_price' in b && Array.isArray(b.folders));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ── edit form ───────────────────────────────────────────────────────────
{
  const m = pickFakeWorker({ projectId: 'proj-plan', pickLimit: 40, extraPrice: 300, extraMax: 10 });
  await suite('plan 編輯方案 — 預帶目前值、結果行、只送改動的鍵、留空語意、沒改不送',
    `${base}/admin.html#project=proj-plan`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const patches = () => m.requests.filter(r => r.method === 'PATCH').map(r => r.body);
      await page.waitForSelector('#pd-plan-limit', { timeout: 5000 });
      const v = await page.evaluate(() => ({
        l: document.getElementById('pd-plan-limit').value, p: document.getElementById('pd-plan-price').value,
        e: document.getElementById('pd-plan-extra').value,
        res: document.getElementById('pd-plan-result').textContent,
        box: document.getElementById('pd-plan').textContent,
      }));
      ok('inputs show the plan', v.l === '40' && v.p === '300' && v.e === '10', JSON.stringify(v));
      ok('result line shows 40 + 10 = 50', /50 張（40 \+ 加選 10）/.test(v.res), v.res);
      ok('the extra-max label says 留空 = 不限制', /留空 = 不限制/.test(v.box));
      ok('the note says submitted records keep their plan', /已送出的紀錄維持送出當時的方案/.test(v.box));

      await page.click('#pd-plan-save');
      await page.waitForFunction(() => document.getElementById('pd-plan-ok').textContent === '沒有變更', null, { timeout: 2000 });
      ok('nothing changed → no request', patches().length === 0, JSON.stringify(patches()));

      await page.fill('#pd-plan-extra', '5');
      await page.click('#pd-plan-save');
      await page.waitForFunction(() => document.getElementById('pd-plan-ok')?.textContent === '已儲存', null, { timeout: 4000 });
      ok('only the changed key is sent', JSON.stringify(patches()) === JSON.stringify([{ extra_max: 5 }]), JSON.stringify(patches()));
      ok('detail refreshed: result line now 45', /45 張（40 \+ 加選 5）/.test(await page.textContent('#pd-plan-result')), await page.textContent('#pd-plan-result'));
      ok('the list was refreshed too', m.requests.filter(r => r.method === 'GET' && r.path === '/api/admin/projects').length >= 2);

      await page.fill('#pd-plan-limit', '');
      await page.fill('#pd-plan-price', '');
      await page.click('#pd-plan-save');
      await page.waitForFunction(() => document.getElementById('pd-plan-ok')?.textContent === '已儲存' && document.getElementById('pd-plan-result')?.textContent.includes('不限'), null, { timeout: 4000 });
      ok('blank 張數 and 單價 → null, extra_max untouched',
        JSON.stringify(patches()[1]) === JSON.stringify({ pick_limit: null, extra_price: null }), JSON.stringify(patches()));
      ok('result line says 不限 when 張數 is empty', /客人最多可挑：不限/.test(await page.textContent('#pd-plan-result')));

      await page.fill('#pd-plan-extra', '');
      await page.click('#pd-plan-save');
      // (optional chaining: the detail shows 載入中… for a moment while it re-reads, with no #pd-plan-result in it)
      await page.waitForFunction(() => document.getElementById('pd-plan-result')?.textContent.includes('不限制（舊專案）'), null, { timeout: 4000 });
      ok('blank 最多可加選 → null (uncapped)', JSON.stringify(patches()[2]) === JSON.stringify({ extra_max: null }), JSON.stringify(patches()));

      await page.fill('#pd-plan-extra', '0');
      await page.click('#pd-plan-save');
      await page.waitForFunction(() => document.getElementById('pd-plan-ok')?.textContent === '已儲存', null, { timeout: 4000 });
      ok('0 → number 0 (不可加選), not null', JSON.stringify(patches()[3]) === JSON.stringify({ extra_max: 0 }), JSON.stringify(patches()));

      const n = patches().length;
      await page.fill('#pd-plan-extra', '501');
      await page.click('#pd-plan-save');
      ok('501 refused client-side', (await page.textContent('#pd-plan-err')) === '最多可加選需為 0–500 的整數' && patches().length === n);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-old', pickLimit: 40, extraMax: null });
  await suite('plan 編輯方案 — 舊專案 extra_max NULL 顯示「不限制（舊專案）」，欄位留空',
    `${base}/admin.html#project=proj-old`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-plan-extra', { timeout: 5000 });
      ok('the field is empty', (await page.inputValue('#pd-plan-extra')) === '');
      ok('the result line says 不限制（舊專案）', /不限制（舊專案）/.test(await page.textContent('#pd-plan-result')), await page.textContent('#pd-plan-result'));
      await page.click('#pd-plan-save');
      await page.waitForTimeout(200);
      ok('saving untouched sends nothing (null → null is no change)', m.requests.filter(r => r.method === 'PATCH').length === 0);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-arch', pickLimit: 40, extraMax: 10, archivedAt: '2026-02-01T00:00:00.000Z' });
  await suite('plan 編輯方案 — 封存專案 409 archived 顯示中文，欄位仍可再改',
    `${base}/admin.html#project=proj-arch`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-plan-extra', { timeout: 5000 });
      await page.fill('#pd-plan-extra', '3');
      await page.click('#pd-plan-save');
      await page.waitForFunction(() => document.getElementById('pd-plan-err').textContent !== '', null, { timeout: 3000 });
      ok('archived message', (await page.textContent('#pd-plan-err')) === '專案已封存，請先取消封存再修改方案');
      ok('the button is usable again', !(await page.$eval('#pd-plan-save', b => b.disabled)));
      ok('no success line', (await page.textContent('#pd-plan-ok')) === '');
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = pickFakeWorker({ projectId: 'proj-nomig', pickLimit: 40, extraMax: 10, patchStatus: 500, patchBody: { error: 'x', code: 'extra_max_unavailable' } });
  await suite('plan 編輯方案 — extra_max_unavailable (500) 提示先跑 migration',
    `${base}/admin.html#project=proj-nomig`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pd-plan-extra', { timeout: 5000 });
      await page.fill('#pd-plan-extra', '3');
      await page.click('#pd-plan-save');
      await page.waitForFunction(() => document.getElementById('pd-plan-err').textContent !== '', null, { timeout: 3000 });
      ok('migration message', (await page.textContent('#pd-plan-err')) === '請先在 D1 執行 extra-max migration');
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// ── guest page: hearts are drafts, the plan cap bites at submit ─────────
const savedHearts = m => Array.from(m.state.selections.values()).filter(s => s.rating > 0).length;
const heartAll = (page, n) => page.evaluate(n => {
  const btns = Array.from(document.querySelectorAll('.photo-card .pick-heart-btn')).slice(0, n);
  btns.forEach(b => b.click());
  return btns.length;
}, n);
const colorOf = (page, sel) => page.evaluate(s => getComputedStyle(document.querySelector(s)).color, sel);
const WARN_COLOR = page => page.evaluate(() => {
  const t = document.createElement('i'); t.style.color = getComputedStyle(document.documentElement).getPropertyValue('--warning');
  document.body.appendChild(t); const c = getComputedStyle(t).color; t.remove(); return c;
});
const DANGER_COLOR = page => page.evaluate(() => {
  const t = document.createElement('i'); t.style.color = getComputedStyle(document.documentElement).getPropertyValue('--danger');
  document.body.appendChild(t); const c = getComputedStyle(t).color; t.remove(); return c;
});
const SHOTS = '/tmp/claude-0/-home-user-imge-picker/239eaf5f-50a8-5d76-9673-4b17f1434015/scratchpad';

for (const [label, co] of [['desktop', undefined], ['phone 390px', MOBILE]]) {
  const m = pickFakeWorker({ ownerName: 'Cap', ownerKey: 'CAP-KEY', pickLimit: 40, extraMax: 10, extraPrice: 300, photos: PHOTOS(120) });
  await suite(`draft cap — 120 hearts on a 40+10 plan all save, counter goes red with the exact text, ♥ never blocked (${label})`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('starts in the plan', (await page.textContent('#pickCounter')) === '已選 0 / 40 張（最多可加選到 50）');
      const n = await heartAll(page, 45);
      ok('45 hearts clicked (positive)', n === 45, String(n));
      await page.waitForFunction(() => document.getElementById('pickCounter').textContent.startsWith('已選 45'), null, { timeout: 4000 });
      const orangeText = await page.textContent('#pickCounter');
      ok('45 (fee zone): still the plan text', orangeText === '已選 45 / 40 張（最多可加選到 50）', orangeText);
      const orange = await colorOf(page, '#pickCounter');
      ok('45 is the warning orange', orange === await WARN_COLOR(page), orange);
      await heartAll(page, 120); // toggles the first 45 OFF; so click only the rest
      // (heartAll toggled 0..44 back off and 45..119 on = 75) -> re-toggle the first 45
      await page.waitForFunction(() => document.getElementById('pickCounter').textContent.startsWith('已選 75'), null, { timeout: 4000 });
      await heartAll(page, 45);
      await page.waitForFunction(() => document.getElementById('pickCounter').textContent.startsWith('已選 120'), null, { timeout: 4000 });
      const t = await page.textContent('#pickCounter');
      ok('120 hearts: red text, exact', t === '已選 120 張（上限 50 張，需減 70 張）', t);
      const red = await colorOf(page, '#pickCounter');
      ok('red is the danger token', red === await DANGER_COLOR(page), red);
      ok('and differs from the orange', red !== orange && red !== await WARN_COLOR(page), `${red} vs ${orange}`);
      ok('over-cap class on, plain over class off', await page.evaluate(() => {
        const c = document.getElementById('pickCounter').classList; return c.contains('over-cap') && !c.contains('over'); }));
      ok('no cap toast, ever', (await toastText(page)) === null, String(await toastText(page)));
      await page.waitForTimeout(1500);
      ok('all 120 hearts saved server-side', savedHearts(m) === 120, String(savedHearts(m)));
      ok('no save was answered pick_cap / nothing reverted (still 120 on screen)', (await page.textContent('#pickCounter')).startsWith('已選 120'));
      ok('no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const box = await page.evaluate(() => { const r = document.getElementById('pickCounter').getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth }; });
      ok('the counter fits inside the viewport', box.l >= 0 && box.r <= box.w + 0.5, JSON.stringify(box));
      const btn = await page.evaluate(() => document.getElementById('pickSubmitBtn').getBoundingClientRect().height);
      ok('submit button ≥ 40px', btn >= 40, String(btn));
      if (co) await page.screenshot({ path: `${SHOTS}/cap-red-390.png` });
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'CAP-KEY'), contextOptions: co });
}

{
  const m = pickFakeWorker({ ownerName: 'Zero', ownerKey: 'ZERO-KEY', pickLimit: 2, extraMax: 0, photos: PHOTOS(6) });
  await suite('draft cap — extra_max 0: 已選 2 / 2 張（不可加選）; past it the red text says 不可加選，需減 N 張; ♥ still works',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await pickHeart(page, 0); await pickHeart(page, 1);
      ok('at the plan', (await page.textContent('#pickCounter')) === '已選 2 / 2 張（不可加選）', await page.textContent('#pickCounter'));
      ok('not red at exactly the plan', await page.evaluate(() => !document.getElementById('pickCounter').classList.contains('over-cap')));
      await pickHeart(page, 2); await pickHeart(page, 3); await pickHeart(page, 4);
      ok('the hearts are on, none refused (positive)', (await heartOn(page, 2)) && (await heartOn(page, 3)) && (await heartOn(page, 4)));
      ok('red text, 0-extras variant', (await page.textContent('#pickCounter')) === '已選 5 張（上限 2 張，不可加選，需減 3 張）', await page.textContent('#pickCounter'));
      ok('no toast', (await toastText(page)) === null);
      await page.waitForTimeout(1300);
      ok('all 5 saved', savedHearts(m) === 5, String(savedHearts(m)));
      // submit refused client-side, with the 0-extras dialog text
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickCapModal.active', { timeout: 3000 });
      ok('0-extras dialog text exact', (await page.textContent('#pickCapBody')) === '目前選了 5 張，此專案最多 2 張，不可加選。請先取消 3 張再送出', await page.textContent('#pickCapBody'));
      ok('no submit request', pickSubmits(m).length === 0);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZERO-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Old', ownerKey: 'OLD-KEY', pickLimit: 2, extraMax: null, photos: PHOTOS(5) });
  await suite('draft cap — no plan cap (extra_max null, an old project): counter as before, never red, submit goes to the price dialog, no cap dialog',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('counter without the extra clause', (await page.textContent('#pickCounter')) === '已選 0 / 2 張');
      for (let i = 0; i < 4; i++) await pickHeart(page, i);
      ok('counter 已選 4 / 2 張', (await page.textContent('#pickCounter')) === '已選 4 / 2 張');
      ok('orange over, not the red class', await page.evaluate(() => { const c = document.getElementById('pickCounter').classList; return c.contains('over') && !c.contains('over-cap'); }));
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickOverModal.active', { timeout: 3000 });
      ok('the over-plan dialog opened (positive)', true);
      ok('the cap dialog did not', await page.evaluate(() => !document.getElementById('pickCapModal').classList.contains('active')));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'OLD-KEY') });
}

for (const [label, co] of [['desktop', undefined], ['phone 390px', MOBILE]]) {
  const m = pickFakeWorker({ ownerName: 'Sub', ownerKey: 'SUB-KEY', pickLimit: 2, extraMax: 1, extraPrice: 500, photos: PHOTOS(8) });
  await suite(`draft cap — submit over the cap: NO submit request, dialog with exact text, 回去刪減 → 已選 filter; trim then submit works (${label})`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      for (let i = 0; i < 6; i++) await pickHeart(page, i);
      await page.waitForTimeout(1300);
      ok('6 hearts saved (cap 3), nothing refused', savedHearts(m) === 6 && (await toastText(page)) === null, String(savedHearts(m)));
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickCapModal.active', { timeout: 3000 });
      const title = await page.textContent('#pickCapTitle');
      ok('title', title === '已超出可送出張數', title);
      const body = await page.textContent('#pickCapBody');
      ok('text exact', body === '目前選了 6 張，最多可送出 3 張（方案 2 + 加選 1）。請先取消 3 張再送出', body);
      ok('NO submit request was sent', pickSubmits(m).length === 0, JSON.stringify(pickSubmits(m)));
      ok('the submit form and price dialog stayed closed', await page.evaluate(() =>
        !document.getElementById('pickSubmitModal').classList.contains('active') && !document.getElementById('pickOverModal').classList.contains('active')));
      const btns = await page.$$eval('#pickCapModal .modal-content button', bs => bs.map(b => ({ t: b.textContent.trim(), h: b.getBoundingClientRect().height })));
      ok('one button 回去刪減, ≥ 44px', btns.length === 1 && btns[0].t === '回去刪減' && btns[0].h >= 43.9, JSON.stringify(btns));
      const geo = await page.evaluate(() => { const r = document.querySelector('#pickCapModal .modal-content').getBoundingClientRect();
        return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: innerWidth, h: innerHeight }; });
      ok('the dialog fits the viewport and is centred', geo.l >= 0 && geo.r <= geo.w && Math.abs((geo.l + geo.r) / 2 - geo.w / 2) < 2 && geo.t >= 0 && geo.b <= geo.h, JSON.stringify(geo));
      if (co) await page.screenshot({ path: `${SHOTS}/cap-dialog-390.png` });
      await page.click('#pickCapBackBtn');
      ok('closes', await page.evaluate(() => !document.getElementById('pickCapModal').classList.contains('active')));
      ok('switched to the 已選 filter', await page.evaluate(() => document.querySelector('#pickFilterBar [data-pick-filter="selected"]').classList.contains('active')));
      ok('the grid shows exactly the 6 picks (positive)', (await page.locator('.photo-card').count()) === 6, String(await page.locator('.photo-card').count()));
      // trim 3 in the 已選 view
      for (let i = 0; i < 3; i++) await page.locator('.photo-card').first().locator('.pick-heart-btn').click();
      await page.waitForFunction(() => document.getElementById('pickCounter').textContent.startsWith('已選 3'), null, { timeout: 3000 });
      ok('counter no longer red at 3', await page.evaluate(() => !document.getElementById('pickCounter').classList.contains('over-cap')));
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickOverModal.active', { timeout: 3000 });
      ok('within the cap: the price dialog (3 > plan 2), unchanged', (await page.$$eval('#pickOverBody p', ps => ps[0].textContent)) === '方案 2 張，目前已選 3 張，超出 1 張');
      await page.click('#pickOverConfirmBtn');
      await page.selectOption('#pickSubmitRelationship', '朋友');
      await page.click('#pickSubmitConfirmBtn');
      await page.waitForFunction(() => document.getElementById('pickSubmitModal') && !document.getElementById('pickSubmitModal').classList.contains('active'), null, { timeout: 4000 });
      ok('exactly one submit request, recorded with 3 photos', pickSubmits(m).length === 1 && m.state.submissions.length === 1 && m.state.submissions[0].count === 3, JSON.stringify(pickSubmits(m)));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'SUB-KEY'), contextOptions: co });
}

{
  const m = pickFakeWorker({ ownerName: 'Srv', ownerKey: 'SRV-KEY', pickLimit: 2, extraMax: 5, photos: PHOTOS(6) });
  seedHearts(m, ['p0', 'p1', 'p2', 'p3']);
  await suite('draft cap — stale page: the server’s 409 pick_cap on the real submit opens the dialog with the server’s numbers; spinner not stuck',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('page holds max 7', (await page.textContent('#pickCounter')) === '已選 4 / 2 張（最多可加選到 7）', await page.textContent('#pickCounter'));
      m.state.project.extra_max = 1; // photographer lowered it after the page loaded: real max is 3
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickOverModal.active', { timeout: 3000 }); // client still believes it fits
      await page.click('#pickOverConfirmBtn');
      await page.selectOption('#pickSubmitRelationship', '朋友');
      await page.click('#pickSubmitConfirmBtn');
      await page.waitForSelector('#pickCapModal.active', { timeout: 4000 });
      ok('one submit request went out (the server is the authority)', pickSubmits(m).length === 1);
      const body = await page.textContent('#pickCapBody');
      ok('dialog uses the response’s numbers', body === '目前選了 4 張，最多可送出 3 張（方案 2 + 加選 1）。請先取消 1 張再送出', body);
      ok('submit form and price dialog closed', await page.evaluate(() =>
        !document.getElementById('pickSubmitModal').classList.contains('active') && !document.getElementById('pickOverModal').classList.contains('active')));
      ok('confirm button re-enabled (no stuck spinner)', await page.evaluate(() => !document.getElementById('pickSubmitConfirmBtn').disabled));
      ok('nothing recorded server-side', m.state.submissions.length === 0 && m.state.project.phase === 'picking');
      ok('counter took the server’s cap: red', (await page.textContent('#pickCounter')) === '已選 4 張（上限 3 張，需減 1 張）', await page.textContent('#pickCounter'));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'SRV-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Mod', ownerKey: 'MOD-KEY', pickLimit: 1, extraMax: 2, extraPrice: 500, photos: PHOTOS(4) });
  await suite('draft cap — over-plan price dialog unchanged within the cap (1 + 2 extra: 3 hearts); a 4th heart is allowed (draft), submit then refused',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await pickHeart(page, 0); await pickHeart(page, 1); await pickHeart(page, 2);
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickOverModal.active', { timeout: 3000 });
      const lines = await page.$$eval('#pickOverBody p', ps => ps.map(p => p.textContent));
      ok('modal line 1 unchanged', lines[0] === '方案 1 張，目前已選 3 張，超出 2 張', JSON.stringify(lines));
      ok('modal line 2 unchanged', lines[1] === '加挑每張 NT$500，加價 NT$500 × 2 = NT$1,000', JSON.stringify(lines));
      await page.click('#pickOverBackBtn');
      await pickHeart(page, 3);
      ok('the 4th heart turns on', await heartOn(page, 3));
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickCapModal.active', { timeout: 3000 });
      ok('cap dialog, not the price dialog', await page.evaluate(() => !document.getElementById('pickOverModal').classList.contains('active')));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'MOD-KEY') });
}

// ── draft reliability: requeue + retry, keepalive on pagehide, status ────
const statusLog = page => page.evaluate(() => {
  window.__st = [];
  const el = document.getElementById('pickSaveStatus');
  new MutationObserver(() => { const t = el.textContent; if (t && window.__st[window.__st.length - 1] !== t) window.__st.push(t); })
    .observe(el, { childList: true, characterData: true, subtree: true });
});

for (const [label, fails] of [['network error twice', ['net', 'net']], ['503 then network error', [503, 'net']], ['429 once', [429]]]) {
  const m = pickFakeWorker({ ownerName: 'Ret', ownerKey: 'RET-KEY', pickLimit: 40, extraMax: 10, photos: PHOTOS(4), failSaves: [...fails] });
  await suite(`draft retry — ${label}: the ♥ ends up saved exactly once, status 儲存中… → 儲存失敗，重試中… → 已自動儲存`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.waitForSelector('#pickSaveStatus');
      await page.evaluate(() => { PickController.retryDelays = [150, 150, 150]; });
      await statusLog(page);
      await pickHeart(page, 1);
      await page.waitForFunction(() => window.__st.includes('已自動儲存'), null, { timeout: 6000 });
      const st = await page.evaluate(() => window.__st);
      ok('status sequence', JSON.stringify(st) === JSON.stringify(['儲存中…', '儲存失敗，重試中…', '已自動儲存']), JSON.stringify(st));
      const reqs = puts(m);
      ok(`${fails.length + 1} attempts, all the same single ♥ (no duplicate rows, no reorder)`,
        reqs.length === fails.length + 1 && reqs.every(r => r.body.upsert.length === 1 && r.body.upsert[0].photo_key === '20260819/p1.jpg' && r.body.upsert[0].rating === 1),
        JSON.stringify(reqs.map(r => r.body)));
      ok('server holds exactly one row, rating 1', m.state.selections.size === 1 && m.state.selections.get('20260819/p1.jpg').rating === 1);
      ok('the ♥ never left the screen', await heartOn(page, 1));
      ok('no error toast during a recoverable outage', (await toastText(page)) === null);
      await page.waitForFunction(() => document.getElementById('pickSaveStatus').textContent === '', null, { timeout: 5000 });
      ok('the 已自動儲存 note fades out (positive: it was shown, now empty)', true);
      return out;
    },
    { before: async page => { await m.attach(page); }, initScript: () => localStorage.setItem('pick_key:TOK', 'RET-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Mrg', ownerKey: 'MRG-KEY', pickLimit: 40, extraMax: 10, photos: PHOTOS(4), failSaves: [{ fail: 'net', delay: 900 }] });
  await suite('draft retry — a newer change made while the failed batch is in flight wins (last mention of a key); other keys survive; one row each',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.evaluate(() => { PickController.retryDelays = [300, 300, 300]; });
      await pickHeart(page, 0); await pickHeart(page, 1);
      await page.waitForTimeout(1100); // the debounce (800ms) fired, the slow request (900ms) is in flight
      await pickHeart(page, 0); // un-heart p0 while p0+p1 are on the wire (it then fails)
      await page.waitForFunction(() => document.getElementById('pickSaveStatus').textContent === '已自動儲存', null, { timeout: 8000 });
      const sel = Array.from(m.state.selections.entries()).map(([k, v]) => `${k}:${v.rating}`).sort();
      // p0 was un-hearted last (newer wins) and has no note, so it is deleted rather than kept as an empty row
      ok('final server state: p0 un-hearted (newer wins, no row left), p1 rating 1, no duplicates', JSON.stringify(sel) === JSON.stringify(['20260819/p1.jpg:1']), JSON.stringify(sel));
      ok('screen agrees', !(await heartOn(page, 0)) && (await heartOn(page, 1)));
      // requests: first (failed) had both; later ones must never resurrect p0=1 after the un-heart
      const last = puts(m).slice(1).flatMap(r => r.body.upsert).filter(u => u.photo_key.endsWith('p0.jpg')).map(u => u.rating);
      ok('no request after the failure carries p0 rating 1', !last.includes(1), JSON.stringify(last));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'MRG-KEY') });
}

{
  const o = { ownerName: 'Bad', ownerKey: 'BAD-KEY', pickLimit: 40, extraMax: 10, photos: PHOTOS(3) };
  const m = pickFakeWorker(o);
  await suite('draft retry — a non-retryable refusal (409 selection_cap) is NOT retried: revert + toast as before',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.evaluate(() => { PickController.retryDelays = [100, 100, 100]; });
      o.failNextSave = { status: 409, body: { error: 'x', code: 'selection_cap', max: 500 } };
      await pickHeart(page, 0);
      await page.waitForFunction(() => document.querySelector('.toast.error .toast-message'), null, { timeout: 4000 });
      await page.waitForTimeout(600);
      ok('one request only', puts(m).length === 1, String(puts(m).length));
      ok('toast 最多可選 500 張', (await toastText(page)) === '最多可選 500 張', String(await toastText(page)));
      ok('heart reverted', !(await heartOn(page, 0)));
      ok('no retrying status', (await page.textContent('#pickSaveStatus')) !== '儲存失敗，重試中…');
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'BAD-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Uns', ownerKey: 'UNS-KEY', pickLimit: 40, extraMax: 10, photos: PHOTOS(3),
    failSaves: Array.from({ length: 12 }, () => 'net') });
  await suite('draft retry — submit while a ♥ is still unsaved is refused with a message (never submits a different list); spinner released',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.evaluate(() => { PickController.retryDelays = [5000, 5000, 5000]; });
      await pickHeart(page, 0);
      await page.waitForFunction(() => document.getElementById('pickSaveStatus').textContent === '儲存失敗，重試中…', null, { timeout: 4000 });
      await page.click('#pickSubmitBtn');
      await page.selectOption('#pickSubmitRelationship', '朋友');
      await page.click('#pickSubmitConfirmBtn');
      await page.waitForFunction(() => document.getElementById('pickSubmitErr').textContent.length > 0, null, { timeout: 4000 });
      ok('message shown', (await page.textContent('#pickSubmitErr')) === '尚有選擇未儲存，請確認網路後再試一次');
      ok('no submit request', pickSubmits(m).length === 0);
      ok('confirm button re-enabled', await page.evaluate(() => !document.getElementById('pickSubmitConfirmBtn').disabled));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'UNS-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Hid', ownerKey: 'HID-KEY', pickLimit: 40, extraMax: 10, photos: PHOTOS(3) });
  await suite('draft keepalive — pagehide flushes a pending ♥ with fetch keepalive and the same headers; nothing pending → nothing sent',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.evaluate(() => {
        window.__f = [];
        const orig = window.fetch;
        window.fetch = function (u, init) { window.__f.push({ u: String(u), keepalive: !!(init && init.keepalive), method: init && init.method, h: init && init.headers }); return orig.apply(this, arguments); };
      });
      // nothing pending: pagehide sends nothing
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      await page.waitForTimeout(300);
      ok('no pending → no request', puts(m).length === 0);
      await pickHeart(page, 2);
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); // well inside the 800ms debounce
      await page.waitForFunction(() => window.__f.some(f => f.keepalive), null, { timeout: 2000 });
      const f = await page.evaluate(() => window.__f.filter(x => x.keepalive));
      ok('one keepalive PUT to /api/pick/selections', f.length === 1 && f[0].method === 'PUT' && f[0].u.endsWith('/api/pick/selections'), JSON.stringify(f));
      ok('carries X-Share-Token and X-Picker-Key', f[0].h['X-Share-Token'] === 'TOK' && f[0].h['X-Picker-Key'] === 'HID-KEY', JSON.stringify(f[0].h));
      await page.waitForFunction(() => true);
      await page.waitForTimeout(200);
      const early = puts(m)[0];
      ok('the server got the ♥ before the debounce fired', early && early.body.upsert[0].photo_key === '20260819/p2.jpg' && early.body.upsert[0].rating === 1 && early.key === 'HID-KEY' && early.t === 'TOK', JSON.stringify(early));
      ok('server state holds it', m.state.selections.get('20260819/p2.jpg')?.rating === 1);
      // visibilitychange to hidden does the same
      await pickHeart(page, 1);
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForFunction(() => window.__f.filter(f => f.keepalive).length === 2, null, { timeout: 2000 });
      ok('visibilitychange→hidden also flushes with keepalive', true);
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'HID-KEY') });
}

{
  const m = pickFakeWorker({ ownerName: 'Boss', ownerKey: 'BOSS-KEY', pickLimit: 2, extraMax: 1, photos: PHOTOS(4) });
  seedHearts(m, ['p0', 'p1', 'p2']);
  await suite('plan cap — a viewer is unchanged: no counter, no ♥ buttons, nothing to refuse',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('no counter element', await page.evaluate(() => document.getElementById('pickCounter') === null));
      const hearts = await page.evaluate(() => ({
        buttons: document.querySelectorAll('button.pick-heart-btn').length,
        statics: document.querySelectorAll('span.pick-heart-btn').length,
      }));
      ok('hearts are static spans, no buttons (positive: the spans exist)', hearts.buttons === 0 && hearts.statics > 0, JSON.stringify(hearts));
      ok('no message', (await toastText(page)) === null);
      ok('no save requests', puts(m).length === 0);
      return out;
    },
    { before: m.attach });
}

await suite('版本號 — admin shows the asset version it loaded',
  `${base}/admin.html`,
  async page => {
    await page.waitForFunction(() => (document.getElementById('buildVersion') || {}).textContent, null, { timeout: 5000 }).catch(() => {});
    const text = await page.evaluate(() => { const el = document.getElementById('buildVersion'); return el ? el.textContent : null; });
    const inHeader = await page.evaluate(() => !!document.querySelector('header #buildVersion'));
    return [
      `${/^v\d{8}[a-z]?$/.test(text || '') ? 'ok  ' : 'FAIL'}  the header names the version   [${text}]`,
      `${inHeader ? 'ok  ' : 'FAIL'}  and it sits in the header`,
    ];
  });
}
