// The old client-account system (POST /api/auth/register and /login) is closed
// unless LEGACY_CLIENT_ACCOUNTS is exactly "on". Why: login had no throttle and
// stored one-round SHA-256, register had no cap at all. Anything but "on" -- a
// missing var, "ON", "true", a typo -- counts as off, like GUEST_ORDERS.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { fakeBucket, fakeDB, ctx, req } from './fakes.mjs';

const SECRET = 'photographer-secret';
const mk = (flag) => {
  const env = { imagepicker: fakeBucket(), PHOTOGRAPHER_TOKEN: SECRET, DB: fakeDB() };
  if (flag !== undefined) env.LEGACY_CLIENT_ACCOUNTS = flag;
  return env;
};
const post = (env, path, body) => worker.fetch(req(path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}), env, ctx);
const REG = { email: 'a@b.co', password: 'pw-12345678', name: 'A' };
const LOGIN = { email: 'a@b.co', password: 'pw-12345678' };

for (const flag of [undefined, 'off', 'ON', 'true', '1', '', ' on']) {
  test(`register is closed when LEGACY_CLIENT_ACCOUNTS is ${JSON.stringify(flag)}`, async () => {
    const env = mk(flag);
    const r = await post(env, '/api/auth/register', REG);
    assert.equal(r.status, 410);
    assert.equal((await r.json()).error, 'client_accounts_closed');
  });
  test(`login is closed when LEGACY_CLIENT_ACCOUNTS is ${JSON.stringify(flag)}`, async () => {
    const env = mk(flag);
    const r = await post(env, '/api/auth/login', LOGIN);
    assert.equal(r.status, 410);
    assert.equal((await r.json()).error, 'client_accounts_closed');
  });
}

test('a closed register writes nothing to D1', async () => {
  const env = mk('off');
  await post(env, '/api/auth/register', REG);
  const row = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind('a@b.co').first();
  assert.equal(row ?? null, null);
});

test('"on" opens register and login again (positive case)', async () => {
  const env = mk('on');
  assert.equal((await post(env, '/api/auth/register', REG)).status, 201);
  // not approved yet: 403, not 410 -- proves the request reached the old code
  assert.equal((await post(env, '/api/auth/login', LOGIN)).status, 403);
});

test('the shipped wrangler.toml has it off', async () => {
  const { readFileSync } = await import('node:fs');
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(toml, /^LEGACY_CLIENT_ACCOUNTS\s*=\s*"off"/m);
});
