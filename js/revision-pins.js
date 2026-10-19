// Pins on the delivered finals — the draft side (docs/revision-pins.md §4.2, §6.1, §13.1).
//
// The seat holder of a delivered, unconfirmed project opens a photo in the standard preview (the
// 驗收頁 is the 毛片 page, docs/delivery.md), places numbered pins and writes a note on each with the
// same 標示修改 / note editor / list as picking (js/pick.js syncPinUI, which reads and writes through
// this store); the drafts autosave to PUT /api/pick/revision-pins and come back from GET
// /api/pick/state (`revision_drafts`). js/delivery-done.js turns the drafts into a round (the
// bottom 「送出（N 張）」); js/revision-history.js shows the earlier rounds.
//
// This file owns: the draft store and its save queue (debounced, retried, flushed on leaving),
// the pins of an open (sent) round for the read-only preview, the card badge count, and the
// plain-Chinese texts for every error code of the contract.
//
// Off (nothing of it on the page) unless: the seat holder, delivered mode, not confirmed,
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

    const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

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
        round: null,                 // the open round's pins by file name, for the read-only preview
        roundFor: '',
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
        // Called by js/pick.js each time the view is applied.
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
            this._syncRound();
            this._preview();
        },

        reset() {
            clearTimeout(this.timer); clearTimeout(this.retryTimer);
            this.timer = this.retryTimer = 0;
            this.enabled = this.editable = this.loaded = false;
            this.sig = '';
            this.marks = new Map(); this.ver = new Map(); this.dirty = new Set();
            this.status = ''; this.statusText = '';
            this.round = null; this.roundFor = '';
            this._changed();
            this._preview();
        },

        // the open preview (js/pick.js) re-reads what it shows: the photo's pins, editable or not
        _preview() {
            const pc = this.pc;
            if (pc && pc.syncPinUI) pc.syncPinUI();
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
            this._preview();
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
        // the card badge: the draft pins of a photo (0 = none, and none at all while a sent round is open)
        badgeCount(key) {
            if (!this.enabled || !this.editable) return 0;
            const list = this.marks.get(key);
            return list ? list.length : 0;
        },
        // `key`: only that photo's pins changed (its card alone is redrawn); none: all of them may have
        _changed(key) {
            const pc = this.pc;
            if (pc && pc.refreshPinBadges) pc.refreshPinBadges(key);
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
            this._changed(key);
        },
        // a photo's FULL pin list, in order (js/pick.js _saveMarks: the same shape the picking pins use)
        setMarks(key, list) {
            this._commit(key, PinLayer.clean(list, PinLayer.PIN_MAX));
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
            if (this.pc && this.pc.renderPinStatus) this.pc.renderPinStatus();   // the line in the open preview
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
            this._preview();
        },
        // the open round's pins of the photo called `name` (copies), [] when it has none or none is open
        roundPins(name) {
            return ((this.round && this.round.byName.get(name)) || []).map(m => ({ x: m.x, y: m.y, note: m.note }));
        },
    };

    window.RevisionPins = RevisionPins;
})();
