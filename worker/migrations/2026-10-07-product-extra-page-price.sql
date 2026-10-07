-- Album extra-page price (docs/products-orders.md, "extra_page_price").
-- Paste into the D1 Console for imagepicker-db once, before merging the
-- Worker that reads and writes extra_page_price. Until it runs, every
-- catalogue read, the photographer's product pages and the guest shop keep
-- working with extra_page_price = null; only an operator create or edit that
-- sets a price (a number) on an album answers 500
-- extra_page_price_unavailable and writes nothing.
--
-- NT$ per inside spread above min_pages (1 spread = 1 P; cover and back not
-- counted), a whole number 0–10,000,000; albums only (NULL on a print).
-- Existing platform products get NULL = extra pages not priced.
--
-- Not safe to re-run: a second run fails with "duplicate column name:
-- extra_page_price", which means it already ran and can be ignored.

ALTER TABLE platform_products ADD COLUMN extra_page_price INTEGER;  -- NT$ per spread above min_pages, albums only; NULL = not priced
