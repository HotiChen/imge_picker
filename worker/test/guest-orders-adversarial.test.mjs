// S2 guest ordering — adversarial review (WP2). Attacks beyond the §7 list in
// guest-orders-security.test.mjs: every case proves the positive on the same
// fixture first (201 for the seat holder of a delivered, confirmed project),
// then changes one thing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  envOf, catalogue, confirmed, ready, printLine, albumLine, orderBody, placeOrder, myOrders, cancelOrder, placed,
  orderRows, itemRows, dbSnapshot, adminOrders, code, walk, s2Schema, S2_ORDER_COLUMNS, S2_ITEM_COLUMNS, S2_SETTINGS_COLUMNS,
  F1, F2, PA, FINAL, FINAL2, G1, admin, deliver, confirm, SECRET, call, pick, rows, claim, OP,
} from './guest-order-helpers.mjs';

const noStore = (res, what) => {
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store', `${what}: Cache-Control`);
  assert.match(res.headers.get('Vary') || '', /X-Share-Token/, `${what}: Vary`);
};

// ─── response headers ────────────────────────────────────────────────────────

test('every answer of the guest order routes is private, no-store (Vary X-Share-Token) — the parse errors and 413 too', async () => {
  const { env, c, p } = await ready();
  const body = orderBody(c);
  const created = await placeOrder(env, p, body);
  assert.equal(created.status, 201);
  noStore(created, '201');
  const id = (await created.json()).order.id;
  const cases = [
    ['replay 200', () => placeOrder(env, p, body), 200],
    ['GET 200', () => myOrders(env, p), 200],
    ['Invalid JSON 400', () => placeOrder(env, p, '{nope'), 400],
    ['invalid_body 400', () => placeOrder(env, p, '[]'), 400],
    ['too_large 413', () => placeOrder(env, p, JSON.stringify(orderBody(c, { note: 'x'.repeat(40 * 1024) }))), 413],
    ['price_changed 409', () => placeOrder(env, p, orderBody(c, { expected_total: 1 })), 409],
    ['not_owner 403', () => placeOrder(env, p, orderBody(c), 'wrong'), 403],
    ['405', () => pick(env, 'PUT', 'orders', p.token, { key: p.key, body: {} }), 405],
    ['404 path', () => pick(env, 'POST', `orders/${id}`, p.token, { key: p.key, body: {} }), 404],
    ['cancel 200', () => cancelOrder(env, p, id), 200],
    ['cancel 404', () => cancelOrder(env, p, 'nope'), 404],
  ];
  for (const [what, run, status] of cases) {
    const res = await run();
    assert.equal(res.status, status, what);
    noStore(res, what);
  }
});

// ─── money tampering ─────────────────────────────────────────────────────────

test('money: expected_total / qty / spreads as strings, floats, unicode digits, exponents, Infinity, booleans, huge → refused; JSON 3e3 is just 3000', async () => {
  const { env, c, p } = await ready();
  assert.equal((await placeOrder(env, p, orderBody(c))).status, 201, 'the positive');
  const before = dbSnapshot(env);
  for (const expected_total of ['3000', '３０００', 3000.0001, -0.5, true, [3000], { v: 3000 }, Number.MAX_SAFE_INTEGER + 2]) {
    const res = await placeOrder(env, p, orderBody(c, { expected_total }));
    assert.equal(res.status, 400, JSON.stringify(expected_total));
    assert.equal(await code(res), 'invalid_body');
  }
  // 1e400 is Infinity once parsed; NaN is not JSON at all
  for (const raw of ['1e400', 'NaN', '-Infinity']) {
    const text = JSON.stringify(orderBody(c)).replace('"expected_total":3000', `"expected_total":${raw}`);
    const res = await placeOrder(env, p, text);
    assert.equal(res.status, 400, raw);
  }
  for (const qty of ['1', '１', 1.0000001, true, [1], 1e400 === Infinity ? null : 0, -1]) {
    const res = await placeOrder(env, p, orderBody(c, { lines: [printLine(c, { qty })] }));
    assert.equal(res.status, 400, JSON.stringify(qty));
    assert.equal(await code(res), 'invalid_qty', JSON.stringify(qty));
  }
  for (const spreads of ['10', '１０', 10.5, 0, true, null, 201, Number.MAX_SAFE_INTEGER]) {
    const res = await placeOrder(env, p, orderBody(c, { lines: [albumLine(c, { spreads })], expected_total: 5000 }));
    assert.equal(res.status, 400, JSON.stringify(spreads));
    assert.equal(await code(res), 'invalid_spreads', JSON.stringify(spreads));
  }
  assert.equal(dbSnapshot(env), before);
  // the same number written another way in JSON is the same number
  const text = JSON.stringify(orderBody(c, { lines: [printLine(c, { photo_key: F2 })] })).replace('"expected_total":3000', '"expected_total":3e3');
  assert.equal((await placeOrder(env, p, text)).status, 201);
});

test('money: prototype keys and duplicate JSON keys never smuggle a field in (last key wins, own properties only)', async () => {
  const { env, c, p } = await ready();
  const opt = c.print.options[0].id;
  const album = c.album.options[0].id;
  const raw = s => placeOrder(env, p, s);
  const rid = () => crypto.randomUUID();
  // __proto__ in a JSON body is an own key, never the prototype: an album line
  // whose "__proto__" holds a photo is still an album line with no photo
  let res = await raw(`{"request_id":"${rid()}","lines":[{"option_id":"${album}","qty":1,"spreads":10,"__proto__":{"photo_key":"${PA}","unit_price":1}}],` +
    `"contact":{"name":"王","phone":"0912345678"},"expected_total":5000,"consent":"v1"}`);
  assert.equal(res.status, 201, await res.clone().text());
  assert.equal(itemRows(env).at(-1).unit_price, 5000);
  assert.deepEqual(JSON.parse(itemRows(env).at(-1).photo_keys), []);
  // a contact whose fields are only on "__proto__" / "constructor" is no contact
  for (const contact of ['{"__proto__":{"name":"王","phone":"0912345678"}}', '{"constructor":{"name":"王"},"phone":"0912345678"}']) {
    res = await raw(`{"request_id":"${rid()}","lines":[{"option_id":"${opt}","qty":1,"photo_key":"${F1}"}],"contact":${contact},"expected_total":3000,"consent":"v1"}`);
    assert.equal(res.status, 400, contact);
    assert.equal(await code(res), 'invalid_contact');
  }
  // the whole body on "__proto__": nothing there
  res = await raw(`{"__proto__":{"request_id":"${rid()}","lines":[{"option_id":"${opt}","qty":1,"photo_key":"${F1}"}]}}`);
  assert.equal(res.status, 400);
  assert.equal(await code(res), 'invalid_request_id');
  // duplicate keys: the last one is the one checked and the one used
  res = await raw(`{"request_id":"${rid()}","lines":[{"option_id":"${opt}","qty":1,"qty":11,"photo_key":"${F1}"}],"contact":{"name":"王","phone":"0912345678"},"expected_total":3000,"consent":"v1"}`);
  assert.equal(await code(res), 'invalid_qty');
  res = await raw(`{"request_id":"${rid()}","lines":[{"option_id":"${opt}","qty":1,"photo_key":"${F1}","photo_key":"${PA}"}],"contact":{"name":"王","phone":"0912345678"},"expected_total":3000,"consent":"v1"}`);
  assert.equal(res.status, 403);
  assert.equal(await code(res), 'not_in_finals');
  res = await raw(`{"request_id":"${rid()}","lines":[{"option_id":"${opt}","qty":1,"photo_key":"${F2}"}],"contact":{"name":"王","phone":"0912345678"},"expected_total":1,"expected_total":3000,"consent":"v1"}`);
  assert.equal(res.status, 201);
  assert.equal(itemRows(env).at(-1).unit_price, 3000);
});

// ─── options ─────────────────────────────────────────────────────────────────

test('options: one platform option retired (its product still live), an option id that is an object / array / huge string → refused', async () => {
  const { env, c, p } = await ready();
  assert.equal((await placeOrder(env, p, orderBody(c))).status, 201, 'the positive');
  const before = dbSnapshot(env);
  env.DB._db.prepare('UPDATE platform_product_options SET active = 0 WHERE id = ?').run(c.ppPrint.options[0].id);
  let res = await placeOrder(env, p, orderBody(c, { lines: [printLine(c, { photo_key: F2 })] }));
  assert.equal(res.status, 404);
  assert.equal(await code(res), 'product_not_offered');
  env.DB._db.prepare('UPDATE platform_product_options SET active = 1 WHERE id = ?').run(c.ppPrint.options[0].id);
  for (const option_id of [{ id: c.print.options[0].id }, [c.print.options[0].id], 'x'.repeat(201), null]) {
    res = await placeOrder(env, p, orderBody(c, { lines: [printLine(c, { option_id })] }));
    assert.equal(res.status, 400, JSON.stringify(option_id).slice(0, 40));
    assert.equal(await code(res), 'invalid_lines');
  }
  // SQL in an option id is just an unknown id (bound, never spliced)
  res = await placeOrder(env, p, orderBody(c, { lines: [printLine(c, { option_id: `' OR 1=1 --` })] }));
  assert.equal(res.status, 404);
  assert.equal(await code(res), 'product_not_offered');
  assert.equal(dbSnapshot(env), before);
});

// ─── photo keys ──────────────────────────────────────────────────────────────

test('photo keys: encoded traversal, ./, doubled slashes, bidi, trailing space, a final of an older delivery → never 201', async () => {
  const { env, c, p } = await ready();
  assert.equal((await placeOrder(env, p, orderBody(c))).status, 201, 'the positive');
  const before = dbSnapshot(env);
  const tryKey = async (photo_key, statuses) => {
    const res = await placeOrder(env, p, orderBody(c, { lines: [printLine(c, { photo_key })] }));
    assert.ok(statuses.includes(res.status), `${JSON.stringify(photo_key)} → ${res.status} ${await res.clone().text()}`);
  };
  for (const k of ['shoot/精修/%2e%2e/毛片/a.jpg', 'shoot/精修/..%2F毛片/a.jpg', 'shoot/精修//f1.jpg', 'shoot/精修/f1.jpg ',
    'shoot/精修/‮gpj.1f', 'shoot/精修/f1.jpg​', 'shoot/精修/sub/../f1.jpg']) {
    await tryKey(k, [403, 404]);
  }
  for (const k of ['shoot/精修/./f1.jpg', 'shoot//精修/f1.jpg', '/shoot/精修/f1.jpg', 'Shoot/精修/f1.jpg', '_thumbs/1600/shoot/精修/f1.jpg.thumb']) {
    await tryKey(k, [403]);
  }
  assert.equal(dbSnapshot(env), before);
  // a new delivery to FINAL2, confirmed again: a FINAL photo is no longer a final
  assert.equal((await deliver(env, p.id, [FINAL2])).status, 200);
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
  const old = await placeOrder(env, p, orderBody(c, { lines: [printLine(c, { photo_key: F2 })] }));
  assert.equal(old.status, 403);
  assert.equal(await code(old), 'not_in_finals');
  assert.equal((await placeOrder(env, p, orderBody(c, { lines: [printLine(c, { photo_key: G1 })] }))).status, 201, 'the positive, new finals');
});

// ─── albums ──────────────────────────────────────────────────────────────────

test('albums: spreads exactly min and max, one over, the no-minimum album, and an operator range turned upside down', async () => {
  const { env, c, p } = await ready();
  assert.equal((await placeOrder(env, p, orderBody(c, { lines: [albumLine(c, { spreads: 10 })], expected_total: 5000 }))).status, 201);
  assert.equal((await placeOrder(env, p, orderBody(c, { lines: [albumLine(c, { spreads: 30, qty: 3 })], expected_total: (5000 + 20 * 150) * 3 }))).status, 201);
  for (const o of orderRows(env)) env.DB._db.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").run(o.id);
  let res = await placeOrder(env, p, orderBody(c, { lines: [albumLine(c, { spreads: 31 })], expected_total: 5000 + 21 * 150 }));
  assert.equal(await code(res), 'pages_above_max');
  res = await placeOrder(env, p, orderBody(c, { lines: [{ option_id: c.nomin.options[0].id, qty: 1, spreads: 1 }], expected_total: 4000 }));
  assert.equal(res.status, 400);
  assert.equal(await code(res), 'album_not_orderable');
  // min above max (a slip in the operator console): nothing fits, nothing is sold
  env.DB._db.prepare('UPDATE platform_products SET min_pages = 20, max_pages = 12 WHERE id = ?').run(c.ppAlbum.id);
  for (const spreads of [12, 15, 20]) {
    res = await placeOrder(env, p, orderBody(c, { lines: [albumLine(c, { spreads })], expected_total: 5000 }));
    assert.equal(res.status, 400, String(spreads));
    assert.match(await code(res), /^pages_(below_min|above_max)$/);
  }
});

// ─── contact ─────────────────────────────────────────────────────────────────

test('contact: a "phone" with no digits at all is no phone (it cannot reach anyone) → invalid_contact', async () => {
  const { env, c, p } = await ready();
  assert.equal((await placeOrder(env, p, orderBody(c, { contact: { name: '王', phone: '(02) 2345-6789' } }))).status, 201, 'the positive');
  const before = dbSnapshot(env);
  for (const phone of ['------', '((()))', '+ + + +', '- - - -', '++++++++++++++++++++']) {
    const res = await placeOrder(env, p, orderBody(c, { contact: { name: '王', phone } }));
    assert.equal(res.status, 400, phone);
    assert.equal(await code(res), 'invalid_contact', phone);
  }
  assert.equal(dbSnapshot(env), before);
  // with a real LINE ID the order stands, but the junk phone still does not
  const res = await placeOrder(env, p, orderBody(c, { contact: { name: '王', phone: '------', line: 'wang' } }));
  assert.equal(await code(res), 'invalid_contact');
  // the boundary: six digits in any layout is a phone, five is not
  assert.equal(await code(await placeOrder(env, p, orderBody(c, { contact: { name: '王', phone: '1-2-3-4-5' } }))), 'invalid_contact');
  assert.equal(await code(await placeOrder(env, p, orderBody(c, { contact: { name: '王', phone: '(1) 2 3+4-5 ' } }))), 'invalid_contact');
  for (const phone of ['(1) 2-3 4+5 6', '123456']) {
    const ok = await placeOrder(env, p, orderBody(c, { contact: { name: '王', phone } }));
    assert.equal(ok.status, 201, phone);
    assert.equal((await cancelOrder(env, p, (await ok.json()).order.id)).status, 200);
  }
});

test('contact and note: formula-looking text (=, +, -, @) is stored as typed (no CSV of orders exists yet), never evaluated; enormous strings refused', async () => {
  const { env, c, p } = await ready();
  const o = await placed(env, p, c, { contact: { name: '=HYPERLINK("http://x","y")', phone: '+886912345678', line: '@evil' }, note: '-2+3\n=cmd|' });
  const [row] = orderRows(env);
  assert.equal(row.contact_name, '=HYPERLINK("http://x","y")');
  assert.equal(row.guest_note, '-2+3\n=cmd|');
  assert.equal(o.contact.name, '=HYPERLINK("http://x","y")');
  for (const contact of [{ name: 'x'.repeat(10000), phone: '0912345678' }, { name: '王', line: 'y'.repeat(10000) }]) {
    const res = await placeOrder(env, p, orderBody(c, { contact }));
    assert.equal(await code(res), 'invalid_contact');
  }
  assert.equal(await code(await placeOrder(env, p, orderBody(c, { note: 'n'.repeat(501) }))), 'invalid_note');
});

// ─── switch ──────────────────────────────────────────────────────────────────

test('switch: a pilot list naming a prefix / a longer id / the id in quotes or brackets is off; whitespace and empty items are fine', async () => {
  const { env, c, p } = await ready();
  env.GUEST_ORDERS = 'pilot';
  for (const pilot of [p.id.slice(0, -1), `${p.id}x`, `"${p.id}"`, `[${p.id}]`, p.id.toUpperCase(), `${p.id.slice(0, 18)},${p.id.slice(18)}`, `${p.id};x`]) {
    env.GUEST_ORDERS_PILOT = pilot;
    const res = await placeOrder(env, p, orderBody(c));
    assert.equal(res.status, 403, pilot);
    assert.equal(await code(res), 'ordering_disabled');
  }
  env.GUEST_ORDERS_PILOT = ` ,, \t${p.id}\t ,`;
  assert.equal((await placeOrder(env, p, orderBody(c))).status, 201, 'the positive');
  // a non-string variable (a [vars] table by mistake) is off
  for (const v of [true, ['on'], { on: 1 }]) {
    env.GUEST_ORDERS = v;
    assert.equal(await code(await placeOrder(env, p, orderBody(c))), 'ordering_disabled', JSON.stringify(v));
  }
});

// ─── idempotency ─────────────────────────────────────────────────────────────

test('request_id: the same id with different case is the same request; a v1/v3/nil UUID is refused; admin orders (NULL request_id) never collide', async () => {
  const { env, c, p } = await ready();
  const body = orderBody(c);
  const first = await placeOrder(env, p, body);
  assert.equal(first.status, 201);
  const again = await placeOrder(env, p, { ...body, request_id: body.request_id.toUpperCase() });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).replay, true);
  assert.equal(orderRows(env).length, 1);
  for (const request_id of ['00000000-0000-0000-0000-000000000000', 'a8098c1a-f86e-11da-bd1a-00112444be1e', '6fa459ea-ee8a-3ca4-894e-db77e160355e']) {
    assert.equal(await code(await placeOrder(env, p, orderBody(c, { request_id }))), 'invalid_request_id', request_id);
  }
  // two admin orders and the system extra-pick order in the same project:
  // NULL request ids under the unique index
  for (let i = 0; i < 2; i++) {
    const res = await call(env, `/api/admin/projects/${p.id}/orders`, { method: 'POST', token: SECRET, body: { lines: [{ option_id: c.print.options[0].id, qty: 1 }] } });
    assert.equal(res.status, 201, await res.clone().text());
  }
  assert.equal(orderRows(env).filter(o => o.request_id === null).length, 2);
  assert.equal((await placeOrder(env, p, orderBody(c))).status, 201, 'guest orders still land');
});

// ─── erase-contact ───────────────────────────────────────────────────────────

test('erase-contact: only the photographer token; pick / operator / no auth → 401; GET → 405; unknown / another photographer\'s → 404; nothing else changes', async () => {
  const { env, c, p } = await ready();
  const o = await placed(env, p, c, { contact: { name: '王小明', phone: '0912999888', line: 'wangline' } });
  const before = dbSnapshot(env);
  const erase = (id, opts = {}) => call(env, `/api/admin/orders/${id}/erase-contact`, { method: 'POST', ...opts });
  for (const opts of [{}, { token: p.token }, { token: OP }, { token: 'nope' }, { headers: { 'X-Share-Token': p.token } }]) {
    const res = await erase(o.id, opts);
    assert.equal(res.status, 401, JSON.stringify(opts));
  }
  assert.equal((await erase(o.id, { method: 'GET', token: SECRET })).status, 405);
  assert.equal((await erase('11111111-1111-4111-8111-111111111111', { token: SECRET })).status, 404);
  // another photographer's order (and project) reads as not found
  env.DB._db.prepare("UPDATE orders SET photographer_id = 'other' WHERE id = ?").run(o.id);
  env.DB._db.prepare("UPDATE projects SET photographer_id = 'other' WHERE id = ?").run(p.id);
  assert.equal((await erase(o.id, { token: SECRET })).status, 404);
  env.DB._db.prepare("UPDATE orders SET photographer_id = 'default' WHERE id = ?").run(o.id);
  env.DB._db.prepare("UPDATE projects SET photographer_id = 'default' WHERE id = ?").run(p.id);
  assert.equal(dbSnapshot(env), before);
  // the positive: exactly the two contact columns and the stamp change
  const rowBefore = { ...orderRows(env)[0] };
  const res = await erase(o.id, { token: SECRET });
  assert.equal(res.status, 200);
  noStoreAdmin(res);
  const rowAfter = { ...orderRows(env)[0] };
  const changed = Object.keys(rowAfter).filter(k => rowAfter[k] !== rowBefore[k]).sort();
  assert.deepEqual(changed, ['contact_erased_at', 'contact_line', 'contact_phone', 'updated_at']);
  // a replay writes nothing
  const snap = dbSnapshot(env);
  assert.equal((await erase(o.id, { token: SECRET })).status, 200);
  assert.equal(dbSnapshot(env), snap);
});
function noStoreAdmin(res) {
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
}

// ─── leaks ───────────────────────────────────────────────────────────────────

test('leaks: no guest-reachable answer carries contact_, request_id, vendor_cost or consent_version; the admin project detail and stats never request_id / vendor_cost', async () => {
  const { env, c, p } = await ready();
  const o = await placed(env, p, c, { contact: { name: '王小明', phone: '0912999888', line: 'wangline' } });
  await call(env, `/api/admin/orders/${o.id}/status`, { method: 'POST', token: SECRET, body: { status: 'confirmed' } });
  const viewer = undefined;
  const guestAnswers = [];
  for (const key of [p.key, viewer]) {
    for (const route of ['state', 'shop', 'orders', 'rounds']) {
      const res = await pick(env, 'GET', route, p.token, { key });
      guestAnswers.push([`${route} ${key ? 'owner' : 'viewer'}`, res.status, await res.text()]);
    }
  }
  for (const [what, , raw] of guestAnswers) {
    // the shop's own `ordering.consent_version` is the notice version the page
    // must send (public, the same for everyone), not an order's
    let text = raw;
    if (what.startsWith('shop')) {
      const j = JSON.parse(raw);
      assert.equal(j.ordering.consent_version, 'v1');
      delete j.ordering;
      text = JSON.stringify(j);
    }
    for (const s of ['contact_', 'request_id', 'vendor_cost', 'consent_version', 'unit_cost', 'platform_option_id', 'picker_id']) {
      assert.ok(!text.includes(s), `${what}: ${s}`);
    }
  }
  // the viewer never sees the phone; the owner does, only in their own orders
  for (const [what, , text] of guestAnswers.filter(([w]) => !w.startsWith('orders owner'))) assert.ok(!text.includes('0912999888'), what);
  assert.ok(guestAnswers.find(([w]) => w === 'orders owner')[2].includes('0912999888'), 'the positive');
  for (const path of [`/api/admin/projects/${p.id}`, '/api/admin/stats', '/api/admin/orders', `/api/admin/projects/${p.id}/orders`]) {
    const res = await call(env, path, { token: SECRET });
    assert.equal(res.status, 200, path);
    const { keys } = walk(await res.json());
    for (const k of ['request_id', 'vendor_cost']) assert.ok(!keys.has(k), `${path}: ${k}`);
  }
});

// ─── bodies ──────────────────────────────────────────────────────────────────

test('bodies: a chunked stream with no Content-Length over 32 KB → 413; under it → read normally; an odd Content-Type changes nothing', async () => {
  const { env, c, p } = await ready();
  const streamOf = text => {
    const bytes = new TextEncoder().encode(text);
    return new ReadableStream({
      start(ctl) { for (let i = 0; i < bytes.length; i += 1000) ctl.enqueue(bytes.slice(i, i + 1000)); ctl.close(); },
    });
  };
  const send = (text, headers = {}) => {
    const h = new Headers({ 'X-Picker-Key': p.key, ...headers });
    const r = new Request(`https://worker.test/api/pick/orders?t=${encodeURIComponent(p.token)}`, { method: 'POST', headers: h, body: streamOf(text), duplex: 'half' });
    assert.equal(r.headers.get('Content-Length'), null);
    return import('../worker.js').then(m => m.default.fetch(r, env, { waitUntil() {} }));
  };
  const big = await send(JSON.stringify(orderBody(c, { note: 'x'.repeat(40 * 1024) })));
  assert.equal(big.status, 413);
  assert.equal(orderRows(env).length, 0);
  const ok = await send(JSON.stringify(orderBody(c)), { 'Content-Type': 'text/plain' });
  assert.equal(ok.status, 201, await ok.clone().text());
});

test('methods: OPTIONS answers the CORS preflight with no body and writes nothing; HEAD → 405', async () => {
  const { env, c, p } = await ready();
  const before = dbSnapshot(env);
  const pre = await pick(env, 'OPTIONS', 'orders', p.token, { key: p.key });
  assert.ok(pre.status < 300);
  assert.equal(await pre.text(), '');
  assert.equal(dbSnapshot(env), before);
  assert.equal((await pick(env, 'HEAD', 'orders', p.token, { key: p.key })).status, 405);
  assert.equal((await placeOrder(env, p, orderBody(c))).status, 201, 'the positive');
});

// ─── atomicity ───────────────────────────────────────────────────────────────

test('atomicity: a line INSERT failing inside the batch leaves no order, no line, no email', async () => {
  const { env, c, p } = await ready();
  const prepare = env.DB.prepare.bind(env.DB);
  let n = 0;
  env.DB.prepare = sql => {
    const s = prepare(sql);
    if (!/^INSERT INTO order_items/.test(sql)) return s;
    return { bind: (...a) => { const b = s.bind(...a); return { ...b, run: async () => { if (++n === 2) throw new Error('D1_ERROR: disk I/O error'); return b.run(); } }; } };
  };
  await assert.rejects(placeOrder(env, p, orderBody(c, { lines: [printLine(c), printLine(c, { photo_key: F2 })], expected_total: 6000 })));
  env.DB.prepare = prepare;
  assert.equal(orderRows(env).length, 0);
  assert.equal(itemRows(env).length, 0);
  assert.equal(env.NOTIFY_EMAIL.sent.length, 0);
  assert.equal((await placeOrder(env, p, orderBody(c))).status, 201, 'the positive');
});

// ─── before the migration ────────────────────────────────────────────────────

test('migration: each of the ten ALTERs missing on its own → POST / GET / cancel / erase all 500 orders_unavailable (settings: only without its own column), nothing written', async () => {
  const all = [
    ...S2_ORDER_COLUMNS.map(col => ({ orders: [col], items: [], settings: [] })),
    ...S2_ITEM_COLUMNS.map(col => ({ orders: [], items: [col], settings: [] })),
    ...S2_SETTINGS_COLUMNS.map(col => ({ orders: [], items: [], settings: [col] })),
  ];
  assert.equal(all.length, 10);
  for (const drop of all) {
    const what = JSON.stringify(drop);
    // (the index names request_id: without that column it cannot be there either)
    const { env, c, p } = await ready({ schema: s2Schema({ ...drop, index: drop.orders.includes('request_id') }) });
    // a guest order made by hand, with what columns there are
    const id = crypto.randomUUID();
    env.DB._db.prepare("INSERT INTO orders (id, photographer_id, project_id, source, status, picker_id, created_at, updated_at) VALUES (?, 'default', ?, 'guest', 'requested', ?, 'x', 'x')").run(id, p.id, p.pickerId);
    const snap = dbSnapshot(env);
    const answers = [
      await placeOrder(env, p, orderBody(c)), await myOrders(env, p), await cancelOrder(env, p, id),
      await call(env, `/api/admin/orders/${id}/erase-contact`, { method: 'POST', token: SECRET }),
    ];
    for (const res of answers) {
      assert.equal(res.status, 500, `${what} ${res.url}`);
      assert.equal(await code(res), 'orders_unavailable', what);
    }
    assert.equal(dbSnapshot(env), snap, what);
    // the settings PUT looks at its own column only: saving the transfer text
    // before the orders columns exist is harmless (no guest route reads it
    // until all of them are there). Refused only when that column is missing.
    const settings = await call(env, '/api/admin/settings', { method: 'PUT', token: SECRET, body: { transfer_info: '台銀 123' } });
    if (drop.settings.includes('transfer_info')) {
      assert.equal(settings.status, 500, what);
      assert.equal(await code(settings), 'orders_unavailable');
    } else {
      assert.equal(settings.status, 200, what);
    }
    assert.equal(rows(env, 'SELECT * FROM orders').length, 1, what);
    // the photographer's side still works
    assert.equal((await call(env, '/api/admin/orders', { token: SECRET })).status, 200, what);
  }
});

// ─── state changes during the request ────────────────────────────────────────

test('races: the photographer reprices / hides the option between the quote and the write → the order lands at the price it was quoted (the write is not catalogue-gated)', async () => {
  // Documented behaviour, not a defect: the price is read once, compared with
  // expected_total, and written. A change landing inside those milliseconds is
  // the photographer's own; the order is a request the photographer confirms.
  const { env, c, p } = await ready();
  const { landOnce } = await import('./guest-order-helpers.mjs');
  landOnce(env, /INSERT INTO orders/, 'UPDATE product_options SET price = 9999 WHERE id = ?', c.print.options[0].id);
  const res = await placeOrder(env, p, orderBody(c));
  assert.equal(res.status, 201);
  assert.equal(itemRows(env)[0].unit_price, 3000);
});

test('cancel: a guest cannot cancel twice into two emails, nor cancel a confirmed, fulfilled or admin-cancelled order', async () => {
  const { env, c, p } = await ready();
  const o = await placed(env, p, c);
  const [a, b] = await Promise.all([cancelOrder(env, p, o.id), cancelOrder(env, p, o.id)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(env.NOTIFY_EMAIL.sent.filter(m => m.subject.startsWith('[客人取消訂單]')).length, 1);
  const o2 = await placed(env, p, c);
  const st = s => call(env, `/api/admin/orders/${o2.id}/status`, { method: 'POST', token: SECRET, body: { status: s } });
  assert.equal((await st('confirmed')).status, 200);
  assert.equal((await cancelOrder(env, p, o2.id)).status, 409);
  assert.equal((await st('fulfilled')).status, 200);
  const r = await cancelOrder(env, p, o2.id);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).from, 'fulfilled');
  assert.equal(orderRows(env).find(x => x.id === o2.id).status, 'fulfilled');
});
