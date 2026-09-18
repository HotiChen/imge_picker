// Image serving: the ?w= thumbnail path, the fallback that keeps
// already-uploaded photos working, and conditional/range requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { fakeBucket, ctx, req } from './fakes.mjs';

const PHOTOS = {
  '2026/wedding/a.jpg': 'ORIGINAL-A-pretend-this-is-25MB',
  '_thumbs/400/2026/wedding/a.jpg.thumb': 'THUMB-400-A',
  '_thumbs/1600/2026/wedding/a.jpg.thumb': 'THUMB-1600-A',
  // uploaded before thumbnails existed — has no variants
  '2026/wedding/old.jpg': 'ORIGINAL-OLD',
};

const env = () => ({ imagepicker: fakeBucket(PHOTOS) });
const get = (path, headers) => worker.fetch(req(path, { headers }), env(), ctx);

test('?w= serves the small thumbnail, not the original', async () => {
  const res = await get('/2026/wedding/a.jpg?w=400');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'THUMB-400-A');
});

test('a width between buckets rounds up to the next bucket', async () => {
  // the sidebar asks for 240 and the page canvas for 1200
  assert.equal(await (await get('/2026/wedding/a.jpg?w=240')).text(), 'THUMB-400-A');
  assert.equal(await (await get('/2026/wedding/a.jpg?w=1200')).text(), 'THUMB-1600-A');
});

test('a width above every bucket clamps to the largest thumbnail', async () => {
  assert.equal(await (await get('/2026/wedding/a.jpg?w=99999')).text(), 'THUMB-1600-A');
});

test('no ?w= serves the untouched original (export, print, download)', async () => {
  const res = await get('/2026/wedding/a.jpg');
  assert.equal(await res.text(), 'ORIGINAL-A-pretend-this-is-25MB');
});

test('a photo with no thumbnail falls back to the original instead of 404', async () => {
  // this is what keeps every already-uploaded photo working
  const res = await get('/2026/wedding/old.jpg?w=400');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ORIGINAL-OLD');
});

test('a genuinely missing key is still a 404', async () => {
  assert.equal((await get('/2026/wedding/nope.jpg?w=400')).status, 404);
});

test('a junk ?w= value is ignored rather than breaking the request', async () => {
  for (const w of ['abc', '-5', '0', '']) {
    const res = await get(`/2026/wedding/a.jpg?w=${w}`);
    assert.equal(res.status, 200, `w=${w}`);
    assert.equal(await res.text(), 'ORIGINAL-A-pretend-this-is-25MB', `w=${w}`);
  }
});

test('requesting a thumbnail key directly does not look for a thumb of a thumb', async () => {
  const res = await get('/_thumbs/400/2026/wedding/a.jpg.thumb?w=400');
  assert.equal(await res.text(), 'THUMB-400-A');
});

test('revalidating with the stored etag returns 304 with no body', async () => {
  const first = await get('/2026/wedding/a.jpg?w=400');
  const etag = first.headers.get('etag');
  assert.ok(etag, 'response must carry an etag to revalidate against');

  const second = await get('/2026/wedding/a.jpg?w=400', { 'If-None-Match': etag });
  assert.equal(second.status, 304);
  assert.equal(await second.text(), '');
});

test('a stale etag re-sends the body', async () => {
  const res = await get('/2026/wedding/a.jpg?w=400', { 'If-None-Match': '"something-else"' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'THUMB-400-A');
});

test('images are cacheable but still revalidate, since a re-upload reuses the key', async () => {
  const cc = (await get('/2026/wedding/a.jpg?w=400')).headers.get('Cache-Control');
  assert.match(cc, /max-age=\d+/);
  // a year-long max-age would pin a replaced photo in the client's browser
  const maxAge = Number(/max-age=(\d+)/.exec(cc)[1]);
  assert.ok(maxAge <= 86400, `max-age ${maxAge} is too long for a mutable key`);
});

test('range requests come back as 206 with a Content-Range', async () => {
  const res = await get('/2026/wedding/a.jpg', { Range: 'bytes=0-7' });
  assert.equal(res.status, 206);
  assert.equal(await res.text(), 'ORIGINAL');
  assert.match(res.headers.get('Content-Range'), /^bytes 0-7\//);
});

test('images are readable cross-origin', async () => {
  const res = await get('/2026/wedding/a.jpg?w=400');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
});
