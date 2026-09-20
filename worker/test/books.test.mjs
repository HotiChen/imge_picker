// Book read/write, including the no-cache header that stopped clients seeing
// a stale album, and the guards on what a client may change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { fakeBucket, ctx, req } from './fakes.mjs';

const BOOK = {
  name: '婚禮相本',
  clientFolders: ['2026/wedding/'],
  pages: [
    { type: 'cover', slots: [{ photoId: '2026/wedding/a.jpg', crop: { x: 0, y: 0, scale: 1 } }] },
    { type: 'inner', locked: true, slots: [{ photoId: null, crop: {} }] },
  ],
};

const withBook = (book = BOOK) => fakeBucket({ '_books/b1.json': JSON.stringify(book) });
// these cover the book routes themselves; the share-token gate in front of
// them has its own file, so they go in as the photographer
const ADMIN = 'secret';
const call = (bucket, path, opts, envExtra = {}) =>
  worker.fetch(req(path, opts), { imagepicker: bucket, PHOTOGRAPHER_TOKEN: ADMIN, ...envExtra }, ctx);

test('a saved album is never served from cache', async () => {
  // without this the photographer saves an edit and the client keeps seeing
  // the old text size and crop until their browser cache expires
  const res = await call(withBook(), '/api/books/b1', { token: ADMIN });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-cache');
});

test('reading a book returns its stored contents', async () => {
  const body = await (await call(withBook(), '/api/books/b1', { token: ADMIN })).json();
  assert.equal(body.name, '婚禮相本');
});

test('an unknown book is a 404', async () => {
  assert.equal((await call(withBook(), '/api/books/nope', { token: ADMIN })).status, 404);
});

test('saving a book requires the photographer token when one is set', async () => {
  const bucket = withBook();
  const env = { PHOTOGRAPHER_TOKEN: 'secret' };

  const denied = await call(bucket, '/api/books/b1', { method: 'PUT', body: '{}' }, env);
  assert.equal(denied.status, 401);

  const wrong = await call(bucket, '/api/books/b1', { method: 'PUT', body: '{}', token: 'guess' }, env);
  assert.equal(wrong.status, 401);

  const ok = await call(bucket, '/api/books/b1', { method: 'PUT', body: '{"name":"x"}', token: 'secret' }, env);
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(bucket._store.get('_books/b1.json').body).name, 'x');
});

test('a client cannot edit a locked page', async () => {
  const res = await call(withBook(), '/api/books/b1', {
    method: 'PATCH', token: ADMIN,
    body: JSON.stringify({ pageIndex: 1, slots: [{ photoId: '2026/wedding/b.jpg' }] }),
  });
  assert.equal(res.status, 403);
});

test('a client cannot pull in a photo outside the folders opened to them', async () => {
  const res = await call(withBook(), '/api/books/b1', {
    method: 'PATCH', token: ADMIN,
    body: JSON.stringify({ pageIndex: 0, slots: [{ photoId: '2026/private/secret.jpg' }] }),
  });
  assert.equal(res.status, 403);
});

test('a client can swap a photo from an opened folder', async () => {
  const bucket = withBook();
  const res = await call(bucket, '/api/books/b1', {
    method: 'PATCH', token: ADMIN,
    body: JSON.stringify({ pageIndex: 0, slots: [{ photoId: '2026/wedding/b.jpg' }] }),
  });
  assert.equal(res.status, 200);
  const saved = JSON.parse(bucket._store.get('_books/b1.json').body);
  assert.equal(saved.pages[0].slots[0].photoId, '2026/wedding/b.jpg');
});

test('an out-of-range page index is rejected', async () => {
  const res = await call(withBook(), '/api/books/b1', {
    method: 'PATCH', token: ADMIN,
    body: JSON.stringify({ pageIndex: 99, slots: [] }),
  });
  assert.equal(res.status, 400);
});

test('approving an album does not block on the notify webhook', async () => {
  const book = { ...BOOK, notifyUrl: 'https://hooks.example/never-responds' };
  const bucket = fakeBucket({ '_books/b1.json': JSON.stringify(book) });

  const originalFetch = globalThis.fetch;
  let notified = false;
  // a webhook that never settles must not hold up the client's response
  globalThis.fetch = () => { notified = true; return new Promise(() => {}); };
  try {
    const res = await Promise.race([
      worker.fetch(req('/api/books/b1/approve', { method: 'POST', token: ADMIN }),
        { imagepicker: bucket, PHOTOGRAPHER_TOKEN: ADMIN }, ctx),
      new Promise((_, rej) => setTimeout(() => rej(new Error('approve blocked on the webhook')), 1000)),
    ]);
    assert.equal(res.status, 200);
    assert.ok(notified, 'the webhook should still have been fired');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
