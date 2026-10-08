// studio_settings.pick_link_message: the photographer's own default text for
// the message sent with a pick link (admin.html 「複製連結」). Admin-only data
// write: the settings GET/PUT carry it, no guest route ever does (it is the
// photographer's private template), and before its hand-run migration reads
// give null and a PUT naming it writes nothing. Placeholders such as {連結}
// are plain text to the Worker (docs/dashboard-settings.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fakeDB } from './fakes.mjs';
import {
  WORKER, statementsOf, s2Schema, envOf, ready, placed, myOrders, cancelOrder, code, rows,
  FINAL, FRESH, SECRET, call, pick, deliver, retouching, confirm,
} from './guest-order-helpers.mjs';

const FIELD = 'pick_link_message';
const MAX = 1000;
const MIGRATION_FILE = new URL('../migrations/2026-10-10-pick-link-message.sql', import.meta.url);
const MIGRATION = existsSync(MIGRATION_FILE) ? readFileSync(MIGRATION_FILE, 'utf8') : '';
const settings = (env, body) => call(env, '/api/admin/settings', { method: body ? 'PUT' : 'GET', token: SECRET, body });
const put = (env, value) => settings(env, { [FIELD]: value });
const stored = env => rows(env, `SELECT ${FIELD} FROM studio_settings`)[0]?.[FIELD];
const table = env => JSON.stringify(rows(env, 'SELECT * FROM studio_settings'));
// schema.sql as a database that has not had this migration (the S2 columns stay)
// (functions: s2Schema throws while schema.sql lacks the column line)
const PRE = () => s2Schema({ orders: [], items: [], settings: [FIELD], index: false });
// ... nor the S2 one (transfer_info) before it
const PRE_BOTH = () => s2Schema({ orders: [], items: [], settings: ['transfer_info', FIELD], index: false });

// ─── the migration ──────────────────────────────────────────────────────────

test('migration: one append-only ALTER, noted in schema.sql; the fixture really lacks it', () => {
  assert.ok(MIGRATION, 'migration file');
  assert.match(MIGRATION, /D1 Console/);
  assert.match(MIGRATION, /pick_link_message_unavailable/);
  assert.match(MIGRATION, /duplicate column/i);
  assert.deepEqual(statementsOf(MIGRATION), [`ALTER TABLE studio_settings ADD COLUMN ${FIELD} TEXT`]);
  assert.match(FRESH, /2026-10-10-pick-link-message\.sql/);
  assert.match(FRESH, /ALTER TABLE studio_settings ADD COLUMN pick_link_message TEXT;/);
  const old = fakeDB({ schema: PRE() });
  assert.throws(() => old._db.prepare(`SELECT ${FIELD} FROM studio_settings`).all(), /no such column/);
  old._db.exec(MIGRATION);
  const shape = d => d._db.prepare('PRAGMA table_info(studio_settings)').all().map(c => ({ ...c }));
  assert.deepEqual(shape(old), shape(fakeDB()));
  assert.throws(() => old._db.exec(MIGRATION), /duplicate column/);
});

// ─── settings GET / PUT ─────────────────────────────────────────────────────

test('GET: pick_link_message starts null and is returned once set', async () => {
  const env = envOf();
  const s = await (await settings(env)).json();
  assert.ok(FIELD in s);
  assert.equal(s[FIELD], null);
  assert.equal((await put(env, '你好 {專案名稱}')).status, 200);
  assert.equal((await (await settings(env)).json())[FIELD], '你好 {專案名稱}');
});

test('PUT: stored trimmed at the ends, line breaks and tabs kept (CRLF as LF), placeholders untouched', async () => {
  const env = envOf();
  const text = '  嗨 {客人}，\r\n\t這是選片連結：{連結}\r\n\n{專案名稱}  \n ';
  const res = await put(env, text);
  assert.equal(res.status, 200, await res.clone().text());
  const want = '嗨 {客人}，\n\t這是選片連結：{連結}\n\n{專案名稱}';
  assert.equal((await res.json())[FIELD], want);
  assert.equal(stored(env), want);
  assert.equal((await (await settings(env)).json())[FIELD], want);
  // inner whitespace stays as typed
  assert.equal((await (await put(env, 'a  \t b')).json())[FIELD], 'a  \t b');
});

test('PUT: at most 1000 code points (not UTF-16 units), counted after trimming', async () => {
  const env = envOf();
  for (const ok of ['x'.repeat(MAX), '😀'.repeat(MAX), `  ${'x'.repeat(MAX)}  `, `\n${'字'.repeat(MAX)}\n`]) {
    const res = await put(env, ok);
    assert.equal(res.status, 200, `${ok.length} units`);
    assert.equal(stored(env), ok.trim());
  }
  const before = table(env);
  for (const over of ['x'.repeat(MAX + 1), '😀'.repeat(MAX + 1), '字'.repeat(MAX + 1), ` ${'x'.repeat(MAX)}y `]) {
    const res = await put(env, over);
    assert.equal(res.status, 400, `${over.length} units`);
    assert.equal(await code(res), 'invalid_pick_link_message');
  }
  assert.equal(table(env), before, 'nothing written');
  assert.equal((await put(env, 'x'.repeat(MAX - 1) + '\n\n')).status, 200, 'trailing breaks trimmed before counting');
  assert.equal(stored(env), 'x'.repeat(MAX - 1));
  assert.notEqual(table(env), before);
  assert.equal((await put(env, 'x'.repeat(MAX + 1))).status, 400);
  assert.equal(stored(env), 'x'.repeat(MAX - 1), 'a refused PUT keeps the last value');
});

test('PUT: control characters other than \\n and \\t, bidi controls, lone surrogates and non-strings are refused, nothing written', async () => {
  const env = envOf();
  assert.equal((await put(env, '原本')).status, 200);
  const before = table(env);
  const bad = [
    'a\u0000b', 'a\u0007b', 'a\u0008b', 'a\u000bb', 'a\u000cb', 'a\u001bb', 'a\u001fb', 'a\u007fb', 'a\u0085b', 'a\u009fb',
    'a؜b', 'a‎b', 'a‏b', 'a‪b', 'a‮b', 'a⁦b', 'a⁩b', 'a b', 'a b', 'a﻿b',
    'a\ud800b', 'a\udfffb', '\ud83d',
    5, 0, true, false, ['a'], { a: 1 },
  ];
  for (const v of bad) {
    const res = await settings(env, { studio_name: '不該寫入', [FIELD]: v });
    assert.equal(res.status, 400, JSON.stringify(v));
    assert.equal(await code(res), 'invalid_pick_link_message', JSON.stringify(v));
  }
  assert.equal(table(env), before);
  assert.equal(stored(env), '原本');
  // the positive: a real emoji (a surrogate pair) and \n / \t go through
  assert.equal((await put(env, '😀\n\t好')).status, 200);
  assert.equal(stored(env), '😀\n\t好');
});

test('PUT: \'\', whitespace or null clear it (null = the built-in default)', async () => {
  const env = envOf();
  for (const v of ['', '   ', ' \n\t\r\n ', null]) {
    assert.equal((await put(env, '有字')).status, 200);
    assert.equal(stored(env), '有字');
    const res = await put(env, v);
    assert.equal(res.status, 200, JSON.stringify(v));
    assert.equal((await res.json())[FIELD], null, JSON.stringify(v));
    assert.equal(stored(env), null);
  }
});

test('the shared paragraph check: transfer_info still stores a tab as a space, the message keeps it', async () => {
  const env = envOf();
  const res = await settings(env, { transfer_info: '銀行\t013\r\n帳號', [FIELD]: '銀行\t013\r\n帳號' });
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.equal(s.transfer_info, '銀行 013\n帳號');
  assert.equal(s[FIELD], '銀行\t013\n帳號');
  for (const v of ['a\u0000b', 'a\u202eb']) {
    const r = await settings(env, { transfer_info: v });
    assert.equal(await code(r), 'invalid_transfer_info', JSON.stringify(v));
  }
});

test('PUT: a body without the field leaves it alone; the field leaves the others alone', async () => {
  const env = envOf();
  assert.equal((await settings(env, { studio_name: '小明', transfer_info: '帳號', [FIELD]: '訊息' })).status, 200);
  assert.equal((await settings(env, { studio_name: '小明攝影' })).status, 200);
  assert.equal((await settings(env, { transfer_info: null })).status, 200);
  let s = await (await settings(env)).json();
  assert.equal(s[FIELD], '訊息');
  assert.equal((await put(env, '新訊息')).status, 200);
  s = await (await settings(env)).json();
  assert.equal(s[FIELD], '新訊息');
  assert.equal(s.studio_name, '小明攝影');
  assert.equal(s.transfer_info, null);
  // an unknown key spelled like it does nothing
  assert.equal((await settings(env, { pick_link_messages: 'x', PICK_LINK_MESSAGE: 'y' })).status, 200);
  assert.equal(stored(env), '新訊息');
});

test('admin only: GET and PUT need the photographer token', async () => {
  const env = envOf();
  assert.equal((await put(env, '私人')).status, 200);
  for (const token of [undefined, 'wrong']) {
    assert.equal((await call(env, '/api/admin/settings', { token })).status, 401);
    assert.equal((await call(env, '/api/admin/settings', { method: 'PUT', token, body: { [FIELD]: '別人' } })).status, 401);
  }
  assert.equal(stored(env), '私人');
});

// ─── before the migration ───────────────────────────────────────────────────

test('before the migration: GET reads null, a PUT naming it is 500 and writes nothing, a PUT without it works', async () => {
  for (const cut of [PRE, PRE_BOTH]) {
    const env = envOf({ schema: cut() });
    let res = await settings(env);
    assert.equal(res.status, 200);
    assert.equal((await res.json())[FIELD], null);
    assert.equal((await settings(env, { studio_name: '小明攝影' })).status, 200);
    const before = table(env);
    for (const v of ['訊息', '', null]) {
      res = await settings(env, { studio_name: '別的', [FIELD]: v });
      assert.equal(res.status, 500, JSON.stringify(v));
      assert.equal(await code(res), 'pick_link_message_unavailable');
      assert.match(res.headers.get('Cache-Control') || '', /no-store/);
    }
    assert.equal(table(env), before);
    res = await settings(env, { studio_name: '還是能存' });
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.equal(s.studio_name, '還是能存');
    assert.equal(s[FIELD], null);
  }
  // with transfer_info still there it keeps reading (positive: not all-null)
  const env = envOf({ schema: PRE() });
  assert.equal((await settings(env, { transfer_info: '帳號' })).status, 200);
  assert.equal((await (await settings(env)).json()).transfer_info, '帳號');
});

// ─── the guest: never ───────────────────────────────────────────────────────

const MARK = '攝影師私人範本Z';
const clean = async (label, res, status = 200) => {
  const text = await res.text();
  assert.equal(res.status, status, `${label}: ${text}`);
  assert.ok(!text.includes(MARK), label);
  assert.ok(!text.includes(FIELD), label);
  return text;
};

test('no guest route carries it: state (owner, viewer; picking, retouching, delivered, confirmed), shop, rounds, ?list=, orders', async () => {
  const env = envOf();
  assert.equal((await settings(env, { studio_name: '小明攝影', [FIELD]: MARK })).status, 200);
  const p = await retouching(env);
  const states = async phase => {
    for (const key of [p.key, undefined]) {
      const s = JSON.parse(await clean(`state ${phase} ${key ? 'owner' : 'viewer'}`, await pick(env, 'GET', 'state', p.token, { key })));
      assert.equal(s.studio?.name, '小明攝影', 'positive: the studio brand is there');
    }
  };
  await states('retouching');
  assert.equal((await deliver(env, p.id)).status, 200);
  await states('delivered');
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
  await states('confirmed');
  for (const route of ['shop', 'rounds']) await clean(route, await pick(env, 'GET', route, p.token, { key: p.key }));
  const listText = await clean('list', await call(env, `/?list=${encodeURIComponent(FINAL)}&t=${encodeURIComponent(p.token)}`));
  assert.match(listText, /f1\.jpg/, 'positive: the list answered');
  // the photographer does see it
  assert.equal((await (await settings(env)).json())[FIELD], MARK);
});

test('no guest order route carries it either (place, list, cancel)', async () => {
  const { env, c, p } = await ready();
  assert.equal((await put(env, MARK)).status, 200);
  assert.equal((await settings(env, { transfer_info: '國泰世華 013' })).status, 200);
  const order = await placed(env, p, c);
  assert.ok(!JSON.stringify(order).includes(MARK));
  assert.ok(!(FIELD in order));
  await clean('orders', await myOrders(env, p));
  const shop = JSON.parse(await clean('shop', await pick(env, 'GET', 'shop', p.token, { key: p.key })));
  assert.ok(shop.ordering, 'positive: ordering is on');
  await clean('cancel', await cancelOrder(env, p, order.id));
});

test('static: the column is named only in the settings read and the settings PUT', () => {
  // every SELECT of it is readStudioSettings's (the guest brand reads three other fields off it)
  const named = WORKER.split('\n').filter(l => l.includes(FIELD) && !/^\s*\/\//.test(l));
  assert.ok(named.length > 0);
  assert.doesNotMatch(WORKER, /pick_link_message FROM/);
  assert.match(WORKER, /async function pickStudio[\s\S]{0,200}return \{ name: s\.studio_name, booking_url: s\.booking_url, has_logo: s\.has_logo \}/);
});
