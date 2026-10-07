-- Product bleed (docs/products-orders.md, "bleed_mm").
-- Paste into the D1 Console for imagepicker-db once, before merging the
-- Worker that reads and writes bleed_mm. Until it runs, every catalogue
-- read, the photographer's product pages and the guest shop keep working
-- with bleed_mm = null; only an operator create or edit that sets a bleed (a
-- number) answers 500 bleed_mm_unavailable and writes nothing.
--
-- Millimetres of bleed the lab wants on each side of a page or print, 0–10
-- (decimals allowed); albums and prints alike. Existing platform products get
-- NULL = 0 mm, so nothing changes for them.
--
-- Not safe to re-run: a second run fails with "duplicate column name:
-- bleed_mm", which means it already ran and can be ignored.

ALTER TABLE platform_products ADD COLUMN bleed_mm REAL;  -- 0–10 mm, albums and prints; NULL = 0 mm
