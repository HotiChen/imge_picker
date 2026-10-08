// Photographer accounts, batch 1 of docs/multi-photographer.md (帳號與登入):
// register (pending, Turnstile, per-IP limit) → the operator approves /
// rejects / suspends / resets the password → login gives a session token
// stored only as its SHA-256. Batch 1's hard rule: a photographer session
// opens NO existing route — isAdminToken still checks PHOTOGRAPHER_TOKEN only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { fakeDB } from './fakes.mjs';
import { SECRET, setup, call, rows, one, sha256Hex, createProject } from './pick-helpers.mjs';

const OP = 'operator-secret';
const TS_SECRET = 'turnstile-secret';
const PASSWORD = 'correct horse battery';
const IP = '203.0.113.7';

// ─── Turnstile stand-in ──────────────────────────────────────────────────────
// The Worker calls the global fetch for siteverify; every test sets `turnstile`
// to what the next verify should answer and reads `verifies` back.
const realFetch = globalThis.fetch;
let turnstile = 'ok';
let verifies = [];
before(() => {
  globalThis.fetch = async (url, init = {}) => {
    verifies.push({ url: String(url), init, form: new URLSearchParams(init.body instanceof URLSearchParams ? init.body : String(init.body ?? '')) });
    if (turnstile === 'throw') throw new Error('network down');
    if (turnstile === '500') return new Response('oops', { status: 500 });
    if (turnstile === '500-json') return Response.json({ success: true }, { status: 500 });
    if (turnstile === 'garbage') return new Response('not json', { status: 200 });
    if (turnstile === 'string-true') return Response.json({ success: 'true' });
    // never answers; rejects when the Worker's signal aborts (a hung siteverify)
    if (turnstile === 'hang') {
      return new Promise((_, reject) => {
        // node's AbortSignal.timeout does not hold the event loop open; this
        // timer does, and gives up (failing the test) after 15 s
        const keep = setTimeout(() => reject(new Error('the Worker never aborted the request')), 15000);
        init.signal?.addEventListener('abort', () => { clearTimeout(keep); reject(init.signal.reason); });
      });
    }
    if (turnstile === 'other-host') return Response.json({ success: true, hostname: 'evil.example' });
    if (turnstile === 'no-host') return Response.json({ success: true });
    return Response.json({ success: turnstile === 'ok', hostname: 'imhoti.tw', 'error-codes': turnstile === 'ok' ? [] : ['invalid-input-response'] });
  };
});
after(() => { globalThis.fetch = realFetch; });

const envOpen = (extra = {}) => {
  turnstile = 'ok';
  verifies = [];
  return setup({ OPERATOR_TOKEN: OP, PHOTOGRAPHER_SIGNUP: 'on', TURNSTILE_SECRET: TS_SECRET, ...extra });
};

const register = (env, body = {}, ip = IP) => call(env, '/api/photographer/register', {
  method: 'POST',
  headers: ip ? { 'CF-Connecting-IP': ip } : {},
  body: { email: 'Ann@Example.com', password: PASSWORD, display_name: '安攝影', studio_note: '安安工作室 https://ann.example', turnstileToken: 'tt-ok', ...body },
});
const login = (env, email = 'ann@example.com', password = PASSWORD) =>
  call(env, '/api/photographer/login', { method: 'POST', body: { email, password } });
const loginFrom = (env, ip, email = 'ann@example.com', password = PASSWORD) =>
  call(env, '/api/photographer/login', { method: 'POST', headers: ip ? { 'CF-Connecting-IP': ip } : {}, body: { email, password } });
const me = (env, token) => call(env, '/api/photographer/me', { token });
// token null = no Authorization header
const op = (env, method, path, token = OP) => call(env, path, { method, token: token ?? undefined });
const act = (env, id, action, token = OP) => op(env, 'POST', `/api/operator/photographers/${id}/${action}`, token);
const account = (env, email = 'ann@example.com') => one(env, 'SELECT * FROM photographers WHERE email = ?', email);

async function registered(env, body = {}, ip = IP) {
  const res = await register(env, body, ip);
  assert.equal(res.status, 202, await res.clone().text());
  return account(env, (body.email ?? 'ann@example.com').toLowerCase());
}
async function active(env, body = {}) {
  const row = await registered(env, body);
  const res = await act(env, row.id, 'approve');
  assert.equal(res.status, 200, await res.clone().text());
  return account(env, row.email);
}
async function loggedIn(env, body = {}) {
  const row = await active(env, body);
  const res = await login(env, row.email, body.password ?? PASSWORD);
  assert.equal(res.status, 200, await res.clone().text());
  return { row, token: (await res.json()).token };
}

// an independent PBKDF2 (node's webcrypto), to check the stored format
async function pbkdf2Hex(password, saltHex, iterations) {
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const bits = await webcrypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const dump = env => JSON.stringify(['photographers', 'photographer_sessions', 'photographer_signups']
  .map(t => rows(env, `SELECT * FROM ${t}`)));
const bad = async (res, status, code, label) => {
  assert.equal(res.status, status, label);
  assert.equal((await res.json()).code, code, label);
};

// ─── registration is closed unless explicitly opened ────────────────────────

test('registration is closed by default, for typos, and without a Turnstile secret', async () => {
  const cases = [
    {},
    { PHOTOGRAPHER_SIGNUP: 'On' },
    { PHOTOGRAPHER_SIGNUP: 'ON' },
    { PHOTOGRAPHER_SIGNUP: 'on ' },
    { PHOTOGRAPHER_SIGNUP: 'true' },
    { PHOTOGRAPHER_SIGNUP: 'yes' },
    { PHOTOGRAPHER_SIGNUP: 'pilot' },
    { PHOTOGRAPHER_SIGNUP: 'on', TURNSTILE_SECRET: '' },
    { PHOTOGRAPHER_SIGNUP: 'on', TURNSTILE_SECRET: undefined },
  ];
  for (const extra of cases) {
    verifies = [];
    turnstile = 'ok';
    const env = setup({ OPERATOR_TOKEN: OP, TURNSTILE_SECRET: TS_SECRET, ...extra });
    const res = await register(env);
    await bad(res, 403, 'registration_closed', JSON.stringify(extra));
    assert.equal(rows(env, 'SELECT * FROM photographers').length, 0);
    assert.equal(verifies.length, 0, 'Turnstile is not even asked');
  }
});

test('closed registration answers before the body is read or the tables are touched', async () => {
  const env = setup({ DB: fakeDB({ schema: withoutPhotographerTables() }) });
  const res = await call(env, '/api/photographer/register', { method: 'POST', body: 'not json' });
  await bad(res, 403, 'registration_closed');
});

test('an open registration creates one pending account with a PBKDF2 hash', async () => {
  const env = envOpen();
  const res = await register(env);
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true, message: '已收到，等待審核' });
  assert.match(res.headers.get('Cache-Control'), /no-store/);
  const row = account(env);
  assert.ok(row, 'email stored lowercased');
  assert.equal(row.status, 'pending');
  assert.equal(row.display_name, '安攝影');
  assert.equal(row.studio_note, '安安工作室 https://ann.example');
  assert.equal(row.approved_at, null);
  assert.match(row.id, /^[0-9a-f]{16}$/);
  const [scheme, iters, salt, hash] = row.password_hash.split('$');
  assert.equal(scheme, 'pbkdf2');
  assert.equal(iters, '100000');
  assert.match(salt, /^[0-9a-f]{32}$/);
  assert.equal(hash, await pbkdf2Hex(PASSWORD, salt, 100000), 'node derives the same hash');
  assert.ok(!dump(env).includes(PASSWORD), 'the password itself is nowhere');
  // one signup row, hashed IP
  const signups = rows(env, 'SELECT * FROM photographer_signups');
  assert.equal(signups.length, 1);
  assert.ok(!dump(env).includes(IP), 'the raw IP is nowhere');
});

test('a studio note is optional; an empty one is stored as NULL', async () => {
  const env = envOpen();
  const row = await registered(env, { studio_note: undefined });
  assert.equal(row.studio_note, null);
  const row2 = await registered(env, { email: 'b@example.com', studio_note: '  ' });
  assert.equal(row2.studio_note, null);
});

// ─── Turnstile fails closed ─────────────────────────────────────────────────

test('Turnstile is verified with the secret, the token and the client IP', async () => {
  const env = envOpen();
  await registered(env);
  assert.equal(verifies.length, 1);
  assert.equal(verifies[0].url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.equal(verifies[0].init.method, 'POST');
  assert.equal(verifies[0].form.get('secret'), TS_SECRET);
  assert.equal(verifies[0].form.get('response'), 'tt-ok');
  assert.equal(verifies[0].form.get('remoteip'), IP);
});

test('Turnstile fails closed: refused, errors, garbage, missing token', async () => {
  for (const mode of ['fail', 'throw', '500', '500-json', 'garbage', 'string-true']) {
    const env = envOpen();
    turnstile = mode;
    await bad(await register(env), 403, 'turnstile_failed', mode);
    assert.equal(rows(env, 'SELECT * FROM photographers').length, 0, mode);
    assert.equal(rows(env, 'SELECT * FROM photographer_signups').length, 0, `${mode}: no quota spent`);
  }
  for (const turnstileToken of [undefined, '', 42, 'x'.repeat(2049)]) {
    const env = envOpen();
    await bad(await register(env, { turnstileToken }), 403, 'turnstile_failed', String(turnstileToken).slice(0, 10));
    assert.equal(verifies.length, 0, 'no call without a usable token');
    assert.equal(rows(env, 'SELECT * FROM photographers').length, 0);
  }
});

// ─── the response never says whether the email exists ──────────────────────

test('a duplicate email gets the identical response and changes nothing', async () => {
  const env = envOpen();
  const first = await register(env);
  const before = account(env);
  const again = await register(env, { email: '  ANN@example.COM ', password: 'another password!', display_name: '冒充' });
  assert.equal(again.status, first.status);
  assert.equal(await again.text(), await first.text());
  assert.deepEqual([...again.headers].sort(), [...first.headers].sort());
  assert.equal(rows(env, 'SELECT * FROM photographers').length, 1);
  const { dup_attempts, last_dup_at, ...rest } = account(env);
  const { dup_attempts: d0, last_dup_at: l0, ...restBefore } = before;
  assert.deepEqual(rest, restBefore, 'the existing account is untouched (but for the duplicate counter)');
  assert.equal(dup_attempts, d0 + 1);
});

test('invalid fields are refused with 400 and nothing is written', async () => {
  const cases = [
    [{ email: 'no-at.example.com' }, 'invalid_email'],
    [{ email: 'a@@example.com' }, 'invalid_email'],
    [{ email: 'a@b@example.com' }, 'invalid_email'],
    [{ email: 'a b@example.com' }, 'invalid_email'],
    [{ email: 'a\u0000@example.com' }, 'invalid_email'],
    [{ email: 'a\u202E@example.com' }, 'invalid_email'],
    [{ email: '@example.com' }, 'invalid_email'],
    [{ email: 'a@' }, 'invalid_email'],
    [{ email: 'a@localhost' }, 'invalid_email'],
    [{ email: `${'a'.repeat(243)}@example.com` }, 'invalid_email'],
    [{ email: 42 }, 'invalid_email'],
    [{ password: 'nine char' }, 'invalid_password'],
    [{ password: 'x'.repeat(201) }, 'invalid_password'],
    [{ password: 1234567890123 }, 'invalid_password'],
    [{ display_name: '' }, 'invalid_display_name'],
    [{ display_name: '   ' }, 'invalid_display_name'],
    [{ display_name: 'x'.repeat(51) }, 'invalid_display_name'],
    [{ display_name: 'a\u0007b' }, 'invalid_display_name'],
    [{ studio_note: '字'.repeat(301) }, 'invalid_studio_note'],
    [{ studio_note: 5 }, 'invalid_studio_note'],
    [{ studio_note: 'a\u0000b' }, 'invalid_studio_note'],
  ];
  for (const [body, code] of cases) {
    const env = envOpen();
    await bad(await register(env, body), 400, code, JSON.stringify(body).slice(0, 40));
    assert.equal(rows(env, 'SELECT * FROM photographers').length, 0);
  }
  // the edges are allowed: 254 characters, 10 and 200 password characters,
  // 300 code points of studio note (emoji are one each), 50 name characters
  const env = envOpen();
  await registered(env, { email: `${'a'.repeat(242)}@example.com`, password: 'x'.repeat(10), studio_note: '😀'.repeat(300), display_name: '名'.repeat(50) });
  await registered(env, { email: 'z@example.com', password: 'y'.repeat(200), studio_note: '第一行\n第二行' });
});

test('a non-JSON or oversized body is refused', async () => {
  const env = envOpen();
  const res = await call(env, '/api/photographer/register', { method: 'POST', body: '{nope' });
  assert.equal(res.status, 400);
  const big = await register(env, { studio_note: 'x'.repeat(20000) });
  assert.equal(big.status, 413);
});

// ─── per-IP rate limit ──────────────────────────────────────────────────────

test('five registrations an hour per IP; the sixth is 429; another IP is unaffected', async () => {
  const env = envOpen();
  for (let i = 0; i < 5; i++) await registered(env, { email: `p${i}@example.com` });
  await bad(await register(env, { email: 'p5@example.com' }), 429, 'rate_limited');
  assert.equal(account(env, 'p5@example.com'), undefined);
  // a duplicate counts too (it passed Turnstile), and is refused the same way
  await bad(await register(env, { email: 'p0@example.com' }), 429, 'rate_limited');
  await registered(env, { email: 'other@example.com' }, '198.51.100.9');
});

test('attempts older than an hour do not count; parallel attempts cannot pass the cap', async () => {
  const env = envOpen();
  for (let i = 0; i < 5; i++) await registered(env, { email: `old${i}@example.com` });
  env.DB._db.prepare('UPDATE photographer_signups SET created_at = ?').run(new Date(Date.now() - 61 * 60000).toISOString());
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => register(env, { email: `new${i}@example.com` })));
  const statuses = results.map(r => r.status).sort();
  assert.deepEqual(statuses, [202, 202, 202, 202, 202, 429, 429, 429]);
  assert.equal(rows(env, "SELECT * FROM photographers WHERE email LIKE 'new%'").length, 5);
});

test('a request without CF-Connecting-IP shares one bucket rather than escaping the limit', async () => {
  const env = envOpen();
  for (let i = 0; i < 5; i++) await registered(env, { email: `n${i}@example.com` }, null);
  await bad(await register(env, { email: 'n5@example.com' }, null), 429, 'rate_limited');
});

// ─── login never reveals existence or status ───────────────────────────────

test('unknown email, wrong password, pending and suspended all get the identical 401', async () => {
  const env = envOpen();
  await registered(env, { email: 'pending@example.com' });
  const sus = await active(env, { email: 'sus@example.com' });
  assert.equal((await act(env, sus.id, 'suspend')).status, 200);
  await active(env, { email: 'ok@example.com' });

  const attempts = [
    login(env, 'nobody@example.com'),
    login(env, 'ok@example.com', 'wrong password!'),
    login(env, 'pending@example.com'),
    login(env, 'sus@example.com'),
    login(env, 'not an email'),
    call(env, '/api/photographer/login', { method: 'POST', body: {} }),
  ];
  const results = await Promise.all(attempts);
  const shapes = await Promise.all(results.map(async r => [r.status, await r.text(), r.headers.get('Cache-Control')]));
  for (const s of shapes) assert.deepEqual(s, shapes[0]);
  assert.equal(shapes[0][0], 401);
  assert.equal(JSON.parse(shapes[0][1]).code, 'login_failed');
  assert.equal(rows(env, 'SELECT * FROM photographer_sessions').length, 0);
});

test('an unknown email still runs a full PBKDF2 (no timing shortcut)', async () => {
  const env = envOpen();
  await active(env, { email: 'ok@example.com' });
  const subtle = globalThis.crypto.subtle;
  const realDerive = subtle.deriveBits;
  const seen = [];
  subtle.deriveBits = function (algo, ...rest) { seen.push(algo.iterations); return realDerive.call(this, algo, ...rest); };
  try {
    seen.length = 0;
    assert.equal((await login(env, 'nobody@example.com')).status, 401);
    assert.deepEqual(seen, [100000], 'unknown email');
    seen.length = 0;
    assert.equal((await login(env, 'ok@example.com', 'wrong password!')).status, 401);
    assert.deepEqual(seen, [100000], 'wrong password');
    seen.length = 0;
    assert.equal((await login(env, 'x'.repeat(5000) + '@example.com', 'y'.repeat(5000))).status, 401);
    assert.deepEqual(seen, [100000], 'oversized input');
  } finally {
    subtle.deriveBits = realDerive;
  }
});

test('a suspend landing between the password check and the session write leaves no session', async () => {
  const env = envOpen();
  const row = await active(env);
  // the moment login has read the active row, the operator suspends it
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    const stmt = realPrepare(sql);
    if (!/^SELECT id, display_name, password_hash, status FROM photographers/.test(sql)) return stmt;
    return { bind: (...a) => { const b = stmt.bind(...a); return { first: async () => {
      const got = await b.first();
      env.DB._db.prepare("UPDATE photographers SET status = 'suspended' WHERE id = ?").run(row.id);
      return got;
    } }; } };
  };
  const res = await login(env);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: '帳號或密碼不正確，或帳號尚未開通', code: 'login_failed' });
  assert.equal(rows(env, 'SELECT * FROM photographer_sessions').length, 0);
  assert.equal(account(env).last_login_at, null);
});

test('login verifies with the iteration count stored in the hash', async () => {
  const env = envOpen();
  const row = await active(env);
  const salt = '00112233445566778899aabbccddeeff';
  env.DB._db.prepare('UPDATE photographers SET password_hash = ? WHERE id = ?')
    .run(`pbkdf2$1000$${salt}$${await pbkdf2Hex(PASSWORD, salt, 1000)}`, row.id);
  assert.equal((await login(env)).status, 200, 'a 1000-iteration hash still logs in');
  // malformed or out-of-range stored hashes fail closed (401, never a 500)
  for (const stored of ['garbage', `pbkdf2$100001$${salt}$aa`, `pbkdf2$0$${salt}$aa`, `pbkdf2$1e3$${salt}$aa`, `sha$1000$${salt}$aa`, 'abc:def']) {
    env.DB._db.prepare('UPDATE photographers SET password_hash = ? WHERE id = ?').run(stored, row.id);
    assert.equal((await login(env)).status, 401, stored);
  }
});

test('a successful login stores only the SHA-256 of a 32-byte token for 30 days', async () => {
  const env = envOpen();
  const row = await active(env);
  const res = await login(env, 'ANN@example.com ');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Cache-Control'), /no-store/);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['photographer', 'token']);
  assert.deepEqual(body.photographer, { id: row.id, display_name: '安攝影' });
  assert.match(body.token, /^[0-9a-f]{64}$/);
  const sessions = rows(env, 'SELECT * FROM photographer_sessions');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].token_hash, await sha256Hex(body.token));
  assert.equal(sessions[0].photographer_id, row.id);
  assert.ok(!JSON.stringify(rows(env, 'SELECT * FROM sqlite_master')).includes(body.token));
  assert.ok(!dump(env).includes(body.token), 'the raw token is nowhere in the database');
  const life = Date.parse(sessions[0].expires_at) - Date.parse(sessions[0].created_at);
  assert.equal(life, 30 * 86400000);
  assert.ok(account(env).last_login_at, 'last_login_at set');
  // two logins, two different tokens
  const second = await (await login(env)).json();
  assert.notEqual(second.token, body.token);
});

// ─── sessions: me / logout / suspend / expiry ───────────────────────────────

test('/me answers the session owner; logout deletes that session only', async () => {
  const env = envOpen();
  const { row, token } = await loggedIn(env);
  const other = (await (await login(env)).json()).token;
  const res = await me(env, token);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Cache-Control'), /no-store/);
  assert.deepEqual(await res.json(), { photographer: { id: row.id, display_name: '安攝影', email: 'ann@example.com' } });
  const out = await call(env, '/api/photographer/logout', { method: 'POST', token });
  assert.equal(out.status, 200);
  assert.equal((await me(env, token)).status, 401);
  assert.equal((await me(env, other)).status, 200, 'the other session is kept');
  assert.equal((await me(env)).status, 401, 'no token');
  assert.equal((await me(env, 'f'.repeat(64))).status, 401, 'unknown token');
  assert.equal((await me(env, SECRET)).status, 401, 'PHOTOGRAPHER_TOKEN is not a session (batch 1)');
  assert.equal((await me(env, await sha256Hex(other))).status, 401, 'the stored hash is not a token');
});

test('suspending takes effect at once and deletes every session; unsuspend does not revive them', async () => {
  const env = envOpen();
  const { row, token } = await loggedIn(env);
  const second = (await (await login(env)).json()).token;
  const { token: bystander } = await loggedIn(env, { email: 'bob@example.com' });
  assert.equal((await act(env, row.id, 'suspend')).status, 200);
  assert.equal(account(env).status, 'suspended');
  assert.equal(rows(env, 'SELECT * FROM photographer_sessions WHERE photographer_id = ?', row.id).length, 0);
  assert.equal((await me(env, token)).status, 401);
  assert.equal((await me(env, second)).status, 401);
  assert.equal((await me(env, bystander)).status, 200, 'another account is untouched');
  assert.equal((await act(env, row.id, 'unsuspend')).status, 200);
  assert.equal(account(env).status, 'active');
  assert.equal((await me(env, token)).status, 401, 'an old session stays dead');
  assert.equal((await login(env)).status, 200, 'logs in again after unsuspend');
});

test('a session whose account is suspended stops working even if a row survived', async () => {
  const env = envOpen();
  const { row, token } = await loggedIn(env);
  env.DB._db.prepare("UPDATE photographers SET status = 'suspended' WHERE id = ?").run(row.id);
  assert.equal((await me(env, token)).status, 401);
  env.DB._db.prepare("UPDATE photographers SET status = 'pending' WHERE id = ?").run(row.id);
  assert.equal((await me(env, token)).status, 401);
});

test('an expired session is refused', async () => {
  const env = envOpen();
  const { token } = await loggedIn(env);
  env.DB._db.prepare('UPDATE photographer_sessions SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
  assert.equal((await me(env, token)).status, 401);
  env.DB._db.prepare('UPDATE photographer_sessions SET expires_at = ?').run(new Date(Date.now() + 60000).toISOString());
  assert.equal((await me(env, token)).status, 200);
});

// ─── operator routes ────────────────────────────────────────────────────────

test('the operator list: pending first then newest first, a pending count, never a hash or a token', async () => {
  const env = envOpen();
  const a = await registered(env, { email: 'a@example.com' });
  const b = await active(env, { email: 'b@example.com' });
  const c = await registered(env, { email: 'c@example.com' });
  env.DB._db.prepare('UPDATE photographers SET created_at = ? WHERE id = ?').run('2026-10-01T00:00:00.000Z', a.id);
  env.DB._db.prepare('UPDATE photographers SET created_at = ? WHERE id = ?').run('2026-10-02T00:00:00.000Z', b.id);
  env.DB._db.prepare('UPDATE photographers SET created_at = ? WHERE id = ?').run('2026-10-03T00:00:00.000Z', c.id);
  const { token } = await (await login(env, 'b@example.com')).json();
  const res = await op(env, 'GET', '/api/operator/photographers');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Cache-Control'), /no-store/);
  const text = await res.text();
  const body = JSON.parse(text);
  // pending first (newest first among them), then the rest
  assert.deepEqual(body.photographers.map(p => p.email), ['c@example.com', 'a@example.com', 'b@example.com']);
  assert.equal(body.pending_count, 2);
  assert.deepEqual(Object.keys(body.photographers[0]).sort(),
    ['approved_at', 'created_at', 'display_name', 'dup_attempts', 'email', 'id', 'last_dup_at', 'last_login_at', 'status', 'studio_note']);
  assert.ok(!text.includes('pbkdf2$') && !text.includes('password'), 'no hash');
  assert.ok(!text.includes(token) && !text.includes(await sha256Hex(token)), 'no token');
});

test('operator photographer routes reject no token, PHOTOGRAPHER_TOKEN and a photographer session', async () => {
  const env = envOpen();
  const { row, token } = await loggedIn(env);
  const target = await registered(env, { email: 'p@example.com' });
  const before = dump(env);
  const routes = [
    ['GET', '/api/operator/photographers'],
    ...['approve', 'reject', 'suspend', 'unsuspend', 'reset-password'].map(a => ['POST', `/api/operator/photographers/${target.id}/${a}`]),
    ['POST', `/api/operator/photographers/${row.id}/suspend`],
  ];
  for (const [method, path] of routes) {
    for (const t of [null, SECRET, token, 'nope']) {
      assert.equal((await op(env, method, path, t)).status, 401, `${method} ${path} ${t}`);
    }
  }
  assert.equal(dump(env), before, 'nothing changed');
  // and an OPERATOR_TOKEN equal to PHOTOGRAPHER_TOKEN opens nothing (existing rule)
  const same = envOpen({ OPERATOR_TOKEN: SECRET });
  assert.equal((await op(same, 'GET', '/api/operator/photographers', SECRET)).status, 401);
});

test('unknown ids are 404; wrong methods 405; unknown actions 404', async () => {
  const env = envOpen();
  const row = await registered(env);
  for (const a of ['approve', 'reject', 'suspend', 'unsuspend', 'reset-password']) {
    assert.equal((await act(env, 'nope', a)).status, 404, a);
  }
  assert.equal((await act(env, row.id, 'delete')).status, 404);
  assert.equal((await op(env, 'GET', `/api/operator/photographers/${row.id}/approve`)).status, 405);
  assert.equal((await op(env, 'POST', '/api/operator/photographers')).status, 405);
  assert.equal((await op(env, 'GET', `/api/operator/photographers/${row.id}`)).status, 404);
  assert.equal((await op(env, 'GET', `/api/operator/photographers/${row.id}/approve/x`)).status, 404);
  assert.equal(account(env).status, 'pending');
});

test('each action only moves from its own status (409 otherwise)', async () => {
  const env = envOpen();
  const row = await registered(env);
  // pending: suspend / unsuspend refused
  await bad(await act(env, row.id, 'suspend'), 409, 'wrong_status');
  await bad(await act(env, row.id, 'unsuspend'), 409, 'wrong_status');
  const ok = await act(env, row.id, 'approve');
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).photographer.status, 'active');
  const approved = account(env);
  assert.equal(approved.status, 'active');
  assert.ok(approved.approved_at);
  // active: approve / reject / unsuspend refused
  await bad(await act(env, row.id, 'approve'), 409, 'wrong_status');
  await bad(await act(env, row.id, 'reject'), 409, 'wrong_status');
  await bad(await act(env, row.id, 'unsuspend'), 409, 'wrong_status');
  assert.equal(account(env).approved_at, approved.approved_at, 'a refused approve rewrites nothing');
  assert.equal((await act(env, row.id, 'suspend')).status, 200);
  // suspended: approve / reject / suspend refused
  await bad(await act(env, row.id, 'approve'), 409, 'wrong_status');
  await bad(await act(env, row.id, 'reject'), 409, 'wrong_status');
  await bad(await act(env, row.id, 'suspend'), 409, 'wrong_status');
  assert.equal(account(env).status, 'suspended');
});

test('reject deletes a pending account only', async () => {
  const env = envOpen();
  const row = await registered(env);
  const keep = await registered(env, { email: 'keep@example.com' });
  const res = await act(env, row.id, 'reject');
  assert.equal(res.status, 200);
  assert.equal(account(env), undefined);
  assert.ok(account(env, 'keep@example.com'));
  assert.equal((await act(env, row.id, 'approve')).status, 404);
  assert.equal(keep.status, 'pending');
});

test('racing actions: exactly one of approve/approve, approve/reject, suspend/suspend wins', async () => {
  for (const [x, y, setupStatus] of [['approve', 'approve', 'pending'], ['approve', 'reject', 'pending'], ['reject', 'reject', 'pending'], ['suspend', 'suspend', 'active']]) {
    const env = envOpen();
    const row = setupStatus === 'active' ? await active(env) : await registered(env);
    const statuses = (await Promise.all([act(env, row.id, x), act(env, row.id, y)])).map(r => r.status);
    const label = `${x}/${y}`;
    // the loser is told why: 409 while the row is there, 404 once a reject deleted it
    assert.equal(statuses.filter(s => s === 200).length, 1, `${label}: ${statuses}`);
    assert.ok(statuses.every(s => [200, 404, 409].includes(s)), `${label}: ${statuses}`);
  }
});

test('reset-password returns a temp password once, replaces the hash and ends every session', async () => {
  const env = envOpen();
  const { row, token } = await loggedIn(env);
  const res = await act(env, row.id, 'reset-password');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Cache-Control'), /no-store/);
  const { temp_password } = await res.json();
  assert.equal(typeof temp_password, 'string');
  assert.ok(temp_password.length >= 12, temp_password);
  assert.match(temp_password, /^[a-z2-9]+$/);
  assert.equal((await me(env, token)).status, 401, 'old sessions end');
  assert.equal(rows(env, 'SELECT * FROM photographer_sessions').length, 0);
  assert.ok(!dump(env).includes(temp_password), 'stored hashed only');
  assert.match(account(env).password_hash, /^pbkdf2\$100000\$/);
  assert.equal((await login(env)).status, 401, 'the old password stops working');
  assert.equal((await login(env, 'ann@example.com', temp_password)).status, 200);
  const list = await (await op(env, 'GET', '/api/operator/photographers')).text();
  assert.ok(!list.includes(temp_password), 'only in the reset response');
  // two resets, two different passwords; status unchanged
  const again = (await (await act(env, row.id, 'reset-password')).json()).temp_password;
  assert.notEqual(again, temp_password);
  assert.equal(account(env).status, 'active');
});

test('no response ever carries a password hash', async () => {
  const env = envOpen();
  const texts = [];
  const keep = async p => { const r = await p; texts.push(await r.clone().text()); return r; };
  await keep(register(env));
  await keep(register(env));
  const row = account(env);
  await keep(op(env, 'GET', '/api/operator/photographers'));
  await keep(act(env, row.id, 'approve'));
  const l = await keep(login(env));
  const { token } = await l.json();
  await keep(me(env, token));
  await keep(act(env, row.id, 'suspend'));
  await keep(act(env, row.id, 'unsuspend'));
  await keep(act(env, row.id, 'reset-password'));
  await keep(login(env, 'x@example.com'));
  await keep(op(env, 'GET', '/api/operator/photographers'));
  assert.ok(texts.length >= 10);
  for (const t of texts) assert.ok(!t.includes('pbkdf2') && !t.includes('password_hash') && !t.includes('token_hash'), t);
});

// ─── HARD SAFETY RULE: a photographer session opens no existing route ──────

test('an active photographer session gets 401 on every existing admin, upload, operator and client route', async () => {
  const env = envOpen();
  const { token } = await loggedIn(env);
  const project = await createProject(env);
  const routes = [
    ['GET', '/api/admin/projects'],
    ['POST', '/api/admin/projects', { title: 'x', folders: ['20260819/'] }],
    ['GET', `/api/admin/projects/${project.id}`],
    ['GET', '/api/admin/settings'],
    ['PUT', '/api/admin/settings', { studio_name: 'hacked' }],
    ['GET', '/api/admin/stats'],
    ['GET', '/api/admin/clients'],
    ['GET', '/api/admin/products'],
    ['GET', '/api/auth/verify-admin'],
    ['POST', '/api/auth/studio-token'],
    ['POST', '/api/auth/session-token'],
    ['PUT', '/2026/evil.jpg', 'bytes'],
    ['PUT', '/api/upload', 'bytes'],
    ['GET', '/api/operator/products'],
    ['GET', '/api/operator/stats'],
    ['GET', '/api/operator/photographers'],
  ];
  for (const [method, path, body] of routes) {
    const res = await call(env, path, { method, token, body });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  assert.equal(env.imagepicker._store.has('2026/evil.jpg'), false);
  // positive control: the same routes open with PHOTOGRAPHER_TOKEN
  assert.equal((await call(env, '/api/admin/projects', { token: SECRET })).status, 200);
  assert.equal((await call(env, '/api/auth/verify-admin', { token: SECRET })).status, 200);
});

test('isAdminToken still checks PHOTOGRAPHER_TOKEN only; resolvePhotographer is used by the new routes only', () => {
  const src = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('function isAdminToken('), src.indexOf('\n}\n', src.indexOf('function isAdminToken(')));
  assert.ok(fn.includes('env.PHOTOGRAPHER_TOKEN'));
  assert.ok(!/photographer_sessions|resolvePhotographer/.test(fn));
  const uses = src.split('resolvePhotographer(').length - 1;
  assert.equal(uses, 2, 'one definition, one call (GET /api/photographer/me)');
});

// ─── before the migration has run ───────────────────────────────────────────

function withoutPhotographerTables() {
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const cut = schema.indexOf('-- ─── Photographer accounts');
  assert.ok(cut > 0, 'schema.sql has the section');
  return schema.slice(0, cut);
}

test('without the migration the new routes answer 500 photographers_unavailable and nothing else changes', async () => {
  const env = envOpen({ DB: fakeDB({ schema: withoutPhotographerTables() }) });
  await bad(await register(env), 500, 'photographers_unavailable', 'register');
  await bad(await login(env), 500, 'photographers_unavailable', 'login');
  await bad(await call(env, '/api/photographer/logout', { method: 'POST', token: 'a'.repeat(64) }), 500, 'photographers_unavailable', 'logout');
  // /me is an auth check: no session can exist before the tables do
  await bad(await me(env, 'a'.repeat(64)), 401, 'unauthorized', 'me');
  await bad(await op(env, 'GET', '/api/operator/photographers'), 500, 'photographers_unavailable', 'list');
  for (const a of ['approve', 'reject', 'suspend', 'unsuspend', 'reset-password']) {
    await bad(await act(env, 'x', a), 500, 'photographers_unavailable', a);
  }
  // the rest works as before
  assert.equal((await call(env, '/api/admin/projects', { token: SECRET })).status, 200);
  assert.equal((await op(env, 'GET', '/api/operator/products')).status, 200);
});

test('unknown /api/photographer/ paths and methods never fall through to the upload route', async () => {
  const env = envOpen();
  for (const [method, path, status] of [
    ['PUT', '/api/photographer/register', 405],
    ['GET', '/api/photographer/login', 405],
    ['POST', '/api/photographer/me', 405],
    ['PUT', '/api/photographer/x', 404],
    ['PUT', '/api/photographer', 404],
    ['GET', '/api/photographer/login/x', 404],
  ]) {
    const res = await call(env, path, { method, token: SECRET, body: method === 'GET' ? undefined : 'bytes' });
    assert.equal(res.status, status, `${method} ${path}`);
  }
  assert.ok(![...env.imagepicker._store.keys()].some(k => k.startsWith('api/')));
});

// ─── security review of 1d98a1b ─────────────────────────────────────────────

test('a reset-password landing between a login’s verify and its session write leaves no session', async () => {
  const env = envOpen();
  const row = await active(env);
  // hold the login's session batch until the reset has committed
  // tag each bound statement with its SQL (test-side only) so the gate can find the session write
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    const stmt = realPrepare(sql);
    return { ...stmt, bind: (...a) => ({ ...stmt.bind(...a), sql }) };
  };
  const realBatch = env.DB.batch.bind(env.DB);
  let release, reached;
  const gate = new Promise(r => { release = r; });
  const atGate = new Promise(r => { reached = r; });
  env.DB.batch = async statements => {
    if (statements.some(st => /INSERT INTO photographer_sessions/.test(st.sql ?? ''))) { reached(); await gate; }
    return realBatch(statements);
  };
  const pending = login(env);
  await atGate;                                         // the old password was verified
  const reset = await act(env, row.id, 'reset-password');
  assert.equal(reset.status, 200);
  release();
  const res = await pending;
  assert.equal(res.status, 401, 'the old password must not mint a session after the reset');
  assert.deepEqual(await res.json(), { error: '帳號或密碼不正確，或帳號尚未開通', code: 'login_failed' });
  assert.equal(rows(env, 'SELECT * FROM photographer_sessions').length, 0);
});

test('login throttle: 10 failures per email in 15 minutes, then 429 before any PBKDF2', async () => {
  const env = envOpen();
  await active(env);
  // ten different IPs, one email
  for (let i = 0; i < 10; i++) assert.equal((await loginFrom(env, `198.51.100.${i}`, 'ann@example.com', `wrong guess ${i}`)).status, 401);
  const subtle = globalThis.crypto.subtle;
  const realDerive = subtle.deriveBits;
  let derives = 0;
  subtle.deriveBits = function (...a) { derives++; return realDerive.apply(this, a); };
  try {
    const res = await loginFrom(env, '198.51.100.99');            // right password, fresh IP
    await bad(res, 429, 'too_many_attempts');
    assert.equal(derives, 0, 'refused before PBKDF2');
  } finally { subtle.deriveBits = realDerive; }
  assert.equal(rows(env, 'SELECT * FROM photographer_sessions').length, 0);
  // another email from a fresh IP is unaffected
  await active(env, { email: 'bob@example.com' });
  assert.equal((await loginFrom(env, '198.51.100.98', 'bob@example.com')).status, 200);
  // the window passes: the email logs in again
  env.DB._db.prepare('UPDATE photographer_login_failures SET created_at = ?').run(new Date(Date.now() - 16 * 60000).toISOString());
  assert.equal((await loginFrom(env, '198.51.100.97')).status, 200);
});

test('login throttle: 10 failures per IP (any emails), then 429; another IP is fine', async () => {
  const env = envOpen();
  await active(env);
  for (let i = 0; i < 10; i++) assert.equal((await loginFrom(env, IP, `nobody${i}@example.com`)).status, 401);
  await bad(await loginFrom(env, IP), 429, 'too_many_attempts');
  assert.equal((await loginFrom(env, '192.0.2.1')).status, 200);
  const raw = JSON.stringify(rows(env, 'SELECT * FROM photographer_login_failures'));
  assert.ok(!raw.includes(IP) && !raw.includes('nobody'), 'keys are hashed');
});

test('login throttle: successes do not count and do not reset; the cap holds under parallel requests', async () => {
  const env = envOpen();
  await active(env);
  for (let i = 0; i < 9; i++) assert.equal((await loginFrom(env, IP, `x${i}@example.com`)).status, 401);
  for (let i = 0; i < 3; i++) assert.equal((await loginFrom(env, IP)).status, 200, 'successes pass and are not failures');
  assert.equal((await loginFrom(env, IP, 'x9@example.com')).status, 401, 'the 10th failure');
  await bad(await loginFrom(env, IP), 429, 'too_many_attempts', 'a success did not reset the IP counter');

  const env2 = envOpen();
  await active(env2);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => loginFrom(env2, '203.0.113.50', 'ann@example.com', `wrong ${i}`)));
  const statuses = results.map(r => r.status).sort();
  assert.deepEqual(statuses, [...Array(10).fill(401), ...Array(10).fill(429)]);
});

test('login throttle: old failure rows are pruned', async () => {
  const env = envOpen();
  await active(env);
  env.DB._db.prepare('INSERT INTO photographer_login_failures (key_hash, attempt, created_at) VALUES (?, ?, ?)').run('old', 'a', new Date(Date.now() - 2 * 86400000).toISOString());
  assert.equal((await loginFrom(env, IP, 'ann@example.com', 'wrong password!')).status, 401);
  assert.equal(rows(env, "SELECT * FROM photographer_login_failures WHERE key_hash = 'old'").length, 0);
});

test('a duplicate registration bumps dup_attempts / last_dup_at only, and the answer stays identical', async () => {
  const env = envOpen();
  const first = await register(env);
  const before = account(env);
  assert.equal(before.dup_attempts, 0);
  assert.equal(before.last_dup_at, null);
  const again = await register(env, { password: 'victim password', display_name: 'Victim' }, '192.0.2.44');
  assert.equal(again.status, first.status);
  assert.equal(await again.text(), await first.text());
  await register(env, { email: 'ANN@example.com' }, '192.0.2.45');
  const after = account(env);
  assert.equal(after.dup_attempts, 2);
  assert.ok(after.last_dup_at);
  for (const k of ['id', 'email', 'password_hash', 'display_name', 'studio_note', 'status', 'created_at']) assert.equal(after[k], before[k], k);
  const list = await (await op(env, 'GET', '/api/operator/photographers')).json();
  assert.equal(list.photographers[0].dup_attempts, 2);
  assert.equal(list.photographers[0].last_dup_at, after.last_dup_at);
});

test('IPv6 signups are limited per /64; IPv4 per address', async () => {
  const env = envOpen();
  const v6 = ['2001:db8:1:2::1', '2001:db8:1:2:aaaa::5', '2001:0db8:0001:0002:ffff:ffff:ffff:ffff', '2001:DB8:1:2::9', '2001:db8:1:2:0:0:0:7'];
  for (let i = 0; i < 5; i++) await registered(env, { email: `v6-${i}@example.com` }, v6[i]);
  await bad(await register(env, { email: 'v6-x@example.com' }, '2001:db8:1:2:dead:beef::1'), 429, 'rate_limited', 'same /64');
  await registered(env, { email: 'v6-y@example.com' }, '2001:db8:1:3::1');   // the next /64
  await registered(env, { email: 'v6-z@example.com' }, '::1');                // a different /64 entirely
  await registered(env, { email: 'v4@example.com' }, '192.0.2.10');
  await registered(env, { email: 'v4b@example.com' }, '192.0.2.11');          // IPv4: each address its own
  // '::' early in the address: the /64 is still the first four groups after expanding it
  const short = ['2001:db8::1', '2001:db8::2:3', '2001:db8:0:0:ffff::', '2001:db8::1:0:0:1', '2001:0db8:0000:0000::9'];
  for (let i = 0; i < 5; i++) await registered(env, { email: `short-${i}@example.com` }, short[i]);
  await bad(await register(env, { email: 'short-x@example.com' }, '2001:db8::abcd'), 429, 'rate_limited', '2001:db8:0:0::/64');
  await registered(env, { email: 'short-y@example.com' }, '2001:db8:0:1::1');
});

test('IPv6 logins are throttled per /64 as well', async () => {
  const env = envOpen();
  await active(env);
  for (let i = 0; i < 10; i++) assert.equal((await loginFrom(env, `2001:db8:9:9::${i + 1}`, `n${i}@example.com`)).status, 401);
  await bad(await loginFrom(env, '2001:db8:9:9:ffff::1'), 429, 'too_many_attempts');
  assert.equal((await loginFrom(env, '2001:db8:9:a::1')).status, 200);
});

test('registration answers 429 registration_busy while 200 accounts are pending', async () => {
  const env = envOpen();
  const ins = env.DB._db.prepare("INSERT INTO photographers (id, email, password_hash, display_name, status, created_at) VALUES (?, ?, 'x', 'n', ?, '2026-10-01T00:00:00.000Z')");
  for (let i = 0; i < 199; i++) ins.run(`seed${i}`, `seed${i}@example.com`, 'pending');
  for (let i = 0; i < 50; i++) ins.run(`act${i}`, `act${i}@example.com`, 'active');
  await registered(env, { email: 'the200th@example.com' });   // 199 pending: still room
  verifies = [];
  await bad(await register(env, { email: 'the201st@example.com' }), 429, 'registration_busy');
  assert.equal(verifies.length, 0, 'refused before Turnstile');
  assert.equal(account(env, 'the201st@example.com'), undefined);
});

test('the operator list stops at 500 rows; pending_count still counts them all', async () => {
  const env = envOpen();
  const ins = env.DB._db.prepare("INSERT INTO photographers (id, email, password_hash, display_name, status, created_at) VALUES (?, ?, 'x', 'n', 'pending', ?)");
  for (let i = 0; i < 520; i++) ins.run(`p${i}`, `p${i}@example.com`, new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString());
  const body = await (await op(env, 'GET', '/api/operator/photographers')).json();
  assert.equal(body.photographers.length, 500);
  assert.equal(body.photographers[0].id, 'p519', 'newest first');
  assert.equal(body.pending_count, 520);
});

test('pending accounts always make the 500-row operator list, however many newer accounts exist', async () => {
  const env = envOpen();
  const ins = env.DB._db.prepare("INSERT INTO photographers (id, email, password_hash, display_name, status, created_at) VALUES (?, ?, 'x', 'n', ?, ?)");
  ins.run('old-pending', 'old@example.com', 'pending', '2025-01-01T00:00:00.000Z');
  for (let i = 0; i < 520; i++) ins.run(`a${i}`, `a${i}@example.com`, i % 2 ? 'active' : 'suspended', new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString());
  const body = await (await op(env, 'GET', '/api/operator/photographers')).json();
  assert.equal(body.photographers.length, 500);
  assert.equal(body.photographers[0].id, 'old-pending', 'pending first');
  assert.equal(body.photographers[1].id, 'a519', 'then newest first');
  assert.equal(body.pending_count, 1);
});

test('Turnstile: a hung siteverify is abandoned after 5 s and fails closed', async () => {
  const env = envOpen();
  turnstile = 'hang';
  const t0 = Date.now();
  await bad(await register(env), 403, 'turnstile_failed');
  const took = Date.now() - t0;
  assert.ok(took >= 4500 && took < 9000, `${took} ms`);
  assert.equal(rows(env, 'SELECT * FROM photographers').length, 0);
});

test('Turnstile: the hostname is checked only when TURNSTILE_HOSTNAME is set', async () => {
  for (const [host, mode, status] of [
    [undefined, 'other-host', 202], [undefined, 'no-host', 202],
    ['imhoti.tw', 'ok', 202], ['imhoti.tw', 'other-host', 403], ['imhoti.tw', 'no-host', 403],
  ]) {
    const env = envOpen(host ? { TURNSTILE_HOSTNAME: host } : {});
    turnstile = mode;
    const res = await register(env);
    assert.equal(res.status, status, `${host} ${mode}`);
  }
});

test('emails are printable ASCII only: full-width look-alikes and markup are refused', async () => {
  for (const email of ['ａnn@example.com', 'ann@exａmple.com', 'ann@例子.tw', '<img src=x onerror=alert(1)>@x.co', 'a"b@example.com', "a'b@example.com",
    'a`b@example.com', 'a\\b@example.com', 'a<b@example.com', 'a>b@example.com', 'ann@exa_mple.com', 'ann@-.com']) {
    const env = envOpen();
    await bad(await register(env, { email }), 400, 'invalid_email', email);
  }
  const env = envOpen();
  await registered(env, { email: 'first.last+tag@sub-domain.example.co' });
});
