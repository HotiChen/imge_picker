// Deleting one uploaded photo: DELETE /api/admin/photo?key=<logical key>
// (docs/delivery.md "刪除照片", docs/multi-photographer.md §3).
//
// Tim's rules:
// 1. Own files only (requirePhotographer, bucketFor(env, who.id)). Someone
//    else's key is the 404 of a key nobody has: same status, body and SQL
//    statement sequence. The Worker's own namespaces (`_…`: `_t/`, `_thumbs/`,
//    `_books/`, `_assets/`) and anything that is not a photo key are 400.
// 2. The thumbnails go with it (`_thumbs/<w>/<key>.thumb`, every width), the
//    original LAST: a failure leaves at worst orphan thumbnails, never an
//    original whose thumbnails vanished; a retry finishes the job.
// 3. Locked (409, nothing deleted) while any project of THIS photographer
//    whose `folders` or `final_folders` cover the key is delivered
//    (`delivered_at`, never inferred from final_folders) or archived.
// 4. Also locked: under the `folders` (the picking folders) of any of this
//    photographer's projects, and named in an album (the default's books).
// 5. The lock is checked again after the thumbnails and before the original.
//
// A = the default photographer (PHOTOGRAPHER_TOKEN), B and C = two real
// accounts (sessions, switch on). Each holds the shoot under the same logical
// keys with its own bytes, so a delete in the wrong prefix shows as the wrong
// object gone, not as a 404 any refusal would also give.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBucket, fakeDB } from './fakes.mjs';
import {
  OBJECTS, PROOF, FINAL, PA, PB, F1, F2, F3, FRESH,
  setup, admin, guest, pin, SECRET, call, claim, save,
} from './revision-helpers.mjs';
import { seedPhotographer, snapshot, ROUTES_ON } from './tenant-helpers.mjs';

const T = 'shoot/x/';                 // a folder no project names
const X = `${T}a.jpg`;
// neighbours of X that share a prefix with it or its thumbnails
const NEIGHBOURS = {
  [`${T}a.jpg2`]: 'N1', [`${T}a.jpg.thumb`]: 'N2', [`${T}a.jpeg`]: 'N3', [`${T}A.jpg`]: 'N4',
  [`${T}sub/a.jpg`]: 'N5', [`shoot/x2/a.jpg`]: 'N6',
  [`_thumbs/400/${T}a.jpg2.thumb`]: 'N7', [`_thumbs/400/${T}a.jpg.thumb.thumb`]: 'N8',
  [`_thumbs/400/${T}sub/a.jpg.thumb`]: 'N9', [`_thumbs/400x/${T}a.jpg.thumb`]: 'N10',
  [`_thumbs/${T}a.jpg.thumb`]: 'N11',
};
const XS = {
  [X]: 'X-ORIG', [`_thumbs/400/${X}.thumb`]: 'X-T400', [`_thumbs/1200/${X}.thumb`]: 'X-T1200',
  [`_thumbs/1600/${X}.thumb`]: 'X-T1600',
  // a width the app no longer writes (an old upload): found by listing _thumbs/
  [`_thumbs/800/${X}.thumb`]: 'X-T800',
};
const X_ALL = [`_thumbs/400/${X}.thumb`, `_thumbs/800/${X}.thumb`, `_thumbs/1200/${X}.thumb`, `_thumbs/1600/${X}.thumb`, X];

function tenantObjects(id, tag) {
  const out = {};
  for (const [k, v] of Object.entries({ ...OBJECTS, ...XS, ...NEIGHBOURS })) {
    if (k.startsWith('other/') || k.includes('/other/') || k.startsWith('_books/')) continue;
    out[`_t/${id}/${k}`] = `${tag}:${v}`;
  }
  out[`_t/${id}/${PROOF}${tag}-only.jpg`] = `${tag}-ONLY`;
  return out;
}

async function world() {
  const env = setup({ extra: ROUTES_ON });
  const B = { ...(await seedPhotographer(env)), tag: 'B' };
  const C = { ...(await seedPhotographer(env)), tag: 'C' };
  const A = { id: 'default', token: SECRET, tag: 'A' };
  env.imagepicker = fakeBucket({
    ...OBJECTS, ...XS, ...NEIGHBOURS, [`${PROOF}A-only.jpg`]: 'A-ONLY',
    ...tenantObjects(B.id, 'B'), ...tenantObjects(C.id, 'C'),
  });
  return { env, A, B, C };
}
const at = (who, key) => (who.id === 'default' ? key : `_t/${who.id}/${key}`);
const keysOf = env => [...env.imagepicker._store.keys()].sort();
const has = (env, key) => env.imagepicker._store.has(key);
const q = key => encodeURIComponent(key);
const del = (env, key, token, extra = {}) => call(env, `/api/admin/photo?key=${q(key)}`, { method: 'DELETE', token, ...extra });
const delRaw = (env, query, token) => call(env, `/api/admin/photo${query}`, { method: 'DELETE', token });
const body = async res => ({ status: res.status, json: await res.json() });

// a project made by `who` through the real route, and the guest flow on it
async function project(w, who, folders = [PROOF]) {
  const res = await call(w.env, '/api/admin/projects', {
    method: 'POST', token: who.token, body: { title: `${who.tag} 婚紗`, folders, pick_limit: 40, extra_price: 200 },
  });
  assert.equal(res.status, 201, `${who.tag} create: ${await res.clone().text()}`);
  const created = await res.json();
  return { id: created.project.id, token: created.token };
}
async function retouchingAs(w, who, folders) {
  const p = await project(w, who, folders);
  const c = await claim(w.env, p.token);
  p.key = c.key;
  const pickKey = (folders || [PROOF])[0] === PROOF ? PA : `${folders[0]}a.jpg`;
  assert.equal((await save(w.env, p.token, p.key, { upsert: [{ photo_key: pickKey, rating: 1, marks: [pin(0.2, 0.2, '臉')] }] })).status, 200);
  assert.equal((await guest(w.env, 'POST', 'submit', p.token, p.key, { relationship: '本人' })).status, 200);
  assert.equal((await admin(w.env, p.id, 'start-retouch', undefined, who.token)).status, 200);
  return p;
}
async function deliveredAs(w, who, finals = [FINAL], folders) {
  const p = await retouchingAs(w, who, folders);
  const res = await admin(w.env, p.id, 'deliver', { final_folders: finals }, who.token);
  assert.equal(res.status, 200, `${who.tag} deliver: ${await res.clone().text()}`);
  return p;
}
// a project whose finals snapshot names FINAL but that is not delivered any
// more (deliver, then undeliver: final_folders stays, delivered_at clears)
async function undeliveredAs(w, who) {
  const p = await deliveredAs(w, who);
  assert.equal((await admin(w.env, p.id, 'undeliver', undefined, who.token)).status, 200);
  const row = w.env.DB._db.prepare('SELECT delivered_at, final_folders FROM projects WHERE id = ?').get(p.id);
  assert.equal(row.delivered_at, null);
  assert.deepEqual(JSON.parse(row.final_folders), [FINAL], 'the snapshot stays');
  return p;
}

// The request wrote nothing anywhere (D1 and R2) and asked R2 to delete nothing.
async function refusedWithNothingDeleted(w, fn, status, code) {
  const before = snapshot(w.env);
  const asked = w.env.imagepicker._deletes.length;
  const res = await fn();
  const out = await body(res);
  assert.equal(out.status, status, JSON.stringify(out.json));
  if (code) assert.equal(out.json.code, code);
  assert.equal(snapshot(w.env), before, 'nothing changed');
  assert.deepEqual(w.env.imagepicker._deletes.slice(asked), [], 'R2 was asked to delete nothing');
  return out;
}

// ─── rule 1 / 2: the caller's own photo, and its thumbnails, and nothing else
test('A deletes its own photo: the thumbnails of every width, then the original; nothing else goes (neighbours, B\'s and C\'s copies)', async () => {
  const w = await world();
  const before = keysOf(w.env);
  const res = await del(w.env, X, SECRET);
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(await res.json(), { ok: true, key: X, deleted: X_ALL });
  assert.deepEqual(keysOf(w.env), before.filter(k => !X_ALL.includes(k)), 'exactly the photo and its thumbnails');
  // the original was the last thing asked for
  assert.equal(w.env.imagepicker._deletes.at(-1), X);
  for (const n of Object.keys(NEIGHBOURS)) assert.ok(has(w.env, n), n);
  for (const who of [w.B, w.C]) for (const k of X_ALL) assert.ok(has(w.env, at(who, k)), `${who.tag} ${k}`);
});

test('B and C each delete their own copy under the same logical key: only their prefix changes; the default\'s and the other\'s stay', async () => {
  const w = await world();
  for (const who of [w.B, w.C]) {
    const before = keysOf(w.env);
    const res = await del(w.env, X, who.token);
    assert.equal(res.status, 200, `${who.tag}: ${await res.clone().text()}`);
    assert.deepEqual(await res.json(), { ok: true, key: X, deleted: X_ALL }, 'logical keys, never the prefix');
    const gone = X_ALL.map(k => at(who, k));
    assert.deepEqual(keysOf(w.env), before.filter(k => !gone.includes(k)), who.tag);
  }
  for (const k of X_ALL) assert.ok(has(w.env, k), `A's ${k}`);
});

test('a photo without thumbnails (an old upload) deletes just the original; a missing thumbnail is not an error', async () => {
  const w = await world();
  const res = await del(w.env, F2, SECRET);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, key: F2, deleted: [F2] });
  assert.ok(!has(w.env, F2));
});

// ─── rule 1: someone else's key is the 404 of a key nobody has ─────────────
for (const [mine, theirs, key] of [['B', 'A', `${PROOF}A-only.jpg`], ['A', 'B', `${PROOF}B-only.jpg`], ['B', 'C', `${PROOF}C-only.jpg`], ['C', 'B', `${PROOF}B-only.jpg`]]) {
  test(`${mine} cannot delete ${theirs}'s photo: the same 404, body and SQL statements as a key nobody has, and nothing deleted`, async () => {
    const w = await world();
    const who = w[mine];
    assert.ok(has(w.env, at(w[theirs], key)), 'the victim exists');
    const sql0 = w.env.DB._sql.length;
    const other = await refusedWithNothingDeleted(w, () => del(w.env, key, who.token), 404);
    const sqlOther = w.env.DB._sql.slice(sql0);
    const sql1 = w.env.DB._sql.length;
    const none = await refusedWithNothingDeleted(w, () => del(w.env, `${PROOF}nobody.jpg`, who.token), 404);
    assert.deepEqual(other, none);
    assert.deepEqual(other.json, { error: 'Not found' });
    assert.deepEqual(sqlOther, w.env.DB._sql.slice(sql1), 'the same statements');
    assert.ok(has(w.env, at(w[theirs], key)));
  });
}

// ─── rule 3: delivered / archived ──────────────────────────────────────────
test('locked: a photo under the finals of a delivered project is 409 photo_locked_delivered; so is one under its picking folders', async () => {
  const w = await world();
  await deliveredAs(w, w.A);
  await refusedWithNothingDeleted(w, () => del(w.env, F1, SECRET), 409, 'photo_locked_delivered');
  await refusedWithNothingDeleted(w, () => del(w.env, PB, SECRET), 409, 'photo_locked_delivered');
  // a folder the project does not name is free
  assert.equal((await del(w.env, X, SECRET)).status, 200);
});

test('locked: a confirmed delivery (確認完成) stays photo_locked_delivered', async () => {
  const w = await world();
  const p = await deliveredAs(w, w.A);
  assert.equal((await admin(w.env, p.id, 'confirm')).status, 200);
  assert.ok(w.env.DB._db.prepare('SELECT client_confirmed_at FROM projects WHERE id = ?').get(p.id).client_confirmed_at);
  await refusedWithNothingDeleted(w, () => del(w.env, F1, SECRET), 409, 'photo_locked_delivered');
});

test('delivered is delivered_at, never final_folders: after 取消交件 (undeliver) the finals are deletable again; the picking folders stay locked', async () => {
  const w = await world();
  await undeliveredAs(w, w.A);
  await refusedWithNothingDeleted(w, () => del(w.env, PB, SECRET), 409, 'photo_in_pick_folder');
  const res = await del(w.env, F3, SECRET);
  assert.equal(res.status, 200, await res.clone().text());
  assert.ok(!has(w.env, F3));
});

test('after 開放修改 (reopen) the finals are deletable again', async () => {
  const w = await world();
  const p = await deliveredAs(w, w.A);
  await refusedWithNothingDeleted(w, () => del(w.env, F1, SECRET), 409, 'photo_locked_delivered');
  assert.equal((await admin(w.env, p.id, 'reopen')).status, 200);
  assert.equal((await del(w.env, F1, SECRET)).status, 200);
});

test('locked: an archived project locks its picking folders and its finals snapshot (photo_locked_archived); unarchive lifts the finals lock', async () => {
  const w = await world();
  const p = await undeliveredAs(w, w.A);
  assert.equal((await admin(w.env, p.id, 'archive')).status, 200);
  await refusedWithNothingDeleted(w, () => del(w.env, F1, SECRET), 409, 'photo_locked_archived');
  await refusedWithNothingDeleted(w, () => del(w.env, PB, SECRET), 409, 'photo_locked_archived');
  assert.equal((await admin(w.env, p.id, 'unarchive')).status, 200);
  await refusedWithNothingDeleted(w, () => del(w.env, PB, SECRET), 409, 'photo_in_pick_folder');
  assert.equal((await del(w.env, F1, SECRET)).status, 200);
});

test('locked: delivered wins over archived, archived over the picking folder (one project delivered, another archived, a third picking)', async () => {
  const w = await world();
  const picking = await project(w, w.A, [FINAL]);
  const archived = await project(w, w.A, [FINAL]);
  assert.equal((await admin(w.env, archived.id, 'archive')).status, 200);
  await refusedWithNothingDeleted(w, () => del(w.env, F1, SECRET), 409, 'photo_locked_archived');
  await deliveredAs(w, w.A, [FINAL]);
  await refusedWithNothingDeleted(w, () => del(w.env, F1, SECRET), 409, 'photo_locked_delivered');
  assert.ok(picking.id);
});

// ─── rule 4: the picking folders, the albums ───────────────────────────────
test('locked: a photo under the picking folders of a project not yet delivered is 409 photo_in_pick_folder (a client may have picked it)', async () => {
  const w = await world();
  await project(w, w.A);
  await refusedWithNothingDeleted(w, () => del(w.env, PA, SECRET), 409, 'photo_in_pick_folder');
  // and in a sub-folder of it
  w.env.imagepicker._store.set(`${PROOF}sub/z.jpg`, { key: 'x', body: 'Z', contentType: 'image/jpeg', uploaded: new Date() });
  await refusedWithNothingDeleted(w, () => del(w.env, `${PROOF}sub/z.jpg`, SECRET), 409, 'photo_in_pick_folder');
});

test('the folder match is on a `/` boundary: a project on shoot/x2/ does not lock shoot/x/a.jpg', async () => {
  const w = await world();
  await project(w, w.A, ['shoot/x2/', 'shoot/x/a']);
  assert.equal((await del(w.env, X, SECRET)).status, 200);
});

function book(env, id, data) {
  env.imagepicker._store.set(`_books/${id}.json`, { key: 'x', body: typeof data === 'string' ? data : JSON.stringify(data), contentType: 'application/json', uploaded: new Date() });
}
test('locked: a photo named in an album (slot, background, the editor\'s layout cache, anywhere in the book) is 409 photo_in_album', async () => {
  for (const pages of [
    [{ slots: [{ photoId: F1, crop: { x: 0, y: 0, scale: 1 } }] }],
    [{ slots: [], bgImage: { photoId: F1, fit: 'cover', opacity: 1 } }],
    [{ slots: [{ photoId: null }], _photoCache: { 0: { photoId: F1 } } }],
  ]) {
    const w = await world();
    book(w.env, 'b9', { name: '相本', clientFolders: [], pages });
    book(w.env, 'b9_status', { approved: false });
    await refusedWithNothingDeleted(w, () => del(w.env, F1, SECRET), 409, 'photo_in_album');
    // another photo of the same folder is free
    assert.equal((await del(w.env, F3, SECRET)).status, 200);
  }
});

test('an album file that does not parse still locks a photo whose key it contains; one that names other photos does not', async () => {
  const w = await world();
  book(w.env, 'broken', `{"pages":[{"slots":[{"photoId":"${F1}"}]}`);
  book(w.env, 'other', { pages: [{ slots: [{ photoId: F3 }] }] });
  await refusedWithNothingDeleted(w, () => del(w.env, F1, SECRET), 409, 'photo_in_album');
  assert.equal((await del(w.env, PB, SECRET)).status, 200);
});

test('albums are listed past the first R2 page', async () => {
  const w = await world();
  const objects = Object.fromEntries([...w.env.imagepicker._store].map(([k, v]) => [k, { body: v.body, contentType: v.contentType }]));
  w.env.imagepicker = fakeBucket(objects, { pageSize: 2 });
  for (let i = 0; i < 5; i++) book(w.env, `a${i}`, { pages: [] });
  book(w.env, 'z-last', { pages: [{ slots: [{ photoId: F1 }] }] });
  await refusedWithNothingDeleted(w, () => del(w.env, F1, SECRET), 409, 'photo_in_album');
});

test('albums are the default photographer\'s (books have no other owner yet): B\'s photo under the same key is not locked by them', async () => {
  const w = await world();
  book(w.env, 'b9', { pages: [{ slots: [{ photoId: F1 }] }] });
  const res = await del(w.env, F1, w.B.token);
  assert.equal(res.status, 200);
  assert.ok(!has(w.env, at(w.B, F1)));
  assert.ok(has(w.env, F1), 'the default\'s untouched');
});

// ─── other photographers' projects neither lock nor unlock ─────────────────
test('another photographer\'s projects on the same folders neither lock nor unlock this photographer\'s photo', async () => {
  const w = await world();
  // B: delivered on FINAL, picking on PROOF, archived on a folder of X
  await deliveredAs(w, w.B);
  const archived = await project(w, w.B, [T]);
  assert.equal((await admin(w.env, archived.id, 'archive', undefined, w.B.token)).status, 200);
  assert.equal((await del(w.env, F1, SECRET)).status, 200, 'A: B\'s delivery locks nothing of A\'s');
  assert.equal((await del(w.env, PA, SECRET)).status, 200, 'A: B\'s picking folders lock nothing of A\'s');
  assert.equal((await del(w.env, X, SECRET)).status, 200, 'A: B\'s archive locks nothing of A\'s');
  // and A's own delivery is not lifted by B's projects
  await deliveredAs(w, w.A, [FINAL], [`${T}`]);
  await refusedWithNothingDeleted(w, () => del(w.env, F3, SECRET), 409, 'photo_locked_delivered');
  // C has none of it: C deletes its own F1 freely
  assert.equal((await del(w.env, F1, w.C.token)).status, 200);
  // B's own are locked by B's own projects
  await refusedWithNothingDeleted(w, () => del(w.env, F3, w.B.token), 409, 'photo_locked_delivered');
  await refusedWithNothingDeleted(w, () => del(w.env, PB, w.B.token), 409, 'photo_locked_delivered');
  await refusedWithNothingDeleted(w, () => del(w.env, `${T}a.jpeg`, w.B.token), 409, 'photo_locked_archived');
});

// ─── the key ───────────────────────────────────────────────────────────────
test('a key that is no photo of anyone\'s is 400 invalid_key for every photographer, however it is spelled, and nothing is deleted', async () => {
  const w = await world();
  const long = `${T}${'あ'.repeat(340)}.jpg`;      // 1020 + 4 + 8 = over 1024 bytes
  assert.ok(new TextEncoder().encode(long).length > 1024);
  const keys = [
    '', '/', '//', 'shoot/', `${PROOF}`,
    `_thumbs/400/${PA}.thumb`, `_thumbs/1200/${X}.thumb`, '_thumbs/', `_t/${w.B.id}/${PA}`, '_t', '_t/x.jpg',
    '_books/b1.json', '_assets/logo.png', '_x.jpg',
    `shoot/../${PA}`, '../x.jpg', 'shoot/./a.jpg', `${T}..`, '..',
    `${T}a\n.jpg`, `${T}a .jpg`, `${T}a\u0000.jpg`,
    long,
    `${T}a.txt`, `${T}a.html`, `${PA} `, `${PA}?x=1`, `${PA}%2F`, `${T}a.svg`, `${T}a.json`, `${T}a`, `${T}a.jpg.thumb`, `${T}.jpg`,
  ];
  for (const who of [w.A, w.B]) {
    for (const key of keys) {
      const out = await refusedWithNothingDeleted(w, () => del(w.env, key, who.token), 400, 'invalid_key');
      assert.ok(out.json.error, `${who.tag} ${JSON.stringify(key)}`);
    }
    // the query decodes once: %5F is `_`, %2e%2e is `..`, %2F is `/`
    for (const query of ['', '?key', '?key=', '?other=x.jpg', `?key=%5Fthumbs%2F400%2F${q(PA)}.thumb`, '?key=%2e%2e%2Fx.jpg',
      `?key=shoot%2F%2E%2E%2F_t%2F${w.B.id}%2Fx.jpg`, '?key=%5Ft%2Fx.jpg', '?key=%255Fx.jpg%2F']) {
      await refusedWithNothingDeleted(w, () => delRaw(w.env, query, who.token), 400, 'invalid_key');
    }
  }
});

test('a key the R2 bucket could literally hold (backslash, double slash, leading slash, 1024 bytes) is looked up as it is: 404 here, never normalised onto another photo', async () => {
  const w = await world();
  const exact = `${T}${'a'.repeat(1024 - T.length - 4)}.jpg`;
  assert.equal(new TextEncoder().encode(exact).length, 1024);
  for (const key of [PA.replace(/\//g, '\\'), PA.replace('/', '//'), `/${PA}`, `${PROOF}/a.jpg`, exact]) {
    await refusedWithNothingDeleted(w, () => del(w.env, key, SECRET), 404);
  }
  // and such a key that does exist is deleted, it and nothing else
  const odd = 'shoot\\odd//a b.jpg';
  w.env.imagepicker._store.set(odd, { key: odd, body: 'ODD', contentType: 'image/jpeg', uploaded: new Date() });
  const res = await del(w.env, odd, SECRET);
  assert.deepEqual(await res.json(), { ok: true, key: odd, deleted: [odd] });
  assert.ok(has(w.env, PA));
});

test('the key comes from ?key= only: a key in the path is a 404 route, nothing deleted', async () => {
  const w = await world();
  for (const path of [`/api/admin/photo/${q(X)}`, `/api/admin/photo/${X}`, `/api/admin/photo/lock/${X}`]) {
    await refusedWithNothingDeleted(w, () => call(w.env, path, { method: 'DELETE', token: SECRET }), 404);
  }
});

// ─── method, identity ──────────────────────────────────────────────────────
test('only DELETE deletes: GET / POST / PUT / PATCH on /api/admin/photo are 405 and write nothing', async () => {
  const w = await world();
  for (const method of ['GET', 'POST', 'PUT', 'PATCH']) {
    await refusedWithNothingDeleted(w, () => call(w.env, `/api/admin/photo?key=${q(X)}`, { method, token: SECRET, body: method === 'GET' ? undefined : 'x' }), 405);
  }
});

test('nobody else deletes: anonymous, an unknown token, a pick link, a studio token, B with the switch off, a flagged or suspended session — all refused, nothing deleted', async () => {
  const w = await world();
  const p = await project(w, w.A, [T]);
  const studio = (await (await call(w.env, '/api/auth/studio-token', { method: 'POST', token: SECRET })).json()).token;
  const tk = encodeURIComponent;
  await refusedWithNothingDeleted(w, () => del(w.env, X), 401);
  await refusedWithNothingDeleted(w, () => del(w.env, X, 'e'.repeat(64)), 401);
  await refusedWithNothingDeleted(w, () => call(w.env, `/api/admin/photo?key=${q(X)}&t=${tk(p.token)}`, { method: 'DELETE' }), 401);
  await refusedWithNothingDeleted(w, () => call(w.env, `/api/admin/photo?key=${q(X)}`, { method: 'DELETE', headers: { 'X-Share-Token': p.token } }), 401);
  await refusedWithNothingDeleted(w, () => call(w.env, `/api/admin/photo?key=${q(X)}&t=${tk(studio)}`, { method: 'DELETE' }), 401);
  await refusedWithNothingDeleted(w, () => del(w.env, X, studio), 401);
  for (const off of [undefined, 'off', 'ON', ' on']) {
    w.env.PHOTOGRAPHER_ROUTES = off;
    await refusedWithNothingDeleted(w, () => del(w.env, X, w.B.token), 401);
  }
  w.env.PHOTOGRAPHER_ROUTES = 'on';
  const flagged = await seedPhotographer(w.env, { mustChange: true });
  await refusedWithNothingDeleted(w, () => del(w.env, X, flagged.token), 403, 'must_change_password');
  const suspended = await seedPhotographer(w.env, { status: 'suspended' });
  await refusedWithNothingDeleted(w, () => del(w.env, X, suspended.token), 401);
  // and the positive control: the same photo, the default's token
  assert.equal((await del(w.env, X, SECRET)).status, 409, 'A: locked by its own picking project on shoot/x/');
});

// ─── rule 2: partial failure, and a retry that finishes ───────────────────
function failingOnce(env, key) {
  const real = env.imagepicker.delete.bind(env.imagepicker);
  let failed = false;
  env.imagepicker.delete = async k => {
    env.imagepicker._deletes.push(k);
    if (!failed && k === key) { failed = true; throw new Error('R2 down'); }
    env.imagepicker._deletes.pop();
    return real(k);
  };
}
test('a thumbnail that fails to delete: 500 photo_delete_failed naming it, the original kept; the retry removes the rest', async () => {
  const w = await world();
  const bad = at(w.B, `_thumbs/1200/${X}.thumb`);
  failingOnce(w.env, bad);
  const first = await body(await del(w.env, X, w.B.token));
  assert.equal(first.status, 500);
  assert.equal(first.json.code, 'photo_delete_failed');
  assert.deepEqual(first.json.failed, [`_thumbs/1200/${X}.thumb`]);
  assert.deepEqual(first.json.deleted, [`_thumbs/400/${X}.thumb`, `_thumbs/800/${X}.thumb`, `_thumbs/1600/${X}.thumb`]);
  assert.ok(first.json.error);
  assert.ok(has(w.env, at(w.B, X)), 'the original stays');
  assert.ok(has(w.env, bad));
  assert.ok(!w.env.imagepicker._deletes.includes(at(w.B, X)), 'never asked to delete the original');
  const again = await body(await del(w.env, X, w.B.token));
  assert.deepEqual(again, { status: 200, json: { ok: true, key: X, deleted: [`_thumbs/1200/${X}.thumb`, X] } });
  for (const k of X_ALL) assert.ok(!has(w.env, at(w.B, k)), k);
  for (const k of X_ALL) assert.ok(has(w.env, k), `A's ${k}`);
});

test('the original that fails to delete: 500 photo_delete_failed naming it, the thumbnails gone; the retry deletes the original', async () => {
  const w = await world();
  failingOnce(w.env, X);
  const first = await body(await del(w.env, X, SECRET));
  assert.equal(first.status, 500);
  assert.equal(first.json.code, 'photo_delete_failed');
  assert.deepEqual(first.json.failed, [X]);
  assert.deepEqual(first.json.deleted, X_ALL.slice(0, -1));
  assert.ok(has(w.env, X));
  const again = await body(await del(w.env, X, SECRET));
  assert.deepEqual(again, { status: 200, json: { ok: true, key: X, deleted: [X] } });
  assert.ok(!has(w.env, X));
  // a third time: gone, so 404 (nothing more to do)
  assert.equal((await del(w.env, X, SECRET)).status, 404);
});

// ─── rule 5: the lock is checked again before the original ────────────────
test('race: a delivery that lands after the thumbnails are gone keeps the original (409 photo_locked_delivered, the thumbnails reported)', async () => {
  const w = await world();
  const real = w.env.imagepicker.delete.bind(w.env.imagepicker);
  let landed = false;
  w.env.imagepicker.delete = async k => {
    if (!landed) {
      landed = true;
      const now = new Date().toISOString();
      w.env.DB._db.prepare("INSERT INTO projects (id, title, folders, created_at, photographer_id, phase, delivered_at, final_folders) VALUES ('late', '', ?, ?, ?, 'retouching', ?, ?)")
        .run(JSON.stringify(['elsewhere/']), now, w.B.id, now, JSON.stringify([T]));
    }
    return real(k);
  };
  const out = await body(await del(w.env, X, w.B.token));
  assert.equal(out.status, 409);
  assert.equal(out.json.code, 'photo_locked_delivered');
  assert.deepEqual(out.json.deleted, X_ALL.slice(0, -1));
  assert.ok(has(w.env, at(w.B, X)), 'the original stays');
  assert.ok(!w.env.imagepicker._deletes.includes(at(w.B, X)));
});

test('race: an album that names the photo after the thumbnails are gone keeps the original (409 photo_in_album)', async () => {
  const w = await world();
  const real = w.env.imagepicker.delete.bind(w.env.imagepicker);
  w.env.imagepicker.delete = async k => {
    book(w.env, 'late', { pages: [{ slots: [{ photoId: X }] }] });
    return real(k);
  };
  const out = await body(await del(w.env, X, SECRET));
  assert.equal(out.status, 409);
  assert.equal(out.json.code, 'photo_in_album');
  assert.ok(has(w.env, X));
});

// ─── before a migration: refuse rather than guess ─────────────────────────
test('a database without the delivery columns cannot say whether a photo is locked: 500 photo_lock_unavailable, nothing deleted', async () => {
  const schema = FRESH.replace(/\n\s*delivered_at\s+TEXT,/, '\n');
  assert.notEqual(schema, FRESH);
  const w = await world();
  w.env.DB = fakeDB({ schema });
  await refusedWithNothingDeleted(w, () => del(w.env, X, SECRET), 500, 'photo_lock_unavailable');
});

test('the 200 answer is private (no-store) JSON', async () => {
  const w = await world();
  const res = await del(w.env, X, SECRET);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /application\/json/);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
});

// PB is in OBJECTS without 1200/1600 thumbnails: deleting it asks R2 only for what is there
test('only thumbnails that exist are reported as deleted', async () => {
  const w = await world();
  const res = await del(w.env, PB, w.C.token);
  assert.deepEqual(await res.json(), { ok: true, key: PB, deleted: [`_thumbs/400/${PB}.thumb`, PB] });
});

// ─── the stored folders, read defensively ─────────────────────────────────
function rawProject(env, id, ownerId, folders, extra = {}) {
  const now = new Date().toISOString();
  const cols = { id, title: '', folders, created_at: now, photographer_id: ownerId, ...extra };
  env.DB._db.prepare(`INSERT INTO projects (${Object.keys(cols).join(', ')}) VALUES (${Object.keys(cols).map(() => '?').join(', ')})`).run(...Object.values(cols));
}
test('a folder stored without its trailing slash (a hand edit) still matches on a `/` boundary: shoot/x locks shoot/x/a.jpg, not shoot/x2/a.jpg', async () => {
  const w = await world();
  rawProject(w.env, 'raw', 'default', JSON.stringify(['shoot/x']));
  await refusedWithNothingDeleted(w, () => del(w.env, X, SECRET), 409, 'photo_in_pick_folder');
  assert.equal((await del(w.env, 'shoot/x2/a.jpg', SECRET)).status, 200);
});

test('a folders column that does not parse, or is not a list of folders, locks every photo of that photographer (fail closed); not another\'s', async () => {
  for (const [col, value] of [['folders', 'not json'], ['folders', '{"a":1}'], ['folders', '[1]'], ['final_folders', 'nope']]) {
    const w = await world();
    rawProject(w.env, 'bad', w.B.id, col === 'folders' ? value : '[]', col === 'final_folders' ? { final_folders: value, delivered_at: new Date().toISOString() } : {});
    await refusedWithNothingDeleted(w, () => del(w.env, X, w.B.token), 409, col === 'folders' ? 'photo_in_pick_folder' : 'photo_locked_delivered');
    assert.equal((await del(w.env, X, w.C.token)).status, 200, `${col} ${value}: C is not B`);
  }
});

test('an album that names the photo URL-encoded (an image URL kept in the book) locks it too', async () => {
  const w = await world();
  book(w.env, 'b9', { pages: [{ slots: [], bgImage: { url: `https://worker.example/${encodeURIComponent(F1)}?w=1200` } }] });
  await refusedWithNothingDeleted(w, () => del(w.env, F1, SECRET), 409, 'photo_in_album');
});
