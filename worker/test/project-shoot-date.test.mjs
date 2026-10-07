// projects.shoot_date (docs/delivery.md, "Shoot date"): the day of the shoot,
// for the completion page (完成頁). Set by the photographer on create and by
// PATCH /api/admin/projects/:id, strictly 'YYYY-MM-DD' (a real calendar day,
// 1900–2100); '' or null clears it. The admin list and detail return it; a
// guest sees it only in /api/pick/state once the project is delivered AND
// confirmed — never earlier. users.shoot_date is the client account's own
// registration answer (may be '未定') and is not this. Its own hand-run
// migration; before it nothing that worked breaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fakeBucket, fakeDB } from './fakes.mjs';
import { SECRET, call, pick, claim, save, one, rows, collectingCtx } from './pick-helpers.mjs';

const PROOF = 'shoot/毛片/';
const FINAL = 'shoot/精修/';
const PA = 'shoot/毛片/a.jpg';
const OBJECTS = { [PA]: 'PROOF-A', 'shoot/精修/f1.jpg': 'FINAL-A' };

const FRESH = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const MIGRATION_FILE = new URL('../migrations/2026-10-07-project-shoot-date.sql', import.meta.url);
// today's deployed database: everything up to the revision pins, no shoot_date
// (nor project_type, appended after it by its own migration)
const BEFORE = FRESH.replace(/(client_confirmed_by\s+TEXT),\n(?:\s*--[^\n]*\n)*\s*shoot_date\s+TEXT,\n(?:\s*--[^\n]*\n)*\s*project_type\s+TEXT\n\);/, '$1\n);');

function setup({ schema } = {}) {
  return { imagepicker: fakeBucket(OBJECTS), DB: fakeDB(schema ? { schema } : {}), PHOTOGRAPHER_TOKEN: SECRET };
}
const create = (env, body = {}) => call(env, '/api/admin/projects', {
  method: 'POST', token: SECRET, body: { title: '王先生 婚紗', folders: [PROOF], pick_limit: 1, extra_max: null, ...body },
});
async function created(env, body) {
  const res = await create(env, body);
  assert.equal(res.status, 201, await res.clone().text());
  return res.json();
}
const patch = (env, id, body, token = SECRET) => call(env, `/api/admin/projects/${id}`, { method: 'PATCH', token, body });
const admin = (env, id, action, body) => call(env, `/api/admin/projects/${id}/${action}`, { method: 'POST', token: SECRET, body });
const detail = async (env, id) => (await call(env, `/api/admin/projects/${id}`, { token: SECRET })).json();
const listRow = async (env, id) => (await (await call(env, '/api/admin/projects', { token: SECRET })).json()).projects.find(r => r.id === id);
const stored = (env, id) => one(env, 'SELECT shoot_date FROM projects WHERE id = ?', id).shoot_date;
const state = async (env, t, key) => {
  const res = await pick(env, 'GET', 'state', t, { key });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
};
const snapshot = env => JSON.stringify(['projects', 'share_tokens'].map(t => rows(env, `SELECT * FROM ${t} ORDER BY rowid`)));

// a project with its seat taken and submitted, then in retouching
async function retouching(env, body) {
  const p = await created(env, body);
  const c = await claim(env, p.token);
  assert.equal(c.res.status, 200);
  assert.equal((await save(env, p.token, c.key, { upsert: [{ photo_key: PA, rating: 1 }] })).status, 200);
  const ctx = collectingCtx();
  assert.equal((await pick(env, 'POST', 'submit', p.token, { key: c.key, body: { relationship: '本人' } }, ctx)).status, 200);
  await ctx.settle();
  assert.equal((await admin(env, p.project.id, 'start-retouch')).status, 200);
  return { ...p, key: c.key, id: p.project.id };
}
const deliver = async (env, id) => assert.equal((await admin(env, id, 'deliver', { final_folders: [FINAL] })).status, 200);
const confirm = async (env, p) => assert.equal((await pick(env, 'POST', 'confirm', p.token, { key: p.key })).status, 200);

// ─── the migration ──────────────────────────────────────────────────────────

test('migration: one ALTER adding projects.shoot_date TEXT; schema.sql notes it; the fixture really lacks it', () => {
  assert.ok(existsSync(MIGRATION_FILE));
  const sql = readFileSync(MIGRATION_FILE, 'utf8');
  const statements = sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
  assert.deepEqual(statements, ['ALTER TABLE projects ADD COLUMN shoot_date TEXT']);
  assert.match(sql, /duplicate column/i);
  assert.match(sql, /D1 Console/);
  assert.match(sql, /shoot_date_unavailable/);
  assert.ok(FRESH.includes('2026-10-07-project-shoot-date.sql'));
  assert.ok(FRESH.includes('ALTER TABLE projects ADD COLUMN shoot_date TEXT;'));
  assert.notEqual(BEFORE, FRESH, 'fixture regex matched');
  const shape = db => db._db.prepare('PRAGMA table_info(projects)').all();
  assert.ok(!shape(fakeDB({ schema: BEFORE })).some(c => c.name === 'shoot_date'));
  assert.ok(shape(fakeDB({ schema: BEFORE })).some(c => c.name === 'client_confirmed_by'));
  // project_type comes back from its own migration on top, so the column order is pinned
  const typeSql = readFileSync(new URL('../migrations/2026-10-07-project-type.sql', import.meta.url), 'utf8');
  assert.deepEqual(shape(fakeDB({ schema: BEFORE + '\n' + sql + '\n' + typeSql })), shape(fakeDB()));
  const twice = fakeDB({ schema: BEFORE + '\n' + sql });
  assert.throws(() => twice._db.exec(sql), /duplicate column/);
});

// ─── photographer writes and reads ──────────────────────────────────────────

test('create: shoot_date is stored and returned by create, detail and list; left out, null or "" = null', async () => {
  const env = setup();
  const p = await created(env, { shoot_date: '2026-09-19' });
  assert.equal(p.project.shoot_date, '2026-09-19');
  assert.equal(stored(env, p.project.id), '2026-09-19');
  assert.equal((await detail(env, p.project.id)).project.shoot_date, '2026-09-19');
  assert.equal((await listRow(env, p.project.id)).shoot_date, '2026-09-19');
  for (const body of [{}, { shoot_date: null }, { shoot_date: '' }]) {
    const q = await created(env, body);
    assert.ok(Object.hasOwn(q.project, 'shoot_date'), JSON.stringify(body));
    assert.equal(q.project.shoot_date, null, JSON.stringify(body));
    assert.equal(stored(env, q.project.id), null);
    const d = (await detail(env, q.project.id)).project;
    assert.ok(Object.hasOwn(d, 'shoot_date'));
    assert.equal(d.shoot_date, null);
    const r = await listRow(env, q.project.id);
    assert.ok(Object.hasOwn(r, 'shoot_date'));
    assert.equal(r.shoot_date, null);
  }
  // edges of the calendar
  for (const v of ['2028-02-29', '1900-01-01', '2100-12-31', '2026-12-31', '2026-01-01']) {
    assert.equal((await created(env, { shoot_date: v })).project.shoot_date, v, v);
  }
});

const BAD_DATES = [
  '2026-02-30', '2027-02-29', '2026-13-01', '2026-00-10', '2026-04-31', '2026-09-00', '2026-09-32',
  '2026-9-19', '2026-09-9', '26-09-19', ' 2026-09-19', '2026-09-19 ', '2026-09-19T00:00', '2026/09/19',
  '1899-12-31', '2101-01-01', '+02026-09-19', '２０２６-09-19', '2026-09-19\n', '未定',
  20260919, 0, true, false, [], {}, ['2026-09-19'],
];

test('create: a bad shoot_date is 400 invalid_shoot_date, nothing written (no project, no link)', async () => {
  const env = setup();
  const before = snapshot(env);
  for (const v of BAD_DATES) {
    const res = await create(env, { shoot_date: v });
    const text = await res.text();
    assert.equal(res.status, 400, `${JSON.stringify(v)}: ${text}`);
    assert.equal(JSON.parse(text).code, 'invalid_shoot_date', JSON.stringify(v));
  }
  assert.equal(snapshot(env), before);
});

test('PATCH: shoot_date sets, changes and clears ("" and null); the response echoes the stored value', async () => {
  const env = setup();
  const p = await created(env);
  const id = p.project.id;
  const ok = async (body, expect) => {
    const res = await patch(env, id, body);
    assert.equal(res.status, 200, await res.clone().text());
    const json = await res.json();
    assert.equal(json.shoot_date, expect, JSON.stringify(body));
    assert.equal(stored(env, id), expect);
    assert.equal((await detail(env, id)).project.shoot_date, expect);
    assert.equal((await listRow(env, id)).shoot_date, expect);
  };
  await ok({ shoot_date: '2026-09-19' }, '2026-09-19');
  await ok({ shoot_date: '2026-10-01' }, '2026-10-01');
  await ok({ shoot_date: '' }, null);
  await ok({ shoot_date: '2026-10-02' }, '2026-10-02');
  await ok({ shoot_date: null }, null);
  // with other keys in the same body
  const res = await patch(env, id, { shoot_date: '2026-10-03', pick_limit: 5 });
  assert.equal(res.status, 200);
  assert.equal(stored(env, id), '2026-10-03');
  assert.equal(one(env, 'SELECT pick_limit FROM projects WHERE id = ?', id).pick_limit, 5);
  // a PATCH without it keeps it
  assert.equal((await patch(env, id, { allow_proof_download: true })).status, 200);
  assert.equal(stored(env, id), '2026-10-03');
});

test('PATCH: a bad shoot_date refuses the whole body (400 invalid_body), nothing written; 401 / 404 as before', async () => {
  const env = setup();
  const p = await created(env, { shoot_date: '2026-09-19' });
  const id = p.project.id;
  const before = snapshot(env);
  for (const v of BAD_DATES) {
    const res = await patch(env, id, { shoot_date: v, pick_limit: 9 });
    assert.equal(res.status, 400, JSON.stringify(v));
    assert.equal((await res.json()).code, 'invalid_body', JSON.stringify(v));
  }
  assert.equal((await patch(env, id, { shoot_date: '2026-09-20' }, 'wrong')).status, 401);
  assert.equal((await patch(env, 'nope', { shoot_date: '2026-09-20' })).status, 404);
  assert.equal(snapshot(env), before);
});

test('PATCH: shoot_date is not a plan edit — an archived project still takes it (the plan still 409s)', async () => {
  const env = setup();
  const p = await created(env);
  assert.equal((await admin(env, p.project.id, 'archive')).status, 200);
  const res = await patch(env, p.project.id, { shoot_date: '2026-09-19' });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(stored(env, p.project.id), '2026-09-19');
  assert.equal((await patch(env, p.project.id, { shoot_date: '2026-09-20', pick_limit: 3 })).status, 409, 'a plan key alongside still refuses');
  assert.equal(stored(env, p.project.id), '2026-09-19');
});

// ─── the guest: only on the completion page ─────────────────────────────────

test('guest state: shoot_date only once delivered AND confirmed — null while picking, retouching, delivered-unconfirmed, after undeliver / reopen / re-deliver', async () => {
  const env = setup();
  const p = await retouching(env, { shoot_date: '2026-09-19' });
  const both = async expect => {
    for (const key of [p.key, undefined]) {
      const s = await state(env, p.token, key);
      assert.ok(Object.hasOwn(s, 'shoot_date'), 'the key is always there');
      assert.equal(s.shoot_date, expect, `${key ? 'owner' : 'viewer'} expects ${expect}`);
    }
  };
  await both(null);                        // retouching
  await deliver(env, p.id);
  assert.equal((await state(env, p.token, p.key)).mode, 'delivered');
  await both(null);                        // delivered, not confirmed
  await confirm(env, p);
  await both('2026-09-19');                // the completion page
  // the photographer edits it: the page shows the new day
  assert.equal((await patch(env, p.id, { shoot_date: '2026-09-20' })).status, 200);
  await both('2026-09-20');
  assert.equal((await patch(env, p.id, { shoot_date: '' })).status, 200);
  await both(null);
  assert.equal((await patch(env, p.id, { shoot_date: '2026-09-21' })).status, 200);
  await both('2026-09-21');
  // a re-deliver clears the confirmation: gone again
  await deliver(env, p.id);
  await both(null);
  await confirm(env, p);
  await both('2026-09-21');
  // undeliver
  assert.equal((await admin(env, p.id, 'undeliver')).status, 200);
  await both(null);
  // reopen after a confirmed delivery
  await deliver(env, p.id);
  await confirm(env, p);
  await both('2026-09-21');
  assert.equal((await admin(env, p.id, 'reopen')).status, 200);
  await both(null);
});

test('guest state: confirmed by the photographer counts too; a project without a date shows null', async () => {
  const env = setup();
  const p = await retouching(env, { shoot_date: '2026-09-19' });
  await deliver(env, p.id);
  assert.equal((await admin(env, p.id, 'confirm')).status, 200);
  assert.equal((await state(env, p.token)).shoot_date, '2026-09-19');
  const q = await retouching(env);
  await deliver(env, q.id);
  await confirm(env, q);
  const s = await state(env, q.token, q.key);
  assert.ok(s.confirmed_at, 'positive: really confirmed');
  assert.equal(s.shoot_date, null);
});

test('guest state: a stored confirmation while not delivered (a hand edit) never shows the date', async () => {
  const env = setup();
  const p = await retouching(env, { shoot_date: '2026-09-19' });
  env.DB._db.prepare("UPDATE projects SET client_confirmed_at = '2026-10-01T00:00:00Z' WHERE id = ?").run(p.id);
  assert.equal((await state(env, p.token, p.key)).shoot_date, null);
});

test('no other guest route carries shoot_date', async () => {
  const env = setup();
  const p = await retouching(env, { shoot_date: '2026-09-19' });
  await deliver(env, p.id);
  await confirm(env, p);
  for (const route of ['shop', 'rounds']) {
    const res = await pick(env, 'GET', route, p.token, { key: p.key });
    assert.equal(res.status, 200, route);
    assert.ok(!(await res.text()).includes('2026-09-19'), route);
  }
  const list = await call(env, `/?list=${encodeURIComponent(FINAL)}&t=${encodeURIComponent(p.token)}`);
  const text = await list.text();
  assert.equal(list.status, 200, text);
  assert.match(text, /f1\.jpg/, 'positive: the list answered');
  assert.ok(!text.includes('2026-09-19'), 'list');
});

// ─── before the migration ───────────────────────────────────────────────────

test('before the migration: create without a date, list, detail, PATCH of other keys and the guest state all work, shoot_date null', async () => {
  const env = setup({ schema: BEFORE });
  for (const body of [{}, { shoot_date: null }, { shoot_date: '' }]) {
    const q = await created(env, body);
    assert.equal(q.project.shoot_date, null);
  }
  const p = await retouching(env);
  await deliver(env, p.id);
  await confirm(env, p);
  const row = await listRow(env, p.id);
  assert.equal(row.shoot_date, null);
  assert.ok(row.client_confirmed_at, 'the list kept the confirmation (no over-eager fallback)');
  assert.equal(row.open_revision_count, 0);
  assert.equal(row.extra_max, null);
  assert.deepEqual(row.final_folders, [FINAL]);
  const d = (await detail(env, p.id)).project;
  assert.ok(Object.hasOwn(d, 'shoot_date'));
  assert.equal(d.shoot_date, null);
  assert.equal((await patch(env, p.id, { allow_proof_download: true })).status, 200);
  const s = await state(env, p.token, p.key);
  assert.ok(s.confirmed_at);
  assert.ok(Object.hasOwn(s, 'shoot_date'));
  assert.equal(s.shoot_date, null);
});

test('before the migration: setting a date is 500 shoot_date_unavailable with nothing written', async () => {
  const env = setup({ schema: BEFORE });
  const p = await created(env);
  const before = snapshot(env);
  for (const extra of [{}, { extra_max: 5 }]) {
    const res = await create(env, { shoot_date: '2026-09-19', ...extra });
    assert.equal(res.status, 500, await res.clone().text());
    assert.equal((await res.json()).code, 'shoot_date_unavailable');
  }
  for (const body of [{ shoot_date: '2026-09-19' }, { shoot_date: null }, { shoot_date: '2026-09-19', pick_limit: 3 }]) {
    const res = await patch(env, p.project.id, body);
    assert.equal(res.status, 500, JSON.stringify(body));
    assert.equal((await res.json()).code, 'shoot_date_unavailable', JSON.stringify(body));
  }
  assert.equal(snapshot(env), before);
  // a bad value is still 400 first
  assert.equal((await create(env, { shoot_date: '2026-02-30' })).status, 400);
  assert.equal((await patch(env, p.project.id, { shoot_date: 'x' })).status, 400);
});

test('a database also missing extra_max: a create with a date is still 500 shoot_date_unavailable, nothing written', async () => {
  const schema = BEFORE.replace(/(allow_proof_download INTEGER NOT NULL DEFAULT 0),\n(?:\s*--[^\n]*\n)*\s*extra_max\s+INTEGER,/, '$1,');
  assert.notEqual(schema, BEFORE, 'fixture regex matched');
  const env = setup({ schema });
  const before = snapshot(env);
  const res = await create(env, { shoot_date: '2026-09-19' });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).code, 'shoot_date_unavailable');
  assert.equal(snapshot(env), before);
  // positive: without a date it is made
  assert.equal((await create(env, {})).status, 201);
});

test('a migrated database lists projects in one query (no fallback retry)', async () => {
  const env = setup();
  await created(env, { shoot_date: '2026-09-19' });
  const n = env.DB._sql.length;
  assert.equal((await call(env, '/api/admin/projects', { token: SECRET })).status, 200);
  const listQueries = env.DB._sql.slice(n).filter(s => /FROM projects p\s/.test(s));
  assert.equal(listQueries.length, 1, 'one list statement');
  assert.match(listQueries[0], /p\.shoot_date/);
});
