// S2 guest ordering — the abuse and security list of docs/guest-shop.md §7,
// one test per case. Every case first proves the positive on the same
// fixture (the seat holder of a delivered, confirmed project orders: 201),
// then changes one thing, so a refusal is never an earlier guard firing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  envOf, catalogue, confirmed, ready, printLine, albumLine, orderBody, placeOrder, myOrders, cancelOrder, placed,
  orderRows, itemRows, dbSnapshot, adminOrders, code, walk, F_MISSING, OP,
  F1, F2, PA, PB, FINAL, FINAL2, admin, deliver, confirm, delivered, SECRET, call, pick, rows, one, landOnce, claim,
} from './guest-order-helpers.mjs';

const mail = env => env.NOTIFY_EMAIL.sent;
const orderStatus = (env, id, s, token = SECRET) => call(env, `/api/admin/orders/${id}/status`, { method: 'POST', token, body: { status: s } });

test('#1 price tampering: unit_price, price, total, kind, name, list_price, unit_cost in the body are ignored', async () => {
  const { env, c, p } = await ready();
  const line = { ...printLine(c, { qty: 2 }), unit_price: 1, price: 1, list_price: 1, unit_cost: 0, vendor_cost: 0, kind: 'service', name: '免費', option_label: 'x', photo_keys: [PA] };
  const res = await placeOrder(env, p, { ...orderBody(c, { lines: [line], expected_total: 6000 }), total: 1, subtotal: 1, discount: 6000, status: 'confirmed', source: 'admin', shipping_fee: 0, picker_id: 'x', photographer_id: 'other' });
  assert.equal(res.status, 201, await res.clone().text());
  const [item] = itemRows(env);
  assert.equal(item.unit_price, 3000);
  assert.equal(item.list_price, 3000);
  assert.equal(item.unit_cost, 2000);
  assert.equal(item.vendor_cost, 900);
  assert.equal(item.kind, 'print');
  assert.equal(item.name, '無框畫');
  assert.equal(item.option_label, '16×20');
  assert.deepEqual(JSON.parse(item.photo_keys), [F1], 'photo_keys from the body is not read: photo_key is');
  const [row] = orderRows(env);
  assert.equal(row.discount, 0);
  assert.equal(row.status, 'requested');
  assert.equal(row.source, 'guest');
  assert.equal(row.picker_id, p.pickerId);
  assert.equal(row.photographer_id, 'default');
  // an expected_total that matches a tampered price is a price_changed
  const cheap = await placeOrder(env, p, orderBody(c, { lines: [{ ...printLine(c), unit_price: 1 }], expected_total: 1 }));
  assert.equal(cheap.status, 409);
  assert.equal(await code(cheap), 'price_changed');
});

test('#2 expected_total differs from the server\'s (price changed, platform price raised): 409 price_changed with the quote, nothing written', async () => {
  const { env, c, p } = await ready();
  assert.equal((await placeOrder(env, p, orderBody(c))).status, 201);
  const before = dbSnapshot(env);
  const lines = [printLine(c, { photo_key: F2, qty: 2 }), albumLine(c, { spreads: 12 })];
  const res = await placeOrder(env, p, orderBody(c, { lines, expected_total: 11000 }));
  assert.equal(res.status, 409);
  const j = await res.json();
  assert.equal(j.code, 'price_changed');
  assert.deepEqual(j.quote, {
    lines: [{ option_id: c.print.options[0].id, qty: 2, unit_price: 3000 }, { option_id: c.album.options[0].id, qty: 1, unit_price: 5300 }],
    subtotal: 11300, total: 11300,
  });
  assert.equal(dbSnapshot(env), before);
  assert.equal((await placeOrder(env, p, orderBody(c, { lines, expected_total: 11300 }))).status, 201);
  // the photographer reprices between page load and submit
  env.DB._db.prepare('UPDATE product_options SET price = 3500 WHERE id = ?').run(c.print.options[0].id);
  const r2 = await placeOrder(env, p, orderBody(c, { expected_total: 3000 }));
  assert.equal(r2.status, 409);
  assert.equal((await r2.json()).quote.total, 3500);
});

test('#3 options not in the guest shop: hidden, retired, platform-retired, under the platform price, a service, another photographer\'s, unknown → 404 product_not_offered', async () => {
  const env = envOf({ extra: { CUSTOM_PRODUCTS: 'on' } });
  const c = await catalogue(env);
  const p = await confirmed(env);
  assert.equal((await placeOrder(env, p, orderBody(c))).status, 201);
  const svc = await call(env, '/api/admin/products', { method: 'POST', token: SECRET, body: { kind: 'service', name: '加修', guest_visible: true, options: [{ label: '', price: 500 }] } });
  assert.equal(svc.status, 201, await svc.clone().text());
  const service = (await svc.json()).product;
  const at = new Date().toISOString();
  env.DB._db.prepare("INSERT INTO products (id, photographer_id, kind, name, guest_visible, created_at, updated_at, platform_product_id) VALUES ('theirs', 'other', 'print', 'x', 1, ?, ?, ?)").run(at, at, c.ppPrint.id);
  env.DB._db.prepare("INSERT INTO product_options (id, product_id, label, price, platform_option_id) VALUES ('theirs-o', 'theirs', '', 9000, ?)").run(c.ppPrint.options[0].id);
  const tryOption = async (option_id, extra = {}) => {
    const res = await placeOrder(env, p, orderBody(c, { lines: [{ option_id, qty: 1, photo_key: F1, ...extra }] }));
    assert.equal(res.status, 404, `${option_id} ${await res.clone().text()}`);
    assert.equal(await code(res), 'product_not_offered');
  };
  await tryOption(c.hidden.options[0].id);
  await tryOption(service.options[0].id);
  await tryOption('theirs-o');
  await tryOption('no-such-option');
  // under today's platform price
  env.DB._db.prepare('UPDATE platform_product_options SET platform_price = 3100 WHERE id = ?').run(c.ppPrint.options[0].id);
  await tryOption(c.print.options[0].id);
  env.DB._db.prepare('UPDATE platform_product_options SET platform_price = 2000 WHERE id = ?').run(c.ppPrint.options[0].id);
  // option retired, product retired, platform product retired
  env.DB._db.prepare('UPDATE product_options SET active = 0 WHERE id = ?').run(c.print.options[0].id);
  await tryOption(c.print.options[0].id);
  env.DB._db.prepare('UPDATE product_options SET active = 1 WHERE id = ?').run(c.print.options[0].id);
  assert.equal((await call(env, `/api/admin/products/${c.print.id}/retire`, { method: 'POST', token: SECRET })).status, 200);
  await tryOption(c.print.options[0].id);
  assert.equal((await call(env, `/api/operator/products/${c.ppAlbum.id}/retire`, { method: 'POST', token: OP })).status, 200);
  await tryOption(c.album.options[0].id, { photo_key: undefined, spreads: 10 });
  // the project's photographer, never the default: a project of 'other' sees theirs only
  env.DB._db.prepare("UPDATE projects SET photographer_id = 'other' WHERE id = ?").run(p.id);
  await tryOption(c.unpriced.options[0].id, { photo_key: undefined, spreads: 10 });
});

test('#4 photo keys: proofs (proof download on or off), _thumbs/, _books/, another folder, .., trailing /, control characters, too long', async () => {
  const { env, c, p } = await ready();
  assert.equal((await placeOrder(env, p, orderBody(c))).status, 201);
  const tryKey = async (photo_key, status, want) => {
    const before = dbSnapshot(env);
    const res = await placeOrder(env, p, orderBody(c, { lines: [printLine(c, { photo_key })] }));
    assert.equal(res.status, status, `${JSON.stringify(photo_key)} ${await res.clone().text()}`);
    assert.equal(await code(res), want, JSON.stringify(photo_key));
    assert.equal(dbSnapshot(env), before);
  };
  for (const k of [PA, PB, '_thumbs/400/shoot/精修/f1.jpg.thumb', '_books/b1.json', 'other/x.jpg', 'shoot/精修/../毛片/a.jpg', 'shoot/精修二/g1.jpg']) {
    await tryKey(k, 403, 'not_in_finals');
  }
  for (const k of ['shoot/精修/', 'shoot/精修/a\u0000.jpg', 'shoot/精修/a\nb.jpg', `shoot/精修/${'x'.repeat(260)}.jpg`, 5, '']) {
    await tryKey(k, 400, 'invalid_photo_key');
  }
  // proof originals switched on: still not a final
  assert.equal((await call(env, `/api/admin/projects/${p.id}`, { method: 'PATCH', token: SECRET, body: { allow_proof_download: true } })).status, 200);
  await tryKey(PA, 403, 'not_in_finals');
});

test('#5 a final that is not in R2: 404 photo_not_found', async () => {
  const { env, c, p } = await ready();
  assert.equal((await placeOrder(env, p, orderBody(c))).status, 201);
  const before = dbSnapshot(env);
  const res = await placeOrder(env, p, orderBody(c, { lines: [printLine(c, { photo_key: F_MISSING })] }));
  assert.equal(res.status, 404);
  assert.equal(await code(res), 'photo_not_found');
  assert.equal(dbSnapshot(env), before);
});

test('#6 quantities and lines: qty 0 / 11 (print) / 4 (album) / 1.5 / "2"; 21 lines; the same photo on the same option twice', async () => {
  const { env, c, p } = await ready();
  assert.equal((await placeOrder(env, p, orderBody(c))).status, 201);
  const before = dbSnapshot(env);
  const cases = [
    [[printLine(c, { qty: 0 })], 'invalid_qty'], [[printLine(c, { qty: 11 })], 'invalid_qty'], [[albumLine(c, { qty: 4 })], 'invalid_qty'],
    [[printLine(c, { qty: 1.5 })], 'invalid_qty'], [[printLine(c, { qty: '2' })], 'invalid_qty'], [[printLine(c, { qty: undefined })], 'invalid_qty'],
    [Array.from({ length: 21 }, () => printLine(c)), 'too_many_lines'],
    [[printLine(c), printLine(c)], 'duplicate_line'],
    [[albumLine(c), albumLine(c, { spreads: 12 })], 'duplicate_line'],
  ];
  for (const [lines, want] of cases) {
    const res = await placeOrder(env, p, orderBody(c, { lines }));
    assert.equal(res.status, 400, want);
    const j = await res.json();
    assert.equal(j.code, want);
    if (want === 'too_many_lines') assert.equal(j.max, 20);
  }
  assert.equal(dbSnapshot(env), before);
  // 20 lines is fine
  const twenty = Array.from({ length: 20 }, (_, i) => printLine(c, { photo_key: i % 2 ? F1 : F2, option_id: c.print.options[0].id, qty: 1 }))
    .filter((l, i, all) => all.findIndex(x => x.photo_key === l.photo_key) === i);
  assert.equal((await placeOrder(env, p, orderBody(c, { lines: twenty, expected_total: 6000 }))).status, 201);
});

test('#7 album spreads: below min, above max, not whole, negative; extra pages not priced above min', async () => {
  const { env, c, p } = await ready();
  assert.equal((await placeOrder(env, p, orderBody(c, { lines: [albumLine(c)], expected_total: 5000 }))).status, 201);
  for (const [line, want] of [
    [albumLine(c, { spreads: 9 }), 'pages_below_min'], [albumLine(c, { spreads: 31 }), 'pages_above_max'],
    [albumLine(c, { spreads: 10.5 }), 'invalid_spreads'], [albumLine(c, { spreads: -3 }), 'invalid_spreads'],
    [{ option_id: c.unpriced.options[0].id, qty: 1, spreads: 12 }, 'extra_pages_unpriced'],
  ]) {
    const res = await placeOrder(env, p, orderBody(c, { lines: [line] }));
    assert.equal(res.status, 400);
    assert.equal(await code(res), want);
  }
});

test('#8 the same request twice (double tap, retry): 200 replay, one order, one email; a request_id that is not a UUID → 400', async () => {
  const { env, c, p } = await ready();
  const body = orderBody(c);
  const [a, b] = await Promise.all([placeOrder(env, p, body), placeOrder(env, p, body)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal(orderRows(env).length, 1);
  assert.equal(mail(env).length, 1);
  // the twin lands between this request's replay check and its write: the
  // INSERT itself refuses a second order for the request, and the answer is
  // the twin's order (the unique index is only the backstop)
  const twin = orderBody(c);
  landOnce(env, /INSERT INTO orders/, `INSERT INTO orders (id, photographer_id, project_id, source, status, picker_id, request_id, contact_name, created_at, updated_at)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'default', ?, 'guest', 'requested', ?, ?, '王小明', 'x', 'x')`, p.id, p.pickerId, twin.request_id);
  const raced = await placeOrder(env, p, twin);
  assert.equal(raced.status, 200, await raced.clone().text());
  const rj = await raced.json();
  assert.equal(rj.replay, true);
  assert.equal(rj.order.id, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(orderRows(env).filter(o => o.request_id === twin.request_id).length, 1);
  const bad = await placeOrder(env, p, orderBody(c, { request_id: 'not-a-uuid' }));
  assert.equal(bad.status, 400);
  assert.equal(await code(bad), 'invalid_request_id');
  // a request id already on another seat holder's order here (a seat reset,
  // and the id reused): never that order, never a second one — 409
  const firstId = (await (a.status === 201 ? a : b).clone().json()).order.id;
  assert.equal((await call(env, `/api/admin/projects/${p.id}/reset-seat`, { method: 'POST', token: SECRET })).status, 200);
  const next = await claim(env, p.token, '新的人');
  const dup = await placeOrder(env, p, { ...body }, next.key);
  assert.equal(dup.status, 409, await dup.clone().text());
  const dj = await dup.json();
  assert.equal(dj.code, 'duplicate_request');
  assert.ok(!JSON.stringify(dj).includes(firstId));
  assert.equal(orderRows(env).filter(o => o.request_id === body.request_id).length, 1);
  // the replay is the seat holder's own: another project's order with the
  // same request id is not handed out (a new order lands here)
  const q = await confirmed(env);
  const r = await placeOrder(env, q, { ...body });
  assert.equal(r.status, 201);
  assert.notEqual((await r.json()).order.id, (await a.clone().json()).order?.id ?? (await b.clone().json()).order.id);
});

test('#9 flood: the 4th open, the 21st guest order; two racing for the last open slot → one lands', async () => {
  const { env, c, p } = await ready();
  await placed(env, p, c);
  await placed(env, p, c);
  const [x, y] = await Promise.all([placeOrder(env, p, orderBody(c)), placeOrder(env, p, orderBody(c))]);
  assert.deepEqual([x.status, y.status].sort(), [201, 409]);
  assert.equal(orderRows(env).filter(o => o.status === 'requested').length, 3);
  const loser = x.status === 409 ? x : y;
  assert.equal(await code(loser), 'too_many_open_orders');
  // the cap rides inside the INSERT: a count the route read earlier does not matter
  for (const o of orderRows(env)) env.DB._db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(o.id);
  landOnce(env, /INSERT INTO orders/, `INSERT INTO orders (id, photographer_id, project_id, source, status, picker_id, created_at, updated_at)
    SELECT 'f' || value, 'default', ?, 'guest', 'cancelled', ?, 'x', 'x' FROM json_each('[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17]')`, p.id, p.pickerId);
  const res = await placeOrder(env, p, orderBody(c));
  assert.equal(res.status, 409);
  assert.equal(await code(res), 'order_cap');
});

test('#10 enumeration: cancel another project\'s / another picker\'s / an admin or system order / a non-UUID → 404; GET lists only one\'s own', async () => {
  const { env, c, p } = await ready();
  const mine = await placed(env, p, c);
  const q = await confirmed(env);
  const theirs = await placed(env, q, c);
  env.DB._db.prepare("INSERT INTO orders (id, photographer_id, project_id, source, status, picker_id, created_at, updated_at) VALUES ('11111111-1111-4111-8111-111111111111', 'default', ?, 'admin', 'requested', ?, 'x', 'x')").run(p.id, p.pickerId);
  env.DB._db.prepare("INSERT INTO orders (id, photographer_id, project_id, source, status, picker_id, created_at, updated_at) VALUES ('22222222-2222-4222-8222-222222222222', 'default', ?, 'guest', 'requested', 'someone-else', 'x', 'x')").run(p.id);
  const before = dbSnapshot(env);
  for (const id of [theirs.id, '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'abc', mine.id.toUpperCase(), `${mine.id}x`]) {
    const res = await cancelOrder(env, p, id);
    assert.equal(res.status, 404, id);
    assert.equal(await code(res), 'not_found');
  }
  assert.equal(dbSnapshot(env), before);
  const listed = (await (await myOrders(env, p)).json()).orders;
  assert.deepEqual(listed.map(o => o.id), [mine.id]);
  assert.equal((await cancelOrder(env, p, mine.id)).status, 200, 'the positive');
});

test('#11 the seat: a viewer, no key, another project\'s key, a key from before a seat reset → 403 not_owner on all three routes', async () => {
  const { env, c, p } = await ready();
  const o = await placed(env, p, c);
  const q = await confirmed(env);
  const routes = key => [placeOrder(env, p, orderBody(c), key), myOrders(env, p, key), cancelOrder(env, p, o.id, key)];
  // (null: no X-Picker-Key header at all — undefined would take the helper's default)
  for (const key of [null, 'wrong-key', q.key]) {
    for (const res of await Promise.all(routes(key))) {
      assert.equal(res.status, 403, String(key));
      assert.equal(await code(res), 'not_owner');
    }
  }
  assert.equal(orderRows(env).filter(r => r.project_id === p.id).length, 1);
  // seat reset: the old key is out, and the new holder does not see the old orders
  assert.equal((await call(env, `/api/admin/projects/${p.id}/reset-seat`, { method: 'POST', token: SECRET })).status, 200);
  for (const res of await Promise.all(routes(p.key))) {
    assert.equal(res.status, 403);
    assert.equal(await code(res), 'not_owner');
  }
  const fresh = await claim(env, p.token, '新的人');
  assert.deepEqual((await (await myOrders(env, p, fresh.key)).json()).orders, []);
  assert.equal((await cancelOrder(env, p, o.id, fresh.key)).status, 404);
});

test('#12 state: not delivered, delivered not confirmed, after undeliver / reopen / a new deliver → 409 not_confirmed (before the body is read); GET and cancel still work', async () => {
  const { env, c, p } = await ready();
  const o = await placed(env, p, c);
  for (const [action, body] of [['undeliver'], ['deliver', { final_folders: [FINAL] }], ['reopen']]) {
    assert.equal((await admin(env, p.id, action, body)).status, 200, action);
    // even an oversized / broken body gets the state answer first
    for (const b of [orderBody(c), '{broken', 'x'.repeat(40 * 1024)]) {
      const res = await placeOrder(env, p, b);
      assert.equal(res.status, 409, action);
      assert.equal(await code(res), 'not_confirmed');
    }
    assert.equal((await myOrders(env, p)).status, 200);
  }
  assert.equal((await cancelOrder(env, p, o.id)).status, 200);
});

test('#13 only the photographer confirms: pick, studio, client and operator tokens on the admin status route → 401; no guest route confirms', async () => {
  const { env, c, p } = await ready();
  const o = await placed(env, p, c);
  for (const token of [p.token, OP, 'nope']) {
    const res = await orderStatus(env, o.id, 'confirmed', token);
    assert.equal(res.status, 401, token);
  }
  for (const path of [`orders/${o.id}/confirm`, `orders/${o.id}/status`, `orders/${o.id}`]) {
    const res = await pick(env, 'POST', path, p.token, { key: p.key, body: { status: 'confirmed' } });
    assert.equal(res.status, 404, path);
  }
  assert.equal(orderRows(env)[0].status, 'requested');
  assert.equal((await orderStatus(env, o.id, 'confirmed')).status, 200, 'the positive');
});

test('#14 injection: <script>, CRLF Bcc:, U+202E in name / note → the email subject is one line, the HTML is escaped', async () => {
  const { env, c, p } = await ready();
  await placed(env, p, c, { contact: { name: '<script>x</script>', phone: '0912345678' }, note: 'a\r\nBcc: evil@example.com\n<img src=x onerror=alert(1)>' });
  // a name with bidi characters is refused outright (invalid_contact); the
  // claim name (picker) is not part of this mail
  const [m] = mail(env);
  assert.doesNotMatch(m.subject, /[\r\n‮]/);
  assert.ok(!m.html.includes('<script>'));
  assert.ok(!m.html.includes('<img'));
  assert.ok(m.html.includes('&lt;img'));
  assert.ok(!/^Bcc:/m.test(m.subject));
  const r = await placeOrder(env, p, orderBody(c, { contact: { name: 'a‮b', phone: '0912345678' } }));
  assert.equal(await code(r), 'invalid_contact');
});

test('#15 race: photographer confirms vs guest cancels — both conditional on requested; the later one is 409 bad_transition with the real from', async () => {
  const { env, c, p } = await ready();
  const o = await placed(env, p, c);
  // the photographer's confirm lands between the guest route's read and its write
  landOnce(env, /UPDATE orders SET status = 'cancelled'/, "UPDATE orders SET status = 'confirmed', confirmed_at = 'now' WHERE id = ?", o.id);
  const res = await cancelOrder(env, p, o.id);
  assert.equal(res.status, 409);
  const j = await res.json();
  assert.equal(j.code, 'bad_transition');
  assert.equal(j.from, 'confirmed');
  assert.equal(orderRows(env)[0].status, 'confirmed');
  // and the other way: the guest cancelled first, the admin confirm is 409
  const o2 = await placed(env, p, c);
  assert.equal((await cancelOrder(env, p, o2.id)).status, 200);
  const late = await orderStatus(env, o2.id, 'confirmed');
  assert.equal(late.status, 409);
  assert.equal((await late.json()).code, 'bad_transition');
});

test('#16 race: a new deliver / undeliver / archive / seat reset / revoke landing during the create → nothing lands; re-read answers 409 / 403 / 401', async () => {
  const cases = [
    ['new deliver', p => [`UPDATE projects SET delivered_at = 'later', final_folders = '["shoot/精修二/"]', client_confirmed_at = NULL WHERE id = ?`, p.id], 409, 'not_confirmed'],
    ['undeliver', p => ['UPDATE projects SET delivered_at = NULL, client_confirmed_at = NULL WHERE id = ?', p.id], 409, 'not_confirmed'],
    ['unconfirmed', p => ['UPDATE projects SET client_confirmed_at = NULL WHERE id = ?', p.id], 409, 'not_confirmed'],
    ['same folders, new stamp, confirmed by hand', p => ["UPDATE projects SET delivered_at = 'later' WHERE id = ?", p.id], 409, 'delivery_changed'],
    ['archive', p => ["UPDATE projects SET archived_at = 'now' WHERE id = ?", p.id], 401, undefined],
    ['seat reset', p => ['UPDATE projects SET owner_picker_id = NULL WHERE id = ?', p.id], 403, 'not_owner'],
    ['revoke', p => ["UPDATE share_tokens SET revoked_at = 'now' WHERE token = ?", p.token], 401, undefined],
  ];
  for (const [name, sql, status, want] of cases) {
    const { env, c, p } = await ready();
    const [s, ...args] = sql(p);
    landOnce(env, /INSERT INTO orders/, s, ...args);
    const res = await placeOrder(env, p, orderBody(c));
    assert.equal(res.status, status, `${name}: ${await res.clone().text()}`);
    assert.equal((await res.json()).code, want, name);
    assert.equal(orderRows(env).length, 0, name);
    assert.equal(itemRows(env).length, 0, name);
    assert.equal(mail(env).length, 0, name);
  }
});

test('#17 leaks: guest answers never carry unit_cost, vendor_cost, platform_option_id, list_price, note, request_id, picker_id, consent_version, final_folders or a full key', async () => {
  const { env, c, p } = await ready();
  const created = await (await placeOrder(env, p, orderBody(c, { lines: [printLine(c), albumLine(c, { spreads: 11 })], expected_total: 8150 }))).json();
  const o = created.order;
  await call(env, `/api/admin/orders/${o.id}`, { method: 'PUT', token: SECRET, body: { note: '私人備註' } });
  const listed = await (await myOrders(env, p)).json();
  const cancelled = await (await cancelOrder(env, p, o.id)).json();
  for (const answer of [created, listed, cancelled]) {
    const { keys } = walk(answer);
    for (const k of ['unit_cost', 'vendor_cost', 'platform_option_id', 'list_price', 'note', 'request_id', 'picker_id', 'consent_version',
      'final_folders', 'photo_keys', 'layout', 'photographer_id', 'project_id', 'source', 'paid_amount', 'contact_erased_at']) {
      assert.ok(!keys.has(k), `${k} in ${JSON.stringify(answer)}`);
    }
    const text = JSON.stringify(answer);
    assert.ok(!text.includes(FINAL), 'no folder');
    assert.ok(!text.includes('私人備註'));
    const { values } = walk(answer);
    for (const n of [2000, 900, 3500, 1500]) assert.ok(!values.includes(n), `no platform price or vendor cost (${n})`);
    // the positive: the guest view is there
    assert.ok(keys.has('unit_price') && keys.has('photo_name') && keys.has('spreads'));
  }
});

test('#18 a viewer\'s /api/pick/state and /shop say nothing of orders or contact', async () => {
  const { env, c, p } = await ready();
  await placed(env, p, c, { contact: { name: '王小明', phone: '0912999888', line: 'wangline' } });
  for (const key of [undefined, p.key]) {
    for (const route of ['state', 'shop']) {
      const res = await pick(env, 'GET', route, p.token, { key });
      assert.equal(res.status, 200);
      const text = await res.text();
      for (const s of ['0912999888', 'wangline', 'orders"', 'contact', 'requested']) assert.ok(!text.includes(s), `${route} ${key}: ${s}`);
    }
  }
});

test('#19 erase: the admin and the guest read only the name afterwards; the email never had the phone or LINE ID', async () => {
  const { env, c, p } = await ready();
  const o = await placed(env, p, c, { contact: { name: '王小明', phone: '0912999888', line: 'wangline' } });
  assert.equal((await call(env, `/api/admin/orders/${o.id}/erase-contact`, { method: 'POST', token: SECRET })).status, 200);
  const adminText = JSON.stringify(await adminOrders(env));
  const guestText = JSON.stringify(await (await myOrders(env, p)).json());
  for (const t of [adminText, guestText]) {
    assert.ok(!t.includes('0912999888') && !t.includes('wangline'));
    assert.ok(t.includes('王小明'));
  }
  const row = JSON.stringify(rows(env, 'SELECT * FROM orders'));
  assert.ok(!row.includes('0912999888') && !row.includes('wangline'));
  for (const m of mail(env)) assert.ok(!JSON.stringify(m).includes('0912999888') && !JSON.stringify(m).includes('wangline'));
  assert.ok(mail(env).length >= 1);
});

test('#20 the switch: unset, "off", "On", "true", "pilot" without this project → 403 ordering_disabled and ordering: null; "pilot" listing it → open', async () => {
  const { env, c, p } = await ready();
  assert.equal((await placeOrder(env, p, orderBody(c))).status, 201, 'the positive ("on")');
  const set = (v, pilot) => { env.GUEST_ORDERS = v; env.GUEST_ORDERS_PILOT = pilot; };
  for (const [v, pilot] of [[undefined], ['off'], ['On'], ['true'], ['1'], [' on'], ['pilot', ''], ['pilot', 'other-project'], ['pilot', undefined], ['pilot ', p.id], ['Pilot', p.id]]) {
    set(v, pilot);
    const before = dbSnapshot(env);
    const res = await placeOrder(env, p, orderBody(c));
    assert.equal(res.status, 403, `${v} ${pilot}`);
    assert.equal(await code(res), 'ordering_disabled');
    assert.equal(dbSnapshot(env), before);
    assert.equal((await (await pick(env, 'GET', 'shop', p.token)).json()).ordering, null, `${v} ${pilot}`);
    // reading and cancelling one's own order never depends on the switch
    assert.equal((await myOrders(env, p)).status, 200);
  }
  for (const pilot of [p.id, `other, ${p.id} ,x`, `${p.id},`]) {
    set('pilot', pilot);
    assert.equal((await placeOrder(env, p, orderBody(c))).status, 201, pilot);
    assert.ok((await (await pick(env, 'GET', 'shop', p.token)).json()).ordering);
    for (const o of orderRows(env)) env.DB._db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(o.id);
  }
  // the switch is read in one place
  const { WORKER } = await import('./guest-order-helpers.mjs');
  assert.equal((WORKER.match(/env\.GUEST_ORDERS\b/g) || []).length, 1);
  assert.equal((WORKER.match(/env\.GUEST_ORDERS_PILOT\b/g) || []).length, 1);
});

test('#21 consent: missing, true, "v0", "V1" → 400 consent_required', async () => {
  const { env, c, p } = await ready();
  for (const consent of [undefined, true, 'v0', 'V1', 1, null]) {
    const res = await placeOrder(env, p, orderBody(c, { consent }));
    assert.equal(res.status, 400, String(consent));
    assert.equal(await code(res), 'consent_required');
  }
  assert.equal(orderRows(env).length, 0);
  assert.equal((await placeOrder(env, p, orderBody(c, { consent: 'v1' }))).status, 201);
});

test('#22 a body over 32 KB (a lying Content-Length too) → 413 too_large, nothing parsed or written', async () => {
  const { env, c, p } = await ready();
  const big = JSON.stringify(orderBody(c, { note: 'x'.repeat(33 * 1024) }));
  const res = await placeOrder(env, p, big);
  assert.equal(res.status, 413);
  assert.equal(await code(res), 'too_large');
  const res2 = await pick(env, 'POST', 'orders', p.token, { key: p.key, body: JSON.stringify(orderBody(c)), headers: { 'Content-Length': String(40 * 1024) } });
  assert.equal(res2.status, 413);
  assert.equal(orderRows(env).length, 0);
});

test('#23 delivery: pickup only — "ship" or anything else → 400 invalid_delivery; an address on pickup is never stored', async () => {
  const { env, c, p } = await ready();
  for (const delivery of [{ method: 'ship', address: '台北市' }, { method: 'post' }, 'pickup', { }]) {
    const res = await placeOrder(env, p, orderBody(c, { delivery }));
    assert.equal(res.status, 400, JSON.stringify(delivery));
    assert.equal(await code(res), 'invalid_delivery');
  }
  assert.equal((await placeOrder(env, p, orderBody(c, { delivery: { method: 'pickup', address: '台北市信義路' } }))).status, 201);
  assert.equal((await placeOrder(env, p, orderBody(c, { delivery: undefined }))).status, 201, 'absent = pickup');
  assert.ok(!JSON.stringify(rows(env, 'SELECT * FROM orders')).includes('信義路'));
  assert.deepEqual(orderRows(env).map(o => o.delivery_method), ['pickup', 'pickup']);
});

test('#24 admin answers never carry vendor_cost or request_id (named columns), on every order route', async () => {
  const { env, c, p } = await ready();
  const o = await placed(env, p, c);
  const answers = [
    await adminOrders(env), await adminOrders(env, `/api/admin/projects/${p.id}/orders`),
    await (await orderStatus(env, o.id, 'confirmed')).json(),
    await (await call(env, `/api/admin/orders/${o.id}/payment`, { method: 'POST', token: SECRET, body: { paid_amount: 100, paid_method: 'transfer' } })).json(),
    await (await call(env, `/api/admin/orders/${o.id}`, { method: 'PUT', token: SECRET, body: { note: 'n' } })).json(),
    await (await call(env, `/api/admin/orders/${o.id}/erase-contact`, { method: 'POST', token: SECRET })).json(),
  ];
  for (const a of answers) {
    const { keys } = walk(a);
    assert.ok(!keys.has('vendor_cost') && !keys.has('request_id'), JSON.stringify(a));
    assert.ok(keys.has('contact'), 'the positive');
  }
});
