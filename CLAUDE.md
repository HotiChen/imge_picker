# imge_picker — working agreement

Photographer's photo-picking studio at imhoti.tw/studio. Cloudflare Worker
(`worker/worker.js`) + R2 bucket `imagepicker` + D1 `imagepicker-db`, vanilla
JS frontend. Feature designs live in `docs/` (e.g. `docs/guest-picking.md`).

**The roadmap is `docs/backlog.md` → "THE ORDER": the only main line.** Run real
jobs end to end first; no new big feature outside that list.

## Where things are (grep the names; line numbers drift)
- `worker/worker.js` (one file, ~3.8k lines): `resolveShareToken` (every link/token
  lookup), `pickReadScope` / `pickFinals` (what a guest link may read — the gate),
  `/api/admin/projects…` (photographer routes, `isAdminToken`), `/api/pick/state`
  and `?list=` / object reads (guest side), `withoutMissingColumn` (works before a
  migration has run). `DEFAULT_PHOTOGRAPHER_ID` is the single-tenant placeholder.
- `worker/test/*.test.mjs` (`fakes.mjs` = fake D1/R2, `pick-helpers.mjs`):
  `delivery.test.mjs` = deliver / undeliver / reopen / finals gate,
  `pick-marks.test.mjs` = pins, `pick-gate.test.mjs` = what a link may read.
- `js/pick.js` guest page (picking, pins, delivery gallery); `js/project-view.js`
  photographer review view (`index.html?project=<id>`); `js/app.js` shared photo
  grid + preview modal; `js/annotation.js` pin drawing; `js/selection-export.js`
  CSV for the retoucher; `js/auth.js` login overlay.
- `admin.html` project list/detail (delivery block, orders, downloads);
  `upload.html` upload; `book_editor/` album editor (own CSS `book_editor.css`,
  not `css/styles.css`); `test/run.mjs` the browser-suite runner (suites live in
  `test/suites/NN-<topic>.mjs`, shared helpers/fakes in `test/lib/`; `test/README.md`).

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

## TDD (always)
1. Write the failing test first; confirm it fails for the right reason.
2. Implement until green.
3. Mutation-test the new code (syntax-check each mutant first — see the worker
   command below). Every mutant killed or explained as equivalent.
4. While developing run only related tests; **run everything before commit/merge.**

Commands:
- Worker (seconds): `node --test "worker/test/*.test.mjs"`, and
  `node --input-type=module --check < worker/worker.js`.
  **Plain `node --check worker/worker.js` is not enough**: there is no package.json,
  so the file is read as CommonJS and a missing paren still exits 0 (verified).
- Album layout engine (seconds, CI does not run it): `node --test book_editor/test/auto_layout.test.mjs`
- Album spread templates + planner (seconds, CI does not run it): `node --test book_editor/test/spread_templates.test.mjs book_editor/test/plan_spreads.test.mjs`
  (all three: `node --test book_editor/test/*.test.mjs`); PNG overview of the library: `node book_editor/test/render-templates.mjs <outDir>`
- Browser (minutes): `NODE_PATH=/tmp/pwinstall/node_modules node test/run.mjs`
  - Only matching suites: `ONLY=<text in suite name> ...` (a filter matching nothing fails)
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

Known flaky: book_editor "no token is minted for an empty folder set" fails under load.
Also seen under load, green alone (3/3 on HEAD): admin "plan 編輯方案…" and admin
"the list row picks up 精修中 too, not just the detail panel".
Also flaky under load, reproduced on the pre-pins base feb9bd4 (5 of 8 runs red alone): suite 10
"mobile preview — preloads i±1/i±2 … at the responsive width bucket (1200 on a 390px/DPR3 phone)". When the full suite shows
only these, re-run the failing suite alone with `ONLY=` before calling it a regression.

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
- Bump the asset `?v=` stamp on every frontend change.
- After deploy: Cloudflare → imhoti.tw → Caching → Purge Everything.
- Never put PHOTOGRAPHER_TOKEN or any secret in `js/config.js` (it is public).

## Standing facts
- R2 lifecycle deletes every object 180 days after upload (whole bucket, no
  prefix). Anything meant to last (logos, long-term copies) must live elsewhere.
- The r2.dev public URL is disabled; all reads go through the Worker's token gates.
- `photographer_id` exists on projects ('default' today); multi-photographer is the goal.
