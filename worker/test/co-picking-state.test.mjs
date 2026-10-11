// Co-picking: what GET /api/pick/state and the admin project detail say
// (docs/co-picking.md, API).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECRET, call, claim } from './pick-helpers.mjs';
import {
  setup, pick, claimed, addCollaborator, withCollaborator, state, expire, removeC, ago,
} from './co-picking-helpers.mjs';

const A = '20260819/a.jpg';
const B = '20260819/b.jpg';
const C = '20260819/c.jpg';
const put = (env, t, key, body) => pick(env, 'PUT', 'selections', t, { key, body });
const PIN = [{ x: 0.25, y: 0.75, note: 'here' }];

test('state roles: owner, collaborator, viewer — is_owner stays owner-only, can_edit for owner and active collaborator', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  const o = await state(env, p.token, p.key);
  assert.equal(o.role, 'owner');
  assert.equal(o.is_owner, true);
  assert.equal(o.can_edit, true);
  assert.equal(o.my_expires_at, null);
  assert.equal(o.my_status, null);
  assert.equal(o.can_request_renewal, false);
  assert.equal(o.renewal_requested, false);
  const s = await state(env, p.token, c.key);
  assert.equal(s.role, 'collaborator');
  assert.equal(s.is_owner, false);
  assert.equal(s.can_edit, true);
  assert.equal(s.my_status, 'active');
  assert.equal(s.my_expires_at, c.json.expires_at);
  assert.equal(s.can_request_renewal, false);
  assert.equal(s.owner, '王小明');
  const v = await state(env, p.token);
  assert.equal(v.role, 'viewer');
  assert.equal(v.is_owner, false);
  assert.equal(v.can_edit, false);
  assert.equal(v.my_expires_at, null);
  assert.equal(v.my_status, null);
  assert.equal(v.can_request_renewal, false);
});

test('state: a collaborator sees the owner\'s notes and pins and who wrote each row; a viewer gets {photo_key, rating} only', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  await put(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, note: 'owner note', marks: PIN }] });
  await put(env, p.token, c.key, { upsert: [{ photo_key: B, rating: 2, note: 'bob note' }] });
  for (const key of [p.key, c.key]) {
    const s = await state(env, p.token, key);
    const a = s.selections.find(x => x.photo_key === A);
    const b = s.selections.find(x => x.photo_key === B);
    assert.equal(a.note, 'owner note');
    assert.deepEqual(a.marks, PIN);
    assert.deepEqual(a.by, { id: p.pickerId, name: '王小明', role: 'owner' });
    assert.equal(b.note, 'bob note');
    assert.equal(b.marks, null);
    assert.deepEqual(b.by, { id: c.pickerId, name: 'Bob', role: 'collaborator' });
    assert.equal('updated_by' in a, false, 'the raw column stays inside');
  }
  const v = await state(env, p.token);
  assert.deepEqual(v.selections, [{ photo_key: A, rating: 1 }, { photo_key: B, rating: 2 }]);
  const text = JSON.stringify(v);
  assert.ok(!text.includes('Bob'));
  assert.ok(!text.includes(c.pickerId));
});

test('state: an expired collaborator reads as a viewer (no notes, no names), with the renewal fields', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  await put(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, note: 'secret' }] });
  expire(env, c.pickerId);
  const s = await state(env, p.token, c.key);
  assert.equal(s.role, 'viewer');
  assert.equal(s.can_edit, false);
  assert.equal(s.my_status, 'expired');
  assert.equal(s.can_request_renewal, true);
  assert.equal(s.renewal_requested, false);
  assert.equal(s.my_expires_at, null);
  assert.deepEqual(s.selections, [{ photo_key: A, rating: 1 }]);
  assert.ok(!JSON.stringify(s).includes('secret'));
});

test('state: an expiry exactly now counts as expired (expires_at must be in the future)', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  expire(env, c.pickerId, new Date(Date.now() - 1).toISOString());
  assert.equal((await state(env, p.token, c.key)).role, 'viewer');
  expire(env, c.pickerId, new Date(Date.now() + 60000).toISOString());
  assert.equal((await state(env, p.token, c.key)).role, 'collaborator');
});

test('state: expires_at equal to now, to the millisecond, is expired (fixed clock)', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  const RealDate = globalThis.Date;
  const fixed = RealDate.now() + 3600000;
  class FixedDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(fixed); }
    static now() { return fixed; }
  }
  expire(env, c.pickerId, new RealDate(fixed).toISOString());
  globalThis.Date = FixedDate;
  let s;
  try { s = await state(env, p.token, c.key); } finally { globalThis.Date = RealDate; }
  assert.equal(s.role, 'viewer');
  assert.equal(s.my_status, 'expired');
});

test('state: a collaborator does not get the owner\'s submit bookkeeping or revision text', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  const s = await state(env, p.token, c.key);
  assert.equal('modified_after_submit' in s, false);
  assert.equal(s.revision_message, null);
  assert.equal('revision_drafts' in s, false);
});

test('state: a key of project A\'s collaborator is nobody on project B', async () => {
  const env = setup();
  const a = await claimed(env, { title: 'A' });
  const b = await claimed(env, { title: 'B' });
  const ca = await addCollaborator(env, a, 'A1');
  const s = await state(env, b.token, ca.key);
  assert.equal(s.role, 'viewer');
  assert.equal(s.my_status, null);
  assert.equal(s.can_edit, false);
  assert.equal((await put(env, b.token, ca.key, { upsert: [{ photo_key: A, rating: 1 }] })).status, 403);
});

test('state by.role: a previous owner\'s rows read as other (no name) after a reset; a removed collaborator is still collaborator', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  await put(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  await put(env, p.token, c.key, { upsert: [{ photo_key: B, rating: 1 }] });
  await removeC(env, p.token, p.key, c.pickerId);
  env.DB._db.prepare("INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at) VALUES (?, ?, 1, '', 'unknown-picker', 'x')").run(p.project.id, C);
  await call(env, `/api/admin/projects/${p.project.id}/reset-seat`, { method: 'POST', token: SECRET });
  const o2 = await claim(env, p.token, '新主人');
  const s = await state(env, p.token, o2.key);
  const by = Object.fromEntries(s.selections.map(x => [x.photo_key, x.by]));
  assert.deepEqual(by[A], { id: p.pickerId, name: null, role: 'other' }, 'no previous owner\'s name on the page');
  assert.deepEqual(by[B], { id: c.pickerId, name: 'Bob', role: 'collaborator' });
  assert.equal(by[C], null);
});

test('admin detail: collaborators (with names and status) and each selection\'s by', async () => {
  const env = setup();
  const p = await claimed(env);
  const bob = await addCollaborator(env, p, 'Bob');
  const amy = await addCollaborator(env, p, 'Amy', null);
  expire(env, amy.pickerId);
  await put(env, p.token, bob.key, { upsert: [{ photo_key: A, rating: 1 }] });
  await put(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 1 }] });
  const res = await call(env, `/api/admin/projects/${p.project.id}`, { token: SECRET });
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.collaborators.length, 2);
  const [b, a] = d.collaborators;
  assert.deepEqual(Object.keys(b).sort(), ['expires_at', 'joined_at', 'last_seen_at', 'name', 'picker_id', 'renewal_requested_at', 'revoked_at', 'status']);
  assert.equal(b.name, 'Bob');
  assert.equal(b.status, 'active');
  assert.equal(a.name, 'Amy');
  assert.equal(a.status, 'expired');
  const by = Object.fromEntries(d.selections.map(x => [x.photo_key, x.by]));
  assert.deepEqual(by[A], { id: bob.pickerId, name: 'Bob', role: 'collaborator' });
  assert.deepEqual(by[B], { id: p.pickerId, name: '王小明', role: 'owner' });
  // after a reset the old owner's collaborators show as removed (ended with the seat)
  await call(env, `/api/admin/projects/${p.project.id}/reset-seat`, { method: 'POST', token: SECRET });
  const d2 = await (await call(env, `/api/admin/projects/${p.project.id}`, { token: SECRET })).json();
  assert.deepEqual(d2.collaborators.map(x => x.status), ['removed', 'removed']);
  // admin only
  assert.equal((await call(env, `/api/admin/projects/${p.project.id}`, { token: 'nope' })).status, 401);
});

test('admin detail: no invite codes or hashes, no key hashes', async () => {
  const env = setup();
  const p = await claimed(env);
  await addCollaborator(env, p, 'Bob');
  const text = await (await call(env, `/api/admin/projects/${p.project.id}`, { token: SECRET })).text();
  assert.ok(!/code_hash|key_hash/.test(text));
  void ago;
});
