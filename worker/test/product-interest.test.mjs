// 「我有興趣」 on the completion page (docs/guest-shop.md, product interest).
// A delivered project the client has confirmed shows the shop's products; the
// seat holder taps 「我有興趣」 on one, the photographer gets one email and the
// project keeps a record (product_interests). A demand test, not an order:
// no payment, no order row. High tier: a guest-triggered write and an email.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fakeDB } from './fakes.mjs';
import { withT } from './pick-helpers.mjs';
import {
  FINAL, F1, FRESH, setup, fakeMailer, admin, deliver, detail, code, confirm, guest, rounds,
  retouching, delivered, landOnce, SECRET, call, pick, rows, one,
} from './revision-helpers.mjs';

const OP = 'operator-secret';
const WORKER = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const MIGRATION_FILE = new URL('../migrations/2026-10-08-product-interests.sql', import.meta.url);
const MIGRATION = existsSync(MIGRATION_FILE) ? readFileSync(MIGRATION_FILE, 'utf8') : '';
const HAS_TABLE = /CREATE TABLE IF NOT EXISTS product_interests/.test(FRESH);
// the deployed database before this migration: everything else, no table
const BEFORE = HAS_TABLE ? FRESH.replace(/\n-- ─── Product interests[\s\S]*$/, '\n') : FRESH;

const envOf = (opts = {}) => setup({ ...opts, extra: { OPERATOR_TOKEN: OP, ...(opts.extra || {}) } });
const tap = (env, t, key, body) => guest(env, 'POST', 'interest', t, key, body);
const interestRows = env => rows(env, 'SELECT * FROM product_interests ORDER BY rowid').map(r => ({ ...r }));
const mailOf = env => env.NOTIFY_EMAIL.sent;

async function platformProduct(env, body = {}) {
  const res = await call(env, '/api/operator/products', {
    method: 'POST', token: OP, body: {
      kind: 'print', name: '無框畫', description: '木框', options: [{ label: '16×20', vendor_cost: 900, platform_price: 2000 }], ...body,
    },
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).product;
}
async function adopt(env, pp, extra = {}) {
  const res = await call(env, '/api/admin/products/from-platform', {
    method: 'POST', token: SECRET, body: {
      platform_product_id: pp.id, options: pp.options.map(o => ({ platform_option_id: o.id, price: 3000 })), guest_visible: true, ...extra,
    },
  });
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).product;
}
// a print and an album in the shop, and a print the photographer hid
async function catalogue(env) {
  const print = await adopt(env, await platformProduct(env));
  const album = await adopt(env, await platformProduct(env, {
    kind: 'album', name: '相本書', photo_count: 20, min_pages: 10, max_pages: 30,
    options: [{ label: '20×20', vendor_cost: 900, platform_price: 2000 }],
  }));
  const hidden = await adopt(env, await platformProduct(env, { name: '桌曆' }), { guest_visible: false });
  return { print, album, hidden };
}
// delivered and confirmed by the client: the 完成頁
async function confirmed(env) {
  const p = await delivered(env);
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
  mailOf(env).length = 0; // the confirmation's own email
  return p;
}
async function ready(opts) {
  const env = envOf(opts);
  const c = await catalogue(env);
  const p = await confirmed(env);
  return { env, c, p };
}

// ─── schema ──────────────────────────────────────────────────────────────────

test('migration: one CREATE TABLE IF NOT EXISTS, noted in schema.sql; turns today\'s database into a fresh one; re-runnable', () => {
  assert.ok(existsSync(MIGRATION_FILE), 'migration file');
  assert.match(MIGRATION, /D1 Console/);
  assert.match(MIGRATION, /interest_unavailable/);
  const statements = MIGRATION.replace(/--[^\n]*/g, '').split(';').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
  assert.equal(statements.length, 1);
  assert.match(statements[0], /^CREATE TABLE IF NOT EXISTS product_interests \(/);
  assert.match(FRESH, /2026-10-08-product-interests\.sql/);
  const db = fakeDB({ schema: BEFORE });
  assert.throws(() => db._db.prepare('SELECT * FROM product_interests').all(), /no such table/);
  db._db.exec(statements[0]);
  db._db.exec(statements[0]);
  const cols = d => d._db.prepare('PRAGMA table_info(product_interests)').all();
  assert.deepEqual(cols(db), cols(fakeDB()));
  assert.deepEqual(cols(db).map(c => c.name),
    ['project_id', 'product_id', 'product_name', 'product_kind', 'first_at', 'last_at', 'tap_count', 'last_emailed_at']);
  // one row per project and product
  db._db.prepare("INSERT INTO product_interests (project_id, product_id, product_name, product_kind, first_at, last_at) VALUES ('p', 'x', 'n', 'print', 'a', 'a')").run();
  assert.throws(() => db._db.prepare("INSERT INTO product_interests (project_id, product_id, product_name, product_kind, first_at, last_at) VALUES ('p', 'x', 'n', 'print', 'a', 'a')").run(), /UNIQUE/);
  assert.equal(db._db.prepare('SELECT tap_count FROM product_interests').get().tap_count, 1);
});

// ─── the tap ─────────────────────────────────────────────────────────────────

test('first tap: 200 {ok, already:false}, no-store; the row snapshots the product; one email to the photographer with a link to the project', async () => {
  const { env, c, p } = await ready();
  const before = JSON.stringify(rows(env, 'SELECT * FROM projects'));
  const res = await tap(env, p.token, p.key, { product_id: c.album.id });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(await res.json(), { ok: true, already: false });
  const [r] = interestRows(env);
  assert.equal(interestRows(env).length, 1);
  assert.equal(r.project_id, p.id);
  assert.equal(r.product_id, c.album.id);
  assert.equal(r.product_name, '相本書');
  assert.equal(r.product_kind, 'album');
  assert.equal(r.tap_count, 1);
  assert.ok(r.first_at && r.first_at === r.last_at && r.last_emailed_at === r.first_at);
  // no order, no project change
  assert.equal(rows(env, 'SELECT * FROM orders').length, 0);
  assert.equal(JSON.stringify(rows(env, 'SELECT * FROM projects')), before);
  assert.equal(mailOf(env).length, 1);
  const [m] = mailOf(env);
  assert.equal(m.to, 'studio@example.com');
  assert.equal(m.from, 'notify@imhoti.tw');
  assert.match(m.subject, /王先生 婚紗/);
  assert.match(m.subject, /王小明/);
  assert.match(m.subject, /相本書/);
  const link = `https://imhoti.tw/studio/admin.html#project=${encodeURIComponent(p.id)}`;
  assert.ok(m.text.includes(link), m.text);
  assert.ok(m.html.includes(`href="${link}"`), m.html);
  assert.match(m.text, /相本書/);
});

test('later taps: already:true, tap_count and last_at move, the snapshot follows the catalogue; emailed again only once 24 h have passed since the last email', async () => {
  const { env, c, p } = await ready();
  assert.equal((await tap(env, p.token, p.key, { product_id: c.print.id })).status, 200);
  const first = interestRows(env)[0];
  await new Promise(r => setTimeout(r, 5));
  let res = await tap(env, p.token, p.key, { product_id: c.print.id });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, already: true });
  let r = interestRows(env)[0];
  assert.equal(interestRows(env).length, 1, 'never a second row');
  assert.equal(r.tap_count, 2);
  assert.equal(r.first_at, first.first_at);
  assert.ok(r.last_at > first.last_at);
  assert.equal(r.last_emailed_at, first.last_emailed_at, 'inside the window: no new email slot');
  assert.equal(mailOf(env).length, 1, 'one email so far');
  // 23 h ago: still inside
  const ago = h => new Date(Date.now() - h * 3600000).toISOString();
  env.DB._db.prepare('UPDATE product_interests SET last_emailed_at = ?').run(ago(23));
  assert.equal((await tap(env, p.token, p.key, { product_id: c.print.id })).status, 200);
  assert.equal(mailOf(env).length, 1);
  // 25 h ago: one more email, and the slot moves
  env.DB._db.prepare('UPDATE product_interests SET last_emailed_at = ?').run(ago(25));
  // the photographer renamed the product meanwhile
  env.DB._db.prepare("UPDATE platform_products SET name = '無框畫 新版' WHERE kind = 'print' AND name = '無框畫'").run();
  res = await tap(env, p.token, p.key, { product_id: c.print.id });
  assert.deepEqual(await res.json(), { ok: true, already: true });
  assert.equal(mailOf(env).length, 2);
  assert.match(mailOf(env)[1].subject, /無框畫 新版/);
  r = interestRows(env)[0];
  assert.equal(r.tap_count, 4);
  assert.equal(r.product_name, '無框畫 新版');
  assert.ok(r.last_emailed_at > ago(1));
  // never emailed (NULL): the next tap emails
  env.DB._db.prepare('UPDATE product_interests SET last_emailed_at = NULL').run();
  assert.equal((await tap(env, p.token, p.key, { product_id: c.print.id })).status, 200);
  assert.equal(mailOf(env).length, 3);
  // another product is its own row and its own email
  res = await tap(env, p.token, p.key, { product_id: c.album.id });
  assert.deepEqual(await res.json(), { ok: true, already: false });
  assert.equal(interestRows(env).length, 2);
  assert.equal(mailOf(env).length, 4);
});

test('two taps at once (even in the same millisecond): one row, tap_count 2, one email', async () => {
  const { env, c, p } = await ready();
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  let a, b;
  try {
    [a, b] = await Promise.all([
      tap(env, p.token, p.key, { product_id: c.print.id }), tap(env, p.token, p.key, { product_id: c.print.id }),
    ]);
  } finally { Date.now = realNow; }
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const flags = [(await a.json()).already, (await b.json()).already].sort();
  assert.deepEqual(flags, [false, true]);
  assert.equal(interestRows(env).length, 1);
  assert.equal(interestRows(env)[0].tap_count, 2);
  assert.equal(mailOf(env).length, 1);
});

// ─── who and when ────────────────────────────────────────────────────────────

test('method: anything but POST is 405 (Allow: POST), even for a viewer', async () => {
  const { env, c, p } = await ready();
  for (const method of ['GET', 'PUT', 'DELETE']) {
    for (const key of [p.key, undefined]) {
      const res = await pick(env, method, 'interest', p.token, { key, body: method === 'GET' ? undefined : { product_id: c.print.id } });
      assert.equal(res.status, 405, `${method} ${key}`);
      assert.equal(res.headers.get('Allow'), 'POST');
    }
  }
  assert.equal(interestRows(env).length, 0);
});

test('seat: a viewer, a wrong key, another project\'s key and a key from before a seat reset are 403 not_owner; nothing written, no email', async () => {
  const env = envOf();
  const c = await catalogue(env);
  const p = await confirmed(env);
  const other = await confirmed(env);
  for (const key of [undefined, 'wrong', other.key]) {
    const res = await tap(env, p.token, key, { product_id: c.print.id });
    assert.equal(res.status, 403, String(key));
    assert.equal(await code(res), 'not_owner');
  }
  // before the body is read
  assert.equal(await code(await pick(env, 'POST', 'interest', p.token, { body: '{not json' })), 'not_owner');
  assert.equal((await call(env, `/api/admin/projects/${p.id}/reset-seat`, { method: 'POST', token: SECRET })).status, 200);
  assert.equal(await code(await tap(env, p.token, p.key, { product_id: c.print.id })), 'not_owner');
  assert.equal(interestRows(env).length, 0);
  assert.equal(mailOf(env).length, 0);
});

test('only on the 完成頁: retouching, delivered but not confirmed, undelivered and reopened are 409 not_confirmed (before the body); confirmed is 200', async () => {
  const env = envOf();
  const c = await catalogue(env);
  const p = await retouching(env);
  const notConfirmed = async (what, body = { product_id: c.print.id }) => {
    const res = await tap(env, p.token, p.key, body);
    assert.equal(res.status, 409, what);
    assert.equal(await code(res), 'not_confirmed', what);
  };
  await notConfirmed('retouching');
  assert.equal((await deliver(env, p.id)).status, 200);
  await notConfirmed('delivered, not confirmed');
  await notConfirmed('before the body', '{not json');
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
  assert.equal((await tap(env, p.token, p.key, { product_id: c.print.id })).status, 200, 'the 完成頁');
  assert.equal((await admin(env, p.id, 'undeliver')).status, 200);
  await notConfirmed('undelivered');
  assert.equal((await deliver(env, p.id)).status, 200);
  await notConfirmed('delivered again: the confirmation went with the undeliver');
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
  assert.equal((await admin(env, p.id, 'reopen')).status, 200);
  await notConfirmed('reopened');
  // a row confirmed but not delivered (only ever by hand) is refused before the body too
  env.DB._db.prepare("UPDATE projects SET client_confirmed_at = '2026-01-01T00:00:00.000Z', client_confirmed_by = 'guest'").run();
  await notConfirmed('confirmed by hand, not delivered', '{not json');
  // the record stays as history through all of it
  assert.equal(interestRows(env).length, 1);
  assert.equal(interestRows(env)[0].tap_count, 1);
});

test('dead links: expired, revoked, archived and unknown are 401; nothing written', async () => {
  const { env, c, p } = await ready();
  const body = { product_id: c.print.id };
  env.DB._db.prepare('UPDATE share_tokens SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
  assert.equal((await tap(env, p.token, p.key, body)).status, 401);
  env.DB._db.prepare('UPDATE share_tokens SET expires_at = ?, revoked_at = ?').run(new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  assert.equal((await tap(env, p.token, p.key, body)).status, 401);
  env.DB._db.prepare('UPDATE share_tokens SET revoked_at = NULL').run();
  assert.equal((await admin(env, p.id, 'archive')).status, 200);
  assert.equal((await tap(env, p.token, p.key, body)).status, 401);
  assert.equal((await tap(env, 'nope', p.key, body)).status, 401);
  assert.equal((await tap(env, undefined, p.key, body)).status, 401);
  assert.equal(interestRows(env).length, 0);
});

test('a change landing between the checks and the write wins: undeliver → 409 not_confirmed, seat reset → 403, archive → 401; nothing written, no email', async () => {
  for (const [sql, status, c0] of [
    ['UPDATE projects SET delivered_at = NULL', 409, 'not_confirmed'],
    ['UPDATE projects SET client_confirmed_at = NULL', 409, 'not_confirmed'],
    ['UPDATE projects SET owner_picker_id = NULL', 403, 'not_owner'],
    ["UPDATE projects SET archived_at = '2026-01-01T00:00:00.000Z'", 401, undefined],
  ]) {
    const { env, c, p } = await ready();
    landOnce(env, /INSERT INTO product_interests/, sql);
    const res = await tap(env, p.token, p.key, { product_id: c.print.id });
    assert.equal(res.status, status, sql);
    if (c0) assert.equal(await code(res), c0, sql);
    assert.equal(interestRows(env).length, 0, sql);
    assert.equal(mailOf(env).length, 0, sql);
  }
});

// ─── the body and the product ────────────────────────────────────────────────

test('body: 413 too_large; 400 Invalid JSON; 400 invalid_body; a product not in this photographer\'s shop is 404 not_found; nothing written', async () => {
  const { env, c, p } = await ready();
  const raw = body => pick(env, 'POST', 'interest', p.token, { key: p.key, body });
  let res = await raw(JSON.stringify({ product_id: 'x'.repeat(4096) }));
  assert.equal(res.status, 413);
  assert.equal(await code(res), 'too_large');
  for (const bad of ['{not json', '']) {
    res = await raw(bad);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'Invalid JSON');
  }
  for (const body of ['[]', '"x"', 'null', {}, { product_id: 3 }, { product_id: '' }, { product_id: null }, { product_id: ['x'] }, { product_id: 'x'.repeat(201) }]) {
    res = await raw(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(await code(res), 'invalid_body', JSON.stringify(body));
  }
  // hidden from guests, unknown, a platform product's own id, an option id
  const optionId = one(env, 'SELECT id FROM product_options WHERE product_id = ?', c.print.id).id;
  const platformId = one(env, 'SELECT platform_product_id AS id FROM products WHERE id = ?', c.print.id).id;
  for (const id of [c.hidden.id, 'nope', platformId, optionId]) {
    res = await raw({ product_id: id });
    assert.equal(res.status, 404, id);
    assert.equal(await code(res), 'not_found', id);
  }
  // another photographer's product is not in this shop
  env.DB._db.prepare("UPDATE products SET photographer_id = 'someone-else' WHERE id = ?").run(c.album.id);
  res = await raw({ product_id: c.album.id });
  assert.equal(res.status, 404);
  // a product taken down after the page loaded
  env.DB._db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(c.print.id);
  assert.equal((await raw({ product_id: c.print.id })).status, 404);
  assert.equal(interestRows(env).length, 0);
  assert.equal(mailOf(env).length, 0);
});

test('cap: 20 distinct products per project — a 21st is 409 interest_cap; a product already there still counts its tap', async () => {
  const { env, c, p } = await ready();
  const ins = env.DB._db.prepare("INSERT INTO product_interests (project_id, product_id, product_name, product_kind, first_at, last_at, last_emailed_at) VALUES (?, ?, 'old', 'print', '2026-01-01', '2026-01-01', '2026-01-01')");
  for (let i = 0; i < 19; i++) ins.run(p.id, `gone-${i}`);
  // another project's rows never count
  for (let i = 0; i < 5; i++) ins.run('other-project', `x-${i}`);
  assert.equal((await tap(env, p.token, p.key, { product_id: c.print.id })).status, 200, 'the 20th');
  const res = await tap(env, p.token, p.key, { product_id: c.album.id });
  assert.equal(res.status, 409);
  assert.equal(await code(res), 'interest_cap');
  assert.equal((await res.json()).max, 20);
  assert.equal(rows(env, 'SELECT * FROM product_interests WHERE project_id = ?', p.id).length, 20);
  const again = await tap(env, p.token, p.key, { product_id: c.print.id });
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { ok: true, already: true });
  assert.equal(one(env, 'SELECT tap_count FROM product_interests WHERE product_id = ?', c.print.id).tap_count, 2);
});

// ─── the email ───────────────────────────────────────────────────────────────

test('a mail that fails, or no mail binding, never fails the tap nor undoes the row', async () => {
  let { env, c, p } = await ready({ mailer: fakeMailer({ fail: true }) });
  let res = await tap(env, p.token, p.key, { product_id: c.print.id });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, already: false });
  assert.equal(interestRows(env).length, 1);
  ({ env, c, p } = await ready());
  delete env.NOTIFY_EMAIL;
  res = await tap(env, p.token, p.key, { product_id: c.print.id });
  assert.equal(res.status, 200);
  assert.equal(interestRows(env).length, 1);
  // the email is sent after the response is built, in the background
  ({ env, c, p } = await ready());
  let release;
  env.NOTIFY_EMAIL.send = () => new Promise(r => { release = r; });
  const pending = [];
  res = await pick(env, 'POST', 'interest', p.token, { key: p.key, body: { product_id: c.album.id } }, { waitUntil: x => pending.push(x) });
  assert.equal(res.status, 200, 'answered while the mail is still on its way');
  assert.equal(pending.length, 1);
  release({});
  await Promise.allSettled(pending);
});

test('mail: subject on one line, no control or bidi marks; the picker name and product name escaped in HTML; no other guest text', async () => {
  const env = envOf();
  const pp = await platformProduct(env, { name: '<b>畫</b>&"框"' });
  const prod = await adopt(env, pp);
  const p = await delivered(env);
  env.DB._db.prepare('UPDATE pickers SET name = ?').run('王‮小\n明<script>x</script>⁦');
  env.DB._db.prepare('UPDATE projects SET title = ?').run('婚紗\r\n Bcc: a@b.c');
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
  env.NOTIFY_EMAIL.sent.length = 0;
  assert.equal((await tap(env, p.token, p.key, { product_id: prod.id, note: '別的字<i>' })).status, 200);
  const [m] = env.NOTIFY_EMAIL.sent;
  assert.ok(m, 'mailed');
  assert.doesNotMatch(m.subject, /[\u0000-\u001f\u007f‪-‮⁦-⁩]/);
  assert.doesNotMatch(m.text, /[‪-‮⁦-⁩]/);
  assert.match(m.subject, /王 小 明/);
  assert.ok(!m.html.includes('<script>'), m.html);
  assert.ok(!m.html.includes('<b>畫'), m.html);
  assert.ok(m.html.includes('&lt;b&gt;畫&lt;/b&gt;&amp;&quot;框&quot;'), m.html);
  assert.ok(m.html.includes('&lt;script&gt;'), m.html);
  assert.ok(!m.text.includes('別的字') && !m.html.includes('別的字'), 'nothing else from the body');
});

// ─── before the migration ────────────────────────────────────────────────────

test('before the migration: the tap is 500 interest_unavailable and writes nothing; the admin detail still loads with interests []', async () => {
  const env = envOf({ schema: BEFORE });
  const c = await catalogue(env);
  const p = await confirmed(env);
  // the guard asks first: the INSERT is never even prepared
  const prepared = [];
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => { prepared.push(sql); return prepare(sql); };
  const res = await tap(env, p.token, p.key, { product_id: c.print.id });
  env.DB.prepare = prepare;
  assert.equal(prepared.filter(s => /INSERT INTO product_interests/.test(s)).length, 0);
  assert.equal(res.status, 500);
  assert.equal(await code(res), 'interest_unavailable');
  assert.equal(env.DB._writes().filter(s => /product_interests/.test(s)).length, 0);
  assert.equal(mailOf(env).length, 0);
  const d = await detail(env, p.id);
  assert.deepEqual(d.interests, []);
  assert.ok(d.project);
  // the order still holds: a viewer is 403, an unconfirmed project 409, before the guard
  assert.equal(await code(await tap(env, p.token, undefined, { product_id: c.print.id })), 'not_owner');
});

// ─── admin ───────────────────────────────────────────────────────────────────

test('admin detail: interests newest first (by last tap), the named fields only; [] when none', async () => {
  const { env, c, p } = await ready();
  assert.deepEqual((await detail(env, p.id)).interests, []);
  assert.equal((await tap(env, p.token, p.key, { product_id: c.print.id })).status, 200);
  await new Promise(r => setTimeout(r, 5));
  assert.equal((await tap(env, p.token, p.key, { product_id: c.album.id })).status, 200);
  let d = await detail(env, p.id);
  assert.deepEqual(d.interests.map(i => i.product_id), [c.album.id, c.print.id]);
  assert.deepEqual(Object.keys(d.interests[0]).sort(), ['first_at', 'last_at', 'product_id', 'product_kind', 'product_name', 'tap_count']);
  assert.equal(d.interests[0].product_name, '相本書');
  assert.equal(d.interests[0].product_kind, 'album');
  await new Promise(r => setTimeout(r, 5));
  // a new tap on the print brings it to the top
  assert.equal((await tap(env, p.token, p.key, { product_id: c.print.id })).status, 200);
  d = await detail(env, p.id);
  assert.deepEqual(d.interests.map(i => [i.product_id, i.tap_count]), [[c.print.id, 2], [c.album.id, 1]]);
  // another project's rows are not this one's
  const env2Rows = rows(env, 'SELECT project_id FROM product_interests');
  assert.ok(env2Rows.every(r => r.project_id === p.id));
  env.DB._db.prepare("INSERT INTO product_interests (project_id, product_id, product_name, product_kind, first_at, last_at) VALUES ('other', 'z', 'z', 'print', '2099-01-01', '2099-01-01')").run();
  assert.equal((await detail(env, p.id)).interests.length, 2);
  // the admin route needs the admin token
  assert.equal((await call(env, `/api/admin/projects/${p.id}`, { token: 'nope' })).status, 401);
});

test('no guest route carries the record: state (owner and viewer), shop, rounds, ?list=, a finals object', async () => {
  const { env, c, p } = await ready();
  assert.equal((await tap(env, p.token, p.key, { product_id: c.album.id })).status, 200);
  assert.equal((await tap(env, p.token, p.key, { product_id: c.album.id })).status, 200);
  const bodies = [];
  for (const key of [p.key, undefined]) {
    const s = await pick(env, 'GET', 'state', p.token, { key });
    assert.equal(s.status, 200);
    bodies.push(await s.text());
  }
  const shop = await pick(env, 'GET', 'shop', p.token, { key: p.key });
  assert.equal(shop.status, 200);
  bodies.push(await shop.text());
  const r = await rounds(env, p.token, p.key);
  assert.equal(r.status, 200);
  bodies.push(await r.text());
  const list = await call(env, withT(`/?list=${encodeURIComponent(FINAL)}`, p.token));
  assert.equal(list.status, 200);
  bodies.push(await list.text());
  for (const b of bodies) {
    assert.doesNotMatch(b, /interest|tap_count|last_emailed_at|first_at/i, b.slice(0, 200));
  }
  // and the guest's own POST answers only {ok, already}
  const own = await tap(env, p.token, p.key, { product_id: c.album.id });
  assert.deepEqual(await own.json(), { ok: true, already: true });
  assert.ok(F1);
});

// ─── the code ────────────────────────────────────────────────────────────────

test('worker: the write is one statement, every value bound; the record is read by the admin detail only', () => {
  const writes = WORKER.match(/INSERT INTO \$\{INTEREST_TABLE\}[^`]*`/g) || [];
  assert.equal(writes.length, 1, 'one INSERT');
  assert.doesNotMatch(WORKER, /UPDATE \$\{INTEREST_TABLE\}|UPDATE product_interests|DELETE FROM product_interests|DELETE FROM \$\{INTEREST_TABLE\}/);
  const reads = WORKER.match(/FROM \$\{INTEREST_TABLE\}/g) || [];
  assert.ok(reads.length >= 1);
  assert.match(WORKER, /const INTEREST_TABLE = 'product_interests'/);
  assert.match(WORKER, /const INTEREST_PRODUCTS_MAX = 20;/);
  assert.match(WORKER, /const INTEREST_EMAIL_INTERVAL_MS = 24 \* 60 \* 60 \* 1000;/);
});
