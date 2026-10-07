// Renaming a project (docs/delivery.md, "Renaming a project"): PATCH
// /api/admin/projects/:id {title} changes projects.title and nothing in R2
// (folders are snapshotted into the project, its links and its selections, so
// renaming a folder is out — CLAUDE.md "Decided not to do"). The one stored
// copy of the title, share_tokens.label on the project's own pick links, is
// rewritten in the same D1 batch, so a link never carries an old name next to
// a renamed project. Frozen records (orders, submissions, revision rounds)
// hold no copy: they read the project's title live or not at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeBucket, fakeDB } from './fakes.mjs';
import { SECRET, call, pick, claim, save, one, rows, collectingCtx, seedToken } from './pick-helpers.mjs';

const PROOF = 'shoot/毛片/';
const FINAL = 'shoot/精修/';
const PA = 'shoot/毛片/a.jpg';
const OBJECTS = { [PA]: 'PROOF-A', 'shoot/精修/f1.jpg': 'FINAL-A' };

function setup() {
  return { imagepicker: fakeBucket(OBJECTS), DB: fakeDB(), PHOTOGRAPHER_TOKEN: SECRET };
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
const stored = (env, id) => one(env, 'SELECT title FROM projects WHERE id = ?', id).title;
const labels = (env, id) => rows(env, "SELECT label FROM share_tokens WHERE kind = 'pick' AND project_id = ? ORDER BY rowid", id).map(r => r.label);
const snapshot = env => JSON.stringify(['projects', 'share_tokens', 'selections', 'submissions'].map(t => rows(env, `SELECT * FROM ${t} ORDER BY rowid`)));
const state = async (env, t, key) => {
  const res = await pick(env, 'GET', 'state', t, { key });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
};

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

// ─── the happy path ─────────────────────────────────────────────────────────

test('PATCH title: stored trimmed, echoed, read back by list and detail', async () => {
  const env = setup();
  const p = await created(env);
  const id = p.project.id;
  const ok = async (title, expect) => {
    const res = await patch(env, id, { title });
    assert.equal(res.status, 200, await res.clone().text());
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.title, expect, JSON.stringify(title));
    assert.equal(stored(env, id), expect);
    assert.equal((await detail(env, id)).project.title, expect);
    assert.equal((await listRow(env, id)).title, expect);
  };
  await ok('林小姐 婚禮', '林小姐 婚禮');
  await ok('  陳家 全家福 \n', '陳家 全家福');
  await ok('X', 'X');
  await ok('字'.repeat(200), '字'.repeat(200));
  await ok(' ' + 'a'.repeat(200) + ' ', 'a'.repeat(200));
  // 200 characters, not 200 UTF-16 units: an emoji counts once
  await ok('📷'.repeat(200), '📷'.repeat(200));
});

test('PATCH title combines with the other keys in one body; a PATCH without it keeps it', async () => {
  const env = setup();
  const p = await created(env);
  const id = p.project.id;
  const res = await patch(env, id, { title: '新名字', pick_limit: 5, shoot_date: '2026-09-19', project_type: '婚禮', allow_proof_download: true });
  assert.equal(res.status, 200, await res.clone().text());
  const json = await res.json();
  assert.equal(json.title, '新名字');
  assert.equal(json.pick_limit, 5);
  const row = one(env, 'SELECT title, pick_limit, shoot_date, project_type, allow_proof_download FROM projects WHERE id = ?', id);
  assert.deepEqual({ ...row }, { title: '新名字', pick_limit: 5, shoot_date: '2026-09-19', project_type: '婚禮', allow_proof_download: 1 });
  assert.equal((await patch(env, id, { pick_limit: 6 })).status, 200);
  assert.equal(stored(env, id), '新名字');
  assert.deepEqual(labels(env, id), ['新名字'], 'a PATCH without title leaves the link label alone too');
});

// ─── refusals ───────────────────────────────────────────────────────────────

const BAD_TITLES = [
  '', ' ', '   \n\t ', '　',
  'a'.repeat(201), ' ' + '字'.repeat(201) + ' ', '📷'.repeat(201),
  null, 0, 1, true, false, [], ['王'], { t: '王' },
  '王\x00明', '王\x07', '王\x1b[31m', '王\x7f', '王\x85明', '王\x9f',
  '王 明', '王 明',
  '王؜', '‎王', '王‏', '王‪', '‮王', '王⁦', '王⁩',
  '王﻿明', '王\ud800明', '王\udfff', '\ud83d',
];

test('PATCH title: blank, too long, not a string or with unsafe characters refuses the whole body (400 invalid_body), nothing written', async () => {
  const env = setup();
  const p = await created(env);
  const id = p.project.id;
  const before = snapshot(env);
  for (const v of BAD_TITLES) {
    for (const body of [{ title: v }, { title: v, pick_limit: 9, shoot_date: '2026-09-19' }]) {
      const res = await patch(env, id, body);
      assert.equal(res.status, 400, JSON.stringify(v));
      assert.equal((await res.json()).code, 'invalid_body', JSON.stringify(v));
    }
  }
  assert.equal(snapshot(env), before);
  assert.equal(stored(env, id), '王先生 婚紗');
});

test('PATCH title: 401 without the photographer token, 404 for an unknown or another photographer\'s project, nothing written', async () => {
  const env = setup();
  const p = await created(env);
  env.DB._db.prepare("INSERT INTO projects (id, title, folders, created_at, photographer_id) VALUES ('other', '別人的', ?, ?, 'someone-else')")
    .run(JSON.stringify([PROOF]), new Date().toISOString());
  await seedToken(env, { token: 'OTHER-LINK', label: '別人的', project_id: 'other', folders: [PROOF] });
  const before = snapshot(env);
  assert.equal((await patch(env, p.project.id, { title: '新' }, 'wrong')).status, 401);
  assert.equal((await patch(env, 'nope', { title: '新' })).status, 404);
  assert.equal((await patch(env, 'other', { title: '新' })).status, 404);
  assert.equal(snapshot(env), before);
});

// ─── archived ───────────────────────────────────────────────────────────────

test('PATCH title is not a plan edit: an archived project takes it (links follow); a plan key alongside still 409s and writes nothing', async () => {
  const env = setup();
  const p = await created(env);
  const id = p.project.id;
  assert.equal((await admin(env, id, 'archive')).status, 200);
  const res = await patch(env, id, { title: '封存後改名' });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(stored(env, id), '封存後改名');
  assert.deepEqual(labels(env, id), ['封存後改名']);
  assert.equal((await patch(env, id, { title: '再改', shoot_date: '2026-09-19', project_type: '婚紗' })).status, 200, 'with the other non-plan keys');
  assert.equal(stored(env, id), '再改');
  const before = snapshot(env);
  const refused = await patch(env, id, { title: '不該寫入', pick_limit: 3 });
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, 'archived');
  assert.equal(snapshot(env), before, 'neither the project nor its links changed');
  assert.deepEqual(labels(env, id), ['再改']);
});

// ─── the copies ─────────────────────────────────────────────────────────────

test('rename rewrites the label of every pick link of THIS project (live and revoked) and of no other link', async () => {
  const env = setup();
  const p = await created(env);
  const q = await created(env, { title: '另一個專案' });
  const id = p.project.id;
  // a second link for p, then revoke the first
  const minted = await admin(env, id, 'links');
  assert.equal(minted.status, 201, await minted.clone().text());
  assert.equal((await call(env, `/api/shares/${encodeURIComponent(p.token)}/revoke`, { method: 'POST', token: SECRET })).status, 200);
  // a book link carrying the same text, and a pick row of another project
  await seedToken(env, { token: 'BOOK-LINK', book_id: 'b1', kind: 'client', label: '王先生 婚紗', folders: [PROOF] });
  // and a non-pick row that (wrongly) names this project: only pick links are the project's
  await seedToken(env, { token: 'ODD-LINK', book_id: 'b1', kind: 'client', label: '王先生 婚紗', project_id: id, folders: [PROOF] });
  const others = () => rows(env, "SELECT token, label FROM share_tokens WHERE kind != 'pick' OR project_id IS NULL OR project_id != ? ORDER BY rowid", id);
  const othersBefore = JSON.stringify(others());
  assert.deepEqual(labels(env, id), ['王先生 婚紗', '王先生 婚紗']);

  const res = await patch(env, id, { title: '  林小姐 婚禮 ' });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(labels(env, id), ['林小姐 婚禮', '林小姐 婚禮'], 'trimmed, both links');
  assert.equal(JSON.stringify(others()), othersBefore, 'another project\'s link and the book link are untouched');
  assert.equal(stored(env, q.project.id), '另一個專案');
  // a link minted after the rename copies the new name
  assert.equal((await admin(env, id, 'links')).status, 201);
  assert.deepEqual(labels(env, id), ['林小姐 婚禮', '林小姐 婚禮', '林小姐 婚禮']);
});

test('the rename is one batch: a failing link update leaves the project title unchanged too', async () => {
  const env = setup();
  const p = await created(env);
  const id = p.project.id;
  // a real SQL failure on the second statement, as D1 would raise it
  env.DB._db.exec("CREATE TRIGGER no_label BEFORE UPDATE OF label ON share_tokens BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  const before = snapshot(env);
  let status = null;
  try { status = (await patch(env, id, { title: '不該寫入', pick_limit: 7 })).status; } catch { status = 'threw'; }
  assert.notEqual(status, 200);
  assert.equal(snapshot(env), before, 'nothing written: title, plan and links as they were');
  assert.equal(stored(env, id), '王先生 婚紗');
  // the positive case: without the trigger the same body lands
  env.DB._db.exec('DROP TRIGGER no_label');
  assert.equal((await patch(env, id, { title: '可以寫入', pick_limit: 7 })).status, 200);
  assert.equal(stored(env, id), '可以寫入');
  assert.deepEqual(labels(env, id), ['可以寫入']);
});

test('a PATCH without title does not touch the links (no label write at all)', async () => {
  const env = setup();
  const p = await created(env);
  env.DB._db.exec("CREATE TRIGGER no_label BEFORE UPDATE OF label ON share_tokens BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  for (const body of [{ pick_limit: 4 }, { shoot_date: '2026-09-19' }, { project_type: '婚禮' }, { allow_proof_download: true }]) {
    const res = await patch(env, p.project.id, body);
    assert.equal(res.status, 200, `${JSON.stringify(body)}: ${await res.clone().text()}`);
  }
});

test('frozen records keep no copy of the title: submissions, orders, revision rounds have no title column', () => {
  const env = setup();
  for (const table of ['submissions', 'orders', 'order_items', 'revision_requests', 'revision_pins', 'selections', 'pickers', 'project_members']) {
    const cols = env.DB._db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    assert.ok(cols.length > 1, `${table} exists`);
    assert.ok(!cols.some(c => /title/i.test(c)), `${table}: ${cols}`);
  }
});

// ─── the guest sees the new name ────────────────────────────────────────────

test('guest state shows the new title after a rename: picking, retouching, delivered', async () => {
  const env = setup();
  const p = await retouching(env);
  assert.equal((await state(env, p.token, p.key)).project.title, '王先生 婚紗', 'positive: the old name first');
  assert.equal((await patch(env, p.id, { title: '林小姐 婚禮' })).status, 200);
  assert.equal((await state(env, p.token, p.key)).project.title, '林小姐 婚禮', 'owner');
  assert.equal((await state(env, p.token)).project.title, '林小姐 婚禮', 'viewer');
  assert.equal((await admin(env, p.id, 'deliver', { final_folders: [FINAL] })).status, 200);
  assert.equal((await patch(env, p.id, { title: '交件後改名' })).status, 200);
  assert.equal((await state(env, p.token, p.key)).project.title, '交件後改名', 'delivered');
  // a rename is not a deliver: the delivery stamps stay as they were
  const row = one(env, 'SELECT delivered_at, final_folders, phase FROM projects WHERE id = ?', p.id);
  assert.ok(row.delivered_at);
  assert.equal(row.phase, 'retouching');
});

test('a fresh project in picking: the guest state follows the rename too', async () => {
  const env = setup();
  const p = await created(env);
  const c = await claim(env, p.token);
  assert.equal((await patch(env, p.project.id, { title: '新名字' })).status, 200);
  assert.equal((await state(env, p.token, c.key)).project.title, '新名字');
});

test('rename does not touch R2: no object is written, copied or deleted', async () => {
  const env = setup();
  const p = await created(env);
  const keysBefore = JSON.stringify([...env.imagepicker._store.keys()]);
  const putsBefore = env.imagepicker._puts.length;
  let deletes = 0;
  const del = env.imagepicker.delete;
  if (del) env.imagepicker.delete = (...a) => { deletes++; return del.apply(env.imagepicker, a); };
  assert.equal((await patch(env, p.project.id, { title: '新名字' })).status, 200);
  assert.equal(env.imagepicker._puts.length, putsBefore);
  assert.equal(deletes, 0);
  assert.equal(JSON.stringify([...env.imagepicker._store.keys()]), keysBefore);
  assert.equal(one(env, 'SELECT folders FROM projects WHERE id = ?', p.project.id).folders, JSON.stringify([PROOF]));
});

test('before the shoot_date migration: a rename alone works; a rename with shoot_date is 500 shoot_date_unavailable and writes nothing (links included)', async () => {
  const FRESH = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const BEFORE = FRESH.replace(/(client_confirmed_by\s+TEXT),\n(?:\s*--[^\n]*\n)*\s*shoot_date\s+TEXT,\n(?:\s*--[^\n]*\n)*\s*project_type\s+TEXT\n\);/, '$1\n);');
  assert.notEqual(BEFORE, FRESH, 'fixture regex matched');
  const env = { imagepicker: fakeBucket(OBJECTS), DB: fakeDB({ schema: BEFORE }), PHOTOGRAPHER_TOKEN: SECRET };
  const p = await created(env);
  const id = p.project.id;
  const before = snapshot(env);
  const res = await patch(env, id, { title: '不該寫入', shoot_date: '2026-09-19' });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).code, 'shoot_date_unavailable');
  assert.equal(snapshot(env), before);
  const ok = await patch(env, id, { title: '改名' });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal(stored(env, id), '改名');
  assert.deepEqual(labels(env, id), ['改名']);
});

test('a project with no link rows at all still renames (200, not 404)', async () => {
  const env = setup();
  env.DB._db.prepare("INSERT INTO projects (id, title, folders, created_at) VALUES ('bare', '舊名', ?, ?)")
    .run(JSON.stringify([PROOF]), new Date().toISOString());
  assert.equal(rows(env, "SELECT 1 FROM share_tokens WHERE project_id = 'bare'").length, 0);
  const res = await patch(env, 'bare', { title: '新名' });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(stored(env, 'bare'), '新名');
});
