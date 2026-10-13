// Registering with a photographer invite code (docs/multi-photographer.md,
// 邀請碼): POST /api/photographer/register-invite {email, password,
// display_name, studio_note?, invite_code}. A live code, with the email it
// was made for, creates an ACTIVE account at once and spends the code in the
// same D1 batch (no review, no Turnstile, PHOTOGRAPHER_SIGNUP not needed),
// answering a session like login does. Every bad code — wrong, used,
// expired, revoked, malformed, or another email than the invited one — and
// an email that already has an account get one identical 400, and the code is
// spent only when the account lands. Guesses are throttled per network and
// per email before the code is looked at (no count shared by everyone).
// Closed (403) unless
// PHOTOGRAPHER_ROUTES is exactly "on"; no secret or no migration is 500
// invites_unavailable. The open sign-up (/register) is untouched.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDB } from './fakes.mjs';
import { SECRET, setup, call, one, rows, sha256Hex } from './pick-helpers.mjs';
import { seedPhotographer, snapshot } from './tenant-helpers.mjs';

const OP = 'operator-secret';
const INVITE_KEY = 'photographer-invite-secret-0123456789abcdef';
const PASSWORD = 'correct horse battery';
const IP = '203.0.113.9';
const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

const envOn = (extra = {}) => setup({ OPERATOR_TOKEN: OP, PHOTOGRAPHER_INVITE_SECRET: INVITE_KEY, PHOTOGRAPHER_ROUTES: 'on', ...extra });
function withoutInvitesTable(schema = SCHEMA) {
  const cut = schema.replace(/CREATE TABLE IF NOT EXISTS photographer_invites \([\s\S]*?\n\);\n/, '').replace(/CREATE INDEX IF NOT EXISTS idx_photographer_invites_\w+ ON photographer_invites\([^)]*\);\n/g, '');
  assert.notEqual(cut, schema, 'schema.sql has the table');
  return cut;
}
function withoutMustChange(schema = SCHEMA) {
  const cut = schema.replace(/(last_dup_at\s+TEXT),[\s\S]*?\n\s*must_change_password INTEGER NOT NULL DEFAULT 0/, '$1');
  assert.notEqual(cut, schema, 'schema.sql has the column');
  return cut;
}

async function newCode(env, body = {}) {
  const res = await call(env, '/api/operator/photographer-invites', { method: 'POST', token: OP, body: { email: 'ann@example.com', ...body } });
  assert.equal(res.status, 201, await res.clone().text());
  return res.json();
}
const registerInvite = (env, body = {}, ip = IP) => call(env, '/api/photographer/register-invite', {
  method: 'POST',
  headers: ip ? { 'CF-Connecting-IP': ip } : {},
  body: { email: 'Ann@Example.com', password: PASSWORD, display_name: '安攝影', ...body },
});
const account = (env, email = 'ann@example.com') => one(env, 'SELECT * FROM photographers WHERE email = ?', email);
const invite = (env, id) => one(env, 'SELECT * FROM photographer_invites WHERE id = ?', id);
const setInvite = (env, id, col, value) => env.DB._db.prepare(`UPDATE photographer_invites SET ${col} = ? WHERE id = ?`).run(value, id);
const past = () => new Date(Date.now() - 1000).toISOString();
const me = (env, token) => call(env, '/api/photographer/me', { token });
const login = (env, email = 'ann@example.com', password = PASSWORD, ip = IP) =>
  call(env, '/api/photographer/login', { method: 'POST', headers: { 'CF-Connecting-IP': ip }, body: { email, password } });
// everything but the throttle's rows (a refused guess is meant to leave one)
function snapshotWithoutThrottle(env) {
  const s = JSON.parse(snapshot(env));
  delete s.data.photographer_login_failures;
  return JSON.stringify(s);
}
const INVALID = { error: '邀請碼不正確或已失效，或此 Email 無法使用', code: 'invalid_invite' };
const CLOSED = { error: '目前未開放註冊', code: 'registration_closed' };
const UNAVAILABLE = { error: '邀請碼功能尚未啟用', code: 'invites_unavailable' };
const TOO_MANY = { error: '嘗試次數太多，請 15 分鐘後再試', code: 'too_many_attempts' };

// no test here may reach Turnstile (or anything else over the network)
const realFetch = globalThis.fetch;
let fetches = 0;
globalThis.fetch = async () => { fetches++; return Response.json({ success: false }); };
after(() => { globalThis.fetch = realFetch; });

// ─── the way in ────────────────────────────────────────────────────────────

test('a live code: 201 {token, photographer, must_change_password: false}; an ACTIVE account, the code spent by it, in one go', async () => {
  const env = envOn();
  const { id, code } = await newCode(env, { note: '給安' });
  const t0 = new Date().toISOString();
  const res = await registerInvite(env, { invite_code: code, studio_note: '安安工作室' });
  assert.equal(res.status, 201, await res.clone().text());
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['must_change_password', 'photographer', 'token'], 'the login answer\'s shape');
  assert.equal(body.must_change_password, false);
  assert.match(body.token, /^[0-9a-f]{64}$/);
  const row = account(env);
  assert.deepEqual(body.photographer, { id: row.id, display_name: '安攝影' });
  assert.match(row.id, /^[0-9a-f]{16}$/);
  assert.equal(row.status, 'active');
  assert.equal(row.email, 'ann@example.com');
  assert.equal(row.display_name, '安攝影');
  assert.equal(row.studio_note, '安安工作室');
  assert.equal(row.must_change_password, 0);
  assert.equal(row.dup_attempts, 0);
  assert.ok(row.created_at >= t0);
  assert.equal(row.approved_at, row.created_at, 'approved when made');
  assert.match(row.password_hash, /^pbkdf2\$100000\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  const inv = invite(env, id);
  assert.equal(inv.used_by, row.id);
  assert.equal(inv.used_at, row.created_at);
  assert.equal(inv.revoked_at, null);
  // the session works now, for 30 days; the password logs in
  const who = await (await me(env, body.token)).json();
  assert.deepEqual(who, { photographer: { id: row.id, display_name: '安攝影', email: 'ann@example.com' }, must_change_password: false });
  const session = one(env, 'SELECT * FROM photographer_sessions WHERE photographer_id = ?', row.id);
  const life = Date.parse(session.expires_at) - Date.parse(session.created_at);
  assert.equal(life, 30 * 24 * 60 * 60 * 1000);
  assert.equal((await login(env)).status, 200);
  // a success is not a failure: no throttle row stays behind
  assert.equal(rows(env, 'SELECT * FROM photographer_login_failures').length, 0);
  // never stored in plain text: not the code, not the password, not the IP
  const all = snapshot(env);
  for (const secret of [code, PASSWORD, IP, body.token]) assert.ok(!all.includes(secret), `${secret} in D1`);
  assert.equal(fetches, 0, 'no Turnstile');
});

test('PHOTOGRAPHER_SIGNUP and TURNSTILE_SECRET play no part: open sign-up off, the code still works', async () => {
  for (const extra of [{}, { PHOTOGRAPHER_SIGNUP: 'off' }, { PHOTOGRAPHER_SIGNUP: 'on', TURNSTILE_SECRET: 'ts' }]) {
    const env = envOn(extra);
    const { code } = await newCode(env);
    assert.equal((await registerInvite(env, { invite_code: code })).status, 201, JSON.stringify(extra));
  }
  assert.equal(fetches, 0);
});

test('a code works once: a replay (another email, the same IP or another) is the one 400 and makes nothing', async () => {
  const env = envOn();
  const { code } = await newCode(env);
  assert.equal((await registerInvite(env, { invite_code: code })).status, 201);
  const before = snapshotWithoutThrottle(env);
  for (const [email, ip] of [['bob@example.com', IP], ['carl@example.com', '198.51.100.2'], ['ann@example.com', IP]]) {
    const res = await registerInvite(env, { invite_code: code, email }, ip);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), INVALID);
  }
  assert.equal(snapshotWithoutThrottle(env), before);
  assert.equal(rows(env, 'SELECT * FROM photographers').length, 1);
});

test('wrong, used, expired, revoked, malformed codes and another email than the invited one all answer the same status and body (no oracle), and write nothing but the throttle row', async () => {
  const env = envOn();
  const used = await newCode(env, { email: 'used@example.com' });
  assert.equal((await registerInvite(env, { invite_code: used.code, email: 'used@example.com' }, '198.51.100.1')).status, 201);
  const expired = await newCode(env, { email: 'expired@example.com' });
  setInvite(env, expired.id, 'expires_at', past());
  const revoked = await newCode(env, { email: 'revoked@example.com' });
  assert.equal((await call(env, `/api/operator/photographer-invites/${revoked.id}/revoke`, { method: 'POST', token: OP })).status, 200);
  const live = await newCode(env, { email: 'live@example.com' });
  const other = await newCode(env, { email: 'other@example.com' });
  const wrong = String((Number(live.code) + 1) % 100000000).padStart(8, '0');
  const L = 'live@example.com';
  const cases = [['used@example.com', used.code], ['expired@example.com', expired.code], ['revoked@example.com', revoked.code],
    [L, wrong], [L, '00000000'], [L, live.code.slice(0, 7)], [L, live.code + '0'], [L, ` ${live.code}`], [L, `${live.code.slice(0, 4)}-${live.code.slice(4)}`],
    [L, Number(live.code)], [L, null], [L, undefined], [L, [live.code]], [L, { code: live.code }], [L, '１２３４５６７８'], [L, '1234567a'], [L, ''],
    // a live code with an email it was not made for (another invitee's, or nobody's)
    ['other@example.com', live.code], ['stranger@example.com', live.code], [L, other.code], [L, expired.code]];
  const answers = new Set();
  for (const [i, [email, invite_code]] of cases.entries()) {
    const before = snapshotWithoutThrottle(env);
    // a fresh network each time, so the per-network limit is not what answers;
    // the per-email one is cleared, so it is not what answers either
    env.DB._db.prepare('DELETE FROM photographer_login_failures').run();
    const res = await registerInvite(env, { invite_code, email }, `192.0.2.${i + 1}`);
    answers.add(`${res.status} ${await res.text()}`);
    assert.equal(snapshotWithoutThrottle(env), before, `case ${i} wrote`);
  }
  assert.deepEqual([...answers], [`400 ${JSON.stringify(INVALID)}`]);
  // the live ones still work afterwards, each with its own email
  env.DB._db.prepare('DELETE FROM photographer_login_failures').run();
  assert.equal((await registerInvite(env, { invite_code: live.code, email: 'LIVE@example.com' }, '192.0.2.200')).status, 201);
  assert.equal((await registerInvite(env, { invite_code: other.code, email: 'other@example.com' }, '192.0.2.201')).status, 201);
});

test('an expired code fails at the edge: one whose expiry is now is already expired', async () => {
  const env = envOn();
  const { id, code } = await newCode(env);
  setInvite(env, id, 'expires_at', new Date(Date.now() - 1).toISOString());
  const res = await registerInvite(env, { invite_code: code });
  assert.equal(res.status, 400);
  assert.equal(invite(env, id).used_at, null);
});

// ─── races ─────────────────────────────────────────────────────────────────

test('race: two registrations with the same code at once make exactly one account; the code names it', async () => {
  for (const sameEmail of [false, true]) {
    const env = envOn();
    const { id, code } = await newCode(env, { email: 'one@example.com' });
    const res = await Promise.all([
      registerInvite(env, { invite_code: code, email: 'one@example.com' }, '198.51.100.1'),
      registerInvite(env, { invite_code: code, email: sameEmail ? 'one@example.com' : 'two@example.com' }, '198.51.100.2'),
      registerInvite(env, { invite_code: code, email: sameEmail ? 'ONE@example.com' : 'three@example.com' }, '198.51.100.3'),
    ]);
    const statuses = res.map(r => r.status).sort();
    assert.deepEqual(statuses, [201, 400, 400], `sameEmail ${sameEmail}`);
    const made = rows(env, 'SELECT * FROM photographers');
    assert.equal(made.length, 1);
    assert.equal(invite(env, id).used_by, made[0].id);
    assert.equal(rows(env, 'SELECT * FROM photographer_sessions').length, 1, 'one session, the winner\'s');
  }
});

test('race: the operator revokes while a registration is in flight — whichever lands first wins, never both', async () => {
  const env = envOn();
  const { id, code } = await newCode(env);
  const [reg, rev] = await Promise.all([
    registerInvite(env, { invite_code: code }),
    call(env, `/api/operator/photographer-invites/${id}/revoke`, { method: 'POST', token: OP }),
  ]);
  assert.equal(rev.status, 200);
  const row = invite(env, id);
  if (reg.status === 201) {
    assert.ok(row.used_by && !row.revoked_at);
    assert.ok(account(env));
  } else {
    assert.equal(reg.status, 400);
    assert.ok(row.revoked_at && !row.used_by);
    assert.equal(account(env), undefined);
  }
});

test('a code revoked or expired after it was looked up (between the read and the batch) makes nothing', async () => {
  for (const col of ['revoked_at', 'expires_at', 'used_at']) {
    const env = envOn();
    const { id, code } = await newCode(env);
    // the moment the batch starts, the row changes under it
    const batch = env.DB.batch.bind(env.DB);
    env.DB.batch = statements => {
      env.DB._db.prepare(`UPDATE photographer_invites SET ${col} = ? WHERE id = ?`).run(past(), id);
      return batch(statements);
    };
    const res = await registerInvite(env, { invite_code: code });
    assert.equal(res.status, 400, col);
    assert.deepEqual(await res.json(), INVALID);
    assert.equal(rows(env, 'SELECT * FROM photographers').length, 0, col);
    assert.equal(rows(env, 'SELECT * FROM photographer_sessions').length, 0, col);
    assert.equal(invite(env, id).used_by, null, col);
  }
});

// ─── emails that are taken ─────────────────────────────────────────────────

test('an email that got an account after its invite was made (any status, any spelling) is the same 400 as a bad code, changes nothing, and does not burn the code', async () => {
  const env = envOn();
  const emails = ['active@example.com', 'pending@example.com', 'suspended@example.com', 'squat@example.com'];
  const codes = {};
  for (const email of emails) codes[email] = await newCode(env, { email });
  // the accounts appear only now (open sign-up, or a hand-made row)
  await seedPhotographer(env, { email: 'active@example.com' });
  const pending = await seedPhotographer(env, { email: 'pending@example.com', status: 'pending' });
  await seedPhotographer(env, { email: 'suspended@example.com', status: 'suspended' });
  await seedPhotographer(env, { id: 'default', email: 'squat@example.com' });
  let n = 0;
  for (const email of emails) {
    for (const spelling of [email, email.toUpperCase(), `  ${email} `]) {
      const before = snapshotWithoutThrottle(env);
      // a fresh network each time, so the per-network limit is not what answers
      const res = await registerInvite(env, { invite_code: codes[email].code, email: spelling }, `192.0.2.${++n}`);
      assert.equal(res.status, 400, spelling);
      assert.deepEqual(await res.json(), INVALID, spelling);
      assert.equal(snapshotWithoutThrottle(env), before, `${spelling} wrote`);
    }
  }
  assert.equal(one(env, "SELECT status FROM photographers WHERE email = 'suspended@example.com'").status, 'suspended');
  assert.equal(one(env, "SELECT id FROM photographers WHERE email = 'squat@example.com'").id, 'default');
  for (const email of emails) assert.equal(invite(env, codes[email].id).used_at, null, `${email}: the code is still live`);
  // the pending sign-up is rejected (deleted): the invite now works for that email
  assert.equal((await call(env, `/api/operator/photographers/${pending.id}/reject`, { method: 'POST', token: OP })).status, 200);
  const res = await registerInvite(env, { invite_code: codes['pending@example.com'].code, email: 'pending@example.com' }, '198.51.100.77');
  assert.equal(res.status, 201);
  const made = await res.json();
  assert.notEqual(made.photographer.id, 'default');
  assert.equal(account(env, 'pending@example.com').status, 'active');
});

// ─── the input ─────────────────────────────────────────────────────────────

test('fields are checked as /register checks them (400, same codes), before the throttle; nothing written, the code stays live', async () => {
  const env = envOn();
  const { id, code } = await newCode(env);
  const before = snapshot(env);
  for (const [body, errCode] of [
    [{ email: 'not-an-email' }, 'invalid_email'],
    [{ email: 'ａnn@example.com' }, 'invalid_email'],
    [{ email: undefined }, 'invalid_email'],
    [{ password: 'short' }, 'invalid_password'],
    [{ password: 'x'.repeat(201) }, 'invalid_password'],
    [{ password: 1234567890 }, 'invalid_password'],
    [{ display_name: '' }, 'invalid_display_name'],
    [{ display_name: 'x'.repeat(51) }, 'invalid_display_name'],
    [{ display_name: 'a‮b' }, 'invalid_display_name'],
    [{ studio_note: 'x'.repeat(301) }, 'invalid_studio_note'],
    [{ studio_note: 5 }, 'invalid_studio_note'],
  ]) {
    const res = await registerInvite(env, { invite_code: code, ...body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).code, errCode, JSON.stringify(body));
  }
  for (const raw of ['not json', '[]', '"x"', 'null']) {
    const res = await call(env, '/api/photographer/register-invite', { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': IP } });
    assert.equal(res.status, 400, raw);
  }
  const big = await call(env, '/api/photographer/register-invite', { method: 'POST', body: JSON.stringify({ invite_code: code, pad: 'x'.repeat(17 * 1024) }), headers: { 'CF-Connecting-IP': IP } });
  assert.equal(big.status, 413);
  assert.equal(snapshot(env), before);
  assert.equal(invite(env, id).used_at, null);
  // the wrong method
  assert.equal((await call(env, '/api/photographer/register-invite')).status, 405);
});

// ─── closed, unavailable ───────────────────────────────────────────────────

test('PHOTOGRAPHER_ROUTES not exactly "on": 403 registration_closed before the body is read, nothing written, the code stays live', async () => {
  for (const routes of [undefined, 'off', 'ON', ' on', 'true', '1']) {
    const env = envOn({ PHOTOGRAPHER_ROUTES: routes });
    const { id, code } = await newCode(env);
    const before = snapshot(env);
    const res = await registerInvite(env, { invite_code: code });
    assert.equal(res.status, 403, String(routes));
    assert.deepEqual(await res.json(), CLOSED);
    const junk = await call(env, '/api/photographer/register-invite', { method: 'POST', body: 'not json' });
    assert.equal(junk.status, 403);
    assert.equal(snapshot(env), before);
    assert.equal(invite(env, id).used_at, null);
  }
});

test('no PHOTOGRAPHER_INVITE_SECRET (or under 32 characters): 500 invites_unavailable, nothing written', async () => {
  for (const secret of [undefined, '', 'x'.repeat(31)]) {
    const env = envOn({ PHOTOGRAPHER_INVITE_SECRET: secret });
    // a row as if a code had been made with some other key
    env.DB._db.prepare("INSERT INTO photographer_invites (id, email, code_hash, created_at, expires_at) VALUES ('i1', 'ann@example.com', 'h', ?, ?)").run(past(), new Date(Date.now() + 3600000).toISOString());
    const before = snapshot(env);
    const res = await registerInvite(env, { invite_code: '12345678' });
    assert.equal(res.status, 500, String(secret));
    assert.deepEqual(await res.json(), UNAVAILABLE);
    assert.equal(snapshot(env), before);
  }
});

test('before the migration: 500 invites_unavailable and nothing written (no throttle row either); open sign-up answers as before', async () => {
  for (const schema of [withoutInvitesTable(), withoutInvitesTable(withoutMustChange())]) {
    const env = envOn({ DB: fakeDB({ schema }) });
    const before = snapshot(env);
    const res = await registerInvite(env, { invite_code: '12345678' });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), UNAVAILABLE);
    assert.equal(snapshot(env), before);
    // /register is untouched: closed while PHOTOGRAPHER_SIGNUP is off, as always
    const open = await call(env, '/api/photographer/register', { method: 'POST', body: { email: 'a@example.com', password: PASSWORD, display_name: 'A', turnstileToken: 't' } });
    assert.equal(open.status, 403);
    assert.equal((await open.json()).code, 'registration_closed');
  }
});

test('before the 2026-10-15 migration (no must_change_password column, prod today): registration works, must_change_password null as login says it', async () => {
  const env = envOn({ DB: fakeDB({ schema: withoutMustChange() }) });
  const { id, code } = await newCode(env);
  const res = await registerInvite(env, { invite_code: code });
  assert.equal(res.status, 201, await res.clone().text());
  const body = await res.json();
  assert.equal(body.must_change_password, null);
  const row = account(env);
  assert.equal(row.status, 'active');
  assert.ok(!('must_change_password' in row));
  assert.equal(invite(env, id).used_by, row.id);
  assert.equal((await me(env, body.token)).status, 200);
  const l = await login(env);
  assert.equal(l.status, 200);
  assert.equal((await l.json()).must_change_password, null);
});

// ─── the guess limits ──────────────────────────────────────────────────────

test('throttle: 5 refused codes per network (IPv6 by /64) in 15 minutes, then 429 before the code is looked at — a live code too, which stays live', async () => {
  const env = envOn();
  const { id, code } = await newCode(env);
  for (let i = 0; i < 5; i++) {
    assert.equal((await registerInvite(env, { invite_code: '00000000', email: `g${i}@example.com` }, '2001:db8:1:2::a')).status, 400);
  }
  const before = snapshot(env);
  const refused = await registerInvite(env, { invite_code: code }, '2001:db8:1:2:ffff::1');
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), TOO_MANY);
  assert.equal(snapshot(env), before, 'a refused attempt reserves nothing');
  assert.equal(invite(env, id).used_at, null);
  // another network is not held up
  assert.equal((await registerInvite(env, { invite_code: code }, '2001:db8:1:3::a')).status, 201);
  // the rows hold hashes, never the address
  assert.ok(!snapshot(env).includes('2001:db8'));
  // the window: failures older than 15 minutes no longer count
  env.DB._db.prepare('UPDATE photographer_login_failures SET created_at = ?').run(new Date(Date.now() - 16 * 60 * 1000).toISOString());
  const again = await newCode(env, { email: 'late@example.com' });
  assert.equal((await registerInvite(env, { invite_code: again.code, email: 'late@example.com' }, '2001:db8:1:2::a')).status, 201);
});

test('throttle: 5 refused codes per email in 15 minutes from any number of networks, then 429 for that email only — its live code stays live', async () => {
  const env = envOn();
  const { id, code } = await newCode(env);
  const bob = await newCode(env, { email: 'bob@example.com' });
  for (let i = 0; i < 5; i++) {
    assert.equal((await registerInvite(env, { invite_code: '00000000', email: i % 2 ? 'ANN@example.com' : 'ann@example.com' }, `10.0.0.${i + 1}`)).status, 400);
  }
  const before = snapshot(env);
  const refused = await registerInvite(env, { invite_code: code }, '10.0.1.1');
  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), TOO_MANY);
  assert.equal(snapshot(env), before);
  assert.equal(invite(env, id).used_at, null);
  // another invitee is not held up, nor are those networks
  assert.equal((await registerInvite(env, { invite_code: bob.code, email: 'bob@example.com' }, '10.0.0.1')).status, 201);
});

test('throttle: no count shared by everyone — 100 refusals from 100 networks with 100 emails hold no other invitee up', async () => {
  const env = envOn();
  const { code } = await newCode(env);
  for (let i = 0; i < 100; i++) {
    const res = await registerInvite(env, { invite_code: '00000000', email: `g${i}@example.com` }, `10.0.${Math.floor(i / 4)}.${i % 4}`);
    assert.equal(res.status, 400, `guess ${i}`);
  }
  // each refusal leaves exactly two rows, its network's and its email's: no third, shared key
  const left = rows(env, 'SELECT key_hash, COUNT(*) AS n FROM photographer_login_failures GROUP BY key_hash');
  assert.equal(left.reduce((t, r) => t + r.n, 0), 200);
  assert.ok(left.every(r => r.n === 1), 'no key counts across networks and emails');
  // the old shared key, filled to any level, holds nothing up
  const ins = env.DB._db.prepare('INSERT INTO photographer_login_failures (key_hash, attempt, created_at) VALUES (?, ?, ?)');
  for (const k of [await sha256Hex(`photographer-invite-all:${INVITE_KEY}`)]) for (let i = 0; i < 2000; i++) ins.run(k, `seed${i}`, new Date().toISOString());
  assert.equal((await registerInvite(env, { invite_code: code }, '198.51.100.250')).status, 201);
});

test('throttle: a malformed code (or none) counts like a wrong one', async () => {
  const env = envOn();
  const { code } = await newCode(env);
  for (const invite_code of ['1', undefined, 12345678, 'abcdefgh', `${code}9`]) {
    assert.equal((await registerInvite(env, { invite_code })).status, 400);
  }
  assert.equal((await registerInvite(env, { invite_code: code })).status, 429);
});

test('an older row with the same email and code (a replaced, used or expired one) does not hide the live newer one', async () => {
  for (const col of ['used_at', 'revoked_at', 'expires_at']) {
    const env = envOn();
    const older = await newCode(env);
    const newer = await newCode(env);
    // the newer one replaced the older (revoked it); leave only `col` set on it
    setInvite(env, older.id, 'revoked_at', null);
    setInvite(env, older.id, 'code_hash', invite(env, newer.id).code_hash);
    setInvite(env, older.id, col, past());
    // the older one is first by created_at (and by rowid)
    setInvite(env, older.id, 'created_at', new Date(Date.now() - 60000).toISOString());
    const res = await registerInvite(env, { invite_code: newer.code });
    assert.equal(res.status, 201, col);
    assert.equal(invite(env, newer.id).used_by, account(env).id, col);
    assert.equal(invite(env, older.id).used_by, null, col);
  }
});

test('throttle: parallel guesses cannot pass the per-network cap', async () => {
  const env = envOn();
  const res = await Promise.all(Array.from({ length: 12 }, (_, i) => registerInvite(env, { invite_code: '00000000', email: `p${i}@example.com` })));
  assert.equal(res.filter(r => r.status === 400).length, 5);
  assert.equal(res.filter(r => r.status === 429).length, 7);
});

test('throttle: another email than the invited one counts as a refused attempt; a success removes its own rows only', async () => {
  const env = envOn();
  const { code } = await newCode(env);
  for (let i = 0; i < 4; i++) assert.equal((await registerInvite(env, { invite_code: code, email: `wrong${i}@example.com` })).status, 400);
  assert.equal((await registerInvite(env, { invite_code: code })).status, 201);
  // the four failures stay: one more refused attempt from this network, then 429
  const other = await newCode(env, { email: 'y@example.com' });
  assert.equal((await registerInvite(env, { invite_code: '00000000', email: 'z@example.com' })).status, 400);
  assert.equal((await registerInvite(env, { invite_code: other.code, email: 'y@example.com' })).status, 429);
});

test('throttle: invite guesses and logins keep separate counts', async () => {
  const env = envOn();
  const { code } = await newCode(env);
  assert.equal((await registerInvite(env, { invite_code: code })).status, 201);
  for (let i = 0; i < 5; i++) await registerInvite(env, { invite_code: '00000000', email: `g${i}@example.com` });
  assert.equal((await login(env)).status, 200, 'refused codes do not lock the login');
  for (let i = 0; i < 10; i++) await login(env, 'ann@example.com', 'wrong password!!');
  assert.equal((await login(env)).status, 429);
  const env2 = envOn();
  for (let i = 0; i < 10; i++) await login(env2, 'nobody@example.com', 'wrong password!!');
  const fresh = await newCode(env2);
  assert.equal((await registerInvite(env2, { invite_code: fresh.code })).status, 201, 'failed logins do not lock invites');
});

// ─── never logged ──────────────────────────────────────────────────────────

test('the code, the password and the token never reach the log', async () => {
  const env = envOn();
  const seen = [];
  const saved = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
    saved[k] = console[k];
    console[k] = (...a) => seen.push(a.map(String).join(' '));
  }
  let code;
  let token;
  try {
    ({ code } = await newCode(env));
    await registerInvite(env, { invite_code: String((Number(code) + 1) % 1e8).padStart(8, '0') });
    token = (await (await registerInvite(env, { invite_code: code })).json()).token;
    await registerInvite(env, { invite_code: code, email: 'replay@example.com' });
  } finally {
    Object.assign(console, saved);
  }
  // the positive case: the flow ran (a vacuous pass otherwise)
  assert.match(token ?? '', /^[0-9a-f]{64}$/);
  const text = seen.join('\n');
  for (const s of [code, PASSWORD, token]) assert.ok(!text.includes(s), 'logged');
});

// ─── afterwards ────────────────────────────────────────────────────────────

test('an invited account is an ordinary active one: the operator can suspend it, which ends its session at once', async () => {
  const env = envOn();
  const { code } = await newCode(env);
  const { token, photographer } = await (await registerInvite(env, { invite_code: code })).json();
  const res = await call(env, `/api/operator/photographers/${photographer.id}/suspend`, { method: 'POST', token: OP });
  assert.equal(res.status, 200);
  assert.equal((await me(env, token)).status, 401);
  assert.equal((await login(env)).status, 401);
});

test('a token minted by registering opens what a login token opens, and only while PHOTOGRAPHER_ROUTES is on', async () => {
  const env = envOn();
  const { code } = await newCode(env);
  const { token } = await (await registerInvite(env, { invite_code: code })).json();
  const list = await call(env, '/api/admin/projects', { token });
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { projects: [] }, 'its own (empty) list, not the default photographer\'s');
  env.PHOTOGRAPHER_ROUTES = 'off';
  assert.equal((await call(env, '/api/admin/projects', { token })).status, 401);
  assert.notEqual(token, SECRET);
});

// ─── the operator's account list ───────────────────────────────────────────

const operatorList = async env => {
  const res = await call(env, '/api/operator/photographers', { token: OP });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
};

test('the operator list says how each account was made: created_via invite (with the invite id) or signup', async () => {
  const env = envOn();
  const signedUp = await seedPhotographer(env, { email: 'signup@example.com', status: 'pending' });
  const { id: inviteId, code } = await newCode(env);
  const { photographer } = await (await registerInvite(env, { invite_code: code })).json();
  const { photographers } = await operatorList(env);
  const by = Object.fromEntries(photographers.map(p => [p.id, p]));
  assert.equal(by[photographer.id].created_via, 'invite');
  assert.equal(by[photographer.id].invite_id, inviteId);
  assert.equal(by[photographer.id].status, 'active');
  assert.equal(by[signedUp.id].created_via, 'signup');
  assert.equal(by[signedUp.id].invite_id, null);
  // still never a hash, a code or a session
  const text = JSON.stringify(photographers);
  assert.ok(!text.includes('pbkdf2') && !text.includes(code) && !text.includes(invite(env, inviteId).code_hash));
});

test('the operator list before either migration: every account reads as signup; must_change_password as before', async () => {
  for (const [schema, flag] of [[withoutInvitesTable(), false], [withoutInvitesTable(withoutMustChange()), null], [withoutMustChange(), null]]) {
    const env = envOn({ DB: fakeDB({ schema }) });
    const p = await seedPhotographer(env);
    const { photographers } = await operatorList(env);
    assert.equal(photographers.length, 1);
    assert.equal(photographers[0].id, p.id);
    assert.equal(photographers[0].created_via, 'signup');
    assert.equal(photographers[0].invite_id, null);
    assert.equal(photographers[0].must_change_password, flag);
  }
  // no must_change_password column, but the invites table: an invited account still says so
  const env = envOn({ DB: fakeDB({ schema: withoutMustChange() }) });
  const { id, code } = await newCode(env);
  const { photographer } = await (await registerInvite(env, { invite_code: code })).json();
  const [row] = (await operatorList(env)).photographers;
  assert.deepEqual([row.id, row.created_via, row.invite_id, row.must_change_password], [photographer.id, 'invite', id, null]);
});
