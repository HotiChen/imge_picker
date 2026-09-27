// Guest picking, phase A2: a project moves picking → submitted → retouching.
// The owner may save in picking and submitted (a save after a submit raises
// modified_after_submit, and sends nothing); every submit appends one row to
// `submissions` and emails the photographer the diff against the one before;
// in retouching nothing the guest does writes. The photographer moves the
// phase with two admin routes. See docs/guest-picking.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECRET, setup, call, pick, claim, claimed, save, one, rows, seedToken, collectingCtx,
} from './pick-helpers.mjs';

const A = '20260819/a.jpg';
const B = '20260819/b.jpg';
const C = '20260819/c.jpg';

function fakeMailer() {
  const sent = [];
  return { sent, async send(msg) { sent.push(msg); return { messageId: 'm' }; } };
}
const mailEnv = (mailer = fakeMailer()) =>
  setup({ NOTIFY_EMAIL: mailer, PHOTOGRAPHER_EMAIL: 'studio@example.com' });

async function submit(env, p, body = { relationship: '本人' }, key = p.key) {
  const c = collectingCtx();
  const res = await pick(env, 'POST', 'submit', p.token, { key, body }, c);
  await c.settle();
  return { res, json: await res.json() };
}

const admin = (env, id, action, token = SECRET) =>
  call(env, `/api/admin/projects/${id}/${action}`, { method: 'POST', token });
const phaseOf = env => one(env, 'SELECT phase, modified_after_submit AS m FROM projects');
const submissions = env => rows(env, 'SELECT * FROM submissions ORDER BY rowid');
const selectionRows = env => rows(env, 'SELECT photo_key, rating, note FROM selections ORDER BY photo_key');

// makes `sql` run the moment the Worker prepares a statement matching `re` —
// after every read the route does, before the write itself executes
function landBefore(env, re, sql) {
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = s => {
    if (re.test(s)) env.DB._db.prepare(sql).run();
    return prepare(s);
  };
}

// ─── schema ──────────────────────────────────────────────────────────────────

test('a new project is picking, unmodified, with no submissions', async () => {
  const env = setup();
  const p = await claimed(env);
  assert.deepEqual({ ...phaseOf(env) }, { phase: 'picking', m: 0 });
  assert.equal(submissions(env).length, 0);
});

test('phase only takes the three values the design names', () => {
  const env = setup();
  env.DB._db.prepare("INSERT INTO projects (id, folders, created_at) VALUES ('p', '[]', 'now')").run();
  assert.equal(one(env, "SELECT phase FROM projects WHERE id = 'p'").phase, 'picking');
  assert.throws(() => env.DB._db.prepare("UPDATE projects SET phase = 'done'").run(), /CHECK/);
});

test('the submit snapshot lives in submissions, not on pickers', () => {
  const env = setup();
  const cols = rows(env, 'PRAGMA table_info(pickers)').map(c => c.name);
  for (const gone of ['submit_count', 'submit_limit', 'submit_price']) assert.ok(!cols.includes(gone), gone);
  assert.deepEqual(rows(env, 'PRAGMA table_info(submissions)').map(c => c.name), [
    'id', 'project_id', 'picker_id', 'relationship', 'email', 'photo_keys', 'count', 'pick_limit', 'extra_price', 'created_at',
  ]);
});

// ─── submit ──────────────────────────────────────────────────────────────────

test('a submit from picking appends a snapshot row and moves the project to submitted', async () => {
  const env = mailEnv();
  const p = await claimed(env, { pick_limit: 1, extra_price: 150 });
  await save(env, p.token, p.key, { upsert: [
    { photo_key: C, rating: 2 }, { photo_key: A, rating: 1 }, { photo_key: B, rating: 0, note: '只留言' },
  ] });
  const { res, json } = await submit(env, p, { relationship: '伴侶', email: ' g@b.tw ' });
  assert.equal(res.status, 200);
  assert.equal(json.phase, 'submitted');
  assert.equal(json.count, 2);
  assert.equal(json.over, 1);
  assert.deepEqual({ ...phaseOf(env) }, { phase: 'submitted', m: 0 });
  const [s] = submissions(env);
  assert.equal(submissions(env).length, 1);
  assert.equal(s.project_id, p.project.id);
  assert.equal(s.picker_id, p.pickerId);
  assert.equal(s.relationship, '伴侶');
  assert.equal(s.email, 'g@b.tw');
  assert.deepEqual(JSON.parse(s.photo_keys), [A, C], 'only rated photos, in key order');
  assert.equal(s.count, 2);
  assert.equal(s.pick_limit, 1);
  assert.equal(s.extra_price, 150);
  assert.ok(Date.parse(s.created_at));
  assert.equal(json.submitted_at, s.created_at);
  // relationship and email stay on the picker as the latest contact info
  const picker = one(env, 'SELECT relationship, email FROM pickers');
  assert.deepEqual({ ...picker }, { relationship: '伴侶', email: 'g@b.tw' });
  // a snapshot: changing the plan later rewrites nothing
  env.DB._db.prepare('UPDATE projects SET pick_limit = 9, extra_price = 9').run();
  assert.deepEqual({ ...submissions(env)[0] }, { ...s });
});

test('a submit with nothing picked records an empty list', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  const { res, json } = await submit(env, p);
  assert.equal(res.status, 200);
  assert.equal(json.count, 0);
  assert.deepEqual(JSON.parse(submissions(env)[0].photo_keys), []);
});

test('submitting again appends a new row and never rewrites the old one', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  await submit(env, p, { relationship: '本人' });
  const first = { ...submissions(env)[0] };
  await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 3 }] });
  assert.equal(phaseOf(env).m, 1);
  const { res } = await submit(env, p, { relationship: '朋友', email: 'x@y.tw' });
  assert.equal(res.status, 200);
  const all = submissions(env);
  assert.equal(all.length, 2);
  assert.deepEqual({ ...all[0] }, first);
  assert.deepEqual(JSON.parse(all[1].photo_keys), [A, B]);
  assert.equal(all[1].relationship, '朋友');
  assert.notEqual(all[1].id, all[0].id);
  assert.deepEqual({ ...phaseOf(env) }, { phase: 'submitted', m: 0 }, 'a resubmit clears the flag');
});

test('the resubmit email lists what was added and removed since the last submit', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }, { photo_key: B, rating: 1 }] });
  await submit(env, p);
  assert.equal(mailer.sent.length, 1);
  for (const part of [mailer.sent[0].text, mailer.sent[0].html]) {
    assert.doesNotMatch(part, /新增|移除|與上次相同/, 'nothing to compare the first submit with');
  }
  await save(env, p.token, p.key, { upsert: [{ photo_key: C, rating: 2 }, { photo_key: A, rating: 0 }] });
  assert.equal(mailer.sent.length, 1, 'a save sends nothing');
  await submit(env, p);
  assert.equal(mailer.sent.length, 2);
  const { text, html } = mailer.sent[1];
  for (const part of [text, html]) {
    assert.match(part, /新增[^]*20260819\/c\.jpg/);
    assert.match(part, /移除[^]*20260819\/a\.jpg/);
    assert.doesNotMatch(part, /20260819\/b\.jpg/, 'unchanged photos are not listed');
  }
  // added comes before removed, so each key sits under its own heading
  assert.ok(text.indexOf('20260819/c.jpg') < text.indexOf('移除'));
  assert.ok(text.indexOf('20260819/a.jpg') > text.indexOf('移除'));
});

test('a resubmit with nothing changed says so rather than listing nothing', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  await submit(env, p);
  await submit(env, p);
  assert.match(mailer.sent[1].text, /與上次相同/);
  assert.doesNotMatch(mailer.sent[1].text, /新增|移除/);
});

test('the diff compares with the previous submission even when someone else made it', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  await submit(env, p);
  await admin(env, p.project.id, 'reset-seat');
  const { key } = await claim(env, p.token, '王太太');
  await save(env, p.token, key, { upsert: [{ photo_key: B, rating: 1 }] });
  await submit(env, { ...p, key });
  assert.match(mailer.sent[1].text, /新增[^]*20260819\/b\.jpg/);
  assert.doesNotMatch(mailer.sent[1].text, /移除/);
});

test('photo keys in the diff are HTML-escaped', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  const evilIn = '20260819/<img src=x onerror=alert(1)>.jpg';
  const evilOut = '20260819/"><svg onload=alert(2)>.jpg';
  await save(env, p.token, p.key, { upsert: [{ photo_key: evilOut, rating: 1 }] });
  await submit(env, p);
  await save(env, p.token, p.key, { upsert: [{ photo_key: evilIn, rating: 1 }], delete: [evilOut] });
  await submit(env, p);
  const { html } = mailer.sent[1];
  assert.doesNotMatch(html, /<img|<svg/i);
  assert.match(html, /20260819\/&lt;img src=x onerror=alert\(1\)&gt;\.jpg/);
  assert.match(html, /20260819\/&quot;&gt;&lt;svg onload=alert\(2\)&gt;\.jpg/);
});

// ─── saving after a submit ───────────────────────────────────────────────────

test('a save while submitted raises modified_after_submit and sends nothing; in picking it does not', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  assert.equal(phaseOf(env).m, 0, 'saving before any submit is not a change after one');
  await submit(env, p);
  const up = await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 1 }] });
  assert.equal(up.status, 200);
  assert.deepEqual({ ...phaseOf(env) }, { phase: 'submitted', m: 1 });
  assert.equal(mailer.sent.length, 1);
  assert.equal(submissions(env).length, 1);
});

test('a delete-only save while submitted raises the flag too', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  await submit(env, p);
  assert.equal((await save(env, p.token, p.key, { delete: [A] })).status, 200);
  assert.equal(phaseOf(env).m, 1);
  assert.equal(selectionRows(env).length, 0);
});

test('an empty save changes nothing, not even the flag', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  await submit(env, p);
  assert.equal((await save(env, p.token, p.key, {})).status, 200);
  assert.equal(phaseOf(env).m, 0);
});

test('a viewer\'s refused save while submitted does not raise the flag', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  await submit(env, p);
  assert.equal((await save(env, p.token, 'wrong', { upsert: [{ photo_key: A, rating: 1 }] })).status, 403);
  assert.equal(phaseOf(env).m, 0);
});

// ─── retouching ──────────────────────────────────────────────────────────────

async function retouching(env) {
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  await submit(env, p);
  assert.equal((await admin(env, p.project.id, 'start-retouch')).status, 200);
  return p;
}

test('in retouching the owner can neither save nor submit: 409 retouching', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await retouching(env);
  const before = JSON.stringify([selectionRows(env), submissions(env), phaseOf(env)]);
  for (const body of [{ upsert: [{ photo_key: B, rating: 1 }] }, { delete: [A] }, { upsert: [{ photo_key: A, rating: 5 }], delete: [A] }]) {
    const res = await save(env, p.token, p.key, body);
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal((await res.json()).code, 'retouching');
  }
  const { res, json } = await submit(env, p);
  assert.equal(res.status, 409);
  assert.equal(json.code, 'retouching');
  assert.equal(JSON.stringify([selectionRows(env), submissions(env), phaseOf(env)]), before);
  assert.equal(mailer.sent.length, 1, 'only the first submit mailed');
});

test('in retouching the phase is the answer even to a malformed request', async () => {
  const env = mailEnv();
  const p = await retouching(env);
  const bad = await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 99 }] });
  assert.equal(bad.status, 409);
  assert.equal((await submit(env, p, { relationship: '同事' })).res.status, 409);
});

test('a viewer in retouching still gets 403, not a hint about the phase', async () => {
  const env = mailEnv();
  const p = await retouching(env);
  assert.equal((await save(env, p.token, 'x', { upsert: [{ photo_key: B, rating: 1 }] })).status, 403);
  assert.equal((await submit(env, p, undefined, 'x')).res.status, 403);
});

// the phase is re-checked inside the write itself: a start-retouch that lands
// after every read the route does still wins
for (const [what, re, body] of [
  ['upsert', /^\s*INSERT INTO selections/i, { upsert: [{ photo_key: B, rating: 1 }] }],
  ['delete', /^\s*DELETE FROM selections/i, { delete: [A] }],
  ['upsert+delete', /^\s*INSERT INTO selections/i, { upsert: [{ photo_key: B, rating: 1 }], delete: [A] }],
  ['upsert+delete, late', /^\s*DELETE FROM selections/i, { upsert: [{ photo_key: B, rating: 1 }], delete: [A] }],
]) {
  test(`a start-retouch landing mid-save wins (${what})`, async () => {
    const env = mailEnv();
    const p = await claimed(env);
    await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
    await submit(env, p);
    landBefore(env, re, "UPDATE projects SET phase = 'retouching'");
    const res = await save(env, p.token, p.key, body);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'retouching');
    assert.deepEqual(selectionRows(env).map(s => s.photo_key), [A], 'nothing written');
    assert.deepEqual({ ...phaseOf(env) }, { phase: 'retouching', m: 0 }, 'flag not raised');
  });
}

test('a start-retouch landing mid-submit wins: no row, no email', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  await submit(env, p);
  landBefore(env, /^\s*INSERT INTO submissions/i, "UPDATE projects SET phase = 'retouching'");
  const { res, json } = await submit(env, p, { relationship: '朋友' });
  assert.equal(res.status, 409);
  assert.equal(json.code, 'retouching');
  assert.equal(submissions(env).length, 1);
  assert.equal(phaseOf(env).phase, 'retouching');
  assert.equal(one(env, 'SELECT relationship FROM pickers').relationship, '本人', 'contact info untouched');
  assert.equal(mailer.sent.length, 1);
});

test('a seat reset landing mid-submit wins: 403, no row, no email, phase unchanged', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  landBefore(env, /^\s*INSERT INTO submissions/i, 'UPDATE projects SET owner_picker_id = NULL');
  const { res } = await submit(env, p);
  assert.equal(res.status, 403);
  assert.equal(submissions(env).length, 0);
  assert.equal(phaseOf(env).phase, 'picking');
  assert.equal(one(env, 'SELECT relationship FROM pickers').relationship, null);
  assert.equal(mailer.sent.length, 0);
});

test('a seat reset landing mid-save while submitted leaves the flag down', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  await submit(env, p);
  landBefore(env, /^\s*INSERT INTO selections/i, 'UPDATE projects SET owner_picker_id = NULL');
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 1 }] })).status, 403);
  assert.equal(phaseOf(env).m, 0);
  assert.equal(selectionRows(env).length, 0);
});

// ─── admin: start-retouch and reopen ─────────────────────────────────────────

for (const action of ['start-retouch', 'reopen']) {
  test(`${action} is admin-only and fails closed`, async () => {
    const env = mailEnv();
    const p = await claimed(env);
    await submit(env, p);
    for (const [token, kind] of [['CLIENT', 'client'], ['STUDIO', 'studio'], ['SESSION', 'session']]) {
      await seedToken(env, { token, kind, project_id: p.project.id, book_id: kind === 'client' ? 'b1' : '' });
    }
    const path = `/api/admin/projects/${p.project.id}/${action}`;
    const tries = [
      call(env, path, { method: 'POST' }),
      call(env, path, { method: 'POST', token: 'wrong' }),
      call(env, path, { method: 'POST', token: p.token }),
      call(env, path, { method: 'POST', token: p.key }),
      call(env, `${path}?t=${p.token}`, { method: 'POST', key: p.key }),
      call(env, path, { method: 'POST', headers: { 'X-Share-Token': p.token } }),
      call(env, path, { method: 'POST', token: 'CLIENT' }),
      call(env, path, { method: 'POST', token: 'STUDIO' }),
      call(env, path, { method: 'POST', token: 'SESSION' }),
      call(env, `${path}?t=STUDIO`, { method: 'POST' }),
    ];
    for (const res of await Promise.all(tries)) assert.equal(res.status, 401);
    const unset = { ...env, PHOTOGRAPHER_TOKEN: undefined };
    assert.equal((await call(unset, path, { method: 'POST', token: 'anything' })).status, 401);
    assert.equal((await call(unset, path, { method: 'POST', token: '' })).status, 401);
    assert.deepEqual({ ...phaseOf(env) }, { phase: 'submitted', m: 0 });
    assert.equal((await admin(env, 'nope', action)).status, 404);
  });
}

test('the phase routes take no extra path segment', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  await submit(env, p);
  for (const action of ['start-retouch/x', 'reopen/x']) {
    assert.notEqual((await admin(env, p.project.id, action)).status, 200, action);
  }
  assert.equal(phaseOf(env).phase, 'submitted');
});

test('start-retouch moves submitted to retouching and keeps the flag for the photographer', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  await submit(env, p);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  const res = await admin(env, p.project.id, 'start-retouch');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).phase, 'retouching');
  assert.deepEqual({ ...phaseOf(env) }, { phase: 'retouching', m: 1 });
  // a second press is harmless
  assert.equal((await admin(env, p.project.id, 'start-retouch')).status, 200);
  assert.equal(phaseOf(env).phase, 'retouching');
});

test('start-retouch from picking is refused: nothing has been submitted', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  const res = await admin(env, p.project.id, 'start-retouch');
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'not_submitted');
  assert.equal(phaseOf(env).phase, 'picking');
});

test('start-retouch after a reopen is refused until the guest submits again', async () => {
  const env = mailEnv();
  const p = await retouching(env);
  await admin(env, p.project.id, 'reopen');
  assert.equal((await admin(env, p.project.id, 'start-retouch')).status, 409);
  await submit(env, p);
  assert.equal((await admin(env, p.project.id, 'start-retouch')).status, 200);
});

test('reopen moves retouching back to picking, keeping every submission and pick', async () => {
  const env = mailEnv();
  const p = await retouching(env);
  env.DB._db.prepare('UPDATE projects SET modified_after_submit = 1').run();
  const res = await admin(env, p.project.id, 'reopen');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).phase, 'picking');
  assert.deepEqual({ ...phaseOf(env) }, { phase: 'picking', m: 0 });
  assert.equal(submissions(env).length, 1);
  assert.equal(selectionRows(env).length, 1);
  // and the owner can pick again
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 1 }] })).status, 200);
  assert.equal(phaseOf(env).m, 0);
  assert.equal((await submit(env, p)).res.status, 200);
  assert.equal(submissions(env).length, 2);
});

test('reopen moves submitted back to picking and clears the flag', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  await submit(env, p);
  await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 1 }] });
  assert.equal((await admin(env, p.project.id, 'reopen')).status, 200);
  assert.deepEqual({ ...phaseOf(env) }, { phase: 'picking', m: 0 });
  // already picking: harmless
  assert.equal((await admin(env, p.project.id, 'reopen')).status, 200);
  assert.equal(phaseOf(env).phase, 'picking');
});

test('the phase routes touch only their own project', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  const q = await claimed(env);
  await submit(env, p);
  await submit(env, q);
  await admin(env, p.project.id, 'start-retouch');
  assert.equal(one(env, 'SELECT phase FROM projects WHERE id = ?', q.project.id).phase, 'submitted');
  await admin(env, p.project.id, 'reopen');
  await admin(env, q.project.id, 'start-retouch');
  assert.equal(one(env, 'SELECT phase FROM projects WHERE id = ?', p.project.id).phase, 'picking');
});

test('reset-seat keeps the phase and every submission', async () => {
  const env = mailEnv();
  const p = await retouching(env);
  assert.equal((await admin(env, p.project.id, 'reset-seat')).status, 200);
  assert.equal(phaseOf(env).phase, 'retouching');
  assert.equal(submissions(env).length, 1);
});

// ─── reading the phase back ──────────────────────────────────────────────────

test('the photographer sees phase, flag and every submission newest first', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  await submit(env, p, { relationship: '本人' });
  await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 1 }] });
  await submit(env, p, { relationship: '朋友' });
  await save(env, p.token, p.key, { delete: [A] });
  const out = await (await call(env, `/api/admin/projects/${p.project.id}`, { token: SECRET })).json();
  assert.equal(out.project.phase, 'submitted');
  assert.equal(out.project.modified_after_submit, 1);
  assert.equal(out.submissions.length, 2);
  assert.equal(out.submissions[0].relationship, '朋友', 'newest first');
  assert.deepEqual(out.submissions[0].photo_keys, [A, B], 'parsed, not a JSON string');
  assert.deepEqual(out.submissions[1].photo_keys, [A]);
  assert.equal(out.submissions[1].picker_id, p.pickerId);
  assert.equal(out.submissions[0].count, 2);
  assert.equal(out.submissions[0].pick_limit, 40);
  assert.equal(out.submissions[0].extra_price, 200);
  assert.ok(!('submit_count' in out.owner));
});

test('submissions newest first holds even when two land in the same millisecond', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  const realNow = Date.now;
  Date.now = () => 1790000000000;
  const RealDate = Date;
  globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [1790000000000])); } };
  globalThis.Date.now = Date.now;
  try {
    await submit(env, p, { relationship: '本人' });
    await submit(env, p, { relationship: '朋友' });
  } finally {
    globalThis.Date = RealDate;
    Date.now = realNow;
  }
  const out = await (await call(env, `/api/admin/projects/${p.project.id}`, { token: SECRET })).json();
  assert.equal(out.submissions[0].created_at, out.submissions[1].created_at);
  assert.equal(out.submissions[0].relationship, '朋友');
});

test('state tells the owner the phase and the flag, and a viewer only the phase', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  const st = async key => (await pick(env, 'GET', 'state', p.token, { key })).json();
  let mine = await st(p.key);
  assert.equal(mine.phase, 'picking');
  assert.equal(mine.modified_after_submit, 0);
  assert.equal(mine.submitted_at, null);
  const { json } = await submit(env, p);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  mine = await st(p.key);
  assert.equal(mine.phase, 'submitted');
  assert.equal(mine.modified_after_submit, 1);
  assert.equal(mine.submitted_at, json.submitted_at);
  const theirs = await st(null);
  assert.equal(theirs.phase, 'submitted');
  assert.ok(!('modified_after_submit' in theirs));
  assert.equal(theirs.submitted_at, null);
  await admin(env, p.project.id, 'start-retouch');
  assert.equal((await st(p.key)).phase, 'retouching');
  assert.equal((await st('wrong')).phase, 'retouching');
});

test('the diff is against the submission before this one, even if another lands meanwhile', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  await submit(env, p);
  // a submission appended after this submit's own row, before its read-back
  landBefore(env, /^\s*SELECT \* FROM submissions/i,
    `INSERT INTO submissions (id, project_id, picker_id, relationship, photo_keys, count, created_at) VALUES ('late', '${p.project.id}', 'x', '本人', '["${C}"]', 1, 'z')`);
  await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 1 }] });
  await submit(env, p);
  const { text } = mailer.sent[1];
  assert.match(text, /新增[^]*20260819\/b\.jpg/);
  assert.doesNotMatch(text, /移除|c\.jpg/);
});

test('the photographer sees only this project\'s submissions', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  const q = await claimed(env);
  await submit(env, p);
  await submit(env, q);
  await submit(env, q);
  const out = await (await call(env, `/api/admin/projects/${p.project.id}`, { token: SECRET })).json();
  assert.equal(out.submissions.length, 1);
  assert.equal(out.submissions[0].picker_id, p.pickerId);
});
