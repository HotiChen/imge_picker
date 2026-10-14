// Browser suites: the login overlay js/auth.js draws on upload.html offers email + password next to the studio password.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { photographerFake } from '../lib/photographer-fake.mjs';

export default async function register() {
  const ACCT = { id: 'ph-1', email: 'ann@example.com', password: 'ann-password-1', display_name: '小安', must_change: false };
  const FLAGGED = { id: 'ph-2', email: 'tmp@example.com', password: 'temp-password-1', display_name: '小暫', must_change: true };
  // whatever upload.html asks after sign-in, an empty folder list
  const quiet = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"folders":[]}' }));
  };
  const shown = (page, sel) => page.$eval(sel, e => e.getClientRects().length > 0);
  const store = page => page.evaluate(() => ({ t: sessionStorage.getItem('studio_token'), s: JSON.parse(sessionStorage.getItem('studio_session') || 'null') }));

  {
    const f = photographerFake({ accounts: [ACCT, FLAGGED] });
    await suite('upload login overlay — unified 帳號 + 密碼 form; an email account signs in, a flagged account goes to settings',
      `${base}/upload.html`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.waitForSelector('#auth-overlay', { timeout: 5000 });
        ok('the unified form shows 帳號 + 密碼 and no mode switch (83-unified-login.mjs asserts it in depth)', (await shown(page, '#auth-account')) && (await shown(page, '#auth-input')) && !(await page.$('#auth-mode-email')));
        await page.fill('#auth-account', ACCT.email);
        await page.fill('#auth-input', 'wrong-password-x');
        await page.click('#auth-btn');
        await page.waitForFunction(() => document.getElementById('auth-err').textContent.includes('帳號或密碼不正確'));
        ok('a wrong password shows the Worker’s sentence; the overlay stays; nothing stored', (await shown(page, '#auth-overlay')) && (await store(page)).t === null);

        await page.fill('#auth-input', ACCT.password);
        await page.click('#auth-btn');
        await page.waitForFunction(() => !document.getElementById('auth-overlay'));
        const s = await store(page);
        ok('a good login removes the overlay and stores the session token + its description', !!s.t && s.s && s.s.t === s.t && s.s.must === false, JSON.stringify(s));
        ok('upload.html now uses that token (CONFIG.PHOTOGRAPHER_TOKEN)', (await page.evaluate(() => CONFIG.PHOTOGRAPHER_TOKEN)) === s.t);
        return out;
      },
      { before: async page => { await quiet(page); await f.attach(page); } });
  }

  {
    const f = photographerFake({ accounts: [FLAGGED] });
    await suite('upload login overlay — a flagged account (must change password) is sent to settings.html',
      `${base}/upload.html`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.waitForSelector('#auth-overlay', { timeout: 5000 });
        await page.fill('#auth-account', FLAGGED.email);
        await page.fill('#auth-input', FLAGGED.password);
        await page.click('#auth-btn');
        await page.waitForURL('**/settings.html', { timeout: 5000 });
        const s = await store(page);
        ok('landed on settings.html with must: true stored', s.s && s.s.must === true && s.s.t === s.t, JSON.stringify(s));
        return out;
      },
      { before: async page => { await quiet(page); await f.attach(page); } });
  }
}
