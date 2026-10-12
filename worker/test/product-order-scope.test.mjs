// Batch 2b-2 of docs/multi-photographer.md: the products and orders routes
// are scoped to the calling photographer (who.id), and the default token is
// no super-user. The platform catalogue (platform_products) stays shared and
// read-only; a photographer adopts into his own products.
//
// For every scoped route that takes an id, with two photographers in one
// database:
// - B on A's resource, and A on B's: 404, the same body as for an id nobody
//   has, the same statements in the same order, and nothing written anywhere
//   (every D1 table and every R2 object compared);
// - each on its own resource: the route's normal answer, and the other
//   photographer's rows untouched.
// The list routes answer each photographer its own rows. The order routes
// that carry photo_keys (R2 keys) stay default-only until batch 3. Guest
// ordering is off for every project that is not the default photographer's,
// whatever GUEST_ORDERS says (doc §4), and the guest shop / 我有興趣 read the
// products of the link's project's photographer only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setup, guest, F1, SECRET, call, pick, rows, one } from './revision-helpers.mjs';
import { confirmed } from './guest-order-helpers.mjs';
import { twoTenants, snapshot, ROUTES_ON } from './tenant-helpers.mjs';

const SRC = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const OP = 'operator-secret';
const NOPE = '00000000-0000-4000-8000-000000000000';

// ─── fixtures ─────────────────────────────────────────────────────────────
async function platformProduct(env, name = '無框畫') {
  const res = await call(env, '/api/operator/products', {
    method: 'POST', token: OP,
    body: { kind: 'print', name, options: [{ label: '16×20', vendor_cost: 900, platform_price: 2000 }, { label: '20×24', vendor_cost: 1200, platform_price: 2600 }] },
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).product;
}
async function adopt(env, pp, token = SECRET, price = 3000) {
  return call(env, '/api/admin/products/from-platform', {
    method: 'POST', token,
    body: { platform_product_id: pp.id, options: [{ platform_option_id: pp.options[0].id, price }], guest_visible: true },
  });
}

// One photographer's set, made through the real routes by the default
// photographer (B cannot create a project yet: folders are R2 paths, default
// only until batch 3) and then handed to `owner`: a delivered project the
// client confirmed, an adopted print, a custom service, an admin order and a
// guest order on that project.
async function tenantSet(env, owner, pp, tag) {
  const p = await confirmed(env);
  const adopted = await adopt(env, pp);
  assert.equal(adopted.status, 201, await adopted.clone().text());
  const product = (await adopted.json()).product;
  const svc = await call(env, '/api/admin/products', {
    method: 'POST', token: SECRET, body: { kind: 'service', name: `${tag}拍攝`, options: [{ label: '', price: 1000 }] },
  });
  assert.equal(svc.status, 201, await svc.clone().text());
  const service = (await svc.json()).product;
  const ao = await call(env, `/api/admin/projects/${p.id}/orders`, {
    method: 'POST', token: SECRET, body: { lines: [{ option_id: product.options[0].id, qty: 1 }], note: `${tag}備註` },
  });
  assert.equal(ao.status, 201, await ao.clone().text());
  const adminOrder = (await ao.json()).order;
  const go = await guest(env, 'POST', 'orders', p.token, p.key, {
    request_id: crypto.randomUUID(), lines: [{ option_id: product.options[0].id, qty: 1, photo_key: F1 }],
    contact: { name: `${tag}客人`, phone: '0912-345-678' }, delivery: { method: 'pickup' }, note: '', expected_total: 3000, consent: 'v1',
  });
  assert.equal(go.status, 201, await go.clone().text());
  const guestOrder = (await go.json()).order;
  const db = env.DB._db;
  db.prepare('UPDATE projects SET title = ?, photographer_id = ? WHERE id = ?').run(`${tag} 婚紗`, owner.id, p.id);
  db.prepare('UPDATE products SET photographer_id = ? WHERE id IN (?, ?)').run(owner.id, product.id, service.id);
  db.prepare('UPDATE orders SET photographer_id = ? WHERE project_id = ?').run(owner.id, p.id);
  return { owner, project: p, adopted: product, service, adminOrder, guestOrder, tag };
}

async function world(extra = {}) {
  // built with custom products and guest orders on; `extra` (a switch to
  // test) applies once everything is in place
  const env = setup({ extra: { ...ROUTES_ON, CUSTOM_PRODUCTS: 'on', OPERATOR_TOKEN: OP, GUEST_ORDERS: 'on' } });
  const { A, B } = await twoTenants(env);
  const pp = await platformProduct(env);
  // B's set first: the default photographer adopts pp for it, hands it over,
  // then adopts pp again for itself
  const b = await tenantSet(env, B, pp, '乙林小姐');
  const a = await tenantSet(env, A, pp, '甲王先生');
  env.NOTIFY_EMAIL.sent.length = 0;
  Object.assign(env, extra);
  return { env, A, B, a, b, pp };
}

// every product / option / order / line / project row that is `id`'s
function ownedRows(env, id) {
  return JSON.stringify({
    products: rows(env, 'SELECT * FROM products WHERE photographer_id = ? ORDER BY rowid', id),
    options: rows(env, 'SELECT o.* FROM product_options o JOIN products p ON p.id = o.product_id WHERE p.photographer_id = ? ORDER BY o.rowid', id),
    orders: rows(env, 'SELECT * FROM orders WHERE photographer_id = ? ORDER BY rowid', id),
    items: rows(env, 'SELECT i.* FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.photographer_id = ? ORDER BY i.rowid', id),
    projects: rows(env, 'SELECT * FROM projects WHERE photographer_id = ? ORDER BY rowid', id),
  }, (k, v) => (v instanceof Uint8Array ? Array.from(v) : v));
}

// ─── the scoped routes that take an id ────────────────────────────────────
// path(set, w) and body(set, w): the request on that photographer set.
// ok: the owner's answer, {A, B} when it differs (photo_keys: default only).
const PR = id => `/api/admin/products/${id}`;
const OR = id => `/api/admin/orders/${id}`;
const PJ = id => `/api/admin/projects/${id}/orders`;
const TARGETED = [
  { name: 'PUT product (adopted: reprice, hide)', method: 'PUT', path: s => PR(s.adopted.id),
    body: (s, w) => ({ guest_visible: false, options: [{ platform_option_id: w.pp.options[0].id, price: 3500 }, { platform_option_id: w.pp.options[1].id, price: 4000 }] }), ok: 200 },
  { name: 'PUT product (custom: rename)', method: 'PUT', path: s => PR(s.service.id), body: () => ({ name: '改名' }), ok: 200 },
  { name: 'PUT product (custom: whole option set)', method: 'PUT', path: s => PR(s.service.id),
    body: s => ({ options: [{ id: s.service.options[0].id, label: '半天', price: 1500 }, { label: '全天', price: 2500 }] }), ok: 200 },
  { name: 'PUT product (custom, custom products off: 403)', method: 'PUT', path: s => PR(s.service.id), body: () => ({ name: 'x' }), ok: 403, extra: { CUSTOM_PRODUCTS: 'off' } },
  { name: 'retire (adopted)', method: 'POST', path: s => `${PR(s.adopted.id)}/retire`, ok: 200 },
  { name: 'restore (adopted)', method: 'POST', path: s => `${PR(s.adopted.id)}/restore`, ok: 200 },
  { name: 'restore (custom, custom products off: 403)', method: 'POST', path: s => `${PR(s.service.id)}/restore`, ok: 403, extra: { CUSTOM_PRODUCTS: 'off' } },
  { name: 'GET project orders', method: 'GET', path: s => PJ(s.project.id), ok: 200 },
  { name: 'POST project orders (photo_keys route: default only until batch 3)', method: 'POST', path: s => PJ(s.project.id),
    body: s => ({ lines: [{ option_id: s.adopted.options[0].id, qty: 2 }] }), ok: { A: 201, B: 404 } },
  { name: 'PUT order (note)', method: 'PUT', path: s => OR(s.adminOrder.id), body: () => ({ note: '新備註' }), ok: 200 },
  { name: 'PUT order (discount)', method: 'PUT', path: s => OR(s.adminOrder.id), body: () => ({ discount: 100 }), ok: 200 },
  { name: 'PUT order (lines: default only until batch 3)', method: 'PUT', path: s => OR(s.adminOrder.id),
    body: s => ({ lines: [{ id: s.adminOrder.items[0].id, qty: 3 }] }), ok: { A: 200, B: 404 } },
  { name: 'PUT order (photo_keys: default only until batch 3)', method: 'PUT', path: s => OR(s.adminOrder.id),
    body: () => ({ note: 'x', photo_keys: [] }), ok: { A: 200, B: 404 } },
  { name: 'erase-contact', method: 'POST', path: s => `${OR(s.guestOrder.id)}/erase-contact`, ok: 200 },
  { name: 'payment', method: 'POST', path: s => `${OR(s.adminOrder.id)}/payment`, body: () => ({ paid_amount: 1000, paid_method: 'cash' }), ok: 200 },
  { name: 'status (requested → confirmed)', method: 'POST', path: s => `${OR(s.guestOrder.id)}/status`, body: () => ({ status: 'confirmed' }), ok: 200 },
  { name: 'status (bad arrow: 409)', method: 'POST', path: s => `${OR(s.adminOrder.id)}/status`, body: () => ({ status: 'requested' }), ok: 409 },
  { name: 'status (confirmed → fulfilled)', method: 'POST', path: s => `${OR(s.adminOrder.id)}/status`, body: () => ({ status: 'fulfilled' }), ok: 200 },
];
const send = (w, route, set, token, nope = false) => {
  const path = route.path(set, w);
  return call(w.env, nope ? path.replace(/[0-9a-f-]{36}/, NOPE) : path, {
    method: route.method, token, body: route.body ? route.body(set, w) : undefined,
  });
};
const okFor = (route, who) => (typeof route.ok === 'object' ? route.ok[who] : route.ok);

for (const route of TARGETED) {
  for (const [who, victim] of [['B', 'a'], ['A', 'b']]) {
    test(`${route.name}: ${who} on the other photographer's resource is a nonexistent one — 404, same body, same statements, nothing written`, async () => {
      const w = await world(route.extra);
      const caller = w[who];
      const target = w[victim];
      const before = snapshot(w.env);
      const mark = w.env.DB._sql.length;
      const res = await send(w, route, target, caller.token);
      const text = await res.text();
      const statements = w.env.DB._sql.slice(mark);
      assert.equal(res.status, 404, `${res.status} ${text}`);
      assert.equal(snapshot(w.env), before, 'something was written');
      // the same request for an id nobody has
      const mark2 = w.env.DB._sql.length;
      const none = await send(w, route, target, caller.token, true);
      assert.equal(none.status, 404);
      assert.equal(text, await none.text(), 'the body tells someone else\'s resource from none');
      assert.deepEqual(statements, w.env.DB._sql.slice(mark2), 'the statements tell someone else\'s resource from none');
      assert.equal(snapshot(w.env), before);
      for (const leak of [target.project.id, target.adopted.id, target.service.id, target.adminOrder.id, target.guestOrder.id, target.tag]) {
        assert.ok(!text.includes(leak), `leaked ${leak}`);
      }
    });
  }

  test(`${route.name}: each photographer on its own resource gets the normal answer and leaves the other's rows alone`, async () => {
    const w = await world(route.extra);
    for (const [mine, other, who] of [[w.b, w.a, 'B'], [w.a, w.b, 'A']]) {
      const theirs = ownedRows(w.env, other.owner.id);
      const before = snapshot(w.env);
      const res = await send(w, route, mine, mine.owner.token);
      const text = await res.text();
      assert.equal(res.status, okFor(route, who), `${who}: ${res.status} ${text}`);
      assert.equal(ownedRows(w.env, other.owner.id), theirs, `${who} changed the other photographer's rows`);
      for (const leak of [other.project.id, other.adopted.id, other.service.id, other.adminOrder.id, other.tag]) {
        assert.ok(!text.includes(leak), `${who} saw the other's ${leak}`);
      }
      // a refusal (B on a photo_keys route) writes nothing at all
      if (res.status >= 400) assert.equal(snapshot(w.env), before, `${who}: a ${res.status} wrote something`);
    }
  });
}

// what the owner's own writes did, on its own rows
test('B on its own resources: the writes land on B\'s rows', async () => {
  const w = await world();
  const t = w.B.token;
  let res = await call(w.env, PR(w.b.adopted.id), { method: 'PUT', token: t, body: { guest_visible: false, options: [{ platform_option_id: w.pp.options[0].id, price: 3500 }] } });
  assert.equal(res.status, 200);
  const p = (await res.json()).product;
  assert.equal(p.guest_visible, 0);
  assert.equal(p.options.find(o => o.active).price, 3500);
  res = await call(w.env, PR(w.b.service.id), { method: 'PUT', token: t, body: { options: [{ label: '全天', price: 2500 }] } });
  assert.equal(res.status, 200);
  assert.deepEqual(rows(w.env, 'SELECT label, price, active FROM product_options WHERE product_id = ? ORDER BY rowid', w.b.service.id).map(r => ({ ...r })),
    [{ label: '', price: 1000, active: 0 }, { label: '全天', price: 2500, active: 1 }]);
  assert.equal((await call(w.env, `${PR(w.b.adopted.id)}/retire`, { method: 'POST', token: t })).status, 200);
  assert.equal(one(w.env, 'SELECT active FROM products WHERE id = ?', w.b.adopted.id).active, 0);
  assert.equal(one(w.env, 'SELECT active FROM products WHERE id = ?', w.a.adopted.id).active, 1);
  assert.equal((await call(w.env, `${OR(w.b.adminOrder.id)}/payment`, { method: 'POST', token: t, body: { paid_amount: 1000, paid_method: 'cash' } })).status, 200);
  assert.equal(one(w.env, 'SELECT paid_amount FROM orders WHERE id = ?', w.b.adminOrder.id).paid_amount, 1000);
  assert.equal(one(w.env, 'SELECT paid_amount FROM orders WHERE id = ?', w.a.adminOrder.id).paid_amount, 0);
  assert.equal((await call(w.env, `${OR(w.b.guestOrder.id)}/erase-contact`, { method: 'POST', token: t })).status, 200);
  assert.equal(one(w.env, 'SELECT contact_phone FROM orders WHERE id = ?', w.b.guestOrder.id).contact_phone, null);
  assert.ok(one(w.env, 'SELECT contact_phone FROM orders WHERE id = ?', w.a.guestOrder.id).contact_phone);
  assert.equal((await call(w.env, `${OR(w.b.guestOrder.id)}/status`, { method: 'POST', token: t, body: { status: 'confirmed' } })).status, 200);
  assert.equal(one(w.env, 'SELECT status FROM orders WHERE id = ?', w.b.guestOrder.id).status, 'confirmed');
  assert.equal(one(w.env, 'SELECT status FROM orders WHERE id = ?', w.a.guestOrder.id).status, 'requested');
  res = await call(w.env, OR(w.b.adminOrder.id), { method: 'PUT', token: t, body: { note: '乙的新備註', discount: 200 } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).order.note, '乙的新備註');
  const got = await (await call(w.env, PJ(w.b.project.id), { token: t })).json();
  assert.deepEqual(got.orders.map(o => o.id).sort(), [w.b.adminOrder.id, w.b.guestOrder.id].sort());
  // with their lines and money (the lines are read under the same owner)
  for (const o of got.orders) {
    assert.equal(o.items.length, 1, o.id);
    assert.equal(o.items[0].option_id, w.b.adopted.options[0].id);
  }
  assert.equal(got.orders.find(o => o.id === w.b.adminOrder.id).subtotal, 3000);
});

// ─── the lists ────────────────────────────────────────────────────────────
test('GET /api/admin/products: each photographer lists its own products only', async () => {
  const w = await world();
  for (const [s, other] of [[w.a, w.b], [w.b, w.a]]) {
    const res = await call(w.env, '/api/admin/products', { token: s.owner.token });
    assert.equal(res.status, 200);
    const got = await res.json();
    assert.deepEqual(got.products.map(p => p.id).sort(), [s.adopted.id, s.service.id].sort(), s.owner.id);
    const text = JSON.stringify(got);
    for (const leak of [other.adopted.id, other.service.id, other.tag, ...other.adopted.options.map(o => o.id)]) assert.ok(!text.includes(leak), leak);
  }
});

test('GET /api/admin/platform-products: one shared catalogue, adopted_product_id is the caller\'s own adoption', async () => {
  const w = await world();
  const seen = [];
  for (const [s, other] of [[w.a, w.b], [w.b, w.a]]) {
    const res = await call(w.env, '/api/admin/platform-products', { token: s.owner.token });
    assert.equal(res.status, 200);
    const got = await res.json();
    seen.push(got.products.map(p => ({ id: p.id, name: p.name, options: p.options })));
    const pp = got.products.find(p => p.id === w.pp.id);
    assert.equal(pp.adopted_product_id, s.adopted.id, s.owner.id);
    assert.ok(!JSON.stringify(got).includes(other.adopted.id));
    assert.ok(!JSON.stringify(got).includes('vendor_cost'));
  }
  assert.deepEqual(seen[0], seen[1], 'the catalogue itself is the same for both');
  // a photographer with no adoption sees it unadopted
  w.env.DB._db.prepare('DELETE FROM product_options WHERE product_id = ?').run(w.b.adopted.id);
  w.env.DB._db.prepare('DELETE FROM order_items WHERE product_id = ?').run(w.b.adopted.id);
  w.env.DB._db.prepare('DELETE FROM products WHERE id = ?').run(w.b.adopted.id);
  const got = await (await call(w.env, '/api/admin/platform-products', { token: w.B.token })).json();
  assert.equal(got.products.find(p => p.id === w.pp.id).adopted_product_id, null);
});

test('GET /api/admin/orders: each photographer lists its own orders only (filters too)', async () => {
  const w = await world();
  for (const [s, other] of [[w.a, w.b], [w.b, w.a]]) {
    for (const [q, want] of [['', [s.adminOrder.id, s.guestOrder.id]], ['?status=requested', [s.guestOrder.id]], ['?status=confirmed', [s.adminOrder.id]], ['?unpaid=1', [s.adminOrder.id]]]) {
      const res = await call(w.env, `/api/admin/orders${q}`, { token: s.owner.token });
      assert.equal(res.status, 200);
      const got = await res.json();
      assert.deepEqual(got.orders.map(o => o.id).sort(), want.sort(), `${s.owner.id} ${q}`);
      const text = JSON.stringify(got);
      for (const leak of [other.adminOrder.id, other.guestOrder.id, other.tag, other.project.id]) assert.ok(!text.includes(leak), leak);
    }
  }
});

test('an order whose project is another photographer\'s reads as not found (ORDER_SCOPE_SQL), list and id alike', async () => {
  const w = await world();
  // data that should never exist: B's order row on A's project
  w.env.DB._db.prepare('UPDATE orders SET project_id = ? WHERE id = ?').run(w.a.project.id, w.b.adminOrder.id);
  const list = await (await call(w.env, '/api/admin/orders', { token: w.B.token })).json();
  assert.deepEqual(list.orders.map(o => o.id), [w.b.guestOrder.id]);
  const before = snapshot(w.env);
  for (const token of [w.A.token, w.B.token]) {
    assert.equal((await call(w.env, `${OR(w.b.adminOrder.id)}/status`, { method: 'POST', token, body: { status: 'fulfilled' } })).status, 404);
  }
  assert.equal(snapshot(w.env), before);
});

test('POST /api/admin/products: B\'s new product is B\'s, and A\'s list does not change', async () => {
  const w = await world();
  const aList = await (await call(w.env, '/api/admin/products', { token: w.A.token })).text();
  const res = await call(w.env, '/api/admin/products', { method: 'POST', token: w.B.token, body: { kind: 'service', name: '乙新服務', options: [{ label: '', price: 800 }] } });
  assert.equal(res.status, 201, await res.clone().text());
  const p = (await res.json()).product;
  assert.equal(one(w.env, 'SELECT photographer_id FROM products WHERE id = ?', p.id).photographer_id, w.B.id);
  assert.equal(await (await call(w.env, '/api/admin/products', { token: w.A.token })).text(), aList);
  assert.ok((await (await call(w.env, '/api/admin/products', { token: w.B.token })).text()).includes(p.id));
});

test('POST /api/admin/products (custom products off): B gets the same 403 as A and nothing is written', async () => {
  const w = await world({ CUSTOM_PRODUCTS: 'off' });
  const before = snapshot(w.env);
  for (const s of [w.a, w.b]) {
    const res = await call(w.env, '/api/admin/products', { method: 'POST', token: s.owner.token, body: { kind: 'service', name: 'x', options: [{ label: '', price: 1 }] } });
    assert.equal(res.status, 403);
  }
  assert.equal(snapshot(w.env), before);
});

test('POST from-platform: each photographer adopts into its own products; "already adopted" is per photographer and names only its own', async () => {
  const w = await world();
  const pp2 = await platformProduct(w.env, '桌曆');
  const theirs = ownedRows(w.env, w.A.id);
  const res = await adopt(w.env, pp2, w.B.token, 2500);
  assert.equal(res.status, 201, await res.clone().text());
  const bp = (await res.json()).product;
  assert.equal(one(w.env, 'SELECT photographer_id FROM products WHERE id = ?', bp.id).photographer_id, w.B.id);
  assert.deepEqual(rows(w.env, 'SELECT product_id FROM product_options WHERE product_id = ?', bp.id).length, 1, 'its option landed with it');
  assert.equal(ownedRows(w.env, w.A.id), theirs, 'A untouched');
  // A adopts the same platform product: its own, not a 409 on B's
  const ra = await adopt(w.env, pp2, w.A.token, 2700);
  assert.equal(ra.status, 201, await ra.clone().text());
  const ap = (await ra.json()).product;
  assert.notEqual(ap.id, bp.id);
  assert.equal(one(w.env, 'SELECT photographer_id FROM products WHERE id = ?', ap.id).photographer_id, 'default');
  // again: 409, each naming its own product only
  for (const [token, mine, other] of [[w.B.token, bp.id, ap.id], [w.A.token, ap.id, bp.id]]) {
    const again = await adopt(w.env, pp2, token);
    assert.equal(again.status, 409);
    const body = await again.json();
    assert.equal(body.product_id, mine);
    assert.ok(!JSON.stringify(body).includes(other));
  }
});

test('POST from-platform: the default photographer having adopted a platform product first does not block another photographer\'s adoption', async () => {
  const w = await world();
  const pp3 = await platformProduct(w.env, '木框');
  const ra = await adopt(w.env, pp3, w.A.token);
  assert.equal(ra.status, 201);
  const rb = await adopt(w.env, pp3, w.B.token);
  assert.equal(rb.status, 201, await rb.clone().text());
  const bp = (await rb.json()).product;
  assert.equal(one(w.env, 'SELECT photographer_id FROM products WHERE id = ?', bp.id).photographer_id, w.B.id);
  assert.equal(rows(w.env, 'SELECT * FROM product_options WHERE product_id = ?', bp.id).length, 1);
});

// ─── order lines read the caller's catalogue only ─────────────────────────
test('POST project orders: the default photographer cannot order another photographer\'s option (400 unknown_option, nothing written)', async () => {
  const w = await world();
  const before = snapshot(w.env);
  for (const optionId of [w.b.adopted.options[0].id, w.b.service.options[0].id]) {
    const res = await call(w.env, PJ(w.a.project.id), { method: 'POST', token: SECRET, body: { lines: [{ option_id: optionId, qty: 1 }] } });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'unknown_option');
  }
  assert.equal(snapshot(w.env), before);
  // its own option: the positive control
  assert.equal((await call(w.env, PJ(w.a.project.id), { method: 'POST', token: SECRET, body: { lines: [{ option_id: w.a.service.options[0].id, qty: 1 }] } })).status, 201);
});

test('PUT order lines: the default photographer cannot add another photographer\'s option to its own order', async () => {
  const w = await world();
  const before = snapshot(w.env);
  const res = await call(w.env, OR(w.a.adminOrder.id), {
    method: 'PUT', token: SECRET, body: { lines: [{ id: w.a.adminOrder.items[0].id }, { option_id: w.b.service.options[0].id, qty: 1 }] },
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'unknown_option');
  assert.equal(snapshot(w.env), before);
});

// ─── the writes re-check the owner inside the statement ───────────────────
function beforeStatement(env, re, fn) {
  const prepare = env.DB.prepare.bind(env.DB);
  let done = false;
  env.DB.prepare = sql => {
    if (!done && re.test(sql)) { done = true; fn(); }
    return prepare(sql);
  };
}

test('PUT product options: a product handed to someone else between the read and the batch keeps its options', async () => {
  const w = await world();
  const opts = () => JSON.stringify(rows(w.env, 'SELECT * FROM product_options WHERE product_id = ? ORDER BY rowid', w.b.service.id));
  const had = opts();
  beforeStatement(w.env, /^UPDATE products SET/, () => w.env.DB._db.prepare('UPDATE products SET photographer_id = ? WHERE id = ?').run(w.A.id, w.b.service.id));
  await call(w.env, PR(w.b.service.id), { method: 'PUT', token: w.B.token, body: { options: [{ id: w.b.service.options[0].id, label: '改', price: 9 }, { label: '新', price: 5 }] } });
  assert.equal(opts(), had, 'the option writes landed on a product that is no longer B\'s');
});

test('PUT adopted product options: the same, for an adopted product', async () => {
  const w = await world();
  const opts = () => JSON.stringify(rows(w.env, 'SELECT * FROM product_options WHERE product_id = ? ORDER BY rowid', w.b.adopted.id));
  const had = opts();
  beforeStatement(w.env, /^UPDATE products SET/, () => w.env.DB._db.prepare('UPDATE products SET photographer_id = ? WHERE id = ?').run(w.A.id, w.b.adopted.id));
  await call(w.env, PR(w.b.adopted.id), { method: 'PUT', token: w.B.token, body: { options: [{ platform_option_id: w.pp.options[1].id, price: 9000 }] } });
  assert.equal(opts(), had);
});

test('adopt: the options land only on a product that is the caller\'s (in-statement owner gate)', async () => {
  const w = await world();
  const pp2 = await platformProduct(w.env, '桌曆');
  // the new product turns out someone else's the moment it lands
  w.env.DB._db.exec("CREATE TRIGGER steal AFTER INSERT ON products BEGIN UPDATE products SET photographer_id = 'someone-else' WHERE id = NEW.id; END");
  await adopt(w.env, pp2, w.B.token);
  const [p] = rows(w.env, "SELECT id FROM products WHERE photographer_id = 'someone-else'");
  assert.ok(p, 'the product landed (then changed hands)');
  assert.equal(rows(w.env, 'SELECT * FROM product_options WHERE product_id = ?', p.id).length, 0, 'an option landed on someone else\'s product');
});

test('POST project orders: the lines land only under an order that is the caller\'s (in-statement owner gate)', async () => {
  const w = await world();
  w.env.DB._db.exec("CREATE TRIGGER steal AFTER INSERT ON orders BEGIN UPDATE orders SET photographer_id = 'someone-else' WHERE id = NEW.id; END");
  const items = rows(w.env, 'SELECT COUNT(*) AS n FROM order_items')[0].n;
  await call(w.env, PJ(w.a.project.id), { method: 'POST', token: SECRET, body: { lines: [{ option_id: w.a.service.options[0].id, qty: 1 }] } });
  assert.equal(rows(w.env, 'SELECT COUNT(*) AS n FROM order_items')[0].n, items, 'a line landed under someone else\'s order');
});

test('PUT order lines: an order handed to someone else between the read and the batch keeps its lines (409)', async () => {
  const w = await world();
  const lines = () => JSON.stringify(rows(w.env, 'SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid', w.a.adminOrder.id));
  const had = lines();
  beforeStatement(w.env, /^DELETE FROM order_items/, () => w.env.DB._db.prepare('UPDATE orders SET photographer_id = ? WHERE id = ?').run(w.B.id, w.a.adminOrder.id));
  const res = await call(w.env, OR(w.a.adminOrder.id), {
    method: 'PUT', token: SECRET, body: { lines: [{ id: w.a.adminOrder.items[0].id, qty: 4 }, { option_id: w.a.service.options[0].id, qty: 1 }] },
  });
  assert.equal(res.status, 409);
  assert.equal(lines(), had, 'the line writes landed on an order that is no longer the caller\'s');
});

// ─── guest ordering: off for every project that is not the default's ──────
const GUEST_ORDER = (s, over = {}) => ({
  request_id: crypto.randomUUID(), lines: [{ option_id: s.adopted.options[0].id, qty: 1, photo_key: F1 }],
  contact: { name: '客人', phone: '0912-000-111' }, delivery: { method: 'pickup' }, note: '', expected_total: 3000, consent: 'v1', ...over,
});
async function switchWorld(mode, pilotOf) {
  const w = await world({ GUEST_ORDERS: mode });
  if (pilotOf) w.env.GUEST_ORDERS_PILOT = pilotOf(w).join(',');
  return w;
}
for (const [label, mode, pilotOf] of [
  ['on', 'on'],
  ['pilot, both projects listed', 'pilot', w => [w.a.project.id, w.b.project.id]],
  ['off', 'off'],
  ['unset', undefined],
]) {
  test(`GUEST_ORDERS ${label}: another photographer's project never takes a guest order (403 ordering_disabled, ordering: null, nothing written)`, async () => {
    const w = await switchWorld(mode, pilotOf);
    const p = w.b.project;
    const shop = await pick(w.env, 'GET', 'shop', p.token);
    assert.equal(shop.status, 200);
    const shopBody = await shop.json();
    assert.equal(shopBody.ordering, null);
    assert.deepEqual(shopBody.products.map(x => x.id), [w.b.adopted.id], 'the shop itself still shows B\'s products');
    const before = snapshot(w.env);
    const res = await guest(w.env, 'POST', 'orders', p.token, p.key, GUEST_ORDER(w.b));
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'ordering_disabled');
    assert.equal(snapshot(w.env), before);
    assert.equal(w.env.NOTIFY_EMAIL.sent.length, 0);
    // the state never carries the flag
    const st = await pick(w.env, 'GET', 'state', p.token, { key: p.key });
    assert.equal(st.status, 200);
    assert.ok(!('ordering' in await st.json()));
    // the guest still sees, and can cancel, its own order (never depended on the switch)
    const mine = await pick(w.env, 'GET', 'orders', p.token, { key: p.key });
    assert.equal(mine.status, 200);
    assert.deepEqual((await mine.json()).orders.map(o => o.id), [w.b.guestOrder.id]);
    const cancel = await guest(w.env, 'POST', `orders/${w.b.guestOrder.id}/cancel`, p.token, p.key);
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).order.status, 'cancelled');

    // the default photographer's project: open exactly when the switch says so (the positive control)
    const q = w.a.project;
    const open = mode === 'on' || mode === 'pilot';
    const aShop = await (await pick(w.env, 'GET', 'shop', q.token)).json();
    assert.equal(aShop.ordering !== null, open);
    const placed = await guest(w.env, 'POST', 'orders', q.token, q.key, GUEST_ORDER(w.a));
    assert.equal(placed.status, open ? 201 : 403, await placed.clone().text());
  });
}

test('GUEST_ORDERS pilot listing only the other photographer\'s project: still off for it, and off for the default\'s unlisted one', async () => {
  const w = await switchWorld('pilot', w => [w.b.project.id]);
  for (const s of [w.a, w.b]) {
    const res = await guest(w.env, 'POST', 'orders', s.project.token, s.project.key, GUEST_ORDER(s));
    assert.equal(res.status, 403);
    assert.equal((await (await pick(w.env, 'GET', 'shop', s.project.token)).json()).ordering, null);
  }
});

test('guestOrdersEnabled takes the project and asks the owner before the switch', () => {
  const fn = SRC.slice(SRC.indexOf('function guestOrdersEnabled('), SRC.indexOf('\n}\n', SRC.indexOf('function guestOrdersEnabled(')));
  assert.match(fn, /^function guestOrdersEnabled\(env, project\)/);
  const calls = SRC.match(/guestOrdersEnabled\(([^)]*)\)/g).slice(1);
  assert.equal(calls.length, 2, 'the shop and the order POST');
  for (const c of calls) assert.equal(c, 'guestOrdersEnabled(env, project)');
});

// ─── 我有興趣 and the shop: the link's project's photographer's products ───
test('guest shop and 我有興趣: each project offers its own photographer\'s products only; another\'s product id is 404', async () => {
  const w = await world();
  for (const [s, other] of [[w.a, w.b], [w.b, w.a]]) {
    const p = s.project;
    const shop = await (await pick(w.env, 'GET', 'shop', p.token)).json();
    assert.deepEqual(shop.products.map(x => x.id), [s.adopted.id]);
    assert.ok(!JSON.stringify(shop).includes(other.adopted.id));
    const before = snapshot(w.env);
    const theirs = await guest(w.env, 'POST', 'interest', p.token, p.key, { product_id: other.adopted.id });
    assert.equal(theirs.status, 404);
    assert.equal((await theirs.json()).code, 'not_found');
    assert.equal(snapshot(w.env), before);
    const ok = await guest(w.env, 'POST', 'interest', p.token, p.key, { product_id: s.adopted.id });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal(one(w.env, 'SELECT product_id FROM product_interests WHERE project_id = ?', p.id).product_id, s.adopted.id);
  }
});

// ─── the source ───────────────────────────────────────────────────────────
test('source: no `default-only until 2b-2` mark is left; the block asks requirePhotographer, the photo_keys gates stay', () => {
  assert.equal((SRC.match(/default-only until 2b-2\b/g) || []).length, 0);
  assert.equal((SRC.match(/requirePhotographer\(request, env\); \/\/ scoped to the caller \(who\.id\): products and orders/g) || []).length, 1);
  assert.equal((SRC.match(/defaultOnly\(auth\.who\); \/\/ default-only until batch 3 \(photo_keys\)/g) || []).length, 2);
});

test('source: the products / orders helpers take the owner from their caller, with no default', () => {
  assert.match(SRC, /async function orderLines\(env, project, input, existing, \{ guest = false, photographerId \} = \{\}\)/);
  assert.match(SRC, /async function readProducts\(env, photographerId, id = null\)/);
  assert.match(SRC, /async function readOrders\(env, photographerId, where, binds, limit = 500\)/);
  assert.match(SRC, /async function readOrder\(env, photographerId, id\)/);
  assert.match(SRC, /function catalogueWrites\(env, t, ownerId, id, set, opts, now\)/);
  for (const name of ['readProducts', 'readOrders', 'readOrder', 'orderLines', 'catalogueWrites']) {
    const fn = SRC.slice(SRC.indexOf(`function ${name}(`), SRC.indexOf('\n}\n', SRC.indexOf(`function ${name}(`)));
    assert.ok(!/DEFAULT_PHOTOGRAPHER_ID/.test(fn.split('\n').map(l => l.split('//')[0]).join('\n')), name);
  }
  // every admin call passes who.id
  const block = SRC.slice(SRC.indexOf('    // ─── Products and orders (docs/products-orders.md)'), SRC.indexOf('    // GET /api/admin/stats'));
  assert.ok(block.length > 10000 && block.includes("pathParts[2] === 'products'"), 'the route block');
  for (const m of block.matchAll(/\b(readProducts|readOrders|readOrder)\(env, ([^,)]+)/g)) assert.equal(m[2], 'who.id', m[0]);
  const lineCalls = [...block.matchAll(/\borderLines\(.*$/gm)];
  assert.equal(lineCalls.length, 2, 'POST project orders and PUT order');
  for (const m of lineCalls) assert.match(m[0], /\{ photographerId: who\.id \}\);$/, m[0]);
  assert.ok(!/DEFAULT_PHOTOGRAPHER_ID/.test(block.split('\n').map(l => l.split('//')[0]).join('\n')), 'no constant left in the block');
});
