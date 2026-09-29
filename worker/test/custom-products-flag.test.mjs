// The CUSTOM_PRODUCTS switch (docs/products-orders.md, "Platform catalogue
// (A2)"). A photographer's own (non-platform) products are off unless the
// Worker's env says exactly "on": creating one, editing one or putting one
// back on sale is 403 custom_products_disabled. Retiring one, everything about
// adopted products, reads, existing order lines and the automatic extra-pick
// order are untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SECRET, MINE, setup, call, createProject, one, rows, days } from './pick-helpers.mjs';

const api = (env, method, path, body) => call(env, path, { method, token: SECRET, body });
const json = async res => res.json();
const ON = { CUSTOM_PRODUCTS: 'on' };
const SERVICE = { kind: 'service', name: '加修', options: [{ label: '', price: 300, cost: 0 }] };
const DISABLED = { error: '目前只能從平台加入商品', code: 'custom_products_disabled' };

const snapshot = env => JSON.stringify(['products', 'product_options', 'orders', 'order_items', 'projects']
  .map(t => rows(env, `SELECT * FROM ${t} ORDER BY rowid`)));

// A custom service as one made before the switch went off: straight into D1.
function seedCustom(env, { id = 'svc', active = 1 } = {}) {
  const at = days(0);
  env.DB._db.prepare("INSERT INTO products (id, photographer_id, kind, name, active, created_at, updated_at) VALUES (?, 'default', 'service', '加修', ?, ?, ?)")
    .run(id, active, at, at);
  env.DB._db.prepare("INSERT INTO product_options (id, product_id, label, price, cost, sort) VALUES (?, ?, '', 300, 0, 0)")
    .run(`${id}o`, id);
  return { id, optionId: `${id}o` };
}

let seq = 0;
async function adopted(env) {
  const at = days(0);
  const pp = `pp${++seq}`;
  env.DB._db.prepare("INSERT INTO platform_products (id, kind, name, description, created_at, updated_at) VALUES (?, 'print', '無框畫', '', ?, ?)")
    .run(pp, at, at);
  env.DB._db.prepare("INSERT INTO platform_product_options (id, platform_product_id, label, vendor_cost, platform_price, sort) VALUES (?, ?, '16×20', 800, 1000, 0)")
    .run(`${pp}o`, pp);
  const res = await api(env, 'POST', '/api/admin/products/from-platform', { platform_product_id: pp, options: [{ platform_option_id: `${pp}o`, price: 1500 }] });
  assert.equal(res.status, 201, 'adopting is never gated');
  return { product: (await json(res)).product, platformOptionId: `${pp}o` };
}

async function assertDisabled(res, what) {
  assert.equal(res.status, 403, what);
  assert.deepEqual(await res.json(), DISABLED, what);
}

test('off by default: creating a custom product is 403 custom_products_disabled, nothing written', async () => {
  const env = setup();
  const before = snapshot(env);
  await assertDisabled(await api(env, 'POST', '/api/admin/products', SERVICE), 'unset');
  assert.equal(snapshot(env), before);
  const list = await json(await api(env, 'GET', '/api/admin/products'));
  assert.equal(list.custom_products_enabled, false);
  assert.deepEqual(list.products, []);
});

test('only exactly "on" turns it on; any other value is off', async () => {
  for (const value of ['off', 'true', 'ON', 'On', '1', 'yes', ' on', 'on ', '', 1, true]) {
    const env = setup({ CUSTOM_PRODUCTS: value });
    const before = snapshot(env);
    await assertDisabled(await api(env, 'POST', '/api/admin/products', SERVICE), JSON.stringify(value));
    assert.equal(snapshot(env), before, JSON.stringify(value));
    assert.equal((await json(await api(env, 'GET', '/api/admin/products'))).custom_products_enabled, false, JSON.stringify(value));
  }
  const env = setup(ON);
  const res = await api(env, 'POST', '/api/admin/products', SERVICE);
  assert.equal(res.status, 201);
  const { product } = await json(res);
  const list = await json(await api(env, 'GET', '/api/admin/products'));
  assert.equal(list.custom_products_enabled, true);
  assert.deepEqual(list.products.map(p => p.id), [product.id]);
  assert.equal((await api(env, 'PUT', `/api/admin/products/${product.id}`, { name: '急件' })).status, 200);
  assert.equal((await api(env, 'POST', `/api/admin/products/${product.id}/retire`)).status, 200);
  assert.equal((await api(env, 'POST', `/api/admin/products/${product.id}/restore`)).status, 200);
  assert.deepEqual([one(env, 'SELECT name, active FROM products WHERE id = ?', product.id)].map(r => [r.name, r.active]), [['急件', 1]]);
});

test('off: an old custom product cannot be edited or restored (403, nothing written), but can be retired and is still listed', async () => {
  const env = setup();
  const svc = seedCustom(env);
  let before = snapshot(env);
  await assertDisabled(await api(env, 'PUT', `/api/admin/products/${svc.id}`, { name: '急件' }), 'PUT name');
  await assertDisabled(await api(env, 'PUT', `/api/admin/products/${svc.id}`, { options: [{ label: '', price: 1 }] }), 'PUT options');
  await assertDisabled(await api(env, 'PUT', `/api/admin/products/${svc.id}`, {}), 'PUT empty');
  assert.equal(snapshot(env), before);
  let [listed] = (await json(await api(env, 'GET', '/api/admin/products'))).products;
  assert.deepEqual([listed.id, listed.active, listed.platform_product_id], [svc.id, 1, null]);

  const res = await api(env, 'POST', `/api/admin/products/${svc.id}/retire`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, active: 0 });
  before = snapshot(env);
  await assertDisabled(await api(env, 'POST', `/api/admin/products/${svc.id}/restore`), 'restore');
  assert.equal(snapshot(env), before);
  assert.equal(one(env, 'SELECT active FROM products WHERE id = ?', svc.id).active, 0);
  [listed] = (await json(await api(env, 'GET', '/api/admin/products'))).products;
  assert.deepEqual([listed.id, listed.active], [svc.id, 0], 'a retired custom product is still listed');
});

test('off: unknown or another photographer\'s product is still 404 on PUT, retire and restore', async () => {
  const env = setup();
  const at = days(0);
  env.DB._db.prepare("INSERT INTO products (id, photographer_id, kind, name, created_at, updated_at) VALUES ('oprod', 'other', 'service', 'theirs', ?, ?)").run(at, at);
  const before = snapshot(env);
  for (const [method, path, body] of [
    ['PUT', '/api/admin/products/nope', { name: 'x' }],
    ['PUT', '/api/admin/products/oprod', { name: 'x' }],
    ['POST', '/api/admin/products/nope/restore'],
    ['POST', '/api/admin/products/oprod/restore'],
    ['POST', '/api/admin/products/oprod/retire'],
  ]) assert.equal((await api(env, method, path, body)).status, 404, `${method} ${path}`);
  assert.equal(snapshot(env), before);
});

test('off: adopted products are untouched — adopt, PUT, retire and restore all work', async () => {
  const env = setup();
  const { product, platformOptionId } = await adopted(env);
  const put = await api(env, 'PUT', `/api/admin/products/${product.id}`, { options: [{ platform_option_id: platformOptionId, price: 1800 }], guest_visible: true });
  assert.equal(put.status, 200);
  assert.equal((await json(put)).product.options[0].price, 1800);
  assert.equal((await api(env, 'POST', `/api/admin/products/${product.id}/retire`)).status, 200);
  const res = await api(env, 'POST', `/api/admin/products/${product.id}/restore`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, active: 1 });
  const list = await json(await api(env, 'GET', '/api/admin/products'));
  assert.deepEqual([list.custom_products_enabled, list.products.length, list.products[0].active], [false, 1, 1]);
});

test('off: an order line made while it was on keeps reading and can be kept on an edit', async () => {
  const env = setup(ON);
  const { project } = await createProject(env);
  const { product } = await json(await api(env, 'POST', '/api/admin/products', SERVICE));
  const made = await api(env, 'POST', `/api/admin/projects/${project.id}/orders`, { lines: [{ option_id: product.options[0].id, qty: 2 }] });
  assert.equal(made.status, 201);
  const { order } = await json(made);
  env.CUSTOM_PRODUCTS = 'off';
  const read = await json(await api(env, 'GET', `/api/admin/projects/${project.id}/orders`));
  assert.deepEqual(read.orders.map(o => [o.id, o.total]), [[order.id, 600]]);
  const put = await api(env, 'PUT', `/api/admin/orders/${order.id}`, { note: 'x', lines: [{ id: order.items[0].id, qty: 2 }] });
  assert.equal(put.status, 200, await put.clone().text());
  assert.equal(rows(env, 'SELECT * FROM order_items').length, 1);
});

test('off: start-retouch still creates the automatic extra-pick order', async () => {
  const env = setup();
  assert.equal(env.CUSTOM_PRODUCTS, undefined);
  const { project } = await createProject(env);
  env.DB._db.prepare(
    "INSERT INTO submissions (id, project_id, picker_id, relationship, photo_keys, count, pick_limit, extra_price, created_at) VALUES ('s1', ?, 'x', '本人', '[]', 50, 40, 200, ?)"
  ).run(project.id, new Date().toISOString());
  env.DB._db.prepare("UPDATE projects SET phase = 'submitted' WHERE id = ?").run(project.id);
  const res = await api(env, 'POST', `/api/admin/projects/${project.id}/start-retouch`);
  assert.equal(res.status, 200);
  const orders = rows(env, "SELECT * FROM orders WHERE source = 'system'");
  assert.equal(orders.length, 1);
  const [line] = rows(env, 'SELECT * FROM order_items');
  assert.deepEqual([line.order_id, line.kind, line.qty, line.unit_price], [orders[0].id, 'extra_pick', 10, 200]);
});

test('wrangler.toml declares CUSTOM_PRODUCTS = "off" under [vars]', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const vars = toml.slice(toml.indexOf('[vars]'));
  assert.match(vars, /^CUSTOM_PRODUCTS = "off"$/m);
});
