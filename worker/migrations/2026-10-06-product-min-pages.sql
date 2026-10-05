-- Album minimum pages (docs/products-orders.md, "min_pages"). Paste into the
-- D1 Console for imagepicker-db once, after 2026-10-04-client-confirm.sql and
-- before merging the Worker that reads and writes min_pages. Until it runs,
-- every catalogue read, the photographer's product pages and the guest shop
-- keep working with min_pages = null; only an operator create or edit that
-- sets a minimum (a number) answers 500 min_pages_unavailable and writes
-- nothing.
--
-- The unit is inside spreads (one spread = 1 P; cover and back are not
-- counted): 相本書 with min_pages 10 needs at least 10 spreads. Existing
-- platform products get NULL = no minimum, so nothing changes for them.
--
-- Not safe to re-run: a second run fails with "duplicate column name:
-- min_pages", which means it already ran and can be ignored.

ALTER TABLE platform_products ADD COLUMN min_pages INTEGER;  -- album only, 1–200; NULL = no minimum
