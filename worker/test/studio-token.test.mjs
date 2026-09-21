// Studio tokens. Gating `GET /<key>` behind a header broke every page the
// photographer uses, because an <img> element cannot send one — so the picker,
// the editor canvas, upload.html and r2_designer 401'd on every tile. The
// photographer now mints a short-lived token with their real credential and
// carries it in `?t=` exactly like a client does.
//
// It reads the whole bucket, so the two things that keep it from being a
// second master key are its twelve hours and the fact that it authorises
// nothing but reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { fakeBucket, fakeDB, ctx, req } from './fakes.mjs';

const SECRET = 'photographer-secret';
const MINE = '20260819/';

const BOOK = {
  name: '王先生 婚紗',
  clientFolders: [MINE],
  pages: [{ type: 'cover', slots: [{ photoId: '20260819/a.jpg', crop: {} }] }],
};

const OBJECTS = {
  '_books/b1.json': JSON.stringify(BOOK),
  '20260819/a.jpg': 'MINE-A',
  '20260819/sub/b.jpg': 'MINE-SUB-B',
  '20260901/x.jpg': 'OTHER-BOOK-X',
  '_thumbs/400/20260901/x.jpg.thumb': 'OTHER-BOOK-X-THUMB',
};

const hours = n => new Date(Date.now() + n * 3600000).toISOString();
const days = n => new Date(Date.now() + n * 86400000).toISOString();

function setup() {
  return { imagepicker: fakeBucket(OBJECTS), DB: fakeDB(), PHOTOGRAPHER_TOKEN: SECRET };
}

const call = (env, path, opts = {}) => worker.fetch(req(path, opts), env, ctx);

const row = (env, token) =>
  env.DB._db.prepare('SELECT * FROM share_tokens WHERE token = ?').get(token);

// a client album link, inserted the way the share route inserts one — without
// naming the kind column, so the default is what decides
async function seedClient(env, overrides = {}) {
  const t = {
    token: 'TK', book_id: 'b1', label: '王先生 婚紗', folders: [MINE],
    created_at: days(-1), expires_at: days(89), revoked_at: null, last_seen_at: null,
    ...overrides,
  };
  await env.DB.prepare(
    'INSERT INTO share_tokens (token, book_id, label, folders, created_at, expires_at, revoked_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(t.token, t.book_id, t.label, JSON.stringify(t.folders), t.created_at, t.expires_at, t.revoked_at, t.last_seen_at).run();
  return t.token;
}

async function seedStudio(env, overrides = {}) {
  const t = {
    token: 'ST', created_at: hours(-1), expires_at: hours(11),
    revoked_at: null, last_seen_at: null, ...overrides,
  };
  await env.DB.prepare(
    "INSERT INTO share_tokens (token, book_id, kind, folders, created_at, expires_at, revoked_at, last_seen_at) VALUES (?, '', 'studio', '[]', ?, ?, ?, ?)"
  ).bind(t.token, t.created_at, t.expires_at, t.revoked_at, t.last_seen_at).run();
  return t.token;
}

const mint = env => call(env, '/api/auth/studio-token', { method: 'POST', token: SECRET });

// ─── minting ─────────────────────────────────────────────────────────────────

test('minting a studio token needs the real photographer credential', async () => {
  const env = setup();
  await seedClient(env);
  await seedStudio(env);
  const post = { method: 'POST' };
  assert.equal((await call(env, '/api/auth/studio-token', post)).status, 401, 'no credential');
  assert.equal((await call(env, '/api/auth/studio-token', { ...post, token: 'nope' })).status, 401, 'wrong credential');
  assert.equal((await call(env, '/api/auth/studio-token?t=TK', post)).status, 401, 'a client link must not mint one');
  assert.equal((await call(env, '/api/auth/studio-token?t=ST', post)).status, 401, 'a studio token must not mint another');
});

test('a minted studio token is a random token that dies in twelve hours', async () => {
  const env = setup();
  const res = await mint(env);
  assert.equal(res.status, 200);
  const { token, expires_at } = await res.json();
  // 32 random bytes, base64url — the same shape as a client link
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, `token looks weak: ${token}`);
  const ttl = (Date.parse(expires_at) - Date.now()) / 3600000;
  assert.ok(ttl > 11.9 && ttl <= 12, `ttl ${ttl} hours, expected 12`);
});

// ─── what it opens ───────────────────────────────────────────────────────────

test('a studio token reads the whole bucket, not one folder snapshot', async () => {
  const env = setup();
  const { token } = await (await mint(env)).json();
  const t = `t=${token}`;
  assert.equal(await (await call(env, `/20260819/a.jpg?${t}`)).text(), 'MINE-A');
  assert.equal(await (await call(env, `/20260819/sub/b.jpg?${t}`)).text(), 'MINE-SUB-B');
  // the folder a client link for b1 would never reach
  assert.equal(await (await call(env, `/20260901/x.jpg?${t}`)).text(), 'OTHER-BOOK-X');
  assert.equal(await (await call(env, `/20260901/x.jpg?w=400&${t}`)).text(), 'OTHER-BOOK-X-THUMB');
  // index.html opens on the folder picker, which lists the bucket root
  const root = await call(env, `/?list=&${t}`);
  assert.equal(root.status, 200, 'the folder picker lists the root');
  assert.ok((await root.json()).folders.includes('20260901/'));
  assert.equal((await call(env, `/?list=${encodeURIComponent('20260901/')}&${t}`)).status, 200);
});

test('a studio token read is not cacheable by a shared cache', async () => {
  // it rides in the URL, so a proxy would happily keep the response and hand
  // it to the next request that guessed the link
  const env = setup();
  const { token } = await (await mint(env)).json();
  const res = await call(env, `/20260819/a.jpg?t=${token}`);
  assert.match(res.headers.get('Cache-Control'), /^private,/);
  assert.match(res.headers.get('Vary') || '', /X-Share-Token/i);
});

// ─── what it must refuse ─────────────────────────────────────────────────────

test('a studio token cannot mint, list or revoke links', async () => {
  const env = setup();
  await seedClient(env);
  const { token } = await (await mint(env)).json();
  const t = `t=${token}`;
  assert.equal((await call(env, `/api/books/b1/share?${t}`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await call(env, `/api/books/b1/shares?${t}`)).status, 401);
  assert.equal((await call(env, `/api/shares/TK/revoke?${t}`, { method: 'POST' })).status, 401);
  assert.equal((await call(env, '/20260819/a.jpg?t=TK')).status, 200, 'the client link survived the attempt');
});

test('a studio token cannot write to the bucket', async () => {
  const env = setup();
  const { token } = await (await mint(env)).json();
  const res = await call(env, `/2026/new.jpg?t=${token}`, { method: 'PUT', body: 'bytes' });
  assert.equal(res.status, 401);
  assert.equal(env.imagepicker._store.has('2026/new.jpg'), false);
});

test('a studio token cannot read or drive an album', async () => {
  // the editor loads books with fetch, which can send the header, so this
  // route has no reason to accept a URL-carried credential
  const env = setup();
  const { token } = await (await mint(env)).json();
  const t = `t=${token}`;
  assert.equal((await call(env, `/api/books/b1?${t}`)).status, 401, 'GET book');
  assert.equal((await call(env, `/api/books/b1/status?${t}`)).status, 401, 'GET status');

  assert.equal((await call(env, `/api/books/b1/approve?${t}`, { method: 'POST' })).status, 401, 'approve');
  assert.equal(env.imagepicker._store.has('_books/b1_status.json'), false, 'approve wrote a status file');

  assert.equal((await call(env, `/api/books/b1?${t}`, { method: 'PUT', body: '{"name":"pwned"}' })).status, 401, 'PUT book');
  assert.equal((await call(env, `/api/books/b1?${t}`, {
    method: 'PATCH', body: JSON.stringify({ pageIndex: 0, slots: [{ photoId: '20260819/sub/b.jpg' }] }),
  })).status, 401, 'PATCH book');
  const stored = JSON.parse(env.imagepicker._store.get('_books/b1.json').body);
  assert.equal(stored.name, BOOK.name, 'the book was overwritten');
  assert.equal(stored.pages[0].slots[0].photoId, '20260819/a.jpg', 'the page was edited');
});

test('a studio token pinned to an album by a hand-edited row still cannot drive it', async () => {
  // rows get hand-edited in the D1 console. What refuses here is the kind, not
  // the fact that a minted studio row happens to carry no book_id.
  const env = setup();
  await env.DB.prepare(
    `INSERT INTO share_tokens (token, book_id, kind, folders, created_at, expires_at) VALUES ('ST', 'b1', 'studio', '["${MINE}"]', ?, ?)`
  ).bind(hours(-1), hours(11)).run();
  assert.equal((await call(env, '/api/books/b1?t=ST')).status, 401, 'GET book');
  assert.equal((await call(env, '/api/books/b1/status?t=ST')).status, 401, 'GET status');
  assert.equal((await call(env, '/api/books/b1/approve?t=ST', { method: 'POST' })).status, 401, 'approve');
  assert.equal(env.imagepicker._store.has('_books/b1_status.json'), false, 'approve wrote a status file');
  assert.equal((await call(env, '/api/books/b1?t=ST', {
    method: 'PATCH', body: JSON.stringify({ pageIndex: 0, slots: [{ photoId: '20260819/sub/b.jpg' }] }),
  })).status, 401, 'PATCH book');
  assert.equal(JSON.parse(env.imagepicker._store.get('_books/b1.json').body).pages[0].slots[0].photoId,
    '20260819/a.jpg', 'the page was edited');
  // the row is live — it reads objects fine, so the refusals above are the
  // route refusing the kind, not a dead token
  assert.equal((await call(env, '/20260819/a.jpg?t=ST')).status, 200);
});

test('a studio token cannot reach the admin API', async () => {
  const env = setup();
  const { token } = await (await mint(env)).json();
  const t = `t=${token}`;
  assert.equal((await call(env, `/api/admin/clients?${t}`)).status, 401);
  assert.equal((await call(env, `/api/admin/clients/1/approve?${t}`, { method: 'PUT' })).status, 401);
  assert.equal((await call(env, `/api/admin/clients/1/permissions?${t}`, { method: 'PUT', body: '{}' })).status, 401);
  assert.equal((await call(env, `/api/admin/clients/1?${t}`, { method: 'DELETE' })).status, 401);
});

// ─── its twelve hours are a deadline, not a lease ────────────────────────────

test('an expired studio token is refused like any other expired token', async () => {
  const env = setup();
  await seedStudio(env, { created_at: hours(-13), expires_at: hours(-1) });
  assert.equal((await call(env, '/20260819/a.jpg?t=ST')).status, 401);
  assert.equal((await call(env, '/?list=&t=ST')).status, 401);
});

test('browsing all day does not slide a studio token out to ninety days', async () => {
  const env = setup();
  await seedStudio(env, { expires_at: hours(11) });
  const before = row(env, 'ST');
  const changedBefore = env.DB._changed();
  for (let i = 0; i < 20; i++) {
    assert.equal((await call(env, '/20260819/a.jpg?t=ST')).status, 200);
  }
  const after = row(env, 'ST');
  assert.equal(after.expires_at, before.expires_at, 'the deadline moved');
  assert.equal(after.last_seen_at, null);
  assert.equal(env.DB._changed() - changedBefore, 0, 'the photographer browsing cost a D1 write');
});

test('a revoked studio token stops working', async () => {
  const env = setup();
  const { token } = await (await mint(env)).json();
  assert.equal((await call(env, `/api/shares/${token}/revoke`, { method: 'POST', token: SECRET })).status, 200);
  assert.equal((await call(env, `/20260819/a.jpg?t=${token}`)).status, 401);
  assert.equal((await call(env, `/?list=&t=${token}`)).status, 401);
});

test('a studio row with an unreadable created_at fails closed', async () => {
  const env = setup();
  await seedStudio(env, { created_at: 'sometime this morning' });
  assert.equal((await call(env, '/20260819/a.jpg?t=ST')).status, 401);
});

// ─── reloading pages all day must not leave a day of live credentials ────────

test('minting again hands back the live token rather than another one', async () => {
  const env = setup();
  const first = await (await mint(env)).json();
  const second = await (await mint(env)).json();
  assert.equal(second.token, first.token);
  assert.equal(second.expires_at, first.expires_at);
  const { n } = env.DB._db.prepare("SELECT COUNT(*) AS n FROM share_tokens WHERE kind = 'studio'").get();
  assert.equal(n, 1, `${n} studio rows after two mints`);
});

test('a studio token too close to its deadline is replaced, not handed back', async () => {
  // a page handed a token with two minutes left would 401 halfway down the grid
  for (const expires_at of [hours(0.5), hours(-1)]) {
    const env = setup();
    await seedStudio(env, { expires_at });
    const { token, expires_at: fresh } = await (await mint(env)).json();
    assert.notEqual(token, 'ST', `reused a token expiring at ${expires_at}`);
    const ttl = (Date.parse(fresh) - Date.now()) / 3600000;
    assert.ok(ttl > 11.9 && ttl <= 12, `ttl ${ttl} hours`);
  }
});

test('a revoked studio token is not handed back to the next mint', async () => {
  const env = setup();
  await seedStudio(env, { revoked_at: hours(-0.5) });
  const { token } = await (await mint(env)).json();
  assert.notEqual(token, 'ST');
  assert.equal((await call(env, `/20260819/a.jpg?t=${token}`)).status, 200, 'the replacement works');
});

// ─── it stays out of the client revoke UI ────────────────────────────────────

test('a studio token is not listed among an album’s client links', async () => {
  // that list is "which links did I send to this client, and which do I kill";
  // the photographer's own session is not one of them
  const env = setup();
  const { token: client } = await (await call(env, '/api/books/b1/share', {
    method: 'POST', token: SECRET, body: JSON.stringify({ label: '王先生 婚紗' }),
  })).json();
  const { token: studio } = await (await mint(env)).json();

  const listed = await (await call(env, '/api/books/b1/shares', { token: SECRET })).json();
  assert.deepEqual(listed.map(e => e.token), [client]);
  assert.equal(JSON.stringify(listed).includes(studio), false);
});

// ─── the column does not exist on the live database yet ──────────────────────

// the column and the comment block that introduces it, comma and all
const PRE_MIGRATION = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
  .replace(/,\n(?:\s*--[^\n]*\n)*\s*kind\s+TEXT[^\n]*\n/, '\n');

test('a database that predates the kind column still serves client links', async () => {
  // schema.sql is CREATE TABLE IF NOT EXISTS, so the deployed D1 keeps the old
  // shape until someone runs the ALTER by hand. Until then every row reads
  // back with no kind at all, and must still be the client link it is.
  assert.equal(/\bkind\b/.test(PRE_MIGRATION), false, 'the pre-migration schema still declares the column');
  const env = {
    imagepicker: fakeBucket(OBJECTS), PHOTOGRAPHER_TOKEN: SECRET,
    DB: fakeDB({ schema: PRE_MIGRATION }),
  };
  await seedClient(env);
  assert.equal((await call(env, '/20260819/a.jpg?t=TK')).status, 200, 'own folder');
  assert.equal((await call(env, '/20260901/x.jpg?t=TK')).status, 401, 'a kindless row must not read the bucket');
  assert.equal((await call(env, '/?list=&t=TK')).status, 401, 'a kindless row must not list the root');
  assert.equal((await call(env, '/api/books/b1?t=TK')).status, 200, 'its album still opens');
});
