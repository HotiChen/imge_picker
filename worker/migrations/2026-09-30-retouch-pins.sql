-- Retouch pins (docs/guest-picking.md). Paste into the D1 Console for
-- imagepicker-db once, after 2026-09-30-delivery.sql and before merging the
-- Worker that saves pins. Until it runs, a save that carries `marks` answers
-- 500 marks_unavailable; every other save, pick state, submit and the admin
-- detail keep working as before (no pins anywhere).
--
-- Not safe to re-run: a second run fails with "duplicate column name: marks",
-- which means it already ran and can be ignored.

ALTER TABLE selections ADD COLUMN marks TEXT;   -- JSON [{x,y,note}], NULL = none
ALTER TABLE submissions ADD COLUMN marks TEXT;  -- JSON {photo_key:[{x,y,note}]} snapshot, NULL = none
