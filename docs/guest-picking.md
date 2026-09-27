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
- **Every submit appends a row to `submissions`** and nothing ever updates or
  deletes one: the picker, relationship, email, the snapshot of photo keys
  with rating ≥ 1 (JSON, key order), the count, and `pick_limit` /
  `extra_price` as they stood — the record the fee is charged from. The
  snapshot is read inside the same conditional `INSERT`. `pickers` keeps only
  the latest relationship/email as contact info.
- Photographer is notified by **email** on submit (send function isolated so
  the transport can change: Cloudflare `send_email` now, Resend later). From
  the second submit on, the email lists the photo keys **added** and
  **removed** since the previous submission of the project (whoever made it),
  or says 與上次相同; every key is HTML-escaped.
- Invites (editor / viewer) require the owner to be registered. **Deferred**;
  the schema allows it.
- Holding the seat ≠ account-level ownership. Long-term storage and
  cross-photographer features need photographer approval. **Nothing reached
  through a link or a claim ever writes `role = 'owner'` in
  `project_members`.** Only an admin route may.
- The old registered-client + `users.folder_path` flow stays as is.

## Schema (migration not yet run in production; edited in place)

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
  modified_after_submit INTEGER NOT NULL DEFAULT 0 -- 1 = saved since last submit
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
  created_at   TEXT NOT NULL
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
| `GET /api/admin/projects` | admin | `{projects: [{id, title, phase, modified_after_submit, owner_name, created_at, submission_count, last_submitted_at, token}]}` newest first, this photographer only (`photographer_id = 'default'`), ≤ 200 rows, one SQL query; `owner_name` null when the seat is free; `token` is the newest live pick link (not revoked, not expired, inside the 180-day ceiling) or null |
| `GET /api/admin/projects/:id` | admin | project incl. `phase`, `modified_after_submit`; owner, pickers, selections with `updated_by`, tokens, `submissions` newest first (`photo_keys` parsed) |
| `POST /api/admin/projects/:id/reset-seat` | admin | free the seat (selections, phase, submissions kept) |
| `POST /api/admin/projects/:id/start-retouch` | admin | `submitted` → `retouching`; 409 `not_submitted` from `picking` |
| `POST /api/admin/projects/:id/reopen` | admin | `submitted`/`retouching` → `picking`, flag cleared |
| `GET /api/pick/state` | pick token (+ key) | owner name, am-I-owner, limit/price, selections, `phase`; owner also gets `modified_after_submit` and `submitted_at` (latest submission) |
| `POST /api/pick/claim` `{name}` | pick token | atomic claim → `picker_key` |
| `PUT /api/pick/selections` | token + key, owner only | batch upsert/delete; 409 `retouching`; raises the flag when `submitted` |
| `POST /api/pick/submit` `{relationship, email?}` | token + key, owner only | append `submissions` row, phase → `submitted`, email with diff; 409 `retouching` |

Admin routes check `isAdminToken` (the photographer token only; fails closed
when unset). Pick, client, session and studio tokens are refused.

## Rules the tests must pin

1. Only admin routes write `project_members.role = 'owner'`.
2. Every `photo_key` must fall inside the token's folder snapshot.
3. A key for project P is useless against project Q's token, and vice versa.
4. Revoked / expired token → claim, save, submit all refused.
5. Non-owner (no key, wrong key, key from before a reset) → save and submit refused.
6. Concurrent claims → exactly one owner.
7. Limits: name ≤ 50, email ≤ 254, note ≤ 500, relationship from the fixed list,
   ≤ 500 keys per save request.
8. Admin pages and the notification email escape every guest-supplied string.
9. `kind = 'pick'` tokens are refused by every route that isn't a pick route
   or a photo read inside their folders.
10. In `retouching` no guest write lands, even one racing a start-retouch;
    submissions are never rewritten; a save never emails.
