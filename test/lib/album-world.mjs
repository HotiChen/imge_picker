// The album preview world (fake Worker + book fixtures + readiness probes) shared by the album
// preview suites.
// Shared by more than one file in test/suites/; helpers used by a single suite file stay in that file.
import { base } from './harness.mjs';
import { doneOpts } from './delivery-helpers.mjs';
import { pickFakeWorker } from './pick-fake.mjs';

export const ALB_DESK = { viewport: { width: 1280, height: 900 } };
// the guest's finals: `n` photos, the last `sub` of them in a subfolder
export const albKeys = (n, sub = 0) => Array.from({ length: n }, (_, i) =>
  `shoot/精修/${i >= n - sub ? '加洗/' : ''}IMG_${String(i + 1).padStart(4, '0')}.jpg`);
export const ALB_SHAPES = [[600, 400], [400, 600], [600, 400], [600, 400], [400, 600], [500, 500], [800, 400], [400, 600], [600, 400], [400, 600]];
// A recognisable picture: its own hue, seeded rectangles (so two different
// photos never hash alike), the number it stands for and a marker at its top.
export function albSvg(i, [w, h]) {
  let seed = 7919 * (i + 1), rects = '';
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const hue = (i * 47) % 360;
  for (let k = 0; k < 14; k++) {
    rects += `<rect x="${Math.floor(rnd() * w * 0.8)}" y="${Math.floor(rnd() * h * 0.8)}" ` +
      `width="${Math.floor(30 + rnd() * w * 0.4)}" height="${Math.floor(30 + rnd() * h * 0.4)}" ` +
      `fill="hsl(${(hue + Math.floor(rnd() * 90)) % 360},70%,${Math.floor(25 + rnd() * 55)}%)"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},60%,35%)"/>` +
    `<stop offset="1" stop-color="hsl(${(hue + 60) % 360},60%,55%)"/></linearGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#g)"/>${rects}` +
    `<polygon points="${w / 2 - 14},4 ${w / 2 + 14},4 ${w / 2},30" fill="#fff"/>` +
    `<text x="${w / 2}" y="${h * 0.62}" font-size="${Math.round(Math.min(w, h) * 0.36)}" font-family="sans-serif" font-weight="700" ` +
    `text-anchor="middle" fill="#fff" stroke="#000" stroke-width="3">${i + 1}${w > h ? 'L' : (w < h ? 'P' : 'S')}</text></svg>`;
}
export const ALBUM_SPIES = '(' + (() => {
  // what the album must not leave behind: storage writes, live timers, and
  // listeners on window / document
  window.__storageWrites = [];
  for (const m of ['setItem', 'removeItem', 'clear']) {
    const o = Storage.prototype[m];
    Storage.prototype[m] = function (...a) { window.__storageWrites.push([m, ...a]); return o.apply(this, a); };
  }
  window.__timers = new Map(); let seq = 0;
  const st = window.setTimeout, ct = window.clearTimeout, si = window.setInterval, ci = window.clearInterval;
  window.setTimeout = (fn, d, ...a) => { const s = ++seq; const id = st(function () { window.__timers.delete(id); return typeof fn === 'function' ? fn.apply(this, a) : undefined; }, d); window.__timers.set(id, { kind: 't', d, s }); return id; };
  window.clearTimeout = id => { window.__timers.delete(id); return ct(id); };
  window.setInterval = (fn, d, ...a) => { const id = si(fn, d, ...a); window.__timers.set(id, { kind: 'i', d, s: ++seq }); return id; };
  window.clearInterval = id => { window.__timers.delete(id); return ci(id); };
  window.__timerSeq = () => seq;
  window.__alive = [];
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
  const watched = t => t === window || t === document;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (watched(this)) {
      const cap = typeof opts === 'object' ? !!(opts && opts.capture) : !!opts;
      if (!window.__alive.some(e => e.t === this && e.type === type && e.fn === fn && e.cap === cap)) window.__alive.push({ t: this, type, fn, cap });
    }
    return add.call(this, type, fn, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    if (watched(this)) {
      const cap = typeof opts === 'object' ? !!(opts && opts.capture) : !!opts;
      window.__alive = window.__alive.filter(e => !(e.t === this && e.type === type && e.fn === fn && e.cap === cap));
    }
    return rem.call(this, type, fn, opts);
  };
}).toString() + ')();';
export const ALB_OWNER = `localStorage.setItem('pick_key:TOK', 'ZOE-KEY');${ALBUM_SPIES}`;
export const ALB_VIEWER = ALBUM_SPIES;

// A pick link whose finals are `files` (SVG photos), the proofs untouched.
// `ctl` changes what the Worker answers while a test is running.
export function albumWorld(o = {}) {
  const files = o.files || albKeys(o.n ?? 48, o.sub ?? 0);
  const dup = o.dup || {};                       // index -> index whose picture it repeats
  const idx = new Map(files.map((k, i) => [k, i]));
  const m = pickFakeWorker(doneOpts({ pickFiles: ['shoot/毛片/a.jpg', ...files], ...(o.fake || {}) }));
  const log = [];                                // every request the page sent to the Worker
  const assets = [];                             // every request the page sent to the static host
  const ctl = { failImages: false, failList: 0, hold: null, waiting: [], imageHits: 0, corsHits: 0 };
  const svgFor = key => { const i = idx.get(key); const src = dup[i] ?? i; const shapes = o.shapes || ALB_SHAPES; return albSvg(src, shapes[src % shapes.length]); };
  const answer = async (route, key) => {
    try {
      await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svgFor(key),
        headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
    } catch (e) { /* the page gave up on it */ }
  };
  const before = async page => {
    page.on('request', r => { if (r.url().startsWith(base)) assets.push(new URL(r.url()).pathname + new URL(r.url()).search); });
    await m.attach(page);
    await page.route('**/imagepicker.hotichen.workers.dev/**', async route => {
      const req = route.request();
      const u = new URL(req.url());
      const method = req.method();
      const key = decodeURIComponent(u.pathname.slice(1));
      const fetchMode = (await req.allHeaders()).origin ? 'cors' : 'no-cors';   // a crossOrigin image sends Origin, a plain <img> does not
      log.push({ method, path: u.pathname, key, mode: fetchMode, w: u.searchParams.get('w'), list: u.searchParams.get('list'), download: u.searchParams.get('download'), t: u.searchParams.get('t') });
      if (method === 'GET' && u.searchParams.has('list') && ctl.failList > 0) {
        ctl.failList--;
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' });
      }
      if (method === 'GET' && idx.has(key) && u.searchParams.has('w')) {
        ctl.imageHits++;
        if (fetchMode === 'cors') ctl.corsHits++;   // the engine's crossOrigin loads, not the gallery's own <img>
        if (ctl.failImages) return route.fulfill({ status: 404, body: 'Object Not Found', headers: { 'Access-Control-Allow-Origin': '*' } });
        if (ctl.hold && u.searchParams.get('w') === '400') {
          ctl.hold.seen++;
          if (ctl.hold.seen > ctl.hold.allow) { ctl.waiting.push(() => answer(route, key)); return; }
        }
        return answer(route, key);
      }
      return route.fallback();
    });
  };
  const release = () => { ctl.hold = null; const w = ctl.waiting.splice(0); w.forEach(f => f()); };
  return { m, files, log, assets, ctl, before, release, keys: new Set(files) };
}

// The finals gallery's lazy tiles load as the page scrolls, and the entry sits under the last row: scroll to it
// (a press does) and let every read that wakes up finish, so the audits below count only what the album asks for.
export const albGalleryReady = async page => {
  await page.waitForSelector('#albumPreviewBtn', { timeout: 5000 });
  await page.waitForSelector('.fg-tile', { timeout: 5000 });
  await page.evaluate(() => document.getElementById('albumPreviewBtn').scrollIntoView({ block: 'center' }));
  await page.evaluate(async () => {
    let last = -1, since = performance.now();
    for (;;) {
      await new Promise(r => setTimeout(r, 80));
      const n = performance.getEntriesByType('resource').length;
      if (n !== last) { last = n; since = performance.now(); }
      if (performance.now() - since > 600) return;
    }
  });
};
export const albSnap = page => page.evaluate(() => {
  const v = document.getElementById('albumViewer');
  if (!v) return null;
  const key = img => decodeURIComponent(new URL(img.src).pathname.slice(1));
  const slides = [...v.querySelectorAll('.album-slide')].map(s => ({
    i: +s.dataset.index, cur: s.dataset.current === 'true', layout: s.querySelector('.album-page')?.dataset.layout ?? null,
    ids: [...s.querySelectorAll('img')].map(key),
  }));
  const dis = id => { const b = document.getElementById(id); return b ? b.disabled : null; };
  return { state: v.dataset.state, label: document.getElementById('albumLabel')?.textContent ?? null,
    slides, prevDis: dis('albumPrev'), nextDis: dis('albumNext'), imgs: v.querySelectorAll('img').length,
    note: document.getElementById('albumNote')?.textContent ?? '' };
});
export const albReady = page => page.waitForFunction(() => document.getElementById('albumViewer')?.dataset.state === 'ready', null, { timeout: 20000 });
export const albShot = async (page, name) => { if (process.env.SHOTS_ALBUM) await page.screenshot({ path: `${process.env.SHOTS_ALBUM}/${name}.png` }); };
export const albPending = (page, since) => page.evaluate(s => [...window.__timers.values()].filter(t => t.s > s).map(t => `${t.kind}${t.d}`), since);
