# Project defaults and per-project plan (decided with Tim 2026-09-30)

A photographer sets **defaults once** (settings); every new project starts from
them and each project can then be **edited on its own**. Today `pick_limit` and
`extra_price` exist on `projects` but can only be set at creation (no update
route), and `studio_settings.default_pick_limit` / `default_extra_price` only
prefill the create form.

## The plan fields

| Field | Meaning | Default | Where |
|---|---|---|---|
| `pick_limit` | photos included in the plan (張數); NULL = unlimited | settings `default_pick_limit` | exists |
| `extra_price` | NT$ per extra photo; NULL = not shown | settings `default_extra_price` | exists |
| **`extra_max`** | how many photos the guest may pick **above** `pick_limit`; **0 = no extra picks** | **10** | new |
| `promo_days`, `promo_percent` | delivery promo window / discount (docs/guest-shop.md) | settings | later (S1) |
| `shipping_fee` | NT$ added to a shipped order (docs/guest-shop.md) | settings | later (S2) |
| `max_pickers` | how many people may pick on one link (1 first person + collaborators; the co-picking feature, not built yet) | **2** (a couple); raise per project for a family portrait | later (collaborators) |

Columns are added by append-only `ALTER`s, hand-run in the D1 Console before
the merge that needs them (`projects.extra_max`,
`studio_settings.default_extra_max`; the promo and shipping columns come with
their own stages).

## Extra-pick cap (checked at submit, since 2026-09-30)

- The guest may **send** at most **`pick_limit + extra_max`** ♥ photos.
  `pick_limit` NULL → no plan cap (only the existing 500 system cap).
  `extra_max` NULL (every project created before this feature) → **no plan cap
  either** — existing projects behave exactly as today.
- **♥ is never limited by the plan (Tim).** Guests heart 100+ photos in a
  first round and narrow down over days; every save is a draft, limited only
  by the system caps (`selection_cap` 500, `row_cap` 1000, `marks_cap` 300).
- **Enforced by the Worker at submit** (`POST /api/pick/submit`), inside the
  submit's own conditional writes: over the cap → 409
  `{error, code: 'pick_cap', count, max, over, limit, extra_max}`, nothing
  written (see "Worker contract" below). The guest un-hearts and submits again.
- `GET /api/pick/state` exposes `extra_max` and the resulting `max_picks` so the
  page can say 「已選 42 / 40 張（最多可加選到 50）」 and, above `max_picks`,
  tell the guest how many to remove before submitting.
- The over-plan price warning at submit (already built) is unchanged.

## Editing a project's plan

- New admin route (extend `PATCH /api/admin/projects/:id`, which until now
  accepted exactly one key, `allow_proof_download`): the body may carry any subset of
  `allow_proof_download`, `pick_limit`, `extra_price`, `extra_max`; validated
  like project creation (safe integers ≥ 0; `extra_price` ≤ `MONEY_MAX`;
  `pick_limit`/`extra_price` may be `null`); unknown keys → 400 `invalid_body`;
  another photographer's project → 404; archived projects refuse.
- Allowed in every phase. Submissions keep the plan **as it stood at submit**
  (already snapshotted); the start-retouch extra-pick fee reads that snapshot,
  so an edit only affects later submits.
- Lowering `pick_limit` / `extra_max` below the current picks is allowed (see
  above). The photographer's project detail gets a 「編輯方案」 form (張數,
  加挑單價, 最多可加選) and the create form gets 最多可加選 (prefilled from
  settings, default 10). Settings gets the default 「最多可加選」.
- Security tier: High (guest write gate). TDD, mutants, security review.

## Worker contract (built 2026-09-30)

Migration `worker/migrations/2026-09-30-extra-max.sql` (hand-run in the D1
Console **before** the merge; not re-runnable — a second run fails with
"duplicate column name"):

```sql
ALTER TABLE projects ADD COLUMN extra_max INTEGER;                -- NULL = no plan cap
ALTER TABLE studio_settings ADD COLUMN default_extra_max INTEGER; -- NULL = unset (10)
```

Constants in `worker.js`: `EXTRA_MAX_MAX = 500`, `EXTRA_MAX_DEFAULT = 10`.

**Settings** — `GET/PUT /api/admin/settings` carry `default_extra_max`
(stored value, `null` = unset) and, read-only, `effective_default_extra_max`
(what a new project gets: the stored value, else **10**). PUT accepts `null`
or a safe integer 0–500; anything else → 400
`{error, code: 'invalid_default_extra_max'}`, nothing written.

**Create** — `POST /api/admin/projects` takes optional `extra_max`:
- a safe integer 0–500 → stored; `null` → stored NULL (no plan cap, like a
  project from before the feature);
- anything else → 400 `{error: 'extra_max must be a whole number from 0 to 500'}`,
  no project, no link;
- **left out** → the studio's `default_extra_max` (if it is a valid 0–500
  value), else 10.

The response's `project` carries `extra_max` (what was stored). The list
(`GET /api/admin/projects`) now carries `pick_limit`, `extra_price` and
`extra_max` per row; the detail carries `extra_max` in `project`. `null` for
projects from before the feature.

**Edit** — `PATCH /api/admin/projects/:id`, body = any **non-empty** subset of

| Key | Accepts |
|---|---|
| `allow_proof_download` | `true` / `false` |
| `pick_limit` | `null` or a safe integer ≥ 0 |
| `extra_price` | `null` or a safe integer 0–`MONEY_MAX` (10,000,000) |
| `extra_max` | `null` or a safe integer 0–500 |

- Any other key, a bad value (strings, floats, negatives, booleans for
  numbers, over the bound), `{}`, a non-object or unparseable JSON → **400**
  `{error, code: 'invalid_body'}`, nothing written (one bad key spoils the
  whole body).
- One `UPDATE ... WHERE id = ? AND photographer_id = 'default'` (+ `AND
  archived_at IS NULL` when a plan key is present). Unknown or another
  photographer's project → **404**.
- Archived: a body with any plan key → **409**
  `{error: 'Project is archived; unarchive it first', code: 'archived'}`,
  nothing written. A body of **only** `allow_proof_download` still works on an
  archived project, exactly as before this change.
- Allowed in every phase (`picking`, `submitted`, `retouching`, delivered).
- 200 `{ok: true, ...each key sent: the value now stored}` — e.g.
  `{ok: true, pick_limit: 30, extra_max: 5}`. The old
  `{allow_proof_download}` body answers `{ok: true, allow_proof_download}` as
  before.
- `PUT`/`POST /api/admin/projects/:id` → 405 (401 without the admin token);
  before this a PUT fell through to the upload route.
- Submissions are never touched: each keeps the `pick_limit` / `extra_price`
  it snapshotted; only later submits see the new plan.

**Enforcement** — at **submit**, not at save (changed 2026-09-30,
docs/pick-handover.md §1).

- `PUT /api/pick/selections` has **no plan cap**: any number of ♥ photos
  saves, up to the system caps only (`selection_cap` 500, `row_cap` 1000,
  `marks_cap` 300, unchanged). A save never answers `pick_cap`.
- `POST /api/pick/submit`: the ♥ photos (rating ≥ 1 — exactly the photos
  the submit snapshots, counted inside the statement) must be ≤
  `pick_limit + extra_max` when both are non-NULL. The condition is part of
  every statement of the submit batch (the `INSERT` of the submission, the
  picker's contact-info `UPDATE`, the phase `UPDATE`), evaluated against the
  selections and the project row as they stand inside the transaction, so a
  save or a PATCH lowering the plan that lands after the route's reads is
  seen, and a save racing the submit cannot produce an over-cap submission.
  Refusal: **409**

```json
{"error": "目前選了 120 張，最多可送出 50 張（方案 40 + 加選 10）。請先取消 70 張再送出",
 "code": "pick_cap", "count": 120, "max": 50, "over": 70, "limit": 40, "extra_max": 10}
```

  `count` = ♥ photos now, `max` = `pick_limit + extra_max`, `over` =
  `count − max`. `extra_max = 0`: 「目前選了 43 張，此專案最多 40 張，不可加選。請先取消
  3 張再送出」. Nothing written: no submission row, no contact info on the
  picker, no phase change, `modified_after_submit` unchanged, no email.
  Rating-0 rows never count; exactly `max` goes through.
- **Repeats** (same photos and pins as the latest submission) are refused the
  same way when over a plan lowered since that submission — the plan is
  authoritative. **⚠ Tim's decision pending (docs/pick-handover.md open Q4);
  this is the recommended default, built and tested.** A repeat within the plan
  is still a repeat (no new row).

Refusal order at submit (the code's existing order, with `pick_cap` put
first among the caps): not the seat holder (403, before anything) → phase
(409 `retouching`, before anything) → the batch → on a refused batch, re-read:
archived since (401) → phase moved (409 `retouching`) → seat moved (403) →
**`pick_cap`** → `marks_cap` → `submission_cap`. `pick_cap` is first among the
caps because it is the one the guest can fix.

**State** — `GET /api/pick/state` `project` gains `extra_max` and
`max_picks` (= `pick_limit + extra_max`, `null` when either is NULL — the
number the submit enforces), for the owner and viewers alike.

**Before the migration**: every project is uncapped (the submit adds the plan
condition only when the project row has an `extra_max` column); saves, submit, state
(`extra_max: null, max_picks: null`), list and detail work; create stores no
`extra_max` (the response says `null`, even if the body sent one); settings
read `default_extra_max: null`. Only a PATCH naming `extra_max` or a settings
PUT naming `default_extra_max` answers **500**
`{error, code: 'extra_max_unavailable'}` with nothing written.

Tests: `worker/test/project-plan.test.mjs`.

## Why one place

Promo, shipping and future plan fields all follow the same rule — studio
default → copied into the project at creation → editable per project — so they
share this settings block and this edit form instead of each inventing its own.

## Known behaviour: an edit only reaches later *different* submits

A re-submit with the same photos and the same pins counts as a repeat and does
not store a new plan snapshot. So if the photographer changes `extra_price` or
`pick_limit` after the guest has submitted and the guest then re-submits
identical picks, start-retouch still creates the extra-pick order from the
older snapshot. This follows the rule above (submissions keep the plan as it
stood); if the photographer expects the new price, he corrects the order by
hand. Revisit if it bites in real jobs.
