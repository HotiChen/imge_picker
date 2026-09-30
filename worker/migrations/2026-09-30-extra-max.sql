-- Extra-pick cap (docs/project-plan.md). Paste into the D1 Console for
-- imagepicker-db once, after 2026-09-30-retouch-pins.sql and before merging
-- the Worker that enforces the cap. Until it runs, every project is uncapped
-- (as today), saves, pick state, the project list and detail keep working,
-- creating a project stores no extra_max, and only a PATCH or a settings PUT
-- that names extra_max / default_extra_max answers 500 extra_max_unavailable.
--
-- Existing projects get NULL = no plan cap, so nothing changes for them.
--
-- Not safe to re-run: a second run fails with "duplicate column name:
-- extra_max" (or default_extra_max), which means it already ran and can be
-- ignored.

ALTER TABLE projects ADD COLUMN extra_max INTEGER;                -- NULL = no plan cap
ALTER TABLE studio_settings ADD COLUMN default_extra_max INTEGER; -- NULL = unset (10)
