// Guest picking: retouch pins. On a ♥ photo the seat holder taps spots and
// leaves a short note at each: selections.marks, a JSON array of
// {x, y, note} with x/y as 0–1 fractions of the photo. Saved with the rating
// (same seat, phase and cap gates, same writes), snapshotted by submit, read
// back only by the seat holder and the photographer. See docs/guest-picking.md.
//
// PUT /api/pick/selections {upsert: [{photo_key, rating, note, marks?}]}
//   marks absent → keep the stored pins (a cached pick.js that never sends
//   them cannot wipe them); marks [] → clear; rating 0 → cleared, whatever
//   the item says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  SECRET, THEIRS, setup, call, pick, claim, claimed, save, one, rows, collectingCtx,
} from './pick-helpers.mjs';
import { fakeDB } from './fakes.mjs';

const A = '20260819/a.jpg';
const B = '20260819/b.jpg';
const C = '20260819/c.jpg';

const pin = (x, y, note = '') => ({ x, y, note });
const P1 = pin(0.25, 0.5, '這裡痘痘');
const P2 = pin(0.75, 0.1, '');
const P3 = pin(0, 1, 'edge');

const marksOf = (env, key) => one(env, 'SELECT marks FROM selections WHERE photo_key = ?', key)?.marks;
const parsedMarks = (env, key) => {
  const m = marksOf(env, key);
  return m == null ? m : JSON.parse(m);
};

async function badMarks(env, p, marks, what, extra = {}) {
  const res = await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks, ...extra }] });
  assert.equal(res.status, 400, what);
  const json = await res.json();
  assert.equal(json.code, 'invalid_marks', what);
  assert.equal(typeof json.error, 'string', what);
}

function fakeMailer() {
  const sent = [];
  return { sent, async send(msg) { sent.push(msg); return { messageId: 'm' }; } };
}
const mailEnv = (mailer = fakeMailer(), extra = {}) =>
  setup({ NOTIFY_EMAIL: mailer, PHOTOGRAPHER_EMAIL: 'studio@example.com', ...extra });
async function submit(env, p, body = { relationship: '本人' }) {
  const c = collectingCtx();
  const res = await pick(env, 'POST', 'submit', p.token, { key: p.key, body }, c);
  await c.settle();
  return { res, json: await res.json() };
}
const rewind = (env, minutes) => env.DB._db.prepare('UPDATE projects SET last_notified_at = ?')
  .run(new Date(Date.now() - minutes * 60000).toISOString());
const submissionRows = env => rows(env, 'SELECT * FROM submissions ORDER BY rowid');
const state = async (env, p, key) => (await pick(env, 'GET', 'state', p.token, { key })).json();
const detail = async (env, id) => {
  const res = await call(env, `/api/admin/projects/${id}`, { token: SECRET });
  assert.equal(res.status, 200);
  return res.json();
};

// schema.sql as a database that has not had the retouch-pins migration
const PRE_MIGRATION = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
  // selections: the column sits between updated_at and the PRIMARY KEY
  .replace(/(updated_at TEXT NOT NULL,)\n(?:\s*--[^\n]*\n)*\s*marks\s+TEXT,[^\n]*/, '$1')
  // submissions: the last column, so notified loses its trailing comma
  .replace(/(notified\s+INTEGER NOT NULL DEFAULT 0),\n(?:\s*--[^\n]*\n)*\s*marks\s+TEXT[^\n]*/, '$1');
const preMigrationEnv = (extra = {}) => setup({ DB: fakeDB({ schema: PRE_MIGRATION }), ...extra });

// ─── the migration ──────────────────────────────────────────────────────────

test('migration: two append-only ALTERs, noted in schema.sql; the fixture really lacks them', () => {
  const file = new URL('../migrations/2026-09-30-retouch-pins.sql', import.meta.url);
  assert.ok(existsSync(file));
  const sql = readFileSync(file, 'utf8');
  const statements = sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
  assert.deepEqual(statements, [
    'ALTER TABLE selections ADD COLUMN marks TEXT',
    'ALTER TABLE submissions ADD COLUMN marks TEXT',
  ]);
  assert.match(sql, /duplicate column/i);
  const fresh = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  assert.match(fresh, /2026-09-30-retouch-pins\.sql/);
  assert.match(fresh, /ALTER TABLE selections ADD COLUMN marks TEXT;/);
  assert.match(fresh, /ALTER TABLE submissions ADD COLUMN marks TEXT;/);
  // the pre-migration fixture: both columns gone, and the migration on top of
  // it gives exactly what schema.sql creates fresh
  const old = fakeDB({ schema: PRE_MIGRATION });
  for (const t of ['selections', 'submissions']) {
    assert.throws(() => old._db.prepare(`SELECT marks FROM ${t}`).all(), /no such column/, t);
  }
  const shape = db => ['selections', 'submissions'].map(t => db._db.prepare(`PRAGMA table_info(${t})`).all());
  assert.deepEqual(shape(fakeDB({ schema: PRE_MIGRATION + '\n' + sql })), shape(fakeDB()));
});

// ─── saving: the happy path ──────────────────────────────────────────────────

test('the owner saves pins on a ♥ photo: canonical form, rounded to 4 decimals, extra fields dropped', async () => {
  const env = setup();
  const p = await claimed(env);
  const res = await save(env, p.token, p.key, {
    upsert: [{
      photo_key: A, rating: 1, note: 'n',
      marks: [
        { note: '  這裡痘痘 ', y: 0.123456, x: 0.987654321, extra: 'drop', shape: 'circle' },
        { x: 0, y: 1 },
        { x: 1, y: 0, note: '' },
      ],
    }],
  });
  assert.equal(res.status, 200);
  // the server's own serialisation: key order x, y, note; note trimmed; a
  // missing note is ''
  assert.equal(marksOf(env, A),
    '[{"x":0.9877,"y":0.1235,"note":"這裡痘痘"},{"x":0,"y":1,"note":""},{"x":1,"y":0,"note":""}]');
  assert.equal(one(env, 'SELECT note FROM selections WHERE photo_key = ?', A).note, 'n');
});

test('bounds: x and y are finite numbers in [0, 1]', async () => {
  const env = setup();
  const p = await claimed(env);
  for (const [bad, what] of [
    [[pin(1.0001, 0.5)], 'x 1.0001'],
    [[pin(0.5, 1.0001)], 'y 1.0001'],
    [[pin(-0.0001, 0.5)], 'x negative'],
    [[pin(0.5, -1)], 'y negative'],
    [[{ x: NaN, y: 0.5 }], 'NaN (JSON null)'],
    [[{ x: null, y: 0.5 }], 'null'],
    [[{ x: '0.5', y: 0.5 }], 'string x'],
    [[{ x: 0.5, y: '0.5' }], 'string y'],
    [[{ y: 0.5 }], 'x missing'],
    [[{ x: 0.5 }], 'y missing'],
    [[{ x: true, y: 0.5 }], 'boolean'],
    [[{ x: [0.5], y: 0.5 }], 'array x'],
  ]) await badMarks(env, p, bad, what);
  // Infinity cannot be sent as JSON; a huge literal parses to it
  const res = await pick(env, 'PUT', 'selections', p.token, {
    key: p.key, body: `{"upsert":[{"photo_key":"${A}","rating":1,"marks":[{"x":1e999,"y":0.5}]}]}`,
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'invalid_marks');
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections').n, 0, 'nothing written on any 400');
  // and the edges themselves are fine
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [pin(0, 0), pin(1, 1)] }] })).status, 200);
  assert.deepEqual(parsedMarks(env, A), [pin(0, 0), pin(1, 1)]);
});

test('bounds: at most 10 pins', async () => {
  const env = setup();
  const p = await claimed(env);
  const n = k => Array.from({ length: k }, (_, i) => pin(i / 10, 0.5, `${i + 1}`));
  await badMarks(env, p, n(11), '11 pins');
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections').n, 0);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: n(10) }] })).status, 200);
  assert.equal(parsedMarks(env, A).length, 10);
});

test('bounds: a pin note is at most 100 characters (not UTF-16 units), after trimming', async () => {
  const env = setup();
  const p = await claimed(env);
  for (const [note, what] of [
    ['a'.repeat(101), '101 ASCII'],
    ['字'.repeat(101), '101 CJK'],
    ['😀'.repeat(101), '101 emoji'],
  ]) await badMarks(env, p, [pin(0.5, 0.5, note)], what);
  for (const note of [5, null, ['x'], { t: 'x' }]) await badMarks(env, p, [{ x: 0.5, y: 0.5, note }], `note ${JSON.stringify(note)}`);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections').n, 0);
  for (const [note, stored] of [
    ['a'.repeat(100), 'a'.repeat(100)],
    ['字'.repeat(100), '字'.repeat(100)],
    ['😀'.repeat(100), '😀'.repeat(100)], // 200 UTF-16 units
    ['  ' + '字'.repeat(100) + '  ', '字'.repeat(100)],
  ]) {
    const res = await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [pin(0.5, 0.5, note)] }] });
    assert.equal(res.status, 200, `${[...note].length} chars`);
    assert.equal(parsedMarks(env, A)[0].note, stored);
  }
});

test('bounds: no control or line-separator characters inside a pin note', async () => {
  const env = setup();
  const p = await claimed(env);
  for (const note of ['a\nb', 'a\rb', 'a\u0000b', 'a\u0007b', 'a\u007Fb', 'a\u0085b', 'a b', 'a b', 'a\tb']) {
    await badMarks(env, p, [pin(0.5, 0.5, note)], JSON.stringify(note));
  }
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections').n, 0);
  // leading/trailing whitespace (a textarea's newline) is trimmed first
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [pin(0.5, 0.5, 'ok\n')] }] })).status, 200);
  assert.equal(parsedMarks(env, A)[0].note, 'ok');
});

test('bounds: marks must be an array of plain objects', async () => {
  const env = setup();
  const p = await claimed(env);
  for (const [bad, what] of [
    [{}, 'object'], ['x', 'string'], [null, 'null'], [5, 'number'], [true, 'boolean'],
    [{ 0: P1, length: 1 }, 'array-like'],
    [[null], 'null item'], [[5], 'number item'], [['x'], 'string item'], [[[0.5, 0.5]], 'array item'],
    [[P1, null], 'one bad item after a good one'],
  ]) await badMarks(env, p, bad, what);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections').n, 0);
});

test('a 400 on one item writes none of the others', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 1, marks: [P1] }] });
  const res = await save(env, p.token, p.key, {
    upsert: [{ photo_key: A, rating: 2, marks: [P2] }, { photo_key: B, rating: 3, marks: [] }, { photo_key: C, rating: 1, marks: [pin(2, 0)] }],
  });
  assert.equal(res.status, 400);
  assert.deepEqual(rows(env, 'SELECT photo_key, rating, marks FROM selections').map(r => ({ ...r })),
    [{ photo_key: B, rating: 1, marks: JSON.stringify([P1]) }]);
});

// ─── saving: absent / [] / unrate ────────────────────────────────────────────

test('marks absent keeps the stored pins; [] clears them', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P1, P2] }] });
  assert.deepEqual(parsedMarks(env, A), [P1, P2]);
  // an old pick.js re-rating and editing the note: the pins stay
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 4, note: '新備註' }] })).status, 200);
  assert.deepEqual(parsedMarks(env, A), [P1, P2]);
  assert.equal(one(env, 'SELECT rating FROM selections WHERE photo_key = ?', A).rating, 4);
  // replacing is whole-list
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 4, marks: [P3] }] });
  assert.deepEqual(parsedMarks(env, A), [P3]);
  // [] clears to NULL, not '[]'
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 4, marks: [] }] })).status, 200);
  assert.equal(marksOf(env, A), null);
  // a new photo saved without marks has none
  await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 1 }] });
  assert.equal(marksOf(env, B), null);
});

test('unrating clears the pins, whether or not the item names marks (pins sent with rating 0 are ignored)', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P1] }, { photo_key: B, rating: 1, marks: [P2] }, { photo_key: C, rating: 1, marks: [P3] }] });
  // A: an old pick.js un-hearting (no marks); B: rating 0 with pins → ignored;
  // C: rating omitted, which is 0
  const res = await save(env, p.token, p.key, {
    upsert: [{ photo_key: A, rating: 0 }, { photo_key: B, rating: 0, marks: [P2] }, { photo_key: C, marks: [P3] }],
  });
  assert.equal(res.status, 200);
  for (const k of [A, B, C]) {
    assert.equal(marksOf(env, k), null, k);
    assert.equal(one(env, 'SELECT rating FROM selections WHERE photo_key = ?', k).rating, 0, k);
  }
  // a brand-new rating-0 row with pins stores none either
  const D = '20260819/sub/d.jpg';
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: D, rating: 0, marks: [P1] }] })).status, 200);
  assert.equal(marksOf(env, D), null);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections WHERE photo_key = ?', D).n, 1);
  // ignored, but still validated
  await badMarks(env, p, [pin(9, 9)], 'bad pins on rating 0', { rating: 0 });
});

test('one save mixing keep, set, clear and unrate applies each to its own photo', async () => {
  const env = setup();
  const p = await claimed(env);
  const D = '20260819/sub/d.jpg';
  await save(env, p.token, p.key, { upsert: [A, B, C, D].map(k => ({ photo_key: k, rating: 1, marks: [P1] })) });
  const res = await save(env, p.token, p.key, {
    upsert: [
      { photo_key: A, rating: 2 },                 // keep
      { photo_key: B, rating: 2, marks: [P2, P3] }, // set
      { photo_key: C, rating: 2, marks: [] },       // clear
      { photo_key: D, rating: 0 },                 // unrate
    ],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(parsedMarks(env, A), [P1]);
  assert.deepEqual(parsedMarks(env, B), [P2, P3]);
  assert.equal(marksOf(env, C), null);
  assert.equal(marksOf(env, D), null);
  assert.deepEqual(rows(env, 'SELECT rating FROM selections ORDER BY photo_key').map(r => r.rating), [2, 2, 2, 0]);
});

test('a key named twice is written as its last mention, marks included', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P1] }] });
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P2] }, { photo_key: A, rating: 1 }] });
  assert.deepEqual(parsedMarks(env, A), [P1], 'the last mention carried no marks: keep');
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }, { photo_key: A, rating: 1, marks: [P3] }] });
  assert.deepEqual(parsedMarks(env, A), [P3]);
});

test('delete takes the pins with the row; a key both upserted and deleted ends up deleted', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P1] }] });
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 1, marks: [P2] }], delete: [A, B] })).status, 200);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections').n, 0);
});

test('a save whose items carry no marks and no unrate never names the column', async () => {
  const env = setup();
  const p = await claimed(env);
  const from = env.DB._sql.length;
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 3, note: 'x' }], delete: [B] })).status, 200);
  const sql = env.DB._sql.slice(from);
  assert.ok(sql.some(s => /INSERT INTO selections/.test(s)), 'the save did write');
  assert.ok(!sql.some(s => /marks/.test(s)), 'no statement mentions marks');
  // and one that does carry marks does name it
  const from2 = env.DB._sql.length;
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 3, marks: [P1] }] });
  assert.ok(env.DB._sql.slice(from2).some(s => /UPDATE selections SET marks/.test(s)));
});

// ─── saving: who, when, where ────────────────────────────────────────────────

test('only the seat holder may save pins: no key, a viewer, a key from before a reset → 403, nothing written', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P1] }] });
  const body = { upsert: [{ photo_key: A, rating: 1, marks: [P2] }, { photo_key: B, rating: 1, marks: [P3] }] };
  assert.equal((await save(env, p.token, undefined, body)).status, 403);
  assert.equal((await save(env, p.token, 'not-a-key', body)).status, 403);
  // reset the seat: the old key is no owner any more
  assert.equal((await call(env, `/api/admin/projects/${p.project.id}/reset-seat`, { method: 'POST', token: SECRET })).status, 200);
  const other = await claim(env, p.token, '李小華');
  assert.equal((await save(env, p.token, p.key, body)).status, 403);
  assert.deepEqual(parsedMarks(env, A), [P1]);
  assert.equal(marksOf(env, B), undefined, 'no row for B');
  // the new holder can
  assert.equal((await save(env, p.token, other.key, body)).status, 200);
  assert.deepEqual(parsedMarks(env, A), [P2]);
});

test('in retouching a save with pins is 409 retouching and writes nothing', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P1] }] });
  await submit(env, p);
  assert.equal((await call(env, `/api/admin/projects/${p.project.id}/start-retouch`, { method: 'POST', token: SECRET })).status, 200);
  for (const upsert of [[{ photo_key: A, rating: 1, marks: [P2] }], [{ photo_key: A, rating: 1, marks: [] }], [{ photo_key: A, rating: 0 }]]) {
    const res = await save(env, p.token, p.key, { upsert });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'retouching');
  }
  assert.deepEqual(parsedMarks(env, A), [P1]);
  assert.equal(one(env, 'SELECT rating FROM selections WHERE photo_key = ?', A).rating, 1);
});

test('a start-retouch landing mid-save wins for the pins too', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P1] }] });
  const batch = env.DB.batch.bind(env.DB);
  env.DB.batch = stmts => {
    env.DB._db.prepare("UPDATE projects SET phase = 'retouching'").run();
    return batch(stmts);
  };
  const res = await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P2] }, { photo_key: B, rating: 0 }] });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'retouching');
  assert.deepEqual(parsedMarks(env, A), [P1]);
});

test('a seat reset landing mid-save wins for the pins too (the marks write carries the gate itself)', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P1] }] });
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    if (/^\s*UPDATE selections SET marks/i.test(sql)) env.DB._db.prepare('UPDATE projects SET owner_picker_id = NULL').run();
    return prepare(sql);
  };
  const res = await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P2] }] });
  assert.equal(res.status, 403);
  assert.deepEqual(parsedMarks(env, A), [P1]);
});

test('pins on a photo outside the link\'s folders: 403, nothing written', async () => {
  const env = setup();
  const p = await claimed(env);
  const res = await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P1] }, { photo_key: `${THEIRS}x.jpg`, rating: 1, marks: [P2] }] });
  assert.equal(res.status, 403);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections').n, 0);
});

test('caps: pins do not count toward them, and a save refused by a cap writes no pins', async () => {
  const env = setup();
  const p = await claimed(env);
  const ins = env.DB._db.prepare("INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at) VALUES (?, ?, 1, '', 'x', 'now')");
  for (let i = 0; i < 500; i++) ins.run(p.project.id, `20260819/p${i}.jpg`);
  // at the 500-star cap: a new star with pins is refused, pins and all
  const res = await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P1] }, { photo_key: '20260819/p0.jpg', rating: 1, marks: [P2] }] });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'selection_cap');
  assert.equal(marksOf(env, A), undefined);
  assert.equal(marksOf(env, '20260819/p0.jpg'), null);
  // pins on photos already starred are fine at the cap
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: '20260819/p0.jpg', rating: 1, marks: [P2] }] })).status, 200);
  assert.deepEqual(parsedMarks(env, '20260819/p0.jpg'), [P2]);
});

test('a save setting pins raises modified_after_submit like any save', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  await submit(env, p);
  assert.equal(one(env, 'SELECT modified_after_submit AS m FROM projects').m, 0);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P1] }] });
  assert.equal(one(env, 'SELECT modified_after_submit AS m FROM projects').m, 1);
});

// ─── reading: state ──────────────────────────────────────────────────────────

test('state: the seat holder gets each selection\'s marks; a viewer never does', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, note: 'n', marks: [P1, P2] }, { photo_key: B, rating: 2 }] });
  const owner = await state(env, p, p.key);
  assert.equal(owner.is_owner, true);
  assert.deepEqual(owner.selections, [
    { photo_key: A, rating: 1, note: 'n', marks: [P1, P2] },
    { photo_key: B, rating: 2, note: '', marks: null },
  ]);
  for (const key of [undefined, 'wrong']) {
    const viewer = await state(env, p, key);
    assert.equal(viewer.is_owner, false);
    assert.deepEqual(viewer.selections, [{ photo_key: A, rating: 1 }, { photo_key: B, rating: 2 }]);
    assert.doesNotMatch(JSON.stringify(viewer), /這裡痘痘|marks/);
  }
});

test('state: marks that do not parse (hand-edited) read as null, not a crash', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }, { photo_key: B, rating: 1 }, { photo_key: C, rating: 1, marks: [P1] }] });
  env.DB._db.prepare('UPDATE selections SET marks = ? WHERE photo_key = ?').run('{nope', A);
  env.DB._db.prepare('UPDATE selections SET marks = ? WHERE photo_key = ?').run('{"x":1}', B);
  const owner = await state(env, p, p.key);
  assert.deepEqual(owner.selections.map(s => s.marks), [null, null, [P1]]);
  // valid JSON that is not a pin list is re-checked on the way out, too
  env.DB._db.prepare('UPDATE selections SET marks = ? WHERE photo_key = ?').run('[1,2]', A);
  env.DB._db.prepare('UPDATE selections SET marks = ? WHERE photo_key = ?').run('[{"x":5,"y":0,"note":"a"}]', B);
  assert.deepEqual((await state(env, p, p.key)).selections.map(s => s.marks), [null, null, [P1]]);
});

// ─── submit ─────────────────────────────────────────────────────────────────

test('submit snapshots the pins of the ♥ photos, keyed by photo', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  await save(env, p.token, p.key, {
    upsert: [{ photo_key: B, rating: 2, marks: [P2] }, { photo_key: A, rating: 1, marks: [P1, P3] }, { photo_key: C, rating: 1 }],
  });
  // pins on an un-hearted row (only ever by hand) stay out of the snapshot
  const D = '20260819/sub/d.jpg';
  await save(env, p.token, p.key, { upsert: [{ photo_key: D, rating: 0 }] });
  env.DB._db.prepare('UPDATE selections SET marks = ? WHERE photo_key = ?').run(JSON.stringify([P1]), D);
  const { res } = await submit(env, p);
  assert.equal(res.status, 200);
  const [row] = submissionRows(env);
  assert.deepEqual(JSON.parse(row.photo_keys), [A, B, C]);
  assert.deepEqual(JSON.parse(row.marks), { [A]: [P1, P3], [B]: [P2] });
  assert.deepEqual(Object.keys(JSON.parse(row.marks)), [A, B], 'key order');
  // a snapshot: later edits do not rewrite it
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [] }] });
  assert.deepEqual(JSON.parse(submissionRows(env)[0].marks), { [A]: [P1, P3], [B]: [P2] });
});

test('submit with no pins anywhere stores NULL marks', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  await submit(env, p);
  assert.equal(submissionRows(env)[0].marks, null);
});

test('repeat: same keys and same pins adds no row; only the pins changed → new row, no email', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P1] }, { photo_key: B, rating: 1 }] });
  const first = await submit(env, p);
  assert.equal(mailer.sent.length, 1);
  rewind(env, 60); // the throttle is not what keeps the mail back below

  // unchanged (a rating and a note do not count either): a repeat
  await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 4, note: 'x' }] });
  const again = await submit(env, p);
  assert.equal(again.res.status, 200);
  assert.equal(again.json.submission_id, first.json.submission_id);
  assert.equal(submissionRows(env).length, 1);

  // only the pins changed: a new row, and no email
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P1, P2] }] });
  const pinsOnly = await submit(env, p);
  assert.equal(pinsOnly.res.status, 200);
  assert.notEqual(pinsOnly.json.submission_id, first.json.submission_id);
  let subs = submissionRows(env);
  assert.equal(subs.length, 2);
  assert.deepEqual(JSON.parse(subs[1].marks), { [A]: [P1, P2] });
  assert.equal(subs[1].photo_keys, subs[0].photo_keys);
  assert.equal(subs[1].notified, 0);
  assert.equal(mailer.sent.length, 1);
  assert.equal(one(env, 'SELECT phase, modified_after_submit AS m FROM projects').m, 0);

  // and a submit repeating that one is a repeat again
  await submit(env, p);
  assert.equal(submissionRows(env).length, 2);

  // pins cleared entirely: a change too
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [] }] });
  await submit(env, p);
  subs = submissionRows(env);
  assert.equal(subs.length, 3);
  assert.equal(subs[2].marks, null);
  assert.equal(mailer.sent.length, 1);

  // the photos changed: a new row and, as before, an email
  await save(env, p.token, p.key, { upsert: [{ photo_key: C, rating: 1, marks: [P3] }] });
  await submit(env, p);
  assert.equal(submissionRows(env).length, 4);
  assert.equal(mailer.sent.length, 2);
});

test('repeat: a pin that moved or was re-noted is a change', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P1] }] });
  await submit(env, p);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [{ ...P1, x: 0.2501 }] }] });
  await submit(env, p);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [{ ...P1, x: 0.2501, note: '別處' }] }] });
  await submit(env, p);
  assert.equal(submissionRows(env).length, 3);
});

// ─── admin detail ───────────────────────────────────────────────────────────

test('admin detail: selections and submissions carry marks, parsed, null when none', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P1] }, { photo_key: B, rating: 1 }] });
  await submit(env, p);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [] }] });
  await submit(env, p);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P2] }] });
  const d = await detail(env, p.project.id);
  assert.deepEqual(d.selections.map(s => [s.photo_key, s.marks]), [[A, [P2]], [B, null]]);
  // newest first
  assert.deepEqual(d.submissions.map(s => s.marks), [null, { [A]: [P1] }]);
  // a pick link is not the photographer
  const res = await call(env, `/api/admin/projects/${p.project.id}?t=${p.token}`, { headers: { 'X-Picker-Key': p.key } });
  assert.equal(res.status, 401);
});

test('admin detail: a hand-edited marks value that does not parse reads as null', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  await submit(env, p);
  env.DB._db.prepare("UPDATE selections SET marks = '{nope'").run();
  env.DB._db.prepare("UPDATE submissions SET marks = '[1,2]'").run();
  const d = await detail(env, p.project.id);
  assert.equal(d.selections[0].marks, null);
  assert.equal(d.submissions[0].marks, null);
});

// ─── before the migration ────────────────────────────────────────────────────

test('before the migration: saves without pins (unrate included), state, submit and admin keep working', async () => {
  const mailer = fakeMailer();
  const env = preMigrationEnv({ NOTIFY_EMAIL: mailer, PHOTOGRAPHER_EMAIL: 'studio@example.com' });
  assert.throws(() => env.DB._db.prepare('SELECT marks FROM selections').all(), /no such column/);
  const p = await claimed(env);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, note: 'n' }, { photo_key: B, rating: 1 }] })).status, 200);
  // an unrate is the one save without marks that would clear them
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 0 }], delete: [C] })).status, 200);
  assert.deepEqual(rows(env, 'SELECT photo_key, rating, note FROM selections ORDER BY photo_key').map(r => ({ ...r })),
    [{ photo_key: A, rating: 1, note: 'n' }, { photo_key: B, rating: 0, note: '' }]);
  const owner = await state(env, p, p.key);
  assert.deepEqual(owner.selections, [
    { photo_key: A, rating: 1, note: 'n', marks: null },
    { photo_key: B, rating: 0, note: '', marks: null },
  ]);
  const viewer = await state(env, p);
  assert.deepEqual(viewer.selections, [{ photo_key: A, rating: 1 }, { photo_key: B, rating: 0 }]);
  const first = await submit(env, p);
  assert.equal(first.res.status, 200);
  assert.equal(submissionRows(env).length, 1);
  assert.equal(mailer.sent.length, 1);
  // a repeat is still a repeat
  const again = await submit(env, p);
  assert.equal(again.json.submission_id, first.json.submission_id);
  assert.equal(submissionRows(env).length, 1);
  // and a change is still a change
  await save(env, p.token, p.key, { upsert: [{ photo_key: C, rating: 1 }] });
  await submit(env, p);
  assert.equal(submissionRows(env).length, 2);
  const d = await detail(env, p.project.id);
  assert.deepEqual(d.selections.map(s => s.marks), [null, null, null]);
  assert.deepEqual(d.submissions.map(s => s.marks), [null, null]);
  assert.deepEqual(d.submissions.map(s => s.photo_keys), [[A, C], [A]]);
});

test('before the migration: a save carrying pins is refused 500 marks_unavailable and writes nothing', async () => {
  const env = preMigrationEnv();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  for (const marks of [[P1], []]) {
    const res = await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 3 }, { photo_key: B, rating: 1, marks }] });
    assert.equal(res.status, 500);
    assert.equal((await res.json()).code, 'marks_unavailable');
  }
  assert.deepEqual(rows(env, 'SELECT photo_key, rating FROM selections').map(r => ({ ...r })), [{ photo_key: A, rating: 1 }]);
  assert.equal(one(env, 'SELECT modified_after_submit AS m FROM projects').m, 0);
});

// ─── size bounds (security review 2026-09-30) ───────────────────────────────
// PICK_MARKS_TOTAL_MAX = 300 pins per project, across its selections;
// PICK_BODY_MAX = 2,000,000 bytes for a save body, PICK_SUBMIT_BODY_MAX =
// 16 KB for a submit body; PICK_BIND_MAX = 1,900,000 bytes for the one big
// bound value of a save (D1 refuses a value over 2,000,000 bytes).
const TOTAL = 300;
const keyN = i => `20260819/m${i}.jpg`;
const pins = n => Array.from({ length: n }, (_, i) => pin((i % 10) / 10, 0.5, `${i}`));
const pinTotal = env => rows(env, 'SELECT marks FROM selections WHERE marks IS NOT NULL')
  .reduce((n, r) => n + JSON.parse(r.marks).length, 0);
// n photos with 10 pins each, then the rest on one more photo
async function pinUpTo(env, p, total) {
  const upsert = [];
  for (let i = 0; total > 0; i++) {
    const k = Math.min(10, total);
    upsert.push({ photo_key: keyN(i), rating: 1, marks: pins(k) });
    total -= k;
  }
  const res = await save(env, p.token, p.key, { upsert });
  assert.equal(res.status, 200);
  return upsert.length;
}
async function expectMarksCap(res) {
  assert.equal(res.status, 409);
  const json = await res.json();
  assert.equal(json.code, 'marks_cap');
  assert.equal(json.error, '標示總數已達上限（300 個）');
  assert.equal(json.max, TOTAL);
}

test('marks cap: 300 pins across the project are fine, the 301st is 409 marks_cap with nothing written', async () => {
  const env = setup();
  const p = await claimed(env);
  const used = await pinUpTo(env, p, TOTAL - 1);
  assert.equal(pinTotal(env), 299);
  // one more: exactly at the cap
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P1] }] })).status, 200);
  assert.equal(pinTotal(env), TOTAL);
  // the 301st, on a new photo that also changes its rating and note: refused whole
  const flag = one(env, 'SELECT modified_after_submit AS m FROM projects').m;
  const res = await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 3, note: 'n', marks: [P2] }, { photo_key: keyN(0), rating: 5 }] });
  await expectMarksCap(res);
  assert.equal(pinTotal(env), TOTAL);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections WHERE photo_key = ?', B).n, 0, 'the rating did not land either');
  assert.equal(one(env, 'SELECT rating FROM selections WHERE photo_key = ?', keyN(0)).rating, 1);
  assert.equal(one(env, 'SELECT modified_after_submit AS m FROM projects').m, flag);
  // a save carrying no pins at all still works at the cap
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 2 }] })).status, 200);
  assert.ok(used > 0);
});

test('marks cap: one save that would take a fresh project from 0 to 301 is refused', async () => {
  const env = setup();
  const p = await claimed(env);
  const upsert = Array.from({ length: 31 }, (_, i) => ({ photo_key: keyN(i), rating: 1, marks: pins(i === 30 ? 1 : 10) }));
  await expectMarksCap(await save(env, p.token, p.key, { upsert }));
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections').n, 0);
  upsert.pop();
  assert.equal((await save(env, p.token, p.key, { upsert })).status, 200);
  assert.equal(pinTotal(env), TOTAL);
});

test('marks cap: at the cap, replacing a photo\'s pins counts the net result; clearing and unrating always work', async () => {
  const env = setup();
  const p = await claimed(env);
  await pinUpTo(env, p, TOTAL);
  // keyN(0) has 10: replace with 10 others — net 0
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: keyN(0), rating: 1, marks: pins(10).map(m => ({ ...m, note: '改' })) }] })).status, 200);
  assert.equal(parsedMarks(env, keyN(0))[0].note, '改');
  // two net-0 replacements plus one new pin: net +1, refused
  await expectMarksCap(await save(env, p.token, p.key, { upsert: [{ photo_key: keyN(0), rating: 1, marks: pins(10) }, { photo_key: keyN(1), rating: 1, marks: pins(10) }, { photo_key: A, rating: 1, marks: [P1] }] }));
  // shrink one and grow another by the same amount: allowed
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: keyN(0), rating: 1, marks: pins(5) }, { photo_key: A, rating: 1, marks: pins(5) }] })).status, 200);
  assert.equal(pinTotal(env), TOTAL);
  // clear, unrate, delete: always allowed
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: keyN(0), rating: 1, marks: [] }] })).status, 200);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: keyN(1), rating: 0 }] })).status, 200);
  assert.equal((await save(env, p.token, p.key, { delete: [keyN(2)] })).status, 200);
  assert.equal(pinTotal(env), TOTAL - 5 - 10 - 10);
});

test('marks cap: pins sent on rating-0 items do not count', async () => {
  const env = setup();
  const p = await claimed(env);
  await pinUpTo(env, p, TOTAL);
  assert.equal((await save(env, p.token, p.key, {
    upsert: [{ photo_key: A, rating: 0, marks: pins(10) }, { photo_key: B, rating: 0, marks: pins(10) }],
  })).status, 200);
  assert.equal(pinTotal(env), TOTAL);
});

test('marks cap: a project already over it (by hand) can still shrink, not grow', async () => {
  const env = setup();
  const p = await claimed(env);
  await pinUpTo(env, p, TOTAL);
  env.DB._db.prepare("INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at, marks) VALUES (?, ?, 1, '', 'x', 'now', ?)")
    .run(p.project.id, A, JSON.stringify(pins(10)));
  assert.equal(pinTotal(env), TOTAL + 10);
  await expectMarksCap(await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 1, marks: [P1] }] }));
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: pins(9) }] })).status, 200);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: pins(9) }] })).status, 200, 'net 0 over the cap');
});

test('marks cap: two saves racing for the last pins — one wins, the other gets 409 marks_cap', async () => {
  const env = setup();
  const p = await claimed(env);
  await pinUpTo(env, p, TOTAL - 5);
  const [r1, r2] = await Promise.all([
    save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: pins(5) }] }),
    save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 1, marks: pins(5) }] }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  await expectMarksCap(r1.status === 409 ? r1 : r2);
  assert.equal(pinTotal(env), TOTAL);
  assert.equal(rows(env, 'SELECT photo_key FROM selections WHERE photo_key IN (?, ?)', A, B).length, 1, 'the loser left no row');
});

test('marks cap: the other caps keep their own codes', async () => {
  const env = setup();
  const p = await claimed(env);
  const ins = env.DB._db.prepare("INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at) VALUES (?, ?, 1, '', 'x', 'now')");
  for (let i = 0; i < 500; i++) ins.run(p.project.id, `20260819/p${i}.jpg`);
  const res = await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P1] }] });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'selection_cap');
});

test('the marks-cap check is inside the write gate: a pin save landing after another took the room is refused whole', async () => {
  const env = setup();
  const p = await claimed(env);
  await pinUpTo(env, p, TOTAL - 1);
  // another save lands between this route's checks and its batch
  const batch = env.DB.batch.bind(env.DB);
  let once = false;
  env.DB.batch = stmts => {
    if (!once) {
      once = true;
      env.DB._db.prepare("INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at, marks) VALUES (?, ?, 1, '', 'x', 'now', ?)")
        .run(p.project.id, C, JSON.stringify([P3]));
    }
    return batch(stmts);
  };
  await expectMarksCap(await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 4, marks: [P1] }] }));
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections WHERE photo_key = ?', A).n, 0);
});

// ─── request and value sizes ────────────────────────────────────────────────

const BODY_MAX = 2000000;

test('save: a body over 2,000,000 bytes is 413 too_large, nothing written, even with no Content-Length', async () => {
  const env = setup();
  const p = await claimed(env);
  const body = JSON.stringify({ upsert: [{ photo_key: A, rating: 1, note: 'x'.repeat(BODY_MAX) }] });
  const res = await pick(env, 'PUT', 'selections', p.token, { key: p.key, body });
  assert.equal(res.status, 413);
  const json = await res.json();
  assert.equal(json.code, 'too_large');
  assert.equal(json.max, BODY_MAX);
  // streamed, so no Content-Length to trust
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); } });
  const worker = (await import('../worker.js')).default;
  const r2 = await worker.fetch(new Request(`https://worker.test/api/pick/selections?t=${p.token}`, {
    method: 'PUT', headers: { 'X-Picker-Key': p.key }, body: stream, duplex: 'half',
  }), env, { waitUntil() {} });
  assert.equal(r2.status, 413);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections').n, 0);
  // parse failures are unchanged
  const bad = await pick(env, 'PUT', 'selections', p.token, { key: p.key, body: '{nope' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'Invalid JSON');
});

test('save: a body inside the cap whose bound value would pass 1,900,000 bytes is 413 before any write', async () => {
  const env = setup();
  const p = await claimed(env);
  // quotes in pin notes are escaped twice in the bound JSON: ~1.2 MB of body
  // becomes over 2 MB of value
  const q = '"'.repeat(100);
  const upsert = Array.from({ length: 500 }, (_, i) => ({ photo_key: `20260819/q${i}.jpg`, rating: 1, marks: Array.from({ length: 10 }, () => pin(0.5, 0.5, q)) }));
  const body = JSON.stringify({ upsert });
  assert.ok(Buffer.byteLength(body) < BODY_MAX, `body ${Buffer.byteLength(body)}`);
  const from = env.DB._sql.length;
  const res = await pick(env, 'PUT', 'selections', p.token, { key: p.key, body });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, 'too_large');
  assert.ok(!env.DB._sql.slice(from).some(s => /^\s*(INSERT|UPDATE|DELETE)/i.test(s)), 'no write was even tried');
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections').n, 0);
});

test('save: the largest legitimate save still passes (500 long CJK keys and notes, 300 long pins)', async () => {
  const env = setup();
  const p = await claimed(env);
  const key = i => `20260819/${String(i).padStart(3, '0')}${'照'.repeat(256 - 9 - 3)}`;
  const upsert = Array.from({ length: 500 }, (_, i) => ({
    photo_key: key(i), rating: 5, note: '字'.repeat(500),
    ...(i < 30 ? { marks: Array.from({ length: 10 }, () => pin(0.1234, 0.5678, '修'.repeat(100))) } : {}),
  }));
  const body = JSON.stringify({ upsert });
  const bytes = Buffer.byteLength(body);
  assert.ok(bytes > 1200000 && bytes < BODY_MAX, `body ${bytes}`);
  const res = await pick(env, 'PUT', 'selections', p.token, { key: p.key, body });
  assert.equal(res.status, 200);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM selections').n, 500);
  assert.equal(pinTotal(env), TOTAL);
});

test('submit: a body over 16 KB is 413 too_large, nothing written', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  const res = await pick(env, 'POST', 'submit', p.token, { key: p.key, body: { relationship: '本人', pad: 'x'.repeat(16 * 1024) } });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).code, 'too_large');
  assert.equal(submissionRows(env).length, 0);
  assert.equal(one(env, 'SELECT phase FROM projects').phase, 'picking');
  // a normal one still works, and bad JSON is still 400
  const bad = await pick(env, 'POST', 'submit', p.token, { key: p.key, body: '{nope' });
  assert.equal(bad.status, 400);
  assert.equal((await submit(env, p)).res.status, 200);
});

test('a very long string is refused without being spread: note, pin note, key, email', async () => {
  const env = setup();
  const p = await claimed(env);
  const huge = 'x'.repeat(600000);
  let spreadLong = 0;
  // String iteration is what charCount uses; count spreads of huge strings
  const orig = String.prototype[Symbol.iterator];
  String.prototype[Symbol.iterator] = function () { if (this.length > 100000) spreadLong++; return orig.call(this); };
  try {
    assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, note: huge }] })).status, 400);
    await badMarks(env, p, [pin(0.5, 0.5, huge)], 'huge pin note');
    assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: MINE_HUGE(huge), rating: 1 }] })).status, 400);
    assert.equal((await pick(env, 'POST', 'submit', p.token, { key: p.key, body: { relationship: '本人', email: 'a@' + 'b'.repeat(10000) } })).status, 400);
  } finally {
    String.prototype[Symbol.iterator] = orig;
  }
  assert.equal(spreadLong, 0);
});
const MINE_HUGE = huge => '20260819/' + huge;

// ─── the submission snapshot's size ─────────────────────────────────────────
// PICK_MARKS_SNAPSHOT_MAX = 300 × (4 × 256 + 4 × 100 + 64) = 446,400 bytes:
// every pin on its own photo, every character 4 bytes. It never refuses a
// snapshot a save could have produced.
const SNAPSHOT_MAX = 446400;
const worstKey = i => `20260819/${String(i).padStart(3, '0')}${'📷'.repeat(256 - 9 - 3)}`;
const bytes = s => Buffer.byteLength(s ?? '');

test('the worst legal snapshot fits under the byte cap, and 50 of them keep the admin detail bounded', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  const upsert = Array.from({ length: TOTAL }, (_, i) => ({ photo_key: worstKey(i), rating: 1, marks: [pin(0.1234, 0.5678, '😀'.repeat(100))] }));
  assert.equal((await save(env, p.token, p.key, { upsert })).status, 200);
  const { res } = await submit(env, p);
  assert.equal(res.status, 200);
  const [row] = submissionRows(env);
  const size = bytes(row.marks);
  console.log(`worst legal marks snapshot: ${size} bytes (cap ${SNAPSHOT_MAX}); photo_keys ${bytes(row.photo_keys)} bytes`);
  assert.ok(size > 0.9 * SNAPSHOT_MAX && size <= SNAPSHOT_MAX, String(size));
  // 50 submissions of that: the detail carries at most 50 of them
  const copy = env.DB._db.prepare(
    "INSERT INTO submissions (id, project_id, picker_id, relationship, email, photo_keys, count, pick_limit, extra_price, created_at, notified, marks) " +
    "SELECT ?, project_id, picker_id, relationship, email, photo_keys, count, pick_limit, extra_price, created_at, notified, marks FROM submissions WHERE id = ?");
  for (let i = 0; i < 60; i++) copy.run(`copy${i}`, row.id);
  const detailRes = await call(env, `/api/admin/projects/${p.project.id}`, { token: SECRET });
  assert.equal(detailRes.status, 200);
  const text = await detailRes.text();
  const d = JSON.parse(text);
  assert.equal(d.submissions.length, 50);
  const bound = 50 * (bytes(row.marks) + bytes(row.photo_keys) + 1024) + 1024 * 1024;
  console.log(`admin detail with 50 worst submissions: ${bytes(text)} bytes (bound ${bound})`);
  assert.ok(bytes(text) <= bound, `${bytes(text)} > ${bound}`);
  assert.equal(Object.keys(d.submissions[0].marks).length, TOTAL);
});

test('the same with ASCII keys and notes: the realistic worst', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  const upsert = Array.from({ length: TOTAL }, (_, i) => ({ photo_key: `20260819/${String(i).padStart(3, '0')}${'x'.repeat(244)}`, rating: 1, marks: [pin(0.1234, 0.5678, 'n'.repeat(100))] }));
  assert.equal((await save(env, p.token, p.key, { upsert })).status, 200);
  await submit(env, p);
  const [row] = submissionRows(env);
  console.log(`ASCII worst marks snapshot: ${bytes(row.marks)} bytes; x50 = ${50 * bytes(row.marks)}`);
  assert.ok(bytes(row.marks) < 150000);
});

test('submit: a snapshot over the byte cap (only by hand) is 409 marks_cap — no row, no phase change, no email', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  const ins = env.DB._db.prepare("INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at, marks) VALUES (?, ?, 1, '', 'x', 'now', ?)");
  const heavy = JSON.stringify(Array.from({ length: 10 }, () => pin(0.1234, 0.5678, '😀'.repeat(100))));
  for (let i = 0; i < 120; i++) ins.run(p.project.id, worstKey(i), heavy);
  const { res, json } = await submit(env, p);
  assert.equal(res.status, 409);
  assert.equal(json.code, 'marks_cap');
  assert.equal(submissionRows(env).length, 0);
  assert.equal(one(env, 'SELECT phase FROM projects').phase, 'picking');
  assert.equal(mailer.sent.length, 0);
  // back under: it goes through
  env.DB._db.prepare('UPDATE selections SET marks = NULL WHERE photo_key != ?').run(worstKey(0));
  assert.equal((await submit(env, p)).res.status, 200);
  assert.equal(submissionRows(env).length, 1);
});

test('submit: the submission cap keeps its own code', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  const ins = env.DB._db.prepare("INSERT INTO submissions (id, project_id, picker_id, relationship, photo_keys, count, created_at) VALUES (?, ?, 'x', '本人', '[]', 0, 'now')");
  for (let i = 0; i < 50; i++) ins.run(`s${i}`, p.project.id);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: [P1] }] });
  const { res, json } = await submit(env, p);
  assert.equal(res.status, 409);
  assert.equal(json.code, 'submission_cap');
});

test('marks cap: deletes in the same save make room (a deleted row\'s pins, and pins on a key also deleted, do not count)', async () => {
  const env = setup();
  const p = await claimed(env);
  await pinUpTo(env, p, TOTAL);
  // delete a photo with 10 pins and pin 10 on another in the same save
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, marks: pins(10) }], delete: [keyN(0)] })).status, 200);
  assert.equal(pinTotal(env), TOTAL);
  // pins on a key that the same save deletes land nowhere, so they cost nothing
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 1, marks: pins(10) }], delete: [B] })).status, 200);
  assert.equal(pinTotal(env), TOTAL);
  assert.equal(marksOf(env, B), undefined);
});
