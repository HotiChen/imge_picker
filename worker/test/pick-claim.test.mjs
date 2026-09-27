// Guest picking: taking the seat. LINE's crawler opens the link to build its
// preview card, so opening claims nothing — only POST /api/pick/claim with a
// name does, and exactly one of any number of simultaneous claims wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup, pick, createProject, claim, claimed, save, rows, one, sha256Hex, seedToken, days, MINE,
} from './pick-helpers.mjs';

const state = async (env, t, key) => {
  const res = await pick(env, 'GET', 'state', t, { key });
  return { res, json: res.status === 200 ? await res.json() : null };
};

// ─── opening the link ────────────────────────────────────────────────────────

test('opening the link claims nothing, from a browser or from LINE\'s crawler', async () => {
  const env = setup();
  const { token } = await createProject(env);
  const before = env.DB._writes().length;
  for (const ua of ['Mozilla/5.0 Line/13.0', 'facebookexternalhit/1.1;line-poker/1.0']) {
    const res = await pick(env, 'GET', 'state', token, { headers: { 'User-Agent': ua } });
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.equal(s.owner, null);
    assert.equal(s.is_owner, false);
  }
  const writes = env.DB._writes().slice(before);
  assert.deepEqual(writes.filter(w => /projects|pickers|selections/i.test(w)), []);
  assert.equal(rows(env, 'SELECT * FROM pickers').length, 0);
});

test('state carries what the page needs and nothing about the seat holder but a name', async () => {
  const env = setup();
  const p = await claimed(env, { title: '王先生 婚紗', pick_limit: 40, extra_price: 200 }, '王小明');
  const { res, json } = await state(env, p.token);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Cache-Control') || '', /no-store/);
  assert.equal(json.project.title, '王先生 婚紗');
  assert.equal(json.project.pick_limit, 40);
  assert.equal(json.project.extra_price, 200);
  assert.deepEqual(json.folders, [MINE]);
  assert.equal(json.owner, '王小明');
  assert.equal(json.is_owner, false, 'no key → a viewer');
  assert.deepEqual(json.selections, []);
  assert.doesNotMatch(JSON.stringify(json), /key_hash|picker_id|updated_by/);
});

// ─── claiming ────────────────────────────────────────────────────────────────

test('a claim returns a key once and stores only its SHA-256', async () => {
  const env = setup();
  const { token } = await createProject(env);
  const { res, json, key } = await claim(env, token, '  王小明  ');
  assert.equal(res.status, 200);
  assert.match(key, /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
  assert.equal(json.owner, '王小明');
  const picker = one(env, 'SELECT * FROM pickers');
  assert.equal(picker.name, '王小明', 'trimmed');
  assert.equal(picker.key_hash, await sha256Hex(key));
  assert.equal(picker.id, json.picker_id);
  for (const [col, v] of Object.entries(picker)) assert.notEqual(v, key, `raw key stored in ${col}`);
  assert.equal(one(env, 'SELECT owner_picker_id FROM projects').owner_picker_id, picker.id);

  const mine = await state(env, token, key);
  assert.equal(mine.json.is_owner, true);
  assert.equal(mine.json.owner, '王小明');
  // the key goes out once: state never repeats it
  assert.doesNotMatch(JSON.stringify(mine.json), new RegExp(key));
});

test('every claim gets a fresh random key', async () => {
  const env = setup();
  const a = await claimed(env);
  const b = await claimed(env);
  assert.notEqual(a.key, b.key);
});

test('a wrong or empty key is a viewer, not the owner', async () => {
  const env = setup();
  const p = await claimed(env);
  for (const key of ['', 'x', p.key + 'x', p.key.slice(1), await sha256Hex(p.key)]) {
    const { json } = await state(env, p.token, key);
    assert.equal(json.is_owner, false, JSON.stringify(key));
  }
});

test('a second claim is refused with the owner\'s name, and leaves no stray picker', async () => {
  const env = setup();
  const p = await claimed(env, {}, '王小明');
  const res = await pick(env, 'POST', 'claim', p.token, { body: { name: '路人甲' } });
  assert.equal(res.status, 409);
  const out = await res.json();
  assert.equal(out.owner, '王小明');
  assert.equal(out.picker_key, undefined);
  assert.equal(rows(env, 'SELECT * FROM pickers').length, 1);
  assert.equal(one(env, 'SELECT owner_picker_id FROM projects').owner_picker_id, p.pickerId);
});

test('even the owner re-claiming does not get a second seat', async () => {
  const env = setup();
  const p = await claimed(env);
  const res = await pick(env, 'POST', 'claim', p.token, { key: p.key, body: { name: '王小明' } });
  assert.equal(res.status, 409);
});

// ─── Rule 6: concurrent claims → exactly one owner ───────────────────────────

test('two claims in the same instant: exactly one wins, the other gets 409 with the winner\'s name', async () => {
  const env = setup();
  const { token } = await createProject(env);
  const [a, b] = await Promise.all([
    pick(env, 'POST', 'claim', token, { body: { name: '甲' } }),
    pick(env, 'POST', 'claim', token, { body: { name: '乙' } }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const [win, lose] = a.status === 200 ? [a, b] : [b, a];
  const w = await win.json();
  const l = await lose.json();
  assert.equal(l.owner, w.owner);
  const owner = one(env, 'SELECT owner_picker_id FROM projects').owner_picker_id;
  assert.equal(owner, w.picker_id);
  assert.equal(rows(env, 'SELECT * FROM pickers').length, 1);
});

test('ten claims at once still make exactly one owner', async () => {
  const env = setup();
  const { token } = await createProject(env);
  const all = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    pick(env, 'POST', 'claim', token, { body: { name: `客${i}` } })));
  assert.equal(all.filter(r => r.status === 200).length, 1);
  assert.equal(all.filter(r => r.status === 409).length, 9);
});

test('the claim is one conditional UPDATE, so a seat taken after any read still loses', async () => {
  const env = setup();
  const { token, project } = await createProject(env);
  // Another request wins the seat at the last possible moment: right before
  // our UPDATE runs, after anything a read-then-write version would have read.
  const prepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    if (/^\s*UPDATE\s+projects\b/i.test(sql)) {
      env.DB._db.prepare("INSERT INTO pickers (id, project_id, key_hash, name, created_at) VALUES ('rival', ?, 'h', '對手', 'now')").run(project.id);
      env.DB._db.prepare("UPDATE projects SET owner_picker_id = 'rival' WHERE id = ?").run(project.id);
    }
    return prepare(sql);
  };
  const res = await pick(env, 'POST', 'claim', token, { body: { name: '王小明' } });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).owner, '對手');
  assert.equal(one(env, 'SELECT owner_picker_id FROM projects').owner_picker_id, 'rival');
  const update = env.DB._sql.find(s => /^\s*UPDATE\s+projects\b/i.test(s));
  assert.match(update, /SET\s+owner_picker_id\s*=\s*\?\s+WHERE\s+id\s*=\s*\?\s+AND\s+owner_picker_id\s+IS\s+NULL/i);
});

// ─── Rule 7 (name) ───────────────────────────────────────────────────────────

test('a name is required, a string, and at most 50 characters', async () => {
  const env = setup();
  const { token } = await createProject(env);
  for (const body of [{}, { name: '' }, { name: '   ' }, { name: 7 }, { name: ['王'] }, { name: '王'.repeat(51) }, { name: 'a'.repeat(51) }]) {
    const res = await pick(env, 'POST', 'claim', token, { body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const bad = await pick(env, 'POST', 'claim', token, { body: 'not json' });
  assert.equal(bad.status, 400);
  assert.equal(rows(env, 'SELECT * FROM pickers').length, 0);
  assert.equal(one(env, 'SELECT owner_picker_id FROM projects').owner_picker_id, null);
  // 50 characters, counted as characters and not UTF-16 units
  const ok = await claim(env, token, '😀'.repeat(50));
  assert.equal(ok.res.status, 200);
});

test('a 50-letter name is accepted', async () => {
  const env = setup();
  const { token } = await createProject(env);
  assert.equal((await claim(env, token, 'a'.repeat(50))).res.status, 200);
});

// ─── Rule 4: revoked / expired ───────────────────────────────────────────────

test('a revoked link cannot be claimed, and neither can an expired or unknown one', async () => {
  const env = setup();
  const { token, project } = await createProject(env);
  env.DB._db.prepare('UPDATE share_tokens SET revoked_at = ? WHERE token = ?').run(days(-0.1), token);
  assert.equal((await pick(env, 'POST', 'claim', token, { body: { name: '王' } })).status, 401);
  assert.equal((await pick(env, 'GET', 'state', token)).status, 401);

  const expired = await seedToken(env, { token: 'EXP', project_id: project.id, expires_at: days(-1) });
  assert.equal((await pick(env, 'POST', 'claim', expired, { body: { name: '王' } })).status, 401);
  // past the 180-day ceiling however far out its stored expiry is
  const old = await seedToken(env, { token: 'OLD', project_id: project.id, created_at: days(-181), expires_at: days(30) });
  assert.equal((await pick(env, 'POST', 'claim', old, { body: { name: '王' } })).status, 401);
  assert.equal((await pick(env, 'POST', 'claim', 'guess', { body: { name: '王' } })).status, 401);
  assert.equal((await pick(env, 'POST', 'claim', undefined, { body: { name: '王' } })).status, 401);
  assert.equal(rows(env, 'SELECT * FROM pickers').length, 0);
});

test('a pick row whose project is gone is a dead link', async () => {
  const env = setup();
  await seedToken(env, { token: 'ORPHAN', project_id: 'missing' });
  assert.equal((await pick(env, 'POST', 'claim', 'ORPHAN', { body: { name: '王' } })).status, 401);
  assert.equal((await pick(env, 'GET', 'state', 'ORPHAN')).status, 401);
});

test('the link is accepted in the X-Share-Token header too', async () => {
  const env = setup();
  const { token } = await createProject(env);
  const res = await pick(env, 'POST', 'claim', undefined, { body: { name: '王' }, headers: { 'X-Share-Token': token } });
  assert.equal(res.status, 200);
});

// ─── Rule 3: a key is bound to its project ───────────────────────────────────

test('a key for project P is useless against project Q\'s link, and vice versa', async () => {
  const env = setup();
  const p = await claimed(env, { title: 'P' }, 'P的人');
  const q = await claimed(env, { title: 'Q' }, 'Q的人');
  assert.equal((await state(env, q.token, p.key)).json.is_owner, false);
  assert.equal((await state(env, p.token, q.key)).json.is_owner, false);
  assert.equal((await save(env, q.token, p.key, { upsert: [{ photo_key: '20260819/a.jpg', rating: 1 }] })).status, 403);
  assert.equal((await save(env, p.token, q.key, { upsert: [{ photo_key: '20260819/a.jpg', rating: 1 }] })).status, 403);
  assert.equal((await pick(env, 'POST', 'submit', q.token, { key: p.key, body: { relationship: '本人' } })).status, 403);
  assert.equal(rows(env, 'SELECT * FROM selections').length, 0);
  // and the rightful keys still work on their own links
  assert.equal((await state(env, p.token, p.key)).json.is_owner, true);
  assert.equal((await state(env, q.token, q.key)).json.is_owner, true);
});
