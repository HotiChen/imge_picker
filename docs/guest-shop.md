# Guest shop (Phase B) — design (2026-09-30, for review)

Detailed design of Phase B in `docs/products-orders.md`, hung off the delivery
gallery (`docs/delivery.md`). Goal (Tim): after delivery the guest buys from
the gallery and the order reaches the photographer with **no manual step**:
it lands in orders as `requested`, an email and an orders-page notice arrive,
one tap confirms.

## Stages

| Stage | What | Writes | Tier | Ships alone |
|---|---|---|---|---|
| **S1** | 購買資訊: guest-visible products + delivery promo + countdown | none from guests | High (worker: prices, cost leak), Normal (UI) | yes |
| **S2** | Guest ordering: cart, contact, order key, receipt, email, one-tap confirm | guest writes | High + security review | needs S1 |
| **S3** | Album auto-layout preview at ordering; layout stored on the line | guest writes | High (worker), Normal (UI) | needs S2 |

## Decisions

- **Delivered mode only.** Shop routes answer only when `pickReadScope(share).mode
  === 'delivered'`. Picking-phase shopping stays out (open question 4).
- **Any link holder may order** (owner and viewers, Tim). An order is tied to an
  **order key**, not the seat: the server issues a random key with the first
  order (returned once, SHA-256 stored on the order, like `pickers.key_hash`);
  the browser keeps it in localStorage per project and sends it as
  `X-Order-Key`. A guest sees and cancels only orders carrying their key's hash.
  `picker_id` is still recorded when the seat holder orders (information only).
- **Bank transfer.** `studio_settings.transfer_info` (free text ≤ 500) is shown
  on the guest's receipt. Recommended: shown once the order is `confirmed`
  (before that: 「攝影師確認後會顯示匯款資訊」), so nobody pays for an order the
  photographer then cancels (open question 1). The photographer records payment
  with the existing payment route (`paid_method: 'transfer'`).
- **Only guest-visible, sellable products**: `guest_visible = 1`, `active = 1`,
  platform product and option active, kind `print` or `album`. Services stay
  admin-only. Guests see name, description, option label, price, promo price,
  `photo_count`, image. **Never** `cost`, `platform_price`, `vendor_cost`.
  Image = `GET /api/platform/products/:platform_product_id/image` (public today).
- **Print (無框畫)**: one final photo per unit; a guest print line has exactly
  `qty` distinct keys (same photo twice = a second line). Stricter than the
  admin rule (`keys ≤ qty`), so the photographer never gets a unit without a photo.
- **Album (相本書)**: defaults to **all delivered finals** in gallery order;
  the guest can exclude/reorder (S3). `photo_count` stays advisory (Phase A rule).
  qty ≤ 3 copies.
- **Photos must be inside the finals** (`pickFinals(project)`), never a `_` key
  and never proofs, even when proof download is on.
- **Promo**: X% off every guest-visible option for N days after delivery.
  Studio default in settings, **per-project override** (assumed — open question 2).
  Server-only validity: `delivered_at ≤ now < delivered_at + N days`, server
  clock. Price rule, integer NT$:
  `promo_price = max(platform_price, floor((price × (100 − pct) + 50) / 100))`
  — clamped at the platform floor (the existing `below_platform_price` rule);
  settings shows which options clamp. Line snapshots `list_price`,
  `promo_percent`, `unit_price` (= promo price or list price).
- **`requested` → one tap `confirmed`** through the existing
  `POST /api/admin/orders/:id/status` (`ORDER_ARROWS.requested` already allows
  it). `requested` owes nothing (`ORDER_OUTSTANDING_SQL` already excludes it).
- **Album layout JSON lives in D1** on the order line (`order_items.layout`),
  never in R2 (`_books/*.json` dies after 180 days). Guests preview thumbnails
  only (`?w=400`); 300 dpi print files are rendered later by the photographer
  from the originals in `book_editor`.
- Minimum personal data, contact kept from other guests, retention limit —
  see PDPA.

## Data model (append-only)

`worker/migrations/2026-10-xx-guest-shop-s1.sql` (before S1's merge):

```sql
ALTER TABLE studio_settings ADD COLUMN promo_percent INTEGER;  -- 0–50, NULL/0 = no promo
ALTER TABLE studio_settings ADD COLUMN promo_days INTEGER;     -- 1–180, NULL = 30
ALTER TABLE projects ADD COLUMN promo_percent INTEGER;         -- NULL = studio default, 0 = none here
ALTER TABLE projects ADD COLUMN promo_days INTEGER;            -- NULL = studio default
ALTER TABLE projects ADD COLUMN shop_enabled INTEGER NOT NULL DEFAULT 1;  -- per-project kill switch
```

`…-guest-shop-s2.sql` (before S2's merge):

```sql
ALTER TABLE studio_settings ADD COLUMN transfer_info TEXT;          -- ≤ 500, shown to guests
ALTER TABLE studio_settings ADD COLUMN ship_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN last_order_notified_at TEXT;        -- order-mail throttle slot
ALTER TABLE orders ADD COLUMN guest_key_hash TEXT;                  -- SHA-256 of the order key
ALTER TABLE orders ADD COLUMN contact_name TEXT;                    -- ≤ 50
ALTER TABLE orders ADD COLUMN contact_method TEXT;                  -- 'line'|'phone'|'email'
ALTER TABLE orders ADD COLUMN contact_value TEXT;                   -- ≤ 100
ALTER TABLE orders ADD COLUMN delivery_method TEXT;                 -- 'pickup'|'ship'
ALTER TABLE orders ADD COLUMN ship_address TEXT;                    -- ≤ 200, only for 'ship'
ALTER TABLE orders ADD COLUMN contact_erased_at TEXT;
ALTER TABLE orders ADD COLUMN notified INTEGER NOT NULL DEFAULT 0;  -- 1 = mailed
ALTER TABLE order_items ADD COLUMN list_price INTEGER;              -- catalogue price at creation
ALTER TABLE order_items ADD COLUMN promo_percent INTEGER;           -- NULL = no promo
CREATE INDEX IF NOT EXISTS idx_orders_guest ON orders(project_id, guest_key_hash);
```

`list_price` is also the column the future platform fee needs
(products-orders.md, "Future platform fee"): write it on **admin** lines too
from S2 on. `…-guest-shop-s3.sql`:

```sql
ALTER TABLE order_items ADD COLUMN layout TEXT;  -- album only, JSON ≤ 64 KB, Worker's serialisation
```

Note each in `worker/schema.sql`. Before each migration runs, the new routes
answer 500 and everything else keeps working (`withoutMissingColumn`).

## API

All guest routes: pick token (`?t=` / `X-Share-Token`) via `resolvePick`;
`SHARED_LINK_HEADERS`; revoked/expired/archived → 401; not delivered → 409
`not_delivered`; `shop_enabled = 0` → 409 `shop_closed`.

| Route | Auth | Answer |
|---|---|---|
| `GET /api/pick/shop` (S1) | token | `{products: [{id, kind, name, description, photo_count, image_url, options: [{id, label, price, promo_price}]}], promo: {percent, ends_at} \| null, now, ship_enabled}` — `now` is the server time for the countdown; `promo_price` null outside the window |
| `POST /api/pick/orders` (S2) | token, optional `X-Order-Key`, `X-Picker-Key` | creates a `requested`, `source 'guest'` order; 201 `{order, order_key?}` (`order_key` only when newly issued) |
| `GET /api/pick/orders` (S2) | token + `X-Order-Key` | this key's orders in this project, newest first; no/unknown key → `{orders: []}` |
| `POST /api/pick/orders/:id/cancel` (S2) | token + `X-Order-Key` | own + `requested` only → `cancelled`; else 404 / 409 `bad_transition` |

**POST body**: `{lines: [{option_id, qty, photo_keys, layout?}], contact: {name,
method, value}, delivery: {method, address?}, note?, expected_total, consent:
true, website: ''}`. The server takes name, kind, price, cost, promo from the
catalogue (reusing `orderLines`); nothing money-related is read from the body.
`expected_total` is what the guest saw: if the server's total differs (promo
ended, price changed) → 409 `price_changed` with the fresh quote, nothing
written. It protects the guest, not the photographer.

**Guest order view** (the only shape a guest route returns): `{id, status,
created_at, confirmed_at, cancelled_at, total, paid: paid_amount >= total,
guest_note, contact, delivery, items: [{name, option_label, qty, list_price,
promo_percent, unit_price, photo_keys, layout}], transfer_info (confirmed only)}`.
Never `note`, `unit_cost`, `vendor_cost`, `platform_option_id`,
`guest_key_hash`, `discount` breakdown beyond `total`.

**Limits** (400 `{error, code}`, nothing written): ≤ 20 lines; qty 1–10 (print),
1–3 (album); ≤ 500 keys per album line (`ORDER_LINE_PHOTOS_MAX`), ≤ 1000 per
order; name 1–50, contact value 1–100, address 1–200 (only with `ship`),
note ≤ 500, no control / bidi characters in any of them; body ≤ 256 KB
(413 `too_large`); `layout` ≤ 64 KB serialised.
Codes, new: `invalid_contact`, `invalid_delivery`, `ship_disabled`,
`consent_required`, `product_not_offered`, `photo_not_in_finals`,
`invalid_layout`, `price_changed` (409), `too_many_open_orders` (409),
`rate_limited` (429), `bot` (400, honeypot). Reused: `invalid_lines`,
`too_many_lines`, `unknown_option`, `retired_option`, `invalid_qty`,
`invalid_photo_keys`, `invalid_note`.

**Admin (photographer token)**:

| Route | Change |
|---|---|
| `PUT /api/admin/settings` | + `promo_percent` (0–50 int, null), `promo_days` (1–180, null), `transfer_info` (≤ 500, null), `ship_enabled` (bool) |
| `PATCH /api/admin/projects/:id` | + `promo_percent` (null/0–50), `promo_days` (null/1–180), `shop_enabled` (bool); still one strict key set, anything else 400 `invalid_body` |
| `GET /api/admin/orders`, `…/projects/:id/orders` | orders gain `contact` (`{name, method, value, delivery_method, ship_address, erased_at}`), items gain `list_price`, `promo_percent`, `has_layout`; single-order read also `layout` |
| `POST /api/admin/orders/:id/erase-contact` | clears `contact_value`, `ship_address` (name kept for the books), stamps `contact_erased_at` |
| `GET /api/admin/stats` | `todo.requested_orders` |
| `GET /api/admin/products` | unchanged (already has `guest_visible`, `platform_price`) |

## Guest UI (phone-first, `index.html` + `js/pick.js`, delivered mode only)

**S1 — 購買資訊** (the bar entry from the guest-UI backlog item): a sheet
listing product cards (photo, name, description, per option `NT$price` struck
through + `NT$promo_price` when in promo). Promo banner: 「交件優惠 85 折，剩 12 天
5 小時」 computed from `ends_at − now` with the server's `now` offset (a wrong
phone clock only changes the display, never the price). Empty list → no entry
at all (removed from the DOM). S1 ends with 「聯絡攝影師訂購」 until S2 ships.

**S2 — ordering**
1. Product card → 「加入」. Print: choose option, then **pick photos from the
   gallery** (tap photos, counter 「已選 2 / 數量 2」); qty follows the picks.
   Album: option → all finals preselected (S3 adds the editor).
2. Cart (bottom sheet): lines, per-line price with promo, total, 「移除」.
3. Form: 姓名, 聯絡方式 (LINE ID / 電話 / Email, one required, one field),
   取件方式 (面交取件; 宅配 only if `ship_enabled`, then 地址), 備註, 個資告知
   box with link to `privacy.html` and a required checkbox, hidden honeypot.
4. Submit → receipt: status 「待攝影師確認」, lines, total, 「取消訂單」 while
   requested; once confirmed, transfer info + 「匯款後請告知攝影師」.
5. 「我的訂單」 in the bar when this browser holds an order key. A lost key
   (other browser) = no access; the photographer still has the order.
States: loading, empty shop, promo/no promo, `price_changed` (show new total,
ask again), `shop_closed`, 429, offline. The page holds no secret beyond the
guest's own order key and link token.

**S3 — album preview** (under the album line, before 加入購物車)
- Runs `AutoLayout.run()` in the guest browser from `?w=400` thumbnails; pages
  drawn with the `layouts.js` renderer (read-only, flip pages).
- v1 controls: 「換風格」 (magazine / story / uniform / byRating / random),
  「調整照片」 (grid: tap to exclude/include, drag or ↑↓ to reorder; re-run
  layout), a note, and **「請攝影師手動排版」** (sends `mode: 'photographer'`,
  keys in order, no pages).
- Naming: 「自動編排」 and 「請攝影師排版」. **Not 「AI 編排」**: the engine is
  rule-based (orientation, rating, order, random); real AI is parked in THE
  ORDER. Phone manual layout (drag photos between slots, crop) is a later step
  that reuses `book_editor`'s slot model once the album chain (THE ORDER #3)
  is integrated.
- Coupling to fix: `auto_layout.js` calls the global `driveManager.getImageUrl`
  and reads global `LAYOUTS` (and `_randomLayout` includes custom layouts).
  Give `run()` an image-URL function and use built-in layouts only; do not load
  `book_editor.js` on the guest page.

**Layout JSON** (Worker's own serialisation): `{v: 1, mode: 'auto' |
'photographer', style, pages: [{layout, slots: [photo_key | null]}]}`. Checked:
`layout` ∈ a built-in id list mirrored in the Worker (full-bleed, 1-up, 2-up-h,
2-up-v, 3-up, 4-grid) with its slot count; ≤ 200 pages; every key ∈ the line's
`photo_keys` and each at most once; every line key placed (auto mode); crop,
bg and page ids dropped (defaults on import). `photographer` mode: `pages: []`.
A test reads `layouts.js` and fails when the two lists drift.

## Photographer UI

- **Settings → 商品**: per product 「顯示給客人」 switch (`guest_visible`, via
  existing PUT). New 「交件優惠」 card: % and days, and a live calculator per
  guest-visible option:
  | 規格 | 售價 | 優惠價 | 平台價 | 你的收入 |
  where 你的收入 = 優惠價 − 平台價; a clamped option shows 「低於平台價，以
  NT$平台價 出售」 in warning colour. A greyed column 「平台服務費（尚未收取）」
  shows the future fee `min(round((售價 − 平台價) × 15%), max(0, 優惠價 − 平台價))`
  and 收入 after it, so the photographer sees that their own discount comes out
  of their share. It stays hidden until the fee is switched on (keep the formula
  in one shared helper).
- **Settings → 收款**: 匯款資訊 text; 提供宅配 switch.
- **Project detail**: 優惠 override (沿用預設 / 自訂 % 與天數 / 不提供), 線上訂購
  on/off; delivered projects show the promo end date.
- **Orders page**: 待確認 filter (exists) is the default view when any exist;
  requested rows get **「確認訂單」** (one tap, then the normal flow) and 「取消」.
  Contact card on guest orders: name, method + value (tap to copy), delivery,
  address; 「清除聯絡資料」 with confirm. Album lines: photo count, style, or
  「請攝影師排版」; S3 adds a read-only preview.
- **Badge**: `todo.requested_orders` on the dashboard to-do list
  (「N 筆客人訂單待確認」 → `orders.html?status=requested`) and a count on 訂單
  in `js/side-nav.js`.

## Email

`sendOrderNotification(env, project, order)`, separate from the pick mail,
same transport rules (skip when `NOTIFY_EMAIL`/`PHOTOGRAPHER_EMAIL` unset; free
plan: only to the verified `PHOTOGRAPHER_EMAIL`). Subject
`[新訂單] <project> — <name> NT$<total>` (one line). Body: project, name,
lines (name, option, qty, price, 優惠 x%), total, delivery method, guest note,
link `https://imhoti.tw/studio/orders.html?status=requested`. **No contact
value or address in the mail** (keeps personal data out of the inbox; it is in
the orders page). Throttle: one mail per project per 10 min via
`projects.last_order_notified_at` (same conditional-UPDATE slot pattern as
submit); a mail lists every `requested` order with `notified = 0`, then marks
them. Throttled or failed orders show in the badge anyway, so nothing is lost.
`ctx.waitUntil`; mail failure never fails the order.

## PDPA (個資法)

- **Controller** is the photographer (studio); the platform processes on their
  behalf. The notice names the studio (`studio_name`).
- **Minimum fields**: name + one contact; address only for 宅配. No ID number,
  no birthday, no IP stored.
- **告知 (Art. 8)** at the form, short, linking to `privacy.html`: who
  collects, purpose (訂單處理、聯絡、出貨), data (姓名、聯絡方式、地址), period
  (below), recipients (攝影師; 印製/物流廠商 only as needed for shipping),
  rights (查詢、閱覽、複製、更正、停止、刪除), and that without it the order
  cannot be processed. `privacy.html` and terms are still to be written (Tim,
  legal check).
- **Visibility**: contact data only in admin routes. Guest routes return an
  order only to its key; a viewer's `/api/pick/state` never mentions orders.
- **Retention**: recommended — `contact_value` and `ship_address` cleared
  automatically 180 days after `fulfilled_at`/`cancelled_at` (lazy UPDATE in
  the admin order routes; a Cron Trigger later), name kept with the order for
  the books. Manual 「清除聯絡資料」 for deletion requests.
- **Export/access on request**: the guest sees their own data on the receipt;
  otherwise the photographer copies it from the order (no export route in v1).

## Abuse and security (S2/S3 security review must cover)

Controls: link revoke (exists) and per-project `shop_enabled`; ≤ 5 open
`requested` orders per project (409 `too_many_open_orders`); ≤ 10 orders per
project per 24 h and ≤ 3 per order key per hour (D1 counts, authoritative);
per-IP limit with the Workers rate-limiting binding if available on the plan
(to verify; IP not stored); honeypot; limits above; nothing counts until the
photographer confirms.

Attack cases:
1. **Price tampering**: `unit_price`, `list_price`, `promo_percent`, `cost`,
   `kind`, `name` in a body are ignored; guest lines never take the admin
   `unit_price` override path.
2. **Promo window**: client clock or a sent `promo_percent`/`now` has no effect;
   window from `delivered_at` + days on the server; undeliver removes the promo
   (and the shop); a deliver repeat keeps the first `delivered_at`.
3. **Floor**: promo never under `platform_price`; a platform price raised since
   the page loaded → `price_changed`.
4. **Other guests' orders**: GET/cancel with no key, wrong key, another
   project's key, another order's id → empty/404; the key is compared by hash
   **and** `project_id`.
5. **Photo keys outside finals**: proofs (switch on or off), `_thumbs/`, `_books/`,
   other projects' folders, `..`, trailing `/`, control chars → 400.
6. **Hidden products**: `guest_visible = 0`, retired, platform-retired,
   services, another photographer's option → `product_not_offered` /
   `unknown_option`.
7. **Oversize layout**: > 64 KB, > 200 pages, unknown layout id, wrong slot
   count, keys not on the line, duplicates, non-string keys, extra fields.
8. **Spam/DoS**: caps above, body cap before `JSON.parse` (`readJsonCapped`),
   mail throttle, no email address taken from the guest (no relay).
9. **Injection**: every guest string escaped in admin pages and the email;
   subject one line.
10. **Leaks**: guest responses built from a named field list; `o.*` must not reach
    guest routes; `guest_key_hash` never in any response.
11. **State**: archived / revoked mid-request → 401; cancel races confirm (one
    conditional UPDATE on `status = 'requested'`); admin confirm of an order the
    guest just cancelled → 409.

## Interplay with existing code

- `orderLines(env, project, input, existing)` checks keys against
  `project.folders` (proofs). **Finals fail it today** — also for admin orders,
  so a photographer cannot attach a final photo to a print line now (found while
  designing). Give it a scope argument: admin = proofs ∪ finals, guest = finals
  only; plus a `guest` flag for the stricter print rule, visibility and promo.
- `insertItem` gains `list_price`, `promo_percent`, `layout`, with a
  missing-column fallback until the migration runs.
- `readOrders` selects `o.*`: after S2 that carries `guest_key_hash` and contact
  into every admin response. Select named columns (as items already do).
- Floor rule, `ORDER_ARROWS`, outstanding/revenue SQL, extra-pick order: unchanged.
- Delivery `PATCH` strict key check: extend the allowed set, keep rejecting others.

## Regression risks

Admin order create/PUT after the `orderLines` change (scope, keys); the
extra-pick batch (shares `insertItem`); stats query with the new todo count;
settings PUT column list; `/api/pick/state` unchanged for picking mode; guest
page bar layout (shared with the in-flight guest pick page UI work); the
browser suites that stub `/api/admin/orders` must mirror the new fields
(fakes mirror real responses).

## Migrations

1. `2026-10-xx-guest-shop-s1.sql` — 5 ALTERs (studio/project promo, shop switch).
2. `2026-10-xx-guest-shop-s2.sql` — 13 ALTERs + index (contact, key, list price,
   transfer, ship, mail slot).
3. `2026-10-xx-guest-shop-s3.sql` — `order_items.layout`.
Tim runs each in the D1 Console before its merge.

## Tests and tiers

- **S1 worker (High)**: shop route per mode/phase/switch/revoke; no
  `cost|platform_price|vendor_cost` keys anywhere in the response (assert the
  positive: `price` present); promo edges (day N−1 vs N, 0%, 50%, clamp,
  project override null/0); settings validation. ~10 mutants.
- **S2 worker (High + security review)**: every attack case above as a test;
  order-key isolation with two keys; caps; honeypot; `price_changed`; mail slot
  race and failure release; erase-contact; admin reads carry no `guest_key_hash`.
  ~10 mutants on pricing, key compare, finals scope, caps.
- **S3 worker (High)**: layout validator table-driven; parity test against
  `layouts.js`.
- **UI (Normal)**: browser suites for 購買資訊 (element present and visible,
  absent when empty — remove from DOM), cart/form/receipt, settings calculator
  numbers, orders confirm button. ~5 mutants. Real phone check: LINE in-app
  browser form, countdown, photo picking, album preview speed with 200+ finals.

## Work packages

| WP | Stage | Who | Size | Files / contention |
|---|---|---|---|---|
| 1 | S1 worker: shop route, promo helper, settings/PATCH fields | opus | 1 d | `worker/worker.js`, tests |
| 2 | S1 settings: guest switch, promo card + calculator | sonnet | 0.5–1 d | `settings.html`, `admin.html` (project override) |
| 3 | S1 guest 購買資訊 | sonnet | 0.5–1 d | `index.html`, `js/pick.js` — **after** the guest pick page UI work lands |
| 4 | S2 worker: orders, key, contact, caps, mail, erase, stats, `orderLines` scope, `readOrders` columns | opus + security review | 2 d | `worker/worker.js` (serial with WP1/7) |
| 5 | S2 guest cart/form/receipt, `privacy.html` shell | sonnet | 1.5 d | `index.html`, `js/pick.js` (serial with WP3/8) |
| 6 | S2 admin: confirm, contact card, erase, badges, transfer/ship settings | sonnet | 1 d | `orders.html`, `js/orders-common.js`, `dashboard.html`, `js/side-nav.js`, `settings.html`, `admin.html` |
| 7 | S3 worker: layout validator + parity test | opus | 0.5–1 d | `worker/worker.js` |
| 8 | S3 guest album preview/editor; decouple `auto_layout.js` | sonnet | 2 d | `js/pick.js`, `book_editor/js/auto_layout.js` (book editor suites must stay green) |
| 9 | S3 admin read-only layout preview | sonnet | 0.5 d | `admin.html`, `orders.html` |

Worker packages are serial (one file). Bump `?v=` on every frontend change.
`privacy.html` text: Tim.

## Open questions for Tim

1. Transfer details: show right after ordering, or only after you confirm
   (recommended)?
2. Promo per-project override: confirm. Also: 取消交件 then 再交件 restarts the
   30 days — OK?
3. Delivery: 面交 / 宅配 both? Shipping fee included in the product price, or
   added when you confirm (needs a way to add a fee line while custom products
   are off)?
4. Shop only after delivery (recommended), or also while picking?
5. Retention: clear phone/address 180 days after an order is done (name kept)?
   Who writes `privacy.html` / terms and checks them legally?
6. Album: must the guest's photo count match the platform album's page/photo
   count (`photo_count`), or stay advisory as today?

## Tim's answers (2026-09-30, round 2 — these supersede the recommendations above)

1. **Transfer details are shown after the photographer confirms** the order.
2. **Promo can be set per project.** More generally there is a studio-level
   set of *project defaults*, and every project can edit its own copy — see
   `docs/project-plan.md` (pick limit, extra price, extra-pick cap, promo,
   shipping fee). *Cancel delivery → deliver again* restarts the promo window
   (today `undeliver` clears `delivered_at`). Tim's view: that looks like a way
   round the rule, but it should be deliberate — **listed for a later
   discussion, not decided.** Until then the behaviour stays as built.
3. **There must be a shipping fee.** Because custom products are off and
   `order_items.kind` has a CHECK that cannot change without a table rebuild,
   shipping is **not** a product line: `orders` gains `delivery_method`
   (`pickup` | `ship`) and `shipping_fee` (integer NT$, snapshot). Total =
   subtotal − discount + shipping_fee. The studio default fee lives in
   settings (project default, editable per project); `pickup` is free; the
   photographer can adjust the fee on the order when confirming. The guest sees
   the fee before submitting and it is inside `expected_total`. The totals SQL
   (`ORDER_TOTAL_SQL`, outstanding, revenue) and the platform-fee rule (shipping
   is not margin) must account for it.
4. **Shop only after delivery.**
5. **Privacy / terms: find someone to review later.** Retention (180 days) and
   the notice wording stay a *reference proposal* until reviewed.
6. **Album photo count stays advisory.** Reference only, to be discussed later.

Guest-shop stages are unchanged; S1 (info + promo) can start once the project
defaults exist, because the promo settings live there.

## S1 trimmed — built (Worker, 2026-10-05)

Tim cut S1 down to the read: **no promo, no countdown, no `ship_enabled`, no
`shop_enabled`** (none of those columns exist yet; the S1 migration above is
not needed for this). What the Worker serves:

`GET /api/pick/shop` — pick link only (`?t=` or `X-Share-Token`, through
`resolvePick`), owner and viewers alike (information only). Order of checks:

| Case | Answer |
|---|---|
| no / unknown / revoked / expired link, archived project, any non-pick token (client, studio, session, admin, operator), a picker key alone | 401 `{error}` |
| any method but GET | 405 `{error}`, `Allow: GET` |
| not delivered now (`pickReadScope(share).mode !== 'delivered'`: picking, retouching before delivery, undelivered, reopened) | 409 `{error: '尚未交件', code: 'not_delivered'}` |
| catalogue tables missing (migration not run) | 500 `{error, code: 'shop_unavailable'}` |
| delivered | 200 `{products: [...]}` (may be `[]`) |

All answers but the 401 carry `Cache-Control: private, no-store` and
`Vary: X-Share-Token`. The route writes nothing (not even the link's
last-seen stamp).

```
{ "products": [ {
    "id": "<products.id>",            // the photographer's product
    "kind": "print" | "album",
    "name": "相本書",                  // plain text, ≤ 60 — render as text
    "description": "精裝 20×20",       // plain text, ≤ 500, '' when none
    "photo_count": 20 | null,         // album only, advisory
    "min_pages": 10 | null,           // album only: fewest inside spreads (1 spread = 1 P, cover/back not counted)
    "image_url": "/api/platform/products/<id>/image?v=<stamp>" | null,  // relative to the Worker origin, public
    "options": [ { "id": "<product_options.id>", "label": "20×20", "price": 5000 } ]  // label '' when single
} ] }
```

- **Which products:** the products of the photographer who owns the link's
  project (`projects.photographer_id`, never anything from the request),
  adopted from the platform (custom products and services never appear),
  `guest_visible = 1`, product and platform product active, kind print/album.
- **Which options:** active, its platform option active and belonging to the
  same platform product, and `price ≥` today's `platform_price` — exactly what
  an order would accept (`orderLines` refuses a price under the floor with
  `below_platform_price`, so such an option is hidden until the photographer
  reprices it). A product with no such option is left out.
- **price** = the photographer's option price = the `unit_price` an order on
  that option is created with. Never `cost`, `platform_price`, `vendor_cost`,
  `platform_option_id`, `guest_visible`, `photographer_id`; the platform
  product id appears only inside `image_url`.
- **Sorted** by the photographer's `sort` (then created), options in their
  set order. **Capped** at 50 products (sellable ones, by sort) × 20 options.
- Before the `min_pages` migration everything works with `min_pages: null`.
