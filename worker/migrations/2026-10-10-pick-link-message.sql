-- The photographer's own default text for the message sent with a pick link
-- (admin.html 「複製連結」, edited in the studio settings).
-- Paste into the D1 Console for imagepicker-db once, before merging the
-- Worker that reads and writes it. One statement.
--
-- Until it has run, GET /api/admin/settings says pick_link_message: null (the
-- page uses its built-in text), and a settings PUT naming pick_link_message
-- answers 500 pick_link_message_unavailable and writes nothing. Every other
-- route, settings PUTs without the field included, keeps working as before.
--
-- Not safe to re-run: a second run fails with "duplicate column name:
-- pick_link_message", which means it already ran and can be ignored.

-- at most 1000 characters, line breaks kept; NULL = the built-in text.
-- Admin-only: no guest route returns it.
ALTER TABLE studio_settings ADD COLUMN pick_link_message TEXT;
