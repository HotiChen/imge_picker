// Co-picking: fixes from the security review of batch 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECRET, call, claim, createProject } from './pick-helpers.mjs';
import {
  setup, pick, claimed, one, addCollaborator, withCollaborator, state, member, list, invite, join,
  patchC, removeC, renewal, decide, expire, ago, beforeMigration, HOUR, DAY, raceBeforeStatement,
} from './co-picking-helpers.mjs';

const A = '20260819/a.jpg';
const put = (env, t, key, body) => pick(env, 'PUT', 'selections', t, { key, body });
const setRequest = (env, id, v) => env.DB._db.prepare('UPDATE project_collaborators SET renewal_requested_at = ? WHERE picker_id = ?').run(v, id);

// ─── (a) a previous owner's name stays out of the guest state ──────────────

test('(a) guest state: a row by the previous owner reads role other with no name; the admin still sees the name', async () => {
  const env = setup();
  const p = await claimed(env, {}, '舊主人');
  await put(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  await call(env, `/api/admin/projects/${p.project.id}/reset-seat`, { method: 'POST', token: SECRET });
  const o2 = await claim(env, p.token, '新主人');
  const c = await addCollaborator(env, { ...p, key: o2.key }, 'Bob');
  for (const key of [o2.key, c.key]) {
    const s = await state(env, p.token, key);
    assert.deepEqual(s.selections[0].by, { id: p.pickerId, name: null, role: 'other' });
    assert.ok(!JSON.stringify(s.selections).includes('舊主人'));
  }
  const d = await (await call(env, `/api/admin/projects/${p.project.id}`, { token: SECRET })).json();
  assert.deepEqual(d.selections[0].by, { id: p.pickerId, name: '舊主人', role: 'other' });
});

// ─── (b) a declined renewal cools down ─────────────────────────────────────

async function declined(env) {
  const { p, c } = await withCollaborator(env);
  expire(env, c.pickerId);
  await renewal(env, p.token, c.key);
  assert.equal((await decide(env, p.token, p.key, c.pickerId, { approve: false })).status, 200);
  return { p, c };
}

test('(b) after a decline, asking again is refused 409 renewal_declined for 24 hours', async () => {
  const env = setup();
  const { p, c } = await declined(env);
  assert.match(member(env, c.pickerId).renewal_requested_at, /^declined:\d{4}-/);
  const r = await renewal(env, p.token, c.key);
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.code, 'renewal_declined');
  assert.ok(Math.abs(Date.parse(body.until) - (Date.now() + DAY)) < 5000);
  assert.match(member(env, c.pickerId).renewal_requested_at, /^declined:/, 'still the marker');
  const s = await state(env, p.token, c.key);
  assert.equal(s.renewal_requested, false);
  assert.equal(s.can_request_renewal, false);
  assert.equal(s.renewal_declined_until, body.until);
});

test('(b) once the cooldown has passed the person may ask again', async () => {
  const env = setup();
  const { p, c } = await declined(env);
  setRequest(env, c.pickerId, `declined:${ago(DAY + 1000)}`);
  const s = await state(env, p.token, c.key);
  assert.equal(s.can_request_renewal, true);
  assert.equal(s.renewal_declined_until, null);
  assert.equal((await renewal(env, p.token, c.key)).status, 200);
  const v = member(env, c.pickerId).renewal_requested_at;
  assert.ok(!v.startsWith('declined:'));
  assert.equal((await state(env, p.token, c.key)).renewal_requested, true);
  // still inside: 23 h ago
  setRequest(env, c.pickerId, `declined:${ago(DAY - HOUR)}`);
  assert.equal((await renewal(env, p.token, c.key)).status, 409);
});

test('(b) the marker is no pending request: list, pending_renewals, admin, decision', async () => {
  const env = setup();
  const { p, c } = await declined(env);
  const l = await (await list(env, p.token, p.key)).json();
  assert.equal(l.pending_renewals, 0);
  assert.equal(l.collaborators[0].renewal_requested_at, null);
  const d = await (await call(env, `/api/admin/projects/${p.project.id}`, { token: SECRET })).json();
  assert.equal(d.collaborators[0].renewal_requested_at, null);
  for (const body of [{ approve: true, window_days: 7 }, { approve: false }]) {
    const r = await decide(env, p.token, p.key, c.pickerId, body);
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.equal((await r.json()).code, 'no_renewal_request');
  }
  assert.match(member(env, c.pickerId).renewal_requested_at, /^declined:/);
  assert.equal((await state(env, p.token, c.key)).role, 'viewer');
});

test('(b) removed (or the seat reset) between the check and the write while cooling down: 403, not 409', async () => {
  for (const race of [
    (env, c) => env.DB._db.prepare('UPDATE project_collaborators SET revoked_at = ? WHERE picker_id = ?').run(ago(1), c.pickerId),
    env => env.DB._db.prepare('UPDATE projects SET owner_picker_id = NULL').run(),
  ]) {
    const env = setup();
    const { p, c } = await declined(env);
    raceBeforeStatement(env, /^UPDATE project_collaborators SET renewal_requested_at = CASE/, () => race(env, c));
    const r = await renewal(env, p.token, c.key);
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'renewal_not_allowed');
  }
});

test('(b) PATCH and DELETE still clear the marker', async () => {
  const env = setup();
  let { p, c } = await declined(env);
  assert.equal((await patchC(env, p.token, p.key, c.pickerId, { window_days: 1 })).status, 200);
  assert.equal(member(env, c.pickerId).renewal_requested_at, null);
  const env2 = setup();
  ({ p, c } = await declined(env2));
  assert.equal((await removeC(env2, p.token, p.key, c.pickerId)).status, 200);
  assert.equal(member(env2, c.pickerId).renewal_requested_at, null);
});

// ─── (c) deleting a project takes its co-picking rows; old failures go ─────

test('(c) deleting a project deletes its collaborators, invites and join failures (only its own)', async () => {
  const env = setup();
  const p = await claimed(env);
  await addCollaborator(env, p, 'Bob');
  await invite(env, p.token, p.key);
  await join(env, p.token, '00000000', 'X', { ip: '192.0.2.1' });
  const q = await claimed(env, { title: 'Q' });
  await addCollaborator(env, q, 'Zed');
  await join(env, q.token, '00000000', 'X', { ip: '192.0.2.2' });
  const res = await call(env, `/api/admin/projects/${p.project.id}`, { method: 'DELETE', token: SECRET });
  assert.equal(res.status, 200);
  for (const t of ['project_collaborators', 'pick_invites', 'pick_join_failures']) {
    assert.equal(one(env, `SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?`, p.project.id).n, 0, t);
    assert.ok(one(env, `SELECT COUNT(*) AS n FROM ${t} WHERE project_id = ?`, q.project.id).n > 0, `${t} of another project stays`);
  }
});

test('(c) deleting a project works before the co-picking migration', async () => {
  const env = beforeMigration();
  const p = await createProject(env);
  const res = await call(env, `/api/admin/projects/${p.project.id}`, { method: 'DELETE', token: SECRET });
  assert.equal(res.status, 200);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM projects').n, 0);
});

test('(c) a project with a submission is still refused, and its co-picking rows stay', async () => {
  const env = setup();
  const p = await claimed(env);
  await addCollaborator(env, p, 'Bob');
  await put(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  await pick(env, 'POST', 'submit', p.token, { key: p.key, body: { relationship: '本人' } });
  assert.equal((await call(env, `/api/admin/projects/${p.project.id}`, { method: 'DELETE', token: SECRET })).status, 409);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM project_collaborators').n, 1);
});

test('(c) any join removes failure rows older than a day from every project', async () => {
  const env = setup();
  const p = await claimed(env);
  const q = await claimed(env, { title: 'Q' });
  const ins = env.DB._db.prepare('INSERT INTO pick_join_failures (project_id, bucket, created_at) VALUES (?, ?, ?)');
  ins.run(q.project.id, 'p', ago(DAY + 60000));
  ins.run('gone-project', 'p', ago(DAY + 60000));
  ins.run(q.project.id, 'p', ago(HOUR));
  await join(env, p.token, '00000000', 'X', { ip: '192.0.2.3' });
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM pick_join_failures WHERE project_id <> ?', p.project.id).n, 1);
});

// ─── (d) why a collaborator's save is refused ──────────────────────────────

test('(d) an expired collaborator\'s save: 403 collaborator_expired; removed: 403 collaborator_removed; a viewer as before', async () => {
  const env = setup();
  const p = await claimed(env);
  const e = await addCollaborator(env, p, 'E');
  expire(env, e.pickerId);
  const r = await addCollaborator(env, p, 'R');
  await removeC(env, p.token, p.key, r.pickerId);
  let res = await put(env, p.token, e.key, { upsert: [{ photo_key: A, rating: 1 }] });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'collaborator_expired');
  res = await put(env, p.token, r.key, { upsert: [{ photo_key: A, rating: 1 }] });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'collaborator_removed');
  for (const key of [undefined, 'junk']) {
    res = await put(env, p.token, key, { upsert: [{ photo_key: A, rating: 1 }] });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: '只有挑選人可以修改' });
  }
  // a seat reset ends the membership as removed
  await call(env, `/api/admin/projects/${p.project.id}/reset-seat`, { method: 'POST', token: SECRET });
  const c2 = { key: e.key };
  res = await put(env, p.token, c2.key, { upsert: [{ photo_key: A, rating: 1 }] });
  assert.equal((await res.json()).code, 'collaborator_removed');
});
