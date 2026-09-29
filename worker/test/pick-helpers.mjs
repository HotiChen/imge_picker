// Shared fixtures for the guest-picking tests (pick-*.test.mjs). Not a test
// file itself: the runner globs *.test.mjs, so this is only ever imported.
//
// One link per shoot. The first person to POST a name to /api/pick/claim
// takes the seat and gets a picker key; everyone else holding the same link
// only looks. See docs/guest-picking.md.
import { webcrypto } from 'node:crypto';
import worker from '../worker.js';
import { fakeBucket, fakeDB, ctx, req } from './fakes.mjs';

export const SECRET = 'photographer-secret';
export const MINE = '20260819/';
export const THEIRS = '20260901/';

export const OBJECTS = {
  '_books/b1.json': JSON.stringify({ name: '王先生 婚紗', clientFolders: [MINE], pages: [] }),
  '20260819/a.jpg': 'MINE-A',
  '20260819/b.jpg': 'MINE-B',
  '20260819/c.jpg': 'MINE-C',
  '20260819/sub/d.jpg': 'MINE-SUB-D',
  '_thumbs/400/20260819/a.jpg.thumb': 'MINE-A-THUMB',
  '20260819-other/secret.jpg': 'NEIGHBOUR',
  '20260901/x.jpg': 'THEIRS-X',
};

export const days = n => new Date(Date.now() + n * 86400000).toISOString();

// CUSTOM_PRODUCTS is off unless the env says "on"; a test that makes the
// photographer's own (non-platform) products passes this to setup().
export const CUSTOM_ON = { CUSTOM_PRODUCTS: 'on' };

export function setup(extra = {}) {
  return { imagepicker: fakeBucket(OBJECTS), DB: fakeDB(), PHOTOGRAPHER_TOKEN: SECRET, ...extra };
}

// ctx.waitUntil that remembers what it was handed, so a test can wait for the
// notification the submit route sends in the background
export function collectingCtx() {
  const pending = [];
  return { waitUntil(p) { pending.push(p); }, settle: () => Promise.allSettled(pending), pending };
}

export const withT = (path, t) =>
  t === undefined ? path : `${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(t)}`;

export function call(env, path, opts = {}, c = ctx) {
  const headers = { ...(opts.headers || {}) };
  if (opts.key != null) headers['X-Picker-Key'] = opts.key; // null = no header
  let body = opts.body;
  if (body !== undefined && typeof body !== 'string') {
    body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  return worker.fetch(req(path, { method: opts.method, headers, body, token: opts.token }), env, c);
}

// A pick route, carrying the link token the way the page does (`?t=`)
export const pick = (env, method, route, t, { key, body, headers } = {}, c) =>
  call(env, withT(`/api/pick/${route}`, t), { method, key, body, headers }, c);

export async function createProject(env, body = {}) {
  const res = await call(env, '/api/admin/projects', {
    method: 'POST', token: SECRET,
    body: { title: '王先生 婚紗', folders: [MINE], pick_limit: 40, extra_price: 200, ...body },
  });
  if (res.status !== 201) throw new Error(`createProject: ${res.status} ${await res.text()}`);
  return res.json();
}

export async function claim(env, t, name = '王小明') {
  const res = await pick(env, 'POST', 'claim', t, { body: { name } });
  const json = await res.json();
  return { res, json, key: json.picker_key };
}

// a project with its seat taken, ready for saves and submits
export async function claimed(env, project = {}, name) {
  const created = await createProject(env, project);
  const c = await claim(env, created.token, name);
  if (c.res.status !== 200) throw new Error(`claim: ${c.res.status}`);
  return { ...created, key: c.key, pickerId: c.json.picker_id };
}

export const save = (env, t, key, body) => pick(env, 'PUT', 'selections', t, { key, body });

export async function sha256Hex(text) {
  const buf = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const rows = (env, sql, ...args) => env.DB._db.prepare(sql).all(...args);
export const one = (env, sql, ...args) => env.DB._db.prepare(sql).get(...args);

// Seeds a share_tokens row directly, for kinds and states the routes would
// never produce (a pick row whose snapshot names `_books/`, an expired one).
export async function seedToken(env, t) {
  const row = {
    book_id: '', label: '', kind: 'pick', project_id: null, folders: [MINE],
    created_at: days(-1), expires_at: days(89), revoked_at: null, user_id: null, ...t,
  };
  env.DB._db.prepare(
    'INSERT INTO share_tokens (token, book_id, label, kind, project_id, folders, created_at, expires_at, revoked_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(row.token, row.book_id, row.label, row.kind, row.project_id, JSON.stringify(row.folders),
    row.created_at, row.expires_at, row.revoked_at, row.user_id);
  return row.token;
}
