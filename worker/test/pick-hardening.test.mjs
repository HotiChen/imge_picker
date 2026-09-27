// Guest picking, security hardening: photo keys are bounded and printable, a
// project holds at most PICK_MAX_SELECTIONS picks, the photographer is not
// mailed more than once per ten minutes nor for a submit that changed nothing,
// notes are the owner's, a lost link can be replaced, and every admin project
// route is scoped to this photographer. See docs/guest-picking.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECRET, MINE, setup, call, pick, createProject, claimed, save, one, rows, collectingCtx, days,
} from './pick-helpers.mjs';

const A = '20260819/a.jpg';
const B = '20260819/b.jpg';
const CAP = 500; // PICK_MAX_SELECTIONS in worker.js
const ROWS = 1000; // PICK_MAX_ROWS in worker.js

const selectionRows = env => rows(env, 'SELECT photo_key, rating, note FROM selections ORDER BY photo_key');
const keysN = (n, from = 0) => Array.from({ length: n }, (_, i) => `20260819/p${from + i}.jpg`);
const upsertOf = keys => keys.map(photo_key => ({ photo_key, rating: 1 }));

// ─── 1. photo_key shape ──────────────────────────────────────────────────────

const BAD_KEYS = [
  ['257 characters', MINE + 'x'.repeat(257 - MINE.length)],
  ['NUL', '20260819/a\u0000.jpg'],
  ['newline', '20260819/a\n.jpg'],
  ['tab', '20260819/a\t.jpg'],
  ['unit separator U+001F', '20260819/a\u001F.jpg'],
  ['DEL U+007F', '20260819/a\u007F.jpg'],
  ['C1 U+0085', '20260819/a\u0085.jpg'],
  ['C1 U+009F', '20260819/a\u009F.jpg'],
  ['line separator U+2028', '20260819/a .jpg'],
  ['paragraph separator U+2029', '20260819/a .jpg'],
  ['a folder, not a photo', '20260819/sub/'],
];

for (const [what, key] of BAD_KEYS) {
  for (const dir of ['upsert', 'delete']) {
    test(`a photo key with ${what} is refused in ${dir}: 400 invalid_photo_key, nothing written`, async () => {
      const env = setup();
      const p = await claimed(env);
      await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
      const body = dir === 'upsert'
        ? { upsert: [{ photo_key: B, rating: 2 }, { photo_key: key, rating: 1 }] }
        : { upsert: [{ photo_key: B, rating: 2 }], delete: [A, key] };
      const res = await save(env, p.token, p.key, body);
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, 'invalid_photo_key');
      assert.deepEqual(selectionRows(env).map(s => s.photo_key), [A]);
    });
  }
}

test('a photo key of exactly 256 characters is fine, counted as characters not UTF-16 units', async () => {
  const env = setup();
  const p = await claimed(env);
  const ascii = MINE + 'x'.repeat(256 - MINE.length);
  // 256 characters, but emoji are two UTF-16 units each
  const emoji = MINE + '📷'.repeat(256 - MINE.length);
  assert.equal(emoji.length > 256, true);
  const res = await save(env, p.token, p.key, { upsert: upsertOf([ascii, emoji]) });
  assert.equal(res.status, 200);
  assert.equal(selectionRows(env).length, 2);
  // and one more character is too many for either
  for (const key of [ascii + 'x', emoji + '📷']) {
    const r = await save(env, p.token, p.key, { upsert: upsertOf([key]) });
    assert.equal(r.status, 400, key.length);
  }
});

test('non-control Unicode and spaces in a key are fine', async () => {
  const env = setup();
  const p = await claimed(env);
  const res = await save(env, p.token, p.key, { upsert: upsertOf(['20260819/婚紗 照 ¡ é.jpg']) });
  assert.equal(res.status, 200);
});

// ─── 2. selection caps ───────────────────────────────────────────────────────
// Rows are seeded straight into D1 to keep these fast; every seeded key is a
// valid key inside the link's folder, so a later save naming one is refused
// (or not) by the cap alone.

function seed(env, p, keys, rating = 1, note = '') {
  const ins = env.DB._db.prepare(
    "INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, 'seeded')");
  env.DB._db.exec('BEGIN');
  for (const k of keys) ins.run(p.project.id, k, rating, note, p.pickerId);
  env.DB._db.exec('COMMIT');
}
const starred = env => one(env, 'SELECT COUNT(*) AS n FROM selections WHERE rating > 0').n;
const zero = keys => keys.map(photo_key => ({ photo_key, rating: 0, note: 'n' }));

test(`a project holds at most ${CAP} starred photos; the save that would pass it writes nothing`, async () => {
  const env = setup();
  const p = await claimed(env);
  seed(env, p, keysN(CAP - 1));
  const before = JSON.stringify(selectionRows(env));
  // one update to an existing pick plus two new ones: CAP + 1
  const res = await save(env, p.token, p.key, {
    upsert: [{ photo_key: keysN(1)[0], rating: 5 }, ...upsertOf(keysN(2, CAP - 1))],
  });
  assert.equal(res.status, 409);
  const json = await res.json();
  assert.equal(json.code, 'selection_cap');
  assert.equal(json.max, CAP);
  assert.equal(JSON.stringify(selectionRows(env)), before, 'not even the update to an existing key');
  // exactly at the cap is fine
  assert.equal((await save(env, p.token, p.key, { upsert: upsertOf(keysN(1, CAP - 1)) })).status, 200);
  assert.equal(starred(env), CAP);
});

test('at the cap, re-rating and deleting still work, and a delete makes room', async () => {
  const env = setup();
  const p = await claimed(env);
  seed(env, p, keysN(CAP));
  const [k0, k1] = keysN(2);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: k0, rating: 5, note: 'n' }] })).status, 200);
  assert.equal(one(env, 'SELECT rating FROM selections WHERE photo_key = ?', k0).rating, 5);
  // a new key alongside a delete in the same save nets out at the cap
  assert.equal((await save(env, p.token, p.key, { upsert: upsertOf([A]), delete: [k1] })).status, 200);
  assert.equal(starred(env), CAP);
  // a key upserted and deleted in the same save ends up deleted, so it takes no slot
  assert.equal((await save(env, p.token, p.key, { upsert: upsertOf([B]), delete: [B] })).status, 200);
  assert.equal(starred(env), CAP);
  assert.equal((await save(env, p.token, p.key, { upsert: upsertOf([B]) })).status, 409);
  assert.equal((await save(env, p.token, p.key, { delete: [k0] })).status, 200);
  assert.equal((await save(env, p.token, p.key, { upsert: upsertOf([B]) })).status, 200);
});

test('a project already over the cap can still re-rate and delete, just not add', async () => {
  const env = setup();
  const p = await claimed(env);
  seed(env, p, keysN(CAP + 5)); // e.g. the constant was lowered after it filled up
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: keysN(1)[0], rating: 3 }] })).status, 200);
  assert.equal((await save(env, p.token, p.key, { delete: keysN(2) })).status, 200);
  assert.equal(starred(env), CAP + 3);
  assert.equal((await save(env, p.token, p.key, { upsert: upsertOf([A]) })).status, 409);
});

test('only starred rows count: un-starring a photo frees its slot', async () => {
  const env = setup();
  const p = await claimed(env);
  seed(env, p, keysN(CAP));
  // the page un-stars by saving rating 0; the row (and any note) stays
  const [k0, k1] = keysN(2);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: k0, rating: 0, note: '先不要' }] })).status, 200);
  assert.equal(one(env, 'SELECT note FROM selections WHERE photo_key = ?', k0).note, '先不要');
  assert.equal((await save(env, p.token, p.key, { upsert: upsertOf([A]) })).status, 200);
  const full = await save(env, p.token, p.key, { upsert: upsertOf([B]) });
  assert.equal(full.status, 409);
  assert.equal((await full.json()).code, 'selection_cap');
  // re-starring an un-starred row is a new pick too
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: k0, rating: 2 }] })).status, 409);
  // un-starring one and starring another in the same save nets out
  const swap = await save(env, p.token, p.key, { upsert: [{ photo_key: k1, rating: 0 }, { photo_key: B, rating: 4 }] });
  assert.equal(swap.status, 200);
  assert.equal(starred(env), CAP);
});

test(`rating-0 rows are allowed past ${CAP} stars, up to ${ROWS} rows in all`, async () => {
  const env = setup();
  const p = await claimed(env);
  seed(env, p, keysN(CAP));
  seed(env, p, keysN(ROWS - CAP - 1, CAP), 0, 'n');
  assert.equal((await save(env, p.token, p.key, { upsert: zero([A]) })).status, 200);
  assert.equal(selectionRows(env).length, ROWS);
  const before = JSON.stringify(selectionRows(env));
  const res = await save(env, p.token, p.key, { upsert: [{ photo_key: keysN(1)[0], rating: 3 }, ...zero([B])] });
  assert.equal(res.status, 409);
  const json = await res.json();
  assert.equal(json.code, 'row_cap');
  assert.equal(json.max, ROWS);
  assert.equal(JSON.stringify(selectionRows(env)), before, 'nothing written');
  // at the row cap: updating works, a new row beside a delete nets out, and a
  // delete makes room
  const [z0, z1] = keysN(2, CAP);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: z0, rating: 0, note: 'changed' }] })).status, 200);
  assert.equal((await save(env, p.token, p.key, { upsert: zero([B]), delete: [z0] })).status, 200);
  assert.equal(selectionRows(env).length, ROWS);
  assert.equal((await save(env, p.token, p.key, { upsert: zero([z0]) })).status, 409);
  assert.equal((await save(env, p.token, p.key, { delete: [z1] })).status, 200);
  assert.equal((await save(env, p.token, p.key, { upsert: zero([z0]) })).status, 200);
});

test('a project already over the row cap can still update and delete, just not add', async () => {
  const env = setup();
  const p = await claimed(env);
  seed(env, p, keysN(ROWS + 5), 0);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: keysN(1)[0], rating: 0, note: 'x' }] })).status, 200);
  assert.equal((await save(env, p.token, p.key, { delete: keysN(2, 5) })).status, 200);
  const res = await save(env, p.token, p.key, { upsert: zero([A]) });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'row_cap');
});

test('a key named twice in one save counts once, and the last one wins', async () => {
  const env = setup();
  const p = await claimed(env);
  seed(env, p, keysN(CAP - 1));
  const res = await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }, { photo_key: A, rating: 4, note: 'last' }] });
  assert.equal(res.status, 200);
  assert.deepEqual({ ...one(env, 'SELECT rating, note FROM selections WHERE photo_key = ?', A) }, { rating: 4, note: 'last' });
});

test('the cap counts only this project', async () => {
  const env = setup();
  const p = await claimed(env);
  const q = await claimed(env);
  seed(env, p, keysN(CAP));
  assert.equal((await save(env, q.token, q.key, { upsert: upsertOf([A]) })).status, 200);
});

test('concurrent saves cannot together pass the cap', async () => {
  const env = setup();
  const p = await claimed(env);
  seed(env, p, keysN(CAP - 10));
  const results = await Promise.all([
    save(env, p.token, p.key, { upsert: upsertOf(keysN(10, 1000)) }),
    save(env, p.token, p.key, { upsert: upsertOf(keysN(10, 2000)) }),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(starred(env), CAP);
});

test('the cap is enforced inside the write, not only by a read before it', async () => {
  // a row that appears after every read the route does, right before the writes
  const env = setup();
  const p = await claimed(env);
  seed(env, p, keysN(CAP - 1));
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = s => {
    if (/^\s*UPDATE projects SET modified_after_submit/i.test(s)) seed(env, p, ['20260819/late.jpg']);
    return prepare(s);
  };
  const res = await save(env, p.token, p.key, { upsert: upsertOf([A]) });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'selection_cap');
  assert.equal(starred(env), CAP);
});

test('a viewer over the cap still gets 403, and retouching still 409 retouching', async () => {
  const env = setup();
  const p = await claimed(env);
  seed(env, p, keysN(CAP));
  assert.equal((await save(env, p.token, 'wrong', { upsert: upsertOf([A]) })).status, 403);
  env.DB._db.prepare("UPDATE projects SET phase = 'retouching'").run();
  const res = await save(env, p.token, p.key, { upsert: upsertOf([A]) });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'retouching');
});

// ─── 3. notification throttle ────────────────────────────────────────────────

function fakeMailer() {
  const sent = [];
  return { sent, async send(msg) { sent.push(msg); return { messageId: 'm' }; } };
}
const mailEnv = (mailer = fakeMailer()) =>
  setup({ NOTIFY_EMAIL: mailer, PHOTOGRAPHER_EMAIL: 'studio@example.com' });
async function submit(env, p, body = { relationship: '本人' }) {
  const c = collectingCtx();
  const res = await pick(env, 'POST', 'submit', p.token, { key: p.key, body }, c);
  await c.settle();
  return res;
}
const rewind = (env, minutes) => env.DB._db.prepare('UPDATE projects SET last_notified_at = ?')
  .run(new Date(Date.now() - minutes * 60000).toISOString());
const submissionCount = env => one(env, 'SELECT COUNT(*) AS n FROM submissions').n;

test('a second changed submit inside ten minutes is recorded but not mailed', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: upsertOf([A]) });
  assert.equal((await submit(env, p)).status, 200);
  assert.equal(mailer.sent.length, 1);
  assert.ok(Date.parse(one(env, 'SELECT last_notified_at FROM projects').last_notified_at));
  await save(env, p.token, p.key, { upsert: upsertOf([B]) });
  assert.equal((await submit(env, p)).status, 200);
  assert.equal(submissionCount(env), 2, 'the submission row is always written');
  assert.equal(mailer.sent.length, 1);
  // at 9 minutes still quiet; at 10 the next changed submit mails
  await save(env, p.token, p.key, { delete: [A] });
  rewind(env, 9);
  await submit(env, p);
  assert.equal(mailer.sent.length, 1);
  await save(env, p.token, p.key, { upsert: upsertOf([A]) });
  rewind(env, 10);
  await submit(env, p);
  assert.equal(mailer.sent.length, 2);
  assert.equal(submissionCount(env), 4);
});

test('a submit with the same photos as the previous one is recorded but never mailed', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: upsertOf([A, B]) });
  await submit(env, p);
  rewind(env, 60);
  // a rating change and a note do not change the picked set
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 5, note: 'x' }] });
  assert.equal((await submit(env, p, { relationship: '朋友' })).status, 200);
  assert.equal(submissionCount(env), 2);
  assert.equal(mailer.sent.length, 1);
  // and a skipped email does not use up the slot
  await save(env, p.token, p.key, { delete: [B] });
  await submit(env, p);
  assert.equal(mailer.sent.length, 2);
});

test('the first submit with nothing picked still mails', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  await submit(env, p);
  assert.equal(mailer.sent.length, 1);
});

test('two concurrent changed submits send one email between them', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: upsertOf([A]) });
  const c = collectingCtx();
  const [r1, r2] = await Promise.all([
    pick(env, 'POST', 'submit', p.token, { key: p.key, body: { relationship: '本人' } }, c),
    pick(env, 'POST', 'submit', p.token, { key: p.key, body: { relationship: '朋友' } }, c),
  ]);
  await c.settle();
  assert.deepEqual([r1.status, r2.status], [200, 200]);
  assert.equal(submissionCount(env), 2);
  assert.equal(mailer.sent.length, 1);
});

test('the throttle is per project', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  const q = await claimed(env);
  await submit(env, p);
  await submit(env, q);
  assert.equal(mailer.sent.length, 2);
});

test('the send slot is claimed with one conditional UPDATE', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  await submit(env, p);
  const claims = env.DB._sql.filter(s => /UPDATE projects SET last_notified_at/i.test(s));
  assert.equal(claims.length, 1);
  assert.match(claims[0], /WHERE[^]*last_notified_at IS NULL OR last_notified_at <= \?/i);
});

// ─── 3b. compare with the last EMAILED submission; flag what was never mailed ─

const notifiedFlags = env => rows(env, 'SELECT notified FROM submissions ORDER BY rowid').map(r => r.notified);
const unnotified = async (env, id) => {
  const list = await (await call(env, '/api/admin/projects', { token: SECRET })).json();
  const detail = await (await call(env, `/api/admin/projects/${id}`, { token: SECRET })).json();
  const fromList = list.projects.find(x => x.id === id).unnotified_submissions;
  assert.equal(detail.unnotified_submissions, fromList, 'list and detail agree');
  return fromList;
};

test('a later email carries everything since the last email, not just since the last submit', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: upsertOf([A]) });
  await submit(env, p); // emailed: [A]
  await save(env, p.token, p.key, { upsert: upsertOf([B]) });
  await submit(env, p); // throttled: [A, B]
  assert.equal(mailer.sent.length, 1);
  rewind(env, 11);
  // same set as the previous submit, but not what the photographer was told
  await submit(env, p);
  assert.equal(mailer.sent.length, 2);
  assert.match(mailer.sent[1].text, /新增[^]*20260819\/b\.jpg/);
  assert.doesNotMatch(mailer.sent[1].text, /移除/);
});

test('a submit matching the last emailed set is not mailed, even if the previous submit differed', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: upsertOf([A]) });
  await submit(env, p); // emailed: [A]
  await save(env, p.token, p.key, { upsert: upsertOf([B]) });
  await submit(env, p); // throttled: [A, B]
  await save(env, p.token, p.key, { delete: [B] });
  rewind(env, 11);
  await submit(env, p); // [A] again: nothing new to tell
  assert.equal(mailer.sent.length, 1);
  assert.equal(submissionCount(env), 3);
});

test('each submission records whether it was emailed', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: upsertOf([A]) });
  await submit(env, p);
  await save(env, p.token, p.key, { upsert: upsertOf([B]) });
  await submit(env, p);
  assert.deepEqual(notifiedFlags(env), [1, 0]);
  await save(env, p.token, p.key, { delete: [A] });
  rewind(env, 11);
  await submit(env, p);
  assert.deepEqual(notifiedFlags(env), [1, 0, 1], 'only the emailed row is marked');
  env.DB._db.prepare('DELETE FROM submissions WHERE rowid = (SELECT MAX(rowid) FROM submissions)').run();
  const out = await (await call(env, `/api/admin/projects/${p.project.id}`, { token: SECRET })).json();
  assert.deepEqual(out.submissions.map(x => x.notified), [0, 1], 'newest first');
});

test('the baseline is an emailed submission from before this one, never one appended after it', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: upsertOf([A]) });
  await submit(env, p); // emailed: [A]
  rewind(env, 11);
  await save(env, p.token, p.key, { upsert: upsertOf([B]) });
  // an emailed row that lands after this submit's own row, before its read-back
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    if (/^\s*SELECT \* FROM submissions/i.test(sql)) {
      env.DB._db.prepare(`INSERT INTO submissions (id, project_id, picker_id, relationship, photo_keys, count, created_at, notified) VALUES ('late', ?, 'x', '本人', ?, 2, 'z', 1)`)
        .run(p.project.id, JSON.stringify([A, B]));
    }
    return prepare(sql);
  };
  await submit(env, p);
  assert.equal(mailer.sent.length, 2, 'compared with [A], not the late [A, B]');
  assert.match(mailer.sent[1].text, /新增[^]*20260819\/b\.jpg/);
});

test('a mailer that fails, or no mail setup, leaves the row unnotified', async () => {
  const env = setup({ NOTIFY_EMAIL: { async send() { throw new Error('down'); } }, PHOTOGRAPHER_EMAIL: 's@x.tw' });
  const p = await claimed(env);
  assert.equal((await submit(env, p)).status, 200);
  const bare = setup();
  const q = await claimed(bare);
  assert.equal((await submit(bare, q)).status, 200);
  assert.deepEqual([notifiedFlags(env), notifiedFlags(bare)], [[0], [0]]);
});

test('unnotified_submissions counts the submits newer than the last email, per project', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  const q = await claimed(env);
  assert.equal(await unnotified(env, p.project.id), 0);
  await save(env, p.token, p.key, { upsert: upsertOf([A]) });
  await submit(env, p);
  assert.equal(await unnotified(env, p.project.id), 0);
  await save(env, p.token, p.key, { upsert: upsertOf([B]) });
  await submit(env, p); // the burst's last submit lands inside the window
  assert.equal(await unnotified(env, p.project.id), 1);
  await submit(env, p); // unchanged: not mailed either
  assert.equal(await unnotified(env, p.project.id), 2);
  await submit(env, q); // another project's email does not clear this one's
  assert.equal(await unnotified(env, q.project.id), 0);
  assert.equal(await unnotified(env, p.project.id), 2);
  await save(env, p.token, p.key, { delete: [A] });
  rewind(env, 11);
  await submit(env, p);
  assert.equal(await unnotified(env, p.project.id), 0);
  assert.equal(mailer.sent.length, 3);
});

test('with no email ever sent, every submission is unnotified', async () => {
  const env = setup();
  const p = await claimed(env);
  await submit(env, p);
  await submit(env, p);
  assert.equal(await unnotified(env, p.project.id), 2);
});

// ─── 4. notes are the owner's ────────────────────────────────────────────────

test('state gives notes to the owner only; viewers see picks and ratings', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 5, note: '放大這張' }, { photo_key: B, rating: 0 }] });
  const st = async key => (await (await pick(env, 'GET', 'state', p.token, { key })).json()).selections;
  assert.deepEqual(await st(p.key), [
    { photo_key: A, rating: 5, note: '放大這張' },
    { photo_key: B, rating: 0, note: '' },
  ]);
  for (const key of [null, 'wrong']) {
    assert.deepEqual(await st(key), [{ photo_key: A, rating: 5 }, { photo_key: B, rating: 0 }], String(key));
  }
  // a key from before a seat reset is a viewer's
  await call(env, `/api/admin/projects/${p.project.id}/reset-seat`, { method: 'POST', token: SECRET });
  assert.deepEqual(await st(p.key), [{ photo_key: A, rating: 5 }, { photo_key: B, rating: 0 }]);
  // the photographer still sees them
  const out = await (await call(env, `/api/admin/projects/${p.project.id}`, { token: SECRET })).json();
  assert.equal(out.selections[0].note, '放大這張');
});

// ─── 5. re-minting a link ────────────────────────────────────────────────────

const links = (env, id, token = SECRET) => call(env, `/api/admin/projects/${id}/links`, { method: 'POST', token });
const detail = async (env, id) => (await call(env, `/api/admin/projects/${id}`, { token: SECRET })).json();

test('a new pick link for an existing project: same snapshot, fresh expiry, works for the project', async () => {
  const env = setup();
  const p = await claimed(env, { folders: [MINE, '20260901'] });
  const res = await links(env, p.project.id);
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.match(json.token, /^[A-Za-z0-9_-]{20,}$/);
  assert.notEqual(json.token, p.token);
  const row = one(env, 'SELECT * FROM share_tokens WHERE token = ?', json.token);
  assert.equal(row.kind, 'pick');
  assert.equal(row.project_id, p.project.id);
  assert.equal(row.book_id, '');
  assert.equal(row.folders, one(env, 'SELECT folders FROM projects').folders);
  assert.deepEqual(JSON.parse(row.folders), [MINE, '20260901/']);
  assert.equal(row.expires_at, json.expires_at);
  const ttl = Date.parse(row.expires_at) - Date.parse(row.created_at);
  assert.equal(ttl, 90 * 86400000);
  assert.ok(Math.abs(Date.parse(row.created_at) - Date.now()) < 5000);
  // the new link reaches the same project and the same seat
  const st = await (await pick(env, 'GET', 'state', json.token, { key: p.key })).json();
  assert.equal(st.project.id, p.project.id);
  assert.equal(st.is_owner, true);
  assert.equal((await save(env, json.token, p.key, { upsert: upsertOf([A]) })).status, 200);
});

test('the snapshot comes from the project, not from the old link or the body', async () => {
  const env = setup();
  const p = await createProject(env);
  env.DB._db.prepare('UPDATE share_tokens SET folders = ?').run(JSON.stringify(['20260901/']));
  const res = await call(env, `/api/admin/projects/${p.project.id}/links`, {
    method: 'POST', token: SECRET, body: { folders: ['20260901/'] },
  });
  const { token } = await res.json();
  assert.deepEqual(JSON.parse(one(env, 'SELECT folders FROM share_tokens WHERE token = ?', token).folders), [MINE]);
});

test('minting a link is admin-only and fails closed', async () => {
  const env = setup();
  const p = await claimed(env);
  assert.equal((await call(env, `/api/admin/projects/${p.project.id}/links`, { method: 'POST' })).status, 401);
  for (const token of ['wrong', p.token, p.key]) {
    assert.equal((await links(env, p.project.id, token)).status, 401, String(token));
  }
  assert.equal((await links({ ...env, PHOTOGRAPHER_TOKEN: undefined }, p.project.id, 'x')).status, 401);
  assert.equal((await links({ ...env, PHOTOGRAPHER_TOKEN: '' }, p.project.id, '')).status, 401);
  assert.equal((await links(env, 'nope')).status, 404);
  assert.equal(rows(env, 'SELECT * FROM share_tokens').length, 1);
  assert.notEqual((await call(env, `/api/admin/projects/${p.project.id}/links/x`, { method: 'POST', token: SECRET })).status, 201);
  assert.notEqual((await call(env, `/api/admin/projects/${p.project.id}/links`, { token: SECRET })).status, 201);
  assert.equal(rows(env, 'SELECT * FROM share_tokens').length, 1);
});

test('the project detail lists every pick link with its status; revoke kills the old one only', async () => {
  const env = setup();
  const p = await claimed(env);
  const { token: fresh } = await (await links(env, p.project.id)).json();
  assert.equal((await call(env, `/api/shares/${p.token}/revoke`, { method: 'POST', token: SECRET })).status, 200);
  assert.equal((await pick(env, 'GET', 'state', p.token)).status, 401);
  assert.equal((await pick(env, 'GET', 'state', fresh)).status, 200);
  // an expired one, and one past the 180-day ceiling
  env.DB._db.prepare(
    "INSERT INTO share_tokens (token, book_id, label, kind, project_id, folders, created_at, expires_at) VALUES ('old', '', '', 'pick', ?, '[]', ?, ?)"
  ).run(p.project.id, days(-100), days(-10));
  env.DB._db.prepare(
    "INSERT INTO share_tokens (token, book_id, label, kind, project_id, folders, created_at, expires_at) VALUES ('ceil', '', '', 'pick', ?, '[]', ?, ?)"
  ).run(p.project.id, days(-181), days(5));
  const out = await detail(env, p.project.id);
  const status = Object.fromEntries(out.tokens.map(t => [t.token, t.status]));
  assert.deepEqual(status, { [fresh]: 'live', [p.token]: 'revoked', old: 'expired', ceil: 'expired' });
  const revoked = out.tokens.find(t => t.token === p.token);
  assert.ok(revoked.revoked_at);
  // and the list shows the fresh one as the project's live link
  const list = await (await call(env, '/api/admin/projects', { token: SECRET })).json();
  assert.equal(list.projects[0].token, fresh);
});

// ─── 6. photographer_id on every admin project route ─────────────────────────

test('another photographer\'s project is 404 on every admin project route, and untouched', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: upsertOf([A]) });
  env.DB._db.prepare("UPDATE projects SET photographer_id = 'someone-else', phase = 'submitted'").run();
  const before = JSON.stringify([rows(env, 'SELECT * FROM projects'), rows(env, 'SELECT * FROM share_tokens')]);
  const id = p.project.id;
  assert.equal((await call(env, `/api/admin/projects/${id}`, { token: SECRET })).status, 404);
  for (const action of ['reset-seat', 'start-retouch', 'reopen', 'links']) {
    const res = await call(env, `/api/admin/projects/${id}/${action}`, { method: 'POST', token: SECRET });
    assert.equal(res.status, 404, action);
  }
  assert.equal(JSON.stringify([rows(env, 'SELECT * FROM projects'), rows(env, 'SELECT * FROM share_tokens')]), before);
  // start-retouch from picking on someone else's project is 404, not a 409 that leaks its phase
  env.DB._db.prepare("UPDATE projects SET phase = 'picking'").run();
  assert.equal((await call(env, `/api/admin/projects/${id}/start-retouch`, { method: 'POST', token: SECRET })).status, 404);
  // while this photographer's own project answers every route
  env.DB._db.prepare("UPDATE projects SET photographer_id = 'default', phase = 'submitted'").run();
  assert.equal((await call(env, `/api/admin/projects/${id}`, { token: SECRET })).status, 200);
  for (const [action, code] of [['links', 201], ['start-retouch', 200], ['reopen', 200], ['reset-seat', 200]]) {
    assert.equal((await call(env, `/api/admin/projects/${id}/${action}`, { method: 'POST', token: SECRET })).status, code, action);
  }
});
