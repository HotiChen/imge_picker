-- Photographer invite codes (邀請碼), docs/multi-photographer.md.
-- Paste into the D1 Console for imagepicker-db before merging the Worker that
-- reads it. Four statements, one per line, run them one by one, in order.
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

-- photographer_invites: one row per 8-digit code the operator made for one invitee. email = the invited email (lowercased, as registration normalises it; only that email can use the code; one live code per email). code_hash = HMAC-SHA256 (key = the PHOTOGRAPHER_INVITE_SECRET wrangler secret, message = 'photographer-invite' + LF + email + LF + code), hex; the code itself is never stored. Valid 1 hour, spent once: used_at / used_by (the new photographers.id) set in the same batch that creates the account; revoked_at set by the operator, or by a newer code for the same email. note: the operator's own reminder, ≤ 200 characters
CREATE TABLE IF NOT EXISTS photographer_invites (id TEXT PRIMARY KEY, email TEXT NOT NULL, code_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, used_by TEXT, revoked_at TEXT, note TEXT);

CREATE INDEX IF NOT EXISTS idx_photographer_invites_code ON photographer_invites(code_hash);

CREATE INDEX IF NOT EXISTS idx_photographer_invites_email ON photographer_invites(email);

CREATE INDEX IF NOT EXISTS idx_photographer_invites_used_by ON photographer_invites(used_by);
