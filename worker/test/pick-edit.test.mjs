// Editing a guest-picking project after it was created (docs/backlog.md,
// "Edit a project's ... after creation"). PATCH /api/admin/projects/:id takes
// any of title, pick_limit, extra_price and folders, checked exactly as the
// create route checks them. A folders edit rewrites the project AND every
// live pick link to it in one batch, so a link already sitting in LINE opens
// the new set at once — wider or narrower. Picks in a folder that was taken
// away stay in D1 but stop counting for the guest (state, ♥ count, submit
// snapshot); the photographer still sees them, marked, and they come back if
// the folder does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECRET, MINE, THEIRS, setup, call, pick, claimed, createProject, save, rows, one, seedToken, days,
  collectingCtx, withT,
} from './pick-helpers.mjs';

const A = '20260819/a.jpg';
const B = '20260819/b.jpg';
const X = '20260901/x.jpg';

const patch = (env, id, body, token = SECRET) =>
  call(env, `/api/admin/projects/${id}`, { method: 'PATCH', token, body });
const detail = async (env, id) => (await call(env, `/api/admin/projects/${id}`, { token: SECRET })).json();
const state = async (env, p, key = p.key) => (await pick(env, 'GET', 'state', p.token, { key })).json();
const tokenFolders = (env, token) => JSON.parse(one(env, 'SELECT folders FROM share_tokens WHERE token = ?', token).folders);

function fakeMailer() {
  const sent = [];
  return { sent, async send(msg) { sent.push(msg); return { messageId: 'm' }; } };
}

async function submit(env, p, relationship = '本人') {
  const c = collectingCtx();
  const res = await pick(env, 'POST', 'submit', p.token, { key: p.key, body: { relationship } }, c);
  await c.settle();
  return { res, json: await res.json() };
}

// every table an edit may touch, for "nothing changed"
const everything = env => JSON.stringify(
  ['projects', 'pickers', 'selections', 'submissions', 'share_tokens']
    .map(t => rows(env, `SELECT * FROM ${t} ORDER BY rowid`)),
);

function seedProject(env, { id, photographer_id = 'default', archived_at = null }) {
  env.DB._db.prepare(
    'INSERT INTO projects (id, folders, created_at, photographer_id, archived_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, JSON.stringify([MINE]), days(0), photographer_id, archived_at);
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

// ─── auth: admin only, fail closed ───────────────────────────────────────────

test('editing a project is admin-only and fails closed', async () => {
  const env = setup();
  const p = await claimed(env);
  for (const [token, kind] of [['CLIENT', 'client'], ['STUDIO', 'studio'], ['SESSION', 'session']]) {
    await seedToken(env, { token, kind, project_id: p.project.id, book_id: kind === 'client' ? 'b1' : '' });
  }
  env.DB._db.prepare("INSERT INTO users (id, email, password_hash, name, approved) VALUES (1, 'c@d.tw', 'x', 'C', 1)").run();
  env.DB._db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES ('S', 1, ?)").run(days(1));
  const before = everything(env);
  const path = `/api/admin/projects/${p.project.id}`;
  const body = { title: 'hacked', folders: [MINE, THEIRS], pick_limit: 1 };
  const tries = [
    call(env, path, { method: 'PATCH', body }),
    call(env, path, { method: 'PATCH', body, token: 'wrong' }),
    call(env, path, { method: 'PATCH', body, token: p.token }),
    call(env, path, { method: 'PATCH', body, token: p.key }),
    call(env, withT(path, p.token), { method: 'PATCH', body, key: p.key }),
    call(env, path, { method: 'PATCH', body, headers: { 'X-Share-Token': p.token } }),
    call(env, path, { method: 'PATCH', body, token: 'CLIENT' }),
    call(env, path, { method: 'PATCH', body, token: 'STUDIO' }),
    call(env, withT(path, 'STUDIO'), { method: 'PATCH', body }),
    call(env, path, { method: 'PATCH', body, token: 'SESSION' }),
    call(env, path, { method: 'PATCH', body, token: 'S' }),
  ];
  for (const res of await Promise.all(tries)) assert.equal(res.status, 401);
  const unset = { ...env, PHOTOGRAPHER_TOKEN: undefined };
  assert.equal((await call(unset, path, { method: 'PATCH', body, token: 'anything' })).status, 401);
  assert.equal((await call(unset, path, { method: 'PATCH', body, token: '' })).status, 401);
  assert.equal(everything(env), before, 'nothing written');
  // and the real credential does get through, so the refusals above are the gate
  assert.equal((await patch(env, p.project.id, { title: 'ok' })).status, 200);
});

test('another photographer\'s project, or an unknown one, is 404 and untouched', async () => {
  const env = setup();
  seedProject(env, { id: 'theirs', photographer_id: 'someone-else' });
  seedProject(env, { id: 'theirs-archived', photographer_id: 'someone-else', archived_at: days(-1) });
  await seedToken(env, { token: 'THEIR-LINK', project_id: 'theirs' });
  const before = everything(env);
  for (const id of ['theirs', 'theirs-archived', 'nope']) {
    const res = await patch(env, id, { title: 'x', folders: [THEIRS] });
    assert.equal(res.status, 404, id);
  }
  assert.equal(everything(env), before);
  assert.deepEqual(tokenFolders(env, 'THEIR-LINK'), [MINE]);
});

// ─── validation: the create route's rules, and nothing else in the body ─────

test('a body the create route would refuse, an unknown field or an empty edit is 400 and changes nothing', async () => {
  const env = setup();
  const p = await claimed(env);
  const before = everything(env);
  const bad = [
    {}, [], null, 7, 'x',
    { photographer_id: 'someone-else' },
    { title: 'ok', phase: 'retouching' },
    { title: 'ok', owner_picker_id: null },
    { title: 7 }, { title: null },
    { pick_limit: -1 }, { pick_limit: 1.5 }, { pick_limit: '40' }, { pick_limit: true },
    { extra_price: -1 }, { extra_price: 1.5 }, { extra_price: '200' }, { extra_price: false },
    { folders: [] }, { folders: 'x/' }, { folders: [''] }, { folders: ['  '] }, { folders: [7] },
    { folders: ['/'] }, { folders: ['_books/'] }, { folders: ['_thumbs/400/'] }, { folders: ['2026/../'] },
    { folders: ['./'] }, { folders: null },
    // one bad field fails the whole edit: the good one alongside it is not applied
    { title: 'fine', folders: ['_books/'] },
    { pick_limit: 10, extra_price: -5 },
  ];
  for (const body of bad) {
    const res = await patch(env, p.project.id, body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const notJson = await call(env, `/api/admin/projects/${p.project.id}`, {
    method: 'PATCH', token: SECRET, body: '{nope', headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(notJson.status, 400);
  assert.equal(everything(env), before);
});

// ─── each field ──────────────────────────────────────────────────────────────

test('each field can be edited alone, cleaned the way create cleans it, and the rest stay', async () => {
  const env = setup();
  const p = await claimed(env, { title: '舊標題', pick_limit: 40, extra_price: 200 });
  const id = p.project.id;

  let res = await patch(env, id, { title: '  新標題  ' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  let out = await res.json();
  assert.equal(out.project.title, '新標題');
  assert.equal(out.project.pick_limit, 40);
  assert.equal(out.project.extra_price, 200);
  assert.deepEqual(out.project.folders, [MINE]);
  assert.equal(out.project.id, id);

  res = await patch(env, id, { title: 'x'.repeat(300) });
  assert.equal((await res.json()).project.title, 'x'.repeat(200));
  res = await patch(env, id, { title: '' });
  assert.equal((await res.json()).project.title, '');

  out = await (await patch(env, id, { pick_limit: 10 })).json();
  assert.equal(out.project.pick_limit, 10);
  assert.equal(out.project.extra_price, 200);
  out = await (await patch(env, id, { extra_price: 0 })).json();
  assert.equal(out.project.extra_price, 0);
  assert.equal(out.project.pick_limit, 10);
  out = await (await patch(env, id, { pick_limit: null, extra_price: null })).json();
  assert.equal(out.project.pick_limit, null);
  assert.equal(out.project.extra_price, null);

  out = await (await patch(env, id, { folders: [' 20260901 ', '20260901/', MINE] })).json();
  assert.deepEqual(out.project.folders, [THEIRS, MINE], 'canonicalised and deduped, order kept');

  const row = one(env, 'SELECT * FROM projects WHERE id = ?', id);
  assert.equal(row.title, '');
  assert.equal(row.pick_limit, null);
  assert.equal(row.extra_price, null);
  assert.deepEqual(JSON.parse(row.folders), [THEIRS, MINE]);
  assert.equal(row.owner_picker_id, p.pickerId, 'the seat is not an edit field');
  assert.equal(row.phase, 'picking');

  // the guest page reads the edit on its next load
  await patch(env, id, { title: 'T2', pick_limit: 3, extra_price: 150 });
  const s = await state(env, p);
  assert.deepEqual(s.project, { id, title: 'T2', pick_limit: 3, extra_price: 150 });
  assert.deepEqual(s.folders, [THEIRS, MINE]);
});

test('a limit or price edit leaves every earlier submission as it was charged', async () => {
  const env = setup({ NOTIFY_EMAIL: fakeMailer(), PHOTOGRAPHER_EMAIL: 'studio@example.com' });
  const p = await claimed(env, { pick_limit: 40, extra_price: 200 });
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }] });
  assert.equal((await submit(env, p)).res.status, 200);
  const first = one(env, 'SELECT * FROM submissions');

  assert.equal((await patch(env, p.project.id, { pick_limit: 1, extra_price: 999 })).status, 200);
  assert.deepEqual(one(env, 'SELECT * FROM submissions WHERE id = ?', first.id), first, 'row untouched');

  await save(env, p.token, p.key, { upsert: [{ photo_key: B, rating: 1 }] });
  const { json } = await submit(env, p);
  assert.equal(json.limit, 1);
  assert.equal(json.price, 999);
  assert.equal(json.over, 1);
  const later = one(env, 'SELECT * FROM submissions WHERE id = ?', json.submission_id);
  assert.equal(later.pick_limit, 1);
  assert.equal(later.extra_price, 999);
  const earlier = one(env, 'SELECT * FROM submissions WHERE id = ?', first.id);
  assert.equal(earlier.pick_limit, 40);
  assert.equal(earlier.extra_price, 200);
});

// ─── folders: the project and every live pick link, together ────────────────

test('a folders edit rewrites every live pick link of the project, and no other token', async () => {
  const env = setup();
  const p = await createProject(env);
  const other = await createProject(env, { title: 'other' });
  const second = await (await call(env, `/api/admin/projects/${p.project.id}/links`, { method: 'POST', token: SECRET })).json();
  const revoked = await (await call(env, `/api/admin/projects/${p.project.id}/links`, { method: 'POST', token: SECRET })).json();
  assert.equal((await call(env, `/api/shares/${revoked.token}/revoke`, { method: 'POST', token: SECRET })).status, 200);
  // non-pick rows that happen to carry this project's id must be left alone
  for (const [token, kind] of [['CLIENT', 'client'], ['STUDIO', 'studio'], ['SESSION', 'session']]) {
    await seedToken(env, { token, kind, project_id: p.project.id, book_id: kind === 'client' ? 'b1' : '' });
  }
  const res = await patch(env, p.project.id, { folders: [MINE, THEIRS] });
  assert.equal(res.status, 200);

  assert.deepEqual(tokenFolders(env, p.token), [MINE, THEIRS]);
  assert.deepEqual(tokenFolders(env, second.token), [MINE, THEIRS]);
  assert.deepEqual(tokenFolders(env, revoked.token), [MINE], 'a revoked link keeps its old snapshot');
  assert.deepEqual(tokenFolders(env, other.token), [MINE], 'another project\'s link is untouched');
  for (const t of ['CLIENT', 'STUDIO', 'SESSION']) assert.deepEqual(tokenFolders(env, t), [MINE], t);
  assert.deepEqual(JSON.parse(one(env, 'SELECT folders FROM projects WHERE id = ?', other.project.id).folders), [MINE]);

  // a link minted after the edit copies the new set
  const third = await (await call(env, `/api/admin/projects/${p.project.id}/links`, { method: 'POST', token: SECRET })).json();
  assert.deepEqual(tokenFolders(env, third.token), [MINE, THEIRS]);
});

test('the project and its links are written in one batch: a failed link write leaves the project as it was', async () => {
  const env = setup();
  const p = await createProject(env);
  const before = everything(env);
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    const stmt = prepare(sql);
    if (!/UPDATE share_tokens SET folders/.test(sql)) return stmt;
    return { ...stmt, bind: (...a) => ({ ...stmt.bind(...a), async run() { throw new Error('D1 hiccup'); } }) };
  };
  await assert.rejects(patch(env, p.project.id, { folders: [MINE, THEIRS], title: 'new' }));
  assert.equal(everything(env), before, 'the project UPDATE rolled back with the failed link UPDATE');
});

test('a link reissued while a folders edit lands copies the new set, not the one it read', async () => {
  const env = setup();
  const p = await createProject(env);
  // the edit commits after the links route read the project, before it inserts
  landOnce(env, /INSERT INTO share_tokens/, 'UPDATE projects SET folders = ? WHERE id = ?',
    JSON.stringify([MINE, THEIRS]), p.project.id);
  const res = await call(env, `/api/admin/projects/${p.project.id}/links`, { method: 'POST', token: SECRET });
  assert.equal(res.status, 201);
  const { token } = await res.json();
  assert.deepEqual(tokenFolders(env, token), [MINE, THEIRS]);
});

test('a live guest link reads an added folder at once and is refused a removed one — list, photo, thumbnail and save', async () => {
  const env = setup();
  const p = await claimed(env);
  const t = p.token;
  const x = encodeURIComponent(X);
  // before: the second folder is closed to this link
  assert.equal((await call(env, withT(`/?list=${encodeURIComponent(THEIRS)}`, t))).status, 401);
  assert.equal((await call(env, withT(`/${x}`, t))).status, 401);
  assert.equal((await save(env, t, p.key, { upsert: [{ photo_key: X, rating: 1 }] })).status, 403);

  // wider
  assert.equal((await patch(env, p.project.id, { folders: [MINE, THEIRS] })).status, 200);
  const listed = await call(env, withT(`/?list=${encodeURIComponent(THEIRS)}`, t));
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).data.map(f => f.id), [X]);
  const photo = await call(env, withT(`/${x}`, t));
  assert.equal(photo.status, 200);
  assert.equal(await photo.text(), 'THEIRS-X');
  assert.equal((await save(env, t, p.key, { upsert: [{ photo_key: X, rating: 1 }] })).status, 200);
  assert.deepEqual((await state(env, p)).folders, [MINE, THEIRS]);

  // narrower: the original folder is taken away
  assert.equal((await patch(env, p.project.id, { folders: [THEIRS] })).status, 200);
  assert.equal((await call(env, withT(`/?list=${encodeURIComponent(MINE)}`, t))).status, 401);
  assert.equal((await call(env, withT(`/${encodeURIComponent(A)}`, t))).status, 401);
  assert.equal((await call(env, withT(`/${encodeURIComponent('_thumbs/400/20260819/a.jpg.thumb')}`, t))).status, 401);
  assert.equal((await call(env, `/${encodeURIComponent(A)}`, { headers: { 'X-Share-Token': t } })).status, 401);
  assert.equal((await save(env, t, p.key, { upsert: [{ photo_key: A, rating: 1 }] })).status, 403);
  assert.equal((await save(env, t, p.key, { delete: [A] })).status, 403);
  assert.deepEqual((await state(env, p)).folders, [THEIRS]);
  // and the folder it still has keeps working
  assert.equal((await call(env, withT(`/${x}`, t))).status, 200);
});

// ─── picks in a removed folder: kept, hidden from the guest ─────────────────

test('picks in a removed folder are kept in D1 but leave the guest\'s state, count and submission; re-adding restores them', async () => {
  const mailer = fakeMailer();
  const env = setup({ NOTIFY_EMAIL: mailer, PHOTOGRAPHER_EMAIL: 'studio@example.com' });
  const p = await claimed(env, { folders: [MINE, THEIRS], pick_limit: 1 });
  await save(env, p.token, p.key, {
    upsert: [{ photo_key: A, rating: 1, note: 'keep me' }, { photo_key: B, rating: 0, note: 'unstarred' }, { photo_key: X, rating: 1 }],
  });

  assert.equal((await patch(env, p.project.id, { folders: [THEIRS] })).status, 200);

  // kept
  assert.deepEqual(rows(env, 'SELECT photo_key, rating, note FROM selections ORDER BY photo_key').map(r => ({ ...r })), [
    { photo_key: A, rating: 1, note: 'keep me' },
    { photo_key: B, rating: 0, note: 'unstarred' },
    { photo_key: X, rating: 1, note: '' },
  ]);
  // hidden from the owner and from a viewer
  const owner = await state(env, p);
  assert.deepEqual(owner.selections.map(s => s.photo_key), [X]);
  const viewer = await state(env, p, null);
  assert.deepEqual(viewer.selections.map(s => s.photo_key), [X]);

  // and from the submission, its count and the email
  const { res, json } = await submit(env, p);
  assert.equal(res.status, 200);
  assert.equal(json.count, 1);
  assert.equal(json.over, 0, 'the hidden pick does not push the guest over the limit');
  const sub = one(env, 'SELECT * FROM submissions WHERE id = ?', json.submission_id);
  assert.deepEqual(JSON.parse(sub.photo_keys), [X]);
  assert.equal(sub.count, 1);
  assert.equal(mailer.sent.length, 1);
  assert.match(mailer.sent[0].text, /已選：1 張/);
  assert.doesNotMatch(mailer.sent[0].text, /20260819/);

  // the photographer still sees every row, the hidden ones marked
  const d = await detail(env, p.project.id);
  assert.deepEqual(d.selections.map(s => [s.photo_key, s.in_folders]), [[A, false], [B, false], [X, true]]);
  assert.equal(d.selections[0].note, 'keep me');

  // a repeat submit is still a repeat
  const again = await submit(env, p);
  assert.equal(again.res.status, 200);
  assert.equal(again.json.submission_id, json.submission_id);
  assert.equal(rows(env, 'SELECT * FROM submissions').length, 1);

  // back again
  assert.equal((await patch(env, p.project.id, { folders: [MINE, THEIRS] })).status, 200);
  assert.deepEqual((await state(env, p)).selections.map(s => [s.photo_key, s.rating, s.note]),
    [[A, 1, 'keep me'], [B, 0, 'unstarred'], [X, 1, '']]);
  const back = await submit(env, p);
  assert.equal(back.json.count, 2);
  assert.equal(back.json.over, 1);
  assert.deepEqual(JSON.parse(one(env, 'SELECT photo_keys FROM submissions WHERE id = ?', back.json.submission_id).photo_keys), [A, X]);
  assert.ok((await detail(env, p.project.id)).selections.every(s => s.in_folders === true));
});

test('a folder is matched on its / boundary: removing 20260819/ does not keep 20260819-other/ keys, nor hide a sibling folder', async () => {
  const env = setup();
  const p = await claimed(env, { folders: [MINE, THEIRS] });
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }, { photo_key: '20260819/sub/d.jpg', rating: 1 }, { photo_key: X, rating: 1 }] });
  // a pick written before the snapshot was narrowed by hand, under a lookalike prefix
  env.DB._db.prepare("INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at) VALUES (?, '20260819-other/secret.jpg', 1, '', ?, ?)").run(p.project.id, p.pickerId, days(0));
  assert.equal((await patch(env, p.project.id, { folders: ['20260819'] })).status, 200);
  assert.deepEqual((await state(env, p)).selections.map(s => s.photo_key), [A, '20260819/sub/d.jpg']);
  await patch(env, p.project.id, { folders: ['20260819/sub'] });
  assert.deepEqual((await state(env, p)).selections.map(s => s.photo_key), ['20260819/sub/d.jpg']);
});

test('the submit gates still hold after an edit: seat, retouching and the submission cap', async () => {
  const env = setup();
  const p = await claimed(env, { folders: [MINE, THEIRS] });
  await save(env, p.token, p.key, { upsert: [{ photo_key: X, rating: 1 }] });
  assert.equal((await patch(env, p.project.id, { folders: [THEIRS], pick_limit: 5 })).status, 200);
  // not the owner
  const viewer = await pick(env, 'POST', 'submit', p.token, { key: null, body: { relationship: '本人' } });
  assert.equal(viewer.status, 403);
  // retouching
  assert.equal((await submit(env, p)).res.status, 200);
  await call(env, `/api/admin/projects/${p.project.id}/start-retouch`, { method: 'POST', token: SECRET });
  const late = await submit(env, p);
  assert.equal(late.res.status, 409);
  assert.equal(late.json.code, 'retouching');
  assert.equal(rows(env, 'SELECT * FROM submissions').length, 1);
});

// ─── archived ────────────────────────────────────────────────────────────────

test('an archived project cannot be edited: 409, and nothing changes', async () => {
  const env = setup();
  const p = await claimed(env);
  await call(env, `/api/admin/projects/${p.project.id}/archive`, { method: 'POST', token: SECRET });
  const before = everything(env);
  const res = await patch(env, p.project.id, { title: 'x', folders: [MINE, THEIRS] });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'archived');
  assert.equal(everything(env), before);
  // unarchived, it can
  await call(env, `/api/admin/projects/${p.project.id}/unarchive`, { method: 'POST', token: SECRET });
  assert.equal((await patch(env, p.project.id, { title: 'x' })).status, 200);
});

test('an archive landing between the edit\'s read and its write wins: 409, nothing written', async () => {
  const env = setup();
  const p = await claimed(env);
  landOnce(env, /UPDATE projects SET/, 'UPDATE projects SET archived_at = ? WHERE id = ?', days(0), p.project.id);
  const res = await patch(env, p.project.id, { title: 'x', folders: [MINE, THEIRS] });
  assert.equal(res.status, 409);
  assert.equal(one(env, 'SELECT title FROM projects').title, '王先生 婚紗');
  assert.deepEqual(tokenFolders(env, p.token), [MINE]);
});

test('PATCH takes no extra path segment', async () => {
  const env = setup();
  const p = await createProject(env);
  const res = await call(env, `/api/admin/projects/${p.project.id}/extra`, { method: 'PATCH', token: SECRET, body: { title: 'x' } });
  assert.notEqual(res.status, 200);
  assert.equal(one(env, 'SELECT title FROM projects').title, '王先生 婚紗');
});

test('a hand-edited project folder list is read the way folderCovers reads it, and an unreadable one hides every pick', async () => {
  const env = setup();
  const p = await claimed(env, { folders: [MINE, THEIRS] });
  await save(env, p.token, p.key, { upsert: [{ photo_key: A, rating: 1 }, { photo_key: X, rating: 1 }] });
  // rows no link could have written, to show what each rule keeps out
  for (const k of ['20260819-other/secret.jpg', '/stray.jpg', '7/z.jpg']) {
    env.DB._db.prepare('INSERT INTO selections (project_id, photo_key, rating, note, updated_by, updated_at) VALUES (?, ?, 1, \'\', ?, ?)').run(p.project.id, k, p.pickerId, days(0));
  }
  const setFolders = v => env.DB._db.prepare('UPDATE projects SET folders = ? WHERE id = ?').run(v, p.project.id);
  const shown = async () => (await state(env, p)).selections.map(s => s.photo_key);
  setFolders('["20260819"]');
  assert.deepEqual(await shown(), [A], 'no trailing slash still stops at the / boundary');
  setFolders('["/", 7, "20260901/"]');
  assert.deepEqual(await shown(), [X], 'a bare / and a non-string open nothing');
  setFolders('not json');
  assert.deepEqual(await shown(), []);
  const d = await detail(env, p.project.id);
  assert.equal(d.selections.length, 5, 'the photographer still sees every row');
  assert.ok(d.selections.every(s => s.in_folders === false));
});
