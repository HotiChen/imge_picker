// Browser suites: operator page 攝影師帳號 panel (docs/multi-photographer.md, batch 1):
// pending sign-ups with 核准 / 拒絕, 停用 / 恢復, 重設密碼 shown once, the pending badge.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { OP_KEY, OP_SEED, PLAT_ALBUM, T, clone, disp, ordersFake, waitText } from '../lib/orders-fake.mjs';

export default async function register() {

// A fake of /api/operator/photographers* mirroring worker.js: the operator
// token or 401 {error}; the method / route (405 / 404); before the migration
// 500 photographers_unavailable; the list newest first with pending_count and
// the public columns only (never password_hash); each action conditional on
// the status it moves from (409 wrong_status with the current status), 404 for
// an unknown id; reject deletes; reset-password returns temp_password once.
function photographersFake({ accounts = [], unavailable = false, operatorToken = 'op' } = {}) {
  const st = { accounts: accounts.map(clone), calls: [], inject: null, temps: [] };
  const MOVES = { approve: ['pending', 'active'], reject: ['pending', null], suspend: ['active', 'suspended'], unsuspend: ['suspended', 'active'], 'reset-password': [null, null] };
  const pub = a => ({ id: a.id, email: a.email, display_name: a.display_name, studio_note: a.studio_note ?? null, status: a.status, created_at: a.created_at, approved_at: a.approved_at ?? null, last_login_at: a.last_login_at ?? null });
  const list = () => {
    const sorted = st.accounts.slice().sort((x, y) => (x.created_at < y.created_at ? 1 : x.created_at > y.created_at ? -1 : 0));
    return { photographers: sorted.map(pub), pending_count: sorted.filter(a => a.status === 'pending').length };
  };
  function handle(method, path) {
    const parts = path.split('/').filter(Boolean); // api operator photographers [id] [action]
    if (parts.length > 5) return { status: 404, body: { error: 'Not found' } };
    const [, , , id, action] = parts;
    const route = !id ? 'list' : MOVES[action] ? 'action' : null;
    if (!route) return { status: 404, body: { error: 'Not found' } };
    if (method !== (route === 'list' ? 'GET' : 'POST')) return { status: 405, body: { error: 'Method not allowed' } };
    if (unavailable) return { status: 500, body: { error: '攝影師帳號功能尚未啟用', code: 'photographers_unavailable' } };
    if (route === 'list') return { body: list() };
    const injected = st.inject && st.inject(method, path);
    if (injected) return injected;
    const a = st.accounts.find(x => x.id === id);
    if (!a) return { status: 404, body: { error: 'Not found' } };
    const [from, to] = MOVES[action];
    if (from && a.status !== from) return { status: 409, body: { error: '帳號狀態已改變，請重新整理', code: 'wrong_status', status: a.status } };
    if (action === 'reject') { st.accounts = st.accounts.filter(x => x !== a); return { body: { ok: true, deleted: true } }; }
    if (action === 'reset-password') {
      const temp = `tmp${st.temps.length}abcdefghjkmn`.slice(0, 16);
      st.temps.push(temp);
      return { body: { ok: true, photographer: pub(a), temp_password: temp } };
    }
    a.status = to;
    if (action === 'approve') a.approved_at = '2026-10-08T03:00:00.000Z';
    return { body: { ok: true, photographer: pub(a) } };
  }
  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/api/operator/photographers**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const h = await req.allHeaders();
      st.calls.push({ method: req.method(), path: u.pathname, auth: h['authorization'] || null });
      if ((h['authorization'] || null) !== `Bearer ${operatorToken}`)
        return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Unauthorized' }) });
      const res = handle(req.method(), u.pathname);
      route.fulfill({ status: res.status || 200, contentType: 'application/json', body: JSON.stringify(res.body) });
    });
  };
  return { st, attach };
}

const XSS_NAME = '<img src=x onerror="window.__xss=1">小安';
const ACCOUNTS = () => [
  { id: 'p-pend-a', email: 'a@example.com', display_name: XSS_NAME, studio_note: '安安工作室\nhttps://ann.example', status: 'pending', created_at: '2026-10-07T01:00:00.000Z' },
  { id: 'p-pend-b', email: 'b@example.com', display_name: '小北', studio_note: null, status: 'pending', created_at: '2026-10-06T01:00:00.000Z' },
  { id: 'p-act-c', email: 'c@example.com', display_name: '小晴', studio_note: '晴天婚紗', status: 'active', created_at: '2026-10-01T01:00:00.000Z', approved_at: '2026-10-02T01:00:00.000Z', last_login_at: '2026-10-05T01:00:00.000Z' },
  { id: 'p-sus-d', email: 'd@example.com', display_name: '小冬', studio_note: '', status: 'suspended', created_at: '2026-09-20T01:00:00.000Z', approved_at: '2026-09-21T01:00:00.000Z' },
];
const CLIP = `(${OP_SEED.toString()})();
  window.__clip = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { window.__clip.push(t); } } });`;
const both = (...fakes) => async page => { for (const f of fakes) await f.attach(page); };
const row = id => `#ph-list .ph-row[data-photographer-id="${id}"]`;
const groupOf = (page, id) => page.$eval(row(id), e => e.closest('.ph-group').dataset.group).catch(() => null);
const buttons = (page, id) => page.$$eval(`${row(id)} button[data-action]`, bs => bs.map(b => `${b.dataset.action}:${b.textContent}`)).catch(() => []);

{
  const o = ordersFake({ platform: [clone(PLAT_ALBUM)], products: [] });
  const f = photographersFake({ accounts: ACCOUNTS() });
  await suite('operator photographers — 待審核清單、紅點數字、核准／拒絕／停用／恢復、重設密碼只顯示一次',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const dialogs = [];
      let answer = true;
      page.on('dialog', d => { dialogs.push(d.message()); answer ? d.accept() : d.dismiss(); });
      await page.waitForSelector(row('p-pend-a'), { timeout: 5000 });

      ok('the list was read with the operator token from /api/operator/photographers',
        f.st.calls.some(c => c.method === 'GET' && c.path === '/api/operator/photographers' && c.auth === 'Bearer op'), JSON.stringify(f.st.calls));
      ok('the pending badge shows 2 and is visible (computed display)', (await T(page, '#ph-badge')) === '2' && (await disp(page, '#ph-badge')) !== 'none');
      ok('the badge sits in the panel title', await page.$eval('#ph-badge', e => e.parentElement.tagName === 'H2' && e.parentElement.textContent.includes('攝影師帳號')));
      ok('pending rows are in the 待審核 group with 核准 / 拒絕', (await groupOf(page, 'p-pend-a')) === 'pending' && (await groupOf(page, 'p-pend-b')) === 'pending' &&
        JSON.stringify(await buttons(page, 'p-pend-a')) === JSON.stringify(['approve:核准', 'reject:拒絕']), JSON.stringify(await buttons(page, 'p-pend-a')));
      ok('an active row is in 使用中 with 停用 / 重設密碼', (await groupOf(page, 'p-act-c')) === 'active' &&
        JSON.stringify(await buttons(page, 'p-act-c')) === JSON.stringify(['suspend:停用', 'reset-password:重設密碼']));
      ok('a suspended row is in 已停用 with 恢復 / 重設密碼', (await groupOf(page, 'p-sus-d')) === 'suspended' &&
        JSON.stringify(await buttons(page, 'p-sus-d')) === JSON.stringify(['unsuspend:恢復', 'reset-password:重設密碼']));
      ok('groups are in the order 待審核, 使用中, 已停用', (await page.$$eval('#ph-list .ph-group', gs => gs.map(g => g.dataset.group).join())) === 'pending,active,suspended');
      ok('pending rows are newest first', (await page.$$eval('[data-group="pending"] .ph-row', rs => rs.map(r => r.dataset.photographerId).join())) === 'p-pend-a,p-pend-b');
      // user data goes in as text
      ok('a display name with markup is shown as text: no <img> in the list, no script ran',
        (await page.$('#ph-list img')) === null && (await page.evaluate(() => window.__xss)) === undefined &&
        (await page.textContent(`${row('p-pend-a')} .ph-name`)) === XSS_NAME);
      ok('email, studio note and dates are shown', (await page.textContent(row('p-pend-a'))).includes('a@example.com') &&
        (await page.textContent(`${row('p-pend-a')} .ph-note`)) === '安安工作室\nhttps://ann.example' &&
        (await page.textContent(row('p-act-c'))).includes('最近登入 2026-10-05') && (await page.textContent(row('p-pend-b'))).includes('尚未登入'));
      ok('an empty studio note adds no note line', (await page.$(`${row('p-pend-b')} .ph-note`)) === null && (await page.$(`${row('p-sus-d')} .ph-note`)) === null);
      ok('the temp password box is hidden at first (computed display)', (await disp(page, '#ph-temp')) === 'none');

      // 核准
      await page.click(`${row('p-pend-b')} button[data-action="approve"]`);
      await waitText(page, '#ph-ok', t => t.includes('已核准'));
      ok('核准 posts approve and the row moves to 使用中; the badge drops to 1',
        f.st.calls.some(c => c.method === 'POST' && c.path === '/api/operator/photographers/p-pend-b/approve' && c.auth === 'Bearer op') &&
        (await groupOf(page, 'p-pend-b')) === 'active' && (await T(page, '#ph-badge')) === '1');
      ok('核准 asks no confirmation', dialogs.length === 0, JSON.stringify(dialogs));

      // 拒絕, dismissed first
      answer = false;
      const before = f.st.calls.length;
      await page.click(`${row('p-pend-a')} button[data-action="reject"]`);
      await page.waitForTimeout(200);
      ok('拒絕 asks first, naming the account; dismissing sends nothing', dialogs.length === 1 && dialogs[0].includes('a@example.com') && f.st.calls.length === before && (await page.$(row('p-pend-a'))) !== null, JSON.stringify(dialogs));
      answer = true;
      await page.click(`${row('p-pend-a')} button[data-action="reject"]`);
      await waitText(page, '#ph-ok', t => t.includes('已拒絕'));
      ok('拒絕 confirmed: the row is gone', (await page.$(row('p-pend-a'))) === null && f.st.calls.some(c => c.path === '/api/operator/photographers/p-pend-a/reject'));
      ok('no pending left: the badge is hidden (computed display) and the 待審核 group is gone',
        (await disp(page, '#ph-badge')) === 'none' && (await page.$('[data-group="pending"]')) === null);

      // 停用 / 恢復
      await page.click(`${row('p-act-c')} button[data-action="suspend"]`);
      await waitText(page, '#ph-ok', t => t.includes('已停用'));
      ok('停用 (confirmed) moves the row to 已停用', (await groupOf(page, 'p-act-c')) === 'suspended' && dialogs.at(-1).includes('登出'));
      await page.click(`${row('p-sus-d')} button[data-action="unsuspend"]`);
      await waitText(page, '#ph-ok', t => t.includes('已恢復'));
      ok('恢復 moves the row to 使用中 without a confirmation', (await groupOf(page, 'p-sus-d')) === 'active' && !dialogs.at(-1).includes('小冬'));

      // 重設密碼
      await page.click(`${row('p-sus-d')} button[data-action="reset-password"]`);
      await page.waitForSelector('#ph-temp:not([hidden])', { timeout: 4000 });
      const temp = f.st.temps[0];
      ok('重設密碼 (confirmed) shows the temp password in the box (computed display), naming whose it is',
        (await disp(page, '#ph-temp')) !== 'none' && (await page.inputValue('#ph-temp-pw')) === temp && (await T(page, '#ph-temp-who')).includes('d@example.com'), temp);
      ok('the box is read-only', (await page.getAttribute('#ph-temp-pw', 'readonly')) !== null);
      ok('the temp password is nowhere but the box: not in the list, not in storage',
        !(await page.textContent('#ph-list')).includes(temp) &&
        !(await page.evaluate(t => Object.keys(localStorage).some(k => localStorage.getItem(k).includes(t)) || Object.keys(sessionStorage).some(k => sessionStorage.getItem(k).includes(t)), temp)));
      await page.click('#ph-temp-copy');
      await waitText(page, '#ph-ok', t => t.includes('已複製'));
      ok('複製 puts exactly the temp password on the clipboard', JSON.stringify(await page.evaluate(() => window.__clip)) === JSON.stringify([temp]));
      await page.click('#ph-temp-close');
      ok('關閉 hides the box and clears the value', (await disp(page, '#ph-temp')) === 'none' && (await page.inputValue('#ph-temp-pw')) === '');

      // a race lost on the Worker: 409 is said in words, the list re-read
      f.st.inject = (method, path) => (path.endsWith('/p-pend-b/suspend')
        ? { status: 409, body: { error: '帳號狀態已改變，請重新整理', code: 'wrong_status', status: 'suspended' } } : null);
      const reads = f.st.calls.filter(c => c.method === 'GET').length;
      await page.click(`${row('p-pend-b')} button[data-action="suspend"]`);
      await waitText(page, '#ph-err', t => t.includes('帳號狀態已改變'));
      await page.waitForTimeout(200);
      ok('a 409 shows the Worker’s sentence and re-reads the list', f.st.calls.filter(c => c.method === 'GET').length > reads);
      f.st.inject = null;

      // the temp box does not survive signing out
      await page.click(`${row('p-pend-b')} button[data-action="reset-password"]`);
      await page.waitForSelector('#ph-temp:not([hidden])', { timeout: 4000 });
      await page.click('#op-logout');
      ok('登出 clears the temp password and the list', (await page.inputValue('#ph-temp-pw')) === '' && (await page.$('#ph-list .ph-row')) === null &&
        (await page.evaluate(k => localStorage.getItem(k), OP_KEY)) === null);
      ok('every call carried the operator token, none went to /api/admin', f.st.calls.every(c => c.auth === 'Bearer op') && !o.st.calls.some(c => c.path.startsWith('/api/admin')));
      return out;
    },
    { before: both(o, f), initScript: CLIP });
}

{
  const o = ordersFake({ platform: [clone(PLAT_ALBUM)], products: [] });
  const f = photographersFake({ accounts: ACCOUNTS() });
  await suite('operator photographers — 手機：按鈕至少 44px、沒有橫向捲動、臨時密碼框可用',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      page.on('dialog', d => d.accept());
      await page.waitForSelector(row('p-pend-a'), { timeout: 5000 });
      const sizes = await page.$$eval('#ph-list button[data-action]', bs => bs.map(b => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
      ok('there are action buttons to measure (4 rows × 2)', sizes.length === 8, JSON.stringify(sizes));
      ok('every action button is at least 44px tall and 44px wide', sizes.every(([w, h]) => h >= 44 && w >= 44), JSON.stringify(sizes));
      ok('the page does not scroll sideways', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      ok('a long email wraps inside the row', await page.$$eval('#ph-list .ph-row', rs => rs.every(r => r.getBoundingClientRect().right <= window.innerWidth + 0.5)));
      await page.click(`${row('p-act-c')} button[data-action="reset-password"]`);
      await page.waitForSelector('#ph-temp:not([hidden])', { timeout: 4000 });
      const temp = await page.$$eval('#ph-temp .btn, #ph-temp-pw', es => es.map(e => Math.round(e.getBoundingClientRect().height)));
      ok('the temp box’s field and buttons are at least 44px tall', temp.length === 3 && temp.every(h => h >= 44), JSON.stringify(temp));
      ok('the temp password font is 16px (iOS does not zoom)', (await page.$eval('#ph-temp-pw', e => getComputedStyle(e).fontSize)) === '16px');
      ok('still no sideways scroll with the box open', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      return out;
    },
    { before: both(o, f), initScript: CLIP, contextOptions: MOBILE });
}

{
  const o = ordersFake({ platform: [clone(PLAT_ALBUM)], products: [] });
  const f = photographersFake({ accounts: ACCOUNTS(), unavailable: true });
  await suite('operator photographers — 還沒跑 migration：顯示尚未啟用，平台商品照常',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-list .prod-row', { timeout: 5000 });
      await waitText(page, '#ph-list', t => t.includes('尚未啟用'));
      ok('the panel says the feature is not enabled yet (the Worker’s sentence)', (await T(page, '#ph-list')).includes('攝影師帳號功能尚未啟用'));
      ok('no badge', (await disp(page, '#ph-badge')) === 'none');
      ok('the platform products still render', (await page.$$('#op-list .prod-row')).length === 1);
      return out;
    },
    { before: both(o, f), initScript: OP_SEED });
}

{
  const o = ordersFake({ platform: [clone(PLAT_ALBUM)], products: [] });
  const f = photographersFake({ accounts: [] });
  await suite('operator photographers — 沒有任何申請：一句提示、沒有紅點',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#op-list .prod-row', { timeout: 5000 });
      await waitText(page, '#ph-list', t => t.includes('還沒有攝影師申請'));
      ok('the empty list says so', (await T(page, '#ph-list')).includes('還沒有攝影師申請') && (await page.$('#ph-list .ph-row')) === null);
      ok('no badge (computed display)', (await disp(page, '#ph-badge')) === 'none');
      return out;
    },
    { before: both(o, f), initScript: OP_SEED });
}

}
