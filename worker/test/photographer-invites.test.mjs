// Photographer invite codes (docs/multi-photographer.md, 邀請碼): the
// photographer_invites table, from its hand-run migration, and the
// operator's routes — POST / GET /api/operator/photographer-invites and
// POST …/:id/revoke. A code is for one email (required; none that already
// has an account; a new code for the same email replaces its live one), 8
// digits, one hour, shown once at creation and stored only as an HMAC over
// the email and the code keyed with PHOTOGRAPHER_INVITE_SECRET; without that
// secret (32+ characters) or before the migration every invite route is 500
// invites_unavailable and writes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fakeDB } from './fakes.mjs';
import { SECRET, setup, call, one, rows } from './pick-helpers.mjs';
import { seedPhotographer, snapshot } from './tenant-helpers.mjs';

const OP = 'operator-secret';
const INVITE_KEY = 'photographer-invite-secret-0123456789abcdef';
const MIGRATION = readFileSync(new URL('../migrations/2026-10-18-photographer-invites.sql', import.meta.url), 'utf8');
const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

const envOn = (extra = {}) => setup({ OPERATOR_TOKEN: OP, PHOTOGRAPHER_INVITE_SECRET: INVITE_KEY, PHOTOGRAPHER_ROUTES: 'on', ...extra });

// schema.sql without the invites table (a database before the migration)
function withoutInvitesTable() {
  const cut = SCHEMA.replace(/CREATE TABLE IF NOT EXISTS photographer_invites \([\s\S]*?\n\);\n/, '').replace(/CREATE INDEX IF NOT EXISTS idx_photographer_invites_\w+ ON photographer_invites\([^)]*\);\n/g, '');
  assert.notEqual(cut, SCHEMA, 'schema.sql has the table');
  assert.ok(!/photographer_invites/.test(cut.replace(/--.*$/gm, '')), 'every statement naming the table is cut');
  return cut;
}

const op = (env, method, path, body, token = OP) => call(env, path, { method, token: token ?? undefined, body });
// a fresh invitee each time unless the body names one
let seq = 0;
const createInvite = (env, body = {}, token = OP) => op(env, 'POST', '/api/operator/photographer-invites', { email: `invitee${++seq}@example.com`, ...body }, token);
const listInvites = (env, token = OP) => op(env, 'GET', '/api/operator/photographer-invites', undefined, token);
const revokeInvite = (env, id, token = OP) => op(env, 'POST', `/api/operator/photographer-invites/${id}/revoke`, undefined, token);
async function newCode(env, body = {}) {
  const res = await createInvite(env, body);
  assert.equal(res.status, 201, await res.clone().text());
  return res.json();
}
const invites = env => rows(env, 'SELECT * FROM photographer_invites ORDER BY rowid');
const setInvite = (env, id, col, value) => env.DB._db.prepare(`UPDATE photographer_invites SET ${col} = ? WHERE id = ?`).run(value, id);
const past = () => new Date(Date.now() - 1000).toISOString();
const hmacHex = async (key, msg) => {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg))).toString('hex');
};

// ─── the migration ─────────────────────────────────────────────────────────

test('migration: one CREATE TABLE IF NOT EXISTS and its indexes, one statement per line, the same shape as schema.sql, re-runnable', () => {
  const statements = MIGRATION.split('\n').filter(l => /^(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP)\b/i.test(l));
  assert.deepEqual(statements.map(s => s.split('(')[0].trim()), [
    'CREATE TABLE IF NOT EXISTS photographer_invites',
    'CREATE INDEX IF NOT EXISTS idx_photographer_invites_code ON photographer_invites',
    'CREATE INDEX IF NOT EXISTS idx_photographer_invites_email ON photographer_invites',
    'CREATE INDEX IF NOT EXISTS idx_photographer_invites_used_by ON photographer_invites',
  ]);
  for (const s of statements) assert.ok(s.trim().endsWith(';'), s);
  assert.ok(!/ALTER|DROP|DELETE|UPDATE/i.test(MIGRATION.replace(/--.*$/gm, '')), 'append-only, new table only');
  const migrated = new DatabaseSync(':memory:');
  migrated.exec(MIGRATION);
  migrated.exec(MIGRATION);
  const fresh = setup().DB._db;
  const shape = db => db.prepare('PRAGMA table_info(photographer_invites)').all().map(c => [c.name, c.type, c.notnull, c.pk]);
  assert.deepEqual(shape(migrated), shape(fresh));
  assert.deepEqual(shape(fresh).map(c => c[0]), ['id', 'email', 'code_hash', 'created_at', 'expires_at', 'used_at', 'used_by', 'revoked_at', 'note']);
  const idx = db => db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'photographer_invites' AND sql IS NOT NULL ORDER BY name").all().map(r => [r.name, r.sql]);
  assert.deepEqual(idx(migrated), idx(fresh));
  assert.equal(idx(fresh).length, 3);
  assert.match(SCHEMA, /2026-10-18-photographer-invites\.sql/, 'schema.sql names the hand-run migration');
});

// ─── operator: who may, and when the feature is off ─────────────────────────

test('operator invite routes: only the operator token; the photographer token, a session or nothing is 401 and writes nothing', async () => {
  const env = envOn();
  const B = await seedPhotographer(env);
  const { id } = await newCode(env);
  for (const token of [null, SECRET, B.token, 'nope']) {
    const before = snapshot(env);
    for (const res of [await createInvite(env, {}, token), await listInvites(env, token), await revokeInvite(env, id, token)]) {
      assert.equal(res.status, 401, `${token}: ${res.url}`);
      assert.ok(!(await res.text()).includes(id));
    }
    assert.equal(snapshot(env), before, `${token} wrote`);
  }
});

test('operator invite routes: no PHOTOGRAPHER_INVITE_SECRET (or one under 32 characters) is 500 invites_unavailable on every route, nothing written', async () => {
  for (const secret of [undefined, '', 'x'.repeat(31), 12345678901234567890123456789012345]) {
    const env = envOn({ PHOTOGRAPHER_INVITE_SECRET: secret });
    env.DB._db.prepare("INSERT INTO photographer_invites (id, email, code_hash, created_at, expires_at) VALUES ('i1', 'i1@example.com', 'h', ?, ?)").run(past(), new Date(Date.now() + 3600000).toISOString());
    const before = snapshot(env);
    for (const res of [await createInvite(env), await listInvites(env), await revokeInvite(env, 'i1')]) {
      assert.equal(res.status, 500, String(secret));
      assert.deepEqual(await res.json(), { error: '邀請碼功能尚未啟用', code: 'invites_unavailable' });
    }
    assert.equal(snapshot(env), before);
  }
  // exactly 32 is enough
  assert.equal((await createInvite(envOn({ PHOTOGRAPHER_INVITE_SECRET: 'y'.repeat(32) }))).status, 201);
});

test('the pre-review table shape (no email column, as if the first 3-statement migration had run): create, list, revoke and register are 500 invites_unavailable, no throttle row, nothing written', async () => {
  const env = envOn({ DB: fakeDB({ schema: withoutInvitesTable() }) });
  env.DB._db.exec('CREATE TABLE photographer_invites (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, used_by TEXT, revoked_at TEXT, note TEXT);');
  env.DB._db.prepare("INSERT INTO photographer_invites (id, code_hash, created_at, expires_at) VALUES ('old', 'h', ?, ?)").run(past(), new Date(Date.now() + 3600000).toISOString());
  const before = snapshot(env);
  const register = await call(env, '/api/photographer/register-invite', {
    method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.9' },
    body: { email: 'ann@example.com', password: 'correct horse battery', display_name: '安', invite_code: '12345678' },
  });
  for (const res of [await createInvite(env, { email: 'ann@example.com' }), await listInvites(env), await revokeInvite(env, 'old'), register]) {
    assert.equal(res.status, 500, res.url);
    assert.deepEqual(await res.json(), { error: '邀請碼功能尚未啟用', code: 'invites_unavailable' });
  }
  assert.equal(rows(env, 'SELECT * FROM photographer_login_failures').length, 0, 'no throttle row');
  assert.equal(snapshot(env), before);
});

test('operator invite routes before the migration: 500 invites_unavailable, nothing written; the photographer list still works', async () => {
  const env = envOn({ DB: fakeDB({ schema: withoutInvitesTable() }) });
  const before = snapshot(env);
  for (const res of [await createInvite(env), await listInvites(env), await revokeInvite(env, 'i1')]) {
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: '邀請碼功能尚未啟用', code: 'invites_unavailable' });
  }
  // the migration is asked before the body: a bad note is 500 too
  const bad = await createInvite(env, { note: 123 });
  assert.equal(bad.status, 500);
  assert.equal((await bad.json()).code, 'invites_unavailable');
  assert.equal(snapshot(env), before);
  assert.equal((await op(env, 'GET', '/api/operator/photographers')).status, 200);
});

test('operator invite routes work while PHOTOGRAPHER_ROUTES is off (only registering with a code is gated by it)', async () => {
  const env = envOn({ PHOTOGRAPHER_ROUTES: 'off' });
  const { id } = await newCode(env);
  assert.equal((await listInvites(env)).status, 200);
  assert.equal((await revokeInvite(env, id)).status, 200);
});

test('operator invite routes: wrong method 405, other paths 404, nothing written', async () => {
  const env = envOn();
  const { id } = await newCode(env);
  const before = snapshot(env);
  for (const [method, path, status] of [
    ['PUT', '/api/operator/photographer-invites', 405],
    ['DELETE', '/api/operator/photographer-invites', 405],
    ['GET', `/api/operator/photographer-invites/${id}/revoke`, 405],
    ['GET', `/api/operator/photographer-invites/${id}`, 404],
    ['POST', `/api/operator/photographer-invites/${id}`, 404],
    ['POST', `/api/operator/photographer-invites/${id}/use`, 404],
    ['POST', `/api/operator/photographer-invites/${id}/revoke/x`, 404],
  ]) {
    const res = await op(env, method, path, method === 'GET' ? undefined : {});
    assert.equal(res.status, status, `${method} ${path}`);
  }
  assert.equal(snapshot(env), before);
});

// ─── operator: create ──────────────────────────────────────────────────────

test('create: 201 {id, email, code, expires_at, note, replaced}; the code is 8 digits, valid one hour, stored only as an HMAC over the email and the code (never in plain text), no-store', async () => {
  const env = envOn();
  const t0 = Date.now();
  const res = await createInvite(env, { email: '  Ming@Example.COM ', note: '  給 王小明 ' });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['code', 'email', 'expires_at', 'id', 'note', 'replaced']);
  assert.equal(body.email, 'ming@example.com', 'normalised as registration normalises it');
  assert.equal(body.replaced, 0);
  assert.match(body.code, /^\d{8}$/);
  assert.equal(body.note, '給 王小明');
  const life = Date.parse(body.expires_at) - t0;
  assert.ok(life >= 3600000 - 50 && life <= 3600000 + 2000, String(life));
  const [row] = invites(env);
  assert.equal(row.id, body.id);
  assert.equal(row.email, 'ming@example.com');
  assert.equal(row.code_hash, await hmacHex(INVITE_KEY, `photographer-invite\nming@example.com\n${body.code}`));
  // bound to the email: the code alone, or with another email, is another hash
  assert.notEqual(row.code_hash, await hmacHex(INVITE_KEY, `photographer-invite\nother@example.com\n${body.code}`));
  assert.notEqual(row.code_hash, await hmacHex(INVITE_KEY, `photographer-invite:${body.code}`));
  assert.equal(row.expires_at, body.expires_at);
  assert.equal(row.note, '給 王小明');
  assert.equal(row.used_at, null);
  assert.equal(row.used_by, null);
  assert.equal(row.revoked_at, null);
  assert.ok(!snapshot(env).includes(body.code), 'the code is nowhere in D1');
  // a different secret gives a different hash: the table alone opens nothing
  assert.notEqual(row.code_hash, await hmacHex('another-secret-0123456789abcdefghijk', `photographer-invite\nming@example.com\n${body.code}`));
});

test('create: the email is required and checked as registration checks it (400 invalid_email, nothing written)', async () => {
  const env = envOn();
  const before = snapshot(env);
  const bare = await call(env, '/api/operator/photographer-invites', { method: 'POST', token: OP });
  assert.equal(bare.status, 400);
  assert.equal((await bare.json()).code, 'invalid_email');
  for (const email of [undefined, null, '', 'not-an-email', 'ａnn@example.com', 'a"b@example.com', 42, ['a@example.com'], 'x'.repeat(250) + '@e.com']) {
    const res = await call(env, '/api/operator/photographer-invites', { method: 'POST', token: OP, body: email === undefined ? {} : { email } });
    assert.equal(res.status, 400, JSON.stringify(email));
    assert.deepEqual(await res.json(), { error: 'Email 格式不正確', code: 'invalid_email' }, JSON.stringify(email));
  }
  assert.equal(snapshot(env), before);
});

test('create: an email that already has an account (any status, any spelling) is 409 email_taken, nothing written', async () => {
  const env = envOn();
  // a live code made before the account appeared: a refused re-create does not revoke it either
  await newCode(env, { email: 'active@example.com' });
  for (const status of ['active', 'pending', 'suspended']) await seedPhotographer(env, { email: `${status}@example.com`, status });
  const before = snapshot(env);
  for (const email of ['active@example.com', 'PENDING@example.com', ' suspended@Example.com ']) {
    const res = await createInvite(env, { email });
    assert.equal(res.status, 409, email);
    assert.deepEqual(await res.json(), { error: '這個 Email 已經有帳號', code: 'email_taken' });
  }
  assert.equal(snapshot(env), before);
});

test('create: one live code per email — a new one revokes the live one (replaced: 1); used, revoked and expired ones stay as they are', async () => {
  const env = envOn();
  const first = await newCode(env, { email: 'ming@example.com' });
  const second = await newCode(env, { email: 'MING@example.com' });
  assert.equal(second.replaced, 1);
  assert.ok(one(env, 'SELECT revoked_at FROM photographer_invites WHERE id = ?', first.id).revoked_at);
  assert.equal(one(env, 'SELECT revoked_at FROM photographer_invites WHERE id = ?', second.id).revoked_at, null);
  const live = () => rows(env, "SELECT id FROM photographer_invites WHERE email = 'ming@example.com' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?", new Date().toISOString()).map(r => r.id);
  assert.deepEqual(live(), [second.id]);
  // an expired one is not "replaced" (nothing to revoke), and keeps revoked_at NULL
  setInvite(env, second.id, 'expires_at', past());
  const third = await newCode(env, { email: 'ming@example.com' });
  assert.equal(third.replaced, 0);
  assert.equal(one(env, 'SELECT revoked_at FROM photographer_invites WHERE id = ?', second.id).revoked_at, null);
  // another email is not touched
  const other = await newCode(env, { email: 'other@example.com' });
  await newCode(env, { email: 'ming@example.com' });
  assert.equal(one(env, 'SELECT revoked_at FROM photographer_invites WHERE id = ?', other.id).revoked_at, null);
  // parallel creates for one email leave exactly one live code
  await Promise.all(Array.from({ length: 5 }, () => createInvite(env, { email: 'race@example.com' })));
  assert.equal(rows(env, "SELECT id FROM photographer_invites WHERE email = 'race@example.com' AND revoked_at IS NULL").length, 1);
});

test('create: an empty object or a blank note is note null; a bad note is 400 invalid_note and writes nothing', async () => {
  const env = envOn();
  assert.equal((await newCode(env, {})).note, null);
  assert.equal((await newCode(env, { note: '   ' })).note, null);
  assert.equal((await newCode(env, { note: null })).note, null);
  assert.equal((await newCode(env, { note: '字'.repeat(200) })).note, '字'.repeat(200));
  const before = snapshot(env);
  for (const note of [123, ['a'], { a: 1 }, '字'.repeat(201), 'a\u0000b', 'a\nb', 'a‮b', true]) {
    const res = await createInvite(env, { note });
    assert.equal(res.status, 400, JSON.stringify(note));
    assert.equal((await res.json()).code, 'invalid_note');
  }
  for (const raw of ['[]', '"x"', 'not json']) {
    const res = await call(env, '/api/operator/photographer-invites', { method: 'POST', token: OP, body: raw, headers: { 'Content-Type': 'application/json' } });
    assert.equal(res.status, 400, raw);
  }
  assert.equal(snapshot(env), before);
});

test('create: at most 10 live codes; an expired, revoked or used one frees its place; 409 invite_limit writes nothing', async () => {
  const env = envOn();
  const made = [];
  for (let i = 0; i < 10; i++) made.push(await newCode(env));
  assert.equal(new Set(made.map(m => m.code)).size, 10, 'codes are random');
  const before = snapshot(env);
  const full = await createInvite(env);
  assert.equal(full.status, 409);
  assert.deepEqual(await full.json(), { error: '尚未使用的邀請碼最多 10 組，請先撤銷不用的', code: 'invite_limit', max: 10 });
  assert.equal(snapshot(env), before);
  setInvite(env, made[0].id, 'expires_at', past());
  await newCode(env);
  setInvite(env, made[1].id, 'revoked_at', past());
  await newCode(env);
  setInvite(env, made[2].id, 'used_at', past());
  await newCode(env);
  assert.equal((await createInvite(env)).status, 409);
  // a new code for an email that has a live one replaces it, so it fits under the cap
  const made10 = rows(env, 'SELECT email FROM photographer_invites WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY rowid DESC LIMIT 1', new Date().toISOString())[0].email;
  const again = await newCode(env, { email: made10 });
  assert.equal(again.replaced, 1);
});

test('create: parallel creates never pass the cap of 10', async () => {
  const env = envOn();
  const res = await Promise.all(Array.from({ length: 15 }, () => createInvite(env)));
  assert.equal(res.filter(r => r.status === 201).length, 10);
  assert.equal(res.filter(r => r.status === 409).length, 5);
  assert.equal(invites(env).length, 10);
});

// ─── operator: list ────────────────────────────────────────────────────────

test('list: newest first, each with its state and who used it; never the code or its hash', async () => {
  const env = envOn();
  const a = await newCode(env, { note: 'A' });
  const b = await newCode(env, { note: 'B' });
  const c = await newCode(env, { note: 'C' });
  const d = await newCode(env, { note: 'D' });
  const user = await seedPhotographer(env, { email: 'used@example.com', displayName: '用過' });
  const usedAt = new Date().toISOString();
  setInvite(env, a.id, 'used_at', usedAt);
  setInvite(env, a.id, 'used_by', user.id);
  setInvite(env, b.id, 'revoked_at', usedAt);
  setInvite(env, c.id, 'expires_at', past());
  // the same created_at for all: rowid breaks the tie, newest first
  env.DB._db.prepare('UPDATE photographer_invites SET created_at = ?').run(usedAt);
  const res = await listInvites(env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const text = await res.text();
  for (const m of [a, b, c, d]) assert.ok(!text.includes(m.code), 'no code in the list');
  for (const r of invites(env)) assert.ok(!text.includes(r.code_hash), 'no hash in the list');
  const { invites: list } = JSON.parse(text);
  assert.deepEqual(list.map(i => i.note), ['D', 'C', 'B', 'A']);
  for (const i of list) {
    assert.deepEqual(Object.keys(i).sort(), ['created_at', 'email', 'expires_at', 'id', 'note', 'revoked_at', 'state', 'used_at', 'used_by', 'used_by_email', 'used_by_name']);
  }
  // the invited email (operator only)
  assert.deepEqual(list.map(i => i.email), [d, c, b, a].map(m => m.email));
  const by = Object.fromEntries(list.map(i => [i.note, i]));
  assert.equal(by.D.state, 'live');
  assert.equal(by.C.state, 'expired');
  assert.equal(by.B.state, 'revoked');
  assert.equal(by.B.revoked_at, usedAt);
  assert.equal(by.A.state, 'used');
  assert.deepEqual([by.A.used_at, by.A.used_by, by.A.used_by_email, by.A.used_by_name], [usedAt, user.id, 'used@example.com', '用過']);
  assert.deepEqual([by.D.used_by, by.D.used_by_email, by.D.used_by_name], [null, null, null]);
});

test('list: an empty table is {invites: []}; at most 200 rows', async () => {
  const env = envOn();
  assert.deepEqual(await (await listInvites(env)).json(), { invites: [] });
  const ins = env.DB._db.prepare('INSERT INTO photographer_invites (id, email, code_hash, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 205; i++) ins.run(`i${i}`, `i${i}@example.com`, `h${i}`, new Date(Date.now() - i * 1000).toISOString(), past(), past());
  const { invites: list } = await (await listInvites(env)).json();
  assert.equal(list.length, 200);
  assert.equal(list[0].id, 'i0');
});

// ─── operator: revoke ──────────────────────────────────────────────────────

test('revoke: sets revoked_at once; a repeat is 200 with the same row; an unknown id 404; a used code stays used', async () => {
  const env = envOn();
  const a = await newCode(env, { note: 'A' });
  const res = await revokeInvite(env, a.id);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.invite.id, a.id);
  assert.equal(body.invite.state, 'revoked');
  assert.ok(!JSON.stringify(body).includes(a.code));
  assert.ok(!('code_hash' in body.invite));
  const first = invites(env)[0].revoked_at;
  assert.ok(first);
  const again = await revokeInvite(env, a.id);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).invite.revoked_at, first);
  assert.equal(invites(env)[0].revoked_at, first, 'the first time stays');

  const before = snapshot(env);
  const unknown = await revokeInvite(env, 'no-such-invite');
  assert.equal(unknown.status, 404);
  assert.equal(snapshot(env), before);

  const u = await newCode(env, { note: 'U' });
  const user = await seedPhotographer(env);
  setInvite(env, u.id, 'used_at', past());
  setInvite(env, u.id, 'used_by', user.id);
  const used = await revokeInvite(env, u.id);
  assert.equal(used.status, 200);
  const usedBody = await used.json();
  assert.equal(usedBody.invite.state, 'used');
  assert.equal(usedBody.invite.revoked_at, null);
  assert.equal(one(env, 'SELECT revoked_at FROM photographer_invites WHERE id = ?', u.id).revoked_at, null);
});
