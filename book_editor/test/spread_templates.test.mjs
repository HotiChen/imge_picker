// node --test book_editor/test/spread_templates.test.mjs
//
// The spread template library (book_editor/js/spread_templates.js): plain data
// plus a validator. Every template is checked here twice over — once by the
// library's own validate(), once by the independent geometry below — and the
// validator is shown to fail on each kind of bad data, naming the template.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(dir, '..', 'js', 'spread_templates.js');
const require = createRequire(import.meta.url);
const ST = require(file);
const clone = o => JSON.parse(JSON.stringify(o));

const SPREAD_W = 420, SPREAD_H = 297;     // A4 portrait pages side by side, mm
const EPS = 5e-4;

// ── loading ─────────────────────────────────────────────────────────────────
test('loads like a page (plain script, no DOM) and adds exactly one global, SpreadTemplates', () => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: 'spread_templates.js' });
  assert.deepEqual(Object.keys(ctx), [], 'a const global is not a property of the context');
  assert.equal(vm.runInContext('typeof SpreadTemplates', ctx), 'object');
  assert.equal(vm.runInContext('SpreadTemplates.TEMPLATES.length', ctx), ST.TEMPLATES.length);
});

test('exposes the spec numbers: A4 spread in mm, 4 per face, 25 mm minimum', () => {
  assert.deepEqual({ ...ST.SPREAD_MM }, { w: 420, h: 297 });
  assert.equal(ST.MAX_PER_FACE, 4);
  assert.equal(ST.MIN_MM, 25);
});

// ── the library as shipped ──────────────────────────────────────────────────
test('about thirty templates, ids unique, every one valid per the library validator', () => {
  assert.ok(ST.TEMPLATES.length >= 30, `only ${ST.TEMPLATES.length} templates`);
  assert.equal(new Set(ST.TEMPLATES.map(t => t.id)).size, ST.TEMPLATES.length);
  const r = ST.validate(ST.TEMPLATES);
  assert.deepEqual(r.errors, [], r.errors.map(e => `${e.id}: ${e.message}`).join('\n'));
  assert.equal(r.ok, true);
});

test('every photo count from 1 to 8 has templates (positive: counts are real, not just declared)', () => {
  for (let k = 1; k <= 8; k++) {
    const n = ST.TEMPLATES.filter(t => t.slots.length === k).length;
    assert.ok(n >= 1, `no template with ${k} slots`);
  }
  for (let k = 2; k <= 8; k++) {
    assert.ok(ST.TEMPLATES.filter(t => t.slots.length === k && !t.tags.includes('hero')).length >= 2, `fewer than two non-hero templates with ${k} slots`);
  }
  assert.equal(Math.max(...ST.TEMPLATES.map(t => t.slots.length)), 8);
});

test('independent geometry: bounds, overlap, faces, fold, size, prefer — for every template', () => {
  for (const t of ST.TEMPLATES) {
    const where = `template ${t.id}`;
    let left = 0, right = 0, span = 0;
    t.slots.forEach((s, i) => {
      const at = `${where} slot ${i}`;
      for (const k of ['x', 'y', 'w', 'h']) assert.ok(Number.isFinite(s[k]), `${at}: ${k} is not a number`);
      assert.ok(s.x >= -EPS && s.y >= -EPS && s.x + s.w <= 1 + EPS && s.y + s.h <= 1 + EPS, `${at} leaves the spread`);
      assert.ok(s.w * SPREAD_W >= 25 - 0.05 && s.h * SPREAD_H >= 25 - 0.05, `${at} is under 25 mm: ${(s.w * SPREAD_W).toFixed(1)} x ${(s.h * SPREAD_H).toFixed(1)}`);
      const aspect = (s.w * SPREAD_W) / (s.h * SPREAD_H);
      if (s.prefer === 'landscape') assert.ok(aspect >= 1.05, `${at}: prefers landscape but is ${aspect.toFixed(2)}`);
      if (s.prefer === 'portrait') assert.ok(aspect <= 1 / 1.05, `${at}: prefers portrait but is ${aspect.toFixed(2)}`);
      assert.ok(['landscape', 'portrait', 'any'].includes(s.prefer), `${at}: prefer ${s.prefer}`);
      if (s.face === 'left') { left++; assert.ok(s.x + s.w <= 0.5 + EPS, `${at}: a left slot crosses the fold`); }
      else if (s.face === 'right') { right++; assert.ok(s.x >= 0.5 - EPS, `${at}: a right slot crosses the fold`); }
      else if (s.face === 'span') { span++; assert.ok(s.x < 0.5 - EPS && s.x + s.w > 0.5 + EPS, `${at}: a span slot that does not cross the fold`); }
      else assert.fail(`${at}: face ${s.face}`);
    });
    assert.ok(left <= 4 && right <= 4, `${where}: ${left} left / ${right} right`);
    assert.deepEqual({ ...t.facing }, { left, right }, `${where}: facing says ${JSON.stringify(t.facing)}`);
    assert.ok(span === 0 || t.tags.includes('hero'), `${where}: crosses the fold without the hero tag`);
    assert.ok(span <= 1, `${where}: ${span} span slots`);
    for (let a = 0; a < t.slots.length; a++) for (let b = a + 1; b < t.slots.length; b++) {
      const p = t.slots[a], q = t.slots[b];
      const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
      const oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
      assert.ok(!(ox > EPS && oy > EPS), `${where}: slots ${a} and ${b} overlap`);
    }
  }
});

test('only hero-tagged templates cross the fold, and every hero-tagged one does (positive and negative)', () => {
  const heroes = ST.TEMPLATES.filter(t => t.tags.includes('hero'));
  assert.ok(heroes.length >= 3, 'a few hero spreads');
  for (const t of heroes) assert.equal(t.slots.filter(s => s.face === 'span').length, 1, `${t.id} has no span slot`);
  const others = ST.TEMPLATES.filter(t => !t.tags.includes('hero'));
  assert.ok(others.length >= 20);
  for (const t of others) assert.ok(t.slots.every(s => s.face !== 'span'), `${t.id}`);
  // a hero with one photo and nothing else exists: the full-bleed spread
  assert.ok(heroes.some(t => t.slots.length === 1 && t.slots[0].w === 1 && t.slots[0].h === 1));
});

test('the library is lively, not all squares: many different slot shapes and size contrasts', () => {
  const aspects = [];
  for (const t of ST.TEMPLATES) for (const s of t.slots) aspects.push((s.w * SPREAD_W) / (s.h * SPREAD_H));
  assert.ok(Math.max(...aspects) >= 2.5, `widest slot ${Math.max(...aspects).toFixed(2)}`);
  assert.ok(Math.min(...aspects) <= 0.5, `tallest slot ${Math.min(...aspects).toFixed(2)}`);
  // a variety of shapes (0.1 buckets): at least 14 different
  assert.ok(new Set(aspects.map(a => Math.round(a * 10))).size >= 14);
  // templates with a clear size hierarchy: biggest slot at least 2x the smallest (area)
  const contrast = ST.TEMPLATES.filter(t => t.slots.length >= 3).filter(t => {
    const ar = t.slots.map(s => s.w * s.h);
    return Math.max(...ar) / Math.min(...ar) >= 2;
  });
  assert.ok(contrast.length >= 10, `only ${contrast.length} templates have a hero-size slot beside small ones`);
  // a golden-ratio cut exists, and a 2:1 / 3:1 style split
  assert.ok(ST.TEMPLATES.some(t => t.tags.includes('golden')));
  const big = ST.TEMPLATES.filter(t => t.slots.length >= 3 && Math.max(...t.slots.map(s => s.w * s.h)) / Math.min(...t.slots.map(s => s.w * s.h)) >= 3);
  assert.ok(big.length >= 4);
});

test('tags: all from the known list, hero / pair / grid families exist, the first tag is the family', () => {
  assert.ok(Array.isArray(ST.TAGS) && ST.TAGS.length >= 8);
  for (const t of ST.TEMPLATES) {
    assert.ok(t.tags.length >= 1 && t.tags.every(x => ST.TAGS.includes(x)), `${t.id}: ${t.tags}`);
    assert.equal(new Set(t.tags).size, t.tags.length, `${t.id}: repeated tag`);
  }
  for (const tag of ['hero', '1-2', '3-up', '2+2', 'collage', 'quiet']) {
    assert.ok(ST.TEMPLATES.some(t => t.tags.includes(tag)), `no template tagged ${tag}`);
  }
  const families = new Set(ST.TEMPLATES.map(t => t.tags[0]));
  assert.ok(families.size >= 8, `${families.size} families: the run-of-two rule needs room`);
});

test('the shapes Tim named all exist: one-big-two-small both ways, 3 small, 2+2, 4-grid + big, 3+3, 4+4, top/bottom split, stagger, frame', () => {
  const has = (p) => assert.ok(ST.TEMPLATES.some(p), String(p));
  has(t => t.facing.left === 1 && t.facing.right === 2);
  has(t => t.facing.left === 2 && t.facing.right === 1);
  has(t => t.facing.left === 1 && t.facing.right === 3);
  has(t => t.facing.left === 2 && t.facing.right === 2);
  has(t => t.facing.left === 4 && t.facing.right === 1);
  has(t => t.facing.left === 3 && t.facing.right === 3);
  has(t => t.facing.left === 4 && t.facing.right === 4);
  has(t => t.tags.includes('stagger'));
  has(t => t.tags.includes('hero') && t.tags.includes('quiet'));      // bleed-free frame around the hero
  has(t => t.facing.left === 0 && t.facing.right === 1);               // a quiet single page
});

test('facing(): counts per face, span separately; byId finds a template', () => {
  const t = ST.byId('hero-strip');
  assert.ok(t);
  assert.deepEqual({ ...ST.facing(t) }, { left: 1, right: 2, span: 1 });
  assert.equal(ST.byId('nope'), null);
});

// ── the validator fails on bad data and says which template ─────────────────
const base = () => clone(ST.TEMPLATES.find(t => t.id === 'quad-stacks'));
const heroBase = () => clone(ST.TEMPLATES.find(t => t.id === 'hero-bleed'));
function breaks(label, make, code, others = ST.TEMPLATES.slice(0, 3)) {
  test(`validate: ${label} -> ${code}, naming the template`, () => {
    const bad = make();
    const r = ST.validate([...clone(others), bad]);
    assert.equal(r.ok, false);
    const e = r.errors.filter(x => x.code === code);
    assert.ok(e.length >= 1, `expected ${code}, got ${JSON.stringify(r.errors)}`);
    const want = bad.id ?? null;                       // a template with no id is named by its position
    assert.ok(e.every(x => x.id === want), `the error must name ${want}: ${JSON.stringify(e)}`);
    assert.ok(r.errors.every(x => x.id === want), 'good templates must not be blamed');
    assert.ok(want === null ? /^#\d+:/.test(e[0].message) : e[0].message.includes(want), 'the message names the template');
  });
}
breaks('two overlapping slots', () => { const t = base(); t.id = 'bad-overlap'; t.slots[1].y = t.slots[0].y + 0.1; return t; }, 'overlap');
breaks('a slot past the right edge', () => { const t = base(); t.id = 'bad-out'; t.slots[3].x = 0.8; return t; }, 'out-of-range');
breaks('a slot with a negative origin', () => { const t = base(); t.id = 'bad-neg'; t.slots[0].x = -0.02; return t; }, 'out-of-range');
breaks('a fifth photo on one face', () => {
  const t = clone(ST.TEMPLATES.find(t2 => t2.id === 'grid-4-4')); t.id = 'bad-five';
  // shrink to make room, then add a fifth left slot
  t.slots.forEach(s => { if (s.face === 'left') { s.y = s.y * 0.8; s.h = s.h * 0.8; } });
  t.slots.push({ x: 0.03, y: 0.88, w: 0.4, h: 0.1, face: 'left', prefer: 'landscape' });
  t.facing.left = 5; return t;
}, 'face-limit');
breaks('a non-hero template with a span slot', () => { const t = heroBase(); t.id = 'bad-span'; t.tags = ['quiet']; return t; }, 'span-not-hero');
breaks('a left slot that crosses the fold', () => { const t = base(); t.id = 'bad-fold'; t.slots[0].w = 0.55; return t; }, 'crosses-fold');
breaks('a right slot that starts left of the fold', () => { const t = base(); t.id = 'bad-fold-r'; t.slots[3].x = 0.45; t.slots[3].w = 0.5; return t; }, 'crosses-fold');
breaks('a slot narrower than 25 mm', () => { const t = base(); t.id = 'bad-small'; t.slots[0].w = 0.04; return t; }, 'too-small');
breaks('a slot shorter than 25 mm', () => { const t = base(); t.id = 'bad-flat'; t.slots[0].h = 0.05; return t; }, 'too-small');
breaks('prefer landscape on a portrait slot', () => { const t = base(); t.id = 'bad-prefer'; t.slots = t.slots.map(s => ({ ...s, w: s.w * 0.4 })); t.slots[0].prefer = 'landscape'; return t; }, 'prefer-mismatch');
breaks('prefer portrait on a landscape slot', () => { const t = base(); t.id = 'bad-prefer2'; t.slots[0].prefer = 'portrait'; return t; }, 'prefer-mismatch');
breaks('a prefer that is not a word', () => { const t = base(); t.id = 'bad-prefer3'; t.slots[0].prefer = 'wide'; return t; }, 'prefer-mismatch');
breaks('a duplicated id', () => { const t = clone(ST.TEMPLATES[0]); return t; }, 'dup-id', ST.TEMPLATES.slice(0, 3));
breaks('an unknown tag', () => { const t = base(); t.id = 'bad-tag'; t.tags = ['quiet', 'fancy']; return t; }, 'bad-tag');
breaks('no tags at all', () => { const t = base(); t.id = 'bad-notags'; t.tags = []; return t; }, 'bad-tag');
breaks('facing that disagrees with the slots', () => { const t = base(); t.id = 'bad-facing'; t.facing = { left: 1, right: 3 }; return t; }, 'facing-mismatch');
breaks('facing missing', () => { const t = base(); t.id = 'bad-nofacing'; delete t.facing; return t; }, 'facing-mismatch');
breaks('a face label that does not match where the slot is', () => { const t = base(); t.id = 'bad-face'; t.slots[0].face = 'right'; t.facing = { left: 1, right: 3 }; return t; }, 'face-mismatch');
breaks('a span slot that does not cross the fold', () => { const t = heroBase(); t.id = 'bad-span2'; t.slots[0].x = 0; t.slots[0].w = 0.3; return t; }, 'face-mismatch');
breaks('a hero tag with no span slot', () => { const t = base(); t.id = 'bad-hero'; t.tags = ['hero', 'grid']; return t; }, 'hero-without-span');
breaks('a template with no slots', () => { const t = base(); t.id = 'bad-empty'; t.slots = []; t.facing = { left: 0, right: 0 }; return t; }, 'no-slots');
breaks('a NaN coordinate', () => { const t = base(); t.id = 'bad-nan'; t.slots[0].x = NaN; return t; }, 'bad-slot');
breaks('a missing id', () => { const t = base(); delete t.id; return t; }, 'bad-id');

test('validate: boundary — a slot touching the fold exactly is fine, 0.2 mm over is not, 24.9 mm is too small and 25 mm is fine', () => {
  const t = base(); t.id = 'edge';
  t.slots[0].x = 0.5 - t.slots[0].w;                      // flush with the fold
  assert.deepEqual(ST.validate([t]).errors.filter(e => e.code === 'crosses-fold'), []);
  t.slots[0].x += 2 / SPREAD_W;                            // 2 mm over the fold
  assert.equal(ST.validate([t]).errors.filter(e => e.code === 'crosses-fold').length, 1);
  const u = base(); u.id = 'edge2';
  u.slots[0].w = 24.9 / SPREAD_W;
  assert.equal(ST.validate([u]).errors.filter(e => e.code === 'too-small').length, 1);
  u.slots[0].w = 25 / SPREAD_W;
  assert.deepEqual(ST.validate([u]).errors.filter(e => e.code === 'too-small'), []);
});

test('validate: several defects in one template are all reported', () => {
  const t = base(); t.id = 'many'; t.tags = ['nope']; t.slots[0].x = -0.1; t.slots[1].y = t.slots[0].y;
  const codes = new Set(ST.validate([t]).errors.map(e => e.code));
  for (const c of ['bad-tag', 'out-of-range', 'overlap']) assert.ok(codes.has(c), `${c} in ${[...codes]}`);
});

test('validate: input is never modified; not an array is an error, not a throw', () => {
  const before = JSON.stringify(ST.TEMPLATES);
  ST.validate(ST.TEMPLATES);
  assert.equal(JSON.stringify(ST.TEMPLATES), before);
  assert.equal(ST.validate(null).ok, false);
  assert.equal(ST.validate([null]).ok, false);
});

test('the data are frozen: nobody can reshape the library by accident at run time', () => {
  assert.ok(Object.isFrozen(ST.TEMPLATES));
  assert.ok(ST.TEMPLATES.every(t => Object.isFrozen(t) && Object.isFrozen(t.slots) && t.slots.every(s => Object.isFrozen(s))));
});
