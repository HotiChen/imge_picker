// Project plan: the extra-pick cap and editing a project's plan
// (docs/project-plan.md).
//
// - projects.extra_max: how many ♥ photos the guest may pick above
//   pick_limit. A save that would leave more than pick_limit + extra_max ♥
//   photos is 409 pick_cap, checked inside the same conditional writes as the
//   other caps. NULL pick_limit or NULL extra_max = no plan cap.
// - Set at creation (body → studio_settings.default_extra_max → 10), edited by
//   PATCH /api/admin/projects/:id together with pick_limit, extra_price and
//   allow_proof_download.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  SECRET, MINE, setup, call, pick, claimed, createProject, save, one, rows,
} from './pick-helpers.mjs';
import { fakeDB } from './fakes.mjs';

const MONEY_MAX = 10_000_000;
const A = '20260819/a.jpg';
const B = '20260819/b.jpg';
const C = '20260819/c.jpg';
const keysN = (n, from = 0) => Array.from({ length: n }, (_, i) => `20260819/k${from + i}.jpg`);
const hearts = keys => keys.map(photo_key => ({ photo_key, rating: 1 }));

function seed(env, projectId, keys, rating = 1) {
  const ins = env.DB._db.prepare(
    "INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at) VALUES (?, ?, ?, '', 'seed', 'seeded')");
  env.DB._db.exec('BEGIN');
  for (const k of keys) ins.run(projectId, k, rating);
  env.DB._db.exec('COMMIT');
}
const starred = env => one(env, 'SELECT COUNT(*) AS n FROM selections WHERE rating > 0').n;
const selectionRows = env => JSON.stringify(rows(env, 'SELECT * FROM selections ORDER BY photo_key'));
const projectRow = (env, id) => ({ ...one(env, 'SELECT * FROM projects WHERE id = ?', id) });

const post = (env, body, token = SECRET) => call(env, '/api/admin/projects', { method: 'POST', token, body });
const patch = (env, id, body, token = SECRET) => call(env, `/api/admin/projects/${id}`, { method: 'PATCH', token, body });
const getSettings = env => call(env, '/api/admin/settings', { token: SECRET });
const putSettings = (env, body) => call(env, '/api/admin/settings', { method: 'PUT', token: SECRET, body });
const detail = async (env, id) => (await call(env, `/api/admin/projects/${id}`, { token: SECRET })).json();
const list = async (env, q = '') => (await call(env, `/api/admin/projects${q}`, { token: SECRET })).json();
const state = async (env, t, key) => (await pick(env, 'GET', 'state', t, { key })).json();
const admin = (env, id, action) => call(env, `/api/admin/projects/${id}/${action}`, { method: 'POST', token: SECRET });

// a claimed project with the plan given (pick_limit / extra_max)
const planned = (env, plan) => claimed(env, plan);

async function expectPickCap(res, max, limit, extraMax) {
  assert.equal(res.status, 409);
  const json = await res.json();
  assert.equal(json.code, 'pick_cap');
  assert.equal(json.max, max);
  assert.equal(json.limit, limit);
  assert.equal(json.extra_max, extraMax);
  assert.equal(typeof json.error, 'string');
  assert.match(json.error, new RegExp(String(max)));
}

// schema.sql as a database that has not had the extra-max migration
const FRESH = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const PRE_MIGRATION = FRESH
  .replace(/(allow_proof_download INTEGER NOT NULL DEFAULT 0),\n(?:\s*--[^\n]*\n)*\s*extra_max\s+INTEGER\n\);/, '$1\n);')
  .replace(/(updated_at\s+TEXT),\n(?:\s*--[^\n]*\n)*\s*default_extra_max\s+INTEGER\n\);/, '$1\n);');
const preMigrationEnv = () => setup({ DB: fakeDB({ schema: PRE_MIGRATION }) });

// ─── the migration ──────────────────────────────────────────────────────────

test('migration: two append-only ALTERs, noted in schema.sql; the fixture really lacks them', () => {
  const file = new URL('../migrations/2026-09-30-extra-max.sql', import.meta.url);
  assert.ok(existsSync(file));
  const sql = readFileSync(file, 'utf8');
  const statements = sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
  assert.deepEqual(statements, [
    'ALTER TABLE projects ADD COLUMN extra_max INTEGER',
    'ALTER TABLE studio_settings ADD COLUMN default_extra_max INTEGER',
  ]);
  assert.match(sql, /duplicate column/i);
  assert.match(FRESH, /2026-09-30-extra-max\.sql/);
  assert.match(FRESH, /ALTER TABLE projects ADD COLUMN extra_max INTEGER;/);
  assert.match(FRESH, /ALTER TABLE studio_settings ADD COLUMN default_extra_max INTEGER;/);
  const old = fakeDB({ schema: PRE_MIGRATION });
  assert.throws(() => old._db.prepare('SELECT extra_max FROM projects').all(), /no such column/);
  assert.throws(() => old._db.prepare('SELECT default_extra_max FROM studio_settings').all(), /no such column/);
  const shape = db => ['projects', 'studio_settings'].map(t => db._db.prepare(`PRAGMA table_info(${t})`).all());
  assert.deepEqual(shape(fakeDB({ schema: PRE_MIGRATION + '\n' + sql })), shape(fakeDB()));
  // and a second paste fails loudly rather than doing anything
  const twice = fakeDB({ schema: PRE_MIGRATION + '\n' + sql });
  assert.throws(() => twice._db.exec(sql), /duplicate column/);
});

// ─── settings: default_extra_max ─────────────────────────────────────────────

test('settings: default_extra_max starts unset, and the effective default is 10', async () => {
  const env = setup();
  const json = await (await getSettings(env)).json();
  assert.equal(json.default_extra_max, null);
  assert.equal(json.effective_default_extra_max, 10);
});

test('settings: PUT default_extra_max stores 0..500, null clears it back to the 10 default', async () => {
  const env = setup();
  for (const v of [0, 25, 500]) {
    const res = await putSettings(env, { default_extra_max: v });
    assert.equal(res.status, 200, String(v));
    const json = await res.json();
    assert.equal(json.default_extra_max, v);
    assert.equal(json.effective_default_extra_max, v);
    assert.equal(one(env, 'SELECT default_extra_max FROM studio_settings').default_extra_max, v);
  }
  // a PUT that leaves it out keeps it
  await putSettings(env, { default_extra_max: 7 });
  assert.equal((await (await putSettings(env, { default_pick_limit: 3 })).json()).default_extra_max, 7);
  const cleared = await (await putSettings(env, { default_extra_max: null })).json();
  assert.equal(cleared.default_extra_max, null);
  assert.equal(cleared.effective_default_extra_max, 10);
  assert.equal(cleared.default_pick_limit, 3);
});

test('settings: an invalid default_extra_max is 400 invalid_default_extra_max, nothing written', async () => {
  const env = setup();
  await putSettings(env, { default_extra_max: 5, studio_name: 'A' });
  const before = JSON.stringify(rows(env, 'SELECT * FROM studio_settings'));
  for (const v of [-1, 1.5, '3', true, 501, 2 ** 53, 1e300, {}, [], '']) {
    const res = await putSettings(env, { default_extra_max: v, studio_name: 'B' });
    assert.equal(res.status, 400, JSON.stringify(v));
    assert.equal((await res.json()).code, 'invalid_default_extra_max', JSON.stringify(v));
  }
  assert.equal(JSON.stringify(rows(env, 'SELECT * FROM studio_settings')), before);
});

test('settings before the migration: GET and other PUTs work; naming default_extra_max is 500 extra_max_unavailable', async () => {
  const env = preMigrationEnv();
  let res = await getSettings(env);
  assert.equal(res.status, 200);
  let json = await res.json();
  assert.equal(json.default_extra_max, null);
  assert.equal(json.effective_default_extra_max, 10);
  res = await putSettings(env, { studio_name: '光影', default_pick_limit: 30 });
  assert.equal(res.status, 200);
  json = await res.json();
  assert.equal(json.studio_name, '光影');
  assert.equal(json.default_extra_max, null);
  const before = JSON.stringify(rows(env, 'SELECT * FROM studio_settings'));
  res = await putSettings(env, { studio_name: 'X', default_extra_max: 5 });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).code, 'extra_max_unavailable');
  assert.equal(JSON.stringify(rows(env, 'SELECT * FROM studio_settings')), before);
});

// ─── create ──────────────────────────────────────────────────────────────────

test('create: an explicit extra_max (0..500, or null = no plan cap) is stored and returned', async () => {
  const env = setup();
  await putSettings(env, { default_extra_max: 33 });
  for (const v of [0, 7, 500, null]) {
    const res = await post(env, { folders: [MINE], pick_limit: 40, extra_max: v });
    assert.equal(res.status, 201, String(v));
    const out = await res.json();
    assert.equal(out.project.extra_max, v);
    assert.equal(projectRow(env, out.project.id).extra_max, v);
  }
});

test('create: an invalid extra_max is 400 and no project or link is made', async () => {
  const env = setup();
  for (const v of [-1, 1.5, '5', true, 501, 2 ** 53, 1e20, [], {}]) {
    const res = await post(env, { folders: [MINE], extra_max: v });
    assert.equal(res.status, 400, JSON.stringify(v));
    assert.match((await res.json()).error, /extra_max/);
  }
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM projects').n, 0);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM share_tokens').n, 0);
});

test('create: extra_max left out comes from settings, else 10', async () => {
  const env = setup();
  // no settings row at all
  let out = await (await post(env, { folders: [MINE] })).json();
  assert.equal(out.project.extra_max, 10);
  assert.equal(projectRow(env, out.project.id).extra_max, 10);
  // a settings row without the default
  await putSettings(env, { studio_name: 'A' });
  out = await (await post(env, { folders: [MINE] })).json();
  assert.equal(projectRow(env, out.project.id).extra_max, 10);
  // the studio default, 0 included (0 is not "unset")
  for (const v of [25, 0]) {
    await putSettings(env, { default_extra_max: v });
    out = await (await post(env, { folders: [MINE], pick_limit: 5 })).json();
    assert.equal(out.project.extra_max, v);
    assert.equal(projectRow(env, out.project.id).extra_max, v);
  }
  // the body beats the default
  out = await (await post(env, { folders: [MINE], extra_max: 3 })).json();
  assert.equal(projectRow(env, out.project.id).extra_max, 3);
  // another photographer's default is not ours
  env.DB._db.prepare("INSERT INTO studio_settings (photographer_id, default_extra_max) VALUES ('other', 99)").run();
  await putSettings(env, { default_extra_max: null });
  out = await (await post(env, { folders: [MINE] })).json();
  assert.equal(projectRow(env, out.project.id).extra_max, 10);
});

test('create: a hand-edited out-of-range studio default falls back to 10', async () => {
  const env = setup();
  env.DB._db.prepare("INSERT INTO studio_settings (photographer_id, default_extra_max) VALUES ('default', 100000)").run();
  const out = await (await post(env, { folders: [MINE] })).json();
  assert.equal(projectRow(env, out.project.id).extra_max, 10);
});

test('list and detail carry the plan, extra_max NULL for a project from before the feature', async () => {
  const env = setup();
  const p = await createProject(env, { pick_limit: 40, extra_price: 200, extra_max: 6 });
  const old = await createProject(env, { pick_limit: 20 });
  env.DB._db.prepare('UPDATE projects SET extra_max = NULL WHERE id = ?').run(old.project.id);
  const d = await detail(env, p.project.id);
  assert.equal(d.project.extra_max, 6);
  assert.equal(d.project.pick_limit, 40);
  assert.equal((await detail(env, old.project.id)).project.extra_max, null);
  const l = (await list(env)).projects;
  const row = l.find(r => r.id === p.project.id);
  assert.deepEqual([row.pick_limit, row.extra_price, row.extra_max], [40, 200, 6]);
  assert.equal(l.find(r => r.id === old.project.id).extra_max, null);
});

// ─── PATCH: the plan edit ────────────────────────────────────────────────────

test('PATCH: each plan key alone is stored, and the answer echoes exactly the keys sent', async () => {
  const env = setup();
  const p = await createProject(env, { pick_limit: 40, extra_price: 200, extra_max: 10 });
  const id = p.project.id;
  const cases = [
    [{ pick_limit: 30 }, { pick_limit: 30 }],
    [{ pick_limit: null }, { pick_limit: null }],
    [{ pick_limit: 0 }, { pick_limit: 0 }],
    [{ extra_price: 350 }, { extra_price: 350 }],
    [{ extra_price: MONEY_MAX }, { extra_price: MONEY_MAX }],
    [{ extra_price: null }, { extra_price: null }],
    [{ extra_price: 0 }, { extra_price: 0 }],
    [{ extra_max: 0 }, { extra_max: 0 }],
    [{ extra_max: 500 }, { extra_max: 500 }],
    [{ extra_max: null }, { extra_max: null }],
    [{ extra_max: 4 }, { extra_max: 4 }],
  ];
  for (const [body, expect] of cases) {
    const before = projectRow(env, id);
    const res = await patch(env, id, body);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.deepEqual(await res.json(), { ok: true, ...expect });
    assert.deepEqual(projectRow(env, id), { ...before, ...expect }, `only ${Object.keys(body)} changed`);
  }
});

test('PATCH: any subset in one call, allow_proof_download included', async () => {
  const env = setup();
  const p = await createProject(env, { pick_limit: 40, extra_price: 200, extra_max: 10 });
  const id = p.project.id;
  let res = await patch(env, id, { pick_limit: 12, extra_max: 3 });
  assert.deepEqual(await res.json(), { ok: true, pick_limit: 12, extra_max: 3 });
  assert.deepEqual([projectRow(env, id).pick_limit, projectRow(env, id).extra_price, projectRow(env, id).extra_max], [12, 200, 3]);
  res = await patch(env, id, { allow_proof_download: true, pick_limit: null, extra_price: 99, extra_max: null });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, allow_proof_download: true, pick_limit: null, extra_price: 99, extra_max: null });
  const row = projectRow(env, id);
  assert.deepEqual([row.allow_proof_download, row.pick_limit, row.extra_price, row.extra_max], [1, null, 99, null]);
  // the old body alone keeps its old answer
  res = await patch(env, id, { allow_proof_download: false });
  assert.deepEqual(await res.json(), { ok: true, allow_proof_download: false });
  assert.equal(projectRow(env, id).allow_proof_download, 0);
});

test('PATCH: a bad value, an unknown key or an empty body is 400 invalid_body and writes nothing', async () => {
  const env = setup();
  const p = await createProject(env, { pick_limit: 40, extra_price: 200, extra_max: 10 });
  const id = p.project.id;
  const before = projectRow(env, id);
  const bodies = [
    {}, [], 'x', null, 5, [{ pick_limit: 1 }],
    { pick_limit: -1 }, { pick_limit: 1.5 }, { pick_limit: '40' }, { pick_limit: true }, { pick_limit: 2 ** 53 },
    { pick_limit: 1e300 }, { pick_limit: {} }, { pick_limit: [] },
    { extra_price: -1 }, { extra_price: MONEY_MAX + 1 }, { extra_price: '200' }, { extra_price: 1.5 }, { extra_price: false },
    { extra_max: -1 }, { extra_max: 501 }, { extra_max: '10' }, { extra_max: 1.5 }, { extra_max: true }, { extra_max: 1e300 },
    { allow_proof_download: 1 }, { allow_proof_download: null }, { allow_proof_download: 'true' },
    { pick_limit: 30, foo: 1 }, { title: 'x' }, { phase: 'picking' }, { photographer_id: 'x' }, { archived_at: null },
    // one bad key spoils the whole body
    { pick_limit: 30, extra_price: 100, extra_max: -1 }, { allow_proof_download: true, pick_limit: '1' },
  ];
  for (const body of bodies) {
    const res = await patch(env, id, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).code, 'invalid_body', JSON.stringify(body));
  }
  // unparseable JSON too
  const raw = await call(env, `/api/admin/projects/${id}`, { method: 'PATCH', token: SECRET, body: '{"pick_limit":', headers: { 'Content-Type': 'application/json' } });
  assert.equal(raw.status, 400);
  assert.equal((await raw.json()).code, 'invalid_body');
  assert.deepEqual(projectRow(env, id), before);
});

test('PATCH: unknown project or another photographer\'s is 404 and untouched', async () => {
  const env = setup();
  const p = await createProject(env, { pick_limit: 40, extra_max: 10 });
  const theirs = await createProject(env, { pick_limit: 40, extra_max: 10 });
  env.DB._db.prepare("UPDATE projects SET photographer_id = 'other' WHERE id = ?").run(theirs.project.id);
  const before = projectRow(env, theirs.project.id);
  for (const body of [{ pick_limit: 1 }, { extra_max: 0 }, { extra_price: 1 }, { allow_proof_download: true }]) {
    assert.equal((await patch(env, theirs.project.id, body)).status, 404, JSON.stringify(body));
    assert.equal((await patch(env, 'no-such-project', body)).status, 404);
  }
  assert.deepEqual(projectRow(env, theirs.project.id), before);
  // and ours still works
  assert.equal((await patch(env, p.project.id, { pick_limit: 1 })).status, 200);
});

test('PATCH: an archived project refuses a plan edit (409 archived, nothing written); the proof switch alone still works', async () => {
  const env = setup();
  const p = await createProject(env, { pick_limit: 40, extra_price: 200, extra_max: 10 });
  const id = p.project.id;
  assert.equal((await admin(env, id, 'archive')).status, 200);
  const before = projectRow(env, id);
  for (const body of [{ pick_limit: 1 }, { extra_price: 1 }, { extra_max: 0 }, { allow_proof_download: true, extra_max: 0 }]) {
    const res = await patch(env, id, body);
    assert.equal(res.status, 409, JSON.stringify(body));
    const json = await res.json();
    assert.equal(json.code, 'archived');
    assert.match(json.error, /archived/i);
  }
  assert.deepEqual(projectRow(env, id), before);
  // allow_proof_download alone keeps its behaviour from before this change
  assert.equal((await patch(env, id, { allow_proof_download: true })).status, 200);
  assert.equal(projectRow(env, id).allow_proof_download, 1);
  // unarchived: editable again
  assert.equal((await admin(env, id, 'unarchive')).status, 200);
  assert.equal((await patch(env, id, { pick_limit: 1 })).status, 200);
  assert.equal(projectRow(env, id).pick_limit, 1);
});

test('PATCH is admin only; other methods on the project are 405, and nothing is written', async () => {
  const env = setup();
  const p = await createProject(env, { pick_limit: 40, extra_max: 10 });
  const id = p.project.id;
  const before = projectRow(env, id);
  for (const token of ['', 'wrong', p.token]) {
    assert.equal((await patch(env, id, { pick_limit: 1 }, token)).status, 401, `token ${token}`);
  }
  assert.equal((await call(env, `/api/admin/projects/${id}?t=${p.token}`, { method: 'PATCH', body: { pick_limit: 1 } })).status, 401);
  assert.equal((await call(env, `/api/admin/projects/${id}`, { method: 'PATCH', headers: { 'X-Share-Token': p.token }, body: { pick_limit: 1 } })).status, 401);
  for (const method of ['PUT', 'POST']) {
    const res = await call(env, `/api/admin/projects/${id}`, { method, token: SECRET, body: { pick_limit: 1 } });
    assert.equal(res.status, 405, method);
    // and without the token it is 401, not a hint that the route exists
    assert.equal((await call(env, `/api/admin/projects/${id}`, { method, body: { pick_limit: 1 } })).status, 401, method);
  }
  assert.deepEqual(projectRow(env, id), before);
  assert.equal([...env.imagepicker._store.keys()].filter(k => k.startsWith('api/')).length, 0, 'nothing uploaded under api/');
});

test('PATCH works in every phase', async () => {
  const env = setup();
  const p = await claimed(env, { pick_limit: 40, extra_max: 10 });
  const id = p.project.id;
  assert.equal((await patch(env, id, { extra_max: 1 })).status, 200);
  await save(env, p.token, p.key, { upsert: hearts([A]) });
  assert.equal((await pick(env, 'POST', 'submit', p.token, { key: p.key, body: { relationship: '本人' } })).status, 200);
  assert.equal(projectRow(env, id).phase, 'submitted');
  assert.equal((await patch(env, id, { extra_max: 2 })).status, 200);
  assert.equal((await admin(env, id, 'start-retouch')).status, 200);
  assert.equal(projectRow(env, id).phase, 'retouching');
  assert.equal((await patch(env, id, { extra_max: 3, pick_limit: 9 })).status, 200);
  assert.deepEqual([projectRow(env, id).extra_max, projectRow(env, id).pick_limit], [3, 9]);
});

test('PATCH never rewrites a submission: they keep the plan as it stood; the next submit takes the new one', async () => {
  const env = setup();
  const p = await claimed(env, { pick_limit: 1, extra_price: 200, extra_max: 10 });
  await save(env, p.token, p.key, { upsert: hearts([A, B]) });
  assert.equal((await pick(env, 'POST', 'submit', p.token, { key: p.key, body: { relationship: '本人' } })).status, 200);
  const before = JSON.stringify(rows(env, 'SELECT * FROM submissions'));
  assert.equal((await patch(env, p.project.id, { pick_limit: 5, extra_price: 999, extra_max: 0 })).status, 200);
  assert.equal(JSON.stringify(rows(env, 'SELECT * FROM submissions')), before);
  const d = await detail(env, p.project.id);
  assert.deepEqual([d.submissions[0].pick_limit, d.submissions[0].extra_price], [1, 200]);
  // a changed submit afterwards snapshots the new plan
  await save(env, p.token, p.key, { upsert: hearts([C]) });
  assert.equal((await pick(env, 'POST', 'submit', p.token, { key: p.key, body: { relationship: '本人' } })).status, 200);
  const subs = rows(env, 'SELECT pick_limit, extra_price FROM submissions ORDER BY rowid');
  assert.deepEqual(subs.map(s => [s.pick_limit, s.extra_price]), [[1, 200], [5, 999]]);
});

test('PATCH before the migration: pick_limit and extra_price work; extra_max is 500 extra_max_unavailable, nothing written', async () => {
  const env = preMigrationEnv();
  const p = await createProject(env, { pick_limit: 40, extra_price: 200 });
  const id = p.project.id;
  let res = await patch(env, id, { pick_limit: 30, extra_price: 100 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, pick_limit: 30, extra_price: 100 });
  const before = projectRow(env, id);
  res = await patch(env, id, { pick_limit: 5, extra_max: 3 });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).code, 'extra_max_unavailable');
  assert.deepEqual(projectRow(env, id), before);
});

// ─── the cap ─────────────────────────────────────────────────────────────────

test('cap: exactly pick_limit + extra_max ♥ photos is fine, one more is 409 pick_cap and writes nothing', async () => {
  const env = setup();
  const p = await planned(env, { pick_limit: 3, extra_max: 2 });
  // one save straight past the cap
  let res = await save(env, p.token, p.key, { upsert: hearts(keysN(6)) });
  await expectPickCap(res, 5, 3, 2);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections').n, 0);
  // one save straight to it
  assert.equal((await save(env, p.token, p.key, { upsert: hearts(keysN(5)) })).status, 200);
  assert.equal(starred(env), 5);
  // one more: refused whole, the note edit riding along included
  const before = selectionRows(env);
  res = await save(env, p.token, p.key, {
    upsert: [{ photo_key: keysN(1)[0], rating: 3, note: 'changed' }, { photo_key: A, rating: 1 }],
  });
  await expectPickCap(res, 5, 3, 2);
  assert.equal(selectionRows(env), before);
  assert.equal(projectRow(env, p.project.id).modified_after_submit, 0);
});

test('cap: the refusal message names the plan', async () => {
  const env = setup();
  const p = await planned(env, { pick_limit: 3, extra_max: 2 });
  const json = await (await save(env, p.token, p.key, { upsert: hearts(keysN(6)) })).json();
  assert.match(json.error, /3/);
  assert.match(json.error, /2/);
  assert.match(json.error, /5/);
});

test('cap: extra_max 0 means no extras — pick_limit itself is the cap', async () => {
  const env = setup();
  const p = await planned(env, { pick_limit: 3, extra_max: 0 });
  assert.equal((await save(env, p.token, p.key, { upsert: hearts(keysN(3)) })).status, 200);
  await expectPickCap(await save(env, p.token, p.key, { upsert: hearts([A]) }), 3, 3, 0);
  assert.equal(starred(env), 3);
});

test('cap: pick_limit 0 with extra_max 0 allows no ♥ at all, but rating-0 rows are fine', async () => {
  const env = setup();
  const p = await planned(env, { pick_limit: 0, extra_max: 0 });
  await expectPickCap(await save(env, p.token, p.key, { upsert: hearts([A]) }), 0, 0, 0);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 0, note: '看看' }] })).status, 200);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections').n, 1);
});

test('cap: NULL pick_limit or NULL extra_max means no plan cap', async () => {
  for (const plan of [{ pick_limit: null, extra_max: 2 }, { pick_limit: 3, extra_max: null }, { pick_limit: null, extra_max: null }]) {
    const env = setup();
    const p = await planned(env, plan);
    const res = await save(env, p.token, p.key, { upsert: hearts(keysN(30)) });
    assert.equal(res.status, 200, JSON.stringify(plan));
    assert.equal(starred(env), 30);
  }
});

test('cap: a project from before the feature (extra_max NULL) behaves as it always did', async () => {
  const env = setup();
  const p = await planned(env, { pick_limit: 3 });
  env.DB._db.prepare('UPDATE projects SET extra_max = NULL WHERE id = ?').run(p.project.id);
  assert.equal((await save(env, p.token, p.key, { upsert: hearts(keysN(40)) })).status, 200);
  assert.equal(starred(env), 40);
});

test('cap: only ♥ counts — rating-0 rows are free, un-hearting at the cap works and frees a slot', async () => {
  const env = setup();
  const p = await planned(env, { pick_limit: 2, extra_max: 1 });
  assert.equal((await save(env, p.token, p.key, { upsert: hearts(keysN(3)) })).status, 200);
  // new rating-0 rows at the cap
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 0 }, { photo_key: B, rating: 0 }] })).status, 200);
  // re-rating one already ♥ at the cap
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: keysN(1)[0], rating: 5, note: 'n' }] })).status, 200);
  // re-hearting a rating-0 row is a new pick
  await expectPickCap(await save(env, p.token, p.key, { upsert: hearts([A]) }), 3, 2, 1);
  // un-heart one, then the other gets in
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: keysN(1)[0], rating: 0 }] })).status, 200);
  assert.equal(starred(env), 2);
  assert.equal((await save(env, p.token, p.key, { upsert: hearts([A]) })).status, 200);
  assert.equal(starred(env), 3);
  // a swap in one save nets out
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 0 }, { photo_key: B, rating: 1 }] })).status, 200);
  assert.equal(starred(env), 3);
  // a delete at the cap works and makes room
  assert.equal((await save(env, p.token, p.key, { delete: [B] })).status, 200);
  assert.equal((await save(env, p.token, p.key, { upsert: hearts([C]) })).status, 200);
  assert.equal(starred(env), 3);
});

test('cap: a project already over it (plan lowered later) may shrink or stay, not grow', async () => {
  const env = setup();
  const p = await planned(env, { pick_limit: 40, extra_max: 10 });
  seed(env, p.project.id, keysN(8));
  assert.equal((await patch(env, p.project.id, { pick_limit: 3, extra_max: 2 })).status, 200);
  // the picks stay
  assert.equal(starred(env), 8);
  // re-rate, un-heart, delete, swap
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: keysN(1)[0], rating: 4 }] })).status, 200);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: keysN(1, 1)[0], rating: 0 }] })).status, 200);
  assert.equal((await save(env, p.token, p.key, { delete: keysN(1, 2) })).status, 200);
  assert.equal(starred(env), 6);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: keysN(1, 3)[0], rating: 0 }, { photo_key: A, rating: 1 }] })).status, 200);
  assert.equal(starred(env), 6);
  // but not grow
  await expectPickCap(await save(env, p.token, p.key, { upsert: hearts([B]) }), 5, 3, 2);
  assert.equal(starred(env), 6);
});

test('cap: raising the plan by PATCH makes room at once', async () => {
  const env = setup();
  const p = await planned(env, { pick_limit: 1, extra_max: 0 });
  assert.equal((await save(env, p.token, p.key, { upsert: hearts([A]) })).status, 200);
  await expectPickCap(await save(env, p.token, p.key, { upsert: hearts([B]) }), 1, 1, 0);
  assert.equal((await patch(env, p.project.id, { extra_max: 1 })).status, 200);
  assert.equal((await save(env, p.token, p.key, { upsert: hearts([B]) })).status, 200);
  assert.equal((await patch(env, p.project.id, { pick_limit: null })).status, 200);
  assert.equal((await save(env, p.token, p.key, { upsert: hearts(keysN(20)) })).status, 200);
});

test('cap: two saves racing for the last slot — one wins, the other is 409 pick_cap and leaves nothing', async () => {
  const env = setup();
  const p = await planned(env, { pick_limit: 3, extra_max: 2 });
  seed(env, p.project.id, keysN(4));
  const [r1, r2] = await Promise.all([
    save(env, p.token, p.key, { upsert: hearts([A]) }),
    save(env, p.token, p.key, { upsert: hearts([B]) }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  await expectPickCap(r1.status === 409 ? r1 : r2, 5, 3, 2);
  assert.equal(starred(env), 5);
  assert.equal(rows(env, 'SELECT photo_key FROM selections WHERE photo_key IN (?, ?)', A, B).length, 1);
});

test('cap: ten saves racing for the last two slots — exactly two win', async () => {
  const env = setup();
  const p = await planned(env, { pick_limit: 3, extra_max: 2 });
  seed(env, p.project.id, keysN(3));
  const results = await Promise.all(keysN(10, 100).map(k => save(env, p.token, p.key, { upsert: hearts([k]) })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 409, 409, 409, 409, 409, 409, 409, 409]);
  for (const r of results.filter(r => r.status === 409)) await expectPickCap(r, 5, 3, 2);
  assert.equal(starred(env), 5);
});

test('cap: checked inside the write — a ♥ landing after every read still counts', async () => {
  const env = setup();
  const p = await planned(env, { pick_limit: 3, extra_max: 2 });
  seed(env, p.project.id, keysN(4));
  const prepare = env.DB.prepare.bind(env.DB);
  let done = false;
  env.DB.prepare = s => {
    if (!done && /^\s*UPDATE projects SET modified_after_submit/i.test(s)) { done = true; seed(env, p.project.id, ['20260819/late.jpg']); }
    return prepare(s);
  };
  await expectPickCap(await save(env, p.token, p.key, { upsert: hearts([A]) }), 5, 3, 2);
  assert.equal(starred(env), 5);
});

test('cap: a plan lowered after every read of the save still wins', async () => {
  const env = setup();
  const p = await planned(env, { pick_limit: 3, extra_max: 2 });
  seed(env, p.project.id, keysN(3));
  const prepare = env.DB.prepare.bind(env.DB);
  let done = false;
  env.DB.prepare = s => {
    if (!done && /^\s*UPDATE projects SET modified_after_submit/i.test(s)) {
      done = true;
      env.DB._db.prepare('UPDATE projects SET extra_max = 0 WHERE id = ?').run(p.project.id);
    }
    return prepare(s);
  };
  await expectPickCap(await save(env, p.token, p.key, { upsert: hearts([A]) }), 3, 3, 0);
  assert.equal(starred(env), 3);
});

test('cap: counts only this project, and the refusal names this project\'s plan', async () => {
  const env = setup();
  const p = await planned(env, { pick_limit: 1, extra_max: 0 });
  const q = await planned(env, { pick_limit: 1, extra_max: 0 });
  seed(env, p.project.id, keysN(5));
  assert.equal((await save(env, q.token, q.key, { upsert: hearts([A]) })).status, 200);
  await patch(env, q.project.id, { pick_limit: 2, extra_max: 1 });
  seed(env, q.project.id, keysN(2, 50));
  await expectPickCap(await save(env, q.token, q.key, { upsert: hearts([B]) }), 3, 2, 1);
  await expectPickCap(await save(env, p.token, p.key, { upsert: hearts([B]) }), 1, 1, 0);
});

test('cap: while submitted it still applies, and a refused save does not raise modified_after_submit', async () => {
  const env = setup();
  const p = await planned(env, { pick_limit: 1, extra_max: 1 });
  await save(env, p.token, p.key, { upsert: hearts([A, B]) });
  assert.equal((await pick(env, 'POST', 'submit', p.token, { key: p.key, body: { relationship: '本人' } })).status, 200);
  await expectPickCap(await save(env, p.token, p.key, { upsert: hearts([C]) }), 2, 1, 1);
  assert.equal(projectRow(env, p.project.id).modified_after_submit, 0);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 0 }] })).status, 200);
  assert.equal(projectRow(env, p.project.id).modified_after_submit, 1);
});

// ─── which code wins ─────────────────────────────────────────────────────────

test('codes: a viewer is 403 and retouching is 409 retouching before pick_cap', async () => {
  const env = setup();
  const p = await planned(env, { pick_limit: 0, extra_max: 0 });
  assert.equal((await save(env, p.token, 'wrong', { upsert: hearts([A]) })).status, 403);
  assert.equal((await save(env, p.token, undefined, { upsert: hearts([A]) })).status, 403);
  env.DB._db.prepare("UPDATE projects SET phase = 'retouching' WHERE id = ?").run(p.project.id);
  const res = await save(env, p.token, p.key, { upsert: hearts([A]) });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'retouching');
});

test('codes: row_cap wins over pick_cap', async () => {
  const env = setup();
  const p = await planned(env, { pick_limit: 0, extra_max: 0 });
  seed(env, p.project.id, keysN(1000), 0);
  const res = await save(env, p.token, p.key, { upsert: hearts([A]) });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'row_cap');
});

test('codes: pick_cap wins over selection_cap when the plan allows at most 500', async () => {
  const env = setup();
  const p = await planned(env, { pick_limit: 3, extra_max: 2 });
  seed(env, p.project.id, keysN(500));
  await expectPickCap(await save(env, p.token, p.key, { upsert: hearts([A]) }), 5, 3, 2);
  // plan exactly 500: still pick_cap
  env.DB._db.prepare('UPDATE projects SET pick_limit = 490, extra_max = 10 WHERE id = ?').run(p.project.id);
  await expectPickCap(await save(env, p.token, p.key, { upsert: hearts([A]) }), 500, 490, 10);
});

test('codes: selection_cap when the plan allows more than 500 (the smaller limit is the one reported)', async () => {
  const env = setup();
  const p = await planned(env, { pick_limit: 495, extra_max: 10 });
  seed(env, p.project.id, keysN(500));
  // 510 breaks both 500 and 505: selection_cap, the tighter one
  let res = await save(env, p.token, p.key, { upsert: hearts(keysN(10, 1000)) });
  assert.equal(res.status, 409);
  let json = await res.json();
  assert.equal(json.code, 'selection_cap');
  assert.equal(json.max, 500);
  // 501 breaks only the system cap
  res = await save(env, p.token, p.key, { upsert: hearts([A]) });
  json = await res.json();
  assert.equal(json.code, 'selection_cap');
});

test('codes: pick_cap wins over marks_cap; marks_cap still shows when the plan fits', async () => {
  const env = setup();
  const p = await planned(env, { pick_limit: 30, extra_max: 0 });
  // 30 ♥ photos with 10 pins each = the 300-pin cap
  const pins = Array.from({ length: 10 }, (_, i) => ({ x: i / 10, y: 0.5, note: '' }));
  const ins = env.DB._db.prepare(
    "INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at, marks) VALUES (?, ?, 1, '', 'seed', 'seeded', ?)");
  for (const k of keysN(30)) ins.run(p.project.id, k, JSON.stringify(pins));
  // a new ♥ with a pin breaks both the plan (31 > 30) and the pins (301 > 300)
  await expectPickCap(await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [pins[0]] }] }), 30, 30, 0);
  // a pin on a photo already ♥ breaks only the pins
  const res = await save(env, p.token, p.key, { upsert: [{ photo_key: keysN(1)[0], rating: 1, marks: [...pins.slice(0, 9), pins[0]] }, { photo_key: keysN(1, 1)[0], rating: 0 }] });
  assert.equal(res.status, 200, 'net fewer pins and fewer ♥ is fine');
  env.DB._db.prepare('UPDATE projects SET extra_max = 5 WHERE id = ?').run(p.project.id);
  const refill = await save(env, p.token, p.key, { upsert: [{ photo_key: keysN(1, 1)[0], rating: 1, marks: pins }, { photo_key: A, rating: 1, marks: [pins[0]] }] });
  assert.equal(refill.status, 409);
  assert.equal((await refill.json()).code, 'marks_cap');
});

// ─── before the migration ────────────────────────────────────────────────────

test('before the migration: create, save, un-heart, pins, submit, state, list and detail all work, with no plan cap', async () => {
  const env = preMigrationEnv();
  await putSettings(env, { default_pick_limit: 3 });
  const res = await post(env, { folders: [MINE], pick_limit: 3, extra_price: 100 });
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.project.extra_max, null);
  // an explicit value has nowhere to go: the project is still made, uncapped
  const res2 = await post(env, { folders: [MINE], pick_limit: 3, extra_max: 2 });
  assert.equal(res2.status, 201);
  assert.equal((await res2.json()).project.extra_max, null);
  const c = await pick(env, 'POST', 'claim', created.token, { body: { name: '王' } });
  const key = (await c.json()).picker_key;
  assert.equal((await save(env, created.token, key, { upsert: hearts(keysN(20)) })).status, 200);
  assert.equal((await save(env, created.token, key, { upsert: [{ photo_key: keysN(1)[0], rating: 0 }] })).status, 200);
  assert.equal((await save(env, created.token, key, { upsert: [{ photo_key: A, rating: 1, marks: [{ x: 0.5, y: 0.5, note: '' }] }] })).status, 200);
  assert.equal((await pick(env, 'POST', 'submit', created.token, { key, body: { relationship: '本人' } })).status, 200);
  const st = await state(env, created.token, key);
  assert.equal(st.project.extra_max, null);
  assert.equal(st.project.max_picks, null);
  const viewer = await state(env, created.token);
  assert.equal(viewer.project.extra_max, null);
  assert.equal(viewer.project.max_picks, null);
  assert.equal((await detail(env, created.project.id)).project.extra_max, null);
  const l = await list(env);
  assert.equal(l.projects.length, 2);
  assert.equal(l.projects[0].extra_max, null);
});

// ─── pick state ──────────────────────────────────────────────────────────────

test('state: owner and viewer both get extra_max and max_picks', async () => {
  const env = setup();
  const p = await planned(env, { pick_limit: 40, extra_price: 200, extra_max: 10 });
  for (const key of [p.key, undefined, 'wrong']) {
    const st = await state(env, p.token, key);
    assert.deepEqual(st.project, { id: p.project.id, title: '王先生 婚紗', pick_limit: 40, extra_price: 200, extra_max: 10, max_picks: 50 });
  }
  await patch(env, p.project.id, { extra_max: 0 });
  assert.equal((await state(env, p.token, p.key)).project.max_picks, 40);
  await patch(env, p.project.id, { extra_max: null });
  let st = await state(env, p.token, p.key);
  assert.deepEqual([st.project.extra_max, st.project.max_picks], [null, null]);
  await patch(env, p.project.id, { extra_max: 5, pick_limit: null });
  st = await state(env, p.token);
  assert.deepEqual([st.project.pick_limit, st.project.extra_max, st.project.max_picks], [null, 5, null]);
});

test('state: max_picks is the number the save enforces', async () => {
  const env = setup();
  const p = await planned(env, { pick_limit: 2, extra_max: 3 });
  const { max_picks } = (await state(env, p.token, p.key)).project;
  assert.equal((await save(env, p.token, p.key, { upsert: hearts(keysN(max_picks)) })).status, 200);
  await expectPickCap(await save(env, p.token, p.key, { upsert: hearts([A]) }), max_picks, 2, 3);
});

