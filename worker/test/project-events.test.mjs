// Project activity log (docs/delivery.md, "Activity log"): an append-only
// project_events table, one row per photographer / client action that
// overwrites project columns (deliver, a repeat deliver 改交, undeliver,
// reopen, start-retouch, confirm), so the history survives the overwrite.
// High tier (a data write on every delivery route): the log is best-effort
// AFTER the main write, never fails or changes the action, works before the
// migration, is only ever INSERTed, and only the project's photographer reads
// it (GET /api/admin/projects/:id/events).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  setup, admin, deliver, retouching, delivered, confirm, reviseText, state, detail,
  FINAL, FINAL2, SECRET, call, pick, one, rows,
} from './revision-helpers.mjs';
import { twoTenants, ROUTES_ON } from './tenant-helpers.mjs';

const SRC = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const FRESH = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const MIGRATION_FILE = new URL('../migrations/2026-10-20-project-events.sql', import.meta.url);
const MIGRATION = existsSync(MIGRATION_FILE) ? readFileSync(MIGRATION_FILE, 'utf8') : '';

// the deployed database today: everything but this migration
const strip = s => {
  const out = s.replace(/CREATE TABLE IF NOT EXISTS project_events \([\s\S]*?\);\n/, '')
    .replace(/CREATE INDEX IF NOT EXISTS idx_project_events_project[^\n]*\n/, '');
  return out;
};
const BEFORE = strip(FRESH);

const events = env => rows(env, 'SELECT * FROM project_events ORDER BY id').map(r => ({ ...r, data: r.data == null ? null : JSON.parse(r.data) }));
const kinds = env => events(env).map(e => e.kind);
const readEvents = (env, id, token = SECRET, opts = {}) => call(env, `/api/admin/projects/${id}/events`, { token, ...opts });

// ─── schema ───────────────────────────────────────────────────────────────

test('schema.sql and the migration create project_events with its index; the migration is append-only (no ALTER / DROP / UPDATE / DELETE)', () => {
  for (const [name, sql] of [['schema.sql', FRESH], ['migration', MIGRATION]]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS project_events \(\s*id\s+INTEGER PRIMARY KEY AUTOINCREMENT/, name);
    for (const col of ['project_id', 'at', 'kind', 'actor', 'data']) assert.match(sql, new RegExp(`project_events \\([^;]*\\b${col}\\b`), `${name}: ${col}`);
    assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_project_events_project ON project_events\(project_id, at\)/, name);
  }
  const statements = MIGRATION.split('\n').filter(l => l.trim() && !l.trim().startsWith('--'));
  assert.equal(statements.length, 2, 'two statements, one per line');
  assert.doesNotMatch(MIGRATION.replace(/--[^\n]*/g, ''), /\b(ALTER|DROP|UPDATE|DELETE)\b/i);
  assert.notEqual(BEFORE, FRESH, 'the before-migration fixture really lacks the table');
});

// ─── writes ───────────────────────────────────────────────────────────────

test('deliver writes one deliver event (photographer, the finals, at = delivered_at); a repeat deliver of another set reads as 改交 with the previous folders', async () => {
  const env = setup();
  const p = await retouching(env);
  assert.deepEqual(kinds(env), ['retouch'], 'start-retouch from submitted logged once');
  const res = await deliver(env, p.id, [FINAL]);
  assert.equal(res.status, 200);
  const { delivered_at } = await res.json();
  let ev = events(env);
  assert.equal(ev.length, 2);
  assert.deepEqual({ ...ev[1], id: 0 }, { id: 0, project_id: p.id, at: delivered_at, kind: 'deliver', actor: 'photographer', data: { final_folders: [FINAL] } });

  // 改交 an other set: delivered_at keeps the first stamp, the event has its own time
  await new Promise(r => setTimeout(r, 5));
  const t0 = new Date().toISOString();
  const again = await deliver(env, p.id, [FINAL2]);
  assert.equal(again.status, 200);
  ev = events(env);
  assert.equal(ev.length, 3);
  assert.equal(ev[2].kind, 'deliver');
  assert.deepEqual(ev[2].data, { final_folders: [FINAL2], repeat: true, previous: [FINAL] });
  assert.ok(ev[2].at >= t0 && delivered_at < t0, `the 改交 is dated when it happened (${ev[2].at}), not by the first stamp (${delivered_at})`);
  assert.equal(one(env, 'SELECT delivered_at FROM projects').delivered_at, delivered_at, 'the stamp is untouched (control)');
});

test('undeliver logs the folders taken down; undeliver of an undelivered project logs nothing (still 200)', async () => {
  const env = setup();
  const p = await delivered(env, [FINAL]);
  const n = events(env).length;
  assert.equal((await admin(env, p.id, 'undeliver')).status, 200);
  const ev = events(env);
  assert.equal(ev.length, n + 1);
  assert.equal(ev.at(-1).kind, 'undeliver');
  assert.equal(ev.at(-1).actor, 'photographer');
  assert.deepEqual(ev.at(-1).data, { final_folders: [FINAL] });
  assert.equal((await admin(env, p.id, 'undeliver')).status, 200);
  assert.equal(events(env).length, n + 1, 'a second undeliver changed nothing and logs nothing');
  // a deliver after an undeliver is a fresh one, not a 改交
  assert.equal((await deliver(env, p.id, [FINAL2])).status, 200);
  assert.deepEqual(events(env).at(-1).data, { final_folders: [FINAL2] });
});

test('reopen logs from which phase and whether it was delivered; reopen of a picking project logs nothing', async () => {
  const env = setup();
  const p = await delivered(env, [FINAL]);
  assert.equal((await admin(env, p.id, 'reopen')).status, 200);
  const last = events(env).at(-1);
  assert.equal(last.kind, 'reopen');
  assert.equal(last.actor, 'photographer');
  assert.deepEqual(last.data, { from_phase: 'retouching', was_delivered: true });
  const n = events(env).length;
  assert.equal((await admin(env, p.id, 'reopen')).status, 200);
  assert.equal(events(env).length, n, 'already picking: nothing to log');
});

test('start-retouch logs once: a second press (already retouching) logs nothing; a refused one (picking) neither', async () => {
  const env = setup();
  const p = await retouching(env);
  assert.deepEqual(kinds(env), ['retouch']);
  assert.equal(events(env)[0].actor, 'photographer');
  assert.equal(events(env)[0].data, null);
  assert.equal((await admin(env, p.id, 'start-retouch')).status, 200);
  assert.deepEqual(kinds(env), ['retouch']);
  assert.equal((await admin(env, p.id, 'reopen')).status, 200);
  assert.equal((await admin(env, p.id, 'start-retouch')).status, 409, 'picking: refused');
  assert.deepEqual(kinds(env), ['retouch', 'reopen']);
});

test('the client confirms: one confirm event, actor client, no name in it; a repeat confirm logs nothing', async () => {
  const env = setup();
  const p = await delivered(env, [FINAL]);
  const res = await confirm(env, p.token, p.key);
  assert.equal(res.status, 200);
  const { confirmed_at } = await res.json();
  const ev = events(env).at(-1);
  assert.equal(ev.kind, 'confirm');
  assert.equal(ev.actor, 'client');
  assert.equal(ev.at, confirmed_at);
  assert.equal(ev.data, null);
  assert.doesNotMatch(JSON.stringify(rows(env, 'SELECT * FROM project_events')), /王小明|picker|key/i);
  const n = events(env).length;
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
  assert.equal(events(env).length, n);
});

test('the photographer marks it complete (標記完成): actor photographer; a second press logs nothing; before delivery (409) nothing', async () => {
  const env = setup();
  const p = await retouching(env);
  assert.equal((await admin(env, p.id, 'confirm')).status, 409);
  assert.deepEqual(kinds(env), ['retouch']);
  assert.equal((await deliver(env, p.id)).status, 200);
  const res = await admin(env, p.id, 'confirm');
  assert.equal(res.status, 200);
  const ev = events(env).at(-1);
  assert.equal(ev.kind, 'confirm');
  assert.equal(ev.actor, 'photographer');
  assert.equal(ev.at, (await res.json()).client_confirmed_at);
  assert.equal((await admin(env, p.id, 'confirm')).status, 200);
  assert.deepEqual(kinds(env), ['retouch', 'deliver', 'confirm']);
});

test('racing presses log once: two undelivers, two reopens, two start-retouches each leave one event (the write decides, not a read before it)', async () => {
  const env = setup();
  const p = await delivered(env, [FINAL]);
  const count = kind => events(env).filter(e => e.kind === kind).length;
  const both = async action => (await Promise.all([admin(env, p.id, action), admin(env, p.id, action)])).map(r => r.status);
  assert.deepEqual(await both('undeliver'), [200, 200]);
  assert.equal(count('undeliver'), 1);
  assert.deepEqual(await both('reopen'), [200, 200]);
  assert.equal(count('reopen'), 1);
  // back to submitted, then two presses
  env.DB._db.prepare("UPDATE projects SET phase = 'submitted'").run();
  assert.deepEqual(await both('start-retouch'), [200, 200]);
  assert.equal(count('retouch'), 2, 'the first retouch (fixture) and one of the two presses');
});

test('refused actions log nothing: deliver before retouching, deliver overlapping the proofs, another photographer\'s project (404)', async () => {
  const env = setup({ extra: ROUTES_ON });
  const { B } = await twoTenants(env);
  const p = await retouching(env);
  const n = events(env).length;
  assert.equal((await deliver(env, p.id, ['shoot/毛片/'])).status, 400);
  for (const action of ['deliver', 'undeliver', 'reopen', 'start-retouch', 'confirm']) {
    const res = await call(env, `/api/admin/projects/${p.id}/${action}`, { method: 'POST', token: B.token, body: { final_folders: [FINAL] } });
    assert.equal(res.status, 404, action);
  }
  assert.equal(events(env).length, n);
});

test('a revision request (text) is not logged: revision_requests already holds it', async () => {
  const env = setup();
  const p = await delivered(env, [FINAL]);
  const n = events(env).length;
  assert.equal((await reviseText(env, p.token, p.key, '再亮一點')).status, 200);
  assert.equal(events(env).length, n);
});

// ─── failure isolation ────────────────────────────────────────────────────

test('before the migration (no project_events table): every action answers exactly as with it, and the read is an empty list', async () => {
  const runAll = async env => {
    const out = [];
    const p = await retouching(env);
    for (const [action, body] of [['deliver', { final_folders: [FINAL] }], ['deliver', { final_folders: [FINAL2] }], ['confirm'], ['undeliver'], ['deliver', { final_folders: [FINAL] }]]) {
      const res = await admin(env, p.id, action, body);
      out.push([action, res.status, Object.keys(await res.json()).sort().join(',')]);
    }
    const c = await confirm(env, p.token, p.key);
    out.push(['guest-confirm', c.status]);
    const r = await admin(env, p.id, 'reopen');
    out.push(['reopen', r.status, (await r.json()).phase]);
    return { out, p };
  };
  const withTable = await runAll(setup());
  const env = setup({ schema: BEFORE });
  const without = await runAll(env);
  assert.deepEqual(without.out, withTable.out);
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'project_events'").n, 0, 'control: really no table');
  assert.equal(one(env, 'SELECT phase FROM projects').phase, 'picking', 'the actions themselves landed');
  const res = await readEvents(env, without.p.id);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).events, []);
});

test('an event insert that fails for any other reason never fails the action, and the main write stays', async () => {
  const env = setup();
  const p = await retouching(env);
  const prepare = env.DB.prepare.bind(env.DB);
  let tried = 0;
  env.DB.prepare = sql => {
    if (/INSERT INTO project_events/.test(sql)) {
      tried++;
      return { bind: () => ({ run: async () => { throw new Error('D1_ERROR: database is locked'); } }) };
    }
    return prepare(sql);
  };
  const res = await deliver(env, p.id, [FINAL]);
  assert.equal(res.status, 200);
  assert.ok((await res.json()).delivered_at);
  assert.equal(tried, 1, 'the insert was tried');
  assert.ok(one(env, 'SELECT delivered_at FROM projects').delivered_at, 'the delivery landed');
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
  assert.equal(tried, 2);
  assert.ok(one(env, 'SELECT client_confirmed_at FROM projects').client_confirmed_at);
});

// ─── append-only ──────────────────────────────────────────────────────────

test('append-only: worker.js only ever INSERTs into project_events (one place), never UPDATE / DELETE / REPLACE it', () => {
  const code = SRC.split('\n').map(l => l.split('//')[0]).join('\n');
  assert.doesNotMatch(code, /UPDATE\s+project_events/i);
  assert.doesNotMatch(code, /DELETE\s+FROM\s+project_events/i);
  assert.doesNotMatch(code, /REPLACE\s+INTO\s+project_events/i);
  assert.doesNotMatch(code, /INSERT\s+OR\s+\w+\s+INTO\s+project_events/i);
  assert.doesNotMatch(code, /DROP\s+TABLE[^;\n]*project_events/i);
  assert.equal(code.split(/INSERT INTO project_events/).length - 1, 1, 'one insert site');
  // and project deletion does not reach it (a deletable project has no events: none can be written before a submission)
  assert.doesNotMatch(code, /'project_events'/);
});

// ─── read ─────────────────────────────────────────────────────────────────

test('GET /api/admin/projects/:id/events: oldest first, data parsed, admin-only headers', async () => {
  const env = setup();
  const p = await delivered(env, [FINAL]);
  assert.equal((await deliver(env, p.id, [FINAL2])).status, 200);
  const res = await readEvents(env, p.id);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Cache-Control') || '', /no-store/);
  const body = await res.json();
  assert.deepEqual(body.events.map(e => e.kind), ['retouch', 'deliver', 'deliver']);
  assert.deepEqual(body.events[2].data, { final_folders: [FINAL2], repeat: true, previous: [FINAL] });
  assert.deepEqual(Object.keys(body.events[0]).sort(), ['actor', 'at', 'data', 'id', 'kind']);
});

test('the read is capped at the newest 200, still oldest first', async () => {
  const env = setup();
  const p = await retouching(env);
  const ins = env.DB._db.prepare("INSERT INTO project_events (project_id, at, kind, actor, data) VALUES (?, ?, 'deliver', 'photographer', NULL)");
  for (let i = 0; i < 205; i++) ins.run(p.id, new Date(Date.UTC(2027, 0, 1, 0, 0, i)).toISOString());
  const body = await (await readEvents(env, p.id)).json();
  assert.equal(body.events.length, 200);
  assert.equal(body.events[0].at, new Date(Date.UTC(2027, 0, 1, 0, 0, 5)).toISOString());
  assert.equal(body.events[199].at, new Date(Date.UTC(2027, 0, 1, 0, 0, 204)).toISOString());
});

test('who may read: nobody / a pick link / a picker key get 401; another photographer gets 404 (same as no project); a malformed data row reads as null', async () => {
  const env = setup({ extra: ROUTES_ON });
  const { B } = await twoTenants(env);
  const p = await delivered(env, [FINAL]);
  assert.equal((await readEvents(env, p.id, null)).status, 401);
  assert.equal((await readEvents(env, p.id, p.token)).status, 401, 'the pick token as a bearer');
  assert.equal((await call(env, `/api/admin/projects/${p.id}/events?t=${p.token}`, { key: p.key })).status, 401, 'the link + seat key');
  const other = await readEvents(env, p.id, B.token);
  assert.equal(other.status, 404);
  const nobody = await readEvents(env, '00000000-0000-4000-8000-000000000000');
  assert.equal(nobody.status, 404);
  assert.deepEqual(await other.json(), await nobody.json());
  // B's own project: its own events only
  env.DB._db.prepare("UPDATE project_events SET data = '{bad' WHERE kind = 'deliver'").run();
  const mine = await (await readEvents(env, p.id)).json();
  assert.equal(mine.events.find(e => e.kind === 'deliver').data, null);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await call(env, `/api/admin/projects/${p.id}/events`, { method, token: SECRET, body: {} });
    assert.notEqual(res.status, 200, method);
  }
});

test('events stay off every guest route: the pick state carries none of them', async () => {
  const env = setup();
  const p = await delivered(env, [FINAL]);
  assert.equal((await deliver(env, p.id, [FINAL2])).status, 200);
  const s = await state(env, p.token, p.key);
  const text = JSON.stringify(s);
  assert.doesNotMatch(text, /"events"|"repeat"|"previous"|project_events/);
  // and a guest path named like it is nothing
  const res = await pick(env, 'GET', 'events', p.token, { key: p.key });
  assert.notEqual(res.status, 200);
});

test('the admin detail route is unchanged (no events in it): the page fetches them on their own', async () => {
  const env = setup();
  const p = await delivered(env, [FINAL]);
  const d = await detail(env, p.id);
  assert.equal(d.events, undefined);
});

test('two delivers inside one millisecond: the second still reads as 改交 (the stamp read before the write counts)', async () => {
  const env = setup();
  const p = await retouching(env);
  const real = Date.prototype.toISOString;
  const frozen = real.call(new Date());
  // both delivers share one `at`, so the second one's `at` equals the first stamp
  Date.prototype.toISOString = function () { return frozen; };
  try {
    assert.equal((await deliver(env, p.id, [FINAL])).status, 200);
    assert.equal((await deliver(env, p.id, [FINAL2])).status, 200);
  } finally { Date.prototype.toISOString = real; }
  const ev = events(env);
  assert.equal(one(env, 'SELECT delivered_at FROM projects').delivered_at, frozen, 'both delivers ran at the same instant (control)');
  assert.deepEqual(ev[ev.length - 1].data, { final_folders: [FINAL2], repeat: true, previous: [FINAL] });
});
