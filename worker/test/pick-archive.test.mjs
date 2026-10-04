// Archiving and deleting a guest-picking project (docs/guest-picking.md,
// "Archive and delete"). Archive hides a finished project from the list and
// kills every pick link to it in the same batch; the project's own state
// refuses those links too, so a link revived by hand still opens nothing.
// Delete is for a project nobody ever submitted: every statement re-checks
// that inside the batch, so a submit racing it can neither be lost nor leave
// orphans behind. Nothing here touches R2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeDB } from './fakes.mjs';
import {
  SECRET, MINE, setup, call, pick, createProject, claimed, save, rows, one, seedToken, days,
  collectingCtx, withT,
} from './pick-helpers.mjs';

const A = '20260819/a.jpg';

const admin = (env, id, action, token = SECRET) =>
  call(env, `/api/admin/projects/${id}/${action}`, { method: 'POST', token });
const archive = (env, id, token) => admin(env, id, 'archive', token);
const unarchive = (env, id, token) => admin(env, id, 'unarchive', token);
const remove = (env, id, token = SECRET) => call(env, `/api/admin/projects/${id}`, { method: 'DELETE', token });
const list = (env, query = '') => call(env, `/api/admin/projects${query}`, { token: SECRET });
const detail = (env, id) => call(env, `/api/admin/projects/${id}`, { token: SECRET });

async function submit(env, p, relationship = '本人') {
  const c = collectingCtx();
  const res = await pick(env, 'POST', 'submit', p.token, { key: p.key, body: { relationship } }, c);
  await c.settle();
  return res;
}

// a claimed project with a pick, a submission and a second link
async function busy(env) {
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1, note: 'n' }] });
  assert.equal((await submit(env, p)).status, 200);
  const second = await (await admin(env, p.project.id, 'links')).json();
  return { ...p, second: second.token };
}

// makes `sql` run once, the first time the Worker prepares a statement
// matching `re` — after every read the route does, before its writes execute
function landOnce(env, re, sql, ...args) {
  const prepare = env.DB.prepare.bind(env.DB);
  let done = false;
  env.DB.prepare = s => {
    if (!done && re.test(s)) { done = true; env.DB._db.prepare(sql).run(...args); }
    return prepare(s);
  };
}

// every table the delete may touch, for "nothing changed"
const everything = env => JSON.stringify(
  ['projects', 'pickers', 'selections', 'submissions', 'project_members', 'share_tokens']
    .map(t => rows(env, `SELECT * FROM ${t} ORDER BY rowid`)),
);

function seedProject(env, { id, photographer_id = 'default', archived_at = null }) {
  env.DB._db.prepare(
    'INSERT INTO projects (id, folders, created_at, photographer_id, archived_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, JSON.stringify([MINE]), days(0), photographer_id, archived_at);
}

// ─── auth: admin only, fail closed ───────────────────────────────────────────

const ROUTES = id => [
  ['POST', `/api/admin/projects/${id}/archive`],
  ['POST', `/api/admin/projects/${id}/unarchive`],
  ['DELETE', `/api/admin/projects/${id}`],
];

test('archive, unarchive and delete are admin-only and fail closed', async () => {
  const env = setup();
  const p = await claimed(env);
  for (const [token, kind] of [['CLIENT', 'client'], ['STUDIO', 'studio'], ['SESSION', 'session']]) {
    await seedToken(env, { token, kind, project_id: p.project.id, book_id: kind === 'client' ? 'b1' : '' });
  }
  env.DB._db.prepare("INSERT INTO users (id, email, password_hash, name, approved) VALUES (1, 'c@d.tw', 'x', 'C', 1)").run();
  env.DB._db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('S', 1, ?)").run(days(1));
  const before = everything(env);
  for (const [method, path] of ROUTES(p.project.id)) {
    const tries = [
      call(env, path, { method }),
      call(env, path, { method, token: 'wrong' }),
      call(env, path, { method, token: p.token }),
      call(env, path, { method, token: p.key }),
      call(env, withT(path, p.token), { method, key: p.key }),
      call(env, path, { method, headers: { 'X-Share-Token': p.token } }),
      call(env, path, { method, token: 'CLIENT' }),
      call(env, path, { method, token: 'STUDIO' }),
      call(env, path, { method, token: 'SESSION' }),
      call(env, withT(path, 'STUDIO'), { method }),
      call(env, path, { method, token: 'S' }),
    ];
    for (const res of await Promise.all(tries)) assert.equal(res.status, 401, `${method} ${path}`);
    const unset = { ...env, PHOTOGRAPHER_TOKEN: undefined };
    assert.equal((await call(unset, path, { method, token: 'anything' })).status, 401);
    assert.equal((await call(unset, path, { method, token: '' })).status, 401);
  }
  assert.equal(everything(env), before, 'nothing written');
});

test('another photographer\'s project, or an unknown one, is 404 and untouched', async () => {
  const env = setup();
  seedProject(env, { id: 'theirs', photographer_id: 'someone-else' });
  seedProject(env, { id: 'theirs-archived', photographer_id: 'someone-else', archived_at: days(-1) });
  await seedToken(env, { token: 'THEIR-LINK', project_id: 'theirs' });
  const before = everything(env);
  for (const id of ['theirs', 'theirs-archived', 'nope']) {
    for (const res of [await archive(env, id), await unarchive(env, id), await remove(env, id)]) {
      assert.equal(res.status, 404, id);
    }
  }
  assert.equal(everything(env), before);
});

test('the routes take no extra path segment and no other method', async () => {
  const env = setup();
  const p = await claimed(env);
  const id = p.project.id;
  for (const res of [
    await admin(env, id, 'archive/x'),
    await admin(env, id, 'unarchive/x'),
    await call(env, `/api/admin/projects/${id}/archive`, { token: SECRET }),
    await call(env, `/api/admin/projects/${id}/x`, { method: 'DELETE', token: SECRET }),
  ]) assert.notEqual(res.status, 200);
  assert.equal(one(env, 'SELECT archived_at FROM projects').archived_at, null);
  assert.equal(rows(env, 'SELECT * FROM projects').length, 1);
});

// ─── archive ─────────────────────────────────────────────────────────────────

test('archive stamps the project and revokes every live link to it, and only those', async () => {
  const env = setup();
  const p = await busy(env);
  const q = await claimed(env);
  await seedToken(env, { token: 'OLD', project_id: p.project.id, revoked_at: days(-2) });
  const res = await archive(env, p.project.id);
  assert.equal(res.status, 200);
  const out = await res.json();
  const stamped = one(env, 'SELECT archived_at FROM projects WHERE id = ?', p.project.id).archived_at;
  assert.ok(stamped && Number.isFinite(Date.parse(stamped)));
  assert.deepEqual(out, { ok: true, archived_at: stamped, revoked: 2 });
  for (const t of [p.token, p.second]) {
    assert.ok(one(env, 'SELECT revoked_at FROM share_tokens WHERE token = ?', t).revoked_at, t);
  }
  // the other project is untouched
  assert.equal(one(env, 'SELECT archived_at FROM projects WHERE id = ?', q.project.id).archived_at, null);
  assert.equal(one(env, 'SELECT revoked_at FROM share_tokens WHERE token = ?', q.token).revoked_at, null);
  assert.equal((await pick(env, 'GET', 'state', q.token, { key: q.key })).status, 200);
  // the data stays
  assert.equal(rows(env, 'SELECT * FROM selections WHERE project_id = ?', p.project.id).length, 1);
  assert.equal(rows(env, 'SELECT * FROM submissions WHERE project_id = ?', p.project.id).length, 1);
  assert.equal(rows(env, 'SELECT * FROM pickers WHERE project_id = ?', p.project.id).length, 1);
  assert.equal(one(env, 'SELECT phase FROM projects WHERE id = ?', p.project.id).phase, 'submitted');
});

test('a link revoked before the archive keeps its own revoke time', async () => {
  const env = setup();
  const p = await claimed(env);
  const at = days(-2);
  await seedToken(env, { token: 'OLD', project_id: p.project.id, revoked_at: at });
  await archive(env, p.project.id);
  assert.equal(one(env, "SELECT revoked_at FROM share_tokens WHERE token = 'OLD'").revoked_at, at);
});

test('archive revokes pick links only, not a stray row of another kind naming the project', async () => {
  const env = setup();
  const p = await claimed(env);
  await seedToken(env, { token: 'STUDIO', kind: 'studio', project_id: p.project.id });
  assert.equal((await (await archive(env, p.project.id)).json()).revoked, 1);
  assert.equal(one(env, "SELECT revoked_at FROM share_tokens WHERE token = 'STUDIO'").revoked_at, null);
});

test('the revoke and the stamp land in one batch', async () => {
  const env = setup();
  const p = await claimed(env);
  const batch = env.DB.batch.bind(env.DB);
  const seen = [];
  env.DB.batch = stmts => { seen.push(stmts.length); return batch(stmts); };
  await archive(env, p.project.id);
  assert.deepEqual(seen, [2]);
});

test('archiving twice keeps the first stamp and revokes nothing more', async () => {
  const env = setup();
  const p = await claimed(env);
  const first = await (await archive(env, p.project.id)).json();
  const res = await archive(env, p.project.id);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, archived_at: first.archived_at, revoked: 0 });
});

test('the detail still loads for an archived project and shows archived_at and dead links', async () => {
  const env = setup();
  const p = await busy(env);
  const before = await (await detail(env, p.project.id)).json();
  assert.equal(before.project.archived_at, null);
  const { archived_at } = await (await archive(env, p.project.id)).json();
  const res = await detail(env, p.project.id);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.project.archived_at, archived_at);
  assert.deepEqual(out.tokens.map(t => t.status), ['revoked', 'revoked']);
  assert.equal(out.submissions.length, 1);
  assert.equal(out.selections.length, 1);
});

// ─── an archived project's links open nothing, even revived by hand ──────────

async function archivedAndRevived(env) {
  const p = await busy(env);
  await archive(env, p.project.id);
  env.DB._db.prepare('UPDATE share_tokens SET revoked_at = NULL').run();
  return p;
}

test('a hand-un-revoked link to an archived project reads no photo and no listing', async () => {
  const env = setup();
  const p = await archivedAndRevived(env);
  for (const t of [p.token, p.second]) {
    for (const path of ['/20260819/a.jpg', '/_thumbs/400/20260819/a.jpg.thumb', '/20260819/a.jpg?w=400',
      `/?list=${encodeURIComponent(MINE)}`]) {
      assert.equal((await call(env, withT(path, t))).status, 401, path);
      assert.equal((await call(env, path, { headers: { 'X-Share-Token': t } })).status, 401, `${path} header`);
    }
  }
});

test('a hand-un-revoked link to an archived project opens no pick route', async () => {
  const env = setup();
  const p = await archivedAndRevived(env);
  const before = everything(env);
  assert.equal((await pick(env, 'GET', 'state', p.token, { key: p.key })).status, 401);
  assert.equal((await pick(env, 'GET', 'state', p.second)).status, 401);
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: '20260819/b.jpg', rating: 1 }] })).status, 401);
  assert.equal((await submit(env, p, '朋友')).status, 401);
  // with the seat free, a claim is refused too
  env.DB._db.prepare('UPDATE projects SET owner_picker_id = NULL').run();
  const mid = everything(env);
  assert.equal((await pick(env, 'POST', 'claim', p.token, { body: { name: '路人' } })).status, 401);
  assert.equal(everything(env), mid);
  env.DB._db.prepare('UPDATE projects SET owner_picker_id = ?').run(p.pickerId);
  assert.equal(everything(env), before, 'nothing written');
});

test('a brand-new live link to an archived project opens nothing either', async () => {
  const env = setup();
  const p = await claimed(env);
  await archive(env, p.project.id);
  await seedToken(env, { token: 'FRESH', project_id: p.project.id, created_at: days(0) });
  assert.equal((await pick(env, 'GET', 'state', 'FRESH')).status, 401);
  assert.equal((await call(env, withT('/20260819/a.jpg', 'FRESH'))).status, 401);
  // while the project's neighbours are not caught by it
  const q = await createProject(env);
  assert.equal((await call(env, withT('/20260819/a.jpg?w=400', q.token))).status, 200);
});

// an archive landing after the route's reads: the writes re-check it
test('an archive landing mid-save wins: 401, nothing written', async () => {
  const env = setup();
  const p = await claimed(env);
  landOnce(env, /^\s*UPDATE projects SET modified_after_submit/i, 'UPDATE projects SET archived_at = ?', days(0));
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] })).status, 401);
  assert.equal(rows(env, 'SELECT * FROM selections').length, 0);
});

test('an archive landing mid-delete-save wins: nothing deleted', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  landOnce(env, /^\s*UPDATE projects SET modified_after_submit/i, 'UPDATE projects SET archived_at = ?', days(0));
  assert.equal((await save(env, p.token, p.key, { delete: [A] })).status, 401);
  assert.equal(rows(env, 'SELECT * FROM selections').length, 1);
});

test('an archive landing mid-submit wins: 401, no row, phase and contact untouched', async () => {
  const env = setup();
  const p = await claimed(env);
  landOnce(env, /^\s*INSERT INTO submissions/i, 'UPDATE projects SET archived_at = ?', days(0));
  assert.equal((await submit(env, p)).status, 401);
  assert.equal(rows(env, 'SELECT * FROM submissions').length, 0);
  assert.equal(one(env, 'SELECT phase FROM projects').phase, 'picking');
  assert.equal(one(env, 'SELECT relationship FROM pickers').relationship, null);
});

test('an archive landing mid-resubmit wins too (the repeat path)', async () => {
  const env = setup();
  const p = await claimed(env);
  await submit(env, p);
  env.DB._db.prepare("UPDATE projects SET phase = 'picking'").run();
  landOnce(env, /^\s*INSERT INTO submissions/i, 'UPDATE projects SET archived_at = ?', days(0));
  assert.equal((await submit(env, p, '朋友')).status, 401);
  assert.equal(one(env, 'SELECT phase FROM projects').phase, 'picking');
  assert.equal(one(env, 'SELECT relationship FROM pickers').relationship, '本人');
});

test('an archive landing mid-claim wins: 401, no seat, no picker row', async () => {
  const env = setup();
  const { token } = await createProject(env);
  landOnce(env, /^\s*UPDATE projects SET owner_picker_id/i, 'UPDATE projects SET archived_at = ?', days(0));
  assert.equal((await pick(env, 'POST', 'claim', token, { body: { name: '王' } })).status, 401);
  assert.equal(one(env, 'SELECT owner_picker_id FROM projects').owner_picker_id, null);
  assert.equal(rows(env, 'SELECT * FROM pickers').length, 0);
});

// ─── unarchive ───────────────────────────────────────────────────────────────

test('unarchive clears the stamp; the links stay dead and a new one works', async () => {
  const env = setup();
  const p = await busy(env);
  await archive(env, p.project.id);
  const res = await unarchive(env, p.project.id);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, archived_at: null });
  assert.equal(one(env, 'SELECT archived_at FROM projects').archived_at, null);
  assert.equal(rows(env, 'SELECT * FROM share_tokens WHERE revoked_at IS NULL').length, 0, 'still revoked');
  assert.equal((await pick(env, 'GET', 'state', p.token, { key: p.key })).status, 401);
  const minted = await (await admin(env, p.project.id, 'links')).json();
  const state = await pick(env, 'GET', 'state', minted.token, { key: p.key });
  assert.equal(state.status, 200);
  assert.equal((await state.json()).is_owner, true, 'same seat through the new link');
  assert.equal((await call(env, withT('/20260819/a.jpg?w=400', minted.token))).status, 200);
});

test('unarchive of a project that is not archived is a harmless 200', async () => {
  const env = setup();
  const p = await claimed(env);
  const res = await unarchive(env, p.project.id);
  assert.equal(res.status, 200);
  assert.equal(one(env, 'SELECT revoked_at FROM share_tokens').revoked_at, null);
  assert.equal((await pick(env, 'GET', 'state', p.token)).status, 200);
});

// ─── the list ────────────────────────────────────────────────────────────────

test('the list hides archived projects; ?archived=1 shows only them', async () => {
  const env = setup();
  const live = await claimed(env);
  const gone = await claimed(env);
  await archive(env, gone.project.id);
  seedProject(env, { id: 'theirs-archived', photographer_id: 'someone-else', archived_at: days(-1) });

  const plain = (await (await list(env)).json()).projects;
  assert.deepEqual(plain.map(r => r.id), [live.project.id]);
  assert.equal(plain[0].archived_at, null);

  const res = await list(env, '?archived=1');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Cache-Control') || '', /no-store/);
  const archived = (await res.json()).projects;
  assert.deepEqual(archived.map(r => r.id), [gone.project.id]);
  assert.ok(archived[0].archived_at);
  assert.equal(archived[0].token, null, 'its links are dead');

  // anything but 1 is the default view
  for (const q of ['?archived=0', '?archived=', '?archived=true']) {
    assert.deepEqual((await (await list(env, q)).json()).projects.map(r => r.id), [live.project.id], q);
  }
});

test('the archived list is still one statement', async () => {
  const env = setup();
  for (let i = 0; i < 3; i++) await archive(env, (await claimed(env)).project.id);
  const before = env.DB._sql.length;
  const { projects } = await (await list(env, '?archived=1')).json();
  assert.equal(projects.length, 3);
  assert.equal(env.DB._sql.length - before, 1);
});

// ─── delete ──────────────────────────────────────────────────────────────────

test('delete removes a never-submitted project and everything hanging off it, and only that', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  await admin(env, p.project.id, 'links');
  env.DB._db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, 1, 'viewer')").run(p.project.id);
  // a neighbour with every kind of row, submissions included
  const q = await busy(env);
  env.DB._db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, 1, 'viewer')").run(q.project.id);
  const album = await seedToken(env, { token: 'ALBUM', kind: 'client', book_id: 'b1' });
  const neighbour = JSON.stringify(['projects', 'pickers', 'selections', 'submissions', 'project_members', 'share_tokens']
    .map(t => rows(env, `SELECT * FROM ${t} WHERE ${t === 'projects' ? 'id' : 'project_id'} IS NOT ? ORDER BY rowid`, p.project.id)));
  const r2 = JSON.stringify([...env.imagepicker._store.keys()]);

  const res = await remove(env, p.project.id);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  for (const [t, col] of [['projects', 'id'], ['pickers', 'project_id'], ['selections', 'project_id'],
    ['project_members', 'project_id'], ['share_tokens', 'project_id']]) {
    assert.equal(rows(env, `SELECT * FROM ${t} WHERE ${col} = ?`, p.project.id).length, 0, t);
  }
  assert.equal(JSON.stringify(['projects', 'pickers', 'selections', 'submissions', 'project_members', 'share_tokens']
    .map(t => rows(env, `SELECT * FROM ${t} WHERE ${t === 'projects' ? 'id' : 'project_id'} IS NOT ? ORDER BY rowid`, p.project.id))),
  neighbour, 'the neighbour and the album link are untouched');
  assert.ok(one(env, 'SELECT token FROM share_tokens WHERE token = ?', album));
  assert.equal(JSON.stringify([...env.imagepicker._store.keys()]), r2, 'R2 untouched');
  assert.deepEqual(env.imagepicker._puts, []);
  assert.equal((await pick(env, 'GET', 'state', p.token)).status, 401);
  assert.equal((await detail(env, p.project.id)).status, 404);
  assert.equal((await pick(env, 'GET', 'state', q.token, { key: q.key })).status, 200);
});

test('delete leaves a stray non-pick row that names the project alone', async () => {
  const env = setup();
  const p = await createProject(env);
  await seedToken(env, { token: 'STUDIO', kind: 'studio', project_id: p.project.id });
  assert.equal((await remove(env, p.project.id)).status, 200);
  assert.ok(one(env, "SELECT token FROM share_tokens WHERE token = 'STUDIO'"));
});

test('an archived project with no submissions can be deleted', async () => {
  const env = setup();
  const p = await claimed(env);
  await archive(env, p.project.id);
  assert.equal((await remove(env, p.project.id)).status, 200);
  assert.equal(rows(env, 'SELECT * FROM projects').length, 0);
});

test('a project with a submission is not deleted: 409 has_submissions, nothing touched', async () => {
  const env = setup();
  const p = await busy(env);
  env.DB._db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, 1, 'viewer')").run(p.project.id);
  const before = everything(env);
  const res = await remove(env, p.project.id);
  assert.equal(res.status, 409);
  const out = await res.json();
  assert.equal(out.code, 'has_submissions');
  assert.equal(typeof out.error, 'string');
  assert.equal(everything(env), before);
});

test('a submit landing mid-delete wins: 409, the submission and every row kept', async () => {
  const env = setup();
  const p = await claimed(env);
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  await admin(env, p.project.id, 'links');
  env.DB._db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, 1, 'viewer')").run(p.project.id);
  const before = everything(env);
  landOnce(env, /^\s*DELETE FROM/i,
    "INSERT INTO submissions (id, project_id, picker_id, relationship, photo_keys, count, created_at) VALUES ('s-race', ?, ?, '本人', '[]', 0, ?)",
    p.project.id, p.pickerId, days(0));
  const res = await remove(env, p.project.id);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'has_submissions');
  const after = JSON.parse(everything(env));
  const want = JSON.parse(before);
  assert.deepEqual(after[0], want[0], 'projects');
  assert.deepEqual(after[1], want[1], 'pickers');
  assert.deepEqual(after[2], want[2], 'selections');
  assert.equal(after[3].length, 1, 'the racing submission');
  assert.deepEqual(after[4], want[4], 'project_members');
  assert.deepEqual(after[5], want[5], 'share_tokens');
});

test('a delete racing another delete answers 404 the second time', async () => {
  const env = setup();
  const p = await createProject(env);
  landOnce(env, /^\s*DELETE FROM/i, 'DELETE FROM projects WHERE id = ?', p.project.id);
  assert.equal((await remove(env, p.project.id)).status, 404);
  assert.equal(rows(env, 'SELECT * FROM share_tokens').length, 1, 'gated: nothing else went either');
});

test('another project\'s submissions do not block a delete', async () => {
  const env = setup();
  await busy(env);
  const p = await createProject(env);
  assert.equal((await remove(env, p.project.id)).status, 200);
  assert.equal(rows(env, 'SELECT * FROM projects').length, 1);
});

test('the delete lands in one batch', async () => {
  const env = setup();
  const p = await createProject(env);
  const batch = env.DB.batch.bind(env.DB);
  const seen = [];
  env.DB.batch = stmts => { seen.push(stmts.length); return batch(stmts); };
  await remove(env, p.project.id);
  assert.deepEqual(seen, [5]);
});

// ─── the hand-run migration ──────────────────────────────────────────────────

test('the archive migration is one ALTER, and fresh == old migration + it', () => {
  const fresh = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/2026-09-28-project-archive.sql', import.meta.url), 'utf8');
  const statements = migration.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean);
  assert.deepEqual(statements.map(s => s.replace(/\s+/g, ' ')), ['ALTER TABLE projects ADD COLUMN archived_at TEXT']);
  // the database as the guest-picking migration left it: no archived_at, and
  // none of the columns appended after it (delivered_at, which the next
  // migration adds, is appended on top so the column order is pinned too)
  const deployed = fresh.replace(/,\n(?:\s*--[^\n]*\n)*\s*archived_at\s+TEXT,\n(?:\s*--[^\n]*\n)*\s*delivered_at\s+TEXT,\n(?:\s*--[^\n]*\n)*\s*final_folders\s+TEXT,\n\s*allow_proof_download[^\n]*\n(?:\s*--[^\n]*\n)*\s*extra_max\s+INTEGER,\n(?:\s*--[^\n]*\n)*\s*client_confirmed_at\s+TEXT,\n(?:\s*--[^\n]*\n)*\s*client_confirmed_by\s+TEXT\n\);/, '\n);');
  assert.doesNotMatch(deployed, /archived_at|delivered_at|final_folders|allow_proof_download|^\s*extra_max\s/m, 'fixture still has the column');
  const later = 'ALTER TABLE projects ADD COLUMN delivered_at TEXT;\n' +
    readFileSync(new URL('../migrations/2026-09-30-delivery.sql', import.meta.url), 'utf8') +
    '\nALTER TABLE projects ADD COLUMN extra_max INTEGER;\n' +
    readFileSync(new URL('../migrations/2026-10-04-client-confirm.sql', import.meta.url), 'utf8');
  const shape = db => db._db.prepare('PRAGMA table_info(projects)').all();
  assert.deepEqual(shape(fakeDB({ schema: deployed + '\n' + migration + '\n' + later })), shape(fakeDB({ schema: fresh })));
  assert.match(fresh, /ALTER TABLE projects ADD COLUMN archived_at TEXT;/, 'schema.sql names the hand-run ALTER');
});

// ─── no new link for an archived project ─────────────────────────────────────

test('a new link cannot be minted for an archived project: 409, no row', async () => {
  const env = setup();
  const p = await claimed(env);
  await archive(env, p.project.id);
  const before = rows(env, "SELECT token FROM share_tokens WHERE project_id = ?", p.project.id).length;
  const res = await admin(env, p.project.id, 'links');
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'archived');
  assert.equal(rows(env, "SELECT token FROM share_tokens WHERE project_id = ?", p.project.id).length, before);
  // and after unarchive it works again
  await unarchive(env, p.project.id);
  assert.equal((await admin(env, p.project.id, 'links')).status, 201);
});

test('an archive landing mid-mint wins: 409, no row', async () => {
  const env = setup();
  const p = await claimed(env);
  const before = rows(env, "SELECT token FROM share_tokens WHERE project_id = ?", p.project.id).length;
  landOnce(env, /INSERT INTO share_tokens/, 'UPDATE projects SET archived_at = ? WHERE id = ?', days(0), p.project.id);
  const res = await admin(env, p.project.id, 'links');
  assert.equal(res.status, 409);
  assert.equal(rows(env, "SELECT token FROM share_tokens WHERE project_id = ?", p.project.id).length, before);
});
