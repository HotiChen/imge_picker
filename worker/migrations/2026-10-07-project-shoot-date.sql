-- Project shoot date (docs/delivery.md, "Shoot date").
-- Paste into the D1 Console for imagepicker-db once, before merging the
-- Worker that reads and writes projects.shoot_date. Until it runs, the
-- project list, the detail, every PATCH without it and the guest pages keep
-- working with shoot_date = null; only a create or PATCH that sets it
-- answers 500 shoot_date_unavailable and writes nothing.
--
-- 'YYYY-MM-DD' (a real day, 1900–2100) or NULL = not set; existing projects
-- get NULL. Shown to the guest only on the completion page (delivered and
-- confirmed). Not users.shoot_date (the client account's own answer).
--
-- Not safe to re-run: a second run fails with "duplicate column name:
-- shoot_date", which means it already ran and can be ignored.

ALTER TABLE projects ADD COLUMN shoot_date TEXT;  -- 'YYYY-MM-DD' or NULL
