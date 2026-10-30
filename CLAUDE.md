# imge_picker — working agreement

Photographer's photo-picking studio at imhoti.tw/studio. Cloudflare Worker
(`worker/worker.js`) + R2 bucket `imagepicker` + D1 `imagepicker-db`, vanilla
JS frontend. Feature designs live in `docs/` (e.g. `docs/guest-picking.md`).

**The roadmap is `docs/backlog.md` → "THE ORDER": the only main line.** Run real
jobs end to end first; no new big feature outside that list.

## Where things are (grep the names; line numbers drift)
- `worker/worker.js` (one file, ~8.4k lines): `resolveShareToken` (every link/token
  lookup), `pickReadScope` / `pickFinals` (what a guest link may read — the gate),
  `/api/admin/projects…` (photographer routes, `requirePhotographer` → `who.id`; `isAdminToken`
  is only called inside it), `/api/pick/state`
  and `?list=` / object reads (guest side), `withoutMissingColumn` (works before a
  migration has run). `DEFAULT_PHOTOGRAPHER_ID` (`'default'`) is Tim's own account (`PHOTOGRAPHER_TOKEN`);
  other photographers are accounts with a session (`docs/multi-photographer.md`).
- `worker/test/*.test.mjs` (`fakes.mjs` = fake D1/R2, `pick-helpers.mjs`):
  `delivery.test.mjs` = deliver / undeliver / reopen / finals gate,
  `pick-marks.test.mjs` = pins, `pick-gate.test.mjs` = what a link may read.
- `js/pick.js` guest page (picking, pins, delivery gallery); `js/project-view.js`
  photographer review view (`index.html?project=<id>`); `js/app.js` shared photo
  grid + preview modal; `js/annotation.js` pin drawing; `js/selection-export.js`
  CSV for the retoucher; `js/auth.js` login overlay.
- `js/guest-tour.js` first-visit tour on the guest pick page (`FORCE_DEFAULT` /
  `window.GUEST_TOUR_FORCE` = test switch; off = first visit only); `js/completion-page.js`
  the 完成頁; `js/guest-order.js` the guest order sheet (S2); `css/side-nav.css` the
  photographer pages' shared menu and phone layout.
- `admin.html` project list/detail (delivery block, orders, downloads);
  `upload.html` upload; `book_editor/` album editor (own CSS `book_editor.css`,
  not `css/styles.css`); `test/run.mjs` the browser-suite runner (suites live in
  `test/suites/NN-<topic>.mjs`, shared helpers/fakes in `test/lib/`; `test/README.md`).
- D1 backup / restore / migration check: `docs/backup.md` (`.github/workflows/d1-backup.yml`,
  `d1-time-travel.yml`; `worker/tools/`: `gen-migration-check.mjs` → `check-migrations.sql`,
  `verify-backup.mjs`, `prune-backups.mjs`).
- Album layout, guest → photographer (2026-10-30): `js/album-layout-view.js` (the 「查看排版」 read-only viewer on order cards),
  `book_editor/js/import_layout.js` (「匯入 book editor」), `js/xmp-export.js` (轉出精挑相片 XMP, `docs/xmp-export.md`). Browser suites
  `test/suites/99t-album-edit.mjs`, `99u-order-layout-view.mjs`, `99v-import-layout.mjs`, `99w-xmp-export.mjs`; unit tests `test/unit/*.test.mjs`
  (`node --test test/unit/*.test.mjs`, CI does not run them); worker `worker/test/guest-album-layout.test.mjs`.

## Talking with Tim
- Reply in Traditional Chinese, short: what's wrong, how to fix it.
- Evaluate fairly. Don't just agree — give your own view and the trade-off.
- Don't guess Tim's local time.
- Tim often can't verify from outside; say what still needs a real phone / prod check.
- Discussion-only requests ("先不動 code") mean no code changes.
- **After every merge to main, end the reply with 「合併後你要確認」**: a checklist
  of what Tim must do or check, specific to this merge, not generic:
  1. GitHub Actions deploy succeeded (the agent cannot see it).
  2. D1 migrations: which ones this merge needs and whether they were confirmed
     (say "none" if none).
  3. Purge Everything needed or not (needed when static files or the Worker changed;
     docs-only merges: not needed, say so).
  4. Real phone / prod checks for what this merge changed (iPhone, LINE in-app
     browser, Safari, Excel, etc.), with the expected result of each.
  5. What was NOT verified, and any decision still waiting on him.

## Roles and models (pick by the cost of a mistake)
| Role | Model | Used for |
|---|---|---|
| Orchestrator (main session) | — | split tasks, verify every agent report (never take it on faith), commit |
| Worker developer | opus | auth, tokens, gates, data writes, money |
| Frontend developer | sonnet | UI with a clear scope |
| Security reviewer | opus | adversarial review of risky changes |
| Mechanical work | haiku | version bumps, running suites, collating |

## Risk tiers
| Tier | Examples | Process |
|---|---|---|
| High | permissions, tokens, data writes, fees | opus, full TDD, ~10 mutants, security review |
| Normal | new UI | sonnet, related tests only while developing, ~5 mutants, no security review |
| Tiny | text, style, 1–2 line fixes | orchestrator edits directly, no agent |

Code for High and Normal work is written by agents (in worktrees, TDD, see "Working with agents"); the
orchestrator splits, verifies and merges. Tim says when to merge.

## TDD (always)
1. Write the failing test first; confirm it fails for the right reason.
2. Implement until green.
3. Mutation-test the new code (syntax-check each mutant first — see the worker
   command below). Every mutant killed or explained as equivalent.
4. While developing run only related tests (`ONLY=` for the browser, the worker suite takes seconds).
   Before commit/merge run what the change's risk calls for (table below), not always everything.

### Which tests before commit/merge
| What changed | Run |
|---|---|
| text, style, one small page fix | the related suites + the worker suite |
| an ordinary feature (one page / one flow) | the related suites + their neighbours + the worker suite |
| shared files (`css/styles.css`, `js/app.js`, `test/lib/`, the harness), the Worker, permissions, tokens, data writes, money | the full browser suite via `run-parallel` + the worker suite |

The full suite runs at most once per merge, only through `run-parallel` (never the old
single-process run, never hand-split groups). Never skip or delete a test to get green.

Commands:
- Worker (seconds): `node --test "worker/test/*.test.mjs"`, and
  `node --input-type=module --check < worker/worker.js`.
  **Plain `node --check worker/worker.js` is not enough**: there is no package.json,
  so the file is read as CommonJS and a missing paren still exits 0 (verified).
- Album layout engine (seconds, CI does not run it): `node --test book_editor/test/auto_layout.test.mjs`
- Album spread templates + planner (seconds, CI does not run it): `node --test book_editor/test/spread_templates.test.mjs book_editor/test/plan_spreads.test.mjs`
  (all three: `node --test book_editor/test/*.test.mjs`); PNG overview of the library: `node book_editor/test/render-templates.mjs <outDir>`
- Browser, related suites (fast): `NODE_PATH=/tmp/pwinstall/node_modules ONLY=<text in suite name> node test/run.mjs`
  (a filter matching nothing fails; `test/README.md`)
- Browser, full suite (~10 min, 3 parallel workers): `NODE_PATH=/tmp/pwinstall/node_modules node test/run-parallel.mjs`
  (`JOBS=4` is faster but less proven; a file that throws or hangs is reported as FAIL and the run goes on).
  Size on 2026-10-29 (full run): browser 120 files / 1446 suites; worker 1912 tests. (2026-10-21, d713634: browser 114 files /
  1353 suites, 684 s, all green; worker 1831 tests.)
  - Playwright lives outside the repo; Chromium at /opt/pw-browsers. In the cloud
    session `/tmp/pwinstall` does not exist: use `NODE_PATH=/opt/node-tools/node_modules`.
- CI runs the worker suite only, not the browser suite.

Known false-pass shapes — assert the positive case too:
- an absent element passes a `!== 'shown'` check
- `.btn{display:inline-flex}` beats `hidden` → remove from DOM, check computed display
- element present but in the wrong container
- `addInitScript` re-seeding on navigation
- fixture refused by an earlier guard, so the guard under test never runs
- test fake diverging from the real API (the 206 bug) — fakes mirror real responses

Suites 36, 50, 51 and 52 used to fail on every run; fixed at the root in 98eaec9 (36), f78b0b0 (50/51),
0efe67f + a71e81d (52), and two full `run-parallel` runs after that were all green (106 files, 1301 suites). If one
of them fails now, treat it as a regression, not as a known flake.
Known flaky: book_editor "no token is minted for an empty folder set" fails under load.
Also seen under load, green alone (3/3 on HEAD): admin "plan 編輯方案…" and admin
"the list row picks up 精修中 too, not just the detail panel".
Also flaky under load, reproduced on the pre-pins base feb9bd4 (5 of 8 runs red alone): suite 10
"mobile preview — preloads i±1/i±2 … at the responsive width bucket (1200 on a 390px/DPR3 phone)".
Also seen under load, green 3/3 alone: suite 10 "mobile preview — a fast burst of navigation only preloads around where it settles"
(seen once more under load by 2026-10-21, green when re-run alone).
Seen once under load (by 2026-10-21), green when re-run alone: suite 83 "unified login — r2_designer overlay: an account
that must change its password lands on settings.html with must:true stored".
Seen once in a full run, green 3/3 alone and in all 126 admin suites together: admin "訂單品項是平台商品：單價不能低於平台價（below_platform_price）…" (a 4000ms waitForFunction timeout).
Also flaky, seen on the base too (c574078 failed 2 of 3 alone; 1 of 3 on HEAD): "guest tour lightbox (390px) … step 3/7 (navigation)" (the ring position on the real prev/next controls).
Also seen once under load, green alone: dashboard "全部待處理歸零…" (3000ms waitForURL timeout). When the full suite shows
only these, re-run the failing suite alone with `ONLY=` before calling it a regression.
In the cloud session on 2026-10-29/30 the full run-parallel shows 7 failures that also fail on the untouched base cfdeb49: suite 10
(mobile preview preload i±1/i±2, 2), suite 26 (album preview 1280px "one analysis per photo again" 3 + album preview 390px "tapping 下一頁 flips" 1),
suite 61 (成果相簿燈箱（手機）loading ring, 1). Not confirmed on Tim's machine.

Visual/contrast tests need a floor on how many elements were scanned, or an
empty scan passes.

## Working with agents
- Check the agent's base before it starts: its worktree can be created from an
  older commit than the branch you are on (an opus worker once started on
  03baff3 and lacked the commit it was meant to build on). Tell it to run
  `git log` first and report a wrong base instead of resetting on its own.
- One agent per file area; agents commit in their own worktree, never push, never
  touch main, never bump `?v=`. The orchestrator merges, resolves conflicts,
  bumps `?v=` once, runs everything, then pushes the `claude/<topic>` branch.
- Browser suites live in `test/suites/NN-<topic>.mjs` (`test/run.mjs` is only the
  runner): a new suite goes in its own new file there, not into an existing one, so
  parallel agents do not conflict. If two agents did touch the same suite file, merge
  them one at a time and `node --check` that file after resolving.
- Reports are not evidence: re-run the suites and read the diff yourself.
- `.claude/worktrees/` holds the agents' worktrees; keep it out of commits
  (`.git/info/exclude`).

## Invariants (a mistake here leaks data)
- A project is delivered **only** when `delivered_at` is set. `final_folders` being
  non-null does not mean delivered: it is the last chosen finals folders and
  stays after 取消交件 and 開放修改 (reopen). Both clear `delivered_at` only.
- `client_confirmed_at` is only set while delivered and never automatically.
  Every deliver (repeat 更換精修 too), undeliver and reopen clears it (and
  `_by`) in the same write; every deliver and every confirm resolves the open
  `revision_requests` in the same batch. Confirmed never coexists with an open
  request (`docs/delivery.md`, client confirmation).
- Every guest read of finals goes through `pickFinals` (needs `delivered_at`).
  A new read path must not bypass it; admin routes may return `final_folders`,
  guest routes must not.
- Retouch pins are `selections.marks` = `[{x,y,note}]`, x/y as 0–1 fractions of
  the photo. An empty note is allowed on purpose (a bare pin can be the message).
- Photographer pages use home.html's cream theme (`--bg:#fff8ee`); client pages stay
  dark, except the 完成頁 (a delivered project the client has confirmed): light,
  scoped under `.cp` in `css/completion-page.css` (`js/completion-page.js`). Never
  change `css/styles.css`'s global `:root`: `index.html` serves guests and the
  photographer's review view.
- Album page counts are in SPREADS (one spread = 1 P; cover and back not counted):
  `platform_products.min_pages` / `max_pages`, `planSpreads` `minSpreads` / `maxSpreads`.
  Not enforced on any order yet (no guest order path): `albumPagesProblem` in the
  Worker is the ready helper for S3 (`docs/guest-shop.md`).

- Revision rounds are `revision_requests` rows. `marks` / `finals` / `message` / `message_auto` are written
  once by the submit `INSERT` and never updated; the only `UPDATE revision_requests` allowed sets
  `resolved_at` (a worker test scans for this). Draft pins (`revision_pins`) count only while their
  `delivery_at` and `delivery_finals` equal the project's; at most one round is open at a time.
- The one guest read outside `pickFinals`: `GET /api/pick/rounds/:id/photo` serves `_thumbs/400|1200/<key>.thumb`
  (never an original, never a download) of a key at index `i` of one of this project's frozen snapshots, to the
  seat owner only, only while delivered. It never takes a key from the request. `pickReadScope`, the object
  route and `?list=` must not learn about old rounds. Thumbnails are served only as jpeg/png/webp/avif.

- Guest ordering (S2) is built but dark: `GUEST_ORDERS` in `worker/wrangler.toml` is `off`
  (`pilot` + `GUEST_ORDERS_PILOT` project ids, or `on`); any other value, a typo included,
  counts as off. Before it is turned on, `2026-10-09-guest-orders.sql` (11 statements, one by
  one) must have been run and the privacy notice reviewed (`docs/guest-shop.md`).
- A guest album layout (`order_items.layout`, v2) is the Worker's own serialisation (`albumLayoutV2`). Every photo key in it must be a
  real object in the delivered finals; a non-cancelled order's layout locks those photos. Guest routes never return the layout object
  (they show only its spread count); only the admin read does.

## Decided not to do (do not re-propose without new evidence)
- Service / Package / Template, quotes, contracts, booking, CRM: scope creep.
  The studio defaults copied into each project already are the minimal template.
- Revision deadlines, round limits and auto-complete on expiry: wait for real jobs.
  Auto-completing for a client who did nothing is a trust risk.
- Renaming an R2 folder (every object copied and deleted; folders are snapshotted
  into projects, share tokens and selections, so it breaks them). Rename the project.
- Deleting a pin when its note is left empty.
- Social auto-posting. Per-version retouch tables (use folders).

## Git / deploy
- Work on a `claude/<topic>` branch. Push to main only when Tim says so —
  pushing main deploys (worker tests, SFTP static files, `wrangler deploy`).
- D1 migrations are hand-run by Tim in the D1 Console **before** the merge
  that needs them. Schema changes are append-only (`ALTER TABLE ... ADD COLUMN`);
  put the SQL in `worker/migrations/` and note it in `worker/schema.sql`.
  Every new migration: re-run `node worker/tools/gen-migration-check.mjs` to regenerate
  `worker/tools/check-migrations.sql`, or the worker test `migration-check.test.mjs` (CI) fails.
  Which migrations prod has run: `docs/backup.md` §四.
- Bump the asset `?v=` stamp on every frontend change.
- After deploy: Cloudflare → imhoti.tw → Caching → Purge Everything.
- Never put PHOTOGRAPHER_TOKEN or any secret in `js/config.js` (it is public).

## Standing facts
- R2 lifecycle (Tim's decision, 2026-10-25; not verified from here, confirm in Cloudflare): the
  180-day *delete* rule is replaced by one that moves objects to Infrequent Access (storage class
  only; reads work as before, reads cost extra). Nothing in R2 should expire on its own; only
  proofs are auto-deleted, by the daily cron, when the photographer sets a retention (default
  off, finals never; `docs/delivery.md` "Proof retention").
- The r2.dev public URL is disabled; all reads go through the Worker's token gates.
- `photographer_id` exists on projects; 'default' is Tim. Other photographers can sign up with an
  operator invite code (`PHOTOGRAPHER_ROUTES = "on"`); open self sign-up is still off
  (`PHOTOGRAPHER_SIGNUP = "off"`). `docs/multi-photographer.md` says what is built and what is not.
