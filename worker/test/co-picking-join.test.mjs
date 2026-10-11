// Co-picking: invites and joining with a code (docs/co-picking.md, API).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { SECRET, INVITE_SECRET, call, createProject, claim, sha256Hex } from './pick-helpers.mjs';
import {
  setup, pick, claimed, one, rows, invite, join, addCollaborator, withCollaborator, state, member,
  ago, later, HOUR, DAY, beforeMigration, raceBeforeStatement,
} from './co-picking-helpers.mjs';

async function hmacHex(secret, message) {
  const key = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await webcrypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── POST /api/pick/invites ────────────────────────────────────────────────

test('invite: the owner gets an 8-digit code valid one hour, shown once, stored only as an HMAC bound to the project', async () => {
  const env = setup();
  const p = await claimed(env);
  const before = Date.now();
  const { res, json } = await invite(env, p.token, p.key, { window_days: 7 });
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(json).sort(), ['code', 'expires_at', 'window_days']);
  assert.match(json.code, /^\d{8}$/);
  assert.equal(json.window_days, 7);
  const exp = Date.parse(json.expires_at);
  assert.ok(exp >= before + HOUR - 1000 && exp <= Date.now() + HOUR + 1000, 'one hour');
  const row = one(env, 'SELECT * FROM pick_invites');
  assert.equal(row.project_id, p.project.id);
  assert.equal(row.invited_by, p.pickerId);
  assert.equal(row.window_days, 7);
  assert.equal(row.used_at, null);
  assert.equal(row.code_hash, await hmacHex(INVITE_SECRET, `${p.project.id}:${json.code}`));
  assert.notEqual(row.code_hash, await hmacHex(SECRET, `${p.project.id}:${json.code}`), 'not keyed with PHOTOGRAPHER_TOKEN');
  // the code is in no column of any table
  const dump = JSON.stringify(rows(env, 'SELECT * FROM pick_invites'));
  assert.ok(!dump.includes(json.code), 'the code is never stored');
  // nor in what the owner can list afterwards
  const listed = await (await pick(env, 'GET', 'collaborators', p.token, { key: p.key })).text();
  assert.ok(!listed.includes(json.code));
  assert.ok(!listed.includes(row.code_hash));
});

test('invite: window_days 1, 7 and null are the only periods', async () => {
  const env = setup();
  const p = await claimed(env);
  for (const bad of [0, 2, 30, '7', -1, 1.5, true, undefined, 'null']) {
    const { res, json } = await invite(env, p.token, p.key, bad === undefined ? {} : { window_days: bad });
    assert.equal(res.status, 400, `window_days ${JSON.stringify(bad)}`);
    assert.equal(json.code, 'invalid_window');
  }
  for (const body of [null, [], 'x']) {
    assert.equal((await invite(env, p.token, p.key, body)).res.status, 400);
  }
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM pick_invites').n, 0);
  assert.equal((await invite(env, p.token, p.key, { window_days: null })).json.window_days, null);
  assert.equal((await invite(env, p.token, p.key, { window_days: 1 })).json.window_days, 1);
});

test('invite: only the owner — a viewer, no key, a collaborator, a key from another project get 403 not_owner', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  const other = await claimed(env, { title: 'B' });
  for (const key of [undefined, 'nonsense', c.key, other.key]) {
    const { res, json } = await invite(env, p.token, key);
    assert.equal(res.status, 403, String(key));
    assert.equal(json.code, 'not_owner');
  }
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM pick_invites WHERE used_at IS NULL').n, 0);
});

test('invite: refused 409 collaborator_limit once active collaborators + unspent unexpired invites come to 2', async () => {
  const env = setup();
  const p = await claimed(env);
  assert.equal((await invite(env, p.token, p.key)).res.status, 200);
  assert.equal((await invite(env, p.token, p.key)).res.status, 200);
  const third = await invite(env, p.token, p.key);
  assert.equal(third.res.status, 409);
  assert.equal(third.json.code, 'collaborator_limit');
  // an expired unspent invite frees its slot
  env.DB._db.prepare('UPDATE pick_invites SET expires_at = ? WHERE rowid = (SELECT MIN(rowid) FROM pick_invites)').run(ago(1));
  assert.equal((await invite(env, p.token, p.key)).res.status, 200);
  assert.equal((await invite(env, p.token, p.key)).res.status, 409);
});

test('invite: a spent invite becomes an active collaborator and still counts; expired and removed collaborators free their slot', async () => {
  const env = setup();
  const p = await claimed(env);
  const a = await addCollaborator(env, p, 'A');
  const b = await addCollaborator(env, p, 'B');
  assert.equal((await invite(env, p.token, p.key)).json.code, 'collaborator_limit');
  // A expires
  env.DB._db.prepare('UPDATE project_collaborators SET expires_at = ? WHERE picker_id = ?').run(ago(1), a.pickerId);
  const inv = await invite(env, p.token, p.key);
  assert.equal(inv.res.status, 200);
  assert.equal((await invite(env, p.token, p.key)).json.code, 'collaborator_limit');
  // B removed: one more slot
  assert.equal((await pick(env, 'DELETE', `collaborators/${b.pickerId}`, p.token, { key: p.key })).status, 200);
  assert.equal((await invite(env, p.token, p.key)).res.status, 200);
  assert.equal((await invite(env, p.token, p.key)).json.code, 'collaborator_limit');
});

test('invite: parallel invites never pass the limit (the count is inside the write)', async () => {
  const env = setup();
  const p = await claimed(env);
  const results = await Promise.all(Array.from({ length: 6 }, () => invite(env, p.token, p.key)));
  assert.equal(results.filter(r => r.res.status === 200).length, 2);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM pick_invites').n, 2);
});

test('invite: refused 409 retouching once the phase is closed; 401 once archived; the slot count ignores a previous owner\'s invites', async () => {
  const env = setup();
  const p = await claimed(env);
  await invite(env, p.token, p.key);
  await invite(env, p.token, p.key);
  // reset the seat: the new owner starts with two free slots
  await call(env, `/api/admin/projects/${p.project.id}/reset-seat`, { method: 'POST', token: SECRET });
  const owner2 = await claim(env, p.token, '新主人');
  assert.equal((await invite(env, p.token, owner2.key)).res.status, 200);
  assert.equal((await invite(env, p.token, owner2.key)).res.status, 200);
  env.DB._db.prepare("UPDATE projects SET phase = 'retouching' WHERE id = ?").run(p.project.id);
  const closed = await invite(env, p.token, owner2.key);
  assert.equal(closed.res.status, 409);
  assert.equal(closed.json.code, 'retouching');
  env.DB._db.prepare("UPDATE projects SET phase = 'submitted', archived_at = ? WHERE id = ?").run(ago(1), p.project.id);
  assert.equal((await invite(env, p.token, owner2.key)).res.status, 401);
});

test('invite: the code is random — many invites, no repeats, every one 8 digits', async () => {
  const env = setup();
  const p = await claimed(env);
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const { json } = await invite(env, p.token, p.key);
    assert.match(json.code, /^\d{8}$/);
    seen.add(json.code);
    env.DB._db.prepare('DELETE FROM pick_invites').run();
  }
  assert.ok(seen.size >= 39);
});

// ─── POST /api/pick/join ───────────────────────────────────────────────────

test('join: a viewer with the code and a name becomes a collaborator; the key is returned once and stored only as its hash', async () => {
  const env = setup();
  const p = await claimed(env);
  const inv = await invite(env, p.token, p.key, { window_days: 7 });
  const before = Date.now();
  const { res, json } = await join(env, p.token, inv.json.code, '  Bob  ');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(json).sort(), ['expires_at', 'name', 'picker_id', 'picker_key', 'role']);
  assert.equal(json.role, 'collaborator');
  assert.equal(json.name, 'Bob');
  const exp = Date.parse(json.expires_at);
  assert.ok(exp >= before + 7 * DAY - 2000 && exp <= Date.now() + 7 * DAY + 2000, 'now + 7 days');
  const picker = one(env, 'SELECT * FROM pickers WHERE id = ?', json.picker_id);
  assert.equal(picker.project_id, p.project.id);
  assert.equal(picker.name, 'Bob');
  assert.equal(picker.key_hash, await sha256Hex(json.picker_key));
  assert.ok(!JSON.stringify(rows(env, 'SELECT * FROM pickers')).includes(json.picker_key));
  const m = member(env, json.picker_id);
  assert.equal(m.project_id, p.project.id);
  assert.equal(m.invited_by, p.pickerId);
  assert.equal(m.expires_at, json.expires_at);
  assert.equal(m.revoked_at, null);
  const inviteRow = one(env, 'SELECT * FROM pick_invites');
  assert.ok(inviteRow.used_at);
  assert.equal(inviteRow.used_by, json.picker_id);
  // the seat is untouched
  assert.equal(one(env, 'SELECT owner_picker_id FROM projects WHERE id = ?', p.project.id).owner_picker_id, p.pickerId);
});

test('join: window 1 day, and null stays null (until the project ends)', async () => {
  const env = setup();
  const p = await claimed(env);
  const one1 = await addCollaborator(env, p, 'A', 1);
  const exp = Date.parse(one1.json.expires_at);
  assert.ok(Math.abs(exp - (Date.now() + DAY)) < 5000);
  const forever = await addCollaborator(env, p, 'B', null);
  assert.equal(forever.json.expires_at, null);
  assert.equal(member(env, forever.pickerId).expires_at, null);
});

test('join: a code works once — the second person gets invalid_code', async () => {
  const env = setup();
  const p = await claimed(env);
  const inv = await invite(env, p.token, p.key);
  assert.equal((await join(env, p.token, inv.json.code, 'A')).res.status, 200);
  const again = await join(env, p.token, inv.json.code, 'B', { ip: '198.51.100.1' });
  assert.equal(again.res.status, 400);
  assert.equal(again.json.code, 'invalid_code');
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM project_collaborators').n, 1);
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM pickers WHERE name = 'B'").n, 0);
});

test('join: parallel joins of one code — exactly one wins, nothing is left behind for the losers', async () => {
  const env = setup();
  const p = await claimed(env);
  const inv = await invite(env, p.token, p.key);
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) =>
    join(env, p.token, inv.json.code, `P${i}`, { ip: `198.51.100.${i + 1}` })));
  assert.equal(results.filter(r => r.res.status === 200).length, 1);
  for (const r of results.filter(r => r.res.status !== 200)) assert.equal(r.json.code, 'invalid_code');
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM project_collaborators').n, 1);
  // only the owner and the winner hold picker rows
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM pickers WHERE project_id = ?', p.project.id).n, 2);
  // each loser counts as a failure; the winner's reservation is released
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM pick_join_failures WHERE bucket = 'p'").n, 4);
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM pick_join_failures WHERE bucket LIKE 'n:%'").n, 4);
});

test('invite race: the seat is reset between the check and the write — no invite lands (403)', async () => {
  const env = setup();
  const p = await claimed(env);
  raceBeforeStatement(env, /^INSERT INTO pick_invites/, () => env.DB._db.prepare('UPDATE projects SET owner_picker_id = NULL').run());
  const r = await invite(env, p.token, p.key);
  assert.equal(r.res.status, 403);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM pick_invites').n, 0);
});

test('join race: the phase closes between the check and the batch — nothing lands (409 retouching)', async () => {
  const env = setup();
  const p = await claimed(env);
  const inv = await invite(env, p.token, p.key);
  raceBeforeStatement(env, /^SELECT i\.id, i\.window_days/, () => env.DB._db.prepare("UPDATE projects SET phase = 'retouching'").run());
  const r = await join(env, p.token, inv.json.code);
  assert.equal(r.res.status, 409);
  assert.equal(one(env, 'SELECT used_at FROM pick_invites').used_at, null);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM project_collaborators').n, 0);
});

test('join: wrong, expired and used codes all answer the same 400 invalid_code (no oracle), each recorded as a failure', async () => {
  const env = setup();
  const p = await claimed(env);
  const used = await invite(env, p.token, p.key);
  await join(env, p.token, used.json.code, 'A');
  const old = await invite(env, p.token, p.key);
  env.DB._db.prepare('UPDATE pick_invites SET expires_at = ? WHERE used_at IS NULL').run(ago(1));
  const bodies = [];
  for (const code of [used.json.code, old.json.code, '00000000', '1234567', 'abcdefgh', 12345678, '', null]) {
    const r = await join(env, p.token, code, 'X', { ip: `192.0.2.${bodies.length + 1}` });
    assert.equal(r.res.status, 400, JSON.stringify(code));
    bodies.push(JSON.stringify(r.json));
  }
  assert.equal(new Set(bodies).size, 1, 'one answer for all');
  assert.equal(JSON.parse(bodies[0]).code, 'invalid_code');
  assert.equal(one(env, "SELECT COUNT(*) AS n FROM pick_join_failures WHERE bucket = 'p'").n, bodies.length);
});

test('join: an invite exactly at its expiry no longer works (expires_at > now)', async () => {
  const env = setup();
  const p = await claimed(env);
  const inv = await invite(env, p.token, p.key);
  env.DB._db.prepare('UPDATE pick_invites SET expires_at = ?').run(new Date(Date.now() - 1).toISOString());
  assert.equal((await join(env, p.token, inv.json.code)).json.code, 'invalid_code');
  // and one still inside its hour works
  const inv2 = await invite(env, p.token, p.key);
  env.DB._db.prepare('UPDATE pick_invites SET expires_at = ? WHERE used_at IS NULL AND expires_at > ?').run(later(60000), new Date().toISOString());
  assert.equal((await join(env, p.token, inv2.json.code, 'B', { ip: '192.0.2.99' })).res.status, 200);
});

test('join: the name follows the claim rule (1–50 characters, trimmed) and a bad name spends nothing', async () => {
  const env = setup();
  const p = await claimed(env);
  const inv = await invite(env, p.token, p.key);
  for (const name of ['', '   ', 'x'.repeat(51), 5, null, undefined]) {
    const r = await pick(env, 'POST', 'join', p.token, { body: { code: inv.json.code, name } });
    assert.equal(r.status, 400, JSON.stringify(name));
    assert.equal((await r.json()).code, 'invalid_name');
  }
  assert.equal(one(env, 'SELECT used_at FROM pick_invites').used_at, null);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM pick_join_failures').n, 0);
  assert.equal((await pick(env, 'POST', 'join', p.token, { body: '{' })).status, 400);
  assert.equal((await pick(env, 'POST', 'join', p.token, { body: [] })).status, 400);
  assert.equal((await join(env, p.token, inv.json.code, 'y'.repeat(50))).res.status, 200);
});

test('join: a code from project A does nothing on project B\'s link (the HMAC is bound to the project)', async () => {
  const env = setup();
  const a = await claimed(env, { title: 'A' });
  const b = await claimed(env, { title: 'B' });
  const inv = await invite(env, a.token, a.key);
  const r = await join(env, b.token, inv.json.code);
  assert.equal(r.res.status, 400);
  assert.equal(r.json.code, 'invalid_code');
  assert.equal(one(env, 'SELECT used_at FROM pick_invites').used_at, null);
  // the same code value stored for B's project would hash differently
  assert.notEqual(await hmacHex(INVITE_SECRET, `${a.project.id}:${inv.json.code}`), await hmacHex(INVITE_SECRET, `${b.project.id}:${inv.json.code}`));
  // still good on A
  assert.equal((await join(env, a.token, inv.json.code)).res.status, 200);
});

test('join: 409 owner_missing with no owner; 409 retouching when not open; 401 when archived — and none of them spends the code', async () => {
  const env = setup();
  const empty = await createProject(env);
  const r0 = await join(env, empty.token, '12345678');
  assert.equal(r0.res.status, 409);
  assert.equal(r0.json.code, 'owner_missing');
  const p = await claimed(env, { title: 'B' });
  const inv = await invite(env, p.token, p.key);
  env.DB._db.prepare("UPDATE projects SET phase = 'retouching' WHERE id = ?").run(p.project.id);
  const r1 = await join(env, p.token, inv.json.code);
  assert.equal(r1.res.status, 409);
  assert.equal(r1.json.code, 'retouching');
  env.DB._db.prepare("UPDATE projects SET phase = 'picking', archived_at = ? WHERE id = ?").run(ago(1), p.project.id);
  assert.equal((await join(env, p.token, inv.json.code)).res.status, 401);
  assert.equal(one(env, 'SELECT used_at FROM pick_invites').used_at, null);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM pick_join_failures').n, 0);
});

test('join: an invite made by a previous owner is dead after reset-seat', async () => {
  const env = setup();
  const p = await claimed(env);
  const inv = await invite(env, p.token, p.key);
  await call(env, `/api/admin/projects/${p.project.id}/reset-seat`, { method: 'POST', token: SECRET });
  await claim(env, p.token, '新主人');
  const r = await join(env, p.token, inv.json.code);
  assert.equal(r.json.code, 'invalid_code');
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM project_collaborators').n, 0);
});

test('join: only POST; the other new routes have their own methods', async () => {
  const env = setup();
  const p = await claimed(env);
  assert.equal((await pick(env, 'GET', 'join', p.token)).status, 405);
  assert.equal((await pick(env, 'GET', 'invites', p.token, { key: p.key })).status, 405);
  assert.equal((await pick(env, 'GET', 'renewal', p.token, { key: p.key })).status, 405);
  assert.equal((await pick(env, 'POST', 'collaborators', p.token, { key: p.key, body: {} })).status, 405);
  assert.equal((await pick(env, 'GET', 'collaborators/x/decision', p.token, { key: p.key })).status, 405);
  assert.equal((await pick(env, 'GET', 'collaborators/x/y', p.token, { key: p.key })).status, 404);
});

// ─── Rate limits ───────────────────────────────────────────────────────────

test('join limit: 5 failures from one network in 15 minutes → 429 too_many_attempts before the code is looked at', async () => {
  const env = setup();
  const p = await claimed(env);
  const inv = await invite(env, p.token, p.key);
  for (let i = 0; i < 5; i++) assert.equal((await join(env, p.token, '00000000', 'X', { ip: '203.0.113.9' })).res.status, 400);
  const locked = await join(env, p.token, inv.json.code, 'X', { ip: '203.0.113.9' });
  assert.equal(locked.res.status, 429);
  assert.equal(locked.json.code, 'too_many_attempts');
  assert.equal(one(env, 'SELECT used_at FROM pick_invites').used_at, null, 'the right code was not even tried');
  // another network still gets through
  assert.equal((await join(env, p.token, inv.json.code, 'X', { ip: '198.51.100.20' })).res.status, 200);
  // the same /64 is the same network
  const q = await claimed(env, { title: 'Q' });
  const invQ = await invite(env, q.token, q.key);
  for (const ip of ['2001:db8:1:2::1', '2001:db8:1:2::2', '2001:db8:1:2:aaaa::3', '2001:db8:1:2::4', '2001:db8:1:2::5']) {
    assert.equal((await join(env, q.token, '00000000', 'X', { ip })).res.status, 400);
  }
  assert.equal((await join(env, q.token, invQ.json.code, 'X', { ip: '2001:db8:1:2:ffff::9' })).res.status, 429);
  assert.equal((await join(env, q.token, invQ.json.code, 'X', { ip: '2001:db8:1:3::9' })).res.status, 200);
});

test('join limit: 30 failures per project in 15 minutes (distributed guessing) → 429 for every network', async () => {
  const env = setup();
  const p = await claimed(env);
  const inv = await invite(env, p.token, p.key);
  // every one of the 30 is still looked at (400), from 30 networks
  for (let i = 0; i < 30; i++) assert.equal((await join(env, p.token, '00000000', 'X', { ip: `192.0.2.${i + 1}` })).res.status, 400, `attempt ${i + 1}`);
  const r = await join(env, p.token, inv.json.code, 'X', { ip: '198.51.100.77' });
  assert.equal(r.res.status, 429);
  assert.equal(one(env, 'SELECT used_at FROM pick_invites').used_at, null);
  // another project is not locked
  const q = await claimed(env, { title: 'Q' });
  const invQ = await invite(env, q.token, q.key);
  assert.equal((await join(env, q.token, invQ.json.code, 'X', { ip: '198.51.100.77' })).res.status, 200);
});

test('join limit: failures older than 15 minutes no longer count; a success leaves no failure row', async () => {
  const env = setup();
  const p = await claimed(env);
  for (let i = 0; i < 5; i++) await join(env, p.token, '00000000', 'X', { ip: '203.0.113.50' });
  env.DB._db.prepare('UPDATE pick_join_failures SET created_at = ?').run(ago(15 * 60000 + 1000));
  const inv = await invite(env, p.token, p.key);
  const before = one(env, 'SELECT COUNT(*) AS n FROM pick_join_failures').n;
  assert.equal((await join(env, p.token, inv.json.code, 'X', { ip: '203.0.113.50' })).res.status, 200);
  assert.equal(one(env, 'SELECT COUNT(*) AS n FROM pick_join_failures').n, before, 'the success removed its own reservation');
});

test('join limit: a burst of parallel wrong guesses from one network records at most 5', async () => {
  const env = setup();
  const p = await claimed(env);
  const results = await Promise.all(Array.from({ length: 12 }, () => join(env, p.token, '00000000', 'X', { ip: '203.0.113.60' })));
  assert.equal(results.filter(r => r.res.status === 400).length, 5);
  assert.equal(results.filter(r => r.res.status === 429).length, 7);
});

// ─── Before the migration ──────────────────────────────────────────────────

test('before the migration: every co-picking route answers 500 co_picking_unavailable', async () => {
  const env = beforeMigration();
  const p = await claimed(env);
  const calls = [
    ['POST', 'invites', { window_days: 7 }, p.key],
    ['POST', 'join', { code: '12345678', name: 'B' }, undefined],
    ['GET', 'collaborators', undefined, p.key],
    ['PATCH', 'collaborators/x', { window_days: 1 }, p.key],
    ['DELETE', 'collaborators/x', undefined, p.key],
    ['POST', 'collaborators/x/decision', { approve: false }, p.key],
    ['POST', 'renewal', {}, p.key],
    ['POST', 'renewal', {}, undefined],
    ['GET', 'collaborators', undefined, undefined],
  ];
  for (const [method, route, body, key] of calls) {
    const res = await pick(env, method, route, p.token, { key, body });
    assert.equal(res.status, 500, `${method} ${route}`);
    assert.equal((await res.json()).code, 'co_picking_unavailable');
  }
});

test('before the migration: the state reads, the owner saves and submits as before', async () => {
  const env = beforeMigration();
  const p = await claimed(env);
  const r = await pick(env, 'PUT', 'selections', p.token, { key: p.key, body: { upsert: [{ photo_key: '20260819/a.jpg', rating: 1, note: 'n' }] } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  const s = await state(env, p.token, p.key);
  assert.equal(s.is_owner, true);
  assert.equal(s.role, 'owner');
  assert.equal(s.can_edit, true);
  assert.equal(s.selections[0].note, 'n');
  const v = await state(env, p.token);
  assert.equal(v.role, 'viewer');
  assert.equal(v.can_edit, false);
  assert.deepEqual(v.selections, [{ photo_key: '20260819/a.jpg', rating: 1 }]);
  const sub = await pick(env, 'POST', 'submit', p.token, { key: p.key, body: { relationship: '本人' } });
  assert.equal(sub.status, 200);
  const detail = await (await call(env, `/api/admin/projects/${p.project.id}`, { token: SECRET })).json();
  assert.deepEqual(detail.collaborators, []);
});

test('PICK_INVITE_SECRET missing or under 32 characters: every co-picking route answers 500 co_picking_unavailable; the rest works', async () => {
  for (const secret of [undefined, '', 'x'.repeat(31)]) {
    const env = setup({ PICK_INVITE_SECRET: secret });
    const p = await claimed(env);
    for (const [method, route, body, key] of [
      ['POST', 'invites', { window_days: 7 }, p.key],
      ['POST', 'join', { code: '12345678', name: 'B' }, undefined],
      ['GET', 'collaborators', undefined, p.key],
      ['PATCH', 'collaborators/x', { window_days: 1 }, p.key],
      ['DELETE', 'collaborators/x', undefined, p.key],
      ['POST', 'collaborators/x/decision', { approve: false }, p.key],
      ['POST', 'renewal', {}, p.key],
    ]) {
      const res = await pick(env, method, route, p.token, { key, body });
      assert.equal(res.status, 500, `${JSON.stringify(secret)} ${method} ${route}`);
      assert.equal((await res.json()).code, 'co_picking_unavailable');
    }
    assert.equal(one(env, 'SELECT COUNT(*) AS n FROM pick_invites').n, 0);
    assert.equal((await pick(env, 'PUT', 'selections', p.token, { key: p.key, body: { upsert: [{ photo_key: '20260819/a.jpg', rating: 1 }] } })).status, 200);
    assert.equal((await state(env, p.token, p.key)).role, 'owner');
  }
  // exactly 32 is enough; PHOTOGRAPHER_TOKEN alone is not
  const ok = setup({ PICK_INVITE_SECRET: 'y'.repeat(32) });
  const q = await claimed(ok);
  assert.equal((await invite(ok, q.token, q.key)).res.status, 200);
});

test('the migration file creates the same three tables as schema.sql, and runs twice', async () => {
  const { MIGRATION, CO_TABLES } = await import('./co-picking-helpers.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const shape = db => CO_TABLES.map(t => [t, db.prepare(`PRAGMA table_info(${t})`).all().map(c => [c.name, c.type, c.notnull, c.pk])]);
  const migrated = new DatabaseSync(':memory:');
  migrated.exec(MIGRATION);
  migrated.exec(MIGRATION);
  const fresh = setup().DB._db;
  assert.deepEqual(shape(migrated), shape(fresh));
  const idx = db => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_pick_invites_project', 'idx_project_collaborators_project', 'idx_pick_join_failures') ORDER BY name").all().map(r => r.name);
  assert.deepEqual(idx(migrated), idx(fresh));
  assert.equal(idx(fresh).length, 3);
  // six statements
  assert.equal(MIGRATION.split('\n').filter(l => /^CREATE /.test(l)).length, 6);
});

test('join through a state read: the new collaborator reads as role collaborator straight away', async () => {
  const env = setup();
  const { p, c } = await withCollaborator(env);
  const s = await state(env, p.token, c.key);
  assert.equal(s.role, 'collaborator');
  assert.equal(s.is_owner, false);
  assert.equal(s.can_edit, true);
});
