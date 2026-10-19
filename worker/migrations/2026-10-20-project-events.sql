-- Project activity log (進度 history), docs/delivery.md "Activity log".
-- Paste into the D1 Console for imagepicker-db before merging the Worker that
-- writes it. Two statements, one per line, run them one by one, in order.
--
-- A new table only, no ALTER. Until it exists every action (交件, 改交, 取消交件,
-- 開放修改, 開始精修, 確認完成) works exactly as before and simply logs nothing;
-- GET /api/admin/projects/:id/events answers {events: []} and the project page
-- shows its 進度 as before. Events from before the migration do not exist: the
-- page still derives those steps from the project's columns.
--
-- Safe to re-run (IF NOT EXISTS).

-- project_events: one row per action, appended after the action's own write (best-effort: a failure here never fails the action). Never updated or deleted. at = ISO time of the action. kind = 'deliver' (data {final_folders, and repeat: true + previous: [...] when it replaced a delivered set}) | 'undeliver' (data {final_folders} taken down) | 'reopen' (data {from_phase, was_delivered}) | 'retouch' (data NULL) | 'confirm' (data NULL). actor = 'photographer' | 'client'. data never holds a name, token or key
CREATE TABLE IF NOT EXISTS project_events (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, data TEXT);

CREATE INDEX IF NOT EXISTS idx_project_events_project ON project_events(project_id, at);
