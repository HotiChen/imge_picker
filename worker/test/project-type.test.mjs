// projects.project_type (docs/delivery.md, "Project type"): the photography
// category of a PROJECT (婚紗 / 婚禮 / 親子 …), set by the photographer on
// create and by PATCH /api/admin/projects/:id. The categories are the ones
// js/shoot-types.js draws; 其他 lets the photographer type their own, so the
// column holds a trimmed plain string of at most 20 characters (no control,
// line-separator, bidi or BOM character); '' or null clears it. The admin list
// and detail always carry it; NO guest route ever does. users.shoot_type is
// the client account's own registration answer and is not this. Its own
// hand-run migration; before it nothing that worked breaks.
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
const MIGRATION_FILE = new URL('../migrations/2026-10-07-project-type.sql', import.meta.url);
// today's deployed database: everything up to shoot_date, no project_type
const BEFORE = FRESH.replace(/(shoot_date\s+TEXT),\n(?:\s*--[^\n]*\n)*\s*project_type\s+TEXT\n\);/, '$1\n);');
// the list the photographer picks from (js/shoot-types.js, shared with admin.html)
const SHOOT_TYPES_SRC = readFileSync(new URL('../../js/shoot-types.js', import.meta.url), 'utf8');
const UI_TYPES = JSON.parse(/const SHOOT_TYPES = (\[[^\]]*\]);/.exec(SHOOT_TYPES_SRC)[1].replace(/'/g, '"'));

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
const stored = (env, id) => one(env, 'SELECT project_type FROM projects WHERE id = ?', id).project_type;
const snapshot = env => JSON.stringify(['projects', 'share_tokens'].map(t => rows(env, `SELECT * FROM ${t} ORDER BY rowid`)));

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

test('migration: one ALTER adding projects.project_type TEXT; schema.sql notes it; the fixture really lacks it', () => {
  assert.ok(existsSync(MIGRATION_FILE));
  const sql = readFileSync(MIGRATION_FILE, 'utf8');
  const statements = sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
  assert.deepEqual(statements, ['ALTER TABLE projects ADD COLUMN project_type TEXT']);
  assert.match(sql, /duplicate column/i);
  assert.match(sql, /D1 Console/);
  assert.match(sql, /project_type_unavailable/);
  assert.ok(FRESH.includes('2026-10-07-project-type.sql'));
  assert.ok(FRESH.includes('ALTER TABLE projects ADD COLUMN project_type TEXT;'));
  assert.notEqual(BEFORE, FRESH, 'fixture regex matched');
  const shape = db => db._db.prepare('PRAGMA table_info(projects)').all();
  assert.ok(!shape(fakeDB({ schema: BEFORE })).some(c => c.name === 'project_type'));
  assert.ok(shape(fakeDB({ schema: BEFORE })).some(c => c.name === 'shoot_date'));
  assert.deepEqual(shape(fakeDB({ schema: BEFORE + '\n' + sql })), shape(fakeDB()));
  const twice = fakeDB({ schema: BEFORE + '\n' + sql });
  assert.throws(() => twice._db.exec(sql), /duplicate column/);
});

// ─── photographer writes and reads ──────────────────────────────────────────

test('the UI list is the one this test reads (js/shoot-types.js), and every entry is accepted as is', async () => {
  assert.deepEqual(UI_TYPES, ['婚紗', '婚禮', '親子', '個人', '活動', '其他']);
  const env = setup();
  for (const t of UI_TYPES) {
    const p = await created(env, { project_type: t });
    assert.equal(p.project.project_type, t, t);
    assert.equal(stored(env, p.project.id), t);
  }
});

test('create: project_type is stored and returned by create, detail and list; left out, null, "" or blank = null', async () => {
  const env = setup();
  const p = await created(env, { project_type: '婚紗' });
  assert.equal(p.project.project_type, '婚紗');
  assert.equal(stored(env, p.project.id), '婚紗');
  assert.equal((await detail(env, p.project.id)).project.project_type, '婚紗');
  assert.equal((await listRow(env, p.project.id)).project_type, '婚紗');
  for (const body of [{}, { project_type: null }, { project_type: '' }, { project_type: '   ' }]) {
    const q = await created(env, body);
    assert.ok(Object.hasOwn(q.project, 'project_type'), JSON.stringify(body));
    assert.equal(q.project.project_type, null, JSON.stringify(body));
    assert.equal(stored(env, q.project.id), null);
    const d = (await detail(env, q.project.id)).project;
    assert.ok(Object.hasOwn(d, 'project_type'));
    assert.equal(d.project_type, null);
    const r = await listRow(env, q.project.id);
    assert.ok(Object.hasOwn(r, 'project_type'));
    assert.equal(r.project_type, null);
  }
});

// typed under 其他: stored trimmed
const GOOD_TYPED = [
  ['寵物', '寵物'],
  ['  孕婦寫真 ', '孕婦寫真'],
  ['商業 / 產品', '商業 / 產品'],
  ['O\'Brien & co', 'O\'Brien & co'],
  ['一二三四五六七八九十一二三四五六七八九十', '一二三四五六七八九十一二三四五六七八九十'], // 20 chars
  [' 一二三四五六七八九十一二三四五六七八九十 ', '一二三四五六七八九十一二三四五六七八九十'], // 20 after the trim
  ['😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀', '😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀'], // 20 code points, 40 UTF-16 units
];

test('create: a type typed under 其他 is stored trimmed, up to 20 characters', async () => {
  const env = setup();
  for (const [v, expect] of GOOD_TYPED) {
    const p = await created(env, { project_type: v });
    assert.equal(p.project.project_type, expect, JSON.stringify(v));
    assert.equal(stored(env, p.project.id), expect, JSON.stringify(v));
  }
});

const BAD_TYPES = [
  '一二三四五六七八九十一二三四五六七八九十一', // 21
  'a'.repeat(200),
  '婚\u0000紗', '婚\u0007紗', '婚\n紗', '婚\r紗', '婚\t紗', '婚\u007f紗', '婚\u0085紗', '婚\u009f紗',
  '婚 紗', '婚 紗',
  '婚‎紗', '婚‏紗', '婚‪紗', '婚‮紗', '婚⁦紗', '婚⁩紗', '婚؜紗', '婚﻿紗',
  '婚\ud800紗',
  1, 0, true, false, [], {}, ['婚紗'], { v: '婚紗' },
];

test('create: a bad project_type is 400 invalid_project_type, nothing written (no project, no link)', async () => {
  const env = setup();
  const before = snapshot(env);
  for (const v of BAD_TYPES) {
    const res = await create(env, { project_type: v });
    const text = await res.text();
    assert.equal(res.status, 400, `${JSON.stringify(v)}: ${text}`);
    assert.equal(JSON.parse(text).code, 'invalid_project_type', JSON.stringify(v));
  }
  assert.equal(snapshot(env), before);
});

test('PATCH: project_type sets, changes and clears ("", blank and null); the response echoes the stored value', async () => {
  const env = setup();
  const p = await created(env);
  const id = p.project.id;
  const ok = async (body, expect) => {
    const res = await patch(env, id, body);
    assert.equal(res.status, 200, await res.clone().text());
    const json = await res.json();
    assert.ok(Object.hasOwn(json, 'project_type'));
    assert.equal(json.project_type, expect, JSON.stringify(body));
    assert.equal(stored(env, id), expect);
    assert.equal((await detail(env, id)).project.project_type, expect);
    assert.equal((await listRow(env, id)).project_type, expect);
  };
  await ok({ project_type: '婚禮' }, '婚禮');
  await ok({ project_type: ' 寵物 ' }, '寵物');
  await ok({ project_type: '' }, null);
  await ok({ project_type: '親子' }, '親子');
  await ok({ project_type: null }, null);
  await ok({ project_type: '活動' }, '活動');
  await ok({ project_type: '  ' }, null);
  // with other keys in the same body, shoot_date included
  const res = await patch(env, id, { project_type: '個人', pick_limit: 5, shoot_date: '2026-09-19' });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(stored(env, id), '個人');
  assert.equal(one(env, 'SELECT pick_limit, shoot_date FROM projects WHERE id = ?', id).pick_limit, 5);
  assert.equal(one(env, 'SELECT shoot_date FROM projects WHERE id = ?', id).shoot_date, '2026-09-19');
  // a PATCH without it keeps it
  assert.equal((await patch(env, id, { allow_proof_download: true })).status, 200);
  assert.equal((await patch(env, id, { shoot_date: '' })).status, 200);
  assert.equal(stored(env, id), '個人');
});

test('PATCH: a bad project_type refuses the whole body (400 invalid_body), nothing written; 401 / 404 as before', async () => {
  const env = setup();
  const p = await created(env, { project_type: '婚紗' });
  const id = p.project.id;
  const before = snapshot(env);
  for (const v of BAD_TYPES) {
    const res = await patch(env, id, { project_type: v, pick_limit: 9 });
    assert.equal(res.status, 400, JSON.stringify(v));
    assert.equal((await res.json()).code, 'invalid_body', JSON.stringify(v));
  }
  assert.equal((await patch(env, id, { project_type: '婚禮' }, 'wrong')).status, 401);
  assert.equal((await patch(env, 'nope', { project_type: '婚禮' })).status, 404);
  assert.equal(snapshot(env), before);
});

test('PATCH: project_type is not a plan edit — an archived project still takes it (the plan still 409s)', async () => {
  const env = setup();
  const p = await created(env);
  assert.equal((await admin(env, p.project.id, 'archive')).status, 200);
  const res = await patch(env, p.project.id, { project_type: '婚紗' });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(stored(env, p.project.id), '婚紗');
  assert.equal((await patch(env, p.project.id, { project_type: '婚禮', shoot_date: '2026-09-19' })).status, 200, 'with the other non-plan key');
  assert.equal(stored(env, p.project.id), '婚禮');
  assert.equal((await patch(env, p.project.id, { project_type: '親子', pick_limit: 3 })).status, 409, 'a plan key alongside still refuses');
  assert.equal(stored(env, p.project.id), '婚禮');
});

// ─── the guest: never ───────────────────────────────────────────────────────

const MARK = '獨特類型X';

test('no guest route carries project_type: state (owner and viewer, every phase incl. the completion page), shop, rounds, ?list=', async () => {
  const env = setup();
  const p = await retouching(env, { project_type: MARK, shoot_date: '2026-09-19' });
  const clean = async (label, res) => {
    const text = await res.text();
    assert.equal(res.status, 200, `${label}: ${text}`);
    assert.ok(!text.includes(MARK), label);
    assert.ok(!text.includes('project_type'), label);
    return text;
  };
  const states = async phase => {
    for (const key of [p.key, undefined]) await clean(`state ${phase} ${key ? 'owner' : 'viewer'}`, await pick(env, 'GET', 'state', p.token, { key }));
  };
  await states('retouching');
  await deliver(env, p.id);
  await states('delivered');
  await confirm(env, p);
  const s = JSON.parse(await clean('state confirmed', await pick(env, 'GET', 'state', p.token, { key: p.key })));
  assert.equal(s.shoot_date, '2026-09-19', 'positive: the completion page is up and does carry the shoot date');
  await states('confirmed');
  for (const route of ['shop', 'rounds']) await clean(route, await pick(env, 'GET', route, p.token, { key: p.key }));
  const listText = await clean('list', await call(env, `/?list=${encodeURIComponent(FINAL)}&t=${encodeURIComponent(p.token)}`));
  assert.match(listText, /f1\.jpg/, 'positive: the list answered');
  // and the photographer does see it on the same project
  assert.equal((await detail(env, p.id)).project.project_type, MARK);
});

// ─── before the migration ───────────────────────────────────────────────────

test('before the migration: create without a type, list, detail, PATCH of other keys and the guest state all work, project_type null', async () => {
  const env = setup({ schema: BEFORE });
  for (const body of [{}, { project_type: null }, { project_type: '' }, { project_type: ' ' }]) {
    const q = await created(env, body);
    assert.equal(q.project.project_type, null);
  }
  const p = await retouching(env, { shoot_date: '2026-09-19' });
  await deliver(env, p.id);
  await confirm(env, p);
  const row = await listRow(env, p.id);
  assert.ok(Object.hasOwn(row, 'project_type'));
  assert.equal(row.project_type, null);
  assert.equal(row.shoot_date, '2026-09-19', 'the list kept shoot_date (no over-eager fallback)');
  assert.ok(row.client_confirmed_at, 'the list kept the confirmation');
  assert.equal(row.open_revision_count, 0);
  assert.deepEqual(row.final_folders, [FINAL]);
  const d = (await detail(env, p.id)).project;
  assert.ok(Object.hasOwn(d, 'project_type'));
  assert.equal(d.project_type, null);
  assert.equal((await patch(env, p.id, { allow_proof_download: true, shoot_date: '2026-09-20' })).status, 200);
  const s = await (await pick(env, 'GET', 'state', p.token, { key: p.key })).json();
  assert.equal(s.shoot_date, '2026-09-20');
});

test('before the migration: setting a type is 500 project_type_unavailable with nothing written', async () => {
  const env = setup({ schema: BEFORE });
  const p = await created(env);
  const before = snapshot(env);
  for (const extra of [{}, { extra_max: 5 }, { shoot_date: '2026-09-19' }]) {
    const res = await create(env, { project_type: '婚紗', ...extra });
    assert.equal(res.status, 500, await res.clone().text());
    assert.equal((await res.json()).code, 'project_type_unavailable', JSON.stringify(extra));
  }
  for (const body of [{ project_type: '婚紗' }, { project_type: null }, { project_type: '' }, { project_type: '婚紗', pick_limit: 3 }, { project_type: '婚紗', shoot_date: '2026-09-19' }]) {
    const res = await patch(env, p.project.id, body);
    assert.equal(res.status, 500, JSON.stringify(body));
    assert.equal((await res.json()).code, 'project_type_unavailable', JSON.stringify(body));
  }
  assert.equal(snapshot(env), before);
  // a bad value is still 400 first
  assert.equal((await create(env, { project_type: 'x'.repeat(21) })).status, 400);
  assert.equal((await patch(env, p.project.id, { project_type: 1 })).status, 400);
});

test('a database missing both shoot_date and project_type: each write names its own missing column; reads still work', async () => {
  const schema = BEFORE.replace(/(client_confirmed_by\s+TEXT),\n(?:\s*--[^\n]*\n)*\s*shoot_date\s+TEXT\n\);/, '$1\n);');
  assert.notEqual(schema, BEFORE, 'fixture regex matched');
  const env = setup({ schema });
  const p = await created(env);
  const before = snapshot(env);
  const code = async res => { assert.equal(res.status, 500); return (await res.json()).code; };
  assert.equal(await code(await create(env, { project_type: '婚紗' })), 'project_type_unavailable');
  assert.equal(await code(await create(env, { shoot_date: '2026-09-19' })), 'shoot_date_unavailable');
  assert.equal(await code(await patch(env, p.project.id, { project_type: '婚紗' })), 'project_type_unavailable');
  assert.equal(await code(await patch(env, p.project.id, { shoot_date: '2026-09-19' })), 'shoot_date_unavailable');
  assert.equal(snapshot(env), before);
  const row = await listRow(env, p.project.id);
  assert.equal(row.project_type, null);
  assert.equal(row.shoot_date, null);
  assert.equal((await detail(env, p.project.id)).project.project_type, null);
});

test('a database with project_type but not shoot_date (migrations pasted out of order): the list still shows the type', async () => {
  // shoot_date removed, project_type kept
  const schema = FRESH.replace(/(client_confirmed_by\s+TEXT),\n(?:\s*--[^\n]*\n)*\s*shoot_date\s+TEXT,/, '$1,');
  assert.notEqual(schema, FRESH, 'fixture regex matched');
  const env = setup({ schema });
  const p = await created(env, { project_type: '婚紗' });
  assert.equal(p.project.project_type, '婚紗');
  const row = await listRow(env, p.project.id);
  assert.equal(row.project_type, '婚紗');
  assert.equal(row.shoot_date, null);
  assert.equal((await detail(env, p.project.id)).project.project_type, '婚紗');
  const res = await patch(env, p.project.id, { project_type: '婚禮' });
  assert.equal(res.status, 200);
  assert.equal(stored(env, p.project.id), '婚禮');
});

test('a migrated database lists projects in one query (no fallback retry), naming p.project_type', async () => {
  const env = setup();
  await created(env, { project_type: '婚紗' });
  const n = env.DB._sql.length;
  assert.equal((await call(env, '/api/admin/projects', { token: SECRET })).status, 200);
  const listQueries = env.DB._sql.slice(n).filter(s => /FROM projects p\s/.test(s));
  assert.equal(listQueries.length, 1, 'one list statement');
  assert.match(listQueries[0], /p\.project_type/);
  assert.match(listQueries[0], /p\.shoot_date/);
});
