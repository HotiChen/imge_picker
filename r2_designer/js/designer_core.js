/**
 * R2 Designer - Core Logic
 * 負責畫布管理、拖放交互、AI 背景處理與匯出。
 */

class Designer {
    constructor() {
        this.canvas = null;
        this.photos = [];
        this.init();
    }

    async init() {
        console.log('🚀 R2 Designer 初始化中...');

        // 1. 初始化 Fabric Canvas
        this.initCanvas();

        // 2. 綁定事件
        this.bindEvents();

        // 3. 載入 R2 素材庫
        await this.loadLibrary();

        // 4. 初始化拖放監聽
        this.initDragAndDrop();
    }

    initCanvas() {
        const container = document.getElementById('canvasContainer');
        const width = 800; // 預設 4:3 比例
        const height = 600;

        this.canvas = new fabric.Canvas('mainCanvas', {
            width: width,
            height: height,
            backgroundColor: '#ffffff',
            preserveObjectStacking: true
        });

        // 監聽選中物件時的 UI 回饋
        this.canvas.on('selection:created', (e) => this.handleSelection(e));
        this.canvas.on('selection:updated', (e) => this.handleSelection(e));

        window.mainCanvas = this.canvas; // 全域方便除錯
    }

    bindEvents() {
        // Tab 切換
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

                e.target.classList.add('active');
                const tabId = e.target.dataset.tab + 'Tab';
                document.getElementById(tabId).classList.add('active');
            });
        });

        // 背景顏色切換
        document.querySelectorAll('.color-swatch-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const color = btn.dataset.color;
                this.canvas.setBackgroundColor(color, this.canvas.renderAll.bind(this.canvas));
            });
        });

        document.getElementById('customColor').addEventListener('input', (e) => {
            this.canvas.setBackgroundColor(e.target.value, this.canvas.renderAll.bind(this.canvas));
        });

        // 匯出按鈕
        document.getElementById('exportBtn').addEventListener('click', () => this.exportProject());

        // AI 生成背景 (Mock)
        document.getElementById('generateAiBg').addEventListener('click', () => this.mockGenerateAiBg());

        // 重新整理素材庫
        document.getElementById('refreshLibrary').addEventListener('click', () => this.loadLibrary());
    }

    async loadLibrary() {
        const libraryGrid = document.getElementById('photoLibrary');
        libraryGrid.innerHTML = '<div class="loading">讀取中...</div>';

        try {
            // 從 R2 載入 (使用 driveManager，預設載入選圖工具的當前路徑)
            if (!driveManager.photos || driveManager.photos.length === 0) {
                const path = CONFIG.DEFAULT_FOLDER;
                await driveManager.initialize();
                await driveManager.loadPhotosFromFolder(path);
            }

            this.photos = driveManager.photos;
            libraryGrid.innerHTML = '';

            this.photos.forEach(photo => {
                const item = document.createElement('div');
                item.className = 'library-item';
                item.draggable = true;
                item.dataset.photoId = photo.id;

                const img = document.createElement('img');
                img.src = driveManager.getImageUrl(photo, true); // 使用縮圖
                img.loading = 'lazy';

                item.appendChild(img);

                // 拖拽開始事件
                item.addEventListener('dragstart', (e) => {
                    e.dataTransfer.setData('photoId', photo.id);
                    item.style.opacity = '0.5';
                });

                item.addEventListener('dragend', () => {
                    item.style.opacity = '1';
                });

                libraryGrid.appendChild(item);
            });

            if (this.photos.length === 0) {
                libraryGrid.innerHTML = '<div class="empty">素材庫是空的。</div>';
            }
        } catch (error) {
            console.error('素材庫加載失敗:', error);
            libraryGrid.innerHTML = '<div class="error">載入失敗。</div>';
        }
    }

    initDragAndDrop() {
        const workspace = document.querySelector('.canvas-workspace');

        workspace.addEventListener('dragover', (e) => {
            e.preventDefault();
            workspace.classList.add('drag-active');
        });

        workspace.addEventListener('dragleave', () => {
            workspace.classList.remove('drag-active');
        });

        workspace.addEventListener('drop', (e) => {
            e.preventDefault();
            workspace.classList.remove('drag-active');

            const photoId = e.dataTransfer.getData('photoId');
            if (photoId) {
                const photo = this.photos.find(p => p.id === photoId);
                if (photo) {
                    const rect = this.canvas.getElement().getBoundingClientRect();
                    const x = e.clientX - rect.left;
                    const y = e.clientY - rect.top;
                    this.addImageToCanvas(photo, x, y);
                }
            }
        });
    }

    addImageToCanvas(photo, x, y) {
        const url = driveManager.getImageUrl(photo, false); // 載入原圖

        fabric.Image.fromURL(url, (img) => {
            // 縮放並放置
            img.scaleToWidth(200);
            img.set({
                left: x || 50,
                top: y || 50,
                padding: 10,
                cornersize: 10,
                transparentCorners: false,
                borderColor: '#f38020',
                cornerColor: '#f38020',
                cornerStyle: 'circle'
            });
            this.canvas.add(img);
            this.canvas.setActiveObject(img);
            this.canvas.renderAll();
            toast.success('已加入照片');
        }, { crossOrigin: 'anonymous' });
    }

    handleSelection(e) {
        console.log('當前選中物件:', e.selected);
    }

    async mockGenerateAiBg() {
        const prompt = document.getElementById('aiPrompt').value;
        if (!prompt) {
            toast.warning('請輸入背景描述');
            return;
        }

        const loader = document.querySelector('.ai-loading');
        const preview = document.getElementById('aiResult');

        loader.style.display = 'block';
        preview.style.backgroundImage = 'none';

        // 模擬 AI 生成延遲
        setTimeout(() => {
            loader.style.display = 'none';
            // 這裡原本應該呼叫真正的 AI API (如 Stable Diffusion 或 DALL-E)
            // 目前先用 Unsplash Source 作為模擬
            const mockUrl = `https://source.unsplash.com/1600x900/?${encodeURIComponent(prompt)}`;
            preview.style.backgroundImage = `url('${mockUrl}')`;

            // 將 AI 背景套用到畫布
            fabric.Image.fromURL(mockUrl, (img) => {
                const canvasAspect = this.canvas.width / this.canvas.height;
                const imgAspect = img.width / img.height;
                let scale;
                if (canvasAspect >= imgAspect) {
                    scale = this.canvas.width / img.width;
                } else {
                    scale = this.canvas.height / img.height;
                }

                this.canvas.setBackgroundImage(img, this.canvas.renderAll.bind(this.canvas), {
                    scaleX: scale,
                    scaleY: scale,
                    originX: 'left',
                    originY: 'top'
                });
                toast.success('AI 背景生成並套用成功 (模擬)');
            }, { crossOrigin: 'anonymous' });

        }, 2500);
    }

    exportProject() {
        const dataURL = this.canvas.toDataURL({
            format: 'png',
            quality: 1
        });

        // 簡單的匯出：直接下載
        const link = document.createElement('a');
        link.download = `Album_Design_${new Date().getTime()}.png`;
        link.href = dataURL;
        link.click();

        toast.success('專案匯出成功！');
    }
}

// 實例化
window.addEventListener('DOMContentLoaded', () => {
    window.designer = new Designer();
});
