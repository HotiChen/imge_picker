// Album preview, stage 1 (docs/album-preview.md): after delivery the guest can
// see their own finals laid out as an album — a cover and inner pages they flip
// through. Read-only and local: nothing is stored, nothing is ordered, nothing
// is written (no POST/PUT, no localStorage / sessionStorage), and only
// thumbnails are ever requested (`?w=` + `?t=`, never an original).
//
// js/pick.js owns when the entry shows (delivered mode, finals view only) and
// calls AlbumPreview.syncEntry(); this file owns everything after the press:
//   1. load book_editor/js/layouts.js + auto_layout.js (only now, with the same
//      ?v= stamp as this very script — nothing is hard-coded here),
//   2. list the finals (the final folders and every subfolder),
//   3. AutoLayout.analyze in chunks of CHUNK (so there is real progress; it has
//      no progress callback) and AutoLayout.plan,
//   4. a full-screen dark viewer: cover + inner pages, flip by button, ← / →
//      or a swipe; only the current page and its two neighbours exist in the DOM.
//
// Every string that came from outside (photo keys) only ever reaches
// img.src as a property — no innerHTML anywhere in this file, so a file name
// that is markup stays text. book_editor.js / exporter.js are not loaded.
(function () {
    'use strict';

    const SCRIPT_SRC = (document.currentScript && document.currentScript.src) || '';

    // One square sheet at a time, like the book editor's default book
    // (settings 20 x 20 cm, coverSettings 20 x 20) and the client viewer
    // (view.html shows one sheet at the book's own aspect). A spread (aspect 2)
    // would be 195px tall on a 390px phone. The same value goes to plan() and
    // to the renderer, so a crop is drawn on the shape it was made for.
    const PAGE_ASPECT = 1;
    const COVER_ASPECT = 1;

    const EDGE = 24;          // a touch starting this close to a screen edge is the browser's back gesture
    const SWIPE_MIN = 40;     // px, or SWIPE_FRAC of the page width, whichever is larger
    const SWIPE_FRAC = 0.12;
    const GUTTER_DESKTOP = 24;
    const GUTTER_PHONE = 12;

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
    const abortError = () => {
        if (typeof DOMException === 'function') return new DOMException('Aborted', 'AbortError');
        const e = new Error('Aborted'); e.name = 'AbortError'; return e;
    };
    const isAbort = e => !!e && e.name === 'AbortError';

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
        const have = () => typeof LAYOUTS !== 'undefined' && typeof AutoLayout !== 'undefined' && typeof fitCoverImage === 'function';
        if (have()) return Promise.resolve();
        if (!enginePromise) {
            enginePromise = (async () => {
                if (typeof LAYOUTS === 'undefined') await loadScript(engineUrl('layouts.js'));
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

        const plan = AutoLayout.plan(items, { style: 'auto', pageAspect: cfg.PAGE_ASPECT, coverAspect: cfg.COVER_ASPECT });
        const dup = plan.dropped.filter(d => d.reason === 'duplicate').length;
        if (ok - dup < 2 || !plan.cover || plan.pages.length === 0) return { kind: 'few' };
        const notes = [];
        if (dup > 0) notes.push(`已略過 ${dup} 張相近的照片`);
        if (capped) notes.push(`已先用前 ${cfg.MAX_PHOTOS} 張排版`);
        if (failed > 0) notes.push(`${failed} 張照片讀取失敗，未放入相本`);
        return { kind: 'ready', plan, notes };
    }

    // ── the viewer ────────────────────────────────────────────────────────
    const Viewer = {
        el: null, stage: null, ctl: null, runId: 0, off: [], opener: null,
        pages: [], index: 0, touch: null,

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
            stage.addEventListener('touchstart', e => this.onTouchStart(e), { passive: true });
            stage.addEventListener('touchmove', e => this.onTouchMove(e), { passive: true });
            stage.addEventListener('touchend', e => this.onTouchEnd(e), { passive: true });
            stage.addEventListener('touchcancel', () => this.snapBack(), { passive: true });

            this.folders = folders;
            this.run();
        },

        close() {
            if (!this.el) return;
            this.runId++;
            if (this.ctl) { this.ctl.abort(); this.ctl = null; }
            this.off.splice(0).forEach(f => f());
            this.el.querySelectorAll('.album-slide').forEach(s => this.dropSlide(s));
            this.el.remove();
            this.el = this.stage = this.foot = null;
            this.pages = []; this.touch = null; this.index = 0;
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
                else this.showAlbum(res.plan, res.notes);
            }, err => {
                if (id !== this.runId || isAbort(err) || ctl.signal.aborted) return;
                this.showError(err && err.kind === 'photos'
                    ? '照片讀取失敗，請檢查網路後再試'
                    : '無法載入相本，請檢查網路後再試');
            });
        },

        setState(state) {
            this.el.dataset.state = state;
            this.stage.replaceChildren();
            this.foot.replaceChildren();
            this.stage.style.removeProperty('--cur');
            this.stage.style.removeProperty('--drag');
            this.stage.classList.remove('dragging');
            this.pages = [];
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

        showAlbum(plan, notes) {
            this.setState('ready');
            this.pages = [
                { aspect: COVER_ASPECT, layout: 'full-bleed', bg: '#ffffff', slots: [{ photoId: plan.cover.photoId, crop: plan.cover.crop }] },
                ...plan.pages.map(p => ({ aspect: PAGE_ASPECT, layout: p.layout, bg: p.bg, slots: p.slots })),
            ];
            const note = text('div', 'album-note', notes.join('・'), 'albumNote');
            note.hidden = notes.length === 0;
            const prev = button('albumPrev', 'album-nav-btn', '‹', '上一頁');
            const next = button('albumNext', 'album-nav-btn', '›', '下一頁');
            const label = text('div', 'album-label', '', 'albumLabel');
            label.setAttribute('aria-live', 'polite');
            const row = text('div', 'album-nav'); row.append(prev, label, next);
            this.foot.append(note, row);
            prev.addEventListener('click', () => this.go(-1));
            next.addEventListener('click', () => this.go(1));
            this.index = 0;
            this.show(0);
            next.focus();
        },

        // ── pages ──
        total() { return this.pages.length - 1; },   // inner pages (the cover is not counted)

        go(delta) {
            const to = Math.min(this.pages.length - 1, Math.max(0, this.index + delta));
            if (to === this.index) { this.snapBack(); return; }
            this.show(to);
        },

        show(index) {
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
            if (label) label.textContent = index === 0 ? '封面' : `${index} / ${this.total()}`;
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
            this.sizePage(page, pageData.aspect);
            // sources last: the frames have their size when the first load event fires
            const w = this.imageWidth(page);
            page.querySelectorAll('img').forEach(im => { im.src = window.driveManager.getImageUrl({ id: im.dataset.photoId }, w); });
        },

        // The cover-fit drawing layouts.js uses (fitCoverImage: the whole photo
        // scaled to cover its slot, positioned by crop), built with DOM calls —
        // renderPageHTML would put a photo key into an HTML string, and brings
        // the editor's x / right-click buttons and a fixed 1600px width.
        renderPage(pageData) {
            const def = LAYOUTS[pageData.layout] || LAYOUTS.blank;
            const page = text('div', 'album-page');
            page.dataset.layout = pageData.layout;
            page.style.background = pageData.bg || '#ffffff';
            def.slots.forEach((sd, idx) => {
                const slot = pageData.slots[idx];
                if (!slot || !slot.photoId) return;
                const box = text('div', 'album-slot');
                box.style.cssText = `left:${sd.x}%;top:${sd.y}%;width:${sd.w}%;height:${sd.h}%;`;
                const wrap = text('div', 'album-slot-crop');
                const crop = slot.crop || {};
                const img = new Image();
                img.className = 'album-img';
                img.alt = '';
                img.draggable = false;
                img.decoding = 'async';
                img.loading = 'eager';          // at most three pages exist, so the neighbours are preloaded on purpose
                img.dataset.photoId = slot.photoId;
                img.dataset.scale = String(crop.scale || 1);
                img.dataset.cropx = String(crop.x || 0);
                img.dataset.cropy = String(crop.y || 0);
                img.dataset.rot = '0';
                img.addEventListener('load', () => { img.style.visibility = ''; fitCoverImage(img); });
                img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
                wrap.appendChild(img);
                box.appendChild(wrap);
                page.appendChild(box);
            });
            return page;
        },

        // largest page of this aspect that fits the stage, with a gutter
        pageSize(aspect) {
            const gutter = window.innerWidth <= 600 ? GUTTER_PHONE : GUTTER_DESKTOP;
            const aw = Math.max(80, this.stage.clientWidth - 2 * gutter);
            const ah = Math.max(80, this.stage.clientHeight - 2 * gutter);
            const w = Math.min(aw, ah * aspect);
            return { w: Math.floor(w), h: Math.floor(w / aspect) };
        },
        sizePage(page, aspect) {
            const { w, h } = this.pageSize(aspect);
            page.style.width = `${w}px`;
            page.style.height = `${h}px`;
        },
        // the pre-generated bucket (400 / 1200 / 1600) for the size this page is shown at,
        // by the rule the gallery's preview uses
        imageWidth(page) {
            const w = page.getBoundingClientRect().width || this.pageSize(PAGE_ASPECT).w;
            const dm = window.driveManager;
            return dm && typeof dm.previewWidth === 'function' ? dm.previewWidth(w, window.devicePixelRatio || 1) : 1200;
        },
        // rotation / window resize: new frame sizes, so the crop is fitted again
        refit() {
            if (!this.el || !this.stage) return;
            for (const slide of this.stage.querySelectorAll('.album-slide')) {
                const page = slide.firstElementChild;
                this.sizePage(page, this.pages[+slide.dataset.index].aspect);
                page.querySelectorAll('img').forEach(im => { if (im.naturalWidth) fitCoverImage(im); });
            }
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

        onTouchStart(e) {
            this.touch = null;
            if (!this.pages.length || e.touches.length !== 1) return;
            const t = e.touches[0];
            if (t.clientX < EDGE || t.clientX > window.innerWidth - EDGE) return;   // the system's back gesture
            this.touch = { x: t.clientX, y: t.clientY, dx: 0, dy: 0, mode: null };
        },
        onTouchMove(e) {
            const s = this.touch;
            if (!s) return;
            if (e.touches.length !== 1) { this.touch = null; this.snapBack(); return; }
            const t = e.touches[0];
            s.dx = t.clientX - s.x; s.dy = t.clientY - s.y;
            if (!s.mode && Math.hypot(s.dx, s.dy) > 10) s.mode = Math.abs(s.dx) > Math.abs(s.dy) * 1.2 ? 'h' : 'v';
            if (s.mode !== 'h') return;
            // the first / last page gives way less, so it feels like an end
            const atEnd = (s.dx > 0 && this.index === 0) || (s.dx < 0 && this.index === this.pages.length - 1);
            this.stage.classList.add('dragging');
            this.stage.style.setProperty('--drag', `${atEnd ? s.dx * 0.25 : s.dx}px`);
        },
        onTouchEnd() {
            const s = this.touch;
            this.touch = null;
            if (!s || s.mode !== 'h') { this.snapBack(); return; }
            const min = Math.max(SWIPE_MIN, this.stage.clientWidth * SWIPE_FRAC);
            if (Math.abs(s.dx) >= min && Math.abs(s.dx) > Math.abs(s.dy) * 1.5) this.go(s.dx < 0 ? 1 : -1);
            else this.snapBack();
        },
        snapBack() {
            if (!this.stage) return;
            this.stage.classList.remove('dragging');
            this.stage.style.setProperty('--drag', '0px');
        },
    };

    // ── the public face js/pick.js talks to ───────────────────────────────
    const AlbumPreview = {
        PAGE_ASPECT, COVER_ASPECT,
        MAX_PHOTOS: 240,          // more than this: the first 240 in shooting order, and it says so
        CHUNK: 24,                // photos analysed per call: the progress granularity
        LIST_MAX_FOLDERS: 200,    // the listing never walks more folders than this
        folders: [],

        // Show the entry right after `after` (a delivered finals view with at
        // least one final folder), or remove it — and close the viewer if it
        // is open — when `show` is false. Idempotent: pick.js calls it on
        // every re-render.
        syncEntry({ show, after, folders }) {
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
