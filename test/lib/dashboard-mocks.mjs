// The dashboard / settings Worker mock and the studio_token seeders shared by the settings suites.
// Shared by more than one file in test/suites/; helpers used by a single suite file stay in that file.
import { PIXEL } from './env.mjs';
import { isExtraMaxFake, settingsShapeFake } from './pick-fake.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// Studio entrance — home.html, dashboard.html, settings.html
// (docs/dashboard-settings.md backs dashboard.html/settings.html;
// home.html's login reuses admin.html's own token check, now against
// GET /api/admin/settings instead of /api/admin/clients).
// ═══════════════════════════════════════════════════════════════════════════

export function dashSettingsMock(opts = {}) {
  const token = opts.token ?? 'adm';
  const state = {
    settings: Object.assign({
      studio_name: null, booking_url: null, default_pick_limit: null, default_extra_price: null,
      default_extra_max: null,
      has_logo: false, logo_type: null, logo_updated_at: null, updated_at: null,
    }, opts.settings || {}),
    stats: opts.stats || {
      by_phase: { picking: 0, submitted: 0, retouching: 0 }, delivered: 0, archived: 0,
      per_month: [], todo: { submitted_not_retouching: 0, unnotified_submissions: 0, modified_after_submit: 0 },
    },
    projects: opts.projects || [],
    settingsPutStatus: opts.settingsPutStatus || 200,
    settingsPutBody: opts.settingsPutBody || null,
    logoPutStatus: opts.logoPutStatus || 200,
    logoPutBody: opts.logoPutBody || null,
    deliverStatus: opts.deliverStatus || 200,
    deliverBody: opts.deliverBody || null,
  };
  const seen = [];
  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const method = req.method();
      const h = await req.allHeaders();
      const auth = h['authorization'] ?? null;
      let body = null;
      try { body = JSON.parse(req.postData() || 'null'); } catch (e) { /* not JSON, e.g. a logo PUT */ }
      seen.push({ method, path: u.pathname, auth, body });
      const json = (data, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });

      if (u.pathname === '/api/studio/logo') // public — no auth required
        return route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
      if (auth !== `Bearer ${token}`) return json({ error: 'Unauthorized' }, 401);

      if (u.pathname === '/api/admin/settings' && method === 'GET') return json({ transfer_info: null, ...settingsShapeFake(state.settings) });
      if (u.pathname === '/api/admin/settings' && method === 'PUT') {
        if (state.settingsPutStatus !== 200) return json(state.settingsPutBody || { error: 'bad' }, state.settingsPutStatus);
        // transfer_info (worker.js transferInfoValue / paragraphText): a string of at most 500 characters, line breaks kept,
        // trimmed, '' / null clears, a control character -> 400 invalid_transfer_info; before the migration a PUT naming it -> 500 orders_unavailable
        if ('transfer_info' in (body || {})) {
          const v = body.transfer_info;
          const bad = v !== null && (typeof v !== 'string' || [...v].length > 500 || /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(v));
          if (bad) return json({ error: 'transfer_info 格式不正確', code: 'invalid_transfer_info' }, 400);
          if (opts.ordersMigrated === false) return json({ error: '客人訂購功能尚未啟用', code: 'orders_unavailable' }, 500);
          body = { ...body, transfer_info: v === null || !v.trim() ? null : v.trim() };
        }
        // default_extra_max: null or a whole number 0-500, else 400 (nothing written)
        if ('default_extra_max' in (body || {}) && body.default_extra_max !== null && !isExtraMaxFake(body.default_extra_max))
          return json({ error: 'default_extra_max must be a whole number from 0 to 500', code: 'invalid_default_extra_max' }, 400);
        Object.assign(state.settings, body);
        return json(settingsShapeFake(state.settings));
      }
      if (u.pathname === '/api/admin/settings/logo' && method === 'PUT') {
        if (state.logoPutStatus !== 200) return json(state.logoPutBody || { error: 'bad' }, state.logoPutStatus);
        state.settings.has_logo = true;
        return json({ ok: true, has_logo: true, logo_type: 'image/png', logo_updated_at: '2026-09-27T00:00:00.000Z', size: 1 });
      }
      if (u.pathname === '/api/admin/settings/logo' && method === 'DELETE') {
        state.settings.has_logo = false;
        return json({ ok: true, has_logo: false });
      }
      if (u.pathname === '/api/admin/stats' && method === 'GET') return json(state.stats);
      if (u.pathname === '/api/admin/projects' && method === 'GET') return json({ projects: state.projects });
      if (/^\/api\/admin\/projects\/[^/]+\/deliver$/.test(u.pathname) && method === 'POST')
        return json(state.deliverBody || { ok: true, delivered_at: '2026-09-27T00:00:00.000Z' }, state.deliverStatus);
      if (/^\/api\/admin\/projects\/[^/]+\/undeliver$/.test(u.pathname) && method === 'POST')
        return json({ ok: true, delivered_at: null });
      return json({});
    });
  };
  return { state, seen, attach };
}

// addInitScript re-seeds on every navigation within the context (a known
// false-pass shape, see CLAUDE.md) — fine for a suite that stays on one
// authenticated page, but wrong for the logout suite, which navigates away
// to home.html and needs the token to actually stay gone there. So this one
// skips home.html; the "already logged in" home.html suite below seeds
// unconditionally instead.
export const SEED_TOKEN = () => {
  if (!location.pathname.endsWith('/home.html')) sessionStorage.setItem('studio_token', 'adm');
};
export const SEED_TOKEN_ALWAYS = () => sessionStorage.setItem('studio_token', 'adm');
