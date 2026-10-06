// Shared fixtures for the revision-pins tests (docs/revision-pins.md):
// revision-pins.test.mjs (drafts, submit, state, admin, before the
// migration) and revision-rounds-gate.test.mjs (history + the thumbnail
// route). Not a test file itself: the runner globs *.test.mjs.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fakeBucket, fakeDB } from './fakes.mjs';
import { SECRET, call, pick, claim, save, one, rows, collectingCtx } from './pick-helpers.mjs';

export const PROOF = 'shoot/毛片/';
export const FINAL = 'shoot/精修/';
export const FINAL2 = 'shoot/精修二/';
export const PA = 'shoot/毛片/a.jpg';
export const PB = 'shoot/毛片/b.jpg';
export const F1 = 'shoot/精修/f1.jpg';
export const F2 = 'shoot/精修/f2.jpg';
export const F3 = 'shoot/精修/f3.jpg';
export const G1 = 'shoot/精修二/g1.jpg';

export const OBJECTS = {
  [PA]: 'PA-ORIG', [`_thumbs/400/${PA}.thumb`]: 'PA-T400', [`_thumbs/1200/${PA}.thumb`]: 'PA-T1200',
  [PB]: 'PB-ORIG', [`_thumbs/400/${PB}.thumb`]: 'PB-T400',
  [F1]: 'F1-ORIG', [`_thumbs/400/${F1}.thumb`]: 'F1-T400', [`_thumbs/1200/${F1}.thumb`]: 'F1-T1200',
  [`_thumbs/1600/${F1}.thumb`]: 'F1-T1600',
  [F2]: 'F2-ORIG', // no thumbnail at all (an old upload, or aged out)
  [F3]: 'F3-ORIG', [`_thumbs/400/${F3}.thumb`]: 'F3-T400',
  [G1]: 'G1-ORIG', [`_thumbs/400/${G1}.thumb`]: 'G1-T400',
  '_books/b1.json': JSON.stringify({ name: 'x', notifyUrl: 'https://secret' }),
  [`_thumbs/400/_books/b1.json.thumb`]: 'BOOK-THUMB',
  'other/x.jpg': 'OTHER-ORIG', [`_thumbs/400/other/x.jpg.thumb`]: 'OTHER-T400',
};

export const FRESH = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const MIGRATION_FILE = new URL('../migrations/2026-10-07-revision-pins.sql', import.meta.url);
export const MIGRATION = existsSync(MIGRATION_FILE) ? readFileSync(MIGRATION_FILE, 'utf8') : '';

// strict once schema.sql has the table (before that, while the tests are
// still red, every state is just FRESH)
const HAS_PINS = /CREATE TABLE IF NOT EXISTS revision_pins/.test(FRESH);
const cut = (s, re, to) => {
  if (!HAS_PINS) return s;
  const out = s.replace(re, to);
  if (out === s) throw new Error(`revision-helpers: ${re} matched nothing in schema.sql`);
  return out;
};
// the deployed database today: client-confirm ran, this migration has not —
// revision_requests without the three columns, no revision_pins table
export const BEFORE = cut(
  cut(FRESH, /(resolved_at\s+TEXT),[^\n]*\n(?:\s*--[^\n]*\n)*\s*marks\s+TEXT,[^\n]*\n(?:\s*--[^\n]*\n)*\s*finals\s+TEXT,[^\n]*\n(?:\s*--[^\n]*\n)*\s*message_auto\s+INTEGER NOT NULL DEFAULT 0[^\n]*\n\);/, '$1\n);'),
  /\n-- ─── Revision pins[\s\S]*$/, '\n');
// the three ALTERs ran, the CREATE TABLE not yet (one statement at a time)
export const HALF = cut(FRESH, /\n-- ─── Revision pins[\s\S]*$/, '\n');
// only the CREATE TABLE ran
export const TABLE_ONLY = cut(FRESH, /(resolved_at\s+TEXT),[^\n]*\n(?:\s*--[^\n]*\n)*\s*marks\s+TEXT,[^\n]*\n(?:\s*--[^\n]*\n)*\s*finals\s+TEXT,[^\n]*\n(?:\s*--[^\n]*\n)*\s*message_auto\s+INTEGER NOT NULL DEFAULT 0[^\n]*\n\);/, '$1\n);');

export function fakeMailer({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    async send(msg) {
      if (fail) throw new Error('smtp down');
      sent.push(msg);
      return { messageId: 'm1' };
    },
  };
}

export function setup({ schema, mailer = fakeMailer(), objects = OBJECTS, extra = {} } = {}) {
  return {
    imagepicker: fakeBucket(objects), DB: fakeDB(schema ? { schema } : {}), PHOTOGRAPHER_TOKEN: SECRET,
    NOTIFY_EMAIL: mailer, PHOTOGRAPHER_EMAIL: 'studio@example.com', NOTIFY_FROM: 'notify@imhoti.tw', ...extra,
  };
}

export const admin = (env, id, action, body, token = SECRET) =>
  call(env, `/api/admin/projects/${id}/${action}`, { method: 'POST', token, body });
export const deliver = (env, id, finals = [FINAL]) => admin(env, id, 'deliver', { final_folders: finals });
export const detail = async (env, id) => (await call(env, `/api/admin/projects/${id}`, { token: SECRET })).json();
export const code = async res => (await res.clone().json()).code;
export async function state(env, t, key) {
  const res = await pick(env, 'GET', 'state', t, { key });
  assert.equal(res.status, 200);
  return res.json();
}

// a guest write, waiting for the background email
export async function guest(env, method, route, t, key, body) {
  const c = collectingCtx();
  const res = await pick(env, method, route, t, { key, body }, c);
  await c.settle();
  return res;
}
export const putPins = (env, t, key, items) => guest(env, 'PUT', 'revision-pins', t, key, { items });
export const submitRound = (env, t, key, body) => guest(env, 'POST', 'revision-round', t, key, body);
export const confirm = (env, t, key) => guest(env, 'POST', 'confirm', t, key, {});
export const reviseText = (env, t, key, message) => guest(env, 'POST', 'revision', t, key, { message });
export const rounds = (env, t, key) => pick(env, 'GET', 'rounds', t, { key });
export const round = (env, t, key, id) => pick(env, 'GET', `rounds/${id}`, t, { key });
export const photo = (env, t, key, id, query, method = 'GET') =>
  pick(env, method, `rounds/${id}/photo${query === undefined ? '' : `?${query}`}`, t, { key });

export const pin = (x = 0.5, y = 0.5, note = '') => ({ x, y, note });

async function createProject(env, body = {}) {
  const res = await call(env, '/api/admin/projects', {
    method: 'POST', token: SECRET, body: { title: '王先生 婚紗', folders: [PROOF], pick_limit: 40, extra_price: 200, ...body },
  });
  assert.equal(res.status, 201);
  return res.json();
}

// claimed, picked (PA with two pins, PB plain), submitted, retouching
export async function retouching(env, body) {
  const created = await createProject(env, body);
  const c = await claim(env, created.token);
  const p = { ...created, key: c.key, id: created.project.id, pickerId: c.json.picker_id };
  const saved = await save(env, p.token, p.key, {
    upsert: [{ photo_key: PA, rating: 1, marks: [pin(0.1, 0.2, '臉'), pin(0.3, 0.4)] }, { photo_key: PB, rating: 1 }],
  });
  assert.equal(saved.status, 200);
  assert.equal((await guest(env, 'POST', 'submit', p.token, p.key, { relationship: '本人' })).status, 200);
  assert.equal((await admin(env, p.id, 'start-retouch')).status, 200);
  return p;
}

export async function delivered(env, finals = [FINAL], body) {
  const p = await retouching(env, body);
  const res = await deliver(env, p.id, finals);
  assert.equal(res.status, 200, await res.clone().text());
  if (env.NOTIFY_EMAIL?.sent) env.NOTIFY_EMAIL.sent.length = 0; // the submit's own email
  return p;
}

// a delivered project with one submitted pins round on F1 (two pins) and F3
export async function withRound(env, finals = [FINAL]) {
  const p = await delivered(env, finals);
  assert.equal((await putPins(env, p.token, p.key, [
    { photo_key: F1, marks: [pin(0.1, 0.1, '去掉路人'), pin(0.9, 0.9)] },
    { photo_key: F3, marks: [pin(0.5, 0.5, '亮一點')] },
  ])).status, 200);
  const res = await submitRound(env, p.token, p.key, { note: '整體再亮一點', expect: [{ k: F1, n: 2 }, { k: F3, n: 1 }] });
  assert.equal(res.status, 200, await res.clone().text());
  const out = await res.json();
  return { ...p, roundId: out.id };
}

export const draftRows = env => rows(env, 'SELECT * FROM revision_pins ORDER BY photo_key');
export const roundRows = env => rows(env, 'SELECT * FROM revision_requests ORDER BY rowid');
export const projectRow = env => ({ ...one(env, 'SELECT * FROM projects') });
export const dbSnapshot = env => JSON.stringify([
  rows(env, 'SELECT * FROM projects'), rows(env, 'SELECT * FROM revision_requests'),
  (() => { try { return rows(env, 'SELECT * FROM revision_pins'); } catch { return null; } })(),
]);

// runs `sql` once, right before the first statement matching `re` is prepared
export function landOnce(env, re, sql, ...args) {
  const prepare = env.DB.prepare.bind(env.DB);
  let done = false;
  env.DB.prepare = s => {
    if (!done && re.test(s)) { done = true; env.DB._db.prepare(sql).run(...args); }
    return prepare(s);
  };
}

export { SECRET, call, pick, claim, save, one, rows };
