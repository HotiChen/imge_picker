// Browser suites: operator page 邀請攝影師 panel. The 8-digit code is shown once (never stored, gone from the DOM
// once closed), a ready-to-copy message carries the registration page + code + the 1-hour / one-email rule, the list
// shows each invite's state with 撤銷 on live ones, and every error code has a Chinese sentence.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { OP_KEY, OP_SEED, PLAT_ALBUM, T, clone, disp, ordersFake, waitText } from '../lib/orders-fake.mjs';

export default async function register() {

// A fake of /api/operator/photographer-invites* mirroring worker.js: the operator token or 401; the method / route
// (405 / 404); POST {email, note?} -> 201 {id, email, code, expires_at, note, replaced} (the code only in this answer,
// never in the list), 400 invalid_email / invalid_note, 409 email_taken (an account has it) / invite_limit (10 live),
// one live code per email (a new one revokes the old: replaced), 500 invites_unavailable; GET -> {invites: [...]}
// newest first with state live | used | revoked | expired and who used it; POST /:id/revoke -> {ok, invite} (a repeat
// changes nothing, 404 for an unknown id).
function invitesFake({ invites = [], accounts = [], unavailable = false, operatorToken = 'op', liveMax = 10 } = {}) {
  const st = { invites: clone(invites), accounts: clone(accounts), calls: [], seq: 0, codes: [], unavailable, inject: null };
  const NOW = () => new Date().toISOString();
  const view = i => {
    const state = i.used_at ? 'used' : i.revoked_at ? 'revoked' : i.expires_at > NOW() ? 'live' : 'expired';
    const { id, email, note, created_at, expires_at, used_at, used_by, revoked_at, used_by_email, used_by_name } = i;
    return { id, email, note: note ?? null, state, created_at, expires_at, used_at: used_at ?? null, used_by: used_by ?? null, used_by_email: used_by_email ?? null, used_by_name: used_by_name ?? null, revoked_at: revoked_at ?? null };
  };
  const live = () => st.invites.filter(i => view(i).state === 'live');
  function handle(method, path, bodyText) {
    const parts = path.split('/').filter(Boolean); // api operator photographer-invites [id] [revoke]
    const [, , , id, action] = parts;
    const route = !id ? 'invites' : action === 'revoke' && parts.length === 5 ? 'revoke' : null;
    if (!route) return { status: 404, body: { error: 'Not found' } };
    if (!(route === 'invites' ? ['GET', 'POST'] : ['POST']).includes(method)) return { status: 405, body: { error: 'Method not allowed' } };
    const inj = st.inject && st.inject(method, path);
    if (inj) return inj;
    if (st.unavailable) return { status: 500, body: { error: '邀請碼功能尚未啟用', code: 'invites_unavailable' } };
    if (route === 'invites' && method === 'GET') return { body: { invites: st.invites.slice().reverse().map(view) } };
    if (route === 'invites') {
      let b = {};
      try { b = JSON.parse(bodyText || '{}'); } catch (e) { return { status: 400, body: { error: 'Invalid JSON' } }; }
      const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 400, body: { error: 'Email 格式不正確', code: 'invalid_email' } };
      const note = typeof b.note === 'string' ? b.note.trim() : '';
      if ([...note].length > 200 || /[\n\r]/.test(note)) return { status: 400, body: { error: '備註最多 200 字，且只能一行', code: 'invalid_note' } };
      if (st.accounts.some(a => a.email === email)) return { status: 409, body: { error: '這個 Email 已經有帳號', code: 'email_taken' } };
      let replaced = 0;
      for (const i of live()) if (i.email === email) { i.revoked_at = NOW(); replaced++; }
      if (live().length >= liveMax) return { status: 409, body: { error: `尚未使用的邀請碼最多 ${liveMax} 組，請先撤銷不用的`, code: 'invite_limit', max: liveMax } };
      const code = String(10000000 + ((++st.seq * 7919123) % 89999999));
      st.codes.push(code);
      const inv = { id: `inv${st.seq}`, email, note: note || null, created_at: NOW(), expires_at: new Date(Date.now() + 3600e3).toISOString() };
      st.invites.push(inv);
      return { status: 201, body: { id: inv.id, email, code, expires_at: inv.expires_at, note: inv.note, replaced } };
    }
    const inv = st.invites.find(i => i.id === id);
    if (!inv) return { status: 404, body: { error: 'Not found' } };
    if (!inv.used_at && !inv.revoked_at) inv.revoked_at = NOW();
    return { body: { ok: true, invite: view(inv) } };
  }
  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/api/operator/photographer-invites**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const h = await req.allHeaders();
      st.calls.push({ method: req.method(), path: u.pathname, auth: h['authorization'] || null, body: req.postData() || null });
      if ((h['authorization'] || null) !== `Bearer ${operatorToken}`)
        return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Unauthorized' }) });
      const res = handle(req.method(), u.pathname, req.postData());
      route.fulfill({ status: res.status || 200, contentType: 'application/json', body: JSON.stringify(res.body) });
    });
  };
  return { st, attach };
}

const CLIP = `(${OP_SEED.toString()})();
  window.__clip = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { window.__clip.push(t); } } });`;
const both = (...fakes) => async page => { for (const f of fakes) await f.attach(page); };
const row = id => `#inv-list .inv-row[data-invite-id="${id}"]`;
const EMAIL = 'friend@example.com';
const past = h => new Date(Date.now() - h * 3600e3).toISOString();
const future = h => new Date(Date.now() + h * 3600e3).toISOString();
const SEEDED = () => [
  { id: 'i-live', email: 'live@example.com', note: '婚攝朋友', created_at: past(0.2), expires_at: future(0.8) },
  { id: 'i-used', email: 'used@example.com', note: null, created_at: past(5), expires_at: past(4), used_at: past(4.5), used_by: 'ph-9', used_by_email: '<b id="evil">u</b>used@example.com', used_by_name: '<img src=x onerror="window.__xss2=1">小晴' },
  { id: 'i-rev', email: 'rev<i id="evil2">x</i>@example.com', note: null, created_at: past(6), expires_at: future(0.5), revoked_at: past(5.9) },
  { id: 'i-exp', email: 'exp@example.com', note: '<img src=x onerror="window.__xss=1">', created_at: past(9), expires_at: past(8) },
];
const state = (page, id) => page.getAttribute(`${row(id)} .inv-state`, 'data-state').catch(() => null);

{
  const o = ordersFake({ platform: [clone(PLAT_ALBUM)], products: [] });
  const f = invitesFake({ invites: SEEDED() });
  await suite('operator invites — the list: state badges, revoke only on live ones, notes are text, no code anywhere',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const dialogs = [];
      let answer = true;
      page.on('dialog', d => { dialogs.push(d.message()); answer ? d.accept() : d.dismiss(); });
      await page.waitForSelector(row('i-live'), { timeout: 5000 });
      ok('the list was read with the operator token', f.st.calls.some(c => c.method === 'GET' && c.path === '/api/operator/photographer-invites' && c.auth === 'Bearer op'), JSON.stringify(f.st.calls));
      ok('a panel titled 邀請攝影師 exists', (await page.$$eval('h2', hs => hs.some(h => h.textContent.includes('邀請攝影師')))));
      ok('four rows, states live / used / revoked / expired', (await state(page, 'i-live')) === 'live' && (await state(page, 'i-used')) === 'used' &&
        (await state(page, 'i-rev')) === 'revoked' && (await state(page, 'i-exp')) === 'expired', `${await state(page, 'i-live')},${await state(page, 'i-used')},${await state(page, 'i-rev')},${await state(page, 'i-exp')}`);
      const label = id => page.textContent(`${row(id)} .inv-state`);
      ok('the badges read in Chinese: 可使用 / 已使用 / 已撤銷 / 已過期', [await label('i-live'), await label('i-used'), await label('i-rev'), await label('i-exp')].join() === '可使用,已使用,已撤銷,已過期');
      ok('a used invite says who registered with it', (await page.textContent(row('i-used'))).includes('小晴') && (await page.textContent(row('i-used'))).includes('used@example.com'));
      ok('markup in who-registered (name and email) is text: no element created, no script ran',
        (await page.$(`${row('i-used')} img`)) === null && (await page.$('#evil')) === null && (await page.$('#evil2')) === null && (await page.evaluate(() => window.__xss2)) === undefined &&
        (await page.textContent(row('i-used'))).includes('<img src=x') && (await page.textContent(row('i-used'))).includes('<b id="evil">'));
      ok('email and note are shown', (await page.textContent(row('i-live'))).includes('live@example.com') && (await page.textContent(row('i-live'))).includes('婚攝朋友'));
      ok('撤銷 exists on the live row only', (await page.$(`${row('i-live')} button[data-action="revoke"]`)) !== null &&
        (await page.$$eval('#inv-list button[data-action="revoke"]', bs => bs.length)) === 1);
      ok('a note with markup is shown as text: no <img>, no script ran', (await page.$('#inv-list img')) === null && (await page.evaluate(() => window.__xss)) === undefined &&
        (await page.textContent(row('i-exp'))).includes('<img src=x'));
      ok('the list holds no 8-digit code', !/\b\d{8}\b/.test(await page.textContent('#inv-list')));

      answer = false;
      let before = f.st.calls.length;
      await page.click(`${row('i-live')} button[data-action="revoke"]`);
      await page.waitForTimeout(200);
      ok('撤銷 asks first, naming the email; dismissing sends nothing', dialogs.length === 1 && dialogs[0].includes('live@example.com') && f.st.calls.length === before, JSON.stringify(dialogs));
      answer = true;
      await page.click(`${row('i-live')} button[data-action="revoke"]`);
      await waitText(page, '#inv-ok', t => t.includes('已撤銷'));
      ok('撤銷 confirmed: POST .../i-live/revoke and the row turns 已撤銷 with no button', f.st.calls.some(c => c.method === 'POST' && c.path === '/api/operator/photographer-invites/i-live/revoke' && c.auth === 'Bearer op') &&
        (await state(page, 'i-live')) === 'revoked' && (await page.$(`${row('i-live')} button[data-action="revoke"]`)) === null);

      // a 404 (gone) is said, the list re-read
      f.st.invites.find(i => i.id === 'i-exp').expires_at = future(1);   // becomes live on the next read
      await page.click('#inv-refresh');
      await page.waitForSelector(`${row('i-exp')} button[data-action="revoke"]`, { timeout: 4000 });
      ok('the refresh button re-reads the list', (await state(page, 'i-exp')) === 'live');
      f.st.invites.push({ id: 'i-ghost', email: 'ghost@example.com', created_at: past(0.1), expires_at: future(0.9) });
      await page.click('#inv-refresh');
      await page.waitForSelector(row('i-ghost'), { timeout: 4000 });
      f.st.inject = (m, p) => (p.endsWith('/i-ghost/revoke') ? { status: 404, body: { error: 'Not found' } } : null);
      await page.click(`${row('i-ghost')} button[data-action="revoke"]`);
      await waitText(page, '#inv-err', t => t.length > 0);
      ok('a failed revoke shows a sentence in #inv-err', (await T(page, '#inv-err')).length > 0);

      // the operator token stopped working: the page signs out and leaves no old message behind
      f.st.invites.push({ id: 'i-late', email: 'late@example.com', created_at: past(0.1), expires_at: future(0.9) });
      f.st.inject = null;
      await page.click('#inv-refresh');
      await page.waitForSelector(row('i-late'), { timeout: 4000 });
      f.st.inject = (m, p) => (p.endsWith('/i-late/revoke') ? { status: 401, body: { error: 'Unauthorized' } } : null);
      await page.click(`${row('i-late')} button[data-action="revoke"]`);
      await page.waitForSelector('#op-login:not([hidden])', { timeout: 4000 });
      await page.waitForTimeout(250);   // the handler runs on after the sign-out; give a wrong write time to land
      ok('a 401 on revoke signs out: the login box shows, the list is gone and no error text is left in the hidden panel',
        (await disp(page, '#op-login')) !== 'none' && (await page.$('#inv-list .inv-row')) === null && (await T(page, '#inv-err')) === '', await T(page, '#inv-err'));
      return out;
    },
    { before: both(o, f), initScript: CLIP });
}

{
  const o = ordersFake({ platform: [clone(PLAT_ALBUM)], products: [] });
  const f = invitesFake({ accounts: [{ email: 'taken@example.com' }] });
  await suite('operator invites — create: the code is shown once with a copy button and a ready-to-copy message, then gone',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#inv-email', { timeout: 5000 });
      ok('the result box is hidden at first (computed display)', (await disp(page, '#inv-result')) === 'none');
      ok('email is required, note optional (labels say so)', (await page.textContent('label[for="inv-email"]')).includes('必填') && (await page.textContent('label[for="inv-note"]')).includes('選填'));

      // client check: an empty email sends nothing
      await page.click('#inv-create');
      ok('an empty email is refused on the page, nothing sent', (await T(page, '#inv-err')).includes('Email') && !f.st.calls.some(c => c.method === 'POST'));

      await page.fill('#inv-email', `  ${EMAIL} `);
      await page.fill('#inv-note', '攝影社學長');
      await page.click('#inv-create');
      await page.waitForSelector('#inv-result:not([hidden])', { timeout: 4000 });
      const code = f.st.codes[0];
      const post = f.st.calls.find(c => c.method === 'POST');
      ok('POST {email, note} with the operator token', !!post && post.path === '/api/operator/photographer-invites' && post.auth === 'Bearer op' &&
        JSON.parse(post.body).email.trim() === EMAIL && JSON.parse(post.body).note === '攝影社學長', post && post.body);
      ok('the result box is visible and shows the 8-digit code', (await disp(page, '#inv-result')) !== 'none' && (await T(page, '#inv-code')).trim() === code && /^\d{8}$/.test(code), code);
      ok('it says the code is shown this once', (await T(page, '#inv-result')).includes('只顯示這一次'));
      const msg = await page.inputValue('#inv-message');
      ok('the message holds the registration page URL, the code, the email, 1 hour and the one-email rule',
        msg.includes(`${base}/register.html`) && msg.includes(code) && msg.includes(EMAIL) && msg.includes('1 小時') && /只能|限/.test(msg) , msg);
      ok('the message textarea is read-only', (await page.getAttribute('#inv-message', 'readonly')) !== null);
      ok('the new invite appears in the list as live, with no code in it', (await page.$$eval('#inv-list .inv-state[data-state="live"]', e => e.length)) === 1 && !(await page.textContent('#inv-list')).includes(code));

      await page.click('#inv-copy-code');
      await waitText(page, '#inv-ok', t => t.includes('已複製'));
      ok('複製邀請碼 puts exactly the code on the clipboard', JSON.stringify(await page.evaluate(() => window.__clip)) === JSON.stringify([code]));
      await page.click('#inv-copy-msg');
      await page.waitForFunction(() => window.__clip.length === 2);
      ok('複製邀請訊息 puts the whole message on the clipboard', (await page.evaluate(() => window.__clip[1])) === msg);

      const where = () => page.evaluate(c => ({
        html: document.documentElement.outerHTML.includes(c),
        values: [...document.querySelectorAll('input, textarea')].some(e => e.value.includes(c)),
        text: document.body.innerText.includes(c),
        ls: Object.keys(localStorage).some(k => (localStorage.getItem(k) || '').includes(c) || k.includes(c)),
        ss: Object.keys(sessionStorage).some(k => (sessionStorage.getItem(k) || '').includes(c)),
      }), code);
      const w1 = await where();
      ok('while shown the code is on the page, but in no storage', (w1.text || w1.values) && !w1.ls && !w1.ss, JSON.stringify(w1));

      await page.click('#inv-close');
      const w2 = await where();
      ok('關閉 hides the box and removes the code from the DOM, every field and all storage', (await disp(page, '#inv-result')) === 'none' && !w2.html && !w2.values && !w2.text && !w2.ls && !w2.ss, JSON.stringify(w2));
      ok('the email field is cleared for the next invite', (await page.inputValue('#inv-email')) === '');

      // make another, then leave by signing out: gone too
      await page.fill('#inv-email', 'second@example.com');
      await page.click('#inv-create');
      await page.waitForSelector('#inv-result:not([hidden])', { timeout: 4000 });
      const code2 = f.st.codes[1];
      ok('a second code is different and is shown', code2 !== code && (await T(page, '#inv-code')).trim() === code2);
      await page.click('#op-logout');
      const w3 = await page.evaluate(c => ({ html: document.documentElement.outerHTML.includes(c), values: [...document.querySelectorAll('input, textarea')].some(e => e.value.includes(c)) }), code2);
      ok('登出 clears the code, the message and the list', !w3.html && !w3.values && (await page.$('#inv-list .inv-row')) === null, JSON.stringify(w3));
      ok('every call carried the operator token', f.st.calls.every(c => c.auth === 'Bearer op'));
      return out;
    },
    { before: both(o, f), initScript: CLIP });
}

{
  const o = ordersFake({ platform: [clone(PLAT_ALBUM)], products: [] });
  const f = invitesFake({ accounts: [{ email: 'taken@example.com' }] });
  await suite('operator invites — replacing a live code, and every error code has a Chinese sentence',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#inv-email', { timeout: 5000 });
      const create = async (email, note = '') => {
        const n = f.st.calls.filter(c => c.method === 'POST').length;
        await page.fill('#inv-email', email);
        await page.fill('#inv-note', note);
        await page.click('#inv-create');
        await page.waitForTimeout(350);
        return f.st.calls.filter(c => c.method === 'POST').length - n;
      };
      const err = () => T(page, '#inv-err');

      await create('same@example.com');
      await page.click('#inv-close');
      await create('same@example.com');
      ok('a second code for the same email says the earlier unused code was revoked',
        (await T(page, '#inv-replaced')).includes('先前') && (await disp(page, '#inv-replaced')) !== 'none');
      ok('the old one shows 已撤銷 and the new one 可使用', (await page.$$eval('#inv-list .inv-state', e => e.map(x => x.dataset.state).sort().join())) === 'live,revoked');
      await page.click('#inv-close');

      await create('not-an-email');
      ok('invalid_email -> Email 格式不正確', (await err()).includes('Email'), await err());
      await create('taken@example.com');
      ok('email_taken -> 已經有帳號', (await err()).includes('已經有帳號'), await err());
      ok('no code box after a refusal', (await disp(page, '#inv-result')) === 'none');
      f.st.inject = m => (m === 'POST' ? { status: 400, body: { error: 'x', code: 'invalid_note' } } : null);
      await create('x@example.com', 'x');
      f.st.inject = null;
      ok('invalid_note -> 備註', (await err()).includes('備註'), await err());

      f.st.inject = (m) => (m === 'POST' ? { status: 409, body: { error: 'x', code: 'invite_limit', max: 10 } } : null);
      await create('limit@example.com');
      ok('invite_limit -> 最多 10 組，請先撤銷', (await err()).includes('10') && (await err()).includes('撤銷'), await err());
      f.st.inject = (m) => (m === 'POST' ? { status: 500, body: { error: 'x', code: 'invites_unavailable' } } : null);
      await create('un@example.com');
      ok('invites_unavailable -> 尚未啟用', (await err()).includes('尚未啟用'), await err());
      f.st.inject = (m) => (m === 'POST' ? { status: 413, body: { error: '資料太大', code: 'too_large' } } : null);
      await create('big@example.com');
      ok('any other answer still shows a sentence', (await err()).length > 0);
      f.st.inject = null;

      // the button locks while the request is out
      let hits = 0;
      await page.route('**/api/operator/photographer-invites', async r => {
        if (r.request().method() !== 'POST') return r.fallback();
        hits++; await new Promise(res => setTimeout(res, 400));
        r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'x', code: 'invalid_email' }) });
      });
      await page.fill('#inv-email', 'double@example.com');
      await page.click('#inv-create');
      const disabled = await page.$eval('#inv-create', b => b.disabled);
      await page.click('#inv-create', { force: true, timeout: 500 }).catch(() => {});
      await page.waitForTimeout(700);
      ok('while the request is out 產生邀請碼 is disabled: one POST only', disabled && hits === 1, `disabled=${disabled} hits=${hits}`);
      return out;
    },
    { before: both(o, f), initScript: CLIP });
}

{
  const o = ordersFake({ platform: [clone(PLAT_ALBUM)], products: [] });
  const f = invitesFake({ invites: SEEDED() });
  await suite('operator invites — phone (390px): buttons >= 44px, no sideways scroll, the message box usable',
    `${base}/operator.html`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector(row('i-live'), { timeout: 5000 });
      await page.fill('#inv-email', EMAIL);
      await page.click('#inv-create');
      await page.waitForSelector('#inv-result:not([hidden])', { timeout: 4000 });
      const sizes = await page.$$eval('#inv-create, #inv-copy-code, #inv-copy-msg, #inv-close, #inv-list button[data-action]', bs => bs.map(b => Math.round(b.getBoundingClientRect().height)));
      ok('every invite button is >= 44px tall (floor: 5 scanned)', sizes.length >= 5 && sizes.every(h => h >= 44), JSON.stringify(sizes));
      ok('no sideways scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      const box = await page.$eval('#inv-message', e => { const r = e.getBoundingClientRect(); return [r.left, r.right, window.innerWidth]; });
      ok('the message box sits inside the screen', box[0] >= 0 && box[1] <= box[2], JSON.stringify(box));
      return out;
    },
    { before: both(o, f), initScript: CLIP, contextOptions: MOBILE });
}
}
