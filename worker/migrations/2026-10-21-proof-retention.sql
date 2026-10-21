-- Proof retention (毛片自動刪除), docs/delivery.md "Proof retention".
-- Paste into the D1 Console for imagepicker-db before merging the Worker that
-- reads them. Four statements, one per line: run them one by one, in order.
--
-- Until all four have run, nothing is ever deleted: the daily cron asks D1 for
-- due projects with a statement naming every column below, and a missing one
-- makes it stop before touching R2. The pages keep working: the project
-- detail says proof_retention.available = false, the guest's /api/pick/expiry
-- answers no date, and a write of the setting answers 500
-- proof_retention_unavailable (nothing stored).
--
-- After they run, still nothing is deleted until the photographer picks a
-- number: NULL here reads as 0 = never.
--
-- Not safe to re-run: a second run of a line fails with "duplicate column
-- name: …", which means that line already ran and can be ignored.

-- the studio's default: 0 / 90 / 180 / 365 days after the client's confirmation; NULL = 0 (never)
ALTER TABLE studio_settings ADD COLUMN proof_retention_days INTEGER;
-- the project's own number: NULL = the studio's, 0 = never, 14..3650 days
ALTER TABLE projects ADD COLUMN proof_retention_days INTEGER;
-- when the cron deleted this project's proofs; NULL = not deleted. Never cleared
ALTER TABLE projects ADD COLUMN proofs_deleted_at TEXT;
-- not before this time (ISO): a run's lease, a skip's 7-day wait, or the notice floor a new setting gives; NULL = no wait
ALTER TABLE projects ADD COLUMN proofs_delete_next_at TEXT;
