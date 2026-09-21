// A client account carries a SET of folders, not one.
//
// Two things the photographer hit in real use: a typo in the single
// `folder_path` box produced an account that silently saw nothing, and one
// client often needs several folders (an engagement shoot and the wedding, a
// wedding and the banquet).
//
// share_tokens already cost two hand-run ALTERs, so the set lives inside the
// existing `folder_path` TEXT column rather than in a new one, and a legacy
// plain string still reads as the one-element set it always was.

// Same reason as session-token.test.mjs: sessions.expires_at is written
// without a zone and Date.parse reads that shape as local time.
process.env.TZ = 'Asia/Taipei';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { fakeBucket, fakeDB, ctx, req } from './fakes.mjs';

const SECRET = 'photographer-secret';
const A = '20260819/';
const B = '20260901/';
const C = '20261012/';
// a comma splits a naive encoding, a quote breaks a naive JSON one, and a
// space is what every one of this photographer's folders actually contains
const ODD = '2026/王, "小明" 婚紗/';

const OBJECTS = {
  '20260819/a.jpg': 'A-PHOTO',
  '20260901/b.jpg': 'B-PHOTO',
  '20261012/c.jpg': 'C-PHOTO',
  '20260819-other/n.jpg': 'NEIGHBOUR',
  [ODD + 'odd.jpg']: 'ODD-PHOTO',
};

const sqlTime = h => new Date(Date.now() + h * 3600000).toISOString().replace('T', ' ').split('.')[0];

function setup() {
  return { imagepicker: fakeBucket(OBJECTS), DB: fakeDB(), PHOTOGRAPHER_TOKEN: SECRET };
}

const call = (env, path, opts = {}) => worker.fetch(req(path, opts), env, ctx);

const sessionRows = env =>
  env.DB._db.prepare("SELECT COUNT(*) AS n FROM share_tokens WHERE kind = 'session'").get().n;

const storedPath = (env, id) =>
  env.DB._db.prepare('SELECT folder_path FROM users WHERE id = ?').get(id).folder_path;

async function seedUser(env, { id = 1, folder_path = A, approved = 1, session, expires_at } = {}) {
  await env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, name, folder_path, approved) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, `c${id}@test`, 'hash:salt', `客戶${id}`, folder_path, approved).run();
  await env.DB.prepare(
    'INSERT INTO permissions (user_id, can_book, can_upload) VALUES (?, 0, 0)'
  ).bind(id).run();
  const token = session ?? `SESS-${id}`;
  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)'
  ).bind(token, id, expires_at ?? sqlTime(30 * 24)).run();
  return token;
}

const mint = (env, session) =>
  call(env, '/api/auth/session-token', { method: 'POST', token: session });

async function minted(env, session) {
  const res = await mint(env, session);
  const body = await res.json().catch(() => null);
  assert.equal(res.status, 200, `mint refused: ${JSON.stringify(body)}`);
  return body;
}

// the object route decodes the whole path, so a key with a quote or a space
// in it survives the round trip as long as we encode it here
const objPath = (key, token) => `/${encodeURIComponent(key)}?t=${token}`;
const listPath = (prefix, token) => `/?list=${encodeURIComponent(prefix)}&t=${token}`;

const setFolders = (env, id, body) =>
  call(env, `/api/admin/clients/${id}/permissions`, {
    method: 'PUT', token: SECRET, body: JSON.stringify(body),
  });

// ─── the encoding ────────────────────────────────────────────────────────────

test('a legacy single folder still reads as the one-element set it always was', async () => {
  // every account that exists today carries a bare path in this column and
  // nothing has rewritten it
  const env = setup();
  const session = await seedUser(env, { folder_path: '20260819' });
  const { token, folders } = await minted(env, session);
  assert.deepEqual(folders, [A], 'a plain string stopped being one folder');
  assert.equal(storedPath(env, 1), '20260819', 'the mint rewrote the stored value');
  assert.equal((await call(env, objPath('20260819/a.jpg', token))).status, 200);
  assert.equal((await call(env, objPath('20260819-other/n.jpg', token))).status, 401,
    'the missing slash opened the neighbour');
});

test('several folders are handed back, each canonicalised the same way', async () => {
  const env = setup();
  const session = await seedUser(env, { folder_path: JSON.stringify(['20260819', B, '  20261012  ']) });
  const { folders } = await minted(env, session);
  assert.deepEqual(folders, [A, B, C], 'the set did not survive the column');
});

test('the set comes back in the photographer’s order', async () => {
  // client-auth-check.js opens folders[0] by default, so the order is a
  // contract and not an artefact of how the row was stored
  const env = setup();
  const session = await seedUser(env, { folder_path: JSON.stringify([C, A, B]) });
  assert.deepEqual((await minted(env, session)).folders, [C, A, B]);
});

test('a folder named with a comma, a quote and a space round-trips', async () => {
  // the reason the encoding is JSON rather than a separated list: every
  // separator anyone would pick is a character a folder name may contain
  const env = setup();
  const session = await seedUser(env, { id: 1, folder_path: '' });
  assert.equal((await setFolders(env, 1, { folders: [ODD, A] })).status, 200);
  const { token, folders } = await minted(env, session);
  assert.deepEqual(folders, [ODD, A], 'the odd name did not survive storage');
  assert.equal(await (await call(env, objPath(ODD + 'odd.jpg', token))).text(), 'ODD-PHOTO');
  const listed = await call(env, listPath(ODD, token));
  assert.equal(listed.status, 200, 'the client cannot list the folder we handed them');
  assert.deepEqual((await listed.json()).data.map(f => f.id), [ODD + 'odd.jpg']);
});

test('a folder name that merely looks numeric is still a folder, not JSON', async () => {
  // `2026` is valid JSON and a real folder name, which is why the encoding is
  // told apart by its opening character and never by "does it parse"
  const env = setup();
  const session = await seedUser(env, { folder_path: '2026' });
  assert.deepEqual((await minted(env, session)).folders, ['2026/']);
});

test('the same folder written twice, or with and without its slash, is one folder', async () => {
  const env = setup();
  const session = await seedUser(env, { folder_path: JSON.stringify(['20260819', A, A]) });
  assert.deepEqual((await minted(env, session)).folders, [A]);
});

test('an empty set is refused the way an empty column always was', async () => {
  for (const folder_path of ['[]', '', '   ', null]) {
    const env = setup();
    const session = await seedUser(env, { folder_path });
    const res = await mint(env, session);
    assert.equal(res.status, 403, `folder_path ${JSON.stringify(folder_path)} minted a token`);
    assert.match((await res.json()).error, /尚未設定資料夾/);
    assert.equal(sessionRows(env), 0);
  }
});

// ─── malformed fails closed, and says so ─────────────────────────────────────

test('a folder set that cannot be read mints nothing and says why', async () => {
  // the same reasoning as the 403 for an empty column: a client staring at an
  // empty grid with no explanation is the failure being designed out. A
  // truncated value is the realistic corruption — it is one backspace in a
  // text box away.
  const malformed = [
    '[',
    '["20260819/"',
    '["20260819/", "20260901/"',
    '[1, 2]',
    '["20260819/", null]',
    '["20260819/", ""]',
    '["20260819/", "   "]',
    '[["20260819/"]]',
    '[{"path":"20260819/"}]',
    // what someone guessing the encoding in the D1 console writes. Read as a
    // plain path it is a folder that does not exist, which is the silent empty
    // grid again, so anything opening the way JSON does has to parse as this
    // encoding or be refused.
    '{"folders": ["20260819/"]}',
    '{}',
    '"20260819/"',
  ];
  for (const folder_path of malformed) {
    const env = setup();
    const session = await seedUser(env, { folder_path });
    const res = await mint(env, session);
    assert.equal(res.status, 403, `folder_path ${JSON.stringify(folder_path)} minted a token`);
    // distinct from the empty-column wording, so the message proves which
    // check answered rather than some earlier gate
    assert.match((await res.json()).error, /資料夾設定有誤/,
      `folder_path ${JSON.stringify(folder_path)} was refused by the wrong check`);
    assert.equal(sessionRows(env), 0, 'a refused mint still wrote a row');
  }
});

test('an unreadable folder set is refused after approval, not instead of it', async () => {
  // the approval gate comes first and must keep its own wording, or a client
  // waiting on the photographer is told to go and fix a folder
  const env = setup();
  const session = await seedUser(env, { approved: 0, folder_path: '["20260819/"' });
  const res = await mint(env, session);
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /待審核/);
});

// ─── what the token opens ────────────────────────────────────────────────────

test('one token reads every folder in the set and nothing else', async () => {
  const env = setup();
  const session = await seedUser(env, { folder_path: JSON.stringify([A, B]) });
  const { token } = await minted(env, session);
  assert.equal(await (await call(env, objPath('20260819/a.jpg', token))).text(), 'A-PHOTO');
  assert.equal(await (await call(env, objPath('20260901/b.jpg', token))).text(), 'B-PHOTO');
  assert.equal((await call(env, objPath('20261012/c.jpg', token))).status, 401, 'a folder not in the set');
  assert.equal((await call(env, objPath('20260819-other/n.jpg', token))).status, 401, 'the neighbour');
  assert.equal((await call(env, listPath(A, token))).status, 200);
  assert.equal((await call(env, listPath(B, token))).status, 200);
  assert.equal((await call(env, listPath(C, token))).status, 401, 'listed a folder not in the set');
  assert.equal((await call(env, listPath('', token))).status, 401, 'the bucket root');
});

test('the photographer can audit the whole snapshot on a minted token', async () => {
  const env = setup();
  const session = await seedUser(env, { folder_path: JSON.stringify([A, B]) });
  const { token } = await minted(env, session);
  const listed = await (await call(env, '/api/shares/minted', { token: SECRET })).json();
  const mine = listed.find(r => r.token === token);
  assert.ok(mine, 'the client token is not in the minted list');
  assert.deepEqual(JSON.parse(mine.folders), [A, B]);
});

// ─── reuse, now that the set can change ──────────────────────────────────────

test('a second page load with the same set reuses the row', async () => {
  const env = setup();
  const session = await seedUser(env, { folder_path: JSON.stringify([A, B]) });
  const first = await minted(env, session);
  const second = await minted(env, session);
  assert.equal(second.token, first.token);
  assert.equal(sessionRows(env), 1, 'two page loads left two rows');
});

test('removing a folder is not served from the row minted before it', async () => {
  const env = setup();
  const session = await seedUser(env, { folder_path: JSON.stringify([A, B]) });
  const before = await minted(env, session);
  assert.equal((await call(env, objPath('20260901/b.jpg', before.token))).status, 200);

  assert.equal((await setFolders(env, 1, { folders: [A] })).status, 200);
  const after = await minted(env, session);
  assert.notEqual(after.token, before.token, 'the wider snapshot was handed back');
  assert.deepEqual(after.folders, [A]);
  assert.equal((await call(env, objPath('20260901/b.jpg', after.token))).status, 401,
    'the removed folder is still reachable through the new token');
});

test('adding a folder is not served from the narrower row either', async () => {
  const env = setup();
  const session = await seedUser(env, { folder_path: JSON.stringify([A]) });
  const before = await minted(env, session);
  assert.equal((await setFolders(env, 1, { folders: [A, B] })).status, 200);
  const after = await minted(env, session);
  assert.notEqual(after.token, before.token, 'the client had to wait out an hour for the new folder');
  assert.deepEqual(after.folders, [A, B]);
  assert.equal((await call(env, objPath('20260901/b.jpg', after.token))).status, 200);
});

test('reordering the set hands back a row whose first folder matches', async () => {
  // folders[0] is what the client page opens, so a row minted from the other
  // order is the wrong answer even though it opens the same photos
  const env = setup();
  const session = await seedUser(env, { folder_path: JSON.stringify([A, B]) });
  const before = await minted(env, session);
  assert.equal((await setFolders(env, 1, { folders: [B, A] })).status, 200);
  const after = await minted(env, session);
  assert.deepEqual(after.folders, [B, A]);
  assert.notEqual(after.token, before.token);
});

// ─── the admin API ───────────────────────────────────────────────────────────

test('the client list carries the parsed set beside the raw column', async () => {
  const env = setup();
  await seedUser(env, { id: 1, folder_path: '20260819' });
  await seedUser(env, { id: 2, folder_path: JSON.stringify([A, B]) });
  await seedUser(env, { id: 3, folder_path: '["20260819/"' });
  await seedUser(env, { id: 4, folder_path: '' });
  const rows = await (await call(env, '/api/admin/clients', { token: SECRET })).json();
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.deepEqual(byId[1].folders, [A], 'a legacy path');
  assert.equal(byId[1].folder_path, '20260819', 'the raw column stopped being returned');
  assert.deepEqual(byId[2].folders, [A, B], 'an encoded set');
  assert.equal(byId[3].folders, null, 'an unreadable column did not read as unreadable');
  assert.equal(byId[3].folder_path, '["20260819/"', 'the raw text is gone, so it cannot be repaired');
  assert.deepEqual(byId[4].folders, []);
});

test('the permissions route writes a set and the mint sees it', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1, folder_path: '' });
  const res = await setFolders(env, 1, { can_book: true, can_upload: false, folders: [A, B] });
  assert.equal(res.status, 200);
  const perms = env.DB._db.prepare('SELECT * FROM permissions WHERE user_id = 1').get();
  assert.equal(perms.can_book, 1);
  assert.equal(perms.can_upload, 0);
  assert.deepEqual((await minted(env, session)).folders, [A, B]);
});

test('a set is stored tidy, because the admin list echoes the raw column back', async () => {
  // GET /api/admin/clients hands back folder_path as it sits in the column, so
  // what the picker writes is what the photographer reads back; two spellings
  // of the same set must not look like two different sets to them
  const env = setup();
  const session = await seedUser(env, { id: 1, folder_path: '' });
  assert.equal((await setFolders(env, 1, { folders: ['  20260819/  ', '\t20260901/'] })).status, 200);
  assert.equal(storedPath(env, 1), JSON.stringify([A, B]), 'the column kept the whitespace');
  const listed = await (await call(env, '/api/admin/clients', { token: SECRET })).json();
  assert.equal(listed.find(r => r.id === 1).folder_path, JSON.stringify([A, B]));
  assert.deepEqual((await minted(env, session)).folders, [A, B]);
});

test('the single-value caller still works and round-trips an encoded set untouched', async () => {
  // admin.html reads folder_path, puts it in a text box and writes it back on
  // every permission toggle. Half-deployed, that box now holds the encoded
  // set — writing it back unchanged must not corrupt it.
  const env = setup();
  const session = await seedUser(env, { id: 1, folder_path: JSON.stringify([A, B]) });
  const raw = storedPath(env, 1);
  assert.equal((await setFolders(env, 1, { can_book: true, folder_path: raw })).status, 200);
  assert.equal(storedPath(env, 1), raw, 'the old UI corrupted the set');
  assert.deepEqual((await minted(env, session)).folders, [A, B]);
  // and the plain string it writes today still lands as a plain string
  assert.equal((await setFolders(env, 1, { folder_path: '20260901' })).status, 200);
  assert.equal(storedPath(env, 1), '20260901');
});

test('a set the route cannot store is refused before anything is written', async () => {
  const env = setup();
  await seedUser(env, { id: 1, folder_path: A });
  for (const folders of ['20260819/', 5, null, [A, ''], [A, '  '], [A, 7], [A, null], [[A]], { 0: A }]) {
    const res = await setFolders(env, 1, { can_book: true, folders });
    assert.equal(res.status, 400, `folders ${JSON.stringify(folders)} was accepted`);
    assert.equal(storedPath(env, 1), A, `folders ${JSON.stringify(folders)} overwrote the column`);
    assert.equal(env.DB._db.prepare('SELECT COUNT(*) AS n FROM permissions WHERE user_id = 1 AND can_book = 1').get().n,
      0, 'a refused request still wrote the permissions half');
  }
});

test('a folder_path that is not a string is refused rather than bound', async () => {
  // a half-migrated UI sending the new array under the old field name would
  // otherwise reach D1 as a bind of the wrong type
  const env = setup();
  await seedUser(env, { id: 1, folder_path: A });
  const res = await setFolders(env, 1, { folder_path: [A, B] });
  assert.equal(res.status, 400);
  assert.equal(storedPath(env, 1), A);
});

test('an empty set is a way to close an account’s access', async () => {
  const env = setup();
  const session = await seedUser(env, { id: 1, folder_path: A });
  assert.equal((await setFolders(env, 1, { folders: [] })).status, 200);
  const res = await mint(env, session);
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /尚未設定資料夾/);
});

test('writing a set still needs the photographer’s credential', async () => {
  const env = setup();
  await seedUser(env, { id: 1, folder_path: A });
  for (const opts of [{}, { token: 'guess' }]) {
    const res = await call(env, '/api/admin/clients/1/permissions', {
      method: 'PUT', body: JSON.stringify({ folders: [B] }), ...opts,
    });
    assert.equal(res.status, 401);
  }
  assert.equal(storedPath(env, 1), A);
});

// ─── what the signed-in client's own account tells them ──────────────────────

test('login and /me carry the parsed set, not just the raw column', async () => {
  // upload.html and the book editor set CONFIG.DEFAULT_FOLDER from this, and
  // the encoded text is not a folder path
  const env = setup();
  const session = await seedUser(env, { id: 1, folder_path: JSON.stringify([A, B]) });
  const me = await (await call(env, '/api/auth/me', { token: session })).json();
  assert.deepEqual(me.user.folders, [A, B]);
  assert.equal(me.user.folder_path, JSON.stringify([A, B]), 'the raw column stopped being returned');

  // and the same shape at the door, because client-login.html stores what
  // login hands back and every page reads the account off that
  assert.equal((await call(env, '/api/auth/register', {
    method: 'POST', body: JSON.stringify({ email: 'new@test', password: 'pw', name: '\u65b0\u5ba2\u6236' }),
  })).status, 201);
  const id = env.DB._db.prepare("SELECT id FROM users WHERE email = 'new@test'").get().id;
  assert.equal((await call(env, `/api/admin/clients/${id}/approve`, { method: 'PUT', token: SECRET })).status, 200);
  assert.equal((await setFolders(env, id, { folders: [B, C] })).status, 200);
  const login = await call(env, '/api/auth/login', {
    method: 'POST', body: JSON.stringify({ email: 'new@test', password: 'pw' }),
  });
  assert.equal(login.status, 200);
  const body = await login.json();
  assert.deepEqual(body.user.folders, [B, C], 'login hands back no readable folder set');
  assert.deepEqual((await minted(env, body.token)).folders, [B, C]);
});

// ─── the folder picker needs no new route ────────────────────────────────────

test('the photographer can walk the bucket with the listing route they have', async () => {
  // GET /?list=<prefix> with the header credential already returns delimited
  // sub-folders at every level, so a picker needs nothing new
  const env = setup();
  const root = await (await call(env, '/?list=', { token: SECRET })).json();
  assert.ok(root.folders.includes('20260819/'), `root folders: ${JSON.stringify(root.folders)}`);
  assert.ok(root.folders.includes('2026/'));
  const inner = await (await call(env, `/?list=${encodeURIComponent('2026/')}`, { token: SECRET })).json();
  assert.deepEqual(inner.folders, [ODD]);
});
