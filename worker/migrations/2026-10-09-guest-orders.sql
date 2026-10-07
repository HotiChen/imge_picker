-- S2 guest ordering (docs/guest-shop.md, 「S2 客人自助訂購」 and 「S2 — Tim 的
-- 決定」: pickup only, no shipping). Paste into the D1 Console for
-- imagepicker-db once, before merging the Worker that serves
-- POST/GET /api/pick/orders and POST /api/pick/orders/:id/cancel. The console
-- runs one statement at a time: run the eleven below one by one, in order.
--
-- Until all of them have run, the three guest order routes answer 500
-- orders_unavailable and write nothing, GET /api/pick/shop says
-- ordering: null, a settings PUT naming transfer_info and
-- POST /api/admin/orders/:id/erase-contact answer 500 orders_unavailable.
-- Every other route — the photographer's orders (read, create, edit, payment,
-- status), stats, settings without transfer_info, 「我有興趣」, the pick
-- routes — keeps working as before, the new fields reading null.
--
-- Existing orders get NULL in every new column (they are admin / system
-- orders); existing order lines get list_price NULL and layout NULL.
--
-- The ALTERs are not safe to re-run: a second run fails with "duplicate column
-- name: …", which means it already ran and can be ignored. The CREATE UNIQUE
-- INDEX is IF NOT EXISTS and can be re-run.
--
-- Running it does not turn ordering on: that is GUEST_ORDERS in
-- worker/wrangler.toml ("off" until the privacy notice is reviewed).

-- 1) the UUID the guest page makes for each submit: a retry of the same
--    submit returns the order that landed instead of making a second one
ALTER TABLE orders ADD COLUMN request_id TEXT;

-- 2)–4) who to contact: the name (1–50 characters) and a phone (6–20) and/or
--    a LINE ID (1–50), at least one of the two. Guest orders only
ALTER TABLE orders ADD COLUMN contact_name TEXT;
ALTER TABLE orders ADD COLUMN contact_phone TEXT;
ALTER TABLE orders ADD COLUMN contact_line TEXT;

-- 5) 'pickup' (面交) — the only method in S2
ALTER TABLE orders ADD COLUMN delivery_method TEXT;

-- 6) the version of the privacy notice the guest ticked, e.g. 'v1'
ALTER TABLE orders ADD COLUMN consent_version TEXT;

-- 7) when the photographer cleared the phone and LINE ID (清除聯絡資料);
--    the name stays, for the books
ALTER TABLE orders ADD COLUMN contact_erased_at TEXT;

-- 8) one order per submit in a project (several NULLs are fine: admin and
--    system orders carry no request_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_request ON orders(project_id, request_id);

-- 9) the catalogue price when the line was made (admin lines too): what the
--    future platform fee is computed from
ALTER TABLE order_items ADD COLUMN list_price INTEGER;

-- 10) album lines: {"v":1,"mode":"photographer","source":"all_finals","spreads":N}
ALTER TABLE order_items ADD COLUMN layout TEXT;

-- 11) the transfer details a guest sees on a confirmed order (≤ 500
--     characters, set in settings)
ALTER TABLE studio_settings ADD COLUMN transfer_info TEXT;
