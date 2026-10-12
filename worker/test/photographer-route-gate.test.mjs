// Batch 2b-0, security review: a photographer route that forgets its guard
// must fail closed.
//
// The Worker's front (export default fetch) asks who is calling before any
// handler runs, for every path that only a photographer may reach
// (photographerOnlyPath: /api/admin/*, /api/shares/minted*, /api/shares/:t/
// revoke*, /api/auth/studio-token, /api/auth/verify-admin): no photographer
// identity is that route's own 401, and no handler runs. And after the
// handler, a response on such a path that did not go through
// requirePhotographer / requireDefault is replaced by 401 — so a new route
// with no guard, or with a hand-rolled token compare, cannot answer.
//
// The proof of concept from the review is kept as the first test: two routes
// injected into a copy of worker.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fakeDB, ctx, req } from './fakes.mjs';
import { SECRET, MINE, setup, call, createProject } from './pick-helpers.mjs';
import { seedPhotographer, snapshot, ROUTES_ON } from './tenant-helpers.mjs';

const SRC = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const codeCount = needle => SRC.split('\n').reduce((n, line) => n + (line.split('//')[0].split(needle).length - 1), 0);
const UNKNOWN = 'e'.repeat(64);
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

async function load(source, name) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, source);
  return (await import(pathToFileURL(file).href)).default;
}
const hit = (mod, env, method, path, token, body) => mod.fetch(req(path, {
  method, token,
  headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}), env, ctx);

// ─── the review's proof of concept ─────────────────────────────────────────
const BANNER = '    // ═══════════════════════════════════════════════════════════════════════\n    // AUTH ROUTES';
const INJECTED = `
    // (test only) a route that forgot its guard, under each photographer-only prefix
    if (['/api/admin/poc-open', '/api/shares/minted/poc', '/api/shares/poc/revoke', '/api/auth/studio-token', '/api/auth/verify-admin'].includes(url.pathname)) {
      const row = await env.DB.prepare('SELECT title FROM projects LIMIT 1').first();
      return jsonOk({ leaked: row ? row.title : null });
    }
    // (test only) a route that compares the token by hand
    if (url.pathname === '/api/admin/poc-handrolled') {
      if (bearerToken(request) !== env.PHOTOGRAPHER_TOKEN) return jsonErr('Unauthorized', 401);
      const row = await env.DB.prepare('SELECT title FROM projects LIMIT 1').first();
      return jsonOk({ leaked: row ? row.title : null });
    }
`;

test('PoC: an injected route with no guard, or a hand-rolled token compare, answers nobody (401)', async () => {
  assert.equal(SRC.split(BANNER).length - 1, 1, 'the injection point exists once');
  const mod = await load(SRC.replace(BANNER, INJECTED + BANNER), 'worker-poc');
  for (const flags of [{}, ROUTES_ON]) {
    const env = setup(flags);
    await createProject(env);
    const B = await seedPhotographer(env);
    const flagged = await seedPhotographer(env, { mustChange: true });
    for (const path of ['/api/admin/poc-open', '/api/shares/minted/poc', '/api/shares/poc/revoke', '/api/auth/studio-token', '/api/auth/verify-admin', '/api/admin/poc-handrolled']) {
      for (const token of [undefined, UNKNOWN, B.token, flagged.token, SECRET]) {
        const before = snapshot(env);
        const res = await hit(mod, env, 'GET', path, token);
        const text = await res.text();
        assert.ok(res.status === 401 || res.status === 403, `${path} ${String(token).slice(0, 6)} → ${res.status} ${text}`);
        assert.ok(!text.includes('王先生'), `${path} leaked: ${text}`);
        assert.equal(snapshot(env), before);
      }
    }
  }
});

test('the guard is not optional for the front: an anonymous request never reaches a photographer-only handler', async () => {
  // a handler that would write if it ran
  const mod = await load(SRC.replace(BANNER, `
    if (url.pathname === '/api/admin/poc-write') {
      await env.DB.prepare("UPDATE projects SET title = 'pwned'").run();
      return jsonOk({ ok: true });
    }
` + BANNER), 'worker-poc-write');
  const env = setup(ROUTES_ON);
  await createProject(env);
  const B = await seedPhotographer(env, { mustChange: true });
  for (const token of [undefined, UNKNOWN, 'not-a-session', B.token]) {
    const before = snapshot(env);
    const res = await hit(mod, env, 'POST', '/api/admin/poc-write', token, {});
    assert.ok(res.status === 401 || res.status === 403, `${String(token)} → ${res.status}`);
    assert.equal(snapshot(env), before, `${String(token)}: the handler ran`);
  }
});

// ─── the crawl: every /api path in the source ──────────────────────────────
// Every '/api/...' literal and every `pathParts[0] === 'api' && pathParts[1]
// === '...'` branch, as a concrete path (unnamed segments filled in). A path
// is either public (listed here, tested in its own suite) or must refuse a
// caller without a photographer identity, on every method.
const PUBLIC = [
  /^\/api\/pick(\/|$)/,                  // guest links (pick-*.test.mjs)
  /^\/api\/photographer(\/|$)/,          // accounts: register / login / me … (photographer-*.test.mjs)
  /^\/api\/platform(\/|$)/,              // public product images (404 for anything else there)
  /^\/api\/studio\/logo$/,               // public logo
  /^\/api\/auth\/(login|logout|register|me|session-token)$/,   // legacy client accounts
  /^\/api\/books(\/|$)/,                 // albums: share links too (photographer-routes.test.mjs covers the admin branch)
];
function crawledPaths() {
  const paths = new Set();
  for (const m of SRC.matchAll(/['`](\/api\/[A-Za-z0-9_\-/]*)/g)) paths.add(m[1].replace(/\/$/, '/zz'));
  // each `if (` condition naming pathParts[0] === 'api', joined across lines
  // up to its opening brace; every value an index is compared with gives a
  // variant (the others at their first value)
  const lines = SRC.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*if \(/.test(lines[i])) continue;
    let cond = lines[i];
    for (let j = i + 1; !/\{\s*$/.test(cond) && j < lines.length && j < i + 6; j++) cond += ' ' + lines[j].trim();
    if (!/pathParts\[0\] === 'api'/.test(cond)) continue;
    const values = [];
    for (const m of cond.matchAll(/pathParts\[(\d)\] === '([^']+)'/g)) (values[m[1]] ??= []).includes(m[2]) || values[m[1]].push(m[2]);
    for (const m of cond.matchAll(/(?<![!.\w])pathParts\[(\d)\](?! ===)/g)) values[m[1]] ??= ['zz'];
    if (!values[1]) continue;
    const first = Array.from(values, v => (v ? v[0] : 'zz'));
    values.forEach((vs, k) => (vs || ['zz']).forEach(v => { const parts = [...first]; parts[k] = v; paths.add('/' + parts.join('/')); }));
  }
  return [...paths].sort();
}

const NOBODY_ID = '00000000-0000-4000-8000-000000000000';
test('crawl: every non-public /api path refuses a caller without a photographer identity, on every method', async () => {
  const paths = crawledPaths();
  assert.ok(paths.length >= 30, `only ${paths.length} paths found: the crawl is broken`);
  const guarded = paths.filter(p => !PUBLIC.some(re => re.test(p)));
  assert.ok(guarded.length >= 20, `only ${guarded.length} guarded paths`);
  for (const must of ['/api/admin/clients', '/api/admin/projects', '/api/admin/settings', '/api/shares/minted', '/api/auth/studio-token', '/api/operator']) {
    assert.ok(guarded.some(p => p.startsWith(must)), `${must} not crawled`);
  }
  const mod = (await import('../worker.js')).default;
  for (const flags of [{}, ROUTES_ON]) {
    const env = setup(flags);
    const project = await createProject(env);
    const B = await seedPhotographer(env);
    const flagged = await seedPhotographer(env, { mustChange: true });
    const squat = await seedPhotographer(env, { id: 'default', email: 'squat@example.com' });
    for (const path of guarded.map(p => p.replaceAll('zz', project.project.id))) {
      for (const method of METHODS) {
        for (const [who, token] of [['none', undefined], ['unknown', UNKNOWN], ['B', B.token], ['flagged', flagged.token], ['squat', squat.token]]) {
          const before = snapshot(env);
          const res = await hit(mod, env, method, path, token, method === 'GET' ? undefined : {});
          const allowed = who === 'none' || who === 'unknown' || who === 'squat' || !flags.PHOTOGRAPHER_ROUTES ? [401] : [401, 403, 404];
          // verify-admin is open to every photographer (it answers {ok:true}, no data)
          if (who === 'B' && flags.PHOTOGRAPHER_ROUTES && path === '/api/auth/verify-admin' && method === 'GET') allowed.push(200);
          // scoped since 2b-1: B's own project list (B has none here), and
          // the 405 a write to a project id gets, the same for any id (no data)
          const ownList = who === 'B' && flags.PHOTOGRAPHER_ROUTES && path === '/api/admin/projects' && method === 'GET';
          if (ownList) allowed.push(200);
          if (who === 'B' && flags.PHOTOGRAPHER_ROUTES && path === `/api/admin/projects/${project.project.id}` && (method === 'PUT' || method === 'POST')) allowed.push(405);
          // scoped since 2b-2, the products / orders block: B's own lists
          // (empty here) and the shared platform catalogue (empty here); the
          // two creates take no id (custom products off: 403; no platform
          // product: 400); and the 405 for a method the path does not take,
          // decided before any id is looked up — the same for an id nobody
          // has (checked below), so it says nothing about A's
          const block = /^\/api\/admin\/(products|platform-products|orders)(\/|$)|^\/api\/admin\/projects\/[^/]+\/orders$/.test(path);
          const blockList = block && method === 'GET' && ['/api/admin/products', '/api/admin/platform-products', '/api/admin/orders'].includes(path);
          if (who === 'B' && flags.PHOTOGRAPHER_ROUTES && block) {
            if (blockList) allowed.push(200);
            if (method === 'POST' && path === '/api/admin/products') allowed.push(403);
            if (method === 'POST' && path === '/api/admin/products/from-platform') allowed.push(400);
          }
          // scoped since 2b-3: B's own settings (200), counts (200) and logo
          // (none: GET 404; a body that is no image: 415; delete: 200), and
          // the 405 for a method the path does not take (no id: no data).
          // B's own studio_settings row is the one thing it may write.
          const own = who === 'B' && flags.PHOTOGRAPHER_ROUTES && /^\/api\/admin\/(settings|settings\/logo|stats)$/.test(path);
          if (own) allowed.push(200, 405, 415);
          const text = await res.clone().text();
          if (who === 'B' && flags.PHOTOGRAPHER_ROUTES && block && res.status === 405) {
            const nobody = await hit(mod, env, method, path.replaceAll(project.project.id, NOBODY_ID), token, method === 'GET' ? undefined : {});
            assert.equal(nobody.status, 405, `${method} ${path}`);
            assert.equal(text, await nobody.text(), `${method} ${path}: B tells A's resource from none`);
            allowed.push(405);
          }
          if (blockList && res.status === 200) {
            const empty = { '/api/admin/products': { products: [], custom_products_enabled: false }, '/api/admin/platform-products': { products: [] }, '/api/admin/orders': { orders: [] } }[path];
            assert.deepEqual(JSON.parse(text), empty, `B ${path}`);
          }
          // a scoped route may refuse B's malformed body before it looks the
          // project up (PATCH: 400): fine only if it answers exactly the same
          // for a project id nobody has, so it says nothing about A's
          if (who === 'B' && flags.PHOTOGRAPHER_ROUTES && !allowed.includes(res.status) && res.status === 400 && path.includes(project.project.id)) {
            const nobody = await hit(mod, env, method, path.replaceAll(project.project.id, NOBODY_ID), token, method === 'GET' ? undefined : {});
            assert.equal(res.status, nobody.status, `${method} ${path}`);
            assert.equal(text, await nobody.text(), `${method} ${path}: B tells A's project from none`);
            allowed.push(400);
          }
          // scoped since batch 3: B's own files (any PUT that reaches the
          // upload route lands under B's prefix, under the logical key it
          // names), B's own studio token (one row, B's), B's own minted
          // tokens (none), and a create with no folders (400, no id at all).
          // Each is set aside before the "nothing written" check below.
          const bOn = who === 'B' && flags.PHOTOGRAPHER_ROUTES;
          const logical = decodeURIComponent(path.slice(1));
          const upload = bOn && method === 'PUT' && res.status === 200 && env.imagepicker._store.has(`_t/${B.id}/${logical}`);
          if (upload) {
            assert.deepEqual(JSON.parse(text), { ok: true, key: logical }, path);
            env.imagepicker._store.delete(`_t/${B.id}/${logical}`);
            allowed.push(200);
          }
          if (bOn && method === 'POST' && path === '/api/auth/studio-token' && res.status === 200) {
            assert.equal(env.DB._db.prepare("DELETE FROM share_tokens WHERE kind = 'studio' AND photographer_id = ?").run(B.id).changes, 1);
            allowed.push(200);
          }
          if (bOn && method === 'GET' && path === '/api/shares/minted' && res.status === 200) {
            assert.deepEqual(JSON.parse(text), []);
            allowed.push(200);
          }
          if (bOn && method === 'POST' && path === '/api/shares/minted/revoke-all' && res.status === 200) {
            assert.deepEqual(JSON.parse(text), { ok: true, revoked: 0 });
            allowed.push(200);
          }
          if (bOn && method === 'POST' && path === '/api/admin/projects') allowed.push(400);
          assert.ok(allowed.includes(res.status), `${flags.PHOTOGRAPHER_ROUTES ?? 'off'} ${who} ${method} ${path} → ${res.status} ${text.slice(0, 120)}`);
          // (B's own upload answers the key B itself sent, which may hold the id)
          assert.ok((upload ||!text.includes(project.project.id)) && !text.includes('王先生'), `${who} ${method} ${path} leaked: ${text.slice(0, 200)}`);
          if (ownList) assert.deepEqual(JSON.parse(text), { projects: [] });
          if (own && res.status === 200 && path !== '/api/admin/stats') {
            const s = JSON.parse(text);
            assert.equal(s.has_logo, false, `B ${method} ${path}: not A's logo`);
          }
          if (own) {
            // B's row may have been written (PUT settings) or touched (DELETE
            // logo): set aside, nothing else may differ
            const mine = env.DB._db.prepare('SELECT * FROM studio_settings WHERE photographer_id = ?').get(B.id);
            env.DB._db.prepare('DELETE FROM studio_settings WHERE photographer_id = ?').run(B.id);
            const after = snapshot(env);
            if (mine) {
              const cols = Object.keys(mine);
              env.DB._db.prepare(`INSERT INTO studio_settings (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...Object.values(mine));
            }
            const beforeWithout = JSON.parse(before);
            beforeWithout.data.studio_settings = beforeWithout.data.studio_settings.filter(r => r.photographer_id !== B.id);
            assert.equal(after, JSON.stringify(beforeWithout), `${who} ${method} ${path} wrote outside B's own settings row`);
            continue;
          }
          assert.equal(snapshot(env), before, `${who} ${method} ${path} wrote`);
        }
      }
    }
  }
});

// ─── scans ─────────────────────────────────────────────────────────────────
test('PHOTOGRAPHER_TOKEN is read in exactly two places: isAdminToken and the operator check that refuses an equal OPERATOR_TOKEN', () => {
  assert.equal(codeCount('env.PHOTOGRAPHER_TOKEN'), 2);
  assert.equal(codeCount('PHOTOGRAPHER_TOKEN'), 2, 'no other spelling (env[...], destructuring)');
  const admin = SRC.slice(SRC.indexOf('function isAdminToken('), SRC.indexOf('\n}\n', SRC.indexOf('function isAdminToken(')));
  assert.ok(admin.includes('env.PHOTOGRAPHER_TOKEN'));
  const op = SRC.slice(SRC.indexOf('function isOperatorToken('), SRC.indexOf('\n}\n', SRC.indexOf('function isOperatorToken(')));
  assert.ok(op.includes('secret === env.PHOTOGRAPHER_TOKEN'));
});

test('isAdminToken is never aliased or passed around: only its definition and the call in identify', () => {
  const uses = [...SRC.matchAll(/\bisAdminToken\b(.?)/g)].filter(m => {
    const lineStart = SRC.lastIndexOf('\n', m.index) + 1;
    return !SRC.slice(lineStart, m.index).includes('//');
  });
  assert.equal(uses.length, 2);
  for (const m of uses) assert.equal(m[1], '(', 'called, never referenced as a value');
  assert.match(SRC.slice(uses[1].index - 200, uses[1].index), /async function identify\(|function identify\(/, 'the one call is in identify');
});

test('isAdminToken compares in constant time (sameSecret) and fails closed on an unset or empty secret', async () => {
  const fn = SRC.slice(SRC.indexOf('function isAdminToken('), SRC.indexOf('\n}\n', SRC.indexOf('function isAdminToken(')));
  assert.match(fn, /sameSecret\(/);
  assert.ok(!/===\s*env\.PHOTOGRAPHER_TOKEN|env\.PHOTOGRAPHER_TOKEN\s*===/.test(fn), 'no plain compare');
  for (const secret of [undefined, '', null]) {
    const env = setup({ PHOTOGRAPHER_TOKEN: secret });
    for (const token of [undefined, '', 'x', 'undefined', 'null']) {
      assert.equal((await call(env, '/api/admin/projects', { token })).status, 401, `${secret} ${token}`);
    }
  }
  const env = setup();
  assert.equal((await call(env, '/api/admin/projects', { token: SECRET })).status, 200);
  assert.equal((await call(env, '/api/admin/projects', { token: SECRET + 'x' })).status, 401);
  assert.equal((await call(env, '/api/admin/projects', { token: SECRET.slice(0, -1) })).status, 401);
});

// ─── optional routes and the session lookup ────────────────────────────────
test('a D1 error in the session lookup does not 500 a share-link visitor on the list / object routes', async () => {
  const env = setup(ROUTES_ON);
  const created = await createProject(env);
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    if (/FROM photographer_sessions/.test(sql) && /^\s*SELECT/i.test(sql)) throw new Error('D1_ERROR: network connection lost');
    return realPrepare(sql);
  };
  const t = encodeURIComponent(created.token);
  for (const path of [`/?list=${encodeURIComponent(MINE)}&t=${t}`, `/20260819/a.jpg?w=400&t=${t}`]) {
    const res = await call(env, path, { token: UNKNOWN });
    assert.equal(res.status, 200, path);
  }
  // and without a link it is just an anonymous visitor
  assert.equal((await call(env, `/?list=${encodeURIComponent(MINE)}`, { token: UNKNOWN })).status, 401);
  // a photographer-only route still fails loudly (not quietly anonymous)
  await assert.rejects(call(env, '/api/admin/projects', { token: UNKNOWN }), /D1_ERROR/);
});

test('a session row named "default" is 401 on every route, flagged or not, optional routes included', async () => {
  for (const mustChange of [false, true]) {
    const env = setup(ROUTES_ON);
    const created = await createProject(env);
    const squat = await seedPhotographer(env, { id: 'default', email: 'squat@example.com', mustChange });
    const t = encodeURIComponent(created.token);
    for (const path of ['/api/auth/verify-admin', '/api/admin/projects', '/api/books/b1', `/?list=${encodeURIComponent(MINE)}&t=${t}`, `/20260819/a.jpg?t=${t}`, '/20260819/a.jpg']) {
      const res = await call(env, path, { token: squat.token });
      assert.equal(res.status, 401, `${mustChange} ${path}`);
    }
  }
});

test('the front and the route share one session lookup per request', async () => {
  const env = setup(ROUTES_ON);
  const B = await seedPhotographer(env);
  const reads = [];
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => { if (/^\s*SELECT[\s\S]*FROM photographer_sessions/i.test(sql)) reads.push(sql); return realPrepare(sql); };
  // scoped since 2b-1: B's own (empty) list
  assert.equal((await call(env, '/api/admin/projects', { token: B.token })).status, 200);
  assert.equal(reads.length, 1);
});

test('the front keeps each route’s own answer: verify-admin says Token 不正確; CORS preflights are never gated', async () => {
  for (const flags of [{}, ROUTES_ON]) {
    const env = setup(flags);
    for (const token of [undefined, UNKNOWN]) {
      const res = await call(env, '/api/auth/verify-admin', { token });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: 'Token 不正確' });
    }
    for (const path of ['/api/admin/projects', '/api/shares/minted', '/api/auth/studio-token']) {
      const res = await call(env, path, { method: 'OPTIONS' });
      assert.equal(res.status, 200, path);
      assert.ok(res.headers.get('Access-Control-Allow-Origin'), path);
    }
  }
});

test('a D1 error in the session lookup fails loudly on the upload route (not a quiet 401)', async () => {
  const env = setup(ROUTES_ON);
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => {
    if (/FROM photographer_sessions/.test(sql) && /^\s*SELECT/i.test(sql)) throw new Error('D1_ERROR: network connection lost');
    return realPrepare(sql);
  };
  await assert.rejects(call(env, '/2026/new.jpg', { method: 'PUT', token: UNKNOWN, body: 'bytes' }), /D1_ERROR/);
  assert.equal(env.imagepicker._store.has('2026/new.jpg'), false);
});
