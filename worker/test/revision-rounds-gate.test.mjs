// Revision history and its thumbnail route (docs/revision-pins.md §4.4,
// §4.5): GET /api/pick/rounds, /rounds/:id and /rounds/:id/photo?i=&w=. The
// photo route is the one guest read outside pickFinals: a 400/1200 thumbnail
// of the key at index i of one of this project's frozen snapshots, to the
// seat owner only, only while delivered, never an original, never a key from
// the request. Every abuse case uses the seat owner's key unless it tests the
// seat, so an earlier 403 cannot make it pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withT } from './pick-helpers.mjs';
import {
  FINAL, FINAL2, PROOF, PA, PB, F1, F2, F3, G1,
  setup, admin, deliver, code, state, guest, putPins, submitRound, confirm, reviseText,
  rounds, round, photo, pin, retouching, delivered, withRound, roundRows, projectRow,
  SECRET, call, pick, claim, save, one, rows,
} from './revision-helpers.mjs';

const body = async res => res.text();
const t400 = (env, p, id, i = 0) => photo(env, p.token, p.key, id, `i=${i}&w=400`);

// ─── the list ────────────────────────────────────────────────────────────────

test('rounds list: newest first — pins, text and the latest submission as `selection`; open, photo_count, has_note; no keys, no finals', async () => {
  const env = setup();
  const p = await withRound(env);
  let res = await rounds(env, p.token, p.key);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  let out = await res.json();
  assert.deepEqual(out.rounds.map(r => [r.id === p.roundId ? 'R1' : r.id, r.kind, r.open, r.photo_count, r.has_note]), [
    ['R1', 'pins', true, 2, true],
    ['selection', 'selection', false, 2, false],
  ]);
  assert.ok(out.rounds.every(r => typeof r.created_at === 'string'));
  assert.doesNotMatch(JSON.stringify(out), /shoot\//, 'no full key, no finals folder');
  assert.equal((await deliver(env, p.id)).status, 200); // resolves R1
  assert.equal((await reviseText(env, p.token, p.key, '舊式文字')).status, 200);
  out = await (await rounds(env, p.token, p.key)).json();
  assert.deepEqual(out.rounds.map(r => [r.kind, r.open, r.photo_count, r.has_note]), [
    ['text', true, 0, true], ['pins', false, 2, true], ['selection', false, 2, false],
  ]);
  // an auto note is not a note
  assert.equal((await deliver(env, p.id)).status, 200);
  assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin()] }])).status, 200);
  assert.equal((await submitRound(env, p.token, p.key, { expect: [{ k: F1, n: 1 }] })).status, 200);
  out = await (await rounds(env, p.token, p.key)).json();
  assert.deepEqual([out.rounds[0].kind, out.rounds[0].has_note, out.rounds[0].photo_count], ['pins', false, 1]);
});

test('rounds list: at most 51 (50 requests + the selection)', async () => {
  const env = setup();
  const p = await delivered(env);
  const ins = env.DB._db.prepare("INSERT INTO revision_requests (id, project_id, picker_id, message, created_at, resolved_at) VALUES (?, ?, NULL, 'x', ?, 'done')");
  for (let i = 0; i < 60; i++) ins.run(`00000000-0000-0000-0000-0000000000${String(i).padStart(2, '0')}`, p.id, `2027-01-01T00:00:${String(i).padStart(2, '0')}Z`);
  const out = await (await rounds(env, p.token, p.key)).json();
  assert.equal(out.rounds.filter(r => r.kind === 'text').length, 50);
  assert.equal(out.rounds.length, 51);
  assert.equal(out.rounds[0].id, '00000000-0000-0000-0000-000000000059');
});

test('rounds: viewers, wrong keys, other projects\' keys and old keys are 403 (the seat holder 200 first); not delivered 409; dead links 401; confirmed still 200; only GET', async () => {
  const env = setup();
  const p = await withRound(env);
  const q = await delivered(env);
  for (const path of ['rounds', `rounds/${p.roundId}`, 'rounds/selection']) {
    assert.equal((await pick(env, 'GET', path, p.token, { key: p.key })).status, 200, path);
    for (const key of [undefined, 'wrong', q.key]) assert.equal((await pick(env, 'GET', path, p.token, { key })).status, 403, `${path} ${key}`);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await pick(env, method, path, p.token, { key: p.key })).status, 405, `${method} ${path}`);
  }
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
  assert.equal((await rounds(env, p.token, p.key)).status, 200, 'confirmed: the route allows it');
  assert.equal((await admin(env, p.id, 'undeliver')).status, 200);
  let res = await rounds(env, p.token, p.key);
  assert.equal(res.status, 409);
  assert.equal(await code(res), 'not_delivered');
  assert.equal(await code(await round(env, p.token, p.key, p.roundId)), 'not_delivered');
  assert.equal((await deliver(env, p.id)).status, 200);
  assert.equal((await call(env, `/api/admin/projects/${p.id}/reset-seat`, { method: 'POST', token: SECRET })).status, 200);
  assert.equal((await rounds(env, p.token, p.key)).status, 403, 'old key after a seat reset');
  const c = await claim(env, p.token, '新座位');
  assert.equal((await rounds(env, p.token, c.key)).status, 200, 'the new seat holder sees the project\'s rounds');
  assert.equal((await rounds(env, 'nope', c.key)).status, 401);
  assert.equal((await admin(env, p.id, 'archive')).status, 200);
  assert.equal((await rounds(env, p.token, c.key)).status, 401);
});

// ─── one round ───────────────────────────────────────────────────────────────

test('one round: pins → {id, kind, created_at, open, note, photos [{i, name, pins}]}; auto note null; text → its message and no photos', async () => {
  const env = setup();
  const p = await withRound(env);
  let res = await round(env, p.token, p.key, p.roundId);
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(Object.keys(out).sort(), ['created_at', 'id', 'kind', 'note', 'open', 'photos']);
  assert.equal(out.id, p.roundId);
  assert.equal(out.kind, 'pins');
  assert.equal(out.open, true);
  assert.equal(out.note, '整體再亮一點');
  assert.deepEqual(out.photos, [
    { i: 0, name: 'f1.jpg', pins: [{ x: 0.1, y: 0.1, note: '去掉路人' }, { x: 0.9, y: 0.9, note: '' }] },
    { i: 1, name: 'f3.jpg', pins: [{ x: 0.5, y: 0.5, note: '亮一點' }] },
  ]);
  assert.doesNotMatch(JSON.stringify(out), /shoot\//);
  assert.equal((await deliver(env, p.id)).status, 200);
  assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F2, marks: [pin()] }])).status, 200);
  const r2 = await (await submitRound(env, p.token, p.key, { expect: [{ k: F2, n: 1 }] })).json();
  const two = await (await round(env, p.token, p.key, r2.id)).json();
  assert.equal(two.note, null, 'the fixed text is not the guest\'s');
  assert.equal((await deliver(env, p.id)).status, 200);
  assert.equal((await reviseText(env, p.token, p.key, '舊式 文字')).status, 200);
  const textId = roundRows(env).find(r => r.marks === null).id;
  const text = await (await round(env, p.token, p.key, textId)).json();
  assert.deepEqual({ kind: text.kind, note: text.note, photos: text.photos, open: text.open }, { kind: 'text', note: '舊式 文字', photos: [], open: true });
});

test('one round: the selection is the latest submission only — its photos with pins first, each with its index in the sorted keys', async () => {
  const env = setup();
  const p = await retouching(env); // submitted PA (2 pins) and PB
  assert.equal((await admin(env, p.id, 'reopen')).status, 200);
  // the newer submission: PA without pins, PB with one
  assert.equal((await save(env, p.token, p.key, { upsert: [{ photo_key: PA, rating: 1, marks: [] }, { photo_key: PB, rating: 1, marks: [pin(0.7, 0.7, 'b')] }] })).status, 200);
  assert.equal((await guest(env, 'POST', 'submit', p.token, p.key, { relationship: '本人' })).status, 200);
  assert.equal((await admin(env, p.id, 'start-retouch')).status, 200);
  assert.equal((await deliver(env, p.id)).status, 200);
  const out = await (await round(env, p.token, p.key, 'selection')).json();
  assert.equal(out.kind, 'selection');
  assert.equal(out.id, 'selection');
  assert.equal(out.open, false);
  assert.equal(out.note, null);
  assert.deepEqual(out.photos, [
    { i: 1, name: 'b.jpg', pins: [{ x: 0.7, y: 0.7, note: 'b' }] },
    { i: 0, name: 'a.jpg', pins: [] },
  ]);
  assert.equal(await body(await t400(env, p, 'selection', 1)), 'PB-T400');
  assert.equal(await body(await t400(env, p, 'selection', 0)), 'PA-T400');
  // an older submission that picked a photo the latest did not is unreachable
  const env2 = setup();
  const q = await retouching(env2);
  assert.equal((await admin(env2, q.id, 'reopen')).status, 200);
  assert.equal((await save(env2, q.token, q.key, { upsert: [{ photo_key: PB, rating: 0 }] })).status, 200);
  assert.equal((await guest(env2, 'POST', 'submit', q.token, q.key, { relationship: '本人' })).status, 200);
  assert.equal((await admin(env2, q.id, 'start-retouch')).status, 200);
  assert.equal((await deliver(env2, q.id)).status, 200);
  const sel = await (await round(env2, q.token, q.key, 'selection')).json();
  assert.deepEqual(sel.photos.map(x => x.name), ['a.jpg']);
  assert.equal((await t400(env2, q, 'selection', 1)).status, 404);
  assert.equal((await rows(env2, 'SELECT * FROM submissions')).length, 2);
});

test('one round: an unknown id, another project\'s round, a malformed id are 404', async () => {
  const env = setup();
  const p = await withRound(env);
  const q = await withRound(env);
  assert.equal((await round(env, p.token, p.key, q.roundId)).status, 404, 'another project\'s round');
  assert.equal((await round(env, q.token, q.key, p.roundId)).status, 404);
  for (const id of ['00000000-0000-0000-0000-000000000000', 'SELECTION', 'abc', p.roundId.toUpperCase(), `${p.roundId}x`, '%2e%2e', 'selection%00']) {
    const res = await round(env, p.token, p.key, id);
    assert.equal(res.status, 404, id);
  }
  // a project with no submission at all has no selection round
  env.DB._db.prepare('DELETE FROM submissions WHERE project_id = ?').run(p.id);
  assert.equal((await round(env, p.token, p.key, 'selection')).status, 404);
  const list = await (await rounds(env, p.token, p.key)).json();
  assert.ok(!list.rounds.some(r => r.kind === 'selection'));
});

// ─── the thumbnail route ─────────────────────────────────────────────────────

test('photo: the seat holder gets exactly the 400 / 1200 thumbnail — never the original, never cached, never a download, never a range', async () => {
  const env = setup();
  const p = await withRound(env);
  let res = await t400(env, p, p.roundId, 0);
  assert.equal(res.status, 200);
  assert.equal(await body(res), 'F1-T400');
  assert.equal(res.headers.get('Cache-Control'), 'private, no-store');
  assert.match(res.headers.get('Vary'), /X-Share-Token/);
  assert.match(res.headers.get('Vary'), /X-Picker-Key/);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.headers.get('Content-Disposition'), null);
  assert.match(res.headers.get('Content-Type'), /^image\//);
  res = await photo(env, p.token, p.key, p.roundId, 'i=0&w=1200');
  assert.equal(await body(res), 'F1-T1200');
  // a Range header still gets the whole thumbnail
  res = await pick(env, 'GET', `rounds/${p.roundId}/photo?i=0&w=400`, p.token, { key: p.key, headers: { Range: 'bytes=0-1' } });
  assert.equal(res.status, 200);
  assert.equal(await body(res), 'F1-T400');
  // F3 has a 400 but no 1200: 404, not the original, not the 400
  res = await photo(env, p.token, p.key, p.roundId, 'i=1&w=1200');
  assert.equal(res.status, 404);
  assert.equal(await code(res), 'no_thumbnail');
  assert.equal(await t400(env, p, p.roundId, 1).then(body), 'F3-T400');
  // F2 has none at all
  assert.equal((await deliver(env, p.id)).status, 200);
  assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F2, marks: [pin()] }])).status, 200);
  const r2 = await (await submitRound(env, p.token, p.key, { expect: [{ k: F2, n: 1 }] })).json();
  res = await t400(env, p, r2.id, 0);
  assert.equal(res.status, 404);
  assert.doesNotMatch(await body(res), /ORIG/);
});

test('photo: w must be exactly 400 or 1200 (400 invalid_width); any download parameter is 400; i out of range or not a plain index is 404', async () => {
  const env = setup();
  const p = await withRound(env);
  assert.equal((await t400(env, p, p.roundId, 0)).status, 200, 'the fixture works');
  for (const q of ['i=0', 'i=0&w=1600', 'i=0&w=9999', 'i=0&w=0', 'i=0&w=400abc', 'i=0&w=%20400', 'i=0&w=400.0', 'i=0&w=-400',
    'i=0&w=', 'i=0&w=1600&w=400', 'i=0&w=400&w=1600']) {
    const res = await photo(env, p.token, p.key, p.roundId, q);
    assert.equal(res.status, 400, q);
    assert.equal(await code(res), 'invalid_width', q);
  }
  for (const q of ['i=0&w=400&download=1', 'i=0&w=400&download=0', 'i=0&w=400&download=']) {
    assert.equal((await photo(env, p.token, p.key, p.roundId, q)).status, 400, q);
  }
  for (const i of ['-1', '1e3', '99999', '', '2', '0x0', '%200', '1.0', '00000', 'NaN']) {
    const res = await photo(env, p.token, p.key, p.roundId, `i=${i}&w=400`);
    assert.equal(res.status, 404, `i=${i}`);
  }
  assert.equal((await photo(env, p.token, p.key, p.roundId, 'w=400')).status, 404, 'no i');
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    assert.equal((await photo(env, p.token, p.key, p.roundId, 'i=0&w=400', method)).status, 405, method);
  }
});

test('photo: viewers, wrong keys, other projects\' keys, old keys 403; another project\'s round 404; a text round 404', async () => {
  const env = setup();
  const p = await withRound(env);
  const q = await withRound(env);
  assert.equal((await t400(env, p, p.roundId)).status, 200);
  for (const key of [undefined, 'wrong', q.key]) {
    assert.equal((await photo(env, p.token, key, p.roundId, 'i=0&w=400')).status, 403, String(key));
  }
  assert.equal((await photo(env, p.token, p.key, q.roundId, 'i=0&w=400')).status, 404, 'q\'s round through p\'s link');
  assert.equal((await photo(env, q.token, q.key, p.roundId, 'i=0&w=400')).status, 404, 'p\'s round through q\'s link');
  assert.equal((await deliver(env, p.id)).status, 200);
  assert.equal((await reviseText(env, p.token, p.key, '文字')).status, 200);
  const textId = roundRows(env).find(r => r.project_id === p.id && r.marks === null).id;
  assert.equal((await t400(env, p, textId)).status, 404);
  assert.equal((await call(env, `/api/admin/projects/${p.id}/reset-seat`, { method: 'POST', token: SECRET })).status, 200);
  assert.equal((await t400(env, p, p.roundId)).status, 403, 'old key after a seat reset');
});

test('photo: after 更換精修 the previous round\'s 精修一 thumbnail is 200 — while the object route still refuses that photo and its thumbnail (401)', async () => {
  const env = setup();
  const p = await withRound(env);
  assert.equal((await deliver(env, p.id, [FINAL2])).status, 200);
  assert.equal(await body(await t400(env, p, p.roundId, 0)), 'F1-T400');
  for (const path of [`/${F1}`, `/${F1}?w=400`, `/_thumbs/400/${F1}.thumb`, `/${F1}?download=1`]) {
    const res = await call(env, withT(path, p.token), { key: p.key });
    assert.equal(res.status, 401, path);
  }
  // the current finals still go through the object route as before
  assert.equal((await call(env, withT(`/${G1}`, p.token))).status, 200);
});

test('photo: undeliver / reopen 409; archived, revoked, expired links 401; confirmed still 200', async () => {
  const env = setup();
  const p = await withRound(env);
  assert.equal((await confirm(env, p.token, p.key)).status, 200);
  assert.equal((await t400(env, p, p.roundId)).status, 200);
  assert.equal((await admin(env, p.id, 'undeliver')).status, 200);
  let res = await t400(env, p, p.roundId);
  assert.equal(res.status, 409);
  assert.equal(await code(res), 'not_delivered');
  assert.equal((await deliver(env, p.id)).status, 200);
  assert.equal((await admin(env, p.id, 'reopen')).status, 200);
  assert.equal(await code(await t400(env, p, p.roundId)), 'not_delivered');
  assert.equal(await code(await t400(env, p, 'selection')), 'not_delivered');
  const env2 = setup();
  const q = await withRound(env2);
  env2.DB._db.prepare('UPDATE share_tokens SET revoked_at = ?').run(new Date().toISOString());
  assert.equal((await t400(env2, q, q.roundId)).status, 401);
  env2.DB._db.prepare('UPDATE share_tokens SET revoked_at = NULL, expires_at = ?').run(new Date(Date.now() - 1).toISOString());
  assert.equal((await t400(env2, q, q.roundId)).status, 401);
  env2.DB._db.prepare('UPDATE share_tokens SET expires_at = ?').run(new Date(Date.now() + 86400000).toISOString());
  assert.equal((await t400(env2, q, q.roundId)).status, 200, 'live again');
  assert.equal((await admin(env2, q.id, 'archive')).status, 200);
  assert.equal((await t400(env2, q, q.roundId)).status, 401);
});

test('photo: hand-edited rows — a `_` key, a `..` key, a key outside the round\'s finals, unreadable marks or finals — are 404 and never serve the object', async () => {
  const cases = [
    [{ '_books/b1.json': [pin()] }, JSON.stringify([FINAL])],
    [{ 'shoot/精修/../../other/x.jpg': [pin()] }, JSON.stringify([FINAL])],
    [{ 'other/x.jpg': [pin()] }, JSON.stringify([FINAL])],
    [{ '_books/b1.json': [pin()] }, JSON.stringify(['_books/'])],
    [{ [F1]: [pin()] }, null],
    [{ [F1]: [pin()] }, 'not json'],
    [{ [F1]: [pin()] }, JSON.stringify(['/'])],
    ['not json', JSON.stringify([FINAL])],
    [{ [F1]: [{ x: 2, y: 0 }] }, JSON.stringify([FINAL])],
  ];
  for (const [marks, finals] of cases) {
    const env = setup();
    const p = await withRound(env);
    env.DB._db.prepare('UPDATE revision_requests SET marks = ?, finals = ?').run(typeof marks === 'string' ? marks : JSON.stringify(marks), finals);
    const res = await t400(env, p, p.roundId, 0);
    assert.equal(res.status, 404, `${JSON.stringify(marks)} ${finals}`);
    assert.doesNotMatch(await body(res), /BOOK|OTHER|ORIG|T400/);
  }
  // the selection round's keys are checked against the proofs the same way
  const env = setup();
  const p = await withRound(env);
  env.DB._db.prepare('UPDATE submissions SET photo_keys = ?').run(JSON.stringify(['_books/b1.json', 'other/x.jpg', 'shoot/毛片/../../other/x.jpg', PA]));
  const keys = await (await round(env, p.token, p.key, 'selection')).json();
  const names = keys.photos.map(x => [x.i, x.name]);
  for (const [i, name] of names) {
    const res = await t400(env, p, 'selection', i);
    if (name === 'a.jpg') assert.equal(await body(res), 'PA-T400');
    else assert.equal(res.status, 404, name);
  }
});

test('photo: the selection round serves proofs only from the project\'s folders and the link\'s own snapshot (originals switch off), as thumbnails', async () => {
  const env = setup();
  const p = await withRound(env);
  assert.equal(projectRow(env).allow_proof_download, 0);
  // the object route refuses the proofs now that the project is delivered
  assert.equal((await call(env, withT(`/${PA}?w=400`, p.token))).status, 401);
  const res = await t400(env, p, 'selection', 0);
  assert.equal(await body(res), 'PA-T400');
  assert.equal(await body(await photo(env, p.token, p.key, 'selection', 'i=0&w=1200')), 'PA-T1200');
  // PB has no 1200: 404, not the original
  const r = await photo(env, p.token, p.key, 'selection', 'i=1&w=1200');
  assert.equal(r.status, 404);
  assert.notEqual(await body(r), 'PB-ORIG');
});
