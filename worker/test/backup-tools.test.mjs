// The D1 backup workflow's helpers (.github/workflows/d1-backup.yml,
// docs/backup.md): worker/tools/verify-backup.mjs (the gate before upload and
// the restore drill) and worker/tools/prune-backups.mjs (which old backups on
// Drive may be deleted — never the newest 12, never anything younger than 90
// days, never a file not named like a backup).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { gateCheck, drill, CORE_TABLES, MIN_BYTES } from '../tools/verify-backup.mjs';
import { planPrune, stampOf, KEEP } from '../tools/prune-backups.mjs';

const W = new URL('../', import.meta.url);
const SCHEMA = readFileSync(new URL('schema.sql', W), 'utf8');
const CHECK = readFileSync(new URL('tools/check-migrations.sql', W), 'utf8');

// A dump shaped like `wrangler d1 export`: the stored CREATE statements, then INSERTs.
function dumpOf(db) {
  const out = ['PRAGMA defer_foreign_keys=TRUE;'];
  const objs = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type = 'index', rowid").all();
  for (const o of objs) out.push(`${o.sql};`);
  for (const o of objs.filter(o => o.type === 'table')) {
    for (const r of db.prepare(`SELECT * FROM "${o.name}"`).all()) {
      const vals = Object.values(r).map(v => (v == null ? 'NULL' : typeof v === 'number' ? v : `'${String(v).replace(/'/g, "''")}'`));
      out.push(`INSERT INTO "${o.name}" VALUES(${vals.join(',')});`);
    }
  }
  return out.join('\n');
}
function prodLike() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  for (const f of ['2026-10-12-indexes.sql']) db.exec(readFileSync(new URL(`migrations/${f}`, W), 'utf8'));
  db.exec("INSERT INTO projects (id, title, folders, created_at) VALUES ('p1', 'Tim''s job; -- not a comment', '[\"a\"]', '2026-10-01')");
  return db;
}

test('gate: a real-shaped dump passes; positive case first', () => {
  const text = dumpOf(prodLike());
  assert.ok(text.length >= MIN_BYTES, `dump is ${text.length} bytes`);
  assert.deepEqual(gateCheck(text, text.length), []);
});

test('gate: an empty / tiny / schema-less / project-less file fails loudly', () => {
  const text = dumpOf(prodLike());
  assert.ok(gateCheck('', 0).length >= 2);
  assert.match(gateCheck(text, MIN_BYTES - 1).join(), /太小/);
  const noProjects = text.replace(/^INSERT INTO "projects".*$/gm, '');
  assert.deepEqual(gateCheck(noProjects, noProjects.length), ['備份檔沒有任何 projects 資料列']);
  for (const t of CORE_TABLES) {
    const cut = text.replace(new RegExp(`CREATE TABLE "?${t}"? \\(`, 'g'), 'CREATE TABLE zz_gone (');
    assert.ok(gateCheck(cut, cut.length).includes(`備份檔缺少核心表 ${t}`), t);
  }
  // a name that merely starts with a core table's name is not that table
  const prefix = text.replace(/CREATE TABLE "?pickers"? \(/, 'CREATE TABLE pickers_old (');
  assert.ok(gateCheck(prefix, prefix.length).includes('備份檔缺少核心表 pickers'));
});

test('drill: the dump loads back, migration check on the copy reports zero rows', () => {
  const r = drill(dumpOf(prodLike()), CHECK);
  assert.deepEqual(r.errors, []);
  assert.ok(r.tables >= 28, `${r.tables} tables`);
  assert.deepEqual(r.missing, []);
});

test('drill: a broken file fails; a copy without a migration warns with the file name', () => {
  assert.match(drill('CREATE TABLE projects (id TEXT); INSERT INTO nope VALUES(1);', CHECK).errors.join(), /無法載入/);
  const db = prodLike();
  db.exec('DROP TABLE project_events');
  const r = drill(dumpOf(db), CHECK);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.missing.map(m => m.from_file), ['2026-10-20-project-events.sql', '2026-10-20-project-events.sql']);
  const empty = prodLike();
  empty.exec('DELETE FROM projects');
  assert.deepEqual(drill(dumpOf(empty), CHECK).errors, ['載入後 projects 沒有任何資料']);
});

// ---- retention ----
const DAY = 86400e3;
const NOW = Date.UTC(2027, 5, 1, 18, 17, 0);
const nameAt = t => `imagepicker-db-${new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.sql.enc`;
const weekly = n => Array.from({ length: n }, (_, i) => nameAt(NOW - (n - 1 - i) * 7 * DAY)); // oldest first, last = now

test('names: only exact backup names parse; impossible dates do not', () => {
  assert.equal(stampOf('imagepicker-db-20270601T181700Z.sql.enc'), NOW);
  for (const bad of ['imagepicker-db-20271340T181700Z.sql.enc', 'imagepicker-db-20270601T181700Z.sql', 'x-imagepicker-db-20270601T181700Z.sql.enc', 'imagepicker-db-20270601T181700Z.sql.enc.bak', 'imagepicker-db-20270631T181700Z.sql.enc']) {
    assert.equal(stampOf(bad), null, bad);
  }
});

test('retention: 12 or fewer backups → nothing deleted', () => {
  for (const n of [1, 5, KEEP]) {
    const names = weekly(n);
    assert.deepEqual(planPrune(names, { now: NOW, justUploaded: names.at(-1) }), []);
  }
});

test('retention: only backups beyond the newest 12 AND older than 90 days go, oldest first, at most 4', () => {
  const names = weekly(20); // 20 weekly backups: 19 weeks back … now
  const doomed = planPrune(names, { now: NOW, justUploaded: names.at(-1) });
  // beyond newest 12 = names[0..7] (19..12 weeks old); all are ≥ 84 days, ≥ 90 days = 19..13 weeks = names[0..6]; cap 4
  assert.deepEqual(doomed, names.slice(0, 4));
  const kept = names.filter(n => !doomed.includes(n));
  assert.ok(kept.length >= KEEP);
  // the 13th newest is 12 weeks = 84 days old: beyond 12, but younger than 90 days → kept
  const thirteen = weekly(13);
  assert.deepEqual(planPrune(thirteen, { now: NOW, justUploaded: thirteen.at(-1) }), []);
});

test('retention: after a long pause (all old but the new one) still exactly the newest 12 stay', () => {
  // the schedule was off for months: 13 old weekly backups 100+ days back, then today's
  const old = Array.from({ length: 13 }, (_, i) => nameAt(NOW - (100 + (12 - i) * 7) * DAY));
  const names = [...old, nameAt(NOW)];
  const doomed = planPrune(names, { now: NOW, justUploaded: names.at(-1) });
  assert.deepEqual(doomed, old.slice(0, 2));
  assert.equal(names.length - doomed.length, KEEP);
});

test('retention: many fresh backups (e.g. daily manual runs) are never deleted while young', () => {
  const daily = Array.from({ length: 40 }, (_, i) => nameAt(NOW - (39 - i) * DAY));
  assert.deepEqual(planPrune(daily, { now: NOW, justUploaded: daily.at(-1) }), []);
});

test('retention: other files in the folder are ignored and never deleted', () => {
  const names = [...weekly(20), 'notes.txt', 'imagepicker-db-old.sql.enc', 'imagepicker-db-20200101T000000Z.sql'];
  const doomed = planPrune(names, { now: NOW, justUploaded: weekly(20).at(-1) });
  assert.equal(doomed.length, 4);
  assert.ok(doomed.every(n => stampOf(n) != null));
});

test('retention: refuses to delete anything when the newest is not the one just uploaded, or a name is in the future', () => {
  const names = weekly(20);
  assert.throws(() => planPrune(names, { now: NOW, justUploaded: names[3] }), /不刪任何舊備份/);
  assert.throws(() => planPrune(names.slice(0, -1), { now: NOW, justUploaded: names.at(-1) }), /不刪任何舊備份/);
  assert.throws(() => planPrune([], { now: NOW, justUploaded: names.at(-1) }), /不刪任何舊備份/);
  assert.throws(() => planPrune([...names, nameAt(NOW + 3 * DAY)], { now: NOW, justUploaded: nameAt(NOW + 3 * DAY) }), /未來/);
});
