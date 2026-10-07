// platform_products.extra_page_price (docs/products-orders.md,
// "extra_page_price"): NT$ per inside spread above min_pages (1 spread = 1 P;
// cover and back not counted). The option price covers the book up to
// min_pages spreads; each spread above costs extra_page_price. NULL = extra
// pages not priced. Albums only, like the page bounds (a print reads null).
// A whole number validated like every other money field (isMoney:
// 0–MONEY_MAX) or null. Operator only; shown to photographers and guests.
// Its own hand-run migration, so every read and every write that does not
// set a number must work before it. albumExtraPagesCost is the pure helper a
// future guest album order will call (no order path exists yet).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fakeDB } from './fakes.mjs';
import { SECRET, MINE, THEIRS, setup, call, pick, save, claimed, rows, one, collectingCtx } from './pick-helpers.mjs';
import { FRESH, NO_EXTRA, NO_BLEED, NO_PAGES, BLEED_SQL, MIN_SQL, MAX_SQL, EXTRA_SQL } from './page-schemas.mjs';

const OP = 'operator-secret';
const MONEY_MAX = 10_000_000;
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

test('migration: one ALTER adding extra_page_price INTEGER; schema.sql notes it; the fixture really lacks it', () => {
  const file = new URL('../migrations/2026-10-07-product-extra-page-price.sql', import.meta.url);
  assert.ok(existsSync(file));
  const statements = sql => sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
  assert.deepEqual(statements(EXTRA_SQL), ['ALTER TABLE platform_products ADD COLUMN extra_page_price INTEGER']);
  assert.match(EXTRA_SQL, /duplicate column/i);
  assert.match(EXTRA_SQL, /D1 Console/);
  assert.ok(FRESH.includes('2026-10-07-product-extra-page-price.sql'));
  assert.ok(FRESH.includes('ALTER TABLE platform_products ADD COLUMN extra_page_price INTEGER;'));
  const shape = db => db._db.prepare('PRAGMA table_info(platform_products)').all();
  const cols = schema => shape(fakeDB({ schema })).map(c => c.name);
  assert.ok(cols(FRESH).includes('extra_page_price'));
  assert.ok(!cols(NO_EXTRA).includes('extra_page_price') && cols(NO_EXTRA).includes('bleed_mm'));
  assert.ok(!cols(NO_BLEED).includes('extra_page_price'));
  assert.ok(!cols(NO_PAGES).includes('extra_page_price'));
  assert.deepEqual(shape(fakeDB({ schema: NO_EXTRA + '\n' + EXTRA_SQL })), shape(fakeDB()));
  assert.deepEqual(shape(fakeDB({ schema: NO_PAGES + '\n' + MIN_SQL + '\n' + MAX_SQL + '\n' + BLEED_SQL + '\n' + EXTRA_SQL })), shape(fakeDB()));
  const twice = fakeDB({ schema: NO_EXTRA + '\n' + EXTRA_SQL });
  assert.throws(() => twice._db.exec(EXTRA_SQL), /duplicate column/);
});

// ─── operator writes and reads ──────────────────────────────────────────────

test('operator: extra_page_price is created, stored and read back on an album; left out or null = null', async () => {
  const env = envFor();
  const album = await createPP(env, { min_pages: 10, extra_page_price: 150 });
  assert.equal(album.extra_page_price, 150);
  assert.equal(ppRow(env, album.id).extra_page_price, 150);
  for (const v of [0, 1, 999, MONEY_MAX]) assert.equal((await createPP(env, { extra_page_price: v })).extra_page_price, v, String(v));
  const none = await createPP(env);
  assert.ok(Object.hasOwn(none, 'extra_page_price'));
  assert.equal(none.extra_page_price, null);
  assert.equal(ppRow(env, none.id).extra_page_price, null);
  assert.equal((await createPP(env, { extra_page_price: null })).extra_page_price, null);
  const list = (await (await op(env, 'GET', '/api/operator/products')).json()).products;
  assert.equal(list.find(p => p.id === album.id).extra_page_price, 150);
  assert.equal(list.find(p => p.id === none.id).extra_page_price, null);
});

test('operator: albums only — a print stores and reads null, whatever it names', async () => {
  const env = envFor();
  const print = await createPP(env, { ...PRINT, extra_page_price: 150 });
  assert.equal(print.extra_page_price, null);
  assert.equal(ppRow(env, print.id).extra_page_price, null);
  // a hand-edited leftover on a print is never shown
  env.DB._db.prepare('UPDATE platform_products SET extra_page_price = 77 WHERE id = ?').run(print.id);
  const list = (await (await op(env, 'GET', '/api/operator/products')).json()).products;
  assert.equal(list.find(p => p.id === print.id).extra_page_price, null);
  // ... nor inherited when it becomes an album
  const res = await putPP(env, print.id, { kind: 'album' });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).product.extra_page_price, null);
  assert.equal(ppRow(env, print.id).extra_page_price, null);
});

test('operator: an invalid extra_page_price is 400 invalid_extra_page_price on create and edit, any kind, nothing written', async () => {
  const env = envFor();
  const pp = await createPP(env, { extra_page_price: 100 });
  const before = snapshot(env);
  for (const v of [-1, -0.5, 1.5, 0.1, MONEY_MAX + 1, 2 ** 53, 1e300, '100', '', true, false, [], {}, [100]]) {
    await bad(await op(env, 'POST', '/api/operator/products', { ...ALBUM, extra_page_price: v }), 400, 'invalid_extra_page_price', `POST ${JSON.stringify(v)}`);
    await bad(await op(env, 'POST', '/api/operator/products', { ...PRINT, extra_page_price: v }), 400, 'invalid_extra_page_price', `print ${JSON.stringify(v)}`);
    await bad(await putPP(env, pp.id, { name: 'changed', extra_page_price: v }), 400, 'invalid_extra_page_price', `PUT ${JSON.stringify(v)}`);
  }
  assert.equal(snapshot(env), before);
});

test('operator PUT: extra_page_price changes, clears with null, is kept when left out, and is cleared by leaving album', async () => {
  const env = envFor();
  const pp = await createPP(env, { extra_page_price: 100, bleed_mm: 3 });
  const ok = async (body, expect) => {
    const res = await putPP(env, pp.id, body);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await res.json()).product.extra_page_price, expect, JSON.stringify(body));
    assert.equal(ppRow(env, pp.id).extra_page_price, expect);
  };
  await ok({ extra_page_price: 200 }, 200);
  await ok({ name: '相本書 2' }, 200);
  await ok({ bleed_mm: 4 }, 200);
  await ok({ extra_page_price: 0 }, 0);
  await ok({ extra_page_price: null }, null);
  await ok({ extra_page_price: 300 }, 300);
  // a PUT that does not name it does not write it back
  const sqlBefore = env.DB._sql.length;
  await ok({ name: 'y' }, 300);
  assert.ok(!env.DB._sql.slice(sqlBefore).some(s => /^UPDATE platform_products SET .*extra_page_price/.test(s)), 'unnamed price not rewritten');
  await ok({ kind: 'print' }, null);       // leaving album clears it (like the page bounds)
  await ok({ kind: 'album' }, null);       // and coming back does not restore it
  await ok({ kind: 'album', extra_page_price: 50 }, 50);
});

test('only the operator writes extra_page_price: photographer 401 on operator routes, adopted PUT is platform_managed', async () => {
  const env = envFor();
  const pp = await createPP(env, { extra_page_price: 100 });
  const mine = await adopt(env, pp);
  const before = snapshot(env);
  assert.equal((await op(env, 'PUT', `/api/operator/products/${pp.id}`, { extra_page_price: 1 }, SECRET)).status, 401);
  assert.equal((await op(env, 'POST', '/api/operator/products', { ...ALBUM, extra_page_price: 1 }, SECRET)).status, 401);
  await bad(await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { extra_page_price: 1 }), 400, 'platform_managed', 'price');
  await bad(await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { extra_page_price: null, sort: 1 }), 400, 'platform_managed', 'price null');
  assert.equal(snapshot(env), before);
  assert.equal((await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { sort: 1 })).status, 200, 'positive');
});

test("photographer views and the guest shop carry the platform's live extra_page_price (albums), never a cost", async () => {
  const env = envFor();
  const pp = await createPP(env, { min_pages: 10, extra_page_price: 150 });
  const print = await createPP(env, { ...PRINT });
  const plain = await createPP(env, { name: '不加頁' });
  const mine = await adopt(env, pp);
  const myPrint = await adopt(env, print);
  const myPlain = await adopt(env, plain);
  assert.equal(mine.extra_page_price, 150, 'adopt response');
  // a hand-edited leftover on the print stays hidden everywhere
  env.DB._db.prepare('UPDATE platform_products SET extra_page_price = 77 WHERE id = ?').run(print.id);
  const catalogue = async () => (await (await admin(env, 'GET', '/api/admin/products')).json()).products;
  const platform = async () => (await (await admin(env, 'GET', '/api/admin/platform-products')).json()).products;
  assert.equal((await catalogue()).find(p => p.id === mine.id).extra_page_price, 150);
  assert.equal((await catalogue()).find(p => p.id === myPrint.id).extra_page_price, null);
  assert.equal((await catalogue()).find(p => p.id === myPlain.id).extra_page_price, null);
  assert.equal((await platform()).find(p => p.id === pp.id).extra_page_price, 150);
  assert.equal((await platform()).find(p => p.id === print.id).extra_page_price, null);
  await putPP(env, pp.id, { extra_page_price: 180 });
  assert.equal((await catalogue()).find(p => p.id === mine.id).extra_page_price, 180, 'live, not a copy');
  const link = await deliveredLink(env);
  const res = await pick(env, 'GET', 'shop', link.token);
  assert.equal(res.status, 200);
  const shop = (await res.json()).products;
  assert.equal(shop.find(p => p.id === mine.id).extra_page_price, 180);
  assert.equal(shop.find(p => p.id === myPrint.id).extra_page_price, null);
  const plainShop = shop.find(p => p.id === myPlain.id);
  assert.ok(Object.hasOwn(plainShop, 'extra_page_price'));
  assert.equal(plainShop.extra_page_price, null);
  for (const p of shop) {
    assert.deepEqual(Object.keys(p).sort(),
      ['bleed_mm', 'description', 'extra_page_price', 'id', 'image_url', 'kind', 'max_pages', 'min_pages', 'name', 'options', 'photo_count'].sort());
    for (const o of p.options) assert.deepEqual(Object.keys(o).sort(), ['id', 'label', 'price']);
  }
  assert.doesNotMatch(JSON.stringify(shop), /cost|platform_price|vendor/);
});

test('a custom product (service) has extra_page_price null', async () => {
  const env = envFor(null, { CUSTOM_PRODUCTS: 'on' });
  const res = await admin(env, 'POST', '/api/admin/products', { kind: 'service', name: '加洗', extra_page_price: 3, options: [{ label: '', price: 100, cost: 0 }] });
  assert.equal(res.status, 201, await res.clone().text());
  const { product } = await res.json();
  assert.ok(Object.hasOwn(product, 'extra_page_price'));
  assert.equal(product.extra_page_price, null);
});

// ─── before the migration ───────────────────────────────────────────────────

for (const [name, schema] of [['extra_page_price missing', NO_EXTRA], ['bleed and extra_page_price missing', NO_BLEED], ['every late column missing', NO_PAGES]]) {
  test(`schema "${name}": every read answers with extra_page_price null`, async () => {
    const env = envFor(schema);
    const pp = await createPP(env);
    assert.ok(Object.hasOwn(pp, 'extra_page_price'));
    assert.equal(pp.extra_page_price, null, 'create response');
    let res = await op(env, 'GET', '/api/operator/products');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).products[0].extra_page_price, null);
    const mine = await adopt(env, pp);
    assert.equal(mine.extra_page_price, null);
    res = await admin(env, 'GET', '/api/admin/products');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).products[0].extra_page_price, null);
    res = await admin(env, 'GET', '/api/admin/platform-products');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).products[0].extra_page_price, null);
    const link = await deliveredLink(env);
    res = await pick(env, 'GET', 'shop', link.token);
    assert.equal(res.status, 200);
    const shop = (await res.json()).products;
    assert.equal(shop.length, 1, 'the shop lists the product');
    assert.ok(Object.hasOwn(shop[0], 'extra_page_price'));
    assert.equal(shop[0].extra_page_price, null);
  });

  test(`schema "${name}": a number is 500 extra_page_price_unavailable with nothing written; null and other fields write`, async () => {
    const env = envFor(schema);
    const pp = await createPP(env);
    const before = snapshot(env);
    await bad(await op(env, 'POST', '/api/operator/products', { ...ALBUM, extra_page_price: 100 }), 500, 'extra_page_price_unavailable', 'POST');
    await bad(await op(env, 'POST', '/api/operator/products', { ...ALBUM, extra_page_price: 0 }), 500, 'extra_page_price_unavailable', 'POST 0');
    await bad(await putPP(env, pp.id, { name: 'x', extra_page_price: 100, options: [{ label: 'n', vendor_cost: 1, platform_price: 2 }] }), 500, 'extra_page_price_unavailable', 'PUT');
    assert.equal(snapshot(env), before, 'nothing written by any 500');
    // a 400 still comes before a 500
    await bad(await putPP(env, pp.id, { extra_page_price: -1 }), 400, 'invalid_extra_page_price', 'bad price');
    let res = await putPP(env, pp.id, { name: '相本書 null', extra_page_price: null });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(ppRow(env, pp.id).name, '相本書 null');
    assert.equal((await op(env, 'POST', '/api/operator/products', { ...ALBUM, extra_page_price: null })).status, 201);
    // a print stores null anyway: nothing to write, no 500
    assert.equal((await op(env, 'POST', '/api/operator/products', { ...PRINT, extra_page_price: 100 })).status, 201);
  });
}

test('extra_page_price unavailable on its own when only it is missing; the other late columns still write', async () => {
  const env = envFor(NO_EXTRA);
  const pp = await createPP(env, { min_pages: 10, max_pages: 20, bleed_mm: 3 });
  assert.deepEqual([pp.min_pages, pp.max_pages, pp.bleed_mm, pp.extra_page_price], [10, 20, 3, null]);
  await bad(await putPP(env, pp.id, { bleed_mm: 4, extra_page_price: 5 }), 500, 'extra_page_price_unavailable', 'missing');
  assert.equal(ppRow(env, pp.id).bleed_mm, 3, 'nothing written');
  const res = await putPP(env, pp.id, { bleed_mm: 4 });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).product.bleed_mm, 4);
});

test('a migrated database reads extra_page_price in the same single query: no column probe', async () => {
  const env = envFor();
  const pp = await createPP(env, { extra_page_price: 100 });
  await adopt(env, pp);
  const link = await deliveredLink(env);
  const probes = () => env.DB._sql.filter(s => /LIMIT 0/.test(s)).length;
  const start = probes();
  assert.equal((await op(env, 'GET', '/api/operator/products')).status, 200);
  assert.equal((await admin(env, 'GET', '/api/admin/products')).status, 200);
  assert.equal((await admin(env, 'GET', '/api/admin/platform-products')).status, 200);
  assert.equal((await pick(env, 'GET', 'shop', link.token)).status, 200);
  assert.equal((await putPP(env, pp.id, { extra_page_price: 120 })).status, 200);
  assert.equal(probes(), start);
  const old = envFor(NO_EXTRA);
  await createPP(old);
  const b = old.DB._sql.filter(s => /LIMIT 0/.test(s)).length;
  assert.equal((await op(old, 'GET', '/api/operator/products')).status, 200);
  assert.ok(old.DB._sql.filter(s => /LIMIT 0/.test(s)).length > b);
});

// ─── albumExtraPagesCost: the helper a guest album order will call ──────────

// Not exported (the Worker exports only its handler); pure, and calls only
// albumPagesProblem, so the test takes both sources from worker.js.
const SRC = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const fn = name => (new RegExp(`^function ${name}\\([\\s\\S]*?\\n}\\n`, 'm').exec(SRC) || [''])[0];
const albumExtraPagesCost = fn('albumExtraPagesCost')
  ? new Function(`${fn('albumPagesProblem')}\n${fn('albumExtraPagesCost')}\nreturn albumExtraPagesCost;`)()
  : null;

test('albumExtraPagesCost: spreads above min_pages × extra_page_price; none at or below min', () => {
  assert.equal(typeof albumExtraPagesCost, 'function', 'albumExtraPagesCost is in worker.js');
  const album = { kind: 'album', min_pages: 10, max_pages: 30, extra_page_price: 150 };
  assert.deepEqual(albumExtraPagesCost(album, 10), { extraPages: 0, cost: 0 });
  assert.deepEqual(albumExtraPagesCost(album, 11), { extraPages: 1, cost: 150 });
  assert.deepEqual(albumExtraPagesCost(album, 17), { extraPages: 7, cost: 1050 });
  assert.deepEqual(albumExtraPagesCost(album, 30), { extraPages: 20, cost: 3000 });
  // below min: no extra pages (the order is refused by albumPagesProblem, not here)
  assert.deepEqual(albumExtraPagesCost(album, 3), { extraPages: 0, cost: 0 });
  assert.deepEqual(albumExtraPagesCost(album, 1), { extraPages: 0, cost: 0 });
  // price 0: extra pages counted, free
  assert.deepEqual(albumExtraPagesCost({ ...album, extra_page_price: 0 }, 12), { extraPages: 2, cost: 0 });
  // min_pages null (or missing, or not a whole number) = 0: every spread is extra
  assert.deepEqual(albumExtraPagesCost({ kind: 'album', min_pages: null, max_pages: null, extra_page_price: 100 }, 5), { extraPages: 5, cost: 500 });
  assert.deepEqual(albumExtraPagesCost({ kind: 'album', extra_page_price: 100 }, 1), { extraPages: 1, cost: 100 });
  assert.deepEqual(albumExtraPagesCost({ kind: 'album', min_pages: '10', extra_page_price: 100 }, 3), { extraPages: 3, cost: 300 });
  // min = max
  assert.deepEqual(albumExtraPagesCost({ kind: 'album', min_pages: 12, max_pages: 12, extra_page_price: 9 }, 12), { extraPages: 0, cost: 0 });
});

test('albumExtraPagesCost: null when not priced, not an album, spreads not a positive whole number, above max, or past safe integers', () => {
  assert.equal(typeof albumExtraPagesCost, 'function');
  const album = { kind: 'album', min_pages: 10, max_pages: 30, extra_page_price: 150 };
  // not priced
  for (const p of [null, undefined, -1, 1.5, '150', NaN, true]) assert.equal(albumExtraPagesCost({ ...album, extra_page_price: p }, 12), null, `price ${String(p)}`);
  assert.equal(albumExtraPagesCost({ kind: 'album', min_pages: 10 }, 12), null, 'no field at all');
  // not an album
  assert.equal(albumExtraPagesCost({ ...album, kind: 'print' }, 12), null);
  assert.equal(albumExtraPagesCost(null, 12), null);
  assert.equal(albumExtraPagesCost(undefined, 12), null);
  // spreads not a positive whole number
  for (const n of [0, -1, 1.5, NaN, Infinity, '12', null, undefined, [12], 2 ** 53]) assert.equal(albumExtraPagesCost(album, n), null, `spreads ${String(n)}`);
  // above max: albumPagesProblem's pages_above_max → null
  assert.equal(albumExtraPagesCost(album, 31), null);
  assert.equal(albumExtraPagesCost(album, 1000), null);
  assert.equal(albumExtraPagesCost({ kind: 'album', min_pages: null, max_pages: 3, extra_page_price: 1 }, 4), null);
  assert.deepEqual(albumExtraPagesCost({ kind: 'album', min_pages: null, max_pages: 3, extra_page_price: 1 }, 3), { extraPages: 3, cost: 3 });
  // overflow: never a cost outside the safe-integer range
  const huge = { kind: 'album', min_pages: null, max_pages: null, extra_page_price: 10_000_000 };
  assert.equal(albumExtraPagesCost(huge, 2 ** 40), null);
  assert.equal(albumExtraPagesCost(huge, Number.MAX_SAFE_INTEGER), null);
  const edge = Math.floor(Number.MAX_SAFE_INTEGER / 10_000_000);
  assert.deepEqual(albumExtraPagesCost(huge, edge), { extraPages: edge, cost: edge * 10_000_000 });
  assert.equal(albumExtraPagesCost(huge, edge + 1), null);
});

test('albumExtraPagesCost is wired into the guest order path only (S2: POST /api/pick/orders, guestOrderLines)', () => {
  const calls = SRC.match(/albumExtraPagesCost\(/g) || [];
  assert.equal(calls.length, 2, 'its definition and one call');
  const guest = /^async function guestOrderLines\([\s\S]*?\n}\n/m.exec(SRC);
  assert.ok(guest && guest[0].includes('albumExtraPagesCost('), 'the one call is in guestOrderLines');
});
