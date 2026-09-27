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
        ownerName: null,

        async start(app) {
            this.app = app;
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
            this.loadGrid();
        },

        _applyState(data) {
            this.ownerName = data.owner ? data.owner.name : null;
            this.photos = (data.selections || [])
                .filter(s => s.rating > 0)
                .map(s => ({
                    id: s.photo_key,
                    name: s.photo_key.split('/').pop() || s.photo_key,
                    rating: s.rating,
                    note: s.note || '',
                    uploaded: null,
                    hasAnnotations: false,
                }));
        },

        // The owner's name is guest-supplied — textContent only, never
        // innerHTML, the same rule js/pick.js follows for its own banner.
        renderBanner() {
            const el = document.getElementById('projectViewBanner');
            if (!el) return;
            const textEl = document.getElementById('pvBannerText');
            const link = document.getElementById('pvBackLink');
            if (textEl) textEl.textContent = `${this.ownerName || '（尚無人認領）'} 的選片 · ${this.photos.length} 張`;
            if (link) link.href = `admin.html#project=${encodeURIComponent(this.projectId)}`;
            el.hidden = false;
        },

        loadGrid() {
            if (!this.photos.length) {
                const h2 = document.querySelector('#emptyState h2');
                const p = document.querySelector('#emptyState p');
                if (h2) h2.textContent = '尚無選取的照片';
                if (p) p.textContent = '這個專案目前還沒有人選片';
            }
            this.app.photos = this.photos;
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
