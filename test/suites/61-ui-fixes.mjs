// Browser suites: small UI fixes from the 2026-10 review (U3 failed client delete, U6 titles and brand; each fix adds its own block here). Registered by test/run.mjs in file-name
// order; see test/README.md.
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { base, stats, suite, ONLY } from '../lib/harness.mjs';
import { ROOT } from '../lib/env.mjs';
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
