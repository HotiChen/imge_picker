// Browser suites: small UI fixes from the 2026-10 review (failed client delete, titles and brand, side menu aria, focus ring, phone button size, 重試 on failed reads).
// Each fix adds its own block here. Registered by test/run.mjs in file-name order; see test/README.md.
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { base, stats, suite, ONLY } from '../lib/harness.mjs';
import { ROOT, MOBILE } from '../lib/env.mjs';
import { ADMIN, ADMIN_PLAIN, adminMock, SHOOT_CLIENTS } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { dashSettingsMock, SEED_TOKEN_ALWAYS, SEED_TOKEN } from '../lib/dashboard-mocks.mjs';
import { ordersFake } from '../lib/orders-fake.mjs';

export default async function register() {

// U3: deleting a client that fails says why next to the button; no alert(), and the button works again
{
  const m = adminMock({ clients: SHOOT_CLIENTS });
  await suite('admin 客戶 — a failed 刪除 shows the reason in the row (no alert) and the button is usable again',
    `${base}/admin.html#clients`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const dialogs = [];
      page.on('dialog', d => { dialogs.push({ type: d.type(), msg: d.message() }); d.accept(); });
      // registered after attach, so it answers first
      await page.route(`**/api/admin/clients/${SHOOT_CLIENTS[0].id}`, async route => {
        if (route.request().method() === 'DELETE') return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"db down"}' });
        return route.fallback();
      });
      await page.waitForSelector('.delete-btn', { timeout: 5000 });
      await page.locator('.delete-btn').first().click();
      await page.waitForSelector('.delete-err', { timeout: 3000 });
      const err = await page.$eval('.delete-err', e => e.textContent);
      ok('the reason is shown in the row', err.includes('刪除失敗') && err.includes('db down'), err);
      ok('it is announced (role=alert)', await page.$eval('.delete-err', e => e.getAttribute('role') === 'alert'));
      ok('the only dialog was the confirm: no alert()', dialogs.length === 1 && dialogs[0].type === 'confirm', JSON.stringify(dialogs));
      ok('the delete button is enabled again', await page.locator('.delete-btn').first().isEnabled());
      ok('and the row is still there', (await page.locator('.delete-btn').count()) === SHOOT_CLIENTS.length);
      // a second failure reuses the same message element
      await page.locator('.delete-btn').first().click();
      await page.waitForTimeout(300);
      ok('a second failure does not stack messages', (await page.locator('.delete-err').count()) === 1);
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// U11: the side menu is a labelled landmark and says which page is current
{
  const m = adminMock({ clients: SHOOT_CLIENTS });
  await suite('side menu — a labelled nav landmark, and aria-current on the current page only (follows the tab)',
    `${base}/admin.html#projects`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const st = () => page.evaluate(() => ({
        label: document.querySelector('nav.side-nav-list')?.getAttribute('aria-label'),
        current: [...document.querySelectorAll('.side-nav-item[aria-current]')].map(a => `${a.textContent.trim()}=${a.getAttribute('aria-current')}`),
        active: [...document.querySelectorAll('.side-nav-item.active')].map(a => a.textContent.trim()),
      }));
      await page.waitForSelector('.side-nav-item.active', { timeout: 5000 });
      let s = await st();
      ok('the nav is labelled 主選單', s.label === '主選單', JSON.stringify(s));
      ok('aria-current="page" is on the active item and nowhere else', JSON.stringify(s.current) === '["選片專案=page"]' && JSON.stringify(s.active) === '["選片專案"]', JSON.stringify(s));
      await page.click('.side-nav-item[data-nav="clients"]');
      await page.waitForFunction(() => document.querySelector('.side-nav-item.active')?.textContent.trim() === '客戶', null, { timeout: 3000 });
      s = await st();
      ok('switching tab moves aria-current with it', JSON.stringify(s.current) === '["客戶=page"]', JSON.stringify(s));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

// U11: a focused text field shows a ring, not only an orange border (client-login, settings)
for (const [name, url, sel, mk] of [
  ['client-login', `${base}/client-login.html`, '.field', () => ({})],
  ['settings', `${base}/settings.html`, '.field', () => { const m = adminMock(); return { before: m.attach, initScript: ADMIN }; }],
]) {
  await suite(`focus ring — a focused ${name} field gets a visible ring`,
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector(sel, { state: 'visible', timeout: 5000 });
      const before = await page.$eval(sel, e => getComputedStyle(e).boxShadow);
      await page.focus(sel);
      const after = await page.$eval(sel, e => getComputedStyle(e).boxShadow);
      ok('no ring before focus', before === 'none', before);
      ok('a ring (box-shadow) once focused', after !== 'none' && /3px/.test(after), after);
      return out;
    },
    mk());
}

// U9: on a phone the project detail's buttons are thumb-sized (>= 44px), not 26px chips
{
  const m = pickFakeWorker({ projectId: 'proj-A', title: '王小明 婚紗', phase: 'picking', projectType: '婚紗', folders: ['shoot/毛片/'] });
  await suite('admin 專案詳情（手機）— the detail buttons are at least 44px tall',
    `${base}/admin.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('[data-open-project]', { timeout: 5000 });
      await page.click('[data-open-project]');
      await page.waitForSelector('#pd-reset-seat-btn', { timeout: 5000 });
      await page.waitForTimeout(300);
      const hs = await page.$$eval('#project-detail-body .btn', els => els
        .filter(e => e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none')
        .map(e => ({ id: e.id || e.textContent.trim().slice(0, 12), h: Math.round(e.getBoundingClientRect().height) })));
      ok('a floor: at least 4 visible buttons were measured', hs.length >= 4, String(hs.length));
      const small = hs.filter(b => b.h < 44);
      ok('every one is >= 44px tall', small.length === 0, JSON.stringify(small));
      return out;
    },
    { before: m.attach, initScript: ADMIN_PLAIN, contextOptions: MOBILE });
}

// U13: a failed read on the dashboard says so and offers 重試, which loads the data
{
  const m = dashSettingsMock({ projects: [{ id: 'p1', title: '海邊系列', phase: 'retouching', delivered_at: null }] });
  let failNext = 2; // the first stats read and the first projects read
  await suite('儀表板 — a failed read shows 讀取失敗 with 重試; 重試 loads it',
    `${base}/dashboard.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#recent-projects .empty-retry', { timeout: 5000 });
      await page.waitForSelector('#stat-chart .empty-retry', { timeout: 5000 });
      ok('both parts show 讀取失敗 and a 重試 button', (await page.locator('.empty-retry').count()) === 2);
      await page.locator('#recent-projects .empty-retry').click();
      await page.waitForSelector('#recent-projects .recent-row', { timeout: 3000 });
      ok('重試 on the project list loads it', (await page.textContent('#recent-projects')).includes('海邊系列'));
      ok('and the other part still offers its own 重試', (await page.locator('#stat-chart .empty-retry').count()) === 1);
      await page.locator('#stat-chart .empty-retry').click();
      await page.waitForFunction(() => !document.querySelector('#stat-chart .empty-retry'), null, { timeout: 3000 });
      ok('重試 on the stats part clears its failure', (await page.locator('.empty-retry').count()) === 0);
      return out;
    },
    { before: async page => {
        await m.attach(page);
        // registered after attach, so it answers first: the first read of each part fails
        await page.route(/\/api\/admin\/(stats|projects)(\?|$)/, route => {
          if (failNext > 0) { failNext--; return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }); }
          return route.fallback();
        });
      }, initScript: SEED_TOKEN_ALWAYS });
}

// U13: a failed orders read shows the reason and offers 重試
{
  const m = dashSettingsMock();
  const o = ordersFake({ products: [], titles: { 'proj-1': '海邊系列' } });
  o.st.addOrder({ id: 'o1', project_id: 'proj-1', status: 'confirmed', items: [{ name: '相本書', unit_price: 1234, qty: 1 }] });
  let fail = true;
  await suite('訂單頁 — a failed read shows 讀取失敗 with 重試; 重試 loads the list',
    `${base}/orders.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#order-list .empty-retry', { timeout: 5000 });
      ok('the list says 讀取失敗 and the error line says why', (await page.textContent('#order-list')).includes('讀取失敗') && (await page.textContent('#orders-err')).length > 0);
      fail = false;
      await page.locator('#order-list .empty-retry').click();
      await page.waitForSelector('.ord-row', { timeout: 3000 });
      ok('重試 loads the order and clears the failure', (await page.locator('.empty-retry').count()) === 0 && (await page.locator('.ord-row').count()) === 1);
      return out;
    },
    { before: async p => {
        await m.attach(p); await o.attach(p);
        await p.route(/\/api\/admin\/orders(\?|$)/, route => fail
          ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' })
          : route.fallback());
      }, initScript: SEED_TOKEN });
}

// Guest 成果相簿 lightbox: a loading ring while the big file is on its way, gone when it lands or fails
{
  const files = Array.from({ length: 6 }, (_, i) => `shoot/精修/f${String(i + 1).padStart(3, '0')}.jpg`);
  const m = pickFakeWorker({
    ownerName: 'Zoe', ownerKey: 'ZOE-KEY', phase: 'retouching', folders: ['shoot/毛片/'], finalFolders: ['shoot/精修/'],
    deliveredAt: '2026-09-20T00:00:00.000Z', pickFiles: ['shoot/毛片/a.jpg', ...files], title: '婚禮精修',
    studio: { name: '光影工作室', booking_url: null, has_logo: true },
    imageDelay: (key, w) => (w === '400' ? 0 : 900) });
  await suite('成果相簿燈箱（手機）— a loading ring until the big file is in; a failed file clears it and says so',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const ring = () => page.evaluate(() => {
        const r = document.getElementById('fgLbLoading');
        return { on: !!r && getComputedStyle(r).display !== 'none' && r.getBoundingClientRect().width > 0, shown: document.getElementById('fgLbImg')?.classList.contains('on'), msg: !document.getElementById('fgLbMsg')?.hidden };
      });
      // f003's big file never arrives
      await page.route(/f003\.jpg\?w=(1200|1600)/, r => r.abort());
      await page.waitForSelector('.fg-tile', { timeout: 5000 });
      await page.locator('.fg-tile').first().click();
      await page.waitForSelector('#fgLightbox', { timeout: 3000 });
      await page.waitForTimeout(200);
      let s = await ring();
      ok('while the big file is on its way the ring is visible and the photo is not', s.on && !s.shown && !s.msg, JSON.stringify(s));
      await page.waitForFunction(() => document.getElementById('fgLbImg')?.classList.contains('on'), null, { timeout: 4000 });
      s = await ring();
      ok('once it is in the ring is gone', !s.on && s.shown, JSON.stringify(s));
      await page.click('#fgLbNext');
      await page.waitForTimeout(200);
      s = await ring();
      ok('swiping on shows the ring again at once', s.on && !s.shown, JSON.stringify(s));
      await page.waitForFunction(() => document.getElementById('fgLbImg')?.classList.contains('on'), null, { timeout: 4000 });
      await page.click('#fgLbNext');
      await page.waitForFunction(() => !document.getElementById('fgLbMsg')?.hidden, null, { timeout: 5000 });
      s = await ring();
      ok('a file that fails clears the ring and shows the message', !s.on && s.msg && !s.shown, JSON.stringify(s));
      return out;
    },
    { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: MOBILE });
}

// U6: one title shape and one brand across the photographer pages ("<page> — Studio", wordmark STUDIO)
const U6 = 'page titles and brand — the photographer pages say "<page> — Studio" and STUDIO, not five different names';
if (!ONLY || ONLY.split('|').some(t => t && U6.includes(t))) {
  console.log(`\n# ${U6}`);
  const PAGES = { 'admin.html': '選片專案', 'dashboard.html': '儀表板', 'orders.html': '訂單', 'settings.html': '設定', 'upload.html': '上傳照片', 'tutorial.html': '操作說明書', 'index.html': '選片' };
  const out = [];
  const ok = (n, c, d = '') => { if (!c) stats.failed++; out.push(`  ${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`); };
  for (const [file, name] of Object.entries(PAGES)) {
    const html = await readFile(join(ROOT, file), 'utf8');
    const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
    ok(`${file}: <title> is "${name} — Studio"`, title === `${name} — Studio`, title);
  }
  for (const file of ['admin.html', 'dashboard.html', 'orders.html', 'settings.html']) {
    const html = await readFile(join(ROOT, file), 'utf8');
    const brands = [...html.matchAll(/class="brand">([^<]*)</g)].map(m => m[1]);
    ok(`${file}: the wordmark is STUDIO (found ${brands.length})`, brands.length >= 1 && brands.every(b => b === 'STUDIO'), brands.join('|'));
  }
  const up = await readFile(join(ROOT, 'upload.html'), 'utf8');
  ok('upload.html: the header wordmark is STUDIO', />STUDIO<\/span>/.test(up) && !up.includes('Image Picker Studio'));
  console.log(out.join('\n'));
}
}
