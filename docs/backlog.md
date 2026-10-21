# Backlog

Decided or discussed, not yet built. Newest decisions at the top of each group.
**Status refreshed 2026-10-21** (against `main` d713634; the previous refresh was 2026-10-08 at 25ae25a): items that have shipped are marked
✅ in place or moved to "Shipped since 2026-09-29" below; sections kept for their decisions
say so in their heading.

## THE ORDER (agreed with Tim 2026-09-29 — the only main line)
Run one real job end to end → connect Album / Proof / Delivery → build
multi-photographer in batches (open registration, operator approval, scope up
to 我有興趣 only: no money flow, S2 ordering stays off for everyone;
`docs/multi-photographer.md`) → validate with real photographers → only then
widen to free sign-up / SaaS. No new big features outside this list.
(Changed 2026-10-08 by Tim: multi-photographer used to wait for "validate with
5 photographers" first.)

1. **Make what exists run for real.**
   - Products / orders migration ✅ run, merged, deployed. `OPERATOR_TOKEN` set.
   - Delivery (交件: finals separate from proofs on the same link, proof
     original download switch) ✅ built and merged — `docs/delivery.md`
     (needed `2026-09-30-delivery.sql`). Still worth a `ping.html` check for
     photos without thumbnails (they no longer fall back to the original in
     the picking view).
   - Client confirmation + revision requests ✅ built and merged (Publish ≠
     Complete: after 交件 the guest taps 確認完成 or asks for changes; 精修二
     goes out with the existing 更換精修; the photographer can 標記完成) —
     `docs/delivery.md` → "Client confirmation and revision requests"
     (`2026-10-04-client-confirm.sql`).
   - **Revision pins on the finals** ✅ built and merged (2026-10-06/07): the
     text 要求修改 became pins + a note, sent as a frozen round (送出修改 N 張),
     history for the guest, round cards and per-round CSV for the
     photographer — `docs/revision-pins.md` (`2026-10-07-revision-pins.sql`).
   - **完成頁** ✅ (a delivered project the client confirmed): light page with
     hero, shoot date, gallery, 下載全部精修, 把這段回憶留下來 (products,
     我有興趣), album preview — `docs/delivery.md` → "The 完成頁".
   - Email: Cloudflare Email Routing on, verify the photographer's inbox,
     `wrangler secret put PHOTOGRAPHER_EMAIL`, submit a test pick.
   - Real phone: iPhone / LINE in-app browser / Safari — picking, gestures,
     delivery gallery, admin pages.
   - ✅ The P0/P1 bugs are fixed (touch annotations were never saved; the orange
     tools toggle covered ♥ — removed on the guest page and the review view).
     Still needs a real-phone look: the 2026-10-07 phone layouts (photographer
     pages `css/side-nav.css`, upload page, picker header on a phone), the guest
     tour, the 完成頁 on iPhone Safari / LINE.
2. **Tim runs 2–3 real jobs end to end** (*this is the step we are in; nothing here is
   confirmed by the repo, only Tim can say how many jobs ran*): project → upload → guest picks →
   submission → retouch → products / 加挑 → order → manual print → delivery.
   Log every snag here. No new big features during this step.
3. **Album back into the project:** Project → Picker → Retouch → Album.
   Integrate the existing `book_editor` (auto-layout, viewer, export); do not
   build a new album engine. Album layouts/print files and the 180-day rule:
   see item 3 "Album chain" in the earlier roadmap notes below.
   *Status 2026-10-08, partly:* the guest sees an A4 album laid out from their own
   finals on the 完成頁 (preview only, nothing saved: `docs/album-preview.md`,
   planner with variety / heroRate / preferredPerSpread / variant / foldSafe,
   min/max spreads from the product, bleed guide, cover title, 再次編排);
   `book_editor` itself is not yet fed from the project. Print files and the
   180-day rule are not built.
4. **Proof → Approval → Delivery:** album → guest proofs → changes →
   approval → final → delivery. From here the product is a photo-project
   delivery system, not just a picking tool.
   *Status 2026-10-08:* the photo side (picks → finals → confirm / revision pins →
   完成頁) is built; the album proof / approval leg is not.
5. **Photographers test it for real** (`docs/photographer-interviews.md`) —
   on the multi-photographer build (open registration, operator approval,
   up to 我有興趣; `docs/multi-photographer.md`, since 2026-10-08).
   Start booking during steps 2–4 — interviews cost no dev time. Three
   questions: would you use it? pay monthly? print albums / 無框畫 through
   the platform?
6. **Decide the business model from the results:** monthly SaaS, platform
   products, print commission, own lab vs the photographer's lab. The 15%
   fee stays off until then.
7. **Only then widen to full SaaS:** free sign-up → subscriptions. (Photographer
   accounts, multi-tenant isolation and per-photographer R2 paths are in
   `docs/multi-photographer.md`: batches 1–3 and invite-code sign-up are built and live, `PHOTOGRAPHER_ROUTES = "on"`;
   batch 4 (per-photographer notification email) and the open self sign-up of batch 5 are not; see the status at the top of that file.)

**Parked — do not start:** referral, client hub, online payment, vendor
accounts, AI (layout or otherwise), more products, big operator console,
complex membership, any new engine. (Video results and Travel Story are recorded under
"Future / not scheduled"; not started.) The notes further down stay as
reference only.

## Shipped since 2026-09-29 (all on `main` as of 25ae25a; `git log` has the detail)
- Plan edit per project + submit-time extra-pick cap (`extra_max`, 409 `pick_cap`), guest
  page cleanup (folders + filter only, one submit button, one counter), retouch pins on
  the proofs (`docs/guest-picking.md`, `docs/project-plan.md`).
- Delivery, client confirmation, revision pins, finals gallery, 完成頁, 下載全部精修
  (`docs/delivery.md`, `docs/revision-pins.md`); project 命名 from 拍攝日期 + 專案名稱
  (`js/project-folders.js`); `shoot_date`, `project_type`, rename (PATCH `title`).
- Photographer admin: project detail as its own view with collapsible blocks,
  list search + status / category filters + 待我處理 sort (filters in the URL hash),
  back-button convention (← 返回 / ← 上一層, 44px, top-left), phone layout
  (`css/side-nav.css`), upload page phone layout + retry, 複製連結 dialog with a
  ready-to-send message, 看全部毛片, 交件通知文案.
- Products: platform catalogue + operator console; album `min_pages` / `max_pages`
  (spreads), `extra_page_price`, `bleed_mm` (`docs/products-orders.md`).
- Album planner + guest album preview (`docs/album-preview.md`); shared helpers in
  `js/util.js` (`escHtml`, `fmtDate`, `todayTaipei`, `formatPrice`).
- Guest first-visit tour (`js/guest-tour.js`, `docs/guest-picking.md`).
- 「我有興趣」 on the 完成頁 + 客人興趣 list in admin (`product_interests`, `docs/guest-shop.md`).
- **S2 guest ordering — built but DARK**: Worker routes, 訂購 sheet / cart / receipt /
  我的訂單 on the 完成頁, photographer orders UI, settings 匯款資訊. Off until Tim sets
  `GUEST_ORDERS` in `worker/wrangler.toml` (`off` default, `pilot` + `GUEST_ORDERS_PILOT`,
  `on`) after the privacy notice is reviewed and `2026-10-09-guest-orders.sql` has run.
  Pickup only, money flow deferred (`docs/guest-shop.md`, "S2 — Tim 的決定").
- Test layout: browser suites split into `test/suites/NN-*.mjs` + `test/lib/*` (`test/README.md`);
  `test/run-parallel.mjs` runs the full browser suite in 3 workers.
- Since 2026-10-08 (all on `main` as of d713634): co-picking (`docs/co-picking.md`); multi-photographer batches 1–3,
  invite-code sign-up and one login form (`docs/multi-photographer.md`); deleting one photo; the 驗收頁 as the 毛片 page,
  per-version view and 改交這一版, the redesigned project page (status card, ⋯ menu, 設定 modal, 準備中), the activity log
  `project_events`, one live pick link per project (a new link revokes the old ones), photo expiry dates
  (`docs/delivery.md`); Space picks on the guest page (`docs/guest-picking.md`); D1 weekly backup and Time Travel
  workflows (`docs/backup.md`).

## Earlier roadmap notes (reference only — THE ORDER above wins)
Done: back-office shell (dashboard, 已交付); studio settings (name, logo,
default plan); products & orders A and platform catalogue A2 (merged, in use).
Design: `docs/products-orders.md`.

1. **180-day countdown.** Photos (and everything else in `imagepicker`) are
   deleted 180 days after upload. Show it: 「照片將於 X 月 X 日刪除」 on the
   project in admin and on the guest page. The platform is not the
   photographer's archive — they keep their originals.
   *Status: Worker done (2026-10-20): `GET /api/admin/projects/:id/expiry` and
   `GET /api/pick/expiry` (`docs/delivery.md`, "Photo expiry"). Frontend done (2026-10-20): a line on
   the admin project page, the date in 複製交件通知文案, a note beside 下載全部精修 on the 完成頁.
   Not built: the 驗收頁 (delivered, not yet confirmed) and the pick page show no date.*
   *Replaced 2026-10-21 (Tim): the lifecycle rule is to be removed; both routes answer no date. Instead the
   Worker deletes **proofs only**, N days after the client's confirmation (studio default 0 / 90 / 180 / 365,
   default 0 = never; per-project override, 延後 30 天, 不要刪; 14-day reminder) — Worker built
   (`docs/delivery.md`, "Proof retention", `2026-10-21-proof-retention.sql`, daily cron). Frontend not built:
   the studio setting, the project's 毛片保存 line + 延後 / 不要刪, the dashboard reminder, the 完成頁 note.*
2. **B — guest shop.** Platform products (photo, price) on the pick page;
   the guest orders, the photographer confirms, payment by transfer. The main
   selling point. *Status: S1 (product info) and 我有興趣 live; S2 ordering built
   dark behind `GUEST_ORDERS`; S3 (album layout on the order) not built —
   `docs/guest-shop.md`.*
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

## Guest pick page UI (decided with Tim 2026-09-30, from his iPhone test — ✅ built 2026-09-30..10-07 except where marked)
Guest link only (owner and viewers); the photographer's own index.html keeps every tool.
- Only two tools for guests: **資料夾** and the **全部 ｜ ♥ 已選 N ｜ 未選** filter.
  Remove FLAGS (PICK/REVIEW/REJECT), ANNOTATION, 排序 and DATA from the guest view (from the DOM).
- Phone: no ☰ / drawer for guests. An always-visible bar under the header:
  「資料夾：<current> ▾」 + the 3-way filter. Desktop: sidebar with only those two.
- Delivered gallery: folder switch only (no filter, no ♥) — **plus (Tim, 2026-09-30):
  購買資訊 and a 分享 button. ✅ Both exist now: 分享 on the gallery and the 完成頁;
  購買資訊 is the 完成頁 product section (option A, info only, + 我有興趣), and ordering
  (option B) is S2, built dark.**
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
- **Retouch pins (decided 2026-09-30, option A; ✅ built 2026-09-30 — `docs/guest-picking.md`,
  "Retouch pins"; the bullets below are the original decision text):** in preview the guest taps
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

> 2026-10-19: 主人看協作者統計 built (docs/co-picking.md build order 5): per-person heart chips + tap-to-filter on the owner's pick page,
> owner only. Still open: the owner page does not live-refresh collaborators' hearts.

## Co-picking / collaborators (decided with Tim 2026-09-30 — HISTORY: superseded by `docs/co-picking.md`, built)
Replaces the seat-passing proposal in docs/pick-handover.md §3+ (kept only as history).
*Status 2026-10-21:* the design was rewritten on 2026-10-11 as `docs/co-picking.md` (8-digit invite codes, at most
2 collaborators, owner-only submit) and built and merged (`2026-10-13-co-picking.sql`; browser suites 65–67, 70, 71, 96).
The bullets below are the 2026-09-30 discussion; where they differ (colours per person, a reusable link, up to 5 people),
`docs/co-picking.md` wins.
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
- **Collaborator link (Tim's proposal, 2026-09-30):** the first person generates ONE
  reusable 協作者連結 (separate from the pick link); anyone who has it can join as a
  collaborator by entering a name, until the project's `max_pickers` is reached
  (default 2, raisable to at most 5 — whether 5 counts the first person is still
  to confirm; recommended: 5 people in total). Safeguards: the first person sees the
  joined list (n/5) with 移除, can close or regenerate the link at any time, default
  validity 7 days; joining needs an explicit tap (a LINE preview never takes a slot);
  the last slot is taken atomically; no approval step. Two devices = two people.
- **Removing a collaborator (Tim's proposal):** a dialog tells the first person how
  many photos that person picked (and how many only they picked) and asks:
  keep their picks (they become the first person's ♥; their notes/pins stay,
  shown as 「小美（已移除）」) or remove their picks (photos only they picked leave
  the list, their notes/pins go with them). Default: keep (not destructive).
- The plan cap is checked at submit on the union of hearts (in progress: the
  submit-time cap, separate from this).
- Not decided yet: how the collaborator link works (one-time link, 48 h, revocable
  by the first person — the redeem/`#h=` mechanics in pick-handover.md can be reused),
  a photographer-visible history, and a 「兩人都選」 filter (likely yes).

## Bugs
Fixed (verified in `js/`, 2026-10-08), kept here for the record:
- ✅ The orange tools toggle covering ♥ on a phone: removed on the guest page
  (`js/pick.js`) and the review view (`js/project-view.js`).
- ✅ Annotations drawn by touch were never saved: `stopDrawing` now reads
  `changedTouches`.
- ✅ − / + zoom now about the view centre (2026-09-30).
- ✅ Pin coordinates are 0–1 fractions of the photo, not pixels.

Still open:
- The old freehand annotation tool (photographer's own `index.html`, localStorage
  `r2_photo_picker_annotations`) may still store fitted-photo pixels; not re-checked.
- Minor: panning is unbounded (not re-checked).

## Deferred features
- ✅ Done: edit a project's 張數 / 加挑單價 / 最多可加選 after creation
  (`PATCH /api/admin/projects/:id`, 編輯方案; `docs/project-plan.md`). Submissions snapshot
  the plan at submit, so an edit only affects later submits.
- Edit a project's folders after creation — same edit screen as 張數 / 單價.
  Folders are snapshotted on the project and on every pick share token
  (grep `folders` in `worker/worker.js`; reissue copies the project), so an edit must
  update the live pick tokens too, or existing links keep the old scope.
  Decide what happens to picks in a removed folder (keep, but hide?).
  Security review: this widens what a live link can read.
- ✅ Done: "no extra picks" is `extra_max = 0` (submit refuses above `pick_limit + extra_max`;
  a blank 加挑單價 still only hides the price).
- ✅ Done another way (multi-photographer batch 2b-3): `GET /api/pick/logo?t=` (the link's photographer) and
  `GET /api/admin/settings/logo` (the caller's own); the public `/api/studio/logo` still serves only the default studio.
- Strip bidi / zero-width characters from `studio_name` (spoofing only; admin-set).
- Custom (non-platform) products for photographers — built, off by
  `CUSTOM_PRODUCTS`; ideas: invite a photographer's own print lab onto the
  platform as a vendor (keeps the 15% margin fee); a paid plan allowing their
  own lab (fee on sale price or monthly, since a self-declared cost can be gamed).
- Registered-owner invites (editor / viewer) for a project.
- Link a registered client account to a pick seat (`pickers.user_id`).
- Storage usage tracking per photographer (limit by GB, not album count).
- Cap the number of photo keys listed in the change-notification email.
- ✅ 已做 2026-10-19（`claude/retouch-stage`，已合併到 main（e1f573c），待 Tim 實機驗）：**驗收頁就是毛片頁**
  （Tim：「精修要修改的方式跟毛片一樣」）。交件、未確認時用標準照片格＋標準預覽（可縮放／平移，沒有 ♥），
  標示用毛片同一套（標示修改／完成、上方說明框、備註・標示清單），存進修改草稿（`PUT /api/pick/revision-pins`，
  Worker 不動）；底部一顆按鈕：沒標示「精修完成」→ 確認完成對話框，有標示「送出（N 張）」→ 送出對話框。
  完成頁不動。`docs/delivery.md`「The 驗收頁 is the 毛片 page」；測試 91–93（新）與 14、15、18、26、28、33、37、
  39、47、61、62、65、85、87（改）。下一條（精修 lightbox 放大縮小）因此一併解決。
- ~~精修（交件後的成品圖庫）lightbox 要有跟毛片一樣的放大／縮小~~（2026-10-19 由上一條解決）（Tim 2026-10-15，iPhone 實測：
  看精修圖要刻意放大縮小，現在沒辦法順手看細節）。毛片預覽的 pinch / − + / 平移已有
  （`js/app.js` 預覽、`js/visual-viewport.js`）；交件圖庫（`js/pick.js` delivery gallery）
  只有上一張／下一張＋下載。待討論：直接共用毛片的縮放模組 vs. 另做；注意交件圖庫只
  走 `pickFinals`，不可為此新增讀取路徑；縮放時要不要載入大圖（1200 → 原圖不可，仍只給 thumb）。
  **只記錄，尚未討論、尚未動工。**
- ✅ 已做 2026-10-18（`claude/guest-delivery-fixes`，已合併到 main（0446a18 起），待 Tim 實機驗）：驗收頁的分享鈕已移除，只留完成頁 `cpShare`；測試 `85-share-on-completion-page.mjs`。
- 驗收頁（交件後、客人還沒確認完成）不該有「分享」鈕；只有確認後的完成頁（`cpShare`）才有
  （Tim 2026-10-15 確認：「完整頁面」＝完成頁）。做法：`js/pick.js` 只在 `cp` 時傳 `onShare`，
  `js/finals-gallery.js` 沒有 `onShare` 就不畫 `#fgShare`；完成頁分享不動。測試代價：
  `test/suites/28-finals-gallery.mjs` 的 6 組分享測試要搬到「已確認」fixture、改點 `cpShare`，
  另加正向檢查「驗收頁沒有分享鈕」；`test/suites/18-guest-downloads.mjs` 版面測試引用
  `#fgShare` 也要改。Normal 等級（sonnet、相關測試、約 5 mutants）。**只記錄，尚未動工。**
- ✅ 已做 2026-10-18（同上）：字樣改「回到毛片」／毛片頁標題「毛片」；毛片原檔只有主人（`isOwner`）能讀／下載，Worker 端用 `X-Picker-Key` 擋（`worker/test/proof-owner-gate.test.mjs`，10 個 mutants），主人的單張下載改成帶 header 的 fetch；狀態列與「回到毛片」同一列、貼在 header 下不跟著捲（`#deliveryStrip`）；挑片頁拿掉 footer 讓頁面不再多捲 41px。**挑片頁的「狀態列」在無頭瀏覽器量到本來就貼著，Tim 看到會動的原因我判斷是這 41px 的外層捲動，未在真 iPhone 驗證。** 測試 `87-guest-proofs-and-strip.mjs`。
- 驗收頁的「下載毛片原檔」鈕會讓人搞混（Tim 2026-10-15）。三點，皆只記錄、尚未討論／動工：
  1. 語意：客人會以為按了是「回到毛片」（看／挑過的那批），實際是進毛片原檔下載清單
     （`js/pick.js` `_renderDeliveryBar`，`switchView('proofs')`，字樣「下載毛片原檔」／「← 回精修成品」），
     而且是壓縮全部毛片一次下載。應改成「回到毛片」。
  2. 權限：非主人（viewer，`isOwner` 為 false）不該能下載毛片原檔；目前只看 `allowProofDownload`。
     **High 等級**（動到誰能讀原檔 / 下載閘）：worker 端也要擋，不能只藏按鈕；opus、完整 TDD、
     ~10 mutants、security review；先確認 worker 的毛片下載路徑有沒有 owner 檢查（grep `allowProofDownload`）。
  3. 版面：「尚待選片人確認完成」（`js/delivery-done.js`）跟「回到毛片」放同一列，且該狀態列 fixed、
     不跟著 scroll；**挑片頁的狀態列也一樣不要跟著 scroll**（兩處都固定在頂端）。要注意 iPhone Safari
     的 sticky/fixed 與網址列收合、LINE 內建瀏覽器。
- ✅ 已做 2026-10-18（同上）：客人頁拿掉自檢連結（`#diagLink`，photographer 的 index 仍有）；測試 `86-guest-first-load.mjs`。
- 客人頁（`index.html`，交件圖庫）頁尾拿掉「點此進行系統自檢」連結（`index.html` 約第 691 行，
  指向診斷頁）。Tim 之前就說過：客人看得到的頁面不要出現「系統自檢」字樣。`js/diagnostics.js`
  留著，只拿掉客人看得到的連結。（Tim 2026-10-15，併自 `claude/backlog-notes-oct15`，尚未動工）
- ✅ 已做 2026-10-18（同上）：相本入口只在完成頁出現（驗收頁原本就會出現，是 bug）；`26-album-preview.mjs` 第 1 節重寫，其餘相本 suite 的共用世界預設改成「已確認」（`test/lib/album-world.mjs`）。
- 「✨ 看看你的照片排成相本」入口（`js/album-preview.js`，`album-entry-title`）現在不能顯示。
  規則：只在客人確認完成（`client_confirmed_at`）之後、在完成頁顯示；這個規則做好前一律不顯示。
  動工前先查它現在在哪些頁面露出（驗收頁有沒有）。（同上，併自 `claude/backlog-notes-oct15`，尚未動工）
- ✅ 已做 2026-10-18（同上）：首次載入顯示轉圈圈（`#guestBoot`，`js/pick.js` `_boot`），資料回來、失效或錯誤都會移除，不會一直轉；測試 `86-guest-first-load.mjs`。
- 客人剛點進連結時，有一段空白等待（讀取 `/api/pick/state` 與照片列表），要加 loading 動畫
  （Tim 2026-10-15，尚未動工）。現況線索：`index.html` 有 `#loadingState`（`.spinner`，預設
  `display:none`，`js/pick.js` 約 1710 行也只負責把它隱藏），看起來客人頁首次載入從沒顯示過它；
  另有 `#loadingModal`（小藥丸，`正在處理...`）。做法方向：首次載入就顯示、state 回來才換成內容；
  注意 state 失敗（過期／無效連結）時要換成錯誤畫面，不能轉圈圈轉到天荒地老；
  暗色客人頁配色、LINE 內建瀏覽器、慢網路實測。Tiny～Normal 等級（純前端，不動 worker）。

## Future / not scheduled: 成果 content (video) and Travel Story (written 2026-10-07, ideas only)
Nothing here is built or started. THE ORDER wins: real jobs first (step 2), then the
guest ordering path (shop S2/S3), then the photographer interviews (step 5). Neither
item starts without evidence from real photographers (see "Start only if" below).

Shared frame: a delivered project is a **成果** (finished work): photos, and later
video, album, products. The photographer controls what is published; the client only
sees what was published. Never a file hub (Dropbox / Drive), never a shared album.

### A. Video results (P1, after the order above)
- **Phase 1, link only (the cheap test):** per project, 影片成果 = title, description,
  an unlisted YouTube / Vimeo link, optional cover. A 發布 switch decides whether the
  client sees it (驗收頁 and 完成頁). No upload, no storage, no transcoding, no 180-day
  problem. Cost is about a third of phase 2. Known weakness: an unlisted link can be
  forwarded, say so to the photographer.
- **Phase 2, upload to R2 (only if photographers ask for it):** table `project_videos`
  (project, title, description, r2 key, cover key, size, published, sort; a new
  migration); H.264 MP4 only, checked by its `ftyp` header, one file up to ~2 GB;
  the photographer supplies the cover (no thumbnail generation); progressive MP4 via
  the existing object route (it already honours Range).
- **Hard parts, in order:** (1) upload size: a Worker request body has a size limit
  (this file already notes ~150–250 MB hits it), wedding highlights are 0.5–2 GB, so
  this needs R2 multipart upload with resume, which is most of the work, not playback;
  (2) the gate: video is delivery content, readable only when `delivered_at` is set
  AND the video is published, a new read path next to `pickFinals`, High tier
  (opus, full TDD, security review); (3) the 180-day R2 lifecycle deletes videos too,
  so say it in the UI (the photographer keeps the original); (4) HEVC does not play
  everywhere, accept H.264 only, no transcoding, no HLS, no multi-resolution;
  (5) LINE in-app browser needs `playsinline`, real-phone check; (6) every play is
  many Range requests, watch Worker request counts.
- **Where it shows:** a 🎬 section on the 完成頁 between the gallery and the products.
- **Start only if:** at least 2 of the 5 interviewed photographers say they would
  attach video at delivery (add this question to `docs/photographer-interviews.md`).
  Phase 2 only if links are not enough.

### B. Travel Story (add-on for group-tour photographers)
Idea: the photographer walks a group through a trip; the platform turns itinerary +
the photographer's photos + each member's own picks into a story-shaped result, which
feeds the album (chapters by day / place) and products. An add-on of a Project, not a
new product and not a shared album.
- **MVP, six things only:** (1) project type 旅行／跟團攝影 (this builds on
  `projects.project_type`, already shipped); (2) a Travel Story switch; (3) Day 1 / 2 / 3
  itinerary; (4) per-day text + place; (5) per-day photographer-chosen photos;
  (6) 成果 photos → Story Album (chapters from the days).
- **Rules to lock:** a member sees only their own photos (never "everyone's photos");
  the story layer is separate from folders (an itinerary day is not a folder); the
  public story only shows photos the photographer picked; the story is free for
  members, money comes from the album / 無框畫 / extra photos; photographers may pay
  per Travel project or for a plan (test NT$300–1,000 per project, decide later).
- **Not in the MVP:** member photo uploads (phase 2 as 「加入旅行回憶」, at most 5, private
  to that member), a one-line personal memory in the album (phase 2), group memorial
  album for the leader / agency (a second product), map, GPS, weather, flights, AI
  travel writing, community, comments, likes, chat.
- **Open architecture question (decide before building):** our model is one project
  per client and a link per seat, with no parent "trip" or "group" entity. A story
  shared by many members (one itinerary, many members' private photos) needs either a
  parent entity that owns the story and owns many member projects, or the story is
  copied into each member project. The first is a new table and new gates (High
  tier); the second is cheap but the photographer edits the itinerary N times. Pick
  one with Tim before any code.
- **Three business assumptions to test, in this order:** (1) will a tour photographer
  type the itinerary into the system at all (if it feels like homework, stop);
  (2) does a member who sees 「我的旅行成果」 buy an album more often than after a plain
  delivery; (3) will the photographer pay for every member getting their own result.
- **How to test cheaply:** run one real 跟團攝影 job on today's flow (Project → Picker →
  Retouch → Delivery → 成果 → Album) with `project_type` set, log the snags here, and
  only then decide whether Travel Story becomes a first-class feature.

## Technical debt / security
- `book_editor/js/layouts.js` `renderPageHTML` writes `src="${src}"` unescaped and
  `_thumbUrl` / `drive.js` `objectUrl` do not encode the photo key (`#`, `?`, quotes
  break the URL or the attribute). Only the editor and `view.html` use it today, and
  keys come from the photographer's own uploads, so the risk is low; the guest album
  preview (`js/album-preview.js`) deliberately builds its DOM without it. Fix before
  anyone else's file names can reach it (multi-photographer) or before the guest
  preview switches to it.
- `node --check <file>.js` does not catch syntax errors on our Node (v22): there
  is no package.json, so the file is not treated as a module and an unbalanced
  paren still exits 0. Use `node --input-type=module --check < worker/worker.js`
  (or add `"type": "module"` where that is correct) in CLAUDE.md's commands (done) and
  in `.github/workflows/deploy.yml` (still a plain `node --check` loop, 2026-10-21). The worker tests import worker.js as ESM,
  so they do catch it; the CI syntax step for the frontend JS files does not.
- ✅ Fixed (r2-hardening): the upload `PUT` answers 404 for a key whose first segment is `api` and writes nothing
  (`worker/test/upload-paths.test.mjs`).
- Browser E2E suite in CI (fix the flaky suites first: book_editor "no token
  is minted for an empty folder set", and mobile preview "preloads i±1 … at
  the responsive width bucket" — both pass alone, fail under load).
- Password hashing: SHA-256 → PBKDF2 with legacy-hash compatibility.
- WAF rate limit on login / register.
- Upload: check magic bytes, 50MB per file. (Content-Type is now checked server-side against the extension:
  `uploadContentType`, `worker/test/upload-types.test.mjs`.)
- `notifyUrl` allowlist on book submit.
- Cloudflare Cache Rule `imhoti.tw/studio/*` → Bypass (removes the need to
  purge after every deploy).
- FLAGS: hide or finish (hidden on the guest page; the photographer's own picker still has them).
- GitHub "Security and quality" shows 1 alert — look at it.
- Real D1 behaviour not yet proven in prod: `batch()` as a transaction under
  load, row/value size limits.

## Open questions and where we stopped (2026-09-30 — HISTORY, partly resolved; for whoever continues the discussion)

> Status 2026-10-08: the branch below was merged long ago (submit-time cap, drafts, pins and
> the four `2026-09-30-*` migrations are all in `main`; the later migrations were written
> assuming they had run). What is still open from this section: "repeat submit over a lowered plan" (built as refuse;
> Tim's call). 2026-10-21: the co-picking questions were answered by `docs/co-picking.md` (built).

Open — need Tim's answer:
- Collaborator limit "最多五個人": 5 total (A + 4, recommended) or 5 collaborators?
- Removal dialog default: keep the removed person's photos (recommended) or remove?
- Repeat submit after the plan was lowered below the current count: refuse (recommended) or allow?
- Collaborator link lifetime (7 days?) vs the normal pick link (48 hours?).
- Collaborator link safeguards to confirm: A can disable/regenerate it, capacity stops joins, A sees every name and can remove.

State of the branch `claude/lucid-cori-viif3w`:
- Worker for submit-time cap is committed (04e1ee1) and tested (682 worker tests).
- Frontend for it (no cap while hearting, red counter + over-limit dialog at submit, reliable drafts) was still being built by an agent: NOT committed, NOT verified. Do not merge until the full browser + worker suites pass.
- Before merging, Tim runs 4 D1 ALTERs in the D1 Console: `selections.marks`, `submissions.marks`, `projects.extra_max`, `studio_settings.default_extra_max` (files in `worker/migrations/2026-09-30-*.sql`). Merge to main deploys; only when Tim says 合併. Then Purge Everything, test on a real iPhone/LINE.
- Co-picking ("共同挑選") is decided in principle only; `docs/pick-handover.md` §3+ (seat passing) is superseded and must be rewritten before any build.
