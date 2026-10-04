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

## Out of scope for this step

Zip download of everything; watermarks; a second link just for delivery;
emailing the guest when delivered (can reuse the mail binding later);
long-term storage past 180 days (the 180-day countdown is still to do).
