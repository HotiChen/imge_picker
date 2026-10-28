// Node tests for js/xmp-export.js (轉出精挑相片 XMP). Run: node --test test/unit/xmp-export.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const X = require('../../js/xmp-export.js');

const BOM = String.fromCharCode(0xFEFF);
const sel = (key, rating, marks = null, extra = {}) => ({ photo_key: key, rating, note: '', marks, ...extra });
const PIN = [{ x: 0.1, y: 0.2, note: 'pin' }];
const off = { rating: 'off', label: 'off', labelPins: 'same', flag: 'off' };
const attrsOf = text => { const m = text.match(/<rdf:Description ([^>]*?)\/>/); return m ? [...m[1].matchAll(/\s?((?:xmp|xmpDM):\w+)="([^"]*)"/g)].map(a => `${a[1]}=${a[2]}`) : null; };

// a strict check without a parser: tags nest properly, attributes are quoted, the packet wraps one xmpmeta
function assertWellFormed(text) {
  const body = text.replace(/<\?xpacket[^?]*\?>/g, '');
  assert.equal((text.match(/<\?xpacket /g) || []).length, 2, 'one begin, one end');
  const stack = [];
  for (const m of body.matchAll(/<(\/?)([\w:]+)((?:\s+[\w:]+="[^"<&]*")*)\s*(\/?)>/g)) {
    if (m[1]) assert.equal(stack.pop(), m[2], 'closing tag matches');
    else if (!m[4]) stack.push(m[2]);
  }
  assert.deepEqual(stack, [], 'every tag closed');
  // no stray < or > outside the matched tags
  assert.equal(body.replace(/<(\/?)([\w:]+)((?:\s+[\w:]+="[^"<&]*")*)\s*(\/?)>/g, '').replace(/\s+/g, ''), '', 'nothing but tags');
}

test('defaultSettings: rating follows the client, Green with pins -> Red, flag off', () => {
  assert.deepEqual(X.defaultSettings(), { rating: 'follow', label: 'Green', labelPins: 'Red', flag: 'off' });
  assert.notEqual(X.defaultSettings(), X.defaultSettings(), 'a fresh object each time');
});

test('normalizeSettings: junk and missing fields fall back to the defaults, never throws', () => {
  const d = X.defaultSettings();
  for (const junk of [undefined, null, 5, 'x', [], true, () => 1, { rating: 9, label: 'Pink', labelPins: 'Pink', flag: 'x' }, { rating: 0 }, { rating: 2.5 }, { rating: {} }]) {
    assert.deepEqual(X.normalizeSettings(junk), d, JSON.stringify(junk));
  }
  assert.deepEqual(X.normalizeSettings({ rating: '3', label: 'off', labelPins: 'Blue', flag: 'pick' }), { rating: 3, label: 'off', labelPins: 'Blue', flag: 'pick' });
  assert.deepEqual(X.normalizeSettings({ rating: 'off', label: 'Purple', labelPins: 'same' }), { rating: 'off', label: 'Purple', labelPins: 'same', flag: 'off' });
  assert.deepEqual(X.normalizeSettings({ flag: 'pick' }), { ...d, flag: 'pick' });
  const evil = { get rating() { throw new Error('boom'); } };
  assert.deepEqual(X.normalizeSettings(evil), d);
  assert.deepEqual(X.normalizeSettings({ rating: 4 }), { ...d, rating: 4 });
});

test('buildXmp: the exact packet, BOM inside begin="", only the attributes that are on', () => {
  const t = X.buildXmp({ rating: 'follow', label: 'Green', labelPins: 'same', flag: 'pick' }, sel('a/IMG_1.CR3', 4));
  assert.equal(t,
    `<?xpacket begin="${BOM}" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="imge-picker">\n' +
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
    '<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpDM="http://ns.adobe.com/xmp/1.0/DynamicMedia/" xmp:Rating="4" xmp:Label="Green" xmpDM:pick="1"/>\n' +
    '</rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>\n');
  assert.ok(t.startsWith(`<?xpacket begin="${BOM}"`) && t.charCodeAt(t.indexOf('begin="') + 7) === 0xFEFF);
});

test('buildXmp: every combination of the three settings gives exactly the expected attributes', () => {
  const ratings = ['off', 'follow', 1, 3, 5];
  const labels = ['off', 'Red', 'Yellow', 'Green', 'Blue', 'Purple'];
  const flags = ['off', 'pick'];
  let n = 0;
  for (const rating of ratings) for (const label of labels) for (const flag of flags) {
    const t = X.buildXmp({ rating, label, labelPins: 'same', flag }, sel('d/a.jpg', 2));
    const want = [];
    if (rating === 'follow') want.push('xmp:Rating=2'); else if (rating !== 'off') want.push(`xmp:Rating=${rating}`);
    if (label !== 'off') want.push(`xmp:Label=${label}`);
    if (flag === 'pick') want.push('xmpDM:pick=1');
    if (!want.length) { assert.equal(t, ''); } else { assert.deepEqual(attrsOf(t), want); assertWellFormed(t); }
    n++;
  }
  assert.equal(n, 60);
});

test('follow the client: stars 1-5 pass through, 0 / 6 / junk give no Rating attribute', () => {
  const s = { ...off, rating: 'follow', label: 'Green' };
  for (const r of [1, 2, 3, 4, 5]) assert.deepEqual(attrsOf(X.buildXmp(s, sel('a.jpg', r))), [`xmp:Rating=${r}`, 'xmp:Label=Green']);
  for (const r of [0, 6, -1, 2.5, null, undefined, 'x']) assert.deepEqual(attrsOf(X.buildXmp(s, sel('a.jpg', r))), ['xmp:Label=Green'], String(r));
  assert.deepEqual(attrsOf(X.buildXmp(s, null)), ['xmp:Label=Green']);
  assert.deepEqual(attrsOf(X.buildXmp({ ...s, rating: 5 }, sel('a.jpg', 1))), ['xmp:Rating=5', 'xmp:Label=Green'], 'fixed ignores the client');
});

test('pin colour: pins -> second colour; no / empty marks -> normal colour; "same" -> normal colour; label off -> no label', () => {
  const s = { rating: 'off', label: 'Green', labelPins: 'Red', flag: 'off' };
  assert.deepEqual(attrsOf(X.buildXmp(s, sel('a.jpg', 3, PIN))), ['xmp:Label=Red']);
  assert.deepEqual(attrsOf(X.buildXmp(s, sel('a.jpg', 3, [{ x: 0, y: 0, note: '' }]))), ['xmp:Label=Red'], 'a bare pin counts');
  assert.deepEqual(attrsOf(X.buildXmp(s, sel('a.jpg', 3, null))), ['xmp:Label=Green']);
  assert.deepEqual(attrsOf(X.buildXmp(s, sel('a.jpg', 3, []))), ['xmp:Label=Green']);
  assert.deepEqual(attrsOf(X.buildXmp({ ...s, labelPins: 'same' }, sel('a.jpg', 3, PIN))), ['xmp:Label=Green']);
  assert.equal(X.buildXmp({ ...s, label: 'off' }, sel('a.jpg', 3, PIN)), '');
  assert.deepEqual(attrsOf(X.buildXmp({ ...s, labelPins: 'Purple' }, sel('a.jpg', 3, PIN))), ['xmp:Label=Purple']);
});

test('no guest text ever reaches the XMP', () => {
  const evil = '"><script>alert(1)</script> & 備註 SECRET';
  const t = X.buildXmp(X.defaultSettings(), sel('a/' + evil + '.jpg', 5, [{ x: 0, y: 0, note: evil }], { note: evil, description: evil, title: evil }));
  assert.ok(!/SECRET|<script|備註|alert|onerror/.test(t));
  assert.ok(!/dc:|Keywords|Description>/.test(t.replace('<rdf:Description ', '')), 'no description, no keywords');
  assertWellFormed(t);
});

test('planExport: only rating >= 1; names are the base name + .xmp; pin count', () => {
  const p = X.planExport(X.defaultSettings(), [
    sel('20260819/IMG_001.CR3', 5, PIN), sel('20260819/IMG_002.jpg', 0), sel('x/y/IMG_003.nef', 1), sel('20260819/IMG_004.jpg', -1), sel('IMG_005', 3),
  ]);
  assert.deepEqual(p.files.map(f => f.name), ['IMG_001.xmp', 'IMG_003.xmp', 'IMG_005.xmp']);
  assert.equal(p.pinned, 1);
  assert.deepEqual(attrsOf(p.files[0].text), ['xmp:Rating=5', 'xmp:Label=Red']);
  assert.deepEqual(attrsOf(p.files[1].text), ['xmp:Rating=1', 'xmp:Label=Green']);
  assert.deepEqual(p.collisions, []); assert.deepEqual(p.skipped, []);
  assert.deepEqual(X.planExport(X.defaultSettings(), null).files, []);
  assert.deepEqual(X.planExport(X.defaultSettings(), [null, 5, 'x', {}]).files, []);
});

test('planExport: same base name in two folders -> the first is kept, the rest listed, nothing overwritten (case-insensitive)', () => {
  const p = X.planExport(X.defaultSettings(), [sel('a/IMG_1.jpg', 3), sel('b/IMG_1.jpg', 5), sel('c/img_1.CR3', 2), sel('b/IMG_2.jpg', 1)]);
  assert.deepEqual(p.files.map(f => f.name), ['IMG_1.xmp', 'IMG_2.xmp']);
  assert.deepEqual(attrsOf(p.files[0].text)[0], 'xmp:Rating=3', 'the first one wins');
  assert.deepEqual(p.collisions.map(c => c.photo_key), ['b/IMG_1.jpg', 'c/img_1.CR3']);
  assert.equal(p.collisions[0].kept, 'a/IMG_1.jpg');
});

test('names are sanitised: no separators or control characters; an empty name is skipped, not written', () => {
  assert.equal(X.xmpBaseName('a/b/IMG_1.CR3'), 'IMG_1');
  assert.equal(X.xmpBaseName('a\\b\\IMG_2.CR3'), 'IMG_2');
  assert.equal(X.xmpBaseName('d/ev:il*na?me"<>|\u0007‎.jpg'), 'evilname');
  assert.equal(X.xmpBaseName('d/..'), '');
  assert.equal(X.xmpBaseName('d/a.b.c.jpg'), 'a.b.c');
  const p = X.planExport(X.defaultSettings(), [sel('d/..', 3), sel('d/***.jpg', 3), sel('d/ok.jpg', 3), sel(null, 3)]);
  assert.deepEqual(p.files.map(f => f.name), ['ok.xmp']);
  assert.deepEqual(p.skipped.map(s => s.reason), ['bad_name', 'bad_name', 'bad_name']);
  for (const f of p.files) assert.ok(!/[\\/\u0000-\u001f]/.test(f.name));
});

test('all settings off -> buildXmp is empty and no files are planned', () => {
  assert.equal(X.buildXmp(off, sel('a.jpg', 5, PIN)), '');
  const p = X.planExport(off, [sel('a.jpg', 5), sel('b.jpg', 3)]);
  assert.deepEqual(p.files, []); assert.deepEqual(p.collisions, []);
});

test('output is well-formed XML (also through sax in strict mode when it is installed)', () => {
  const texts = [X.buildXmp(X.defaultSettings(), sel('a.jpg', 4)), X.buildXmp({ rating: 2, label: 'Blue', labelPins: 'same', flag: 'pick' }, sel('a.jpg', 1))];
  for (const t of texts) {
    assertWellFormed(t);
    try {
      const sax = require('sax');
      const ps = sax.parser(true, { xmlns: true });
      let err = null; ps.onerror = e => { err = e; };
      ps.write(t.replace(/<\?xpacket[^?]*\?>/g, '')).close();
      assert.equal(err, null);
    } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
});

test('readme: zh-TW, warns about overwriting, names the Lightroom menu, says the pick flag is unverified', () => {
  const r = X.readme();
  assert.match(r, /不要解壓縮到已經有 \.xmp 的資料夾/);
  assert.match(r, /RAW/);
  assert.match(r, /從檔案讀取中繼資料/);
  assert.match(r, /Read Metadata from File/);
  assert.match(r, /旗標.*尚未.*驗證/);
});
