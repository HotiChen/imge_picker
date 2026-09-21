const Viewer = {
    book: null,
    currentPageIndex: 0,
    bookId: null,
    changedPages: new Set(),
    pickerSlotIdx: -1,
    showGuides: false,
    // ?t= from the URL. The client opens this page from a LINE chat message,
    // over and over, for months: LINE's in-app webview may drop any storage we
    // put it in, so the URL is the only copy that survives. It is read and
    // never rewritten away, and nothing about a first load consumes it —
    // LINE pre-fetches every link to build its preview card, so the very first
    // request the Worker sees is usually a crawler, not the client.
    shareToken: '',
    // The photographer opens the same page to preview an album, with no ?t=.
    adminToken: '',

    async init() {
        const params = new URLSearchParams(location.search);
        this.bookId = params.get('id');
        if (!this.bookId) { this._setError('無效的分享連結'); return; }

        this.shareToken = params.get('t') || '';
        this.adminToken = (typeof CONFIG !== 'undefined' && CONFIG.PHOTOGRAPHER_TOKEN) || this._storedAdminToken();

        // layouts.js builds every <img src> on the page canvas; an element
        // cannot send a header, so the token has to be in the query string.
        if (typeof CONFIG !== 'undefined') CONFIG.SHARE_TOKEN = this.shareToken;

        if (!this.shareToken && !this.adminToken) {
            // A blank screen here has already cost this project a long
            // debugging session. Say what is missing.
            this._setError('這個連結缺少存取權杖，無法開啟相本。請向攝影師索取完整的分享連結。');
            return;
        }

        // The photographer previews an album with no ?t= at all. They used to
        // get blob URLs: every <img> fired a naked request that 401'd, then
        // the same bytes were fetched again with the bearer token. Trading the
        // bearer token for a studio token costs one POST and lets the elements
        // load the photos themselves, cache and all.
        if (!this.shareToken) {
            if (typeof CONFIG !== 'undefined' && !CONFIG.PHOTOGRAPHER_TOKEN) {
                CONFIG.PHOTOGRAPHER_TOKEN = this.adminToken;
            }
            if (window.StudioToken) await window.StudioToken.ensure();
        }

        await this.loadBook();
        this.bindEvents();
    },

    _storedAdminToken() {
        try { return sessionStorage.getItem('studio_token') || ''; } catch (e) { return ''; }
    },

    /**
     * The credential for everything fetch() sends.
     *
     * Header form rather than ?t= on purpose: one code path then covers both
     * the client's share token and the photographer's bearer token, the token
     * stays out of the Worker's request URLs, and the Worker already answers
     * `Vary: X-Share-Token` on these routes. <img> is the exception — an
     * element cannot carry a header — so those keep the ?t= query form.
     */
    _authHeaders(extra) {
        const h = { ...(extra || {}) };
        if (this.shareToken) h['X-Share-Token'] = this.shareToken;
        else if (this.adminToken) h['Authorization'] = `Bearer ${this.adminToken}`;
        return h;
    },

    // Photo URL for an <img>, with the share token in the query string.
    _photoUrl(photoId, w = 400) {
        return _thumbUrl(photoId, w);
    },

    /**
     * Fetches the photobook details from the server, sanitizes its fields for backwards compatibility,
     * and sets up the preview display.
     * Pre-conditions:
     *   - `this.bookId` must be a valid book identifier.
     *   - The network connection to `${CONFIG.WORKER_URL}/api/books/${this.bookId}` must be active.
     * Post-conditions:
     *   - Fetches the book object, normalizes settings, pages, slots, and textLayers with default values.
     *   - Sets the page index to 0, renders the first page, and queries approval status.
     *   - Sets an error screen if fetching or structure sanitization fails.
     */
    async loadBook() {
        try {
            const r = await fetch(`${CONFIG.WORKER_URL}/api/books/${this.bookId}`, {
                headers: this._authHeaders()
            });
            if (r.status === 401) throw new Error('這個相本連結已失效或被撤銷，請向攝影師索取新的連結。');
            if (!r.ok) throw new Error('找不到此相本（連結可能已過期或無效）');
            const rawBook = await r.json();

            // Ensure default structure and backward compatibility
            this.book = {
                name: '未命名相本',
                clientFolders: [],
                notifyUrl: '',
                settings: { width: 20, height: 20, unit: 'cm', dpi: 300 },
                coverSettings: { width: 20, height: 20, unit: 'cm', dpi: 300 },
                pages: [],
                ...rawBook
            };
            this.book.settings = {
                width: 20, height: 20, unit: 'cm', dpi: 300,
                ...(rawBook.settings || {})
            };
            this.book.coverSettings = {
                width: 20, height: 20, unit: 'cm', dpi: 300,
                ...(rawBook.coverSettings || {})
            };

            // Restore custom layouts BEFORE page sanitization so LAYOUTS[layout] check doesn't fall back
            if (rawBook._customLayouts) {
                Object.entries(rawBook._customLayouts).forEach(([id, layout]) => {
                    if (!LAYOUTS[id] && layout?.name) LAYOUTS[id] = layout;
                });
            }

            // Why: Guarantee that pages is a valid array of structured objects
            if (Array.isArray(this.book.pages)) {
                this.book.pages = this.book.pages.map((page, pIdx) => {
                    if (!page || typeof page !== 'object') return null;

                    const type = page.type || 'inner';
                    let layout = page.layout;

                    if (!layout || !LAYOUTS[layout]) {
                        const defaultLayouts = { cover: 'full-bleed', inner: '2-up-h', 'back-cover': 'blank' };
                        layout = defaultLayouts[type] || 'blank';
                    }

                    const layoutDef = LAYOUTS[layout] || LAYOUTS['blank'];
                    const slots = Array.isArray(page.slots) ? page.slots : [];

                    // Why: Map slots and fill in missing parameters conforming to layout slot count
                    const sanitizedSlots = (layoutDef.slots || []).map((slotDef, sIdx) => {
                        const s = slots[sIdx] || {};
                        return {
                            photoId: s.photoId || null,
                            crop: {
                                x: s.crop?.x ?? 0,
                                y: s.crop?.y ?? 0,
                                scale: s.crop?.scale ?? 1,
                                rotation: s.crop?.rotation ?? 0
                            },
                            fit: s.fit || 'cover',
                            ...(s.override ? { override: s.override } : {})
                        };
                    });

                    return {
                        id: page.id || `page-${Date.now()}-${pIdx}-${Math.random().toString(36).slice(2, 6)}`,
                        type,
                        layout,
                        slots: sanitizedSlots,
                        bg: page.bg || '#ffffff',
                        bgImage: page.bgImage || null,
                        textLayers: Array.isArray(page.textLayers) ? page.textLayers : [],
                        locked: !!page.locked
                    };
                }).filter(Boolean);
            } else {
                this.book.pages = [];
            }

            document.title = `${this.book.name || '相本'} · 預覽`;
            document.getElementById('bookTitle').textContent = this.book.name || '相本';
            this.currentPageIndex = 0;
            this.renderPage();
            this.checkApprovalStatus();
        } catch (e) {
            this._setError(e.message);
        }
    },

    async checkApprovalStatus() {
        try {
            const r = await fetch(`${CONFIG.WORKER_URL}/api/books/${this.bookId}/status`, {
                headers: this._authHeaders()
            });
            if (!r.ok) return;
            const data = await r.json();
            if (data.approved) this._showApproved(data.timestamp);
        } catch (e) {}
    },

    renderPage() {
        if (!this.book) return;
        const page = this.book.pages[this.currentPageIndex];
        if (!page) return;

        const area = document.getElementById('pageArea');
        const settings = page.type === 'inner'
            ? this.book.settings
            : (this.book.coverSettings || this.book.settings);

        const areaW = area.clientWidth - 80;
        const areaH = area.clientHeight - 80;
        const aspect = settings.width / settings.height;

        let displayW, displayH;
        if (areaW / areaH > aspect) {
            displayH = Math.max(areaH, 200);
            displayW = displayH * aspect;
        } else {
            displayW = Math.max(areaW, 200);
            displayH = displayW / aspect;
        }

        area.innerHTML = renderPageHTML(page, displayW, displayH);

        if (this.showGuides) {
            const canvas = area.querySelector('.page-canvas');
            if (canvas) appendPageGuides(canvas, displayW, displayH, settings, this.book.settings?.bleed ?? 3);
        }

        const counter = document.getElementById('pageCounter');
        if (counter) {
            const label = pageLabel(this.book.pages, this.currentPageIndex, this.book.settings);
            const lockMark = page.locked ? ' 🔒' : ' 🔓';
            counter.textContent = `${label}${lockMark}（${this.currentPageIndex + 1} / ${this.book.pages.length}）`;
        }

        document.getElementById('prevBtn').disabled = this.currentPageIndex === 0;
        document.getElementById('nextBtn').disabled = this.currentPageIndex === this.book.pages.length - 1;

        if (!page.locked) this._bindSlotClicks();
    },

    // ─── 換圖互動 ──────────────────────────────

    _bindSlotClicks() {
        document.querySelectorAll('.page-slot').forEach(el => {
            el.classList.add('swappable');
            // 加換圖提示圖示
            const hint = document.createElement('div');
            hint.className = 'slot-swap-hint';
            hint.textContent = '✎';
            el.appendChild(hint);
            el.addEventListener('click', () => {
                this.pickerSlotIdx = parseInt(el.dataset.slotIdx);
                this._openPhotoPicker();
            });
        });
    },

    async _openPhotoPicker() {
        const modal = document.getElementById('viewerPickerModal');
        const grid = document.getElementById('viewerPickerGrid');
        modal.classList.add('active');
        grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:#9fa8da;">載入照片中...</div>';

        const clientFolders = this.book.clientFolders || [];
        if (clientFolders.length === 0) {
            grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:#9fa8da;">攝影師尚未開放照片庫</div>';
            return;
        }

        try {
            const results = await Promise.all(clientFolders.map(f => this._loadFolderRecursive(f)));
            const allPhotos = results.flat();

            if (allPhotos.length === 0) {
                grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:#9fa8da;">沒有可選的照片</div>';
                return;
            }

            grid.innerHTML = allPhotos.map(photo => `
                <div class="viewer-picker-photo" data-photo-id="${_escapeHtml(photo.id)}" title="${_escapeHtml(photo.name)}">
                    <img src="${_escapeHtml(this._photoUrl(photo.id, 400))}" loading="lazy" decoding="async">
                </div>
            `).join('');

            grid.querySelectorAll('.viewer-picker-photo').forEach(el => {
                el.addEventListener('click', () => {
                    this._selectPhoto(el.dataset.photoId);
                    modal.classList.remove('active');
                });
            });
        } catch (e) {
            grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:#ff4757;">載入失敗，請重試</div>';
        }
    },

    async _fetchFolderDirect(folderPath) {
        if (folderPath && !folderPath.endsWith('/')) folderPath += '/';
        try {
            const resp = await fetch(`${CONFIG.WORKER_URL}/?list=${encodeURIComponent(folderPath)}`, {
                headers: this._authHeaders()
            });
            const result = await resp.json();
            if (result.status !== 'success') return { photos: [], folders: [] };
            return {
                photos: result.data.map(f => ({ id: f.id, name: f.name })),
                folders: result.folders || []
            };
        } catch (e) {
            return { photos: [], folders: [] };
        }
    },

    async _loadFolderRecursive(folderPath) {
        const { photos, folders } = await this._fetchFolderDirect(folderPath);
        if (folders.length === 0) return photos;
        const subResults = await Promise.all(folders.map(f => this._loadFolderRecursive(f)));
        return photos.concat(...subResults);
    },

    _selectPhoto(photoId) {
        const page = this.book.pages[this.currentPageIndex];
        if (!page || page.locked) return;
        const slot = page.slots[this.pickerSlotIdx];
        if (!slot) return;
        slot.photoId = photoId;
        slot.crop = { x: 0, y: 0, scale: 1 };
        this.changedPages.add(this.currentPageIndex);
        this._updateSaveBtn();
        this.renderPage();
    },

    _updateSaveBtn() {
        const btn = document.getElementById('saveChangesBtn');
        if (btn) btn.style.display = this.changedPages.size > 0 ? '' : 'none';
    },

    // ─── 儲存修改 ──────────────────────────────

    async saveChanges() {
        const btn = document.getElementById('saveChangesBtn');
        if (btn) { btn.disabled = true; btn.textContent = '儲存中...'; }
        try {
            for (const pageIndex of this.changedPages) {
                const page = this.book.pages[pageIndex];
                const r = await fetch(`${CONFIG.WORKER_URL}/api/books/${this.bookId}`, {
                    method: 'PATCH',
                    headers: this._authHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({ pageIndex, slots: page.slots })
                });
                if (!r.ok) {
                    const err = await r.json().catch(() => ({}));
                    throw new Error(err.error || '儲存失敗');
                }
            }
            this.changedPages.clear();
            this._updateSaveBtn();
            this._toast('已儲存！攝影師已收到通知。');
        } catch (e) {
            this._toast(e.message || '儲存失敗，請重試', true);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '💾 儲存修改'; }
        }
    },

    // ─── 批准 ────────────────────────────────

    async approve() {
        const btn = document.getElementById('approveBtn');
        if (!btn || btn.disabled) return;
        const hasUnsaved = this.changedPages.size > 0;
        const msg = hasUnsaved
            ? '你有未儲存的修改，確定直接批准？（建議先儲存修改再批准）'
            : '確定批准此相本？批准後攝影師將開始後續處理。';
        if (!confirm(msg)) return;
        btn.disabled = true;
        btn.textContent = '送出中...';
        try {
            const r = await fetch(`${CONFIG.WORKER_URL}/api/books/${this.bookId}/approve`, {
                method: 'POST',
                headers: this._authHeaders({ 'Content-Type': 'application/json' })
            });
            if (!r.ok) throw new Error();
            this._showApproved(new Date().toISOString());
        } catch (e) {
            btn.disabled = false;
            btn.textContent = '批准相本';
            alert('操作失敗，請重試');
        }
    },

    // ─── 事件綁定 ────────────────────────────

    bindEvents() {
        document.getElementById('prevBtn').addEventListener('click', () => {
            if (this.currentPageIndex > 0) { this.currentPageIndex--; this.renderPage(); }
        });
        document.getElementById('nextBtn').addEventListener('click', () => {
            if (this.currentPageIndex < this.book.pages.length - 1) { this.currentPageIndex++; this.renderPage(); }
        });
        document.getElementById('guideToggleBtn')?.addEventListener('click', e => {
            this.showGuides = !this.showGuides;
            e.currentTarget.classList.toggle('active', this.showGuides);
            e.currentTarget.textContent = this.showGuides ? '⊞ 參考線 ✓' : '⊞ 參考線';
            this.renderPage();
        });
        document.getElementById('approveBtn')?.addEventListener('click', () => this.approve());
        document.getElementById('saveChangesBtn')?.addEventListener('click', () => this.saveChanges());
        document.getElementById('closeViewerPickerBtn')?.addEventListener('click', () => {
            document.getElementById('viewerPickerModal').classList.remove('active');
        });
        document.getElementById('viewerPickerModal')?.addEventListener('click', e => {
            if (e.target.id === 'viewerPickerModal') e.target.classList.remove('active');
        });
        document.addEventListener('keydown', e => {
            if (e.target.tagName === 'INPUT') return;
            if (e.key === 'Escape') document.getElementById('viewerPickerModal')?.classList.remove('active');
            if (e.key === 'ArrowLeft') document.getElementById('prevBtn').click();
            if (e.key === 'ArrowRight') document.getElementById('nextBtn').click();
        });
        // renderPage() replaces the whole canvas and re-creates every <img>;
        // a window drag would otherwise fire it dozens of times
        let resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => this.renderPage(), 200);
        });
    },

    // ─── 工具 ────────────────────────────────

    _showApproved(ts) {
        const btn = document.getElementById('approveBtn');
        if (btn) { btn.textContent = '✓ 已批准'; btn.disabled = true; btn.className = 'btn btn-approved'; }
        const badge = document.getElementById('approvedBadge');
        if (badge) {
            const dateStr = ts ? new Date(ts).toLocaleDateString('zh-TW') : '';
            badge.textContent = `✓ 已於 ${dateStr} 批准`;
            badge.style.display = '';
        }
    },

    _toast(msg, isError = false) {
        const t = document.createElement('div');
        t.textContent = msg;
        t.style.cssText = `position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
            background:${isError ? '#c0392b' : '#27ae60'};color:white;
            padding:10px 24px;border-radius:8px;font-size:0.85rem;
            z-index:9999;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,0.3);`;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 3000);
    },

    _setError(msg) {
        document.getElementById('pageArea').innerHTML =
            `<div class="state-msg error"><span class="icon">⚠</span><span>${msg}</span></div>`;
        document.getElementById('bookTitle').textContent = '載入失敗';
        document.getElementById('approveBtn').style.display = 'none';
    }
};

document.addEventListener('DOMContentLoaded', () => Viewer.init());
