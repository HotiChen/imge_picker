class BookEditor {
    constructor() {
        this.book = {
            name: '未命名相本',
            clientFolders: [],
            settings: { width: 20, height: 20, unit: 'cm', dpi: 300 },
            coverSettings: { width: 20, height: 20, unit: 'cm', dpi: 300 },
            pages: []
        };
        this.currentPageIndex = 0;
        this.pendingSlotIdx = -1;
        this.cropMode = false;
        this.cropSlotIdx = -1;
        this.cropDragState = null;
        this.slotEditMode = false;
        this.slotPosDragState = null;
        this._slotPosMoveHandler = null;
        this._slotPosUpHandler = null;
        this.libraryPhotos = [];
        this.libAllPhotos = [];
        this.libFolderStack = [];
        this.libFilter = { minRating: 0 };
        this.showGuides = false;
        this._draggedPageIdx = -1;

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
        this.checkCloudStatus();
        if (!localStorage.getItem('book_editor_tour_done')) {
            setTimeout(() => TourGuide.start(), 800);
        }
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
            bg: '#ffffff',
            locked: false
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
        page.slots = LAYOUTS[layoutId].slots.map((_, idx) => {
            const old = existing[idx] || {};
            return { photoId: old.photoId || null, crop: old.crop || { x: 0, y: 0, scale: 1 } };
        });
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
        if (this.cropMode && this.cropSlotIdx === slotIdx) {
            this.cropMode = false;
            this.cropSlotIdx = -1;
            this.cropDragState = null;
            const bar = document.getElementById('cropModeBar');
            if (bar) bar.style.display = 'none';
        }
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

    enterSlotEditMode() {
        if (this.cropMode) this.exitCropMode();
        this.slotEditMode = true;
        this.renderCurrentPage();
        const bar = document.getElementById('slotEditModeBar');
        if (bar) bar.style.display = 'flex';
        const btn = document.getElementById('slotEditBtn');
        if (btn) { btn.style.borderColor = 'var(--primary)'; btn.style.color = 'var(--primary)'; }
    }

    exitSlotEditMode() {
        this.slotEditMode = false;
        this.renderCurrentPage();
        const bar = document.getElementById('slotEditModeBar');
        if (bar) bar.style.display = 'none';
        const btn = document.getElementById('slotEditBtn');
        if (btn) { btn.style.borderColor = ''; btn.style.color = ''; }
    }

    _bindSlotPositionEdit() {
        const area = document.getElementById('pagePreviewArea');
        const canvas = area?.querySelector('.page-canvas');
        if (!canvas) return;

        document.querySelectorAll('.page-slot').forEach(slotEl => {
            const slotIdx = parseInt(slotEl.dataset.slotIdx);
            slotEl.classList.add('slot-edit-active');

            ['nw', 'ne', 'se', 'sw'].forEach(dir => {
                const handle = document.createElement('div');
                handle.className = `slot-pos-handle pos-${dir}`;
                slotEl.appendChild(handle);
                handle.addEventListener('mousedown', e => {
                    e.preventDefault();
                    e.stopPropagation();
                    const rect = canvas.getBoundingClientRect();
                    this.slotPosDragState = {
                        type: 'resize', slotIdx, dir,
                        startX: e.clientX, startY: e.clientY,
                        cW: rect.width, cH: rect.height,
                        orig: this._getSlotGeometry(slotIdx)
                    };
                });
            });

            slotEl.addEventListener('mousedown', e => {
                if (e.target.classList.contains('slot-pos-handle')) return;
                e.preventDefault();
                const rect = canvas.getBoundingClientRect();
                this.slotPosDragState = {
                    type: 'move', slotIdx,
                    startX: e.clientX, startY: e.clientY,
                    cW: rect.width, cH: rect.height,
                    orig: this._getSlotGeometry(slotIdx)
                };
            });
        });

        this._slotPosMoveHandler = e => {
            if (!this.slotPosDragState) return;
            const d = this.slotPosDragState;
            const dx = (e.clientX - d.startX) / d.cW * 100;
            const dy = (e.clientY - d.startY) / d.cH * 100;
            const page = this.book.pages[this.currentPageIndex];
            if (!page) return;
            const slot = page.slots[d.slotIdx];
            if (!slot) return;
            const o = d.orig;

            if (d.type === 'move') {
                slot.override = {
                    x: Math.max(0, Math.min(100 - o.w, o.x + dx)),
                    y: Math.max(0, Math.min(100 - o.h, o.y + dy)),
                    w: o.w, h: o.h
                };
            } else {
                let { x, y, w, h } = { ...o };
                const dir = d.dir;
                if (dir.includes('n')) {
                    const newY = Math.min(o.y + dy, o.y + o.h - 5);
                    h = Math.max(5, o.h - (newY - o.y));
                    y = newY;
                }
                if (dir.includes('s')) h = Math.max(5, o.h + dy);
                if (dir.includes('e')) w = Math.max(5, o.w + dx);
                if (dir.includes('w')) {
                    const newX = Math.min(o.x + dx, o.x + o.w - 5);
                    w = Math.max(5, o.w - (newX - o.x));
                    x = newX;
                }
                slot.override = { x, y, w, h };
            }

            const slotEl = document.querySelector(`[data-slot-idx="${d.slotIdx}"]`);
            if (slotEl) {
                const g = slot.override;
                slotEl.style.left = g.x + '%';
                slotEl.style.top = g.y + '%';
                slotEl.style.width = g.w + '%';
                slotEl.style.height = g.h + '%';
                const lbl = document.getElementById('slotSizeLabel');
                if (lbl) { lbl.textContent = `W ${Math.round(g.w)}% × H ${Math.round(g.h)}%`; lbl.style.display = ''; }
            }
        };

        this._slotPosUpHandler = () => {
            if (this.slotPosDragState) {
                this.renderPageList();
                this.saveToStorage();
            }
            this.slotPosDragState = null;
            const lbl = document.getElementById('slotSizeLabel');
            if (lbl) lbl.style.display = 'none';
        };

        document.addEventListener('mousemove', this._slotPosMoveHandler);
        document.addEventListener('mouseup', this._slotPosUpHandler);
    }

    _getSlotGeometry(slotIdx) {
        const page = this.book.pages[this.currentPageIndex];
        if (!page) return { x: 0, y: 0, w: 50, h: 50 };
        const slot = page.slots[slotIdx];
        if (slot?.override) return { ...slot.override };
        const slotDef = LAYOUTS[page.layout]?.slots[slotIdx];
        if (!slotDef) return { x: 0, y: 0, w: 50, h: 50 };
        return { x: slotDef.x, y: slotDef.y, w: slotDef.w, h: slotDef.h };
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
        const img = wrapper.querySelector('img');
        if (img) img.style.objectPosition = `${50 + cropX}% ${50 + cropY}%`;
    }

    // ─── 照片庫 ──────────────────────────────

    async _fetchFolderDirect(folderPath) {
        if (folderPath && !folderPath.endsWith('/')) folderPath += '/';
        try {
            const url = `${CONFIG.WORKER_URL}/?list=${encodeURIComponent(folderPath)}`;
            const resp = await fetch(url);
            const result = await resp.json();
            if (result.status !== 'success') return { photos: [], folders: [] };
            const savedRatings = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.RATINGS) || '{}');
            const photos = result.data.map(f => ({
                id: f.id, name: f.name, size: f.size, uploaded: f.uploaded,
                rating: savedRatings[f.id] || 0
            }));
            return { photos, folders: result.folders || [] };
        } catch (e) {
            return { photos: [], folders: [] };
        }
    }

    async _loadFolderRecursive(folderPath) {
        const { photos, folders } = await this._fetchFolderDirect(folderPath);
        if (folders.length === 0) return photos;
        const subResults = await Promise.all(folders.map(f => this._loadFolderRecursive(f)));
        return photos.concat(...subResults);
    }

    _applyLibFilter() {
        const { minRating } = this.libFilter;
        this.libraryPhotos = minRating > 0
            ? this.libAllPhotos.filter(p => (p.rating || 0) >= minRating)
            : [...this.libAllPhotos];
        this.renderPhotoStrip();
    }

    renderPhotoStrip() {
        const strip = document.getElementById('photoStrip');
        const grid = document.getElementById('photoStripGrid');
        const countEl = document.getElementById('photoStripCount');
        if (!grid) return;
        if (this.libraryPhotos.length === 0) {
            if (strip) strip.style.display = 'none';
            return;
        }
        if (strip) strip.style.display = 'flex';
        if (countEl) countEl.textContent = `${this.libraryPhotos.length} 張`;
        grid.innerHTML = this.libraryPhotos.map(photo => {
            const stars = photo.rating > 0 ? `<div class="strip-photo-rating">${'★'.repeat(photo.rating)}</div>` : '';
            return `<div class="strip-photo" data-photo-id="${photo.id}" draggable="true" title="${photo.name}">
                <img src="${driveManager.getImageUrl(photo, true)}" loading="lazy">
                ${stars}
            </div>`;
        }).join('');
        grid.querySelectorAll('.strip-photo').forEach(el => {
            el.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', el.dataset.photoId));
            el.addEventListener('click', () => {
                if (this.pendingSlotIdx >= 0) this.setSlotPhoto(this.pendingSlotIdx, el.dataset.photoId);
            });
        });
    }

    async loadLibrary(folderPath) {
        if (!folderPath) { toast.warning('請輸入資料夾路徑'); return; }
        const loadBtn = document.getElementById('libLoadBtn');
        if (loadBtn) loadBtn.disabled = true;
        try {
            const { photos, folders } = await this._fetchFolderDirect(folderPath);
            this.libFolderStack = [folderPath];
            this._updateLibNav(folderPath);
            if (folders.length > 0) {
                this.libAllPhotos = [];
                this.libraryPhotos = [];
                const strip = document.getElementById('photoStrip');
                if (strip) strip.style.display = 'none';
                this.renderLibrary(null, folders);
                toast.success(`找到 ${folders.length} 個資料夾`);
            } else {
                this.libAllPhotos = photos;
                this._applyLibFilter();
                this.renderLibrary(null, []);
                toast.success(`共 ${this.libraryPhotos.length} 張照片`);
            }
        } catch (e) {
            toast.error('載入失敗');
        } finally {
            if (loadBtn) loadBtn.disabled = false;
        }
    }

    async navigateLibraryTo(folderPath) {
        const loadBtn = document.getElementById('libLoadBtn');
        if (loadBtn) loadBtn.disabled = true;
        toast.info('載入中...');
        try {
            const allPhotos = await this._loadFolderRecursive(folderPath);
            this.libAllPhotos = allPhotos;
            this.libFolderStack.push(folderPath);
            this.libFilter.minRating = 0;
            const ratingEl = document.getElementById('libFilterRating');
            if (ratingEl) ratingEl.value = '0';
            this._applyLibFilter();
            this._updateLibNav(folderPath);
            toast.success(`共 ${allPhotos.length} 張照片`);
        } catch (e) {
            toast.error('載入失敗');
        } finally {
            if (loadBtn) loadBtn.disabled = false;
        }
    }

    async navigateLibraryBack() {
        if (this.libFolderStack.length <= 1) return;
        this.libFolderStack.pop();
        const prev = this.libFolderStack[this.libFolderStack.length - 1];
        const loadBtn = document.getElementById('libLoadBtn');
        if (loadBtn) loadBtn.disabled = true;
        try {
            const { folders } = await this._fetchFolderDirect(prev);
            this.libAllPhotos = [];
            this.libraryPhotos = [];
            const strip = document.getElementById('photoStrip');
            if (strip) strip.style.display = 'none';
            this._updateLibNav(prev);
            this.renderLibrary(null, folders);
        } catch (e) {
            toast.error('載入失敗');
        } finally {
            if (loadBtn) loadBtn.disabled = false;
        }
    }

    _updateLibNav(currentPath) {
        const navRow = document.getElementById('libNavRow');
        const pathEl = document.getElementById('libCurrentPath');
        if (navRow) navRow.style.display = this.libFolderStack.length > 1 ? 'flex' : 'none';
        if (pathEl) pathEl.textContent = currentPath || '';
    }

    renderLibrary(targetEl, folders = []) {
        const grid = targetEl || document.getElementById('libraryGrid');
        if (!grid) return;
        if (folders.length === 0) {
            grid.innerHTML = `<div class="lib-empty">輸入路徑後點載入</div>`;
            return;
        }
        grid.innerHTML = folders.map(f => {
            const name = f.replace(/\/$/, '').split('/').pop();
            return `<div class="lib-folder" data-folder-path="${f}" title="${name}">
                <span style="font-size:1.2rem;">📁</span>
                <span class="lib-folder-name">${name}</span>
            </div>`;
        }).join('');
        grid.querySelectorAll('.lib-folder').forEach(el => {
            el.addEventListener('click', () => this.navigateLibraryTo(el.dataset.folderPath));
            el.addEventListener('mouseenter', () => el.style.borderColor = 'rgba(243,128,32,0.5)');
            el.addEventListener('mouseleave', () => el.style.borderColor = 'transparent');
        });
    }

    _getPlacedPhotoIds() {
        const ids = new Set();
        this.book.pages.forEach(page => page.slots.forEach(s => { if (s.photoId) ids.add(s.photoId); }));
        return ids;
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
                <div class="page-thumb ${isActive ? 'active' : ''} ${page.locked ? 'locked' : ''}" data-page-idx="${idx}">
                    <div class="page-thumb-preview">${renderPageThumbnailHTML(page)}</div>
                    <div class="page-thumb-label">${label}</div>
                    ${page.type === 'inner' ? `<button class="page-delete-btn" data-page-idx="${idx}" title="刪除">×</button>` : ''}
                    <button class="page-lock-btn" data-page-idx="${idx}" title="${page.locked ? '解鎖此頁' : '鎖定此頁'}">${page.locked ? '🔒' : '🔓'}</button>
                </div>
            `;
        }).join('');

        list.querySelectorAll('.page-thumb').forEach(el => {
            const idx = parseInt(el.dataset.pageIdx);
            const page = this.book.pages[idx];

            el.addEventListener('click', e => {
                if (e.target.classList.contains('page-delete-btn')) return;
                if (e.target.classList.contains('page-lock-btn')) return;
                this.exitCropMode();
                this.currentPageIndex = idx;
                this.renderAll();
            });

            // drag-to-reorder (inner pages only)
            if (page?.type === 'inner') {
                el.setAttribute('draggable', 'true');
                el.addEventListener('dragstart', e => {
                    this._draggedPageIdx = idx;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/page-drag', String(idx));
                    el.style.opacity = '0.5';
                });
                el.addEventListener('dragend', () => {
                    el.style.opacity = '';
                    this._draggedPageIdx = -1;
                    list.querySelectorAll('.page-thumb').forEach(t => t.classList.remove('drag-over'));
                });
                el.addEventListener('dragover', e => {
                    if (this._draggedPageIdx < 0 || !e.dataTransfer.types.includes('text/page-drag')) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    list.querySelectorAll('.page-thumb').forEach(t => t.classList.remove('drag-over'));
                    el.classList.add('drag-over');
                });
                el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
                el.addEventListener('drop', e => {
                    e.preventDefault();
                    el.classList.remove('drag-over');
                    const from = this._draggedPageIdx;
                    const to = idx;
                    if (from === to || from < 0) return;
                    if (this.book.pages[from]?.type !== 'inner' || this.book.pages[to]?.type !== 'inner') return;
                    const [moved] = this.book.pages.splice(from, 1);
                    this.book.pages.splice(to, 0, moved);
                    if (this.currentPageIndex === from) this.currentPageIndex = to;
                    else if (from < to && this.currentPageIndex > from && this.currentPageIndex <= to) this.currentPageIndex--;
                    else if (from > to && this.currentPageIndex >= to && this.currentPageIndex < from) this.currentPageIndex++;
                    this.renderAll();
                    this.saveToStorage();
                });
            }
        });

        list.querySelectorAll('.page-delete-btn').forEach(el => {
            el.addEventListener('click', e => {
                e.stopPropagation();
                if (confirm('確定刪除這頁？')) this.deletePage(parseInt(el.dataset.pageIdx));
            });
        });

        list.querySelectorAll('.page-lock-btn').forEach(el => {
            el.addEventListener('click', e => {
                e.stopPropagation();
                this.togglePageLock(parseInt(el.dataset.pageIdx));
            });
        });
    }

    togglePageLock(idx) {
        const page = this.book.pages[idx];
        if (!page) return;
        page.locked = !page.locked;
        this.renderPageList();
        this.saveToStorage();
        toast.success(page.locked ? '🔒 已鎖定此頁' : '🔓 已解鎖此頁');
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

        const canvas = area.querySelector('.page-canvas');
        if (canvas) {
            if (this.showGuides) {
                this._appendGuides(canvas, displayW, displayH, settings);
            } else {
                canvas.style.boxShadow = '';
            }
        }

        const counterText = `${this.currentPageIndex + 1} / ${this.book.pages.length}`;
        const counter = document.getElementById('pageCounter');
        if (counter) counter.textContent = counterText;
        const counterBot = document.getElementById('pageCounterBot');
        if (counterBot) counterBot.textContent = counterText;

        const bgInput = document.getElementById('pageBgColor');
        if (bgInput) bgInput.value = page.bg || '#ffffff';

        this._bindSlotInteractions(displayW, displayH);

        // 攔截整個預覽區的 dragover/drop，防止瀏覽器顯示原生「拖放檔案」UI
        const area2 = document.getElementById('pagePreviewArea');
        if (area2) {
            area2.addEventListener('dragover', e => e.preventDefault(), { capture: true });
            area2.addEventListener('drop',     e => e.preventDefault(), { capture: true });
        }
    }

    _appendGuides(canvas, displayW, displayH, settings) {
        // mm → px at current display scale
        const bleedMm = 3, safeMm = 3;
        const scaleX = displayW / (settings.width * 10);   // px per mm
        const scaleY = displayH / (settings.height * 10);
        const bleedX = bleedMm * scaleX, bleedY = bleedMm * scaleY;
        const safeX  = safeMm  * scaleX, safeY  = safeMm  * scaleY;

        canvas.style.position = 'relative';
        // bleed shown as box-shadow (outside trim, no overflow change needed)
        canvas.style.boxShadow = `0 0 0 ${Math.round(bleedX)}px rgba(220,50,50,0.35)`;

        const el = document.createElement('div');
        el.className = 'guide-overlay';
        el.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:20;overflow:visible;';
        el.innerHTML = `
            <div style="position:absolute;top:${safeY}px;left:${safeX}px;right:${safeX}px;bottom:${safeY}px;border:1px dashed rgba(66,133,244,0.8);pointer-events:none;"></div>
            <div style="position:absolute;top:0;bottom:0;left:50%;width:1px;background:rgba(40,200,100,0.7);transform:translateX(-0.5px);pointer-events:none;"></div>
            <span style="position:absolute;top:-18px;left:0;font-size:9px;color:rgba(220,50,50,0.9);background:rgba(0,0,0,0.55);padding:1px 5px;border-radius:2px;white-space:nowrap;">← 出血 ${bleedMm}mm →</span>
            <span style="position:absolute;top:${safeY+2}px;left:${safeX+3}px;font-size:9px;color:rgba(100,160,255,0.95);background:rgba(0,0,0,0.55);padding:1px 5px;border-radius:2px;white-space:nowrap;">安全邊距 ${safeMm}mm</span>
            <span style="position:absolute;top:4px;left:50%;transform:translateX(-50%);font-size:9px;color:rgba(40,200,100,0.95);background:rgba(0,0,0,0.55);padding:1px 5px;border-radius:2px;white-space:nowrap;">書脊</span>
        `;
        canvas.appendChild(el);
    }

    _bindSlotInteractions(displayW, displayH) {
        // Remove old global listeners before (re)binding
        if (this._cropMoveHandler) {
            document.removeEventListener('mousemove', this._cropMoveHandler);
            document.removeEventListener('mouseup', this._cropUpHandler);
            this._cropMoveHandler = null;
            this._cropUpHandler = null;
        }
        if (this._slotPosMoveHandler) {
            document.removeEventListener('mousemove', this._slotPosMoveHandler);
            document.removeEventListener('mouseup', this._slotPosUpHandler);
            this._slotPosMoveHandler = null;
            this._slotPosUpHandler = null;
        }

        if (this.slotEditMode) {
            this._bindSlotPositionEdit();
            return;
        }

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

            // 空格子：點擊選照片
            if (!hasPhoto) {
                slotEl.addEventListener('click', e => {
                    if (e.target.classList.contains('slot-clear-btn')) return;
                    this.openPhotoModal(slotIdx);
                });
            }

            // 拖放
            slotEl.addEventListener('dragover', e => e.preventDefault());
            slotEl.addEventListener('drop', e => {
                e.preventDefault();
                const photoId = e.dataTransfer.getData('text/plain');
                if (photoId) this.setSlotPhoto(slotIdx, photoId);
            });

            // 有照片的格子：mousedown 直接進入裁切 + 開始拖移（單一手勢）
            if (hasPhoto) {
                slotEl.addEventListener('mousedown', e => {
                    if (e.target.classList.contains('slot-clear-btn')) return;
                    e.preventDefault();
                    if (!this.cropMode || this.cropSlotIdx !== slotIdx) {
                        this.enterCropMode(slotIdx);
                    }
                    this.cropDragState = { lastX: e.clientX, lastY: e.clientY };
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

        // 全域 mousemove / mouseup（只保留一組）
        this._cropMoveHandler = e => {
            if (!this.cropDragState || !this.cropMode) return;
            const page = this.book.pages[this.currentPageIndex];
            if (!page?.slots[this.cropSlotIdx]) return;

            const slotEl = document.querySelector(`[data-slot-idx="${this.cropSlotIdx}"]`);
            if (!slotEl) return;
            const rect = slotEl.getBoundingClientRect();
            const dx = (e.clientX - this.cropDragState.lastX) / rect.width;
            const dy = (e.clientY - this.cropDragState.lastY) / rect.height;

            const crop = page.slots[this.cropSlotIdx].crop;
            crop.x = Math.max(-0.5, Math.min(0.5, (crop.x || 0) + dx));
            crop.y = Math.max(-0.5, Math.min(0.5, (crop.y || 0) + dy));
            this.cropDragState = { lastX: e.clientX, lastY: e.clientY };
            this._updateSlotTransform(this.cropSlotIdx);
        };
        this._cropUpHandler = () => { this.cropDragState = null; };

        document.addEventListener('mousemove', this._cropMoveHandler);
        document.addEventListener('mouseup', this._cropUpHandler);
    }

    addCustomLayoutBtn(id, name) {
        const grid = document.getElementById('layoutGrid');
        if (!grid || grid.querySelector(`[data-layout="${id}"]`)) return;

        const wrapper = document.createElement('div');
        wrapper.className = 'layout-btn-wrapper';
        wrapper.dataset.layoutId = id;

        const btn = document.createElement('button');
        btn.className = 'layout-btn';
        btn.dataset.layout = id;
        btn.title = name;

        const layout = LAYOUTS[id];
        const slotPreviews = (layout?.slots || []).map(s =>
            `<div style="position:absolute;left:${s.x}%;top:${s.y}%;width:${s.w}%;height:${s.h}%;background:rgba(255,255,255,0.15);border-radius:1px;"></div>`
        ).join('');
        btn.innerHTML = `<div class="layout-btn-preview">${slotPreviews}</div>`;
        btn.addEventListener('click', () => this.setLayout(id));

        const delBtn = document.createElement('button');
        delBtn.className = 'layout-btn-del';
        delBtn.title = '刪除版型';
        delBtn.textContent = '×';
        delBtn.addEventListener('click', e => {
            e.stopPropagation();
            if (!confirm(`確定刪除版型「${name}」？`)) return;
            LayoutEditor.deleteCustom(id);
            wrapper.remove();
        });

        wrapper.appendChild(btn);
        wrapper.appendChild(delBtn);
        grid.appendChild(wrapper);
    }

    updateLayoutSelector() {
        const page = this.book.pages[this.currentPageIndex];
        document.querySelectorAll('.layout-btn').forEach(btn => {
            btn.classList.toggle('active', page && btn.dataset.layout === page.layout);
        });
    }

    updatePageNav() {
        const atStart = this.currentPageIndex === 0;
        const atEnd = this.currentPageIndex === this.book.pages.length - 1;
        ['prevPageBtn', 'prevPageBtnBot'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.disabled = atStart;
        });
        ['nextPageBtn', 'nextPageBtnBot'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.disabled = atEnd;
        });
    }

    // ─── 自動排版 ────────────────────────────

    async runAutoLayout() {
        if (this.libraryPhotos.length === 0) {
            toast.warning('請先載入照片庫');
            return;
        }
        const innerCount = this.book.pages.filter(p => p.type === 'inner').length;
        if (innerCount > 0) {
            if (!confirm(`自動排版將取代目前所有 ${innerCount} 張內頁（封面與封底保留）。確定繼續？`)) return;
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

    // ─── 雲端分享 ────────────────────────────

    _generateId() {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    }

    async openShareModal() {
        document.getElementById('shareFolderStep').style.display = '';
        document.getElementById('shareUrlStep').style.display = 'none';
        document.getElementById('shareModal')?.classList.add('active');
        await this._renderShareFolders();
    }

    async _renderShareFolders() {
        const container = document.getElementById('shareFolderList');
        if (!container) return;

        const rootPath = this.libFolderStack[0];
        if (!rootPath) {
            container.innerHTML = '<p style="font-size:0.75rem;color:var(--text-muted);">請先在右側載入照片素材庫，才能選擇資料夾。</p>';
            return;
        }

        container.innerHTML = '<p style="font-size:0.75rem;color:var(--text-muted);">載入中...</p>';
        const { folders } = await this._fetchFolderDirect(rootPath);

        if (folders.length === 0) {
            // 根目錄本身就是唯一資料夾
            const checked = (this.book.clientFolders || []).length === 0
                || (this.book.clientFolders || []).includes(rootPath);
            container.innerHTML = `<label class="share-folder-item">
                <input type="checkbox" class="share-folder-cb" value="${rootPath}" ${checked ? 'checked' : ''}>
                <span>📁 ${rootPath.replace(/\/$/, '').split('/').pop() || rootPath}</span>
            </label>`;
            return;
        }

        const current = new Set(this.book.clientFolders || []);
        container.innerHTML = folders.map(f => {
            const name = f.replace(/\/$/, '').split('/').pop();
            const checked = current.size === 0 || current.has(f);
            return `<label class="share-folder-item">
                <input type="checkbox" class="share-folder-cb" value="${f}" ${checked ? 'checked' : ''}>
                <span>📁 ${name}</span>
            </label>`;
        }).join('');
    }

    async saveToCloud() {
        const clientFolders = [...document.querySelectorAll('.share-folder-cb:checked')].map(el => el.value);
        this.book.clientFolders = clientFolders;

        const btn = document.getElementById('shareConfirmBtn');
        if (btn) { btn.disabled = true; btn.textContent = '儲存中...'; }
        try {
            if (!this.book.cloudId) this.book.cloudId = this._generateId();
            const id = this.book.cloudId;

            const headers = { 'Content-Type': 'application/json' };
            if (CONFIG.PHOTOGRAPHER_TOKEN) headers['Authorization'] = `Bearer ${CONFIG.PHOTOGRAPHER_TOKEN}`;

            const r = await fetch(`${CONFIG.WORKER_URL}/api/books/${id}`, {
                method: 'PUT',
                headers,
                body: JSON.stringify(this.book)
            });
            if (!r.ok) throw new Error('雲端儲存失敗（' + r.status + '）');

            this.saveToStorage();

            const viewUrl = new URL(`view.html?id=${id}`, window.location.href).href;
            const urlInput = document.getElementById('shareUrl');
            if (urlInput) urlInput.value = viewUrl;

            document.getElementById('shareFolderStep').style.display = 'none';
            document.getElementById('shareUrlStep').style.display = '';
            this.checkCloudStatus();
        } catch (e) {
            toast.error(e.message || '分享失敗，請確認網路連線');
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '儲存並產生分享連結 →'; }
        }
    }

    async checkCloudStatus() {
        if (!this.book.cloudId) return;
        try {
            const r = await fetch(`${CONFIG.WORKER_URL}/api/books/${this.book.cloudId}/status`);
            if (!r.ok) return;
            const data = await r.json();
            const el = document.getElementById('cloudStatusIndicator');
            if (el) {
                if (data.approved) {
                    el.textContent = '✓ 客戶已批准';
                    el.style.color = '#27ae60';
                } else {
                    el.textContent = '☁ 已分享';
                    el.style.color = '#9fa8da';
                }
            }
        } catch (e) {}
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
            const path = document.getElementById('libFolderInput')?.value.trim() || '';
            this.loadLibrary(path);
        });
        this._on('libFolderInput', 'keydown', e => {
            if (e.key === 'Enter') { const path = e.target.value.trim(); this.loadLibrary(path); }
        });
        this._on('libBackBtn', 'click', () => this.navigateLibraryBack());
        this._on('libFilterRating', 'change', e => {
            this.libFilter.minRating = parseInt(e.target.value) || 0;
            this._applyLibFilter();
            this.renderLibrary();
        });

        // 頁面導航（頂欄 + 底部）
        const goPrev = () => {
            if (this.currentPageIndex > 0) { this.exitCropMode(); this.currentPageIndex--; this.renderAll(); }
        };
        const goNext = () => {
            if (this.currentPageIndex < this.book.pages.length - 1) { this.exitCropMode(); this.currentPageIndex++; this.renderAll(); }
        };
        this._on('prevPageBtn', 'click', goPrev);
        this._on('nextPageBtn', 'click', goNext);
        this._on('prevPageBtnBot', 'click', goPrev);
        this._on('nextPageBtnBot', 'click', goNext);

        // 頁面背景色
        const applyBg = color => {
            const page = this.book.pages[this.currentPageIndex];
            if (!page) return;
            page.bg = color;
            const canvas = document.querySelector('.page-canvas');
            if (canvas) canvas.style.background = color;
            this.renderPageList();
            this.saveToStorage();
        };
        this._on('pageBgColor', 'input', e => applyBg(e.target.value));
        this._on('pageBgWhiteBtn', 'click', () => { applyBg('#ffffff'); const i = document.getElementById('pageBgColor'); if (i) i.value = '#ffffff'; });
        this._on('pageBgBlackBtn', 'click', () => { applyBg('#000000'); const i = document.getElementById('pageBgColor'); if (i) i.value = '#000000'; });

        // 新增頁面
        this._on('addPageBtn', 'click', () => this.addInnerPage());

        // 版型按鈕
        document.querySelectorAll('.layout-btn').forEach(btn => {
            btn.addEventListener('click', () => this.setLayout(btn.dataset.layout));
        });

        // 裁切完成
        this._on('cropDoneBtn', 'click', () => this.exitCropMode());

        // 格位調整
        this._on('slotEditBtn', 'click', () => { if (this.slotEditMode) this.exitSlotEditMode(); else this.enterSlotEditMode(); });
        this._on('slotEditDoneBtn', 'click', () => this.exitSlotEditMode());

        // 照片選取 Modal 關閉
        this._on('closePhotoModal', 'click', () => { this.pendingSlotIdx = -1; this.closePhotoModal(); });
        this._on('photoPickerModal', 'click', e => {
            if (e.target.id === 'photoPickerModal') { this.pendingSlotIdx = -1; this.closePhotoModal(); }
        });

        // 自動排版
        this._on('runAutoLayoutBtn', 'click', () => this.runAutoLayout());
        this._on('runAutoLayoutTopBtn', 'click', () => this.runAutoLayout());
        this._on('shortcutsBtn', 'click', () => TourGuide.start());

        // 參考線 toggle
        this._on('guideToggleBtn', 'click', () => {
            this.showGuides = !this.showGuides;
            const btn = document.getElementById('guideToggleBtn');
            if (btn) {
                btn.style.borderColor = this.showGuides ? 'var(--primary)' : '';
                btn.style.color = this.showGuides ? 'var(--primary)' : '';
                btn.textContent = this.showGuides ? '⊞ 參考線 ✓' : '⊞ 參考線';
            }
            this.renderCurrentPage(this.cropMode ? this.cropSlotIdx : -1);
        });

        // 分享 / 雲端
        this._on('shareBtn', 'click', () => this.openShareModal());
        this._on('shareConfirmBtn', 'click', () => this.saveToCloud());
        this._on('closeShareModalBtn', 'click', () => document.getElementById('shareModal')?.classList.remove('active'));
        this._on('shareModal', 'click', e => { if (e.target.id === 'shareModal') document.getElementById('shareModal').classList.remove('active'); });
        this._on('copyShareUrlBtn', 'click', () => {
            const url = document.getElementById('shareUrl')?.value;
            if (!url) return;
            navigator.clipboard?.writeText(url)
                .then(() => toast.success('已複製連結'))
                .catch(() => {
                    const el = document.getElementById('shareUrl');
                    el.select();
                    document.execCommand('copy');
                    toast.success('已複製連結');
                });
        });

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
                this.book = { name: '未命名相本', clientFolders: [], settings: { width: 20, height: 20, unit: 'cm', dpi: 300 }, coverSettings: { width: 20, height: 20, unit: 'cm', dpi: 300 }, pages: [] };
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
            if (e.key === 'Escape') {
                if (this.cropMode) this.exitCropMode();
                else if (this.slotEditMode) this.exitSlotEditMode();
            }
            if (e.key === 'ArrowLeft' && this.currentPageIndex > 0) { this.exitCropMode(); this.currentPageIndex--; this.renderAll(); }
            if (e.key === 'ArrowRight' && this.currentPageIndex < this.book.pages.length - 1) { this.exitCropMode(); this.currentPageIndex++; this.renderAll(); }
            if ((e.key === 'Delete' || e.key === 'Backspace') && this.cropMode && this.cropSlotIdx >= 0) {
                this.clearSlot(this.cropSlotIdx);
            }
            if (e.key === '?') {
                toast.info('快速鍵：← → 翻頁 · ESC 退出模式 · Delete 清除格子照片 · 滾輪 縮放裁切');
            }
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
