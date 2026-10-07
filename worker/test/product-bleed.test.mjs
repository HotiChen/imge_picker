// platform_products.bleed_mm (docs/products-orders.md, "bleed_mm"): how many
// millimetres of bleed the lab wants around each page / print, set by the
// operator per platform product. Albums and prints alike (unlike the page
// bounds). A number 0–10 inclusive (decimals allowed: 2.5 mm is common) or
// null = 0 mm. Shown to photographers and guests (the album editor draws the
// cut line from it); never a cost. Arrives in its own hand-run migration, so
// every read and every write that does not set a number must work before it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fakeDB } from './fakes.mjs';
import { SECRET, MINE, THEIRS, setup, call, pick, save, claimed, rows, one, collectingCtx } from './pick-helpers.mjs';
import { FRESH, NO_BLEED, NO_PAGES, BLEED_SQL, MIN_SQL, MAX_SQL } from './page-schemas.mjs';

const OP = 'operator-secret';
const envFor = (schema, extra = {}) => setup({ OPERATOR_TOKEN: OP, ...(schema ? { DB: fakeDB({ schema }) } : {}), ...extra });
const op = (env, method, path, body, token = OP) => call(env, path, { method, token, body });
const admin = (env, method, path, body, token = SECRET) => call(env, path, { method, token, body });

const ALBUM = { kind: 'album', name: '相本書', description: '精裝', options: [{ label: '20×20', vendor_cost: 900, platform_price: 1000 }] };
const PRINT = { kind: 'print', name: '無框畫', options: [{ label: 'A4', vendor_cost: 100, platform_price: 200 }] };
async function createPP(env, body = {}) {
  const res = await op(env, 'POST', '/api/operator/products', { ...ALBUM, ...body });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).product;
}
const putPP = (env, id, body) => op(env, 'PUT', `/api/operator/products/${id}`, body);
const ppRow = (env, id) => one(env, 'SELECT * FROM platform_products WHERE id = ?', id);
const snapshot = env => JSON.stringify(['platform_products', 'platform_product_options', 'products', 'product_options']
  .map(t => rows(env, `SELECT * FROM ${t} ORDER BY rowid`)));
const bad = async (res, status, code, label) => {
  const text = await res.text();
  assert.equal(res.status, status, `${label}: ${text}`);
  assert.equal(JSON.parse(text).code, code, label);
};
async function adopt(env, pp) {
  const res = await admin(env, 'POST', '/api/admin/products/from-platform', {
    platform_product_id: pp.id, options: pp.options.map(o => ({ platform_option_id: o.id, price: o.platform_price * 2 })), guest_visible: true,
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).product;
}
async function deliveredLink(env) {
  const p = await claimed(env);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: `${MINE}a.jpg`, rating: 1 }] })).status, 200);
  const c = collectingCtx();
  assert.equal((await pick(env, 'POST', 'submit', p.token, { key: p.key, body: { relationship: '本人' } }, c)).status, 200);
  await c.settle();
  assert.equal((await admin(env, 'POST', `/api/admin/projects/${p.project.id}/start-retouch`)).status, 200);
  assert.equal((await admin(env, 'POST', `/api/admin/projects/${p.project.id}/deliver`, { final_folders: [THEIRS] })).status, 200);
  return p;
}

// ─── the migration ──────────────────────────────────────────────────────────

test('migration: one ALTER adding bleed_mm REAL; schema.sql notes it; the fixture really lacks it', () => {
  const file = new URL('../migrations/2026-10-07-product-bleed.sql', import.meta.url);
  assert.ok(existsSync(file));
  const statements = sql => sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
  assert.deepEqual(statements(BLEED_SQL), ['ALTER TABLE platform_products ADD COLUMN bleed_mm REAL']);
  assert.match(BLEED_SQL, /duplicate column/i);
  assert.match(BLEED_SQL, /D1 Console/);
  assert.ok(FRESH.includes('2026-10-07-product-bleed.sql'));
  assert.ok(FRESH.includes('ALTER TABLE platform_products ADD COLUMN bleed_mm REAL;'));
  const shape = db => db._db.prepare('PRAGMA table_info(platform_products)').all();
  const cols = schema => shape(fakeDB({ schema })).map(c => c.name);
  assert.ok(cols(FRESH).includes('bleed_mm'));
  assert.ok(!cols(NO_BLEED).includes('bleed_mm') && cols(NO_BLEED).includes('max_pages'));
  assert.ok(!cols(NO_PAGES).includes('bleed_mm'));
  // the paste on today's database = schema.sql; all three in order on one with none = schema.sql
  assert.deepEqual(shape(fakeDB({ schema: NO_BLEED + '\n' + BLEED_SQL })), shape(fakeDB()));
  assert.deepEqual(shape(fakeDB({ schema: NO_PAGES + '\n' + MIN_SQL + '\n' + MAX_SQL + '\n' + BLEED_SQL })), shape(fakeDB()));
  const twice = fakeDB({ schema: NO_BLEED + '\n' + BLEED_SQL });
  assert.throws(() => twice._db.exec(BLEED_SQL), /duplicate column/);
});

// ─── operator writes and reads ──────────────────────────────────────────────

test('operator: bleed_mm is created, stored and read back on albums and prints; left out or null = null', async () => {
  const env = envFor();
  const album = await createPP(env, { bleed_mm: 3 });
  assert.equal(album.bleed_mm, 3);
  assert.equal(ppRow(env, album.id).bleed_mm, 3);
  const print = await createPP(env, { ...PRINT, bleed_mm: 2.5 });
  assert.equal(print.bleed_mm, 2.5, 'a print keeps its bleed (not album-only)');
  assert.equal(ppRow(env, print.id).bleed_mm, 2.5);
  for (const v of [0, 10, 0.5, 9.99]) assert.equal((await createPP(env, { bleed_mm: v })).bleed_mm, v, String(v));
  const none = await createPP(env);
  assert.ok(Object.hasOwn(none, 'bleed_mm'));
  assert.equal(none.bleed_mm, null);
  assert.equal(ppRow(env, none.id).bleed_mm, null);
  assert.equal((await createPP(env, { bleed_mm: null })).bleed_mm, null);
  const list = (await (await op(env, 'GET', '/api/operator/products')).json()).products;
  assert.equal(list.find(p => p.id === album.id).bleed_mm, 3);
  assert.equal(list.find(p => p.id === print.id).bleed_mm, 2.5);
  assert.equal(list.find(p => p.id === none.id).bleed_mm, null);
});

test('operator: an invalid bleed_mm is 400 invalid_bleed_mm on create and edit, any kind, nothing written', async () => {
  const env = envFor();
  const pp = await createPP(env, { bleed_mm: 3 });
  const before = snapshot(env);
  for (const v of [-0.01, -1, 10.01, 11, 1e300, '3', '', true, false, [], {}, [3]]) {
    await bad(await op(env, 'POST', '/api/operator/products', { ...ALBUM, bleed_mm: v }), 400, 'invalid_bleed_mm', `POST ${JSON.stringify(v)}`);
    await bad(await op(env, 'POST', '/api/operator/products', { ...PRINT, bleed_mm: v }), 400, 'invalid_bleed_mm', `print ${JSON.stringify(v)}`);
    await bad(await putPP(env, pp.id, { name: 'changed', bleed_mm: v }), 400, 'invalid_bleed_mm', `PUT ${JSON.stringify(v)}`);
  }
  assert.equal(snapshot(env), before);
});

test('operator PUT: bleed_mm changes, clears with null, is kept when left out, and survives a kind change', async () => {
  const env = envFor();
  const pp = await createPP(env, { bleed_mm: 3, min_pages: 10 });
  const ok = async (body, expect) => {
    const res = await putPP(env, pp.id, body);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await res.json()).product.bleed_mm, expect, JSON.stringify(body));
    assert.equal(ppRow(env, pp.id).bleed_mm, expect);
  };
  await ok({ bleed_mm: 5 }, 5);
  await ok({ name: '相本書 2' }, 5);
  await ok({ kind: 'print' }, 5);       // leaving album clears the page bounds, not the bleed
  assert.equal(ppRow(env, pp.id).min_pages, null);
  await ok({ kind: 'album' }, 5);
  await ok({ bleed_mm: 0 }, 0);
  await ok({ bleed_mm: null }, null);
  await ok({ bleed_mm: 10 }, 10);
  // a PUT that does not name it does not write it back
  const sqlBefore = env.DB._sql.length;
  await ok({ name: 'y' }, 10);
  assert.ok(!env.DB._sql.slice(sqlBefore).some(s => /^UPDATE platform_products SET .*bleed_mm/.test(s)), 'unnamed bleed not rewritten');
});

test('only the operator writes bleed_mm: photographer 401 on operator routes, adopted PUT is platform_managed', async () => {
  const env = envFor();
  const pp = await createPP(env, { bleed_mm: 3 });
  const mine = await adopt(env, pp);
  const before = snapshot(env);
  assert.equal((await op(env, 'PUT', `/api/operator/products/${pp.id}`, { bleed_mm: 4 }, SECRET)).status, 401);
  assert.equal((await op(env, 'POST', '/api/operator/products', { ...ALBUM, bleed_mm: 4 }, SECRET)).status, 401);
  await bad(await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { bleed_mm: 4 }), 400, 'platform_managed', 'bleed');
  await bad(await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { bleed_mm: null, sort: 1 }), 400, 'platform_managed', 'bleed null');
  assert.equal(snapshot(env), before);
  assert.equal((await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { sort: 1 })).status, 200, 'positive');
});

test("photographer views and the guest shop carry the platform's live bleed_mm, never a cost", async () => {
  const env = envFor();
  const pp = await createPP(env, { bleed_mm: 3 });
  const print = await createPP(env, { ...PRINT, bleed_mm: 2 });
  const plain = await createPP(env, { name: '無出血' });
  const mine = await adopt(env, pp);
  const myPrint = await adopt(env, print);
  const myPlain = await adopt(env, plain);
  assert.equal(mine.bleed_mm, 3, 'adopt response');
  const catalogue = async () => (await (await admin(env, 'GET', '/api/admin/products')).json()).products;
  const platform = async () => (await (await admin(env, 'GET', '/api/admin/platform-products')).json()).products;
  assert.equal((await catalogue()).find(p => p.id === mine.id).bleed_mm, 3);
  assert.equal((await catalogue()).find(p => p.id === myPrint.id).bleed_mm, 2);
  assert.equal((await catalogue()).find(p => p.id === myPlain.id).bleed_mm, null);
  assert.equal((await platform()).find(p => p.id === pp.id).bleed_mm, 3);
  assert.equal((await platform()).find(p => p.id === print.id).bleed_mm, 2);
  await putPP(env, pp.id, { bleed_mm: 4.5 });
  assert.equal((await catalogue()).find(p => p.id === mine.id).bleed_mm, 4.5, 'live, not a copy');
  const link = await deliveredLink(env);
  const res = await pick(env, 'GET', 'shop', link.token);
  assert.equal(res.status, 200);
  const shop = (await res.json()).products;
  assert.equal(shop.find(p => p.id === mine.id).bleed_mm, 4.5);
  assert.equal(shop.find(p => p.id === myPrint.id).bleed_mm, 2);
  const plainShop = shop.find(p => p.id === myPlain.id);
  assert.ok(Object.hasOwn(plainShop, 'bleed_mm'));
  assert.equal(plainShop.bleed_mm, null);
  // the guest shape is a named list: bleed added, still no cost of any kind
  for (const p of shop) {
    assert.deepEqual(Object.keys(p).sort(),
      ['bleed_mm', 'description', 'id', 'image_url', 'kind', 'max_pages', 'min_pages', 'name', 'options', 'photo_count'].sort());
    for (const o of p.options) assert.deepEqual(Object.keys(o).sort(), ['id', 'label', 'price']);
  }
});

test('a custom product (service) has bleed_mm null', async () => {
  const env = envFor(null, { CUSTOM_PRODUCTS: 'on' });
  const res = await admin(env, 'POST', '/api/admin/products', { kind: 'service', name: '加洗', bleed_mm: 3, options: [{ label: '', price: 100, cost: 0 }] });
  assert.equal(res.status, 201, await res.clone().text());
  const { product } = await res.json();
  assert.equal(product.bleed_mm, null);
});

// ─── before the migration ───────────────────────────────────────────────────

for (const [name, schema] of [['bleed missing', NO_BLEED], ['bleed and both page bounds missing', NO_PAGES]]) {
  test(`schema "${name}": every read answers with bleed_mm null`, async () => {
    const env = envFor(schema);
    const pp = await createPP(env);
    assert.equal(pp.bleed_mm, null, 'create response');
    let res = await op(env, 'GET', '/api/operator/products');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).products[0].bleed_mm, null);
    const mine = await adopt(env, pp);
    assert.equal(mine.bleed_mm, null);
    res = await admin(env, 'GET', '/api/admin/products');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).products[0].bleed_mm, null);
    res = await admin(env, 'GET', '/api/admin/platform-products');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).products[0].bleed_mm, null);
    const link = await deliveredLink(env);
    res = await pick(env, 'GET', 'shop', link.token);
    assert.equal(res.status, 200);
    const shop = (await res.json()).products;
    assert.equal(shop.length, 1, 'the shop lists the product');
    assert.ok(Object.hasOwn(shop[0], 'bleed_mm'));
    assert.equal(shop[0].bleed_mm, null);
  });

  test(`schema "${name}": a number is 500 bleed_mm_unavailable with nothing written; null and other fields write`, async () => {
    const env = envFor(schema);
    const pp = await createPP(env);
    const before = snapshot(env);
    await bad(await op(env, 'POST', '/api/operator/products', { ...ALBUM, bleed_mm: 3 }), 500, 'bleed_mm_unavailable', 'POST');
    await bad(await op(env, 'POST', '/api/operator/products', { ...PRINT, bleed_mm: 0 }), 500, 'bleed_mm_unavailable', 'POST 0');
    await bad(await putPP(env, pp.id, { name: 'x', bleed_mm: 3, options: [{ label: 'n', vendor_cost: 1, platform_price: 2 }] }), 500, 'bleed_mm_unavailable', 'PUT');
    assert.equal(snapshot(env), before, 'nothing written by any 500');
    // a 400 still comes before a 500
    await bad(await putPP(env, pp.id, { bleed_mm: 11 }), 400, 'invalid_bleed_mm', 'bad bleed');
    let res = await putPP(env, pp.id, { name: '相本書 null', bleed_mm: null });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(ppRow(env, pp.id).name, '相本書 null');
    assert.equal((await op(env, 'POST', '/api/operator/products', { ...ALBUM, bleed_mm: null })).status, 201);
  });
}

test('page bounds still unavailable on their own when only bleed is there (columns judged one by one)', async () => {
  // bleed present, max_pages missing: the bleed writes, max_pages answers its own 500
  const schema = FRESH.replace(/(min_pages\s+INTEGER),\n(?:\s*--[^\n]*\n)*\s*max_pages\s+INTEGER,\n/, '$1,\n');
  assert.notEqual(schema, FRESH, 'fixture regex matched');
  const env = envFor(schema);
  const pp = await createPP(env, { bleed_mm: 3, min_pages: 10 });
  assert.deepEqual([pp.bleed_mm, pp.min_pages, pp.max_pages], [3, 10, null]);
  await bad(await putPP(env, pp.id, { bleed_mm: 4, max_pages: 20 }), 500, 'max_pages_unavailable', 'max missing');
  assert.equal(ppRow(env, pp.id).bleed_mm, 3, 'nothing written');
  const res = await putPP(env, pp.id, { bleed_mm: 4 });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).product.bleed_mm, 4);
});

test('a migrated database reads bleed in the same single query: no column probe', async () => {
  const env = envFor();
  const pp = await createPP(env, { bleed_mm: 3 });
  await adopt(env, pp);
  const link = await deliveredLink(env);
  const probes = () => env.DB._sql.filter(s => /LIMIT 0/.test(s)).length;
  const start = probes();
  assert.equal((await op(env, 'GET', '/api/operator/products')).status, 200);
  assert.equal((await admin(env, 'GET', '/api/admin/products')).status, 200);
  assert.equal((await admin(env, 'GET', '/api/admin/platform-products')).status, 200);
  assert.equal((await pick(env, 'GET', 'shop', link.token)).status, 200);
  assert.equal((await putPP(env, pp.id, { bleed_mm: 4 })).status, 200);
  assert.equal(probes(), start);
  // positive: a database without bleed does probe
  const old = envFor(NO_BLEED);
  await createPP(old);
  const b = old.DB._sql.filter(s => /LIMIT 0/.test(s)).length;
  assert.equal((await op(old, 'GET', '/api/operator/products')).status, 200);
  assert.ok(old.DB._sql.filter(s => /LIMIT 0/.test(s)).length > b);
});
