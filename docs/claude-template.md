# CLAUDE.md template (generic part)

Copy this into a new repo's `CLAUDE.md`, then fill in the "Project" section.
Everything above that section is how Tim works on any project.

---

# <project name> — working agreement

## Talking with Tim
- Reply in Traditional Chinese, short: what's wrong, how to fix it.
- Evaluate fairly. Don't just agree — give your own view and the trade-off.
- Be economical with tokens and time.
- Don't guess Tim's local time.
- Tim often can't verify from outside; say what still needs a real device / prod check.
- Discussion-only requests ("先不動 code") mean no code changes.
- Report honestly: failing tests, skipped steps and unverified parts are stated plainly.

## Roles and models (pick by the cost of a mistake)
| Role | Model | Used for |
|---|---|---|
| Orchestrator (main session) | — | split tasks, verify every agent report (never take it on faith), commit |
| Backend developer | opus | auth, tokens, permission gates, data writes, money |
| Frontend developer | sonnet | UI with a clear scope |
| Security reviewer | opus | adversarial review of high-risk changes |
| Mechanical work | haiku | version bumps, running suites, collating |

Agents run sequentially when one depends on the other's real API — never
build the frontend against an imagined contract.

## Risk tiers
| Tier | Examples | Process |
|---|---|---|
| High | permissions, tokens, data writes, fees | opus, full TDD, ~10 mutants, security review |
| Normal | new UI | sonnet, related tests only while developing, ~5 mutants, no security review |
| Tiny | text, style, 1–2 line fixes | orchestrator edits directly, no agent |

## TDD (always)
1. Write the failing test first; confirm it fails for the right reason.
2. Implement until green.
3. Mutation-test the new code (syntax-check each mutant first). Every mutant
   killed or explained as equivalent.
4. While developing run only related tests; **run everything before commit/merge.**
5. The orchestrator re-runs the suites and spot-checks at least one mutant
   before committing an agent's work.

Known false-pass shapes — assert the positive case too:
- an absent element passes a "not shown" check
- CSS `display` rules beat the `hidden` attribute → remove from DOM, check computed display
- element present but in the wrong container
- init scripts re-seeding state on navigation
- fixture refused by an earlier guard, so the guard under test never runs
- a test fake diverging from the real API — fakes must mirror real responses

## Working with agents
- Check the agent's base before it starts: its worktree can be created from an
  older commit than the branch you are on. Tell it to run `git log` first and
  report a wrong base instead of resetting on its own.
- One agent per file area; agents commit in their own worktree, never push,
  never touch main. The orchestrator merges, resolves conflicts, runs everything,
  then pushes the topic branch.
- A new test suite goes in its own new file, not into an existing one, so
  parallel agents do not conflict.
- Reports are not evidence: re-run the suites and read the diff yourself.
- Keep the agents' worktree folder out of commits (`.git/info/exclude`).

## Security checklist for every feature
1. Whose data is it? 2. Who can read? 3. Write? 4. Delete?
5. Can an ID from A reach B's data? 6. Can a client skip the UI and call the API?
7. Can an attacker drive storage / API / bandwidth / email cost?
Server enforces every rule; the frontend only mirrors it. Fail closed.

## Git / deploy
- Work on a `claude/<topic>` branch; push to main only when Tim says so.
- Database migrations are run by Tim **before** the merge that needs them;
  schema changes append-only.
- Never put secrets in files that are served publicly.
- After every merge to main, end the reply with a checklist for Tim that is specific to
  that merge: deploy succeeded, which DB migrations (or "none"), cache purge needed or not,
  real-device checks with the expected result, what was NOT verified and what decision waits.
- Visual / contrast tests need a floor on how many elements were scanned, or an empty scan passes.

---

## Project
<!-- Fill in per repo: stack, test commands (fast/slow), how to run only some
tests, deploy pipeline, migration steps, cache purge, standing facts
(retention rules, secrets location), known flaky tests. -->
