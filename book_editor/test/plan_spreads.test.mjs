// node --test book_editor/test/plan_spreads.test.mjs
//
// AutoLayout.planSpreads: the pure planner for the A4 portrait album — a
// single-page cover, spreads of up to four photos per face, picked from the
// data in spread_templates.js. Everything is checked on synthetic items (what
// analyze() would return) and on real fitCoverImage geometry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lcg } from './legacy-fixture.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(dir, '..', 'js', f), 'utf8');
vm.runInThisContext(read('layouts.js'), { filename: 'layouts.js' });
vm.runInThisContext(read('spread_templates.js'), { filename: 'spread_templates.js' });
vm.runInThisContext(read('auto_layout.js'), { filename: 'auto_layout.js' });
const AutoLayout = vm.runInThisContext('AutoLayout');
// foldSafe (default true, plan_spreads_foldsafe.test.mjs) needs a foldRisk on every item; the fixtures here carry none,
// so they run the planner without that rule (the behaviour every assertion in this file was written against).
{ const planSpreads = AutoLayout.planSpreads; AutoLayout.planSpreads = (items, o = {}) => planSpreads(items, { foldSafe: false, ...o }); }
const ST = vm.runInThisContext('SpreadTemplates');

// planSpreads' default is now fit: 'contain' (whole photo, no crop; plan_spreads_contain.test.mjs). Everything in
// THIS file is the fit: 'cover' behaviour (crop to fill the slot, focus offsets), the switch Tim can flip back to:
// every call goes through planCover, which only adds { fit: 'cover' } and changes no assertion below.
const planCover = (items, o = {}) => AutoLayout.planSpreads(items, { fit: 'cover', ...o });

const COVER = 210 / 297, SPREAD = 420 / 297;
const HEX = '0123456789abcdef';
const hashOf = n => {
  let s = (n + 1) * 2654435761 >>> 0, h = '';
  for (let i = 0; i < 16; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; h += HEX[s >>> 28]; }
  return h;
};
const orientationOf = a => (Math.abs(a - 1) <= 0.05 ? 'square' : a > 1 ? 'landscape' : 'portrait');
let seq = 0;
const item = (id, o = {}) => {
  const aspect = o.aspect ?? 1.5;
  return { id, ok: o.ok ?? true, aspect, orientation: orientationOf(aspect), hash: o.hash ?? hashOf(seq++),
    sharpness: o.sharp ?? 50, focus: o.focus ?? { x: 0.5, y: 0.5 } };
};
const pad = n => String(n).padStart(3, '0');
const ids = n => Array.from({ length: n }, (_, i) => `IMG_${pad(i + 1)}.jpg`);
const POOL = [1.5, 1.5, 1.5, 1.333, 0.667, 0.667, 0.8, 1.0, 1.778, 0.5625, 2.4, 0.4];
function randomItems(seed, n, pool = POOL) {
  const rnd = lcg(seed), out = [];
  for (let i = 0; i < n; i++) {
    out.push(item(`IMG_${pad(i + 1)}.jpg`, { aspect: pool[Math.floor(rnd() * pool.length)], sharp: Math.floor(rnd() * 100),
      hash: hashOf(seed * 1000 + i), focus: { x: rnd(), y: rnd() } }));
  }
  return out;
}
const uniform = (n, aspect, sharp = 50) => ids(n).map((id, i) => item(id, { aspect, sharp: sharp + (i % 7), hash: hashOf(9000 + i) }));
const placedOf = plan => plan.spreads.flatMap(s => s.slots.map(x => x.photoId));
const tpl = id => ST.byId(id);
const isHero = id => tpl(id).tags.includes('hero');
const family = id => tpl(id).tags[0];
const faceCounts = t => ({ left: t.slots.filter(s => s.face === 'left').length, right: t.slots.filter(s => s.face === 'right').length });

// the real fitCoverImage geometry, as in auto_layout.test.mjs
function geometry(photoAspect, slotAspect, crop) {
  const slotW = Math.round(slotAspect * 100000), slotH = 100000;
  const img = { parentElement: { clientWidth: slotW, clientHeight: slotH },
    naturalWidth: Math.round(photoAspect * 100000), naturalHeight: 100000,
    dataset: { scale: String(crop.scale), cropx: String(crop.x), cropy: String(crop.y), rot: '0' }, style: {} };
  globalThis.fitCoverImage(img);
  return { left: parseFloat(img.style.left), top: parseFloat(img.style.top), w: parseFloat(img.style.width), h: parseFloat(img.style.height), slotW, slotH };
}
const covers = g => g.left <= 2 && g.top <= 2 && g.left + g.w >= g.slotW - 2 && g.top + g.h >= g.slotH - 2;

// every rule planSpreads promises, on one result
function check(plan, items, label, o = {}) {
  const maxPerFace = o.maxPerFace ?? 4;
  const byId = new Map(items.map(i => [i.id, i]));
  const survivors = items.filter(i => i.ok && !plan.dropped.some(d => d.id === i.id));
  const placed = placedOf(plan);
  const expected = survivors.length === 2 || survivors.length === 3 ? survivors.length - 1 : survivors.length;
  if (survivors.length >= 1) assert.ok(plan.cover, `${label}: no cover`);
  if (survivors.length === 1) assert.equal(placed.length, 0, `${label}: one photo is the cover only`);
  else assert.equal(placed.length, expected, `${label}: placed ${placed.length}, expected ${expected}`);
  assert.equal(new Set(placed).size, placed.length, `${label}: a photo is placed twice`);
  for (const id of placed) assert.ok(byId.has(id) && !plan.dropped.some(d => d.id === id), `${label}: ${id} dropped or unknown`);
  const seen = new Set();
  plan.spreads.forEach((sp, n) => {
    const t = tpl(sp.template);
    assert.ok(t, `${label}: unknown template ${sp.template}`);
    assert.equal(sp.id, `spread-${n + 1}`);
    assert.ok(!seen.has(sp.id)); seen.add(sp.id);
    assert.equal(sp.slots.length, t.slots.length, `${label}: slots of ${t.id}`);
    const fc = faceCounts(t);
    assert.ok(fc.left <= maxPerFace && fc.right <= maxPerFace, `${label}: ${t.id} has ${fc.left}/${fc.right} on a face`);
    assert.ok(sp.slots.length >= 1 && sp.slots.length <= 8, `${label}: ${sp.slots.length} photos on a spread`);
    sp.slots.forEach((s, i) => {
      assert.ok(s.photoId, `${label}: empty slot`);
      assert.deepEqual({ ...s.slot }, { x: t.slots[i].x, y: t.slots[i].y, w: t.slots[i].w, h: t.slots[i].h, face: t.slots[i].face }, `${label}: slot geometry`);
      assert.equal(s.crop.scale, 1);
      const photo = byId.get(s.photoId);
      const slotAspect = (t.slots[i].w / t.slots[i].h) * (o.spreadAspect ?? SPREAD);
      assert.ok(covers(geometry(photo.aspect, slotAspect, s.crop)), `${label}: ${s.photoId} leaves a gap in ${t.id} slot ${i}`);
    });
  });
  const T = plan.spreads.map(s => s.template);
  for (let i = 1; i < T.length; i++) assert.notEqual(T[i], T[i - 1], `${label}: ${T[i]} twice running at ${i}`);
  for (let i = 2; i < T.length; i++) assert.ok(!(family(T[i]) === family(T[i - 1]) && family(T[i - 1]) === family(T[i - 2])), `${label}: family ${family(T[i])} three spreads running at ${i}`);
  for (let i = 0; i + 5 <= T.length; i++) assert.ok(T.slice(i, i + 5).filter(isHero).length <= 1, `${label}: two heroes within spreads ${i + 1}-${i + 5}`);
  const inner = placed.length;
  plan.spreads.forEach((sp, n) => {
    if (sp.slots.length === 1 && inner > 1) assert.ok(isHero(sp.template), `${label}: a lone photo on a non-hero spread (${sp.template})`);
  });
  if (plan.spreads.length > 0 && inner > 1) {
    const last = plan.spreads[plan.spreads.length - 1];
    assert.ok(last.slots.length >= 2 || isHero(last.template), `${label}: the last spread is a lone ${last.template}`);
  }
  if (plan.cover) {
    const c = byId.get(plan.cover.photoId);
    assert.ok(c && c.ok, `${label}: cover is not a usable photo`);
    assert.equal(plan.cover.crop.scale, 1);
    assert.ok(covers(geometry(c.aspect, o.coverAspect ?? COVER, plan.cover.crop)), `${label}: the cover photo leaves a gap`);
  }
}

// ── edges ───────────────────────────────────────────────────────────────────
test('planSpreads exists and is separate from plan (plan keeps its old answer)', () => {
  assert.equal(typeof AutoLayout.planSpreads, 'function');
  const p = AutoLayout.plan(uniform(6, 1.5), { pageAspect: 1, coverAspect: 1 });
  assert.ok(Array.isArray(p.pages) && p.spreads === undefined);
});

test('edges: no photos -> nothing at all; every photo failed -> nothing, all dropped', () => {
  assert.deepEqual(planCover([]), { cover: null, spreads: [], back: null, dropped: [] });
  assert.deepEqual(planCover(null), { cover: null, spreads: [], back: null, dropped: [] });
  const items = ids(3).map(id => item(id, { ok: false }));
  const p = planCover(items);
  assert.equal(p.cover, null); assert.deepEqual(p.spreads, []);
  assert.deepEqual(p.dropped.map(d => d.reason), ['failed', 'failed', 'failed']);
});

test('edges: one photo -> a cover and no spread', () => {
  const p = planCover([item('a.jpg', { aspect: 0.7 })]);
  assert.equal(p.cover.photoId, 'a.jpg');
  assert.deepEqual(p.spreads, []);
  assert.equal(p.back, null);
  check(p, [item('a.jpg')], 'one');
});

test('edges: two photos -> the cover and one spread with the other photo (not the cover twice); three -> one spread with two', () => {
  const two = [item('a.jpg', { aspect: 0.7 }), item('b.jpg', { aspect: 1.5 })];
  const p2 = planCover(two);
  assert.equal(p2.spreads.length, 1);
  assert.deepEqual(placedOf(p2), [p2.cover.photoId === 'a.jpg' ? 'b.jpg' : 'a.jpg']);
  check(p2, two, 'two');
  const three = [item('a.jpg', { aspect: 0.7 }), item('b.jpg', { aspect: 1.5 }), item('c.jpg', { aspect: 1.5 })];
  const p3 = planCover(three);
  assert.equal(p3.spreads.length, 1, 'three photos make one spread');
  assert.equal(p3.spreads[0].slots.length, 2);
  assert.ok(!placedOf(p3).includes(p3.cover.photoId));
  check(p3, three, 'three');
});

test('edges: two photos, one of them landscape-sharp, make a quiet hero; two portraits make a single page, not a hero', () => {
  const p = planCover([item('a.jpg', { aspect: 0.7, sharp: 90 }), item('b.jpg', { aspect: 1.5, sharp: 20 })]);
  assert.ok(isHero(p.spreads[0].template), p.spreads[0].template);
  const q = planCover([item('a.jpg', { aspect: 0.7, sharp: 90 }), item('b.jpg', { aspect: 0.7, sharp: 20 })]);
  assert.equal(q.spreads.length, 1);
  assert.ok(!isHero(q.spreads[0].template), 'a portrait is not stretched over a spread: ' + q.spreads[0].template);
});

test('edges: four photos -> the cover photo also appears inside (nothing wasted); five and six fit one or two spreads', () => {
  const items = uniform(4, 0.75);
  const p = planCover(items);
  assert.equal(placedOf(p).length, 4);
  assert.ok(placedOf(p).includes(p.cover.photoId));
  check(p, items, 'four');
  for (const n of [5, 6, 7, 8, 9]) { const it = randomItems(n, n); check(planCover(it), it, `n=${n}`); }
});

test('edges: all portrait, all landscape, all square, all identical, panoramas, ultra-tall', () => {
  for (const [name, a] of [['portrait', 0.667], ['landscape', 1.5], ['square', 1], ['pano', 2.8], ['tall', 0.36]]) {
    const items = uniform(23, a);
    check(planCover(items), items, name);
  }
  const same = ids(6).map(id => item(id, { hash: '0123456789abcdef' }));
  const p = planCover(same, { dedupe: 'drop' });   // 'drop' = the legacy near-duplicate drop (the planSpreads default is now 'separate')
  assert.ok(p.cover, 'the survivor is the cover');
  assert.equal(p.dropped.filter(d => d.reason === 'duplicate').length, 5, 'six identical shots inside one window collapse to one');
  assert.deepEqual(p.spreads, []);
});

// ── coverage, structure, rules on many seeded sets ──────────────────────────
test('structure: every rule holds on 120 seeded sets of 0..90 photos (mixed shapes, some failed)', () => {
  const rnd = lcg(77);
  for (let s = 1; s <= 120; s++) {
    const n = Math.floor(rnd() * 91);
    const items = randomItems(s, n);
    if (n > 3 && s % 5 === 0) items[1].ok = false;
    check(planCover(items), items, `seed ${s} n=${n}`);
  }
});

test('structure: same rules with other page shapes, and with a smaller per-face cap', () => {
  for (let s = 1; s <= 25; s++) {
    const items = randomItems(500 + s, 10 + (s * 7) % 50);
    check(planCover(items, { spreadAspect: 2, coverAspect: 1 }), items, `wide ${s}`, { spreadAspect: 2, coverAspect: 1 });
    check(planCover(items, { maxPerFace: 2 }), items, `cap2 ${s}`, { maxPerFace: 2 });
  }
});

test('maxPerFace is a real filter: with 2 no template with a 3- or 4-photo face is used, and with 4 such templates are used (positive)', () => {
  const items = randomItems(31, 60);
  const used = p => new Set(p.spreads.map(s => s.template));
  const p2 = planCover(items, { maxPerFace: 2 });
  for (const id of used(p2)) { const f = faceCounts(tpl(id)); assert.ok(f.left <= 2 && f.right <= 2, id); }
  const p4 = planCover(items, { maxPerFace: 4 });
  assert.ok([...used(p4)].some(id => { const f = faceCounts(tpl(id)); return f.left >= 3 || f.right >= 3; }), 'control: the default does use busy faces');
  assert.ok(p4.spreads.some(s => s.slots.length >= 6));
});

// ── variety ─────────────────────────────────────────────────────────────────
test('variety: 40 mixed photos use at least 6 different templates and 4 families, never one twice running', () => {
  const items = randomItems(40, 40);
  const p = planCover(items);
  const T = p.spreads.map(s => s.template);
  assert.ok(new Set(T).size >= 6, `${new Set(T).size} templates in ${T.length} spreads: ${T}`);
  assert.ok(new Set(T.map(family)).size >= 4, [...new Set(T.map(family))].join());
  assert.ok(T.length >= 6 && T.length <= 14, `${T.length} spreads for 40 photos`);
});

test('variety: all-landscape and all-portrait books of 40 are not one template repeated', () => {
  for (const a of [1.5, 0.667]) {
    const T = planCover(uniform(40, a)).spreads.map(s => s.template);
    // photos of one shape fit fewer templates, so the bar is lower than for a mixed book
    assert.ok(new Set(T).size >= 4, `${a}: ${[...new Set(T)]}`);
    assert.ok(new Set(T.map(family)).size >= 3, `${a}: families`);
    assert.ok(Math.max(...Object.values(T.reduce((m, t) => ((m[t] = (m[t] || 0) + 1), m), {}))) <= Math.ceil(T.length / 2), `${a}: one template carries half the book`);
  }
});

test('variety: over 30 mixed 40-photo books no template carries more than 3 spreads, and the crops stay good (mean kept share of a photo >= 0.83 on this harsh pool with panoramas)', () => {
  let kept = 0, slots = 0, most = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const items = randomItems(seed + 4000, 40);
    const byId = new Map(items.map(i => [i.id, i]));
    const p = planCover(items);
    const uses = {};
    for (const sp of p.spreads) {
      uses[sp.template] = (uses[sp.template] || 0) + 1;
      for (const s of sp.slots) {
        const a = byId.get(s.photoId).aspect, b = (s.slot.w / s.slot.h) * SPREAD;
        kept += Math.min(a, b) / Math.max(a, b); slots++;
      }
    }
    most = Math.max(most, ...Object.values(uses));
  }
  assert.ok(most <= 3, `a template carried ${most} spreads`);
  assert.ok(kept / slots >= 0.83, `mean kept share ${(kept / slots).toFixed(3)}`);
});

test('variety: the same family never three spreads running — a family-heavy library is forced to rotate', () => {
  const only = ST.TEMPLATES.filter(t => ['quad-stacks', 'quad-columns', 'quad-stagger', 'grid-4-4', 'mosaic-4-4', 'trios', 'one-two-right', 'hero-bleed', 'pair-portraits'].includes(t.id));
  const items = uniform(36, 1.5);
  const p = planCover(items, { templates: only });
  check(p, items, 'rotate');
  const T = p.spreads.map(s => s.template);
  assert.ok(new Set(T).size >= 3);
});

// ── hero ────────────────────────────────────────────────────────────────────
test('hero: at most one in any five consecutive spreads, even when every photo is a sharp landscape (and some are used)', () => {
  const items = uniform(60, 1.5, 80);
  const p = planCover(items);
  const T = p.spreads.map(s => s.template);
  assert.ok(T.filter(isHero).length >= 1, 'control: a book of sharp landscapes has at least one through-spread');
  check(p, items, 'heroes');
  assert.ok(T.filter(isHero).length <= Math.ceil(T.length / 5), `${T.filter(isHero).length} heroes in ${T.length} spreads`);
});

test('hero: the through-spread photo is a sharp landscape — not a blurry one, not a portrait (8 wedding-like books)', () => {
  let books = 0, heroes = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const rnd = lcg(seed * 31);
    const items = Array.from({ length: 40 }, (_, i) => item(`IMG_${pad(i + 1)}.jpg`, {
      aspect: rnd() < 0.25 ? 0.7 : 1.5, sharp: Math.floor(rnd() * 100), hash: hashOf(seed * 100 + i) }));
    const p = planCover(items);
    const byId = new Map(items.map(i => [i.id, i]));
    const sorted = items.map(i => i.sharpness).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const heroPhotos = p.spreads.filter(s => isHero(s.template)).map(s => s.slots.find(x => x.slot.face === 'span').photoId);
    if (heroPhotos.length) books++;
    heroes += heroPhotos.length;
    for (const id of heroPhotos) {
      assert.equal(byId.get(id).orientation, 'landscape', `seed ${seed}: ${id} is not landscape`);
      assert.ok(byId.get(id).sharpness >= median, `seed ${seed}: a below-median photo (${byId.get(id).sharpness} < ${median}) got a through-spread`);
    }
  }
  assert.ok(books >= 6 && heroes >= 8, `control: heroes are used (${heroes} in ${books} of 8 books)`);
});

test('hero: the cover photo is never the through-spread twin of the cover', () => {
  for (let s = 1; s <= 30; s++) {
    const items = randomItems(900 + s, 20 + s, [1.5, 1.5, 0.7, 1.778]);
    const p = planCover(items);
    for (const sp of p.spreads) if (isHero(sp.template)) assert.notEqual(sp.slots.find(x => x.slot.face === 'span').photoId, p.cover.photoId, `seed ${s}`);
  }
});

test('hero: when every photo is a landscape the sharpest one becomes the cover — and then it is not also the through-spread (the first photo, where a hero fits best)', () => {
  const items = uniform(24, 1.5, 10).map((it, i) => ({ ...it, sharpness: i === 0 ? 99 : 10 + (i % 5), hash: hashOf(8100 + i) }));
  const p = planCover(items);
  assert.equal(p.cover.photoId, 'IMG_001.jpg');
  assert.ok(p.spreads.some(s => isHero(s.template)), 'control: the book has through-spreads');
  for (const sp of p.spreads) if (isHero(sp.template)) assert.notEqual(sp.slots.find(x => x.slot.face === 'span').photoId, 'IMG_001.jpg', 'the cover photo was repeated as a through-spread');
});

// ── pacing ──────────────────────────────────────────────────────────────────
test('rhythm: spreads carry 2..8 photos (a lone photo only on a hero), the last spread is never a stray photo — every n from 2 to 45', () => {
  for (let n = 2; n <= 45; n++) {
    const items = randomItems(2000 + n, n, [1.5, 0.7, 1.5, 0.7, 1.0]);
    const p = planCover(items);
    check(p, items, `n=${n}`);
    p.spreads.forEach(sp => assert.ok(sp.slots.length >= 2 || isHero(sp.template) || placedOf(p).length === 1, `n=${n}`));
  }
});

test('rhythm: not all spreads have the same photo count — busy and quiet alternate', () => {
  const p = planCover(randomItems(41, 60));
  assert.ok(new Set(p.spreads.map(s => s.slots.length)).size >= 4, [...new Set(p.spreads.map(s => s.slots.length))].join());
});

// ── the pure promises ───────────────────────────────────────────────────────
test('deterministic and pure: same input twice -> identical output; the input is frozen and untouched', () => {
  const items = randomItems(8, 55);
  const frozen = JSON.stringify(items);
  items.forEach(i => { Object.freeze(i.focus); Object.freeze(i); }); Object.freeze(items);
  const a = planCover(items), b = planCover(items);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify(items), frozen);
  const c = planCover(JSON.parse(frozen));
  assert.equal(JSON.stringify(c), JSON.stringify(a));
});

test('deterministic: no Math.random, no clock, no DOM — stubs that throw are never touched', () => {
  const items = randomItems(9, 40);
  const r = Math.random, n = Date.now;
  Math.random = () => { throw new Error('Math.random'); }; Date.now = () => { throw new Error('Date.now'); };
  try { planCover(items); } finally { Math.random = r; Date.now = n; }
});

test('the input order does not matter: file names decide (natural sort), shuffled input gives the same book', () => {
  const items = randomItems(10, 33);
  const shuffled = items.map(x => ({ x, k: Math.sin(items.indexOf(x) * 12.9898) })).sort((a, b) => a.k - b.k).map(o => o.x);
  assert.notDeepEqual(shuffled.map(i => i.id), items.map(i => i.id));
  assert.equal(JSON.stringify(planCover(shuffled)), JSON.stringify(planCover(items)));
});

test("order: 'given' keeps the caller's order", () => {
  const items = [item('z.jpg', { aspect: 0.7 }), item('a.jpg', { aspect: 0.7 }), item('m.jpg', { aspect: 0.7 }), item('b.jpg', { aspect: 0.7 }), item('c.jpg', { aspect: 0.7 })];
  const given = planCover(items, { order: 'given' });
  const natural = planCover(items);
  assert.equal(natural.cover.photoId, 'a.jpg', 'natural sort: a comes first, a tie goes to the earlier');
  assert.equal(given.cover.photoId, 'z.jpg', "given: z was first, and a tie goes to the earlier");
  const gIds = placedOf(given), nIds = placedOf(natural);
  assert.deepEqual([...gIds].sort(), [...nIds].sort());
  assert.notDeepEqual(gIds, nIds);
});

test('seed: the same seed is byte-identical, another seed gives another valid book (and default = seed 0)', () => {
  const items = randomItems(12, 60);
  const a = planCover(items, { seed: 7 }), b = planCover(items, { seed: 7 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify(planCover(items)), JSON.stringify(planCover(items, { seed: 0 })));
  let different = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const c = planCover(items, { seed });
    check(c, items, `seed ${seed}`);
    if (JSON.stringify(c.spreads.map(s => s.template)) !== JSON.stringify(a.spreads.map(s => s.template))) different++;
  }
  assert.ok(different >= 3, `only ${different} of 5 other seeds changed the book`);
});

test('speed: 240 photos plan in under 2 seconds', () => {
  const items = randomItems(3, 240);
  const t0 = performance.now();
  const p = planCover(items);
  const ms = performance.now() - t0;
  check(p, items, '240');
  assert.ok(ms < 2000, `${ms.toFixed(0)} ms`);
});

// ── dedupe, failed, order (the same engine as plan) ─────────────────────────
test('dedupe: near-identical neighbours collapse to the sharper one and say so', () => {
  const items = randomItems(15, 12);
  items[4] = item(items[4].id, { aspect: items[3].aspect, hash: items[3].hash, sharp: items[3].sharpness + 30 });
  const p = planCover(items, { dedupe: 'drop' });   // the legacy drop; the planSpreads default is 'separate' (plan_spreads_separate.test.mjs)
  const d = p.dropped.find(x => x.reason === 'duplicate');
  assert.ok(d, 'one is dropped');
  assert.equal(d.id, items[3].id); assert.equal(d.of, items[4].id);
  assert.ok(!placedOf(p).includes(items[3].id) && placedOf(p).includes(items[4].id) || p.cover.photoId === items[4].id);
  check(p, items, 'dedupe');
});

test('failed photos go to dropped and are never placed, not even on the cover', () => {
  const items = randomItems(16, 14);
  items[0].ok = false; items[5].ok = false;
  const p = planCover(items);
  assert.deepEqual(p.dropped.filter(d => d.reason === 'failed').map(d => d.id), [items[0].id, items[5].id]);
  assert.ok(![items[0].id, items[5].id].some(id => placedOf(p).includes(id) || p.cover.photoId === id));
});

// ── cover ───────────────────────────────────────────────────────────────────
test('cover: the sharpest photo whose shape suits a tall A4 cover; a razor-sharp panorama and a blurry portrait lose to a sharp portrait', () => {
  const items = [item('a.jpg', { aspect: 2.5, sharp: 99 }), item('b.jpg', { aspect: 0.7, sharp: 40 }), item('c.jpg', { aspect: 0.75, sharp: 70 }),
    item('d.jpg', { aspect: 1.5, sharp: 90 }), item('e.jpg', { aspect: 0.7, sharp: 10 }), item('f.jpg', { aspect: 1.5, sharp: 20 })];
  assert.equal(planCover(items).cover.photoId, 'c.jpg');
});

test('cover: coverAspect decides — a wide cover wants a landscape; default is A4 portrait 210/297', () => {
  const items = [item('a.jpg', { aspect: 0.7, sharp: 90 }), item('b.jpg', { aspect: 1.5, sharp: 60 }), item('c.jpg', { aspect: 1.4, sharp: 20 }), item('d.jpg', { aspect: 0.6, sharp: 10 })];
  assert.equal(planCover(items).cover.photoId, 'a.jpg');
  assert.equal(planCover(items, { coverAspect: 1.5 }).cover.photoId, 'b.jpg');
});

test('crop: the cover crop is computed for the A4 cover shape (a landscape photo is cropped sideways, subject toward the middle)', () => {
  const items = [item('a.jpg', { aspect: 1.5, sharp: 90, focus: { x: 0.25, y: 0.5 } }), item('b.jpg', { aspect: 1.5, sharp: 10 })];
  const p = planCover(items, { coverAspect: COVER });
  const c = p.cover.crop;
  assert.equal(p.cover.photoId, 'a.jpg');
  const r = 1.5 / COVER;
  assert.ok(Math.abs(c.x - Math.trunc(r * 0.25 * 1e4) / 1e4) < 1e-9 || Math.abs(c.x) <= (r - 1) / 2 + 1e-9);
  assert.ok(c.x > 0, 'the subject sits left, so the photo moves right');
  assert.equal(c.y, 0); assert.equal(c.scale, 1);
});

test('crop: slot crops follow the real slot shape (spreadAspect changes them), and the focus lands inside its slot', () => {
  const items = randomItems(21, 30);
  const a = planCover(items), b = planCover(items, { spreadAspect: 2.4 });
  assert.notEqual(JSON.stringify(a.spreads.map(s => s.slots.map(x => x.crop))), JSON.stringify(b.spreads.map(s => s.slots.map(x => x.crop))));
  const byId = new Map(items.map(i => [i.id, i]));
  for (const sp of a.spreads) for (const s of sp.slots) {
    const ph = byId.get(s.photoId), sa = (s.slot.w / s.slot.h) * SPREAD;
    const g = geometry(ph.aspect, sa, s.crop);
    const fx = (g.left + ph.focus.x * g.w) / g.slotW, fy = (g.top + ph.focus.y * g.h) / g.slotH;
    assert.ok(covers(g));
    assert.ok(fx >= -0.001 && fx <= 1.001 && fy >= -0.001 && fy <= 1.001, `focus left its slot: ${fx.toFixed(2)},${fy.toFixed(2)}`);
  }
});

// ── options: templates, whitelist, errors, back ─────────────────────────────
test('templates: only the whitelist is used', () => {
  const only = ['pair-portraits', 'quad-stacks', 'one-two-right', 'two-one-left', 'hero-frame', 'grid-4-4'].map(id => tpl(id));
  const items = randomItems(23, 40);
  const p = planCover(items, { templates: only });
  const allowed = new Set(only.map(t => t.id));
  assert.ok(p.spreads.every(s => allowed.has(s.template)));
  check(p, items, 'whitelist');
});

test('templates: a library that cannot seat the photos says so; the default library cannot fail', () => {
  const evens = ST.TEMPLATES.filter(t => t.slots.length === 2);
  assert.throws(() => planCover(randomItems(1, 11), { templates: evens }), /templates|seat/i);
  assert.throws(() => planCover(randomItems(1, 11), { templates: [] }), /templates|seat/i);
  for (let n = 2; n <= 30; n++) assert.doesNotThrow(() => planCover(randomItems(70 + n, n)));
});

test('templates: a template with a bad slot is skipped, never crashes the planner', () => {
  const bad = { id: 'bad', name: 'x', tags: ['quiet'], facing: { left: 1, right: 0 }, slots: [{ x: 0, y: 0, w: 0, h: 0.5, face: 'left', prefer: 'any' }] };
  const items = randomItems(2, 12);
  const p = planCover(items, { templates: [bad, ...ST.TEMPLATES] });
  assert.ok(p.spreads.every(s => s.template !== 'bad'));
});

test('templates: a non-hero template that crosses the fold is never used, even if the caller passes it (the planner re-checks, it does not trust the data)', () => {
  const sneaky = { id: 'aaa-sneaky', name: 'x', tags: ['quiet'], facing: { left: 0, right: 0 },
    slots: [{ x: 0.1, y: 0.1, w: 0.8, h: 0.8, face: 'span', prefer: 'landscape' }] };
  const crowded = { id: 'aaa-crowded', name: 'x', tags: ['quiet'], facing: { left: 5, right: 0 },
    slots: [0, 1, 2, 3, 4].map(i => ({ x: 0.02 + i * 0.09, y: 0.1, w: 0.08, h: 0.8, face: 'left', prefer: 'portrait' })) };
  const items = randomItems(6, 30);
  const p = planCover(items, { templates: [sneaky, crowded, ...ST.TEMPLATES] });
  assert.ok(p.spreads.every(s => s.template !== 'aaa-sneaky'), 'the non-hero span template was used');
  assert.ok(p.spreads.every(s => s.template !== 'aaa-crowded'), 'a five-photo page was used');
  // and with only the sneaky one there is nothing to seat the photos with
  assert.throws(() => planCover(items, { templates: [sneaky] }), /seat/);
});

test('a library with only pairs and single pages: the stray single page is never the last spread (and a lone photo is only used when nothing else can seat an odd count)', () => {
  const lib = ['pair-portraits', 'pair-landscapes', 'solo-left', 'solo-right'].map(id => tpl(id));
  for (const n of [6, 8, 10]) {                    // n photos -> n inner photos: an odd one out never needs to exist for even n...
    // n landscapes and, last in file order, one portrait: the portrait is exactly what a single page suits,
    // so only the rule keeps that single page off the end
    const items = [...uniform(n, 1.5).map((it, i) => ({ ...it, hash: hashOf(7000 + i) })), item(`IMG_${pad(n + 1)}.jpg`, { aspect: 0.66, hash: hashOf(7999) })];
    const p = planCover(items, { templates: lib });
    assert.equal(placedOf(p).length, n + 1, 'every photo is placed');
    const last = p.spreads[p.spreads.length - 1];
    assert.ok(last.slots.length >= 2, `the last spread is a lone ${last.template}`);
    assert.ok(p.spreads.some(s => s.slots.length === 1), 'control: an odd count really needs a single page here');
  }
});

test('back: none by default; { back: true } gives a blank closing page (no photo)', () => {
  const items = randomItems(4, 12);
  assert.equal(planCover(items).back, null);
  const b = planCover(items, { back: true }).back;
  assert.ok(b && typeof b === 'object' && !b.photoId);
  assert.equal(planCover([], { back: true }).back, null, 'no book, no back');
  assert.equal(planCover([item('a.jpg')], { back: true }).back, null, 'a cover alone has no back page');
});

test('without a templates option it reads the global SpreadTemplates; without that global it says what to load', () => {
  const ctx = vm.createContext({});
  vm.runInContext(read('layouts.js'), ctx);
  vm.runInContext(read('auto_layout.js'), ctx);
  const AL = vm.runInContext('AutoLayout', ctx);
  assert.throws(() => AL.planSpreads([item('a.jpg'), item('b.jpg')]), /spread_templates/);
});

// ── fit: 'cover' is the engine as it was before the contain default (byte for byte) ──
// sha256 (first 16 hex) of JSON.stringify(plan) from the engine at commit eea6a60, before `fit` existed.
const COVER_GOLDEN = { '1x40': '12b59f82e9871568', '2x12': '8b51e9268e4a4d2c', '3x90': 'c921a64b880c4dd7',
  '4x5': 'df0bf3c3b5f3f85b', '5x23': 'a046d0882ae64b93', '6x60': 'bb58ffba1fbac4db' };
test("fit: 'cover' answers byte-for-byte what the engine answered before `fit` existed (6 seeded books, 5 to 90 photos)", async () => {
  const { createHash } = await import('node:crypto');
  for (const [key, want] of Object.entries(COVER_GOLDEN)) {
    const [seed, n] = key.split('x').map(Number);
    const p = AutoLayout.planSpreads(randomItems(seed, n), { fit: 'cover' });
    assert.equal(createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16), want, `book ${key} changed in cover mode`);
    assert.ok(p.spreads.some(s => s.slots.some(x => x.crop.x !== 0 || x.crop.y !== 0)), `${key}: control: cover mode really crops`);
    assert.ok(p.spreads.every(s => s.slots.every(x => !('fit' in x))), `${key}: cover output carries no fit key (absent = cover, as in layouts.js)`);
  }
});

test("fit: leaving the option out is 'contain', not 'cover' (the new default), and the two really differ", () => {
  const items = randomItems(1, 40);
  const def = AutoLayout.planSpreads(items), con = AutoLayout.planSpreads(items, { fit: 'contain' }), cov = planCover(items);
  assert.equal(JSON.stringify(def), JSON.stringify(con));
  assert.notEqual(JSON.stringify(def), JSON.stringify(cov));
  assert.ok(def.spreads.every(s => s.slots.every(x => x.fit === 'contain')));
});

// ── the old engine is untouched ─────────────────────────────────────────────
test('plan() still answers exactly as before for the same items (no new keys, no changed pages)', () => {
  const items = randomItems(4, 25);
  const p = AutoLayout.plan(items, { pageAspect: 1, coverAspect: 1 });
  assert.deepEqual(Object.keys(p).sort(), ['cover', 'dropped', 'pages']);
  assert.ok(p.pages.every(pg => ['full-bleed', '1-up', '2-up-h', '2-up-v', '3-up', '4-grid'].includes(pg.layout)));
});
