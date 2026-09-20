CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  folder_path TEXT DEFAULT '',
  approved INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
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
  last_seen_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_share_tokens_book ON share_tokens(book_id);
