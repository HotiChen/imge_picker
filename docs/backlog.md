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
1. ✅ Back-office shell: side menu, dashboard (projects by phase, per month,
   to-do), add a 已交付 phase so "completed" can be counted.
2. Photographer accounts with real login (replaces the shared
   PHOTOGRAPHER_TOKEN). Record `referred_by` on each account from day one.
   Registration stays closed until a second photographer joins; then add
   cross-account isolation tests.
3. ✅ Settings: studio name, logo, default plan (張數, 加挑單價).
   Logo must NOT live in the `imagepicker` bucket (180-day lifecycle).
   Guest page shows the studio brand + a booking link.
4. Products and sales: catalogue (cost, price), orders per project. First
   version: orders recorded by hand, no payment gateway. Design draft:
   `docs/products-orders.md` (phases A admin / B guest shop / C payments).
5. Referral payouts (single level only — never multi-level): A earns a share
   of B's sales, paid out of the platform's cut, time-limited (e.g. 12 months).
   Needs payments through the platform first; check tax/legal before launch.
6. Operator console (Tim as the SaaS operator, separate from any
   photographer's back office): photographers registered / active, clients,
   vendors; GMV this month, photographers with sales, top sellers, projects
   created or updated per photographer. Needs item 2 first (with one
   photographer every number is Tim's own). Own auth role — never the
   photographer token. Aggregates by default; no client personal data unless
   needed (個資法). Vendors = see "Vendor jobs" below.
7. Landing page (for photographers once multi-photographer is real).

## Vendor jobs (discussed 2026-09-29, not scheduled)
Vendors (廠商) are outside businesses doing work on an order: print labs
(相本書, 無框畫) and layout designers (婚紗廠商 排版). Flow: order line →
job sent to a vendor → vendor downloads exactly those photos → (layout) uploads
a proof → photographer / client approves → printed → shipped (tracking no.).
- v1: no vendor account. A job link per job, reusing share-token machinery
  (new kind, photo-key snapshot, revocable, expiring), like pick links. Works
  before photographer accounts.
- v2: vendor accounts, a vendor sees jobs from many photographers; vendor
  directory on the platform (possible second revenue side).
- Cost on the order line = the vendor's price → payable per vendor per month.
- Proofs uploaded to R2 fall under the 180-day lifecycle — fine for proofs,
  not for anything kept long-term.
- Open: how Tim sends jobs today (LINE + Drive?); does the client approve a
  layout proof, or only the photographer?

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
- Custom (non-platform) products for photographers — built, off by
  `CUSTOM_PRODUCTS`; ideas: invite a photographer's own print lab onto the
  platform as a vendor (keeps the 15% margin fee); a paid plan allowing their
  own lab (fee on sale price or monthly, since a self-declared cost can be gamed).
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
