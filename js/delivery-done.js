// The client's answer on a delivered project: the status block under the delivery bar and its
// modals — 確認完成 and 需要修改 (docs/delivery.md, client confirmation; docs/revision-pins.md §7.3).
//
// Moved out of js/pick.js. pick.js keeps what the page state is (mode, view, confirmedAt, the
// header-carrying fetch) and calls DeliveryDone.render(pc) whenever the view is re-applied; this
// file owns the block, its modals and the two requests' flow. `pc` is the PickController.
//
// With pins on the finals (js/revision-pins.js is on: the seat holder, `revision_drafts` an array)
// the 需要修改 text box gives way to 「送出修改 N 張」 and its dialog, and the 「上一輪的修改資訊」
// button (js/revision-history.js) appears; without them (migration not run, old Worker) the text
// flow below is untouched.
//
// Only in the delivered mode: outside it neither the block nor its modals exist (removed, never
// hidden). Every string that came from the server (the revision text) goes through textContent.
(function () {
    'use strict';

    const pinsOn = () => !!(window.RevisionPins && RevisionPins.enabled);

    const DeliveryDone = {
        busy: false,
        keyHandler: null,
        pc: null,

        // re-draw the block (a pin was added, a save failed ...): cheap, the modals stay
        refresh() {
            if (this.pc && document.getElementById('deliveryDone')) this.render(this.pc);
        },

        remove() {
            document.getElementById('deliveryDone')?.remove();
            this.removeModals();
            if (window.RevisionHistory) RevisionHistory.close(true);
        },

        render(pc) {
            this.pc = pc;
            let el = document.getElementById('deliveryDone');
            const bar = document.getElementById('deliveryBar');
            // the completion page has no status block, no 確認完成, no modals
            if (pc.mode !== 'delivered' || !bar || pc._completionWanted()) {
                this.remove();
                return;
            }
            const pins = pinsOn();
            if (pins && window.RevisionHistory) RevisionHistory.probe(pc);
            if (!el) {
                el = document.createElement('div');
                el.id = 'deliveryDone';
                el.className = 'delivery-done';
                bar.after(el);
            }
            const confirmed = !!pc.confirmedAt;
            const revising = !confirmed && pc.revisionOpen;
            el.dataset.state = confirmed ? 'confirmed' : (revising ? 'revising' : 'open');

            const text = (cls, id, t) => {
                const d = document.createElement('div');
                d.className = cls;
                if (id) d.id = id;
                d.textContent = t;
                return d;
            };
            const kids = [];
            if (confirmed) {
                const when = pc._fmtDate(pc.confirmedAt);
                kids.push(text('delivery-done-status', 'deliveryDoneStatus', `✓ 已確認完成${when ? `（${when}）` : ''}`));
            } else if (revising) {
                // a viewer sees that changes are in progress, never the text
                const sent = pins && typeof pc.revisionOpenPhotos === 'number' ? `已送出修改（${pc.revisionOpenPhotos} 張），攝影師處理中` : '已通知攝影師，修改中';
                kids.push(text('delivery-done-status', 'deliveryDoneStatus', pc.isOwner ? sent : '攝影師修改中'));
                if (pc.isOwner && pc.revisionMessage) kids.push(text('delivery-done-msg', 'deliveryDoneMsg', pc.revisionMessage));
            } else {
                kids.push(text('delivery-done-status', 'deliveryDoneStatus',
                    pc.isOwner ? (pins ? '滿意的話請按「確認完成」，需要調整請點照片標示後按「送出修改」' : '滿意的話請按「確認完成」，需要調整請按「需要修改」') : '尚待選片人確認完成'));
            }
            // a draft that is not saved yet (offline / refused): said here too, not only in the lightbox
            if (pins && !confirmed && RevisionPins.status) {
                const save = text('delivery-done-save', 'deliveryDoneSave', RevisionPins.statusText);
                save.setAttribute('role', 'status');
                kids.push(save);
            }
            // buttons: the seat holder only, and none once confirmed
            if (pc.isOwner && !confirmed) {
                const actions = document.createElement('div');
                actions.className = 'delivery-done-actions';
                const ok = document.createElement('button');
                ok.id = 'doneConfirmBtn';
                ok.type = 'button';
                ok.className = 'btn btn-success';
                ok.textContent = '確認完成';
                ok.addEventListener('click', () => this.openModal(pc, 'confirm'));
                actions.append(ok);
                if (pins) {
                    // a sent round is frozen and only one is open at a time: no second submit until the photographer delivers again
                    if (!revising) {
                        const n = RevisionPins.photoCount();
                        const send = document.createElement('button');
                        send.id = 'doneRoundBtn';
                        send.type = 'button';
                        send.className = 'btn btn-outline';
                        send.textContent = `送出修改 ${n} 張`;
                        send.disabled = n === 0;
                        send.addEventListener('click', () => this.openModal(pc, 'round'));
                        actions.append(send);
                        if (n === 0) {
                            const hint = text('delivery-done-hint', 'doneRoundHint', '點照片進入標示修改');
                            actions.append(hint);
                        }
                    }
                    if (window.RevisionHistory && RevisionHistory.visible()) {
                        const hist = document.createElement('button');
                        hist.id = 'doneHistoryBtn';
                        hist.type = 'button';
                        hist.className = 'btn btn-outline';
                        hist.textContent = '上一輪的修改資訊';
                        hist.addEventListener('click', () => RevisionHistory.open(pc, hist));
                        actions.append(hist);
                    }
                } else {
                    const rev = document.createElement('button');
                    rev.id = 'doneReviseBtn';
                    rev.type = 'button';
                    rev.className = 'btn btn-outline';
                    rev.textContent = '需要修改';
                    rev.addEventListener('click', () => this.openModal(pc, 'revision'));
                    actions.append(rev);
                }
                kids.push(actions);
                this.ensureModals(pc);
            } else {
                this.removeModals();
            }
            el.replaceChildren(...kids);
        },

        removeModals() {
            document.getElementById('doneConfirmModal')?.remove();
            document.getElementById('doneReviseModal')?.remove();
            document.getElementById('doneRoundModal')?.remove();
            if (this.keyHandler) {
                document.removeEventListener('keydown', this.keyHandler);
                this.keyHandler = null;
            }
        },

        ensureModals(pc) {
            const mk = (tag, cls, props) => Object.assign(document.createElement(tag), { className: cls || '' }, props || {});
            const modal = (id, title, ...body) => {
                const m = mk('div', 'modal done-modal', { id });
                m.setAttribute('role', 'dialog');
                m.setAttribute('aria-modal', 'true');
                m.setAttribute('aria-labelledby', `${id}Title`);
                const content = mk('div', 'modal-content pick-submit-content pick-over-content');
                content.append(mk('h3', '', { id: `${id}Title`, textContent: title }), ...body);
                m.append(mk('div', 'modal-overlay'), content);
                return m;
            };
            const errBox = id => {
                const e = mk('div', 'pick-claim-err done-err', { id });
                e.setAttribute('role', 'alert');
                return e;
            };
            const btn = (id, cls, label) => mk('button', cls, { id, type: 'button', textContent: label });

            if (!document.getElementById('doneConfirmModal')) {
                const confirmModal = modal('doneConfirmModal', '確認完成？',
                    mk('p', 'pick-over-line', { textContent: '確認後攝影師會收到通知；之後若要再修改，需聯絡攝影師。' }),
                    errBox('doneConfirmErr'),
                    (() => {
                        const a = mk('div', 'pick-submit-actions');
                        a.append(btn('doneConfirmCancel', 'btn btn-outline', '取消'), btn('doneConfirmSubmit', 'btn btn-success', '確認完成'));
                        return a;
                    })());
                document.body.append(confirmModal);
                confirmModal.querySelector('.modal-overlay').addEventListener('click', () => this.closeModal('confirm'));
                document.getElementById('doneConfirmCancel').addEventListener('click', () => this.closeModal('confirm'));
                document.getElementById('doneConfirmSubmit').addEventListener('click', () => this.submit(this.pc, 'confirm'));
            }

            if (pinsOn()) {
                // the text box is replaced by the round dialog
                document.getElementById('doneReviseModal')?.remove();
                if (!document.getElementById('doneRoundModal')) {
                    const ta = mk('textarea', 'input done-textarea', { id: 'doneRoundNote', rows: 3, maxLength: 1000 });
                    ta.setAttribute('aria-label', '總說明（可不填）');
                    ta.placeholder = '想補充的話（可不填）';
                    const count = mk('div', 'done-count', { id: 'doneRoundCount', textContent: '0 / 1000' });
                    const roundModal = modal('doneRoundModal', '送出修改？',
                        mk('ul', 'done-round-list', { id: 'doneRoundList' }),
                        mk('p', 'pick-over-line', { textContent: '送出後這一輪就不能再改，攝影師更新照片後會再通知你。' }),
                        ta, count, errBox('doneRoundErr'),
                        (() => {
                            const a = mk('div', 'pick-submit-actions');
                            a.append(btn('doneRoundCancel', 'btn btn-outline', '取消'), btn('doneRoundSubmit', 'btn btn-success', '送出修改'));
                            return a;
                        })());
                    document.body.append(roundModal);
                    ta.addEventListener('input', () => { count.textContent = `${ta.value.length} / 1000`; });
                    roundModal.querySelector('.modal-overlay').addEventListener('click', () => this.closeModal('round'));
                    document.getElementById('doneRoundCancel').addEventListener('click', () => this.closeModal('round'));
                    document.getElementById('doneRoundSubmit').addEventListener('click', () => this.submitRound(this.pc));
                }
            } else {
                document.getElementById('doneRoundModal')?.remove();
                if (!document.getElementById('doneReviseModal')) {
                    const ta = mk('textarea', 'input done-textarea', { id: 'doneReviseText', rows: 5, maxLength: 1000 });
                    ta.setAttribute('aria-label', '修改內容');
                    ta.placeholder = '請說明哪裡需要修改（可寫照片檔名）';
                    const count = mk('div', 'done-count', { id: 'doneReviseCount', textContent: '0 / 1000' });
                    const reviseModal = modal('doneReviseModal', '需要修改',
                        mk('p', 'pick-over-line', { textContent: '請寫下需要修改的地方，送出後會通知攝影師。' }),
                        ta, count, errBox('doneReviseErr'),
                        (() => {
                            const a = mk('div', 'pick-submit-actions');
                            const send = btn('doneReviseSubmit', 'btn btn-success', '送出');
                            send.disabled = true;
                            a.append(btn('doneReviseCancel', 'btn btn-outline', '取消'), send);
                            return a;
                        })());
                    document.body.append(reviseModal);
                    ta.addEventListener('input', () => {
                        count.textContent = `${ta.value.length} / 1000`;
                        if (!this.busy) document.getElementById('doneReviseSubmit').disabled = !ta.value.trim();
                    });
                    reviseModal.querySelector('.modal-overlay').addEventListener('click', () => this.closeModal('revision'));
                    document.getElementById('doneReviseCancel').addEventListener('click', () => this.closeModal('revision'));
                    document.getElementById('doneReviseSubmit').addEventListener('click', () => this.submit(this.pc, 'revision'));
                }
            }

            if (!this.keyHandler) {
                this.keyHandler = e => {
                    if (e.key !== 'Escape') return;
                    for (const kind of ['confirm', 'revision', 'round']) {
                        if (this.modalEl(kind)?.classList.contains('active')) this.closeModal(kind);
                    }
                };
                document.addEventListener('keydown', this.keyHandler);
            }
        },

        modalEl(kind) {
            return document.getElementById({ revision: 'doneReviseModal', round: 'doneRoundModal' }[kind] || 'doneConfirmModal');
        },
        errEl(kind) {
            return document.getElementById({ revision: 'doneReviseErr', round: 'doneRoundErr' }[kind] || 'doneConfirmErr');
        },
        openModal(pc, kind) {
            const m = this.modalEl(kind);
            if (!m) return;
            this.showErr(kind, '');
            if (kind === 'confirm') this.fillConfirm();
            if (kind === 'round') this.fillRound();
            m.classList.add('active');
            if (kind === 'revision') setTimeout(() => document.getElementById('doneReviseText')?.focus(), 30);
        },

        // 確認完成 with drafts still unsent: say so (they do not reach the photographer)
        fillConfirm() {
            document.getElementById('doneConfirmUnsent')?.remove();
            const n = pinsOn() ? RevisionPins.photoCount() : 0;
            if (!n) return;
            const p = document.createElement('p');
            p.id = 'doneConfirmUnsent';
            p.className = 'pick-over-line done-round-warn';
            p.textContent = `你還有 ${n} 張照片的標示沒有送出，確認完成後不會送給攝影師`;
            document.getElementById('doneConfirmErr')?.before(p);
        },

        // the round dialog's title, rows and empty-note warning, from the drafts as they are now
        fillRound() {
            if (!pinsOn()) return;
            const keys = RevisionPins.keys();
            document.getElementById('doneRoundModalTitle').textContent = `送出 ${keys.length} 張照片的修改？`;
            const list = document.getElementById('doneRoundList');
            const rows = keys.map(k => {
                const li = document.createElement('li');
                li.className = 'done-round-item';
                const img = document.createElement('img');
                img.alt = '';
                img.decoding = 'async';
                img.src = driveManager.getImageUrl({ id: k }, 400);
                const name = document.createElement('span');
                name.className = 'done-round-name';
                name.setAttribute('dir', 'auto');
                name.textContent = k.split('/').pop();
                const n = document.createElement('span');
                n.className = 'done-round-count';
                n.textContent = `${RevisionPins.marksOf(k).length} 個標示`;
                li.append(img, name, n);
                return li;
            });
            list.replaceChildren(...rows);
            document.getElementById('doneRoundWarn')?.remove();
            const empty = RevisionPins.emptyNotes();
            if (empty) {
                const w = document.createElement('p');
                w.id = 'doneRoundWarn';
                w.className = 'done-round-warn';
                w.textContent = `有 ${empty} 個標示沒有寫說明，攝影師只看得到位置`;
                list.after(w);
            }
        },
        closeModal(kind) {
            if (this.busy) return;
            this.modalEl(kind)?.classList.remove('active');
        },

        // The error line of a modal; `reload` adds a 重新載入 button next to it
        // (a page that shows an old version must be reloaded, not retried).
        showErr(kind, text, reload) {
            const el = this.errEl(kind);
            if (!el) return;
            el.replaceChildren();
            if (text) el.append(document.createTextNode(text));
            if (reload) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'btn btn-outline done-reload';
                b.textContent = '重新載入';
                b.addEventListener('click', () => window.location.reload());
                el.append(b);
            }
        },

        errorText(status, data) {
            const code = data && data.code;
            if (code === 'revision_open_cap' || code === 'revision_cap') return '修改要求已達上限，請直接聯絡攝影師';
            if (code === 'not_delivered') return '攝影師已更新或收回成品，請重新整理頁面';
            if (code === 'invalid_message') return '請輸入 1–1000 字的修改內容';
            if (code === 'too_large') return '內容太長，請縮短後再送出';
            if (status === 403) return '只有選片人可以操作';
            if (status === 401) return '連結已失效，請向攝影師索取新的連結';
            if (status === 0) return '無法連線，請檢查網路後再試';
            return '暫時無法處理，請稍後再試';
        },

        // Re-reads the state right before sending: the page may be showing a
        // version the photographer has since replaced (docs/delivery.md,
        // "Known limit"). 'ok' = nothing moved; 'confirmed' = it was confirmed
        // meanwhile (by the photographer); 'stale' = finals, delivery or the
        // open request changed; 'error' = the read itself failed.
        async guard(pc) {
            const r = await pc.fetchState();
            if (!r.ok) return { kind: 'error', status: r.status, data: r.data };
            const d = r.data;
            if (d.mode !== 'delivered') return { kind: 'stale' };
            const finals = Array.isArray(d.final_folders) ? d.final_folders : [];
            if (JSON.stringify(finals) !== JSON.stringify(pc.finalFolders) || (d.delivered_at || null) !== pc.deliveredAt) {
                return { kind: 'stale' };
            }
            if (typeof d.confirmed_at === 'string') return { kind: 'confirmed', data: d };
            const msg = typeof d.revision_message === 'string' ? d.revision_message : null;
            if ((d.revision_open === true) !== pc.revisionOpen || msg !== pc.revisionMessage) return { kind: 'stale' };
            return { kind: 'ok' };
        },

        async submit(pc, kind) {
            if (this.busy) return;
            const revision = kind === 'revision';
            const submit = document.getElementById(revision ? 'doneReviseSubmit' : 'doneConfirmSubmit');
            const ta = document.getElementById('doneReviseText');
            const message = revision ? ta.value.trim() : '';
            if (revision && !message) { this.showErr(kind, '請輸入修改內容'); return; }
            this.showErr(kind, '');
            this.busy = true;
            submit.disabled = true;
            try {
                const guard = await this.guard(pc);
                if (guard.kind === 'stale') {
                    this.showErr(kind, '攝影師剛更新了照片，請重新整理後再確認', true);
                    return;
                }
                if (guard.kind === 'error') {
                    this.showErr(kind, this.errorText(guard.status, guard.data));
                    return;
                }
                if (guard.kind === 'confirmed') {
                    pc._applyConfirmFields(guard.data);
                    this.busy = false;
                    this.closeModal(kind);
                    pc._applyView();   // re-renders the block, and switches to the completion page when this confirmed
                    if (typeof toast !== 'undefined') toast.success('此相簿已確認完成');
                    return;
                }
                const { ok, status, data } = revision ? await pc.requestRevision(message) : await pc.confirmDelivery();
                if (ok) {
                    if (revision) {
                        pc.revisionOpen = true;
                        pc.revisionMessage = typeof data.message === 'string' ? data.message : message;
                        ta.value = '';
                        document.getElementById('doneReviseCount').textContent = '0 / 1000';
                    } else {
                        pc.confirmedAt = typeof data.confirmed_at === 'string' ? data.confirmed_at : new Date().toISOString();
                        pc.revisionOpen = false;
                        pc.revisionMessage = null;
                    }
                    this.busy = false;
                    this.closeModal(kind);
                    pc._applyView();   // re-renders the block, and switches to the completion page when this confirmed
                    if (typeof toast !== 'undefined') toast.success(revision ? '已通知攝影師' : '已確認完成');
                    return;
                }
                if (data && data.code === 'already_confirmed') {
                    // confirmed in the meantime (another tab, or the photographer):
                    // show it as it is
                    const r = await pc.fetchState();
                    if (r.ok) pc._applyConfirmFields(r.data);
                    else { pc.confirmedAt = pc.confirmedAt || new Date().toISOString(); pc.revisionOpen = false; pc.revisionMessage = null; }
                    this.busy = false;
                    this.closeModal(kind);
                    pc._applyView();   // re-renders the block, and switches to the completion page when this confirmed
                    if (typeof toast !== 'undefined') toast.success('此相簿已確認完成');
                    return;
                }
                this.showErr(kind, this.errorText(status, data), data && data.code === 'not_delivered');
            } finally {
                this.busy = false;
                if (submit.isConnected) submit.disabled = revision ? !ta.value.trim() : false;
            }
        },

        // 「送出修改 N 張」: save what is pending, make sure the page is not showing an old delivery, then
        // POST the round with `expect` (the photos and pin counts this page believes it is sending).
        async submitRound(pc) {
            if (this.busy || !pinsOn()) return;
            const kind = 'round';
            const submit = document.getElementById('doneRoundSubmit');
            const ta = document.getElementById('doneRoundNote');
            this.showErr(kind, '');
            this.busy = true;
            submit.disabled = true;
            const leave = () => { this.busy = false; this.closeModal(kind); };
            try {
                const saved = await RevisionPins.flush();
                if (!saved.ok) { this.showErr(kind, saved.text || RevisionPins.errorText(saved.status, saved.data)); return; }
                const guard = await this.guard(pc);
                if (guard.kind === 'stale') { this.showErr(kind, '攝影師剛更新了照片，請重新整理後再確認', true); return; }
                if (guard.kind === 'error') { this.showErr(kind, RevisionPins.errorText(guard.status, guard.data)); return; }
                if (guard.kind === 'confirmed') {
                    pc._applyConfirmFields(guard.data);
                    leave();
                    pc._applyView();
                    if (typeof toast !== 'undefined') toast.success('此相簿已確認完成');
                    return;
                }
                const body = { expect: RevisionPins.expect() };
                const noteText = ta.value.trim();
                if (noteText) body.note = noteText;
                const { ok, status, data } = await pc.submitRevisionRound(body);
                const code = data && data.code;
                if (ok) {
                    const r = await pc.refreshState();
                    if (!r.ok) {
                        // sent, but the re-read failed: show it as sent from what the answer said
                        pc.revisionOpen = true;
                        pc.revisionMessage = null;
                        pc.revisionOpenPhotos = typeof data.photo_count === 'number' ? data.photo_count : RevisionPins.photoCount();
                        RevisionPins.adopt([]);
                        pc._applyView();
                    }
                    ta.value = '';
                    document.getElementById('doneRoundCount').textContent = '0 / 1000';
                    leave();
                    if (typeof toast !== 'undefined') toast.success('已送出修改，攝影師會收到通知');
                    return;
                }
                if (code === 'already_confirmed' || code === 'revision_open') {
                    // confirmed / sent in another tab meanwhile: show it as it is
                    const r = await pc.refreshState();
                    if (!r.ok && code === 'already_confirmed') { pc.confirmedAt = pc.confirmedAt || new Date().toISOString(); pc.revisionOpen = false; pc.revisionMessage = null; pc._applyView(); }
                    leave();
                    if (typeof toast !== 'undefined') {
                        if (code === 'already_confirmed') toast.success('此相簿已確認完成'); else toast.info(RevisionPins.errorText(status, data));
                    }
                    return;
                }
                if (code === 'draft_changed' || code === 'no_pins') {
                    // another tab changed the drafts: take the server's, show the list again and let the guest confirm
                    const r = await pc.fetchState();
                    if (r.ok) { pc._applyConfirmFields(r.data); if (Array.isArray(r.data.revision_drafts)) RevisionPins.adopt(r.data.revision_drafts); }
                    if (!RevisionPins.photoCount()) {
                        leave();
                        pc._applyView();
                        if (typeof toast !== 'undefined') toast.info('目前沒有標示可以送出');
                        return;
                    }
                    this.fillRound();
                    this.showErr(kind, RevisionPins.errorText(status, data));
                    return;
                }
                this.showErr(kind, RevisionPins.errorText(status, data), code === 'not_delivered');
            } finally {
                this.busy = false;
                if (submit.isConnected) submit.disabled = false;
            }
        },
    };

    window.DeliveryDone = DeliveryDone;
})();
