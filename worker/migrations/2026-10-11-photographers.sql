-- Photographer accounts, batch 1 of docs/multi-photographer.md (帳號與登入).
-- Paste into the D1 Console for imagepicker-db before merging the Worker that
-- reads them. Seven statements, one per line, run them one by one, in order.
--
-- New tables only. The old client-account tables (users / permissions /
-- sessions) are not touched, and nothing is seeded: 'default' (Tim) stays the
-- PHOTOGRAPHER_TOKEN env secret and has no row here.
--
-- Until they exist, /api/photographer/* (register, login, logout) and
-- /api/operator/photographers* answer 500 photographers_unavailable, every
-- other route keeps working as before (GET /api/photographer/me says 401). A photographer session opens no
-- existing route in this batch.
--
-- Safe to re-run (IF NOT EXISTS).

-- photographers: email lowercased printable ASCII, password pbkdf2$<iters>$<saltHex>$<hashHex>, status pending | active | suspended,
-- dup_attempts / last_dup_at: later registrations naming this email (the operator checks identity before approving)
CREATE TABLE IF NOT EXISTS photographers (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, studio_note TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, approved_at TEXT, last_login_at TEXT, dup_attempts INTEGER NOT NULL DEFAULT 0, last_dup_at TEXT);

-- photographer_sessions: token_hash = SHA-256 hex of the bearer token, the raw token is never stored
CREATE TABLE IF NOT EXISTS photographer_sessions (token_hash TEXT PRIMARY KEY, photographer_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_photographer_sessions_owner ON photographer_sessions(photographer_id);

-- photographer_signups: one row per registration attempt that passed Turnstile (per-IP rate limit, ip_hash = SHA-256, never the raw IP)
CREATE TABLE IF NOT EXISTS photographer_signups (ip_hash TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_photographer_signups_ip ON photographer_signups(ip_hash, created_at);

-- photographer_login_failures: one row per login attempt, reserved before the password check and deleted again when it succeeds, key_hash = SHA-256 of the IP (/64 for IPv6) or of the email, 10 per key per 15 minutes
CREATE TABLE IF NOT EXISTS photographer_login_failures (key_hash TEXT NOT NULL, attempt TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_photographer_login_failures_key ON photographer_login_failures(key_hash, created_at);
