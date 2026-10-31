// Album preview (docs/album-preview.md): after delivery the guest can see
// their own finals laid out as an A4 portrait album — a single-page cover, then
// spreads (two A4 pages side by side, up to four photos a page), then a back
// cover if the plan has one. Read-only and local: nothing is stored, nothing is
// ordered, nothing is written (no POST/PUT, no localStorage / sessionStorage),
// and only thumbnails are ever requested (`?w=` + `?t=`, never an original).
//
// js/pick.js owns when the entry shows (delivered mode, finals view only) and
// calls AlbumPreview.syncEntry(); this file owns everything after the press:
//   1. load book_editor/js/layouts.js + spread_templates.js + auto_layout.js
//      (only now, with the same ?v= stamp as this very script — nothing is
//      hard-coded here),
//   2. list the finals (the final folders and every subfolder),
//   3. AutoLayout.analyze in chunks of CHUNK (so there is real progress; it has
//      no progress callback) and AutoLayout.planSpreads,
//   4. a full-screen dark viewer: cover + spreads, flip by button, ← / → or a
//      swipe; only the current page and its two neighbours exist in the DOM;
//      double tap / double click zooms 2.5x, pinch and the wheel zoom 1x-4x,
//      and a zoomed page is dragged to pan (the swipe is off while zoomed).
//
// A photo is drawn WHOLE by default (the plan says fit: 'contain' for every slot: centred inside its frame on the
// white paper, never cropped, never stretched; Tim's check in the LINE browser: cropping "cuts off heads"). A plan with
// fit: 'cover' (AlbumPreview.PLAN_OPTS = { fit: 'cover' }) is still drawn the old way, filling its frame with crop.
//
// Spread-count bounds (docs/album-preview.md "Spread-count bounds"): AlbumPreview.PLAN_OPTS may carry
// { minSpreads, maxSpreads } (js/completion-page.js sets them from the shop's album product). The plan's
// own report says whether they were met; boundsHint() turns "not met" into one kind sentence, shown in
// the viewer's footer and handed to AlbumPreview.onResult for the page behind it.
//
// Edit mode (docs/guest-shop.md, "S3 — 客人相本排版"): ONLY when the page hands over AlbumPreview.order (the caller is the
// seat owner of a confirmed project, ordering is on and the album product is orderable: js/completion-page.js decides),
// the viewer lets the guest swap photos slot by slot, switch a spread to another template WITH THE SAME SLOT COUNT (版型, plus
// 鏡像) and pick one background colour for the whole book (背景) (docs/guest-shop.md "S3 第一步"; never the spread count, never
// which photos are used), step back through the last HISTORY_MAX layouts (in memory only), and send the book to js/guest-order.js
// as a Layout JSON v2 after a whole-book review. Without AlbumPreview.order the viewer is exactly the read-only preview (no edit markup at all).
//
// Every string that came from outside (photo keys) only ever reaches
// img.src as a property — no innerHTML anywhere in this file, so a file name
// that is markup stays text. book_editor.js / exporter.js are not loaded.
(function () {
    'use strict';

    const SCRIPT_SRC = (document.currentScript && document.currentScript.src) || '';

    // A4 portrait pages. The cover and back are one page (210 x 297); the inside
    // is spreads, two pages side by side (420 x 297). The same values go to
    // planSpreads() and to the renderer, so a crop is drawn on the shape it was
    // made for.
    // The preview pages are A4 (a cover / back is one page, a spread is two side by side): this is the only
    // physical size the preview knows, so bleed_mm is turned into a fraction of it (docs/album-preview.md "Bleed").
    const PAGE_MM = { w: 210, h: 297 };
    const BLEED_MAX = 10;     // the Worker refuses more (platform_products.bleed_mm is 0-10)
    const COVER_ASPECT = 210 / 297;
    const SPREAD_ASPECT = 420 / 297;

    const EDGE = 24;          // a touch starting this close to a screen edge is the browser's back gesture
    const SWIPE_MIN = 40;     // px, or SWIPE_FRAC of the page width, whichever is larger
    const SWIPE_FRAC = 0.12;
    const PHONE_W = 600;      // window this narrow (or less) is a phone held upright
    const SHORT_H = 500;      // window this short (or less) is a phone on its side

    const ZOOM_DOUBLE = 2.5;  // what a double tap / double click zooms to
    const ZOOM_MAX = 4;
    const ZOOM_SNAP = 1.02;   // a pinch that ends below this lands on exactly 1x
    const TAP_MS = 350;       // a touch shorter than this, and still, is a tap
    const TAP_SLOP = 10;      // px a finger may drift and still be a tap
    const DOUBLE_TAP_MS = 300;
    const DOUBLE_TAP_DIST = 40;
    const HINT_MS = 4500;     // the zoom hint stays this long (or until the first touch)
    const HINT_FADE_MS = 400;

    // Edit mode (see the header): a swapped-in photo whose bare share of its slot (AutoLayout.util.wasteOf) is above this gets
    // the shape notice. The planner's own hard waste line is also 30%.
    const SHAPE_WASTE_WARN = 0.3;
    const HISTORY_MAX = 5;                  // 上一版: the last five layouts, in memory only
    const LAYOUT_MAX_BYTES = 64 * 1024;     // what the Worker accepts of a Layout JSON
    // The Worker refuses a layout key with a quote, <, >, backtick, backslash, a control or bidi character, BOM or a lone surrogate
    // (worker.js bookPhotoIdSafe, the same rule). In edit mode such a photo is left out of the book rather than producing a layout
    // the Worker would answer 400 invalid_layout.
    const KEY_MAX = 1024;
    const UNSAFE_KEY_CHAR = /["<>`\\\x00-\x1f\x7f-\x9f\u{61c}\u{200e}\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}\u{d800}-\u{dfff}]/u;
    const keySafe = id => typeof id === 'string' && id.length <= KEY_MAX && !UNSAFE_KEY_CHAR.test(id);
    const UNAVAILABLE = '訂購暫時無法使用，排版已保留，請稍後再試';
    const round3 = n => Math.round(n * 1000) / 1000;
    const clonePlan = plan => JSON.parse(JSON.stringify(plan));
    // The one place the nine book colours live (id -> hex, in the Worker contract's order; the Worker keeps its own list of ids and a
    // test compares them). `white` is the paper: a book that is white sends no `background` at all.
    const BACKGROUND_COLORS = Object.freeze([
        ['white', '#ffffff', '白'], ['cream', '#fff8ee', '奶油'], ['butter', '#fff4cc', '奶黃'], ['blush', '#fde8ec', '粉'],
        ['peach', '#ffe5d4', '蜜桃'], ['mint', '#e3f4e8', '薄荷'], ['sky', '#e1effb', '天空'], ['lavender', '#eee8fa', '薰衣草'], ['gray', '#eeeeee', '灰'],
    ].map(([id, hex, label]) => Object.freeze({ id, hex, label })));
    const colorById = id => BACKGROUND_COLORS.find(c => c.id === id) || null;
    const PAPER = BACKGROUND_COLORS[0].hex;

    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const text = (tag, cls, t, id) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (id) e.id = id;
        if (t != null) e.textContent = t;
        return e;
    };
    const button = (id, cls, label, aria) => {
        const b = text('button', cls, label, id);
        b.type = 'button';
        if (aria) b.setAttribute('aria-label', aria);
        return b;
    };
    // bleed_mm as the page shows it: a finite number above 0, at most BLEED_MAX; anything else (null, 0, junk) is 0 = no guide
    const normBleed = v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, BLEED_MAX) : 0);
    const abortError = () => {
        if (typeof DOMException === 'function') return new DOMException('Aborted', 'AbortError');
        const e = new Error('Aborted'); e.name = 'AbortError'; return e;
    };
    const isAbort = e => !!e && e.name === 'AbortError';

    // ── one photo in its frame ────────────────────────────────────────────
    // contain: the box AutoLayout.util.containBox works out (the whole photo, centred, touching the frame on one
    // axis), set as px on the <img>. The frame's own layout size is used (not getBoundingClientRect, which a zoomed
    // page would scale). object-fit: contain stays in the CSS as the belt to these braces.
    function frameSize(wrap) {
        const cs = getComputedStyle(wrap);
        const w = parseFloat(cs.width), h = parseFloat(cs.height);
        return { w: w > 0 ? w : wrap.clientWidth, h: h > 0 ? h : wrap.clientHeight };
    }
    function fitContainImage(img) {
        const wrap = img.parentElement;
        if (!wrap || !img.naturalWidth || !img.naturalHeight) return;
        const f = frameSize(wrap);
        if (!f.w || !f.h) return;
        const b = AutoLayout.util.containBox(img.naturalWidth, img.naturalHeight, f.w, f.h,
            { x: parseFloat(img.dataset.cropx) || 0, y: parseFloat(img.dataset.cropy) || 0, scale: parseFloat(img.dataset.scale) || 1 });
        img.style.width = `${b.w}px`;
        img.style.height = `${b.h}px`;
        img.style.left = `${b.left}px`;
        img.style.top = `${b.top}px`;
    }
    const fitPhoto = img => (img.dataset.fit === 'contain' ? fitContainImage(img) : fitCoverImage(img));

    // ── the engine files, loaded on the first press ─────────────────────
    function stamp() {
        try {
            const own = new URL(SCRIPT_SRC).searchParams.get('v');
            if (own) return own;
        } catch (e) { /* no usable src */ }
        const tag = document.querySelector('script[src*="js/pick.js"]');
        const m = tag && /[?&]v=([^&"]+)/.exec(tag.getAttribute('src') || '');
        return m ? m[1] : '';
    }
    function engineUrl(file) {
        const u = new URL(`../book_editor/js/${file}`, SCRIPT_SRC || document.baseURI);
        const v = stamp();
        if (v) u.searchParams.set('v', v);
        return u.href;
    }
    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.async = false;
            s.onload = () => resolve();
            s.onerror = () => { s.remove(); reject(new Error(`could not load ${src}`)); };
            document.head.appendChild(s);
        });
    }
    let enginePromise = null;
    function ensureEngine() {
        const have = () => typeof LAYOUTS !== 'undefined' && typeof SpreadTemplates !== 'undefined'
            && typeof AutoLayout !== 'undefined' && typeof fitCoverImage === 'function';
        if (have()) return Promise.resolve();
        if (!enginePromise) {
            enginePromise = (async () => {
                if (typeof LAYOUTS === 'undefined') await loadScript(engineUrl('layouts.js'));
                if (typeof SpreadTemplates === 'undefined') await loadScript(engineUrl('spread_templates.js'));
                if (typeof AutoLayout === 'undefined') await loadScript(engineUrl('auto_layout.js'));
            })().catch(e => { enginePromise = null; throw e; });
        }
        return enginePromise;
    }

    // ── the finals, from the same listing route the gallery uses ──────────
    async function listOne(prefix, signal) {
        const url = `${CONFIG.WORKER_URL}/?list=${encodeURIComponent(prefix)}`;
        const res = await fetch(url, { headers: window.driveManager._authHeaders(), signal });
        if (!res.ok) throw new Error(`list ${res.status}`);
        const body = await res.json();
        if (!body || body.status !== 'success' || !Array.isArray(body.data)) throw new Error('list shape');
        return {
            ids: body.data.map(f => f && f.id).filter(id => typeof id === 'string' && id && !id.endsWith('/')),
            folders: (Array.isArray(body.folders) ? body.folders : []).filter(f => typeof f === 'string' && f),
        };
    }
    // Every photo under the final folders, subfolders included. Never leaves
    // them (a prefix that does not start with one is skipped), asks for each
    // folder once, and stops at LIST_MAX_FOLDERS so a runaway tree cannot
    // make this loop forever.
    async function listFinals(roots, signal, limits) {
        const seenFolders = new Set(), ids = new Set();
        const norm = f => (f.endsWith('/') ? f : f + '/');
        const rootList = [...new Set(roots.map(norm))];
        const queue = rootList.slice();
        rootList.forEach(r => seenFolders.add(r));
        let visited = 0;
        while (queue.length) {
            if (signal.aborted) throw abortError();
            const wave = queue.splice(0, 4);
            visited += wave.length;
            if (visited > limits.LIST_MAX_FOLDERS) break;
            const results = await Promise.all(wave.map(f => listOne(f, signal)));
            for (const r of results) {
                r.ids.forEach(id => ids.add(id));
                for (const sub of r.folders) {
                    const f = norm(sub);
                    if (seenFolders.has(f) || !rootList.some(root => f.startsWith(root))) continue;
                    seenFolders.add(f);
                    queue.push(f);
                }
            }
        }
        return [...ids];
    }

    // ── the spread-count bounds, in words ─────────────────────────────────
    // `plan` = AutoLayout.planSpreads' result, `photoCount` = the photos that were laid out. Only a bound that was
    // asked for AND not met says anything; a caller error (min > max: the report carries `error`) says nothing, it
    // is not the guest's to fix. photosNeeded / photosAllowed can be null: the number is then left out.
    // photosNeeded is the bare minimum the planner can reach the spread count with (docs/album-preview.md).
    function boundsHint(plan, photoCount) {
        const parts = [];
        const min = plan && plan.minSpreads, max = plan && plan.maxSpreads;
        if (min && min.met === false && !min.error) {
            const need = Number.isFinite(min.photosNeeded) ? `；建議至少 ${min.photosNeeded} 張` : '';
            parts.push(`這本相本至少要 ${min.wanted} 個跨頁，目前 ${photoCount} 張照片只排得出 ${min.achieved} 個${need}`);
        }
        if (max && max.met === false && !max.error) {
            parts.push(Number.isFinite(max.photosAllowed) ? `照片超過這本相本能放的 ${max.photosAllowed} 張` : '照片超過這本相本能放的數量');
        }
        return parts.length ? `${parts.join('。')}。` : null;
    }

    // ── the pipeline: finals -> plan ──────────────────────────────────────
    // Resolves { kind: 'ready', plan, notes } | { kind: 'few' }; rejects with
    // an Error carrying .kind = 'list' | 'photos' for the error panel, or with
    // an AbortError.
    async function build(folders, signal, onProgress, cfg) {
        onProgress({ phase: 'prepare' });
        try {
            await ensureEngine();
        } catch (e) { e.kind = 'list'; throw e; }
        if (signal.aborted) throw abortError();
        let ids;
        try {
            ids = await listFinals(folders, signal, cfg);
        } catch (e) {
            if (isAbort(e) || signal.aborted) throw abortError();
            e.kind = 'list'; throw e;
        }
        if (signal.aborted) throw abortError();
        ids.sort(AutoLayout.util.naturalCompare);
        const capped = ids.length > cfg.MAX_PHOTOS;
        if (capped) ids = ids.slice(0, cfg.MAX_PHOTOS);
        let skipped = 0;
        if (cfg.order) { const safe = ids.filter(keySafe); skipped = ids.length - safe.length; ids = safe; }   // edit mode: only keys the Worker accepts
        if (ids.length < 2) return { kind: 'few' };

        const urlFor = id => window.driveManager.getImageUrl({ id }, 400);
        const items = [];
        onProgress({ phase: 'analyze', done: 0, total: ids.length });
        for (let i = 0; i < ids.length; i += cfg.CHUNK) {
            const part = await AutoLayout.analyze(ids.slice(i, i + cfg.CHUNK), { urlFor, signal });
            items.push(...part);
            onProgress({ phase: 'analyze', done: items.length, total: ids.length });
        }
        if (signal.aborted) throw abortError();
        const ok = items.filter(it => it.ok).length;
        const failed = items.length - ok;
        if (ok === 0 || (ok < 2 && failed > 0)) { const e = new Error('photos failed'); e.kind = 'photos'; throw e; }

        const plan = planFor(items, cfg, 0);
        const dup = plan.dropped.filter(d => d.reason === 'duplicate').length;
        if (ok - dup < 2 || !plan.cover || plan.spreads.length === 0) return { kind: 'few' };
        const notes = [];
        if (dup > 0) notes.push(`已略過 ${dup} 張相近的照片`);
        if (capped) notes.push(`已先用前 ${cfg.MAX_PHOTOS} 張排版`);
        if (failed > 0) notes.push(`${failed} 張照片讀取失敗，未放入相本`);
        if (skipped > 0) notes.push(`${skipped} 張照片的檔名含特殊字元，未放入相本`);
        return { kind: 'ready', plan, notes, hint: boundsHint(plan, ok - dup), items, photoCount: ok - dup };
    }

    // The plan for `variant` (0 = the first layout; n > 0 = the same photos laid out another way, AutoLayout's `variant`).
    // Pure and local: the analysed items are kept, so 再次編排 never touches the network again.
    function planFor(items, cfg, variant) {
        const o = { ...cfg.PLAN_OPTS, coverAspect: cfg.COVER_ASPECT, spreadAspect: cfg.SPREAD_ASPECT };
        if (variant > 0) o.variant = variant;
        return AutoLayout.planSpreads(items, o);
    }
    // what the guest sees of a plan: the cover photo, and per spread the template, the mirror state and where each photo sits.
    // Two plans with the same signature look the same, so 再次編排 never presents one as new.
    function planSignature(plan) {
        const r = n => Math.round(n * 1e4);
        return JSON.stringify([plan.cover.photoId, plan.spreads.map(s => [s.template, !!s.mirrored,
            s.slots.map(x => [x.photoId, r(x.slot.x), r(x.slot.y), x.slot.face]).sort()])]);
    }
    const RELAYOUT_TRIES = 12;      // variants tried for one press before saying there is only one layout
    // the cover title as the page was handed it: a non-empty string once trimmed, else nothing is drawn
    const coverTitleOf = v => (typeof v === 'string' && v.trim() ? v.trim() : '');
    // how much room a title needs: a CJK character is about twice as wide as a latin one
    const titleUnits = t => [...t].reduce((n, ch) => n + (/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
    const titleTier = t => { const u = titleUnits(t); return u <= 24 ? 1 : u <= 44 ? 2 : u <= 72 ? 3 : 4; };

    // the pages the viewer shows, from a plan: the cover, the spreads, then the back if the plan has one
    function pagesOf(plan) {
        const pages = [
            { kind: 'cover', aspect: COVER_ASPECT, layout: 'cover',
              slots: [{ photoId: plan.cover.photoId, crop: plan.cover.crop, fit: plan.cover.fit, slot: { x: 0, y: 0, w: 1, h: 1 } }] },
            ...plan.spreads.map(sp => ({ kind: 'spread', aspect: SPREAD_ASPECT, layout: sp.template, slots: sp.slots })),
        ];
        if (plan.back) {
            const b = plan.back;
            pages.push({ kind: 'back', aspect: COVER_ASPECT, layout: 'back',
                slots: b.photoId ? [{ photoId: b.photoId, crop: b.crop || { x: 0, y: 0, scale: 1 }, fit: b.fit, slot: { x: 0, y: 0, w: 1, h: 1 } }] : [] });
        }
        return pages;
    }

    // Edit mode is on only when the page handed over AlbumPreview.order for an orderable album and nothing has been ordered yet.
    function canEdit(items) {
        const o = AlbumPreview.order;
        return !!(o && !o.locked && o.product && typeof o.submit === 'function' && Number.isFinite(o.min) && Number.isFinite(o.max)
            && Array.isArray(items) && typeof AutoLayout !== 'undefined' && AutoLayout.util && AutoLayout.util.cropFor && AutoLayout.util.wasteOf);
    }

    // ── the viewer ────────────────────────────────────────────────────────
    const Viewer = {
        el: null, stage: null, ctl: null, runId: 0, off: [], opener: null,
        pages: [], index: 0,
        g: null,                              // the gesture in progress: swipe | pan | pinch
        zoom: { s: 1, x: 0, y: 0 },           // the current page's zoom: scale and pan (px from centre)
        lastTap: null, touchAt: 0, mouse: null,
        hint: null, hintTimer: null, hintFade: null,
        items: null, photoCount: 0, variant: 0, basePlan: null, sig: '', cueTimer: null,   // re-layout: the analysed photos and the layout number (0 = the first)
        // edit mode (only with AlbumPreview.order): the plan being edited, the in-memory 上一版 stack, an open overlay (picker / confirm)
        edit: false, cur: null, bg: null, history: [], dirty: false, reviewing: false, reached: false, overlay: null, lastFocus: null, downAt: null,
        hintNow: null, byId: null,

        isOpen() { return !!this.el; },

        open(folders, opener) {
            if (this.el) return;
            this.opener = opener || null;
            const v = text('div', 'album-viewer', null, 'albumViewer');
            v.setAttribute('role', 'dialog');
            v.setAttribute('aria-modal', 'true');
            v.setAttribute('aria-label', '相本預覽');
            v.tabIndex = -1;
            const bar = text('div', 'album-viewer-bar');
            bar.append(text('span', 'album-viewer-title', '相本預覽'),
                button('albumClose', 'album-icon-btn', '✕', '關閉'));
            const stage = text('div', 'album-stage', null, 'albumStage');
            const foot = text('div', 'album-viewer-foot');
            v.append(bar, stage, foot);
            document.body.appendChild(v);
            this.el = v; this.stage = stage; this.foot = foot;
            document.documentElement.classList.add('album-open');

            v.querySelector('#albumClose').addEventListener('click', () => this.close());
            const onKey = e => this.onKey(e);
            const onResize = () => this.refit();
            document.addEventListener('keydown', onKey);
            window.addEventListener('resize', onResize);
            this.off.push(() => document.removeEventListener('keydown', onKey), () => window.removeEventListener('resize', onResize));
            // everything below sits on elements that go with the viewer: nothing is left on window / document
            stage.addEventListener('touchstart', e => this.onTouchStart(e), { passive: true });
            stage.addEventListener('touchmove', e => this.onTouchMove(e), { passive: true });
            stage.addEventListener('touchend', e => this.onTouchEnd(e), { passive: true });
            stage.addEventListener('touchcancel', e => this.onTouchCancel(e), { passive: true });
            stage.addEventListener('wheel', e => this.onWheel(e), { passive: false });
            stage.addEventListener('dblclick', e => this.onDblClick(e));
            stage.addEventListener('pointerdown', e => this.onPointerDown(e));
            stage.addEventListener('pointermove', e => this.onPointerMove(e));
            stage.addEventListener('pointerup', e => this.onPointerEnd(e));
            stage.addEventListener('pointercancel', e => this.onPointerEnd(e));
            stage.addEventListener('click', e => this.onSlotClick(e));

            this.folders = folders;
            this.run();
        },

        close(skipFocus) {
            if (!this.el) return;
            this.runId++;
            if (this.ctl) { this.ctl.abort(); this.ctl = null; }
            this.off.splice(0).forEach(f => f());
            this.clearHintTimers();
            this.el.querySelectorAll('.album-slide').forEach(s => this.dropSlide(s));
            this.el.remove();
            this.el = this.stage = this.foot = null;
            this.pages = []; this.g = null; this.index = 0; this.mouse = null; this.lastTap = null; this.hint = null;
            this.items = null; this.basePlan = null; this.variant = 0; this.sig = ''; clearTimeout(this.cueTimer);     // closing forgets the layout number: nothing is stored
            this.edit = false; this.cur = null; this.bg = null; this.history = []; this.dirty = false; this.reviewing = false; this.reached = false;   // and the swaps and the 上一版 stack
            this.overlay = null; this.lastFocus = null; this.downAt = null; this.hintNow = null; this.byId = null;
            this.zoom = { s: 1, x: 0, y: 0 };
            document.documentElement.classList.remove('album-open');
            const btn = document.getElementById('albumPreviewBtn');
            const back = btn || this.opener;
            this.opener = null;
            if (!skipFocus && back && typeof back.focus === 'function' && document.contains(back)) back.focus();
        },

        // one run: prepare -> list -> analyze -> plan -> show. A retry is a new run.
        run() {
            const id = ++this.runId;
            if (this.ctl) this.ctl.abort();
            const ctl = this.ctl = new AbortController();
            this.setState('loading');
            this.showProgress('正在準備你的照片…', null);
            const onProgress = p => {
                if (id !== this.runId) return;
                if (p.phase === 'analyze') this.showProgress(`正在為你排版… ${p.done}/${p.total}`, p.total ? p.done / p.total : 0);
            };
            build(this.folders, ctl.signal, onProgress, AlbumPreview).then(res => {
                if (id !== this.runId) return;
                if (res.kind === 'few') this.showFew();
                else { this.items = res.items; this.photoCount = res.photoCount; this.variant = 0; this.basePlan = res.plan; this.showAlbum(res.plan, res.notes, res.hint); }
                AlbumPreview.reportHint(res.kind === 'few' ? null : res.hint);
            }, err => {
                if (id !== this.runId || isAbort(err) || ctl.signal.aborted) return;
                this.showError(err && err.kind === 'photos'
                    ? '照片讀取失敗，請檢查網路後再試'
                    : '無法載入相本，請檢查網路後再試');
            });
        },

        setState(state) {
            this.el.dataset.state = state;
            this.clearHintTimers();
            this.hint = null;
            this.stage.replaceChildren();
            this.foot.replaceChildren();
            this.stage.style.removeProperty('--cur');
            this.stage.style.removeProperty('--drag');
            this.stage.classList.remove('dragging', 'zoomed');
            delete this.stage.dataset.zoom;
            delete this.stage.dataset.zoomable;
            this.pages = [];
            this.g = null; this.mouse = null; this.lastTap = null;
            this.zoom = { s: 1, x: 0, y: 0 };
            // the control that had the focus is gone with the old state
            if (!this.el.contains(document.activeElement) || document.activeElement === document.body) this.el.focus();
        },

        panel(id, ...kids) {
            const p = text('div', 'album-panel', null, id);
            p.append(...kids);
            this.stage.appendChild(p);
            return p;
        },

        showProgress(label, frac) {
            if (!this.el || this.el.dataset.state !== 'loading') return;
            let p = this.stage.querySelector('.album-panel');
            if (!p) {
                const bar = text('div', 'album-progress-bar'); bar.appendChild(document.createElement('span'));
                p = this.panel(null, text('div', 'album-progress-text', '', 'albumProgress'), bar);
                const cancel = button('albumCancel', 'btn btn-outline album-btn', '取消');
                cancel.addEventListener('click', () => this.close());
                p.appendChild(cancel);
                cancel.focus();
            }
            p.querySelector('#albumProgress').textContent = label;
            p.querySelector('.album-progress-bar span').style.width = frac == null ? '0%' : `${Math.round(frac * 100)}%`;
        },

        showFew() {
            this.setState('few');
            const close = button('albumFewClose', 'btn btn-outline album-btn', '關閉');
            close.addEventListener('click', () => this.close());
            this.panel('albumFew', text('div', 'album-panel-title', '至少需要 2 張不同的照片，才能排成相本'),
                text('div', 'album-panel-sub', '照片不夠多，實際相本可以請攝影師幫你排版。'), close);
            close.focus();
        },

        showError(message) {
            this.setState('error');
            const retry = button('albumRetry', 'btn btn-primary album-btn', '重試');
            retry.addEventListener('click', () => this.run());
            const close = button('albumErrClose', 'btn btn-outline album-btn', '關閉');
            close.addEventListener('click', () => this.close());
            const row = text('div', 'album-panel-actions'); row.append(retry, close);
            const p = this.panel('albumError', text('div', 'album-panel-title', message), row);
            p.setAttribute('role', 'alert');
            retry.focus();
        },

        showAlbum(plan, notes, hint) {
            this.setState('ready');
            this.stage.dataset.zoomable = 'true';       // CSS: the stage takes the touches itself (touch-action: none)
            this.cur = clonePlan(plan);
            this.pages = pagesOf(this.cur);
            this.sig = planSignature(plan);
            this.hintNow = hint;
            this.history = []; this.dirty = false; this.reviewing = false; this.reached = false; this.byId = null; this.bg = null;
            this.edit = canEdit(this.items);
            this.el.dataset.edit = this.edit ? 'true' : 'false';
            const note = text('div', 'album-note', notes.join('・'), 'albumNote');
            note.hidden = notes.length === 0;
            // the bounds could not be met: said plainly, above the page buttons (present only then)
            const bounds = hint ? this.boundsEl(hint) : null;
            const prev = button('albumPrev', 'album-nav-btn', '‹', '上一頁');
            const next = button('albumNext', 'album-nav-btn', '›', '下一頁');
            const label = text('div', 'album-label', '', 'albumLabel');
            label.setAttribute('aria-live', 'polite');
            const row = text('div', 'album-nav'); row.append(prev, label, next);
            const again = button('albumRelayout', 'album-relayout-btn', '再次編排');
            again.addEventListener('click', () => this.again());
            if (bounds) this.foot.append(bounds);
            // page row first (‹ 1 / 15 ›), then the actions, 送出結帳 on its own row, and the quiet caption last
            this.foot.append(note, row);
            if (this.edit) this.foot.append(this.editRow(again));
            this.foot.append(this.relayoutRow(again, this.edit));
            if (!this.edit && AlbumPreview.order && AlbumPreview.order.locked) {
                this.foot.append(text('div', 'album-locked', '這本相本已送出訂單，排版無法再修改', 'albumLockedNote'));
            }
            prev.addEventListener('click', () => this.go(-1));
            next.addEventListener('click', () => this.go(1));
            this.index = 0;
            this.show(0);
            next.focus();
            this.refreshEdit();
            this.showHint();
        },

        boundsEl(hint) {
            const b = text('div', 'album-bounds', hint, 'albumBounds');
            b.setAttribute('role', 'status');
            return b;
        },

        // 再次編排 / 回到原本: the same photos, another layout. Local only (the analysed items are kept), nothing stored.
        // In edit mode 再次編排 sits in the action row (editRow) and this row holds only 回到原本, the chip and the status / caption.
        relayoutRow(again, edit) {
            const row = text('div', 'album-relayout');
            const back = button('albumRelayoutBack', 'album-relayout-btn album-relayout-back', '回到原本');
            back.hidden = true;
            const chip = text('span', 'album-relayout-chip', '', 'albumRelayoutChip');
            chip.hidden = true;
            const status = text('div', 'album-relayout-status', '', 'albumRelayoutStatus');
            status.setAttribute('role', 'status');
            status.setAttribute('aria-live', 'polite');
            const cap = text('div', 'album-relayout-cap', '這是系統自動排版的示意，換個排法看看', 'albumRelayoutCap');
            const btns = text('div', 'album-relayout-btns');
            if (edit) btns.append(back, chip); else btns.append(again, back, chip);
            const side = text('div', 'album-relayout-side');
            side.append(status, cap);
            row.append(btns, side);
            back.addEventListener('click', () => this.guard(() => this.relayout(0, '已回到原本排法')));
            return row;
        },

        say(msg) {
            const st = document.getElementById('albumRelayoutStatus');
            if (!st) return;
            st.textContent = '';                                   // a repeated message is announced again
            st.textContent = msg;
        },

        // 再次編排: the next variant whose plan LOOKS different from the one shown (up to RELAYOUT_TRIES tried). When none does
        // the plan stays and the guest is told so: an unchanged result is never presented as new.
        again() {
            if (!this.el || !this.items || !this.pages.length) return;
            for (let v = this.variant + 1; v <= this.variant + RELAYOUT_TRIES; v++) {
                let plan;
                try { plan = planFor(this.items, AlbumPreview, v); } catch (e) { break; }
                if (!plan || !plan.cover || !plan.spreads.length) break;
                if (planSignature(plan) !== this.sig) { this.guard(() => this.relayout(v, `已換成排法 ${v + 1}`, plan)); return; }
            }
            this.say('這本相本照片不多，目前只有這個排法');
        },

        // a short fade of the stage so the guest sees the pages were drawn again (none under prefers-reduced-motion: CSS)
        cue() {
            if (!this.stage) return;
            this.stage.classList.remove('album-redraw');
            void this.stage.offsetWidth;
            this.stage.classList.add('album-redraw');
            clearTimeout(this.cueTimer);
            this.cueTimer = setTimeout(() => { if (this.stage) this.stage.classList.remove('album-redraw'); }, 300);
        },

        // Swap to layout number `variant` (0 = the first one). The page index is kept when it still exists (clamped), the
        // counters and the bounds sentence follow the new plan, the cover title is drawn again with the cover.
        // In edit mode the layout being left (swaps included) goes on the 上一版 stack first.
        relayout(variant, msg, given) {
            if (!this.el || !this.items || !this.pages.length) return;
            let plan;
            try { plan = given || (variant === 0 && this.basePlan ? this.basePlan : planFor(this.items, AlbumPreview, variant)); } catch (e) { return; }
            if (!plan || !plan.cover || !plan.spreads.length) return;
            if (this.edit) this.pushHistory();
            this.variant = variant;
            this.sig = planSignature(plan);
            this.cur = clonePlan(plan);
            this.dirty = false;
            this.paintPlan(boundsHint(plan, this.photoCount), msg);
        },

        // everything that follows a change of the whole plan (a re-layout, or 上一版): `this.cur`, `this.variant` are already set
        paintPlan(hint, msg) {
            this.hintNow = hint;
            this.hideHint();
            for (const s of [...this.stage.querySelectorAll('.album-slide')]) this.dropSlide(s);
            this.pages = pagesOf(this.cur);
            const old = this.foot.querySelector('#albumBounds');
            if (old) old.remove();
            if (hint) this.foot.prepend(this.boundsEl(hint));
            const back = document.getElementById('albumRelayoutBack');
            const chip = document.getElementById('albumRelayoutChip');
            const variant = this.variant;
            if (chip) { chip.hidden = variant === 0; chip.textContent = variant === 0 ? '' : `排法 ${variant + 1}`; }
            if (back) {
                const hadFocus = document.activeElement === back;
                back.hidden = variant === 0;
                if (hadFocus && back.hidden) document.getElementById('albumRelayout')?.focus();
            }
            this.show(Math.min(this.index, this.pages.length - 1));
            this.cue();
            if (msg) this.say(msg);
            this.refreshEdit();
            AlbumPreview.reportHint(hint);
        },

        // ── edit mode ──────────────────────────────────────────────────────────
        // the photos by id, from the analysis (aspect and focus are what a new crop is made from)
        photos() {
            if (!this.byId) this.byId = new Map((this.items || []).filter(it => it && it.ok && typeof it.id === 'string').map(it => [it.id, it]));
            return this.byId;
        },
        photo(id) { return this.photos().get(id) || null; },
        // a slot's address: the cover, or spread n's slot s
        refOf(pageIndex, si) {
            const pg = this.pages[pageIndex];
            if (!pg) return null;
            if (pg.kind === 'cover') return si === 0 ? { cover: true } : null;
            if (pg.kind === 'spread' && this.cur.spreads[pageIndex - 1] && this.cur.spreads[pageIndex - 1].slots[si]) return { n: pageIndex - 1, s: si };
            return null;
        },
        slotAt(ref) { return ref.cover ? this.cur.cover : this.cur.spreads[ref.n].slots[ref.s]; },
        aspectAt(ref) {
            if (ref.cover) return COVER_ASPECT;
            const sd = this.slotAt(ref).slot;
            return sd.w * SPREAD_ASPECT / sd.h;
        },
        // the photo ids on the inside pages (the cover may repeat one of them; an inside photo is there once)
        innerIds(except) {
            const ids = new Set();
            this.cur.spreads.forEach((sp, n) => sp.slots.forEach((x, s) => {
                if (x.photoId && !(except && !except.cover && except.n === n && except.s === s)) ids.add(x.photoId);
            }));
            return ids;
        },
        // `id` drawn in the slot at `ref`: the slot keeps its place, its fit; the crop comes from the analysed focus
        placed(ref, id) {
            const old = this.slotAt(ref), it = this.photo(id);
            if (old.fit === 'contain') return { photoId: id, fit: 'contain', crop: { x: 0, y: 0, scale: 1 }, slot: old.slot };
            return { photoId: id, crop: AutoLayout.util.cropFor(it.aspect, this.aspectAt(ref), it.focus), slot: old.slot };
        },
        setSlot(ref, obj) { if (ref.cover) this.cur.cover = obj; else this.cur.spreads[ref.n].slots[ref.s] = obj; },
        wasteAt(ref, id) { const it = this.photo(id); return it ? AutoLayout.util.wasteOf(it.aspect, this.aspectAt(ref)) : 0; },

        // ── 版型 / 鏡像 / 背景 ──
        pageColor() { const c = colorById(this.bg); return c ? c.hex : PAPER; },
        // the template's slot `i` as this spread draws it: its fractions, left <-> right when mirrored (span stays span)
        slotGeometry(ts, mirrored) {
            return mirrored
                ? { x: 1 - ts.x - ts.w, y: ts.y, w: ts.w, h: ts.h, face: ts.face === 'left' ? 'right' : ts.face === 'right' ? 'left' : ts.face }
                : { x: ts.x, y: ts.y, w: ts.w, h: ts.h, face: ts.face };
        },
        // Spread `n` (0-based) drawn with template `id`, `mirrored` or not. Photo i stays in slot i (slots are in template order), the
        // fit stays, the crop is made again for the NEW slot's shape (contain: 0,0,1 like the planner). Only a template of the library
        // with the same slot count is taken; nothing else changes (spread count, cover, which photos). Returns false when refused.
        applyTemplate(n, id, mirrored) {
            const sp = this.cur && Number.isInteger(n) ? this.cur.spreads[n] : null;
            const t = typeof id === 'string' ? SpreadTemplates.byId(id) : null;
            if (!sp || !t || t.slots.length !== sp.slots.length) return false;
            const m = !!mirrored;
            sp.slots = sp.slots.map((x, i) => {
                const slot = this.slotGeometry(t.slots[i], m);
                const it = x.photoId ? this.photo(x.photoId) : null;
                if (x.fit === 'contain') return { photoId: x.photoId, fit: 'contain', crop: { x: 0, y: 0, scale: 1 }, slot };
                const crop = it ? AutoLayout.util.cropFor(it.aspect, slot.w * SPREAD_ASPECT / slot.h, it.focus) : x.crop;
                return { photoId: x.photoId, crop, slot };
            });
            sp.template = t.id;
            if (m) sp.mirrored = true; else delete sp.mirrored;
            return true;
        },
        // 版型 / 鏡像 count as an edit: 再次編排 would throw them away, so it asks first
        switchSpread(n, id, mirrored, msg) {
            if (!this.applyTemplate(n, id, mirrored)) return false;
            this.dirty = true;
            this.redraw();
            this.editSay(msg);
            this.refreshEdit();
            return true;
        },
        // the book's colour: an id of BACKGROUND_COLORS; white (the paper) is "none" and sends no `background`. Unknown ids are ignored.
        setBackground(id) {
            const c = colorById(id);
            if (!c) return false;
            this.bg = c.id === 'white' ? null : c.id;
            this.paintBackground();
            return true;
        },
        paintBackground() {
            if (!this.stage) return;
            const hex = this.pageColor();
            this.stage.querySelectorAll('.album-page').forEach(p => { p.style.background = hex; });
        },

        // choose `id` for the slot at `ref`: a photo already on the inside pages EXCHANGES the two slots, any other replaces
        choose(ref, id) {
            const here = this.slotAt(ref);
            if (!this.photo(id) || here.photoId === id) return false;
            const notes = [];
            let other = null;
            if (!ref.cover) {
                this.cur.spreads.forEach((sp, n) => sp.slots.forEach((x, s) => { if (!other && x.photoId === id && !(n === ref.n && s === ref.s)) other = { n, s }; }));
            }
            const mine = here.photoId;
            if (other && !mine) { this.editSay('這格是空的，請選還沒用到的照片'); return false; }     // nothing to swap back, and a photo is never twice inside
            const next = this.placed(ref, id);
            if (other) {
                const there = this.placed(other, mine);
                this.setSlot(ref, next);
                this.setSlot(other, there);
                notes.push('這張已在書中，兩格已互換位置');
                if (this.wasteAt(other, mine) > SHAPE_WASTE_WARN) notes.push('換過去的那張和那一格形狀不合，會留白或被裁切');
            } else {
                this.setSlot(ref, next);
            }
            if (this.wasteAt(ref, id) > SHAPE_WASTE_WARN) notes.push('這張和這格形狀不合，會留白或被裁切');
            this.dirty = true;
            this.redraw();
            this.editSay(notes.length ? `${notes.join('。')}。` : '已換照片');
            this.refreshEdit();
            return true;
        },
        // draw the pages again from this.cur, on the page the guest is on
        redraw() {
            for (const s of [...this.stage.querySelectorAll('.album-slide')]) this.dropSlide(s);
            this.pages = pagesOf(this.cur);
            this.show(Math.min(this.index, this.pages.length - 1));
        },
        editSay(msg) {
            const st = document.getElementById('albumEditNote');
            if (!st) return;
            st.textContent = '';
            st.textContent = msg;
        },

        editRow(again) {
            const row = text('div', 'album-edit');
            const note = text('div', 'album-edit-note', '點一張照片，可以換成別張', 'albumEditNote');
            note.setAttribute('role', 'status');
            note.setAttribute('aria-live', 'polite');
            const warn = text('div', 'album-edit-warn', '', 'albumPagesWarn');
            warn.setAttribute('role', 'status');
            warn.hidden = true;
            const act = (id, label) => button(id, 'album-relayout-btn album-edit-btn album-act', label);
            const style = act(null, '版型');
            style.dataset.albumStyle = '';
            style.setAttribute('aria-haspopup', 'dialog');
            const bg = act(null, '背景');
            bg.dataset.albumBg = '';
            bg.setAttribute('aria-haspopup', 'dialog');
            const undo = act('albumUndo', '上一版');
            undo.disabled = true;
            again.classList.add('album-edit-btn', 'album-act');
            const actions = text('div', 'album-actions');
            actions.append(style, bg, undo, again);
            const go = button('albumCheckout', 'album-relayout-btn album-edit-btn album-edit-go', '送出結帳');
            row.append(actions, go, note, warn);
            style.addEventListener('click', () => this.openStyle());
            bg.addEventListener('click', () => this.openBackground());
            undo.addEventListener('click', () => this.undo());
            go.addEventListener('click', () => this.startReview());
            return row;
        },
        // the cover and the back are single pages: no 版型 there (it would be a different slot count anyway)
        refreshStyleBtn() {
            const b = this.foot && this.foot.querySelector('[data-album-style]');
            const pg = this.pages[this.index];
            if (b) b.hidden = !pg || pg.kind !== 'spread';
        },
        // 上一版 and 送出結帳 follow the state: the stack, and whether the spread count is one this book may have
        refreshEdit() {
            if (!this.edit || !this.el) return;
            this.refreshStyleBtn();
            const undo = document.getElementById('albumUndo');
            if (undo) { undo.disabled = this.history.length === 0; undo.dataset.count = String(this.history.length); }
            const o = AlbumPreview.order, n = this.cur.spreads.length;
            const bad = !o || n < o.min || n > o.max;
            const go = document.getElementById('albumCheckout'), warn = document.getElementById('albumPagesWarn');
            if (go) go.disabled = bad;
            if (warn) { warn.hidden = !bad; warn.textContent = bad ? `不符合這本相本的頁數：目前 ${n} 個跨頁，這本相本是 ${o.min}–${o.max} 個跨頁` : ''; }
        },
        pushHistory() {
            this.history.push({ cur: clonePlan(this.cur), bg: this.bg, variant: this.variant, sig: this.sig, dirty: this.dirty, hint: this.hintNow });
            while (this.history.length > HISTORY_MAX) this.history.shift();
        },
        undo() {
            if (!this.edit || !this.history.length || this.reviewing) return;
            const s = this.history.pop();
            this.variant = s.variant; this.sig = s.sig; this.cur = s.cur; this.bg = s.bg; this.dirty = s.dirty;
            this.paintPlan(s.hint, '已回到上一版');
        },
        // 再次編排 / 回到原本 throw the swaps away: ask first (only when there is something to lose)
        guard(run) {
            if (!this.edit || !this.dirty) { run(); return; }
            this.confirmBox('再次編排會取消你換過的照片和版型，確定要繼續嗎？', '繼續編排', run, '先不要');
        },

        // ── the overlays: the candidate picker and the confirmation. The rest of the viewer is inert meanwhile. ──
        openOverlay(node) {
            this.closeOverlay(true);
            this.lastFocus = document.activeElement;
            this.overlay = node;
            this.el.append(node);
            for (const part of [this.stage, this.foot, this.el.querySelector('.album-viewer-bar')]) if (part) part.inert = true;
        },
        closeOverlay(quiet) {
            if (!this.overlay) return;
            this.overlay.remove();
            this.overlay = null;
            for (const part of [this.stage, this.foot, this.el.querySelector('.album-viewer-bar')]) if (part) part.inert = false;
            const back = this.lastFocus;
            this.lastFocus = null;
            if (!quiet && back && this.el.contains(back) && !back.disabled && typeof back.focus === 'function') back.focus();
        },
        confirmBox(message, yesLabel, onYes, noLabel) {
            const box = text('div', 'album-overlay album-confirm', null, 'albumConfirm');
            box.setAttribute('role', 'alertdialog');
            box.setAttribute('aria-modal', 'true');
            box.setAttribute('aria-labelledby', 'albumConfirmText');
            const card = text('div', 'album-overlay-card');
            const yes = button('albumConfirmYes', 'btn btn-primary album-btn', yesLabel);
            const no = button('albumConfirmNo', 'btn btn-outline album-btn', noLabel || '取消');
            const acts = text('div', 'album-panel-actions');
            acts.append(yes, no);
            card.append(text('div', 'album-panel-title', message, 'albumConfirmText'), acts);
            box.append(card);
            yes.addEventListener('click', () => { this.closeOverlay(); onYes(); });
            no.addEventListener('click', () => this.closeOverlay());
            this.openOverlay(box);
            no.focus();
        },

        // the candidate list for the slot at `ref`: this book's finals (thumbnails only), photos not on the inside pages first,
        // photos of the slot's own orientation first, the ones already in the book dimmed and marked 已使用
        openPicker(ref) {
            const here = this.slotAt(ref);
            const inner = this.innerIds(ref);
            const slotAspect = this.aspectAt(ref);
            const orient = a => (Math.abs(a - 1) <= 0.1 ? 'square' : a > 1 ? 'landscape' : 'portrait');
            const want = orient(slotAspect);
            const list = [...this.photos().values()].map((it, i) => ({ it, i, used: inner.has(it.id), cur: it.id === here.photoId, match: orient(it.aspect) === want }));
            list.sort((a, b) => (a.used - b.used) || ((b.match ? 1 : 0) - (a.match ? 1 : 0)) || (a.i - b.i));
            const box = text('div', 'album-overlay album-picker', null, 'albumPicker');
            box.setAttribute('role', 'dialog');
            box.setAttribute('aria-modal', 'true');
            box.setAttribute('aria-label', '選一張照片');
            const head = text('div', 'album-picker-head');
            const close = button('albumPickerClose', 'album-icon-btn', '✕', '關閉');
            head.append(text('span', 'album-picker-title', ref.cover ? '選封面照片' : '選一張照片換進這格'), close);
            const grid = text('div', 'album-cands', null, 'albumCandidates');
            const dm = window.driveManager;
            for (const c of list) {
                const b = button(null, 'album-cand', null);
                b.dataset.photoId = c.it.id;
                b.dataset.used = c.used ? 'true' : 'false';
                b.dataset.match = c.match ? 'true' : 'false';
                if (c.cur) b.dataset.current = 'true';
                b.setAttribute('aria-label', c.cur ? '目前這張' : c.used ? '已使用的照片' : '照片');
                const img = new Image();
                img.alt = '';
                img.loading = 'lazy';
                img.decoding = 'async';
                img.draggable = false;
                img.src = dm.getImageUrl({ id: c.it.id }, 400);
                b.append(img);
                if (c.cur) b.append(text('span', 'album-cand-badge album-cand-current', '目前'));
                else if (c.used) b.append(text('span', 'album-cand-badge', '已使用'));
                b.addEventListener('click', () => { this.closeOverlay(true); this.choose(ref, c.it.id); this.focusAfterEdit(); });
                grid.append(b);
            }
            box.append(head, grid);
            close.addEventListener('click', () => this.closeOverlay());
            this.openOverlay(box);
            close.focus();
        },
        // 版型: every template of the library with the SAME slot count as the current spread (never the cover / back), each as a small
        // wireframe of the whole spread (the dashed line is the fold; a slot across it is a span slot); 鏡像 flips this spread.
        openStyle() {
            if (!this.edit || this.reviewing || this.overlay || !this.cur) return;
            const pg = this.pages[this.index];
            if (!pg || pg.kind !== 'spread') return;
            const n = this.index - 1;
            const sp = this.cur.spreads[n];
            if (!sp) return;
            const k = sp.slots.length;
            const box = text('div', 'album-overlay album-style', null, 'albumStyle');
            box.setAttribute('role', 'dialog');
            box.setAttribute('aria-modal', 'true');
            box.setAttribute('aria-label', '選版型');
            const head = text('div', 'album-picker-head');
            const close = button('albumStyleClose', 'album-icon-btn', '✕', '關閉');
            head.append(text('span', 'album-picker-title', '選這一跨頁的版型'), close);
            const mirror = button(null, 'album-relayout-btn album-mirror', '鏡像（左右對調）');
            mirror.dataset.albumMirror = '';
            const list = text('div', 'album-tpls', null, 'albumStyleList');
            const draw = () => {
                const m = !!this.cur.spreads[n].mirrored, curId = this.cur.spreads[n].template;
                mirror.setAttribute('aria-pressed', String(m));
                list.replaceChildren();
                for (const t of SpreadTemplates.TEMPLATES) {
                    if (t.slots.length !== k) continue;
                    const b = button(null, 'album-tpl', null);
                    b.dataset.templateId = t.id;
                    const here = t.id === curId;
                    if (here) { b.dataset.current = 'true'; b.setAttribute('aria-current', 'true'); }
                    b.setAttribute('aria-label', `${t.name}${here ? '（目前）' : ''}`);
                    const wire = text('span', 'album-tpl-wire');
                    t.slots.forEach(ts => {
                        const g = this.slotGeometry(ts, m);
                        const r = text('span', 'album-tpl-slot');
                        r.dataset.face = ts.face;
                        r.style.cssText = `left:${+(g.x * 100).toFixed(3)}%;top:${+(g.y * 100).toFixed(3)}%;width:${+(g.w * 100).toFixed(3)}%;height:${+(g.h * 100).toFixed(3)}%;`;
                        wire.append(r);
                    });
                    b.append(wire, text('span', 'album-tpl-name', t.name));
                    b.addEventListener('click', () => {
                        const quiet = t.id === this.cur.spreads[n].template;
                        this.closeOverlay();
                        if (!quiet) this.switchSpread(n, t.id, !!this.cur.spreads[n].mirrored, '已換版型');
                        this.focusAfterEdit();
                    });
                    list.append(b);
                }
            };
            mirror.addEventListener('click', () => {
                const was = !!this.cur.spreads[n].mirrored;
                if (this.switchSpread(n, this.cur.spreads[n].template, !was, was ? '已取消鏡像' : '已左右對調')) draw();
            });
            draw();
            box.append(head, mirror, list);
            close.addEventListener('click', () => this.closeOverlay());
            this.openOverlay(box);
            const here = list.querySelector('[data-current="true"]');
            if (here && typeof here.scrollIntoView === 'function') here.scrollIntoView({ block: 'nearest' });
            close.focus();
        },
        // 背景: nine swatches; the choice covers the cover, every spread and the back at once
        openBackground() {
            if (!this.edit || this.reviewing || this.overlay || !this.cur) return;
            const box = text('div', 'album-overlay album-style', null, 'albumBg');
            box.setAttribute('role', 'dialog');
            box.setAttribute('aria-modal', 'true');
            box.setAttribute('aria-label', '選背景顏色');
            const head = text('div', 'album-picker-head');
            const close = button('albumBgClose', 'album-icon-btn', '✕', '關閉');
            head.append(text('span', 'album-picker-title', '整本相本的背景顏色'), close);
            const grid = text('div', 'album-swatches');
            const nowId = this.bg || 'white';
            for (const c of BACKGROUND_COLORS) {
                const b = button(null, 'album-swatch-btn', null, `${c.label}${c.id === nowId ? '（目前）' : ''}`);
                b.dataset.bg = c.id;
                b.setAttribute('aria-pressed', String(c.id === nowId));
                const sw = text('span', 'album-swatch');
                sw.style.background = c.hex;
                b.append(sw, text('span', 'album-swatch-name', c.label));
                b.addEventListener('click', () => {
                    this.closeOverlay();
                    this.setBackground(c.id);
                    this.editSay(c.id === 'white' ? '背景已改回白色' : `背景已改成${c.label}`);
                    this.focusAfterEdit();
                });
                grid.append(b);
            }
            box.append(head, text('div', 'album-bg-note', '整本相本（封面、每個跨頁、封底）用同一個顏色'), grid);
            close.addEventListener('click', () => this.closeOverlay());
            this.openOverlay(box);
            (grid.querySelector('[aria-pressed="true"]') || close).focus();
        },
        focusAfterEdit() {
            const next = document.getElementById('albumNext');
            if ((this.el && !this.el.contains(document.activeElement)) || document.activeElement === document.body) (next && !next.disabled ? next : this.el).focus();
        },

        // a tap on a photo of the current page opens its candidate list
        onSlotClick(e) {
            if (!this.edit || this.reviewing || this.overlay || !this.pages.length) return;
            const d = this.downAt;
            this.downAt = null;
            if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > TAP_SLOP) return;      // a drag that ended on a photo is not a tap
            const box = e.target && e.target.closest ? e.target.closest('.album-slot') : null;
            const slide = box && box.closest('.album-slide');
            if (!box || box.dataset.slot === undefined || !slide || slide.dataset.current !== 'true') return;
            const ref = this.refOf(+slide.dataset.index, +box.dataset.slot);
            if (ref) this.openPicker(ref);
        },

        // ── 送出結帳: the whole book once, cover -> every spread -> back; 確認送出 opens only at the last page ──
        startReview() {
            if (!this.edit || this.reviewing || this.overlay) return;
            const o = AlbumPreview.order;
            const n = this.cur.spreads.length;
            if (!o || n < o.min || n > o.max) { this.refreshEdit(); return; }
            this.reviewing = true; this.reached = false;
            this.el.dataset.review = 'true';
            this.hideHint();
            this.foot.querySelector('.album-edit').hidden = true;
            this.foot.querySelector('.album-relayout').hidden = true;
            const row = text('div', 'album-review', null, 'albumReview');
            const msg = text('div', 'album-review-note', '請從封面翻到最後一頁，確認整本書。送出後無法修改。', 'albumReviewNote');
            msg.setAttribute('role', 'status');
            const back = button('albumReviewBack', 'album-relayout-btn album-edit-btn', '返回修改');
            const go = button('albumSubmit', 'album-relayout-btn album-edit-btn album-edit-go', '確認送出');
            go.disabled = true;
            const btns = text('div', 'album-edit-btns');
            btns.append(back, go);
            row.append(msg, btns);
            this.foot.append(row);
            back.addEventListener('click', () => this.endReview());
            go.addEventListener('click', () => this.confirmSubmit());
            this.show(0);
            const nx = document.getElementById('albumNext');
            if (nx) nx.focus();
        },
        endReview() {
            if (!this.reviewing) return;
            this.reviewing = false; this.reached = false;
            delete this.el.dataset.review;
            const rv = this.foot.querySelector('#albumReview');
            if (rv) rv.remove();
            this.foot.querySelector('.album-edit').hidden = false;
            this.foot.querySelector('.album-relayout').hidden = false;
            const go = document.getElementById('albumCheckout');
            if (go) go.focus();
        },
        noteReach() {
            if (!this.reviewing || this.index !== this.pages.length - 1) return;
            this.reached = true;
            const go = document.getElementById('albumSubmit');
            if (go) go.disabled = false;
            const msg = document.getElementById('albumReviewNote');
            if (msg) msg.textContent = '已看完整本書。送出後無法修改。';
        },
        confirmSubmit() {
            if (!this.reviewing || !this.reached || this.overlay) return;
            this.confirmBox('送出後排版無法修改，確定要送出嗎？', '確認送出', () => this.submit(), '再看看');
        },
        submit() {
            const o = AlbumPreview.order;
            const layout = this.layout();
            const msg = document.getElementById('albumReviewNote');
            const say = t => { if (msg) msg.textContent = t; };
            if (!layout) return;
            if (!o || o.locked || typeof o.submit !== 'function') { say(UNAVAILABLE); return; }
            if (layout.spreads.length < o.min || layout.spreads.length > o.max) { say('不符合這本相本的頁數，請返回修改。'); return; }
            if (new TextEncoder().encode(JSON.stringify(layout)).length > LAYOUT_MAX_BYTES) { say('這本相本內容太大，無法送出。'); return; }
            // hand over first: the viewer goes only when the order sheet took it, else the layout stays here and the guest is told
            let taken = false;
            try { taken = o.submit(layout) !== false; } catch (e) { taken = false; }
            if (!taken) { say(UNAVAILABLE); return; }
            this.close(true);                  // the order sheet has the focus now
        },
        // Layout JSON v2 (docs/guest-shop.md): photo_key is the key the preview draws with; crops to 3 decimals; no spreads count
        layout() {
            if (!this.cur) return null;
            const one = x => ({ photo_key: x.photoId, fit: x.fit === 'contain' ? 'contain' : 'cover',
                crop: { x: round3((x.crop && x.crop.x) || 0), y: round3((x.crop && x.crop.y) || 0), scale: 1 } });
            return { v: 2, mode: 'auto',
                cover: this.cur.cover && this.cur.cover.photoId ? one(this.cur.cover) : null,
                spreads: this.cur.spreads.map(sp => {
                    const o = { template: sp.template };
                    if (sp.mirrored) o.mirrored = true;
                    o.slots = sp.slots.map(one);
                    return o;
                }),
                back: this.cur.back ? {} : null,
                ...(this.bg && colorById(this.bg) ? { background: { type: 'color', value: this.bg } } : {}) };      // no key at all = white, as before
        },

        // ── pages ──
        total() { return this.pages.filter(p => p.kind === 'spread').length; },   // spreads (the cover and back are not counted)

        go(delta) {
            this.hideHint();
            const to = Math.min(this.pages.length - 1, Math.max(0, this.index + delta));
            if (to === this.index) { this.snapBack(); return; }
            this.show(to);
        },

        show(index) {
            this.resetZoom(false);          // a new page always starts at 1x
            this.index = index;
            this.stage.classList.remove('dragging');
            this.stage.style.removeProperty('--drag');
            this.stage.style.setProperty('--cur', String(index));
            for (const s of [...this.stage.querySelectorAll('.album-slide')]) {
                if (Math.abs(+s.dataset.index - index) > 1) this.dropSlide(s);
            }
            for (let i = index - 1; i <= index + 1; i++) {
                if (i < 0 || i >= this.pages.length) continue;
                if (!this.stage.querySelector(`.album-slide[data-index="${i}"]`)) this.addSlide(i);
            }
            for (const s of this.stage.querySelectorAll('.album-slide')) {
                const cur = +s.dataset.index === index;
                s.dataset.current = cur ? 'true' : 'false';
                s.setAttribute('aria-hidden', cur ? 'false' : 'true');
                s.querySelectorAll('img').forEach(im => { im.fetchPriority = cur ? 'high' : 'low'; });
            }
            const label = document.getElementById('albumLabel');
            const kind = this.pages[index].kind;
            if (label) label.textContent = kind === 'cover' ? '封面' : kind === 'back' ? '封底' : `${index} / ${this.total()}`;
            const prev = document.getElementById('albumPrev'), next = document.getElementById('albumNext');
            if (prev) prev.disabled = index === 0;
            if (next) next.disabled = index === this.pages.length - 1;
            if (this.edit) this.refreshStyleBtn();
            // a disabled button cannot keep the focus
            if (this.el && !this.el.contains(document.activeElement)) (next && !next.disabled ? next : prev || this.el).focus();
            this.noteReach();
        },

        // a slide leaving the window gives its pictures back (a phone keeps a
        // decoded copy of a detached <img> until it is collected)
        dropSlide(slide) {
            slide.querySelectorAll('img').forEach(im => { im.removeAttribute('src'); });
            slide.remove();
        },

        addSlide(i) {
            const slide = text('div', 'album-slide');
            slide.dataset.index = String(i);
            slide.style.setProperty('--i', String(i));
            const pageData = this.pages[i];
            const page = this.renderPage(pageData);
            slide.appendChild(page);
            this.stage.appendChild(slide);
            this.sizePage(page, pageData);
            // sources last: the frames have their size when the first load event fires
            const w = this.imageWidth(page);
            page.querySelectorAll('img').forEach(im => { im.src = window.driveManager.getImageUrl({ id: im.dataset.photoId }, w); });
        },

        // The drawing layouts.js uses (contain: the whole photo inside its slot, as fitContainImage works it out;
        // cover: fitCoverImage, the photo scaled to cover its slot, positioned by crop), built with DOM calls —
        // renderPageHTML would put a photo key into an HTML string, and brings
        // the editor's x / right-click buttons and a fixed 1600px width. A slot's
        // box is the template's own fractions of the page (or spread).
        renderPage(pageData) {
            const page = text('div', 'album-page');
            page.dataset.kind = pageData.kind;
            page.dataset.layout = pageData.layout;
            page.style.background = Viewer.pageColor();     // the book's colour (white = the paper); a contain frame has no ground, so it shows through
            const pct = v => `${+(v * 100).toFixed(3)}%`;
            // Bleed: the page box is the whole printed sheet and the template's fractions are the finished page, which
            // sits inside it. Edge photos that fill their frame (cover) run on out to the sheet edge so the cut finds
            // paper with picture on it; a whole photo (contain) stays inside the trim. Only the outer edges of the
            // sheet bleed: the middle of a spread is a fold, not a cut.
            const bleed = normBleed(AlbumPreview.bleedMm);
            const bw = pageData.kind === 'spread' ? 2 * PAGE_MM.w : PAGE_MM.w;
            const bx = bleed / bw, by = bleed / PAGE_MM.h;
            if (bleed) page.dataset.bleed = String(bleed);
            const EDGE_TOL = 0.001;
            pageData.slots.forEach((slot, slotIdx) => {
                if (!slot || !slot.photoId || !slot.slot) return;
                const sd = slot.slot;
                const contain = slot.fit === 'contain';       // absent = cover, as layouts.js reads slot.fit
                const box = text('div', 'album-slot');
                if (contain) box.dataset.fit = 'contain';
                if (Viewer.edit) box.dataset.slot = String(slotIdx);       // edit mode only: the read-only markup is untouched
                if (!bleed) box.style.cssText = `left:${pct(sd.x)};top:${pct(sd.y)};width:${pct(sd.w)};height:${pct(sd.h)};`;
                else {
                    let l = bx + sd.x * (1 - 2 * bx), t = by + sd.y * (1 - 2 * by);
                    let r = bx + (sd.x + sd.w) * (1 - 2 * bx), b = by + (sd.y + sd.h) * (1 - 2 * by);
                    if (!contain) {
                        if (sd.x <= EDGE_TOL) l = 0;
                        if (sd.y <= EDGE_TOL) t = 0;
                        if (sd.x + sd.w >= 1 - EDGE_TOL) r = 1;
                        if (sd.y + sd.h >= 1 - EDGE_TOL) b = 1;
                    }
                    box.style.cssText = `left:${pct(l)};top:${pct(t)};width:${pct(r - l)};height:${pct(b - t)};`;
                }
                const wrap = text('div', 'album-slot-crop');
                const crop = slot.crop || {};
                const img = new Image();
                img.className = 'album-img';
                img.alt = '';
                img.draggable = false;
                img.decoding = 'async';
                img.loading = 'eager';          // at most three pages exist, so the neighbours are preloaded on purpose
                if (contain) img.dataset.fit = 'contain';
                img.dataset.photoId = slot.photoId;
                img.dataset.scale = String(crop.scale || 1);
                img.dataset.cropx = String(crop.x || 0);
                img.dataset.cropy = String(crop.y || 0);
                img.dataset.rot = '0';
                img.addEventListener('load', () => { img.style.visibility = ''; fitPhoto(img); });
                img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
                wrap.appendChild(img);
                box.appendChild(wrap);
                page.appendChild(box);
            });
            const title = pageData.kind === 'cover' ? coverTitleOf(AlbumPreview.coverTitle) : '';
            if (title) {
                // The project title, at the top of the cover only: inside the trim (the bleed strip is the printer's, not
                // ours), white on a soft dark fade, sized in the page's own container units (css/completion-page.css).
                // textContent, never innerHTML; it takes no tap or drag (pointer-events: none, so the viewer's gestures
                // see the page, not the title).
                page.dataset.titled = 'true';          // CSS: the cover becomes the container its title is sized in
                const box = text('div', 'album-cover-title');
                box.dataset.tier = String(titleTier(title));
                box.setAttribute('dir', 'auto');
                box.style.paddingTop = `calc(${pct(bx)} + 6cqw)`;
                box.style.paddingLeft = box.style.paddingRight = `calc(${pct(bx)} + 7cqw)`;
                box.appendChild(text('div', 'album-cover-title-text', title));
                page.appendChild(box);
            }
            if (bleed) {
                // the trim line: dashed, with everything outside it dimmed (the part the printer cuts off)
                const guide = text('div', 'album-bleed-guide');
                guide.setAttribute('aria-hidden', 'true');
                guide.style.cssText = `position:absolute;z-index:3;pointer-events:none;box-sizing:border-box;left:${pct(bx)};top:${pct(by)};right:${pct(bx)};bottom:${pct(by)};` +
                    'border:1px dashed rgba(255,255,255,.9);box-shadow:0 0 0 1px rgba(0,0,0,.45),0 0 0 100vmax rgba(0,0,0,.38);';
                page.appendChild(guide);
            }
            return page;
        },

        // largest page of this shape that fits the stage, with a gutter: none at
        // the sides for a spread on an upright phone (it takes the whole width)
        pageSize(pageData) {
            let gx = 24, gy = 24;
            if (window.innerWidth <= PHONE_W) { gx = pageData.kind === 'spread' ? 0 : 16; gy = 12; }
            else if (window.innerHeight <= SHORT_H) { gx = 12; gy = 8; }
            const aw = Math.max(80, this.stage.clientWidth - 2 * gx);
            const ah = Math.max(80, this.stage.clientHeight - 2 * gy);
            const w = Math.min(aw, ah * pageData.aspect);
            return { w: Math.floor(w), h: Math.floor(w / pageData.aspect) };
        },
        sizePage(page, pageData) {
            const { w, h } = this.pageSize(pageData);
            page.style.width = `${w}px`;
            page.style.height = `${h}px`;
        },
        // the pre-generated bucket (400 / 1200 / 1600) for the size this page is shown at,
        // by the rule the gallery's preview uses (offsetWidth: not the zoomed size)
        imageWidth(page) {
            const w = page.offsetWidth || this.pageSize(this.pages[this.index] || { kind: 'spread', aspect: SPREAD_ASPECT }).w;
            const dm = window.driveManager;
            return dm && typeof dm.previewWidth === 'function' ? dm.previewWidth(w, window.devicePixelRatio || 1) : 1200;
        },
        // rotation / window resize: new frame sizes, so the crop is fitted again (at 1x)
        refit() {
            if (!this.el || !this.stage || !this.pages.length) return;
            this.resetZoom(false);
            for (const slide of this.stage.querySelectorAll('.album-slide')) {
                const page = slide.firstElementChild;
                this.sizePage(page, this.pages[+slide.dataset.index]);
                page.querySelectorAll('img').forEach(im => { if (im.naturalWidth) fitPhoto(im); });
            }
        },

        // ── zoom ──
        currentPage() { return this.stage ? this.stage.querySelector('.album-slide[data-current="true"] .album-page') : null; },
        isZoomed() { return this.zoom.s > 1.001; },

        // Scale `s` and pan (x, y) from the stage's centre, with the pan held inside what keeps
        // the page covering the window on every side it is bigger than (never a blank edge).
        setZoom(s, x, y, animate) {
            const pg = this.currentPage();
            if (!pg) return;
            s = clamp(s, 1, ZOOM_MAX);
            if (s < 1.001) { s = 1; x = 0; y = 0; }
            else {
                const mx = Math.max(0, (pg.offsetWidth * s - this.stage.clientWidth) / 2);
                const my = Math.max(0, (pg.offsetHeight * s - this.stage.clientHeight) / 2);
                x = clamp(x, -mx, mx); y = clamp(y, -my, my);
            }
            this.zoom = { s, x, y };
            pg.classList.toggle('zoom-anim', !!animate);
            pg.style.transform = s === 1 ? '' : `translate(${x}px, ${y}px) scale(${s})`;
            this.stage.dataset.zoom = s.toFixed(2);
            this.stage.classList.toggle('zoomed', s > 1.001);
        },
        resetZoom(animate) {
            if (this.stage && (this.zoom.s !== 1 || this.zoom.x !== 0 || this.zoom.y !== 0 || !this.stage.dataset.zoom)) this.setZoom(1, 0, 0, animate);
        },
        // zoom to `s`, keeping the content under the screen point (cx, cy) where it is
        zoomAt(s, cx, cy, animate) {
            const r = this.stage.getBoundingClientRect();
            const px = cx - (r.left + r.width / 2), py = cy - (r.top + r.height / 2);
            const z = this.zoom;
            const qx = (px - z.x) / z.s, qy = (py - z.y) / z.s;
            s = clamp(s, 1, ZOOM_MAX);
            this.setZoom(s, px - qx * s, py - qy * s, animate);
        },
        toggleZoom(cx, cy) {
            if (this.isZoomed()) this.setZoom(1, 0, 0, true);
            else this.zoomAt(ZOOM_DOUBLE, cx, cy, true);
        },

        // ── the hint (phone width only): one line, gone after a few seconds or at the first touch ──
        showHint() {
            if (window.innerWidth > PHONE_W || !this.stage) return;
            const h = text('div', 'album-hint', this.edit ? '點照片換圖・兩指放大' : '雙擊放大・橫放手機看更大', 'albumHint');
            h.setAttribute('aria-hidden', 'true');
            this.stage.appendChild(h);
            this.hint = h;
            this.hintTimer = setTimeout(() => { this.hintTimer = null; this.hideHint(); }, HINT_MS);
        },
        hideHint() {
            if (this.hintTimer) { clearTimeout(this.hintTimer); this.hintTimer = null; }
            const h = this.hint;
            if (!h) return;
            this.hint = null;
            h.classList.add('gone');
            this.hintFade = setTimeout(() => { this.hintFade = null; h.remove(); }, HINT_FADE_MS);
        },
        clearHintTimers() {
            if (this.hintTimer) { clearTimeout(this.hintTimer); this.hintTimer = null; }
            if (this.hintFade) { clearTimeout(this.hintFade); this.hintFade = null; }
        },

        // ── input ──
        onKey(e) {
            if (!this.el) return;
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (this.overlay) this.closeOverlay(); else this.close(); return; }
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                if (this.el.dataset.state !== 'ready' || this.overlay) return;
                e.preventDefault();
                this.go(e.key === 'ArrowRight' ? 1 : -1);
                return;
            }
            if (e.key === 'Tab') {      // the dialog is modal: Tab goes round inside it
                const items = [...(this.overlay || this.el).querySelectorAll('button:not([disabled])')].filter(b => !b.closest('[inert]'));
                if (!items.length) { e.preventDefault(); this.el.focus(); return; }
                const first = items[0], last = items[items.length - 1], at = document.activeElement;
                if (!(this.overlay || this.el).contains(at) || (e.shiftKey && (at === first || at === this.el)) || (!e.shiftKey && at === last)) {
                    e.preventDefault();
                    (e.shiftKey ? last : first).focus();
                }
            }
        },

        // One finger: a swipe flips (at 1x), a drag pans (zoomed), two taps in a row zoom.
        // Two fingers: pinch. A touch starting within EDGE px of a screen edge is the
        // browser's back gesture and is ignored.
        onTouchStart(e) {
            this.hideHint();
            if (!this.pages.length) return;
            if (e.touches.length >= 2) { this.startPinch(e); return; }
            const t = e.touches[0];
            this.g = null;
            if (t.clientX < EDGE || t.clientX > window.innerWidth - EDGE) { this.lastTap = null; return; }
            this.g = { mode: this.isZoomed() ? 'pan' : 'swipe', x: t.clientX, y: t.clientY, lx: t.clientX, ly: t.clientY,
                dx: 0, dy: 0, dir: null, moved: false, t0: e.timeStamp };
        },
        onTouchMove(e) {
            const g = this.g;
            if (!g) return;
            if (g.mode === 'pinch') { if (e.touches.length >= 2) this.movePinch(e); return; }
            if (e.touches.length !== 1) { this.g = null; this.snapBack(); return; }
            const t = e.touches[0];
            g.dx = t.clientX - g.x; g.dy = t.clientY - g.y;
            if (!g.moved && Math.hypot(g.dx, g.dy) > TAP_SLOP) g.moved = true;
            if (g.mode === 'pan') {
                const z = this.zoom;
                this.setZoom(z.s, z.x + (t.clientX - g.lx), z.y + (t.clientY - g.ly), false);
                g.lx = t.clientX; g.ly = t.clientY;
                return;
            }
            if (!g.dir && Math.hypot(g.dx, g.dy) > 10) g.dir = Math.abs(g.dx) > Math.abs(g.dy) * 1.2 ? 'h' : 'v';
            if (g.dir !== 'h') return;
            // the first / last page gives way less, so it feels like an end
            const atEnd = (g.dx > 0 && this.index === 0) || (g.dx < 0 && this.index === this.pages.length - 1);
            this.stage.classList.add('dragging');
            this.stage.style.setProperty('--drag', `${atEnd ? g.dx * 0.25 : g.dx}px`);
        },
        onTouchEnd(e) {
            this.touchAt = performance.now();
            const g = this.g;
            if (!g) return;
            if (g.mode === 'pinch') {
                this.lastTap = null;
                if (e.touches.length >= 2) return;
                if (this.zoom.s <= ZOOM_SNAP) { this.g = null; this.resetZoom(true); return; }
                if (e.touches.length === 1) {       // a finger is left: keep dragging with it
                    const t = e.touches[0];
                    this.g = { mode: 'pan', x: t.clientX, y: t.clientY, lx: t.clientX, ly: t.clientY, dx: 0, dy: 0, dir: null, moved: true, t0: e.timeStamp };
                } else this.g = null;
                return;
            }
            this.g = null;
            if (!g.moved && e.timeStamp - g.t0 <= TAP_MS) { this.onTap(g.x, g.y, e.timeStamp); this.snapBack(); return; }
            if (g.mode === 'pan') return;
            const min = Math.max(SWIPE_MIN, this.stage.clientWidth * SWIPE_FRAC);
            if (g.dir === 'h' && Math.abs(g.dx) >= min && Math.abs(g.dx) > Math.abs(g.dy) * 1.5) this.go(g.dx < 0 ? 1 : -1);
            else this.snapBack();
        },
        onTouchCancel() {
            const wasPinch = this.g && this.g.mode === 'pinch';
            this.g = null; this.lastTap = null;
            this.snapBack();
            if (wasPinch && this.zoom.s <= ZOOM_SNAP) this.resetZoom(true);
        },
        onTap(x, y, time) {
            if (this.edit) return;          // a tap picks a photo there (onSlotClick); zoom is the pinch and the wheel
            const last = this.lastTap;
            if (last && time - last.t <= DOUBLE_TAP_MS && Math.hypot(x - last.x, y - last.y) <= DOUBLE_TAP_DIST) {
                this.lastTap = null;
                this.toggleZoom(x, y);
            } else this.lastTap = { x, y, t: time };
        },
        startPinch(e) {
            const a = e.touches[0], b = e.touches[1];
            this.snapBack();
            this.lastTap = null;
            const r = this.stage.getBoundingClientRect(), z = this.zoom;
            const mx = (a.clientX + b.clientX) / 2 - (r.left + r.width / 2), my = (a.clientY + b.clientY) / 2 - (r.top + r.height / 2);
            this.g = { mode: 'pinch', d0: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)), s0: z.s,
                qx: (mx - z.x) / z.s, qy: (my - z.y) / z.s };      // the picture point between the fingers
        },
        // the scale follows the spread of the fingers; the picture point that was between them follows their middle
        movePinch(e) {
            const g = this.g, a = e.touches[0], b = e.touches[1];
            const r = this.stage.getBoundingClientRect();
            const mx = (a.clientX + b.clientX) / 2 - (r.left + r.width / 2), my = (a.clientY + b.clientY) / 2 - (r.top + r.height / 2);
            const s = clamp(g.s0 * Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / g.d0, 1, ZOOM_MAX);
            this.setZoom(s, mx - g.qx * s, my - g.qy * s, false);
        },
        snapBack() {
            if (!this.stage) return;
            this.stage.classList.remove('dragging');
            this.stage.style.setProperty('--drag', '0px');
        },

        // desktop: the wheel zooms about the cursor, a double click toggles 2.5x, a mouse drag pans
        onWheel(e) {
            if (!this.pages.length) return;
            e.preventDefault();             // no page scroll, no browser zoom under the cursor
            this.hideHint();
            const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
            this.zoomAt(this.zoom.s * Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.002)), e.clientX, e.clientY, false);
        },
        onDblClick(e) {
            if (!this.pages.length || this.edit) return;
            if (performance.now() - this.touchAt < 700) return;      // a touch double tap already did it
            this.hideHint();
            this.toggleZoom(e.clientX, e.clientY);
        },
        onPointerDown(e) {
            if (this.edit) this.downAt = { x: e.clientX, y: e.clientY };
            if (e.pointerType !== 'mouse' || e.button !== 0 || !this.isZoomed()) return;
            this.mouse = { x: e.clientX, y: e.clientY };
            try { this.stage.setPointerCapture(e.pointerId); } catch (err) { /* no capture: the drag still works inside the stage */ }
        },
        onPointerMove(e) {
            const m = this.mouse;
            if (!m || !(e.buttons & 1)) return;
            const z = this.zoom;
            this.setZoom(z.s, z.x + (e.clientX - m.x), z.y + (e.clientY - m.y), false);
            m.x = e.clientX; m.y = e.clientY;
        },
        onPointerEnd(e) {
            if (!this.mouse) return;
            this.mouse = null;
            try { this.stage.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
        },
    };

    // ── the public face js/pick.js talks to ───────────────────────────────
    const AlbumPreview = {
        COVER_ASPECT, SPREAD_ASPECT,
        MAX_PHOTOS: 240,          // more than this: the first 240 in shooting order, and it says so
        CHUNK: 24,                // photos analysed per call: the progress granularity
        LIST_MAX_FOLDERS: 200,    // the listing never walks more folders than this
        PLAN_OPTS: {},            // extra options for AutoLayout.planSpreads (e.g. { back: true, minSpreads, maxSpreads }); the shapes above always win
        folders: [],
        // mm of bleed the printer trims off each outer edge (the product's bleed_mm; null / 0 = none = the page is
        // drawn exactly as before). Read when a page is drawn, so set it before the viewer opens.
        bleedMm: 0,
        // the project title drawn at the top of the cover (js/completion-page.js sets it with the page; '' = nothing drawn)
        coverTitle: '',
        // Editing + ordering (js/completion-page.js sets it for the seat owner of a confirmed project with ordering on and an orderable
        // album product, else null = the read-only preview): { product, min, max, submit(layout), locked }. `min` / `max` are the spread
        // counts the book may have, `submit` hands the Layout JSON v2 to js/guest-order.js. `locked` (set by lockOrder) ends editing.
        order: null,
        SHAPE_WASTE_WARN, HISTORY_MAX, LAYOUT_MAX_BYTES, BACKGROUND_COLORS,
        lockOrder() { if (this.order) this.order.locked = true; },
        // the layout of the open viewer in edit mode (null otherwise); for the tests
        currentLayout() { return Viewer.edit ? Viewer.layout() : null; },
        _testViewer() { return Viewer; },       // for the browser suites only
        onResult: null,           // optional (hint: string | null) => void, called after every run (the page behind the viewer shows the hint)
        boundsHint,

        reportHint(hint) {
            if (typeof this.onResult !== 'function') return;
            try { this.onResult(hint); } catch (e) { /* a page's own callback never breaks the viewer */ }
        },

        // Every photo under the final folders (subfolders included), as ids, in listing order. Rejects when
        // a listing fails. For the 下載全部精修 button; the same walk the preview uses.
        listFinalIds(folders, signal) {
            return listFinals(Array.isArray(folders) ? folders : [], signal || new AbortController().signal, this);
        },

        // Show the entry right after `after` (a delivered finals view with at
        // least one final folder), or remove it — and close the viewer if it
        // is open — when `show` is false. Idempotent: pick.js calls it on
        // every re-render.
        syncEntry({ show, after, folders, bleedMm }) {
            if (bleedMm !== undefined) this.bleedMm = normBleed(bleedMm);
            let entry = document.getElementById('albumPreviewEntry');
            if (!show || !after || !after.parentNode || !Array.isArray(folders) || !folders.length) {
                if (Viewer.isOpen()) Viewer.close();
                entry?.remove();
                this.folders = [];
                return;
            }
            this.folders = folders.slice();
            if (!entry) {
                entry = text('div', 'album-entry', null, 'albumPreviewEntry');
                const btn = button('albumPreviewBtn', 'album-entry-btn', null);
                btn.setAttribute('aria-haspopup', 'dialog');
                const body = text('span', 'album-entry-text');
                body.append(text('span', 'album-entry-title', '✨ 看看你的照片排成相本'),
                    text('span', 'album-entry-sub', '這是系統自動排版的示意，實際相本可由攝影師調整'));
                const chev = text('span', 'album-entry-chev', '›');
                chev.setAttribute('aria-hidden', 'true');
                btn.append(body, chev);
                btn.addEventListener('click', () => this.open(btn));
                entry.appendChild(btn);
            }
            if (entry.previousElementSibling !== after) after.after(entry);
        },

        open(opener) {
            if (Viewer.isOpen() || !this.folders.length) return;
            Viewer.open(this.folders.slice(), opener || document.getElementById('albumPreviewBtn'));
        },
        close() { Viewer.close(); },
        isOpen() { return Viewer.isOpen(); },
    };

    window.AlbumPreview = AlbumPreview;
})();
