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

Columns are added by append-only `ALTER`s, hand-run in the D1 Console before
the merge that needs them (`projects.extra_max`,
`studio_settings.default_extra_max`; the promo and shipping columns come with
their own stages).

## Extra-pick cap (this round)

- The guest may hold at most **`pick_limit + extra_max`** ♥ photos.
  `pick_limit` NULL → no plan cap (only the existing 500 system cap).
  `extra_max` NULL (every project created before this feature) → **no plan cap
  either** — existing projects behave exactly as today.
- **Enforced by the Worker** inside the same conditional write that already
  applies `selection_cap`/`row_cap` on `PUT /api/pick/selections`: refused with
  409 `{code: 'pick_cap', max, limit, extra_max}` (nothing written). Un-hearting
  and deleting always work. A project already above its cap (lowered later) keeps
  its picks; the guest just cannot add more.
- `GET /api/pick/state` exposes `extra_max` and the resulting `max_picks` so the
  page can say 「已選 42 / 40 張（最多可加選到 50）」 and, when the guest taps ♥
  at the cap, show 「已達可挑上限：方案 40 張 + 加選 10 張」. `extra_max = 0`
  reads 「不可加選」.
- The over-plan warning at submit (already built) is unchanged.

## Editing a project's plan

- New admin route (extend `PATCH /api/admin/projects/:id`, which today accepts
  exactly one key, `allow_proof_download`): the body may carry any subset of
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

## Why one place

Promo, shipping and future plan fields all follow the same rule — studio
default → copied into the project at creation → editable per project — so they
share this settings block and this edit form instead of each inventing its own.
