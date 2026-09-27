-- Guest picking (docs/guest-picking.md). Paste into the D1 Console for
-- imagepicker-db once, before deploying the Worker that serves /api/pick.
--
-- The CREATEs are IF NOT EXISTS and safe to re-run. The ALTER is not: run a
-- second time it fails with "duplicate column name: project_id", which means
-- it already ran and can be ignored.

CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT '',
  folders         TEXT NOT NULL,
  pick_limit      INTEGER,
  extra_price     INTEGER,
  owner_picker_id TEXT,
  created_at      TEXT NOT NULL,
  photographer_id TEXT NOT NULL DEFAULT 'default'
);

CREATE TABLE IF NOT EXISTS pickers (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  key_hash     TEXT NOT NULL,
  name         TEXT NOT NULL,
  relationship TEXT,
  email        TEXT,
  user_id      INTEGER,
  created_at   TEXT NOT NULL,
  submitted_at TEXT,
  submit_count INTEGER, submit_limit INTEGER, submit_price INTEGER
);

CREATE TABLE IF NOT EXISTS selections (
  project_id TEXT NOT NULL,
  photo_key  TEXT NOT NULL,
  rating     INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, photo_key)
);

CREATE TABLE IF NOT EXISTS project_members (
  project_id  TEXT NOT NULL,
  user_id     INTEGER NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  approved_at TEXT,
  PRIMARY KEY (project_id, user_id)
);

ALTER TABLE share_tokens ADD COLUMN project_id TEXT;
