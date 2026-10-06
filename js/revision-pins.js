// Pins on the delivered finals — the draft side (docs/revision-pins.md §4.2, §6.1, §13.1).
//
// The seat holder of a delivered, unconfirmed project taps a photo in the finals lightbox, places
// numbered pins and writes a note on each; the drafts autosave to PUT /api/pick/revision-pins and
// come back from GET /api/pick/state (`revision_drafts`). js/delivery-done.js turns the drafts into
// a round (「送出修改 N 張」); js/revision-history.js shows the earlier rounds.
//
// This file owns: the draft store and its save queue (debounced, retried, flushed on leaving),
// the lightbox hooks js/finals-gallery.js calls (toolbar toggle, pin layer, note drawer), the tile
// badge, and the plain-Chinese texts for every error code of the contract.
//
// Off (every hook gone, nothing in the DOM) unless: the seat holder, delivered mode, not confirmed,
// and `revision_drafts` is an ARRAY — null means the migration has not run, absent means a viewer
// or an old Worker; both keep the old 需要修改 text flow. Every string that came from outside (a
// note, a file name) reaches the DOM through textContent / .value / setAttribute only.
(function () {
    'use strict';

    const SAVE_DELAY = 600;          // ms after the last edit
    const BATCH = 20;                // items per PUT (server limit)
    const PATH = '/api/pick/revision-pins';
    const retryMs = () => { const n = Number(window.REVISION_PINS_RETRY_MS); return n > 0 ? n : 4000; };
    // the codes after which the page's own picture is stale: re-read the state instead of retrying
    const STALE_CODES = ['revision_open', 'already_confirmed', 'not_delivered'];

    const el = (tag, cls, txt) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (txt != null) e.textContent = txt;
        return e;
    };
    const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const note = text => { if (typeof toast !== 'undefined') toast.info(text); };

    const RevisionPins = {
        pc: null,
        enabled: false,              // the pin UI exists on this page state
        editable: false,             // enabled and no round is open (a sent round is read-only)
        loaded: false,
        sig: '',                     // the delivery the drafts belong to
        marks: new Map(),            // photo key -> [{x, y, note}]  (never an empty list)
        ver: new Map(),              // photo key -> edit counter (what a save may clear from `dirty`)
        dirty: new Set(),
        timer: 0,
        retryTimer: 0,
        chain: Promise.resolve(),
        status: '',                  // '' | 'offline' | 'error'
        statusText: '',
        round: null,                 // the open round's pins by file name, for the read-only lightbox
        roundFor: '',
        pinMode: false,
        selected: -1,
        lb: null,                    // the open lightbox: { bar, root, toggle, stage, img, photo, layer, drawer }
        _hooked: false,

        // ── texts ─────────────────────────────────────────────────────────
        errorText(status, data) {
            const code = data && data.code;
            const max = data && data.max;
            switch (code) {
                case 'not_delivered': return '攝影師已更新或收回成品，請重新整理頁面';
                case 'not_owner': return '只有選片人可以操作';
                case 'already_confirmed': return '此相簿已確認完成';
                case 'revision_open': return '你已送出修改，攝影師處理中';
                case 'revision_cap': return `修改次數已達上限${max ? `（${max} 次）` : ''}，請直接聯絡攝影師`;
                case 'revision_photos_cap': return `一次最多標示 ${max || 100} 張照片，請先送出或刪除部分標示`;
                case 'marks_cap': return `標示總數已達上限${max ? `（${max} 個）` : ''}，請先減少一些標示`;
                case 'no_pins': return '還沒有任何標示，請先在照片上點出要修改的位置';
                case 'draft_changed': return '標示在別處被修改過，已更新為最新內容，請確認後再送出';
                case 'invalid_message': return '總說明請輸入 1–1000 字';
                case 'invalid_marks': return '標示內容不正確（每張最多 10 個，說明最多 100 字）';
                case 'invalid_photo_key':
                case 'not_in_finals': return '這張照片已不在目前的成品中，請重新整理頁面';
                case 'invalid_body': return '資料格式不正確，請重新整理頁面後再試';
                case 'too_large': return '內容太長，請縮短後再送出';
                case 'revision_pins_unavailable': return '標示修改功能暫時無法使用，請直接聯絡攝影師';
                default: break;
            }
            if (status === 0) return '無法連線，請檢查網路後再試';
            if (status === 401) return '連結已失效，請向攝影師索取新的連結';
            if (status === 403) return '只有選片人可以操作';
            if (status === 413) return '內容太長，請縮短後再送出';
            if (status === 429) return '操作太頻繁，請稍後再試';
            if (status === 400) return '資料格式不正確，請重新整理頁面後再試';
            return '暫時無法處理，請稍後再試';
        },

        // ── when the pin UI exists ─────────────────────────────────────────
        // Called by js/pick.js each time the view is applied (before the gallery is mounted).
        sync(pc) {
            this.pc = pc;
            this._hook();
            const on = !!(pc.active && pc.isOwner && pc.mode === 'delivered' && pc.view === 'finals' && !pc.confirmedAt && Array.isArray(pc.revisionDrafts));
            if (!on) { if (this.enabled) this.reset(); return; }
            const sig = `${pc.deliveredAt}\n${(pc.finalFolders || []).join('\n')}`;
            if (this.enabled && sig !== this.sig) this.reset();       // another delivery: these drafts were the old one's
            this.enabled = true;
            this.sig = sig;
            if (!this.loaded) this.adopt(pc.revisionDrafts);
            this.editable = !pc.revisionOpen;
            if (!this.editable && this.pinMode) { this.pinMode = false; this.selected = -1; }
            this._syncRound();
            this.refreshLb();
        },

        reset() {
            clearTimeout(this.timer); clearTimeout(this.retryTimer);
            this.timer = this.retryTimer = 0;
            this.enabled = this.editable = this.loaded = false;
            this.sig = '';
            this.marks = new Map(); this.ver = new Map(); this.dirty = new Set();
            this.status = ''; this.statusText = '';
            this.round = null; this.roundFor = '';
            this.pinMode = false; this.selected = -1;
            this._teardownLb();
        },

        // The gallery options (js/finals-gallery.js mount): nothing at all while off.
        galleryOpts() {
            return this.enabled ? { lightboxExtras: this.extras, tileBadge: photo => this.badge(photo) } : {};
        },

        // Replace the drafts with the server's (a fresh state read): local unsaved edits are dropped.
        adopt(list) {
            const next = new Map();
            (Array.isArray(list) ? list : []).forEach(d => {
                if (!d || typeof d.photo_key !== 'string') return;
                const m = PinLayer.clean(d.marks, PinLayer.PIN_MAX);
                if (m.length) next.set(d.photo_key, m);
            });
            clearTimeout(this.timer); clearTimeout(this.retryTimer);
            this.timer = this.retryTimer = 0;
            this.marks = next; this.ver = new Map(); this.dirty = new Set();
            this.loaded = true;
            this.setStatus('', '');
            this._changed();
            if (this.lb) this._paint();
        },

        // ── the numbers ───────────────────────────────────────────────────
        photoCount() { return this.marks.size; },
        emptyNotes() {
            let n = 0;
            this.marks.forEach(list => list.forEach(m => { if (!m.note.trim()) n++; }));
            return n;
        },
        marksOf(key) { return (this.marks.get(key) || []).map(m => ({ x: m.x, y: m.y, note: m.note })); },
        // [{k, n}] sorted by key — what POST /api/pick/revision-round compares against its drafts
        expect() {
            return [...this.marks.entries()].sort((a, b) => byCodePoint(a[0], b[0])).map(([k, list]) => ({ k, n: list.length }));
        },
        keys() { return [...this.marks.keys()].sort(byCodePoint); },
        badge(photo) {
            if (!this.enabled || !this.editable) return null;
            const list = this.marks.get(photo.id);
            return list && list.length ? String(list.length) : null;
        },
        _changed() {
            if (window.FinalsGallery && FinalsGallery.refreshBadges) FinalsGallery.refreshBadges();
            if (window.DeliveryDone && DeliveryDone.refresh) DeliveryDone.refresh();
        },

        // ── editing (only while editable) ─────────────────────────────────
        _commit(key, list) {
            if (!this.enabled || !this.editable) return;
            if (list.length) this.marks.set(key, list); else this.marks.delete(key);
            this.ver.set(key, (this.ver.get(key) || 0) + 1);
            this.dirty.add(key);
            if (this.status === 'error') this.setStatus('', '');
            this.schedule();
            this._changed();
        },
        addPin(key, x, y) {
            const cur = this.marksOf(key);
            if (cur.length >= PinLayer.PIN_MAX) { note(`每張照片最多標示 ${PinLayer.PIN_MAX} 個位置`); return -1; }
            cur.push({ x, y, note: '' });
            this._commit(key, cur);
            return cur.length - 1;
        },
        setNote(key, i, text) {
            const cur = this.marksOf(key);
            if (!cur[i]) return;
            cur[i].note = text;
            this._commit(key, cur);
        },
        removePin(key, i) {
            const cur = this.marksOf(key);
            if (!cur[i]) return;
            cur.splice(i, 1);
            this._commit(key, cur);
        },

        // ── saving ────────────────────────────────────────────────────────
        schedule() {
            clearTimeout(this.timer); clearTimeout(this.retryTimer);
            this.retryTimer = 0;
            this.timer = setTimeout(() => { this.timer = 0; this.flush(); }, SAVE_DELAY);
        },
        // Sends everything dirty now (serialised behind any save in flight). Resolves
        // { ok: true } or { ok: false, retry, status, data, text }.
        flush() {
            clearTimeout(this.timer);
            this.timer = 0;
            const run = () => this._drain();
            this.chain = this.chain.then(run, run);
            return this.chain;
        },
        async _drain() {
            while (this.dirty.size) {
                if (!this.enabled) return { ok: true };
                const keys = [...this.dirty].slice(0, BATCH);
                const vers = keys.map(k => this.ver.get(k) || 0);
                const r = await this._put(keys.map(k => ({ photo_key: k, marks: this.marksOf(k) })));
                if (!r.ok) return r;
                keys.forEach((k, i) => { if ((this.ver.get(k) || 0) === vers[i]) this.dirty.delete(k); });
            }
            if (this.status) this.setStatus('', '');
            return { ok: true };
        },
        async _put(items) {
            const pc = this.pc;
            const r = await pc._json(PATH, { method: 'PUT', headers: pc.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ items }) });
            if (r.ok) return { ok: true };
            const code = r.data && r.data.code;
            const text = this.errorText(r.status, r.data);
            const retry = r.status === 0 || r.status === 429 || (r.status >= 500 && code !== 'revision_pins_unavailable');
            if (retry) {
                this.setStatus('offline', '尚未儲存，連線後會自動送出');
                clearTimeout(this.retryTimer);
                this.retryTimer = setTimeout(() => { this.retryTimer = 0; this.flush(); }, retryMs());
                return { ok: false, retry: true, status: r.status, data: r.data, text };
            }
            this.setStatus('error', text);
            if (STALE_CODES.includes(code) && pc.refreshState) pc.refreshState();   // the page's picture is old: re-read it
            return { ok: false, retry: false, status: r.status, data: r.data, text };
        },
        setStatus(kind, text) {
            this.status = kind;
            this.statusText = text || '';
            const s = document.getElementById('rpStatus');
            if (s) { s.textContent = this.statusText; s.dataset.kind = kind; }
            if (window.DeliveryDone && DeliveryDone.refresh) DeliveryDone.refresh();
        },
        // leaving the page: what is still unsent goes out with keepalive (the answer is not awaited)
        _hook() {
            if (this._hooked) return;
            this._hooked = true;
            const leave = () => this._beacon();
            window.addEventListener('pagehide', leave);
            document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') leave(); });
        },
        _beacon() {
            const pc = this.pc;
            if (!pc || !this.enabled || !this.editable || !this.dirty.size) return;
            clearTimeout(this.timer);
            this.timer = 0;
            const keys = [...this.dirty];
            for (let i = 0; i < keys.length; i += BATCH) {
                const items = keys.slice(i, i + BATCH).map(k => ({ photo_key: k, marks: this.marksOf(k) }));
                try {
                    fetch(`${CONFIG.WORKER_URL}${PATH}`, {
                        method: 'PUT', keepalive: true,
                        headers: pc.headers({ 'Content-Type': 'application/json' }),
                        body: JSON.stringify({ items }),
                    }).catch(() => { /* gone with the page */ });
                } catch (e) { /* nothing to do */ }
            }
        },

        // ── a round that is open (sent): its pins, read-only, by file name ─
        async _syncRound() {
            const pc = this.pc;
            const open = this.enabled && pc.revisionOpen && typeof pc.revisionOpenPhotos === 'number';
            if (!open) { this.round = null; this.roundFor = ''; return; }
            const tag = `${this.sig}|${pc.revisionOpenPhotos}`;
            if (this.roundFor === tag) return;
            this.roundFor = tag;
            const list = window.RevisionHistory ? await RevisionHistory.ensureList(pc) : null;
            if (this.roundFor !== tag || !list || !list.ok) return;
            const row = list.rounds.find(r => r && r.open && r.kind === 'pins');
            if (!row) return;
            const r = await pc._json(`/api/pick/rounds/${encodeURIComponent(row.id)}`, { headers: pc.headers() });
            if (this.roundFor !== tag || !r.ok || !Array.isArray(r.data.photos)) return;
            const count = new Map();
            r.data.photos.forEach(p => count.set(p.name, (count.get(p.name) || 0) + 1));
            const byName = new Map();
            // a file name two photos share cannot be matched to one of them: no pins shown for it
            r.data.photos.forEach(p => { if (count.get(p.name) === 1) byName.set(p.name, PinLayer.clean(p.pins, PinLayer.PIN_MAX)); });
            this.round = { byName };
            if (this.lb) this._paint();
        },
        pinsFor(photo) {
            if (!photo) return [];
            if (this.editable) return this.marksOf(photo.id);
            return (this.round && this.round.byName.get(photo.name)) || [];
        },

        // ── the lightbox ──────────────────────────────────────────────────
        extras: {
            toolbar(bar, api) {
                const rp = RevisionPins;
                rp.lb = { bar, root: api.root, toggle: null, stage: null, img: null, photo: null, layer: null, drawer: null };
                rp._ensureToggle();
            },
            onShow(photo, stage, img) {
                const rp = RevisionPins, lb = rp.lb;
                if (!lb) return;
                lb.photo = photo; lb.stage = stage; lb.img = img;
                if (!lb.layer) {
                    lb.layer = PinLayer.attach(stage, img, {
                        max: PinLayer.PIN_MAX, readOnly: true,
                        onAdd: (x, y) => rp._onAdd(x, y),
                        onSelect: i => rp._onSelect(i),
                        onFull: () => note(`每張照片最多標示 ${PinLayer.PIN_MAX} 個位置`),
                    });
                }
                // the new photo's pins wait for its own picture (the old one's box is not theirs)
                lb.layer.layer.style.visibility = 'hidden';
                const show = () => { img.removeEventListener('load', show); img.removeEventListener('error', show); if (lb.layer) { lb.layer.refresh(); lb.layer.layer.style.visibility = ''; } };
                img.addEventListener('load', show);
                img.addEventListener('error', show);
                rp.selected = -1;
                rp._paint();
                if (img.complete && img.naturalWidth > 0) show();
            },
            onClose() {
                const rp = RevisionPins;
                rp._teardownLb();
                rp.pinMode = false;
                rp.selected = -1;
                if (rp.dirty.size) rp.flush();          // what is typed is on its way now, not in 600 ms
            },
            blockSwipe() { return RevisionPins.pinMode && RevisionPins.editable; },
        },

        _teardownLb() {
            const lb = this.lb;
            if (!lb) return;
            this.lb = null;
            if (lb.layer) lb.layer.destroy();
            if (lb.drawer) lb.drawer.remove();
            if (lb.toggle) lb.toggle.remove();
        },

        _ensureToggle() {
            const lb = this.lb;
            if (!lb) return;
            const want = this.enabled && this.editable;
            if (!want) { if (lb.toggle) { lb.toggle.remove(); lb.toggle = null; } return; }
            if (lb.toggle) return;
            const b = el('button', 'fg-lb-btn rp-toggle', '標示修改');
            b.id = 'rpPinToggle';
            b.type = 'button';
            b.setAttribute('aria-pressed', 'false');
            b.addEventListener('click', () => this.setPinMode(!this.pinMode));
            lb.bar.insertBefore(b, lb.bar.querySelector('#fgLbDownload'));
            lb.toggle = b;
            this._syncToggle();
        },
        _syncToggle() {
            const t = this.lb && this.lb.toggle;
            if (!t) return;
            t.textContent = this.pinMode ? '完成' : '標示修改';
            t.setAttribute('aria-pressed', this.pinMode ? 'true' : 'false');
        },
        setPinMode(on) {
            if (on && !(this.enabled && this.editable)) return;
            this.pinMode = !!on;
            this.selected = -1;
            this._syncToggle();
            this._paint();
        },
        refreshLb() {
            if (!this.lb) return;
            this._ensureToggle();
            this._syncToggle();
            if (this.lb.layer) this._paint();
        },

        // pins on the picture + the drawer, for the photo on show
        _paint() {
            const lb = this.lb;
            if (!lb || !lb.layer) return;
            const pins = this.pinsFor(lb.photo);
            lb.layer.set(pins);
            if (this.selected >= pins.length) this.selected = -1;
            lb.layer.select(this.selected);
            lb.layer.setReadOnly(!(this.pinMode && this.editable));
            this._drawer(pins);
        },
        _onAdd(x, y) {
            const lb = this.lb;
            if (!lb || !lb.photo || !this.pinMode || !this.editable) return;
            const i = this.addPin(lb.photo.id, x, y);
            if (i < 0) return;
            this.selected = i;
            this._paint();
            // the tap that placed the pin is the gesture that may raise the phone keyboard: focus now
            const input = lb.drawer && lb.drawer.querySelectorAll('.rp-note')[i];
            if (input) input.focus({ preventScroll: true });
        },
        _onSelect(i) {
            const lb = this.lb;
            if (!lb) return;
            if (this.editable && !this.pinMode) this.setPinMode(true);
            this.selected = i;
            this._paint();
            const input = lb.drawer && lb.drawer.querySelectorAll('.rp-note')[i];
            if (input) input.focus({ preventScroll: true });
        },

        // The drawer sits between the bar and the photo (a phone keyboard rises from the bottom, so the
        // note input is never under it). Editable in pin mode; read-only when a sent round has pins here.
        _drawer(pins) {
            const lb = this.lb;
            const show = this.editable ? this.pinMode : pins.length > 0;
            if (!show) { if (lb.drawer) { lb.drawer.remove(); lb.drawer = null; } return; }
            if (!lb.drawer) {
                lb.drawer = el('div', 'rp-drawer');
                lb.drawer.id = 'rpDrawer';
                lb.root.insertBefore(lb.drawer, lb.stage);
            }
            const key = lb.photo && lb.photo.id;
            const hint = el('div', 'rp-hint', this.editable
                ? `點照片上要修改的位置（這張已標 ${pins.length}/${PinLayer.PIN_MAX}）`
                : '已送出的修改標示（唯讀）');
            hint.id = 'rpHint';
            const list = el('ol', 'rp-list');
            pins.forEach((m, i) => {
                const row = el('li', 'rp-row');
                if (i === this.selected) row.setAttribute('aria-current', 'true');
                const num = el('span', 'rp-num', String(i + 1));
                row.append(num);
                if (this.editable) {
                    const input = el('input', 'rp-note');
                    input.type = 'text';
                    input.maxLength = PinLayer.NOTE_MAX;
                    input.value = m.note;
                    input.placeholder = '這裡要修改什麼？例：這裡痘痘';
                    input.enterKeyHint = 'done';
                    input.setAttribute('dir', 'auto');
                    input.setAttribute('autocomplete', 'off');
                    input.setAttribute('aria-label', `標示 ${i + 1} 的備註`);
                    const count = el('span', 'rp-count', `${PinLayer.len(m.note)}/${PinLayer.NOTE_MAX}`);
                    input.addEventListener('input', () => {
                        const clean = PinLayer.sanitize(input.value);
                        if (clean !== input.value) input.value = clean;
                        count.textContent = `${PinLayer.len(clean)}/${PinLayer.NOTE_MAX}`;
                        this.setNote(key, i, clean);
                        if (lb.layer) lb.layer.set(this.pinsFor(lb.photo));   // the pin's accessible name follows
                        if (lb.layer) lb.layer.select(this.selected);
                    });
                    input.addEventListener('focus', () => {
                        this.selected = i;
                        if (lb.layer) lb.layer.select(i);
                        list.querySelectorAll('.rp-row').forEach((r, k) => { if (k === i) r.setAttribute('aria-current', 'true'); else r.removeAttribute('aria-current'); });
                    });
                    input.addEventListener('keydown', e => {
                        if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); input.blur(); }
                    });
                    const del = el('button', 'rp-del', '×');
                    del.type = 'button';
                    del.setAttribute('aria-label', `刪除標示 ${i + 1}`);
                    del.addEventListener('click', () => { this.removePin(key, i); this.selected = -1; this._paint(); });
                    row.append(input, count, del);
                } else {
                    const t = el('span', 'rp-text', m.note || '（沒有說明）');
                    t.setAttribute('dir', 'auto');
                    row.append(t);
                }
                list.append(row);
            });
            const status = el('div', 'rp-status', this.statusText);
            status.id = 'rpStatus';
            status.setAttribute('role', 'status');
            status.dataset.kind = this.status;
            // rebuilt in place; a note being typed keeps its focus only when nothing structural changed
            const keep = document.activeElement;
            const keepIndex = keep && keep.classList && keep.classList.contains('rp-note') && lb.drawer.contains(keep)
                ? [...lb.drawer.querySelectorAll('.rp-note')].indexOf(keep) : -1;
            lb.drawer.replaceChildren(hint, list, status);
            if (keepIndex >= 0 && keepIndex < pins.length && this.selected !== -1) {
                const again = lb.drawer.querySelectorAll('.rp-note')[keepIndex];
                if (again) again.focus({ preventScroll: true });
            }
        },
    };

    window.RevisionPins = RevisionPins;
})();
