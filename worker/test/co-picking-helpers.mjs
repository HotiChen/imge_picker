// Shared fixtures for the co-picking tests (co-picking-*.test.mjs,
// docs/co-picking.md). Not a test file itself.
import { readFileSync } from 'node:fs';
import { fakeDB } from './fakes.mjs';
import { setup, pick, claimed, save, one, rows } from './pick-helpers.mjs';

export const MIGRATION = readFileSync(new URL('../migrations/2026-10-13-co-picking.sql', import.meta.url), 'utf8');
export const CO_TABLES = ['pick_invites', 'project_collaborators', 'pick_join_failures'];

// a database as deployed before the co-picking migration
export function beforeMigration(extra = {}) {
  const env = setup(extra);
  for (const t of CO_TABLES) env.DB._db.exec(`DROP TABLE ${t}`);
  return env;
}

export const iso = ms => new Date(ms).toISOString();
export const ago = ms => iso(Date.now() - ms);
export const later = ms => iso(Date.now() + ms);
export const HOUR = 3600000;
export const DAY = 86400000;

export async function invite(env, t, key, body = { window_days: 7 }) {
  const res = await pick(env, 'POST', 'invites', t, { key, body });
  return { res, json: await res.json() };
}

export async function join(env, t, code, name = 'Bob', { ip = '203.0.113.7', key } = {}) {
  const res = await pick(env, 'POST', 'join', t, { key, body: { code, name }, headers: { 'CF-Connecting-IP': ip } });
  return { res, json: await res.json() };
}

// invites and joins one collaborator; returns {key, pickerId, json}
export async function addCollaborator(env, p, name = 'Bob', windowDays = 7, ip) {
  const inv = await invite(env, p.token, p.key, { window_days: windowDays });
  if (inv.res.status !== 200) throw new Error(`invite: ${inv.res.status} ${JSON.stringify(inv.json)}`);
  const j = await join(env, p.token, inv.json.code, name, { ip });
  if (j.res.status !== 200) throw new Error(`join: ${j.res.status} ${JSON.stringify(j.json)}`);
  return { key: j.json.picker_key, pickerId: j.json.picker_id, json: j.json };
}

// a claimed project (owner 王小明) with one active collaborator Bob
export async function withCollaborator(env, project = {}, windowDays = 7) {
  const p = await claimed(env, project);
  const c = await addCollaborator(env, p, 'Bob', windowDays);
  return { p, c };
}

export const state = async (env, t, key) => (await pick(env, 'GET', 'state', t, { key })).json();
export const list = async (env, t, key) => pick(env, 'GET', 'collaborators', t, { key });
export const patchC = (env, t, key, id, body) => pick(env, 'PATCH', `collaborators/${id}`, t, { key, body });
export const removeC = (env, t, key, id) => pick(env, 'DELETE', `collaborators/${id}`, t, { key });
export const renewal = (env, t, key) => pick(env, 'POST', 'renewal', t, { key, body: {} });
export const decide = (env, t, key, id, body) => pick(env, 'POST', `collaborators/${id}/decision`, t, { key, body });

export const expire = (env, pickerId, when = ago(1000)) =>
  env.DB._db.prepare('UPDATE project_collaborators SET expires_at = ? WHERE picker_id = ?').run(when, pickerId);
export const member = (env, pickerId) => one(env, 'SELECT * FROM project_collaborators WHERE picker_id = ?', pickerId);
export const sel = (env, projectId, key) => one(env, 'SELECT * FROM selections WHERE project_id = ? AND photo_key = ?', projectId, key);

// Runs `fn` (a direct DB write) right before the first statement whose SQL
// matches `pattern` runs — a write by someone else landing between a route's
// checks and its conditional statement.
export function raceBeforeStatement(env, pattern, fn) {
  const real = env.DB.prepare.bind(env.DB);
  let armed = true;
  const fire = () => { if (armed) { armed = false; fn(); } };
  env.DB.prepare = sql => {
    const stmt = real(sql);
    if (!pattern.test(sql)) return stmt;
    const wrap = r => ({
      ...r,
      async run() { fire(); return r.run(); },
      async first() { fire(); return r.first(); },
      async all() { fire(); return r.all(); },
    });
    return { ...wrap(stmt), bind: (...a) => wrap(stmt.bind(...a)) };
  };
}

export { setup, pick, claimed, save, one, rows, fakeDB };
