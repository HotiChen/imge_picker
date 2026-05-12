// Main Application (R2 完整功能回歸版)
class App {
    constructor() {
        this.photos = [];
        this.filteredPhotos = [];
        this.currentPhotoIndex = 0;
        this.filters = {
            stars: 'all',
            annotated: 'all',
            sortBy: 'name'
        };
        this.selectedPhotoIds = new Set();
        this.lastSelectedIndex = -1; // 用於 Shift 選取
        this.folderStack = []; // [{path, name}] 資料夾導航歷史
        this.currentFolders = []; // 目前層級的子資料夾清單

        this.init();
    }

    showLoading(text = '正在處理...') {
        const modal = document.getElementById('loadingModal');
        const textEl = document.getElementById('loadingText');
        if (modal && textEl) {
            textEl.textContent = text;
            modal.classList.add('active');
        }
    }

    hideLoading() {
        const modal = document.getElementById('loadingModal');
        if (modal) modal.classList.remove('active');
    }

    addListener(id, event, callback) {
        const el = document.getElementById(id);
        if (el) el.addEventListener(event, callback);
    }

    async init() {
        console.log('--- 選圖軟體 Full v2.0 ---');

        // 1. 初始化 Manager
        await driveManager.initialize();

        // 2. 初始化標註系統
        const canvas = document.getElementById('photoCanvas');
        if (canvas) annotationManager.initialize(canvas);

        // 3. 綁定所有事件 (包含分級按鈕)
        this.bindEvents();

        // 4. 檢查 URL 參數自動載入
        await this.checkUrlParams();

        // 5. 啟動 5 分鐘自動存檔計時器
        this.startAutoSaveTimer();
    }

    async checkUrlParams() {
        const params = new URLSearchParams(window.location.search);
        const folderId = params.get('folder') || params.get('id');
        if (folderId) {
            document.getElementById('driveUrl').value = folderId;

            // 魔術連結模式 (客戶版 UI 最佳化)
            const firstSidebarSection = document.querySelector('.sidebar-section:first-child');
            if (firstSidebarSection) {
                firstSidebarSection.style.display = 'none'; // 隱藏輸入框區塊
            }

            const emptyStateH2 = document.querySelector('#emptyState h2');
            const emptyStateP = document.querySelector('#emptyState p');
            if (emptyStateH2) emptyStateH2.textContent = '歡迎來到專屬選圖空間';
            if (emptyStateP) emptyStateP.textContent = '正在為您準備高畫質照片，請稍候...';

            await this.handleLoadPhotos(folderId);

            // 顯示完成提交按鈕
            const submitBtn = document.getElementById('submitJobBtn');
            if (submitBtn) submitBtn.style.display = 'inline-block';
        }
    }

    async handleLoadPhotos(path) {
        if (path === undefined || path === null) return;
        this.showLoading(`正在載入...`);
        try {
            const result = await driveManager.loadPhotosFromFolder(path);
            if (result) {
                this.photos = result.photos || [];
                this.currentFolders = result.folders || [];

                this.updateFolderNav();
                this.applyFilters();

                if (this.currentFolders.length > 0 && this.photos.length === 0) {
                    this.renderFolderGrid();
                } else {
                    this.renderPhotoGrid();
                }
                this.updateStats();
                this.updateExpiryCountdown(result.projectCreatedTime);

                const hasCloudData = await driveManager.checkIfDataExistsOnCloud();
                if (hasCloudData) {
                    document.getElementById('discoveryModal').classList.add('active');
                }
            }
        } finally {
            this.hideLoading();
        }
    }

    navigateToFolder(folderPath) {
        this.folderStack.push({
            path: driveManager.currentFolderId || '',
            name: driveManager.currentFolderName || ''
        });
        this.handleLoadPhotos(folderPath);
    }

    navigateBack() {
        if (this.folderStack.length === 0) return;
        const prev = this.folderStack.pop();
        this.handleLoadPhotos(prev.path);
    }

    updateFolderNav() {
        const nav = document.getElementById('folderNav');
        if (!nav) return;

        if (this.folderStack.length === 0) {
            nav.style.display = 'none';
            nav.innerHTML = '';
            return;
        }

        nav.style.display = 'flex';

        const crumbs = this.folderStack
            .filter(item => item.name)
            .map((item, idx) => `<span class="breadcrumb-item" data-idx="${idx}">${item.name}</span>`)
            .join('<span class="breadcrumb-sep"> › </span>');

        const currentName = driveManager.currentFolderName;
        const current = currentName
            ? `<span class="breadcrumb-sep"> › </span><span class="breadcrumb-current">${currentName}</span>`
            : '';

        nav.innerHTML = `
            <button class="btn btn-text breadcrumb-back" onclick="app.navigateBack()">← 返回</button>
            <nav class="breadcrumb">${crumbs}${current}</nav>
        `;

        nav.querySelectorAll('.breadcrumb-item').forEach(item => {
            item.addEventListener('click', () => {
                const idx = parseInt(item.dataset.idx);
                const target = this.folderStack[idx];
                this.folderStack = this.folderStack.slice(0, idx);
                this.handleLoadPhotos(target.path);
            });
        });
    }

    renderFolderGrid() {
        const grid = document.getElementById('photoGrid');
        grid.innerHTML = '';
        document.getElementById('emptyState').style.display = 'none';
        this.currentFolders.forEach(folder => grid.appendChild(this.createFolderCard(folder)));
    }

    createFolderCard(folder) {
        const card = document.createElement('div');
        card.className = 'folder-card';
        card.innerHTML = `
            <div class="folder-icon">📁</div>
            <div class="folder-name">${folder.name}</div>
        `;
        card.addEventListener('click', () => this.navigateToFolder(folder.id));
        return card;
    }

    bindEvents() {
        // 載入按鈕
        this.addListener('loadPhotosBtn', 'click', () => {
            const path = document.getElementById('driveUrl').value.trim();
            this.handleLoadPhotos(path);

            // 在手機端按下載入後，自動收起側邊欄
            if (window.innerWidth <= 1024) {
                const sidebar = document.querySelector('.sidebar');
                const backdrop = document.getElementById('sidebarBackdrop');
                if (sidebar) sidebar.classList.remove('active');
                if (backdrop) backdrop.classList.remove('active');
            }
        });

        // 手機端側邊欄切換
        this.addListener('sidebarToggle', 'click', () => {
            const sidebar = document.querySelector('.sidebar');
            const backdrop = document.getElementById('sidebarBackdrop');
            if (sidebar) sidebar.classList.toggle('active');
            if (backdrop) backdrop.classList.toggle('active');
        });

        // 點擊遮罩關閉側邊欄
        this.addListener('sidebarBackdrop', 'click', () => {
            const sidebar = document.querySelector('.sidebar');
            const backdrop = document.getElementById('sidebarBackdrop');
            if (sidebar) sidebar.classList.remove('active');
            if (backdrop) backdrop.classList.remove('active');
        });

        // 篩選按鈕 (星級)
        document.querySelectorAll('.star-filter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const target = e.currentTarget;
                document.querySelectorAll('.star-filter-btn').forEach(b => b.classList.remove('active'));
                target.classList.add('active');
                this.filters.stars = target.dataset.stars;
                this.applyFilters();
                this.renderPhotoGrid();
                this.updateStats();
            });
        });

        // 篩選按鈕 (標註狀態)
        document.querySelectorAll('.toggle-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const target = e.currentTarget;
                target.parentElement.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
                target.classList.add('active');
                this.filters.annotated = target.dataset.annotated;
                this.applyFilters();
                this.renderPhotoGrid();
            });
        });

        // 只看已選取
        this.addListener('filterSelectedBtn', 'click', () => {
            this.filters.selectedOnly = !this.filters.selectedOnly;
            const btn = document.getElementById('filterSelectedBtn');
            if (this.filters.selectedOnly) {
                btn.style.background = 'rgba(243, 128, 32, 0.1)';
                btn.innerHTML = `🧺 顯示全部照片`;
            } else {
                btn.style.background = '';
                const count = this.selectedPhotoIds.size;
                btn.innerHTML = `🧺 只看我選取的 (<span id="selectedCountBadge">${count}</span>)`;
            }
            this.applyFilters();
            this.renderPhotoGrid();
        });

        // 點擊空白處清空選取
        this.addListener('photoGrid', 'click', (e) => {
            if (e.target.id === 'photoGrid') {
                this.clearSelection();
            }
        });

        // 排序
        this.addListener('sortBy', 'change', (e) => {
            this.filters.sortBy = e.target.value;
            this.applyFilters();
            this.renderPhotoGrid();
        });

        // Modal 控制
        this.addListener('closeModal', 'click', () => this.closeModal());
        this.addListener('prevPhotoBtn', 'click', () => this.navigatePhoto(-1));
        this.addListener('nextPhotoBtn', 'click', () => this.navigatePhoto(1));

        // 標註工具切換
        document.querySelectorAll('.tool-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
                const target = e.currentTarget;
                target.classList.add('active');
                annotationManager.setTool(target.dataset.tool);
                if (target.dataset.tool === 'eraser') annotationManager.clearAnnotations();
            });
        });

        // 顏色切換
        document.querySelectorAll('.color-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
                e.target.classList.add('active');
                annotationManager.setColor(e.target.dataset.color);
            });
        });

        // 儲存到 Google Sheets (GAS)
        this.addListener('saveCurrentFolderBtn', 'click', () => {
            driveManager.saveToGAS();
        });

        // 從 Google Sheets 同步
        this.addListener('loadFromSheetsBtn', 'click', () => {
            driveManager.loadFromGAS();
        });

        // 偵測雲端資料後的決策
        this.addListener('importCloudBtn', 'click', async () => {
            document.getElementById('discoveryModal').classList.remove('active');
            await driveManager.loadFromGAS();
        });

        this.addListener('skipCloudBtn', 'click', () => {
            document.getElementById('discoveryModal').classList.remove('active');
            toast.info('已跳過雲端載入，使用本地/全新資料');
        });

        // 備份與清理
        this.addListener('backupDataBtn', 'click', () => {
            driveManager.backupData();
        });

        this.addListener('resetAllDataBtn', 'click', () => {
            if (confirm('確定要清除所有本地快取資料嗎？這將會刪除所有尚未同步到 Google Sheets 的評分與標注。')) {
                localStorage.clear();
                window.location.reload();
            }
        });

        this.addListener('resetCurrentDataBtn', 'click', () => {
            this.resetCurrentFolderData();
        });

        // 縮放控制
        this.addListener('zoomInBtn', 'click', () => annotationManager.zoomBy(0.2));
        this.addListener('zoomOutBtn', 'click', () => annotationManager.zoomBy(-0.2));
        this.addListener('zoomResetBtn', 'click', () => annotationManager.resetZoom());
        this.addListener('deleteSelectedBtn', 'click', () => annotationManager.deleteSelected());

        // 打包下載 5 星照片
        this.addListener('downloadFiveStarBtn', 'click', () => {
            driveManager.downloadFiveStarPhotos();
        });

        // 打包下載「全部」
        this.addListener('downloadAllBtn', 'click', () => {
            driveManager.downloadAllPhotos();
        });

        // 完成提交按鈕 (P0)
        this.addListener('submitJobBtn', 'click', () => {
            this.submitJob();
        });

        // 手機端工具抽屜切換
        this.addListener('mobileToolsToggle', 'click', () => {
            const sidebar = document.getElementById('modalSidebar');
            if (sidebar) sidebar.classList.toggle('active');
        });

        this.addListener('closeMobileSidebar', 'click', () => {
            const sidebar = document.getElementById('modalSidebar');
            if (sidebar) sidebar.classList.remove('active');
        });

        this.addListener('undoBtn', 'click', () => annotationManager.undo());
        this.addListener('redoBtn', 'click', () => annotationManager.redo());

        // 鍵盤支援
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
            const modal = document.getElementById('photoModal');
            if (modal && modal.classList.contains('active')) {
                // Ctrl/Cmd + Z (Undo)
                if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
                    if (e.shiftKey) annotationManager.redo();
                    else annotationManager.undo();
                    e.preventDefault();
                }
                // Ctrl/Cmd + Y (Redo)
                if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
                    annotationManager.redo();
                    e.preventDefault();
                }

                // Delete / Backspace (刪除選中)
                if (e.key === 'Delete' || e.key === 'Backspace') {
                    annotationManager.deleteSelected();
                }

                if (e.key === 'ArrowLeft') this.navigatePhoto(-1);
                if (e.key === 'ArrowRight') this.navigatePhoto(1);
                if (e.key === 'Escape') this.closeModal();
                if (e.key >= '0' && e.key <= '5') {
                    const rating = parseInt(e.key);
                    const photo = this.filteredPhotos[this.currentPhotoIndex];
                    if (photo) {
                        const starsContainer = document.querySelector('#modalPhotoRating .star-rating');
                        if (starsContainer) ratingManager.setRating(starsContainer, rating, photo.id);
                    }
                }
            } else if (this.selectedPhotoIds.size > 0) {
                // 如果 Modal 沒開但有選取照片，執行批量操作
                if (e.key >= '0' && e.key <= '5') {
                    this.setBulkRating(parseInt(e.key));
                    e.preventDefault();
                }
                if (e.key === 'Escape') {
                    this.clearSelection();
                }
            }
        });
    }

    toggleSelection(photoId, index, isShift = false, isCtrl = false) {
        if (isShift && this.lastSelectedIndex !== -1) {
            // Shift 連選邏輯
            const start = Math.min(this.lastSelectedIndex, index);
            const end = Math.max(this.lastSelectedIndex, index);
            const shouldAdd = !this.selectedPhotoIds.has(this.filteredPhotos[this.lastSelectedIndex].id);

            for (let i = start; i <= end; i++) {
                const id = this.filteredPhotos[i].id;
                if (shouldAdd) this.selectedPhotoIds.add(id);
                else this.selectedPhotoIds.delete(id);
            }
        } else if (isCtrl || isShift) {
            // Ctrl 或單純 Shift 但沒前一個目標：這時就像多選模式
            if (this.selectedPhotoIds.has(photoId)) {
                this.selectedPhotoIds.delete(photoId);
            } else {
                this.selectedPhotoIds.add(photoId);
            }
        } else {
            // 普通點擊（如果已經選了多張，則清空並選這一張；如果沒選，正常點擊會開 Modal，這由 createPhotoCard 處理）
            this.selectedPhotoIds.clear();
            this.selectedPhotoIds.add(photoId);
        }

        this.lastSelectedIndex = index;
        this.updateBulkUI();
        this.renderPhotoGrid();
    }

    clearSelection() {
        this.selectedPhotoIds.clear();
        this.lastSelectedIndex = -1;
        this.updateBulkUI();
        this.renderPhotoGrid();
    }

    resetCurrentFolderData() {
        if (this.photos.length === 0) return;

        const msg = `確定要重設「${driveManager.currentFolderName}」資料夾內所有照片的評分與標註嗎？\n(這將清除目前 ${this.photos.length} 張照片的本地紀錄)`;
        if (!confirm(msg)) return;

        this.photos.forEach(photo => {
            photo.rating = 0;
            photo.note = '';
            photo.annotations = [];
            photo.hasAnnotations = false;

            // 同步更新 DriveManager 的持久化儲存 (但不重新載入)
            driveManager.saveRating(photo.id, 0);
            driveManager.saveNote(photo.id, '');
            driveManager.saveAnnotations(photo.id, []);
        });

        this.clearSelection();
        this.applyFilters();
        this.renderPhotoGrid();
        this.updateStats();
        toast.success(`已重設該資料夾的所有評分與標註`);
    }

    selectAllVisible() {
        if (this.filteredPhotos.length === 0) return;

        this.filteredPhotos.forEach(photo => {
            this.selectedPhotoIds.add(photo.id);
        });

        this.updateBulkUI();
        this.renderPhotoGrid();
        toast.info(`已全選目前過濾出的 ${this.filteredPhotos.length} 張照片`);
    }

    updateExpiryCountdown(serverCreatedTime) {
        // 設定銷毀天數為 180 天
        const EXPIRY_DAYS = 180;
        const folderId = driveManager.currentFolderId || 'default';
        let expiryDate = localStorage.getItem('project_expiry_' + folderId);

        // 如果資料夾物件帶有最早的上傳時間，則以此為準重新計算過期日
        if (serverCreatedTime) {
            const createdDate = new Date(serverCreatedTime);
            createdDate.setDate(createdDate.getDate() + EXPIRY_DAYS);
            expiryDate = createdDate.toISOString();
            localStorage.setItem('project_expiry_' + folderId, expiryDate);
        }

        // 如果都沒有，才初始化一個全新的倒數（以現在起算）
        if (!expiryDate) {
            const date = new Date();
            date.setDate(date.getDate() + EXPIRY_DAYS);
            expiryDate = date.toISOString();
            localStorage.setItem('project_expiry_' + folderId, expiryDate);
        }

        const updateTimer = () => {
            const now = new Date().getTime();
            const distance = new Date(expiryDate).getTime() - now;

            const days = Math.floor(distance / (1000 * 60 * 60 * 24));
            const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));

            const badge = document.getElementById('expiryBadge');
            const timer = document.getElementById('expiryTimer');

            if (distance < 0) {
                if (badge) badge.style.display = 'none';
                return;
            }

            if (badge) badge.style.display = 'flex';
            if (timer) timer.textContent = `${days}天 ${hours}時 ${minutes}分`;
        };

        updateTimer();
        if (this.expiryInterval) clearInterval(this.expiryInterval);
        this.expiryInterval = setInterval(updateTimer, 60000); // 每一分鐘更新一次
    }

    async setBulkRating(rating) {
        if (this.selectedPhotoIds.size === 0) return;

        const count = this.selectedPhotoIds.size;
        this.showLoading(`正在為 ${count} 張照片設置為 ${rating} 星...`);
        try {
            const promises = Array.from(this.selectedPhotoIds).map(id => {
                const photo = this.photos.find(p => p.id === id);
                if (photo) {
                    photo.rating = rating;
                    return driveManager.saveRating(id, rating);
                }
                return Promise.resolve();
            });
            await Promise.all(promises);
            toast.success(`批量操作成功！已設置 ${count} 張照片為 ${rating} 星`);

            // 重要：更新介面呈現新星等
            this.clearSelection();
            this.applyFilters();
            this.renderPhotoGrid();
            this.updateStats();
        } catch (e) {
            toast.error('批量操作失敗');
        } finally {
            this.hideLoading();
        }
    }

    // [新功能] 打包下載選取的照片
    async downloadSelected() {
        if (this.selectedPhotoIds.size === 0) {
            toast.warning('請先點擊照片右上角圓圈，選取要下載的照片');
            return;
        }
        driveManager.downloadSelectedPhotos(this.selectedPhotoIds);
    }

    updateBulkUI() {
        const bar = document.getElementById('bulkActionBar');
        const count = document.getElementById('selectedCount');
        const badge = document.getElementById('selectionBadge');
        const mobileCount = document.getElementById('mobileSelectedCount');
        const mobileBar = document.getElementById('mobileActionBar');

        if (bar && count) {
            count.textContent = this.selectedPhotoIds.size;
            if (badge) badge.textContent = this.selectedPhotoIds.size;
            if (mobileCount) mobileCount.textContent = this.selectedPhotoIds.size;

            if (this.selectedPhotoIds.size > 0) {
                bar.classList.add('active');
                if (window.innerWidth <= 1024 && mobileBar) {
                    mobileBar.style.display = 'flex';
                }

                // 初始化批量星星的懸停效果
                const stars = bar.querySelectorAll('.bulk-star');
                stars.forEach((star, idx) => {
                    star.onmouseenter = () => {
                        stars.forEach((s, sIdx) => {
                            s.style.color = sIdx <= idx ? 'var(--warning)' : '';
                        });
                    };
                });
                const group = document.getElementById('bulkStars');
                if (group) {
                    group.onmouseleave = () => {
                        stars.forEach(s => s.style.color = '');
                    };
                }
            } else {
                bar.classList.remove('active');
                if (mobileBar) mobileBar.style.display = 'none';
            }
        }
    }

    // [新功能] 客戶提交挑圖結果
    async submitJob() {
        const stats = { total: this.photos.length, rated: 0, annotated: 0, 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        this.photos.forEach(p => {
            if (p.rating > 0) stats.rated++;
            if (p.hasAnnotations) stats.annotated++;
            stats[p.rating]++;
        });

        if (stats.rated === 0 && stats.annotated === 0 && this.selectedPhotoIds.size === 0) {
            toast.warning('您尚未對任何照片進行評分、選取或標註喔！');
            return;
        }

        const msg = `您目前已評分 ${stats.rated} 張照片，包含 ${stats['5']} 張五星照片。\n確認要送出並通知攝影師嗎？\n(確認後仍可繼續修改)`;
        if (confirm(msg)) {
            this.showLoading('正在彙整您挑選的結果並通知攝影師...');
            try {
                // 強制執行一次存檔 (GAS 同步)
                if (API_CONFIG.GAS_WEB_APP_URL) {
                    await driveManager.saveToGAS(true);

                    // [New] 觸發後端 Email 通知攝影師程序
                    driveManager.notifyPhotographer(this.selectedPhotoIds, stats);
                }
                setTimeout(() => {
                    this.hideLoading();
                    toast.success('大功告成！已將挑圖結果送出。');

                    // 也可以選擇順便幫他打包下載 5 星或有評分的進度
                    if (confirm('是否要順便將您給了 5 星的照片打包下載到您的電腦中？')) {
                        driveManager.downloadFiveStarPhotos();
                    }
                }, 1500); // 模擬等待時間
            } catch (error) {
                this.hideLoading();
                toast.error('送出失敗，但您的進度已儲存。');
            }
        }
    }

    applyFilters() {
        this.filteredPhotos = this.photos.filter(p => {
            if (this.filters.stars !== 'all' && p.rating !== parseInt(this.filters.stars)) return false;
            if (this.filters.annotated === 'yes' && !p.hasAnnotations) return false;
            if (this.filters.annotated === 'no' && p.hasAnnotations) return false;
            if (this.filters.selectedOnly && !this.selectedPhotoIds.has(p.id)) return false;
            return true;
        });

        this.filteredPhotos.sort((a, b) => {
            if (this.filters.sortBy === 'rating') return b.rating - a.rating;
            if (this.filters.sortBy === 'name') return a.name.localeCompare(b.name);
            return 0;
        });
    }

    renderPhotoGrid() {
        const grid = document.getElementById('photoGrid');
        grid.innerHTML = '';
        if (this.filteredPhotos.length === 0) {
            document.getElementById('emptyState').style.display = 'flex';
            return;
        }
        document.getElementById('emptyState').style.display = 'none';

        this.filteredPhotos.forEach((photo, index) => {
            const card = this.createPhotoCard(photo, index);
            grid.appendChild(card);
        });
    }

    createPhotoCard(photo, index) {
        const card = document.createElement('div');
        const isSelected = this.selectedPhotoIds.has(photo.id);
        card.className = `photo-card ${isSelected ? 'selected' : ''}`;
        card.dataset.photoId = photo.id;

        const imageUrl = driveManager.getImageUrl(photo, true);
        card.innerHTML = `
            <div class="photo-image-container">
                <img src="${imageUrl}" class="photo-image" loading="lazy">
                <div class="photo-overlay">
                    ${photo.hasAnnotations ? '<span class="photo-badge">已標註</span>' : ''}
                </div>
                <div class="select-toggle-btn" title="選取此照片"></div>
            </div>
            <div class="photo-info-section">
                <div class="photo-name">${photo.name}</div>
                <div class="rating-container" id="rating-${photo.id.replace(/\//g, '_')}"></div>
            </div>
        `;

        const rc = card.querySelector('.rating-container');
        rc.appendChild(ratingManager.createStarRating(photo.rating, photo.id, true));

        // 專門處理右上角勾勾的點擊
        const selectBtn = card.querySelector('.select-toggle-btn');
        selectBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // 阻止觸發開 Modal
            this.toggleSelection(photo.id, index, e.shiftKey, true);
        });

        card.addEventListener('click', (e) => {
            if (e.target.closest('.star-rating')) return; // 點星星不開彈窗

            // 判斷是否為批量選取操作 (Ctrl, Cmd, 或 Shift)
            if (e.ctrlKey || e.metaKey || e.shiftKey) {
                e.preventDefault();
                this.toggleSelection(photo.id, index, e.shiftKey, (e.ctrlKey || e.metaKey));
            } else {
                // 普通點擊現在不再清除選取！
                this.openModal(index);
            }
        });
        return card;
    }

    async openModal(index) {
        if (index < 0 || index >= this.filteredPhotos.length) return;
        this.currentPhotoIndex = index;
        const photo = this.filteredPhotos[index];

        document.getElementById('photoModal').classList.add('active');
        document.getElementById('modalPhotoName').textContent = photo.name;
        document.getElementById('photoNote').value = photo.note || '';

        const mpr = document.getElementById('modalPhotoRating');
        mpr.innerHTML = '';
        mpr.appendChild(ratingManager.createStarRating(photo.rating, photo.id, true));

        this.updateModalNavigation();

        // 重置手機端工具抽屜狀態
        const sidebar = document.getElementById('modalSidebar');
        if (sidebar) sidebar.classList.remove('active');

        await annotationManager.loadPhoto(photo);
    }

    closeModal() {
        this.saveCurrentNote();
        document.getElementById('photoModal').classList.remove('active');
    }

    saveCurrentNote() {
        const val = document.getElementById('photoNote').value;
        const photo = this.filteredPhotos[this.currentPhotoIndex];
        if (photo) driveManager.saveNote(photo.id, val);
    }

    async navigatePhoto(dir) {
        this.saveCurrentNote();
        const next = this.currentPhotoIndex + dir;
        if (next >= 0 && next < this.filteredPhotos.length) {
            await this.openModal(next);
        }
    }

    updateModalNavigation() {
        document.getElementById('prevPhotoBtn').disabled = this.currentPhotoIndex === 0;
        document.getElementById('nextPhotoBtn').disabled = this.currentPhotoIndex === this.filteredPhotos.length - 1;
        document.getElementById('photoCounter').textContent = `${this.currentPhotoIndex + 1} / ${this.filteredPhotos.length}`;
    }

    updateStats() {
        const stats = { total: this.photos.length, rated: 0, annotated: 0, 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        this.photos.forEach(p => {
            const r = parseInt(p.rating) || 0;
            if (r > 0) stats.rated++;
            if (p.hasAnnotations) stats.annotated++;
            stats[r]++;
        });

        console.log('Update Stats:', stats);

        const totalEl = document.getElementById('totalPhotos');
        const ratedEl = document.getElementById('ratedPhotos');
        const annotatedEl = document.getElementById('annotatedPhotos');
        const starsAllEl = document.getElementById('starsAll');

        if (totalEl) totalEl.textContent = stats.total;
        if (ratedEl) ratedEl.textContent = stats.rated;
        if (annotatedEl) annotatedEl.textContent = stats.annotated;
        if (starsAllEl) starsAllEl.textContent = stats.total;

        for (let i = 0; i <= 5; i++) {
            const el = document.getElementById(`stars${i}`);
            if (el) el.textContent = stats[i];

            // 容錯處理：如果 HTML 用的是 stars_5 這種格式
            const elAlt = document.getElementById(`stars_${i}`);
            if (elAlt) elAlt.textContent = stats[i];
        }
    }

    // 啟動自動存檔計時器 (每 5 分鐘一次)
    startAutoSaveTimer() {
        if (this.autoSaveInterval) clearInterval(this.autoSaveInterval);

        const FIVE_MINUTES = 5 * 60 * 1000;

        this.autoSaveInterval = setInterval(async () => {
            // 只有當有照片載入且有資料夾時才執行
            if (this.photos.length > 0 && driveManager.currentFolderId) {
                console.log('%c[System] 執行定時自動備份...', 'color: #667eea; font-weight: bold;');
                await driveManager.saveToGAS(true); // true 表示為靜默存檔
            }
        }, FIVE_MINUTES);

        console.log('--- 自動存檔計時器已啟動 (每 5 分鐘一次) ---');
    }
}

document.addEventListener('DOMContentLoaded', () => { window.app = new App(); });
