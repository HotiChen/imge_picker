// worker/tools/check-migrations.sql (from worker/tools/gen-migration-check.mjs): one
// read-only SELECT that lists every expected table, ALTER … ADD COLUMN column
// and index the database lacks, with the file that adds it. Empty = all run.
// Run here against real SQLite (node:sqlite), the engine D1 is built on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { statements, expectedItems, readSources, renderSql, generate, OUTPUT } from '../tools/gen-migration-check.mjs';

const W = new URL('../', import.meta.url);
const SCHEMA = readFileSync(new URL('schema.sql', W), 'utf8');
const MIGRATIONS = readdirSync(new URL('migrations/', W)).filter(f => f.endsWith('.sql')).sort();
const CHECK = readFileSync(OUTPUT, 'utf8');

const runCheck = (db, sql = CHECK) => db.prepare(sql.trim().replace(/;$/, '')).all().map(r => ({ ...r }));

// schema.sql, then every migration one statement at a time (as in the D1
// Console). Re-adding a column schema.sql already has is the only error allowed.
function fullDb({ skip = [] } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  for (const f of MIGRATIONS) {
    if (skip.includes(f)) continue;
    for (const st of statements(readFileSync(new URL(`migrations/${f}`, W), 'utf8'))) {
      try { db.exec(st); } catch (e) {
        if (!/duplicate column name/i.test(e.message)) throw new Error(`${f}: ${e.message}`);
      }
    }
  }
  return db;
}

test('the committed check-migrations.sql is what the generator writes now (no drift)', () => {
  assert.equal(CHECK, generate(), 'run: node worker/tools/gen-migration-check.mjs');
});

test('a database built from schema.sql + every migration: the check returns zero rows', () => {
  assert.deepEqual(runCheck(fullDb()), []);
});

test('an empty database: every table and index is listed, no column of a missing table', () => {
  const items = expectedItems(readSources());
  const rows = runCheck(new DatabaseSync(':memory:'));
  const tables = items.filter(i => i.kind === 'table');
  const indexes = items.filter(i => i.kind === 'index');
  assert.ok(tables.length >= 28 && indexes.length >= 24, `scanned ${tables.length} tables / ${indexes.length} indexes`);
  assert.equal(rows.length, tables.length + indexes.length);
  assert.ok(!rows.some(r => r.missing.startsWith('欄位 ')), 'no column rows when the table itself is missing');
  assert.ok(rows.some(r => r.from_file === 'schema.sql' && r.missing === '表 share_tokens'));
  assert.ok(rows.some(r => r.from_file === '2026-09-27-guest-picking.sql' && r.missing === '表 projects'));
});

test('one migration not run (project-events): exactly its table and index, naming that file', () => {
  const db = fullDb({ skip: ['2026-10-20-project-events.sql'] });
  // schema.sql already declares project_events; a database that never ran the file has neither.
  db.exec('DROP TABLE project_events');
  assert.deepEqual(runCheck(db), [
    { from_file: '2026-10-20-project-events.sql', missing: '表 project_events' },
    { from_file: '2026-10-20-project-events.sql', missing: '索引 idx_project_events_project（project_events）' },
  ]);
});

test('an ALTER migration not run: exactly the missing column, naming that file', () => {
  const db = fullDb();
  db.exec('ALTER TABLE projects DROP COLUMN shoot_date');
  assert.deepEqual(runCheck(db), [
    { from_file: '2026-10-07-project-shoot-date.sql', missing: '欄位 projects.shoot_date' },
  ]);
});

test('a missing table with ALTERed columns is reported once, as the table, not per column', () => {
  const db = fullDb();
  db.exec('DROP TABLE revision_requests');
  assert.deepEqual(runCheck(db), [
    { from_file: '2026-10-04-client-confirm.sql', missing: '表 revision_requests' },
    { from_file: '2026-10-04-client-confirm.sql', missing: '索引 idx_revision_requests_project（revision_requests）' },
  ]);
});

test('an index only schema.sql declares is attributed to schema.sql; a migration index to its file', () => {
  const db = fullDb();
  db.exec('DROP INDEX idx_share_tokens_book; DROP INDEX idx_pickers_key');
  assert.deepEqual(runCheck(db), [
    { from_file: 'schema.sql', missing: '索引 idx_share_tokens_book（share_tokens）' },
    { from_file: '2026-10-12-indexes.sql', missing: '索引 idx_pickers_key（pickers）' },
  ]);
});

test('generator: earliest migration wins, comments and quoted text are ignored', () => {
  const items = expectedItems([
    { file: 'a.sql', sql: "-- CREATE TABLE ghost (x);\nCREATE TABLE IF NOT EXISTS t (x TEXT DEFAULT 'a;b -- c');\nALTER TABLE t ADD COLUMN y TEXT;\nCREATE UNIQUE INDEX IF NOT EXISTS i1 ON t(y);" },
    { file: 'b.sql', sql: 'ALTER TABLE t ADD COLUMN y TEXT;\nALTER TABLE t ADD COLUMN z INTEGER;' },
    { file: 'schema.sql', sql: 'CREATE TABLE IF NOT EXISTS t (x, y, z);\nCREATE TABLE base (id);\nCREATE INDEX IF NOT EXISTS i2 ON base(id);' },
  ]);
  assert.deepEqual(items.map(i => [i.file, i.kind, i.table, i.name]), [
    ['schema.sql', 'table', 'base', null],
    ['schema.sql', 'index', 'base', 'i2'],
    ['a.sql', 'table', 't', null],
    ['a.sql', 'column', 't', 'y'],
    ['a.sql', 'index', 't', 'i1'],
    ['b.sql', 'column', 't', 'z'],
  ]);
  assert.throws(() => expectedItems([{ file: "x'; DROP TABLE y; --.sql", sql: '' }]), /unexpected file name/);
});

test('the check is a single read-only SELECT (safe to paste into the D1 Console)', () => {
  const body = statements(CHECK);
  assert.equal(body.length, 1);
  assert.match(body[0], /^WITH expected\b/);
  assert.doesNotMatch(body[0], /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|PRAGMA\s)\b/i);
  // renderSql escapes quotes in literals
  assert.match(renderSql([{ file: 'x.sql', kind: 'table', table: "o'k", name: null }]), /'o''k'/);
});
