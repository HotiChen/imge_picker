# Delivery (交件) — design (decided with Tim 2026-09-29)

Proofing and delivery are two different paths. Today a project only has
proofs: the guest picks from the project's folders, the photographer
retouches outside the system, and 已交付 (`delivered_at`) is just a stamp —
there is no place where the guest sees the finished photos. Tim needs the two
separated before he can run real shoots through the studio.

## Decisions

- **Same link.** The guest's pick link is also the delivery link. Before
  delivery it opens the picking view (proofs, as today). After delivery it
  opens the **delivery gallery**: the retouched photos only.
- **Finals live in their own folder(s)**, never under a proof folder (the
  pick view shows a folder's subfolders, so a finals folder inside a proof
  folder would leak during picking). Convention: `<shoot>/毛片/` and
  `<shoot>/精修/` side by side; the picker for final folders refuses a folder
  inside (or containing) a proof folder of the project.
- **Folder naming (decided with Tim 2026-10-04; frontend only, no Worker or
  schema change).** Creating a project names its folders; the photographer no
  longer picks them. R2 has no real folders (a folder is a key prefix), so
  "creating" one only decides the name — it exists once its first photo is
  uploaded. Names come from one place, `js/project-folders.js`:
  - project root `YYYYMMDD 專案名稱/` (the **shoot date**, which defaults to
    today and can be changed, one space, the name); the project `title` is the
    same string (editable later; **the folders are fixed once created**);
  - proofs `<root>/毛片/`, finals `<root>/精修/`, second version `精修二/`, then
    `精修三 … 精修十`, then Arabic numerals (`精修11`, `精修12`);
  - the name is cleaned: `/ \ ? # % * : | " < >`, control characters and
    invisible formatting characters are removed, runs of whitespace become one
    space, ends trimmed; it is cut so the root stays ≤ 176 characters (title ≤ 200,
    photo key ≤ 256 with room for `精修NN/` and a file name); empty after cleaning
    = no project.
  - `POST /api/admin/projects` is unchanged: `folders: ["<root>/毛片/"]`. The root
    is read back from that snapshot (parent of the first `…/毛片/` folder), so no
    new column. Older projects keep whatever folders their snapshot holds; one
    whose proofs are not in `…/毛片/` keeps the old ＋上傳精修 link
    (`<parent>/精修/`, unlocked, no listing).
  - Create form: 專案名稱 + 拍攝日期, a preview of the folder, and a non-blocking
    note from `GET /?list=<root>/毛片/` (admin token): "已有 N 張照片，會沿用"
    (re-creating a project over the same folder picks its photos up again);
    a failed listing never blocks the create.
  - Project page: 資料夾：`<root>/`; ＋上傳毛片 → `upload.html?folder=<root>/毛片/&project=<id>&lock=1`;
    ＋上傳精修 → the next version after the biggest `精修*` under `<root>/` (read
    from R2; never reuses a number, so it cannot overwrite a version). Until that
    listing is known, or if it fails, the link names no folder and does not lock.
    `lock=1` makes upload.html show the folder as fixed (no folder tree, no new
    folders); without `lock=1` the page is unchanged.
  - The 交件 chooser starts on the newest `精修*` when nothing was chosen before
    (last delivery's folders win; a delivered project is not touched).
- **Deliver** = the photographer picks the final folder(s) in the project
  detail and presses 「交件」. It stores the finals folder snapshot on the
  project and stamps `delivered_at` (today's rule stays: only from
  `retouching`). 「取消交件」 (the existing undeliver) takes the gallery down
  again and the link goes back to the picking view's read-only state. It
  only clears the stamp: the chosen final folders stay on the project and
  the admin page prefills the next 「交件」 with them (editable; nothing is
  sent until 交件 is pressed). 「退回挑片」 (reopen) does the same to a
  delivery — clears the stamp, keeps the folders — besides moving the phase
  back to picking (both changed 2026-10-04; they used to clear them).
- **Guests download full-resolution finals**, one photo at a time (download
  all as a zip is later: size limits). Through the Worker's token gate like
  every read; the r2.dev URL stays disabled.
- **After delivery, proofs are not shown.** The gallery is finals only.
- **Proof originals download — a per-project on/off switch**, default off,
  set by the photographer in the project detail. When on, the guest can
  download the full-resolution proof originals: while picking (a download
  button in preview) and after delivery (a secondary 「下載毛片原檔」 entry
  that lists the proofs for download only — no picking). When off, proofs
  are never served at full resolution to a guest (today's behaviour).
- Owner and viewers of the link see the same gallery; downloads are allowed
  for both (the link is what the photographer shared).
- The shop (guest add-ons, B) and the album chain later hang off the
  delivery gallery, not the picking view.

## Security (High tier: this changes what a link can read)

- A pick token's read scope becomes: proof folders while not delivered (as
  today); **final folders once delivered**; proof folders again (read-only,
  download-only) only if the switch is on. Nothing else, ever.
- Full-resolution reads are a separate check from thumbnails: finals only
  when delivered; proofs only when the switch is on.
- Archived projects and revoked links refuse everything, as today.
- The finals snapshot is taken from the project, never from a guest request;
  its folder rules mirror the existing `pickFolders` / `folderCovers` checks.

## Schema (append-only; Tim runs it in D1 before the merge)

```sql
ALTER TABLE projects ADD COLUMN final_folders TEXT;            -- JSON array, the last chosen finals (see below)
ALTER TABLE projects ADD COLUMN allow_proof_download INTEGER NOT NULL DEFAULT 0;
```

## Worker decisions (2026-09-30)

Migration: `worker/migrations/2026-09-30-delivery.sql` (the two ALTERs above).
Before it runs, deliver and the switch answer 500; the list, detail, reopen,
undeliver and every pick link keep working (not delivered, switch off).

**Admin** (photographer token only; another photographer's project is 404):

| Route | Body | Answer |
|---|---|---|
| `POST /api/admin/projects/:id/deliver` | `{final_folders: [...]}` | 200 `{ok, delivered_at, final_folders}` (canonical: trimmed, trailing `/`, deduped) |
| `POST /api/admin/projects/:id/undeliver` | — | 200 `{ok, delivered_at: null}`; clears only `delivered_at`, **keeps** `final_folders` |
| `PATCH /api/admin/projects/:id` | `{allow_proof_download: true\|false}` | 200 `{ok, allow_proof_download}` |

- Deliver checks, in order: 404; phase ≠ `retouching` → 409 `not_retouching`
  (with `phase`, before the body is read, as today); more than 20 folders →
  400 `too_many_final_folders` (`max: 20`); any folder that fails the
  `pickFolders` rules, is over 256 characters or has a control character, an
  empty list or a missing/non-JSON body → 400 `invalid_final_folders`; a
  folder equal to, inside or containing a proof folder (the project's
  `folders` or any of its pick links' snapshots) → 400
  `final_overlaps_proofs` with `folder`. A sibling that only shares the prefix
  (`毛片x/` next to `毛片/`) is fine.
- The snapshot and the stamp are one conditional `UPDATE` (gated on
  `phase = 'retouching'` and the proof folders read), so a reopen racing it
  wins (409, nothing written).
- **A repeat deliver while delivered replaces the finals** and keeps the
  first `delivered_at`. A deliver after undeliver or reopen replaces the kept
  finals and stamps a new `delivered_at` (the overlap check runs on the new
  body as always).
- **Reopen (退回挑片)** `POST /api/admin/projects/:id/reopen` → 200 `{ok,
  phase: 'picking'}`: phase back to `picking`, `modified_after_submit = 0`,
  `delivered_at = NULL`; **keeps** `final_folders`, like undeliver. 404 for
  an unknown or another photographer's project.
- **`final_folders` is not the delivered flag.** After undeliver or reopen a
  project is `delivered_at = NULL` with `final_folders` still set — a normal
  state.
  Delivered means `delivered_at` set **and** a valid snapshot (`pickFinals`);
  every guest read (pick state, listings, thumbnails, originals, downloads)
  goes through that check, so a kept snapshot is never readable through a
  link. Code (worker or page) must read delivery from `delivered_at`, never
  from `final_folders` being non-null.
- The PATCH body takes only that one boolean key; anything else (other keys,
  `1`, `"true"`, `null`, not an object) → 400 `invalid_body`.
- `GET /api/admin/projects` rows and `GET /api/admin/projects/:id`'s
  `project` carry `final_folders` (array: the last chosen finals, which may
  be there while not delivered — admin.html prefills the deliver picker with
  it; `null` when none was ever chosen), `delivered_at` (the delivery state)
  and `allow_proof_download` (boolean).

**Guest** — `GET /api/pick/state` adds (same for owner and viewers):

- `mode`: `'picking'` or `'delivered'`. Delivered = `delivered_at` set **and**
  a valid finals snapshot; a legacy stamp without one (delivered before this
  feature) stays `'picking'` (the read-only view, as before).
- `folders`: the proof folders the link can read now — as before while
  picking; `[]` once delivered unless the switch is on.
- `final_folders`: `[]` until delivered (also after undeliver or reopen,
  though the project keeps its snapshot). The page lists each folder (and its
  subfolders) with the usual `?list=<folder>&t=<token>`.
- `allow_proof_download` (boolean), `delivered_at` (`null` unless delivered).

**Reads through a pick link** (object route `/<key>?t=`, `?list=`):

- Preview scope (listing, `?w=N`, `_thumbs/...` keys): proofs while picking;
  finals once delivered, plus proofs when the switch is on.
- Originals (a request without `?w=`, or `?download=1`): finals only once
  delivered; proofs only while the switch is on. Otherwise **403
  `{code: 'original_not_allowed'}`**; outside the preview scope 401.
- **Found while building this:** before this change a pick link *did* get
  proof originals — any URL without `?w=`, and `?w=` fell back to the
  original when a photo had no thumbnail. Both are closed now: with the
  switch off, a proof with no thumbnail answers 404 in the picking view (it
  used to show the original). Photos uploaded without thumbnails need their
  thumbnails made (ping.html shows which) or the switch turned on.
- **Download:** `GET /<key>?download=1&t=<token>` serves the original
  (ignores `?w=`) with `Content-Disposition: attachment; filename="<ASCII
  fallback>"; filename*=UTF-8''<RFC 5987 name>`, and the object route's usual
  headers (ETag, Range, `Cache-Control: private`, `Vary`). A thumbnail key
  with `download=1` is 400. Works for the photographer and album links too.
- Guest save/submit after delivery: still 409 `retouching`. Archived,
  revoked and expired links: 401 for everything, finals included.

## Client confirmation and revision requests (decided 2026-10-04)

Publish ≠ Complete. 交件 (`delivered_at`) only puts the finals up; the guest
then either **confirms** (確認完成) or **asks for changes** (要求修改, a short
text). The photographer is emailed, uploads a 「精修二」 folder and presses
the existing 「更換精修」 (a repeat deliver), which is the second version.
Versions are folders: there is no version table.

**Decisions**

- Only the seat holder (owner) confirms or asks; viewers see the state but
  cannot write (403, as save/submit). Only while delivered — `pickReadScope`
  mode `'delivered'` (stamp **and** a readable finals snapshot); otherwise
  409 `not_delivered`. Archived, revoked and expired links: 401 as always.
- The gallery stays open while changes are asked for (the guest keeps seeing
  the current finals).
- Honest record: `client_confirmed_by` is `'guest'` or `'photographer'`. The
  photographer may mark it complete by hand (標記完成) when the guest never
  answers. **Nothing ever confirms on its own.**
- Clearing rules — a confirmation always belongs to the delivery that is up:
  - **every deliver** (the first, a repeat 更換精修, one after undeliver or
    reopen) clears the confirmation in the same `UPDATE` as the stamp and, in
    the same batch under the same gate, resolves every open request
    (`resolved_at = now`). A refused deliver (not retouching, a reopen racing
    it) changes neither.
  - **undeliver** and **reopen** clear the confirmation in the same statement
    that clears `delivered_at`; open requests stay open for the photographer
    (the next deliver resolves them).
  - **a confirmation** (guest or photographer) resolves the open requests in
    the same batch, so a confirmed project never has an open request (the
    guest may confirm after asking: "算了，這樣就好").
- A request after the confirmation: 409 `already_confirmed`. A repeat confirm
  is idempotent: 200 with the first stamp, nothing written, no email — also
  when the photographer confirmed first (`by` stays `'photographer'`).
- Limits: message trimmed, 1–1000 characters (characters, not UTF-16 units);
  line breaks kept (CRLF/CR → LF, tab → space), every other control or
  line-separator character (`PICK_KEY_CONTROL`, the set pin notes refuse) is
  **dropped**; ≤ 10 open and ≤ 50 in all per project (both checked inside the
  `INSERT`); body ≤ 16 KB (`PICK_SUBMIT_BODY_MAX`, streamed).
- Email (same binding and rules as the submit mail; never throttled — the
  caps bound it to ≤ 50 requests per project): on a request (subject
  `[要求修改] <title> — <name>`) and on the guest's first confirm (`[客人確認完成] …`).
  Subject on one line (control characters and the bidirectional marks /
  overrides / isolates U+200E, U+200F, U+202A–U+202E, U+2066–U+2069 → space,
  so a name cannot reorder how the subject reads); the guest's text only in
  the body — raw in the text part, HTML-escaped (`white-space:pre-wrap`) in the
  HTML part; a link to `https://imhoti.tw/studio/admin.html#project=<id>`. A
  mail that fails or is not configured never fails the request (background,
  caught). The photographer's 標記完成 sends nothing.

**States** (only while delivered; any deliver / undeliver / reopen goes back
to the top):

```
delivered ──guest 要求修改──▶ delivered + open request(s) ──更換精修──▶ delivered (new finals, requests resolved)
    │                                │
    └──確認完成 / 標記完成──▶ confirmed ◀─────┘ (resolves open requests)
confirmed ──要求修改──▶ 409 already_confirmed     confirmed ──更換精修 / 取消交件 / 退回挑片──▶ not confirmed
```

**API**

| Route | Auth | Body | Answer |
|---|---|---|---|
| `POST /api/pick/confirm` | pick token + key, owner | none or a JSON object (keys ignored) | 200 `{ok, confirmed_at}` (repeat: the first stamp); 401 dead link; 403 not the owner; 409 `not_delivered`; 400 `Invalid JSON` / `invalid_body` (not an object); 413 `too_large`; 500 `confirm_unavailable` |
| `POST /api/pick/revision` | pick token + key, owner | `{message}` | 200 `{ok, message (as stored), created_at}`; 401; 403; 409 `not_delivered` / `already_confirmed` / `revision_open_cap` (`max: 10`) / `revision_cap` (`max: 50`); 400 `invalid_message` (`max: 1000`) / `Invalid JSON` / `invalid_body`; 413 `too_large`; 500 `confirm_unavailable` |
| `POST /api/admin/projects/:id/confirm` | admin | — | 200 `{ok, client_confirmed_at, client_confirmed_by}` (repeat: the first stamp, whoever made it); 401; 404 unknown / other photographer; 409 `not_delivered` (no `delivered_at`); 500 `confirm_unavailable` |

Check order (guest): link (401) → seat (403) → delivered now (409, before the
body) → body (413 / 400) → message (400) → migration (500) → confirmed
(repeat 200 / 409) → the gated write; a write that changed nothing is re-read
to say why (401 archived, 403 seat moved, 409 not delivered, confirmed, then
the caps: open first).

- `GET /api/pick/state` adds `confirmed_at` (string|null) and
  `revision_open` (boolean) for owner and viewers alike, and
  `revision_message`: the latest **open** request's text **for the seat
  holder only** — a viewer (no key, a wrong key, another project's key, a key
  from before a seat reset) always gets `null`. The text is the guest's own
  words and may be about body or skin, so it follows the notes / pins rule
  (security review 2026-10-04). Outside delivered mode always `null / false /
  null`. Never `client_confirmed_by`, never the list.
- `GET /api/admin/projects` rows and `GET /api/admin/projects/:id`'s `project`
  add `client_confirmed_at`, `client_confirmed_by`, `open_revision_count`;
  the detail adds `revision_requests` (newest first, ≤ 50: `{id, message,
  created_at, resolved_at, picker_id, picker_name}`; `picker_name` null when
  the picker is gone). Guest text is raw in JSON: admin.html must escape it.
- Dashboard stats are unchanged: 已交付 still counts `delivered_at`;
  confirmation is a separate dimension.

**Concurrency.** Guest confirm = one batch: `UPDATE projects SET
client_confirmed_at … WHERE id, owner_picker_id = me, archived_at IS NULL,
phase = 'retouching', delivered_at IS NOT NULL, final_folders IS NOT NULL,
client_confirmed_at IS NULL` + resolve-open (gated on "confirmed"). A request
= one `INSERT … SELECT … WHERE` the same gate + not confirmed + both caps.
Deliver = one batch (stamp + clear, resolve under the same gate). Undeliver /
reopen clear stamp and confirmation in one statement. So no interleaving
leaves "confirmed with an open request" or "confirmed while `delivered_at` is
NULL".

**Schema** (`worker/migrations/2026-10-04-client-confirm.sql`, four statements,
run one by one in the D1 Console before the merge):

```sql
ALTER TABLE projects ADD COLUMN client_confirmed_at TEXT;   -- NULL = not confirmed
ALTER TABLE projects ADD COLUMN client_confirmed_by TEXT;   -- 'guest' | 'photographer'
CREATE TABLE IF NOT EXISTS revision_requests (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, picker_id TEXT,
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 1000),
  created_at TEXT NOT NULL, resolved_at TEXT);              -- resolved_at NULL = open
CREATE INDEX IF NOT EXISTS idx_revision_requests_project ON revision_requests(project_id, resolved_at);
```

**Before the migration** (or with only the ALTERs run): every existing route
works — list, detail, pick state (`null / false / null`), claim, save,
submit, start-retouch, deliver, undeliver, reopen, stats; the three new
routes answer 500 `confirm_unavailable` and write nothing.

**Revision pins (2026-10-06, supersedes "the text says which photo").** Per-photo
pins on the finals are now a revision request: drafts (`revision_pins`, bound to
the delivery) sent as one frozen round (a `revision_requests` row with `marks` /
`finals` / `message_auto`; only `resolved_at` is ever updated), at most one open
request at a time, history and a thumbnail-only route for the seat holder. The
same clearing rules above apply unchanged (a round is a `revision_requests`
row). Design, contract and migration: `docs/revision-pins.md` (§13 is what was
built). The text route `POST /api/pick/revision` stays for one version.

**Not done, on purpose** (CLAUDE.md "Decided not to do"): a limit on rounds,
a reply deadline, auto-complete on expiry (a client who did nothing must
never read as confirmed), a version table (versions
are folders). Also not done: emailing the guest when 精修二 is up; the stale
page case below.

**Known limits** (security review 2026-10-04, accepted for now):

- A guest whose page still shows version 1 can confirm after the photographer
  already put version 2 up (the confirm lands on what is up now). The
  mitigation is on the page and **not built yet**: pick.js should re-read
  `/api/pick/state` before sending a confirm and say so if `final_folders`
  changed. Binding the confirm to a version server-side would
  only catch a renamed folder, not new files uploaded over the same folder,
  so it is not done.
- Revision-request emails have no time throttle: flooding needs the owner's
  picker key, and the 50-per-project cap bounds it to 50 emails.

## The finish page as a web album (built 2026-10-04)

Only the delivered **finals** view (`mode === 'delivered'`, `view === 'finals'`)
changed; picking, a delivery taken back (finals kept, `delivered_at` null) and
the 下載毛片原檔 list keep the card grid and the sidebar. Files:
`js/finals-gallery.js` (new, one global `FinalsGallery`, loaded after
`album-preview.js`), `js/pick.js` (`_syncFinals`, `renderFinals`,
`_finalsChips`, `shareLink`), a three-line hook in `js/app.js`
`renderPhotoGrid`, a block of new `.fg-*` classes at the end of
`css/styles.css`. No `:root` change, no worker / migration change.

- **No cards in the DOM.** In the finals view `renderPhotoGrid` hands the photos
  (`app.filteredPhotos`, the order the page already had: the name sort, never
  re-sorted) to the gallery. `body.fg-mode` hides the sidebar, preview pane,
  guest bar and the old grid and lets the page scroll as a document.
- **Hero**: the first final in gallery order as the cover (`?w=` bucket for the
  hero width x DPR: 400 / 1200 / 1600, never the original; it stays when the
  guest switches folder), studio logo + name (the header's own data), the
  project title, 「N 張照片」 and 分享. The box has its final height before the
  picture arrives (dark placeholder, fade-in).
- **Justified rows**: every row one height, 6px gaps, target 320px (rows
  >= 1000px wide), 260px (>= 640px), 200px (phone). A row grows until it fits
  the width at or under the target, then keeps or drops its last photo, whichever
  is nearer the target. The last row is not stretched. Shapes come from the
  thumbnails (`naturalWidth / naturalHeight` on load, 3:2 until then); a new
  shape asks for a batched reflow (one animation frame, at most one per 120ms),
  so 300 photos cost a few layouts, not 300. The guest's place on the page is
  kept across a reflow. Resize reflows through a `ResizeObserver`; a width that
  keeps flipping (scrollbar) stops being listened to for 1.5s. The first 36
  tiles load eagerly, the rest lazily. Tile thumbnails ask 400 where that is
  enough for the tile (about 480px wide) and 1200 on a retina screen / phone.
- **Lightbox**: click a photo. ‹ ›, ← → Esc, swipe (a touch that starts within
  24px of a screen edge is ignored: the browser's back gesture, same as
  `album-preview.js`), `n / total`, the file name, 下載 (the same one-byte
  probe + `?download=1&t=` as the old card button), the 1200 / 1600 bucket for
  the screen, the neighbours preloaded. The page behind is locked
  (`html.fg-open`); closing gives the focus back to the tile of the photo the
  lightbox ended on. Listeners on `document` live only while it is open.
- **Folder chips** under the hero when there is more than one place to be: the
  finals folders, and (inside a folder with subfolders, or inside one) a chip per
  subfolder plus 「‹ 上一層」. A single finals folder without subfolders shows none.
- **確認完成 block** (`#deliveryDone`, all ids / text / flow unchanged) is a thin
  strip above the hero; the proofs entry bar only takes room when the switch is on.
- **相本預覽 entry** is the last thing on the page, right after the rows.
- **分享**: Web Share API with `{title, url}`; without it (or when it fails for a
  reason other than the guest cancelling) the link is copied (clipboard, else a
  temporary textarea + `execCommand('copy')`) and a toast says 已複製連結. The url
  is always `origin + pathname + ?t=<token>`: never `location.href`, never the
  owner key (that lives in localStorage and the `X-Picker-Key` header, not in a
  URL). Owner and viewers both have the button.
- Not done: download all, duplicate-photo hiding (a copy file in the folder
  shows like any other), a cover chosen by the photographer (needs a column).

## Out of scope for this step

Zip download of everything; watermarks; a second link just for delivery;
emailing the guest when delivered (can reuse the mail binding later);
long-term storage past 180 days (the 180-day countdown is still to do).
