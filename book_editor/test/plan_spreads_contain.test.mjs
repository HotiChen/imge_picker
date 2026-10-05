// node --test book_editor/test/plan_spreads_contain.test.mjs
//
// AutoLayout.planSpreads with fit: 'contain' (the default since Tim's LINE-browser check: cropping a photo to fill its
// slot "cuts off heads", so the album shows every photo whole). A slot gets { fit: 'contain', crop: {0,0,1} }; the cost
// is the WASTE (the share of the slot the whole photo does not cover), not the crop loss. The fit: 'cover' behaviour is
// pinned in plan_spreads.test.mjs (byte for byte). Everything here runs on synthetic items (what analyze() returns) and
// on the real contain geometry (AutoLayout.util.containBox, the function the viewer draws with).
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
const ST = vm.runInThisContext('SpreadTemplates');

const COVER = 210 / 297, SPREAD = 420 / 297;
const MAX_WASTE = 0.45;                         // the hard floor on one slot's waste (docs/album-preview.md)
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
  return { id, ok: o.ok ?? true, aspect, orientation: orientationOf(aspect), hash: o.hash ?? hashOf(seq++ + 500000),
    sharpness: o.sharp ?? 50, focus: o.focus ?? { x: 0.5, y: 0.5 } };
};
const pad = n => String(n).padStart(3, '0');
const ids = n => Array.from({ length: n }, (_, i) => `IMG_${pad(i + 1)}.jpg`);
const POOL = [1.5, 1.5, 1.5, 1.333, 0.667, 0.667, 0.8, 1.0, 1.778, 0.5625, 2.4, 0.4];         // harsh: a panorama, a very tall one
const NORMAL = [1.5, 1.5, 1.333, 1.5, 0.667, 0.667, 0.8, 0.75, 1.0, 1.778, 0.5625];            // what a phone and a camera make
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
const slotAspect = (slot, spread = SPREAD) => (slot.w / slot.h) * spread;
// the waste of one photo in one slot, measured the long way: draw it with containBox and count the area
const wasteByArea = (photoAspect, sa) => {
  const slotW = Math.round(sa * 100000), slotH = 100000;
  const b = AutoLayout.util.containBox(Math.round(photoAspect * 100000), 100000, slotW, slotH, { x: 0, y: 0, scale: 1 });
  return 1 - (b.w * b.h) / (slotW * slotH);
};
const wasteOf = (photoAspect, sa) => AutoLayout.util.wasteOf(photoAspect, sa);
const wastesOf = (plan, items, spread = SPREAD) => {
  const byId = new Map(items.map(i => [i.id, i]));
  return plan.spreads.flatMap(sp => sp.slots.map(s => wasteOf(byId.get(s.photoId).aspect, slotAspect(s.slot, spread))));
};
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

// every rule planSpreads promises, in contain mode
function check(plan, items, label, o = {}) {
  const maxPerFace = o.maxPerFace ?? 4;
  const spread = o.spreadAspect ?? SPREAD;
  const byId = new Map(items.map(i => [i.id, i]));
  const survivors = items.filter(i => i.ok && !plan.dropped.some(d => d.id === i.id));
  const placed = placedOf(plan);
  const expected = survivors.length === 2 || survivors.length === 3 ? survivors.length - 1 : survivors.length;
  if (survivors.length >= 1) assert.ok(plan.cover, `${label}: no cover`);
  if (survivors.length === 1) assert.equal(placed.length, 0, `${label}: one photo is the cover only`);
  else assert.equal(placed.length, expected, `${label}: placed ${placed.length}, expected ${expected}`);
  assert.equal(new Set(placed).size, placed.length, `${label}: a photo is placed twice`);
  for (const id of placed) assert.ok(byId.has(id) && !plan.dropped.some(d => d.id === id), `${label}: ${id} dropped or unknown`);
  plan.spreads.forEach((sp, n) => {
    const t = tpl(sp.template);
    assert.ok(t, `${label}: unknown template ${sp.template}`);
    assert.equal(sp.id, `spread-${n + 1}`);
    assert.equal(sp.slots.length, t.slots.length, `${label}: slots of ${t.id}`);
    const fc = faceCounts(t);
    assert.ok(fc.left <= maxPerFace && fc.right <= maxPerFace, `${label}: ${t.id} has ${fc.left}/${fc.right} on a face`);
    sp.slots.forEach((s, i) => {
      assert.ok(s.photoId, `${label}: empty slot`);
      assert.deepEqual({ ...s.slot }, { x: t.slots[i].x, y: t.slots[i].y, w: t.slots[i].w, h: t.slots[i].h, face: t.slots[i].face }, `${label}: slot geometry`);
      assert.equal(s.fit, 'contain', `${label}: ${t.id} slot ${i} fit`);
      assert.deepEqual({ ...s.crop }, { x: 0, y: 0, scale: 1 }, `${label}: ${t.id} slot ${i} crop`);
    });
  });
  const T = plan.spreads.map(s => s.template);
  for (let i = 1; i < T.length; i++) assert.notEqual(T[i], T[i - 1], `${label}: ${T[i]} twice running at ${i}`);
  for (let i = 2; i < T.length; i++) assert.ok(!(family(T[i]) === family(T[i - 1]) && family(T[i - 1]) === family(T[i - 2])), `${label}: family ${family(T[i])} three spreads running at ${i}`);
  for (let i = 0; i + 5 <= T.length; i++) assert.ok(T.slice(i, i + 5).filter(isHero).length <= 1, `${label}: two heroes within spreads ${i + 1}-${i + 5}`);
  const inner = placed.length;
  plan.spreads.forEach(sp => {
    if (sp.slots.length === 1 && inner > 1) assert.ok(isHero(sp.template), `${label}: a lone photo on a non-hero spread (${sp.template})`);
  });
  if (plan.spreads.length > 0 && inner > 1) {
    const last = plan.spreads[plan.spreads.length - 1];
    assert.ok(last.slots.length >= 2 || isHero(last.template), `${label}: the last spread is a lone ${last.template}`);
  }
  if (plan.cover) {
    const c = byId.get(plan.cover.photoId);
    assert.ok(c && c.ok, `${label}: cover is not a usable photo`);
    assert.equal(plan.cover.fit, 'contain', `${label}: cover fit`);
    assert.deepEqual({ ...plan.cover.crop }, { x: 0, y: 0, scale: 1 }, `${label}: cover crop`);
  }
  void spread;
}

// ── the contract: fit, crop, geometry ───────────────────────────────────────
test("contract: every slot and the cover say fit: 'contain' with crop {0,0,1} — by default and when asked, and an unknown value is the default too", () => {
  const items = randomItems(5, 40);
  for (const o of [{}, { fit: 'contain' }, { fit: 'nonsense' }, { fit: undefined }]) {
    const p = AutoLayout.planSpreads(items, o);
    assert.ok(p.spreads.length >= 6, 'control: a real book');
    assert.equal(p.cover.fit, 'contain');
    assert.deepEqual({ ...p.cover.crop }, { x: 0, y: 0, scale: 1 });
    for (const sp of p.spreads) for (const s of sp.slots) {
      assert.equal(s.fit, 'contain');
      assert.deepEqual({ ...s.crop }, { x: 0, y: 0, scale: 1 });
    }
  }
});

test('contract: the focus point plays no part — the same photos with other focus points make the same contain book', () => {
  const a = randomItems(6, 40);
  const b = a.map((it, i) => ({ ...it, focus: { x: ((i * 37) % 100) / 100, y: ((i * 53) % 100) / 100 } }));
  assert.equal(JSON.stringify(AutoLayout.planSpreads(a)), JSON.stringify(AutoLayout.planSpreads(b)));
});

test('geometry: containBox puts the WHOLE photo inside the slot, with its own aspect ratio, centred — on every slot of 30 books', () => {
  let slots = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const items = randomItems(seed + 200, 40);
    const byId = new Map(items.map(i => [i.id, i]));
    const p = AutoLayout.planSpreads(items);
    for (const sp of p.spreads) for (const s of sp.slots) {
      const ph = byId.get(s.photoId), sa = slotAspect(s.slot);
      const slotW = Math.round(sa * 1e5), slotH = 1e5;
      const natW = Math.round(ph.aspect * 1e5), natH = 1e5;
      const b = AutoLayout.util.containBox(natW, natH, slotW, slotH, s.crop);
      assert.ok(b.left >= -1e-6 && b.top >= -1e-6 && b.left + b.w <= slotW + 1e-6 && b.top + b.h <= slotH + 1e-6, `${s.photoId} leaves its slot`);
      assert.ok(Math.abs(b.w / b.h - natW / natH) / (natW / natH) < 1e-9, `${s.photoId} is stretched: ${b.w / b.h} vs ${natW / natH}`);
      assert.ok(Math.abs(b.left + b.w / 2 - slotW / 2) < 1e-6 && Math.abs(b.top + b.h / 2 - slotH / 2) < 1e-6, `${s.photoId} is not centred`);
      assert.ok(Math.abs(b.w - slotW) < 1e-6 || Math.abs(b.h - slotH) < 1e-6, `${s.photoId} touches neither side: it could be bigger`);
      slots++;
    }
  }
  assert.ok(slots > 800, `control: ${slots} slots were checked`);
});

test('geometry: containBox on hand-worked numbers (landscape in a tall slot, portrait in a wide one, an exact fit, a crop offset moves it)', () => {
  const eq = (got, want) => { for (const k of ['left', 'top', 'w', 'h']) assert.ok(Math.abs(got[k] - want[k]) < 1e-9, `${k}: ${got[k]} vs ${want[k]}`); };
  eq(AutoLayout.util.containBox(3000, 2000, 200, 400, { x: 0, y: 0, scale: 1 }), { left: 0, top: (400 - 200 / 1.5) / 2, w: 200, h: 200 / 1.5 });
  eq(AutoLayout.util.containBox(2000, 3000, 400, 200, { x: 0, y: 0, scale: 1 }), { left: (400 - 200 / 1.5) / 2, top: 0, w: 200 / 1.5, h: 200 });
  eq(AutoLayout.util.containBox(600, 400, 300, 200, { x: 0, y: 0, scale: 1 }), { left: 0, top: 0, w: 300, h: 200 });
  eq(AutoLayout.util.containBox(600, 400, 300, 200, undefined), { left: 0, top: 0, w: 300, h: 200 });
  const moved = AutoLayout.util.containBox(2000, 3000, 400, 200, { x: 0.1, y: 0, scale: 1 });
  assert.ok(Math.abs(moved.left - ((400 - 200 / 1.5) / 2 + 40)) < 1e-9, 'a crop offset (the editor can still set one) moves the box by x * slot width');
});

test('waste: wasteOf is 1 - min/max of the two aspects, and equals the uncovered area of the contain box', () => {
  assert.equal(wasteOf(1.5, 1.5), 0);
  assert.ok(Math.abs(wasteOf(1.5, 0.75) - 0.5) < 1e-12);
  assert.ok(Math.abs(wasteOf(0.75, 1.5) - 0.5) < 1e-12, 'symmetric');
  assert.ok(Math.abs(wasteOf(2 / 3, COVER) - (1 - (2 / 3) / COVER)) < 1e-12);
  assert.ok(Math.abs(wasteOf(3, 1) - 2 / 3) < 1e-12);
  for (const [a, b] of [[1.5, 1.0], [0.667, 1.414], [1.778, 0.707], [0.4, 2.4], [1.0, 1.0], [0.8, 0.707], [1.5, 1.414]]) {
    assert.ok(Math.abs(wasteOf(a, b) - wasteByArea(a, b)) < 1e-4, `${a} in ${b}: ${wasteOf(a, b)} vs ${wasteByArea(a, b)}`);
  }
});

// ── structure: every rule still holds ───────────────────────────────────────
test('structure: every rule holds on 120 seeded contain books of 0..90 photos (mixed shapes, some failed)', () => {
  const rnd = lcg(77);
  for (let s = 1; s <= 120; s++) {
    const n = Math.floor(rnd() * 91);
    const items = randomItems(s, n);
    if (n > 3 && s % 5 === 0) items[1].ok = false;
    check(AutoLayout.planSpreads(items), items, `seed ${s} n=${n}`);
  }
});

test('structure: all portrait, all landscape, all square, panoramas, ultra-tall, other page shapes and a smaller per-face cap', () => {
  for (const [name, a] of [['portrait', 0.667], ['landscape', 1.5], ['square', 1], ['pano', 2.8], ['tall', 0.36]]) {
    const items = uniform(23, a);
    check(AutoLayout.planSpreads(items), items, name);
  }
  for (let s = 1; s <= 15; s++) {
    const items = randomItems(500 + s, 10 + (s * 7) % 50);
    check(AutoLayout.planSpreads(items, { spreadAspect: 2, coverAspect: 1 }), items, `wide ${s}`, { spreadAspect: 2 });
    check(AutoLayout.planSpreads(items, { maxPerFace: 2 }), items, `cap2 ${s}`, { maxPerFace: 2 });
  }
});

test('edges: nothing, one photo (cover only, whole), two, three, four photos', () => {
  assert.deepEqual(AutoLayout.planSpreads([]), { cover: null, spreads: [], back: null, dropped: [] });
  const one = AutoLayout.planSpreads([item('a.jpg', { aspect: 0.7 })]);
  assert.equal(one.cover.photoId, 'a.jpg'); assert.equal(one.cover.fit, 'contain'); assert.deepEqual(one.spreads, []);
  for (const n of [2, 3, 4, 5, 8]) { const it = randomItems(n, n); check(AutoLayout.planSpreads(it), it, `n=${n}`); }
});

test('pure: deterministic, the input is frozen and untouched, no Math.random, no clock', () => {
  const items = randomItems(8, 55);
  const frozen = JSON.stringify(items);
  items.forEach(i => { Object.freeze(i.focus); Object.freeze(i); }); Object.freeze(items);
  const r = Math.random, n = Date.now;
  Math.random = () => { throw new Error('Math.random'); }; Date.now = () => { throw new Error('Date.now'); };
  let a, b;
  try { a = AutoLayout.planSpreads(items); b = AutoLayout.planSpreads(items); } finally { Math.random = r; Date.now = n; }
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify(items), frozen);
  assert.equal(JSON.stringify(AutoLayout.planSpreads(JSON.parse(frozen))), JSON.stringify(a));
});

test('speed: 240 photos plan in under 2 seconds (contain, where a relaxed floor means more cost tables)', () => {
  const items = randomItems(3, 240);
  const t0 = performance.now();
  const p = AutoLayout.planSpreads(items);
  const ms = performance.now() - t0;
  check(p, items, '240');
  assert.ok(ms < 2000, `${ms.toFixed(0)} ms`);
});

// ── the cost is the waste: the planner picks shapes that fit the photos ─────
// Baselines: (a) the book's own photo groups poured into the FIRST template of each size in reading order (a fixed pick,
// no seating), (b) the same groups poured into a pseudo-random template of that size, in reading order.
function baselineWaste(plan, items, pickTemplate, spread = SPREAD) {
  const sorted = items.slice().sort((a, b) => AutoLayout.util.naturalCompare(a.id, b.id));
  const placed = placedOf(plan);
  const byId = new Map(sorted.map(i => [i.id, i]));
  const bySize = {};
  for (const t of ST.TEMPLATES) (bySize[t.slots.length] ||= []).push(t);
  const w = [];
  let at = 0, n = 0;
  for (const sp of plan.spreads) {
    const group = placed.slice(at, at + sp.slots.length);
    const t = pickTemplate(bySize[sp.slots.length], n++);
    group.forEach((id, i) => w.push(wasteOf(byId.get(id).aspect, slotAspect(t.slots[i], spread))));
    at += sp.slots.length;
  }
  return mean(w);
}

test('waste: over 30 mixed 40-photo books the planner leaves far less paper uncovered than a fixed or random template pick, and no more than cover mode crops away', () => {
  let planned = 0, fixed = 0, random = 0, coverLoss = 0, books = 0;
  const rnd = lcg(4242);
  for (let seed = 1; seed <= 30; seed++) {
    const items = randomItems(seed + 4000, 40, NORMAL);
    const p = AutoLayout.planSpreads(items);
    const c = AutoLayout.planSpreads(items, { fit: 'cover' });
    planned += mean(wastesOf(p, items));
    coverLoss += mean(wastesOf(c, items));            // for cover mode this number is the share cropped away
    fixed += baselineWaste(p, items, list => list[0]);
    random += baselineWaste(p, items, list => list[Math.floor(rnd() * list.length)]);
    books++;
  }
  planned /= books; fixed /= books; random /= books; coverLoss /= books;
  assert.ok(planned <= 0.11, `mean waste ${planned.toFixed(3)} (fixed ${fixed.toFixed(3)}, random ${random.toFixed(3)}, cover-mode crop ${coverLoss.toFixed(3)})`);
  assert.ok(planned <= 0.5 * fixed && planned <= 0.5 * random, `planner ${planned.toFixed(3)} vs fixed ${fixed.toFixed(3)} / random ${random.toFixed(3)}`);
  assert.ok(planned <= coverLoss + 0.005, `contain ${planned.toFixed(3)} should not be worse than cover mode's crop loss ${coverLoss.toFixed(3)}`);
  assert.ok(fixed >= 0.2 && random >= 0.2, `control: the baselines really are wasteful (${fixed.toFixed(3)}, ${random.toFixed(3)})`);
});

// The one-shape bounds are measured, not wished: all-portrait 0.001-0.009 (the library is rich in portrait slots, so the
// bound is tight at 0.05 on purpose); all-3:2 landscape 0.05 without the usage price, 0.11-0.15 with it. The price (a template
// may carry only 3 spreads, spreadOutUsage) trades about 7-10 points of whitespace in a book of ONE shape for not repeating a
// layout 5 times in 12 spreads; mixed books pay nothing (0.0995 either way). 0.16 is the headroom over that, not a new target.
test('waste: the harsh pool (panoramas, ultra-tall) also stays under a mean of 0.14, and a one-shape book is as good as its shape allows', () => {
  let sum = 0;
  for (let seed = 1; seed <= 20; seed++) { const items = randomItems(seed + 700, 40); sum += mean(wastesOf(AutoLayout.planSpreads(items), items)); }
  assert.ok(sum / 20 <= 0.14, `mean waste ${(sum / 20).toFixed(3)}`);
  for (const a of [1.5, 0.667]) {
    const items = uniform(40, a);
    const m = mean(wastesOf(AutoLayout.planSpreads(items), items));
    assert.ok(m <= (a > 1 ? 0.16 : 0.05), `${a}: mean waste ${m.toFixed(3)}`);
  }
});

test('waste: the planner prefers a better-fitting template — a portrait-only book is seated in portrait-friendly slots, a landscape-only book in landscape ones', () => {
  const meanSlotAspect = items => { const p = AutoLayout.planSpreads(items); return mean(p.spreads.flatMap(s => s.slots.map(x => slotAspect(x.slot)))); };
  const portrait = meanSlotAspect(uniform(40, 0.667)), landscape = meanSlotAspect(uniform(40, 1.5));
  assert.ok(portrait < 1.0, `portrait photos sit in slots of mean aspect ${portrait.toFixed(2)}`);
  assert.ok(landscape > portrait + 0.4, `landscape ${landscape.toFixed(2)} vs portrait ${portrait.toFixed(2)}`);
});

// ── variety survives the stricter taste ─────────────────────────────────────
const usesOf = plan => plan.spreads.reduce((m, s) => ((m[s.template] = (m[s.template] || 0) + 1), m), {});
test('variety: over 30 mixed 40-photo books each uses at least 6 templates, none carries more than 3 spreads, none twice running', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const items = randomItems(seed + 4000, 40, NORMAL);
    const p = AutoLayout.planSpreads(items);
    const u = usesOf(p), T = p.spreads.map(s => s.template);
    assert.ok(Object.keys(u).length >= 6, `seed ${seed}: ${Object.keys(u).length} templates in ${T.length} spreads`);
    assert.ok(Math.max(...Object.values(u)) <= 3, `seed ${seed}: a template carries ${Math.max(...Object.values(u))} spreads: ${JSON.stringify(u)}`);
    assert.ok(new Set(T.map(family)).size >= 4, `seed ${seed}: families`);
  }
});

test('variety: a book whose shapes repeat (the same ten photos over and over — one template fits them best) still turns over templates', () => {
  for (const pat of [[1.5, 0.667, 1.5, 1.5, 0.667, 1.0, 2.0, 0.667, 1.5, 0.667], [1.5, 0.667, 1.5, 1.5, 0.8, 1.0, 1.778, 0.667, 1.333, 0.75]]) {
    const items = Array.from({ length: 44 }, (_, i) => item(`IMG_${pad(i + 1)}.jpg`, { aspect: pat[i % pat.length], sharp: 20 + (i * 37) % 60, hash: hashOf(5000 + i) }));
    const p = AutoLayout.planSpreads(items);
    check(p, items, 'periodic');
    const u = usesOf(p);
    assert.ok(Object.keys(u).length >= 6, `${Object.keys(u).length} templates: ${JSON.stringify(u)}`);
    assert.ok(Math.max(...Object.values(u)) <= 3, `a template carries ${Math.max(...Object.values(u))} spreads: ${JSON.stringify(u)}`);
    assert.ok(mean(wastesOf(p, items)) <= 0.12, `waste ${mean(wastesOf(p, items)).toFixed(3)}`);
  }
});

test('variety: all-landscape and all-portrait books of 40 are not one template repeated, and a long book may repeat a template in proportion (240 photos)', () => {
  for (const a of [1.5, 0.667]) {
    const T = AutoLayout.planSpreads(uniform(40, a)).spreads.map(s => s.template);
    assert.ok(new Set(T).size >= 4, `${a}: ${[...new Set(T)]}`);
    assert.ok(Math.max(...Object.values(T.reduce((m, t) => ((m[t] = (m[t] || 0) + 1), m), {}))) <= Math.ceil(T.length / 2), `${a}: one template carries half the book`);
  }
  const big = AutoLayout.planSpreads(randomItems(31, 240, NORMAL));
  assert.ok(Object.keys(usesOf(big)).length >= 12, `240 photos use ${Object.keys(usesOf(big)).length} templates`);
});

// ── the hard floor: a slot wastes at most 45% unless nothing else can be done ──
test('floor: on normal photo shapes no slot of any of 30 books wastes more than 45%', () => {
  let slots = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const items = randomItems(seed + 1300, 20 + (seed * 3) % 60, NORMAL);
    const w = wastesOf(AutoLayout.planSpreads(items), items);
    slots += w.length;
    assert.ok(Math.max(...w) <= MAX_WASTE + 1e-9, `seed ${seed}: a slot wastes ${(Math.max(...w) * 100).toFixed(0)}%`);
  }
  assert.ok(slots > 500, `control: ${slots} slots`);
});

test('floor: a book where, without the floor, the usage pricing pushes a slot to 47% waste — with it the worst slot stays at 31% (found by diffing the planner with and without the floor)', () => {
  const rnd = lcg(7 * 7);
  const items = Array.from({ length: 40 }, (_, i) => {
    const aspect = POOL[Math.floor(rnd() * POOL.length)];
    return { id: `I${String(i + 1).padStart(3, '0')}`, ok: true, aspect, orientation: orientationOf(aspect), hash: hashOf(7 * 100 + i), sharpness: Math.floor(rnd() * 100), focus: { x: 0.5, y: 0.5 } };
  });
  const w = wastesOf(AutoLayout.planSpreads(items), items);
  assert.ok(Math.max(...w) <= 0.35, `worst slot ${(Math.max(...w) * 100).toFixed(0)}%`);
  assert.ok(Math.max(...w) <= MAX_WASTE);
});

test('floor: a limit that cannot be met is relaxed (never a throw) — a library of wide strips for square photos wastes more than 45%, the full library for the same photos does not', () => {
  const strips = ST.TEMPLATES.filter(t => ['bands-4-4', 'triple-bands', 'seven-wide', 'five-wide', 'wide-three-one', 'pair-landscapes', 'hero-wide', 'solo-left'].includes(t.id));
  const items = uniform(30, 1.0);
  const tight = AutoLayout.planSpreads(items, { templates: strips });
  check(tight, items, 'strips');
  assert.ok(Math.max(...wastesOf(tight, items)) > MAX_WASTE, 'control: this library really cannot be seated within 45%');
  const full = AutoLayout.planSpreads(items);
  assert.ok(Math.max(...wastesOf(full, items)) <= MAX_WASTE + 1e-9, 'with the whole library the same square photos need no slot over 45%');
});

test('floor: the relaxation goes in steps — it takes the least wasteful slots it can, not whatever is cheapest', () => {
  const strips = ST.TEMPLATES.filter(t => ['bands-4-4', 'triple-bands', 'seven-wide', 'five-wide', 'wide-three-one', 'pair-landscapes', 'hero-wide', 'solo-left'].includes(t.id));
  const items = uniform(30, 1.0);
  const w = wastesOf(AutoLayout.planSpreads(items, { templates: strips }), items);
  assert.ok(mean(w) <= 0.7, `mean waste ${mean(w).toFixed(2)} in the relaxed book`);
});

// ── hero: a through-spread is for a landscape ───────────────────────────────
test('hero: with landscapes available no portrait or square-ish tall photo ever gets a through-spread (12 books, a third of them portrait)', () => {
  let heroes = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const rnd = lcg(seed * 91);
    const items = Array.from({ length: 40 }, (_, i) => item(`IMG_${pad(i + 1)}.jpg`, {
      aspect: rnd() < 0.33 ? [0.667, 0.8, 0.75, 0.5625][Math.floor(rnd() * 4)] : [1.5, 1.778, 1.333][Math.floor(rnd() * 3)],
      sharp: Math.floor(rnd() * 100), hash: hashOf(seed * 100 + i) }));
    const p = AutoLayout.planSpreads(items);
    const byId = new Map(items.map(i => [i.id, i]));
    for (const sp of p.spreads.filter(s => isHero(s.template))) {
      const ph = byId.get(sp.slots.find(x => x.slot.face === 'span').photoId);
      heroes++;
      assert.notEqual(ph.orientation, 'portrait', `seed ${seed}: a portrait (${ph.aspect}) on ${sp.template}`);
      const slot = tpl(sp.template).slots[0];
      assert.ok(wasteOf(ph.aspect, slotAspect(slot)) <= MAX_WASTE, `seed ${seed}: ${ph.aspect} wastes ${(wasteOf(ph.aspect, slotAspect(slot)) * 100).toFixed(0)}% of ${sp.template}`);
    }
  }
  assert.ok(heroes >= 8, `control: through-spreads are used (${heroes})`);
});

test('hero: a portrait-only book has no through-spread at all, and a hero-only library still seats a portrait when it must (the rule yields, the planner does not throw)', () => {
  const items = uniform(30, 0.667, 80);
  const p = AutoLayout.planSpreads(items);
  check(p, items, 'portraits');
  assert.ok(p.spreads.every(s => !isHero(s.template)), 'no hero for portraits');
  const only = ST.TEMPLATES.filter(t => t.tags.includes('hero'));
  const two = [item('a.jpg', { aspect: 0.667 }), item('b.jpg', { aspect: 0.667 })];
  const q = AutoLayout.planSpreads(two, { templates: only });
  assert.equal(q.spreads.length, 1); assert.ok(isHero(q.spreads[0].template), 'the only way to seat it');
});

test('hero: a sharp landscape does get one (positive control — the stronger direction rule did not switch heroes off)', () => {
  const items = uniform(40, 1.5, 70);
  const p = AutoLayout.planSpreads(items);
  assert.ok(p.spreads.some(s => isHero(s.template)));
  const T = p.spreads.map(s => s.template);
  for (let i = 0; i + 5 <= T.length; i++) assert.ok(T.slice(i, i + 5).filter(isHero).length <= 1);
});

test('hero: the cover photo is never also the through-spread', () => {
  for (let s = 1; s <= 20; s++) {
    const items = randomItems(900 + s, 20 + s, [1.5, 1.5, 0.7, 1.778]);
    const p = AutoLayout.planSpreads(items);
    for (const sp of p.spreads) if (isHero(sp.template)) assert.notEqual(sp.slots.find(x => x.slot.face === 'span').photoId, p.cover.photoId, `seed ${s}`);
  }
});

// ── the cover: a single A4 portrait page ────────────────────────────────────
test('cover: a sharp landscape and a panorama lose to a less sharp portrait (the cover is one tall page)', () => {
  const items = [item('a.jpg', { aspect: 2.5, sharp: 99 }), item('b.jpg', { aspect: 0.7, sharp: 40 }), item('c.jpg', { aspect: 1.5, sharp: 95 }),
    item('d.jpg', { aspect: 1.778, sharp: 90 }), item('e.jpg', { aspect: 0.75, sharp: 20 })];
  assert.equal(AutoLayout.planSpreads(items).cover.photoId, 'b.jpg');
});

test('cover: among the portraits that fit, the sharpest; a tie goes to the earlier', () => {
  const items = [item('a.jpg', { aspect: 0.667, sharp: 30 }), item('b.jpg', { aspect: 0.8, sharp: 80 }), item('c.jpg', { aspect: 0.7, sharp: 60 }),
    item('d.jpg', { aspect: 0.7, sharp: 80 }), item('e.jpg', { aspect: 1.5, sharp: 99 })];
  assert.equal(AutoLayout.planSpreads(items).cover.photoId, 'b.jpg');
});

test('cover: whenever the book has any portrait that fits the page (waste <= 25%) the cover wastes at most 25% — 30 mixed books', () => {
  let tested = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const items = randomItems(seed + 3000, 12 + seed, NORMAL);
    const p = AutoLayout.planSpreads(items);
    const byId = new Map(items.map(i => [i.id, i]));
    const fits = items.some(i => wasteOf(i.aspect, COVER) <= 0.25);
    if (!fits) continue;
    tested++;
    assert.ok(wasteOf(byId.get(p.cover.photoId).aspect, COVER) <= 0.25 + 1e-9, `seed ${seed}: the cover is ${byId.get(p.cover.photoId).aspect}`);
  }
  assert.ok(tested >= 25, `control: ${tested} of 30 books had a fitting portrait`);
});

test('cover: with no portrait at all, the photo that fits the tall page best wins — a square beats a 3:2, a 3:2 beats a panorama, sharpness only decides between equals', () => {
  const sq = [item('a.jpg', { aspect: 1.5, sharp: 90 }), item('b.jpg', { aspect: 1.0, sharp: 10 }), item('c.jpg', { aspect: 1.778, sharp: 99 })];
  assert.equal(AutoLayout.planSpreads(sq).cover.photoId, 'b.jpg');
  const ls = [item('a.jpg', { aspect: 2.5, sharp: 99 }), item('b.jpg', { aspect: 1.5, sharp: 10 }), item('c.jpg', { aspect: 1.778, sharp: 90 })];
  assert.equal(AutoLayout.planSpreads(ls).cover.photoId, 'b.jpg');
  const tie = [item('a.jpg', { aspect: 1.5, sharp: 10 }), item('b.jpg', { aspect: 1.5, sharp: 70 })];
  assert.equal(AutoLayout.planSpreads(tie).cover.photoId, 'b.jpg');
});

test('cover: coverAspect still decides — a wide cover wants a landscape; default is A4 portrait 210/297', () => {
  const items = [item('a.jpg', { aspect: 0.7, sharp: 90 }), item('b.jpg', { aspect: 1.5, sharp: 60 }), item('c.jpg', { aspect: 1.4, sharp: 20 }), item('d.jpg', { aspect: 0.6, sharp: 10 })];
  assert.equal(AutoLayout.planSpreads(items).cover.photoId, 'a.jpg');
  assert.equal(AutoLayout.planSpreads(items, { coverAspect: 1.5 }).cover.photoId, 'b.jpg');
});

test('cover: a failed photo is never the cover, even a perfectly shaped one', () => {
  const items = [item('a.jpg', { aspect: 0.707, sharp: 99, ok: false }), item('b.jpg', { aspect: 1.5, sharp: 10 }), item('c.jpg', { aspect: 1.4, sharp: 10 })];
  assert.notEqual(AutoLayout.planSpreads(items).cover.photoId, 'a.jpg');
});

test('plan() (the editor square-page planner) is untouched by all of this: no fit key, same answer twice', () => {
  const items = randomItems(4, 25);
  const p = AutoLayout.plan(items, { pageAspect: 1, coverAspect: 1 });
  assert.ok(p.pages.every(pg => pg.slots.every(s => !('fit' in s) && s.crop.scale === 1)));
  assert.equal(JSON.stringify(p), JSON.stringify(AutoLayout.plan(items, { pageAspect: 1, coverAspect: 1 })));
  assert.equal(p.cover.fit, undefined);
});
