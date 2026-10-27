// S3 guest album layout (docs/guest-shop.md, 「S3 — 客人相本排版：Tim 的決定與規格
// （2026-10-27…）」): POST /api/pick/orders takes an album line
// {option_id, qty, layout} with Layout JSON v2. The Worker checks the layout
// (template whitelist, slot counts, every photo in the finals of the delivery up
// now, inner photos once, fit, crop, ≤ 200 spreads, ≤ 64 KB), rebuilds it,
// prices it by layout.spreads.length and stores it in order_items.layout. The
// body may be 96 KB only when it carries an album layout. High tier: a guest
// write, money, and a guest naming photo keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  WORKER, s2Schema, ready as readyBase, printLine, albumLine, orderBody, placeOrder, myOrders, cancelOrder,
  orderRows, itemRows, dbSnapshot, adminOrders, code, walk, deliver, confirm,
  F1, F2, F3, PA, G1, FINAL, FINAL2, pick, guest, OBJECTS, FRESH,
} from './guest-order-helpers.mjs';
import { fakeBucket } from './fakes.mjs';

const require = createRequire(import.meta.url);
const SpreadTemplates = require('../../book_editor/js/spread_templates.js');

// the Worker's own table, read from its source
function workerTemplateTable() {
  const m = /const ALBUM_TEMPLATE_SLOTS = new Map\(Object\.entries\((\{[\s\S]*?\})\)\);/.exec(WORKER);
  assert.ok(m, 'ALBUM_TEMPLATE_SLOTS not found in worker.js');
  return new Function(`return ${m[1]};`)();
}

// photos under the finals folder; every layout photo must be a real object
// there (listed from R2), so ready() puts them all in the bucket
const K = i => `${FINAL}L${String(i).padStart(3, '0')}.jpg`;
const SIZED = (i, long) => `${FINAL}${String(i).padStart(4, '0')}-${'k'.repeat(long ? 61 : 60)}.jpg`;
const SEEDED = [
  ...Array.from({ length: 300 }, (_, i) => K(i + 1)),
  ...Array.from({ length: 420 }, (_, i) => [SIZED(i, false), SIZED(i, true)]).flat(),
  ...Array.from({ length: 10 }, (_, i) => `${FINAL2}n${i}.jpg`),
];
// over 1000 objects under FINAL: the listing takes two pages
const LAYOUT_OBJECTS = { ...OBJECTS, ...Object.fromEntries(SEEDED.map(k => [k, 'L'])) };
const ready = (opts = {}) => readyBase({ objects: LAYOUT_OBJECTS, ...opts });
const slot = (photo_key, over = {}) => ({ photo_key, fit: 'contain', crop: { x: 0, y: 0, scale: 1 }, ...over });
// n spreads of one photo each ('hero-bleed'), photos K(1)…K(n), cover K(1)
function layoutOf(n, over = {}) {
  return {
    v: 2, mode: 'auto',
    cover: slot(K(1), { fit: 'cover', crop: { x: 0.25, y: 0, scale: 1 } }),
    spreads: Array.from({ length: n }, (_, i) => ({ template: 'hero-bleed', slots: [slot(K(i + 1))] })),
    back: null,
    ...over,
  };
}
const layoutLine = (c, layout, over = {}) => ({ option_id: c.album.options[0].id, qty: 1, layout, ...over });
const albumOrder = (c, layout, { total = 5000, ...over } = {}) =>
  orderBody(c, { lines: [layoutLine(c, layout, over)], expected_total: total });

async function refused(env, p, body, status, want, what) {
  const before = dbSnapshot(env);
  const res = await placeOrder(env, p, body);
  assert.equal(res.status, status, `${what}: ${await res.clone().text()}`);
  assert.equal(await code(res), want, what);
  assert.equal(dbSnapshot(env), before, `${what}: nothing written`);
  return res;
}

// ─── the template table ──────────────────────────────────────────────────────

test('the Worker\'s template table matches book_editor/js/spread_templates.js: the same 43 ids, the same slot counts', () => {
  const table = workerTemplateTable();
  const library = Object.fromEntries(SpreadTemplates.TEMPLATES.map(t => [t.id, t.slots.length]));
  assert.equal(SpreadTemplates.TEMPLATES.length, 43);
  assert.deepEqual(Object.keys(table).sort(), Object.keys(library).sort());
  for (const [id, n] of Object.entries(library)) assert.equal(table[id], n, id);
});

// ─── the happy path ──────────────────────────────────────────────────────────

test('a layout album line: 201; priced by layout.spreads.length; stored as the Worker\'s own serialisation; photo_keys [] ', async () => {
  const { env, c, p } = await ready();
  const layout = layoutOf(12);
  layout.spreads[0] = { template: 'pair-portraits', mirrored: true, slots: [slot(K(1)), slot(K(13), { fit: 'cover', crop: { x: -1, y: 1, scale: 1 } })] };
  const res = await placeOrder(env, p, albumOrder(c, layout, { total: 5300, qty: 1 }));
  assert.equal(res.status, 201, await res.clone().text());
  const { order } = await res.json();
  assert.deepEqual(order.items, [{ kind: 'album', name: '相本書', option_label: '20×20', qty: 1, unit_price: 5300, photo_name: null, spreads: 12 }]);
  assert.equal(order.total, 5300);
  const [item] = itemRows(env);
  assert.equal(item.unit_price, 5300);
  assert.equal(item.list_price, 5000);
  assert.equal(item.photo_keys, '[]');
  assert.equal(item.layout, JSON.stringify(layout), 'canonical order: v, mode, cover, spreads (template, mirrored, slots), back');
  // the photographer reads it back as the object
  const admin = await adminOrders(env);
  assert.deepEqual(admin.orders[0].items[0].layout, layout);
  // the guest's own list counts the spreads, never shows the layout
  const mine = await (await myOrders(env, p)).json();
  assert.equal(mine.orders[0].items[0].spreads, 12);
  assert.ok(!walk(mine).keys.has('layout'));
});

test('the layout is rebuilt server-side: extra fields dropped everywhere, mirrored only when true, back {} or null', async () => {
  const { env, c, p } = await ready();
  const layout = layoutOf(10);
  const noisy = {
    ...layout, extra: 'x', pages: [1], unit_price: 1, source: 'all_finals', back: { color: 'red', photo_key: PA },
    cover: { ...layout.cover, photoId: 'u', slot: { x: 0 }, crop: { ...layout.cover.crop, zoom: 9 } },
    spreads: layout.spreads.map((s, i) => ({
      ...s, id: `spread-${i}`, mirrored: i === 1 ? false : (i === 2 ? true : undefined), name: '通頁滿版',
      slots: s.slots.map(x => ({ ...x, photoId: 'p', slot: { x: 0, y: 0, w: 1, h: 1, face: 'span' }, url: 'https://evil' })),
    })),
  };
  assert.equal((await placeOrder(env, p, albumOrder(c, noisy))).status, 201);
  const stored = JSON.parse(itemRows(env)[0].layout);
  const want = { ...layout, back: {} };
  want.spreads = layout.spreads.map((s, i) => (i === 2 ? { template: s.template, mirrored: true, slots: s.slots } : s));
  assert.deepEqual(stored, want);
  assert.ok(!itemRows(env)[0].layout.includes('evil') && !itemRows(env)[0].layout.includes(PA));
});

test('the cover may repeat one inner photo; cover null and back absent are fine; crop at exactly ±5 and a panorama\'s 1.6 are fine', async () => {
  const { env, c, p } = await ready();
  for (const layout of [
    layoutOf(10),                                   // cover = K(1), also spread 1
    layoutOf(10, { cover: null }),
    (({ back, ...l }) => l)(layoutOf(10)),
    layoutOf(10, { cover: slot(F2, { crop: { x: 5, y: -5, scale: 1 } }) }),
    // a 3:1 panorama on the A4 cover: cropFor gives about 1.6
    layoutOf(10, { cover: slot(F2, { fit: 'cover', crop: { x: 1.6, y: 0, scale: 1 } }) }),
  ]) {
    const res = await placeOrder(env, p, albumOrder(c, layout));
    assert.equal(res.status, 201, await res.clone().text());
    assert.equal((await cancelOrder(env, p, (await res.json()).order.id)).status, 200);
  }
});

test('layout and spreads together: equal is fine, different is 400 invalid_spreads; layout alone is fine', async () => {
  const { env, c, p } = await ready();
  const ok = await placeOrder(env, p, albumOrder(c, layoutOf(11), { total: 5150, spreads: 11 }));
  assert.equal(ok.status, 201, await ok.clone().text());
  await refused(env, p, albumOrder(c, layoutOf(11), { total: 5150, spreads: 12 }), 400, 'invalid_spreads', 'spreads 12, layout 11');
  await refused(env, p, albumOrder(c, layoutOf(11), { total: 5000, spreads: 10 }), 400, 'invalid_spreads', 'spreads 10, layout 11');
});

test('pages: layout.spreads.length goes through albumPagesProblem and the extra-page price', async () => {
  const { env, c, p } = await ready();
  for (const [n, want] of [[9, 'pages_below_min'], [0, 'pages_below_min'], [31, 'pages_above_max'], [200, 'pages_above_max']]) {
    await refused(env, p, albumOrder(c, layoutOf(n, n ? {} : { cover: null })), 400, want, `${n} spreads`);
  }
  await refused(env, p, orderBody(c, { lines: [layoutLine(c, layoutOf(11), { option_id: c.unpriced.options[0].id })], expected_total: 4000 }),
    400, 'extra_pages_unpriced', 'unpriced extra pages');
  await refused(env, p, orderBody(c, { lines: [layoutLine(c, layoutOf(10), { option_id: c.nomin.options[0].id })], expected_total: 4000 }),
    400, 'album_not_orderable', 'no minimum');
  const res = await placeOrder(env, p, albumOrder(c, layoutOf(30), { total: 5000 + 20 * 150 }));
  assert.equal(res.status, 201, await res.clone().text());
  // the price comes from the layout's count: an expected total for 10 is a price change
  await refused(env, p, albumOrder(c, layoutOf(11)), 409, 'price_changed', 'expected 10 spreads');
});

test('a layout on a print line is invalid_lines', async () => {
  const { env, c, p } = await ready();
  await refused(env, p, orderBody(c, { lines: [printLine(c, { layout: layoutOf(10) })] }), 400, 'invalid_lines', 'print + layout');
});

// ─── invalid_layout: one case per rule ───────────────────────────────────────

test('invalid_layout: shape, version, mode', async () => {
  const { env, c, p } = await ready();
  const cases = {
    'layout null': null, 'layout a string': 'auto', 'layout an array': [], 'layout a number': 2,
    'v missing': (({ v, ...l }) => l)(layoutOf(10)), 'v 1': layoutOf(10, { v: 1 }), 'v "2"': layoutOf(10, { v: '2' }),
    'mode photographer': layoutOf(10, { mode: 'photographer' }), 'mode missing': (({ mode, ...l }) => l)(layoutOf(10)),
    'spreads missing': (({ spreads, ...l }) => l)(layoutOf(10)), 'spreads an object': layoutOf(10, { spreads: { 0: 1 } }),
    'a spread not an object': layoutOf(10, { spreads: [...layoutOf(9).spreads, 'x'] }),
    'cover a string': layoutOf(10, { cover: K(1) }), 'cover an array': layoutOf(10, { cover: [] }),
    'back a string': layoutOf(10, { back: 'x' }), 'back an array': layoutOf(10, { back: [] }), 'back a number': layoutOf(10, { back: 0 }),
  };
  for (const [what, layout] of Object.entries(cases)) await refused(env, p, albumOrder(c, layout), 400, 'invalid_layout', what);
});

test('invalid_layout: template not in the whitelist (prototype names too), mirrored not a boolean', async () => {
  const { env, c, p } = await ready();
  for (const template of ['nope', '', 'Hero-Bleed', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 1, null, undefined, ['hero-bleed']]) {
    const layout = layoutOf(10);
    layout.spreads[3] = { ...layout.spreads[3], template };
    await refused(env, p, albumOrder(c, layout), 400, 'invalid_layout', `template ${JSON.stringify(template)}`);
  }
  for (const mirrored of ['yes', 1, null, {}]) {
    const layout = layoutOf(10);
    layout.spreads[3] = { ...layout.spreads[3], mirrored };
    await refused(env, p, albumOrder(c, layout), 400, 'invalid_layout', `mirrored ${JSON.stringify(mirrored)}`);
  }
});

test('invalid_layout: slot count must be the template\'s exactly; slots an array of objects', async () => {
  const { env, c, p } = await ready();
  const bad = [
    ['hero-bleed', [slot(K(4)), slot(K(90))]],
    ['hero-bleed', []],
    ['pair-portraits', [slot(K(4))]],
    ['grid-4-4', Array.from({ length: 7 }, (_, i) => slot(K(50 + i)))],
    ['grid-4-4', Array.from({ length: 9 }, (_, i) => slot(K(50 + i)))],
    ['hero-bleed', slot(K(4))],
    ['hero-bleed', undefined],
    ['hero-bleed', ['x']],
    ['hero-bleed', [null]],
  ];
  for (const [template, slots] of bad) {
    const layout = layoutOf(10);
    layout.spreads[3] = { template, slots };
    await refused(env, p, albumOrder(c, layout), 400, 'invalid_layout', `${template} ${JSON.stringify(slots)}`);
  }
  // the positive: grid-4-4 with 8
  const layout = layoutOf(10);
  layout.spreads[3] = { template: 'grid-4-4', slots: Array.from({ length: 8 }, (_, i) => slot(K(50 + i))) };
  assert.equal((await placeOrder(env, p, albumOrder(c, layout))).status, 201);
});

test('invalid_layout: a photo_key that is not a key (type, empty, control character, a folder, over 256 characters)', async () => {
  const { env, c, p } = await ready();
  for (const key of [undefined, null, 7, '', `${FINAL}a\nb.jpg`, `${FINAL}a\u0000.jpg`, `${FINAL}a .jpg`, FINAL, `${FINAL}${'x'.repeat(256)}`, { k: 1 }]) {
    for (const where of ['inner', 'cover']) {
      const layout = layoutOf(10);
      if (where === 'inner') layout.spreads[2].slots[0].photo_key = key;
      else layout.cover.photo_key = key;
      await refused(env, p, albumOrder(c, layout), 400, 'invalid_layout', `${where} ${JSON.stringify(key)}`);
    }
  }
});

test('invalid_layout: an inner photo twice (same spread or another); the cover is the one that may repeat', async () => {
  const { env, c, p } = await ready();
  const twice = layoutOf(10);
  twice.spreads[5].slots[0].photo_key = K(2);
  await refused(env, p, albumOrder(c, twice), 400, 'invalid_layout', 'K(2) on spread 2 and 6');
  const sameSpread = layoutOf(10);
  sameSpread.spreads[5] = { template: 'pair-portraits', slots: [slot(K(77)), slot(K(77))] };
  await refused(env, p, albumOrder(c, sameSpread), 400, 'invalid_layout', 'K(77) twice on one spread');
});

test('invalid_layout: fit contain|cover only; crop finite numbers within ±5, scale exactly 1', async () => {
  const { env, c, p } = await ready();
  const slotCases = [
    ['fit fill', { fit: 'fill' }], ['fit missing', { fit: undefined }], ['fit Cover', { fit: 'Cover' }],
    ['crop missing', { crop: undefined }], ['crop null', { crop: null }], ['crop an array', { crop: [0, 0, 1] }],
    ['x over 5', { crop: { x: 5.000001, y: 0, scale: 1 } }], ['x under -5', { crop: { x: -5.5, y: 0, scale: 1 } }],
    ['y over 5', { crop: { x: 0, y: 6, scale: 1 } }], ['y under -5', { crop: { x: 0, y: -5.0001, scale: 1 } }],
    ['x a string', { crop: { x: '0', y: 0, scale: 1 } }], ['y missing', { crop: { x: 0, scale: 1 } }], ['x null', { crop: { x: null, y: 0, scale: 1 } }],
    ['x huge', { crop: { x: 1e308, y: 0, scale: 1 } }],
    ['scale 2', { crop: { x: 0, y: 0, scale: 2 } }], ['scale 0.5', { crop: { x: 0, y: 0, scale: 0.5 } }],
    ['scale "1"', { crop: { x: 0, y: 0, scale: '1' } }], ['scale missing', { crop: { x: 0, y: 0 } }],
  ];
  for (const [what, over] of slotCases) {
    for (const where of ['inner', 'cover']) {
      const layout = layoutOf(10);
      if (where === 'inner') layout.spreads[4].slots[0] = { ...layout.spreads[4].slots[0], ...over };
      else layout.cover = { ...layout.cover, ...over };
      await refused(env, p, albumOrder(c, layout), 400, 'invalid_layout', `${where} ${what}`);
    }
  }
  // a crop of 1e999 parses to Infinity: refused too
  const text = JSON.stringify(albumOrder(c, layoutOf(10))).replace('"x":0.25', '"x":1e999');
  assert.ok(text.includes('1e999'));
  await refused(env, p, text, 400, 'invalid_layout', 'x Infinity');
});

test('invalid_layout: at most 200 spreads (201 refused before the page range; 200 reaches it)', async () => {
  const { env, c, p } = await ready();
  await refused(env, p, albumOrder(c, layoutOf(201)), 400, 'invalid_layout', '201 spreads');
  await refused(env, p, albumOrder(c, layoutOf(200)), 400, 'pages_above_max', '200 spreads');
});

// The serialisation the Worker stores, as this file builds it (no extra
// fields, the canonical key order): the cap is judged on these UTF-8 bytes.
const bytes = s => new TextEncoder().encode(s).byteLength;
// 105 spreads of 4 photos ('quad-stacks') with long keys, the first `pad` keys
// one character longer so the layout is exactly `size` bytes; 105 spreads is
// over max_pages (30), so a layout under the cap answers pages_above_max and
// one over it invalid_layout
function sizedLayout(size) {
  const key = (i, pad) => SIZED(i, i < pad);
  const build = pad => ({
    v: 2, mode: 'auto', cover: null,
    spreads: Array.from({ length: 105 }, (_, s) => ({ template: 'quad-stacks', slots: [0, 1, 2, 3].map(j => slot(key(s * 4 + j, pad))) })),
    back: null,
  });
  const pad = size - bytes(JSON.stringify(build(0)));
  assert.ok(pad >= 0 && pad <= 420, `pad ${pad}`);
  const layout = build(pad);
  assert.equal(bytes(JSON.stringify(layout)), size);
  return layout;
}

test('invalid_layout: the stored layout at most 64 KB (65536 bytes reaches the page range, 65537 is refused)', async () => {
  const { env, c, p } = await ready();
  const at = sizedLayout(64 * 1024);
  const body = JSON.stringify(albumOrder(c, at));
  assert.ok(bytes(body) > 32 * 1024 && bytes(body) < 96 * 1024, 'over the plain cap, under the layout cap');
  await refused(env, p, body, 400, 'pages_above_max', '65536 bytes');
  await refused(env, p, albumOrder(c, sizedLayout(64 * 1024 + 1)), 400, 'invalid_layout', '65537 bytes');
  // extra fields do not count: they are dropped before the size is judged
  const noisy = sizedLayout(64 * 1024);
  noisy.spreads.forEach(s => s.slots.forEach(x => { x.note = 'n'.repeat(20); }));
  await refused(env, p, albumOrder(c, noisy), 400, 'pages_above_max', '65536 bytes + dropped fields');
});

// ─── the finals: the same check the print lines use ──────────────────────────

test('not_in_finals: every layout photo (inner and cover) must be in the finals of the delivery up now — 403, nothing written', async () => {
  const { env, c, p } = await ready();
  const outside = [PA, G1, 'other/x.jpg', '_books/b1.json', `_thumbs/400/${F1}.thumb`, `${FINAL}../毛片/a.jpg`, `${FINAL}./f1.jpg`,
    'shoot/精修', 'shoot/精修x/f1.jpg', `/${F1}`];
  for (const key of outside) {
    for (const where of ['inner', 'cover']) {
      const layout = layoutOf(10);
      if (where === 'inner') layout.spreads[7].slots[0].photo_key = key;
      else layout.cover.photo_key = key;
      const res = await refused(env, p, albumOrder(c, layout), 403, 'not_in_finals', `${where} ${key}`);
      const text = await res.text();
      assert.ok(!text.includes(FINAL) && !/final_folders/.test(text), 'the refusal names no folder');
    }
  }
  // the positive on the same fixture
  const ok = layoutOf(10);
  ok.spreads[7].slots[0].photo_key = F3;
  assert.equal((await placeOrder(env, p, albumOrder(c, ok))).status, 201);
});

test('not_in_finals: after 更換精修 to another folder, the old finals are outside', async () => {
  const { env, c, p } = await ready();
  assert.equal((await deliver(env, p.id, [FINAL2])).status, 200);
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
  await refused(env, p, albumOrder(c, layoutOf(10)), 403, 'not_in_finals', 'old finals');
  const moved = layoutOf(10);
  moved.cover.photo_key = G1;
  moved.spreads.forEach((s, i) => { s.slots[0].photo_key = `${FINAL2}n${i}.jpg`; });
  assert.equal((await placeOrder(env, p, albumOrder(c, moved))).status, 201);
});

test('a layout order answer never carries final_folders, a folder or the stored layout (201, replay, GET)', async () => {
  const { env, c, p } = await ready();
  const body = albumOrder(c, layoutOf(10));
  const answers = [await placeOrder(env, p, body), await placeOrder(env, p, body), await myOrders(env, p)];
  assert.deepEqual(answers.map(r => r.status), [201, 200, 200]);
  for (const res of answers) {
    const json = await res.json();
    const { keys, values } = walk(json);
    for (const k of ['final_folders', 'layout', 'photo_keys', 'slots', 'cover']) assert.ok(!keys.has(k), k);
    assert.ok(!values.some(v => typeof v === 'string' && v.includes(FINAL)), 'no folder or key');
  }
});

// ─── idempotency, migration, email ───────────────────────────────────────────

test('the same request_id with a layout again: 200 {order, replay:true}, one order, one line — even with another layout', async () => {
  const { env, c, p } = await ready();
  const body = albumOrder(c, layoutOf(10));
  assert.equal((await placeOrder(env, p, body)).status, 201);
  const again = await placeOrder(env, p, { ...body, lines: [layoutLine(c, layoutOf(12))], expected_total: 5300 });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).replay, true);
  assert.equal(orderRows(env).length, 1);
  assert.equal(itemRows(env).length, 1);
  assert.equal(JSON.parse(itemRows(env)[0].layout).spreads.length, 10);
});

test('before the migration: a layout order answers 500 orders_unavailable and writes nothing', async () => {
  const { env, c, p } = await ready({ schema: s2Schema() });
  const snap = dbSnapshot(env);
  const res = await placeOrder(env, p, albumOrder(c, layoutOf(10)));
  assert.equal(res.status, 500);
  assert.equal(await code(res), 'orders_unavailable');
  assert.equal(dbSnapshot(env), snap);
});

test('the photographer\'s email names the spread count of a layout album', async () => {
  const { env, c, p } = await ready();
  assert.equal((await placeOrder(env, p, albumOrder(c, layoutOf(12), { total: 5300 }))).status, 201);
  const [m] = env.NOTIFY_EMAIL.sent;
  assert.ok(m, 'one email');
  assert.match(m.text, /相本書[^\n]*12 跨頁/);
  assert.ok(!m.text.includes(K(1)) && !m.html.includes(K(1)), 'no photo keys in the email');
});

test('the old album line (spreads, no layout) is unchanged: mode photographer, all finals', async () => {
  const { env, c, p } = await ready();
  assert.equal((await placeOrder(env, p, orderBody(c, { lines: [albumLine(c, { spreads: 12 })], expected_total: 5300 }))).status, 201);
  assert.deepEqual(JSON.parse(itemRows(env)[0].layout), { v: 1, mode: 'photographer', source: 'all_finals', spreads: 12 });
});

// ─── the body cap ────────────────────────────────────────────────────────────

const big = n => 'n'.repeat(n);
test('body cap: 32 KB without an album layout (413 max 32768), 96 KB with one (413 max 98304 past it)', async () => {
  const { env, c, p } = await ready();
  const tooLarge = async (body, max, what, headers) => {
    const before = dbSnapshot(env);
    const res = headers ? await pick(env, 'POST', 'orders', p.token, { key: p.key, body, headers }) : await placeOrder(env, p, body);
    assert.equal(res.status, 413, what);
    assert.deepEqual(await res.json(), { error: '資料太大', code: 'too_large', max }, what);
    assert.equal(res.headers.get('Cache-Control'), 'private, no-store', what);
    assert.equal(dbSnapshot(env), before, what);
  };
  // no layout: 32 KB as before, whatever the padding
  await tooLarge(JSON.stringify(orderBody(c, { note: big(33 * 1024) })), 32 * 1024, 'note 33 KB');
  await tooLarge(JSON.stringify(orderBody(c, { pad: big(60 * 1024) })), 32 * 1024, 'unknown key 60 KB');
  await tooLarge(JSON.stringify(orderBody(c, { lines: [albumLine(c, { spreads: 10, layout: null })], pad: big(40 * 1024) })), 32 * 1024, 'layout null');
  await tooLarge(JSON.stringify(orderBody(c, { lines: [albumLine(c, { spreads: 10, layout: 'x' })], pad: big(40 * 1024) })), 32 * 1024, 'layout a string');
  await tooLarge(JSON.stringify(orderBody(c, { layout: layoutOf(10), pad: big(40 * 1024) })), 32 * 1024, 'layout outside the lines');
  await tooLarge(`{"pad":"${big(40 * 1024)}"`, 32 * 1024, 'not JSON, over 32 KB');
  await tooLarge(JSON.stringify(orderBody(c)), 32 * 1024, 'a lying Content-Length', { 'Content-Length': String(40 * 1024) });
  // with a layout: up to 96 KB
  const withLayout = JSON.stringify(albumOrder(c, layoutOf(10, { pad: big(80 * 1024) })));
  assert.ok(bytes(withLayout) > 80 * 1024 && bytes(withLayout) < 96 * 1024);
  const res = await placeOrder(env, p, withLayout);
  assert.equal(res.status, 201, await res.clone().text());
  assert.ok(!itemRows(env)[0].layout.includes('nnnn'), 'the padding is not stored');
  await tooLarge(JSON.stringify(albumOrder(c, layoutOf(10, { pad: big(97 * 1024) }))), 96 * 1024, 'layout body 97 KB');
  await tooLarge(JSON.stringify(orderBody(c, { pad: big(97 * 1024) })), 96 * 1024, 'anything over 96 KB');
  await tooLarge(JSON.stringify(albumOrder(c, layoutOf(10))), 96 * 1024, 'a Content-Length over 96 KB', { 'Content-Length': String(97 * 1024) });
  // exactly at the caps
  const plain = orderBody(c);
  plain.note = '';
  const base = bytes(JSON.stringify({ ...plain, pad: '' }));
  const atPlain = JSON.stringify({ ...plain, pad: big(32 * 1024 - base) });
  assert.equal(bytes(atPlain), 32 * 1024);
  assert.equal((await placeOrder(env, p, atPlain)).status, 201, '32768 bytes without a layout is read');
  const lb = albumOrder(c, layoutOf(10));
  const lbase = bytes(JSON.stringify({ ...lb, pad: '' }));
  const atLayout = JSON.stringify({ ...lb, pad: big(96 * 1024 - lbase) });
  assert.equal(bytes(atLayout), 96 * 1024);
  const r2 = await placeOrder(env, p, atLayout);
  assert.equal(r2.status, 201, `98304 bytes with a layout is read: ${await r2.clone().text()}`);
  await tooLarge(JSON.stringify({ ...lb, pad: big(96 * 1024 - lbase + 1) }), 96 * 1024, '98305 bytes with a layout');
  await tooLarge(JSON.stringify({ ...plain, pad: big(32 * 1024 - base + 1) }), 32 * 1024, '32769 bytes without a layout');
});

test('body cap: under 32 KB a malformed body is still 400 Invalid JSON, a layout body under 32 KB is unaffected', async () => {
  const { env, c, p } = await ready();
  const res = await placeOrder(env, p, '{nope');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Invalid JSON');
  assert.equal((await placeOrder(env, p, albumOrder(c, layoutOf(10)))).status, 201);
});

// ─── every layout photo is a real object in the finals ──────────────────────

test('photo_not_found: a layout photo (inner or cover) under the finals folder but not in R2 — 404, nothing written', async () => {
  const { env, c, p } = await ready();
  for (const key of [`${FINAL}nope.jpg`, `${FINAL}other-shoot/z.jpg`, `${FINAL}${PA}`, `${FINAL}x/shoot/毛片/y.jpg`, `${FINAL}L001.JPG`, `${FINAL}L001.jpg.thumb`]) {
    for (const where of ['inner', 'cover']) {
      const layout = layoutOf(10);
      if (where === 'inner') layout.spreads[6].slots[0].photo_key = key;
      else layout.cover.photo_key = key;
      await refused(env, p, albumOrder(c, layout), 404, 'photo_not_found', `${where} ${key}`);
    }
  }
  // the positive: a real one in a sub-folder of the finals
  const sub = `${FINAL}sub/s1.jpg`;
  await env.imagepicker.put(sub, 'S');
  const layout = layoutOf(10);
  layout.spreads[6].slots[0].photo_key = sub;
  assert.equal((await placeOrder(env, p, albumOrder(c, layout))).status, 201);
});

// the bucket's list calls, by prefix
function countLists(env) {
  const seen = [];
  const list = env.imagepicker.list.bind(env.imagepicker);
  env.imagepicker.list = o => { seen.push(o?.prefix); return list(o); };
  return seen;
}

test('the finals are listed only for a layout, only the folders its photos are under, page by page', async () => {
  const env0 = await ready();
  // FINAL and FINAL2 both delivered; the layout only uses FINAL
  assert.equal((await deliver(env0.env, env0.p.id, [FINAL, FINAL2])).status, 200);
  assert.equal((await confirm(env0.env, env0.p.token, env0.p.key)).status, 200);
  const { env, c, p } = env0;
  const seen = countLists(env);
  assert.equal((await placeOrder(env, p, orderBody(c))).status, 201);
  assert.deepEqual(seen, [], 'a print order lists nothing');
  assert.equal((await placeOrder(env, p, albumOrder(c, layoutOf(10)))).status, 201);
  assert.deepEqual(seen, [FINAL, FINAL], 'FINAL only, two pages (over 1000 objects)');
  // a photo on the second page is found
  // the last one in the bucket's own order (the fake sorts with localeCompare)
  const inFinal = [...env.imagepicker._store.keys()].filter(k => k.startsWith(FINAL)).sort((x, y) => x.localeCompare(y));
  const late = inFinal[inFinal.length - 1];
  assert.ok(inFinal.length > 1000 && SEEDED.includes(late));
  const layout = layoutOf(10);
  layout.spreads[2].slots[0].photo_key = late;
  assert.equal((await placeOrder(env, p, albumOrder(c, layout))).status, 201, 'second page');
});

test('finals folders inside one another (or named twice) are listed once, as the outer one', async () => {
  const { env, c, p } = await ready();
  const sub = `${FINAL}sub/`;
  await env.imagepicker.put(`${sub}s1.jpg`, 'S');
  assert.equal((await deliver(env, p.id, [sub, FINAL, FINAL.slice(0, -1), sub])).status, 200);
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
  const seen = countLists(env);
  const layout = layoutOf(10);
  layout.spreads[3].slots[0].photo_key = `${sub}s1.jpg`;
  assert.equal((await placeOrder(env, p, albumOrder(c, layout))).status, 201);
  assert.deepEqual(seen, [FINAL, FINAL], 'FINAL alone (two pages), never sub/ again');
});

test('a finals listing that does not finish within the page cap fails closed: 500 finals_unavailable, nothing written', async () => {
  const { env, c, p } = await ready();
  // 1 object a page: far more pages than the cap
  env.imagepicker = fakeBucket(LAYOUT_OBJECTS, { pageSize: 1 });
  const seen = countLists(env);
  await refused(env, p, albumOrder(c, layoutOf(10)), 500, 'finals_unavailable', 'page cap');
  assert.equal(seen.length, 10, 'stops at the cap');
  // a listing that says truncated with no cursor: also not finished
  env.imagepicker = fakeBucket(LAYOUT_OBJECTS);
  const list = env.imagepicker.list.bind(env.imagepicker);
  env.imagepicker.list = async o => ({ ...(await list(o)), truncated: true, cursor: undefined });
  await refused(env, p, albumOrder(c, layoutOf(10)), 500, 'finals_unavailable', 'no cursor');
});

test('invalid_layout: a photo_key with a character an album may not hold (quotes, < >, backtick, backslash, bidi, BOM, lone surrogate)', async () => {
  const { env, c, p } = await ready();
  for (const ch of ['"', '<', '>', '`', '\\', '\u202e', '\u2066', '\u200e', '\u061c', '\ufeff', '\ud800', '\udfff']) {
    for (const where of ['inner', 'cover']) {
      const key = `${FINAL}a${ch}b.jpg`;
      // in R2 too, so only the character refuses it
      await env.imagepicker.put(key, 'X');
      const layout = layoutOf(10);
      if (where === 'inner') layout.spreads[1].slots[0].photo_key = key;
      else layout.cover.photo_key = key;
      await refused(env, p, albumOrder(c, layout), 400, 'invalid_layout', `${where} U+${ch.codePointAt(0).toString(16)}`);
    }
  }
  // the repro: markup in a key never reaches the database
  const evil = `${FINAL}x" onerror="alert(document.cookie)<img src=x>.jpg`;
  await env.imagepicker.put(evil, 'X');
  await refused(env, p, albumOrder(c, layoutOf(10, { cover: slot(evil) })), 400, 'invalid_layout', 'markup');
  // ' and & stay allowed, as in an album
  const fine = `${FINAL}it's & co.jpg`;
  await env.imagepicker.put(fine, 'X');
  assert.equal((await placeOrder(env, p, albumOrder(c, layoutOf(10, { cover: slot(fine) })))).status, 201);
});

// ─── the wiring ──────────────────────────────────────────────────────────────

test('the layout photos are judged by pickKeyAllowed against the finals inside guestOrderLines (no new read path)', () => {
  const route = WORKER.slice(WORKER.indexOf('async function guestOrderLines('));
  const fn = route.slice(0, route.indexOf('\n}\n'));
  assert.match(fn, /pickKeyAllowed\(\{ folders: finals \}/);
  const v = WORKER.slice(WORKER.indexOf('function albumLayoutV2('));
  const body = v.slice(0, v.indexOf('\n}\n'));
  assert.ok(body.length > 0 && !/\.head\(|\.get\(|\.list\(|env\./.test(body.replace(/ALBUM_TEMPLATE_SLOTS\.get\(/g, '')), 'the validator reads nothing');
});
