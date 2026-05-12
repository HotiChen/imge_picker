class BookEditor {
    constructor() {
        this.book = {
            name: '未命名相本',
            settings: { width: 20, height: 20, unit: 'cm', dpi: 300 },
            coverSettings: { width: 20, height: 20, unit: 'cm', dpi: 300 },
            pages: []
        };
        this.currentPageIndex = 0;
        this.pendingSlotIdx = -1;
        this.cropMode = false;
        this.cropSlotIdx = -1;
        this.cropDragState = null;
        this.libraryPhotos = [];

        this.init();
    }

    async init() {
        const customIds = LayoutEditor.loadSaved();
        customIds.forEach(id => this.addCustomLayoutBtn(id, LAYOUTS[id].name));

        if (!this.loadFromStorage()) {
            this._addPage('cover', 'full-bleed');
            this._addPage('inner', '2-up-h');
            this._addPage('inner', '2-up-h');
            this._addPage('back-cover', 'blank');
        }
        this.bindEvents();
        this.renderAll();
    }

    // ─── 頁面管理 ─────────────────────────────

    _addPage(type, layoutId) {
        const defaultLayouts = { cover: 'full-bleed', inner: '2-up-h', 'back-cover': 'blank' };
        const layout = layoutId || defaultLayouts[type] || '2-up-h';
        const layoutDef = LAYOUTS[layout];
        const page = {
            id: `page-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type,
            layout,
            slots: layoutDef.slots.map(() => ({ photoId: null, crop: { x: 0, y: 0, scale: 1 } })),
            bg: '#ffffff'
        };

        if (type === 'cover') {
            this.book.pages.unshift(page);
        } else if (type === 'back-cover') {
            this.book.pages.push(page);
        } else {
            const backIdx = this.book.pages.findIndex(p => p.type === 'back-cover');
            backIdx !== -1 ? this.book.pages.splice(backIdx, 0, page) : this.book.pages.push(page);
        }
        return page;
    }

    addInnerPage() {
        this._addPage('inner', '2-up-h');
        this.renderAll();
        this.saveToStorage();
    }

    deletePage(idx) {
        const page = this.book.pages[idx];
        if (!page || page.type !== 'inner') return;
        if (this.book.pages.filter(p => p.type === 'inner').length <= 1) {
            toast.warning('至少需要保留一頁內頁');
            return;
        }
        this.book.pages.splice(idx, 1);
        if (this.currentPageIndex >= this.book.pages.length) {
            this.currentPageIndex = this.book.pages.length - 1;
        }
        this.renderAll();
        this.saveToStorage();
    }

    setLayout(layoutId) {
        const page = this.book.pages[this.currentPageIndex];
        if (!page || !LAYOUTS[layoutId]) return;
        const existing = page.slots || [];
        page.layout = layoutId;
        page.slots = LAYOUTS[layoutId].slots.map((_, idx) =>
            existing[idx] || { photoId: null, crop: { x: 0, y: 0, scale: 1 } }
        );
        this.renderCurrentPage();
        this.renderPageList();
        this.saveToStorage();
    }

    setSlotPhoto(slotIdx, photoId) {
        const page = this.book.pages[this.currentPageIndex];
        if (!page) return;
        if (!page.slots[slotIdx]) page.slots[slotIdx] = {};
        page.slots[slotIdx].photoId = photoId;
        page.slots[slotIdx].crop = { x: 0, y: 0, scale: 1 };
        this.pendingSlotIdx = -1;
        this.closePhotoModal();
        this.renderCurrentPage();
        this.renderPageList();
        this.saveToStorage();
    }

    clearSlot(slotIdx) {
        const page = this.book.pages[this.currentPageIndex];
        if (!page || !page.slots[slotIdx]) return;
        page.slots[slotIdx] = { photoId: null, crop: { x: 0, y: 0, scale: 1 } };
        this.renderCurrentPage();
        this.renderPageList();
        this.saveToStorage();
    }

    // ─── 裁切模式 ─────────────────────────────

    enterCropMode(slotIdx) {
        this.cropMode = true;
        this.cropSlotIdx = slotIdx;
        this.renderCurrentPage(slotIdx);
        const bar = document.getElementById('cropModeBar');
        if (bar) bar.style.display = 'flex';
    }

    exitCropMode() {
        this.cropMode = false;
        this.cropSlotIdx = -1;
        this.cropDragState = null;
        this.renderCurrentPage();
        const bar = document.getElementById('cropModeBar');
        if (bar) bar.style.display = 'none';
        this.saveToStorage();
    }

    _updateSlotTransform(slotIdx) {
        const page = this.book.pages[this.currentPageIndex];
        if (!page || !page.slots[slotIdx]) return;
        const crop = page.slots[slotIdx].crop;
        const wrapper = document.querySelector(`[data-slot-idx="${slotIdx}"] .slot-crop-wrapper`);
        if (!wrapper) return;
        const scale = crop.scale || 1;
        const cropX = (crop.x || 0) * 100;
        const cropY = (crop.y || 0) * 100;
        wrapper.style.width = `${100 * scale}%`;
        wrapper.style.height = `${100 * scale}%`;
        wrapper.style.transform = `translate(calc(-50% + ${cropX}%), calc(-50% + ${cropY}%))`;
    }

    // ─── 照片庫 ──────────────────────────────

    async loadLibrary(folderPath) {
        const loadBtn = document.getElementById('libLoadBtn');
        if (loadBtn) loadBtn.disabled = true;
        try {
            const result = await driveManager.loadPhotosFromFolder(folderPath);
            this.libraryPhotos = result.photos || [];
            this.renderLibrary();
            toast.success(`載入 ${this.libraryPhotos.length} 張照片`);
        } catch (e) {
            toast.error('載入失敗');
        } finally {
            if (loadBtn) loadBtn.disabled = false;
        }
    }

    renderLibrary(targetEl) {
        const grid = targetEl || document.getElementById('libraryGrid');
        if (!grid) return;

        if (this.libraryPhotos.length === 0) {
            grid.innerHTML = '<div class="lib-empty">輸入路徑後點載入</div>';
            return;
        }

        grid.innerHTML = this.libraryPhotos.map(photo => `
            <div class="lib-photo" data-photo-id="${photo.id}" draggable="true" title="${photo.name}">
                <img src="${driveManager.getImageUrl(photo, true)}" loading="lazy">
            </div>
        `).join('');

        grid.querySelectorAll('.lib-photo').forEach(el => {
            el.addEventListener('dragstart', e => {
                e.dataTransfer.setData('text/plain', el.dataset.photoId);
            });
            el.addEventListener('click', () => {
                if (this.pendingSlotIdx >= 0) {
                    this.setSlotPhoto(this.pendingSlotIdx, el.dataset.photoId);
                }
            });
        });
    }

    // ─── 照片選取 Modal ──────────────────────

    openPhotoModal(slotIdx) {
        this.pendingSlotIdx = slotIdx;
        const modal = document.getElementById('photoPickerModal');
        if (!modal) return;
        modal.classList.add('active');

        // 渲染 modal 內的照片庫
        const grid = document.getElementById('modalLibraryGrid');
        if (!grid) return;

        if (this.libraryPhotos.length === 0) {
            grid.innerHTML = '<div class="lib-empty" style="padding:24px;text-align:center;">請先在左側載入照片庫</div>';
            return;
        }

        grid.innerHTML = this.libraryPhotos.map(photo => `
            <div class="modal-photo" data-photo-id="${photo.id}">
                <img src="${driveManager.getImageUrl(photo, true)}" loading="lazy">
                <div class="modal-photo-name">${photo.name}</div>
            </div>
        `).join('');

        grid.querySelectorAll('.modal-photo').forEach(el => {
            el.addEventListener('click', () => {
                this.setSlotPhoto(this.pendingSlotIdx, el.dataset.photoId);
            });
        });
    }

    closePhotoModal() {
        const modal = document.getElementById('photoPickerModal');
        if (modal) modal.classList.remove('active');
    }

    // ─── 渲染 ────────────────────────────────

    renderAll() {
        this.renderPageList();
        this.renderCurrentPage();
        this.updateLayoutSelector();
        this.updatePageNav();
    }

    renderPageList() {
        const list = document.getElementById('pageList');
        if (!list) return;

        list.innerHTML = this.book.pages.map((page, idx) => {
            const isActive = idx === this.currentPageIndex;
            const label = { cover: '封面', 'back-cover': '封底' }[page.type] || `第 ${idx} 頁`;
            return `
                <div class="page-thumb ${isActive ? 'active' : ''}" data-page-idx="${idx}">
                    <div class="page-thumb-preview">${renderPageThumbnailHTML(page)}</div>
                    <div class="page-thumb-label">${label}</div>
                    ${page.type === 'inner' ? `<button class="page-delete-btn" data-page-idx="${idx}" title="刪除">×</button>` : ''}
                </div>
            `;
        }).join('');

        list.querySelectorAll('.page-thumb').forEach(el => {
            el.addEventListener('click', e => {
                if (e.target.classList.contains('page-delete-btn')) return;
                this.exitCropMode();
                this.currentPageIndex = parseInt(el.dataset.pageIdx);
                this.renderAll();
            });
        });

        list.querySelectorAll('.page-delete-btn').forEach(el => {
            el.addEventListener('click', e => {
                e.stopPropagation();
                if (confirm('確定刪除這頁？')) this.deletePage(parseInt(el.dataset.pageIdx));
            });
        });
    }

    renderCurrentPage(cropSlotIdx = -1) {
        const area = document.getElementById('pagePreviewArea');
        if (!area) return;
        const page = this.book.pages[this.currentPageIndex];
        if (!page) { area.innerHTML = ''; return; }

        const settings = page.type === 'inner' ? this.book.settings : (this.book.coverSettings || this.book.settings);
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

        area.innerHTML = renderPageHTML(page, displayW, displayH, cropSlotIdx);

        const counter = document.getElementById('pageCounter');
        if (counter) counter.textContent = `${this.currentPageIndex + 1} / ${this.book.pages.length}`;

        this._bindSlotInteractions(displayW, displayH);
    }

    _bindSlotInteractions(displayW, displayH) {
        document.querySelectorAll('.page-slot').forEach(slotEl => {
            const slotIdx = parseInt(slotEl.dataset.slotIdx);
            const hasPhoto = slotEl.classList.contains('has-photo');

            // 清除按鈕
            const clearBtn = slotEl.querySelector('.slot-clear-btn');
            if (clearBtn) {
                clearBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    this.clearSlot(slotIdx);
                });
            }

            // 點擊格子
            slotEl.addEventListener('click', e => {
                if (e.target.classList.contains('slot-clear-btn')) return;
                if (this.cropMode && this.cropSlotIdx === slotIdx) return;
                if (hasPhoto) {
                    this.enterCropMode(slotIdx);
                } else {
                    this.openPhotoModal(slotIdx);
                }
            });

            // 拖放
            slotEl.addEventListener('dragover', e => e.preventDefault());
            slotEl.addEventListener('drop', e => {
                e.preventDefault();
                const photoId = e.dataTransfer.getData('text/plain');
                if (photoId) this.setSlotPhoto(slotIdx, photoId);
            });

            // 裁切拖移
            if (this.cropMode && this.cropSlotIdx === slotIdx) {
                slotEl.addEventListener('mousedown', e => {
                    if (e.target.classList.contains('slot-clear-btn')) return;
                    this.cropDragState = { lastX: e.clientX, lastY: e.clientY };
                    e.preventDefault();
                });

                slotEl.addEventListener('wheel', e => {
                    e.preventDefault();
                    const page = this.book.pages[this.currentPageIndex];
                    if (!page?.slots[slotIdx]) return;
                    const crop = page.slots[slotIdx].crop;
                    crop.scale = Math.max(1, Math.min(4, (crop.scale || 1) + (e.deltaY < 0 ? 0.1 : -0.1)));
                    this._updateSlotTransform(slotIdx);
                }, { passive: false });
            }
        });

        // 裁切模式全域 mousemove / mouseup
        if (this.cropMode) {
            const onMove = e => {
                if (!this.cropDragState) return;
                const page = this.book.pages[this.currentPageIndex];
                if (!page?.slots[this.cropSlotIdx]) return;

                const slotEl = document.querySelector(`[data-slot-idx="${this.cropSlotIdx}"]`);
                if (!slotEl) return;
                const rect = slotEl.getBoundingClientRect();
                const dx = (e.clientX - this.cropDragState.lastX) / rect.width;
                const dy = (e.clientY - this.cropDragState.lastY) / rect.height;

                const crop = page.slots[this.cropSlotIdx].crop;
                crop.x = (crop.x || 0) + dx;
                crop.y = (crop.y || 0) + dy;
                this.cropDragState = { lastX: e.clientX, lastY: e.clientY };
                this._updateSlotTransform(this.cropSlotIdx);
            };
            const onUp = () => { this.cropDragState = null; };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        }
    }

    addCustomLayoutBtn(id, name) {
        const grid = document.getElementById('layoutGrid');
        if (!grid || grid.querySelector(`[data-layout="${id}"]`)) return;

        const btn = document.createElement('button');
        btn.className = 'layout-btn';
        btn.dataset.layout = id;
        btn.title = name;

        const layout = LAYOUTS[id];
        const slotPreviews = (layout?.slots || []).map(s =>
            `<div style="position:absolute;left:${s.x}%;top:${s.y}%;width:${s.w}%;height:${s.h}%;background:rgba(255,255,255,0.15);border-radius:1px;"></div>`
        ).join('');
        btn.innerHTML = `<div class="layout-btn-preview" style="position:relative;">${slotPreviews}</div>`;

        btn.addEventListener('click', () => this.setLayout(id));
        grid.appendChild(btn);
    }

    updateLayoutSelector() {
        const page = this.book.pages[this.currentPageIndex];
        document.querySelectorAll('.layout-btn').forEach(btn => {
            btn.classList.toggle('active', page && btn.dataset.layout === page.layout);
        });
    }

    updatePageNav() {
        const prev = document.getElementById('prevPageBtn');
        const next = document.getElementById('nextPageBtn');
        if (prev) prev.disabled = this.currentPageIndex === 0;
        if (next) next.disabled = this.currentPageIndex === this.book.pages.length - 1;
    }

    // ─── 自動排版 ────────────────────────────

    async runAutoLayout() {
        if (this.libraryPhotos.length === 0) {
            toast.warning('請先載入照片庫');
            return;
        }
        const styleEl = document.getElementById('autoLayoutStyle');
        const style = styleEl?.value || 'magazine';

        const btn = document.getElementById('runAutoLayoutBtn');
        if (btn) btn.disabled = true;
        toast.info('正在分析照片方向並自動排版...');

        try {
            const innerPages = await AutoLayout.run(this.libraryPhotos, style);

            const cover = this.book.pages.find(p => p.type === 'cover') || this._addPage('cover', 'full-bleed');
            const back = this.book.pages.find(p => p.type === 'back-cover') || this._addPage('back-cover', 'blank');

            // 封面用第一張5星或第一張
            if (innerPages.length > 0 && innerPages[0].slots[0]?.photoId) {
                cover.slots[0] = { photoId: innerPages[0].slots[0].photoId, crop: { x: 0, y: 0, scale: 1 } };
            }

            this.book.pages = [cover, ...innerPages, back];
            this.currentPageIndex = 0;
            this.renderAll();
            this.saveToStorage();
            toast.success(`自動排版完成！共 ${this.book.pages.length} 頁（含封面封底）`);
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // ─── 儲存 / 讀取 ─────────────────────────

    saveToStorage() {
        try {
            localStorage.setItem('book_editor_state', JSON.stringify(this.book));
        } catch (e) { /* quota exceeded */ }
    }

    loadFromStorage() {
        try {
            const saved = localStorage.getItem('book_editor_state');
            if (saved) { this.book = JSON.parse(saved); return true; }
        } catch (e) {}
        return false;
    }

    // ─── 事件綁定 ────────────────────────────

    bindEvents() {
        // 書本名稱
        this._on('bookName', 'change', e => { this.book.name = e.target.value; this.saveToStorage(); });

        // 設定
        this._on('bookWidth', 'change', e => { this.book.settings.width = parseFloat(e.target.value) || 20; this.renderCurrentPage(); this.saveToStorage(); });
        this._on('bookHeight', 'change', e => { this.book.settings.height = parseFloat(e.target.value) || 20; this.renderCurrentPage(); this.saveToStorage(); });
        this._on('bookDpi', 'change', e => { this.book.settings.dpi = parseInt(e.target.value) || 300; this.saveToStorage(); });
        this._on('coverWidth', 'change', e => { this.book.coverSettings.width = parseFloat(e.target.value) || 20; this.saveToStorage(); });
        this._on('coverHeight', 'change', e => { this.book.coverSettings.height = parseFloat(e.target.value) || 20; this.saveToStorage(); });

        // 照片庫
        this._on('libLoadBtn', 'click', () => {
            const path = document.getElementById('libFolderInput')?.value.trim();
            if (path) this.loadLibrary(path);
        });
        this._on('libFolderInput', 'keydown', e => {
            if (e.key === 'Enter') { const path = e.target.value.trim(); if (path) this.loadLibrary(path); }
        });

        // 頁面導航
        this._on('prevPageBtn', 'click', () => {
            if (this.currentPageIndex > 0) { this.exitCropMode(); this.currentPageIndex--; this.renderAll(); }
        });
        this._on('nextPageBtn', 'click', () => {
            if (this.currentPageIndex < this.book.pages.length - 1) { this.exitCropMode(); this.currentPageIndex++; this.renderAll(); }
        });

        // 新增頁面
        this._on('addPageBtn', 'click', () => this.addInnerPage());

        // 版型按鈕
        document.querySelectorAll('.layout-btn').forEach(btn => {
            btn.addEventListener('click', () => this.setLayout(btn.dataset.layout));
        });

        // 裁切完成
        this._on('cropDoneBtn', 'click', () => this.exitCropMode());

        // 照片選取 Modal 關閉
        this._on('closePhotoModal', 'click', () => { this.pendingSlotIdx = -1; this.closePhotoModal(); });
        this._on('photoPickerModal', 'click', e => {
            if (e.target.id === 'photoPickerModal') { this.pendingSlotIdx = -1; this.closePhotoModal(); }
        });

        // 自動排版
        this._on('runAutoLayoutBtn', 'click', () => this.runAutoLayout());

        // 自訂版型編輯器
        this._on('openLayoutEditorBtn', 'click', () => {
            LayoutEditor.open();
            LayoutEditor.initCanvas();
        });
        this._on('closeLayoutEditorBtn', 'click', () => LayoutEditor.close());
        this._on('cancelLayoutEditorBtn', 'click', () => LayoutEditor.close());
        this._on('saveLayoutEditorBtn', 'click', () => LayoutEditor.save());
        this._on('layoutEditorModal', 'click', e => {
            if (e.target.id === 'layoutEditorModal') LayoutEditor.close();
        });

        // 匯出
        this._on('exportBtn', 'click', () => BookExporter.exportAll(this.book));

        // 清除所有資料
        this._on('clearBookBtn', 'click', () => {
            if (confirm('確定要清除相本並重新開始？')) {
                localStorage.removeItem('book_editor_state');
                this.book = { name: '未命名相本', settings: { width: 20, height: 20, unit: 'cm', dpi: 300 }, coverSettings: { width: 20, height: 20, unit: 'cm', dpi: 300 }, pages: [] };
                this._addPage('cover', 'full-bleed');
                this._addPage('inner', '2-up-h');
                this._addPage('inner', '2-up-h');
                this._addPage('back-cover', 'blank');
                this.currentPageIndex = 0;
                this.renderAll();
            }
        });

        // 鍵盤
        document.addEventListener('keydown', e => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (e.key === 'Escape' && this.cropMode) this.exitCropMode();
            if (e.key === 'ArrowLeft' && this.currentPageIndex > 0) { this.exitCropMode(); this.currentPageIndex--; this.renderAll(); }
            if (e.key === 'ArrowRight' && this.currentPageIndex < this.book.pages.length - 1) { this.exitCropMode(); this.currentPageIndex++; this.renderAll(); }
        });

        // Window resize
        let resizeTimer;
        window.addEventListener('resize', () => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => this.renderCurrentPage(this.cropMode ? this.cropSlotIdx : -1), 200);
        });
    }

    _on(id, event, cb) {
        const el = document.getElementById(id);
        if (el) el.addEventListener(event, cb);
    }
}

document.addEventListener('DOMContentLoaded', () => { window.bookEditor = new BookEditor(); });
