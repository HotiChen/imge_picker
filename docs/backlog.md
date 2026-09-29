# Backlog

Decided or discussed, not yet built. Newest decisions at the top of each group.

## Two-week plan (from the PM review, 2026-09-29)
No new big features until steps 1–3 have results.
1. Merge A + A2 + the switch and check them on prod (checklist below); do the
   phone test and the email setup in the same sitting.
2. Tim runs his own real shoots through it for two weeks: list 相本書 /
   無框畫, then pick → 加挑 → order → payment with real clients. Note what
   gets stuck and what nobody uses.
3. Interview 5+ photographers — `docs/photographer-interviews.md` (questions,
   log table, and what each answer decides).
4. Data duties before a second photographer: 180-day countdown (reuse the
   old picker's countdown in `js/app.js`), a reminder email N days before
   deletion, export picks + orders as CSV, D1 backup / restore drill
   (Time Travel), Worker error alerts. Decide the R2 retention (180 vs 365
   days) from the interviews first.
5. Minimum legal pages before outsiders use it: terms of service, privacy
   policy / 個資告知 (guest names, emails and photos pass through the
   platform). License of the repo is undecided (README).

Held until the interviews: guest shop B, photographer accounts, full operator
console, referral payouts, vendor v2.

## Next up
- [ ] Merge products & orders (A) + platform catalogue (A2) + the
      `CUSTOM_PRODUCTS` switch (branch `claude/lucid-cori-viif3w`). Tim, in order:
      1. D1 Console: `PRAGMA table_info(products)` must return nothing.
      2. Run `worker/migrations/2026-09-29-products-orders.sql`.
      3. `wrangler secret put OPERATOR_TOKEN` — `openssl rand -hex 32`, never
         the photographer's token.
      4. Merge, then Cloudflare → Caching → Purge Everything.
      5. Check: operator.html lists a 無框畫 with an image; settings 從平台加入
         adopts it (no 新增服務 button); an order + payment shows up in the
         dashboard and the operator sales table; start-retouch on an over-limit
         project creates the 加挑 order; pages on a phone.
- [ ] Phone test of guest picking + gestures (and the bright entrance) on real
      LINE / iOS Safari (Tim). Watch: LINE's edge swipe-back vs swipe-right, zoom feel.
- [ ] Email notifications — code and the `send_email` binding are on main.
      Tim: Cloudflare → Email Routing on (check MX first), verify the
      photographer's inbox as a destination, `wrangler secret put
      PHOTOGRAPHER_EMAIL`, then submit a test pick (inbox + spam); admin
      未寄信 should clear. Sender `notify@imhoti.tw` (`NOTIFY_FROM`).

## Product roadmap (order agreed 2026-09-29)
Done: back-office shell (dashboard, 已交付); studio settings (name, logo,
default plan); products & orders A and platform catalogue A2 — built, waiting
on the merge above. Design: `docs/products-orders.md`.

1. **180-day countdown.** Photos (and everything else in `imagepicker`) are
   deleted 180 days after upload. Show it: 「照片將於 X 月 X 日刪除」 on the
   project in admin and on the guest page. The platform is not the
   photographer's archive — they keep their originals.
2. **B — guest shop.** Platform products (photo, price) on the pick page;
   the guest orders, the photographer confirms, payment by transfer. The main
   selling point. Detailed design before building (outline in the products doc).
3. **Album chain.** Submit → auto-layout draft from the picks (`book_editor`
   already has auto_layout, a client viewer with approve, and a 300 dpi export)
   → guest checks and swaps photos on the phone → approve creates an album
   order → payment → print. Then smarter layout (ratings, face-aware crop,
   grouping by time/scene, near-duplicates).
   - **Keep the print files, not the originals:** at approval / send-to-print,
     upload each finished page JPG (one object per page — a whole-book zip of
     ~150–250 MB would hit the Worker's request size limit) to a **separate
     bucket with no lifecycle**, plus the layout JSON. A reprint of the same
     book then needs no originals (~NT$0.2 per book per month at R2 prices).
     Editing still needs the originals, so only within 180 days (or after the
     photographer re-uploads them — check that same folder + file names
     reconnect a layout).
   - Keep a human "send to print" click at first: a bad auto-layout printed
     costs real money. Print files are rendered in the browser today (too
     heavy for a phone), so the photographer's desktop renders them.
   - Warn when a crop is too low-resolution for its print size.
4. **Vendor jobs** — see below.
5. **Photographer accounts** with real login, replacing the shared
   PHOTOGRAPHER_TOKEN; referral code on sign-up, `referred_by` recorded from
   day one. Registration closed until a second photographer joins; then
   cross-account isolation tests.
6. **Operator console, full**: photographers registered / active, clients,
   vendors; GMV per month, photographers with sales, top sellers, projects per
   photographer. `operator.html` (A2) is the temporary start. Own auth role,
   never the photographer token. Aggregates by default; no client personal
   data unless needed (個資法).
7. **C — online payment** (ECPay / TapPay / LINE Pay), e-invoice, and the
   platform fee (15% of the list-price margin, rules in the products doc).
   Check tax/legal first.
8. **Referral payouts** — single level only, never multi-level (多層次傳銷
   law): A earns a share of the platform's fee on B's platform sales, for a
   limited time (e.g. 12 months). Paid out of the platform's cut, never B's.
   Per-sale amounts are small (margin 200 → fee 30 → e.g. 30% = 9), so it
   works by volume. Until the fee is charged, reward referrals with longer
   fee-free time instead (e.g. +3 months per referred photographer who
   sells). Payouts to individuals need withholding — ask an accountant.
9. **Long-term storage plan** (paid): originals + layouts kept past 180 days
   in a separate bucket, billed by GB.
10. Landing page for photographers.

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
- Storage usage tracking per photographer (limit by GB, not album count).
- Cap the number of photo keys listed in the change-notification email.

## Technical debt / security
- Browser E2E suite in CI (fix the flaky suites first: book_editor "no token
  is minted for an empty folder set", and mobile preview "preloads i±1 … at
  the responsive width bucket" — both pass alone, fail under load).
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
