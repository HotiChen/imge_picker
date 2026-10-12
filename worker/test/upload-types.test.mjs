// Security review of multi-photographer batch 3, finding 2: the upload PUT
// stored whatever Content-Type it was sent, and the object route served it
// back as stored — so a photographer (any of them once accounts open) could
// upload `x.html` as text/html or an SVG and hand out a link that runs script
// on the Worker's origin.
//
// Upload: the key's extension AND the Content-Type must both be a photo the
// app really uploads (upload.html takes jpg/jpeg/png/webp/heic/heif/tif/tiff/
// gif/avif/bmp; its thumbnails are `_thumbs/<w>/<key>.thumb` as webp or jpeg;
// the album editor's backgrounds are images under `_assets/`). A key the
// picker lists (.jpg/.jpeg/.png/.webp/.avif — the only ones `?list=` shows)
// may only be stored as jpeg/png/webp/avif, so whatever the grid, a
// thumbnail fallback or the lightbox asks for is served inline. GIF is
// image/gif; HEIC / HEIF / TIFF / BMP may also come as
// application/octet-stream (or with no type): browsers often know no type for
// them and upload.html then sends octet-stream. Those are never listed, and
// are served as downloads. Anything else — text/html, SVG, XML, script,
// text/plain, no extension — is 415 unsupported_type and nothing is written.
//
// Serving: every response of the object route (full, Range 206, 304, ?w=
// thumbnail, ?download=1, via the photographer or a link) carries
// `X-Content-Type-Options: nosniff` and `Content-Security-Policy:
// default-src 'none'; sandbox`; an object whose stored type is not
// jpeg/png/webp/avif (a legacy upload, or a HEIC / TIFF / GIF / BMP) goes out
// as application/octet-stream, as an attachment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { ctx, req } from './fakes.mjs';
import { setup, PROOF, PA, SECRET, call } from './revision-helpers.mjs';
import { seedPhotographer, snapshot, ROUTES_ON } from './tenant-helpers.mjs';

const CSP = "default-src 'none'; sandbox";
async function world() {
  const env = setup({ extra: ROUTES_ON });
  const B = await seedPhotographer(env);
  return { env, A: { id: 'default', token: SECRET, tag: 'A' }, B: { ...B, tag: 'B' } };
}
const at = (who, key) => (who.id === 'default' ? key : `_t/${who.id}/${key}`);
// a PUT with exactly these headers: a byte body, so fetch adds no type itself
const put = (env, path, token, type) => {
  const headers = type === undefined ? {} : { 'Content-Type': type };
  return worker.fetch(req(path, { method: 'PUT', token, headers, body: new Uint8Array([1, 2, 3]) }), env, ctx);
};
const enc = k => `/${encodeURIComponent(k)}`;

// ─── upload: what the app really sends lands ───────────────────────────────
const ALLOWED = [
  // [key, sent Content-Type, stored Content-Type]
  ['shoot/a.jpg', 'image/jpeg', 'image/jpeg'],
  ['shoot/IMG_0001.JPG', 'image/jpeg', 'image/jpeg'],
  ['shoot/b.jpeg', 'image/jpeg', 'image/jpeg'],
  ['shoot/c.png', 'image/png', 'image/png'],
  ['shoot/d.webp', 'image/webp', 'image/webp'],
  ['shoot/e.avif', 'image/avif', 'image/avif'],
  ['shoot/f.gif', 'image/gif', 'image/gif'],
  ['shoot/g.heic', 'image/heic', 'image/heic'],
  ['shoot/g2.HEIC', 'application/octet-stream', 'application/octet-stream'],
  ['shoot/h.heif', 'image/heif', 'image/heif'],
  ['shoot/i.tif', 'image/tiff', 'image/tiff'],
  ['shoot/i2.tiff', 'application/octet-stream', 'application/octet-stream'],
  ['shoot/j.bmp', 'image/bmp', 'image/bmp'],
  // parameters and case do not matter; what is stored is the bare type
  ['shoot/k.jpg', 'IMAGE/JPEG; charset=binary', 'image/jpeg'],
  // a type of another photo format than the extension says is still a photo
  ['shoot/l.jpg', 'image/png', 'image/png'],
  // no Content-Type at all: the extension's own type, as the route always defaulted to a photo
  ['shoot/m.jpg', undefined, 'image/jpeg'],
  ['shoot/n.png', undefined, 'image/png'],
  ['shoot/o.heic', undefined, 'image/heic'],
  // upload.html's thumbnails (webp, or jpeg where the browser cannot encode webp)
  ['_thumbs/400/shoot/a.jpg.thumb', 'image/webp', 'image/webp'],
  ['_thumbs/1200/shoot/IMG_0001.JPG.thumb', 'image/jpeg', 'image/jpeg'],
  ['_thumbs/400/shoot/g.heic.thumb', 'image/webp', 'image/webp'],
  ['_thumbs/400/shoot/m.jpg.thumb', undefined, 'image/jpeg'],
];

for (const whoName of ['A', 'B']) {
  test(`upload (${whoName}): every photo the app really uploads lands, with its type`, async () => {
    const w = await world();
    const who = w[whoName];
    for (const [key, sent, stored] of ALLOWED) {
      const res = await put(w.env, enc(key), who.token, sent);
      assert.equal(res.status, 200, `${key} ${sent}: ${await res.clone().text()}`);
      const obj = w.env.imagepicker._store.get(at(who, key));
      assert.ok(obj, `${key} stored`);
      assert.equal(obj.contentType, stored, key);
    }
    // the album editor's background: `_assets/` comes off, as before
    const bg = await put(w.env, '/_assets/backgrounds/1700000000_paper.jpg', who.token, 'image/jpeg');
    assert.equal(bg.status, 200);
    assert.equal(w.env.imagepicker._store.get(at(who, 'backgrounds/1700000000_paper.jpg'))?.contentType, 'image/jpeg');
  });
}

// ─── upload: nothing script-capable, nothing that is not a photo ───────────
const REFUSED = [
  ['shoot/x.html', 'text/html'],
  ['shoot/x.jpg', 'text/html'],
  ['shoot/x.html', 'image/jpeg'],
  ['shoot/x.htm', 'image/jpeg'],
  ['shoot/x.svg', 'image/svg+xml'],
  ['shoot/x.jpg', 'image/svg+xml'],
  ['shoot/x.jpg', 'IMAGE/SVG+XML; charset=utf-8'],
  ['shoot/x.svg', 'image/jpeg'],
  ['shoot/x.xml', 'application/xml'],
  ['shoot/x.jpg', 'text/xml'],
  ['shoot/x.js', 'application/javascript'],
  ['shoot/x.jpg', 'text/javascript'],
  ['shoot/x.jpg', 'text/plain'],
  ['shoot/x.jpg', 'application/pdf'],
  ['shoot/x.jpg', 'image/jpeg, text/html'],
  ['shoot/x.jpg', ''],
  ['shoot/x.json', 'application/json'],
  ['shoot/x.jpg.html', 'image/jpeg'],
  ['shoot/x.html.jpg', 'text/html'],
  ['shoot/noextension', 'image/jpeg'],
  ['shoot/.jpg', 'image/jpeg'],
  ['shoot/x.jpg/', 'image/jpeg'],
  // octet-stream only where browsers really send it (HEIC / HEIF / TIFF / BMP)
  ['shoot/x.jpg', 'application/octet-stream'],
  ['shoot/x.png', 'application/octet-stream'],
  ['shoot/x.gif', 'application/octet-stream'],
  // a listed extension is stored only as an inline type (it would be a
  // download, a broken image in the grid, otherwise)
  ['shoot/x.jpg', 'image/gif'],
  ['shoot/x.png', 'image/heic'],
  ['shoot/x.webp', 'image/tiff'],
  ['shoot/x.avif', 'image/bmp'],
  // and the other formats only as their own type
  ['shoot/x.gif', 'image/png'],
  ['shoot/x.heic', 'image/tiff'],
  ['shoot/x.tif', 'image/heic'],
  ['shoot/x.bmp', 'image/gif'],
  // no type is not a pass for a key that is no photo
  ['shoot/x.html', undefined],
  ['shoot/x.svg', undefined],
  // thumbnails: only under _thumbs/<digits>/, of a photo key, as jpeg/png/webp/avif
  ['shoot/x.thumb', 'image/webp'],
  ['_thumbs/400/shoot/x.html.thumb', 'image/webp'],
  ['_thumbs/400/shoot/x.jpg.thumb', 'image/svg+xml'],
  ['_thumbs/400/shoot/x.jpg.thumb', 'text/html'],
  ['_thumbs/400/shoot/x.jpg.thumb', 'image/gif'],
  ['_thumbs/400/shoot/x.jpg.thumb', 'application/octet-stream'],
  ['_thumbs/abc/shoot/x.jpg.thumb', 'image/webp'],
  ['_thumbs/400/shoot/x.jpg', 'text/html'],
];

for (const whoName of ['A', 'B']) {
  test(`upload (${whoName}): html, svg, xml, script, text, no extension → 415 unsupported_type, nothing written`, async () => {
    const w = await world();
    const who = w[whoName];
    for (const [key, sent] of REFUSED) {
      const before = snapshot(w.env);
      const res = await put(w.env, enc(key), who.token, sent);
      assert.equal(res.status, 415, `${key} ${JSON.stringify(sent)}: ${res.status}`);
      assert.equal((await res.json()).code, 'unsupported_type');
      assert.equal(snapshot(w.env), before, `${key} wrote`);
    }
    // through the album editor's `_assets/` path too
    const res = await put(w.env, '/_assets/backgrounds/1_x.svg', who.token, 'image/svg+xml');
    assert.equal(res.status, 415);
  });
}

test('upload → serve: whatever is accepted under a key the picker lists comes back inline, never as a download', async () => {
  const w = await world();
  const types = [undefined, 'image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif', 'image/heic', 'image/heif',
    'image/tiff', 'image/bmp', 'application/octet-stream', 'IMAGE/PNG; x=1'];
  let accepted = 0;
  for (const ext of ['jpg', 'JPG', 'jpeg', 'png', 'webp', 'avif']) {
    for (const [i, type] of types.entries()) {
      const key = `shoot/t${i}.${ext}`;
      const res = await put(w.env, enc(key), SECRET, type);
      if (res.status !== 200) { assert.equal(res.status, 415, `${key} ${type}`); continue; }
      accepted += 1;
      const got = await call(w.env, enc(key), { token: SECRET });
      assert.match(got.headers.get('Content-Type'), /^image\/(jpeg|png|webp|avif)$/, `${key} ${type}`);
      assert.equal(got.headers.get('Content-Disposition'), null, `${key} ${type}`);
    }
  }
  // no type, and the four inline ones (one with parameters), on each of the six
  assert.equal(accepted, 6 * 6);
});

test('upload: who may upload is still decided first (401), and the reserved and empty keys keep their 400', async () => {
  const w = await world();
  assert.equal((await put(w.env, '/shoot/x.html', undefined, 'text/html')).status, 401);
  assert.equal((await put(w.env, `/_t/${w.B.id}/x.html`, SECRET, 'text/html')).status, 400);
  assert.equal((await put(w.env, '/', SECRET, 'text/html')).status, 400);
});

// ─── serving: nosniff + sandbox CSP everywhere; non-photos as attachments ──
const LEGACY = {
  // stored by the old route as sent
  'shoot/毛片/evil.jpg': 'text/html',
  'shoot/毛片/evil.svg': 'image/svg+xml',
  'shoot/毛片/evil.html': 'text/html; charset=utf-8',
  'shoot/毛片/raw.heic': 'image/heic',
  'shoot/毛片/scan.tif': 'application/octet-stream',
  'shoot/毛片/anim.gif': 'image/gif',
  // the four that are served inline
  'shoot/毛片/ok.jpg': 'image/jpeg',
  'shoot/毛片/ok.png': 'image/png',
  'shoot/毛片/ok.webp': 'image/webp; q=1',
  'shoot/毛片/ok.avif': 'IMAGE/AVIF',
};
const INLINE = /^shoot\/毛片\/ok\./;
function seed(env, who) {
  for (const [key, type] of Object.entries(LEGACY)) {
    const k = at(who, key);
    env.imagepicker._store.set(k, { key: k, body: `${who.tag}:${key}`, contentType: type, uploaded: new Date('2026-01-01T00:00:00Z') });
    // a thumbnail stored with the same type as its original
    const t = at(who, `_thumbs/400/${key}.thumb`);
    env.imagepicker._store.set(t, { key: t, body: `${who.tag}:T:${key}`, contentType: type, uploaded: new Date('2026-01-01T00:00:00Z') });
  }
}
async function studioToken(env, who) {
  const res = await call(env, '/api/auth/studio-token', { method: 'POST', token: who.token });
  return (await res.json()).token;
}
function assertHardened(res, key, label, { download = false } = {}) {
  const tag = `${label} ${key} (${res.status})`;
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff', tag);
  assert.equal(res.headers.get('Content-Security-Policy'), CSP, tag);
  const type = res.headers.get('Content-Type');
  const disposition = res.headers.get('Content-Disposition');
  if (INLINE.test(key)) {
    assert.match(type, /^image\/(jpeg|png|webp|avif)/i, tag);
    if (download) assert.match(disposition, /^attachment;/, tag);
    else assert.equal(disposition, null, tag);
  } else {
    assert.equal(type, 'application/octet-stream', tag);
    assert.match(disposition || '', /^attachment;/, tag);
  }
}

for (const whoName of ['A', 'B']) {
  test(`serving (${whoName}): full, Range 206, 304, ?w= thumbnail, ?download=1 — by the photographer and by a studio token`, async () => {
    const w = await world();
    const who = w[whoName];
    seed(w.env, who);
    const studio = await studioToken(w.env, who);
    const ways = [
      ['photographer', path => call(w.env, path, { token: who.token })],
      ['studio token', path => call(w.env, `${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(studio)}`)],
    ];
    let scanned = 0;
    for (const [label, get] of ways) {
      for (const key of Object.keys(LEGACY)) {
        const path = `/${encodeURIComponent(key)}`;
        const full = await get(path);
        assert.equal(full.status, 200, `${label} ${key}`);
        assert.equal(await full.text(), `${who.tag}:${key}`);
        assertHardened(full, key, `${label} full`);

        const range = await (label === 'photographer'
          ? call(w.env, path, { token: who.token, headers: { Range: 'bytes=0-1' } })
          : call(w.env, `${path}?t=${encodeURIComponent(studio)}`, { headers: { Range: 'bytes=0-1' } }));
        assert.equal(range.status, 206, `${label} ${key} range`);
        assertHardened(range, key, `${label} range`);

        const etag = full.headers.get('etag');
        const cached = await (label === 'photographer'
          ? call(w.env, path, { token: who.token, headers: { 'If-None-Match': etag } })
          : call(w.env, `${path}?t=${encodeURIComponent(studio)}`, { headers: { 'If-None-Match': etag } }));
        assert.equal(cached.status, 304, `${label} ${key} 304`);
        assertHardened(cached, key, `${label} 304`);

        const thumb = await get(`${path}?w=400`);
        assert.equal(thumb.status, 200);
        assert.equal(await thumb.text(), `${who.tag}:T:${key}`);
        assertHardened(thumb, key, `${label} ?w=`);

        const direct = await get(`/${encodeURIComponent(`_thumbs/400/${key}.thumb`)}`);
        if (label === 'photographer') {
          assert.equal(direct.status, 200);
          assertHardened(direct, key, `${label} thumb key`);
        }

        const dl = await get(`${path}?download=1`);
        assert.equal(dl.status, 200);
        assertHardened(dl, key, `${label} download`, { download: true });
        scanned += 1;
      }
    }
    assert.equal(scanned, 2 * Object.keys(LEGACY).length);
  });
}

test('serving through a pick link: the delivered preview and the original carry the same headers', async () => {
  const w = await world();
  seed(w.env, w.A);
  const res = await call(w.env, '/api/admin/projects', { method: 'POST', token: SECRET, body: { title: 't', folders: [PROOF] } });
  const { project, token } = await res.json();
  // picking: the thumbnail only
  for (const key of ['shoot/毛片/evil.jpg', 'shoot/毛片/ok.jpg', PA]) {
    const t = await call(w.env, `/${encodeURIComponent(key)}?w=400&t=${encodeURIComponent(token)}`);
    assert.equal(t.status, 200, key);
    const k = key === PA ? 'shoot/毛片/ok.jpg' : key;   // PA is a plain jpeg
    assertHardened(t, k, 'pick ?w=');
  }
  // proofs downloadable: the original too
  w.env.DB._db.prepare('UPDATE projects SET allow_proof_download = 1 WHERE id = ?').run(project.id);
  const o = await call(w.env, `/${encodeURIComponent('shoot/毛片/evil.svg')}?t=${encodeURIComponent(token)}`);
  assert.equal(o.status, 200);
  assertHardened(o, 'shoot/毛片/evil.svg', 'pick original');
});
