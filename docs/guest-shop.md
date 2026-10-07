# Guest shop (Phase B) — design (2026-09-30, for review)

> **狀態（2026-10-08）**：S1（只讀的 `GET /api/pick/shop`）與「我有興趣」已建好。
> **S2 已重寫**，以文末 **「S2 客人自助訂購 — 設計稿（2026-10-08 改版）」** 為準；
> 下面 2026-09-30 的 S2 內容（Decisions 的 S2 部分、Data model 的 s2 migration、API 的 S2 列、
> Guest UI S2、Photographer UI、Email、Abuse、Migrations、Tests、Work packages）
> 只留作歷史，各段開頭有「已被取代」標記。例外：**PDPA** 仍是參考底稿（等審閱），
> **Interplay** 的四點重讀程式後仍然成立；這兩段開頭各有說明。Tim 的回答（兩輪）一字未刪。

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

> 已被取代（S2 部分）：「任何連結持有人都能下單 + order key」改為**只限座位持有人、只在完成頁**；
> 促銷（promo）不在 S2；運費改為訂單欄位。見文末 S2 改版 §1–§4。

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

`…-guest-shop-s2.sql` (before S2's merge) — **已被取代**，以文末 S2 改版 §4 的 SQL 為準：

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

> 已被取代（S2 列、POST body、Guest order view、Limits、Admin 表）：以文末 S2 改版 §5 為準。
> S1 的 `GET /api/pick/shop` 以「S1 trimmed — built」為準。

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

**S2 — ordering**（已被取代：入口在完成頁、不是交件畫廊；見文末 S2 改版 §6、§9）
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

> 已被取代：促銷卡片不在 S2；S2 的攝影師端見文末 S2 改版 §9 WP4。

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

> 已被取代：不做 10 分鐘節流 / `notified` 欄位，改為每筆一封、由上限約束（同要求修改信）。見文末 S2 改版 §5.6。

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

> 仍是**參考方案**（Tim 回答 5：要找人審）。S2 改版 §4.3、§6 的開關以此為底稿。

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

> 已被取代：以文末 S2 改版 §7 的測試案例為準（order key 案例改為座位 key）。

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

> 2026-10-08 重讀程式：下面四點**仍然成立**（`orderLines` 只認毛片、`readOrders` 用 `o.*`）。
> S2 改版 §3.5、§4 接手處理。

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

> 已被取代：S1 migration 沒有做（S1 trimmed）；S2 見文末 S2 改版 §4.1。

1. `2026-10-xx-guest-shop-s1.sql` — 5 ALTERs (studio/project promo, shop switch).
2. `2026-10-xx-guest-shop-s2.sql` — 13 ALTERs + index (contact, key, list price,
   transfer, ship, mail slot).
3. `2026-10-xx-guest-shop-s3.sql` — `order_items.layout`.
Tim runs each in the D1 Console before its merge.

## Tests and tiers

> 已被取代（S2）：見文末 S2 改版 §8。

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

> 已被取代（WP4–WP6）：見文末 S2 改版 §9。

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

> 已回答（下一節）。S2 的新問題見文末 S2 改版 §11。

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
    "max_pages": 30 | null,           // album only: most inside spreads, same unit, >= min_pages
    "bleed_mm": 3 | 2.5 | null,       // prints and albums: mm of bleed on each side, 0–10; null = 0 mm
    "extra_page_price": 150 | null,   // album only: NT$ per spread above min_pages (option price covers up to min_pages); null = not priced
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
- Before the `min_pages` / `max_pages` / `bleed_mm` / `extra_page_price`
  migrations everything works with that field `null` (each column on its own).
- `extra_page_price` is a customer-facing price (the operator's number, as
  is); still no cost field of any kind in the shop.

## Album page range — where the refusal lives (S3, not built yet)

> 2026-10-08：S2 改版建議**提早在 S2 接上**兩個 helper：S2 的相本行沒有 layout，但客人選一個
> 跨頁數 `spreads`（§3.3，待 Tim 答 §11 Q10）。下面「S3 用 `layout.pages.length`」的規則到 S3 仍然適用。

Tim (2026-10-05): an album outside its platform product's page range is
**refused**, never charged per extra spread. (2026-10-07: inside the range, spreads
above `min_pages` may cost `extra_page_price` each — see below.) The range is
`platform_products.min_pages` / `max_pages` (`docs/products-orders.md`),
inside spreads, both nullable.

Nothing refuses anything today, on purpose: admin orders carry no layout and
guest ordering (S2/S3) does not exist, so there is no page count to judge. Do
not add a check to the admin order routes.

When S3 builds `POST /api/pick/orders` with an album `layout`:

- For each album line in `mode: 'auto'`, spreads = `layout.pages.length`
  (one layout page = one spread = 1 P; cover and back are not layout pages).
- Read the line's platform product live (`pp.kind`, `pp.min_pages`,
  `pp.max_pages`) the way every read here does:
  `withPageColumns(env, cols => …${pageSelect(cols)}…)` — one query on a
  migrated database, a probe only after a missing-column failure, and a
  missing column reads as no bound, never an error. Then call
  `albumPagesProblem(spreads, product)` (`worker.js`, pure, unit-tested in
  `worker/test/product-max-pages.test.mjs`). It returns `null` (fits, or not
  an album), `'pages_below_min'`, `'pages_above_max'` or `'invalid_layout'`
  (spreads not a whole number ≥ 0). Any non-null → 400 `{error, code}` with
  that code, nothing written — together with the other S3 layout checks,
  before the order insert.
- `mode: 'photographer'` (請攝影師排版, `pages: []`) has no page count: skip
  the check; the photographer lays it out within the range.
- The guest page uses `min_pages` / `max_pages` from `GET /api/pick/shop` to
  guide the layout, but the Worker's check is the only one that counts.
- Extra spreads: once the line fits, `albumExtraPagesCost(product, spreads)`
  (`worker.js`, pure, reads `pp.extra_page_price` / `min_pages` / `max_pages`
  live) gives `{extraPages, cost}`; add `cost` to the line server-side (never
  a price from the request). `null` = extra pages not priced or not
  computable: then an album with spreads above `min_pages` must not be sold
  at the bare option price by accident — S3 decides (refuse, or treat as
  photographer-priced). Not wired anywhere yet.
- New error codes for the S2 list: `pages_below_min`, `pages_above_max`.
- The test `albumPagesProblem is not wired to any route yet` fails once the
  helper is called; update it then.

## Product interest 「我有興趣」 — Worker (2026-10-08)

Tim decided: on the 完成頁 (delivered **and** client-confirmed) the client taps
「我有興趣」 on a shop product card. The photographer gets one email and the
project keeps a record. A demand test, **not an order**: no payment, no order
row, not a CRM.

**Migration** (Tim runs it in the D1 Console before the merge):
`worker/migrations/2026-10-08-product-interests.sql`, one
`CREATE TABLE IF NOT EXISTS product_interests (...)`, re-runnable. Until it
has run the route answers 500 `interest_unavailable` and the admin detail says
`interests: []`.

**`POST /api/pick/interest`** body `{product_id}` (pick link, `X-Picker-Key`).
Checks, in order:

| Status | code | when |
|---|---|---|
| 401 | — | dead link (unknown, expired, revoked, archived project) |
| 405 | — | not POST (`Allow: POST`), viewers too |
| 403 | `not_owner` | no key / wrong key / key from before a seat reset |
| 409 | `not_confirmed` | not delivered, or delivered but not confirmed (picking, retouching, undelivered, reopened) — before the body is read |
| 413 | `too_large` | body over 1 KB |
| 400 | `Invalid JSON` (error) / `invalid_body` | not JSON / `product_id` not a 1–200 char string |
| 404 | `not_found` | not one of the products `readGuestShop` returns for the project's photographer right now (hidden, inactive, another photographer's, unknown) |
| 500 | `shop_unavailable` / `interest_unavailable` | catalogue tables / this migration missing |
| 409 | `interest_cap` (`max: 20`) | a 21st distinct product on this project (a product already there always counts) |
| 200 | — | `{ok: true, already: boolean}` — `already` = this project had tapped this product before |

Every answer carries `Cache-Control: private, no-store`.

**The write** is one statement: `INSERT … SELECT … WHERE <seat, not archived,
phase retouching, delivered_at, final_folders, client_confirmed_at all set>
AND <under the cap or already there> ON CONFLICT(project_id, product_id) DO
UPDATE SET tap_count + 1, last_at, name/kind re-snapshotted, last_emailed_at
moved only when NULL or ≥ 24 h old RETURNING tap_count, mail`. So an undeliver,
reopen, seat reset or archive landing after the checks makes it a no-op (then
re-read: 401 / 403 / 409 `not_confirmed` / 409 `interest_cap`), and of two
racing taps one emails. The name and kind come from our catalogue
(`readGuestShop`), never from the request.

**Email** (same `NOTIFY_EMAIL` / `PHOTOGRAPHER_EMAIL` / `NOTIFY_FROM` binding as
the other notifications): on the first tap, and again only when the last email
about that product is 24 h old. Subject `[有興趣] <title> — <picker>：<product>`,
everything through `oneLine` (control and bidi characters → spaces), HTML
escaped, link `https://imhoti.tw/studio/admin.html#project=<id>`. Sent in the
background after the write (`ctx.waitUntil`): a failed or missing mailer never
fails the tap and never undoes it. The slot is taken before the send, so a
failed send is retried only by a tap 24 h later (the record is in the admin
anyway). Residual: two taps on an old row inside the same millisecond after
24 h could both email.

**Admin**: `GET /api/admin/projects/:id` has `interests: [{product_id,
product_name, product_kind, first_at, last_at, tap_count}]`, newest tap first
(`last_at DESC`), `[]` when none or before the migration. No guest route
(`/api/pick/state`, `/shop`, `/rounds`, `?list=`) carries it.

Deliver / undeliver / reopen do not touch `product_interests`: the record stays
as history; a new tap needs the project confirmed again.

---

# S2 客人自助訂購 — 設計稿（2026-10-08 改版）

狀態：**設計稿，未實作**。取代上面 2026-09-30 的 S2 內容。基準：`17eee37`（S1 trimmed、「我有興趣」已在程式裡）。
相關：`docs/products-orders.md`（訂單、狀態、平台價、`min_pages`/`max_pages`/`extra_page_price`）、
`docs/delivery.md`（交件、客戶確認、完成頁）、`docs/project-plan.md`（專案預設值：運費）、
`docs/backlog.md`（THE ORDER、Parked）、`CLAUDE.md`（不變量、不做清單、風險分級）。
Tim 的決定（2026-10-07/08）：客人自己下單（「全自動」的第一步只做 S2）；轉帳資訊在攝影師確認後才顯示（回答 1）；
整個 S2 **暗中上線**，個資告知與保存期限有人審過（回答 5）之前，客人只看到「我有興趣」。

## 1. 目標與不做的事

客人在**完成頁**（已交件且已確認完成，`mode === 'delivered'` 且 `confirmed_at` 有值）上，
由**座位持有人**選商品線（相本書 / 無框畫 / 其他輸出）、規格與數量，填聯絡方式與取貨方式（面交 / 宅配，宅配帶運費快照），
送出後訂單以 `requested`、`source 'guest'` 進到攝影師的訂單列表，攝影師收到一封信，**一鍵確認**；
確認後客人的收據才顯示轉帳資訊。攝影師照舊在後台記錄收款（`POST /api/admin/orders/:id/payment`，`paid_method: 'transfer'`）。

不做（實作時不要偷偷加）：

- **線上付款**（Parked）、電子發票、平台抽成（15% 規則已定但不收，`docs/backlog.md` THE ORDER 第 6 步再決定）。
- **自動確認**：第一版每筆都要攝影師按確認。日後可加開關，不在 S2。
- **相本自動排版給客人調整**（= S3）。S2 的相本行 = 全部精修、「請攝影師排版」。
- **交件畫廊 / 挑片中下單**：只在完成頁。未確認的驗收頁不賣東西（客人還在要求修改）。
- **觀看者下單**：只有座位持有人（同「我有興趣」、確認完成、要求修改）。
- **庫存**：平台商品是接單印製，沒有庫存概念；只有防濫用上限。
- **促銷 / 倒數**（S1 trimmed 已拿掉）、`shop_enabled` 每專案開關（S2 用全域暗開關，§6）。
- **寄信給客人**：免費方案的 Email Service 只能寄到驗證過的地址（`wrangler.toml` 註解），寄不到客人信箱（§11 Q14）。
- **改 deliver / undeliver / reopen / confirm 的批次**：訂單不跟著交件狀態自動變（§3.4）。

## 2. 現況 vs S2 要加的

| 項目 | 現況（17eee37，程式為準） | S2 加什麼 |
|---|---|---|
| 商品目錄給客人看 | `GET /api/pick/shop`（`readGuestShop`）：交件模式、owner 與觀看者都可讀；只回 `guest_visible`、平台商品、價格 ≥ 平台價的規格 | 回應加 `ordering`（開關與運費資訊，§5.2）；其他不變 |
| 「我有興趣」 | `POST /api/pick/interest`、表 `product_interests`；完成頁、座位持有人；每產品一列、24h 一封信、上限 20 產品 | 開關開時前端把按鈕換成「訂購」；路由保留（快取舊頁）；資料列留作歷史（§6） |
| 訂單表 | `orders` / `order_items` 已有 `source 'guest'`、`status 'requested'`、`picker_id`、`guest_note` 欄位，但**沒有任何路由寫入 guest 訂單** | 客人建立、讀、取消三條路由；聯絡/取貨/運費/同意欄位（§4） |
| 狀態箭頭 | `ORDER_ARROWS.requested = ['confirmed','cancelled']`；`ORDER_OUTSTANDING_SQL` 不算 `requested` | 不變；客人只能 `requested → cancelled`（§3） |
| 金額 | `ORDER_TOTAL_SQL = MAX(0, Σ unit_price×qty − discount)`，讀取時計算，不存 | 加運費：`MAX(0, 小計 − discount) + shipping_fee`（§3.5；或改用運費行，§11 Q2） |
| 訂單行驗證 | `orderLines` 照片只認 `project.folders`（**毛片**）；精修 key 一律 `photo_not_in_project`（連 admin 也一樣） | 加 scope 參數：客人 = 只認精修（`pickReadScope(s).finals`）；admin = 毛片 ∪ 精修（§11 Q17） |
| 相本頁數 | `albumPagesProblem` / `albumExtraPagesCost` 是純函式，**沒接任何路由**（有測試釘住「未接」） | S2 用客人選的 `spreads` 接上（§3.3，待 Q10） |
| 攝影師後台 | `orders.html` 已有「待確認」篩選；`js/orders-common.js` 對 `requested` 已有「確認 / 取消訂單」按鈕；admin.html 專案訂單區已顯示 `guest_note` | 聯絡卡片、清除個資、運費顯示與修改、徽章、設定頁（轉帳資訊、運費預設、宅配開關） |
| 個資 | 沒有隱私頁（`privacy.html` 不存在），沒有任何客人聯絡欄位 | 告知文字 + 同意版本、最少欄位、手動清除；**開關在審過前不開** |
| 匯出 | `docs/products-orders.md` 列了 `GET /api/admin/orders/:id/export.csv`，**程式裡沒有** | S2 不做；若做，走 `csvCell`（§7 #14） |

## 3. 狀態機

### 3.1 客人訂單的狀態

```
           客人送出（完成頁、座位持有人、開關開）
                    │
                    ▼
              requested ──攝影師「確認訂單」──▶ confirmed ──攝影師「已完成」──▶ fulfilled
                │   │                            │    ▲                         │
   客人「取消」─┘   └─攝影師「取消」              │    └──攝影師「改回」(既有)──┘
                │                                 │
                ▼                                 ▼
            cancelled ◀───────攝影師「取消」──────┴───────────────(fulfilled 也可取消，既有)
```

- 箭頭全部沿用 `ORDER_ARROWS`，**不改**。新增的只有「客人取消」這一條，它只走 `requested → cancelled`。
- 客人可取消：**只在 `requested`**（§11 Q5）。確認後只有攝影師能改（`docs/products-orders.md` 既有規則）。
- 付款與狀態無關（既有）：確認後可以未付、部分付、已付。`requested` 不欠錢（`ORDER_OUTSTANDING_SQL` 已排除）。
- 攝影師確認仍走 `POST /api/admin/orders/:id/status {status:'confirmed'}`。`confirmed_at` 保留第一次（既有 COALESCE）。
- 轉帳資訊（`studio_settings.transfer_info`）只在 `status IN ('confirmed','fulfilled')` 時出現在客人收據（Tim 回答 1）；
  `requested` 顯示「攝影師確認後會顯示匯款資訊」；`cancelled` 不顯示。
- 客人的收據狀態字：`requested` 待攝影師確認｜`confirmed` 已確認，請匯款（已付則「已收款」）｜`fulfilled` 已完成｜`cancelled` 已取消。
  「已收款」= `paid_amount >= total`（只回布林，不回金額明細以外的東西）。

### 3.2 攝影師可做的事（全部是既有路由，S2 只加欄位）

| 動作 | 路由 | S2 的變化 |
|---|---|---|
| 確認 | `POST …/status` | 無；UI 確認前顯示聯絡卡片與運費 |
| 調整運費 | `PUT /api/admin/orders/:id` | 加 `shipping_fee`（`isMoney`），未取消時可改；`below_paid` 要把運費算進去 |
| 改價 / 改行 / 折扣 | `PUT /api/admin/orders/:id` | 既有（平台價下限照舊；`source` 保持 `'guest'`，`takeOver` 只把 `system` 變 `admin`） |
| 記錄收款 | `POST …/payment` | 無；`overpaid` 用 `order.total`（已含運費，因為來自 SQL） |
| 取消 | `POST …/status` | 無；與客人取消競態見 §7 #15 |
| 清除聯絡資料 | 新 `POST /api/admin/orders/:id/erase-contact` | §5.4 |

### 3.3 商品線與金額

**所有金額都由 Worker 從目錄算**，body 只有 `option_id`、數量、照片 key、跨頁數。客人送 `expected_total`
（頁面算的總額），Worker 算出的總額不同 → 409 `price_changed` 附新報價、什麼都不寫（保護客人，不保護攝影師）。

| 線 | 一行的形狀 | 驗證 | 單價 |
|---|---|---|---|
| 無框畫 / 其他輸出（`kind 'print'`） | `{option_id, qty, photo_key}`：**一張照片一行**，`qty` = 同一張印幾份 | `photo_key` 在**目前精修**內（`pickKeyAllowed({folders: scope.finals}, key)`，毛片不算，即使開了原檔下載）、`pickKeyValid`、R2 `head` 存在（≤ 20 次）；同一 key 同一規格只能一行 | `unit_price` = 規格價；`list_price` = 規格價 |
| 相本書（`kind 'album'`） | `{option_id, qty, spreads}`：`qty` 1–3 本 | `photo_keys` 存 `[]`（= 全部精修，攝影師排版）；`spreads` 見下 | `unit_price` = 規格價 + 加頁費；`list_price` = 規格價 |

相本跨頁數（建議 Q10-A）：

- 客人選 `spreads`（整數），頁面預設 `min_pages`。Worker 讀該行平台商品的 `kind/min_pages/max_pages/extra_page_price`
  （`withPageColumns` + `pageSelect`，同 `readGuestShop`），呼叫 `albumPagesProblem(spreads, product)`：
  `pages_below_min` / `pages_above_max` / `invalid_layout` → 400，什麼都不寫。
- 合範圍後 `albumExtraPagesCost(product, spreads)`：回 `{extraPages, cost}` → `unit_price = option.price + cost`
  （每本一樣，所以 `ORDER_SUBTOTAL_SQL` 的 `unit_price × qty` 不用改）。回 `null` 且 `spreads > min_pages`（沒定加頁價）
  → 400 `extra_pages_unpriced`（不可以用基本價偷賣多的頁）；`spreads ≤ min_pages` 或沒有 `min_pages` → 加頁費 0。
- `min_pages` 是 NULL 時 `albumExtraPagesCost` 把每一頁都當加頁（`min || 0`）：沒定 `min_pages` 又定了 `extra_page_price`
  的相本，`spreads=10` 會多收 10 頁。**這是 helper 現有行為**；S2 建議：`min_pages` NULL 時只接受 `spreads` 省略（視為攝影師決定、加頁費 0），見 Q10。
- `unit_cost` = 今天的平台價（既有 `orderLines`）；**加頁沒有對應的成本欄位**（`extra_page_price` 是給客人看的價），
  所以加頁費全部進攝影師的毛利。這是目錄缺的一塊，不在 S2 決定（§11 Q12）。
- `layout` 欄位（S3 本來就要加）在 S2 存 `{"v":1,"mode":"photographer","source":"all_finals","spreads":N}`；
  不存 `final_folders`（攝影師從專案看得到交件資料夾）。S3 再加 `pages`。
- `photo_count` 仍是參考（Tim 回答 6）。

解析度（無框畫）：精修縮圖最大 1600 px（`THUMB_BUCKETS = [400,1200,1600]`），客人頁面拿不到原檔尺寸；上傳時也沒把寬高存進 R2 metadata
（`upload.html` 在瀏覽器裡有 `bitmap.width/height`，但只拿來做縮圖）。所以 **S2 不做自動解析度檢查**，
由攝影師在確認與印前檢查（Tim：攝影師保留印前檢查、印刷檔由攝影師匯出）。可行的後續做法列在 §11 Q11。**標為未決。**

### 3.4 與交件狀態的互動（取消交件 / 退回挑片 / 更換精修 / 封存）

| 事件 | 開著的客人訂單（`requested` / `confirmed`） | 客人能做什麼 |
|---|---|---|
| 更換精修（重複交件） | 不動。確認被清掉（既有不變量）→ 完成頁消失 | 不能新下單（409 `not_confirmed`）；能讀、能取消自己的 `requested` |
| 取消交件 / 退回挑片 | 不動 | 同上 |
| 攝影師標記完成 / 客人再確認 | 不動 | 可再下單 |
| 封存專案 | 不動（admin 仍可讀、改，既有規則） | 全部 401（連結死） |
| 撤銷連結 / seat reset | 不動 | 401 / 舊 key 不再是 owner → 403，讀不到 |

建議（§11 Q13-A）：**訂單永遠不因交件狀態自動取消**；admin 訂單列在專案「目前未交件」時加一行提示（只是 UI）。
理由：自動取消要改 undeliver/reopen 批次（不變量核心），而且客人可能已經匯款。

印出的照片是**下單當下**的精修 key（快照）。更換精修後舊 key 可能已不在目前精修；攝影師以訂單上的 key 為準，
那份檔案仍在 R2（直到 180 天生命週期）。這是攝影師的事，客人收據只顯示檔名。

### 3.5 金額 SQL（運費，Tim 回答 3 的做法 A）

```
ORDER_SUBTOTAL_SQL  不變
ORDER_TOTAL_SQL     = MAX(0, <subtotal> − o.discount) + o.shipping_fee
ORDER_OUTSTANDING_SQL 不變（引用 TOTAL）
```

- 折扣只扣商品小計（`orderDiscount(discount, subtotal)` 不變），運費不能被折扣吃掉，也不能是負的。
- JS 的 `below_paid`（`subtotal - discount < paid_amount`，worker.js PUT 路由）要改成含運費；`overpaid` 用 SQL 的 `total`，自動含。
- 營收統計 `revenue[].paid` 是 `paid_amount`，會含運費；`cost` 只算行的 `unit_cost` → **毛利會多算運費**（運費其實付給物流）。
  S2 建議：統計加一欄 `shipping`（同月份、同條件的 `SUM(shipping_fee)`）讓儀表板扣掉；或接受。§11 Q2。
- 平台費規則（未收）：運費不是毛利，不計費（Tim 回答 3）。用 `list_price` 與行的平台價計，本來就不碰運費。
- **migration 沒跑時**：`o.shipping_fee` 不存在 → 所有訂單讀取與 stats 會 500。必須做降級：`orderMoneySql(cols)` 依探測結果產生
  有/無運費兩種 SQL（同 `withPageColumns` 的作法：先當作有，缺欄位才探測再跑一次）。四種狀態都要測。
  這是做法 A 的主要成本；做法 B（運費當一行 `service`）完全不用改金額 SQL（§11 Q2）。

## 4. 資料模型（append-only）

### 4.1 Migration

檔名 `worker/migrations/2026-10-xx-guest-orders.sql`，Tim 在 D1 Console **合併前**一句一句執行；`worker/schema.sql`
照慣例在各表加 `-- ALTER …` 註解與欄位。ALTER 重跑會報 duplicate column（= 已跑過，可忽略）。

```sql
-- orders：客人訂單才有值，admin / system 訂單全是 NULL / 預設
ALTER TABLE orders ADD COLUMN request_id TEXT;              -- 客人頁每次送出產生的 UUID（冪等）
ALTER TABLE orders ADD COLUMN contact_name TEXT;            -- 1–50 字
ALTER TABLE orders ADD COLUMN contact_phone TEXT;           -- 6–20，數字 + - 空白 ( )
ALTER TABLE orders ADD COLUMN contact_line TEXT;            -- LINE ID 1–50
ALTER TABLE orders ADD COLUMN delivery_method TEXT;         -- 'pickup' | 'ship'
ALTER TABLE orders ADD COLUMN ship_address TEXT;            -- 1–200，只在 'ship'
ALTER TABLE orders ADD COLUMN shipping_fee INTEGER NOT NULL DEFAULT 0;  -- NT$ 快照，攝影師可改（§11 Q2 若選 B 則不加）
ALTER TABLE orders ADD COLUMN consent_version TEXT;         -- 客人勾選的告知版本，例 'v1'
ALTER TABLE orders ADD COLUMN contact_erased_at TEXT;       -- 清除聯絡資料的時間
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_request ON orders(project_id, request_id);
-- order_items
ALTER TABLE order_items ADD COLUMN list_price INTEGER;      -- 建立時的目錄價（平台費的前提；admin 行也寫）
ALTER TABLE order_items ADD COLUMN layout TEXT;             -- 相本：S2 = {"v":1,"mode":"photographer","source":"all_finals","spreads":N}
-- 設定與專案預設（docs/project-plan.md 的「studio 預設 → 專案可改」）
ALTER TABLE studio_settings ADD COLUMN transfer_info TEXT;          -- ≤ 500，確認後給客人看
ALTER TABLE studio_settings ADD COLUMN ship_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE studio_settings ADD COLUMN default_shipping_fee INTEGER; -- NULL = 未設
ALTER TABLE projects ADD COLUMN shipping_fee INTEGER;               -- NULL = 用 studio 預設
```

- SQLite 的 UNIQUE 允許多個 NULL，所以 admin / system 訂單（`request_id` NULL）不受影響。
- 不加 `guest_key_hash`：建議以**座位**當收據身分（§11 Q8-A）。若 Tim 選 Q8-B（另發 order key），再加
  `ALTER TABLE orders ADD COLUMN guest_key_hash TEXT;` 與 `CREATE INDEX IF NOT EXISTS idx_orders_guest ON orders(project_id, guest_key_hash);`，
  key 由 Worker 產生、只回一次、存 SHA-256（同 `pickers.key_hash`），header `X-Order-Key`。
- 不加 `notified` / `last_order_notified_at`（不節流，§5.6）。不加促銷欄位。

### 4.2 客人身分與可見範圍

- 建立：`picker_id = 目前座位持有人`（`resolvePick` 的 `picker.id`，且 `isOwner`）。
- 讀 / 取消：`WHERE o.project_id = <連結的專案> AND o.picker_id = <目前 picker> AND o.source = 'guest'`，而且呼叫者必須 `isOwner`。
  seat reset 後新的座位持有人**看不到**前一位的訂單（裡面有前一位的電話地址）；舊 key 不再是 owner → 403。
- 觀看者：完成頁看得到商品（S1 既有），**沒有**訂購按鈕、讀不到任何訂單（403）。

### 4.3 個資（PDPA）欄位規則

- 最少欄位（建議 Q6-A）：姓名必填（預填座位的 `picker.name`）、電話與 LINE ID **至少一個**、地址只在宅配。不收 email、身分證、生日、IP。
- 所有字串：trim；拒絕控制字元與 bidi（同 `project_type` 的拒絕集合）；長度用 code point。
- `consent_version` 必須等於 Worker 常數 `ORDER_CONSENT_VERSION`（例 `'v1'`），否則 400 `consent_required`。告知文字改版 → 常數加一，舊頁送舊版本會被擋。
- 清除：`erase-contact` 把 `contact_phone`、`contact_line`、`ship_address` 設 NULL、蓋 `contact_erased_at`，**姓名保留**（帳務）。
  自動清除（建議完成 / 取消後 180 天）S2 不做，等 Tim 答 Q15 與審閱結果。
- 聯絡資料只出現在：admin 訂單讀取、客人**自己**的收據。不進 email、不進 `/api/pick/state`、不進 log。

### 4.4 與 `product_interests` 的關係

兩張表互不參照。「我有興趣」是需求測試，訂單是訂單：下單不寫、不刪、不改 interest 列；有 interest 列也不擋下單（§11 Q9）。
admin 專案頁兩者並列（「客人興趣」區塊保留）。開關開後新的 interest 列自然會變少——這本身就是 S2 是否有人用的對照數據。

## 5. API

### 5.1 共同規則

全部 `/api/pick/` 下，`resolveShareToken` + `resolvePick`（401），`SHARED_LINK_HEADERS`（`Cache-Control: private, no-store`、`Vary`）。
攝影師一律是 `project.photographer_id`（連結的專案），**不是** `DEFAULT_PHOTOGRAPHER_ID`、不是 request。
（現況：`readGuestShop` 用 `project.photographer_id`，`orderLines` 用 `DEFAULT_PHOTOGRAPHER_ID`；今天兩者都是 `'default'`，
客人路徑要統一用前者。）檢查順序固定：

**401 連結 → 405 方法 → 403 座位 → 403 開關 → 409 狀態（body 之前）→ 413/400 body → 500 migration → 400/404 目錄與照片 → 409 金額 → 200 重送 → 409 上限 → 寫入**；
寫入沒落地時重讀專案說明原因（同 `/api/pick/interest`）。

### 5.2 `GET /api/pick/shop`（改）

既有回應加一個 key，owner 與觀看者都一樣（不是秘密）：

```
"ordering": null                                   // 開關關、或 migration 沒跑
"ordering": { "ship_enabled": true, "shipping_fee": 150 | null, "consent_version": "v1" }   // 開關開
```

`shipping_fee` = `projects.shipping_fee ?? studio_settings.default_shipping_fee`（null = 宅配未設運費 → 頁面不給選宅配）。
`ordering` 非 null **不代表**這個人能下單（觀看者、未確認都不行）；頁面另看 `is_owner` 與 `confirmed_at`。

### 5.3 客人路由

| 路由 | 成功 | 錯誤（依檢查順序） |
|---|---|---|
| `POST /api/pick/orders` | 201 `{order}`（客人視圖）；同 `request_id` 重送 → 200 `{order, replay:true}` | 401；405（`Allow: POST, GET`）；403 `not_owner`；403 `ordering_disabled`；409 `not_confirmed`（未交件 / 未確認，body 之前）；413 `too_large`（> 32 KB）；400 `Invalid JSON` / `invalid_body` / `invalid_request_id` / `invalid_lines` / `too_many_lines`（`max:20`）/ `invalid_qty` / `invalid_photo_key` / `duplicate_line` / `invalid_spreads` / `invalid_contact` / `invalid_delivery` / `ship_disabled` / `consent_required` / `invalid_note`；500 `shop_unavailable` / `orders_unavailable`；404 `product_not_offered`（不在 `readGuestShop` 結果裡：隱藏、退役、平台退役、低於平台價、別的攝影師、service）；403 `not_in_finals`；404 `photo_not_found`；400 `pages_below_min` / `pages_above_max` / `invalid_layout` / `extra_pages_unpriced`；409 `price_changed`（附 `{quote:{lines,subtotal,shipping_fee,total}}`）；409 `too_many_open_orders`（`max:3`）/ `order_cap`（`max:20`） |
| `GET /api/pick/orders` | 200 `{orders:[客人視圖]}`，新到舊，≤ 20 | 401；405；403 `not_owner`；500 `orders_unavailable` |
| `POST /api/pick/orders/:id/cancel` | 200 `{order}`（已是 `cancelled` → 200 不寫） | 401；405；403 `not_owner`；404 `not_found`（不是 UUID、不是這個專案、不是這個 picker、不是 guest 訂單）；500；409 `bad_transition`（`from`：已確認 / 已完成） |

- `GET` 與 `cancel` **不看開關、不看交件狀態**（只要連結活著、是座位持有人）：開關關掉或取消交件後，客人仍能看到並取消自己的待確認訂單（§11 Q13）。
- 客人視圖（只有這個形狀會出現在客人路由，從具名欄位組出來，**絕不** `o.*`）：

```
{ id, status, created_at, confirmed_at, cancelled_at,
  items: [{ kind, name, option_label, qty, unit_price, photo_name | null, spreads | null }],
  subtotal, discount, shipping_fee, total, paid: paid_amount >= total,
  delivery_method, guest_note,
  contact: { name, phone, line, address } | null,        // contact_erased_at 有值 → 只剩 name
  transfer_info: string | null }                          // 只在 confirmed / fulfilled
```

  `photo_name` = 檔名（`key.split('/').pop()`），**不回完整 key、不回資料夾**（同 `/api/pick/rounds`，守住「客人路由不回 `final_folders`」）。
  絕不回：`note`、`unit_cost`、`vendor_cost`、`platform_option_id`、`list_price`、`request_id`、`picker_id`、`consent_version`、`layout` 原文。

- POST body：

```
{ request_id: "<uuid v4>",
  lines: [ {option_id, qty, photo_key} | {option_id, qty, spreads} ],
  contact: { name, phone?, line? }, delivery: { method: 'pickup'|'ship', address? },
  note?: string, expected_total: integer, consent: "v1" }
```

  上限：≤ 20 行；print `qty` 1–10、album 1–3；`note` ≤ 500（`orderNote` 規則 + 控制字元拒絕）；body ≤ 32 KB（`readJsonCapped`）。
  未知 key 忽略；`unit_price`、`price`、`kind`、`name`、`shipping_fee`、`total` 出現在 body 一律無效（不讀）。

- 寫入：一個 batch（D1 batch = transaction）。

```
1) INSERT INTO orders (id, photographer_id, project_id, source, status, picker_id, guest_note, request_id,
     contact_name, contact_phone, contact_line, delivery_method, ship_address, shipping_fee, consent_version,
     created_at, updated_at)
   SELECT ?id, p.photographer_id, p.id, 'guest', 'requested', ?picker, ?note, ?req, …, ?fee, ?ver, ?now, ?now
     FROM projects p
    WHERE p.id = ?pid AND p.owner_picker_id = ?picker AND p.archived_at IS NULL AND p.phase = 'retouching'
      AND p.delivered_at = ?readDeliveredAt AND p.final_folders = ?readFinals AND p.client_confirmed_at IS NOT NULL
      AND (SELECT COUNT(*) FROM orders WHERE project_id = p.id AND source = 'guest' AND status = 'requested') < 3
      AND (SELECT COUNT(*) FROM orders WHERE project_id = p.id AND source = 'guest') < 20
   ON CONFLICT(project_id, request_id) DO NOTHING
2..n) INSERT INTO order_items (…, list_price, layout) SELECT … WHERE EXISTS (SELECT 1 FROM orders WHERE id = ?id)
```

  `?readDeliveredAt` / `?readFinals` 綁路由讀到的值：攝影師在中途更換精修、取消交件 → 整批不落地（照片 key 是對那一版精修驗的）。
  之後讀 `?id`：在 → 201；不在 → 查 `request_id` 同專案同 picker 的訂單：有 → 200 replay；否則重讀專案：
  401（封存）→ 403（座位換人）→ 409 `not_confirmed` → 409 上限（open 先）。

### 5.4 Admin（photographer token，`ADMIN_ONLY_HEADERS`）

| 路由 | 變化 |
|---|---|
| `GET /api/admin/orders`、`…/projects/:id/orders`、單筆回應 | `readOrders` 改**具名欄位**（現在是 `o.*`）；多 `contact {name, phone, line, address, erased_at}`、`delivery_method`、`shipping_fee`、`consent_version`；行多 `list_price`、`layout`（解析後）。不回 `request_id`；`vendor_cost` 照舊不回 |
| `PUT /api/admin/orders/:id` | 加 `shipping_fee`（`isMoney`）；取消的訂單 409 `cancelled`（同其他金額欄位） |
| `POST /api/admin/orders/:id/erase-contact` | 新。200 `{order}`；404；已清過 → 200 不寫。條件寫入 `WHERE id AND photographer_id` |
| `POST /api/admin/projects/:id/orders`（admin 建單） | 行多寫 `list_price`；照片 scope 改為毛片 ∪ 精修（Q17） |
| `GET/PUT /api/admin/settings` | 加 `transfer_info`（null / ≤ 500，控制字元除換行外拒絕）、`ship_enabled`（bool）、`default_shipping_fee`（null / `isMoney`）；缺欄位 → 500 `orders_unavailable`，什麼都不寫 |
| `PATCH /api/admin/projects/:id` | `PROJECT_PATCH_FIELDS` 加 `shipping_fee`（null / `isMoney`），算 plan 欄位（封存 409） |
| `GET /api/admin/stats` | `todo.requested_orders`（`source='guest' AND status='requested'`）；（可選）`revenue[].shipping` |

### 5.5 Migration 沒跑時（never fail open）

| 路由 | 沒跑 |
|---|---|
| `GET /api/pick/shop` | 正常，`ordering: null` |
| 三條客人訂單路由 | 500 `orders_unavailable`，什麼都不寫 |
| admin 訂單讀取 / stats / 建單 / PUT / 付款 / 狀態 | **正常**（金額 SQL 降級成無運費版本；新欄位讀 null） |
| settings / PATCH 帶新欄位 | 500 `orders_unavailable`；不帶新欄位照舊 |
| `POST /api/pick/interest`、確認、要求修改 | 不變 |

### 5.6 Email

`sendOrderNotification(env, project, pickerName, order, event)`，同 `NOTIFY_EMAIL` / `PHOTOGRAPHER_EMAIL` / `NOTIFY_FROM`，
沒設就略過（`console.warn`）。主旨 `[新訂單] <title> — <name>：NT$<total>`；客人取消時 `[客人取消訂單] …`。
全部經 `oneLine`，HTML 經 `escapeHtml`。內文：專案、客人名、每行（品名、規格、數量、單價、相本跨頁數或檔名，最多 20 行）、運費、
總額、取貨方式、客人備註（只在內文，`white-space:pre-wrap`）、連結 `https://imhoti.tw/studio/orders.html?status=requested`。
**不放電話、LINE、地址**（個資不進信箱）。背景送（`ctx.waitUntil`），失敗不影響訂單。
**不節流**：座位 key + 每專案 20 筆總上限把信限制在 ≤ 40 封/專案（同要求修改信的理由）。

## 6. 暗中上線開關

- **放哪**（建議 Q1-B）：`worker/wrangler.toml` `[vars]` 的 `GUEST_ORDERS`，同 `CUSTOM_PRODUCTS` 的作法：
  `"on"` = 全開；`"pilot"` = 只有 `GUEST_ORDERS_PILOT`（逗號分隔的 project id）裡的專案開；其他值或沒設 = 關（**打錯字 = 關**）。
  必須寫在 toml，不能只在 Dashboard 加（CI 的 `wrangler deploy` 會清掉，toml 已有註解）。
- **誰翻**：Tim（平台營運者）改 toml、合併到 main 部署。攝影師不能翻（個資告知的責任在審閱前不能交給攝影師按鈕）。
  多攝影師以後再加 per-studio 開關（`studio_settings` 欄位），S2 不做。
- **關的時候客人看到**：完成頁跟今天一模一樣——商品卡 + 「我有興趣」。`/shop` 回 `ordering: null`；`POST /api/pick/orders` 403 `ordering_disabled`。
- **開的時候**：座位持有人在每張可下單的商品卡看到「訂購」（取代「我有興趣」）；觀看者只看到商品資訊與「由主要挑選人訂購」一行字。
  「我有興趣」路由保留（快取中的舊 pick.js），資料列留作歷史。
- **pilot 的用途**：Tim 先在自己的測試專案用真手機、真 D1、真信箱跑完整流程，其他客人完全看不到。
- **翻開前的關卡**（checklist，寫進合併後清單）：告知文字與 `ORDER_CONSENT_VERSION` 已審；`transfer_info` 已填；
  `default_shipping_fee` / `ship_enabled` 已決定；pilot 跑過一輪真單。

## 7. 濫用與安全清單（每條都是一個測試案例）

每條都用**座位持有人 key + 已確認的 fixture** 先證明正向案例 201，再改一個條件，避免「被前面的 403/409 擋掉而假通過」。

| # | 嘗試 | 預期 |
|---|---|---|
| 1 | 價格竄改：body 帶 `unit_price: 1`、`price`、`total`、`shipping_fee: 0`、`kind:'service'`、`name` | 全部忽略；行的 `unit_price`、`list_price`、`unit_cost` = 目錄；運費 = 專案/預設值 |
| 2 | `expected_total` 與伺服器不同（規格剛改價、平台價調高到隱藏、運費改了） | 409 `price_changed` + `quote`，沒有寫任何列 |
| 3 | 隱藏 / 退役 / 平台退役 / 低於平台價 / service / 別的攝影師的 `option_id` / 不存在 | 404 `product_not_offered`（與 `readGuestShop` 同一份清單） |
| 4 | 照片 key：毛片（原檔下載開或關）、`_thumbs/…`、`_books/…`、別專案資料夾、`..`、結尾 `/`、控制字元、> 256 字 | 400 `invalid_photo_key` 或 403 `not_in_finals` |
| 5 | 精修資料夾內但 R2 沒有的 key | 404 `photo_not_found` |
| 6 | 數量 / 行數：qty 0、11（print）、4（album）、1.5、`"2"`；21 行；同 key 同規格兩行 | 400 對應碼，沒寫 |
| 7 | 相本 `spreads` 低於 min、高於 max、非整數、負數；加頁未定價卻超過 min | 400 `pages_below_min` / `pages_above_max` / `invalid_spreads` / `extra_pages_unpriced` |
| 8 | 重複送出（連點、網路重試）同 `request_id` | 第二次 200 `replay:true`、只有一筆訂單、只寄一封信；`request_id` 不是 UUID → 400 |
| 9 | 洪水：同專案第 4 筆 `requested`、第 21 筆 guest 訂單（含已取消） | 409 `too_many_open_orders` / `order_cap`；上限在 INSERT 裡判斷，兩個同時送只會進一筆 |
| 10 | 列舉：別專案的訂單 id、自己專案別 picker 的、admin/system 訂單的 id、非 UUID | `cancel` 404；`GET` 只列自己的 |
| 11 | 座位：觀看者、沒有 key、別專案的 key、seat reset 前的舊 key | 403 `not_owner`（三條路由都是）；**同一 fixture 先證明 owner 201** |
| 12 | 狀態：未交件、交件未確認、取消交件後、退回挑片後、更換精修後（確認被清） | 建立 409 `not_confirmed`；GET/cancel 仍可 |
| 13 | 只有攝影師能確認：pick token / studio / client / operator token 打 `/api/admin/orders/:id/status` | 401；客人路由沒有任何改成 `confirmed` 的路徑 |
| 14 | 注入：名字、備註、地址含 `<script>`、`\r\nBcc:`、U+202E | email 主旨一行（`oneLine`）、HTML 跳脫；admin 頁 `textContent`；若日後做 CSV 一律 `csvCell`（`= + - @ \t \r` 前綴 `'`） |
| 15 | 競態：攝影師確認 vs 客人取消（同時） | 兩者都是 `UPDATE … WHERE status = 'requested'` 的條件寫入；後到的 409 `bad_transition`（附真實 `from`） |
| 16 | 競態：建立途中攝影師更換精修 / 取消交件 / 封存 / seat reset | 寫入 gate 綁 `delivered_at`、`final_folders`、`client_confirmed_at`、`owner_picker_id`、`archived_at` → 不落地；重讀回 409 / 403 / 401 |
| 17 | 洩漏：客人回應掃描不含 `unit_cost|vendor_cost|platform_option_id|list_price|note"|request_id|picker_id|consent_version|final_folders`；完整 key 不出現 | 正向斷言 `unit_price`、`photo_name` 存在 |
| 18 | 觀看者的 `/api/pick/state`、`/shop` 不出現任何訂單或聯絡資料 | 掃描回應 |
| 19 | 個資清除：erase 後 admin 與客人讀取都只剩姓名；email 從來不含電話/地址 | 讀 fake D1 與 fake mailer |
| 20 | 開關：`GUEST_ORDERS` 沒設、`"On"`、`"true"`、`"pilot"` 但專案不在名單 | 403 `ordering_disabled`、`/shop` `ordering: null` |
| 21 | 告知版本：`consent` 缺、`true`、`"v0"` | 400 `consent_required` |
| 22 | body > 32 KB（串流截斷，不先 `JSON.parse`） | 413 `too_large` |
| 23 | 運費：宅配但 `ship_enabled = 0` 或運費未設；面交帶 `address` | 400 `ship_disabled`；面交的地址不存（存 NULL） |
| 24 | admin 回應不含 `vendor_cost`（`readOrders` 改具名欄位後的回歸） | 掃描 |

## 8. 測試計畫

### 8.1 Worker（新檔，不改既有檔的斷言；只因契約擴充而動的列在合併說明）

- `worker/test/guest-orders.test.mjs`：migration 檔（逐句、schema.sql 有註記）；建立正向（print、album、混合、宅配/面交）；
  §3.3 金額表（含 `albumExtraPagesCost` 的 null 分支與 `min_pages` NULL）；冪等；上限；狀態矩陣（§3.4 每一列）；
  GET / cancel；email 內容（主旨一行、無電話地址、20 行截斷、HTML 跳脫）；缺 migration（§5.5 每一列）。
- `worker/test/guest-orders-security.test.mjs`：§7 全部 24 條，一條一個 `test()`。
- `worker/test/order-money.test.mjs`：`ORDER_TOTAL_SQL` 含運費、折扣不吃運費、`below_paid` / `overpaid` 含運費、
  stats 的 `outstanding` 與 `revenue`、**有/無 `shipping_fee` 欄位兩種 schema** 都對；extra-pick 自動訂單不受影響（`extraPickWrites`）。
- `worker/test/products-orders.test.mjs`：admin 建單照片 scope 改動（若 Q17-A）：精修 key 可加、毛片照舊、`_` key 照舊拒絕。
- 既有：`product-max-pages.test.mjs` 的「`albumPagesProblem is not wired to any route yet`」與
  `product-extra-page-price.test.mjs` 的「`albumExtraPagesCost is not wired to any route yet`」**都會變紅**——
  按 guest-shop 原文的指示改成「只接在 `POST /api/pick/orders`」。

### 8.2 Mutation（Worker，12 個；每個先 `node --input-type=module --check < worker/worker.js`）

1. 建立拿掉 `isOwner` → #11 紅。
2. 拿掉 `client_confirmed_at IS NOT NULL`（gate 與預檢）→ #12 紅。
3. 單價改成讀 `l.unit_price ?? c.price`（admin 覆寫路徑）→ #1 紅。
4. 拿掉 `expected_total` 比對 → #2 紅。
5. 照片 scope 用 `scope.preview`（含毛片）→ #4 毛片案例紅。
6. 拿掉 `albumPagesProblem` 呼叫 → #7 紅。
7. `extra_pages_unpriced` 分支拿掉（null 當 0）→ #7 紅。
8. open 上限 `< 3` 改 `<= 3` → #9 紅。
9. GET 查詢拿掉 `AND picker_id = ?` → #10/#11 紅。
10. cancel 拿掉 `AND status = 'requested'` → #15 紅。
11. 客人視圖改回 `...o` → #17 紅。
12. `ORDER_TOTAL_SQL` 拿掉 `+ shipping_fee`（或折扣扣到運費）→ order-money 紅。

每條規則先寫測試、在 `17eee37` 上跑（路由不存在 → 401/404 而非預期碼），確認失敗理由是「規則不存在」。

### 8.3 瀏覽器（各自新檔）

- `test/suites/NN-guest-order.mjs`：開關關 → 只有「我有興趣」（訂購按鈕**不在 DOM**）；開 → 座位持有人有「訂購」、觀看者沒有（同 fixture 先證明 owner 有）；
  print 選照片、album 跨頁步進器（min/max 夾住、加頁費顯示）、表單驗證、告知勾選、送出 → 收據（待確認、無匯款資訊）、
  fake 回 `confirmed` → 顯示 `transfer_info`；`price_changed` 顯示新總額再確認；409 / 429 / 離線文字；取消按鈕只在 requested。
  完成頁是淺色 `.cp`：新元素放在 `.cp` 下、不動 `css/styles.css` 的 `:root`（掃描元素數量設下限）。
- `test/suites/NN-admin-guest-orders.mjs`：orders.html 聯絡卡片（`textContent`，含 bidi 測試字串）、清除個資確認、運費顯示與修改、
  dashboard 徽章、settings 三個新欄位。fake 回應**照真實 Worker 形狀**（含 `contact: null` 的舊單）。
- 既有 `33-completion-page`、product interest 相關 suite、orders 相關 suite 不改斷言必須綠。

## 9. 工作切分與順序

| 包 | 內容 | 模型 / 分級 | 檔案（互不重疊） | 依賴 |
|---|---|---|---|---|
| WP1 | migration、schema.sql、`orderLines` scope 參數、客人三條路由、`readOrders` 具名欄位、金額 SQL + 降級、settings / PATCH / stats / erase、email、§8.1 測試、§8.2 mutants | opus，High（金額、個資、客人寫入） | `worker/**` | 本稿 + Tim 答 Q1/Q2/Q8/Q10 |
| WP2 | WP1 對抗式安全審查（只讀、跑測試、補 §7 缺的案例） | opus | 只補 `worker/test/guest-orders-security.test.mjs` | WP1 |
| WP3 | 客人端：新 `js/guest-order.js`（商品 → 行 → 表單 → 收據 → 我的訂單）、新 `css/guest-order.css`（`.cp` 範圍）、`js/completion-page.js` 加一個 `cfg.onOrder` 掛勾（取代「我有興趣」按鈕的地方）、`js/pick.js` 只接 cfg 與 header、`index.html` script tag、suite | sonnet，Normal（Worker 是唯一防線） | `js/guest-order.js`、`css/guest-order.css`、`js/completion-page.js`、`js/pick.js`、`index.html`、`test/suites/NN-guest-order.mjs` | WP1 契約（可先用 fake 並行） |
| WP4 | 攝影師端：聯絡卡片、清除、運費、徽章、設定 | sonnet，Normal | `orders.html`、`js/orders-common.js`、`admin.html`（專案訂單區約 2474 行的渲染）、`settings.html`、`dashboard.html`、`js/side-nav.js`、`test/suites/NN-admin-guest-orders.mjs` | WP1 契約 |
| 合併 | 合併、`?v=` 一次、全部 suite、改 `docs/products-orders.md` Phase B 段與 CLAUDE.md 不變量 | orchestrator | — | 全部 |

檔案衝突：`worker.js` 只給 WP1（WP2 不改程式）；`js/pick.js` 與 `js/completion-page.js` 只給 WP3（revision-pins 的前端若同時在動，WP3 要排在它之後）；
`admin.html` 只給 WP4；`index.html` 只有 WP3 動。

順序：① WP1 ‖ WP3、WP4（UI 照 §5 契約用 fake）② WP2 ③ WP1 修審查結果 ④ 合併、全測、部署（開關 `"off"`）
⑤ Tim 跑 D1 migration（合併前）、改 `"pilot"` 部署、真機一輪 ⑥ 審閱通過後 `"on"`。

誠實估計：**4–5 輪**才會真正開給客人。WP1 一輪（約 1 天 agent 工作，worker.js 5.2k 行光讀就貴）、審查後通常要修一輪、
UI 兩包並行一輪、合併後 pilot 真機至少一輪會發現手機表單問題（LINE 內建瀏覽器鍵盤蓋住按鈕、自動填入）。
最後一步卡在個資審閱，不在程式。Token 約 2.5–3M（±40%，參考 revision-pins 的實際花費）。

Tim 要手動做的：合併前跑 migration（逐句）；決定運費預設與宅配；填 `transfer_info`；pilot 時用自己的手機下一張真單、
後台確認、看收據出現匯款資訊、取消一張；找人審告知文字；最後改 `GUEST_ORDERS = "on"`。

## 10. 風險與沙盒裡驗證不到的

- **真的寄信**：fake mailer 只驗證內容；Email Routing、驗證地址、垃圾信匣、中文主旨在 Gmail 的顯示都要 prod 驗。
- **真的 D1**：`INSERT … SELECT … ON CONFLICT DO NOTHING` 帶 UNIQUE 索引（含 NULL）、batch 是否真的是 transaction、
  `withoutMissingColumn` 對 D1 錯誤訊息的比對，只在 node:sqlite 上測過。
- **真手機**：iPhone Safari、LINE 內建瀏覽器的表單（鍵盤、`inputmode=tel`、自動填入地址）、淺色完成頁上的新底部面板、
  回上一頁時表單是否保留。
- **轉帳流程**：完全在系統外（客人轉帳 → 攝影師對帳 → 手動記錄收款）。客人匯了但攝影師忘了記，收據會一直顯示「請匯款」。
- **客人不知道已確認**：沒有寄信給客人（免費方案限制），客人要自己回來看；實務上攝影師會用 LINE 聯絡。真單後再評估。
- **金額 SQL 改動面大**：`ORDER_TOTAL_SQL` 被讀取、未付篩選、stats 共用；改錯會讓儀表板全錯。做法 B 可避開（Q2）。
- **相本「全部精修」**：600 張精修的婚禮也只會存 `photo_keys: []`；攝影師要記得排版範圍 = 下單當時的交件資料夾，而之後更換精修會改變它。
- **加頁沒有成本欄位**：平台費開始收之前要補。
- **180 天生命週期**：訂單 key 指向的精修 180 天後被刪；訂單晚於上傳很久時，印前要先確認檔案還在。
- **個資審閱**：S2 程式可以全部做完、合併、部署，但開關不能開；時間取決於找到審閱的人。

## 11. 待 Tim 決定（回一個字母即可）

1. **暗開關的形式**
   A. `GUEST_ORDERS` on/off（toml）。B. **on / off / pilot + 專案名單（建議）**。C. 設定頁的 per-studio 欄位。
   取捨：B 讓你先在自己的專案用真手機跑；C 會把個資責任交給攝影師按鈕，審閱前不建議。

2. **運費怎麼存、預設多少、誰能改**
   A. `orders.shipping_fee` 欄位（你 9/30 的決定 3；本稿 §3.5 照這個寫）。B. **Worker 自動加一行 `service`「運費」（建議）**。
   取捨：A 要改 `ORDER_TOTAL_SQL`、加降級 SQL、改 `below_paid`，營收毛利還要另扣；B 金額 SQL 一行都不用改，
   攝影師在確認時直接改那一行的價格，平台費本來就不算 `platform_option_id` 為 NULL 的行；缺點是收據上運費看起來像一個品項。
   兩者都是：studio 預設（設定頁）→ 專案可改 → 訂單確認時可改；面交免運；客人送出前看得到運費。預設金額請給一個數字（例 NT$150）或「未設 = 不提供宅配」。

3. **上線時提供宅配嗎**
   A. **只開面交（建議），宅配等第一張真單後再開**。B. 兩個都開，預設運費 NT$__。
   取捨：A 少收一個地址欄（個資最少）；B 外地客人才買得到。

4. **數量與上限**（沒有庫存）
   A. **無框畫每行 1–10 份、每單 ≤ 20 行、相本 1–3 本、每專案同時 ≤ 3 筆待確認、總共 ≤ 20 筆客人訂單（建議）**。B. 更緊（每單 ≤ 10 行、同時 1 筆）。C. 更鬆。
   取捨：上限只防濫用；一般客人一次不會印超過 20 張不同照片，超過就直接聯絡你。

5. **客人能取消到什麼時候**
   A. **只在待確認（建議）**。B. 確認後、未付款前也可以。C. 不能取消，要找攝影師。
   取捨：B 的話你確認後可能已經下單給廠商；A 最清楚。

6. **聯絡欄位**
   A. **姓名 + 電話或 LINE ID 擇一必填 + 宅配才填地址（建議）**。B. 電話必填。C. 只要姓名（你已有客人的 LINE）。
   取捨：C 個資最少，但若客人不是平常聯絡你的那個人會找不到人。

7. **個資告知的關卡**
   A. **表單上的短告知 + 必勾 + 存版本號；審閱前開關不開（建議）**。B. 另外做 `privacy.html` 全文頁，表單連過去。
   誰審？（你在回答 5 說要找人）。取捨：B 比較完整但多一頁要維護；A 先夠用，B 可以等審閱的人要求。

8. **收據身分**
   A. **用座位 key（只有主要挑選人能下單與看訂單，換手機 = 跟現在換手機一樣）（建議）**。B. 另發一把訂單 key（`X-Order-Key`，存 hash）。C. 客人帳號登入（Parked）。
   取捨：A 不用新的祕密、seat reset 後新的人看不到前一位的電話地址；B 多一把會掉的 key，只有在「觀看者也能下單」時才需要。

9. **有「我有興趣」紀錄時能下單嗎 / 按鈕怎麼換**
   A. **兩者無關、都允許；開關開時按鈕換成「訂購」，興趣紀錄留作歷史（建議）**。B. 兩個按鈕都留。C. 下單時用興趣紀錄預選商品。
   取捨：B 會讓客人困惑「按哪個」；C 多做事但沒人要求。

10. **S2 的相本價格**
    A. **客人選跨頁數（min–max），加頁費由 Worker 用 `extra_page_price` 算；未定加頁價就只能選 min；沒有 `min_pages` 就不讓選、加頁費 0（建議）**。
    B. 不選頁數，先收基本價，攝影師排版後在確認時改價。C. S2 不賣相本，只留「我有興趣」。
    取捨：A 價格確定、客人匯的就是最後金額，攝影師要照這個頁數排；B 客人看到的價格之後會變（轉帳資訊在確認後才出現，所以還能接受）。

11. **無框畫解析度**
    A. **S2 不自動檢查，攝影師確認前與印前自己看（建議）**。B. Worker 讀原檔 JPEG 開頭（R2 range 讀前 64 KB 解析尺寸），對照平台規格新增的「最小長邊像素」欄位，太小就擋或警告。
    C. 上傳時把寬高存進 R2 metadata（只對新上傳有效），日後檢查用。
    取捨：B 要一個 JPEG 解析器與 operator 欄位（High tier）；C 便宜但舊照片沒有資料。建議 S2 用 A、先做 C 累積資料。

12. **錢怎麼流、15% 平台費**（只問，不在本稿決定）
    現有決定：平台費規則已定（list price 與平台價差的 15%，攝影師折扣自己吸收、上限為該行毛利），**目前不收**，THE ORDER 第 6 步再決定。
    要問的：A. **客人匯款到攝影師帳戶，攝影師再私下付你平台價（S2 不記錄）（建議，不需程式）**。B. 客人匯到平台，平台再付攝影師（需要金流，Parked）。
    另外：相本**加頁**目前只有給客人看的 `extra_page_price`，沒有平台成本——加頁的平台成本要不要新增欄位？（不急，平台費開始收之前要決定。）

13. **取消交件 / 退回挑片 / 更換精修時，開著的訂單怎麼辦**
    A. **訂單不動；客人仍能看與取消自己的待確認訂單、不能下新單；後台提示「專案目前未交件」（建議）**。B. 自動取消待確認訂單。
    取捨：B 要改交件批次（不變量核心），而且客人可能已匯款。

14. **攝影師確認後要通知客人嗎**
    A. **不寄，客人回完成頁看；你用 LINE 聯絡（建議）**。B. 收客人 email 並寄信（目前免費方案只能寄到驗證過的地址，要先升級 Email 方案）。
    取捨：B 對客人最友善，但多收一項個資、多一筆費用。

15. **個資保存**
    A. **S2 只做手動「清除聯絡資料」；自動清除（完成或取消後 180 天）等審閱結果再做（建議）**。B. 現在就在後台讀取時順手清（讀取裡做寫入）。
    取捨：B 不用排程，但「讀取時寫資料」容易出錯也難測。

16. **觀看者**
    A. **看得到商品，不能訂購，顯示「由主要挑選人訂購」（建議）**。B. 觀看者也能下單（舊稿設計，需要 Q8-B）。

17. **攝影師自己建單時能不能加精修照片**（現在連 admin 也只能加毛片的 key）
    A. **一起修：admin 建單 = 毛片 ∪ 精修（建議）**。B. 只改客人路徑。
    取捨：A 是現有的 bug（無框畫幾乎都印精修），改動在同一個函式；B 範圍小但 bug 留著。

## 12. 與現況不一致（舊文件 vs 程式，17eee37）

1. `docs/products-orders.md` API 表列了 `GET /api/admin/orders/:id/export.csv`：**程式沒有這條路由**（Phase A scope 也寫 out）。
2. `docs/products-orders.md` Phase B 大綱：「只有 owner seat 下單、picking / submitted / retouching 都可」——被本稿取代（只在完成頁）。
3. 本檔 2026-09-30 稿：任何連結持有人 + order key、promo、`shop_enabled`、`ship_enabled` 的 S1 欄位——都不存在（S1 trimmed），S2 改為座位持有人。
4. 本檔 Interplay：「`orderLines` 只認 `project.folders`，精修會失敗（連 admin）」——**仍然成立**（worker.js `orderLines`：`scope = {folders: JSON.parse(project.folders)}`）。
5. 本檔 Interplay：「`readOrders` 選 `o.*`」——**仍然成立**；新欄位會自動流進每個 admin 訂單回應，所以 WP1 必須改具名欄位。
6. 本檔 2026-09-30 WP6「orders 頁加『確認訂單』」：**已經有了**（`js/orders-common.js` 對 `requested` 有「確認 / 取消訂單」，`orders.html` 有「待確認」篩選）。
7. 本檔 Email 的 10 分鐘節流與 `notified`：與後來的要求修改信、興趣信的作法不同（它們不節流或 24h 一封）；本稿改為不節流 + 上限。
8. `readGuestShop` 用 `project.photographer_id`，`orderLines` 與所有 admin 訂單查詢用 `DEFAULT_PHOTOGRAPHER_ID`——今天相同，多攝影師時會分岔。
9. `privacy.html` 在舊稿多處被引用，**不存在**。
10. 本檔「Album page range」寫「`albumExtraPagesCost` 回 null 時 S3 決定」；本稿把這個決定提前到 S2（`extra_pages_unpriced`，Q10）。
