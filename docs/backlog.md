# Backlog

Decided or discussed, not yet built. Newest decisions at the top of each group.

## THE ORDER (agreed with Tim 2026-09-29 — the only main line)
Run one real job end to end → connect Album / Proof / Delivery → validate
with 5 photographers → only then multi-tenant SaaS. No new big features
outside this list.

1. **Make what exists run for real.**
   - Products / orders migration ✅ run, merged, deployed. `OPERATOR_TOKEN` set.
   - Delivery (交件: finals separate from proofs on the same link, proof
     original download switch) — `docs/delivery.md`; finishing now. Needs
     `worker/migrations/2026-09-30-delivery.sql` in D1 before its merge, and
     a check in `ping.html` for photos without thumbnails (they no longer fall
     back to the original in the picking view).
   - Email: Cloudflare Email Routing on, verify the photographer's inbox,
     `wrangler secret put PHOTOGRAPHER_EMAIL`, submit a test pick.
   - Real phone: iPhone / LINE in-app browser / Safari — picking, gestures,
     delivery gallery, admin pages.
   - Fix known P0/P1 bugs (see Bugs): touch annotations never saved; orange
     tools toggle covering ♥ on a 390px phone.
2. **Tim runs 2–3 real jobs end to end:** project → upload → guest picks →
   submission → retouch → products / 加挑 → order → manual print → delivery.
   Log every snag here. No new big features during this step.
3. **Album back into the project:** Project → Picker → Retouch → Album.
   Integrate the existing `book_editor` (auto-layout, viewer, export); do not
   build a new album engine. Album layouts/print files and the 180-day rule:
   see item 3 "Album chain" in the earlier roadmap notes below.
4. **Proof → Approval → Delivery:** album → guest proofs → changes →
   approval → final → delivery. From here the product is a photo-project
   delivery system, not just a picking tool.
5. **5 photographers test it for real** (`docs/photographer-interviews.md`).
   Start booking during steps 2–4 — interviews cost no dev time. Three
   questions: would you use it? pay monthly? print albums / 無框畫 through
   the platform?
6. **Decide the business model from the results:** monthly SaaS, platform
   products, print commission, own lab vs the photographer's lab. The 15%
   fee stays off until then.
7. **Only then SaaS:** photographer accounts → multi-tenant → subscriptions
   → isolation between photographers.

**Parked — do not start:** referral, client hub, online payment, vendor
accounts, AI (layout or otherwise), more products, big operator console,
complex membership, any new engine. The notes further down stay as
reference only.

## Earlier roadmap notes (reference only — THE ORDER above wins)
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

## Guest pick page UI (decided with Tim 2026-09-30, from his iPhone test — not built yet)
Guest link only (owner and viewers); the photographer's own index.html keeps every tool.
- Only two tools for guests: **資料夾** and the **全部 ｜ ♥ 已選 N ｜ 未選** filter.
  Remove FLAGS (PICK/REVIEW/REJECT), ANNOTATION, 排序 and DATA from the guest view (from the DOM).
- Phone: no ☰ / drawer for guests. An always-visible bar under the header:
  「資料夾：<current> ▾」 + the 3-way filter. Desktop: sidebar with only those two.
- Delivered gallery: folder switch only (no filter, no ♥) — **plus (Tim, 2026-09-30,
  scope still to confirm): 購買資訊 and a 分享 button.**
  - 購買資訊: options — (A) info only: the photographer's guest-visible products
    (name, spec/price, photo) + a 「聯絡攝影師訂購」 link; a read-only guest route
    (delivered mode only, never cost); needs a guest_visible switch in settings
    (column exists, no UI yet); ~0.5–1 day. (B) full order request from the
    gallery = Phase B guest shop, guest writes, High tier, 2–3 days. Recommended: A first.
  - **Tim's goal (2026-09-30): end state is B** — the guest orders from the
    delivered gallery and the order reaches the photographer with no manual
    step (「無感」): it appears in orders (status requested), an email/notice
    arrives, one tap to confirm. Build in stages (info first, then ordering);
    a detailed Phase B design (docs/products-orders.md has only an outline)
    comes before building. Payment stays a bank transfer until online
    payment (parked).
  - 分享: share the gallery link (Web Share API, fallback copy). Anyone with the
    link can view AND download the finals (owner and viewers already see the same
    gallery); the photographer can revoke the link. A separate view-only /
    no-download share link is a bigger change — not planned.
- **One submit button only: the bottom one (完成提交).** Remove 完成挑圖 from the header.
- **No 預約拍攝 button on the guest page at all** (Tim: not wanted). The booking_url setting stays, unused on this page.
- Top-left brand: the photographer's own studio logo / name from settings.
- Replace the 「HC」 circle with a small person icon (placeholder for a future client login).
- **Retouch pins (decided 2026-09-30, option A):** in preview the guest taps
  「標示修改」, then taps spots on the photo → numbered pins ①②…, each with a
  short note (「這裡痘痘」). No freehand circles for now (option B, later if
  clients need it; keep the data shape open for it).
  - Server-side: an append-only column on `selections` (e.g. `marks` JSON:
    `[{x, y, note}]`, x/y as 0–1 fractions of the photo so any screen size
    lines up — this also retires the old pixel-coordinate bug). Tim runs the
    ALTER in D1 before the merge.
  - Saved with the selection (same phase gates as ratings/notes); only on
    ♥ photos; limits (e.g. ≤ 10 pins per photo, note ≤ 100 chars).
  - Submission snapshot includes the pins; changes after a submit show in
    已修改 / the diff.
  - Photographer (Tim, 2026-09-30): wherever he opens the picked photos —
    the project's 「看照片 →」 view (index.html?project=<id>) — every photo
    shows the guest's pins: a pin-count badge on the grid card, and in
    preview the numbered pins drawn over the photo (they follow zoom/pan)
    with the matching notes listed beside/below. Read-only for him.
    Later, if retouchers need it: export the pins (a list per file, or the
    photo with the pins drawn on) with 下載選片.
  - Guest writes → High tier: TDD + security review. ~1.5 days.
  - Build together with the guest pick page UI changes above.

## Co-picking / collaborators (decided with Tim 2026-09-30 — design to be rewritten, not built)
Replaces the seat-passing proposal in docs/pick-handover.md §3+ (kept only as history).
- **Two people by default** (the first person + one collaborator, a couple);
  `max_pickers` per project, raisable for a family portrait.
- Each person's ♥ has their own colour **and the first character of their name**
  (colour alone is not enough); same first character → 首字1 / 首字2, numbered by
  join order. A photo hearted by both is **one** photo (union, counted once); the
  card shows both marks.
- Removing: **the first person may remove any photo** (clears everyone's ♥);
  a collaborator can only cancel their own ♥.
- **Only the first person submits.** A collaborator's edits after a submit mark
  the project 「已修改，尚未重新送出」 (photographer and first person both see it).
- Collaborator's notes and pins are **retouch requests to the photographer**
  (no separate "family only" comments — families chat in LINE): saved per person,
  included in the submission when the first person submits, shown to the
  photographer tagged with the writer's name/colour. The input is labelled
  「給攝影師的修圖備註」. Limits: ≤10 pins per person per photo, ≤300 per project.
- Removing a photo also clears the pins/notes on it; the writer sees 「這張已被移除」.
- The plan cap is checked at submit on the union of hearts (in progress: the
  submit-time cap, separate from this).
- Not decided yet: how the collaborator link works (one-time link, 48 h, revocable
  by the first person — the redeem/`#h=` mechanics in pick-handover.md can be reused),
  a photographer-visible history, and a 「兩人都選」 filter (likely yes).

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
- Upload route (`PUT` to any unmatched path) also accepts admin requests under
  `api/…` and stores them as R2 objects (e.g. `PUT /api/admin/projects/<id>/archive`
  writes a junk object; only the admin token can do it, the 180-day lifecycle
  removes it). Make the upload route refuse any key starting with `api/`.
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
