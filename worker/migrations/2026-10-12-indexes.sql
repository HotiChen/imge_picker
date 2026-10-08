-- Append-only; two statements, run one by one in the D1 Console.
-- They speed up the lookups by (project_id, key_hash) on pickers and by
-- (project_id, kind) on share_tokens; the cost is a little more work on each
-- INSERT/UPDATE of those two tables. Nothing depends on them: the Worker works
-- with or without.
-- Not in schema.sql as statements: the tests that rebuild a "database before the
-- migration" strip columns from schema.sql, and an index naming one of them would
-- break those fixtures. A fresh database can run this file once after schema.sql.
CREATE INDEX IF NOT EXISTS idx_pickers_key ON pickers(project_id, key_hash);
CREATE INDEX IF NOT EXISTS idx_share_tokens_project ON share_tokens(project_id, kind, created_at);
