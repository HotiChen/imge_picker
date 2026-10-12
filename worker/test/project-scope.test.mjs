// Batch 2b-1 of docs/multi-photographer.md: the project routes are scoped to
// the calling photographer (who.id), and nobody is a super-user — the default
// photographer's token (PHOTOGRAPHER_TOKEN) sees photographer_id 'default'
// only, exactly like any session sees its own id only.
//
// For every scoped project route, with two photographers in one database:
// - B on A's project, and A on B's: 404, the same body as for an id that does
//   not exist, the same statements in the same order (no timing shape that
//   tells "someone else's" from "nobody's"), and nothing written anywhere
//   (every D1 table and every R2 object compared);
// - each on its own project: the route's normal answer, and the other
//   photographer's rows untouched by it.
// Also: the list shows each photographer only their own projects, the
// project flows mail PHOTOGRAPHER_EMAIL only for the default photographer's
// projects, and the guest side takes the photographer from the link's
// project, never from the request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  setup, admin, deliver, guest, submitRound, putPins, confirm, reviseText, pin, state,
  PA, PB, F1, FINAL, SECRET, call, pick, claim, save, one, rows,
} from './revision-helpers.mjs';
import { twoTenants, snapshot, ROUTES_ON } from './tenant-helpers.mjs';

const SRC = readFileSync(new URL('../worker.js', import.meta.url), 'utf8');
const NOPE = '00000000-0000-4000-8000-000000000000';   // a project id nobody has

// ─── fixtures ─────────────────────────────────────────────────────────────
// A project in `stage`, made through the real routes by the default
// photographer and then handed to `owner` (B cannot create a project yet: the
// folders are R2 paths, default-only until batch 3). The extra-pick plan
// (limit 1, NT$200, two picks) gives start-retouch a fee, so its order writes
// (extraPickWrites) run too.
const STAGES = ['fresh', 'claimed', 'submitted', 'retouching', 'delivered', 'archived'];
async function build(env, owner, stage, title) {
  const res = await call(env, '/api/admin/projects', {
    method: 'POST', token: SECRET,
    body: { title, folders: ['shoot/毛片/'], pick_limit: 1, extra_price: 200, extra_max: null },
  });
  assert.equal(res.status, 201, await res.clone().text());
  const created = await res.json();
  const p = { id: created.project.id, token: created.token, owner };
  const at = STAGES.indexOf(stage);
  if (stage === 'archived') {
    assert.equal((await admin(env, p.id, 'archive')).status, 200);
  } else if (at >= 1) {
    const c = await claim(env, p.token);
    p.key = c.key;
    if (at >= 2) {
      assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: PA, rating: 1, marks: [pin(0.2, 0.2, '臉')] }, { photo_key: PB, rating: 1 }] })).status, 200);
      assert.equal((await guest(env, 'POST', 'submit', p.token, p.key, { relationship: '本人' })).status, 200);
    }
    if (at >= 3) assert.equal((await admin(env, p.id, 'start-retouch')).status, 200);
    if (at >= 4) {
      assert.equal((await deliver(env, p.id)).status, 200);
      // an open 要求修改, for confirm to resolve
      assert.equal((await reviseText(env, p.token, p.key, '再亮一點')).status, 200);
    }
  }
  env.DB._db.prepare('UPDATE projects SET photographer_id = ? WHERE id = ?').run(owner.id, p.id);
  env.DB._db.prepare('UPDATE orders SET photographer_id = ? WHERE project_id = ?').run(owner.id, p.id);
  return p;
}

// one database, A's project and B's, both in `stage`
async function world(stage) {
  const env = setup({ extra: ROUTES_ON });
  const { A, B } = await twoTenants(env);
  const a = await build(env, A, stage, '甲 王先生 婚紗');
  const b = await build(env, B, stage, '乙 林小姐 婚紗');
  env.NOTIFY_EMAIL.sent.length = 0;
  return { env, A, B, a, b };
}

// every row that belongs to one project, across every table that hangs off it
const PROJECT_TABLES = ['pickers', 'selections', 'submissions', 'share_tokens', 'revision_requests', 'revision_pins',
  'product_interests', 'project_collaborators', 'pick_invites', 'pick_join_failures', 'project_members', 'orders'];
function projectRows(env, id) {
  const out = { projects: rows(env, 'SELECT * FROM projects WHERE id = ?', id) };
  for (const t of PROJECT_TABLES) out[t] = rows(env, `SELECT * FROM ${t} WHERE project_id = ? ORDER BY rowid`, id);
  out.order_items = rows(env, 'SELECT i.* FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.project_id = ? ORDER BY i.rowid', id);
  return JSON.stringify(out);
}

const send = (env, route, id, token) => call(env, route.path(id), {
  method: route.method, token, body: route.body,
});

// ─── the scoped routes, each with the stage its owner gets a normal answer in
const P = id => `/api/admin/projects/${id}`;
const SCOPED = [
  { name: 'GET :id', method: 'GET', path: P, stage: 'delivered', ok: 200 },
  { name: 'PATCH :id (title: rename + links)', method: 'PATCH', path: P, body: { title: '改名' }, stage: 'fresh', ok: 200 },
  { name: 'PATCH :id (plan)', method: 'PATCH', path: P, body: { pick_limit: 5, extra_max: 3 }, stage: 'fresh', ok: 200 },
  { name: 'PATCH :id (plan, archived: 409)', method: 'PATCH', path: P, body: { pick_limit: 5 }, stage: 'archived', ok: 409 },
  { name: 'DELETE :id', method: 'DELETE', path: P, stage: 'fresh', ok: 200 },
  { name: 'DELETE :id (submitted: 409)', method: 'DELETE', path: P, stage: 'submitted', ok: 409 },
  { name: 'reset-seat', method: 'POST', path: id => `${P(id)}/reset-seat`, stage: 'claimed', ok: 200 },
  { name: 'start-retouch (new system order)', method: 'POST', path: id => `${P(id)}/start-retouch`, stage: 'submitted', ok: 200 },
  { name: 'start-retouch (rewrites the system order)', method: 'POST', path: id => `${P(id)}/start-retouch`, stage: 'retouching', ok: 200 },
  { name: 'start-retouch (picking: 409)', method: 'POST', path: id => `${P(id)}/start-retouch`, stage: 'claimed', ok: 409 },
  { name: 'reopen', method: 'POST', path: id => `${P(id)}/reopen`, stage: 'delivered', ok: 200 },
  { name: 'archive', method: 'POST', path: id => `${P(id)}/archive`, stage: 'claimed', ok: 200 },
  { name: 'unarchive', method: 'POST', path: id => `${P(id)}/unarchive`, stage: 'archived', ok: 200 },
  { name: 'links', method: 'POST', path: id => `${P(id)}/links`, stage: 'fresh', ok: 201 },
  { name: 'links (archived: 409)', method: 'POST', path: id => `${P(id)}/links`, stage: 'archived', ok: 409 },
  { name: 'confirm', method: 'POST', path: id => `${P(id)}/confirm`, stage: 'delivered', ok: 200 },
  { name: 'confirm (not delivered: 409)', method: 'POST', path: id => `${P(id)}/confirm`, stage: 'retouching', ok: 409 },
];

for (const route of SCOPED) {
  for (const [who, victim] of [['B', 'a'], ['A', 'b']]) {
    test(`${route.name}: ${who} on the other photographer's project is a nonexistent one — 404, same body, same statements, nothing written`, async () => {
      const w = await world(route.stage);
      const caller = w[who];
      const target = w[victim];
      const before = snapshot(w.env);
      const mark = w.env.DB._sql.length;
      const res = await send(w.env, route, target.id, caller.token);
      const text = await res.text();
      const statements = w.env.DB._sql.slice(mark);
      assert.equal(res.status, 404, `${res.status} ${text}`);
      assert.equal(snapshot(w.env), before, 'something was written');
      assert.equal(w.env.NOTIFY_EMAIL.sent.length, 0);
      // the same request for an id nobody has
      const mark2 = w.env.DB._sql.length;
      const none = await send(w.env, route, NOPE, caller.token);
      assert.equal(none.status, 404);
      assert.equal(text, await none.text(), 'the body tells someone else\'s project from no project');
      assert.deepEqual(statements, w.env.DB._sql.slice(mark2), 'the statements tell someone else\'s project from no project');
      assert.equal(snapshot(w.env), before);
      // and nothing of the target's in the answer
      for (const leak of [target.id, '王先生', '林小姐', 'shoot/']) assert.ok(!text.includes(leak), `leaked ${leak}`);
    });
  }

  test(`${route.name}: each photographer on its own project gets the normal answer and leaves the other's rows alone`, async () => {
    const w = await world(route.stage);
    for (const [mine, other] of [[w.b, w.a], [w.a, w.b]]) {
      const theirs = projectRows(w.env, other.id);
      const res = await send(w.env, route, mine.id, mine.owner.token);
      const text = await res.text();
      assert.equal(res.status, route.ok, `${mine.owner.id}: ${res.status} ${text}`);
      assert.equal(projectRows(w.env, other.id), theirs, `${mine.owner.id} changed the other photographer's rows`);
      assert.ok(!text.includes(other.id), `${mine.owner.id} saw the other project`);
    }
  });
}

// what the owner's own writes actually did, for the routes whose writes reach
// sub-tables (so a scoped route that silently does nothing would fail here)
test('B on its own project: the writes land on B\'s rows (start-retouch order, links, archive revoke, confirm resolve, delete)', async () => {
  let w = await world('submitted');
  assert.equal((await send(w.env, SCOPED[7], w.b.id, w.B.token)).status, 200);
  assert.equal(one(w.env, 'SELECT phase FROM projects WHERE id = ?', w.b.id).phase, 'retouching');
  const [order] = rows(w.env, "SELECT * FROM orders WHERE project_id = ? AND source = 'system'", w.b.id);
  assert.equal(order.photographer_id, w.B.id, 'the extra-pick order is B\'s');
  assert.equal(one(w.env, "SELECT qty FROM order_items WHERE order_id = ? AND kind = 'extra_pick'", order.id).qty, 1);
  assert.equal(rows(w.env, 'SELECT * FROM orders WHERE project_id = ?', w.a.id).length, 0, 'A\'s project got no order');

  w = await world('retouching');
  // the plan changed under B's system order: the rewrite path, on B's order only
  w.env.DB._db.prepare('UPDATE submissions SET extra_price = 300 WHERE project_id = ?').run(w.b.id);
  w.env.DB._db.prepare('UPDATE submissions SET extra_price = 300 WHERE project_id = ?').run(w.a.id);
  assert.equal((await send(w.env, SCOPED[8], w.b.id, w.B.token)).status, 200);
  const price = id => one(w.env, "SELECT i.unit_price FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.project_id = ? AND i.kind = 'extra_pick'", id).unit_price;
  assert.equal(price(w.b.id), 300);
  assert.equal(price(w.a.id), 200, 'A\'s order untouched');

  w = await world('fresh');
  const minted = await (await send(w.env, SCOPED[13], w.b.id, w.B.token)).json();
  assert.equal(one(w.env, 'SELECT project_id FROM share_tokens WHERE token = ?', minted.token).project_id, w.b.id);
  assert.equal((await pick(w.env, 'GET', 'state', minted.token)).status, 200, 'B\'s new link works');

  w = await world('claimed');
  const archived = await (await send(w.env, SCOPED[11], w.b.id, w.B.token)).json();
  assert.equal(archived.revoked, 1);
  assert.equal(rows(w.env, "SELECT * FROM share_tokens WHERE project_id = ? AND revoked_at IS NULL", w.a.id).length, 1, 'A\'s link still live');

  w = await world('delivered');
  assert.equal((await send(w.env, SCOPED[15], w.b.id, w.B.token)).status, 200);
  assert.equal(one(w.env, 'SELECT client_confirmed_by FROM projects WHERE id = ?', w.b.id).client_confirmed_by, 'photographer');
  assert.equal(one(w.env, 'SELECT COUNT(*) AS n FROM revision_requests WHERE project_id = ? AND resolved_at IS NULL', w.b.id).n, 0);
  assert.equal(one(w.env, 'SELECT COUNT(*) AS n FROM revision_requests WHERE project_id = ? AND resolved_at IS NULL', w.a.id).n, 1, 'A\'s request still open');
  assert.equal(one(w.env, 'SELECT client_confirmed_at FROM projects WHERE id = ?', w.a.id).client_confirmed_at, null);

  w = await world('fresh');
  assert.equal((await send(w.env, SCOPED[4], w.b.id, w.B.token)).status, 200);
  assert.equal(rows(w.env, 'SELECT * FROM projects WHERE id = ?', w.b.id).length, 0);
  assert.equal(rows(w.env, 'SELECT * FROM share_tokens WHERE project_id = ?', w.b.id).length, 0);
  assert.equal(rows(w.env, 'SELECT * FROM projects WHERE id = ?', w.a.id).length, 1);
  assert.equal(rows(w.env, 'SELECT * FROM share_tokens WHERE project_id = ?', w.a.id).length, 1);
});

test('GET :id: each photographer reads its own project in full (pickers, selections, submissions, links, requests)', async () => {
  const w = await world('delivered');
  for (const [mine, other] of [[w.b, w.a], [w.a, w.b]]) {
    const res = await call(w.env, P(mine.id), { token: mine.owner.token });
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.project.id, mine.id);
    assert.equal(d.project.photographer_id, mine.owner.id);
    assert.equal(d.pickers.length, 1);
    assert.equal(d.selections.length, 2);
    assert.equal(d.submissions.length, 1);
    assert.equal(d.tokens.length, 1);
    assert.equal(d.revision_requests.length, 1);
    assert.ok(!JSON.stringify(d).includes(other.id));
  }
});

// ─── the list ─────────────────────────────────────────────────────────────
test('GET /api/admin/projects: each photographer lists its own projects only, archived or not', async () => {
  const w = await world('claimed');
  const arcA = await build(w.env, w.A, 'archived', '甲 封存');
  const arcB = await build(w.env, w.B, 'archived', '乙 封存');
  for (const [who, mine, mineArchived, theirs] of [[w.A, w.a, arcA, [w.b, arcB]], [w.B, w.b, arcB, [w.a, arcA]]]) {
    const live = await (await call(w.env, '/api/admin/projects', { token: who.token })).json();
    assert.deepEqual(live.projects.map(p => p.id), [mine.id], who.id);
    assert.equal(live.projects[0].owner_name, '王小明');
    assert.ok(live.projects[0].token, 'the live link is listed');
    const old = await (await call(w.env, '/api/admin/projects?archived=1', { token: who.token })).json();
    assert.deepEqual(old.projects.map(p => p.id), [mineArchived.id], who.id);
    const text = JSON.stringify([live, old]);
    for (const t of theirs) assert.ok(!text.includes(t.id));
  }
});

test('GET /api/admin/projects: a photographer with no projects gets an empty list, and the default token is no super-user', async () => {
  const w = await world('fresh');
  w.env.DB._db.prepare("UPDATE projects SET photographer_id = 'someone-else'").run();
  for (const who of [w.A, w.B]) {
    const res = await call(w.env, '/api/admin/projects', { token: who.token });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).projects, []);
  }
});

// ─── the 405s: open to every photographer, the same for any id, D1 not asked
test('PUT / POST /api/admin/projects/:id: 405 for every photographer, whoever owns the id (no D1 read, nothing written)', async () => {
  const w = await world('fresh');
  for (const method of ['PUT', 'POST']) {
    for (const who of [w.A, w.B]) {
      for (const id of [w.a.id, w.b.id, NOPE]) {
        const before = snapshot(w.env);
        const mark = w.env.DB._sql.length;
        const res = await call(w.env, P(id), { method, token: who.token, body: {} });
        assert.equal(res.status, 405, `${method} ${who.id} ${id}`);
        assert.deepEqual(await res.json(), { error: 'Method not allowed' });
        assert.deepEqual(w.env.DB._sql.slice(mark).filter(s => /projects/.test(s)), [], 'no project lookup');
        assert.equal(snapshot(w.env), before);
      }
    }
  }
});

// ─── still default-only (batch 3): they touch R2 folders ──────────────────
test('still default-only until batch 3: B cannot create a project, deliver or undeliver — even its own', async () => {
  const w = await world('retouching');
  const before = snapshot(w.env);
  const created = await call(w.env, '/api/admin/projects', { method: 'POST', token: w.B.token, body: { title: 'x', folders: ['shoot/毛片/'] } });
  assert.equal(created.status, 404);
  assert.equal((await deliver2(w.env, w.b.id, w.B.token)).status, 404);
  assert.equal((await admin(w.env, w.b.id, 'undeliver', undefined, w.B.token)).status, 404);
  assert.equal(snapshot(w.env), before);
  // and the default token cannot deliver B's project either
  assert.equal((await deliver2(w.env, w.b.id, SECRET)).status, 404);
  assert.equal(snapshot(w.env), before);
});
const deliver2 = (env, id, token) => admin(env, id, 'deliver', { final_folders: [FINAL] }, token);

// ─── notifications: PHOTOGRAPHER_EMAIL is the default photographer's inbox ─
// Until per-studio notify_email (batch 4), another photographer's project
// mails nobody: no guest name, file name, note or order of theirs reaches
// Tim's inbox. Every flow, both ways (A's still mails: the positive control).
async function mailFlows(owner) {
  const env = setup({ extra: { ...ROUTES_ON, GUEST_ORDERS: 'on', OPERATOR_TOKEN: 'operator-secret' } });
  const { A, B } = await twoTenants(env);
  const who = owner === 'A' ? A : B;
  const sent = {};
  const count = async (name, fn) => { env.NOTIFY_EMAIL.sent.length = 0; await fn(); sent[name] = env.NOTIFY_EMAIL.sent.length; };

  // the pick submit
  const s = await build(env, A, 'claimed', '送出案');
  env.DB._db.prepare('UPDATE projects SET photographer_id = ? WHERE id = ?').run(who.id, s.id);
  assert.equal((await save(env, s.token, s.key, { upsert: [{ photo_key: PA, rating: 1 }] })).status, 200);
  await count('submit', async () => assert.equal((await guest(env, 'POST', 'submit', s.token, s.key, { relationship: '本人' })).status, 200));

  // the guest's 要求修改 (text), the pins round, the confirmation
  const d = await build(env, A, 'retouching', '交件案');
  assert.equal((await deliver(env, d.id)).status, 200);
  env.DB._db.prepare('UPDATE projects SET photographer_id = ? WHERE id = ?').run(who.id, d.id);
  await count('revision', async () => assert.equal((await reviseText(env, d.token, d.key, '再亮一點')).status, 200));
  const d2 = await build(env, A, 'retouching', '輪次案');
  assert.equal((await deliver(env, d2.id)).status, 200);
  env.DB._db.prepare('UPDATE projects SET photographer_id = ? WHERE id = ?').run(who.id, d2.id);
  assert.equal((await putPins(env, d2.token, d2.key, [{ photo_key: F1, marks: [pin(0.5, 0.5, '去掉路人')] }])).status, 200);
  await count('round', async () => {
    const r = await submitRound(env, d2.token, d2.key, { note: '整體再亮', expect: [{ k: F1, n: 1 }] });
    assert.equal(r.status, 200, await r.clone().text());
  });
  const d3 = await build(env, A, 'retouching', '確認案');
  assert.equal((await deliver(env, d3.id)).status, 200);
  env.DB._db.prepare('UPDATE projects SET photographer_id = ? WHERE id = ?').run(who.id, d3.id);
  await count('confirm', async () => assert.equal((await confirm(env, d3.token, d3.key)).status, 200));

  // 我有興趣 and a guest order, on a product of the project's photographer
  const pp = await (await call(env, '/api/operator/products', {
    method: 'POST', token: 'operator-secret',
    body: { kind: 'print', name: '無框畫', options: [{ label: '16×20', vendor_cost: 900, platform_price: 2000 }] },
  })).json();
  const adopted = await call(env, '/api/admin/products/from-platform', {
    method: 'POST', token: SECRET,
    body: { platform_product_id: pp.product.id, options: pp.product.options.map(o => ({ platform_option_id: o.id, price: 3000 })), guest_visible: true },
  });
  assert.equal(adopted.status, 201, await adopted.clone().text());
  const product = (await adopted.json()).product;
  env.DB._db.prepare('UPDATE products SET photographer_id = ? WHERE id = ?').run(who.id, product.id);
  await count('interest', async () => {
    const r = await guest(env, 'POST', 'interest', d3.token, d3.key, { product_id: product.id });
    assert.equal(r.status, 200, await r.clone().text());
  });
  await count('order', async () => {
    const r = await guest(env, 'POST', 'orders', d3.token, d3.key, {
      request_id: crypto.randomUUID(), lines: [{ option_id: product.options[0].id, qty: 1, photo_key: F1 }],
      contact: { name: '王小明', phone: '0912-345-678' }, delivery: { method: 'pickup' }, note: '', expected_total: 3000, consent: 'v1',
    });
    // since 2b-2 another photographer's project takes no guest order at all
    // (docs/multi-photographer.md §4), GUEST_ORDERS=on or not: nothing to mail
    assert.equal(r.status, owner === 'A' ? 201 : 403, await r.clone().text());
  });
  return sent;
}

test('notifications: every project flow mails PHOTOGRAPHER_EMAIL for the default photographer\'s project (positive control)', async () => {
  const sent = await mailFlows('A');
  assert.deepEqual(sent, { submit: 1, revision: 1, round: 1, confirm: 1, interest: 1, order: 1 });
});

test('notifications: another photographer\'s project mails nobody — submit, 要求修改, pins round, confirm, 我有興趣, guest order', async () => {
  const sent = await mailFlows('B');
  assert.deepEqual(sent, { submit: 0, revision: 0, round: 0, confirm: 0, interest: 0, order: 0 });
});

test('notifications: every sender asks the one inbox gate first (a new sender without it fails here)', () => {
  const senders = [...SRC.matchAll(/^async function (send\w*Notification)\(env, project\b[^)]*\) \{\n(.*)\n/gm)];
  assert.equal(senders.length, 5, senders.map(m => m[1]).join(', '));
  for (const [, name, first] of senders) assert.match(first, /^\s*if \(!mailsDefaultInbox\(project\)\) return false;/, name);
  // and nothing else mails PHOTOGRAPHER_EMAIL
  const code = SRC.split('\n').map(l => l.split('//')[0]).join('\n');
  assert.equal((code.match(/to: env\.PHOTOGRAPHER_EMAIL/g) || []).length, 5);
});

// ─── the guest side: the photographer is the link's project's ─────────────
test('guest side: the studio a link shows is its project\'s photographer\'s, whatever the request claims', async () => {
  const w = await world('claimed');
  const now = new Date().toISOString();
  for (const [id, name] of [[w.A.id, '甲工作室'], [w.B.id, '乙工作室']]) {
    w.env.DB._db.prepare('INSERT INTO studio_settings (photographer_id, studio_name, updated_at) VALUES (?, ?, ?)').run(id, name, now);
  }
  for (const [p, name] of [[w.a, '甲工作室'], [w.b, '乙工作室']]) {
    for (const forged of ['', `&photographer_id=${encodeURIComponent(p === w.a ? w.B.id : w.A.id)}`, `&photographer=${encodeURIComponent(w.A.id)}`]) {
      const res = await call(w.env, `/api/pick/state?t=${encodeURIComponent(p.token)}${forged}`, {
        key: p.key, headers: { 'X-Photographer-Id': p === w.a ? w.B.id : w.A.id },
      });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).studio.name, name, forged);
    }
  }
  // and the state of each still reads (sanity: the guest helpers work on B's project)
  assert.equal((await state(w.env, w.b.token, w.b.key)).project.id, w.b.id);
});

test('guest side: no /api/pick route reads a photographer id from the request; every owner it uses is project.photographer_id', () => {
  // the guest routes live in the /api/pick block of routeRequest
  const start = SRC.indexOf("pathParts[1] === 'pick'");
  assert.ok(start > 0, 'the /api/pick block');
  const code = SRC.split('\n').map(l => l.split('//')[0]).join('\n');
  for (const re of [/\[\s*['"`]photographer_?id['"`]\s*\]/i, /\.get\(\s*['"][^'"]*photographer/i, /body\??\.photographer/i]) {
    assert.ok(!re.test(code), `worker.js matches ${re}`);
  }
  // every photographer id a guest path hands on is the project's
  const uses = [...code.matchAll(/photographerId:\s*([\w.]+)/g)].map(m => m[1]);
  for (const u of uses) assert.ok(['owner', 'project.photographer_id', 'who.id', 'auth.who.id'].includes(u), u);
});

// ─── the source: no 2b-1 route is default-only any more ───────────────────
test('source: no `default-only until 2b-1` mark is left, and every project route asks requirePhotographer', () => {
  assert.equal((SRC.match(/default-only until 2b-1\b/g) || []).length, 0);
  const scoped = SRC.match(/requirePhotographer\(request, env\); \/\/ scoped to the caller/g) || [];
  assert.equal(scoped.length, 9 + 1 + 3, 'list, detail, reset-seat, start-retouch/reopen, archive/unarchive, delete, links, confirm, patch; (2b-2) the products / orders block; (2b-3) stats, settings, settings/logo');
  const open405 = SRC.match(/requirePhotographer\(request, env\); \/\/ open to every photographer: a 405/g) || [];
  assert.equal(open405.length, 1);
});

// ─── a malformed body: refused before the lookup, the same for any id ─────
test('PATCH :id with a bad body: B gets the same 400 for A\'s project as for an id nobody has, and nothing is written', async () => {
  const w = await world('fresh');
  const before = snapshot(w.env);
  for (const body of [{}, { title: '' }, { photographer_id: w.B.id }, { pick_limit: -1 }]) {
    const mine = await call(w.env, P(w.a.id), { method: 'PATCH', token: w.B.token, body });
    const none = await call(w.env, P(NOPE), { method: 'PATCH', token: w.B.token, body });
    assert.equal(mine.status, 400, JSON.stringify(body));
    assert.equal(await mine.text(), await none.text());
  }
  assert.equal(snapshot(w.env), before);
});

// ─── the writes re-check the owner inside the statement ───────────────────
// The project is handed to the other photographer (or deleted) between the
// route's read and its write: the write must not land. (No route reassigns a
// project today; the in-statement gate is what keeps a future one, or a
// delete, from racing a write onto a project that is no longer the caller's.)
function beforeStatement(env, re, fn) {
  const prepare = env.DB.prepare.bind(env.DB);
  let done = false;
  env.DB.prepare = sql => {
    if (!done && re.test(sql)) { done = true; fn(); }
    return prepare(sql);
  };
}

test('links: a project reassigned between the read and the INSERT gets no link', async () => {
  const w = await world('fresh');
  const links = () => rows(w.env, 'SELECT token FROM share_tokens WHERE project_id = ?', w.b.id).length;
  const had = links();
  beforeStatement(w.env, /^INSERT INTO share_tokens/, () => w.env.DB._db.prepare('UPDATE projects SET photographer_id = ? WHERE id = ?').run(w.A.id, w.b.id));
  const res = await call(w.env, `${P(w.b.id)}/links`, { method: 'POST', token: w.B.token });
  assert.notEqual(res.status, 201);
  assert.equal(links(), had, 'a link was minted on a project that is no longer B\'s');
});

test('confirm: a project reassigned before the batch is neither confirmed nor has its requests resolved', async () => {
  const w = await world('delivered');
  beforeStatement(w.env, /^UPDATE projects SET client_confirmed_at/, () => w.env.DB._db.prepare('UPDATE projects SET photographer_id = ? WHERE id = ?').run(w.A.id, w.b.id));
  const res = await call(w.env, `${P(w.b.id)}/confirm`, { method: 'POST', token: w.B.token });
  assert.equal(res.status, 404);
  assert.equal(one(w.env, 'SELECT client_confirmed_at FROM projects WHERE id = ?', w.b.id).client_confirmed_at, null);
  assert.equal(one(w.env, 'SELECT COUNT(*) AS n FROM revision_requests WHERE project_id = ? AND resolved_at IS NULL', w.b.id).n, 1);
});

test('confirm: the resolve statement re-checks the owner itself (a project confirmed under someone else keeps its requests)', async () => {
  // the photographer UPDATE is the first statement; make it land anyway (as
  // if the project were confirmed by its guest a moment before), then hand
  // the project over: only the owner gate inside the resolve stops it
  const w = await world('delivered');
  beforeStatement(w.env, /^UPDATE revision_requests SET resolved_at/, () => {
    w.env.DB._db.prepare("UPDATE projects SET client_confirmed_at = '2026-01-01T00:00:00.000Z', photographer_id = ? WHERE id = ?").run(w.A.id, w.b.id);
  });
  await call(w.env, `${P(w.b.id)}/confirm`, { method: 'POST', token: w.B.token });
  assert.equal(one(w.env, 'SELECT COUNT(*) AS n FROM revision_requests WHERE project_id = ? AND resolved_at IS NULL', w.b.id).n, 1);
});

test('start-retouch: a project reassigned before the batch neither moves nor gets an order', async () => {
  const w = await world('submitted');
  beforeStatement(w.env, /^UPDATE projects SET phase = 'retouching'/, () => w.env.DB._db.prepare('UPDATE projects SET photographer_id = ? WHERE id = ?').run(w.A.id, w.b.id));
  const res = await call(w.env, `${P(w.b.id)}/start-retouch`, { method: 'POST', token: w.B.token });
  assert.equal(res.status, 404);
  assert.equal(one(w.env, 'SELECT phase FROM projects WHERE id = ?', w.b.id).phase, 'submitted');
  assert.equal(rows(w.env, 'SELECT * FROM orders WHERE project_id = ?', w.b.id).length, 0);
  assert.equal(rows(w.env, 'SELECT * FROM order_items').length, 0);
});

test('start-retouch: the system order is looked up as the caller\'s — another photographer\'s order on the project is not rewritten', async () => {
  // a system order on B's project that is not B's (data that should never
  // exist): extraPickWrites looks the order up by owner, so it is not touched
  const w = await world('retouching');
  w.env.DB._db.prepare('UPDATE orders SET photographer_id = ? WHERE project_id = ?').run(w.A.id, w.b.id);
  const before = JSON.stringify(rows(w.env, 'SELECT * FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.project_id = ?', w.b.id));
  w.env.DB._db.prepare('UPDATE submissions SET extra_price = 300 WHERE project_id = ?').run(w.b.id);
  assert.equal((await call(w.env, `${P(w.b.id)}/start-retouch`, { method: 'POST', token: w.B.token })).status, 200);
  assert.equal(JSON.stringify(rows(w.env, 'SELECT * FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.project_id = ?', w.b.id)), before);
});

// ─── behaviour behind the owner binds a static count alone used to catch ──
test('guest confirm on another photographer\'s project resolves its open 要求修改 (the resolve is bound to the project\'s owner)', async () => {
  const w = await world('delivered');
  for (const p of [w.b, w.a]) {
    const open = () => one(w.env, 'SELECT COUNT(*) AS n FROM revision_requests WHERE project_id = ? AND resolved_at IS NULL', p.id).n;
    assert.equal(open(), 1, 'the fixture has an open request');
    const res = await confirm(w.env, p.token, p.key);
    assert.equal(res.status, 200, await res.clone().text());
    assert.ok(one(w.env, 'SELECT client_confirmed_at FROM projects WHERE id = ?', p.id).client_confirmed_at);
    assert.equal(open(), 0, `${p.owner.id}: confirmed with an open request`);
  }
});

test('PATCH :id title on B\'s own project renames B\'s link label too, and not A\'s', async () => {
  const w = await world('fresh');
  const label = id => one(w.env, "SELECT label FROM share_tokens WHERE kind = 'pick' AND project_id = ?", id).label;
  const aLabel = label(w.a.id);
  const res = await call(w.env, P(w.b.id), { method: 'PATCH', token: w.B.token, body: { title: '乙 新名字' } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(one(w.env, 'SELECT title FROM projects WHERE id = ?', w.b.id).title, '乙 新名字');
  assert.equal(label(w.b.id), '乙 新名字');
  assert.equal(label(w.a.id), aLabel);
});

// ─── POST /api/shares/:token/revoke: a pick link only of the caller's own ─
// Still default-only (batch 3), so today the caller is the default
// photographer: a pick link of another photographer's project is a token
// that does not exist (404, the same body, nothing written).
test('shares revoke: the default token cannot revoke another photographer\'s pick link (404 like an unknown token); its own still revokes', async () => {
  const w = await world('fresh');
  const before = snapshot(w.env);
  const res = await call(w.env, `/api/shares/${encodeURIComponent(w.b.token)}/revoke`, { method: 'POST', token: SECRET });
  const text = await res.text();
  assert.equal(res.status, 404);
  assert.equal(snapshot(w.env), before, 'B\'s link was revoked');
  const none = await call(w.env, '/api/shares/no-such-token/revoke', { method: 'POST', token: SECRET });
  assert.equal(none.status, 404);
  assert.equal(text, await none.text());
  // B itself is refused (default-only until batch 3), even on its own link
  assert.equal((await call(w.env, `/api/shares/${encodeURIComponent(w.b.token)}/revoke`, { method: 'POST', token: w.B.token })).status, 404);
  assert.equal(snapshot(w.env), before);
  assert.equal((await pick(w.env, 'GET', 'state', w.b.token)).status, 200, 'B\'s link still works');
  // positive control: the default photographer's own pick link, and a link with no project (a book link)
  assert.equal((await call(w.env, `/api/shares/${encodeURIComponent(w.a.token)}/revoke`, { method: 'POST', token: SECRET })).status, 200);
  assert.ok(one(w.env, 'SELECT revoked_at FROM share_tokens WHERE token = ?', w.a.token).revoked_at);
  w.env.DB._db.prepare("INSERT INTO share_tokens (token, book_id, label, kind, project_id, folders, created_at, expires_at) VALUES ('BOOKLINK', 'b1', '', 'client', NULL, '[]', ?, ?)")
    .run(new Date().toISOString(), new Date(Date.now() + 86400000).toISOString());
  assert.equal((await call(w.env, '/api/shares/BOOKLINK/revoke', { method: 'POST', token: SECRET })).status, 200);
});
