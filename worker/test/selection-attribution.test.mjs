// A save that changes nothing must not take a photo from the person who picked it (Tim 2026-10-18: the owner flipping
// through the lightbox with the arrows re-saved every photo it left, which re-stamped a collaborator's ♥ as the owner's
// or deleted it). High tier: a write path. The owner may still change or delete a collaborator's photo on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, claimed, save, one, sha256Hex } from './pick-helpers.mjs';

const A = '20260819/a.jpg';
const B = '20260819/b.jpg';
const C = '20260819/c.jpg';
const THEN = '2026-10-01T00:00:00.000Z';

// an owner with its seat, a collaborator, and photos the collaborator picked (A with a note, B plain) — the owner picked C
async function world() {
  const env = setup();
  const p = await claimed(env);
  const owner = one(env, 'SELECT owner_picker_id AS id FROM projects').id;
  env.DB._db.prepare('INSERT INTO pickers (id, project_id, key_hash, name, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('picker-collab', p.project.id, await sha256Hex('COLLAB-KEY-1'), '協作者 Mia', THEN);
  env.DB._db.prepare('INSERT INTO project_collaborators (picker_id, project_id, invited_by, joined_at) VALUES (?, ?, ?, ?)')
    .run('picker-collab', p.project.id, owner, THEN);
  const ins = env.DB._db.prepare('INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  ins.run(p.project.id, A, 1, '要這張', 'picker-collab', THEN);
  ins.run(p.project.id, B, 1, '', 'picker-collab', THEN);
  ins.run(p.project.id, C, 1, '', owner, THEN);
  return { env, p, owner };
}
const row = (env, k) => one(env, 'SELECT rating, note, updated_by, updated_at FROM selections WHERE photo_key = ?', k);

test('the owner re-sending a collaborator\'s photo exactly as it is leaves it the collaborator\'s (author and time)', async () => {
  const { env, p } = await world();
  const res = await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, note: '要這張' }, { photo_key: B, rating: 1, note: '' }] });
  assert.equal(res.status, 200);
  assert.deepEqual({ ...row(env, A) }, { rating: 1, note: '要這張', updated_by: 'picker-collab', updated_at: THEN });
  assert.deepEqual({ ...row(env, B) }, { rating: 1, note: '', updated_by: 'picker-collab', updated_at: THEN });
});

test('the owner changing a collaborator\'s photo on purpose still takes it: a new note, an un-heart, a delete', async () => {
  const { env, p, owner } = await world();
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, note: '改了備註' }] })).status, 200);
  assert.deepEqual({ ...row(env, A) }, { rating: 1, note: '改了備註', updated_by: owner, updated_at: row(env, A).updated_at });
  assert.notEqual(row(env, A).updated_at, THEN);
  // an un-heart with a note keeps the row (rating 0) and is the owner's
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 0, note: '不要' }] })).status, 200);
  assert.deepEqual({ ...row(env, B) }, { rating: 0, note: '不要', updated_by: owner, updated_at: row(env, B).updated_at });
  // rating 0 with no note is the delete: the owner can remove a collaborator's pick
  const { env: env2, p: p2 } = await world();
  assert.equal((await save(env2, p2.token, p2.key, { upsert: [{ photo_key: A, rating: 0, note: '' }] })).status, 200);
  assert.equal(row(env2, A), undefined);
});

test('only the rating differs, or only the note: each counts as a change by the owner', async () => {
  const { env, p, owner } = await world();
  // same note, rating 1 -> 0 (the row stays: it has a note)
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 0, note: '要這張' }] })).status, 200);
  assert.deepEqual({ ...row(env, A) }, { rating: 0, note: '要這張', updated_by: owner, updated_at: row(env, A).updated_at });
  // same rating, only a note added
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 1, note: '新備註' }] })).status, 200);
  assert.deepEqual({ ...row(env, B) }, { rating: 1, note: '新備註', updated_by: owner, updated_at: row(env, B).updated_at });
});

test('a mixed save: the untouched photo stays the collaborator\'s, the changed one is the owner\'s', async () => {
  const { env, p, owner } = await world();
  const res = await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, note: '要這張' }, { photo_key: B, rating: 1, note: '加一句' }] });
  assert.equal(res.status, 200);
  assert.equal(row(env, A).updated_by, 'picker-collab');
  assert.equal(row(env, A).updated_at, THEN);
  assert.deepEqual({ ...row(env, B) }.updated_by, owner);
  assert.equal(row(env, B).note, '加一句');
});

test('the owner re-sending its own photo is unchanged behaviour (still its own, still saved)', async () => {
  const { env, p, owner } = await world();
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: C, rating: 1, note: '' }] })).status, 200);
  assert.equal(row(env, C).updated_by, owner);
  assert.equal(row(env, C).rating, 1);
});

test('a photo nobody has picked is still created by the owner\'s ♥ (the guard drops only identical rows)', async () => {
  const { env, p, owner } = await world();
  const D = '20260819/d.jpg';
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: D, rating: 1, note: '' }] })).status, 200);
  assert.deepEqual({ ...row(env, D) }, { rating: 1, note: '', updated_by: owner, updated_at: row(env, D).updated_at });
});
