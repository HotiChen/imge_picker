// A photo the guest un-hearted and left no note on is not kept as a row. It used to be stored as "rating 0, no note": it did
// not count toward the 500 ♥ cap, but every one of them took a name in PICK_MAX_ROWS (1000), so a guest who hearted and
// un-hearted 800 photos of a 1050-photo shoot could no longer heart anything, with only 198 picked. Such an item (rating 0, empty
// note) is now a delete. A rating-0 item WITH a note stays: the note is the guest's. See docs/guest-picking.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, pick, claimed, save, one, rows } from './pick-helpers.mjs';

const A = '20260819/a.jpg';
const B = '20260819/b.jpg';
const C = '20260819/c.jpg';
const ROWS = 1000; // PICK_MAX_ROWS in worker.js
const keysN = (n, from = 0) => Array.from({ length: n }, (_, i) => `20260819/p${from + i}.jpg`);
const sel = env => rows(env, 'SELECT photo_key, rating, note, marks FROM selections ORDER BY photo_key');
const count = env => one(env, 'SELECT COUNT(*) AS n FROM selections').n;
function seed(env, p, keys, rating = 0, note = '') {
  const ins = env.DB._db.prepare(
    "INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, 'seeded')");
  env.DB._db.exec('BEGIN');
  for (const k of keys) ins.run(p.project.id, k, rating, note, p.pickerId);
  env.DB._db.exec('COMMIT');
}

test('un-hearting a photo with no note deletes its row', async () => {
  const env = setup();
  const p = await claimed(env);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 4 }] })).status, 200);
  assert.equal(count(env), 1);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 0 }] })).status, 200);
  assert.equal(count(env), 0, 'no empty rating-0 row is left behind');
});

test('hearting then un-hearting in one save leaves nothing', async () => {
  const env = setup();
  const p = await claimed(env);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 3 }, { photo_key: A, rating: 0 }] })).status, 200);
  assert.equal(count(env), 0);
});

test('a rating-0 item with a note keeps its row and its note (the note is the guest\'s)', async () => {
  const env = setup();
  const p = await claimed(env);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 0, note: '先不要' }] })).status, 200);
  assert.deepEqual(sel(env).map(r => [r.photo_key, r.rating, r.note]), [[A, 0, '先不要']]);
  // a note of only spaces is a note: it is not "empty" for this rule
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 0, note: ' ' }] })).status, 200);
  assert.equal(count(env), 2);
});

test('un-hearting a photo that carried pins deletes the row, pins included', async () => {
  const env = setup();
  const p = await claimed(env);
  const pin = { x: 0.5, y: 0.5, note: '修圖' };
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 2, marks: [pin] }] })).status, 200);
  assert.ok(one(env, 'SELECT marks FROM selections WHERE photo_key = ?', A).marks);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 0 }] })).status, 200);
  assert.equal(count(env), 0);
});

test('a key named twice in one save: its LAST mention decides', async () => {
  const env = setup();
  const p = await claimed(env);
  // empty-zero first, then a heart: the heart wins and the row exists
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 0 }, { photo_key: A, rating: 3 }] })).status, 200);
  assert.deepEqual(sel(env).map(r => [r.photo_key, r.rating]), [[A, 3]]);
  // heart first, then empty-zero: the row is gone
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 5 }, { photo_key: A, rating: 0 }] })).status, 200);
  assert.equal(count(env), 0);
});

test('un-hearting one photo leaves every other row alone', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }, { photo_key: B, rating: 2, note: 'b' }, { photo_key: C, rating: 0, note: 'c' }] });
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 0 }] })).status, 200);
  assert.deepEqual(sel(env).map(r => [r.photo_key, r.rating, r.note]), [[B, 2, 'b'], [C, 0, 'c']]);
});

test('at the row cap, an un-heart frees its name in the same save that adds another photo', async () => {
  const env = setup();
  const p = await claimed(env);
  seed(env, p, keysN(ROWS - 1), 1);
  seed(env, p, [B], 1);                  // ROWS rows: full
  assert.equal(count(env), ROWS);
  // adding a new ♥ alone is refused: row_cap
  const full = await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 3 }] });
  assert.equal(full.status, 409);
  assert.equal((await full.json()).code, 'row_cap');
  // un-hearting B (no note) in the same save frees the name A needs
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 3 }, { photo_key: B, rating: 0 }] })).status, 200);
  assert.equal(count(env), ROWS);
  assert.equal(one(env, 'SELECT rating FROM selections WHERE photo_key = ?', A).rating, 3);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections WHERE photo_key = ?', B).n, 0);
});

test('rows already left behind (rating 0, no note) are cleaned up when the guest touches that photo', async () => {
  const env = setup();
  const p = await claimed(env);
  seed(env, p, [A, B], 0);               // the junk an older version left
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 0 }] })).status, 200);
  assert.deepEqual(sel(env).map(r => r.photo_key), [B], 'A is gone, B was not touched');
});

test('the ♥ count and the ♥ cap are unaffected: hearts are still counted and capped', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }, { photo_key: B, rating: 1 }] });
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 0 }] });
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections WHERE rating > 0').n, 1);
  seed(env, p, keysN(499), 1);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: C, rating: 1 }] })).status, 409, 'the 501st ♥ is still refused');
});

test('the seat, the phase and the folder gates are unchanged for an un-heart', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  // a viewer (no key) cannot un-heart, and the row stays
  const viewer = await pick(env, 'PUT', 'selections', p.token, { body: { upsert: [{ photo_key: A, rating: 0 }] } });
  assert.equal(viewer.status, 403);
  assert.equal(count(env), 1);
  // a photo outside the link's folders is refused even as an un-heart
  const outside = await save(env, p.token, p.key, { upsert: [{ photo_key: '20260901/x.jpg', rating: 0 }] });
  assert.equal(outside.status, 403);
  assert.equal(count(env), 1);
});
