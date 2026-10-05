-- Album maximum pages (docs/products-orders.md, "min_pages / max_pages").
-- Paste into the D1 Console for imagepicker-db once, after
-- 2026-10-06-product-min-pages.sql and before merging the Worker that reads
-- and writes max_pages. Until it runs, every catalogue read, the
-- photographer's product pages and the guest shop keep working with
-- max_pages = null; only an operator create or edit that sets a maximum (a
-- number) answers 500 max_pages_unavailable and writes nothing. The two
-- files are independent: either one missing degrades only its own column.
--
-- Same unit as min_pages: inside spreads (one spread = 1 P; cover and back
-- are not counted). When both are set, max_pages >= min_pages. Existing
-- platform products get NULL = no maximum, so nothing changes for them.
--
-- Not safe to re-run: a second run fails with "duplicate column name:
-- max_pages", which means it already ran and can be ignored.

ALTER TABLE platform_products ADD COLUMN max_pages INTEGER;  -- album only, 1–200, >= min_pages; NULL = no maximum
