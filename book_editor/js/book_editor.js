class BookEditor {
    constructor() {
        this.currentBookId = null;
        this.book = {
            name: '未命名相本',
            clientFolders: [],
            notifyUrl: '',
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
        this.selectedTextLayerId = null;
        this._textDragState = null;
        this._textMoveHandler = null;
        this._textUpHandler = null;
        this._wheelSaveTimer = null;
        this.libraryPhotos = [];
        this.libAllPhotos = [];
        this.libFolderStack = [];
        this.libFilter = { minRating: 0 };
        this.showGuides = false;
        this._draggedPageIdx = -1;

        this.init();
    }

    /**
     * Initializes the Book Editor application, setting up the active book state, registering
     * custom layouts, binding events, and rendering pages.
     * Pre-conditions:
     *   - Document DOM must be ready.
     *   - `localStorage` and `location.search` must be accessible.
     * Post-conditions:
     *   - Sets `this.currentBookId` and retrieves or generates book data.
     *   - Registers custom layouts with existence checks to prevent crashes.
     *   - Binds UI event listeners and performs initial rendering.
     *   - Captures any startup errors, logging them and displaying a toast notification.
     */
    async init() {
        try {
            const customIds = LayoutEditor.loadSaved();
            customIds.forEach(id => {
                // Why: Defend against missing or corrupted custom layout definitions in LAYOUTS
                if (LAYOUTS[id] && LAYOUTS[id].name) {
                    this.addCustomLayoutBtn(id, LAYOUTS[id].name);
                }
            });

            const { id, showModal } = this._initBookId();
            this.currentBookId = id;

            let isLoaded = false;
            try {
                isLoaded = this.loadFromStorage();
            } catch (loadErr) {
                console.error("Error reading book from storage, falling back to new book:", loadErr);
            }

            if (!isLoaded) {
                this._addPage('cover', 'full-bleed');
                this._addPage('inner', '2-up-h');
                this._addPage('inner', '2-up-h');
                this._addPage('back-cover', 'blank');
            } else {
                // Why: Persist the sanitized/upgraded structure back to storage immediately
                this.saveToStorage();
            }

            // Why: Ensure the current page index is within the boundaries of loaded pages
            if (this.currentPageIndex >= this.book.pages.length) {
                this.currentPageIndex = Math.max(0, this.book.pages.length - 1);
            }

            this.bindEvents();
            this.renderAll();
            this.checkCloudStatus();

            if (showModal) {
                setTimeout(() => this.openBooksModal(), 300);
            }

            // Import photos handed over from main picker
            const importRaw = localStorage.getItem('book_editor_import');
            if (importRaw) {
                localStorage.removeItem('book_editor_import');
                try {
                    const { folderPath } = JSON.parse(importRaw);
                    if (folderPath) {
                        const input = document.getElementById('libFolderInput');
                        if (input) input.value = folderPath;
                        toast.info('正在從選圖頁匯入照片庫...');
                        setTimeout(() => this.loadLibrary(folderPath), 400);
                    }
                } catch (e) {}
            }

            if (!localStorage.getItem('book_editor_tour_done')) {
                setTimeout(() => TourGuide.start(), 800);
            }
        } catch (err) {
            console.error("Failed to initialize book editor:", err);
            toast.error("載入相本失敗: " + err.message, 10000);
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
            bgImage: null,
            textLayers: [],
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

        // Cache all photo assignments so they survive switching through blank or fewer-slot layouts
        page._photoCache = page._photoCache || {};
        (page.slots || []).forEach((slot, i) => {
            if (slot.photoId) page._photoCache[i] = { photoId: slot.photoId, crop: slot.crop, fit: slot.fit };
        });

        const existing = page.slots || [];
        page.layout = layoutId;
        page.slots = LAYOUTS[layoutId].slots.map((_, idx) => {
            const old = existing[idx] || page._photoCache[idx] || {};
            const s = { photoId: old.photoId || null, crop: old.crop || { x: 0, y: 0, scale: 1 } };
            if (old.fit) s.fit = old.fit;
            return s;
        });
        this.renderCurrentPage();
        this._updatePageThumbnail(this.currentPageIndex);
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
        this._updatePageThumbnail(this.currentPageIndex);
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
        this._updatePageThumbnail(this.currentPageIndex);
        this.saveToStorage();
    }

    // ─── 裁切模式 ─────────────────────────────

    /**
     * Enters the crop mode for a specific slot.
     * Pre-conditions:
     *   - `slotIdx` must be a valid, non-negative integer index within current page slots.
     *   - The slot must have a photo assigned.
     * Post-conditions:
     *   - `this.cropMode` is set to true.
     *   - `this.cropSlotIdx` is set to `slotIdx`.
     *   - Dynamically updates slot DOM classes and appends helper hints without rebuilding the DOM.
     *   - Displays crop mode control bar and updates corresponding crop/scale parameters.
     */
    enterCropMode(slotIdx) {
        this.cropMode = true;
        this.cropSlotIdx = slotIdx;
        
        // 1. 動態更新 DOM 狀態，避免 renderCurrentPage() 重新產生 DOM 導致滑鼠捕獲 (Mouse Capture) 中斷
        document.querySelectorAll('.page-slot').forEach(el => {
            el.classList.remove('crop-active');
            el.querySelector('.crop-hint')?.remove();
            el.querySelector('.slot-debug-overlay')?.remove();
        });
        
        const slotEl = document.querySelector(`[data-slot-idx="${slotIdx}"]`);
        if (slotEl) {
            slotEl.classList.add('crop-active');
            // 補上裁切提示文字
            if (!slotEl.querySelector('.crop-hint')) {
                const hint = document.createElement('div');
                hint.className = 'crop-hint';
                hint.textContent = '拖移平移 · 滾輪縮放';
                slotEl.appendChild(hint);
            }
        }
        
        const bar = document.getElementById('cropModeBar');
        if (bar) { bar.style.display = 'flex'; bar.classList.add('bar-flash'); setTimeout(() => bar.classList.remove('bar-flash'), 600); }
        const page = this.book.pages[this.currentPageIndex];
        this._updateFitToggleBtn(page?.slots[slotIdx]?.fit || 'cover');
        this._updateRotationUI(slotIdx);
        this._updateZoomUI(slotIdx);
        this._updateSlotTransform(slotIdx);
        if (!localStorage.getItem('book_editor_crop_hinted')) {
            localStorage.setItem('book_editor_crop_hinted', '1');
            toast.info('裁切模式：拖移平移 · 滾輪縮放 · 點「完整顯示」可切換顯示方式');
        }
    }

    _showSlotContextMenu(slotIdx, clientX, clientY) {
        document.getElementById('slotCtxMenu')?.remove();

        const page = this.book.pages[this.currentPageIndex];
        const slot = page?.slots[slotIdx];
        const hasPhoto = !!slot?.photoId;
        const currentFit = slot?.fit || 'cover';

        const menu = document.createElement('div');
        menu.id = 'slotCtxMenu';
        menu.className = 'slot-ctx-menu';

        const fitItems = [
            { label: '填滿',     fit: 'cover',      icon: '⊞' },
            { label: '完整顯示', fit: 'contain',    icon: '⊟' },
            { label: '適合寬度', fit: 'fit-width',  icon: '↔' },
            { label: '適合高度', fit: 'fit-height', icon: '↕' },
        ];

        if (hasPhoto) {
            const currentRot = Math.round(slot?.crop?.rotation || 0);
            menu.innerHTML =
                fitItems.map(it =>
                    `<button class="ctx-item${it.fit === currentFit ? ' ctx-item--active' : ''}" data-fit="${it.fit}">
                        <span class="ctx-icon">${it.icon}</span>${it.label}
                    </button>`
                ).join('') +
                `<div class="ctx-sep"></div>
                 <button class="ctx-item" data-action="reset"><span class="ctx-icon">⊙</span>置中重置</button>
                 <div class="ctx-sep"></div>
                 <button class="ctx-item" data-action="rot90"><span class="ctx-icon">↻</span>旋轉 +90°</button>
                 <button class="ctx-item" data-action="rot-90"><span class="ctx-icon">↺</span>旋轉 -90°</button>
                 <button class="ctx-item" data-action="rot180"><span class="ctx-icon">🔃</span>旋轉 180°</button>
                 <button class="ctx-item${currentRot !== 0 ? '' : ' ctx-item--disabled'}" data-action="rot0"><span class="ctx-icon">⊘</span>重置旋轉 (${currentRot}°→0°)</button>
                 <div class="ctx-sep"></div>
                 <button class="ctx-item ctx-item--danger" data-action="clear"><span class="ctx-icon">✕</span>清除照片</button>`;
        } else {
            menu.innerHTML = `<button class="ctx-item" data-action="pick"><span class="ctx-icon">+</span>放入照片</button>`;
        }

        document.body.appendChild(menu);
        const mRect = menu.getBoundingClientRect();
        menu.style.left = Math.min(clientX, window.innerWidth  - mRect.width  - 8) + 'px';
        menu.style.top  = Math.min(clientY, window.innerHeight - mRect.height - 8) + 'px';

        menu.querySelectorAll('.ctx-item').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                menu.remove();
                const fit    = btn.dataset.fit;
                const action = btn.dataset.action;
                if (fit) {
                    this._applyFitPreset(slotIdx, fit);
                } else if (action === 'reset') {
                    const s = page?.slots[slotIdx];
                    if (s) { s.crop = { x: 0, y: 0, scale: 1, rotation: 0 }; s.fit = 'cover'; }
                    this.renderCurrentPage(this.cropMode ? this.cropSlotIdx : -1);
                    this._updateRotationUI(slotIdx);
                    this.saveToStorage();
                } else if (action === 'rot90' || action === 'rot-90' || action === 'rot180' || action === 'rot0') {
                    const s = page?.slots[slotIdx];
                    if (!s) return;
                    if (!s.crop) s.crop = { x: 0, y: 0, scale: 1, rotation: 0 };
                    const cur = s.crop.rotation || 0;
                    s.crop.rotation = action === 'rot90' ? cur + 90
                                    : action === 'rot-90' ? cur - 90
                                    : action === 'rot180' ? cur + 180
                                    : 0;
                    this._updateSlotTransform(slotIdx);
                    this._updateRotationUI(slotIdx);
                    this.saveToStorage();
                } else if (action === 'clear') {
                    this.clearSlot(slotIdx);
                } else if (action === 'pick') {
                    this.openPhotoModal(slotIdx);
                }
            });
        });

        const dismiss = ev => {
            if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('mousedown', dismiss); }
        };
        setTimeout(() => document.addEventListener('mousedown', dismiss), 0);
    }

    _applyFitPreset(slotIdx, fit) {
        const page = this.book.pages[this.currentPageIndex];
        const slot = page?.slots[slotIdx];
        if (!slot) return;
        slot.fit = fit;
        if (fit === 'cover') slot.crop = { x: 0, y: 0, scale: 1 };
        this.renderCurrentPage(this.cropMode ? this.cropSlotIdx : -1);
        this._updateFitToggleBtn(fit);
        this.saveToStorage();
    }

    _updateFitToggleBtn(fit) {
        const btn = document.getElementById('fitToggleBtn');
        const hint = document.getElementById('cropModeHint');
        if (!btn) return;
        if (fit === 'contain') {
            btn.textContent = '⊟ 裁切填滿';
            btn.style.borderColor = 'var(--primary)';
            btn.style.color = 'var(--primary)';
            if (hint) hint.textContent = '完整顯示模式（照片不裁切）';
        } else {
            btn.textContent = '⊞ 完整顯示';
            btn.style.borderColor = '';
            btn.style.color = '';
            if (hint) hint.textContent = '✂ 裁切模式：拖移平移 · 滾輪縮放';
        }
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
                this._updatePageThumbnail(this.currentPageIndex);
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

    /**
     * 更新指定插槽的照片平移與縮放 Transform 樣式。
     *
     * @pre
     * - `slotIdx` 必須為非負整數，且對應當前頁面 `page.slots` 的有效索引。
     * - `page.slots[slotIdx]` 必須已載入照片 (photoId 不為空)。
     * - DOM 中必須存在對應的 `[data-slot-idx="${slotIdx}"] .slot-crop-wrapper` 元素。
     *
     * @post
     * - 將 `wrapper` 元素的 `width` 與 `height` 更新為 `100 * scale %`。
     * - 將 `wrapper` 元素的 `transform` 屬性更新為 `translate(calc(-50% + cropX/safeScale%), calc(-50% + cropY/safeScale%))`。
     * - 將 `img` 元素的 `objectPosition` 固定為 `'50% 50%'`，以配合 wrapper 的 transform 平移。
     */
    _updateSlotTransform(slotIdx) {
        const page = this.book.pages[this.currentPageIndex];
        if (!page || !page.slots[slotIdx]) return;
        const crop = page.slots[slotIdx].crop;
        const slotEl = document.querySelector(`[data-slot-idx="${slotIdx}"]`);
        if (!slotEl) return;
        const scale = crop.scale || 1;
        const safeScale = Math.max(0.01, scale); // 防禦除以零與無效值
        const cropX = (crop.x || 0) * 100;
        const cropY = (crop.y || 0) * 100;
        const rotation = crop.rotation || 0;
        slotEl.style.transform = ''; // 格子本身不旋轉，保持正正方方
        
        const wrapper = slotEl.querySelector('.slot-crop-wrapper');
        if (wrapper) {
            wrapper.style.width = `${100 * scale}%`;
            wrapper.style.height = `${100 * scale}%`;
            wrapper.style.transform = `translate(calc(-50% + ${cropX / safeScale}%), calc(-50% + ${cropY / safeScale}%)) rotate(${rotation}deg)`;
        }
        
        const img = slotEl.querySelector('.slot-crop-wrapper img');
        if (img) {
            img.style.objectPosition = '50% 50%';
        }
    }

    _updateRotationUI(slotIdx) {
        const page = this.book.pages[this.currentPageIndex];
        const rot = Math.round(page?.slots[slotIdx]?.crop?.rotation || 0);
        const slider = document.getElementById('rotationSlider');
        const val = document.getElementById('rotationVal');
        if (slider) slider.value = rot;
        if (val) val.textContent = rot + '°';
    }

    _updateZoomUI(slotIdx) {
        const page = this.book.pages[this.currentPageIndex];
        const scale = page?.slots[slotIdx]?.crop?.scale || 1;
        const slider = document.getElementById('zoomSlider');
        const val = document.getElementById('zoomVal');
        if (slider) slider.value = Math.round(scale * 100);
        if (val) val.textContent = scale.toFixed(1) + '×';
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
        const grid = document.getElementById('photoStripGrid');
        const countEl = document.getElementById('photoStripCount');
        if (!grid) return;
        if (this.libraryPhotos.length === 0) {
            grid.innerHTML = '<div class="strip-empty-hint">請在右側選擇資料夾以載入照片 →</div>';
            if (countEl) countEl.textContent = '';
            return;
        }
        if (countEl) countEl.textContent = `${this.libraryPhotos.length} 張`;
        grid.innerHTML = this.libraryPhotos.map(photo => {
            const stars = photo.rating > 0 ? `<div class="strip-photo-rating">${'★'.repeat(photo.rating)}</div>` : '';
            return `<div class="strip-photo" data-photo-id="${photo.id}" draggable="true" title="${photo.name}">
                <img src="${driveManager.getImageUrl(photo)}" loading="lazy">
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
                this.renderPhotoStrip();
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
            this.renderPhotoStrip();
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

    // ─── 底圖功能 ─────────────────────────────

    setBgImage(photoId) {
        const page = this.book.pages[this.currentPageIndex];
        if (!page) return;
        if (!page.bgImage) page.bgImage = { photoId: null, fit: 'cover', opacity: 1 };
        page.bgImage.photoId = photoId;
        document.getElementById('bgPickerModal')?.classList.remove('active');
        this.renderCurrentPage(this.cropMode ? this.cropSlotIdx : -1);
        this._updatePageThumbnail(this.currentPageIndex);
        this.updateBgImageUI();
        this.saveToStorage();
    }

    setBgImageOpacity(opacity) {
        const page = this.book.pages[this.currentPageIndex];
        if (!page) return;
        if (!page.bgImage) page.bgImage = { photoId: null, fit: 'cover', opacity: 1 };
        page.bgImage.opacity = opacity;
        // direct DOM update — avoid full re-render while dragging
        const bgEl = document.querySelector('.page-bgimage');
        if (bgEl) bgEl.style.opacity = opacity;
        this.saveToStorage();
    }

    setBgImageFit(fit) {
        const page = this.book.pages[this.currentPageIndex];
        if (!page?.bgImage?.photoId) return;
        page.bgImage.fit = fit;
        this.renderCurrentPage(this.cropMode ? this.cropSlotIdx : -1);
        this.updateBgFitButtons(fit);
        this.saveToStorage();
    }

    removeBgImage() {
        const page = this.book.pages[this.currentPageIndex];
        if (!page) return;
        page.bgImage = null;
        this.renderCurrentPage(this.cropMode ? this.cropSlotIdx : -1);
        this._updatePageThumbnail(this.currentPageIndex);
        this.updateBgImageUI();
        this.saveToStorage();
    }

    updateBgImageUI() {
        const page = this.book.pages[this.currentPageIndex];
        const bgImage = page?.bgImage;
        const preview = document.getElementById('bgImagePreview');
        const slider = document.getElementById('bgOpacitySlider');
        const sliderVal = document.getElementById('bgOpacityVal');

        if (!bgImage?.photoId) {
            if (preview) preview.innerHTML = '<span style="font-size:0.7rem;color:var(--text-muted);">未設定底圖</span>';
            if (slider) slider.value = 100;
            if (sliderVal) sliderVal.textContent = '100%';
            this.updateBgFitButtons('cover');
            return;
        }

        const src = `${CONFIG.WORKER_URL}/${bgImage.photoId}`;
        if (preview) preview.innerHTML = `<img src="${src}" style="width:100%;height:100%;object-fit:cover;display:block;">`;
        const opPct = Math.round((bgImage.opacity ?? 1) * 100);
        if (slider) slider.value = opPct;
        if (sliderVal) sliderVal.textContent = `${opPct}%`;
        this.updateBgFitButtons(bgImage.fit || 'cover');
    }

    updateBgFitButtons(activeFit) {
        document.querySelectorAll('.bg-fit-btn').forEach(btn => {
            const on = btn.dataset.fit === activeFit;
            btn.style.borderColor = on ? 'var(--primary)' : '';
            btn.style.color = on ? 'var(--primary)' : '';
        });
    }

    async openBgPicker(tab) {
        this._bgPickerTab = tab || 'assets';
        const modal = document.getElementById('bgPickerModal');
        if (!modal) return;
        modal.classList.add('active');
        modal.querySelectorAll('.bg-picker-tab').forEach(t => {
            const active = t.dataset.tab === this._bgPickerTab;
            t.style.color = active ? 'var(--primary)' : 'var(--text-muted)';
            t.style.borderBottomColor = active ? 'var(--primary)' : 'transparent';
        });
        await this._loadBgPickerGrid(this._bgPickerTab);
    }

    async _loadBgPickerGrid(tab) {
        const grid = document.getElementById('bgPickerGrid');
        if (!grid) return;
        grid.innerHTML = '<div style="color:var(--text-muted);font-size:0.8rem;padding:24px;text-align:center;grid-column:1/-1;">載入中...</div>';

        let photos = [];
        if (tab === 'assets') {
            try { ({ photos } = await this._fetchFolderDirect('_assets/backgrounds/')); } catch (e) {}
        } else {
            photos = this.libraryPhotos;
        }

        if (photos.length === 0) {
            const msg = tab === 'assets' ? '素材庫無圖片。請先上傳背景圖 (點右側 ⬆ 按鈕)。' : '請先在右側載入照片庫';
            grid.innerHTML = `<div style="color:var(--text-muted);font-size:0.8rem;padding:24px;text-align:center;grid-column:1/-1;">${msg}</div>`;
            return;
        }

        grid.innerHTML = photos.map(p => {
            const src = `${CONFIG.WORKER_URL}/${p.id}`;
            return `<div class="modal-photo bg-picker-photo" data-photo-id="${p.id}" title="${p.name}"><img src="${src}" loading="lazy"></div>`;
        }).join('');
        grid.querySelectorAll('.bg-picker-photo').forEach(el => {
            el.addEventListener('click', () => this.setBgImage(el.dataset.photoId));
        });
    }

    async uploadBgAsset(file) {
        if (!file) return;
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const key = `_assets/backgrounds/${Date.now()}_${safeName}`;
        try {
            const headers = { 'Content-Type': file.type || 'image/jpeg' };
            if (CONFIG.PHOTOGRAPHER_TOKEN) headers['Authorization'] = `Bearer ${CONFIG.PHOTOGRAPHER_TOKEN}`;
            const r = await fetch(`${CONFIG.WORKER_URL}/${key}`, { method: 'PUT', headers, body: file });
            if (!r.ok) throw new Error(`上傳失敗 (${r.status})`);
            toast.success('底圖已上傳！');
            this.setBgImage(key);
        } catch (e) {
            toast.error(e.message || '上傳失敗');
        }
    }

    // ─── 文字層功能 ───────────────────────────

    addTextLayer() {
        const page = this.book.pages[this.currentPageIndex];
        if (!page) return;
        if (!page.textLayers) page.textLayers = [];
        const layer = {
            id: `txt-${Date.now()}`,
            text: '文字',
            font: '"Playfair Display", serif',
            size: 5,
            color: '#222222',
            bold: false,
            italic: false,
            align: 'center',
            x: 50, y: 50, w: 80,
            layer: 'above'
        };
        page.textLayers.push(layer);
        this.selectedTextLayerId = layer.id;
        this.renderCurrentPage(this.cropMode ? this.cropSlotIdx : -1);
        this._updatePageThumbnail(this.currentPageIndex);
        this.renderTextLayerPanel();
        this.saveToStorage();
    }

    deleteTextLayer(id) {
        const page = this.book.pages[this.currentPageIndex];
        if (!page?.textLayers) return;
        page.textLayers = page.textLayers.filter(t => t.id !== id);
        if (this.selectedTextLayerId === id) this.selectedTextLayerId = null;
        this.renderCurrentPage(this.cropMode ? this.cropSlotIdx : -1);
        this._updatePageThumbnail(this.currentPageIndex);
        this.renderTextLayerPanel();
        this.saveToStorage();
    }

    selectTextLayer(id) {
        this.selectedTextLayerId = id;
        this.renderTextLayerPanel();
        document.querySelectorAll('.page-text-layer').forEach(el => {
            el.classList.toggle('text-layer-selected', el.dataset.textLayerId === id);
        });
    }

    updateSelectedTextLayer(props) {
        const page = this.book.pages[this.currentPageIndex];
        const layer = page?.textLayers?.find(t => t.id === this.selectedTextLayerId);
        if (!layer) return;
        Object.assign(layer, props);
        this._patchTextLayerDOM(layer.id);
        this._updatePageThumbnail(this.currentPageIndex);
        this.renderTextLayerPanel();
        this.saveToStorage();
    }

    _patchTextLayerDOM(layerId) {
        const page = this.book.pages[this.currentPageIndex];
        const layer = page?.textLayers?.find(t => t.id === layerId);
        if (!layer) return;
        const el = document.querySelector(`[data-text-layer-id="${layerId}"]`);
        if (!el) {
            // element not in DOM yet — fall back to full re-render
            this.renderCurrentPage(this.cropMode ? this.cropSlotIdx : -1);
            return;
        }
        const area = document.getElementById('pagePreviewArea');
        const canvas = area?.querySelector('.page-canvas');
        const displayW = canvas?.clientWidth || 600;
        const fontSize = Math.max(8, Math.round(layer.size / 100 * displayW));
        el.style.left = `${layer.x}%`;
        el.style.top = `${layer.y}%`;
        el.style.width = `${layer.w}%`;
        el.style.textAlign = layer.align;
        el.style.zIndex = layer.layer === 'below' ? 1 : 5;
        const span = el.querySelector('span');
        if (span) {
            span.style.fontFamily = layer.font;
            span.style.fontSize = `${fontSize}px`;
            span.style.fontWeight = layer.bold ? '700' : '400';
            span.style.fontStyle = layer.italic ? 'italic' : 'normal';
            span.style.color = layer.color;
            const lines = _escapeHtml(layer.text || '').split('\n').join('<br>');
            span.innerHTML = lines || '&#8203;';
        }
    }

    _updatePageThumbnail(pageIdx) {
        const page = this.book.pages[pageIdx];
        if (!page) return;
        const thumbEl = document.querySelector(`.page-thumb[data-page-idx="${pageIdx}"] .page-thumb-preview`);
        if (!thumbEl) return;
        thumbEl.innerHTML = renderPageThumbnailHTML(page);
    }

    renderTextLayerPanel() {
        const page = this.book.pages[this.currentPageIndex];
        const layers = page?.textLayers || [];
        const list = document.getElementById('textLayerList');
        if (!list) return;

        if (layers.length === 0) {
            list.innerHTML = '<div style="font-size:0.72rem;color:var(--text-muted);padding:2px 0;">尚無文字層</div>';
        } else {
            list.innerHTML = layers.map(t => {
                const sel = t.id === this.selectedTextLayerId;
                return `<div class="text-layer-item${sel ? ' selected' : ''}" data-layer-id="${t.id}">
                    <span class="text-layer-preview">${t.text || '(空白)'}</span>
                    <span class="text-layer-tag">${t.layer === 'below' ? '照片下↓' : '照片上↑'}</span>
                    <button class="text-layer-del-btn" data-layer-id="${t.id}" title="刪除">×</button>
                </div>`;
            }).join('');
            list.querySelectorAll('.text-layer-item').forEach(el => {
                el.addEventListener('click', e => {
                    if (e.target.classList.contains('text-layer-del-btn')) return;
                    this.selectTextLayer(el.dataset.layerId);
                });
            });
            list.querySelectorAll('.text-layer-del-btn').forEach(el => {
                el.addEventListener('click', e => { e.stopPropagation(); this.deleteTextLayer(el.dataset.layerId); });
            });
        }

        const editor = document.getElementById('textLayerEditor');
        if (!editor) return;
        const layer = layers.find(t => t.id === this.selectedTextLayerId);
        if (!layer) { editor.style.display = 'none'; return; }
        editor.style.display = '';

        const textInput = document.getElementById('textLayerInput');
        if (textInput && document.activeElement !== textInput) textInput.value = layer.text;

        const fontSel = document.getElementById('textLayerFont');
        if (fontSel) fontSel.value = layer.font;

        const colorInput = document.getElementById('textLayerColor');
        if (colorInput) colorInput.value = layer.color;

        const sizeSlider = document.getElementById('textLayerSize');
        const sizeVal = document.getElementById('textLayerSizeVal');
        if (sizeSlider) sizeSlider.value = layer.size;
        if (sizeVal) sizeVal.textContent = `${layer.size}%`;

        const setActive = (id, on) => {
            const el = document.getElementById(id);
            if (el) { el.style.borderColor = on ? 'var(--primary)' : ''; el.style.color = on ? 'var(--primary)' : ''; }
        };
        setActive('textLayerBoldBtn', layer.bold);
        setActive('textLayerItalicBtn', layer.italic);
        setActive('textLayerAlignLeftBtn', layer.align === 'left');
        setActive('textLayerAlignCenterBtn', layer.align === 'center');
        setActive('textLayerAlignRightBtn', layer.align === 'right');
        setActive('textLayerLayerAboveBtn', layer.layer !== 'below');
        setActive('textLayerLayerBelowBtn', layer.layer === 'below');
    }

    _bindTextLayerDrag() {
        const page = this.book.pages[this.currentPageIndex];
        if (!page?.textLayers?.length) return;
        const area = document.getElementById('pagePreviewArea');
        const canvas = area?.querySelector('.page-canvas');
        if (!canvas) return;

        document.querySelectorAll('.page-text-layer').forEach(el => {
            const layerId = el.dataset.textLayerId;
            el.addEventListener('mousedown', e => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                this.selectTextLayer(layerId);
                const cr = canvas.getBoundingClientRect();
                const layer = page.textLayers?.find(t => t.id === layerId);
                if (!layer) return;
                this._textDragState = { id: layerId, startX: e.clientX, startY: e.clientY, cW: cr.width, cH: cr.height, origX: layer.x, origY: layer.y };
            });
        });

        this._textMoveHandler = e => {
            if (!this._textDragState) return;
            const d = this._textDragState;
            const dx = (e.clientX - d.startX) / d.cW * 100;
            const dy = (e.clientY - d.startY) / d.cH * 100;
            const pg = this.book.pages[this.currentPageIndex];
            const layer = pg?.textLayers?.find(t => t.id === d.id);
            if (!layer) return;
            layer.x = Math.max(5, Math.min(95, d.origX + dx));
            layer.y = Math.max(3, Math.min(97, d.origY + dy));
            const el = document.querySelector(`[data-text-layer-id="${d.id}"]`);
            if (el) { el.style.left = layer.x + '%'; el.style.top = layer.y + '%'; }
        };
        this._textUpHandler = () => { if (this._textDragState) this.saveToStorage(); this._textDragState = null; };
        document.addEventListener('mousemove', this._textMoveHandler);
        document.addEventListener('mouseup', this._textUpHandler);
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
            grid.innerHTML = '<div class="lib-empty" style="padding:24px;text-align:center;">請先在右側素材庫選擇資料夾載入照片</div>';
            return;
        }

        grid.innerHTML = this.libraryPhotos.map(photo => `
            <div class="modal-photo" data-photo-id="${photo.id}" draggable="true" title="點擊放入 · 或拖曳到格子">
                <img src="${driveManager.getImageUrl(photo)}" loading="lazy">
                <div class="modal-photo-name">${photo.name}</div>
            </div>
        `).join('');

        grid.querySelectorAll('.modal-photo').forEach(el => {
            el.addEventListener('click', () => {
                this.setSlotPhoto(this.pendingSlotIdx, el.dataset.photoId);
            });
            el.addEventListener('dragstart', e => {
                e.dataTransfer.setData('text/plain', el.dataset.photoId);
                // close modal so slot becomes droppable
                setTimeout(() => this.closePhotoModal(), 50);
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
        this.updateBgImageUI();
        this.renderTextLayerPanel();
        this._populateSettingsUI();
    }

    _populateSettingsUI() {
        const s = this.book.settings || {};
        const nameEl = document.getElementById('bookName');
        const wEl = document.getElementById('bookWidth');
        const hEl = document.getElementById('bookHeight');
        const dpiEl = document.getElementById('bookDpi');
        if (nameEl && nameEl !== document.activeElement) nameEl.value = this.book.name || '';
        if (wEl && wEl !== document.activeElement) wEl.value = s.width ?? 20;
        if (hEl && hEl !== document.activeElement) hEl.value = s.height ?? 20;
        if (dpiEl && dpiEl !== document.activeElement) dpiEl.value = s.dpi ?? 300;
    }

    renderPageList() {
        const list = document.getElementById('pageList');
        if (!list) return;

        const innerPages = this.book.pages.filter(p => p.type === 'inner');
        list.innerHTML = this.book.pages.map((page, idx) => {
            const isActive = idx === this.currentPageIndex;
            const innerNum = page.type === 'inner' ? innerPages.indexOf(page) + 1 : 0;
            const label = { cover: '封面', 'back-cover': '封底' }[page.type] || `第 ${innerNum} 頁`;
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
                this.selectedTextLayerId = null;
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
        this._bindTextLayerDrag();
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
        if (this._textMoveHandler) {
            document.removeEventListener('mousemove', this._textMoveHandler);
            document.removeEventListener('mouseup', this._textUpHandler);
            this._textMoveHandler = null;
            this._textUpHandler = null;
        }
        this._textDragState = null;
        clearTimeout(this._wheelSaveTimer);

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
            slotEl.addEventListener('dragover', e => {
                if (!e.dataTransfer.types.includes('text/plain')) return;
                e.preventDefault();
                slotEl.classList.add('drag-over');
            });
            slotEl.addEventListener('dragleave', () => slotEl.classList.remove('drag-over'));
            slotEl.addEventListener('drop', e => {
                e.preventDefault();
                slotEl.classList.remove('drag-over');
                const photoId = e.dataTransfer.getData('text/plain');
                if (photoId) this.setSlotPhoto(slotIdx, photoId);
            });

            // 右鍵選單
            slotEl.addEventListener('contextmenu', e => {
                e.preventDefault();
                e.stopPropagation();
                this._showSlotContextMenu(slotIdx, e.clientX, e.clientY);
            });

            // 有照片的格子：mousedown 直接進入裁切 + 開始拖移（單一手勢）
            if (hasPhoto) {
                slotEl.addEventListener('mousedown', e => {
                    if (e.button !== 0) return; // ignore right-click / middle-click
                    if (e.target.classList.contains('slot-clear-btn')) return;
                    e.preventDefault();
                    if (!this.cropMode || this.cropSlotIdx !== slotIdx) {
                        this.enterCropMode(slotIdx);
                    }
                    this.cropDragState = { lastX: e.clientX, lastY: e.clientY, slotEl: document.querySelector(`[data-slot-idx="${slotIdx}"]`) };
                });

                slotEl.addEventListener('wheel', e => {
                    e.preventDefault();
                    const page = this.book.pages[this.currentPageIndex];
                    if (!page?.slots[slotIdx]) return;
                    const crop = page.slots[slotIdx].crop;
                    const factor = e.deltaY < 0 ? 1.04 : 0.96;
                    const newScale = Math.max(1, Math.min(4, (crop.scale || 1) * factor));
                    crop.scale = newScale;

                    this._updateSlotTransform(slotIdx);
                    this._updateZoomUI(slotIdx);
                    clearTimeout(this._wheelSaveTimer);
                    this._wheelSaveTimer = setTimeout(() => this.saveToStorage(), 500);
                }, { passive: false });

                // 旋轉 handle（在 crop 模式下顯示）
                if (this.cropMode && this.cropSlotIdx === slotIdx) {
                    const handle = document.createElement('div');
                    handle.className = 'slot-rotate-handle';
                    handle.title = '拖曳自由旋轉';
                    handle.textContent = '↻';
                    slotEl.appendChild(handle);

                    handle.addEventListener('mousedown', e => {
                        e.preventDefault();
                        e.stopPropagation();
                        const rect = slotEl.getBoundingClientRect();
                        const cx = rect.left + rect.width / 2;
                        const cy = rect.top + rect.height / 2;
                        const startAngle = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;
                        const pg = this.book.pages[this.currentPageIndex];
                        const startRotation = pg?.slots[slotIdx]?.crop?.rotation || 0;

                        const onMove = ev => {
                            const angle = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI;
                            const p = this.book.pages[this.currentPageIndex];
                            if (!p?.slots[slotIdx]) return;
                            p.slots[slotIdx].crop.rotation = startRotation + (angle - startAngle);
                            this._updateSlotTransform(slotIdx);
                            this._updateRotationUI(slotIdx);
                        };
                        const onUp = () => {
                            document.removeEventListener('mousemove', onMove);
                            document.removeEventListener('mouseup', onUp);
                            this.saveToStorage();
                        };
                        document.addEventListener('mousemove', onMove);
                        document.addEventListener('mouseup', onUp);
                    });
                }
            }
        });

        /**
         * Crop movement handler for mouse dragging.
         * Pre-conditions:
         *   - `this.cropDragState` is active (contains start client coordinates and target slot element).
         *   - `this.cropMode` is true.
         *   - Valid slot index (`this.cropSlotIdx`) with a slot existing.
         * Post-conditions:
         *   - Updates crop offset coordinates `crop.x` and `crop.y` without clamping constraints to allow free pan.
         *   - Updates `this.cropDragState` with the latest client coordinates.
         *   - Applies transformation by calling `_updateSlotTransform`.
         */
        this._cropMoveHandler = e => {
            if (!this.cropDragState || !this.cropMode) return;
            const page = this.book.pages[this.currentPageIndex];
            if (!page?.slots[this.cropSlotIdx]) return;

            const slotEl = this.cropDragState.slotEl;
            if (!slotEl) return;
            const rect = slotEl.getBoundingClientRect();
            const dx_raw = (e.clientX - this.cropDragState.lastX) / rect.width;
            const dy_raw = (e.clientY - this.cropDragState.lastY) / rect.height;

            // Rotate delta back to slot's local coordinate space
            const rotation = page.slots[this.cropSlotIdx].crop?.rotation || 0;
            const rad = -rotation * Math.PI / 180;
            const dx = dx_raw * Math.cos(rad) - dy_raw * Math.sin(rad);
            const dy = dx_raw * Math.sin(rad) + dy_raw * Math.cos(rad);

            const crop = page.slots[this.cropSlotIdx].crop;
            // Remove clamp to allow free panning (past the boundaries)
            crop.x = (crop.x || 0) + dx;
            crop.y = (crop.y || 0) + dy;
            
            this.cropDragState = { lastX: e.clientX, lastY: e.clientY, slotEl };
            this._updateSlotTransform(this.cropSlotIdx);
        };
        this._cropUpHandler = () => { this.cropDragState = null; this.saveToStorage(); };

        document.removeEventListener('mousemove', this._cropMoveHandler);
        document.removeEventListener('mouseup', this._cropUpHandler);
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
            if (!await this._confirm(`自動排版將取代目前所有 ${innerCount} 張內頁（封面與封底保留）。確定繼續？`, '確定排版', 'btn-primary')) return;
        }
        const styleEl = document.getElementById('autoLayoutStyle');
        const style = styleEl?.value || 'magazine';

        const btn = document.getElementById('runAutoLayoutBtn');
        if (btn) btn.disabled = true;
        toast.info('正在分析照片方向並自動排版...');

        const snapshot = JSON.parse(JSON.stringify(this.book.pages));

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
            this._autoLayoutSnapshot = snapshot;
            this.renderAll();
            this.saveToStorage();
            toast.withAction(
                `自動排版完成！共 ${this.book.pages.length} 頁`,
                'success', '復原', () => this._undoAutoLayout()
            );
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    _undoAutoLayout() {
        if (!this._autoLayoutSnapshot) return;
        this.book.pages = this._autoLayoutSnapshot;
        this._autoLayoutSnapshot = null;
        this.currentPageIndex = 0;
        this.renderAll();
        this.saveToStorage();
        toast.info('已復原自動排版');
    }

    // ─── 儲存 / 讀取 ─────────────────────────

    saveToStorage() {
        try {
            localStorage.setItem(`book_editor_${this.currentBookId}`, JSON.stringify(this.book));
            this._updateBooksList();
        } catch (e) { /* quota exceeded */ }
    }

    /**
     * Loads the active photobook state from local storage.
     * Pre-conditions:
     *   - `this.currentBookId` must be a valid ID string.
     *   - `localStorage` must be accessible.
     * Post-conditions:
     *   - If the key exists, parses and loads the book state into `this.book`.
     *   - Performs comprehensive structure sanitization to guarantee backward compatibility:
     *     - Ensures default settings and coverSettings objects are present.
     *     - Filters and maps `pages` to guarantee they are objects, have valid layouts, and
     *       fully populated slots arrays matching layout definitions.
     *   - Returns true if successful, false otherwise.
     */
    loadFromStorage() {
        try {
            const saved = localStorage.getItem(`book_editor_${this.currentBookId}`);
            if (saved) {
                const parsed = JSON.parse(saved);
                // Ensure default structure and backward compatibility
                this.book = {
                    name: '未命名相本',
                    clientFolders: [],
                    notifyUrl: '',
                    settings: { width: 20, height: 20, unit: 'cm', dpi: 300 },
                    coverSettings: { width: 20, height: 20, unit: 'cm', dpi: 300 },
                    pages: [],
                    ...parsed
                };
                // Ensure nested settings objects are also fully initialized
                this.book.settings = {
                    width: 20, height: 20, unit: 'cm', dpi: 300,
                    ...(parsed.settings || {})
                };
                this.book.coverSettings = {
                    width: 20, height: 20, unit: 'cm', dpi: 300,
                    ...(parsed.coverSettings || {})
                };

                // Why: Guarantee that pages is a valid array of structured objects
                if (Array.isArray(this.book.pages)) {
                    this.book.pages = this.book.pages.map((page, pIdx) => {
                        if (!page || typeof page !== 'object') return null;

                        const type = page.type || 'inner';
                        let layout = page.layout;

                        // Why: Fallback to default layout if the saved layout ID is not present in LAYOUTS
                        if (!layout || !LAYOUTS[layout]) {
                            const defaultLayouts = { cover: 'full-bleed', inner: '2-up-h', 'back-cover': 'blank' };
                            layout = defaultLayouts[type] || 'blank';
                        }

                        const layoutDef = LAYOUTS[layout] || LAYOUTS['blank'];
                        const slots = Array.isArray(page.slots) ? page.slots : [];

                        // Why: Construct fully populated slots conforming to the layout slots definition
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

                return true;
            }
        } catch (e) {
            console.error("Failed to parse book data from storage:", e);
        }
        return false;
    }

    // ─── 書本管理 ────────────────────────────

    _initBookId() {
        const params = new URLSearchParams(location.search);
        let id = params.get('id');

        if (id) return { id, showModal: false };

        const books = this._getBooksList();

        // 遷移舊單一書本資料
        const oldData = localStorage.getItem('book_editor_state');
        if (oldData) {
            try {
                const parsed = JSON.parse(oldData);
                const newId = this._generateId();
                localStorage.setItem(`book_editor_${newId}`, oldData);
                const entry = { id: newId, name: parsed.name || '相本', updatedAt: Date.now() };
                const newList = books.length ? [entry, ...books] : [entry];
                localStorage.setItem('book_editor_books', JSON.stringify(newList));
                localStorage.removeItem('book_editor_state');
                history.replaceState(null, '', `?id=${newId}`);
                return { id: newId, showModal: newList.length > 1 };
            } catch (e) {}
        }

        if (books.length > 0) {
            const recent = books[0];
            history.replaceState(null, '', `?id=${recent.id}`);
            return { id: recent.id, showModal: books.length > 1 };
        }

        const newId = this._generateId();
        history.replaceState(null, '', `?id=${newId}`);
        return { id: newId, showModal: false };
    }

    _getBooksList() {
        try { return JSON.parse(localStorage.getItem('book_editor_books') || '[]'); }
        catch (e) { return []; }
    }

    _updateBooksList() {
        const list = this._getBooksList();
        const idx = list.findIndex(b => b.id === this.currentBookId);
        const existing = idx >= 0 ? list[idx] : {};
        const coverPage = this.book.pages.find(p => p.type === 'cover') || this.book.pages[0];
        const coverPhotoId = coverPage?.slots?.[0]?.photoId || null;
        const entry = {
            id: this.currentBookId,
            name: this.book.name,
            updatedAt: Date.now(),
            pageCount: this.book.pages.length,
            clientFolder: this.book.clientFolders?.[0] || existing.clientFolder || '',
            status: existing.status || 'draft',
            coverPhotoId,
        };
        if (idx >= 0) list[idx] = entry;
        else list.unshift(entry);
        localStorage.setItem('book_editor_books', JSON.stringify(list));
        if (document.getElementById('booksModal')?.classList.contains('active')) {
            this._renderBooksModalList();
        }
    }

    openBooksModal() {
        this._renderBooksModalList();
        document.getElementById('booksModal')?.classList.add('active');
    }

    _renderBooksModalList() {
        const container = document.getElementById('booksModalList');
        if (!container) return;
        const books = this._getBooksList();
        if (books.length === 0) {
            container.innerHTML = '<div class="books-empty">還沒有相本，點擊「新增相本」開始！</div>';
            this._renderStorageBar();
            return;
        }
        const statusMap = {
            draft:       ['草稿',  'status-draft'],
            'in-progress': ['製作中', 'status-inprogress'],
            delivered:   ['已交付', 'status-delivered'],
        };
        container.innerHTML = books.map((b, i) => {
            const date = new Date(b.updatedAt).toLocaleDateString('zh-TW');
            const isCurrent = b.id === this.currentBookId;
            const [statusLabel, statusClass] = statusMap[b.status || 'draft'] || statusMap.draft;
            const thumbUrl = b.coverPhotoId ? `${CONFIG.WORKER_URL}/${encodeURIComponent(b.coverPhotoId)}` : '';
            const folder = b.clientFolder || '';
            const folderShort = folder.length > 22 ? '…' + folder.slice(-20) : folder;
            return `<div class="books-row${isCurrent ? ' books-row--current' : ''}" data-id="${b.id}" data-idx="${i}" draggable="true">
                <span class="books-drag-handle" title="拖曳排序">⠿</span>
                ${thumbUrl
                    ? `<img class="books-thumb" src="${thumbUrl}" alt="" loading="lazy">`
                    : '<div class="books-thumb books-thumb--empty"></div>'}
                <div class="books-row-info">
                    <div class="books-row-top">
                        <span class="books-row-name">${this._escHtml(b.name)}</span>
                        <button class="btn btn-icon books-rename-btn" data-id="${b.id}" title="重新命名">✎</button>
                    </div>
                    <div class="books-row-meta">
                        ${b.pageCount ? `<span class="books-meta-chip">${b.pageCount} 頁</span>` : ''}
                        ${folder ? `<span class="books-meta-chip books-meta-folder" title="${this._escHtml(folder)}">${this._escHtml(folderShort)}</span>` : ''}
                        <span class="books-row-date">${date}</span>
                    </div>
                </div>
                <div class="books-row-actions">
                    <button class="books-status-btn ${statusClass}" data-id="${b.id}" title="點擊切換狀態">${statusLabel}</button>
                    ${isCurrent
                        ? '<span class="books-current-badge">編輯中</span>'
                        : `<button class="btn btn-secondary books-open-btn" data-id="${b.id}">開啟</button>`}
                    <button class="btn btn-icon books-dup-btn" data-id="${b.id}" title="建立副本">⿻</button>
                    <button class="btn btn-icon books-export-btn" data-id="${b.id}" title="匯出 JSON">⬇</button>
                    <button class="btn btn-icon books-del-btn" data-id="${b.id}" title="刪除">✕</button>
                </div>
            </div>`;
        }).join('');

        container.querySelectorAll('.books-open-btn').forEach(btn =>
            btn.addEventListener('click', () => this._openBook(btn.dataset.id)));
        container.querySelectorAll('.books-dup-btn').forEach(btn =>
            btn.addEventListener('click', () => this._duplicateBook(btn.dataset.id)));
        container.querySelectorAll('.books-del-btn').forEach(btn =>
            btn.addEventListener('click', () => this._deleteBook(btn.dataset.id)));
        container.querySelectorAll('.books-rename-btn').forEach(btn =>
            btn.addEventListener('click', () => this._startRename(btn.dataset.id)));
        container.querySelectorAll('.books-status-btn').forEach(btn =>
            btn.addEventListener('click', () => this._cycleStatus(btn.dataset.id)));
        container.querySelectorAll('.books-export-btn').forEach(btn =>
            btn.addEventListener('click', () => this._exportBook(btn.dataset.id)));

        this._bindDragReorder(container);
        this._renderStorageBar();
    }

    _startRename(id) {
        const row = document.querySelector(`.books-row[data-id="${id}"]`);
        if (!row) return;
        const nameSpan = row.querySelector('.books-row-name');
        if (!nameSpan) return;
        const orig = nameSpan.textContent;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = orig;
        input.className = 'books-rename-input';
        nameSpan.replaceWith(input);
        input.focus();
        input.select();
        const finish = () => {
            const newName = input.value.trim() || orig;
            const span = document.createElement('span');
            span.className = 'books-row-name';
            span.textContent = newName;
            input.replaceWith(span);
            if (newName !== orig) this._saveBookName(id, newName);
        };
        input.addEventListener('blur', finish);
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { input.value = orig; input.blur(); }
        });
    }

    _saveBookName(id, name) {
        const list = this._getBooksList();
        const entry = list.find(b => b.id === id);
        if (entry) { entry.name = name; localStorage.setItem('book_editor_books', JSON.stringify(list)); }
        try {
            const raw = localStorage.getItem(`book_editor_${id}`);
            if (raw) {
                const book = JSON.parse(raw);
                book.name = name;
                localStorage.setItem(`book_editor_${id}`, JSON.stringify(book));
            }
        } catch (e) {}
        if (id === this.currentBookId) {
            this.book.name = name;
            const inp = document.getElementById('bookName');
            if (inp) inp.value = name;
        }
    }

    _cycleStatus(id) {
        const order = ['draft', 'in-progress', 'delivered'];
        const list = this._getBooksList();
        const entry = list.find(b => b.id === id);
        if (!entry) return;
        const next = order[(order.indexOf(entry.status || 'draft') + 1) % order.length];
        entry.status = next;
        localStorage.setItem('book_editor_books', JSON.stringify(list));
        this._renderBooksModalList();
    }

    _exportBook(id) {
        const raw = localStorage.getItem(`book_editor_${id}`);
        if (!raw) return;
        const book = JSON.parse(raw);
        const list = this._getBooksList();
        const meta = list.find(b => b.id === id) || {};
        const payload = { ...book, _meta: { id, status: meta.status, exportedAt: new Date().toISOString() } };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${(book.name || 'book').replace(/[/\\:*?"<>|]/g, '_')}.photobook.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    _importBook(file) {
        const reader = new FileReader();
        reader.onload = e => {
            try {
                const data = JSON.parse(e.target.result);
                if (!data.pages || !Array.isArray(data.pages)) throw new Error('invalid');
                const importedMeta = data._meta || {};
                delete data._meta;
                data.name = data.name || '匯入的相本';
                const newId = this._generateId();
                localStorage.setItem(`book_editor_${newId}`, JSON.stringify(data));
                const list = this._getBooksList();
                list.unshift({
                    id: newId, name: data.name, updatedAt: Date.now(),
                    pageCount: data.pages.length, status: importedMeta.status || 'draft',
                    clientFolder: data.clientFolders?.[0] || '',
                    coverPhotoId: data.pages[0]?.slots?.[0]?.photoId || null,
                });
                localStorage.setItem('book_editor_books', JSON.stringify(list));
                toast.success(`已匯入「${data.name}」`);
                this._renderBooksModalList();
            } catch (err) {
                toast.error('匯入失敗：格式錯誤');
            }
        };
        reader.readAsText(file);
    }

    _bindDragReorder(container) {
        let dragId = null;
        container.querySelectorAll('.books-row').forEach(row => {
            row.addEventListener('dragstart', e => {
                dragId = row.dataset.id;
                row.classList.add('books-row--dragging');
                e.dataTransfer.effectAllowed = 'move';
            });
            row.addEventListener('dragend', () => {
                row.classList.remove('books-row--dragging');
                container.querySelectorAll('.books-row--drag-over').forEach(r => r.classList.remove('books-row--drag-over'));
            });
            row.addEventListener('dragover', e => {
                e.preventDefault();
                if (row.dataset.id === dragId) return;
                container.querySelectorAll('.books-row--drag-over').forEach(r => r.classList.remove('books-row--drag-over'));
                row.classList.add('books-row--drag-over');
            });
            row.addEventListener('drop', e => {
                e.preventDefault();
                if (!dragId || row.dataset.id === dragId) return;
                const list = this._getBooksList();
                const from = list.findIndex(b => b.id === dragId);
                const to = list.findIndex(b => b.id === row.dataset.id);
                if (from < 0 || to < 0) return;
                const [moved] = list.splice(from, 1);
                list.splice(to, 0, moved);
                localStorage.setItem('book_editor_books', JSON.stringify(list));
                this._renderBooksModalList();
            });
        });
    }

    _getStorageUsage() {
        let used = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            used += (k.length + (localStorage.getItem(k) || '').length) * 2;
        }
        const max = 5 * 1024 * 1024;
        return { used, max, pct: Math.min(100, Math.round(used / max * 100)) };
    }

    _renderStorageBar() {
        const el = document.getElementById('booksStorageBar');
        if (!el) return;
        const { used, pct } = this._getStorageUsage();
        const usedKB = (used / 1024).toFixed(0);
        const warn = pct > 80;
        el.innerHTML = `<div class="storage-bar-label">
            儲存空間：${usedKB} KB / 5120 KB（${pct}%）
            ${warn ? '<span class="storage-warn">⚠ 空間不足，請匯出並刪除舊相本</span>' : ''}
        </div>
        <div class="storage-bar-track">
            <div class="storage-bar-fill${warn ? ' storage-bar-fill--warn' : ''}" style="width:${pct}%"></div>
        </div>`;
    }

    _openBook(id) {
        this.saveToStorage();
        location.href = `?id=${id}`;
    }

    async _duplicateBook(srcId) {
        const raw = localStorage.getItem(`book_editor_${srcId}`);
        if (!raw) return;
        const copy = JSON.parse(raw);
        copy.name = copy.name + ' (複本)';
        const newId = this._generateId();
        localStorage.setItem(`book_editor_${newId}`, JSON.stringify(copy));
        const list = this._getBooksList();
        const srcMeta = list.find(b => b.id === srcId) || {};
        const srcIdx = list.findIndex(b => b.id === srcId);
        const entry = {
            id: newId, name: copy.name, updatedAt: Date.now(),
            pageCount: copy.pages?.length || 0, status: srcMeta.status || 'draft',
            clientFolder: srcMeta.clientFolder || '', coverPhotoId: srcMeta.coverPhotoId || null,
        };
        list.splice(srcIdx + 1, 0, entry);
        localStorage.setItem('book_editor_books', JSON.stringify(list));
        toast.success('已建立相本副本，並新增至列表');
        this._renderBooksModalList();
    }

    async _deleteBook(id) {
        const list = this._getBooksList();
        const target = list.find(b => b.id === id);
        if (!target) return;
        if (!await this._confirm(`確定刪除「${target.name}」？此操作無法還原。`, '刪除', 'btn-danger')) return;
        localStorage.removeItem(`book_editor_${id}`);
        const newList = list.filter(b => b.id !== id);
        localStorage.setItem('book_editor_books', JSON.stringify(newList));
        if (id === this.currentBookId) {
            if (newList.length > 0) { location.href = `?id=${newList[0].id}`; }
            else { const nid = this._generateId(); history.replaceState(null, '', `?id=${nid}`); location.reload(); }
            return;
        }
        this._renderBooksModalList();
    }

    _createNewBook() {
        this.saveToStorage();
        location.href = `?id=${this._generateId()}`;
    }

    _escHtml(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
        // 帶入已儲存的 notify URL
        const notifyInput = document.getElementById('notifyUrlInput');
        if (notifyInput) notifyInput.value = this.book.notifyUrl || '';
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
        this.book.notifyUrl = (document.getElementById('notifyUrlInput')?.value || '').trim();

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
        // 攔截預覽區的原生檔案拖放 UI（只綁一次）
        const previewArea = document.getElementById('pagePreviewArea');
        if (previewArea) {
            previewArea.addEventListener('dragover', e => {
                if (e.dataTransfer.types.includes('text/plain')) e.preventDefault();
            }, { capture: true });
            previewArea.addEventListener('drop', e => {
                if (!e.dataTransfer.types.includes('text/plain')) e.preventDefault();
            }, { capture: true });
        }

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
            // do NOT call renderLibrary() here — it would wipe the folder list
        });

        // 頁面導航（頂欄 + 底部）
        const goPrev = () => {
            if (this.currentPageIndex > 0) { this.exitCropMode(); this.selectedTextLayerId = null; this.currentPageIndex--; this.renderAll(); }
        };
        const goNext = () => {
            if (this.currentPageIndex < this.book.pages.length - 1) { this.exitCropMode(); this.selectedTextLayerId = null; this.currentPageIndex++; this.renderAll(); }
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
            this._updatePageThumbnail(this.currentPageIndex);
            this.saveToStorage();
        };
        this._on('pageBgColor', 'input', e => applyBg(e.target.value));
        this._on('pageBgWhiteBtn', 'click', () => { applyBg('#ffffff'); const i = document.getElementById('pageBgColor'); if (i) i.value = '#ffffff'; });
        this._on('pageBgBlackBtn', 'click', () => { applyBg('#000000'); const i = document.getElementById('pageBgColor'); if (i) i.value = '#000000'; });

        // ─── 底圖事件 ─────────────────────────────────────────────
        this._on('bgPickFromAssetsBtn', 'click', () => this.openBgPicker('assets'));
        this._on('bgPickFromLibBtn', 'click', () => this.openBgPicker('library'));
        this._on('bgRemoveBtn', 'click', () => this.removeBgImage());
        this._on('bgUploadBtn', 'click', () => document.getElementById('bgUploadInput')?.click());
        this._on('bgUploadInput', 'change', e => { const f = e.target.files?.[0]; if (f) { this.uploadBgAsset(f); e.target.value = ''; } });
        this._on('bgOpacitySlider', 'input', e => {
            const v = parseInt(e.target.value) / 100;
            document.getElementById('bgOpacityVal').textContent = `${Math.round(v * 100)}%`;
            this.setBgImageOpacity(v);
        });
        document.querySelectorAll('.bg-fit-btn').forEach(btn => {
            btn.addEventListener('click', () => this.setBgImageFit(btn.dataset.fit));
        });
        // bgPickerModal
        this._on('closeBgPickerBtn', 'click', () => document.getElementById('bgPickerModal')?.classList.remove('active'));
        this._on('bgPickerModal', 'click', e => { if (e.target.id === 'bgPickerModal') e.target.classList.remove('active'); });
        document.querySelectorAll('.bg-picker-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const t = tab.dataset.tab;
                document.querySelectorAll('.bg-picker-tab').forEach(bt => {
                    const on = bt.dataset.tab === t;
                    bt.style.color = on ? 'var(--primary)' : 'var(--text-muted)';
                    bt.style.borderBottomColor = on ? 'var(--primary)' : 'transparent';
                });
                this._bgPickerTab = t;
                this._loadBgPickerGrid(t);
            });
        });

        // ─── 文字層事件 ───────────────────────────────────────────
        this._on('addTextLayerBtn', 'click', () => this.addTextLayer());
        this._on('textLayerInput', 'input', e => this.updateSelectedTextLayer({ text: e.target.value }));
        this._on('textLayerFont', 'change', e => this.updateSelectedTextLayer({ font: e.target.value }));
        const onColorChange = e => this.updateSelectedTextLayer({ color: e.target.value });
        this._on('textLayerColor', 'input', onColorChange);
        this._on('textLayerColor', 'change', onColorChange);
        const onSizeChange = e => {
            const v = parseFloat(e.target.value);
            const el = document.getElementById('textLayerSizeVal');
            if (el) el.textContent = `${v}%`;
            this.updateSelectedTextLayer({ size: v });
        };
        this._on('textLayerSize', 'input', onSizeChange);
        this._on('textLayerSize', 'change', onSizeChange);
        this._on('textLayerBoldBtn', 'click', () => {
            const page = this.book.pages[this.currentPageIndex];
            const layer = page?.textLayers?.find(t => t.id === this.selectedTextLayerId);
            if (layer) this.updateSelectedTextLayer({ bold: !layer.bold });
        });
        this._on('textLayerItalicBtn', 'click', () => {
            const page = this.book.pages[this.currentPageIndex];
            const layer = page?.textLayers?.find(t => t.id === this.selectedTextLayerId);
            if (layer) this.updateSelectedTextLayer({ italic: !layer.italic });
        });
        this._on('textLayerAlignLeftBtn', 'click', () => this.updateSelectedTextLayer({ align: 'left' }));
        this._on('textLayerAlignCenterBtn', 'click', () => this.updateSelectedTextLayer({ align: 'center' }));
        this._on('textLayerAlignRightBtn', 'click', () => this.updateSelectedTextLayer({ align: 'right' }));
        this._on('textLayerLayerAboveBtn', 'click', () => this.updateSelectedTextLayer({ layer: 'above' }));
        this._on('textLayerLayerBelowBtn', 'click', () => this.updateSelectedTextLayer({ layer: 'below' }));

        // 新增頁面
        this._on('addPageBtn', 'click', () => this.addInnerPage());

        // 版型按鈕
        document.querySelectorAll('.layout-btn').forEach(btn => {
            btn.addEventListener('click', () => this.setLayout(btn.dataset.layout));
        });

        // 裁切完成
        this._on('cropDoneBtn', 'click', () => this.exitCropMode());
        this._on('fitToggleBtn', 'click', () => {
            const page = this.book.pages[this.currentPageIndex];
            if (!page || this.cropSlotIdx < 0 || !page.slots[this.cropSlotIdx]) return;
            const slot = page.slots[this.cropSlotIdx];
            slot.fit = slot.fit === 'contain' ? 'cover' : 'contain';
            if (slot.fit === 'cover') { slot.crop = { x: 0, y: 0, scale: 1 }; }
            this._updateFitToggleBtn(slot.fit);
            this.renderCurrentPage(this.cropSlotIdx);
            this.saveToStorage();
        });

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

        // 縮放 slider
        this._on('zoomSlider', 'input', e => {
            const page = this.book.pages[this.currentPageIndex];
            if (!page || this.cropSlotIdx < 0) return;
            const scale = parseInt(e.target.value) / 100;
            if (!page.slots[this.cropSlotIdx].crop) page.slots[this.cropSlotIdx].crop = { x: 0, y: 0, scale: 1 };
            const crop = page.slots[this.cropSlotIdx].crop;
            crop.scale = scale;
            const val = document.getElementById('zoomVal');
            if (val) val.textContent = scale.toFixed(1) + '×';
            this._updateSlotTransform(this.cropSlotIdx);
        });
        this._on('zoomSlider', 'change', () => this.saveToStorage());

        // 旋轉 slider
        this._on('rotationSlider', 'input', e => {
            const page = this.book.pages[this.currentPageIndex];
            if (!page || this.cropSlotIdx < 0) return;
            const rot = parseInt(e.target.value);
            if (!page.slots[this.cropSlotIdx].crop) page.slots[this.cropSlotIdx].crop = { x: 0, y: 0, scale: 1 };
            page.slots[this.cropSlotIdx].crop.rotation = rot;
            const val = document.getElementById('rotationVal');
            if (val) val.textContent = rot + '°';
            this._updateSlotTransform(this.cropSlotIdx);
        });
        this._on('rotationSlider', 'change', () => this.saveToStorage());
        this._on('resetRotBtn', 'click', () => {
            const page = this.book.pages[this.currentPageIndex];
            if (!page || this.cropSlotIdx < 0) return;
            page.slots[this.cropSlotIdx].crop.rotation = 0;
            const slider = document.getElementById('rotationSlider');
            if (slider) slider.value = 0;
            const val = document.getElementById('rotationVal');
            if (val) val.textContent = '0°';
            this._updateSlotTransform(this.cropSlotIdx);
            this.saveToStorage();
        });

        // 書單
        this._on('booksBtn', 'click', () => this.openBooksModal());
        this._on('closeBooksModalBtn', 'click', () => document.getElementById('booksModal')?.classList.remove('active'));
        this._on('newBookBtn', 'click', () => this._createNewBook());
        this._on('importBookBtn', 'click', () => document.getElementById('importBookInput')?.click());
        this._on('importBookInput', 'change', e => {
            const f = e.target.files?.[0];
            if (f) { this._importBook(f); e.target.value = ''; }
        });
        document.getElementById('booksModal')?.addEventListener('click', e => {
            if (e.target.id === 'booksModal') document.getElementById('booksModal').classList.remove('active');
        });

        // 匯出
        this._on('exportBtn', 'click', () => BookExporter.exportAll(this.book));

        // 清除所有資料
        this._on('clearBookBtn', 'click', async () => {
            if (await this._confirm('確定要清除相本並重新開始？所有頁面都會消失。', '清除重設')) {
                localStorage.removeItem(`book_editor_${this.currentBookId}`);
                this.book = { name: '未命名相本', clientFolders: [], notifyUrl: '', settings: { width: 20, height: 20, unit: 'cm', dpi: 300 }, coverSettings: { width: 20, height: 20, unit: 'cm', dpi: 300 }, pages: [] };
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

    _confirm(message, okLabel = '確定', okClass = 'btn-danger') {
        return new Promise(resolve => {
            const modal = document.getElementById('confirmModal');
            if (!modal) { resolve(window.confirm(message)); return; }
            document.getElementById('confirmMessage').textContent = message;
            const okBtn = document.getElementById('confirmOkBtn');
            okBtn.textContent = okLabel;
            okBtn.className = `btn ${okClass}`;
            modal.classList.add('active');
            const done = (result) => {
                modal.classList.remove('active');
                okBtn.removeEventListener('click', onOk);
                document.getElementById('confirmCancelBtn').removeEventListener('click', onCancel);
                resolve(result);
            };
            const onOk = () => done(true);
            const onCancel = () => done(false);
            okBtn.addEventListener('click', onOk);
            document.getElementById('confirmCancelBtn').addEventListener('click', onCancel);
        });
    }
}

document.addEventListener('DOMContentLoaded', () => { window.bookEditor = new BookEditor(); });
