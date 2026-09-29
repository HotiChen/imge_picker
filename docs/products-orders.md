# Products and orders — design (Phase A locked 2026-09-29)

Products & orders, in the product roadmap in `docs/backlog.md`. Meant to be the main selling point of the
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
| **C** | Online payment (ECPay / TapPay / LINE Pay), e-invoice, platform fee | guest + admin | High; legal/tax check first. 「Referral payouts」 (`docs/backlog.md`) need this |

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

`worker/migrations/2026-09-29-products-orders.sql`, hand-run before the merge
(until it runs, the order routes, stats and start-retouch answer 500):

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

### Worker decisions (Phase A build)

Where the design above left a choice open, the Worker does this:

- **Limits (400 `{error, code}`, nothing written):** name and option label
  ≤ 60, description and note ≤ 500, ≤ 20 options per product, ≤ 50 lines per
  order, qty 1–999, one unit price/cost ≤ NT$10,000,000, ≤ 500 photo keys per
  line and 1000 per order. Codes: `invalid_kind|name|description|photo_count|
  guest_visible|sort|options|label|price|cost`, `invalid_lines`,
  `too_many_lines`, `unknown_line`, `unknown_option`, `retired_option`,
  `invalid_qty`, `invalid_unit_price`, `invalid_photo_keys`,
  `photo_not_in_project`, `invalid_discount`, `discount_exceeds_subtotal`,
  `invalid_note`, `below_paid`, `invalid_paid_amount|method|at`, `overpaid`,
  `invalid_status`.
- **Photos on a line:** unique, inside the project's folders, never a `_`
  key. print: at most one per unit (none yet is fine); album: any number —
  `photo_count` is advisory only (a studio often settles the count later) and
  is kept on albums only; service and extra_pick: none.
- **Options** are the active set: the array order is the sort order.
- **Order lines on PUT** are the whole set: `{id, qty?, photo_keys?,
  unit_price?}` keeps a line and its snapshot (its option cannot change —
  remove it and add a new one), `{option_id, …}` adds one, a line left out is
  removed. At least one line; there is no DELETE — cancel instead.
  `unit_price` absent or `null` = the catalogue's (new) / unchanged (kept).
- **Status:** asking for the current status is a 200 no-op. fulfilled →
  confirmed is allowed (undo; clears `fulfilled_at`). `confirmed_at` keeps its
  first stamp. A move that loses a race is 409 `bad_transition` with the real
  `from`.
- **Cancelled** orders: lines, discount and a non-zero payment are 409
  `cancelled`; the note can change and a payment can be cleared (refund).
- **Money guards:** a payment may not exceed the total (400 `overpaid`), and
  a PUT may not bring the total under what was paid (400 `below_paid`: record
  the refund first). `paid_at` is a date or ISO time, 2000 → now + 1 day,
  default now. `outstanding` counts only confirmed/fulfilled orders.
- **Concurrent edits:** PUT and payment are conditional on the order's
  `updated_at`; the loser is 409 `conflict` and writes nothing.
- **source** flips `system → admin` on any admin write (PUT, payment,
  status); a guest order stays `guest`.
- **Extra-pick order:** written in the same D1 batch as the start-retouch
  phase move, gated on the latest submission not having changed (a submit
  landing in between retries, up to 3 times, then 409 `busy`). A new one is
  created only when the project has no system order **and** no order with an
  extra-pick line, so a cancelled or edited one is never replaced; to waive
  the fee, cancel it or set its `unit_price` to 0 (removing the line and
  pressing start-retouch again recreates it). `extra_pick` also carries
  `order_extra` (the photo count on the charged line); `matches` compares
  that count with `extra`, so a waived price is not a mismatch.
- **Archived projects:** orders are still readable and can still be created
  and edited (a late reprint is a real sale).
- `GET /api/admin/orders`: newest 500, with `project_title`, lines and money;
  an unknown `status` is 400.
- **Stats:** `revenue: [{month, paid, cost, margin}]` (12 months, same Taipei
  window as `per_month`, by `paid_at`, cost of the whole order counted in the
  month it was paid, cancelled excluded), `outstanding` (NT$), and
  `todo.unpaid_orders` (orders with outstanding > 0, archived projects
  included — the money is still owed).

## Platform catalogue (A2 — built before A merges, decided 2026-09-29)

Tim is the operator. He lists printable products (相本書, 無框畫, …) with
their cost; photographers pick from that catalogue and set their own price.
The platform lives on the product flow: a photographer who could add their
own prints with their own lab would pay the platform nothing.

### Decisions

- **Two catalogues.** `platform_products` / `platform_product_options`,
  written only by the operator. A photographer's `products` row is either
  **custom** (kind `service` only — 加修, 急件, …) or **adopted** from a
  platform product (kind `album` / `print`, `platform_product_id` set).
  A photographer can no longer create an album/print product of their own
  (400 `platform_only`).
- **Custom products are switched off** (Tim, 2026-09-29): photographers sell
  platform products only. `CUSTOM_PRODUCTS` in wrangler.toml `[vars]` turns
  them on when exactly `"on"` (unset / anything else = off). Off: create,
  edit and restore of a custom product → 403 `custom_products_disabled`;
  retire, adopted products, reads, old order lines and the extra-pick order
  are unaffected. `GET /api/admin/products` returns `custom_products_enabled`;
  settings leaves 「新增服務」 out of the page when it is false.
- **Three prices per option.**
  | | set by | seen by |
  |---|---|---|
  | `vendor_cost` (what the lab charges Tim) | operator | operator only |
  | `platform_price` (the photographer's cost) | operator | operator, photographer |
  | `price` (the guest's price) | photographer | everyone |
  Today `platform_price` = `vendor_cost` (no platform cut) **and no platform fee
  is charged**; both prices are kept so a margin or fee can start without a
  schema change. The 15% fee below is planned for later (with online payment).
- **Photographer's price ≥ platform price**, checked on adopt, on edit, and
  again when a line is created (the operator may have raised the platform
  price since): 400 `below_platform_price`; the photographer's catalogue
  flags such options.
- **Subset of options.** Adopting picks some of the platform options; each
  adopted option carries `platform_option_id` and the photographer's price.
  Name, description, kind, photo_count and image come from the platform
  product (not editable by the photographer).
- **Cost on an order line** for an adopted option is the platform price at
  line creation (snapshot); the line also snapshots `platform_option_id` and
  `vendor_cost`. `vendor_cost` never leaves operator routes.
- A retired platform product or option makes the adopted one unusable for
  new lines (`retired_option`); existing orders keep their snapshots.
- **Operator auth (temporary until accounts):** `OPERATOR_TOKEN` secret,
  fails closed when unset, and is refused if it equals `PHOTOGRAPHER_TOKEN`.
  Photographer, pick, client, studio and session tokens → 401 on
  `/api/operator/*`; the operator token → 401 on `/api/admin/*`.
- **Product images:** uploaded by the operator only, D1 blob ≤ 200 KB,
  PNG/JPEG/WebP by magic bytes (same rules as the logo). Served publicly at
  `GET /api/platform/products/:id/image` (nosniff, CSP `default-src 'none'`,
  ETag) — product photos are not secret and the guest shop (B) needs them.
- **Future platform fee — rules decided by Tim 2026-09-29, not charged yet.**
  Whoever gives a discount absorbs it.
  1. **Fee = (list price − platform price) × qty × 15%** per platform line.
     List price = the photographer's catalogue price when the line was made;
     platform price = the regular platform price (never a promotional one).
  2. **Photographer's discounts** (order discount, a lowered unit price on a
     line) come out of the photographer's share; the fee is still computed
     from the list price. **Cap:** the fee never exceeds the line's actual
     margin (what the guest paid − platform price, floor 0), so a deep
     discount can cost the photographer their margin but never makes them
     pay to sell.
     Example: list 1000, platform 800 → fee 30. At 85% (850): photographer
     keeps 850 − 800 − 30 = 20. At 80% (800): margin 0 → fee 0.
  3. **Platform's discounts** (a platform-run promotion) come out of the
     platform's fee; the photographer's income is unchanged. If the
     promotion is larger than the fee, **the platform pays the photographer
     the difference** (Tim chose (a)). Example: list 1000, platform 800,
     platform promo −50 → guest pays 950, photographer still nets 170, the
     platform's fee 30 − 50 = −20 (the platform pays 20).
  4. Orders therefore need two discounts kept apart: the photographer's
     (`orders.discount` today) and the platform's (new, with the promotion).
  5. If the platform price is ever set above vendor cost, the platform also
     earns that spread — say so when telling photographers.
  Nothing is charged now. Lines keep `platform_option_id` and the platform
  price (`unit_cost`). **Before the fee starts**, lines must also snapshot
  the list price (a new `order_items.list_price`), because `unit_price` can
  be overridden; the fee applies only to orders created after that.

### Schema

A's migration has not been run yet, so its CREATEs gain the link columns
directly (no ALTER): `products.platform_product_id`,
`product_options.platform_option_id`, `order_items.platform_option_id`,
`order_items.vendor_cost`. Two new tables:

```sql
CREATE TABLE IF NOT EXISTS platform_products (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('print','album')),
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  photo_count INTEGER, active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  image BLOB, image_type TEXT, image_updated_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS platform_product_options (
  id TEXT PRIMARY KEY, platform_product_id TEXT NOT NULL,
  label TEXT NOT NULL,
  vendor_cost INTEGER NOT NULL CHECK (vendor_cost >= 0),
  platform_price INTEGER NOT NULL CHECK (platform_price >= 0),
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0
);
```

### API

| Route | Auth | |
|---|---|---|
| `GET/POST /api/operator/products`, `PUT /api/operator/products/:id`, `POST …/retire`, `…/restore` | operator | same shape and rules as the photographer's products (options as a set, never deleted) |
| `PUT/DELETE /api/operator/products/:id/image` | operator | logo rules |
| `GET /api/operator/stats` | operator | this month and 12 months: per platform product, qty sold, platform revenue, vendor cost, margin (paid orders, cancelled excluded) |
| `GET /api/platform/products/:id/image` | public | the image, 404 when none |
| `GET /api/admin/platform-products` | photographer | active platform products + active options with `platform_price`, never `vendor_cost`; which ones this photographer already adopted |
| `POST /api/admin/products/from-platform` | photographer | `{platform_product_id, options: [{platform_option_id, price}]}`; one adopted product per platform product (409 `already_adopted`) |
| `PUT /api/admin/products/:id` on an adopted product | photographer | only the option set (platform option ids + prices), active, sort |

### UI

- `operator.html` — own sign-in (operator token, stored apart from the
  photographer's), platform catalogue (options: label, 廠商成本, 平台價),
  image upload, a small sales table from `/api/operator/stats`. Not in the
  photographer's side menu.
- Settings → 商品: 「從平台加入」 (pick product, tick sizes, set prices, shows
  平台價 as the floor), adopted products show the platform image and a
  warning when a price has fallen below the platform price; 「新增服務」 for
  custom (service only).

### Worker decisions (A2 build)

- **Operator token** only as `Authorization: Bearer` (never `?t=` or
  `X-Share-Token`); unknown `/api/operator/*` is 404 after the token check.
  `OPERATOR_TOKEN` should be ≥ 32 random characters (e.g.
  `openssl rand -hex 32`), never the photographer's.
- **Before merging**, Tim runs `PRAGMA table_info(products)` in the D1
  Console: it must return nothing (no table from an earlier draft), then the
  migration.
- **Operator catalogue:** kinds `print|album`; each option needs both
  `vendor_cost` and `platform_price` (`invalid_vendor_cost`,
  `invalid_platform_price`), same limits as A. A platform price under the
  vendor cost is not refused (Tim may subsidise).
- **Custom products** are `service` only: `kind` album/print on POST or PUT
  → 400 `platform_only`.
- **Adopt** (`from-platform`): `guest_visible` and `sort` may be set too.
  Codes: `unknown_platform_product`, `retired_option` (retired product or
  option), `invalid_options` (not this product's, repeated, none),
  `invalid_price`, `below_platform_price`; 409 `already_adopted` with the
  existing `product_id` (retired ones count; checked again inside the insert,
  so a race lands one).
- **Adopted PUT:** `options: [{platform_option_id, price}]` (an option already
  adopted is the same row, repriced; left out = retired), `guest_visible`,
  `sort`. `kind|name|description|photo_count` → 400 `platform_managed`.
  `active` is retire/restore, as for every product. Keeping a platform option
  the operator retired → `retired_option`.
- **Reads of an adopted product** show the platform's live kind, name,
  description, photo_count, image and option labels; each option's `cost` is
  the current platform price, plus `platform_price`, `platform_active` and
  `below_platform_price`.
- **The floor** applies to the catalogue price and to an admin `unit_price`
  override alike; a kept platform line may not be repriced under its own
  snapshotted `unit_cost`. The order discount is not held to it (it only cuts
  the photographer's margin; the line cost stays the platform price).
- **A kept platform line** keeps its snapshot for the units already sold.
  Fewer units, photo edits and a reprice at or above its own `unit_cost` are
  always allowed, retired or not. **More units** need the platform product
  and option still active (else `retired_option`) and today's platform price
  ≤ the line's `unit_cost` (else `below_platform_price`, "add a new line"),
  so a line keeps one cost.
- **Operator stats:** `{per_month: [{month, qty, revenue, vendor_cost,
  margin}] × 12, this_month, products: [{platform_product_id, name, kind,
  active, qty, revenue, vendor_cost, margin, this_month}]}` — every platform
  product, all photographers, lines' snapshots (revenue = `unit_cost`), by
  `paid_at` (any payment) in Taipei months, cancelled excluded.
- **Images:** 413 `too_large`, 415 `unsupported_type`, 404 unknown product.
  The public route serves a retired product's image too (old orders show it);
  non-GET is 405, anything else under `/api/platform/` 404.
