// platform_products.category (Tim's choice C: a real column). A short label
// the operator gives a platform product ('婚紗相本', '無框畫', '桌框' …), used
// to group the catalogue. A string of at most CATEGORY_MAX (20) characters
// after trim, or null; '' (or only spaces) counts as null. Operator only:
// photographers see it but never write it (an adopted product's PUT is
// platform_managed). Shown wherever the platform product's name and
// description already are: the operator list/detail, the photographer's
// catalogue and platform list, and the guest shop. Before this column the
// category was only the first paragraph of the description ('【相本›婚紗相本】
// …'); the migration's second statement backfills the column from it. Its own
// hand-run migration, so every read and every write that does not set a
// category must work before it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fakeDB } from './fakes.mjs';
import { SECRET, MINE, THEIRS, setup, call, pick, save, claimed, rows, one, collectingCtx } from './pick-helpers.mjs';
import { FRESH, NO_CATEGORY, NO_EXTRA, NO_PAGES, MIN_SQL, MAX_SQL, BLEED_SQL, EXTRA_SQL, CATEGORY_SQL } from './page-schemas.mjs';

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
const statements = sql => sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);

// ─── the migration ──────────────────────────────────────────────────────────

test('migration: ALTER adding category TEXT, then one backfill UPDATE; schema.sql notes it; the fixture really lacks it', () => {
  const file = new URL('../migrations/2026-10-14-product-category.sql', import.meta.url);
  assert.ok(existsSync(file));
  const st = statements(CATEGORY_SQL);
  assert.equal(st.length, 2, 'two statements, run one by one');
  assert.equal(st[0], 'ALTER TABLE platform_products ADD COLUMN category TEXT');
  assert.match(st[1], /^UPDATE platform_products SET category = /);
  assert.match(st[1], /category IS NULL/, 'the backfill never overwrites a category already set');
  assert.match(CATEGORY_SQL, /duplicate column/i);
  assert.match(CATEGORY_SQL, /D1 Console/);
  assert.match(CATEGORY_SQL, /-- 1\./);
  assert.match(CATEGORY_SQL, /-- 2\./);
  assert.ok(FRESH.includes('2026-10-14-product-category.sql'));
  assert.ok(FRESH.includes('ALTER TABLE platform_products ADD COLUMN category TEXT;'));
  const shape = db => db._db.prepare('PRAGMA table_info(platform_products)').all();
  const cols = schema => shape(fakeDB({ schema })).map(c => c.name);
  assert.ok(cols(FRESH).includes('category'));
  assert.ok(!cols(NO_CATEGORY).includes('category') && cols(NO_CATEGORY).includes('extra_page_price'));
  assert.ok(!cols(NO_EXTRA).includes('category'));
  assert.ok(!cols(NO_PAGES).includes('category'));
  // the paste on today's database = schema.sql; all of them in order on one with none = schema.sql
  assert.deepEqual(shape(fakeDB({ schema: NO_CATEGORY + '\n' + CATEGORY_SQL })), shape(fakeDB()));
  assert.deepEqual(shape(fakeDB({ schema: NO_PAGES + '\n' + MIN_SQL + '\n' + MAX_SQL + '\n' + BLEED_SQL + '\n' + EXTRA_SQL + '\n' + CATEGORY_SQL })), shape(fakeDB()));
  const twice = fakeDB({ schema: NO_CATEGORY + '\n' + CATEGORY_SQL });
  assert.throws(() => twice._db.exec(CATEGORY_SQL), /duplicate column/);
});

test('backfill: the text after the first › up to 】, only the part before the first 、; rows without a header stay NULL', () => {
  const db = fakeDB({ schema: NO_CATEGORY });
  const ins = db._db.prepare(
    "INSERT INTO platform_products (id, kind, name, description, created_at, updated_at) VALUES (?, 'album', 'n', ?, 't', 't')");
  const cases = [
    ['wedding', '【相本›婚紗相本】\n精裝 30 頁', '婚紗相本'],
    ['two', '【相本›婚紗相本、傳記相本】\n適合婚紗與傳記', '婚紗相本'],
    ['dot', '【相本›寶寶.成長相本】\n…', '寶寶.成長相本'],
    ['travel', '【相本›旅遊.全家福相本】', '旅遊.全家福相本'],
    ['canvas', '【框畫›無框畫】\n畫布', '無框畫'],
    ['enlarge', '【框畫›放大框】', '放大框'],
    ['desk', '【框畫›桌框】 桌上型', '桌框'],
    ['spaces', '【相本› 婚紗相本 、x】', '婚紗相本'],
    ['twoArrows', '【相本›婚紗›精裝】', '婚紗›精裝'],
    ['plain', '精裝相本，30 頁', null],
    ['empty', '', null],
    ['noArrow', '【相本】婚紗', null],
    ['notFirst', '前言【相本›婚紗相本】', null],
    ['closeFirst', '【相本】說明›婚紗】', null],
    ['blank', '【相本›】', null],
    ['blankBeforeComma', '【相本›、婚紗】', null],
    ['tooLong', `【相本›${'字'.repeat(21)}】`, null],
    ['twenty', `【相本›${'字'.repeat(20)}】`, '字'.repeat(20)],
    ['newline', '【相本›婚\n紗】', null],
  ];
  for (const [id, d] of cases) ins.run(id, d);
  const [alter, backfill] = statements(CATEGORY_SQL);
  db._db.exec(alter);
  db._db.exec(backfill);
  const got = Object.fromEntries(db._db.prepare('SELECT id, category FROM platform_products').all().map(r => [r.id, r.category]));
  for (const [id, d, want] of cases) assert.equal(got[id], want, `${id}: ${JSON.stringify(d)}`);
  // the description is left as it was
  assert.equal(db._db.prepare("SELECT description FROM platform_products WHERE id = 'two'").get().description, '【相本›婚紗相本、傳記相本】\n適合婚紗與傳記');
});

test('backfill: a category already set is kept; running the UPDATE again changes nothing', () => {
  const db = fakeDB();
  const ins = db._db.prepare(
    "INSERT INTO platform_products (id, kind, name, description, category, created_at, updated_at) VALUES (?, 'album', 'n', ?, ?, 't', 't')");
  ins.run('set', '【相本›婚紗相本】', '自訂分類');
  ins.run('unset', '【相本›傳記相本】', null);
  const [, backfill] = statements(CATEGORY_SQL);
  db._db.exec(backfill);
  db._db.exec(backfill);
  const got = Object.fromEntries(db._db.prepare('SELECT id, category FROM platform_products').all().map(r => [r.id, r.category]));
  assert.deepEqual(got, { set: '自訂分類', unset: '傳記相本' });
});

// ─── operator writes and reads ──────────────────────────────────────────────

test('operator: category is created trimmed, stored and read back on albums and prints; left out, null, "" or spaces = null', async () => {
  const env = envFor();
  const album = await createPP(env, { category: '  婚紗相本 ' });
  assert.equal(album.category, '婚紗相本');
  assert.equal(ppRow(env, album.id).category, '婚紗相本');
  const print = await createPP(env, { ...PRINT, category: '無框畫' });
  assert.equal(print.category, '無框畫', 'a print keeps its category (not album-only)');
  const twenty = '字'.repeat(20);
  assert.equal((await createPP(env, { category: ` ${twenty} ` })).category, twenty, '20 characters after trim');
  const emoji = '📷'.repeat(20);
  assert.equal((await createPP(env, { category: emoji })).category, emoji, 'counted in characters, not UTF-16 units');
  const none = await createPP(env);
  assert.ok(Object.hasOwn(none, 'category'));
  assert.equal(none.category, null);
  assert.equal(ppRow(env, none.id).category, null);
  for (const v of [null, '', '   ']) {
    const p = await createPP(env, { category: v });
    assert.equal(p.category, null, JSON.stringify(v));
    assert.equal(ppRow(env, p.id).category, null, `stored ${JSON.stringify(v)}`);
  }
  const list = (await (await op(env, 'GET', '/api/operator/products')).json()).products;
  assert.equal(list.find(p => p.id === album.id).category, '婚紗相本');
  assert.equal(list.find(p => p.id === print.id).category, '無框畫');
  assert.equal(list.find(p => p.id === none.id).category, null);
});

test('operator: an invalid category is 400 invalid_category on create and edit, nothing written', async () => {
  const env = envFor();
  const pp = await createPP(env, { category: '婚紗相本' });
  const before = snapshot(env);
  for (const v of ['字'.repeat(21), ` ${'a'.repeat(21)} `, '📷'.repeat(21), 3, 0, true, false, [], ['a'], {}, '婚\n紗', 'a\u0000b', 'a\tb']) {
    await bad(await op(env, 'POST', '/api/operator/products', { ...ALBUM, category: v }), 400, 'invalid_category', `POST ${JSON.stringify(v)}`);
    await bad(await op(env, 'POST', '/api/operator/products', { ...PRINT, category: v }), 400, 'invalid_category', `print ${JSON.stringify(v)}`);
    await bad(await putPP(env, pp.id, { name: 'changed', category: v }), 400, 'invalid_category', `PUT ${JSON.stringify(v)}`);
  }
  assert.equal(snapshot(env), before);
});

test('operator PUT: category changes, clears with null or "", is kept when left out, and survives a kind change', async () => {
  const env = envFor();
  const pp = await createPP(env, { category: '婚紗相本' });
  const ok = async (body, expect) => {
    const res = await putPP(env, pp.id, body);
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await res.json()).product.category, expect, JSON.stringify(body));
    assert.equal(ppRow(env, pp.id).category, expect);
  };
  await ok({ category: '傳記相本' }, '傳記相本');
  await ok({ name: '相本書 2' }, '傳記相本');
  await ok({ kind: 'print' }, '傳記相本');
  await ok({ kind: 'album' }, '傳記相本');
  await ok({ category: ' 寶寶.成長相本 ' }, '寶寶.成長相本');
  await ok({ category: null }, null);
  await ok({ category: '桌框' }, '桌框');
  await ok({ category: '' }, null);
  await ok({ category: '放大框' }, '放大框');
  await ok({ category: '  ' }, null);
  await ok({ category: '無框畫' }, '無框畫');
  // a PUT that does not name it does not write it back
  const sqlBefore = env.DB._sql.length;
  await ok({ name: 'y' }, '無框畫');
  assert.ok(!env.DB._sql.slice(sqlBefore).some(s => /^UPDATE platform_products SET .*category/.test(s)), 'unnamed category not rewritten');
  // positive: a named one is
  const sqlNamed = env.DB._sql.length;
  await ok({ category: '桌框' }, '桌框');
  assert.ok(env.DB._sql.slice(sqlNamed).some(s => /^UPDATE platform_products SET .*category/.test(s)), 'named category written');
});

test('operator list keeps its order (active, sort, created): category does not reorder it', async () => {
  const env = envFor();
  const a = await createPP(env, { name: 'A', category: '桌框', sort: 1 });
  const b = await createPP(env, { name: 'B', category: '婚紗相本', sort: 2 });
  const c = await createPP(env, { name: 'C', category: null, sort: 0 });
  const list = (await (await op(env, 'GET', '/api/operator/products')).json()).products;
  assert.deepEqual(list.map(p => p.id), [c.id, a.id, b.id]);
  assert.deepEqual(list.map(p => p.category), [null, '桌框', '婚紗相本']);
});

// ─── only the operator writes it ────────────────────────────────────────────

test('only the operator writes category: photographer 401 on operator routes, adopted PUT is platform_managed', async () => {
  const env = envFor();
  const pp = await createPP(env, { category: '婚紗相本' });
  const mine = await adopt(env, pp);
  const before = snapshot(env);
  assert.equal((await op(env, 'PUT', `/api/operator/products/${pp.id}`, { category: '桌框' }, SECRET)).status, 401);
  assert.equal((await op(env, 'POST', '/api/operator/products', { ...ALBUM, category: '桌框' }, SECRET)).status, 401);
  assert.equal((await op(env, 'PUT', `/api/operator/products/${pp.id}`, { category: '桌框' }, null)).status, 401);
  await bad(await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { category: '桌框' }), 400, 'platform_managed', 'category');
  await bad(await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { category: null, sort: 1 }), 400, 'platform_managed', 'category null');
  await bad(await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { category: '' }), 400, 'platform_managed', 'category empty');
  assert.equal(snapshot(env), before);
  assert.equal((await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { sort: 1 })).status, 200, 'positive');
  assert.equal(ppRow(env, pp.id).category, '婚紗相本');
  // the operator can
  assert.equal((await putPP(env, pp.id, { category: '桌框' })).status, 200);
  assert.equal(ppRow(env, pp.id).category, '桌框');
});

test('a photographer adopting a product cannot smuggle a category in; a custom product reads category null', async () => {
  const env = envFor(null, { CUSTOM_PRODUCTS: 'on' });
  const pp = await createPP(env, { category: '婚紗相本' });
  const res = await admin(env, 'POST', '/api/admin/products/from-platform', {
    platform_product_id: pp.id, options: pp.options.map(o => ({ platform_option_id: o.id, price: o.platform_price * 2 })), category: '桌框',
  });
  assert.ok(res.status === 201 || res.status === 400, await res.clone().text());
  if (res.status === 201) assert.equal((await res.json()).product.category, '婚紗相本');
  assert.equal(ppRow(env, pp.id).category, '婚紗相本');
  const custom = await admin(env, 'POST', '/api/admin/products', { kind: 'service', name: '加洗', category: '桌框', options: [{ label: '', price: 100, cost: 0 }] });
  assert.equal(custom.status, 201, await custom.clone().text());
  const { product } = await custom.json();
  assert.ok(Object.hasOwn(product, 'category'));
  assert.equal(product.category, null);
});

// ─── reads on the photographer and guest side ───────────────────────────────

test("photographer views and the guest shop carry the platform's live category", async () => {
  const env = envFor();
  const pp = await createPP(env, { category: '婚紗相本' });
  const print = await createPP(env, { ...PRINT, category: '無框畫' });
  const plain = await createPP(env, { name: '無分類' });
  const mine = await adopt(env, pp);
  const myPrint = await adopt(env, print);
  const myPlain = await adopt(env, plain);
  assert.equal(mine.category, '婚紗相本', 'adopt response');
  const catalogue = async () => (await (await admin(env, 'GET', '/api/admin/products')).json()).products;
  const platform = async () => (await (await admin(env, 'GET', '/api/admin/platform-products')).json()).products;
  assert.equal((await catalogue()).find(p => p.id === mine.id).category, '婚紗相本');
  assert.equal((await catalogue()).find(p => p.id === myPrint.id).category, '無框畫');
  const plainCat = (await catalogue()).find(p => p.id === myPlain.id);
  assert.ok(Object.hasOwn(plainCat, 'category'));
  assert.equal(plainCat.category, null);
  assert.equal((await platform()).find(p => p.id === pp.id).category, '婚紗相本');
  assert.equal((await platform()).find(p => p.id === print.id).category, '無框畫');
  assert.equal((await platform()).find(p => p.id === plain.id).category, null);
  await putPP(env, pp.id, { category: '傳記相本' });
  assert.equal((await catalogue()).find(p => p.id === mine.id).category, '傳記相本', 'live, not a copy');
  // the adopted product's own row never stores one (products has no such column)
  assert.ok(!Object.hasOwn(one(env, 'SELECT * FROM products WHERE id = ?', mine.id), 'category'));
  const link = await deliveredLink(env);
  const res = await pick(env, 'GET', 'shop', link.token);
  assert.equal(res.status, 200);
  const shop = (await res.json()).products;
  assert.equal(shop.find(p => p.id === mine.id).category, '傳記相本');
  assert.equal(shop.find(p => p.id === myPrint.id).category, '無框畫');
  const plainShop = shop.find(p => p.id === myPlain.id);
  assert.ok(Object.hasOwn(plainShop, 'category'));
  assert.equal(plainShop.category, null);
  for (const p of shop) {
    assert.deepEqual(Object.keys(p).sort(),
      ['bleed_mm', 'category', 'description', 'extra_page_price', 'id', 'image_url', 'kind', 'max_pages', 'min_pages', 'name', 'options', 'photo_count'].sort());
  }
});

// ─── before the migration ───────────────────────────────────────────────────

for (const [name, schema] of [['category missing', NO_CATEGORY], ['extra_page_price and category missing', NO_EXTRA], ['every late column missing', NO_PAGES]]) {
  test(`schema "${name}": every read answers with category null`, async () => {
    const env = envFor(schema);
    const pp = await createPP(env);
    assert.ok(Object.hasOwn(pp, 'category'));
    assert.equal(pp.category, null, 'create response');
    let res = await op(env, 'GET', '/api/operator/products');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).products[0].category, null);
    const mine = await adopt(env, pp);
    assert.equal(mine.category, null);
    res = await admin(env, 'GET', '/api/admin/products');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).products[0].category, null);
    res = await admin(env, 'GET', '/api/admin/platform-products');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).products[0].category, null);
    const link = await deliveredLink(env);
    res = await pick(env, 'GET', 'shop', link.token);
    assert.equal(res.status, 200);
    const shop = (await res.json()).products;
    assert.equal(shop.length, 1, 'the shop lists the product');
    assert.ok(Object.hasOwn(shop[0], 'category'));
    assert.equal(shop[0].category, null);
  });

  test(`schema "${name}": a category is 500 category_unavailable with nothing written; null, "" and other fields write`, async () => {
    const env = envFor(schema);
    const pp = await createPP(env);
    const before = snapshot(env);
    await bad(await op(env, 'POST', '/api/operator/products', { ...ALBUM, category: '婚紗相本' }), 500, 'category_unavailable', 'POST');
    await bad(await op(env, 'POST', '/api/operator/products', { ...PRINT, category: '無框畫' }), 500, 'category_unavailable', 'POST print');
    await bad(await putPP(env, pp.id, { name: 'x', category: '桌框', options: [{ label: 'n', vendor_cost: 1, platform_price: 2 }] }), 500, 'category_unavailable', 'PUT');
    assert.equal(snapshot(env), before, 'nothing written by any 500');
    // a 400 still comes before a 500
    await bad(await putPP(env, pp.id, { category: 'x'.repeat(21) }), 400, 'invalid_category', 'bad category');
    await bad(await putPP(env, pp.id, { category: 5 }), 400, 'invalid_category', 'not a string');
    for (const v of [null, '', '  ']) {
      const res = await putPP(env, pp.id, { name: `相本書 ${JSON.stringify(v)}`, category: v });
      assert.equal(res.status, 200, await res.clone().text());
      assert.equal(ppRow(env, pp.id).name, `相本書 ${JSON.stringify(v)}`);
      assert.equal((await op(env, 'POST', '/api/operator/products', { ...ALBUM, category: v })).status, 201, `POST ${JSON.stringify(v)}`);
    }
  });
}

test('category unavailable on its own when only it is missing; the other late columns still write', async () => {
  const env = envFor(NO_CATEGORY);
  const pp = await createPP(env, { min_pages: 10, max_pages: 20, bleed_mm: 3, extra_page_price: 100 });
  assert.deepEqual([pp.min_pages, pp.max_pages, pp.bleed_mm, pp.extra_page_price, pp.category], [10, 20, 3, 100, null]);
  await bad(await putPP(env, pp.id, { bleed_mm: 4, category: '桌框' }), 500, 'category_unavailable', 'missing');
  assert.equal(ppRow(env, pp.id).bleed_mm, 3, 'nothing written');
  const res = await putPP(env, pp.id, { bleed_mm: 4 });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).product.bleed_mm, 4);
});

test('a migrated database reads category in the same single query: no column probe', async () => {
  const env = envFor();
  const pp = await createPP(env, { category: '婚紗相本' });
  await adopt(env, pp);
  const link = await deliveredLink(env);
  const probes = () => env.DB._sql.filter(s => /LIMIT 0/.test(s)).length;
  const start = probes();
  assert.equal((await op(env, 'GET', '/api/operator/products')).status, 200);
  assert.equal((await admin(env, 'GET', '/api/admin/products')).status, 200);
  assert.equal((await admin(env, 'GET', '/api/admin/platform-products')).status, 200);
  assert.equal((await pick(env, 'GET', 'shop', link.token)).status, 200);
  assert.equal((await putPP(env, pp.id, { category: '傳記相本' })).status, 200);
  assert.equal(probes(), start);
  const old = envFor(NO_CATEGORY);
  await createPP(old);
  const b = old.DB._sql.filter(s => /LIMIT 0/.test(s)).length;
  assert.equal((await op(old, 'GET', '/api/operator/products')).status, 200);
  assert.ok(old.DB._sql.filter(s => /LIMIT 0/.test(s)).length > b);
});
