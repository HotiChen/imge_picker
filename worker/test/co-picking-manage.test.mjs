// Co-picking: the owner's list, period changes, removal, renewal requests and
// decisions (docs/co-picking.md, API + Renewal and slots).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECRET, call, claim } from './pick-helpers.mjs';
import {
  setup, pick, claimed, one, invite, join, addCollaborator, withCollaborator, state, member, list,
  patchC, removeC, renewal, decide, expire, ago, later, DAY, raceBeforeStatement,
} from './co-picking-helpers.mjs';

const A = '20260819/a.jpg';

// ─── GET /api/pick/collaborators ───────────────────────────────────────────

test('list: the owner sees each collaborator (name, joined, valid until, status, last seen, renewal) and the unspent invites, no codes', async () => {
  const env = setup();
  const p = await claimed(env);
  const bob = await addCollaborator(env, p, 'Bob', 7);
  const amy = await addCollaborator(env, p, 'Amy', null);
  await removeC(env, p.token, p.key, amy.pickerId);
  const inv = await invite(env, p.token, p.key, { window_days: 1 });
  const res = await list(env, p.token, p.key);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['collaborators', 'invites', 'max', 'pending_renewals']);
  assert.equal(body.max, 2);
  assert.equal(body.pending_renewals, 0);
  assert.equal(body.invites.pending, 1);
  assert.equal(body.invites.soonest_expires_at, inv.json.expires_at);
  assert.equal(body.collaborators.length, 2);
  const [b, a] = body.collaborators;
  assert.deepEqual(Object.keys(b).sort(), ['expires_at', 'joined_at', 'last_seen_at', 'name', 'picker_id', 'renewal_requested_at', 'revoked_at', 'status']);
  assert.equal(b.picker_id, bob.pickerId);
  assert.equal(b.name, 'Bob');
  assert.equal(b.status, 'active');
  assert.equal(b.expires_at, bob.json.expires_at);
  assert.ok(b.joined_at);
  assert.equal(a.name, 'Amy');
  assert.equal(a.status, 'removed');
  assert.ok(a.revoked_at);
  expire(env, bob.pickerId);
  const after = await (await list(env, p.token, p.key)).json();
  assert.equal(after.collaborators[0].status, 'expired');
  assert.ok(!JSON.stringify(after).includes(inv.json.code));
});

test('list: owner only — viewer, collaborator and a foreign key get 403 not_owner', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  const other = await claimed(env, { title: 'B' });
  for (const key of [undefined, c.key, other.key, 'junk']) {
    const res = await list(env, p.token, key);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'not_owner');
  }
});

test('list: after reset-seat the new owner sees none of the old owner\'s collaborators', async () => {
  const env = setup();
  const { p } = await withCollaborator(env);
  await call(env, `/api/admin/projects/${p.project.id}/reset-seat`, { method: 'POST', token: SECRET });
  const o2 = await claim(env, p.token, '新主人');
  const body = await (await list(env, p.token, o2.key)).json();
  assert.deepEqual(body.collaborators, []);
  assert.equal(body.invites.pending, 0);
  assert.equal(body.invites.soonest_expires_at, null);
});

test('last_seen_at moves when an active collaborator reads the state', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  assert.equal(member(env, c.pickerId).last_seen_at, null);
  await state(env, p.token, c.key);
  assert.ok(member(env, c.pickerId).last_seen_at);
});

// ─── PATCH /api/pick/collaborators/:id ─────────────────────────────────────

test('patch: the owner changes the period, from now; effective on the very next request', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env, {}, 7);
  const r = await patchC(env, p.token, p.key, c.pickerId, { window_days: 1 });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.collaborator.picker_id, c.pickerId);
  assert.ok(Math.abs(Date.parse(body.collaborator.expires_at) - (Date.now() + DAY)) < 5000);
  assert.equal(member(env, c.pickerId).expires_at, body.collaborator.expires_at);
  assert.equal((await patchC(env, p.token, p.key, c.pickerId, { window_days: null })).status, 200);
  assert.equal(member(env, c.pickerId).expires_at, null);
  // an expiry the next request sees
  expire(env, c.pickerId);
  assert.equal((await state(env, p.token, c.key)).role, 'viewer');
  assert.equal((await pick(env, 'PUT', 'selections', p.token, { key: c.key, body: { upsert: [{ photo_key: A, rating: 1 }] } })).status, 403);
});

test('patch: bad window 400, unknown picker 404, a removed one 409 collaborator_removed, non-owners 403', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  const other = await claimed(env, { title: 'B' });
  const otherC = await addCollaborator(env, other, 'Zed');
  assert.equal((await patchC(env, p.token, p.key, c.pickerId, { window_days: 3 })).status, 400);
  assert.equal((await patchC(env, p.token, p.key, c.pickerId, {})).status, 400);
  assert.equal((await patchC(env, p.token, p.key, 'nobody', { window_days: 1 })).status, 404);
  // a collaborator of another project is not found here
  assert.equal((await patchC(env, p.token, p.key, otherC.pickerId, { window_days: 1 })).status, 404);
  assert.equal(member(env, otherC.pickerId).expires_at, otherC.json.expires_at);
  // the owner's own id is not a collaborator
  assert.equal((await patchC(env, p.token, p.key, p.pickerId, { window_days: 1 })).status, 404);
  for (const key of [c.key, undefined, other.key]) {
    const r = await patchC(env, p.token, key, c.pickerId, { window_days: null });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'not_owner');
  }
  await removeC(env, p.token, p.key, c.pickerId);
  const r = await patchC(env, p.token, p.key, c.pickerId, { window_days: 7 });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'collaborator_removed');
  assert.equal(member(env, c.pickerId).revoked_at != null, true);
});

test('patch: re-activating an expired collaborator takes a slot (same counting rule)', async () => {
  const env = setup();
  const p = await claimed(env);
  const a = await addCollaborator(env, p, 'A');
  expire(env, a.pickerId);
  await addCollaborator(env, p, 'B');
  await invite(env, p.token, p.key);
  const r = await patchC(env, p.token, p.key, a.pickerId, { window_days: 7 });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'collaborator_limit');
  assert.ok(Date.parse(member(env, a.pickerId).expires_at) < Date.now());
  // the active one can still be changed
  const b = one(env, "SELECT picker_id FROM project_collaborators WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)", new Date().toISOString());
  assert.equal((await patchC(env, p.token, p.key, b.picker_id, { window_days: 1 })).status, 200);
});

// ─── DELETE /api/pick/collaborators/:id ────────────────────────────────────

test('delete: the owner removes a collaborator; the very next request from that key is a viewer\'s; the hearts stay', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  await pick(env, 'PUT', 'selections', p.token, { key: c.key, body: { upsert: [{ photo_key: A, rating: 1, note: 'bob' }] } });
  const r = await removeC(env, p.token, p.key, c.pickerId);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.collaborator.status, 'removed');
  const s = await state(env, p.token, c.key);
  assert.equal(s.role, 'viewer');
  assert.equal(s.my_status, 'removed');
  assert.equal(s.can_request_renewal, false);
  assert.deepEqual(s.selections, [{ photo_key: A, rating: 1 }], 'a viewer\'s list, no notes, no by');
  const save = await pick(env, 'PUT', 'selections', p.token, { key: c.key, body: { upsert: [{ photo_key: A, rating: 0 }] } });
  assert.equal(save.status, 403);
  assert.equal(one(env, 'SELECT rating FROM selections WHERE photo_key = ?', A).rating, 1, 'the selection belongs to the project');
  // removing again is a no-op 200 and keeps the first time
  const first = member(env, c.pickerId).revoked_at;
  assert.equal((await removeC(env, p.token, p.key, c.pickerId)).status, 200);
  assert.equal(member(env, c.pickerId).revoked_at, first);
});

test('delete: non-owners 403, unknown 404, another project\'s collaborator 404', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  const other = await claimed(env, { title: 'B' });
  const otherC = await addCollaborator(env, other, 'Zed');
  for (const key of [c.key, undefined, other.key]) assert.equal((await removeC(env, p.token, key, c.pickerId)).status, 403);
  assert.equal((await removeC(env, p.token, p.key, 'nobody')).status, 404);
  assert.equal((await removeC(env, p.token, p.key, otherC.pickerId)).status, 404);
  assert.equal(member(env, otherC.pickerId).revoked_at, null);
  // a collaborator cannot remove themself or another through their own key
  assert.equal(member(env, c.pickerId).revoked_at, null);
});

test('reset-seat ends every collaborator at once, with no write to their rows', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  const before = member(env, c.pickerId);
  await call(env, `/api/admin/projects/${p.project.id}/reset-seat`, { method: 'POST', token: SECRET });
  assert.deepEqual(member(env, c.pickerId), before);
  const s = await state(env, p.token, c.key);
  assert.equal(s.role, 'viewer');
  assert.equal(s.can_edit, false);
  assert.equal(s.can_request_renewal, false);
  assert.equal((await pick(env, 'PUT', 'selections', p.token, { key: c.key, body: { upsert: [{ photo_key: A, rating: 1 }] } })).status, 403);
  // and a new owner who claims does not revive them
  await claim(env, p.token, '新主人');
  assert.equal((await state(env, p.token, c.key)).role, 'viewer');
  assert.equal((await renewal(env, p.token, c.key)).status, 403);
});

// ─── POST /api/pick/renewal ────────────────────────────────────────────────

test('renewal: an expired collaborator sees can_request_renewal and asks once; a repeat is a no-op 200', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  expire(env, c.pickerId);
  const s = await state(env, p.token, c.key);
  assert.equal(s.role, 'viewer');
  assert.equal(s.my_status, 'expired');
  assert.equal(s.can_request_renewal, true);
  assert.equal(s.renewal_requested, false);
  assert.equal(s.can_edit, false);
  const r = await renewal(env, p.token, c.key);
  assert.equal(r.status, 200);
  const at = member(env, c.pickerId).renewal_requested_at;
  assert.ok(at);
  assert.equal((await r.json()).renewal_requested_at, at);
  assert.equal((await renewal(env, p.token, c.key)).status, 200);
  assert.equal(member(env, c.pickerId).renewal_requested_at, at, 'kept the first');
  const s2 = await state(env, p.token, c.key);
  assert.equal(s2.renewal_requested, true);
  const l = await (await list(env, p.token, p.key)).json();
  assert.equal(l.pending_renewals, 1);
  assert.equal(l.collaborators[0].renewal_requested_at, at);
});

test('renewal: anyone else gets 403 — active, removed, viewer, no key, the owner', async () => {
  const env = setup();
  const p = await claimed(env);
  const active = await addCollaborator(env, p, 'A');
  const removed = await addCollaborator(env, p, 'R');
  expire(env, removed.pickerId);
  await removeC(env, p.token, p.key, removed.pickerId);
  for (const key of [active.key, removed.key, undefined, 'junk', p.key]) {
    const r = await renewal(env, p.token, key);
    assert.equal(r.status, 403, String(key));
    assert.equal((await r.json()).code, 'renewal_not_allowed');
  }
  assert.equal(member(env, active.pickerId).renewal_requested_at, null);
  assert.equal(member(env, removed.pickerId).renewal_requested_at, null);
  const s = await state(env, p.token, active.key);
  assert.equal(s.my_status, 'active');
  assert.equal(s.can_request_renewal, false);
});

test('renewal race: removed between the check and the write — nothing is asked (403)', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  expire(env, c.pickerId);
  raceBeforeStatement(env, /^UPDATE project_collaborators SET renewal_requested_at = COALESCE/, () =>
    env.DB._db.prepare('UPDATE project_collaborators SET revoked_at = ? WHERE picker_id = ?').run(ago(1), c.pickerId));
  const r = await renewal(env, p.token, c.key);
  assert.equal(r.status, 403);
  assert.equal(member(env, c.pickerId).renewal_requested_at, null);
});

test('renewal race: the seat is reset between the check and the write — nothing is asked (403)', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  expire(env, c.pickerId);
  raceBeforeStatement(env, /^UPDATE project_collaborators SET renewal_requested_at = COALESCE/, () =>
    env.DB._db.prepare('UPDATE projects SET owner_picker_id = NULL').run());
  assert.equal((await renewal(env, p.token, c.key)).status, 403);
  assert.equal(member(env, c.pickerId).renewal_requested_at, null);
});

test('renewal: a key from another project asks nothing here', async () => {
  const env = setup();
  const a = await claimed(env, { title: 'A' });
  const b = await claimed(env, { title: 'B' });
  const ca = await addCollaborator(env, a, 'A1');
  expire(env, ca.pickerId);
  assert.equal((await renewal(env, b.token, ca.key)).status, 403);
  assert.equal(member(env, ca.pickerId).renewal_requested_at, null);
});

// ─── POST /api/pick/collaborators/:id/decision ─────────────────────────────

test('decision approve: a new period from now, the request cleared, the person active again', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  expire(env, c.pickerId);
  await renewal(env, p.token, c.key);
  const r = await decide(env, p.token, p.key, c.pickerId, { approve: true, window_days: 1 });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.collaborator.status, 'active');
  assert.equal(body.collaborator.renewal_requested_at, null);
  const m = member(env, c.pickerId);
  assert.equal(m.renewal_requested_at, null);
  assert.ok(Math.abs(Date.parse(m.expires_at) - (Date.now() + DAY)) < 5000);
  const s = await state(env, p.token, c.key);
  assert.equal(s.role, 'collaborator');
  assert.equal(s.my_expires_at, m.expires_at);
  // null = until the project ends
  expire(env, c.pickerId);
  await renewal(env, p.token, c.key);
  assert.equal((await decide(env, p.token, p.key, c.pickerId, { approve: true, window_days: null })).status, 200);
  assert.equal(member(env, c.pickerId).expires_at, null);
});

test('decision decline: the request cleared, still expired, and they may ask again', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  expire(env, c.pickerId);
  await renewal(env, p.token, c.key);
  const expiresBefore = member(env, c.pickerId).expires_at;
  const r = await decide(env, p.token, p.key, c.pickerId, { approve: false });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).collaborator.status, 'expired');
  assert.equal(member(env, c.pickerId).renewal_requested_at, null);
  assert.equal(member(env, c.pickerId).expires_at, expiresBefore);
  assert.equal((await state(env, p.token, c.key)).renewal_requested, false);
  assert.equal((await renewal(env, p.token, c.key)).status, 200);
});

test('decision: approve refused 409 collaborator_limit when the OTHER active people + unspent invites come to 2', async () => {
  const env = setup();
  const p = await claimed(env);
  const a = await addCollaborator(env, p, 'A');
  expire(env, a.pickerId);
  await renewal(env, p.token, a.key);
  await addCollaborator(env, p, 'B');
  await invite(env, p.token, p.key);
  const r = await decide(env, p.token, p.key, a.pickerId, { approve: true, window_days: 7 });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'collaborator_limit');
  assert.ok(member(env, a.pickerId).renewal_requested_at, 'the request stays pending');
  // the invite expires: a slot frees and the approve goes through
  env.DB._db.prepare('UPDATE pick_invites SET expires_at = ? WHERE used_at IS NULL').run(ago(1));
  assert.equal((await decide(env, p.token, p.key, a.pickerId, { approve: true, window_days: 7 })).status, 200);
  // decline is never limited
});

test('decision: no pending request 409 no_renewal_request; removed 409; unknown 404; bad body 400; non-owners 403', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  let r = await decide(env, p.token, p.key, c.pickerId, { approve: false });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'no_renewal_request');
  r = await decide(env, p.token, p.key, c.pickerId, { approve: true, window_days: 7 });
  assert.equal((await r.json()).code, 'no_renewal_request');
  expire(env, c.pickerId);
  await renewal(env, p.token, c.key);
  for (const body of [{}, { approve: 'yes' }, { approve: true }, { approve: true, window_days: 2 }, null]) {
    assert.equal((await decide(env, p.token, p.key, c.pickerId, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await decide(env, p.token, p.key, 'nobody', { approve: false })).status, 404);
  for (const key of [c.key, undefined]) {
    const res = await decide(env, p.token, key, c.pickerId, { approve: true, window_days: null });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'not_owner');
  }
  assert.ok(member(env, c.pickerId).renewal_requested_at);
  await removeC(env, p.token, p.key, c.pickerId);
  assert.equal(member(env, c.pickerId).renewal_requested_at, null, 'removing clears a pending request');
  r = await decide(env, p.token, p.key, c.pickerId, { approve: true, window_days: 7 });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'collaborator_removed');
});

test('patch clears a pending renewal request (the owner answered it another way)', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  expire(env, c.pickerId);
  await renewal(env, p.token, c.key);
  assert.equal((await patchC(env, p.token, p.key, c.pickerId, { window_days: 7 })).status, 200);
  assert.equal(member(env, c.pickerId).renewal_requested_at, null);
  assert.equal((await state(env, p.token, c.key)).role, 'collaborator');
});

test('archived: every management route answers 401 (the link is dead)', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  env.DB._db.prepare('UPDATE projects SET archived_at = ? WHERE id = ?').run(ago(1), p.project.id);
  assert.equal((await list(env, p.token, p.key)).status, 401);
  assert.equal((await patchC(env, p.token, p.key, c.pickerId, { window_days: 1 })).status, 401);
  assert.equal((await removeC(env, p.token, p.key, c.pickerId)).status, 401);
  assert.equal((await renewal(env, p.token, c.key)).status, 401);
  assert.equal(member(env, c.pickerId).revoked_at, null);
});

test('a code is never usable to reach owner routes, and joining twice with two codes gives two separate people', async () => {
  const env = setup();
  const p = await claimed(env);
  const i1 = await invite(env, p.token, p.key);
  const i2 = await invite(env, p.token, p.key);
  const j1 = await join(env, p.token, i1.json.code, 'Same');
  const j2 = await join(env, p.token, i2.json.code, 'Same', { ip: '198.51.100.4' });
  assert.notEqual(j1.json.picker_id, j2.json.picker_id);
  assert.notEqual(j1.json.picker_key, j2.json.picker_key);
  assert.equal((await invite(env, p.token, j1.json.picker_key)).res.status, 403);
  assert.equal((await removeC(env, p.token, j1.json.picker_key, j2.json.picker_id)).status, 403);
  assert.equal(member(env, j2.json.picker_id).revoked_at, null);
  void later;
});
