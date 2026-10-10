// The platform catalogue seed copied from the print lab's shop (photo-art-1.com,
// 印像網, read 2026-10-10): worker/seed/photo-art-catalogue.mjs. These tests run
// every seed payload through the real operator route, so a rule the Worker
// enforces (name ≤ 60, description ≤ 500, whole-NT$ money, ...) cannot drift
// away from the seed unnoticed. The seed is reviewed by Tim before it is
// applied (worker/seed/import-catalogue.mjs, dry run by default).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRODUCTS, CATEGORIES, toPayload, sourceIds } from '../seed/photo-art-catalogue.mjs';
import { buildPlan, applyPlan } from '../seed/import-catalogue.mjs';
import { setup, call, rows } from './pick-helpers.mjs';

const OP = 'operator-secret';
const envOp = () => setup({ OPERATOR_TOKEN: OP });
const post = (env, body) => call(env, '/api/operator/products', { method: 'POST', token: OP, body });

// Every product id the shop lists under 相本 (49) and 相框 (27) on 2026-10-10.
// A shop duplicate (353/354; 121/123/181) is merged into one seed product, so
// it still has to be counted here.
const SHOP_IDS = [
  562, 573, 578, 482, 479, 478, 480, 477, 483, 57, 472, 566, 564, 527, 180, 49, 353, 354, 181, 123, 121,
  572, 46, 62, 169, 499, 33, 558, 108, 545, 559, 552, 551, 549, 548, 546, 544, 542, 540, 537, 358, 504,
  312, 280, 516, 130, 543, 535, 530,
  561, 575, 42, 351, 97, 187, 438, 54, 569, 171, 521, 205, 524, 348, 501, 522, 526, 118, 520, 79, 519,
  77, 533, 117, 536, 532, 555,
];

test('the seed covers every shop product exactly once', () => {
  assert.equal(SHOP_IDS.length, 76);
  assert.equal(new Set(SHOP_IDS).size, 76);
  const seen = sourceIds();
  assert.deepEqual([...seen].sort((a, b) => a - b), [...SHOP_IDS].sort((a, b) => a - b));
  assert.equal(seen.length, new Set(seen).size, 'a shop id is in two seed products');
});

test('every seed payload is accepted by the operator route', async () => {
  const env = envOp();
  assert.ok(PRODUCTS.length >= 70, `only ${PRODUCTS.length} products`);
  for (const p of PRODUCTS) {
    const res = await post(env, toPayload(p, 0));
    assert.equal(res.status, 201, `${p.name}: ${await res.clone().text()}`);
  }
  const stored = rows(env, 'SELECT name, kind, min_pages FROM platform_products');
  assert.equal(stored.length, PRODUCTS.length);
});

test('names are unique and every product has a priced option', () => {
  const names = PRODUCTS.map(p => p.name);
  assert.equal(new Set(names).size, names.length);
  for (const p of PRODUCTS) {
    assert.ok(p.opts.length >= 1, p.name);
    for (const o of p.opts) assert.ok(Number.isSafeInteger(o.price) && o.price > 0, `${p.name} / ${o.size}`);
  }
});

test('category is written into the description and the sort order follows the categories', () => {
  const order = [];
  PRODUCTS.forEach((p, i) => {
    assert.ok(p.subs.length >= 1, p.name);
    for (const s of p.subs) assert.ok(CATEGORIES[s], `${p.name}: unknown subcategory ${s}`);
    const body = toPayload(p, i);
    const [top, sub] = [CATEGORIES[p.subs[0]], p.subs[0]];
    assert.ok(body.description.startsWith(`【${top}›${p.subs.join('、')}】`), `${p.name}: ${body.description.slice(0, 30)}`);
    assert.ok(sub);
    order.push(Object.keys(CATEGORIES).indexOf(p.subs[0]));
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'products are not grouped by subcategory');
});

test('nothing the shop does not publish is invented: no bleed, no extra-page price, no page maximum', () => {
  for (const [i, p] of PRODUCTS.entries()) {
    const body = toPayload(p, i);
    assert.ok(!('bleed_mm' in body), `${p.name} has bleed_mm`);
    assert.ok(!('extra_page_price' in body), `${p.name} has extra_page_price`);
    assert.ok(!('max_pages' in body), `${p.name} has max_pages`);
  }
});

test('albums carry the shop\'s 15-spread base as min_pages, prints carry none', () => {
  for (const [i, p] of PRODUCTS.entries()) {
    const body = toPayload(p, i);
    if (p.kind === 'album') assert.equal(body.min_pages, 15, p.name);
    else assert.ok(!('min_pages' in body), p.name);
  }
});

test('a price worked out from the shop\'s other pages is flagged in the description', () => {
  let flagged = 0;
  for (const [i, p] of PRODUCTS.entries()) {
    const body = toPayload(p, i);
    const inferred = p.opts.filter(o => o.how === 'inferred');
    if (inferred.length) {
      flagged++;
      // the add-page line also says 待確認, so look for the price line itself,
      // and for every inferred size on it
      const line = body.description.split('｜').find(s => s.startsWith('價格待確認：'));
      assert.ok(line, `${p.name}: no 價格待確認 line`);
      for (const o of inferred) assert.ok(line.includes(o.size), `${p.name}: ${o.size} not listed as unconfirmed`);
    } else {
      assert.ok(!body.description.includes('價格待確認：'), `${p.name}: flagged without an inferred price`);
    }
  }
  assert.ok(flagged >= 10, `expected the multi-size albums to be flagged, got ${flagged}`);
});

test('vendor cost and platform price are the shop price, never below it', () => {
  for (const [i, p] of PRODUCTS.entries()) {
    const body = toPayload(p, i);
    body.options.forEach((o, j) => {
      assert.equal(o.vendor_cost, p.opts[j].price, p.name);
      assert.equal(o.platform_price, p.opts[j].price, p.name);
    });
  }
});

test('only the discontinued shop items are marked for retirement', () => {
  const retired = PRODUCTS.filter(p => p.retire).map(p => p.src.join('/')).sort();
  assert.deepEqual(retired, ['532', '540', '544', '545']);
});

// ── the import script (worker/seed/import-catalogue.mjs) ────────────────────

test('the plan skips a product whose name is already in the catalogue', () => {
  const taken = [PRODUCTS[0].name, PRODUCTS[5].name, '別的商品'];
  const plan = buildPlan(PRODUCTS, taken);
  assert.equal(plan.skip.length, 2);
  assert.deepEqual(plan.skip.map(s => s.name), [PRODUCTS[0].name, PRODUCTS[5].name]);
  assert.equal(plan.create.length, PRODUCTS.length - 2);
  // the sort position is the seed's, not the position among the products still to create
  const second = plan.create.find(c => c.name === PRODUCTS[1].name);
  assert.equal(second.body.sort, 10);
  assert.equal(buildPlan(PRODUCTS, []).create.length, PRODUCTS.length);
});

test('applying the plan creates every product, then retires the discontinued ones only', async () => {
  const env = envOp();
  const sent = [];
  const api = async (method, path, body) => {
    sent.push(`${method} ${path.replace(/[0-9a-f-]{36}/, ':id')}`);
    const res = await call(env, path, { method, token: OP, body });
    return { status: res.status, data: await res.json() };
  };
  const result = await applyPlan(buildPlan(PRODUCTS, []), api);
  assert.equal(result.created, PRODUCTS.length);
  assert.equal(result.retired, 4);
  assert.equal(sent.filter(s => s === 'POST /api/operator/products').length, PRODUCTS.length);
  assert.equal(sent.filter(s => s === 'POST /api/operator/products/:id/retire').length, 4);
  const active = rows(env, 'SELECT active, COUNT(*) AS n FROM platform_products GROUP BY active')
    .map(r => [r.active, r.n]).sort();
  assert.deepEqual(active, [[0, 4], [1, PRODUCTS.length - 4]]);
  // a second run finds nothing left to create
  const again = buildPlan(PRODUCTS, rows(env, 'SELECT name FROM platform_products').map(r => r.name));
  assert.equal(again.create.length, 0);
  assert.equal(again.skip.length, PRODUCTS.length);
});

test('applying stops at the first refusal and says which product', async () => {
  let n = 0;
  const api = async () => (++n === 3 ? { status: 500, data: { code: 'min_pages_unavailable' } } : { status: 201, data: { product: { id: `p${n}` } } });
  await assert.rejects(applyPlan(buildPlan(PRODUCTS, []), api), err => {
    assert.match(err.message, new RegExp(PRODUCTS[2].name.replace(/[()]/g, '\\$&')));
    assert.match(err.message, /min_pages_unavailable/);
    return true;
  });
  assert.equal(n, 3, 'it kept going after a refusal');
});

test('a product that was made but could not be retired is reported, not skipped over', async () => {
  const discontinued = PRODUCTS.find(p => p.retire);
  const api = async (method, path) => (path.endsWith('/retire')
    ? { status: 500, data: { code: 'db_down' } }
    : { status: 201, data: { product: { id: 'p1' } } });
  await assert.rejects(applyPlan(buildPlan([discontinued], []), api), err => {
    assert.match(err.message, /已建立但下架失敗/);
    assert.ok(err.message.includes(discontinued.name));
    return true;
  });
});
