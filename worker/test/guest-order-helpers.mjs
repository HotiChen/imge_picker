// Shared fixtures for the S2 guest-ordering tests (docs/guest-shop.md, 「S2 客人
// 自助訂購」 and 「S2 — Tim 的決定」): guest-orders.test.mjs (contract, money,
// admin side, before the migration) and guest-orders-security.test.mjs (§7,
// one test per abuse case). Not a test file itself: the runner globs
// *.test.mjs.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  FINAL, FINAL2, F1, F2, F3, G1, PA, PB, OBJECTS, FRESH, setup, fakeMailer, admin, deliver, confirm, guest,
  delivered, retouching, SECRET, call, pick, rows, one, landOnce, claim,
} from './revision-helpers.mjs';

export const OP = 'operator-secret';
export const WORKER = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
export const MIGRATION_FILE = new URL('../migrations/2026-10-09-guest-orders.sql', import.meta.url);
export const MIGRATION = existsSync(MIGRATION_FILE) ? readFileSync(MIGRATION_FILE, 'utf8') : '';
export const statementsOf = sql => sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);

// a final that is in the finals folder but not in R2
export const F_MISSING = 'shoot/精修/missing.jpg';

// What the migration adds, so a test can take it away again: schema.sql as
// the deployed database had it before (none of it), or with only part of the
// paste run. (SQLite's DROP COLUMN cannot rewrite a CREATE that has comments
// in it, so the columns are cut from the text, like the other suites do.)
export const S2_ORDER_COLUMNS = ['request_id', 'contact_name', 'contact_phone', 'contact_line', 'delivery_method', 'consent_version', 'contact_erased_at'];
export const S2_ITEM_COLUMNS = ['list_price', 'layout'];
export const S2_SETTINGS_COLUMNS = ['transfer_info'];
export function s2Schema({ orders = S2_ORDER_COLUMNS, items = S2_ITEM_COLUMNS, settings = S2_SETTINGS_COLUMNS, index = true } = {}) {
  let s = FRESH;
  for (const col of [...orders, ...items, ...settings]) {
    const re = new RegExp(`^[ \\t]*${col}[ \\t]+(TEXT|INTEGER)[^\\n]*\\n`, 'm');
    if (!re.test(s)) throw new Error(`s2Schema: no column line for ${col} in schema.sql`);
    s = s.replace(re, '');
  }
  // the column now last loses its comma (comments may sit between it and `);`)
  s = s.replace(/,([ \t]*--[^\n]*)?\n((?:[ \t]*--[^\n]*\n)*)\);/g, '$1\n$2);');
  if (index) {
    const re = /^CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_request[^\n]*\n/m;
    if (!re.test(s)) throw new Error('s2Schema: no idx_orders_request in schema.sql');
    s = s.replace(re, '');
  }
  return s;
}

export const envOf = (opts = {}) => setup({
  ...opts, extra: { OPERATOR_TOKEN: OP, GUEST_ORDERS: 'on', ...(opts.extra || {}) },
});

async function platformProduct(env, body = {}) {
  const res = await call(env, '/api/operator/products', {
    method: 'POST', token: OP, body: {
      kind: 'print', name: '無框畫', description: '木框', options: [{ label: '16×20', vendor_cost: 900, platform_price: 2000 }], ...body,
    },
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).product;
}
async function adopt(env, pp, { price = 3000, ...extra } = {}) {
  const res = await call(env, '/api/admin/products/from-platform', {
    method: 'POST', token: SECRET, body: {
      platform_product_id: pp.id, options: pp.options.map(o => ({ platform_option_id: o.id, price })), guest_visible: true, ...extra,
    },
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).product;
}

// The shop: a print (NT$3000, platform 2000), an album with a page range and
// an extra-page price (NT$5000 for 10 spreads, +150 a spread up to 30), an
// album whose extra pages are not priced, an album with no page minimum,
// a print the photographer hid, a service (never sold to guests).
export async function catalogue(env) {
  const ppPrint = await platformProduct(env);
  const print = await adopt(env, ppPrint);
  const ppAlbum = await platformProduct(env, {
    kind: 'album', name: '相本書', photo_count: 20, min_pages: 10, max_pages: 30, extra_page_price: 150,
    options: [{ label: '20×20', vendor_cost: 1500, platform_price: 3500 }],
  });
  const album = await adopt(env, ppAlbum, { price: 5000 });
  const unpriced = await adopt(env, await platformProduct(env, {
    kind: 'album', name: '小相本', min_pages: 10, max_pages: 20,
    options: [{ label: '15×15', vendor_cost: 1000, platform_price: 2000 }],
  }), { price: 4000 });
  const nomin = await adopt(env, await platformProduct(env, {
    kind: 'album', name: '自由相本', max_pages: 20, extra_page_price: 100,
    options: [{ label: '10×10', vendor_cost: 1000, platform_price: 2000 }],
  }), { price: 4000 });
  const hidden = await adopt(env, await platformProduct(env, { name: '桌曆' }), { guest_visible: false });
  return { ppPrint, print, ppAlbum, album, unpriced, nomin, hidden };
}

// delivered and confirmed by the client: the 完成頁
export async function confirmed(env, finals) {
  const p = await delivered(env, finals);
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
  if (env.NOTIFY_EMAIL?.sent) env.NOTIFY_EMAIL.sent.length = 0;
  return p;
}
export async function ready(opts) {
  const env = envOf(opts);
  const c = await catalogue(env);
  const p = await confirmed(env);
  return { env, c, p };
}

export const printLine = (c, over = {}) => ({ option_id: c.print.options[0].id, qty: 1, photo_key: F1, ...over });
export const albumLine = (c, over = {}) => ({ option_id: c.album.options[0].id, qty: 1, spreads: 10, ...over });
export function orderBody(c, over = {}) {
  return {
    request_id: crypto.randomUUID(),
    lines: [printLine(c)],
    contact: { name: '王小明', phone: '0912-345-678' },
    delivery: { method: 'pickup' },
    note: '',
    expected_total: 3000,
    consent: 'v1',
    ...over,
  };
}

export const placeOrder = (env, p, body, key = p.key) => guest(env, 'POST', 'orders', p.token, key, body);
export const myOrders = (env, p, key = p.key) => pick(env, 'GET', 'orders', p.token, { key });
export const cancelOrder = (env, p, id, key = p.key) => guest(env, 'POST', `orders/${id}/cancel`, p.token, key);
export async function placed(env, p, c, over = {}) {
  const res = await placeOrder(env, p, orderBody(c, over));
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).order;
}

export const orderRows = env => rows(env, 'SELECT * FROM orders ORDER BY rowid').map(r => ({ ...r }));
export const itemRows = env => rows(env, 'SELECT * FROM order_items ORDER BY rowid').map(r => ({ ...r }));
export const dbSnapshot = env => JSON.stringify(['orders', 'order_items', 'projects', 'product_interests', 'revision_requests']
  .map(t => { try { return rows(env, `SELECT * FROM ${t} ORDER BY rowid`); } catch { return null; } }));
export const adminOrders = async (env, path = '/api/admin/orders') => (await call(env, path, { token: SECRET })).json();
export const code = async res => (await res.clone().json()).code;

// every key anywhere in a JSON value, and every string / number in it
export function walk(v, keys = new Set(), values = []) {
  if (Array.isArray(v)) v.forEach(x => walk(x, keys, values));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x, keys, values); }
  else values.push(v);
  return { keys, values };
}

export {
  FINAL, FINAL2, F1, F2, F3, G1, PA, PB, OBJECTS, FRESH, setup, fakeMailer, admin, deliver, confirm, guest,
  delivered, retouching, SECRET, call, pick, rows, one, landOnce, claim,
};
