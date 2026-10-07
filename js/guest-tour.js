// First-visit guided tour for the CLIENT on the pick page (index.html?t=…). Phase-aware, seat owner only:
//   picking   — ♥ on a photo, then the tour REALLY opens that photo (the card's own click, no fake modal) and
//               walks the enlarged view: left/right/swipe, its ♥, 標示修改, 完成; then closes what it opened and
//               points at the submit button. The tour never taps, swipes, hearts or pins for the guest.
//   delivered — the finals, how to mark a change, 確認完成 (delivered and not yet confirmed)
// No tour for viewers, on the 完成頁 (html.cp-on), and none STARTS while a dialog / the lightbox / the claim
// overlay is open. A running picking tour allows the pick page's own lightbox (#photoModal): the one it opened and
// one the guest opens; only the first is closed when the tour ends.
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

    const MODAL = '#photoModal';
    const modalActive = () => { const m = document.getElementById('photoModal'); return !!m && m.classList.contains('active'); };
    const lbHeart = () => first(MODAL + ' #modalPhotoRating .pick-heart-btn');
    const lbHearted = () => { const h = lbHeart(); return !!h && h.classList.contains('on'); };
    const pinMode = () => !!(window.PickController && PickController.pinMode);
    // the lightbox's own prev/next circles (ring both through their overlay strip); none visible: swipe only
    const navTarget = () => (first(MODAL + ' #prevPhotoBtn') || first(MODAL + ' #nextPhotoBtn')) ? first(MODAL + ' .modal-nav-overlay') : null;

    // modal: the step lives inside the enlarged view (skipped when it is not open); soft: no target is fine
    // (text only, altText when the target is absent); skipIf: nothing to teach now; onNext: runs when 下一步 /
    // a tap on the ring leaves the step; auto: advance by itself after the guest's own real tap.
    const FLOWS = {
        picking: [
            { id: 'heart', text: '點愛心選這張。選好的照片會留給攝影師修圖。', target: () => first('.photo-card .pick-heart-btn') },
            { id: 'open', text: '點照片可以放大，看得更清楚。按「下一步」，幫你打開這張。', target: () => first('.photo-card'), onNext: 'open' },
            { id: 'nav', modal: true, soft: true, text: '點左右兩邊的箭頭，或用手指左右滑，看上一張／下一張。', altText: '用手指左右滑，看上一張／下一張。', target: navTarget },
            { id: 'lbheart', modal: true, text: '想選這張就點愛心。選了，才能標示修改。', target: lbHeart, skipIf: lbHearted, auto: () => lbHearted() },
            { id: 'pin', modal: true, soft: true, text: '按這裡，再點照片上要修的位置。', altText: '選了愛心之後，這裡會出現「標示修改」：按它，再點照片上要修的位置。',
              target: () => first('#pickPinBtn'), skipIf: pinMode, auto: () => pinMode() },
            { id: 'done', modal: true, soft: true, text: '點照片上要修的位置，寫下怎麼修；想標幾個位置都可以，標完按「完成」。', target: () => first('#pickPinDoneBtn') },
            { id: 'submit', text: '選好了，按這裡送出。', target: () => first('#mobileActionBar:not(.pick-bar-off) #pickSubmitBtn') },
        ],
        delivered: [
            { text: '這是攝影師交付的精修成品。', target: () => first('#fgRows .fg-tile') },
            { text: '有要修改的地方？\n① 點照片放大，按「標示修改」\n② 點照片上要修的位置，寫下怎麼修\n③ 標完按「完成」，全部標好再按「送出修改」', target: () => first('#fgRows .fg-tile') },
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
    // TEST PHASE SWITCH: while FORCE_DEFAULT is true the tour shows on every visit (the stored "seen" is ignored and
    // never written, so nobody is marked as having seen it). To go live as first-visit-only, set it to false
    // (a page may also set window.GUEST_TOUR_FORCE = true / false before this file loads; the test harness does).
    const FORCE_DEFAULT = true;
    function forced() { return typeof window.GUEST_TOUR_FORCE === 'boolean' ? window.GUEST_TOUR_FORCE : FORCE_DEFAULT; }
    function seen(phase) {
        if (mem[phase]) return true;   // finished or skipped on this page load: do not restart it until a reload
        if (forced()) return false;
        try { return localStorage.getItem(KEYS[phase]) === '1'; } catch (e) { return false; }
    }
    function markSeen(phase) {
        mem[phase] = true;
        if (forced()) return;
        try { localStorage.setItem(KEYS[phase], '1'); } catch (e) { /* private mode: once per page load */ }
    }
    // a dialog the guest is in: nothing to start under it, and a running tour steps aside
    // `running`: a picking tour is up, so the pick page's own lightbox (#photoModal) is no blocker any more
    function blocked(running) {
        const root = document.documentElement;
        if (root.classList.contains('cp-on')) return true;
        if (document.getElementById('fgLightbox')) return true;
        for (const m of document.querySelectorAll('.modal.active')) if (!(running && m.id === 'photoModal')) return true;
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
            const all = FLOWS[ph].map(s => ({ ...s, hasTarget: !!s.target, el: s.target && !s.modal ? s.target() : null }))
                .filter(s => s.modal || !s.hasTarget || s.el);
            // the enlarged-view steps need the step that opens a photo
            return all.some(s => s.id === 'open') || !all.some(s => s.modal) ? all : all.filter(s => !s.modal);
        },

        start(ph) {
            if (this.tour) return;
            const steps = this.resolve(ph);
            if (!steps.some(s => s.el)) return;                 // zero targets: no tour
            this.tour = { phase: ph, steps, i: 0, opener: document.activeElement };
            this.build();
            this.show(0);
            this._onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.finish(); } };
            this._onClick = e => this.guard(e);
            this._onMove = () => this.schedule();
            document.addEventListener('keydown', this._onKey, true);
            document.addEventListener('click', this._onClick, true);
            window.addEventListener('resize', this._onMove);
            window.addEventListener('scroll', this._onMove, true);
            this._watch = setInterval(() => {
                if (!this.tour) return;
                if (blocked(this.tour.phase === 'picking') || this.phaseNow() !== this.tour.phase) { this.close(false); return; }
                this.sync();
                if (!this.tour) return;
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
            if (this._own) return;                               // the tour's own click on the card
            // the enlarged view is the guest's: arrows, ♥, 標示修改, pins, ✕ all work as usual
            if (n && n.closest && n.closest('#photoModal') && modalActive()) { setTimeout(() => this.sync(), 80); return; }
            const el = t.steps[t.i] && t.steps[t.i].el;
            e.preventDefault();
            e.stopPropagation();
            if (el && el.contains(n)) this.go(1);
        },

        go(d) {
            const t = this.tour;
            if (!t) return;
            const j = t.i + d;
            if (d > 0 && t.steps[t.i].onNext === 'open') this.openPhoto();
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
                if (s.modal && !modalActive()) { i += d; continue; }       // nothing enlarged to point into
                if (s.skipIf && s.skipIf()) { i += d; continue; }
                if (!s.target) break;
                s.el = s.target();
                if (s.el || s.soft) break;
                i += d;
            }
            if (i < 0 || i >= t.steps.length) { if (d > 0) this.finish(); return; }
            t.i = i;
            const s = t.steps[i];
            if (!s.modal) this.closeOwnedModal();                    // back on the grid: put away what the tour opened
            t.count.textContent = `${i + 1}/${t.steps.length}`;
            t.text.textContent = s.text;
            t.back.hidden = i === 0;
            const last = i === t.steps.length - 1;
            t.next.textContent = last ? '完成' : '下一步';
            if (s.el && !s.modal) {
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
            if (s.modal && s.target) s.el = s.target();                // the guest may have swiped to another photo
            let el = s.el && visible(s.el) ? s.el : null;
            if (!s.modal && el && modalActive()) el = null;            // a grid target under the lightbox: no ring
            const txt = el || !s.altText ? s.text : s.altText;
            if (t.text.textContent !== txt) t.text.textContent = txt;
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

        // the tour's only "action": open the highlighted card's photo through the card's own click handler
        // (the same path as a guest's tap). If a lightbox is already open (the guest's), leave it alone.
        openPhoto() {
            const t = this.tour;
            if (!t || modalActive()) return;
            const card = first('.photo-card');
            if (!card) return;
            this._own = true;
            try { card.click(); } finally { this._own = false; }
            if (modalActive()) t.openedModal = true;
        },

        closeOwnedModal() {
            const t = this.tour;
            if (!t || !t.openedModal) return;
            t.openedModal = false;
            if (modalActive() && window.app && typeof app.closeModal === 'function') app.closeModal();
        },

        // per tick / after the guest's own tap: a lightbox the guest closed, a ♥ or 標示修改 tap that finished a step
        sync() {
            const t = this.tour;
            if (!t) return;
            const s = t.steps[t.i];
            if (!modalActive()) t.openedModal = false;               // closed by the guest: no longer ours to close
            if (!s || !s.modal) return;
            if (!modalActive()) { this.go(1); return; }
            if (s.auto && s.auto()) this.go(1);
        },

        // finishing, skipping, ✕ and Esc all mean "seen"
        finish() {
            const t = this.tour;
            if (!t) return;
            markSeen(t.phase);
            this.closeOwnedModal();
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
