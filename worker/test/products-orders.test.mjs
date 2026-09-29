// Products, orders, the automatic extra-pick order and the revenue stats
// (docs/products-orders.md, Phase A). Money is integer NT$; every price, cost,
// name and kind on a line comes from the catalogue, never from the body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDB } from './fakes.mjs';
import {
  SECRET, MINE, setup, call, pick, createProject, claimed, save, one, rows, seedToken, days,
  collectingCtx,
} from './pick-helpers.mjs';

const A = `${MINE}a.jpg`;
const B = `${MINE}b.jpg`;
const C = `${MINE}c.jpg`;
const D = `${MINE}sub/d.jpg`;

const api = (env, method, path, body, token = SECRET) => call(env, path, { method, token, body });
const json = async res => res.json();

async function newProduct(env, body = {}) {
  const res = await api(env, 'POST', '/api/admin/products', {
    kind: 'print', name: '無框畫', options: [{ label: '16×20', price: 3000, cost: 1200 }], ...body,
  });
  if (res.status !== 201) throw new Error(`newProduct: ${res.status} ${await res.text()}`);
  return (await res.json()).product;
}

async function newOrder(env, projectId, body) {
  const res = await api(env, 'POST', `/api/admin/projects/${projectId}/orders`, body);
  if (res.status !== 201) throw new Error(`newOrder: ${res.status} ${await res.text()}`);
  return (await res.json()).order;
}

const projectOrders = async (env, id) => json(await api(env, 'GET', `/api/admin/projects/${id}/orders`));
const startRetouch = (env, id) => api(env, 'POST', `/api/admin/projects/${id}/start-retouch`);
const reopen = (env, id) => api(env, 'POST', `/api/admin/projects/${id}/reopen`);
const payment = (env, id, body) => api(env, 'POST', `/api/admin/orders/${id}/payment`, body);
const status = (env, id, s) => api(env, 'POST', `/api/admin/orders/${id}/status`, { status: s });
const putOrder = (env, id, body) => api(env, 'PUT', `/api/admin/orders/${id}`, body);
const stats = env => api(env, 'GET', '/api/admin/stats');

// everything the new tables hold, for "nothing was written" checks
const snapshot = env => JSON.stringify(['products', 'product_options', 'orders', 'order_items', 'projects']
  .map(t => rows(env, `SELECT * FROM ${t} ORDER BY rowid`)));

let seq = 0;
// A submission row as the submit route would write it, and the project moved
// to 'submitted' the way that route moves it.
function seedSubmission(env, projectId, { count, pick_limit = 40, extra_price = 200 } = {}) {
  env.DB._db.prepare(
    "INSERT INTO submissions (id, project_id, picker_id, relationship, photo_keys, count, pick_limit, extra_price, created_at) VALUES (?, ?, 'x', '本人', '[]', ?, ?, ?, ?)"
  ).run(`sub${++seq}`, projectId, count, pick_limit, extra_price, new Date(Date.now() + seq).toISOString());
  env.DB._db.prepare("UPDATE projects SET phase = 'submitted' WHERE id = ?").run(projectId);
}

// another photographer's project, product (with an option) and order
function seedOther(env) {
  const at = days(0);
  env.DB._db.prepare("INSERT INTO projects (id, title, folders, created_at, photographer_id) VALUES ('op', 'theirs', ?, ?, 'other')")
    .run(JSON.stringify([MINE]), at);
  env.DB._db.prepare("INSERT INTO products (id, photographer_id, kind, name, created_at, updated_at) VALUES ('oprod', 'other', 'print', 'theirs', ?, ?)").run(at, at);
  env.DB._db.prepare("INSERT INTO product_options (id, product_id, label, price, cost) VALUES ('oopt', 'oprod', '', 100, 10)").run();
  env.DB._db.prepare("INSERT INTO orders (id, photographer_id, project_id, source, created_at, updated_at) VALUES ('oord', 'other', 'op', 'admin', ?, ?)").run(at, at);
  env.DB._db.prepare("INSERT INTO order_items (id, order_id, kind, name, unit_price, qty) VALUES ('oitem', 'oord', 'print', 'theirs', 100, 1)").run();
}

// ─── products ────────────────────────────────────────────────────────────────

test('products: create with options, list them back without the image blob', async () => {
  const env = setup();
  const res = await api(env, 'POST', '/api/admin/products', {
    kind: 'album', name: '  相本書  ', description: '20 頁', photo_count: 20, guest_visible: true,
    options: [{ label: '20×20', price: 8000, cost: 3000 }, { label: '30×30', price: 12000 }],
    photographer_id: 'other', id: 'mine', active: 0,
  });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const { product } = await res.json();
  assert.equal(product.name, '相本書');
  assert.equal(product.kind, 'album');
  assert.equal(product.photo_count, 20);
  assert.equal(product.guest_visible, 1);
  assert.equal(product.active, 1, 'active is not taken from the body');
  assert.notEqual(product.id, 'mine');
  assert.equal(product.has_image, false);
  assert.ok(!('image' in product));
  assert.deepEqual(product.options.map(o => [o.label, o.price, o.cost, o.active, o.sort]),
    [['20×20', 8000, 3000, 1, 0], ['30×30', 12000, 0, 1, 1]]);
  assert.equal(one(env, 'SELECT photographer_id FROM products').photographer_id, 'default');
  const list = await api(env, 'GET', '/api/admin/products');
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual((await list.json()).products, [product]);
});

test('products: photo_count only sticks to albums', async () => {
  const env = setup();
  const p = await newProduct(env, { kind: 'print', photo_count: 5 });
  assert.equal(p.photo_count, null);
  const a = await newProduct(env, { kind: 'album', photo_count: 5 });
  assert.equal(a.photo_count, 5);
  const res = await api(env, 'PUT', `/api/admin/products/${a.id}`, { kind: 'service' });
  assert.equal((await res.json()).product.photo_count, null);
});

test('products: validation is 400 with a code, and nothing is written', async () => {
  const env = setup();
  const existing = await newProduct(env);
  const good = { kind: 'print', name: 'x', options: [{ label: '', price: 1 }] };
  const cases = [
    [{ ...good, kind: 'extra_pick' }, 'invalid_kind'],
    [{ ...good, kind: undefined }, 'invalid_kind'],
    [{ ...good, name: '' }, 'invalid_name'],
    [{ ...good, name: '   ' }, 'invalid_name'],
    [{ ...good, name: 'x'.repeat(61) }, 'invalid_name'],
    [{ ...good, name: 'a\nb' }, 'invalid_name'],
    [{ ...good, name: 5 }, 'invalid_name'],
    [{ ...good, description: 'x'.repeat(501) }, 'invalid_description'],
    [{ ...good, description: 5 }, 'invalid_description'],
    [{ ...good, photo_count: 0 }, 'invalid_photo_count'],
    [{ ...good, photo_count: 1.5 }, 'invalid_photo_count'],
    [{ ...good, guest_visible: 'yes' }, 'invalid_guest_visible'],
    [{ ...good, sort: -1 }, 'invalid_sort'],
    [{ ...good, options: [] }, 'invalid_options'],
    [{ ...good, options: undefined }, 'invalid_options'],
    [{ ...good, options: 'x' }, 'invalid_options'],
    [{ ...good, options: Array.from({ length: 21 }, () => ({ price: 1 })) }, 'invalid_options'],
    [{ ...good, options: [null] }, 'invalid_options'],
    [{ ...good, options: [{ label: 'x'.repeat(61), price: 1 }] }, 'invalid_label'],
    [{ ...good, options: [{ label: 'a\tb', price: 1 }] }, 'invalid_label'],
    [{ ...good, options: [{ label: '', price: -1 }] }, 'invalid_price'],
    [{ ...good, options: [{ label: '', price: 1.5 }] }, 'invalid_price'],
    [{ ...good, options: [{ label: '', price: '100' }] }, 'invalid_price'],
    [{ ...good, options: [{ label: '', price: 10_000_001 }] }, 'invalid_price'],
    [{ ...good, options: [{ label: '', price: 1, cost: -1 }] }, 'invalid_cost'],
    [{ ...good, options: [{ label: '', price: 1, cost: 2 ** 53 }] }, 'invalid_cost'],
    [{ ...good, options: [{ id: existing.options[0].id, label: '', price: 1 }] }, 'invalid_options'],
  ];
  const before = snapshot(env);
  for (const [body, code] of cases) {
    const res = await api(env, 'POST', '/api/admin/products', body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal((await res.json()).code, code, JSON.stringify(body).slice(0, 80));
  }
  for (const body of ['[]', 'null', 'nope', '5']) {
    assert.equal((await api(env, 'POST', '/api/admin/products', body)).status, 400, body);
  }
  assert.equal(snapshot(env), before);
  // the boundaries are accepted
  const edge = await newProduct(env, {
    name: 'x'.repeat(60), description: 'y'.repeat(500),
    options: Array.from({ length: 20 }, (_, i) => ({ label: 'z'.repeat(60), price: i ? 10_000_000 : 0, cost: 0 })),
  });
  assert.equal(edge.options.length, 20);
});

test('products: PUT changes the fields present; options are replaced as a set, missing ones retired', async () => {
  const env = setup();
  const p = await newProduct(env, {
    description: 'keep me', options: [{ label: 'S', price: 100, cost: 10 }, { label: 'M', price: 200, cost: 20 }],
  });
  const [s, m] = p.options;
  const res = await api(env, 'PUT', `/api/admin/products/${p.id}`, {
    name: '畫布', options: [{ id: m.id, label: 'M2', price: 250, cost: 25 }, { label: 'L', price: 300 }],
    photographer_id: 'other', active: 0,
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const { product } = await res.json();
  assert.equal(product.name, '畫布');
  assert.equal(product.description, 'keep me');
  assert.equal(product.kind, 'print');
  assert.equal(product.active, 1);
  const byId = Object.fromEntries(product.options.map(o => [o.id, o]));
  assert.deepEqual([byId[m.id].label, byId[m.id].price, byId[m.id].cost, byId[m.id].active, byId[m.id].sort], ['M2', 250, 25, 1, 0]);
  assert.equal(byId[s.id].active, 0, 'missing option retired, not deleted');
  assert.equal(byId[s.id].price, 100);
  const added = product.options.find(o => o.label === 'L');
  assert.deepEqual([added.active, added.sort, added.cost], [1, 1, 0]);
  assert.equal(rows(env, 'SELECT * FROM product_options').length, 3);
  assert.equal(one(env, 'SELECT photographer_id FROM products').photographer_id, 'default');
  // a retired option comes back by naming its id
  const back = await json(await api(env, 'PUT', `/api/admin/products/${p.id}`, { options: [{ id: s.id, label: 'S', price: 100 }] }));
  assert.deepEqual(back.product.options.filter(o => o.active).map(o => o.id), [s.id]);
  // fields left out keep their values
  const same = await json(await api(env, 'PUT', `/api/admin/products/${p.id}`, {}));
  assert.equal(same.product.name, '畫布');
  assert.equal(same.product.options.length, 3);
});

test('products: PUT refuses an option id of another product, unknown ids and bad fields, writing nothing', async () => {
  const env = setup();
  seedOther(env);
  const p = await newProduct(env);
  const q = await newProduct(env, { name: '另一個' });
  const before = snapshot(env);
  for (const [body, code] of [
    [{ options: [{ id: q.options[0].id, label: '', price: 1 }] }, 'invalid_options'],
    [{ options: [{ id: 'oopt', label: '', price: 1 }] }, 'invalid_options'],
    [{ options: [{ id: 'nope', label: '', price: 1 }] }, 'invalid_options'],
    [{ options: [{ id: p.options[0].id, label: '', price: 1 }, { id: p.options[0].id, label: '', price: 1 }] }, 'invalid_options'],
    [{ options: [] }, 'invalid_options'],
    [{ name: '' }, 'invalid_name'],
    [{ kind: 'extra_pick' }, 'invalid_kind'],
    [{ name: 'ok', options: [{ label: '', price: -5 }] }, 'invalid_price'],
  ]) {
    const res = await api(env, 'PUT', `/api/admin/products/${p.id}`, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).code, code, JSON.stringify(body));
  }
  assert.equal(snapshot(env), before);
});

test('products: retire and restore; another photographer\'s product is 404 and not listed', async () => {
  const env = setup();
  seedOther(env);
  const p = await newProduct(env);
  let res = await api(env, 'POST', `/api/admin/products/${p.id}/retire`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, active: 0 });
  let list = (await json(await api(env, 'GET', '/api/admin/products'))).products;
  assert.deepEqual(list.map(x => [x.id, x.active]), [[p.id, 0]], 'retired is still listed, flagged; theirs is not');
  res = await api(env, 'POST', `/api/admin/products/${p.id}/restore`);
  assert.deepEqual(await res.json(), { ok: true, active: 1 });
  assert.equal(one(env, 'SELECT active FROM products WHERE id = ?', p.id).active, 1);
  const before = snapshot(env);
  for (const [method, path, body] of [
    ['POST', '/api/admin/products/oprod/retire'],
    ['POST', '/api/admin/products/oprod/restore'],
    ['PUT', '/api/admin/products/oprod', { name: 'mine now' }],
    ['POST', '/api/admin/products/nope/retire'],
    ['PUT', '/api/admin/products/nope', { name: 'x' }],
  ]) assert.equal((await api(env, method, path, body)).status, 404, `${method} ${path}`);
  assert.equal(snapshot(env), before);
});

// ─── orders: create ──────────────────────────────────────────────────────────

test('orders: price, cost, name and kind come from the catalogue; unit_price is the one override', async () => {
  const env = setup();
  const { project } = await createProject(env);
  const print = await newProduct(env);
  const service = await newProduct(env, { kind: 'service', name: '急件', options: [{ label: '', price: 500, cost: 0 }] });
  const res = await api(env, 'POST', `/api/admin/projects/${project.id}/orders`, {
    lines: [
      { option_id: print.options[0].id, qty: 2, photo_keys: [A, B], name: 'free', unit_cost: 0, kind: 'service', product_id: 'x' },
      { option_id: service.options[0].id, qty: 1, unit_price: 300 },
    ],
    discount: 100, note: '  電話訂  ', source: 'system', status: 'fulfilled', paid_amount: 999, photographer_id: 'other',
  });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const { order } = await res.json();
  assert.equal(order.project_id, project.id);
  assert.equal(order.project_title, '王先生 婚紗');
  assert.equal(order.source, 'admin');
  assert.equal(order.status, 'confirmed');
  assert.match(order.confirmed_at, /^\d{4}-/);
  assert.equal(order.paid_amount, 0);
  assert.equal(order.note, '電話訂');
  assert.deepEqual(order.items.map(i => [i.kind, i.product_id, i.option_id, i.name, i.option_label, i.unit_price, i.unit_cost, i.qty, i.photo_keys]), [
    ['print', print.id, print.options[0].id, '無框畫', '16×20', 3000, 1200, 2, [A, B]],
    ['service', service.id, service.options[0].id, '急件', '', 300, 0, 1, []],
  ]);
  // 2 × 3000 + 300 − 100
  assert.deepEqual([order.subtotal, order.discount, order.total, order.cost, order.outstanding], [6300, 100, 6200, 2400, 6200]);
  assert.equal(one(env, 'SELECT photographer_id FROM orders').photographer_id, 'default');
  assert.equal(one(env, "SELECT photo_keys FROM order_items WHERE kind = 'print'").photo_keys, JSON.stringify([A, B]));
});

test('orders: the line snapshot survives catalogue edits and retirement', async () => {
  const env = setup();
  const { project } = await createProject(env);
  const p = await newProduct(env);
  const order = await newOrder(env, project.id, { lines: [{ option_id: p.options[0].id, qty: 1 }] });
  await api(env, 'PUT', `/api/admin/products/${p.id}`, { name: '改名', options: [{ id: p.options[0].id, label: '改', price: 1, cost: 1 }] });
  await api(env, 'POST', `/api/admin/products/${p.id}/retire`);
  const [read] = (await projectOrders(env, project.id)).orders;
  assert.equal(read.id, order.id);
  assert.deepEqual([read.items[0].name, read.items[0].option_label, read.items[0].unit_price, read.items[0].unit_cost], ['無框畫', '16×20', 3000, 1200]);
  assert.equal(read.total, 3000);
  // and an edit that keeps the line keeps the snapshot, retired or not
  const res = await putOrder(env, order.id, { lines: [{ id: read.items[0].id, qty: 3 }] });
  assert.equal(res.status, 200);
  const edited = (await res.json()).order;
  assert.deepEqual([edited.items[0].name, edited.items[0].unit_price, edited.items[0].qty], ['無框畫', 3000, 3]);
  assert.equal(edited.total, 9000);
});

test('orders: a retired option or product cannot go on a new line', async () => {
  const env = setup();
  const { project } = await createProject(env);
  const p = await newProduct(env, { options: [{ label: 'S', price: 100 }, { label: 'M', price: 200 }] });
  const [s, m] = p.options;
  await api(env, 'PUT', `/api/admin/products/${p.id}`, { options: [{ id: m.id, label: 'M', price: 200 }] });
  const order = await newOrder(env, project.id, { lines: [{ option_id: m.id, qty: 1 }] });
  const before = snapshot(env);
  let res = await api(env, 'POST', `/api/admin/projects/${project.id}/orders`, { lines: [{ option_id: s.id, qty: 1 }] });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'retired_option');
  res = await putOrder(env, order.id, { lines: [{ id: order.items[0].id }, { option_id: s.id, qty: 1 }] });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'retired_option');
  await api(env, 'POST', `/api/admin/products/${p.id}/retire`);
  const after = snapshot(env);
  res = await api(env, 'POST', `/api/admin/projects/${project.id}/orders`, { lines: [{ option_id: m.id, qty: 1 }] });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'retired_option');
  assert.equal(snapshot(env), after);
  assert.notEqual(before, after); // the retire itself did write
  // restored, it sells again
  await api(env, 'POST', `/api/admin/products/${p.id}/restore`);
  assert.equal((await api(env, 'POST', `/api/admin/projects/${project.id}/orders`, { lines: [{ option_id: m.id, qty: 1 }] })).status, 201);
});

test('orders: line and order validation is 400 with a code, and nothing is written', async () => {
  const env = setup();
  seedOther(env);
  const { project } = await createProject(env);
  const print = await newProduct(env);
  const album = await newProduct(env, { kind: 'album', name: '相本', photo_count: 2, options: [{ label: '', price: 5000 }] });
  const service = await newProduct(env, { kind: 'service', name: '加修', options: [{ label: '', price: 300 }] });
  const P = print.options[0].id;
  const line = (extra = {}) => ({ option_id: P, qty: 1, ...extra });
  const cases = [
    [{}, 'invalid_lines'],
    [{ lines: [] }, 'invalid_lines'],
    [{ lines: 'x' }, 'invalid_lines'],
    [{ lines: [null] }, 'invalid_lines'],
    [{ lines: [[]] }, 'invalid_lines'],
    [{ lines: Array.from({ length: 51 }, () => line()) }, 'too_many_lines'],
    [{ lines: [line({ qty: 0 })] }, 'invalid_qty'],
    [{ lines: [line({ qty: 1000 })] }, 'invalid_qty'],
    [{ lines: [line({ qty: 1.5 })] }, 'invalid_qty'],
    [{ lines: [line({ qty: '1' })] }, 'invalid_qty'],
    [{ lines: [line({ qty: undefined })] }, 'invalid_qty'],
    [{ lines: [line({ option_id: undefined })] }, 'unknown_option'],
    [{ lines: [line({ option_id: 'nope' })] }, 'unknown_option'],
    [{ lines: [line({ option_id: 'oopt' })] }, 'unknown_option'],
    [{ lines: [line({ option_id: 5 })] }, 'unknown_option'],
    [{ lines: [line({ id: 'nope' })] }, 'unknown_line'],
    [{ lines: [line({ unit_price: -1 })] }, 'invalid_unit_price'],
    [{ lines: [line({ unit_price: 1.5 })] }, 'invalid_unit_price'],
    [{ lines: [line({ unit_price: '5' })] }, 'invalid_unit_price'],
    [{ lines: [line({ unit_price: 10_000_001 })] }, 'invalid_unit_price'],
    [{ lines: [line({ photo_keys: 'x' })] }, 'invalid_photo_keys'],
    [{ lines: [line({ photo_keys: [5] })] }, 'invalid_photo_keys'],
    [{ lines: [line({ photo_keys: [A, B] })] }, 'invalid_photo_keys'], // print: at most one per unit
    [{ lines: [line({ qty: 2, photo_keys: [A, A] })] }, 'invalid_photo_keys'],
    [{ lines: [line({ photo_keys: [`${MINE}`] })] }, 'invalid_photo_keys'],
    [{ lines: [line({ photo_keys: ['x'.repeat(257)] })] }, 'invalid_photo_keys'],
    [{ lines: [line({ photo_keys: [`${MINE}a\n.jpg`] })] }, 'invalid_photo_keys'],
    [{ lines: [line({ photo_keys: ['20260819-other/secret.jpg'] })] }, 'photo_not_in_project'],
    [{ lines: [line({ photo_keys: ['20260901/x.jpg'] })] }, 'photo_not_in_project'],
    [{ lines: [line({ photo_keys: ['_books/b1.json'] })] }, 'photo_not_in_project'],
    [{ lines: [line({ photo_keys: [`${MINE}../20260901/x.jpg`] })] }, 'photo_not_in_project'],
    [{ lines: [{ option_id: service.options[0].id, qty: 1, photo_keys: [A] }] }, 'invalid_photo_keys'],
    [{ lines: [{ option_id: album.options[0].id, qty: 1, photo_keys: Array.from({ length: 501 }, (_, i) => `${MINE}${i}.jpg`) }] }, 'invalid_photo_keys'],
    [{ lines: [line()], discount: 3001 }, 'discount_exceeds_subtotal'],
    [{ lines: [line()], discount: -1 }, 'invalid_discount'],
    [{ lines: [line()], discount: 1.5 }, 'invalid_discount'],
    [{ lines: [line()], note: 'x'.repeat(501) }, 'invalid_note'],
    [{ lines: [line()], note: 5 }, 'invalid_note'],
  ];
  const before = snapshot(env);
  for (const [body, code] of cases) {
    const res = await api(env, 'POST', `/api/admin/projects/${project.id}/orders`, body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 100));
    assert.equal((await res.json()).code, code, JSON.stringify(body).slice(0, 100));
  }
  for (const body of ['[]', 'null', 'nope']) {
    assert.equal((await api(env, 'POST', `/api/admin/projects/${project.id}/orders`, body)).status, 400, body);
  }
  // more than ORDER_PHOTOS_MAX photo keys across the whole order
  const many = Array.from({ length: 3 }, (_, n) => ({
    option_id: album.options[0].id, qty: 1, photo_keys: Array.from({ length: 400 }, (_, i) => `${MINE}${n}-${i}.jpg`),
  }));
  const res = await api(env, 'POST', `/api/admin/projects/${project.id}/orders`, { lines: many });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'invalid_photo_keys');
  assert.equal(snapshot(env), before);
  // the boundaries are accepted: 50 lines, qty 999, discount = subtotal,
  // 500-char note, a photo in a subfolder, an album off its advisory count
  const ok = await newOrder(env, project.id, {
    lines: [
      ...Array.from({ length: 48 }, () => line()),
      { option_id: P, qty: 999, photo_keys: [D] },
      { option_id: album.options[0].id, qty: 1, photo_keys: [A, B, C] },
    ],
    note: 'n'.repeat(500),
  });
  assert.equal(ok.items.length, 50);
  assert.equal(ok.subtotal, 48 * 3000 + 999 * 3000 + 5000);
  const full = await newOrder(env, project.id, { lines: [line()], discount: 3000 });
  assert.equal(full.total, 0);
});

test('orders: another photographer\'s project or order is 404 everywhere, and untouched', async () => {
  const env = setup();
  seedOther(env);
  const p = await newProduct(env);
  const { project } = await createProject(env);
  const mine = await newOrder(env, project.id, { lines: [{ option_id: p.options[0].id, qty: 1 }] });
  // an order row that says 'default' but whose project is theirs
  env.DB._db.prepare("INSERT INTO orders (id, photographer_id, project_id, source, created_at, updated_at) VALUES ('mixed', 'default', 'op', 'admin', ?, ?)").run(days(0), days(0));
  const before = snapshot(env);
  const line = { lines: [{ option_id: p.options[0].id, qty: 1 }] };
  for (const [method, path, body] of [
    ['GET', '/api/admin/projects/op/orders'],
    ['POST', '/api/admin/projects/op/orders', line],
    ['GET', '/api/admin/projects/nope/orders'],
    ['POST', '/api/admin/projects/nope/orders', line],
    ...['oord', 'mixed', 'nope'].flatMap(id => [
      ['PUT', `/api/admin/orders/${id}`, { note: 'x' }],
      ['POST', `/api/admin/orders/${id}/payment`, { paid_amount: 0 }],
      ['POST', `/api/admin/orders/${id}/status`, { status: 'cancelled' }],
    ]),
  ]) assert.equal((await api(env, method, path, body)).status, 404, `${method} ${path}`);
  assert.equal(snapshot(env), before);
  const all = (await json(await api(env, 'GET', '/api/admin/orders'))).orders;
  assert.deepEqual(all.map(o => o.id), [mine.id]);
});

test('orders: an archived project still reads and still records a sale', async () => {
  const env = setup();
  const p = await newProduct(env);
  const { project } = await createProject(env);
  const first = await newOrder(env, project.id, { lines: [{ option_id: p.options[0].id, qty: 1 }] });
  assert.equal((await api(env, 'POST', `/api/admin/projects/${project.id}/archive`)).status, 200);
  assert.deepEqual((await projectOrders(env, project.id)).orders.map(o => o.id), [first.id]);
  const late = await newOrder(env, project.id, { lines: [{ option_id: p.options[0].id, qty: 1 }] });
  assert.equal((await projectOrders(env, project.id)).orders.length, 2);
  assert.equal((await payment(env, late.id, { paid_amount: 3000, paid_method: 'cash' })).status, 200);
});

// ─── orders: edit ────────────────────────────────────────────────────────────

test('orders: PUT edits discount, note and lines; kept lines keep their snapshot, missing ones go', async () => {
  const env = setup();
  const { project } = await createProject(env);
  const p = await newProduct(env);
  const q = await newProduct(env, { kind: 'album', name: '相本', options: [{ label: '', price: 5000, cost: 2000 }] });
  const order = await newOrder(env, project.id, {
    lines: [{ option_id: p.options[0].id, qty: 1, photo_keys: [A] }, { option_id: p.options[0].id, qty: 1 }],
  });
  const [keep, drop] = order.items;
  const res = await putOrder(env, order.id, {
    discount: 500, note: '改',
    lines: [
      { id: keep.id, qty: 2, photo_keys: [A, B], unit_price: 2500, name: 'hacked', unit_cost: 0 },
      { option_id: q.options[0].id, qty: 1, photo_keys: [C, D] },
    ],
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const edited = (await res.json()).order;
  assert.equal(edited.source, 'admin');
  assert.equal(edited.note, '改');
  assert.equal(edited.discount, 500);
  const byId = Object.fromEntries(edited.items.map(i => [i.id, i]));
  assert.ok(!byId[drop.id], 'a line left out is removed');
  assert.deepEqual([byId[keep.id].name, byId[keep.id].unit_price, byId[keep.id].unit_cost, byId[keep.id].qty, byId[keep.id].photo_keys],
    ['無框畫', 2500, 1200, 2, [A, B]]);
  const added = edited.items.find(i => i.id !== keep.id);
  assert.deepEqual([added.kind, added.name, added.unit_price, added.unit_cost, added.photo_keys], ['album', '相本', 5000, 2000, [C, D]]);
  assert.deepEqual([edited.subtotal, edited.total, edited.cost], [10000, 9500, 4400]);
  assert.equal(rows(env, 'SELECT * FROM order_items').length, 2);
  // fields left out keep their values; unit_price left out keeps the override
  const again = (await json(await putOrder(env, order.id, { note: '再改' }))).order;
  assert.deepEqual([again.discount, again.total, again.items.length], [500, 9500, 2]);
  const kept = (await json(await putOrder(env, order.id, { lines: [{ id: keep.id }] }))).order;
  assert.deepEqual([kept.items[0].unit_price, kept.items[0].qty, kept.items[0].photo_keys, kept.total], [2500, 2, [A, B], 4500]);
});

test('orders: PUT validation is 400 and writes nothing', async () => {
  const env = setup();
  const { project } = await createProject(env);
  const other = await createProject(env);
  const p = await newProduct(env);
  const q = await newProduct(env, { name: '另', options: [{ label: '', price: 100 }] });
  const order = await newOrder(env, project.id, { lines: [{ option_id: p.options[0].id, qty: 1 }] });
  const elsewhere = await newOrder(env, other.project.id, { lines: [{ option_id: p.options[0].id, qty: 1 }] });
  const id = order.items[0].id;
  const before = snapshot(env);
  for (const [body, code] of [
    [{ lines: [] }, 'invalid_lines'],
    [{ lines: [{ id: elsewhere.items[0].id }] }, 'unknown_line'],
    [{ lines: [{ id }, { id }] }, 'unknown_line'],
    [{ lines: [{ id, option_id: q.options[0].id }] }, 'invalid_lines'],
    [{ lines: [{ id, qty: 0 }] }, 'invalid_qty'],
    [{ lines: [{ id, photo_keys: ['20260901/x.jpg'] }] }, 'photo_not_in_project'],
    [{ lines: [{ id, unit_price: -1 }] }, 'invalid_unit_price'],
    [{ discount: 3001 }, 'discount_exceeds_subtotal'],
    [{ note: 'x'.repeat(501) }, 'invalid_note'],
    [{ discount: -1 }, 'invalid_discount'],
  ]) {
    const res = await putOrder(env, order.id, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).code, code, JSON.stringify(body));
  }
  // a discount that fits the old lines but not the new ones
  env.DB._db.prepare('UPDATE orders SET discount = 200 WHERE id = ?').run(order.id);
  const withDiscount = snapshot(env);
  const res = await putOrder(env, order.id, { lines: [{ id, unit_price: 100 }] });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'discount_exceeds_subtotal');
  assert.equal(snapshot(env), withDiscount);
  env.DB._db.prepare('UPDATE orders SET discount = 0 WHERE id = ?').run(order.id);
  assert.equal(snapshot(env), before);
  for (const body of ['[]', 'null', 'nope']) assert.equal((await putOrder(env, order.id, body)).status, 400);
  assert.equal(snapshot(env), before);
});

test('orders: PUT cannot bring the total under what was already paid', async () => {
  const env = setup();
  const { project } = await createProject(env);
  const p = await newProduct(env);
  const order = await newOrder(env, project.id, { lines: [{ option_id: p.options[0].id, qty: 2 }] });
  assert.equal((await payment(env, order.id, { paid_amount: 6000, paid_method: 'transfer' })).status, 200);
  const before = snapshot(env);
  let res = await putOrder(env, order.id, { discount: 1 });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'below_paid');
  res = await putOrder(env, order.id, { lines: [{ id: order.items[0].id, qty: 1 }] });
  assert.equal((await res.json()).code, 'below_paid');
  assert.equal(snapshot(env), before);
  // equal is fine
  assert.equal((await putOrder(env, order.id, { discount: 0, note: 'ok' })).status, 200);
});

test('orders: a cancelled order keeps its lines and discount; its note can still change', async () => {
  const env = setup();
  const { project } = await createProject(env);
  const p = await newProduct(env);
  const order = await newOrder(env, project.id, { lines: [{ option_id: p.options[0].id, qty: 1 }] });
  assert.equal((await status(env, order.id, 'cancelled')).status, 200);
  const before = snapshot(env);
  for (const body of [{ discount: 1 }, { lines: [{ id: order.items[0].id, qty: 2 }] }]) {
    const res = await putOrder(env, order.id, body);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'cancelled');
  }
  assert.equal(snapshot(env), before);
  const res = await putOrder(env, order.id, { note: '客人改期' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).order.note, '客人改期');
});

// an edit that lands after the route read the order and before it writes
function interleave(env, pattern, sql, ...args) {
  const prepare = env.DB.prepare.bind(env.DB);
  const state = { done: false };
  env.DB.prepare = s => {
    if (!state.done && pattern.test(s)) {
      state.done = true;
      env.DB._db.prepare(sql).run(...args);
    }
    return prepare(s);
  };
  return state;
}

test('orders: a PUT that loses a race to another edit is a 409 and writes none of its lines', async () => {
  const env = setup();
  const { project } = await createProject(env);
  const p = await newProduct(env);
  const order = await newOrder(env, project.id, { lines: [{ option_id: p.options[0].id, qty: 1 }, { option_id: p.options[0].id, qty: 1 }] });
  const [keep] = order.items;
  const state = interleave(env, /^UPDATE orders SET discount/, "UPDATE orders SET updated_at = 'elsewhere', note = 'theirs'");
  const res = await putOrder(env, order.id, {
    discount: 100, note: 'mine', lines: [{ id: keep.id, qty: 5 }, { option_id: p.options[0].id, qty: 2 }],
  });
  assert.ok(state.done);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'conflict');
  assert.deepEqual(rows(env, 'SELECT id, qty FROM order_items ORDER BY rowid').map(r => [r.id, r.qty]), order.items.map(i => [i.id, 1]));
  assert.deepEqual({ ...one(env, 'SELECT discount, note FROM orders') }, { discount: 0, note: 'theirs' });
});

test('payment: a cancel landing between the read and the write is a 409, not a paid cancelled order', async () => {
  const env = setup();
  const { project } = await createProject(env);
  const p = await newProduct(env);
  const order = await newOrder(env, project.id, { lines: [{ option_id: p.options[0].id, qty: 1 }] });
  const state = interleave(env, /^UPDATE orders SET paid_amount/, "UPDATE orders SET status = 'cancelled', updated_at = 'elsewhere'");
  const res = await payment(env, order.id, { paid_amount: 3000, paid_method: 'cash' });
  assert.ok(state.done);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'conflict');
  assert.equal(one(env, 'SELECT paid_amount FROM orders').paid_amount, 0);
});

// ─── payment ─────────────────────────────────────────────────────────────────

test('payment: record, then 0 clears paid_at and paid_method', async () => {
  const env = setup();
  const { project } = await createProject(env);
  const p = await newProduct(env);
  const order = await newOrder(env, project.id, { lines: [{ option_id: p.options[0].id, qty: 1 }] });
  let res = await payment(env, order.id, { paid_amount: 1000, paid_method: 'transfer' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  let o = (await res.json()).order;
  assert.deepEqual([o.paid_amount, o.paid_method, o.outstanding, o.total], [1000, 'transfer', 2000, 3000]);
  assert.ok(Math.abs(Date.parse(o.paid_at) - Date.now()) < 60000, 'paid_at defaults to now');
  res = await payment(env, order.id, { paid_amount: 3000, paid_method: 'cash', paid_at: '2026-09-01' });
  o = (await res.json()).order;
  assert.deepEqual([o.paid_amount, o.paid_method, o.paid_at, o.outstanding], [3000, 'cash', '2026-09-01T00:00:00.000Z', 0]);
  res = await payment(env, order.id, { paid_amount: 0, paid_method: 'cash', paid_at: '2026-09-02' });
  assert.equal(res.status, 200);
  o = (await res.json()).order;
  assert.deepEqual([o.paid_amount, o.paid_method, o.paid_at, o.outstanding], [0, null, null, 3000]);
  assert.deepEqual({ ...one(env, 'SELECT paid_amount, paid_method, paid_at, source FROM orders') },
    { paid_amount: 0, paid_method: null, paid_at: null, source: 'admin' });
});

test('payment: validation is 400, overpaying is 400, a cancelled order is 409; nothing written', async () => {
  const env = setup();
  const { project } = await createProject(env);
  const p = await newProduct(env);
  const order = await newOrder(env, project.id, { lines: [{ option_id: p.options[0].id, qty: 1 }], discount: 500 });
  const before = snapshot(env);
  for (const [body, code] of [
    [{}, 'invalid_paid_amount'],
    [{ paid_amount: -1, paid_method: 'cash' }, 'invalid_paid_amount'],
    [{ paid_amount: 1.5, paid_method: 'cash' }, 'invalid_paid_amount'],
    [{ paid_amount: '100', paid_method: 'cash' }, 'invalid_paid_amount'],
    [{ paid_amount: 100 }, 'invalid_paid_method'],
    [{ paid_amount: 100, paid_method: 'card' }, 'invalid_paid_method'],
    [{ paid_amount: 100, paid_method: 'cash', paid_at: 'yesterday' }, 'invalid_paid_at'],
    [{ paid_amount: 100, paid_method: 'cash', paid_at: 5 }, 'invalid_paid_at'],
    [{ paid_amount: 100, paid_method: 'cash', paid_at: days(3) }, 'invalid_paid_at'],
    [{ paid_amount: 100, paid_method: 'cash', paid_at: '1999-12-31' }, 'invalid_paid_at'],
    [{ paid_amount: 2501, paid_method: 'cash' }, 'overpaid'],
  ]) {
    const res = await payment(env, order.id, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).code, code, JSON.stringify(body));
  }
  for (const body of ['[]', 'null', 'nope']) assert.equal((await payment(env, order.id, body)).status, 400);
  assert.equal(snapshot(env), before);
  assert.equal((await payment(env, order.id, { paid_amount: 2500, paid_method: 'other' })).status, 200);
  await payment(env, order.id, { paid_amount: 0 });
  await status(env, order.id, 'cancelled');
  const cancelled = snapshot(env);
  const res = await payment(env, order.id, { paid_amount: 100, paid_method: 'cash' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'cancelled');
  assert.equal(snapshot(env), cancelled);
  // clearing a cancelled order's payment (a refund) is allowed
  assert.equal((await payment(env, order.id, { paid_amount: 0 })).status, 200);
});

// ─── status ──────────────────────────────────────────────────────────────────

test('status: confirmed → fulfilled → confirmed (undo) → cancelled, with stamps', async () => {
  const env = setup();
  const { project } = await createProject(env);
  const p = await newProduct(env);
  const order = await newOrder(env, project.id, { lines: [{ option_id: p.options[0].id, qty: 1 }] });
  let res = await status(env, order.id, 'fulfilled');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  let o = (await res.json()).order;
  assert.equal(o.status, 'fulfilled');
  assert.match(o.fulfilled_at, /^\d{4}-/);
  assert.equal(o.confirmed_at, order.confirmed_at);
  assert.equal(o.outstanding, 3000, 'fulfilled but unpaid still owes');
  o = (await json(await status(env, order.id, 'confirmed'))).order;
  assert.deepEqual([o.status, o.fulfilled_at, o.confirmed_at], ['confirmed', null, order.confirmed_at]);
  o = (await json(await status(env, order.id, 'cancelled'))).order;
  assert.equal(o.status, 'cancelled');
  assert.match(o.cancelled_at, /^\d{4}-/);
  assert.equal(o.outstanding, 0, 'cancelled counts for nothing');
  assert.equal(o.source, 'admin');
});

test('status: only the allowed arrows; 409 otherwise; same status is a no-op; bad value 400', async () => {
  const env = setup();
  const { project } = await createProject(env);
  const p = await newProduct(env);
  const order = await newOrder(env, project.id, { lines: [{ option_id: p.options[0].id, qty: 1 }] });
  const set = s => env.DB._db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(s, order.id);
  const refused = [
    ['confirmed', 'requested'], ['fulfilled', 'requested'], ['requested', 'fulfilled'],
    ['cancelled', 'confirmed'], ['cancelled', 'fulfilled'], ['cancelled', 'requested'],
  ];
  for (const [from, to] of refused) {
    set(from);
    const before = snapshot(env);
    const res = await status(env, order.id, to);
    assert.equal(res.status, 409, `${from} → ${to}`);
    const body = await res.json();
    assert.deepEqual([body.code, body.from, body.to], ['bad_transition', from, to]);
    assert.equal(snapshot(env), before);
  }
  const allowed = [
    ['requested', 'confirmed'], ['requested', 'cancelled'], ['confirmed', 'fulfilled'],
    ['confirmed', 'cancelled'], ['fulfilled', 'confirmed'], ['fulfilled', 'cancelled'],
  ];
  for (const [from, to] of allowed) {
    set(from);
    const res = await status(env, order.id, to);
    assert.equal(res.status, 200, `${from} → ${to}`);
    assert.equal(one(env, 'SELECT status FROM orders').status, to);
  }
  set('confirmed');
  env.DB._db.prepare("UPDATE orders SET updated_at = 'x', source = 'system'").run();
  const res = await status(env, order.id, 'confirmed');
  assert.equal(res.status, 200);
  assert.equal(one(env, 'SELECT updated_at FROM orders').updated_at, 'x', 'no write');
  const before = snapshot(env);
  for (const body of [{ status: 'done' }, {}, { status: null }]) {
    const r = await api(env, 'POST', `/api/admin/orders/${order.id}/status`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal((await r.json()).code, 'invalid_status');
  }
  assert.equal(snapshot(env), before);
});

test('status: a change landing between the read and the write is a 409, not a skipped arrow', async () => {
  const env = setup();
  const { project } = await createProject(env);
  const p = await newProduct(env);
  const order = await newOrder(env, project.id, { lines: [{ option_id: p.options[0].id, qty: 1 }] });
  const prepare = env.DB.prepare.bind(env.DB);
  let done = false;
  env.DB.prepare = s => {
    if (!done && /^UPDATE orders SET status/.test(s)) {
      done = true;
      env.DB._db.prepare("UPDATE orders SET status = 'cancelled'").run();
    }
    return prepare(s);
  };
  const res = await status(env, order.id, 'fulfilled');
  assert.equal(res.status, 409);
  assert.equal(one(env, 'SELECT status FROM orders').status, 'cancelled');
});

// ─── the list across projects ────────────────────────────────────────────────

test('GET /api/admin/orders: every project, filtered by status and unpaid', async () => {
  const env = setup();
  seedOther(env);
  const p = await newProduct(env);
  const one1 = await createProject(env, { title: '甲' });
  const two = await createProject(env, { title: '乙' });
  const line = { lines: [{ option_id: p.options[0].id, qty: 1 }] };
  const a = await newOrder(env, one1.project.id, line);             // unpaid
  const b = await newOrder(env, two.project.id, line);              // paid in full
  const c = await newOrder(env, two.project.id, line);              // part-paid, fulfilled
  const d = await newOrder(env, one1.project.id, line);             // cancelled
  await payment(env, b.id, { paid_amount: 3000, paid_method: 'cash' });
  await payment(env, c.id, { paid_amount: 1000, paid_method: 'cash' });
  await status(env, c.id, 'fulfilled');
  await status(env, d.id, 'cancelled');
  const res = await api(env, 'GET', '/api/admin/orders');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const { orders } = await res.json();
  assert.deepEqual(orders.map(o => o.id).sort(), [a.id, b.id, c.id, d.id].sort());
  const byId = Object.fromEntries(orders.map(o => [o.id, o]));
  assert.equal(byId[a.id].project_title, '甲');
  assert.equal(byId[b.id].project_title, '乙');
  assert.deepEqual([byId[c.id].total, byId[c.id].outstanding], [3000, 2000]);
  assert.deepEqual([byId[b.id].outstanding, byId[d.id].outstanding], [0, 0]);
  assert.equal(byId[a.id].items.length, 1);
  const unpaid = (await json(await api(env, 'GET', '/api/admin/orders?unpaid=1'))).orders;
  assert.deepEqual(unpaid.map(o => o.id).sort(), [a.id, c.id].sort());
  const fulfilled = (await json(await api(env, 'GET', '/api/admin/orders?status=fulfilled'))).orders;
  assert.deepEqual(fulfilled.map(o => o.id), [c.id]);
  const both = (await json(await api(env, 'GET', '/api/admin/orders?status=confirmed&unpaid=1'))).orders;
  assert.deepEqual(both.map(o => o.id), [a.id]);
  assert.equal((await api(env, 'GET', '/api/admin/orders?status=done')).status, 400);
  assert.equal((await json(await api(env, 'GET', '/api/admin/orders?status='))).orders.length, 4);
});

// ─── the automatic extra-pick order ──────────────────────────────────────────

const systemOrders = env => rows(env, "SELECT * FROM orders WHERE source = 'system'");
const extraLine = env => one(env, "SELECT * FROM order_items WHERE kind = 'extra_pick'");

test('extra pick: no submission, no limit, no price, or at/under the limit → no order, fee 0', async () => {
  for (const [setupFn, label] of [
    [(env, id) => { env.DB._db.prepare("UPDATE projects SET phase = 'submitted' WHERE id = ?").run(id); }, 'no submission'],
    [(env, id) => seedSubmission(env, id, { count: 50, pick_limit: null }), 'no limit'],
    [(env, id) => seedSubmission(env, id, { count: 50, extra_price: null }), 'no price'],
    [(env, id) => seedSubmission(env, id, { count: 40 }), 'at the limit'],
    [(env, id) => seedSubmission(env, id, { count: 12 }), 'under the limit'],
    [(env, id) => seedSubmission(env, id, { count: 50, extra_price: 0 }), 'free extras'],
  ]) {
    const env = setup();
    const { project } = await createProject(env);
    setupFn(env, project.id);
    const res = await startRetouch(env, project.id);
    assert.equal(res.status, 200, label);
    assert.equal(one(env, 'SELECT phase FROM projects').phase, 'retouching', label);
    assert.equal(rows(env, 'SELECT * FROM orders').length, 0, label);
    const { extra_pick } = await projectOrders(env, project.id);
    assert.equal(extra_pick.fee, 0, label);
    assert.equal(extra_pick.order_id, null, label);
    assert.equal(extra_pick.matches, true, label);
  }
});

test('extra pick: over the limit → one confirmed system order with one extra_pick line', async () => {
  const env = setup();
  const { project } = await createProject(env);
  seedSubmission(env, project.id, { count: 50, pick_limit: 40, extra_price: 200 });
  const res = await startRetouch(env, project.id);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, phase: 'retouching' });
  const [order] = systemOrders(env);
  assert.deepEqual([order.status, order.photographer_id, order.project_id, order.paid_amount, order.discount],
    ['confirmed', 'default', project.id, 0, 0]);
  assert.ok(order.confirmed_at);
  const line = extraLine(env);
  assert.deepEqual([line.order_id, line.qty, line.unit_price, line.unit_cost, line.product_id, line.option_id, line.photo_keys],
    [order.id, 10, 200, 0, null, null, '[]']);
  const body = await projectOrders(env, project.id);
  assert.deepEqual(body.extra_pick, {
    count: 50, pick_limit: 40, extra_price: 200, extra: 10, fee: 2000, order_id: order.id, order_extra: 10, matches: true,
  });
  assert.equal(body.orders.length, 1);
  assert.deepEqual([body.orders[0].total, body.orders[0].outstanding, body.orders[0].source], [2000, 2000, 'system']);
  // a second press changes nothing
  assert.equal((await startRetouch(env, project.id)).status, 200);
  assert.equal(rows(env, 'SELECT * FROM orders').length, 1);
  assert.equal(rows(env, 'SELECT * FROM order_items').length, 1);
  assert.equal(extraLine(env).qty, 10);
});

test('extra pick: the fee comes from the latest submission\'s snapshot, not the live plan', async () => {
  const env = setup();
  const { project } = await createProject(env);
  seedSubmission(env, project.id, { count: 45, pick_limit: 40, extra_price: 200 });
  seedSubmission(env, project.id, { count: 48, pick_limit: 40, extra_price: 150 });
  env.DB._db.prepare('UPDATE projects SET pick_limit = 1, extra_price = 999').run();
  await startRetouch(env, project.id);
  assert.deepEqual([extraLine(env).qty, extraLine(env).unit_price], [8, 150]);
});

test('extra pick: reopen + resubmit + start-retouch recomputes the unpaid system order in place', async () => {
  const env = setup();
  const p = await claimed(env, { pick_limit: 1, extra_price: 200 });
  const submit = async () => {
    const c = collectingCtx();
    const res = await pick(env, 'POST', 'submit', p.token, { key: p.key, body: { relationship: '本人' } }, c);
    await c.settle();
    assert.equal(res.status, 200);
  };
  await save(env, p.token, p.key, { upsert: [A, B, C].map(k => ({ photo_key: k, rating: 1 })) });
  await submit();
  assert.equal((await startRetouch(env, p.project.id)).status, 200);
  const [first] = systemOrders(env);
  assert.equal(extraLine(env).qty, 2);
  assert.equal((await reopen(env, p.project.id)).status, 200);
  assert.equal(systemOrders(env).length, 1, 'reopen leaves the order alone');
  await save(env, p.token, p.key, { upsert: [{ photo_key: D, rating: 1 }] });
  await submit();
  assert.equal((await startRetouch(env, p.project.id)).status, 200);
  const [again] = systemOrders(env);
  assert.equal(again.id, first.id, 'the same order, rewritten');
  assert.equal(rows(env, 'SELECT * FROM order_items').length, 1);
  assert.deepEqual([extraLine(env).qty, extraLine(env).unit_price], [3, 200]);
  const { extra_pick } = await projectOrders(env, p.project.id);
  assert.deepEqual([extra_pick.count, extra_pick.fee, extra_pick.matches], [4, 600, true]);
});

test('extra pick: when the fee drops to 0 an unpaid system order is removed', async () => {
  const env = setup();
  const { project } = await createProject(env);
  seedSubmission(env, project.id, { count: 50 });
  await startRetouch(env, project.id);
  assert.equal(systemOrders(env).length, 1);
  await reopen(env, project.id);
  seedSubmission(env, project.id, { count: 40 });
  assert.equal((await startRetouch(env, project.id)).status, 200);
  assert.equal(rows(env, 'SELECT * FROM orders').length, 0);
  assert.equal(rows(env, 'SELECT * FROM order_items').length, 0);
  const { extra_pick } = await projectOrders(env, project.id);
  assert.deepEqual([extra_pick.fee, extra_pick.order_id, extra_pick.matches], [0, null, true]);
});

test('extra pick: a paid system order is never rewritten or removed; the mismatch is shown', async () => {
  for (const next of [55, 30]) {
    const env = setup();
    const { project } = await createProject(env);
    seedSubmission(env, project.id, { count: 50 });
    await startRetouch(env, project.id);
    const [order] = systemOrders(env);
    // paid by hand in the D1 console: still 'system', but paid
    env.DB._db.prepare("UPDATE orders SET paid_amount = 2000, paid_at = ?, paid_method = 'cash'").run(days(0));
    await reopen(env, project.id);
    seedSubmission(env, project.id, { count: next });
    const before = snapshot(env).replace(/"phase":"\w+"/g, '');
    assert.equal((await startRetouch(env, project.id)).status, 200);
    assert.equal(snapshot(env).replace(/"phase":"\w+"/g, ''), before, `count ${next}: orders untouched`);
    assert.equal(one(env, 'SELECT phase FROM projects').phase, 'retouching');
    const { extra_pick } = await projectOrders(env, project.id);
    assert.deepEqual([extra_pick.extra, extra_pick.order_id, extra_pick.order_extra, extra_pick.matches],
      [Math.max(0, next - 40), order.id, 10, false], `count ${next}`);
  }
});

test('extra pick: once the photographer edits the order the system stops touching it', async () => {
  for (const edit of [
    (env, o) => putOrder(env, o.id, { note: '已談好' }),
    (env, o) => status(env, o.id, 'fulfilled'),
    (env, o) => status(env, o.id, 'cancelled'),
    (env, o) => payment(env, o.id, { paid_amount: 0 }),
    (env, o) => putOrder(env, o.id, { lines: [{ id: extraLine(env).id, unit_price: 0 }] }), // waived
  ]) {
    const env = setup();
    const { project } = await createProject(env);
    seedSubmission(env, project.id, { count: 50 });
    await startRetouch(env, project.id);
    const [order] = systemOrders(env);
    assert.equal((await edit(env, order)).status, 200);
    assert.equal(one(env, 'SELECT source FROM orders').source, 'admin');
    const before = snapshot(env).replace(/"phase":"\w+"/g, '');
    await reopen(env, project.id);
    seedSubmission(env, project.id, { count: 60 });
    assert.equal((await startRetouch(env, project.id)).status, 200);
    assert.equal(snapshot(env).replace(/"phase":"\w+"/g, ''), before, 'not rewritten, and no second order');
    const { extra_pick } = await projectOrders(env, project.id);
    assert.deepEqual([extra_pick.extra, extra_pick.order_id, extra_pick.order_extra, extra_pick.matches], [20, order.id, 10, false]);
    // and dropping to 0 does not remove it either
    await reopen(env, project.id);
    seedSubmission(env, project.id, { count: 10 });
    await startRetouch(env, project.id);
    assert.equal(rows(env, 'SELECT * FROM orders').length, 1);
  }
});

test('extra pick: the system order never touches another photographer\'s project', async () => {
  const env = setup();
  seedOther(env);
  seedSubmission(env, 'op', { count: 50 });
  const before = snapshot(env);
  assert.equal((await startRetouch(env, 'op')).status, 404);
  assert.equal(snapshot(env), before);
});

test('extra pick: a failing order write leaves the phase where it was', async () => {
  const env = setup();
  const { project } = await createProject(env);
  seedSubmission(env, project.id, { count: 50 });
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = s => {
    const stmt = prepare(s);
    if (!/INSERT INTO order_items/.test(s)) return stmt;
    return { bind: () => ({ run: async () => { throw new Error('D1 down'); } }) };
  };
  await assert.rejects(startRetouch(env, project.id), /D1 down/);
  assert.equal(one(env, 'SELECT phase FROM projects').phase, 'submitted');
  assert.equal(rows(env, 'SELECT * FROM orders').length, 0);
});

test('extra pick: a submit landing between the read and the batch is charged, not the one before it', async () => {
  const env = setup();
  const { project } = await createProject(env);
  seedSubmission(env, project.id, { count: 50 });
  const prepare = env.DB.prepare.bind(env.DB);
  let done = false;
  env.DB.prepare = s => {
    if (!done && /^UPDATE projects SET phase = 'retouching'/.test(s)) {
      done = true;
      seedSubmission(env, project.id, { count: 45 });
    }
    return prepare(s);
  };
  assert.equal((await startRetouch(env, project.id)).status, 200);
  assert.equal(one(env, 'SELECT phase FROM projects').phase, 'retouching');
  assert.equal(extraLine(env).qty, 5);
  assert.equal(rows(env, 'SELECT * FROM orders').length, 1);
});

test('extra pick: a payment landing between the read and the batch still protects the order', async () => {
  const env = setup();
  const { project } = await createProject(env);
  seedSubmission(env, project.id, { count: 50 });
  await startRetouch(env, project.id);
  await reopen(env, project.id);
  seedSubmission(env, project.id, { count: 60 });
  const prepare = env.DB.prepare.bind(env.DB);
  let done = false;
  env.DB.prepare = s => {
    if (!done && /^UPDATE projects SET phase = 'retouching'/.test(s)) {
      done = true;
      env.DB._db.prepare("UPDATE orders SET paid_amount = 2000, paid_at = ?, paid_method = 'cash'").run(days(0));
    }
    return prepare(s);
  };
  assert.equal((await startRetouch(env, project.id)).status, 200);
  assert.ok(done);
  assert.equal(one(env, 'SELECT phase FROM projects').phase, 'retouching');
  assert.equal(extraLine(env).qty, 10, 'the paid line was not rewritten');
  env.DB.prepare = prepare;
  // and the same for a fee that dropped to 0: the paid order is not removed
  await reopen(env, project.id);
  env.DB._db.prepare('UPDATE orders SET paid_amount = 0, paid_at = NULL, paid_method = NULL').run();
  seedSubmission(env, project.id, { count: 10 });
  done = false;
  env.DB.prepare = s => {
    if (!done && /^UPDATE projects SET phase = 'retouching'/.test(s)) {
      done = true;
      env.DB._db.prepare("UPDATE orders SET paid_amount = 2000, paid_at = ?, paid_method = 'cash'").run(days(0));
    }
    return prepare(s);
  };
  assert.equal((await startRetouch(env, project.id)).status, 200);
  assert.equal(rows(env, 'SELECT * FROM orders').length, 1);
  assert.equal(rows(env, 'SELECT * FROM order_items').length, 1);
});

test('start-retouch from picking is still 409 and creates no order', async () => {
  const env = setup();
  const { project } = await createProject(env);
  seedSubmission(env, project.id, { count: 50 });
  env.DB._db.prepare("UPDATE projects SET phase = 'picking'").run();
  const res = await startRetouch(env, project.id);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'not_submitted');
  assert.equal(rows(env, 'SELECT * FROM orders').length, 0);
});

// ─── stats ───────────────────────────────────────────────────────────────────

function monthKey(ms) {
  const d = new Date(ms + 8 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function taipeiMonthStart(back = 0) {
  const d = new Date(Date.now() + 8 * 3600000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - back, 1) - 8 * 3600000;
}

test('stats: revenue by paid_at in Taipei months, cost and margin; outstanding and unpaid to-do', async () => {
  const env = setup();
  seedOther(env);
  const { project } = await createProject(env);
  const p = await newProduct(env); // 3000, cost 1200
  const line = n => ({ lines: [{ option_id: p.options[0].id, qty: n }] });
  const iso = ms => new Date(ms).toISOString();
  const thisStart = taipeiMonthStart(0);
  const paidAt = (o, amount, at) => env.DB._db.prepare("UPDATE orders SET paid_amount = ?, paid_at = ?, paid_method = 'cash' WHERE id = ?").run(amount, at, o.id);
  const a = await newOrder(env, project.id, line(1));   // paid in full, first instant of this month
  const b = await newOrder(env, project.id, line(2));   // part-paid, last instant of last month
  const c = await newOrder(env, project.id, line(1));   // paid, then cancelled: counts for nothing
  const d = await newOrder(env, project.id, line(1));   // paid 13 months ago: out of the window
  const e = await newOrder(env, project.id, { ...line(1), discount: 500 }); // unpaid, fulfilled
  await newOrder(env, project.id, line(1));             // unpaid
  paidAt(a, 3000, iso(thisStart));
  paidAt(b, 1000, iso(thisStart - 1));
  paidAt(c, 3000, iso(thisStart));
  paidAt(d, 3000, iso(taipeiMonthStart(12)));
  env.DB._db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(c.id);
  env.DB._db.prepare("UPDATE orders SET status = 'fulfilled' WHERE id = ?").run(e.id);
  // theirs, paid this month
  env.DB._db.prepare("UPDATE orders SET paid_amount = 100, paid_at = ? WHERE id = 'oord'").run(iso(thisStart));
  // a requested order (Phase B) owes nothing yet
  const r = await newOrder(env, project.id, line(1));
  env.DB._db.prepare("UPDATE orders SET status = 'requested' WHERE id = ?").run(r.id);
  const res = await stats(env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.revenue.length, 12);
  assert.deepEqual(body.revenue.map(m => m.month), body.per_month.map(m => m.month));
  const by = Object.fromEntries(body.revenue.map(m => [m.month, m]));
  assert.deepEqual({ ...by[monthKey(thisStart)] }, { month: monthKey(thisStart), paid: 3000, cost: 1200, margin: 1800 });
  assert.deepEqual({ ...by[monthKey(thisStart - 1)] }, { month: monthKey(thisStart - 1), paid: 1000, cost: 2400, margin: -1400 });
  assert.equal(body.revenue.reduce((n, m) => n + m.paid, 0), 4000);
  // b owes 5000, e owes 2500, the unpaid one 3000; a is settled, c cancelled, d paid
  assert.equal(body.outstanding, 5000 + 2500 + 3000);
  assert.equal(body.todo.unpaid_orders, 3);
  // the existing fields are still there
  assert.deepEqual(Object.keys(body.todo).sort(), ['modified_after_submit', 'submitted_not_retouching', 'unnotified_submissions', 'unpaid_orders']);
  assert.ok(body.by_phase && body.per_month.length === 12);
});

test('stats: an empty studio has twelve zero revenue months and nothing outstanding', async () => {
  const env = setup();
  const body = await (await stats(env)).json();
  assert.equal(body.revenue.length, 12);
  assert.ok(body.revenue.every(m => m.paid === 0 && m.cost === 0 && m.margin === 0));
  assert.equal(body.revenue[11].month, monthKey(Date.now()));
  assert.equal(body.outstanding, 0);
  assert.equal(body.todo.unpaid_orders, 0);
});

// ─── auth, methods, unknown paths ────────────────────────────────────────────

const ROUTES = (project, product, order) => [
  ['GET', '/api/admin/products'],
  ['POST', '/api/admin/products', { kind: 'print', name: 'x', options: [{ price: 1 }] }],
  ['PUT', `/api/admin/products/${product}`, { name: 'x' }],
  ['POST', `/api/admin/products/${product}/retire`],
  ['POST', `/api/admin/products/${product}/restore`],
  ['GET', `/api/admin/projects/${project}/orders`],
  ['POST', `/api/admin/projects/${project}/orders`, { lines: [] }],
  ['GET', '/api/admin/orders'],
  ['PUT', `/api/admin/orders/${order}`, { note: 'x' }],
  ['POST', `/api/admin/orders/${order}/payment`, { paid_amount: 0 }],
  ['POST', `/api/admin/orders/${order}/status`, { status: 'cancelled' }],
];

test('every products/orders route fails closed and refuses every other kind of token', async () => {
  for (const unset of [undefined, '']) {
    const env = setup({ PHOTOGRAPHER_TOKEN: unset });
    for (const [method, path, body] of ROUTES('x', 'x', 'x')) {
      for (const token of [undefined, '', 'undefined']) {
        assert.equal((await call(env, path, { method, body, token })).status, 401, `${method} ${path} unset`);
      }
    }
  }
  const env = setup();
  const p = await claimed(env);
  const prod = await newProduct(env);
  const order = await newOrder(env, p.project.id, { lines: [{ option_id: prod.options[0].id, qty: 1 }] });
  for (const [token, kind] of [['CLIENT', 'client'], ['STUDIO', 'studio'], ['SESSION', 'session']]) {
    await seedToken(env, { token, kind, project_id: p.project.id, book_id: kind === 'client' ? 'b1' : '' });
  }
  const before = snapshot(env);
  for (const [method, path, body] of ROUTES(p.project.id, prod.id, order.id)) {
    for (const token of ['CLIENT', 'STUDIO', 'SESSION', p.token, p.key, `${SECRET}x`]) {
      for (const res of await Promise.all([
        call(env, path, { method, body, token }),
        call(env, `${path}?t=${token}`, { method, body }),
        call(env, path, { method, body, headers: { 'X-Share-Token': token } }),
      ])) assert.equal(res.status, 401, `${method} ${path} ${token}`);
    }
  }
  assert.equal(snapshot(env), before);
  assert.equal([...env.imagepicker._store.keys()].filter(k => k.startsWith('api/')).length, 0, 'nothing fell through to the upload route');
});

test('wrong methods are 405 and unknown paths 404, with the admin token; nothing written', async () => {
  const env = setup();
  const { project } = await createProject(env);
  const prod = await newProduct(env);
  const order = await newOrder(env, project.id, { lines: [{ option_id: prod.options[0].id, qty: 1 }] });
  const before = snapshot(env);
  for (const [path, methods] of [
    ['/api/admin/products', ['PUT', 'DELETE', 'PATCH']],
    [`/api/admin/products/${prod.id}`, ['GET', 'POST', 'DELETE', 'PATCH']],
    [`/api/admin/products/${prod.id}/retire`, ['GET', 'PUT', 'DELETE']],
    [`/api/admin/products/${prod.id}/restore`, ['GET', 'PUT', 'DELETE']],
    [`/api/admin/projects/${project.id}/orders`, ['PUT', 'DELETE', 'PATCH']],
    ['/api/admin/orders', ['POST', 'PUT', 'DELETE']],
    [`/api/admin/orders/${order.id}`, ['GET', 'POST', 'DELETE', 'PATCH']],
    [`/api/admin/orders/${order.id}/payment`, ['GET', 'PUT', 'DELETE']],
    [`/api/admin/orders/${order.id}/status`, ['GET', 'PUT', 'DELETE']],
  ]) {
    for (const method of methods) {
      const res = await call(env, path, { method, token: SECRET, body: method === 'GET' ? undefined : '{}' });
      assert.equal(res.status, 405, `${method} ${path}`);
    }
  }
  for (const [method, path] of [
    ['GET', `/api/admin/orders/${order.id}/export.csv`],
    ['PUT', `/api/admin/products/${prod.id}/image`],
    ['POST', `/api/admin/orders/${order.id}/items`],
    ['PUT', `/api/admin/projects/${project.id}/orders/x`],
  ]) assert.equal((await call(env, path, { method, token: SECRET, body: method === 'GET' ? undefined : '{}' })).status, 404, `${method} ${path}`);
  assert.equal(snapshot(env), before);
  assert.equal([...env.imagepicker._store.keys()].filter(k => k.startsWith('api/')).length, 0, 'nothing fell through to the upload route');
});

// ─── the hand-run migration ──────────────────────────────────────────────────

test('the products/orders migration: re-runnable, and schema.sql == dashboard-era database + it', () => {
  const fresh = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/2026-09-29-products-orders.sql', import.meta.url), 'utf8');
  const statements = migration.replace(/--[^\n]*/g, '').split(';').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
  assert.ok(statements.length >= 4);
  for (const s of statements) assert.match(s, /^CREATE (TABLE|INDEX) IF NOT EXISTS /, s.slice(0, 60));
  for (const t of ['products', 'product_options', 'orders', 'order_items']) {
    assert.ok(statements.some(s => s.startsWith(`CREATE TABLE IF NOT EXISTS ${t} `)), t);
  }
  const deployed = fresh.replace(/\n-- ─── Products and orders[\s\S]*$/, '\n');
  assert.doesNotMatch(deployed, /order_items|product_options/, 'fixture still has the new schema');
  assert.match(deployed, /studio_settings/, 'fixture cut too much');
  const shape = db => ['products', 'product_options', 'orders', 'order_items'].map(t => [
    db._db.prepare(`PRAGMA table_info(${t})`).all(),
    db._db.prepare(`PRAGMA index_list(${t})`).all().map(i => i.name).sort(),
  ]);
  const migrated = fakeDB({ schema: deployed + '\n' + migration });
  assert.deepEqual(shape(migrated), shape(fakeDB({ schema: fresh })));
  assert.ok(shape(migrated).every(([cols]) => cols.length > 0));
  migrated._db.exec(migration); // safe to paste twice
});

// ─── security review ─────────────────────────────────────────────────────────

test('a project with an order is not deleted: 409 has_orders, the order and its payment stay counted', async () => {
  const env = setup();
  const p = await newProduct(env);
  const { project } = await createProject(env);
  const order = await newOrder(env, project.id, { lines: [{ option_id: p.options[0].id, qty: 1 }] });
  assert.equal((await payment(env, order.id, { paid_amount: 3000, paid_method: 'cash' })).status, 200);
  const before = snapshot(env);
  const res = await api(env, 'DELETE', `/api/admin/projects/${project.id}`);
  assert.equal(res.status, 409);
  const out = await res.json();
  assert.equal(out.code, 'has_orders');
  assert.equal(typeof out.error, 'string');
  assert.equal(snapshot(env), before);
  assert.deepEqual((await json(await api(env, 'GET', '/api/admin/orders'))).orders.map(o => o.id), [order.id]);
  assert.equal((await json(await stats(env))).revenue[11].paid, 3000);
});

test('an order landing mid-delete wins: 409 has_orders, the project and the order kept', async () => {
  const env = setup();
  const { project } = await createProject(env);
  const prepare = env.DB.prepare.bind(env.DB);
  let done = false;
  env.DB.prepare = s => {
    if (!done && /^\s*DELETE FROM selections/.test(s)) {
      done = true;
      env.DB._db.prepare("INSERT INTO orders (id, photographer_id, project_id, source, created_at, updated_at) VALUES ('race', 'default', ?, 'admin', ?, ?)")
        .run(project.id, days(0), days(0));
    }
    return prepare(s);
  };
  const res = await api(env, 'DELETE', `/api/admin/projects/${project.id}`);
  assert.ok(done);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'has_orders');
  assert.equal(rows(env, 'SELECT * FROM projects').length, 1);
  assert.equal(rows(env, 'SELECT * FROM orders').length, 1);
});

test('a project with neither submissions nor orders is still deleted', async () => {
  const env = setup();
  const { project } = await createProject(env);
  assert.equal((await api(env, 'DELETE', `/api/admin/projects/${project.id}`)).status, 200);
  assert.equal(rows(env, 'SELECT * FROM projects').length, 0);
});

test('a project\'s extra_price becomes an order unit_price, so it is held to the same money bound', async () => {
  const env = setup();
  for (const extra_price of [1e20, 2 ** 53, 10_000_001]) {
    const res = await api(env, 'POST', '/api/admin/projects', { title: 'x', folders: [MINE], pick_limit: 1, extra_price });
    assert.equal(res.status, 400, String(extra_price));
  }
  for (const pick_limit of [1e20, 2 ** 53]) {
    const res = await api(env, 'POST', '/api/admin/projects', { title: 'x', folders: [MINE], pick_limit, extra_price: 1 });
    assert.equal(res.status, 400, String(pick_limit));
  }
  assert.equal(rows(env, 'SELECT * FROM projects').length, 0);
  const { project } = await createProject(env, { pick_limit: 1, extra_price: 10_000_000 });
  seedSubmission(env, project.id, { count: 3, pick_limit: 1, extra_price: 10_000_000 });
  assert.equal((await startRetouch(env, project.id)).status, 200);
  assert.equal(extraLine(env).unit_price, 10_000_000);
});

test('a PUT cannot adopt another order\'s line (another photographer\'s, or another of mine)', async () => {
  const env = setup();
  seedOther(env);
  const p = await newProduct(env);
  const { project } = await createProject(env);
  const mine = await newOrder(env, project.id, { lines: [{ option_id: p.options[0].id, qty: 1 }] });
  const other = await newOrder(env, project.id, { lines: [{ option_id: p.options[0].id, qty: 2 }] });
  const before = snapshot(env);
  for (const id of ['oitem', other.items[0].id]) {
    const res = await putOrder(env, mine.id, { lines: [{ id: mine.items[0].id }, { id }] });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'unknown_line');
  }
  assert.equal(snapshot(env), before);
  // the positive case: its own line is kept
  assert.equal((await putOrder(env, mine.id, { lines: [{ id: mine.items[0].id, qty: 3 }] })).status, 200);
  assert.equal(one(env, 'SELECT qty FROM order_items WHERE id = ?', mine.items[0].id).qty, 3);
});
