-- 「我有興趣」 on the completion page (docs/guest-shop.md, product interest).
-- Paste into the D1 Console for imagepicker-db once, before merging the
-- Worker that serves POST /api/pick/interest. One statement.
--
-- Until it has run, POST /api/pick/interest answers 500 interest_unavailable
-- and writes nothing (no email either), and GET /api/admin/projects/:id says
-- interests: []. Every other route keeps working as before.
--
-- CREATE TABLE IF NOT EXISTS: safe to re-run.

-- One row per project and product the client tapped 「我有興趣」 on. name and
-- kind are the product as it was at the latest tap (the catalogue can change
-- later). last_emailed_at: when the photographer was last emailed about this
-- row (at most once per 24 h).
CREATE TABLE IF NOT EXISTS product_interests (
  project_id      TEXT NOT NULL,
  product_id      TEXT NOT NULL,
  product_name    TEXT NOT NULL,
  product_kind    TEXT NOT NULL,
  first_at        TEXT NOT NULL,
  last_at         TEXT NOT NULL,
  tap_count       INTEGER NOT NULL DEFAULT 1,
  last_emailed_at TEXT,
  PRIMARY KEY (project_id, product_id)
);
