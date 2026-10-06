// node --test book_editor/test/fold_risk.test.mjs
//
// The fold-risk heuristic (docs/album-preview.md, "Fold safety"): from the grey thumbnail analyze() already reads,
// how likely is it that a photo drawn across a spread has its subject on the fold? Pure helper on synthetic pixel
// arrays (util.foldRiskOf / util.foldStatsOf), and analyze() wiring (no extra request, same pixelsOf for browser and node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(dir, '..', 'js', f), 'utf8');
vm.runInThisContext(read('layouts.js'), { filename: 'layouts.js' });
vm.runInThisContext(read('auto_layout.js'), { filename: 'auto_layout.js' });
const AutoLayout = vm.runInThisContext('AutoLayout');
const U = AutoLayout.util;
const FOLD = AutoLayout.FOLD;

// a grey picture: f(u, v) in 0..1 coordinates -> 0..255
const grey = (w, h, f) => { const g = new Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = f((x + 0.5) / w, (y + 0.5) / h, x, y); return g; };
const W = 64, H = 40;
const FLAT = 128;
// a textured block (a busy subject: 1-pixel checker) between u0 and u1, flat grey elsewhere
const block = (u0, u1, v0 = 0.15, v1 = 0.85) => (u, v, x, y) => (u >= u0 && u < u1 && v >= v0 && v < v1 ? ((x + y) % 2 ? 230 : 25) : FLAT);
const rndOf = seed => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };
const risk = (g, w = W, h = H) => U.foldRiskOf(g, w, h);

test('constants: the documented numbers', () => {
  assert.equal(FOLD.W, 64); assert.equal(FOLD.H, 40);
  assert.equal(FOLD.BAND, 0.14);
  assert.equal(FOLD.LIMIT, 0.5);
  assert.ok(FOLD.RATIO_LO < FOLD.RATIO_HI);
  assert.ok(Object.isFrozen(FOLD));
});

test('(a) a sharp subject in the middle on a flat background is high risk', () => {
  const g = grey(W, H, block(0.4, 0.6));
  const s = U.foldStatsOf(g, W, H);
  assert.ok(s.ratio > 3, `the band is much busier than the photo: ${s.ratio}`);
  assert.ok(s.offset < 0.03, `centroid on the middle: ${s.offset}`);
  assert.ok(risk(g) >= 0.9, `risk ${risk(g)}`);
  assert.ok(risk(g) >= FOLD.LIMIT);
});

test('(a2) a wide subject in the middle is high too, and so is a small one right on the fold', () => {
  assert.ok(risk(grey(W, H, block(0.3, 0.7))) >= FOLD.LIMIT);
  assert.ok(risk(grey(W, H, block(0.47, 0.53, 0.3, 0.7))) >= FOLD.LIMIT);
});

test('(b) a sharp subject at 25% or at 75%, flat centre, is low risk', () => {
  for (const [u0, u1] of [[0.15, 0.35], [0.65, 0.85]]) {
    const g = grey(W, H, block(u0, u1));
    assert.ok(risk(g) < FOLD.LIMIT, `${u0}-${u1}: ${risk(g)}`);
    assert.equal(risk(g), 0, 'nothing at all in the band');
  }
});

test('(b2) two subjects, one each side of a flat centre (the centroid sits on the middle but nothing is on the fold): low', () => {
  const g = grey(W, H, (u, v, x, y) => (block(0.15, 0.3)(u, v, x, y) !== FLAT || block(0.7, 0.85)(u, v, x, y) !== FLAT ? ((x + y) % 2 ? 230 : 25) : FLAT));
  const s = U.foldStatsOf(g, W, H);
  assert.ok(s.offset < 0.03, `centroid ${s.offset}`);
  assert.equal(s.ratio, 0);
  assert.equal(risk(g), 0);
});

test('(c) a flat sky in the middle with detail at the edges is low risk', () => {
  const g = grey(W, H, (u, v, x, y) => (u < 0.3 || u >= 0.7 ? ((x * 7 + y * 3) % 5 < 2 ? 220 : 40) : FLAT));
  assert.ok(risk(g) < FOLD.LIMIT, `risk ${risk(g)}`);
});

test('(d) a uniform flat image is low risk (no subject to cut); so are a plain gradient and sensor noise', () => {
  assert.equal(risk(grey(W, H, () => FLAT)), 0);
  assert.equal(risk(grey(W, H, () => 0)), 0);
  assert.equal(risk(grey(W, H, () => 255)), 0);
  const ramp = grey(W, H, u => u * 255);
  assert.ok(risk(ramp) < FOLD.LIMIT, `ramp ${risk(ramp)}`);
  assert.equal(risk(grey(W, H, (u, v) => 40 + 160 * v)), 0, 'a vertical ramp');
  const r = rndOf(5);
  assert.equal(risk(grey(W, H, () => FLAT + (r() - 0.5) * 8)), 0, 'faint noise (a flat sky after JPEG) is under the detail floor');
});

test('(e) noise everywhere: ratio ~1, no particular subject on the fold: low (decided: the heuristic finds busy centres, not busy photos)', () => {
  for (const seed of [1, 2, 3, 4]) {
    const r = rndOf(seed);
    const g = grey(W, H, () => FLAT + (r() - 0.5) * 200);
    const s = U.foldStatsOf(g, W, H);
    assert.ok(s.ratio > 0.8 && s.ratio < 1.25, `seed ${seed}: ratio ${s.ratio}`);
    assert.ok(risk(g) < FOLD.LIMIT, `seed ${seed}: risk ${risk(g)}`);
    assert.ok(risk(g) > 0, 'but not zero: it is busy on the fold too');
  }
});

test('(f) missing or broken pixel data is HIGH risk (default deny)', () => {
  assert.equal(risk(null), 1);
  assert.equal(risk(undefined), 1);
  assert.equal(risk([]), 1);
  assert.equal(risk(new Array(10).fill(1)), 1, 'wrong length');
  assert.equal(risk(grey(W, H, () => FLAT), 0, 0), 1);
  assert.equal(risk(grey(W, H, () => FLAT), 2, 2), 1, 'too small to have an interior');
  const nan = grey(W, H, () => FLAT); nan[100] = NaN;
  assert.equal(risk(nan), 1);
  assert.equal(U.foldStatsOf(null, W, H), null);
});

test('the band: 14% of the width, centred. A subject just outside it is low, just inside it high; mirrored photos agree', () => {
  assert.ok(risk(grey(W, H, block(0.20, 0.42))) < FOLD.LIMIT, 'ends before 43%');
  assert.ok(risk(grey(W, H, block(0.58, 0.80))) < FOLD.LIMIT, 'starts after 57%');
  assert.ok(risk(grey(W, H, block(0.44, 0.50))) >= FOLD.LIMIT, 'inside, left of the fold');
  assert.ok(risk(grey(W, H, block(0.50, 0.56))) >= FOLD.LIMIT, 'inside, right of the fold');
  const g = grey(W, H, block(0.5, 0.8));
  const m = grey(W, H, block(0.2, 0.5));
  assert.ok(Math.abs(risk(g) - risk(m)) < 0.1, `mirror ${risk(g)} vs ${risk(m)}`);
});

test('monotone: sliding a subject from 25% towards the middle never lowers the risk, and it ends high', () => {
  let prev = -1;
  for (const c of [0.25, 0.32, 0.38, 0.42, 0.46, 0.5]) {
    const r = risk(grey(W, H, block(c - 0.07, c + 0.07)));
    assert.ok(r >= prev - 1e-9, `c=${c}: ${r} < ${prev}`);
    prev = r;
  }
  assert.ok(prev >= FOLD.LIMIT);
});

test('the answer does not depend on the grid it was computed on (64x40 vs 128x80 vs 48x30)', () => {
  const f = block(0.4, 0.6);
  for (const [w, h] of [[48, 30], [64, 40], [128, 80]]) {
    assert.ok(risk(grey(w, h, f), w, h) >= FOLD.LIMIT, `centred ${w}x${h}`);
    assert.ok(risk(grey(w, h, block(0.15, 0.35)), w, h) < FOLD.LIMIT, `side ${w}x${h}`);
  }
});

test('range and purity: always 0..1, never mutates, same input same output', () => {
  const r = rndOf(11);
  for (let i = 0; i < 40; i++) {
    const g = grey(W, H, () => r() * 255);
    const copy = g.slice();
    const a = risk(g), b = risk(g);
    assert.ok(a >= 0 && a <= 1 && Number.isFinite(a));
    assert.equal(a, b);
    assert.deepEqual(g, copy);
  }
});

// ── analyze wiring ──────────────────────────────────────────────────────────
const picture = (w, h, paint) => ({ naturalWidth: w, naturalHeight: h, paint });
const pixelsOf = (img, w, h) => {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = img.paint((x + 0.5) / w, (y + 0.5) / h, x, y);
    const o = (y * w + x) * 4;
    out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
  }
  return out;
};

test('analyze: foldRisk from the same thumbnail, no extra request: one load per photo, centred subject high, side subject low', async () => {
  const pics = {
    centre: picture(600, 400, block(0.4, 0.6)),
    side: picture(600, 400, block(0.15, 0.35)),
    flat: picture(600, 400, () => FLAT),
  };
  const loads = [], reads = [];
  const res = await AutoLayout.analyze(['centre', 'side', 'flat'], {
    urlFor: id => `u://${id}`,
    loadImage: async url => { loads.push(url); return pics[url.slice(4)]; },
    pixelsOf: (img, w, h) => { reads.push([w, h]); return pixelsOf(img, w, h); },
  });
  assert.equal(loads.length, 3, 'one image load per photo (no extra network request)');
  assert.deepEqual(reads.filter(([w, h]) => w === FOLD.W && h === FOLD.H).length, 3, 'one fold read per photo, at FOLD.W x FOLD.H');
  assert.equal(reads.length, 9, 'three canvas reads per photo in all (9x8, 32x32, fold grid)');
  const by = Object.fromEntries(res.map(r => [r.id, r]));
  assert.ok(by.centre.foldRisk >= FOLD.LIMIT, `centre ${by.centre.foldRisk}`);
  assert.ok(by.side.foldRisk < FOLD.LIMIT, `side ${by.side.foldRisk}`);
  assert.equal(by.flat.foldRisk, 0);
  for (const r of res) assert.ok(r.foldRisk >= 0 && r.foldRisk <= 1);
});

test('analyze: no pixels (aspectOnly, tainted canvas, failed load) means foldRisk null = unknown; the planner reads that as high', async () => {
  const ok = { urlFor: id => id, loadImage: async () => picture(300, 200, () => FLAT) };
  const a = await AutoLayout.analyze(['a'], { ...ok, aspectOnly: true, pixelsOf });
  assert.equal(a[0].foldRisk, null);
  const t = await AutoLayout.analyze(['a'], { ...ok, pixelsOf: () => { throw new Error('SecurityError'); } });
  assert.equal(t[0].ok, true); assert.equal(t[0].foldRisk, null);
  const f = await AutoLayout.analyze(['a'], { urlFor: id => id, loadImage: async () => { throw new Error('offline'); }, pixelsOf });
  assert.equal(f[0].ok, false); assert.equal(f[0].foldRisk, null);
  // a read that only fails on the third (fold) read keeps the rest of the analysis
  let n = 0;
  const p = await AutoLayout.analyze(['a'], { ...ok, pixelsOf: (img, w, h) => { if (++n === 3) throw new Error('x'); return pixelsOf(img, w, h); } });
  assert.equal(p[0].foldRisk, null);
  assert.notEqual(p[0].hash, '', 'the hash read before it is kept');
});
