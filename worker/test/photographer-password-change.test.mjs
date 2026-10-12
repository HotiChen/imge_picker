// Photographer accounts, batch 2a of docs/multi-photographer.md: a photographer
// changes their own password (POST /api/photographer/change-password), and a
// password reset by the operator forces that change first
// (photographers.must_change_password). While the flag is set a session opens
// only change-password, me and logout: the guard lives in resolvePhotographer,
// so every route that batch 2b opens to sessions gets it for free.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fakeDB } from './fakes.mjs';
import { SECRET, setup, call, rows, one, sha256Hex, createProject } from './pick-helpers.mjs';

const OP = 'operator-secret';
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a brand new passphrase';
const IP = '203.0.113.7';
const SRC = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');

// Turnstile always says yes here (registration is only the fixture)
const realFetch = globalThis.fetch;
before(() => { globalThis.fetch = async () => Response.json({ success: true, hostname: 'imhoti.tw' }); });
after(() => { globalThis.fetch = realFetch; });

const envOpen = (extra = {}) => setup({ OPERATOR_TOKEN: OP, PHOTOGRAPHER_SIGNUP: 'on', TURNSTILE_SECRET: 'ts', ...extra });
const register = (env, email) => call(env, '/api/photographer/register', {
  method: 'POST', headers: { 'CF-Connecting-IP': IP },
  body: { email, password: PASSWORD, display_name: '安攝影', turnstileToken: 'tt' },
});
const loginFrom = (env, ip, email = 'ann@example.com', password = PASSWORD) =>
  call(env, '/api/photographer/login', { method: 'POST', headers: ip ? { 'CF-Connecting-IP': ip } : {}, body: { email, password } });
const login = (env, email, password) => loginFrom(env, IP, email, password);
const me = (env, token) => call(env, '/api/photographer/me', { token });
const act = (env, id, action) => call(env, `/api/operator/photographers/${id}/${action}`, { method: 'POST', token: OP });
const account = (env, email = 'ann@example.com') => one(env, 'SELECT * FROM photographers WHERE email = ?', email);
const change = (env, token, body, ip = IP) => call(env, '/api/photographer/change-password', {
  method: 'POST', token, headers: ip ? { 'CF-Connecting-IP': ip } : {},
  body: body === undefined ? { current_password: PASSWORD, new_password: NEW_PASSWORD } : body,
});
const sessionsOf = (env, id) => rows(env, 'SELECT * FROM photographer_sessions WHERE photographer_id = ?', id);
const bad = async (res, status, code, label) => {
  const text = await res.text();
  assert.equal(res.status, status, `${label}: ${text}`);
  assert.equal(JSON.parse(text).code, code, label);
};

async function activeAccount(env, email = 'ann@example.com') {
  assert.equal((await register(env, email)).status, 202);
  const row = account(env, email);
  assert.equal((await act(env, row.id, 'approve')).status, 200);
  return account(env, email);
}
async function loggedIn(env, email = 'ann@example.com', password = PASSWORD) {
  const row = await activeAccount(env, email);
  return { row, token: await tokenFor(env, email, password) };
}
async function tokenFor(env, email = 'ann@example.com', password = PASSWORD) {
  const res = await login(env, email, password);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()).token;
}
// reset by the operator, then logged in with the temporary password
async function mustChange(env, email = 'ann@example.com') {
  const { row } = await loggedIn(env, email);
  const res = await act(env, row.id, 'reset-password');
  assert.equal(res.status, 200);
  const temp = (await res.json()).temp_password;
  return { row, temp, token: await tokenFor(env, email, temp) };
}

// count PBKDF2 runs (each is one deriveBits)
async function countingDerives(fn) {
  const subtle = globalThis.crypto.subtle;
  const realDerive = subtle.deriveBits;
  let n = 0;
  subtle.deriveBits = function (...a) { n++; return realDerive.apply(this, a); };
  try { await fn(); } finally { subtle.deriveBits = realDerive; }
  return n;
}

// hold the next batch whose SQL matches `re` until release(); statements are
// tagged with their SQL (test side only) so the gate can find them
function gateBatch(env, re) {
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    const stmt = realPrepare(sql);
    return { ...stmt, bind: (...a) => ({ ...stmt.bind(...a), sql }) };
  };
  const realBatch = env.DB.batch.bind(env.DB);
  let release, reached;
  const gate = new Promise(r => { release = r; });
  const atGate = new Promise(r => { reached = r; });
  let armed = true;
  env.DB.batch = async statements => {
    if (armed && statements.some(st => re.test(st.sql ?? ''))) { armed = false; reached(); await gate; }
    return realBatch(statements);
  };
  return { atGate, release };
}

// ─── the happy path ─────────────────────────────────────────────────────────

test('change-password: {ok:true}; the new password works, the old one does not', async () => {
  const env = envOpen();
  const { row, token } = await loggedIn(env);
  const before = account(env).password_hash;
  const res = await change(env, token);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Cache-Control'), /no-store/);
  assert.deepEqual(await res.json(), { ok: true });
  const after = account(env);
  assert.notEqual(after.password_hash, before);
  assert.match(after.password_hash, /^pbkdf2\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(after.must_change_password, 0);
  assert.equal(after.status, 'active');
  await bad(await login(env, 'ann@example.com', PASSWORD), 401, 'login_failed', 'old password');
  assert.equal((await login(env, 'ann@example.com', NEW_PASSWORD)).status, 200, 'new password');
  assert.equal((await me(env, token)).status, 200, 'the session that changed it is kept');
  assert.equal(account(env).id, row.id);
});

test('change-password ends every OTHER session of this photographer, and nobody else’s', async () => {
  const env = envOpen();
  const { row, token } = await loggedIn(env);
  const second = await tokenFor(env);
  const third = await tokenFor(env);
  const { token: bob } = await loggedIn(env, 'bob@example.com');
  const bobHash = account(env, 'bob@example.com').password_hash;
  assert.equal(sessionsOf(env, row.id).length, 3);
  assert.equal((await change(env, token)).status, 200);
  const left = sessionsOf(env, row.id);
  assert.equal(left.length, 1);
  assert.equal(left[0].token_hash, await sha256Hex(token));
  assert.equal((await me(env, token)).status, 200);
  assert.equal((await me(env, second)).status, 401);
  assert.equal((await me(env, third)).status, 401);
  assert.equal((await me(env, bob)).status, 200, 'another account keeps its session');
  assert.equal(account(env, 'bob@example.com').password_hash, bobHash, 'and its password');
});

test('a successful change leaves no throttle rows behind; the hash is never in a response', async () => {
  const env = envOpen();
  const { token } = await loggedIn(env);
  const before = rows(env, 'SELECT * FROM photographer_login_failures').length;
  const res = await change(env, token);
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.equal(rows(env, 'SELECT * FROM photographer_login_failures').length, before);
  assert.ok(!/pbkdf2|password_hash|token_hash/.test(text));
  const meText = await (await me(env, token)).text();
  assert.ok(!/pbkdf2|password_hash|token_hash/.test(meText));
});

// ─── forced change after an operator reset ──────────────────────────────────

test('reset-password sets must_change_password in the same write and still ends every session', async () => {
  const env = envOpen();
  const { row, token } = await loggedIn(env);
  assert.equal(account(env).must_change_password, 0);
  const res = await act(env, row.id, 'reset-password');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.temp_password, 'string');
  assert.equal(body.must_change_password, true);
  assert.equal(body.warning, undefined);
  assert.equal(account(env).must_change_password, 1);
  assert.equal(sessionsOf(env, row.id).length, 0);
  assert.equal((await me(env, token)).status, 401);
  assert.ok(!JSON.stringify(body).includes('pbkdf2'));
});

test('login and /me say must_change_password: true for a reset account, false otherwise', async () => {
  const env = envOpen();
  const { row, token: normal } = await loggedIn(env);
  const meNormal = await (await me(env, normal)).json();
  assert.deepEqual(meNormal, { photographer: { id: row.id, display_name: '安攝影', email: 'ann@example.com' }, must_change_password: false });
  const plain = await (await login(env, 'ann@example.com', PASSWORD)).json();
  assert.equal(plain.must_change_password, false);
  assert.deepEqual(Object.keys(plain).sort(), ['must_change_password', 'photographer', 'token']);

  const temp = (await (await act(env, row.id, 'reset-password')).json()).temp_password;
  const res = await login(env, 'ann@example.com', temp);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.must_change_password, true);
  assert.deepEqual(body.photographer, { id: row.id, display_name: '安攝影' });
  const meForced = await (await me(env, body.token)).json();
  assert.deepEqual(meForced, { photographer: { id: row.id, display_name: '安攝影', email: 'ann@example.com' }, must_change_password: true });
});

test('changing the temporary password clears the flag; the temporary password stops working', async () => {
  const env = envOpen();
  const { row, temp, token } = await mustChange(env);
  const res = await change(env, token, { current_password: temp, new_password: NEW_PASSWORD });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(account(env).must_change_password, 0);
  assert.equal((await (await me(env, token)).json()).must_change_password, false);
  assert.equal((await login(env, 'ann@example.com', temp)).status, 401);
  const again = await (await login(env, 'ann@example.com', NEW_PASSWORD)).json();
  assert.equal(again.must_change_password, false);
  assert.equal(sessionsOf(env, row.id).length, 2);
});

test('an odd stored flag (not 0) reads as must change: fail closed', async () => {
  const env = envOpen();
  const { row, token } = await loggedIn(env);
  env.DB._db.prepare('UPDATE photographers SET must_change_password = 2 WHERE id = ?').run(row.id);
  assert.equal((await (await me(env, token)).json()).must_change_password, true);
  env.DB._db.prepare('UPDATE photographers SET must_change_password = 0 WHERE id = ?').run(row.id);
  assert.equal((await (await me(env, token)).json()).must_change_password, false);
});

test('a flagged session can call me and logout (change-password: above)', async () => {
  const env = envOpen();
  const { row, temp, token } = await mustChange(env);
  const second = await tokenFor(env, 'ann@example.com', temp);
  assert.equal((await me(env, token)).status, 200);
  const out = await call(env, '/api/photographer/logout', { method: 'POST', token });
  assert.equal(out.status, 200);
  assert.equal((await me(env, token)).status, 401);
  assert.equal((await me(env, second)).status, 200, 'logout ends only its own session');
  assert.equal(sessionsOf(env, row.id).length, 1);
});

// ─── the guard: while flagged, nothing but change-password / me / logout ───

// The guard's own source, evaluated alone, so it can be run against routes
// that do not open to sessions yet (batch 2b adds them).
function loadGuard() {
  const start = SRC.indexOf('// <photographer-route-guard>');
  const end = SRC.indexOf('// </photographer-route-guard>');
  assert.ok(start > 0 && end > start, 'worker.js marks the guard');
  const ctx = {};
  vm.runInNewContext(`${SRC.slice(start, end)}\nthis.guard = photographerRouteRefusal; this.allowed = PHOTOGRAPHER_MUST_CHANGE_ROUTES;`, ctx);
  return ctx;
}
// routes batch 2b will open to sessions (names are the guard's route ids)
const STUB_ROUTES = ['admin/projects', 'admin/project', 'admin/settings', 'admin/products', 'admin/orders', 'upload', 'books',
  'photographer/settings', 'photographer/me/x', 'me', 'logout', 'change-password', '', undefined, null, 'PHOTOGRAPHER/ME', 'photographer/me ',
  'constructor', '__proto__', 'toString'];
const ALLOWED = ['photographer/me', 'photographer/logout', 'photographer/change-password'];

test('guard: a flagged session is refused 403 must_change_password on every route but the three', () => {
  const { guard, allowed } = loadGuard();
  assert.deepEqual([...allowed].sort(), [...ALLOWED].sort());
  const who = { id: 'p1', must_change_password: true };
  for (const route of STUB_ROUTES) {
    const r = guard(who, route);
    assert.ok(r, `refused: ${String(route)}`);
    assert.equal(r.status, 403, String(route));
    assert.equal(r.body.code, 'must_change_password', String(route));
  }
  for (const route of ALLOWED) assert.equal(guard(who, route), null, route);
});

test('guard: an unflagged session passes every route; no session is 401 everywhere', () => {
  const { guard } = loadGuard();
  for (const route of [...STUB_ROUTES, ...ALLOWED]) {
    assert.equal(guard({ id: 'p1', must_change_password: false }, route), null, String(route));
    const r = guard(null, route);
    assert.equal(r.status, 401, String(route));
    assert.equal(r.body.code, 'unauthorized');
  }
});

test('guard: an unknown flag (column missing, or not 0/1) fails closed outside the three', () => {
  const { guard } = loadGuard();
  for (const flag of [null, undefined, 1, 'false', 0]) {
    for (const route of STUB_ROUTES) {
      const r = guard({ id: 'p1', must_change_password: flag }, route);
      assert.ok(r, `${flag} ${String(route)}`);
      assert.ok(r.status === 403 || r.status === 500, `${flag} ${String(route)}`);
    }
    for (const route of ALLOWED) assert.equal(guard({ id: 'p1', must_change_password: flag }, route), null);
  }
  assert.equal(guard({ id: 'p1', must_change_password: null }, 'upload').body.code, 'password_change_unavailable');
});

test('every resolvePhotographer call names its route; the raw lookup is only reached through the guard', () => {
  const calls = [...SRC.matchAll(/resolvePhotographer\(([^)]*)\)/g)].map(m => m[1]);
  const def = calls.filter(a => /^request, env, route$/.test(a.trim()));
  assert.equal(def.length, 1, 'one definition');
  const uses = calls.filter(a => !/^request, env, route$/.test(a.trim()));
  assert.ok(uses.length >= 2, 'me and change-password');
  for (const a of uses) assert.match(a.trim(), /^request, env, '[a-z/-]+'$/, a);
  assert.equal(SRC.split('lookupPhotographerSession(').length - 1, 2, 'one definition, one call');
  const fn = SRC.slice(SRC.indexOf('async function resolvePhotographer('), SRC.indexOf('\n}\n', SRC.indexOf('async function resolvePhotographer(')));
  assert.ok(fn.includes('who = await lookupPhotographerSession(request, env)'), 'the raw lookup is inside resolvePhotographer');
  assert.ok(fn.includes('photographerRouteRefusal(who, route)'), 'the guard sees the caller’s own route');
});

test('a flagged session is refused (never 2xx) on every existing route; the routes still work for PHOTOGRAPHER_TOKEN', async () => {
  const env = envOpen();
  const { token } = await mustChange(env);
  const project = await createProject(env);
  const routes = [
    ['GET', '/api/admin/projects'],
    ['POST', '/api/admin/projects', { title: 'x', folders: ['20260819/'] }],
    ['GET', `/api/admin/projects/${project.id}`],
    ['GET', '/api/admin/settings'],
    ['PUT', '/api/admin/settings', { studio_name: 'hacked' }],
    ['GET', '/api/admin/products'],
    ['GET', '/api/auth/verify-admin'],
    ['POST', '/api/auth/studio-token'],
    ['PUT', '/2026/evil.jpg', 'bytes'],
    ['PUT', '/api/upload', 'bytes'],
    ['GET', '/api/operator/photographers'],
  ];
  for (const [method, path, body] of routes) {
    const res = await call(env, path, { method, token, body });
    // batch 2a: these do not take sessions at all (401). Batch 2b opens them
    // through resolvePhotographer, and then a flagged session must get 403
    // must_change_password — never anything else.
    if (res.status === 403) assert.equal((await res.json()).code, 'must_change_password', `${method} ${path}`);
    else assert.equal(res.status, 401, `${method} ${path}`);
  }
  assert.equal(env.imagepicker._store.has('2026/evil.jpg'), false);
  assert.equal((await call(env, '/api/admin/projects', { token: SECRET })).status, 200);
});

// ─── who may call it ────────────────────────────────────────────────────────

test('change-password needs a live session of an active account', async () => {
  const env = envOpen();
  const { row, token } = await loggedIn(env);
  const before = account(env).password_hash;
  await bad(await change(env, undefined), 401, 'unauthorized', 'no token');
  await bad(await change(env, 'f'.repeat(64)), 401, 'unauthorized', 'unknown token');
  await bad(await change(env, SECRET), 401, 'unauthorized', 'PHOTOGRAPHER_TOKEN is not a session');
  await bad(await change(env, OP), 401, 'unauthorized', 'OPERATOR_TOKEN is not a session');
  await bad(await change(env, await sha256Hex(token)), 401, 'unauthorized', 'the stored hash is not a token');
  env.DB._db.prepare('UPDATE photographer_sessions SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
  await bad(await change(env, token), 401, 'unauthorized', 'expired');
  env.DB._db.prepare('UPDATE photographer_sessions SET expires_at = ?').run(new Date(Date.now() + 60000).toISOString());
  env.DB._db.prepare("UPDATE photographers SET status = 'suspended' WHERE id = ?").run(row.id);
  await bad(await change(env, token), 401, 'unauthorized', 'suspended (session row survived)');
  env.DB._db.prepare("UPDATE photographers SET status = 'pending' WHERE id = ?").run(row.id);
  await bad(await change(env, token), 401, 'unauthorized', 'pending');
  assert.equal(account(env).password_hash, before);
  assert.equal(rows(env, 'SELECT * FROM photographer_login_failures').length, 0, 'not even an attempt is recorded');
});

test('a suspended account cannot change its password (the operator suspend deletes the session)', async () => {
  const env = envOpen();
  const { row, token } = await loggedIn(env);
  assert.equal((await act(env, row.id, 'suspend')).status, 200);
  const before = account(env).password_hash;
  await bad(await change(env, token), 401, 'unauthorized', 'suspended');
  assert.equal(account(env).password_hash, before);
});

test('only POST; unknown sub-paths 404', async () => {
  const env = envOpen();
  const { token } = await loggedIn(env);
  assert.equal((await call(env, '/api/photographer/change-password', { token })).status, 405);
  assert.equal((await call(env, '/api/photographer/change-password', { method: 'PUT', token, body: 'x' })).status, 405);
  assert.equal((await call(env, '/api/photographer/change-password/x', { method: 'POST', token, body: {} })).status, 404);
});

// ─── input ──────────────────────────────────────────────────────────────────

test('invalid input is 400 before any PBKDF2 or throttle row, and changes nothing', async () => {
  const env = envOpen();
  const { token } = await loggedIn(env);
  const before = account(env).password_hash;
  const cases = [
    [{ new_password: NEW_PASSWORD }, 'invalid_current_password'],
    [{ current_password: '', new_password: NEW_PASSWORD }, 'invalid_current_password'],
    [{ current_password: 12345678901, new_password: NEW_PASSWORD }, 'invalid_current_password'],
    [{ current_password: [PASSWORD], new_password: NEW_PASSWORD }, 'invalid_current_password'],
    [{ current_password: { a: 1 }, new_password: NEW_PASSWORD }, 'invalid_current_password'],
    [{ current_password: 'x'.repeat(401), new_password: NEW_PASSWORD }, 'invalid_current_password'],
    [{ current_password: PASSWORD }, 'invalid_password'],
    [{ current_password: PASSWORD, new_password: '' }, 'invalid_password'],
    [{ current_password: PASSWORD, new_password: '123456789' }, 'invalid_password'],
    [{ current_password: PASSWORD, new_password: 'x'.repeat(201) }, 'invalid_password'],
    [{ current_password: PASSWORD, new_password: '😀'.repeat(201) }, 'invalid_password'],
    [{ current_password: PASSWORD, new_password: 1234567890123 }, 'invalid_password'],
    [{ current_password: PASSWORD, new_password: null }, 'invalid_password'],
    [{ current_password: PASSWORD, new_password: [NEW_PASSWORD] }, 'invalid_password'],
    [{ current_password: PASSWORD, new_password: PASSWORD }, 'same_password'],
    [{}, 'invalid_current_password'],
    [[], 'invalid_current_password'],
    [null, 'invalid_current_password'],
    ['"a string"', 'invalid_current_password'],
  ];
  const derives = await countingDerives(async () => {
    for (const [body, code] of cases) await bad(await change(env, token, body), 400, code, JSON.stringify(body));
  });
  assert.equal(derives, 0, 'no PBKDF2 for refused input');
  assert.equal(rows(env, 'SELECT * FROM photographer_login_failures').length, 0);
  assert.equal(account(env).password_hash, before);
  assert.equal(sessionsOf(env, account(env).id).length, 1);
});

test('boundaries: 10 and 200 characters are accepted (characters, not UTF-16 units)', async () => {
  const env = envOpen();
  const { token } = await loggedIn(env);
  assert.equal((await change(env, token, { current_password: PASSWORD, new_password: '1234567890' })).status, 200);
  assert.equal((await change(env, token, { current_password: '1234567890', new_password: '😀'.repeat(200) })).status, 200);
  assert.equal((await login(env, 'ann@example.com', '😀'.repeat(200))).status, 200);
});

test('a non-JSON or oversized body is refused', async () => {
  const env = envOpen();
  const { token } = await loggedIn(env);
  assert.equal((await change(env, token, 'not json')).status, 400);
  assert.equal((await change(env, token, JSON.stringify({ current_password: PASSWORD, new_password: 'x'.repeat(20000) }))).status, 413);
  assert.equal(account(env).must_change_password, 0);
});

// ─── wrong current password: throttled with the login budget ───────────────

test('a wrong current password is 403 wrong_password and changes nothing', async () => {
  const env = envOpen();
  const { row, token } = await loggedIn(env);
  const second = await tokenFor(env);
  const before = account(env).password_hash;
  const res = await change(env, token, { current_password: 'wrong password!', new_password: NEW_PASSWORD });
  await bad(res, 403, 'wrong_password', 'wrong');
  assert.equal(account(env).password_hash, before);
  assert.equal(sessionsOf(env, row.id).length, 2, 'no session is touched');
  assert.equal((await me(env, second)).status, 200);
  assert.equal((await login(env, 'ann@example.com', NEW_PASSWORD)).status, 401);
});

test('wrong current passwords count toward the login lockout (shared with login, per email and per IP)', async () => {
  const env = envOpen();
  const { token } = await loggedIn(env);
  // five failed logins and five wrong change attempts, all from different IPs
  for (let i = 0; i < 5; i++) assert.equal((await loginFrom(env, `198.51.100.${i}`, 'ann@example.com', `bad login ${i}`)).status, 401);
  for (let i = 0; i < 5; i++) {
    await bad(await change(env, token, { current_password: `bad change ${i}`, new_password: NEW_PASSWORD }, `198.51.100.${50 + i}`), 403, 'wrong_password', `#${i}`);
  }
  let res;
  const derives = await countingDerives(async () => { res = await change(env, token, undefined, '198.51.100.99'); });
  await bad(res, 429, 'too_many_attempts', 'the right password, too late');
  assert.equal(derives, 0, 'refused before PBKDF2');
  await bad(await loginFrom(env, '198.51.100.98'), 429, 'too_many_attempts', 'login is locked too');
  assert.match(account(env).password_hash, /^pbkdf2/);
  assert.equal((await login(env, 'ann@example.com', NEW_PASSWORD)).status, 429);
  // the window passes
  env.DB._db.prepare('UPDATE photographer_login_failures SET created_at = ?').run(new Date(Date.now() - 16 * 60000).toISOString());
  assert.equal((await change(env, token, undefined, '198.51.100.97')).status, 200);
});

test('wrong current passwords from one IP lock that IP for login too', async () => {
  const env = envOpen();
  const { token } = await loggedIn(env);
  await activeAccount(env, 'bob@example.com');
  for (let i = 0; i < 10; i++) await bad(await change(env, token, { current_password: `bad ${i}`, new_password: NEW_PASSWORD }, '192.0.2.9'), 403, 'wrong_password', `#${i}`);
  await bad(await loginFrom(env, '192.0.2.9', 'bob@example.com'), 429, 'too_many_attempts', 'same IP, another email');
  assert.equal((await loginFrom(env, '192.0.2.10', 'bob@example.com')).status, 200);
  const raw = JSON.stringify(rows(env, 'SELECT * FROM photographer_login_failures'));
  assert.ok(!raw.includes('192.0.2.9') && !raw.includes('ann@'), 'keys are hashed');
});

test('parallel wrong guesses cannot pass the cap', async () => {
  const env = envOpen();
  const { token } = await loggedIn(env);
  const results = await Promise.all(Array.from({ length: 16 }, (_, i) =>
    change(env, token, { current_password: `guess ${i}`, new_password: NEW_PASSWORD }, `198.51.100.${i}`)));
  const statuses = results.map(r => r.status).sort();
  assert.deepEqual(statuses, [...Array(10).fill(403), ...Array(6).fill(429)]);
});

test('right and wrong current passwords cost the same PBKDF2 work', async () => {
  const env = envOpen();
  const { token } = await loggedIn(env);
  let wrong, right;
  const w = await countingDerives(async () => { wrong = await change(env, token, { current_password: 'wrong password!', new_password: NEW_PASSWORD }); });
  const r = await countingDerives(async () => { right = await change(env, token); });
  assert.equal(wrong.status, 403);
  assert.equal(right.status, 200);
  assert.equal(w, r, 'same number of PBKDF2 runs');
  assert.equal(w, 2, 'verify + the new hash');
});

// ─── races ──────────────────────────────────────────────────────────────────

test('two parallel changes from two sessions: exactly one wins; the loser’s session ends', async () => {
  const env = envOpen();
  const { row, token: a } = await loggedIn(env);
  const b = await tokenFor(env);
  const { atGate, release } = gateBatch(env, /UPDATE photographers SET password_hash/);
  const first = change(env, a, { current_password: PASSWORD, new_password: 'first new password' });
  await atGate;                        // A verified the old password and holds its write
  const second = await change(env, b, { current_password: PASSWORD, new_password: 'second new password' });
  release();
  const firstRes = await first;
  // B landed first: A's write must not land on top of it
  assert.equal(second.status, 200, await second.clone().text());
  await bad(firstRes, 409, 'password_change_conflict', 'the stale change');
  assert.equal((await login(env, 'ann@example.com', 'second new password')).status, 200);
  assert.equal((await login(env, 'ann@example.com', 'first new password')).status, 401);
  assert.equal((await me(env, a)).status, 401, 'the loser’s session was ended by the winner');
  assert.equal((await me(env, b)).status, 200);
  assert.equal(sessionsOf(env, row.id).length, 2, 'b plus the one login above');
});

test('an operator reset landing between the verify and the write wins; the flag stays set', async () => {
  const env = envOpen();
  const { row, token } = await loggedIn(env);
  const { atGate, release } = gateBatch(env, /UPDATE photographers SET password_hash = \?, must_change_password = 0/);
  const pending = change(env, token);
  await atGate;
  const reset = await act(env, row.id, 'reset-password');
  assert.equal(reset.status, 200);
  const temp = (await reset.json()).temp_password;
  release();
  await bad(await pending, 409, 'password_change_conflict', 'the change after the reset');
  assert.equal(account(env).must_change_password, 1);
  assert.equal(sessionsOf(env, row.id).length, 0);
  assert.equal((await login(env, 'ann@example.com', NEW_PASSWORD)).status, 401);
  assert.equal((await login(env, 'ann@example.com', temp)).status, 200);
});

test('a suspend landing between the verify and the write wins', async () => {
  const env = envOpen();
  const { row, token } = await loggedIn(env);
  const before = account(env).password_hash;
  const { atGate, release } = gateBatch(env, /UPDATE photographers SET password_hash = \?, must_change_password = 0/);
  const pending = change(env, token);
  await atGate;
  assert.equal((await act(env, row.id, 'suspend')).status, 200);
  release();
  assert.equal((await pending).status, 409);
  assert.equal(account(env).password_hash, before);
  assert.equal(account(env).status, 'suspended');
});

test('a logout of the changing session landing between the verify and the write wins', async () => {
  const env = envOpen();
  const { row, token } = await loggedIn(env);
  const other = await tokenFor(env);
  const before = account(env).password_hash;
  const { atGate, release } = gateBatch(env, /UPDATE photographers SET password_hash = \?, must_change_password = 0/);
  const pending = change(env, token);
  await atGate;
  assert.equal((await call(env, '/api/photographer/logout', { method: 'POST', token })).status, 200);
  release();
  assert.equal((await pending).status, 409);
  assert.equal(account(env).password_hash, before, 'a dead session changes nothing');
  assert.equal((await me(env, other)).status, 200, 'and ends nothing');
  assert.equal(sessionsOf(env, row.id).length, 1);
});

// Defence in depth: today every write that changes the hash or the status also
// deletes the sessions, but the change must not lean on that alone.
test('a hash or status changed between the verify and the write (sessions untouched) is 409 too', async () => {
  for (const [label, sql] of [
    ['hash', "UPDATE photographers SET password_hash = 'pbkdf2$1000$00112233445566778899aabbccddeeff$' || printf('%064d', 0) WHERE id = ?"],
    ['status', "UPDATE photographers SET status = 'suspended' WHERE id = ?"],
  ]) {
    const env = envOpen();
    const { row, token } = await loggedIn(env);
    await tokenFor(env);                 // a second session, which must survive
    const { atGate, release } = gateBatch(env, /UPDATE photographers SET password_hash = \?, must_change_password = 0/);
    const pending = change(env, token);
    await atGate;
    env.DB._db.prepare(sql).run(row.id);
    const changed = account(env).password_hash;
    release();
    await bad(await pending, 409, 'password_change_conflict', label);
    assert.equal(account(env).password_hash, changed, `${label}: nothing written`);
    assert.equal(sessionsOf(env, row.id).length, 2, `${label}: no session ended`);
  }
});

test('a login with the old password racing a change mints no session', async () => {
  const env = envOpen();
  const { row, token } = await loggedIn(env);
  const { atGate, release } = gateBatch(env, /INSERT INTO photographer_sessions/);
  const pendingLogin = login(env, 'ann@example.com', PASSWORD);
  await atGate;
  assert.equal((await change(env, token)).status, 200);
  release();
  assert.equal((await pendingLogin).status, 401);
  assert.equal(sessionsOf(env, row.id).length, 1, 'only the changing session');
});

// ─── before the migration (no must_change_password column) ─────────────────

function withoutMustChangeColumn() {
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const cut = schema.replace(/(last_dup_at\s+TEXT),[\s\S]*?\n\s*must_change_password INTEGER NOT NULL DEFAULT 0/, '$1');
  assert.notEqual(cut, schema, 'schema.sql has the column');
  assert.ok(!/must_change_password/.test(cut.slice(cut.indexOf('CREATE TABLE IF NOT EXISTS photographers'), cut.indexOf('CREATE TABLE IF NOT EXISTS photographer_sessions'))));
  return cut;
}

test('without the column: login and /me work and say null; change-password is 500 and writes nothing', async () => {
  const env = envOpen({ DB: fakeDB({ schema: withoutMustChangeColumn() }) });
  const row = await activeAccount(env);
  const res = await login(env, 'ann@example.com', PASSWORD);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.must_change_password, null);
  const m = await me(env, body.token);
  assert.equal(m.status, 200);
  assert.deepEqual(await m.json(), { photographer: { id: row.id, display_name: '安攝影', email: 'ann@example.com' }, must_change_password: null });
  const before = account(env).password_hash;
  let ch;
  const derives = await countingDerives(async () => { ch = await change(env, body.token); });
  await bad(ch, 500, 'password_change_unavailable', 'change-password');
  assert.equal(derives, 0);
  assert.equal(account(env).password_hash, before);
  assert.equal(rows(env, 'SELECT * FROM photographer_login_failures').length, 0);
  assert.equal((await call(env, '/api/photographer/logout', { method: 'POST', token: body.token })).status, 200);
  assert.equal((await me(env, body.token)).status, 401);
});

test('without the column: reset-password still resets and ends sessions, and says the change is not enforced', async () => {
  const env = envOpen({ DB: fakeDB({ schema: withoutMustChangeColumn() }) });
  const row = await activeAccount(env);
  const token = await tokenFor(env);
  const res = await act(env, row.id, 'reset-password');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.temp_password, 'string');
  assert.equal(body.must_change_password, false);
  assert.equal(body.warning, 'must_change_unavailable');
  assert.equal(sessionsOf(env, row.id).length, 0);
  assert.equal((await me(env, token)).status, 401);
  assert.equal((await login(env, 'ann@example.com', PASSWORD)).status, 401);
  assert.equal((await login(env, 'ann@example.com', body.temp_password)).status, 200);
});

test('the migration adds exactly the column, append-only', () => {
  const sql = readFileSync(new URL('../migrations/2026-10-15-photographer-must-change-password.sql', import.meta.url), 'utf8');
  const statements = sql.split('\n').filter(l => l.trim() && !l.trim().startsWith('--'));
  assert.deepEqual(statements, ['ALTER TABLE photographers ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;']);
  // and it runs on a batch-1 database, defaulting every existing row to 0
  const env = envOpen({ DB: fakeDB({ schema: withoutMustChangeColumn() }) });
  env.DB._db.prepare("INSERT INTO photographers (id, email, password_hash, display_name, status, created_at) VALUES ('p', 'p@example.com', 'x', 'P', 'active', 'now')").run();
  env.DB._db.exec(statements[0]);
  assert.equal(one(env, 'SELECT must_change_password FROM photographers').must_change_password, 0);
});
