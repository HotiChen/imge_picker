// Security review of multi-photographer batch 3: suspending, resetting or
// deleting a photographer must cut what they handed out, not only their
// sessions.
//
// - Studio tokens (POST /api/auth/studio-token, a 12-hour read credential
//   for their own files) are revoked in the same batch as the session delete
//   on suspend and reset-password. Not given back on un-suspend.
// - Guest pick links of a suspended photographer's projects go dark the moment
//   the account is suspended and come back on un-suspend (Tim's decision): the
//   owner's status is checked where every link is resolved
//   (resolveShareToken), inside the query that already loads the row, so a
//   hot read costs no extra statement. Dark answers exactly as an unknown
//   link does.
// - A deleted owner (no photographers row) is dark too.
// - The default photographer has no photographers row and is never affected,
//   whatever a row named 'default' would say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, PROOF, PA, SECRET, call, one, rows } from './revision-helpers.mjs';
import { seedPhotographer, ROUTES_ON } from './tenant-helpers.mjs';

const OP = 'operator-secret-0123456789';
const FRESH = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
// share_tokens as before the 2026-10-17 migration (no photographer_id)
const BEFORE_OWNER = FRESH.replace(/(project_id\s+TEXT),\n(?:\s*--[^\n]*\n)*\s*photographer_id\s+TEXT\n\);/, '$1\n);');
const enc = encodeURIComponent;

async function world({ schema } = {}) {
  const env = setup({ extra: { ...ROUTES_ON, OPERATOR_TOKEN: OP }, ...(schema ? { schema } : {}) });
  const A = { id: 'default', token: SECRET, tag: 'A' };
  const B = { ...(await seedPhotographer(env)), tag: 'B' };
  // B's own copy of the shoot, under B's prefix
  for (const [k, v] of [[PA, 'B:PA'], [`_thumbs/400/${PA}.thumb`, 'B:PA-T400']]) {
    env.imagepicker._store.set(`_t/${B.id}/${k}`, { key: `_t/${B.id}/${k}`, body: v, contentType: 'image/jpeg', uploaded: new Date('2026-01-01T00:00:00Z') });
  }
  return { env, A, B };
}
const act = (env, id, action) => call(env, `/api/operator/photographers/${id}/${action}`, { method: 'POST', token: OP });
async function projectOf(env, who) {
  const res = await call(env, '/api/admin/projects', { method: 'POST', token: who.token, body: { title: `${who.tag} 婚紗`, folders: [PROOF] } });
  assert.equal(res.status, 201, `${who.tag}: ${await res.clone().text()}`);
  const out = await res.json();
  return { id: out.project.id, token: out.token };
}
async function mint(env, who) {
  const res = await call(env, '/api/auth/studio-token', { method: 'POST', token: who.token });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()).token;
}
const shareRow = (env, token) => one(env, 'SELECT * FROM share_tokens WHERE token = ?', token);

// every guest-facing read a link opens, as {status, body}
async function reads(env, link) {
  const out = {};
  const grab = async (name, path) => {
    const res = await call(env, path);
    out[name] = { status: res.status, body: await res.text() };
  };
  await grab('state', `/api/pick/state?t=${enc(link)}`);
  await grab('list', `/?list=${enc(PROOF)}&t=${enc(link)}`);
  await grab('object', `/${PA}?t=${enc(link)}`);
  await grab('thumb', `/${PA}?w=400&t=${enc(link)}`);
  return out;
}
// a studio token's reads (it has no pick routes)
async function studioReads(env, token) {
  const out = {};
  for (const [name, path] of [['list', `/?list=${enc(PROOF)}&t=${enc(token)}`], ['object', `/${PA}?t=${enc(token)}`]]) {
    const res = await call(env, path);
    out[name] = { status: res.status, body: await res.text() };
  }
  return out;
}
const BOGUS = 'no-such-link-0000000000000000000000000000';

// ─── pick links: dark while suspended, back on un-suspend ──────────────────
test('suspend: the photographer\'s pick links answer exactly like an unknown link; un-suspend brings them back unrevoked', async () => {
  const w = await world();
  const p = await projectOf(w.env, w.B);
  const before = await reads(w.env, p.token);
  assert.equal(before.state.status, 200, before.state.body);
  assert.equal(before.list.status, 200, before.list.body);
  // a picking-phase link sees the preview, not the original
  assert.equal(before.object.status, 403);
  assert.equal(before.thumb.status, 200);
  assert.equal(before.thumb.body, 'B:PA-T400');

  assert.equal((await act(w.env, w.B.id, 'suspend')).status, 200);
  const dark = await reads(w.env, p.token);
  const unknown = await reads(w.env, BOGUS);
  assert.deepEqual(dark, unknown);
  assert.equal(dark.state.status, 401);
  assert.equal(dark.thumb.status, 401);
  // reversible: the link row itself was not revoked
  assert.equal(shareRow(w.env, p.token).revoked_at, null);

  assert.equal((await act(w.env, w.B.id, 'unsuspend')).status, 200);
  const back = await reads(w.env, p.token);
  assert.equal(back.state.status, 200, back.state.body);
  assert.equal(back.thumb.body, 'B:PA-T400');
  assert.equal(back.list.body, before.list.body);
});

test('a pick link of a deleted photographer (no photographers row) does not resolve', async () => {
  const w = await world();
  const p = await projectOf(w.env, w.B);
  const studio = await mint(w.env, w.B);
  assert.equal((await reads(w.env, p.token)).state.status, 200);
  assert.equal((await studioReads(w.env, studio)).object.status, 200);
  w.env.DB._db.prepare('DELETE FROM photographers WHERE id = ?').run(w.B.id);
  assert.deepEqual(await reads(w.env, p.token), await reads(w.env, BOGUS));
  assert.deepEqual(await studioReads(w.env, studio), await studioReads(w.env, BOGUS));
});

test('a pending owner is dark too: only an active account (or the default) owns a live link', async () => {
  const w = await world();
  const p = await projectOf(w.env, w.B);
  w.env.DB._db.prepare("UPDATE photographers SET status = 'pending' WHERE id = ?").run(w.B.id);
  assert.deepEqual(await reads(w.env, p.token), await reads(w.env, BOGUS));
});

test('a pick link goes by its PROJECT\'s owner, not by what its own row says', async () => {
  const w = await world();
  const a = await projectOf(w.env, w.A);
  const b = await projectOf(w.env, w.B);
  // the rows' own photographer_id swapped by hand: still the project decides
  w.env.DB._db.prepare('UPDATE share_tokens SET photographer_id = ? WHERE token = ?').run(w.B.id, a.token);
  w.env.DB._db.prepare("UPDATE share_tokens SET photographer_id = NULL WHERE token = ?").run(b.token);
  assert.equal((await act(w.env, w.B.id, 'suspend')).status, 200);
  assert.equal((await reads(w.env, a.token)).state.status, 200);
  assert.deepEqual(await reads(w.env, b.token), await reads(w.env, BOGUS));
});

// ─── the default photographer is never affected ────────────────────────────
test('the default photographer\'s links and studio token keep working when another photographer is suspended, and even beside a suspended row named "default"', async () => {
  const w = await world();
  const a = await projectOf(w.env, w.A);
  const studio = await mint(w.env, w.A);
  // a legacy row with a literal 'default' owner reads as the default's
  w.env.DB._db.prepare("INSERT INTO share_tokens (token, book_id, kind, folders, created_at, expires_at, photographer_id) VALUES ('LIT-DEFAULT', '', 'studio', '[]', ?, ?, 'default')")
    .run(new Date(Date.now() - 3600000).toISOString(), new Date(Date.now() + 3600000).toISOString());
  assert.equal((await act(w.env, w.B.id, 'suspend')).status, 200);
  w.env.DB._db.prepare("INSERT INTO photographers (id, email, password_hash, display_name, status, created_at) VALUES ('default', 'd@x.test', 'x', 'd', 'suspended', ?)").run(new Date().toISOString());
  const r = await reads(w.env, a.token);
  assert.equal(r.state.status, 200, r.state.body);
  assert.equal(r.thumb.body, 'PA-T400');
  for (const t of [studio, 'LIT-DEFAULT']) {
    const s = await studioReads(w.env, t);
    assert.equal(s.object.status, 200, t);
    assert.equal(s.list.status, 200, t);
    assert.equal(shareRow(w.env, t).revoked_at, null, t);
  }
});

// ─── studio tokens: revoked in the same batch as the sessions ──────────────
function batchesOf(env) {
  const seen = [];
  const real = env.DB.batch.bind(env.DB);
  env.DB.batch = async statements => {
    const from = env.DB._sql.length;
    const out = await real(statements);
    seen.push(env.DB._sql.slice(from));
    return out;
  };
  return seen;
}

for (const action of ['suspend', 'reset-password']) {
  test(`${action}: the photographer's live studio tokens are revoked in the same batch as the session delete; nobody else's`, async () => {
    const w = await world();
    const C = await seedPhotographer(w.env);
    w.env.imagepicker._store.set(`_t/${C.id}/${PA}`, { key: `_t/${C.id}/${PA}`, body: 'C:PA', contentType: 'image/jpeg', uploaded: new Date('2026-01-01T00:00:00Z') });
    const studioB = await mint(w.env, w.B);
    const studioC = await mint(w.env, C);
    const studioA = await mint(w.env, w.A);
    // an already revoked one keeps its own revoked_at
    w.env.DB._db.prepare("INSERT INTO share_tokens (token, book_id, kind, folders, created_at, expires_at, revoked_at, photographer_id) VALUES ('OLD-B', '', 'studio', '[]', ?, ?, '2026-01-01T00:00:00.000Z', ?)")
      .run(new Date(Date.now() - 3600000).toISOString(), new Date(Date.now() + 3600000).toISOString(), w.B.id);
    const p = await projectOf(w.env, w.B);
    assert.equal((await studioReads(w.env, studioB)).object.status, 200);

    const batches = batchesOf(w.env);
    const res = await act(w.env, w.B.id, action);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(batches.length, 1);
    const [batch] = batches;
    assert.ok(batch.some(s => /DELETE FROM photographer_sessions/.test(s)), 'sessions in the batch');
    assert.ok(batch.some(s => /UPDATE share_tokens SET revoked_at/.test(s) && /kind = 'studio'/.test(s)), 'tokens in the same batch');

    assert.ok(shareRow(w.env, studioB).revoked_at, 'B\'s studio token revoked');
    assert.equal(shareRow(w.env, 'OLD-B').revoked_at, '2026-01-01T00:00:00.000Z');
    assert.equal(shareRow(w.env, studioC).revoked_at, null, 'C untouched');
    assert.equal(shareRow(w.env, studioA).revoked_at, null, 'default untouched');
    // pick links are not revoked by either action
    assert.equal(shareRow(w.env, p.token).revoked_at, null);
    assert.equal(rows(w.env, 'SELECT * FROM photographer_sessions WHERE photographer_id = ?', w.B.id).length, 0);
    assert.deepEqual(await studioReads(w.env, studioB), await studioReads(w.env, BOGUS));
    assert.equal((await studioReads(w.env, studioC)).object.status, 200);
    assert.equal((await studioReads(w.env, studioA)).object.status, 200);
    if (action === 'reset-password') assert.equal((await reads(w.env, p.token)).state.status, 200, 'still active: links stay');
  });
}

test('un-suspend does not give the studio token back', async () => {
  const w = await world();
  const studio = await mint(w.env, w.B);
  await act(w.env, w.B.id, 'suspend');
  await act(w.env, w.B.id, 'unsuspend');
  assert.ok(shareRow(w.env, studio).revoked_at);
  assert.equal((await studioReads(w.env, studio)).object.status, 401);
});

test('a suspend that loses its race (409, the account is not active) revokes nothing; reject of an active account (409) revokes nothing', async () => {
  const w = await world();
  const studio = await mint(w.env, w.B);
  const rej = await act(w.env, w.B.id, 'reject');
  assert.equal(rej.status, 409);
  assert.equal(shareRow(w.env, studio).revoked_at, null, 'reject of an active account');
  w.env.DB._db.prepare("UPDATE photographers SET status = 'pending' WHERE id = ?").run(w.B.id);
  const sus = await act(w.env, w.B.id, 'suspend');
  assert.equal(sus.status, 409);
  assert.equal(shareRow(w.env, studio).revoked_at, null, 'suspend of a pending account');
});

test('reject (the delete): a deleted account\'s studio tokens are revoked in the same batch', async () => {
  const w = await world();
  const studio = await mint(w.env, w.B);
  w.env.DB._db.prepare("UPDATE photographers SET status = 'pending' WHERE id = ?").run(w.B.id);
  const res = await act(w.env, w.B.id, 'reject');
  assert.equal(res.status, 200);
  assert.ok(shareRow(w.env, studio).revoked_at);
});

test('before the share-token owner migration: suspend and reset-password still work (no owned studio rows can exist), the default\'s rows untouched', async () => {
  const w = await world({ schema: BEFORE_OWNER });
  w.env.DB._db.prepare("INSERT INTO share_tokens (token, book_id, kind, folders, created_at, expires_at) VALUES ('A-STUDIO', '', 'studio', '[]', ?, ?)")
    .run(new Date(Date.now() - 3600000).toISOString(), new Date(Date.now() + 3600000).toISOString());
  for (const action of ['suspend', 'unsuspend', 'reset-password']) {
    const res = await act(w.env, w.B.id, action);
    assert.equal(res.status, 200, `${action}: ${await res.clone().text()}`);
  }
  assert.equal(shareRow(w.env, 'A-STUDIO').revoked_at, null);
  assert.equal(rows(w.env, 'SELECT * FROM photographer_sessions WHERE photographer_id = ?', w.B.id).length, 0);
});

// ─── no extra round trip, and the fallbacks ────────────────────────────────
test('the owner check rides in the statements that already load the link: a pick read issues no extra SELECT', async () => {
  const w = await world();
  const p = await projectOf(w.env, w.B);
  const from = w.env.DB._sql.length;
  const res = await call(w.env, `/${PA}?w=400&t=${enc(p.token)}`);
  assert.equal(res.status, 200);
  const sql = w.env.DB._sql.slice(from).filter(s => /^\s*SELECT/i.test(s));
  assert.equal(sql.length, 2, sql.join('\n'));
  assert.match(sql[0], /FROM share_tokens/);
  assert.match(sql[1], /FROM projects/);
  assert.match(sql[1], /photographers/);
});

test('without the photographers table (batch-1 migration not run): the default\'s links work, anyone else\'s are dark', async () => {
  const w = await world();
  const a = await projectOf(w.env, w.A);
  const b = await projectOf(w.env, w.B);
  const studioB = await mint(w.env, w.B);
  w.env.DB._db.exec('DROP TABLE photographers');
  const r = await reads(w.env, a.token);
  assert.equal(r.state.status, 200, r.state.body);
  assert.equal(r.thumb.body, 'PA-T400');
  assert.deepEqual(await reads(w.env, b.token), await reads(w.env, BOGUS));
  assert.deepEqual(await studioReads(w.env, studioB), await studioReads(w.env, BOGUS));
});

test('before the share-token owner migration: every project-less link is the default\'s and resolves as before', async () => {
  const w = await world({ schema: BEFORE_OWNER });
  w.env.DB._db.prepare("INSERT INTO share_tokens (token, book_id, kind, folders, created_at, expires_at) VALUES ('A-STUDIO', '', 'studio', '[]', ?, ?)")
    .run(new Date(Date.now() - 3600000).toISOString(), new Date(Date.now() + 3600000).toISOString());
  const s = await studioReads(w.env, 'A-STUDIO');
  assert.equal(s.object.status, 200);
  const a = await projectOf(w.env, w.A);
  assert.equal((await reads(w.env, a.token)).state.status, 200);
});

// The owner check is a WHERE condition, not a selected column: the rows the
// routes get are exactly the table's columns, so no helper field can ride
// along on `share` / `share.project` (no route echoes those rows whole, so
// a selected-and-stripped column could not be tested from outside).
test('the statements that load a link select only the table\'s own columns; the owner check is in the WHERE', async () => {
  const w = await world();
  const p = await projectOf(w.env, w.B);
  const studio = await mint(w.env, w.B);
  for (const path of [`/${PA}?w=400&t=${enc(p.token)}`, `/${PA}?t=${enc(studio)}`]) {
    const from = w.env.DB._sql.length;
    assert.equal((await call(w.env, path)).status, 200, path);
    const selects = w.env.DB._sql.slice(from).filter(s => /^\s*SELECT/i.test(s) && /FROM (share_tokens|projects)\b/.test(s));
    assert.ok(selects.length >= 1, path);
    for (const sql of selects) {
      const m = /^\s*SELECT\s+(.*?)\s+FROM\s+(share_tokens|projects)\b/is.exec(sql);
      assert.ok(m, sql);
      assert.match(m[1], /^(s|p)\.\*$/, `selects more than the row: ${sql}`);
      assert.match(sql, /WHERE[\s\S]*photographers[\s\S]*status = 'active'/, `owner check in the WHERE: ${sql}`);
    }
  }
});
