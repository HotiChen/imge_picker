-- Client confirmation and revision requests (docs/delivery.md, "Client
-- confirmation and revision requests"). Paste into the D1 Console for
-- imagepicker-db once, after 2026-09-30-extra-max.sql and before merging the
-- Worker that serves POST /api/pick/confirm and /api/pick/revision. The
-- console runs one statement at a time: run the four below one by one, in
-- order. Until all four have run, the guest's confirm and revision request and
-- the photographer's 標記完成 (POST /api/admin/projects/:id/confirm) answer 500
-- confirm_unavailable; every other route (project list, detail, pick state,
-- save, submit, start-retouch, deliver, undeliver, reopen, every pick link)
-- keeps working as before, with nothing confirmed and no requests.
--
-- Existing projects get NULL = not confirmed, so nothing changes for them.
--
-- The two ALTERs are not safe to re-run: a second run fails with
-- "duplicate column name: client_confirmed_at" (or client_confirmed_by),
-- which means it already ran and can be ignored. The CREATE TABLE and CREATE INDEX are
-- IF NOT EXISTS and can be re-run.

ALTER TABLE projects ADD COLUMN client_confirmed_at TEXT;   -- NULL = not confirmed

ALTER TABLE projects ADD COLUMN client_confirmed_by TEXT;   -- 'guest' | 'photographer'

CREATE TABLE IF NOT EXISTS revision_requests (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  picker_id   TEXT,                      -- the seat holder who asked; NULL if unknown
  message     TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 1000),
  created_at  TEXT NOT NULL,
  resolved_at TEXT                       -- NULL = open
);

CREATE INDEX IF NOT EXISTS idx_revision_requests_project ON revision_requests(project_id, resolved_at);
