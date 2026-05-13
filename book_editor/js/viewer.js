const Viewer = {
    book: null,
    currentPageIndex: 0,
    bookId: null,
    changedPages: new Set(),
    pickerSlotIdx: -1,

    async init() {
        const params = new URLSearchParams(location.search);
        this.bookId = params.get('id');
        if (!this.bookId) { this._setError('無效的分享連結'); return; }
        await this.loadBook();
        this.bindEvents();
    },

    async loadBook() {
        try {
            const r = await fetch(`${CONFIG.WORKER_URL}/api/books/${this.bookId}`);
            if (!r.ok) throw new Error('找不到此相本（連結可能已過期或無效）');
            this.book = await r.json();
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
            const r = await fetch(`${CONFIG.WORKER_URL}/api/books/${this.bookId}/status`);
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

        const counter = document.getElementById('pageCounter');
        if (counter) {
            const labels = { cover: '封面', 'back-cover': '封底' };
            const label = labels[page.type] || `第 ${this.currentPageIndex} 頁`;
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
                <div class="viewer-picker-photo" data-photo-id="${photo.id}" title="${photo.name}">
                    <img src="https://images.weserv.nl/?url=${CONFIG.WORKER_URL.replace(/^https?:\/\//, '')}/${photo.id}&w=200&q=75" loading="lazy">
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
            const resp = await fetch(`${CONFIG.WORKER_URL}/?list=${encodeURIComponent(folderPath)}`);
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
                    headers: { 'Content-Type': 'application/json' },
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
                headers: { 'Content-Type': 'application/json' }
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
        window.addEventListener('resize', () => this.renderPage());
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
