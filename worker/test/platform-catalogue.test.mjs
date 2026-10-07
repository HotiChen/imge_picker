// The platform catalogue (docs/products-orders.md, "Platform catalogue (A2)").
// The operator lists printable products with a vendor cost and a platform
// price; a photographer adopts one, picks some of its options and sets a
// price at or above the platform price. Album and print products can only be
// adopted; the photographer's own products are services. vendor_cost is the
// operator's alone and never leaves /api/operator/*.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { fakeDB, req, ctx } from './fakes.mjs';
import { SECRET, MINE, CUSTOM_ON, setup, call, createProject, claimed, one, rows, seedToken, days } from './pick-helpers.mjs';

const OP = 'operator-secret';
const A = `${MINE}a.jpg`;

const envOp = (extra = {}) => setup({ OPERATOR_TOKEN: OP, ...extra });
const op = (env, method, path, body, token = OP) => call(env, path, { method, token, body });
const admin = (env, method, path, body, token = SECRET) => call(env, path, { method, token, body });
const json = async res => res.json();

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const WEBP = new Uint8Array([...'RIFF'].map(c => c.charCodeAt(0)).concat([0x10, 0, 0, 0], [...'WEBPVP8 '].map(c => c.charCodeAt(0))));
const text = s => new TextEncoder().encode(s);
const putImage = (env, id, bytes, { token = OP, headers = {} } = {}) =>
  worker.fetch(req(`/api/operator/products/${id}/image`, { method: 'PUT', token, body: bytes, headers }), env, ctx);
const getImage = (env, id, headers = {}) => call(env, `/api/platform/products/${id}/image`, { headers });

// A vendor cost nothing else in these tests ever equals, so a JSON-string
// search for it finds a leak wherever it happens.
const VENDOR = 987_651;

async function platformProduct(env, body = {}) {
  const res = await op(env, 'POST', '/api/operator/products', {
    kind: 'print', name: '無框畫', description: '木框', options: [
      { label: '16×20', vendor_cost: VENDOR, platform_price: 1000 },
      { label: '24×36', vendor_cost: VENDOR + 1, platform_price: 2000 },
    ], ...body,
  });
  if (res.status !== 201) throw new Error(`platformProduct: ${res.status} ${await res.text()}`);
  return (await res.json()).product;
}

async function adopt(env, pp, options, extra = {}) {
  const res = await admin(env, 'POST', '/api/admin/products/from-platform', {
    platform_product_id: pp.id,
    options: options ?? pp.options.map(o => ({ platform_option_id: o.id, price: o.platform_price * 3 })),
    ...extra,
  });
  if (res.status !== 201) throw new Error(`adopt: ${res.status} ${await res.text()}`);
  return (await res.json()).product;
}

async function newOrder(env, projectId, body) {
  const res = await admin(env, 'POST', `/api/admin/projects/${projectId}/orders`, body);
  if (res.status !== 201) throw new Error(`newOrder: ${res.status} ${await res.text()}`);
  return (await res.json()).order;
}

// every table the catalogue and orders live in, for "nothing was written"
const snapshot = env => JSON.stringify(['platform_products', 'platform_product_options', 'products', 'product_options', 'orders', 'order_items']
  .map(t => rows(env, `SELECT * FROM ${t} ORDER BY rowid`)));
const bad = async (res, status, code, label) => {
  assert.equal(res.status, status, label);
  assert.equal((await res.json()).code, code, label);
};

// ─── operator auth ───────────────────────────────────────────────────────────

const OPERATOR_ROUTES = id => [
  ['GET', '/api/operator/products'],
  ['POST', '/api/operator/products', { kind: 'print', name: 'x', options: [{ label: '', vendor_cost: 1, platform_price: 1 }] }],
  ['PUT', `/api/operator/products/${id}`, { name: 'hacked' }],
  ['POST', `/api/operator/products/${id}/retire`],
  ['POST', `/api/operator/products/${id}/restore`],
  ['PUT', `/api/operator/products/${id}/image`, 'x'],
  ['DELETE', `/api/operator/products/${id}/image`],
  ['GET', '/api/operator/stats'],
];

test('operator routes fail closed when OPERATOR_TOKEN is unset or empty', async () => {
  for (const unset of [undefined, '']) {
    const env = setup({ OPERATOR_TOKEN: unset });
    for (const [method, path, body] of OPERATOR_ROUTES('x')) {
      for (const token of [undefined, '', 'undefined', SECRET]) {
        assert.equal((await call(env, path, { method, body, token })).status, 401, `${method} ${path} ${token}`);
      }
    }
    assert.equal(rows(env, 'SELECT * FROM platform_products').length, 0);
  }
});

test('an OPERATOR_TOKEN equal to PHOTOGRAPHER_TOKEN is refused on operator routes; the admin keeps working', async () => {
  const env = setup({ OPERATOR_TOKEN: SECRET });
  for (const [method, path, body] of OPERATOR_ROUTES('x')) {
    assert.equal((await call(env, path, { method, body, token: SECRET })).status, 401, `${method} ${path}`);
  }
  assert.equal(rows(env, 'SELECT * FROM platform_products').length, 0);
  // the positive case: the same token is still the photographer's
  assert.equal((await admin(env, 'GET', '/api/admin/products')).status, 200);
});

test('the operator token opens operator routes, and nothing else does', async () => {
  const env = envOp();
  const pp = await platformProduct(env);
  const res = await op(env, 'GET', '/api/operator/products');
  assert.equal(res.status, 200, 'positive: the operator token works');
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const p = await claimed(env);
  for (const [token, kind] of [['CLIENT', 'client'], ['STUDIO', 'studio'], ['SESSION', 'session']]) {
    await seedToken(env, { token, kind, project_id: p.project.id, book_id: kind === 'client' ? 'b1' : '' });
  }
  const before = snapshot(env);
  for (const [method, path, body] of OPERATOR_ROUTES(pp.id)) {
    for (const token of [SECRET, 'CLIENT', 'STUDIO', 'SESSION', p.token, p.key, `${OP}x`, OP.slice(0, -1), OP.toUpperCase(), ` ${OP}x`]) {
      for (const r of await Promise.all([
        call(env, path, { method, body, token }),
        call(env, `${path}?t=${token}`, { method, body }),
        call(env, path, { method, body, headers: { 'X-Share-Token': token } }),
      ])) assert.equal(r.status, 401, `${method} ${path} ${token}`);
    }
    // the operator token only counts as a bearer header, never as a link token
    for (const r of await Promise.all([
      call(env, `${path}?t=${OP}`, { method, body }),
      call(env, path, { method, body, headers: { 'X-Share-Token': OP } }),
    ])) assert.equal(r.status, 401, `${method} ${path} operator token outside the header`);
  }
  assert.equal(snapshot(env), before);
  assert.equal([...env.imagepicker._store.keys()].filter(k => k.startsWith('api/')).length, 0, 'nothing fell through to the upload route');
});

test('the operator token is 401 on every admin route, the upload and the photos', async () => {
  const env = envOp();
  const pp = await platformProduct(env);
  const { project } = await createProject(env);
  const mine = await adopt(env, pp);
  const order = await newOrder(env, project.id, { lines: [{ option_id: mine.options[0].id, qty: 1 }] });
  const before = snapshot(env);
  for (const [method, path, body] of [
    ['GET', '/api/auth/verify-admin'],
    ['GET', '/api/admin/products'],
    ['POST', '/api/admin/products', { kind: 'service', name: 'x', options: [{ price: 1 }] }],
    ['POST', '/api/admin/products/from-platform', { platform_product_id: pp.id, options: [] }],
    ['GET', '/api/admin/platform-products'],
    ['PUT', `/api/admin/products/${mine.id}`, { sort: 3 }],
    ['POST', `/api/admin/products/${mine.id}/retire`],
    ['GET', `/api/admin/projects/${project.id}/orders`],
    ['POST', `/api/admin/projects/${project.id}/orders`, { lines: [{ option_id: mine.options[0].id, qty: 1 }] }],
    ['GET', '/api/admin/orders'],
    ['PUT', `/api/admin/orders/${order.id}`, { note: 'x' }],
    ['POST', `/api/admin/orders/${order.id}/payment`, { paid_amount: 0 }],
    ['GET', '/api/admin/stats'],
    ['GET', '/api/admin/settings'],
    ['PUT', '/api/admin/settings/logo', 'x'],
    ['GET', '/api/admin/projects'],
    ['POST', '/api/auth/studio-token'],
    ['PUT', '/20260819/new.jpg', 'x'],
    ['GET', `/${A}`],
    ['GET', `/?list=${MINE}`],
  ]) assert.equal((await call(env, path, { method, body, token: OP })).status, 401, `${method} ${path}`);
  assert.equal(snapshot(env), before);
  assert.ok(!env.imagepicker._store.has('20260819/new.jpg'));
});

test('unknown /api/operator/* paths are 404 and wrong methods 405, never another route; nothing written', async () => {
  const env = envOp();
  const pp = await platformProduct(env);
  const before = snapshot(env);
  for (const [method, path] of [
    ['GET', '/api/operator'],
    ['PUT', '/api/operator'],
    ['GET', '/api/operator/nope'],
    ['PUT', '/api/operator/nope'],
    ['PUT', `/api/operator/products/${pp.id}/nope`],
    ['PUT', `/api/operator/products/${pp.id}/image/x`],
    ['GET', '/api/operator/stats/x'],
    ['PUT', '/api/operator/stats/x'],
    ['GET', '/api/operator/orders'],
  ]) assert.equal((await op(env, method, path, method === 'GET' ? undefined : '{}')).status, 404, `${method} ${path}`);
  for (const [path, methods] of [
    ['/api/operator/products', ['PUT', 'DELETE', 'PATCH']],
    [`/api/operator/products/${pp.id}`, ['GET', 'POST', 'DELETE']],
    [`/api/operator/products/${pp.id}/retire`, ['GET', 'PUT']],
    [`/api/operator/products/${pp.id}/image`, ['GET', 'POST']],
    ['/api/operator/stats', ['POST', 'PUT', 'DELETE']],
  ]) {
    for (const method of methods) {
      assert.equal((await op(env, method, path, method === 'GET' ? undefined : '{}')).status, 405, `${method} ${path}`);
    }
  }
  // unknown paths are behind the gate too
  assert.equal((await op(env, 'PUT', '/api/operator/nope', '{}', SECRET)).status, 401);
  assert.equal(snapshot(env), before);
  assert.equal([...env.imagepicker._store.keys()].filter(k => k.startsWith('api/')).length, 0, 'nothing fell through to the upload route');
});

// ─── operator catalogue ──────────────────────────────────────────────────────

test('operator: create a platform product with vendor cost and platform price; list it back', async () => {
  const env = envOp();
  const res = await op(env, 'POST', '/api/operator/products', {
    kind: 'album', name: '  相本書  ', description: '精裝', photo_count: 20, sort: 2,
    options: [{ label: '20×20', vendor_cost: 3000, platform_price: 3000 }, { label: '30×30', vendor_cost: 4000, platform_price: 4500 }],
    id: 'mine', active: 0, photographer_id: 'x', guest_visible: 1,
  });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const { product } = await res.json();
  assert.notEqual(product.id, 'mine');
  assert.deepEqual([product.kind, product.name, product.description, product.photo_count, product.active, product.sort, product.has_image],
    ['album', '相本書', '精裝', 20, 1, 2, false]);
  assert.ok(!('image' in product));
  assert.ok(!('guest_visible' in product));
  assert.deepEqual(product.options.map(o => [o.label, o.vendor_cost, o.platform_price, o.active, o.sort]),
    [['20×20', 3000, 3000, 1, 0], ['30×30', 4000, 4500, 1, 1]]);
  const list = await json(await op(env, 'GET', '/api/operator/products'));
  assert.deepEqual(list.products, [product]);
  // photo_count sticks to albums only
  const print = await platformProduct(env, { photo_count: 5 });
  assert.equal(print.photo_count, null);
});

test('operator: validation is 400 with a code, and nothing is written', async () => {
  const env = envOp();
  const existing = await platformProduct(env);
  const good = { kind: 'print', name: 'x', options: [{ label: '', vendor_cost: 1, platform_price: 1 }] };
  const opt = o => ({ ...good, options: [{ label: '', vendor_cost: 1, platform_price: 1, ...o }] });
  const cases = [
    [{ ...good, kind: 'service' }, 'invalid_kind'],
    [{ ...good, kind: 'extra_pick' }, 'invalid_kind'],
    [{ ...good, kind: undefined }, 'invalid_kind'],
    [{ ...good, name: '' }, 'invalid_name'],
    [{ ...good, name: 'x'.repeat(61) }, 'invalid_name'],
    [{ ...good, name: 'a\nb' }, 'invalid_name'],
    [{ ...good, description: 'x'.repeat(501) }, 'invalid_description'],
    [{ ...good, photo_count: 0 }, 'invalid_photo_count'],
    [{ ...good, sort: -1 }, 'invalid_sort'],
    [{ ...good, options: [] }, 'invalid_options'],
    [{ ...good, options: Array.from({ length: 21 }, () => ({ vendor_cost: 1, platform_price: 1 })) }, 'invalid_options'],
    [{ ...good, options: [{ id: existing.options[0].id, label: '', vendor_cost: 1, platform_price: 1 }] }, 'invalid_options'],
    [opt({ label: 'x'.repeat(61) }), 'invalid_label'],
    [opt({ vendor_cost: -1 }), 'invalid_vendor_cost'],
    [opt({ vendor_cost: undefined }), 'invalid_vendor_cost'],
    [opt({ vendor_cost: '5' }), 'invalid_vendor_cost'],
    [opt({ vendor_cost: 10_000_001 }), 'invalid_vendor_cost'],
    [opt({ platform_price: -1 }), 'invalid_platform_price'],
    [opt({ platform_price: undefined }), 'invalid_platform_price'],
    [opt({ platform_price: 1.5 }), 'invalid_platform_price'],
  ];
  const before = snapshot(env);
  for (const [body, code] of cases) await bad(await op(env, 'POST', '/api/operator/products', body), 400, code, JSON.stringify(body).slice(0, 80));
  for (const body of ['[]', 'null', 'nope']) assert.equal((await op(env, 'POST', '/api/operator/products', body)).status, 400);
  for (const [body, code] of [
    [{ name: '' }, 'invalid_name'],
    [{ kind: 'service' }, 'invalid_kind'],
    [{ options: [{ id: 'nope', label: '', vendor_cost: 1, platform_price: 1 }] }, 'invalid_options'],
    [{ options: [{ label: '', vendor_cost: 1, platform_price: -1 }] }, 'invalid_platform_price'],
  ]) await bad(await op(env, 'PUT', `/api/operator/products/${existing.id}`, body), 400, code, JSON.stringify(body));
  assert.equal(snapshot(env), before);
  // the boundaries are accepted
  const edge = await platformProduct(env, {
    name: 'x'.repeat(60), options: Array.from({ length: 20 }, (_, i) => ({ label: 'z'.repeat(60), vendor_cost: i ? 10_000_000 : 0, platform_price: 0 })),
  });
  assert.equal(edge.options.length, 20);
});

test('operator: PUT changes fields; options are a set, missing ones retired; retire and restore', async () => {
  const env = envOp();
  const pp = await platformProduct(env);
  const [s, m] = pp.options;
  const res = await op(env, 'PUT', `/api/operator/products/${pp.id}`, {
    name: '畫布', options: [{ id: m.id, label: 'M', vendor_cost: 5, platform_price: 6 }, { label: 'L', vendor_cost: 7, platform_price: 8 }],
  });
  assert.equal(res.status, 200);
  const { product } = await res.json();
  assert.deepEqual([product.name, product.description, product.kind], ['畫布', '木框', 'print']);
  const byId = Object.fromEntries(product.options.map(o => [o.id, o]));
  assert.deepEqual([byId[m.id].label, byId[m.id].vendor_cost, byId[m.id].platform_price, byId[m.id].active, byId[m.id].sort], ['M', 5, 6, 1, 0]);
  assert.equal(byId[s.id].active, 0, 'retired, not deleted');
  assert.equal(product.options.length, 3);
  assert.deepEqual(await json(await op(env, 'POST', `/api/operator/products/${pp.id}/retire`)), { ok: true, active: 0 });
  assert.equal(one(env, 'SELECT active FROM platform_products').active, 0);
  assert.deepEqual(await json(await op(env, 'POST', `/api/operator/products/${pp.id}/restore`)), { ok: true, active: 1 });
  for (const [method, path, body] of [
    ['PUT', '/api/operator/products/nope', { name: 'x' }],
    ['POST', '/api/operator/products/nope/retire'],
    ['POST', '/api/operator/products/nope/restore'],
  ]) assert.equal((await op(env, method, path, body)).status, 404, `${method} ${path}`);
});

// ─── the photographer's view of the platform ─────────────────────────────────

test('GET /api/admin/platform-products: active products and options, platform price, never vendor cost; adopted flagged', async () => {
  const env = envOp();
  const pp = await platformProduct(env);
  const gone = await platformProduct(env, { name: '停售' });
  await op(env, 'POST', `/api/operator/products/${gone.id}/retire`);
  // one option retired
  await op(env, 'PUT', `/api/operator/products/${pp.id}`, { options: [{ id: pp.options[0].id, label: '16×20', vendor_cost: VENDOR, platform_price: 1000 }] });
  let res = await admin(env, 'GET', '/api/admin/platform-products');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const raw = await res.text();
  assert.ok(!raw.includes(String(VENDOR)) && !raw.includes('vendor_cost'), raw);
  let list = JSON.parse(raw).products;
  assert.deepEqual(list.map(p => p.id), [pp.id], 'the retired platform product is not offered');
  assert.deepEqual(list[0].options.map(o => [o.id, o.label, o.platform_price]), [[pp.options[0].id, '16×20', 1000]]);
  assert.deepEqual([list[0].name, list[0].kind, list[0].description, list[0].has_image, list[0].adopted_product_id], ['無框畫', 'print', '木框', false, null]);
  const mine = await adopt(env, pp, [{ platform_option_id: pp.options[0].id, price: 1500 }]);
  list = (await json(await admin(env, 'GET', '/api/admin/platform-products'))).products;
  assert.equal(list[0].adopted_product_id, mine.id);
  assert.equal((await admin(env, 'POST', '/api/admin/platform-products')).status, 405);
  assert.equal((await admin(env, 'GET', '/api/admin/platform-products/x')).status, 404);
});

// ─── custom products are services only ───────────────────────────────────────

test('a photographer cannot create or turn a custom product into an album or print: 400 platform_only', async () => {
  const env = envOp(CUSTOM_ON);
  const before = snapshot(env);
  for (const kind of ['album', 'print']) {
    await bad(await admin(env, 'POST', '/api/admin/products', { kind, name: 'x', options: [{ label: '', price: 1 }] }), 400, 'platform_only', kind);
  }
  assert.equal(snapshot(env), before);
  const res = await admin(env, 'POST', '/api/admin/products', { kind: 'service', name: '加修', options: [{ label: '', price: 300, cost: 0 }] });
  assert.equal(res.status, 201, 'positive: a service is still the photographer\'s own');
  const { product } = await res.json();
  assert.equal(product.platform_product_id, null);
  const mid = snapshot(env);
  for (const kind of ['album', 'print']) {
    await bad(await admin(env, 'PUT', `/api/admin/products/${product.id}`, { kind }), 400, 'platform_only', kind);
  }
  assert.equal(snapshot(env), mid);
  assert.equal((await admin(env, 'PUT', `/api/admin/products/${product.id}`, { kind: 'service', name: '急件' })).status, 200);
});

// ─── adopt ───────────────────────────────────────────────────────────────────

test('adopt: a subset of options at the photographer\'s prices; name and kind come from the platform', async () => {
  const env = envOp();
  const pp = await platformProduct(env, { kind: 'album', photo_count: 20 });
  const res = await admin(env, 'POST', '/api/admin/products/from-platform', {
    platform_product_id: pp.id, options: [{ platform_option_id: pp.options[1].id, price: 2000 }],
    name: 'mine', kind: 'service', description: 'x', photo_count: 3, photographer_id: 'other', sort: 4, guest_visible: true,
  });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const raw = await res.clone().text();
  assert.ok(!raw.includes(String(VENDOR + 1)) && !raw.includes('vendor_cost'), raw);
  const { product } = await res.json();
  assert.deepEqual([product.kind, product.name, product.description, product.photo_count, product.platform_product_id, product.sort, product.guest_visible, product.active],
    ['album', '無框畫', '木框', 20, pp.id, 4, 1, 1]);
  assert.deepEqual(product.options.map(o => [o.label, o.price, o.cost, o.platform_price, o.platform_option_id, o.below_platform_price, o.active]),
    [['24×36', 2000, 2000, 2000, pp.options[1].id, false, 1]]);
  assert.equal(one(env, 'SELECT photographer_id FROM products').photographer_id, 'default');
  const list = (await json(await admin(env, 'GET', '/api/admin/products'))).products;
  assert.deepEqual(list, [product]);
  // the platform renames it: the photographer's catalogue follows
  await op(env, 'PUT', `/api/operator/products/${pp.id}`, { name: '相本書', description: '新', photo_count: 30 });
  const [live] = (await json(await admin(env, 'GET', '/api/admin/products'))).products;
  assert.deepEqual([live.name, live.description, live.photo_count], ['相本書', '新', 30]);
});

test('adopt: one per platform product (409 already_adopted, retired or not)', async () => {
  const env = envOp();
  const pp = await platformProduct(env);
  const mine = await adopt(env, pp);
  const before = snapshot(env);
  const again = { platform_product_id: pp.id, options: [{ platform_option_id: pp.options[0].id, price: 5000 }] };
  let res = await admin(env, 'POST', '/api/admin/products/from-platform', again);
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: '已加入這個平台商品', code: 'already_adopted', product_id: mine.id });
  await admin(env, 'POST', `/api/admin/products/${mine.id}/retire`);
  const retired = snapshot(env);
  assert.notEqual(retired, before);
  res = await admin(env, 'POST', '/api/admin/products/from-platform', again);
  assert.equal(res.status, 409);
  assert.equal(snapshot(env), retired);
  // another photographer's adoption does not count against this one
  const other = await platformProduct(env, { name: '別的' });
  env.DB._db.prepare("INSERT INTO products (id, photographer_id, kind, name, platform_product_id, created_at, updated_at) VALUES ('theirs', 'other', 'print', 'x', ?, ?, ?)")
    .run(other.id, days(0), days(0));
  assert.equal((await admin(env, 'POST', '/api/admin/products/from-platform', { platform_product_id: other.id, options: [{ platform_option_id: other.options[0].id, price: 1000 }] })).status, 201);
});

test('adopt: two adopts racing land one product, the other is 409', async () => {
  const env = envOp();
  const pp = await platformProduct(env);
  const body = { platform_product_id: pp.id, options: [{ platform_option_id: pp.options[0].id, price: 1000 }] };
  // the second request's existence check has already passed when the first lands
  const prepare = env.DB.prepare.bind(env.DB);
  let done = false;
  env.DB.prepare = s => {
    if (!done && /^INSERT INTO products/.test(s)) {
      done = true;
      env.DB._db.prepare("INSERT INTO products (id, photographer_id, kind, name, platform_product_id, created_at, updated_at) VALUES ('first', 'default', 'print', 'x', ?, ?, ?)")
        .run(pp.id, days(0), days(0));
    }
    return prepare(s);
  };
  const res = await admin(env, 'POST', '/api/admin/products/from-platform', body);
  assert.ok(done);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'already_adopted');
  assert.equal(rows(env, 'SELECT * FROM products').length, 1);
  assert.equal(rows(env, 'SELECT * FROM product_options').length, 0);
});

test('adopt: validation is 400 with a code, and nothing is written', async () => {
  const env = envOp();
  const pp = await platformProduct(env);
  const other = await platformProduct(env, { name: '別的' });
  const gone = await platformProduct(env, { name: '停售' });
  await op(env, 'POST', `/api/operator/products/${gone.id}/retire`);
  const [s, m] = pp.options;
  // the operator retired one option
  await op(env, 'PUT', `/api/operator/products/${pp.id}`, { options: [{ id: s.id, label: '16×20', vendor_cost: VENDOR, platform_price: 1000 }] });
  const o = (id, price) => ({ platform_option_id: id, price });
  const cases = [
    [{ options: [o(s.id, 1000)] }, 'unknown_platform_product'],
    [{ platform_product_id: 'nope', options: [o(s.id, 1000)] }, 'unknown_platform_product'],
    [{ platform_product_id: 5, options: [o(s.id, 1000)] }, 'unknown_platform_product'],
    [{ platform_product_id: gone.id, options: [o(gone.options[0].id, 1000)] }, 'retired_option'],
    [{ platform_product_id: pp.id }, 'invalid_options'],
    [{ platform_product_id: pp.id, options: [] }, 'invalid_options'],
    [{ platform_product_id: pp.id, options: 'x' }, 'invalid_options'],
    [{ platform_product_id: pp.id, options: [null] }, 'invalid_options'],
    [{ platform_product_id: pp.id, options: [o('nope', 1000)] }, 'invalid_options'],
    [{ platform_product_id: pp.id, options: [o(other.options[0].id, 1000)] }, 'invalid_options'],
    [{ platform_product_id: pp.id, options: [o(s.id, 1000), o(s.id, 1200)] }, 'invalid_options'],
    [{ platform_product_id: pp.id, options: [o(m.id, 5000)] }, 'retired_option'],
    [{ platform_product_id: pp.id, options: [o(s.id, -1)] }, 'invalid_price'],
    [{ platform_product_id: pp.id, options: [o(s.id, '2000')] }, 'invalid_price'],
    [{ platform_product_id: pp.id, options: [o(s.id, 10_000_001)] }, 'invalid_price'],
    [{ platform_product_id: pp.id, options: [o(s.id, 999)] }, 'below_platform_price'],
    [{ platform_product_id: pp.id, options: [o(s.id, 0)] }, 'below_platform_price'],
    [{ platform_product_id: pp.id, options: [o(s.id, 1000)], sort: -1 }, 'invalid_sort'],
    [{ platform_product_id: pp.id, options: [o(s.id, 1000)], guest_visible: 'yes' }, 'invalid_guest_visible'],
  ];
  const before = snapshot(env);
  for (const [body, code] of cases) {
    await bad(await admin(env, 'POST', '/api/admin/products/from-platform', body), 400, code, JSON.stringify(body));
  }
  for (const body of ['[]', 'null', 'nope']) assert.equal((await admin(env, 'POST', '/api/admin/products/from-platform', body)).status, 400);
  assert.equal(snapshot(env), before);
  // the floor itself is accepted
  const ok = await adopt(env, pp, [o(s.id, 1000)]);
  assert.equal(ok.options[0].price, 1000);
});

// ─── an adopted product's edits ──────────────────────────────────────────────

test('adopted PUT: only options (platform ids + prices), sort and guest_visible; the platform\'s fields are 400', async () => {
  const env = envOp();
  const pp = await platformProduct(env);
  const [s, m] = pp.options;
  const mine = await adopt(env, pp, [{ platform_option_id: s.id, price: 1500 }]);
  const before = snapshot(env);
  for (const [body, code] of [
    [{ name: 'x' }, 'platform_managed'],
    [{ kind: 'print' }, 'platform_managed'],
    [{ description: 'x' }, 'platform_managed'],
    [{ photo_count: 3 }, 'platform_managed'],
    [{ options: [] }, 'invalid_options'],
    [{ options: [{ platform_option_id: 'nope', price: 1 }] }, 'invalid_options'],
    [{ options: [{ label: 'x', price: 5000 }] }, 'invalid_options'],
    [{ options: [{ platform_option_id: s.id, price: 999 }] }, 'below_platform_price'],
    [{ options: [{ platform_option_id: s.id, price: 1500 }, { platform_option_id: m.id, price: 1999 }] }, 'below_platform_price'],
    [{ options: [{ platform_option_id: s.id, price: -1 }] }, 'invalid_price'],
    [{ sort: -1 }, 'invalid_sort'],
  ]) await bad(await admin(env, 'PUT', `/api/admin/products/${mine.id}`, body), 400, code, JSON.stringify(body));
  assert.equal(snapshot(env), before);
  // add m, reprice s, move it, show it to guests
  let res = await admin(env, 'PUT', `/api/admin/products/${mine.id}`, {
    options: [{ platform_option_id: m.id, price: 2500 }, { platform_option_id: s.id, price: 1200 }], sort: 7, guest_visible: 1,
  });
  assert.equal(res.status, 200);
  let { product } = await res.json();
  assert.deepEqual([product.sort, product.guest_visible, product.name], [7, 1, '無框畫']);
  assert.deepEqual(product.options.filter(o => o.active).map(o => [o.platform_option_id, o.price, o.sort]), [[m.id, 2500, 0], [s.id, 1200, 1]]);
  const sRow = product.options.find(o => o.platform_option_id === s.id);
  assert.equal(sRow.id, mine.options[0].id, 'the same option row, repriced');
  // drop s: retired, never deleted
  ({ product } = await json(await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { options: [{ platform_option_id: m.id, price: 2500 }] })));
  assert.deepEqual(product.options.map(o => [o.platform_option_id, o.active]).sort(), [[m.id, 1], [s.id, 0]].sort());
  assert.equal(rows(env, 'SELECT * FROM product_options').length, 2);
  // and it comes back by naming it again
  ({ product } = await json(await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { options: [{ platform_option_id: s.id, price: 1100 }] })));
  assert.deepEqual(product.options.filter(o => o.active).map(o => [o.id, o.price]), [[sRow.id, 1100]]);
  // retire and restore work on an adopted product too
  assert.deepEqual(await json(await admin(env, 'POST', `/api/admin/products/${mine.id}/retire`)), { ok: true, active: 0 });
  assert.deepEqual(await json(await admin(env, 'POST', `/api/admin/products/${mine.id}/restore`)), { ok: true, active: 1 });
});

test('adopted PUT: a platform option the operator retired cannot be kept on', async () => {
  const env = envOp();
  const pp = await platformProduct(env);
  const [s, m] = pp.options;
  const mine = await adopt(env, pp);
  await op(env, 'PUT', `/api/operator/products/${pp.id}`, { options: [{ id: m.id, label: '24×36', vendor_cost: 1, platform_price: 2000 }] });
  const before = snapshot(env);
  await bad(await admin(env, 'PUT', `/api/admin/products/${mine.id}`, {
    options: [{ platform_option_id: s.id, price: 3000 }, { platform_option_id: m.id, price: 6000 }],
  }), 400, 'retired_option');
  assert.equal(snapshot(env), before);
  assert.equal((await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { options: [{ platform_option_id: m.id, price: 6000 }] })).status, 200);
});

// ─── the platform price as a floor ───────────────────────────────────────────

test('the operator raises the platform price: flagged, and new lines below it are 400 below_platform_price', async () => {
  const env = envOp();
  const pp = await platformProduct(env);
  const [s] = pp.options;
  const mine = await adopt(env, pp, [{ platform_option_id: s.id, price: 1500 }]);
  const { project } = await createProject(env);
  const order = await newOrder(env, project.id, { lines: [{ option_id: mine.options[0].id, qty: 1 }] });
  await op(env, 'PUT', `/api/operator/products/${pp.id}`, { options: [{ id: s.id, label: '16×20', vendor_cost: VENDOR, platform_price: 1600 }] });
  const [flagged] = (await json(await admin(env, 'GET', '/api/admin/products'))).products;
  assert.deepEqual([flagged.options[0].below_platform_price, flagged.options[0].platform_price, flagged.options[0].cost, flagged.options[0].price], [true, 1600, 1600, 1500]);
  const before = snapshot(env);
  const line = extra => ({ option_id: mine.options[0].id, qty: 1, ...extra });
  await bad(await admin(env, 'POST', `/api/admin/projects/${project.id}/orders`, { lines: [line()] }), 400, 'below_platform_price', 'catalogue price');
  await bad(await admin(env, 'POST', `/api/admin/projects/${project.id}/orders`, { lines: [line({ unit_price: 1599 })] }), 400, 'below_platform_price', 'override');
  await bad(await admin(env, 'POST', `/api/admin/projects/${project.id}/orders`, { lines: [line({ unit_price: 0 })] }), 400, 'below_platform_price', 'override 0');
  await bad(await admin(env, 'PUT', `/api/admin/orders/${order.id}`, { lines: [{ id: order.items[0].id }, line()] }), 400, 'below_platform_price', 'PUT add');
  assert.equal(snapshot(env), before);
  // the existing line keeps its snapshot for the units already sold, but
  // cannot grow at the old platform price: new units are a new line
  await bad(await admin(env, 'PUT', `/api/admin/orders/${order.id}`, { lines: [{ id: order.items[0].id, qty: 2 }] }), 400, 'below_platform_price', 'PUT grow');
  await bad(await admin(env, 'PUT', `/api/admin/orders/${order.id}`, { lines: [{ id: order.items[0].id, qty: 2, unit_price: 5000 }] }), 400, 'below_platform_price', 'PUT grow, repriced');
  assert.equal(snapshot(env), before);
  // a photo edit, or a reprice at or above its own cost, is not a new unit
  assert.equal((await admin(env, 'PUT', `/api/admin/orders/${order.id}`, { lines: [{ id: order.items[0].id, qty: 1, photo_keys: [A], unit_price: 1000 }] })).status, 200);
  // an explicit override at or above the platform price is fine
  const over = await newOrder(env, project.id, { lines: [line({ unit_price: 1600 })] });
  assert.deepEqual([over.items[0].unit_price, over.items[0].unit_cost], [1600, 1600]);
  // and the photographer repricing it clears the flag
  const res = await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { options: [{ platform_option_id: s.id, price: 1600 }] });
  assert.equal((await res.json()).product.options[0].below_platform_price, false);
  assert.equal((await newOrder(env, project.id, { lines: [line()] })).items[0].unit_price, 1600);
});

test('a kept adopted line cannot be repriced under its own cost', async () => {
  const env = envOp(CUSTOM_ON);
  const pp = await platformProduct(env);
  const mine = await adopt(env, pp, [{ platform_option_id: pp.options[0].id, price: 1500 }]);
  const { project } = await createProject(env);
  const order = await newOrder(env, project.id, { lines: [{ option_id: mine.options[0].id, qty: 1 }] });
  const id = order.items[0].id;
  const before = snapshot(env);
  await bad(await admin(env, 'PUT', `/api/admin/orders/${order.id}`, { lines: [{ id, unit_price: 999 }] }), 400, 'below_platform_price');
  assert.equal(snapshot(env), before);
  const ok = await json(await admin(env, 'PUT', `/api/admin/orders/${order.id}`, { lines: [{ id, unit_price: 1000 }] }));
  assert.equal(ok.order.items[0].unit_price, 1000);
  // a service line has no floor: the photographer's own
  const svc = (await json(await admin(env, 'POST', '/api/admin/products', { kind: 'service', name: '加修', options: [{ label: '', price: 300, cost: 100 }] }))).product;
  const o2 = await newOrder(env, project.id, { lines: [{ option_id: svc.options[0].id, qty: 1, unit_price: 0 }] });
  assert.deepEqual([o2.items[0].unit_price, o2.items[0].unit_cost], [0, 100]);
});

// ─── retired on the platform ─────────────────────────────────────────────────

test('a platform option or product the operator retired: new lines are retired_option, old orders keep theirs', async () => {
  const env = envOp();
  const pp = await platformProduct(env);
  const [s, m] = pp.options;
  const mine = await adopt(env, pp);
  const [ms, mm] = mine.options;
  const { project } = await createProject(env);
  const order = await newOrder(env, project.id, { lines: [{ option_id: ms.id, qty: 1 }] });
  // the operator retires option s
  await op(env, 'PUT', `/api/operator/products/${pp.id}`, { options: [{ id: m.id, label: '24×36', vendor_cost: VENDOR + 1, platform_price: 2000 }] });
  let before = snapshot(env);
  await bad(await admin(env, 'POST', `/api/admin/projects/${project.id}/orders`, { lines: [{ option_id: ms.id, qty: 1 }] }), 400, 'retired_option');
  await bad(await admin(env, 'PUT', `/api/admin/orders/${order.id}`, { lines: [{ id: order.items[0].id }, { option_id: ms.id, qty: 1 }] }), 400, 'retired_option');
  assert.equal(snapshot(env), before);
  assert.equal((await admin(env, 'POST', `/api/admin/projects/${project.id}/orders`, { lines: [{ option_id: mm.id, qty: 1 }] })).status, 201, 'the other option still sells');
  // then the whole product
  await op(env, 'POST', `/api/operator/products/${pp.id}/retire`);
  before = snapshot(env);
  await bad(await admin(env, 'POST', `/api/admin/projects/${project.id}/orders`, { lines: [{ option_id: mm.id, qty: 1 }] }), 400, 'retired_option');
  assert.equal(snapshot(env), before);
  const [kept] = (await json(await admin(env, 'GET', `/api/admin/projects/${project.id}/orders`))).orders.filter(o => o.id === order.id);
  assert.deepEqual([kept.items[0].name, kept.items[0].unit_price, kept.items[0].unit_cost], ['無框畫', 3000, 1000]);
  // the old line cannot grow: a new unit of a retired product is a new sale
  before = snapshot(env);
  await bad(await admin(env, 'PUT', `/api/admin/orders/${order.id}`, { lines: [{ id: order.items[0].id, qty: 2 }] }), 400, 'retired_option', 'PUT grow');
  assert.equal(snapshot(env), before);
  // but an edit that keeps its units still works
  assert.equal((await admin(env, 'PUT', `/api/admin/orders/${order.id}`, { lines: [{ id: order.items[0].id, photo_keys: [A] }] })).status, 200);
  const [listed] = (await json(await admin(env, 'GET', '/api/admin/products'))).products;
  assert.equal(listed.platform_active, 0);
  // restored, it sells again
  await op(env, 'POST', `/api/operator/products/${pp.id}/restore`);
  assert.equal((await admin(env, 'POST', `/api/admin/projects/${project.id}/orders`, { lines: [{ option_id: mm.id, qty: 1 }] })).status, 201);
});

test('a kept platform line: fewer units or new photos on a retired option are fine; more units need it live', async () => {
  const env = envOp();
  const pp = await platformProduct(env);
  const [s, m] = pp.options;
  const mine = await adopt(env, pp);
  const { project } = await createProject(env);
  const order = await newOrder(env, project.id, { lines: [{ option_id: mine.options[0].id, qty: 3 }] });
  const id = order.items[0].id;
  // the operator retires s (the option only)
  await op(env, 'PUT', `/api/operator/products/${pp.id}`, { options: [{ id: m.id, label: '24×36', vendor_cost: 1, platform_price: 2000 }] });
  const before = snapshot(env);
  await bad(await admin(env, 'PUT', `/api/admin/orders/${order.id}`, { lines: [{ id, qty: 4 }] }), 400, 'retired_option', 'grow');
  assert.equal(snapshot(env), before);
  let res = await admin(env, 'PUT', `/api/admin/orders/${order.id}`, { lines: [{ id, qty: 2 }] });
  assert.equal(res.status, 200, 'fewer units');
  assert.equal((await res.json()).order.items[0].qty, 2);
  res = await admin(env, 'PUT', `/api/admin/orders/${order.id}`, { lines: [{ id, photo_keys: [A] }] });
  assert.equal(res.status, 200, 'a photo edit');
  res = await admin(env, 'PUT', `/api/admin/orders/${order.id}`, { lines: [{ id, qty: 2 }] });
  assert.equal(res.status, 200, 'the same count');
  // restored, it may grow again
  await op(env, 'PUT', `/api/operator/products/${pp.id}`, { options: [{ id: s.id, label: '16×20', vendor_cost: VENDOR, platform_price: 1000 }, { id: m.id, label: '24×36', vendor_cost: 1, platform_price: 2000 }] });
  res = await admin(env, 'PUT', `/api/admin/orders/${order.id}`, { lines: [{ id, qty: 5 }] });
  assert.equal(res.status, 200, 'grow once live again');
  // the whole platform product retired: same rule
  await op(env, 'POST', `/api/operator/products/${pp.id}/retire`);
  const mid = snapshot(env);
  await bad(await admin(env, 'PUT', `/api/admin/orders/${order.id}`, { lines: [{ id, qty: 6 }] }), 400, 'retired_option', 'grow, product retired');
  assert.equal(snapshot(env), mid);
  assert.equal((await admin(env, 'PUT', `/api/admin/orders/${order.id}`, { lines: [{ id, qty: 1 }] })).status, 200);
});

test('a kept platform line may grow when the platform price was lowered or kept; its snapshot stays', async () => {
  const env = envOp();
  const pp = await platformProduct(env);
  const [s] = pp.options;
  const mine = await adopt(env, pp, [{ platform_option_id: s.id, price: 1500 }]);
  const { project } = await createProject(env);
  const order = await newOrder(env, project.id, { lines: [{ option_id: mine.options[0].id, qty: 1 }] });
  const id = order.items[0].id;
  // unchanged price: grows
  let res = await admin(env, 'PUT', `/api/admin/orders/${order.id}`, { lines: [{ id, qty: 2 }] });
  assert.equal(res.status, 200);
  // lowered: grows, and the line keeps one cost, its snapshot
  await op(env, 'PUT', `/api/operator/products/${pp.id}`, { options: [{ id: s.id, label: '16×20', vendor_cost: 1, platform_price: 800 }] });
  res = await admin(env, 'PUT', `/api/admin/orders/${order.id}`, { lines: [{ id, qty: 3 }] });
  assert.equal(res.status, 200);
  const item = (await res.json()).order.items[0];
  assert.deepEqual([item.qty, item.unit_price, item.unit_cost], [3, 1500, 1000]);
  assert.equal(one(env, 'SELECT vendor_cost FROM order_items').vendor_cost, VENDOR);
  // raised above the snapshot, even under the line's price: a new line
  await op(env, 'PUT', `/api/operator/products/${pp.id}`, { options: [{ id: s.id, label: '16×20', vendor_cost: 1, platform_price: 1001 }] });
  const before = snapshot(env);
  const r = await admin(env, 'PUT', `/api/admin/orders/${order.id}`, { lines: [{ id, qty: 4 }] });
  assert.equal(r.status, 400);
  const out = await r.json();
  assert.equal(out.code, 'below_platform_price');
  assert.match(out.error, /新的一行|new line/);
  assert.equal(snapshot(env), before);
});

test('a kept platform line whose platform option row is gone cannot grow (400, not 500)', async () => {
  const env = envOp();
  const pp = await platformProduct(env);
  const mine = await adopt(env, pp);
  const { project } = await createProject(env);
  const order = await newOrder(env, project.id, { lines: [{ option_id: mine.options[0].id, qty: 1 }] });
  env.DB._db.prepare('DELETE FROM platform_product_options WHERE id = ?').run(pp.options[0].id);
  const before = snapshot(env);
  await bad(await admin(env, 'PUT', `/api/admin/orders/${order.id}`, { lines: [{ id: order.items[0].id, qty: 2 }] }), 400, 'retired_option');
  assert.equal(snapshot(env), before);
  assert.equal((await admin(env, 'PUT', `/api/admin/orders/${order.id}`, { lines: [{ id: order.items[0].id, note: 'x' }] })).status, 200);
});

test('a hand-edited adopted option that names another platform product\'s option fails closed', async () => {
  const env = envOp();
  const pp = await platformProduct(env);
  const other = await platformProduct(env, { name: '別的', options: [{ label: 'cheap', vendor_cost: 0, platform_price: 0 }] });
  const mine = await adopt(env, pp);
  env.DB._db.prepare('UPDATE product_options SET platform_option_id = ? WHERE id = ?').run(other.options[0].id, mine.options[0].id);
  const { project } = await createProject(env);
  const before = snapshot(env);
  await bad(await admin(env, 'POST', `/api/admin/projects/${project.id}/orders`, { lines: [{ option_id: mine.options[0].id, qty: 1 }] }), 400, 'retired_option');
  assert.equal(snapshot(env), before);
  // the untouched option still sells
  assert.equal((await admin(env, 'POST', `/api/admin/projects/${project.id}/orders`, { lines: [{ option_id: mine.options[1].id, qty: 1 }] })).status, 201);
});

// ─── snapshots ───────────────────────────────────────────────────────────────

test('a line snapshots the platform price as its cost, the vendor cost and the platform option; operator edits never change it', async () => {
  const env = envOp(CUSTOM_ON);
  const pp = await platformProduct(env);
  const mine = await adopt(env, pp, [{ platform_option_id: pp.options[0].id, price: 3000 }]);
  const { project } = await createProject(env);
  const order = await newOrder(env, project.id, { lines: [{ option_id: mine.options[0].id, qty: 2, photo_keys: [A] }] });
  const item = () => one(env, 'SELECT * FROM order_items WHERE id = ?', order.items[0].id);
  assert.deepEqual([item().kind, item().name, item().option_label, item().unit_price, item().unit_cost, item().vendor_cost, item().platform_option_id, item().product_id, item().option_id],
    ['print', '無框畫', '16×20', 3000, 1000, VENDOR, pp.options[0].id, mine.id, mine.options[0].id]);
  assert.deepEqual([order.cost, order.total], [2000, 6000]);
  const was = { ...item() };
  await op(env, 'PUT', `/api/operator/products/${pp.id}`, {
    name: '改名', options: [{ id: pp.options[0].id, label: '改', vendor_cost: 1, platform_price: 2 }],
  });
  assert.deepEqual({ ...item() }, was);
  const [read] = (await json(await admin(env, 'GET', `/api/admin/projects/${project.id}/orders`))).orders;
  assert.deepEqual([read.items[0].name, read.items[0].option_label, read.items[0].unit_cost, read.cost], ['無框畫', '16×20', 1000, 2000]);
  // a new line takes the platform's current name, label and price
  const next = await newOrder(env, project.id, { lines: [{ option_id: mine.options[0].id, qty: 1 }] });
  assert.deepEqual([next.items[0].name, next.items[0].option_label, next.items[0].unit_cost],
    ['改名', '改', 2]);
  assert.equal(one(env, 'SELECT vendor_cost FROM order_items WHERE id = ?', next.items[0].id).vendor_cost, 1);
  // a custom service line carries no vendor cost and no platform option
  const svc = (await json(await admin(env, 'POST', '/api/admin/products', { kind: 'service', name: '加修', options: [{ label: '', price: 300, cost: 50 }] }))).product;
  const s = await newOrder(env, project.id, { lines: [{ option_id: svc.options[0].id, qty: 1 }] });
  assert.deepEqual({ ...one(env, 'SELECT unit_cost, vendor_cost, platform_option_id FROM order_items WHERE id = ?', s.items[0].id) },
    { unit_cost: 50, vendor_cost: 0, platform_option_id: null });
});

test('another photographer\'s adopted option cannot go on my order', async () => {
  const env = envOp();
  const pp = await platformProduct(env);
  env.DB._db.prepare("INSERT INTO products (id, photographer_id, kind, name, platform_product_id, created_at, updated_at) VALUES ('theirs', 'other', 'print', 'x', ?, ?, ?)")
    .run(pp.id, days(0), days(0));
  env.DB._db.prepare("INSERT INTO product_options (id, product_id, label, price, cost, platform_option_id) VALUES ('topt', 'theirs', '', 5000, 0, ?)").run(pp.options[0].id);
  const { project } = await createProject(env);
  const before = snapshot(env);
  await bad(await admin(env, 'POST', `/api/admin/projects/${project.id}/orders`, { lines: [{ option_id: 'topt', qty: 1 }] }), 400, 'unknown_option');
  assert.equal((await admin(env, 'PUT', '/api/admin/products/theirs', { sort: 1 })).status, 404);
  assert.equal(snapshot(env), before);
  // theirs does not show as adopted by me, and I can adopt it myself
  const [offered] = (await json(await admin(env, 'GET', '/api/admin/platform-products'))).products;
  assert.equal(offered.adopted_product_id, null);
  assert.ok(!(await json(await admin(env, 'GET', '/api/admin/products'))).products.some(p => p.id === 'theirs'));
});

// ─── vendor_cost never reaches the photographer ─────────────────────────────

test('vendor_cost appears in no /api/admin/* response', async () => {
  const env = envOp();
  const pp = await platformProduct(env);
  const mine = await adopt(env, pp);
  const { project } = await createProject(env);
  const texts = [];
  const grab = async res => { const t = await res.text(); texts.push([res.url || '', t]); return JSON.parse(t); };
  const created = await grab(await admin(env, 'POST', `/api/admin/projects/${project.id}/orders`, {
    lines: [{ option_id: mine.options[0].id, qty: 1 }, { option_id: mine.options[1].id, qty: 1 }],
  }));
  assert.ok(created.order, 'positive: the order was made');
  const id = created.order.id;
  await grab(await admin(env, 'PUT', `/api/admin/orders/${id}`, { note: 'x' }));
  await grab(await admin(env, 'POST', `/api/admin/orders/${id}/payment`, { paid_amount: 1000, paid_method: 'cash' }));
  await grab(await admin(env, 'POST', `/api/admin/orders/${id}/status`, { status: 'fulfilled' }));
  await grab(await admin(env, 'GET', `/api/admin/projects/${project.id}/orders`));
  await grab(await admin(env, 'GET', '/api/admin/orders'));
  await grab(await admin(env, 'GET', '/api/admin/orders?unpaid=1'));
  await grab(await admin(env, 'GET', '/api/admin/products'));
  await grab(await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { sort: 1 }));
  await grab(await admin(env, 'GET', '/api/admin/platform-products'));
  const statsBody = await grab(await admin(env, 'GET', '/api/admin/stats'));
  assert.equal(statsBody.revenue[11].cost, 3000, 'positive: the photographer\'s cost is the platform price');
  // the value is really stored, so the search is meaningful
  assert.equal(rows(env, 'SELECT vendor_cost FROM order_items ORDER BY vendor_cost').map(r => r.vendor_cost).join(), `${VENDOR},${VENDOR + 1}`);
  for (const [, t] of texts) {
    assert.ok(!t.includes('vendor_cost'), t.slice(0, 200));
    assert.ok(!t.includes(String(VENDOR)) && !t.includes(String(VENDOR + 1)), t.slice(0, 200));
  }
  // and the operator does see it
  assert.ok((await (await op(env, 'GET', '/api/operator/products')).text()).includes(String(VENDOR)));
});

// ─── operator stats ──────────────────────────────────────────────────────────

function monthKey(ms) {
  const d = new Date(ms + 8 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function taipeiMonthStart(back = 0) {
  const d = new Date(Date.now() + 8 * 3600000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1) - 8 * 3600000;
}

test('operator stats: per platform product, paid orders by Taipei month, across photographers; cancelled and unpaid excluded', async () => {
  const env = envOp(CUSTOM_ON);
  const book = await platformProduct(env, { kind: 'album', name: '相本書', options: [{ label: '', vendor_cost: 300, platform_price: 1000 }] });
  const print = await platformProduct(env, { name: '無框畫', options: [{ label: '', vendor_cost: 200, platform_price: 500 }] });
  const unsold = await platformProduct(env, { name: '沒賣', options: [{ label: '', vendor_cost: 1, platform_price: 1 }] });
  const b = await adopt(env, book, [{ platform_option_id: book.options[0].id, price: 3000 }]);
  const p = await adopt(env, print, [{ platform_option_id: print.options[0].id, price: 1500 }]);
  const svc = (await json(await admin(env, 'POST', '/api/admin/products', { kind: 'service', name: '加修', options: [{ label: '', price: 300, cost: 100 }] }))).product;
  const { project } = await createProject(env);
  const iso = ms => new Date(ms).toISOString();
  const thisStart = taipeiMonthStart(0);
  const paid = (o, at, amount = 1) => env.DB._db.prepare("UPDATE orders SET paid_amount = ?, paid_at = ?, paid_method = 'cash' WHERE id = ?").run(amount, at, o.id);
  // this month: 2 books + 1 print + a service (not the platform's); part-paid counts
  const o1 = await newOrder(env, project.id, { lines: [{ option_id: b.options[0].id, qty: 2 }, { option_id: p.options[0].id, qty: 1 }, { option_id: svc.options[0].id, qty: 1 }] });
  paid(o1, iso(thisStart));
  // last month (its last instant): 3 prints
  const o2 = await newOrder(env, project.id, { lines: [{ option_id: p.options[0].id, qty: 3 }] });
  paid(o2, iso(thisStart - 1));
  // paid, then cancelled: nothing
  const o3 = await newOrder(env, project.id, { lines: [{ option_id: b.options[0].id, qty: 5 }] });
  paid(o3, iso(thisStart));
  env.DB._db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(o3.id);
  // unpaid: nothing
  await newOrder(env, project.id, { lines: [{ option_id: b.options[0].id, qty: 7 }] });
  // 12 months back: out of the window
  const o5 = await newOrder(env, project.id, { lines: [{ option_id: b.options[0].id, qty: 11 }] });
  paid(o5, iso(taipeiMonthStart(12)));
  // another photographer's order with a platform line, paid this month: counts
  env.DB._db.prepare("INSERT INTO projects (id, title, folders, created_at, photographer_id) VALUES ('op', 'theirs', '[]', ?, 'other')").run(days(0));
  env.DB._db.prepare("INSERT INTO orders (id, photographer_id, project_id, source, paid_amount, paid_at, paid_method, created_at, updated_at) VALUES ('oord', 'other', 'op', 'admin', 1, ?, 'cash', ?, ?)")
    .run(iso(thisStart + 1000), days(0), days(0));
  env.DB._db.prepare("INSERT INTO order_items (id, order_id, kind, name, unit_price, unit_cost, vendor_cost, platform_option_id, qty) VALUES ('oi', 'oord', 'album', '相本書', 2000, 1000, 300, ?, 1)")
    .run(book.options[0].id);
  // the operator raises the price later: the stats use the snapshots
  await op(env, 'PUT', `/api/operator/products/${book.id}`, { options: [{ id: book.options[0].id, label: '', vendor_cost: 999, platform_price: 9999 }] });

  const res = await op(env, 'GET', '/api/operator/stats');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const body = await res.json();
  const now = monthKey(thisStart);
  const last = monthKey(thisStart - 1);
  assert.equal(body.per_month.length, 12);
  assert.equal(body.per_month[11].month, now);
  const pm = Object.fromEntries(body.per_month.map(m => [m.month, m]));
  // this month: books 3 (2 mine + 1 theirs) × 1000 / 300, print 1 × 500 / 200
  assert.deepEqual({ ...pm[now] }, { month: now, qty: 4, revenue: 3500, vendor_cost: 1100, margin: 2400 });
  assert.deepEqual({ ...pm[last] }, { month: last, qty: 3, revenue: 1500, vendor_cost: 600, margin: 900 });
  assert.deepEqual({ ...body.this_month }, { ...pm[now] });
  assert.equal(body.per_month.reduce((n, m) => n + m.qty, 0), 7, 'cancelled, unpaid and out-of-window excluded');
  const by = Object.fromEntries(body.products.map(x => [x.platform_product_id, x]));
  assert.deepEqual({ ...by[book.id], this_month: { ...by[book.id].this_month } }, {
    platform_product_id: book.id, name: '相本書', kind: 'album', active: 1,
    qty: 3, revenue: 3000, vendor_cost: 900, margin: 2100,
    this_month: { qty: 3, revenue: 3000, vendor_cost: 900, margin: 2100 },
  });
  assert.deepEqual([by[print.id].qty, by[print.id].revenue, by[print.id].vendor_cost, by[print.id].margin], [4, 2000, 800, 1200]);
  assert.deepEqual([by[print.id].this_month.qty, by[print.id].this_month.revenue], [1, 500]);
  assert.deepEqual([by[unsold.id].qty, by[unsold.id].revenue, by[unsold.id].this_month.qty], [0, 0, 0]);
  assert.equal(body.products.length, 3);
});

test('operator stats: an empty platform has twelve zero months', async () => {
  const env = envOp();
  const body = await json(await op(env, 'GET', '/api/operator/stats'));
  assert.equal(body.per_month.length, 12);
  assert.ok(body.per_month.every(m => m.qty === 0 && m.revenue === 0 && m.vendor_cost === 0 && m.margin === 0));
  assert.equal(body.per_month[11].month, monthKey(Date.now()));
  assert.deepEqual(body.products, []);
});

// ─── product images ──────────────────────────────────────────────────────────

test('image: the operator uploads PNG, JPEG or WebP by magic bytes; served publicly with the logo\'s headers', async () => {
  const env = envOp();
  const pp = await platformProduct(env);
  assert.equal((await getImage(env, pp.id)).status, 404, 'none yet');
  for (const [bytes, type] of [[PNG, 'image/png'], [JPEG, 'image/jpeg'], [WEBP, 'image/webp']]) {
    const res = await putImage(env, pp.id, bytes, { headers: { 'Content-Type': 'image/svg+xml' } });
    assert.equal(res.status, 200, type);
    const out = await res.json();
    assert.deepEqual([out.ok, out.has_image, out.image_type, out.size], [true, true, type, bytes.length]);
    const got = await getImage(env, pp.id);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('Content-Type'), type);
    assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes);
  }
  const res = await getImage(env, pp.id);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('Content-Security-Policy'), "default-src 'none'");
  assert.equal(res.headers.get('Cache-Control'), 'public, max-age=300');
  const at = one(env, 'SELECT image_updated_at FROM platform_products').image_updated_at;
  assert.equal(res.headers.get('ETag'), `"${at}"`);
  assert.equal((await getImage(env, pp.id, { 'If-None-Match': `"${at}"` })).status, 304);
  assert.equal((await getImage(env, pp.id, { 'If-None-Match': '"old"' })).status, 200);
  // the listings say there is one
  assert.equal((await json(await op(env, 'GET', '/api/operator/products'))).products[0].has_image, true);
  const mine = await adopt(env, pp);
  const [listed] = (await json(await admin(env, 'GET', '/api/admin/products'))).products;
  assert.equal(listed.id, mine.id);
  assert.equal(listed.has_image, true, 'an adopted product shows the platform image');
  assert.equal((await json(await admin(env, 'GET', '/api/admin/platform-products'))).products[0].has_image, true);
  // delete
  const del = await call(env, `/api/operator/products/${pp.id}/image`, { method: 'DELETE', token: OP });
  assert.deepEqual(await del.json(), { ok: true, has_image: false });
  assert.equal((await getImage(env, pp.id)).status, 404);
  assert.equal(one(env, 'SELECT image FROM platform_products').image, null);
});

test('image: SVG, HTML, empty and near-misses are 415; over 200 KB is 413; an unknown product 404; nothing stored', async () => {
  const env = envOp();
  const pp = await platformProduct(env);
  for (const bytes of [
    text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    text('<html></html>'), text('GIF89a....'), new Uint8Array([]), PNG.slice(0, 7),
    new Uint8Array([...'RIFF'].map(c => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WAVE'].map(c => c.charCodeAt(0)))),
  ]) {
    const res = await putImage(env, pp.id, bytes, { headers: { 'Content-Type': 'image/png' } });
    assert.equal(res.status, 415);
    assert.equal((await res.json()).code, 'unsupported_type');
  }
  assert.equal(one(env, 'SELECT image FROM platform_products').image, null);
  const exact = new Uint8Array(200 * 1024); exact.set(PNG);
  assert.equal((await putImage(env, pp.id, exact)).status, 200);
  const over = new Uint8Array(200 * 1024 + 1); over.set(JPEG);
  const res = await putImage(env, pp.id, over);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, 'too_large');
  assert.equal(one(env, 'SELECT image_type FROM platform_products').image_type, 'image/png', 'the old image stays');
  assert.equal((await putImage(env, 'nope', PNG)).status, 404);
  assert.equal((await call(env, '/api/operator/products/nope/image', { method: 'DELETE', token: OP })).status, 404);
  // the photographer cannot upload one
  assert.equal((await putImage(env, pp.id, JPEG, { token: SECRET })).status, 401);
  assert.equal(one(env, 'SELECT image_type FROM platform_products').image_type, 'image/png');
});

test('image: the public route answers GET only, and nothing else under /api/platform/', async () => {
  const env = envOp();
  const pp = await platformProduct(env);
  await putImage(env, pp.id, PNG);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    for (const token of [undefined, SECRET, OP]) {
      assert.equal((await call(env, `/api/platform/products/${pp.id}/image`, { method, token, body: 'x' })).status, 405, `${method} ${token}`);
    }
  }
  for (const path of ['/api/platform', '/api/platform/products', `/api/platform/products/${pp.id}`, `/api/platform/products/${pp.id}/image/x`, '/api/platform/nope']) {
    for (const method of ['GET', 'PUT']) {
      assert.equal((await call(env, path, { method, token: SECRET, body: method === 'GET' ? undefined : 'x' })).status, 404, `${method} ${path}`);
    }
  }
  assert.equal([...env.imagepicker._store.keys()].filter(k => k.startsWith('api/')).length, 0, 'nothing fell through to the upload route');
  assert.equal((await getImage(env, 'nope')).status, 404);
  // a hand-edited row that is not an image is not served
  env.DB._db.prepare("UPDATE platform_products SET image = ?, image_type = 'image/svg+xml'").run(text('<svg/>'));
  assert.equal((await getImage(env, pp.id)).status, 404);
  // a photographer's own products table image columns are not this route
  env.DB._db.prepare("INSERT INTO products (id, photographer_id, kind, name, image, image_type, image_updated_at, created_at, updated_at) VALUES ('p1', 'default', 'service', 'x', ?, 'image/png', 'a', 'a', 'a')").run(PNG);
  assert.equal((await getImage(env, 'p1')).status, 404);
});

// ─── the migration ───────────────────────────────────────────────────────────

test('the migration carries the platform tables and link columns, is re-runnable, and matches schema.sql', () => {
  const fresh = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/2026-09-29-products-orders.sql', import.meta.url), 'utf8');
  const statements = migration.replace(/--[^\n]*/g, '').split(';').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
  for (const s of statements) assert.match(s, /^CREATE (TABLE|INDEX) IF NOT EXISTS /, s.slice(0, 60));
  const TABLES = ['platform_products', 'platform_product_options', 'products', 'product_options', 'orders', 'order_items'];
  for (const t of TABLES) assert.ok(statements.some(s => s.startsWith(`CREATE TABLE IF NOT EXISTS ${t} `)), t);
  const deployed = fresh.replace(/\n-- ─── Products and orders[\s\S]*$/, '\n');
  assert.doesNotMatch(deployed, /platform_products|order_items/, 'fixture still has the new schema');
  assert.match(deployed, /studio_settings/, 'fixture cut too much');
  const shape = db => TABLES.map(t => [
    db._db.prepare(`PRAGMA table_info(${t})`).all(),
    db._db.prepare(`PRAGMA index_list(${t})`).all().map(i => i.name).sort(),
  ]);
  // platform_products.min_pages / max_pages / bleed_mm come from their own later migrations on top
  const minPages = readFileSync(new URL('../migrations/2026-10-06-product-min-pages.sql', import.meta.url), 'utf8');
  const maxPages = readFileSync(new URL('../migrations/2026-10-06-product-max-pages.sql', import.meta.url), 'utf8');
  const bleed = readFileSync(new URL('../migrations/2026-10-07-product-bleed.sql', import.meta.url), 'utf8');
  assert.deepEqual(shape(fakeDB({ schema: deployed + '\n' + migration + '\n' + minPages + '\n' + maxPages + '\n' + bleed })), shape(fakeDB({ schema: fresh })));
  const migrated = fakeDB({ schema: deployed + '\n' + migration });
  const cols = t => migrated._db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  assert.ok(cols('products').includes('platform_product_id'));
  assert.ok(cols('product_options').includes('platform_option_id'));
  assert.ok(cols('order_items').includes('platform_option_id'));
  const vc = migrated._db.prepare('PRAGMA table_info(order_items)').all().find(c => c.name === 'vendor_cost');
  assert.deepEqual([vc.type, vc.notnull, vc.dflt_value], ['INTEGER', 1, '0']);
  assert.ok(shape(migrated).every(([c]) => c.length > 0));
  assert.throws(() => migrated._db.prepare("INSERT INTO platform_product_options (id, platform_product_id, label, vendor_cost, platform_price) VALUES ('x', 'y', '', -1, 0)").run(), /CHECK/);
  assert.throws(() => migrated._db.prepare("INSERT INTO platform_products (id, kind, name, created_at, updated_at) VALUES ('x', 'service', 'n', 'a', 'a')").run(), /CHECK/);
  migrated._db.exec(migration); // safe to paste twice
});
