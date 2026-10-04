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
  photographer_id TEXT NOT NULL DEFAULT 'default',
  -- picking → submitted → retouching. The guest saves in the first two and
  -- submits from them; in retouching nothing the guest does writes. Only the
  -- admin routes start-retouch and reopen move it anywhere but 'submitted'.
  phase           TEXT NOT NULL DEFAULT 'picking'
                  CHECK (phase IN ('picking','submitted','retouching')),
  -- 1 = the owner saved after the last submit and has not submitted again.
  -- A save never emails; this is how the photographer finds out.
  modified_after_submit INTEGER NOT NULL DEFAULT 0,
  -- when the photographer was last emailed about a submit; a submit
  -- inside ten minutes of it is recorded but not mailed. NULL = never.
  last_notified_at TEXT,
  -- when the photographer archived the project; NULL = active. An archived
  -- project is off the default list and every link to it is refused (by this
  -- column as well as by the links' own revoked_at). Appended, because the
  -- CREATE above is IF NOT EXISTS and a database that already ran the
  -- guest-picking migration only gets it from a hand-run
  --   ALTER TABLE projects ADD COLUMN archived_at TEXT;
  -- (worker/migrations/2026-09-28-project-archive.sql).
  archived_at     TEXT,
  -- when the photographer marked the finished photos delivered; NULL = not
  -- yet. Not a phase value: the CHECK above cannot change without rebuilding
  -- the table. Only set from phase 'retouching' (POST .../deliver), cleared by
  -- .../undeliver and by reopen, so delivered always means retouching too and
  -- the guest's writes stay refused. Appended, from a hand-run
  --   ALTER TABLE projects ADD COLUMN delivered_at TEXT;
  -- (worker/migrations/2026-09-28-dashboard-settings.sql).
  delivered_at    TEXT,
  -- the finals folder snapshot the delivery gallery shows (JSON array, the
  -- same canonical form as `folders`): the last chosen finals. Written
  -- together with delivered_at by POST .../deliver; undeliver clears only
  -- delivered_at and keeps this (the next deliver is prefilled from it), so
  -- it can be set while not delivered — delivered means delivered_at set
  -- AND a valid snapshot, never this alone. Reopen clears both. NULL = never
  -- chosen (or reopened). Never inside or around a proof folder
  -- (docs/delivery.md).
  -- 1 = the guest may download the proof originals (full resolution); 0 =
  -- thumbnails only, the default. Set by PATCH /api/admin/projects/:id.
  -- Both appended, from a hand-run
  --   ALTER TABLE projects ADD COLUMN final_folders TEXT;
  --   ALTER TABLE projects ADD COLUMN allow_proof_download INTEGER NOT NULL DEFAULT 0;
  -- (worker/migrations/2026-09-30-delivery.sql).
  final_folders   TEXT,
  allow_proof_download INTEGER NOT NULL DEFAULT 0,
  -- how many ♥ photos the guest may pick above pick_limit (0 = none); the
  -- save refuses more than pick_limit + extra_max (409 pick_cap). NULL = no
  -- plan cap (every project from before it); set at creation (body, else
  -- studio_settings.default_extra_max, else 10) and by PATCH
  -- /api/admin/projects/:id (docs/project-plan.md). Appended, from a hand-run
  --   ALTER TABLE projects ADD COLUMN extra_max INTEGER;
  -- (worker/migrations/2026-09-30-extra-max.sql).
  extra_max       INTEGER
);

-- Everyone who ever held the seat. key_hash is the SHA-256 of the bearer key
-- handed out once at claim; the key itself is never stored. relationship and
-- email are the latest contact info the picker gave at submit; the submit
-- record itself is a row in `submissions`.
CREATE TABLE IF NOT EXISTS pickers (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  key_hash     TEXT NOT NULL,             -- SHA-256 of the bearer key
  name         TEXT NOT NULL,
  relationship TEXT,
  email        TEXT,
  user_id      INTEGER,
  created_at   TEXT NOT NULL
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
  -- Retouch pins on a ♥ photo: a JSON array [{x, y, note}] (x/y 0–1
  -- fractions of the photo, ≤ 10 pins, note ≤ 100 characters; ≤ 300 pins per
  -- project, PICK_MARKS_TOTAL_MAX), in the
  -- Worker's own serialisation; NULL = none, never '[]'. Only ever non-NULL
  -- on a row with rating > 0. Appended, from a hand-run
  --   ALTER TABLE selections ADD COLUMN marks TEXT;
  -- (worker/migrations/2026-09-30-retouch-pins.sql).
  marks      TEXT,
  PRIMARY KEY (project_id, photo_key)
);

-- One row per submit, never updated or deleted: the record an extra-photo
-- fee is charged from, and what the next submit's email is diffed against.
-- The snapshot is taken in the same statement that checks the seat and the
-- phase, so it is exactly the list that was submitted.
CREATE TABLE IF NOT EXISTS submissions (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  picker_id    TEXT NOT NULL,
  relationship TEXT NOT NULL,
  email        TEXT,
  photo_keys   TEXT NOT NULL,             -- JSON array, rating >= 1, key order
  count        INTEGER NOT NULL,
  pick_limit   INTEGER,                   -- the plan as it stood at submit
  extra_price  INTEGER,
  created_at   TEXT NOT NULL,
  -- 1 = the photographer was emailed about this submit; 0 = throttled,
  -- unchanged since the last email, or the mail failed / is not set up
  notified     INTEGER NOT NULL DEFAULT 0,
  -- The pins of the submitted (rating >= 1) photos, snapshotted by the same
  -- INSERT: JSON {photo_key: [{x, y, note}]}, key order, only photos that
  -- have pins; NULL = none. Appended, from the same hand-run file as
  -- selections.marks:
  --   ALTER TABLE submissions ADD COLUMN marks TEXT;
  marks        TEXT
);
CREATE INDEX IF NOT EXISTS idx_submissions_project ON submissions(project_id, created_at);

-- Deferred feature (invites), table now. Nothing reached through a link or a
-- claim writes this table; only an admin route may write role = 'owner'.
CREATE TABLE IF NOT EXISTS project_members (
  project_id  TEXT NOT NULL,
  user_id     INTEGER NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  approved_at TEXT,
  PRIMARY KEY (project_id, user_id)
);

-- ─── Studio settings (docs/dashboard-settings.md) ──────────────────────────
-- A new table, so a deployed database gets it from the same hand-run file as
-- the projects column above: worker/migrations/2026-09-28-dashboard-settings.sql.
-- One row per photographer, keyed by the Worker's constant, never by a body.
-- The logo lives here, not in the `imagepicker` bucket, whose lifecycle rule
-- deletes everything after 180 days. It is ≤ 200 KB of PNG/JPEG/WebP, decided
-- by its magic bytes; logo_type is that sniffed type, never the client's.
-- booking_url is validated (https:// only) on write, because the guest page
-- puts it in an href.
CREATE TABLE IF NOT EXISTS studio_settings (
  photographer_id     TEXT PRIMARY KEY,
  studio_name         TEXT,
  booking_url         TEXT,
  default_pick_limit  INTEGER,
  default_extra_price INTEGER,
  logo                BLOB,
  logo_type           TEXT,
  logo_updated_at     TEXT,
  updated_at          TEXT,
  -- the extra_max a new project starts with; NULL = unset, which means 10.
  -- Appended, from a hand-run
  --   ALTER TABLE studio_settings ADD COLUMN default_extra_max INTEGER;
  -- (worker/migrations/2026-09-30-extra-max.sql).
  default_extra_max   INTEGER
);

-- ─── Products and orders (docs/products-orders.md) ─────────────────────────
-- New tables, so a deployed database gets them from one hand-run file:
-- worker/migrations/2026-09-29-products-orders.sql. Money is integer NT$, tax
-- included. photographer_id is always the Worker's constant, never a body's.

-- The catalogue. Never deleted, only retired (active = 0): order lines point
-- at it. The image columns are for the Phase B guest shop (D1, not the
-- `imagepicker` bucket, whose lifecycle deletes after 180 days); no route
-- reads or writes them yet.
CREATE TABLE IF NOT EXISTS products (
  id              TEXT PRIMARY KEY,
  photographer_id TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('print','album','service')),
  name            TEXT NOT NULL,          -- ≤ 60
  description     TEXT NOT NULL DEFAULT '',-- ≤ 500, shown to guests in B
  photo_count     INTEGER,                -- album: expected photos, NULL = any (advisory)
  guest_visible   INTEGER NOT NULL DEFAULT 0,  -- Phase B shop
  active          INTEGER NOT NULL DEFAULT 1,
  sort            INTEGER NOT NULL DEFAULT 0,
  image           BLOB,
  image_type      TEXT,
  image_updated_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  platform_product_id TEXT               -- adopted from platform_products; NULL = the photographer's own (service)
);
CREATE INDEX IF NOT EXISTS idx_products_owner ON products(photographer_id, active, sort);

-- Price and cost live on the option; a product without choices has one, with
-- label ''. Retired like products, never deleted.
CREATE TABLE IF NOT EXISTS product_options (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL,
  label       TEXT NOT NULL,              -- '16×20 無框', '' when single
  price       INTEGER NOT NULL CHECK (price >= 0),
  cost        INTEGER NOT NULL DEFAULT 0 CHECK (cost >= 0),
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  platform_option_id TEXT        -- adopted: the platform option it sells; price >= its platform_price
);
CREATE INDEX IF NOT EXISTS idx_options_product ON product_options(product_id, sort);

-- One order per sale. Totals are computed on read (Σ unit_price × qty −
-- discount), never stored. Payment is one amount per order, no deposits
-- table. source 'system' is the automatic extra-pick order; any admin edit
-- flips it to 'admin' and from then on the Worker leaves it alone.
CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  photographer_id TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('admin','guest','system')),
  status          TEXT NOT NULL DEFAULT 'confirmed'
                  CHECK (status IN ('requested','confirmed','fulfilled','cancelled')),
  picker_id       TEXT,                   -- guest orders: who asked
  discount        INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  paid_amount     INTEGER NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  paid_at         TEXT,
  paid_method     TEXT CHECK (paid_method IN ('cash','transfer','other')),
  note            TEXT NOT NULL DEFAULT '',   -- photographer only, ≤ 500
  guest_note      TEXT NOT NULL DEFAULT '',   -- from the guest, ≤ 500
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  confirmed_at    TEXT,
  fulfilled_at    TEXT,
  cancelled_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_project ON orders(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_owner_paid ON orders(photographer_id, paid_at);

-- Every line snapshots name, option, price and cost when it is added, so a
-- catalogue edit never changes an existing order.
CREATE TABLE IF NOT EXISTS order_items (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('print','album','service','extra_pick')),
  product_id    TEXT,                     -- NULL for extra_pick
  option_id     TEXT,
  name          TEXT NOT NULL,            -- snapshot
  option_label  TEXT NOT NULL DEFAULT '', -- snapshot
  unit_price    INTEGER NOT NULL CHECK (unit_price >= 0),  -- snapshot, editable by admin
  unit_cost     INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  qty           INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 999),
  photo_keys    TEXT NOT NULL DEFAULT '[]',  -- JSON; print: ≤ 1 per unit, album: the set
  platform_option_id TEXT,                -- snapshot: the platform option sold (NULL = not the platform's)
  vendor_cost   INTEGER NOT NULL DEFAULT 0 CHECK (vendor_cost >= 0)  -- snapshot, operator only: never in an /api/admin response
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

-- The platform catalogue (A2): printable products the operator lists, with
-- what the lab charges (vendor_cost, operator only) and what a photographer
-- pays (platform_price). A photographer adopts one into `products`
-- (platform_product_id) and sells chosen options at a price >= platform_price.
-- Never deleted, only retired. Same hand-run file as the tables above.
CREATE TABLE IF NOT EXISTS platform_products (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('print','album')),
  name             TEXT NOT NULL,          -- ≤ 60
  description      TEXT NOT NULL DEFAULT '',-- ≤ 500
  photo_count      INTEGER,                -- album: expected photos, NULL = any (advisory)
  active           INTEGER NOT NULL DEFAULT 1,
  sort             INTEGER NOT NULL DEFAULT 0,
  image            BLOB,                   -- ≤ 200 KB, PNG/JPEG/WebP; served publicly
  image_type       TEXT,
  image_updated_at TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_products_sort ON platform_products(active, sort);

CREATE TABLE IF NOT EXISTS platform_product_options (
  id                  TEXT PRIMARY KEY,
  platform_product_id TEXT NOT NULL,
  label               TEXT NOT NULL,
  vendor_cost         INTEGER NOT NULL CHECK (vendor_cost >= 0),     -- operator only
  platform_price      INTEGER NOT NULL CHECK (platform_price >= 0),  -- the photographer's cost
  active              INTEGER NOT NULL DEFAULT 1,
  sort                INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_platform_options_product ON platform_product_options(platform_product_id, sort);
