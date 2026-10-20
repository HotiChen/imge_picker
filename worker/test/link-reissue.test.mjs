// Re-issuing a pick link (docs/guest-picking.md, "Lost / leaked link"): POST
// /api/admin/projects/:id/links mints a new pick link AND, in the same batch,
// revokes every other live pick link of that project, so a project has
// exactly one live pick link. High tier (tokens, a data write): the revoke is
// gated exactly like the mint (this photographer's, not archived) and on the
// new row having landed, touches only kind = 'pick' rows of this project, and
// a refused or failed mint revokes nothing. The seat, keys, collaborators and
// selections are the project's, not the link's, so they carry over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECRET, MINE, setup, call, pick, createProject, claimed, claim, save, rows, one, seedToken, days,
  collectingCtx, withT,
} from './pick-helpers.mjs';
import { withCollaborator, member } from './co-picking-helpers.mjs';
import { twoTenants, ROUTES_ON } from './tenant-helpers.mjs';

const A = '20260819/a.jpg';
const B = '20260819/b.jpg';
const THUMB = '/_thumbs/400/20260819/a.jpg.thumb';

const mint = (env, id, token = SECRET) => call(env, `/api/admin/projects/${id}/links`, { method: 'POST', token });
const live = (env, projectId) =>
  rows(env, "SELECT token FROM share_tokens WHERE kind = 'pick' AND project_id = ? AND revoked_at IS NULL ORDER BY token", projectId)
    .map(r => r.token);
const events = env => rows(env, 'SELECT * FROM project_events ORDER BY id')
  .map(r => ({ ...r, data: r.data == null ? null : JSON.parse(r.data) }));
const reissues = env => events(env).filter(e => e.kind === 'link_reissued');

async function submit(env, t, key) {
  const c = collectingCtx();
  const res = await pick(env, 'POST', 'submit', t, { key, body: { relationship: '本人' } }, c);
  await c.settle();
  return res;
}

const seedProject = (env, id, photographer_id = 'default', archived_at = null) =>
  env.DB._db.prepare('INSERT INTO projects (id, folders, created_at, photographer_id, archived_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, JSON.stringify([MINE]), days(0), photographer_id, archived_at);

// ─── the main behaviour ──────────────────────────────────────────────────────

test('minting a new link revokes the old one: refused (401) on state, list, object, claim, save and submit; the new link works', async () => {
  const env = setup();
  const p = await claimed(env);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, note: 'n' }] })).status, 200);
  // control: the old link works on every route before the mint
  assert.equal((await pick(env, 'GET', 'state', p.token, { key: p.key })).status, 200);
  assert.equal((await call(env, withT(THUMB, p.token))).status, 200);

  const res = await mint(env, p.project.id);
  assert.equal(res.status, 201);
  const fresh = (await res.json()).token;
  assert.deepEqual(live(env, p.project.id), [fresh]);

  const old = p.token;
  assert.equal((await pick(env, 'GET', 'state', old, { key: p.key })).status, 401, 'state');
  assert.equal((await call(env, withT(`/?list=${encodeURIComponent(MINE)}`, old))).status, 401, 'list');
  assert.equal((await call(env, withT(THUMB, old))).status, 401, 'object');
  assert.equal((await pick(env, 'POST', 'claim', old, { body: { name: '路人' } })).status, 401, 'claim');
  assert.equal((await save(env, old, p.key, { upsert: [{ photo_key: B, rating: 1 }] })).status, 401, 'save');
  assert.equal((await submit(env, old, p.key)).status, 401, 'submit');
  assert.equal(rows(env, 'SELECT * FROM submissions').length, 0, 'the old link submitted nothing');
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections WHERE photo_key = ?', B).n, 0, 'the old link saved nothing');

  // the new link: same project, same seat, same selections
  const st = await (await pick(env, 'GET', 'state', fresh, { key: p.key })).json();
  assert.equal(st.project.id, p.project.id);
  assert.equal(st.is_owner, true);
  assert.deepEqual(st.selections.map(s => [s.photo_key, s.rating, s.note]), [[A, 1, 'n']]);
  assert.equal((await call(env, withT(`/?list=${encodeURIComponent(MINE)}`, fresh))).status, 200);
  assert.equal((await call(env, withT(THUMB, fresh))).status, 200);
  assert.equal((await save(env, fresh, p.key, { upsert: [{ photo_key: B, rating: 1 }] })).status, 200);
  assert.equal((await submit(env, fresh, p.key)).status, 200);
});

test('a client mid-pick resumes with the new link: claim with the new link is the same seat (no second owner), state has the same selections', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 2, note: '亮一點' }, { photo_key: B, rating: 1 }] });
  const before = one(env, 'SELECT owner_picker_id FROM projects').owner_picker_id;
  const { token: fresh } = await (await mint(env, p.project.id)).json();
  // the seat is on the project, not the link: someone else claiming via the new link does not take it
  const other = await claim(env, fresh, '路人');
  assert.notEqual(other.json.is_owner, true);
  assert.equal(one(env, 'SELECT owner_picker_id FROM projects').owner_picker_id, before);
  // the owner's key still owns it through the new link
  const st = await (await pick(env, 'GET', 'state', fresh, { key: p.key })).json();
  assert.equal(st.is_owner, true);
  assert.deepEqual(st.selections.map(s => [s.photo_key, s.rating, s.note]).sort(), [[A, 2, '亮一點'], [B, 1, '']]);
});

test('response keeps its fields and adds revoked = the links this call revoked (already-revoked ones keep their stamp)', async () => {
  const env = setup();
  const p = await createProject(env);
  const id = p.project.id;
  await seedToken(env, { token: 'extra-live', project_id: id });
  const oldStamp = days(-3);
  await seedToken(env, { token: 'was-revoked', project_id: id, revoked_at: oldStamp });
  const res = await mint(env, id);
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.deepEqual(Object.keys(json).sort(), ['created_at', 'expires_at', 'revoked', 'status', 'token']);
  assert.equal(json.status, 'live');
  assert.equal(json.revoked, 2, 'the creation link and extra-live');
  assert.deepEqual(live(env, id), [json.token]);
  assert.equal(one(env, "SELECT revoked_at FROM share_tokens WHERE token = 'was-revoked'").revoked_at, oldStamp);
  for (const t of [p.token, 'extra-live']) {
    assert.equal(one(env, 'SELECT revoked_at FROM share_tokens WHERE token = ?', t).revoked_at, json.created_at, t);
  }
  // a second mint revokes just the one before it
  const again = await (await mint(env, id)).json();
  assert.equal(again.revoked, 1);
  assert.deepEqual(live(env, id), [again.token]);
  assert.equal(one(env, 'SELECT revoked_at FROM share_tokens WHERE token = ?', json.token).revoked_at, again.created_at);
});

test('only this project\'s pick links: other kinds with this project_id, other projects\' links, collaborators, the owner\'s key and selections are untouched', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  const q = await createProject(env, { title: '別的案子' });
  for (const [token, kind] of [['CLIENT', 'client'], ['STUDIO', 'studio'], ['SESSION', 'session']]) {
    await seedToken(env, { token, kind, project_id: p.project.id, book_id: kind === 'client' ? 'b1' : '' });
  }
  const snap = () => JSON.stringify([
    rows(env, "SELECT * FROM share_tokens WHERE NOT (kind = 'pick' AND project_id = ?) ORDER BY token", p.project.id),
    rows(env, 'SELECT * FROM pickers ORDER BY id'),
    rows(env, 'SELECT * FROM project_collaborators ORDER BY picker_id'),
    rows(env, 'SELECT * FROM pick_invites ORDER BY id'),
    rows(env, 'SELECT * FROM selections ORDER BY photo_key'),
    rows(env, 'SELECT * FROM projects ORDER BY id'),
  ]);
  const before = snap();
  const json = await (await mint(env, p.project.id)).json();
  assert.equal(json.revoked, 1);
  assert.equal(snap(), before);
  assert.deepEqual(live(env, q.project.id), [q.token], 'the other project keeps its link');
  // the collaborator keeps working through the new link
  assert.ok(!member(env, c.pickerId).revoked_at);
  const st = await (await pick(env, 'GET', 'state', json.token, { key: c.key })).json();
  assert.equal(st.project.id, p.project.id);
  assert.equal((await save(env, json.token, c.key, { upsert: [{ photo_key: B, rating: 1 }] })).status, 200);
  assert.equal((await pick(env, 'GET', 'state', q.token)).status, 200, 'the other project\'s link still opens');
});

// ─── refusals revoke nothing ────────────────────────────────────────────────

test('archived, another photographer\'s and an unknown project refuse with no revocation and no event', async () => {
  const env = setup(ROUTES_ON);
  const { B: other } = await twoTenants(env);
  const p = await createProject(env);
  const id = p.project.id;
  const shareRows = () => JSON.stringify(rows(env, 'SELECT * FROM share_tokens ORDER BY token'));
  let before = shareRows();
  // another photographer: 404
  assert.equal((await mint(env, id, other.token)).status, 404);
  assert.equal(shareRows(), before);
  // unknown
  assert.equal((await mint(env, 'nope')).status, 404);
  assert.equal(shareRows(), before);
  // archived, with a link revived by hand (so a revoke would be visible)
  env.DB._db.prepare('UPDATE projects SET archived_at = ?').run(days(0));
  env.DB._db.prepare('UPDATE share_tokens SET revoked_at = NULL').run();
  before = shareRows();
  const res = await mint(env, id);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'archived');
  assert.equal(shareRows(), before);
  assert.deepEqual(reissues(env), []);
});

test('an archive landing between the read and the batch: 409, the old link is not revoked by the mint, no event', async () => {
  const env = setup();
  const p = await createProject(env);
  const prepare = env.DB.prepare.bind(env.DB);
  let done = false;
  env.DB.prepare = s => {
    // only the stamp, not the archive's own revoke, so the mint's revoke is what is tested
    if (!done && /INSERT INTO share_tokens/.test(s)) { done = true; env.DB._db.prepare('UPDATE projects SET archived_at = ?').run(days(0)); }
    return prepare(s);
  };
  const res = await mint(env, p.project.id);
  assert.equal(res.status, 409);
  assert.ok(done, 'the race was staged');
  assert.equal(one(env, 'SELECT revoked_at FROM share_tokens WHERE token = ?', p.token).revoked_at, null);
  assert.equal(rows(env, 'SELECT * FROM share_tokens').length, 1);
  assert.deepEqual(reissues(env), []);
});

test('the project moving to another photographer between the read and the batch: nothing written, the old link stays live', async () => {
  const env = setup();
  const p = await createProject(env);
  const prepare = env.DB.prepare.bind(env.DB);
  let done = false;
  env.DB.prepare = s => {
    if (!done && /INSERT INTO share_tokens/.test(s)) { done = true; env.DB._db.prepare("UPDATE projects SET photographer_id = 'someone-else'").run(); }
    return prepare(s);
  };
  const res = await mint(env, p.project.id);
  assert.notEqual(res.status, 201);
  assert.ok(done);
  assert.equal(one(env, 'SELECT revoked_at FROM share_tokens WHERE token = ?', p.token).revoked_at, null);
  assert.equal(rows(env, 'SELECT * FROM share_tokens').length, 1);
});

test('a mint whose batch fails leaves the old link live and no new one (the insert or the revoke throwing)', async () => {
  for (const which of [/INSERT INTO share_tokens/, /UPDATE share_tokens SET revoked_at/]) {
    const env = setup();
    const p = await createProject(env);
    await seedToken(env, { token: 'extra-live', project_id: p.project.id });
    const prepare = env.DB.prepare.bind(env.DB);
    let tried = 0;
    env.DB.prepare = s => {
      const stmt = prepare(s);
      if (!which.test(s)) return stmt;
      return { bind: (...a) => { const b = stmt.bind(...a); return { ...b, run: async () => { tried++; await b.run(); throw new Error('D1_ERROR: boom'); } }; } };
    };
    // the route throws (the top-level handler answers 500) or answers non-201: either way nothing landed
    const status = await mint(env, p.project.id).then(r => r.status, () => 'threw');
    assert.notEqual(status, 201, String(which));
    assert.ok(tried >= 1, `the failing statement ran (${which})`);
    assert.deepEqual(live(env, p.project.id), ['extra-live', p.token].sort(), String(which));
    assert.equal(rows(env, 'SELECT * FROM share_tokens').length, 2, String(which));
    assert.deepEqual(reissues(env), [], String(which));
  }
});

// ─── race ───────────────────────────────────────────────────────────────────

test('two mints at once leave exactly one live pick link (the later batch revokes the earlier one\'s token)', async () => {
  const env = setup();
  const p = await createProject(env);
  const out = await Promise.all([mint(env, p.project.id), mint(env, p.project.id), mint(env, p.project.id)]);
  assert.deepEqual(out.map(r => r.status), [201, 201, 201]);
  const tokens = await Promise.all(out.map(r => r.json()));
  const alive = live(env, p.project.id);
  assert.equal(alive.length, 1);
  assert.ok(tokens.some(t => t.token === alive[0]));
  // every link that ever existed was revoked exactly once: 4 links, 3 revocations
  assert.equal(tokens.reduce((n, t) => n + t.revoked, 0), 3);
  assert.equal(rows(env, "SELECT * FROM share_tokens WHERE kind = 'pick'").length, 4);
});

// ─── activity log ───────────────────────────────────────────────────────────

test('a mint logs one link_reissued event (photographer, at = created_at, data {revoked}); no token string in it', async () => {
  const env = setup();
  const p = await createProject(env);
  await seedToken(env, { token: 'extra-live', project_id: p.project.id });
  const json = await (await mint(env, p.project.id)).json();
  const ev = reissues(env);
  assert.equal(ev.length, 1);
  assert.deepEqual({ ...ev[0], id: 0 }, {
    id: 0, project_id: p.project.id, at: json.created_at, kind: 'link_reissued', actor: 'photographer', data: { revoked: 2 },
  });
  const raw = one(env, "SELECT data FROM project_events WHERE kind = 'link_reissued'").data;
  for (const t of [json.token, p.token, 'extra-live']) assert.ok(!raw.includes(t), 'no token in data');
  // a mint with nothing to revoke still logs (the write happened), with revoked: 0
  env.DB._db.prepare('UPDATE share_tokens SET revoked_at = ?').run(days(0));
  const again = await (await mint(env, p.project.id)).json();
  assert.equal(again.revoked, 0);
  assert.deepEqual(reissues(env).map(e => e.data), [{ revoked: 2 }, { revoked: 0 }]);
  // and it is readable by the photographer
  const read = await (await call(env, `/api/admin/projects/${p.project.id}/events`, { token: SECRET })).json();
  assert.deepEqual(read.events.filter(e => e.kind === 'link_reissued').map(e => e.data), [{ revoked: 2 }, { revoked: 0 }]);
});

test('before the project_events migration the mint answers exactly as with it (and revokes the same)', async () => {
  const runOnce = async env => {
    const p = await createProject(env);
    const res = await mint(env, p.project.id);
    const json = await res.json();
    return { status: res.status, keys: Object.keys(json).sort(), revoked: json.revoked, live: live(env, p.project.id).length };
  };
  const withTable = await runOnce(setup());
  const env = setup();
  env.DB._db.exec('DROP TABLE project_events');
  const without = await runOnce(env);
  assert.deepEqual(without, withTable);
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'project_events'").n, 0, 'control: really no table');
  assert.equal(withTable.status, 201);
});

test('an event insert that fails for another reason never fails the mint', async () => {
  const env = setup();
  const p = await createProject(env);
  const prepare = env.DB.prepare.bind(env.DB);
  let tried = 0;
  env.DB.prepare = sql => {
    if (/INSERT INTO project_events/.test(sql)) {
      tried++;
      return { bind: () => ({ run: async () => { throw new Error('D1_ERROR: database is locked'); } }) };
    }
    return prepare(sql);
  };
  const res = await mint(env, p.project.id);
  assert.equal(res.status, 201);
  assert.equal((await res.json()).revoked, 1);
  assert.equal(tried, 1);
  assert.ok(one(env, 'SELECT revoked_at FROM share_tokens WHERE token = ?', p.token).revoked_at, 'the revoke landed');
});
