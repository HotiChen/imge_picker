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
- [ ] Guests circle what to retouch (after the bottom-bar and edit-project work
      ships — all three touch the preview / pick.js). Today pick.js removes the
      drawing tools for guests (pick.js ~404-409) because annotations only live
      in that browser's localStorage (`r2_photo_picker_annotations`); the
      photographer never sees them. Needs: a D1 column/table for annotations
      (migration, hand-run first), guest save/load through `/api/pick/*` with
      the same gates as selections, the touch-drawing save bug fixed, coordinates
      stored relative to the photo (fractions of width/height) so phone and
      desktop agree, and the admin/project view showing them. High tier.

## Handoff (2026-09-28 session end) — start here
Two finished pieces of work, not yet on main:
1. **Guest bottom bar + submit overage + booking link** — merged into
   `claude/vigilant-edison-ewegwm` (merge 7b01260, from `claude/guest-bottom-bar`).
   Verified: its new suites fail on the old code, pass on the new. TODO before PR:
   bump `?v=` (20260928j → next), run the full browser + worker suites, open PR.
   - Phone bottom bar shows 已選 N / L (red when over), 完成提交 beside it; viewer sees none;
     header counter/完成挑圖 hidden on mobile pick mode; desktop unchanged.
   - Over the limit: no warning while picking; the submit modal shows the overage
     and fee (N × price, or 加挑費用請與攝影師確認) before sending.
   - 📅 預約拍攝 left the header; shown in the banner once submitted (https only).
2. **Edit a project after creation** (title / 張數 / 單價 / folders) — branch
   `claude/edit-project` (5bb3917), pushed, NOT merged. Security review done:
   no Critical/High. Fix before merging (TDD):
   - M1 (Medium, verified): hidden picks (in a removed folder) still count toward the
     500-star / 1000-row caps in the save route (worker.js ~1747-1757), and the guest
     can't delete them (403). Count only covered rows (`pickCoveredSql`) in the star cap;
     decide the row cap.
   - L1: resubmit email lists hidden picks under 移除 (pickDiff) — mark as 資料夾已移除 instead.
   - L2: pick.js flush() should undo + re-fetch state on 403, not only 409/400.
   - L4: cap pick_limit / extra_price (e.g. ≤ 1,000,000) in pickProjectFields.
   - Decide: photographer `?project=` view still shows hidden picks unmarked
     (js/project-view.js) — mark or exclude?
   - Prod checks: D1 with json_each/json_valid/substr(x,-1); no cache rule overriding
     `private` on photo responses.
   Then merge into the working branch, bump `?v=`, full suites, PR.
3. The commit-review hook fix (`.claude/settings.json`) is on main; it only takes
   effect in a new session.

## Ideas to design next (Tim, 2026-09-28)
- **Add a folder to a project after its link was sent** (e.g. a 精修 subfolder with
  the retouched photos): covered by the edit-project work above (adding a folder
  widens every live link at once); a subfolder of an existing project folder is
  already visible without any edit.
- **Retouch versions**: a guest picks photo A; the photographer uploads 精修 v1,
  the guest comments, v2, v3 … up to a maximum the photographer sets per project
  (e.g. 最多 4 版), shown to the guest ("第 2 / 4 版"). Needs design: how versions
  are stored (naming like `A_v2.jpg` or a `versions` table), the guest view
  (side-by-side / history), comments per version, the round counter and what
  happens at the limit (extra fee?). Probably pairs with "guests circle what to
  retouch" (Next up).
  Also: the guest can look back at earlier versions — "第 3 / 4 版" with ‹ ›
  between v1…vN, ideally a before/after compare (side by side or a drag
  divider). Comments must be tied to the version they were made on. Mind the
  180-day R2 lifecycle: old versions of a long project will be deleted.

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
- Phone preview: the orange tools toggle (`.mobile-tools-toggle`, fixed
  bottom-right, 52px) covers the bottom bar's ♥ on a 390px phone. Predates
  the zoom fix.
- Annotations drawn by touch are never saved: `stopDrawing` gets a TouchEvent
  with no `clientX`, so the end point is NaN.
- Annotation coordinates are fitted-photo pixels, so a circle drawn at one
  window size lands elsewhere at another. Fixing it changes the stored format
  (localStorage `r2_photo_picker_annotations`) — needs a migration.
- Minor: − / + zoom about the photo's top-left, not its centre; panning is
  unbounded.

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
