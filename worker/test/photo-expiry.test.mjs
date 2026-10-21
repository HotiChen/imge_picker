// 照片保存期限 (docs/delivery.md, "Photo expiry"), retired 2026-10-21: the R2
// bucket's whole-bucket 180-day lifecycle rule is being removed (proofs are
// deleted by the Worker on the photographer's own schedule instead, finals
// never), so the two read-only routes keep their shape but answer no date,
// and never ask R2 anything:
// - GET /api/admin/projects/:id/expiry — the photographer's own project:
//   {proofs, finals}, each {expires_at: null, earliest_uploaded: null,
//   count: null, truncated: false}; finals null while final_folders is;
// - GET /api/pick/expiry — any live pick link: {expires_at: null,
//   days_left: null}, delivered or not.
// The pages (admin.html #pd-expiry, the 完成頁 #cpExpiry) hide the line on a
// null date, so the old "照片預計保存到…" disappears without a page change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  setup, admin, deliver, delivered, retouching,
  FINAL2, SECRET, call, pick, one,
} from './revision-helpers.mjs';
import { twoTenants, ROUTES_ON } from './tenant-helpers.mjs';

const SRC = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const DAY = 86400000;
const NOPE = '00000000-0000-4000-8000-000000000000';
const iso = ms => new Date(ms).toISOString();
const NONE = { expires_at: null, earliest_uploaded: null, count: null, truncated: false };

// every R2 call the request makes (list, get, head), by method
function countR2(env) {
  const calls = [];
  for (const m of ['list', 'get', 'head']) {
    const f = env.imagepicker[m].bind(env.imagepicker);
    env.imagepicker[m] = (...a) => { calls.push(m); return f(...a); };
  }
  return calls;
}

const adminExpiry = (env, id, token = SECRET) => call(env, `/api/admin/projects/${id}/expiry`, { token });
const guestExpiry = (env, t, extra = '') => pick(env, 'GET', `expiry${extra}`, t);

// ─── the photographer's route ─────────────────────────────────────────────

test('admin expiry: delivered — proofs and finals keep their shape, every date null, and R2 is not asked', async () => {
  const env = setup();
  const p = await delivered(env);
  const calls = countR2(env);
  const res = await adminExpiry(env, p.id);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(res.headers.get('Vary'), 'Authorization');
  assert.deepEqual(await res.json(), { proofs: NONE, finals: NONE });
  assert.deepEqual(calls, []);
});

test('admin expiry: finals is null until the project has final_folders; after 取消交件 the kept final_folders still answer an (empty) entry', async () => {
  const env = setup();
  const p = await retouching(env);
  const calls = countR2(env);
  assert.deepEqual(await (await adminExpiry(env, p.id)).json(), { proofs: NONE, finals: null });
  assert.equal((await deliver(env, p.id)).status, 200);
  assert.equal((await admin(env, p.id, 'undeliver')).status, 200);
  assert.equal(one(env, 'SELECT delivered_at FROM projects').delivered_at, null);
  assert.ok(one(env, 'SELECT final_folders FROM projects').final_folders, 'final_folders kept');
  calls.length = 0;
  assert.deepEqual(await (await adminExpiry(env, p.id)).json(), { proofs: NONE, finals: NONE });
  assert.deepEqual(calls, []);
});

test('admin expiry: no token or a link token is 401; an unknown id 404; another method 405', async () => {
  const env = setup();
  const p = await delivered(env);
  assert.equal((await adminExpiry(env, p.id)).status, 200, 'positive control');
  assert.equal((await call(env, `/api/admin/projects/${p.id}/expiry`)).status, 401);
  assert.equal((await adminExpiry(env, p.id, p.token)).status, 401);
  assert.equal((await call(env, `/api/admin/projects/${p.id}/expiry`, { headers: { 'X-Share-Token': p.token } })).status, 401);
  assert.equal((await adminExpiry(env, NOPE)).status, 404);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = await call(env, `/api/admin/projects/${p.id}/expiry`, { method, token: SECRET });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('Allow'), 'GET', method);
  }
});

test('admin expiry: another photographer\'s project is a nonexistent one, both ways; its own answers', async () => {
  const env = setup({ extra: ROUTES_ON });
  const { B } = await twoTenants(env);
  const a = await delivered(env);
  const b = await delivered(env);
  env.DB._db.prepare('UPDATE projects SET photographer_id = ? WHERE id = ?').run(B.id, b.id);
  for (const [token, victim] of [[B.token, a.id], [SECRET, b.id]]) {
    const res = await adminExpiry(env, victim, token);
    const none = await adminExpiry(env, NOPE, token);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), await none.text());
  }
  assert.deepEqual(await (await adminExpiry(env, b.id, B.token)).json(), { proofs: NONE, finals: NONE });
  assert.deepEqual(await (await adminExpiry(env, a.id)).json(), { proofs: NONE, finals: NONE });
});

// ─── the guest's route ────────────────────────────────────────────────────

test('guest expiry: delivered — {expires_at: null, days_left: null} for owner and viewer, nothing else, R2 not asked', async () => {
  const env = setup();
  const p = await delivered(env);
  const calls = countR2(env);
  for (const key of [p.key, undefined]) { // the seat owner and a viewer alike
    const res = await pick(env, 'GET', 'expiry', p.token, { key });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), '*');
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { expires_at: null, days_left: null });
    for (const leak of ['shoot', '精修', '毛片', '.jpg', 'count', 'truncated', 'earliest']) assert.ok(!text.includes(leak), `leaked ${leak}`);
  }
  assert.deepEqual(calls, []);
});

test('guest expiry: picking, 取消交件 and 開放修改 — still null, and R2 not asked', async () => {
  for (const action of [null, 'undeliver', 'reopen']) {
    const env = setup();
    const p = action ? await delivered(env) : await retouching(env);
    if (action) assert.equal((await admin(env, p.id, action)).status, 200, action);
    const calls = countR2(env);
    const res = await guestExpiry(env, p.token);
    assert.equal(res.status, 200, String(action));
    assert.deepEqual(await res.json(), { expires_at: null, days_left: null }, String(action));
    assert.deepEqual(calls, [], String(action));
  }
});

test('guest expiry: folder / prefix / key in the query change nothing and ask R2 nothing', async () => {
  const env = setup();
  const p = await delivered(env);
  const calls = countR2(env);
  const res = await guestExpiry(env, p.token, `?folder=other/&prefix=other/&key=${encodeURIComponent('other/x.jpg')}&folders=${encodeURIComponent(FINAL2)}`);
  assert.deepEqual(await res.json(), { expires_at: null, days_left: null });
  assert.deepEqual(calls, []);
});

test('guest expiry: a revoked, expired, unknown or missing link is 401', async () => {
  const env = setup();
  const p = await delivered(env);
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

test('guest expiry: GET only (405 with Allow: GET); a sub-path is 404', async () => {
  const env = setup();
  const p = await delivered(env);
  const res = await pick(env, 'POST', 'expiry', p.token, { body: {} });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('Allow'), 'GET');
  assert.equal((await guestExpiry(env, p.token, '/x')).status, 404);
});

// ─── the source ───────────────────────────────────────────────────────────

test('source: the 180-day estimate is gone (no R2_LIFETIME_DAYS, no folderExpiry), and neither route lists R2', () => {
  assert.doesNotMatch(SRC, /R2_LIFETIME_DAYS|folderExpiry|EXPIRY_LIST_CALLS_MAX/);
  const guest = SRC.slice(SRC.indexOf("route === 'expiry'"), SRC.indexOf("route === 'expiry'") + 600);
  assert.match(guest, /expires_at: null, days_left: null/);
  assert.doesNotMatch(guest, /\.list\(|bucketFor|params\.get|request\.json/);
  const at = SRC.indexOf("pathParts[4] === 'expiry'");
  const adminRoute = SRC.slice(at, at + 1400);
  assert.match(adminRoute, /NO_EXPIRY/);
  assert.doesNotMatch(adminRoute, /\.list\(|bucketFor/);
});
