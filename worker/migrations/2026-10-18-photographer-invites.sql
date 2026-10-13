-- Photographer invite codes (邀請碼), docs/multi-photographer.md.
-- Paste into the D1 Console for imagepicker-db before merging the Worker that
-- reads it. Three statements, one per line, run them one by one, in order.
-- Needs 2026-10-11-photographers.sql first (the invite throttle shares its
-- photographer_login_failures table).
--
-- A new table only, no ALTER. Until it exists the operator's invite routes
-- (/api/operator/photographer-invites…) and POST
-- /api/photographer/register-invite answer 500 invites_unavailable and write
-- nothing; open sign-up (/api/photographer/register), login and the operator's
-- photographer list keep working as before (every account reads as
-- created_via: 'signup').
--
-- Safe to re-run (IF NOT EXISTS).

-- photographer_invites: one row per 8-digit code the operator made. code_hash = HMAC-SHA256 (key = the PHOTOGRAPHER_INVITE_SECRET wrangler secret, message = 'photographer-invite:' + code), hex; the code itself is never stored. Valid 1 hour, spent once: used_at / used_by (the new photographers.id) set in the same batch that creates the account; revoked_at set by the operator. note: the operator's own reminder, ≤ 200 characters
CREATE TABLE IF NOT EXISTS photographer_invites (id TEXT PRIMARY KEY, code_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, used_by TEXT, revoked_at TEXT, note TEXT);

CREATE INDEX IF NOT EXISTS idx_photographer_invites_code ON photographer_invites(code_hash);

CREATE INDEX IF NOT EXISTS idx_photographer_invites_used_by ON photographer_invites(used_by);
