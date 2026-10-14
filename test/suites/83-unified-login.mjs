// Browser suites: ONE login form everywhere (js/unified-login.js): a 帳號 field and a 密碼 field, no 改用 Email 登入 toggle.
// 帳號 `admin` (trimmed, any case) = the studio password through the page's own verification call (zero
// /api/photographer calls); anything else = an email + password account (POST /api/photographer/login).
// Surfaces: home.html, admin.html, and the js/auth.js overlay on upload.html, book_editor/ and r2_designer/.
// operator.html (its own operator token) and client-login.html (retired client accounts) are not part of it.
// Registered by test/run.mjs in file-name order; see test/README.md.
import fs from 'node:fs';
import path from 'node:path';
import { base, suite } from '../lib/harness.mjs';
import { MOBILE, ROOT } from '../lib/env.mjs';
import { photographerFake, stubFabric } from '../lib/photographer-fake.mjs';

export default async function register() {
  const ACCT = { id: 'ph-1', email: 'ann@example.com', password: 'ann-password-1', display_name: '小安', must_change: false };
  const FLAGGED = { id: 'ph-2', email: 'tmp@example.com', password: 'temp-password-1', display_name: '小暫', must_change: true };
  const STUDIO_PW = 'studio-pw';
  const WORKER = 'imagepicker.hotichen.workers.dev';

  // The studio side of the Worker: the three verification routes answer 200 for the studio password and 401 otherwise;
  // everything else (what a page asks after sign-in) is an empty answer. Every call is recorded.
  const studioMock = (emptyBody = '{"folders":[]}') => {
    const calls = [];
    const attach = async page => {
      await page.route(`**/${WORKER}/api/**`, async route => {
        const req = route.request();
        const u = new URL(req.url());
        const h = await req.allHeaders();
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
        if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        calls.push({ method: req.method(), path: u.pathname, auth: h['authorization'] || null });
        const verify = ['/api/admin/settings', '/api/admin/clients', '/api/auth/verify-admin'].includes(u.pathname);
        if (verify && h['authorization'] !== `Bearer ${STUDIO_PW}`) return route.fulfill({ status: 401, headers: cors, contentType: 'application/json', body: '{"error":"Unauthorized"}' });
        route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: verify ? '{"ok":true}' : emptyBody });
      });
    };
    return { calls, attach };
  };
  const both = (studio, f, extra) => async page => { if (extra) await extra(page); await studio.attach(page); await f.attach(page); };
  const store = page => page.evaluate(() => ({ t: sessionStorage.getItem('studio_token'), s: JSON.parse(sessionStorage.getItem('studio_session') || 'null'), all: JSON.stringify(sessionStorage), ls: JSON.stringify(localStorage) }));
  const shown = (page, sel) => page.$eval(sel, e => e.getClientRects().length > 0);
  const lines = () => { const out = []; return { out, ok: (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`) }; };

  // every login surface, with the ids it uses and how it looks when the sign-in is done
  const quietTour = () => { try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) { /* ignore */ } };
  const overlayGone = page => page.waitForFunction(() => !document.getElementById('auth-overlay'), null, { timeout: 5000 });
  const SURFACES = [
    { name: 'home.html', url: `${base}/home.html`, open: async page => { await page.click('#photographerLoginBtn'); },
      acct: '#loginAccountInput', pw: '#loginTokenInput', btn: '#loginSubmitBtn', err: '#loginErr', verify: '/api/admin/settings',
      done: page => page.waitForURL('**/dashboard.html', { timeout: 5000 }), mustDone: page => page.waitForURL('**/settings.html', { timeout: 5000 }) },
    { name: 'admin.html', url: `${base}/admin.html`, open: async page => { await page.waitForSelector('#login-view', { state: 'visible' }); },
      acct: '#admin-account-input', pw: '#admin-token-input', btn: '#admin-login-btn', err: '#admin-login-err', verify: '/api/admin/clients',
      done: page => page.waitForFunction(() => getComputedStyle(document.getElementById('login-view')).display === 'none' && getComputedStyle(document.getElementById('admin-view')).display !== 'none', null, { timeout: 5000 }),
      mustDone: page => page.waitForURL('**/settings.html', { timeout: 5000 }), emptyBody: '[]' },
    { name: 'upload.html overlay', url: `${base}/upload.html`, open: async page => { await page.waitForSelector('#auth-overlay'); },
      acct: '#auth-account', pw: '#auth-input', btn: '#auth-btn', err: '#auth-err', verify: '/api/auth/verify-admin',
      done: overlayGone, mustDone: page => page.waitForURL('**/settings.html', { timeout: 5000 }) },
    { name: 'book_editor overlay', url: `${base}/book_editor/index.html`, open: async page => { await page.waitForSelector('#auth-overlay'); },
      acct: '#auth-account', pw: '#auth-input', btn: '#auth-btn', err: '#auth-err', verify: '/api/auth/verify-admin',
      done: overlayGone, mustDone: page => page.waitForURL('**/settings.html', { timeout: 5000 }), init: quietTour },
    { name: 'r2_designer overlay', url: `${base}/r2_designer/index.html`, open: async page => { await page.waitForSelector('#auth-overlay'); },
      acct: '#auth-account', pw: '#auth-input', btn: '#auth-btn', err: '#auth-err', verify: '/api/auth/verify-admin',
      done: overlayGone, mustDone: page => page.waitForURL('**/settings.html', { timeout: 5000 }), fabric: true },
  ];
  const opts = (S, studio, f) => ({ before: both(studio, f, S.fabric ? stubFabric : null), initScript: S.init });
  const fill = async (page, S, account, pw, { submit = 'click' } = {}) => {
    await page.fill(S.acct, account);
    await page.fill(S.pw, pw);
    if (submit === 'enter') await page.press(S.pw, 'Enter'); else await page.click(S.btn);
  };
  // calls that are a sign-in attempt (a page may ask other things on load, book_editor does)
  const attempts = (studio, f) => studio.calls.filter(c => c.path === '/api/admin/settings' || c.path === '/api/admin/clients' || c.path === '/api/auth/verify-admin').length + f.st.calls.length;
  const errText = (page, S) => page.textContent(S.err);

  for (const S of SURFACES) {
    // ── the form itself ────────────────────────────────────────────────────
    {
      const studio = studioMock(S.emptyBody); const f = photographerFake({ accounts: [ACCT] });
      await suite(`unified login — ${S.name}: one form with 帳號 + 密碼, the right attributes, no toggle, nothing sent before submit`,
        S.url,
        async page => {
          const { out, ok } = lines();
          await S.open(page);
          ok('the 帳號 field is visible and is a text field (not type=email: `admin` must be accepted)', (await shown(page, S.acct)) && (await page.getAttribute(S.acct, 'type')) === 'text');
          ok('the 密碼 field is visible, a password field, with the show/hide eye', (await shown(page, S.pw)) && (await page.getAttribute(S.pw, 'type')) === 'password' && (await page.$(`.pw-wrap:has(${S.pw}) .pw-eye`)) !== null);
          const attrs = await page.$eval(S.acct, e => ['autocomplete', 'autocapitalize', 'autocorrect', 'spellcheck', 'inputmode'].map(a => e.getAttribute(a)));
          ok('帳號: autocomplete=username, autocapitalize/autocorrect off, spellcheck false, email keyboard', JSON.stringify(attrs) === JSON.stringify(['username', 'off', 'off', 'false', 'email']), JSON.stringify(attrs));
          ok('密碼: autocomplete=current-password', (await page.getAttribute(S.pw, 'autocomplete')) === 'current-password');
          ok('both fields sit in one <form method=post> with the submit button (password managers; Enter submits)', await page.evaluate(([a, p, b]) => {
            const f = document.querySelector(a).closest('form');
            return !!f && f.method === 'post' && f.contains(document.querySelector(p)) && document.querySelector(b).type === 'submit';
          }, [S.acct, S.pw, S.btn]));
          ok('there is no 改用 toggle left on the page', !(await page.$eval(S.acct, e => e.closest('.login-card, #auth-overlay').textContent)).includes('改用') && (await page.$('#loginModeEmail, #loginModeToken, #auth-mode-email, #auth-mode-token')) === null);
          ok('typed text is not altered: a mixed-case address is kept as typed', await (async () => { await page.fill(S.acct, 'Ann@Example.com'); return (await page.inputValue(S.acct)) === 'Ann@Example.com'; })());
          ok('opening the page made no sign-in attempt', attempts(studio, f) === 0);
          return out;
        }, opts(S, studio, f));
    }

    // ── 帳號 admin: the studio password, the page's own verification call, no /api/photographer ─────
    {
      const studio = studioMock(S.emptyBody); const f = photographerFake({ accounts: [ACCT] });
      await suite(`unified login — ${S.name}: 帳號 admin + the studio password signs in (Enter submits), exact call and storage, zero /api/photographer calls`,
        S.url,
        async page => {
          const { out, ok } = lines();
          await S.open(page);
          await fill(page, S, 'admin', STUDIO_PW, { submit: 'enter' });
          await S.done(page);
          const s = await store(page);
          const verify = studio.calls.filter(c => c.path === S.verify);
          ok(`the verification is GET ${S.verify} with Bearer <the password> (the page may ask its own things before / after)`, verify.length >= 1 && verify[0].method === 'GET' && verify[0].auth === `Bearer ${STUDIO_PW}` && (S.name.includes('overlay') ? verify.length === 1 : true), JSON.stringify(studio.calls));
          ok('studio_token holds the studio password, and no studio_session record is written (Tim’s path as before)', s.t === STUDIO_PW && s.s === null, JSON.stringify(s));
          ok('no /api/photographer call at all', f.st.calls.length === 0 && !studio.calls.some(c => c.path.startsWith('/api/photographer')), JSON.stringify(f.st.calls));
          ok('nothing in localStorage (nothing remembered)', !s.ls.includes(STUDIO_PW) && !s.ls.includes('admin'), s.ls);
          if (S.name.includes('overlay')) ok('the page now uses that token (CONFIG.PHOTOGRAPHER_TOKEN)', (await page.evaluate(() => CONFIG.PHOTOGRAPHER_TOKEN)) === STUDIO_PW);
          return out;
        }, opts(S, studio, f));
    }

    // ── an email: POST /api/photographer/login ─────────────────────────────────────────────────
    {
      const studio = studioMock(S.emptyBody); const f = photographerFake({ accounts: [ACCT] });
      await suite(`unified login — ${S.name}: an email + password signs in (token + studio_session stored), never touching the studio verification`,
        S.url,
        async page => {
          const { out, ok } = lines();
          await S.open(page);
          await fill(page, S, `  ${ACCT.email.toUpperCase()} `, ACCT.password);
          await S.done(page);
          const s = await store(page);
          const live = [...f.st.sessions.keys()];
          const c = f.st.calls.filter(x => x.path === '/api/photographer/login');
          ok('one POST /api/photographer/login with {email (trimmed), password} and no Authorization', c.length === 1 && c[0].method === 'POST' && c[0].auth === null && JSON.parse(c[0].body).email === ACCT.email.toUpperCase() && JSON.parse(c[0].body).password === ACCT.password, JSON.stringify(c));
          ok('the session token is in studio_token, described by studio_session {t, must:false}', live.length === 1 && s.t === live[0] && s.s && s.s.t === live[0] && s.s.must === false, JSON.stringify(s));
          ok('the studio verification route was never called for an email', !studio.calls.some(x => x.path === S.verify), JSON.stringify(studio.calls));
          ok('the password is nowhere in storage', !s.all.includes(ACCT.password) && !s.ls.includes(ACCT.password));
          return out;
        }, opts(S, studio, f));
    }

    // ── a flagged account lands on settings ────────────────────────────────────────────────────
    {
      const studio = studioMock(S.emptyBody); const f = photographerFake({ accounts: [FLAGGED] });
      await suite(`unified login — ${S.name}: an account that must change its password lands on settings.html with must:true stored`,
        S.url,
        async page => {
          const { out, ok } = lines();
          await S.open(page);
          await fill(page, S, FLAGGED.email, FLAGGED.password);
          await S.mustDone(page);
          const s = await store(page);
          ok('on settings.html, the session stored with must:true', /\/settings\.html$/.test(new URL(page.url()).pathname) && s.s && s.s.must === true && s.s.t === s.t, `${page.url()} ${JSON.stringify(s)}`);
          return out;
        }, opts(S, studio, f));
    }

    // ── wrong credentials, empty fields ────────────────────────────────────────────────────────
    {
      const studio = studioMock(S.emptyBody); const f = photographerFake({ accounts: [ACCT] });
      await suite(`unified login — ${S.name}: wrong admin password and wrong email password say the same sentence; empty 帳號 / 密碼 are refused locally`,
        S.url,
        async page => {
          const { out, ok } = lines();
          await S.open(page);
          const waitErr = () => page.waitForFunction(sel => document.querySelector(sel).textContent.length > 0, S.err);
          const clearErr = () => page.evaluate(sel => { document.querySelector(sel).textContent = ''; }, S.err);

          await page.click(S.btn);
          ok('empty 帳號: 請輸入帳號, nothing sent', (await errText(page, S)).includes('請輸入帳號') && attempts(studio, f) === 0, await errText(page, S));
          await page.fill(S.acct, 'admin'); await page.fill(S.pw, ''); await page.click(S.btn);
          ok('帳號 admin with an empty 密碼: 請輸入密碼, nothing sent', (await errText(page, S)).includes('請輸入密碼') && attempts(studio, f) === 0, await errText(page, S));
          await page.fill(S.acct, ACCT.email); await page.fill(S.pw, ''); await page.click(S.btn);
          ok('an email with an empty 密碼: 請輸入密碼, nothing sent', (await errText(page, S)).includes('請輸入密碼') && attempts(studio, f) === 0, await errText(page, S));

          await clearErr();
          await fill(page, S, 'admin', 'not-the-studio-password');
          await waitErr();
          const adminErr = (await errText(page, S)).trim();
          ok('a wrong admin password is refused and nothing is stored', (await store(page)).t === null && studio.calls.filter(c => c.path === S.verify).length === 1);
          await clearErr();
          await fill(page, S, ACCT.email, 'wrong-password-x');
          await waitErr();
          const mailErr = (await errText(page, S)).trim();
          ok('a wrong email password is refused and nothing is stored', (await store(page)).t === null && f.st.calls.some(c => c.path === '/api/photographer/login'));
          ok('the two refusals are the same sentence (it does not say which part was wrong)', adminErr === mailErr && adminErr.includes('帳號或密碼不正確'), JSON.stringify([adminErr, mailErr]));
          ok('and it names neither the password alone nor Email nor admin', !/^密碼|Email|admin/.test(adminErr), adminErr);
          ok('the form is still there after a failure (positive)', await shown(page, S.acct) && await shown(page, S.pw));
          return out;
        }, opts(S, studio, f));
    }
  }

  // ── the studio verification fails at the network level / with a 5xx: the login is REFUSED, nothing is stored ─────────
  for (const S of SURFACES) {
    for (const mode of ['network error', 'HTTP 500', 'HTTP 503']) {
      const studio = studioMock(S.emptyBody); const f = photographerFake({ accounts: [ACCT] });
      const before = async page => {
        await both(studio, f, S.fabric ? stubFabric : null)(page);
        // registered last, so it wins over the generic mock for the verification route only
        await page.route(`**/${WORKER}${S.verify}`, route => mode === 'network error' ? route.abort('failed')
          : route.fulfill({ status: Number(mode.slice(5)), headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, contentType: 'application/json', body: '{"error":"boom"}' }));
      };
      await suite(`unified login — ${S.name}: ${mode} on the admin verification refuses the login (無法連線，請稍後再試) and stores nothing`,
        S.url,
        async page => {
          const { out, ok } = lines();
          await S.open(page);
          await fill(page, S, 'admin', STUDIO_PW);
          await page.waitForFunction(sel => document.querySelector(sel).textContent.length > 0, S.err);
          const s = await store(page);
          ok('the message says it could not connect and to retry', (await errText(page, S)).includes('無法連線，請稍後再試'), await errText(page, S));
          ok('the password is nowhere in sessionStorage / localStorage (never store an unverified password)', s.t === null && !s.all.includes(STUDIO_PW) && !s.ls.includes(STUDIO_PW), JSON.stringify(s));
          ok('the form is still there (positive) and no /api/photographer call was made', (await shown(page, S.acct)) && (await shown(page, S.pw)) && f.st.calls.length === 0);
          if (S.name.includes('overlay')) ok('the overlay is still on the page and the page token is unset', (await page.$('#auth-overlay')) !== null && !(await page.evaluate(() => CONFIG.PHOTOGRAPHER_TOKEN)));
          else ok('still on the same page', page.url().startsWith(S.url));
          return out;
        }, { before, initScript: S.init });
    }
  }

  // ── `admin` in any case, with spaces ────────────────────────────────────────────────────────
  for (const variant of ['ADMIN', ' admin ', 'Admin', '\tAdMiN  ']) {
    const S = SURFACES[0];
    const studio = studioMock(); const f = photographerFake({ accounts: [ACCT] });
    await suite(`unified login — home.html: 帳號 ${JSON.stringify(variant)} is the studio login too (trimmed, case-insensitive)`,
      S.url,
      async page => {
        const { out, ok } = lines();
        await S.open(page);
        await fill(page, S, variant, STUDIO_PW);
        await S.done(page);
        ok('signed in with the studio password as studio_token', (await store(page)).t === STUDIO_PW);
        ok('through the studio verification, never /api/photographer', studio.calls.some(c => c.path === S.verify) && f.st.calls.length === 0);
        return out;
      }, opts(S, studio, f));
  }
  {
    // not exactly `admin`: an email attempt, so it goes to the account login (which refuses it) and not the studio route
    const S = SURFACES[0];
    const studio = studioMock(); const f = photographerFake({ accounts: [ACCT] });
    await suite('unified login — home.html: 帳號 "administrator" / "admin@x.tw" are emails, not the studio login (positive: the account route is called)',
      S.url,
      async page => {
        const { out, ok } = lines();
        await S.open(page);
        for (const a of ['administrator', 'admin@example.com']) {
          await fill(page, S, a, STUDIO_PW);
          await page.waitForTimeout(400);
        }
        ok('the account login was called for both, the studio verification for neither', f.st.calls.filter(c => c.path === '/api/photographer/login').length === 2 && !studio.calls.some(c => c.path === S.verify), JSON.stringify([f.st.calls.length, studio.calls]));
        ok('nothing was stored', (await store(page)).t === null);
        return out;
      }, opts(S, studio, f));
  }

  // ── no password in the URL ─────────────────────────────────────────────────────────────────
  {
    const S = SURFACES[0];
    const studio = studioMock(); const f = photographerFake({ accounts: [ACCT] });
    await suite('unified login — home.html: submitting never navigates with the password in the address (Enter in the password field)',
      S.url,
      async page => {
        const { out, ok } = lines();
        await S.open(page);
        await fill(page, S, ACCT.email, 'wrong-password-x', { submit: 'enter' });
        await page.waitForFunction(() => document.getElementById('loginErr').textContent.length > 0);
        ok('still on home.html with no query string, the password is not in the URL', page.url() === `${base}/home.html` && !page.url().includes('wrong'), page.url());
        ok('the login call was made (positive: Enter did submit)', f.st.calls.some(c => c.path === '/api/photographer/login'));
        return out;
      }, opts(S, studio, f));
  }

  // ── phone ───────────────────────────────────────────────────────────────────────────────────
  for (const S of SURFACES.filter(x => ['home.html', 'admin.html', 'upload.html overlay'].includes(x.name))) {
    const studio = studioMock(S.emptyBody); const f = photographerFake({ accounts: [ACCT] });
    await suite(`unified login — ${S.name} on a 390px phone: fields and button >= 44px, 16px text, card inside the screen, no sideways scroll`,
      S.url,
      async page => {
        const { out, ok } = lines();
        await S.open(page);
        const m = await page.$$eval([S.acct, S.pw, S.btn].join(','), es => es.map(e => { const r = e.getBoundingClientRect(); return { h: Math.round(r.height), w: Math.round(r.width), l: Math.round(r.left), r: Math.round(r.right), fs: parseFloat(getComputedStyle(e).fontSize) }; }));
        ok('three controls measured (floor: 3)', m.length === 3, JSON.stringify(m));
        ok('every field and the button are >= 44px tall', m.every(x => x.h >= 44), JSON.stringify(m));
        ok('the two fields use >= 16px text (iOS does not zoom on focus)', m.slice(0, 2).every(x => x.fs >= 16), JSON.stringify(m));
        ok('all inside the 390px screen', m.every(x => x.l >= 0 && x.r <= 390 && x.w > 150), JSON.stringify(m));
        ok('no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
        const eye = await page.$eval(`.pw-wrap:has(${S.pw}) .pw-eye`, e => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
        ok('the eye is a >= 44 x 40 tap target', eye[0] >= 44 && eye[1] >= 40, JSON.stringify(eye));
        return out;
      }, { ...opts(S, studio, f), contextOptions: MOBILE });
  }

  // ── the toggle is gone from the whole repository ─────────────────────────────────────────────
  {
    const f = photographerFake({ accounts: [ACCT] });
    await suite('unified login — no 改用 Email / 改用存取密碼 toggle (or its ids) remains in any html or js of the repository',
      `${base}/home.html`,
      async () => {
        const { out, ok } = lines();
        const files = [];
        const walk = dir => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (['node_modules', '.git', '.claude', 'test', 'docs', 'worker'].includes(e.name)) continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p); else if (/\.(html|js|mjs)$/.test(e.name)) files.push(p);
          }
        };
        walk(ROOT);
        const BAD = /改用 ?Email|改用存取密碼|改用攝影師密碼|loginModeEmail|loginModeToken|auth-mode-email|auth-mode-token|loginEmailPane|loginEmailInput|loginPwInput|auth-email-pane|auth-token-pane/;
        const hits = files.filter(p => BAD.test(fs.readFileSync(p, 'utf8'))).map(p => path.relative(ROOT, p));
        ok(`scanned ${files.length} files (floor: 30, includes home.html and js/auth.js)`, files.length >= 30 && files.some(p => p.endsWith('home.html')) && files.some(p => p.endsWith(path.join('js', 'auth.js'))));
        ok('no toggle text or old pane / field id anywhere', hits.length === 0, JSON.stringify(hits));
        // every page that shows the form: a real <script src> with a ?v= stamp, placed before the script that uses it
        const PAGES = [['home.html', null], ['admin.html', null], ['upload.html', 'js/auth.js'], ['book_editor/index.html', 'js/auth.js'], ['r2_designer/index.html', 'js/auth.js']];
        const bad = [];
        for (const [f2, user] of PAGES) {
          const html = fs.readFileSync(path.join(ROOT, f2), 'utf8');
          const m = /<script[^>]+src="[^"]*js\/unified-login\.js\?v=\d{8}[a-z]?"[^>]*><\/script>/.exec(html);
          if (!m) { bad.push(`${f2}: no stamped script tag`); continue; }
          const needs = [/js\/photographer-session\.js/, /js\/password-toggle\.js/].filter(re => { const x = re.exec(html); return !x || x.index > m.index; });
          if (needs.length) bad.push(`${f2}: photographer-session.js / password-toggle.js must come before it`);
          if (user) { const u = html.indexOf(user + '?'); if (u < 0 || u < m.index) bad.push(`${f2}: must load before ${user}`); }
          else if (!/<script>[\s\S]*UnifiedLogin\./.test(html.slice(m.index + m[0].length))) bad.push(`${f2}: the inline script using UnifiedLogin must come after it`);
        }
        ok('all five login surfaces load js/unified-login.js (stamped ?v=, after its dependencies, before the code that uses it)', bad.length === 0, JSON.stringify(bad));
        // and no other html page uses the form without it: every page that mentions UnifiedLogin or auth.js loads the module
        const users = files.filter(p => p.endsWith('.html')).filter(p => /UnifiedLogin\.|js\/auth\.js/.test(fs.readFileSync(p, 'utf8')));
        const missing = users.filter(p => !/js\/unified-login\.js\?v=/.test(fs.readFileSync(p, 'utf8'))).map(p => path.relative(ROOT, p));
        ok(`every html using UnifiedLogin or js/auth.js loads the module (scanned ${users.length}, floor: 5)`, users.length >= 5 && missing.length === 0, JSON.stringify(missing));
        return out;
      }, { before: f.attach });
  }
}
