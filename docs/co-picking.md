# Co-picking (協作者) — design, decided 2026-10-11

Tim's decisions, all agreed on 2026-10-11:

- The seat holder (主人) can invite people to pick with them. It also covers the owner moving to another
  device: the owner joins as a collaborator under their own name on the computer.
- Invitation = an **8-digit code** shown on the owner's phone. The person opens the same pick link, enters the
  code and **their name**, and is a collaborator.
- A code is valid **1 hour** and works for **one person, once**. A second person needs a second code.
- At most **2 collaborators** per project (the owner is not counted), raisable per project later.
- The owner sees every collaborator: **name, joined at (date and time, Taipei), valid until**, and can **remove**
  one at any time (effective on that person's very next request) and **change the period**.
- The period is chosen by the owner when inviting: **今天 (1 day) / 一週 (7 days) / 到專案結束 (no end)**.
- **The owner has the last word.** Only the owner can submit, invite, remove and change periods, and the owner can
  un-heart or edit anything a collaborator did.
- A collaborator can heart, write notes and pin photos. A collaborator can change or un-heart **only what they
  last wrote themselves**; a row the owner last wrote (or another collaborator) is not theirs to change.
- A collaborator **sees the owner's notes** (today only the seat holder does).
- A removed collaborator's hearts stay: the selection belongs to the project, and the owner can un-heart any of them.
- The **photographer sees who picked each photo** (主人 / 協作者名) in the project view, and the collaborator list.
- 重設主人 (reset seat) ends **all** collaborators at once.
- Not in this build: a colour per person, notifications, collaborators inviting others, per-collaborator caps.

## Renewal and slots — decided 2026-10-11 ("全部開始")

Tim asked: can another person be invited when one expires, and can the expired one ask to continue. He confirmed the proposal below and
asked to build everything. It is part of batch 1 (the `renewal_requested_at` column, the two renewal routes, `pending_renewals`).

- **An expired or removed collaborator no longer counts toward the limit of 2**, so the owner can invite someone else at once (a new code).
  One counting rule everywhere: slots in use = **active collaborators + unspent, unexpired invites**; an invite or a renewal is refused when
  that already comes to 2.
- **Renewal:** a collaborator whose period has **expired** (not one the owner removed) sees 「期限已到，要繼續嗎？」 with a button 「我要繼續」.
  It sends the owner a request; the owner sees it as a badge and a banner in the page (「Bob 要求續期」) and picks 「同意：今天 / 一週 / 到專案結束」 or
  「不同意」. Approving sets the new period from that moment. One pending request per person. A removed collaborator cannot ask.
- The owner's page checks for new requests while it is open and visible (every 30 seconds) and shows a toast; no email or push in this build.

## Why a collaborator is "a picker row"

`pickers` already is "a person with a key" (`key_hash` = SHA-256 of the bearer key, per project) and
`selections.updated_by` already holds a picker id. So a collaborator is a `pickers` row plus a membership row;
attribution (`updated_by`) and key handling come for free, and the save gates only need "is this picker the
owner **or** an active collaborator of this owner".

A membership is valid only while `invited_by = projects.owner_picker_id`: when the photographer resets the seat
(`owner_picker_id` changes) every membership of the old owner stops working with **no extra write**.

## Data (hand-run migration `worker/migrations/2026-10-13-co-picking.sql`, append-only, 3 new tables, no ALTER)

```sql
CREATE TABLE IF NOT EXISTS pick_invites (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  code_hash  TEXT NOT NULL,          -- HMAC-SHA256(key = PHOTOGRAPHER_TOKEN, message = project_id + ':' + the 8 digits), hex; the code itself is never stored
  invited_by TEXT NOT NULL,          -- the owner's picker id when it was made
  window_days INTEGER,               -- the collaborator's period: 1, 7, or NULL = until the project ends
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,          -- created_at + 1 hour
  used_at    TEXT,                   -- set once, atomically, by the join that spends it
  used_by    TEXT                    -- the new picker id
);
CREATE INDEX IF NOT EXISTS idx_pick_invites_project ON pick_invites(project_id, created_at);

CREATE TABLE IF NOT EXISTS project_collaborators (
  picker_id  TEXT PRIMARY KEY,       -- pickers.id of this person
  project_id TEXT NOT NULL,
  invited_by TEXT NOT NULL,          -- the owner picker id that invited them; valid only while that is still the owner
  joined_at  TEXT NOT NULL,
  expires_at TEXT,                   -- NULL = until the project ends
  revoked_at TEXT,
  last_seen_at TEXT,
  renewal_requested_at TEXT          -- set by the person after expiry; cleared when the owner approves or declines
);
CREATE INDEX IF NOT EXISTS idx_project_collaborators_project ON project_collaborators(project_id, joined_at);

CREATE TABLE IF NOT EXISTS pick_join_failures (
  project_id TEXT NOT NULL,
  bucket     TEXT NOT NULL,          -- 'p' (the whole project) or 'n:<network>' (a /64 or IPv4)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pick_join_failures ON pick_join_failures(project_id, bucket, created_at);
```

Before the migration every co-picking route answers **500 `co_picking_unavailable`** and nothing else changes
(the same pattern as `photographers_unavailable`); reads of the state work, `collaborators` is `[]`.

## Who can do what

| | owner | collaborator (active) | viewer / expired / removed |
|---|---|---|---|
| read the state, photos | yes | yes | yes (as today) |
| see notes, pins | yes | **yes** | no |
| heart / note / pin | any photo, any row | new rows, and rows **they** last wrote | no |
| un-heart | any | only their own | no |
| submit (`/api/pick/submit`) | yes | **no, 403 `not_owner`** | no |
| invite / list / change period / remove | yes | **no, 403** | no |
| join with a code | n/a | n/a | yes, once per code |

"Rows they last wrote" = `selections.updated_by = <their picker id>`. The rule is **per row (one photo), not per field**: the row's author
is whoever wrote it last, whatever they changed. Consequence, on purpose and visible in the UI through `by`: if the owner edits only
the note on a photo a collaborator hearted, the row becomes the owner's and the collaborator can no longer un-heart it (they get
`not_yours`); the owner can always change it back, and the owner has the last word anyway. A collaborator's write to a row last written
by someone else that would change its rating, note or pins is **refused for that item** (see the save contract);
re-sending the identical value is a no-op. This is enforced **inside the write statement** (not only in JS), like
every other gate, so a race with the owner cannot overwrite the owner's row.

The existing gates keep holding for everyone: phase open (picking / submitted), project not archived, key valid for
this project, photo key inside the link's folders, the ♥ cap (500), the row cap (1000), the pins cap (300), the plan
cap at submit. The caps are **per project**, shared by everyone.

## API (all behind the pick link `?t=`, the person's key in `X-Picker-Key`; JSON)

- `POST /api/pick/invites` — **owner only**. Body `{window_days: 1 | 7 | null}`. Makes an 8-digit code (random,
  `crypto.getRandomValues`, zero-padded), stores only its hash. Refused **409 `collaborator_limit`** when
  active collaborators + unspent unexpired invites ≥ `PICK_MAX_COLLABORATORS` (2). Answers `{code, expires_at, window_days}`.
  The code is shown once; it cannot be listed again.
- `POST /api/pick/join` — **no key needed** (a viewer). Body `{code, name}` (name 1–`PICK_NAME_MAX` chars, same rule as
  claim). Spends the invite **atomically** (`UPDATE … SET used_at … WHERE code_hash = ? AND used_at IS NULL AND expires_at > now`;
  one winner), inserts the picker row and the membership with `expires_at = now + window_days` (NULL stays NULL), and answers
  `{picker_key, picker_id, name, role: 'collaborator', expires_at}` once (the key is stored only as a hash).
  Wrong / used / expired code → **400 `invalid_code`** (one answer for all three, no oracle) and a row in `pick_join_failures`.
  More than **10 failures per project** or **5 per network** in 15 minutes → **429 `too_many_attempts`** (checked before the code is looked at).
  Refused **409 `owner_missing`** when the project has no owner (nobody to invite), **409 `retouching`** when the phase is not open (`pickRetouching`), and **401 `Unauthorized`** when the project is archived (the link is dead), the same answers the other pick routes give.
- `GET /api/pick/collaborators` — **owner only**. `[{picker_id, name, joined_at, expires_at, revoked_at, status: 'active'|'expired'|'removed', last_seen_at}]`
  plus the unspent invites' count and soonest expiry (no codes).
- `PATCH /api/pick/collaborators/:picker_id` — **owner only**. Body `{window_days: 1 | 7 | null}`; sets `expires_at` from **now**.
- `POST /api/pick/renewal` — the person's own key (an **expired** membership of the current owner, not removed). Sets `renewal_requested_at`
  (once; a second request is a no-op 200). Anyone else (active, removed, viewer, no key) gets 403. State shows an expired person
  `role: 'viewer'`, `my_status: 'expired'`, `can_request_renewal: true`, `renewal_requested: <bool>`.
- `POST /api/pick/collaborators/:picker_id/decision` — **owner only**. `{approve: true, window_days: 1 | 7 | null}` → new period from now
  (409 `collaborator_limit` when the OTHER active people plus the unspent, unexpired invites already come to 2), clears the request;
  `{approve: false}` → clears the request, stays expired.
- `GET /api/pick/collaborators` also returns `renewal_requested_at` per person and a `pending_renewals` count (the owner's badge and toast read it).
- `DELETE /api/pick/collaborators/:picker_id` — **owner only**. Sets `revoked_at`; the very next request from that key is a viewer's.
- `GET /api/pick/state` (existing) adds `role: 'owner' | 'collaborator' | 'viewer'`, `is_owner` (true for the owner **only**, so every
  existing owner-only check in the page keeps meaning "may submit / invite"), `can_edit` (owner or active collaborator), and `my_expires_at`
  for a collaborator. `selections[].by` = `{id, name, role}` of who last wrote the row, for the owner and collaborators only. **A viewer gets no `by`
and no names**, exactly the `{photo_key, rating}` list a viewer gets today.
- `PUT /api/pick/selections` (existing): allowed for owner and active collaborator. For a collaborator, an item that would change a
  row last written by someone else is **skipped**, not applied, and the response is `{ok: true, rejected: [{photo_key, code: 'not_yours'}]}`
  (200, the rest of the batch applies) so the page can put those photos back as the server has them. All-or-nothing still holds for the
  caps and the gates.
- `POST /api/pick/submit` stays owner-only. `POST /api/pick/claim` unchanged (it takes the empty seat).
- Admin: `GET /api/admin/projects/:id` adds `collaborators` (same list, with picker names) and each selection's `by`;
  `reset-seat` needs no change (memberships die with `invited_by`).

## Security rules (an opus reviewer attacks all of these)

- Keys are stored as SHA-256 (they are 256-bit random). A code has only 10^8 values, so a plain or salted hash would fall to an
  offline guess in seconds if the table leaked: it is an **HMAC with a server secret** (`PHOTOGRAPHER_TOKEN`, already a secret in the
  Worker's environment), bound to the project id. A leaked table alone reveals no live code. The cost: rotating that token invalidates
  codes still within their hour, which is fine. The code is also single-use and expires in an hour.
- Spending an invite is one atomic conditional write; two people entering the same code: one wins, the other gets `invalid_code`.
- Guess limits as above; the lock is by project (distributed guessing) and by network; a lock never reveals whether a code exists.
- Every gate statement re-checks "owner or active collaborator" **inside the write** (like the seat check today): phase, archive,
  `revoked_at IS NULL`, `expires_at` null or in the future, `invited_by = projects.owner_picker_id`.
- A collaborator cannot reach any owner-only route, and cannot join, invite or remove through a key of someone else.
- Removing, expiry and reset-seat take effect on the **next request**, with no cache.
- The photographer's routes are unchanged in who can call them; the new fields are admin-only reads.

## Build order (each batch merges on its own)

1. **Worker + migration + tests** (opus, High): everything above, TDD, ~10+ mutants, then a security review.
2. **Owner's panel** (sonnet): 「邀請協作者」 (period choice, the code shown big with a copy button and the 1-hour countdown), the collaborator list
   (name, joined at, valid until, 移除, change period), the fake worker mirrors the contract.
3. **Join + collaborator mode** (sonnet): on a seat-taken link, 「我有邀請碼」 → code + name → collaborator; a banner 「你是協作者，有效到 …」;
   hearts/notes/pins work, 完成提交 and the invite panel are hidden; a `not_yours` photo is put back with a toast.
4. **Photographer's view** (sonnet): who picked each photo in the project view (list and grid), the collaborator list in the detail.
5. Later, if wanted: a colour and initial per person; a notification when someone joins.

## Not decided here

- Raising `PICK_MAX_COLLABORATORS` per project (a constant for now, like the other caps).
- Per-field authorship (see the row rule below): wanted only if real use shows the row rule is too blunt.
