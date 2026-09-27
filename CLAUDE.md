# imge_picker — working agreement

Photographer's photo-picking studio at imhoti.tw/studio. Cloudflare Worker
(`worker/worker.js`) + R2 bucket `imagepicker` + D1 `imagepicker-db`, vanilla
JS frontend. Feature designs live in `docs/` (e.g. `docs/guest-picking.md`).

## Talking with Tim
- Reply in Traditional Chinese, short: what's wrong, how to fix it.
- Evaluate fairly. Don't just agree — give your own view and the trade-off.
- Don't guess Tim's local time.
- Tim often can't verify from outside; say what still needs a real phone / prod check.
- Discussion-only requests ("先不動 code") mean no code changes.

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
3. Mutation-test the new code (`node --check` each mutant first). Every mutant
   killed or explained as equivalent.
4. While developing run only related tests; **run everything before commit/merge.**

Commands:
- Worker (seconds): `node --test "worker/test/*.test.mjs"`, and `node --check worker/worker.js`
- Browser (minutes): `NODE_PATH=/tmp/pwinstall/node_modules node test/run.mjs`
  - Only matching suites: `ONLY=<text in suite name> ...` (a filter matching nothing fails)
  - Playwright lives outside the repo; Chromium at /opt/pw-browsers.
- CI runs the worker suite only, not the browser suite.

Known false-pass shapes — assert the positive case too:
- an absent element passes a `!== 'shown'` check
- `.btn{display:inline-flex}` beats `hidden` → remove from DOM, check computed display
- element present but in the wrong container
- `addInitScript` re-seeding on navigation
- fixture refused by an earlier guard, so the guard under test never runs
- test fake diverging from the real API (the 206 bug) — fakes mirror real responses

Known flaky: book_editor "no token is minted for an empty folder set" fails under load.

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
