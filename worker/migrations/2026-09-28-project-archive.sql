-- Project archive (docs/guest-picking.md, "Archive and delete"). Paste into
-- the D1 Console for imagepicker-db once, after 2026-09-27-guest-picking.sql
-- and before deploying the Worker that serves the archive routes: until it
-- runs, the project list fails and every pick link is refused (album links
-- are unaffected).
--
-- Not safe to re-run: a second run fails with "duplicate column name:
-- archived_at", which means it already ran and can be ignored.

ALTER TABLE projects ADD COLUMN archived_at TEXT;
