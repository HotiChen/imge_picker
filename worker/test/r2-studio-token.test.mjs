// Batch 3 of docs/multi-photographer.md: minted tokens and link revocation,
// per photographer.
//
// A studio token (POST /api/auth/studio-token) reads its owner's files only,
// so it needs an owner: share_tokens.photographer_id (NULL = the default
// photographer, which is every row written before this batch). "One live
// studio row at a time" becomes one live row PER photographer: issuing or
// revoking for X never touches Y's rows. GET /api/shares/minted, POST
// /api/shares/minted/revoke-all and POST /api/shares/:token/revoke answer
// the caller's own tokens only; anyone else's token is a token that does not
// exist (404, the same body, the same statements). Client-session tokens
// (legacy client accounts) and album links have no owner but the default.
//
// The column arrives in a hand-run migration
// (worker/migrations/2026-10-17-share-token-owner.sql). Before it has run the
// default photographer behaves exactly as before, and a non-default
// photographer's studio-token / minted calls answer 500 share_owner_unavailable
// and write nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fakeDB } from './fakes.mjs';
import { setup, PROOF, PA, SECRET, call, one, rows } from './revision-helpers.mjs';
import { seedPhotographer, snapshot, ROUTES_ON } from './tenant-helpers.mjs';

const FRESH = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const MIGRATION_FILE = new URL('../migrations/2026-10-17-share-token-owner.sql', import.meta.url);
const MIGRATION = existsSync(MIGRATION_FILE) ? readFileSync(MIGRATION_FILE, 'utf8') : '';
// schema.sql as the deployed database before the migration
const BEFORE = FRESH.replace(/(project_id\s+TEXT),\n(?:\s*--[^\n]*\n)*\s*photographer_id\s+TEXT\n\);/, '$1\n);');
const statementsOf = sql => sql.split('\n').filter(l => !/^\s*--/.test(l)).join('\n').split(';').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);

const hours = n => new Date(Date.now() + n * 3600000).toISOString();
const enc = encodeURIComponent;

async function world({ schema } = {}) {
  const env = setup({ extra: ROUTES_ON, ...(schema ? { schema } : {}) });
  const A = { id: 'default', token: SECRET, tag: 'A' };
  const B = { ...(await seedPhotographer(env)), tag: 'B' };
  const C = { ...(await seedPhotographer(env)), tag: 'C' };
  return { env, A, B, C };
}
const mint = (env, who) => call(env, '/api/auth/studio-token', { method: 'POST', token: who.token });
const minted = (env, who) => call(env, '/api/shares/minted', { token: who.token });
const revokeAll = (env, who) => call(env, '/api/shares/minted/revoke-all', { method: 'POST', token: who.token });
const revoke = (env, who, token) => call(env, `/api/shares/${enc(token)}/revoke`, { method: 'POST', token: who.token });
const row = (env, token) => one(env, 'SELECT * FROM share_tokens WHERE token = ?', token);
const live = (env, token) => !row(env, token).revoked_at;

// a studio row seeded straight into D1, owned by `owner` (null = default)
function seedStudio(env, token, owner, expiresAt = hours(11)) {
  env.DB._db.prepare("INSERT INTO share_tokens (token, book_id, kind, folders, created_at, expires_at, photographer_id) VALUES (?, '', 'studio', '[]', ?, ?, ?)")
    .run(token, hours(-1), expiresAt, owner);
  return token;
}
function seedLink(env, token, { kind = 'client', project = null, book = 'b1' } = {}) {
  env.DB._db.prepare("INSERT INTO share_tokens (token, book_id, label, kind, project_id, folders, created_at, expires_at) VALUES (?, ?, '', ?, ?, ?, ?, ?)")
    .run(token, book, kind, project, JSON.stringify([PROOF]), hours(-1), hours(24 * 30));
  return token;
}
function seedSession(env) {
  env.DB._db.prepare("INSERT INTO users (id, email, password_hash, name, folder_path, approved) VALUES (77, 'c@x', 'h:s', '客', ?, 1)").run(PROOF);
  env.DB._db.prepare("INSERT INTO share_tokens (token, book_id, kind, user_id, folders, created_at, expires_at) VALUES ('SESSION-TK', '', 'session', 77, ?, ?, ?)")
    .run(JSON.stringify([PROOF]), hours(-0.1), hours(0.9));
  return 'SESSION-TK';
}
async function projectOf(w, who) {
  const res = await call(w.env, '/api/admin/projects', { method: 'POST', token: who.token, body: { title: `${who.tag} 婚紗`, folders: [PROOF] } });
  assert.equal(res.status, 201, `${who.tag}: ${await res.clone().text()}`);
  const out = await res.json();
  return { id: out.project.id, token: out.token };
}

// ─── the migration ─────────────────────────────────────────────────────────
test('migration: one append-only ALTER, run by hand, noted in schema.sql; the pre-migration fixture really lacks it', () => {
  assert.ok(MIGRATION, 'worker/migrations/2026-10-17-share-token-owner.sql');
  assert.match(MIGRATION, /D1 Console/);
  assert.match(MIGRATION, /share_owner_unavailable/);
  assert.match(MIGRATION, /duplicate column name/i);
  assert.match(MIGRATION, /before/i);
  assert.deepEqual(statementsOf(MIGRATION), ['ALTER TABLE share_tokens ADD COLUMN photographer_id TEXT']);
  assert.match(FRESH, /2026-10-17-share-token-owner\.sql/);
  assert.match(FRESH, /ALTER TABLE share_tokens ADD COLUMN photographer_id TEXT;/);
  assert.notEqual(BEFORE, FRESH, 'the pre-migration schema is cut');
  const old = fakeDB({ schema: BEFORE });
  assert.throws(() => old._db.prepare('SELECT photographer_id FROM share_tokens').all(), /no such column/);
  old._db.prepare('SELECT project_id, kind FROM share_tokens').all();   // only the one column is cut
  for (const s of statementsOf(MIGRATION)) old._db.exec(s);
  const shape = d => d._db.prepare('PRAGMA table_info(share_tokens)').all().map(c => ({ ...c }));
  assert.deepEqual(shape(old), shape(fakeDB()));
  for (const s of statementsOf(MIGRATION)) assert.throws(() => old._db.exec(s), /duplicate column name/);
});

// ─── studio tokens: one live row per photographer ──────────────────────────
test('studio-token: each photographer gets its own token; the row names its owner (NULL for the default)', async () => {
  const w = await world();
  const got = {};
  for (const who of [w.A, w.B, w.C]) {
    const res = await mint(w.env, who);
    assert.equal(res.status, 200, who.tag);
    got[who.tag] = await res.json();
    assert.match(got[who.tag].token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!('photographer_id' in got[who.tag]), 'the answer is {token, expires_at} as before');
  }
  assert.equal(new Set(Object.values(got).map(g => g.token)).size, 3);
  assert.equal(row(w.env, got.A.token).photographer_id, null);
  assert.equal(row(w.env, got.B.token).photographer_id, w.B.id);
  assert.equal(row(w.env, got.C.token).photographer_id, w.C.id);
  // each one's second mint hands back its own live token; nobody's was revoked
  for (const who of [w.A, w.B, w.C]) {
    assert.equal((await (await mint(w.env, who)).json()).token, got[who.tag].token, who.tag);
  }
  for (const g of Object.values(got)) assert.ok(live(w.env, g.token));
  assert.equal(rows(w.env, "SELECT * FROM share_tokens WHERE kind = 'studio'").length, 3);
});

test('studio-token: a fresh mint retires only the caller\'s other live rows', async () => {
  const w = await world();
  // each photographer: one row about to expire (replaced) and one older live row
  for (const [who, owner] of [[w.A, null], [w.B, w.B.id], [w.C, w.C.id]]) {
    seedStudio(w.env, `${who.tag}-NEAR`, owner, hours(0.5));
    seedStudio(w.env, `${who.tag}-OLD`, owner, hours(0.4));
  }
  const fresh = (await (await mint(w.env, w.B)).json()).token;
  assert.ok(!['B-NEAR', 'B-OLD'].includes(fresh));
  assert.ok(!live(w.env, 'B-NEAR') && !live(w.env, 'B-OLD'), 'B\'s own older rows are retired');
  for (const t of ['A-NEAR', 'A-OLD', 'C-NEAR', 'C-OLD']) assert.ok(live(w.env, t), `${t} was revoked by B's mint`);
  // and the default's mint leaves B's and C's alone
  const a = (await (await mint(w.env, w.A)).json()).token;
  assert.ok(!live(w.env, 'A-NEAR') && !live(w.env, 'A-OLD'));
  for (const t of [fresh, 'C-NEAR', 'C-OLD']) assert.ok(live(w.env, t), `${t} was revoked by the default's mint`);
  assert.ok(live(w.env, a));
});

test('studio-token: never hands back another photographer\'s live token', async () => {
  const w = await world();
  seedStudio(w.env, 'A-LIVE', null);
  seedStudio(w.env, 'C-LIVE', w.C.id);
  const b = (await (await mint(w.env, w.B)).json()).token;
  assert.ok(!['A-LIVE', 'C-LIVE'].includes(b));
  // a row of the default's, named 'default' by hand, is not handed to B either
  const w2 = await world();
  seedStudio(w2.env, 'B-LIVE', w2.B.id);
  const a = (await (await mint(w2.env, w2.A)).json()).token;
  assert.notEqual(a, 'B-LIVE');
});

// ─── GET /api/shares/minted ────────────────────────────────────────────────
test('GET /api/shares/minted: each photographer sees its own studio tokens only; client sessions are the default\'s', async () => {
  const w = await world();
  const tok = {};
  for (const who of [w.A, w.B, w.C]) tok[who.tag] = (await (await mint(w.env, who)).json()).token;
  const session = seedSession(w.env);
  const seen = {};
  for (const who of [w.A, w.B, w.C]) {
    const res = await minted(w.env, who);
    assert.equal(res.status, 200, who.tag);
    seen[who.tag] = await res.json();
  }
  assert.deepEqual(seen.A.map(r => r.token).sort(), [tok.A, session].sort());
  assert.deepEqual(seen.B.map(r => r.token), [tok.B]);
  assert.deepEqual(seen.C.map(r => r.token), [tok.C]);
  assert.deepEqual(Object.keys(seen.B[0]).sort(), ['created_at', 'expires_at', 'folders', 'kind', 'token', 'user_id'], 'the same columns as before');
  for (const [who, others] of [['A', [tok.B, tok.C]], ['B', [tok.A, tok.C, session]], ['C', [tok.A, tok.B, session]]]) {
    for (const o of others) assert.ok(!JSON.stringify(seen[who]).includes(o), `${who} saw ${o}`);
  }
});

// ─── POST /api/shares/minted/revoke-all ────────────────────────────────────
test('POST /api/shares/minted/revoke-all: revokes the caller\'s own minted tokens only', async () => {
  const w = await world();
  const tok = {};
  for (const who of [w.A, w.B, w.C]) tok[who.tag] = (await (await mint(w.env, who)).json()).token;
  const session = seedSession(w.env);
  const album = seedLink(w.env, 'ALBUM');
  let res = await revokeAll(w.env, w.B);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, revoked: 1 });
  assert.ok(!live(w.env, tok.B));
  for (const t of [tok.A, tok.C, session, album]) assert.ok(live(w.env, t), `${t} revoked by B`);
  res = await revokeAll(w.env, w.A);
  assert.deepEqual(await res.json(), { ok: true, revoked: 2 }, 'the default\'s studio token and the client session');
  assert.ok(!live(w.env, tok.A) && !live(w.env, session));
  assert.ok(live(w.env, tok.C) && live(w.env, album));
});

// ─── POST /api/shares/:token/revoke ────────────────────────────────────────
test('POST /api/shares/:token/revoke: someone else\'s token is a nonexistent one — 404, same body, same statements, nothing written', async () => {
  const w = await world();
  const pa = await projectOf(w, w.A);
  const pb = await projectOf(w, w.B);
  const pc = await projectOf(w, w.C);
  seedStudio(w.env, 'A-STUDIO', null);
  seedStudio(w.env, 'B-STUDIO', w.B.id);
  seedStudio(w.env, 'C-STUDIO', w.C.id);
  seedLink(w.env, 'ALBUM');                     // an album link: the default's
  const session = seedSession(w.env);
  const cases = [
    [w.B, ['A-STUDIO', 'C-STUDIO', 'ALBUM', session, pa.token, pc.token]],
    [w.C, ['A-STUDIO', 'B-STUDIO', 'ALBUM', pb.token]],
    [w.A, ['B-STUDIO', 'C-STUDIO', pb.token, pc.token]],
  ];
  for (const [caller, theirs] of cases) {
    for (const token of theirs) {
      const before = snapshot(w.env);
      const mark = w.env.DB._sql.length;
      const res = await revoke(w.env, caller, token);
      const text = await res.text();
      const statements = w.env.DB._sql.slice(mark);
      assert.equal(res.status, 404, `${caller.tag} revoked ${token}`);
      assert.equal(snapshot(w.env), before, `${caller.tag} → ${token} wrote`);
      const mark2 = w.env.DB._sql.length;
      const none = await revoke(w.env, caller, 'no-such-token');
      assert.equal(none.status, 404);
      assert.equal(text, await none.text());
      assert.deepEqual(statements, w.env.DB._sql.slice(mark2), `${caller.tag} → ${token}: the statements tell it from none`);
    }
  }
  // the owners: each revokes its own
  for (const [who, mine] of [[w.B, ['B-STUDIO', pb.token]], [w.C, ['C-STUDIO', pc.token]], [w.A, ['A-STUDIO', 'ALBUM', session, pa.token]]]) {
    for (const token of mine) {
      const res = await revoke(w.env, who, token);
      assert.equal(res.status, 200, `${who.tag} ${token}`);
      assert.ok(!live(w.env, token));
    }
  }
});

test('POST /api/shares/:token/revoke: a pick link goes by its project\'s owner, whatever its own column says', async () => {
  const w = await world();
  const pb = await projectOf(w, w.B);
  // a hand-edited row claiming the default owns B's link changes nothing
  w.env.DB._db.prepare('UPDATE share_tokens SET photographer_id = NULL WHERE token = ?').run(pb.token);
  assert.equal((await revoke(w.env, w.A, pb.token)).status, 404);
  w.env.DB._db.prepare('UPDATE share_tokens SET photographer_id = ? WHERE token = ?').run(w.C.id, pb.token);
  assert.equal((await revoke(w.env, w.C, pb.token)).status, 404);
  assert.ok(live(w.env, pb.token));
  assert.equal((await revoke(w.env, w.B, pb.token)).status, 200);
});

test('POST /api/shares/:token/revoke: the owner is re-checked inside the UPDATE (a project handed over mid-request)', async () => {
  const w = await world();
  const pb = await projectOf(w, w.B);
  const prepare = w.env.DB.prepare.bind(w.env.DB);
  w.env.DB.prepare = sql => {
    if (/^UPDATE share_tokens SET revoked_at/.test(sql)) w.env.DB._db.prepare('UPDATE projects SET photographer_id = ? WHERE id = ?').run(w.C.id, pb.id);
    return prepare(sql);
  };
  assert.equal((await revoke(w.env, w.B, pb.token)).status, 404);
  assert.ok(live(w.env, pb.token));
});

// ─── before the migration ──────────────────────────────────────────────────
test('before the migration: the default photographer mints, lists, revokes exactly as before', async () => {
  const w = await world({ schema: BEFORE });
  const first = await mint(w.env, w.A);
  assert.equal(first.status, 200);
  const { token } = await first.json();
  assert.equal((await (await mint(w.env, w.A)).json()).token, token, 'reused');
  assert.equal(rows(w.env, "SELECT * FROM share_tokens WHERE kind = 'studio'").length, 1);
  assert.equal((await call(w.env, `/${PA}?t=${enc(token)}`)).status, 200, 'it reads the default\'s files');
  const listed = await (await minted(w.env, w.A)).json();
  assert.deepEqual(listed.map(r => r.token), [token]);
  seedLink(w.env, 'ALBUM');
  assert.equal((await revoke(w.env, w.A, 'ALBUM')).status, 200);
  assert.deepEqual(await (await revokeAll(w.env, w.A)).json(), { ok: true, revoked: 1 });
  assert.ok(!live(w.env, token));
});

test('before the migration: a non-default photographer\'s studio-token / minted / revoke-all are 500 share_owner_unavailable and write nothing', async () => {
  const w = await world({ schema: BEFORE });
  const a = (await (await mint(w.env, w.A)).json()).token;
  for (const who of [w.B, w.C]) {
    for (const send of [mint, minted, revokeAll]) {
      const before = snapshot(w.env);
      const res = await send(w.env, who);
      assert.equal(res.status, 500, `${who.tag} ${send.name}`);
      assert.equal((await res.json()).code, 'share_owner_unavailable');
      assert.equal(snapshot(w.env), before, `${who.tag} ${send.name} wrote`);
    }
  }
  assert.ok(live(w.env, a), 'the default\'s token survived');
});

test('before the migration: revoke still goes by project for a pick link; a project-less token is the default\'s only', async () => {
  const w = await world({ schema: BEFORE });
  const pb = await projectOf(w, w.B);
  const pa = await projectOf(w, w.A);
  seedLink(w.env, 'ALBUM');
  const before = snapshot(w.env);
  for (const [who, token] of [[w.B, 'ALBUM'], [w.B, pa.token], [w.A, pb.token], [w.C, pb.token]]) {
    assert.equal((await revoke(w.env, who, token)).status, 404, `${who.tag} ${token}`);
  }
  assert.equal(snapshot(w.env), before);
  assert.equal((await revoke(w.env, w.B, pb.token)).status, 200);
  assert.equal((await revoke(w.env, w.A, 'ALBUM')).status, 200);
  assert.equal((await revoke(w.env, w.A, pa.token)).status, 200);
});

// ─── the source ────────────────────────────────────────────────────────────
test('source: the minted-token routes are scoped to the caller; no `default-only until batch 3` mark is left anywhere', () => {
  const SRC = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
  assert.equal((SRC.match(/default-only until batch 3/g) || []).length, 0);
  for (const route of ["url.pathname === '/api/auth/studio-token'", "pathParts[2] === 'minted' && !pathParts[3]", "pathParts[3] === 'revoke-all'", "pathParts[3] === 'revoke')"]) {
    const at = SRC.indexOf(route);
    assert.ok(at > 0, route);
    assert.match(SRC.slice(at, at + 400), /requirePhotographer\(request, env\); \/\/ scoped to the caller \(who\.id\)/, route);
  }
});
