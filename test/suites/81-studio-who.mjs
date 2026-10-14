// Browser suites: the photographer's NAME next to 登出 (js/studio-who.js, css/studio-who.css).
// Account session (email login / invited friend) = display_name from GET /api/photographer/me; Tim's own token = the
// studio name from GET /api/admin/settings, else 「攝影師」. Rendered with textContent only, ellipsised, a title with the
// full name, cached in sessionStorage.studio_who tied to the token (one lookup per session, not per page), cleared on
// logout; a failed lookup leaves the page as it was. Phone: initial only in the header (name in the index.html menu).
// Chromium only, not a real phone. Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { photographerFake, stubFabric } from '../lib/photographer-fake.mjs';
import { dashSettingsMock } from '../lib/dashboard-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {
  const ACCT = { id: 'ph-1', email: 'ann@example.com', password: 'ann-password-1', display_name: '小安', must_change: false };
  const lines = () => { const out = []; return { out, ok: (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`) }; };
  const both = (...fakes) => async page => { await stubFabric(page); for (const f of fakes) await f.attach(page); };
  // seeded once per tab (addInitScript re-runs on every navigation: a known false-pass shape); an optional raw script runs once too
  const seed = (token, session, extra = '') => `if (!sessionStorage.getItem('__seeded')) { sessionStorage.setItem('__seeded', '1'); sessionStorage.setItem('studio_token', ${JSON.stringify(token)}); ${session ? `sessionStorage.setItem('studio_session', JSON.stringify({ t: ${JSON.stringify(token)}, must: false }));` : ''} ${extra} }`;
  const WHO = '.studio-who';
  // what the header shows: the element, its parts and where it sits relative to the logout button, in one evaluate
  const who = (page, logoutSel = '#logout-btn') => page.evaluate(([w, lo]) => {
    const e = document.querySelector(w);
    if (!e) return null;
    const cs = getComputedStyle(e), name = e.querySelector('.studio-who-name'), ini = e.querySelector('.studio-who-ini');
    const r = e.getBoundingClientRect(), out = document.querySelector(lo);
    const nr = name && name.getBoundingClientRect(), ir = ini && ini.getBoundingClientRect(), or = out && out.getBoundingClientRect();
    const hdr = e.closest('header');
    return {
      shown: e.getClientRects().length > 0 && cs.visibility !== 'hidden',
      text: name ? name.textContent : null, ini: ini ? ini.textContent : null, title: e.getAttribute('title'),
      kids: e.querySelectorAll('*').length, imgs: e.querySelectorAll('img, b, script').length,
      nameDisp: name ? getComputedStyle(name).display : null, iniDisp: ini ? getComputedStyle(ini).display : null,
      nameShown: !!name && name.getClientRects().length > 0, iniShown: !!ini && ini.getClientRects().length > 0,
      beforeLogout: !!out && e.nextElementSibling === out, sameParent: !!out && e.parentElement === out.parentElement,
      w: r.width, nameW: nr ? nr.width : 0, iniW: ir ? ir.width : 0, nameOverflow: name ? name.scrollWidth > name.clientWidth : false,
      ellipsis: name ? getComputedStyle(name).textOverflow : null, nameWs: name ? getComputedStyle(name).whiteSpace : null,
      logoutRight: or ? or.right : null, logoutLeft: or ? or.left : null, logoutShown: !!out && out.getClientRects().length > 0,
      iw: innerWidth, sw: document.documentElement.scrollWidth,
      hdrH: hdr ? hdr.getBoundingClientRect().height : null, hdrScroll: hdr ? hdr.scrollWidth <= hdr.clientWidth + 1 : null,
      logoutInHdr: !!out && !!hdr && or.top >= hdr.getBoundingClientRect().top - 1 && or.bottom <= hdr.getBoundingClientRect().bottom + 1,
      whoTop: r.top, whoBottom: r.bottom, hdrTop: hdr ? hdr.getBoundingClientRect().top : null, hdrBottom: hdr ? hdr.getBoundingClientRect().bottom : null,
    };
  }, [WHO, logoutSel]);
  const waitWho = (page, t = 5000) => page.waitForSelector(`${WHO} .studio-who-name`, { state: 'attached', timeout: t });
  const cache = page => page.evaluate(() => sessionStorage.getItem('studio_who'));
  const me = f => f.st.calls.filter(c => c.path === '/api/photographer/me');
  const setReads = m => m.seen.filter(r => r.path === '/api/admin/settings' && r.method === 'GET');

  // ── 1. account session: the display_name, before 登出, from /me ──────────────────────────────────────────────────────
  for (const [page_, sel] of [['dashboard.html', '#logout-btn'], ['orders.html', '#logout-btn'], ['settings.html', '#logout-btn']]) {
    const f = photographerFake({ accounts: [ACCT] });
    f.st.sessions.set('sess-1', ACCT.id);
    const m = dashSettingsMock({ token: a => !!f.accountOf(a) });
    await suite(`studio who — account session on ${page_}: the display_name sits right before 登出, titled, from one /me call`,
      `${base}/${page_}`,
      async page => {
        const { out, ok } = lines();
        await waitWho(page);
        const w = await who(page, sel);
        ok('the name is the account display_name (real element, shown)', !!w && w.shown && w.text === ACCT.display_name, JSON.stringify(w));
        ok('it is the element right before the logout button, same header', !!w && w.beforeLogout && w.sameParent, JSON.stringify(w));
        ok('title carries the full name and the initial is its first character', !!w && w.title === ACCT.display_name && w.ini === '小', JSON.stringify(w));
        ok('exactly one /me call, carrying the session token', me(f).length === 1 && me(f)[0].auth === 'Bearer sess-1', JSON.stringify(me(f)));
        ok('the name is in no URL the page requested', ![...f.st.calls, ...m.seen].some(c => (c.path || '').includes(encodeURIComponent(ACCT.display_name))));
        const c = JSON.parse(await cache(page) || 'null');
        ok('cached in sessionStorage.studio_who tied to the token', !!c && c.t === 'sess-1' && c.name === ACCT.display_name, JSON.stringify(c));
        return out;
      },
      { before: both(m, f), initScript: seed('sess-1', true) });
  }

  // ── 2. markup in display_name stays text ─────────────────────────────────────────────────────────────────────────────
  {
    const EVIL = '<img src=x onerror="window.__xss=1"><b>粗</b><script>window.__xss=2<\/script>';
    const f = photographerFake({ accounts: [{ ...ACCT, display_name: EVIL }] });
    f.st.sessions.set('sess-1', ACCT.id);
    const m = dashSettingsMock({ token: a => !!f.accountOf(a) });
    await suite('studio who — markup in display_name is text (stored XSS), header and cache',
      `${base}/dashboard.html`,
      async page => {
        const { out, ok } = lines();
        await waitWho(page);
        await page.waitForTimeout(300);
        const w = await who(page);
        ok('the literal markup is the text, character for character', !!w && w.text === EVIL, JSON.stringify(w));
        ok('no element was created from it (no img / b / script inside the label; only the two spans)', !!w && w.imgs === 0 && w.kids === 2, JSON.stringify(w));
        ok('the title is the raw string (an attribute, not markup)', !!w && w.title === EVIL);
        ok('nothing executed', (await page.evaluate(() => window.__xss)) === undefined);
        ok('no stray img[src=x] anywhere in the page', (await page.$$('img[src="x"]')).length === 0);
        return out;
      },
      { before: both(m, f), initScript: seed('sess-1', true) });
  }

  // ── 3. Tim's token: studio name from settings, else the fixed fallback; one read, nothing from /api/photographer ───
  for (const [label, studio, want] of [['with a studio_name', '森林攝影', '森林攝影'], ['without a studio_name', null, '攝影師']]) {
    const f = photographerFake({ accounts: [ACCT] });
    const m = dashSettingsMock({ token: 'adm', settings: { studio_name: studio } });
    await suite(`studio who — Tim's token ${label} on orders.html: ${want}, ONE settings read, no /api/photographer call`,
      `${base}/orders.html`,
      async page => {
        const { out, ok } = lines();
        await waitWho(page);
        const w = await who(page);
        ok(`the label is ${want}`, !!w && w.shown && w.text === want && w.beforeLogout, JSON.stringify(w));
        ok('exactly one GET /api/admin/settings, with Tim’s token (orders.html made none before)', setReads(m).length === 1 && setReads(m)[0].auth === 'Bearer adm', JSON.stringify(setReads(m)));
        ok('API-silent otherwise: no /api/photographer/* call at all', f.st.calls.length === 0, JSON.stringify(f.st.calls));
        const c = JSON.parse(await cache(page) || 'null');
        ok('cached for the token', !!c && c.t === 'adm' && c.name === want, JSON.stringify(c));
        return out;
      },
      { before: both(m, f), initScript: seed('adm', false) });
  }

  // ── 4. long name: ellipsis, title, 登出 still on screen ─────────────────────────────────────────────────────────────────
  {
    const LONG = '非常非常長的攝影工作室名稱一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥';
    const f = photographerFake({ accounts: [{ ...ACCT, display_name: LONG }] });
    f.st.sessions.set('sess-1', ACCT.id);
    const m = dashSettingsMock({ token: a => !!f.accountOf(a) });
    await suite('studio who — a long name is cut with an ellipsis (max-width), the title keeps all of it, 登出 stays on screen',
      `${base}/dashboard.html`,
      async page => {
        const { out, ok } = lines();
        await waitWho(page);
        const w = await who(page);
        ok('the DOM text is the full name (cut by CSS, not by JS)', !!w && w.text === LONG && w.title === LONG, JSON.stringify(w));
        ok('the name box is narrower than its text (really overflowing) with text-overflow: ellipsis and nowrap', !!w && w.nameOverflow && w.ellipsis === 'ellipsis' && w.nameWs === 'nowrap', JSON.stringify(w));
        ok('and capped (<= 200px)', !!w && w.nameW > 0 && w.nameW <= 200, JSON.stringify(w));
        ok('登出 still fully inside the viewport, on one header row', !!w && w.logoutShown && w.logoutRight <= w.iw && w.sw <= w.iw && w.hdrH <= 60, JSON.stringify(w));
        return out;
      },
      { before: both(m, f), initScript: seed('sess-1', true) });
  }

  // ── 5. phone: initial only, 登出 stays in the header, no wrap / overflow ───────────────────────────────────────────────
  for (const [page_, sel, navSel] of [['dashboard.html', '#logout-btn', '#sideNav .side-nav-list'], ['admin.html', '#logout-btn', '#sideNav .side-nav-list'], ['orders.html', '#logout-btn', '#sideNav .side-nav-list'], ['settings.html', '#logout-btn', '#sideNav .side-nav-list']]) {
    const f = photographerFake({ accounts: [{ ...ACCT, display_name: '陳小安工作室很長的名字' }] });
    f.st.sessions.set('sess-1', ACCT.id);
    const m = dashSettingsMock({ token: a => !!f.accountOf(a) });
    await suite(`studio who — phone 390px ${page_}: the header shows the initial only, 登出 stays on screen, the header and the nav row do not wrap`,
      `${base}/${page_}`,
      async page => {
        const { out, ok } = lines();
        await waitWho(page);
        const w = await who(page, sel);
        ok('the initial circle is shown (real element, computed)', !!w && w.shown && w.iniShown && w.iniDisp !== 'none' && w.ini === '陳', JSON.stringify(w));
        ok('the name text is not shown on a phone (computed display none, zero width)', !!w && w.nameDisp === 'none' && !w.nameShown, JSON.stringify(w));
        ok('title still holds the full name', !!w && w.title === '陳小安工作室很長的名字');
        ok('登出 is visible and fully inside 390px, name right before it', !!w && w.logoutShown && w.logoutRight <= w.iw && w.logoutLeft >= 0 && w.beforeLogout, JSON.stringify(w));
        ok('the header is one bar (<= 60px, its content does not overflow, 登出 inside it) and the page has no sideways scroll', !!w && w.hdrH <= 60 && w.hdrScroll && w.logoutInHdr && w.sw <= w.iw, JSON.stringify(w));
        ok('the initial sits inside the header', !!w && w.whoTop >= w.hdrTop - 1 && w.whoBottom <= w.hdrBottom + 1, JSON.stringify(w));
        const nav = await page.$eval(navSel, e => ({ fd: getComputedStyle(e).flexDirection, wrap: getComputedStyle(e).flexWrap, h: e.getBoundingClientRect().height, items: e.querySelectorAll('.side-nav-item').length }));
        ok('the pill row is still one row of pills (row, nowrap, <= 60px tall, floor: 8 pills)', nav.fd === 'row' && nav.wrap === 'nowrap' && nav.h <= 60 && nav.items >= 8, JSON.stringify(nav));
        return out;
      },
      { before: both(m, f), initScript: seed('sess-1', true), contextOptions: MOBILE });
  }

  // ── 6. logout: the label goes, the cache is cleared ─────────────────────────────────────────────────────────────────────
  {
    const f = photographerFake({ accounts: [ACCT] });
    f.st.sessions.set('sess-1', ACCT.id);
    const m = dashSettingsMock({ token: a => !!f.accountOf(a) });
    await suite('studio who — logout (dashboard): leaves for home.html and studio_who is gone with the token',
      `${base}/dashboard.html`,
      async page => {
        const { out, ok } = lines();
        await waitWho(page);
        ok('cached before logout', (await cache(page)) !== null);
        await page.click('#logout-btn');
        await page.waitForURL('**/home.html', { timeout: 5000 });
        const s = await page.evaluate(() => ({ t: sessionStorage.getItem('studio_token'), w: sessionStorage.getItem('studio_who'), all: JSON.stringify(sessionStorage) }));
        ok('token, session and the name cache are all gone', s.t === null && s.w === null && !s.all.includes(ACCT.display_name), JSON.stringify(s));
        ok('no label on home.html', (await page.$(WHO)) === null);
        return out;
      },
      { before: both(m, f), initScript: seed('sess-1', true) });
  }
  {
    // admin.html logs out in place (login view toggles back): the label must leave the DOM too
    const f = photographerFake({ accounts: [ACCT] });
    const m = dashSettingsMock({ token: 'adm', settings: { studio_name: '森林攝影' } });
    await suite('studio who — admin.html: Tim signs in with the token form, the label appears; 登出 removes it from the DOM and clears the cache',
      `${base}/admin.html`,
      async page => {
        const { out, ok } = lines();
        ok('before login there is no label (login view)', (await page.$(WHO)) === null || !(await who(page)).shown);
        await page.fill('#admin-token-input', 'adm');
        await page.click('#admin-login-btn');
        await waitWho(page);
        const w = await who(page);
        ok('after the form login the label shows the studio name before 登出', !!w && w.shown && w.text === '森林攝影' && w.beforeLogout, JSON.stringify(w));
        ok('no /api/photographer call for Tim’s token (admin.html reads settings for its own forms too, so no count here)', setReads(m).length >= 1 && f.st.calls.length === 0, JSON.stringify([setReads(m).length, f.st.calls]));
        await page.click('#logout-btn');
        await page.waitForFunction(() => !document.querySelector('.studio-who'), null, { timeout: 3000 });
        ok('the label is gone from the DOM', (await page.$(WHO)) === null);
        ok('and the cache with the token', (await cache(page)) === null && (await page.evaluate(() => sessionStorage.getItem('studio_token'))) === null);
        // sign in again with the same token: shown again (not stuck gone)
        await page.fill('#admin-token-input', 'adm');
        await page.click('#admin-login-btn');
        await waitWho(page);
        ok('signing in again brings it back', (await who(page)).text === '森林攝影');
        return out;
      },
      { before: both(m, f) });
  }

  // ── 7. /me failure: the page keeps working ───────────────────────────────────────────────────────────────────────────────
  for (const [label, brk] of [['500', 'status'], ['network error', 'abort']]) {
    const f = photographerFake({ accounts: [ACCT] });
    f.st.sessions.set('sess-1', ACCT.id);
    const m = dashSettingsMock({ token: a => !!f.accountOf(a) });
    let asked = 0;
    await suite(`studio who — /me fails (${label}): nothing shown, no cache, the dashboard still renders its menu and 登出 works`,
      `${base}/dashboard.html`,
      async page => {
        const { out, ok } = lines();
        await page.waitForSelector('#sideNav .side-nav-item', { timeout: 5000 });
        await page.waitForFunction(() => true);
        await page.waitForTimeout(600);
        ok('/me really was asked (the failure was exercised)', asked >= 1, `asked=${asked}`);
        ok('no label shown (an absent element is the expected state; the header is intact)', (await page.$(WHO)) === null && (await page.$('header .brand')) !== null);
        ok('nothing cached from a failure', (await cache(page)) === null);
        ok('the side menu has all its items (floor 8) and 登出 is visible', (await page.$$('#sideNav .side-nav-item')).length >= 8 && (await page.$eval('#logout-btn', e => e.getClientRects().length > 0)));
        await page.click('#logout-btn');
        await page.waitForURL('**/home.html', { timeout: 5000 });
        ok('登出 still leaves the page', true);
        return out;
      },
      { before: async page => {
          await both(m, f)(page);
          if (brk === 'abort') await page.route('**/api/photographer/me', r => { asked++; r.abort(); });
          else await page.route('**/api/photographer/me', r => { asked++; r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }); });
        }, initScript: seed('sess-1', true) });
  }
  {
    // Tim's token: the settings read fails -> nothing shown, page fine
    const f = photographerFake({ accounts: [ACCT] });
    const m = dashSettingsMock({ token: 'adm' });
    await suite('studio who — Tim’s settings read fails (500): no label, no cache, the page still works',
      `${base}/orders.html`,
      async page => {
        const { out, ok } = lines();
        await page.waitForSelector('#sideNav .side-nav-item', { timeout: 5000 });
        await page.waitForTimeout(600);
        ok('no label, no cache', (await page.$(WHO)) === null && (await cache(page)) === null);
        ok('menu and 登出 present', (await page.$$('#sideNav .side-nav-item')).length >= 8 && (await page.$eval('#logout-btn', e => e.getClientRects().length > 0)));
        return out;
      },
      { before: async page => { await both(m, f)(page); await page.route('**/api/admin/settings', r => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' })); }, initScript: seed('adm', false) });
  }

  // ── 8. the cache: reused across pages, ignored for another token, shown without waiting ──────────────────────────────────
  {
    const f = photographerFake({ accounts: [ACCT] });
    f.st.sessions.set('sess-1', ACCT.id);
    const m = dashSettingsMock({ token: a => !!f.accountOf(a) });
    await suite('studio who — cache: orders → admin → dashboard → settings share one /me; the name is on every page',
      `${base}/dashboard.html`,
      async page => {
        const { out, ok } = lines();
        await waitWho(page);
        const seen = [];
        for (const p of ['orders.html', 'admin.html', 'dashboard.html', 'settings.html']) {
          await page.goto(`${base}/${p}`, { waitUntil: 'load' });
          await waitWho(page);
          const w = await who(page);
          seen.push([p, w && w.text, w && w.beforeLogout]);
        }
        ok('the name showed on all four pages, before 登出', seen.every(s => s[1] === ACCT.display_name && s[2] === true), JSON.stringify(seen));
        // settings.html asks /me for its own account form (email, must_change): that one call is the page's, not the label's,
        // and it is shared with the label rather than doubled (the label was already there from the cache)
        ok('/me: once for orders, admin and dashboard together, plus settings.html’s own account-form call (2 in all, not 5)', me(f).length === 2, `calls=${me(f).length}`);
        return out;
      },
      { before: both(m, f), initScript: seed('sess-1', true) });
  }
  {
    const f = photographerFake({ accounts: [ACCT] });
    f.st.sessions.set('sess-1', ACCT.id);
    const m = dashSettingsMock({ token: a => !!f.accountOf(a) });
    await suite('studio who — a cached name is drawn at once with no /me; a cache written for ANOTHER token is ignored and replaced',
      `${base}/dashboard.html`,
      async page => {
        const { out, ok } = lines();
        // first load: cache says 快取名 for sess-1
        await page.waitForSelector(`${WHO} .studio-who-name`, { timeout: 5000 });
        const w = await who(page);
        ok('the cached name is shown', w.text === '快取名', JSON.stringify(w));
        await page.waitForTimeout(500);
        ok('and /me was not asked at all', me(f).length === 0, `calls=${me(f).length}`);
        // now the cache belongs to somebody else's token -> must not be used, must be fetched
        await page.evaluate(() => sessionStorage.setItem('studio_who', JSON.stringify({ t: 'other-token', name: '別人' })));
        await page.reload({ waitUntil: 'load' });
        await waitWho(page);
        await page.waitForFunction(n => document.querySelector('.studio-who-name').textContent === n, ACCT.display_name, { timeout: 4000 });
        const c = JSON.parse(await cache(page));
        ok('the other token’s name is replaced by the session’s own name, fetched once', me(f).length === 1 && c.t === 'sess-1' && c.name === ACCT.display_name, JSON.stringify([me(f).length, c]));
        // a corrupt cache is harmless
        await page.evaluate(() => sessionStorage.setItem('studio_who', '{not json'));
        await page.reload({ waitUntil: 'load' });
        await waitWho(page);
        ok('a corrupt cache is ignored and the name still arrives', (await who(page)).text === ACCT.display_name);
        return out;
      },
      { before: both(m, f), initScript: seed('sess-1', true, `sessionStorage.setItem('studio_who', JSON.stringify({ t: 'sess-1', name: '快取名' }));`) });
  }
  {
    // a new token (change-password swaps it) refetches under the new token
    const f = photographerFake({ accounts: [ACCT] });
    f.st.sessions.set('sess-1', ACCT.id);
    const m = dashSettingsMock({ token: a => !!f.accountOf(a) });
    await suite('studio who — the token changes (a new session for the same account): the name is looked up again under the new token',
      `${base}/dashboard.html`,
      async page => {
        const { out, ok } = lines();
        await waitWho(page);
        f.st.sessions.set('sess-2', ACCT.id);
        f.st.accounts[0].display_name = '小安二';
        await page.evaluate(() => { sessionStorage.setItem('studio_token', 'sess-2'); sessionStorage.setItem('studio_session', JSON.stringify({ t: 'sess-2', must: false })); });
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => document.querySelector('.studio-who-name') && document.querySelector('.studio-who-name').textContent === '小安二', null, { timeout: 4000 });
        const c = JSON.parse(await cache(page));
        ok('re-fetched once more, cache now tied to the new token', me(f).length === 2 && me(f)[1].auth === 'Bearer sess-2' && c.t === 'sess-2' && c.name === '小安二', JSON.stringify([me(f).map(x => x.auth), c]));
        return out;
      },
      { before: both(m, f), initScript: seed('sess-1', true) });
  }

  // ── 9. settings.html: saving the studio name updates Tim's label ─────────────────────────────────────────────────────────
  {
    const f = photographerFake({ accounts: [ACCT] });
    const m = dashSettingsMock({ token: 'adm', settings: { studio_name: '舊名' } });
    await suite('studio who — settings.html (Tim): saving a new studio_name updates the label and the cache without another read',
      `${base}/settings.html`,
      async page => {
        const { out, ok } = lines();
        await waitWho(page);
        ok('starts as the stored name', (await who(page)).text === '舊名');
        await page.waitForFunction(() => document.getElementById('set-studio-name') && document.getElementById('set-studio-name').value === '舊名');
        await page.fill('#set-studio-name', '新名');
        const before = setReads(m).length;
        await page.click('#set-save-btn');
        await page.waitForFunction(() => document.querySelector('.studio-who-name').textContent === '新名', null, { timeout: 4000 });
        const c = JSON.parse(await cache(page));
        ok('label and cache show the new name', (await who(page)).text === '新名' && c.name === '新名', JSON.stringify(c));
        ok('no extra settings read to learn it', setReads(m).length === before, `${before} -> ${setReads(m).length}`);
        return out;
      },
      { before: both(m, f), initScript: seed('adm', false) });
  }

  // ── 10. index.html (the photographer's own picker): next to #studio-logout; phone: the menu line ───────────────────────────
  for (const [label, ctx] of [['desktop 1280', { viewport: { width: 1280, height: 900 } }], ['phone 390', MOBILE]]) {
    const phone = ctx === MOBILE;
    const m = pickFakeWorker({ folders: ['shoot/毛片/'] });
    let reads = 0;
    await suite(`studio who — index.html (Tim's token, ${label}): ${phone ? 'initial hidden in the header, full name in the ☰ menu above 登出' : 'the studio name right before 登出 in the header'}`,
      `${base}/index.html`,
      async page => {
        const { out, ok } = lines();
        await page.waitForSelector('#studio-logout', { state: 'attached', timeout: 6000 });
        await page.waitForSelector(`${WHO} .studio-who-name`, { state: 'attached', timeout: 6000 });
        const w = await who(page, '#studio-logout');
        ok('the label is the studio name, next to #studio-logout inside .header-right', !!w && w.text === '森林攝影' && w.beforeLogout && (await page.$('.header-right .studio-who')) !== null, JSON.stringify(w));
        ok('one settings read', reads === 1, `reads=${reads}`);
        if (!phone) {
          ok('desktop: the name text is shown, the header row does not overflow', !!w && w.shown && w.nameShown && w.logoutShown && w.logoutRight <= w.iw && w.sw <= w.iw, JSON.stringify(w));
        } else {
          ok('phone: nothing of it in the header (the header cannot take it)', !!w && !w.shown, JSON.stringify(w));
          const menu = await page.evaluate(() => {
            const el = document.querySelector('#phoneMenu .studio-who'), out = document.getElementById('phoneLogoutBtn');
            return el ? { text: el.querySelector('.studio-who-name').textContent, before: el.nextElementSibling === out, disp: getComputedStyle(el.querySelector('.studio-who-name')).display } : null;
          });
          ok('the ☰ menu carries the full name line right above 登出 (real element, name visible)', !!menu && menu.text === '森林攝影' && menu.before && menu.disp !== 'none', JSON.stringify(menu));
        }
        await page.evaluate(() => document.getElementById('studio-logout').click());
        await page.waitForTimeout(300);
        return out;
      },
      { before: async page => {
          await m.attach(page);
          await page.route('**/api/admin/settings', r => { if (r.request().method() === 'GET') { reads++; return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ studio_name: '森林攝影', has_logo: false }) }); } return r.fallback(); });
        }, initScript: seed('adm', false), contextOptions: ctx });
  }
}
