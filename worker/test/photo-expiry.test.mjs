// 照片保存期限 (docs/delivery.md, "Photo expiry"): the R2 bucket's lifecycle
// rule deletes every object R2_LIFETIME_DAYS (180) days after upload, and two
// read-only routes say when a project's photos start to go:
// - GET /api/admin/projects/:id/expiry — the photographer's own project:
//   {proofs, finals} with {expires_at, earliest_uploaded, count, truncated}
//   each (finals null while final_folders is);
// - GET /api/pick/expiry — any live pick link: {expires_at, days_left} of the
//   finals pickFinals opens (delivered_at set), {expires_at: null,
//   days_left: null} otherwise. Never a proof, a key, a name or a count.
// High tier: the guest route is a new read path, so it is held to pickFinals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeBucket } from './fakes.mjs';
import {
  setup, admin, deliver, delivered, retouching, OBJECTS,
  PROOF, FINAL, FINAL2, PA, PB, F1, F2, F3, G1, SECRET, call, pick, one,
} from './revision-helpers.mjs';
import { twoTenants, ROUTES_ON } from './tenant-helpers.mjs';

const SRC = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const DAY = 86400000;
const NOPE = '00000000-0000-4000-8000-000000000000';
const plus180 = iso => new Date(Date.parse(iso) + 180 * DAY).toISOString();
const iso = ms => new Date(ms).toISOString();

// stamps an object's upload time the way R2 holds it (a Date)
function uploadedAt(env, key, when) {
  const rec = env.imagepicker._store.get(key);
  assert.ok(rec, `no object ${key}`);
  rec.uploaded = new Date(when);
}
// counts the R2 list calls, by prefix
function countLists(env) {
  const calls = [];
  const list = env.imagepicker.list.bind(env.imagepicker);
  env.imagepicker.list = opts => { calls.push(opts?.prefix ?? ''); return list(opts); };
  return calls;
}

const adminExpiry = (env, id, token = SECRET) => call(env, `/api/admin/projects/${id}/expiry`, { token });
const guestExpiry = (env, t, extra = '') => pick(env, 'GET', `expiry${extra}`, t);

// proof dates: PB is the oldest proof; finals: F2 the oldest final
function stampAll(env) {
  uploadedAt(env, PA, '2026-03-01T00:00:00Z');
  uploadedAt(env, PB, '2026-02-10T08:00:00Z');
  uploadedAt(env, F1, '2026-04-01T00:00:00Z');
  uploadedAt(env, F2, '2026-03-15T12:30:00Z');
  uploadedAt(env, F3, '2026-04-02T00:00:00Z');
  uploadedAt(env, G1, '2025-12-01T00:00:00Z'); // another finals folder, not delivered
  uploadedAt(env, 'other/x.jpg', '2025-06-01T00:00:00Z');
  // the thumbnails are older than anything, and never count
  for (const k of Object.keys(OBJECTS)) if (k.startsWith('_')) uploadedAt(env, k, '2025-01-01T00:00:00Z');
}

// ─── the photographer's route ─────────────────────────────────────────────

test('admin expiry: proofs and finals each answer the earliest upload + 180 days, with the count scanned', async () => {
  const env = setup();
  const p = await delivered(env);
  stampAll(env);
  const res = await adminExpiry(env, p.id);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(res.headers.get('Vary'), 'Authorization');
  assert.deepEqual(await res.json(), {
    proofs: { expires_at: plus180('2026-02-10T08:00:00Z'), earliest_uploaded: '2026-02-10T08:00:00.000Z', count: 2, truncated: false },
    finals: { expires_at: plus180('2026-03-15T12:30:00Z'), earliest_uploaded: '2026-03-15T12:30:00.000Z', count: 3, truncated: false },
  });
  assert.equal(plus180('2026-02-10T08:00:00Z'), '2026-08-09T08:00:00.000Z');
});

test('admin expiry: finals is null until the project has final_folders; after 取消交件 the kept final_folders still answer', async () => {
  const env = setup();
  const p = await retouching(env);
  stampAll(env);
  const before = await (await adminExpiry(env, p.id)).json();
  assert.equal(before.finals, null);
  assert.equal(before.proofs.count, 2);
  assert.equal((await deliver(env, p.id)).status, 200);
  assert.equal((await admin(env, p.id, 'undeliver')).status, 200);
  assert.equal(one(env, 'SELECT delivered_at FROM projects').delivered_at, null);
  const after = await (await adminExpiry(env, p.id)).json();
  assert.equal(after.finals.expires_at, plus180('2026-03-15T12:30:00Z'));
});

test('admin expiry: subfolders count; `_` folders (_thumbs/ and the like), .thumb files and non-photos never do', async () => {
  const env = setup();
  const p = await retouching(env);
  stampAll(env);
  const put = (k, when) => env.imagepicker._store.set(k, { key: k, body: 'X', contentType: 'image/jpeg', uploaded: new Date(when) });
  put(`${PROOF}sub/deep.jpg`, '2026-01-20T00:00:00Z');                 // counts: the oldest real photo
  put(`${PROOF}_thumbs/400/old.jpg`, '2025-02-01T00:00:00Z');          // a `_` folder inside the proofs
  put(`${PROOF}sub/_hidden/old.jpg`, '2025-02-01T00:00:00Z');
  put(`${PROOF}a.jpg.thumb`, '2025-02-01T00:00:00Z');                  // a thumbnail-shaped name
  put(`${PROOF}notes.txt`, '2025-02-01T00:00:00Z');                     // not a photo
  put(`${PROOF}book.json`, '2025-02-01T00:00:00Z');
  put(`_thumbs/1200/${PROOF}sub/deep.jpg.thumb`, '2025-02-01T00:00:00Z'); // the real thumbnail namespace
  const { proofs } = await (await adminExpiry(env, p.id)).json();
  assert.deepEqual(proofs, {
    expires_at: plus180('2026-01-20T00:00:00Z'), earliest_uploaded: '2026-01-20T00:00:00.000Z', count: 3, truncated: false,
  });
});

test('admin expiry: every photo extension upload takes counts (a HEIC original too)', async () => {
  const env = setup();
  const p = await retouching(env);
  stampAll(env);
  env.imagepicker._store.set(`${PROOF}raw.HEIC`, { key: 'x', body: 'H', contentType: 'image/heic', uploaded: new Date('2026-01-05T00:00:00Z') });
  const { proofs } = await (await adminExpiry(env, p.id)).json();
  assert.equal(proofs.earliest_uploaded, '2026-01-05T00:00:00.000Z');
  assert.equal(proofs.count, 3);
});

test('admin expiry: an empty folder answers nulls, count 0, not truncated', async () => {
  const env = setup();
  const res = await call(env, '/api/admin/projects', {
    method: 'POST', token: SECRET, body: { title: '空', folders: ['empty/'], pick_limit: 40, extra_price: 200 },
  });
  const { project } = await res.json();
  const calls = countLists(env);
  const out = await (await adminExpiry(env, project.id)).json();
  assert.deepEqual(out, { proofs: { expires_at: null, earliest_uploaded: null, count: 0, truncated: false }, finals: null });
  assert.deepEqual(calls, ['empty/'], 'one list call, on the logical folder');
});

// pageSize 2: five list calls see ten objects
async function paged(n, oldestLast = true) {
  const env = setup();
  env.imagepicker = fakeBucket(OBJECTS, { pageSize: 2 });
  const res = await call(env, '/api/admin/projects', {
    method: 'POST', token: SECRET, body: { title: '大', folders: ['big/'], pick_limit: 40, extra_price: 200 },
  });
  const { project } = await res.json();
  for (let i = 0; i < n; i++) {
    const k = `big/${String(i).padStart(3, '0')}.jpg`;
    // every photo a day apart, newest first, so the last key is the oldest
    const when = Date.parse('2026-05-01T00:00:00Z') - (oldestLast ? i : -i) * DAY;
    env.imagepicker._store.set(k, { key: k, body: 'X', contentType: 'image/jpeg', uploaded: new Date(when) });
  }
  return { env, id: project.id };
}

test('admin expiry: at most five list calls per folder — past that truncated, with the earliest of what was scanned', async () => {
  const { env, id } = await paged(13);
  const calls = countLists(env);
  const { proofs } = await (await adminExpiry(env, id)).json();
  assert.equal(calls.length, 5);
  // ten scanned (000..009); the earliest of those is 009, nine days back
  const earliest = iso(Date.parse('2026-05-01T00:00:00Z') - 9 * DAY);
  assert.deepEqual(proofs, { expires_at: plus180(earliest), earliest_uploaded: earliest, count: 10, truncated: true });
});

test('admin expiry: exactly five pages is complete, not truncated', async () => {
  const { env, id } = await paged(10);
  const calls = countLists(env);
  const { proofs } = await (await adminExpiry(env, id)).json();
  assert.equal(calls.length, 5);
  assert.equal(proofs.count, 10);
  assert.equal(proofs.truncated, false);
});

test('admin expiry: follows the cursor across pages (the oldest on a later page wins)', async () => {
  const { env, id } = await paged(7);
  const { proofs } = await (await adminExpiry(env, id)).json();
  assert.equal(proofs.count, 7);
  assert.equal(proofs.earliest_uploaded, iso(Date.parse('2026-05-01T00:00:00Z') - 6 * DAY));
  assert.equal(proofs.truncated, false);
});

test('admin expiry: the five-call cap is per folder (two folders, ten calls)', async () => {
  const { env } = await paged(0);
  for (const f of ['big/', 'big2/']) {
    for (let i = 0; i < 12; i++) env.imagepicker._store.set(`${f}${String(i).padStart(3, '0')}.jpg`, { key: 'x', body: 'X', contentType: 'image/jpeg', uploaded: new Date('2026-05-01T00:00:00Z') });
  }
  const res = await call(env, '/api/admin/projects', {
    method: 'POST', token: SECRET, body: { title: '兩', folders: ['big/', 'big2/'], pick_limit: 40, extra_price: 200 },
  });
  const { project } = await res.json();
  const calls = countLists(env);
  const { proofs } = await (await adminExpiry(env, project.id)).json();
  assert.deepEqual(calls, ['big/', 'big/', 'big/', 'big/', 'big/', 'big2/', 'big2/', 'big2/', 'big2/', 'big2/']);
  assert.equal(proofs.count, 20);
  assert.equal(proofs.truncated, true);
});

test('admin expiry: no token or a link token is 401; an unknown id 404; another method 405', async () => {
  const env = setup();
  const p = await delivered(env);
  assert.equal((await call(env, `/api/admin/projects/${p.id}/expiry`)).status, 401);
  assert.equal((await adminExpiry(env, p.id, p.token)).status, 401);
  assert.equal((await call(env, `/api/admin/projects/${p.id}/expiry`, { headers: { 'X-Share-Token': p.token } })).status, 401);
  assert.equal((await adminExpiry(env, NOPE)).status, 404);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await call(env, `/api/admin/projects/${p.id}/expiry`, { method, token: SECRET });
    assert.equal(res.status, 405, method);
  }
});

test('admin expiry: another photographer\'s project is a nonexistent one; its own reads its own prefix', async () => {
  const env = setup({ extra: ROUTES_ON });
  const { B } = await twoTenants(env);
  const a = await delivered(env);
  stampAll(env);
  // a second project, handed to B, with B's own copies of the same logical keys (newer)
  const b = await delivered(env);
  env.DB._db.prepare('UPDATE projects SET photographer_id = ? WHERE id = ?').run(B.id, b.id);
  for (const k of [PA, PB, F1, F2, F3]) {
    env.imagepicker._store.set(`_t/${B.id}/${k}`, { key: 'x', body: 'B', contentType: 'image/jpeg', uploaded: new Date('2026-09-01T00:00:00Z') });
  }
  env.imagepicker._store.set(`_t/${B.id}/${F2}`, { key: 'x', body: 'B', contentType: 'image/jpeg', uploaded: new Date('2026-08-20T00:00:00Z') });

  for (const [token, victim] of [[B.token, a.id], [SECRET, b.id]]) {
    const res = await adminExpiry(env, victim, token);
    const none = await adminExpiry(env, NOPE, token);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), await none.text());
  }
  const mine = await (await adminExpiry(env, b.id, B.token)).json();
  assert.equal(mine.proofs.earliest_uploaded, '2026-09-01T00:00:00.000Z');
  assert.equal(mine.proofs.count, 2);
  assert.equal(mine.finals.earliest_uploaded, '2026-08-20T00:00:00.000Z');
  // and the default's own still reads the unprefixed objects
  const theirs = await (await adminExpiry(env, a.id)).json();
  assert.equal(theirs.finals.earliest_uploaded, '2026-03-15T12:30:00.000Z');
});

// ─── the guest's route ────────────────────────────────────────────────────

test('guest expiry: delivered — the finals\' earliest upload + 180 days and the whole days left, nothing else', async () => {
  const env = setup();
  const p = await delivered(env);
  stampAll(env);
  const oldest = Date.now() - 30 * DAY;
  uploadedAt(env, F1, Date.now() - 10 * DAY);
  uploadedAt(env, F2, oldest);
  uploadedAt(env, F3, Date.now() - 20 * DAY);
  for (const key of [p.key, undefined]) { // the seat owner and a viewer alike
    const res = await pick(env, 'GET', 'expiry', p.token, { key });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { expires_at: iso(oldest + 180 * DAY), days_left: 150 });
    for (const leak of ['shoot', '精修', 'f1', 'f2', '.jpg', 'count', 'truncated', 'earliest']) assert.ok(!text.includes(leak), `leaked ${leak}`);
  }
});

test('guest expiry: days_left counts whole days up, and is 0 (not negative) once the date has passed', async () => {
  const env = setup();
  const p = await delivered(env);
  stampAll(env);
  for (const k of [F1, F2, F3]) uploadedAt(env, k, Date.now() - 179.5 * DAY);
  assert.equal((await (await guestExpiry(env, p.token)).json()).days_left, 1);
  for (const k of [F1, F2, F3]) uploadedAt(env, k, Date.now() - 200 * DAY);
  const late = await (await guestExpiry(env, p.token)).json();
  assert.equal(late.days_left, 0);
  assert.ok(Date.parse(late.expires_at) < Date.now());
});

test('guest expiry: only the delivered finals — never the proofs, even with proof download on, nor another finals folder', async () => {
  const env = setup();
  const p = await delivered(env);
  stampAll(env);
  uploadedAt(env, PA, '2025-03-01T00:00:00Z');   // far older proofs
  env.DB._db.prepare('UPDATE projects SET allow_proof_download = 1').run();
  const out = await (await guestExpiry(env, p.token)).json();
  assert.equal(out.expires_at, plus180('2026-03-15T12:30:00Z'));
  // a repeat deliver onto FINAL2 (G1, older) moves it
  assert.equal((await deliver(env, p.id, [FINAL2])).status, 200);
  assert.equal((await (await guestExpiry(env, p.token)).json()).expires_at, plus180('2025-12-01T00:00:00Z'));
});

test('guest expiry: not delivered — {expires_at: null, days_left: null}, and R2 is not asked', async () => {
  const env = setup();
  const p = await retouching(env);
  stampAll(env);
  const calls = countLists(env);
  const res = await guestExpiry(env, p.token);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { expires_at: null, days_left: null });
  assert.deepEqual(calls, []);
});

test('guest expiry: after 取消交件 and after 開放修改 it is null again (final_folders kept, delivered_at cleared)', async () => {
  for (const action of ['undeliver', 'reopen']) {
    const env = setup();
    const p = await delivered(env);
    stampAll(env);
    assert.notEqual((await (await guestExpiry(env, p.token)).json()).expires_at, null, 'positive control');
    assert.equal((await admin(env, p.id, action)).status, 200, action);
    assert.ok(one(env, 'SELECT final_folders FROM projects').final_folders, 'final_folders kept');
    const calls = countLists(env);
    assert.deepEqual(await (await guestExpiry(env, p.token)).json(), { expires_at: null, days_left: null }, action);
    assert.deepEqual(calls, [], action);
  }
});

test('guest expiry: a final_folders edited by hand to name `_` objects or `/` opens nothing (pickFinals re-validates)', async () => {
  for (const bad of ['["_thumbs/"]', '["/"]', '["_t/abc/"]', 'not json', '[]']) {
    const env = setup();
    const p = await delivered(env);
    stampAll(env);
    env.DB._db.prepare('UPDATE projects SET final_folders = ?').run(bad);
    const calls = countLists(env);
    assert.deepEqual(await (await guestExpiry(env, p.token)).json(), { expires_at: null, days_left: null }, bad);
    assert.deepEqual(calls, [], bad);
  }
});

test('guest expiry: a revoked, expired, unknown or missing link is 401', async () => {
  const env = setup();
  const p = await delivered(env);
  stampAll(env);
  assert.equal((await guestExpiry(env, p.token)).status, 200, 'positive control');
  assert.equal((await guestExpiry(env, 'no-such-token')).status, 401);
  assert.equal((await call(env, '/api/pick/expiry')).status, 401);
  env.DB._db.prepare('UPDATE share_tokens SET expires_at = ? WHERE token = ?').run(iso(Date.now() - 1000), p.token);
  assert.equal((await guestExpiry(env, p.token)).status, 401);
  env.DB._db.prepare('UPDATE share_tokens SET expires_at = ?, revoked_at = ? WHERE token = ?').run(iso(Date.now() + DAY), iso(Date.now()), p.token);
  assert.equal((await guestExpiry(env, p.token)).status, 401);
  // the photographer's token is not a link
  assert.equal((await call(env, '/api/pick/expiry', { token: SECRET })).status, 401);
});

test('guest expiry: another project\'s link reads its own finals only; the request names no folder', async () => {
  const env = setup();
  const p = await delivered(env);                 // FINAL
  const q = await delivered(env, [FINAL2]);       // FINAL2 (G1)
  stampAll(env);
  assert.equal((await (await guestExpiry(env, p.token)).json()).expires_at, plus180('2026-03-15T12:30:00Z'));
  assert.equal((await (await guestExpiry(env, q.token)).json()).expires_at, plus180('2025-12-01T00:00:00Z'));
  // folder / prefix / key in the query change nothing
  const calls = countLists(env);
  const tricked = await (await guestExpiry(env, p.token, `?folder=other/&prefix=other/&key=${encodeURIComponent('other/x.jpg')}&folders=${encodeURIComponent(FINAL2)}`)).json();
  assert.equal(tricked.expires_at, plus180('2026-03-15T12:30:00Z'));
  assert.deepEqual(calls, [FINAL]);
});

test('guest expiry: GET only (405 with Allow: GET); a sub-path is 404', async () => {
  const env = setup();
  const p = await delivered(env);
  const res = await pick(env, 'POST', 'expiry', p.token, { body: {} });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('Allow'), 'GET');
  assert.equal((await guestExpiry(env, p.token, '/x')).status, 404);
});

test('guest expiry: a project of another photographer reads that photographer\'s prefix, never the default\'s same keys', async () => {
  const env = setup({ extra: ROUTES_ON });
  const { B } = await twoTenants(env);
  const p = await delivered(env);
  stampAll(env);   // the default's F2: 2026-03-15
  env.DB._db.prepare('UPDATE projects SET photographer_id = ? WHERE id = ?').run(B.id, p.id);
  const calls = countLists(env);
  assert.deepEqual(await (await guestExpiry(env, p.token)).json(), { expires_at: null, days_left: null }, 'B has no finals uploaded yet');
  assert.deepEqual(calls, [`_t/${B.id}/${FINAL}`]);
  env.imagepicker._store.set(`_t/${B.id}/${F1}`, { key: 'x', body: 'B', contentType: 'image/jpeg', uploaded: new Date('2026-08-01T00:00:00Z') });
  assert.equal((await (await guestExpiry(env, p.token)).json()).expires_at, plus180('2026-08-01T00:00:00Z'));
});

// ─── the source ───────────────────────────────────────────────────────────

test('source: R2_LIFETIME_DAYS is 180, named next to the lifecycle rule it mirrors; the guest route reads pickFinals', () => {
  assert.match(SRC, /const R2_LIFETIME_DAYS = 180;/);
  const at = SRC.indexOf('const R2_LIFETIME_DAYS');
  assert.match(SRC.slice(Math.max(0, at - 600), at), /lifecycle/i);
  const route = SRC.slice(SRC.indexOf("route === 'expiry'"), SRC.indexOf("route === 'expiry'") + 1500);
  assert.match(route, /pickReadScope\(s\)|pickFinals\(/);
  assert.doesNotMatch(route, /params\.get|request\.json|\.folders\b/);
});
