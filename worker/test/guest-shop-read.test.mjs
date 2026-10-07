// GET /api/pick/shop (docs/guest-shop.md, S1 trimmed): what a guest holding a
// delivered pick link may buy. Read only, delivered mode only, the products
// of the photographer who owns the link's project, adopted print/album
// products shown to guests and live on both sides, each with the options a
// guest could order today at the price an order would charge. Never cost,
// platform_price, vendor_cost or platform option ids. High tier: money data
// on a guest route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_PAGES } from './page-schemas.mjs';
import worker from '../worker.js';
import { fakeDB, req, ctx } from './fakes.mjs';
import {
  SECRET, MINE, THEIRS, setup, call, pick, save, claimed, one, rows, seedToken, days, collectingCtx,
} from './pick-helpers.mjs';

const OP = 'operator-secret';
const A = `${MINE}a.jpg`;
const envOp = (extra = {}) => setup({ OPERATOR_TOKEN: OP, ...extra });
const op = (env, method, path, body, token = OP) => call(env, path, { method, token, body });
const admin = (env, method, path, body, token = SECRET) => call(env, path, { method, token, body });
const shop = (env, t, opts = {}) => pick(env, opts.method || 'GET', 'shop', t, opts);

// numbers nothing else in these tests equals, so a search for them finds a
// leak wherever it happens
const VENDOR = 987_651;
const PLATFORM = 2_987;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function platformProduct(env, body = {}) {
  const res = await op(env, 'POST', '/api/operator/products', {
    kind: 'print', name: '無框畫', description: '木框', options: [
      { label: '16×20', vendor_cost: VENDOR, platform_price: PLATFORM },
    ], ...body,
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).product;
}

async function adopt(env, pp, prices, extra = {}) {
  const res = await admin(env, 'POST', '/api/admin/products/from-platform', {
    platform_product_id: pp.id,
    options: pp.options.map((o, i) => ({ platform_option_id: o.id, price: prices[i] })),
    guest_visible: true, ...extra,
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).product;
}

// an album (two options, min_pages 10, max_pages 30, with an image) and a print, both
// adopted and shown to guests; the print sorts first
async function catalogue(env) {
  const ppAlbum = await platformProduct(env, {
    kind: 'album', name: '相本書', description: '精裝 20×20', photo_count: 20, min_pages: 10, max_pages: 30, options: [
      { label: '20×20', vendor_cost: VENDOR, platform_price: PLATFORM },
      { label: '30×30', vendor_cost: VENDOR + 1, platform_price: PLATFORM + 1 },
    ],
  });
  const ppPrint = await platformProduct(env);
  const img = await worker.fetch(req(`/api/operator/products/${ppAlbum.id}/image`, { method: 'PUT', token: OP, body: PNG }), env, ctx);
  assert.equal(img.status, 200);
  const imageStamp = one(env, 'SELECT image_updated_at FROM platform_products WHERE id = ?', ppAlbum.id).image_updated_at;
  const album = await adopt(env, ppAlbum, [5000, 7000], { sort: 2 });
  const print = await adopt(env, ppPrint, [3000], { sort: 1 });
  return { ppAlbum, ppPrint, album, print, imageStamp };
}

async function submit(env, t, key) {
  const c = collectingCtx();
  const res = await pick(env, 'POST', 'submit', t, { key, body: { relationship: '本人' } }, c);
  await c.settle();
  return res;
}

// a project in retouching: seat taken, one pick submitted, retouch started
async function retouching(env) {
  const p = await claimed(env);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] })).status, 200);
  assert.equal((await submit(env, p.token, p.key)).status, 200);
  assert.equal((await admin(env, 'POST', `/api/admin/projects/${p.project.id}/start-retouch`)).status, 200);
  return p;
}
const deliver = (env, p) => admin(env, 'POST', `/api/admin/projects/${p.project.id}/deliver`, { final_folders: [THEIRS] });
async function delivered(env) {
  const p = await retouching(env);
  const res = await deliver(env, p);
  assert.equal(res.status, 200, await res.clone().text());
  return p;
}

const okShop = async (env, t, opts) => {
  const res = await shop(env, t, opts);
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
};

// every key and every scalar in a response
function walk(v, keys = new Set(), values = []) {
  if (Array.isArray(v)) for (const x of v) walk(x, keys, values);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x, keys, values); }
  else values.push(v);
  return { keys, values };
}

const everything = env => JSON.stringify(
  ['projects', 'share_tokens', 'platform_products', 'platform_product_options', 'products', 'product_options', 'orders', 'order_items']
    .map(t => rows(env, `SELECT * FROM ${t} ORDER BY rowid`)),
);

// ─── the answer ─────────────────────────────────────────────────────────────

test('delivered: the shop lists the guest-visible products, sorted, in the exact shape the page codes against', async () => {
  const env = envOp();
  const c = await catalogue(env);
  const p = await delivered(env);
  const res = await shop(env, p.token);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(res.headers.get('Vary'), 'X-Share-Token');
  const json = await res.json();
  assert.deepEqual(json, {
    products: [
      {
        id: c.print.id, kind: 'print', name: '無框畫', description: '木框', photo_count: null, min_pages: null, max_pages: null, bleed_mm: null, extra_page_price: null, image_url: null,
        options: [{ id: c.print.options[0].id, label: '16×20', price: 3000 }],
      },
      {
        id: c.album.id, kind: 'album', name: '相本書', description: '精裝 20×20', photo_count: 20, min_pages: 10, max_pages: 30, bleed_mm: null, extra_page_price: null,
        image_url: `/api/platform/products/${c.ppAlbum.id}/image?v=${encodeURIComponent(c.imageStamp)}`,
        options: [
          { id: c.album.options[0].id, label: '20×20', price: 5000 },
          { id: c.album.options[1].id, label: '30×30', price: 7000 },
        ],
      },
    ],
  });
  // the image_url really serves the image, without any token
  const img = await call(env, json.products[1].image_url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('Content-Type'), 'image/png');
});

test('owner and viewers read the same shop; the token works as ?t= and as X-Share-Token', async () => {
  const env = envOp();
  await catalogue(env);
  const p = await delivered(env);
  const viewer = await okShop(env, p.token);
  const owner = await okShop(env, p.token, { key: p.key });
  assert.equal(viewer.products.length, 2);
  assert.deepEqual(owner, viewer);
  const header = await call(env, '/api/pick/shop', { headers: { 'X-Share-Token': p.token } });
  assert.equal(header.status, 200);
  assert.deepEqual(await header.json(), viewer);
});

test('no cost leaks: no cost, platform_price, vendor_cost or platform option id anywhere in the answer', async () => {
  const env = envOp();
  const c = await catalogue(env);
  const p = await delivered(env);
  const json = await okShop(env, p.token);
  const { keys, values } = walk(json);
  assert.deepEqual([...keys].sort(), ['bleed_mm', 'description', 'extra_page_price', 'id', 'image_url', 'kind', 'label', 'max_pages', 'min_pages', 'name', 'options', 'photo_count', 'price', 'products'].sort());
  for (const forbidden of [VENDOR, VENDOR + 1, PLATFORM, PLATFORM + 1]) assert.ok(!values.includes(forbidden), `value ${forbidden}`);
  const text = JSON.stringify(json);
  assert.doesNotMatch(text, /987651|987652|2987|2988|cost|platform_price|vendor|guest_visible|photographer/);
  for (const o of [...c.ppAlbum.options, ...c.ppPrint.options]) assert.ok(!text.includes(o.id), 'platform option id');
  // the platform product id appears only inside the image path
  assert.ok(!text.includes(c.ppPrint.id), 'a print without an image says nothing of its platform product');
  assert.equal(text.split(c.ppAlbum.id).length - 1, 1);
  // the positive: prices are there
  assert.deepEqual(json.products.flatMap(x => x.options.map(o => o.price)), [3000, 5000, 7000]);
});

test('the shop price is what an order on that option charges', async () => {
  const env = envOp();
  const c = await catalogue(env);
  const p = await delivered(env);
  const json = await okShop(env, p.token);
  for (const product of json.products) {
    for (const o of product.options) {
      const res = await admin(env, 'POST', `/api/admin/projects/${p.project.id}/orders`, { lines: [{ option_id: o.id, qty: 1 }] });
      assert.equal(res.status, 201, await res.clone().text());
      assert.equal((await res.json()).order.items[0].unit_price, o.price, `${product.name} ${o.label}`);
    }
  }
  // a repriced option shows its new price at once
  await admin(env, 'PUT', `/api/admin/products/${c.print.id}`, { options: [{ platform_option_id: c.ppPrint.options[0].id, price: 3500 }] });
  assert.equal((await okShop(env, p.token)).products[0].options[0].price, 3500);
});

test('only sellable products and options: hidden, retired, platform-retired, under the floor, services and mismatched options are left out', async () => {
  const env = envOp({ CUSTOM_PRODUCTS: 'on' });
  const c = await catalogue(env);
  const p = await delivered(env);
  const ids = async () => (await okShop(env, p.token)).products.map(x => [x.id, x.options.map(o => o.id)]);
  const full = [[c.print.id, [c.print.options[0].id]], [c.album.id, c.album.options.map(o => o.id)]];
  assert.deepEqual(await ids(), full, 'positive: both listed before anything changes');

  // guest_visible off
  await admin(env, 'PUT', `/api/admin/products/${c.print.id}`, { guest_visible: false });
  assert.deepEqual(await ids(), [full[1]]);
  await admin(env, 'PUT', `/api/admin/products/${c.print.id}`, { guest_visible: true });
  assert.deepEqual(await ids(), full);

  // the photographer retires the product
  await admin(env, 'POST', `/api/admin/products/${c.print.id}/retire`);
  assert.deepEqual(await ids(), [full[1]]);
  await admin(env, 'POST', `/api/admin/products/${c.print.id}/restore`);
  assert.deepEqual(await ids(), full);

  // the operator retires the platform product
  await op(env, 'POST', `/api/operator/products/${c.ppAlbum.id}/retire`);
  assert.deepEqual(await ids(), [full[0]]);
  await op(env, 'POST', `/api/operator/products/${c.ppAlbum.id}/restore`);
  assert.deepEqual(await ids(), full);

  // the operator retires one platform option: that option goes, the product stays
  env.DB._db.prepare('UPDATE platform_product_options SET active = 0 WHERE id = ?').run(c.ppAlbum.options[1].id);
  assert.deepEqual(await ids(), [full[0], [c.album.id, [c.album.options[0].id]]]);
  env.DB._db.prepare('UPDATE platform_product_options SET active = 1 WHERE id = ?').run(c.ppAlbum.options[1].id);

  // the photographer drops an option from the set (retired, never deleted)
  env.DB._db.prepare('UPDATE product_options SET active = 0 WHERE id = ?').run(c.album.options[0].id);
  assert.deepEqual(await ids(), [full[0], [c.album.id, [c.album.options[1].id]]]);
  env.DB._db.prepare('UPDATE product_options SET active = 1 WHERE id = ?').run(c.album.options[0].id);

  // the operator raises the platform price above the photographer's: an
  // order would be refused (below_platform_price), so the guest is not shown it
  env.DB._db.prepare('UPDATE platform_product_options SET platform_price = 3001 WHERE id = ?').run(c.ppPrint.options[0].id);
  assert.deepEqual(await ids(), [full[1]], 'a product whose every option is under the floor goes');
  const refused = await admin(env, 'POST', `/api/admin/projects/${p.project.id}/orders`, { lines: [{ option_id: c.print.options[0].id, qty: 1 }] });
  assert.equal((await refused.json()).code, 'below_platform_price', 'the order flow agrees');
  // equal to the floor is sellable
  env.DB._db.prepare('UPDATE platform_product_options SET platform_price = 3000 WHERE id = ?').run(c.ppPrint.options[0].id);
  assert.deepEqual(await ids(), full);

  // an option pointing at another platform product's option (hand edit)
  env.DB._db.prepare('UPDATE product_options SET platform_option_id = ? WHERE id = ?').run(c.ppPrint.options[0].id, c.album.options[0].id);
  assert.deepEqual(await ids(), [full[0], [c.album.id, [c.album.options[1].id]]]);
  env.DB._db.prepare('UPDATE product_options SET platform_option_id = ? WHERE id = ?').run(c.ppAlbum.options[0].id, c.album.options[0].id);

  // a service (custom product) shown to guests is never in the shop
  const svc = await admin(env, 'POST', '/api/admin/products', { kind: 'service', name: '急件', guest_visible: true, options: [{ price: 100 }] });
  assert.equal(svc.status, 201);
  assert.deepEqual(await ids(), full);
  // nor a hand-made custom print without a platform product
  env.DB._db.prepare("UPDATE products SET kind = 'print' WHERE id = ?").run((await svc.json()).product.id);
  assert.deepEqual(await ids(), full);
  // nor an adopted row whose own kind says service (hand edit)
  env.DB._db.prepare("UPDATE products SET kind = 'service' WHERE id = ?").run(c.print.id);
  assert.deepEqual(await ids(), [full[1]]);
  env.DB._db.prepare("UPDATE products SET kind = 'print' WHERE id = ?").run(c.print.id);
  assert.deepEqual(await ids(), full);
});

test('sorted by the photographer\'s sort, options in their order', async () => {
  const env = envOp();
  const c = await catalogue(env);
  const p = await delivered(env);
  assert.deepEqual((await okShop(env, p.token)).products.map(x => x.id), [c.print.id, c.album.id]);
  await admin(env, 'PUT', `/api/admin/products/${c.album.id}`, { sort: 0 });
  assert.deepEqual((await okShop(env, p.token)).products.map(x => x.id), [c.album.id, c.print.id]);
  // reorder the album's options: the array order is the sort order
  await admin(env, 'PUT', `/api/admin/products/${c.album.id}`, {
    options: [{ platform_option_id: c.ppAlbum.options[1].id, price: 7000 }, { platform_option_id: c.ppAlbum.options[0].id, price: 5000 }],
  });
  assert.deepEqual((await okShop(env, p.token)).products[0].options.map(o => o.label), ['30×30', '20×20']);
});

test("another photographer's products never show; the project decides the photographer, not the request", async () => {
  const env = envOp();
  const c = await catalogue(env);
  const p = await delivered(env);
  // another photographer adopted the same platform album, shown to guests
  const now = new Date().toISOString();
  env.DB._db.prepare(
    "INSERT INTO products (id, photographer_id, kind, name, guest_visible, platform_product_id, sort, created_at, updated_at) VALUES ('theirs', 'other', 'album', 'x', 1, ?, 0, ?, ?)"
  ).run(c.ppAlbum.id, now, now);
  env.DB._db.prepare(
    "INSERT INTO product_options (id, product_id, label, price, cost, platform_option_id) VALUES ('theirs-o', 'theirs', '', 99999, ?, ?)"
  ).run(PLATFORM, c.ppAlbum.options[0].id);
  const mine = await okShop(env, p.token);
  assert.deepEqual(mine.products.map(x => x.id), [c.print.id, c.album.id]);
  assert.doesNotMatch(JSON.stringify(mine), /theirs|99999/);
  // whatever the request says
  for (const extra of ['&photographer_id=other', '&photographer=other', '&pid=other']) {
    const res = await call(env, `/api/pick/shop?t=${encodeURIComponent(p.token)}${extra}`, { headers: { 'X-Photographer-Id': 'other' } });
    assert.deepEqual(await res.json(), mine, extra);
  }
  // a project of the other photographer sees theirs, and not ours
  env.DB._db.prepare("UPDATE projects SET photographer_id = 'other' WHERE id = ?").run(p.project.id);
  const theirs = await okShop(env, p.token);
  assert.deepEqual(theirs.products.map(x => [x.id, x.options.map(o => [o.id, o.price])]), [['theirs', [['theirs-o', 99999]]]]);
  // and a project with no photographer sees nothing
  env.DB._db.prepare("UPDATE projects SET photographer_id = '' WHERE id = ?").run(p.project.id);
  assert.deepEqual(await okShop(env, p.token), { products: [] });
});

// ─── when it answers ────────────────────────────────────────────────────────

test('delivered mode only: picking, retouching, undelivered and reopened are 409 not_delivered, never the list', async () => {
  const env = envOp();
  await catalogue(env);
  const notDelivered = async (t, label, key) => {
    const res = await shop(env, t, { key });
    assert.equal(res.status, 409, label);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store', label);
    const json = await res.json();
    assert.equal(json.code, 'not_delivered', label);
    assert.ok(!('products' in json), label);
  };
  const p = await claimed(env);
  await notDelivered(p.token, 'picking (viewer)');
  await notDelivered(p.token, 'picking (owner)', p.key);
  const r = await retouching(env);
  await notDelivered(r.token, 'retouching, not delivered');
  // a finals snapshot without the stamp is not a delivery
  env.DB._db.prepare('UPDATE projects SET final_folders = ? WHERE id = ?').run(JSON.stringify([THEIRS]), r.project.id);
  await notDelivered(r.token, 'snapshot without delivered_at');
  // a stamp without a readable snapshot is not one either
  env.DB._db.prepare("UPDATE projects SET delivered_at = ?, final_folders = 'not json' WHERE id = ?").run(new Date().toISOString(), r.project.id);
  await notDelivered(r.token, 'stamp with a broken snapshot');
  env.DB._db.prepare('UPDATE projects SET delivered_at = NULL, final_folders = NULL WHERE id = ?').run(r.project.id);
  // the positive, then undeliver, deliver again, reopen
  assert.equal((await deliver(env, r)).status, 200);
  assert.equal((await shop(env, r.token)).status, 200);
  assert.equal((await admin(env, 'POST', `/api/admin/projects/${r.project.id}/undeliver`)).status, 200);
  await notDelivered(r.token, 'undelivered');
  assert.equal((await deliver(env, r)).status, 200);
  assert.equal((await shop(env, r.token)).status, 200, 'delivered again');
  assert.equal((await admin(env, 'POST', `/api/admin/projects/${r.project.id}/reopen`)).status, 200);
  await notDelivered(r.token, 'reopened');
});

test('archived, revoked, expired or unknown links are 401', async () => {
  const env = envOp();
  await catalogue(env);
  const p = await delivered(env);
  assert.equal((await shop(env, p.token)).status, 200, 'positive first');
  const q = await delivered(env);
  assert.equal((await admin(env, 'POST', `/api/admin/projects/${q.project.id}/archive`)).status, 200);
  assert.equal((await shop(env, q.token)).status, 401, 'archived');
  // a link revived by hand on an archived project is still dead
  env.DB._db.prepare('UPDATE share_tokens SET revoked_at = NULL WHERE token = ?').run(q.token);
  assert.equal((await shop(env, q.token)).status, 401, 'archived, link revived');
  env.DB._db.prepare('UPDATE share_tokens SET revoked_at = ? WHERE token = ?').run(new Date().toISOString(), p.token);
  assert.equal((await shop(env, p.token)).status, 401, 'revoked');
  env.DB._db.prepare('UPDATE share_tokens SET revoked_at = NULL, expires_at = ? WHERE token = ?').run(days(-1), p.token);
  assert.equal((await shop(env, p.token)).status, 401, 'expired');
  for (const t of [undefined, '', 'nope', `${p.token}x`, "' OR 1=1 --", `${p.token}' OR '1'='1`]) {
    assert.equal((await shop(env, t)).status, 401, String(t));
  }
});

test('only a pick link opens it: admin, operator, client, studio and session tokens and a bare picker key are 401', async () => {
  const env = envOp();
  await catalogue(env);
  const p = await delivered(env);
  for (const [token, kind] of [['CLIENT', 'client'], ['STUDIO', 'studio'], ['SESSION', 'session']]) {
    // even pointed at the delivered project
    await seedToken(env, { token, kind, project_id: p.project.id, book_id: kind === 'client' ? 'b1' : '', folders: [THEIRS] });
  }
  for (const token of [SECRET, OP, 'CLIENT', 'STUDIO', 'SESSION', p.key]) {
    for (const res of [
      await call(env, '/api/pick/shop', { token }),
      await call(env, `/api/pick/shop?t=${encodeURIComponent(token)}`),
      await call(env, '/api/pick/shop', { headers: { 'X-Share-Token': token } }),
    ]) {
      assert.equal(res.status, 401, token);
      assert.ok(!('products' in await res.json()), token);
    }
  }
  assert.equal((await call(env, '/api/pick/shop', { key: p.key })).status, 401, 'a picker key alone');
  assert.equal((await shop(env, p.token)).status, 200, 'positive: the pick link');
});

test('wrong methods are 405 and write nothing; other paths under it are 404', async () => {
  const env = envOp();
  await catalogue(env);
  const p = await delivered(env);
  const before = everything(env);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    for (const key of [undefined, p.key]) {
      const res = await shop(env, p.token, { method, key, body: { products: [], option_id: 'x' } });
      assert.equal(res.status, 405, `${method} ${key}`);
      assert.equal(res.headers.get('Allow'), 'GET');
    }
  }
  // the link is checked before the method
  assert.equal((await shop(env, 'nope', { method: 'POST', body: {} })).status, 401);
  assert.equal((await pick(env, 'GET', 'shop/x', p.token)).status, 404);
  assert.equal((await pick(env, 'PUT', 'shop/x', p.token, { body: {} })).status, 404);
  assert.equal(everything(env), before);
  assert.equal([...env.imagepicker._store.keys()].filter(k => k.startsWith('api/')).length, 0, 'nothing fell through to the upload route');
});

test('a not-delivered project with a wrong method is still 405 (method before state), and writes nothing', async () => {
  const env = envOp();
  const p = await claimed(env);
  const before = everything(env);
  assert.equal((await shop(env, p.token, { method: 'POST', body: {} })).status, 405);
  assert.equal(everything(env), before);
});

// ─── caps and edge data ─────────────────────────────────────────────────────

test('caps: at most 50 products and 20 options each', async () => {
  const env = envOp();
  const p = await delivered(env);
  const now = new Date().toISOString();
  const db = env.DB._db;
  for (let i = 0; i < 60; i++) {
    db.prepare("INSERT INTO platform_products (id, kind, name, created_at, updated_at) VALUES (?, 'print', ?, ?, ?)").run(`pp${i}`, `p${i}`, now, now);
    db.prepare("INSERT INTO products (id, photographer_id, kind, name, guest_visible, platform_product_id, sort, created_at, updated_at) VALUES (?, 'default', 'print', 'x', 1, ?, ?, ?, ?)")
      .run(`m${i}`, `pp${i}`, i, now, now);
    const options = i === 0 ? 25 : 1;
    for (let j = 0; j < options; j++) {
      db.prepare("INSERT INTO platform_product_options (id, platform_product_id, label, vendor_cost, platform_price, sort) VALUES (?, ?, ?, 1, 1, ?)").run(`po${i}-${j}`, `pp${i}`, `o${j}`, j);
      db.prepare('INSERT INTO product_options (id, product_id, label, price, cost, sort, platform_option_id) VALUES (?, ?, ?, 10, 1, ?, ?)').run(`mo${i}-${j}`, `m${i}`, `o${j}`, j, `po${i}-${j}`);
    }
  }
  const json = await okShop(env, p.token);
  assert.equal(json.products.length, 50);
  assert.deepEqual(json.products.map(x => x.id), Array.from({ length: 50 }, (_, i) => `m${i}`), 'the first 50 by sort');
  assert.equal(json.products[0].options.length, 20);
  assert.deepEqual(json.products[0].options.map(o => o.label), Array.from({ length: 20 }, (_, j) => `o${j}`));
  // the cap counts sellable products only: hide the first ten's options and
  // ten more come in
  for (let i = 0; i < 10; i++) db.prepare('UPDATE product_options SET active = 0 WHERE product_id = ?').run(`m${i}`);
  const after = await okShop(env, p.token);
  assert.equal(after.products.length, 50);
  assert.equal(after.products[0].id, 'm10');
  assert.equal(after.products[49].id, 'm59');
});

test('an empty catalogue is {products: []}', async () => {
  const env = envOp();
  const p = await delivered(env);
  assert.deepEqual(await okShop(env, p.token), { products: [] });
});

test('min_pages / max_pages: the album carries them, the print null; photo_count is album-only too', async () => {
  const env = envOp();
  const c = await catalogue(env);
  const p = await delivered(env);
  // a hand-edited print with values still reads null
  env.DB._db.prepare('UPDATE platform_products SET min_pages = 7, max_pages = 8, photo_count = 7 WHERE id = ?').run(c.ppPrint.id);
  const json = await okShop(env, p.token);
  const byId = Object.fromEntries(json.products.map(x => [x.id, x]));
  assert.equal(byId[c.album.id].min_pages, 10);
  assert.equal(byId[c.album.id].photo_count, 20);
  assert.equal(byId[c.album.id].max_pages, 30);
  assert.equal(byId[c.print.id].min_pages, null);
  assert.equal(byId[c.print.id].max_pages, null);
  assert.equal(byId[c.print.id].photo_count, null);
  await op(env, 'PUT', `/api/operator/products/${c.ppAlbum.id}`, { min_pages: 12, max_pages: 24 });
  const album = (await okShop(env, p.token)).products.find(x => x.id === c.album.id);
  assert.deepEqual([album.min_pages, album.max_pages], [12, 24]);
});

// ─── missing migrations ─────────────────────────────────────────────────────

test('before both page migrations the shop still answers, min_pages and max_pages null', async () => {
  const env = envOp({ DB: fakeDB({ schema: NO_PAGES }) });
  const ppAlbum = await platformProduct(env, { kind: 'album', name: '相本書', photo_count: 20 });
  const album = await adopt(env, ppAlbum, [5000]);
  const p = await delivered(env);
  const json = await okShop(env, p.token);
  assert.deepEqual(json.products.map(x => [x.id, x.min_pages, x.max_pages, x.photo_count, x.options.map(o => o.price)]), [[album.id, null, null, 20, [5000]]]);
});

test('without the catalogue tables the shop is 500 shop_unavailable, no list, no detail', async () => {
  const env = envOp();
  const p = await delivered(env);
  for (const table of ['product_options', 'platform_product_options', 'products', 'platform_products']) {
    env.DB._db.exec(`DROP TABLE ${table}`);
    const res = await shop(env, p.token);
    assert.equal(res.status, 500, table);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
    const json = await res.json();
    assert.deepEqual(json, { error: '商品資訊暫時無法顯示', code: 'shop_unavailable' }, table);
  }
  // not delivered is still 409 first, before any catalogue read
  env.DB._db.prepare('UPDATE projects SET delivered_at = NULL WHERE id = ?').run(p.project.id);
  assert.equal((await shop(env, p.token)).status, 409);
});

test('the shop writes nothing, not even the link\'s last-seen stamp', async () => {
  const env = envOp();
  await catalogue(env);
  const p = await delivered(env);
  env.DB._db.prepare('UPDATE share_tokens SET last_seen_at = NULL').run();
  const before = everything(env);
  const writes = env.DB._writes().length;
  await okShop(env, p.token);
  await okShop(env, p.token, { key: p.key });
  assert.equal(everything(env), before);
  assert.equal(env.DB._writes().length, writes);
});
