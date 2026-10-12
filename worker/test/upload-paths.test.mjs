// Security review of multi-photographer batch 3, finding 3: the upload route
// is the PUT fall-through, so whatever no earlier route claimed became an R2
// key — `PUT /` wrote an object with an empty key, and a PUT to any /api/...
// path no route answers (a typo, a retired route) wrote `api/...` into the
// photographer's files. Now: an empty key is 400 invalid_key, any key under
// `api/` is 404, a key that is not valid percent-encoding is 400, and nothing
// is written. Who may upload is unchanged (401 first), and the default
// photographer's real writes (photos, thumbnails, album backgrounds) land as
// before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, SECRET, call } from './revision-helpers.mjs';
import { seedPhotographer, snapshot, ROUTES_ON } from './tenant-helpers.mjs';

const JPEG = { 'Content-Type': 'image/jpeg' };
async function world() {
  const env = setup({ extra: ROUTES_ON });
  const B = await seedPhotographer(env);
  return { env, A: { id: 'default', token: SECRET }, B };
}
const put = (env, path, token, headers = JPEG) => call(env, path, { method: 'PUT', token, body: 'BYTES', headers });

test('PUT / (an empty key) is 400 invalid_key and writes nothing, for every photographer', async () => {
  const w = await world();
  for (const who of [w.A, w.B]) {
    // `/_assets/` is empty once the `_assets/` prefix comes off
    for (const path of ['/', '//', '/_assets/']) {
      const before = snapshot(w.env);
      const res = await put(w.env, path, who.token);
      assert.equal(res.status, 400, `${who.id} ${path}`);
      assert.equal((await res.json()).code, 'invalid_key');
      assert.equal(snapshot(w.env), before, `${who.id} ${path} wrote`);
    }
  }
  assert.ok(!w.env.imagepicker._store.has(''));
  assert.ok(!w.env.imagepicker._store.has(`_t/${w.B.id}/`));
});

test('a PUT under /api/ that no route answers is 404 and writes nothing — plain, encoded or bare', async () => {
  const w = await world();
  const paths = [
    '/api', '/api/', '/api/nothing.jpg', '/api/admin/nope/x.jpg', '/api/nope/deeper/x.png', '/api/books',
    '/api/shares/x', '/api/upload/2026/a.jpg', '/%61pi/x.jpg', '/%61%70%69/x.jpg', '//api/x.jpg',
    // the key as it would be stored: `_assets/` comes off first
    '/_assets/api/x.jpg',
  ];
  for (const who of [w.A, w.B]) {
    for (const path of paths) {
      const before = snapshot(w.env);
      const res = await put(w.env, path, who.token);
      assert.equal(res.status, 404, `${who.id} ${path}: ${res.status}`);
      assert.equal(snapshot(w.env), before, `${who.id} ${path} wrote`);
    }
  }
  for (const k of w.env.imagepicker._store.keys()) assert.doesNotMatch(k, /(^|\/)api(\/|$)/, k);
});

test('a key that is not valid percent-encoding is 400, not a 500', async () => {
  const w = await world();
  const before = snapshot(w.env);
  const res = await put(w.env, '/2026/%E0%A4%A.jpg', SECRET);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'invalid_key');
  assert.equal(snapshot(w.env), before);
});

test('anonymous PUTs to the same paths are still 401 (who may upload is decided first)', async () => {
  const w = await world();
  for (const path of ['/', '/api/nothing.jpg', '/%61pi/x.jpg', '/2026/%E0%A4%A.jpg']) {
    assert.equal((await put(w.env, path, undefined)).status, 401, path);
  }
});

test('the default photographer\'s real writes still land: a photo, its thumbnails, an album background', async () => {
  const w = await world();
  const cases = [
    ['/2026%2F%E5%A9%9A%E7%A6%AE%2FIMG_001.JPG', '2026/婚禮/IMG_001.JPG', JPEG],
    [`/${encodeURIComponent('_thumbs/400/2026/婚禮/IMG_001.JPG.thumb')}`, '_thumbs/400/2026/婚禮/IMG_001.JPG.thumb', { 'Content-Type': 'image/webp' }],
    ['/_assets/backgrounds/1700000000_paper.jpg', 'backgrounds/1700000000_paper.jpg', JPEG],
    // a folder merely named like the API, deeper down, is a folder
    ['/2026/api/x.jpg', '2026/api/x.jpg', JPEG],
    // and a top folder that only starts with the letters
    ['/apiary/x.jpg', 'apiary/x.jpg', JPEG],
    // `//x.jpg` is the literal key `/x.jpg`, as before (in the writer's own files)
    ['//x.jpg', '/x.jpg', JPEG],
  ];
  for (const [path, key, headers] of cases) {
    const res = await put(w.env, path, SECRET, headers);
    assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`);
    assert.equal((await res.json()).key, key);
    assert.equal(w.env.imagepicker._store.get(key)?.body, 'BYTES', key);
  }
});
