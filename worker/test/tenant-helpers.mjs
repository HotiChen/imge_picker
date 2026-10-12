// Two-photographer fixtures (docs/multi-photographer.md, batch 2b). Not a test
// file itself. Batches 2b-1..3 reuse these to prove that photographer B can
// neither read nor change photographer A's data.
//
// A is always the default photographer: PHOTOGRAPHER_TOKEN, id 'default'.
// B is a real account: a photographers row and a live photographer_sessions
// row (the SHA-256 of a random token, as login stores it). Login itself is not
// exercised here (photographer-accounts.test.mjs does that), so a fixture
// costs no PBKDF2.
import { webcrypto } from 'node:crypto';
import { SECRET, sha256Hex } from './pick-helpers.mjs';

// a well-formed stored hash whose password nobody knows (never logged in with)
export const UNUSED_HASH = 'pbkdf2$100000$00112233445566778899aabbccddeeff$' + '0'.repeat(64);

const hex = n => [...webcrypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');

// The kill switch for photographer sessions (photographerRoutesOpen): only
// the exact string 'on' opens; anything else, unset included, is off.
export const ROUTES_ON = { PHOTOGRAPHER_ROUTES: 'on' };

// A photographers row plus one live session; returns {id, email, token}.
// mustChange: undefined leaves the column to its default (and works on a
// database without it), true / false / a number writes it.
export async function seedPhotographer(env, { id = hex(8), email, status = 'active', mustChange, displayName = '乙攝影', expiresInMs = 86400000 } = {}) {
  const now = new Date().toISOString();
  const mail = email ?? `${id}@example.com`;
  const cols = ['id', 'email', 'password_hash', 'display_name', 'status', 'created_at', 'approved_at'];
  const vals = [id, mail, UNUSED_HASH, displayName, status, now, status === 'pending' ? null : now];
  if (mustChange !== undefined) { cols.push('must_change_password'); vals.push(mustChange === true ? 1 : mustChange === false ? 0 : mustChange); }
  env.DB._db.prepare(`INSERT INTO photographers (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
  const token = hex(32);
  env.DB._db.prepare('INSERT INTO photographer_sessions (token_hash, photographer_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(await sha256Hex(token), id, now, new Date(Date.now() + expiresInMs).toISOString());
  return { id, email: mail, token };
}

// {A: the default photographer, B: a second, active account with a session}
export async function twoTenants(env, b = {}) {
  return { A: { id: 'default', token: SECRET }, B: await seedPhotographer(env, b) };
}

// Every row of every table, and every R2 object, as one string: equal before
// and after a request means the request wrote nothing anywhere.
export function snapshot(env) {
  const db = env.DB._db;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map(r => r.name);
  const data = {};
  for (const t of tables) data[t] = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all();
  const r2 = env.imagepicker ? [...env.imagepicker._store.entries()].map(([k, v]) => [k, String(v.body), v.contentType]) : [];
  return JSON.stringify({ data, r2 }, (k, v) => (v instanceof Uint8Array ? Array.from(v) : typeof v === 'bigint' ? String(v) : v));
}
