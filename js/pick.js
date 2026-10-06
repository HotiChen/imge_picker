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
    // css/styles.css hides the photographer's 登出 / avatar under this class
    if (token) document.documentElement.classList.add('guest-mode');

    // Retouch pins (docs/guest-picking.md "Retouch pins — the save contract").
    const SHOP_TIMEOUT_MS = 8000;   // the 完成頁's shop read
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
        extraMax: null,   // ♥ allowed above pickLimit (null = no plan cap)
        maxPicks: null,   // pickLimit + extraMax from the server (null = no plan cap)
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
        // Client confirmation (docs/delivery.md), from GET /api/pick/state:
        // null / false / null outside the delivered mode.
        confirmedAt: null,
        revisionOpen: false,
        revisionMessage: null,
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
        // GET /api/pick/shop (docs/guest-shop.md): what the 完成頁 may offer. Information only; a slow
        // Worker is given up on after SHOP_TIMEOUT_MS (the page behind it must not wait for it).
        fetchShop() {
            const ctl = typeof AbortController === 'function' ? new AbortController() : null;
            const timer = ctl ? setTimeout(() => ctl.abort(), SHOP_TIMEOUT_MS) : 0;
            return this._json('/api/pick/shop', { headers: this.headers(), signal: ctl ? ctl.signal : undefined })
                .finally(() => clearTimeout(timer));
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

        confirmDelivery() {
            return this._json('/api/pick/confirm', {
                method: 'POST',
                headers: this.headers({ 'Content-Type': 'application/json' }),
                body: '{}',
            });
        },
        requestRevision(message) {
            return this._json('/api/pick/revision', {
                method: 'POST',
                headers: this.headers({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ message }),
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
            this._syncCompletion();
            this._syncFinals();
            this._renderDone();
            this._renderAlbumEntry();
            const noteGroup = document.getElementById('noteInputGroup');
            if (noteGroup) noteGroup.hidden = gallery;
        },

        _renderDeliveryBar() {
            const el = document.getElementById('deliveryBar');
            if (!el) return;
            const titleEl = document.getElementById('deliveryTitle');
            const btn = document.getElementById('deliveryProofsBtn');
            if (this.mode !== 'delivered' || this._completionWanted()) { el.hidden = true; return; }
            // in the finals gallery the bar is a thin strip, and only there when it
            // carries the 下載毛片原檔 entry (the hero already has the title)
            el.classList.toggle('fg-bar-proofs', this.allowProofDownload);
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

        // ── the finals gallery (js/finals-gallery.js, docs/delivery.md) ──────
        // The delivered finish page as a web album: only in delivered mode and the
        // finals view. Picking, an undelivered project (finals kept) and the
        // 下載毛片原檔 list have none of it in the DOM. app.js's renderPhotoGrid
        // hands the photos over (renderFinals) instead of building cards.
        _finalsOn() {
            return this.active && this.mode === 'delivered' && this.view === 'finals' &&
                !!window.FinalsGallery && FinalsGallery.isMounted();
        },

        _syncFinals() {
            if (!window.FinalsGallery) return;
            const want = this.active && this.mode === 'delivered' && this.view === 'finals';
            if (!want) { FinalsGallery.unmount(); return; }
            // the confirmed delivery has its own light page: the gallery is mounted into it (no hero of
            // its own, light theme); otherwise into the dark page's content column, as always
            const cp = this._completionWanted() && CompletionPage.isMounted();
            const content = cp ? CompletionPage.galleryHost() : document.querySelector('main.main-content > .content');
            if (!content) return;
            // the other kind of host (a confirmation just came in, or went): rebuild the gallery there
            const switched = FinalsGallery.isMounted() && this._finalsInCp !== cp;
            if (switched) FinalsGallery.unmount();
            this._finalsInCp = cp;
            const studio = this.studio || {};
            FinalsGallery.mount(content, {
                title: this.projectTitle,
                studio: { name: studio.name || '', hasLogo: !!studio.has_logo, logoUrl: `${CONFIG.WORKER_URL}/api/studio/logo` },
                drive: driveManager,
                onShare: () => this.shareLink(),
                onDownload: (e, photo) => this.download(e, photo),
                onFolder: folder => this.app && this.app.handleLoadPhotos(folder),
                ...(cp ? { hero: false, theme: 'light' } : {}),
            });
            // a fresh gallery has no photos yet; the open folder's are already loaded
            if (switched && this.app && this.app.filteredPhotos) this.renderFinals(this.app.filteredPhotos);
        },

        // ── the 完成頁 (js/completion-page.js, docs/delivery.md) ─────────────
        // A delivered project the client CONFIRMED (confirmed_at, owner and viewers alike) shows the light
        // completion page instead of the 驗收頁, at the same URL. Never outside the delivered finals view; a
        // page without the scripts keeps the 驗收頁. The switch is in place (a re-render, no reload):
        // everything the page needs is already here, a reload would only add a blank flash and a second state
        // read, and the confirmation that triggers it has just been written to the Worker.
        _completionWanted() {
            return this.active && this.mode === 'delivered' && this.view === 'finals' && !!this.confirmedAt &&
                !!window.CompletionPage && !!window.FinalsGallery;
        },

        _syncCompletion() {
            if (!window.CompletionPage) return;
            if (!this._completionWanted()) {
                if (CompletionPage.isMounted()) CompletionPage.unmount();
                return;
            }
            const studio = this.studio || {};
            const when = this._fmtDate(this.confirmedAt);
            const cfg = {
                title: this.projectTitle,
                studio: { name: studio.name || '', hasLogo: !!studio.has_logo, logoUrl: `${CONFIG.WORKER_URL}/api/studio/logo`, bookingUrl: studio.booking_url || null },
                confirmedText: `已確認完成${when ? `（${when}）` : ''}`,
                workerUrl: CONFIG.WORKER_URL,
                onShare: () => this.shareLink(),
                onDownloadAll: () => this.downloadAllFinals(),
                fetchShop: () => this.fetchShop(),
                onShopSettled: () => this._renderAlbumEntry(),
            };
            const fresh = !CompletionPage.isMounted();
            CompletionPage.mount(cfg);
            if (fresh) {
                // the gallery of the dark page (if it was up) is rebuilt in the new host by _syncFinals; the
                // page starts at the top and takes the focus the closed modal left behind
                window.scrollTo(0, 0);
                try { document.getElementById('completionPage').focus({ preventScroll: true }); } catch (e) { /* no focus: fine */ }
            }
        },

        // 下載全部精修: every final (all final folders, subfolders included) as one zip named
        // <title>_精修_<N>張.zip. The finals are the deliverable (pickReadScope: delivered originals), so the
        // same rule as the per-photo 下載. The listing is the album preview's own walk.
        async downloadAllFinals() {
            let ids;
            try {
                ids = window.AlbumPreview && AlbumPreview.listFinalIds
                    ? await AlbumPreview.listFinalIds(this.finalFolders)
                    : (this.app ? this.app.photos.map(p => p.id) : []);
            } catch (e) {
                if (typeof toast !== 'undefined') toast.error('無法取得照片清單，請稍後再試');
                return;
            }
            const photos = ids.map(id => ({ id, name: String(id).split('/').pop() }));
            if (!photos.length) {
                if (typeof toast !== 'undefined') toast.warning('目前沒有照片可供下載');
                return;
            }
            const zipName = `${driveManager.sanitizeFileTitle(this.projectTitle)}_精修_${photos.length}張.zip`;
            await driveManager.downloadPhotos(photos, zipName);
        },

        // The finals folders as chips, plus (when the open folder has subfolders, or
        // is one) a chip per subfolder and a way back. None for a single folder.
        _finalsChips() {
            const roots = this.finalFolders;
            const cur = (typeof driveManager !== 'undefined' && driveManager.currentFolderId) || '';
            const kids = (this.app && this.app.currentFolders) || [];
            const activeRoot = roots.find(r => cur.startsWith(r)) || '';
            const nested = !!cur && !roots.includes(cur);
            if (roots.length < 2 && !kids.length && !nested) return [];
            const name = f => f.replace(/\/$/, '').split('/').pop() || f;
            const chips = roots.map(r => ({ folder: r, label: name(r), pressed: r === activeRoot }));
            if (nested) {
                const parent = cur.replace(/[^/]+\/$/, '');
                chips.push({ folder: parent, label: '‹ 上一層', pressed: false, sub: true, back: true });
            }
            kids.forEach(k => chips.push({ folder: k.id, label: k.name || name(k.id), pressed: false, sub: true }));
            return chips;
        },

        // app.js renderPhotoGrid: the photos of the open folder, in the order the
        // page already had. Returns false when there is no gallery (build cards).
        renderFinals(photos) {
            if (!this._finalsOn()) return false;
            FinalsGallery.setChips(this._finalsChips());
            FinalsGallery.setPhotos(photos, driveManager.currentFolderId);
            if (window.CompletionPage && CompletionPage.isMounted()) {
                if (photos.length) CompletionPage.setCover(photos[0], driveManager, photos);
                CompletionPage.setCount(photos.length);
            }
            return true;
        },

        // The link that goes out is the link token and nothing else: origin + path
        // + ?t=<token>. Never location.href (it may carry anything the guest's
        // browser added) and never the owner key — that lives in localStorage and
        // the X-Picker-Key header and has no business in a URL.
        shareUrl() {
            return `${window.location.origin}${window.location.pathname}?t=${encodeURIComponent(this.token)}`;
        },

        async shareLink() {
            const url = this.shareUrl();
            if (typeof navigator.share === 'function') {
                try {
                    await navigator.share({ title: this.projectTitle || '精修成品', url });
                    return;
                } catch (e) {
                    if (e && e.name === 'AbortError') return;   // the guest closed the sheet
                    // anything else: fall back to copying
                }
            }
            const done = await this._copyText(url);
            if (typeof toast === 'undefined') return;
            if (done) toast.success('已複製連結'); else toast.error('無法複製連結');
        },

        async _copyText(text) {
            try {
                if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                    await navigator.clipboard.writeText(text);
                    return true;
                }
            } catch (e) { /* denied: try the old way */ }
            const prev = document.activeElement;
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.dataset.fgCopy = '1';
            ta.setAttribute('aria-hidden', 'true');
            ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
            document.body.appendChild(ta);
            let ok = false;
            try {
                ta.focus();
                ta.select();
                ta.setSelectionRange(0, text.length);
                ok = !!document.execCommand('copy');
            } catch (e) { ok = false; }
            ta.remove();
            if (prev && typeof prev.focus === 'function') prev.focus({ preventScroll: true });
            return ok;
        },

        // The album preview entry (docs/album-preview.md, stage 1): delivered
        // mode and the finals view only, the last thing in the finals gallery
        // (right after its rows; without the gallery script: under the
        // confirmation block, as before) —
        // removed from the DOM in picking, after 取消交件 / 開放修改 (the finals
        // stay on the project but delivered_at is null, so mode is 'picking')
        // and in the proofs list. Owner and viewers alike: it is read-only.
        // js/album-preview.js does the rest; a page without it just has no entry.
        _renderAlbumEntry() {
            if (!window.AlbumPreview) return;
            const cp = this._completionWanted() && !!window.CompletionPage && CompletionPage.isMounted();
            AlbumPreview.syncEntry({
                show: this.mode === 'delivered' && this.view === 'finals' && this.finalFolders.length > 0 && (!cp || CompletionPage.shopSettled()),
                // the gallery's last row: the entry is the last thing on the page (on the 完成頁: in its own
                // album section, once the shop has answered so the spread bounds are already set)
                after: cp ? CompletionPage.albumAnchor() : ((this._finalsOn() && FinalsGallery.afterEl()) || document.getElementById('deliveryDone')),
                folders: this.finalFolders,
            });
        },

        // ── client confirmation: 確認完成 / 需要修改 (docs/delivery.md) ─────
        // Only in the delivered mode: outside it neither the block nor its
        // modals exist (removed, never hidden). Every string that came from
        // the server (the revision text) goes through textContent.
        _fmtDate(iso) {
            return Util.fmtDate(iso, 'ymd');
        },

        // confirmed_at / revision_open / revision_message from a state read;
        // null / false / null outside the delivered mode (a stray value there
        // is ignored all the same). Touches nothing else on the page.
        _applyConfirmFields(data) {
            const delivered = this.mode === 'delivered';
            this.confirmedAt = delivered && typeof data.confirmed_at === 'string' ? data.confirmed_at : null;
            this.revisionOpen = delivered && !this.confirmedAt && data.revision_open === true;
            // only the seat holder is sent the text (a viewer: null, always)
            this.revisionMessage = this.isOwner && this.revisionOpen && typeof data.revision_message === 'string' ? data.revision_message : null;
        },

        _renderDone() {
            let el = document.getElementById('deliveryDone');
            const bar = document.getElementById('deliveryBar');
            // the completion page has no status block, no 確認完成, no modals
            if (this.mode !== 'delivered' || !bar || this._completionWanted()) {
                el?.remove();
                this._removeDoneModals();
                return;
            }
            if (!el) {
                el = document.createElement('div');
                el.id = 'deliveryDone';
                el.className = 'delivery-done';
                bar.after(el);
            }
            const confirmed = !!this.confirmedAt;
            const revising = !confirmed && this.revisionOpen;
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
                const when = this._fmtDate(this.confirmedAt);
                kids.push(text('delivery-done-status', 'deliveryDoneStatus', `✓ 已確認完成${when ? `（${when}）` : ''}`));
            } else if (revising) {
                // a viewer sees that changes are in progress, never the text
                kids.push(text('delivery-done-status', 'deliveryDoneStatus', this.isOwner ? '已通知攝影師，修改中' : '攝影師修改中'));
                if (this.isOwner && this.revisionMessage) kids.push(text('delivery-done-msg', 'deliveryDoneMsg', this.revisionMessage));
            } else {
                kids.push(text('delivery-done-status', 'deliveryDoneStatus',
                    this.isOwner ? '滿意的話請按「確認完成」，需要調整請按「需要修改」' : '尚待選片人確認完成'));
            }
            // buttons: the seat holder only, and none once confirmed
            if (this.isOwner && !confirmed) {
                const actions = document.createElement('div');
                actions.className = 'delivery-done-actions';
                const ok = document.createElement('button');
                ok.id = 'doneConfirmBtn';
                ok.type = 'button';
                ok.className = 'btn btn-success';
                ok.textContent = '確認完成';
                ok.addEventListener('click', () => this._openDoneModal('confirm'));
                const rev = document.createElement('button');
                rev.id = 'doneReviseBtn';
                rev.type = 'button';
                rev.className = 'btn btn-outline';
                rev.textContent = '需要修改';
                rev.addEventListener('click', () => this._openDoneModal('revision'));
                actions.append(ok, rev);
                kids.push(actions);
                this._ensureDoneModals();
            } else {
                this._removeDoneModals();
            }
            el.replaceChildren(...kids);
        },

        _removeDoneModals() {
            document.getElementById('doneConfirmModal')?.remove();
            document.getElementById('doneReviseModal')?.remove();
            if (this._doneKeyHandler) {
                document.removeEventListener('keydown', this._doneKeyHandler);
                this._doneKeyHandler = null;
            }
        },

        _ensureDoneModals() {
            if (document.getElementById('doneConfirmModal')) return;
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

            const confirmModal = modal('doneConfirmModal', '確認完成？',
                mk('p', 'pick-over-line', { textContent: '確認後攝影師會收到通知；之後若要再修改，需聯絡攝影師。' }),
                errBox('doneConfirmErr'),
                (() => {
                    const a = mk('div', 'pick-submit-actions');
                    a.append(btn('doneConfirmCancel', 'btn btn-outline', '取消'), btn('doneConfirmSubmit', 'btn btn-success', '確認完成'));
                    return a;
                })());

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
            document.body.append(confirmModal, reviseModal);

            const sync = () => {
                count.textContent = `${ta.value.length} / 1000`;
                if (!this._doneBusy) document.getElementById('doneReviseSubmit').disabled = !ta.value.trim();
            };
            ta.addEventListener('input', sync);
            for (const [m, kind] of [[confirmModal, 'confirm'], [reviseModal, 'revision']]) {
                m.querySelector('.modal-overlay').addEventListener('click', () => this._closeDoneModal(kind));
            }
            document.getElementById('doneConfirmCancel').addEventListener('click', () => this._closeDoneModal('confirm'));
            document.getElementById('doneReviseCancel').addEventListener('click', () => this._closeDoneModal('revision'));
            document.getElementById('doneConfirmSubmit').addEventListener('click', () => this._doneSubmit('confirm'));
            document.getElementById('doneReviseSubmit').addEventListener('click', () => this._doneSubmit('revision'));
            this._doneKeyHandler = e => {
                if (e.key !== 'Escape') return;
                if (confirmModal.classList.contains('active')) this._closeDoneModal('confirm');
                if (reviseModal.classList.contains('active')) this._closeDoneModal('revision');
            };
            document.addEventListener('keydown', this._doneKeyHandler);
        },

        _doneModal(kind) {
            return document.getElementById(kind === 'revision' ? 'doneReviseModal' : 'doneConfirmModal');
        },
        _doneErr(kind) {
            return document.getElementById(kind === 'revision' ? 'doneReviseErr' : 'doneConfirmErr');
        },
        _openDoneModal(kind) {
            const m = this._doneModal(kind);
            if (!m) return;
            this._doneShowErr(kind, '');
            m.classList.add('active');
            if (kind === 'revision') setTimeout(() => document.getElementById('doneReviseText')?.focus(), 30);
        },
        _closeDoneModal(kind) {
            if (this._doneBusy) return;
            this._doneModal(kind)?.classList.remove('active');
        },

        // The error line of a modal; `reload` adds a 重新載入 button next to it
        // (a page that shows an old version must be reloaded, not retried).
        _doneShowErr(kind, text, reload) {
            const el = this._doneErr(kind);
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

        _doneErrorText(status, data) {
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
        async _doneGuard() {
            const r = await this.fetchState();
            if (!r.ok) return { kind: 'error', status: r.status, data: r.data };
            const d = r.data;
            if (d.mode !== 'delivered') return { kind: 'stale' };
            const finals = Array.isArray(d.final_folders) ? d.final_folders : [];
            if (JSON.stringify(finals) !== JSON.stringify(this.finalFolders) || (d.delivered_at || null) !== this.deliveredAt) {
                return { kind: 'stale' };
            }
            if (typeof d.confirmed_at === 'string') return { kind: 'confirmed', data: d };
            const msg = typeof d.revision_message === 'string' ? d.revision_message : null;
            if ((d.revision_open === true) !== this.revisionOpen || msg !== this.revisionMessage) return { kind: 'stale' };
            return { kind: 'ok' };
        },

        async _doneSubmit(kind) {
            if (this._doneBusy) return;
            const revision = kind === 'revision';
            const submit = document.getElementById(revision ? 'doneReviseSubmit' : 'doneConfirmSubmit');
            const ta = document.getElementById('doneReviseText');
            const message = revision ? ta.value.trim() : '';
            if (revision && !message) { this._doneShowErr(kind, '請輸入修改內容'); return; }
            this._doneShowErr(kind, '');
            this._doneBusy = true;
            submit.disabled = true;
            try {
                const guard = await this._doneGuard();
                if (guard.kind === 'stale') {
                    this._doneShowErr(kind, '攝影師剛更新了照片，請重新整理後再確認', true);
                    return;
                }
                if (guard.kind === 'error') {
                    this._doneShowErr(kind, this._doneErrorText(guard.status, guard.data));
                    return;
                }
                if (guard.kind === 'confirmed') {
                    this._applyConfirmFields(guard.data);
                    this._doneBusy = false;
                    this._closeDoneModal(kind);
                    this._applyView();   // re-renders the block, and switches to the completion page when this confirmed
                    if (typeof toast !== 'undefined') toast.success('此相簿已確認完成');
                    return;
                }
                const { ok, status, data } = revision ? await this.requestRevision(message) : await this.confirmDelivery();
                if (ok) {
                    if (revision) {
                        this.revisionOpen = true;
                        this.revisionMessage = typeof data.message === 'string' ? data.message : message;
                        ta.value = '';
                        document.getElementById('doneReviseCount').textContent = '0 / 1000';
                    } else {
                        this.confirmedAt = typeof data.confirmed_at === 'string' ? data.confirmed_at : new Date().toISOString();
                        this.revisionOpen = false;
                        this.revisionMessage = null;
                    }
                    this._doneBusy = false;
                    this._closeDoneModal(kind);
                    this._applyView();   // re-renders the block, and switches to the completion page when this confirmed
                    if (typeof toast !== 'undefined') toast.success(revision ? '已通知攝影師' : '已確認完成');
                    return;
                }
                if (data && data.code === 'already_confirmed') {
                    // confirmed in the meantime (another tab, or the photographer):
                    // show it as it is
                    const r = await this.fetchState();
                    if (r.ok) this._applyConfirmFields(r.data);
                    else { this.confirmedAt = this.confirmedAt || new Date().toISOString(); this.revisionOpen = false; this.revisionMessage = null; }
                    this._doneBusy = false;
                    this._closeDoneModal(kind);
                    this._applyView();   // re-renders the block, and switches to the completion page when this confirmed
                    if (typeof toast !== 'undefined') toast.success('此相簿已確認完成');
                    return;
                }
                this._doneShowErr(kind, this._doneErrorText(status, data), data && data.code === 'not_delivered');
            } finally {
                this._doneBusy = false;
                if (submit.isConnected) submit.disabled = revision ? !ta.value.trim() : false;
            }
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
            if (this._retryCount >= this.retryDelays.length) this._retryCount = 0; // a new action earns a fresh round
            this._setSaveStatus(this._retryCount > 0 ? 'retry' : 'saving');
            this._saveTimer = setTimeout(() => this.flush(), 800);
        },

        // One flush at a time (a second caller waits for, and then drains, the
        // first): a failed batch is put back into the queue, and two batches in
        // flight could otherwise land out of order and let an older ♥ win.
        // Resolves once nothing is left to send OR a retry is pending; check
        // hasPending() afterwards if that matters (submit does).
        flush() {
            clearTimeout(this._saveTimer);
            if (this._flushP) { this._flushWanted = true; return this._flushP; }
            if (!this.hasPending()) return Promise.resolve();
            // _drain awaits a request before it can finish, so its finally
            // always runs after this assignment
            this._flushP = this._drain();
            return this._flushP;
        },

        async _drain() {
            try {
                do {
                    this._flushWanted = false;
                    const retry = await this._flushOnce();
                    if (retry) break;
                } while (this._flushWanted || this.hasPending());
            } finally {
                this._flushP = null;
            }
        },

        hasPending() { return this._pendingUpsert.size > 0 || this._pendingDelete.size > 0; },

        // ── draft status: 儲存中… / 已自動儲存 / 儲存失敗，重試中… ─────────────
        _setSaveStatus(kind) {
            const el = document.getElementById('pickSaveStatus');
            clearTimeout(this._statusTimer);
            this._saveStatusKind = kind;
            if (!el) return;
            el.textContent = kind === 'saving' ? '儲存中…'
                : (kind === 'saved' ? '已自動儲存'
                    : (kind === 'retry' ? '儲存失敗，重試中…' : ''));
            el.dataset.state = kind || '';
            if (kind === 'saved') {
                this._statusTimer = setTimeout(() => {
                    if (this._saveStatusKind === 'saved') this._setSaveStatus('');
                }, 2500);
            }
        },

        // Backoff for a batch the network/server could not take: 2 s, 5 s, 15 s,
        // then it waits for the next ♥ (queueUpsert flushes) or the browser
        // coming back online.
        retryDelays: [2000, 5000, 15000],
        _retryCount: 0,
        _retryTimer: null,

        _scheduleRetry() {
            clearTimeout(this._retryTimer);
            const i = this._retryCount;
            if (i >= this.retryDelays.length) {
                if (i === this.retryDelays.length) {
                    this._retryCount++;
                    if (typeof toast !== 'undefined') toast.error('儲存失敗，請檢查網路連線');
                }
                return; // wait for the next action / 'online'
            }
            this._retryCount++;
            this._retryTimer = setTimeout(() => this.flush(), this.retryDelays[i]);
        },

        // Put a failed batch back. Anything touched again since (still queued)
        // is newer and wins; the pre-batch snapshot is older, so it wins over a
        // newer batch's own snapshot (a revert must go back to what the server
        // holds).
        _requeue(upsert, del, prevSnapshot) {
            for (const item of upsert) {
                if (this._pendingUpsert.has(item.photo_key) || this._pendingDelete.has(item.photo_key)) continue;
                this._pendingUpsert.set(item.photo_key, item);
            }
            for (const key of del) {
                if (this._pendingUpsert.has(key) || this._pendingDelete.has(key)) continue;
                this._pendingDelete.add(key);
            }
            for (const [key, prev] of prevSnapshot) this._pendingPrev.set(key, prev);
        },

        // The pending queue plus the batch still in flight, one item per key
        // (newer wins) — what a closing page must not lose.
        _draftPayload() {
            const up = new Map();
            const del = new Set();
            if (this._inflight) {
                for (const it of this._inflight.upsert) up.set(it.photo_key, it);
                for (const k of this._inflight.del) del.add(k);
            }
            for (const [k, it] of this._pendingUpsert) { up.set(k, it); del.delete(k); }
            for (const k of this._pendingDelete) { del.add(k); up.delete(k); }
            return { upsert: Array.from(up.values()), delete: Array.from(del) };
        },

        // pagehide / visibilitychange→hidden: sendBeacon cannot carry
        // X-Share-Token / X-Picker-Key, keepalive fetch can. The queue is kept
        // (a resumed page re-sends the same idempotent upserts).
        flushKeepalive() {
            if (!this.canEdit()) return;
            const payload = this._draftPayload();
            if (!payload.upsert.length && !payload.delete.length) return;
            try {
                fetch(`${CONFIG.WORKER_URL}/api/pick/selections`, {
                    method: 'PUT',
                    headers: this.headers({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify(payload),
                    keepalive: true,
                }).catch(() => {});
            } catch (e) { /* best effort */ }
        },

        _wireDraftSafety() {
            if (this._draftWired) return;
            this._draftWired = true;
            window.addEventListener('pagehide', () => this.flushKeepalive());
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden') this.flushKeepalive();
            });
            window.addEventListener('online', () => {
                if (this.hasPending()) { this._retryCount = 0; this.flush(); }
            });
        },

        // Sends one batch. Returns true when it failed retryably (re-queued).
        async _flushOnce() {
            const upsert = Array.from(this._pendingUpsert.values());
            const del = Array.from(this._pendingDelete);
            const prevSnapshot = this._pendingPrev;
            this._pendingUpsert.clear();
            this._pendingDelete.clear();
            this._pendingPrev = new Map();
            this._marksClear = new Set();
            this._inflight = { upsert, del };
            this._setSaveStatus(this._retryCount > 0 ? 'retry' : 'saving');
            let res;
            try {
                res = await this.saveSelections({ upsert, delete: del });
            } finally {
                this._inflight = null;
            }
            const { ok, status, data } = res;
            if (ok) {
                this._retryCount = 0;
                clearTimeout(this._retryTimer);
                this._setSaveStatus(this.hasPending() ? 'saving' : 'saved');
                // mirrors the gate UPDATE in worker.js: a save while already
                // 'submitted' raises modified_after_submit, so the banner has
                // to catch up here too — nothing re-fetches state for us.
                if (this.phase === 'submitted' && !this.modifiedAfterSubmit) {
                    this.modifiedAfterSubmit = true;
                    this.renderBanner();
                }
                return false;
            }
            if (status === 0 || status === 429 || (status >= 500 && !(data && data.code === 'marks_unavailable'))) {
                this._requeue(upsert, del, prevSnapshot);
                this._setSaveStatus('retry');
                this._scheduleRetry();
                return true;
            }
            this._retryCount = 0;
            this._setSaveStatus(this.hasPending() ? 'saving' : '');
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
            this._wireDraftSafety();

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
            this.extraMax = project.extra_max ?? null;
            this.maxPicks = project.max_picks ?? null;
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
            this._applyConfirmFields(data);
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
            if (this.renderFinals(this.app.filteredPhotos)) return;
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
            this.closePinEditor(true);
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
            // the note editor lives only while its pin does, on this photo, editable
            const ed = this._pinEd;
            if (ed && (!editable || !this.pinMode || ed.key !== id || !this.marksOf(id)[ed.index])) this.closePinEditor(true);
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
            // the tap that placed the pin is a user gesture: focus now, in the
            // same call stack, or iOS will not raise the keyboard
            if (this.pinMode) this._openPinEditor(cur.length);
        },

        // The note input that opens on a freshly placed pin. Pinned to the TOP
        // of the photo area (a phone keyboard rises from the bottom, so the
        // input is never under it). Typing saves through setPinNote — the same
        // path as the panel's list, so no new data shape; Enter, 確定, tapping
        // another spot or leaving pin mode just close it. A pin closed
        // without text stays as an empty-note pin, as it always could.
        _openPinEditor(index) {
            const cc = document.querySelector('.canvas-container');
            const key = this._pinPhotoId;
            const mark = this.marksOf(key)[index];
            if (!cc || !mark || !this.pinMode || !this.canEdit()) return;
            this.closePinEditor(true);
            const ed = document.createElement('div');
            ed.id = 'pickPinEditor';
            ed.className = 'pick-pin-editor';
            const num = document.createElement('span');
            num.className = 'pick-pin-num';
            num.textContent = String(index + 1);
            const input = document.createElement('input');
            input.type = 'text';
            input.id = 'pickPinEditorInput';
            input.className = 'pick-pin-editor-input';
            input.maxLength = PIN_NOTE_MAX;
            input.value = mark.note;
            input.placeholder = '這裡要修改什麼？例：這裡痘痘';
            input.enterKeyHint = 'done';
            input.setAttribute('dir', 'auto');
            input.setAttribute('autocomplete', 'off');
            input.setAttribute('aria-label', `標示 ${index + 1} 的備註`);
            const ok = document.createElement('button');
            ok.type = 'button';
            ok.id = 'pickPinEditorOk';
            ok.className = 'pick-tool-btn pick-tool-done';
            ok.textContent = '確定';
            input.addEventListener('input', () => {
                const clean = pinSanitize(input.value);
                if (clean !== input.value) input.value = clean;
                this.setPinNote(key, index, clean);
            });
            input.addEventListener('keydown', e => {
                if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); this.closePinEditor(); }
            });
            input.addEventListener('blur', () => { if (this._pinEd && this._pinEd.input === input) this.closePinEditor(); });
            ok.addEventListener('click', () => this.closePinEditor());
            ed.append(num, input, ok);
            cc.appendChild(ed);
            cc.classList.add('pin-editing');
            this._pinEd = { el: ed, input, key, index };
            input.focus({ preventScroll: true });
        },

        // quiet = the caller re-renders everything itself. Otherwise the
        // panel's list is brought up to date with what was just typed.
        closePinEditor(quiet) {
            const ed = this._pinEd;
            if (!ed) return;
            this._pinEd = null; // first: removing a focused input fires blur
            ed.el.remove();
            document.querySelector('.canvas-container')?.classList.remove('pin-editing');
            if (!quiet) this._refreshPinList();
        },

        // setPinNote does not re-render the list; copy the stored notes into
        // its inputs in place (a re-render would drop a focus the guest has
        // just put in the list), or rebuild it if the pin count differs.
        _refreshPinList() {
            const id = this._pinPhotoId;
            const sel = id ? this.selections.get(id) : null;
            const hearted = !!sel && sel.rating > 0;
            const marks = hearted ? this.marksOf(id) : [];
            const rows = document.querySelectorAll('#pickPinList .pick-pin-item');
            if (rows.length !== marks.length || !rows.length) {
                this._renderPinList(hearted, this.canEdit() && hearted, marks);
                return;
            }
            rows.forEach((li, i) => {
                const input = li.querySelector('.pick-pin-note');
                const count = li.querySelector('.pick-pin-count');
                if (input && input !== document.activeElement && input.value !== marks[i].note) input.value = marks[i].note;
                if (count) count.textContent = `${pinLen(marks[i].note)}/${PIN_NOTE_MAX}`;
            });
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
                // the quiet draft status sits under the counter in a line whose
                // height is reserved, so its text never moves the bar
                const st = document.createElement('div');
                st.id = 'pickSaveStatus';
                st.className = 'pick-save-status';
                st.setAttribute('aria-live', 'polite');
                const wrap = document.createElement('div');
                wrap.className = 'pick-counter-wrap';
                wrap.append(el, st);
                status.replaceChildren(wrap);
            }
            const count = this._selectedCount();
            const limit = this.pickLimit;
            const max = this.maxPicks;
            const overCap = max != null && count > max;
            let text = limit == null ? `已選 ${count} 張` : `已選 ${count} / ${limit} 張`;
            if (overCap) {
                // hearts are drafts: past the plan's cap is allowed, submit is not
                text = this.extraMax === 0
                    ? `已選 ${count} 張（上限 ${max} 張，不可加選，需減 ${count - max} 張）`
                    : `已選 ${count} 張（上限 ${max} 張，需減 ${count - max} 張）`;
            } else if (limit != null && this.extraMax != null) {
                text += this.extraMax === 0 ? '（不可加選）' : `（最多可加選到 ${limit + this.extraMax}）`;
            }
            el.textContent = text;
            el.classList.toggle('over', !overCap && limit != null && count > limit);
            el.classList.toggle('over-cap', overCap);
        },

        // How many picks exceed the plan (0 when there is no limit).
        overCount() {
            const limit = this.pickLimit;
            return limit == null ? 0 : Math.max(0, this._selectedCount() - limit);
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
            const max = this.maxPicks;
            const n = this._selectedCount();
            if (max != null && n > max) {
                // nothing is sent: the server would refuse it with 409 pick_cap
                this.openCapModal({ count: n, max, over: n - max, limit: this.pickLimit, extra_max: this.extraMax });
                return;
            }
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
                const p = Util.formatPrice(price);
                lines.push(`加挑每張 ${p}，加價 ${p} × ${over} = ${Util.formatPrice(price * over)}`);
            }
            body.replaceChildren(...lines.map((t, i) => {
                const p = document.createElement('p');
                p.className = i === 0 ? 'pick-over-line' : 'pick-over-price';
                p.textContent = t;
                return p;
            }));
            modal.classList.add('active');
        },
        // 已超出可送出張數: d = {count, max, over, limit, extra_max} (from the
        // local numbers, or the server's 409 pick_cap body).
        openCapModal(d) {
            const modal = document.getElementById('pickCapModal');
            const body = document.getElementById('pickCapBody');
            const count = d.count != null ? d.count : this._selectedCount();
            const max = d.max != null ? d.max : this.maxPicks;
            const over = d.over != null ? d.over : count - max;
            const limit = d.limit != null ? d.limit : this.pickLimit;
            const extra = d.extra_max != null ? d.extra_max : this.extraMax;
            if (!modal || !body) return;
            const text = extra === 0
                ? `目前選了 ${count} 張，此專案最多 ${max} 張，不可加選。請先取消 ${over} 張再送出`
                : `目前選了 ${count} 張，最多可送出 ${max} 張（方案 ${limit} + 加選 ${extra}）。請先取消 ${over} 張再送出`;
            const p = document.createElement('p');
            p.className = 'pick-over-line';
            p.textContent = text;
            body.replaceChildren(p);
            modal.classList.add('active');
        },
        closeCapModal() {
            document.getElementById('pickCapModal')?.classList.remove('active');
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
            document.getElementById('pickCapBackBtn')?.addEventListener('click', () => {
                this.closeCapModal();
                this._setFilterMode('selected');
            });
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

            if (btn) btn.disabled = true;
            let ok = false, status = 0, data = {};
            try {
                await this.flush();
                if (this.hasPending()) {
                    // the hearts on screen are not all saved: submitting now would
                    // send a different list than the guest sees
                    if (errEl) errEl.textContent = '尚有選擇未儲存，請確認網路後再試一次';
                    return;
                }
                ({ ok, status, data } = await this.submitPicks({ relationship, email: email || undefined }));
            } finally {
                if (btn) btn.disabled = false;
            }

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
            } else if (status === 409 && data && data.code === 'pick_cap') {
                // the plan changed since this page loaded (or a stale count):
                // take the server's numbers, nothing was written
                if (data.limit != null) this.pickLimit = data.limit;
                if (data.extra_max != null) this.extraMax = data.extra_max;
                if (data.max != null) this.maxPicks = data.max;
                this.closeSubmitModal();
                this.closeOverModal();
                this.renderCounter();
                this.openCapModal(data);
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
