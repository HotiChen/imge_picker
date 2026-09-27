// Guest picking, submission bounds: a project's `submissions` cannot grow
// without limit, and a notification that fails to send does not use up the
// ten-minute email slot.
//   - a submit whose picked set equals the latest submission's writes no row
//     and answers 200 with that latest submission (idempotent);
//   - at most PICK_MAX_SUBMISSIONS rows per project, checked inside the gated
//     INSERT; past it → 409 {code: 'submission_cap', max};
//   - the admin detail returns at most the newest PICK_MAX_SUBMISSIONS rows;
//   - a send that throws or fails gives the slot back, but only if nobody
//     else has taken it since.
// See docs/guest-picking.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECRET, setup, call, pick, claimed, save, one, rows, collectingCtx,
} from './pick-helpers.mjs';

const A = '20260819/a.jpg';
const B = '20260819/b.jpg';
const C = '20260819/c.jpg';
const MAX = 50; // PICK_MAX_SUBMISSIONS in worker.js

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
  return { res, json: await res.json() };
}

const submissionRows = env => rows(env, 'SELECT * FROM submissions ORDER BY rowid');
const star = (env, p, keys) => save(env, p.token, p.key, { upsert: keys.map(photo_key => ({ photo_key, rating: 1 })) });
const lastNotified = env => one(env, 'SELECT last_notified_at FROM projects').last_notified_at;

// n rows appended straight to the table, as if submitted long ago
function seedSubmissions(env, projectId, n, keys = []) {
  const ins = env.DB._db.prepare(
    "INSERT INTO submissions (id, project_id, picker_id, relationship, photo_keys, count, created_at, notified) VALUES (?, ?, 'x', '本人', ?, ?, ?, 1)"
  );
  for (let i = 0; i < n; i++) {
    ins.run(`seed-${projectId}-${i}`, projectId, JSON.stringify([...keys, `20260819/seed${i}.jpg`]), keys.length + 1,
      new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString());
  }
}

// ─── 1a. an unchanged resubmit is idempotent ─────────────────────────────────

test('a submit with the same picked set as the latest writes no row and returns that latest submission', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  await star(env, p, [A, B]);
  const first = await submit(env, p);
  assert.equal(first.res.status, 200);
  // a rating change and a note leave the picked set as it was
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 5, note: 'x' }] });
  const again = await submit(env, p, { relationship: '朋友', email: 'n@b.tw' });
  assert.equal(again.res.status, 200);
  assert.equal(submissionRows(env).length, 1, 'no new row');
  // the same shape the page reads, describing the submission already on file
  assert.deepEqual(again.json, first.json);
  assert.equal(again.json.submission_id, submissionRows(env)[0].id);
  assert.equal(again.json.submitted_at, submissionRows(env)[0].created_at);
  // the submit itself still counts: flag down, phase submitted, contact kept
  assert.deepEqual({ ...one(env, 'SELECT phase, modified_after_submit AS m FROM projects') }, { phase: 'submitted', m: 0 });
  const picker = one(env, 'SELECT relationship, email FROM pickers WHERE id = ?', p.pickerId);
  assert.deepEqual({ ...picker }, { relationship: '朋友', email: 'n@b.tw' });
});

test('after a reopen, an unchanged submit moves the project back to submitted without a new row', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  await star(env, p, [A]);
  await submit(env, p);
  await call(env, `/api/admin/projects/${p.project.id}/reopen`, { method: 'POST', token: SECRET });
  assert.equal(one(env, 'SELECT phase FROM projects').phase, 'picking');
  assert.equal((await submit(env, p)).res.status, 200);
  assert.equal(one(env, 'SELECT phase FROM projects').phase, 'submitted');
  assert.equal(submissionRows(env).length, 1);
});

test('a changed set, even one that only differs from the latest, still appends a row', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  await star(env, p, [A]);
  await submit(env, p);
  await star(env, p, [B]);
  const { json } = await submit(env, p);
  assert.equal(submissionRows(env).length, 2);
  // back to [A]: equal to an older row but not the latest, so it is recorded
  await save(env, p.token, p.key, { delete: [B] });
  const back = await submit(env, p);
  assert.equal(submissionRows(env).length, 3);
  assert.notEqual(back.json.submission_id, json.submission_id);
});

test('an empty first submit is recorded; an empty second one is not', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  await submit(env, p);
  assert.equal(submissionRows(env).length, 1);
  await submit(env, p);
  assert.equal(submissionRows(env).length, 1);
});

test('the latest submission is compared inside the INSERT, not only by a read before it', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  await star(env, p, [A]);
  await submit(env, p);
  await star(env, p, [B]);
  // a submission with the [A, B] set lands after the route's reads, just
  // before its INSERT: this submit is then a repeat of it
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    if (/^\s*INSERT INTO submissions/i.test(sql)) {
      env.DB._db.prepare("INSERT INTO submissions (id, project_id, picker_id, relationship, photo_keys, count, created_at) VALUES ('late', ?, 'x', '本人', ?, 2, 'z')")
        .run(p.project.id, JSON.stringify([A, B]));
    }
    return prepare(sql);
  };
  const { res, json } = await submit(env, p);
  assert.equal(res.status, 200);
  assert.equal(submissionRows(env).length, 2);
  assert.equal(json.submission_id, 'late');
});

test('an unchanged resubmit of a submission that was never emailed mails it once the window has passed', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  await star(env, p, [A]);
  await submit(env, p); // emailed
  await star(env, p, [B]);
  await submit(env, p); // throttled: [A, B] never mailed
  assert.equal(mailer.sent.length, 1);
  env.DB._db.prepare('UPDATE projects SET last_notified_at = ?').run(new Date(Date.now() - 11 * 60000).toISOString());
  await submit(env, p); // same set as the latest: no row, but the photographer was never told
  assert.equal(submissionRows(env).length, 2);
  assert.equal(mailer.sent.length, 2);
  assert.match(mailer.sent[1].text, /新增[^]*20260819\/b\.jpg/);
  assert.deepEqual(submissionRows(env).map(r => r.notified), [1, 1]);
  // and once it has been mailed, a further repeat is quiet
  env.DB._db.prepare('UPDATE projects SET last_notified_at = NULL').run();
  await submit(env, p);
  assert.equal(mailer.sent.length, 2);
});

// ─── 1b. at most PICK_MAX_SUBMISSIONS rows per project ───────────────────────

test(`a project holds at most ${MAX} submissions; past that a changed submit is 409 submission_cap`, async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  seedSubmissions(env, p.project.id, MAX - 1);
  await star(env, p, [A]);
  assert.equal((await submit(env, p)).res.status, 200, `row ${MAX} is allowed`);
  assert.equal(submissionRows(env).length, MAX);
  const sentBefore = mailer.sent.length;
  await star(env, p, [B]);
  assert.equal(one(env, 'SELECT modified_after_submit AS m FROM projects').m, 1);
  const { res, json } = await submit(env, p, { relationship: '朋友', email: 'x@y.tw' });
  assert.equal(res.status, 409);
  assert.equal(json.code, 'submission_cap');
  assert.equal(json.max, MAX);
  assert.equal(typeof json.error, 'string');
  assert.ok(json.error.length > 0);
  // nothing the submit would write landed
  assert.equal(submissionRows(env).length, MAX);
  assert.equal(one(env, 'SELECT modified_after_submit AS m FROM projects').m, 1, 'the flag stays up');
  assert.notEqual(one(env, 'SELECT relationship FROM pickers WHERE id = ?', p.pickerId).relationship, '朋友');
  assert.equal(mailer.sent.length, sentBefore);
});

test('at the cap, an unchanged submit is still a 200 repeat', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  seedSubmissions(env, p.project.id, MAX - 1);
  await star(env, p, [A]);
  await submit(env, p);
  const { res } = await submit(env, p);
  assert.equal(res.status, 200);
  assert.equal(submissionRows(env).length, MAX);
});

test('the submission cap counts only this project', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  const q = await claimed(env);
  seedSubmissions(env, q.project.id, MAX);
  await star(env, p, [A]);
  assert.equal((await submit(env, p)).res.status, 200);
});

test('the submission cap is enforced inside the INSERT, not only by a read before it', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  seedSubmissions(env, p.project.id, MAX - 1);
  await star(env, p, [A]);
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    if (/^\s*INSERT INTO submissions/i.test(sql)) {
      env.DB._db.prepare("INSERT INTO submissions (id, project_id, picker_id, relationship, photo_keys, count, created_at) VALUES ('late', ?, 'x', '本人', '[]', 0, 'z')")
        .run(p.project.id);
    }
    return prepare(sql);
  };
  const { res, json } = await submit(env, p);
  assert.equal(res.status, 409);
  assert.equal(json.code, 'submission_cap');
  assert.equal(submissionRows(env).length, MAX);
  assert.equal(one(env, 'SELECT phase FROM projects').phase, 'picking', 'the phase did not move');
});

test('over the cap, a viewer still gets 403 and retouching still 409 retouching', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  seedSubmissions(env, p.project.id, MAX);
  await star(env, p, [A]);
  const viewer = await pick(env, 'POST', 'submit', p.token, { key: 'wrong', body: { relationship: '本人' } });
  assert.equal(viewer.status, 403);
  env.DB._db.prepare("UPDATE projects SET phase = 'retouching'").run();
  const { res, json } = await submit(env, p);
  assert.equal(res.status, 409);
  assert.equal(json.code, 'retouching');
});

// ─── 1c. the admin detail is bounded too ─────────────────────────────────────

test(`the project detail returns only the newest ${MAX} submissions, with a LIMIT in the query`, async () => {
  const env = mailEnv();
  const p = await claimed(env);
  seedSubmissions(env, p.project.id, MAX + 10);
  const out = await (await call(env, `/api/admin/projects/${p.project.id}`, { token: SECRET })).json();
  assert.equal(out.submissions.length, MAX);
  assert.equal(out.submissions[0].id, `seed-${p.project.id}-${MAX + 9}`, 'newest first');
  assert.equal(out.submissions[MAX - 1].id, `seed-${p.project.id}-10`);
  const reads = env.DB._sql.filter(s => /FROM submissions WHERE project_id = \?/i.test(s) && /photo_keys/.test(s) && /^\s*SELECT/i.test(s));
  assert.ok(reads.length >= 1);
  for (const s of reads) assert.match(s, /LIMIT/i);
});

// ─── 2. a failed send gives the slot back ────────────────────────────────────

test('a mailer that throws once does not burn the slot: the next changed submit inside ten minutes still emails', async () => {
  let fail = true;
  const sent = [];
  const env = mailEnv({ sent, async send(msg) { if (fail) { fail = false; throw new Error('smtp down'); } sent.push(msg); } });
  const p = await claimed(env);
  await star(env, p, [A]);
  await submit(env, p);
  assert.equal(sent.length, 0);
  assert.equal(lastNotified(env), null, 'restored to what it was');
  await star(env, p, [B]);
  await submit(env, p);
  assert.equal(sent.length, 1);
  assert.ok(Date.parse(lastNotified(env)));
  // it compares with the last EMAILED submission — none — so it is a first email
  assert.doesNotMatch(sent[0].text, /新增|移除/);
});

test('a failed send restores the previous last_notified_at, not NULL', async () => {
  const env = mailEnv({ async send() { throw new Error('down'); } });
  const p = await claimed(env);
  const old = new Date(Date.now() - 30 * 60000).toISOString();
  env.DB._db.prepare('UPDATE projects SET last_notified_at = ?').run(old);
  await submit(env, p);
  assert.equal(lastNotified(env), old);
});

test('a send that reports failure (no photographer address) gives the slot back too', async () => {
  const env = setup({ NOTIFY_EMAIL: fakeMailer() });
  const p = await claimed(env);
  await submit(env, p);
  assert.equal(lastNotified(env), null);
});

test('the slot is only given back if nobody has taken it since', async () => {
  const theirs = new Date(Date.now() + 1000).toISOString();
  const env = mailEnv({
    async send() {
      // another submit's claim lands while this send is failing
      env.DB._db.prepare('UPDATE projects SET last_notified_at = ?').run(theirs);
      throw new Error('down');
    },
  });
  const p = await claimed(env);
  await submit(env, p);
  assert.equal(lastNotified(env), theirs);
  const releases = env.DB._sql.filter(s => /^\s*UPDATE projects SET last_notified_at/i.test(s));
  assert.equal(releases.length, 2, 'one claim, one conditional release');
  assert.match(releases[1], /WHERE[^]*last_notified_at = \?/i);
});

test('a successful send keeps the slot', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  await submit(env, p);
  const at = lastNotified(env);
  assert.ok(Date.parse(at));
  await star(env, p, [C]);
  await submit(env, p);
  assert.equal(mailer.sent.length, 1, 'still inside the window');
  assert.equal(lastNotified(env), at);
});
