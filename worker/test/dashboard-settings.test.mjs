// Back-office: delivered state, studio settings, logo, guest branding and the
// dashboard aggregates (docs/dashboard-settings.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { fakeDB, req, ctx } from './fakes.mjs';
import {
  SECRET, MINE, setup, call, pick, createProject, claimed, save, one, rows, seedToken, days,
  collectingCtx,
} from './pick-helpers.mjs';

const A = '20260819/a.jpg';

const admin = (env, id, action, token = SECRET, body) =>
  call(env, `/api/admin/projects/${id}/${action}`, { method: 'POST', token, body });
// deliver takes the finals folder snapshot (docs/delivery.md)
const FINALS = { final_folders: ['20260819-final/'] };
const deliver = (env, id) => admin(env, id, 'deliver', SECRET, FINALS);
const getSettings = (env, token = SECRET) => call(env, '/api/admin/settings', { token });
const putSettings = (env, body, token = SECRET) => call(env, '/api/admin/settings', { method: 'PUT', token, body });
// raw bytes: `call` would JSON-encode anything that is not a string
const putLogo = (env, bytes, { token = SECRET, headers = {} } = {}) =>
  worker.fetch(req('/api/admin/settings/logo', { method: 'PUT', token, body: bytes, headers }), env, ctx);
const deleteLogo = (env, token = SECRET) => call(env, '/api/admin/settings/logo', { method: 'DELETE', token });
const getLogo = (env, headers = {}) => call(env, '/api/studio/logo', { headers });
const stats = (env, token = SECRET) => call(env, '/api/admin/stats', { token });

async function submit(env, p) {
  const c = collectingCtx();
  const res = await pick(env, 'POST', 'submit', p.token, { key: p.key, body: { relationship: '本人' } }, c);
  await c.settle();
  return res;
}

// a project in retouching, with one pick submitted
async function retouching(env) {
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  assert.equal((await submit(env, p)).status, 200);
  assert.equal((await admin(env, p.project.id, 'start-retouch')).status, 200);
  return p;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const WEBP = new Uint8Array([...'RIFF'].map(c => c.charCodeAt(0)).concat([0x10, 0, 0, 0], [...'WEBPVP8 '].map(c => c.charCodeAt(0))));
const text = s => new TextEncoder().encode(s);

// ─── delivered ───────────────────────────────────────────────────────────────

test('deliver stamps delivered_at from retouching; a repeat keeps the first stamp', async () => {
  const env = setup();
  const p = await retouching(env);
  const res = await deliver(env, p.project.id);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.match(json.delivered_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(one(env, 'SELECT delivered_at FROM projects').delivered_at, json.delivered_at);
  assert.equal(one(env, 'SELECT phase FROM projects').phase, 'retouching', 'the phase does not move');
  env.DB._db.prepare("UPDATE projects SET delivered_at = '2026-01-01T00:00:00.000Z'").run();
  const again = await (await deliver(env, p.project.id)).json();
  assert.equal(again.delivered_at, '2026-01-01T00:00:00.000Z');
});

test('deliver from picking or submitted is 409 not_retouching and writes nothing', async () => {
  const env = setup();
  const p = await claimed(env);
  let res = await admin(env, p.project.id, 'deliver');
  assert.equal(res.status, 409);
  let json = await res.json();
  assert.equal(json.code, 'not_retouching');
  assert.equal(json.phase, 'picking');
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  await submit(env, p);
  res = await admin(env, p.project.id, 'deliver');
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'not_retouching');
  assert.equal(one(env, 'SELECT delivered_at FROM projects').delivered_at, null);
});

test('deliver / undeliver: unknown or other photographer is 404, untouched', async () => {
  const env = setup();
  const p = await retouching(env);
  env.DB._db.prepare("UPDATE projects SET photographer_id = 'other'").run();
  for (const action of ['deliver', 'undeliver']) {
    assert.equal((await admin(env, p.project.id, action)).status, 404, action);
    assert.equal((await admin(env, 'nope', action)).status, 404, action);
  }
  assert.equal(one(env, 'SELECT delivered_at FROM projects').delivered_at, null);
  env.DB._db.prepare("UPDATE projects SET photographer_id = 'other', delivered_at = 'x'").run();
  assert.equal((await admin(env, p.project.id, 'undeliver')).status, 404);
  assert.equal(one(env, 'SELECT delivered_at FROM projects').delivered_at, 'x');
});

test('undeliver clears the stamp; reopen clears it too (delivered implies retouching); both keep the finals', async () => {
  const env = setup();
  const p = await retouching(env);
  assert.equal((await deliver(env, p.project.id)).status, 200);
  const res = await admin(env, p.project.id, 'undeliver');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, delivered_at: null });
  assert.equal(one(env, 'SELECT delivered_at FROM projects').delivered_at, null);
  assert.equal(one(env, 'SELECT phase FROM projects').phase, 'retouching');
  assert.equal((await deliver(env, p.project.id)).status, 200);
  assert.equal((await admin(env, p.project.id, 'reopen')).status, 200);
  assert.deepEqual({ ...one(env, 'SELECT phase, delivered_at, final_folders FROM projects') },
    { phase: 'picking', delivered_at: null, final_folders: JSON.stringify(FINALS.final_folders) });
});

test('a delivered project refuses guest saves and submits like retouching', async () => {
  const env = setup();
  const p = await retouching(env);
  assert.equal((await deliver(env, p.project.id)).status, 200);
  assert.equal(one(env, 'SELECT phase FROM projects').phase, 'retouching');
  const s = await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 3 }] });
  assert.equal(s.status, 409);
  assert.equal((await s.json()).code, 'retouching');
  const sub = await submit(env, p);
  assert.equal(sub.status, 409);
  assert.equal((await sub.json()).code, 'retouching');
  assert.equal(one(env, 'SELECT rating FROM selections').rating, 1);
  assert.equal(rows(env, 'SELECT * FROM submissions').length, 1);
});

test('the project list and detail carry delivered_at', async () => {
  const env = setup();
  const p = await retouching(env);
  const other = await createProject(env);
  const { delivered_at } = await (await deliver(env, p.project.id)).json();
  const list = await (await call(env, '/api/admin/projects', { token: SECRET })).json();
  const byId = Object.fromEntries(list.projects.map(r => [r.id, r]));
  assert.equal(byId[p.project.id].delivered_at, delivered_at);
  assert.ok('delivered_at' in byId[other.project.id]);
  assert.equal(byId[other.project.id].delivered_at, null);
  const detail = await (await call(env, `/api/admin/projects/${p.project.id}`, { token: SECRET })).json();
  assert.equal(detail.project.delivered_at, delivered_at);
});

// ─── settings ────────────────────────────────────────────────────────────────

test('settings start empty and never return the blob', async () => {
  const env = setup();
  const res = await getSettings(env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(await res.json(), {
    studio_name: null, booking_url: null, default_pick_limit: null, default_extra_price: null,
    default_extra_max: null, effective_default_extra_max: 10, // docs/project-plan.md
    transfer_info: null, // docs/guest-shop.md S2
    has_logo: false, logo_type: null, logo_updated_at: null, updated_at: null,
  });
  await putLogo(env, PNG);
  const json = await (await getSettings(env)).json();
  assert.equal(json.has_logo, true);
  assert.equal(json.logo_type, 'image/png');
  assert.match(json.logo_updated_at, /^\d{4}-/);
  assert.ok(!('logo' in json));
});

test('PUT settings stores valid values, ignores unknown fields and the body photographer_id', async () => {
  const env = setup();
  const res = await putSettings(env, {
    studio_name: '  光影工作室  ', booking_url: 'https://line.me/R/ti/p/@abc',
    default_pick_limit: 40, default_extra_price: 0, photographer_id: 'evil', logo: 'x', whatever: 1,
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.studio_name, '光影工作室');
  assert.equal(json.booking_url, 'https://line.me/R/ti/p/@abc');
  assert.equal(json.default_pick_limit, 40);
  assert.equal(json.default_extra_price, 0);
  assert.equal(json.has_logo, false);
  assert.match(json.updated_at, /^\d{4}-/);
  const stored = rows(env, 'SELECT photographer_id, logo FROM studio_settings');
  assert.deepEqual(stored.map(r => ({ ...r })), [{ photographer_id: 'default', logo: null }]);
  assert.deepEqual(await (await getSettings(env)).json(), json);
});

test('PUT settings: a field left out keeps its value, null clears it', async () => {
  const env = setup();
  await putSettings(env, { studio_name: 'A', booking_url: 'https://a.tw/', default_pick_limit: 5, default_extra_price: 100 });
  let json = await (await putSettings(env, { default_pick_limit: 9 })).json();
  assert.deepEqual([json.studio_name, json.booking_url, json.default_pick_limit, json.default_extra_price], ['A', 'https://a.tw/', 9, 100]);
  json = await (await putSettings(env, { studio_name: null, booking_url: '', default_extra_price: null })).json();
  assert.deepEqual([json.studio_name, json.booking_url, json.default_pick_limit, json.default_extra_price], [null, null, 9, null]);
});

test('PUT settings keeps the logo', async () => {
  const env = setup();
  await putLogo(env, PNG);
  await putSettings(env, { studio_name: 'A' });
  assert.equal((await getSettings(env).then(r => r.json())).has_logo, true);
  assert.equal((await getLogo(env)).status, 200);
});

test('PUT settings validation: 400 with a code per field, nothing written', async () => {
  const env = setup();
  await putSettings(env, { studio_name: 'Keep', booking_url: 'https://keep.tw/' });
  const before = JSON.stringify(rows(env, 'SELECT * FROM studio_settings'));
  const bad = [
    [{ studio_name: 'x'.repeat(61) }, 'invalid_studio_name'],
    [{ studio_name: 12 }, 'invalid_studio_name'],
    [{ booking_url: 'javascript:alert(1)' }, 'invalid_booking_url'],
    [{ booking_url: 'JaVaScRiPt:alert(1)' }, 'invalid_booking_url'],
    [{ booking_url: 'data:text/html,<script>' }, 'invalid_booking_url'],
    [{ booking_url: 'http://example.com' }, 'invalid_booking_url'],
    [{ booking_url: 'ftp://example.com' }, 'invalid_booking_url'],
    [{ booking_url: '//example.com' }, 'invalid_booking_url'],
    [{ booking_url: 'https:example.com' }, 'invalid_booking_url'],
    [{ booking_url: 'https://' }, 'invalid_booking_url'],
    [{ booking_url: 'https://a.tw/\nx' }, 'invalid_booking_url'],
    [{ booking_url: 'https://a.tw/ x' }, 'invalid_booking_url'],
    [{ booking_url: 'https://imhoti.tw@evil.com/' }, 'invalid_booking_url'],
    [{ booking_url: 'https://a.tw/' + 'x'.repeat(490) }, 'invalid_booking_url'],
    // 503 characters as typed, 499 once the parser drops the default port
    [{ booking_url: 'https://a.tw:443/' + 'x'.repeat(486) }, 'invalid_booking_url'],
    [{ booking_url: 5 }, 'invalid_booking_url'],
    [{ default_pick_limit: -1 }, 'invalid_default_pick_limit'],
    [{ default_pick_limit: 1.5 }, 'invalid_default_pick_limit'],
    [{ default_pick_limit: '3' }, 'invalid_default_pick_limit'],
    [{ default_extra_price: -5 }, 'invalid_default_extra_price'],
    [{ default_extra_price: 1e20 }, 'invalid_default_extra_price'],
    [{ studio_name: 'ok', default_extra_price: true }, 'invalid_default_extra_price'],
  ];
  for (const [body, code] of bad) {
    const res = await putSettings(env, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).code, code, JSON.stringify(body));
  }
  for (const body of ['[]', 'null', '"x"', '{bad']) {
    assert.equal((await call(env, '/api/admin/settings', { method: 'PUT', token: SECRET, body })).status, 400, body);
  }
  assert.equal(JSON.stringify(rows(env, 'SELECT * FROM studio_settings')), before);
});

test('PUT settings accepts the boundaries: 60 chars, 500-char https URL, 0', async () => {
  const env = setup();
  const url = 'https://a.tw/' + 'x'.repeat(487);
  assert.equal(url.length, 500);
  const res = await putSettings(env, { studio_name: '字'.repeat(60), booking_url: url, default_pick_limit: 0 });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.booking_url, url);
  assert.equal([...json.studio_name].length, 60);
  assert.equal(json.default_pick_limit, 0);
  // the scheme is case-insensitive
  assert.equal((await putSettings(env, { booking_url: 'HTTPS://A.tw/' })).status, 200);
});

// ─── logo ────────────────────────────────────────────────────────────────────

test('logo: PNG, JPEG and WebP are accepted by magic bytes, whatever Content-Type says', async () => {
  const env = setup();
  for (const [bytes, type] of [[PNG, 'image/png'], [JPEG, 'image/jpeg'], [WEBP, 'image/webp']]) {
    const res = await putLogo(env, bytes, { headers: { 'Content-Type': 'image/svg+xml' } });
    assert.equal(res.status, 200, type);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.logo_type, type);
    assert.equal(json.has_logo, true);
    const got = await getLogo(env);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('Content-Type'), type);
    assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes);
  }
});

test('logo: SVG, HTML, GIF, empty and near-misses are 415 and nothing is stored', async () => {
  const env = setup();
  const bad = [
    text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    text('<html><script>alert(1)</script></html>'),
    text('GIF89a....'),
    new Uint8Array([]),
    PNG.slice(0, 7),
    new Uint8Array([0xff, 0xd8, 0x00]),
    new Uint8Array([...'RIFF'].map(c => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WAVE'].map(c => c.charCodeAt(0)))),
    new Uint8Array([0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ];
  for (const bytes of bad) {
    const res = await putLogo(env, bytes, { headers: { 'Content-Type': 'image/png' } });
    assert.equal(res.status, 415, new TextDecoder().decode(bytes));
    assert.equal((await res.json()).code, 'unsupported_type');
  }
  assert.equal(rows(env, 'SELECT * FROM studio_settings WHERE logo IS NOT NULL').length, 0);
  assert.equal((await getLogo(env)).status, 404);
});

test('logo: 200 KB is the limit, one byte over is 413', async () => {
  const env = setup();
  const exact = new Uint8Array(200 * 1024); exact.set(PNG);
  assert.equal((await putLogo(env, exact)).status, 200);
  const over = new Uint8Array(200 * 1024 + 1); over.set(JPEG);
  const res = await putLogo(env, over);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, 'too_large');
  assert.equal(one(env, 'SELECT logo_type FROM studio_settings').logo_type, 'image/png', 'the old logo stays');
});

test('logo: an oversize streamed body without Content-Length is still 413', async () => {
  const env = setup();
  const chunk = new Uint8Array(64 * 1024); chunk.set(PNG);
  let sent = 0;
  const body = new ReadableStream({
    pull(c) { if (sent++ < 10) c.enqueue(chunk); else c.close(); },
  });
  const request = new Request('https://worker.test/api/admin/settings/logo', {
    method: 'PUT', body, duplex: 'half', headers: { Authorization: `Bearer ${SECRET}` },
  });
  const res = await worker.fetch(request, env, ctx);
  assert.equal(res.status, 413);
  assert.ok(sent < 10, 'stopped reading early');
  assert.equal(rows(env, 'SELECT * FROM studio_settings').length, 0);
});

test('logo is served with nosniff, a locked CSP, a 300s cache and an ETag', async () => {
  const env = setup();
  await putLogo(env, PNG);
  const res = await getLogo(env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('Content-Security-Policy'), "default-src 'none'");
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=300');
  const at = one(env, 'SELECT logo_updated_at FROM studio_settings').logo_updated_at;
  assert.equal(res.headers.get('ETag'), `"${at}"`);
  const cached = await getLogo(env, { 'If-None-Match': `"${at}"` });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), '');
  assert.equal((await getLogo(env, { 'If-None-Match': '"old"' })).status, 200);
});

test('a hand-edited logo that is not an image is not served', async () => {
  const env = setup();
  await putLogo(env, PNG);
  env.DB._db.prepare("UPDATE studio_settings SET logo = ?, logo_type = 'image/svg+xml'").run(text('<svg/>'));
  assert.equal((await getLogo(env)).status, 404);
});

test('DELETE logo removes it (and is idempotent); settings stay', async () => {
  const env = setup();
  await putSettings(env, { studio_name: 'A' });
  await putLogo(env, PNG);
  const res = await deleteLogo(env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, has_logo: false });
  assert.equal((await getLogo(env)).status, 404);
  const s = await (await getSettings(env)).json();
  assert.deepEqual([s.has_logo, s.logo_type, s.logo_updated_at, s.studio_name], [false, null, null, 'A']);
  assert.equal((await deleteLogo(env)).status, 200);
});

test('no settings row at all: logo 404', async () => {
  const env = setup();
  assert.equal((await getLogo(env)).status, 404);
});

test('the logo is another photographer\'s: not served', async () => {
  const env = setup();
  await putLogo(env, PNG);
  env.DB._db.prepare("UPDATE studio_settings SET photographer_id = 'other'").run();
  assert.equal((await getLogo(env)).status, 404);
  assert.equal((await getSettings(env).then(r => r.json())).has_logo, false);
});

// ─── guest branding ──────────────────────────────────────────────────────────

test('pick state carries the studio brand for owner and viewer alike', async () => {
  const env = setup();
  const p = await claimed(env);
  let state = await (await pick(env, 'GET', 'state', p.token)).json();
  assert.deepEqual(state.studio, { name: null, booking_url: null, has_logo: false });
  await putSettings(env, { studio_name: '光影', booking_url: 'https://book.tw/', default_pick_limit: 3 });
  await putLogo(env, JPEG);
  for (const key of [p.key, undefined]) {
    state = await (await pick(env, 'GET', 'state', p.token, { key })).json();
    assert.deepEqual(state.studio, { name: '光影', booking_url: 'https://book.tw/', has_logo: true });
  }
});

test('pick state still works on a database without studio_settings', async () => {
  const fresh = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const withoutSettings = fresh.replace(/CREATE TABLE IF NOT EXISTS studio_settings[\s\S]*?\);/, '');
  assert.doesNotMatch(withoutSettings, /CREATE TABLE IF NOT EXISTS studio_settings/);
  const env = setup({ DB: fakeDB({ schema: withoutSettings }) });
  const p = await claimed(env);
  const res = await pick(env, 'GET', 'state', p.token, { key: p.key });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).studio, { name: null, booking_url: null, has_logo: false });
});

test('pick state reads the brand of the project\'s own photographer', async () => {
  const env = setup();
  const p = await claimed(env);
  await putSettings(env, { studio_name: 'Default studio' });
  env.DB._db.prepare("UPDATE projects SET photographer_id = 'other'").run();
  const state = await (await pick(env, 'GET', 'state', p.token)).json();
  assert.equal(state.studio.name, null);
});

// ─── stats ───────────────────────────────────────────────────────────────────

function monthKey(ms) {
  const d = new Date(ms + 8 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
// the UTC instant the current Taipei month starts, shifted by `back` months
function taipeiMonthStart(back = 0) {
  const d = new Date(Date.now() + 8 * 3600000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1) - 8 * 3600000;
}
let seq = 0;
function seed(env, { phase = 'picking', created_at = days(0), delivered_at = null, archived_at = null,
  photographer_id = 'default', modified_after_submit = 0 } = {}) {
  const id = `s${++seq}`;
  env.DB._db.prepare(
    `INSERT INTO projects (id, title, folders, created_at, photographer_id, phase, modified_after_submit, archived_at, delivered_at)
     VALUES (?, '', '[]', ?, ?, ?, ?, ?, ?)`
  ).run(id, created_at, photographer_id, phase, modified_after_submit, archived_at, delivered_at);
  return id;
}
function seedSubmission(env, projectId, notified) {
  env.DB._db.prepare(
    "INSERT INTO submissions (id, project_id, picker_id, relationship, photo_keys, count, created_at, notified) VALUES (?, ?, 'x', '本人', '[]', 0, ?, ?)"
  ).run(`sub${++seq}`, projectId, days(0), notified);
}

test('stats: an empty studio', async () => {
  const env = setup();
  const res = await stats(env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const json = await res.json();
  assert.deepEqual(json.by_phase, { picking: 0, submitted: 0, retouching: 0 });
  assert.equal(json.delivered, 0);
  assert.equal(json.archived, 0);
  assert.deepEqual(json.todo, { submitted_not_retouching: 0, unnotified_submissions: 0, modified_after_submit: 0, unpaid_orders: 0, requested_orders: 0 });
  assert.equal(json.per_month.length, 12);
  assert.equal(json.per_month[11].month, monthKey(Date.now()));
  assert.equal(json.per_month[0].month, monthKey(taipeiMonthStart(11)));
  assert.ok(json.per_month.every(m => m.created === 0 && m.delivered === 0));
});

test('stats: counts by phase, delivered, archived and to-do, this photographer only', async () => {
  const env = setup();
  seed(env, { phase: 'picking' });
  seed(env, { phase: 'picking' });
  const sub1 = seed(env, { phase: 'submitted' });
  const sub2 = seed(env, { phase: 'submitted', modified_after_submit: 1 });
  seed(env, { phase: 'retouching', modified_after_submit: 1 });
  seed(env, { phase: 'retouching', delivered_at: days(0) });
  seed(env, { phase: 'retouching', delivered_at: days(0) });
  seed(env, { phase: 'retouching', delivered_at: days(-1), archived_at: days(0) });
  const arch = seed(env, { phase: 'submitted', archived_at: days(0), modified_after_submit: 1 });
  seed(env, { phase: 'picking', archived_at: days(0) });
  const other = seed(env, { phase: 'submitted', photographer_id: 'other', delivered_at: days(0), modified_after_submit: 1 });
  seed(env, { phase: 'picking', photographer_id: 'other', archived_at: days(0) });
  seedSubmission(env, sub1, 0); // unnotified
  seedSubmission(env, sub1, 0);
  seedSubmission(env, sub2, 0);
  seedSubmission(env, sub2, 1); // the latest was mailed: nothing pending
  seedSubmission(env, arch, 0); // archived: not a to-do
  seedSubmission(env, other, 0);
  const json = await (await stats(env)).json();
  assert.deepEqual(json.by_phase, { picking: 2, submitted: 2, retouching: 1 });
  assert.equal(json.delivered, 3);
  assert.equal(json.archived, 3);
  assert.deepEqual(json.todo, { submitted_not_retouching: 2, unnotified_submissions: 1, modified_after_submit: 2, unpaid_orders: 0, requested_orders: 0 });
});

test('stats per_month: Asia/Taipei boundaries, last 12 months, created and delivered', async () => {
  const env = setup();
  const thisStart = taipeiMonthStart(0);
  const iso = ms => new Date(ms).toISOString();
  seed(env, { created_at: iso(thisStart) });                   // this month, first instant
  seed(env, { created_at: iso(thisStart - 1) });               // last month, last instant (UTC says this month's day 1 is 16:00 the day before)
  seed(env, { created_at: iso(taipeiMonthStart(11)) });        // oldest bucket
  seed(env, { created_at: iso(taipeiMonthStart(11) - 1) });    // 13 months ago: out
  seed(env, { created_at: iso(taipeiMonthStart(20)), delivered_at: iso(thisStart + 1000), phase: 'retouching' });
  seed(env, { created_at: iso(thisStart), delivered_at: iso(thisStart - 1), phase: 'retouching', archived_at: iso(thisStart) });
  seed(env, { created_at: iso(thisStart), photographer_id: 'other', delivered_at: iso(thisStart) });
  const { per_month } = await (await stats(env)).json();
  assert.equal(per_month.length, 12);
  const by = Object.fromEntries(per_month.map(m => [m.month, m]));
  assert.deepEqual({ ...by[monthKey(thisStart)] }, { month: monthKey(thisStart), created: 2, delivered: 1 });
  assert.deepEqual({ ...by[monthKey(thisStart - 1)] }, { month: monthKey(thisStart - 1), created: 1, delivered: 1 });
  assert.equal(by[monthKey(taipeiMonthStart(11))].created, 1);
  assert.equal(per_month.reduce((n, m) => n + m.created, 0), 4);
  assert.equal(per_month.reduce((n, m) => n + m.delivered, 0), 2);
  // oldest first
  assert.deepEqual(per_month.map(m => m.month), [...per_month.map(m => m.month)].sort());
});

// ─── auth ────────────────────────────────────────────────────────────────────

const ADMIN_ROUTES = id => [
  ['GET', '/api/admin/settings'],
  ['PUT', '/api/admin/settings', { studio_name: 'x' }],
  ['PUT', '/api/admin/settings/logo', PNG],
  ['DELETE', '/api/admin/settings/logo'],
  ['GET', '/api/admin/stats'],
  ['POST', `/api/admin/projects/${id}/deliver`],
  ['POST', `/api/admin/projects/${id}/undeliver`],
];

test('the new admin routes fail closed and refuse every other kind of token', async () => {
  for (const unset of [undefined, '']) {
    const env = setup({ PHOTOGRAPHER_TOKEN: unset });
    for (const [method, path, body] of ADMIN_ROUTES('x')) {
      for (const token of [undefined, '', 'undefined']) {
        assert.equal((await call(env, path, { method, body, token })).status, 401, `${method} ${path} unset`);
      }
    }
  }
  const env = setup();
  const p = await retouching(env);
  for (const [token, kind] of [['CLIENT', 'client'], ['STUDIO', 'studio'], ['SESSION', 'session']]) {
    await seedToken(env, { token, kind, project_id: p.project.id, book_id: kind === 'client' ? 'b1' : '' });
  }
  const before = JSON.stringify([rows(env, 'SELECT * FROM projects'), rows(env, 'SELECT * FROM studio_settings')]);
  for (const [method, path, body] of ADMIN_ROUTES(p.project.id)) {
    for (const token of ['CLIENT', 'STUDIO', 'SESSION', p.token, p.key, `${SECRET}x`]) {
      for (const res of await Promise.all([
        call(env, path, { method, body, token }),
        call(env, `${path}?t=${token}`, { method, body }),
        call(env, path, { method, body, headers: { 'X-Share-Token': token } }),
      ])) assert.equal(res.status, 401, `${method} ${path} ${token}`);
    }
  }
  assert.equal(JSON.stringify([rows(env, 'SELECT * FROM projects'), rows(env, 'SELECT * FROM studio_settings')]), before);
  assert.equal([...env.imagepicker._store.keys()].filter(k => k.startsWith('api/')).length, 0, 'nothing fell through to the upload route');
});

test('the public logo route needs no token and writes nothing', async () => {
  const env = setup();
  await putLogo(env, WEBP);
  const res = await call(env, '/api/studio/logo');
  assert.equal(res.status, 200);
  for (const method of ['PUT', 'POST', 'DELETE']) {
    const r = await call(env, '/api/studio/logo', { method, body: method === 'DELETE' ? undefined : 'x' });
    assert.notEqual(r.status, 200, method);
  }
  assert.equal((await call(env, '/api/studio/logo')).status, 200);
  assert.equal([...env.imagepicker._store.keys()].filter(k => k.startsWith('api/')).length, 0);
});

// ─── the hand-run migration ──────────────────────────────────────────────────

test('the dashboard migration: fresh == archive-era database + it', () => {
  const fresh = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/2026-09-28-dashboard-settings.sql', import.meta.url), 'utf8');
  const statements = migration.replace(/--[^\n]*/g, '').split(';').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
  assert.equal(statements[0], 'ALTER TABLE projects ADD COLUMN delivered_at TEXT');
  assert.match(statements[1], /^CREATE TABLE IF NOT EXISTS studio_settings /);
  assert.equal(statements.length, 2);
  // (the delivery columns appended after delivered_at go too, and come back
  // from their own migration on top, so the column order is pinned)
  const deployed = fresh
    .replace(/,\n(?:\s*--[^\n]*\n)*\s*delivered_at\s+TEXT,\n(?:\s*--[^\n]*\n)*\s*final_folders\s+TEXT,\n\s*allow_proof_download[^\n]*\n(?:\s*--[^\n]*\n)*\s*extra_max\s+INTEGER,\n(?:\s*--[^\n]*\n)*\s*client_confirmed_at\s+TEXT,\n(?:\s*--[^\n]*\n)*\s*client_confirmed_by\s+TEXT,\n(?:\s*--[^\n]*\n)*\s*shoot_date\s+TEXT,\n(?:\s*--[^\n]*\n)*\s*project_type\s+TEXT\n\);/, '\n);')
    .replace(/\n-- ─── Studio settings[\s\S]*$/, '\n');
  assert.doesNotMatch(deployed, /delivered_at|studio_settings|final_folders|extra_max/, 'fixture still has the new schema');
  const later = readFileSync(new URL('../migrations/2026-09-30-delivery.sql', import.meta.url), 'utf8') +
    '\n' + readFileSync(new URL('../migrations/2026-09-30-extra-max.sql', import.meta.url), 'utf8') +
    '\n' + readFileSync(new URL('../migrations/2026-10-04-client-confirm.sql', import.meta.url), 'utf8') +
    '\n' + readFileSync(new URL('../migrations/2026-10-07-project-shoot-date.sql', import.meta.url), 'utf8') +
    '\n' + readFileSync(new URL('../migrations/2026-10-07-project-type.sql', import.meta.url), 'utf8') +
    // (studio_settings.transfer_info, S2 guest ordering: the one statement of that file on this table)
    '\n' + readFileSync(new URL('../migrations/2026-10-09-guest-orders.sql', import.meta.url), 'utf8').match(/ALTER TABLE studio_settings[^;]*;/)[0];
  const shape = db => ['projects', 'studio_settings'].map(t => db._db.prepare(`PRAGMA table_info(${t})`).all());
  assert.deepEqual(shape(fakeDB({ schema: deployed + '\n' + migration + '\n' + later })), shape(fakeDB({ schema: fresh })));
  assert.match(fresh, /ALTER TABLE projects ADD COLUMN delivered_at TEXT;/, 'schema.sql names the hand-run ALTER');
  // the CREATE is safe to paste twice
  const twice = fakeDB({ schema: deployed + '\n' + migration + '\n' + later });
  twice._db.exec(migration.replace(/ALTER TABLE[^;]*;/, ''));
});

test('a reopen landing between deliver\'s write and its read is a 409, not ok with a null stamp', async () => {
  const env = setup();
  const p = await retouching(env);
  const prepare = env.DB.prepare.bind(env.DB);
  let done = false;
  env.DB.prepare = s => {
    if (!done && /^SELECT phase, delivered_at FROM projects/.test(s)) {
      done = true;
      env.DB._db.prepare("UPDATE projects SET phase = 'picking', delivered_at = NULL").run();
    }
    return prepare(s);
  };
  const res = await deliver(env, p.project.id);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'not_retouching');
  assert.match(res.headers.get('Cache-Control') || '', /no-store/);
});

test('a refused deliver is not cached either', async () => {
  const env = setup();
  const p = await claimed(env);
  const res = await admin(env, p.project.id, 'deliver');
  assert.equal(res.status, 409);
  assert.match(res.headers.get('Cache-Control') || '', /no-store/);
});
