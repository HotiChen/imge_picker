// Photographer project view — admin.html → index.html?project=<id>.
//
// The photographer clicking through from a guest-picking project's admin
// detail page (heading or a photo row) rather than typing a folder path.
// Shows only that project's selected photos (rating > 0), across every
// folder the project spans, without opening each folder in turn to find
// them — the same "reach across folders from just the keys" trick
// PickController's own 已選 filter already uses (js/pick.js _photoFromKey).
//
// Admin-only: there is no guest entry point for `?project=`. It reuses
// whatever admin credential is already on the page — CONFIG.PHOTOGRAPHER_TOKEN,
// restored from sessionStorage by js/client-auth-check.js before this runs,
// exactly the way an ordinary photographer visit already works — rather than
// inventing a second login path.
(function () {
    const params = new URLSearchParams(window.location.search);
    const projectId = params.get('project') || '';
    // The one photo to open straight into preview — admin.html's per-row
    // link — same key format as a normal photo id (js/drive.js).
    const photoKey = params.get('photo') || '';

    const ProjectViewController = {
        active: !!projectId,
        projectId,
        photoKey,
        app: null,
        photos: [],
        projectTitle: '',
        // 'picks' (the client's picks, the default) or 'all' (every proof in the
        // project's folders, read-only). ?mode=all opens straight into the second.
        mode: params.get('mode') === 'all' ? 'all' : 'picks',
        proofFolders: [],
        allPhotos: null,        // every proof, once listed (null = not loaded yet)
        _selByKey: new Map(),   // photo_key -> the client's selection row
        ownerName: null,
        tokens: [],

        async start(app) {
            this.app = app;
            this._trimSidebar();
            this._trimHeader();
            this._trimBulkBar();
            this._trimModal();
            this._wireViewToggle();
            this._wireDownloads();
            this._wireCopyLinkBtn();
            this._buildModeToggle();
            const admin = (typeof CONFIG !== 'undefined' && CONFIG.PHOTOGRAPHER_TOKEN) || '';
            if (!admin) {
                // Not a second login path: js/client-auth-check.js already
                // owns "no credential yet" (its studio/client choice
                // overlay). This is only the fallback for the unlikely case
                // that somehow let us through anyway.
                this._showFatalError('請先以攝影師身分登入');
                return;
            }
            // The listing/admin fetch below carries the credential in a
            // header; the <img> tiles the grid is about to render cannot,
            // so the same URL-carryable token every studio tile uses has to
            // be minted first (js/drive.js loadPhotosFromFolder does the
            // same thing before its own listing call).
            if (window.StudioToken) await window.StudioToken.ensure();

            let res;
            try {
                res = await fetch(
                    `${CONFIG.WORKER_URL}/api/admin/projects/${encodeURIComponent(this.projectId)}`,
                    { headers: { 'Authorization': `Bearer ${admin}` } }
                );
            } catch (e) {
                this._showFatalError('無法連線到 Worker');
                return;
            }
            if (!res.ok) {
                this._showFatalError(res.status === 404 ? '找不到這個專案' : `讀取失敗（${res.status}）`);
                return;
            }
            const data = await res.json().catch(() => ({}));
            this._applyState(data);
            this.renderBanner();
            this.renderRevisions(data.revision_requests);
            if (this.mode === 'all') { await this._ensureAllLoaded(); this.renderBanner(); }
            this.loadGrid();
        },

        // ── 客人選的 / 全部毛片 ────────────────────────────────────────────────
        // The picks view is the default. 全部毛片 lists every photo in the
        // project's proof folders (and the subfolders under them) with the same
        // listing route and credential a studio folder view uses — no new route.
        // Read-only: nothing here writes. A picked photo keeps its ♥ / 💬 / 📍
        // flags; the rest show none.
        currentPhotos() {
            return this.mode === 'all' && this.allPhotos ? this.allPhotos : this.photos;
        },

        _buildModeToggle() {
            const banner = document.getElementById('projectViewBanner');
            if (!banner || document.getElementById('pvModeToggle')) return;
            const wrap = document.createElement('div');
            wrap.id = 'pvModeToggle';
            wrap.className = 'pv-mode-toggle';
            wrap.setAttribute('role', 'group');
            wrap.setAttribute('aria-label', '顯示範圍');
            [['picks', '客人選的'], ['all', '全部毛片']].forEach(([mode, label]) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'btn btn-outline pv-banner-btn pv-mode-btn';
                b.dataset.pvMode = mode;
                b.textContent = label;
                b.addEventListener('click', () => this.setMode(mode));
                wrap.appendChild(b);
            });
            const text = document.getElementById('pvBannerText');
            banner.insertBefore(wrap, text || null);
            this._syncModeToggle();
        },

        _syncModeToggle() {
            document.querySelectorAll('#pvModeToggle [data-pv-mode]').forEach(b => {
                const on = b.dataset.pvMode === this.mode;
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
                b.classList.toggle('on', on);
            });
        },

        async setMode(mode) {
            if (mode !== 'picks' && mode !== 'all') return;
            if (mode === this.mode) return;
            this.mode = mode;
            this._syncModeToggle();
            try {
                const u = new URL(location.href);
                if (mode === 'all') u.searchParams.set('mode', 'all'); else u.searchParams.delete('mode');
                history.replaceState(history.state, '', u.pathname + u.search + u.hash);
            } catch (e) { /* the address is a convenience only */ }
            if (mode === 'all') await this._ensureAllLoaded();
            if (this.mode !== mode) return;   // toggled again while listing
            this.renderBanner();
            this.loadGrid();
        },

        async _ensureAllLoaded() {
            if (this.allPhotos) return;
            const textEl = document.getElementById('pvBannerText');
            if (textEl) textEl.textContent = '載入全部毛片中…';
            try {
                this.allPhotos = await this._listAllProofs();
                this.allError = false;
            } catch (e) {
                this.allPhotos = [];
                this.allError = true;
                if (typeof toast !== 'undefined') toast.error('無法讀取毛片資料夾');
            }
        },

        // Every file under the project's folders: the same `?list=` call
        // driveManager.loadPhotosFromFolder makes (same headers), repeated into the
        // subfolders (photos can sit one or two levels down, docs/backlog.md),
        // without touching driveManager's own state.
        async _listAllProofs() {
            const seen = new Map();
            const walk = async (prefix, depth) => {
                const res = await fetch(`${CONFIG.WORKER_URL}/?list=${encodeURIComponent(prefix)}`,
                    { headers: driveManager._authHeaders() });
                const r = await res.json().catch(() => null);
                if (!res.ok || !r || r.status !== 'success') throw new Error('list failed');
                (r.data || []).forEach(f => {
                    if (!f || !f.id || seen.has(f.id)) return;
                    const sel = this._selByKey.get(f.id);
                    seen.set(f.id, {
                        id: f.id,
                        name: f.name || f.id.split('/').pop(),
                        size: f.size,
                        uploaded: f.uploaded || null,
                        rating: sel ? sel.rating : 0,
                        note: sel ? sel.note : '',
                        updatedAt: sel ? sel.updatedAt : null,
                        hasAnnotations: false,
                        marks: sel ? sel.marks : [],
                    });
                });
                if (depth < 3) await Promise.all((r.folders || []).map(f => walk(f, depth + 1)));
            };
            for (const f of this.proofFolders) await walk(f.endsWith('/') ? f : f + '/', 0);
            return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
        },

        _applyState(data) {
            this.ownerName = data.owner ? data.owner.name : null;
            this.projectTitle = data.project && data.project.title ? String(data.project.title) : '';
            // GET /api/admin/projects/:id already returns these newest-first
            // (worker.js: ORDER BY created_at DESC), each with a computed
            // status — so the first 'live' one found here is the newest live
            // link (task: 專案選片 — 複製選片連結).
            this.tokens = Array.isArray(data.tokens) ? data.tokens : [];
            this.proofFolders = data.project && Array.isArray(data.project.folders)
                ? data.project.folders.filter(f => typeof f === 'string' && f) : [];
            this._selByKey = new Map((data.selections || []).map(s => [s.photo_key, {
                rating: s.rating, note: s.note || '', updatedAt: s.updated_at || null,
                marks: window.cleanPinMarks(s.marks),
            }]));
            this.photos = (data.selections || [])
                .filter(s => s.rating > 0)
                .map(s => ({
                    id: s.photo_key,
                    name: s.photo_key.split('/').pop() || s.photo_key,
                    rating: s.rating,
                    note: s.note || '',
                    uploaded: null,
                    // list mode's "updated time" column (task: 專案選片 grid/list)
                    updatedAt: s.updated_at || null,
                    hasAnnotations: false,
                    // the guest's retouch pins (docs/guest-picking.md); null
                    // before the D1 migration ran = none
                    marks: window.cleanPinMarks(s.marks),
                }));
        },

        // Preview: the guest's pins are drawn over the photo by
        // annotationManager (read-only, following zoom/pan); this lists their
        // notes beside/below it — 「① 這裡痘痘」. A note is guest text: textContent
        // only, isolated (dir=auto + unicode-bidi: isolate in CSS) so bidi
        // characters cannot reorder anything around it.
        //
        // The list is NOT drawn over the photo: it is a section of the modal's
        // side column (#modalSidebar) — beside the photo on a desktop, below it
        // on a phone (css/styles.css body.pv-active) — so the photo stays the
        // main thing and the retouch requests are metadata next to it. With
        // neither pins nor a note there is nothing to put there, so the whole
        // column is dropped for that photo rather than left as an empty shell.
        syncPinUI(photo) {
            const sidebar = document.getElementById('modalSidebar');
            if (!sidebar) return;
            document.getElementById('pvPinSection')?.remove();
            const marks = photo && Array.isArray(photo.marks) ? photo.marks : [];
            const hasNote = !!(photo && photo.note);
            // the read-only note of this photo (js/app.js openModal fills it)
            const noteGroup = document.getElementById('noteInputGroup');
            if (noteGroup) noteGroup.hidden = !hasNote;
            const tools = sidebar.querySelector('.annotation-tools');
            if (tools) tools.hidden = !hasNote;
            sidebar.classList.toggle('hidden', !marks.length && !hasNote);
            if (!marks.length) return;
            const section = document.createElement('section');
            section.id = 'pvPinSection';
            section.className = 'pv-pin-section';
            const head = document.createElement('h4');
            head.textContent = `客戶標示 · ${marks.length} 處`;
            const list = document.createElement('ol');
            list.id = 'pvPinList';
            list.className = 'pv-pin-list';
            marks.forEach((m, i) => {
                const li = document.createElement('li');
                const num = document.createElement('span');
                num.className = 'pv-pin-num';
                num.textContent = '①②③④⑤⑥⑦⑧⑨⑩'[i] || String(i + 1);
                const text = document.createElement('span');
                text.className = 'pv-pin-text';
                text.setAttribute('dir', 'auto');
                text.textContent = m.note || '（無備註）';
                li.append(num, text);
                list.appendChild(li);
            });
            section.append(head, list);
            sidebar.appendChild(section);
        },

        // ── preview modal trim: this is a review, not a pick ────────────────
        // The client's drawing tools (select/pan/circle/eraser/undo/redo,
        // colours, brush size, 清除全部) and the orange #mobileToolsToggle that
        // opens them have no job here — and the toggle covered the ♥ on a
        // phone. Removed outright, not hidden (.btn/.tool-btn carry
        // display:inline-flex, which beats [hidden]; same reason as
        // _trimSidebar and js/pick.js _setupGuestModal). What stays: the
        // read-only note textarea (#noteInputGroup, shown only when the
        // photo has a note — see syncPinUI) and the pins list. body.pv-active
        // switches on the side-column layout in css/styles.css.
        _trimModal() {
            document.body.classList.add('pv-active');
            document.getElementById('mobileToolsToggle')?.remove();
            ['.sidebar-header-mobile', '.annotation-tools > h4', '.tool-buttons',
                '.color-picker', '.slider-group', '.modal-actions']
                .forEach(sel => document.querySelector(sel)?.remove());
            // what is left of the note box is read-only text from the client
            const label = document.querySelector('#noteInputGroup label');
            if (label) label.textContent = '客戶備註';
            document.querySelector('#noteInputGroup small')?.remove();
        },

        // ── sidebar trim: this view is read-only and has no one folder ──────
        // (task: 專案選片). Removed outright, not hidden — .btn/.toggle-btn
        // carry display:inline-flex/flex, which beats the UA's [hidden]
        // { display: none }, the same reason js/pick.js removes rather than
        // hides its own studio-only controls.
        //
        // Only 01 / SOURCE stays. Everything after it is a studio tool with no
        // job when reviewing someone's picks: 02 / RATING (every card here is
        // already a pick, and no control may re-rate one) with 清除 and the
        // 只看選取 button, 03 / FLAGS (placeholder), 04 / ANNOTATION with the
        // 排序 select (the order is the default, by name), 05 / DATA (匯出備份
        // JSON / 清除所有快取 act on this browser's cache, not on the project;
        // 重設此資料夾 would wipe someone else's picks). Whole sections go, so no
        // heading or divider is left over. app.js reaches those nodes only
        // through addListener (a no-op for a missing id) or querySelectorAll
        // (an empty list), and updateStats() null-checks every counter.
        _trimSidebar() {
            // 01/SOURCE — nothing to type a path into; every photo already
            // comes from the project's own picks (this.photos), across every
            // folder it spans.
            document.querySelector('.sidebar-section:first-child .input-group')?.remove();
            document.querySelectorAll('aside.sidebar > .sidebar-section:not(:first-child)')
                .forEach(sec => sec.remove());
            // What is left of the sidebar is the SOURCE title alone, so the
            // ☰ that opens it as a drawer on a phone (<= 1024px) would open
            // an empty drawer: no button, no backdrop. A desktop shows the
            // sidebar as a column and never used the button.
            document.getElementById('sidebarToggle')?.remove();
            document.getElementById('sidebarBackdrop')?.remove();
        },

        // ── top bar trim: 預約拍攝 / 上傳 / 相本書 are studio links ────────────
        // 預約拍攝 is the guest page's own link (filled by js/pick.js, never in
        // this view), 上傳 and 相本書 lead away from a review. Removed, not
        // hidden, for the same display:inline-flex reason as above. app.js binds
        // 上傳 / 相本書 with addListener, which skips a missing id.
        _trimHeader() {
            ['studioBookingLink', 'uploadPageBtn', 'openBookEditorBtn']
                .forEach(id => document.getElementById(id)?.remove());
        },

        // The bulk-action bar's own star buttons + 清空評分 write ratings —
        // app.js's setBulkRating() also refuses outright while this view is
        // active (belt and suspenders), but removing the controls too keeps
        // the bar honest about what it can do here. 下載選取/取消選取 stay.
        _trimBulkBar() {
            document.getElementById('bulkStars')?.remove();
            document.querySelector('#bulkActionBar button[onclick="app.setBulkRating(0)"]')?.remove();
        },

        // ── downloads: 打包全部下載 / 下載選取 (task: 專案選片) ───────────────
        // driveManager.photos stays empty here — loadPhotosFromFolder is never
        // called for a project view — so both buttons are pointed at this
        // project's own picks (this.photos) instead, across every folder.
        // Simplest correct 下載選取: this view already shows nothing but
        // picks and has no selection control any more (the checkbox is gone,
        // see js/app.js createPhotoCard), so there is no meaningful subset to
        // carve out — 下載選取 downloads exactly what 打包全部下載 does.
        //
        // The zip is named <project title>_選片_<N>張.zip (N = photos in it), not
        // after the internal id. Because 下載選取 is the same thing as 打包全部下載
        // here, its buttons are hidden in this view (body.pv-active, css/styles.css)
        // — the markup and the hook below stay, so it can come back.
        _wireDownloads() {
            const self = this;
            const zipName = () => {
                const list = self.currentPhotos();
                return `${driveManager.sanitizeFileTitle(self.projectTitle)}_${self.mode === 'all' ? '毛片' : '選片'}_${list.length}張.zip`;
            };
            driveManager.downloadAllPhotos = function () {
                return this.downloadPhotos(self.currentPhotos(), zipName());
            };
            this.app.downloadSelected = function () {
                return driveManager.downloadPhotos(self.currentPhotos(), zipName());
            };
        },

        // ── grid/list toggle (task: 專案選片) ────────────────────────────────
        // Reuses the header's existing (until now decorative) 網格 button.
        // Other modes are untouched: this listener/override only exists once
        // ProjectViewController.start() runs, i.e. only in this view.
        _wireViewToggle() {
            this.viewMode = this._loadViewMode();
            const btn = document.getElementById('headerViewBtn');
            this._applyViewBtn(btn);
            if (btn) btn.addEventListener('click', () => this._toggleViewMode(btn));

            const origRender = this.app.renderPhotoGrid.bind(this.app);
            this.app.renderPhotoGrid = () => {
                const grid = document.getElementById('photoGrid');
                if (grid) grid.classList.toggle('pv-list', this.viewMode === 'list');
                if (this.viewMode === 'list') this._renderListView();
                else origRender();
            };
        },

        _toggleViewMode(btn) {
            this.viewMode = this.viewMode === 'list' ? 'grid' : 'list';
            this._saveViewMode(this.viewMode);
            this._applyViewBtn(btn);
            this.app.renderPhotoGrid();
        },

        _applyViewBtn(btn) {
            if (btn) btn.textContent = this.viewMode === 'list' ? '列表' : '網格';
        },

        // Remembered per browser (task: 專案選片) — best-effort, never load
        // bearing: a private window or blocked site data just falls back to
        // the grid default.
        _loadViewMode() {
            try { return localStorage.getItem('pv_view_mode') === 'list' ? 'list' : 'grid'; }
            catch (e) { return 'grid'; }
        },
        _saveViewMode(mode) {
            try { localStorage.setItem('pv_view_mode', mode); } catch (e) { /* best effort */ }
        },

        _renderListView() {
            const grid = document.getElementById('photoGrid');
            const empty = document.getElementById('emptyState');
            if (!grid) return;
            grid.innerHTML = '';
            const photos = this.app.filteredPhotos;
            if (!photos.length) {
                if (empty) empty.style.display = 'flex';
                return;
            }
            if (empty) empty.style.display = 'none';
            const frag = document.createDocumentFragment();
            photos.forEach((photo, index) => frag.appendChild(this._createListRow(photo, index)));
            grid.appendChild(frag);
        },

        // One row: small thumbnail, filename, note, updated time. Clicking
        // anywhere on the row opens the same preview a grid card would.
        _createListRow(photo, index) {
            const row = document.createElement('div');
            row.className = 'pv-list-row';
            row.dataset.photoId = photo.id;
            const thumbUrl = driveManager.getImageUrl(photo, 100);
            row.innerHTML = `
                <img src="${escHtml(thumbUrl)}" class="pv-list-thumb" loading="lazy" decoding="async" alt="">
                <span class="pv-list-name">${escHtml(photo.name)}</span>
                <span class="pv-list-note">${escHtml(photo.note || '')}</span>
                <span class="pv-list-time">${escHtml(this._fmtTime(photo.updatedAt))}</span>
            `;
            row.addEventListener('click', () => this.app.openModal(index));
            return row;
        },

        // The Taipei "9/27 22:52" format, shared with admin.html (js/util.js).
        _fmtTime(iso) {
            return Util.fmtDate(iso, 'mdhm');
        },

        // The owner's name is guest-supplied — textContent only, never
        // innerHTML, the same rule js/pick.js follows for its own banner.
        renderBanner() {
            const el = document.getElementById('projectViewBanner');
            if (!el) return;
            const textEl = document.getElementById('pvBannerText');
            const link = document.getElementById('pvBackLink');
            if (textEl) {
                textEl.textContent = this.mode === 'all' && this.allPhotos
                    ? `全部毛片 · ${this.allPhotos.length} 張（客人選了 ${this.photos.length} 張）`
                    : `${this.ownerName || '（尚無人認領）'} 的選片 · ${this.photos.length} 張`;
            }
            if (link) link.href = `admin.html#project=${encodeURIComponent(this.projectId)}`;
            el.hidden = false;
        },

        // ── 修改標示 (docs/revision-pins.md 6.2): the client's pins on the delivered finals ──
        // One card per pins round (newest first), the same cards admin.html shows
        // (js/revision-rounds-view.js): the note, open / handled, and the photos with
        // read-only pins so the photographer sees where to retouch. Text rounds have no
        // photos and stay in admin.html. No pins round, no section at all. Nothing here
        // writes; the photos are read with the admin credential in a header.
        renderRevisions(rows) {
            document.getElementById('pvRevisions')?.remove();
            const view = window.RevisionRoundsView;
            const all = Array.isArray(rows) ? rows : [];
            if (!view || !window.PinLayer || !all.some(r => view.kindOf(r) === 'pins')) return;
            const banner = document.getElementById('projectViewBanner');
            if (!banner) return;
            const section = document.createElement('section');
            section.id = 'pvRevisions';
            const head = document.createElement('h3');
            head.textContent = '客人在精修照片上的修改標示';
            section.appendChild(head);
            const ctx = {
                workerUrl: CONFIG.WORKER_URL,
                token: () => (typeof CONFIG !== 'undefined' && CONFIG.PHOTOGRAPHER_TOKEN) || '',
                fmtTime: iso => Util.fmtDate(iso, 'mdhm') || String(iso || ''),
            };
            // the rows are newest first: the oldest round is 第 1 輪, text rounds count too
            all.forEach((r, i) => { if (view.kindOf(r) === 'pins') section.appendChild(view.renderRound(r, all.length - i, ctx)); });
            banner.after(section);
        },

        // ── 複製選片連結 (task: 專案選片) — shares the project's own pick
        // link, never a folder path. The click handler needs nothing from
        // the fetch yet, so it can be wired up front, before this.tokens is
        // even populated.
        _wireCopyLinkBtn() {
            const btn = document.getElementById('pvCopyLinkBtn');
            if (btn) btn.addEventListener('click', () => this._copyPickLink());
        },

        async _copyPickLink() {
            const live = this.tokens.find(t => t.status === 'live');
            if (!live) {
                if (typeof toast !== 'undefined') toast.warning('沒有有效連結，請到專案頁產生');
                return;
            }
            try {
                await navigator.clipboard.writeText(this._projectLink(live.token));
                if (typeof toast !== 'undefined') toast.success('已複製選片連結');
            } catch (e) {
                if (typeof toast !== 'undefined') toast.error('複製失敗，請手動複製');
            }
        },

        // The same shape as admin.html's own projectLink(token) — index.html
        // sits beside admin.html, and the pick page needs nothing but ?t=.
        _projectLink(token) {
            const base = location.href.split('#')[0].split('?')[0];
            return `${base}?t=${encodeURIComponent(token)}`;
        },

        loadGrid() {
            const list = this.currentPhotos();
            const h2 = document.querySelector('#emptyState h2');
            const p = document.querySelector('#emptyState p');
            if (this.mode === 'all') {
                if (h2) h2.textContent = this.allError ? '無法讀取毛片' : '沒有毛片';
                if (p) p.textContent = this.allError ? '毛片資料夾暫時讀不到，請稍後再試' : '這個專案的毛片資料夾裡還沒有照片';
            } else if (!this.photos.length) {
                if (h2) h2.textContent = '尚無選取的照片';
                if (p) p.textContent = '這個專案目前還沒有人選片';
            }
            this.app.photos = list;
            this.app.currentFolders = [];
            this.app.applyFilters();
            this.app.renderPhotoGrid();
            this.app.updateStats();

            if (this.photoKey) {
                const idx = this.app.filteredPhotos.findIndex(p => p.id === this.photoKey);
                if (idx >= 0) this.app.openModal(idx);
            }
        },

        _showFatalError(msg) {
            const empty = document.getElementById('emptyState');
            const loading = document.getElementById('loadingState');
            if (loading) loading.style.display = 'none';
            if (!empty) return;
            const h2 = empty.querySelector('h2');
            const p = empty.querySelector('p');
            if (h2) h2.textContent = '無法開啟選片';
            if (p) p.textContent = msg;
            empty.style.display = 'flex';
        },
    };

    window.ProjectViewController = ProjectViewController;
})();
