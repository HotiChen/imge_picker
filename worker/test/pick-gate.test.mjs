// Rule 9: a `kind = 'pick'` token opens the pick routes and photo reads inside
// its own folders, and nothing else. It travels in a LINE chat, so it is the
// credential most likely to end up in the wrong hands. And the pick routes open
// for pick tokens only: an album link, a studio token or a client session
// token must not take a seat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECRET, MINE, setup, call, pick, createProject, claimed, save, rows, seedToken, withT,
} from './pick-helpers.mjs';

// every non-pick route, as [method, path, body?]
const OTHER_ROUTES = p => [
  ['GET', '/api/auth/verify-admin'],
  ['POST', '/api/auth/studio-token'],
  ['POST', '/api/auth/session-token'],
  ['GET', '/api/auth/me'],
  ['GET', '/api/admin/clients'],
  ['PUT', '/api/admin/clients/1/approve'],
  ['PUT', '/api/admin/clients/1/permissions', { can_book: true }],
  ['DELETE', '/api/admin/clients/1'],
  ['POST', '/api/admin/projects', { folders: [MINE] }],
  ['GET', '/api/admin/projects'],
  ['GET', `/api/admin/projects/${p.project.id}`],
  ['POST', `/api/admin/projects/${p.project.id}/reset-seat`],
  ['POST', `/api/admin/projects/${p.project.id}/start-retouch`],
  ['POST', `/api/admin/projects/${p.project.id}/reopen`],
  ['POST', `/api/admin/projects/${p.project.id}/archive`],
  ['POST', `/api/admin/projects/${p.project.id}/unarchive`],
  ['DELETE', `/api/admin/projects/${p.project.id}`],
  ['POST', `/api/admin/projects/${p.project.id}/deliver`],
  ['POST', `/api/admin/projects/${p.project.id}/undeliver`],
  ['GET', '/api/admin/stats'],
  ['GET', '/api/admin/settings'],
  ['PUT', '/api/admin/settings', { studio_name: 'x' }],
  ['PUT', '/api/admin/settings/logo', '\x89PNG\r\n\x1a\n'],
  ['DELETE', '/api/admin/settings/logo'],
  ['GET', '/api/shares/minted'],
  ['POST', '/api/shares/minted/revoke-all'],
  ['POST', `/api/shares/${p.token}/revoke`],
  ['POST', '/api/books/b1/share'],
  ['GET', '/api/books/b1/shares'],
  ['GET', '/api/books/b1'],
  ['PUT', '/api/books/b1', { pages: [] }],
  ['PATCH', '/api/books/b1', { pageIndex: 0, slots: [] }],
  ['GET', '/api/books/b1/status'],
  ['POST', '/api/books/b1/approve'],
  ['PUT', '/20260819/new.jpg', 'IMG'],
  ['PUT', '/_assets/20260819/new.jpg', 'IMG'],
];

test('a pick token is refused by every route that is not a pick route or a photo read', async () => {
  const env = setup();
  const p = await claimed(env);
  const snapshot = () => JSON.stringify([
    rows(env, 'SELECT * FROM share_tokens ORDER BY token'),
    rows(env, 'SELECT * FROM users'),
    rows(env, 'SELECT * FROM projects'),
    rows(env, 'SELECT * FROM studio_settings'),
  ]);
  const before = snapshot();
  for (const [method, path, body] of OTHER_ROUTES(p)) {
    // in each place a credential can travel: the query string, the share
    // header, and the Authorization header the admin and session routes read
    const tries = [
      call(env, withT(path, p.token), { method, body, key: p.key }),
      call(env, path, { method, body, key: p.key, headers: { 'X-Share-Token': p.token } }),
      call(env, path, { method, body, key: p.key, token: p.token }),
      call(env, path, { method, body, token: p.key }),
    ];
    for (const res of await Promise.all(tries)) {
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  }
  assert.equal(snapshot(), before, 'and none of them wrote anything');
  assert.deepEqual(Object.keys(Object.fromEntries(env.imagepicker._store)).filter(k => k.includes('new.jpg')), []);
});

test('the pick routes refuse every token that is not a pick token', async () => {
  const env = setup();
  const p = await claimed(env);
  const kinds = { CLIENT: 'client', STUDIO: 'studio', SESSION: 'session' };
  for (const [token, kind] of Object.entries(kinds)) {
    // same folders and even the same project id, so only the kind differs
    await seedToken(env, { token, kind, project_id: p.project.id, book_id: kind === 'client' ? 'b1' : '' });
    assert.equal((await pick(env, 'GET', 'state', token)).status, 401, `${kind} state`);
    assert.equal((await pick(env, 'POST', 'claim', token, { body: { name: '王' } })).status, 401, `${kind} claim`);
    assert.equal((await save(env, token, p.key, { upsert: [{ photo_key: '20260819/a.jpg', rating: 1 }] })).status, 401, `${kind} save`);
    assert.equal((await pick(env, 'POST', 'submit', token, { key: p.key, body: { relationship: '本人' } })).status, 401, `${kind} submit`);
  }
  // nor does the photographer's own credential stand in for a link
  assert.equal((await call(env, '/api/pick/state', { token: SECRET })).status, 401);
  assert.equal(rows(env, 'SELECT * FROM selections').length, 0);
});

test('a pick token reads thumbnails and listings inside its folders; originals only with the switch (docs/delivery.md)', async () => {
  const env = setup();
  const { token } = await createProject(env);
  await env.imagepicker.put('_thumbs/400/20260819/sub/d.jpg.thumb', 'MINE-SUB-D-THUMB');
  for (const path of ['/20260819/sub/d.jpg?w=400', '/_thumbs/400/20260819/a.jpg.thumb', '/20260819/a.jpg?w=400']) {
    const res = await call(env, withT(path, token));
    assert.equal(res.status, 200, path);
    assert.match(await res.text(), /THUMB$/, path);
  }
  for (const path of ['/20260819/a.jpg', '/20260819/sub/d.jpg']) {
    const res = await call(env, withT(path, token));
    assert.equal(res.status, 403, path);
    assert.equal((await res.json()).code, 'original_not_allowed');
  }
  env.DB._db.prepare('UPDATE projects SET allow_proof_download = 1').run();
  for (const [path, body] of [['/20260819/a.jpg', 'MINE-A'], ['/20260819/sub/d.jpg', 'MINE-SUB-D']]) {
    const res = await call(env, withT(path, token));
    assert.equal(res.status, 200, path);
    assert.equal(await res.text(), body);
  }
  const list = await call(env, withT(`/?list=${encodeURIComponent(MINE)}`, token));
  assert.equal(list.status, 200);
  assert.ok((await list.json()).data.length >= 3);
});

test('a pick token reads nothing outside its folders', async () => {
  const env = setup();
  const { token } = await createProject(env);
  for (const path of [
    '/20260901/x.jpg',
    '/20260819-other/secret.jpg',
    '/20260819/../20260901/x.jpg',
    '/_books/b1.json',
    `/?list=${encodeURIComponent('20260901/')}`,
    `/?list=${encodeURIComponent('')}`,
    `/?list=${encodeURIComponent('_books/')}`,
  ]) {
    const res = await call(env, withT(path, token));
    assert.equal(res.status, 401, path);
  }
});

test('`_`-prefixed keys stay unreadable even if a pick snapshot names them', async () => {
  const env = setup();
  const { project } = await createProject(env);
  await seedToken(env, { token: 'UNDERSCORE', project_id: project.id, folders: ['_books/', '_thumbs/'] });
  for (const path of ['/_books/b1.json', '/_thumbs/400/20260819/a.jpg.thumb']) {
    assert.equal((await call(env, withT(path, 'UNDERSCORE'))).status, 401, path);
  }
});

test('revoking a pick link through the ordinary revoke route kills it everywhere', async () => {
  const env = setup();
  const p = await claimed(env);
  const res = await call(env, `/api/shares/${p.token}/revoke`, { method: 'POST', token: SECRET });
  assert.equal(res.status, 200);
  assert.equal((await call(env, withT('/20260819/a.jpg', p.token))).status, 401);
  assert.equal((await pick(env, 'GET', 'state', p.token, { key: p.key })).status, 401);
});

test('a pick link is not a minted token: it does not show up or die with them', async () => {
  const env = setup();
  const p = await claimed(env);
  const listed = await (await call(env, '/api/shares/minted', { token: SECRET })).json();
  assert.equal(listed.filter(r => r.token === p.token).length, 0);
  await call(env, '/api/shares/minted/revoke-all', { method: 'POST', token: SECRET });
  assert.equal((await pick(env, 'GET', 'state', p.token)).status, 200);
});

test('a pick row is refused by the book routes even if hand-edited to name that book', async () => {
  const env = setup();
  const { project } = await createProject(env);
  await seedToken(env, { token: 'PICKBOOK', project_id: project.id, book_id: 'b1' });
  for (const [method, path] of [['GET', '/api/books/b1'], ['GET', '/api/books/b1/status'], ['POST', '/api/books/b1/approve']]) {
    assert.equal((await call(env, withT(path, 'PICKBOOK'), { method })).status, 401, `${method} ${path}`);
  }
});
