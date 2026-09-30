# Iterative picking: submit-time cap, drafts, 傳送協作者 — design (proposed 2026-09-30)

> **Status (2026-09-30): PROPOSAL — not scheduled.** Two parts, with different
> standing. §1 (plan cap checked at submit, not at ♥) is needed and is the next
> thing to build, together with the draft-reliability fixes in §2. §3–§4b
> (傳送協作者 / 要回 / 回歸上一棒 / root-only submit / notifications) is a large
> design that no real client has asked for yet; it is kept for when one does.
> Open for discussion before building it: co-editing (everyone may heart, only
> the root submits, root can remove collaborators) is much simpler than moving a
> single seat, and root-only submit is what pulls in the return button and the
> notification machinery. See docs/backlog.md.
>
> **Tim (2026-09-30): collaborators are wanted, as co-picking.** Two people by
> default (a couple: the first person + one collaborator), raisable per project
> (`max_pickers`) for family portraits. Each person's hearts show in their own
> colour (with the first letter of their name, colour alone is not enough), a
> photo hearted by both counts once, both may add comments. Still to settle:
> who can remove a photo (proposal: the first person removes any, a collaborator
> only their own heart), who sees a collaborator's comments (proposal: the family
> only), and only the first person submits. To be re-designed as co-picking,
> replacing the seat-passing sections below.


Guests heart 100+ photos in a first round and narrow down over days, often
passing the link to a spouse (100 → 70 → 50). Three changes follow: the plan
cap moves from save to submit; the existing server-side draft is documented;
the seat holder can **send the picking right to one collaborator** (「傳送協作者」)
on, in an unlimited chain; a non-root holder can **return it** one step to
whoever sent it to them (「回歸上一棒」); only the chain's first holder (the
root) can **take it back** from anyone (「要回選擇權」). Builds on `docs/guest-picking.md` and
`docs/project-plan.md`; everything there not contradicted here still holds.

## Decisions

1. **♥ is limited only by the system caps** (`PICK_MAX_SELECTIONS` 500,
   `PICK_MAX_ROWS` 1000, `PICK_MARKS_TOTAL_MAX` 300). The plan cap
   `pick_limit + extra_max` (NULL in either = none) is enforced **at submit**,
   atomically, inside the submit batch. Over → 409 `pick_cap`, nothing written.
2. **Draft = the server.** Every ♥/note/pin is already saved (debounced 800 ms);
   the same browser keeps its picker key. No new draft mechanism.
3. **One seat, one holder at a time.** 「協作者」 is **not** co-editing: sending
   moves the picking right (♥, notes, pins) to the recipient; the sender becomes
   a viewer. All selections stay (they belong to the project).
4. **Only the root submits (Tim).** 完成提交 (`POST /api/pick/submit`) is the
   root's alone, server-enforced inside the submit batch: any other holder gets
   403 `not_root`, nothing written. Saving stays with whoever holds the seat. A
   non-root holder's primary button is 「回歸上一棒（還給 {name}）」 instead; they
   may return an over-cap list — the root trims before submitting. In
   `submitted`, a non-root holder may edit and return; only the root
   re-submits. A root alone (no handover) sees no change. After reset-seat the
   next claimer is the new root and gets the submit right; a root who lost their
   key → the photographer's reset-seat.
5. **Send**: the holder issues a one-time link (random, SHA-256 stored, 48 h,
   single use, one live per project). The recipient opens it, enters a name, and
   gets their own picker key (same machinery as claim).
6. **Take back (Tim, final)**: chains are unlimited (A→B→C→D…) and **only the
   root** — the first person who held the seat since the last reset — may take
   the seat back, from whoever holds it, in one tap, immediately, **no
   approval**. In A→B→C, A can; B cannot (B asks A or C to send it back).
   Before a link is redeemed, the current holder can 「取消傳送」 the link they
   issued (the seat never left).
7. **Return one step (Tim)**: a holder who is not the root and got the seat by
   a link can press 「回歸上一棒」 — one tap, no link, no approval — and the
   seat goes to **上一棒**, the picker who issued the link this holder redeemed.
   A→B→C→D: D returns to C, C to B, B to A. The root's 要回 stays separate.
8. **Unlimited, recorded.** Sends, returns and take-backs have no product
   limit and are all recorded; the photographer sees the history in the project
   detail. **No email** to guests or the photographer for seat moves (the
   submit email stays, and only the root submits). The only cap is an anti-spam safeguard of **20 seat
   moves per project per day**.
9. Allowed only in `picking` / `submitted` (like saves). `reset-seat` stays the
   final fallback: it frees the seat **and clears the root**; the next claimer
   starts a new chain as its root.
10. **Telling the next person (Tim: required)** without infrastructure we
   don't have: the sender/returner gets a one-tap prefilled message (Web Share
   sheet, LINE or copy) to send themselves; in-page banners and a title badge
   greet whoever opens the link. Email/push later behind one seam (§4b).

## 1. Submit-time plan cap

### Worker (exact)

`PUT /api/pick/selections` — remove:
- `withPlan`, `planFit` and the ` AND ${planFit}` term in `openFor`;
- in `refused()`: the `plan` columns, the `FROM projects WHERE id = ?1` suffix
  and the whole `pick_cap` branch. Order becomes `row_cap` → `marks_cap` (when
  stars fit) → `selection_cap`, as before the plan feature;
- the "A save may leave at most … (409 pick_cap)" comment at the plan constants.

`POST /api/pick/submit` — add, only when `hasField(project, 'extra_max')`:

```js
const planOk = `(p.pick_limit IS NULL OR p.extra_max IS NULL OR (SELECT COUNT(*) FROM (${picked})) <= p.pick_limit + p.extra_max)`;
```

appended to `fits` (`… AND ${planOk}`), so it gates all three statements
(INSERT, `UPDATE pickers`, `UPDATE projects`) — repeats included: a repeat over
a plan lowered since is refused too (open Q4). Counted from `selections` inside
the statement, against the project row inside the transaction, so a save or a
PATCH landing between the route's reads and the batch is seen.

**Root only** (when `hasField(project, 'root_picker_id')`): the route refuses
early, before reading the body, when `project.root_picker_id !== picker.id` →
**403** `{error: '只有最初的挑圖者可以送出，請按「回歸上一棒」還給對方', code:
'not_root'}`; and `AND p.root_picker_id = ?me` joins `open` in all three
statements, so it is atomic with the rest (the migration backfill guarantees
every held seat has a root). Before the handover migration: no root check (as
today).

Refusal order in `refused()`: seat 403 → `retouching` 409 → `not_root` 403 → **`pick_cap`** →
`marks_cap` → `submission_cap`. `pick_cap` is first because it is the one the
guest can fix. One extra read (`SELECT count, pick_limit, extra_max`) builds:

```json
{"error": "目前選了 120 張，最多可送出 50 張（方案 40 + 加選 10）。請先取消 70 張再送出",
 "code": "pick_cap", "count": 120, "max": 50, "over": 70, "limit": 40, "extra_max": 10}
```

`extra_max = 0`: 「…最多可送出 40 張（方案 40 張，不可加選）…」. Nothing written:
no row, no contact info, no phase change, no email, `modified_after_submit`
unchanged. Before the extra-max migration: no plan cap (as today).

`GET /api/pick/state` keeps `extra_max` / `max_picks`. `extraPickFee` needs no
change (a new submission's extra is now ≤ `extra_max`).

### Guest UI

- Counter: within the cap unchanged (「已選 42 / 40 張（最多可加選到 50）」,
  `.over` orange above `pick_limit`). Above `max_picks`: 「已選 120 張（上限 50 張，
  需減 70 張）」 in red (`.over-cap`, `--danger`).
- 完成提交 over the cap → new modal `#pickCapModal`: 「目前選了 120 張，最多可
  送出 50 張（方案 40 + 加選 10）。請先取消 70 張再送出」, one button 「回去刪減」 →
  close + `_setFilterMode('selected')`. Within the cap: the existing over-plan
  price modal, unchanged.
- A 409 `pick_cap` from submit (plan lowered after load): close the submit
  modal, take `limit`/`extra_max`/`max` from the body, re-render the counter,
  open `#pickCapModal` with the server's numbers.
- Only the root's bottom bar has 完成提交 (§4); a non-root holder's has
  「回歸上一棒」 and the counter still turns red over the cap (informational: 「已選
  120 張（上限 50 張，送出前需減 70 張）」).
- Remove: `atPickCap()` and its use in `js/app.js` `togglePickHeart`
  (lines ~880–885), `showPickCapMessage()`, and the `pick_cap` branch in
  `flush()`.

### Docs to update in the same package

`guest-picking.md`: the "Plan cap" bullet (save → submit); the PUT row loses
`pick_cap`; the submit row gains `pick_cap` (`{count, max, over, limit,
extra_max}`); rule 18. `project-plan.md`: "Extra-pick cap" and "Enforcement"
(save → submit, new body, new order); the ♥-at-cap toast text goes. Fields,
PATCH, settings, pre-migration behaviour stay.

## 2. Drafts (暫存) — what exists

- Each change is queued and sent after 800 ms (`queueUpsert` → `flush`); submit
  flushes first. Selections live in D1; reopening the link in the **same
  browser** restores everything (key in `localStorage["pick_key:<token>"]`).
- **Limit:** another browser/device (incl. LINE in-app browser vs Safari) has
  no key → viewer. Recovery: 傳送協作者 from the old browser, or the
  photographer's 重設主人 (picks kept).
- **Found gap:** `flush()` clears the queue before sending; on a network error
  the ♥ stays on screen but is not saved (only a toast). Also nothing flushes
  on `pagehide`, so closing within 800 ms drops the last tap.
- Worth it (small, WP3, open Q3): re-queue on network failure and retry; flush
  on `pagehide`/`visibilitychange:hidden` (`fetch` with `keepalive`); a quiet
  status in the bar: 「已自動儲存」 / 「儲存中…」 / 「未儲存，重試中」. No local
  draft copy.

## 3. 傳送協作者 and 要回選擇權

### Data model — `worker/migrations/2026-10-01-handover.sql`

Append-only; noted in `worker/schema.sql`. The ALTER and backfill run once
(a second run fails with "duplicate column name" = already done); the
`CREATE … IF NOT EXISTS` lines are safe to re-run.

```sql
-- the root of the current chain: set by a claim on a free seat, cleared by reset-seat
ALTER TABLE projects ADD COLUMN root_picker_id TEXT;
-- no handover existed before this, so every current holder is their chain's root
UPDATE projects SET root_picker_id = owner_picker_id WHERE owner_picker_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pick_handovers (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('handover','takeback','return')),
  root_picker_id TEXT NOT NULL,     -- the chain this event belongs to (projects.root_picker_id then)
  token_hash     TEXT,              -- SHA-256 of the one-time token; NULL for takeback/return
  from_picker_id TEXT NOT NULL,     -- the holder the seat left (handover: sender)
  to_picker_id   TEXT,              -- the holder it went to (handover: set on redeem)
  created_at     TEXT NOT NULL,
  expires_at     TEXT,              -- handover: created_at + 48 h
  redeemed_at    TEXT,              -- when the seat moved; takeback/return: = created_at
  cancelled_at   TEXT,
  cancel_reason  TEXT               -- 'cancelled' | 'replaced' | 'expired' | 'takeback' | 'returned'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_handovers_token ON pick_handovers(token_hash);
CREATE INDEX IF NOT EXISTS idx_handovers_project ON pick_handovers(project_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_handovers_live ON pick_handovers(project_id)
  WHERE kind = 'handover' AND redeemed_at IS NULL AND cancelled_at IS NULL;
```

**Why a column for the root, not derived from history.** Claims and resets
are not history rows, so "first row since the last reset" cannot be read back
reliably (a chain with no handover yet has no row at all, and a reset leaves no
trace). One column written by the two statements that already define a chain's
start and end is exact and atomic:
- claim: `UPDATE projects SET owner_picker_id = ?, root_picker_id = ? WHERE …
  owner_picker_id IS NULL …` (the existing single conditional statement);
- reset-seat: `SET owner_picker_id = NULL, root_picker_id = NULL`.
Nothing else writes it; send, redeem, return and take-back never change the
root. Each history row copies `root_picker_id`, so only the current chain's
rows are considered below. Before the migration the claim and reset
retry without the column (`withoutMissingColumn`).

**A known picker keeps their row.** A redeem whose `X-Picker-Key` already
resolves to a `pickers` row of this project (e.g. B getting it back, or the
root receiving a link) moves the seat to **that** row — no new row, no new key,
the `name` field ignored. So the root's key stays the root's proof. Only a
browser with no key of this project gets a new row and key.

Constants: `HANDOVER_TTL_MS = 48 h`, `SEAT_MOVES_PER_DAY = 20` (history rows
created per project per 24 h: link issues, returns, take-backs — a technical
safeguard against scripted spam, not a product limit; a family passing the
link around a few times a day stays well under it),
`HANDOVER_HISTORY_MAX = 50`.

Definitions used below (SQL fragments):
- **live(h)**: `h.kind='handover' AND h.token_hash=?hash AND h.project_id=?p AND
  h.redeemed_at IS NULL AND h.cancelled_at IS NULL AND h.expires_at > ?now AND
  h.created_at > ?now−48h` (the second term ignores a hand-edited expiry, like
  `shareCeiling`).
- **open(p)**: `p.id=?p AND p.phase IN ('picking','submitted') AND p.archived_at IS NULL`.
- **room**: `(SELECT COUNT(*) FROM pick_handovers WHERE project_id=?p AND
  created_at > ?now−24h) < 20`.
- **prev(x)** (上一棒 of holder x): `SELECT from_picker_id FROM pick_handovers
  WHERE project_id=?p AND root_picker_id = <current root> AND kind='handover'
  AND redeemed_at IS NOT NULL AND to_picker_id = x ORDER BY redeemed_at DESC,
  rowid DESC LIMIT 1` — the issuer of the latest link x redeemed in this chain.
  NULL after a fresh claim or a reset (new root; old rows belong to the old
  chain). The root never returns (refused before the lookup), even if they once
  redeemed a link. The target's `pickers` row and key stay valid, so no new key
  or link is needed. A link sent "backwards" (C sends to B) makes the latest
  row win: prev(B) = C.
- **chain** (for display): holder, prev(holder), prev(prev(holder))… up to the
  root or a name already listed (links sent backwards can loop), reversed —
  「A → B → C」; ≤ 10 names, a leading `…` beyond.
- **may take back**: `p.root_picker_id = ?me AND p.owner_picker_id = ?holder
  AND ?holder <> ?me`, where `?holder` is the holder id the route read just
  before. `?me` comes only from the request's key (`resolvePick` → `picker.id`),
  never from the body.

### API (all under `/api/pick`, pick token required: `resolvePick` first)

| Route | Auth | Body → answer |
|---|---|---|
| `POST /api/pick/handover` | holder | — → **201** `{handover_token, expires_at}` (token shown once, `no-store`). Batch: cancel any open handover of the project (`replaced`, or `expired` if past), INSERT the new one (`root_picker_id` copied from the project); both gated on `owner_picker_id = me`, open(p), room. At most one live link per project (the partial unique index backs it). |
| `POST /api/pick/handover/cancel` | holder | — → 200 `{ok, cancelled: 0\|1}` (取消傳送: the holder's own open link, `cancel_reason 'cancelled'`; gated on `owner_picker_id = me`) |
| `POST /api/pick/handover/peek` | link holder | `{token}` → 200 `{from_name, root_name, expires_at}`; else 410. Read-only. |
| `POST /api/pick/handover/redeem` | link holder, not the holder | `{token, name}` → 200 `{picker_key?, picker_id, owner}` (`picker_key` only when a new row was made) |
| `POST /api/pick/takeback` | the root only | `{}` → 200 `{ok, owner: rootName}` |
| `POST /api/pick/return` | the holder, not the root, with a prev | `{}` → 200 `{ok, owner: prevName}` |

Bodies read with `readJsonCapped` (4 KB). The token travels only in a POST body
(never a URL the server sees, never logged).

**Redeem batch** (one `DB.batch`, success = statement 2 changed a row). `?to`
= the caller's existing picker id, or a fresh id:
1. only for a fresh id: `INSERT INTO pickers (id, project_id, key_hash, name,
   created_at) SELECT … WHERE EXISTS (SELECT 1 FROM pick_handovers h JOIN
   projects p ON p.id = h.project_id WHERE live(h) AND open(p) AND
   p.owner_picker_id = h.from_picker_id)`
2. `UPDATE projects SET owner_picker_id = ?to WHERE open AND owner_picker_id =
   (SELECT from_picker_id FROM pick_handovers h WHERE live(h)) AND ?to <>
   owner_picker_id AND EXISTS (SELECT 1 FROM pickers WHERE id = ?to AND
   project_id = ?p)`
3. `UPDATE pick_handovers SET redeemed_at = ?now, to_picker_id = ?to WHERE
   live AND EXISTS (SELECT 1 FROM projects WHERE id = ?p AND owner_picker_id = ?to)`

Every condition is on the rows inside the transaction: two redeems of one token
→ one wins; a reset-seat, a take-back or a newer issue landing first makes the
token dead (`owner ≠ from_picker_id` or `cancelled_at` set). A new key is made
like claim's (`newShareToken`, hash stored, returned once). The root is never
touched.

**Take-back** — the route reads the project; refuses early when `root_picker_id
≠ me` (403 `not_root`) or the root already holds the seat (409 `already_holder`);
then one batch with `?holder` = the holder it read (success = statement 3):
1. `INSERT INTO pick_handovers (kind 'takeback', root = me, from = ?holder,
   to = me, created_at = redeemed_at = now) SELECT … FROM projects p WHERE
   open(p) AND <may take back> AND room`
2. `UPDATE pick_handovers SET cancelled_at = now, cancel_reason = 'takeback'
   WHERE <open handover of the project> AND EXISTS (…same condition…)` — a link
   the holder had issued dies with the take-back.
3. `UPDATE projects SET owner_picker_id = ?me WHERE open AND <may take back>`

Because the UPDATE requires `owner_picker_id = ?holder` (the current holder's
id) **and** `root_picker_id = ?me`, a send/redeem or a reset-seat landing
between the read and the batch leaves it at 0 rows: nothing is written and the
route answers 409 `seat_moved` (the page re-fetches and the root may tap
again). Two take-backs at once → one row, one move.

**Return (回歸上一棒)** — the route checks `isOwner` (403 otherwise),
`me ≠ root` and reads `?prev` = prev(me) (either missing → 409
`{code: 'no_previous'}`); then one batch (success = statement 3):
1. `INSERT INTO pick_handovers (kind 'return', root = p.root_picker_id, from =
   me, to = ?prev, created_at = redeemed_at = now) SELECT … FROM projects p WHERE
   open(p) AND p.owner_picker_id = ?me AND p.root_picker_id = ?root AND
   prev(?me) = ?prev AND room`
2. cancel my open link (`cancel_reason 'returned'`) under the same condition.
3. `UPDATE projects SET owner_picker_id = ?prev WHERE open AND owner_picker_id =
   ?me AND root_picker_id = ?root AND EXISTS (SELECT 1 FROM pickers WHERE id =
   ?prev AND project_id = ?p)`
A take-back, send/redeem or reset landing first changes the owner or root → 0
rows → 409 `seat_moved`, nothing written. A return racing the holder's own
save/submit: both are gated on `owner = me`; whichever commits first stands,
the other is 403 (save) or lands before the seat moves.

**Previous holder lost their key** (changed phone): the return still moves the
seat to their row, and nobody can act until the root takes back or the
photographer resets. The server cannot know whether a key still exists, so the
confirm dialog warns (below) instead of blocking.

**Errors** (refusal re-read like `pickRefused`): archived mid-request → 401;
phase (incl. delivered) → 409 `retouching`; not the holder (issue/cancel) →
403; redeem by the current holder → 409 `self_handover`
(「這是你自己產生的連結，請傳給協作者」); unknown, used, cancelled, expired, other
project's, or issuer no longer holder → **410** `{code: 'handover_invalid',
error: '這個連結已失效，請對方重新傳送'}` (one answer for all); take-back by anyone
but the root (no key, forged or old key, previous senders) → 403 `not_root`;
submit by a non-root holder → 403 `not_root`; return by a non-holder → 403, by the root / with no 上一棒 → 409
`no_previous`, raced → 409 `seat_moved`; throttle → 429 `{code: 'seat_rate',
max: 20}`; bad name → 400 (claim's rule:
trimmed, 1–50 characters; recommend also refusing `PICK_KEY_CONTROL` in both
claim and redeem); migration not run → 500 `{code: 'handover_unavailable'}`
(needs a `no such table` test beside `isMissingColumn`).

**State** gains, for a request whose key matches a picker of the project:
`you: {name, is_root, lost_to_root, returned_by?, returned_to?, prev_name?}` —
`lost_to_root`: the chain's latest move is a take-back from me;
`returned_by`: its latest move is a return **to** me (name of who returned);
`returned_to`: a return **from** me; `prev_name`: only for the holder, their
上一棒 (drives the return button). Plus `root_name` and `chain: [names]`
(definition above). The holder also gets `handover:
{expires_at} | null` (their live link). A request with no key gets none of
these. Before the migration: `is_root: false`, `chain: []`, `handover: null`.

**Admin detail** gains `root` (picker id/name) and `seat_history` (≤ 50, newest
first): `{kind, root_name, from_name, to_name, created_at, expires_at,
redeemed_at, cancelled_at, cancel_reason, status}`, status ∈ `live | redeemed |
takeback | returned | cancelled | replaced | expired | void` (`void` = issuer no longer
holds the seat). `token_hash` is never selected. Missing table → `[]`.

**Root lost their key** (changed phone, cleared LINE browser): nobody can take
back; the photographer's 重設主人 is the fallback. It clears the root and frees
the seat, and **whoever claims first becomes the new root** — if the link sits
in a group chat, the wrong person may win that race. Admin copy on the reset
confirm: 「重設後，第一個輸入名字的人會成為新的挑圖者（也是唯一能要回的人）。請先
通知客人立刻重新打開連結。」 Selections are kept either way.

### What moves and what stays

- Selections, notes, pins, `modified_after_submit`, phase, submissions: untouched
  by send, redeem, return, take-back.
- **Notes/pins** are owner-only (`isOwner` in state): the new holder sees every
  note and pin; the old one, as viewer, sees none. The confirm copy says so.
- **`updated_by`** stays per row (who last wrote it); the admin table shows mixed
  names, which is the true history.
- **Submissions**: only the root submits, so `picker_id`, relationship and email
  are always the root's (per submit, as today). A chain's picks reach the
  photographer only through the root's 完成提交; a repeat rule is unchanged.
- **Email**: unchanged (submit only, names the root). Optional one-liner
  「本次經手：A → B → C」 from the chain (cheap, WP4). No email on seat moves.
- **In-flight edits**: a save/submit is gated on `owner_picker_id = me` inside
  its batch. Whichever commits first wins whole; the loser gets 403 and nothing
  is written (its queued ♥ is lost). The client flushes before issuing. On any
  403 from save/submit the page re-fetches state and shows the viewer banner.
- **Guest-shop order key**: separate per-browser key, unaffected.
- **Claim overlay**: shown only when the seat is free. A `#h=` link with a free
  seat is dead anyway (issuer lost the seat) → the ordinary claim overlay.
- **reset-seat**: one change — it also clears `root_picker_id` (same
  statement). Live links become `void`; the old root loses the take-back right;
  the next claim starts a new chain.
- **Claim**: also sets `root_picker_id` in its existing conditional UPDATE.

### Link shape and crawlers

`https://imhoti.tw/studio/index.html?t=<pick token>#h=<handover token>`.
The fragment is never sent to any server: LINE's preview crawler, proxies and
Worker logs never see it, and a GET consumes nothing anyway. The page reads
`location.hash`, removes it with `history.replaceState`, calls `peek`, and
redeems only on the explicit 「開始挑選」 POST. Tokens are 32 random bytes
(`newShareToken`), so no typed short code (it would need brute-force limits).
**Phone check:** LINE in-app browser keeps the fragment and `localStorage`.

## 4. Guest UI (phone-first, text via `textContent`)

**Bottom bar by role** (the one primary button, right of the counter):

| Who | Primary button | Also |
|---|---|---|
| Root holding the seat | 完成提交 (as today) | 傳送協作者 in the banner |
| Non-root holder | 回歸上一棒（還給 {prev}） — no 完成提交 in the DOM | 傳送協作者 in the banner |
| Viewer (incl. previous holders, root not holding) | none (bar off, as today) | banners below |

A non-root holder always has a 上一棒 (they got the seat by a link, or by a
return from someone who did); if state lacks `prev_name` (pre-migration) the
bar shows no primary button.

**Holder, idle** — banner button 「傳送協作者」 (secondary). Tap → flush, then dialog:

> **傳送協作者**
> 同一時間只有一個人能挑選。
> 傳送後，選擇權會交給對方：由對方按 ♥、寫備註，**你會變成只能查看**。
> 只有最初的挑圖者（{root}）能按「完成提交」送給攝影師。
> 你目前的 ♥、備註和標示都會留給對方繼續用。
> **只有最初的挑圖者（{root}）可以要回選擇權。**
> [取消] [產生連結]

When the holder **is** the root, the last line reads 「你是最初的挑圖者，之後隨時
可以按「要回選擇權」拿回來。」; otherwise 「你傳出去後就不能自己要回，只有最初的挑圖者
{root} 可以要回。」

**Link issued** — 「把連結傳給協作者（48 小時內有效，只能使用一次，只會顯示這一次）」
[傳送給對方] (share sheet with the prefilled text, §4b) [複製訊息]; then the banner reads 「已產生協作者連結，對方接手前你仍可挑選
（{到期時間}前有效）　[取消傳送]」. A new 傳送協作者 replaces the old link.

**Recipient** (`#h=`, peek ok):

> **{B} 請你接手挑選**
> 接手後由你挑選，{B} 會變成只能查看。選好後按「回歸上一棒」還給 {B}。
> 最後由最初的挑圖者 {A} 按「完成提交」送給攝影師；{A} 也隨時可以要回選擇權。
> [你的名字＿＿＿] [開始挑選]

A browser that already holds a key of this project (a previous holder getting
it back) sees no name field: 「{B} 把選擇權傳回給你」 [開始挑選]. 410 → 「這個連結
已失效，請對方重新傳送」, then the ordinary view. Success → a new key (if any)
stored under `pick_key:<t>`, state re-fetched.

**Root, not holding** — banner 「選擇權目前在 {C} 手上　[要回選擇權]」 and below it
the chain 「A → B → C」. Tap → 「要回後，{C} 會變成只能查看。確定要回選擇權？」
[取消] [要回]. 409 `seat_moved` → re-fetch, banner updates, tap again.

**Non-root previous sender** (B in A→B→C) — no take-back button:
「選擇權目前在 {C} 手上，你現在只能查看。想再挑選，請 {C} 選好後還給你，或傳送協作者給
你，或請最初的挑圖者 {A} 要回後再傳給你。」 (The first option only when B is
C's 上一棒.) plus the chain line.

**Non-root holder** — primary button 「回歸上一棒（還給 {prev}）」. Tap → dialog:

> **回歸上一棒**
> 把選擇權還給 {prev}？（目前已選 N 張）
> 還給後你會變成只能查看；{prev} 可以繼續挑選。
> 只有最初的挑圖者 {root} 能按「完成提交」送給攝影師。
> 你的 ♥、備註和標示都會留著。
> 如果 {prev} 已換手機或打不開連結，請改用「傳送協作者」傳給對方。
> [取消] [還給 {prev}]

(When {prev} is the root, the third and fourth lines merge: 「{prev} 可以繼續挑選，
或按「完成提交」送給攝影師。」) Over the cap adds 「目前超過上限 {over} 張，{root}
送出前需要刪減。」 On success: the share sheet opens with the return message
(§4b), then the returner's banner 「選擇權已回到 {prev} 手上，你現在只能查看」;
409 `seat_moved` → re-fetch. A holder may return or send onward; both are
recorded. A 403 `not_root` on submit (stale page) → re-fetch state, bar
switches to 回歸上一棒.

**Previous holder after a return** (`returned_by`) — root: 「{name} 已把選擇權還給
你（已選 N 張，上限 M 張），可以繼續挑選或按「完成提交」送出」; non-root: 「{name}
已把選擇權還給你，可以繼續挑選，選好後按「回歸上一棒」」. Dismissible; gone once
the seat moves again.

**Root holding, general line** — 「你是最初的挑圖者：已選 N 張，上限 M 張」
(over: 「…需減 X 張才能送出」); no limit: 「你是最初的挑圖者：已選 N 張」.

**Holder whose seat was taken back** (`lost_to_root`, on load or after a 403
on save/submit) — 「選擇權已被 {A} 要回，你現在只能查看」. Unsaved ♥ from the
moment of the take-back are gone (the 403 save wrote nothing).

**Cap over** — see §1.

### 4b. Letting the next person know

Constraints: no LINE messaging API; `send_email` on the free plan reaches only
addresses verified in Email Routing (the photographer's), so no guest email;
web push needs an installed PWA on iOS and does not work in LINE's browser.
So v1 is zero-infrastructure:

1. **Prefilled message, one tap.** After 產生連結, after 回歸上一棒, and
   (optional) after 要回, the page calls `navigator.share({text})`; without Web
   Share it shows the text with 「複製訊息」 and 「用 LINE 傳送」
   (`https://line.me/R/share?text=` + `encodeURIComponent(text)`). The guest
   picks the chat and sends it themselves.
   - Send: 「{我的名字} 請你接手挑選「{專案}」的照片。打開連結、輸入名字就能開始（48 小時內有效）：{pickUrl}#h={token}」
   - Return: 「我選好了（已選 N 張），選擇權還給你了。請打開連結繼續挑選{prevIsRoot ? '或按「完成提交」' : ''}：{pickUrl}」
   - Take-back (optional): 「我把選擇權要回來了，謝謝你幫忙挑選：{pickUrl}」
   Built in JS: `pickUrl = location.origin + location.pathname + '?t=' +
   encodeURIComponent(token)`; names and title have control/line-separator
   characters stripped and are cut to 50 characters. The one-time `#h=` token
   appears **only** in the send message, never in a return or take-back
   message; nothing else secret is added (the pick link is one the sender
   already holds and the receiver already had).
2. **Banners** for whoever opens the link: the lines in §4 (root not holding,
   previous holder after a return, taken back, root's count/cap line).
3. **Badge.** When the seat is with you and the latest move put it there
   (`you.seat_event_id` from state, not yet acknowledged in
   `localStorage["seat_seen:<t>"]`, a per-viewer convenience), `document.title`
   gets 「● 輪到你了｜」 and a dot shows on the banner; cleared on the first save,
   submit or tap on the banner. The page re-fetches state on
   `visibilitychange → visible` (no polling timer), so a tab left open notices
   a return or take-back when it comes back to the front.
4. **Later (out of scope)**: every seat move is already one `pick_handovers`
   row inserted by a successful batch. The seam is a no-op `notifySeatMove(env,
   project, event)` called after those batches (like `sendPickNotification`
   after submit). Email later: optional `pickers.notify_email` (append-only
   ALTER), collected at redeem/claim, used once the account has a sender domain
   (Resend or paid Email Routing); throttled per project like the submit mail.
   Push later: a `push_subscriptions` table keyed by picker id, fed by the same
   hook. The photographer gets no seat-move notification (history only).

## 5. Photographer UI (`admin.html`)

Project detail, new section 「選擇權紀錄」 under 挑選人: first line 「最初的挑圖者：
王小美　目前：林小華」 and the chain, then events newest first:
「10/02 14:03 王小美 → 陳大明（傳送）」, 「10/03 09:10 王小美 要回選擇權（原：陳大明）」,
「10/03 11:20 陳大明 還給 王小美（回歸上一棒）」, 「10/03 09:00 陳大明 產生連結・10/05 09:00 到期」, cancelled/expired/void greyed;
events of earlier chains (before a reset) under 「重設前」. Names through
`escHtml`. No email, no admin actions (重設主人 is the lever; its confirm gets
the new-root warning above).

## 6. Security and abuse — the review must cover

1. Crawler/GET of the link (any UA) writes nothing; the token never appears in
   a URL the server receives.
2. Only the hash is stored; `token_hash` absent from every response; issue
   response `no-store`.
3. Double redeem, redeem racing redeem → exactly one holder, no stray `pickers`
   row.
4. Redeem racing reset-seat / take-back / a newer issue / archive / start-retouch
   → the later-gated write loses whole.
5. Token of project P on Q's link, revoked/expired/archived pick link → 410/401.
6. Expired by clock, hand-edited `expires_at` beyond 48 h → dead.
7. Viewer or stale key (before a reset, after sending, after being taken back)
   → issue/cancel/save/submit 403.
8. Take-back is the root's only: in A→B→C, A can, B and C cannot (403
   `not_root`); no key, a forged key, another project's key, the old root's key
   after a reset → 403. The root is taken only from the key (`picker.id`), never
   from the body. Nothing but claim and reset-seat writes `root_picker_id`
   (grep-level test); redeem, send and take-back leave it unchanged.
9. Take-back racing a save/submit by the holder → one wins whole; racing a send
   or a redeem → `owner_picker_id = ?holder` fails, 409 `seat_moved`, nothing
   written; racing a reset-seat → root cleared, nothing written; two take-backs
   → one move, one row. The holder's live link dies with the take-back.
10. Retouching/delivered/archived: issue, redeem, take-back refused (409/401),
    also when the phase moves between the read and the batch.
11. Chain spam / ping-pong (a script bouncing the seat by send+return or
    take-back): 21st seat move in 24 h → 429,
    nothing written — a safeguard only. Peek/redeem failures write nothing
    (per-IP limit via the Workers rate-limiting binding if the plan has it —
    verify; 256-bit tokens make guessing moot). Unbounded chains stay cheap:
    history ≤ 50 in admin, chain ≤ 10 in state.
12. A previous holder redeeming reuses their own row (no second row, no new
    key); the root redeeming keeps `root_picker_id` = their row, so their
    take-back still works afterwards.
13. Name: length, control characters, escaping in admin, email and banners.
14. Notes/pins visibility flips exactly at the seat move (state for old/new key).
15. A leaked live link = anyone can take the seat within 48 h: single use,
    cancel, take-back and reset-seat are the answers; copy says "only send to the
    person who will pick".
16. Return: only the holder (viewer, stale or forged key, another project's
    key → 403); the root or a holder with no 上一棒 (fresh claim, after reset) →
    409 `no_previous`; the target is always prev(me) from the table, never from
    the body; racing take-back / send / redeem / reset → 409 `seat_moved`,
    nothing written; racing its own save/submit → one wins whole;
    retouching/delivered/archived → 409/401; a return to a picker whose key is
    lost is recoverable by the root or reset-seat.
17. Known limit (same as claim): a redeem response lost in transit leaves the
    seat with a key nobody holds → the root takes back, or reset-seat.
    Root lost key → only reset-seat; the first claimer after it becomes root
    (race in a group chat; mitigated by the admin confirm copy).
18. Submit by any non-root holder (a B, C, D holding the seat; a forged or
    old key) → 403 `not_root`, nothing written (no row, no contact info, no
    phase change, no email); a reset between read and batch → refused; the root
    submits normally, including right after a return or take-back.
19. Prefilled messages never contain the `#h=` token except the send message,
    never the picker key; guest names in them cannot inject line breaks.

## 7. Regression risks

- Save-time cap is on this unmerged branch only (commits `d73174a`,
  `93761b8`): prod never had it, so removing it changes no live behaviour. The
  extra-max migration is still required before merge.
- Tests to rewrite: `worker/test/project-plan.test.mjs` "cap:"/"codes:" tests
  (~lines 405–669) → submit-time; the fake in `test/run.mjs` (~line 3793)
  returns `pick_cap` from submit, not save (fakes mirror real responses); the six
  "plan cap —" suites (~11892–12017). `pick-submit`, `pick-submission-bounds`,
  `pick-claim`, `pick-marks` must stay green unchanged.
- Refusal order in submit changes for projects hitting several limits at once.
- Handover before its migration: claim and reset-seat retry without
  `root_picker_id`; every existing route unchanged; new routes 500. Claim and
  reset-seat now write one more column: `pick-claim`, `pick-projects` and the
  admin reset suite must stay green, plus a test that reset clears the root.
- A cached old `pick.js` still pre-checks ♥ against the cap until the `?v=` bump.

## 8. Tests and tier

- WP1, WP4: **High** — TDD, ~10 mutants each, security review. New
  `worker/test/pick-handover.test.mjs` (real SQLite fake): every case in §6,
  plus root set by claim / cleared by reset / backfilled by the migration,
  chains A→B→C→A→D, the return chain A→B→C→D then D→C→B→A (each step, the
  root refusing with `no_previous`, then a fresh send from A), return after a
  take-back or reset, peek, history statuses, state fields (`is_root`, `chain`,
  `lost_to_root`, `returned_by`, `prev_name`, `seat_event_id`), pre-migration;
  submit by B/C/D → 403 `not_root` with nothing written (rows, pickers, phase,
  flag, email all unchanged), by A → 200, over-cap return then A's submit →
  `pick_cap`; `not_root` before `pick_cap` in the order. Mutants must
  include dropping each term of <may take back> and of the return gate. Submit cap: exact
  cap ok, +1 refused with body, repeats, racing save, lowered plan, NULLs, order
  vs `marks_cap`/`submission_cap`, nothing written.
- UI: **Normal** — suites for counter red text, cap modal → 已選 filter, 409 from
  submit, issue/cancel, recipient screen (new and returning picker), 410, root
  banner with button and chain, non-root banner **without** button (assert the
  button is absent from the DOM *and* that the root's is present), taken-back
  banner, return button only for a non-root holder with 上一棒 (absent for the
  root and viewers, present for D), return confirm, returner and receiver
  banners, bottom bar per role (root: 完成提交 present **and** 回歸上一棒
  absent; non-root holder: the reverse; viewer: neither), share text for send
  (contains `#h=`) and return (does not), copy fallback without Web Share,
  title badge set and cleared, 403 `not_root` → bar switches, 403 → viewer; assert
  positive cases (element present, in the right container, computed display).

## 9. Work packages

| # | Package | Size | Role / model | Files |
|---|---|---|---|---|
| WP1 | Submit-time cap (Worker) + doc edits | S | worker dev / opus | worker.js, project-plan.test.mjs, guest-picking.md, project-plan.md |
| WP2 | Cap UI: counter, `#pickCapModal`, remove pre-check | S | frontend / sonnet | pick.js, app.js, index.html, styles.css, run.mjs |
| WP3 | Draft: retry, `pagehide` flush, 已自動儲存 (if Q3 yes) | S | frontend / sonnet | pick.js, index.html, styles.css, run.mjs |
| WP4 | Handover + return + root take-back + root-only submit (Worker: `root_picker_id` in claim/reset, routes, state, admin detail; migration, schema) | M–L | worker dev / opus | worker.js, schema.sql, migrations/, new test file, pick-claim/pick-projects tests |
| WP5 | Security review of WP1 + WP4 (§6) | S | security / opus | read-only |
| WP6 | Guest UI: 傳送協作者, recipient, 回歸上一棒 + bottom bar per role, banners, share text, badge, 403 refresh | M | frontend / sonnet | pick.js, index.html, styles.css, run.mjs |
| WP7 | 選擇權紀錄 + reset-confirm copy in admin | S | frontend / sonnet | admin.html, run.mjs |
| WP8 | `?v=` bump, full suites | XS | mechanical / haiku | html files |

Contention: `worker.js` WP1 → WP4 in sequence. `pick.js`/`index.html`/
`styles.css` WP2 → WP3 → WP6 in sequence. `test/run.mjs` is shared by WP2, 3, 6,
7 — one agent at a time (WP7 appends after WP6). WP7 may run parallel to WP6 in
code if its suite is added last. Migration SQL goes to Tim before the WP4 merge.

## Open questions for Tim

1. Link valid 48 h, link only (no typed code) — OK?
2. Handovers are unlimited; the only cap is an anti-spam safeguard of 20 seat
   moves (傳送連結 + 回歸上一棒 + 要回) per project per day — OK, or count only
   redeemed moves (not links issued and never used)?
3. Build the small draft improvements (retry, 已自動儲存) now?
4. A repeat submit over a plan the photographer lowered after the last submit:
   refuse (recommended, the plan is authoritative) or let the repeat through?

(Decided: take-back needs no approval; only the root may take back; only the
root submits; notification v1 = prefilled message + banners + badge, no email.)
