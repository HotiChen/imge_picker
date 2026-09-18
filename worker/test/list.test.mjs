// Folder listing. The pagination case is a correctness bug, not just perf:
// before the cursor loop, a folder over 1000 photos silently lost the rest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { fakeBucket, ctx, req } from './fakes.mjs';

const listing = async (bucket, prefix = '') => {
  const res = await worker.fetch(
    req(`/?list=${encodeURIComponent(prefix)}`), { imagepicker: bucket }, ctx
  );
  assert.equal(res.status, 200);
  return res.json();
};

test('a folder larger than one R2 page returns every photo', async () => {
  const photos = {};
  for (let i = 0; i < 2350; i++) {
    photos[`2026/big/${String(i).padStart(5, '0')}.jpg`] = 'x';
  }
  // real R2 caps a list() call at 1000 objects
  const body = await listing(fakeBucket(photos, { pageSize: 1000 }), '2026/big/');
  assert.equal(body.data.length, 2350);
});

test('only image files are listed', async () => {
  const body = await listing(fakeBucket({
    '2026/a.jpg': 'x',
    '2026/b.PNG': 'x',
    '2026/c.webp': 'x',
    '2026/notes.txt': 'x',
    '2026/.DS_Store': 'x',
  }), '2026/');
  assert.deepEqual(body.data.map(f => f.name).sort(), ['a.jpg', 'b.PNG', 'c.webp'].sort());
});

test('internal folders are hidden from the folder picker', async () => {
  const body = await listing(fakeBucket({
    '2026/a.jpg': 'x',
    '_thumbs/400/2026/a.jpg.thumb': 'x',
    '_books/abc.json': 'x',
  }), '');
  assert.ok(!body.folders.some(f => f.startsWith('_')),
    `internal folders leaked into the picker: ${JSON.stringify(body.folders)}`);
  assert.ok(body.folders.includes('2026/'));
});

test('an empty folder lists cleanly rather than erroring', async () => {
  const body = await listing(fakeBucket({}), '2026/nothing/');
  assert.equal(body.status, 'success');
  assert.deepEqual(body.data, []);
});

test('listing reports each photo size so the UI can show it', async () => {
  const body = await listing(fakeBucket({ '2026/a.jpg': 'abcde' }), '2026/');
  assert.equal(body.data[0].size, 5);
  assert.equal(body.data[0].id, '2026/a.jpg');
});
