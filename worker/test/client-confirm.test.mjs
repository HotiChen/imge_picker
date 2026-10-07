// Client confirmation and revision requests (docs/delivery.md, decided
// 2026-10-04). After delivery the seat holder either confirms the delivery
// (確認完成) or asks for changes (要求修改, a short text); the photographer is
// emailed, uploads 精修二 and re-delivers (the existing repeat deliver), which
// clears the confirmation and resolves the open requests. The photographer
// may also mark a delivery complete by hand. High tier: new guest writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fakeBucket, fakeDB } from './fakes.mjs';
import {
  SECRET, call, pick, claim, save, one, rows, days, withT, collectingCtx,
} from './pick-helpers.mjs';

const PROOF = 'shoot/毛片/';
const FINAL = 'shoot/精修/';
const FINAL2 = 'shoot/精修二/';
const PA = 'shoot/毛片/a.jpg';
const FA = 'shoot/精修/f1.jpg';
const OBJECTS = {
  [PA]: 'PROOF-A-ORIGINAL',
  [`_thumbs/400/${PA}.thumb`]: 'PROOF-A-400',
  [FA]: 'FINAL-A-ORIGINAL',
  'shoot/精修二/f1.jpg': 'FINAL2-A-ORIGINAL',
};

const FRESH = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
// a database before this migration: neither column, no table
const strippedColumns = FRESH.replace(
  /(extra_max\s+INTEGER),\n(?:\s*--[^\n]*\n)*\s*client_confirmed_at\s+TEXT,\n(?:\s*--[^\n]*\n)*\s*client_confirmed_by\s+TEXT,\n(?:\s*--[^\n]*\n)*\s*shoot_date\s+TEXT,\n(?:\s*--[^\n]*\n)*\s*project_type\s+TEXT\n\);/, '$1\n);');
const strippedTable = s => s.replace(/\n-- ─── Client confirmation[\s\S]*$/, '\n');
const BEFORE = strippedTable(strippedColumns);
// the two ALTERs run but not the CREATE TABLE (the D1 console runs one
// statement at a time, so a half-run paste is possible)
const HALF = strippedTable(FRESH);

function fakeMailer({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    async send(msg) {
      if (fail) throw new Error('smtp down');
      sent.push(msg);
      return { messageId: 'm1' };
    },
  };
}

function setup({ schema, mailer = fakeMailer(), extra = {} } = {}) {
  return {
    imagepicker: fakeBucket(OBJECTS), DB: fakeDB(schema ? { schema } : {}), PHOTOGRAPHER_TOKEN: SECRET,
    NOTIFY_EMAIL: mailer, PHOTOGRAPHER_EMAIL: 'studio@example.com', NOTIFY_FROM: 'notify@imhoti.tw', ...extra,
  };
}

const admin = (env, id, action, body, token = SECRET) =>
  call(env, `/api/admin/projects/${id}/${action}`, { method: 'POST', token, body });
const deliver = (env, id, finals = [FINAL]) => admin(env, id, 'deliver', { final_folders: finals });
const detail = async (env, id) => (await call(env, `/api/admin/projects/${id}`, { token: SECRET })).json();
const listRow = async (env, id) => (await (await call(env, '/api/admin/projects', { token: SECRET })).json()).projects.find(r => r.id === id);
const state = async (env, t, key) => {
  const res = await pick(env, 'GET', 'state', t, { key });
  assert.equal(res.status, 200);
  return res.json();
};

// a guest write, waiting for the background email
async function guest(env, route, t, key, body) {
  const c = collectingCtx();
  const res = await pick(env, 'POST', route, t, { key, body }, c);
  await c.settle();
  return res;
}
const confirm = (env, t, key, body) => guest(env, 'confirm', t, key, body);
const revise = (env, t, key, message) => guest(env, 'revision', t, key, message === undefined ? {} : { message });

async function createProject(env) {
  const res = await call(env, '/api/admin/projects', {
    method: 'POST', token: SECRET, body: { title: '王先生 婚紗', folders: [PROOF], pick_limit: 40, extra_price: 200 },
  });
  assert.equal(res.status, 201);
  return res.json();
}

async function retouching(env) {
  const created = await createProject(env);
  const c = await claim(env, created.token);
  const p = { ...created, key: c.key, id: created.project.id, pickerId: c.json.picker_id };
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: PA, rating: 1 }] })).status, 200);
  assert.equal((await guest(env, 'submit', p.token, p.key, { relationship: '本人' })).status, 200);
  assert.equal((await admin(env, p.id, 'start-retouch')).status, 200);
  return p;
}

async function delivered(env, finals = [FINAL]) {
  const p = await retouching(env);
  const res = await deliver(env, p.id, finals);
  assert.equal(res.status, 200, await res.clone().text());
  env.NOTIFY_EMAIL && (env.NOTIFY_EMAIL.sent.length = 0); // the submit's own email
  return p;
}

const confirmation = env => ({ ...one(env, 'SELECT client_confirmed_at, client_confirmed_by FROM projects') });
const openCount = env => one(env, 'SELECT COUNT(*) AS n FROM revision_requests WHERE resolved_at IS NULL').n;
const snapshot = env => JSON.stringify([rows(env, 'SELECT * FROM projects'), rows(env, 'SELECT * FROM revision_requests')]);
const code = async res => (await res.clone().json()).code;

// runs `sql` once, right before the first statement matching `re` is prepared
function landOnce(env, re, sql, ...args) {
  const prepare = env.DB.prepare.bind(env.DB);
  let done = false;
  env.DB.prepare = s => {
    if (!done && re.test(s)) { done = true; env.DB._db.prepare(sql).run(...args); }
    return prepare(s);
  };
}

// ─── schema ──────────────────────────────────────────────────────────────────

test('migration: two ALTERs, one CREATE TABLE IF NOT EXISTS and its index, one statement each; noted in schema.sql', () => {
  const file = new URL('../migrations/2026-10-04-client-confirm.sql', import.meta.url);
  assert.ok(existsSync(file));
  const sql = readFileSync(file, 'utf8');
  assert.match(sql, /D1 Console/);
  assert.match(sql, /duplicate column/i);
  assert.match(sql, /confirm_unavailable/);
  const statements = sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
  assert.equal(statements.length, 4);
  assert.equal(statements[0], 'ALTER TABLE projects ADD COLUMN client_confirmed_at TEXT');
  assert.equal(statements[1], 'ALTER TABLE projects ADD COLUMN client_confirmed_by TEXT');
  assert.match(statements[2], /^CREATE TABLE IF NOT EXISTS revision_requests \(/);
  assert.match(statements[3], /^CREATE INDEX IF NOT EXISTS \w+ ON revision_requests\s?\(project_id, resolved_at\)$/);
  assert.match(FRESH, /2026-10-04-client-confirm\.sql/);
  // the deployed database (before) takes the paste, statement by statement,
  // and ends up with what a fresh schema.sql has
  const db = fakeDB({ schema: BEFORE });
  for (const s of statements) db._db.exec(s);
  const cols = t => db._db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  const fresh = fakeDB();
  const freshCols = t => fresh._db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  // (shoot_date and project_type come later, from 2026-10-07-project-shoot-date.sql and 2026-10-07-project-type.sql)
  assert.deepEqual(cols('projects'), freshCols('projects').filter(c => !['shoot_date', 'project_type'].includes(c)));
  // (the three revision-pins columns come later, from 2026-10-07-revision-pins.sql)
  assert.deepEqual(cols('revision_requests'), freshCols('revision_requests').filter(c => !['marks', 'finals', 'message_auto'].includes(c)));
  assert.deepEqual(cols('revision_requests'), ['id', 'project_id', 'picker_id', 'message', 'created_at', 'resolved_at']);
  // a re-run of the ALTER says it already ran; the CREATEs are re-runnable
  assert.throws(() => db._db.exec(statements[0]), /duplicate column/);
  db._db.exec(statements[2]);
  db._db.exec(statements[3]);
  // and BEFORE really is the old shape
  const old = fakeDB({ schema: BEFORE });
  assert.throws(() => old._db.prepare('SELECT client_confirmed_at FROM projects').all(), /no such column/);
  assert.throws(() => old._db.prepare('SELECT * FROM revision_requests').all(), /no such table/);
});

test('a new project: not confirmed, no requests — in the DB, the admin list and detail, and the pick state', async () => {
  const env = setup();
  const p = await createProject(env);
  assert.deepEqual(confirmation(env), { client_confirmed_at: null, client_confirmed_by: null });
  const row = await listRow(env, p.project.id);
  assert.equal(row.client_confirmed_at, null);
  assert.equal(row.client_confirmed_by, null);
  assert.equal(row.open_revision_count, 0);
  const d = await detail(env, p.project.id);
  assert.equal(d.project.client_confirmed_at, null);
  assert.equal(d.project.client_confirmed_by, null);
  assert.equal(d.project.open_revision_count, 0);
  assert.deepEqual(d.revision_requests, []);
  const s = await state(env, p.token);
  assert.equal(s.confirmed_at, null);
  assert.equal(s.revision_open, false);
  assert.equal(s.revision_message, null);
});

// ─── guest confirm ───────────────────────────────────────────────────────────

test('confirm: the seat holder of a delivered project confirms; stamped as the guest; owner and viewers see it', async () => {
  const env = setup();
  const p = await delivered(env);
  const res = await confirm(env, p.token, p.key);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.match(json.confirmed_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal('client_confirmed_by' in json, false, 'who confirmed is an admin field');
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(confirmation(env), { client_confirmed_at: json.confirmed_at, client_confirmed_by: 'guest' });
  for (const key of [p.key, undefined]) {
    const s = await state(env, p.token, key);
    assert.equal(s.mode, 'delivered');
    assert.equal(s.confirmed_at, json.confirmed_at);
    assert.equal(s.revision_open, false);
    assert.equal('client_confirmed_by' in s, false);
  }
  // an empty JSON object is the same as no body
  const env2 = setup();
  const q = await delivered(env2);
  assert.equal((await confirm(env2, q.token, q.key, {})).status, 200);
  assert.equal(confirmation(env2).client_confirmed_by, 'guest');
});

test('confirm: only the seat holder — a viewer, a wrong key or another project\'s key is 403, nothing written', async () => {
  const env = setup();
  const p = await delivered(env);
  const other = await createProject(env);
  const o = await claim(env, other.token, '別人');
  const before = snapshot(env);
  for (const key of [undefined, 'not-a-key', o.key]) {
    const res = await confirm(env, p.token, key);
    assert.equal(res.status, 403, String(key));
    const rev = await revise(env, p.token, key, '請調亮');
    assert.equal(rev.status, 403, String(key));
  }
  assert.equal(snapshot(env), before);
  // and the owner, same project, same moment: allowed (the 403s were the seat)
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
});

test('confirm / revision: only once delivered — picking, submitted, retouching, undelivered, reopened and a legacy stamp are 409 not_delivered', async () => {
  const env = setup();
  const created = await createProject(env);
  const c = await claim(env, created.token);
  const p = { ...created, key: c.key, id: created.project.id };
  const refusedNow = async label => {
    const before = snapshot(env);
    for (const res of [await confirm(env, p.token, p.key), await revise(env, p.token, p.key, '請調亮')]) {
      assert.equal(res.status, 409, label);
      assert.equal(await code(res), 'not_delivered', label);
    }
    assert.equal(snapshot(env), before, label);
  };
  await refusedNow('picking');
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: PA, rating: 1 }] })).status, 200);
  assert.equal((await guest(env, 'submit', p.token, p.key, { relationship: '本人' })).status, 200);
  await refusedNow('submitted');
  assert.equal((await admin(env, p.id, 'start-retouch')).status, 200);
  await refusedNow('retouching');
  // a finals snapshot sitting on the project without the stamp is not a delivery
  env.DB._db.prepare('UPDATE projects SET final_folders = ?').run(JSON.stringify([FINAL]));
  await refusedNow('retouching with kept finals');
  // a stamp without a snapshot (delivered before the finals feature) neither
  env.DB._db.prepare("UPDATE projects SET final_folders = NULL, delivered_at = '2026-01-01T00:00:00.000Z'").run();
  await refusedNow('legacy stamp');
  env.DB._db.prepare('UPDATE projects SET delivered_at = NULL').run();
  assert.equal((await deliver(env, p.id)).status, 200);
  assert.equal((await admin(env, p.id, 'undeliver')).status, 200);
  await refusedNow('undelivered');
  assert.equal((await deliver(env, p.id)).status, 200);
  assert.equal((await admin(env, p.id, 'reopen')).status, 200);
  await refusedNow('reopened');
  // positive control: delivered again, both go through
  assert.equal((await guest(env, 'submit', p.token, p.key, { relationship: '本人' })).status, 200);
  assert.equal((await admin(env, p.id, 'start-retouch')).status, 200);
  assert.equal((await deliver(env, p.id)).status, 200);
  assert.equal((await revise(env, p.token, p.key, '請調亮')).status, 200);
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
});

test('confirm / revision: a stamped project whose finals snapshot does not read is not delivered (409); not_delivered is said before the body is read', async () => {
  for (const bad of ['not json', '["/"]', '["_books/"]', '{}']) {
    const env = setup();
    const p = await delivered(env);
    env.DB._db.prepare('UPDATE projects SET final_folders = ?').run(bad);
    const before = snapshot(env);
    for (const res of [await confirm(env, p.token, p.key), await revise(env, p.token, p.key, '請調亮')]) {
      assert.equal(res.status, 409, bad);
      assert.equal(await code(res), 'not_delivered', bad);
    }
    assert.equal(snapshot(env), before, bad);
  }
  const env = setup();
  const p = await retouching(env);
  for (const res of [await revise(env, p.token, p.key, ''), await pick(env, 'POST', 'confirm', p.token, { key: p.key, body: 'not json' })]) {
    assert.equal(res.status, 409);
    assert.equal(await code(res), 'not_delivered');
  }
});

test('confirm / revision: archived, revoked and expired links are 401, nothing written', async () => {
  for (const kill of ['archive', 'archive-revived', 'revoke', 'expire', 'no-token']) {
    const env = setup();
    const p = await delivered(env);
    if (kill.startsWith('archive')) assert.equal((await admin(env, p.id, 'archive')).status, 200);
    if (kill === 'archive-revived') env.DB._db.prepare('UPDATE share_tokens SET revoked_at = NULL').run();
    if (kill === 'revoke') assert.equal((await call(env, `/api/shares/${p.token}/revoke`, { method: 'POST', token: SECRET })).status, 200);
    if (kill === 'expire') env.DB._db.prepare('UPDATE share_tokens SET expires_at = ?').run(days(-1));
    const t = kill === 'no-token' ? undefined : p.token;
    const before = snapshot(env);
    assert.equal((await confirm(env, t, p.key)).status, 401, kill);
    assert.equal((await revise(env, t, p.key, '請調亮')).status, 401, kill);
    assert.equal(snapshot(env), before, kill);
    assert.equal(env.NOTIFY_EMAIL.sent.length, 0, kill);
  }
});

test('confirm is idempotent: a repeat answers the first stamp and changes nothing; after the photographer marked it, the guest gets that stamp', async () => {
  const env = setup();
  const p = await delivered(env);
  const first = await (await confirm(env, p.token, p.key)).json();
  env.DB._db.prepare("UPDATE projects SET client_confirmed_at = '2026-01-02T00:00:00.000Z'").run();
  const before = snapshot(env);
  const again = await confirm(env, p.token, p.key);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { ok: true, confirmed_at: '2026-01-02T00:00:00.000Z' });
  assert.equal(snapshot(env), before);
  assert.ok(first.confirmed_at);
  assert.equal(env.NOTIFY_EMAIL.sent.length, 1, 'only the first confirm emails');

  const env2 = setup();
  const q = await delivered(env2);
  const marked = await (await admin(env2, q.id, 'confirm')).json();
  const g = await confirm(env2, q.token, q.key);
  assert.equal(g.status, 200);
  assert.equal((await g.json()).confirmed_at, marked.client_confirmed_at);
  assert.equal(confirmation(env2).client_confirmed_by, 'photographer', 'the record of who confirmed is not rewritten');
});

test('confirm body: anything but nothing or a JSON object is 400; over the cap is 413; nothing written', async () => {
  const env = setup();
  const p = await delivered(env);
  const before = snapshot(env);
  for (const body of ['[]', '"x"', '1', 'null', 'not json']) {
    const res = await pick(env, 'POST', 'confirm', p.token, { key: p.key, body });
    assert.equal(res.status, 400, body);
  }
  const big = await pick(env, 'POST', 'confirm', p.token, { key: p.key, body: JSON.stringify({ pad: 'x'.repeat(20000) }) });
  assert.equal(big.status, 413);
  assert.equal(await code(big), 'too_large');
  assert.equal(snapshot(env), before);
});

// ─── guest revision request ──────────────────────────────────────────────────

test('revision: stored with the picker, the gallery stays open, owner and viewers see it is open (only the owner reads the text); admin sees the request', async () => {
  const env = setup();
  const p = await delivered(env);
  const res = await revise(env, p.token, p.key, '  第 3 張請把背景的路人修掉  ');
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.message, '第 3 張請把背景的路人修掉');
  assert.match(json.created_at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const r = one(env, 'SELECT * FROM revision_requests');
  assert.equal(r.project_id, p.id);
  assert.equal(r.picker_id, p.pickerId);
  assert.equal(r.message, '第 3 張請把背景的路人修掉');
  assert.equal(r.resolved_at, null);
  assert.ok(r.id);
  assert.deepEqual(confirmation(env), { client_confirmed_at: null, client_confirmed_by: null });
  for (const key of [p.key, undefined, 'not-a-key']) {
    const s = await state(env, p.token, key);
    assert.equal(s.mode, 'delivered', 'the gallery stays open while changes are asked for');
    assert.deepEqual(s.final_folders, [FINAL]);
    assert.equal(s.revision_open, true, 'viewers see that changes were asked for');
    // the text is the owner's own words (body, skin…): like notes and pins,
    // only the seat holder reads it back; a viewer gets null
    assert.equal(s.revision_message, key === p.key ? '第 3 張請把背景的路人修掉' : null);
    assert.equal(s.confirmed_at, null);
    assert.equal('revision_requests' in s, false);
  }
  assert.equal((await call(env, withT(`/${FA.split('/').map(encodeURIComponent).join('/')}`, p.token))).status, 200);
  const row = await listRow(env, p.id);
  assert.equal(row.open_revision_count, 1);
  const d = await detail(env, p.id);
  assert.equal(d.project.open_revision_count, 1);
  assert.equal(d.revision_requests.length, 1);
  // (kind / marks / finals / message_auto / photo_count: docs/revision-pins.md §4.6)
  assert.deepEqual(Object.keys(d.revision_requests[0]).sort(), ['created_at', 'finals', 'id', 'kind', 'marks', 'message', 'message_auto', 'photo_count', 'picker_id', 'picker_name', 'resolved_at']);
  assert.equal(d.revision_requests[0].kind, 'text');
  assert.equal(d.revision_requests[0].picker_name, '王小明');
  assert.equal(d.revision_requests[0].message, '第 3 張請把背景的路人修掉');
});

test('revision state: only the latest open message, only to the owner — never a resolved one, never another project\'s, never to a viewer', async () => {
  const env = setup();
  const p = await delivered(env);
  const q = await delivered(env);
  assert.equal((await revise(env, q.token, q.key, 'Q 的訊息')).status, 200);
  assert.equal((await revise(env, p.token, p.key, '第一次')).status, 200);
  assert.equal((await revise(env, p.token, p.key, '第二次')).status, 200);
  assert.equal((await state(env, p.token, p.key)).revision_message, '第二次');
  const viewer = await state(env, p.token);
  assert.equal(viewer.revision_open, true);
  assert.equal(viewer.revision_message, null, 'a viewer never reads the text');
  // another project's owner key on this link is a viewer here
  assert.equal((await state(env, p.token, q.key)).revision_message, null);
  // the newest one handled by hand: the next open one shows
  env.DB._db.prepare("UPDATE revision_requests SET resolved_at = 'x' WHERE message = '第二次'").run();
  assert.equal((await state(env, p.token, p.key)).revision_message, '第一次');
  assert.equal((await state(env, p.token)).revision_message, null);
  env.DB._db.prepare("UPDATE revision_requests SET resolved_at = 'x' WHERE message = '第一次'").run();
  const s = await state(env, p.token, p.key);
  assert.equal(s.revision_open, false);
  assert.equal(s.revision_message, null);
  assert.equal((await state(env, q.token, q.key)).revision_message, 'Q 的訊息');
  // a seat reset: the old owner's key reads as a viewer
  assert.equal((await revise(env, p.token, p.key, '第三次')).status, 200);
  assert.equal((await admin(env, p.id, 'reset-seat')).status, 200);
  const reset = await state(env, p.token, p.key);
  assert.equal(reset.revision_open, true);
  assert.equal(reset.revision_message, null);
});

test('revision message: trimmed, 1–1000 characters, line breaks kept, other control characters dropped; else 400 invalid_message', async () => {
  const env = setup();
  const p = await delivered(env);
  const before = snapshot(env);
  const bads = [undefined, null, 7, ['x'], { t: 'x' }, '', '   ', '\u0000\u0007 ', '\n\n', 'x'.repeat(1001), '😀'.repeat(1001)];
  for (const bad of bads) {
    const res = await guest(env, 'revision', p.token, p.key, bad === undefined ? {} : { message: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(await code(res), 'invalid_message', JSON.stringify(bad));
  }
  for (const body of ['not json', '[]', 'null']) {
    assert.equal((await pick(env, 'POST', 'revision', p.token, { key: p.key, body })).status, 400, body);
  }
  const big = await pick(env, 'POST', 'revision', p.token, { key: p.key, body: JSON.stringify({ message: 'x'.repeat(20000) }) });
  assert.equal(big.status, 413);
  assert.equal(await code(big), 'too_large');
  assert.equal(snapshot(env), before);
  // the edges that pass: exactly 1000 characters (an emoji is one)
  assert.equal((await revise(env, p.token, p.key, '😀'.repeat(1000))).status, 200);
  assert.equal((await revise(env, p.token, p.key, 'x')).status, 200);
  const res = await revise(env, p.token, p.key, '第一行\r\n第二行\r第三行\t結尾\u0000\u0007\u001b[31m  \u0085!');
  assert.equal(res.status, 200);
  const stored = one(env, 'SELECT message FROM revision_requests ORDER BY rowid DESC LIMIT 1').message;
  assert.equal(stored, '第一行\n第二行\n第三行 結尾[31m!');
  assert.equal((await res.json()).message, stored);
});

test('revision caps: at most 10 open (409 revision_open_cap) and 50 in all (409 revision_cap); nothing written past them', async () => {
  const env = setup();
  const p = await delivered(env);
  for (let i = 0; i < 10; i++) assert.equal((await revise(env, p.token, p.key, `第 ${i} 個`)).status, 200);
  const before = snapshot(env);
  const over = await revise(env, p.token, p.key, '第 11 個');
  assert.equal(over.status, 409);
  const oj = await over.json();
  assert.equal(oj.code, 'revision_open_cap');
  assert.equal(oj.max, 10);
  assert.equal(typeof oj.error, 'string');
  assert.equal(snapshot(env), before);
  // a re-deliver resolves them; then there is room again
  assert.equal((await deliver(env, p.id, [FINAL2])).status, 200);
  assert.equal(openCount(env), 0);
  assert.equal((await revise(env, p.token, p.key, '再一個')).status, 200);
  // 50 in all, open or not
  env.DB._db.prepare('UPDATE revision_requests SET resolved_at = ?').run('2026-01-01T00:00:00.000Z');
  for (let i = 0; i < 39; i++) {
    env.DB._db.prepare("INSERT INTO revision_requests (id, project_id, picker_id, message, created_at, resolved_at) VALUES (?, ?, NULL, 'x', '2026-01-01', '2026-01-01')")
      .run(`seed${i}`, p.id);
  }
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM revision_requests').n, 50);
  const capped = await revise(env, p.token, p.key, '第 51 個');
  assert.equal(capped.status, 409);
  const cj = await capped.json();
  assert.equal(cj.code, 'revision_cap');
  assert.equal(cj.max, 50);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM revision_requests').n, 50);
  // the 50 is per project: another project still takes one
  const q = await delivered(env);
  assert.equal((await revise(env, q.token, q.key, '別的專案')).status, 200);
});

test('revision after confirming is 409 already_confirmed; confirming resolves the open requests in the same write', async () => {
  const env = setup();
  const p = await delivered(env);
  assert.equal((await revise(env, p.token, p.key, '請調亮')).status, 200);
  assert.equal((await revise(env, p.token, p.key, '還有第 5 張')).status, 200);
  assert.equal(openCount(env), 2);
  const c = await confirm(env, p.token, p.key);
  assert.equal(c.status, 200);
  const at = (await c.json()).confirmed_at;
  assert.equal(openCount(env), 0, 'confirmed never leaves a request open');
  assert.deepEqual(rows(env, 'SELECT resolved_at FROM revision_requests').map(r => r.resolved_at), [at, at]);
  const writes = env.DB._writes().filter(s => /client_confirmed_at = \?/.test(s) || /UPDATE revision_requests/.test(s));
  assert.ok(writes.length >= 2);
  const before = snapshot(env);
  const res = await revise(env, p.token, p.key, '我又想改');
  assert.equal(res.status, 409);
  assert.equal(await code(res), 'already_confirmed');
  assert.equal(snapshot(env), before);
  const s = await state(env, p.token, p.key);
  assert.equal(s.revision_open, false);
  assert.equal(s.revision_message, null);
  assert.equal(s.confirmed_at, at);
});

// ─── what clears a confirmation ──────────────────────────────────────────────

test('a repeat deliver (更換精修) clears the confirmation, resolves the open requests and keeps the first delivered_at', async () => {
  const env = setup();
  const p = await delivered(env);
  env.DB._db.prepare("UPDATE projects SET delivered_at = '2026-01-01T00:00:00.000Z'").run();
  assert.equal((await revise(env, p.token, p.key, '請調亮')).status, 200);
  env.DB._db.prepare("INSERT INTO revision_requests (id, project_id, message, created_at, resolved_at) VALUES ('old', ?, 'done', '2025-12-01', '2025-12-02')").run(p.id);
  const res = await deliver(env, p.id, [FINAL2]);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).delivered_at, '2026-01-01T00:00:00.000Z');
  assert.equal(openCount(env), 0);
  assert.equal(one(env, "SELECT resolved_at FROM revision_requests WHERE id = 'old'").resolved_at, '2025-12-02', 'an old resolution is not rewritten');
  const s = await state(env, p.token);
  assert.deepEqual(s.final_folders, [FINAL2]);
  assert.equal(s.revision_open, false);
  // and a confirmed delivery re-delivered is not confirmed any more
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
  assert.ok(confirmation(env).client_confirmed_at);
  assert.equal((await deliver(env, p.id, [FINAL])).status, 200);
  assert.deepEqual(confirmation(env), { client_confirmed_at: null, client_confirmed_by: null });
  assert.equal((await state(env, p.token)).confirmed_at, null);
  // the photographer's own mark is cleared the same way
  assert.equal((await admin(env, p.id, 'confirm')).status, 200);
  assert.equal((await deliver(env, p.id, [FINAL2])).status, 200);
  assert.deepEqual(confirmation(env), { client_confirmed_at: null, client_confirmed_by: null });
});

test('undeliver and reopen clear the confirmation (and leave open requests for the photographer)', async () => {
  for (const action of ['undeliver', 'reopen']) {
    const env = setup();
    const p = await delivered(env);
    assert.equal((await confirm(env, p.token, p.key)).status, 200);
    env.DB._db.prepare("INSERT INTO revision_requests (id, project_id, message, created_at) VALUES ('r', ?, 'm', '2026-01-01')").run(p.id);
    assert.equal((await admin(env, p.id, action)).status, 200, action);
    assert.deepEqual(confirmation(env), { client_confirmed_at: null, client_confirmed_by: null }, action);
    assert.equal(openCount(env), 1, action);
    // and in picking mode the guest's state carries the defaults
    const s = await state(env, p.token, p.key);
    assert.equal(s.mode, 'picking');
    assert.equal(s.confirmed_at, null);
    assert.equal(s.revision_open, false);
    assert.equal(s.revision_message, null);
  }
});

test('a refused deliver (a reopen racing it) clears nothing and resolves nothing', async () => {
  const env = setup();
  const p = await delivered(env);
  assert.equal((await revise(env, p.token, p.key, '請調亮')).status, 200);
  const before = snapshot(env);
  landOnce(env, /^\s*UPDATE projects SET delivered_at/i, "UPDATE projects SET phase = 'picking'");
  const res = await deliver(env, p.id, [FINAL2]);
  assert.equal(res.status, 409);
  assert.equal(openCount(env), 1);
  assert.equal(snapshot(env), before.replace('"phase":"retouching"', '"phase":"picking"'));
});

test('state in picking mode gives the defaults even when the row says otherwise (hand edit)', async () => {
  const env = setup();
  const p = await retouching(env);
  env.DB._db.prepare("UPDATE projects SET client_confirmed_at = 'x', client_confirmed_by = 'guest'").run();
  env.DB._db.prepare("INSERT INTO revision_requests (id, project_id, message, created_at) VALUES ('r', ?, 'secret', '2026-01-01')").run(p.id);
  for (const key of [p.key, undefined]) {
    const s = await state(env, p.token, key);
    assert.equal(s.mode, 'picking');
    assert.equal(s.confirmed_at, null);
    assert.equal(s.revision_open, false);
    assert.equal(s.revision_message, null);
  }
});

// ─── races ───────────────────────────────────────────────────────────────────

test('races: a confirm landing inside a revision request wins (409, no row); an undeliver inside a confirm wins (409, not confirmed)', async () => {
  const env = setup();
  const p = await delivered(env);
  landOnce(env, /^\s*INSERT INTO revision_requests/i, "UPDATE projects SET client_confirmed_at = '2026-01-01T00:00:00.000Z', client_confirmed_by = 'guest'");
  const r = await revise(env, p.token, p.key, '請調亮');
  assert.equal(r.status, 409);
  assert.equal(await code(r), 'already_confirmed');
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM revision_requests').n, 0);

  const env2 = setup();
  const q = await delivered(env2);
  landOnce(env2, /^\s*UPDATE projects SET client_confirmed_at/i, 'UPDATE projects SET delivered_at = NULL');
  const c = await confirm(env2, q.token, q.key);
  assert.equal(c.status, 409);
  assert.equal(await code(c), 'not_delivered');
  assert.deepEqual(confirmation(env2), { client_confirmed_at: null, client_confirmed_by: null });
  assert.equal(env2.NOTIFY_EMAIL.sent.length, 0);

  // a seat reset inside the write: 403, nothing
  const env3 = setup();
  const s = await delivered(env3);
  landOnce(env3, /^\s*UPDATE projects SET client_confirmed_at/i, 'UPDATE projects SET owner_picker_id = NULL');
  assert.equal((await confirm(env3, s.token, s.key)).status, 403);
  landOnce(env3, /^\s*INSERT INTO revision_requests/i, 'UPDATE projects SET owner_picker_id = NULL');
  assert.equal((await revise(env3, s.token, s.key, 'x')).status, 403);
  assert.equal(confirmation(env3).client_confirmed_at, null);
  assert.equal(one(env3, 'SELECT COUNT(*) AS n FROM revision_requests').n, 0);

  // an archive inside the write: 401
  const env4 = setup();
  const a = await delivered(env4);
  landOnce(env4, /^\s*INSERT INTO revision_requests/i, "UPDATE projects SET archived_at = '2026-01-01'");
  assert.equal((await revise(env4, a.token, a.key, 'x')).status, 401);
  assert.equal(one(env4, 'SELECT COUNT(*) AS n FROM revision_requests').n, 0);
});

test('races: confirm and revision sent together never leave a confirmed project with an open request', async () => {
  for (let i = 0; i < 5; i++) {
    const env = setup();
    const p = await delivered(env);
    const results = await Promise.all(i % 2
      ? [confirm(env, p.token, p.key), revise(env, p.token, p.key, '請調亮')]
      : [revise(env, p.token, p.key, '請調亮'), confirm(env, p.token, p.key)]);
    for (const r of results) assert.ok([200, 409].includes(r.status));
    assert.ok(confirmation(env).client_confirmed_at);
    assert.equal(openCount(env), 0);
  }
});

// ─── admin: mark complete ────────────────────────────────────────────────────

test('admin confirm: the photographer marks a delivered project complete; stamped as the photographer; resolves open requests; no email', async () => {
  const env = setup();
  const p = await delivered(env);
  assert.equal((await revise(env, p.token, p.key, '請調亮')).status, 200);
  env.NOTIFY_EMAIL.sent.length = 0;
  const res = await admin(env, p.id, 'confirm');
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.client_confirmed_by, 'photographer');
  assert.match(json.client_confirmed_at, /^\d{4}-/);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(res.headers.get('Vary'), 'Authorization');
  assert.deepEqual(confirmation(env), { client_confirmed_at: json.client_confirmed_at, client_confirmed_by: 'photographer' });
  assert.equal(openCount(env), 0);
  assert.equal(env.NOTIFY_EMAIL.sent.length, 0);
  // idempotent, and the guest sees the time but not who
  const again = await (await admin(env, p.id, 'confirm')).json();
  assert.equal(again.client_confirmed_at, json.client_confirmed_at);
  const s = await state(env, p.token);
  assert.equal(s.confirmed_at, json.client_confirmed_at);
  assert.equal('client_confirmed_by' in s, false);
  const row = await listRow(env, p.id);
  assert.equal(row.client_confirmed_by, 'photographer');
  assert.equal(row.client_confirmed_at, json.client_confirmed_at);
  assert.equal(row.open_revision_count, 0);
  const d = await detail(env, p.id);
  assert.equal(d.project.client_confirmed_by, 'photographer');
  assert.equal(d.revision_requests[0].resolved_at, json.client_confirmed_at);
});

test('admin confirm: admin token only (401), this photographer only (404), delivered only (409 not_delivered); nothing written', async () => {
  const env = setup();
  const p = await retouching(env);
  const before = snapshot(env);
  for (const token of ['', 'wrong', p.token]) assert.equal((await admin(env, p.id, 'confirm', undefined, token)).status, 401);
  assert.equal((await call(env, withT(`/api/admin/projects/${p.id}/confirm`, p.token), { method: 'POST' })).status, 401);
  const nd = await admin(env, p.id, 'confirm');
  assert.equal(nd.status, 409);
  assert.equal(await code(nd), 'not_delivered');
  assert.equal(snapshot(env), before);
  assert.equal((await deliver(env, p.id)).status, 200);
  env.DB._db.prepare("UPDATE projects SET photographer_id = 'other'").run();
  const other = snapshot(env);
  for (const id of [p.id, 'nope']) assert.equal((await admin(env, id, 'confirm')).status, 404);
  assert.equal(snapshot(env), other);
  // positive: back to this photographer, it confirms
  env.DB._db.prepare("UPDATE projects SET photographer_id = 'default'").run();
  assert.equal((await admin(env, p.id, 'confirm')).status, 200);
  // the write itself is scoped too: a project that changes hands between the
  // route's read and its write is 404 and untouched
  const env2 = setup();
  const q = await delivered(env2);
  landOnce(env2, /^\s*UPDATE projects SET client_confirmed_at = \?, client_confirmed_by = 'photographer'/i, "UPDATE projects SET photographer_id = 'other'");
  assert.equal((await admin(env2, q.id, 'confirm')).status, 404);
  assert.deepEqual(confirmation(env2), { client_confirmed_at: null, client_confirmed_by: null });
  // and an undeliver landing there is 409 not_delivered, not confirmed
  const env3 = setup();
  const r = await delivered(env3);
  landOnce(env3, /^\s*UPDATE projects SET client_confirmed_at = \?, client_confirmed_by = 'photographer'/i, 'UPDATE projects SET delivered_at = NULL');
  const raced = await admin(env3, r.id, 'confirm');
  assert.equal(raced.status, 409);
  assert.equal(await code(raced), 'not_delivered');
  assert.deepEqual(confirmation(env3), { client_confirmed_at: null, client_confirmed_by: null });
});

test('admin detail lists at most 50 requests, newest first; the dashboard counts do not move on a confirm', async () => {
  const env = setup();
  const p = await delivered(env);
  for (let i = 0; i < 55; i++) {
    env.DB._db.prepare('INSERT INTO revision_requests (id, project_id, picker_id, message, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(`r${i}`, p.id, p.pickerId, `m${i}`, `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`, i < 52 ? 'x' : null);
  }
  const d = await detail(env, p.id);
  assert.equal(d.revision_requests.length, 50);
  assert.equal(d.revision_requests[0].message, 'm54');
  assert.equal(d.revision_requests[49].message, 'm5');
  assert.equal(d.project.open_revision_count, 3);
  assert.equal((await listRow(env, p.id)).open_revision_count, 3);
  const stats = async () => (await call(env, '/api/admin/stats', { token: SECRET })).text();
  const before = await stats();
  assert.equal((await admin(env, p.id, 'confirm')).status, 200);
  assert.equal(await stats(), before);
});

// ─── email ───────────────────────────────────────────────────────────────────

test('email: a revision request mails the photographer — title, name, the message as text, escaped in HTML, a link back to the project', async () => {
  const env = setup();
  const p = await delivered(env);
  env.DB._db.prepare("UPDATE pickers SET name = ?").run('Eve\r\nBcc: x@evil.test\u202Egpj.exe\u200E\u200F\u202A\u202B\u202C\u202D\u2066\u2067\u2068\u2069');
  const msg = '<script>alert(1)</script> & 第 3 張\n請修';
  assert.equal((await revise(env, p.token, p.key, msg)).status, 200);
  const sent = env.NOTIFY_EMAIL.sent;
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.equal(m.to, 'studio@example.com');
  assert.equal(m.from, 'notify@imhoti.tw');
  assert.ok(!/[\r\n]/.test(m.subject), m.subject);
  // no bidirectional override can reorder what the subject line shows
  assert.ok(!/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(m.subject), JSON.stringify(m.subject));
  assert.ok(m.subject.includes('gpj.exe'), 'the rest of the name stays');
  assert.match(m.subject, /要求修改/);
  assert.match(m.subject, /王先生 婚紗/);
  assert.ok(!m.subject.includes('<script>'), 'the message is never in the subject');
  const link = `https://imhoti.tw/studio/admin.html#project=${encodeURIComponent(p.id)}`;
  assert.ok(m.text.includes(msg), 'plain text carries the message as typed');
  assert.ok(m.text.includes(link));
  assert.ok(m.text.includes('王先生 婚紗'));
  assert.ok(!m.html.includes('<script>'));
  assert.ok(m.html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; 第 3 張'));
  assert.ok(m.html.includes(`href="${link}"`));
  // only the keys the existing mail sends: no header can be injected
  assert.deepEqual(Object.keys(m).sort(), ['from', 'html', 'subject', 'text', 'to']);
});

test('email: a guest confirm mails once; a mail that throws or is not configured never fails the request', async () => {
  const env = setup();
  const p = await delivered(env);
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
  assert.equal(env.NOTIFY_EMAIL.sent.length, 1);
  assert.match(env.NOTIFY_EMAIL.sent[0].subject, /確認完成/);
  assert.ok(env.NOTIFY_EMAIL.sent[0].text.includes(`admin.html#project=${encodeURIComponent(p.id)}`));
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
  assert.equal(env.NOTIFY_EMAIL.sent.length, 1);

  for (const extra of [{ NOTIFY_EMAIL: fakeMailer({ fail: true }) }, { NOTIFY_EMAIL: undefined }, { PHOTOGRAPHER_EMAIL: undefined }]) {
    const e = setup({ extra });
    const q = await delivered(e);
    const r = await revise(e, q.token, q.key, '請調亮');
    assert.equal(r.status, 200);
    assert.equal(one(e, 'SELECT COUNT(*) AS n FROM revision_requests').n, 1);
    assert.equal((await confirm(e, q.token, q.key)).status, 200);
    assert.ok(confirmation(e).client_confirmed_at);
  }
});

// ─── before the migration ────────────────────────────────────────────────────

for (const [label, schema] of [['before the migration', BEFORE], ['with the ALTERs run but not the CREATE TABLE', HALF]]) {
  test(`${label}: every existing route works; confirm, revision and admin confirm answer 500 confirm_unavailable`, async () => {
    const env = setup({ schema });
    const p = await retouching(env); // create, claim, save, submit, start-retouch
    env.NOTIFY_EMAIL.sent.length = 0; // the submit's own email
    const row = await listRow(env, p.id);
    assert.ok(row, 'the list loads');
    assert.equal(row.client_confirmed_at, null);
    assert.equal(row.client_confirmed_by, null);
    assert.equal(row.open_revision_count, 0);
    assert.equal(row.submission_count, 1);
    let d = await detail(env, p.id);
    assert.equal(d.project.client_confirmed_at, null);
    assert.equal(d.project.open_revision_count, 0);
    assert.deepEqual(d.revision_requests, []);
    assert.equal((await deliver(env, p.id)).status, 200);
    assert.equal((await deliver(env, p.id, [FINAL2])).status, 200);
    const s = await state(env, p.token, p.key);
    assert.equal(s.mode, 'delivered');
    assert.equal(s.confirmed_at, null);
    assert.equal(s.revision_open, false);
    assert.equal(s.revision_message, null);
    const before = JSON.stringify(rows(env, 'SELECT * FROM projects'));
    for (const res of [await confirm(env, p.token, p.key), await revise(env, p.token, p.key, '請調亮'), await admin(env, p.id, 'confirm')]) {
      assert.equal(res.status, 500, label);
      assert.equal(await code(res), 'confirm_unavailable', label);
    }
    assert.equal(JSON.stringify(rows(env, 'SELECT * FROM projects')), before);
    assert.equal(env.NOTIFY_EMAIL.sent.length, 0);
    // a viewer is still refused first
    assert.equal((await confirm(env, p.token, undefined)).status, 403);
    assert.equal((await admin(env, p.id, 'undeliver')).status, 200);
    assert.equal(one(env, 'SELECT delivered_at FROM projects').delivered_at, null);
    assert.equal((await deliver(env, p.id)).status, 200);
    const reopened = await admin(env, p.id, 'reopen');
    assert.equal(reopened.status, 200);
    assert.deepEqual({ ...one(env, 'SELECT phase, delivered_at FROM projects') }, { phase: 'picking', delivered_at: null });
    assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: PA, rating: 2 }] })).status, 200);
    d = await detail(env, p.id);
    assert.equal(d.selections[0].rating, 2);
    assert.equal((await call(env, '/api/admin/stats', { token: SECRET })).status, 200);
  });
}
