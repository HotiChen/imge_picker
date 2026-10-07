// The orders / products Worker fake and the platform / product fixtures, plus the section-collapse
// helpers other suites reuse.
// Shared by more than one file in test/suites/; helpers used by a single suite file stay in that file.
import { PIXEL } from './env.mjs';

// ═══════════════════════════════════════════════════════════════════════════
// Products and orders (docs/products-orders.md, Phase A) — settings 商品,
// admin project 訂單, orders.html, dashboard revenue
// ═══════════════════════════════════════════════════════════════════════════

// A fake of the Phase A admin API that mirrors the real Worker's shapes and
// arithmetic (worker.js: readOrders, ORDER_*_SQL, the 400 {error, code} and
// 409 answers) — never a friendlier version of it. Chain it AFTER the fake
// that serves the rest of the page: anything it does not own falls through.
export function ordersFake(opts = {}) {
  const st = {
    products: opts.products || [],
    // CUSTOM_PRODUCTS: the Worker's switch for the photographer's own
    // products, off unless exactly "on" — so off here unless asked for
    customProducts: opts.customProducts === true,
    platform: opts.platform || [],   // platform catalogue: {id, kind, name, …, min_pages?, max_pages?, options: [{id, label, vendor_cost, platform_price, active, sort}]}
    // which page-bound columns the fake database has (worker.js pageColumns): a
    // missing one reads null and refuses a number (500 <col>_unavailable)
    pageColumns: { min_pages: true, max_pages: true, bleed_mm: true, ...(opts.pageColumns || {}) },
    imageSeq: 0,
    operatorToken: opts.operatorToken || 'op',
    orders: opts.orders || [],
    titles: opts.titles || {},
    extra: opts.extra || { count: null, pick_limit: null, extra_price: null, extra: 0, fee: 0, order_id: null, order_extra: null, matches: true },
    inject: null,            // (method, path, body) => {status, body} | null
    calls: [],
    n: 0,
  };
  const id = p => `${p}-${++st.n}`;
  const NOW = '2026-09-29T02:00:00.000Z';
  const money = o => {
    const subtotal = o.items.reduce((n, i) => n + i.unit_price * i.qty, 0);
    const total = Math.max(0, subtotal - o.discount);
    const cost = o.items.reduce((n, i) => n + i.unit_cost * i.qty, 0);
    const outstanding = ['confirmed', 'fulfilled'].includes(o.status) ? Math.max(0, total - o.paid_amount) : 0;
    return { subtotal, total, cost, outstanding };
  };
  const view = o => ({ ...o, project_title: st.titles[o.project_id] ?? '', ...money(o), items: o.items.map(({ vendor_cost, ...i }) => ({ ...i, photo_keys: [...i.photo_keys] })) });
  st.addOrder = (o = {}) => {
    const order = {
      id: o.id || id('ord'), photographer_id: 'default', project_id: o.project_id || 'proj-1', source: o.source || 'admin',
      status: o.status || 'confirmed', picker_id: null, discount: o.discount || 0, paid_amount: o.paid_amount || 0,
      paid_at: o.paid_at || null, paid_method: o.paid_method || null, note: o.note || '', guest_note: '',
      created_at: o.created_at || NOW, updated_at: o.updated_at || NOW,
      confirmed_at: NOW, fulfilled_at: null, cancelled_at: null,
      items: (o.items || []).map(i => ({
        id: i.id || id('item'), order_id: '', kind: i.kind || 'album', product_id: i.product_id ?? 'prod-x', option_id: i.option_id ?? 'opt-x',
        name: i.name, option_label: i.option_label || '', unit_price: i.unit_price, unit_cost: i.unit_cost || 0, qty: i.qty || 1,
        photo_keys: i.photo_keys || [], platform_option_id: i.platform_option_id ?? null, vendor_cost: i.vendor_cost || 0,
      })),
    };
    order.items.forEach(i => { i.order_id = order.id; });
    st.orders.push(order);
    return order;
  };
  const taipeiMonth = iso => new Date(Date.parse(iso) + 8 * 3600 * 1000).toISOString().slice(0, 7);
  // GET /api/operator/stats — the Worker's shape: 12 Taipei months, by paid_at,
  // cancelled excluded, revenue = unit_cost, vendor_cost from the line snapshot
  function operatorStats() {
    const [y, mo] = taipeiMonth(NOW).split('-').map(Number);
    const months = [];
    for (let i = 11; i >= 0; i--) { const d = new Date(Date.UTC(y, mo - 1 - i, 1)); months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`); }
    const zero = () => ({ qty: 0, revenue: 0, vendor_cost: 0, margin: 0 });
    const add = (into, r) => { into.qty += r.qty; into.revenue += r.revenue; into.vendor_cost += r.vendor_cost; into.margin = into.revenue - into.vendor_cost; };
    const perMonth = new Map(months.map(month => [month, { month, ...zero() }]));
    const prods = new Map(st.platform.map(pp => [pp.id, { platform_product_id: pp.id, name: pp.name, kind: pp.kind, active: pp.active, ...zero(), this_month: zero() }]));
    const thisMonth = months[months.length - 1];
    for (const o of st.orders) {
      if (o.status === 'cancelled' || !(o.paid_amount > 0) || !o.paid_at) continue;
      const month = taipeiMonth(o.paid_at);
      if (!perMonth.has(month)) continue;
      for (const i of o.items) {
        if (!i.platform_option_id) continue;
        const pp = st.platform.find(x => x.options.some(op => op.id === i.platform_option_id));
        if (!pp) continue;
        const r = { qty: i.qty, revenue: i.unit_cost * i.qty, vendor_cost: i.vendor_cost * i.qty };
        add(perMonth.get(month), r);
        const p = prods.get(pp.id);
        add(p, r);
        if (month === thisMonth) add(p.this_month, r);
      }
    }
    return { per_month: [...perMonth.values()], this_month: perMonth.get(thisMonth), products: [...prods.values()] };
  }

  // ── the platform catalogue (A2), mirroring worker.js: readProducts,
  // readPlatformProducts, adoptedOptions, productOptions(PLATFORM_MONEY) ───
  const MONEY_MAX = 10_000_000;
  const isMoney = v => Number.isSafeInteger(v) && v >= 0 && v <= MONEY_MAX;
  const platformOf = ppId => st.platform.find(x => x.id === ppId) || null;
  // an adopted product as the photographer reads it: the platform's live kind,
  // name, description, photo_count, image and option labels; cost is the
  // current platform price; never the vendor cost
  const viewProduct = p => {
    const pp = p.platform_product_id ? platformOf(p.platform_product_id) : null;
    const adopted = !!p.platform_product_id;
    const v = { ...p, platform_active: adopted ? (pp ? pp.active : 0) : null, min_pages: null, max_pages: null, bleed_mm: null };
    if (pp) Object.assign(v, { kind: pp.kind, name: pp.name, description: pp.description, photo_count: pp.photo_count,
      min_pages: pageRead(pp, 'min_pages'), max_pages: pageRead(pp, 'max_pages'), bleed_mm: bleedRead(pp),
      has_image: pp.has_image, image_type: pp.image_type, image_updated_at: pp.image_updated_at });
    v.options = p.options.map(o => {
      if (!o.platform_option_id) return { ...o };
      const po = pp ? pp.options.find(x => x.id === o.platform_option_id) : null;
      return { ...o, label: po ? po.label : o.label, cost: po ? po.platform_price : o.cost,
        platform_price: po ? po.platform_price : null, platform_active: po ? po.active : null,
        below_platform_price: !!po && o.price < po.platform_price };
    });
    return v;
  };
  const platView = pp => ({ id: pp.id, kind: pp.kind, name: pp.name, description: pp.description, photo_count: pp.photo_count,
    min_pages: pageRead(pp, 'min_pages'), max_pages: pageRead(pp, 'max_pages'), bleed_mm: bleedRead(pp),
    active: pp.active, sort: pp.sort, has_image: pp.has_image, image_type: pp.image_type, image_updated_at: pp.image_updated_at,
    created_at: NOW, updated_at: NOW, options: pp.options.map(o => ({ ...o })) });
  // the photographer's option, as an order line reads it
  const optionOf = optionId => {
    for (const raw of st.products) for (const op of viewProduct(raw).options) if (op.id === optionId) return { p: viewProduct(raw), op };
    return null;
  };
  // an option is usable for a new line unless it, its product or (adopted) the platform's is retired
  const optionUsable = ({ p, op }) => !!op.active && !!p.active && (!op.platform_option_id || (!!p.platform_active && !!op.platform_active));
  const vendorCostOf = op => {
    const pp = op.platform_option_id ? st.platform.find(x => x.options.some(o => o.id === op.platform_option_id)) : null;
    return pp ? pp.options.find(o => o.id === op.platform_option_id).vendor_cost : 0;
  };
  const bad = (code, status = 400) => ({ status, body: { error: code.replace(/_/g, ' '), code } });

  // platform_products.min_pages / max_pages (worker.js: albumOnly, pageBoundsWrite,
  // pageBoundsFit, PAGES_UNAVAILABLE): safe integer 1–200 or null, albums only,
  // max ≥ min on the merged row; a number for a column the database lacks is a
  // 500 <col>_unavailable, a missing column reads null
  const PAGE_BOUNDS = ['min_pages', 'max_pages'];
  const PAGES_UNAVAILABLE = {
    min_pages: { error: '最少頁數功能尚未啟用', code: 'min_pages_unavailable' },
    max_pages: { error: '最多頁數功能尚未啟用', code: 'max_pages_unavailable' },
  };
  const albumOnly = (kind, v) => (kind === 'album' && v != null ? v : null);
  const pageRead = (pp, col) => (st.pageColumns[col] ? albumOnly(pp.kind, pp[col]) : null);
  // platform_products.bleed_mm (worker.js: bleedWrite, BLEED_MM_MAX): a finite number 0–10
  // or null, albums AND prints; absent from a PUT keeps it; a number for a missing
  // column is 500 bleed_mm_unavailable; a missing column reads null
  const bleedRead = pp => (st.pageColumns.bleed_mm && pp.bleed_mm != null ? pp.bleed_mm : null);
  function bleedWrite(body) {
    if (!('bleed_mm' in body)) return { set: {} };
    const v = body.bleed_mm;
    if (v !== null && !(typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10)) return { bad: 'invalid_bleed_mm' };
    if (v !== null && !st.pageColumns.bleed_mm) return { unavailable: { error: '出血設定功能尚未啟用', code: 'bleed_mm_unavailable' } };
    return { set: { bleed_mm: v } };
  }
  // returns {set} (the bounds to store) | {bad} | {unavailable}
  function pageBoundsWrite(body, kind, current) {
    const named = {};
    for (const col of PAGE_BOUNDS) {
      if (!(col in body)) continue;
      const v = body[col];
      if (v !== null && !(Number.isSafeInteger(v) && v >= 1 && v <= 200)) return { bad: `invalid_${col}` };
      named[col] = v;
    }
    const set = {};
    if (kind !== 'album') {
      for (const col of PAGE_BOUNDS) if (col in named || (current && current.kind === 'album')) set[col] = null;
    } else {
      for (const col of PAGE_BOUNDS) set[col] = col in named ? named[col] : (current ? pageRead(current, col) : null);
      if (set.min_pages !== null && set.max_pages !== null && set.max_pages < set.min_pages) return { bad: 'invalid_page_range' };
      const entering = current !== null && current.kind !== 'album';
      for (const col of PAGE_BOUNDS) if (!(col in named) && !entering) delete set[col];
    }
    for (const col of PAGE_BOUNDS) if (col in set && !st.pageColumns[col] && set[col] !== null) return { unavailable: PAGES_UNAVAILABLE[col] };
    return { set };
  }

  // productOptions(): {id?, label, ...money}; returns {options} | {bad}
  function checkOptions(value, existingIds, money) {
    if (!Array.isArray(value) || !value.length || value.length > 20) return { bad: 'invalid_options' };
    const seen = new Set(), options = [];
    for (const [i, o] of value.entries()) {
      if (!o || typeof o !== 'object' || Array.isArray(o)) return { bad: 'invalid_options' };
      if (o.id !== undefined) {
        if (typeof o.id !== 'string' || !existingIds.has(o.id) || seen.has(o.id)) return { bad: 'invalid_options' };
        seen.add(o.id);
      }
      const label = o.label == null ? '' : o.label;
      if (typeof label !== 'string' || [...label.trim()].length > 60) return { bad: 'invalid_label' };
      const option = { id: o.id, label: label.trim(), sort: i };
      for (const [field, code, dflt] of money) {
        const v = o[field] === undefined && dflt !== undefined ? dflt : o[field];
        if (!isMoney(v)) return { bad: code };
        option[field] = v;
      }
      options.push(option);
    }
    return { options };
  }
  const CUSTOM_MONEY = [['price', 'invalid_price'], ['cost', 'invalid_cost', 0]];
  const PLATFORM_MONEY = [['vendor_cost', 'invalid_vendor_cost'], ['platform_price', 'invalid_platform_price']];
  // productFields(): kind/name/description/photo_count/sort of a body
  function checkFields(body, partial, kinds) {
    const set = {};
    if (!partial || 'kind' in body) { if (!kinds.includes(body.kind)) return { bad: 'invalid_kind' }; set.kind = body.kind; }
    if (!partial || 'name' in body) {
      const v = typeof body.name === 'string' ? body.name.trim() : '';
      if (!v || [...v].length > 60) return { bad: 'invalid_name' };
      set.name = v;
    }
    if ('description' in body) {
      const v = body.description === null ? '' : body.description;
      if (typeof v !== 'string' || [...v.trim()].length > 500) return { bad: 'invalid_description' };
      set.description = v.trim();
    }
    if ('photo_count' in body) {
      const v = body.photo_count;
      if (v !== null && !(Number.isSafeInteger(v) && v >= 1 && v <= 500)) return { bad: 'invalid_photo_count' };
      set.photo_count = v;
    }
    if ('sort' in body) { if (!(Number.isSafeInteger(body.sort) && body.sort >= 0)) return { bad: 'invalid_sort' }; set.sort = body.sort; }
    return { set };
  }
  // adoptedOptions(): [{platform_option_id, price}] against one platform product
  function checkAdopted(value, pp) {
    if (!Array.isArray(value) || !value.length || value.length > 20) return { bad: 'invalid_options' };
    const seen = new Set(), options = [];
    for (const [i, o] of value.entries()) {
      if (!o || typeof o !== 'object' || Array.isArray(o)) return { bad: 'invalid_options' };
      const po = typeof o.platform_option_id === 'string' ? pp.options.find(x => x.id === o.platform_option_id) : null;
      if (!po || seen.has(po.id)) return { bad: 'invalid_options' };
      seen.add(po.id);
      if (!isMoney(o.price)) return { bad: 'invalid_price' };
      if (!(po.active && pp.active)) return { bad: 'retired_option' };
      if (o.price < po.platform_price) return { bad: 'below_platform_price' };
      options.push({ platform_option_id: po.id, label: po.label, price: o.price, cost: po.platform_price, sort: i });
    }
    return { options };
  }
  // sniffImageType(): PNG / JPEG / WebP by magic bytes
  function sniff(b) {
    if (!b || b.length < 12) return null;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') return 'image/webp';
    return null;
  }

  function handle(method, path, params, body, bytes) {
    if (st.inject) { const hit = st.inject(method, path, body); if (hit) return hit; }
    let m;
    // ── the public platform image ──
    if ((m = /^\/api\/platform\/products\/([^/]+)\/image$/.exec(path))) {
      if (method !== 'GET') return { status: 405, body: { error: 'Method not allowed' } };
      const pp = platformOf(decodeURIComponent(m[1]));
      if (!pp || !pp.has_image) return { status: 404, body: { error: 'Not found' } };
      return { raw: PIXEL, type: 'image/png' };
    }
    // ── the operator's catalogue ──
    if (path === '/api/operator/products' && method === 'GET') return { body: { products: st.platform.map(platView) } };
    if (path === '/api/operator/products' && method === 'POST') {
      const f = checkFields(body, false, ['print', 'album']);
      if (f.bad) return bad(f.bad);
      const bounds = pageBoundsWrite(body, f.set.kind, null);
      if (bounds.bad) return bad(bounds.bad);
      const bleed = bleedWrite(body);
      if (bleed.bad) return bad(bleed.bad);
      const opts = checkOptions(body.options, new Set(), PLATFORM_MONEY);
      if (opts.bad) return bad(opts.bad);
      if (bounds.unavailable) return { status: 500, body: bounds.unavailable };
      if (bleed.unavailable) return { status: 500, body: bleed.unavailable };
      const pp = { id: id('plat'), description: '', photo_count: null, sort: 0, ...f.set, ...bounds.set, ...bleed.set, active: 1, has_image: false, image_type: null, image_updated_at: null,
        options: opts.options.map(o => ({ id: id('popt'), label: o.label, vendor_cost: o.vendor_cost, platform_price: o.platform_price, active: 1, sort: o.sort })) };
      if (pp.kind !== 'album') pp.photo_count = null;
      st.platform.push(pp);
      return { status: 201, body: { product: platView(pp) } };
    }
    if ((m = /^\/api\/operator\/products\/([^/]+)$/.exec(path)) && method === 'PUT') {
      const pp = platformOf(m[1]);
      if (!pp) return { status: 404, body: { error: 'Not found' } };
      const f = checkFields(body, true, ['print', 'album']);
      if (f.bad) return bad(f.bad);
      const bounds = pageBoundsWrite(body, f.set.kind ?? pp.kind, pp);
      if (bounds.bad) return bad(bounds.bad);
      const bleed = bleedWrite(body);
      if (bleed.bad) return bad(bleed.bad);
      let opts = null;
      if ('options' in body) {
        const c = checkOptions(body.options, new Set(pp.options.map(o => o.id)), PLATFORM_MONEY);
        if (c.bad) return bad(c.bad);
        opts = c.options;
      }
      if (bounds.unavailable) return { status: 500, body: bounds.unavailable };
      if (bleed.unavailable) return { status: 500, body: bleed.unavailable };
      Object.assign(pp, f.set, bounds.set, bleed.set);
      if (pp.kind !== 'album') pp.photo_count = null;
      if (opts) {
        const keep = new Set(opts.filter(o => o.id).map(o => o.id));
        pp.options.forEach(o => { if (!keep.has(o.id)) o.active = 0; });
        opts.forEach(o => {
          if (o.id) Object.assign(pp.options.find(x => x.id === o.id), { label: o.label, vendor_cost: o.vendor_cost, platform_price: o.platform_price, sort: o.sort, active: 1 });
          else pp.options.push({ id: id('popt'), label: o.label, vendor_cost: o.vendor_cost, platform_price: o.platform_price, active: 1, sort: o.sort });
        });
        pp.options.sort((a, b) => a.sort - b.sort);
      }
      return { body: { product: platView(pp) } };
    }
    if ((m = /^\/api\/operator\/products\/([^/]+)\/(retire|restore)$/.exec(path)) && method === 'POST') {
      const pp = platformOf(m[1]);
      if (!pp) return { status: 404, body: { error: 'Not found' } };
      pp.active = m[2] === 'restore' ? 1 : 0;
      return { body: { ok: true, active: pp.active } };
    }
    if ((m = /^\/api\/operator\/products\/([^/]+)\/image$/.exec(path)) && (method === 'PUT' || method === 'DELETE')) {
      const pp = platformOf(m[1]);
      if (!pp) return { status: 404, body: { error: 'Not found' } };
      if (method === 'DELETE') { Object.assign(pp, { has_image: false, image_type: null, image_updated_at: null }); return { body: { ok: true, has_image: false } }; }
      if (bytes.length > 204800) return { status: 413, body: { error: '商品圖片不可超過 200 KB', code: 'too_large', max: 204800 } };
      const type = sniff(bytes);
      if (!type) return { status: 415, body: { error: '商品圖片只接受 PNG、JPEG 或 WebP', code: 'unsupported_type' } };
      const stamp = new Date(Date.parse(NOW) + (++st.imageSeq) * 1000).toISOString();
      Object.assign(pp, { has_image: true, image_type: type, image_updated_at: stamp });
      return { body: { ok: true, has_image: true, image_type: type, image_updated_at: stamp, size: bytes.length } };
    }
    if (path === '/api/operator/stats' && method === 'GET') return { body: operatorStats() };
    // ── the photographer's view of the platform ──
    if (path === '/api/admin/platform-products' && method === 'GET') {
      const products = st.platform.filter(pp => pp.active).map(pp => {
        const mine = st.products.find(p => p.platform_product_id === pp.id);
        return { id: pp.id, kind: pp.kind, name: pp.name, description: pp.description, photo_count: pp.photo_count, sort: pp.sort,
          min_pages: pageRead(pp, 'min_pages'), max_pages: pageRead(pp, 'max_pages'),
          has_image: pp.has_image, image_updated_at: pp.image_updated_at, adopted_product_id: mine ? mine.id : null,
          options: pp.options.filter(o => o.active).map(o => ({ id: o.id, label: o.label, platform_price: o.platform_price, sort: o.sort })) };
      }).filter(p => p.options.length);
      return { body: { products } };
    }
    if (path === '/api/admin/products/from-platform' && method === 'POST') {
      const pp = typeof body.platform_product_id === 'string' ? platformOf(body.platform_product_id) : null;
      if (!pp) return bad('unknown_platform_product');
      if (!pp.active) return bad('retired_option');
      const opts = checkAdopted(body.options, pp);
      if (opts.bad) return bad(opts.bad);
      const existing = st.products.find(p => p.platform_product_id === pp.id);
      if (existing) return { status: 409, body: { error: '已加入這個平台商品', code: 'already_adopted', product_id: existing.id } };
      const p = { id: id('prod'), kind: pp.kind, name: pp.name, description: pp.description, photo_count: pp.photo_count, guest_visible: 0, active: 1, sort: 0,
        has_image: false, image_type: null, image_updated_at: null, created_at: NOW, updated_at: NOW, platform_product_id: pp.id,
        options: opts.options.map(o => ({ id: id('opt'), label: o.label, price: o.price, cost: o.cost, active: 1, sort: o.sort, platform_option_id: o.platform_option_id })) };
      st.products.push(p);
      return { status: 201, body: { product: viewProduct(p) } };
    }
    // ── the photographer's products ──
    if (path === '/api/admin/products' && method === 'GET') return { body: { products: st.products.map(viewProduct), custom_products_enabled: st.customProducts } };
    // with the switch off a custom product can be retired, never made, edited or restored
    const customOff = { status: 403, body: { error: '目前只能從平台加入商品', code: 'custom_products_disabled' } };
    if (path === '/api/admin/products' && method === 'POST') {
      if (!st.customProducts) return customOff;
      const f = checkFields(body, false, ['album', 'print', 'service']);
      if (f.bad) return bad(f.bad);
      if (f.set.kind !== 'service') return bad('platform_only');
      const opts = checkOptions(body.options, new Set(), CUSTOM_MONEY);
      if (opts.bad) return bad(opts.bad);
      const p = {
        id: id('prod'), description: '', photo_count: null, guest_visible: 0, sort: 0, ...f.set, active: 1,
        has_image: false, image_type: null, image_updated_at: null, created_at: NOW, updated_at: NOW, platform_product_id: null,
        options: opts.options.map(o => ({ id: id('opt'), label: o.label, price: o.price, cost: o.cost, active: 1, sort: o.sort })),
      };
      p.photo_count = null;
      st.products.push(p);
      return { status: 201, body: { product: viewProduct(p) } };
    }
    if ((m = /^\/api\/admin\/products\/([^/]+)$/.exec(path)) && method === 'PUT') {
      const p = st.products.find(x => x.id === m[1]);
      if (!p) return { status: 404, body: { error: 'Not found' } };
      if (p.platform_product_id) {
        if (['kind', 'name', 'description', 'photo_count', 'min_pages', 'max_pages', 'bleed_mm'].some(k => k in body)) return bad('platform_managed');
        const f = checkFields(body, true, []);
        if (f.bad) return bad(f.bad);
        let opts = null;
        if ('options' in body) {
          const pp = platformOf(p.platform_product_id) || { active: 0, options: [] };
          const c = checkAdopted(body.options, pp);
          if (c.bad) return bad(c.bad);
          opts = c.options;
        }
        if (opts) {
          const keep = new Set(opts.map(o => o.platform_option_id));
          p.options.forEach(o => { if (!keep.has(o.platform_option_id)) o.active = 0; });
          opts.forEach(o => {
            const row = p.options.find(x => x.platform_option_id === o.platform_option_id);
            if (row) Object.assign(row, { price: o.price, cost: o.cost, label: o.label, sort: o.sort, active: 1 });
            else p.options.push({ id: id('opt'), label: o.label, price: o.price, cost: o.cost, active: 1, sort: o.sort, platform_option_id: o.platform_option_id });
          });
        }
        if ('sort' in f.set) p.sort = f.set.sort;
        return { body: { product: viewProduct(p) } };
      }
      if (!st.customProducts) return customOff;
      const f = checkFields(body, true, ['album', 'print', 'service']);
      if (f.bad) return bad(f.bad);
      if (f.set.kind !== undefined && f.set.kind !== 'service') return bad('platform_only');
      let opts = null;
      if ('options' in body) {
        const c = checkOptions(body.options, new Set(p.options.map(o => o.id)), CUSTOM_MONEY);
        if (c.bad) return bad(c.bad);
        opts = c.options;
      }
      Object.assign(p, f.set);
      if (p.kind !== 'album') p.photo_count = null;
      if (opts) {
        const keep = new Set(opts.filter(o => o.id).map(o => o.id));
        p.options.forEach(o => { if (!keep.has(o.id)) o.active = 0; });
        opts.forEach(o => {
          if (o.id) Object.assign(p.options.find(x => x.id === o.id), { label: o.label, price: o.price, cost: o.cost, sort: o.sort, active: 1 });
          else p.options.push({ id: id('opt'), label: o.label, price: o.price, cost: o.cost, active: 1, sort: o.sort });
        });
      }
      return { body: { product: viewProduct(p) } };
    }
    if ((m = /^\/api\/admin\/products\/([^/]+)\/(retire|restore)$/.exec(path)) && method === 'POST') {
      const p = st.products.find(x => x.id === m[1]);
      if (!p) return { status: 404, body: { error: 'Not found' } };
      if (m[2] === 'restore' && !p.platform_product_id && !st.customProducts) return customOff;
      p.active = m[2] === 'restore' ? 1 : 0;
      return { body: { ok: true, active: p.active } };
    }
    if (path === '/api/admin/orders' && method === 'GET') {
      const wanted = params.get('status');
      let list = st.orders.map(view);
      if (wanted) list = list.filter(o => o.status === wanted);
      if (params.get('unpaid') === '1') list = list.filter(o => o.outstanding > 0);
      return { body: { orders: list.slice().reverse() } };
    }
    if ((m = /^\/api\/admin\/projects\/([^/]+)\/orders$/.exec(path))) {
      const pid = decodeURIComponent(m[1]);
      if (method === 'GET') return { body: { orders: st.orders.filter(o => o.project_id === pid).map(view).reverse(), extra_pick: st.extra } };
      if (method === 'POST') {
        if (!Array.isArray(body.lines) || !body.lines.length) return bad('invalid_lines');
        const items = [];
        for (const l of body.lines) {
          const hit = optionOf(l.option_id);
          if (!hit) return bad('unknown_option');
          if (!optionUsable(hit)) return bad('retired_option');
          if (!(Number.isSafeInteger(l.qty) && l.qty >= 1 && l.qty <= 999)) return bad('invalid_qty');
          const line = { kind: hit.p.kind, product_id: hit.p.id, option_id: hit.op.id, name: hit.p.name, option_label: hit.op.label,
            unit_price: l.unit_price ?? hit.op.price, unit_cost: hit.op.cost, qty: l.qty, photo_keys: l.photo_keys || [],
            platform_option_id: hit.op.platform_option_id ?? null, vendor_cost: vendorCostOf(hit.op) };
          // the platform price is a floor, an explicit unit_price included
          if (line.platform_option_id && line.unit_price < hit.op.platform_price) return bad('below_platform_price');
          items.push(line);
        }
        const sub = items.reduce((n, i) => n + i.unit_price * i.qty, 0);
        if ((body.discount ?? 0) > sub) return bad('discount_exceeds_subtotal');
        const order = st.addOrder({ project_id: pid, items, discount: body.discount ?? 0, note: body.note || '' });
        return { status: 201, body: { order: view(order) } };
      }
    }
    if ((m = /^\/api\/admin\/orders\/([^/]+)$/.exec(path)) && method === 'PUT') {
      const o = st.orders.find(x => x.id === m[1]);
      if (!o) return { status: 404, body: { error: 'Not found' } };
      if (o.status === 'cancelled' && ('lines' in body || 'discount' in body)) return { status: 409, body: { error: '訂單已取消', code: 'cancelled' } };
      const items = [];
      for (const l of body.lines ?? o.items.map(i => ({ id: i.id }))) {
        const old = l.id ? o.items.find(i => i.id === l.id) : null;
        if (l.id && !old) return bad('unknown_line');
        if (old) {
          // a kept platform line is never repriced under its own snapshotted cost
          if (old.platform_option_id && l.unit_price != null && l.unit_price < old.unit_cost) return bad('below_platform_price');
          items.push({ ...old, qty: l.qty ?? old.qty, unit_price: l.unit_price ?? old.unit_price, photo_keys: l.photo_keys ?? old.photo_keys });
        } else {
          const hit = optionOf(l.option_id);
          if (!hit) return bad('unknown_option');
          if (!optionUsable(hit)) return bad('retired_option');
          const line = { id: id('item'), order_id: o.id, kind: hit.p.kind, product_id: hit.p.id, option_id: hit.op.id, name: hit.p.name,
            option_label: hit.op.label, unit_price: l.unit_price ?? hit.op.price, unit_cost: hit.op.cost, qty: l.qty, photo_keys: l.photo_keys || [],
            platform_option_id: hit.op.platform_option_id ?? null, vendor_cost: vendorCostOf(hit.op) };
          if (line.platform_option_id && line.unit_price < hit.op.platform_price) return bad('below_platform_price');
          items.push(line);
        }
      }
      const discount = 'discount' in body ? body.discount : o.discount;
      const sub = items.reduce((n, i) => n + i.unit_price * i.qty, 0);
      if (discount > sub) return bad('discount_exceeds_subtotal');
      if (sub - discount < o.paid_amount) return bad('below_paid');
      o.items = items; o.discount = discount;
      if ('note' in body) o.note = body.note;
      if (o.source === 'system') o.source = 'admin';
      return { body: { order: view(o) } };
    }
    if ((m = /^\/api\/admin\/orders\/([^/]+)\/payment$/.exec(path)) && method === 'POST') {
      const o = st.orders.find(x => x.id === m[1]);
      if (!o) return { status: 404, body: { error: 'Not found' } };
      const amount = body.paid_amount;
      if (!Number.isSafeInteger(amount) || amount < 0) return bad('invalid_paid_amount');
      if (amount > 0) {
        if (!['cash', 'transfer', 'other'].includes(body.paid_method)) return bad('invalid_paid_method');
        if (o.status === 'cancelled') return { status: 409, body: { error: '訂單已取消', code: 'cancelled' } };
        if (amount > money(o).total) return bad('overpaid');
        o.paid_amount = amount; o.paid_method = body.paid_method;
        o.paid_at = body.paid_at ? new Date(body.paid_at).toISOString() : NOW;
      } else { o.paid_amount = 0; o.paid_method = null; o.paid_at = null; }
      return { body: { order: view(o) } };
    }
    if ((m = /^\/api\/admin\/orders\/([^/]+)\/status$/.exec(path)) && method === 'POST') {
      const o = st.orders.find(x => x.id === m[1]);
      if (!o) return { status: 404, body: { error: 'Not found' } };
      const arrows = { requested: ['confirmed', 'cancelled'], confirmed: ['fulfilled', 'cancelled'], fulfilled: ['confirmed', 'cancelled'], cancelled: [] };
      if (body.status === o.status) return { body: { order: view(o) } };
      if (!arrows[o.status].includes(body.status))
        return { status: 409, body: { error: `無法從 ${o.status} 改為 ${body.status}`, code: 'bad_transition', from: o.status, to: body.status } };
      o.status = body.status;
      return { body: { order: view(o) } };
    }
    return null;
  }

  const attach = async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const method = req.method();
      const p = u.pathname;
      const isPublic = /^\/api\/platform\//.test(p);
      const isOperator = /^\/api\/operator\//.test(p);
      const mine = isPublic || isOperator || /^\/api\/admin\/(products|orders|platform-products)(\/|$)/.test(p) || /^\/api\/admin\/projects\/[^/]+\/orders$/.test(p);
      if (!mine) return route.fallback();
      let body = null;
      try { body = JSON.parse(req.postData() || 'null'); } catch (e) { /* none, or raw bytes */ }
      const bytes = req.postDataBuffer() || Buffer.alloc(0);
      const h = await req.allHeaders();
      st.calls.push({ method, path: p, search: u.search, body, auth: h['authorization'] || null, size: bytes.length, type: h['content-type'] || null });
      // the two sides never open each other's routes: the operator token is
      // refused on /api/admin and the photographer's on /api/operator
      if (!isPublic && (h['authorization'] || null) !== (isOperator ? `Bearer ${st.operatorToken}` : 'Bearer adm'))
        return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Unauthorized' }) });
      const res = handle(method, p, u.searchParams, body || {}, bytes) || { status: 404, body: { error: 'Not found' } };
      if (res.raw) return route.fulfill({ status: res.status || 200, contentType: res.type, body: res.raw });
      route.fulfill({ status: res.status || 200, contentType: 'application/json', body: JSON.stringify(res.body) });
    });
  };
  return { st, attach };
}

// The platform's own catalogue (what the operator lists) and the photographer's
// adopted products from it. An adopted option's label / cost are read from the
// platform live, so the copies stored on the adopted rows are only placeholders.
export const PLAT_ALBUM = { id: 'plat-album', kind: 'album', name: '相本書', description: '20 頁精裝', photo_count: 20, active: 1, sort: 0,
  has_image: true, image_type: 'image/png', image_updated_at: '2026-09-01T00:00:00.000Z',
  options: [
    { id: 'popt-album-s', label: '8×8 吋', vendor_cost: 1400, platform_price: 1500, active: 1, sort: 0 },
    { id: 'popt-album-l', label: '12×12 吋', vendor_cost: 2300, platform_price: 2400, active: 1, sort: 1 },
    { id: 'popt-album-old', label: '舊規格', vendor_cost: 40, platform_price: 50, active: 0, sort: 2 },
  ] };
export const PLAT_PRINT = { id: 'plat-print', kind: 'print', name: '無框畫', description: '', photo_count: null, active: 1, sort: 1,
  has_image: false, image_type: null, image_updated_at: null,
  options: [{ id: 'popt-print', label: '', vendor_cost: 450, platform_price: 500, active: 1, sort: 0 }] };
export const PROD_ALBUM = { id: 'prod-album', kind: 'album', name: '相本書', description: '20 頁精裝', photo_count: 20, guest_visible: 0, active: 1, sort: 0,
  has_image: false, image_type: null, image_updated_at: null, created_at: '', updated_at: '', platform_product_id: 'plat-album',
  options: [
    { id: 'opt-album-s', label: '8×8 吋', price: 3800, cost: 1500, active: 1, sort: 0, platform_option_id: 'popt-album-s' },
    { id: 'opt-album-l', label: '12×12 吋', price: 5800, cost: 2400, active: 1, sort: 1, platform_option_id: 'popt-album-l' },
    { id: 'opt-album-old', label: '舊規格', price: 100, cost: 50, active: 0, sort: 2, platform_option_id: 'popt-album-old' },
  ] };
export const PROD_PRINT = { id: 'prod-print', kind: 'print', name: '無框畫', description: '', photo_count: null, guest_visible: 0, active: 1, sort: 1,
  has_image: false, image_type: null, image_updated_at: null, created_at: '', updated_at: '', platform_product_id: 'plat-print',
  options: [{ id: 'opt-print', label: '', price: 1200, cost: 500, active: 1, sort: 0, platform_option_id: 'popt-print' }] };
export const PROD_SERVICE_OFF = { id: 'prod-svc', kind: 'service', name: '急件加修', description: '', photo_count: null, guest_visible: 0, active: 0, sort: 2,
  has_image: false, image_type: null, image_updated_at: null, created_at: '', updated_at: '', platform_product_id: null,
  options: [{ id: 'opt-svc', label: '', price: 500, cost: 0, active: 1, sort: 0 }] };
export const clone = x => JSON.parse(JSON.stringify(x));
export const waitText = (page, sel, pred, timeout = 4000) =>
  page.waitForFunction(([s, src]) => { const el = document.querySelector(s); return !!el && new Function('t', `return (${src})(t)`)(el.textContent); },
    [sel, pred.toString()], { timeout });

// ── settings: 商品 ──────────────────────────────────────────────────────────
export const platFx = () => [clone(PLAT_ALBUM), clone(PLAT_PRINT)];
export const T = (page, sel) => page.textContent(sel);
export const disp = (page, sel) => page.$eval(sel, e => getComputedStyle(e).display);
export const RED = 'rgb(192, 57, 43)';

// ── admin.html project detail: 訂單 ────────────────────────────────────────
export const ADMIN_PICKS = m => {
  const at = '2026-01-01T00:00:00.000Z';
  m.state.selections.set('20260819/IMG_1.jpg', { rating: 1, note: '', updated_by: 'x', updated_at: at });
  m.state.selections.set('20260819/IMG_2.jpg', { rating: 1, note: '', updated_by: 'x', updated_at: at });
  m.state.selections.set('20260819/IMG_3.jpg', { rating: 0, note: '', updated_by: 'x', updated_at: at });
};

// ═══════════════════════════════════════════════════════════════════════════
// admin.html 專案詳情：每個區塊用標題列收合（標題＋一行摘要＋▾/▸）。
// 頂部（標題、徽章、挑選人、操作按鈕列）不收合。展開狀態存在 localStorage（只是便利）。
// 這一段用 ADMIN_PLAIN（沒有預存的展開偏好）來看預設；其他舊的 admin suite 用 ADMIN，
// 它預存「全部展開」，等於一個已經把區塊都打開過的攝影師。
// ═══════════════════════════════════════════════════════════════════════════
export const SEC_NAMES = ['delivery', 'settings', 'selections', 'orders', 'submissions', 'people'];
export const secInfo = page => page.evaluate(names => Object.fromEntries(names.map(n => {
  const sec = document.getElementById('pd-sec-' + n), btn = document.getElementById(`pd-sec-${n}-btn`);
  const body = document.getElementById(`pd-sec-${n}-body`), sum = document.getElementById(`pd-sec-${n}-sum`);
  return [n, sec && btn && body && sum ? {
    title: btn.querySelector('.pd-sec-title').textContent.trim(), sum: sum.textContent.trim(), expanded: btn.getAttribute('aria-expanded'),
    controls: btn.getAttribute('aria-controls'), bodyId: body.id, display: getComputedStyle(body).display, secDisplay: getComputedStyle(sec).display,
    caret: btn.querySelector('.pd-sec-caret').textContent.trim(), tag: btn.tagName, type: btn.type,
  } : null];
})), SEC_NAMES);
export const secWait = page => page.waitForSelector('#pd-sec-settings-btn', { timeout: 5000 });
export const secOpen = i => i && i.expanded === 'true' && i.display !== 'none' && i.caret === '▾';

// ── operator.html: the operator's own sign-in key and a seed for it ────────
export const OP_KEY = 'imhoti_operator_token';
// seeds the operator token once per tab (sessionStorage marks it), so a later
// sign-out or reload is not undone by the init script running again
export const OP_SEED = () => { if (!sessionStorage.getItem('__seeded')) { localStorage.setItem('imhoti_operator_token', 'op'); sessionStorage.setItem('__seeded', '1'); } };
