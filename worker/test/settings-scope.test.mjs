// Batch 2b-3 of docs/multi-photographer.md: the studio settings, the logo and
// the dashboard counts are scoped to the calling photographer (who.id), and
// the default token is no super-user. Each photographer reads and writes his
// own studio_settings row (the table is keyed by photographer_id already: no
// migration), his own logo, and counts only his own projects and orders.
//
// The guest page's logo comes from the link: GET /api/pick/logo?t=<pick link>
// serves the logo of that link's project's photographer, never anyone else's
// (no logo of his: 404, the same as when nobody has one). The old public
// GET /api/studio/logo stays the default photographer's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { req, ctx } from './fakes.mjs';
import { SECRET, setup, call, createProject, rows, one } from './pick-helpers.mjs';
import { twoTenants, snapshot, ROUTES_ON } from './tenant-helpers.mjs';
import { s2Schema, envOf } from './guest-order-helpers.mjs';

const SRC = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 9, 9]);

const getSettings = (env, token) => call(env, '/api/admin/settings', { token });
const putSettings = (env, body, token) => call(env, '/api/admin/settings', { method: 'PUT', token, body });
const putLogo = (env, bytes, token) =>
  worker.fetch(req('/api/admin/settings/logo', { method: 'PUT', token, body: bytes }), env, ctx);
const deleteLogo = (env, token) => call(env, '/api/admin/settings/logo', { method: 'DELETE', token });
const adminLogo = (env, token, headers = {}) => call(env, '/api/admin/settings/logo', { token, headers });
const pickLogo = (env, t, opts = {}) => call(env, `/api/pick/logo?t=${encodeURIComponent(t)}`, opts);
const stats = (env, token) => call(env, '/api/admin/stats', { token });
const bytesOf = async res => new Uint8Array(await res.arrayBuffer());
const settingsRow = (env, id) => one(env, 'SELECT * FROM studio_settings WHERE photographer_id = ?', id);

async function world() {
  const env = setup(ROUTES_ON);
  const { A, B } = await twoTenants(env);
  return { env, A, B };
}

// a pick link to a project that `owner` owns (made by the default
// photographer, then handed over: B cannot create one until batch 3)
async function linkOf(env, owner, title = '專案') {
  const created = await createProject(env, { title });
  env.DB._db.prepare('UPDATE projects SET photographer_id = ? WHERE id = ?').run(owner.id, created.project.id);
  return created;
}

// ─── settings ──────────────────────────────────────────────────────────────

test('settings: each photographer reads and writes his own row; the other row is untouched', async () => {
  const { env, A, B } = await world();
  assert.equal((await putSettings(env, { studio_name: '甲工作室', booking_url: 'https://a.example/', default_pick_limit: 30 }, A.token)).status, 200);
  const aRow = JSON.stringify(settingsRow(env, A.id));

  // B starts empty: nothing of A's
  const empty = await getSettings(env, B.token);
  assert.equal(empty.status, 200);
  const e = await empty.json();
  assert.equal(e.studio_name, null);
  assert.equal(e.booking_url, null);
  assert.equal(e.default_pick_limit, null);
  assert.equal(e.has_logo, false);

  const put = await putSettings(env, { studio_name: '乙工作室', default_pick_limit: 12 }, B.token);
  assert.equal(put.status, 200);
  const p = await put.json();
  assert.equal(p.studio_name, '乙工作室');
  assert.equal(p.default_pick_limit, 12);
  assert.equal(p.booking_url, null, 'not A\'s booking link');
  assert.equal(settingsRow(env, B.id).studio_name, '乙工作室');
  assert.equal(JSON.stringify(settingsRow(env, A.id)), aRow, 'A\'s row untouched by B');

  // and the other way round: A's write never reaches B's row
  const bRow = JSON.stringify(settingsRow(env, B.id));
  assert.equal((await putSettings(env, { studio_name: '甲二' }, A.token)).status, 200);
  assert.equal(JSON.stringify(settingsRow(env, B.id)), bRow, 'B\'s row untouched by A');
  assert.equal((await (await getSettings(env, A.token)).json()).studio_name, '甲二');
  assert.equal((await (await getSettings(env, B.token)).json()).studio_name, '乙工作室');
  assert.equal(rows(env, 'SELECT * FROM studio_settings').length, 2);
});

test('settings: a photographer_id in the body is ignored — B cannot write A\'s row, nor A B\'s', async () => {
  const { env, A, B } = await world();
  await putSettings(env, { studio_name: '甲' }, A.token);
  await putSettings(env, { studio_name: '乙' }, B.token);
  const before = JSON.stringify(rows(env, 'SELECT * FROM studio_settings ORDER BY photographer_id'));
  await putSettings(env, { photographer_id: A.id, studio_name: '乙改' }, B.token);
  await putSettings(env, { photographer_id: B.id, studio_name: '甲改' }, A.token);
  assert.equal(settingsRow(env, A.id).studio_name, '甲改');
  assert.equal(settingsRow(env, B.id).studio_name, '乙改');
  assert.notEqual(JSON.stringify(rows(env, 'SELECT * FROM studio_settings ORDER BY photographer_id')), before);
  assert.equal(rows(env, 'SELECT * FROM studio_settings').length, 2);
});

test('settings: a bad body from B writes nothing anywhere (400, as for anyone)', async () => {
  const { env, A, B } = await world();
  await putSettings(env, { studio_name: '甲' }, A.token);
  const before = snapshot(env);
  const res = await putSettings(env, { booking_url: 'http://insecure.example/' }, B.token);
  assert.equal(res.status, 400);
  assert.equal(snapshot(env), before);
});

test('settings before the late-column migrations: B reads and writes his base fields; a late column is 500, nothing written', async () => {
  const schema = s2Schema({ orders: [], items: [], settings: ['default_extra_max', 'transfer_info', 'pick_link_message'], index: false });
  const env = envOf({ schema, extra: ROUTES_ON });
  const { A, B } = await twoTenants(env);
  assert.equal((await putSettings(env, { studio_name: '甲' }, A.token)).status, 200);
  const got = await (await getSettings(env, B.token)).json();
  assert.equal(got.studio_name, null);
  assert.equal(got.pick_link_message, null);
  const put = await putSettings(env, { studio_name: '乙' }, B.token);
  assert.equal(put.status, 200);
  assert.equal((await put.json()).studio_name, '乙');
  const before = snapshot(env);
  const late = await putSettings(env, { pick_link_message: 'x' }, B.token);
  assert.equal(late.status, 500);
  assert.equal((await late.json()).code, 'pick_link_message_unavailable');
  assert.equal(snapshot(env), before);
  assert.equal((await (await getSettings(env, A.token)).json()).studio_name, '甲');
  // the logo and stats need no late column
  assert.equal((await putLogo(env, PNG, B.token)).status, 200);
  assert.equal((await stats(env, B.token)).status, 200);
});

// ─── logo (admin) ───────────────────────────────────────────────────────────

test('logo PUT / DELETE: each photographer changes his own logo only', async () => {
  const { env, A, B } = await world();
  assert.equal((await putLogo(env, PNG, A.token)).status, 200);
  const aRow = JSON.stringify(settingsRow(env, A.id), (k, v) => (v instanceof Uint8Array ? Array.from(v) : v));
  const row = () => JSON.stringify(settingsRow(env, A.id), (k, v) => (v instanceof Uint8Array ? Array.from(v) : v));

  const put = await putLogo(env, JPEG, B.token);
  assert.equal(put.status, 200);
  assert.equal((await put.json()).logo_type, 'image/jpeg');
  assert.equal(settingsRow(env, B.id).logo_type, 'image/jpeg');
  assert.equal(row(), aRow, 'A\'s logo untouched by B\'s upload');
  assert.equal((await (await getSettings(env, B.token)).json()).logo_type, 'image/jpeg');
  assert.equal((await (await getSettings(env, A.token)).json()).logo_type, 'image/png');

  // B deletes: B's goes, A's stays
  assert.equal((await deleteLogo(env, B.token)).status, 200);
  assert.equal(settingsRow(env, B.id).logo, null);
  assert.equal(row(), aRow, 'A\'s logo untouched by B\'s delete');

  // A deletes: A's goes, B's (re-uploaded) stays
  await putLogo(env, JPEG, B.token);
  const bLogo = Array.from(settingsRow(env, B.id).logo);
  assert.equal((await deleteLogo(env, A.token)).status, 200);
  assert.equal(settingsRow(env, A.id).logo, null);
  assert.deepEqual(Array.from(settingsRow(env, B.id).logo), bLogo, 'B\'s logo untouched by A\'s delete');
});

test('logo DELETE by a photographer with no row writes nothing (A\'s row untouched)', async () => {
  const { env, A, B } = await world();
  await putLogo(env, PNG, A.token);
  const before = snapshot(env);
  const res = await deleteLogo(env, B.token);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, has_logo: false });
  assert.equal(snapshot(env), before);
});

test('GET /api/admin/settings/logo: the caller\'s own logo, private; none of his = 404, the same as nobody\'s', async () => {
  const { env, A, B } = await world();
  await putLogo(env, PNG, A.token);
  const a = await adminLogo(env, A.token);
  assert.equal(a.status, 200);
  assert.equal(a.headers.get('Content-Type'), 'image/png');
  assert.equal(a.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(a.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(await bytesOf(a), PNG);

  // B has none, A has one: B's answer is the one for "nobody has a logo"
  const b = await adminLogo(env, B.token);
  const bText = await b.text();
  const fresh = setup(ROUTES_ON);
  const { B: B2 } = await twoTenants(fresh);
  const none = await adminLogo(fresh, B2.token);
  assert.equal(b.status, 404);
  assert.equal(none.status, 404);
  assert.equal(bText, await none.text());

  await putLogo(env, JPEG, B.token);
  const b2 = await adminLogo(env, B.token);
  assert.equal(b2.status, 200);
  assert.deepEqual(await bytesOf(b2), JPEG);
  // A still gets A's
  assert.deepEqual(await bytesOf(await adminLogo(env, A.token)), PNG);

  // no identity: 401 (a pick link is no identity either)
  const link = await linkOf(env, A);
  assert.equal((await adminLogo(env, undefined)).status, 401);
  assert.equal((await call(env, `/api/admin/settings/logo?t=${encodeURIComponent(link.token)}`)).status, 401);
});

// ─── logo (guest, through the link) ──────────────────────────────────────────

test('GET /api/pick/logo: the logo of the link\'s project\'s photographer, never the other one', async () => {
  const { env, A, B } = await world();
  await putLogo(env, PNG, A.token);
  await putLogo(env, JPEG, B.token);
  const aLink = await linkOf(env, A, '甲案');
  const bLink = await linkOf(env, B, '乙案');
  const before = snapshot(env);

  const a = await pickLogo(env, aLink.token);
  assert.equal(a.status, 200);
  assert.equal(a.headers.get('Content-Type'), 'image/png');
  assert.equal(a.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(a.headers.get('Content-Security-Policy'), "default-src 'none'");
  assert.match(a.headers.get('Cache-Control'), /^private\b/, 'a URL with a link in it is not for shared caches');
  assert.deepEqual(await bytesOf(a), PNG);

  const b = await pickLogo(env, bLink.token);
  assert.equal(b.status, 200);
  assert.equal(b.headers.get('Content-Type'), 'image/jpeg');
  assert.deepEqual(await bytesOf(b), JPEG);

  // the link in a header works the same
  const h = await call(env, '/api/pick/logo', { headers: { 'X-Share-Token': bLink.token } });
  assert.deepEqual(await bytesOf(h), JPEG);
  assert.equal(snapshot(env), before, 'reading a logo writes nothing');
});

test('GET /api/pick/logo: the link\'s photographer has no logo → 404 like nobody\'s, not the default one', async () => {
  const { env, A, B } = await world();
  await putLogo(env, PNG, A.token);
  const bLink = await linkOf(env, B);
  const res = await pickLogo(env, bLink.token);
  const text = await res.text();
  assert.equal(res.status, 404);
  // the same as a default project whose photographer set no logo
  const fresh = setup(ROUTES_ON);
  const plain = await linkOf(fresh, { id: 'default' });
  const none = await pickLogo(fresh, plain.token);
  assert.equal(none.status, 404);
  assert.equal(text, await none.text());
  // and A deleting its logo makes A's link 404 too, B's link unchanged
  const aLink = await linkOf(env, A);
  assert.equal((await pickLogo(env, aLink.token)).status, 200);
  await deleteLogo(env, A.token);
  assert.equal((await pickLogo(env, aLink.token)).status, 404);
});

test('GET /api/pick/logo: no link, a bad / revoked / archived link is 401; other methods 405; ETag 304', async () => {
  const { env, A } = await world();
  await putLogo(env, PNG, A.token);
  const link = await linkOf(env, A);
  assert.equal((await call(env, '/api/pick/logo')).status, 401);
  assert.equal((await pickLogo(env, 'nope')).status, 401);
  // the photographer's token is no link
  assert.equal((await call(env, '/api/pick/logo', { token: SECRET })).status, 401);
  for (const method of ['PUT', 'POST', 'DELETE']) {
    const before = snapshot(env);
    const r = await pickLogo(env, link.token, { method, body: method === 'DELETE' ? undefined : 'x' });
    assert.equal(r.status, 405, method);
    assert.equal(snapshot(env), before, method);
  }
  const ok = await pickLogo(env, link.token);
  const tag = ok.headers.get('ETag');
  assert.ok(tag);
  assert.equal((await pickLogo(env, link.token, { headers: { 'If-None-Match': tag } })).status, 304);
  env.DB._db.prepare("UPDATE projects SET archived_at = '2026-01-01T00:00:00.000Z'").run();
  assert.equal((await pickLogo(env, link.token)).status, 401);
  env.DB._db.prepare('UPDATE projects SET archived_at = NULL').run();
  env.DB._db.prepare("UPDATE share_tokens SET revoked_at = '2026-01-01T00:00:00.000Z'").run();
  assert.equal((await pickLogo(env, link.token)).status, 401);
});

test('GET /api/pick/logo: a hand-edited row that is not an image is 404 (re-sniffed)', async () => {
  const { env, B } = await world();
  const link = await linkOf(env, B);
  env.DB._db.prepare("INSERT INTO studio_settings (photographer_id, logo, logo_type) VALUES (?, ?, 'image/png')")
    .run(B.id, new TextEncoder().encode('<script>alert(1)</script>'));
  assert.equal((await pickLogo(env, link.token)).status, 404);
});

test('GET /api/studio/logo stays the default photographer\'s: B\'s logo never shows there', async () => {
  const { env, A, B } = await world();
  await putLogo(env, JPEG, B.token);
  assert.equal((await call(env, '/api/studio/logo')).status, 404, 'default has none; B\'s is not served');
  await putLogo(env, PNG, A.token);
  const res = await call(env, '/api/studio/logo');
  assert.equal(res.status, 200);
  assert.deepEqual(await bytesOf(res), PNG);
});

test('the guest page\'s studio block (state) is the link\'s photographer\'s, has_logo included', async () => {
  const { env, A, B } = await world();
  await putSettings(env, { studio_name: '甲' }, A.token);
  await putLogo(env, PNG, A.token);
  await putSettings(env, { studio_name: '乙' }, B.token);
  const bLink = await linkOf(env, B);
  const state = await (await call(env, `/api/pick/state?t=${encodeURIComponent(bLink.token)}`)).json();
  assert.equal(state.studio.name, '乙');
  assert.equal(state.studio.has_logo, false);
});

// ─── stats ─────────────────────────────────────────────────────────────────

function seedOrder(env, owner, projectId, { price, paid }) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  env.DB._db.prepare("INSERT INTO orders (id, photographer_id, project_id, source, status, paid_amount, paid_at, created_at, updated_at, confirmed_at) VALUES (?, ?, ?, 'admin', 'confirmed', ?, ?, ?, ?, ?)")
    .run(id, owner.id, projectId, paid, paid ? now : null, now, now, now);
  env.DB._db.prepare("INSERT INTO order_items (id, order_id, kind, name, unit_price, unit_cost, qty) VALUES (?, ?, 'service', 'x', ?, 100, 1)")
    .run(crypto.randomUUID(), id, price);
}

test('stats: each photographer counts his own projects and orders only', async () => {
  const { env, A, B } = await world();
  const a1 = await linkOf(env, A, '甲一');
  const b1 = await linkOf(env, B, '乙一');
  await linkOf(env, B, '乙二');
  env.DB._db.prepare("UPDATE projects SET phase = 'submitted' WHERE id = ?").run(b1.project.id);
  seedOrder(env, A, a1.project.id, { price: 1000, paid: 300 });
  seedOrder(env, B, b1.project.id, { price: 5000, paid: 2000 });
  seedOrder(env, B, b1.project.id, { price: 800, paid: 0 });
  const before = snapshot(env);

  const a = await stats(env, A.token);
  assert.equal(a.status, 200);
  assert.equal(a.headers.get('Cache-Control'), 'private, no-store');
  const sa = await a.json();
  assert.deepEqual(sa.by_phase, { picking: 1, submitted: 0, retouching: 0 });
  assert.equal(sa.outstanding, 700);
  assert.equal(sa.todo.unpaid_orders, 1);
  assert.equal(sa.per_month.reduce((n, m) => n + m.created, 0), 1);
  assert.equal(sa.revenue.reduce((n, m) => n + m.paid, 0), 300);

  const sb = await (await stats(env, B.token)).json();
  assert.deepEqual(sb.by_phase, { picking: 1, submitted: 1, retouching: 0 });
  assert.equal(sb.todo.submitted_not_retouching, 1);
  assert.equal(sb.outstanding, 3000 + 800);
  assert.equal(sb.todo.unpaid_orders, 2);
  assert.equal(sb.per_month.reduce((n, m) => n + m.created, 0), 2);
  assert.equal(sb.revenue.reduce((n, m) => n + m.paid, 0), 2000);
  assert.equal(sb.revenue.reduce((n, m) => n + m.cost, 0), 100, 'only the paid order\'s cost');
  assert.equal(snapshot(env), before, 'stats write nothing');
});

test('stats: a photographer with nothing gets all zeros, whatever the other has', async () => {
  const { env, A, B } = await world();
  const a1 = await linkOf(env, A);
  seedOrder(env, A, a1.project.id, { price: 1000, paid: 1000 });
  const sb = await (await stats(env, B.token)).json();
  assert.deepEqual(sb.by_phase, { picking: 0, submitted: 0, retouching: 0 });
  assert.equal(sb.delivered, 0);
  assert.equal(sb.archived, 0);
  assert.equal(sb.outstanding, 0);
  assert.ok(sb.per_month.every(m => m.created === 0 && m.delivered === 0));
  assert.ok(sb.revenue.every(m => m.paid === 0 && m.cost === 0 && m.margin === 0));
  assert.deepEqual(sb.todo, { submitted_not_retouching: 0, unnotified_submissions: 0, modified_after_submit: 0, unpaid_orders: 0, requested_orders: 0 });
});

// ─── switch off, and the source ─────────────────────────────────────────────

test('switch off: a session is 401 on every 2b-3 route and on nothing else is it let in; nothing written', async () => {
  const env = setup();
  const { A, B } = await twoTenants(env);
  await putLogo(env, PNG, A.token);
  for (const [method, path, body] of [
    ['GET', '/api/admin/stats'], ['GET', '/api/admin/settings'], ['PUT', '/api/admin/settings', { studio_name: 'x' }],
    ['GET', '/api/admin/settings/logo'], ['PUT', '/api/admin/settings/logo', 'x'], ['DELETE', '/api/admin/settings/logo'],
  ]) {
    const before = snapshot(env);
    assert.equal((await call(env, path, { method, token: B.token, body })).status, 401, `${method} ${path}`);
    assert.equal(snapshot(env), before, `${method} ${path}`);
  }
});

test('source: the 2b-3 routes are scoped to the caller, and no 2b-3 mark is left', () => {
  assert.equal((SRC.match(/default-only until 2b-3/g) || []).length, 0);
  for (const path of ["'/api/admin/stats'", "'/api/admin/settings'", "'/api/admin/settings/logo'"]) {
    const at = SRC.indexOf(`url.pathname === ${path}`);
    assert.ok(at > 0, path);
    const line = SRC.slice(SRC.indexOf('\n', at) + 1, SRC.indexOf('\n', SRC.indexOf('\n', at) + 1));
    assert.match(line, /requirePhotographer\(request, env\); \/\/ scoped to the caller \(who\.id\)/, path);
  }
  // the guest logo reads the project's photographer, never a constant
  const at = SRC.indexOf("route === 'logo'");
  assert.ok(at > 0);
  const block = SRC.slice(at, SRC.indexOf('\n      }\n', at));
  assert.ok(block.includes('project.photographer_id'));
  assert.ok(!block.includes('DEFAULT_PHOTOGRAPHER_ID'));
});
