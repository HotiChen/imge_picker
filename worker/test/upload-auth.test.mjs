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

test('with no token configured the worker stays open, as before', async () => {
  assert.equal((await call(fakeBucket(), '/api/auth/verify-admin', {})).status, 200);
  assert.equal((await call(fakeBucket(), '/2026/a.jpg', { method: 'PUT', body: 'b' })).status, 200);
});

test('preflight requests are answered', async () => {
  const res = await call(fakeBucket(), '/2026/a.jpg', { method: 'OPTIONS' });
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});
