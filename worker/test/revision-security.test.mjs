// Adversarial review of revision pins (docs/revision-pins.md §8), one test per
// finding: token kinds, a key smuggled outside the header, existence oracles,
// the thumbnail's content type, and the races between two tabs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedToken, days } from './pick-helpers.mjs';
import {
  FINAL, F1, F3, OBJECTS,
  setup, code, putPins, submitRound, rounds, round, photo, pin, delivered, withRound, draftRows, roundRows, projectRow, landOnce,
  pick, one,
} from './revision-helpers.mjs';

const ALL = (id = 'selection') => [
  ['PUT', 'revision-pins', { items: [{ photo_key: F1, marks: [pin()] }] }],
  ['POST', 'revision-round', { expect: [{ k: F1, n: 1 }] }],
  ['GET', 'rounds'],
  ['GET', `rounds/${id}`],
  ['GET', `rounds/${id}/photo?i=0&w=400`],
];

test('token kinds: a studio, session, album or client token, a pick row without a project, and no token at all are 401 on every new route — even with the seat holder\'s key', async () => {
  const env = setup();
  const p = await withRound(env);
  for (const [method, route, body] of ALL(p.roundId)) {
    assert.equal((await pick(env, method, route, p.token, { key: p.key, body })).status === 401, false, `${route}: the link itself works`);
  }
  const tokens = [
    await seedToken(env, { token: 'studio-t', kind: 'studio', project_id: p.id, folders: [FINAL] }),
    await seedToken(env, { token: 'session-t', kind: 'session', project_id: p.id, folders: [FINAL] }),
    await seedToken(env, { token: 'album-t', kind: 'client', book_id: 'b1', project_id: p.id, folders: [FINAL] }),
    await seedToken(env, { token: 'client-t', kind: 'client', user_id: 1, project_id: p.id, folders: [FINAL] }),
    await seedToken(env, { token: 'orphan-t', kind: 'pick', project_id: null, folders: [FINAL] }),
    await seedToken(env, { token: 'other-project-t', kind: 'pick', project_id: 'no-such-project', folders: [FINAL] }),
    await seedToken(env, { token: 'too-old-t', kind: 'pick', project_id: p.id, created_at: days(-400), expires_at: days(5) }),
  ];
  for (const t of [...tokens, undefined, '']) {
    for (const [method, route, body] of ALL(p.roundId)) {
      const res = await pick(env, method, route, t, { key: p.key, body });
      assert.equal(res.status, 401, `${t} ${method} ${route}`);
    }
  }
  // the admin token is not a pick link either
  const res = await pick(env, 'GET', 'rounds', undefined, { key: p.key, headers: { Authorization: 'Bearer photographer-secret' } });
  assert.equal(res.status, 401);
});

test('the picker key only counts in its header: ?key= / ?picker_key= in the URL, or the key as the link token, is a viewer (403) or a dead link (401)', async () => {
  const env = setup();
  const p = await withRound(env);
  for (const q of [`key=${p.key}`, `picker_key=${p.key}`, `X-Picker-Key=${p.key}`]) {
    const res = await pick(env, 'GET', `rounds?${q}`, p.token, {});
    assert.equal(res.status, 403, q);
  }
  assert.equal((await pick(env, 'GET', 'rounds', p.key, { key: p.key })).status, 401);
});

test('no existence oracle: a viewer gets 403 for a real round, an unknown round and another project\'s round alike; 404 only reaches the seat holder', async () => {
  const env = setup();
  const p = await withRound(env);
  const q = await withRound(env);
  for (const id of [p.roundId, q.roundId, '00000000-0000-0000-0000-000000000000', 'nope']) {
    assert.equal((await round(env, p.token, undefined, id)).status, 403, id);
    assert.equal((await photo(env, p.token, undefined, id, 'i=0&w=400')).status, 403, id);
  }
  assert.equal((await round(env, p.token, p.key, q.roundId)).status, 404);
});

test('the thumbnail\'s Content-Type: a stored PNG / WebP stays itself; anything not a raster image (SVG, HTML, none) is sent as image/jpeg with nosniff', async () => {
  const objects = {
    ...OBJECTS,
    [`_thumbs/400/${F1}.thumb`]: { body: 'PNG-BYTES', contentType: 'image/png' },
    [`_thumbs/1200/${F1}.thumb`]: { body: '<svg onload=alert(1)>', contentType: 'image/svg+xml' },
    [`_thumbs/400/${F3}.thumb`]: { body: '<html>', contentType: 'text/html' },
  };
  const env = setup({ objects });
  const p = await withRound(env);
  let res = await photo(env, p.token, p.key, p.roundId, 'i=0&w=400');
  assert.equal(res.headers.get('Content-Type'), 'image/png');
  assert.equal(await res.text(), 'PNG-BYTES');
  res = await photo(env, p.token, p.key, p.roundId, 'i=0&w=1200');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  res = await photo(env, p.token, p.key, p.roundId, 'i=1&w=400');
  assert.equal(res.headers.get('Content-Type'), 'image/jpeg');
  // the default (the fake's image/jpeg) passes through
  const env2 = setup();
  const q = await withRound(env2);
  assert.equal((await photo(env2, q.token, q.key, q.roundId, 'i=0&w=400')).headers.get('Content-Type'), 'image/jpeg');
});

test('two tabs: a round sent in one tab while the other saves a draft makes the save a no-op (409 revision_open)', async () => {
  const env = setup();
  const p = await delivered(env);
  assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin()] }])).status, 200);
  landOnce(env, /UPDATE projects SET id = id/,
    "INSERT INTO revision_requests (id, project_id, picker_id, message, message_auto, marks, finals, created_at) SELECT 'r-other', id, NULL, 'x', 1, '{}', final_folders, 'y' FROM projects");
  const res = await putPins(env, p.token, p.key, [{ photo_key: F3, marks: [pin()] }]);
  assert.equal(res.status, 409);
  assert.equal(await code(res), 'revision_open');
  assert.deepEqual(draftRows(env).map(r => r.photo_key), [F1]);
});

test('two tabs: a draft added in another tab between the page\'s last read and its send makes the send 409 draft_changed; nothing frozen, drafts kept', async () => {
  const env = setup();
  const p = await delivered(env);
  assert.equal((await putPins(env, p.token, p.key, [{ photo_key: F1, marks: [pin()] }])).status, 200);
  const { delivered_at: at, final_folders: ff } = projectRow(env);
  landOnce(env, /INSERT INTO revision_requests \(id, project_id, picker_id, message, message_auto/,
    'INSERT INTO revision_pins (project_id, photo_key, marks, delivery_at, delivery_finals, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    p.id, F3, JSON.stringify([pin()]), at, ff, p.pickerId, 'x');
  const res = await submitRound(env, p.token, p.key, { expect: [{ k: F1, n: 1 }] });
  assert.equal(res.status, 409);
  assert.equal(await code(res), 'draft_changed');
  assert.equal(roundRows(env).length, 0);
  assert.equal(draftRows(env).length, 2);
  // and a pin added to the same photo (the count moves)
  const env2 = setup();
  const q = await delivered(env2);
  assert.equal((await putPins(env2, q.token, q.key, [{ photo_key: F1, marks: [pin()] }])).status, 200);
  landOnce(env2, /INSERT INTO revision_requests \(id, project_id, picker_id, message, message_auto/,
    'UPDATE revision_pins SET marks = ?', JSON.stringify([pin(), pin(0.2, 0.2)]));
  const res2 = await submitRound(env2, q.token, q.key, { expect: [{ k: F1, n: 1 }] });
  assert.equal(await code(res2), 'draft_changed');
  assert.equal(roundRows(env2).length, 0);
});

test('a seat holder of another project with its own round cannot freeze, read or thumbnail across: every query is scoped by the link\'s project', async () => {
  const env = setup();
  const p = await withRound(env);
  const q = await delivered(env);
  // q drafts a key that is in p's finals too (same folder name) — still q's own
  assert.equal((await putPins(env, q.token, q.key, [{ photo_key: F1, marks: [pin(0.3, 0.3, 'q')] }])).status, 200);
  const res = await submitRound(env, q.token, q.key, { expect: [{ k: F1, n: 1 }] });
  assert.equal(res.status, 200);
  const qRound = (await res.json()).id;
  assert.equal(one(env, 'SELECT project_id FROM revision_requests WHERE id = ?', qRound).project_id, q.id);
  // p's frozen round is untouched, p's list does not show q's round
  const list = await (await rounds(env, p.token, p.key)).json();
  assert.ok(!list.rounds.some(r => r.id === qRound));
  assert.equal(JSON.parse(one(env, 'SELECT marks FROM revision_requests WHERE id = ?', p.roundId).marks)[F1][0].note, '去掉路人');
});

test('guest responses never carry final_folders / finals or a full key; the state keeps final_folders as the existing `final_folders` (current finals) only', async () => {
  const env = setup();
  const p = await withRound(env);
  for (const path of ['rounds', `rounds/${p.roundId}`, 'rounds/selection']) {
    const text = await (await pick(env, 'GET', path, p.token, { key: p.key })).text();
    assert.doesNotMatch(text, /final_folders|"finals"|shoot\//, path);
  }
});
