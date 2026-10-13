// Review of claude/r2-hardening: POST /api/auth/studio-token checks the
// session first and writes the token row afterwards. A suspend (or reset,
// logout, expiry) landing in between deletes the session and revokes the
// account's studio tokens — but the row about to be written is not there yet,
// so it would survive as a live 12-hour credential of a suspended account.
// The INSERT for a photographer session is now conditional on that session
// row still existing, unexpired, for an active account; when it does not
// land, the answer is the same 401 as an expired session and nothing is
// written. The default photographer (PHOTOGRAPHER_TOKEN, no session row) is
// unaffected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, SECRET, call, rows } from './revision-helpers.mjs';
import { seedPhotographer, ROUTES_ON } from './tenant-helpers.mjs';

async function world() {
  const env = setup({ extra: ROUTES_ON });
  return { env, B: await seedPhotographer(env) };
}
const mint = (env, token) => call(env, '/api/auth/studio-token', { method: 'POST', token });
const studioRows = (env, id) => rows(env, "SELECT * FROM share_tokens WHERE kind = 'studio' AND photographer_id IS ?", id);

// run `between` right before the studio-token INSERT statement is prepared:
// after the route's session check, before its write
function interleave(env, between) {
  const real = env.DB.prepare.bind(env.DB);
  let fired = 0;
  env.DB.prepare = sql => {
    if (/^\s*INSERT INTO share_tokens/i.test(sql) && /'studio'/.test(sql) && !fired++) between();
    return real(sql);
  };
  return () => fired;
}
async function expiredAnswer(env) {
  const gone = await seedPhotographer(env, { expiresInMs: -1000 });
  const res = await mint(env, gone.token);
  return { status: res.status, body: await res.text() };
}

const cases = {
  'the session deleted (suspend / reset / logout)': (env, B) => env.DB._db.prepare('DELETE FROM photographer_sessions WHERE photographer_id = ?').run(B.id),
  'the session expired': (env, B) => env.DB._db.prepare("UPDATE photographer_sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE photographer_id = ?").run(B.id),
  'the account suspended (session row left behind)': (env, B) => env.DB._db.prepare("UPDATE photographers SET status = 'suspended' WHERE id = ?").run(B.id),
};
for (const [name, between] of Object.entries(cases)) {
  test(`studio-token: ${name} between the session check and the INSERT → the expired-session 401, no row`, async () => {
    const w = await world();
    const expected = await expiredAnswer(w.env);
    assert.equal(expected.status, 401);
    const fired = interleave(w.env, () => between(w.env, w.B));
    const before = studioRows(w.env, w.B.id).length;
    const res = await mint(w.env, w.B.token);
    assert.equal(fired(), 1, 'the interleaving ran');
    assert.deepEqual({ status: res.status, body: await res.text() }, expected);
    assert.equal(studioRows(w.env, w.B.id).length, before, 'no studio row written');
  });
}

test('studio-token: it is THIS session that must still exist — logging it out mid-request is 401 even while the account has another live session', async () => {
  const w = await world();
  const expected = await expiredAnswer(w.env);
  // a second live session of the same account (another device)
  w.env.DB._db.prepare('INSERT INTO photographer_sessions (token_hash, photographer_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run('f'.repeat(64), w.B.id, new Date().toISOString(), new Date(Date.now() + 86400000).toISOString());
  interleave(w.env, () => w.env.DB._db.prepare('DELETE FROM photographer_sessions WHERE photographer_id = ? AND token_hash != ?').run(w.B.id, 'f'.repeat(64)));
  const res = await mint(w.env, w.B.token);
  assert.deepEqual({ status: res.status, body: await res.text() }, expected);
  assert.equal(studioRows(w.env, w.B.id).length, 0);
});

test('studio-token: an uninterrupted session mints as before (positive control), and the default needs no session', async () => {
  const w = await world();
  const res = await mint(w.env, w.B.token);
  assert.equal(res.status, 200);
  const { token } = await res.json();
  assert.equal(studioRows(w.env, w.B.id).length, 1);
  assert.equal(studioRows(w.env, w.B.id)[0].token, token);
  const a = await mint(w.env, SECRET);
  assert.equal(a.status, 200);
  assert.equal(studioRows(w.env, null).length, 1);
});

test('studio-token: a failed conditional INSERT supersedes nothing — the photographer\'s other live row is left as it was', async () => {
  const w = await world();
  // an old live row of B's, too short-lived to be reused (under an hour left)
  w.env.DB._db.prepare("INSERT INTO share_tokens (token, book_id, kind, folders, created_at, expires_at, photographer_id) VALUES ('B-OLD', '', 'studio', '[]', ?, ?, ?)")
    .run(new Date(Date.now() - 3600000).toISOString(), new Date(Date.now() + 600000).toISOString(), w.B.id);
  interleave(w.env, () => w.env.DB._db.prepare('DELETE FROM photographer_sessions WHERE photographer_id = ?').run(w.B.id));
  // (the interleaving itself deletes the session, so compare share_tokens)
  const before = JSON.stringify(rows(w.env, 'SELECT * FROM share_tokens ORDER BY rowid'));
  assert.equal((await mint(w.env, w.B.token)).status, 401);
  assert.equal(JSON.stringify(rows(w.env, 'SELECT * FROM share_tokens ORDER BY rowid')), before);
  assert.equal(rows(w.env, "SELECT revoked_at FROM share_tokens WHERE token = 'B-OLD'")[0].revoked_at, null);
});
