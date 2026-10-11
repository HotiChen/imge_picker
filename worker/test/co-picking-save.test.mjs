// Co-picking: what a collaborator may write (docs/co-picking.md, Who can do
// what + the save contract). The per-row rule: a collaborator changes only
// new rows and rows they last wrote; the owner changes anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECRET, call, MINE } from './pick-helpers.mjs';
import {
  setup, pick, claimed, one, rows, addCollaborator, withCollaborator, state, member, expire, removeC, sel, ago,
} from './co-picking-helpers.mjs';

const A = '20260819/a.jpg';
const B = '20260819/b.jpg';
const C = '20260819/c.jpg';
const put = (env, t, key, body) => pick(env, 'PUT', 'selections', t, { key, body });
const PIN = [{ x: 0.5, y: 0.5, note: 'skin' }];

test('a collaborator hearts, notes and pins new photos; the rows are theirs (updated_by)', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  const r = await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 1, note: 'bob note', marks: PIN }] });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, rejected: [] });
  const row = sel(env, p.project.id, A);
  assert.equal(row.rating, 1);
  assert.equal(row.note, 'bob note');
  assert.equal(row.updated_by, c.pickerId);
  assert.deepEqual(JSON.parse(row.marks), PIN);
});

test('a collaborator changes and un-hearts rows they last wrote', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 1, note: 'x' }, { photo_key: B, rating: 1 }] });
  let r = await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 3, note: 'y', marks: PIN }] });
  assert.deepEqual(await r.json(), { ok: true, rejected: [] });
  assert.equal(sel(env, p.project.id, A).rating, 3);
  r = await put(env, p.token, c.key, { delete: [A], upsert: [{ photo_key: B, rating: 0 }] });
  assert.deepEqual(await r.json(), { ok: true, rejected: [] });
  assert.equal(sel(env, p.project.id, A), undefined);
  assert.equal(sel(env, p.project.id, B), undefined);
});

test('not_yours: a collaborator\'s change to the owner\'s row is skipped, the rest of the batch applies', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  await put(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, note: 'owner' }, { photo_key: B, rating: 2, marks: PIN }] });
  const r = await put(env, p.token, c.key, {
    upsert: [{ photo_key: A, rating: 0 }, { photo_key: B, rating: 2, marks: [] }, { photo_key: C, rating: 1 }],
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.rejected.map(x => x.photo_key).sort(), [A, B]);
  for (const x of body.rejected) assert.equal(x.code, 'not_yours');
  assert.equal(sel(env, p.project.id, A).rating, 1);
  assert.equal(sel(env, p.project.id, A).note, 'owner');
  assert.equal(sel(env, p.project.id, A).updated_by, p.pickerId);
  assert.deepEqual(JSON.parse(sel(env, p.project.id, B).marks), PIN, 'pins untouched');
  assert.equal(sel(env, p.project.id, C).updated_by, c.pickerId);
});

test('not_yours: rating, note and pins each count as a change; a delete of the owner\'s row is refused', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  await put(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 2, note: 'n', marks: PIN }] });
  for (const item of [
    { photo_key: A, rating: 3, note: 'n' },
    { photo_key: A, rating: 2, note: 'other' },
    { photo_key: A, rating: 2, note: 'n', marks: [{ x: 0.1, y: 0.1, note: '' }] },
  ]) {
    const body = await (await put(env, p.token, c.key, { upsert: [item] })).json();
    assert.deepEqual(body.rejected, [{ photo_key: A, code: 'not_yours' }], JSON.stringify(item));
  }
  const del = await (await put(env, p.token, c.key, { delete: [A] })).json();
  assert.deepEqual(del.rejected, [{ photo_key: A, code: 'not_yours' }]);
  const row = sel(env, p.project.id, A);
  assert.equal(row.rating, 2);
  assert.equal(row.note, 'n');
  assert.equal(row.updated_by, p.pickerId);
});

test('not_yours: re-sending the identical value is a no-op — not rejected, and the row stays the owner\'s', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  await put(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 2, note: 'n', marks: PIN }] });
  const before = sel(env, p.project.id, A);
  for (const item of [
    { photo_key: A, rating: 2, note: 'n' },
    { photo_key: A, rating: 2, note: 'n', marks: PIN },
  ]) {
    const body = await (await put(env, p.token, c.key, { upsert: [item] })).json();
    assert.deepEqual(body, { ok: true, rejected: [] });
  }
  assert.deepEqual(sel(env, p.project.id, A), before);
});

test('not_yours: another collaborator\'s row is not yours either; a row by an unknown author is not yours', async () => {
  const env = setup();
  const p = await claimed(env);
  const a = await addCollaborator(env, p, 'A');
  const b = await addCollaborator(env, p, 'B');
  await put(env, p.token, a.key, { upsert: [{ photo_key: A, rating: 1 }] });
  const body = await (await put(env, p.token, b.key, { upsert: [{ photo_key: A, rating: 0 }] })).json();
  assert.deepEqual(body.rejected, [{ photo_key: A, code: 'not_yours' }]);
  env.DB._db.prepare("INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at) VALUES (?, ?, 1, '', 'unknown-picker', 'then')").run(p.project.id, B);
  const legacy = await (await put(env, p.token, b.key, { delete: [B] })).json();
  assert.deepEqual(legacy.rejected, [{ photo_key: B, code: 'not_yours' }]);
  assert.ok(sel(env, p.project.id, B));
});

test('the row rule is per row: the owner editing only the note makes the row the owner\'s', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 1 }] });
  await put(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, note: 'owner note' }] });
  const body = await (await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 0 }] })).json();
  assert.deepEqual(body.rejected, [{ photo_key: A, code: 'not_yours' }]);
});

test('the owner changes any row, a collaborator\'s included, and the owner\'s response has no rejected list', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 1, note: 'bob' }, { photo_key: B, rating: 1 }] });
  const r = await put(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 4, note: 'mine now' }], delete: [B] });
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(sel(env, p.project.id, A).updated_by, p.pickerId);
  assert.equal(sel(env, p.project.id, B), undefined);
});

test('a removed collaborator\'s hearts stay, and the owner can un-heart them', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 1 }] });
  await removeC(env, p.token, p.key, c.pickerId);
  assert.equal(sel(env, p.project.id, A).rating, 1);
  await put(env, p.token, p.key, { delete: [A] });
  assert.equal(sel(env, p.project.id, A), undefined);
});

test('expired, removed, reset-seat and a foreign key cannot save (403); nothing lands', async () => {
  const env = setup();
  const p = await claimed(env);
  const exp = await addCollaborator(env, p, 'E');
  expire(env, exp.pickerId);
  const rem = await addCollaborator(env, p, 'R');
  await removeC(env, p.token, p.key, rem.pickerId);
  const other = await claimed(env, { title: 'O' });
  const otherC = await addCollaborator(env, other, 'X');
  for (const key of [exp.key, rem.key, otherC.key]) {
    const r = await put(env, p.token, key, { upsert: [{ photo_key: A, rating: 1 }] });
    assert.equal(r.status, 403);
  }
  assert.equal(rows(env, 'SELECT * FROM selections WHERE project_id = ?', p.project.id).length, 0);
});

test('phase and archive gates hold for a collaborator: 409 retouching, 401 archived', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  env.DB._db.prepare("UPDATE projects SET phase = 'retouching' WHERE id = ?").run(p.project.id);
  const r = await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 1 }] });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'retouching');
  env.DB._db.prepare("UPDATE projects SET phase = 'submitted', archived_at = ? WHERE id = ?").run(ago(1), p.project.id);
  assert.equal((await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 1 }] })).status, 401);
  env.DB._db.prepare('UPDATE projects SET archived_at = NULL WHERE id = ?').run(p.project.id);
  // submitted is open: the save lands and raises modified_after_submit
  assert.equal((await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 1 }] })).status, 200);
  assert.equal(one(env, 'SELECT modified_after_submit AS m FROM projects WHERE id = ?', p.project.id).m, 1);
});

test('a collaborator\'s save stays inside the link\'s folders', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  const r = await put(env, p.token, c.key, { upsert: [{ photo_key: '20260901/x.jpg', rating: 1 }] });
  assert.equal(r.status, 403);
  void MINE;
});

test('caps are per project, shared: the owner\'s and the collaborator\'s hearts count together (500)', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  const ins = env.DB._db.prepare("INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at) VALUES (?, ?, 1, '', ?, 'x')");
  for (let i = 0; i < 499; i++) ins.run(p.project.id, `20260819/o${i}.jpg`, p.pickerId);
  assert.equal((await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 1 }] })).status, 200);
  const r = await put(env, p.token, c.key, { upsert: [{ photo_key: B, rating: 1 }] });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'selection_cap');
  // un-hearting their own still works over the cap
  assert.equal((await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 0 }] })).status, 200);
});

test('caps: the row cap (1000) and the pins cap (300) are shared too', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  const ins = env.DB._db.prepare("INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at, marks) VALUES (?, ?, 0, 'n', ?, 'x', ?)");
  for (let i = 0; i < 1000; i++) ins.run(p.project.id, `20260819/r${i}.jpg`, p.pickerId, null);
  let r = await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 1 }] });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'row_cap');
  env.DB._db.prepare('DELETE FROM selections').run();
  const pins10 = JSON.stringify(Array.from({ length: 10 }, () => ({ x: 0.1, y: 0.1, note: '' })));
  const ins2 = env.DB._db.prepare("INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at, marks) VALUES (?, ?, 1, '', ?, 'x', ?)");
  for (let i = 0; i < 30; i++) ins2.run(p.project.id, `20260819/m${i}.jpg`, p.pickerId, pins10);
  r = await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 1, marks: PIN }] });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'marks_cap');
});

test('a cap refusal is all-or-nothing for a collaborator too: nothing in the batch lands', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  const ins = env.DB._db.prepare("INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at) VALUES (?, ?, 1, '', ?, 'x')");
  for (let i = 0; i < 500; i++) ins.run(p.project.id, `20260819/o${i}.jpg`, p.pickerId);
  const r = await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 0, note: 'note only' }, { photo_key: B, rating: 1 }] });
  assert.equal(r.status, 409);
  assert.equal(sel(env, p.project.id, A), undefined);
});

test('a skipped item does not count for the caps: the owner\'s row keeps its own heart in the count', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  const ins = env.DB._db.prepare("INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at) VALUES (?, ?, 1, '', ?, 'x')");
  for (let i = 0; i < 499; i++) ins.run(p.project.id, `20260819/o${i}.jpg`, p.pickerId);
  ins.run(p.project.id, A, p.pickerId); // 500, A is the owner's
  // un-hearting A is not theirs, so it frees nothing: B would be 501
  const r = await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 0 }, { photo_key: B, rating: 1 }] });
  assert.equal(r.status, 409);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections WHERE rating > 0').n, 500);
});

// ─── Inside the statement ──────────────────────────────────────────────────
// The JS check reads the rows first; the owner can write between that read
// and the batch. Simulated by a DB whose batch() lets the owner's write land
// first: the statements themselves must still skip the owner's row.

function raceBefore(env, sqlRun) {
  const real = env.DB.batch.bind(env.DB);
  let armed = true;
  env.DB.batch = statements => {
    if (armed) { armed = false; sqlRun(); }
    return real(statements);
  };
}

test('race: the owner writes the row between the check and the batch — the collaborator\'s upsert does not overwrite it', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 1, note: 'bob' }] });
  raceBefore(env, () => env.DB._db.prepare("UPDATE selections SET rating = 5, note = 'owner wins', updated_by = ? WHERE photo_key = ?").run(p.pickerId, A));
  const r = await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 2, note: 'bob again', marks: PIN }, { photo_key: B, rating: 1 }] });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.rejected, [{ photo_key: A, code: 'not_yours' }]);
  const row = sel(env, p.project.id, A);
  assert.equal(row.rating, 5);
  assert.equal(row.note, 'owner wins');
  assert.equal(row.marks, null);
  assert.equal(row.updated_by, p.pickerId);
  assert.equal(sel(env, p.project.id, B).updated_by, c.pickerId);
});

test('race: the owner takes the row between the check and the batch — the collaborator\'s delete does not remove it', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 1 }] });
  raceBefore(env, () => env.DB._db.prepare('UPDATE selections SET updated_by = ? WHERE photo_key = ?').run(p.pickerId, A));
  const body = await (await put(env, p.token, c.key, { delete: [A] })).json();
  assert.deepEqual(body.rejected, [{ photo_key: A, code: 'not_yours' }]);
  assert.ok(sel(env, p.project.id, A));
});

test('race: the owner takes a row between the check and the batch — the caps count it as it stands, all-or-nothing', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  const ins = env.DB._db.prepare("INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at) VALUES (?, ?, 1, '', ?, 'x')");
  for (let i = 0; i < 499; i++) ins.run(p.project.id, `20260819/o${i}.jpg`, p.pickerId);
  await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 1 }] }); // 500, A is Bob's
  // Bob un-hearts A (his, as read) and hearts B; the owner takes A first
  raceBefore(env, () => env.DB._db.prepare('UPDATE selections SET updated_by = ? WHERE photo_key = ?').run(p.pickerId, A));
  const r = await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 0, note: 'x' }, { photo_key: B, rating: 1 }] });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'selection_cap');
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections WHERE rating > 0').n, 500);
  assert.equal(sel(env, p.project.id, B), undefined);
});

test('race: a skipped item on the owner\'s row is not counted twice — the rest of the batch still fits and lands', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  const ins = env.DB._db.prepare("INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at) VALUES (?, ?, 1, '', ?, 'x')");
  for (let i = 0; i < 499; i++) ins.run(p.project.id, `20260819/o${i}.jpg`, p.pickerId);
  await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 1 }] }); // 500, A is Bob's
  raceBefore(env, () => env.DB._db.prepare('UPDATE selections SET updated_by = ? WHERE photo_key = ?').run(p.pickerId, A));
  const r = await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 2 }, { photo_key: B, rating: 0, note: 'later' }] });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).rejected, [{ photo_key: A, code: 'not_yours' }]);
  assert.equal(sel(env, p.project.id, A).rating, 1);
  assert.equal(sel(env, p.project.id, B).note, 'later');
});

test('race: a delete skipped on the owner\'s row still counts that row for the caps', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  const ins = env.DB._db.prepare("INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at) VALUES (?, ?, 1, '', ?, 'x')");
  for (let i = 0; i < 499; i++) ins.run(p.project.id, `20260819/o${i}.jpg`, p.pickerId);
  await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 1 }] });
  raceBefore(env, () => env.DB._db.prepare('UPDATE selections SET updated_by = ? WHERE photo_key = ?').run(p.pickerId, A));
  const r = await put(env, p.token, c.key, { delete: [A], upsert: [{ photo_key: B, rating: 1 }] });
  assert.equal(r.status, 409);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections WHERE rating > 0').n, 500);
  assert.ok(sel(env, p.project.id, A));
});

test('race: the collaborator is removed between the check and the batch — nothing lands (403)', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  raceBefore(env, () => env.DB._db.prepare('UPDATE project_collaborators SET revoked_at = ? WHERE picker_id = ?').run(ago(1), c.pickerId));
  const r = await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 1 }] });
  assert.equal(r.status, 403);
  assert.equal(sel(env, p.project.id, A), undefined);
});

test('race: the membership expires, or the seat is reset, between the check and the batch — nothing lands', async () => {
  for (const sql of [
    env => env.DB._db.prepare('UPDATE project_collaborators SET expires_at = ?').run(ago(60000)),
    env => env.DB._db.prepare('UPDATE projects SET owner_picker_id = NULL').run(),
    env => env.DB._db.prepare("UPDATE project_collaborators SET invited_by = 'someone-else'").run(),
  ]) {
    const env = setup();
    const { p, c } = await withCollaborator(env);
    raceBefore(env, () => sql(env));
    const r = await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 1 }], delete: [B] });
    assert.equal(r.status, 403);
    assert.equal(rows(env, 'SELECT * FROM selections').length, 0);
  }
});

test('race: the membership of the caller in ANOTHER project does not open this one inside the statement', async () => {
  // the gate names the project: a membership row for this picker id in
  // another project (hand-made, never by a route) does not count
  const env = setup();
  const { p, c } = await withCollaborator(env);
  raceBefore(env, () => env.DB._db.prepare("UPDATE project_collaborators SET project_id = 'other' WHERE picker_id = ?").run(c.pickerId));
  assert.equal((await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 1 }] })).status, 403);
  assert.equal(sel(env, p.project.id, A), undefined);
});

test('the per-row rule is in the SQL: every collaborator write statement names updated_by', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 1 }] });
  env.DB._sql.length = 0;
  await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 2, marks: PIN }], delete: [B] });
  const writes = env.DB._writes().filter(s => /selections/.test(s) && !/^\s*UPDATE projects/i.test(s));
  assert.ok(writes.length >= 3, 'insert, marks, delete');
  for (const s of writes) assert.match(s, /updated_by IS NOT \?2|updated_by = \?2/, s.slice(0, 80));
  for (const s of env.DB._writes()) assert.match(s, /project_collaborators/, 'every statement re-checks the membership');
});

test('submit stays owner-only: a collaborator gets 403 not_owner', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  await put(env, p.token, c.key, { upsert: [{ photo_key: A, rating: 1 }] });
  const r = await pick(env, 'POST', 'submit', p.token, { key: c.key, body: { relationship: '本人' } });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'not_owner');
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM submissions').n, 0);
  assert.equal(one(env, 'SELECT phase FROM projects WHERE id = ?', p.project.id).phase, 'picking');
  // and the owner still submits what the collaborator hearted
  const ok = await pick(env, 'POST', 'submit', p.token, { key: p.key, body: { relationship: '本人' } });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).count, 1);
});

test('a collaborator cannot reach any owner-only route after delivery either', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  await call(env, `/api/admin/projects/${p.project.id}/start-retouch`, { method: 'POST', token: SECRET });
  env.DB._db.prepare("UPDATE projects SET phase = 'retouching', delivered_at = ?, final_folders = ? WHERE id = ?").run(ago(1), JSON.stringify([MINE]), p.project.id);
  for (const [method, route, body] of [
    ['POST', 'confirm', {}], ['POST', 'revision', { message: 'x' }], ['PUT', 'revision-pins', { items: [{ photo_key: A, marks: PIN }] }],
    ['POST', 'revision-round', {}], ['GET', 'rounds'], ['POST', 'interest', { product_id: 'x' }], ['GET', 'orders'],
    ['POST', 'orders', {}], ['POST', 'claim', { name: 'x' }],
  ]) {
    const r = await pick(env, method, route, p.token, { key: c.key, body });
    assert.ok([403, 409].includes(r.status), `${method} ${route}: ${r.status}`);
  }
  assert.equal(one(env, 'SELECT client_confirmed_at AS x FROM projects WHERE id = ?', p.project.id).x, null);
  assert.equal(one(env, 'SELECT owner_picker_id AS o FROM projects WHERE id = ?', p.project.id).o, p.pickerId);
});

test('member() helper sanity: a fresh collaborator is active', async () => {
  const env = setup();
  const { c } = await withCollaborator(env);
  assert.equal(member(env, c.pickerId).revoked_at, null);
  void state;
});
