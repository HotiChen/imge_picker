// Browser suites: small UI fixes from the 2026-10 review (U3 so far; each fix adds its own block here). Registered by test/run.mjs in file-name
// order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { ADMIN, adminMock, SHOOT_CLIENTS } from '../lib/auth-mocks.mjs';

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
}
