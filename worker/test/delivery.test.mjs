// Delivery (交件): the pick link turns into the delivery gallery once the
// photographer delivers, and a per-project switch opens the proof originals
// (docs/delivery.md). High tier: this changes what a link can read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import worker from '../worker.js';
import { fakeBucket, fakeDB, ctx, req } from './fakes.mjs';
import {
  SECRET, call, pick, claim, save, one, rows, seedToken, days, withT, collectingCtx,
} from './pick-helpers.mjs';

const PROOF = 'shoot/毛片/';
const FINAL = 'shoot/精修/';
const PA = 'shoot/毛片/a.jpg';
const PSUB = 'shoot/毛片/sub/c.jpg';
const FA = 'shoot/精修/f1.jpg';
const FQ = 'shoot/精修/新娘 "1".jpg';
const FSUB = 'shoot/精修/sub/g.jpg';
const FNOTHUMB = 'shoot/精修/nothumb.jpg';
const thumb = (k, w = 400) => `_thumbs/${w}/${k}.thumb`;

const OBJECTS = {
  '_books/b1.json': '{"notifyUrl":"https://hook.example/secret"}',
  [PA]: 'PROOF-A-ORIGINAL',
  'shoot/毛片/b.jpg': 'PROOF-B-ORIGINAL',
  [PSUB]: 'PROOF-SUB-ORIGINAL',
  [thumb(PA)]: 'PROOF-A-400',
  [thumb(PA, 1600)]: 'PROOF-A-1600',
  [thumb(PSUB)]: 'PROOF-SUB-400',
  [FA]: 'FINAL-A-ORIGINAL',
  [FQ]: 'FINAL-Q-ORIGINAL',
  [FSUB]: 'FINAL-SUB-ORIGINAL',
  [FNOTHUMB]: 'FINAL-NOTHUMB-ORIGINAL',
  [thumb(FA)]: 'FINAL-A-400',
  [thumb(FSUB)]: 'FINAL-SUB-400',
  // the sibling / prefix tricks: a bare startsWith would let these through
  'shoot/精修-x/leak.jpg': 'LEAK-FINAL-SIBLING',
  'shoot/毛片x/leak.jpg': 'LEAK-PROOF-SIBLING',
  [thumb('shoot/精修-x/leak.jpg')]: 'LEAK-FINAL-SIBLING-400',
  'other/x.jpg': 'OTHER-SHOOT',
};

function setup(schema) {
  return { imagepicker: fakeBucket(OBJECTS), DB: fakeDB(schema ? { schema } : {}), PHOTOGRAPHER_TOKEN: SECRET };
}

const admin = (env, id, action, body, token = SECRET) =>
  call(env, `/api/admin/projects/${id}/${action}`, { method: 'POST', token, body });
const deliver = (env, id, finals = [FINAL], token = SECRET) =>
  admin(env, id, 'deliver', finals === undefined ? undefined : { final_folders: finals }, token);
const patch = (env, id, body, token = SECRET) =>
  call(env, `/api/admin/projects/${id}`, { method: 'PATCH', token, body });
const detail = async (env, id) => (await call(env, `/api/admin/projects/${id}`, { token: SECRET })).json();
const list = async env => (await call(env, '/api/admin/projects', { token: SECRET })).json();
const state = async (env, t, key) => {
  const res = await pick(env, 'GET', 'state', t, { key });
  assert.equal(res.status, 200);
  return res.json();
};
// a read through the link, the way an <img> sends it (?t=)
const read = (env, path, t) => call(env, withT(path, t));
const readHeader = (env, path, t) => call(env, path, { headers: { 'X-Share-Token': t } });
const enc = k => '/' + k.split('/').map(encodeURIComponent).join('/');
const listing = (env, prefix, t) => read(env, `/?list=${encodeURIComponent(prefix)}`, t);

async function createProject(env, folders = [PROOF]) {
  const res = await call(env, '/api/admin/projects', {
    method: 'POST', token: SECRET, body: { title: '王先生 婚紗', folders, pick_limit: 40, extra_price: 200 },
  });
  assert.equal(res.status, 201);
  return res.json();
}

async function submit(env, t, key) {
  const c = collectingCtx();
  const res = await pick(env, 'POST', 'submit', t, { key, body: { relationship: '本人' } }, c);
  await c.settle();
  return res;
}

// a project in retouching: claimed, one pick submitted, retouch started
async function retouching(env, folders) {
  const created = await createProject(env, folders);
  const c = await claim(env, created.token);
  const p = { ...created, key: c.key, id: created.project.id };
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: PA, rating: 1 }] })).status, 200);
  assert.equal((await submit(env, p.token, p.key)).status, 200);
  assert.equal((await admin(env, p.id, 'start-retouch')).status, 200);
  return p;
}

async function delivered(env, finals = [FINAL]) {
  const p = await retouching(env);
  const res = await deliver(env, p.id, finals);
  assert.equal(res.status, 200, await res.clone().text());
  return p;
}

const setSwitch = (env, on) => env.DB._db.prepare('UPDATE projects SET allow_proof_download = ?').run(on ? 1 : 0);

async function expectStatus(env, t, path, status, body) {
  for (const res of [await read(env, path, t), await readHeader(env, path, t)]) {
    const text = await res.text();
    assert.equal(res.status, status, `${path} → ${res.status} ${text}`);
    if (body !== undefined) assert.equal(text, body, path);
  }
}

function landOnce(env, re, sql, ...args) {
  const prepare = env.DB.prepare.bind(env.DB);
  let done = false;
  env.DB.prepare = s => {
    if (!done && re.test(s)) { done = true; env.DB._db.prepare(sql).run(...args); }
    return prepare(s);
  };
}

// ─── schema ──────────────────────────────────────────────────────────────────

test('migration: two append-only ALTERs, noted in schema.sql; a new project defaults to not delivered, switch off', async () => {
  const file = new URL('../migrations/2026-09-30-delivery.sql', import.meta.url);
  assert.ok(existsSync(file));
  const sql = readFileSync(file, 'utf8');
  assert.match(sql, /ALTER TABLE projects ADD COLUMN final_folders TEXT;/);
  assert.match(sql, /ALTER TABLE projects ADD COLUMN allow_proof_download INTEGER NOT NULL DEFAULT 0;/);
  assert.match(sql, /duplicate column/i);
  assert.equal(sql.match(/^\s*(CREATE|DROP|UPDATE|DELETE|INSERT)\b/gim), null, 'ALTERs only');
  assert.match(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'), /2026-09-30-delivery\.sql/);
  const env = setup();
  const p = await createProject(env);
  assert.deepEqual({ ...one(env, 'SELECT final_folders, allow_proof_download FROM projects') },
    { final_folders: null, allow_proof_download: 0 });
  const d = await detail(env, p.project.id);
  assert.equal(d.project.final_folders, null);
  assert.equal(d.project.allow_proof_download, false);
});

// ─── deliver: auth and validation ────────────────────────────────────────────

test('deliver / undeliver / the switch are admin only', async () => {
  const env = setup();
  const p = await retouching(env);
  const before = JSON.stringify(rows(env, 'SELECT * FROM projects'));
  for (const token of ['', 'wrong', p.token]) {  // '' = no Authorization header
    assert.equal((await deliver(env, p.id, [FINAL], token)).status, 401);
    assert.equal((await admin(env, p.id, 'undeliver', undefined, token)).status, 401);
    assert.equal((await patch(env, p.id, { allow_proof_download: true }, token)).status, 401);
  }
  // the link itself as ?t= or header is no admin credential either
  assert.equal((await call(env, withT(`/api/admin/projects/${p.id}/deliver`, p.token), { method: 'POST', body: { final_folders: [FINAL] } })).status, 401);
  assert.equal((await call(env, `/api/admin/projects/${p.id}`, { method: 'PATCH', headers: { 'X-Share-Token': p.token }, body: { allow_proof_download: true } })).status, 401);
  assert.equal(JSON.stringify(rows(env, 'SELECT * FROM projects')), before);
});

test('deliver stores the canonical finals and stamps delivered_at in one write', async () => {
  const env = setup();
  const p = await retouching(env);
  const res = await deliver(env, p.id, ['  shoot/精修 ', 'shoot/精修/', 'shoot/精修2/']);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.deepEqual(json.final_folders, [FINAL, 'shoot/精修2/']);
  assert.match(json.delivered_at, /^\d{4}-\d\d-\d\dT/);
  const row = one(env, 'SELECT delivered_at, final_folders, phase FROM projects');
  assert.equal(row.delivered_at, json.delivered_at);
  assert.deepEqual(JSON.parse(row.final_folders), [FINAL, 'shoot/精修2/']);
  assert.equal(row.phase, 'retouching');
  const writes = env.DB._writes().filter(s => /final_folders/.test(s));
  assert.equal(writes.length, 1);
  assert.match(writes[0], /delivered_at/, 'same statement as the stamp');
});

test('a repeat deliver may change the finals and keeps the first stamp', async () => {
  const env = setup();
  const p = await delivered(env);
  env.DB._db.prepare("UPDATE projects SET delivered_at = '2026-01-01T00:00:00.000Z'").run();
  const res = await deliver(env, p.id, ['shoot/精修2/']);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.delivered_at, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(json.final_folders, ['shoot/精修2/']);
  assert.deepEqual(JSON.parse(one(env, 'SELECT final_folders FROM projects').final_folders), ['shoot/精修2/']);
  // and the gallery follows: the old finals are gone from the link
  await expectStatus(env, p.token, `${enc(FA)}?w=400`, 401);
});

test('deliver refuses malformed finals with 400 invalid_final_folders and writes nothing', async () => {
  const env = setup();
  const p = await retouching(env);
  const before = JSON.stringify(rows(env, 'SELECT * FROM projects'));
  const bads = [
    undefined, null, 'shoot/精修/', {}, [], [''], ['   '], [123], [null], ['/'], ['/shoot/精修/'],
    ['_thumbs/'], ['_books/'], ['shoot/../other/'], ['shoot/./精修/'], [FINAL, 7],
    ['shoot/精修\n/'], ['shoot/\u2028/'], ['x'.repeat(300) + '/'],
  ];
  for (const bad of bads) {
    const res = await admin(env, p.id, 'deliver', bad === undefined ? undefined : { final_folders: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal((await res.json()).code, 'invalid_final_folders', JSON.stringify(bad));
  }
  const raw = await call(env, `/api/admin/projects/${p.id}/deliver`, { method: 'POST', token: SECRET, body: 'not json' });
  assert.equal(raw.status, 400);
  assert.equal((await raw.json()).code, 'invalid_final_folders');
  assert.equal(JSON.stringify(rows(env, 'SELECT * FROM projects')), before);
});

test('deliver takes at most 20 final folders: 21 is 400 too_many_final_folders, 20 is fine', async () => {
  const env = setup();
  const p = await retouching(env);
  const many = n => Array.from({ length: n }, (_, i) => `shoot/精修${i}/`);
  const res = await deliver(env, p.id, many(21));
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.code, 'too_many_final_folders');
  assert.equal(json.max, 20);
  assert.equal(one(env, 'SELECT delivered_at FROM projects').delivered_at, null);
  const ok = await deliver(env, p.id, many(20));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).final_folders.length, 20);
});

test('deliver refuses a finals folder equal to, inside or containing a proof folder (400 final_overlaps_proofs)', async () => {
  const env = setup();
  const p = await retouching(env);
  const before = JSON.stringify(rows(env, 'SELECT * FROM projects'));
  for (const bad of ['shoot/毛片/', 'shoot/毛片', 'shoot/毛片/精修/', 'shoot/毛片/sub/deeper/', 'shoot/', 'shoot']) {
    const res = await deliver(env, p.id, [FINAL, bad]);
    assert.equal(res.status, 400, bad);
    const json = await res.json();
    assert.equal(json.code, 'final_overlaps_proofs', bad);
    assert.equal(json.folder, bad.endsWith('/') ? bad : bad + '/');
  }
  assert.equal(JSON.stringify(rows(env, 'SELECT * FROM projects')), before);
  // a sibling that only shares the prefix is a different folder
  for (const ok of ['shoot/毛片x/', 'shoot/毛', 'shoo/']) {
    const res = await deliver(env, p.id, [ok]);
    assert.equal(res.status, 200, ok);
  }
});

test('the overlap check also covers a pick link whose snapshot differs from the project', async () => {
  const env = setup();
  const p = await retouching(env);
  await seedToken(env, { token: 'ODD', project_id: p.id, folders: ['elsewhere/proofs/'] });
  const res = await deliver(env, p.id, ['elsewhere/']);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'final_overlaps_proofs');
  assert.equal(one(env, 'SELECT delivered_at FROM projects').delivered_at, null);
});

test('deliver is still only from retouching (409 not_retouching), checked before the body and inside the write', async () => {
  const env = setup();
  const created = await createProject(env);
  const id = created.project.id;
  for (const body of [{ final_folders: [FINAL] }, undefined]) {
    const res = await admin(env, id, 'deliver', body);
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.code, 'not_retouching');
    assert.equal(json.phase, 'picking');
  }
  env.DB._db.prepare("UPDATE projects SET phase = 'submitted'").run();
  assert.equal((await deliver(env, id)).status, 409);
  assert.deepEqual({ ...one(env, 'SELECT delivered_at, final_folders FROM projects') }, { delivered_at: null, final_folders: null });
  // a reopen landing between the route's read and its write wins
  env.DB._db.prepare("UPDATE projects SET phase = 'retouching'").run();
  landOnce(env, /^\s*UPDATE projects SET delivered_at/i, "UPDATE projects SET phase = 'picking'");
  const raced = await deliver(env, id);
  assert.equal(raced.status, 409);
  assert.equal((await raced.json()).code, 'not_retouching');
  assert.deepEqual({ ...one(env, 'SELECT delivered_at, final_folders FROM projects') }, { delivered_at: null, final_folders: null });
});

test('deliver / undeliver / the switch: unknown or other photographer is 404, untouched', async () => {
  const env = setup();
  const p = await retouching(env);
  env.DB._db.prepare("UPDATE projects SET photographer_id = 'other'").run();
  const before = JSON.stringify(rows(env, 'SELECT * FROM projects'));
  for (const id of [p.id, 'nope']) {
    assert.equal((await deliver(env, id)).status, 404);
    assert.equal((await admin(env, id, 'undeliver')).status, 404);
    assert.equal((await patch(env, id, { allow_proof_download: true })).status, 404);
  }
  assert.equal(JSON.stringify(rows(env, 'SELECT * FROM projects')), before);
});

test('undeliver clears delivered_at and the finals; reopen clears both too', async () => {
  const env = setup();
  const p = await delivered(env);
  const res = await admin(env, p.id, 'undeliver');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, delivered_at: null });
  assert.deepEqual({ ...one(env, 'SELECT delivered_at, final_folders, phase FROM projects') },
    { delivered_at: null, final_folders: null, phase: 'retouching' });
  assert.equal((await deliver(env, p.id)).status, 200);
  assert.equal((await admin(env, p.id, 'reopen')).status, 200);
  assert.deepEqual({ ...one(env, 'SELECT delivered_at, final_folders, phase FROM projects') },
    { delivered_at: null, final_folders: null, phase: 'picking' });
});

// ─── the switch ──────────────────────────────────────────────────────────────

test('PATCH /api/admin/projects/:id sets allow_proof_download on and off; list and detail expose it and the finals', async () => {
  const env = setup();
  const p = await delivered(env);
  let res = await patch(env, p.id, { allow_proof_download: true });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, allow_proof_download: true });
  assert.equal(one(env, 'SELECT allow_proof_download FROM projects').allow_proof_download, 1);
  let d = await detail(env, p.id);
  assert.equal(d.project.allow_proof_download, true);
  assert.deepEqual(d.project.final_folders, [FINAL]);
  let l = (await list(env)).projects.find(r => r.id === p.id);
  assert.equal(l.allow_proof_download, true);
  assert.deepEqual(l.final_folders, [FINAL]);
  res = await patch(env, p.id, { allow_proof_download: false });
  assert.deepEqual(await res.json(), { ok: true, allow_proof_download: false });
  assert.equal(one(env, 'SELECT allow_proof_download FROM projects').allow_proof_download, 0);
  d = await detail(env, p.id);
  assert.equal(d.project.allow_proof_download, false);
  l = (await list(env)).projects.find(r => r.id === p.id);
  assert.equal(l.allow_proof_download, false);
  await admin(env, p.id, 'undeliver');
  assert.equal((await detail(env, p.id)).project.final_folders, null);
  assert.equal((await list(env)).projects.find(r => r.id === p.id).final_folders, null);
});

test('PATCH refuses anything but a boolean allow_proof_download (400 invalid_body)', async () => {
  const env = setup();
  const p = await retouching(env);
  for (const body of [{}, { allow_proof_download: 1 }, { allow_proof_download: 'true' }, { allow_proof_download: null },
    { allow_proof_download: true, final_folders: [FINAL] }, { phase: 'picking' }, [true], 'x']) {
    const res = await patch(env, p.id, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).code, 'invalid_body');
  }
  assert.deepEqual({ ...one(env, 'SELECT allow_proof_download, final_folders, phase FROM projects') },
    { allow_proof_download: 0, final_folders: null, phase: 'retouching' });
});

// ─── guest: picking mode ─────────────────────────────────────────────────────

test('picking: proofs are thumbnails only — the original, a download and a missing thumbnail never serve the original', async () => {
  const env = setup();
  const p = await createProject(env);
  const t = p.token;
  await expectStatus(env, t, `${enc(PA)}?w=400`, 200, 'PROOF-A-400');
  await expectStatus(env, t, `${enc(PA)}?w=1200`, 200, 'PROOF-A-1600');
  await expectStatus(env, t, enc(thumb(PA)), 200, 'PROOF-A-400');
  await expectStatus(env, t, `${enc(PSUB)}?w=400`, 200, 'PROOF-SUB-400');
  for (const path of [enc(PA), `${enc(PA)}?download=1`, `${enc(PA)}?w=400&download=1`, enc(PSUB)]) {
    const res = await read(env, path, t);
    assert.equal(res.status, 403, path);
    assert.equal((await res.json()).code, 'original_not_allowed', path);
  }
  // no thumbnail yet: not the original as a fallback
  const miss = await read(env, `${enc('shoot/毛片/b.jpg')}?w=400`, t);
  assert.equal(miss.status, 404);
  assert.notEqual(await miss.text(), 'PROOF-B-ORIGINAL');
  // a Range request is no way round it
  const ranged = await call(env, withT(enc(PA), t), { headers: { Range: 'bytes=0-3' } });
  assert.equal(ranged.status, 403);
  const listed = await listing(env, PROOF, t);
  assert.equal(listed.status, 200);
  const json = await listed.json();
  assert.deepEqual(json.data.map(f => f.id).sort(), [PA, 'shoot/毛片/b.jpg']);
  assert.deepEqual(json.folders, ['shoot/毛片/sub/']);
});

test('picking: finals are invisible, even with a finals snapshot sitting on the project undelivered', async () => {
  const env = setup();
  const p = await createProject(env);
  env.DB._db.prepare('UPDATE projects SET final_folders = ?').run(JSON.stringify([FINAL]));
  for (const path of [enc(FA), `${enc(FA)}?w=400`, enc(thumb(FA)), `${enc(FA)}?download=1`, `/?list=${encodeURIComponent(FINAL)}`]) {
    await expectStatus(env, p.token, path, 401);
  }
  const s = await state(env, p.token);
  assert.equal(s.mode, 'picking');
  assert.deepEqual(s.final_folders, []);
  assert.deepEqual(s.folders, [PROOF]);
  assert.equal(s.allow_proof_download, false);
  assert.equal(s.delivered_at, null);
});

test('picking with the switch on: proof originals and downloads are served', async () => {
  const env = setup();
  const p = await createProject(env);
  setSwitch(env, true);
  await expectStatus(env, p.token, enc(PA), 200, 'PROOF-A-ORIGINAL');
  await expectStatus(env, p.token, enc(PSUB), 200, 'PROOF-SUB-ORIGINAL');
  // no thumbnail: the original is allowed now, so it is the fallback
  await expectStatus(env, p.token, `${enc('shoot/毛片/b.jpg')}?w=400`, 200, 'PROOF-B-ORIGINAL');
  const dl = await read(env, `${enc(PA)}?download=1`, p.token);
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), 'PROOF-A-ORIGINAL');
  assert.match(dl.headers.get('Content-Disposition'), /^attachment;/);
  const s = await state(env, p.token);
  assert.equal(s.mode, 'picking');
  assert.equal(s.allow_proof_download, true);
  // switched off again: back to thumbnails only
  setSwitch(env, false);
  assert.equal((await read(env, enc(PA), p.token)).status, 403);
  assert.equal((await read(env, `${enc(PA)}?w=400`, p.token)).status, 200);
});

// ─── guest: delivered ────────────────────────────────────────────────────────

test('delivered: finals — thumbnails, originals, downloads, subfolders and listings — are served', async () => {
  const env = setup();
  const p = await delivered(env);
  const t = p.token;
  await expectStatus(env, t, `${enc(FA)}?w=400`, 200, 'FINAL-A-400');
  await expectStatus(env, t, enc(thumb(FA)), 200, 'FINAL-A-400');
  await expectStatus(env, t, enc(FA), 200, 'FINAL-A-ORIGINAL');
  await expectStatus(env, t, enc(FSUB), 200, 'FINAL-SUB-ORIGINAL');
  await expectStatus(env, t, `${enc(FNOTHUMB)}?w=400`, 200, 'FINAL-NOTHUMB-ORIGINAL');
  await expectStatus(env, t, `${enc(FA)}?download=1`, 200, 'FINAL-A-ORIGINAL');
  // download means the original, whatever ?w= says
  await expectStatus(env, t, `${enc(FA)}?w=400&download=1`, 200, 'FINAL-A-ORIGINAL');
  const listed = await listing(env, FINAL, t);
  assert.equal(listed.status, 200);
  const json = await listed.json();
  assert.deepEqual(json.data.map(f => f.id).sort(), [FA, FNOTHUMB, FQ].sort());
  assert.deepEqual(json.folders, ['shoot/精修/sub/']);
  assert.equal((await listing(env, 'shoot/精修/sub/', t)).status, 200);
});

test('delivered: proofs are gone (thumbnails, originals, listing) while the switch is off', async () => {
  const env = setup();
  const p = await delivered(env);
  for (const path of [`${enc(PA)}?w=400`, enc(thumb(PA)), enc(PA), `${enc(PA)}?download=1`, `${enc(PSUB)}?w=400`,
    `/?list=${encodeURIComponent(PROOF)}`]) {
    await expectStatus(env, p.token, path, 401);
  }
});

test('delivered with the switch on: proofs come back, download-only (originals, thumbnails for the list)', async () => {
  const env = setup();
  const p = await delivered(env);
  setSwitch(env, true);
  await expectStatus(env, p.token, `${enc(PA)}?w=400`, 200, 'PROOF-A-400');
  await expectStatus(env, p.token, enc(PA), 200, 'PROOF-A-ORIGINAL');
  await expectStatus(env, p.token, `${enc(PA)}?download=1`, 200, 'PROOF-A-ORIGINAL');
  assert.equal((await listing(env, PROOF, p.token)).status, 200);
  // and the finals are still there
  await expectStatus(env, p.token, enc(FA), 200, 'FINAL-A-ORIGINAL');
  const s = await state(env, p.token);
  assert.equal(s.mode, 'delivered');
  assert.deepEqual(s.folders, [PROOF]);
  assert.deepEqual(s.final_folders, [FINAL]);
  assert.equal(s.allow_proof_download, true);
  // …but not for picking: the guest's writes stay refused
  const sv = await save(env, p.token, p.key, { upsert: [{ photo_key: PA, rating: 5 }] });
  assert.equal(sv.status, 409);
  assert.equal((await sv.json()).code, 'retouching');
});

test('delivered: nothing outside the finals — siblings, other shoots, traversal, `_` keys', async () => {
  const env = setup();
  const p = await delivered(env);
  setSwitch(env, true);
  for (const path of [
    enc('shoot/精修-x/leak.jpg'), `${enc('shoot/精修-x/leak.jpg')}?w=400`, enc(thumb('shoot/精修-x/leak.jpg')),
    enc('shoot/毛片x/leak.jpg'), enc('other/x.jpg'), `${enc('other/x.jpg')}?download=1`,
    '/shoot%2F%E7%B2%BE%E4%BF%AE%2F..%2F..%2Fother%2Fx.jpg',
    '/shoot/%E7%B2%BE%E4%BF%AE/%2E%2E/%2E%2E/other/x.jpg',
    '/_books/b1.json', '/_books/b1.json?download=1',
    `/?list=${encodeURIComponent('shoot/精修-x/')}`, `/?list=${encodeURIComponent('shoot/')}`,
    `/?list=${encodeURIComponent('')}`, `/?list=${encodeURIComponent('_books/')}`,
    `/?list=${encodeURIComponent('shoot/精修/../')}`,
  ]) {
    await expectStatus(env, p.token, path, 401);
  }
});

test('a hand-written finals snapshot naming `_` folders, `/` or traversal opens nothing', async () => {
  const env = setup();
  const p = await delivered(env);
  for (const finals of [['_books/'], ['/'], ['shoot/精修/../../'], ['_thumbs/']]) {
    env.DB._db.prepare('UPDATE projects SET final_folders = ?').run(JSON.stringify(finals));
    for (const path of ['/_books/b1.json', enc(thumb('shoot/精修-x/leak.jpg')), enc('other/x.jpg'), `/?list=${encodeURIComponent('_books/')}`, `/?list=${encodeURIComponent('_thumbs/')}`]) {
      await expectStatus(env, p.token, path, 401);
    }
    // a snapshot that fails the deliver rules is not a delivery at all
    const st = await state(env, p.token);
    assert.equal(st.mode, 'picking', JSON.stringify(finals));
    assert.deepEqual(st.final_folders, []);
  }
  for (const junk of ['not json', '{"a":1}', '[]', 'null']) {
    env.DB._db.prepare('UPDATE projects SET final_folders = ?').run(junk);
    await expectStatus(env, p.token, enc(FA), 401);
    // a snapshot that cannot be read is not a delivery: the proofs stay as picking had them
    await expectStatus(env, p.token, enc(PA), 403);
    assert.equal((await state(env, p.token)).mode, 'picking');
  }
});

test('delivered: pick state switches the page to the gallery; viewers get the same scope as the owner', async () => {
  const env = setup();
  const p = await delivered(env);
  const owner = await state(env, p.token, p.key);
  const viewer = await state(env, p.token);
  const stranger = await state(env, p.token, 'not-a-key');
  for (const s of [owner, viewer, stranger]) {
    assert.equal(s.mode, 'delivered');
    assert.deepEqual(s.final_folders, [FINAL]);
    assert.deepEqual(s.folders, []);
    assert.equal(s.allow_proof_download, false);
    assert.equal(s.delivered_at, one(env, 'SELECT delivered_at FROM projects').delivered_at);
  }
  assert.equal(owner.is_owner, true);
  assert.equal(viewer.is_owner, false);
  // reads carry no picker key at all: an owner's key changes nothing
  for (const headers of [{}, { 'X-Picker-Key': p.key }, { 'X-Picker-Key': 'nope' }]) {
    const res = await call(env, withT(`${enc(FA)}?download=1`, p.token), { headers });
    assert.equal(res.status, 200);
    const off = await call(env, withT(`${enc(PA)}?w=400`, p.token), { headers });
    assert.equal(off.status, 401);
  }
});

test('delivered: guest save and submit are still refused (409 retouching), nothing written', async () => {
  const env = setup();
  const p = await delivered(env);
  const sv = await save(env, p.token, p.key, { upsert: [{ photo_key: PA, rating: 3 }] });
  assert.equal(sv.status, 409);
  assert.equal((await sv.json()).code, 'retouching');
  const sub = await submit(env, p.token, p.key);
  assert.equal(sub.status, 409);
  assert.equal(one(env, 'SELECT rating FROM selections').rating, 1);
  assert.equal(rows(env, 'SELECT * FROM submissions').length, 1);
  assert.equal((await save(env, p.token, undefined, { upsert: [{ photo_key: PA, rating: 3 }] })).status, 403);
});

test('undeliver takes the gallery down: back to the proofs, thumbnails only', async () => {
  const env = setup();
  const p = await delivered(env);
  await expectStatus(env, p.token, enc(FA), 200);
  assert.equal((await admin(env, p.id, 'undeliver')).status, 200);
  await expectStatus(env, p.token, enc(FA), 401);
  await expectStatus(env, p.token, `${enc(FA)}?w=400`, 401);
  await expectStatus(env, p.token, `${enc(PA)}?w=400`, 200, 'PROOF-A-400');
  await expectStatus(env, p.token, enc(PA), 403);
  const s = await state(env, p.token);
  assert.equal(s.mode, 'picking');
  assert.deepEqual(s.final_folders, []);
  assert.deepEqual(s.folders, [PROOF]);
});

test('a legacy delivered stamp without finals keeps the picking scope', async () => {
  const env = setup();
  const p = await retouching(env);
  env.DB._db.prepare("UPDATE projects SET delivered_at = '2026-09-01T00:00:00.000Z'").run();
  const s = await state(env, p.token);
  assert.equal(s.mode, 'picking');
  await expectStatus(env, p.token, `${enc(PA)}?w=400`, 200);
  await expectStatus(env, p.token, enc(PA), 403);
});

// ─── dead links ──────────────────────────────────────────────────────────────

const EVERY_READ = [
  enc(FA), `${enc(FA)}?w=400`, enc(thumb(FA)), `${enc(FA)}?download=1`, `/?list=${encodeURIComponent(FINAL)}`,
  enc(PA), `${enc(PA)}?w=400`, `/?list=${encodeURIComponent(PROOF)}`,
];

test('archived, revoked and expired links refuse everything, finals included', async () => {
  for (const kill of ['archive', 'revoke', 'expire', 'archive-revived']) {
    const env = setup();
    const p = await delivered(env);
    setSwitch(env, true);
    await expectStatus(env, p.token, enc(FA), 200);
    if (kill === 'archive' || kill === 'archive-revived') assert.equal((await admin(env, p.id, 'archive')).status, 200);
    if (kill === 'archive-revived') env.DB._db.prepare('UPDATE share_tokens SET revoked_at = NULL').run();
    if (kill === 'revoke') assert.equal((await call(env, `/api/shares/${p.token}/revoke`, { method: 'POST', token: SECRET })).status, 200);
    if (kill === 'expire') env.DB._db.prepare('UPDATE share_tokens SET expires_at = ?').run(days(-1));
    for (const path of EVERY_READ) await expectStatus(env, p.token, path, 401);
    assert.equal((await pick(env, 'GET', 'state', p.token, { key: p.key })).status, 401, kill);
  }
});

test("another project's link never reads this project's finals, and vice versa", async () => {
  const env = setup();
  const p = await delivered(env);
  const q = await createProject(env, ['other/']);
  setSwitch(env, true);
  for (const path of [enc(FA), `${enc(FA)}?w=400`, `${enc(FA)}?download=1`, enc(PA), `/?list=${encodeURIComponent(FINAL)}`]) {
    await expectStatus(env, q.token, path, 401);
  }
  // q, undelivered with the switch on, reads its own proofs in full
  await expectStatus(env, q.token, enc('other/x.jpg'), 200, 'OTHER-SHOOT');
  await expectStatus(env, p.token, enc('other/x.jpg'), 401);
});

// ─── download headers ────────────────────────────────────────────────────────

test('download: attachment with an ASCII-safe filename and the RFC 5987 UTF-8 name, same object headers', async () => {
  const env = setup();
  const p = await delivered(env);
  const res = await read(env, `${enc(FQ)}?download=1`, p.token);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'FINAL-Q-ORIGINAL');
  const cd = res.headers.get('Content-Disposition');
  const m = /^attachment; filename="([^"]*)"; filename\*=UTF-8''([^;\s]+)$/.exec(cd);
  assert.ok(m, cd);
  assert.match(m[1], /^[\x20-\x7e]+$/);
  assert.ok(!/["\\]/.test(m[1]));
  assert.match(m[1], /\.jpg$/);
  assert.match(m[2], /^[A-Za-z0-9!#$&+\-.^_`|~%]+$/, 'attr-chars and pct-encoding only');
  assert.equal(decodeURIComponent(m[2]), '新娘 "1".jpg');
  assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
  assert.ok(res.headers.get('etag'));
  assert.match(res.headers.get('Cache-Control'), /^private/);
  assert.equal(res.headers.get('Vary'), 'X-Share-Token');
  const plain = await read(env, `${enc(FA)}?download=1`, p.token);
  assert.equal(plain.headers.get('Content-Disposition'), `attachment; filename="f1.jpg"; filename*=UTF-8''f1.jpg`);
  // a plain read of the same photo is not an attachment
  assert.equal((await read(env, enc(FA), p.token)).headers.get('Content-Disposition'), null);
  // characters RFC 5987 does not allow raw are percent-encoded
  env.imagepicker._store.set('shoot/精修/it\'s (1)*.jpg', { ...env.imagepicker._store.get(FA), key: 'x' });
  const odd = await read(env, `${enc("shoot/精修/it's (1)*.jpg")}?download=1`, p.token);
  const star = /filename\*=UTF-8''(.+)$/.exec(odd.headers.get('Content-Disposition'))[1];
  assert.equal(star, 'it%27s%20%281%29%2A.jpg');
});

test('download of a thumbnail key is 400; the photographer can download any original', async () => {
  const env = setup();
  const p = await delivered(env);
  assert.equal((await read(env, `${enc(thumb(FA))}?download=1`, p.token)).status, 400);
  const res = await call(env, `${enc(PA)}?download=1`, { token: SECRET });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'PROOF-A-ORIGINAL');
  assert.match(res.headers.get('Content-Disposition'), /^attachment; filename="a.jpg"/);
});

// ─── before the migration ────────────────────────────────────────────────────

test('on a database the migration has not reached, the rest of the app keeps working', async () => {
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
    .replace(/^\s*final_folders\b.*$/m, '')
    .replace(/^\s*allow_proof_download\b.*$/m, '')
    // the column before them loses its trailing comma
    .replace(/(delivered_at\s+TEXT),(\s*(--[^\n]*\n\s*)*\))/, '$1$2');
  const env = setup(schema);
  assert.throws(() => env.DB._db.prepare('SELECT final_folders FROM projects').all(), /no such column/);
  const p = await retouching(env);
  const l = (await list(env)).projects.find(r => r.id === p.id);
  assert.equal(l.final_folders, null);
  assert.equal(l.allow_proof_download, false);
  const d = await detail(env, p.id);
  assert.equal(d.project.final_folders, null);
  assert.equal(d.project.allow_proof_download, false);
  const s = await state(env, p.token, p.key);
  assert.equal(s.mode, 'picking');
  assert.equal(s.allow_proof_download, false);
  await expectStatus(env, p.token, `${enc(PA)}?w=400`, 200, 'PROOF-A-400');
  await expectStatus(env, p.token, enc(PA), 403);
  env.DB._db.prepare("UPDATE projects SET delivered_at = 'x'").run();
  assert.equal((await admin(env, p.id, 'undeliver')).status, 200);
  assert.equal(one(env, 'SELECT delivered_at FROM projects').delivered_at, null);
  env.DB._db.prepare("UPDATE projects SET delivered_at = 'x'").run();
  assert.equal((await admin(env, p.id, 'reopen')).status, 200);
  assert.deepEqual({ ...one(env, 'SELECT phase, delivered_at FROM projects') }, { phase: 'picking', delivered_at: null });
});

// the other kinds of link keep today's behaviour
test('an album link still reads originals in its folders; no Content-Disposition unless asked', async () => {
  const env = setup();
  await seedToken(env, { token: 'ALBUM', kind: 'client', book_id: 'b1', folders: [PROOF] });
  const res = await read(env, enc(PA), 'ALBUM');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'PROOF-A-ORIGINAL');
  assert.equal(res.headers.get('Content-Disposition'), null);
  assert.equal((await read(env, enc(FA), 'ALBUM')).status, 401);
});
