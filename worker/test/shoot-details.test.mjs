// 拍攝日期 and 拍攝類型 on a client account.
//
// A client registering gave name, email and password, and the photographer was
// left guessing which R2 folder the account belonged to. The folders are named
// by date, so a shoot date is the hint that closes that gap; the type is what
// tells an engagement shoot from a banquet when two accounts share a day.
//
// Both live in new `users` columns, which means a hand-run migration, which
// means every statement naming one has to work on a database that has not had
// it run yet. That is most of this file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { fakeBucket, fakeDB, ctx, req } from './fakes.mjs';

const SECRET = 'photographer-secret';

// Exactly the two statements the photographer pastes into the D1 console.
// Kept here rather than described, so the ordering test below is run against
// the SQL that actually ships in the report.
const MIGRATION = [
  "ALTER TABLE users ADD COLUMN shoot_date TEXT DEFAULT '';",
  "ALTER TABLE users ADD COLUMN shoot_type TEXT DEFAULT '';",
].join('\n');

// Same trick as session-token.test.mjs, scoped to the users block: `created_at`
// is the last column the deployed database has, so "before the migration" is
// everything after it stripped.
const PRE_MIGRATION = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
  .replace(/(CREATE TABLE IF NOT EXISTS users \([\s\S]*?created_at TEXT DEFAULT \(datetime\('now'\)\)),[\s\S]*?(\n\);)/, '$1$2');
const PRE_USERS = /CREATE TABLE IF NOT EXISTS users \(([\s\S]*?)\n\);/.exec(PRE_MIGRATION)[1];

const setup = (opts = {}) => ({
  imagepicker: fakeBucket(), PHOTOGRAPHER_TOKEN: SECRET, DB: fakeDB(opts),
});

const call = (env, path, opts = {}) => worker.fetch(req(path, opts), env, ctx);

const register = (env, body) =>
  call(env, '/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

async function clients(env) {
  const res = await call(env, '/api/admin/clients', { token: SECRET });
  const body = await res.json().catch(() => null);
  assert.equal(res.status, 200, `listing refused: ${JSON.stringify(body)}`);
  return body;
}

const setFields = (env, id, body) =>
  call(env, `/api/admin/clients/${id}/permissions`, {
    method: 'PUT', token: SECRET, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const storedRow = (env, id) =>
  env.DB._db.prepare('SELECT * FROM users WHERE id = ?').get(id);

const columns = db => db.prepare('PRAGMA table_info(users)').all().map(c => c.name);

// ─── registration collects them ──────────────────────────────────────────────

test('registration stores the shoot date and type it was given', async () => {
  const env = setup();
  const res = await register(env, {
    name: '王小明', email: 'W@Example.com', password: 'secret1',
    shoot_date: '2026-08-19', shoot_type: '婚紗',
  });
  assert.equal(res.status, 201, JSON.stringify(await res.json()));
  const [row] = await clients(env);
  assert.equal(row.shoot_date, '2026-08-19');
  assert.equal(row.shoot_type, '婚紗');
});

test('「未定」 is a date the client gave, not a date they withheld', async () => {
  // The whole reason the option exists: a client who registers before the day
  // is settled has answered, and must not be chased up as if they had not.
  const env = setup();
  await register(env, { name: 'A', email: 'a@t', password: 'p', shoot_date: '未定', shoot_type: '婚禮' });
  const [row] = await clients(env);
  assert.equal(row.shoot_date, '未定');
});

test('a 其他 type is stored as the text the client typed', async () => {
  // 其他 opens a text box, so the column is free text and the Worker keeps no
  // list of its own to check it against.
  const env = setup();
  await register(env, { name: 'A', email: 'a@t', password: 'p', shoot_date: '2026-08-19', shoot_type: '寵物寫真' });
  const [row] = await clients(env);
  assert.equal(row.shoot_type, '寵物寫真');
});

test('an account registered without either reads back as unfilled, not as null', async () => {
  const env = setup();
  await register(env, { name: 'A', email: 'a@t', password: 'p' });
  const [row] = await clients(env);
  assert.equal(row.shoot_date, '');
  assert.equal(row.shoot_type, '');
});

// Both fields, because the two guards are separate lines and a missing one
// looks exactly like the other one working.
for (const [field, bad] of [['shoot_date', { y: 2026 }], ['shoot_type', ['婚紗']]]) {
  test(`registering with a ${field} that is not a string is refused rather than bound`, async () => {
    const env = setup();
    const res = await register(env, {
      name: 'A', email: 'a@t', password: 'p', shoot_date: '2026-08-19', shoot_type: '婚紗',
      [field]: bad,
    });
    assert.equal(res.status, 400, JSON.stringify(await res.json()));
    assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0,
      'the account was created anyway');
  });
}

// ─── the photographer edits them ─────────────────────────────────────────────

async function seeded(env) {
  await register(env, {
    name: '王小明', email: 'w@t', password: 'p', shoot_date: '2026-08-19', shoot_type: '婚紗',
  });
  await setFields(env, 1, { can_book: true, can_upload: false, folders: ['20260819/'] });
  return 1;
}

test('the photographer can correct both fields', async () => {
  // Clients fill these in wrong and the photographer is the one who finds out.
  const env = setup();
  const id = await seeded(env);
  const res = await setFields(env, id, {
    can_book: true, can_upload: false, shoot_date: '2026-09-01', shoot_type: '親子',
  });
  assert.equal(res.status, 200, JSON.stringify(await res.json()));
  const row = storedRow(env, id);
  assert.equal(row.shoot_date, '2026-09-01');
  assert.equal(row.shoot_type, '親子');
});

test('editing the shoot fields leaves the folders alone', async () => {
  // The two cells save independently, so a shoot edit that carried no folders
  // must not be read as "this client now has none".
  const env = setup();
  const id = await seeded(env);
  await setFields(env, id, { can_book: true, can_upload: false, shoot_type: '婚禮' });
  const row = storedRow(env, id);
  assert.equal(row.folder_path, '["20260819/"]');
  assert.equal(row.shoot_date, '2026-08-19', 'the field that was not sent was overwritten');
  assert.equal(row.shoot_type, '婚禮');
});

test('editing the folders leaves the shoot fields alone', async () => {
  const env = setup();
  const id = await seeded(env);
  await setFields(env, id, { can_book: true, can_upload: false, folders: ['20260901/'] });
  const row = storedRow(env, id);
  assert.equal(row.shoot_date, '2026-08-19');
  assert.equal(row.shoot_type, '婚紗');
});

for (const [field, bad] of [['shoot_date', 20260819], ['shoot_type', ['婚禮']]]) {
  test(`an edit with a ${field} of the wrong type is refused before anything is written`, async () => {
    const env = setup();
    const id = await seeded(env);
    const res = await setFields(env, id, { can_book: false, can_upload: true, [field]: bad });
    assert.equal(res.status, 400, JSON.stringify(await res.json()));
    assert.equal(storedRow(env, id).shoot_date, '2026-08-19');
    assert.equal(storedRow(env, id).shoot_type, '婚紗');
    const perm = env.DB._db.prepare('SELECT * FROM permissions WHERE user_id = ?').get(id);
    assert.equal(perm.can_upload, 0, 'the permissions landed on a request that was refused');
  });
}

test('clearing a shoot field back to unfilled is allowed', async () => {
  const env = setup();
  const id = await seeded(env);
  await setFields(env, id, { can_book: true, can_upload: false, shoot_date: '', shoot_type: '' });
  const row = storedRow(env, id);
  assert.equal(row.shoot_date, '');
  assert.equal(row.shoot_type, '');
});

// ─── the columns do not exist on the live database yet ───────────────────────

test('the pre-migration schema really is missing both columns', () => {
  // Guards the strip above: a regex that quietly matched nothing would make
  // every test below a test of the migrated schema.
  assert.equal(/\bshoot_date\b/.test(PRE_USERS), false, 'the pre-migration users table still declares shoot_date');
  assert.equal(/\bshoot_type\b/.test(PRE_USERS), false, 'the pre-migration users table still declares shoot_type');
});

test('an unmigrated database still lists clients, reading as unfilled', async () => {
  // schema.sql is CREATE TABLE IF NOT EXISTS, so the deployed D1 keeps the old
  // shape until the ALTERs are pasted in. Losing the whole client table over a
  // column nobody has added yet is a worse failure than showing no date.
  const env = setup({ schema: PRE_MIGRATION });
  await register(env, { name: 'A', email: 'a@t', password: 'p', shoot_date: '2026-08-19', shoot_type: '婚紗' });
  const rows = await clients(env);
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0].shoot_date, '');
  assert.equal(rows[0].shoot_type, '');
  assert.equal(rows[0].name, 'A', 'the rest of the row went missing with the columns');
});

test('an unmigrated database still takes registrations', async () => {
  const env = setup({ schema: PRE_MIGRATION });
  const res = await register(env, {
    name: 'A', email: 'a@t', password: 'p', shoot_date: '2026-08-19', shoot_type: '婚紗',
  });
  assert.equal(res.status, 201, JSON.stringify(await res.json()));
  assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  // and the account is usable — the permissions row goes in either way
  assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM permissions').get().n, 1);
});

test('an unmigrated database refuses a shoot edit loudly and writes nothing', async () => {
  // The photographer is the only one who can fix this, and the only way they
  // learn the migration has not been run is being told. Refused before the
  // permissions are touched, so the request is all-or-nothing.
  const env = setup({ schema: PRE_MIGRATION });
  await register(env, { name: 'A', email: 'a@t', password: 'p' });
  const res = await setFields(env, 1, { can_book: true, can_upload: true, shoot_date: '2026-08-19' });
  assert.equal(res.status, 500, JSON.stringify(await res.json()));
  const perm = env.DB._db.prepare('SELECT * FROM permissions WHERE user_id = 1').get();
  assert.equal(perm.can_book, 0, 'the permissions landed on a request that failed');
});

test('an unmigrated database still takes a folders edit', async () => {
  // The columns are new; the folder picker is not, and must not stop working
  // because of them.
  const env = setup({ schema: PRE_MIGRATION });
  await register(env, { name: 'A', email: 'a@t', password: 'p' });
  const res = await setFields(env, 1, { can_book: false, can_upload: false, folders: ['20260819/'] });
  assert.equal(res.status, 200, JSON.stringify(await res.json()));
  assert.equal(storedRow(env, 1).folder_path, '["20260819/"]');
});

// ─── a fresh database and a migrated one are the same database ───────────────

test('the migration produces the column order a fresh schema.sql gives', async () => {
  // The trap the share_tokens comments describe: ALTER TABLE can only append,
  // so a column declared anywhere but the end of the CREATE gives a fresh
  // database a different shape from the migrated one the photographer runs —
  // and `SELECT *` then hands back the columns in a different order on each.
  const migrated = fakeDB({ schema: PRE_MIGRATION });
  migrated._db.exec(MIGRATION);
  assert.deepEqual(columns(migrated._db), columns(fakeDB()._db));
});

test('a fresh database defaults both columns to unfilled', async () => {
  const env = setup();
  env.DB._db.exec("INSERT INTO users (email, password_hash, name) VALUES ('x@t', 'h:s', 'X')");
  const row = storedRow(env, 1);
  assert.equal(row.shoot_date, '');
  assert.equal(row.shoot_type, '');
});
