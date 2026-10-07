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
        return { kind: 'ready', plan, notes, hint: boundsHint(plan, ok - dup), items, photoCount: ok - dup };
    }

    // The plan for `variant` (0 = the first layout; n > 0 = the same photos laid out another way, AutoLayout's `variant`).
    // Pure and local: the analysed items are kept, so 再次編排 never touches the network again.
    function planFor(items, cfg, variant) {
        const o = { ...cfg.PLAN_OPTS, coverAspect: cfg.COVER_ASPECT, spreadAspect: cfg.SPREAD_ASPECT };
        if (variant > 0) o.variant = variant;
        return AutoLayout.planSpreads(items, o);
    }
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

    // ── the viewer ────────────────────────────────────────────────────────
    const Viewer = {
        el: null, stage: null, ctl: null, runId: 0, off: [], opener: null,
        pages: [], index: 0,
        g: null,                              // the gesture in progress: swipe | pan | pinch
        zoom: { s: 1, x: 0, y: 0 },           // the current page's zoom: scale and pan (px from centre)
        lastTap: null, touchAt: 0, mouse: null,
        hint: null, hintTimer: null, hintFade: null,
        items: null, photoCount: 0, variant: 0, basePlan: null,   // re-layout: the analysed photos and the layout number (0 = the first)

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

            this.folders = folders;
            this.run();
        },

        close() {
            if (!this.el) return;
            this.runId++;
            if (this.ctl) { this.ctl.abort(); this.ctl = null; }
            this.off.splice(0).forEach(f => f());
            this.clearHintTimers();
            this.el.querySelectorAll('.album-slide').forEach(s => this.dropSlide(s));
            this.el.remove();
            this.el = this.stage = this.foot = null;
            this.pages = []; this.g = null; this.index = 0; this.mouse = null; this.lastTap = null; this.hint = null;
            this.items = null; this.basePlan = null; this.variant = 0;     // closing forgets the layout number: nothing is stored
            this.zoom = { s: 1, x: 0, y: 0 };
            document.documentElement.classList.remove('album-open');
            const btn = document.getElementById('albumPreviewBtn');
            const back = btn || this.opener;
            this.opener = null;
            if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
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
            this.pages = pagesOf(plan);
            const note = text('div', 'album-note', notes.join('・'), 'albumNote');
            note.hidden = notes.length === 0;
            // the bounds could not be met: said plainly, above the page buttons (present only then)
            const bounds = hint ? this.boundsEl(hint) : null;
            const prev = button('albumPrev', 'album-nav-btn', '‹', '上一頁');
            const next = button('albumNext', 'album-nav-btn', '›', '下一頁');
            const label = text('div', 'album-label', '', 'albumLabel');
            label.setAttribute('aria-live', 'polite');
            const row = text('div', 'album-nav'); row.append(prev, label, next);
            if (bounds) this.foot.append(bounds);
            this.foot.append(note, row, this.relayoutRow());
            prev.addEventListener('click', () => this.go(-1));
            next.addEventListener('click', () => this.go(1));
            this.index = 0;
            this.show(0);
            next.focus();
            this.showHint();
        },

        boundsEl(hint) {
            const b = text('div', 'album-bounds', hint, 'albumBounds');
            b.setAttribute('role', 'status');
            return b;
        },

        // 再次編排 / 回到原本: the same photos, another layout. Local only (the analysed items are kept), nothing stored.
        relayoutRow() {
            const row = text('div', 'album-relayout');
            const again = button('albumRelayout', 'album-relayout-btn', '再次編排');
            const back = button('albumRelayoutBack', 'album-relayout-btn album-relayout-back', '回到原本');
            back.hidden = true;
            const cap = text('div', 'album-relayout-cap', '這是系統自動排版的示意，換個排法看看', 'albumRelayoutCap');
            const btns = text('div', 'album-relayout-btns');
            btns.append(again, back);
            row.append(btns, cap);
            again.addEventListener('click', () => this.relayout(this.variant + 1));
            back.addEventListener('click', () => this.relayout(0));
            return row;
        },

        // Swap to layout number `variant` (0 = the first one). The page index is kept when it still exists (clamped), the
        // counters and the bounds sentence follow the new plan, the cover title is drawn again with the cover.
        relayout(variant) {
            if (!this.el || !this.items || !this.pages.length) return;
            let plan;
            try { plan = variant === 0 && this.basePlan ? this.basePlan : planFor(this.items, AlbumPreview, variant); } catch (e) { return; }
            if (!plan || !plan.cover || !plan.spreads.length) return;
            this.variant = variant;
            this.hideHint();
            for (const s of [...this.stage.querySelectorAll('.album-slide')]) this.dropSlide(s);
            this.pages = pagesOf(plan);
            const hint = boundsHint(plan, this.photoCount);
            const old = this.foot.querySelector('#albumBounds');
            if (old) old.remove();
            if (hint) this.foot.prepend(this.boundsEl(hint));
            const back = document.getElementById('albumRelayoutBack');
            if (back) {
                const hadFocus = document.activeElement === back;
                back.hidden = variant === 0;
                if (hadFocus && back.hidden) document.getElementById('albumRelayout')?.focus();
            }
            this.show(Math.min(this.index, this.pages.length - 1));
            AlbumPreview.reportHint(hint);
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
            // a disabled button cannot keep the focus
            if (this.el && !this.el.contains(document.activeElement)) (next && !next.disabled ? next : prev || this.el).focus();
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
            page.style.background = '#ffffff';
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
            pageData.slots.forEach(slot => {
                if (!slot || !slot.photoId || !slot.slot) return;
                const sd = slot.slot;
                const contain = slot.fit === 'contain';       // absent = cover, as layouts.js reads slot.fit
                const box = text('div', 'album-slot');
                if (contain) box.dataset.fit = 'contain';
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
            const h = text('div', 'album-hint', '雙擊放大・橫放手機看更大', 'albumHint');
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
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); return; }
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                if (this.el.dataset.state !== 'ready') return;
                e.preventDefault();
                this.go(e.key === 'ArrowRight' ? 1 : -1);
                return;
            }
            if (e.key === 'Tab') {      // the dialog is modal: Tab goes round inside it
                const items = [...this.el.querySelectorAll('button:not([disabled])')];
                if (!items.length) { e.preventDefault(); this.el.focus(); return; }
                const first = items[0], last = items[items.length - 1], at = document.activeElement;
                if (!this.el.contains(at) || (e.shiftKey && (at === first || at === this.el)) || (!e.shiftKey && at === last)) {
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
            if (!this.pages.length) return;
            if (performance.now() - this.touchAt < 700) return;      // a touch double tap already did it
            this.hideHint();
            this.toggleZoom(e.clientX, e.clientY);
        },
        onPointerDown(e) {
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
