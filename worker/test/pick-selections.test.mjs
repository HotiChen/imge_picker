// Guest picking: saving picks. One selection list per project, written only
// by whoever holds the seat, and only for photos inside the link's folders.
//
// Body: { upsert: [{ photo_key, rating, note }], delete: [photo_key] }.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECRET, setup, call, pick, createProject, claim, claimed, save, rows, one, seedToken, days,
} from './pick-helpers.mjs';

const A = '20260819/a.jpg';
const B = '20260819/b.jpg';

const selections = env => rows(env, 'SELECT * FROM selections ORDER BY photo_key');

test('the owner saves picks, and state hands them back to anyone holding the link', async () => {
  const env = setup();
  const p = await claimed(env);
  const res = await save(env, p.token, p.key, {
    upsert: [{ photo_key: A, rating: 5, note: '放大這張' }, { photo_key: B, rating: 2 }],
  });
  assert.equal(res.status, 200);
  const stored = selections(env);
  assert.equal(stored.length, 2);
  assert.equal(stored[0].rating, 5);
  assert.equal(stored[0].note, '放大這張');
  assert.equal(stored[0].updated_by, p.pickerId);
  assert.ok(stored[0].updated_at);
  assert.equal(stored[1].note, '', 'a missing note is empty, not NULL');

  // notes are the owner's: a viewer gets picks and ratings only
  const viewer = await (await pick(env, 'GET', 'state', p.token)).json();
  assert.deepEqual(viewer.selections, [
    { photo_key: A, rating: 5 },
    { photo_key: B, rating: 2 },
  ]);
  const owner = await (await pick(env, 'GET', 'state', p.token, { key: p.key })).json();
  assert.deepEqual(owner.selections, [
    { photo_key: A, rating: 5, note: '放大這張', marks: null },
    { photo_key: B, rating: 2, note: '', marks: null },
  ]);
});

test('saving the same photo again updates it, and delete removes it', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, note: 'x' }, { photo_key: B, rating: 1 }] });
  const res = await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 4, note: 'y' }], delete: [B] });
  assert.equal(res.status, 200);
  const stored = selections(env);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].rating, 4);
  assert.equal(stored[0].note, 'y');
});

test('a full 500-key save is a bounded number of statements, not one per key', async () => {
  // D1 caps queries per Worker invocation, so a statement per photo would fail
  // a large save in production while passing every test here
  const env = setup();
  const p = await claimed(env);
  const before = env.DB._sql.length;
  const upsert = Array.from({ length: 500 }, (_, i) => ({ photo_key: `20260819/p${i}.jpg`, rating: 1 }));
  assert.equal((await save(env, p.token, p.key, { upsert })).status, 200);
  assert.equal(selections(env).length, 500);
  assert.ok(env.DB._sql.length - before <= 8, `issued ${env.DB._sql.length - before} statements`);
});

// ─── Rule 5: only the owner writes ───────────────────────────────────────────

test('no key, a wrong key, or someone else\'s key cannot save', async () => {
  const env = setup();
  const p = await claimed(env);
  const body = { upsert: [{ photo_key: A, rating: 3 }] };
  for (const key of [undefined, '', 'nope', p.key + 'x']) {
    const res = await save(env, p.token, key, body);
    assert.equal(res.status, 403, JSON.stringify(key));
  }
  assert.equal(selections(env).length, 0);
});

test('before anyone claims, nobody can save', async () => {
  const env = setup();
  const { token } = await createProject(env);
  assert.equal((await save(env, token, undefined, { upsert: [{ photo_key: A, rating: 3 }] })).status, 403);
  assert.equal(selections(env).length, 0);
});

test('a key from before a seat reset is refused, even before anyone reclaims', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 3 }] });
  await call(env, `/api/admin/projects/${p.project.id}/reset-seat`, { method: 'POST', token: SECRET });
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 3 }] })).status, 403);
  assert.equal((await save(env, p.token, p.key, { delete: [A] })).status, 403);

  const next = await claim(env, p.token, '王太太');
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 3 }] })).status, 403);
  assert.equal((await save(env, p.token, next.key, { upsert: [{ photo_key: B, rating: 3 }] })).status, 200);
  assert.deepEqual(selections(env).map(s => s.photo_key), [A, B]);
});

// ─── Rule 2: every photo_key inside the snapshot ─────────────────────────────

test('a photo outside the link\'s folders is refused, and the whole save with it', async () => {
  const env = setup();
  const p = await claimed(env);
  for (const bad of [
    '20260901/x.jpg',            // another shoot
    '20260819-other/secret.jpg', // the sibling a bare startsWith would let through
    '20260819/../20260901/x.jpg',
    '20260819/./a.jpg',
    '_thumbs/400/20260819/a.jpg.thumb',
    '_books/b1.json',
    '/20260819/a.jpg',
    '20260819',
    '',
  ]) {
    const res = await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }, { photo_key: bad, rating: 1 }] });
    assert.equal(res.status, 403, bad);
    const del = await save(env, p.token, p.key, { delete: [bad] });
    assert.equal(del.status, 403, `delete ${bad}`);
  }
  assert.equal(selections(env).length, 0, 'nothing from a refused save lands');
});

test('the snapshot is the token\'s, not the project\'s current folders', async () => {
  const env = setup();
  const p = await claimed(env);
  env.DB._db.prepare('UPDATE projects SET folders = ?').run(JSON.stringify(['20260819/', '20260901/']));
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: '20260901/x.jpg', rating: 1 }] })).status, 403);
});

test('an internal key is refused even when the snapshot names its folder', async () => {
  const env = setup();
  const { project, token } = await createProject(env);
  // hand-seeded: the create route refuses `_` folders, so only a hand edit gets here
  await seedToken(env, { token: 'UNDERSCORE', project_id: project.id, folders: ['_books/', '20260819/'] });
  const { key } = await claim(env, 'UNDERSCORE');
  assert.equal((await save(env, 'UNDERSCORE', key, { upsert: [{ photo_key: '_books/b1.json', rating: 1 }] })).status, 403);
  assert.equal((await save(env, token, key, { upsert: [{ photo_key: A, rating: 1 }] })).status, 200,
    'same project, so the key is good on either of its links');
  assert.deepEqual(selections(env).map(s => s.photo_key), [A]);
});

// ─── Rule 7: limits ──────────────────────────────────────────────────────────

test('a note may be 500 characters and no more', async () => {
  const env = setup();
  const p = await claimed(env);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, note: '字'.repeat(500) }] })).status, 200);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 1, note: '字'.repeat(501) }] })).status, 400);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 1, note: 5 }] })).status, 400);
  assert.deepEqual(selections(env).map(s => s.photo_key), [A]);
});

test('a save may name 500 keys and no more, counting deletes', async () => {
  const env = setup();
  const p = await claimed(env);
  const keys = n => Array.from({ length: n }, (_, i) => `20260819/p${i}.jpg`);
  assert.equal((await save(env, p.token, p.key, { upsert: keys(501).map(k => ({ photo_key: k, rating: 1 })) })).status, 400);
  assert.equal((await save(env, p.token, p.key, { delete: keys(501) })).status, 400);
  assert.equal((await save(env, p.token, p.key, {
    upsert: keys(250).map(k => ({ photo_key: k, rating: 1 })), delete: keys(251).map(k => k + 'x'),
  })).status, 400);
  assert.equal(selections(env).length, 0);
  assert.equal((await save(env, p.token, p.key, {
    upsert: keys(250).map(k => ({ photo_key: k, rating: 1 })), delete: keys(250).map(k => k + 'x'),
  })).status, 200);
});

test('ratings are whole stars from 0 to 5, and the body must be the documented shape', async () => {
  const env = setup();
  const p = await claimed(env);
  for (const rating of [-1, 6, 2.5, '3', null]) {
    const res = await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating }] });
    assert.equal(res.status, 400, `rating ${rating}`);
  }
  for (const body of ['nope', [], { upsert: 'x' }, { delete: 'x' }, { upsert: [null] }, { upsert: [{ rating: 1 }] }, { delete: [7] }]) {
    const res = await save(env, p.token, p.key, body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(selections(env).length, 0);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 0 }, { photo_key: B, rating: 5 }] })).status, 200);
});

// ─── Rule 4: revoked / expired ───────────────────────────────────────────────

test('a revoked or expired link cannot save, even with the right key', async () => {
  const env = setup();
  const p = await claimed(env);
  await seedToken(env, { token: 'EXP', project_id: p.project.id, expires_at: days(-1) });
  assert.equal((await save(env, 'EXP', p.key, { upsert: [{ photo_key: A, rating: 1 }] })).status, 401);
  env.DB._db.prepare('UPDATE share_tokens SET revoked_at = ? WHERE token = ?').run(days(-0.1), p.token);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] })).status, 401);
  assert.equal(selections(env).length, 0);
});

test('a seat reset that lands between the owner check and the write still wins', async () => {
  const env = setup();
  const p = await claimed(env);
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    if (/^\s*(INSERT INTO selections|DELETE FROM selections)/i.test(sql)) {
      env.DB._db.prepare('UPDATE projects SET owner_picker_id = NULL').run();
    }
    return prepare(sql);
  };
  env.DB._db.prepare("INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at) VALUES (?, ?, 1, '', 'x', 'now')").run(p.project.id, B);
  const res = await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 5 }] });
  assert.equal(res.status, 403);
  await save(env, p.token, p.key, { delete: [B] });
  assert.deepEqual(selections(env).map(s => s.photo_key), [B], 'neither the upsert nor the delete landed');
});

test('a delete-only save loses to a seat reset that lands just before it', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    if (/^\s*DELETE FROM selections/i.test(sql)) env.DB._db.prepare('UPDATE projects SET owner_picker_id = NULL').run();
    return prepare(sql);
  };
  await save(env, p.token, p.key, { delete: [A] });
  assert.deepEqual(selections(env).map(s => s.photo_key), [A]);
});
