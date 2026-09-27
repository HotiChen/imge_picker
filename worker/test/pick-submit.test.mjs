// Guest picking: submitting. The owner says who they are to the couple
// (relationship, required) and optionally leaves an email; the Worker records
// the count, limit and price as they stood — the record any extra-photo fee is
// charged from — and emails the photographer. Over the limit is a warning,
// never a block. An email that fails must not fail the submit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECRET, setup, call, pick, claim, claimed, save, one, rows, seedToken, days, collectingCtx,
} from './pick-helpers.mjs';

const RELATIONSHIPS = ['本人', '伴侶', '家人', '朋友', '其他'];

function fakeMailer({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    async send(msg) {
      if (fail) throw new Error('smtp down');
      sent.push(msg);
      return { messageId: 'm1' };
    },
  };
}

function mailEnv(mailer = fakeMailer(), extra = {}) {
  return setup({ NOTIFY_EMAIL: mailer, PHOTOGRAPHER_EMAIL: 'studio@example.com', ...extra });
}

// key: omitted = the owner's own; null = no key header at all
async function submit(env, p, body, key) {
  if (key === undefined) key = p.key;
  const c = collectingCtx();
  const res = await pick(env, 'POST', 'submit', p.token, { key, body }, c);
  await c.settle();
  return { res, json: await res.json() };
}

const picks = (env, p, n, rating = 3) =>
  save(env, p.token, p.key, { upsert: Array.from({ length: n }, (_, i) => ({ photo_key: `20260819/p${i}.jpg`, rating })) });

test('a submit records the count, limit and price as they stood', async () => {
  const env = mailEnv();
  const p = await claimed(env, { pick_limit: 40, extra_price: 200 });
  await picks(env, p, 3);
  const { res, json } = await submit(env, p, { relationship: '伴侶', email: ' a@b.tw ' });
  assert.equal(res.status, 200);
  assert.equal(json.count, 3);
  assert.equal(json.limit, 40);
  assert.equal(json.price, 200);
  assert.equal(json.over, 0);
  const picker = one(env, 'SELECT * FROM pickers');
  assert.equal(picker.relationship, '伴侶');
  assert.equal(picker.email, 'a@b.tw');
  const record = one(env, 'SELECT * FROM submissions');
  assert.equal(record.relationship, '伴侶');
  assert.equal(record.email, 'a@b.tw');
  assert.equal(record.count, 3);
  assert.equal(record.pick_limit, 40);
  assert.equal(record.extra_price, 200);
  assert.ok(record.created_at);

  // a snapshot: the photographer changing the plan later does not rewrite it
  env.DB._db.prepare('UPDATE projects SET pick_limit = 10, extra_price = 999').run();
  const after = one(env, 'SELECT * FROM submissions');
  assert.equal(after.pick_limit, 40);
  assert.equal(after.extra_price, 200);
});

test('over the limit is a warning, never a block', async () => {
  const env = mailEnv();
  const p = await claimed(env, { pick_limit: 2, extra_price: 150 });
  await picks(env, p, 5);
  const { res, json } = await submit(env, p, { relationship: '本人' });
  assert.equal(res.status, 200);
  assert.equal(json.count, 5);
  assert.equal(json.over, 3);
  assert.equal(one(env, 'SELECT count FROM submissions').count, 5);
});

test('exactly at the limit is not over it', async () => {
  const env = mailEnv();
  const p = await claimed(env, { pick_limit: 3 });
  await picks(env, p, 3);
  assert.equal((await submit(env, p, { relationship: '本人' })).json.over, 0);
});

test('with no limit nothing is ever over, and the snapshot says NULL', async () => {
  const env = mailEnv();
  const p = await claimed(env, { pick_limit: null, extra_price: null });
  await picks(env, p, 7);
  const { json } = await submit(env, p, { relationship: '家人' });
  assert.equal(json.limit, null);
  assert.equal(json.over, 0);
  const record = one(env, 'SELECT * FROM submissions');
  assert.equal(record.pick_limit, null);
  assert.equal(record.extra_price, null);
  assert.equal(record.email, null, 'email is optional');
});

test('only photos with at least one star are counted as picked', async () => {
  const env = mailEnv();
  const p = await claimed(env, { pick_limit: 1 });
  await save(env, p.token, p.key, {
    upsert: [{ photo_key: '20260819/a.jpg', rating: 0, note: '只留言' }, { photo_key: '20260819/b.jpg', rating: 1 }],
  });
  assert.equal((await submit(env, p, { relationship: '本人' })).json.count, 1);
});

test('a later submit adds a record with the new count', async () => {
  const env = mailEnv();
  const p = await claimed(env, { pick_limit: 10 });
  await picks(env, p, 2);
  await submit(env, p, { relationship: '本人' });
  await picks(env, p, 4);
  const { json } = await submit(env, p, { relationship: '朋友' });
  assert.equal(json.count, 4);
  const records = rows(env, 'SELECT * FROM submissions ORDER BY rowid');
  assert.deepEqual(records.map(r => r.count), [2, 4]);
  assert.equal(one(env, 'SELECT relationship FROM pickers').relationship, '朋友');
});

// ─── Rule 7: relationship and email ──────────────────────────────────────────

test('relationship is required and must be one of the five', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  for (const body of [{}, { relationship: '' }, { relationship: '同事' }, { relationship: ' 本人 ' }, { relationship: 1 }, 'x']) {
    const { res } = await submit(env, p, body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(rows(env, 'SELECT * FROM submissions').length, 0);
  for (const relationship of RELATIONSHIPS) {
    assert.equal((await submit(env, p, { relationship })).res.status, 200, relationship);
  }
});

test('email is at most 254 characters and must look like an address', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  const at254 = 'a'.repeat(254 - '@b.tw'.length) + '@b.tw';
  for (const email of [at254 + 'x', 'no-at-sign', 'a b@c.tw', 7, ['a@b.tw']]) {
    const { res } = await submit(env, p, { relationship: '本人', email });
    assert.equal(res.status, 400, JSON.stringify(email));
  }
  assert.equal(rows(env, 'SELECT * FROM submissions').length, 0);
  assert.equal((await submit(env, p, { relationship: '本人', email: at254 })).res.status, 200);
  await picks(env, p, 1); // a changed set, so the next submit is a new row
  assert.equal((await submit(env, p, { relationship: '本人', email: '' })).res.status, 200);
  assert.equal(one(env, 'SELECT email FROM pickers').email, null, 'blank is no email');
  assert.equal(one(env, 'SELECT email FROM submissions ORDER BY rowid DESC').email, null);
});

// ─── Rules 4 and 5 ───────────────────────────────────────────────────────────

test('no key, a wrong key, or a key from before a reset cannot submit', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  for (const key of [null, '', 'nope']) {
    assert.equal((await submit(env, p, { relationship: '本人' }, key)).res.status, 403, JSON.stringify(key));
  }
  await call(env, `/api/admin/projects/${p.project.id}/reset-seat`, { method: 'POST', token: SECRET });
  assert.equal((await submit(env, p, { relationship: '本人' })).res.status, 403);
  await claim(env, p.token, '新的人');
  assert.equal((await submit(env, p, { relationship: '本人' })).res.status, 403);
  assert.equal(rows(env, 'SELECT * FROM submissions').length, 0);
  assert.equal(env.NOTIFY_EMAIL.sent.length, 0);
});

test('a revoked or expired link cannot submit', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  await seedToken(env, { token: 'EXP', project_id: p.project.id, expires_at: days(-1) });
  assert.equal((await submit(env, { ...p, token: 'EXP' }, { relationship: '本人' })).res.status, 401);
  env.DB._db.prepare('UPDATE share_tokens SET revoked_at = ? WHERE token = ?').run(days(-0.1), p.token);
  assert.equal((await submit(env, p, { relationship: '本人' })).res.status, 401);
  assert.equal(rows(env, 'SELECT * FROM submissions').length, 0);
  assert.equal(env.NOTIFY_EMAIL.sent.length, 0);
});

// ─── the notification email ──────────────────────────────────────────────────

test('the photographer gets one email with the submit record', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer, { NOTIFY_FROM: 'picker@studio.tw' });
  const p = await claimed(env, { title: '王先生 婚紗', pick_limit: 2, extra_price: 150 }, '王小明');
  await picks(env, p, 5);
  await submit(env, p, { relationship: '伴侶', email: 'guest@b.tw' });
  assert.equal(mailer.sent.length, 1);
  const m = mailer.sent[0];
  assert.equal(m.to, 'studio@example.com');
  assert.equal(m.from, 'picker@studio.tw');
  assert.match(m.subject, /王先生 婚紗/);
  assert.match(m.subject, /王小明/);
  for (const part of [m.html, m.text]) {
    assert.match(part, /王小明/);
    assert.match(part, /伴侶/);
    assert.match(part, /guest@b\.tw/);
    assert.match(part, /5/);
    assert.match(part, /多 3 張/);
    assert.match(part, /150/);
  }
});

test('with no NOTIFY_FROM the photographer\'s own address sends', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const p = await claimed(env);
  await submit(env, p, { relationship: '本人' });
  assert.equal(mailer.sent[0].from, 'studio@example.com');
});

// ─── Rule 8: every guest string escaped in the email ─────────────────────────

test('every guest-supplied string is HTML-escaped in the email', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const evilName = '<script>alert(1)</script>&"\'';
  const p = await claimed(env, { title: '<img src=x onerror=alert(2)>' }, evilName);
  await picks(env, p, 1);
  await submit(env, p, { relationship: '其他', email: '"><svg/onload=alert(3)>@b.tw' });
  const { html, subject } = mailer.sent[0];
  assert.doesNotMatch(html, /<script|<img|<svg/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&amp;&quot;&#39;/);
  assert.match(html, /&lt;img src=x onerror=alert\(2\)&gt;/);
  assert.match(html, /&quot;&gt;&lt;svg\/onload=alert\(3\)&gt;@b\.tw/);
  assert.doesNotMatch(subject, /[\r\n]/);
});

test('a name cannot break the subject line into extra headers', async () => {
  const mailer = fakeMailer();
  const env = mailEnv(mailer);
  const { createProject } = await import('./pick-helpers.mjs');
  const { token } = await createProject(env, { title: 'A\r\nBcc: x@evil.tw' });
  // names are single-line text anyway; the title is the photographer's, but
  // the subject is built from both
  const { key } = await claim(env, token, '王');
  const c = collectingCtx();
  await pick(env, 'POST', 'submit', token, { key, body: { relationship: '本人' } }, c);
  await c.settle();
  assert.doesNotMatch(mailer.sent[0].subject, /[\r\n]/);
});

// ─── an email that fails must not fail the submit ────────────────────────────

test('a mailer that throws does not fail the submit', async () => {
  const env = mailEnv(fakeMailer({ fail: true }));
  const p = await claimed(env);
  await picks(env, p, 2);
  const { res, json } = await submit(env, p, { relationship: '本人' });
  assert.equal(res.status, 200);
  assert.equal(json.count, 2);
  assert.equal(rows(env, 'SELECT * FROM submissions').length, 1);
});

test('a mailer that throws synchronously does not fail the submit either', async () => {
  const env = mailEnv({ send() { throw new Error('boom'); } });
  const p = await claimed(env);
  assert.equal((await submit(env, p, { relationship: '本人' })).res.status, 200);
});

test('with no mail binding or no photographer address, submit succeeds and nothing is sent', async () => {
  const noBinding = setup({ PHOTOGRAPHER_EMAIL: 'studio@example.com' });
  const p1 = await claimed(noBinding);
  assert.equal((await submit(noBinding, p1, { relationship: '本人' })).res.status, 200);

  const mailer = fakeMailer();
  const noAddress = setup({ NOTIFY_EMAIL: mailer });
  const p2 = await claimed(noAddress);
  assert.equal((await submit(noAddress, p2, { relationship: '本人' })).res.status, 200);
  assert.equal(mailer.sent.length, 0);
});

test('the submit hands the email to waitUntil rather than making the guest wait', async () => {
  let release;
  const mailer = { sent: [], send: () => new Promise(r => { release = r; }) };
  const env = mailEnv(mailer);
  const p = await claimed(env);
  const c = collectingCtx();
  const res = await Promise.race([
    pick(env, 'POST', 'submit', p.token, { key: p.key, body: { relationship: '本人' } }, c),
    new Promise(r => setTimeout(() => r('still waiting on the mailer'), 1000)),
  ]);
  assert.notEqual(res, 'still waiting on the mailer');
  assert.equal(res.status, 200, 'answered while the mailer is still pending');
  assert.equal(c.pending.length, 1);
  // the send starts after the slot is claimed, a few awaits later
  while (!release) await new Promise(r => setTimeout(r, 1));
  release();
  await c.settle();
});

test('a seat reset that lands between the owner check and the submit still wins', async () => {
  const env = mailEnv();
  const p = await claimed(env);
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    if (/^\s*INSERT INTO submissions/i.test(sql)) env.DB._db.prepare('UPDATE projects SET owner_picker_id = NULL').run();
    return prepare(sql);
  };
  assert.equal((await submit(env, p, { relationship: '本人' })).res.status, 403);
  assert.equal(rows(env, 'SELECT * FROM submissions').length, 0);
  assert.equal(env.NOTIFY_EMAIL.sent.length, 0);
});
