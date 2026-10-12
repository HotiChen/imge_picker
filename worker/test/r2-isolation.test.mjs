// Batch 3 of docs/multi-photographer.md: R2 / file isolation.
//
// One bucket. The default photographer's objects stay where they are; every
// other photographer's live under `_t/<id>/`. Every R2 call goes through one
// helper (bucketFor) that adds the prefix on the way in and strips it on the
// way out, so what clients, share links, selections and orders store — the
// LOGICAL key — never carries it. The `_t/` namespace is reserved: no request
// can name a `_t/...` key itself, for any photographer, the default included
// (whose keys are not prefixed, so `_t/B/x` typed by the default would BE B's).
//
// Three photographers in one database on every R2 path: A = the default
// (PHOTOGRAPHER_TOKEN), B and C = two real accounts (sessions, switch on). Each
// holds an object under the same logical key with its own content, so a read
// that lands in the wrong prefix shows up as the wrong bytes, not as a 404 that
// any refusal would also give.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeBucket } from './fakes.mjs';
import {
  OBJECTS, PROOF, FINAL, PA, PB, F1, F3,
  setup, admin, guest, putPins, submitRound, photo, pin,
  SECRET, call, pick, claim, save, one, rows,
} from './revision-helpers.mjs';
import { seedPhotographer, snapshot, ROUTES_ON } from './tenant-helpers.mjs';

const SRC = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const NOPE = '00000000-0000-4000-8000-000000000000';
const t = token => encodeURIComponent(token);

// ─── the world ─────────────────────────────────────────────────────────────
// A's objects are revision-helpers' OBJECTS, unprefixed. B and C each get a
// copy of the shoot under their own prefix, every byte tagged with the owner
// (`B:PA-ORIG`), and one photo only they have.
function tenantObjects(id, tag) {
  const out = {};
  for (const [k, v] of Object.entries(OBJECTS)) {
    if (k.startsWith('other/') || k.includes('/other/')) continue;   // A's alone
    out[`_t/${id}/${k}`] = `${tag}:${v}`;
  }
  out[`_t/${id}/${PROOF}${tag}-only.jpg`] = `${tag}-ONLY`;
  return out;
}

async function world({ pageSize } = {}) {
  const env = setup({ extra: ROUTES_ON });
  const B = { ...(await seedPhotographer(env)), tag: 'B' };
  const C = { ...(await seedPhotographer(env)), tag: 'C' };
  const A = { id: 'default', token: SECRET, tag: 'A' };
  const objects = { ...OBJECTS, ...tenantObjects(B.id, 'B'), ...tenantObjects(C.id, 'C') };
  env.imagepicker = fakeBucket(objects, pageSize ? { pageSize } : undefined);
  return { env, A, B, C };
}
// the R2 key a logical key lands on for `who`
const at = (who, key) => (who.id === 'default' ? key : `_t/${who.id}/${key}`);
const stored = (env, key) => env.imagepicker._store.get(key)?.body;
const keysOf = env => [...env.imagepicker._store.keys()].sort();

const read = async (env, path, token) => {
  const res = await call(env, path, { token });
  return { status: res.status, text: await res.text(), res };
};
const list = async (env, prefix, token, link) => {
  const res = await call(env, `/?list=${encodeURIComponent(prefix)}${link ? `&t=${t(link)}` : ''}`, { token });
  return { status: res.status, body: res.status === 200 ? await res.json() : await res.text() };
};

// a project made by `who` through the real route, and the guest flow on it
async function project(w, who, folders = [PROOF]) {
  const res = await call(w.env, '/api/admin/projects', {
    method: 'POST', token: who.token, body: { title: `${who.tag} 婚紗`, folders, pick_limit: 40, extra_price: 200 },
  });
  assert.equal(res.status, 201, `${who.tag} create: ${await res.clone().text()}`);
  const created = await res.json();
  return { id: created.project.id, token: created.token, created };
}
async function retouchingAs(w, who) {
  const p = await project(w, who);
  const c = await claim(w.env, p.token);
  p.key = c.key;
  assert.equal((await save(w.env, p.token, p.key, { upsert: [{ photo_key: PA, rating: 1, marks: [pin(0.2, 0.2, '臉')] }, { photo_key: PB, rating: 1 }] })).status, 200);
  assert.equal((await guest(w.env, 'POST', 'submit', p.token, p.key, { relationship: '本人' })).status, 200);
  assert.equal((await admin(w.env, p.id, 'start-retouch', undefined, who.token)).status, 200);
  return p;
}
async function deliveredAs(w, who) {
  const p = await retouchingAs(w, who);
  const res = await admin(w.env, p.id, 'deliver', { final_folders: [FINAL] }, who.token);
  assert.equal(res.status, 200, `${who.tag} deliver: ${await res.clone().text()}`);
  return p;
}

// ─── upload ────────────────────────────────────────────────────────────────
test('upload: each photographer\'s PUT lands under its own prefix (the default\'s unprefixed); the answer names the logical key', async () => {
  const w = await world();
  for (const who of [w.A, w.B, w.C]) {
    const res = await call(w.env, '/shoot/new/n.jpg', { method: 'PUT', token: who.token, body: `${who.tag}-NEW`, headers: { 'Content-Type': 'image/png' } });
    assert.equal(res.status, 200, who.tag);
    assert.deepEqual(await res.json(), { ok: true, key: 'shoot/new/n.jpg' }, `${who.tag}: the logical key, never the prefix`);
    assert.equal(stored(w.env, at(who, 'shoot/new/n.jpg')), `${who.tag}-NEW`, who.tag);
  }
  // the default's write did not land in a tenant prefix, and nothing else appeared
  assert.equal(keysOf(w.env).filter(k => k.endsWith('shoot/new/n.jpg')).length, 3);
  // each reads back its own bytes, with the content type it sent
  for (const who of [w.A, w.B, w.C]) {
    const r = await read(w.env, '/shoot/new/n.jpg', who.token);
    assert.equal(r.text, `${who.tag}-NEW`, who.tag);
    assert.equal(r.res.headers.get('Content-Type'), 'image/png');
  }
});

test('upload: thumbnails and `_assets/` follow the same prefix (the upload page writes `_thumbs/<w>/<key>.thumb`)', async () => {
  const w = await world();
  const B = w.B;
  assert.equal((await call(w.env, '/shoot/new/n.jpg', { method: 'PUT', token: B.token, body: 'B-NEW' })).status, 200);
  assert.equal((await call(w.env, '/_thumbs/400/shoot/new/n.jpg.thumb', { method: 'PUT', token: B.token, body: 'B-NEW-T400' })).status, 200);
  assert.equal(stored(w.env, `_t/${B.id}/_thumbs/400/shoot/new/n.jpg.thumb`), 'B-NEW-T400');
  assert.equal(stored(w.env, '_thumbs/400/shoot/new/n.jpg.thumb'), undefined, 'not in the default\'s thumbnails');
  assert.equal((await read(w.env, '/shoot/new/n.jpg?w=400', B.token)).text, 'B-NEW-T400');
  const res = await call(w.env, '/_assets/logo.png', { method: 'PUT', token: B.token, body: 'LOGO' });
  assert.deepEqual(await res.json(), { ok: true, key: 'logo.png' });
  assert.equal(stored(w.env, `_t/${B.id}/logo.png`), 'LOGO');
  assert.equal(stored(w.env, 'logo.png'), undefined);
});

test('upload: a key in the reserved `_t/` namespace is refused (400) for every photographer, however it is spelled, and nothing is written', async () => {
  const w = await world();
  const C = w.C;
  const victim = at(C, PA);
  const had = stored(w.env, victim);
  const spellings = [
    `/_t/${C.id}/${PA}`,
    `/_assets/_t/${C.id}/${PA}`,                       // stripped to _t/... first
    `/%5Ft/${C.id}/${PA}`,                             // %5F = _
    `/_t%2F${C.id}%2F${encodeURIComponent(PA)}`,       // encoded slashes
    `/%2e%2e/_t/${C.id}/${PA}`,                        // URL-normalised away
    `/x/../_t/${C.id}/${PA}`,
    `/_t\\${C.id}\\x.jpg`,                             // a backslash is a slash in an https URL
    '/_t', '/_t/', '/_t/x',
  ];
  for (const who of [w.A, w.B, w.C]) {
    for (const path of spellings) {
      const before = snapshot(w.env);
      const res = await call(w.env, path, { method: 'PUT', token: who.token, body: `${who.tag}-EVIL` });
      assert.equal(res.status, 400, `${who.tag} PUT ${path}: ${res.status}`);
      assert.equal(snapshot(w.env), before, `${who.tag} PUT ${path} wrote`);
    }
  }
  assert.equal(stored(w.env, victim), had);
});

test('upload: keys that only look like escaping stay literal, inside the writer\'s own prefix', async () => {
  const w = await world();
  const { B, C } = w;
  const victim = at(C, PA);
  const had = stored(w.env, victim);
  for (const path of [`/..%2F_t%2F${C.id}%2F${encodeURIComponent(PA)}`, `/..%2F${C.id}%2F${encodeURIComponent(PA)}`, `//_t/${C.id}/${PA}`]) {
    const before = new Set(keysOf(w.env));
    const res = await call(w.env, path, { method: 'PUT', token: B.token, body: 'B-EVIL' });
    assert.equal(res.status, 200, path);
    const added = keysOf(w.env).filter(k => !before.has(k));
    assert.equal(added.length, 1, path);
    assert.ok(added[0].startsWith(`_t/${B.id}/`), `${path} landed at ${added[0]}`);
  }
  assert.equal(stored(w.env, victim), had, 'C\'s object was overwritten');
  // the default's literal `/_t/...` (a leading slash) is not the reserved namespace and not C's key
  const res = await call(w.env, `//_t/${C.id}/${PA}`, { method: 'PUT', token: SECRET, body: 'A-SLASH' });
  assert.equal(res.status, 200);
  assert.equal(stored(w.env, `/_t/${C.id}/${PA}`), 'A-SLASH');
  assert.equal(stored(w.env, victim), had);
});

test('upload: anyone without a photographer identity is refused (401), a share link included', async () => {
  const w = await world();
  const p = await project(w, w.B);
  const before = snapshot(w.env);
  for (const path of ['/shoot/new/n.jpg', `/shoot/new/n.jpg?t=${t(p.token)}`]) {
    assert.equal((await call(w.env, path, { method: 'PUT', body: 'x' })).status, 401, path);
  }
  assert.equal(snapshot(w.env), before);
});

// ─── list ──────────────────────────────────────────────────────────────────
test('?list=: each photographer lists its own objects under logical keys, never another\'s', async () => {
  const w = await world();
  const names = r => r.body.data.map(f => f.id).sort();
  const a = await list(w.env, PROOF, SECRET);
  assert.equal(a.status, 200);
  assert.deepEqual(names(a), [PA, PB]);
  for (const who of [w.B, w.C]) {
    const r = await list(w.env, PROOF, who.token);
    assert.equal(r.status, 200, who.tag);
    assert.deepEqual(names(r), [`${PROOF}${who.tag}-only.jpg`, PA, PB].sort(), who.tag);
    assert.ok(!JSON.stringify(r.body).includes('_t/'), `${who.tag}: a prefix leaked into the listing`);
    const other = who === w.B ? w.C : w.B;
    assert.ok(!JSON.stringify(r.body).includes(`${other.tag}-only`), `${who.tag} saw ${other.tag}'s photo`);
  }
  assert.ok(!JSON.stringify(a.body).includes('-only'), 'the default saw a tenant photo');
});

test('?list= at the root: the default never sees `_t/` (nor any tenant id); a tenant sees only its own folders', async () => {
  const w = await world();
  const a = await list(w.env, '', SECRET);
  assert.equal(a.status, 200);
  assert.ok(!a.body.folders.some(f => f.startsWith('_')), JSON.stringify(a.body.folders));
  assert.ok(a.body.folders.includes('other/'));
  for (const who of [w.B, w.C]) {
    const r = await list(w.env, '', who.token);
    assert.deepEqual(r.body.folders, ['shoot/'], who.tag);
    assert.ok(!JSON.stringify(r.body).includes(w.B.id) && !JSON.stringify(r.body).includes(w.C.id), who.tag);
  }
  for (const prefix of ['_', '_t']) {
    const r = await list(w.env, prefix, SECRET);
    assert.equal(r.status, 200);
    assert.ok(!JSON.stringify(r.body).includes(w.B.id), `${prefix}: ${JSON.stringify(r.body)}`);
  }
});

test('?list= of a reserved `_t/` prefix lists nothing, for every photographer (the same answer as an empty folder)', async () => {
  const w = await world();
  const empty = (await list(w.env, 'no-such-folder/', SECRET)).body;
  assert.deepEqual(empty, { status: 'success', data: [], folders: [] });
  for (const who of [w.A, w.B, w.C]) {
    for (const prefix of ['_t/', `_t/${w.B.id}/`, `_t/${w.B.id}/${PROOF}`, `_t/${w.C.id}/`, `_t/${w.B.id}`]) {
      const r = await list(w.env, prefix, who.token);
      assert.equal(r.status, 200, `${who.tag} ${prefix}`);
      assert.deepEqual(r.body, empty, `${who.tag} ${prefix}`);
    }
  }
});

test('?list= follows R2\'s cursor through pages and still returns only the caller\'s objects', async () => {
  const w = await world({ pageSize: 2 });
  const { B } = w;
  const folder = 'big/';
  for (let i = 0; i < 5; i++) {
    w.env.imagepicker._store.set(`_t/${B.id}/${folder}${i}.jpg`, { key: 'x', body: `B${i}`, contentType: 'image/jpeg', uploaded: new Date() });
    w.env.imagepicker._store.set(`${folder}${i}a.jpg`, { key: 'x', body: `A${i}`, contentType: 'image/jpeg', uploaded: new Date() });
    w.env.imagepicker._store.set(`_t/${w.C.id}/${folder}${i}c.jpg`, { key: 'x', body: `C${i}`, contentType: 'image/jpeg', uploaded: new Date() });
  }
  const r = await list(w.env, folder, B.token);
  assert.deepEqual(r.body.data.map(f => f.id).sort(), [0, 1, 2, 3, 4].map(i => `${folder}${i}.jpg`));
  assert.ok(r.body.data.every(f => f.name && f.size === 2));
  const a = await list(w.env, folder, SECRET);
  assert.deepEqual(a.body.data.map(f => f.id).sort(), [0, 1, 2, 3, 4].map(i => `${folder}${i}a.jpg`));
});

// ─── object reads ──────────────────────────────────────────────────────────
test('GET object: the same logical key gives each photographer its own bytes', async () => {
  const w = await world();
  assert.equal((await read(w.env, `/${PA}`, SECRET)).text, 'PA-ORIG');
  for (const who of [w.B, w.C]) {
    assert.equal((await read(w.env, `/${PA}`, who.token)).text, `${who.tag}:PA-ORIG`, who.tag);
    assert.equal((await read(w.env, `/${PROOF}${who.tag}-only.jpg`, who.token)).text, `${who.tag}-ONLY`);
  }
  // what only one photographer has is a missing object to everyone else
  const missing = await read(w.env, '/no/such.jpg', SECRET);
  assert.equal(missing.status, 404);
  for (const [who, key] of [[w.A, `${PROOF}B-only.jpg`], [w.C, `${PROOF}B-only.jpg`], [w.B, 'other/x.jpg'], [w.B, `${PROOF}C-only.jpg`]]) {
    const r = await read(w.env, `/${key}`, who.token);
    assert.equal(r.status, 404, `${who.tag} ${key}`);
    assert.equal(r.text, missing.text);
  }
});

test('GET object: a `_t/...` key typed by anyone is a missing object (404), never another photographer\'s bytes', async () => {
  const w = await world();
  const missing = await read(w.env, '/no/such.jpg', SECRET);
  for (const who of [w.A, w.B, w.C]) {
    for (const path of [`/_t/${w.B.id}/${PA}`, `/_t/${w.C.id}/${PA}`, `/%5Ft/${w.B.id}/${PA}`, `/x/../_t/${w.B.id}/${PA}`,
      `/_t/${w.B.id}/${PA}?w=400`, `/_t/${w.B.id}/${PA}?download=1`, `/_thumbs/400/_t/${w.B.id}/${PA}.thumb`]) {
      const r = await read(w.env, path, who.token);
      assert.equal(r.status, 404, `${who.tag} ${path}: ${r.status} ${r.text}`);
      assert.equal(r.text, missing.text, `${who.tag} ${path}`);
    }
  }
});

test('GET object ?w=: a tenant\'s thumbnail, falling back to its own original — never the default\'s thumbnail', async () => {
  const w = await world();
  const { B } = w;
  assert.equal((await read(w.env, `/${PA}?w=400`, B.token)).text, 'B:PA-T400');
  assert.equal((await read(w.env, `/${PA}?w=1000`, B.token)).text, 'B:PA-T1200');
  assert.equal((await read(w.env, `/_thumbs/400/${PA}.thumb`, B.token)).text, 'B:PA-T400');
  // B has no thumbnail: B's original, though the default has one for the same key
  w.env.imagepicker._store.delete(`_t/${B.id}/_thumbs/400/${PA}.thumb`);
  w.env.imagepicker._store.delete(`_t/${B.id}/_thumbs/1200/${PA}.thumb`);
  assert.equal((await read(w.env, `/${PA}?w=400`, B.token)).text, 'B:PA-ORIG');
  assert.equal((await read(w.env, `/${PA}?w=400`, SECRET)).text, 'PA-T400');
});

test('GET object ?download=1: the caller\'s own original as an attachment', async () => {
  const w = await world();
  for (const who of [w.A, w.B, w.C]) {
    const r = await read(w.env, `/${PA}?download=1`, who.token);
    assert.equal(r.status, 200);
    assert.equal(r.text, who.id === 'default' ? 'PA-ORIG' : `${who.tag}:PA-ORIG`);
    assert.match(r.res.headers.get('Content-Disposition'), /^attachment; filename="a\.jpg"/);
  }
});

test('GET object: a Range request and a conditional request read the caller\'s own object', async () => {
  const w = await world();
  const res = await call(w.env, `/${PA}`, { token: w.B.token, headers: { Range: 'bytes=0-1' } });
  assert.equal(res.status, 206);
  assert.equal(await res.text(), 'B:');
  const etag = (await call(w.env, `/${PA}`, { token: w.B.token })).headers.get('etag');
  const again = await call(w.env, `/${PA}`, { token: w.B.token, headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
});

// ─── studio tokens read their owner's prefix only ──────────────────────────
async function studio(env, who) {
  const res = await call(env, '/api/auth/studio-token', { method: 'POST', token: who.token });
  assert.equal(res.status, 200, `${who.tag}: ${await res.clone().text()}`);
  return (await res.json()).token;
}
test('studio token: each photographer\'s reads its own prefix only (objects, thumbnails, listings)', async () => {
  const w = await world();
  const tokens = { A: await studio(w.env, w.A), B: await studio(w.env, w.B), C: await studio(w.env, w.C) };
  assert.equal(new Set(Object.values(tokens)).size, 3, 'three tokens');
  assert.equal((await read(w.env, `/${PA}?t=${t(tokens.A)}`)).text, 'PA-ORIG');
  for (const who of [w.B, w.C]) {
    const tk = t(tokens[who.tag]);
    assert.equal((await read(w.env, `/${PA}?t=${tk}`)).text, `${who.tag}:PA-ORIG`, who.tag);
    assert.equal((await read(w.env, `/${PA}?w=400&t=${tk}`)).text, `${who.tag}:PA-T400`, who.tag);
    assert.equal((await read(w.env, `/other/x.jpg?t=${tk}`)).status, 404, `${who.tag}: the default's photo`);
    const other = who === w.B ? w.C : w.B;
    assert.equal((await read(w.env, `/${PROOF}${other.tag}-only.jpg?t=${tk}`)).status, 404, `${who.tag}: ${other.tag}'s photo`);
    const root = await list(w.env, '', undefined, tokens[who.tag]);
    assert.deepEqual(root.body.folders, ['shoot/'], who.tag);
    const proofs = await list(w.env, PROOF, undefined, tokens[who.tag]);
    assert.deepEqual(proofs.body.data.map(f => f.id).sort(), [`${PROOF}${who.tag}-only.jpg`, PA, PB].sort());
  }
  // the default's token: unprefixed only — `_t/` is internal (401) to every link, and lists nothing
  for (const tk of Object.values(tokens)) {
    assert.equal((await read(w.env, `/_t/${w.B.id}/${PA}?t=${t(tk)}`)).status, 401);
    assert.deepEqual((await list(w.env, `_t/${w.B.id}/`, undefined, tk)).body, { status: 'success', data: [], folders: [] });
  }
  assert.ok(!(await list(w.env, '', undefined, tokens.A)).body.folders.some(f => f.startsWith('_')));
});

// ─── guest links read their project's photographer's prefix ────────────────
test('a guest link of B\'s project reads B\'s prefix only — never the default\'s, even for the same logical key', async () => {
  const w = await world();
  const b = await project(w, w.B);
  const a = await project(w, w.A);
  // originals too, not only previews (B's own switch, on B's own project)
  for (const [p, who] of [[b, w.B], [a, w.A]]) {
    const res = await call(w.env, `/api/admin/projects/${p.id}`, { method: 'PATCH', token: who.token, body: { allow_proof_download: true } });
    assert.equal(res.status, 200, who.tag);
  }
  assert.equal(one(w.env, 'SELECT photographer_id FROM projects WHERE id = ?', b.id).photographer_id, w.B.id);
  const r = await list(w.env, PROOF, undefined, b.token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map(f => f.id).sort(), [`${PROOF}B-only.jpg`, PA, PB].sort());
  assert.equal((await read(w.env, `/${PA}?t=${t(b.token)}`)).text, 'B:PA-ORIG');
  assert.equal((await read(w.env, `/${PA}?w=400&t=${t(b.token)}`)).text, 'B:PA-T400');
  assert.equal((await read(w.env, `/${PA}?t=${t(a.token)}`)).text, 'PA-ORIG', 'the default\'s link: the default\'s bytes');
  assert.equal((await list(w.env, PROOF, undefined, a.token)).body.data.length, 2);
  // B's object gone: 404, not a fall back to the default's same key
  w.env.imagepicker._store.delete(`_t/${w.B.id}/${PA}`);
  w.env.imagepicker._store.delete(`_t/${w.B.id}/_thumbs/400/${PA}.thumb`);
  w.env.imagepicker._store.delete(`_t/${w.B.id}/_thumbs/1200/${PA}.thumb`);
  assert.equal((await read(w.env, `/${PA}?t=${t(b.token)}`)).status, 404);
  assert.equal((await read(w.env, `/${PA}?w=400&t=${t(b.token)}`)).status, 404);
  // and a link never reads a `_t/` key at all
  assert.equal((await read(w.env, `/_t/${w.C.id}/${PA}?t=${t(b.token)}`)).status, 401);
});

test('a guest link takes the photographer from its project, not from the request', async () => {
  const w = await world();
  const b = await project(w, w.B);
  assert.equal((await call(w.env, `/api/admin/projects/${b.id}`, { method: 'PATCH', token: w.B.token, body: { allow_proof_download: true } })).status, 200);
  // a photographer token riding along does not move the link to its own prefix
  for (const hdr of [{ 'X-Photographer-Id': 'default' }, { 'X-Photographer-Id': w.C.id }]) {
    const res = await call(w.env, `/${PA}?t=${t(b.token)}&photographer_id=default`, { headers: hdr });
    assert.equal(await res.text(), 'B:PA-ORIG');
  }
  // the project handed to C (as the operator might, by hand): the link now reads C's
  w.env.DB._db.prepare('UPDATE projects SET photographer_id = ? WHERE id = ?').run(w.C.id, b.id);
  assert.equal((await read(w.env, `/${PA}?t=${t(b.token)}`)).text, 'C:PA-ORIG');
});

// ─── delivery: the finals gate for a non-default project ───────────────────
test('deliver / undeliver: B delivers its own project; the link reads B\'s finals only while delivered', async () => {
  const w = await world();
  const p = await deliveredAs(w, w.B);
  const row = one(w.env, 'SELECT delivered_at, final_folders FROM projects WHERE id = ?', p.id);
  assert.ok(row.delivered_at);
  assert.equal(row.final_folders, JSON.stringify([FINAL]));
  assert.equal((await read(w.env, `/${F1}?t=${t(p.token)}`)).text, 'B:F1-ORIG');
  assert.deepEqual((await list(w.env, FINAL, undefined, p.token)).body.data.map(f => f.id).sort(), [F1, 'shoot/精修/f2.jpg', F3].sort());
  const st = await (await pick(w.env, 'GET', 'state', p.token, { key: p.key })).json();
  assert.ok(JSON.stringify(st).includes(FINAL), 'the state shows the finals');
  const res = await admin(w.env, p.id, 'undeliver', undefined, w.B.token);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, delivered_at: null });
  assert.equal((await read(w.env, `/${F1}?t=${t(p.token)}`)).status, 401, 'no finals once undelivered');
  assert.equal((await list(w.env, FINAL, undefined, p.token)).status, 401);
});

for (const action of ['deliver', 'undeliver']) {
  test(`${action}: another photographer's project is a nonexistent one — 404, same body, same statements, nothing written (A↔B, B↔C)`, async () => {
    const w = await world();
    const pb = await retouchingAs(w, w.B);
    const pc = await retouchingAs(w, w.C);
    const pa = await retouchingAs(w, w.A);
    if (action === 'undeliver') {
      for (const [p, who] of [[pb, w.B], [pc, w.C], [pa, w.A]]) assert.equal((await admin(w.env, p.id, 'deliver', { final_folders: [FINAL] }, who.token)).status, 200);
    }
    const body = action === 'deliver' ? { final_folders: [FINAL] } : undefined;
    for (const [caller, target] of [[w.A, pb], [w.C, pb], [w.B, pc], [w.B, pa], [w.C, pa]]) {
      const before = snapshot(w.env);
      const mark = w.env.DB._sql.length;
      const res = await admin(w.env, target.id, action, body, caller.token);
      const text = await res.text();
      const statements = w.env.DB._sql.slice(mark);
      assert.equal(res.status, 404, `${caller.tag} → ${text}`);
      assert.equal(snapshot(w.env), before, `${caller.tag} wrote`);
      const mark2 = w.env.DB._sql.length;
      const none = await admin(w.env, NOPE, action, body, caller.token);
      assert.equal(none.status, 404);
      assert.equal(text, await none.text());
      assert.deepEqual(statements, w.env.DB._sql.slice(mark2), `${caller.tag}: the statements tell someone else's project from none`);
    }
    // the owners still can (positive control)
    for (const [p, who] of [[pb, w.B], [pc, w.C], [pa, w.A]]) assert.equal((await admin(w.env, p.id, action, body, who.token)).status, 200, who.tag);
  });
}

// ─── round thumbnails: the one guest read outside pickFinals ───────────────
test('GET /api/pick/rounds/:id/photo of B\'s project serves B\'s thumbnail, never the default\'s', async () => {
  const w = await world();
  const p = await deliveredAs(w, w.B);
  assert.equal((await putPins(w.env, p.token, p.key, [{ photo_key: F1, marks: [pin(0.1, 0.1, '去掉路人')] }])).status, 200);
  const sub = await submitRound(w.env, p.token, p.key, { note: '亮一點', expect: [{ k: F1, n: 1 }] });
  assert.equal(sub.status, 200, await sub.clone().text());
  const { id } = await sub.json();
  const res = await photo(w.env, p.token, p.key, id, 'i=0&w=400');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'B:F1-T400');
  assert.equal(await (await photo(w.env, p.token, p.key, id, 'i=0&w=1200')).text(), 'B:F1-T1200');
  w.env.imagepicker._store.delete(`_t/${w.B.id}/_thumbs/400/${F1}.thumb`);
  const gone = await photo(w.env, p.token, p.key, id, 'i=0&w=400');
  assert.equal(gone.status, 404, 'B\'s thumbnail gone: 404, not the default\'s');
  assert.equal((await gone.json()).code, 'no_thumbnail');
});

// ─── create ────────────────────────────────────────────────────────────────
test('POST /api/admin/projects: each photographer\'s project is its own (a body photographer_id is ignored); no one else lists it', async () => {
  const w = await world();
  const made = {};
  for (const who of [w.A, w.B, w.C]) {
    const res = await call(w.env, '/api/admin/projects', {
      method: 'POST', token: who.token, body: { title: `${who.tag} 新案`, folders: [PROOF], photographer_id: 'default' },
    });
    assert.equal(res.status, 201, who.tag);
    const out = await res.json();
    assert.equal(out.project.photographer_id, who.id, who.tag);
    assert.equal(one(w.env, 'SELECT photographer_id FROM projects WHERE id = ?', out.project.id).photographer_id, who.id);
    made[who.tag] = out.project.id;
  }
  for (const who of [w.A, w.B, w.C]) {
    const listed = (await (await call(w.env, '/api/admin/projects', { token: who.token })).json()).projects.map(p => p.id);
    assert.deepEqual(listed, [made[who.tag]], who.tag);
  }
});

test('POST /api/admin/projects: the studio default plan is the caller\'s own (studio_settings of who.id)', async () => {
  const w = await world();
  for (const [who, n] of [[w.A, 3], [w.B, 7]]) {
    assert.equal((await call(w.env, '/api/admin/settings', { method: 'PUT', token: who.token, body: { default_extra_max: n } })).status, 200);
  }
  for (const [who, n] of [[w.A, 3], [w.B, 7], [w.C, 10]]) {
    const res = await call(w.env, '/api/admin/projects', { method: 'POST', token: who.token, body: { title: 'x', folders: [PROOF] } });
    assert.equal((await res.json()).project.extra_max, n, who.tag);
  }
});

// ─── an unsafe photographer id never reaches R2 ────────────────────────────
for (const id of ['../x', 'a/b', 'B', '_t', 'a b', 'a%2fb', 'a.b', 'x'.repeat(65), 'a\\b']) {
  test(`an unsafe photographer id (${JSON.stringify(id.slice(0, 12))}) never names an R2 key: refused, nothing read or written`, async () => {
    const w = await world();
    const odd = await seedPhotographer(w.env, { id, email: `odd${Math.random()}@example.com` });
    const before = snapshot(w.env);
    await assert.rejects(call(w.env, '/shoot/new/n.jpg', { method: 'PUT', token: odd.token, body: 'x' }), /photographer id/);
    await assert.rejects(call(w.env, `/${PA}`, { token: odd.token }), /photographer id/);
    await assert.rejects(call(w.env, `/?list=${encodeURIComponent(PROOF)}`, { token: odd.token }), /photographer id/);
    assert.equal(snapshot(w.env), before);
    // and a guest link of a project carrying it
    const p = await project(w, w.A);
    w.env.DB._db.prepare('UPDATE projects SET photographer_id = ? WHERE id = ?').run(id, p.id);
    await assert.rejects(call(w.env, `/${PA}?t=${t(p.token)}`), /photographer id/);
  });
}

// ─── the source: one choke point ───────────────────────────────────────────
const code = SRC.split('\n').map(l => l.split('//')[0]).join('\n');
function fnBody(name) {
  const start = SRC.indexOf(`function ${name}(`);
  return SRC.slice(start, SRC.indexOf('\n}\n', start));
}
test('source: `env.imagepicker` (the R2 binding) is touched only inside bucketFor', () => {
  const uses = [...code.matchAll(/imagepicker/g)];
  assert.equal(uses.length, 1, `the binding is named ${uses.length} times outside comments`);
  const body = fnBody('bucketFor');
  assert.ok(body.includes('env.imagepicker'), 'bucketFor holds the one use');
  assert.ok(!/\[\s*['"`]imagepicker/.test(SRC), 'no env[\'imagepicker\']');
  // every R2 call in the routes goes through a bucket from bucketFor
  assert.ok((code.match(/bucketFor\(env, /g) || []).length >= 6, 'the routes ask bucketFor');
});

test('source: the reserved namespace is checked on the logical key, inside the helper, before the prefix', () => {
  const body = fnBody('bucketFor');
  assert.match(body, /isTenantKey\(/);
  assert.match(SRC, /function isTenantKey\(key\)/);
  const prefix = fnBody('tenantPrefix');
  assert.match(prefix, /PHOTOGRAPHER_ID_SAFE\.test\(/);
});
