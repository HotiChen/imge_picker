// The delivered finish page as a web album (docs/delivery.md, "Finals gallery").
//
// js/pick.js decides *when* this exists (delivered mode + the finals view) and
// feeds it: it mounts the shell, hands over each folder's photos in the order
// the page already had (app.filteredPhotos — never re-sorted here), the chip
// spec, and three callbacks (share, download, open folder). This file owns
// everything you see in that view:
//   - a hero: the first final as a cover (a ?w= bucket, never the original),
//     studio, project title, a share button;
//   - justified rows: every row one height, photos side by side at their own
//     shape, the last row never stretched. Shapes come from the thumbnails
//     (naturalWidth / naturalHeight as they load); until then 3:2. Reflows are
//     batched (one animation frame, at most one per MIN_GAP_MS), so 300 photos
//     cost a handful of layouts, not 300;
//   - a full-screen lightbox: ‹ ›, ← → Esc, swipe, n / total, preload ±1.
// Two options of mount() serve the light 完成頁 (js/completion-page.js, which has its own
// hero): `hero: false` keeps the hero element detached (no cover is loaded, nothing of it is
// on the page) and `theme: 'light'` puts `fg--light` on the root and `fg-lightbox--light` on
// the lightbox, the hooks css/completion-page.css styles. Without them nothing changes.
//
// Every string that came from outside (file and folder names, title, studio
// name) only reaches the DOM through textContent / setAttribute / property
// assignment — no innerHTML in this file.
(function () {
    'use strict';

    const GAP = 6;                  // px between photos and between rows
    const EAGER = 36;               // the first screens load eagerly, the rest lazily
    const DEFAULT_ASPECT = 3 / 2;   // until a thumbnail says otherwise
    const MIN_GAP_MS = 120;         // at most one batched reflow per this many ms
    const RO_BURST = 4;             // this many resize-driven reflows within RO_WINDOW_MS: stop listening (a scrollbar loop)
    const RO_WINDOW_MS = 1500;
    const EDGE = 24;                // a touch starting this close to a screen edge is the browser's back gesture
    const SWIPE_MIN = 40;           // px, or SWIPE_FRAC of the width, whichever is larger
    const SWIPE_FRAC = 0.12;
    const LB_MIN_BUCKET = 1200;     // the lightbox never shows the 400 thumbnail

    // target row height by the width the rows have: ~320 on a desktop, ~200 on a phone
    const targetHeight = w => (w < 640 ? 200 : w < 1000 ? 260 : 320);

    const el = (tag, cls, txt, id) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (id) e.id = id;
        if (txt != null) e.textContent = txt;
        return e;
    };
    const btn = (id, cls, label, aria) => {
        const b = el('button', cls, label, id);
        b.type = 'button';
        if (aria) b.setAttribute('aria-label', aria);
        return b;
    };

    // Pure: split `aspects` (width / height) into rows for a container of width
    // `W`. A row grows until its height (when it fills the width) is at most the
    // target, then keeps or drops its last photo, whichever lands nearer the
    // target. What is left at the end is a row of its own that is *not* stretched
    // (target height, natural widths) unless it already closes under the target.
    function justify(aspects, W, gap, T) {
        const rows = [];
        const n = aspects.length;
        let i = 0;
        while (i < n) {
            let sum = 0, j = i, h = Infinity;
            while (j < n) {
                sum += aspects[j];
                j++;
                h = (W - gap * (j - i - 1)) / sum;
                if (h <= T) break;
            }
            if (j >= n && h > T) { rows.push({ from: i, to: n, h: T, fill: false }); break; }
            if (j - i > 1) {
                const hPrev = (W - gap * (j - i - 2)) / (sum - aspects[j - 1]);
                if (Math.abs(hPrev - T) < Math.abs(h - T)) { j--; h = hPrev; }
            }
            rows.push({ from: i, to: j, h, fill: true });
            i = j;
        }
        return rows;
    }

    const FinalsGallery = {
        justify,
        stats: { layouts: 0 },

        // state of the mounted gallery (null when not mounted)
        ctx: null, root: null, hero: null, rowsEl: null, chipsEl: null, emptyEl: null, countEl: null,
        photos: [], tiles: [], rowEls: [], aspects: new Map(), sig: '', coverKey: null,
        _ro: null, _roTimes: [], _roOff: false, _timer: 0, _raf: 0, _pending: false, _last: 0,
        _lastW: 0, _deferred: false, _chipSig: '',

        isMounted() { return !!this.root; },
        afterEl() { return this.rowsEl; },

        // Build (or refresh) the shell: hero, the rows host. `host` is the page's
        // content column; `cfg` = { title, studio: {name, hasLogo, logoUrl}, drive,
        // onShare(), onDownload(e, photo), onFolder(path), hero?: false, theme?: 'light' }.
        mount(host, cfg) {
            this.ctx = cfg;
            if (this.root && this.root.isConnected) {
                this._fillHero();
                return;
            }
            this.unmount();
            this.ctx = cfg;
            const root = el('div', 'fg', null, 'finalsGallery');
            const hero = el('header', 'fg-hero', null, 'fgHero');
            const media = el('div', 'fg-hero-media');
            const shade = el('div', 'fg-hero-shade');
            const body = el('div', 'fg-hero-body');
            const share = btn('fgShare', 'fg-share', '分享', '分享這個相簿');
            share.addEventListener('click', () => { if (this.ctx && this.ctx.onShare) this.ctx.onShare(); });
            body.append(el('h1', 'fg-title', null, 'fgTitle'), el('div', 'fg-count', null, 'fgCount'));
            hero.append(media, shade, body, share);
            const rows = el('div', 'fg-rows', null, 'fgRows');
            // hero: false: the hero stays a detached element (the code below keeps writing to it,
            // harmlessly) and never reaches the page
            if (cfg.hero === false) root.append(rows); else root.append(hero, rows);
            if (cfg.theme === 'light') root.classList.add('fg--light');
            host.insertBefore(root, host.firstChild);
            this.root = root; this.hero = hero; this.rowsEl = rows; this.countEl = body.lastChild;
            document.body.classList.add('fg-mode');
            document.documentElement.classList.add('fg-on');
            this.photos = []; this.tiles = []; this.rowEls = []; this.sig = ''; this.coverKey = null; this._chipSig = '';
            this._fillHero();
            this._observe();
        },

        // the studio line, the title (outside strings: textContent only)
        _fillHero() {
            const c = this.ctx || {};
            const hero = this.hero;
            hero.querySelector('#fgTitle').textContent = c.title || '精修成品';
            let studio = hero.querySelector('#fgStudio');
            const s = c.studio;
            if (!s || (!s.name && !s.hasLogo)) { studio?.remove(); return; }
            if (!studio) {
                studio = el('div', 'fg-studio', null, 'fgStudio');
                hero.querySelector('.fg-hero-body').insertBefore(studio, hero.querySelector('#fgTitle'));
            }
            studio.replaceChildren();
            if (s.hasLogo && s.logoUrl) {
                const img = el('img', 'fg-studio-logo');
                img.alt = '';
                img.src = s.logoUrl;
                img.addEventListener('error', () => img.remove());
                studio.append(img);
            }
            if (s.name) studio.append(el('span', 'fg-studio-name', s.name));
        },

        unmount() {
            this.closeLightbox(true);
            if (this._ro) { this._ro.disconnect(); this._ro = null; }
            if (this._winResize) { window.removeEventListener('resize', this._winResize); this._winResize = null; }
            clearTimeout(this._timer); cancelAnimationFrame(this._raf);
            this._timer = 0; this._raf = 0; this._pending = false; this._deferred = false;
            if (this.root) this.root.remove();
            this.root = this.hero = this.rowsEl = this.chipsEl = this.emptyEl = this.countEl = null;
            this.photos = []; this.tiles = []; this.rowEls = []; this.sig = ''; this.coverKey = null; this._chipSig = '';
            this._roTimes = []; this._roOff = false; this._lastW = 0;
            document.body.classList.remove('fg-mode');
            document.documentElement.classList.remove('fg-on', 'fg-open');
            this.ctx = null;
        },

        // ── chips: the finals folders, and the subfolders of the one open ──────
        // spec = [{ folder, label, pressed, sub, back }] or empty / null (none shown).
        setChips(spec) {
            if (!this.root) return;
            const list = Array.isArray(spec) ? spec : [];
            const sig = JSON.stringify(list);
            if (sig === this._chipSig) return;
            this._chipSig = sig;
            const had = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('fg-chip')
                ? document.activeElement.dataset.folder : null;
            if (!list.length) { this.chipsEl?.remove(); this.chipsEl = null; return; }
            if (!this.chipsEl) {
                this.chipsEl = el('nav', 'fg-chips', null, 'fgChips');
                this.chipsEl.setAttribute('aria-label', '資料夾');
                if (this.hero.parentNode) this.hero.after(this.chipsEl); else this.root.insertBefore(this.chipsEl, this.root.firstChild);
            }
            const chips = list.map(c => {
                const b = btn(null, `fg-chip${c.sub ? ' fg-chip--sub' : ''}`, c.label);
                b.dataset.folder = c.folder;
                b.setAttribute('aria-pressed', c.pressed ? 'true' : 'false');
                b.addEventListener('click', () => { if (this.ctx && this.ctx.onFolder) this.ctx.onFolder(c.folder); });
                return b;
            });
            this.chipsEl.replaceChildren(...chips);
            if (had) this.chipsEl.querySelector(`.fg-chip[data-folder="${CSS.escape(had)}"]`)?.focus({ preventScroll: true });
        },

        // ── the photos ────────────────────────────────────────────────────
        // `photos` = [{id, name}] in the order to show; the same ids again (same
        // folder) change nothing.
        setPhotos(photos, folderKey) {
            if (!this.root) return;
            const sig = `${folderKey || ''}\n${photos.map(p => p.id).join('\n')}`;
            if (sig === this.sig && (this.tiles.length === photos.length)) return;
            this.sig = sig;
            this.photos = photos.slice();
            this.countEl.textContent = photos.length ? `${photos.length} 張照片` : '';
            // the cover is the first photo of the first folder that has any, and stays
            if (!this.coverKey && photos.length && !(this.ctx && this.ctx.hero === false)) this._setCover(photos[0]);
            this.hero.classList.toggle('fg-hero--bare', !this.coverKey && !photos.length);
            this._buildTiles();
            if (!photos.length) {
                this.rowsEl.replaceChildren(); this.rowEls = [];
                if (!this.emptyEl) { this.emptyEl = el('p', 'fg-empty', '這裡還沒有照片', 'fgEmpty'); this.rowsEl.before(this.emptyEl); }
            } else {
                this.emptyEl?.remove(); this.emptyEl = null;
                this.layout();
            }
        },

        _drive() { return (this.ctx && this.ctx.drive) || window.driveManager; },

        _setCover(photo) {
            const d = this._drive();
            this.coverKey = photo.id;
            const w = this.hero.getBoundingClientRect().width || window.innerWidth;
            const img = el('img', 'fg-cover', null, 'fgCover');
            img.alt = '';
            img.decoding = 'async';
            img.fetchPriority = 'high';
            img.dataset.photoId = photo.id;
            img.addEventListener('load', () => img.classList.add('on'));
            img.addEventListener('error', () => img.remove());
            img.src = d.getImageUrl(photo, d.previewWidth(w, window.devicePixelRatio || 1));
            this.hero.querySelector('.fg-hero-media').replaceChildren(img);
        },

        // 400 when that is enough for a ~3:2 tile at the target height; else 1200
        _tileBucket() {
            const d = this._drive();
            const W = this.rowsEl.clientWidth || window.innerWidth;
            const est = Math.ceil(targetHeight(W) * DEFAULT_ASPECT);
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            return d.previewWidth(Math.ceil(est * dpr / 1.2), 1);
        },

        _buildTiles() {
            const d = this._drive();
            const bucket = this.photos.length ? this._tileBucket() : 400;
            this.tiles = this.photos.map((photo, i) => {
                const t = btn(null, 'fg-tile');
                t.dataset.photoId = photo.id;
                t.setAttribute('aria-label', `檢視 ${photo.name || photo.id}`);
                const img = new Image();
                img.alt = '';
                img.decoding = 'async';
                img.draggable = false;
                img.loading = i < EAGER ? 'eager' : 'lazy';
                img.addEventListener('load', () => {
                    img.classList.add('on');
                    this._learn(photo.id, img.naturalWidth, img.naturalHeight);
                });
                img.addEventListener('error', () => t.classList.add('fg-tile--broken'));
                img.src = d.getImageUrl(photo, bucket);
                t.append(img);
                t.addEventListener('click', () => this.openLightbox(i, t));
                return t;
            });
        },

        // a thumbnail loaded: remember its shape; a shape other than the one the
        // layout used asks for one (batched) reflow
        _learn(id, w, h) {
            if (!(w > 0 && h > 0)) return;
            const a = w / h;
            const prev = this.aspects.get(id) || DEFAULT_ASPECT;
            this.aspects.set(id, a);
            if (Math.abs(a - prev) / prev > 0.002) this.schedule();
        },

        // ── reflow ────────────────────────────────────────────────────────
        // One animation frame, and never more often than MIN_GAP_MS: however many
        // images load meanwhile they cost one layout.
        schedule() {
            if (!this.root || this._pending) return;
            if (this.lb) { this._deferred = true; return; }   // not under the lightbox; on close
            this._pending = true;
            const go = () => { this._raf = 0; this._timer = 0; this._pending = false; this.layout(); };
            const wait = Math.max(0, MIN_GAP_MS - (performance.now() - this._last));
            if (wait > 0) this._timer = setTimeout(() => { this._timer = 0; this._raf = requestAnimationFrame(go); }, wait);
            else this._raf = requestAnimationFrame(go);
        },

        layout() {
            const host = this.rowsEl;
            if (!host || !this.tiles.length) return;
            const W = host.clientWidth;
            if (W < 50) return;                       // not shown (display: none ancestor)
            this._last = performance.now();
            this._lastW = W;
            const T = targetHeight(W);
            const asp = this.photos.map(p => this.aspects.get(p.id) || DEFAULT_ASPECT);
            const rows = justify(asp, W, GAP, T);

            // keep what the guest is looking at where it is
            let anchor = null, off = 0;
            if (window.scrollY > 0) {
                for (const t of this.tiles) {
                    if (!t.isConnected) continue;
                    const r = t.getBoundingClientRect();
                    if (r.bottom > 64) { anchor = t; off = r.top; break; }
                }
            }

            while (this.rowEls.length < rows.length) {
                const r = el('div', 'fg-row');
                this.rowEls.push(r);
                host.appendChild(r);
            }
            while (this.rowEls.length > rows.length) this.rowEls.pop().remove();
            rows.forEach((row, k) => {
                const r = this.rowEls[k];
                r.style.height = `${row.h}px`;
                const want = this.tiles.slice(row.from, row.to);
                if (r.children.length !== want.length || want.some((t, i) => r.children[i] !== t)) r.replaceChildren(...want);
                want.forEach((t, i) => {
                    const a = asp[row.from + i];
                    t.style.flex = row.fill ? `${a} 1 0px` : '0 0 auto';
                    t.style.width = row.fill ? '' : `${a * row.h}px`;
                });
            });
            this.stats.layouts++;

            if (anchor && anchor.isConnected) {
                const d = anchor.getBoundingClientRect().top - off;
                if (Math.abs(d) > 1) window.scrollBy(0, d);
            }
        },

        _observe() {
            if (typeof ResizeObserver === 'function') {
                this._ro = new ResizeObserver(() => {
                    if (!this.rowsEl || this._roOff) return;
                    const W = this.rowsEl.clientWidth;
                    if (Math.abs(W - this._lastW) < 1) return;
                    const now = performance.now();
                    this._roTimes = this._roTimes.filter(t => now - t < RO_WINDOW_MS);
                    // a width that keeps flipping (a scrollbar coming and going) is not a resize
                    if (this._roTimes.length >= RO_BURST) { this._roOff = true; setTimeout(() => { this._roOff = false; this._roTimes = []; }, RO_WINDOW_MS); return; }
                    this._roTimes.push(now);
                    this.schedule();
                });
                this._ro.observe(this.rowsEl);
            } else {
                this._winResize = () => this.schedule();
                window.addEventListener('resize', this._winResize);
            }
        },

        // ── the lightbox ──────────────────────────────────────────────────
        lb: null,

        openLightbox(index, opener) {
            if (this.lb || !this.photos.length) return;
            const lb = this.lb = {
                i: Math.max(0, Math.min(index, this.photos.length - 1)), off: [], touch: null, preload: [], tok: 0, el: null, stage: null, img: null,
            };
            const root = el('div', 'fg-lightbox', null, 'fgLightbox');
            root.setAttribute('role', 'dialog');
            root.setAttribute('aria-modal', 'true');
            root.setAttribute('aria-label', '照片檢視');
            if (this.ctx && this.ctx.theme === 'light') root.classList.add('fg-lightbox--light');
            root.tabIndex = -1;
            const bar = el('div', 'fg-lb-bar');
            const dl = el('a', 'fg-lb-btn fg-lb-dl', '下載', 'fgLbDownload');
            dl.rel = 'noopener';
            dl.addEventListener('click', e => {
                const p = this.photos[lb.i];
                if (this.ctx && this.ctx.onDownload && p) this.ctx.onDownload(e, p);
            });
            const close = btn('fgLbClose', 'fg-lb-btn fg-lb-close', '✕', '關閉');
            close.addEventListener('click', () => this.closeLightbox());
            bar.append(el('span', 'fg-lb-count', null, 'fgLbCount'), el('span', 'fg-lb-name', null, 'fgLbName'), dl, close);
            const stage = el('div', 'fg-lb-stage', null, 'fgLbStage');
            const prev = btn('fgLbPrev', 'fg-lb-nav fg-lb-prev', '‹', '上一張');
            const next = btn('fgLbNext', 'fg-lb-nav fg-lb-next', '›', '下一張');
            prev.addEventListener('click', () => this.go(-1));
            next.addEventListener('click', () => this.go(1));
            const img = el('img', 'fg-lb-img', null, 'fgLbImg');
            img.alt = '';
            img.draggable = false;
            const msg = el('div', 'fg-lb-msg', '這張暫時無法顯示', 'fgLbMsg');
            msg.hidden = true;
            stage.append(prev, img, next, msg);
            root.append(bar, stage);
            document.body.appendChild(root);
            lb.el = root; lb.stage = stage; lb.img = img; lb.opener = opener || null;
            document.documentElement.classList.add('fg-open');

            const onKey = e => this._onKey(e);
            document.addEventListener('keydown', onKey);
            lb.off.push(() => document.removeEventListener('keydown', onKey));
            stage.addEventListener('touchstart', e => this._touchStart(e), { passive: true });
            stage.addEventListener('touchmove', e => this._touchMove(e), { passive: true });
            stage.addEventListener('touchend', () => this._touchEnd(), { passive: true });
            stage.addEventListener('touchcancel', () => this._snapBack(), { passive: true });
            this._show();
            root.focus({ preventScroll: true });
        },

        // the lightbox shows the 1200 / 1600 bucket for the screen it is on
        _lbUrl(photo) {
            const d = this._drive();
            const w = Math.max(LB_MIN_BUCKET, d.previewWidth(window.innerWidth, window.devicePixelRatio || 1));
            return d.getImageUrl(photo, w);
        },

        _show() {
            const lb = this.lb;
            if (!lb) return;
            const n = this.photos.length;
            const photo = this.photos[lb.i];
            const tok = ++lb.tok;
            const q = id => lb.el.querySelector(id);
            q('#fgLbCount').textContent = `${lb.i + 1} / ${n}`;
            q('#fgLbName').textContent = photo.name || '';
            q('#fgLbDownload').href = this._drive().downloadUrl(photo);
            q('#fgLbPrev').disabled = lb.i === 0;
            q('#fgLbNext').disabled = lb.i === n - 1;
            const img = lb.img, msg = q('#fgLbMsg');
            img.classList.remove('on');
            msg.hidden = true;
            img.onload = () => { if (tok === lb.tok) img.classList.add('on'); };
            img.onerror = () => { if (tok === lb.tok) { msg.hidden = false; } };
            img.src = this._lbUrl(photo);
            // the neighbours, so a flip does not wait for the network
            lb.preload = [lb.i - 1, lb.i + 1].filter(k => k >= 0 && k < n).map(k => { const im = new Image(); im.src = this._lbUrl(this.photos[k]); return im; });
            // a disabled button cannot keep the focus
            if (lb.el.contains(document.activeElement) && document.activeElement.disabled) lb.el.focus({ preventScroll: true });
        },

        go(d) {
            const lb = this.lb;
            if (!lb) return;
            const k = lb.i + d;
            if (k < 0 || k >= this.photos.length) { this._snapBack(); return; }
            lb.i = k;
            this._snapBack();
            this._show();
        },

        // the photo the lightbox ended on gets the focus back (and is scrolled to)
        closeLightbox(quiet) {
            const lb = this.lb;
            if (!lb) return;
            this.lb = null;
            lb.off.splice(0).forEach(f => f());
            lb.tok++;
            lb.img.onload = lb.img.onerror = null;
            lb.el.remove();
            lb.preload = [];
            document.documentElement.classList.remove('fg-open');
            if (quiet) return;
            const photo = this.photos[lb.i];
            const tile = photo && this.tiles.find(t => t.dataset.photoId === photo.id);
            const back = tile && tile.isConnected ? tile : (lb.opener && lb.opener.isConnected ? lb.opener : null);
            if (back) back.focus();
            if (this._deferred) { this._deferred = false; this.schedule(); }
        },

        _onKey(e) {
            const lb = this.lb;
            if (!lb) return;
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeLightbox(); return; }
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); this.go(e.key === 'ArrowRight' ? 1 : -1); return; }
            if (e.key === 'Tab') {      // the dialog is modal: Tab goes round inside it
                const items = [...lb.el.querySelectorAll('button:not([disabled]), a[href]')];
                if (!items.length) { e.preventDefault(); lb.el.focus(); return; }
                const first = items[0], last = items[items.length - 1], at = document.activeElement;
                if (!lb.el.contains(at) || (e.shiftKey && (at === first || at === lb.el)) || (!e.shiftKey && at === last)) {
                    e.preventDefault();
                    (e.shiftKey ? last : first).focus();
                }
            }
        },

        _touchStart(e) {
            const lb = this.lb;
            if (!lb) return;
            lb.touch = null;
            if (e.touches.length !== 1) return;
            const t = e.touches[0];
            if (t.clientX < EDGE || t.clientX > window.innerWidth - EDGE) return;   // the system's back gesture
            lb.touch = { x: t.clientX, y: t.clientY, dx: 0, dy: 0, mode: null };
        },
        _touchMove(e) {
            const lb = this.lb, s = lb && lb.touch;
            if (!s) return;
            if (e.touches.length !== 1) { lb.touch = null; this._snapBack(); return; }
            const t = e.touches[0];
            s.dx = t.clientX - s.x; s.dy = t.clientY - s.y;
            if (!s.mode && Math.hypot(s.dx, s.dy) > 10) s.mode = Math.abs(s.dx) > Math.abs(s.dy) * 1.2 ? 'h' : 'v';
            if (s.mode !== 'h') return;
            const atEnd = (s.dx > 0 && lb.i === 0) || (s.dx < 0 && lb.i === this.photos.length - 1);
            lb.stage.classList.add('dragging');
            lb.stage.style.setProperty('--drag', `${atEnd ? s.dx * 0.25 : s.dx}px`);
        },
        _touchEnd() {
            const lb = this.lb, s = lb && lb.touch;
            if (!lb) return;
            lb.touch = null;
            if (!s || s.mode !== 'h') { this._snapBack(); return; }
            const min = Math.max(SWIPE_MIN, lb.stage.clientWidth * SWIPE_FRAC);
            if (Math.abs(s.dx) >= min && Math.abs(s.dx) > Math.abs(s.dy) * 1.5) this.go(s.dx < 0 ? 1 : -1);
            else this._snapBack();
        },
        _snapBack() {
            const lb = this.lb;
            if (!lb || !lb.stage) return;
            lb.stage.classList.remove('dragging');
            lb.stage.style.setProperty('--drag', '0px');
        },
    };

    window.FinalsGallery = FinalsGallery;
})();
