# Guest picking — design (locked 2026-09-27)

The photographer sends one LINE link per shoot. The first person who opens it
**and enters a name** takes the owner seat and picks; everyone else who opens
the same link can only look. Selections live on the server, not in the
browser. This replaces the fake `submitJob()` in `js/app.js`.

## Decisions

- One link per project; reuses share-token machinery (`kind = 'pick'`,
  revocable, expiring, folder snapshot at mint).
- Opening the link claims nothing (LINE's link-preview crawler opens it).
  Claiming needs `POST /api/pick/claim {name}`.
- The claim is atomic: `UPDATE ... WHERE owner_picker_id IS NULL`. Two claims
  in the same second: exactly one wins, the other gets 409 with the owner name.
- Before anyone claims, and for everyone who is not the owner, the link is
  view-only.
- The owner's browser remembers its picker key (localStorage). No personal
  link is shown. A browser switch loses the seat; recovery is **login** (if
  registered) or the **photographer resets** the seat in admin. Selections
  belong to the project, so a reset never loses picks.
- One selection list per project.
- Submit: relationship **required** (本人／伴侶／家人／朋友／其他), email
  **optional**. Email is contact info only, never an identity key.
- Over the plan's limit: warn, do not block —
  「方案 40 張精修，您已選 50 張，多 10 張，每張 NT$xxx 加挑費」.
- **Phases** (`projects.phase`): `picking` → `submitted` → `retouching`,
  default `picking`.
  - The owner saves in `picking` and `submitted`. A save while `submitted`
    sets `projects.modified_after_submit = 1` and sends **no** email.
  - Submit is allowed from `picking` or `submitted`: phase becomes
    `submitted`, `modified_after_submit = 0`, email sent.
  - In `retouching`, save and submit are refused with **409**
    `{code: 'retouching'}` — also for a malformed request; a non-owner still
    gets 403 first.
  - The seat and phase checks live **inside** the writes: a save (gate
    `UPDATE projects` + upsert + delete) and a submit (`INSERT submissions` +
    `UPDATE pickers` + `UPDATE projects`) each go as one D1 `batch()`
    (a transaction), every statement conditional on
    `owner_picker_id = me AND phase IN ('picking','submitted')`. A seat reset
    or start-retouch that lands after the route's reads still wins.
  - Only admin routes move the phase otherwise: `start-retouch`
    (`submitted` → `retouching`; from `picking` → 409 `not_submitted`; a
    second press is a no-op 200) and `reopen` (`submitted`/`retouching` →
    `picking`, clears `modified_after_submit`; already `picking` is a no-op 200).
    `start-retouch` keeps `modified_after_submit` so the photographer sees
    unsubmitted changes.
  - `reset-seat` keeps the phase and every submission.
- **Every submit that changed the picked set appends a row to `submissions`**
  and nothing ever rewrites or deletes one (only `notified` is set once):
  the picker, relationship, email, the snapshot of photo keys with rating ≥ 1 (JSON, key order), the count, and `pick_limit` /
  `extra_price` as they stood — the record the fee is charged from. The
  snapshot is read inside the same conditional `INSERT`. `pickers` keeps only
  the latest relationship/email as contact info.
- **Repeat submits are idempotent**: a submit whose picked-key set equals the
  **latest** submission's writes no row (checked inside the `INSERT`) and
  answers 200 with that latest submission (`submission_id`, `submitted_at`,
  `count`, `limit`, `price`, `over` — same shape as a new one). The rest of
  the submit still lands: contact info, phase → `submitted`,
  `modified_after_submit = 0`. If that latest row was never emailed, the
  repeat may email it (same throttle rules).
- **Submission cap**: `PICK_MAX_SUBMISSIONS = 50` rows per project (constant in
  `worker.js`), checked inside the gated `INSERT` together with seat and
  phase; the batch's `UPDATE`s require "a repeat, or under the cap", so a
  refused submit writes nothing. A changed submit at the cap → **409**
  `{error, code: 'submission_cap', max: 50}`; a repeat at the cap is still 200.
- Photographer is notified by **email** on submit (send function isolated so
  the transport can change: Cloudflare `send_email` now, Resend later). From
  the second email on, it lists the photo keys **added** and **removed** since
  the last submission the photographer was **emailed** about (whoever made
  it), so a later email carries everything they were not told; every key is
  HTML-escaped.
- **Email throttle**: at most one notification per project per 10 minutes
  (`projects.last_notified_at`, claimed by one conditional `UPDATE ... WHERE
  last_notified_at IS NULL OR last_notified_at <= now-10min`, so two racing
  submits send one), and none for a submit whose photo-key set equals the
  last **emailed** submission's (such a submit does not use up the slot).
  The claim is a compare-and-set on the value read just before it; if the send
  throws or reports failure (mail not configured), the slot is released with
  `UPDATE ... SET last_notified_at = <previous> WHERE last_notified_at = <mine>`,
  so a failed send never burns the window and never clobbers another claim. The
  submission row (subject to the repeat and cap rules above) is written
  regardless of the email; only the email is skipped.
  `submissions.notified` is 1 once its email was handed to the mailer (0 when
  throttled, unchanged, failed or mail not configured); admin shows
  `unnotified_submissions` = submissions newer than the last notified one
  (all of them if none), so a burst's last submit that was never mailed gets
  a badge.
- **Selection caps** (constants in `worker.js`, change them there only):
  `PICK_MAX_SELECTIONS = 500` starred rows (rating ≥ 1, what submit counts;
  un-starring = upsert rating 0 frees a slot) and `PICK_MAX_ROWS = 1000` rows
  of any rating per project. Checked inside every statement of the save batch
  against the state the save would leave (existing rows overwritten by the
  upserts, minus the deletes), so concurrent saves cannot pass it. A save that
  would exceed either → **409** `{code: 'selection_cap', max: 500}` or
  `{code: 'row_cap', max: 1000}`, nothing written. A project already over a cap
  (constant lowered) can still re-rate, un-star and delete — just not grow.
- **Notes are the owner's**: `/api/pick/state` returns `note` only to the
  current seat holder; everyone else gets `{photo_key, rating}` per selection.
  Admin sees notes.
- **Lost / leaked link**: `POST /api/admin/projects/:id/links` mints a new pick
  link (snapshot = `projects.folders`, 90-day expiry like creation); the old
  one is killed with the ordinary `POST /api/shares/:token/revoke`. Old and new
  links reach the same project and seat.
- **Archive and delete** (admin only, scoped to this photographer):
  - `POST /api/admin/projects/:id/archive` stamps `projects.archived_at` and
    revokes every live pick link of the project in the **same batch**
    (links already revoked keep their own `revoked_at`; the revoke is gated on
    the project being this photographer's). A second archive keeps the first
    stamp. Selections, pickers, submissions and the phase stay.
  - An archived project's links are refused **by project state as well**
    (`resolveShareToken` reads the project with `archived_at IS NULL`), so a
    link revived by hand or minted while archived opens no `/api/pick/*` route,
    no photo and no listing (401). Claim, save and submit also re-check
    `archived_at IS NULL` inside their writes, so an archive landing mid-write
    wins (401, nothing written).
  - `POST /api/admin/projects/:id/unarchive` clears the stamp. The links stay
    revoked; the photographer mints a new one with `.../links`.
  - `DELETE /api/admin/projects/:id` only for a project with **zero
    submissions** (otherwise 409 `has_submissions`; archive it instead).
    Deletes its selections, pickers, project_members, `kind = 'pick'`
    share_tokens and the project row in one batch, every statement gated on
    `NOT EXISTS (SELECT 1 FROM submissions WHERE project_id = ?)` (and on the
    project being this photographer's), so a submit racing the delete leaves
    everything in place and the route answers 409. R2 is never touched.
- Invites (editor / viewer) require the owner to be registered. **Deferred**;
  the schema allows it.
- Holding the seat ≠ account-level ownership. Long-term storage and
  cross-photographer features need photographer approval. **Nothing reached
  through a link or a claim ever writes `role = 'owner'` in
  `project_members`.** Only an admin route may.
- The old registered-client + `users.folder_path` flow stays as is.

## Schema

The guest-picking tables are in production
(`worker/migrations/2026-09-27-guest-picking.sql`). Later columns come in
their own migration files, run by hand in order:
`worker/migrations/2026-09-28-project-archive.sql` adds
`projects.archived_at` (run it **before** deploying the Worker that reads it:
until then the project list fails and pick links are refused; album links are
unaffected). `worker/migrations/2026-09-28-dashboard-settings.sql` adds
`projects.delivered_at` and `studio_settings` (`docs/dashboard-settings.md`).

```sql
CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL DEFAULT '',
  folders         TEXT NOT NULL,          -- JSON array
  pick_limit      INTEGER,                -- NULL = no limit
  extra_price     INTEGER,                -- NT$ per extra photo, NULL = not shown
  owner_picker_id TEXT,                   -- NULL = seat free
  created_at      TEXT NOT NULL,
  photographer_id TEXT NOT NULL DEFAULT 'default', -- set server-side, never from the body
  phase           TEXT NOT NULL DEFAULT 'picking'
                  CHECK (phase IN ('picking','submitted','retouching')),
  modified_after_submit INTEGER NOT NULL DEFAULT 0, -- 1 = saved since last submit
  last_notified_at TEXT,                  -- last notification email; NULL = never
  archived_at     TEXT,                   -- NULL = active (2026-09-28 migration)
  delivered_at    TEXT                    -- NULL = not delivered (dashboard migration)
);
CREATE TABLE IF NOT EXISTS pickers (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  key_hash     TEXT NOT NULL,             -- SHA-256 of the bearer key
  name         TEXT NOT NULL,
  relationship TEXT,
  email        TEXT,
  user_id      INTEGER,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS submissions (       -- append-only, one row per submit
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  picker_id    TEXT NOT NULL,
  relationship TEXT NOT NULL,
  email        TEXT,
  photo_keys   TEXT NOT NULL,             -- JSON array, rating >= 1, key order
  count        INTEGER NOT NULL,
  pick_limit   INTEGER,                   -- plan as it stood at submit
  extra_price  INTEGER,
  created_at   TEXT NOT NULL,
  notified     INTEGER NOT NULL DEFAULT 0 -- 1 = the photographer was emailed about it
);
CREATE INDEX IF NOT EXISTS idx_submissions_project ON submissions(project_id, created_at);
CREATE TABLE IF NOT EXISTS selections (
  project_id TEXT NOT NULL,
  photo_key  TEXT NOT NULL,
  rating     INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL,               -- picker id
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, photo_key)
);
CREATE TABLE IF NOT EXISTS project_members (   -- deferred feature, table now
  project_id  TEXT NOT NULL,
  user_id     INTEGER NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  approved_at TEXT,
  PRIMARY KEY (project_id, user_id)
);
ALTER TABLE share_tokens ADD COLUMN project_id TEXT;
```

## API

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/admin/projects` | admin | create project + mint pick link |
| `GET /api/admin/projects[?archived=1]` | admin | `{projects: [{id, title, phase, modified_after_submit, owner_name, created_at, archived_at, delivered_at, submission_count, last_submitted_at, unnotified_submissions, token}]}` newest first, this photographer only (`photographer_id = 'default'`), ≤ 200 rows, one SQL query; `owner_name` null when the seat is free; `token` is the newest live pick link (not revoked, not expired, inside the 180-day ceiling) or null. Archived projects are hidden; `?archived=1` returns only archived ones (any other value = default) |
| `GET /api/admin/projects/:id` | admin | project incl. `phase`, `modified_after_submit`, `last_notified_at`; owner, pickers, selections with `updated_by` and `note`, `tokens` (every pick link, newest first: `{token, created_at, expires_at, revoked_at, last_seen_at, status: 'live'\|'revoked'\|'expired'}`), `submissions` newest first, at most `PICK_MAX_SUBMISSIONS` (50) (`photo_keys` parsed, `notified` 0/1), `unnotified_submissions` |
| `POST /api/admin/projects/:id/links` | admin | mint a new pick link → 201 `{token, expires_at, created_at, status: 'live'}` |
| `POST /api/shares/:token/revoke` | admin | revoke any link, pick links included → `{ok: true}`; 404 if unknown or already revoked |
| `POST /api/admin/projects/:id/archive` | admin | stamp `archived_at` + revoke live pick links (one batch) → `{ok: true, archived_at, revoked}` (`revoked` = links revoked by this call; a repeat keeps the first stamp, `revoked: 0`); 404 unknown / other photographer |
| `POST /api/admin/projects/:id/unarchive` | admin | clear `archived_at` → `{ok: true, archived_at: null}` (links stay revoked); 404 |
| `DELETE /api/admin/projects/:id` | admin | delete a project with no submissions → `{ok: true}`; 409 `{error, code: 'has_submissions'}` (also when a submit races it); 404 |
| `POST /api/admin/projects/:id/reset-seat` | admin | free the seat (selections, phase, submissions kept) |
| `POST /api/admin/projects/:id/start-retouch` | admin | `submitted` → `retouching`; 409 `not_submitted` from `picking` |
| `POST /api/admin/projects/:id/reopen` | admin | `submitted`/`retouching` → `picking`, flag and `delivered_at` cleared |
| `POST /api/admin/projects/:id/deliver` / `undeliver` | admin | stamp / clear `delivered_at` (deliver only from `retouching`, else 409 `not_retouching`) — see `docs/dashboard-settings.md` |
| `GET /api/pick/state` | pick token (+ key) | owner name, am-I-owner, limit/price, selections, `phase`, `studio: {name, booking_url, has_logo}`; owner also gets `modified_after_submit`, `submitted_at` (latest submission) and each selection's `note` (viewers get `{photo_key, rating}` only) |
| `POST /api/pick/claim` `{name}` | pick token | atomic claim → `picker_key` |
| `PUT /api/pick/selections` | token + key, owner only | batch upsert/delete; 400 `invalid_photo_key`; 409 `retouching` / `selection_cap` / `row_cap`; raises the flag when `submitted` |
| `POST /api/pick/submit` `{relationship, email?}` | token + key, owner only | append `submissions` row (none for a repeat of the latest set: 200 with the latest), phase → `submitted`, email with diff (throttled, see above); 409 `retouching` / `submission_cap` |

Admin routes check `isAdminToken` (the photographer token only; fails closed
when unset). Pick, client, session and studio tokens are refused. Every
`/api/admin/projects/:id…` route also filters on `photographer_id =
DEFAULT_PHOTOGRAPHER_ID`: another photographer's project is 404 and untouched.

## Rules the tests must pin

1. Only admin routes write `project_members.role = 'owner'`.
2. Every `photo_key` must fall inside the token's folder snapshot.
3. A key for project P is useless against project Q's token, and vice versa.
4. Revoked / expired token → claim, save, submit all refused.
5. Non-owner (no key, wrong key, key from before a reset) → save and submit refused.
6. Concurrent claims → exactly one owner.
7. Limits: name ≤ 50, email ≤ 254, note ≤ 500, relationship from the fixed list,
   ≤ 500 keys per save request; `photo_key` ≤ 256 characters (not UTF-16
   units), no control characters (U+0000–U+001F, U+007F–U+009F, U+2028,
   U+2029), not ending in `/` → 400 `invalid_photo_key` (upserts and deletes);
   ≤ 500 starred / ≤ 1000 total selections per project, atomic.
8. Admin pages and the notification email escape every guest-supplied string.
9. `kind = 'pick'` tokens are refused by every route that isn't a pick route
   or a photo read inside their folders.
10. In `retouching` no guest write lands, even one racing a start-retouch;
    submissions are never rewritten; a save never emails.
11. At most one email per project per 10 minutes, none for an unchanged
    photo set; a failed send gives the slot back (only if still ours).
14. A repeat of the latest picked set adds no row; ≤ 50 submissions per
    project, atomic, 409 `submission_cap`; admin detail returns ≤ 50.
12. Notes reach only the seat holder and admin.
13. Admin project routes are scoped to this photographer's projects.
15. Archive revokes every live pick link in the same batch as the stamp; an
    archived project's links (even un-revoked by hand) open no pick route,
    photo or listing, and an archive racing a claim/save/submit wins. Unarchive
    leaves the links revoked. The list hides archived projects by default.
16. Delete only with zero submissions (409 `has_submissions`); every statement
    of its batch re-checks that, so a racing submit is never lost or orphaned;
    R2 is never touched.
