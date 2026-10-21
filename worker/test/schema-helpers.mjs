// Schema fixtures shared by the migration tests. Not a test file itself.
//
// schema.sql appends each hand-run migration's columns at the end of their
// table, so a test that rebuilds "the database before migration X" by
// cutting X's columns off the end of schema.sql first has to cut off every
// column appended after X. withoutProofRetention() cuts what
// worker/migrations/2026-10-21-proof-retention.sql adds (three projects
// columns, one studio_settings column, each with its comment block), giving
// back schema.sql as it was before that migration, byte for byte.
import { readFileSync } from 'node:fs';

export const PROOF_RETENTION_PROJECT_COLUMNS = ['proof_retention_days', 'proofs_deleted_at', 'proofs_delete_next_at'];
export const PROOF_RETENTION_STUDIO_COLUMNS = ['proof_retention_days'];

const PROJECTS_BLOCK = /,\n {2}-- Proof retention \(docs\/delivery\.md, "Proof retention"\): the daily cron[\s\S]*?\n {2}proofs_delete_next_at TEXT\n\);/;
const STUDIO_BLOCK = /,\n {2}-- the studio's default for proof retention[\s\S]*?\n {2}proof_retention_days INTEGER\n\);/;
function cut(sql, re) {
  const out = sql.replace(re, '\n);');
  if (out === sql) throw new Error('schema-helpers: a proof-retention block in schema.sql moved');
  return out;
}
export const withoutProofRetention = sql => cut(cut(sql, PROJECTS_BLOCK), STUDIO_BLOCK);
// only the studio_settings column (the studio_settings fixtures)
export const withoutStudioProofRetention = sql => cut(sql, STUDIO_BLOCK);
export const PROOF_RETENTION_STUDIO_SQL = 'ALTER TABLE studio_settings ADD COLUMN proof_retention_days INTEGER;';

// the migration itself, for the tests that bring an old database all the way
// up to schema.sql (each later migration in turn)
export const PROOF_RETENTION_MIGRATION = readFileSync(new URL('../migrations/2026-10-21-proof-retention.sql', import.meta.url), 'utf8');
