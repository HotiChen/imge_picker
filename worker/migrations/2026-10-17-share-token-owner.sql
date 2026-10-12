-- Per-photographer studio tokens, batch 3 of docs/multi-photographer.md
-- (R2 / file isolation). Paste into the D1 Console for imagepicker-db BEFORE
-- merging the Worker that reads it. One statement.
--
-- share_tokens.photographer_id names whose files a project-less token reads:
-- a 'studio' token's minter. NULL is the default photographer (Tim), which is
-- what every existing row becomes — album links, client sessions and the
-- default's studio tokens — so nothing changes for them. A 'pick' link's
-- owner is always its project's photographer, never this column.
--
-- Until it has run: the default photographer mints, lists and revokes studio
-- tokens exactly as before; any other photographer's POST
-- /api/auth/studio-token, GET /api/shares/minted and POST
-- /api/shares/minted/revoke-all answer 500 share_owner_unavailable and write
-- nothing (only reachable while PHOTOGRAPHER_ROUTES is "on").
--
-- Not safe to re-run: a second run fails with "duplicate column name:
-- photographer_id", which means it already ran and can be ignored.

ALTER TABLE share_tokens ADD COLUMN photographer_id TEXT;
