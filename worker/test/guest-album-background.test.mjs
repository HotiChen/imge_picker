// S3 step 1 (docs/guest-shop.md, 「S3 第一步 — 換版型（同張數）、整本底色」):
// Layout JSON v2 takes an optional whole-book background,
// `background?: null | {type: 'color', value: <id>}`, the id from a whitelist
// of nine. The Worker rebuilds it as {type, value} after `back`, drops every
// other field, refuses anything else (type 'image' is step 2's: refused now)
// with 400 invalid_layout, and stores a layout without one byte for byte as
// before. The photographer's order read returns it; the guest's views never
// return the layout. Template switching adds no rule: the slot-count check is
// the contract (pinned here). High tier: a guest-controlled write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  WORKER, ready as readyBase, orderBody, placeOrder, myOrders, cancelOrder, orderRows, itemRows, dbSnapshot, adminOrders, code, walk,
  FINAL, OBJECTS,
} from './guest-order-helpers.mjs';

const require = createRequire(import.meta.url);

// The whitelist as the spec writes it (id → hex)
const SPEC_COLORS = {
  white: '#ffffff', cream: '#fff8ee', butter: '#fff4cc', blush: '#fde8ec', peach: '#ffe5d4',
  mint: '#e3f4e8', sky: '#e1effb', lavender: '#eee8fa', gray: '#eeeeee',
};

// the Worker's own table, read from its source
function workerColorTable() {
  const m = /const ALBUM_BACKGROUND_COLORS = new Map\(Object\.entries\((\{[\s\S]*?\})\)\);/.exec(WORKER);
  assert.ok(m, 'ALBUM_BACKGROUND_COLORS not found in worker.js (as new Map(Object.entries({...})))');
  return new Function(`return ${m[1]};`)();
}

const K = i => `${FINAL}L${String(i).padStart(3, '0')}.jpg`;
const SIZED = (i, long) => `${FINAL}${String(i).padStart(4, '0')}-${'k'.repeat(long ? 61 : 60)}.jpg`;
const SEEDED = [
  ...Array.from({ length: 40 }, (_, i) => K(i + 1)),
  ...Array.from({ length: 420 }, (_, i) => [SIZED(i, false), SIZED(i, true)]).flat(),
];
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
// a 201, then cancelled (a guest may hold only 3 open orders); the stored
// row keeps its layout text for the checks (lastLayout reads the row)
async function accepted(env, p, body, what, { keep = false } = {}) {
  const res = await placeOrder(env, p, body);
  assert.equal(res.status, 201, `${what}: ${await res.clone().text()}`);
  if (!keep) assert.equal((await cancelOrder(env, p, (await res.clone().json()).order.id)).status, 200, `${what}: cancel`);
  return res;
}
const lastLayout = env => itemRows(env).at(-1).layout;

// ─── the colour table ────────────────────────────────────────────────────────

test('the Worker\'s colour table is the spec\'s nine ids with the spec\'s hex, and the spec text still lists them', () => {
  const table = workerColorTable();
  assert.deepEqual(Object.keys(table), Object.keys(SPEC_COLORS), 'the same ids, in the spec\'s order');
  assert.deepEqual(table, SPEC_COLORS);
  const spec = readFileSync(new URL('../../docs/guest-shop.md', import.meta.url), 'utf8');
  const section = spec.slice(spec.indexOf('## S3 第一步'));
  assert.ok(section.length > 100, 'the S3 第一步 section is in docs/guest-shop.md');
  for (const [id, hex] of Object.entries(SPEC_COLORS)) assert.ok(section.includes(`\`${id} ${hex}\``), `${id} ${hex} in the spec`);
});

// The client copy (book_editor/js/import_layout.js, `ImportLayout.BACKGROUND_COLORS`
// = {id: '#hex'}, written by the photographer-side work). Until that work is in
// the tree (the file does not mention a background at all) this test is
// skipped, loudly; once the file talks about a background, a missing or
// renamed table FAILS, and any drift in an id or a hex fails.
test('parity: book_editor/js/import_layout.js ImportLayout.BACKGROUND_COLORS equals the Worker\'s table, id → hex', t => {
  const path = new URL('../../book_editor/js/import_layout.js', import.meta.url);
  const source = readFileSync(path, 'utf8');
  const ImportLayout = require('../../book_editor/js/import_layout.js');
  const table = ImportLayout && ImportLayout.BACKGROUND_COLORS;
  if (table === undefined && !/background/i.test(source)) {
    t.skip('ImportLayout.BACKGROUND_COLORS not written yet (import_layout.js has no background work): parity NOT checked');
    return;
  }
  assert.ok(table && typeof table === 'object',
    'import_layout.js mentions a background but exports no ImportLayout.BACKGROUND_COLORS {id: "#hex"}: the parity cannot be checked');
  assert.deepEqual({ ...table }, workerColorTable(), 'client and Worker colour tables drifted');
});

// ─── no background: byte-identical to before ────────────────────────────────

test('no background (absent, undefined, null): stored byte for byte as before, no background key', async () => {
  const { env, c, p } = await ready();
  const plain = layoutOf(10);
  const before = JSON.stringify(plain); // the pre-background serialisation, canonical order
  for (const [what, layout] of [
    ['absent', plain],
    ['undefined', { ...plain, background: undefined }],
    ['null', { ...plain, background: null }],
  ]) {
    await accepted(env, p, albumOrder(c, layout), what, { keep: true });
    assert.equal(lastLayout(env), before, `${what}: byte-identical`);
    assert.ok(!lastLayout(env).includes('background'), what);
  }
  const admin = await adminOrders(env);
  for (const o of admin.orders) assert.ok(!('background' in o.items[0].layout), 'admin read: no background key');
});

// ─── a colour: stored, canonical, read back by the photographer ──────────────

test('every whitelisted colour is accepted and stored as {type, value} right after back; price unchanged', async () => {
  const { env, c, p } = await ready();
  for (const id of Object.keys(SPEC_COLORS)) {
    const layout = layoutOf(10, { background: { type: 'color', value: id } });
    await accepted(env, p, albumOrder(c, layout, { total: 5000 }), id);
    assert.equal(lastLayout(env), JSON.stringify(layout), `${id}: canonical order v, mode, cover, spreads, back, background`);
    assert.ok(lastLayout(env).endsWith(`"back":null,"background":{"type":"color","value":"${id}"}}`), id);
  }
  assert.ok(itemRows(env).every(i => i.unit_price === 5000), 'the background costs nothing');
});

test('background: extra fields dropped (only type and value read), key order rebuilt, other top-level fields still dropped', async () => {
  const { env, c, p } = await ready();
  const layout = layoutOf(10, {
    background: { value: 'mint', image: 'x', photo_key: K(3), hex: '#000000', type: 'color', opacity: 0.5, nested: { a: 1 } },
    bg: 'red', backgroundImage: K(4),
  });
  await accepted(env, p, albumOrder(c, layout), 'noisy background');
  const want = { ...layoutOf(10), background: { type: 'color', value: 'mint' } };
  assert.equal(lastLayout(env), JSON.stringify(want));
  // a __proto__ key in the JSON text is just an extra own field: dropped
  const text = JSON.stringify(albumOrder(c, layoutOf(10, { background: { type: 'color', value: 'sky' } })))
    .replace('"background":{', '"background":{"__proto__":{"type":"image","value":"evil"},');
  assert.ok(text.includes('__proto__'));
  await accepted(env, p, text, '__proto__ field');
  assert.ok(lastLayout(env).endsWith('"background":{"type":"color","value":"sky"}}'));
  assert.ok(!lastLayout(env).includes('evil') && !lastLayout(env).includes('__proto__'));
});

test('the photographer\'s order read returns the background inside the parsed layout', async () => {
  const { env, c, p } = await ready();
  const layout = layoutOf(12, { background: { type: 'color', value: 'lavender' } });
  await accepted(env, p, albumOrder(c, layout, { total: 5300 }), 'lavender', { keep: true });
  const admin = await adminOrders(env);
  assert.deepEqual(admin.orders[0].items[0].layout, layout);
  assert.deepEqual(admin.orders[0].items[0].layout.background, { type: 'color', value: 'lavender' });
});

test('the guest\'s views (201, replay, GET) and the email never carry the layout or the background', async () => {
  const { env, c, p } = await ready();
  const body = albumOrder(c, layoutOf(10, { background: { type: 'color', value: 'butter' } }));
  const answers = [await placeOrder(env, p, body), await placeOrder(env, p, body), await myOrders(env, p)];
  assert.deepEqual(answers.map(r => r.status), [201, 200, 200]);
  for (const res of answers) {
    const json = await res.json();
    const { keys, values } = walk(json);
    assert.ok(keys.has('spreads'), 'the positive: the guest view is the order (spreads shown)');
    for (const k of ['layout', 'background', 'slots', 'cover']) assert.ok(!keys.has(k), k);
    assert.ok(!values.includes('butter'), 'no colour id');
  }
  const [m] = env.NOTIFY_EMAIL.sent;
  assert.ok(m, 'one email');
  assert.ok(!/butter|background/.test(m.text) && !/butter|background/.test(m.html), 'the email names no background');
});

test('the same request_id again with another background: replay, the first background stays', async () => {
  const { env, c, p } = await ready();
  const body = albumOrder(c, layoutOf(10, { background: { type: 'color', value: 'peach' } }));
  await accepted(env, p, body, 'first', { keep: true });
  const again = await placeOrder(env, p, { ...body, lines: [layoutLine(c, layoutOf(10, { background: { type: 'color', value: 'gray' } }))] });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).replay, true);
  assert.equal(orderRows(env).length, 1);
  assert.equal(itemRows(env).length, 1);
  assert.deepEqual(JSON.parse(itemRows(env)[0].layout).background, { type: 'color', value: 'peach' });
});

// ─── invalid_layout: one case per rule ───────────────────────────────────────

test('invalid_layout: background not an object (string, number, boolean, array)', async () => {
  const { env, c, p } = await ready();
  for (const background of ['white', '', 'color', 0, 1, true, false, [], [{ type: 'color', value: 'white' }], ['color', 'white']]) {
    await refused(env, p, albumOrder(c, layoutOf(10, { background })), 400, 'invalid_layout', `background ${JSON.stringify(background)}`);
  }
});

test('invalid_layout: background type \'image\' (step 2\'s, refused now), with a colour id or a final as its value', async () => {
  const { env, c, p } = await ready();
  for (const value of ['white', K(2), { photo_key: K(2) }]) {
    await refused(env, p, albumOrder(c, layoutOf(10, { background: { type: 'image', value } })), 400, 'invalid_layout', `image ${JSON.stringify(value)}`);
  }
});

test('invalid_layout: background type missing or not exactly \'color\'', async () => {
  const { env, c, p } = await ready();
  for (const type of [undefined, null, '', 'Color', 'COLOR', 'color ', ' color', 'colour', 'gradient', 'pattern', 1, true, ['color'], { type: 'color' }]) {
    await refused(env, p, albumOrder(c, layoutOf(10, { background: { type, value: 'white' } })), 400, 'invalid_layout', `type ${JSON.stringify(type)}`);
  }
});

test('invalid_layout: background value missing, not a string, or not a whitelisted id (prototype names too)', async () => {
  const { env, c, p } = await ready();
  const values = [
    undefined, null, 1, 0, true, ['white'], { id: 'white' }, { type: 'color', value: 'white' },
    '', 'White', 'WHITE', ' white', 'white ', 'grey', 'black', 'red', '#ffffff', 'ffffff', 'rgb(255,255,255)',
    'url(x)', 'white;background:url(x)', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf',
    'isPrototypeOf', '__defineGetter__', 'prototype', 'length', 'size', '0',
  ];
  for (const value of values) {
    await refused(env, p, albumOrder(c, layoutOf(10, { background: { type: 'color', value } })), 400, 'invalid_layout', `value ${JSON.stringify(value)}`);
  }
  // nested: an object where the whole background should be
  await refused(env, p, albumOrder(c, layoutOf(10, { background: { type: { type: 'color' }, value: { value: 'white' } } })), 400, 'invalid_layout', 'nested');
  // the background object itself empty
  await refused(env, p, albumOrder(c, layoutOf(10, { background: {} })), 400, 'invalid_layout', 'empty object');
  // a __proto__ wrapper hides the real fields: refused (nothing read through the prototype)
  const text = JSON.stringify(albumOrder(c, layoutOf(10, { background: {} })))
    .replace('"background":{}', '"background":{"__proto__":{"type":"color","value":"white"}}');
  assert.ok(text.includes('"__proto__":{"type"'));
  await refused(env, p, text, 400, 'invalid_layout', '__proto__ wrapper');
  // the positive on the same fixture
  await accepted(env, p, albumOrder(c, layoutOf(10, { background: { type: 'color', value: 'white' } })), 'white');
});

test('invalid_layout: type and value are read only as the object\'s own fields (a polluted Object.prototype gives none)', async () => {
  const { env, c, p } = await ready();
  // non-enumerable, so nothing else iterating objects sees it; removed after
  Object.defineProperty(Object.prototype, 'value', { value: 'white', configurable: true, writable: true });
  try {
    assert.equal(({}).value, 'white', 'the pollution is in place');
    await refused(env, p, albumOrder(c, layoutOf(10, { background: { type: 'color' } })), 400, 'invalid_layout', 'value only on the prototype');
  } finally { delete Object.prototype.value; }
  Object.defineProperty(Object.prototype, 'type', { value: 'color', configurable: true, writable: true });
  try {
    await refused(env, p, albumOrder(c, layoutOf(10, { background: { value: 'white' } })), 400, 'invalid_layout', 'type only on the prototype');
  } finally { delete Object.prototype.type; }
  assert.equal(({}).value, undefined);
  assert.equal(({}).type, undefined);
});

// ─── the size cap still applies, background included ────────────────────────

const bytes = s => new TextEncoder().encode(s).byteLength;
// 105 spreads of 4 photos with long keys and a background, exactly `size`
// bytes as the Worker serialises it; 105 spreads is over max_pages (30), so
// under the cap answers pages_above_max and over it invalid_layout
function sizedLayout(size, background) {
  const key = (i, pad) => SIZED(i, i < pad);
  const build = pad => ({
    v: 2, mode: 'auto', cover: null,
    spreads: Array.from({ length: 105 }, (_, s) => ({ template: 'quad-stacks', slots: [0, 1, 2, 3].map(j => slot(key(s * 4 + j, pad))) })),
    back: null, background,
  });
  const pad = size - bytes(JSON.stringify(build(0)));
  assert.ok(pad >= 0 && pad <= 420, `pad ${pad}`);
  const layout = build(pad);
  assert.equal(bytes(JSON.stringify(layout)), size);
  return layout;
}

test('the 64 KB cap counts the background: 65536 bytes with one reaches the page range, 65537 is refused', async () => {
  const { env, c, p } = await ready();
  const bg = { type: 'color', value: 'lavender' };
  await refused(env, p, albumOrder(c, sizedLayout(64 * 1024, bg)), 400, 'pages_above_max', '65536 bytes with a background');
  await refused(env, p, albumOrder(c, sizedLayout(64 * 1024 + 1, bg)), 400, 'invalid_layout', '65537 bytes with a background');
  // dropped background fields do not count
  const noisy = sizedLayout(64 * 1024, bg);
  noisy.background = { ...bg, junk: 'j'.repeat(2000) };
  await refused(env, p, albumOrder(c, noisy), 400, 'pages_above_max', '65536 bytes + dropped background fields');
});

// ─── template switching: the slot count is the contract ──────────────────────

test('a spread switched to another template with the same slot count (mirrored) is accepted; another slot count is refused', async () => {
  const { env, c, p } = await ready();
  const switched = layoutOf(10, { background: { type: 'color', value: 'cream' } });
  switched.spreads[2] = { template: 'pair-stagger', mirrored: true, slots: [slot(K(3)), slot(K(30))] };
  switched.spreads[5] = { template: 'triptych', slots: [slot(K(6)), slot(K(31)), slot(K(32))] };
  await accepted(env, p, albumOrder(c, switched), 'pair-portraits → pair-stagger, mirrored; 3 → triptych');
  assert.equal(lastLayout(env), JSON.stringify(switched));
  // the same photos, a template with a different slot count
  for (const template of ['one-two-right', 'hero-bleed', 'quad-stacks']) {
    const wrong = layoutOf(10);
    wrong.spreads[2] = { template, mirrored: true, slots: [slot(K(3)), slot(K(33))] };
    await refused(env, p, albumOrder(c, wrong), 400, 'invalid_layout', `2 slots on ${template}`);
  }
});

// ─── the wiring ──────────────────────────────────────────────────────────────

test('the background check reads nothing and looks ids up with a Map\'s has (no plain-object lookup)', () => {
  const v = WORKER.slice(WORKER.indexOf('function albumLayoutBackground('));
  const body = v.slice(0, v.indexOf('\n}\n'));
  assert.ok(body.length > 0, 'albumLayoutBackground found');
  assert.match(body, /ALBUM_BACKGROUND_COLORS\.has\(/);
  assert.ok(!/\.head\(|\.get\(|\.list\(|env\.|\bin\b/.test(body), 'reads nothing, no `in` lookup');
});
