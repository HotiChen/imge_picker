// Shared by auto_layout.test.mjs and the one-off script that recorded
// auto_layout.legacy-golden.json from the pre-refactor auto_layout.js.
// It drives the OLD public API (AutoLayout.run) with fake globals, so the
// recorded pages are exactly what the editor got before analyze/plan existed.

// natural size by photo id: a fixed mix of landscape, portrait, square; p07 never loads
export const DIMS = {
  p01: [600, 400], p02: [400, 600], p03: [400, 600], p04: [600, 400], p05: [500, 500],
  p06: [600, 400], p07: null, p08: [400, 600], p09: [600, 400], p10: [600, 400],
  p11: [400, 600], p12: [800, 400], p13: [400, 600],
};
export const RATINGS = { p01: 5, p03: 3, p04: 4, p05: 5, p06: 2, p07: 1, p09: 4, p10: 3, p12: 5, p13: 2 };
export const STYLES = ['magazine', 'uniform', 'story', 'byRating', 'random', 'no-such-style'];
export const SETS = { thirteen: 13, five: 5, one: 1 };

export const photosOf = n => Object.keys(DIMS).slice(0, n).map(id => ({ id, rating: RATINGS[id] || 0 }));

// deterministic Math.random for ids and the random style
export function lcg(seed = 12345) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

// Installs fake Image / driveManager / Date.now on globalThis, runs `fn`, restores them.
export async function withFakeBrowser(fn) {
  const saved = { Image: globalThis.Image, driveManager: globalThis.driveManager,
    random: Math.random, now: Date.now };
  globalThis.driveManager = { getImageUrl: (photo, w) => `fake://${photo.id}?w=${w}` };
  globalThis.Image = class {
    set src(url) {
      const id = String(url).replace('fake://', '').split('?')[0];
      const d = DIMS[id];
      setTimeout(() => {
        if (!d) { this.onerror && this.onerror(new Error('load failed')); return; }
        this.naturalWidth = d[0]; this.naturalHeight = d[1];
        this.onload && this.onload();
      }, 0);
    }
  };
  Date.now = () => 1700000000000;
  try { return await fn(); } finally {
    globalThis.Image = saved.Image; globalThis.driveManager = saved.driveManager;
    Math.random = saved.random; Date.now = saved.now;
  }
}

export async function recordLegacy(AutoLayout) {
  const out = {};
  for (const [setName, n] of Object.entries(SETS)) {
    for (const style of STYLES) {
      out[`${setName}/${style}`] = await withFakeBrowser(async () => {
        Math.random = lcg();
        return JSON.parse(JSON.stringify(await AutoLayout.run(photosOf(n), style)));
      });
    }
  }
  return out;
}
