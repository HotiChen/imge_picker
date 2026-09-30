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

    // Retouch pins (docs/guest-picking.md "Retouch pins — the save contract").
    const PIN_MAX = 10;         // per photo (server PICK_MARKS_MAX)
    const PIN_NOTE_MAX = 100;   // characters (server PICK_MARK_NOTE_MAX)
    // control / line-separator characters the server refuses in a note
    const PIN_NOTE_BAD = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
    const pinSanitize = v => String(v == null ? '' : v).replace(PIN_NOTE_BAD, '');
    const pinLen = v => Array.from(v).length;
    // what the server sends is canonical already; this only keeps a bad row
    // from ever reaching the canvas
    const cleanMarks = arr => window.cleanPinMarks(arr, PIN_MAX); // js/annotation.js

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
        // Delivery (docs/delivery.md), from GET /api/pick/state. `mode` is
        // 'picking' or 'delivered'; `folders` above is the proofs this link
        // may read right now ([] once delivered unless the switch is on).
        mode: 'picking',
        finalFolders: [],
        allowProofDownload: false,
        deliveredAt: null,
        // What the page shows: 'picking' (today's view), 'finals' (the
        // delivery gallery) or 'proofs' (delivered + switch on: a
        // download-only list of the proofs).
        view: 'picking',
        // path -> [{id,name}] children last seen for it (from that path's own
        // `?list=` response). Builds the nested 資料夾 tree lazily: only a
        // folder actually opened has its children on screen (docs/backlog.md
        // "Guest page hides subfolders").
        folderChildren: new Map(),
        selections: new Map(),   // photo_key -> {rating, note}
        // 全部 / 已選 / 未選 — the guest filter bar (docs/guest-picking.md).
        // 'all' and 'unselected' read the current folder's grid; 'selected'
        // is built straight from `selections`, across every permitted folder.
        filterMode: 'all',
        _saveTimer: null,
        _pendingUpsert: new Map(),
        _pendingDelete: new Set(),
        // The value each key held before this in-flight batch touched it
        // (or null if the key was new), so a 409 selection_cap/row_cap can put
        // the optimistic UI back exactly where it was.
        _pendingPrev: new Map(),
        // keys whose pins an un-heart just cleared locally: a re-heart in the
        // same batch must say `marks: []` (absent would keep the server's)
        _marksClear: new Set(),
        // retouch pins: pin mode + the photo the pin UI is showing
        pinMode: false,
        _pinPhotoId: null,

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
            return this.active && this.isOwner && this.mode === 'picking' &&
                (this.phase === 'picking' || this.phase === 'submitted');
        },

        // ── delivery (docs/delivery.md) ─────────────────────────────────
        // The delivery gallery / proof-download list: no picking UI at all.
        isGallery() { return this.active && this.view !== 'picking'; },

        // Whether this link may show a download button. Picking: only when
        // the photographer switched proof downloads on. Gallery: always (the
        // finals are the deliverable; the proofs list only exists when the
        // switch is on).
        canDownload() {
            return this.active && (this.view === 'picking' ? this.allowProofDownload : true);
        },

        downloadLabel() { return this.view === 'finals' ? '下載' : '下載原檔'; },

        // The folders the page lists for the current view.
        viewFolders() {
            return this.view === 'finals' ? this.finalFolders : this.folders;
        },

        // A plain link to `?download=1` would navigate a guest away to a JSON
        // error page on a 403 (attachment headers only come with a success),
        // so ask for one byte first: only a success is followed, and the
        // refusal the photographer's switch causes gets its own sentence.
        async download(e, photo) {
            if (e) e.preventDefault();
            const url = driveManager.downloadUrl(photo);
            let res;
            try {
                res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
            } catch (err) {
                if (typeof toast !== 'undefined') toast.error('無法連線，請檢查網路');
                return;
            }
            if (!res.ok) {
                let data = null;
                try { data = await res.json(); } catch (err) { /* not JSON */ }
                if (typeof toast !== 'undefined') {
                    toast.error(res.status === 403 && data && data.code === 'original_not_allowed'
                        ? '原檔未開放下載'
                        : (res.status === 401 ? '連結已失效，請向攝影師索取新的連結' : '下載失敗，請稍後再試'));
                }
                return;
            }
            const a = document.createElement('a');
            a.href = url;
            a.rel = 'noopener';
            document.body.appendChild(a);
            a.click();
            a.remove();
        },

        async switchView(view) {
            if (this.view === view) return;
            this.view = view;
            this.folderChildren = new Map();
            this._applyView();
            await this.loadGrid();
        },

        // Everything that depends on which view is showing.
        _applyView() {
            const gallery = this.isGallery();
            if (gallery && !this._galleryUIRemoved) {
                // removed, not hidden (.btn's display beats [hidden]); the
                // delivered gallery / proofs list has a folder selector only
                document.getElementById('pickFilterBar')?.remove();
                document.getElementById('pickFilterSection')?.remove();
                document.getElementById('pickCounter')?.remove();
                document.getElementById('mobileActionBar')?.remove(); // the counter lives here
                document.getElementById('pickBanner')?.remove();
                document.getElementById('pickModalTools')?.remove();
                this._galleryUIRemoved = true;
            }
            this._renderDeliveryBar();
            const noteGroup = document.getElementById('noteInputGroup');
            if (noteGroup) noteGroup.hidden = gallery;
        },

        _renderDeliveryBar() {
            const el = document.getElementById('deliveryBar');
            if (!el) return;
            const titleEl = document.getElementById('deliveryTitle');
            const btn = document.getElementById('deliveryProofsBtn');
            if (this.mode !== 'delivered') { el.hidden = true; return; }
            const t = this.projectTitle ? ` · ${this.projectTitle}` : '';
            if (titleEl) titleEl.textContent = this.view === 'finals' ? `精修成品${t}` : `毛片原檔（僅供下載）${t}`;
            if (btn) {
                if (this.allowProofDownload) {
                    btn.textContent = this.view === 'finals' ? '下載毛片原檔' : '← 回精修成品';
                    btn.hidden = false;
                    btn.onclick = () => this.switchView(this.view === 'finals' ? 'proofs' : 'finals');
                } else {
                    btn.remove(); // removed, not hidden: no proof-download entry exists
                }
            }
            el.hidden = false;
        },

        // ── autosave: debounced, batched ─────────────────────────────────
        // `marks` undefined = the photo's pins did not change: the request
        // item carries no `marks` (the server keeps them). A defined array is
        // the photo's FULL pin list (the numbering is its order).
        queueUpsert(photoKey, rating, note, marks) {
            if (!this.canEdit()) return;
            const prevSel = this.selections.get(photoKey);
            if (!this._pendingPrev.has(photoKey)) {
                this._pendingPrev.set(photoKey, prevSel ? { ...prevSel } : null);
            }
            this._pendingDelete.delete(photoKey);
            const prevPending = this._pendingUpsert.get(photoKey);
            const item = { photo_key: photoKey, rating, note: note || '' };
            let stored;
            if (rating > 0) {
                if (marks !== undefined) {
                    item.marks = marks;
                    stored = marks;
                    this._marksClear.delete(photoKey);
                } else {
                    stored = prevSel && Array.isArray(prevSel.marks) ? prevSel.marks : [];
                    if (prevPending && prevPending.marks !== undefined) item.marks = prevPending.marks;
                    else if (this._marksClear.has(photoKey)) item.marks = [];
                }
            } else {
                // un-heart: the server clears the pins itself; never send them
                stored = [];
                if (prevSel && Array.isArray(prevSel.marks) && prevSel.marks.length) this._marksClear.add(photoKey);
            }
            this._pendingUpsert.set(photoKey, item);
            this.selections.set(photoKey, { rating, note: note || '', marks: stored });
            this.renderCounter();
            // 'all' shows the current folder regardless of what is picked, so
            // it never needs a repaint here; 已選/未選 depend on the rating
            // that just changed, both in and out of the current folder.
            if (this.filterMode !== 'all' && marks === undefined) this.rerenderGrid();
            if (this._pinPhotoId === photoKey && (!prevSel || (prevSel.rating > 0) !== (rating > 0))) this.syncPinUI();
            clearTimeout(this._saveTimer);
            this._saveTimer = setTimeout(() => this.flush(), 800);
        },

        async flush() {
            clearTimeout(this._saveTimer);
            if (!this._pendingUpsert.size && !this._pendingDelete.size) return;
            const upsert = Array.from(this._pendingUpsert.values());
            const del = Array.from(this._pendingDelete);
            const prevSnapshot = this._pendingPrev;
            this._pendingUpsert.clear();
            this._pendingDelete.clear();
            this._pendingPrev = new Map();
            this._marksClear = new Set();
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
                this.syncPinUI();
                return;
            }
            if (status === 409 && data && data.code === 'marks_cap') {
                // nothing was written: take the optimistic pin(s) back
                this._revertBatch(prevSnapshot);
                if (typeof toast !== 'undefined') toast.error('標註總數已達上限（300 個）');
                return;
            }
            if (status === 413 || (status === 500 && data && data.code === 'marks_unavailable') ||
                (status === 400 && data && data.code === 'invalid_marks')) {
                // nothing was written in any of these either
                this._revertBatch(prevSnapshot);
                if (typeof toast !== 'undefined') {
                    toast.error(status === 413 ? '內容太大，無法儲存，請減少標示或備註的文字'
                        : (status === 500 ? '標示功能尚未啟用，請稍後再試' : '標示內容不正確，請修改後再試'));
                }
                return;
            }
            if (status === 409 && data && (data.code === 'selection_cap' || data.code === 'row_cap')) {
                // nothing was written server-side — put every key this batch
                // touched back to what it held before, so the optimistic ♥
                // toggle does not lie about what is actually saved
                this._revertBatch(prevSnapshot);
                if (typeof toast !== 'undefined') {
                    // selection_cap gets the copy the spec asks for; row_cap
                    // (a table-size limit a guest never sees coming) shows the
                    // server's own message rather than a made-up one
                    toast.error(data.code === 'selection_cap'
                        ? `最多可選 ${data.max} 張`
                        : ((data && data.error) || '儲存失敗，請檢查網路連線'));
                }
                return;
            }
            if (status === 400 && data && data.code === 'invalid_photo_key') {
                // nothing was written; the batch's optimistic state is wrong
                // the same way a cap refusal is
                this._revertBatch(prevSnapshot);
                if (typeof toast !== 'undefined') toast.error((data && data.error) || '照片名稱不正確');
                return;
            }
            if (typeof toast !== 'undefined') {
                // a static, server-authored string — never guest-supplied text —
                // so it is safe in toast's innerHTML-based renderer
                toast.error((data && data.error) || '儲存失敗，請檢查網路連線');
            }
        },

        _revertBatch(prevSnapshot) {
            for (const [key, prev] of prevSnapshot) {
                if (prev) this.selections.set(key, prev);
                else this.selections.delete(key);
            }
            // togglePickHeart already wrote the optimistic rating straight onto
            // the photo objects in app.photos (and any synthetic ♥已選 card),
            // not just into `selections` — resyncing every one of them from
            // `selections`, the same way a reload does, is what actually
            // undoes it on screen, not only in this map.
            this.applyServerSelections();
            this.syncPinUI();
        },

        _selectedCount() {
            let n = 0;
            for (const s of this.selections.values()) if (s.rating > 0) n++;
            return n;
        },

        // ── filter bar: 全部 / ♥ 已選 (N) / 未選 ────────────────────────────
        // 全部/未選 read the current folder's own photos; 已選 is built from
        // `selections` directly, so it reaches across every folder the link
        // permits without a second /list call per folder.
        buildFilteredPhotos(currentPhotos) {
            if (this.filterMode === 'selected') {
                return Array.from(this.selections.entries())
                    .filter(([, s]) => s.rating > 0)
                    .map(([photo_key, s]) => this._photoFromKey(photo_key, s))
                    .sort((a, b) => a.id.localeCompare(b.id));
            }
            if (this.filterMode === 'unselected') {
                return currentPhotos.filter(p => {
                    const s = this.selections.get(p.id);
                    return !s || !(s.rating > 0);
                });
            }
            return currentPhotos.slice();
        },

        // A photo object good enough for createPhotoCard/getImageUrl, built
        // from nothing but the key and the state already on hand — no
        // metadata fetch, no listing of the folder it lives in.
        _photoFromKey(photo_key, s) {
            return {
                id: photo_key,
                name: photo_key.split('/').pop() || photo_key,
                rating: s.rating,
                note: s.note || '',
                uploaded: null,
                hasAnnotations: false,
            };
        },

        _replaceFilterBar() {
            document.querySelector('.star-filter')?.remove();
            document.getElementById('filterSelectedBtn')?.remove();
            const bar = document.getElementById('pickFilterBar');
            if (!bar) return;
            bar.hidden = false;
            bar.querySelectorAll('[data-pick-filter]').forEach(btn => {
                btn.addEventListener('click', () => this._setFilterMode(btn.dataset.pickFilter));
            });
        },

        _setFilterMode(mode) {
            if (this.filterMode === mode) return;
            this.filterMode = mode;
            document.querySelectorAll('#pickFilterBar [data-pick-filter]').forEach(b => {
                b.classList.toggle('active', b.dataset.pickFilter === mode);
            });
            this.rerenderGrid();
        },

        // ── lifecycle ─────────────────────────────────────────────────────
        async start(app) {
            this.app = app;
            if (typeof CONFIG !== 'undefined') CONFIG.SHARE_TOKEN = this.token;
            this._hideStudioOnlyUI();
            this._removeSourceControls();
            this._removeAnnotationToolbox();
            this._setupGuestModal();
            this._removeZipDownloads();
            this._replaceFilterBar();
            this._restructureGuestChrome();
            this._wireHooks(app);
            this._wireSubmitModal();

            const { ok, status, data } = await this.fetchState();
            if (!ok) {
                this._showFatalError(status === 401
                    ? '連結已失效或不存在，請向攝影師索取新的連結'
                    : '無法載入，請稍後再試');
                return;
            }
            this._applyState(data);
            this._renderStudioHeader();
            this._layoutGuest();
            // No download button exists for a guest unless this link may
            // download: removed from the DOM, not hidden.
            if (!this.canDownload()) {
                document.getElementById('previewDownloadBtn')?.remove();
                document.getElementById('modalDownloadBtn')?.remove();
            }
            this._applyView();
            this.renderCounter();

            if (!this.isOwner && this.ownerName === null && this.mode === 'picking') {
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
            // A delivered project shows the gallery to owner and viewers alike.
            this.mode = data.mode === 'delivered' ? 'delivered' : 'picking';
            this.finalFolders = Array.isArray(data.final_folders) ? data.final_folders : [];
            this.allowProofDownload = data.allow_proof_download === true;
            this.deliveredAt = data.delivered_at || null;
            this.view = this.mode === 'delivered' ? 'finals' : 'picking';
            this.selections = new Map(
                (data.selections || []).map(s => [s.photo_key, {
                    rating: s.rating || 0, note: s.note || '',
                    // only the seat owner is sent pins; a viewer has none
                    marks: this.isOwner && (s.rating || 0) > 0 ? cleanMarks(s.marks) : [],
                }])
            );
            this.studio = data.studio || null;
        },

        // Header branding for a guest pick link (docs/dashboard-settings.md):
        // GET /api/pick/state's studio.{name, booking_url, has_logo}. Every
        // value here is guest-untrusted server data — name/alt go through
        // textContent, the logo is loaded by property assignment (never
        // built into an HTML string). The guest page has no 預約拍攝 button at
        // all (docs/backlog.md, "Guest pick page UI"): booking_url stays a
        // setting, unused here.
        _renderStudioHeader() {
            const studio = this.studio;
            if (!studio) return;
            if (studio.name) {
                const nameEl = document.querySelector('.logo-name');
                if (nameEl) nameEl.textContent = studio.name;
            }
            if (studio.has_logo) {
                const markEl = document.querySelector('.logo-mark');
                if (markEl) {
                    const img = document.createElement('img');
                    img.className = 'logo-mark-img';
                    img.alt = studio.name || 'Studio logo';
                    img.src = `${CONFIG.WORKER_URL}/api/studio/logo`;
                    markEl.replaceWith(img);
                }
            }
        },

        async afterClaim() {
            this.renderBanner();
            await this.loadGrid();
        },

        async loadGrid() {
            const emptyH2 = document.querySelector('#emptyState h2');
            const emptyP = document.querySelector('#emptyState p');
            if (emptyH2) emptyH2.textContent = this.isOwner ? '正在準備您的照片' : '正在載入相簿';
            if (emptyP) emptyP.textContent = '請稍候…';
            const folder = this.viewFolders()[0] || '';
            await this.app.handleLoadPhotos(folder);
            if (this.isGallery() && !this.app.photos.length && !this.app.currentFolders.length) {
                if (emptyH2) emptyH2.textContent = '這裡還沒有照片';
                if (emptyP) emptyP.textContent = '';
            }
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
            this._renderGrid();
            this.app.updateStats();
            this.renderCounter();
        },

        // Rebuilds the grid so every card is recreated with the current
        // canEdit() — the one place a mid-session drop into 'retouching'
        // actually strips the star/select controls already on screen.
        rerenderGrid() {
            if (!this.app) return;
            this.app.applyFilters();
            this._renderGrid();
        },

        // Never let a photo-less-but-has-subfolders folder's card grid
        // (app.js renderFolderGrid) get silently replaced by an empty photo
        // grid (docs/backlog.md "Guest page hides subfolders", rule 3) —
        // handleLoadPhotos's own auto-navigate (see _wireHooks) means this
        // case is rare in practice, but this is the backstop for whatever
        // reaches applyServerSelections/rerenderGrid without going through
        // it. ♥ 已選 is exempt: it reaches across every folder regardless of
        // what the current one holds, so it must never fall back to cards.
        _renderGrid() {
            if (this.filterMode !== 'selected' &&
                this.app.currentFolders.length > 0 && this.app.photos.length === 0) {
                this.app.renderFolderGrid();
            } else {
                this.app.renderPhotoGrid();
            }
        },

        _hideStudioOnlyUI() {
            ['uploadPageBtn', 'openBookEditorBtn', 'studioBookingLink',
             // the one submit button is the bottom bar's #pickSubmitBtn; the
             // header 完成挑圖 stays only for the ?folder= mode (index.html)
             'submitJobBtn', 'sidebarToggle', 'sidebarBackdrop',
             'headerSortBtn', 'headerViewBtn', 'expiryBadge']
                .forEach(id => document.getElementById(id)?.remove());
            document.querySelector('.header-vsep')?.remove();
            document.querySelector('.logo-label')?.remove();
            document.getElementById('buildVersion')?.remove();
        },

        // A guest gets only 資料夾 and the 全部 / 已選 / 未選 filter
        // (docs/backlog.md "Guest pick page UI"): every other sidebar section
        // is removed from the DOM, the filter bar is rescued out of the
        // 02 / RATING section first, and the HC avatar becomes a person icon.
        _restructureGuestChrome() {
            const sidebar = document.querySelector('aside.sidebar');
            const bar = document.getElementById('pickFilterBar');
            if (sidebar) {
                const sections = Array.from(sidebar.querySelectorAll(':scope > .sidebar-section'));
                const filterSection = document.createElement('div');
                filterSection.className = 'sidebar-section';
                filterSection.id = 'pickFilterSection';
                if (bar) filterSection.appendChild(bar);
                sections.slice(1).forEach(sec => sec.remove());
                sidebar.appendChild(filterSection);
                if (sections[0]) {
                    sections[0].querySelector('.side-title')?.remove();
                    sections[0].querySelector('#sourceMeta')?.remove();
                }
            }
            const avatar = document.getElementById('userAvatarStudio');
            if (avatar) {
                avatar.classList.add('guest-avatar');
                avatar.setAttribute('role', 'img');
                avatar.setAttribute('aria-label', '訪客');
                avatar.textContent = '';
                // static markup only: a person icon, no guest text involved
                avatar.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" ' +
                    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
                    'aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/></svg>';
            }
        },

        // ≤1024px (where the ☰ drawer used to be): no sidebar at all — a
        // sticky #guestBar at the top of the grid column carries the project
        // title, a folder selector and the filter. Wider: the sidebar comes
        // back holding just 資料夾 and the filter. Re-run on a width change
        // (rotation), moving the same nodes so their listeners survive.
        _layoutGuest() {
            const title = document.querySelector('#headerBreadcrumbs');
            if (title && this.projectTitle) title.textContent = this.projectTitle;
            if (!this._sidebarEl) this._sidebarEl = document.querySelector('aside.sidebar');
            if (!this._mq) {
                this._mq = window.matchMedia('(max-width: 1024px)');
                this._mq.addEventListener('change', () => this._layoutGuest());
            }
            const main = document.querySelector('main.main-content');
            const content = document.querySelector('main.main-content > .content');
            if (!main || !content || !this._sidebarEl) return;
            const bar = document.getElementById('pickFilterBar');
            if (this._mq.matches) {
                let gb = document.getElementById('guestBar');
                if (!gb) {
                    gb = document.createElement('div');
                    gb.id = 'guestBar';
                    gb.className = 'guest-bar';
                    const t = document.createElement('div');
                    t.id = 'guestBarTitle';
                    t.className = 'guest-bar-title';
                    const row = document.createElement('label');
                    row.className = 'guest-folder-row';
                    row.id = 'guestFolderRow';
                    const cap = document.createElement('span');
                    cap.className = 'guest-folder-cap';
                    cap.textContent = '資料夾：';
                    const sel = document.createElement('select');
                    sel.id = 'guestFolderSelect';
                    sel.className = 'guest-folder-select';
                    sel.setAttribute('aria-label', '資料夾');
                    sel.addEventListener('change', () => this.app.handleLoadPhotos(sel.value));
                    row.append(cap, sel);
                    gb.append(t, row);
                    content.insertBefore(gb, content.firstChild);
                }
                content.classList.add('has-guest-bar');
                gb.querySelector('#guestBarTitle').textContent = this.projectTitle || '';
                if (bar) gb.appendChild(bar);
                this._sidebarEl.remove();
            } else {
                document.getElementById('guestBar')?.remove();
                content.classList.remove('has-guest-bar');
                if (!this._sidebarEl.isConnected) main.insertBefore(this._sidebarEl, content);
                const sec = document.getElementById('pickFilterSection');
                if (bar && sec) sec.appendChild(bar);
            }
            this.renderFolderPanel();
        },

        // The <select> in #guestBar: same rows as the desktop tree (roots +
        // every subfolder seen so far, indented), same click target
        // (handleLoadPhotos), only present while the bar is.
        _renderFolderSelect() {
            const sel = document.getElementById('guestFolderSelect');
            const row = document.getElementById('guestFolderRow');
            if (!sel || !row) return;
            const roots = this.viewFolders();
            row.hidden = !roots.length;
            const current = (typeof driveManager !== 'undefined') ? driveManager.currentFolderId : '';
            sel.textContent = '';
            const add = (folder, depth) => {
                const o = document.createElement('option');
                o.value = folder;
                const name = folder.replace(/\/$/, '').split('/').pop() || folder;
                o.textContent = (depth ? '\u3000'.repeat(depth) + '└ ' : '') + name;
                sel.appendChild(o);
                (this.folderChildren.get(folder) || []).forEach(c => add(c.id, depth + 1));
            };
            roots.forEach(f => add(f, 0));
            sel.value = current;
        },

        // 01/SOURCE's path box + LOAD button are the studio's own way to type
        // a path; a guest has no path to type — their folders come from the
        // token (this.folders). Removed, not hidden: .btn carries
        // display:inline-flex, which beats the UA's [hidden] { display: none
        // }. The 資料夾 panel underneath stays — renderFolderPanel fills it.
        _removeSourceControls() {
            document.querySelector('.sidebar-section:first-child .input-group')?.remove();
        },

        // The drawing toolbox (tools, colour, brush size, clear-all) has
        // nowhere to save to: `selections` has a `note` column but no
        // annotations column, and guests are never minted a studio token to
        // write one through anyway. The note box and the canvas itself
        // (still the photo viewer) stay.
        // 打包全部下載 / 下載選取 / 全選 fetch full-resolution originals, which
        // a guest link is refused (docs/delivery.md) — and a photo's download
        // is the per-photo link instead. Removed, not hidden.
        _removeZipDownloads() {
            ['downloadAllBtn', 'downloadSelectedHeaderBtn', 'selectAllBtn', 'deselectAllBtn', 'bulkActionBar']
                .forEach(id => document.getElementById(id)?.remove());
        },

        // ── the preview's own controls (docs/backlog.md "Retouch pins") ──────
        // The orange #mobileToolsToggle covered the ♥ on a phone; a guest gets
        // a labelled 備註・標示 button instead, inside the photo area (above the
        // bottom ♥ bar, never over it). The photographer's own toggle stays.
        _setupGuestModal() {
            document.getElementById('mobileToolsToggle')?.remove();
            const head = document.querySelector('.sidebar-header-mobile h4');
            if (head) head.textContent = '備註・標示';
            const deskHead = document.querySelector('.annotation-tools > h4');
            if (deskHead) deskHead.textContent = '備註・標示';
        },

        // The row of buttons over the photo, built on demand and only for the
        // seat owner (a viewer has neither notes nor pins to work with).
        _ensureToolsRow() {
            const cc = document.querySelector('.canvas-container');
            if (!cc) return null;
            const wanted = this.isOwner && !this.isGallery();
            let row = document.getElementById('pickModalTools');
            if (!wanted) { row?.remove(); this._exitPinMode(true); return null; }
            if (row) return row;
            row = document.createElement('div');
            row.id = 'pickModalTools';
            row.className = 'pick-modal-tools';
            const left = document.createElement('div');
            left.className = 'pick-tools-left';
            const right = document.createElement('div');
            right.className = 'pick-tools-right';

            const pinBtn = document.createElement('button');
            pinBtn.type = 'button';
            pinBtn.id = 'pickPinBtn';
            pinBtn.className = 'pick-tool-btn';
            pinBtn.textContent = '標示修改';
            pinBtn.addEventListener('click', () => this._enterPinMode());
            const doneBtn = document.createElement('button');
            doneBtn.type = 'button';
            doneBtn.id = 'pickPinDoneBtn';
            doneBtn.className = 'pick-tool-btn pick-tool-done';
            doneBtn.textContent = '完成';
            doneBtn.addEventListener('click', () => this._exitPinMode());
            const panelBtn = document.createElement('button');
            panelBtn.type = 'button';
            panelBtn.id = 'pickPanelBtn';
            panelBtn.className = 'pick-tool-btn pick-panel-btn';
            panelBtn.textContent = '備註・標示';
            panelBtn.addEventListener('click', () => {
                document.getElementById('modalSidebar')?.classList.toggle('active');
            });
            right.appendChild(panelBtn);
            row.append(left, right);
            cc.appendChild(row);
            this._pinBtn = pinBtn;
            this._pinDoneBtn = doneBtn;
            return row;
        },

        _currentPinPhoto() {
            const a = window.annotationManager;
            return (a && a.currentPhoto && a.currentPhoto.id === this._pinPhotoId) ? a.currentPhoto : null;
        },

        _enterPinMode() {
            if (!this.canEdit() || !this._pinPhotoId) return;
            const sel = this.selections.get(this._pinPhotoId);
            if (!sel || !(sel.rating > 0)) return;
            this.pinMode = true;
            document.getElementById('modalSidebar')?.classList.remove('active');
            annotationManager.setPinMode(true);
            this.syncPinUI();
        },

        _exitPinMode(quiet) {
            if (!this.pinMode) return;
            this.pinMode = false;
            if (window.annotationManager) annotationManager.setPinMode(false);
            if (!quiet) this.syncPinUI();
        },

        // Called when the preview shows a photo (js/app.js openModal, with the
        // photo) and whenever something that decides what the pin UI shows
        // changes: the ♥, the phase, a revert. Rebuilds the buttons and the
        // list; the canvas pins are re-read from `selections`.
        syncPinUI(photo) {
            if (!this.active) return;
            if (photo) {
                if (this._pinPhotoId !== photo.id) this._exitPinMode(true);
                this._pinPhotoId = photo.id;
            }
            const id = this._pinPhotoId;
            const row = this._ensureToolsRow();
            const sel = id ? this.selections.get(id) : null;
            const hearted = !!sel && sel.rating > 0;
            const editable = this.canEdit() && hearted;
            if (!editable && this.pinMode) this._exitPinMode(true);
            if (row) {
                const left = row.querySelector('.pick-tools-left');
                left.replaceChildren();
                if (editable) left.appendChild(this.pinMode ? this._pinDoneBtn : this._pinBtn);
            }
            this._renderPinHint();
            const marks = hearted ? this.marksOf(id) : [];
            const cur = this._currentPinPhoto();
            if (cur && window.annotationManager) annotationManager.setMarks(marks);
            this._renderPinList(hearted, editable, marks);
        },

        _renderPinHint() {
            const cc = document.querySelector('.canvas-container');
            let hint = document.getElementById('pickPinHint');
            if (!this.pinMode || !cc) { hint?.remove(); return; }
            if (!hint) {
                hint = document.createElement('div');
                hint.id = 'pickPinHint';
                hint.className = 'pick-pin-hint';
                cc.appendChild(hint);
            }
            const n = this.marksOf(this._pinPhotoId).length;
            hint.textContent = `點照片上要修改的位置（已標 ${n}/${PIN_MAX}）`;
        },

        // The 修改標示 list in the note panel: one row per pin — number, note
        // input (≤100 chars, with a counter), × to delete. Every note goes
        // through .value / textContent; nothing is built as HTML.
        _renderPinList(visible, editable, marks) {
            const group = document.getElementById('noteInputGroup');
            let sec = document.getElementById('pickPinsSection');
            if (!visible || !group || !this.isOwner) { sec?.remove(); return; }
            if (!sec) {
                sec = document.createElement('div');
                sec.id = 'pickPinsSection';
                sec.className = 'note-input-group pick-pins-section';
                group.after(sec);
            }
            sec.replaceChildren();
            const label = document.createElement('label');
            label.textContent = '修改標示';
            sec.appendChild(label);
            if (!marks.length) {
                const p = document.createElement('p');
                p.className = 'pick-pins-empty';
                p.textContent = editable ? '尚無標示。按「標示修改」，再點照片上要修改的位置。' : '這張沒有標示。';
                sec.appendChild(p);
                return;
            }
            const key = this._pinPhotoId;
            const ol = document.createElement('ol');
            ol.id = 'pickPinList';
            ol.className = 'pick-pin-list';
            marks.forEach((m, i) => {
                const li = document.createElement('li');
                li.className = 'pick-pin-item';
                const num = document.createElement('span');
                num.className = 'pick-pin-num';
                num.textContent = String(i + 1);
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'pick-pin-note';
                input.maxLength = PIN_NOTE_MAX;
                input.value = m.note;
                input.placeholder = '這裡要修改什麼？例：這裡痘痘';
                input.setAttribute('dir', 'auto');
                input.setAttribute('aria-label', `標示 ${i + 1} 的備註`);
                input.readOnly = !editable;
                const count = document.createElement('span');
                count.className = 'pick-pin-count';
                count.textContent = `${pinLen(m.note)}/${PIN_NOTE_MAX}`;
                input.addEventListener('input', () => {
                    const clean = pinSanitize(input.value);
                    if (clean !== input.value) input.value = clean;
                    count.textContent = `${pinLen(clean)}/${PIN_NOTE_MAX}`;
                    this.setPinNote(key, i, clean);
                });
                li.append(num, input, count);
                if (editable) {
                    const del = document.createElement('button');
                    del.type = 'button';
                    del.className = 'pick-pin-del';
                    del.textContent = '×';
                    del.setAttribute('aria-label', `刪除標示 ${i + 1}`);
                    del.addEventListener('click', () => this.removePin(key, i));
                    li.appendChild(del);
                }
                ol.appendChild(li);
            });
            sec.appendChild(ol);
        },

        // ── pin data (all writes go through queueUpsert, full list each time) ─
        marksOf(key) {
            const s = this.selections.get(key);
            return s && s.rating > 0 && Array.isArray(s.marks)
                ? s.marks.map(m => ({ x: m.x, y: m.y, note: m.note })) : [];
        },

        _saveMarks(key, marks) {
            const s = this.selections.get(key);
            if (!s || !(s.rating > 0)) return;
            this.queueUpsert(key, s.rating, s.note, marks);
        },

        addPin(key, x, y) {
            if (!this.canEdit()) return;
            const cur = this.marksOf(key);
            const s = this.selections.get(key);
            if (!s || !(s.rating > 0)) return;
            if (cur.length >= PIN_MAX) {
                if (typeof toast !== 'undefined') toast.info(`每張照片最多標示 ${PIN_MAX} 個位置`);
                return;
            }
            this._saveMarks(key, cur.concat({ x, y, note: '' }));
            this.syncPinUI();
        },

        setPinNote(key, index, note) {
            if (!this.canEdit()) return;
            const cur = this.marksOf(key);
            if (!cur[index]) return;
            cur[index].note = note;
            this._saveMarks(key, cur);
        },

        removePin(key, index) {
            if (!this.canEdit()) return;
            const cur = this.marksOf(key);
            if (!cur[index]) return;
            cur.splice(index, 1);
            this._saveMarks(key, cur);
            this.syncPinUI();
        },

        _removeAnnotationToolbox() {
            document.querySelector('.tool-buttons')?.remove();
            document.querySelector('.color-picker')?.remove();
            document.querySelector('.slider-group')?.remove();
            document.querySelector('.modal-actions')?.remove();
        },

        // The left 資料夾 panel: every folder this link opens, one click to
        // load it, the current one highlighted — plus, nested under each,
        // every subfolder this link has loaded so far (docs/backlog.md
        // "Guest page hides subfolders"). Lazy: a folder not yet opened has
        // no children on screen until it is (folderChildren). Re-rendered
        // after every load (see _wireHooks) so it survives app.js's own
        // subfolder-tree render, which targets this same container.
        renderFolderPanel() {
            this._renderFolderSelect();
            const container = document.getElementById('folderTreeContainer');
            const list = document.getElementById('folderTree');
            if (!container || !list) return;
            const roots = this.viewFolders();
            if (!roots.length) { container.style.display = 'none'; return; }
            container.style.display = 'block';
            const current = (typeof driveManager !== 'undefined') ? driveManager.currentFolderId : '';
            list.innerHTML = '';
            const frag = document.createDocumentFragment();
            roots.forEach(f => this._appendTreeRow(frag, f, 0, current));
            list.appendChild(frag);
        },

        // One row for `folder`, then recurses into its cached children (if
        // any) one level deeper — the same padding/icon convention app.js's
        // own _buildTreeEl uses for its single-root tree.
        _appendTreeRow(parent, folder, depth, current) {
            const row = document.createElement('div');
            row.className = 'tree-row' + (folder === current ? ' tree-active' : '');
            row.dataset.folder = folder;
            row.style.paddingLeft = (4 + depth * 14) + 'px';
            const icon = document.createElement('span');
            icon.className = 'tree-icon';
            icon.textContent = depth === 0 ? '🗂' : '📁';
            const label = document.createElement('span');
            label.className = 'tree-label';
            label.textContent = folder.replace(/\/$/, '').split('/').pop() || folder;
            label.title = folder;
            row.appendChild(icon);
            row.appendChild(label);
            row.addEventListener('click', () => this.app.handleLoadPhotos(folder));
            parent.appendChild(row);
            (this.folderChildren.get(folder) || [])
                .forEach(child => this._appendTreeRow(parent, child.id, depth + 1, current));
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
                const loadedPath = driveManager.currentFolderId;
                this.folderChildren.set(loadedPath, app.currentFolders.slice());
                // Rule 2 (docs/backlog.md): a folder with no photos of its
                // own but with subfolders opens its first subfolder
                // automatically — including the initial load (loadGrid
                // already calls this same wrapped method). Recurses until a
                // folder with photos, or a true leaf (no photos, no
                // subfolders) is reached.
                const first = app.currentFolders[0] && app.currentFolders[0].id;
                if (app.currentFolders.length > 0 && app.photos.length === 0 &&
                    first && first !== loadedPath) {
                    await app.handleLoadPhotos(first);
                    return;
                }
                this.applyServerSelections();
                this.renderFolderPanel();
            };
        },

        // ── banner: "someone else is picking" / phase notices ──────────────
        renderBanner() {
            const el = document.getElementById('pickBanner');
            const linesEl = document.getElementById('pickBannerLines');
            const hintEl = document.getElementById('pickBannerHint');
            const hintTextEl = document.getElementById('pickBannerHintText');
            if (!el || !linesEl) return;
            // the delivery gallery has its own bar; picking notices don't apply
            if (this.mode === 'delivered') { el.hidden = true; return; }

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

        // ── counter: the one pick counter, bottom-left ───────────────────────
        // "已選 N / limit 張" (no limit: "已選 N 張"). It lives in the bottom
        // bar (#mobileActionBar's status), which replaces that bar's generic
        // "已選取 0 張" — that one counts bulk-selected cards, never picks.
        // Over the limit it only changes colour (.over): no message while
        // picking; the warning is the modal at submit (requestSubmit).
        renderCounter() {
            const badgeEl = document.getElementById('pickFilterSelectedCount');
            if (badgeEl) badgeEl.textContent = String(this._selectedCount());

            const bar = document.getElementById('mobileActionBar');
            const status = document.getElementById('mobileActionStatus');
            if (!bar || !status || this.isGallery()) return;
            document.body.classList.add('pick-active');
            // a viewer (no seat) picks nothing: no counter, no submit
            bar.classList.toggle('pick-bar-off', !this.isOwner);
            if (!this.isOwner) return;

            let el = document.getElementById('pickCounter');
            if (!el) {
                el = document.createElement('span');
                el.id = 'pickCounter';
                el.className = 'pick-counter';
                status.replaceChildren(el);
            }
            const count = this._selectedCount();
            const limit = this.pickLimit;
            el.textContent = limit == null ? `已選 ${count} 張` : `已選 ${count} / ${limit} 張`;
            el.classList.toggle('over', limit != null && count > limit);
        },

        // How many picks exceed the plan (0 when there is no limit).
        overCount() {
            const limit = this.pickLimit;
            return limit == null ? 0 : Math.max(0, this._selectedCount() - limit);
        },

        _fmtMoney(n) {
            return Number(n).toLocaleString('en-US');
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

        // ── submit: over the limit, warn first (never block) ─────────────────
        // The over-limit modal comes first; 確認送出 there opens the ordinary
        // submit form (relationship / email), so that step is unchanged.
        requestSubmit() {
            if (this.overCount() > 0) this.openOverModal();
            else this.openSubmitModal();
        },
        openOverModal() {
            const modal = document.getElementById('pickOverModal');
            const body = document.getElementById('pickOverBody');
            if (!modal || !body) { this.openSubmitModal(); return; }
            const limit = this.pickLimit;
            const n = this._selectedCount();
            const over = this.overCount();
            const lines = [`方案 ${limit} 張，目前已選 ${n} 張，超出 ${over} 張`];
            const price = this.extraPrice;
            if (price != null && Number(price) > 0) {
                const p = this._fmtMoney(price);
                lines.push(`加挑每張 NT$${p}，加價 NT$${p} × ${over} = NT$${this._fmtMoney(price * over)}`);
            }
            body.replaceChildren(...lines.map((t, i) => {
                const p = document.createElement('p');
                p.className = i === 0 ? 'pick-over-line' : 'pick-over-price';
                p.textContent = t;
                return p;
            }));
            modal.classList.add('active');
        },
        closeOverModal() {
            document.getElementById('pickOverModal')?.classList.remove('active');
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
            document.getElementById('pickOverBackBtn')?.addEventListener('click', () => this.closeOverModal());
            document.getElementById('pickOverConfirmBtn')?.addEventListener('click', () => {
                this.closeOverModal();
                this.openSubmitModal();
            });
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
