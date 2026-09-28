# Backlog

Decided or discussed, not yet built. Newest decisions at the top of each group.

## Next up
- [ ] Phone test of guest picking + gestures (and the new bright entrance) on real LINE / iOS Safari (Tim).
      Watch: LINE's edge swipe-back vs swipe-right, zoom feel.
- [ ] Email notifications — code and `wrangler.toml` binding ready (branch
      `claude/vigilant-edison-ewegwm`). Tim, before merging:
      1. Cloudflare → imhoti.tw → Email → Email Routing: enable (check MX first).
      2. Destination addresses: add and verify the photographer's inbox.
      3. `wrangler secret put PHOTOGRAPHER_EMAIL` (or Worker → Settings → Secret).
      4. Merge, submit a test pick, check inbox + spam; admin 未寄信 should clear.
      Sender is `notify@imhoti.tw` (`NOTIFY_FROM` var). Until then admin shows 未寄信.

## Product roadmap (agreed order)
1. Back-office shell: side menu, dashboard (projects by phase, per month,
   to-do), add a 已交付 phase so "completed" can be counted.
2. Photographer accounts with real login (replaces the shared
   PHOTOGRAPHER_TOKEN). Record `referred_by` on each account from day one.
   Registration stays closed until a second photographer joins; then add
   cross-account isolation tests.
3. Settings: studio name, logo, default plan (張數, 加挑單價).
   Logo must NOT live in the `imagepicker` bucket (180-day lifecycle).
   Guest page shows the studio brand + a booking link.
4. Products and sales: catalogue (cost, price), orders per project. First
   version: orders recorded by hand, no payment gateway.
5. Referral payouts (single level only — never multi-level): A earns a share
   of B's sales, paid out of the platform's cut, time-limited (e.g. 12 months).
   Needs payments through the platform first; check tax/legal before launch.
6. Landing page (for photographers once multi-photographer is real).

## Bugs
- Guest page hides subfolders. Project folder `A/` with `A/a/`, `A/b/`, `A/c/`:
  the guest sees none of a/b/c and cannot open them. The Worker allows them
  (prefix match); the page loses them. `js/pick.js` redraws after every load:
  `applyServerSelections` calls `renderPhotoGrid()` (pick.js:372), replacing
  the folder cards app.js drew for a photo-less folder, and
  `renderFolderPanel` (pick.js:415) lists only the project's own folders,
  replacing app.js's subfolder tree. Also: when `A/` has photos of its own,
  folder cards never show (app.js:136). Probably the same in the
  photographer project view (`project-view.js:287` clears currentFolders) —
  unverified. Workaround: list `A/a/`, `A/b/`, `A/c/` as the project folders.
  Planned fix: the 資料夾 panel shows subfolders nested under each project
  folder, all clickable; a photo-less folder opens its first subfolder.
  Check the ♥ 已選 filter still spans every folder. Test with real hit-testing.
- Preview zoom on a phone (Tim, real phone). Decided: double-tap while zoomed
  = back to fit (like iPhone Photos); double-tap at fit = ♥.
  1. Zoomed in, a double-tap does nothing: touchstart marks every touch as a
     pan when zoom > 1 (annotation.js:480) and touchend returns before tap
     detection (:521). Fix: a touch that barely moved is still a tap.
  2. No easy way back to fit: the ⟲ (`#zoomResetBtn`) exists in the bottom
     bar but is a 16px icon. Fix: double-tap resets (above) and a 44px ⟲.
     Swipe-to-navigate stays off while zoomed (one finger pans) — by design.
  3. Zooming is clipped to the fitted-photo box: the canvas is sized to the
     fitted image (annotation.js:197-216) and zoom draws inside it (:237),
     so the black bars never show the enlarged photo. Fix: canvas fills
     `.canvas-container`, image drawn centred inside it. Touches annotation
     coordinates — re-test the photographer's drawing tools.

## Deferred features
- Edit a project's 張數 / 加挑單價 after creation (today only set at create;
  no update route). Submissions snapshot both at submit, so an edit only
  affects later submits.
- Edit a project's folders after creation — same edit screen as 張數 / 單價.
  Folders are snapshotted on the project and on every pick share token
  (worker.js:1074, reissue copies the project at :1290), so an edit must
  update the live pick tokens too, or existing links keep the old scope.
  Decide what happens to picks in a removed folder (keep, but hide?).
  Security review: this widens what a live link can read.
- Make "no extra picks" explicit: today a blank 加挑單價 only hides the price —
  guests can still pick past the limit, nothing blocks. Add a choice
  (可加選 NT$__ / 不可加選) and cap picks at the limit for 不可加選.
- Logo route per photographer (`/api/studio/:pid/logo`); today it always
  serves the default studio — fine until a second photographer exists.
- Strip bidi / zero-width characters from `studio_name` (spoofing only; admin-set).
- Registered-owner invites (editor / viewer) for a project.
- Link a registered client account to a pick seat (`pickers.user_id`).
- Long-term storage for registered owners — needs a separate bucket.
- Storage usage tracking per photographer (limit by GB, not album count).
- Cap the number of photo keys listed in the change-notification email.

## Technical debt / security
- Browser E2E suite in CI (fix the flaky book_editor "no token is minted for
  an empty folder set" first).
- Password hashing: SHA-256 → PBKDF2 with legacy-hash compatibility.
- WAF rate limit on login / register.
- Upload: force Content-Type server-side, check magic bytes, 50MB per file.
- `notifyUrl` allowlist on book submit.
- Cloudflare Cache Rule `imhoti.tw/studio/*` → Bypass (removes the need to
  purge after every deploy).
- FLAGS: hide or finish. README sync.
- GitHub "Security and quality" shows 1 alert — look at it.
- Real D1 behaviour not yet proven in prod: `batch()` as a transaction under
  load, row/value size limits.
