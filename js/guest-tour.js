// First-visit guided tour for the CLIENT on the pick page (index.html?t=…). Phase-aware, seat owner only:
//   picking   — ♥ on a photo, tap to enlarge, pins/notes (text only: that tool lives inside the lightbox),
//               the submit button
//   delivered — the finals, how to mark a change, 確認完成 (delivered and not yet confirmed)
// No tour for viewers, on the 完成頁 (html.cp-on), or while a dialog / the lightbox / the claim overlay is open.
// Pure overlay: everything is position:fixed, nothing changes the page layout; scrolling stays free (no shield).
// Taps outside the card are swallowed (a capture-phase click guard) so a stray tap cannot ♥ or open a photo
// under the dim; a tap on the highlighted target advances (the action itself is not performed).
// Seen state: localStorage guestTourPickingV1 / guestTourDeliveredV1; storage blocked → once per page load.
// js/pick.js calls GuestTour.maybeStart({phase, isOwner, isEligible}) after each render / phase change.
(function () {
    const KEYS = { picking: 'guestTourPickingV1', delivered: 'guestTourDeliveredV1' };
    const mem = {};                       // fallback when storage throws, and the per-page-load record
    const MARGIN = 12;                    // gap between card and target / viewport edge
    const PAD = 6;                        // ring padding around a target

    const FLOWS = {
        picking: [
            { text: '點愛心選這張。選好的照片會留給攝影師修圖。', target: () => first('.photo-card .pick-heart-btn') },
            { text: '點照片可以放大，看得更清楚。', target: () => first('.photo-card') },
            { text: '想請攝影師修圖？放大照片後，按「備註・標示」，再在照片上點一下加註記。' },
            { text: '選好了，按這裡送出。', target: () => first('#mobileActionBar:not(.pick-bar-off) #pickSubmitBtn') },
        ],
        delivered: [
            { text: '這是攝影師交付的精修成品。', target: () => first('#fgRows .fg-tile') },
            { text: '有要修改的地方：點照片放大，按「標示修改」，再在照片上點一下加註記。', target: () => first('#fgRows .fg-tile') },
            { text: '都滿意就按「確認完成」。', target: () => first('#doneConfirmBtn') },
        ],
    };

    // the page is ready for a tour when these all resolve (a tour must not start on a half-loaded grid)
    const READY = {
        picking: ['.photo-card .pick-heart-btn', '#mobileActionBar:not(.pick-bar-off) #pickSubmitBtn'],
        delivered: ['#fgRows .fg-tile', '#doneConfirmBtn'],
    };

    function visible(el) {
        if (!el || !el.isConnected) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden';
    }
    function first(sel) {
        for (const el of document.querySelectorAll(sel)) if (visible(el)) return el;
        return null;
    }
    function seen(phase) {
        if (mem[phase]) return true;
        try { return localStorage.getItem(KEYS[phase]) === '1'; } catch (e) { return false; }
    }
    function markSeen(phase) {
        mem[phase] = true;
        try { localStorage.setItem(KEYS[phase], '1'); } catch (e) { /* private mode: once per page load */ }
    }
    // a dialog the guest is in: nothing to start under it, and a running tour steps aside
    function blocked() {
        const root = document.documentElement;
        if (root.classList.contains('cp-on')) return true;
        if (document.getElementById('fgLightbox')) return true;
        if (document.querySelector('.modal.active')) return true;
        if (visible(document.getElementById('pickClaimOverlay'))) return true;
        if (visible(document.getElementById('loadingState'))) return true;     // the loading pill
        return false;
    }
    const reduced = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

    const GuestTour = {
        opts: null,
        tour: null,           // {phase, steps, i, ui…} while running
        waiting: null,        // phase being waited for
        helpEl: null,

        phaseNow() {
            const o = this.opts;
            if (!o || !o.isOwner || !FLOWS[o.phase]) return null;
            if (typeof o.isEligible === 'function') { try { if (!o.isEligible()) return null; } catch (e) { return null; } }
            return o.phase;
        },

        isActive() { return !!this.tour; },

        maybeStart(opts) {
            this.opts = opts || null;
            const ph = this.phaseNow();
            if (!ph) { this.close(false); this.stopWaiting(); this.removeHelp(); return; }
            if (this.tour && this.tour.phase !== ph) this.close(false);
            this.ensureHelp();
            if (!this.tour && !seen(ph)) this.waitFor(ph);
        },

        // replay for the current phase (the ？ button)
        replay() {
            const ph = this.phaseNow();
            if (!ph || blocked()) return;
            this.close(false);
            this.start(ph);
        },

        stopWaiting() { clearInterval(this._poll); this._poll = null; this.waiting = null; },

        // wait until the grid has cards and the page stopped loading; give up silently
        waitFor(ph) {
            if (this.waiting === ph) return;
            this.stopWaiting();
            this.waiting = ph;
            const t0 = Date.now();
            const tick = () => {
                if (this.phaseNow() !== ph || seen(ph) || this.tour || Date.now() - t0 > 20000) { this.stopWaiting(); return; }
                if (blocked()) return;
                if (!READY[ph].every(sel => first(sel))) return;
                this.stopWaiting();
                this.start(ph);
            };
            this._poll = setInterval(tick, 250);
            tick();
        },

        // the flow's steps whose target exists now (text-only steps always stay)
        resolve(ph) {
            return FLOWS[ph].map(s => ({ text: s.text, target: s.target, hasTarget: !!s.target, el: s.target ? s.target() : null }))
                .filter(s => !s.hasTarget || s.el);
        },

        start(ph) {
            if (this.tour) return;
            const steps = this.resolve(ph);
            if (!steps.some(s => s.el)) return;                 // zero targets: no tour
            this.tour = { phase: ph, steps, i: 0, opener: document.activeElement };
            this.build();
            this.show(0);
            this._onKey = e => { if (e.key === 'Escape') { e.preventDefault(); this.finish(); } };
            this._onClick = e => this.guard(e);
            this._onMove = () => this.schedule();
            document.addEventListener('keydown', this._onKey, true);
            document.addEventListener('click', this._onClick, true);
            window.addEventListener('resize', this._onMove);
            window.addEventListener('scroll', this._onMove, true);
            this._watch = setInterval(() => {
                if (!this.tour) return;
                if (blocked() || this.phaseNow() !== this.tour.phase) { this.close(false); return; }
                this.place();
            }, 300);
        },

        build() {
            const dim = document.createElement('div');
            dim.className = 'gt-dim';
            const ring = document.createElement('div');
            ring.className = 'gt-ring';
            const card = document.createElement('div');
            card.className = 'gt-card';
            card.setAttribute('role', 'dialog');
            card.setAttribute('aria-live', 'polite');
            card.setAttribute('aria-label', '操作導覽');
            card.tabIndex = -1;
            const head = document.createElement('div');
            head.className = 'gt-head';
            const count = document.createElement('span');
            count.className = 'gt-count';
            const x = document.createElement('button');
            x.type = 'button'; x.className = 'gt-x'; x.textContent = '✕'; x.setAttribute('aria-label', '關閉導覽');
            x.addEventListener('click', () => this.finish());
            head.append(count, x);
            const text = document.createElement('p');
            text.className = 'gt-text';
            const row = document.createElement('div');
            row.className = 'gt-actions';
            const skip = document.createElement('button');
            skip.type = 'button'; skip.className = 'gt-btn gt-skip'; skip.textContent = '略過';
            skip.addEventListener('click', () => this.finish());
            const back = document.createElement('button');
            back.type = 'button'; back.className = 'gt-btn gt-back'; back.textContent = '上一步';
            back.addEventListener('click', () => this.go(-1));
            const next = document.createElement('button');
            next.type = 'button'; next.className = 'gt-btn gt-next'; next.textContent = '下一步';
            next.addEventListener('click', () => this.go(1));
            row.append(skip, back, next);
            card.append(head, text, row);
            document.body.append(dim, ring, card);
            Object.assign(this.tour, { dim, ring, card, count, text, back, next });
        },

        // outside taps are swallowed; a tap on the highlighted target advances
        guard(e) {
            const t = this.tour;
            if (!t) return;
            const n = e.target;
            if (n && n.closest && (n.closest('.gt-card') || n.closest('.gt-help'))) return;
            const el = t.steps[t.i] && t.steps[t.i].el;
            e.preventDefault();
            e.stopPropagation();
            if (el && el.contains(n)) this.go(1);
        },

        go(d) {
            const t = this.tour;
            if (!t) return;
            const j = t.i + d;
            if (j >= t.steps.length) { this.finish(); return; }
            if (j < 0) return;
            this.show(j);
        },

        show(i) {
            const t = this.tour;
            const d = i >= t.i ? 1 : -1;
            // a target that vanished since the start: skip the step (never point at nothing)
            while (i >= 0 && i < t.steps.length) {
                const s = t.steps[i];
                if (!s.target) break;
                s.el = s.target();
                if (s.el) break;
                i += d;
            }
            if (i < 0 || i >= t.steps.length) { if (d > 0) this.finish(); return; }
            t.i = i;
            const s = t.steps[i];
            t.count.textContent = `${i + 1}/${t.steps.length}`;
            t.text.textContent = s.text;
            t.back.hidden = i === 0;
            const last = i === t.steps.length - 1;
            t.next.textContent = last ? '完成' : '下一步';
            if (s.el) {
                const r = s.el.getBoundingClientRect();
                if (r.top < 0 || r.bottom > innerHeight) s.el.scrollIntoView({ block: 'center', behavior: 'auto' });
            }
            this.place();
            // focus moves into the card (preventScroll: the page must not jump)
            try { t.next.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        },

        schedule() {
            if (this._raf) return;
            this._raf = requestAnimationFrame(() => { this._raf = 0; this.place(); });
        },

        place() {
            const t = this.tour;
            if (!t) return;
            const s = t.steps[t.i];
            const vw = document.documentElement.clientWidth, vh = innerHeight;
            const el = s.el && visible(s.el) ? s.el : null;
            const card = t.card;
            card.style.width = `${Math.min(340, vw - 2 * MARGIN)}px`;
            const w = card.offsetWidth, h = card.offsetHeight;
            let top, left, hole = null;
            if (el) {
                const r = el.getBoundingClientRect();
                hole = { l: r.left - PAD, t: r.top - PAD, w: r.width + 2 * PAD, h: r.height + 2 * PAD };
                Object.assign(t.ring.style, { display: 'block', left: `${hole.l}px`, top: `${hole.t}px`, width: `${hole.w}px`, height: `${hole.h}px` });
                t.dim.style.display = 'none';
                const below = hole.t + hole.h + MARGIN, above = hole.t - h - MARGIN;
                const lo = MARGIN, hi = vh - h - MARGIN;
                if (below <= hi) top = below;
                else if (above >= lo) top = above;
                else {
                    // the target is too big to sit beside: pin to whichever edge overlaps it less
                    const ovTop = Math.max(0, lo + h - hole.t), ovBot = Math.max(0, hole.t + hole.h - hi);
                    top = ovTop <= ovBot ? lo : hi;
                }
                left = hole.l + hole.w / 2 - w / 2;
            } else {
                t.ring.style.display = 'none';
                t.dim.style.display = 'block';
                top = vh - h - 96;                              // above the bottom bar, lower third
                left = (vw - w) / 2;
            }
            top = Math.max(MARGIN, Math.min(top, vh - h - MARGIN));
            left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));
            card.style.top = `${top}px`;
            card.style.left = `${left}px`;
        },

        // finishing, skipping, ✕ and Esc all mean "seen"
        finish() {
            const t = this.tour;
            if (!t) return;
            markSeen(t.phase);
            this.close(true);
        },

        // Closing never marks seen (finish() does). `returnFocus` true: the guest ended the tour, give the focus
        // back to where it was. false: stepped aside (dialog opened, phase changed): focus is left alone and the
        // tour may come back.
        close(returnFocus) {
            const t = this.tour;
            if (!t) return;
            this.tour = null;
            clearInterval(this._watch);
            cancelAnimationFrame(this._raf); this._raf = 0;
            document.removeEventListener('keydown', this._onKey, true);
            document.removeEventListener('click', this._onClick, true);
            window.removeEventListener('resize', this._onMove);
            window.removeEventListener('scroll', this._onMove, true);
            const hadFocus = t.card.contains(document.activeElement);
            t.dim.remove(); t.ring.remove(); t.card.remove();
            const op = t.opener;
            if (returnFocus && hadFocus && op && op.isConnected && typeof op.focus === 'function') { try { op.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
        },

        ensureHelp() {
            if (this.helpEl && this.helpEl.isConnected) return;
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'gt-help';
            b.textContent = '？';
            b.setAttribute('aria-label', '操作說明');
            b.title = '操作說明';
            b.addEventListener('click', () => this.replay());
            document.body.append(b);
            this.helpEl = b;
        },

        removeHelp() {
            if (this.helpEl) this.helpEl.remove();
            this.helpEl = null;
        },
    };

    window.GuestTour = GuestTour;
})();
