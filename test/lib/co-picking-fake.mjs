// Co-picking (docs/co-picking.md) on the photographer's review view: wraps pickFakeWorker so that
// GET /api/admin/projects/:id answers like worker.js does now — `collaborators` (collaboratorView
// shape: picker_id, name, joined_at, expires_at, revoked_at, status, last_seen_at, renewal_requested_at)
// and, on every selection, `by` = pickAuthors(): {id, name, role: owner|collaborator|other} or null
// for an updated_by that is no picker of the project. Everything else is pickFakeWorker's own answer
// (its fulfill is intercepted, so the two never drift apart).
import { pickFakeWorker } from './pick-fake.mjs';

// opts: pickFakeWorker's, plus
//   collaborators: [{id, name, status?: 'active'|'expired'|'removed', joined_at?, expires_at?, revoked_at?}]
//   (each also becomes a picker row, as a join does), and
//   others: [{id, name}] — pickers that are neither owner nor collaborator (a seat holder before a reset)
export function coPickingFake(opts = {}) {
  const m = pickFakeWorker(opts);
  const members = (opts.collaborators || []).map((c, i) => ({
    picker_id: c.id, name: c.name, joined_at: c.joined_at || `2026-09-2${i + 1}T10:00:00.000Z`,
    expires_at: c.expires_at === undefined ? '2026-12-31T00:00:00.000Z' : c.expires_at,
    revoked_at: c.revoked_at || null, status: c.status || 'active',
    last_seen_at: null, renewal_requested_at: null,
  }));
  for (const c of members) m.state.pickers.set(c.picker_id, { id: c.picker_id, name: c.name, key: `${c.picker_id}-KEY` });
  for (const o of (opts.others || [])) m.state.pickers.set(o.id, { id: o.id, name: o.name, key: `${o.id}-KEY` });
  const memberIds = new Set(members.map(c => c.picker_id));
  const by = id => {
    const p = id == null ? null : m.state.pickers.get(id);
    if (!p) return null;
    const role = id === m.state.project.owner_picker_id ? 'owner' : memberIds.has(id) ? 'collaborator' : 'other';
    return { id, name: p.name, role };
  };
  const attach = page => m.attach({
    route: (pattern, handler) => page.route(pattern, (route, req) => handler(new Proxy(route, {
      get(target, prop) {
        if (prop !== 'fulfill') { const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v; }
        return o => {
          const u = new URL(target.request().url());
          if (!(o.status === 200 && target.request().method() === 'GET' && /^\/api\/admin\/projects\/[^/]+$/.test(u.pathname))) return target.fulfill(o);
          const data = JSON.parse(o.body);
          data.selections = data.selections.map(s => ({ ...s, by: by(s.updated_by) }));
          if (opts.noCollaboratorsField !== true) data.collaborators = members;
          return target.fulfill({ ...o, body: JSON.stringify(data) });
        };
      },
    }), req)),
  });
  return { ...m, attach, members };
}
