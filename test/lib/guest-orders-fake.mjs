// A fake of the Worker's S2 guest ordering routes (docs/guest-shop.md, 「S2 — built (Worker, WP1)」):
//   GET  /api/pick/orders              -> 200 {orders: [guest view]}
//   POST /api/pick/orders              -> the status / code table of the doc, in the doc's order
//   POST /api/pick/orders/:id/cancel   -> 200 {order} | 409 bad_transition | ...
// It sits on top of pickFakeWorker (test/lib/pick-fake.mjs: seat owner, delivered + confirmed, /shop with
// `ordering`): ordersWorld() wraps a world's `before` and registers its route AFTER the world's own, so it
// answers first and falls back for every other path.
//
// The checks run in the order of the doc's table. Money is computed from the catalogue (opts.products,
// the same list /shop serves) exactly as the Worker does:
//   print unit_price = option price;  album unit_price = option price + (spreads - min_pages) * extra_page_price
// and nothing the body says about money is read. Every answer carries Cache-Control: private, no-store.
//
// Controls for a test (`ctl`): failNext: ['net', 500, ...] consumed by POSTs (a number answers that status
// with a plain body); dropAfterWrite: write the order, then drop the connection (the replay scenario);
// delay: ms to hold every POST; force: {status, body} for the next POST only (an answer the page cannot
// provoke by itself); leakTransfer: a misbehaving Worker that sends transfer_info on a requested order;
// missingKeys: finals that are not in R2 (photo_not_found).
import { WORKER } from './delivery-helpers.mjs';

export const ORDERING = { consent_version: 'v1', delivery_methods: ['pickup'], max_lines: 20, print_qty_max: 10, album_qty_max: 3 };
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHONE = /^[0-9+\-() ]{6,20}$/;
const CTRL = /[\u0000-\u001F\u007F‪-‮⁦-⁩‎‏]/;
const whole = (v, lo, hi) => Number.isSafeInteger(v) && v >= lo && v <= hi;

export function ordersWorld(w, o = {}) {
  const products = o.products;                    // the /shop list
  const ordering = o.ordering === undefined ? ORDERING : o.ordering;
  const orders = [];                              // stored, oldest first: {id, picker_id, request_id, status, ...}
  const reqs = [];                                // every request this fake saw: {method, path, search, key, t, body, bodyText}
  const ctl = { failNext: [], dropAfterWrite: false, delay: 0, force: null, leakTransfer: false, missingKeys: new Set(o.missingKeys || []),
    ordersUnavailable: !!o.ordersUnavailable, transferInfo: o.transferInfo === undefined ? '轉帳：000-123 王小明\n備註請填訂單人姓名' : o.transferInfo };
  const state = w.m.state;
  const finals = () => {
    const folders = state.project.final_folders || [];
    return w.files.filter(k => folders.some(f => k.startsWith(f)));
  };
  const optionOf = id => {
    for (const p of products) for (const op of p.options) if (op.id === id) return { p, op };
    return null;
  };
  const view = ord => ({
    id: ord.id, status: ord.status, created_at: ord.created_at, confirmed_at: ord.confirmed_at || null, cancelled_at: ord.cancelled_at || null,
    items: ord.items.map(i => ({ kind: i.kind, name: i.name, option_label: i.option_label, qty: i.qty, unit_price: i.unit_price, photo_name: i.photo_name, spreads: i.spreads })),
    subtotal: ord.total, discount: 0, total: ord.total, paid: false, delivery_method: 'pickup', guest_note: ord.guest_note ?? null,
    contact: { name: ord.contact.name, phone: ord.contact.phone ?? null, line: ord.contact.line ?? null },
    transfer_info: (ord.status === 'confirmed' || ord.status === 'fulfilled' || ctl.leakTransfer) ? ctl.transferInfo : null,
  });
  const ownerPicker = key => {
    const p = key ? w.m.findByKey(key) : null;
    return p && state.project.owner_picker_id === p.id ? p : null;
  };

  const handler = async route => {
    const req = route.request();
    const u = new URL(req.url());
    const method = req.method();
    if (!(u.pathname === '/api/pick/orders' || u.pathname.startsWith('/api/pick/orders/'))) return route.fallback();
    const h = await req.allHeaders();
    const tok = u.searchParams.get('t') || h['x-share-token'] || '';
    const key = h['x-picker-key'] || '';
    const bodyText = req.postData() || '';
    let body = null;
    try { body = JSON.parse(bodyText || 'null'); } catch (e) { /* not JSON */ }
    reqs.push({ method, path: u.pathname, search: u.search, key, t: tok, body, bodyText, headers: h });
    const send = (data, status = 200, extra) => route.fulfill({ status, contentType: 'application/json', headers: { 'Cache-Control': 'private, no-store', ...(extra || {}) }, body: JSON.stringify(data) });
    const err = (status, code, extra) => send({ error: code || 'error', ...(code ? { code } : {}), ...(extra || {}) }, status);

    if (method === 'POST' && ctl.delay) await new Promise(r => setTimeout(r, ctl.delay));
    if (!tok || state.project.archived_at) return send({ error: 'Unauthorized' }, 401);
    const m = /^\/api\/pick\/orders\/([^/]+)\/cancel$/.exec(u.pathname);
    if (u.pathname !== '/api/pick/orders' && !m) return err(404, 'not_found');

    // ── cancel
    if (m) {
      if (method !== 'POST') return send({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
      const picker = ownerPicker(key);
      if (!picker) return err(403, 'not_owner');
      if (!UUID4.test(m[1]) && !/^[0-9a-f-]{36}$/i.test(m[1])) return err(404, 'not_found');
      if (ctl.ordersUnavailable) return err(500, 'orders_unavailable');
      const ord = orders.find(x => x.id === m[1] && x.picker_id === picker.id);
      if (!ord) return err(404, 'not_found');
      if (ord.status === 'cancelled') return send({ order: view(ord) });
      if (ord.status !== 'requested') return err(409, 'bad_transition', { from: ord.status, to: 'cancelled' });
      ord.status = 'cancelled'; ord.cancelled_at = new Date().toISOString();
      return send({ order: view(ord) });
    }

    // ── list
    if (method === 'GET') {
      const picker = ownerPicker(key);
      if (!picker) return err(403, 'not_owner');
      if (ctl.ordersUnavailable) return err(500, 'orders_unavailable');
      return send({ orders: orders.filter(x => x.picker_id === picker.id).slice().reverse().slice(0, 20).map(view) });
    }
    if (method !== 'POST') return send({ error: 'Method not allowed' }, 405, { Allow: 'GET, POST' });

    // ── create: the table of docs/guest-shop.md, in order
    if (ctl.force) { const f = ctl.force; ctl.force = null; return send(f.body, f.status); }
    const fail = ctl.failNext.shift();
    if (fail === 'net') return route.abort('failed');
    if (typeof fail === 'number') return send({ error: 'boom' }, fail);
    const picker = ownerPicker(key);
    if (!picker) return err(403, 'not_owner');
    if (!ordering) return err(403, 'ordering_disabled');
    if (!state.project.delivered_at || !state.project.client_confirmed_at) return err(409, 'not_confirmed');
    if (bodyText.length > 32 * 1024) return err(413, 'too_large', { max: 32768 });
    if (!body || typeof body !== 'object' || Array.isArray(body)) return err(400, 'invalid_body');
    if (typeof body.request_id !== 'string' || !UUID4.test(body.request_id)) return err(400, 'invalid_request_id');
    const lines = body.lines;
    if (!Array.isArray(lines) || !lines.length) return err(400, 'invalid_lines');
    if (lines.length > 20) return err(400, 'too_many_lines', { max: 20 });
    for (const l of lines) {
      if (!l || typeof l !== 'object' || Array.isArray(l) || typeof l.option_id !== 'string' || l.option_id.length < 1 || l.option_id.length > 200) return err(400, 'invalid_lines');
    }
    for (const l of lines) if (!whole(l.qty, 1, 10)) return err(400, 'invalid_qty');
    const seen = new Set();
    for (const l of lines) {
      const album = l.spreads !== undefined && l.photo_key === undefined;
      if (!album) {
        if (typeof l.photo_key !== 'string' || !l.photo_key || l.photo_key.length > 256 || CTRL.test(l.photo_key) || l.photo_key.endsWith('/')) return err(400, 'invalid_photo_key');
      } else if (!whole(l.spreads, 1, 200)) return err(400, 'invalid_spreads');
      const k = album ? `a|${l.option_id}` : `p|${l.option_id}|${l.photo_key}`;
      if (seen.has(k)) return err(400, 'duplicate_line');
      seen.add(k);
    }
    for (const l of lines) if (l.photo_key === undefined && l.spreads === undefined) return err(400, 'invalid_spreads');
    const c = body.contact;
    const okStr = (v, lo, hi) => typeof v === 'string' && v.trim().length >= lo && v.trim().length <= hi && !CTRL.test(v);
    if (!c || typeof c !== 'object' || !okStr(c.name, 1, 50)) return err(400, 'invalid_contact');
    const hasPhone = c.phone != null && c.phone !== '', hasLine = c.line != null && c.line !== '';
    if (!hasPhone && !hasLine) return err(400, 'invalid_contact');
    if (hasPhone && !(typeof c.phone === 'string' && PHONE.test(c.phone.trim()))) return err(400, 'invalid_contact');
    if (hasLine && !okStr(c.line, 1, 50)) return err(400, 'invalid_contact');
    if (body.delivery !== undefined && !(body.delivery && body.delivery.method === 'pickup')) return err(400, 'invalid_delivery');
    if (body.consent !== (ordering && ordering.consent_version)) return err(400, 'consent_required');
    if (body.note !== undefined && body.note !== null && (typeof body.note !== 'string' || body.note.length > 500 || /[\u0000-\u0009\u000B-\u001F\u007F‪-‮⁦-⁩]/.test(body.note))) return err(400, 'invalid_note');
    if (!whole(body.expected_total, 0, Number.MAX_SAFE_INTEGER)) return err(400, 'invalid_body');
    if (ctl.ordersUnavailable) return err(500, 'orders_unavailable');
    const prior = orders.find(x => x.request_id === body.request_id);
    if (prior && prior.picker_id === picker.id) return send({ order: view(prior), replay: true }, 200);
    if (o.shopUnavailable) return err(500, 'shop_unavailable');

    const fin = finals();
    const items = [], quote = [];
    for (const l of lines) {
      const hit = optionOf(l.option_id);
      if (!hit) return err(404, 'product_not_offered');
      const { p, op } = hit;
      const album = p.kind === 'album';
      if (album && l.photo_key !== undefined) return err(400, 'invalid_lines');
      if (!album && l.spreads !== undefined) return err(400, 'invalid_lines');
      let unit = op.price, name_photo = null, spreads = null;
      if (!album) {
        if (!fin.includes(l.photo_key)) return err(403, 'not_in_finals');
        if (ctl.missingKeys.has(l.photo_key)) return err(404, 'photo_not_found');
        name_photo = l.photo_key.split('/').pop();
      } else {
        if (p.min_pages == null) return err(400, 'album_not_orderable');
        if (l.spreads < p.min_pages) return err(400, 'pages_below_min', { min: p.min_pages });
        if (p.max_pages != null && l.spreads > p.max_pages) return err(400, 'pages_above_max', { max: p.max_pages });
        if (l.spreads > p.min_pages && p.extra_page_price == null) return err(400, 'extra_pages_unpriced');
        if (!whole(l.qty, 1, ordering.album_qty_max)) return err(400, 'invalid_qty');
        unit = op.price + (l.spreads - p.min_pages) * (p.extra_page_price || 0);
        spreads = l.spreads;
      }
      items.push({ kind: p.kind, name: p.name, option_label: op.label, qty: l.qty, unit_price: unit, photo_name: name_photo, spreads });
      quote.push({ option_id: l.option_id, qty: l.qty, unit_price: unit });
    }
    const total = items.reduce((a, i) => a + i.unit_price * i.qty, 0);
    if (total !== body.expected_total) return err(409, 'price_changed', { quote: { lines: quote, subtotal: total, total } });
    const mine = orders.filter(x => x.picker_id === picker.id);
    if (mine.filter(x => x.status === 'requested').length >= 3) return err(409, 'too_many_open_orders', { max: 3 });
    if (orders.length >= 20) return err(409, 'order_cap', { max: 20 });
    if (prior) return err(409, 'duplicate_request');
    const ord = {
      id: `${String(orders.length + 1).padStart(8, '0')}-0000-4000-8000-000000000000`, picker_id: picker.id, request_id: body.request_id, status: 'requested',
      created_at: new Date().toISOString(), items, total, guest_note: typeof body.note === 'string' && body.note ? body.note : null,
      contact: { name: c.name.trim(), phone: hasPhone ? c.phone.trim() : null, line: hasLine ? c.line.trim() : null },
    };
    orders.push(ord);
    if (ctl.dropAfterWrite) { ctl.dropAfterWrite = false; return route.abort('failed'); }
    return send({ order: view(ord) }, 201);
  };

  const before = async page => {
    await w.before(page);
    await page.route(WORKER + '/**', handler);
  };
  const confirm = id => { const x = orders.find(y => y.id === id); x.status = 'confirmed'; x.confirmed_at = new Date().toISOString(); };
  // seed an order of this seat holder (a previous visit)
  const seed = (over = {}) => {
    const picker = state.pickers.get(state.project.owner_picker_id);
    const ord = {
      id: `${String(orders.length + 1).padStart(8, '0')}-0000-4000-8000-000000000000`, picker_id: picker.id, request_id: `seed-${orders.length}`, status: 'requested',
      created_at: '2026-10-01T03:00:00.000Z', items: [{ kind: 'print', name: '無框畫', option_label: '16×20', qty: 1, unit_price: 3000, photo_name: 'IMG_0001.jpg', spreads: null }],
      total: 3000, guest_note: null, contact: { name: 'Zoe', phone: '0912-345-678', line: null }, ...over,
    };
    orders.push(ord);
    return ord;
  };
  const posts = () => reqs.filter(r => r.method === 'POST' && r.path === '/api/pick/orders');
  return { ...w, before, orders, reqs, ctl, posts, confirm, seed, view, ordering };
}
