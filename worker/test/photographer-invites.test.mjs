// Photographer invite codes (docs/multi-photographer.md, 邀請碼): the
// photographer_invites table, from its hand-run migration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { setup } from './pick-helpers.mjs';

const MIGRATION = readFileSync(new URL('../migrations/2026-10-18-photographer-invites.sql', import.meta.url), 'utf8');
const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

// ─── the migration ─────────────────────────────────────────────────────────

test('migration: one CREATE TABLE IF NOT EXISTS and its indexes, one statement per line, the same shape as schema.sql, re-runnable', () => {
  const statements = MIGRATION.split('\n').filter(l => /^(CREATE|ALTER|INSERT|UPDATE|DELETE|DROP)\b/i.test(l));
  assert.deepEqual(statements.map(s => s.split('(')[0].trim()), [
    'CREATE TABLE IF NOT EXISTS photographer_invites',
    'CREATE INDEX IF NOT EXISTS idx_photographer_invites_code ON photographer_invites',
    'CREATE INDEX IF NOT EXISTS idx_photographer_invites_used_by ON photographer_invites',
  ]);
  for (const s of statements) assert.ok(s.trim().endsWith(';'), s);
  assert.ok(!/ALTER|DROP|DELETE|UPDATE/i.test(MIGRATION.replace(/--.*$/gm, '')), 'append-only, new table only');
  const migrated = new DatabaseSync(':memory:');
  migrated.exec(MIGRATION);
  migrated.exec(MIGRATION);
  const fresh = setup().DB._db;
  const shape = db => db.prepare('PRAGMA table_info(photographer_invites)').all().map(c => [c.name, c.type, c.notnull, c.pk]);
  assert.deepEqual(shape(migrated), shape(fresh));
  assert.deepEqual(shape(fresh).map(c => c[0]), ['id', 'code_hash', 'created_at', 'expires_at', 'used_at', 'used_by', 'revoked_at', 'note']);
  const idx = db => db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'photographer_invites' AND sql IS NOT NULL ORDER BY name").all().map(r => [r.name, r.sql]);
  assert.deepEqual(idx(migrated), idx(fresh));
  assert.equal(idx(fresh).length, 2);
  assert.match(SCHEMA, /2026-10-18-photographer-invites\.sql/, 'schema.sql names the hand-run migration');
});
