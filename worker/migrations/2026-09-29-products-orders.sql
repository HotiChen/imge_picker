-- Products and orders, Phase A + the platform catalogue A2
-- (docs/products-orders.md). Paste into the D1
-- Console for imagepicker-db once, after 2026-09-28-dashboard-settings.sql and
-- before deploying the Worker that serves /api/admin/products and the order
-- routes: until it runs those routes, the project orders view, the stats and
-- start-retouch (which writes the extra-pick order in the same batch as the
-- phase move) answer 500. Guest pick links keep working.
--
-- New tables and indexes only, all IF NOT EXISTS: safe to paste again. (An
-- earlier draft of this file, without the platform link columns, was never
-- run on prod; a database that did run it needs those tables dropped first.)

CREATE TABLE IF NOT EXISTS products (
  id              TEXT PRIMARY KEY,
  photographer_id TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('print','album','service')),
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  photo_count     INTEGER,
  guest_visible   INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  sort            INTEGER NOT NULL DEFAULT 0,
  image           BLOB,
  image_type      TEXT,
  image_updated_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  platform_product_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_products_owner ON products(photographer_id, active, sort);

CREATE TABLE IF NOT EXISTS product_options (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL,
  label       TEXT NOT NULL,
  price       INTEGER NOT NULL CHECK (price >= 0),
  cost        INTEGER NOT NULL DEFAULT 0 CHECK (cost >= 0),
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  platform_option_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_options_product ON product_options(product_id, sort);

CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  photographer_id TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('admin','guest','system')),
  status          TEXT NOT NULL DEFAULT 'confirmed'
                  CHECK (status IN ('requested','confirmed','fulfilled','cancelled')),
  picker_id       TEXT,
  discount        INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  paid_amount     INTEGER NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  paid_at         TEXT,
  paid_method     TEXT CHECK (paid_method IN ('cash','transfer','other')),
  note            TEXT NOT NULL DEFAULT '',
  guest_note      TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  confirmed_at    TEXT,
  fulfilled_at    TEXT,
  cancelled_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_project ON orders(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_owner_paid ON orders(photographer_id, paid_at);

CREATE TABLE IF NOT EXISTS order_items (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('print','album','service','extra_pick')),
  product_id    TEXT,
  option_id     TEXT,
  name          TEXT NOT NULL,
  option_label  TEXT NOT NULL DEFAULT '',
  unit_price    INTEGER NOT NULL CHECK (unit_price >= 0),
  unit_cost     INTEGER NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  qty           INTEGER NOT NULL CHECK (qty BETWEEN 1 AND 999),
  photo_keys    TEXT NOT NULL DEFAULT '[]',
  platform_option_id TEXT,
  vendor_cost   INTEGER NOT NULL DEFAULT 0 CHECK (vendor_cost >= 0)
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

-- The platform catalogue (A2, docs/products-orders.md): the operator's
-- printable products. products.platform_product_id and
-- product_options.platform_option_id link an adopted product to it;
-- order_items snapshots platform_option_id and vendor_cost.
CREATE TABLE IF NOT EXISTS platform_products (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('print','album')),
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  photo_count      INTEGER,
  active           INTEGER NOT NULL DEFAULT 1,
  sort             INTEGER NOT NULL DEFAULT 0,
  image            BLOB,
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
  vendor_cost         INTEGER NOT NULL CHECK (vendor_cost >= 0),
  platform_price      INTEGER NOT NULL CHECK (platform_price >= 0),
  active              INTEGER NOT NULL DEFAULT 1,
  sort                INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_platform_options_product ON platform_product_options(platform_product_id, sort);
