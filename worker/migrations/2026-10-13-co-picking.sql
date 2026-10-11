-- Co-picking (協作者), batch 1 of docs/co-picking.md.
-- Paste into the D1 Console for imagepicker-db before merging the Worker that
-- reads them. Six statements, one per line, run them one by one, in order.
--
-- New tables only, no ALTER. Until they exist, every co-picking route
-- (/api/pick/invites, /join, /collaborators…, /renewal) answers 500
-- co_picking_unavailable and everything else keeps working as before: the
-- state reads, the owner saves and submits, the admin detail shows
-- collaborators: [].
--
-- Safe to re-run (IF NOT EXISTS).

-- pick_invites: one row per 8-digit invite code. code_hash = HMAC-SHA256 (key = PHOTOGRAPHER_TOKEN, message = project_id + ':' + code), hex; the code itself is never stored. Valid 1 hour, spent once (used_at / used_by set atomically by the join). window_days = the collaborator's period: 1, 7 or NULL (until the project ends)
CREATE TABLE IF NOT EXISTS pick_invites (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, code_hash TEXT NOT NULL, invited_by TEXT NOT NULL, window_days INTEGER, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, used_by TEXT);

CREATE INDEX IF NOT EXISTS idx_pick_invites_project ON pick_invites(project_id, created_at);

-- project_collaborators: one row per collaborator (picker_id = pickers.id). Valid only while invited_by = projects.owner_picker_id, revoked_at IS NULL and expires_at is NULL or in the future. renewal_requested_at: set by the person after expiry, cleared when the owner approves or declines
CREATE TABLE IF NOT EXISTS project_collaborators (picker_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, invited_by TEXT NOT NULL, joined_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, last_seen_at TEXT, renewal_requested_at TEXT);

CREATE INDEX IF NOT EXISTS idx_project_collaborators_project ON project_collaborators(project_id, joined_at);

-- pick_join_failures: one row per failed join (wrong / used / expired code), bucket 'p' (the whole project) or 'n:<network>' (IPv4 or IPv6 /64); 10 per project and 5 per network in 15 minutes, then 429
CREATE TABLE IF NOT EXISTS pick_join_failures (project_id TEXT NOT NULL, bucket TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_pick_join_failures ON pick_join_failures(project_id, bucket, created_at);
