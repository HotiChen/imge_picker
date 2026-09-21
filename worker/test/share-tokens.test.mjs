// Client share tokens. Before these, `?list=`, `/<key>` and every /api/books
// route were open to anyone who guessed a folder name, so one client could
// read another's wedding photos.
//
// Two facts about LINE shape the design and so the tests: its crawler
// pre-fetches the link to build the preview card (so a fetch must never burn
// or bind the token, and must not count as "the client opened it"), and the
// client reopens the same chat link over and over (so the token rides in the
// query string).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { fakeBucket, fakeDB, ctx, req } from './fakes.mjs';

const SECRET = 'photographer-secret';
const MINE = '20260819/';

const BOOK = {
  name: '王先生 婚紗',
  clientFolders: [MINE],
  notifyUrl: 'https://notify-api.line.me/api/notify?token=SUPER-SECRET-WEBHOOK',
  settings: { width: 20, height: 20, unit: 'cm', dpi: 300 },
  coverSettings: { width: 22, height: 22, unit: 'cm', dpi: 300 },
  _customLayouts: { 'my-3up': { name: '三格', slots: [{}, {}, {}] } },
  pages: [
    {
      type: 'cover', layout: 'my-3up',
      slots: [
        { photoId: '20260819/a.jpg', crop: { x: 0, y: 0, scale: 1 } },
        // the photographer placed one from a different shoot
        { photoId: '20260901/x.jpg', crop: {} },
      ],
    },
    { type: 'inner', locked: true, slots: [{ photoId: null, crop: {} }] },
  ],
};

const OTHER_BOOK = {
  name: '陳小姐 婚紗',
  clientFolders: ['20260901/'],
  pages: [{ type: 'cover', slots: [{ photoId: null, crop: {} }] }],
};

const OBJECTS = {
  '_books/b1.json': JSON.stringify(BOOK),
  '_books/b2.json': JSON.stringify(OTHER_BOOK),
  '20260819/a.jpg': 'MINE-A',
  '20260819/sub/b.jpg': 'MINE-SUB-B',
  // the sibling that a naive startsWith('20260819') prefix check would leak
  '20260819-other/secret.jpg': 'NOT-MINE',
  '20260901/x.jpg': 'OTHER-BOOK-X',
  '_thumbs/400/20260819/a.jpg.thumb': 'MINE-A-THUMB',
  '_thumbs/400/20260819-other/secret.jpg.thumb': 'NOT-MINE-THUMB',
};

const days = n => new Date(Date.now() + n * 86400000).toISOString();

function setup() {
  return { imagepicker: fakeBucket(OBJECTS), DB: fakeDB(), PHOTOGRAPHER_TOKEN: SECRET };
}

const call = (env, path, opts = {}) => worker.fetch(req(path, opts), env, ctx);

async function seed(env, overrides = {}) {
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

const row = (env, token) =>
  env.DB._db.prepare('SELECT * FROM share_tokens WHERE token = ?').get(token);

// every route a client's browser touches while viewing an album
const gated = token => [
  ['GET', `/?list=${encodeURIComponent(MINE)}`],
  ['GET', '/20260819/a.jpg'],
  ['GET', '/api/books/b1'],
  ['GET', '/api/books/b1/status'],
  ['POST', '/api/books/b1/approve'],
];

// ─── the gate itself ─────────────────────────────────────────────────────────

test('with no share token every client route is refused', async () => {
  const env = setup();
  await seed(env);
  for (const [method, path] of gated()) {
    const res = await call(env, path, { method });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  const patch = await call(env, '/api/books/b1', {
    method: 'PATCH', body: JSON.stringify({ pageIndex: 0, slots: [] }),
  });
  assert.equal(patch.status, 401, 'PATCH /api/books/b1');
});

test('a guessed share token is refused', async () => {
  const env = setup();
  await seed(env);
  for (const [method, path] of gated()) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await call(env, `${path}${sep}t=not-a-real-token`, { method });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test('a revoked token behaves exactly like no token', async () => {
  const env = setup();
  await seed(env, { revoked_at: days(-0.5) });
  for (const [method, path] of gated()) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await call(env, `${path}${sep}t=TK`, { method });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test('an expired token behaves exactly like no token', async () => {
  const env = setup();
  await seed(env, { expires_at: days(-1) });
  for (const [method, path] of gated()) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await call(env, `${path}${sep}t=TK`, { method });
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test('an expired token is not resurrected by the sliding-expiry bump', async () => {
  const env = setup();
  await seed(env, { expires_at: days(-1), last_seen_at: days(-30) });
  const before = row(env, 'TK').expires_at;
  assert.equal((await call(env, '/20260819/a.jpg?t=TK')).status, 401);
  assert.equal(row(env, 'TK').expires_at, before, 'a refused request must not bump the expiry');
  assert.ok(Date.parse(row(env, 'TK').expires_at) < Date.now(), 'still expired');
});

test('a valid token reads the album it was issued for', async () => {
  const env = setup();
  await seed(env);
  for (const [method, path] of gated()) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await call(env, `${path}${sep}t=TK`, { method });
    assert.equal(res.status, 200, `${method} ${path}`);
  }
});

test('the token may also arrive as a header', async () => {
  const env = setup();
  await seed(env);
  const res = await call(env, '/20260819/a.jpg', { headers: { 'X-Share-Token': 'TK' } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'MINE-A');
});

// ─── what the token's folders do and do not cover ────────────────────────────

test('a token reads photos inside its folders, including sub-folders', async () => {
  const env = setup();
  await seed(env);
  assert.equal(await (await call(env, '/20260819/a.jpg?t=TK')).text(), 'MINE-A');
  assert.equal(await (await call(env, '/20260819/sub/b.jpg?t=TK')).text(), 'MINE-SUB-B');
  const listed = await (await call(env, `/?list=${encodeURIComponent('20260819/sub/')}&t=TK`)).json();
  assert.equal(listed.data.length, 1);
});

test('a token cannot read a folder outside its snapshot', async () => {
  const env = setup();
  await seed(env);
  assert.equal((await call(env, '/20260901/x.jpg?t=TK')).status, 401, 'other book folder');
  assert.equal((await call(env, `/?list=${encodeURIComponent('20260901/')}&t=TK`)).status, 401);
});

test('a folder prefix only matches on a slash boundary', async () => {
  // `20260819-other/` shares a string prefix with `20260819/` but is a
  // different client's folder
  const env = setup();
  await seed(env);
  assert.equal((await call(env, '/20260819-other/secret.jpg?t=TK')).status, 401, 'sibling object');
  assert.equal((await call(env, `/?list=${encodeURIComponent('20260819-other/')}&t=TK`)).status, 401, 'sibling listing');
  // and a token stored without the trailing slash must not widen it either
  const env2 = setup();
  await seed(env2, { folders: ['20260819'] });
  assert.equal((await call(env2, '/20260819-other/secret.jpg?t=TK')).status, 401, 'sibling via slashless folder');
  assert.equal((await call(env2, '/20260819/a.jpg?t=TK')).status, 200, 'own folder via slashless folder');
});

test('listing the bucket root is refused even though the token has folders', async () => {
  const env = setup();
  await seed(env);
  assert.equal((await call(env, '/?list=&t=TK')).status, 401, 'empty prefix');
  // a prefix that stops one character short of the slash would list siblings
  assert.equal((await call(env, '/?list=20260819&t=TK')).status, 401, 'slashless prefix');
});

test('a path cannot be walked out of the token folders', async () => {
  const env = setup();
  await seed(env);
  for (const path of [
    '/20260819/%2e%2e/20260901/x.jpg',
    '/20260819/..%2f20260901%2fx.jpg',
    '/?list=' + encodeURIComponent('20260819/../'),
  ]) {
    const sep = path.includes('?') ? '&' : '?';
    assert.equal((await call(env, `${path}${sep}t=TK`)).status, 401, path);
  }
});

test('a thumbnail is gated by the photo it is a thumbnail of', async () => {
  const env = setup();
  await seed(env);
  assert.equal(await (await call(env, '/20260819/a.jpg?w=400&t=TK')).text(), 'MINE-A-THUMB');
  const direct = await call(env, `/${encodeURIComponent('_thumbs/400/20260819/a.jpg.thumb')}?t=TK`);
  assert.equal(direct.status, 200, 'own thumbnail read directly');
  const stolen = await call(env, `/${encodeURIComponent('_thumbs/400/20260819-other/secret.jpg.thumb')}?t=TK`);
  assert.equal(stolen.status, 401, 'another client thumbnail read directly');
});

test('a token for one book cannot touch another book', async () => {
  const env = setup();
  await seed(env, { book_id: 'b1' });
  assert.equal((await call(env, '/api/books/b2?t=TK')).status, 401);
  assert.equal((await call(env, '/api/books/b2/status?t=TK')).status, 401);
  assert.equal((await call(env, '/api/books/b2/approve?t=TK', { method: 'POST' })).status, 401);
  const patch = await call(env, '/api/books/b2?t=TK', {
    method: 'PATCH', body: JSON.stringify({ pageIndex: 0, slots: [{ photoId: '20260901/x.jpg' }] }),
  });
  assert.equal(patch.status, 401);
});

test('approving another book writes nothing', async () => {
  const env = setup();
  await seed(env);
  await call(env, '/api/books/b2/approve?t=TK', { method: 'POST' });
  assert.equal(env.imagepicker._store.has('_books/b2_status.json'), false);
});

// ─── the book-edit guards survive the new gate ───────────────────────────────

test('a token holder still cannot edit a locked page', async () => {
  const env = setup();
  await seed(env);
  const res = await call(env, '/api/books/b1?t=TK', {
    method: 'PATCH', body: JSON.stringify({ pageIndex: 1, slots: [{ photoId: '20260819/sub/b.jpg' }] }),
  });
  assert.equal(res.status, 403);
});

test('a token holder still cannot pull in a photo outside clientFolders', async () => {
  const env = setup();
  await seed(env);
  const res = await call(env, '/api/books/b1?t=TK', {
    method: 'PATCH', body: JSON.stringify({ pageIndex: 0, slots: [{ photoId: '20260901/x.jpg' }] }),
  });
  assert.equal(res.status, 403);
});

test('a token holder can swap a photo from an opened folder', async () => {
  const env = setup();
  await seed(env);
  const res = await call(env, '/api/books/b1?t=TK', {
    method: 'PATCH', body: JSON.stringify({ pageIndex: 0, slots: [{ photoId: '20260819/sub/b.jpg' }] }),
  });
  assert.equal(res.status, 200);
  const saved = JSON.parse(env.imagepicker._store.get('_books/b1.json').body);
  assert.equal(saved.pages[0].slots[0].photoId, '20260819/sub/b.jpg');
});

test('a share token cannot overwrite a whole book', async () => {
  const env = setup();
  await seed(env);
  const res = await call(env, '/api/books/b1?t=TK', { method: 'PUT', body: '{"name":"pwned"}' });
  assert.equal(res.status, 401);
  assert.equal(JSON.parse(env.imagepicker._store.get('_books/b1.json').body).name, '王先生 婚紗');
});

// ─── the admin keeps full access ─────────────────────────────────────────────

test('the photographer token still opens everything', async () => {
  const env = setup();
  const opts = { token: SECRET };
  assert.equal((await call(env, '/?list=', opts)).status, 200);
  assert.equal((await call(env, '/20260901/x.jpg', opts)).status, 200);
  assert.equal((await call(env, '/api/books/b2', opts)).status, 200);
  assert.equal((await call(env, '/api/books/b2/status', opts)).status, 200);
  assert.equal((await call(env, '/api/books/b2/approve', { ...opts, method: 'POST' })).status, 200);
  assert.equal((await call(env, '/api/books/b1', {
    ...opts, method: 'PATCH', body: JSON.stringify({ pageIndex: 0, slots: [{ photoId: '20260819/a.jpg' }] }),
  })).status, 200);
});

test('an admin read is not marked private, a share-token read is', async () => {
  const env = setup();
  await seed(env);
  const admin = await call(env, '/20260819/a.jpg', { token: SECRET });
  assert.match(admin.headers.get('Cache-Control'), /^public,/);
  const client = await call(env, '/20260819/a.jpg?t=TK');
  assert.match(client.headers.get('Cache-Control'), /^private,/,
    'a shared-link photo must not be cached by a shared proxy');
  // the rest of the caching contract is unchanged
  assert.match(client.headers.get('Cache-Control'), /max-age=86400, stale-while-revalidate=604800/);
});

// ─── sliding expiry, crawlers and the D1 write throttle ──────────────────────

test('a genuine visit slides the expiry out to 90 days', async () => {
  const env = setup();
  await seed(env, { expires_at: days(10), last_seen_at: days(-3) });
  await call(env, '/20260819/a.jpg?t=TK');
  const after = row(env, 'TK');
  const extended = (Date.parse(after.expires_at) - Date.now()) / 86400000;
  assert.ok(extended > 89 && extended <= 90, `expiry moved to ${extended} days, expected ~90`);
  assert.ok(Date.now() - Date.parse(after.last_seen_at) < 5000, 'last_seen_at should be now');
});

test('a LINE preview crawler does not count as the client opening the link', async () => {
  for (const ua of [
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Mozilla/5.0 (compatible; Line-Poker/1.0)',
  ]) {
    const env = setup();
    await seed(env, { expires_at: days(10), last_seen_at: days(-3) });
    const before = row(env, 'TK');
    const res = await call(env, '/20260819/a.jpg?t=TK', { headers: { 'User-Agent': ua } });
    // the crawler still has to be able to fetch, or there is no preview card
    assert.equal(res.status, 200, ua);
    const after = row(env, 'TK');
    assert.equal(after.last_seen_at, before.last_seen_at, `last_seen_at moved for ${ua}`);
    assert.equal(after.expires_at, before.expires_at, `expires_at moved for ${ua}`);
  }
});

test('a crawler pre-fetch does not burn the token for the human who clicks next', async () => {
  const env = setup();
  await seed(env);
  await call(env, '/api/books/b1?t=TK', { headers: { 'User-Agent': 'facebookexternalhit/1.1' } });
  assert.equal((await call(env, '/api/books/b1?t=TK')).status, 200);
});

test('reading an album one image after another issues one D1 write, not one per image', async () => {
  const env = setup();
  await seed(env, { last_seen_at: days(-3) });
  const before = env.DB._writes().length;
  for (let i = 0; i < 200; i++) await call(env, '/20260819/a.jpg?t=TK');
  const writes = env.DB._writes().length - before;
  assert.equal(writes, 1, `${writes} D1 writes for one album view; the throttle is not throttling`);
});

// A browser opens an album's images in parallel, and the throttle reads
// last_seen_at and writes it back with nothing atomic in between — so every
// one of those requests sees the same stale timestamp and tries to bump. The
// statement count can only be bounded by the request count here; what must
// stay at one is the number of rows that actually change.
test('a whole album loading at once changes the row once, though it still issues a statement per request', async () => {
  const env = setup();
  await seed(env, { expires_at: days(10), last_seen_at: days(-3) });
  const before = env.DB._changed();
  await Promise.all(Array.from({ length: 200 }, () => call(env, '/20260819/a.jpg?t=TK')));
  const changed = env.DB._changed() - before;
  assert.equal(changed, 1, `${changed} rows changed for one album view; the UPDATE is not self-guarded`);
  const extended = (Date.parse(row(env, 'TK').expires_at) - Date.now()) / 86400000;
  assert.ok(extended > 89 && extended <= 90, `expiry ended up at ${extended} days`);
});

test('a second visit within the day does not rewrite the row', async () => {
  const env = setup();
  await seed(env, { expires_at: days(88), last_seen_at: new Date().toISOString() });
  const before = row(env, 'TK');
  await call(env, '/20260819/a.jpg?t=TK');
  const after = row(env, 'TK');
  assert.equal(after.last_seen_at, before.last_seen_at);
  assert.equal(after.expires_at, before.expires_at);
});

// ─── issuing, listing and revoking (photographer only) ───────────────────────

test('issuing a link requires the photographer token', async () => {
  const env = setup();
  await seed(env);
  assert.equal((await call(env, '/api/books/b1/share', { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await call(env, '/api/books/b1/share?t=TK', { method: 'POST', body: '{}' })).status, 401,
    'a share token must not mint more share tokens');
  assert.equal((await call(env, '/api/books/b1/shares')).status, 401);
  assert.equal((await call(env, '/api/books/b1/shares?t=TK')).status, 401);
  assert.equal((await call(env, '/api/shares/TK/revoke', { method: 'POST' })).status, 401);
  assert.equal((await call(env, '/api/shares/TK/revoke?t=TK', { method: 'POST' })).status, 401);
});

test('an issued link opens the album and nothing else', async () => {
  const env = setup();
  const res = await call(env, '/api/books/b1/share', {
    method: 'POST', token: SECRET, body: JSON.stringify({ label: '王先生 婚紗' }),
  });
  assert.equal(res.status, 200);
  const { token, expires_at } = await res.json();
  assert.ok(token, 'an issued link must carry a token');
  // 32 random bytes, base64url
  assert.match(token, /^[A-Za-z0-9_-]{43}$/, `token looks weak: ${token}`);
  const ttl = (Date.parse(expires_at) - Date.now()) / 86400000;
  assert.ok(ttl > 89 && ttl <= 90, `ttl ${ttl} days`);

  assert.equal((await call(env, `/api/books/b1?t=${token}`)).status, 200);
  assert.equal((await call(env, `/20260819/a.jpg?t=${token}`)).status, 200);
  assert.equal((await call(env, `/20260901/x.jpg?t=${token}`)).status, 401);
  assert.equal((await call(env, `/api/books/b2?t=${token}`)).status, 401);
});

test('two issued links are different tokens', async () => {
  const env = setup();
  const mint = async () => (await (await call(env, '/api/books/b1/share', {
    method: 'POST', token: SECRET, body: '{}',
  })).json()).token;
  assert.notEqual(await mint(), await mint());
});

test('the folders are snapshotted at issue time, so widening the book later does not widen the link', async () => {
  const env = setup();
  const { token } = await (await call(env, '/api/books/b1/share', {
    method: 'POST', token: SECRET, body: '{}',
  })).json();
  await env.imagepicker.put('_books/b1.json',
    JSON.stringify({ ...BOOK, clientFolders: [MINE, '20260901/'] }));
  assert.equal((await call(env, `/20260901/x.jpg?t=${token}`)).status, 401);
});

test('the photographer can see which links exist, and revoke one', async () => {
  const env = setup();
  const { token } = await (await call(env, '/api/books/b1/share', {
    method: 'POST', token: SECRET, body: JSON.stringify({ label: '王先生 婚紗' }),
  })).json();

  const listed = await (await call(env, '/api/books/b1/shares', { token: SECRET })).json();
  assert.equal(listed.length, 1);
  const entry = listed[0];
  for (const field of ['label', 'created_at', 'expires_at', 'revoked_at', 'last_seen_at']) {
    assert.ok(field in entry, `the revoke UI needs ${field}`);
  }
  assert.equal(entry.label, '王先生 婚紗');

  assert.equal((await call(env, `/api/shares/${token}/revoke`, { method: 'POST', token: SECRET })).status, 200);
  assert.equal((await call(env, `/api/books/b1?t=${token}`)).status, 401, 'revoked link still works');
  assert.equal((await call(env, `/20260819/a.jpg?t=${token}`)).status, 401);
  const after = await (await call(env, '/api/books/b1/shares', { token: SECRET })).json();
  assert.ok(after[0].revoked_at, 'the revoked link should show when it was revoked');
});

test('one book’s link list does not show another book’s links', async () => {
  const env = setup();
  await call(env, '/api/books/b1/share', { method: 'POST', token: SECRET, body: '{}' });
  const listed = await (await call(env, '/api/books/b2/shares', { token: SECRET })).json();
  assert.deepEqual(listed, []);
});

// ─── degrading safely ────────────────────────────────────────────────────────

test('with no D1 bound a share token is simply not a share token', async () => {
  const env = { imagepicker: fakeBucket(OBJECTS), PHOTOGRAPHER_TOKEN: SECRET };
  for (const path of ['/20260819/a.jpg?t=TK', '/?list=20260819%2F&t=TK', '/api/books/b1?t=TK']) {
    const res = await call(env, path);
    assert.equal(res.status, 401, path); // refused, not a 500
  }
  assert.equal((await call(env, '/20260819/a.jpg', { token: SECRET })).status, 200,
    'the photographer still gets through without D1');
});

test('a share token cannot reach the studio admin API', async () => {
  const env = setup();
  await seed(env);
  assert.equal((await call(env, '/api/admin/clients?t=TK')).status, 401);
  assert.equal((await call(env, '/2026/new.jpg?t=TK', { method: 'PUT', body: 'x' })).status, 401);
});

test('a token whose snapshot is empty opens nothing', async () => {
  // a book with no clientFolders yet still mints a link; it must not become a
  // skeleton key for the whole bucket
  for (const folders of [[], [''], ['/']]) {
    const env = setup();
    await seed(env, { folders });
    assert.equal((await call(env, '/20260819/a.jpg?t=TK')).status, 401, JSON.stringify(folders));
    assert.equal((await call(env, '/20260901/x.jpg?t=TK')).status, 401, JSON.stringify(folders));
    assert.equal((await call(env, '/?list=20260819%2F&t=TK')).status, 401, JSON.stringify(folders));
    // `//x.jpg` reaches the worker as the key `/x.jpg`, so a bare `/` folder
    // is a skeleton key rather than the no-op it looks like
    assert.equal((await call(env, '//20260819/a.jpg?t=TK')).status, 401, JSON.stringify(folders));
    // the book itself is still reachable — the link is for that album
    assert.equal((await call(env, '/api/books/b1?t=TK')).status, 200, JSON.stringify(folders));
  }
});

test('a token row with a corrupt folders column is refused, not a crash', async () => {
  // rows get hand-edited in the D1 console; a broken one must fail closed
  for (const folders of ['not json', 'null', '"20260819/"', '{}', '']) {
    const env = setup();
    await env.DB.prepare(
      'INSERT INTO share_tokens (token, book_id, label, folders, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind('TK', 'b1', '', folders, days(-1), days(89)).run();
    assert.equal((await call(env, '/20260819/a.jpg?t=TK')).status, 401, JSON.stringify(folders));
    assert.equal((await call(env, '/api/books/b1?t=TK')).status, 401, JSON.stringify(folders));
  }
});

// ─── what a share-token holder is allowed to SEE of the book ─────────────────

test('the album handed to a client carries no photographer secrets', async () => {
  const env = setup();
  await seed(env);
  const view = await (await call(env, '/api/books/b1?t=TK')).json();

  // notifyUrl is a bearer webhook. Forwarded in a LINE group it lets anyone
  // post into the photographer's notification channel, and revoking the share
  // token does not revoke it — it has to be rotated by hand.
  assert.equal('notifyUrl' in view, false, 'the webhook URL must not reach the client');
  assert.equal(JSON.stringify(view).includes('SUPER-SECRET-WEBHOOK'), false,
    'the webhook must not survive anywhere in the payload');
  for (const leaked of ['notifyUrl', 'ownerId', 'adminNotes', 'notify_url']) {
    assert.equal(leaked in view, false, `${leaked} must not be whitelisted in`);
  }
});

test('the client is told its own folders, not the book’s current ones', async () => {
  const env = setup();
  await seed(env, { folders: [MINE] });
  await env.imagepicker.put('_books/b1.json',
    JSON.stringify({ ...BOOK, clientFolders: [MINE, '20260901/', '20261225/'] }));
  const view = await (await call(env, '/api/books/b1?t=TK')).json();
  // the viewer builds its photo picker from this; the book's list is wider
  // than the token and every extra folder would just 401 on fetch
  assert.deepEqual(view.clientFolders, [MINE]);
});

test('the projected album still carries everything the viewer renders from', async () => {
  const env = setup();
  await seed(env);
  const view = await (await call(env, '/api/books/b1?t=TK')).json();
  assert.equal(view.name, '王先生 婚紗');
  assert.deepEqual(view.settings, BOOK.settings);
  assert.deepEqual(view.coverSettings, BOOK.coverSettings);
  // without this every page on a custom layout silently falls back to a
  // default one — a whitelist that breaks the album is worse than the leak
  assert.deepEqual(view._customLayouts, BOOK._customLayouts);
  assert.equal(view.pages.length, 2);
  assert.equal(view.pages[0].layout, 'my-3up');
  assert.equal(view.pages[1].locked, true);
});

test('a slot the client cannot fetch keeps its photoId, so saving cannot erase it', async () => {
  // the viewer PATCHes back `page.slots` wholesale, so a photoId nulled out on
  // read would be written back as null and destroy the photographer's work
  const env = setup();
  await seed(env);
  const view = await (await call(env, '/api/books/b1?t=TK')).json();
  assert.equal(view.pages[0].slots[1].photoId, '20260901/x.jpg');

  await call(env, '/api/books/b1?t=TK', {
    method: 'PATCH',
    body: JSON.stringify({ pageIndex: 0, slots: view.pages[0].slots }),
  });
  const stored = JSON.parse(env.imagepicker._store.get('_books/b1.json').body);
  assert.equal(stored.pages[0].slots[1].photoId, '20260901/x.jpg',
    'a client round-trip must not wipe a slot it was not allowed to fetch');
});

test('the photographer still gets the whole book, webhook included', async () => {
  const env = setup();
  const view = await (await call(env, '/api/books/b1', { token: SECRET })).json();
  assert.equal(view.notifyUrl, BOOK.notifyUrl);
  assert.deepEqual(view.clientFolders, [MINE]);
});

// ─── what a share-token holder is allowed to WRITE ───────────────────────────

test('widening the book does not widen a link already sent out', async () => {
  const env = setup();
  await seed(env, { folders: [MINE] });
  await env.imagepicker.put('_books/b1.json',
    JSON.stringify({ ...BOOK, clientFolders: [MINE, '20260901/'] }));
  const res = await call(env, '/api/books/b1?t=TK', {
    method: 'PATCH', body: JSON.stringify({ pageIndex: 0, slots: [{ photoId: '20260901/x.jpg' }] }),
  });
  assert.equal(res.status, 403, 'the live book, not the snapshot, decided what may be placed');
  const stored = JSON.parse(env.imagepicker._store.get('_books/b1.json').body);
  assert.equal(stored.pages[0].slots[0].photoId, '20260819/a.jpg');
});

test('a book with no clientFolders is not an open door for a share token', async () => {
  // empty is the default for a new book, and it used to skip validation
  const env = setup();
  await seed(env, { folders: [MINE] });
  await env.imagepicker.put('_books/b1.json', JSON.stringify({ ...BOOK, clientFolders: [] }));
  const res = await call(env, '/api/books/b1?t=TK', {
    method: 'PATCH', body: JSON.stringify({ pageIndex: 0, slots: [{ photoId: '20260901/x.jpg' }] }),
  });
  assert.equal(res.status, 403);
});

test('placing a photo is checked on a slash boundary, not by naive startsWith', async () => {
  for (const clientFolders of [['20260819'], ['20260819/']]) {
    const env = setup();
    await seed(env, { folders: ['20260819'] });
    await env.imagepicker.put('_books/b1.json', JSON.stringify({ ...BOOK, clientFolders }));
    const res = await call(env, '/api/books/b1?t=TK', {
      method: 'PATCH', body: JSON.stringify({ pageIndex: 0, slots: [{ photoId: '20260819-other/secret.jpg' }] }),
    });
    assert.equal(res.status, 403, JSON.stringify(clientFolders));
    const ok = await call(env, '/api/books/b1?t=TK', {
      method: 'PATCH', body: JSON.stringify({ pageIndex: 0, slots: [{ photoId: '20260819/sub/b.jpg' }] }),
    });
    assert.equal(ok.status, 200, JSON.stringify(clientFolders));
  }
});

test('a token holder is bounded by the book policy AND their own snapshot', async () => {
  const env = setup();
  await seed(env, { folders: ['20260819/sub/'] });
  // the book opens all of 20260819/, the token only the sub-folder
  const inBoth = await call(env, '/api/books/b1?t=TK', {
    method: 'PATCH', body: JSON.stringify({ pageIndex: 0, slots: [{ photoId: '20260819/sub/b.jpg' }] }),
  });
  assert.equal(inBoth.status, 200);
  const bookOnly = await call(env, '/api/books/b1?t=TK', {
    method: 'PATCH', body: JSON.stringify({ pageIndex: 0, slots: [{ photoId: '20260819/a.jpg' }] }),
  });
  assert.equal(bookOnly.status, 403, 'the book allows it but the token snapshot does not');
});

// The book's own clientFolders check is the only thing bounding the
// photographer, so the slash boundary on it can only be tested there — on the
// client path the token snapshot masks it.
test('the book policy itself matches on a slash boundary, on the admin path too', async () => {
  const env = setup();
  await env.imagepicker.put('_books/b1.json', JSON.stringify({ ...BOOK, clientFolders: ['20260819'] }));
  const sibling = await call(env, '/api/books/b1', {
    token: SECRET, method: 'PATCH',
    body: JSON.stringify({ pageIndex: 0, slots: [{ photoId: '20260819-other/secret.jpg' }] }),
  });
  assert.equal(sibling.status, 403, 'a slashless policy entry must not reach the sibling folder');
  const own = await call(env, '/api/books/b1', {
    token: SECRET, method: 'PATCH',
    body: JSON.stringify({ pageIndex: 0, slots: [{ photoId: '20260819/sub/b.jpg' }] }),
  });
  assert.equal(own.status, 200);
});

test('the photographer is bounded by the book policy only', async () => {
  const env = setup();
  await env.imagepicker.put('_books/b1.json', JSON.stringify({ ...BOOK, clientFolders: [] }));
  // an empty policy is no policy, and the photographer has no snapshot
  const res = await call(env, '/api/books/b1', {
    token: SECRET, method: 'PATCH',
    body: JSON.stringify({ pageIndex: 0, slots: [{ photoId: '20260901/x.jpg' }] }),
  });
  assert.equal(res.status, 200);
});

// ─── shared caches ───────────────────────────────────────────────────────────

test('nothing authorised by a share token is cacheable by a shared cache', async () => {
  const env = setup();
  await seed(env);
  const routes = [
    `/?list=${encodeURIComponent(MINE)}&t=TK`,
    '/api/books/b1?t=TK',
    '/api/books/b1/status?t=TK',
    '/20260819/a.jpg?t=TK',
  ];
  for (const path of routes) {
    const res = await call(env, path);
    assert.equal(res.status, 200, path);
    const cc = res.headers.get('Cache-Control');
    assert.ok(cc, `${path} sends no cache directive at all`);
    assert.match(cc, /^private|no-store/, `${path} is cacheable by a shared cache: ${cc}`);
    // the token is also accepted as a header, which no shared cache keys on
    assert.match(res.headers.get('Vary') || '', /X-Share-Token/i,
      `${path} does not vary on the header form of the token`);
  }
});

test('the photographer’s own book read is unchanged', async () => {
  const env = setup();
  const res = await call(env, '/api/books/b1', { token: SECRET });
  assert.equal(res.headers.get('Cache-Control'), 'no-cache');
});

// ─── the header form of the token, on every route ────────────────────────────

test('the header form of the token works on every client route', async () => {
  const env = setup();
  await seed(env);
  const headers = { 'X-Share-Token': 'TK' };
  assert.equal((await call(env, `/?list=${encodeURIComponent(MINE)}`, { headers })).status, 200, 'list');
  assert.equal((await call(env, '/api/books/b1', { headers })).status, 200, 'book');
  assert.equal((await call(env, '/api/books/b1/status', { headers })).status, 200, 'status');
  assert.equal((await call(env, '/api/books/b1/approve', { headers, method: 'POST' })).status, 200, 'approve');
  assert.equal((await call(env, '/20260819/a.jpg', { headers })).status, 200, 'object');
  // and still bounded by the same folders
  assert.equal((await call(env, '/20260901/x.jpg', { headers })).status, 401, 'object outside snapshot');
  assert.equal((await call(env, '/?list=20260901%2F', { headers })).status, 401, 'list outside snapshot');
});

test('a share token row cannot have a NULL token', async () => {
  // SQLite lets a TEXT PRIMARY KEY be NULL, and lets there be several
  const env = setup();
  assert.throws(() => env.DB._db.prepare(
    'INSERT INTO share_tokens (token, book_id, folders, created_at, expires_at) VALUES (NULL, ?, ?, ?, ?)'
  ).run('b1', '[]', days(0), days(90)), /NOT NULL/i);
});

// ─── the six-month ceiling ───────────────────────────────────────────────────
// The sliding expiry alone means a link forwarded into a LINE group never dies
// on its own. The effective expiry is min(now + 90d, created_at + 180d).

const CEILING_DAYS = 180;

test('a link opened steadily for six months dies anyway', async () => {
  const env = setup();
  // kept alive by daily visits right up to the ceiling: the stored column
  // still says it is live, and it must be refused regardless
  await seed(env, { created_at: days(-CEILING_DAYS - 1), expires_at: days(80), last_seen_at: days(-1) });
  for (const [method, path] of gated()) {
    const sep = path.includes('?') ? '&' : '?';
    assert.equal((await call(env, `${path}${sep}t=TK`, { method })).status, 401, `${method} ${path}`);
  }
});

test('the ceiling is enforced against created_at, not against the stored expiry', async () => {
  // a hand-edited or clock-skewed row must not buy itself extra life
  const env = setup();
  await seed(env, { created_at: days(-CEILING_DAYS - 1), expires_at: days(500) });
  assert.equal((await call(env, '/20260819/a.jpg?t=TK')).status, 401);
  assert.equal((await call(env, '/api/books/b1?t=TK')).status, 401);
});

test('a stored expiry beyond the ceiling is clamped, not treated as a forgery', async () => {
  // the same odd row inside its first six months is still a live link — the
  // ceiling is a deadline, not a tripwire
  const env = setup();
  await seed(env, { created_at: days(-10), expires_at: days(500) });
  assert.equal((await call(env, '/20260819/a.jpg?t=TK')).status, 200);
});

test('the last bump before the ceiling is clamped to it, not pushed 90 days out', async () => {
  const env = setup();
  await seed(env, { created_at: days(-(CEILING_DAYS - 1)), expires_at: days(10), last_seen_at: days(-3) });
  await call(env, '/20260819/a.jpg?t=TK');
  const left = (Date.parse(row(env, 'TK').expires_at) - Date.now()) / 86400000;
  assert.ok(left > 0.5 && left < 1.5, `expiry landed ${left} days out, expected ~1`);
});

test('a token created 179 days ago still works today', async () => {
  const env = setup();
  await seed(env, { created_at: days(-(CEILING_DAYS - 1)), expires_at: days(10), last_seen_at: days(-3) });
  assert.equal((await call(env, '/20260819/a.jpg?t=TK')).status, 200);
});

test('the photographer’s link list shows the real deadline, not a stale column', async () => {
  const env = setup();
  await seed(env, { created_at: days(-(CEILING_DAYS - 1)), expires_at: days(80), last_seen_at: days(-3) });
  await call(env, '/20260819/a.jpg?t=TK');
  const [entry] = await (await call(env, '/api/books/b1/shares', { token: SECRET })).json();
  const left = (Date.parse(entry.expires_at) - Date.now()) / 86400000;
  assert.ok(left < 1.5, `the revoke UI would claim ${left} more days than the link really has`);
});

test('a token at its ceiling still records visits, though its expiry stops moving', async () => {
  // the photographer reads last_seen_at off /shares to decide whether a link
  // is still in use before revoking it; freezing it for the back half of the
  // link's life would read as "nobody has touched this" while someone browses
  // it daily
  const env = setup();
  const created = days(-120);
  const ceiling = new Date(Date.parse(created) + CEILING_DAYS * 86400000).toISOString();
  await seed(env, { created_at: created, expires_at: ceiling, last_seen_at: days(-3) });
  const before = row(env, 'TK');
  const changedBefore = env.DB._changed();

  await Promise.all(Array.from({ length: 50 }, () => call(env, '/20260819/a.jpg?t=TK')));

  const after = row(env, 'TK');
  assert.equal(after.expires_at, before.expires_at, 'the ceiling pins the expiry');
  assert.notEqual(after.last_seen_at, before.last_seen_at,
    'a link being opened daily must not look untouched');
  assert.ok(Date.now() - Date.parse(after.last_seen_at) < 5000, 'last_seen_at should be now');
  // the throttle and the self-guarded UPDATE together: one row changed for a
  // whole album view, not one per image
  assert.equal(env.DB._changed() - changedBefore, 1, 'a D1 write per image');

  await call(env, '/20260819/a.jpg?t=TK');
  assert.equal(env.DB._changed() - changedBefore, 1, 'a later visit the same day must not write again');
});

test('a young token still gets the full 90 days', async () => {
  const env = setup();
  await seed(env, { created_at: days(-1), expires_at: days(10), last_seen_at: days(-3) });
  await call(env, '/20260819/a.jpg?t=TK');
  const left = (Date.parse(row(env, 'TK').expires_at) - Date.now()) / 86400000;
  assert.ok(left > 89 && left <= 90, `expiry landed ${left} days out, expected ~90`);
});

test('revocation still beats a token well inside its ceiling', async () => {
  const env = setup();
  await seed(env, { created_at: days(-1), expires_at: days(89), revoked_at: days(-0.5) });
  assert.equal((await call(env, '/20260819/a.jpg?t=TK')).status, 401);
  assert.equal((await call(env, '/api/books/b1?t=TK')).status, 401);
});

test('a row with an unreadable created_at fails closed', async () => {
  const env = setup();
  await seed(env, { created_at: 'sometime last spring', expires_at: days(89) });
  assert.equal((await call(env, '/20260819/a.jpg?t=TK')).status, 401);
});

// ─── approve fires the webhook once ──────────────────────────────────────────

function captureNotify() {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return Promise.resolve(new Response('ok'));
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

test('approving notifies the photographer once, however often the client taps', async () => {
  const env = setup();
  await seed(env);
  const notify = captureNotify();
  try {
    const first = await call(env, '/api/books/b1/approve?t=TK', { method: 'POST' });
    assert.equal(first.status, 200);
    assert.equal(notify.calls.length, 1, 'the first approval must notify');

    for (let i = 0; i < 5; i++) {
      const again = await call(env, '/api/books/b1/approve?t=TK', { method: 'POST' });
      // the viewer shows a success state off this; a double-tap is not an error
      assert.equal(again.status, 200, 'a repeat approval still succeeds');
      assert.deepEqual(await again.json(), { ok: true }, 'and returns the same shape');
    }
    assert.equal(notify.calls.length, 1,
      `the webhook fired ${notify.calls.length} times; anyone in the LINE group can spam it`);
  } finally { notify.restore(); }
});

test('a repeat approval keeps the moment the client actually approved', async () => {
  // seeded rather than produced by a first call: two calls a millisecond apart
  // would write the same ISO timestamp and the assertion could never fail
  const env = setup();
  await seed(env);
  const approvedAt = '2026-03-01T09:15:00.000Z';
  await env.imagepicker.put('_books/b1_status.json',
    JSON.stringify({ approved: true, timestamp: approvedAt }));
  const notify = captureNotify();
  try {
    await call(env, '/api/books/b1/approve?t=TK', { method: 'POST' });
    const after = JSON.parse(env.imagepicker._store.get('_books/b1_status.json').body);
    assert.equal(after.timestamp, approvedAt,
      'the approval time is a fact about the first approval, not the last tap');
    assert.equal(after.approved, true);
  } finally { notify.restore(); }
});

test('a repeat approval does not rewrite R2 either', async () => {
  const env = setup();
  await seed(env);
  const notify = captureNotify();
  try {
    await call(env, '/api/books/b1/approve?t=TK', { method: 'POST' });
    const before = env.imagepicker._puts.length;
    for (let i = 0; i < 5; i++) await call(env, '/api/books/b1/approve?t=TK', { method: 'POST' });
    assert.equal(env.imagepicker._puts.length - before, 0,
      'a held-down button should not turn into a write per tap');
  } finally { notify.restore(); }
});

test('a book explicitly marked unapproved still notifies when approved', async () => {
  const env = setup();
  await seed(env);
  await env.imagepicker.put('_books/b1_status.json', JSON.stringify({ approved: false }));
  const notify = captureNotify();
  try {
    await call(env, '/api/books/b1/approve?t=TK', { method: 'POST' });
    assert.equal(notify.calls.length, 1);
  } finally { notify.restore(); }
});

test('an unreadable status file fails toward notifying, not toward silence', async () => {
  // a missed notification is the photographer never learning the album is
  // approved; a duplicate is a second message in their chat
  const env = setup();
  await seed(env);
  await env.imagepicker.put('_books/b1_status.json', 'not json at all');
  const notify = captureNotify();
  try {
    const res = await call(env, '/api/books/b1/approve?t=TK', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(notify.calls.length, 1);
  } finally { notify.restore(); }
});

test('the photographer approving is idempotent too', async () => {
  const env = setup();
  const notify = captureNotify();
  try {
    await call(env, '/api/books/b1/approve', { method: 'POST', token: SECRET });
    await call(env, '/api/books/b1/approve', { method: 'POST', token: SECRET });
    assert.equal(notify.calls.length, 1);
  } finally { notify.restore(); }
});

test('the notification still carries what the photographer needs', async () => {
  const env = setup();
  await seed(env);
  const notify = captureNotify();
  try {
    await call(env, '/api/books/b1/approve?t=TK', { method: 'POST' });
    const [{ url, body }] = notify.calls;
    assert.equal(url, BOOK.notifyUrl);
    assert.equal(body.event, 'book_approved');
    assert.equal(body.bookId, 'b1');
    assert.equal(body.bookName, BOOK.name);
    const stored = JSON.parse(env.imagepicker._store.get('_books/b1_status.json').body);
    assert.equal(body.timestamp, stored.timestamp, 'the message and the record must agree');
  } finally { notify.restore(); }
});
