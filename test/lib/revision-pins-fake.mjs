// The fake Worker side of the revision pins (docs/revision-pins.md §13.1): drafts, the submit, the round
// history and the round thumbnails, on top of the album world (SVG photos, the pick fake). Mirrors the
// real routes' order of checks, status codes and answer shapes (worker/worker.js, worker/test/revision-*.test.mjs).
// Only suites/37-finals-pins-client.mjs uses it; the one shared-lib change it needs is pick-fake's additive
// `decorateState` hook.
import { albumWorld, albSvg } from './album-world.mjs';
import { pickMarksCanonFake, revisionMessageFake } from './pick-fake.mjs';

export const RP_AUTO_MESSAGE = '請見照片上的標示';
const OWNER_KEY = 'ZOE-KEY';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);   // code point order, like roundPhotoKeys
export const sortedKeys = keys => [...new Set(keys)].sort(cmp);

// o: albumWorld options plus
//   migrated: false -> the migration has not run (state.revision_drafts null, every new route 500)
//   drafts:   [{photo_key, marks}] already saved for the current delivery
//   rounds:   [{id, kind:'pins'|'text', created_at, open?, note?, photos:[{key, pins}]}]  (newest last)
//   selection: {created_at, photos:[{key, pins}]}  (the latest submission)
//   missingThumbs: Set of `${roundId}:${i}` whose thumbnail does not exist
export function pinsWorld(o = {}) {
  const migrated = o.migrated !== false;
  const sig = () => JSON.stringify([w.m.state.project.delivered_at, w.m.state.project.final_folders]);
  const store = { sig: null, drafts: new Map() };       // the saved drafts and the delivery they belong to
  const rounds = (o.rounds || []).map(r => ({ open: false, note: null, ...r }));
  const calls = [];                                      // every request to the new routes: {method, path, search, headers, body}
  const ctl = {
    failNext: [],            // FIFO of {on:'put'|'round', status, body} | {on, net:true}: the next such request is answered so
    beforeRound: null,       // () => void, run once just before the submit is judged (another tab changes the drafts)
    delay: { put: 0, round: 0 },
    putCount: 0,
  };
  const validDrafts = () => (store.sig === sig() ? store.drafts : new Map());
  const openRound = () => rounds.filter(r => r.open).pop() || null;
  const inFinals = key => (w.m.state.project.final_folders || []).some(f => key.startsWith(f));
  const owner = key => {
    const picker = key ? w.m.findByKey(key) : null;
    return !!picker && w.m.state.project.owner_picker_id === picker.id;
  };

  const w = albumWorld({
    ...o,
    fake: {
      ...(o.fake || {}),
      decorateState(resp, { isOwner }) {
        if (resp.mode !== 'delivered' || !isOwner) return;       // viewers and non-delivered: no such keys
        resp.revision_drafts = !migrated ? null
          : resp.confirmed_at ? []
            : sortedKeys([...validDrafts().keys()]).map(photo_key => ({ photo_key, marks: validDrafts().get(photo_key) }));
        const open = migrated ? openRound() : null;
        resp.revision_open_photos = open && open.kind === 'pins' ? open.photos.length : null;
        if (open && open.kind === 'pins' && !open.note) resp.revision_message = null;   // message_auto: not the guest's words
      },
    },
  });
  const baseBefore = w.before;
  const json = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data),
    headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'private, no-store' } });
  // the checks every new route shares: link (401) -> method (405) -> seat (403) -> delivered (409)
  const common = (route, h, methods) => {
    const m = route.request().method();
    if (!methods.includes(m)) return json(route, { error: 'Method not allowed' }, 405);
    if (!owner(h['x-picker-key'])) return json(route, { error: '只有挑選人可以操作', code: 'not_owner' }, 403);
    const p = w.m.state.project;
    if (!(p.delivered_at && Array.isArray(p.final_folders) && p.final_folders.length)) return json(route, { error: '尚未交件', code: 'not_delivered' }, 409);
    return null;
  };
  const injected = on => {
    const i = ctl.failNext.findIndex(f => f.on === on);
    return i < 0 ? null : ctl.failNext.splice(i, 1)[0];
  };

  w.before = async page => {
    await baseBefore(page);
    await page.route('**/imagepicker.hotichen.workers.dev/api/pick/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const method = req.method();
      const h = await req.allHeaders();
      const path = u.pathname;
      const isNew = path === '/api/pick/revision-pins' || path === '/api/pick/revision-round' || path === '/api/pick/rounds' || path.startsWith('/api/pick/rounds/');
      if (!isNew) return route.fallback();
      let body = null;
      try { body = JSON.parse(req.postData() || 'null'); } catch (e) { /* not JSON */ }
      calls.push({ method, path, search: u.search, url: req.url(), headers: { token: h['x-share-token'] || '', key: h['x-picker-key'] || '' }, body, keepalive: null });
      const p = w.m.state.project;

      // ── PUT /api/pick/revision-pins
      if (path === '/api/pick/revision-pins') {
        ctl.putCount++;
        const f = injected('put');
        if (ctl.delay.put) await new Promise(r => setTimeout(r, ctl.delay.put));
        if (f) { if (f.effect) f.effect(); return f.net ? route.abort('failed') : json(route, f.body || { error: 'x' }, f.status); }
        const bad = common(route, h, ['PUT']);
        if (bad) return bad;
        const raw = req.postData() || '';
        if (Buffer.byteLength(raw) > 131072) return json(route, { error: '資料太大', code: 'too_large' }, 413);
        if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20)
          return json(route, { error: 'Invalid body', code: 'invalid_body' }, 400);
        const items = new Map();
        for (const it of body.items) {
          if (!it || typeof it.photo_key !== 'string' || !it.photo_key || it.photo_key.endsWith('/')) return json(route, { error: 'bad key', code: 'invalid_photo_key' }, 400);
          const marks = pickMarksCanonFake(it.marks);
          if (!marks) return json(route, { error: 'bad marks', code: 'invalid_marks' }, 400);
          items.set(it.photo_key, marks);
        }
        for (const k of items.keys()) if (!inFinals(k)) return json(route, { error: '不在精修資料夾', code: 'not_in_finals' }, 403);
        if (!migrated) return json(route, { error: '功能尚未啟用', code: 'revision_pins_unavailable' }, 500);
        if (p.client_confirmed_at) return json(route, { error: '已確認完成', code: 'already_confirmed' }, 409);
        if (w.m.state.revisions.some(r => !r.resolved_at)) return json(route, { error: '已有一輪', code: 'revision_open' }, 409);
        if (store.sig !== sig()) { store.sig = sig(); store.drafts = new Map(); }   // a draft of an older delivery is dropped
        const next = new Map(store.drafts);
        for (const [k, marks] of items) { if (marks.length) next.set(k, marks); else next.delete(k); }
        const total = [...next.values()].reduce((a, v) => a + v.length, 0);
        if (next.size > 100 && next.size > store.drafts.size) return json(route, { error: 'cap', code: 'revision_photos_cap', max: 100 }, 409);
        if (total > 300) return json(route, { error: 'cap', code: 'marks_cap', max: 300 }, 409);
        store.drafts = next;
        return json(route, { ok: true });
      }

      // ── POST /api/pick/revision-round
      if (path === '/api/pick/revision-round') {
        const f = injected('round');
        if (ctl.delay.round) await new Promise(r => setTimeout(r, ctl.delay.round));
        if (f) { if (f.effect) f.effect(); return f.net ? route.abort('failed') : json(route, f.body || { error: 'x' }, f.status); }
        const bad = common(route, h, ['POST']);
        if (bad) return bad;
        if (ctl.beforeRound) { const fn = ctl.beforeRound; ctl.beforeRound = null; fn(); }
        if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.expect) || body.expect.length > 100)
          return json(route, { error: 'Invalid body', code: 'invalid_body' }, 400);
        let note = null;
        if (body.note != null && !(typeof body.note === 'string' && !body.note.trim())) {
          note = revisionMessageFake(body.note);
          if (!note) return json(route, { error: '總說明不正確', code: 'invalid_message', max: 1000 }, 400);
        }
        for (const e of body.expect) if (!e || typeof e.k !== 'string' || !Number.isInteger(e.n) || e.n < 1 || e.n > 10) return json(route, { error: 'bad expect', code: 'invalid_body' }, 400);
        if (!migrated) return json(route, { error: '功能尚未啟用', code: 'revision_pins_unavailable' }, 500);
        if (p.client_confirmed_at) return json(route, { error: '已確認完成', code: 'already_confirmed' }, 409);
        if (w.m.state.revisions.some(r => !r.resolved_at)) return json(route, { error: '已有一輪', code: 'revision_open' }, 409);
        const cur = validDrafts();
        if (!cur.size) return json(route, { error: '沒有標示', code: 'no_pins' }, 409);
        const same = body.expect.length === cur.size && body.expect.every(e => cur.has(e.k) && cur.get(e.k).length === e.n);
        if (!same) return json(route, { error: '標示已變更', code: 'draft_changed' }, 409);
        if (w.m.state.revisions.length >= 50) return json(route, { error: '上限', code: 'revision_cap', max: 50 }, 409);
        const at = new Date().toISOString();
        const id = `00000000-0000-4000-8000-${String(rounds.length + 1).padStart(12, '0')}`;
        rounds.push({ id, kind: 'pins', created_at: at, open: true, note,
          photos: sortedKeys([...cur.keys()]).map(key => ({ key, pins: cur.get(key) })) });
        w.m.state.revisions.push({ id, picker_id: 'picker-0', message: note || RP_AUTO_MESSAGE, created_at: at, resolved_at: null });
        store.drafts = new Map();
        return json(route, { ok: true, id, created_at: at, photo_count: cur.size });
      }

      // ── history (GET only)
      const bad = common(route, h, ['GET']);
      if (bad) return bad;
      if (!migrated) return json(route, { error: '功能尚未啟用', code: 'revision_pins_unavailable' }, 500);
      const roundFor = id => {
        if (id === 'selection') return o.selection ? { id: 'selection', kind: 'selection', created_at: o.selection.created_at, open: false, note: null, photos: o.selection.photos } : null;
        return rounds.find(r => r.id === id) || null;
      };
      const keysOf = r => sortedKeys(r.photos.map(x => x.key));
      if (path === '/api/pick/rounds') {
        const f = injected('rounds');
        if (f) { if (f.effect) f.effect(); return f.net ? route.abort('failed') : json(route, f.body || { error: 'x' }, f.status); }
        const all = [...rounds, ...(o.selection ? [roundFor('selection')] : [])].sort((a, b) => cmp(b.created_at, a.created_at));
        return json(route, { rounds: all.map(r => ({ id: r.id, kind: r.kind, created_at: r.created_at, open: !!r.open, photo_count: r.photos.length, has_note: !!r.note })) });
      }
      const mm = /^\/api\/pick\/rounds\/([^/]+)(\/photo)?$/.exec(path);
      const r = mm ? roundFor(decodeURIComponent(mm[1])) : null;
      if (!r) return json(route, { error: 'Not found', code: 'not_found' }, 404);
      const keys = keysOf(r);
      if (!mm[2]) {
        const photos = keys.map((key, i) => ({ i, name: key.split('/').pop(), pins: r.photos.find(x => x.key === key).pins || [] }));
        photos.sort((a, b) => (b.pins.length > 0) - (a.pins.length > 0) || a.i - b.i);   // a selection round: pinned first
        return json(route, { id: r.id, kind: r.kind, created_at: r.created_at, open: !!r.open, note: r.note, photos });
      }
      // GET /api/pick/rounds/:id/photo?i=&w=
      if (u.searchParams.has('download')) return json(route, { error: 'x', code: 'invalid_request' }, 400);
      const wd = u.searchParams.get('w');
      if (wd !== '400' && wd !== '1200') return json(route, { error: 'x', code: 'invalid_width' }, 400);
      const iq = u.searchParams.get('i') || '';
      if (!/^\d{1,4}$/.test(iq) || +iq >= keys.length) return json(route, { error: 'Not found', code: 'not_found' }, 404);
      if (o.missingThumbs && o.missingThumbs.has(`${r.id}:${iq}`)) return json(route, { error: 'no thumbnail', code: 'no_thumbnail' }, 404);
      const k = keys[+iq];
      const idx = (o.files || w.files).indexOf(k);
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: albSvg(Math.max(0, idx), [600, 400]),
        headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
    });
  };
  // what the other tab / the photographer does: a round exists from now on
  const submitDirect = (keys, note = null) => {
    const at = new Date().toISOString();
    const id = `00000000-0000-4000-8000-${String(rounds.length + 1).padStart(12, '0')}`;
    rounds.push({ id, kind: 'pins', created_at: at, open: true, note,
      photos: sortedKeys(keys).map(key => ({ key, pins: [{ x: 0.5, y: 0.5, note: '另一個分頁' }] })) });
    w.m.state.revisions.push({ id, picker_id: 'picker-0', message: note || RP_AUTO_MESSAGE, created_at: at, resolved_at: null });
    store.drafts = new Map();
  };
  const setDrafts = list => { store.sig = sig(); store.drafts = new Map(list.map(d => [d.photo_key, d.marks])); };
  if (o.drafts) setDrafts(o.drafts);
  // a seeded open round is also an open revision_requests row (the state's revision_open)
  for (const r of rounds) if (r.open) w.m.state.revisions.push({ id: r.id, picker_id: 'picker-0', message: r.note || RP_AUTO_MESSAGE, created_at: r.created_at, resolved_at: null });
  return { ...w, store, rounds, calls, ctl, drafts: validDrafts, setDrafts, submitDirect, openRound };
}
// one photo's draft in the state's shape
export const draftOf = (key, marks) => ({ photo_key: key, marks });
export { OWNER_KEY };
