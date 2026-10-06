// Revision pins on the finals (docs/revision-pins.md, decided 2026-10-06:
// Tim took every recommendation in §11). After delivery the seat holder pins
// the current finals (drafts, revision_pins), then sends them as one frozen
// round (a revision_requests row with `marks` / `finals` / `message_auto`).
// High tier: new guest writes bound to the delivery and the finals gate.
// History and the thumbnail route are in revision-rounds-gate.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fakeDB } from './fakes.mjs';
import { seedToken, sha256Hex } from './pick-helpers.mjs';
import {
  FINAL, FINAL2, PROOF, PA, F1, F2, F3, G1, FRESH, MIGRATION, BEFORE, HALF, TABLE_ONLY,
  setup, fakeMailer, admin, deliver, detail, code, state, guest, putPins, submitRound, confirm, reviseText,
  rounds, photo, pin, retouching, delivered, withRound, draftRows, roundRows, projectRow, dbSnapshot, landOnce,
  SECRET, call, pick, claim, save, one, rows,
} from './revision-helpers.mjs';

const AUTO = '請見照片上的標示';
const WORKER = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');

// ─── schema ──────────────────────────────────────────────────────────────────

test('migration: three ALTERs and one CREATE TABLE IF NOT EXISTS, one statement each; noted in schema.sql; turns today\'s database into a fresh one', () => {
  const file = new URL('../migrations/2026-10-07-revision-pins.sql', import.meta.url);
  assert.ok(existsSync(file));
  assert.match(MIGRATION, /D1 Console/);
  assert.match(MIGRATION, /duplicate column/i);
  assert.match(MIGRATION, /revision_pins_unavailable/);
  const statements = MIGRATION.replace(/--[^\n]*/g, '').split(';').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
  assert.equal(statements.length, 4);
  assert.equal(statements[0], 'ALTER TABLE revision_requests ADD COLUMN marks TEXT');
  assert.equal(statements[1], 'ALTER TABLE revision_requests ADD COLUMN finals TEXT');
  assert.equal(statements[2], 'ALTER TABLE revision_requests ADD COLUMN message_auto INTEGER NOT NULL DEFAULT 0');
  assert.match(statements[3], /^CREATE TABLE IF NOT EXISTS revision_pins \(/);
  assert.match(FRESH, /2026-10-07-revision-pins\.sql/);
  const db = fakeDB({ schema: BEFORE });
  // a request row from before the migration survives it as a text request
  db._db.prepare("INSERT INTO revision_requests (id, project_id, picker_id, message, created_at) VALUES ('r', 'p', NULL, '舊的', 'x')").run();
  for (const s of statements) db._db.exec(s);
  const cols = (d, t) => d._db.prepare(`PRAGMA table_info(${t})`).all();
  const fresh = fakeDB();
  assert.deepEqual(cols(db, 'revision_requests'), cols(fresh, 'revision_requests'));
  assert.deepEqual(cols(db, 'revision_pins'), cols(fresh, 'revision_pins'));
  assert.deepEqual(cols(fresh, 'revision_pins').map(c => c.name),
    ['project_id', 'photo_key', 'marks', 'delivery_at', 'delivery_finals', 'updated_by', 'updated_at']);
  assert.deepEqual({ ...db._db.prepare('SELECT marks, finals, message_auto FROM revision_requests').get() }, { marks: null, finals: null, message_auto: 0 });
  // a re-run of an ALTER says it already ran; the CREATE is re-runnable
  for (const i of [0, 1, 2]) assert.throws(() => db._db.exec(statements[i]), /duplicate column/);
  db._db.exec(statements[3]);
  // and BEFORE really is today's shape
  const old = fakeDB({ schema: BEFORE });
  assert.throws(() => old._db.prepare('SELECT marks FROM revision_requests').all(), /no such column/);
  assert.throws(() => old._db.prepare('SELECT * FROM revision_pins').all(), /no such table/);
  old._db.prepare('SELECT client_confirmed_at FROM projects').all();
});

// ─── state ───────────────────────────────────────────────────────────────────

test('state: the seat holder of a delivered project gets revision_drafts [] and revision_open_photos null; a viewer gets neither key; picking mode neither', async () => {
  const env = setup();
  const p = await retouching(env);
  let s = await state(env, p.token, p.key);
  assert.equal(s.mode, 'picking');
  assert.ok(!('revision_drafts' in s) && !('revision_open_photos' in s), 'not delivered: no keys');
  assert.equal((await deliver(env, p.id)).status, 200);
  s = await state(env, p.token, p.key);
  assert.equal(s.mode, 'delivered');
  assert.deepEqual(s.revision_drafts, []);
  assert.equal(s.revision_open_photos, null);
  for (const key of [undefined, 'wrong-key']) {
    const v = await state(env, p.token, key);
    assert.equal(v.mode, 'delivered');
    assert.ok(!('revision_drafts' in v), 'viewer: no drafts key');
    assert.ok(!('revision_open_photos' in v), 'viewer: no open photos key');
  }
});

// ─── drafts ──────────────────────────────────────────────────────────────────

test('drafts: saved per photo, read back through state in key order; a photo is replaced whole; [] deletes it; a key named twice keeps its last mention', async () => {
  const env = setup();
  const p = await delivered(env);
  const before = projectRow(env);
  let res = await putPins(env, p.token, p.key, [
    { photo_key: F3, marks: [pin(0.5, 0.5, '  亮一點  ')] },
    { photo_key: F1, marks: [pin(0.12345, 0.5), pin(1, 0, '去掉路人')] },
  ]);
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(await res.json(), { ok: true });
  let s = await state(env, p.token, p.key);
  assert.deepEqual(s.revision_drafts, [
    { photo_key: F1, marks: [{ x: 0.1235, y: 0.5, note: '' }, { x: 1, y: 0, note: '去掉路人' }] },
    { photo_key: F3, marks: [{ x: 0.5, y: 0.5, note: '亮一點' }] },
  ]);
  const [r1] = draftRows(env);
  assert.equal(r1.delivery_at, before.delivered_at);
  assert.equal(r1.delivery_finals, before.final_folders);
  assert.equal(r1.updated_by, p.pickerId);
  assert.ok(r1.updated_at);
  res = await putPins(env, p.token, p.key, [
    { photo_key: F1, marks: [pin(0.2, 0.2, 'x')] },
    { photo_key: F3, marks: [] },
    { photo_key: F1, marks: [pin(0.3, 0.3, '最後')] },
  ]);
  assert.equal(res.status, 200);
  s = await state(env, p.token, p.key);
  assert.deepEqual(s.revision_drafts, [{ photo_key: F1, marks: [{ x: 0.3, y: 0.3, note: '最後' }] }]);
  assert.equal(draftRows(env).length, 1, 'never stores []');
  // deleting a photo that has no draft is fine
  assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F2, marks: [] }])).status, 200);
  // the project row is not touched by a draft save
  const after = projectRow(env);
  assert.equal(JSON.stringify(after), JSON.stringify(before));
});

test('drafts: only the seat holder — a viewer, a wrong key, another project\'s key and a key from before a seat reset are 403; nothing written', async () => {
  const env = setup();
  const p = await delivered(env);
  const other = await delivered(env); // a second project with its own seat
  // the same fixture lets the seat holder in
  assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin()] }])).status, 200);
  const snap = dbSnapshot(env);
  for (const key of [undefined, 'wrong', other.key]) {
    const res = await putPins(env, p.token, key, [{ photo_key: F1, marks: [pin(0.2, 0.2)] }]);
    assert.equal(res.status, 403, String(key));
  }
  assert.equal((await call(env, `/api/admin/projects/${p.id}/reset-seat`, { method: 'POST', token: SECRET })).status, 200);
  const res = await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin(0.2, 0.2)] }]);
  assert.equal(res.status, 403, 'old key after a seat reset');
  const noSeat = j => j.replace(/"owner_picker_id":(null|"[^"]*")/g, '');
  assert.equal(noSeat(dbSnapshot(env)), noSeat(snap));
});

test('drafts: only while delivered — retouching, undelivered and reopened are 409 not_delivered (before the body is read); dead links 401', async () => {
  const env = setup();
  const p = await retouching(env);
  let res = await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin()] }]);
  assert.equal(res.status, 409);
  assert.equal(await code(res), 'not_delivered');
  // not_delivered comes before the body
  res = await pick(env, 'PUT', 'revision-pins', p.token, { key: p.key, body: '{not json' });
  assert.equal(await code(res), 'not_delivered');
  assert.equal((await deliver(env, p.id)).status, 200);
  assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin()] }])).status, 200);
  assert.equal((await admin(env, p.id, 'undeliver')).status, 200);
  res = await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin(0.2, 0.2)] }]);
  assert.equal(await code(res), 'not_delivered');
  assert.equal((await deliver(env, p.id)).status, 200);
  assert.equal((await admin(env, p.id, 'reopen')).status, 200);
  res = await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin(0.2, 0.2)] }]);
  assert.equal(await code(res), 'not_delivered');
  // the link itself: archived, revoked, expired, unknown
  const env2 = setup();
  const q = await delivered(env2);
  env2.DB._db.prepare('UPDATE share_tokens SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
  assert.equal((await putPins(env2, q.token, q.key, [{ photo_key: F1, marks: [pin()] }])).status, 401);
  env2.DB._db.prepare('UPDATE share_tokens SET expires_at = ?, revoked_at = ?').run(new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  assert.equal((await putPins(env2, q.token, q.key, [{ photo_key: F1, marks: [pin()] }])).status, 401);
  env2.DB._db.prepare('UPDATE share_tokens SET revoked_at = NULL').run();
  assert.equal((await putPins(env2, q.token, q.key, [{ photo_key: F1, marks: [pin()] }])).status, 200, 'live again');
  assert.equal((await admin(env2, q.id, 'archive')).status, 200);
  assert.equal((await putPins(env2, q.token, q.key, [{ photo_key: F1, marks: [pin()] }])).status, 401);
  assert.equal((await putPins(env2, 'nope', q.key, [{ photo_key: F1, marks: [pin()] }])).status, 401);
});

test('drafts: only keys in the current finals — a proof (even with originals open), another folder, a `_` object, `..` are 403 not_in_finals; nothing written', async () => {
  const env = setup();
  const p = await delivered(env);
  assert.equal((await call(env, `/api/admin/projects/${p.id}`, { method: 'PATCH', token: SECRET, body: { allow_proof_download: true } })).status, 200);
  for (const key of [PA, 'other/x.jpg', '_thumbs/400/shoot/精修/f1.jpg.thumb', 'shoot/精修/../毛片/a.jpg', 'shoot/精修二/g1.jpg', 'shoot/精修']) {
    const res = await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin()] }, { photo_key: key, marks: [pin()] }]);
    assert.equal(res.status, 403, key);
    assert.equal(await code(res), 'not_in_finals', key);
  }
  // `_books/…` is internal even if a finals snapshot named it by hand
  env.DB._db.prepare('UPDATE projects SET final_folders = ?').run(JSON.stringify([FINAL, '_books/']));
  const res = await putPins(env, p.token, p.key, [{ photo_key: '_books/b1.json', marks: [pin()] }]);
  assert.equal(res.status, 409, 'a snapshot naming `_` is not a delivery at all');
  assert.equal(draftRows(env).length, 0);
});

test('drafts body: 413 over 128 KB; 400 Invalid JSON, invalid_body (not an object, items not 1–20 items, an item not an object), invalid_photo_key, invalid_marks; nothing written', async () => {
  const env = setup();
  const p = await delivered(env);
  const raw = body => pick(env, 'PUT', 'revision-pins', p.token, { key: p.key, body });
  let res = await raw('x'.repeat(128 * 1024 + 1));
  assert.equal(res.status, 413);
  assert.equal(await code(res), 'too_large');
  res = await raw('{not json');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Invalid JSON');
  const twentyOne = Array.from({ length: 21 }, (_, i) => ({ photo_key: `${FINAL}p${i}.jpg`, marks: [pin()] }));
  for (const body of [[], '"str"', 'null', {}, { items: {} }, { items: [] }, { items: twentyOne }, { items: [null] }, { items: ['x'] },
    { items: [{ marks: [pin()] }] }, { items: [{ photo_key: 3, marks: [pin()] }] }]) {
    res = await raw(body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal(await code(res), 'invalid_body', JSON.stringify(body).slice(0, 60));
  }
  for (const key of [`${FINAL}a\nb.jpg`, `${FINAL}a .jpg`, `${FINAL}sub/`, `${FINAL}${'長'.repeat(260)}.jpg`]) {
    res = await putPins(env, p.token, p.key, [{ photo_key: key, marks: [pin()] }]);
    assert.equal(res.status, 400, key.slice(0, 40));
    assert.equal(await code(res), 'invalid_photo_key');
  }
  const bad = [
    Array.from({ length: 11 }, () => pin()), [pin(1.1, 0)], [pin(0, -0.1)], [{ x: '0.5', y: 0.5 }], [pin(0.5, 0.5, 'n'.repeat(101))],
    [pin(0.5, 0.5, 'a\u0007b')], [pin(0.5, 0.5, 'a\nb')], [{ x: 0.5, y: 0.5, note: 5 }], 'x', null, [[0.5, 0.5]],
  ];
  for (const marks of bad) {
    res = await putPins(env, p.token, p.key, [{ photo_key: F1, marks }]);
    assert.equal(res.status, 400, JSON.stringify(marks).slice(0, 60));
    assert.equal(await code(res), 'invalid_marks');
  }
  // 20 items and 10 pins with 100-character notes are fine; an empty note too
  const twenty = Array.from({ length: 20 }, (_, i) => ({ photo_key: `${FINAL}p${i}.jpg`, marks: [pin(0.5, 0.5, i ? 'n'.repeat(100) : '')] }));
  assert.equal((await putPins(env, p.token, p.key, twenty)).status, 200);
  assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F1, marks: Array.from({ length: 10 }, () => pin()) }])).status, 200);
  assert.equal(draftRows(env).length, 21);
});

test('drafts: a bidi override in a note is stored as typed (display isolates it); control characters are refused', async () => {
  const env = setup();
  const p = await delivered(env);
  assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin(0.5, 0.5, 'abc‮def')] }])).status, 200);
  assert.equal(JSON.parse(draftRows(env)[0].marks)[0].note, 'abc‮def');
});

test('drafts: confirmed is 409 already_confirmed; any open round (a pins round or an old text request) is 409 revision_open; nothing written', async () => {
  const env = setup();
  const p = await delivered(env);
  assert.equal((await reviseText(env, p.token, p.key, '舊式文字')).status, 200);
  let res = await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin()] }]);
  assert.equal(res.status, 409);
  assert.equal(await code(res), 'revision_open');
  assert.equal(draftRows(env).length, 0);
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
  res = await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin()] }]);
  assert.equal(await code(res), 'already_confirmed');
  const env2 = setup();
  const q = await withRound(env2);
  res = await putPins(env2, q.token, q.key, [{ photo_key: F2, marks: [pin()] }]);
  assert.equal(await code(res), 'revision_open');
  assert.equal(draftRows(env2).length, 0);
});

test('drafts caps: at most 100 photos (409 revision_photos_cap) and 300 pins (409 marks_cap) — checked in the write; a project already over may still delete and shrink', async () => {
  const env = setup();
  const p = await delivered(env);
  const items = (from, n, pins = 1) => Array.from({ length: n }, (_, i) => ({ photo_key: `${FINAL}p${String(from + i).padStart(3, '0')}.jpg`, marks: Array.from({ length: pins }, () => pin()) }));
  for (let i = 0; i < 100; i += 20) assert.equal((await putPins(env, p.token, p.key, items(i, 20))).status, 200);
  let res = await putPins(env, p.token, p.key, items(100, 1));
  assert.equal(res.status, 409);
  assert.deepEqual({ code: (await res.clone().json()).code, max: (await res.json()).max }, { code: 'revision_photos_cap', max: 100 });
  // replacing one of the 100 is fine
  assert.equal((await putPins(env, p.token, p.key, items(0, 1, 3))).status, 200);
  assert.equal(draftRows(env).length, 100);
  // pins: 30 photos × 10 = 300, then one more
  const env2 = setup();
  const q = await delivered(env2);
  for (let i = 0; i < 30; i += 10) assert.equal((await putPins(env2, q.token, q.key, items(i, 10, 10))).status, 200);
  res = await putPins(env2, q.token, q.key, items(30, 1));
  assert.equal(res.status, 409);
  assert.deepEqual({ code: (await res.clone().json()).code, max: (await res.json()).max }, { code: 'marks_cap', max: 300 });
  res = await putPins(env2, q.token, q.key, [{ photo_key: `${FINAL}p000.jpg`, marks: Array.from({ length: 10 }, () => pin()) }, ...items(30, 1)]);
  assert.equal(await code(res), 'marks_cap', 'a same-count replace does not make room');
  assert.equal(draftRows(env2).length, 30);
  // over the cap by hand: deleting and shrinking still work, growing does not
  const env3 = setup();
  const r = await delivered(env3);
  const { delivered_at: at, final_folders: ff } = projectRow(env3);
  const ins = env3.DB._db.prepare('INSERT INTO revision_pins (project_id, photo_key, marks, delivery_at, delivery_finals, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 105; i++) ins.run(r.id, `${FINAL}h${String(i).padStart(3, '0')}.jpg`, JSON.stringify([pin()]), at, ff, r.pickerId, 'x');
  assert.equal((await putPins(env3, r.token, r.key, [{ photo_key: `${FINAL}h000.jpg`, marks: [] }])).status, 200);
  assert.equal((await putPins(env3, r.token, r.key, [{ photo_key: `${FINAL}h001.jpg`, marks: [pin(0.1, 0.1)] }])).status, 200);
  res = await putPins(env3, r.token, r.key, [{ photo_key: `${FINAL}new.jpg`, marks: [pin()] }]);
  assert.equal(await code(res), 'revision_photos_cap');
  assert.equal(draftRows(env3).length, 104);
});

test('drafts are bound to the delivery: a same-folder repeat deliver keeps them; new folders or undeliver → deliver hide them, and the next save clears the stale rows', async () => {
  const env = setup();
  const p = await delivered(env);
  assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin()] }])).status, 200);
  assert.equal((await deliver(env, p.id)).status, 200); // 更換精修 to the same folder
  assert.equal((await state(env, p.token, p.key)).revision_drafts.length, 1);
  assert.equal((await deliver(env, p.id, [FINAL, FINAL2])).status, 200);
  assert.deepEqual((await state(env, p.token, p.key)).revision_drafts, [], 'other folders: stale');
  assert.equal(draftRows(env).length, 1, 'still there until the next save');
  assert.equal((await putPins(env, p.token, p.key, [{ photo_key: G1, marks: [pin()] }])).status, 200);
  assert.deepEqual(draftRows(env).map(r => r.photo_key), [G1], 'the stale row went with it');
  assert.equal((await admin(env, p.id, 'undeliver')).status, 200);
  await new Promise(r => setTimeout(r, 5)); // a new delivered_at
  assert.equal((await deliver(env, p.id, [FINAL, FINAL2])).status, 200);
  assert.deepEqual((await state(env, p.token, p.key)).revision_drafts, [], 'a new delivery: stale');
  // a hand-made row outside the finals is never handed back
  const { delivered_at: at, final_folders: ff } = projectRow(env);
  env.DB._db.prepare('INSERT INTO revision_pins (project_id, photo_key, marks, delivery_at, delivery_finals, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(p.id, PA, JSON.stringify([pin()]), at, ff, p.pickerId, 'x');
  env.DB._db.prepare('INSERT INTO revision_pins (project_id, photo_key, marks, delivery_at, delivery_finals, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(p.id, F3, 'not json', at, ff, p.pickerId, 'x');
  assert.deepEqual((await state(env, p.token, p.key)).revision_drafts, []);
});

test('drafts race: a deliver to new folders landing between the route\'s checks and its write makes the save a no-op (409 not_delivered)', async () => {
  const env = setup();
  const p = await delivered(env);
  landOnce(env, /UPDATE projects SET id = id/, 'UPDATE projects SET final_folders = ?', JSON.stringify([FINAL2]));
  const res = await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin()] }]);
  assert.equal(res.status, 409);
  assert.equal(await code(res), 'not_delivered');
  assert.equal(draftRows(env).length, 0);
  // and a confirm landing there
  const env2 = setup();
  const q = await delivered(env2);
  landOnce(env2, /UPDATE projects SET id = id/, "UPDATE projects SET client_confirmed_at = 'x', client_confirmed_by = 'guest'");
  const res2 = await putPins(env2, q.token, q.key, [{ photo_key: F1, marks: [pin()] }]);
  assert.equal(await code(res2), 'already_confirmed');
  assert.equal(draftRows(env2).length, 0);
});

// ─── submit ──────────────────────────────────────────────────────────────────

test('submit: one frozen row — the snapshot of the drafts (Chinese, quote and backslash keys), the finals as they were, the note; drafts deleted in the same batch', async () => {
  const env = setup();
  const p = await delivered(env);
  const Q = `${FINAL}他說"好".jpg`;
  const B = `${FINAL}back\\slash.jpg`;
  assert.equal((await putPins(env, p.token, p.key, [
    { photo_key: F1, marks: [pin(0.1, 0.1, '去掉路人'), pin(0.9, 0.9)] },
    { photo_key: Q, marks: [pin(0.2, 0.2, '引號')] },
    { photo_key: B, marks: [pin(0.3, 0.3)] },
  ])).status, 200);
  const expect = [{ k: Q, n: 1 }, { k: F1, n: 2 }, { k: B, n: 1 }]; // any order
  const res = await submitRound(env, p.token, p.key, { note: '  整體再亮一點\r\n謝謝 ', expect });
  assert.equal(res.status, 200, await res.clone().text());
  const out = await res.json();
  assert.equal(out.ok, true);
  assert.match(out.id, /^[0-9a-f-]{36}$/);
  assert.equal(out.photo_count, 3);
  assert.ok(out.created_at);
  const [row] = roundRows(env);
  assert.equal(row.id, out.id);
  assert.equal(row.project_id, p.id);
  assert.equal(row.picker_id, p.pickerId);
  assert.equal(row.message, '整體再亮一點\n謝謝');
  assert.equal(row.message_auto, 0);
  assert.equal(row.resolved_at, null);
  assert.equal(row.created_at, out.created_at);
  assert.equal(row.finals, projectRow(env).final_folders);
  assert.deepEqual(JSON.parse(row.marks), {
    [B]: [{ x: 0.3, y: 0.3, note: '' }],
    [F1]: [{ x: 0.1, y: 0.1, note: '去掉路人' }, { x: 0.9, y: 0.9, note: '' }],
    [Q]: [{ x: 0.2, y: 0.2, note: '引號' }],
  });
  assert.equal(draftRows(env).length, 0);
  const s = await state(env, p.token, p.key);
  assert.equal(s.revision_open, true);
  assert.equal(s.revision_open_photos, 3);
  assert.equal(s.revision_message, '整體再亮一點\n謝謝');
  assert.deepEqual(s.revision_drafts, []);
  // the project row is untouched: not confirmed, still delivered
  assert.equal(projectRow(env).client_confirmed_at, null);
  // a viewer sees it is open, never the text or the count
  const v = await state(env, p.token, undefined);
  assert.equal(v.revision_open, true);
  assert.equal(v.revision_message, null);
  assert.ok(!('revision_open_photos' in v));
});

test('submit note: optional — none, null, "" or blank stores the fixed text with message_auto = 1 and state never reads it as the guest\'s; not a string or over 1000 is 400 invalid_message', async () => {
  for (const body of [{}, { note: null }, { note: '' }, { note: '  \n ' }]) {
    const env = setup();
    const p = await delivered(env);
    assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin()] }])).status, 200);
    const res = await submitRound(env, p.token, p.key, { ...body, expect: [{ k: F1, n: 1 }] });
    assert.equal(res.status, 200, JSON.stringify(body));
    const [row] = roundRows(env);
    assert.equal(row.message, AUTO);
    assert.equal(row.message_auto, 1);
    const s = await state(env, p.token, p.key);
    assert.equal(s.revision_open, true);
    assert.equal(s.revision_message, null);
  }
  const env = setup();
  const p = await delivered(env);
  assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin()] }])).status, 200);
  for (const note of [5, ['x'], { a: 1 }, 'n'.repeat(1001)]) {
    const res = await submitRound(env, p.token, p.key, { note, expect: [{ k: F1, n: 1 }] });
    assert.equal(res.status, 400);
    assert.equal(await code(res), 'invalid_message');
  }
  assert.equal(roundRows(env).length, 0);
  assert.equal((await submitRound(env, p.token, p.key, { note: 'n'.repeat(1000), expect: [{ k: F1, n: 1 }] })).status, 200);
});

test('submit expect: it must match the drafts exactly (keys and pin counts) or 409 draft_changed; a malformed expect is 400 invalid_body; no drafts is 409 no_pins', async () => {
  const env = setup();
  const p = await delivered(env);
  let res = await submitRound(env, p.token, p.key, { expect: [] });
  assert.equal(res.status, 409);
  assert.equal(await code(res), 'no_pins');
  res = await submitRound(env, p.token, p.key, { expect: [{ k: F1, n: 1 }] });
  assert.equal(await code(res), 'no_pins');
  assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin(), pin()] }, { photo_key: F3, marks: [pin()] }])).status, 200);
  for (const expect of [
    [], [{ k: F1, n: 2 }], [{ k: F1, n: 1 }, { k: F3, n: 1 }], [{ k: F1, n: 2 }, { k: F3, n: 1 }, { k: F2, n: 1 }],
    [{ k: F1, n: 2 }, { k: F2, n: 1 }],
  ]) {
    res = await submitRound(env, p.token, p.key, { expect });
    assert.equal(res.status, 409, JSON.stringify(expect));
    assert.equal(await code(res), 'draft_changed', JSON.stringify(expect));
  }
  const many = Array.from({ length: 101 }, (_, i) => ({ k: `${FINAL}p${i}.jpg`, n: 1 }));
  for (const body of [{}, { expect: 'x' }, { expect: {} }, { expect: many }, { expect: [{ k: F1 }] }, { expect: [{ k: F1, n: 0 }] },
    { expect: [{ k: F1, n: 11 }] }, { expect: [{ k: F1, n: 1.5 }] }, { expect: [{ k: F1, n: '2' }] }, { expect: [{ k: 5, n: 1 }] },
    { expect: [null] }, { expect: [{ k: `${FINAL}a\nb`, n: 1 }] }, { expect: [{ k: F1, n: 2 }, { k: F1, n: 2 }] }, [], '"x"', 'null']) {
    res = await submitRound(env, p.token, p.key, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(await code(res), 'invalid_body', JSON.stringify(body).slice(0, 80));
  }
  res = await pick(env, 'POST', 'revision-round', p.token, { key: p.key, body: '{bad' });
  assert.equal(res.status, 400);
  assert.equal(roundRows(env).length, 0);
  assert.equal(draftRows(env).length, 2);
  assert.equal((await submitRound(env, p.token, p.key, { expect: [{ k: F3, n: 1 }, { k: F1, n: 2 }] })).status, 200);
});

test('submit: 401 dead link, 403 not the seat holder, 409 not_delivered (before the body), 413 over 128 KB; nothing written, no email', async () => {
  const env = setup();
  const p = await delivered(env);
  assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin()] }])).status, 200);
  const snap = dbSnapshot(env);
  const body = { expect: [{ k: F1, n: 1 }] };
  assert.equal((await submitRound(env, 'nope', p.key, body)).status, 401);
  for (const key of [undefined, 'wrong']) assert.equal((await submitRound(env, p.token, key, body)).status, 403);
  let res = await pick(env, 'POST', 'revision-round', p.token, { key: p.key, body: 'x'.repeat(128 * 1024 + 1) });
  assert.equal(res.status, 413);
  assert.equal(dbSnapshot(env), snap);
  assert.equal(env.NOTIFY_EMAIL.sent.length, 0);
  assert.equal((await admin(env, p.id, 'undeliver')).status, 200);
  res = await pick(env, 'POST', 'revision-round', p.token, { key: p.key, body: '{bad' });
  assert.equal(res.status, 409);
  assert.equal(await code(res), 'not_delivered');
  assert.equal(roundRows(env).length, 0);
  // a 100-photo expect with the longest keys fits the body cap
  const env2 = setup();
  const q = await delivered(env2);
  const longKey = i => `${FINAL}${'😀'.repeat(240)}${String(i).padStart(3, '0')}.jpg`;
  const expect = Array.from({ length: 100 }, (_, i) => ({ k: longKey(i), n: 1 }));
  res = await submitRound(env2, q.token, q.key, { note: '長'.repeat(1000), expect });
  assert.equal(await code(res), 'no_pins', 'parsed, not 413');
});

test('submit: confirmed is 409 already_confirmed; any open request (text or pins) is 409 revision_open; a double submit writes one row', async () => {
  const env = setup();
  const p = await delivered(env);
  assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin()] }])).status, 200);
  assert.equal((await reviseText(env, p.token, p.key, '舊式')).status, 200);
  let res = await submitRound(env, p.token, p.key, { expect: [{ k: F1, n: 1 }] });
  assert.equal(res.status, 409);
  assert.equal(await code(res), 'revision_open');
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
  res = await submitRound(env, p.token, p.key, { expect: [{ k: F1, n: 1 }] });
  assert.equal(await code(res), 'already_confirmed');
  assert.equal(roundRows(env).filter(r => r.marks).length, 0);
  const env2 = setup();
  const q = await withRound(env2);
  res = await submitRound(env2, q.token, q.key, { expect: [{ k: F1, n: 2 }, { k: F3, n: 1 }] });
  assert.equal(res.status, 409);
  assert.ok(['revision_open', 'no_pins'].includes(await code(res)));
  assert.equal(roundRows(env2).length, 1);
});

test('submit caps: 50 requests in all is 409 revision_cap; a snapshot over 446,400 bytes (only by hand) is 409 marks_cap; nothing written', async () => {
  const env = setup();
  const p = await delivered(env);
  const ins = env.DB._db.prepare("INSERT INTO revision_requests (id, project_id, picker_id, message, created_at, resolved_at) VALUES (?, ?, NULL, 'old', ?, 'done')");
  for (let i = 0; i < 50; i++) ins.run(`r${i}`, p.id, `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`);
  assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin()] }])).status, 200);
  let res = await submitRound(env, p.token, p.key, { expect: [{ k: F1, n: 1 }] });
  assert.equal(res.status, 409);
  assert.deepEqual([await code(res), (await res.json()).max], ['revision_cap', 50]);
  env.DB._db.prepare("DELETE FROM revision_requests WHERE id = 'r0'").run();
  // hand-edited drafts too big to freeze
  const { delivered_at: at, final_folders: ff } = projectRow(env);
  const huge = JSON.stringify(Array.from({ length: 10 }, () => pin(0.5, 0.5, '😀'.repeat(100))));
  const ins2 = env.DB._db.prepare('INSERT INTO revision_pins (project_id, photo_key, marks, delivery_at, delivery_finals, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const expect = [{ k: F1, n: 1 }];
  for (let i = 0; i < 99; i++) {
    const k = `${FINAL}${'😀'.repeat(200)}${String(i).padStart(2, '0')}.jpg`;
    ins2.run(p.id, k, huge, at, ff, p.pickerId, 'x');
    expect.push({ k, n: 10 });
  }
  res = await submitRound(env, p.token, p.key, { expect });
  assert.equal(await code(res), 'marks_cap');
  assert.equal(roundRows(env).length, 49);
  assert.equal(draftRows(env).length, 100);
});

test('submit email: subject on one line with the count; the note (if the guest wrote one) and one line per photo, at most 20; HTML escaped; bidi stripped; a failing mailer never fails the submit', async () => {
  const env = setup();
  const p = await delivered(env);
  assert.equal((await putPins(env, p.token, p.key, [
    { photo_key: F1, marks: [pin(0.1, 0.1, '去掉<b>路人</b>'), pin(0.9, 0.9)] },
    { photo_key: `${FINAL}x‮gpj.exe.jpg`, marks: [pin(0.1, 0.1, 'a‮b')] },
  ])).status, 200);
  const res = await submitRound(env, p.token, p.key, { note: '整體<script>x</script>', expect: [{ k: F1, n: 2 }, { k: `${FINAL}x‮gpj.exe.jpg`, n: 1 }] });
  assert.equal(res.status, 200);
  assert.equal(env.NOTIFY_EMAIL.sent.length, 1);
  const m = env.NOTIFY_EMAIL.sent[0];
  assert.equal(m.to, 'studio@example.com');
  assert.equal(m.subject, '[要求修改] 王先生 婚紗 — 王小明（2 張）');
  assert.match(m.text, /整體<script>x<\/script>/);
  assert.match(m.text, /^f1\.jpg：①去掉<b>路人<\/b> ②$/m);
  assert.match(m.text, /^x gpj\.exe\.jpg：①a b$/m);
  assert.doesNotMatch(m.text + m.html + m.subject, /‮/);
  assert.doesNotMatch(m.html, /<script>|<b>/);
  assert.match(m.html, /&lt;script&gt;/);
  assert.match(m.text, new RegExp(`admin\\.html#project=${p.id}`));
  // no note: the fixed text is not the guest's and is not mailed
  const env2 = setup();
  const q = await delivered(env2);
  const items = Array.from({ length: 20 }, (_, i) => ({ photo_key: `${FINAL}p${String(i).padStart(2, '0')}.jpg`, marks: [pin(0.5, 0.5, `n${i}`)] }));
  assert.equal((await putPins(env2, q.token, q.key, items)).status, 200);
  const more = Array.from({ length: 5 }, (_, i) => ({ photo_key: `${FINAL}q${i}.jpg`, marks: [pin()] }));
  assert.equal((await putPins(env2, q.token, q.key, more)).status, 200);
  const expect = [...items, ...more].map(i => ({ k: i.photo_key, n: 1 }));
  assert.equal((await submitRound(env2, q.token, q.key, { expect })).status, 200);
  const m2 = env2.NOTIFY_EMAIL.sent[0];
  assert.equal(m2.subject, '[要求修改] 王先生 婚紗 — 王小明（25 張）');
  assert.doesNotMatch(m2.text + m2.html, new RegExp(AUTO));
  assert.equal((m2.text.match(/^\S+\.jpg：/gm) || []).length, 20);
  assert.match(m2.text, /…另 5 張，請到後台查看/);
  // a mailer that throws, or none at all
  for (const extra of [{ NOTIFY_EMAIL: fakeMailer({ fail: true }) }, { NOTIFY_EMAIL: undefined }]) {
    const env3 = setup({ extra });
    const r = await delivered(env3);
    assert.equal((await putPins(env3, r.token, r.key, [{ photo_key: F1, marks: [pin()] }])).status, 200);
    assert.equal((await submitRound(env3, r.token, r.key, { expect: [{ k: F1, n: 1 }] })).status, 200);
    assert.equal(roundRows(env3).length, 1);
  }
});

// ─── frozen ──────────────────────────────────────────────────────────────────

test('frozen (source): every UPDATE of revision_requests sets resolved_at only; nothing deletes or replaces a request', () => {
  const updates = [...WORKER.matchAll(/UPDATE\s+revision_requests\s+SET\s+([\s\S]*?)\s+WHERE/g)].map(m => m[1].replace(/\s+/g, ' '));
  assert.ok(updates.length >= 2, `found ${updates.length}`);
  for (const set of updates) assert.equal(set, 'resolved_at = ?', set);
  assert.doesNotMatch(WORKER, /DELETE\s+FROM\s+revision_requests/i);
  assert.doesNotMatch(WORKER, /REPLACE\s+INTO\s+revision_requests/i);
  assert.doesNotMatch(WORKER, /INSERT\s+OR\s+\w+\s+INTO\s+revision_requests/i);
});

test('frozen (behaviour): a round\'s marks, finals and message never change through drafts, delivers, undeliver, reopen, confirm and later rounds', async () => {
  const env = setup();
  const p = await withRound(env);
  const frozen = () => ({ ...one(env, 'SELECT id, project_id, picker_id, message, message_auto, marks, finals, created_at FROM revision_requests WHERE id = ?', p.roundId) });
  const first = frozen();
  assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin()] }])).status, 409);
  assert.equal((await deliver(env, p.id)).status, 200);
  assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin(0.2, 0.2, '第二輪')] }])).status, 200);
  assert.equal((await submitRound(env, p.token, p.key, { expect: [{ k: F1, n: 1 }] })).status, 200);
  assert.equal((await deliver(env, p.id, [FINAL2])).status, 200);
  assert.equal((await admin(env, p.id, 'undeliver')).status, 200);
  assert.equal((await deliver(env, p.id, [FINAL2])).status, 200);
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
  assert.equal((await admin(env, p.id, 'reopen')).status, 200);
  assert.deepEqual(frozen(), first);
  assert.equal(roundRows(env).length, 2);
  assert.ok(roundRows(env).every(r => r.resolved_at), 'resolved by the delivers / confirm');
});

// ─── races ───────────────────────────────────────────────────────────────────

const ROUND_INSERT = /INSERT INTO revision_requests \(id, project_id, picker_id, message, message_auto, marks, finals, created_at\)/;
const invariant = env => {
  const pr = projectRow(env);
  if (pr.client_confirmed_at) assert.equal(one(env, 'SELECT COUNT(*) AS n FROM revision_requests WHERE resolved_at IS NULL').n, 0, 'confirmed ⇒ none open');
};

test('races: a confirm, an undeliver, a deliver to other folders, an archive or another round landing inside a submit each win; nothing written', async () => {
  const cases = [
    ["UPDATE projects SET client_confirmed_at = 'x', client_confirmed_by = 'guest'", [], 'already_confirmed'],
    ['UPDATE projects SET delivered_at = NULL', [], 'not_delivered'],
    ['UPDATE projects SET final_folders = ?', [JSON.stringify([FINAL2])], 'not_delivered'],
    ["UPDATE projects SET archived_at = 'x'", [], null],
    ['UPDATE projects SET owner_picker_id = NULL', [], null],
    ["INSERT INTO revision_requests (id, project_id, picker_id, message, created_at) SELECT 'other', id, NULL, 'x', 'y' FROM projects", [], 'revision_open'],
  ];
  for (const [sql, args, want] of cases) {
    const env = setup();
    const p = await delivered(env);
    assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin()] }])).status, 200);
    landOnce(env, ROUND_INSERT, sql, ...args);
    const res = await submitRound(env, p.token, p.key, { expect: [{ k: F1, n: 1 }] });
    if (want) {
      assert.equal(res.status, 409, sql);
      assert.equal(await code(res), want, sql);
    } else {
      assert.ok([401, 403].includes(res.status), `${sql}: ${res.status}`);
    }
    assert.equal(roundRows(env).filter(r => r.marks).length, 0, sql);
    assert.equal(draftRows(env).length, 1, `${sql}: drafts kept`);
    assert.equal(env.NOTIFY_EMAIL.sent.length, 0, sql);
    invariant(env);
  }
});

test('races: submit and confirm sent together, and two submits together, never leave confirmed + open or two rounds', async () => {
  for (let i = 0; i < 4; i++) {
    const env = setup();
    const p = await delivered(env);
    assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin()] }])).status, 200);
    const body = { expect: [{ k: F1, n: 1 }] };
    const order = i % 2 ? [confirm(env, p.token, p.key), submitRound(env, p.token, p.key, body)] : [submitRound(env, p.token, p.key, body), confirm(env, p.token, p.key)];
    await Promise.all(order);
    invariant(env);
    const env2 = setup();
    const q = await delivered(env2);
    assert.equal((await putPins(env2, q.token, q.key, [{ photo_key: F1, marks: [pin()] }])).status, 200);
    const results = await Promise.all([submitRound(env2, q.token, q.key, body), submitRound(env2, q.token, q.key, body)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal(roundRows(env2).length, 1);
  }
});

// ─── 更換精修, seat reset ─────────────────────────────────────────────────────

test('after 更換精修 to 精修二: the round is resolved, the old finals refuse drafts, the new ones take them, and a second round can go', async () => {
  const env = setup();
  const p = await withRound(env);
  assert.equal((await deliver(env, p.id, [FINAL2])).status, 200);
  assert.ok(roundRows(env)[0].resolved_at);
  const s = await state(env, p.token, p.key);
  assert.equal(s.revision_open, false);
  assert.equal(s.revision_open_photos, null);
  let res = await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin()] }]);
  assert.equal(await code(res), 'not_in_finals');
  assert.equal((await putPins(env, p.token, p.key, [{ photo_key: G1, marks: [pin(0.4, 0.4, '再修')] }])).status, 200);
  res = await submitRound(env, p.token, p.key, { note: '第二輪', expect: [{ k: G1, n: 1 }] });
  assert.equal(res.status, 200);
  const second = roundRows(env)[1];
  assert.equal(second.finals, JSON.stringify([FINAL2]));
  assert.equal(roundRows(env)[0].finals, JSON.stringify([FINAL]));
});

test('a seat reset: the new seat holder sees the open round and the project\'s drafts (they belong to the project), the old key nothing', async () => {
  const env = setup();
  const p = await withRound(env);
  assert.equal((await call(env, `/api/admin/projects/${p.id}/reset-seat`, { method: 'POST', token: SECRET })).status, 200);
  const c = await claim(env, p.token, '王媽媽');
  assert.equal(c.res.status, 200);
  const s = await state(env, p.token, c.key);
  assert.equal(s.is_owner, true);
  assert.equal(s.revision_open_photos, 2);
  assert.equal(s.revision_message, '整體再亮一點');
  const old = await state(env, p.token, p.key);
  assert.ok(!('revision_drafts' in old));
  assert.equal(old.revision_message, null);
});

// ─── admin ───────────────────────────────────────────────────────────────────

test('admin detail: every request has kind, marks (parsed), finals (array), message_auto (boolean) and photo_count; text requests stay text', async () => {
  const env = setup();
  const p = await delivered(env);
  assert.equal((await reviseText(env, p.token, p.key, '舊式文字')).status, 200);
  assert.equal((await deliver(env, p.id)).status, 200);
  assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin(0.1, 0.2, '臉')] }])).status, 200);
  assert.equal((await submitRound(env, p.token, p.key, { expect: [{ k: F1, n: 1 }] })).status, 200);
  const d = await detail(env, p.id);
  assert.equal(d.revision_requests.length, 2);
  const [pins, text] = d.revision_requests;
  assert.equal(pins.kind, 'pins');
  assert.deepEqual(pins.marks, { [F1]: [{ x: 0.1, y: 0.2, note: '臉' }] });
  assert.deepEqual(pins.finals, [FINAL]);
  assert.equal(pins.message_auto, true);
  assert.equal(pins.message, AUTO);
  assert.equal(pins.photo_count, 1);
  assert.equal(pins.picker_name, '王小明');
  assert.equal(pins.resolved_at, null);
  assert.equal(text.kind, 'text');
  assert.equal(text.marks, null);
  assert.equal(text.finals, null);
  assert.equal(text.message_auto, false);
  assert.equal(text.photo_count, 0);
  assert.equal(text.message, '舊式文字');
  assert.ok(text.resolved_at);
  assert.equal(d.project.open_revision_count, 1);
  // other photographer / no token
  assert.equal((await call(env, `/api/admin/projects/${p.id}`)).status, 401);
});

// ─── before the migration ────────────────────────────────────────────────────

for (const [label, schema] of [['before the migration', BEFORE], ['with the ALTERs run but not the CREATE TABLE', HALF], ['with only the CREATE TABLE run', TABLE_ONLY]]) {
  test(`${label}: every existing route works; the new routes answer 500 revision_pins_unavailable and write nothing`, async () => {
    const env = setup({ schema });
    const p = await delivered(env);
    // the state: the feature is off (null), the rest as always
    let s = await state(env, p.token, p.key);
    assert.equal(s.mode, 'delivered');
    assert.equal(s.revision_drafts, null);
    assert.equal(s.revision_open_photos, null);
    const snap = dbSnapshot(env);
    const results = [
      await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin()] }]),
      await submitRound(env, p.token, p.key, { expect: [{ k: F1, n: 1 }] }),
      await rounds(env, p.token, p.key),
      await pick(env, 'GET', 'rounds/selection', p.token, { key: p.key }),
      await photo(env, p.token, p.key, 'selection', 'i=0&w=400'),
    ];
    for (const res of results) {
      assert.equal(res.status, 500, label);
      assert.equal(await code(res), 'revision_pins_unavailable', label);
    }
    assert.equal(dbSnapshot(env), snap);
    assert.equal(env.NOTIFY_EMAIL.sent.length, 0);
    // the seat is still checked first
    assert.equal((await putPins(env, p.token, undefined, [{ photo_key: F1, marks: [pin()] }])).status, 403);
    // the old text route, confirm, the admin detail, deliver, undeliver, reopen
    assert.equal((await reviseText(env, p.token, p.key, '請調亮')).status, 200);
    s = await state(env, p.token, p.key);
    assert.equal(s.revision_message, '請調亮');
    const d = await detail(env, p.id);
    assert.equal(d.revision_requests.length, 1);
    assert.equal(d.revision_requests[0].kind, 'text');
    assert.equal(d.revision_requests[0].marks, null);
    assert.equal(d.revision_requests[0].message_auto, false);
    assert.equal((await deliver(env, p.id, [FINAL2])).status, 200);
    assert.equal((await confirm(env, p.token, p.key)).status, 200);
    assert.equal((await admin(env, p.id, 'undeliver')).status, 200);
    assert.equal((await deliver(env, p.id)).status, 200);
    assert.equal((await admin(env, p.id, 'reopen')).status, 200);
    assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: PA, rating: 2 }] })).status, 200);
  });
}
