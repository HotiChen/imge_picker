-- Delivery (docs/delivery.md). Paste into the D1 Console for imagepicker-db
-- once, after 2026-09-29-products-orders.sql and before deploying the Worker
-- that serves the delivery gallery. Until it runs, deliver and the proof
-- download switch answer 500; the project list, detail, reopen, undeliver and
-- every guest pick link keep working as before (not delivered, switch off).
--
-- Not safe to re-run: a second run fails with "duplicate column name:
-- final_folders" (or allow_proof_download), which means it already ran and
-- can be ignored.

ALTER TABLE projects ADD COLUMN final_folders TEXT;            -- JSON array, NULL = not delivered yet
ALTER TABLE projects ADD COLUMN allow_proof_download INTEGER NOT NULL DEFAULT 0;
