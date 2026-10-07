-- Project type (docs/delivery.md, "Project type").
-- Paste into the D1 Console for imagepicker-db once, before merging the
-- Worker that reads and writes projects.project_type. Until it runs, the
-- project list, the detail, every PATCH without it and the guest pages keep
-- working with project_type = null; only a create or PATCH that names it
-- answers 500 project_type_unavailable and writes nothing.
--
-- The photography category of the PROJECT: one of the categories in
-- js/shoot-types.js (婚紗 / 婚禮 / 親子 / 個人 / 活動) or what the photographer
-- typed under 其他 (trimmed, at most 20 characters); NULL = not set, which
-- existing projects get. Photographer-only: no guest route returns it. Not
-- users.shoot_type (the client account's own registration answer).
--
-- Independent of 2026-10-07-project-shoot-date.sql: either may run first.
-- Not safe to re-run: a second run fails with "duplicate column name:
-- project_type", which means it already ran and can be ignored.

ALTER TABLE projects ADD COLUMN project_type TEXT;  -- category text or NULL
