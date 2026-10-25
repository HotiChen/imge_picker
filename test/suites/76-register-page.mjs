// Browser suites: register.html, the invited photographer's registration page (phone-first, cream theme,
// no link from any public page). Registered by test/run.mjs in file-name order; see test/README.md.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { base, suite } from '../lib/harness.mjs';
import { MOBILE, ROOT } from '../lib/env.mjs';
import { photographerFake } from '../lib/photographer-fake.mjs';

export default async function register() {
  const EMAIL = 'friend@example.com';
  const PW = 'a-long-password-1';
  const fill = async (page, f = {}) => {
    await page.fill('#reg-email', f.email ?? EMAIL);
    await page.fill('#reg-name', f.name ?? '小安');
    await page.fill('#reg-password', f.password ?? PW);
    await page.fill('#reg-code', f.code ?? '12345678');
  };
  const submit = async page => { await page.click('#reg-submit'); };
  const errText = page => page.textContent('#reg-err');
  const waitErr = (page, pred) => page.waitForFunction(src => { const t = document.getElementById('reg-err').textContent; return !!t && eval(`(${src})`)(t); }, pred.toString(), { timeout: 4000 });

  {
    const f = photographerFake({ invites: [{ email: EMAIL, code: '12345678' }] });
    await suite('register page — layout: fields, hints, notice, cream theme, phone width (390px)',
      `${base}/register.html`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        const attr = (sel, a) => page.getAttribute(sel, a);
        ok('email, display name, password and code fields exist', (await page.$$('#reg-email, #reg-name, #reg-password, #reg-code')).length === 4);
        ok('email is type=email, the code is numeric (inputmode) with a 8-digit limit', (await attr('#reg-email', 'type')) === 'email' &&
          (await attr('#reg-code', 'inputmode')) === 'numeric' && (await attr('#reg-code', 'maxlength')) === '8');
        ok('the password field is new-password and has a show/hide eye', (await attr('#reg-password', 'autocomplete')) === 'new-password' && (await page.$('.pw-eye')) !== null);
        ok('the 10–200 characters rule is on the page', (await page.textContent('body')).includes('10–200'));
        ok('the retention notice is shown, the old 180-day wording is gone', (await page.textContent('body')).includes('照片不會因保存期限自動刪除；毛片是否刪除由攝影師設定') && !(await page.textContent('body')).includes('180 天'));
        ok('the page tells crawlers to stay away', (await page.$('meta[name="robots"][content*="noindex"]')) !== null);
        ok('cream theme: --bg is #fff8ee and the body paints it', (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())) === '#fff8ee' &&
          (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(255, 248, 238)');
        ok('no sideways scroll at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        const sizes = await page.$$eval('#reg-form input, #reg-submit', es => es.map(e => Math.round(e.getBoundingClientRect().height)));
        ok('every field and the button are >= 44px tall (phone)', sizes.length === 5 && sizes.every(h => h >= 44), JSON.stringify(sizes));
        const fonts = await page.$$eval('#reg-form input', es => es.map(e => parseFloat(getComputedStyle(e).fontSize)));
        ok('inputs are >= 16px (iOS does not zoom in)', fonts.every(s => s >= 16), JSON.stringify(fonts));
        ok('nothing was sent just by opening the page', f.st.calls.length === 0);
        return out;
      },
      { before: f.attach, contextOptions: MOBILE });
  }

  {
    const f = photographerFake({ invites: [{ email: EMAIL, code: '12345678' }] });
    await suite('register page — success: 201 stores the session like the login flow and lands on the dashboard',
      `${base}/register.html`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await fill(page, { email: '  Friend@Example.com ' });
        await submit(page);
        await page.waitForURL('**/dashboard.html', { timeout: 5000 });
        const call = f.st.calls.find(c => c.path === '/api/photographer/register-invite');
        const sent = call ? JSON.parse(call.body) : {};
        ok('POST /api/photographer/register-invite with email, display_name, password and invite_code',
          !!call && call.method === 'POST' && sent.display_name === '小安' && sent.password === PW && sent.invite_code === '12345678' && sent.email.trim().toLowerCase() === EMAIL, call && call.body);
        const s = await page.evaluate(() => ({ t: sessionStorage.getItem('studio_token'), r: JSON.parse(sessionStorage.getItem('studio_session') || 'null'), ls: JSON.stringify(localStorage), all: JSON.stringify(sessionStorage) }));
        const realToken = [...f.st.sessions.keys()][0];
        ok('the token is in sessionStorage.studio_token (as the login flow stores it) and marked as a session', s.t === realToken && s.r && s.r.t === realToken, JSON.stringify(s));
        ok('no must-change flag for a normal account', s.r && s.r.must === false);
        ok('the password is nowhere in storage, the token is not in localStorage', !s.all.includes(PW) && !s.ls.includes(PW) && !s.ls.includes(realToken), s.ls);
        return out;
      },
      { before: f.attach });
  }

  {
    const f = photographerFake({ invites: [{ email: EMAIL, code: '12345678' }] });
    await suite('register page — errors: invalid_invite is one uniform sentence; closed, throttle, field and network errors have their own',
      `${base}/register.html`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        const reg = () => f.st.calls.filter(c => c.path === '/api/photographer/register-invite').length;

        // client-side checks come before any request
        await fill(page, { code: '1234' });
        await submit(page);
        ok('a short code is refused on the page, nothing sent', /8/.test(await errText(page)) && reg() === 0, await errText(page));
        await fill(page, { password: 'short' });
        await submit(page);
        ok('a short password is refused on the page (10–200), nothing sent', (await errText(page)).includes('10') && reg() === 0, await errText(page));
        await fill(page, { email: 'not-an-email' });
        await submit(page);
        ok('a bad email is refused on the page, nothing sent', (await errText(page)).includes('Email') && reg() === 0, await errText(page));
        await fill(page, { name: '   ' });
        await submit(page);
        ok('an empty display name is refused on the page, nothing sent', reg() === 0 && (await errText(page)).length > 0);

        // wrong code, and another email with a right code: the same sentence
        await fill(page, { code: '00000000' });
        await submit(page);
        await waitErr(page, t => t.length > 0);
        const wrong = await errText(page);
        await fill(page, { email: 'other@example.com' });
        await submit(page);
        await page.waitForTimeout(400);
        const other = await errText(page);
        ok('a wrong code says 邀請碼不正確或已失效', wrong.includes('邀請碼不正確或已失效'), wrong);
        ok('the right code with another email gets the identical sentence (no hint which part was wrong)', other === wrong, other);
        ok('the inputs stay so the person can retry; the page did not navigate', (await page.inputValue('#reg-name')) === '小安' && page.url().endsWith('/register.html'));

        // closed
        f.st.closed = true;
        await fill(page);
        await submit(page);
        await waitErr(page, t => t.includes('尚未開放註冊'));
        ok('403 registration_closed -> 目前尚未開放註冊', (await errText(page)).includes('目前尚未開放註冊'));
        f.st.closed = false;

        // throttle
        f.st.failures = 10;
        await fill(page);
        await submit(page);
        await waitErr(page, t => t.includes('稍後') || t.includes('15 分鐘'));
        ok('429 -> try again later, with the wait', /稍後|15 分鐘/.test(await errText(page)));
        f.st.failures = 0;

        // network
        await page.route('**/api/photographer/register-invite', r => r.abort());
        await fill(page);
        await submit(page);
        await waitErr(page, t => t.includes('連線'));
        ok('a network failure says so', (await errText(page)).includes('連線'));
        await page.unroute('**/api/photographer/register-invite');

        // the button is a real lock while a request is out (no double submit)
        let hits = 0;
        await page.route('**/api/photographer/register-invite', async r => { hits++; await new Promise(res => setTimeout(res, 400)); r.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: 'x', code: 'invalid_invite' }) }); });
        await fill(page);
        await page.click('#reg-submit');
        const disabled = await page.$eval('#reg-submit', b => b.disabled);
        await page.click('#reg-submit', { force: true, timeout: 500 }).catch(() => {});
        await page.waitForTimeout(700);
        ok('while the request is out the button is disabled and a second tap sends nothing', disabled && hits === 1, `disabled=${disabled} hits=${hits}`);
        ok('after a refusal the button works again', !(await page.$eval('#reg-submit', b => b.disabled)));
        ok('nothing was stored in any failure', (await page.evaluate(() => sessionStorage.getItem('studio_token'))) === null);
        return out;
      },
      { before: f.attach });
  }

  {
    const f = photographerFake({ invites: [{ email: EMAIL, code: '12345678' }] });
    await suite('register page — the password eye shows and hides what was typed',
      `${base}/register.html`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.fill('#reg-password', PW);
        ok('hidden at first', (await page.getAttribute('#reg-password', 'type')) === 'password');
        await page.click('.pw-eye');
        ok('shown after a tap', (await page.getAttribute('#reg-password', 'type')) === 'text');
        await page.click('.pw-eye');
        ok('hidden after a second tap', (await page.getAttribute('#reg-password', 'type')) === 'password');
        return out;
      },
      { before: f.attach });
  }

  // No public page links to register.html: it is reached only by the URL given to a friend.
  await suite('register page — no page of the site links to it',
    `${base}/register.html`,
    async () => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const files = [];
      const walk = dir => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (['node_modules', '.git', '.claude', 'test', 'docs', 'worker'].includes(e.name)) continue;
          const p = join(dir, e.name);
          if (e.isDirectory()) walk(p); else if (/\.(html|js|css)$/.test(e.name)) files.push(p);
        }
      };
      walk(ROOT);
      ok('the scan saw the site (floor: 30 files)', files.length >= 30, String(files.length));
      const hits = files.filter(p => !p.endsWith('register.html') && !p.endsWith('operator.html') && /register\.html/.test(readFileSync(p, 'utf8')));
      ok('no file other than register.html and the operator page names register.html', hits.length === 0, hits.join(', '));
      ok('the operator page does name it (it builds the invite message)', /register\.html/.test(readFileSync(join(ROOT, 'operator.html'), 'utf8')));
      return out;
    });
}
