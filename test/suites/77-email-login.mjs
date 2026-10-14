// Browser suites: photographer email + password login (home.html), must_change_password (everything but settings is
// closed until the password is changed), the change-password form in settings.html (swaps the stored token for the new
// one), and logout calling /api/photographer/logout. Tim's own token entry keeps working exactly as before.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { photographerFake, stubFabric } from '../lib/photographer-fake.mjs';
import { dashSettingsMock } from '../lib/dashboard-mocks.mjs';

export default async function register() {
  const ACCT = { id: 'ph-1', email: 'ann@example.com', password: 'ann-password-1', display_name: '小安', must_change: false };
  const FLAGGED = { id: 'ph-2', email: 'tmp@example.com', password: 'temp-password-1', display_name: '小暫', must_change: true };
  const NEWPW = 'a-brand-new-pass-9';
  const both = (...fakes) => async page => { await stubFabric(page); for (const f of fakes) await f.attach(page); };
  const store = page => page.evaluate(() => ({ t: sessionStorage.getItem('studio_token'), s: JSON.parse(sessionStorage.getItem('studio_session') || 'null'), all: JSON.stringify(sessionStorage), ls: JSON.stringify(localStorage) }));
  // a seed that runs once per tab (addInitScript re-runs on every navigation: a known false-pass shape)
  const seed = (token, must) => `if (!sessionStorage.getItem('__seeded')) { sessionStorage.setItem('__seeded', '1'); sessionStorage.setItem('studio_token', ${JSON.stringify(token)}); ${must === undefined ? '' : `sessionStorage.setItem('studio_session', JSON.stringify({ t: ${JSON.stringify(token)}, must: ${must} }));`} }`;
  const disp = (page, sel) => page.$eval(sel, e => getComputedStyle(e).display);
  // really on screen (an ancestor with display:none counts), unlike the element's own computed display
  const shown = (page, sel) => page.$eval(sel, e => e.getClientRects().length > 0);
  // one unified form now (no 改用 Email 登入 toggle): 帳號 + 密碼; the toggle's own behaviour is gone, see 83-unified-login.mjs
  const openEmailLogin = async page => { await page.click('#photographerLoginBtn'); };
  const fillLogin = async (page, email, pw) => { await page.fill('#loginAccountInput', email); await page.fill('#loginTokenInput', pw); await page.click('#loginSubmitBtn'); };

  {
    const f = photographerFake({ accounts: [ACCT] });
    await suite('email login — wrong password, throttle, network; then a good login stores the session and lands on the dashboard',
      `${base}/home.html`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        const errT = () => page.textContent('#loginErr');
        await openEmailLogin(page);

        await page.click('#loginSubmitBtn');
        ok('empty fields are refused on the page, nothing sent', (await errT()).length > 0 && f.st.calls.length === 0, await errT());

        await fillLogin(page, ACCT.email, 'wrong-password-x');
        await page.waitForFunction(() => document.getElementById('loginErr').textContent.length > 0);
        ok('wrong password shows the Worker’s one sentence (帳號或密碼不正確…) and nothing is stored', (await errT()).includes('帳號或密碼不正確') && (await store(page)).t === null, await errT());
        ok('the login call carried the typed email and password in the body, no Authorization', (() => {
          const c = f.st.calls.find(x => x.path === '/api/photographer/login');
          return !!c && c.method === 'POST' && JSON.parse(c.body).email === ACCT.email && JSON.parse(c.body).password === 'wrong-password-x' && c.auth === null;
        })());

        f.st.failures = 10;
        await fillLogin(page, ACCT.email, ACCT.password);
        await page.waitForFunction(() => document.getElementById('loginErr').textContent.includes('15'));
        ok('429 says to wait 15 minutes', (await errT()).includes('15 分鐘'), await errT());
        f.st.failures = 0;

        await page.route('**/api/photographer/login', r => r.abort());
        await fillLogin(page, ACCT.email, ACCT.password);
        await page.waitForFunction(() => document.getElementById('loginErr').textContent.includes('連線'));
        ok('a network failure says so', (await errT()).includes('連線'));
        await page.unroute('**/api/photographer/login');

        await fillLogin(page, `  ${ACCT.email.toUpperCase()} `, ACCT.password);
        await page.waitForURL('**/dashboard.html', { timeout: 5000 });
        const s = await store(page);
        const live = [...f.st.sessions.keys()];
        ok('the session token is in sessionStorage.studio_token and described as a session without the must flag', live.length === 1 && s.t === live[0] && s.s && s.s.t === live[0] && s.s.must === false, JSON.stringify(s));
        ok('the password is nowhere in storage and the token not in localStorage', !s.all.includes(ACCT.password) && !s.ls.includes(ACCT.password) && !s.ls.includes(live[0]));
        return out;
      },
      { before: f.attach });
  }

  {
    const f = photographerFake({ accounts: [FLAGGED] });
    const m = dashSettingsMock({ token: a => !!f.accountOf(a), gate: f.gate });
    await suite('must change password — login lands on settings, every other page sends the person back until it is changed',
      `${base}/home.html`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await openEmailLogin(page);
        await fillLogin(page, FLAGGED.email, FLAGGED.password);
        await page.waitForURL('**/settings.html', { timeout: 5000 });
        const s0 = await store(page);
        ok('the session is stored with must: true', s0.s && s0.s.must === true && s0.s.t === s0.t, JSON.stringify(s0));
        await page.waitForSelector('#acct-submit', { timeout: 4000 });
        ok('a banner says the password must be changed first', (await disp(page, '#acct-must')) !== 'none' && (await page.textContent('#acct-must')).includes('先修改密碼'));
        ok('the account form is visible: current / new / confirm', (await page.$$eval('#acct-current, #acct-new, #acct-new2', e => e.filter(x => getComputedStyle(x).display !== 'none').length)) === 3);
        // nothing else of the page is usable (and nothing else was requested: the Worker would answer 403)
        const visibleHeadings = await page.$$eval('main h2', hs => hs.filter(h => getComputedStyle(h).display !== 'none').map(h => h.textContent.trim()));
        ok('only the account section is visible on settings', visibleHeadings.length === 1 && visibleHeadings[0].includes('密碼'), JSON.stringify(visibleHeadings));
        ok('no other Worker route was called (the flagged session would get 403 there)', m.seen.filter(r => r.path.startsWith('/api/admin') || r.path.startsWith('/api/shares')).length === 0, JSON.stringify(m.seen.map(r => r.path)));
        const me = f.st.calls.find(c => c.path === '/api/photographer/me');
        ok('settings asked /api/photographer/me with the session token', !!me && me.auth === `Bearer ${s0.t}`);

        for (const dest of ['dashboard.html', 'admin.html', 'orders.html', 'upload.html', 'index.html?project=p1', 'book_editor/index.html', 'r2_designer/index.html']) {
          await page.goto(`${base}/${dest}`, { waitUntil: 'load' });
          await page.waitForURL('**/settings.html', { timeout: 4000 }).catch(() => {});
          ok(`${dest} sends a flagged session back to settings.html`, /\/settings\.html$/.test(new URL(page.url()).pathname), page.url());
        }

        // local checks first, nothing sent
        const cp = () => f.st.calls.filter(c => c.path === '/api/photographer/change-password').length;
        const errT = () => page.textContent('#acct-err');
        const setPw = async (cur, n1, n2) => { await page.fill('#acct-current', cur); await page.fill('#acct-new', n1); await page.fill('#acct-new2', n2); await page.click('#acct-submit'); };
        await setPw(FLAGGED.password, 'short', 'short');
        ok('a short new password is refused on the page (10–200)', (await errT()).includes('10') && cp() === 0, await errT());
        await setPw(FLAGGED.password, NEWPW, NEWPW + 'x');
        ok('a confirmation that differs is refused on the page', (await errT()).includes('不一致') && cp() === 0, await errT());
        await setPw(FLAGGED.password, FLAGGED.password, FLAGGED.password);
        ok('the same password again is refused on the page', (await errT()).includes('不能和目前') && cp() === 0, await errT());
        await setPw('', NEWPW, NEWPW);
        ok('an empty current password is refused on the page', cp() === 0 && (await errT()).length > 0);

        // the Worker's refusals
        await setPw('not-the-password-1', NEWPW, NEWPW);
        await page.waitForFunction(() => document.getElementById('acct-err').textContent.includes('目前的密碼不正確'));
        ok('403 wrong_password -> 目前的密碼不正確; still on settings, token unchanged', cp() === 1 && (await store(page)).t === s0.t && /settings\.html$/.test(page.url()));
        f.st.failures = 10;
        await setPw(FLAGGED.password, NEWPW, NEWPW);
        await page.waitForFunction(() => document.getElementById('acct-err').textContent.includes('15'));
        ok('429 -> wait 15 minutes', (await errT()).includes('15 分鐘'));
        f.st.failures = 0;

        // success
        await setPw(FLAGGED.password, NEWPW, NEWPW);
        await page.waitForURL('**/dashboard.html', { timeout: 5000 });
        const s1 = await store(page);
        const live = [...f.st.sessions.keys()];
        const call = f.st.calls.filter(c => c.path === '/api/photographer/change-password').pop();
        ok('change-password was posted with the session token, {current_password, new_password}', !!call && call.auth === `Bearer ${s0.t}` &&
          JSON.parse(call.body).current_password === FLAGGED.password && JSON.parse(call.body).new_password === NEWPW);
        ok('the stored token is now the NEW one (the old one no longer exists on the Worker), and the must flag is gone',
          live.length === 1 && live[0] !== s0.t && s1.t === live[0] && s1.s && s1.s.t === live[0] && s1.s.must === false, JSON.stringify({ s1, live, old: s0.t }));
        ok('neither password is in storage', !s1.all.includes(NEWPW) && !s1.all.includes(FLAGGED.password) && !s1.ls.includes(NEWPW));
        // and the other pages are open again
        await page.goto(`${base}/orders.html`, { waitUntil: 'load' });
        ok('afterwards orders.html stays (no bounce back to settings)', /\/orders\.html$/.test(new URL(page.url()).pathname), page.url());
        return out;
      },
      { before: both(m, f) });
  }

  {
    const f = photographerFake({ accounts: [ACCT] });
    // the one live session the page starts with
    f.st.sessions.set('sess-start', ACCT.id);
    const m = dashSettingsMock({ token: a => !!f.accountOf(a) });
    await suite('settings (signed in with an account) — account section, change password swaps the token, later requests use the new one, logout ends the session',
      `${base}/settings.html`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        page.on('dialog', d => d.accept());
        await page.waitForSelector('#acct-submit', { timeout: 5000 });
        ok('the account section is visible and says whose account it is', (await disp(page, '#account-section')) !== 'none' && (await page.textContent('#account-section')).includes(ACCT.email));
        ok('no must-change banner for a normal account (computed display)', (await disp(page, '#acct-must')) === 'none');
        ok('the rest of settings loaded as usual', m.seen.some(r => r.path === '/api/admin/settings') && (await disp(page, '#set-studio-name')) !== 'none');

        await page.fill('#acct-current', ACCT.password);
        await page.fill('#acct-new', NEWPW);
        await page.fill('#acct-new2', NEWPW);
        await page.click('#acct-submit');
        await page.waitForFunction(() => document.getElementById('acct-ok').textContent.length > 0, null, { timeout: 5000 });
        const s1 = await store(page);
        const live = [...f.st.sessions.keys()];
        ok('success message shown; token swapped for the new one (the old one is gone on the Worker)', live.length === 1 && live[0] !== 'sess-start' && s1.t === live[0] && s1.s.t === live[0], JSON.stringify({ s1, live }));
        ok('the form is cleared after success', (await page.inputValue('#acct-current')) === '' && (await page.inputValue('#acct-new')) === '' && (await page.inputValue('#acct-new2')) === '');
        ok('still on settings.html, not signed out', /settings\.html$/.test(page.url()));

        // a later request from this same page must carry the NEW token (the hole: it kept sending the old one and was 401)
        await page.click('#revoke-all-btn');
        await page.waitForFunction(() => document.getElementById('revoke-result').textContent.length > 0, null, { timeout: 4000 });
        const last = m.seen.filter(r => r.path === '/api/shares/minted/revoke-all').pop();
        ok('the next request from the page carries the new token and is accepted', !!last && last.auth === `Bearer ${live[0]}` && (await page.textContent('#revoke-result')).includes('已撤銷'), JSON.stringify(last));
        ok('and the page was not bounced to home.html', /settings\.html$/.test(page.url()));

        // logout: the Worker is told, the storage emptied
        await page.click('#logout-btn');
        await page.waitForURL('**/home.html', { timeout: 5000 });
        const out1 = f.st.calls.filter(c => c.path === '/api/photographer/logout');
        ok('登出 posts /api/photographer/logout with the (new) session token', out1.length === 1 && out1[0].method === 'POST' && out1[0].auth === `Bearer ${live[0]}`, JSON.stringify(out1));
        ok('the session is gone on the Worker and in sessionStorage', f.st.sessions.size === 0 && (await store(page)).t === null && (await store(page)).s === null);
        return out;
      },
      { before: both(m, f), initScript: seed('sess-start', false) });
  }

  {
    const f = photographerFake({ accounts: [ACCT] });
    const m = dashSettingsMock({ token: 'adm' });
    await suite('settings (Tim’s own token) — no account section, no /api/photographer calls at all, logout as before',
      `${base}/settings.html`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.waitForSelector('#set-studio-name', { timeout: 5000 });
        await page.waitForFunction(() => document.getElementById('set-studio-name'));
        ok('the account section stays hidden (computed display)', (await disp(page, '#account-section')) === 'none');
        ok('settings loaded with the token', m.seen.some(r => r.path === '/api/admin/settings' && r.auth === 'Bearer adm'));
        await page.click('#logout-btn');
        await page.waitForURL('**/home.html', { timeout: 5000 });
        ok('logout empties the token', (await store(page)).t === null);
        ok('no /api/photographer call was made, opening or leaving', f.st.calls.length === 0, JSON.stringify(f.st.calls));
        return out;
      },
      { before: both(m, f), initScript: seed('adm') });
  }

  {
    const f = photographerFake({ accounts: [ACCT] });   // no live session: the stored one is dead
    const m = dashSettingsMock({ token: 'adm' });
    await suite('settings (account session that expired) — /me says 401, the person is sent to home.html',
      `${base}/settings.html`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.waitForURL('**/home.html', { timeout: 5000 }).catch(() => {});
        // polled inside the page, so it survives the second hop home that a second 401 starts
        await page.waitForFunction(() => /home\.html$/.test(location.pathname) && !sessionStorage.getItem('studio_token'), null, { timeout: 5000 });
        ok('bounced to home.html', /home\.html$/.test(page.url()), page.url());
        ok('the dead token was dropped', (await store(page)).t === null);
        return out;
      },
      { before: both(m, f), initScript: seed('sess-dead', false) });
  }

  {
    const f = photographerFake({ accounts: [ACCT] });
    f.st.sessions.set('sess-start', ACCT.id);
    const m = dashSettingsMock({ token: a => !!f.accountOf(a) });
    await suite('settings account form — phone (390px): fields and button >= 44px, no sideways scroll',
      `${base}/settings.html`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.waitForSelector('#acct-submit', { timeout: 5000 });
        const sizes = await page.$$eval('#acct-current, #acct-new, #acct-new2, #acct-submit', es => es.map(e => Math.round(e.getBoundingClientRect().height)));
        ok('every field and the button are >= 44px tall (floor: 4 scanned)', sizes.length === 4 && sizes.every(h => h >= 44), JSON.stringify(sizes));
        ok('no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        return out;
      },
      { before: both(m, f), initScript: seed('sess-start', false), contextOptions: MOBILE });
  }
}
