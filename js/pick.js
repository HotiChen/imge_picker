// Guest picking (docs/guest-picking.md).
//
// Present only when index.html is opened as a pick link: `?t=<pick token>`.
// That query param has never meant anything on this page before, so gating
// every line here behind `active` — decided synchronously, from the URL,
// before any other script's DOMContentLoaded handler runs — is what keeps the
// studio admin flow, the signed-in client flow and the old `?folder=`/`?id=`
// magic link running exactly as they did. client-auth-check.js checks this
// flag and gets out of the way; app.js checks it at the two points it has to
// (checkUrlParams, submitJob) and otherwise runs untouched.
//
// The pick token doubles as an ordinary share token for photo reads: the
// object route, the thumbnail route and `?list=` all accept it through
// `shareCovers` exactly like a client's album link (worker.js, `resolvePick`
// is only consulted on `/api/pick/*`). So the existing photo grid, folder
// tree and thumbnail plumbing (drive.js) need no changes at all — only
// CONFIG.SHARE_TOKEN has to carry this token, the same field a studio or
// session token fills.
(function () {
    const token = new URLSearchParams(window.location.search).get('t') || '';

    const PickController = {
        active: !!token,
        token,
        app: null,
        projectId: '',
        projectTitle: '',
        isOwner: false,
        ownerName: null,          // the seat holder's name, whoever that is
        phase: 'picking',
        pickLimit: null,
        extraPrice: null,
        modifiedAfterSubmit: false,
        submittedAt: null,
        folders: [],
        selections: new Map(),   // photo_key -> {rating, note}
        _saveTimer: null,
        _pendingUpsert: new Map(),
        _pendingDelete: new Set(),

        // ── localStorage: the picker key, kept per link so two different
        // pick links opened in the same browser never share one seat's key.
        _keyName() { return `pick_key:${this.token}`; },
        getKey() {
            try { return localStorage.getItem(this._keyName()) || ''; }
            catch (e) { return ''; }
        },
        setKey(k) {
            try { localStorage.setItem(this._keyName(), k); } catch (e) { /* best effort */ }
        },

        headers(extra) {
            const h = Object.assign({}, extra || {});
            h['X-Share-Token'] = this.token;
            const key = this.getKey();
            if (key) h['X-Picker-Key'] = key;
            return h;
        },

        async _json(path, opts) {
            let res;
            try {
                res = await fetch(`${CONFIG.WORKER_URL}${path}`, opts);
            } catch (e) {
                return { ok: false, status: 0, data: { error: '無法連線，請檢查網路' } };
            }
            let data = null;
            try { data = await res.json(); } catch (e) { /* not JSON */ }
            return { ok: res.ok, status: res.status, data: data || {} };
        },

        fetchState() {
            return this._json('/api/pick/state', { headers: this.headers() });
        },
        claim(name) {
            return this._json('/api/pick/claim', {
                method: 'POST',
                headers: this.headers({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ name }),
            });
        },
        saveSelections(payload) {
            return this._json('/api/pick/selections', {
                method: 'PUT',
                headers: this.headers({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(payload),
            });
        },
        submitPicks(payload) {
            return this._json('/api/pick/submit', {
                method: 'POST',
                headers: this.headers({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(payload),
            });
        },

        // Whether this browser may currently change ratings/notes and submit.
        // False for every viewer (no seat, or someone else's), and false for
        // the owner too once the photographer has started retouching.
        canEdit() {
            return this.active && this.isOwner && (this.phase === 'picking' || this.phase === 'submitted');
        },

        // ── autosave: debounced, batched ─────────────────────────────────
        queueUpsert(photoKey, rating, note) {
            if (!this.canEdit()) return;
            this._pendingDelete.delete(photoKey);
            this._pendingUpsert.set(photoKey, { photo_key: photoKey, rating, note: note || '' });
            this.selections.set(photoKey, { rating, note: note || '' });
            this.renderCounter();
            clearTimeout(this._saveTimer);
            this._saveTimer = setTimeout(() => this.flush(), 800);
        },

        async flush() {
            clearTimeout(this._saveTimer);
            if (!this._pendingUpsert.size && !this._pendingDelete.size) return;
            const upsert = Array.from(this._pendingUpsert.values());
            const del = Array.from(this._pendingDelete);
            this._pendingUpsert.clear();
            this._pendingDelete.clear();
            const { ok, status, data } = await this.saveSelections({ upsert, delete: del });
            if (ok) {
                // mirrors the gate UPDATE in worker.js: a save while already
                // 'submitted' raises modified_after_submit, so the banner has
                // to catch up here too — nothing re-fetches state for us.
                if (this.phase === 'submitted' && !this.modifiedAfterSubmit) {
                    this.modifiedAfterSubmit = true;
                    this.renderBanner();
                }
                return;
            }
            if (status === 409 && data && data.code === 'retouching') {
                this.phase = 'retouching';
                this.renderBanner();
                this.rerenderGrid();
            } else if (typeof toast !== 'undefined') {
                // a static, server-authored string — never guest-supplied text —
                // so it is safe in toast's innerHTML-based renderer
                toast.error((data && data.error) || '儲存失敗，請檢查網路連線');
            }
        },

        // ── lifecycle ─────────────────────────────────────────────────────
        async start(app) {
            this.app = app;
            if (typeof CONFIG !== 'undefined') CONFIG.SHARE_TOKEN = this.token;
            this._hideStudioOnlyUI();
            const firstSidebarSection = document.querySelector('.sidebar-section:first-child');
            if (firstSidebarSection) firstSidebarSection.style.display = 'none';
            this._wireHooks(app);
            this._wireSubmitModal();
            this._wireBannerHint();

            const { ok, status, data } = await this.fetchState();
            if (!ok) {
                this._showFatalError(status === 401
                    ? '連結已失效或不存在，請向攝影師索取新的連結'
                    : '無法載入，請稍後再試');
                return;
            }
            this._applyState(data);
            this._updateSubmitButton();

            if (!this.isOwner && this.ownerName === null) {
                // seat free — block on a name before showing anything else
                this._showClaimOverlay();
                return;
            }
            this.renderBanner();
            await this.loadGrid();
        },

        _applyState(data) {
            const project = data.project || {};
            this.projectId = project.id || '';
            this.projectTitle = project.title || '';
            this.pickLimit = project.pick_limit ?? null;
            this.extraPrice = project.extra_price ?? null;
            this.isOwner = !!data.is_owner;
            this.ownerName = data.owner === undefined ? null : data.owner;
            this.phase = data.phase || 'picking';
            this.modifiedAfterSubmit = !!data.modified_after_submit;
            this.submittedAt = data.submitted_at || null;
            this.folders = Array.isArray(data.folders) ? data.folders : [];
            this.selections = new Map(
                (data.selections || []).map(s => [s.photo_key, { rating: s.rating || 0, note: s.note || '' }])
            );
        },

        _updateSubmitButton() {
            const btn = document.getElementById('submitJobBtn');
            if (btn) btn.style.display = this.isOwner ? 'inline-flex' : 'none';
        },

        async afterClaim() {
            this._updateSubmitButton();
            this.renderBanner();
            await this.loadGrid();
        },

        async loadGrid() {
            const emptyH2 = document.querySelector('#emptyState h2');
            const emptyP = document.querySelector('#emptyState p');
            if (emptyH2) emptyH2.textContent = this.isOwner ? '正在準備您的照片' : '正在載入相簿';
            if (emptyP) emptyP.textContent = '請稍候…';
            const folder = this.folders[0] || '';
            await this.app.handleLoadPhotos(folder);
            this.renderCounter();
        },

        // Every server-known rating/note wins over whatever localStorage
        // handed back — "server state wins on reload" — and this runs after
        // every load, including a later folder-tree navigation, because both
        // funnel through the one wrapped handleLoadPhotos.
        applyServerSelections() {
            if (!this.app) return;
            this.app.photos.forEach(p => {
                const s = this.selections.get(p.id);
                p.rating = s ? s.rating : 0;
                p.note = s ? s.note : '';
            });
            this.app.applyFilters();
            this.app.renderPhotoGrid();
            this.app.updateStats();
            this.renderCounter();
        },

        // Rebuilds the grid so every card is recreated with the current
        // canEdit() — the one place a mid-session drop into 'retouching'
        // actually strips the star/select controls already on screen.
        rerenderGrid() {
            if (!this.app) return;
            this.app.applyFilters();
            this.app.renderPhotoGrid();
        },

        _hideStudioOnlyUI() {
            ['uploadPageBtn', 'openBookEditorBtn'].forEach(id => document.getElementById(id)?.remove());
        },

        _showFatalError(msg) {
            const empty = document.getElementById('emptyState');
            const loading = document.getElementById('loadingState');
            if (loading) loading.style.display = 'none';
            if (!empty) return;
            const h2 = empty.querySelector('h2');
            const p = empty.querySelector('p');
            if (h2) h2.textContent = '無法開啟相簿';
            if (p) p.textContent = msg;
            empty.style.display = 'flex';
        },

        // ── drive.js hooks: one choke point each for rating and note, so
        // pick.js needs no changes to rating.js or drive.js itself ─────────
        _wireHooks(app) {
            const origSaveRating = driveManager.saveRating.bind(driveManager);
            driveManager.saveRating = (photoId, rating) => {
                origSaveRating(photoId, rating);
                if (!this.canEdit()) return;
                const prev = this.selections.get(photoId);
                this.queueUpsert(photoId, rating, prev ? prev.note : '');
            };
            const origSaveNote = driveManager.saveNote.bind(driveManager);
            driveManager.saveNote = (photoId, note) => {
                origSaveNote(photoId, note);
                if (!this.canEdit()) return;
                const photo = app.photos.find(p => p.id === photoId);
                const prev = this.selections.get(photoId);
                const rating = photo ? (photo.rating || 0) : (prev ? prev.rating : 0);
                this.queueUpsert(photoId, rating, note);
            };
            const origLoad = app.handleLoadPhotos.bind(app);
            app.handleLoadPhotos = async (path) => {
                await this.flush();
                await origLoad(path);
                this.applyServerSelections();
            };
        },

        // ── banner: "someone else is picking" / phase notices ──────────────
        renderBanner() {
            const el = document.getElementById('pickBanner');
            const linesEl = document.getElementById('pickBannerLines');
            const hintEl = document.getElementById('pickBannerHint');
            const hintTextEl = document.getElementById('pickBannerHintText');
            if (!el || !linesEl) return;

            const lines = [];
            if (!this.isOwner && this.ownerName) lines.push(`此相簿由 ${this.ownerName} 選片中`);
            if (this.phase === 'retouching') {
                lines.push('攝影師已安排精修，如需修改請透過 LINE 聯絡攝影師');
            } else if (this.isOwner && this.phase === 'submitted') {
                lines.push('已送出');
                if (this.modifiedAfterSubmit) lines.push('已修改，請重新送出');
            }
            const showHint = !this.isOwner && !!this.ownerName && this.phase !== 'retouching';

            linesEl.textContent = '';
            lines.forEach(text => {
                const d = document.createElement('div');
                d.className = 'pick-banner-line';
                d.textContent = text; // guest-supplied names go through textContent only
                linesEl.appendChild(d);
            });
            if (hintEl) hintEl.hidden = !showHint;
            if (hintTextEl) hintTextEl.textContent = showHint ? `你是 ${this.ownerName} 嗎？` : '';
            el.hidden = lines.length === 0 && !showHint;
        },

        _wireBannerHint() {
            const btn = document.getElementById('pickBannerLoginBtn');
            if (btn) btn.addEventListener('click', () => { window.location.href = 'client-login.html'; });
        },

        // ── counter: "已選 N / limit" + the over-limit warning ──────────────
        renderCounter() {
            const el = document.getElementById('pickCounter');
            const mainEl = document.getElementById('pickCounterMain');
            const warnEl = document.getElementById('pickCounterWarn');
            if (!el || !mainEl) return;
            if (!this.isOwner) { el.hidden = true; return; }

            const count = Array.from(this.selections.values()).filter(s => s.rating > 0).length;
            const limit = this.pickLimit;
            mainEl.textContent = limit == null ? `已選 ${count} 張` : `已選 ${count} / ${limit}`;
            el.classList.toggle('over', limit != null && count > limit);

            const over = limit == null ? 0 : Math.max(0, count - limit);
            if (warnEl) {
                if (over > 0) {
                    let msg = `方案 ${limit} 張精修，您已選 ${count} 張，多 ${over} 張`;
                    if (this.extraPrice != null) msg += `，每張 NT$${this.extraPrice} 加挑費`;
                    warnEl.textContent = msg;
                    warnEl.hidden = false;
                } else {
                    warnEl.textContent = '';
                    warnEl.hidden = true;
                }
            }
            el.hidden = false;
        },

        // ── claim overlay: the free-seat name prompt ─────────────────────
        _showClaimOverlay() {
            const overlay = document.getElementById('pickClaimOverlay');
            if (!overlay) return;
            const projectEl = document.getElementById('pickClaimProject');
            if (projectEl) projectEl.textContent = this.projectTitle || '';
            overlay.hidden = false;

            const input = document.getElementById('pickNameInput');
            const btn = document.getElementById('pickClaimBtn');
            const err = document.getElementById('pickClaimErr');
            if (!input || !btn) return;

            const submit = async () => {
                const name = (input.value || '').trim();
                if (err) err.textContent = '';
                if (!name) { if (err) err.textContent = '請輸入姓名'; return; }
                btn.disabled = true;
                const { ok, status, data } = await this.claim(name);
                btn.disabled = false;
                if (ok) {
                    this.setKey(data.picker_key);
                    this.isOwner = true;
                    this.ownerName = data.owner;
                    overlay.hidden = true;
                    await this.afterClaim();
                } else if (status === 409) {
                    this.isOwner = false;
                    this.ownerName = (data && data.owner) || null;
                    overlay.hidden = true;
                    this.renderBanner();
                    await this.loadGrid();
                } else if (err) {
                    err.textContent = (data && data.error) || '送出失敗，請再試一次';
                }
            };
            btn.onclick = submit;
            input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
            setTimeout(() => input.focus(), 30);
        },

        // ── submit modal ──────────────────────────────────────────────────
        openSubmitModal() {
            const modal = document.getElementById('pickSubmitModal');
            if (!modal) return;
            const nameEl = document.getElementById('pickSubmitName');
            const relEl = document.getElementById('pickSubmitRelationship');
            const emailEl = document.getElementById('pickSubmitEmail');
            const errEl = document.getElementById('pickSubmitErr');
            if (nameEl) nameEl.value = this.ownerName || '';
            if (relEl) relEl.value = '';
            if (emailEl) emailEl.value = '';
            if (errEl) errEl.textContent = '';
            modal.classList.add('active');
        },
        closeSubmitModal() {
            document.getElementById('pickSubmitModal')?.classList.remove('active');
        },

        _wireSubmitModal() {
            document.getElementById('pickSubmitCancelBtn')?.addEventListener('click', () => this.closeSubmitModal());
            document.getElementById('pickSubmitConfirmBtn')?.addEventListener('click', () => this._confirmSubmit());
        },

        async _confirmSubmit() {
            const relEl = document.getElementById('pickSubmitRelationship');
            const emailEl = document.getElementById('pickSubmitEmail');
            const errEl = document.getElementById('pickSubmitErr');
            const btn = document.getElementById('pickSubmitConfirmBtn');
            const relationship = relEl ? relEl.value : '';
            const email = emailEl ? emailEl.value.trim() : '';
            if (errEl) errEl.textContent = '';

            await this.flush();
            if (btn) btn.disabled = true;
            const { ok, status, data } = await this.submitPicks({ relationship, email: email || undefined });
            if (btn) btn.disabled = false;

            if (ok) {
                this.phase = 'submitted';
                this.modifiedAfterSubmit = false;
                this.submittedAt = data.submitted_at || null;
                this.closeSubmitModal();
                this.renderBanner();
                this.renderCounter();
                if (typeof toast !== 'undefined') {
                    let msg = `已送出，共 ${data.count ?? 0} 張`;
                    if (data.over) msg += `，超出方案 ${data.over} 張`;
                    toast.success(msg);
                }
            } else if (status === 409 && data && data.code === 'retouching') {
                this.phase = 'retouching';
                this.closeSubmitModal();
                this.renderBanner();
                this.rerenderGrid();
            } else if (errEl) {
                // a real, server-authored message (e.g. 請選擇與新人的關係,
                // Email 格式不正確) rather than a made-up one
                errEl.textContent = (data && data.error) || '送出失敗，請再試一次';
            }
        },
    };

    window.PickController = PickController;
})();
