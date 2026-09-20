// Upload and admin-token checks. The thumbnail writes from upload.html go
// through the same PUT route, so they are covered here too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { fakeBucket, ctx, req } from './fakes.mjs';

const call = (bucket, path, opts, envExtra = {}) =>
  worker.fetch(req(path, opts), { imagepicker: bucket, ...envExtra }, ctx);

test('uploading is refused without the photographer token', async () => {
  const res = await call(fakeBucket(), '/2026/a.jpg', { method: 'PUT', body: 'bytes' },
    { PHOTOGRAPHER_TOKEN: 'secret' });
  assert.equal(res.status, 401);
});

test('uploading with the right token stores the object', async () => {
  const bucket = fakeBucket();
  const res = await call(bucket, '/2026/a.jpg', { method: 'PUT', body: 'bytes', token: 'secret' },
    { PHOTOGRAPHER_TOKEN: 'secret' });
  assert.equal(res.status, 200);
  assert.equal(bucket._store.get('2026/a.jpg').body, 'bytes');
});

test('a thumbnail write lands on the key the image route reads back', async () => {
  const bucket = fakeBucket({ '2026/a.jpg': 'ORIGINAL' });
  const env = { PHOTOGRAPHER_TOKEN: 'secret' };

  // exactly what upload.html sends after the original finishes
  const key = encodeURIComponent('_thumbs/400/2026/a.jpg.thumb');
  const put = await call(bucket, `/${key}`, {
    method: 'PUT', body: 'THUMB-BYTES', token: 'secret',
    headers: { 'Content-Type': 'image/webp' },
  }, env);
  assert.equal(put.status, 200);

  // ...and the browser then asks for it through ?w=
  const got = await call(bucket, '/2026/a.jpg?w=400', {}, env);
  assert.equal(await got.text(), 'THUMB-BYTES');
  assert.equal(got.headers.get('Content-Type'), 'image/webp');
});

test('verify-admin accepts the right token and rejects the wrong one', async () => {
  const env = { PHOTOGRAPHER_TOKEN: 'secret' };
  assert.equal((await call(fakeBucket(), '/api/auth/verify-admin', { token: 'secret' }, env)).status, 200);
  assert.equal((await call(fakeBucket(), '/api/auth/verify-admin', { token: 'nope' }, env)).status, 401);
  assert.equal((await call(fakeBucket(), '/api/auth/verify-admin', {}, env)).status, 401);
});

// A missing PHOTOGRAPHER_TOKEN used to mean "open to everyone" on four
// separate code paths. Every admin-side surface must now refuse instead, so a
// secret that was never set (or got mistyped on deploy) takes the studio
// offline rather than handing it to whoever finds the URL.
test('with no token configured every write surface is refused', async () => {
  assert.equal((await call(fakeBucket(), '/2026/a.jpg',
    { method: 'PUT', body: 'b' })).status, 401, 'upload');

  assert.equal((await call(fakeBucket(), '/api/books/b1',
    { method: 'PUT', body: '{"name":"x"}' })).status, 401, 'book PUT');

  assert.equal((await call(fakeBucket(), '/api/admin/clients',
    {})).status, 401, 'admin API');

  assert.equal((await call(fakeBucket(), '/api/auth/verify-admin',
    {})).status, 401, 'verify-admin with no token');
});

// The open path used to sit in front of the comparison, so any string at all
// came back ok once the secret was missing.
test('verify-admin refuses an arbitrary token when no secret is configured', async () => {
  for (const token of ['', 'guess', 'undefined', 'null']) {
    const res = await call(fakeBucket(), '/api/auth/verify-admin', { token });
    assert.equal(res.status, 401, `token ${JSON.stringify(token)}`);
  }
});

test('a no-token upload attempt writes nothing to the bucket', async () => {
  const bucket = fakeBucket();
  await call(bucket, '/2026/a.jpg', { method: 'PUT', body: 'b' });
  assert.equal(bucket._store.size, 0);
});

test('preflight requests are answered', async () => {
  const res = await call(fakeBucket(), '/2026/a.jpg', { method: 'OPTIONS' });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});
