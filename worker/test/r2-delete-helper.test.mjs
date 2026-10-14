// bucketFor's delete (docs/multi-photographer.md §3, batch 3; the photo
// delete route builds on it). The one way to remove an R2 object: the same
// key handling as get / head / put — the logical key, the caller's prefix
// added here, the reserved `_t/` namespace refused on the logical key before
// the prefix — and one string key per call (real R2 also takes an array; the
// helper does not, so no route can sweep a list past the reserved check).
//
// bucketFor is not exported, so this lifts it (and what it needs) out of
// worker.js and runs it against the fake R2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeBucket } from './fakes.mjs';

const SRC = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const from = SRC.indexOf('const TENANT_PREFIX');
const to = SRC.indexOf('// Books have no owner yet');
assert.ok(from > 0 && to > from, 'the helper block moved: update the markers');
const bucketFor = new Function('DEFAULT_PHOTOGRAPHER_ID', `${SRC.slice(from, to)}\nreturn bucketFor;`)('default');

const B = '0123456789abcdef';
const world = () => fakeBucket({
  'shoot/a.jpg': 'A', [`_t/${B}/shoot/a.jpg`]: 'B', '_t/other/x.jpg': 'O',
  '_thumbs/400/shoot/a.jpg.thumb': 'AT', [`_t/${B}/_thumbs/400/shoot/a.jpg.thumb`]: 'BT',
});

test('bucketFor.delete: the default removes its own unprefixed key; a tenant removes only under its own prefix', async () => {
  const r2 = world();
  await bucketFor({ imagepicker: r2 }, B).delete('shoot/a.jpg');
  assert.deepEqual(r2._deletes, [`_t/${B}/shoot/a.jpg`]);
  assert.equal(r2._store.get('shoot/a.jpg').body, 'A', 'the default\'s object, same logical key, untouched');
  await bucketFor({ imagepicker: r2 }, 'default').delete('shoot/a.jpg');
  assert.deepEqual(r2._deletes, [`_t/${B}/shoot/a.jpg`, 'shoot/a.jpg']);
  // thumbnails go through the same door
  await bucketFor({ imagepicker: r2 }, B).delete('_thumbs/400/shoot/a.jpg.thumb');
  assert.ok(!r2._store.has(`_t/${B}/_thumbs/400/shoot/a.jpg.thumb`));
  assert.ok(r2._store.has('_thumbs/400/shoot/a.jpg.thumb'));
});

test('bucketFor.delete: a reserved key (`_t`, `_t/…`) or anything that is not one string is refused before R2 is asked', async () => {
  for (const who of ['default', B]) {
    const r2 = world();
    const photos = bucketFor({ imagepicker: r2 }, who);
    for (const key of ['_t', '_t/', `_t/${B}/shoot/a.jpg`, '_t/other/x.jpg', ['shoot/a.jpg'], [`_t/${B}/shoot/a.jpg`], undefined, null, 42]) {
      assert.throws(() => photos.delete(key), /reserved/, `${who} ${JSON.stringify(key)}`);
    }
    assert.deepEqual(r2._deletes, [], who);
    assert.equal(r2._store.size, 5, who);
  }
});

test('bucketFor.delete: an unsafe photographer id throws before any delete', () => {
  const r2 = world();
  for (const id of ['', '../x', 'A', '_x', undefined]) assert.throws(() => bucketFor({ imagepicker: r2 }, id), /unsafe/);
  assert.deepEqual(r2._deletes, []);
});

test('bucketFor.delete: deleting a key that is not there is not an error (as real R2)', async () => {
  const r2 = world();
  assert.equal(await bucketFor({ imagepicker: r2 }, B).delete('nope.jpg'), undefined);
  assert.deepEqual(r2._deletes, [`_t/${B}/nope.jpg`]);
});
