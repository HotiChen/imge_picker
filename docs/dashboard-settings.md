# Dashboard, delivered state and studio settings — backend

The back-office dashboard / delivered state and studio settings (both done; see the product roadmap in `docs/backlog.md`), Worker side. Guest picking itself
is in `docs/guest-picking.md`.

## Migration

`worker/migrations/2026-09-28-dashboard-settings.sql`, hand-run in the D1
Console **after** `2026-09-28-project-archive.sql` and **before** deploying the
Worker that reads it:

```sql
ALTER TABLE projects ADD COLUMN delivered_at TEXT;   -- not re-runnable ("duplicate column name")
CREATE TABLE IF NOT EXISTS studio_settings (
  photographer_id TEXT PRIMARY KEY, studio_name TEXT, booking_url TEXT,
  default_pick_limit INTEGER, default_extra_price INTEGER,
  logo BLOB, logo_type TEXT, logo_updated_at TEXT, updated_at TEXT
);
```

Until it runs: the project list, stats and settings routes fail (500). Pick
links keep working; `studio` reads as empty.

## Decisions

- **Delivered is a stamp, not a phase.** `projects.delivered_at`; the phase
  CHECK cannot change without a table rebuild. Deliver only from
  `retouching`, so a delivered project is a retouching project and every guest
  save/submit is refused with 409 `retouching`. `reopen` clears the stamp too
  (delivered always implies retouching).
- **Logo lives in D1**, not R2 (the bucket's lifecycle deletes after 180 days).
  ≤ 200 KB, PNG / JPEG / WebP decided by magic bytes only; the client's
  Content-Type is ignored and SVG/anything else is 415. Re-sniffed when served,
  so a hand-edited row cannot serve anything else.
- **booking_url** is https only (scheme case-insensitive), no whitespace or
  control characters, no `user:pass@`, ≤ 500 characters as typed and as
  re-serialised; stored as the URL parser's `href`. The guest page may put it
  in an `href` directly.
- `photographer_id` is always the Worker constant, never from a body.

## API

All `/api/admin/*` routes: `isAdminToken` (fails closed when
`PHOTOGRAPHER_TOKEN` is unset); pick, client, studio and session tokens → 401.
Responses carry `Cache-Control: private, no-store`.

| Route | Answer |
|---|---|
| `POST /api/admin/projects/:id/deliver` | `{ok: true, delivered_at}` (a repeat keeps the first stamp); 409 `{error, code: 'not_retouching', phase}` from picking/submitted; 404 unknown / other photographer |
| `POST /api/admin/projects/:id/undeliver` | `{ok: true, delivered_at: null}`; 404 |
| `GET /api/admin/projects` | rows gain `delivered_at` (detail has it via `project`) |
| `GET /api/admin/settings` | `{studio_name, booking_url, default_pick_limit, default_extra_price, has_logo, logo_type, logo_updated_at, updated_at}` — all null / `has_logo: false` before anything is set; never the blob |
| `PUT /api/admin/settings` | JSON; only the fields present change, `null` (or `''` for the strings) clears one, unknown fields ignored → same shape as GET. 400 `{error, code}` with `code` one of `invalid_studio_name` (not string/null, > 60 chars after trim), `invalid_booking_url`, `invalid_default_pick_limit`, `invalid_default_extra_price` (not a safe integer ≥ 0 or null); plain 400 for non-object JSON. Nothing written on any 400 |
| `PUT /api/admin/settings/logo` | raw bytes → `{ok: true, has_logo: true, logo_type, logo_updated_at, size}`; 413 `{code: 'too_large', max: 204800}`; 415 `{code: 'unsupported_type'}` |
| `DELETE /api/admin/settings/logo` | `{ok: true, has_logo: false}` (idempotent) |
| `GET /api/studio/logo` | public. The bytes, `Content-Type` = sniffed type, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`, `Cache-Control: public, max-age=300`, `ETag: "<logo_updated_at>"` (304 on `If-None-Match`); 404 when none. Other methods 405 |
| `GET /api/pick/state` | gains `studio: {name, booking_url, has_logo}` for owner and viewers (the project's own photographer's settings) |
| `GET /api/admin/stats` | see below |

Wrong method on `/api/admin/settings`, `/settings/logo`, `/stats` (with the
admin token) → 405.

### Stats

```json
{
  "by_phase": {"picking": 0, "submitted": 0, "retouching": 0},
  "delivered": 0,
  "archived": 0,
  "per_month": [{"month": "2026-09", "created": 0, "delivered": 0}],
  "todo": {"submitted_not_retouching": 0, "unnotified_submissions": 0, "modified_after_submit": 0}
}
```

- Scoped to this photographer. `by_phase` excludes archived projects;
  `retouching` there excludes delivered ones (in progress only).
- `delivered` = projects with `delivered_at`, archived included; `archived` =
  archived projects.
- `per_month`: exactly 12 entries, oldest first, ending with the current
  Asia/Taipei month (UTC+8, month boundaries at 16:00 UTC the day before).
  `created` by `created_at`, `delivered` by `delivered_at`; archived included.
- `todo` counts **projects**, non-archived: in `submitted`; with at least one
  submission newer than the last emailed one; with `modified_after_submit = 1`.
- Two SQL statements: one pass for the counts, one grouped query for months.
