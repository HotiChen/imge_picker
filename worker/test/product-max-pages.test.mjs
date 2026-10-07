// platform_products.max_pages and the album page range (docs/products-orders.md,
// "min_pages / max_pages"). Tim: an album below its minimum is refused, never
// charged per extra spread, and the operator sets both a minimum and a
// maximum of inside spreads per album product. max_pages mirrors min_pages
// (albums only, 1–200 or null, operator only); when both are set max ≥ min,
// judged on the merged row. The two columns come from two hand-run migrations
// and must degrade independently. albumPagesProblem is the pure check the S3
// guest album order will call (no order path exists yet).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fakeDB } from './fakes.mjs';
import { SECRET, MINE, THEIRS, setup, call, pick, save, claimed, rows, one, collectingCtx } from './pick-helpers.mjs';
import { FRESH, NO_PAGES, NO_MAX, NO_MIN, MIN_SQL, MAX_SQL, BLEED_SQL, EXTRA_SQL } from './page-schemas.mjs';

const OP = 'operator-secret';
const envFor = (schema, extra = {}) => setup({ OPERATOR_TOKEN: OP, ...(schema ? { DB: fakeDB({ schema }) } : {}), ...extra });
const op = (env, method, path, body, token = OP) => call(env, path, { method, token, body });
const admin = (env, method, path, body, token = SECRET) => call(env, path, { method, token, body });

const ALBUM = { kind: 'album', name: '相本書', description: '精裝', options: [{ label: '20×20', vendor_cost: 900, platform_price: 1000 }] };
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

test('migration: a second file with one ALTER for max_pages; the min_pages file is untouched; schema.sql notes both', () => {
  const file = new URL('../migrations/2026-10-06-product-max-pages.sql', import.meta.url);
  assert.ok(existsSync(file));
  const statements = sql => sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
  assert.deepEqual(statements(MAX_SQL), ['ALTER TABLE platform_products ADD COLUMN max_pages INTEGER']);
  assert.deepEqual(statements(MIN_SQL), ['ALTER TABLE platform_products ADD COLUMN min_pages INTEGER']);
  assert.match(MAX_SQL, /duplicate column/i);
  for (const s of ['2026-10-06-product-min-pages.sql', '2026-10-06-product-max-pages.sql',
    'ALTER TABLE platform_products ADD COLUMN min_pages INTEGER;', 'ALTER TABLE platform_products ADD COLUMN max_pages INTEGER;']) {
    assert.ok(FRESH.includes(s), s);
  }
  const shape = db => db._db.prepare('PRAGMA table_info(platform_products)').all();
  const cols = schema => shape(fakeDB({ schema })).map(c => c.name);
  // the fixtures really are the states they claim
  assert.ok(cols(FRESH).includes('min_pages') && cols(FRESH).includes('max_pages'));
  assert.ok(!cols(NO_PAGES).includes('min_pages') && !cols(NO_PAGES).includes('max_pages'));
  assert.ok(cols(NO_MAX).includes('min_pages') && !cols(NO_MAX).includes('max_pages'));
  assert.ok(!cols(NO_MIN).includes('min_pages') && cols(NO_MIN).includes('max_pages'));
  // both, in order, on a database with neither = schema.sql; max alone on top of min = schema.sql
  assert.deepEqual(shape(fakeDB({ schema: NO_PAGES + '\n' + MIN_SQL + '\n' + MAX_SQL + '\n' + BLEED_SQL + '\n' + EXTRA_SQL })), shape(fakeDB()));
  assert.deepEqual(shape(fakeDB({ schema: NO_MAX + '\n' + MAX_SQL + '\n' + BLEED_SQL + '\n' + EXTRA_SQL })), shape(fakeDB()));
  const twice = fakeDB({ schema: NO_MAX + '\n' + MAX_SQL });
  assert.throws(() => twice._db.exec(MAX_SQL), /duplicate column/);
});

// ─── operator writes and reads ──────────────────────────────────────────────

test('operator: max_pages is created, stored and read back; left out or null = no maximum; print stores null', async () => {
  const env = envFor();
  const pp = await createPP(env, { min_pages: 10, max_pages: 30 });
  assert.deepEqual([pp.min_pages, pp.max_pages], [10, 30]);
  assert.deepEqual([ppRow(env, pp.id).min_pages, ppRow(env, pp.id).max_pages], [10, 30]);
  const list = await (await op(env, 'GET', '/api/operator/products')).json();
  assert.equal(list.products.find(p => p.id === pp.id).max_pages, 30);
  assert.equal((await createPP(env, { max_pages: 1 })).max_pages, 1);
  assert.equal((await createPP(env, { max_pages: 200 })).max_pages, 200);
  const none = await createPP(env);
  assert.ok(Object.hasOwn(none, 'max_pages'));
  assert.equal(none.max_pages, null);
  assert.equal((await createPP(env, { max_pages: null })).max_pages, null);
  const print = await createPP(env, { kind: 'print', name: '無框畫', max_pages: 12 });
  assert.equal(print.max_pages, null);
  assert.equal(ppRow(env, print.id).max_pages, null);
  // a hand-edited print still reads null
  env.DB._db.prepare('UPDATE platform_products SET max_pages = 9 WHERE id = ?').run(print.id);
  assert.equal((await (await op(env, 'GET', '/api/operator/products')).json()).products.find(p => p.id === print.id).max_pages, null);
});

test('operator: an invalid max_pages is 400 invalid_max_pages on create and edit, any kind, nothing written', async () => {
  const env = envFor();
  const pp = await createPP(env, { min_pages: 5, max_pages: 10 });
  const before = snapshot(env);
  for (const v of [0, -1, 201, 1.5, '10', true, false, [], {}, [10], 2 ** 53, 1e300, '']) {
    await bad(await op(env, 'POST', '/api/operator/products', { ...ALBUM, max_pages: v }), 400, 'invalid_max_pages', `POST ${JSON.stringify(v)}`);
    await bad(await putPP(env, pp.id, { name: 'changed', max_pages: v }), 400, 'invalid_max_pages', `PUT ${JSON.stringify(v)}`);
    await bad(await op(env, 'POST', '/api/operator/products', { ...ALBUM, kind: 'print', max_pages: v }), 400, 'invalid_max_pages', `print ${JSON.stringify(v)}`);
  }
  assert.equal(snapshot(env), before);
});

test('range: max_pages below min_pages is 400 invalid_page_range on create; equal is fine', async () => {
  const env = envFor();
  const before = snapshot(env);
  await bad(await op(env, 'POST', '/api/operator/products', { ...ALBUM, min_pages: 10, max_pages: 9 }), 400, 'invalid_page_range', 'POST 10..9');
  await bad(await op(env, 'POST', '/api/operator/products', { ...ALBUM, min_pages: 200, max_pages: 1 }), 400, 'invalid_page_range', 'POST 200..1');
  assert.equal(snapshot(env), before);
  const eq = await createPP(env, { min_pages: 10, max_pages: 10 });
  assert.deepEqual([eq.min_pages, eq.max_pages], [10, 10]);
  // on a print both are dropped, so there is no range to judge
  const print = await createPP(env, { kind: 'print', name: '無框畫', min_pages: 10, max_pages: 9 });
  assert.deepEqual([print.min_pages, print.max_pages], [null, null]);
});

test('range on PUT is judged on the merged row: one bound named is checked against the stored other', async () => {
  const env = envFor();
  const pp = await createPP(env, { min_pages: 10, max_pages: 20 });
  const before = snapshot(env);
  await bad(await putPP(env, pp.id, { min_pages: 21 }), 400, 'invalid_page_range', 'min above stored max');
  await bad(await putPP(env, pp.id, { max_pages: 9 }), 400, 'invalid_page_range', 'max below stored min');
  await bad(await putPP(env, pp.id, { min_pages: 15, max_pages: 14 }), 400, 'invalid_page_range', 'both named');
  await bad(await putPP(env, pp.id, { name: 'x', min_pages: 30, options: [{ label: 'n', vendor_cost: 1, platform_price: 2 }] }), 400, 'invalid_page_range', 'with other fields');
  assert.equal(snapshot(env), before, 'nothing written on any 400');
  const ok = async (body, expect) => {
    const res = await putPP(env, pp.id, body);
    assert.equal(res.status, 200, await res.clone().text());
    const { product } = await res.json();
    assert.deepEqual([product.min_pages, product.max_pages], expect, JSON.stringify(body));
    assert.deepEqual([ppRow(env, pp.id).min_pages, ppRow(env, pp.id).max_pages], expect);
  };
  await ok({ min_pages: 20 }, [20, 20]);                 // equal to the stored max
  await ok({ min_pages: 25, max_pages: 30 }, [25, 30]);  // both move together
  await ok({ max_pages: null }, [25, null]);             // no maximum: any min is fine
  await ok({ min_pages: 199 }, [199, null]);
  await ok({ min_pages: null, max_pages: 3 }, [null, 3]); // no minimum: any max is fine
  await ok({ name: '相本書 2' }, [null, 3]);               // neither named: kept
});

test('a PUT leaving album clears both bounds (stored, not only masked); coming back does not restore them', async () => {
  const env = envFor();
  const pp = await createPP(env, { min_pages: 10, max_pages: 20 });
  let res = await putPP(env, pp.id, { kind: 'print' });
  assert.equal(res.status, 200);
  assert.deepEqual([ppRow(env, pp.id).min_pages, ppRow(env, pp.id).max_pages], [null, null]);
  // a print naming an invalid range is not judged (both dropped)
  res = await putPP(env, pp.id, { min_pages: 10, max_pages: 5 });
  assert.equal(res.status, 200);
  res = await putPP(env, pp.id, { kind: 'album' });
  const { product } = await res.json();
  assert.deepEqual([product.min_pages, product.max_pages], [null, null]);
  // leaving album with a bad range in the same body is fine: both are dropped
  await putPP(env, pp.id, { min_pages: 8, max_pages: 9 });
  res = await putPP(env, pp.id, { kind: 'print', min_pages: 9, max_pages: 8 });
  assert.equal(res.status, 200);
  assert.deepEqual([ppRow(env, pp.id).min_pages, ppRow(env, pp.id).max_pages], [null, null]);
});

test("a print's hidden leftover bounds (hand edit) never count: not in the range check, not carried into album", async () => {
  const env = envFor();
  const pp = await createPP(env, { kind: 'print', name: '無框畫' });
  const leftovers = () => env.DB._db.prepare('UPDATE platform_products SET min_pages = 7, max_pages = 8 WHERE id = ?').run(pp.id);
  leftovers();
  // the operator sees null for both on a print …
  const shown = (await (await op(env, 'GET', '/api/operator/products')).json()).products.find(p => p.id === pp.id);
  assert.deepEqual([shown.min_pages, shown.max_pages], [null, null]);
  // … so turning it into an album with max 5 is no range error against a hidden min 7
  let res = await putPP(env, pp.id, { kind: 'album', max_pages: 5 });
  assert.equal(res.status, 200, await res.clone().text());
  let { product } = await res.json();
  assert.deepEqual([product.min_pages, product.max_pages], [null, 5], 'the hidden min is not inherited');
  assert.deepEqual([ppRow(env, pp.id).min_pages, ppRow(env, pp.id).max_pages], [null, 5], 'and is cleared in the row');
  // entering album without naming either clears both leftovers
  await putPP(env, pp.id, { kind: 'print' });
  leftovers();
  res = await putPP(env, pp.id, { kind: 'album' });
  ({ product } = await res.json());
  assert.deepEqual([product.min_pages, product.max_pages], [null, null]);
  assert.deepEqual([ppRow(env, pp.id).min_pages, ppRow(env, pp.id).max_pages], [null, null]);
  // a PUT that stays album still keeps what it does not name
  await putPP(env, pp.id, { min_pages: 4, max_pages: 6 });
  res = await putPP(env, pp.id, { max_pages: 9 });
  ({ product } = await res.json());
  assert.deepEqual([product.min_pages, product.max_pages], [4, 9]);
});

test('only the operator writes max_pages: photographer 401 on operator routes, adopted PUT is platform_managed', async () => {
  const env = envFor();
  const pp = await createPP(env, { min_pages: 10, max_pages: 20 });
  const mine = await adopt(env, pp);
  const before = snapshot(env);
  assert.equal((await op(env, 'PUT', `/api/operator/products/${pp.id}`, { max_pages: 30 }, SECRET)).status, 401);
  await bad(await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { max_pages: 30 }), 400, 'platform_managed', 'max');
  await bad(await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { max_pages: null, sort: 1 }), 400, 'platform_managed', 'max null');
  assert.equal(snapshot(env), before);
  assert.equal((await admin(env, 'PUT', `/api/admin/products/${mine.id}`, { sort: 1 })).status, 200, 'positive');
});

test("photographer views and the guest shop carry the platform's live max_pages", async () => {
  const env = envFor();
  const pp = await createPP(env, { min_pages: 10, max_pages: 20 });
  const print = await createPP(env, { kind: 'print', name: '無框畫' });
  const mine = await adopt(env, pp);
  const myPrint = await adopt(env, print);
  assert.equal(mine.max_pages, 20, 'adopt response');
  env.DB._db.prepare('UPDATE platform_products SET max_pages = 9 WHERE id = ?').run(print.id);
  const catalogue = async () => (await (await admin(env, 'GET', '/api/admin/products')).json()).products;
  const platform = async () => (await (await admin(env, 'GET', '/api/admin/platform-products')).json()).products;
  assert.equal((await catalogue()).find(p => p.id === mine.id).max_pages, 20);
  assert.equal((await catalogue()).find(p => p.id === myPrint.id).max_pages, null);
  assert.equal((await platform()).find(p => p.id === pp.id).max_pages, 20);
  assert.equal((await platform()).find(p => p.id === print.id).max_pages, null);
  await putPP(env, pp.id, { max_pages: 24 });
  assert.equal((await catalogue()).find(p => p.id === mine.id).max_pages, 24);
  const link = await deliveredLink(env);
  const shop = await (await pick(env, 'GET', 'shop', link.token)).json();
  assert.equal(shop.products.find(p => p.id === mine.id).max_pages, 24);
  assert.equal(shop.products.find(p => p.id === myPrint.id).max_pages, null);
});

// ─── the schema states ──────────────────────────────────────────────────────

// [name, schema, has min_pages, has max_pages]
const STATES = [
  ['both present', FRESH, true, true],
  ['min present, max missing', NO_MAX, true, false],
  ['min missing, max present', NO_MIN, false, true],
  ['both missing', NO_PAGES, false, false],
];

for (const [name, schema, hasMin, hasMax] of STATES) {
  test(`schema state "${name}": every read answers, a missing column reads null, a present one its value`, async () => {
    const env = envFor(schema);
    const pp = await createPP(env, { ...(hasMin ? { min_pages: 10 } : {}), ...(hasMax ? { max_pages: 20 } : {}) });
    const want = [hasMin ? 10 : null, hasMax ? 20 : null];
    assert.deepEqual([pp.min_pages, pp.max_pages], want, 'create response');
    const pick2 = p => [p.min_pages, p.max_pages];
    let res = await op(env, 'GET', '/api/operator/products');
    assert.equal(res.status, 200);
    assert.deepEqual(pick2((await res.json()).products[0]), want, 'operator list');
    const mine = await adopt(env, pp);
    assert.deepEqual(pick2(mine), want, 'adopt response');
    res = await admin(env, 'GET', '/api/admin/products');
    assert.equal(res.status, 200);
    assert.deepEqual(pick2((await res.json()).products[0]), want, 'admin products');
    res = await admin(env, 'GET', '/api/admin/platform-products');
    assert.equal(res.status, 200);
    assert.deepEqual(pick2((await res.json()).products[0]), want, 'platform-products');
    const link = await deliveredLink(env);
    res = await pick(env, 'GET', 'shop', link.token);
    assert.equal(res.status, 200);
    const shop = (await res.json()).products;
    assert.equal(shop.length, 1, 'the shop lists the product (not an empty fail)');
    assert.deepEqual(pick2(shop[0]), want, 'guest shop');
    // and the keys are always there
    for (const p of [shop[0], mine]) assert.ok(Object.hasOwn(p, 'min_pages') && Object.hasOwn(p, 'max_pages'));
  });

  test(`schema state "${name}": a number for a missing column is 500 <col>_unavailable with nothing written; null and present columns write`, async () => {
    const env = envFor(schema);
    const pp = await createPP(env);
    const before = snapshot(env);
    if (!hasMin) {
      await bad(await op(env, 'POST', '/api/operator/products', { ...ALBUM, min_pages: 10 }), 500, 'min_pages_unavailable', 'POST min');
      await bad(await putPP(env, pp.id, { name: 'x', min_pages: 10, options: [{ label: 'n', vendor_cost: 1, platform_price: 2 }] }), 500, 'min_pages_unavailable', 'PUT min');
    }
    if (!hasMax) {
      await bad(await op(env, 'POST', '/api/operator/products', { ...ALBUM, max_pages: 10 }), 500, 'max_pages_unavailable', 'POST max');
      await bad(await putPP(env, pp.id, { name: 'x', max_pages: 10, options: [{ label: 'n', vendor_cost: 1, platform_price: 2 }] }), 500, 'max_pages_unavailable', 'PUT max');
      // with a present min in the same body: still nothing written, not half of it
      if (hasMin) {
        await bad(await op(env, 'POST', '/api/operator/products', { ...ALBUM, min_pages: 5, max_pages: 10 }), 500, 'max_pages_unavailable', 'POST both');
        await bad(await putPP(env, pp.id, { min_pages: 5, max_pages: 10 }), 500, 'max_pages_unavailable', 'PUT both');
      }
    }
    if (!hasMin && hasMax) {
      await bad(await putPP(env, pp.id, { min_pages: 5, max_pages: 10 }), 500, 'min_pages_unavailable', 'PUT both');
    }
    assert.equal(snapshot(env), before, 'nothing written by any 500');
    // a 400 still comes before a 500
    await bad(await putPP(env, pp.id, { max_pages: 0 }), 400, 'invalid_max_pages', 'bad max');
    await bad(await putPP(env, pp.id, { min_pages: 0 }), 400, 'invalid_min_pages', 'bad min');
    // null for either works in every state, and the rest of the body lands
    let res = await putPP(env, pp.id, { name: '相本書 null', min_pages: null, max_pages: null });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(ppRow(env, pp.id).name, '相本書 null');
    assert.equal((await op(env, 'POST', '/api/operator/products', { ...ALBUM, min_pages: null, max_pages: null })).status, 201);
    // a present column takes a number
    const body = { ...(hasMin ? { min_pages: 7 } : {}), ...(hasMax ? { max_pages: 9 } : {}) };
    res = await putPP(env, pp.id, body);
    assert.equal(res.status, 200, await res.clone().text());
    const { product } = await res.json();
    assert.deepEqual([product.min_pages, product.max_pages], [hasMin ? 7 : null, hasMax ? 9 : null]);
    // leaving album works in every state
    res = await putPP(env, pp.id, { kind: 'print' });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(ppRow(env, pp.id).kind, 'print');
    if (hasMin) assert.equal(ppRow(env, pp.id).min_pages, null);
    if (hasMax) assert.equal(ppRow(env, pp.id).max_pages, null);
  });
}

test('a migrated database is read in one query: no column probe on any read or on an edit', async () => {
  const env = envFor();
  const pp = await createPP(env, { min_pages: 10, max_pages: 20 });
  await adopt(env, pp);
  const link = await deliveredLink(env);
  const probes = () => env.DB._sql.filter(s => /LIMIT 0/.test(s)).length;
  const start = probes();
  assert.equal((await op(env, 'GET', '/api/operator/products')).status, 200);
  assert.equal((await admin(env, 'GET', '/api/admin/products')).status, 200);
  assert.equal((await admin(env, 'GET', '/api/admin/platform-products')).status, 200);
  assert.equal((await pick(env, 'GET', 'shop', link.token)).status, 200);
  assert.equal((await putPP(env, pp.id, { name: 'x' })).status, 200);
  assert.equal((await putPP(env, pp.id, { min_pages: 11, max_pages: 21 })).status, 200);
  // an album created without bounds names neither column (NULL is the default)
  await createPP(env);
  assert.equal(probes(), start, 'no probe once both columns are there');
  // a PUT names only the bounds it changes: nothing else is written back
  const sqlBefore = env.DB._sql.length;
  assert.equal((await putPP(env, pp.id, { name: 'y' })).status, 200);
  assert.ok(!env.DB._sql.slice(sqlBefore).some(s => /^UPDATE platform_products SET .*(min|max)_pages/.test(s)), 'unnamed bounds not rewritten');
  // the positive: a database missing one does probe (so the count above means something)
  const old = envFor(NO_MAX);
  await createPP(old);
  const before = old.DB._sql.filter(s => /LIMIT 0/.test(s)).length;
  assert.equal((await op(old, 'GET', '/api/operator/products')).status, 200);
  assert.ok(old.DB._sql.filter(s => /LIMIT 0/.test(s)).length > before);
});

test('a column probe failing for another reason is an error, not "column missing" (no quiet null, no write)', async () => {
  // a database missing max_pages: the first read fails, so the probe runs
  const env = envFor(NO_MAX);
  const pp = await createPP(env, { min_pages: 10 });
  const before = snapshot(env);
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    if (/LIMIT 0/.test(sql)) throw new Error('D1_ERROR: Network connection lost.');
    return prepare(sql);
  };
  await assert.rejects(op(env, 'GET', '/api/operator/products'), /Network connection lost/);
  await assert.rejects(admin(env, 'GET', '/api/admin/products'), /Network connection lost/);
  await assert.rejects(putPP(env, pp.id, { min_pages: 11 }), /Network connection lost/);
  assert.equal(snapshot(env), before);
});

// ─── albumPagesProblem: the check S3 will call ──────────────────────────────

// The helper is not exported (the Worker's module exports only its handler);
// it is pure and self-contained, so the test takes its source from worker.js.
const SRC = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const found = /^function albumPagesProblem\([\s\S]*?\n}\n/m.exec(SRC);
const albumPagesProblem = found ? new Function(`${found[0]}\nreturn albumPagesProblem;`)() : null;

test('albumPagesProblem: null inside [min, max], pages_below_min / pages_above_max outside', () => {
  assert.equal(typeof albumPagesProblem, 'function', 'albumPagesProblem is in worker.js');
  const album = { kind: 'album', min_pages: 10, max_pages: 20 };
  for (const n of [10, 11, 15, 19, 20]) assert.equal(albumPagesProblem(n, album), null, String(n));
  for (const n of [0, 1, 9]) assert.equal(albumPagesProblem(n, album), 'pages_below_min', String(n));
  for (const n of [21, 200, 10_000]) assert.equal(albumPagesProblem(n, album), 'pages_above_max', String(n));
  // one bound only
  assert.equal(albumPagesProblem(5, { kind: 'album', min_pages: 10, max_pages: null }), 'pages_below_min');
  assert.equal(albumPagesProblem(500, { kind: 'album', min_pages: 10, max_pages: null }), null);
  assert.equal(albumPagesProblem(1, { kind: 'album', min_pages: null, max_pages: 3 }), null);
  assert.equal(albumPagesProblem(4, { kind: 'album', min_pages: null, max_pages: 3 }), 'pages_above_max');
  // no bounds, or bounds missing from the row (a database without the columns)
  assert.equal(albumPagesProblem(1, { kind: 'album', min_pages: null, max_pages: null }), null);
  assert.equal(albumPagesProblem(1, { kind: 'album' }), null);
  // min = max
  assert.equal(albumPagesProblem(12, { kind: 'album', min_pages: 12, max_pages: 12 }), null);
  assert.equal(albumPagesProblem(11, { kind: 'album', min_pages: 12, max_pages: 12 }), 'pages_below_min');
  assert.equal(albumPagesProblem(13, { kind: 'album', min_pages: 12, max_pages: 12 }), 'pages_above_max');
  // an inverted pair (only an operator race can store one) fits no count
  for (let n = 0; n <= 30; n++) assert.notEqual(albumPagesProblem(n, { kind: 'album', min_pages: 15, max_pages: 12 }), null, String(n));
});

test('albumPagesProblem: a count that is not a whole number from 0 is invalid_layout; bounds apply to albums only', () => {
  assert.equal(typeof albumPagesProblem, 'function');
  const album = { kind: 'album', min_pages: 1, max_pages: 20 };
  for (const n of [-1, 1.5, NaN, Infinity, '10', null, undefined, true, [10], {}, 2 ** 53]) {
    assert.equal(albumPagesProblem(n, album), 'invalid_layout', String(n));
  }
  assert.equal(albumPagesProblem(-1, { kind: 'album' }), 'invalid_layout', 'even without bounds');
  // a print or service has no page bounds, whatever the row says
  assert.equal(albumPagesProblem(1, { kind: 'print', min_pages: 10, max_pages: 20 }), null);
  assert.equal(albumPagesProblem(99, { kind: 'print', min_pages: 10, max_pages: 20 }), null);
  // a stored bound that is not a whole number is no bound
  assert.equal(albumPagesProblem(1, { kind: 'album', min_pages: '10', max_pages: 'x' }), null);
});

test('albumPagesProblem is not wired to any route yet: no order path carries a layout', () => {
  // documents the state Tim was told about: S3 is where it gets called
  // albumExtraPagesCost (itself not wired, product-extra-page-price.test.mjs)
  // calls it to refuse spreads above max_pages; that call is not a route
  const helper = /^function albumExtraPagesCost\([\s\S]*?\n}\n/m.exec(SRC);
  assert.ok(helper && helper[0].includes('albumPagesProblem('), 'the helper is there and calls it');
  const calls = SRC.replace(helper[0], '').split('albumPagesProblem(').length - 1;
  assert.equal(calls, 1, 'only the definition — wire it in S3 and update this test');
});
