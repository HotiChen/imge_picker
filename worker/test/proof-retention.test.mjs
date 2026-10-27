// Proof retention (docs/delivery.md, "Proof retention"): the Worker deletes a
// project's PROOFS (projects.folders, and their `_thumbs/<w>/…` thumbnails)
// N days after the client confirmed the delivery. Finals are never deleted;
// D1 keeps every row. N = projects.proof_retention_days (NULL = the studio's,
// 0 = never, 14..3650) else studio_settings.proof_retention_days (0 / 90 /
// 180 / 365; NULL = 0). Default 0: nothing is ever deleted until the
// photographer chooses a number.
//
// High tier: an irreversible R2 delete, a scheduled job, a permission. Every
// safety check has a negative test here; the positive ones prove the delete
// really happens (and only to what it should).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { fakeBucket, ctx } from './fakes.mjs';
import {
  setup as baseSetup, admin, deliver, delivered, retouching, OBJECTS, FRESH, landOnce,
  PROOF, FINAL, FINAL2, PA, PB, F1, F2, F3, G1, SECRET, call, pick, one, rows,
} from './revision-helpers.mjs';
import { twoTenants, ROUTES_ON } from './tenant-helpers.mjs';

const SRC = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const DAY = 86400000;
const NOPE = '00000000-0000-4000-8000-000000000000';
const iso = ms => new Date(ms).toISOString();

// ─── fixtures ─────────────────────────────────────────────────────────────
const PC = 'shoot/毛片/sub/c.jpg';
const NEIGH = 'shoot/毛片-other/x.jpg';          // a neighbour folder that only shares the prefix text
const DOTS = 'shoot/毛片/../精修/f9.jpg';         // a literal R2 key with a `..` segment
const NOTE = 'shoot/毛片/notes.txt';             // not a photo upload
const PROOF_ORIGINALS = [PA, PB, PC];
const PROOF_THUMBS = [
  `_thumbs/400/${PA}.thumb`, `_thumbs/1200/${PA}.thumb`, `_thumbs/800/${PA}.thumb`,
  `_thumbs/400/${PB}.thumb`, `_thumbs/400/${PC}.thumb`, `_thumbs/1600/${PC}.thumb`,
];
const WORLD = {
  ...OBJECTS,
  [PC]: 'PC-ORIG', [`_thumbs/400/${PC}.thumb`]: 'PC-T400', [`_thumbs/1600/${PC}.thumb`]: 'PC-T1600',
  [`_thumbs/800/${PA}.thumb`]: 'PA-T800',                  // an older upload page's width
  [NEIGH]: 'NEIGH', [`_thumbs/400/${NEIGH}.thumb`]: 'NEIGH-T',
  [DOTS]: 'DOTS', [`_thumbs/400/${DOTS}.thumb`]: 'DOTS-T',
  [NOTE]: 'NOTE',
};
const KEPT = Object.keys(WORLD).filter(k => !PROOF_ORIGINALS.includes(k) && !PROOF_THUMBS.includes(k));

const setup = (o = {}) => baseSetup({ objects: WORLD, ...o });
const settings = (env, body, token = SECRET) => call(env, '/api/admin/settings', { method: 'PUT', token, body });
const retention = (env, id, body, token = SECRET) => call(env, `/api/admin/projects/${id}/proofs-retention`, { method: 'POST', token, body });
const detail = async (env, id, token = SECRET) => (await call(env, `/api/admin/projects/${id}`, { token })).json();
const info = async (env, id, token) => (await detail(env, id, token)).project.proof_retention;
const cron = (env, at) => worker.scheduled({ scheduledTime: at, cron: '17 19 * * *' }, env, ctx);
const events = (env, kind) => rows(env, 'SELECT * FROM project_events WHERE kind = ? ORDER BY id', kind)
  .map(r => ({ ...r, data: r.data == null ? null : JSON.parse(r.data) }));
const has = (env, k) => env.imagepicker._store.has(k);
const confirmedAt = env => Date.parse(one(env, 'SELECT client_confirmed_at FROM projects').client_confirmed_at);
// the D1 tables a proof delete must leave exactly as they were
const keptRows = env => JSON.stringify(['selections', 'submissions', 'pickers', 'share_tokens', 'revision_requests', 'orders', 'order_items']
  .map(t => rows(env, `SELECT * FROM ${t} ORDER BY rowid`)));

// delivered + confirmed by the photographer (client_confirmed_at = now)
async function confirmed(env, finals, body) {
  const p = await delivered(env, finals, body);
  assert.equal((await admin(env, p.id, 'confirm')).status, 200);
  return p;
}
// the studio default, through the real route
async function studio(env, days, token = SECRET) {
  const res = await settings(env, { proof_retention_days: days }, token);
  assert.equal(res.status, 200, await res.clone().text());
}
// every subrequest (D1 statement, D1 batch, R2 call) a cron run makes
function countCalls(env) {
  const calls = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    const st = prepare(sql);
    const wrap = s => ({
      first: (...a) => { calls.push(`d1 ${sql.slice(0, 40)}`); return s.first(...a); },
      all: (...a) => { calls.push(`d1 ${sql.slice(0, 40)}`); return s.all(...a); },
      run: (...a) => { calls.push(`d1 ${sql.slice(0, 40)}`); return s.run(...a); },
    });
    return { ...wrap(st), bind: (...a) => ({ ...wrap(st.bind(...a)), _inner: st.bind(...a) }) };
  };
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = list => { calls.push('d1 batch'); return batch(list.map(s => s._inner || s)); };
  for (const m of ['get', 'head', 'put', 'delete', 'list']) {
    const f = env.imagepicker[m].bind(env.imagepicker);
    env.imagepicker[m] = (...a) => { calls.push(`r2 ${m}`); return f(...a); };
  }
  return calls;
}

// ─── the delete itself ────────────────────────────────────────────────────

test('due: studio 90 days — every proof original and thumbnail goes; finals, neighbours, books and D1 rows stay; stamped and logged', async () => {
  const env = setup();
  await studio(env, 90);
  const p = await confirmed(env);
  const before = keptRows(env);
  const at = confirmedAt(env) + 90 * DAY;
  await cron(env, at);
  for (const k of [...PROOF_ORIGINALS, ...PROOF_THUMBS]) assert.ok(!has(env, k), `still there: ${k}`);
  for (const k of KEPT) assert.ok(has(env, k), `deleted by mistake: ${k}`);
  assert.equal(keptRows(env), before, 'D1 rows untouched');
  const row = one(env, 'SELECT * FROM projects');
  assert.equal(row.proofs_deleted_at, iso(at));
  assert.ok(row.delivered_at && row.client_confirmed_at && row.final_folders, 'the delivery itself is untouched');
  const done = events(env, 'proofs_deleted');
  assert.equal(done.length, 1);
  assert.deepEqual(done[0].data, { folders: [PROOF], originals: 3, thumbs: 6 });
  assert.equal(done[0].project_id, p.id);
  assert.equal(done[0].actor, 'system');
  // the summary was written BEFORE the delete, and names no file
  const planned = events(env, 'proofs_delete_planned');
  assert.equal(planned.length, 1);
  assert.deepEqual(planned[0].data, { folders: [PROOF], originals: 3, thumbs: 6, complete: true });
  assert.ok(planned[0].id < done[0].id);
  assert.doesNotMatch(JSON.stringify(rows(env, 'SELECT data FROM project_events')), /\.jpg|_thumbs/);
  // R2 was only ever asked to delete proof keys
  assert.deepEqual([...env.imagepicker._deletes].sort(), [...PROOF_ORIGINALS, ...PROOF_THUMBS].sort());
});

test('due: a second run after the delete does nothing (no list, no delete, no event)', async () => {
  const env = setup();
  await studio(env, 90);
  await confirmed(env);
  const at = confirmedAt(env) + 90 * DAY;
  await cron(env, at);
  const n = rows(env, 'SELECT * FROM project_events').length;
  const calls = countCalls(env);
  await cron(env, at + 400 * DAY);
  assert.deepEqual(calls.filter(c => c.startsWith('r2')), []);
  assert.equal(rows(env, 'SELECT * FROM project_events').length, n);
});

test('after the delete: the guest\'s proof reads are a plain 404 / an empty list; the finals still serve', async () => {
  const env = setup();
  await studio(env, 90);
  const p = await confirmed(env);
  env.DB._db.prepare('UPDATE projects SET allow_proof_download = 1').run();
  await cron(env, confirmedAt(env) + 90 * DAY);
  const read = (k, key) => call(env, `/${k.split('/').map(encodeURIComponent).join('/')}?t=${encodeURIComponent(p.token)}`, { key });
  assert.equal((await read(PA, p.key)).status, 404);
  assert.equal((await read(`_thumbs/400/${PA}.thumb`, p.key)).status, 404);
  assert.equal((await read(F1, p.key)).status, 200);
  const listed = await call(env, `/?list=${encodeURIComponent(PROOF)}&t=${encodeURIComponent(p.token)}`, { key: p.key });
  assert.equal(listed.status, 200);
  assert.doesNotMatch(await listed.text(), /a\.jpg|b\.jpg/);
});

test('timing: one millisecond before confirmed + N days nothing happens; at it, the delete runs', async () => {
  const env = setup();
  await studio(env, 90);
  await confirmed(env);
  const due = confirmedAt(env) + 90 * DAY;
  await cron(env, due - 1);
  assert.deepEqual(env.imagepicker._deletes, []);
  assert.equal(one(env, 'SELECT proofs_deleted_at FROM projects').proofs_deleted_at, null);
  assert.equal(rows(env, 'SELECT * FROM project_events WHERE kind LIKE \'proofs%\'').length, 0);
  await cron(env, due);
  assert.ok(!has(env, PA));
});

test('a project override: 30 days with the studio at 0 — deleted at 30 days, not before', async () => {
  const env = setup();
  const p = await confirmed(env);
  assert.equal((await retention(env, p.id, { days: 30 })).status, 200);
  await cron(env, confirmedAt(env) + 29 * DAY);
  assert.ok(has(env, PA));
  await cron(env, confirmedAt(env) + 30 * DAY);
  assert.ok(!has(env, PA));
});

test('the delete is idempotent and resumable: an R2 failure mid-way leaves the rest for the next run, which finishes', async () => {
  const env = setup();
  env.imagepicker = fakeBucket(WORLD, { pageSize: 2 });
  await studio(env, 90);
  await confirmed(env);
  const at = confirmedAt(env) + 90 * DAY;
  // the first delete call throws
  const del = env.imagepicker.delete.bind(env.imagepicker);
  let fail = true;
  env.imagepicker.delete = keys => { if (fail) { fail = false; throw new Error('R2 down'); } return del(keys); };
  await cron(env, at);
  assert.equal(one(env, 'SELECT proofs_deleted_at FROM projects').proofs_deleted_at, null, 'not stamped while anything is left');
  for (const k of KEPT) assert.ok(has(env, k), k);
  // the lease has to run out: the same day it is not retried
  await cron(env, at + 60000);
  assert.equal(one(env, 'SELECT proofs_deleted_at FROM projects').proofs_deleted_at, null);
  await cron(env, at + DAY);
  for (const k of [...PROOF_ORIGINALS, ...PROOF_THUMBS]) assert.ok(!has(env, k), k);
  for (const k of KEPT) assert.ok(has(env, k), k);
  assert.equal(one(env, 'SELECT proofs_deleted_at FROM projects').proofs_deleted_at, iso(at + DAY));
  assert.deepEqual(events(env, 'proofs_deleted').map(e => e.data), [{ folders: [PROOF], originals: 3, thumbs: 6 }], 'the failed run is not counted');
});

test('budget: a run makes at most 45 subrequests; a big folder takes several daily runs and the totals add up', async () => {
  const env = setup();
  const objects = { ...WORLD };
  for (let i = 0; i < 1500; i++) {
    const k = `${PROOF}big/${String(i).padStart(4, '0')}.jpg`;
    objects[k] = 'X';
    objects[`_thumbs/400/${k}.thumb`] = 'T';
    objects[`_thumbs/1200/${k}.thumb`] = 'T';
  }
  env.imagepicker = fakeBucket(objects, { pageSize: 100 });
  await studio(env, 90);
  await confirmed(env);
  let at = confirmedAt(env) + 90 * DAY;
  let runs = 0;
  while (one(env, 'SELECT proofs_deleted_at FROM projects').proofs_deleted_at === null) {
    const calls = countCalls(env);
    await cron(env, at);
    assert.ok(calls.length <= 45, `run ${runs + 1}: ${calls.length} subrequests`);
    assert.ok(calls.length > 0);
    runs++;
    at += DAY;
    assert.ok(runs < 20, 'never finished');
  }
  assert.ok(runs > 1, 'the folder needs more than one run at this page size');
  for (const k of KEPT) assert.ok(env.imagepicker._store.has(k), k);
  assert.equal([...env.imagepicker._store.keys()].filter(k => k.includes('毛片/big/')).length, 0);
  const done = events(env, 'proofs_deleted');
  assert.deepEqual(done.map(e => e.data), [{ folders: [PROOF], originals: 1503, thumbs: 3006 }]);
});

test('parallel runs: two crons at once delete each key, stamp once and count once', async () => {
  const env = setup();
  await studio(env, 90);
  await confirmed(env);
  const at = confirmedAt(env) + 90 * DAY;
  await Promise.all([cron(env, at), cron(env, at)]);
  for (const k of [...PROOF_ORIGINALS, ...PROOF_THUMBS]) assert.ok(!has(env, k), k);
  for (const k of KEPT) assert.ok(has(env, k), k);
  assert.equal(events(env, 'proofs_deleted').length, 1);
  assert.equal(events(env, 'proofs_delete_planned').length, 1);
  assert.deepEqual(events(env, 'proofs_deleted')[0].data, { folders: [PROOF], originals: 3, thumbs: 6 });
});

test('the last check: 不要刪 landing between the listing and the delete stops it (nothing deleted)', async () => {
  const env = setup();
  await studio(env, 90);
  await confirmed(env);
  // right before the re-check statement, the photographer presses 不要刪
  landOnce(env, /UPDATE projects SET proofs_delete_next_at = \?[\s\S]*folders = \?/, 'UPDATE projects SET proof_retention_days = 0');
  await cron(env, confirmedAt(env) + 90 * DAY);
  assert.deepEqual(env.imagepicker._deletes, []);
  assert.equal(one(env, 'SELECT proofs_deleted_at FROM projects').proofs_deleted_at, null);
});

test('the summary must land first: when the event cannot be written, nothing is deleted', async () => {
  const env = setup();
  await studio(env, 90);
  await confirmed(env);
  env.DB._db.exec('DROP TABLE project_events');
  await cron(env, confirmedAt(env) + 90 * DAY);
  assert.deepEqual(env.imagepicker._deletes, []);
  assert.equal(one(env, 'SELECT proofs_deleted_at FROM projects').proofs_deleted_at, null);
});

// ─── never deleted ────────────────────────────────────────────────────────

test('default 0: with no setting at all, ten years after the confirmation nothing is listed, deleted or logged', async () => {
  const env = setup();
  await confirmed(env);
  const calls = countCalls(env);
  await cron(env, Date.now() + 3650 * DAY);
  assert.deepEqual(calls.filter(c => c.startsWith('r2')), []);
  assert.deepEqual(env.imagepicker._deletes, []);
  assert.equal(rows(env, "SELECT * FROM project_events WHERE kind LIKE 'proofs%'").length, 0);
  // studio set, project 0 (never): the same
  await studio(env, 90);
  const id = one(env, 'SELECT id FROM projects').id;
  assert.equal((await retention(env, id, { action: 'never' })).status, 200);
  await cron(env, Date.now() + 3650 * DAY);
  assert.deepEqual(env.imagepicker._deletes, []);
});

test('a number edited by hand that the routes never store (studio 30, project 5000 or -1) reads as 0: never deleted', async () => {
  for (const [table, value] of [['studio_settings', 30], ['studio_settings', 1], ['projects', 5000], ['projects', -1]]) {
    const env = setup();
    const p = await confirmed(env);
    if (table === 'studio_settings') env.DB._db.prepare("INSERT INTO studio_settings (photographer_id, proof_retention_days) VALUES ('default', ?)").run(value);
    else env.DB._db.prepare('UPDATE projects SET proof_retention_days = ?').run(value);
    await cron(env, Date.now() + 9000 * DAY);
    assert.deepEqual(env.imagepicker._deletes, [], `${table} ${value}`);
    assert.equal((await info(env, p.id)).days, 0, `${table} ${value}`);
  }
});

test('not confirmed: delivered (or only picking / retouching) is never deleted, however long', async () => {
  for (const stage of ['picking', 'retouching', 'delivered']) {
    const env = setup();
    await studio(env, 90);
    if (stage === 'delivered') await delivered(env);
    else if (stage === 'retouching') await retouching(env);
    else await call(env, '/api/admin/projects', { method: 'POST', token: SECRET, body: { title: 't', folders: [PROOF] } });
    await cron(env, Date.now() + 3650 * DAY);
    assert.deepEqual(env.imagepicker._deletes, [], stage);
  }
});

test('取消交件 and 開放修改 after the confirmation cancel the schedule (confirmation cleared)', async () => {
  for (const action of ['undeliver', 'reopen']) {
    const env = setup();
    await studio(env, 90);
    const p = await confirmed(env);
    const at = confirmedAt(env) + 90 * DAY;
    assert.equal((await admin(env, p.id, action)).status, 200, action);
    await cron(env, at + 3650 * DAY);
    assert.deepEqual(env.imagepicker._deletes, [], action);
    assert.equal((await info(env, p.id)).proofs_delete_at, null, action);
  }
});

test('a delivered_at cleared by hand (finals snapshot kept, confirmation left by hand) is not deleted', async () => {
  const env = setup();
  await studio(env, 90);
  await confirmed(env);
  env.DB._db.prepare('UPDATE projects SET delivered_at = NULL').run();
  await cron(env, Date.now() + 3650 * DAY);
  assert.deepEqual(env.imagepicker._deletes, []);
});

// ─── finals and shared folders: skipped, logged, never deleted ────────────

async function skipped(env, reason, { expectNone = true } = {}) {
  const at = confirmedAt(env) + 90 * DAY;
  await cron(env, at);
  if (expectNone) assert.deepEqual(env.imagepicker._deletes, [], reason);
  assert.equal(one(env, 'SELECT proofs_deleted_at FROM projects ORDER BY created_at LIMIT 1').proofs_deleted_at, null, reason);
  const ev = events(env, 'proofs_delete_skipped');
  assert.equal(ev.length, 1, reason);
  assert.equal(ev[0].data.reason, reason);
  assert.equal(ev[0].actor, 'system');
  return at;
}

test('finals inside, equal to or around the proofs (edited by hand) — skipped as finals_overlap', async () => {
  for (const finals of [[PROOF], ['shoot/毛片/sub/'], ['shoot/'], [FINAL, PROOF]]) {
    const env = setup();
    await studio(env, 90);
    await confirmed(env);
    env.DB._db.prepare('UPDATE projects SET final_folders = ?').run(JSON.stringify(finals));
    await skipped(env, 'finals_overlap');
    for (const k of Object.keys(WORLD)) assert.ok(has(env, k), `${finals}: ${k}`);
  }
});

test('proofs around the finals (folders ["shoot/"] and finals shoot/精修/) — skipped (a top-level folder), the finals untouched', async () => {
  const env = setup();
  await studio(env, 90);
  await confirmed(env);
  env.DB._db.prepare('UPDATE projects SET folders = ?').run(JSON.stringify(['shoot/']));
  await skipped(env, 'top_level_folder');
  for (const k of [F1, F2, F3, `_thumbs/400/${F1}.thumb`]) assert.ok(has(env, k));
});

test('an earlier round\'s frozen finals snapshot overlapping the proofs — skipped as finals_overlap', async () => {
  const env = setup();
  await studio(env, 90);
  const p = await confirmed(env);
  env.DB._db.prepare("INSERT INTO revision_requests (id, project_id, message, created_at, resolved_at, finals) VALUES ('r1', ?, 'x', ?, ?, ?)")
    .run(p.id, iso(Date.now()), iso(Date.now()), JSON.stringify([PROOF]));
  await skipped(env, 'finals_overlap');
});

test('a folder shared with another project of the same photographer (its proofs or its finals, either direction) — skipped', async () => {
  for (const [col, value] of [['folders', [PROOF]], ['folders', ['shoot/']], ['folders', ['shoot/毛片/sub/']], ['final_folders', [PROOF]]]) {
    const env = setup();
    await studio(env, 90);
    await confirmed(env);
    const res = await call(env, '/api/admin/projects', { method: 'POST', token: SECRET, body: { title: '另一案', folders: ['elsewhere/'] } });
    const other = (await res.json()).project.id;
    env.DB._db.prepare(`UPDATE projects SET ${col} = ? WHERE id = ?`).run(JSON.stringify(value), other);
    await skipped(env, 'shared_with_project');
  }
});

test('another project\'s submission naming one of these proofs — skipped', async () => {
  const env = setup();
  await studio(env, 90);
  await confirmed(env);
  const res = await call(env, '/api/admin/projects', { method: 'POST', token: SECRET, body: { title: '另一案', folders: ['elsewhere/'] } });
  const other = (await res.json()).project.id;
  env.DB._db.prepare("INSERT INTO submissions (id, project_id, picker_id, relationship, photo_keys, count, created_at) VALUES ('s9', ?, 'x', '本人', ?, 1, ?)")
    .run(other, JSON.stringify([PA]), iso(Date.now()));
  await skipped(env, 'shared_with_project');
});

test('a live link of any kind covering the folder (album link, client session, another project\'s pick link) — skipped; a revoked or expired one does not count', async () => {
  for (const [kind, folders, live] of [['client', ['shoot/'], true], ['session', [PROOF], true], ['client', [PROOF], false], ['session', ['shoot/毛片'], 'expired']]) {
    const env = setup();
    await studio(env, 90);
    await confirmed(env);
    const now = Date.now();
    env.DB._db.prepare('INSERT INTO share_tokens (token, book_id, kind, folders, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`tok-${kind}`, 'b1', kind, JSON.stringify(folders), iso(now), iso(now + (live === 'expired' ? 1000 : 3650 * DAY)), live === false ? iso(now) : null);
    if (live === true) {
      await skipped(env, 'shared_with_link');
    } else {
      // revoked: counts as nothing. expired: dead by the time the cron runs.
      await cron(env, confirmedAt(env) + 90 * DAY);
      assert.ok(!has(env, PA), `${kind} ${live}`);
    }
  }
});

test('a client account whose folder covers the proofs (legacy accounts) — skipped', async () => {
  const env = setup();
  await studio(env, 90);
  await confirmed(env);
  env.DB._db.prepare("INSERT INTO users (email, password_hash, name, folder_path, approved) VALUES ('c@x.tw', 'x', '客', 'shoot', 1)").run();
  await skipped(env, 'shared_with_client_account');
});

test('an album naming a photo under the proofs — skipped as in_album; more albums than can be read — albums_unchecked', async () => {
  {
    const env = setup({ objects: { ...WORLD, '_books/b2.json': JSON.stringify({ pages: [{ slots: [{ photoId: PB }] }] }) } });
    await studio(env, 90);
    await confirmed(env);
    await skipped(env, 'in_album');
  }
  {
    const many = { ...WORLD };
    for (let i = 0; i < 26; i++) many[`_books/x${i}.json`] = JSON.stringify({ pages: [] });
    const env = setup({ objects: many });
    await studio(env, 90);
    await confirmed(env);
    await skipped(env, 'albums_unchecked');
  }
});

test('an order line naming one of the proofs (any status) — skipped as in_order', async () => {
  const env = setup();
  await studio(env, 90);
  const p = await confirmed(env);
  const now = iso(Date.now());
  env.DB._db.prepare("INSERT INTO orders (id, photographer_id, project_id, source, status, created_at, updated_at) VALUES ('o1', 'default', ?, 'admin', 'cancelled', ?, ?)").run(p.id, now, now);
  env.DB._db.prepare("INSERT INTO order_items (id, order_id, kind, name, unit_price, qty, photo_keys) VALUES ('i1', 'o1', 'print', '6x4', 10, 1, ?)").run(JSON.stringify([PA]));
  await skipped(env, 'in_order');
});

// a guest album line whose Layout JSON v2 names `key` (S3); a hand-made row: a
// guest layout can only name finals, so a proof in one is a hand edit, but the
// rule is the photo lock's (layoutNaming)
function layoutOrder(env, projectId, key, status) {
  const now = iso(Date.now());
  const layout = { v: 2, mode: 'auto', cover: null, spreads: [{ template: 'hero-bleed', slots: [{ photo_key: key, fit: 'contain', crop: { x: 0, y: 0, scale: 1 } }] }], back: null };
  env.DB._db.prepare("INSERT INTO orders (id, photographer_id, project_id, source, status, created_at, updated_at) VALUES ('o2', 'default', ?, 'guest', ?, ?, ?)").run(projectId, status, now, now);
  env.DB._db.prepare("INSERT INTO order_items (id, order_id, kind, name, unit_price, qty, photo_keys, layout) VALUES ('i2', 'o2', 'album', '相本', 10, 1, '[]', ?)").run(JSON.stringify(layout));
}
test('a guest layout (v2) naming one of the proofs on an order not cancelled — skipped as in_order; cancelled, the proofs go', async () => {
  for (const status of ['requested', 'confirmed', 'fulfilled']) {
    const env = setup();
    await studio(env, 90);
    const p = await confirmed(env);
    layoutOrder(env, p.id, PA, status);
    await skipped(env, 'in_order');
  }
  const env = setup();
  await studio(env, 90);
  const p = await confirmed(env);
  layoutOrder(env, p.id, PA, 'cancelled');
  await cron(env, confirmedAt(env) + 90 * DAY);
  assert.ok(!has(env, PA), 'a cancelled order\'s layout holds nothing');
});

test('a guest layout (v2) holds the proofs only by a key under them, not by a folder name its text contains (the forged `<finals>/x/shoot/毛片/y.jpg`)', async () => {
  const env = setup();
  await studio(env, 90);
  const p = await confirmed(env);
  layoutOrder(env, p.id, `${FINAL}x/${PA}`, 'requested');
  await cron(env, confirmedAt(env) + 90 * DAY);
  assert.ok(!has(env, PA), 'C: the proofs go');
  assert.equal(events(env, 'proofs_delete_skipped').length, 0);
});

test('a guest layout that does not parse holds the proofs by its text (fail closed)', async () => {
  const env = setup();
  await studio(env, 90);
  const p = await confirmed(env);
  const now = iso(Date.now());
  env.DB._db.prepare("INSERT INTO orders (id, photographer_id, project_id, source, status, created_at, updated_at) VALUES ('o3', 'default', ?, 'guest', 'requested', ?, ?)").run(p.id, now, now);
  env.DB._db.prepare("INSERT INTO order_items (id, order_id, kind, name, unit_price, qty, photo_keys, layout) VALUES ('i3', 'o3', 'album', '相本', 10, 1, '[]', ?)").run(`{"v":2,"x":"${PA}"`);
  await skipped(env, 'in_order');
});

test('a skip waits 7 days before the next check (not re-logged every day), and a cleared reason then lets the delete run', async () => {
  const env = setup();
  await studio(env, 90);
  await confirmed(env);
  env.DB._db.prepare("INSERT INTO users (email, password_hash, name, folder_path, approved) VALUES ('c@x.tw', 'x', '客', 'shoot', 1)").run();
  const at = await skipped(env, 'shared_with_client_account');
  const calls = countCalls(env);
  await cron(env, at + 6 * DAY);
  assert.deepEqual(calls.filter(c => c.startsWith('r2')), []);
  assert.equal(events(env, 'proofs_delete_skipped').length, 1);
  env.DB._db.prepare('DELETE FROM users').run();
  await cron(env, at + 7 * DAY);
  assert.ok(!has(env, PA));
  assert.equal(events(env, 'proofs_deleted').length, 1);
});

test('only keys a photo upload could be, inside the folder: a `..` key, a non-photo, a neighbour folder are never deleted', async () => {
  const env = setup();
  await studio(env, 90);
  await confirmed(env);
  await cron(env, confirmedAt(env) + 90 * DAY);
  for (const k of [DOTS, `_thumbs/400/${DOTS}.thumb`, NOTE, NEIGH, `_thumbs/400/${NEIGH}.thumb`]) assert.ok(has(env, k), k);
  assert.ok(!has(env, PA), 'positive control');
});

// ─── tenants ──────────────────────────────────────────────────────────────

test('another photographer: B\'s due project deletes only under _t/B/; the default\'s same logical keys (and A\'s own undue project) stay', async () => {
  const env = setup({ extra: ROUTES_ON });
  const { B } = await twoTenants(env);
  await studio(env, 90, B.token);
  // A (default): delivered + confirmed, studio 0 — never due
  const a = await confirmed(env);
  // B's project on the same logical folders, with B's own copies
  const b = await confirmed(env);
  env.DB._db.prepare('UPDATE projects SET photographer_id = ? WHERE id = ?').run(B.id, b.id);
  for (const k of [PA, PB, `_thumbs/400/${PA}.thumb`, F1]) env.imagepicker._store.set(`_t/${B.id}/${k}`, { key: k, body: 'B', contentType: 'image/jpeg', uploaded: new Date(Date.now() - DAY) });
  // A's project also covers the same logical folder: other photographers' rows never count against B
  const bConfirmed = Date.parse(one(env, 'SELECT client_confirmed_at FROM projects WHERE id = ?', b.id).client_confirmed_at);
  await cron(env, bConfirmed + 90 * DAY);
  assert.ok(!has(env, `_t/${B.id}/${PA}`));
  assert.ok(!has(env, `_t/${B.id}/${PB}`));
  assert.ok(!has(env, `_t/${B.id}/_thumbs/400/${PA}.thumb`));
  assert.ok(has(env, `_t/${B.id}/${F1}`), 'B\'s finals');
  for (const k of Object.keys(WORLD)) assert.ok(has(env, k), `the default's ${k}`);
  assert.ok(env.imagepicker._deletes.every(k => k.startsWith(`_t/${B.id}/`)), env.imagepicker._deletes.join());
  assert.notEqual(one(env, 'SELECT proofs_deleted_at FROM projects WHERE id = ?', b.id).proofs_deleted_at, null);
  assert.equal(one(env, 'SELECT proofs_deleted_at FROM projects WHERE id = ?', a.id).proofs_deleted_at, null);
});

test('settings belong to their photographer: B cannot read or change A\'s project retention (404, nothing written), and A\'s studio is not B\'s', async () => {
  const env = setup({ extra: ROUTES_ON });
  const { B } = await twoTenants(env);
  const a = await confirmed(env);
  const before = JSON.stringify(rows(env, 'SELECT * FROM projects'));
  for (const body of [{ days: 0 }, { days: 30 }, { action: 'postpone' }, { action: 'never' }]) {
    const res = await retention(env, a.id, body, B.token);
    const none = await retention(env, NOPE, body, B.token);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), await none.text());
  }
  assert.equal(JSON.stringify(rows(env, 'SELECT * FROM projects')), before);
  await studio(env, 365, B.token);
  assert.equal((await info(env, a.id)).studio_days, 0, 'A\'s default is still 0');
  await cron(env, Date.now() + 3650 * DAY);
  assert.deepEqual(env.imagepicker._deletes, []);
});

// ─── the settings routes ──────────────────────────────────────────────────

test('studio setting: only 0 / 90 / 180 / 365 (or null = 0); anything else 400 and nothing stored', async () => {
  const env = setup();
  for (const v of [0, 90, 180, 365, null]) {
    const res = await settings(env, { proof_retention_days: v });
    assert.equal(res.status, 200, String(v));
    assert.equal((await res.json()).proof_retention_days, v ?? 0);
  }
  await studio(env, 180);
  for (const v of [30, 91, 1, -90, 90.5, '90', true, [90], {}, 3650]) {
    const res = await settings(env, { proof_retention_days: v });
    assert.equal(res.status, 400, JSON.stringify(v));
    assert.equal((await res.json()).code, 'invalid_proof_retention_days');
  }
  assert.equal(one(env, 'SELECT proof_retention_days FROM studio_settings').proof_retention_days, 180);
  assert.equal((await (await call(env, '/api/admin/settings', { token: SECRET })).json()).proof_retention_days, 180);
});

test('project setting: {days: null | 0 | 14..3650} or {action: postpone | never}; anything else 400, nothing written', async () => {
  const env = setup();
  const p = await confirmed(env);
  for (const [body, stored] of [[{ days: 14 }, 14], [{ days: 3650 }, 3650], [{ days: 0 }, 0], [{ days: null }, null], [{ action: 'never' }, 0]]) {
    const res = await retention(env, p.id, body);
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(one(env, 'SELECT proof_retention_days FROM projects').proof_retention_days, stored, JSON.stringify(body));
  }
  const before = JSON.stringify(rows(env, 'SELECT * FROM projects'));
  for (const body of [{ days: 13 }, { days: 1 }, { days: 3651 }, { days: -1 }, { days: 30.5 }, { days: '30' }, { days: true },
    { action: 'later' }, { action: 'postpone', days: 30 }, {}, null, [], { days: 30, folders: ['x/'] }, { key: PA }]) {
    const res = await retention(env, p.id, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).code, 'invalid_body');
  }
  assert.equal(JSON.stringify(rows(env, 'SELECT * FROM projects')), before);
  for (const method of ['GET', 'PUT', 'DELETE']) {
    assert.equal((await call(env, `/api/admin/projects/${p.id}/proofs-retention`, { method, token: SECRET })).status, 405, method);
  }
  assert.equal((await call(env, `/api/admin/projects/${p.id}/proofs-retention`, { method: 'POST', body: { days: 0 } })).status, 401);
  assert.equal((await retention(env, p.id, { days: 0 }, p.token)).status, 401);
});

test('postpone: the effective days + 30 into the override (studio 90 → 120), at least 30 days from now; logged', async () => {
  const env = setup();
  await studio(env, 90);
  const p = await confirmed(env);
  const res = await retention(env, p.id, { action: 'postpone' });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.proof_retention.days, 120);
  assert.equal(out.proof_retention.source, 'project');
  assert.equal(one(env, 'SELECT proof_retention_days FROM projects').proof_retention_days, 120);
  const ev = events(env, 'proof_retention_set');
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0].data, { action: 'postpone', days: 120, previous: null });
  assert.equal(ev[0].actor, 'photographer');
  await cron(env, confirmedAt(env) + 119 * DAY);
  assert.ok(has(env, PA));
  await cron(env, confirmedAt(env) + 120 * DAY);
  assert.ok(!has(env, PA));
});

test('postpone of an overdue project counts from now: at least 30 days from the press', async () => {
  const env = setup();
  await studio(env, 90);
  const p = await confirmed(env);
  // confirmed 200 days ago; skipped so far (say a shared folder), so not yet deleted
  const longAgo = Date.now() - 200 * DAY;
  env.DB._db.prepare('UPDATE projects SET client_confirmed_at = ?').run(iso(longAgo));
  const pressed = Date.now();
  assert.equal((await retention(env, p.id, { action: 'postpone' })).status, 200);
  const i = await info(env, p.id);
  assert.ok(Date.parse(i.proofs_delete_at) >= pressed + 30 * DAY, i.proofs_delete_at);
  await cron(env, pressed + 29 * DAY);
  assert.ok(has(env, PA));
  await cron(env, Date.now() + 31 * DAY);
  assert.ok(!has(env, PA));
});

test('postpone with nothing scheduled (effective 0) is 409 proofs_not_scheduled and writes nothing; past 3650 days 409 too', async () => {
  const env = setup();
  const p = await confirmed(env);
  let res = await retention(env, p.id, { action: 'postpone' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'proofs_not_scheduled');
  assert.equal(one(env, 'SELECT proof_retention_days FROM projects').proof_retention_days, null);
  assert.equal((await retention(env, p.id, { days: 3630 })).status, 200);
  res = await retention(env, p.id, { action: 'postpone' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'retention_too_long');
  assert.equal(one(env, 'SELECT proof_retention_days FROM projects').proof_retention_days, 3630);
});

test('after the delete every setting change is 409 proofs_deleted', async () => {
  const env = setup();
  await studio(env, 90);
  const p = await confirmed(env);
  await cron(env, confirmedAt(env) + 90 * DAY);
  for (const body of [{ days: 0 }, { action: 'postpone' }, { action: 'never' }]) {
    const res = await retention(env, p.id, body);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'proofs_deleted');
  }
});

test('a new studio number never deletes sooner than 14 days after it was set (old confirmed projects get a notice window)', async () => {
  const env = setup();
  const p = await confirmed(env);
  env.DB._db.prepare('UPDATE projects SET client_confirmed_at = ?').run(iso(Date.now() - 200 * DAY));
  const set = Date.now();
  await studio(env, 90);
  const i = await info(env, p.id);
  assert.equal(i.notice, true);
  assert.ok(Date.parse(i.proofs_delete_at) >= set + 14 * DAY);
  await cron(env, set + 13 * DAY);
  assert.ok(has(env, PA));
  await cron(env, Date.now() + 14 * DAY + 60000);
  assert.ok(!has(env, PA));
});

test('a new project number also waits 14 days from the press', async () => {
  const env = setup();
  const p = await confirmed(env);
  env.DB._db.prepare('UPDATE projects SET client_confirmed_at = ?').run(iso(Date.now() - 200 * DAY));
  const set = Date.now();
  assert.equal((await retention(env, p.id, { days: 30 })).status, 200);
  await cron(env, set + 13 * DAY);
  assert.ok(has(env, PA));
  await cron(env, Date.now() + 14 * DAY + 60000);
  assert.ok(!has(env, PA));
});

// ─── what the pages read ──────────────────────────────────────────────────

test('admin detail: proof_retention — days / source / dates; days_left rounds up; notice inside 14 days; deleted', async () => {
  const env = setup();
  const p = await confirmed(env);
  assert.deepEqual(await info(env, p.id), {
    available: true, days: 0, source: 'studio', project_days: null, studio_days: 0,
    proofs_delete_at: null, days_left: null, notice: false, proofs_deleted_at: null,
  });
  await studio(env, 90);
  const c = confirmedAt(env);
  let i = await info(env, p.id);
  assert.equal(i.days, 90);
  assert.equal(i.studio_days, 90);
  assert.equal(i.proofs_delete_at, iso(c + 90 * DAY));
  assert.ok(i.days_left === 90 || i.days_left === 89, String(i.days_left));
  assert.equal(i.notice, false);
  // 14 days and a little less left: notice; days_left 14
  env.DB._db.prepare('UPDATE projects SET client_confirmed_at = ?, proofs_delete_next_at = NULL').run(iso(Date.now() - 76 * DAY - 60000));
  i = await info(env, p.id);
  assert.equal(i.notice, true);
  assert.equal(i.days_left, 14);
  // 15 days left: no notice
  env.DB._db.prepare('UPDATE projects SET client_confirmed_at = ?').run(iso(Date.now() - 75 * DAY - 60000));
  i = await info(env, p.id);
  assert.equal(i.notice, false);
  assert.equal(i.days_left, 15);
  // a day and a half left: 2
  env.DB._db.prepare('UPDATE projects SET client_confirmed_at = ?').run(iso(Date.now() - 88.5 * DAY));
  assert.equal((await info(env, p.id)).days_left, 2);
  // overdue: 0, never negative
  env.DB._db.prepare('UPDATE projects SET client_confirmed_at = ?').run(iso(Date.now() - 100 * DAY));
  i = await info(env, p.id);
  assert.equal(i.days_left, 0);
  assert.equal(i.notice, true);
  // a project override wins
  assert.equal((await retention(env, p.id, { days: 365 })).status, 200);
  i = await info(env, p.id);
  assert.equal(i.source, 'project');
  assert.equal(i.project_days, 365);
  assert.equal(i.days, 365);
  // deleted
  await cron(env, Date.now() + 400 * DAY);
  i = await info(env, p.id);
  assert.match(i.proofs_deleted_at, /^\d{4}-/);
  assert.equal(i.proofs_delete_at, null);
  assert.equal(i.days_left, null);
  assert.equal(i.notice, false);
});

test('admin upcoming list: the caller\'s projects inside the 14-day window only, soonest first', async () => {
  const env = setup({ extra: ROUTES_ON });
  const { B } = await twoTenants(env);
  await studio(env, 90);
  const near = await confirmed(env);
  const far = await confirmed(env);
  const notConfirmed = await delivered(env);
  env.DB._db.prepare('UPDATE projects SET client_confirmed_at = ? WHERE id = ?').run(iso(Date.now() - 80 * DAY), near.id);
  const res = await call(env, '/api/admin/proofs-retention', { token: SECRET });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const out = await res.json();
  assert.equal(out.available, true);
  assert.equal(out.studio_days, 90);
  assert.deepEqual(out.upcoming.map(u => u.id), [near.id]);
  assert.equal(out.upcoming[0].days_left, 10);
  assert.equal(out.upcoming[0].title, '王先生 婚紗');
  assert.ok(!out.upcoming.some(u => u.id === far.id || u.id === notConfirmed.id));
  // B sees none of A's
  const theirs = await (await call(env, '/api/admin/proofs-retention', { token: B.token })).json();
  assert.deepEqual(theirs.upcoming, []);
  assert.equal(theirs.studio_days, 0);
  assert.equal((await call(env, '/api/admin/proofs-retention', { method: 'POST', token: SECRET })).status, 405);
  assert.equal((await call(env, '/api/admin/proofs-retention')).status, 401);
});

test('guest /api/pick/expiry: proofs {proofs_delete_at, days_left, notice, proofs_deleted_at, can_download} — no folder or file name', async () => {
  const env = setup();
  await studio(env, 90);
  const p = await confirmed(env);
  const c = confirmedAt(env);
  const read = async key => { const r = await pick(env, 'GET', 'expiry', p.token, { key }); assert.equal(r.status, 200); return r.text(); };
  let text = await read(p.key);
  let out = JSON.parse(text);
  assert.equal(out.expires_at, null);
  assert.equal(out.days_left, null);
  assert.equal(out.proofs.proofs_delete_at, iso(c + 90 * DAY));
  assert.equal(out.proofs.notice, false);
  assert.equal(out.proofs.proofs_deleted_at, null);
  assert.equal(out.proofs.can_download, false, 'the switch is off');
  assert.deepEqual(Object.keys(out.proofs).sort(), ['can_download', 'days_left', 'notice', 'proofs_delete_at', 'proofs_deleted_at']);
  for (const leak of ['shoot', '毛片', '精修', '.jpg', 'folders', 'source', 'studio_days']) assert.ok(!text.includes(leak), leak);
  env.DB._db.prepare('UPDATE projects SET allow_proof_download = 1').run();
  assert.equal(JSON.parse(await read(p.key)).proofs.can_download, true, 'the seat owner, switch on');
  assert.equal(JSON.parse(await read(undefined)).proofs.can_download, false, 'a viewer never downloads proof originals');
  await cron(env, c + 90 * DAY);
  out = JSON.parse(await read(p.key));
  assert.equal(out.proofs.proofs_deleted_at, iso(c + 90 * DAY));
  assert.equal(out.proofs.proofs_delete_at, null);
  assert.equal(out.proofs.can_download, false, 'nothing left to download');
});

test('guest /api/pick/expiry: not confirmed — no date; not delivered — no date', async () => {
  const env = setup();
  await studio(env, 90);
  const p = await delivered(env);
  const out = await (await pick(env, 'GET', 'expiry', p.token, { key: p.key })).json();
  assert.deepEqual(out.proofs, { proofs_delete_at: null, days_left: null, notice: false, proofs_deleted_at: null, can_download: false });
});

// ─── before the migration ─────────────────────────────────────────────────

// schema.sql without the four columns this feature adds
const WITHOUT = FRESH
  .replace(/\n\s*proof_retention_days\s+INTEGER[^\n]*/g, '')
  .replace(/\n\s*proofs_deleted_at\s+TEXT[^\n]*/g, '')
  .replace(/\n\s*proofs_delete_next_at\s+TEXT[^\n]*/g, '')
  .replace(/,(\s*(?:--[^\n]*\n\s*)*)\);/g, '$1);');

test('before the migration: no 500 anywhere a page reads, the writes say unavailable, and the cron deletes nothing', async () => {
  assert.notEqual(WITHOUT, FRESH, 'the columns are in schema.sql');
  const env = setup({ schema: WITHOUT });
  const cols = t => rows(env, `PRAGMA table_info(${t})`).map(c => c.name);
  for (const c of ['proof_retention_days', 'proofs_deleted_at', 'proofs_delete_next_at']) assert.ok(!cols('projects').includes(c), c);
  assert.ok(!cols('studio_settings').includes('proof_retention_days'));
  // the settings GET / PUT of anything else still work
  assert.equal((await call(env, '/api/admin/settings', { token: SECRET })).status, 200);
  assert.equal((await settings(env, { studio_name: 'X' })).status, 200);
  const p = await confirmed(env);
  const d = await call(env, `/api/admin/projects/${p.id}`, { token: SECRET });
  assert.equal(d.status, 200);
  const i = (await d.json()).project.proof_retention;
  assert.equal(i.available, false);
  assert.equal(i.days, 0);
  assert.equal(i.proofs_delete_at, null);
  const g = await pick(env, 'GET', 'expiry', p.token, { key: p.key });
  assert.equal(g.status, 200);
  assert.equal((await g.json()).proofs.proofs_delete_at, null);
  const u = await call(env, '/api/admin/proofs-retention', { token: SECRET });
  assert.equal(u.status, 200);
  assert.deepEqual(await u.json(), { available: false, studio_days: 0, upcoming: [] });
  let res = await settings(env, { proof_retention_days: 90 });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).code, 'proof_retention_unavailable');
  res = await retention(env, p.id, { days: 30 });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).code, 'proof_retention_unavailable');
  // nothing in the database says to delete, and the cron cannot ask: it stops before R2, quietly
  const calls = countCalls(env);
  const out = await cron(env, Date.now() + 3650 * DAY);
  assert.deepEqual(out, { ran: false, reason: 'unavailable' });
  assert.deepEqual(calls.filter(c => c.startsWith('r2')), [], 'R2 never asked');
  assert.deepEqual(env.imagepicker._deletes, []);
});

test('half a migration (the studio column only): still unavailable everywhere, nothing deleted', async () => {
  const half = WITHOUT.replace(/(link_message_done\s+TEXT)(\s*(?:--[^\n]*\n\s*)*\);)/, '$1,\n  proof_retention_days INTEGER$2');
  assert.notEqual(half, WITHOUT);
  const env = setup({ schema: half });
  env.DB._db.prepare("INSERT INTO studio_settings (photographer_id, proof_retention_days) VALUES ('default', 90)").run();
  await confirmed(env);
  const calls = countCalls(env);
  assert.deepEqual(await cron(env, Date.now() + 3650 * DAY), { ran: false, reason: 'unavailable' });
  assert.deepEqual(calls.filter(c => c.startsWith('r2')), [], 'R2 never asked');
  assert.deepEqual(env.imagepicker._deletes, []);
});

// ─── the source ───────────────────────────────────────────────────────────

test('migration: four append-only ALTERs, in schema.sql too; wrangler.toml has a daily cron off the hour', () => {
  const sql = readFileSync(new URL('../migrations/2026-10-21-proof-retention.sql', import.meta.url), 'utf8');
  const code = sql.split('\n').map(l => l.split('--')[0]).join('\n');
  assert.deepEqual(code.split(';').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean), [
    'ALTER TABLE studio_settings ADD COLUMN proof_retention_days INTEGER',
    'ALTER TABLE projects ADD COLUMN proof_retention_days INTEGER',
    'ALTER TABLE projects ADD COLUMN proofs_deleted_at TEXT',
    'ALTER TABLE projects ADD COLUMN proofs_delete_next_at TEXT',
  ]);
  for (const col of ['proof_retention_days INTEGER', 'proofs_deleted_at TEXT', 'proofs_delete_next_at TEXT']) assert.match(FRESH, new RegExp(col));
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const m = /\[triggers\]\s*\ncrons\s*=\s*\["(\d+) (\d+) \* \* \*"\]/.exec(toml);
  assert.ok(m, 'a [triggers] crons entry');
  assert.notEqual(Number(m[1]), 0, 'not on the hour');
  assert.equal(typeof worker.scheduled, 'function');
});

test('source: the cron deletes through bucketFor(run.env, p.photographer_id, budget) only, takes nothing from a request, and the batch delete re-checks every key', () => {
  const fn = name => {
    const at = SRC.indexOf(`async function ${name}(`);
    assert.ok(at > 0, name);
    return SRC.slice(at, SRC.indexOf('\n}\n', at));
  };
  const retire = fn('retireProofs');
  assert.doesNotMatch(retire, /env\.|request|params|\.delete\(/);
  assert.match(retire, /const owner = p\.photographer_id;/);
  assert.match(retire, /bucketFor\(run\.env, owner, run\.spend\)/);
  assert.equal(retire.split('bucketFor(').length - 1, 1);
  assert.match(retire, /photos\.deleteMany\(/);
  const runner = fn('runProofRetention');
  assert.doesNotMatch(runner, /request|params|bucketFor|\.delete/);
  assert.match(SRC, /deleteMany\(keys\) \{\n[^\n]*\n\s*if \(keys\.some\(reserved\)\)/);
  // the scheduled handler hands over only the controller's time
  const sched = SRC.slice(SRC.indexOf('async scheduled(controller, env, ctx)'), SRC.indexOf('async scheduled(controller, env, ctx)') + 400);
  assert.match(sched, /runProofRetention\(env, /);
});

// the batch delete on bucketFor, lifted out the way r2-delete-helper.test.mjs does
const from = SRC.indexOf('const TENANT_PREFIX');
const to = SRC.indexOf('// Books have no owner yet');
const bucketFor = new Function('DEFAULT_PHOTOGRAPHER_ID', `${SRC.slice(from, to)}\nreturn bucketFor;`)('default');

test('bucketFor.deleteMany: 1..1000 logical keys, each prefixed; a reserved or non-string key, an empty or oversized list refuse the whole call', async () => {
  const T = '0123456789abcdef';
  const r2 = fakeBucket({ 'a.jpg': 'A', [`_t/${T}/a.jpg`]: 'TA', [`_t/${T}/b.jpg`]: 'TB' });
  await bucketFor({ imagepicker: r2 }, T).deleteMany(['a.jpg', 'b.jpg']);
  assert.deepEqual(r2._deletes, [`_t/${T}/a.jpg`, `_t/${T}/b.jpg`]);
  assert.ok(r2._store.has('a.jpg'));
  await bucketFor({ imagepicker: r2 }, 'default').deleteMany(['a.jpg']);
  assert.ok(!r2._store.has('a.jpg'));
  const before = r2._deletes.length;
  for (const bad of [[], ['x.jpg', '_t/other/x.jpg'], ['_t'], ['x.jpg', 42], 'x.jpg', null, Array.from({ length: 1001 }, (_, i) => `${i}.jpg`)]) {
    for (const who of ['default', T]) assert.throws(() => bucketFor({ imagepicker: r2 }, who).deleteMany(bad), /R2/, JSON.stringify(bad)?.slice(0, 40));
  }
  assert.equal(r2._deletes.length, before);
});

// ─── security review fixes (2026-10-21) ───────────────────────────────────

test('only what was uploaded by the confirmation goes: a file (and thumbnail) uploaded after it stays', async () => {
  const LATE = 'shoot/毛片/2027續拍/n.jpg';
  const env = setup();
  await studio(env, 90);
  await confirmed(env);
  const c = confirmedAt(env);
  for (const k of [LATE, `_thumbs/400/${LATE}.thumb`]) env.imagepicker._store.set(k, { key: k, body: 'L', contentType: 'image/jpeg', uploaded: new Date(c + 1000) });
  // an original whose upload time cannot be read stays too
  env.imagepicker._store.set('shoot/毛片/odd.jpg', { key: 'x', body: 'O', contentType: 'image/jpeg', uploaded: new Date(NaN) });
  await cron(env, c + 90 * DAY);
  assert.ok(has(env, LATE), 'uploaded after the confirmation');
  assert.ok(has(env, `_thumbs/400/${LATE}.thumb`));
  assert.ok(has(env, 'shoot/毛片/odd.jpg'));
  assert.ok(!has(env, PA), 'positive control');
  assert.deepEqual(events(env, 'proofs_deleted')[0].data, { folders: [PROOF], originals: 3, thumbs: 6 });
});

test('a top-level proof folder (one segment, e.g. 2026/) is skipped as top_level_folder', async () => {
  const env = setup({ objects: { ...WORLD, '2026/a.jpg': 'A26', '_thumbs/400/2026/a.jpg.thumb': 'T26' } });
  await studio(env, 90);
  await confirmed(env);
  env.DB._db.prepare('UPDATE projects SET folders = ?').run(JSON.stringify(['2026/']));
  await skipped(env, 'top_level_folder');
  assert.ok(has(env, '2026/a.jpg'));
});

test('a key with any `_` path segment is never deleted (shoot/毛片/_備份/z.jpg and its thumbnail stay)', async () => {
  const HID = 'shoot/毛片/_備份/z.jpg';
  const env = setup({ objects: { ...WORLD, [HID]: 'H', [`_thumbs/400/${HID}.thumb`]: 'HT' } });
  await studio(env, 90);
  await confirmed(env);
  await cron(env, confirmedAt(env) + 90 * DAY);
  assert.ok(has(env, HID));
  assert.ok(has(env, `_thumbs/400/${HID}.thumb`));
  assert.ok(!has(env, PA), 'positive control');
});

test('a project number the route never stores (1..13, a fraction, a string) reads as 0: never deleted', async () => {
  for (const value of [1, 7, 13, 30.5, 'abc', -14]) {
    const env = setup();
    const p = await confirmed(env);
    env.DB._db.prepare('UPDATE projects SET proof_retention_days = ?').run(value);
    await cron(env, Date.now() + 9000 * DAY);
    assert.deepEqual(env.imagepicker._deletes, [], String(value));
    assert.equal((await info(env, p.id)).days, 0, String(value));
    // the candidate query reads it as 0 as well: never even picked up
    assert.equal(one(env, 'SELECT proofs_delete_next_at FROM projects').proofs_delete_next_at, null, String(value));
  }
});

test('more than ten not-yet-due candidates do not keep a due project out (each is put off a day)', async () => {
  const env = setup();
  await studio(env, 90);
  const p = await confirmed(env);
  const now = Date.now();
  env.DB._db.prepare('UPDATE projects SET client_confirmed_at = ? WHERE id = ?').run(iso(now - 91 * DAY), p.id);
  // eleven projects due in 12 hours (inside the query's one-day slack), confirmed earlier, so sorted first
  for (let i = 0; i < 11; i++) {
    env.DB._db.prepare(
      "INSERT INTO projects (id, title, folders, created_at, photographer_id, phase, delivered_at, final_folders, client_confirmed_at, proof_retention_days) " +
      "VALUES (?, 'f', ?, ?, 'default', 'retouching', ?, ?, ?, 365)"
    ).run(`filler-${i}`, JSON.stringify([`filler${i}/`]), iso(now), iso(now - 400 * DAY), JSON.stringify([`fillerfinal${i}/`]), iso(now - 365 * DAY + DAY / 2));
  }
  await cron(env, now);
  await cron(env, now + 1000);
  assert.ok(!has(env, PA), 'the due project was reached');
  assert.ok(Date.parse(one(env, "SELECT proofs_delete_next_at FROM projects WHERE id = 'filler-0'").proofs_delete_next_at) > now);
});
