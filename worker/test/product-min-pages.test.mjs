// platform_products.min_pages (docs/products-orders.md, "min_pages"): the
// operator sets an album's fewest inside spreads (1 spread = 1 P, cover and
// back not counted) on the platform product; photographers see it on the
// products they adopt and on the platform list; nobody but the operator
// writes it. Albums only, 1–200 or null. Before the hand-run migration every
// read says null and only a write of a number is refused (500).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fakeDB } from './fakes.mjs';
import { SECRET, CUSTOM_ON, setup, call, rows, one } from './pick-helpers.mjs';
import { FRESH, NO_PAGES, MAX_SQL, BLEED_SQL } from './page-schemas.mjs';

const OP = 'operator-secret';
const envOp = (extra = {}) => setup({ OPERATOR_TOKEN: OP, ...extra });
const op = (env, method, path, body, token = OP) => call(env, path, { method, token, body });
const admin = (env, method, path, body, token = SECRET) => call(env, path, { method, token, body });

// schema.sql as a database that has had neither page-bound migration (the
// max_pages one comes after; product-max-pages.test.mjs covers every state)
const PRE_MIGRATION = NO_PAGES;
const preEnv = (extra = {}) => setup({ OPERATOR_TOKEN: OP, DB: fakeDB({ schema: PRE_MIGRATION }), ...extra });

const ALBUM = { kind: 'album', name: '相本書', description: '精裝', photo_count: 20, options: [{ label: '20×20', vendor_cost: 900, platform_price: 1000 }] };

async function createPP(env, body = {}) {
  const res = await op(env, 'POST', '/api/operator/products', { ...ALBUM, ...body });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).product;
}
const ppRow = (env, id) => one(env, 'SELECT * FROM platform_products WHERE id = ?', id);
const snapshot = env => JSON.stringify(['platform_products', 'platform_product_options', 'products', 'product_options']
  .map(t => rows(env, `SELECT * FROM ${t} ORDER BY rowid`)));
const bad = async (res, status, code, label) => {
  assert.equal(res.status, status, label);
  assert.equal((await res.json()).code, code, label);
};
const adopt = async (env, pp) => {
  const res = await admin(env, 'POST', '/api/admin/products/from-platform', {
    platform_product_id: pp.id, options: pp.options.map(o => ({ platform_option_id: o.id, price: o.platform_price * 2 })),
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).product;
};

// ─── the migration ──────────────────────────────────────────────────────────

test('migration: one append-only ALTER, noted in schema.sql; the fixture really lacks it', () => {
  const file = new URL('../migrations/2026-10-06-product-min-pages.sql', import.meta.url);
  assert.ok(existsSync(file));
  const sql = readFileSync(file, 'utf8');
  const statements = sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
  assert.deepEqual(statements, ['ALTER TABLE platform_products ADD COLUMN min_pages INTEGER']);
  assert.match(sql, /duplicate column/i);
  assert.match(FRESH, /2026-10-06-product-min-pages\.sql/);
  assert.match(FRESH, /ALTER TABLE platform_products ADD COLUMN min_pages INTEGER;/);
  assert.notEqual(PRE_MIGRATION, FRESH, 'fixture regex matched nothing');
  const old = fakeDB({ schema: PRE_MIGRATION });
  assert.throws(() => old._db.prepare('SELECT min_pages FROM platform_products').all(), /no such column/);
  const shape = db => db._db.prepare('PRAGMA table_info(platform_products)').all();
  assert.deepEqual(shape(fakeDB({ schema: PRE_MIGRATION + '\n' + sql + '\n' + MAX_SQL + '\n' + BLEED_SQL })), shape(fakeDB()));
  const twice = fakeDB({ schema: PRE_MIGRATION + '\n' + sql });
  assert.throws(() => twice._db.exec(sql), /duplicate column/);
});

// ─── operator writes and reads ──────────────────────────────────────────────

test('operator: an album is created with min_pages, stored, and read back by create, list', async () => {
  const env = envOp();
  const pp = await createPP(env, { min_pages: 10 });
  assert.equal(pp.min_pages, 10);
  assert.equal(ppRow(env, pp.id).min_pages, 10);
  const list = await (await op(env, 'GET', '/api/operator/products')).json();
  assert.equal(list.products.find(p => p.id === pp.id).min_pages, 10);
  // the bounds themselves are fine
  assert.equal((await createPP(env, { min_pages: 1 })).min_pages, 1);
  assert.equal((await createPP(env, { min_pages: 200 })).min_pages, 200);
  // left out or null = no minimum
  const none = await createPP(env);
  assert.equal(none.min_pages, null);
  assert.ok(Object.hasOwn(none, 'min_pages'), 'the key is there, as null');
  assert.equal((await createPP(env, { min_pages: null })).min_pages, null);
});

test('operator: min_pages sticks to albums only — a print stores and reads null', async () => {
  const env = envOp();
  const print = await createPP(env, { kind: 'print', name: '無框畫', min_pages: 12 });
  assert.equal(print.min_pages, null);
  assert.equal(ppRow(env, print.id).min_pages, null);
  // and a PUT naming it on a print stores null as well
  const res = await op(env, 'PUT', `/api/operator/products/${print.id}`, { min_pages: 15 });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).product.min_pages, null);
  assert.equal(ppRow(env, print.id).min_pages, null);
  // a hand-edited print with a value still reads null
  env.DB._db.prepare('UPDATE platform_products SET min_pages = 9 WHERE id = ?').run(print.id);
  const list = await (await op(env, 'GET', '/api/operator/products')).json();
  assert.equal(list.products.find(p => p.id === print.id).min_pages, null);
});

test('operator: PUT changes min_pages, null clears it, leaving it out keeps it; leaving album clears it', async () => {
  const env = envOp();
  const pp = await createPP(env, { min_pages: 10 });
  const put = async body => {
    const res = await op(env, 'PUT', `/api/operator/products/${pp.id}`, body);
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json()).product;
  };
  assert.equal((await put({ min_pages: 14 })).min_pages, 14);
  assert.equal(ppRow(env, pp.id).min_pages, 14);
  assert.equal((await put({ name: '相本書 新版' })).min_pages, 14, 'left out keeps it');
  assert.equal(ppRow(env, pp.id).min_pages, 14);
  assert.equal((await put({ min_pages: null })).min_pages, null);
  assert.equal(ppRow(env, pp.id).min_pages, null);
  await put({ min_pages: 8 });
  const print = await put({ kind: 'print' });
  assert.equal(print.min_pages, null);
  assert.equal(ppRow(env, pp.id).min_pages, null, 'the stored value is cleared, not only masked');
  // back to album, it does not come back by itself
  assert.equal((await put({ kind: 'album' })).min_pages, null);
  assert.equal((await put({ kind: 'album', min_pages: 11 })).min_pages, 11);
});

test('operator: an invalid min_pages is 400 invalid_min_pages on create and edit, nothing written', async () => {
  const env = envOp();
  const pp = await createPP(env, { min_pages: 10 });
  const before = snapshot(env);
  for (const v of [0, -1, 201, 1.5, '10', true, false, [], {}, [10], 2 ** 53, 1e300, '']) {
    await bad(await op(env, 'POST', '/api/operator/products', { ...ALBUM, min_pages: v }), 400, 'invalid_min_pages', `POST ${JSON.stringify(v)}`);
    await bad(await op(env, 'PUT', `/api/operator/products/${pp.id}`, { name: 'changed', min_pages: v }), 400, 'invalid_min_pages', `PUT ${JSON.stringify(v)}`);
    // refused on a print too: a bad value is bad whatever the kind
    await bad(await op(env, 'POST', '/api/operator/products', { ...ALBUM, kind: 'print', min_pages: v }), 400, 'invalid_min_pages', `print ${JSON.stringify(v)}`);
  }
  assert.equal(snapshot(env), before);
});

test('only the operator writes min_pages: the photographer token is 401 there, and an adopted PUT is platform_managed', async () => {
  const env = envOp();
  const pp = await createPP(env, { min_pages: 10 });
  const mine = await adopt(env, pp);
  const before = snapshot(env);
  assert.equal((await op(env, 'PUT', `/api/operator/products/${pp.id}`, { min_pages: 3 }, SECRET)).status, 401);
  assert.equal((await op(env, 'POST', '/api/operator/products', { ...ALBUM, min_pages: 3 }, SECRET)).status, 401);
  await bad(await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { min_pages: 3 }), 400, 'platform_managed');
  await bad(await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { min_pages: null, sort: 2 }), 400, 'platform_managed');
  assert.equal(snapshot(env), before);
  // the positive case: the same PUT without it works
  assert.equal((await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { sort: 2 })).status, 200);
});

test("photographer: an adopted album shows the platform's live min_pages in the catalogue and on the platform list", async () => {
  const env = envOp();
  const pp = await createPP(env, { min_pages: 10 });
  const print = await createPP(env, { kind: 'print', name: '無框畫' });
  const mine = await adopt(env, pp);
  assert.equal(mine.min_pages, 10, 'the adopt response');
  const catalogue = async () => (await (await admin(env, 'GET', '/api/admin/products')).json()).products;
  assert.equal((await catalogue()).find(p => p.id === mine.id).min_pages, 10);
  const platform = async () => (await (await admin(env, 'GET', '/api/admin/platform-products')).json()).products;
  assert.equal((await platform()).find(p => p.id === pp.id).min_pages, 10);
  assert.equal((await platform()).find(p => p.id === print.id).min_pages, null);
  assert.ok(Object.hasOwn((await platform()).find(p => p.id === print.id), 'min_pages'));
  // a hand-edited print with a value still reads null on both photographer views
  env.DB._db.prepare('UPDATE platform_products SET min_pages = 9 WHERE id = ?').run(print.id);
  assert.equal((await platform()).find(p => p.id === print.id).min_pages, null);
  const myPrint = await adopt(env, print);
  assert.equal((await catalogue()).find(p => p.id === myPrint.id).min_pages, null);
  // the operator changes it: the photographer sees the new value at once
  await op(env, 'PUT', `/api/operator/products/${pp.id}`, { min_pages: 16 });
  assert.equal((await catalogue()).find(p => p.id === mine.id).min_pages, 16);
  assert.equal((await platform()).find(p => p.id === pp.id).min_pages, 16);
  // a PUT response on the adopted product carries it too
  const res = await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { sort: 1 });
  assert.equal((await res.json()).product.min_pages, 16);
});

test("photographer: a custom (service) product has min_pages null and a body's min_pages is ignored, never a 500", async () => {
  const env = envOp(CUSTOM_ON);
  const res = await admin(env, 'POST', '/api/admin/products', { kind: 'service', name: '加修', min_pages: 10, options: [{ price: 500 }] });
  assert.equal(res.status, 201, await res.clone().text());
  const product = (await res.json()).product;
  assert.equal(product.min_pages, null);
  const put = await admin(env, 'PUT', `/api/admin/products/${product.id}`, { min_pages: 10, name: '加修 2' });
  assert.equal(put.status, 200);
  assert.equal((await put.json()).product.min_pages, null);
});

// ─── before the migration ───────────────────────────────────────────────────

test('before the migration: operator and photographer reads work with min_pages null; creates and edits without a number work', async () => {
  const env = preEnv();
  const pp = await createPP(env);
  assert.equal(pp.min_pages, null);
  assert.equal((await createPP(env, { min_pages: null })).min_pages, null);
  // a print naming one is stored as null: nothing to refuse
  assert.equal((await createPP(env, { kind: 'print', name: '無框畫', min_pages: 5 })).min_pages, null);
  const list = await op(env, 'GET', '/api/operator/products');
  assert.equal(list.status, 200);
  assert.ok((await list.json()).products.every(p => p.min_pages === null));
  let res = await op(env, 'PUT', `/api/operator/products/${pp.id}`, { name: '相本書 2', min_pages: null });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).product.name, '相本書 2', 'the rest of the PUT landed');
  res = await op(env, 'PUT', `/api/operator/products/${pp.id}`, { kind: 'print' });
  assert.equal(res.status, 200, 'leaving album before the migration: nothing to clear');
  assert.equal(ppRow(env, pp.id).kind, 'print');
  await op(env, 'PUT', `/api/operator/products/${pp.id}`, { kind: 'album' });
  const mine = await adopt(env, pp);
  assert.equal(mine.min_pages, null);
  res = await admin(env, 'GET', '/api/admin/products');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).products[0].min_pages, null);
  res = await admin(env, 'GET', '/api/admin/platform-products');
  assert.equal(res.status, 200);
  assert.ok((await res.json()).products.every(p => p.min_pages === null));
});

test('before the migration: a create or edit that sets a number is 500 min_pages_unavailable, nothing written', async () => {
  const env = preEnv();
  const pp = await createPP(env);
  const before = snapshot(env);
  await bad(await op(env, 'POST', '/api/operator/products', { ...ALBUM, min_pages: 10 }), 500, 'min_pages_unavailable', 'POST');
  await bad(await op(env, 'PUT', `/api/operator/products/${pp.id}`, { name: 'x', min_pages: 10, options: [{ label: 'n', vendor_cost: 1, platform_price: 2 }] }), 500, 'min_pages_unavailable', 'PUT');
  assert.equal(snapshot(env), before, 'neither the product nor its options changed');
  // a bad value is still 400 first
  await bad(await op(env, 'PUT', `/api/operator/products/${pp.id}`, { min_pages: 0 }), 400, 'invalid_min_pages');
});
