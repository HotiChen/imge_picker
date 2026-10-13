// Browser suites: review fixes for the photographer-invite pages — register.html never puts the typed fields in a URL,
// every page that draws the js/auth.js overlay can sign in with an account and goes to the ROOT settings.html when the
// password must change, every logout path ends the account session on the Worker (and stays silent for Tim's token),
// and the stale-record / must-change edge cases. Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { PIXEL } from '../lib/env.mjs';
import { photographerFake, stubFabric } from '../lib/photographer-fake.mjs';
import { dashSettingsMock } from '../lib/dashboard-mocks.mjs';
import { uploadFake } from '../lib/upload-fake.mjs';

export default async function register() {
  const ACCT = { id: 'ph-1', email: 'ann@example.com', password: 'ann-password-1', display_name: '小安', must_change: false };
  const FLAGGED = { id: 'ph-2', email: 'tmp@example.com', password: 'temp-password-1', display_name: '小暫', must_change: true };
  const both = (...fakes) => async page => { await stubFabric(page); for (const f of fakes) await f.attach(page); };
  const seed = (token, session) => `if (!sessionStorage.getItem('__seeded')) { sessionStorage.setItem('__seeded', '1'); sessionStorage.setItem('studio_token', ${JSON.stringify(token)}); ${session ? `sessionStorage.setItem('studio_session', ${JSON.stringify(JSON.stringify(session))});` : ''} }`;
  const store = page => page.evaluate(() => ({ t: sessionStorage.getItem('studio_token'), s: sessionStorage.getItem('studio_session') }));
  const logouts = f => f.st.calls.filter(c => c.path === '/api/photographer/logout');
  const quiet = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"folders":[]}' }));
  };

  // ── 1. register.html: the typed fields never reach a URL ────────────────────
  {
    const f = photographerFake({ invites: [{ email: 'friend@example.com', code: '12345678' }] });
    const docs = [];
    await suite('register page — password-toggle.js failing to load must not turn Enter into a GET with the fields in the URL',
      `${base}/register.html`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        page.on('request', r => { if (r.resourceType() === 'document') docs.push(r.url()); });
        ok('control: the toggle script really did not load (no eye)', (await page.$('.pw-eye')) === null);
        ok('the form posts, never gets', (await page.$eval('#reg-form', f => f.method)) === 'post');
        ok('no input carries a name (a native submit would have nothing to put in a URL)', (await page.$$eval('#reg-form input[name]', es => es.length)) === 0);
        await page.fill('#reg-email', 'friend@example.com');
        await page.fill('#reg-name', '小安');
        await page.fill('#reg-password', 'a-long-password-1');
        await page.fill('#reg-code', '00000000');
        await page.press('#reg-code', 'Enter');
        await page.waitForFunction(() => document.getElementById('reg-err').textContent.length > 0, null, { timeout: 4000 });
        ok('Enter was handled by the page: the error shows and the Worker was asked once', f.st.calls.filter(c => c.path === '/api/photographer/register-invite').length === 1);
        ok('the URL has no query and holds none of the typed values', new URL(page.url()).search === '' && !/a-long-password|00000000|friend%40|friend@/.test(page.url()), page.url());
        ok('no document request carried the fields', docs.every(u => !/a-long-password|00000000|friend/.test(u)), JSON.stringify(docs));
        return out;
      },
      { before: async page => { await page.route('**/js/password-toggle.js**', r => r.abort()); await f.attach(page); } });
  }

  // ── 2./3. every page that draws the auth.js overlay ─────────────────────────
  for (const [label, path, root] of [['r2_designer', '/r2_designer/index.html', '/settings.html'], ['book_editor', '/book_editor/index.html', '/settings.html']]) {
    const f = photographerFake({ accounts: [ACCT, FLAGGED] });
    await suite(`${label} login overlay — email + password works (needs the session helper) and a flagged account goes to the root settings.html`,
      `${base}${path}`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.waitForSelector('#auth-overlay', { timeout: 5000 });
        ok('the helper is loaded on this page', await page.evaluate(() => typeof window.PhotographerSession === 'object'));
        await page.click('#auth-mode-email');
        await page.fill('#auth-email', FLAGGED.email);
        await page.fill('#auth-pw', FLAGGED.password);
        await page.click('#auth-email-btn');
        await page.waitForURL('**/settings.html', { timeout: 5000 });
        ok('the flagged login lands on the ROOT settings.html (not a 404 beside this page)', new URL(page.url()).pathname === root, page.url());
        ok('the session is stored with must: true', JSON.parse((await store(page)).s || 'null')?.must === true);
        return out;
      },
      { before: both(f), initScript: () => { try { localStorage.setItem('book_editor_tour_done', '1'); } catch (e) { /* ignore */ } } });
  }
  {
    const f = photographerFake({ accounts: [ACCT] });
    await suite('r2_designer login overlay — a normal account signs in without a page error',
      `${base}/r2_designer/index.html`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.waitForSelector('#auth-overlay', { timeout: 5000 });
        await page.click('#auth-mode-email');
        await page.fill('#auth-email', ACCT.email);
        await page.fill('#auth-pw', ACCT.password);
        await page.click('#auth-email-btn');
        await page.waitForFunction(() => !document.getElementById('auth-overlay'), null, { timeout: 5000 });
        const s = await store(page);
        ok('the overlay is gone and the session is stored (and no 無法連線 was shown)', !!s.t && JSON.parse(s.s).t === s.t && JSON.parse(s.s).must === false);
        return out;
      },
      { before: both(f) });
  }

  // ── 4. the logout paths ────────────────────────────────────────────────────
  {
    const f = photographerFake({ accounts: [ACCT] });
    f.st.sessions.set('sess-start', ACCT.id);
    await suite('logout paths — index.html 登出 ends the account session on the Worker and clears studio_session',
      `${base}/index.html?project=p1`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.waitForSelector('#studio-logout', { timeout: 5000 });
        await Promise.all([page.waitForEvent('load'), page.click('#studio-logout')]).catch(() => {});
        await page.waitForTimeout(300);
        ok('POST /api/photographer/logout with the session token', logouts(f).length === 1 && logouts(f)[0].method === 'POST' && logouts(f)[0].auth === 'Bearer sess-start', JSON.stringify(f.st.calls));
        ok('the session is gone on the Worker, and both storage keys are cleared', f.st.sessions.size === 0 && (await store(page)).t === null && (await store(page)).s === null);
        return out;
      },
      { before: async page => { await quiet(page); await f.attach(page); }, initScript: seed('sess-start', { t: 'sess-start', must: false }) });
  }
  {
    const f = photographerFake({ accounts: [ACCT] });
    await suite('logout paths — index.html 登出 with Tim’s token makes no /api/photographer call',
      `${base}/index.html?project=p1`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.waitForSelector('#studio-logout', { timeout: 5000 });
        await Promise.all([page.waitForEvent('load'), page.click('#studio-logout')]).catch(() => {});
        await page.waitForTimeout(300);
        ok('token cleared, and the Worker heard nothing', (await store(page)).t === null && f.st.calls.length === 0, JSON.stringify(f.st.calls));
        return out;
      },
      { before: async page => { await quiet(page); await f.attach(page); }, initScript: seed('adm') });
  }
  {
    const f = photographerFake({ accounts: [ACCT] });
    f.st.sessions.set('sess-start', ACCT.id);
    const u = uploadFake({ plan: {} });      // answers 401 to any token but "adm"
    await suite('logout paths — upload.html: a 401 on an upload with an account session ends that session and clears studio_session',
      `${base}/upload.html?folder=${encodeURIComponent('shoot/')}&lock=1`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.waitForSelector('#fileInput', { state: 'attached', timeout: 5000 });
        await page.setInputFiles('#fileInput', [{ name: 'a.png', mimeType: 'image/png', buffer: PIXEL }]);
        await page.waitForFunction(() => !sessionStorage.getItem('studio_token'), null, { timeout: 8000 });
        await page.waitForTimeout(300);
        ok('the 401 dropped the token and the session record', (await store(page)).t === null && (await store(page)).s === null);
        ok('and the Worker was told to end that session', logouts(f).length === 1 && logouts(f)[0].auth === 'Bearer sess-start', JSON.stringify(f.st.calls));
        return out;
      },
      { before: both(u, f), initScript: seed('sess-start', { t: 'sess-start', must: false }) });
  }
  {
    const f = photographerFake({ accounts: [ACCT] });
    const u = uploadFake({ plan: {} });
    await suite('logout paths — upload.html: a 401 with Tim’s token stays silent toward /api/photographer',
      `${base}/upload.html?folder=${encodeURIComponent('shoot/')}&lock=1`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.waitForSelector('#fileInput', { state: 'attached', timeout: 5000 });
        await page.setInputFiles('#fileInput', [{ name: 'a.png', mimeType: 'image/png', buffer: PIXEL }]);
        await page.waitForFunction(() => !sessionStorage.getItem('studio_token'), null, { timeout: 8000 });
        await page.waitForTimeout(300);
        ok('token dropped, and no /api/photographer call was made', f.st.calls.length === 0, JSON.stringify(f.st.calls));
        return out;
      },
      { before: both(u, f), initScript: seed('wrong-token') });
  }

  // ── 5. edge cases ──────────────────────────────────────────────────────────
  {
    const f = photographerFake({ accounts: [ACCT] });
    const m = dashSettingsMock({ token: 'adm' });
    await suite('stale studio_session next to Tim’s token — no account section, no /api/photographer call, logout stays silent',
      `${base}/settings.html`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.waitForSelector('#set-studio-name', { timeout: 5000 });
        ok('stays on settings (a record for another token, must: true, does not redirect)', /\/settings\.html$/.test(page.url()));
        ok('the account section is not shown', (await page.$eval('#account-section', e => e.getClientRects().length)) === 0);
        ok('the page loaded as usual', m.seen.some(r => r.path === '/api/admin/settings' && r.auth === 'Bearer adm'));
        await page.click('#logout-btn');
        await page.waitForURL('**/home.html', { timeout: 5000 });
        ok('no /api/photographer call at all, opening or leaving', f.st.calls.length === 0, JSON.stringify(f.st.calls));
        return out;
      },
      { before: both(m, f), initScript: seed('adm', { t: 'some-old-session', must: true }) });
  }
  {
    const f = photographerFake({ accounts: [FLAGGED] });   // no live session
    const m = dashSettingsMock({ token: 'adm' });
    await suite('must-change mode — a /me 401 (session already dead) sends the person home',
      `${base}/settings.html`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.waitForFunction(() => /home\.html$/.test(location.pathname) && !sessionStorage.getItem('studio_token'), null, { timeout: 5000 });
        ok('on home.html with the token and the record gone', (await store(page)).t === null && (await store(page)).s === null);
        ok('control: /me was asked', f.st.calls.some(c => c.path === '/api/photographer/me'));
        return out;
      },
      { before: both(m, f), initScript: seed('sess-dead', { t: 'sess-dead', must: true }) });
  }
}
