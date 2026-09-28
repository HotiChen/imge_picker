-- Dashboard + studio settings (docs/dashboard-settings.md). Paste into the D1
-- Console for imagepicker-db once, after 2026-09-28-project-archive.sql and
-- before deploying the Worker that reads delivered_at: until it runs, the
-- project list and the stats fail, and settings/logo routes answer 500. Guest
-- pick links keep working (the studio brand reads as empty).
--
-- The ALTER is not safe to re-run: a second run fails with "duplicate column
-- name: delivered_at", which means it already ran and can be ignored. The
-- CREATE is IF NOT EXISTS and safe to paste again.

ALTER TABLE projects ADD COLUMN delivered_at TEXT;

CREATE TABLE IF NOT EXISTS studio_settings (
  photographer_id     TEXT PRIMARY KEY,
  studio_name         TEXT,
  booking_url         TEXT,
  default_pick_limit  INTEGER,
  default_extra_price INTEGER,
  logo                BLOB,
  logo_type           TEXT,
  logo_updated_at     TEXT,
  updated_at          TEXT
);
