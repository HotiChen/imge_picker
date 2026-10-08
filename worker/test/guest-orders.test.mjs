// S2 guest ordering (docs/guest-shop.md, 「S2 客人自助訂購」 + 「S2 — Tim 的
// 決定」): the contract, the money, the state matrix, the photographer's side
// and everything before the migration. The abuse cases of §7 are one test
// each in guest-orders-security.test.mjs. High tier: guest-triggered writes,
// money totals, personal data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDB } from './fakes.mjs';
import {
  WORKER, MIGRATION, MIGRATION_FILE, statementsOf, s2Schema, envOf, catalogue, confirmed, ready, printLine, albumLine,
  orderBody, placeOrder, myOrders, cancelOrder, placed, orderRows, itemRows, dbSnapshot, adminOrders, code,
  F1, F2, F3, PA, FINAL, FINAL2, FRESH, fakeMailer, admin, deliver, confirm, retouching, delivered, SECRET, call, pick,
  rows, one, landOnce, S2_ORDER_COLUMNS, S2_ITEM_COLUMNS, S2_SETTINGS_COLUMNS,
} from './guest-order-helpers.mjs';

const mail = env => env.NOTIFY_EMAIL.sent;
const GUEST_VIEW_KEYS = ['cancelled_at', 'confirmed_at', 'contact', 'created_at', 'delivery_method', 'discount', 'guest_note', 'id', 'items',
  'paid', 'status', 'subtotal', 'total', 'transfer_info'];
const GUEST_ITEM_KEYS = ['kind', 'name', 'option_label', 'photo_name', 'qty', 'spreads', 'unit_price'];
const settings = (env, body) => call(env, '/api/admin/settings', { method: body ? 'PUT' : 'GET', token: SECRET, body });
const orderStatus = (env, id, s) => call(env, `/api/admin/orders/${id}/status`, { method: 'POST', token: SECRET, body: { status: s } });
const erase = (env, id, token = SECRET) => call(env, `/api/admin/orders/${id}/erase-contact`, { method: 'POST', token });

// ─── schema ──────────────────────────────────────────────────────────────────

test('migration: eleven statements, each runnable on its own, noted in schema.sql; turns today\'s database into a fresh one', () => {
  assert.ok(MIGRATION, 'migration file');
  assert.match(MIGRATION, /D1 Console/);
  assert.match(MIGRATION, /orders_unavailable/);
  assert.deepEqual(statementsOf(MIGRATION), [
    'ALTER TABLE orders ADD COLUMN request_id TEXT',
    'ALTER TABLE orders ADD COLUMN contact_name TEXT',
    'ALTER TABLE orders ADD COLUMN contact_phone TEXT',
    'ALTER TABLE orders ADD COLUMN contact_line TEXT',
    'ALTER TABLE orders ADD COLUMN delivery_method TEXT',
    'ALTER TABLE orders ADD COLUMN consent_version TEXT',
    'ALTER TABLE orders ADD COLUMN contact_erased_at TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_request ON orders(project_id, request_id)',
    'ALTER TABLE order_items ADD COLUMN list_price INTEGER',
    'ALTER TABLE order_items ADD COLUMN layout TEXT',
    'ALTER TABLE studio_settings ADD COLUMN transfer_info TEXT',
  ]);
  // pickup only (Tim): nothing for shipping is added
  assert.doesNotMatch(MIGRATION.replace(/--[^\n]*/g, ''), /ship|address|fee/i);
  assert.match(FRESH, /2026-10-09-guest-orders\.sql/);
  for (const s of statementsOf(MIGRATION)) assert.ok(FRESH.includes(s.replace(/ TEXT$| INTEGER$/, '')) || FRESH.includes(s), `schema.sql notes: ${s}`);
  // (studio_settings.pick_link_message, appended after transfer_info, comes from its own later migration on top)
  const env = { DB: fakeDB({ schema: s2Schema({ settings: [...S2_SETTINGS_COLUMNS, 'pick_link_message'] }) }) };
  assert.throws(() => env.DB._db.prepare('SELECT request_id FROM orders').all(), /no such column/, 'the fixture lacks it');
  assert.throws(() => env.DB._db.prepare('SELECT transfer_info FROM studio_settings').all(), /no such column/);
  for (const s of statementsOf(MIGRATION)) env.DB._db.exec(s);
  env.DB._db.exec(readFileSync(new URL('../migrations/2026-10-10-pick-link-message.sql', import.meta.url), 'utf8'));
  const fresh = fakeDB();
  for (const t of ['orders', 'order_items', 'studio_settings']) {
    const cols = d => d.prepare(`PRAGMA table_info(${t})`).all().map(c => ({ ...c }));
    assert.deepEqual(cols(env.DB._db), cols(fresh._db), t);
  }
  const idx = d => d.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_orders_request'").get()?.sql;
  assert.ok(idx(env.DB._db));
  assert.equal(idx(env.DB._db), idx(fresh._db));
  // the index refuses a second order with the same request in a project,
  // never two orders without one
  const ins = (id, pid, req) => fresh._db.prepare(
    "INSERT INTO orders (id, photographer_id, project_id, source, created_at, updated_at, request_id) VALUES (?, 'default', ?, 'guest', 'a', 'a', ?)"
  ).run(id, pid, req);
  ins('o1', 'p', null); ins('o2', 'p', null); ins('o3', 'p', 'r'); ins('o4', 'q', 'r');
  assert.throws(() => ins('o5', 'p', 'r'), /UNIQUE/);
});

test('wrangler.toml ships the switch off, with an empty pilot list, in [vars]', () => {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const vars = toml.slice(toml.indexOf('[vars]'));
  assert.match(vars, /^GUEST_ORDERS = "off"$/m);
  assert.match(vars, /^GUEST_ORDERS_PILOT = ""$/m);
});

// ─── create ──────────────────────────────────────────────────────────────────

test('a print line: 201 {order} in the guest view; the row and the line carry the catalogue\'s money and the contact', async () => {
  const { env, c, p } = await ready();
  const body = orderBody(c, { lines: [printLine(c, { qty: 2 })], expected_total: 6000, note: '  謝謝\r\n要亮面  ', contact: { name: ' 王小明 ', phone: ' 0912-345-678 ', line: 'wang_01' } });
  const res = await placeOrder(env, p, body);
  assert.equal(res.status, 201, await res.clone().text());
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const { order, ...rest } = await res.json();
  assert.deepEqual(rest, {});
  assert.deepEqual(Object.keys(order).sort(), GUEST_VIEW_KEYS);
  assert.equal(order.status, 'requested');
  assert.equal(order.subtotal, 6000);
  assert.equal(order.discount, 0);
  assert.equal(order.total, 6000);
  assert.equal(order.paid, false);
  assert.equal(order.delivery_method, 'pickup');
  assert.equal(order.guest_note, '謝謝\n要亮面');
  assert.deepEqual(order.contact, { name: '王小明', phone: '0912-345-678', line: 'wang_01' });
  assert.equal(order.transfer_info, null);
  assert.equal(order.confirmed_at, null);
  assert.equal(order.cancelled_at, null);
  assert.deepEqual(order.items, [{ kind: 'print', name: '無框畫', option_label: '16×20', qty: 2, unit_price: 3000, photo_name: 'f1.jpg', spreads: null }]);
  const [row] = orderRows(env);
  assert.equal(orderRows(env).length, 1);
  assert.equal(row.id, order.id);
  assert.equal(row.source, 'guest');
  assert.equal(row.status, 'requested');
  assert.equal(row.photographer_id, 'default');
  assert.equal(row.project_id, p.id);
  assert.equal(row.picker_id, p.pickerId);
  assert.equal(row.request_id, body.request_id);
  assert.equal(row.contact_name, '王小明');
  assert.equal(row.contact_phone, '0912-345-678');
  assert.equal(row.contact_line, 'wang_01');
  assert.equal(row.delivery_method, 'pickup');
  assert.equal(row.consent_version, 'v1');
  assert.equal(row.contact_erased_at, null);
  assert.equal(row.discount, 0);
  assert.equal(row.note, '');
  assert.equal(row.confirmed_at, null);
  const [item] = itemRows(env);
  assert.equal(item.order_id, order.id);
  assert.equal(item.kind, 'print');
  assert.equal(item.product_id, c.print.id);
  assert.equal(item.option_id, c.print.options[0].id);
  assert.equal(item.unit_price, 3000);
  assert.equal(item.list_price, 3000);
  assert.equal(item.unit_cost, 2000);
  assert.equal(item.vendor_cost, 900);
  assert.equal(item.platform_option_id, c.ppPrint.options[0].id);
  assert.equal(item.qty, 2);
  assert.deepEqual(JSON.parse(item.photo_keys), [F1]);
  assert.equal(item.layout, null);
});

test('an album line: spreads above min_pages cost extra_page_price each, server-side; the layout notes 請攝影師排版 with all finals', async () => {
  const { env, c, p } = await ready();
  const res = await placeOrder(env, p, orderBody(c, { lines: [albumLine(c, { qty: 2, spreads: 12 })], expected_total: 2 * 5300 }));
  assert.equal(res.status, 201, await res.clone().text());
  const { order } = await res.json();
  assert.deepEqual(order.items, [{ kind: 'album', name: '相本書', option_label: '20×20', qty: 2, unit_price: 5300, photo_name: null, spreads: 12 }]);
  assert.equal(order.total, 10600);
  const [item] = itemRows(env);
  assert.equal(item.unit_price, 5300);
  assert.equal(item.list_price, 5000);
  assert.equal(item.unit_cost, 3500);
  assert.equal(item.photo_keys, '[]');
  assert.deepEqual(JSON.parse(item.layout), { v: 1, mode: 'photographer', source: 'all_finals', spreads: 12 });
});

test('album price table: min, max, inside, below, above, unpriced extra pages, no minimum, bad spreads', async () => {
  const { env, c, p } = await ready();
  const cases = [
    [albumLine(c, { spreads: 10 }), 5000],
    [albumLine(c, { spreads: 11 }), 5150],
    [albumLine(c, { spreads: 30 }), 5000 + 20 * 150],
    [albumLine(c, { spreads: 9 }), 'pages_below_min'],
    [albumLine(c, { spreads: 31 }), 'pages_above_max'],
    // extra pages not priced: the bare option price only up to min_pages
    [{ option_id: c.unpriced.options[0].id, qty: 1, spreads: 10 }, 4000],
    [{ option_id: c.unpriced.options[0].id, qty: 1, spreads: 11 }, 'extra_pages_unpriced'],
    // no min_pages: not orderable at all (the photographer would decide the size)
    [{ option_id: c.nomin.options[0].id, qty: 1, spreads: 10 }, 'album_not_orderable'],
    [albumLine(c, { spreads: 0 }), 'invalid_spreads'],
    [albumLine(c, { spreads: -1 }), 'invalid_spreads'],
    [albumLine(c, { spreads: 1.5 }), 'invalid_spreads'],
    [albumLine(c, { spreads: '12' }), 'invalid_spreads'],
    [albumLine(c, { spreads: undefined }), 'invalid_spreads'],
    [albumLine(c, { spreads: 201 }), 'invalid_spreads'],
  ];
  for (const [line, want] of cases) {
    const before = dbSnapshot(env);
    const total = typeof want === 'number' ? want : 5000;
    const res = await placeOrder(env, p, orderBody(c, { lines: [line], expected_total: total }));
    if (typeof want === 'number') {
      assert.equal(res.status, 201, `${JSON.stringify(line)} ${await res.clone().text()}`);
      const { order } = await res.json();
      assert.equal(order.total, want);
      // and cancel it, so the open cap never gets in the way
      assert.equal((await cancelOrder(env, p, order.id)).status, 200);
    } else {
      assert.equal(res.status, 400, `${JSON.stringify(line)} ${await res.clone().text()}`);
      assert.equal(await code(res), want, JSON.stringify(line));
      assert.equal(dbSnapshot(env), before, 'nothing written');
    }
  }
});

test('mixed lines: one order, the server\'s total; qty per kind (print 1–10, album 1–3)', async () => {
  const { env, c, p } = await ready();
  const lines = [printLine(c, { qty: 10 }), printLine(c, { photo_key: F2, qty: 1 }), albumLine(c, { qty: 3, spreads: 10 })];
  const res = await placeOrder(env, p, orderBody(c, { lines, expected_total: 30000 + 3000 + 15000 }));
  assert.equal(res.status, 201, await res.clone().text());
  const { order } = await res.json();
  assert.equal(order.items.length, 3);
  assert.equal(order.total, 48000);
  assert.deepEqual(order.items.map(i => i.photo_name), ['f1.jpg', 'f2.jpg', null]);
  for (const [line, want] of [[printLine(c, { qty: 11 }), 'invalid_qty'], [albumLine(c, { qty: 4 }), 'invalid_qty'], [printLine(c, { qty: 0 }), 'invalid_qty']]) {
    const r = await placeOrder(env, p, orderBody(c, { lines: [line], expected_total: 0 }));
    assert.equal(r.status, 400);
    assert.equal(await code(r), want);
  }
});

test('the same photo on two options is two lines; the same photo on the same option twice is duplicate_line', async () => {
  const env = envOf();
  const c = await catalogue(env);
  // a second option on the print
  const pp2 = c.ppPrint;
  const p = await confirmed(env);
  env.DB._db.prepare("INSERT INTO platform_product_options (id, platform_product_id, label, vendor_cost, platform_price, sort) VALUES ('ppo2', ?, '24×36', 1000, 2500, 1)").run(pp2.id);
  env.DB._db.prepare("INSERT INTO product_options (id, product_id, label, price, cost, sort, platform_option_id) VALUES ('opt2', ?, '24×36', 4000, 0, 1, 'ppo2')").run(c.print.id);
  const ok = await placeOrder(env, p, orderBody(c, { lines: [printLine(c), printLine(c, { option_id: 'opt2' })], expected_total: 7000 }));
  assert.equal(ok.status, 201, await ok.clone().text());
  const dup = await placeOrder(env, p, orderBody(c, { lines: [printLine(c), printLine(c, { qty: 2 })], expected_total: 9000 }));
  assert.equal(dup.status, 400);
  assert.equal(await code(dup), 'duplicate_line');
});

test('contact: name 1–50, phone (6–20 of digits + - space ( )) or LINE ID (1–50) at least one; trimmed; no control or bidi characters', async () => {
  const { env, c, p } = await ready();
  const bad = [
    {}, { name: '' }, { name: '   ', phone: '0912345678' }, { name: 'x'.repeat(51), phone: '0912345678' },
    { name: '王小明' }, { name: '王小明', phone: '', line: '' }, { name: '王小明', phone: null, line: null },
    { name: '王小明', phone: '12345' }, { name: '王小明', phone: '1'.repeat(21) }, { name: '王小明', phone: '0912abc678' },
    { name: '王小明', line: 'x'.repeat(51) }, { name: '王‮明', phone: '0912345678' }, { name: '王小明', line: 'a\nb' },
    { name: '王小明', phone: 912345678 }, { name: 5, phone: '0912345678' }, '王小明', null,
  ];
  for (const contact of bad) {
    const res = await placeOrder(env, p, orderBody(c, { contact }));
    assert.equal(res.status, 400, JSON.stringify(contact));
    assert.equal(await code(res), 'invalid_contact', JSON.stringify(contact));
  }
  assert.equal(orderRows(env).length, 0);
  for (const contact of [{ name: '王', phone: '(02) 2345-6789' }, { name: '😀'.repeat(50), line: '😀'.repeat(50) }, { name: 'A', phone: '+886 912 345 678' }]) {
    const res = await placeOrder(env, p, orderBody(c, { contact }));
    assert.equal(res.status, 201, JSON.stringify(contact));
    assert.equal((await cancelOrder(env, p, (await res.json()).order.id)).status, 200);
  }
  // a missing optional field is stored NULL, never ''
  const row = orderRows(env).at(-1);
  assert.equal(row.contact_phone, '+886 912 345 678');
  assert.equal(row.contact_line, null);
});

test('note: optional, ≤ 500 characters, line breaks kept, other control and bidi characters refused', async () => {
  const { env, c, p } = await ready();
  for (const note of ['x'.repeat(501), 'a\u0007b', 'a‮b', 5, ['a']]) {
    const res = await placeOrder(env, p, orderBody(c, { note }));
    assert.equal(res.status, 400, JSON.stringify(note));
    assert.equal(await code(res), 'invalid_note');
  }
  const res = await placeOrder(env, p, orderBody(c, { note: undefined }));
  assert.equal(res.status, 201);
  assert.equal(orderRows(env)[0].guest_note, '');
  const res2 = await placeOrder(env, p, orderBody(c, { note: null }));
  assert.equal(res2.status, 201);
});

test('the request_id is a UUID; the body is a JSON object; expected_total a whole number', async () => {
  const { env, c, p } = await ready();
  for (const request_id of [undefined, '', 'abc', 123, '00000000-0000-0000-0000-00000000000g', `${crypto.randomUUID()}x`]) {
    const res = await placeOrder(env, p, orderBody(c, { request_id }));
    assert.equal(res.status, 400, String(request_id));
    assert.equal(await code(res), 'invalid_request_id');
  }
  for (const expected_total of [undefined, '3000', 3000.5, -1, null]) {
    const res = await placeOrder(env, p, orderBody(c, { expected_total }));
    assert.equal(res.status, 400, String(expected_total));
    assert.equal(await code(res), 'invalid_body');
  }
  for (const body of ['[]', '"x"', 'null']) {
    const res = await placeOrder(env, p, body);
    assert.equal(res.status, 400);
    assert.equal(await code(res), 'invalid_body');
  }
  const res = await placeOrder(env, p, '{nope');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Invalid JSON');
  for (const lines of [undefined, [], 'x', [null], [5]]) {
    const r = await placeOrder(env, p, orderBody(c, { lines }));
    assert.equal(r.status, 400);
    assert.equal(await code(r), 'invalid_lines', JSON.stringify(lines));
  }
  for (const line of [{ qty: 1, photo_key: F1 }, { option_id: 5, qty: 1, photo_key: F1 }, { option_id: '', qty: 1, photo_key: F1 }]) {
    const r = await placeOrder(env, p, orderBody(c, { lines: [line] }));
    assert.equal(r.status, 400);
    assert.equal(await code(r), 'invalid_lines', JSON.stringify(line));
  }
  assert.equal(orderRows(env).length, 0);
});

test('a print line without a photo, or with spreads; an album line with a photo: refused', async () => {
  const { env, c, p } = await ready();
  for (const [line, want] of [
    [printLine(c, { photo_key: undefined }), 'invalid_photo_key'],
    [printLine(c, { spreads: 10 }), 'invalid_lines'],
    [albumLine(c, { photo_key: F1 }), 'invalid_lines'],
  ]) {
    const res = await placeOrder(env, p, orderBody(c, { lines: [line], expected_total: 3000 }));
    assert.equal(res.status, 400, JSON.stringify(line));
    assert.equal(await code(res), want, JSON.stringify(line));
  }
  assert.equal(orderRows(env).length, 0);
});

// ─── idempotency and caps ────────────────────────────────────────────────────

test('the same request_id again: 200 {order, replay:true}, one order, one email — even with another body', async () => {
  const { env, c, p } = await ready();
  const body = orderBody(c);
  const first = await placeOrder(env, p, body);
  assert.equal(first.status, 201);
  const a = (await first.json()).order;
  const again = await placeOrder(env, p, body);
  assert.equal(again.status, 200);
  const b = await again.json();
  assert.equal(b.replay, true);
  assert.deepEqual(b.order, a);
  // a retry the page rebuilt (another quantity): still the order that landed
  const other = await placeOrder(env, p, { ...body, lines: [printLine(c, { qty: 3 })], expected_total: 9000 });
  assert.equal(other.status, 200);
  assert.equal((await other.json()).order.id, a.id);
  // the photographer repriced since: a retry is still the order that landed,
  // never a price_changed (the guest would submit again with a new id)
  env.DB._db.prepare('UPDATE product_options SET price = 3500 WHERE id = ?').run(c.print.options[0].id);
  const late = await placeOrder(env, p, body);
  assert.equal(late.status, 200);
  assert.equal((await late.json()).order.total, 3000);
  env.DB._db.prepare('UPDATE product_options SET price = 3000 WHERE id = ?').run(c.print.options[0].id);
  assert.equal(orderRows(env).length, 1);
  assert.equal(itemRows(env).length, 1);
  assert.equal(mail(env).length, 1);
  // a request id is per order: a new one is a new order
  assert.equal((await placeOrder(env, p, orderBody(c))).status, 201);
  assert.equal(orderRows(env).length, 2);
});

test('caps: at most 3 requested at once (409 too_many_open_orders, max 3); 20 guest orders in all, cancelled included (409 order_cap, max 20)', async () => {
  const { env, c, p } = await ready();
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await placed(env, p, c)).id);
  const before = dbSnapshot(env);
  const fourth = await placeOrder(env, p, orderBody(c));
  assert.equal(fourth.status, 409);
  assert.deepEqual({ ...(await fourth.json()), error: undefined }, { error: undefined, code: 'too_many_open_orders', max: 3 });
  assert.equal(dbSnapshot(env), before);
  // a confirmed one no longer counts as open
  assert.equal((await orderStatus(env, ids[0], 'confirmed')).status, 200);
  assert.equal((await placeOrder(env, p, orderBody(c))).status, 201);
  // an admin or system order never counts
  const fill = (n, status) => {
    for (let i = 0; i < n; i++) {
      env.DB._db.prepare("INSERT INTO orders (id, photographer_id, project_id, source, status, picker_id, created_at, updated_at) VALUES (?, 'default', ?, ?, ?, ?, 'x', 'x')")
        .run(crypto.randomUUID(), p.id, status === 'admin' ? 'admin' : 'guest', status === 'admin' ? 'confirmed' : status, p.pickerId);
    }
  };
  fill(30, 'admin');
  // 4 guest orders so far (one confirmed, three requested); cancel two
  assert.equal((await cancelOrder(env, p, ids[1])).status, 200);
  assert.equal((await cancelOrder(env, p, ids[2])).status, 200);
  fill(15, 'cancelled'); // 19 guest orders
  assert.equal((await placeOrder(env, p, orderBody(c))).status, 201); // the 20th
  const capped = await placeOrder(env, p, orderBody(c));
  assert.equal(capped.status, 409);
  const j = await capped.json();
  assert.equal(j.code, 'order_cap');
  assert.equal(j.max, 20);
});

// ─── state ───────────────────────────────────────────────────────────────────

test('state matrix: only delivered AND confirmed creates; GET and cancel keep working after undeliver / reopen; the orders are left as they were', async () => {
  const env = envOf();
  const c = await catalogue(env);
  // retouching, not delivered
  const r = await retouching(env);
  let res = await placeOrder(env, r, orderBody(c));
  assert.equal(res.status, 409);
  assert.equal(await code(res), 'not_confirmed');
  // delivered, not confirmed
  const p = await delivered(env);
  res = await placeOrder(env, p, orderBody(c));
  assert.equal(await code(res), 'not_confirmed');
  assert.equal(res.status, 409);
  assert.equal(orderRows(env).length, 0);
  // confirmed: orders
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
  const o1 = await placed(env, p, c);
  const o2 = await placed(env, p, c);
  const rowsBefore = JSON.stringify(orderRows(env)) + JSON.stringify(itemRows(env));
  // undeliver: no new order, the old ones untouched, readable, cancellable
  assert.equal((await admin(env, p.id, 'undeliver')).status, 200);
  res = await placeOrder(env, p, orderBody(c));
  assert.equal(res.status, 409);
  assert.equal(await code(res), 'not_confirmed');
  assert.equal(JSON.stringify(orderRows(env)) + JSON.stringify(itemRows(env)), rowsBefore);
  const listed = await myOrders(env, p);
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).orders.map(o => o.id), [o2.id, o1.id]);
  // the photographer sees the project is not delivered right now
  const adminSide = await adminOrders(env);
  assert.deepEqual(adminSide.orders.map(o => o.project_delivered), [false, false]);
  assert.equal((await cancelOrder(env, p, o1.id)).status, 200);
  // reopen: the same
  assert.equal((await admin(env, p.id, 'reopen')).status, 200);
  res = await placeOrder(env, p, orderBody(c));
  assert.equal(await code(res), 'not_confirmed');
  assert.equal((await myOrders(env, p)).status, 200);
  assert.equal(orderRows(env).find(o => o.id === o2.id).status, 'requested');
  // a repeat deliver (更換精修) clears the confirmation: not confirmed again
  const q = await confirmed(env);
  await placed(env, q, c);
  assert.equal((await deliver(env, q.id, [FINAL2])).status, 200);
  res = await placeOrder(env, q, orderBody(c, { lines: [printLine(c, { photo_key: 'shoot/精修二/g1.jpg' })] }));
  assert.equal(await code(res), 'not_confirmed');
  const fresh = await adminOrders(env);
  assert.equal(fresh.orders.find(o => o.project_id === q.id).project_delivered, true);
});

// ─── GET and cancel ──────────────────────────────────────────────────────────

test('GET: the seat holder\'s guest orders in this project, newest first, guest view only; transfer_info once confirmed or fulfilled', async () => {
  const { env, c, p } = await ready();
  assert.deepEqual(await (await myOrders(env, p)).json(), { orders: [] });
  assert.equal((await settings(env, { transfer_info: '國泰世華 013\n帳號 1234-5678' })).status, 200);
  const a = await placed(env, p, c);
  const b = await placed(env, p, c, { lines: [albumLine(c)], expected_total: 5000 });
  // an admin order on the same project never shows
  env.DB._db.prepare("INSERT INTO orders (id, photographer_id, project_id, source, status, picker_id, created_at, updated_at) VALUES ('adm', 'default', ?, 'admin', 'confirmed', ?, 'z', 'z')").run(p.id, p.pickerId);
  const res = await myOrders(env, p);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const { orders } = await res.json();
  assert.deepEqual(orders.map(o => o.id), [b.id, a.id]);
  for (const o of orders) {
    assert.deepEqual(Object.keys(o).sort(), GUEST_VIEW_KEYS);
    for (const i of o.items) assert.deepEqual(Object.keys(i).sort(), GUEST_ITEM_KEYS);
    assert.equal(o.transfer_info, null, 'requested: no transfer info yet');
  }
  assert.equal((await orderStatus(env, a.id, 'confirmed')).status, 200);
  let mine = (await (await myOrders(env, p)).json()).orders;
  assert.equal(mine.find(o => o.id === a.id).transfer_info, '國泰世華 013\n帳號 1234-5678');
  assert.equal(mine.find(o => o.id === a.id).status, 'confirmed');
  assert.ok(mine.find(o => o.id === a.id).confirmed_at);
  assert.equal(mine.find(o => o.id === b.id).transfer_info, null);
  // paid: paid_amount >= total, a boolean only
  assert.equal((await call(env, `/api/admin/orders/${a.id}/payment`, { method: 'POST', token: SECRET, body: { paid_amount: 3000, paid_method: 'transfer' } })).status, 200);
  assert.equal((await orderStatus(env, a.id, 'fulfilled')).status, 200);
  mine = (await (await myOrders(env, p)).json()).orders;
  const fa = mine.find(o => o.id === a.id);
  assert.equal(fa.paid, true);
  assert.equal(fa.transfer_info, '國泰世華 013\n帳號 1234-5678');
  assert.ok(!JSON.stringify(mine).includes('paid_amount'));
  // cancelled: no transfer info
  assert.equal((await orderStatus(env, a.id, 'cancelled')).status, 200);
  mine = (await (await myOrders(env, p)).json()).orders;
  assert.equal(mine.find(o => o.id === a.id).transfer_info, null);
  // the photographer's discount shows in the money, never their note
  assert.equal((await call(env, `/api/admin/orders/${b.id}`, { method: 'PUT', token: SECRET, body: { discount: 500, note: '老客戶' } })).status, 200);
  mine = (await (await myOrders(env, p)).json()).orders;
  const fb = mine.find(o => o.id === b.id);
  assert.equal(fb.discount, 500);
  assert.equal(fb.total, 4500);
  assert.ok(!JSON.stringify(mine).includes('老客戶'));
});

test('cancel: own requested → 200 cancelled (and an email); again → 200, nothing written; confirmed → 409 bad_transition', async () => {
  const { env, c, p } = await ready();
  const o = await placed(env, p, c);
  mail(env).length = 0;
  const res = await cancelOrder(env, p, o.id);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const { order } = await res.json();
  assert.equal(order.status, 'cancelled');
  assert.ok(order.cancelled_at);
  assert.deepEqual(Object.keys(order).sort(), GUEST_VIEW_KEYS);
  const row = orderRows(env)[0];
  assert.equal(row.status, 'cancelled');
  assert.equal(row.cancelled_at, order.cancelled_at);
  assert.equal(mail(env).length, 1);
  assert.match(mail(env)[0].subject, /^\[客人取消訂單\] /);
  const snap = dbSnapshot(env);
  const again = await cancelOrder(env, p, o.id);
  assert.equal(again.status, 200);
  assert.equal((await again.json()).order.status, 'cancelled');
  assert.equal(dbSnapshot(env), snap);
  assert.equal(mail(env).length, 1);
  const o2 = await placed(env, p, c);
  assert.equal((await orderStatus(env, o2.id, 'confirmed')).status, 200);
  const late = await cancelOrder(env, p, o2.id);
  assert.equal(late.status, 409);
  const j = await late.json();
  assert.equal(j.code, 'bad_transition');
  assert.equal(j.from, 'confirmed');
  assert.equal(orderRows(env).find(r => r.id === o2.id).status, 'confirmed');
  // method
  const get = await pick(env, 'GET', `orders/${o2.id}/cancel`, p.token, { key: p.key });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('Allow'), 'POST');
});

test('routes: GET/POST on orders only (405 Allow: GET, POST); anything deeper is 404', async () => {
  const { env, c, p } = await ready();
  for (const method of ['PUT', 'DELETE', 'PATCH']) {
    const res = await pick(env, method, 'orders', p.token, { key: p.key, body: {} });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('Allow'), 'GET, POST');
  }
  const o = await placed(env, p, c);
  for (const path of [`orders/${o.id}`, `orders/${o.id}/cancel/x`, `orders/${o.id}/confirm`]) {
    const res = await pick(env, 'POST', path, p.token, { key: p.key, body: {} });
    assert.equal(res.status, 404, path);
  }
});

// ─── email ───────────────────────────────────────────────────────────────────

test('email on a new order: subject on one line with the total; lines and note in the body; never the phone or LINE ID; link to the requested orders', async () => {
  const { env, c, p } = await ready();
  await placed(env, p, c, {
    lines: [printLine(c, { qty: 2 }), albumLine(c, { spreads: 12 })], expected_total: 6000 + 5300,
    contact: { name: '王<b>小明</b>', phone: '0912-777-888', line: 'secret_line_id' }, note: '請用<script>亮面</script>\n謝謝',
  });
  assert.equal(mail(env).length, 1);
  const [m] = mail(env);
  assert.equal(m.to, 'studio@example.com');
  assert.equal(m.from, 'notify@imhoti.tw');
  assert.equal(m.subject, '[新訂單] 王先生 婚紗 — 王<b>小明</b>：NT$11300');
  assert.doesNotMatch(m.subject, /[\r\n]/);
  for (const part of [m.text, m.html, m.subject]) {
    assert.ok(!part.includes('0912-777-888'), 'no phone');
    assert.ok(!part.includes('secret_line_id'), 'no LINE ID');
  }
  assert.match(m.text, /無框畫/);
  assert.match(m.text, /f1\.jpg/);
  assert.match(m.text, /12 跨頁/);
  assert.match(m.text, /NT\$11300/);
  assert.match(m.text, /面交/);
  assert.match(m.text, /謝謝/);
  assert.ok(m.text.includes('https://imhoti.tw/studio/orders.html?status=requested'));
  assert.ok(m.html.includes('href="https://imhoti.tw/studio/orders.html?status=requested"'));
  assert.ok(!m.html.includes('<script>'), 'escaped');
  assert.ok(m.html.includes('&lt;script&gt;'));
  assert.ok(!m.html.includes('<b>小明'));
});

test('email: not set up → the order still lands; the mailer failing → still 201', async () => {
  for (const extra of [{ NOTIFY_EMAIL: undefined }, { PHOTOGRAPHER_EMAIL: undefined }]) {
    const env = envOf({ extra });
    const c = await catalogue(env);
    const p = await confirmed(env);
    assert.equal((await placeOrder(env, p, orderBody(c))).status, 201);
  }
  const env = envOf({ mailer: fakeMailer({ fail: true }) });
  const c = await catalogue(env);
  // the confirmation's own mail fails too, which never fails it
  const p = await confirmed(env);
  assert.equal((await placeOrder(env, p, orderBody(c))).status, 201);
  assert.equal(orderRows(env).length, 1);
});

// ─── before the migration ────────────────────────────────────────────────────

test('before the migration: the three guest routes answer 500 orders_unavailable and write nothing; the shop says ordering: null', async () => {
  const { env, c, p } = await ready({ schema: s2Schema() });
  // a guest order made by hand (none can be made before the migration)
  const o = { id: crypto.randomUUID() };
  env.DB._db.prepare("INSERT INTO orders (id, photographer_id, project_id, source, status, picker_id, created_at, updated_at) VALUES (?, 'default', ?, 'guest', 'requested', ?, 'x', 'x')").run(o.id, p.id, p.pickerId);
  const snap = dbSnapshot(env);
  for (const res of [await placeOrder(env, p, orderBody(c)), await myOrders(env, p), await cancelOrder(env, p, o.id)]) {
    assert.equal(res.status, 500);
    assert.equal(await code(res), 'orders_unavailable');
  }
  assert.equal(dbSnapshot(env), snap);
  const shop = await pick(env, 'GET', 'shop', p.token);
  assert.equal(shop.status, 200);
  const sj = await shop.json();
  assert.equal(sj.ordering, null);
  assert.ok(sj.products.length > 0);
});

test('a half-run migration (one statement at a time) is still unavailable: never half working', async () => {
  const subsets = [
    { orders: S2_ORDER_COLUMNS.slice(3), items: [], settings: [] },
    { orders: [], items: ['layout'], settings: [] },
    { orders: [], items: [], settings: ['transfer_info'] },
    { orders: ['contact_erased_at'], items: [], settings: [] },
  ];
  for (const drop of subsets) {
    const { env, c, p } = await ready({ schema: s2Schema({ ...drop, index: false }) });
    const res = await placeOrder(env, p, orderBody(c));
    assert.equal(res.status, 500, JSON.stringify(drop));
    assert.equal(await code(res), 'orders_unavailable');
    assert.equal(orderRows(env).length, 0);
    assert.equal((await pick(env, 'GET', 'shop', p.token).then(r => r.json())).ordering, null);
  }
  // only the index missing: the routes work (idempotency does not rest on it)
  const { env, c, p } = await ready({ schema: s2Schema({ orders: [], items: [], settings: [], index: true }) });
  const body = orderBody(c);
  assert.equal((await placeOrder(env, p, body)).status, 201);
  assert.equal((await placeOrder(env, p, body)).status, 200);
  assert.equal(orderRows(env).length, 1);
  // a twin landing between the replay check and the write: the INSERT's own
  // NOT EXISTS keeps it to one order, with no index to fall back on
  const twin = orderBody(c);
  landOnce(env, /INSERT INTO orders/, `INSERT INTO orders (id, photographer_id, project_id, source, status, picker_id, request_id, contact_name, created_at, updated_at)
    VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'default', ?, 'guest', 'requested', ?, ?, '王小明', 'x', 'x')`, p.id, p.pickerId, twin.request_id);
  const raced = await placeOrder(env, p, twin);
  assert.equal(raced.status, 200);
  assert.equal(orderRows(env).filter(o => o.request_id === twin.request_id).length, 1);
});

test('before the migration the photographer\'s order routes and stats work as before (new fields read null)', async () => {
  const env = envOf({ schema: s2Schema() });
  const c = await catalogue(env);
  const p = await confirmed(env);
  // admin create (with a final photo now, Q17), read, PUT, payment, status, stats, settings
  let res = await call(env, `/api/admin/projects/${p.id}/orders`, { method: 'POST', token: SECRET, body: { lines: [{ option_id: c.print.options[0].id, qty: 1, photo_keys: [F1] }] } });
  assert.equal(res.status, 201, await res.clone().text());
  const { order } = await res.json();
  assert.equal(order.contact, null);
  assert.equal(order.delivery_method, null);
  assert.equal(order.items[0].list_price, null);
  assert.equal(order.items[0].layout, null);
  res = await call(env, `/api/admin/orders/${order.id}`, { method: 'PUT', token: SECRET, body: { lines: [{ id: order.items[0].id, qty: 2 }, { option_id: c.album.options[0].id, qty: 1 }] } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).order.total, 6000 + 5000);
  assert.equal((await call(env, `/api/admin/orders/${order.id}/payment`, { method: 'POST', token: SECRET, body: { paid_amount: 100, paid_method: 'cash' } })).status, 200);
  assert.equal((await orderStatus(env, order.id, 'fulfilled')).status, 200);
  assert.equal((await adminOrders(env)).orders.length, 1);
  assert.equal((await adminOrders(env, `/api/admin/projects/${p.id}/orders`)).orders.length, 1);
  const stats = await (await call(env, '/api/admin/stats', { token: SECRET })).json();
  assert.equal(stats.todo.requested_orders, 0);
  const s = await settings(env);
  assert.equal(s.status, 200);
  assert.equal((await s.json()).transfer_info, null);
  // settings without the new field still save; with it: 500, nothing written
  assert.equal((await settings(env, { studio_name: '小明攝影' })).status, 200);
  const before = JSON.stringify(rows(env, 'SELECT * FROM studio_settings'));
  const t = await settings(env, { studio_name: '別的', transfer_info: '帳號' });
  assert.equal(t.status, 500);
  assert.equal(await code(t), 'orders_unavailable');
  assert.equal(JSON.stringify(rows(env, 'SELECT * FROM studio_settings')), before);
  // erase: 500 too
  const e = await erase(env, order.id);
  assert.equal(e.status, 500);
  assert.equal(await code(e), 'orders_unavailable');
});

// ─── settings: transfer_info ─────────────────────────────────────────────────

test('settings: transfer_info is null / a string ≤ 500 (line breaks kept, trimmed, \'\' clears); control and bidi characters refused', async () => {
  const env = envOf();
  assert.equal((await (await settings(env)).json()).transfer_info, null);
  let res = await settings(env, { transfer_info: '  國泰世華 013\r\n帳號 1234  ' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).transfer_info, '國泰世華 013\n帳號 1234');
  assert.equal((await (await settings(env)).json()).transfer_info, '國泰世華 013\n帳號 1234');
  for (const v of ['x'.repeat(501), 'a\u0000b', 'a‮b', 5, ['a'], { a: 1 }]) {
    res = await settings(env, { transfer_info: v });
    assert.equal(res.status, 400, JSON.stringify(v));
    assert.equal(await code(res), 'invalid_transfer_info');
  }
  assert.equal((await (await settings(env)).json()).transfer_info, '國泰世華 013\n帳號 1234');
  assert.equal((await settings(env, { transfer_info: 'x'.repeat(500) })).status, 200);
  for (const v of ['', '   ', null]) {
    res = await settings(env, { transfer_info: v });
    assert.equal((await res.json()).transfer_info, null);
  }
  // other fields leave it alone
  await settings(env, { transfer_info: '帳號' });
  await settings(env, { studio_name: '小明' });
  assert.equal((await (await settings(env)).json()).transfer_info, '帳號');
});

test('the guest reads the transfer text through one function only (readTransferInfo)', () => {
  assert.match(WORKER, /async function readTransferInfo\(env, project\)/);
  assert.equal(WORKER.split('transfer_info FROM studio_settings').length - 1, 1, 'one guest-side read of the column');
  assert.equal((WORKER.match(/readTransferInfo\(/g) || []).length >= 2, true);
});

// ─── the photographer's side ─────────────────────────────────────────────────

test('admin orders: named columns — contact, delivery method, consent version, project_delivered; lines gain list_price and layout; never request_id or vendor_cost', async () => {
  const { env, c, p } = await ready();
  const o = await placed(env, p, c, { lines: [printLine(c), albumLine(c, { spreads: 11 })], expected_total: 3000 + 5150, contact: { name: '王小明', line: 'wang' } });
  const res = await call(env, `/api/admin/projects/${p.id}/orders`, { method: 'POST', token: SECRET, body: { lines: [{ option_id: c.print.options[0].id, qty: 1 }] } });
  assert.equal(res.status, 201);
  const adminOrder = (await res.json()).order;
  for (const path of ['/api/admin/orders', `/api/admin/projects/${p.id}/orders`]) {
    const { orders } = await adminOrders(env, path);
    const g = orders.find(x => x.id === o.id);
    const a = orders.find(x => x.id === adminOrder.id);
    assert.deepEqual(Object.keys(g).sort(), [
      'cancelled_at', 'confirmed_at', 'consent_version', 'contact', 'cost', 'created_at', 'delivery_method', 'discount', 'fulfilled_at', 'guest_note',
      'id', 'items', 'note', 'outstanding', 'paid_amount', 'paid_at', 'paid_method', 'photographer_id', 'picker_id', 'project_delivered',
      'project_id', 'project_title', 'source', 'status', 'subtotal', 'total', 'updated_at',
    ]);
    assert.deepEqual(g.contact, { name: '王小明', phone: null, line: 'wang', erased_at: null });
    assert.equal(g.delivery_method, 'pickup');
    assert.equal(g.consent_version, 'v1');
    assert.equal(g.project_delivered, true);
    assert.equal(g.total, 8150);
    assert.equal(g.outstanding, 0, 'requested owes nothing');
    assert.deepEqual(Object.keys(g.items[0]).sort(), ['id', 'kind', 'layout', 'list_price', 'name', 'option_id', 'option_label', 'order_id',
      'photo_keys', 'platform_option_id', 'product_id', 'qty', 'unit_cost', 'unit_price']);
    assert.deepEqual(g.items.map(i => [i.list_price, i.unit_price, i.layout]), [
      [3000, 3000, null], [5000, 5150, { v: 1, mode: 'photographer', source: 'all_finals', spreads: 11 }],
    ]);
    assert.deepEqual(g.items[0].photo_keys, [F1]);
    // an admin order: no contact, but its lines now record the list price too
    assert.equal(a.contact, null);
    assert.equal(a.delivery_method, null);
    assert.equal(a.items[0].list_price, 3000);
    const text = JSON.stringify(orders);
    assert.ok(!text.includes('request_id'));
    assert.ok(!text.includes('vendor_cost'));
  }
});

test('erase-contact: phone and LINE ID cleared, name kept, stamped; the guest then sees only the name; again → 200, nothing written', async () => {
  const { env, c, p } = await ready();
  const o = await placed(env, p, c, { contact: { name: '王小明', phone: '0912345678', line: 'wang' } });
  let res = await erase(env, o.id);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  const { order } = await res.json();
  assert.equal(order.contact.name, '王小明');
  assert.equal(order.contact.phone, null);
  assert.equal(order.contact.line, null);
  assert.ok(order.contact.erased_at);
  const row = orderRows(env)[0];
  assert.equal(row.contact_phone, null);
  assert.equal(row.contact_line, null);
  assert.equal(row.contact_name, '王小明');
  assert.equal(row.contact_erased_at, order.contact.erased_at);
  const mine = (await (await myOrders(env, p)).json()).orders[0];
  assert.deepEqual(mine.contact, { name: '王小明', phone: null, line: null });
  const snap = dbSnapshot(env);
  res = await erase(env, o.id);
  assert.equal(res.status, 200);
  assert.equal(dbSnapshot(env), snap);
  // unknown, another photographer's, an order without contact, a wrong token, a GET
  assert.equal((await erase(env, 'nope')).status, 404);
  env.DB._db.prepare("UPDATE orders SET photographer_id = 'other' WHERE id = ?").run(o.id);
  assert.equal((await erase(env, o.id)).status, 404);
  env.DB._db.prepare("UPDATE orders SET photographer_id = 'default' WHERE id = ?").run(o.id);
  const a = await call(env, `/api/admin/projects/${p.id}/orders`, { method: 'POST', token: SECRET, body: { lines: [{ option_id: c.print.options[0].id, qty: 1 }] } });
  const adminId = (await a.json()).order.id;
  res = await erase(env, adminId);
  assert.equal(res.status, 409);
  assert.equal(await code(res), 'no_contact');
  assert.equal((await erase(env, o.id, 'wrong')).status, 401);
  assert.equal((await call(env, `/api/admin/orders/${o.id}/erase-contact`, { token: SECRET })).status, 405);
});

test('stats: todo.requested_orders counts the guest orders waiting for confirmation', async () => {
  const { env, c, p } = await ready();
  const get = async () => (await (await call(env, '/api/admin/stats', { token: SECRET })).json()).todo.requested_orders;
  assert.equal(await get(), 0);
  const a = await placed(env, p, c);
  await placed(env, p, c);
  // a requested order that is not a guest's never counts (none should exist)
  env.DB._db.prepare("INSERT INTO orders (id, photographer_id, project_id, source, status, created_at, updated_at) VALUES ('adm', 'default', ?, 'admin', 'requested', 'x', 'x')").run(p.id);
  assert.equal(await get(), 2);
  await orderStatus(env, a.id, 'confirmed');
  assert.equal(await get(), 1);
  // archived projects still count (the order still waits)
  await admin(env, p.id, 'archive');
  assert.equal(await get(), 1);
});

test('Q17: the photographer\'s own order may carry a final photo (current finals, or the last chosen after undeliver); proofs too; `_` and other folders never', async () => {
  const { env, c, p } = await ready();
  const make = keys => call(env, `/api/admin/projects/${p.id}/orders`, { method: 'POST', token: SECRET, body: { lines: [{ option_id: c.print.options[0].id, qty: 2, photo_keys: keys }] } });
  let res = await make([F1, PA]);
  assert.equal(res.status, 201, await res.clone().text());
  const o = (await res.json()).order;
  assert.deepEqual(o.items[0].photo_keys, [F1, PA]);
  for (const k of ['_thumbs/400/shoot/精修/f1.jpg.thumb', 'other/x.jpg', '_books/b1.json', 'shoot/精修二/g1.jpg']) {
    res = await make([k]);
    assert.equal(res.status, 400, k);
    assert.equal(await code(res), 'photo_not_in_project', k);
  }
  assert.equal((await admin(env, p.id, 'undeliver')).status, 200);
  assert.equal((await make([F2])).status, 201, 'final_folders stays after undeliver');
  // a kept line whose final is no longer in the chosen finals can still be edited
  assert.equal((await deliver(env, p.id, ['shoot/精修二/'])).status, 200);
  res = await call(env, `/api/admin/orders/${o.id}`, { method: 'PUT', token: SECRET, body: { lines: [{ id: o.items[0].id, qty: 3 }], note: 'x' } });
  assert.equal(res.status, 200, await res.clone().text());
  // but a new key outside every scope still is not
  res = await call(env, `/api/admin/orders/${o.id}`, { method: 'PUT', token: SECRET, body: { lines: [{ id: o.items[0].id, photo_keys: [F1, F3] }] } });
  assert.equal(res.status, 400);
  assert.equal(await code(res), 'photo_not_in_project');
});

test('/api/pick/shop advertises ordering only with the switch on (owner and viewers alike)', async () => {
  const { env, p } = await ready();
  const viewer = await (await pick(env, 'GET', 'shop', p.token)).json();
  const owner = await (await pick(env, 'GET', 'shop', p.token, { key: p.key })).json();
  assert.deepEqual(viewer.ordering, { consent_version: 'v1', delivery_methods: ['pickup'], max_lines: 20, print_qty_max: 10, album_qty_max: 3 });
  assert.deepEqual(owner, viewer);
  env.GUEST_ORDERS = 'off';
  assert.equal((await (await pick(env, 'GET', 'shop', p.token)).json()).ordering, null);
});

test('albumPagesProblem / albumExtraPagesCost are wired into the guest order path only', () => {
  const route = WORKER.slice(WORKER.indexOf('async function guestOrderLines('));
  assert.ok(route.length < WORKER.length);
  const fn = route.slice(0, route.indexOf('\n}\n'));
  assert.ok(fn.includes('albumPagesProblem('));
  assert.ok(fn.includes('albumExtraPagesCost('));
});
