// Security review of multi-photographer batch 3, info item: share_tokens rows
// owned by the default photographer are NULL (every row the Worker writes),
// but a row holding the literal 'default' (a hand edit, a future writer) read
// as the default's files (shareOwner) while minted / revoke-all / revoke and
// the studio-token reuse / supersede only matched `photographer_id IS NULL`
// — so the default could neither see nor revoke it. The default's owner
// clause now matches NULL and 'default' alike; any other photographer's
// matches only its own id, never either of those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, PROOF, PA, SECRET, call, one } from './revision-helpers.mjs';
import { seedPhotographer, snapshot, ROUTES_ON } from './tenant-helpers.mjs';

const hours = n => new Date(Date.now() + n * 3600000).toISOString();
const enc = encodeURIComponent;
async function world() {
  const env = setup({ extra: ROUTES_ON });
  return { env, A: { id: 'default', token: SECRET, tag: 'A' }, B: { ...(await seedPhotographer(env)), tag: 'B' } };
}
function seedStudio(env, token, owner, expiresAt = hours(11)) {
  env.DB._db.prepare("INSERT INTO share_tokens (token, book_id, kind, folders, created_at, expires_at, photographer_id) VALUES (?, '', 'studio', '[]', ?, ?, ?)")
    .run(token, hours(-1), expiresAt, owner);
  return token;
}
function seedAlbumLink(env, token, owner) {
  env.DB._db.prepare("INSERT INTO share_tokens (token, book_id, label, kind, folders, created_at, expires_at, photographer_id) VALUES (?, 'b1', '', 'client', ?, ?, ?, ?)")
    .run(token, JSON.stringify([PROOF]), hours(-1), hours(24 * 30), owner);
  return token;
}
const row = (env, token) => one(env, 'SELECT * FROM share_tokens WHERE token = ?', token);
const minted = async (env, who) => (await (await call(env, '/api/shares/minted', { token: who.token })).json()).map(r => r.token).sort();

test('a literal \'default\' row reads the default\'s files (as before this change)', async () => {
  const w = await world();
  seedStudio(w.env, 'LIT', 'default');
  const res = await call(w.env, `/${PA}?t=LIT`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'PA-ORIG');
});

test('GET /api/shares/minted: the default lists its NULL and literal \'default\' rows; B lists neither', async () => {
  const w = await world();
  seedStudio(w.env, 'NULL-ROW', null);
  seedStudio(w.env, 'LIT', 'default');
  seedStudio(w.env, 'B-ROW', w.B.id);
  assert.deepEqual(await minted(w.env, w.A), ['LIT', 'NULL-ROW']);
  assert.deepEqual(await minted(w.env, w.B), ['B-ROW']);
});

test('POST /api/shares/minted/revoke-all: the default revokes its NULL and literal rows, not B\'s; B revokes only its own', async () => {
  const w = await world();
  seedStudio(w.env, 'NULL-ROW', null);
  seedStudio(w.env, 'LIT', 'default');
  seedStudio(w.env, 'B-ROW', w.B.id);
  const b = await call(w.env, '/api/shares/minted/revoke-all', { method: 'POST', token: w.B.token });
  assert.deepEqual(await b.json(), { ok: true, revoked: 1 });
  assert.equal(row(w.env, 'LIT').revoked_at, null);
  assert.equal(row(w.env, 'NULL-ROW').revoked_at, null);
  const a = await call(w.env, '/api/shares/minted/revoke-all', { method: 'POST', token: SECRET });
  assert.deepEqual(await a.json(), { ok: true, revoked: 2 });
  assert.ok(row(w.env, 'LIT').revoked_at);
  assert.ok(row(w.env, 'NULL-ROW').revoked_at);
});

test('POST /api/shares/:token/revoke: a project-less literal \'default\' row is the default\'s to revoke, B gets 404 and nothing changes', async () => {
  const w = await world();
  seedStudio(w.env, 'LIT', 'default');
  seedAlbumLink(w.env, 'LIT-ALBUM', 'default');
  for (const t of ['LIT', 'LIT-ALBUM']) {
    const before = snapshot(w.env);
    const b = await call(w.env, `/api/shares/${enc(t)}/revoke`, { method: 'POST', token: w.B.token });
    assert.equal(b.status, 404, t);
    assert.equal(snapshot(w.env), before, t);
    const a = await call(w.env, `/api/shares/${enc(t)}/revoke`, { method: 'POST', token: SECRET });
    assert.equal(a.status, 200, t);
    assert.ok(row(w.env, t).revoked_at, t);
  }
  // and B's own row is still B's alone
  seedStudio(w.env, 'B-ROW', w.B.id);
  assert.equal((await call(w.env, '/api/shares/B-ROW/revoke', { method: 'POST', token: SECRET })).status, 404);
  assert.equal((await call(w.env, '/api/shares/B-ROW/revoke', { method: 'POST', token: w.B.token })).status, 200);
});

test('POST /api/auth/studio-token: the default reuses a live literal \'default\' row and supersedes a short-lived one; B never touches either', async () => {
  const w = await world();
  seedStudio(w.env, 'LIT-LONG', 'default', hours(11));
  const reused = await (await call(w.env, '/api/auth/studio-token', { method: 'POST', token: SECRET })).json();
  assert.equal(reused.token, 'LIT-LONG');
  // B's mint neither reuses nor revokes the default's rows
  const b = await (await call(w.env, '/api/auth/studio-token', { method: 'POST', token: w.B.token })).json();
  assert.notEqual(b.token, 'LIT-LONG');
  assert.equal(row(w.env, 'LIT-LONG').revoked_at, null);
  assert.equal(row(w.env, b.token).photographer_id, w.B.id);

  const w2 = await world();
  seedStudio(w2.env, 'LIT-SHORT', 'default', hours(0.5));   // under the reuse floor
  const fresh = await (await call(w2.env, '/api/auth/studio-token', { method: 'POST', token: SECRET })).json();
  assert.notEqual(fresh.token, 'LIT-SHORT');
  assert.ok(row(w2.env, 'LIT-SHORT').revoked_at, 'one live studio row per photographer, the literal one included');
  assert.equal(row(w2.env, fresh.token).photographer_id, null, 'the default still writes NULL');
});
