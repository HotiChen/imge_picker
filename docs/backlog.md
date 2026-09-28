# Backlog

Decided or discussed, not yet built. Newest decisions at the top of each group.

## Next up
- [ ] Phone test of guest picking + gestures (and the new bright entrance) on real LINE / iOS Safari (Tim).
      Watch: LINE's edge swipe-back vs swipe-right, zoom feel.
- [ ] Email notifications — code and `wrangler.toml` binding ready (branch
      `claude/vigilant-edison-ewegwm`). Tim, before merging:
      1. Cloudflare → imhoti.tw → Email → Email Routing: enable (check MX first).
      2. Destination addresses: add and verify the photographer's inbox.
      3. `wrangler secret put PHOTOGRAPHER_EMAIL` (or Worker → Settings → Secret).
      4. Merge, submit a test pick, check inbox + spam; admin 未寄信 should clear.
      Sender is `notify@imhoti.tw` (`NOTIFY_FROM` var). Until then admin shows 未寄信.

## Product roadmap (agreed order)
1. Back-office shell: side menu, dashboard (projects by phase, per month,
   to-do), add a 已交付 phase so "completed" can be counted.
2. Photographer accounts with real login (replaces the shared
   PHOTOGRAPHER_TOKEN). Record `referred_by` on each account from day one.
   Registration stays closed until a second photographer joins; then add
   cross-account isolation tests.
3. Settings: studio name, logo, default plan (張數, 加挑單價).
   Logo must NOT live in the `imagepicker` bucket (180-day lifecycle).
   Guest page shows the studio brand + a booking link.
4. Products and sales: catalogue (cost, price), orders per project. First
   version: orders recorded by hand, no payment gateway.
5. Referral payouts (single level only — never multi-level): A earns a share
   of B's sales, paid out of the platform's cut, time-limited (e.g. 12 months).
   Needs payments through the platform first; check tax/legal before launch.
6. Landing page (for photographers once multi-photographer is real).

## Deferred features
- Logo route per photographer (`/api/studio/:pid/logo`); today it always
  serves the default studio — fine until a second photographer exists.
- Strip bidi / zero-width characters from `studio_name` (spoofing only; admin-set).
- Registered-owner invites (editor / viewer) for a project.
- Link a registered client account to a pick seat (`pickers.user_id`).
- Long-term storage for registered owners — needs a separate bucket.
- Storage usage tracking per photographer (limit by GB, not album count).
- Cap the number of photo keys listed in the change-notification email.

## Technical debt / security
- Browser E2E suite in CI (fix the flaky book_editor "no token is minted for
  an empty folder set" first).
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
