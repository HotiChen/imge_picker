// 自動排版演算法
//
// Two layers, so the same engine runs in the photographer's editor and on the
// client's phone (docs/album-preview.md):
//   analyze(ids, opts)  — the only part with I/O: loads each ?w=400 thumbnail and
//                         measures it (aspect, dHash, sharpness, focus point).
//   plan(items, opts)   — a pure, deterministic function of analyze's output:
//                         de-duplicates, orders, paces and crops. No DOM, no
//                         network, no Math.random.
//   run(photos, style)  — the editor's original five styles, unchanged.
//
// Loading this file has no side effects and adds one global, AutoLayout. It
// reads the global LAYOUTS (layouts.js) only when plan() is called without an
// explicit `layouts`, and driveManager only inside run().
const AutoLayout = (() => {

    // ─── tunables (all documented in docs/album-preview.md) ────────────────
    const DEFAULTS = Object.freeze({
        hashThreshold: 6,       // dHash Hamming distance (of 64 bits) at or under which two shots are one
        window: 5,              // ...if they are at most this many positions apart in shooting order
        concurrency: 6,         // thumbnails loaded at once
        photosPerPage: 2.5,     // page-count target when `pages` is not given...
        densityPull: 0.6,       // ...which is only a pull: one page off costs this much layout quality
    });
    const BUILTIN_LAYOUT_IDS = ['full-bleed', '1-up', '2-up-h', '2-up-v', '3-up', '4-grid'];
    const FOCUS_MIN = 0.2, FOCUS_MAX = 0.8;          // a centroid on the very edge is noise, not a subject
    const SQUARE_TOLERANCE = 0.05;                   // |aspect - 1| within 5% counts as square
    const COVER_MIN_FIT = 0.6;                       // a cover photo must keep >= 60% of itself
    const FEW_PHOTOS = 3;                            // 2..3 photos: the cover is not repeated inside
    const HERO_GAP = 3;                              // full-bleed pages need 3 other pages between them
    const CRUSH_BELOW = 0.4;                         // a slot may keep < 40% of a photo only if nothing else fits
    const MAX_RUN = 2;                               // same layout at most twice running
    const REPEAT_COST = 0.12;                        // mild dislike of the same layout twice running
    const LONE_LAST_COST = 0.4;                      // ending on a single full-bleed photo is allowed, not encouraged
    const ORDER_COST = 0.02;                         // per photo pair swapped inside a page

    // ─── small pure helpers ────────────────────────────────────────────────
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    // toward zero, never past the limit the photo needs to keep covering its slot; + 0 turns -0 into 0
    const round4 = v => Math.trunc(v * 1e4) / 1e4 + 0;

    function abortError(signal) {
        if (signal && signal.reason instanceof Error) return signal.reason;
        if (typeof DOMException === 'function') return new DOMException('Aborted', 'AbortError');
        const e = new Error('Aborted'); e.name = 'AbortError'; return e;
    }

    // Number-aware, case-insensitive; IMG_9 < IMG_10. Total order: names that
    // only differ in case or zero padding still compare unequal, so the result
    // never depends on the engine's sort stability or the locale.
    function naturalCompare(a, b) {
        const ta = String(a).toLowerCase().match(/\d+|\D+/g) || [];
        const tb = String(b).toLowerCase().match(/\d+|\D+/g) || [];
        const n = Math.min(ta.length, tb.length);
        for (let i = 0; i < n; i++) {
            const x = ta[i], y = tb[i];
            const dx = x.charCodeAt(0) >= 48 && x.charCodeAt(0) <= 57;
            const dy = y.charCodeAt(0) >= 48 && y.charCodeAt(0) <= 57;
            if (dx && dy) {
                const nx = x.replace(/^0+/, ''), ny = y.replace(/^0+/, '');
                if (nx.length !== ny.length) return nx.length < ny.length ? -1 : 1;
                if (nx !== ny) return nx < ny ? -1 : 1;
            } else if (dx !== dy) {
                return dx ? -1 : 1;                 // digits sort before letters
            } else if (x !== y) {
                return x < y ? -1 : 1;
            }
        }
        if (ta.length !== tb.length) return ta.length < tb.length ? -1 : 1;
        const ra = String(a), rb = String(b);
        if (ra.length !== rb.length) return ra.length < rb.length ? -1 : 1;
        return ra === rb ? 0 : (ra < rb ? -1 : 1);
    }

    // RGBA -> grey, one number per pixel
    function toGray(rgba) {
        const n = Math.floor(rgba.length / 4);
        const g = new Array(n);
        for (let i = 0; i < n; i++) {
            g[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
        }
        return g;
    }

    // difference hash: 9 columns x 8 rows of grey; bit = "this pixel is brighter
    // than the one to its right", row-major, MSB first -> 16 hex characters
    function dHash(gray) {
        let hex = '';
        for (let row = 0; row < 8; row++) {
            for (let nib = 0; nib < 2; nib++) {
                let v = 0;
                for (let b = 0; b < 4; b++) {
                    const x = nib * 4 + b;
                    v = (v << 1) | (gray[row * 9 + x] > gray[row * 9 + x + 1] ? 1 : 0);
                }
                hex += v.toString(16);
            }
        }
        return hex;
    }

    const POP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
    // Infinity when either hash is missing or they are not comparable, so
    // "unknown" is never "close".
    function hamming(a, b) {
        if (!a || !b || a.length !== b.length) return Infinity;
        let d = 0;
        for (let i = 0; i < a.length; i++) {
            const x = parseInt(a[i], 16), y = parseInt(b[i], 16);
            if (Number.isNaN(x) || Number.isNaN(y)) return Infinity;
            d += POP[x ^ y];
        }
        return d;
    }

    // variance of the 4-neighbour Laplacian over the 30x30 interior of a 32x32 grey
    function sharpnessOf(g) {
        const S = 32;
        let sum = 0, sum2 = 0, n = 0;
        for (let y = 1; y < S - 1; y++) {
            for (let x = 1; x < S - 1; x++) {
                const i = y * S + x;
                const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - S] - g[i + S];
                sum += lap; sum2 += lap * lap; n++;
            }
        }
        const mean = sum / n;
        return Math.max(0, sum2 / n - mean * mean);
    }

    // centre of gradient energy of a 32x32 grey, as 0..1 fractions of the photo,
    // clamped to FOCUS_MIN..FOCUS_MAX. A flat picture has no subject: the middle.
    function focusOf(g) {
        const S = 32;
        let e = 0, ex = 0, ey = 0;
        for (let y = 1; y < S - 1; y++) {
            for (let x = 1; x < S - 1; x++) {
                const i = y * S + x;
                const gx = g[i + 1] - g[i - 1], gy = g[i + S] - g[i - S];
                const w = gx * gx + gy * gy;
                e += w; ex += w * (x + 0.5); ey += w * (y + 0.5);
            }
        }
        if (!(e > 0)) return { x: 0.5, y: 0.5 };
        return { x: clamp(ex / e / S, FOCUS_MIN, FOCUS_MAX), y: clamp(ey / e / S, FOCUS_MIN, FOCUS_MAX) };
    }

    const orientationOfAspect = a =>
        Math.abs(a - 1) <= SQUARE_TOLERANCE ? 'square' : (a > 1 ? 'landscape' : 'portrait');

    // The crop that brings `focus` towards the middle of a slot, with the photo
    // drawn exactly as layouts.js fitCoverImage / exporter.js draw it:
    //   s = max(scale*slotW/natW, scale*slotH/natH); left = (slotW-drawW)/2 + crop.x*slotW
    // At scale 1 only one axis overflows. With r = photoAspect/slotAspect:
    //   r > 1: drawW = r*slotW, so crop.x = r*(0.5-fx), at most (r-1)/2 either way
    //   r < 1: drawH = slotH/r, so crop.y = (0.5-fy)/r, at most (1/r-1)/2 either way
    // The limit is what keeps the photo covering the slot. scale stays 1: no
    // enlarging, so no resolution lost.
    function cropFor(photoAspect, slotAspect, focus) {
        const fx = clamp(Number.isFinite(focus && focus.x) ? focus.x : 0.5, FOCUS_MIN, FOCUS_MAX);
        const fy = clamp(Number.isFinite(focus && focus.y) ? focus.y : 0.5, FOCUS_MIN, FOCUS_MAX);
        const r = photoAspect / slotAspect;
        let x = 0, y = 0;
        if (r > 1) {
            const max = (r - 1) / 2;
            x = clamp(r * (0.5 - fx), -max, max);
        } else if (r < 1) {
            const k = 1 / r, max = (k - 1) / 2;
            y = clamp(k * (0.5 - fy), -max, max);
        }
        return { x: round4(x), y: round4(y), scale: 1 };
    }

    // ─── analyze: the I/O half ─────────────────────────────────────────────
    // Reading pixels needs a CORS-clean canvas; the Worker sends
    // Access-Control-Allow-Origin: * on photo reads, so crossOrigin=anonymous
    // works. If that load still fails (an old cached no-CORS copy), retry plain:
    // the size is enough to lay the page out, only the hash/sharpness are lost.
    function defaultLoadImage(url, { signal, aspectOnly } = {}) {
        const attempt = cors => new Promise((resolve, reject) => {
            const img = new Image();
            if (cors) img.crossOrigin = 'anonymous';
            const onAbort = () => { img.onload = img.onerror = null; img.src = ''; reject(abortError(signal)); };
            if (signal) {
                if (signal.aborted) return reject(abortError(signal));
                signal.addEventListener('abort', onAbort, { once: true });
            }
            const done = fn => v => { signal && signal.removeEventListener('abort', onAbort); fn(v); };
            img.onload = done(() => resolve(img));
            img.onerror = done(() => reject(new Error('image failed to load')));
            img.src = url;
        });
        if (aspectOnly) return attempt(false);     // exactly what the old run() did
        return attempt(true).catch(err => {
            if (signal && signal.aborted) throw err;
            return attempt(false);
        });
    }

    // Draws the image into a w x h canvas and returns its RGBA bytes. Throws
    // (SecurityError) on a tainted canvas; analyze() turns that into "no hash".
    function defaultPixelsOf(img, w, h) {
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);
        return ctx.getImageData(0, 0, w, h).data;
    }

    const failedItem = id => ({ id, ok: false, aspect: 1, orientation: 'square', hash: '', sharpness: 0, focus: { x: 0.5, y: 0.5 } });

    async function analyzeOne(id, o) {
        let img;
        try {
            img = await o.loadImage(o.urlFor(id), { signal: o.signal, aspectOnly: o.aspectOnly });
        } catch (e) {
            if (o.signal && o.signal.aborted) throw abortError(o.signal);
            return failedItem(id);
        }
        if (o.signal && o.signal.aborted) throw abortError(o.signal);
        const w = img && (img.naturalWidth || img.width), h = img && (img.naturalHeight || img.height);
        if (!(w > 0 && h > 0)) return failedItem(id);
        const aspect = w / h;
        const out = { id, ok: true, aspect, orientation: orientationOfAspect(aspect),
            hash: '', sharpness: 0, focus: { x: 0.5, y: 0.5 } };
        if (o.aspectOnly) return out;
        try {
            out.hash = dHash(toGray(await o.pixelsOf(img, 9, 8)));
            const g = toGray(await o.pixelsOf(img, 32, 32));
            out.sharpness = sharpnessOf(g);
            out.focus = focusOf(g);
        } catch (e) {
            out.hash = ''; out.sharpness = 0; out.focus = { x: 0.5, y: 0.5 };
        }
        return out;
    }

    // ids -> one entry per id, in input order. Never rejects because of one
    // photo (it comes back ok:false); rejects with AbortError when `signal`
    // fires. At most `concurrency` loads are in flight.
    async function analyze(ids, opts = {}) {
        const list = Array.from(ids || []);
        const signal = opts.signal;
        if (signal && signal.aborted) throw abortError(signal);
        if (list.length === 0) return [];
        if (typeof opts.urlFor !== 'function') throw new TypeError('AutoLayout.analyze: opts.urlFor(id) is required');
        const o = {
            urlFor: opts.urlFor,
            loadImage: opts.loadImage || defaultLoadImage,
            pixelsOf: opts.pixelsOf || defaultPixelsOf,
            aspectOnly: !!opts.aspectOnly,
            signal,
        };
        const conc = Math.max(1, Math.floor(Number(opts.concurrency) || DEFAULTS.concurrency));
        const results = new Array(list.length);
        let next = 0;
        const worker = async () => {
            for (;;) {
                if (signal && signal.aborted) throw abortError(signal);
                const i = next++;
                if (i >= list.length) return;
                results[i] = await analyzeOne(list[i], o);
            }
        };
        const workers = [];
        for (let w = 0; w < Math.min(conc, list.length); w++) workers.push(worker());
        let onAbort;
        const aborted = new Promise((_, reject) => {
            if (signal) {
                onAbort = () => reject(abortError(signal));
                signal.addEventListener('abort', onAbort, { once: true });
            }
        });
        try {
            await Promise.race(signal ? [Promise.all(workers), aborted] : [Promise.all(workers)]);
        } finally {
            if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        }
        return results;
    }

    // ─── plan: the pure half ───────────────────────────────────────────────
    function defaultLayouts() {
        if (typeof LAYOUTS === 'undefined') {
            throw new Error('AutoLayout.plan: load layouts.js first, or pass { layouts }');
        }
        const out = {};
        for (const id of BUILTIN_LAYOUT_IDS) if (LAYOUTS[id]) out[id] = LAYOUTS[id];
        return out;
    }

    // what the planner needs to know about each usable layout
    function catalogue(layouts, pageAspect) {
        const cat = [];
        for (const id of Object.keys(layouts).sort()) {
            const def = layouts[id];
            const slots = def && Array.isArray(def.slots) ? def.slots : [];
            if (slots.length === 0) continue;
            if (!slots.every(s => s && s.w > 0 && s.h > 0)) continue;
            cat.push({
                id, k: slots.length,
                aspects: slots.map(s => (s.w / s.h) * pageAspect),
                // a single slot that fills the page edge to edge
                hero: slots.length === 1 && slots[0].w >= 99 && slots[0].h >= 99,
            });
        }
        return cat;
    }

    const PERMS = {};
    function permutations(k) {
        if (PERMS[k]) return PERMS[k];
        const out = [];
        const rec = (cur, rest) => {
            if (rest.length === 0) { out.push(cur); return; }
            for (let i = 0; i < rest.length; i++) rec([...cur, rest[i]], [...rest.slice(0, i), ...rest.slice(i + 1)]);
        };
        rec([], Array.from({ length: k }, (_, i) => i));
        return (PERMS[k] = out);
    }

    // share of the photo that survives being cropped to the slot (1 = no loss)
    const keptShare = (photoAspect, slotAspect) =>
        Math.min(photoAspect, slotAspect) / Math.max(photoAspect, slotAspect);
    // loss, with a harder penalty once more than 45% is cut away and a much
    // harder one past 60% (a panorama squeezed into a square cell)
    function cropCost(photoAspect, slotAspect) {
        const loss = 1 - keptShare(photoAspect, slotAspect);
        return loss + 2 * Math.max(0, loss - 0.45) + 6 * Math.max(0, loss - 0.6);
    }

    // share of the slot left bare when the whole photo is drawn inside it (contain): 0 = a perfect fit
    const wasteOf = (photoAspect, slotAspect) => 1 - keptShare(photoAspect, slotAspect);
    const wasteCost = w => SP_WASTE_WEIGHT * (w + 2 * Math.max(0, w - 0.3) + 6 * Math.max(0, w - 0.45));

    // Where the photo is drawn inside a slot for fit: 'contain' (the viewer and any renderer use this one function):
    // s = min(scale * slotW / natW, scale * slotH / natH); centred, then moved by crop.x / crop.y of the slot.
    // scale 1 (the planner's only value) shows the whole photo, touching the slot on one axis.
    function containBox(natW, natH, slotW, slotH, crop) {
        if (!(natW > 0 && natH > 0 && slotW > 0 && slotH > 0)) return { left: 0, top: 0, w: Math.max(0, slotW) || 0, h: Math.max(0, slotH) || 0 };
        const scale = crop && Number(crop.scale) > 0 ? Number(crop.scale) : 1;
        const cx = crop && Number.isFinite(Number(crop.x)) ? Number(crop.x) : 0;
        const cy = crop && Number.isFinite(Number(crop.y)) ? Number(crop.y) : 0;
        const k = Math.min(scale * slotW / natW, scale * slotH / natH);
        const w = natW * k, h = natH * k;
        return { left: (slotW - w) / 2 + cx * slotW, top: (slotH - h) / 2 + cy * slotH, w, h };
    }

    const baseCost = (L) => L.hero ? -0.15 : L.k === 1 ? 0.3 : L.k === 2 ? 0.04 : L.k === 3 ? 0.02 : 0;

    function normalise(it, index) {
        const aspect = Number(it && it.aspect);
        const hasAspect = Number.isFinite(aspect) && aspect > 0;
        const kinds = ['landscape', 'portrait', 'square'];
        const f = it && it.focus;
        return {
            id: String(it && it.id), index,
            ok: !!it && it.ok !== false && hasAspect,
            aspect: hasAspect ? aspect : 1,
            orientation: it && kinds.includes(it.orientation) ? it.orientation : orientationOfAspect(hasAspect ? aspect : 1),
            hash: it && typeof it.hash === 'string' ? it.hash.toLowerCase() : '',
            sharp: it && Number.isFinite(Number(it.sharpness)) ? Number(it.sharpness) : 0,
            focus: { x: f && Number.isFinite(f.x) ? f.x : 0.5, y: f && Number.isFinite(f.y) ? f.y : 0.5 },
        };
    }

    // ── step 1: drop failed and near-duplicate shots ──
    // Greedy over shooting order, comparing each shot with the *kept* shots at
    // most `window` positions back (not transitively: a slow pan through
    // similar frames is not one picture). The sharpest of a matching group
    // survives, the earlier one on a tie.
    function dedupe(recs, threshold, windowSize) {
        const dropped = [];          // { rec, reason, pos, same? }
        const winnerOf = new Map();  // dropped id -> the id it lost to
        const seenIds = new Set();
        let reps = [];               // kept so far: { rec, pos }
        recs.forEach((rec, pos) => {
            if (seenIds.has(rec.id)) {            // the same id twice is one photo
                dropped.push({ rec, reason: 'duplicate', pos, same: true });
                return;
            }
            seenIds.add(rec.id);
            if (!rec.ok) { dropped.push({ rec, reason: 'failed', pos }); return; }
            const matches = reps.filter(r => pos - r.pos <= windowSize && hamming(r.rec.hash, rec.hash) <= threshold);
            if (matches.length === 0) { reps.push({ rec, pos }); return; }
            const group = [...matches, { rec, pos }];
            let winner = group[0];
            for (const g of group) if (g.rec.sharp > winner.rec.sharp) winner = g;
            for (const g of group) {
                if (g === winner) continue;
                dropped.push({ rec: g.rec, reason: 'duplicate', pos: g.pos });
                winnerOf.set(g.rec.id, winner.rec.id);
            }
            reps = reps.filter(r => !matches.includes(r));
            reps.push(winner);
        });
        const resolve = id => { let x = id, guard = 0; while (winnerOf.has(x) && guard++ < 1e6) x = winnerOf.get(x); return x; };
        dropped.sort((a, b) => a.pos - b.pos);
        reps.sort((a, b) => a.pos - b.pos);
        return {
            kept: reps.map(r => r.rec),
            dropped: dropped.map(d => d.reason === 'failed'
                ? { id: d.rec.id, reason: 'failed' }
                : { id: d.rec.id, reason: 'duplicate', of: d.same ? d.rec.id : resolve(d.rec.id) }),
        };
    }

    // ── step 2: the cover ──
    // Among the survivors whose shape keeps >= 60% of the photo in the cover's
    // aspect, the sharpest; the earlier one on a tie. If none fit, any.
    function pickCover(survivors, coverAspect) {
        let pool = survivors.filter(r => keptShare(r.aspect, coverAspect) >= COVER_MIN_FIT);
        if (pool.length === 0) pool = survivors;
        let best = pool[0];
        for (const r of pool) if (r.sharp > best.sharp) best = r;
        return best;
    }

    // contain cover: the cover is ONE tall A4 page and the photo is shown whole, so a 3:2 would be a small strip on
    // a big white page. Among the survivors that waste at most COVER_WASTE_TARGET of the page (a portrait, in practice)
    // the sharpest; none: at most COVER_WASTE_SOFT; none: the one that wastes least (the sharper on a tie).
    function pickCoverContain(survivors, coverAspect) {
        const sharpest = pool => { let best = pool[0]; for (const r of pool) if (r.sharp > best.sharp) best = r; return best; };
        for (const limit of [COVER_WASTE_TARGET, COVER_WASTE_SOFT]) {
            const pool = survivors.filter(r => wasteOf(r.aspect, coverAspect) <= limit);
            if (pool.length) return sharpest(pool);
        }
        let best = survivors[0];
        for (const r of survivors) {
            const d = wasteOf(r.aspect, coverAspect) - wasteOf(best.aspect, coverAspect);
            if (d < -1e-12 || (Math.abs(d) <= 1e-12 && r.sharp > best.sharp)) best = r;
        }
        return best;
    }

    // ── step 3: pages — dynamic programming over the shooting order ──
    // A page is the next k photos poured into a layout with k slots, so the
    // order is kept. Cost = crop loss of the best seating + a little taste:
    //   full-bleed ("hero") wants a sharp photo in the page's own orientation,
    //   single photos cost more than groups, the same layout twice running
    //   costs a bit. Hard rules: <= 2 of a layout in a row, a hero needs 3
    //   other pages before the next, the last page is not a lone non-hero
    //   photo, a 3-slot page takes no mixed orientations. A per-page price
    //   `lambda` (swept over a grid) steers the page count to the target.
    function buildCosts(P, cat, ctx, noCrush) {
        const m = P.length, L = cat.length;
        const cost = new Float64Array(m * L).fill(Infinity);
        const seat = new Array(m * L).fill(null);
        for (let li = 0; li < L; li++) {
            const lay = cat[li], k = lay.k;
            const perms = k <= 5 ? permutations(k) : [Array.from({ length: k }, (_, i) => i)];
            for (let i = 0; i + k <= m; i++) {
                const group = P.slice(i, i + k);
                if (k === 3) {
                    const kinds = new Set(group.map(r => r.orientation).filter(o => o !== 'square'));
                    if (kinds.size > 1) continue;                    // mixed orientation: not a 3-slot page
                }
                let best = Infinity, bestPerm = null;
                for (const perm of perms) {
                    let c = 0, crushed = false;
                    for (let s = 0; s < k; s++) {
                        const asp = group[perm[s]].aspect;
                        c += cropCost(asp, lay.aspects[s]);
                        if (keptShare(asp, lay.aspects[s]) < CRUSH_BELOW) crushed = true;
                    }
                    if (noCrush && crushed) continue;
                    for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) if (perm[a] > perm[b]) c += ORDER_COST;
                    if (c < best) { best = c; bestPerm = perm; }
                }
                if (bestPerm === null) continue;                    // every seating crushes a photo
                let c = best + baseCost(lay);
                if (lay.hero) {
                    const r = group[0];
                    c += 1.0 * (1 - ctx.pct.get(r.id));
                    if (r.orientation !== 'square' && r.orientation !== ctx.heroOrientation) c += 0.8;
                    if (r.id === ctx.coverId) c += 10;               // the cover is already that picture
                }
                cost[i * L + li] = c;
                seat[i * L + li] = bestPerm;
            }
        }
        return { cost, seat };
    }

    function solve(costs, cat, m, lambda, cfg) {
        const L = cat.length, NONE = L;
        const idx = (i, last, run, since) => ((i * (L + 1) + last) * 2 + run) * 4 + since;
        const size = (m + 1) * (L + 1) * 2 * 4;
        const dp = new Float64Array(size).fill(Infinity);
        const from = new Int32Array(size).fill(-1);
        const via = new Int16Array(size).fill(-1);
        dp[idx(0, NONE, 0, HERO_GAP)] = 0;
        for (let i = 0; i < m; i++) {
            for (let last = 0; last <= L; last++) for (let run = 0; run < 2; run++) for (let since = 0; since <= HERO_GAP; since++) {
                const here = idx(i, last, run, since);
                const cur = dp[here];
                if (cur === Infinity) continue;
                for (let li = 0; li < L; li++) {
                    const lay = cat[li], k = lay.k;
                    if (i + k > m) continue;
                    const pc = costs.cost[i * L + li];
                    if (pc === Infinity) continue;
                    if (cfg.hero && lay.hero && since < HERO_GAP) continue;
                    if (cfg.last && i + k === m && k === 1 && !lay.hero && m > 1) continue;
                    let nrun = 0;
                    if (li === last) {
                        nrun = run + 1;
                        if (nrun >= MAX_RUN) { if (cfg.run) continue; nrun = MAX_RUN - 1; }
                    }
                    const ns = lay.hero ? 0 : Math.min(HERO_GAP, since + 1);
                    const c = cur + pc + lambda + (li === last ? REPEAT_COST : 0)
                        + (i + k === m && k === 1 && m > 1 ? LONE_LAST_COST : 0);
                    const t = idx(i + k, li, nrun, ns);
                    if (c < dp[t]) { dp[t] = c; from[t] = here; via[t] = li; }
                }
            }
        }
        let best = Infinity, bestT = -1;
        for (let last = 0; last < L; last++) for (let run = 0; run < 2; run++) for (let since = 0; since <= HERO_GAP; since++) {
            const t = idx(m, last, run, since);
            if (dp[t] < best) { best = dp[t]; bestT = t; }
        }
        if (bestT < 0) return null;
        const groups = [];
        for (let t = bestT; via[t] >= 0; t = from[t]) groups.push(via[t]);
        groups.reverse();
        return { groups, cost: best - lambda * groups.length };
    }

    // target: the page count asked for. `pull` is how many cost units one page
    // of deviation is worth: huge when the caller asked for `pages` (hit it as
    // closely as the rules allow), small for the default density (quality wins).
    function choosePages(P, cat, ctx, target, pull) {
        const m = P.length;
        const configs = [
            { run: true, hero: true, last: true },
            { run: false, hero: true, last: true },
            { run: false, hero: false, last: true },
            { run: false, hero: false, last: false },
        ];
        // Rules first, then taste: for each rule set (strictest first) insist
        // that no photo is crushed, and only if that cannot be met accept
        // crushing too, before giving up a rule.
        const memo = {};
        const costsFor = noCrush => memo[noCrush] || (memo[noCrush] = buildCosts(P, cat, ctx, noCrush));
        for (const cfg of configs) {
            for (const noCrush of [true, false]) {
                const costs = costsFor(noCrush);
                if (!solve(costs, cat, m, 0, cfg)) continue;      // infeasible whatever the price
                let best = null;
                for (let step = -30; step <= 30; step++) {
                    const lambda = step / 10;
                    const res = solve(costs, cat, m, lambda, cfg);
                    if (!res) continue;
                    const score = res.cost + pull * Math.abs(res.groups.length - target);
                    if (!best || score < best.score - 1e-12) best = { score, groups: res.groups };
                }
                return { groups: best.groups, costs };
            }
        }
        throw new Error('AutoLayout.plan: the layouts given cannot seat these photos — include a single-photo layout');
    }

    // items: analyze()'s output. opts: { style:'auto', layouts, pages, pageAspect,
    // coverAspect, hashThreshold, window, order:'natural'|'given' }
    function plan(items, opts = {}) {
        const style = opts.style === undefined ? 'auto' : opts.style;
        if (style !== 'auto') throw new Error(`AutoLayout.plan: unknown style "${style}" — plan() only does "auto"; use run() for the old styles`);

        const pageAspect = Number(opts.pageAspect) > 0 && Number.isFinite(Number(opts.pageAspect)) ? Number(opts.pageAspect) : 1;
        const coverAspect = Number(opts.coverAspect) > 0 && Number.isFinite(Number(opts.coverAspect)) ? Number(opts.coverAspect) : pageAspect;
        const threshold = Number.isFinite(opts.hashThreshold) ? opts.hashThreshold : DEFAULTS.hashThreshold;
        const windowSize = Number.isFinite(opts.window) ? opts.window : DEFAULTS.window;

        const list = Array.isArray(items) ? items : [];
        let recs = list.map(normalise);
        if (opts.order !== 'given') {
            recs = recs.map((r, i) => ({ r, i })).sort((a, b) => naturalCompare(a.r.id, b.r.id) || a.i - b.i).map(x => x.r);
        }
        const { kept, dropped } = dedupe(recs, threshold, windowSize);
        if (kept.length === 0) return { cover: null, pages: [], dropped };

        // position in the kept list, for sharpness percentiles
        const sharps = kept.map(r => r.sharp).sort((a, b) => a - b);
        const below = v => { let lo = 0, hi = sharps.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sharps[mid] < v) lo = mid + 1; else hi = mid; } return lo; };
        const pct = new Map(kept.map(r => [r.id, kept.length > 1 ? below(r.sharp) / (kept.length - 1) : 1]));

        const coverRec = pickCover(kept, coverAspect);
        const cover = { photoId: coverRec.id, crop: cropFor(coverRec.aspect, coverAspect, coverRec.focus) };
        const inner = kept.length >= 2 && kept.length <= FEW_PHOTOS ? kept.filter(r => r !== coverRec) : kept;

        const cat = catalogue(opts.layouts || defaultLayouts(), pageAspect);
        const m = inner.length;
        const asked = Number.isFinite(opts.pages) && opts.pages >= 1;
        const wanted = asked
            ? Math.round(opts.pages)
            : Math.max(Math.ceil(m / 4), Math.min(m, Math.round(m / DEFAULTS.photosPerPage)));
        const ctx = { pct, coverId: coverRec.id, heroOrientation: pageAspect < 1 - SQUARE_TOLERANCE ? 'portrait' : 'landscape' };
        const { groups, costs } = choosePages(inner, cat, ctx, wanted, asked ? 1000 : DEFAULTS.densityPull);

        const L = cat.length;
        const pages = [];
        let at = 0;
        groups.forEach((li, n) => {
            const lay = cat[li], perm = costs.seat[at * L + li];
            const slots = lay.aspects.map((slotAspect, s) => {
                const r = inner[at + perm[s]];
                return { photoId: r.id, crop: cropFor(r.aspect, slotAspect, r.focus) };
            });
            pages.push({ id: `auto-${n + 1}`, type: 'inner', layout: lay.id, slots, bg: '#ffffff' });
            at += lay.k;
        });
        return { cover, pages, dropped };
    }

    // ─── planSpreads: the A4 album (cover page + spreads) ───────────────────
    // The same analyze() output and the same first steps as plan() (natural
    // order, de-duplication, cover pick, focus crops), but the inside is laid
    // out in SPREADS poured into templates from spread_templates.js, chosen by
    // dynamic programming over the shooting order:
    //   * a spread is the next k photos poured into a k-slot template, seated
    //     by an optimal assignment (Hungarian) that minimises crop loss, with
    //     a small pull to keep the shooting order along the reading order;
    //   * cost of a spread = seating cost + a price per spread + a rhythm cost
    //     per photo count (2-3 photos is sparse, 4-6 is the sweet spot, 8 is
    //     busy) + a tiny deterministic jitter so equal templates take turns;
    //   * hard rules (relaxed one by one, last first, when they cannot hold):
    //       - the next spread never uses the same template,
    //       - the same family (tags[0]) is never on three spreads running,
    //       - a through-spread (`hero`) needs 4 other spreads before the next,
    //       - a lone photo only on a hero spread, and the last spread is never
    //         a stray non-hero photo (unless the whole book is one photo),
    //       - 2-3 photos in all make exactly one spread.
    //   * a hero slot pays more for a blurry or non-landscape photo and is
    //     never the cover photo; a hero spread earns a bonus, so the sharpest
    //     landscapes get them, as often as the cap allows.
    const SPREAD_DEFAULTS = Object.freeze({
        coverAspect: 210 / 297,   // A4 portrait page
        spreadAspect: 420 / 297,  // two of them side by side
        maxPerFace: 4,
        heroGap: 4,               // a hero spread needs this many other spreads before the next (<= 1 in any 5)
        maxFamilyRun: 2,          // spreads of one family running
        spreadPrice: 0.55,        // every spread costs this much: fewer, fuller spreads win ties
        heroBonus: 0.65,          // what a through-spread earns (paid back by a blurry or portrait photo)
        jitter: 0.12,             // deterministic variety, scaled by `seed`'s hash
    });
    const SP_RHYTHM = [0, 0.15, 0.3, 0.14, 0.04, 0, 0.1, 0.25, 0.4, 0.6, 0.8, 1, 1.2];   // by photo count
    const SP_SOLO = 0.6;              // a lone non-hero photo (only ever the whole book's last resort)
    const SP_ORDER = 0.03;            // per seat of distance between shooting order and reading order
    const SP_SAME_FAMILY = 0.1;       // next spread of the same family
    const SP_BIG_SHARP = 0.15;        // sharp photos in the big slots
    const SP_BIG = 1e6;               // "impossible" inside the assignment (crushed photo in a no-crush pass)
    const SP_PASSES = 8;              // variety polish: at most this many sweeps over the spreads
    const SP_MAX_K = 12;
    // fit: 'contain' (the default): the whole photo, never cropped. A slot's cost is its WASTE, the share of the slot
    // the photo does not cover (1 - min/max of the two aspects), because that is the paper that shows.
    const CONTAIN_LIMITS = [0.45, 0.6, Infinity];   // the hard floor on one slot's waste, relaxed in these steps (45% first)
    const SP_WASTE_WEIGHT = 2;        // (1 gave a mean waste of 11% on mixed 40-photo books, 2 gives 10% and a worst slot of 35% for ~0.5 more spreads; 3 only 9.5%) waste cost = weight * (waste + 2 * (waste - 0.3)+ + 6 * (waste - 0.45)+)
    const SP_HERO_WRONG_COVER = 0.8;  // a portrait on a through-spread, in cover mode (cropped to a spread)
    const SP_HERO_WRONG_CONTAIN = 2.4;// ...and in contain mode, where it would sit in a small box between two blank bands
    const SP_USE_MIN = 3;             // contain: a template may carry this many spreads without a price (more in a long book)...
    const SP_USE_PRICE = 0.4;         // ...each spread over it adds this to that template's cost, each round
    const SP_USE_ROUNDS = 8;
    const COVER_WASTE_TARGET = 0.25;  // contain cover: candidates wasting at most this much of the A4 page...
    const COVER_WASTE_SOFT = 0.45;    // ...else at most this much; else the one that wastes least

    // min-cost assignment, rows = photos, columns = slots (n x n, O(n^3)); returns the column of each row
    function hungarian(a, n) {
        const u = new Float64Array(n + 1), v = new Float64Array(n + 1), p = new Int32Array(n + 1), way = new Int32Array(n + 1);
        for (let i = 1; i <= n; i++) {
            p[0] = i;
            let j0 = 0;
            const minv = new Float64Array(n + 1).fill(Infinity), used = new Uint8Array(n + 1);
            do {
                used[j0] = 1;
                const i0 = p[j0];
                let delta = Infinity, j1 = 0;
                for (let j = 1; j <= n; j++) {
                    if (used[j]) continue;
                    const cur = a[i0 - 1][j - 1] - u[i0] - v[j];
                    if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
                    if (minv[j] < delta) { delta = minv[j]; j1 = j; }
                }
                for (let j = 0; j <= n; j++) {
                    if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
                }
                j0 = j1;
            } while (p[j0] !== 0);
            do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
        }
        const col = new Array(n);
        for (let j = 1; j <= n; j++) col[p[j] - 1] = j - 1;
        return col;
    }

    // small deterministic hash -> 0..1, from the template id, the position and the seed
    function jitterOf(id, at, seed) {
        let h = 2166136261 ^ (seed | 0);
        for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
        h ^= Math.imul(at + 1, 0x9E3779B1);
        h = Math.imul(h ^ (h >>> 15), 0x85EBCA6B);
        h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
        h ^= h >>> 16;
        return (h >>> 0) / 4294967296;
    }

    // what the planner needs to know about each usable template; broken ones are skipped
    function spreadCatalogue(templates, spreadAspect, maxPerFace) {
        const cat = [];
        const list = templates.filter(t => t && typeof t.id === 'string' && Array.isArray(t.slots));
        list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        for (const t of list) {
            const slots = t.slots;
            if (slots.length === 0 || slots.length > SP_MAX_K) continue;
            if (!slots.every(s => s && [s.x, s.y, s.w, s.h].every(Number.isFinite) && s.w > 0 && s.h > 0 && ['left', 'right', 'span'].includes(s.face))) continue;
            const tags = Array.isArray(t.tags) ? t.tags : [];
            const hero = tags.includes('hero');
            const left = slots.filter(s => s.face === 'left').length, right = slots.filter(s => s.face === 'right').length;
            if (left > maxPerFace || right > maxPerFace) continue;
            if (slots.some(s => s.face === 'span') && !hero) continue;      // only a hero may cross the fold
            cat.push({
                id: t.id, tpl: t, k: slots.length, hero,
                family: tags.length ? tags[0] : t.id,
                aspects: slots.map(s => (s.w / s.h) * spreadAspect),
                span: slots.map(s => s.face === 'span'),
                big: slots.map(s => Math.min(1, (s.w * s.h) / 0.2)),
            });
        }
        return cat;
    }

    // `level` is the crush rule of this pass. cover: true = no photo may keep < 40% of itself, false = anything goes.
    // contain: the most waste one slot may have (CONTAIN_LIMITS; Infinity = anything goes).
    function spreadCosts(P, cat, ctx, level) {
        const m = P.length, T = cat.length;
        const cost = new Float64Array(m * T).fill(Infinity);
        const seat = new Array(m * T).fill(null);
        for (let ti = 0; ti < T; ti++) {
            const lay = cat[ti], k = lay.k;
            const spans = lay.span.filter(Boolean).length;
            for (let i = 0; i + k <= m; i++) {
                const a = new Array(k);
                for (let p = 0; p < k; p++) {
                    const r = P[i + p];
                    const row = new Array(k);
                    for (let s = 0; s < k; s++) {
                        let c;
                        if (ctx.contain) {
                            const waste = wasteOf(r.aspect, lay.aspects[s]);
                            c = wasteCost(waste) + SP_ORDER * Math.abs(p - s);
                            if (waste > level) c += SP_BIG;
                        } else {
                            c = cropCost(r.aspect, lay.aspects[s]) + SP_ORDER * Math.abs(p - s);
                            if (keptShare(r.aspect, lay.aspects[s]) < CRUSH_BELOW && level) c += SP_BIG;
                        }
                        const sharp = 1 - ctx.pct.get(r.id);
                        if (lay.span[s]) {
                            c += 1.0 * sharp;
                            if (r.orientation !== 'square' && r.orientation !== 'landscape') c += ctx.contain ? SP_HERO_WRONG_CONTAIN : SP_HERO_WRONG_COVER;
                            if (r.id === ctx.coverId) c += 10;                  // the cover is already that picture
                        } else {
                            c += SP_BIG_SHARP * sharp * lay.big[s];
                        }
                        row[s] = c;
                    }
                    a[p] = row;
                }
                const col = k === 1 ? [0] : hungarian(a, k);
                let c = 0;
                for (let p = 0; p < k; p++) c += a[p][col[p]];
                if (c >= SP_BIG / 2) continue;                                   // every seating crushes a photo
                c += lay.hero ? SP_RHYTHM[k] - ctx.cfg.heroBonus * (k === 1 ? 1 : 0.5 * spans) : (k === 1 ? SP_SOLO : SP_RHYTHM[k]);
                c += ctx.cfg.jitter * jitterOf(lay.id, i, ctx.seed);
                cost[i * T + ti] = c;
                seat[i * T + ti] = col;
            }
        }
        return { cost, seat };
    }

    // state = (the previous template, how many spreads of its family run, spreads since the last hero)
    function spreadSolve(costs, cat, m, rules, cfg) {
        const T = cat.length, NONE = T, H = cfg.heroGap, RUN = cfg.maxFamilyRun;
        const idx = (i, last, run, since) => ((i * (T + 1) + last) * RUN + (run - 1)) * (H + 1) + since;
        const size = (m + 1) * (T + 1) * RUN * (H + 1);
        const dp = new Float64Array(size).fill(Infinity);
        const from = new Int32Array(size).fill(-1);
        const via = new Int16Array(size).fill(-1);
        dp[idx(0, NONE, 1, H)] = 0;
        for (let i = 0; i < m; i++) {
            for (let last = 0; last <= T; last++) for (let run = 1; run <= RUN; run++) for (let since = 0; since <= H; since++) {
                const here = idx(i, last, run, since);
                const cur = dp[here];
                if (cur === Infinity) continue;
                for (let t = 0; t < T; t++) {
                    const lay = cat[t], k = lay.k;
                    if (i + k > m) continue;
                    const pc = costs.cost[i * T + t];
                    if (pc === Infinity) continue;
                    if (rules.whole && !(i === 0 && k === m)) continue;
                    if (rules.adj && t === last) continue;
                    if (rules.hero && lay.hero && since < H) continue;
                    if (rules.solo && k === 1 && !lay.hero && m > 1) continue;
                    if (rules.last && i + k === m && k === 1 && !lay.hero && m > 1) continue;
                    const same = last !== NONE && cat[last].family === lay.family;
                    let nrun = 1;
                    if (same) {
                        nrun = run + 1;
                        if (nrun > RUN) { if (rules.run) continue; nrun = RUN; }
                    }
                    const ns = lay.hero ? 0 : Math.min(H, since + 1);
                    const c = cur + pc + cfg.spreadPrice + (same ? SP_SAME_FAMILY : 0);
                    const to = idx(i + k, t, nrun, ns);
                    if (c < dp[to]) { dp[to] = c; from[to] = here; via[to] = t; }
                }
            }
        }
        let best = Infinity, bestT = -1;
        for (let last = 0; last < T; last++) for (let run = 1; run <= RUN; run++) for (let since = 0; since <= H; since++) {
            const t = idx(m, last, run, since);
            if (dp[t] < best) { best = dp[t]; bestT = t; }
        }
        if (bestT < 0) return null;
        const groups = [];
        for (let t = bestT; via[t] >= 0; t = from[t]) groups.push(via[t]);
        return groups.reverse();
    }

    // charge for the same template on two spreads `d` apart (d = 1 is a hard rule, handled by `adj`)
    const spNear = d => (d === 2 ? 0.9 : d === 3 ? 0.6 : d === 4 ? 0.35 : 0.15);
    function polishVariety(groups, costs, cat, m, rules, cfg) {
        const T = cat.length, S = groups.length, H = cfg.heroGap, RUN = cfg.maxFamilyRun;
        const g = groups.slice();
        const starts = [];
        { let at = 0; for (const t of g) { starts.push(at); at += cat[t].k; } }
        const costAt = (j, t) => costs.cost[starts[j] * T + t];
        // what spread j adds to the book when it uses template t (its own cost, the family
        // charge with its neighbours, the repeat charge with every other spread)
        const share = (j, t) => {
            let c = costAt(j, t);
            if (j > 0 && cat[g[j - 1]].family === cat[t].family) c += SP_SAME_FAMILY;
            if (j + 1 < S && cat[g[j + 1]].family === cat[t].family) c += SP_SAME_FAMILY;
            for (let o = 0; o < S; o++) if (o !== j && g[o] === t) c += spNear(Math.abs(o - j));
            return c;
        };
        const allowed = (j, t) => {
            const lay = cat[t];
            if (rules.adj && ((j > 0 && g[j - 1] === t) || (j + 1 < S && g[j + 1] === t))) return false;
            if (rules.hero && lay.hero) for (let o = Math.max(0, j - H); o <= Math.min(S - 1, j + H); o++) if (o !== j && cat[g[o]].hero) return false;
            if (rules.solo && lay.k === 1 && !lay.hero && m > 1) return false;
            if (rules.last && j === S - 1 && lay.k === 1 && !lay.hero && m > 1) return false;
            if (rules.run) {
                const fam = i => (i === j ? lay.family : cat[g[i]].family);
                for (let a = Math.max(0, j - RUN); a <= j && a + RUN < S; a++) {
                    let same = true;
                    for (let q = a; q <= a + RUN; q++) if (fam(q) !== fam(a)) { same = false; break; }
                    if (same) return false;
                }
            }
            return true;
        };
        for (let sweep = 0; sweep < SP_PASSES; sweep++) {
            let moved = false;
            for (let j = 0; j < S; j++) {
                const k = cat[g[j]].k;
                let bestT = g[j], best = share(j, g[j]);
                for (let t = 0; t < T; t++) {
                    if (t === g[j] || cat[t].k !== k || costAt(j, t) === Infinity || !allowed(j, t)) continue;
                    const c = share(j, t);
                    if (c < best - 1e-9) { best = c; bestT = t; }
                }
                if (bestT !== g[j]) { g[j] = bestT; moved = true; }
            }
            if (!moved) break;
        }
        return g;
    }

    // Contain only. Waste is a sharper taste than crop loss was, so a book whose photos repeat a shape (a long run of
    // 3:2 with a portrait now and then) would lean on the one or two templates that fit it. Price the templates that
    // carry too many spreads and solve again, a few rounds: the spreads move to the next-best fitting templates (the
    // photo groups change too, which the swap polish below cannot do). A template may carry max(3, a fifth of the
    // spreads); each round adds SP_USE_PRICE per spread over that. Same rules as the first solve; stops when no template
    // is over, when a solve fails, or after SP_USE_ROUNDS.
    function spreadOutUsage(groups, costs, cat, m, rules, cfg) {
        const T = cat.length, price = new Float64Array(T);
        let best = groups;
        for (let round = 0; round < SP_USE_ROUNDS; round++) {
            const uses = new Map();
            best.forEach(t => uses.set(t, (uses.get(t) || 0) + 1));
            const allowed = Math.max(SP_USE_MIN, Math.ceil(best.length / 5));
            let over = false;
            for (const [t, c] of uses) if (c > allowed) { price[t] += SP_USE_PRICE * (c - allowed); over = true; }
            if (!over) break;
            const cost = Float64Array.from(costs.cost, (c, i) => c + price[i % T]);
            const g = spreadSolve({ cost, seat: costs.seat }, cat, m, rules, cfg);
            if (!g) break;
            best = g;
        }
        return best;
    }

    // opts: { templates, coverAspect, spreadAspect, hashThreshold, window, maxPerFace, seed, order, back, fit }
    function planSpreads(items, opts = {}) {
        const D = SPREAD_DEFAULTS;
        const num = (v, d) => (Number(v) > 0 && Number.isFinite(Number(v)) ? Number(v) : d);
        const coverAspect = num(opts.coverAspect, D.coverAspect);
        const spreadAspect = num(opts.spreadAspect, D.spreadAspect);
        const maxPerFace = Number.isFinite(opts.maxPerFace) ? Math.max(1, Math.floor(opts.maxPerFace)) : D.maxPerFace;
        const threshold = Number.isFinite(opts.hashThreshold) ? opts.hashThreshold : DEFAULTS.hashThreshold;
        const windowSize = Number.isFinite(opts.window) ? opts.window : DEFAULTS.window;
        const seed = Number.isFinite(opts.seed) ? Math.trunc(opts.seed) : 0;
        const contain = opts.fit !== 'cover';        // 'contain' (whole photo, nothing cropped) unless 'cover' is asked for

        const list = Array.isArray(items) ? items : [];
        let recs = list.map(normalise);
        if (opts.order !== 'given') {
            recs = recs.map((r, i) => ({ r, i })).sort((a, b) => naturalCompare(a.r.id, b.r.id) || a.i - b.i).map(x => x.r);
        }
        const { kept, dropped } = dedupe(recs, threshold, windowSize);
        if (kept.length === 0) return { cover: null, spreads: [], back: null, dropped };

        const sharps = kept.map(r => r.sharp).sort((a, b) => a - b);
        const below = v => { let lo = 0, hi = sharps.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (sharps[mid] < v) lo = mid + 1; else hi = mid; } return lo; };
        const pct = new Map(kept.map(r => [r.id, kept.length > 1 ? below(r.sharp) / (kept.length - 1) : 1]));

        const coverRec = contain ? pickCoverContain(kept, coverAspect) : pickCover(kept, coverAspect);
        const cover = contain
            ? { photoId: coverRec.id, fit: 'contain', crop: { x: 0, y: 0, scale: 1 } }
            : { photoId: coverRec.id, crop: cropFor(coverRec.aspect, coverAspect, coverRec.focus) };
        // one photo: the cover alone. 2-3: the cover is not repeated inside. 4+: it is.
        const inner = kept.length === 1 ? [] : kept.length <= FEW_PHOTOS ? kept.filter(r => r !== coverRec) : kept;
        const m = inner.length;
        if (m === 0) return { cover, spreads: [], back: null, dropped };

        const templates = opts.templates !== undefined ? opts.templates
            : (typeof SpreadTemplates !== 'undefined' ? SpreadTemplates.TEMPLATES : null);
        if (!Array.isArray(templates)) throw new Error('AutoLayout.planSpreads: load spread_templates.js first, or pass { templates }');
        const cat = spreadCatalogue(templates, spreadAspect, maxPerFace);

        const cfg = { spreadPrice: D.spreadPrice, heroBonus: D.heroBonus, jitter: D.jitter, heroGap: D.heroGap, maxFamilyRun: D.maxFamilyRun };
        const ctx = { pct, coverId: coverRec.id, seed, cfg, contain };
        const memo = new Map();
        const costsFor = level => { if (!memo.has(level)) memo.set(level, spreadCosts(inner, cat, ctx, level)); return memo.get(level); };
        const levels = contain ? CONTAIN_LIMITS : [true, false];
        // Rules first, then taste: strictest rule set first, and inside it no
        // crushed photo before a crushed one; only then give a rule up.
        const ladder = [
            { adj: true, run: true, hero: true, solo: true, last: true },
            { adj: true, run: false, hero: true, solo: true, last: true },
            { adj: true, run: false, hero: false, solo: true, last: true },
            { adj: true, run: false, hero: false, solo: false, last: true },
            { adj: true, run: false, hero: false, solo: false, last: false },
            { adj: false, run: false, hero: false, solo: false, last: false },
        ];
        let groups = null, costs = null, used = null;
        search:
        for (const whole of m <= FEW_PHOTOS ? [true, false] : [false]) {
            for (const rules of ladder) {
                for (const level of levels) {
                    const c = costsFor(level);
                    const g = cat.length ? spreadSolve(c, cat, m, { ...rules, whole }, cfg) : null;
                    if (g) { groups = g; costs = c; used = { ...rules, whole }; break search; }
                }
            }
        }
        if (!groups) throw new Error('AutoLayout.planSpreads: the templates given cannot seat these photos — include templates for 1 and 2 photos');

        // Variety. The pass above takes the cheapest book, which tends to lean on a
        // few templates. Polish it: keep every spread's photos, and try the other
        // templates with the same number of slots, one spread at a time, taking a
        // swap when it lowers (cost + a charge for the same template showing up
        // again within a few spreads, or at all). Every hard rule is checked on
        // each candidate, so none is bent. Deterministic; stops when nothing moves.
        if (contain && groups.length > 1 && cat.length > 1) groups = spreadOutUsage(groups, costs, cat, m, used, cfg);
        if (groups.length > 1 && cat.length > 1) groups = polishVariety(groups, costs, cat, m, used, cfg);

        const T = cat.length;
        const spreads = [];
        let at = 0;
        groups.forEach((ti, n) => {
            const lay = cat[ti], col = costs.seat[at * T + ti];
            const slots = new Array(lay.k);
            for (let p = 0; p < lay.k; p++) {
                const s = col[p], r = inner[at + p], sd = lay.tpl.slots[s];
                slots[s] = contain
                    ? { photoId: r.id, fit: 'contain', crop: { x: 0, y: 0, scale: 1 }, slot: { x: sd.x, y: sd.y, w: sd.w, h: sd.h, face: sd.face } }
                    : { photoId: r.id, crop: cropFor(r.aspect, lay.aspects[s], r.focus), slot: { x: sd.x, y: sd.y, w: sd.w, h: sd.h, face: sd.face } };
            }
            spreads.push({ id: `spread-${n + 1}`, template: lay.id, slots });
            at += lay.k;
        });
        return { cover, spreads, back: opts.back === true ? {} : null, dropped };
    }

    // ─── the original five styles (editor) ─────────────────────────────────
    return {
        DEFAULTS,
        SPREAD_DEFAULTS,
        analyze,
        plan,
        planSpreads,
        // pure helpers, exposed for tests and for callers that want to reuse them
        util: { naturalCompare, toGray, dHash, hamming, sharpnessOf, focusOf, cropFor, wasteOf, containBox },

        // 入口：photos 為照片陣列，style 為排版風格
        async run(photos, style = 'magazine') {
            if (!photos || photos.length === 0) return [];

            // 取得所有照片方向（用縮圖，速度快；只要長寬比，不讀像素）
            const byId = new Map(photos.map(p => [p.id, p]));
            const infos = await analyze(photos.map(p => p.id), {
                aspectOnly: true,
                urlFor: id => driveManager.getImageUrl(byId.get(id), 400),
            });
            // a photo that fails to load counts as landscape; square counts as landscape
            const withOrient = photos.map((p, i) => ({
                ...p,
                orientation: infos[i].ok && infos[i].aspect < 1 ? 'portrait' : 'landscape',
            }));

            switch (style) {
                case 'uniform':  return this._uniformLayout(withOrient);
                case 'story':    return this._storyLayout(withOrient);
                case 'byRating': return this._ratingLayout(withOrient);
                case 'random':   return this._randomLayout(withOrient);
                default:         return this._magazineLayout(withOrient);
            }
        },

        _makeSlots(photoIds) {
            return photoIds.map(id => ({ photoId: id || null, crop: { x: 0, y: 0, scale: 1 } }));
        },

        _makePage(layout, photoIds) {
            const layoutDef = LAYOUTS[layout];
            const slots = layoutDef.slots.map((_, idx) => ({
                photoId: photoIds[idx] || null,
                crop: { x: 0, y: 0, scale: 1 }
            }));
            return {
                id: `page-auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                type: 'inner',
                layout,
                slots,
                bg: '#ffffff'
            };
        },

        // 整齊型：固定每頁 2 張
        _uniformLayout(photos) {
            const pages = [];
            for (let i = 0; i < photos.length; i += 2) {
                if (i + 1 < photos.length) {
                    pages.push(this._makePage('2-up-h', [photos[i].id, photos[i + 1].id]));
                } else {
                    pages.push(this._makePage('1-up', [photos[i].id]));
                }
            }
            return pages;
        },

        // 雜誌型：5星全版，依數量混搭版型
        _magazineLayout(photos) {
            const sorted = [...photos].sort((a, b) => (b.rating || 0) - (a.rating || 0));
            const pages = [];
            let i = 0;

            while (i < sorted.length) {
                const p = sorted[i];
                const r = p.rating || 0;

                if (r >= 5) {
                    pages.push(this._makePage('full-bleed', [p.id]));
                    i++;
                } else if (i + 3 < sorted.length) {
                    pages.push(this._makePage('4-grid', sorted.slice(i, i + 4).map(x => x.id)));
                    i += 4;
                } else if (i + 2 < sorted.length) {
                    pages.push(this._makePage('3-up', sorted.slice(i, i + 3).map(x => x.id)));
                    i += 3;
                } else if (i + 1 < sorted.length) {
                    const p2 = sorted[i + 1];
                    const layout = (p.orientation === 'landscape' && p2.orientation === 'landscape') ? '2-up-v' : '2-up-h';
                    pages.push(this._makePage(layout, [p.id, p2.id]));
                    i += 2;
                } else {
                    pages.push(this._makePage('1-up', [p.id]));
                    i++;
                }
            }
            return pages;
        },

        // 故事型：照片順序排列，橫式配橫式，直式配直式
        _storyLayout(photos) {
            const pages = [];
            let i = 0;

            while (i < photos.length) {
                const p = photos[i];

                if (i + 1 < photos.length) {
                    const p2 = photos[i + 1];
                    if (p.orientation === 'portrait' && p2.orientation === 'portrait') {
                        pages.push(this._makePage('2-up-h', [p.id, p2.id]));
                    } else if (p.orientation === 'landscape' && p2.orientation === 'landscape') {
                        pages.push(this._makePage('2-up-v', [p.id, p2.id]));
                    } else {
                        pages.push(this._makePage('3-up', [
                            p.id,
                            p2.id,
                            photos[i + 2]?.id || null
                        ]));
                        i += (photos[i + 2] ? 3 : 2);
                        continue;
                    }
                    i += 2;
                } else {
                    pages.push(this._makePage('full-bleed', [p.id]));
                    i++;
                }
            }
            return pages;
        },

        // 隨機型：隨機挑版型塞滿照片
        _randomLayout(photos) {
            // 所有可用版型（含自訂，排除空白）
            const pool = Object.entries(LAYOUTS)
                .filter(([, def]) => def.slots.length > 0)
                .map(([id, def]) => ({ id, count: def.slots.length }));

            const pages = [];
            let i = 0;

            while (i < photos.length) {
                const remaining = photos.length - i;
                // 只挑不超過剩餘張數的版型，避免空格子
                const fits = pool.filter(l => l.count <= remaining);
                const candidates = fits.length > 0 ? fits : pool.filter(l => l.count === 1);
                const pick = candidates[Math.floor(Math.random() * candidates.length)];
                const ids = photos.slice(i, i + pick.count).map(p => p.id);
                pages.push(this._makePage(pick.id, ids));
                i += pick.count;
            }
            return pages;
        },

        // 以評分決定：5星全版，4星單張，3星兩張，其餘四格
        _ratingLayout(photos) {
            const sorted = [...photos].sort((a, b) => (b.rating || 0) - (a.rating || 0));
            const pages = [];
            let i = 0;

            while (i < sorted.length) {
                const p = sorted[i];
                const r = p.rating || 0;

                if (r >= 5) {
                    pages.push(this._makePage('full-bleed', [p.id]));
                    i++;
                } else if (r >= 4) {
                    pages.push(this._makePage('1-up', [p.id]));
                    i++;
                } else if (r >= 3 && i + 1 < sorted.length) {
                    pages.push(this._makePage('2-up-h', [p.id, sorted[i + 1].id]));
                    i += 2;
                } else if (i + 3 < sorted.length) {
                    pages.push(this._makePage('4-grid', sorted.slice(i, i + 4).map(x => x.id)));
                    i += 4;
                } else {
                    pages.push(this._makePage('1-up', [p.id]));
                    i++;
                }
            }
            return pages;
        }
    };
})();
