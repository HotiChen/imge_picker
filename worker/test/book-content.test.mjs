// What an album write may put into a book. A slot's photoId and crop are
// rendered into HTML by the editor and by every viewer of the album — the
// photographer's own session among them — so a value that can close an
// attribute is a stored XSS that steals the studio token (audit FE-1). The
// renderer escapes on its own as well (test/run.mjs "album XSS"); this file is
// the other half: the Worker refuses to store such values at all.
//
// A share-link holder (the client) reaches PATCH /api/books/:id; the
// photographer also reaches PUT. Both are covered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';
import { fakeBucket, fakeDB, ctx, req } from './fakes.mjs';

const SECRET = 'photographer-secret';
const FOLDER = '20260819/';
const BOOK = {
  name: 'b',
  clientFolders: [FOLDER],
  pages: [
    { type: 'cover', layout: 'full-bleed', slots: [{ photoId: '20260819/a.jpg', crop: { x: 0, y: 0, scale: 1 } }] },
    { type: 'inner', layout: '2-up-h', slots: [
      { photoId: '20260819/b.jpg', crop: { x: 0.1, y: 0, scale: 1, rotation: 0 } },
      { photoId: '20260819/c.jpg', crop: { x: 0, y: 0, scale: 1 } },
    ] },
  ],
};
const BOOK_TEXT = JSON.stringify(BOOK);

const days = n => new Date(Date.now() + n * 864e5).toISOString();

async function setup() {
  const env = { imagepicker: fakeBucket({ '_books/b1.json': BOOK_TEXT }), DB: fakeDB(), PHOTOGRAPHER_TOKEN: SECRET };
  await env.DB.prepare('INSERT INTO share_tokens (token, book_id, label, folders, created_at, expires_at) VALUES (?,?,?,?,?,?)')
    .bind('TK', 'b1', 'client', JSON.stringify([FOLDER]), days(-1), days(89)).run();
  return env;
}
const call = (env, path, opts) => worker.fetch(req(path, opts), env, ctx);
const stored = env => env.imagepicker._store.get('_books/b1.json').body;
// the client's own save: X-Share-Token header, the way viewer.js sends it
const clientPatch = (env, body) => call(env, '/api/books/b1', {
  method: 'PATCH', headers: { 'X-Share-Token': 'TK' }, body: JSON.stringify(body),
});
const adminPatch = (env, body) => call(env, '/api/books/b1', { method: 'PATCH', token: SECRET, body: JSON.stringify(body) });
const adminPut = (env, body) => call(env, '/api/books/b1', {
  method: 'PUT', token: SECRET, body: typeof body === 'string' ? body : JSON.stringify(body),
});

// the three shapes the audit proved, plus every character class the Worker refuses
const HOSTILE_PHOTO_IDS = [
  ['attribute breakout (PoC)', '20260819/a.jpg" onerror="window.__xss2=1" x="'],
  ['tag breakout', '20260819/"><img src=x onerror=alert(1)>.jpg'],
  ['angle brackets alone', '20260819/<svg onload=alert(1)>.jpg'],
  ['closing angle bracket', '20260819/a>.jpg'],
  ['backtick', '20260819/a`b.jpg'],
  ['backslash', '20260819/a\\b.jpg'],
  ['newline', '20260819/a\nb.jpg'],
  ['carriage return', '20260819/a\rb.jpg'],
  ['tab', '20260819/a\tb.jpg'],
  ['NUL', '20260819/a\u0000b.jpg'],
  ['DEL', '20260819/a\u007fb.jpg'],
  ['C1 control (NEL)', '20260819/a\u0085b.jpg'],
  ['line separator', '20260819/a\u{2028}b.jpg'],
  ['paragraph separator', '20260819/a\u{2029}b.jpg'],
  ['bidi override (RLO)', '20260819/a\u{202e}gpj.exe'],
  ['bidi isolate (RLI)', '20260819/a\u{2067}b.jpg'],
  ['right-to-left mark', '20260819/a\u{200f}b.jpg'],
  ['arabic letter mark', '20260819/a\u{61c}b.jpg'],
  ['byte order mark', '20260819/a\u{feff}b.jpg'],
  // no R2 key (UTF-8) can hold one, and the renderer's encoder would throw on it
  ['lone surrogate', '20260819/a' + String.fromCharCode(0xd800) + 'b.jpg'],
  ['longer than an R2 key can be', FOLDER + 'a'.repeat(1100) + '.jpg'],
];

// what real uploads produce: upload.html keeps the file name as it is
const LEGIT_PHOTO_IDS = [
  '20260819/新娘 準備 (1).jpg',
  '20260819/婚禮/儀式-002.JPG',
  "20260819/Tim's pick.jpg",
  "20260819/O'Brien & 家人 #3 [final] {v2} 100% +1 =ok; @x ~y !z,(a).jpeg",
  '20260819/IMG_0001.HEIC.jpg',
  '20260819/日本語・한국어・emoji😀.webp',
];

const HOSTILE_CROPS = [
  ['crop.x is markup (PoC)', { x: '"><img src=x onerror="window.__xss=1">', y: 0, scale: 1 }],
  ['crop.y is a string', { x: 0, y: '0', scale: 1 }],
  ['crop.scale is a string', { x: 0, y: 0, scale: '1' }],
  ['crop.rotation is a string', { x: 0, y: 0, scale: 1, rotation: '90deg' }],
  ['crop.x is an object', { x: { toString: 1 }, y: 0, scale: 1 }],
  ['crop.x is an array', { x: [0], y: 0, scale: 1 }],
  ['crop.x is a boolean', { x: true, y: 0, scale: 1 }],
  ['crop.x is null', { x: null, y: 0, scale: 1 }],
  ['an unknown key', { x: 0, y: 0, scale: 1, evil: 'x'.repeat(1000) }],
  ['an inherited-looking key', { x: 0, y: 0, scale: 1, constructor: 1 }],
  ['crop.x out of range', { x: 1001, y: 0, scale: 1 }],
  ['crop.x out of range, negative', { x: -1001, y: 0, scale: 1 }],
  ['crop.y out of range', { x: 0, y: 5000, scale: 1 }],
  ['crop.scale out of range', { x: 0, y: 0, scale: 1001 }],
  ['crop.scale negative', { x: 0, y: 0, scale: -1 }],
  ['crop.rotation out of range', { x: 0, y: 0, scale: 1, rotation: 1e7 }],
  ['crop is an array', [0, 0, 1]],
  ['crop is an empty array', []],
  ['crop is a string', '"><img src=x>'],
  ['crop is a number', 5],
  ['crop is null', null],
];

// ─── share-link PATCH: hostile photoIds ──────────────────────────────────────

for (const [label, photoId] of HOSTILE_PHOTO_IDS) {
  test(`share-link PATCH refuses a photoId with ${label}: 400 invalid_photo_id, book unchanged`, async () => {
    const env = await setup();
    const res = await clientPatch(env, { pageIndex: 0, slots: [{ photoId, crop: { x: 0, y: 0, scale: 1 } }] });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'invalid_photo_id');
    assert.equal(stored(env), BOOK_TEXT, 'the book was written anyway');
  });
}

test('a hostile photoId in a later slot refuses the whole PATCH, earlier slots included', async () => {
  const env = await setup();
  const res = await clientPatch(env, { pageIndex: 1, slots: [
    { photoId: '20260819/new.jpg', crop: { x: 0, y: 0, scale: 1 } },
    { photoId: '20260819/c.jpg" onerror="x', crop: { x: 0, y: 0, scale: 1 } },
  ] });
  assert.equal(res.status, 400);
  assert.equal(stored(env), BOOK_TEXT);
});

// ─── share-link PATCH: hostile crops ─────────────────────────────────────────

for (const [label, crop] of HOSTILE_CROPS) {
  test(`share-link PATCH refuses ${label}: 400 invalid_crop, book unchanged`, async () => {
    const env = await setup();
    const res = await clientPatch(env, { pageIndex: 0, slots: [{ photoId: '20260819/a.jpg', crop }] });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'invalid_crop');
    assert.equal(stored(env), BOOK_TEXT, 'the book was written anyway');
  });
}

test('an infinite crop value (1e309 in the JSON) is refused', async () => {
  const env = await setup();
  const res = await call(env, '/api/books/b1', {
    method: 'PATCH', headers: { 'X-Share-Token': 'TK' },
    body: '{"pageIndex":0,"slots":[{"photoId":"20260819/a.jpg","crop":{"x":1e309,"y":0,"scale":1}}]}',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'invalid_crop');
  assert.equal(stored(env), BOOK_TEXT);
});

test('a hostile crop on a slot that clears its photo is still refused', async () => {
  // the photoId branch `continue`s on a null photo; the crop must not ride past it
  const env = await setup();
  const res = await clientPatch(env, { pageIndex: 0, slots: [{ photoId: null, crop: { x: '<b>', y: 0, scale: 1 } }] });
  assert.equal(res.status, 400);
  assert.equal(stored(env), BOOK_TEXT);
});

test('a hostile crop with no photoId at all is still refused', async () => {
  const env = await setup();
  const res = await clientPatch(env, { pageIndex: 0, slots: [{ crop: { x: 0, y: 0, scale: 1, evil: 1 } }] });
  assert.equal(res.status, 400);
  assert.equal(stored(env), BOOK_TEXT);
});

// ─── share-link PATCH: what must keep working ────────────────────────────────

for (const photoId of LEGIT_PHOTO_IDS) {
  test(`share-link PATCH stores a real file name: ${JSON.stringify(photoId)}`, async () => {
    const env = await setup();
    const res = await clientPatch(env, { pageIndex: 0, slots: [{ photoId, crop: { x: 0, y: 0, scale: 1 } }] });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(JSON.parse(stored(env)).pages[0].slots[0].photoId, photoId);
  });
}

test('share-link PATCH stores a normal crop exactly, rotation and negative pan included', async () => {
  const env = await setup();
  const crop = { x: -0.1234, y: 0.5, scale: 2.5, rotation: -450 };
  const res = await clientPatch(env, { pageIndex: 1, slots: [
    { photoId: '20260819/b.jpg', crop },
    { photoId: '20260819/c.jpg', crop: { x: 0, y: 0, scale: 1 } },
  ] });
  assert.equal(res.status, 200);
  const saved = JSON.parse(stored(env)).pages[1].slots;
  assert.deepEqual(saved[0].crop, crop);
  assert.deepEqual(saved[1].crop, { x: 0, y: 0, scale: 1 });
});

test('the bounds themselves are allowed (inclusive)', async () => {
  const env = await setup();
  const crop = { x: -1000, y: 1000, scale: 1000, rotation: 1e6 };
  const res = await clientPatch(env, { pageIndex: 0, slots: [{ photoId: '20260819/a.jpg', crop }] });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(stored(env)).pages[0].slots[0].crop, crop);
  const low = await clientPatch(env, { pageIndex: 0, slots: [{ photoId: '20260819/a.jpg', crop: { x: 1000, y: -1000, scale: 0, rotation: -1e6 } }] });
  assert.equal(low.status, 200);
});

test('exactly what viewer.js sends — every slot of the page, crop with all four fields, fit and override — is stored', async () => {
  const env = await setup();
  const slots = [
    { photoId: '20260819/新 的.jpg', crop: { x: 0, y: 0, scale: 1, rotation: 0 }, fit: 'cover', override: { x: 1, y: 2, w: 40, h: 50 } },
    { photoId: '20260819/c.jpg', crop: { x: 0, y: 0, scale: 1, rotation: 0 }, fit: 'contain' },
  ];
  const res = await clientPatch(env, { pageIndex: 1, slots });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(stored(env)).pages[1].slots[0].photoId, '20260819/新 的.jpg');
});

test('clearing a slot (null photoId) still works by share link', async () => {
  const env = await setup();
  const res = await clientPatch(env, { pageIndex: 0, slots: [{ photoId: null, crop: { x: 0, y: 0, scale: 1 } }] });
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(stored(env)).pages[0].slots[0].photoId, null);
});

test('a photo outside the opened folder is still 403, a clean neighbour folder too', async () => {
  const env = await setup();
  for (const photoId of ['20260901/x.jpg', '20260819-other/x.jpg', '2026/x.jpg']) {
    const res = await clientPatch(env, { pageIndex: 0, slots: [{ photoId, crop: { x: 0, y: 0, scale: 1 } }] });
    assert.equal(res.status, 403, photoId);
  }
  assert.equal(stored(env), BOOK_TEXT);
});

// ─── the photographer's PATCH goes through the same checks ───────────────────

test('the photographer PATCH refuses the same hostile photoId and crop', async () => {
  const env = await setup();
  const a = await adminPatch(env, { pageIndex: 0, slots: [{ photoId: HOSTILE_PHOTO_IDS[0][1] }] });
  assert.equal(a.status, 400);
  const b = await adminPatch(env, { pageIndex: 0, slots: [{ photoId: '20260819/a.jpg', crop: HOSTILE_CROPS[0][1] }] });
  assert.equal(b.status, 400);
  assert.equal(stored(env), BOOK_TEXT);
});

// ─── the photographer's PUT ──────────────────────────────────────────────────

// a book the editor really saves: _bookDataForSave() with text layers, a
// background image, overrides, fits, a custom layout, settings and a stray
// crop with a null (a NaN that went through JSON.stringify)
const EDITOR_BOOK = {
  id: 'b1', name: '王先生 婚紗', clientFolders: [FOLDER], notifyUrl: '', status: 'draft',
  settings: { width: 57, height: 21, unit: 'cm', dpi: 300, bleed: 3, pagesPerSheet: 2 },
  coverSettings: { width: 28.5, height: 21, unit: 'cm', dpi: 300 },
  _customLayouts: { 'custom-1': { name: '我的', slots: [{ x: 0, y: 0, w: 60, h: 100 }] } },
  pages: [
    { id: 'p0', type: 'cover', layout: 'full-bleed', bg: '#ffffff', locked: false,
      bgImage: { photoId: "20260819/O'Brien 底圖.jpg", fit: 'cover', opacity: 0.8 },
      slots: [{ photoId: '20260819/新娘 (1).jpg', crop: { x: 0.1, y: -0.2, scale: 1.3, rotation: 90 }, fit: 'cover', z: 3 }],
      textLayers: [{ id: 'tl-1', text: '婚禮\n2026', font: "'Noto Serif TC', serif", size: 6, color: '#ffffff', x: 50, y: 50, w: 80, align: 'center', bold: true }] },
    { id: 'p1', type: 'inner', layout: 'custom-1', bg: '#000',
      slots: [{ photoId: null, crop: { x: null, y: 0, scale: 1 } }, null, { photoId: '20260819/c.jpg' }],
      _photoCache: { 0: { photoId: '20260819/old.jpg', crop: { x: 0, y: 0, scale: 1 } } } },
    { id: 'p2', type: 'back-cover', layout: 'blank', slots: [] },
  ],
};

test('the photographer PUT still stores a real editor book byte for byte', async () => {
  const env = await setup();
  const text = JSON.stringify(EDITOR_BOOK);
  const res = await adminPut(env, text);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(stored(env), text);
});

test('the photographer PUT refuses a book whose slot photoId can break out of an attribute', async () => {
  const env = await setup();
  const book = structuredClone(EDITOR_BOOK);
  book.pages[0].slots[0].photoId = HOSTILE_PHOTO_IDS[0][1];
  const res = await adminPut(env, book);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'invalid_photo_id');
  assert.equal(stored(env), BOOK_TEXT);
});

test('the photographer PUT refuses a hostile background photoId', async () => {
  const env = await setup();
  const book = structuredClone(EDITOR_BOOK);
  book.pages[0].bgImage.photoId = '20260819/bg.jpg\' onerror=\'x"';
  const res = await adminPut(env, book);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'invalid_photo_id');
  assert.equal(stored(env), BOOK_TEXT);
});

test('the photographer PUT refuses a non-string photoId', async () => {
  const env = await setup();
  const book = structuredClone(EDITOR_BOOK);
  book.pages[0].slots[0].photoId = { toString: 'x' };
  assert.equal((await adminPut(env, book)).status, 400);
  assert.equal(stored(env), BOOK_TEXT);
});

test('the photographer PUT refuses a markup crop, an unknown crop key, and a non-object crop', async () => {
  for (const crop of [{ x: '"><img src=x>', y: 0, scale: 1 }, { x: 0, y: 0, scale: 1, evil: 1 }, 'x', [1]]) {
    const env = await setup();
    const book = structuredClone(EDITOR_BOOK);
    book.pages[0].slots[0].crop = crop;
    const res = await adminPut(env, book);
    assert.equal(res.status, 400, JSON.stringify(crop));
    assert.equal((await res.json()).code, 'invalid_crop');
    assert.equal(stored(env), BOOK_TEXT);
  }
});

test('the photographer PUT refuses a body that is not a JSON object, or pages that is not a list', async () => {
  for (const body of ['not json', '[]', '"x"', 'null', '{"pages":{}}', '{"pages":[{"slots":{"0":{}}}]}']) {
    const env = await setup();
    const res = await adminPut(env, body);
    assert.equal(res.status, 400, body);
    assert.equal(stored(env), BOOK_TEXT, body);
  }
});
