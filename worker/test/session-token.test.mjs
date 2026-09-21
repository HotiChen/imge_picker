// Client session tokens. index.html is dual-mode: the photographer arrives
// with a studio token, a client arrives having signed in against D1. Gating
// `GET /?list=` and `GET /<key>` behind an admin credential or a share token
// left the second one with nothing — a D1 session is neither, so a client who
// signs in with their own account sees no folders and no photos.
//
// They now trade that session for the same shape of thing the photographer
// gets: a read-only token that fits in a query string, because an <img>
// cannot send a header. Unlike the studio token it opens one folder — the one
// on their own user row — and unlike the album link it is not sent to anyone,
// it is minted on demand by the person already holding the session.

// The Worker runs in UTC, but sessions.expires_at is written as
// 'YYYY-MM-DD HH:MM:SS' with nothing in the text saying which zone that is,
// and Date.parse reads that shape as LOCAL time. Pinning a non-UTC zone here
// keeps that from being a bug only a traveller ever sees.
process.env.TZ = 'Asia/Taipei';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker.js';
import { fakeBucket, fakeDB, ctx, req } from './fakes.mjs';

const SECRET = 'photographer-secret';
const MINE = '20260819/';
const THEIRS = '20260901/';

const BOOK = {
  name: '王先生 婚紗',
  clientFolders: [MINE],
  notifyUrl: 'https://hook.test/notify',
  pages: [{ type: 'cover', slots: [{ photoId: '20260819/a.jpg', crop: {} }] }],
};

const OBJECTS = {
  '_books/b1.json': JSON.stringify(BOOK),
  '20260819/a.jpg': 'MINE-A',
  '20260819/sub/b.jpg': 'MINE-SUB-B',
  '_thumbs/400/20260819/a.jpg.thumb': 'MINE-A-THUMB',
  '20260901/x.jpg': 'THEIRS-X',
  '20260819-other/c.jpg': 'NEIGHBOUR-C',
};

const hours = n => new Date(Date.now() + n * 3600000).toISOString();
const days = n => new Date(Date.now() + n * 86400000).toISOString();
// exactly the shape POST /api/auth/login writes
const sqlTime = h => new Date(Date.now() + h * 3600000).toISOString().replace('T', ' ').split('.')[0];

function setup() {
  return { imagepicker: fakeBucket(OBJECTS), DB: fakeDB(), PHOTOGRAPHER_TOKEN: SECRET };
}

const call = (env, path, opts = {}) => worker.fetch(req(path, opts), env, ctx);

const row = (env, token) =>
  env.DB._db.prepare('SELECT * FROM share_tokens WHERE token = ?').get(token);

const studioRows = env =>
  env.DB._db.prepare("SELECT COUNT(*) AS n FROM share_tokens WHERE kind = 'session'").get().n;

// a client with an approved account, a folder of their own and a live session
async function seedUser(env, { id, folder_path = MINE, approved = 1, session, expires_at } = {}) {
  await env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, name, folder_path, approved) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, `c${id}@test`, 'hash:salt', `客戶${id}`, folder_path, approved).run();
  await env.DB.prepare(
    'INSERT INTO permissions (user_id, can_book, can_upload) VALUES (?, 1, 1)'
  ).bind(id).run();
  const token = session ?? `SESS-${id}`;
  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
  ).bind(token, id, expires_at ?? sqlTime(30 * 24)).run();
  return token;
}

// an album link, inserted the way the share route inserts one — without
// naming the kind column, so the default is what decides
async function seedClientLink(env) {
  await env.DB.prepare(
    'INSERT INTO share_tokens (token, book_id, label, folders, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind('TK', 'b1', '王先生 婚紗', JSON.stringify([MINE]), days(-1), days(89)).run();
  return 'TK';
}

const mint = (env, session) =>
  call(env, '/api/auth/session-token', { method: 'POST', token: session });

async function minted(env, session) {
  const res = await mint(env, session);
  const body = await res.json().catch(() => null);
  assert.equal(res.status, 200, `mint refused: ${JSON.stringify(body)}`);
  return body;
}

// ─── minting ─────────────────────────────────────────────────────────────────

test('a signed-in client trades their session for a token that fits in a URL', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  const res = await mint(env, session);
  assert.equal(res.status, 200);
  const body = await res.json();
  // 32 random bytes, base64url — the same shape as every other share token
  assert.match(body.token, /^[A-Za-z0-9_-]{43}$/, `token looks weak: ${body.token}`);
  assert.notEqual(body.token, session, 'handed back the session token itself');
  // the frontend lists this string straight back as `?list=`, so it is part
  // of the contract, not a debugging extra
  assert.deepEqual(body.folders, [MINE]);
  const ttl = (Date.parse(body.expires_at) - Date.now()) / 3600000;
  assert.ok(ttl > 0.9 && ttl <= 1, `ttl ${ttl} hours, expected 1`);
  assert.equal(row(env, body.token).kind, 'session');
});

test('minting needs a live D1 session and nothing else will do', async () => {
  const env = setup();
  await seedUser(env, { id: 1 });
  await seedUser(env, { id: 2, session: 'DEAD', expires_at: sqlTime(-1) });
  await seedClientLink(env);
  const post = { method: 'POST' };
  const path = '/api/auth/session-token';
  assert.equal((await call(env, path, post)).status, 401, 'no credential');
  assert.equal((await call(env, path, { ...post, token: 'nope' })).status, 401, 'a guessed session');
  assert.equal((await call(env, path, { ...post, token: 'DEAD' })).status, 401, 'an expired session');
  assert.equal((await call(env, path, { ...post, token: SECRET })).status, 401,
    'the photographer credential is not a client session');
  assert.equal((await call(env, `${path}?t=TK`, post)).status, 401, 'an album link must not mint one');
  assert.equal(studioRows(env), 0, 'a refused mint still wrote a row');
});

test('a minted token cannot be turned back into a session', async () => {
  // it rides in URLs and access logs; if it were also a session credential
  // that leak would be an account takeover rather than an hour of read access
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  const { token } = await minted(env, session);
  assert.equal((await call(env, '/api/auth/session-token', { method: 'POST', token })).status, 401,
    'minted another token from itself');
  assert.equal((await call(env, '/api/auth/me', { token })).status, 401, '/me accepted it');
});

test('an account still waiting for approval mints nothing', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1, approved: 0 });
  const res = await mint(env, session);
  assert.equal(res.status, 403);
  assert.equal(studioRows(env), 0, 'an unapproved account got a row anyway');
});

test('an account with no folder set mints nothing', async () => {
  // '' is the default on a fresh user row. Read as "everything" it would open
  // every other client's wedding; read as "nothing" it is a silent empty grid.
  for (const folder_path of ['', '   ', null]) {
    const env = setup();
    const session = await seedUser(env, { id: 1, folder_path });
    const res = await mint(env, session);
    assert.equal(res.status, 403, `folder_path ${JSON.stringify(folder_path)} minted a token`);
    assert.equal(studioRows(env), 0);
  }
});

test('a folder path without a trailing slash is handed back canonical', async () => {
  // `20260819` and `20260819/` are different prefixes to R2, and the first one
  // also reaches 20260819-other/. The client lists back what we tell them.
  const env = setup();
  const session = await seedUser(env, { id: 1, folder_path: '20260819' });
  const { token, folders } = await minted(env, session);
  assert.deepEqual(folders, [MINE]);
  const listed = await call(env, `/?list=${encodeURIComponent(folders[0])}&t=${token}`);
  assert.equal(listed.status, 200, 'the client cannot list the folder we handed them');
  assert.deepEqual((await listed.json()).data.map(f => f.id), ['20260819/a.jpg']);
  assert.equal((await call(env, `/20260819-other/c.jpg?t=${token}`)).status, 401, 'the neighbour opened');
});

test('the token does not outlive the session it was traded for', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1, expires_at: sqlTime(10 / 60) });
  const { expires_at } = await minted(env, session);
  const ttl = (Date.parse(expires_at) - Date.now()) / 60000;
  assert.ok(ttl > 9 && ttl <= 10.1, `ttl ${ttl} minutes, expected the session's remaining 10`);
});

test('a session row with an unreadable expiry mints nothing', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1, expires_at: 'tomorrow morning' });
  assert.equal((await mint(env, session)).status, 401);
  assert.equal(studioRows(env), 0);
});

test('with no D1 bound there is no session to trade', async () => {
  const env = { imagepicker: fakeBucket(OBJECTS), PHOTOGRAPHER_TOKEN: SECRET };
  assert.equal((await call(env, '/api/auth/session-token', { method: 'POST', token: 'SESS-1' })).status, 401);
});

// ─── what it opens ───────────────────────────────────────────────────────────

test('a client reads their own folder, sub-folders and thumbnails', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  const { token } = await minted(env, session);
  const t = `t=${token}`;
  assert.equal(await (await call(env, `/20260819/a.jpg?${t}`)).text(), 'MINE-A');
  assert.equal(await (await call(env, `/20260819/sub/b.jpg?${t}`)).text(), 'MINE-SUB-B');
  assert.equal(await (await call(env, `/20260819/a.jpg?w=400&${t}`)).text(), 'MINE-A-THUMB');
  const listed = await call(env, `/?list=${encodeURIComponent(MINE)}&${t}`);
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).folders, ['20260819/sub/']);
  assert.equal((await call(env, `/?list=${encodeURIComponent(MINE + 'sub/')}&${t}`)).status, 200);
});

test('a client token reaches nothing outside its own folder', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  const { token } = await minted(env, session);
  const t = `t=${token}`;
  assert.equal((await call(env, `/20260901/x.jpg?${t}`)).status, 401, 'another folder');
  // a prefix match that is not on a slash boundary
  assert.equal((await call(env, `/20260819-other/c.jpg?${t}`)).status, 401, 'the neighbouring folder');
  assert.equal((await call(env, `/?list=&${t}`)).status, 401, 'the bucket root');
  assert.equal((await call(env, `/?list=${encodeURIComponent(THEIRS)}&${t}`)).status, 401, 'listing another folder');
  assert.equal((await call(env, `/_books/b1.json?${t}`)).status, 401, 'the raw book object');
});

test('two clients cannot reach each other’s folders', async () => {
  const env = setup();
  const one = await seedUser(env, { id: 1, folder_path: MINE });
  const two = await seedUser(env, { id: 2, folder_path: THEIRS });
  const a = (await minted(env, one)).token;
  const b = (await minted(env, two)).token;
  assert.notEqual(a, b, 'two clients were handed the same token');

  assert.equal((await call(env, `/20260819/a.jpg?t=${a}`)).status, 200);
  assert.equal((await call(env, `/20260901/x.jpg?t=${b}`)).status, 200);

  assert.equal((await call(env, `/20260901/x.jpg?t=${a}`)).status, 401, 'one read two’s photo');
  assert.equal((await call(env, `/20260819/a.jpg?t=${b}`)).status, 401, 'two read one’s photo');
  assert.equal((await call(env, `/?list=${encodeURIComponent(THEIRS)}&t=${a}`)).status, 401, 'one listed two’s folder');
  assert.equal((await call(env, `/?list=${encodeURIComponent(MINE)}&t=${b}`)).status, 401, 'two listed one’s folder');
});

test('a client session token is not itself a key to the bucket', async () => {
  // the obvious shortcut — put the D1 session token in `?t=` — must not work,
  // or the long-lived credential ends up in every image URL
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  assert.equal((await call(env, `/20260819/a.jpg?t=${session}`)).status, 401);
  assert.equal((await call(env, `/?list=${encodeURIComponent(MINE)}&t=${session}`)).status, 401);
});

test('a client token read is not cacheable by a shared cache', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  const { token } = await minted(env, session);
  const res = await call(env, `/20260819/a.jpg?t=${token}`);
  assert.match(res.headers.get('Cache-Control'), /^private,/);
  assert.match(res.headers.get('Vary') || '', /X-Share-Token/i);
  const listed = await call(env, `/?list=${encodeURIComponent(MINE)}&t=${token}`);
  assert.match(listed.headers.get('Cache-Control') || '', /no-store/);
});

// ─── what it must refuse ─────────────────────────────────────────────────────

test('a client token cannot write to the bucket', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  const { token } = await minted(env, session);
  // even inside its own folder
  const res = await call(env, `/20260819/new.jpg?t=${token}`, { method: 'PUT', body: 'bytes' });
  assert.equal(res.status, 401);
  assert.equal(env.imagepicker._store.has('20260819/new.jpg'), false);
});

test('a client token cannot mint, list or revoke share links', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  await seedClientLink(env);
  const { token } = await minted(env, session);
  const t = `t=${token}`;
  assert.equal((await call(env, `/api/books/b1/share?${t}`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await call(env, `/api/books/b1/shares?${t}`)).status, 401);
  assert.equal((await call(env, `/api/shares/TK/revoke?${t}`, { method: 'POST' })).status, 401);
  assert.equal(row(env, 'TK').revoked_at, null, 'the album link was revoked');
});

test('a client token cannot mint a studio token', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  const { token } = await minted(env, session);
  assert.equal((await call(env, `/api/auth/studio-token?t=${token}`, { method: 'POST' })).status, 401);
  assert.equal((await call(env, '/api/auth/studio-token', { method: 'POST', token })).status, 401);
  assert.equal(env.DB._db.prepare("SELECT COUNT(*) AS n FROM share_tokens WHERE kind = 'studio'").get().n, 0);
});

test('a client token cannot read or drive an album', async () => {
  // the client album is reached through a share link, and the book routes are
  // driven by fetch, which can send the session in a header. A token whose
  // only job is to sign <img> URLs has no business here.
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  const { token } = await minted(env, session);
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

test('a client token pinned to an album by a hand-edited row still cannot drive it', async () => {
  // rows get hand-edited in the D1 console, and this album's clientFolders are
  // exactly this token's folders — so what refuses here has to be the kind,
  // not the book_id and not the folder snapshot.
  const env = setup();
  await env.DB.prepare(
    `INSERT INTO share_tokens (token, book_id, kind, folders, created_at, expires_at) VALUES ('CS', 'b1', 'session', '["${MINE}"]', ?, ?)`
  ).bind(hours(-0.5), hours(0.5)).run();
  assert.equal((await call(env, '/api/books/b1?t=CS')).status, 401, 'GET book');
  assert.equal((await call(env, '/api/books/b1/status?t=CS')).status, 401, 'GET status');
  assert.equal((await call(env, '/api/books/b1/approve?t=CS', { method: 'POST' })).status, 401, 'approve');
  assert.equal(env.imagepicker._store.has('_books/b1_status.json'), false, 'approve wrote a status file');
  assert.equal((await call(env, '/api/books/b1?t=CS', {
    method: 'PATCH', body: JSON.stringify({ pageIndex: 0, slots: [{ photoId: '20260819/sub/b.jpg' }] }),
  })).status, 401, 'PATCH book');
  assert.equal(JSON.parse(env.imagepicker._store.get('_books/b1.json').body).pages[0].slots[0].photoId,
    '20260819/a.jpg', 'the page was edited');
  // the row is live — it reads its folder fine, so the refusals above are the
  // route refusing the kind rather than a dead token
  assert.equal((await call(env, '/20260819/a.jpg?t=CS')).status, 200);
});

test('a client token cannot reach the admin API', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  const { token } = await minted(env, session);
  for (const [path, opts] of [
    ['/api/admin/clients', {}],
    ['/api/admin/clients/1/approve', { method: 'PUT' }],
    ['/api/admin/clients/1/permissions', { method: 'PUT', body: '{"folder_path":"/"}' }],
    ['/api/admin/clients/1', { method: 'DELETE' }],
  ]) {
    assert.equal((await call(env, `${path}?t=${token}`, opts)).status, 401, `${path} via ?t=`);
    // and the same token as a bearer header, which is where it would land if
    // the frontend ever confused it with the session
    assert.equal((await call(env, path, { ...opts, token })).status, 401, `${path} as a header`);
  }
  assert.equal(env.DB._db.prepare('SELECT folder_path, approved FROM users WHERE id = 1').get().folder_path, MINE);
});

// ─── its hour is a deadline, not a lease ─────────────────────────────────────

test('an expired client token is refused like any other expired token', async () => {
  const env = setup();
  await env.DB.prepare(
    `INSERT INTO share_tokens (token, book_id, kind, folders, created_at, expires_at) VALUES ('CS', '', 'session', '["${MINE}"]', ?, ?)`
  ).bind(hours(-2), hours(-1)).run();
  assert.equal((await call(env, '/20260819/a.jpg?t=CS')).status, 401);
  assert.equal((await call(env, `/?list=${encodeURIComponent(MINE)}&t=CS`)).status, 401);
});

test('browsing all day does not slide a client token out to ninety days', async () => {
  // the album link slides because the client cannot renew it; this one they
  // re-mint from their session whenever they like, so sliding would only keep
  // a stale folder snapshot alive after the photographer narrowed it
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  const { token } = await minted(env, session);
  const before = row(env, token);
  const changedBefore = env.DB._changed();
  for (let i = 0; i < 20; i++) {
    assert.equal((await call(env, `/20260819/a.jpg?t=${token}`)).status, 200);
  }
  const after = row(env, token);
  assert.equal(after.expires_at, before.expires_at, 'the deadline moved');
  assert.equal(after.last_seen_at, null);
  assert.equal(env.DB._changed() - changedBefore, 0, 'a client browsing cost a D1 write');
});

test('a revoked client token stops working', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  const { token } = await minted(env, session);
  assert.equal((await call(env, `/api/shares/${token}/revoke`, { method: 'POST', token: SECRET })).status, 200);
  assert.equal((await call(env, `/20260819/a.jpg?t=${token}`)).status, 401);
  assert.equal((await call(env, `/?list=${encodeURIComponent(MINE)}&t=${token}`)).status, 401);
});

// ─── it stays out of the photographer's link list, and out of studio mints ───

test('a client token is not listed among an album’s client links', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  const { token: link } = await (await call(env, '/api/books/b1/share', {
    method: 'POST', token: SECRET, body: JSON.stringify({ label: '王先生 婚紗' }),
  })).json();
  const { token } = await minted(env, session);
  const listed = await (await call(env, '/api/books/b1/shares', { token: SECRET })).json();
  assert.deepEqual(listed.map(e => e.token), [link]);
  assert.equal(JSON.stringify(listed).includes(token), false);
});

test('minting a studio token never hands back a client’s', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  const { token } = await minted(env, session);
  // and one with hours left on it, so the reuse query has every reason but
  // the kind to pick it up
  await env.DB.prepare(
    `INSERT INTO share_tokens (token, book_id, kind, folders, created_at, expires_at) VALUES ('CS2', '', 'session', '["${MINE}"]', ?, ?)`
  ).bind(hours(-0.5), hours(11)).run();
  const studio = await (await call(env, '/api/auth/studio-token', { method: 'POST', token: SECRET })).json();
  assert.notEqual(studio.token, token);
  assert.notEqual(studio.token, 'CS2', 'the photographer was handed a client’s token');
  // and the studio token it did hand back reads the whole bucket, so the two
  // rows really are being told apart by kind
  assert.equal((await call(env, `/20260901/x.jpg?t=${studio.token}`)).status, 200);
});

// ─── the column does not exist on the live database yet ──────────────────────

const PRE_MIGRATION = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
  .replace(/,\n(?:\s*--[^\n]*\n)*\s*kind\s+TEXT[^\n]*\n/, '\n');

test('on a database that predates the kind column, minting fails loudly', async () => {
  // schema.sql is CREATE TABLE IF NOT EXISTS, so the deployed D1 keeps the old
  // shape until the ALTER from 86dcdbb is run by hand. This needs no second
  // migration of its own, but it does need that one.
  assert.equal(/\bkind\b/.test(PRE_MIGRATION), false, 'the pre-migration schema still declares the column');
  const env = {
    imagepicker: fakeBucket(OBJECTS), PHOTOGRAPHER_TOKEN: SECRET,
    DB: fakeDB({ schema: PRE_MIGRATION }),
  };
  const session = await seedUser(env, { id: 1 });
  await assert.rejects(() => mint(env, session), 'minting quietly succeeded without the column');
  // and the album links already in a client's chat are untouched by all this
  await seedClientLink(env);
  assert.equal((await call(env, '/20260819/a.jpg?t=TK')).status, 200);
  assert.equal((await call(env, '/api/books/b1?t=TK')).status, 200);
});
