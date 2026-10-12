-- The photographer's own default text for the message sent with a project
-- link at the later stages (admin.html 「複製連結」, edited in the studio
-- settings): 已送出 (link_message_submitted), 已交件 (link_message_delivered),
-- 已完成 (link_message_done). The 選片中 one stays pick_link_message
-- (2026-10-10-pick-link-message.sql).
-- Paste into the D1 Console for imagepicker-db before merging the Worker
-- that reads and writes them. THREE statements: run them one by one.
--
-- Until they have run, GET /api/admin/settings says null for each (the page
-- uses its built-in text), and a settings PUT naming any of them answers 500
-- link_messages_unavailable and writes nothing (the other fields in that body
-- included). Every other route, settings PUTs without them included, keeps
-- working as before.
--
-- Not safe to re-run: a statement run a second time fails with
-- "duplicate column name: link_message_…", which means that one already
-- ran and can be ignored; run the ones that did not.

-- each at most 1000 characters, line breaks and tabs kept; NULL = the
-- built-in text. Admin-only: no guest route returns them.
ALTER TABLE studio_settings ADD COLUMN link_message_submitted TEXT;
ALTER TABLE studio_settings ADD COLUMN link_message_delivered TEXT;
ALTER TABLE studio_settings ADD COLUMN link_message_done TEXT;
