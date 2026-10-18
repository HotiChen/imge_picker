// Proof originals are the seat owner's (Tim 2026-10-15: "我不是主人，不應該讓我下載"). When the photographer turns
// allow_proof_download on, only the picker whose key is the project's owner seat (X-Picker-Key, a header: never
// a URL) may read a proof ORIGINAL or download it. Anyone else holding the link still sees proof thumbnails and
// still reads and downloads the finals. High tier: this is a read gate (docs/delivery.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBucket, fakeDB } from './fakes.mjs';
import { SECRET, call, claim, save, pick, createProject, collectingCtx, withT, rows, sha256Hex } from './pick-helpers.mjs';

const PROOF = 'shoot/毛片/';
const FINAL = 'shoot/精修/';
const PA = 'shoot/毛片/a.jpg';
const PNOTHUMB = 'shoot/毛片/nothumb.jpg';
const FA = 'shoot/精修/f1.jpg';
const OBJECTS = {
  [PA]: 'PROOF-A-ORIGINAL',
  [PNOTHUMB]: 'PROOF-NOTHUMB-ORIGINAL',
  [`_thumbs/400/${PA}.thumb`]: 'PROOF-A-400',
  [FA]: 'FINAL-A-ORIGINAL',
  [`_thumbs/400/${FA}.thumb`]: 'FINAL-A-400',
};
const enc = k => '/' + k.split('/').map(encodeURIComponent).join('/');
const setup = () => ({ imagepicker: fakeBucket(OBJECTS), DB: fakeDB(), PHOTOGRAPHER_TOKEN: SECRET });
const admin = (env, id, action, body) => call(env, `/api/admin/projects/${id}/${action}`, { method: 'POST', token: SECRET, body });
const setSwitch = (env, on) => env.DB._db.prepare('UPDATE projects SET allow_proof_download = ?').run(on ? 1 : 0);

// a project whose seat is taken (key) and, when `deliver`, delivered with the finals folder
async function world({ deliver = true, sw = true } = {}) {
  const env = setup();
  const created = await createProject(env, { folders: [PROOF] });
  const c = await claim(env, created.token);
  const p = { env, t: created.token, id: created.project.id, key: c.key };
  assert.equal((await save(env, p.t, p.key, { upsert: [{ photo_key: PA, rating: 1 }] })).status, 200);
  const ctxc = collectingCtx();
  assert.equal((await pick(env, 'POST', 'submit', p.t, { key: p.key, body: { relationship: '本人' } }, ctxc)).status, 200);
  await ctxc.settle();
  assert.equal((await admin(env, p.id, 'start-retouch')).status, 200);
  if (deliver) assert.equal((await admin(env, p.id, 'deliver', { final_folders: [FINAL] })).status, 200);
  setSwitch(env, sw);
  return p;
}
// the same read, the two ways a link travels: ?t= (an <a>/<img>) and X-Share-Token (a fetch); the key only as a header
const read = (p, path, key) => Promise.all([
  call(p.env, withT(path, p.t), key == null ? {} : { headers: { 'X-Picker-Key': key } }),
  call(p.env, path, { headers: { 'X-Share-Token': p.t, ...(key == null ? {} : { 'X-Picker-Key': key }) } }),
]);
const expect = async (p, path, key, status, body) => {
  for (const res of await read(p, path, key)) {
    const text = await res.clone().text();
    assert.equal(res.status, status, `${path} key=${key} → ${res.status} ${text}`);
    if (body !== undefined) assert.equal(text, body, path);
  }
};
const expectRefused = async (p, path, key) => {
  for (const res of await read(p, path, key)) {
    assert.equal(res.status, 403, `${path} key=${key} → ${res.status}`);
    assert.equal((await res.json()).code, 'original_not_allowed', path);
  }
};

test('delivered + switch on: the owner reads and downloads a proof original; the same link without the key is refused', async () => {
  const p = await world();
  for (const path of [enc(PA), `${enc(PA)}?download=1`]) {
    await expect(p, path, p.key, 200, 'PROOF-A-ORIGINAL');
    await expectRefused(p, path, null);
  }
});

test('anyone who is not the owner is a viewer: no key, a made-up key, another project\'s owner key, the key in the URL', async () => {
  const p = await world();
  const other = await createProject(p.env, { folders: ['other/'] });
  const otherKey = (await claim(p.env, other.token)).key;
  assert.ok(otherKey && otherKey !== p.key);
  for (const key of [null, '', 'not-a-key', otherKey]) {
    await expectRefused(p, `${enc(PA)}?download=1`, key);
    await expectRefused(p, enc(PA), key);
  }
  // the key is read from the header only, never from the query string
  for (const q of [`k=${p.key}`, `key=${p.key}`, `picker_key=${p.key}`, `owner_key=${p.key}`]) {
    const res = await call(p.env, withT(`${enc(PA)}?download=1&${q}`, p.t));
    assert.equal(res.status, 403, q);
  }
  // control: the owner's own key still works, so the refusals above are about the key and nothing else
  await expect(p, `${enc(PA)}?download=1`, p.key, 200, 'PROOF-A-ORIGINAL');
});

test('what a viewer still has: proof thumbnails, the proof listing, and the finals (thumbnail, original, download)', async () => {
  const p = await world();
  await expect(p, `${enc(PA)}?w=400`, null, 200, 'PROOF-A-400');
  await expect(p, enc(`_thumbs/400/${PA}.thumb`), null, 200, 'PROOF-A-400');
  await expect(p, enc(FA), null, 200, 'FINAL-A-ORIGINAL');
  await expect(p, `${enc(FA)}?download=1`, null, 200, 'FINAL-A-ORIGINAL');
  await expect(p, `${enc(FA)}?w=400`, null, 200, 'FINAL-A-400');
  for (const res of await read(p, `/?list=${encodeURIComponent(PROOF)}`, null)) assert.equal(res.status, 200);
});

test('a proof with no thumbnail: the owner gets the original as the fallback, a viewer gets 404 (never the original)', async () => {
  const p = await world();
  await expect(p, `${enc(PNOTHUMB)}?w=400`, p.key, 200, 'PROOF-NOTHUMB-ORIGINAL');
  for (const res of await read(p, `${enc(PNOTHUMB)}?w=400`, null)) {
    assert.equal(res.status, 404);
    assert.notEqual(await res.text(), 'PROOF-NOTHUMB-ORIGINAL');
  }
});

test('picking with the switch on: the same rule (owner only); a Range request is no way round it', async () => {
  const p = await world({ deliver: false });
  await expect(p, `${enc(PA)}?download=1`, p.key, 200, 'PROOF-A-ORIGINAL');
  await expectRefused(p, `${enc(PA)}?download=1`, null);
  const ranged = await call(p.env, withT(enc(PA), p.t), { headers: { Range: 'bytes=0-3' } });
  assert.equal(ranged.status, 403);
});

test('the switch still comes first: off means nobody, the owner included (delivered: the proofs are out of scope; picking: thumbnails only)', async () => {
  const delivered = await world({ deliver: true, sw: false });
  for (const key of [delivered.key, null]) await expect(delivered, `${enc(PA)}?download=1`, key, 401);
  const picking = await world({ deliver: false, sw: false });
  for (const key of [picking.key, null]) await expectRefused(picking, `${enc(PA)}?download=1`, key);
});

test('a proof original sent to the owner varies on the key, so a cache never hands it to a viewer', async () => {
  const p = await world();
  const res = await call(p.env, enc(PA), { headers: { 'X-Share-Token': p.t, 'X-Picker-Key': p.key } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('Vary') || '', /X-Picker-Key/i);
  assert.match(res.headers.get('Vary') || '', /X-Share-Token/i);
  // a read that never looked at the key (a final, its thumbnail) keeps the plain Vary: no needless cache split
  for (const path of [`${enc(FA)}?w=400`, enc(FA)]) {
    const r = await call(p.env, path, { headers: { 'X-Share-Token': p.t, 'X-Picker-Key': p.key } });
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get('Vary'), 'X-Share-Token', path);
  }
});

test('the gate reads nothing it should not: no write, and a thumbnail read does not need a key lookup', async () => {
  const p = await world();
  const before = JSON.stringify(rows(p.env, 'SELECT id, owner_picker_id, delivered_at FROM projects'));
  await expect(p, `${enc(PA)}?download=1`, p.key, 200);
  await expect(p, `${enc(PA)}?w=400`, null, 200);
  assert.equal(JSON.stringify(rows(p.env, 'SELECT id, owner_picker_id, delivered_at FROM projects')), before);
});

test('a real picker of this project who is not the seat owner is a viewer too: a second picker row, and a seat that was reset', async () => {
  const p = await world();
  // someone else of the same project (a valid key, a row in `pickers`): not the owner
  const stranger = 'STRANGER-KEY-0001';
  p.env.DB._db.prepare('INSERT INTO pickers (id, project_id, key_hash, name, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('picker-stranger', p.id, await sha256Hex(stranger), '路人', new Date().toISOString());
  await expectRefused(p, `${enc(PA)}?download=1`, stranger);
  await expect(p, `${enc(PA)}?download=1`, p.key, 200, 'PROOF-A-ORIGINAL');
  // the seat is reset (the owner is someone else now): the old owner's key still finds its picker row, and is no longer the owner
  p.env.DB._db.prepare('UPDATE projects SET owner_picker_id = ?').run('picker-stranger');
  await expectRefused(p, `${enc(PA)}?download=1`, p.key);
  await expect(p, `${enc(PA)}?download=1`, stranger, 200, 'PROOF-A-ORIGINAL');
  p.env.DB._db.prepare('UPDATE projects SET owner_picker_id = NULL').run();
  await expectRefused(p, `${enc(PA)}?download=1`, p.key);
  await expectRefused(p, `${enc(PA)}?download=1`, stranger);
});

test('an active collaborator (co-picking) is not the owner: no proof originals for them either', async () => {
  const p = await world();
  const collab = 'COLLAB-KEY-0001';
  const owner = rows(p.env, 'SELECT owner_picker_id FROM projects')[0].owner_picker_id;
  assert.ok(owner, 'the seat is taken');
  p.env.DB._db.prepare('INSERT INTO pickers (id, project_id, key_hash, name, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('picker-collab', p.id, await sha256Hex(collab), '共同挑選人', new Date().toISOString());
  p.env.DB._db.prepare('INSERT INTO project_collaborators (picker_id, project_id, invited_by, joined_at) VALUES (?, ?, ?, ?)')
    .run('picker-collab', p.id, owner, new Date().toISOString());
  // control: the state says this key really is an active collaborator (so the refusal below is about ownership, not a bad row)
  const st = await (await pick(p.env, 'GET', 'state', p.t, { key: collab })).json();
  assert.equal(st.is_owner, false);
  assert.equal(st.role, 'collaborator', JSON.stringify(st).slice(0, 200));
  await expectRefused(p, `${enc(PA)}?download=1`, collab);
  await expect(p, `${enc(PA)}?w=400`, collab, 200, 'PROOF-A-400');          // thumbnails: as everyone
  await expect(p, `${enc(FA)}?download=1`, collab, 200, 'FINAL-A-ORIGINAL'); // finals: as everyone
  await expect(p, `${enc(PA)}?download=1`, p.key, 200, 'PROOF-A-ORIGINAL');
});
