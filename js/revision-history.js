// 「上一輪的修改資訊」 — the read-only history of the rounds (docs/revision-pins.md §4.4, §4.5, §6.1).
//
// The seat holder of a delivered, unconfirmed project can open a full-screen panel with the newest
// round (the selection round the guest sent, or a round of pins), its note and photos, and a list of
// the earlier rounds. Pins are shown on the OLD photo, read-only (js/pin-layer.js).
//
// The photos come from GET /api/pick/rounds/:id/photo?i=&w=400|1200 — thumbnails only. An <img src>
// cannot carry the picker key (and it must never be in a URL), so each one is fetched with the
// usual headers and shown as a blob: URL, loaded lazily and revoked when the panel closes or moves
// to another round. Every string that came from the server (the note, a pin's note, a file name)
// reaches the DOM through textContent, with dir="auto" and `unicode-bidi: isolate` (CSS).
(function () {
    'use strict';

    const LIST = '/api/pick/rounds';
    const el = (tag, cls, txt) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (txt != null) e.textContent = txt;
        return e;
    };
    const auto = e => { e.setAttribute('dir', 'auto'); return e; };

    const RevisionHistory = {
        sig: '',
        state: 'idle',               // 'idle' | 'loading' | 'ok' | 'error' | 'none'
        rounds: [],
        promise: null,
        // panel state (null when closed)
        ui: null,
        urls: new Set(),
        _keyHandler: null,

        // ── the list of rounds (cached per delivery / open-round state) ───
        _sigOf(pc) { return `${pc.deliveredAt}|${pc.revisionOpen}|${pc.revisionOpenPhotos}`; },

        // Called while rendering the status block: reads the list once per signature, then re-renders it.
        probe(pc) {
            if (!window.RevisionPins || !RevisionPins.enabled) { this.reset(); return; }
            this.ensureList(pc);
        },

        ensureList(pc, force) {
            const sig = this._sigOf(pc);
            if (!force && this.sig === sig && this.promise) return this.promise;
            this.sig = sig;
            this.state = 'loading';
            const p = this._load(pc, sig);
            this.promise = p;
            return p;
        },

        async _load(pc, sig) {
            const r = await pc._json(LIST, { headers: pc.headers() });
            if (this.sig !== sig) return { ok: false, stale: true, rounds: [] };
            if (r.ok && Array.isArray(r.data.rounds)) {
                this.rounds = r.data.rounds.filter(x => x && typeof x.id === 'string');
                this.state = 'ok';
            } else {
                this.rounds = [];
                // a refusal (4xx) is final: no history. A network / server hiccup is worth a retry button.
                this.state = (r.status === 0 || r.status === 429 || (r.status >= 500 && !(r.data && r.data.code === 'revision_pins_unavailable'))) ? 'error' : 'none';
            }
            if (pc._renderDone) pc._renderDone();
            return { ok: this.state === 'ok', rounds: this.rounds, status: r.status };
        },

        reset() {
            this.sig = '';
            this.state = 'idle';
            this.rounds = [];
            this.promise = null;
            this.close(true);
        },

        // whether the 「上一輪的修改資訊」 button is offered
        visible() {
            return (this.state === 'ok' && this.rounds.length > 0) || this.state === 'error';
        },

        // ── titles ────────────────────────────────────────────────────────
        _title(pc, round) {
            const when = pc._fmtDate(round.created_at);
            const tail = when ? ` · ${when}` : '';
            if (round.kind === 'selection') return `挑片時的標示${tail}`;
            const asked = this.rounds.filter(r => r.kind !== 'selection').sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));
            const k = asked.findIndex(r => r.id === round.id) + 1;
            return round.kind === 'text' ? `修改要求${tail}` : `第 ${k || 1} 輪修改${tail}`;
        },

        // ── fetching ──────────────────────────────────────────────────────
        async _blob(pc, path) {
            let res;
            try { res = await fetch(`${CONFIG.WORKER_URL}${path}`, { headers: pc.headers() }); }
            catch (e) { return { ok: false, status: 0 }; }
            if (!res.ok) return { ok: false, status: res.status };
            try { return { ok: true, blob: await res.blob() }; } catch (e) { return { ok: false, status: 0 }; }
        },
        _url(blob) {
            const u = URL.createObjectURL(blob);
            this.urls.add(u);
            return u;
        },
        _revokeAll() {
            this.urls.forEach(u => URL.revokeObjectURL(u));
            this.urls.clear();
        },
        _photoPath(roundId, i, w) { return `${LIST}/${encodeURIComponent(roundId)}/photo?i=${i}&w=${w}`; },

        // ── the panel ─────────────────────────────────────────────────────
        async open(pc, opener) {
            if (this.ui) return;
            const root = el('div', 'rh');
            root.id = 'revHistory';
            root.setAttribute('role', 'dialog');
            root.setAttribute('aria-modal', 'true');
            root.setAttribute('aria-labelledby', 'revHistoryTitle');
            const bar = el('div', 'rh-bar');
            const title = el('h2', 'rh-title', '上一輪的修改資訊');
            title.id = 'revHistoryTitle';
            title.setAttribute('dir', 'auto');
            const close = el('button', 'rh-btn', '✕');
            close.id = 'revHistoryClose';
            close.type = 'button';
            close.setAttribute('aria-label', '關閉');
            close.addEventListener('click', () => this.close());
            bar.append(title, close);
            const body = el('div', 'rh-body');
            root.append(bar, body);
            document.body.appendChild(root);
            document.documentElement.classList.add('rh-open');
            this.ui = { pc, root, body, title, opener: opener || null, round: null, token: 0, io: null, view: null };
            this._keyHandler = e => this._onKey(e);
            document.addEventListener('keydown', this._keyHandler);
            close.focus({ preventScroll: true });
            if (this.state === 'ok' && this.rounds.length) await this.showRound(this.rounds[0].id);
            else this._failed();
        },

        close(quiet) {
            const ui = this.ui;
            if (!ui) return;
            this.ui = null;
            if (this._keyHandler) { document.removeEventListener('keydown', this._keyHandler); this._keyHandler = null; }
            if (ui.io) ui.io.disconnect();
            ui.token++;
            this._revokeAll();
            ui.root.remove();
            document.documentElement.classList.remove('rh-open');
            // the button may have been re-drawn since (the status block re-renders): find it again
            const back = ui.opener && ui.opener.isConnected ? ui.opener : document.getElementById('doneHistoryBtn');
            if (!quiet && back) back.focus({ preventScroll: true });
        },

        _onKey(e) {
            const ui = this.ui;
            if (!ui) return;
            if (e.key === 'Escape') {
                e.preventDefault(); e.stopPropagation();
                if (ui.view) this._closeBig(); else this.close();
                return;
            }
            if (e.key === 'Tab') {      // modal: Tab goes round inside the panel
                const items = [...ui.root.querySelectorAll('button:not([disabled])')];
                if (!items.length) { e.preventDefault(); return; }
                const first = items[0], last = items[items.length - 1], at = document.activeElement;
                if (!ui.root.contains(at) || (e.shiftKey && at === first) || (!e.shiftKey && at === last)) {
                    e.preventDefault();
                    (e.shiftKey ? last : first).focus();
                }
            }
        },

        // the list could not be read: a plain line and a retry
        _failed() {
            const ui = this.ui;
            if (!ui) return;
            ui.title.textContent = '上一輪的修改資訊';
            const msg = el('p', 'rh-msg', '暫時無法載入');
            msg.id = 'revHistoryMsg';
            const retry = el('button', 'rh-btn', '重試');
            retry.id = 'revHistoryRetry';
            retry.type = 'button';
            retry.addEventListener('click', async () => {
                retry.disabled = true;
                const r = await this.ensureList(ui.pc, true);
                if (this.ui !== ui) return;
                if (r.ok && this.rounds.length) await this.showRound(this.rounds[0].id);
                else { retry.disabled = false; msg.textContent = r.ok ? '沒有修改紀錄' : '暫時無法載入'; }
            });
            ui.body.replaceChildren(msg, retry);
        },

        async showRound(id) {
            const ui = this.ui;
            if (!ui) return;
            const token = ++ui.token;
            if (ui.io) { ui.io.disconnect(); ui.io = null; }
            this._revokeAll();
            const pc = ui.pc;
            const row = this.rounds.find(r => r.id === id);
            ui.title.textContent = row ? this._title(pc, row) : '上一輪的修改資訊';
            const loading = el('p', 'rh-msg', '載入中…');
            ui.body.replaceChildren(loading);
            const r = await pc._json(`${LIST}/${encodeURIComponent(id)}`, { headers: pc.headers() });
            if (this.ui !== ui || ui.token !== token) return;
            if (!r.ok || !Array.isArray(r.data.photos)) {
                const msg = el('p', 'rh-msg', '暫時無法載入');
                msg.id = 'revHistoryMsg';
                const retry = el('button', 'rh-btn', '重試');
                retry.id = 'revHistoryRetry';
                retry.type = 'button';
                retry.addEventListener('click', () => this.showRound(id));
                ui.body.replaceChildren(msg, retry);
                return;
            }
            const round = r.data;
            ui.round = round;
            ui.title.textContent = this._title(pc, { ...round, id });
            const kids = [];
            if (typeof round.note === 'string' && round.note) {
                const n = auto(el('p', 'rh-note', round.note));
                n.id = 'revHistoryNote';
                kids.push(n);
            }
            const photos = round.photos.filter(p => p && Number.isInteger(p.i)).map(p => ({ i: p.i, name: String(p.name || ''), pins: PinLayer.clean(p.pins) }));
            // a selection round: the photos with pins first, the rest folded away until asked for
            const lead = round.kind === 'selection' ? photos.filter(p => p.pins.length) : photos;
            const rest = round.kind === 'selection' ? photos.filter(p => !p.pins.length) : [];
            const grid = el('div', 'rh-grid');
            grid.id = 'revHistoryGrid';
            lead.forEach(p => grid.appendChild(this._card(id, round, p)));
            kids.push(grid);
            if (!photos.length && round.kind === 'text') {
                /* a text request has no photos: the note above is all of it */
            } else if (!lead.length && !rest.length) {
                kids.push(el('p', 'rh-msg', '這一輪沒有照片'));
            } else if (!lead.length) {
                kids.push(el('p', 'rh-msg', '這一輪沒有標示'));
            }
            if (rest.length) {
                const more = el('button', 'rh-btn rh-more', `其他已選 ${rest.length} 張`);
                more.id = 'revHistoryMore';
                more.type = 'button';
                more.addEventListener('click', () => {
                    rest.forEach(p => grid.appendChild(this._card(id, round, p)));
                    more.remove();
                    this._observe();
                });
                kids.push(more);
            }
            const others = this.rounds.filter(x => x.id !== id);
            if (others.length) {
                const box = el('section', 'rh-earlier-box');
                box.id = 'revHistoryEarlier';
                box.append(el('h3', '', '更早的輪次'));
                others.forEach(x => {
                    const b = auto(el('button', 'rh-btn rh-earlier', `${this._title(pc, x)}${x.photo_count ? `（${x.photo_count} 張）` : ''}`));
                    b.type = 'button';
                    b.addEventListener('click', () => { this.showRound(x.id); ui.body.scrollTop = 0; });
                    box.append(b);
                });
                kids.push(box);
            }
            ui.body.replaceChildren(...kids);
            ui.body.scrollTop = 0;
            this._observe();
        },

        _card(roundId, round, p) {
            const b = el('button', 'rh-photo');
            b.type = 'button';
            b.dataset.i = String(p.i);
            b.dataset.loaded = '0';
            const thumb = el('div', 'rh-thumb');
            b.append(thumb);
            if (p.pins.length) b.append(el('span', 'rh-pins', String(p.pins.length)));
            b.append(auto(el('span', 'rh-name', p.name)));
            b.setAttribute('aria-label', `${p.name || '照片'}${p.pins.length ? `，${p.pins.length} 個標示` : ''}`);
            b._thumb = thumb;
            b._round = { id: roundId, photo: p };
            b.addEventListener('click', () => this._openBig(roundId, round, p, b));
            return b;
        },

        // load a card's thumbnail when it nears the screen
        _observe() {
            const ui = this.ui;
            if (!ui) return;
            const cards = [...ui.body.querySelectorAll('.rh-photo[data-loaded="0"]')];
            if (typeof IntersectionObserver !== 'function') { cards.forEach(c => this._loadThumb(c)); return; }
            if (!ui.io) {
                ui.io = new IntersectionObserver(entries => entries.forEach(en => {
                    if (!en.isIntersecting) return;
                    ui.io.unobserve(en.target);
                    this._loadThumb(en.target);
                }), { root: ui.body, rootMargin: '200px' });
            }
            cards.forEach(c => ui.io.observe(c));
        },

        async _loadThumb(card) {
            const ui = this.ui;
            if (!ui || card.dataset.loaded !== '0') return;
            card.dataset.loaded = '1';
            const token = ui.token;
            const { id, photo } = card._round;
            const r = await this._blob(ui.pc, this._photoPath(id, photo.i, 400));
            if (this.ui !== ui || ui.token !== token || !card.isConnected) return;
            const thumb = card._thumb;
            if (!r.ok) { thumb.replaceChildren(el('div', 'rh-gone', r.status === 404 ? '照片已不在雲端' : '無法載入')); return; }
            const img = document.createElement('img');
            img.alt = '';
            img.decoding = 'async';
            img.addEventListener('error', () => thumb.replaceChildren(el('div', 'rh-gone', '無法載入')));
            img.src = this._url(r.blob);
            thumb.replaceChildren(img);
        },

        // ── one photo, large, with its pins (read-only) ───────────────────
        async _openBig(roundId, round, p, opener) {
            const ui = this.ui;
            if (!ui || ui.view) return;
            const pc = ui.pc;
            const view = el('div', 'rh-view');
            view.id = 'revHistoryView';
            const bar = el('div', 'rh-bar');
            const back = el('button', 'rh-btn back-btn', '← 返回');
            back.id = 'rhBack';
            back.type = 'button';
            back.addEventListener('click', () => this._closeBig());
            const name = auto(el('div', 'rh-title', p.name));
            bar.append(back, name);
            const stage = el('div', 'rh-stage');
            const list = el('ol', 'rh-pinlist');
            list.id = 'rhPinList';
            view.append(bar, stage, list);
            ui.root.appendChild(view);
            ui.view = { el: view, opener, layer: null, urls: [] };
            back.focus({ preventScroll: true });

            let layer = null;
            const rows = [];
            const select = i => {
                rows.forEach((r, k) => { if (k === i) r.setAttribute('aria-current', 'true'); else r.removeAttribute('aria-current'); });
                if (layer) layer.select(i);
            };
            p.pins.forEach((m, i) => {
                const row = el('li', 'rh-pinrow');
                row.append(el('span', 'rp-num', String(i + 1)), auto(el('span', 'rh-pinnote', m.note || '（沒有說明）')));
                row.addEventListener('click', () => select(i));
                list.append(row);
                rows.push(row);
            });
            if (!p.pins.length) list.append(el('li', 'rh-pinrow', '這張沒有標示'));

            const token = ui.token;
            const r = await this._blob(pc, this._photoPath(roundId, p.i, 1200));
            if (this.ui !== ui || ui.token !== token || !ui.view || ui.view.el !== view) return;
            if (!r.ok) {
                stage.append(el('div', 'rh-gone', r.status === 404 ? '照片已不在雲端' : '無法載入'));
                return;
            }
            const img = document.createElement('img');
            img.id = 'rhBig';
            img.className = 'rh-big';
            img.alt = '';
            img.draggable = false;
            stage.append(img);
            layer = PinLayer.attach(stage, img, { readOnly: true, onSelect: i => select(i) });
            layer.set(p.pins);
            ui.view.layer = layer;
            img.src = this._url(r.blob);
        },

        _closeBig() {
            const ui = this.ui;
            if (!ui || !ui.view) return;
            const v = ui.view;
            ui.view = null;
            if (v.layer) v.layer.destroy();
            v.el.remove();
            if (v.opener && v.opener.isConnected) v.opener.focus({ preventScroll: true });
        },
    };

    window.RevisionHistory = RevisionHistory;
})();
