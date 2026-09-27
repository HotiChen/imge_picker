// Guest picking, the photographer's half: creating a project mints the one
// LINE link for it, reading it back shows who holds the seat and what they
// picked, and resetting the seat frees it without losing a single pick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECRET, MINE, THEIRS, setup, call, pick, createProject, claim, claimed, save, rows, one,
  collectingCtx,
} from './pick-helpers.mjs';

const post = (env, body, token = SECRET) =>
  call(env, '/api/admin/projects', { method: 'POST', token, body });

// ─── POST /api/admin/projects ────────────────────────────────────────────────

test('creating a project needs the photographer token, and fails closed without one configured', async () => {
  const env = setup();
  assert.equal((await post(env, { folders: [MINE] }, '')).status, 401);
  assert.equal((await post(env, { folders: [MINE] }, 'wrong')).status, 401);
  const unset = setup({ PHOTOGRAPHER_TOKEN: undefined });
  assert.equal((await post(unset, { folders: [MINE] }, 'anything')).status, 401);
  assert.equal(rows(env, 'SELECT * FROM projects').length, 0);
  assert.equal(rows(unset, 'SELECT * FROM projects').length, 0);
});

test('creating a project mints one pick link with a canonical folder snapshot', async () => {
  const env = setup();
  const res = await post(env, {
    title: '王先生 婚紗', folders: [' 20260819 ', '20260819/', THEIRS], pick_limit: 40, extra_price: 200,
  });
  assert.equal(res.status, 201);
  const out = await res.json();
  assert.ok(out.token && out.project?.id && out.expires_at);

  const p = one(env, 'SELECT * FROM projects WHERE id = ?', out.project.id);
  assert.equal(p.title, '王先生 婚紗');
  assert.deepEqual(JSON.parse(p.folders), [MINE, THEIRS]);
  assert.equal(p.pick_limit, 40);
  assert.equal(p.extra_price, 200);
  assert.equal(p.owner_picker_id, null, 'nobody holds the seat until someone claims it');

  const t = one(env, 'SELECT * FROM share_tokens WHERE token = ?', out.token);
  assert.equal(t.kind, 'pick');
  assert.equal(t.project_id, out.project.id);
  assert.equal(t.book_id, '', 'belongs to no album, so no book route can match it');
  assert.deepEqual(JSON.parse(t.folders), [MINE, THEIRS]);
  assert.equal(t.revoked_at, null);
  const life = Date.parse(t.expires_at) - Date.parse(t.created_at);
  assert.ok(Math.abs(life - 90 * 86400000) < 5000, 'the same 90-day life as an album link');
});

test('limit and price are optional: NULL means no limit and no price shown', async () => {
  const env = setup();
  const out = await (await post(env, { folders: [MINE] })).json();
  const p = one(env, 'SELECT * FROM projects WHERE id = ?', out.project.id);
  assert.equal(p.pick_limit, null);
  assert.equal(p.extra_price, null);
  assert.equal(p.title, '');
});

test('a project is refused unless its folders are real, non-internal folders', async () => {
  const env = setup();
  for (const folders of [undefined, [], 'x/', [''], ['  '], [7], ['/'], ['_books/'], ['_thumbs/400/'], ['2026/../'], ['./']]) {
    const res = await post(env, { folders });
    assert.equal(res.status, 400, JSON.stringify(folders));
  }
  assert.equal(rows(env, 'SELECT * FROM projects').length, 0);
  assert.equal(rows(env, "SELECT * FROM share_tokens WHERE kind = 'pick'").length, 0);
});

test('limit and price must be whole numbers from zero up when given', async () => {
  const env = setup();
  for (const bad of [-1, 1.5, '40', true]) {
    assert.equal((await post(env, { folders: [MINE], pick_limit: bad })).status, 400, `limit ${bad}`);
    assert.equal((await post(env, { folders: [MINE], extra_price: bad })).status, 400, `price ${bad}`);
  }
  assert.equal((await post(env, { folders: [MINE], pick_limit: 0, extra_price: 0 })).status, 201);
  assert.equal((await post(env, { folders: [MINE], title: 7 })).status, 400);
});

// ─── GET /api/admin/projects/:id ─────────────────────────────────────────────

test('reading a project back needs the photographer token', async () => {
  const env = setup();
  const { project, token } = await createProject(env);
  assert.equal((await call(env, `/api/admin/projects/${project.id}`)).status, 401);
  assert.equal((await call(env, `/api/admin/projects/${project.id}`, { token: 'wrong' })).status, 401);
  // the link itself is not a way in either
  assert.equal((await call(env, `/api/admin/projects/${project.id}?t=${token}`)).status, 401);
  assert.equal((await call(env, `/api/admin/projects/${project.id}`, { token })).status, 401);
  assert.equal((await call(env, '/api/admin/projects/nope', { token: SECRET })).status, 404);
});

test('the photographer sees the seat holder, the submit record and who set each pick', async () => {
  const env = setup();
  const c = collectingCtx();
  const p = await claimed(env, {}, '<b>王</b>小明');
  await save(env, p.token, p.key, { upsert: [{ photo_key: '20260819/a.jpg', rating: 5, note: '<i>放大</i>' }] });
  await pick(env, 'POST', 'submit', p.token, { key: p.key, body: { relationship: '本人', email: 'a@b.tw' } }, c);
  await c.settle();

  const res = await call(env, `/api/admin/projects/${p.project.id}`, { token: SECRET });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /application\/json/,
    'guest strings go out as JSON, never as markup the Worker built');
  assert.match(res.headers.get('Cache-Control') || '', /no-store/);
  const out = await res.json();
  assert.equal(out.project.id, p.project.id);
  assert.equal(out.project.pick_limit, 40);
  assert.equal(out.owner.id, p.pickerId);
  assert.equal(out.owner.name, '<b>王</b>小明', 'raw in JSON; the admin page escapes on render');
  assert.equal(out.owner.relationship, '本人');
  assert.equal(out.owner.email, 'a@b.tw');
  assert.equal(out.owner.submit_count, 1);
  assert.equal(out.owner.submit_limit, 40);
  assert.equal(out.owner.submit_price, 200);
  assert.ok(out.owner.submitted_at);
  assert.equal(out.selections.length, 1);
  assert.equal(out.selections[0].photo_key, '20260819/a.jpg');
  assert.equal(out.selections[0].note, '<i>放大</i>');
  assert.equal(out.selections[0].updated_by, p.pickerId);
  assert.equal(out.tokens.length, 1);
  assert.equal(out.tokens[0].token, p.token, 'so the photographer can revoke the link');
  assert.doesNotMatch(JSON.stringify(out), /key_hash/, 'the stored key hash never leaves the Worker');
});

// ─── POST /api/admin/projects/:id/reset-seat ─────────────────────────────────

test('resetting the seat needs the photographer token', async () => {
  const env = setup();
  const p = await claimed(env);
  const path = `/api/admin/projects/${p.project.id}/reset-seat`;
  assert.equal((await call(env, path, { method: 'POST' })).status, 401);
  assert.equal((await call(env, path, { method: 'POST', token: p.token })).status, 401);
  assert.equal((await call(env, `${path}?t=${p.token}`, { method: 'POST', key: p.key })).status, 401);
  assert.equal(one(env, 'SELECT owner_picker_id FROM projects').owner_picker_id, p.pickerId);
  assert.equal((await call(env, '/api/admin/projects/nope/reset-seat', { method: 'POST', token: SECRET })).status, 404);
});

test('resetting the seat frees it and keeps every pick', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: '20260819/a.jpg', rating: 3 }] });
  const res = await call(env, `/api/admin/projects/${p.project.id}/reset-seat`, { method: 'POST', token: SECRET });
  assert.equal(res.status, 200);
  assert.equal(one(env, 'SELECT owner_picker_id FROM projects').owner_picker_id, null);
  assert.equal(rows(env, 'SELECT * FROM selections').length, 1, 'selections belong to the project');
  const stale = await (await pick(env, 'GET', 'state', p.token, { key: p.key })).json();
  assert.equal(stale.is_owner, false, 'the old key is a viewer now');
  assert.equal(stale.owner, null);

  // the next person to claim inherits them
  const next = await claim(env, p.token, '王太太');
  assert.equal(next.res.status, 200);
  const state = await (await pick(env, 'GET', 'state', p.token, { key: next.key })).json();
  assert.equal(state.is_owner, true);
  assert.deepEqual(state.selections.map(s => s.photo_key), ['20260819/a.jpg']);
});

// ─── Rule 1: nothing a guest does writes project_members ─────────────────────

test('no link or claim ever writes project_members, whatever the guest sends', async () => {
  const env = setup();
  const c = collectingCtx();
  const { token } = await createProject(env);
  const cl = await pick(env, 'POST', 'claim', token, {
    body: { name: '王小明', role: 'owner', user_id: 1, project_id: 'x' },
  });
  assert.equal(cl.status, 200);
  const { picker_key: key } = await cl.json();
  await pick(env, 'GET', 'state', token, { key });
  await save(env, token, key, { upsert: [{ photo_key: '20260819/a.jpg', rating: 1, role: 'owner' }] });
  await pick(env, 'POST', 'submit', token, { key, body: { relationship: '本人', role: 'owner' } }, c);
  await c.settle();
  // a second claimant, and a guest-supplied user id on the way
  await pick(env, 'POST', 'claim', token, { body: { name: '路人', role: 'owner' } });

  assert.equal(rows(env, 'SELECT * FROM project_members').length, 0);
  const touched = env.DB._writes().filter(s => /project_members/i.test(s));
  assert.deepEqual(touched, [], 'no statement on a guest path names project_members');
  assert.equal(one(env, 'SELECT user_id FROM pickers').user_id, null, 'nor ties the seat to an account');
});

test('project_members only accepts the three roles the design names', () => {
  const env = setup();
  assert.throws(() => env.DB._db.prepare(
    "INSERT INTO project_members (project_id, user_id, role) VALUES ('p', 1, 'admin')"
  ).run(), /CHECK/);
});

// ─── the hand-run migration ──────────────────────────────────────────────────

test('the migration file turns a deployed database into exactly what schema.sql creates fresh', async () => {
  const { readFileSync } = await import('node:fs');
  const { fakeDB } = await import('./fakes.mjs');
  const fresh = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/2026-09-27-guest-picking.sql', import.meta.url), 'utf8');
  // the live database: share_tokens without project_id, none of the new tables
  const deployed = fresh
    .replace(/,\n(?:\s*--[^\n]*\n)*\s*project_id\s+TEXT\n\);/, '\n);')
    .replace(/\n-- ─── Guest picking[\s\S]*$/, '\n');
  assert.doesNotMatch(deployed, /project_id|CREATE TABLE IF NOT EXISTS projects/, 'fixture still has the new schema');
  const migrated = fakeDB({ schema: deployed + '\n' + migration });
  const created = fakeDB({ schema: fresh });
  const shape = db => ['share_tokens', 'projects', 'pickers', 'selections', 'project_members']
    .map(t => [t, db._db.prepare(`PRAGMA table_info(${t})`).all()]);
  assert.deepEqual(shape(migrated), shape(created));
  // table_info cannot see a CHECK, so the role constraint is tried directly
  assert.throws(() => migrated._db.prepare(
    "INSERT INTO project_members (project_id, user_id, role) VALUES ('p', 1, 'admin')").run(), /CHECK/);
  // and the CREATEs are safe to paste twice (the ALTER is not, and says so)
  assert.match(migration, /duplicate column name/);
});

// ─── photographer_id: attributable from day one ──────────────────────────────

test('every project is attributed to the one photographer, never to what the body says', async () => {
  const env = setup();
  const res = await post(env, { folders: [MINE], photographer_id: 'someone-else' });
  assert.equal(res.status, 201);
  const out = await res.json();
  assert.equal(one(env, 'SELECT photographer_id FROM projects WHERE id = ?', out.project.id).photographer_id, 'default');
  const back = await (await call(env, `/api/admin/projects/${out.project.id}`, { token: SECRET })).json();
  assert.equal(back.project.photographer_id, 'default');
});

test('a project row written without photographer_id reads as the default photographer', () => {
  const env = setup();
  env.DB._db.prepare("INSERT INTO projects (id, folders, created_at) VALUES ('p', '[]', 'now')").run();
  assert.equal(one(env, "SELECT photographer_id FROM projects WHERE id = 'p'").photographer_id, 'default');
});
