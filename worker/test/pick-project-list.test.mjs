// GET /api/admin/projects — the photographer's list of guest-picking
// projects: where each one stands, who holds the seat, how often it was
// submitted, and the live link so it can be copied into LINE again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECRET, MINE, setup, call, pick, createProject, claimed, save, rows, one, seedToken, days,
  collectingCtx,
} from './pick-helpers.mjs';

const list = (env, opts = { token: SECRET }) => call(env, '/api/admin/projects', opts);

const submit = async (env, p, relationship = '本人') => {
  const c = collectingCtx();
  const res = await pick(env, 'POST', 'submit', p.token, { key: p.key, body: { relationship } }, c);
  await c.settle();
  assert.equal(res.status, 200);
};

// a project row written straight into D1, for ages and owners the routes
// would take real time to produce
function seedProject(env, { id, created_at, photographer_id = 'default', owner_picker_id = null, title = '' }) {
  env.DB._db.prepare(
    'INSERT INTO projects (id, title, folders, owner_picker_id, created_at, photographer_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, title, JSON.stringify([MINE]), owner_picker_id, created_at, photographer_id);
}

test('listing projects needs the photographer token, and fails closed without one configured', async () => {
  const env = setup();
  const p = await claimed(env);
  assert.equal((await list(env, {})).status, 401);
  assert.equal((await list(env, { token: 'wrong' })).status, 401);
  assert.equal((await list(env, { token: p.token })).status, 401, 'the pick link is not a way in');
  assert.equal((await list(env, { token: p.key })).status, 401, 'nor is the picker key');
  assert.equal((await call(env, `/api/admin/projects?t=${p.token}`)).status, 401);
  for (const kind of ['client', 'studio', 'session']) {
    const token = await seedToken(env, { token: `T-${kind}`, kind, book_id: kind === 'client' ? 'b1' : '' });
    assert.equal((await list(env, { token })).status, 401, kind);
    assert.equal((await call(env, `/api/admin/projects?t=${token}`)).status, 401, `${kind} ?t=`);
  }
  // a signed-in client's D1 session is not the photographer either
  env.DB._db.prepare("INSERT INTO users (id, email, password_hash, name, approved) VALUES (1, 'c@d.tw', 'x', 'C', 1)").run();
  env.DB._db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('S', 1, ?)").run(days(1));
  assert.equal((await list(env, { token: 'S' })).status, 401, 'client session');
  const unset = setup({ PHOTOGRAPHER_TOKEN: undefined });
  await seedToken(unset, { token: 'x' });
  assert.equal((await list(unset, { token: 'anything' })).status, 401);
  assert.equal((await list(unset, { token: '' })).status, 401);
});

test('an empty studio lists no projects', async () => {
  const res = await list(setup());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { projects: [] });
});

test('each project shows phase, flag, seat holder, submits and its live link', async () => {
  const env = setup();
  const p = await claimed(env, { title: '王先生 婚紗' }, '<b>王</b>小明');
  await save(env, p.token, p.key, { upsert: [{ photo_key: '20260819/a.jpg', rating: 5 }] });
  await submit(env, p);
  await save(env, p.token, p.key, { upsert: [{ photo_key: '20260819/b.jpg', rating: 3 }] });
  await submit(env, p, '伴侶');
  await save(env, p.token, p.key, { upsert: [{ photo_key: '20260819/c.jpg', rating: 1 }] });

  const res = await list(env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Content-Type'), /application\/json/);
  assert.match(res.headers.get('Cache-Control') || '', /no-store/);
  const { projects } = await res.json();
  assert.equal(projects.length, 1);
  const row = projects[0];
  const latest = one(env, 'SELECT MAX(created_at) AS at FROM submissions WHERE project_id = ?', p.project.id).at;
  const created = one(env, 'SELECT created_at FROM projects WHERE id = ?', p.project.id).created_at;
  assert.deepEqual(row, {
    id: p.project.id,
    title: '王先生 婚紗',
    phase: 'submitted',
    modified_after_submit: 1,
    owner_name: '<b>王</b>小明', // raw in JSON; admin.html escapes on render
    created_at: created,
    submission_count: 2,
    last_submitted_at: latest,
    token: p.token,
  });
  assert.doesNotMatch(JSON.stringify(projects), /key_hash|folders|photo_keys/);
});

test('a free seat, no submits and a dead link each read as null or zero', async () => {
  const env = setup();
  const fresh = await createProject(env);
  const revoked = await createProject(env);
  env.DB._db.prepare('UPDATE share_tokens SET revoked_at = ? WHERE token = ?').run(days(0), revoked.token);
  const expired = await createProject(env);
  env.DB._db.prepare('UPDATE share_tokens SET expires_at = ? WHERE token = ?').run(days(-1), expired.token);
  // past the 180-day ceiling, whatever its stored expiry says
  const ancient = await createProject(env);
  env.DB._db.prepare('UPDATE share_tokens SET created_at = ?, expires_at = ? WHERE token = ?')
    .run(days(-181), days(30), ancient.token);

  const { projects } = await (await list(env)).json();
  const by = Object.fromEntries(projects.map(r => [r.id, r]));
  const f = by[fresh.project.id];
  assert.equal(f.owner_name, null);
  assert.equal(f.submission_count, 0);
  assert.equal(f.last_submitted_at, null);
  assert.equal(f.phase, 'picking');
  assert.equal(f.modified_after_submit, 0);
  assert.equal(f.token, fresh.token);
  assert.equal(by[revoked.project.id].token, null, 'revoked');
  assert.equal(by[expired.project.id].token, null, 'expired');
  assert.equal(by[ancient.project.id].token, null, 'past the ceiling');
});

test('a seat reset shows the seat as free again, and the link is the newest live one', async () => {
  const env = setup();
  const p = await claimed(env);
  await call(env, `/api/admin/projects/${p.project.id}/reset-seat`, { method: 'POST', token: SECRET });
  // an older live pick row for the same project, and a live row of another kind
  await seedToken(env, { token: 'OLDER', project_id: p.project.id, created_at: days(-10) });
  await seedToken(env, { token: 'STUDIO', kind: 'studio', project_id: p.project.id, created_at: days(0), expires_at: days(1) });
  const { projects } = await (await list(env)).json();
  assert.equal(projects[0].owner_name, null);
  assert.equal(projects[0].token, p.token);
});

test('an owner id that belongs to another project names nobody', async () => {
  const env = setup();
  const a = await claimed(env, {}, '甲');
  seedProject(env, { id: 'B', created_at: days(1), owner_picker_id: a.pickerId });
  const { projects } = await (await list(env)).json();
  assert.equal(projects.find(r => r.id === 'B').owner_name, null);
  assert.equal(projects.find(r => r.id === a.project.id).owner_name, '甲');
});

test('newest first, only this photographer, at most 200', async () => {
  const env = setup();
  for (let i = 0; i < 205; i++) {
    seedProject(env, { id: `p${String(i).padStart(3, '0')}`, created_at: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString() });
  }
  seedProject(env, { id: 'theirs', created_at: days(1), photographer_id: 'someone-else' });
  const { projects } = await (await list(env)).json();
  assert.equal(projects.length, 200);
  assert.equal(projects[0].id, 'p204');
  assert.equal(projects[199].id, 'p005');
  assert.ok(!projects.some(r => r.id === 'theirs'), "another photographer's project stays out");
});

test('the list is one SQL statement, however many projects there are', async () => {
  const env = setup();
  for (let i = 0; i < 3; i++) {
    const p = await claimed(env);
    await submit(env, p);
  }
  const before = env.DB._sql.length;
  const res = await list(env);
  assert.equal(res.status, 200);
  assert.equal(env.DB._sql.length - before, 1);
  const { projects } = await res.json();
  assert.equal(projects.length, 3);
  // each counts its own submits, not the table's
  assert.deepEqual(projects.map(r => r.submission_count), [1, 1, 1]);
  assert.equal(rows(env, 'SELECT * FROM projects').length, 3);
});
