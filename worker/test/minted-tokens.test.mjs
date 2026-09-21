// Lifetime, revocation and blast radius of the two MINTED token kinds — the
// photographer's studio token and a signed-in client's session token. The
// gates themselves are covered by studio-token.test.mjs and
// session-token.test.mjs; everything here is about what a minted token can
// still reach after the thing it was minted from is gone, and about the
// objects no URL-borne token should ever have reached in the first place.

// see session-token.test.mjs — sessions.expires_at carries no zone marker
process.env.TZ = 'Asia/Taipei';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { fakeBucket, fakeDB, ctx, req } from './fakes.mjs';

const SECRET = 'photographer-secret';
const MINE = '20260819/';
const THEIRS = '20260901/';

const BOOK = {
  name: '王先生 婚紗',
  clientFolders: [MINE],
  notifyUrl: 'https://hook.test/BEARER-SECRET',
  pages: [{ type: 'cover', slots: [{ photoId: '20260819/a.jpg', crop: {} }] }],
};

const OBJECTS = {
  '_books/b1.json': JSON.stringify(BOOK),
  '_books/b1_status.json': JSON.stringify({ approved: false }),
  '_thumbs/400/_books/b1.json.thumb': JSON.stringify(BOOK),
  // no such namespace today; it stands for the next one somebody adds
  '_private/notes.txt': 'FUTURE-NAMESPACE',
  '20260819/a.jpg': 'MINE-A',
  '_thumbs/400/20260819/a.jpg.thumb': 'MINE-A-THUMB',
  '20260901/x.jpg': 'THEIRS-X',
};

const hours = n => new Date(Date.now() + n * 3600000).toISOString();
const days = n => new Date(Date.now() + n * 86400000).toISOString();
const sqlTime = h => new Date(Date.now() + h * 3600000).toISOString().replace('T', ' ').split('.')[0];

const setup = () => ({ imagepicker: fakeBucket(OBJECTS), DB: fakeDB(), PHOTOGRAPHER_TOKEN: SECRET });
const call = (env, path, opts = {}) => worker.fetch(req(path, opts), env, ctx);
const row = (env, token) => env.DB._db.prepare('SELECT * FROM share_tokens WHERE token = ?').get(token);

async function seedUser(env, { id, folder_path = MINE, session, expires_at } = {}) {
  await env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, name, folder_path, approved) VALUES (?, ?, ?, ?, ?, 1)'
  ).bind(id, `c${id}@test`, 'hash:salt', `客戶${id}`, folder_path).run();
  const token = session ?? `SESS-${id}`;
  await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, id, expires_at ?? sqlTime(30 * 24)).run();
  return token;
}

const addSession = (env, id, token, expires_at) =>
  env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(token, id, expires_at).run();

// an album link, inserted the way the share route inserts one
const seedLink = (env, folders = [MINE]) =>
  env.DB.prepare(
    'INSERT INTO share_tokens (token, book_id, label, folders, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind('TK', 'b1', '王先生', JSON.stringify(folders), days(-1), days(89)).run();

const seedStudio = (env, token, expires_at) =>
  env.DB.prepare(
    "INSERT INTO share_tokens (token, book_id, kind, folders, created_at, expires_at) VALUES (?, '', 'studio', '[]', ?, ?)"
  ).bind(token, hours(-1), expires_at).run();

const mintStudio = async env =>
  (await call(env, '/api/auth/studio-token', { method: 'POST', token: SECRET })).json();

async function mintSession(env, session) {
  const res = await call(env, '/api/auth/session-token', { method: 'POST', token: session });
  const body = await res.json().catch(() => null);
  assert.equal(res.status, 200, `mint refused: ${JSON.stringify(body)}`);
  return body;
}

// ─── FIX 1: the Worker's own objects are not photos ──────────────────────────

test('a studio token cannot read the Worker’s own objects', async () => {
  // _books/<id>.json carries notifyUrl, a bearer webhook secret. The album
  // projection was added to keep that away from a URL-borne token; the object
  // route handed it back by a different door.
  const env = setup();
  const { token } = await mintStudio(env);
  const t = `t=${token}`;
  for (const key of ['_books/b1.json', '_books/b1_status.json', '_thumbs/400/_books/b1.json.thumb',
                     // whatever the Worker keeps for itself next is private by
                     // default, the same way the album projection is a whitelist
                     '_private/notes.txt']) {
    const res = await call(env, `/${key}?${t}`);
    assert.equal(res.status, 401, key);
    assert.equal((await res.text()).includes('BEARER-SECRET'), false, `${key} leaked the webhook`);
  }
  // and it still does the job it exists for
  assert.equal(await (await call(env, `/20260819/a.jpg?${t}`)).text(), 'MINE-A');
  assert.equal(await (await call(env, `/20260819/a.jpg?w=400&${t}`)).text(), 'MINE-A-THUMB');
  assert.equal((await call(env, `/20260901/x.jpg?${t}`)).status, 200, 'the studio grant stopped being bucket-wide');
});

test('no token that travels in a URL reads the Worker’s own objects', async () => {
  // not even one whose folder snapshot names the namespace outright — a
  // clientFolders typo in the editor would be enough
  const env = setup();
  await seedLink(env, [MINE, '_books/', '_thumbs/']);
  const session = await seedUser(env, { id: 1 });
  const { token } = await mintSession(env, session);
  for (const t of ['TK', token]) {
    assert.equal((await call(env, `/_books/b1.json?t=${t}`)).status, 401, `${t} read a book object`);
    assert.equal((await call(env, `/_thumbs/400/_books/b1.json.thumb?t=${t}`)).status, 401,
      `${t} read a book object through the thumbnail namespace`);
  }
  assert.equal((await call(env, '/20260819/a.jpg?t=TK')).status, 200, 'the album link stopped working');
});

test('the photographer’s header credential still reads a book object', async () => {
  const env = setup();
  const res = await call(env, '/_books/b1.json', { token: SECRET });
  assert.equal(res.status, 200);
  assert.equal((await res.text()).includes('BEARER-SECRET'), true);
});

// ─── FIX 2: one live studio row, and a way to see and kill it ────────────────

test('a studio mint supersedes every other live studio row and nothing else', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  await seedLink(env);
  const client = (await mintSession(env, session)).token;
  await seedStudio(env, 'ST1', hours(11));
  await seedStudio(env, 'ST2', hours(10));
  const { token } = await mintStudio(env);
  assert.equal(token, 'ST1', 'the newest live row should still be reused');
  assert.equal((await call(env, '/20260819/a.jpg?t=ST1')).status, 200);
  assert.equal((await call(env, '/20260819/a.jpg?t=ST2')).status, 401, 'a second live studio row survived');
  assert.notEqual(row(env, 'ST2').revoked_at, null);
  // the photographer opening a page does not log every client out
  assert.equal((await call(env, '/20260819/a.jpg?t=TK')).status, 200, 'an album link was superseded');
  assert.equal((await call(env, `/20260819/a.jpg?t=${client}`)).status, 200, 'a client token was superseded');
});

test('a studio mint that issues a new row kills the one it replaced', async () => {
  // this is what a photographer who thinks their password leaked reaches for:
  // log in again, and the credential that was out there stops working
  const env = setup();
  await seedStudio(env, 'ST', hours(0.5)); // too close to its deadline to reuse
  const { token } = await mintStudio(env);
  assert.notEqual(token, 'ST');
  assert.equal((await call(env, '/20260819/a.jpg?t=ST')).status, 401, 'the superseded token still reads');
  assert.equal((await call(env, `/20260819/a.jpg?t=${token}`)).status, 200);
});

test('minting twice does not revoke the token it just handed back', async () => {
  // the photographer works with the picker and the editor open side by side;
  // each page mints for itself and both must land on the same live row
  const env = setup();
  const first = await mintStudio(env);
  const second = await mintStudio(env);
  assert.equal(second.token, first.token);
  assert.equal((await call(env, `/20260819/a.jpg?t=${first.token}`)).status, 200,
    'the second page load killed the first page’s token');
  assert.equal(row(env, first.token).revoked_at, null);
});

test('the photographer can list the minted tokens the album lists cannot show', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  await seedLink(env);
  const studio = (await mintStudio(env)).token;
  const client = (await mintSession(env, session)).token;

  // neither of these is out there any more, so neither is an answer to
  // "what is holding my bucket open right now"
  await seedStudio(env, 'EXPIRED', hours(-1));
  await seedStudio(env, 'REVOKED', hours(6));
  await call(env, '/api/shares/REVOKED/revoke', { method: 'POST', token: SECRET });

  const listed = await (await call(env, '/api/shares/minted', { token: SECRET })).json();
  const byToken = Object.fromEntries(listed.map(r => [r.token, r]));
  assert.deepEqual(Object.keys(byToken).sort(), [studio, client].sort());
  assert.equal(byToken[studio].kind, 'studio');
  assert.equal(byToken[client].kind, 'session');
  assert.equal(byToken[client].user_id, 1, 'a client token that cannot be traced to a client');
  assert.equal(byToken[studio].user_id, null);
  // and the per-album list is unchanged — these are not links sent to anyone
  const album = await (await call(env, '/api/books/b1/shares', { token: SECRET })).json();
  assert.deepEqual(album.map(r => r.token), ['TK']);
});

test('revoking every minted token spares the links already in a client’s chat', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  await seedLink(env);
  const studio = (await mintStudio(env)).token;
  const client = (await mintSession(env, session)).token;

  // already dead, and so not part of what this call killed
  await seedStudio(env, 'GONE', hours(6));
  await call(env, '/api/shares/GONE/revoke', { method: 'POST', token: SECRET });

  const res = await call(env, '/api/shares/minted/revoke-all', { method: 'POST', token: SECRET });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).revoked, 2);

  assert.equal((await call(env, `/20260819/a.jpg?t=${studio}`)).status, 401, 'studio survived');
  assert.equal((await call(env, `/20260819/a.jpg?t=${client}`)).status, 401, 'client session survived');
  assert.equal((await call(env, '/20260819/a.jpg?t=TK')).status, 200, 'an album link was killed too');
  assert.equal((await call(env, '/api/books/b1?t=TK')).status, 200);
  assert.deepEqual(await (await call(env, '/api/shares/minted', { token: SECRET })).json(), []);
});

test('only the photographer can list or kill minted tokens', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  const studio = (await mintStudio(env)).token;
  const client = (await mintSession(env, session)).token;
  const kill = { method: 'POST' };
  for (const [label, opts, q] of [
    ['no credential', {}, ''],
    ['a guessed credential', { token: 'nope' }, ''],
    ['the studio token itself', {}, `?t=${studio}`],
    ['a client session token', {}, `?t=${client}`],
    ['a client session token as a header', { token: client }, ''],
  ]) {
    assert.equal((await call(env, `/api/shares/minted${q}`, opts)).status, 401, `list via ${label}`);
    assert.equal((await call(env, `/api/shares/minted/revoke-all${q}`, { ...opts, ...kill })).status, 401,
      `revoke-all via ${label}`);
  }
  assert.equal((await call(env, `/20260819/a.jpg?t=${studio}`)).status, 200, 'a refused revoke killed it anyway');
  assert.equal((await call(env, `/20260819/a.jpg?t=${client}`)).status, 200);
});

// ─── FIX 3: minted client tokens die with the account ────────────────────────

test('logging out kills the URL tokens minted from that account', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  await seedLink(env);
  const studio = (await mintStudio(env)).token;
  const { token } = await mintSession(env, session);
  assert.equal((await call(env, `/20260819/a.jpg?t=${token}`)).status, 200);

  assert.equal((await call(env, '/api/auth/logout', { method: 'POST', token: session })).status, 200);
  assert.equal((await call(env, `/20260819/a.jpg?t=${token}`)).status, 401, 'an hour of reading survived logout');
  assert.equal(row(env, token), undefined, 'the row is still there to be found later');
  // and nobody else's credentials went with it
  assert.equal((await call(env, `/20260819/a.jpg?t=${studio}`)).status, 200, 'logout killed the studio token');
  assert.equal((await call(env, '/20260819/a.jpg?t=TK')).status, 200, 'logout killed an album link');
});

test('deleting a client kills the URL tokens they were holding', async () => {
  const env = setup();
  const one = await seedUser(env, { id: 1, folder_path: MINE });
  const two = await seedUser(env, { id: 2, folder_path: THEIRS });
  const a = (await mintSession(env, one)).token;
  const b = (await mintSession(env, two)).token;

  assert.equal((await call(env, '/api/admin/clients/1', { method: 'DELETE', token: SECRET })).status, 200);
  assert.equal((await call(env, `/20260819/a.jpg?t=${a}`)).status, 401, 'a deleted client kept reading');
  assert.equal(row(env, a), undefined);
  assert.equal((await call(env, `/20260901/x.jpg?t=${b}`)).status, 200, 'the other client was collateral');
});

test('a logout that names no live session deletes nobody’s tokens', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  const { token } = await mintSession(env, session);
  for (const bad of ['nope', '']) {
    assert.equal((await call(env, '/api/auth/logout', { method: 'POST', token: bad })).status, 200);
  }
  assert.equal((await call(env, `/20260819/a.jpg?t=${token}`)).status, 200, 'a stranger logged someone out');
});

// ─── FIX 3: session-token reuse, now that the row can name its owner ─────────

test('a second page load reuses the row rather than adding one', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  const first = await mintSession(env, session);
  const second = await mintSession(env, session);
  assert.equal(second.token, first.token);
  assert.equal(second.expires_at, first.expires_at);
  const { n } = env.DB._db.prepare("SELECT COUNT(*) AS n FROM share_tokens WHERE kind = 'session'").get();
  assert.equal(n, 1, `${n} rows after two page loads`);
});

test('two clients are never handed the same row, even sharing a folder', async () => {
  const env = setup();
  const one = await seedUser(env, { id: 1, folder_path: MINE });
  const two = await seedUser(env, { id: 2, folder_path: MINE });
  assert.notEqual((await mintSession(env, one)).token, (await mintSession(env, two)).token);
});

test('a narrowed folder is not served from the row minted before it', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1, folder_path: MINE });
  const before = await mintSession(env, session);
  await call(env, '/api/admin/clients/1/permissions', {
    method: 'PUT', token: SECRET, body: JSON.stringify({ folder_path: THEIRS }),
  });
  const after = await mintSession(env, session);
  assert.notEqual(after.token, before.token, 'the stale snapshot was handed back');
  assert.deepEqual(after.folders, [THEIRS]);
  assert.equal((await call(env, `/20260901/x.jpg?t=${after.token}`)).status, 200);
  assert.equal((await call(env, `/20260819/a.jpg?t=${after.token}`)).status, 401);
});

test('an album link carrying a hand-edited user_id is not reused as a client’s token', async () => {
  // user_id is written by one route today, so the owner alone looks like key
  // enough — but rows get hand-edited in the D1 console, and an album link
  // handed back here would put a 90-day link in a client's image URLs and
  // leave a logout deleting it. What refuses is the kind, not the owner.
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  // issued seventy days ago, so its remaining twenty fall INSIDE this
  // session's thirty — otherwise the clamp refuses it and the kind check is
  // never the thing under test
  await env.DB.prepare(
    `INSERT INTO share_tokens (token, book_id, user_id, folders, created_at, expires_at) VALUES ('TK', 'b1', 1, '["${MINE}"]', ?, ?)`
  ).bind(days(-70), days(20)).run();
  const { token } = await mintSession(env, session);
  assert.notEqual(token, 'TK', 'a 90-day album link was handed back as an hour-long client token');
  const ttl = (Date.parse(row(env, token).expires_at) - Date.now()) / 3600000;
  assert.ok(ttl > 0.9 && ttl <= 1, `ttl ${ttl} hours`);
  assert.equal(row(env, 'TK').kind, 'client', 'the album link was rewritten');
});

test('a revoked row is not handed back to the next page load', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  const first = (await mintSession(env, session)).token;
  await call(env, '/api/shares/minted/revoke-all', { method: 'POST', token: SECRET });
  const second = (await mintSession(env, session)).token;
  assert.notEqual(second, first, 'the revoked row came straight back');
  assert.equal((await call(env, `/20260819/a.jpg?t=${second}`)).status, 200);
  assert.equal((await call(env, `/20260819/a.jpg?t=${first}`)).status, 401);
});

test('a reuse candidate too close to its deadline is replaced', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1 });
  await env.DB.prepare(
    `INSERT INTO share_tokens (token, book_id, kind, user_id, folders, created_at, expires_at) VALUES ('CS', '', 'session', 1, '["${MINE}"]', ?, ?)`
  ).bind(hours(-1), hours(5 / 60)).run();
  const { token, expires_at } = await mintSession(env, session);
  assert.notEqual(token, 'CS', 'handed back a token with five minutes left');
  const ttl = (Date.parse(expires_at) - Date.now()) / 60000;
  assert.ok(ttl > 55 && ttl <= 60, `ttl ${ttl} minutes`);
});

test('a reused row cannot carry a shorter session past its own end', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1 });     // 30 days
  const long = await mintSession(env, session);        // clamped to an hour
  await addSession(env, 1, 'SHORT', sqlTime(10 / 60)); // this device has 10 minutes
  const short = await mintSession(env, 'SHORT');
  assert.notEqual(short.token, long.token, 'the short session was handed the long session’s hour');
  const ttl = (Date.parse(short.expires_at) - Date.now()) / 60000;
  assert.ok(ttl > 9 && ttl <= 10.1, `ttl ${ttl} minutes`);
});

// ─── FIX 4a: the photographer's own reads are not for a shared cache ─────────

test('an admin read is not cacheable by a shared cache either', async () => {
  const env = setup();
  const res = await call(env, '/20260819/a.jpg', { token: SECRET });
  assert.equal(res.status, 200);
  // the URL carries no credential at all, so a proxy that kept this would
  // hand the photo to the next request that guessed the URL
  assert.match(res.headers.get('Cache-Control'), /^private,/);
  assert.match(res.headers.get('Vary') || '', /Authorization/i);
  // the rest of the caching contract is unchanged
  assert.match(res.headers.get('Cache-Control'), /max-age=86400, stale-while-revalidate=604800/);
});

test('an admin listing and status read say how they may be cached', async () => {
  const env = setup();
  for (const path of [`/?list=${encodeURIComponent(MINE)}`, '/api/books/b1/status']) {
    const res = await call(env, path, { token: SECRET });
    assert.equal(res.status, 200, path);
    const cc = res.headers.get('Cache-Control');
    assert.ok(cc, `${path} sends no cache directive at all`);
    assert.match(cc, /^private|no-store/, `${path} is cacheable by a shared cache: ${cc}`);
    assert.match(res.headers.get('Vary') || '', /Authorization/i, `${path} does not vary on the credential`);
  }
});

test('the album the photographer reads back is not for a shared cache to keep', async () => {
  // this is the response that carries notifyUrl in full — a bearer webhook
  // secret that revoking a link does not revoke. `no-cache` governs whether a
  // stored response may be SERVED, not whether it may be STORED, so without
  // `private` a shared cache is entitled to hold the secret on disk.
  const env = setup();
  const res = await call(env, '/api/books/b1', { token: SECRET });
  assert.equal(res.status, 200);
  assert.equal((await res.text()).includes('BEARER-SECRET'), true, 'the fixture lost the secret');
  const cc = res.headers.get('Cache-Control');
  assert.match(cc, /(^|[\s,])private([\s,]|$)/, `a shared cache may store this: ${cc}`);
  // and it still revalidates, which is what stopped a client seeing a stale album
  assert.match(cc, /(^|[\s,])no-cache([\s,]|$)/, `a saved edit could be served stale: ${cc}`);
});

// ─── FIX 4b: a slot photoId that is not a string ─────────────────────────────

test('a photoId that is not a string is refused, not thrown on', async () => {
  // folderCovers calls startsWith on it; a number reaches the runtime as an
  // uncaught TypeError and the client sees a 1101, not a refusal
  const env = setup();
  for (const photoId of [5, true, ['20260819/a.jpg'], { id: '20260819/a.jpg' }]) {
    const res = await call(env, '/api/books/b1', {
      method: 'PATCH', token: SECRET,
      body: JSON.stringify({ pageIndex: 0, slots: [{ photoId }] }),
    });
    assert.equal(res.status, 400, `photoId ${JSON.stringify(photoId)}`);
    const stored = JSON.parse(env.imagepicker._store.get('_books/b1.json').body);
    assert.equal(stored.pages[0].slots[0].photoId, '20260819/a.jpg', 'the page was written anyway');
  }
});

test('clearing a slot with a null photoId still works', async () => {
  const env = setup();
  const res = await call(env, '/api/books/b1', {
    method: 'PATCH', token: SECRET,
    body: JSON.stringify({ pageIndex: 0, slots: [{ photoId: null }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(env.imagepicker._store.get('_books/b1.json').body).pages[0].slots[0].photoId, null);
});
