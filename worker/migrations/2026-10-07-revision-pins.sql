-- Revision pins on the finals (docs/revision-pins.md). Paste into the
-- D1 Console for imagepicker-db once, after 2026-10-04-client-confirm.sql and
-- before merging the Worker that serves PUT /api/pick/revision-pins,
-- POST /api/pick/revision-round and GET /api/pick/rounds…. The console runs
-- one statement at a time: run the four below one by one, in order.
--
-- Until all four have run, those new routes answer 500
-- revision_pins_unavailable and write nothing (the thumbnail route never falls
-- back to the ordinary object reads), and GET /api/pick/state says
-- revision_drafts: null (the feature is off). Every other route — project
-- list and detail, pick state, claim, save, submit, start-retouch, deliver,
-- undeliver, reopen, confirm, the old text 要求修改 (POST /api/pick/revision),
-- every pick link — keeps working as before.
--
-- Existing revision_requests rows get marks NULL, finals NULL and
-- message_auto 0: they read as the old text requests they are.
--
-- The three ALTERs are not safe to re-run: a second run fails with
-- "duplicate column name: marks" (or finals, message_auto), which means it
-- already ran and can be ignored. The CREATE TABLE is IF NOT EXISTS and can be
-- re-run.

-- 1) the frozen pins of one round: JSON {photo_key: [{x,y,note}]}, only the
--    photos that have pins. NULL = an old text request
ALTER TABLE revision_requests ADD COLUMN marks TEXT;

-- 2) the finals the round was sent on (projects.final_folders as it was).
--    NULL = an old text request
ALTER TABLE revision_requests ADD COLUMN finals TEXT;

-- 3) 1 = message is the Worker's fixed text (the guest wrote no overall note)
ALTER TABLE revision_requests ADD COLUMN message_auto INTEGER NOT NULL DEFAULT 0;

-- 4) draft pins on the current finals, one row per photo, bound to the
--    delivery they were made on
CREATE TABLE IF NOT EXISTS revision_pins (
  project_id      TEXT NOT NULL,
  photo_key       TEXT NOT NULL,
  marks           TEXT NOT NULL,
  delivery_at     TEXT NOT NULL,
  delivery_finals TEXT NOT NULL,
  updated_by      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (project_id, photo_key)
);
