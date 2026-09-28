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
            if (!this._pendingPrev.has(photoKey)) {
                const prev = this.selections.get(photoKey);
                this._pendingPrev.set(photoKey, prev ? { ...prev } : null);
            }
            this._pendingDelete.delete(photoKey);
            this._pendingUpsert.set(photoKey, { photo_key: photoKey, rating, note: note || '' });
            this.selections.set(photoKey, { rating, note: note || '' });
            this.renderCounter();
            // 'all' shows the current folder regardless of what is picked, so
            // it never needs a repaint here; 已選/未選 depend on the rating
            // that just changed, both in and out of the current folder.
            if (this.filterMode !== 'all') this.rerenderGrid();
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
            // The ♥ count itself never depends on filterMode, but this keeps
            // the header/mobile-bar counters explicitly current on every
            // filter switch rather than relying on that being incidental.
            this.renderCounter();
        },

        // ── lifecycle ─────────────────────────────────────────────────────
        async start(app) {
            this.app = app;
            if (typeof CONFIG !== 'undefined') CONFIG.SHARE_TOKEN = this.token;
            this._hideStudioOnlyUI();
            this._removeSourceControls();
            this._removeAnnotationToolbox();
            this._replaceFilterBar();
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
            this._updateSubmitButton();
            // Before anything else can run (including the claim overlay
            // below), so a fresh viewer never sees a flash of the mobile
            // bar's old bulk-select content forced on by the !important
            // rule in css/styles.css.
            this.renderCounter();

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
            this.studio = data.studio || null;
        },

        // Header branding for a guest pick link (docs/dashboard-settings.md):
        // GET /api/pick/state's studio.{name, has_logo}. Every value here is
        // guest-untrusted server data — name/alt go through textContent, the
        // logo is loaded by property assignment (never built into an HTML
        // string). booking_url no longer renders here — see renderBanner,
        // which shows 📅 預約拍攝 only once the guest has actually submitted.
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

        _updateSubmitButton() {
            const btn = document.getElementById('submitJobBtn');
            if (btn) btn.style.display = this.isOwner ? 'inline-flex' : 'none';
            // Drives the mobile bar's owner/viewer gating too (css/styles.css,
            // the 1024px media query) — this is the one place isOwner ever
            // changes (start(), afterClaim()), so it is the right choke point.
            document.body.classList.toggle('pick-active', this.active);
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
            ['uploadPageBtn', 'openBookEditorBtn'].forEach(id => document.getElementById(id)?.remove());
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
            const container = document.getElementById('folderTreeContainer');
            const list = document.getElementById('folderTree');
            if (!container || !list) return;
            if (!this.folders.length) { container.style.display = 'none'; return; }
            container.style.display = 'block';
            const current = (typeof driveManager !== 'undefined') ? driveManager.currentFolderId : '';
            list.innerHTML = '';
            const frag = document.createDocumentFragment();
            this.folders.forEach(f => this._appendTreeRow(frag, f, 0, current));
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
            const bookingWrap = document.getElementById('pickBannerBooking');
            const bookingLink = document.getElementById('studioBookingLink');
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

            // 預約拍攝 — moved out of the header (docs/dashboard-settings.md):
            // shown only once the seat holder has actually submitted (this
            // also covers reloading the page after submitting, since phase
            // is server state, not a one-time event), and only for an https
            // booking_url. Same safety rules as before: href set only when
            // it starts with https://, by property, never left to fall
            // through and get set anyway.
            if (bookingWrap && bookingLink) {
                const studio = this.studio;
                const showBooking = this.isOwner && this.phase === 'submitted' && !!studio &&
                    typeof studio.booking_url === 'string' && studio.booking_url.startsWith('https://');
                if (showBooking) bookingLink.href = studio.booking_url;
                bookingWrap.hidden = !showBooking;
            }

            el.hidden = lines.length === 0 && !showHint;
        },

        // Shared by the header counter and the mobile bar's counter — numbers
        // only, no warning sentence (that moved to openSubmitModal, at submit
        // time, per the product owner's call: docs/guest-picking.md).
        _counterText(count, limit) {
            return limit == null ? `已選 ${count} 張` : `已選 ${count} / ${limit}`;
        },

        // ── counter: "已選 N / limit" ─────────────────────────────────────
        renderCounter() {
            const badgeEl = document.getElementById('pickFilterSelectedCount');
            if (badgeEl) badgeEl.textContent = String(this._selectedCount());

            const el = document.getElementById('pickCounter');
            const mainEl = document.getElementById('pickCounterMain');
            if (el && mainEl) {
                if (!this.isOwner) {
                    el.hidden = true;
                } else {
                    const count = this._selectedCount();
                    const limit = this.pickLimit;
                    mainEl.textContent = this._counterText(count, limit);
                    el.classList.toggle('over', limit != null && count > limit);
                    el.hidden = false;
                }
            }
            this._updateMobileBar();
        },

        // ── mobile bottom bar: reuses #mobileActionBar (js/app.js's own
        // bulk-select bar) for pick mode, on the mobile layout only. Owner
        // sees the same ♥ count as the header, red when over the limit, and
        // the existing 完成提交 button (already routed through
        // app.submitJob() → PickController). A viewer sees no bar at all —
        // css/styles.css's #mobileActionBar.pick-mobile-hidden is what
        // actually wins the specificity fight against the forced `display:
        // flex !important` in the 1024px media query. ─────────────────────
        _updateMobileBar() {
            const bar = document.getElementById('mobileActionBar');
            if (!bar) return;
            const status = document.getElementById('mobileActionStatus');
            if (status) status.hidden = true;
            bar.classList.toggle('pick-mobile-hidden', !this.isOwner);
            const counterEl = document.getElementById('pickMobileCounter');
            if (!counterEl) return;
            if (!this.isOwner) { counterEl.hidden = true; return; }
            const count = this._selectedCount();
            const limit = this.pickLimit;
            counterEl.textContent = this._counterText(count, limit);
            counterEl.classList.toggle('over', limit != null && count > limit);
            counterEl.hidden = false;
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
            this._renderSubmitOverInfo();
            modal.classList.add('active');
        },

        // The over-limit warning, moved here from the header counter (the
        // product owner's call): recomputed fresh every time the modal
        // opens, so going back to change picks and reopening always shows
        // the current numbers. Text is entirely built from server-given
        // numbers (count/limit/extraPrice), never guest input.
        _renderSubmitOverInfo() {
            const overEl = document.getElementById('pickSubmitOverInfo');
            if (!overEl) return;
            const count = this._selectedCount();
            const limit = this.pickLimit;
            const over = limit == null ? 0 : Math.max(0, count - limit);
            if (over <= 0) {
                overEl.textContent = '';
                overEl.hidden = true;
                return;
            }
            let msg = `方案 ${limit} 張，您選了 ${count} 張，多 ${over} 張`;
            msg += this.extraPrice != null
                ? `，加挑費用 ${over} × NT$${this.extraPrice} = NT$${over * this.extraPrice}`
                : '，加挑費用請與攝影師確認';
            overEl.textContent = msg;
            overEl.hidden = false;
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
