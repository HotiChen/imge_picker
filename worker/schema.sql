CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  -- The folders this client may read. Either a plain path, which is every
  -- account that predates the set and reads as the one folder it names, or a
  -- JSON array of paths. Anything opening the way JSON does -- `[`, `{` or a
  -- quote -- must parse as that array or the account is refused out loud
  -- rather than shown an empty grid. See parseClientFolders in worker.js. No
  -- DDL change: the set is in-band precisely so this column needs none.
  folder_path TEXT DEFAULT '',
  approved INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  -- What the client answered at registration, so the photographer is not left
  -- guessing which dated folder the account belongs to. '' is 未填 -- nobody
  -- was asked, which is every account created before these two columns. A
  -- date is 'YYYY-MM-DD'; '未定' is the client saying the day is not settled,
  -- which is an answer and must not read as 未填. shoot_type is free text
  -- because 其他 lets the client type their own, so nothing validates it
  -- against the list the two pages draw (js/shoot-types.js).
  --
  -- Appended, for the same reason the last two share_tokens columns are: the
  -- CREATE above is IF NOT EXISTS, so a deployed database only gets these
  -- from a hand-run
  --   ALTER TABLE users ADD COLUMN shoot_date TEXT DEFAULT '';
  --   ALTER TABLE users ADD COLUMN shoot_type TEXT DEFAULT '';
  -- ALTER can only append, so they are declared last and in that order, or a
  -- fresh database and a migrated one disagree about what SELECT * returns.
  shoot_date TEXT DEFAULT '',
  shoot_type TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS permissions (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  can_book INTEGER DEFAULT 0,
  can_upload INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  expires_at TEXT NOT NULL
);

-- One link per client album, handed over in a LINE message. `folders` is a
-- snapshot of the book's clientFolders at issue time, so opening more folders
-- on the book later does not silently widen links already sent out.
CREATE TABLE IF NOT EXISTS share_tokens (
  token        TEXT NOT NULL PRIMARY KEY,
  book_id      TEXT NOT NULL,
  label        TEXT DEFAULT '',
  folders      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  last_seen_at TEXT,
  -- Whose row this is, for a signed-in client's own token and nothing else;
  -- NULL on every other row. It is the only thing that lets a logout or an
  -- account deletion find the URL tokens that account was handed: those rows
  -- carry no book_id, so the per-album list cannot see them either. Written
  -- by one route, so a delete keyed on it alone cannot reach anything else.
  -- Appended, because the CREATE above is IF NOT EXISTS and a deployed
  -- database only gets it from a hand-run
  --   ALTER TABLE share_tokens ADD COLUMN user_id INTEGER;
  user_id      INTEGER,
  -- 'client' for the album link above, 'studio' for the photographer's own
  -- pages, which read everything, and 'session' for a signed-in client's own
  -- folder. The latter two are minted, read-only and write nothing; all three
  -- are told apart by this column and never by the shape of `folders`.
  -- Appended for the same reason, from the same migration:
  --   ALTER TABLE share_tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'client';
  -- A fourth kind, 'pick', is the guest-picking link (docs/guest-picking.md):
  -- sent like 'client', but it opens the /api/pick routes and photo reads
  -- inside its folders and nothing else.
  kind         TEXT NOT NULL DEFAULT 'client',
  -- The project a 'pick' row belongs to; NULL on every other kind. Appended
  -- for the same reason as the two above, from a hand-run
  --   ALTER TABLE share_tokens ADD COLUMN project_id TEXT;
  -- (worker/migrations/2026-09-27-guest-picking.sql has the whole paste).
  project_id   TEXT
);
CREATE INDEX IF NOT EXISTS idx_share_tokens_book ON share_tokens(book_id);
CREATE INDEX IF NOT EXISTS idx_share_tokens_user ON share_tokens(user_id);

-- ─── Guest picking (docs/guest-picking.md) ─────────────────────────────────
-- New tables, so a deployed database gets them from the same migration file
-- as the column above: worker/migrations/2026-09-27-guest-picking.sql.

-- One shoot, one link. `folders` is the JSON array the link's snapshot was
-- taken from. owner_picker_id is the seat: NULL is free, and the only write
-- that fills it is the conditional UPDATE in POST /api/pick/claim, which is
-- what makes two simultaneous claims produce exactly one owner.
CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT '',
  folders         TEXT NOT NULL,          -- JSON array
  pick_limit      INTEGER,                -- NULL = no limit
  extra_price     INTEGER,                -- NT$ per extra photo, NULL = not shown
  owner_picker_id TEXT,                   -- NULL = seat free
  created_at      TEXT NOT NULL,
  -- Whose project this is. One photographer today, so every row is
  -- 'default'; it is here so the data is attributable from the first row,
  -- before any multi-photographer auth exists. Set by the Worker, never taken
  -- from a request body.
  photographer_id TEXT NOT NULL DEFAULT 'default'
);

-- Everyone who ever held the seat, so a reset keeps the old submit record.
-- key_hash is the SHA-256 of the bearer key handed out once at claim; the key
-- itself is never stored. submit_* snapshot the count, limit and price at
-- submit, which is the record an extra-photo fee is charged from.
CREATE TABLE IF NOT EXISTS pickers (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  key_hash     TEXT NOT NULL,             -- SHA-256 of the bearer key
  name         TEXT NOT NULL,
  relationship TEXT,
  email        TEXT,
  user_id      INTEGER,
  created_at   TEXT NOT NULL,
  submitted_at TEXT,
  submit_count INTEGER, submit_limit INTEGER, submit_price INTEGER
);

-- One list per project, so a seat reset never loses a pick. updated_by is the
-- picker id, for the photographer's view.
CREATE TABLE IF NOT EXISTS selections (
  project_id TEXT NOT NULL,
  photo_key  TEXT NOT NULL,
  rating     INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL,               -- picker id
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, photo_key)
);

-- Deferred feature (invites), table now. Nothing reached through a link or a
-- claim writes this table; only an admin route may write role = 'owner'.
CREATE TABLE IF NOT EXISTS project_members (
  project_id  TEXT NOT NULL,
  user_id     INTEGER NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  approved_at TEXT,
  PRIMARY KEY (project_id, user_id)
);
