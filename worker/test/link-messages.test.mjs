// The copy-link message per project stage (admin.html 「複製連結」): besides
// studio_settings.pick_link_message (選片中, pick-link-message.test.mjs) the
// photographer keeps one template each for 已送出 (link_message_submitted),
// 已交件 (link_message_delivered) and 已完成 (link_message_done). Admin-only
// data writes, scoped to the caller (who.id): the settings GET/PUT carry
// them, no guest route ever does, and before their hand-run migration
// (worker/migrations/2026-10-16-link-messages.sql, three ALTERs) reads give
// null and a PUT naming any of them writes nothing at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fakeDB } from './fakes.mjs';
import {
  WORKER, statementsOf, s2Schema, envOf, ready, placed, myOrders, cancelOrder, code, rows, one,
  FINAL, FRESH, SECRET, call, pick, deliver, retouching, confirm,
} from './guest-order-helpers.mjs';
import { createProject } from './pick-helpers.mjs';
import { twoTenants, snapshot, ROUTES_ON } from './tenant-helpers.mjs';

const NEW = ['link_message_submitted', 'link_message_delivered', 'link_message_done'];
const ALL = ['pick_link_message', ...NEW];
const MAX = 1000;
const MIGRATION_FILE = new URL('../migrations/2026-10-16-link-messages.sql', import.meta.url);
const MIGRATION = existsSync(MIGRATION_FILE) ? readFileSync(MIGRATION_FILE, 'utf8') : '';
const settings = (env, body, token = SECRET) => call(env, '/api/admin/settings', { method: body ? 'PUT' : 'GET', token, body });
const stored = (env, field, id = 'default') => one(env, `SELECT ${field} FROM studio_settings WHERE photographer_id = ?`, id)?.[field];
const table = env => JSON.stringify(rows(env, 'SELECT * FROM studio_settings'));
// schema.sql as a database without some of the late studio_settings columns
const cut = (cols) => () => s2Schema({ orders: [], items: [], settings: cols, index: false });
const PRE = cut(NEW);
const PRE_ALL = cut(['transfer_info', ...ALL]);

// ─── the migration ──────────────────────────────────────────────────────────

test('migration: three separate append-only ALTERs, noted in schema.sql; the fixture really lacks them', () => {
  assert.ok(MIGRATION, 'migration file');
  assert.match(MIGRATION, /D1 Console/);
  assert.match(MIGRATION, /link_messages_unavailable/);
  assert.match(MIGRATION, /duplicate column name/i);
  assert.deepEqual(statementsOf(MIGRATION), NEW.map(c => `ALTER TABLE studio_settings ADD COLUMN ${c} TEXT`));
  assert.match(FRESH, /2026-10-16-link-messages\.sql/);
  for (const c of NEW) assert.match(FRESH, new RegExp(`ALTER TABLE studio_settings ADD COLUMN ${c} TEXT;`));
  const old = fakeDB({ schema: PRE() });
  for (const c of NEW) assert.throws(() => old._db.prepare(`SELECT ${c} FROM studio_settings`).all(), /no such column/);
  old._db.prepare('SELECT pick_link_message FROM studio_settings').all(); // positive: only the three are cut
  const stmts = statementsOf(MIGRATION);
  for (const s of stmts) old._db.exec(s); // one by one, as Tim pastes them
  const shape = d => d._db.prepare('PRAGMA table_info(studio_settings)').all().map(c => ({ ...c }));
  assert.deepEqual(shape(old), shape(fakeDB()));
  for (const s of stmts) assert.throws(() => old._db.exec(s), /duplicate column name/);
});

// ─── settings GET / PUT ─────────────────────────────────────────────────────

test('GET: all four start null and each is returned once set', async () => {
  const env = envOf();
  const s = await (await settings(env)).json();
  for (const f of ALL) {
    assert.ok(f in s, f);
    assert.equal(s[f], null, f);
  }
  for (const f of NEW) assert.equal((await settings(env, { [f]: `${f} {連結}` })).status, 200);
  const got = await (await settings(env)).json();
  for (const f of NEW) assert.equal(got[f], `${f} {連結}`);
  assert.equal(got.pick_link_message, null);
});

test('PUT: each new field is stored trimmed, CRLF as LF, tabs and inner breaks kept, placeholders untouched', async () => {
  const env = envOf();
  const text = '  嗨 {客人}，\r\n\t精修好了：{連結}\r\n\n{專案名稱}  \n ';
  const want = '嗨 {客人}，\n\t精修好了：{連結}\n\n{專案名稱}';
  for (const f of NEW) {
    const res = await settings(env, { [f]: text });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await res.json())[f], want, f);
    assert.equal(stored(env, f), want, f);
  }
});

test('PUT: at most 1000 code points each; over is 400 with that field\'s code, nothing written', async () => {
  const env = envOf();
  for (const f of NEW) {
    for (const ok of ['x'.repeat(MAX), '😀'.repeat(MAX), `  ${'字'.repeat(MAX)}\n`]) {
      assert.equal((await settings(env, { [f]: ok })).status, 200, `${f} ${ok.length}`);
      assert.equal(stored(env, f), ok.trim());
    }
    const before = table(env);
    for (const over of ['x'.repeat(MAX + 1), '😀'.repeat(MAX + 1), ` ${'x'.repeat(MAX)}y `]) {
      const res = await settings(env, { studio_name: '不該寫入', [f]: over });
      assert.equal(res.status, 400, `${f} ${over.length}`);
      assert.equal(await code(res), `invalid_${f}`);
    }
    assert.equal(table(env), before, `${f}: nothing written`);
  }
});

test('PUT: control / bidi / separator / BOM / lone-surrogate characters and non-strings refused per field, nothing written', async () => {
  const env = envOf();
  const bad = [
    'a\u0000b', 'a\u0007b', 'a\u000bb', 'a\u000cb', 'a\u001bb', 'a\u007fb', 'a\u0085b', 'a\u009fb',
    'a؜b', 'a‎b', 'a‏b', 'a‪b', 'a‮b', 'a⁦b', 'a⁩b', 'a b', 'a b', 'a﻿b',
    'a\ud800b', 'a\udfffb', '\ud83d',
    5, 0, true, false, ['a'], { a: 1 },
  ];
  for (const f of NEW) {
    assert.equal((await settings(env, { [f]: '原本' })).status, 200);
    const before = table(env);
    for (const v of bad) {
      const res = await settings(env, { studio_name: '不該寫入', pick_link_message: '也不該', [f]: v });
      assert.equal(res.status, 400, `${f} ${JSON.stringify(v)}`);
      assert.equal(await code(res), `invalid_${f}`, `${f} ${JSON.stringify(v)}`);
    }
    assert.equal(table(env), before, f);
    assert.equal(stored(env, f), '原本');
    // positive: an emoji (a surrogate pair), \n and \t go through
    assert.equal((await settings(env, { [f]: '😀\n\t好' })).status, 200);
    assert.equal(stored(env, f), '😀\n\t好');
  }
});

test('PUT: \'\', whitespace or null clear each (null = the built-in default)', async () => {
  const env = envOf();
  for (const f of NEW) {
    for (const v of ['', '   ', ' \n\t\r\n ', null]) {
      assert.equal((await settings(env, { [f]: '有字' })).status, 200);
      assert.equal(stored(env, f), '有字');
      const res = await settings(env, { [f]: v });
      assert.equal(res.status, 200, `${f} ${JSON.stringify(v)}`);
      assert.equal((await res.json())[f], null);
      assert.equal(stored(env, f), null);
    }
  }
});

test('PUT: one field changes only itself; a body without them leaves all four alone', async () => {
  const env = envOf();
  const first = Object.fromEntries(ALL.map(f => [f, `舊 ${f}`]));
  assert.equal((await settings(env, { studio_name: '小明', ...first })).status, 200);
  for (const f of ALL) {
    assert.equal((await settings(env, { [f]: `新 ${f}` })).status, 200);
    const s = await (await settings(env)).json();
    for (const g of ALL) assert.equal(s[g], g === f ? `新 ${g}` : (ALL.indexOf(g) < ALL.indexOf(f) ? `新 ${g}` : `舊 ${g}`), `${f} → ${g}`);
    assert.equal(s.studio_name, '小明');
  }
  assert.equal((await settings(env, { studio_name: '小明攝影', transfer_info: '帳號' })).status, 200);
  const s = await (await settings(env)).json();
  for (const g of ALL) assert.equal(s[g], `新 ${g}`);
  // clearing one leaves the rest
  assert.equal((await settings(env, { link_message_delivered: null })).status, 200);
  const t = await (await settings(env)).json();
  assert.equal(t.link_message_delivered, null);
  for (const g of ALL.filter(g => g !== 'link_message_delivered')) assert.equal(t[g], `新 ${g}`);
  // a bad one among good ones: 400, none of them written
  const before = table(env);
  const res = await settings(env, { pick_link_message: 'x', link_message_submitted: 'y', link_message_done: 'a\u0000b' });
  assert.equal(await code(res), 'invalid_link_message_done');
  assert.equal(table(env), before);
  // unknown keys spelled like them do nothing
  assert.equal((await settings(env, { link_message_dones: 'x', LINK_MESSAGE_DONE: 'y', link_message: 'z' })).status, 200);
  assert.equal(table(env).includes('"x"'), false);
  assert.equal(stored(env, 'link_message_done'), '新 link_message_done');
});

test('admin only: GET and PUT need the photographer token', async () => {
  const env = envOf();
  assert.equal((await settings(env, { link_message_done: '私人' })).status, 200);
  for (const token of [undefined, 'wrong']) {
    assert.equal((await call(env, '/api/admin/settings', { token })).status, 401);
    for (const f of NEW) assert.equal((await call(env, '/api/admin/settings', { method: 'PUT', token, body: { [f]: '別人' } })).status, 401);
  }
  assert.equal(stored(env, 'link_message_done'), '私人');
  assert.equal(stored(env, 'link_message_submitted'), null);
});

// ─── per photographer ───────────────────────────────────────────────────────

test('scoped to the caller: B writes and reads his own row only; A\'s row is untouched, and back', async () => {
  const env = envOf({ extra: ROUTES_ON });
  const { A, B } = await twoTenants(env);
  assert.equal((await settings(env, { link_message_submitted: '甲送出', link_message_done: '甲完成' }, A.token)).status, 200);
  const aRow = JSON.stringify(one(env, 'SELECT * FROM studio_settings WHERE photographer_id = ?', A.id));
  const empty = await (await settings(env, undefined, B.token)).json();
  for (const f of ALL) assert.equal(empty[f], null, `B starts empty: ${f}`);
  const res = await settings(env, { link_message_delivered: '乙交件', link_message_done: '乙完成' }, B.token);
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.link_message_delivered, '乙交件');
  assert.equal(b.link_message_done, '乙完成');
  assert.equal(b.link_message_submitted, null, 'not A\'s');
  assert.equal(stored(env, 'link_message_done', B.id), '乙完成');
  assert.equal(JSON.stringify(one(env, 'SELECT * FROM studio_settings WHERE photographer_id = ?', A.id)), aRow);
  // B's bad value is refused the same way, nothing anywhere
  const before = snapshot(env);
  assert.equal(await code(await settings(env, { link_message_submitted: 'a‮b' }, B.token)), 'invalid_link_message_submitted');
  assert.equal(snapshot(env), before);
  // and A's write never reaches B's row
  const bRow = JSON.stringify(one(env, 'SELECT * FROM studio_settings WHERE photographer_id = ?', B.id));
  assert.equal((await settings(env, { link_message_delivered: '甲交件' }, A.token)).status, 200);
  assert.equal(JSON.stringify(one(env, 'SELECT * FROM studio_settings WHERE photographer_id = ?', B.id)), bRow);
  assert.equal((await (await settings(env, undefined, A.token)).json()).link_message_delivered, '甲交件');
  assert.equal((await (await settings(env, undefined, B.token)).json()).link_message_delivered, '乙交件');
  assert.equal(rows(env, 'SELECT * FROM studio_settings').length, 2);
});

// ─── before the migration ───────────────────────────────────────────────────

test('before the migration: GET reads null for the three, a PUT naming any of them is 500 and writes nothing, a PUT without them works', async () => {
  for (const schema of [PRE, PRE_ALL]) {
    const env = envOf({ schema: schema() });
    let res = await settings(env);
    assert.equal(res.status, 200);
    const s = await res.json();
    for (const f of NEW) {
      assert.ok(f in s, f);
      assert.equal(s[f], null, f);
    }
    assert.equal((await settings(env, { studio_name: '小明攝影' })).status, 200);
    const before = snapshot(env);
    for (const f of NEW) {
      for (const v of ['訊息', '', null]) {
        const body = schema === PRE ? { studio_name: '別的', pick_link_message: '也不該', [f]: v } : { studio_name: '別的', [f]: v };
        res = await settings(env, body);
        assert.equal(res.status, 500, `${f} ${JSON.stringify(v)}`);
        assert.equal(await code(res), 'link_messages_unavailable');
        assert.match(res.headers.get('Cache-Control') || '', /no-store/);
      }
    }
    // a bad value still answers 400 first (validation runs before the write)
    assert.equal(await code(await settings(env, { link_message_done: 5 })), 'invalid_link_message_done');
    assert.equal(snapshot(env), before);
    res = await settings(env, { studio_name: '還是能存' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).studio_name, '還是能存');
  }
  // with pick_link_message there, it still saves and reads (positive)
  const env = envOf({ schema: PRE() });
  assert.equal((await settings(env, { pick_link_message: '選片訊息' })).status, 200);
  assert.equal((await (await settings(env)).json()).pick_link_message, '選片訊息');
});

test('a half-run migration: the columns that exist read and save on their own, a missing one is 500', async () => {
  const env = envOf({ schema: cut(['link_message_delivered', 'link_message_done'])() });
  assert.equal((await settings(env, { link_message_submitted: '送出了', pick_link_message: '選片' })).status, 200);
  const s = await (await settings(env)).json();
  assert.equal(s.link_message_submitted, '送出了');
  assert.equal(s.pick_link_message, '選片');
  assert.equal(s.link_message_delivered, null);
  assert.equal(s.link_message_done, null);
  const before = snapshot(env);
  const res = await settings(env, { link_message_submitted: '改', link_message_done: '完成' });
  assert.equal(res.status, 500);
  assert.equal(await code(res), 'link_messages_unavailable');
  assert.equal(snapshot(env), before);
  // pick_link_message missing but the three there: they still read
  const env2 = envOf({ schema: cut(['pick_link_message'])() });
  assert.equal((await settings(env2, { link_message_done: '完成' })).status, 200);
  const t = await (await settings(env2)).json();
  assert.equal(t.link_message_done, '完成');
  assert.equal(t.pick_link_message, null);
  assert.equal(await code(await settings(env2, { pick_link_message: 'x' })), 'pick_link_message_unavailable');
});

// ─── the guest: never ───────────────────────────────────────────────────────

const MARK = '攝影師私人階段範本Q';
const clean = async (label, res, status = 200) => {
  const text = await res.text();
  assert.equal(res.status, status, `${label}: ${text}`);
  assert.ok(!text.includes(MARK), label);
  for (const f of NEW) assert.ok(!text.includes(f), `${label}: ${f}`);
  return text;
};
const marks = Object.fromEntries(NEW.map(f => [f, `${MARK} ${f}`]));

test('no guest route carries them: state (owner, viewer; retouching, delivered, confirmed), shop, rounds, ?list=', async () => {
  const env = envOf();
  assert.equal((await settings(env, { studio_name: '小明攝影', ...marks })).status, 200);
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
  // the photographer does see them
  const s = await (await settings(env)).json();
  for (const f of NEW) assert.equal(s[f], marks[f]);
});

test('no guest order route carries them (place, list, cancel)', async () => {
  const { env, c, p } = await ready();
  assert.equal((await settings(env, { ...marks, transfer_info: '國泰世華 013' })).status, 200);
  const order = await placed(env, p, c);
  assert.ok(!JSON.stringify(order).includes(MARK));
  await clean('orders', await myOrders(env, p));
  const shop = JSON.parse(await clean('shop', await pick(env, 'GET', 'shop', p.token, { key: p.key })));
  assert.ok(shop.ordering, 'positive: ordering is on');
  await clean('cancel', await cancelOrder(env, p, order.id));
});

test('a non-default photographer\'s guest brand (pickStudio) carries his name, never his link messages', async () => {
  const env = envOf({ extra: ROUTES_ON });
  const { B } = await twoTenants(env);
  assert.equal((await settings(env, { studio_name: '乙工作室', ...marks }, B.token)).status, 200);
  const created = await createProject(env, { title: '乙的專案' });
  env.DB._db.prepare('UPDATE projects SET photographer_id = ? WHERE id = ?').run(B.id, created.project.id);
  const s = JSON.parse(await clean('state B', await pick(env, 'GET', 'state', created.token)));
  assert.equal(s.studio?.name, '乙工作室', 'positive: B\'s brand');
  assert.deepEqual(Object.keys(s.studio).sort(), ['booking_url', 'has_logo', 'name']);
});

test('static: the columns are read only by readStudioSettings; pickStudio passes three other fields', () => {
  for (const f of NEW) assert.doesNotMatch(WORKER, new RegExp(`${f} FROM`));
  assert.match(WORKER, /async function pickStudio[\s\S]{0,200}return \{ name: s\.studio_name, booking_url: s\.booking_url, has_logo: s\.has_logo \}/);
});
