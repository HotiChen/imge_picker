// The fake pick Worker: pickFakeWorker plus the small fakes that mirror worker.js validation.
// Every guest / project / delivery suite builds its world from this.
// Shared by more than one file in test/suites/; helpers used by a single suite file stay in that file.
import { PIXEL } from './env.mjs';
import { PHOTOS } from './editor-mocks.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// Guest picking (docs/guest-picking.md) — index.html?t=<pick token> and the
// admin.html project panel. The fake below mirrors the real routes' request
// and response shapes exactly (field names, status codes, error bodies) as
// worker.js implements them — see resolvePick/claim/selections/submit and
// the /api/admin/projects* routes — so a fake that drifts from the real API
// is the failure mode this suite exists to catch.
// ═══════════════════════════════════════════════════════════════════════════

export const PICK_RELATIONSHIPS = ['本人', '伴侶', '家人', '朋友', '其他'];
// Mirrors worker.js's own constants exactly (docs/guest-picking.md) — a photo
// key's shape, and the two caps a save is checked against.
export const PICK_PHOTO_KEY_MAX = 256;
export const PICK_KEY_CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;
export const PICK_MAX_SELECTIONS = 500;
export const PICK_MAX_ROWS = 1000;
export function pickKeyValidFake(key) {
  return typeof key === 'string' && [...key].length <= PICK_PHOTO_KEY_MAX &&
    !PICK_KEY_CONTROL.test(key) && !key.endsWith('/');
}
// How many of `subs` (oldest first) are newer than the last one flagged
// notified:1 — every one of them if none was. Mirrors PICK_UNNOTIFIED_SQL.
export function unnotifiedCountFake(subs) {
  let lastNotified = -1;
  subs.forEach((s, i) => { if (s.notified) lastNotified = i; });
  return subs.length - 1 - lastNotified;
}
export function pickTokenStatusFake(t, now = Date.now()) {
  if (t.revoked_at) return 'revoked';
  if (!Number.isFinite(Date.parse(t.expires_at)) || Date.parse(t.expires_at) <= now) return 'expired';
  return 'live';
}

// Mirrors worker.js's own `GET list` handling of R2's `delimiter: '/'`
// listing: everything under `prefix` that has no further '/' is a file,
// everything with one becomes a folder prefix (deduped). Used by fixtures
// that need real nested-subfolder shapes (docs/backlog.md "Guest page hides
// subfolders") rather than a hand-authored folders list per level.
export function delimitedListFake(files, prefix) {
  const data = [];
  const prefixSet = new Set();
  for (const key of files) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      data.push({ id: key, name: key.split('/').pop(), size: 1024, uploaded: '2026-01-01T00:00:00.000Z' });
    } else {
      prefixSet.add(prefix + rest.slice(0, slash + 1));
    }
  }
  return { data, folders: Array.from(prefixSet).sort() };
}

// Mirrors worker.js's pickReadScope: delivered = delivered_at AND a valid
// finals snapshot; a legacy stamp without one stays 'picking'.
export function pickScopeFake(project) {
  const finals = Array.isArray(project.final_folders) && project.final_folders.length ? project.final_folders : null;
  if (project.delivered_at && finals) {
    return { mode: 'delivered', finals, proofs: project.allow_proof_download ? project.folders : [] };
  }
  return { mode: 'picking', finals: [], proofs: project.folders };
}
// worker.js's finalFolders()/pickFolders(): trimmed, trailing '/', deduped;
// null when any entry cannot name a folder.
export function finalFoldersFake(value) {
  if (!Array.isArray(value) || !value.length) return null;
  const out = [];
  for (const f of value) {
    if (typeof f !== 'string' || !f.trim()) return null;
    const t = f.trim();
    const slashed = t.endsWith('/') ? t : t + '/';
    if (slashed.startsWith('/') || slashed.startsWith('_')) return null;
    const seg = slashed.split('/');
    if (seg.includes('..') || seg.includes('.')) return null;
    if ([...slashed].length > 256 || /[\x00-\x1f\x7f]/.test(slashed)) return null;
    if (!out.includes(slashed)) out.push(slashed);
  }
  return out;
}
// worker.js attachmentDisposition
export function attachmentFake(key) {
  const name = key.split('/').pop() || 'photo';
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

// worker.js's retouch-pin validation + canonical form (docs/guest-picking.md,
// "Retouch pins — the save contract"): an array of ≤ 10 plain objects, x/y
// finite JSON numbers in [0,1] (stored to 4 decimals), note optional, trimmed,
// ≤ 100 characters with no control / line-separator character; only
// {x, y, note} survive, in that order. null on any violation.
export const PICK_MARKS_MAX_FAKE = 10;
export const PICK_MARKS_TOTAL_MAX_FAKE = 300;
export function pickMarksCanonFake(marks) {
  if (!Array.isArray(marks) || marks.length > PICK_MARKS_MAX_FAKE) return null;
  const out = [];
  for (const m of marks) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
    for (const v of [m.x, m.y]) if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return null;
    let note = '';
    if (m.note !== undefined) {
      if (typeof m.note !== 'string') return null;
      note = m.note.trim();
      if ([...note].length > 100 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(note)) return null;
    }
    out.push({ x: Math.round(m.x * 10000) / 10000, y: Math.round(m.y * 10000) / 10000, note });
  }
  return out;
}

// Mirrors worker.js: the plan cap (pick_limit + extra_max), the settings shape
// and the PATCH/create validation (docs/project-plan.md, "Worker contract").
export const EXTRA_MAX_MAX_FAKE = 500, EXTRA_MAX_DEFAULT_FAKE = 10, MONEY_MAX_FAKE = 10000000;
export const isExtraMaxFake = v => Number.isSafeInteger(v) && v >= 0 && v <= EXTRA_MAX_MAX_FAKE;
// worker.js isShootDateInput: null / '' / a real 'YYYY-MM-DD' (years 1900-2100)
export const isShootDateInputFake = v => {
  if (v === null || v === '') return true;
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (y < 1900 || y > 2100) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
};
// projects.project_type (worker contract): null / '' = unset, else a string of 1-20 characters (the SHOOT_TYPES
// entries, or what was typed under 其他); a non-string or a longer one is 400 invalid_project_type.
export const isProjectTypeInputFake = v => v === null || v === '' || (typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 20);

export function settingsShapeFake(st) {
  const x = st.default_extra_max ?? null;
  return { studio_name: null, booking_url: null, default_pick_limit: null, default_extra_price: null,
    has_logo: false, ...st, default_extra_max: x,
    effective_default_extra_max: isExtraMaxFake(x) ? x : EXTRA_MAX_DEFAULT_FAKE };
}
// Mirrors worker.js revisionMessage (docs/delivery.md, client confirmation):
// CRLF/CR -> LF, tab -> space, every other control / line-separator character
// dropped, trimmed, 1-1000 characters (code points); null when it does not fit.
export function revisionMessageFake(v) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\r\n?/g, '\n').replace(/\t/g, ' ')
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, c => (c === '\n' ? c : '')).trim();
  if (!t || [...t].length > 1000) return null;
  return t;
}
export function pickFakeWorker(opts = {}) {
  const settings = { ...(opts.settings || {}) };
  const state = {
    settings,
    project: {
      id: opts.projectId || 'proj-1',
      title: opts.title ?? 'T 專案',
      pick_limit: opts.pickLimit ?? null,
      extra_price: opts.extraPrice ?? null,
      extra_max: opts.extraMax ?? null,   // NULL = a project from before the feature: no plan cap
      folders: opts.folders || ['20260819/'],
      owner_picker_id: null,
      phase: opts.phase || 'picking',
      modified_after_submit: 0,
      archived_at: opts.archivedAt || null,
      delivered_at: opts.deliveredAt || null,
      // docs/delivery.md: final_folders is an array once delivered, else
      // null; allow_proof_download is a boolean (the Worker's row/detail
      // shape — never 0/1)
      final_folders: opts.finalFolders || null,
      allow_proof_download: !!opts.allowProofDownload,
      // docs/delivery.md client confirmation: null until confirmed;
      // 'guest' | 'photographer' says who
      shoot_date: opts.shootDateColumn === false ? null : (opts.shootDate ?? null),
      project_type: opts.projectTypeColumn === false ? null : (opts.projectType ?? null),
      client_confirmed_at: opts.confirmedAt || null,
      client_confirmed_by: opts.confirmedAt ? (opts.confirmedBy || 'guest') : null,
    },
    // revision_requests rows, oldest first internally (served newest first):
    // {id, picker_id, message, created_at, resolved_at}
    revisions: (opts.revisions || []).map((r, i) => ({
      id: r.id || `rev-${i + 1}`, picker_id: r.picker_id ?? null, message: r.message,
      created_at: r.created_at || new Date(Date.UTC(2026, 8, 21, 0, i)).toISOString(), resolved_at: r.resolved_at || null,
      // docs/revision-pins.md 13.1: a text round (the default) has no marks; a pins round carries
      // marks {photo_key: [{x,y,note}]}, finals [folder...], message_auto, photo_count
      kind: r.kind || 'text', marks: r.marks || null, finals: r.finals || null,
      message_auto: !!r.message_auto,
      photo_count: r.photo_count ?? (r.marks ? Object.keys(r.marks).length : 0),
    })),
    // GET /api/pick/state's studio.{name, booking_url, has_logo}
    // (docs/dashboard-settings.md) — omitted from the response unless a test
    // opts in, so every pre-existing suite's fixture is unaffected.
    studio: opts.studio || null,
    deleted: false,
    pickers: new Map(),        // id -> {id, name, key, relationship, email}
    selections: new Map(),     // photo_key -> {rating, note, updated_by, updated_at}
    submissions: [],           // oldest first internally; served newest-first
    // every pick link the project ever had, oldest first internally, exactly
    // like worker.js's share_tokens rows (docs/guest-picking.md, "re-minting
    // a link"). opts.listToken === null means the project starts with none.
    tokens: opts.listToken === null ? [] : [{
      token: opts.listToken !== undefined ? opts.listToken : 'PICK-TOKEN',
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2027-01-01T00:00:00.000Z',
      revoked_at: null,
    }],
  };
  if (opts.ownerName) {
    const id = 'picker-0';
    state.pickers.set(id, { id, name: opts.ownerName, key: opts.ownerKey || 'OWNER-KEY' });
    state.project.owner_picker_id = id;
  }
  // product_interests rows (docs/guest-shop.md, product interest): {product_id, product_name, product_kind,
  // first_at, last_at, tap_count}; opts.interests seeds them
  state.interests = (opts.interests || []).map(x => ({ ...x }));
  const requests = [];

  function findByKey(key) {
    for (const p of state.pickers.values()) if (p.key === key) return p;
    return null;
  }
  function liveToken() {
    return state.tokens.find(t => pickTokenStatusFake(t) === 'live') || null;
  }
  const openRevisions = () => state.revisions.filter(r => !r.resolved_at);
  // a confirmation resolves every open request (worker.js resolveRevisionsIfConfirmed)
  const resolveOpen = at => openRevisions().forEach(r => { r.resolved_at = at; });

  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const method = req.method();
      const h = await req.allHeaders();
      const shareTok = u.searchParams.get('t') || h['x-share-token'] || '';
      const pickerKey = h['x-picker-key'] || '';
      let body = null;
      try { body = JSON.parse(req.postData() || 'null'); } catch (e) { /* not JSON */ }
      requests.push({ method, path: u.pathname, search: u.search, t: shareTok, key: pickerKey, body, range: h['range'] || null, auth: h['authorization'] || null });
      const json = (data, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });

      if (u.pathname === '/api/pick/state' && method === 'GET') {
        const picker = pickerKey ? findByKey(pickerKey) : null;
        const isOwner = !!picker && state.project.owner_picker_id === picker.id;
        const ownerPicker = state.project.owner_picker_id ? state.pickers.get(state.project.owner_picker_id) : null;
        const subs = state.submissions;
        const scope = pickScopeFake(state.project);
        const resp = {
          project: {
            id: state.project.id, title: state.project.title,
            pick_limit: state.project.pick_limit, extra_price: state.project.extra_price,
            extra_max: state.project.extra_max,
            max_picks: state.project.pick_limit != null && state.project.extra_max != null
              ? state.project.pick_limit + state.project.extra_max : null,
          },
          mode: scope.mode,
          folders: scope.proofs,
          final_folders: scope.finals,
          allow_proof_download: state.project.allow_proof_download,
          delivered_at: scope.mode === 'delivered' ? state.project.delivered_at : null,
          // docs/delivery.md: the same for owner and viewers; null / false /
          // null outside the delivered mode, never who confirmed
          confirmed_at: scope.mode === 'delivered' ? state.project.client_confirmed_at : null,
          // projects.shoot_date: only while delivered AND confirmed, null in every other state (docs/delivery.md)
          shoot_date: scope.mode === 'delivered' && state.project.client_confirmed_at ? (state.project.shoot_date ?? null) : null,
          revision_open: scope.mode === 'delivered' && openRevisions().length > 0,
          // the text goes to the seat owner only; a viewer always gets null
          // (opts.leakViewerMessage: a misbehaving Worker, to prove the page itself never shows it)
          revision_message: (isOwner || opts.leakViewerMessage) && scope.mode === 'delivered' && openRevisions().length
            ? openRevisions()[openRevisions().length - 1].message : null,
          owner: ownerPicker ? ownerPicker.name : null,
          is_owner: isOwner,
          phase: state.project.phase,
          submitted_at: subs.length ? subs[subs.length - 1].created_at : null,
          // notes are the owner's own words to the photographer — a viewer
          // gets {photo_key, rating} only (docs/guest-picking.md)
          selections: Array.from(state.selections.entries())
            .map(([photo_key, s]) => isOwner
              ? { photo_key, rating: s.rating, note: s.note, marks: opts.marksUnavailable ? null : (s.marks || null) }
              : { photo_key, rating: s.rating }),
        };
        if (isOwner) resp.modified_after_submit = state.project.modified_after_submit;
        if (state.studio) resp.studio = state.studio;
        if (opts.decorateState) opts.decorateState(resp, { isOwner, scope, picker });   // a suite's own additions to the answer
        return json(resp);
      }

      // GET /api/pick/shop (worker.js, docs/guest-shop.md "S1 trimmed"): the same order of checks as the
      // Worker — link (401: no token, or an archived project; a picker key alone is no link) -> method
      // (405, Allow: GET) -> delivered now (409 not_delivered) -> catalogue tables (500 shop_unavailable)
      // -> 200 {products}. Every answer but the 401 carries Cache-Control: private, no-store and
      // Vary: X-Share-Token. opts.shopProducts is the exact list the Worker would send (see
      // shopProductsFake); opts.shopUnavailable = the migration has not run; opts.shopFail = 'net'
      // drops the connection (a fetch TypeError), a number answers that status with a plain JSON error;
      // opts.shopDelay holds every answer back that many ms.
      if (u.pathname === '/api/pick/shop') {
        if (opts.shopDelay) await new Promise(r => setTimeout(r, opts.shopDelay));   // a slow Worker
        if (opts.shopFail === 'net') return route.abort('failed');
        if (typeof opts.shopFail === 'number') return json({ error: 'boom' }, opts.shopFail);
        if (!shareTok || state.project.archived_at) return json({ error: 'Unauthorized' }, 401);
        const noStore = { 'Cache-Control': 'private, no-store', 'Vary': 'X-Share-Token' };
        const send = (data, status, extra) => route.fulfill({ status, contentType: 'application/json', headers: { ...noStore, ...(extra || {}) }, body: JSON.stringify(data) });
        if (method !== 'GET') return send({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
        if (pickScopeFake(state.project).mode !== 'delivered') return send({ error: '尚未交件', code: 'not_delivered' }, 409);
        if (opts.shopUnavailable) return send({ error: '商品資訊暫時無法顯示', code: 'shop_unavailable' }, 500);
        // `ordering` (docs/guest-shop.md, S2): null = switch off / migration not run; opts.ordering is the object the Worker would send
        return send({ products: opts.shopProducts || [], ordering: opts.ordering ?? null }, 200);
      }

      if (u.pathname === '/api/pick/claim' && method === 'POST') {
        const name = typeof body?.name === 'string' ? body.name.trim() : '';
        if (!name || name.length > 50) return json({ error: '請輸入 1–50 字的名字' }, 400);
        if (state.project.owner_picker_id) {
          const owner = state.pickers.get(state.project.owner_picker_id);
          return json({ error: '已有人在挑選', owner: owner ? owner.name : null }, 409);
        }
        const id = 'picker-' + (state.pickers.size + 1);
        const key = 'KEY-' + id;
        state.pickers.set(id, { id, name, key });
        state.project.owner_picker_id = id;
        return json({ picker_key: key, picker_id: id, owner: name });
      }

      if (u.pathname === '/api/pick/selections' && method === 'PUT') {
        if (!['picking', 'submitted'].includes(state.project.phase))
          return json({ error: '攝影師已開始修圖，無法再修改或送出', code: 'retouching' }, 409);
        const picker = pickerKey ? findByKey(pickerKey) : null;
        const isOwner = !!picker && state.project.owner_picker_id === picker.id;
        if (!isOwner) return json({ error: '只有挑選人可以修改' }, 403);
        const upsert = body?.upsert || [];
        const del = body?.delete || [];
        // the real limits: a save body over 2,000,000 bytes is 413 too_large
        // (opts.failNextSave injects any other answer, once, for the paths a
        // browser cannot reach — e.g. a real 2 MB body)
        if (Buffer.byteLength(req.postData() || '') > 2000000)
          return json({ error: '資料太大', code: 'too_large', max: 2000000 }, 413);
        if (opts.failNextSave) { const f = opts.failNextSave; opts.failNextSave = null; return json(f.body, f.status); }
        // opts.failSaves: a FIFO of injected failures for the retry paths — 'net'
        // drops the connection (a fetch TypeError), a number answers that status
        if (opts.failSaves && opts.failSaves.length) {
          const f0 = opts.failSaves.shift();
          const f = f0 && typeof f0 === 'object' ? f0.fail : f0;
          if (f0 && f0.delay) await new Promise(r => setTimeout(r, f0.delay)); // a slow, then failing, request
          if (f === 'net') return route.abort('failed');
          return json({ error: '暫時無法處理', code: 'unavailable' }, f);
        }
        // marks: shape first, per item (400 invalid_marks, nothing written) —
        // rating 0 pins are ignored but still validated
        for (const item of upsert) {
          if (item.marks !== undefined && pickMarksCanonFake(item.marks) === null)
            return json({ error: '標示內容不正確', code: 'invalid_marks' }, 400);
        }
        // shape first (docs/guest-picking.md rule 7), same as worker.js —
        // checked before anything about caps, and before any write
        for (const item of upsert) {
          if (!pickKeyValidFake(item.photo_key)) return json({ error: '照片名稱不正確', code: 'invalid_photo_key' }, 400);
        }
        for (const k of del) {
          if (!pickKeyValidFake(k)) return json({ error: '照片名稱不正確', code: 'invalid_photo_key' }, 400);
        }
        // before the D1 migration: any save that carries `marks` (even []) is 500
        if (opts.marksUnavailable && upsert.some(it => it.marks !== undefined))
          return json({ error: '標示功能尚未啟用', code: 'marks_unavailable' }, 500);
        // the caps: what this save would leave, against the current count —
        // whichever of PICK_MAX_SELECTIONS/current-count is bigger, mirroring
        // worker.js's MAX(?, current) so a project already over a lowered cap
        // can still re-rate/un-star/delete
        const byKey = new Map(upsert.map(it => [it.photo_key, it])); // last mention wins
        const removed = new Set(del);
        const resultKeys = new Set([...state.selections.keys(), ...byKey.keys()]);
        for (const k of removed) resultKeys.delete(k);
        let starCount = 0;
        for (const k of resultKeys) {
          const rating = byKey.has(k) ? byKey.get(k).rating : state.selections.get(k)?.rating;
          if (rating > 0) starCount++;
        }
        const priorStars = Array.from(state.selections.values()).filter(s => s.rating > 0).length;
        const priorRows = state.selections.size;
        // hearts are drafts (docs/pick-handover.md §1): a save never answers
        // pick_cap — the plan cap is enforced at submit only
        if (starCount > Math.max(PICK_MAX_SELECTIONS, priorStars)) {
          return json({ error: `最多只能選 ${PICK_MAX_SELECTIONS} 張`, code: 'selection_cap', max: PICK_MAX_SELECTIONS }, 409);
        }
        if (resultKeys.size > Math.max(PICK_MAX_ROWS, priorRows)) {
          return json({ error: `最多只能保留 ${PICK_MAX_ROWS} 筆`, code: 'row_cap', max: PICK_MAX_ROWS }, 409);
        }
        // the stored pins after the save: absent + rating>=1 keeps, an array
        // replaces (empty = none), rating 0 clears, deleted rows go
        const newMarks = new Map();
        for (const [k, item] of byKey) {
          if (removed.has(k)) continue;
          if (!(item.rating >= 1)) newMarks.set(k, null);
          else if (item.marks === undefined) newMarks.set(k, state.selections.get(k)?.marks || null);
          else { const c = pickMarksCanonFake(item.marks); newMarks.set(k, c.length ? c : null); }
        }
        const pinsOf = k => (newMarks.has(k) ? newMarks.get(k) : state.selections.get(k)?.marks) || [];
        const writesPins = upsert.some(it => it.rating >= 1 && Array.isArray(it.marks) && it.marks.length > 0);
        if (writesPins) {
          let total = 0, priorTotal = 0;
          for (const k of resultKeys) total += pinsOf(k).length;
          for (const s of state.selections.values()) priorTotal += (s.marks || []).length;
          if (total > Math.max(PICK_MARKS_TOTAL_MAX_FAKE, priorTotal))
            return json({ error: '標示總數已達上限（300 個）', code: 'marks_cap', max: PICK_MARKS_TOTAL_MAX_FAKE }, 409);
        }
        const now = new Date().toISOString();
        if (state.project.phase === 'submitted') state.project.modified_after_submit = 1;
        for (const [k, item] of byKey) {
          state.selections.set(k,
            { rating: item.rating, note: item.note || '', marks: newMarks.get(k) || null, updated_by: picker.id, updated_at: now });
        }
        del.forEach(k => state.selections.delete(k));
        return json({ ok: true });
      }

      if (u.pathname === '/api/pick/submit' && method === 'POST') {
        if (!['picking', 'submitted'].includes(state.project.phase))
          return json({ error: '攝影師已開始修圖，無法再修改或送出', code: 'retouching' }, 409);
        const picker = pickerKey ? findByKey(pickerKey) : null;
        const isOwner = !!picker && state.project.owner_picker_id === picker.id;
        if (!isOwner) return json({ error: '只有挑選人可以送出' }, 403);
        if (!PICK_RELATIONSHIPS.includes(body?.relationship)) return json({ error: '請選擇與新人的關係' }, 400);
        let mail = null;
        if (body.email !== undefined && body.email !== null && body.email !== '') {
          if (!/^[^\s@]+@[^\s@]+$/.test(body.email)) return json({ error: 'Email 格式不正確' }, 400);
          mail = body.email;
        }
        // the plan cap at submit (worker.js pickCapRefused): count > pick_limit +
        // extra_max (both non-NULL) -> 409 pick_cap, nothing recorded
        {
          const { pick_limit: pl, extra_max: em } = state.project;
          const count = Array.from(state.selections.values()).filter(s => s.rating > 0).length;
          if (pl != null && em != null && count > pl + em) {
            const max = pl + em, over = count - max;
            return json({
              error: em > 0
                ? `目前選了 ${count} 張，最多可送出 ${max} 張（方案 ${pl} + 加選 ${em}）。請先取消 ${over} 張再送出`
                : `目前選了 ${count} 張，此專案最多 ${max} 張，不可加選。請先取消 ${over} 張再送出`,
              code: 'pick_cap', count, max, over, limit: pl, extra_max: em }, 409);
          }
        }
        const photo_keys = Array.from(state.selections.entries())
          .filter(([, s]) => s.rating > 0).map(([k]) => k).sort();
        const submission = {
          id: 'sub-' + (state.submissions.length + 1), picker_id: picker.id,
          relationship: body.relationship, email: mail, photo_keys, count: photo_keys.length,
          // {photo_key: pins} over the picked photos that have pins; null when none
          marks: (() => {
            const o = {};
            for (const k of photo_keys) { const mk = state.selections.get(k).marks; if (mk && mk.length) o[k] = mk; }
            return Object.keys(o).length ? o : null;
          })(),
          pick_limit: state.project.pick_limit, extra_price: state.project.extra_price,
          created_at: new Date(Date.now() + state.submissions.length).toISOString(),
          // the fake never actually mails (the throttle/diff logic is
          // worker.js's own, pinned by worker/test/pick-hardening.test.mjs) —
          // every submission starts unnotified, exactly like a project with
          // no mail configured
          notified: 0,
        };
        state.submissions.push(submission);
        state.project.phase = 'submitted';
        state.project.modified_after_submit = 0;
        picker.relationship = body.relationship;
        picker.email = mail;
        const limit = state.project.pick_limit;
        return json({
          ok: true, phase: 'submitted', submission_id: submission.id, submitted_at: submission.created_at,
          count: submission.count, limit, price: state.project.extra_price,
          over: limit == null ? 0 : Math.max(0, submission.count - limit),
        });
      }

      // POST /api/pick/confirm and /api/pick/revision (worker.js): link (401)
      // -> seat (403) -> delivered now (409, before the body) -> body (413 /
      // 400) -> message (400) -> migration (500) -> confirmed (repeat 200 /
      // 409) -> caps. opts.failNextPick: FIFO of injected answers for the
      // paths a browser cannot reach.
      if ((u.pathname === '/api/pick/confirm' || u.pathname === '/api/pick/revision') && method === 'POST') {
        const confirming = u.pathname === '/api/pick/confirm';
        if (opts.pickDelay) await new Promise(r => setTimeout(r, opts.pickDelay));
        if (opts.failNextPick && opts.failNextPick.length) {
          const f = opts.failNextPick.shift();
          if (f === 'net') return route.abort('failed');
          if (f.effect) f.effect(); // e.g. the photographer confirmed in the meantime
          return json(f.body, f.status);
        }
        if (state.project.archived_at) return json({ error: 'Unauthorized' }, 401);
        const picker = pickerKey ? findByKey(pickerKey) : null;
        const isOwner = !!picker && state.project.owner_picker_id === picker.id;
        if (!isOwner) return json({ error: confirming ? '只有挑選人可以確認完成' : '只有挑選人可以要求修改' }, 403);
        if (pickScopeFake(state.project).mode !== 'delivered') return json({ error: '尚未交件', code: 'not_delivered' }, 409);
        const raw = req.postData() || '';
        if (Buffer.byteLength(raw) > 16384) return json({ error: '資料太大', code: 'too_large', max: 16384 }, 413);
        let parsed = {};
        if (raw.trim()) { try { parsed = JSON.parse(raw); } catch (e) { return json({ error: 'Invalid JSON' }, 400); } }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json({ error: 'Invalid body', code: 'invalid_body' }, 400);
        const message = confirming ? null : revisionMessageFake(parsed.message);
        if (!confirming && !message) return json({ error: '請輸入 1–1000 字的修改說明', code: 'invalid_message', max: 1000 }, 400);
        if (opts.confirmUnavailable) return json({ error: '確認完成功能尚未啟用', code: 'confirm_unavailable' }, 500);
        if (state.project.client_confirmed_at) {
          return confirming ? json({ ok: true, confirmed_at: state.project.client_confirmed_at })
            : json({ error: '已確認完成，無法再要求修改', code: 'already_confirmed' }, 409);
        }
        const at = new Date().toISOString();
        if (confirming) {
          state.project.client_confirmed_at = at;
          state.project.client_confirmed_by = 'guest';
          resolveOpen(at);
          return json({ ok: true, confirmed_at: at });
        }
        if (openRevisions().length >= 10) return json({ error: '尚未處理的修改需求已有 10 則，請等攝影師回覆', code: 'revision_open_cap', max: 10 }, 409);
        if (state.revisions.length >= 50) return json({ error: '修改需求已達上限（50 則），請直接聯絡攝影師', code: 'revision_cap', max: 50 }, 409);
        state.revisions.push({ id: 'rev-' + (state.revisions.length + 1), picker_id: picker.id, message, created_at: at, resolved_at: null });
        return json({ ok: true, message, created_at: at });
      }

      if (u.pathname === '/api/admin/projects' && method === 'GET') {
        const owner = state.project.owner_picker_id ? state.pickers.get(state.project.owner_picker_id) : null;
        const subs = state.submissions;
        const live = liveToken();
        const wantArchived = u.searchParams.get('archived') === '1';
        const isArchived = !!state.project.archived_at;
        const mainRow = {
          id: state.project.id,
          title: state.project.title,
          phase: state.project.phase,
          modified_after_submit: state.project.modified_after_submit,
          pick_limit: state.project.pick_limit, extra_price: state.project.extra_price,
          extra_max: state.project.extra_max,
          owner_name: owner ? owner.name : null,
          created_at: '2026-01-01T00:00:00.000Z',
          archived_at: state.project.archived_at,
          delivered_at: state.project.delivered_at,
          final_folders: state.project.final_folders,
          allow_proof_download: state.project.allow_proof_download,
          shoot_date: state.project.shoot_date ?? null,
          project_type: opts.projectTypeColumn === false ? null : (state.project.project_type ?? null),
          client_confirmed_at: state.project.client_confirmed_at,
          client_confirmed_by: state.project.client_confirmed_by,
          open_revision_count: openRevisions().length,
          submission_count: subs.length,
          last_submitted_at: subs.length ? subs[subs.length - 1].created_at : null,
          unnotified_submissions: unnotifiedCountFake(subs),
          token: live ? live.token : null,
        };
        const projects = (!state.deleted && (wantArchived ? isArchived : !isArchived)) ? [mainRow] : [];
        // opts.extraProjects: more list rows (list-only: no detail behind them), same row shape
        for (const x of opts.extraProjects || []) {
          if (wantArchived ? !!x.archived_at : !x.archived_at) projects.push({ project_type: null, open_revision_count: 0, submission_count: 0, owner_name: null, delivered_at: null, archived_at: null, ...x });
        }
        return json({ projects });
      }

      if (u.pathname === '/api/admin/settings' && method === 'GET') return json(settingsShapeFake(state.settings));
      if (u.pathname === '/api/admin/projects' && method === 'POST') {
        // extra_max: a whole number 0-500 is stored, null = stored NULL (no plan
        // cap), LEFT OUT = the studio default (else 10); anything else is 400
        let extra_max;
        if (!('extra_max' in (body || {}))) extra_max = settingsShapeFake(state.settings).effective_default_extra_max;
        else if (body.extra_max === null || isExtraMaxFake(body.extra_max)) extra_max = body.extra_max;
        else return json({ error: 'extra_max must be a whole number from 0 to 500' }, 400);
        // shoot_date (worker.js isShootDateInput / SHOOT_DATE_UNAVAILABLE): '' / null / absent = none,
        // else a real 'YYYY-MM-DD'; bad = 400 invalid_shoot_date; a date before the migration = 500
        let shoot_date = null;
        if (body && 'shoot_date' in body) {
          if (!isShootDateInputFake(body.shoot_date)) return json({ error: 'shoot_date must be YYYY-MM-DD', code: 'invalid_shoot_date' }, 400);
          shoot_date = body.shoot_date === '' ? null : body.shoot_date;
        }
        if (shoot_date !== null && opts.shootDateColumn === false) return json({ error: '拍攝日期功能尚未啟用', code: 'shoot_date_unavailable' }, 500);
        state.project.shoot_date = shoot_date;
        // project_type: '' / null / absent = unset; bad = 400 invalid_project_type; before the migration a write naming it = 500
        let project_type = null;
        if (body && 'project_type' in body) {
          if (!isProjectTypeInputFake(body.project_type)) return json({ error: 'invalid project_type', code: 'invalid_project_type' }, 400);
          if (opts.projectTypeColumn === false) return json({ error: 'project_type unavailable', code: 'project_type_unavailable' }, 500);
          project_type = body.project_type === '' || body.project_type === null ? null : body.project_type.trim();
        }
        state.project.project_type = project_type;
        return json({
          project: {
            id: state.project.id, title: body.title || '', folders: body.folders,
            pick_limit: body.pick_limit ?? null, extra_price: body.extra_price ?? null,
            extra_max, shoot_date, project_type, photographer_id: 'default',
          },
          token: 'PICK-TOKEN', expires_at: '2027-01-01T00:00:00.000Z',
        }, 201);
      }
      if (/^\/api\/admin\/projects\/[^/]+$/.test(u.pathname) && method === 'GET') {
        // worker.js: an unknown (or deleted) project id is a 404, not somebody else's project
        if (state.deleted || decodeURIComponent(u.pathname.split('/')[4]) !== state.project.id) return json({ error: 'Not found' }, 404);
        const pickers = Array.from(state.pickers.values()).map(p => ({
          id: p.id, name: p.name, relationship: p.relationship || null,
          email: p.email || null, user_id: null, created_at: '2026-01-01T00:00:00.000Z',
        }));
        const selections = Array.from(state.selections.entries())
          .map(([photo_key, s]) => ({ photo_key, rating: s.rating, note: s.note,
            marks: opts.marksUnavailable ? null : (s.marks || null), updated_by: s.updated_by, updated_at: s.updated_at }));
        const submissions = state.submissions.slice().reverse()
          .map(sub => ({ ...sub, marks: opts.marksUnavailable ? null : (sub.marks || null) }));
        const owner = state.project.owner_picker_id ? state.pickers.get(state.project.owner_picker_id) : null;
        const tokens = state.tokens.slice().reverse().map(t => ({ ...t, status: pickTokenStatusFake(t) }));
        // newest first, at most 50: {id, message, created_at, resolved_at,
        // picker_id, picker_name} (picker_name null when the picker is gone)
        const revision_requests = state.revisions.slice().reverse().slice(0, 50).map(r => ({
          id: r.id, message: r.message, created_at: r.created_at, resolved_at: r.resolved_at,
          picker_id: r.picker_id, picker_name: state.pickers.get(r.picker_id)?.name ?? null,
          kind: r.kind, marks: r.marks, finals: r.finals, message_auto: r.message_auto, photo_count: r.photo_count,
        }));
        return json({
          project: { ...state.project, open_revision_count: openRevisions().length },
          owner: owner ? { id: owner.id, name: owner.name } : null,
          pickers, selections, tokens, submissions,
          unnotified_submissions: unnotifiedCountFake(state.submissions),
          revision_requests,
          interests: state.interests.slice().sort((a, b) => (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0)),   // newest tap first, [] when none
        });
      }
      if (/^\/api\/admin\/projects\/[^/]+$/.test(u.pathname) && method === 'DELETE') {
        if (state.submissions.length)
          return json({ error: '已有送出紀錄，無法刪除（可改為封存）', code: 'has_submissions' }, 409);
        state.deleted = true;
        return json({ ok: true });
      }
      if (/\/api\/admin\/projects\/[^/]+\/links$/.test(u.pathname) && method === 'POST') {
        if (state.project.archived_at)
          return json({ error: 'Project is archived; unarchive it first', code: 'archived' }, 409);
        const token = 'PICK-TOKEN-' + (state.tokens.length + 1);
        const created_at = new Date().toISOString();
        const expires_at = new Date(Date.now() + 90 * 86400000).toISOString();
        state.tokens.push({ token, created_at, expires_at, revoked_at: null });
        return json({ token, expires_at, created_at, status: 'live' }, 201);
      }
      if (/\/api\/admin\/projects\/[^/]+\/archive$/.test(u.pathname) && method === 'POST') {
        let revoked = 0;
        if (!state.project.archived_at) {
          const at = new Date().toISOString();
          state.project.archived_at = at;
          for (const t of state.tokens) {
            if (pickTokenStatusFake(t) === 'live') { t.revoked_at = at; revoked++; }
          }
        }
        return json({ ok: true, archived_at: state.project.archived_at, revoked });
      }
      if (/\/api\/admin\/projects\/[^/]+\/unarchive$/.test(u.pathname) && method === 'POST') {
        state.project.archived_at = null;
        return json({ ok: true, archived_at: null });
      }
      if (/^\/api\/shares\/[^/]+\/revoke$/.test(u.pathname) && method === 'POST') {
        const tok = decodeURIComponent(u.pathname.split('/')[3]);
        const row = state.tokens.find(t => t.token === tok);
        if (!row || row.revoked_at) return json({ error: 'Not found' }, 404);
        row.revoked_at = new Date().toISOString();
        return json({ ok: true });
      }
      if (/\/api\/admin\/projects\/[^/]+\/reset-seat$/.test(u.pathname) && method === 'POST') {
        state.project.owner_picker_id = null;
        return json({ ok: true });
      }
      if (/\/api\/admin\/projects\/[^/]+\/start-retouch$/.test(u.pathname) && method === 'POST') {
        if (state.project.phase === 'picking')
          return json({ error: '客人尚未送出，無法開始修圖', code: 'not_submitted', phase: 'picking' }, 409);
        state.project.phase = 'retouching';
        return json({ ok: true, phase: 'retouching' });
      }
      // POST /api/admin/projects/:id/confirm (worker.js): 標記完成
      if (/^\/api\/admin\/projects\/[^/]+\/confirm$/.test(u.pathname) && method === 'POST') {
        if (u.pathname.split('/')[4] !== state.project.id) return json({ error: 'Not found' }, 404);
        if (opts.confirmUnavailable) return json({ error: '確認完成功能尚未啟用', code: 'confirm_unavailable' }, 500);
        if (!state.project.delivered_at) return json({ error: '尚未交件，無法標記完成', code: 'not_delivered' }, 409);
        if (!state.project.client_confirmed_at) {
          const at = new Date().toISOString();
          state.project.client_confirmed_at = at;
          state.project.client_confirmed_by = 'photographer';
          resolveOpen(at);
        }
        return json({ ok: true, client_confirmed_at: state.project.client_confirmed_at, client_confirmed_by: state.project.client_confirmed_by });
      }
      if (/\/api\/admin\/projects\/[^/]+\/reopen$/.test(u.pathname) && method === 'POST') {
        state.project.client_confirmed_at = null;
        state.project.client_confirmed_by = null;
        state.project.phase = 'picking';
        state.project.modified_after_submit = 0;
        // clears the stamp, keeps the finals snapshot as the last choice, like
        // undeliver (worker.js reopen); pickScopeFake reads it as not delivered
        state.project.delivered_at = null;
        return json({ ok: true, phase: 'picking' });
      }
      // Delivered projects (docs/dashboard-settings.md) — a stamp, not a
      // phase: delivering never changes `phase`, only sets `delivered_at`,
      // and only from retouching.
      if (/\/api\/admin\/projects\/[^/]+\/deliver$/.test(u.pathname) && method === 'POST') {
        if (state.project.phase !== 'retouching')
          return json({ error: '尚未開始修圖，無法標記為已交付', code: 'not_retouching', phase: state.project.phase }, 409);
        const raw = body && typeof body === 'object' && !Array.isArray(body) ? body.final_folders : undefined;
        if (Array.isArray(raw) && raw.length > 20)
          return json({ error: '交件資料夾最多 20 個', code: 'too_many_final_folders', max: 20 }, 400);
        const finals = finalFoldersFake(raw);
        if (!finals) return json({ error: '交件資料夾不正確', code: 'invalid_final_folders' }, 400);
        const proofs = state.project.folders.concat(...state.tokens.map(t => t.folders || []));
        const clash = finals.find(f => proofs.some(p => f.startsWith(p) || p.startsWith(f)));
        if (clash) return json({ error: `「${clash}」與毛片資料夾重疊，精修請放在獨立的資料夾`, code: 'final_overlaps_proofs', folder: clash }, 400);
        // a repeat deliver replaces the finals and keeps the first stamp
        if (!state.project.delivered_at) state.project.delivered_at = new Date().toISOString();
        state.project.final_folders = finals;
        // every deliver puts a new version up: it clears the confirmation and
        // resolves the open requests (docs/delivery.md)
        state.project.client_confirmed_at = null;
        state.project.client_confirmed_by = null;
        resolveOpen(new Date().toISOString());
        return json({ ok: true, delivered_at: state.project.delivered_at, final_folders: finals });
      }
      if (/\/api\/admin\/projects\/[^/]+\/undeliver$/.test(u.pathname) && method === 'POST') {
        // clears the stamp only: the snapshot stays as the last chosen finals
        // (worker.js undeliver); pickScopeFake still reads it as not delivered
        state.project.delivered_at = null;
        state.project.client_confirmed_at = null;
        state.project.client_confirmed_by = null;
        return json({ ok: true, delivered_at: null });
      }
      if (/^\/api\/admin\/projects\/[^/]+$/.test(u.pathname) && method === 'PATCH') {
        if (opts.patchStatus && opts.patchStatus !== 200)
          return json(opts.patchBody || { error: 'DB error' }, opts.patchStatus);
        // any non-empty subset of the four keys; one bad key spoils the body
        const good = {
          allow_proof_download: v => typeof v === 'boolean',
          pick_limit: v => v === null || (Number.isSafeInteger(v) && v >= 0),
          extra_price: v => v === null || (Number.isSafeInteger(v) && v >= 0 && v <= MONEY_MAX_FAKE),
          extra_max: v => v === null || isExtraMaxFake(v),
          shoot_date: isShootDateInputFake,
          project_type: isProjectTypeInputFake,
          // worker contract: a string, trimmed, 1-200 chars; blank/invalid refuses the whole body; works when archived
          title: v => typeof v === 'string' && v.trim().length >= 1 && v.trim().length <= 200,
        };
        const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : [];
        if (!keys.length || keys.some(k => !good[k] || !good[k](body[k])))
          return json({ error: 'Invalid body', code: 'invalid_body' }, 400);
        if (keys.includes('project_type') && opts.projectTypeColumn === false) return json({ error: 'project_type unavailable', code: 'project_type_unavailable' }, 500);
        const planKey = keys.some(k => k !== 'allow_proof_download' && k !== 'shoot_date' && k !== 'project_type' && k !== 'title');
        if (keys.includes('shoot_date') && opts.shootDateColumn === false) return json({ error: '拍攝日期功能尚未啟用', code: 'shoot_date_unavailable' }, 500);
        if (planKey && state.project.archived_at)
          return json({ error: 'Project is archived; unarchive it first', code: 'archived' }, 409);
        for (const k of keys) state.project[k] = k === 'title' ? body[k].trim() : k === 'project_type' ? (body[k] === '' || body[k] === null ? null : body[k].trim()) : (k === 'shoot_date' && body[k] === '' ? null : body[k]);
        return json({ ok: true, ...body, ...(keys.includes('title') ? { title: state.project.title } : {}), ...(keys.includes('shoot_date') ? { shoot_date: state.project.shoot_date } : {}), ...(keys.includes('project_type') ? { project_type: state.project.project_type } : {}) });
      }

      // A pick link's reads (docs/delivery.md): a listing outside the link's
      // scope is 401 when the fixture asks for scoped reads; an original (no
      // ?w=, or ?download=1) is finals once delivered, proofs only while the
      // switch is on — else 403 original_not_allowed. Downloads carry the
      // real Content-Disposition; a Range request gets a real 206.
      if (shareTok && method === 'GET' && !u.pathname.startsWith('/api/') && u.pathname !== '/' && !u.searchParams.has('list')) {
        const key = decodeURIComponent(u.pathname.slice(1));
        const scope = pickScopeFake(state.project);
        const cors = { 'Access-Control-Allow-Origin': '*' };
        const isDownload = u.searchParams.get('download') === '1';
        const isOriginal = isDownload || !u.searchParams.has('w');
        if (isOriginal) {
          const isFinal = scope.finals.some(f => key.startsWith(f));
          if (!isFinal && !state.project.allow_proof_download) {
            return route.fulfill({ status: 403, contentType: 'application/json', headers: cors,
              body: JSON.stringify({ error: '原檔未開放下載', code: 'original_not_allowed' }) });
          }
        }
        const headers = { ...cors, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400' };
        if (isDownload) headers['Content-Disposition'] = attachmentFake(key);
        // opts.imageFor(key, w) -> a Buffer (a PNG of that photo's shape), for suites that
        // need photos of different aspect ratios; opts.imageDelay(key) -> ms to hold the answer
        const full = (opts.imageFor && opts.imageFor(key, u.searchParams.get('w'))) || opts.image || PIXEL;
        if (opts.imageDelay && !isDownload) { const ms = opts.imageDelay(key); if (ms) await new Promise(r => setTimeout(r, ms)); }
        if (h['range']) {
          const m = /^bytes=(\d+)-(\d*)$/.exec(h['range']);
          if (m) {
            const start = +m[1], end = m[2] === '' ? full.length - 1 : Math.min(+m[2], full.length - 1);
            headers['Content-Range'] = `bytes ${start}-${end}/${full.length}`;
            return route.fulfill({ status: 206, contentType: 'image/png', headers, body: full.subarray(start, end + 1) });
          }
        }
        return route.fulfill({ status: 200, contentType: 'image/png', headers, body: full });
      }

      if (u.searchParams.has('list')) {
        // opts.listDelay {prefix: ms} holds the first listing of that prefix back; opts.listFail makes every
        // listing fail (a status number, or 'net' for a dropped connection)
        const listPrefixAsked = u.searchParams.get('list') || '';
        if (opts.listDelay && opts.listDelay[listPrefixAsked]) {   // held back once, then answers at once
          const ms = opts.listDelay[listPrefixAsked]; delete opts.listDelay[listPrefixAsked];
          await new Promise(r => setTimeout(r, ms));
        }
        if (opts.listFail) return opts.listFail === 'net' ? route.abort() : json({ error: 'list failed' }, opts.listFail);
        // Nested subfolders (docs/backlog.md "Guest page hides subfolders"):
        // a flat list of full photo keys, delimiter-listed exactly like
        // worker.js's own R2 call — so `folders` for any prefix reflects
        // whatever subfolders actually exist under it, at any depth.
        if (opts.pickFiles) {
          const prefix = u.searchParams.get('list') || '';
          const { data, folders } = delimitedListFake(opts.pickFiles, prefix);
          return json({ status: 'success', data, folders });
        }
        // the admin create-project folder picker browses the bucket itself,
        // not a pick token's own (single-folder) grid — a distinct fixture
        if (opts.bucketFolders) {
          const prefix = u.searchParams.get('list') || '';
          const folders = opts.bucketFolders.filter(f => f.startsWith(prefix) && f !== prefix);
          return json({ status: 'success', folders, data: [] });
        }
        // Multi-folder pick projects: distinct photos per permitted folder,
        // so a test can tell which one is actually on screen rather than
        // just which one the sidebar claims is active.
        if (opts.photosByFolder) {
          const prefix = u.searchParams.get('list') || '';
          return json({ status: 'success', folders: [], data: opts.photosByFolder[prefix] || [] });
        }
        return json({ status: 'success', folders: [], data: opts.photos || PHOTOS(3) });
      }
      if (opts.image) return route.fulfill({ status: 200, contentType: 'image/png', body: opts.image,
        headers: { 'Access-Control-Allow-Origin': '*' } });
      // POST /api/pick/interest (worker.js, docs/guest-shop.md "Product interest"): the Worker's order of checks —
      // link (401) -> method (405, Allow: POST) -> seat (403 not_owner) -> delivered AND confirmed now (409
      // not_confirmed, before the body) -> body (413 too_large / 400 invalid_body) -> product offered now (404
      // not_found) -> tables (500 shop_unavailable / interest_unavailable) -> cap of 20 distinct products
      // (409 interest_cap) -> 200 {ok, already}. Every answer carries Cache-Control: private, no-store.
      // opts.interestFail = 'net' drops the connection; opts.interestUnavailable = the migration has not run;
      // opts.interestDelay holds the answer back that many ms. The query token only: a key in the URL is a bug
      // the suite checks for.
      if (u.pathname === '/api/pick/interest') {
        if (opts.interestDelay) await new Promise(r => setTimeout(r, opts.interestDelay));
        if (opts.interestFail === 'net') return route.abort('failed');
        if (!shareTok || state.project.archived_at) return json({ error: 'Unauthorized' }, 401);
        const send = (data, status, extra) => route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'private, no-store', ...(extra || {}) }, body: JSON.stringify(data) });
        if (method !== 'POST') return send({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
        const picker = findByKey(pickerKey);
        if (!picker || state.project.owner_picker_id !== picker.id) return send({ error: '只有挑選人可以通知攝影師', code: 'not_owner' }, 403);
        if (pickScopeFake(state.project).mode !== 'delivered' || !state.project.client_confirmed_at) return send({ error: '尚未確認完成', code: 'not_confirmed' }, 409);
        if ((req.postData() || '').length > 1024) return send({ error: 'too large', code: 'too_large' }, 413);
        if (!body || typeof body !== 'object' || typeof body.product_id !== 'string' || body.product_id.length < 1 || body.product_id.length > 200) return send({ error: 'invalid body', code: 'invalid_body' }, 400);
        const product = (opts.shopProducts || []).find(x => x.id === body.product_id);
        if (!product) return send({ error: '這個商品目前不提供', code: 'not_found' }, 404);
        if (opts.shopUnavailable) return send({ error: '商品資訊暫時無法顯示', code: 'shop_unavailable' }, 500);
        if (opts.interestUnavailable) return send({ error: '暫時無法記錄', code: 'interest_unavailable' }, 500);
        const at = new Date().toISOString();
        const row = state.interests.find(x => x.product_id === product.id);
        if (!row && state.interests.length >= 20) return send({ error: '已達上限', code: 'interest_cap', max: 20 }, 409);
        if (row) { row.tap_count += 1; row.last_at = at; row.product_name = product.name; row.product_kind = product.kind; }
        else state.interests.push({ product_id: product.id, product_name: product.name, product_kind: product.kind, first_at: at, last_at: at, tap_count: 1 });
        return send({ ok: true, already: !!row }, 200);
      }

      route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
    });
  };
  return { state, attach, requests, findByKey };
}

// The shape worker.js readGuestShop answers (docs/guest-shop.md, "S1 trimmed"), as the Worker's own test
// pins it (worker/test/guest-shop-read.test.mjs): a print first (sort 1), then an album with a page range
// and an image. min_pages / max_pages are SPREADS and null on a print; image_url is RELATIVE to the Worker
// origin; price is the photographer's option price (an integer, NT$); label is '' on a single option.
export const SHOP_PRINT_FAKE = {
  id: 'prod-print', kind: 'print', name: '無框畫', description: '木框', photo_count: null, min_pages: null, max_pages: null, extra_page_price: null, image_url: null,
  options: [{ id: 'opt-print-1', label: '16×20', price: 3000 }],
};
export const SHOP_ALBUM_FAKE = {
  id: 'prod-album', kind: 'album', name: '相本書', description: '精裝 20×20', photo_count: 20, min_pages: 10, max_pages: 30, extra_page_price: null,
  image_url: '/api/platform/products/pp-album/image?v=2026-10-05T00%3A00%3A00.000Z',
  options: [{ id: 'opt-album-1', label: '20×20', price: 5000 }, { id: 'opt-album-2', label: '30×30', price: 7000 }],
};
export const shopProductsFake = (over = {}) => [
  { ...SHOP_PRINT_FAKE, ...(over.print || {}) },
  { ...SHOP_ALBUM_FAKE, ...(over.album || {}) },
];
