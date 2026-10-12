// Batch 2b-0 of docs/multi-photographer.md: the identity layer.
//
// Every photographer route asks requirePhotographer / requireDefault who is
// calling. PHOTOGRAPHER_TOKEN is the default photographer; a photographer
// session is someone else, and is let in only while the kill switch
// photographerRoutesOpen(env) says so (PHOTOGRAPHER_ROUTES = "on"; anything
// else, unset included, is off). Off, a session gets exactly what an unknown
// token gets today. On, every route that is not yet scoped to its caller
// (until batch 3 lands) answers a non-default photographer 404 and writes
// nothing; the scoped ones (2b-1: the project routes; 2b-2: products and
// orders; 2b-3: settings, logo, dashboard) answer B's own data only, and A's
// resource is 404 to B (project-scope.test.mjs, product-order-scope.test.mjs
// and settings-scope.test.mjs have the per-route two-photographer tests).
//
// The route table below is checked against the source: every call site must
// be reached by a table route (an instrumented copy of worker.js records which
// site each request goes through), so a new photographer route without an
// entry here fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fakeDB, ctx, req } from './fakes.mjs';
import { SECRET, MINE, CUSTOM_ON, setup, call, createProject, rows } from './pick-helpers.mjs';
import { seedPhotographer, twoTenants, snapshot, ROUTES_ON } from './tenant-helpers.mjs';

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const SRC = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const UNKNOWN = 'e'.repeat(64);           // shaped like a session token, matches none
// occurrences outside `//` comments
const codeCount = needle => SRC.split('\n').reduce((n, line) => n + (line.split('//')[0].split(needle).length - 1), 0);
// 'open': any photographer, no data. 'scoped': any photographer, its own data
// only (who.id) — what 2b-1..3 turn their routes into. The rest: default only
// until that batch.
const UNTIL = ['open', 'scoped', 'batch 3', 'retired'];   // 2b-1, 2b-2 and 2b-3 are merged: their routes are 'scoped'
// which helper a mark requires at its call site
const helperFor = until => (until === 'open' || until === 'scoped' ? 'requirePhotographer' : 'requireDefault');
// the mark on a call-site line
const markOf = line => /\/\/ default-only until (batch 3|retired)\b/.exec(line)?.[1]
  ?? (/\/\/ open to every photographer\b/.test(line) ? 'open' : /\/\/ scoped to the caller\b/.test(line) ? 'scoped' : null);

// ─── fixture: one of everything the default photographer owns ──────────────
async function fixture(env) {
  const created = await createProject(env);
  const projectId = created.project.id;
  const now = new Date().toISOString();
  const db = env.DB._db;
  db.prepare("INSERT INTO products (id, photographer_id, kind, name, created_at, updated_at) VALUES ('prod-a', 'default', 'service', '拍攝', ?, ?)").run(now, now);
  db.prepare("INSERT INTO product_options (id, product_id, label, price) VALUES ('opt-a', 'prod-a', '', 1000)").run();
  db.prepare("INSERT INTO orders (id, photographer_id, project_id, source, status, created_at, updated_at, confirmed_at) VALUES ('ord-a', 'default', ?, 'admin', 'confirmed', ?, ?, ?)").run(projectId, now, now, now);
  db.prepare("INSERT INTO order_items (id, order_id, kind, product_id, option_id, name, unit_price, qty) VALUES ('item-a', 'ord-a', 'service', 'prod-a', 'opt-a', '拍攝', 1000, 1)").run();
  // the default photographer's logo (GET /api/admin/settings/logo answers A 200)
  db.prepare("INSERT INTO studio_settings (photographer_id, logo, logo_type, logo_updated_at, updated_at) VALUES ('default', ?, 'image/png', ?, ?)")
    .run(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]), now, now);
  const user = db.prepare("INSERT INTO users (email, password_hash, name, folder_path, approved) VALUES ('c@example.com', 'x', '客人', ?, 0)").run(MINE);
  return { projectId, pickToken: created.token, userId: Number(user.lastInsertRowid) };
}

// until: which batch scopes the route to its caller (until then: default
// only). 'open': answers every photographer, and carries no data.
const R = (until, method, path, body) => ({ until, method, path, body });
const P = f => `/api/admin/projects/${f.projectId}`;
const ROUTES = [
  R('open', 'GET', () => '/api/auth/verify-admin'),
  R('batch 3', 'POST', () => '/api/auth/studio-token'),
  R('retired', 'GET', () => '/api/admin/clients'),
  R('retired', 'PUT', f => `/api/admin/clients/${f.userId}/approve`),
  R('retired', 'PUT', f => `/api/admin/clients/${f.userId}/permissions`, { can_book: true }),
  R('retired', 'DELETE', f => `/api/admin/clients/${f.userId}`),
  R('batch 3', 'POST', () => '/api/admin/projects', { title: '新案', folders: [MINE] }),
  R('scoped', 'GET', () => '/api/admin/projects'),
  R('scoped', 'GET', P),
  R('scoped', 'POST', f => `${P(f)}/reset-seat`),
  R('scoped', 'POST', f => `${P(f)}/start-retouch`),
  R('scoped', 'POST', f => `${P(f)}/reopen`),
  R('scoped', 'POST', f => `${P(f)}/archive`),
  R('scoped', 'POST', f => `${P(f)}/unarchive`),
  R('scoped', 'DELETE', P),
  R('scoped', 'POST', f => `${P(f)}/links`),
  R('batch 3', 'POST', f => `${P(f)}/deliver`, { final_folders: [MINE] }),
  R('batch 3', 'POST', f => `${P(f)}/undeliver`),
  R('scoped', 'POST', f => `${P(f)}/confirm`),
  R('scoped', 'PATCH', P, { title: '改名' }),
  R('open', 'PUT', P, {}),
  R('open', 'POST', P, {}),
  R('scoped', 'GET', () => '/api/admin/products'),
  R('scoped', 'POST', () => '/api/admin/products', { kind: 'service', name: 'x', options: [{ label: '', price: 1 }] }),
  R('scoped', 'GET', () => '/api/admin/platform-products'),
  R('scoped', 'POST', () => '/api/admin/products/from-platform', { platform_product_id: 'nope' }),
  R('scoped', 'PUT', () => '/api/admin/products/prod-a', { guest_visible: 1 }),
  R('scoped', 'POST', () => '/api/admin/products/prod-a/retire'),
  R('scoped', 'POST', () => '/api/admin/products/prod-a/restore'),
  R('scoped', 'GET', () => '/api/admin/orders'),
  R('scoped', 'GET', f => `${P(f)}/orders`),
  R('scoped', 'POST', f => `${P(f)}/orders`, { lines: [{ option_id: 'opt-a', qty: 1 }] }),
  R('scoped', 'PUT', () => '/api/admin/orders/ord-a', { note: '備註' }),
  R('scoped', 'POST', () => '/api/admin/orders/ord-a/erase-contact'),
  R('scoped', 'POST', () => '/api/admin/orders/ord-a/payment', { paid_amount: 0 }),
  R('scoped', 'POST', () => '/api/admin/orders/ord-a/status', { status: 'fulfilled' }),
  R('scoped', 'GET', () => '/api/admin/stats'),
  R('scoped', 'GET', () => '/api/admin/settings'),
  R('scoped', 'PUT', () => '/api/admin/settings', { studio_name: '工作室' }),
  R('scoped', 'GET', () => '/api/admin/settings/logo'),
  R('scoped', 'PUT', () => '/api/admin/settings/logo', 'not an image'),
  R('scoped', 'DELETE', () => '/api/admin/settings/logo'),
  R('batch 3', 'GET', () => '/api/shares/minted'),
  R('batch 3', 'POST', () => '/api/shares/minted/revoke-all'),
  R('batch 3', 'POST', f => `/api/shares/${encodeURIComponent(f.pickToken)}/revoke`),
  R('batch 3', 'POST', () => '/api/books/b1/share', {}),
  R('batch 3', 'GET', () => '/api/books/b1/shares'),
  R('batch 3', 'GET', () => '/api/books/b1'),
  R('batch 3', 'PUT', () => '/api/books/b1', { name: '王先生 婚紗', clientFolders: [MINE], pages: [] }),
  R('batch 3', 'PATCH', () => '/api/books/b1', { name: '新名' }),
  R('batch 3', 'PUT', () => '/2026/new.jpg', 'bytes'),
  R('batch 3', 'GET', () => `/?list=${encodeURIComponent(MINE)}`),
  R('batch 3', 'GET', () => '/20260819/a.jpg'),
];
const label = r => `${r.method} ${r.path({ projectId: ':id', pickToken: ':token', userId: ':uid' })}`;
const send = (mod, env, r, f, token) => mod.fetch(req(r.path(f), {
  method: r.method, token,
  headers: r.body !== undefined && typeof r.body !== 'string' ? { 'Content-Type': 'application/json' } : {},
  body: r.body === undefined ? undefined : typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
}), env, ctx);

let realWorker;
async function worker() { return (realWorker ??= (await import('../worker.js')).default); }

// ─── the call sites, read from the source ─────────────────────────────────
// Each `requirePhotographer(` / `requireDefault(` call outside the two helpers
// themselves, with the batch named on its line.
// the nearest top-level declaration above `index`: `function NAME(` (the
// Worker's routes live in routeRequest), or the export's `async fetch(` (a
// top-level `const` closes the previous one)
function enclosingFunction(src, index) {
  let name = null;
  for (const m of src.slice(0, index).matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)\(|^  async (fetch)\(|^(?:const|let) /gm)) name = m[1] || m[2] || '(top level)';
  return name;
}
function callSites(src = SRC) {
  const sites = [];
  for (const m of src.matchAll(/\b(requirePhotographer|requireDefault)\(/g)) {
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const line = src.slice(lineStart, src.indexOf('\n', m.index));
    if (/^\s*(async\s+)?function\s/.test(line) || /^\s*\/\//.test(line)) continue;   // the definition, or prose
    const inside = enclosingFunction(src, m.index);
    if (inside === 'requirePhotographer' || inside === 'requireDefault') continue;
    const until = markOf(line);
    sites.push({ fn: m[1], index: m.index, line: line.trim(), until });
  }
  return sites;
}

test('route table: at least 45 routes, every call site is marked, and the marks agree with the helper used', () => {
  assert.ok(ROUTES.length >= 45, `${ROUTES.length} routes`);
  const sites = callSites();
  assert.ok(sites.length >= 25, `only ${sites.length} call sites found: the scan is broken`);
  for (const s of sites) {
    assert.ok(UNTIL.includes(s.until), `unmarked call site: ${s.line}`);
    // requireDefault is the default-only gate; requirePhotographer alone opens the route
    assert.equal(s.fn, helperFor(s.until), s.line);
  }
  for (const r of ROUTES) assert.ok(UNTIL.includes(r.until), label(r));
  // isAdminToken survives only inside identify (requirePhotographer's lookup)
  assert.equal(codeCount('isAdminToken('), 2, 'its definition and identify');
  const fn = SRC.slice(SRC.indexOf('async function identify('), SRC.indexOf('\n}\n', SRC.indexOf('async function identify(')));
  assert.ok(fn.includes('isAdminToken(request, env)'));
  assert.ok(fn.includes('photographerRoutesOpen(env)'));
  const gate = SRC.slice(SRC.indexOf('async function requirePhotographer('), SRC.indexOf('\n}\n', SRC.indexOf('async function requirePhotographer(')));
  assert.ok(gate.includes('photographerIdentity(request, env)'));
});

// An instrumented copy of worker.js: each call site reports its number before
// it runs. Every table route must pass through exactly one site, that site's
// mark must be the route's `until`, and every site must be reached.
test('route table covers every call site (instrumented worker)', async () => {
  const sites = callSites();
  let out = '';
  let at = 0;
  sites.forEach((s, i) => {
    out += SRC.slice(at, s.index) + `(globalThis.__siteHit(${i}), ${s.fn})(`;
    at = s.index + s.fn.length + 1;
  });
  out += SRC.slice(at);
  const dir = mkdtempSync(join(tmpdir(), 'routes-'));
  const file = join(dir, 'worker-instrumented.mjs');
  writeFileSync(file, out);
  const mod = (await import(pathToFileURL(file).href)).default;
  const reached = new Set();
  try {
    for (const r of ROUTES) {
      const env = setup();
      const f = await fixture(env);
      const hits = [];
      globalThis.__siteHit = i => { hits.push(i); };
      const res = await send(mod, env, r, f, SECRET);
      assert.equal(hits.length, 1, `${label(r)} went through ${hits.length} call sites (${res.status})`);
      assert.equal(sites[hits[0]].until, r.until, `${label(r)}: ${sites[hits[0]].line}`);
      reached.add(hits[0]);
    }
  } finally { delete globalThis.__siteHit; }
  for (let i = 0; i < sites.length; i++) assert.ok(reached.has(i), `no table route reaches: ${sites[i].line}`);
});

// ─── positive control: the default photographer is not refused anywhere ────
for (const flags of [{}, ROUTES_ON]) {
  test(`PHOTOGRAPHER_TOKEN opens every route (${flags.PHOTOGRAPHER_ROUTES ?? 'switch unset'})`, async () => {
    const mod = await worker();
    for (const r of ROUTES) {
      const env = setup({ ...CUSTOM_ON, ...flags });
      const f = await fixture(env);
      const res = await send(mod, env, r, f, SECRET);
      const text = await res.text();
      assert.ok(![401, 403, 404].includes(res.status) && res.status < 500, `${label(r)}: ${res.status} ${text.slice(0, 200)}`);
    }
  });
}

// ─── switch off: a session is just an unknown token, as before 2b ──────────
for (const value of [undefined, 'off', 'ON', 'On', ' on', 'on ', 'true', '1', 'yes', '']) {
  test(`PHOTOGRAPHER_ROUTES=${JSON.stringify(value)}: a live session gets exactly what an unknown token gets, and writes nothing`, async () => {
    const mod = await worker();
    for (const r of ROUTES) {
      const env = setup(value === undefined ? {} : { PHOTOGRAPHER_ROUTES: value });
      const f = await fixture(env);
      const { B } = await twoTenants(env);
      const before = snapshot(env);
      const asSession = await send(mod, env, r, f, B.token);
      const sessionText = await asSession.text();
      assert.equal(snapshot(env), before, `${label(r)} wrote something`);
      const asUnknown = await send(mod, env, r, f, UNKNOWN);
      assert.equal(asSession.status, asUnknown.status, label(r));
      assert.equal(sessionText, await asUnknown.text(), label(r));
      assert.ok(asSession.status === 401 || asSession.status === 404 || asSession.status === 403, `${label(r)}: ${asSession.status}`);
      if (value !== undefined && value !== 'off') break;   // the odd spellings: one route is enough per value
    }
  });
}

// ─── switch on: a non-default photographer reaches nothing that is not theirs
test('PHOTOGRAPHER_ROUTES=on: a non-default session is 404 on every default-only route and writes nothing', async () => {
  const mod = await worker();
  let refused = 0;
  for (const r of ROUTES) {
    const env = setup(ROUTES_ON);
    const f = await fixture(env);
    const { B } = await twoTenants(env);
    const before = snapshot(env);
    const res = await send(mod, env, r, f, B.token);
    const text = await res.text();
    // 2b-3: B's settings PUT writes B's own studio_settings row, and only that
    if (label(r) === 'PUT /api/admin/settings') {
      assert.equal(env.DB._db.prepare('DELETE FROM studio_settings WHERE photographer_id = ?').run(B.id).changes, 1, 'B\'s own row');
    }
    assert.equal(snapshot(env), before, `${label(r)} wrote something`);
    // nothing of A's in any answer to B
    assert.ok(!text.includes(f.projectId) && !text.includes('王先生') && !text.includes(MINE), `${label(r)} leaked: ${text}`);
    // the answers that are not a 404: verify-admin (no data), the 405 on a
    // project id (no data, the same for any id, D1 never asked) and the
    // project list, scoped (B's own projects: none here). Every other scoped
    // route is B on A's resource: 404 and nothing written, like default-only
    // (project-scope.test.mjs: per route, against a nonexistent id too) — and
    // A still gets it (the positive control above runs every route with A's token)
    // Since 2b-2 the products / orders lists are B's own (empty here), the
    // shared platform catalogue (empty here), and the two creates answer B
    // without touching anything of A's: custom products are off in this
    // env (403), and the platform product does not exist (400).
    const notRefused = {
      'GET /api/auth/verify-admin': [200, { ok: true }], 'PUT /api/admin/projects/:id': [405], 'POST /api/admin/projects/:id': [405],
      'GET /api/admin/projects': [200, { projects: [] }],
      'GET /api/admin/products': [200, { products: [], custom_products_enabled: false }],
      'POST /api/admin/products': [403],
      'GET /api/admin/platform-products': [200, { products: [] }],
      'POST /api/admin/products/from-platform': [400],
      'GET /api/admin/orders': [200, { orders: [] }],
      // 2b-3: B's own settings (none: all null), B's own counts (all zero),
      // B's own logo (a body that is no image: 415; delete: B has none)
      'GET /api/admin/stats': [200], 'GET /api/admin/settings': [200], 'PUT /api/admin/settings': [200],
      'PUT /api/admin/settings/logo': [415], 'DELETE /api/admin/settings/logo': [200, { ok: true, has_logo: false }],
    };
    if (hasOwn(notRefused, label(r))) {
      const [status, body] = notRefused[label(r)];
      assert.equal(res.status, status, label(r));
      if (body) assert.deepEqual(JSON.parse(text), body, `${label(r)}: B sees nothing of anyone else's`);
      if (label(r) === 'GET /api/admin/settings' || label(r) === 'PUT /api/admin/settings') {
        const s = JSON.parse(text);
        assert.equal(s.has_logo, false, `${label(r)}: not A's logo`);
        assert.equal(s.logo_updated_at, null, label(r));
      }
      if (label(r) === 'GET /api/admin/stats') {
        const s = JSON.parse(text);
        assert.deepEqual(s.by_phase, { picking: 0, submitted: 0, retouching: 0 }, 'not A\'s project');
        assert.equal(s.outstanding, 0, 'not A\'s order');
      }
      continue;
    }
    assert.equal(res.status, 404, `${label(r)}: ${res.status} ${text.slice(0, 200)}`);
    refused++;
  }
  assert.equal(refused, ROUTES.length - 14);
});

test('marks: scoped (2b-1 onwards) is requirePhotographer; a leftover 2b-1..3 default-only mark is unknown now', () => {
  assert.equal(markOf("const auth = await requirePhotographer(request, env); // scoped to the caller (who.id)"), 'scoped');
  assert.equal(helperFor('scoped'), 'requirePhotographer');
  assert.equal(markOf('const auth = await requireDefault(request, env); // default-only until 2b-3'), null, '2b-3 is merged');
  assert.equal(markOf('const auth = await requireDefault(request, env); // default-only until batch 3'), 'batch 3');
  assert.equal(helperFor('batch 3'), 'requireDefault');
  assert.equal(markOf('const auth = await requireDefault(request, env); // default-only until 2b-1'), null, '2b-1 is merged');
  assert.equal(markOf('const auth = await requireDefault(request, env); // default-only until 2b-2'), null, '2b-2 is merged');
  assert.equal(markOf('const auth = await requirePhotographer(request, env); // open to every photographer: answers no data'), 'open');
  assert.equal(markOf('const auth = await requireDefault(request, env);'), null, 'an unmarked site');
  assert.equal(markOf('const auth = await requireDefault(request, env); // default-only until later'), null, 'an unknown batch');
});

test('PHOTOGRAPHER_ROUTES=on: the photo_keys order routes stay default-only on their own (batch 3), not only through the block', () => {
  const marks = SRC.match(/\/\/ default-only until batch 3 \(photo_keys\)/g) || [];
  assert.equal(marks.length, 2, 'POST /api/admin/projects/:id/orders and PUT /api/admin/orders/:id');
  for (const m of SRC.matchAll(/^.*\/\/ default-only until batch 3 \(photo_keys\).*$/gm)) {
    assert.match(m[0], /defaultOnly\(auth\.who\)/, m[0]);
  }
});

test('PHOTOGRAPHER_ROUTES=on: the default photographer still gets its data; the same request from B does not', async () => {
  const env = setup(ROUTES_ON);
  const f = await fixture(env);
  const { A, B } = await twoTenants(env);
  const mine = await call(env, '/api/admin/projects', { token: A.token });
  assert.equal(mine.status, 200);
  assert.ok((await mine.text()).includes(f.projectId));
  // scoped since 2b-1: B gets its own list (empty here), never A's rows
  const theirs = await call(env, '/api/admin/projects', { token: B.token });
  assert.equal(theirs.status, 200);
  const text = await theirs.text();
  assert.ok(!text.includes(f.projectId));
  assert.deepEqual(JSON.parse(text).projects, []);
});

test('PHOTOGRAPHER_ROUTES=on: a flagged session (operator reset) is 403 must_change_password on every route', async () => {
  const mod = await worker();
  for (const r of ROUTES) {
    const env = setup(ROUTES_ON);
    const f = await fixture(env);
    const B = await seedPhotographer(env, { mustChange: true });
    const before = snapshot(env);
    const res = await send(mod, env, r, f, B.token);
    assert.equal(res.status, 403, label(r));
    assert.equal((await res.json()).code, 'must_change_password', label(r));
    assert.equal(snapshot(env), before, label(r));
  }
});

test('PHOTOGRAPHER_ROUTES=on, before the must_change migration: a session is 500 password_change_unavailable, never in', async () => {
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
    .replace(/(last_dup_at\s+TEXT),[\s\S]*?\n\s*must_change_password INTEGER NOT NULL DEFAULT 0/, '$1');
  assert.ok(!/must_change_password INTEGER/.test(schema));
  const env = setup({ ...ROUTES_ON, DB: fakeDB({ schema }) });
  const B = await seedPhotographer(env);
  for (const path of ['/api/auth/verify-admin', '/api/admin/projects', '/api/admin/settings']) {
    const res = await call(env, path, { token: B.token });
    assert.equal(res.status, 500, path);
    assert.equal((await res.json()).code, 'password_change_unavailable', path);
  }
  assert.equal((await call(env, '/api/admin/projects', { token: SECRET })).status, 200);
});

test('PHOTOGRAPHER_ROUTES=on: only PHOTOGRAPHER_TOKEN is the default photographer — a session row named "default" is nobody', async () => {
  const env = setup(ROUTES_ON);
  const fake = await seedPhotographer(env, { id: 'default', email: 'squat@example.com' });
  for (const path of ['/api/auth/verify-admin', '/api/admin/projects', '/api/admin/settings', '/?list=20260819/', '/20260819/a.jpg']) {
    const res = await call(env, path, { token: fake.token });
    assert.equal(res.status, 401, path);
  }
});

test('PHOTOGRAPHER_ROUTES=on: suspended, pending and expired sessions are nobody (401)', async () => {
  for (const opts of [{ status: 'suspended' }, { status: 'pending' }, { expiresInMs: -1000 }]) {
    const env = setup(ROUTES_ON);
    const B = await seedPhotographer(env, opts);
    for (const path of ['/api/auth/verify-admin', '/api/admin/projects']) {
      assert.equal((await call(env, path, { token: B.token })).status, 401, `${JSON.stringify(opts)} ${path}`);
    }
  }
});

test('PHOTOGRAPHER_ROUTES=on: a guest share link still reads through the list and object routes', async () => {
  const env = setup(ROUTES_ON);
  const f = await fixture(env);
  const list = await call(env, `/?list=${encodeURIComponent(MINE)}&t=${encodeURIComponent(f.pickToken)}`);
  assert.equal(list.status, 200);
  const obj = await call(env, `/20260819/a.jpg?w=400&t=${encodeURIComponent(f.pickToken)}`);
  assert.equal(obj.status, 200);
});

test('without PHOTOGRAPHER_TOKEN configured nothing is the default photographer (fails closed), switch on or off', async () => {
  for (const flags of [{}, ROUTES_ON]) {
    const env = setup({ PHOTOGRAPHER_TOKEN: undefined, ...flags });
    for (const token of [undefined, '', 'undefined', SECRET]) {
      assert.equal((await call(env, '/api/admin/projects', { token })).status, 401, String(token));
      assert.equal((await call(env, '/api/auth/verify-admin', { token })).status, 401, String(token));
    }
  }
});

test('the switch is one function, and wrangler.toml ships it off', () => {
  const fn = SRC.slice(SRC.indexOf('function photographerRoutesOpen('), SRC.indexOf('\n}\n', SRC.indexOf('function photographerRoutesOpen(')));
  assert.match(fn, /return env\.PHOTOGRAPHER_ROUTES === 'on';/);
  assert.equal(codeCount('photographerRoutesOpen('), 2, 'its definition and identify');
  assert.equal(codeCount('PHOTOGRAPHER_ROUTES'), 1, 'read nowhere else');
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(toml, /^PHOTOGRAPHER_ROUTES = "off"$/m);
});

// ─── identity comes only from the helpers' return value ───────────────────
test('no fallback to the default photographer: no `?? DEFAULT_PHOTOGRAPHER_ID`, `|| DEFAULT_PHOTOGRAPHER_ID`, `who?.`', () => {
  const code = SRC.split('\n').map(l => l.split('//')[0]).join('\n');
  assert.ok(!/(\?\?|\|\|)\s*DEFAULT_PHOTOGRAPHER_ID\b/.test(code), 'a ?? / || fallback to the default photographer');
  assert.ok(!/DEFAULT_PHOTOGRAPHER_ID\s*(\?\?|\|\|)/.test(code), 'the default photographer ahead of a fallback');
  assert.ok(!/\bwho\?\./.test(code) && !/\bwho\s*\?\?/.test(code), 'an optional who: identity is there or the route refused');
  assert.ok(!/\.who\?\./.test(code), 'auth.who?. / session.who?.');
});

test('no route reads a photographer id from the request (body, query or header)', () => {
  const bad = [
    /body\??\.photographer_?[iI]d\b/, /body\[\s*['"]photographer_?id['"]\s*\]/i, /\{[^}]*\bphotographer_id\b[^}]*\}\s*=\s*body\b/,
    /params\.get\(\s*['"][^'"]*photographer/i, /searchParams\.get\(\s*['"][^'"]*photographer/i,
    /headers\.get\(\s*['"][^'"]*photographer/i,
  ];
  for (const re of bad) assert.ok(!re.test(SRC), `worker.js matches ${re}`);
});

// Where DEFAULT_PHOTOGRAPHER_ID may still appear, by enclosing function, with
// exact counts. Batches 2b-1..3 shrink this table (each replaced constant
// becomes who.id); a new use anywhere fails until it is argued for here.
const DEFAULT_ID_USES = {
  '(top level)': 1,          // the definition
  defaultOnly: 1,            // the default-only gate
  identify: 2,               // PHOTOGRAPHER_TOKEN → 'default'; a session named 'default' is refused
  mailsDefaultInbox: 1,      // PHOTOGRAPHER_EMAIL is the default photographer's inbox only (until batch 4)
  guestOrdersEnabled: 1,     // guest ordering: the default photographer's projects only (doc §4)
  routeRequest: 9,           // the routes themselves: batch 3's POST projects / deliver / undeliver, and the public /api/studio/logo (the default's, 2b-3)
};
test('DEFAULT_PHOTOGRAPHER_ID appears only in the allow-listed functions, with exact counts', () => {
  const counts = {};
  for (const m of SRC.matchAll(/\bDEFAULT_PHOTOGRAPHER_ID\b/g)) {
    const lineStart = SRC.lastIndexOf('\n', m.index) + 1;
    if (/^\s*\/\//.test(SRC.slice(lineStart, m.index))) continue;      // prose in a comment
    const name = /^const DEFAULT_PHOTOGRAPHER_ID\b/.test(SRC.slice(lineStart)) ? '(top level)' : enclosingFunction(SRC, m.index);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  assert.deepEqual(counts, DEFAULT_ID_USES);
  // and the literal lives only in the definition
  assert.equal(codeCount("'default'"), 1);
  assert.equal(codeCount('"default"'), 0);
  assert.equal(codeCount('`default`'), 0);
});

test('fixture helpers: twoTenants gives A the default token and B a live session of an active account', async () => {
  const env = setup();
  const { A, B } = await twoTenants(env);
  assert.equal(A.id, 'default');
  assert.equal(A.token, SECRET);
  assert.notEqual(B.id, 'default');
  assert.match(B.token, /^[0-9a-f]{64}$/);
  const [row] = rows(env, 'SELECT status FROM photographers WHERE id = ?', B.id);
  assert.equal(row.status, 'active');
  // the session is real: /me knows it
  const me = await call(env, '/api/photographer/me', { token: B.token });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).photographer.id, B.id);
});
