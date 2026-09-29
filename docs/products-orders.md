# Products and orders — design (Phase A locked 2026-09-29)

Roadmap item 4 (`docs/backlog.md`). Meant to be the main selling point of the
SaaS: the photographer sells add-ons (prints, albums, frames, extra
retouching, extra picks) and sees what every shoot really earned.

The core idea: **sell at the moment the client is looking at the photos.**
The guest is already on the pick page choosing favourites; that is where
"enlarge this one to 16×20" happens. Tools photographers use today (LINE +
spreadsheet + bank transfer) lose that moment.

## Phases

| Phase | What | Who sees it | Risk tier |
|---|---|---|---|
| **A** | Catalogue, orders recorded by the photographer, extra-pick fee added automatically, revenue on the dashboard | admin only | High (money data) |
| **B** | Guest add-on shop on the pick page: pick a product for a photo, send an order request; photographer confirms; payment off-platform (transfer / cash) | guest + admin | High + security review (guest writes) |
| **C** | Online payment (ECPay / TapPay / LINE Pay), e-invoice, platform fee | guest + admin | High; legal/tax check first. Referral payouts (roadmap 5) need this |

A is built so B needs no schema change, only new routes and UI. C adds
payment tables; it does not change A/B's.

## Decisions

- **Money is an integer NT$, tax included.** No floats, no currency column
  (add one only if a non-TWD photographer ever joins).
- **Every order line snapshots name, option, price and cost** at creation.
  Editing or retiring a product never changes an existing order.
- **Products have options** (尺寸 / 材質) from day one: price and cost live on
  the option, not the product. A product without choices has exactly one
  option. Retrofitting options later would move prices between tables.
- **Products are never deleted, only retired** (`active = 0`), because order
  lines point at them.
- **Product kind decides what a line needs:**
  - `print` — one photo per unit (放大、相框、畫布)
  - `album` — a set of photos, with an optional required count (相本 20 張)
  - `service` — no photos (加修、急件、外拍加時)
  - `extra_pick` — system only, never in the catalogue; the extra-pick fee
- **Payment is recorded on the order, not per line**: `paid_amount`,
  `paid_at`, `paid_method` (`cash` / `transfer` / `other`). Partial payment
  (deposits) is `paid_amount < total`.
- **Revenue is counted when paid** (`paid_at`), cost when paid too. Simple for
  a small studio and matches how they think ("錢進來了沒").
- `photographer_id` on products and orders, always the Worker's constant,
  never from a body — same rule as projects and settings. Every query is
  scoped by it; an order's project must belong to the same photographer.
- Product images (Phase B thumbnails) **cannot live in the `imagepicker`
  bucket** (180-day lifecycle). Same approach as the logo: D1 blob, ≤ 200 KB,
  type by magic bytes. Revisit if a photographer wants many large images.

### Extra-pick fee (the automatic line)

Fee = `max(0, count − pick_limit) × extra_price`, from the **latest
submission's** snapshot (never the live project plan).

- At **start-retouch** the Worker upserts one `system` order for the project
  with one `extra_pick` line ("加挑 10 張 × NT$200"). No fee → no order (an
  existing unpaid one is removed).
- A **reopen + resubmit + start-retouch** recomputes it while the order is
  unpaid. Once anything is paid it is never rewritten; the admin sees
  「加挑張數已變更（原 10 → 現 14），請確認」 and adjusts by hand.
- The photographer can edit or delete it like any other order (a discount,
  a waived fee). After a manual edit the system stops touching it
  (`source` flips to `admin`).

Trade-off: the alternative is no automation, just a "suggested fee" button.
Less can go wrong, but forgetting to charge extra picks is exactly the money
a studio loses today, so automatic is worth the extra tests.

## Order states

```
requested ──confirm──▶ confirmed ──▶ fulfilled
    │                     │
    └──────cancel─────────┴──▶ cancelled
```

- `requested` exists only for guest orders (Phase B). Admin and system orders
  start `confirmed`.
- Payment is independent of state: a confirmed order can be unpaid, part-paid
  or paid; fulfilled-but-unpaid is allowed (studios deliver on trust).
- A guest can only cancel their own `requested` order. After `confirmed`
  only the photographer changes it.
- Cancelled orders stay in the table (history) and count for nothing.

## Schema (Phase A — new tables only)

`worker/migrations/2026-xx-xx-products-orders.sql`, hand-run before the merge:

```sql
CREATE TABLE IF NOT EXISTS products (
  id              TEXT PRIMARY KEY,
  photographer_id TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('print','album','service')),
  name            TEXT NOT NULL,          -- ≤ 60
  description     TEXT NOT NULL DEFAULT '',-- ≤ 500, shown to guests in B
  photo_count     INTEGER,                -- album: required photos, NULL = any
  guest_visible   INTEGER NOT NULL DEFAULT 0,  -- Phase B shop
  active          INTEGER NOT NULL DEFAULT 1,
  sort            INTEGER NOT NULL DEFAULT 0,
  image           BLOB, image_type TEXT, image_updated_at TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_owner ON products(photographer_id, active, sort);

CREATE TABLE IF NOT EXISTS product_options (
  id          TEXT PRIMARY KEY,
  product_id  TEXT NOT NULL,
  label       TEXT NOT NULL,              -- '16×20 無框', '' when single
  price       INTEGER NOT NULL CHECK (price >= 0),
  cost        INTEGER NOT NULL DEFAULT 0 CHECK (cost >= 0),
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_options_product ON product_options(product_id, sort);

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
  confirmed_at    TEXT, fulfilled_at TEXT, cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_project ON orders(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_owner_paid ON orders(photographer_id, paid_at);

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
  photo_keys    TEXT NOT NULL DEFAULT '[]'  -- JSON; print: 1 per unit, album: the set
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
```

Totals are **computed, not stored**: `total = Σ unit_price × qty − discount`
(never below 0; a discount larger than the subtotal is a 400). One source of
truth, nothing to drift. Fine at a studio's volume.

## API (Phase A, all `isAdminToken`, `Cache-Control: private, no-store`)

| Route | Answer |
|---|---|
| `GET /api/admin/products` | products with their options, retired included (flag) |
| `POST /api/admin/products` | create with ≥ 1 option |
| `PUT /api/admin/products/:id` | fields present change; options replaced as a set (existing ids kept, missing ones retired, never deleted) |
| `POST /api/admin/products/:id/retire` / `…/restore` | |
| `GET /api/admin/projects/:id/orders` | orders + items + computed totals + extra-pick warning |
| `POST /api/admin/projects/:id/orders` | lines by `option_id` + qty (+ photo keys); price/cost/name **taken from the catalogue**, not the body; admin may override `unit_price` explicitly |
| `PUT /api/admin/orders/:id` | discount, note, lines |
| `POST /api/admin/orders/:id/payment` | `{paid_amount, paid_method, paid_at?}` |
| `POST /api/admin/orders/:id/status` | `{status}` along the allowed arrows only; 409 otherwise |
| `GET /api/admin/orders?status=&unpaid=1` | all orders across projects (the to-do list) |
| `GET /api/admin/orders/:id/export.csv` | photo keys per line — the list for the print lab |
| `GET /api/admin/stats` | gains `revenue`: per month `{paid, cost, margin}`, `outstanding` (confirmed/fulfilled, unpaid remainder), `todo.unpaid_orders` |

Photo keys on a line must be inside the project's folders (`folderCovers`),
checked on every write.

## Phase B — guest shop (outline; detailed design before building)

- The pick page shows products with `guest_visible = 1` and `active = 1`:
  a 「加購」 button on the preview, and a cart.
- `POST /api/pick/orders` with the **owner seat key** only — viewers can
  browse but not order. Body: option ids + qty + photo keys + guest note.
  Server takes prices from the catalogue, checks photo keys against the
  link's folder snapshot, caps lines (e.g. ≤ 50) and qty, rate-limits.
- The guest sees their own orders' status and total, never cost, never the
  photographer's note.
- New request → email to the photographer (reuse the submit mail, same
  throttle).
- Allowed in `picking`, `submitted`, `retouching`; refused on archived
  projects. Delivered: still allowed (reprints are sales too) — Tim decides.
- Payment instructions (bank account text) come from `studio_settings` —
  a new appended column.

## UI

- **Settings → 商品**: catalogue list, add/edit, options table, retire.
- **Project detail → 訂單**: the project's orders, extra-pick line, add
  order, record payment, status buttons, CSV export.
- **Side menu → 訂單**: every order across projects, filter unpaid /
  requested (Phase B requests show up here first).
- **Dashboard**: 本月營收、毛利、未收款; the month chart gains revenue.

## Security notes

- Phase A adds no public route. The risk is wrong totals and cross-project
  or (later) cross-photographer reads: test every route with another
  photographer's ids once accounts exist; today, test that a project/order id
  from a different `photographer_id` row is 404.
- Never trust price, cost, name or kind from a body (the admin
  `unit_price` override is the one explicit exception, admin-only).
- `cost` never leaves admin routes.
- Phase B is the real attack surface (guest writes): security review
  required, with the seat-key, folder and rate-limit checks above.

## Tim's answers (2026-09-29)

1. Sells today: **相本書** (album) and **無框畫** (print). The catalogue is
   entered by Tim in the UI; nothing is seeded.
2. Extra-pick fee automatic at start-retouch: **yes**.
3. **No deposits.** One payment per order: `paid_amount` / `paid_at` /
   `paid_method` stay on `orders`; no payments table.
4. Delivered projects still accept guest orders (Phase B).
5. Guests must see a product photo (Phase B). The `image` columns ship in
   A's migration so B needs no schema change; the image routes come with B.

## Phase A scope (what is built now)

In: products + options CRUD (retire/restore, never delete); project orders
(create, edit lines/discount/note, payment, status); the automatic
extra-pick order; `GET /api/admin/orders` across projects; stats `revenue`;
UI in settings (商品), project detail (訂單), an orders page in the side
menu, dashboard revenue cards.

Out (later): product image routes and the guest shop (B); CSV export for the
print lab (small follow-up once lines carry photos in real use); payments
gateway (C).

### Extra-pick details

- Source: the project's latest `submissions` row (by `created_at`). No
  submission, `pick_limit` NULL, `extra_price` NULL, or `count ≤ pick_limit`
  → fee 0.
- `GET /api/admin/projects/:id/orders` returns
  `extra_pick: {count, pick_limit, extra_price, extra, fee, order_id,
  matches}` computed on read, so the photographer sees a mismatch
  (「加挑張數已變更」) without the Worker ever rewriting a paid order.
