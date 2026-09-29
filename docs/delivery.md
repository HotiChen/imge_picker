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
  again and the link goes back to the picking view's read-only state.
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
ALTER TABLE projects ADD COLUMN final_folders TEXT;            -- JSON array, NULL = not delivered yet
ALTER TABLE projects ADD COLUMN allow_proof_download INTEGER NOT NULL DEFAULT 0;
```

## Out of scope for this step

Zip download of everything; watermarks; a second link just for delivery;
emailing the guest when delivered (can reuse the mail binding later);
long-term storage past 180 days (the 180-day countdown is still to do).
