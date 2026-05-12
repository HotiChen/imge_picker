// Image Annotation System (選圖軟體 功能回傳版 - 支援編號、縮放、平移與自動儲存)
class AnnotationManager {
    constructor() {
        this.canvas = null;
        this.ctx = null;
        this.currentPhoto = null;
        this.isDrawing = false;
        this.isPanning = false;
        this.startX = 0;
        this.startY = 0;
        this.annotations = [];
        this.currentTool = 'pan';
        this.currentColor = '#ff4757';
        this.brushSize = 3;
        this.imageElement = null;

        // 縮放和平移
        this.zoom = 1;
        this.minZoom = 0.5;
        this.maxZoom = 5;
        this.panX = 0;
        this.panY = 0;
        this.lastPanX = 0;
        this.lastPanY = 0;

        // 選擇工具
        this.selectedAnnotation = null;
        this.isMovingAnnotation = false;
        this.moveStartX = 0;
        this.moveStartY = 0;
    }

    // 初始化畫布
    initialize(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        // 設定畫布事件
        this.canvas.addEventListener('mousedown', this.startDrawing.bind(this));
        this.canvas.addEventListener('mousemove', this.draw.bind(this));
        this.canvas.addEventListener('mouseup', this.stopDrawing.bind(this));
        this.canvas.addEventListener('mouseleave', this.stopDrawing.bind(this));

        // 滾輪縮放
        this.canvas.addEventListener('wheel', this.handleWheel.bind(this));

        // 觸控支援
        this.canvas.addEventListener('touchstart', this.handleTouch.bind(this));
        this.canvas.addEventListener('touchmove', this.handleTouch.bind(this));
        this.canvas.addEventListener('touchend', this.stopDrawing.bind(this));

        // 監聽視窗縮放
        window.addEventListener('resize', () => {
            if (this.imageElement) {
                this.resizeCanvas(this.imageElement);
                this.redraw();
            }
        });
    }

    // 載入照片到畫布
    async loadPhoto(photo) {
        this.currentPhoto = photo;
        // 載入該照片的標注（深拷貝避免引用問題）
        this.annotations = photo.annotations ? JSON.parse(JSON.stringify(photo.annotations)) : [];

        // 重置 Undo/Redo 棧
        this.undoStack = [];
        this.redoStack = [];

        console.log(`載入照片 ${photo.name}，標注數量：${this.annotations.length}`, this.annotations);

        // 儲存初始狀態到 Undo 棧
        this.undoStack.push(JSON.stringify(this.annotations));

        // 重置縮放和平移
        this.zoom = 1;
        this.panX = 0;
        this.panY = 0;

        // 清除選擇狀態
        this.selectedAnnotation = null;
        this.isMovingAnnotation = false;

        // 更新縮放顯示與 UI 狀態
        this.updateZoomDisplay();
        this.updateUndoRedoUI();

        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous'; // R2 支援 CORS，不需要 blob 下載

            img.onload = () => {
                this.imageElement = img;
                this.resizeCanvas(img);
                this.redraw();
                resolve();
            };

            img.onerror = (error) => {
                console.error('載入圖片失敗:', error);
                toast.error('載入圖片失敗');
                reject(error);
            };

            // R2 直接使用 URL，不需 Auth Header
            img.src = driveManager.getImageUrl(photo);
        });
    }

    // 儲存當前狀態到 Undo 棧 (用於 Undo/Redo)
    saveState() {
        const state = JSON.stringify(this.annotations);
        // 如果新狀態跟最後一個狀態不同，才存入
        if (this.undoStack.length === 0 || this.undoStack[this.undoStack.length - 1] !== state) {
            this.undoStack.push(state);
            // 限制棧長度
            if (this.undoStack.length > 50) this.undoStack.shift();
            // 動作發生後，Redo 棧要清空
            this.redoStack = [];
            this.updateUndoRedoUI();
        }
    }

    updateUndoRedoUI() {
        const undoBtn = document.getElementById('undoBtn');
        const redoBtn = document.getElementById('redoBtn');
        if (undoBtn) undoBtn.disabled = this.undoStack.length <= 1;
        if (redoBtn) redoBtn.disabled = this.redoStack.length === 0;
    }

    undo() {
        if (this.undoStack.length <= 1) return;

        // 把當前狀態移到 Redo 棧
        const currentState = this.undoStack.pop();
        this.redoStack.push(currentState);

        // 套用上一個狀態
        const previousState = this.undoStack[this.undoStack.length - 1];
        this.annotations = JSON.parse(previousState);

        this.selectedAnnotation = null;
        this.redraw();
        this.autoSave();
        this.updateUndoRedoUI();
        toast.info('已復原');
    }

    redo() {
        if (this.redoStack.length === 0) return;

        // 把 Redo 棧頂端移回 Undo 棧
        const nextState = this.redoStack.pop();
        this.undoStack.push(nextState);

        // 套用該狀態
        this.annotations = JSON.parse(nextState);

        this.selectedAnnotation = null;
        this.redraw();
        this.autoSave();
        this.updateUndoRedoUI();
        toast.info('已重做');
    }

    // 調整畫布大小以符合圖片
    resizeCanvas(img) {
        const container = this.canvas.parentElement;
        const maxWidth = container.clientWidth - 0; // 電影模式拿掉 padding
        const maxHeight = container.clientHeight - 0;

        let width = img.width;
        let height = img.height;

        // 計算縮放比例
        const scale = Math.min(maxWidth / width, maxHeight / height, 1);

        width *= scale;
        height *= scale;

        this.canvas.width = width;
        this.canvas.height = height;

        // 儲存原始縮放比例
        this.scale = scale;
    }

    // 重新繪製畫布
    redraw() {
        if (!this.imageElement) return;

        // 清除畫布
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // 儲存當前狀態
        this.ctx.save();

        // 應用縮放和平移
        this.ctx.translate(this.panX, this.panY);
        this.ctx.scale(this.zoom, this.zoom);

        // 繪製圖片
        this.ctx.drawImage(this.imageElement, 0, 0, this.canvas.width, this.canvas.height);

        // 繪製所有標注
        this.annotations.forEach(annotation => {
            this.drawAnnotation(annotation);
        });

        // 繪製選中效果
        if (this.selectedAnnotation) {
            const ann = this.selectedAnnotation;
            if (ann.type === 'circle') {
                const width = Math.abs(ann.endX - ann.startX);
                const height = Math.abs(ann.endY - ann.startY);
                const centerX = (ann.startX + ann.endX) / 2;
                const centerY = (ann.startY + ann.endY) / 2;
                const radius = Math.min(width, height) / 2;

                // 繪製虛線選中框
                this.ctx.setLineDash([8, 4]);
                this.ctx.strokeStyle = '#00aaff';
                this.ctx.lineWidth = 2;
                this.ctx.beginPath();
                this.ctx.arc(centerX, centerY, radius + 5, 0, 2 * Math.PI);
                this.ctx.stroke();
                this.ctx.setLineDash([]);
            }
        }

        // 恢復狀態
        this.ctx.restore();
    }

    // 繪製標注 (支援編號)
    drawAnnotation(annotation) {
        if (annotation.type === 'circle') {
            this.ctx.strokeStyle = annotation.color;
            this.ctx.lineWidth = annotation.size;
            this.ctx.lineCap = 'round';
            this.ctx.lineJoin = 'round';

            const width = Math.abs(annotation.endX - annotation.startX);
            const height = Math.abs(annotation.endY - annotation.startY);
            const centerX = (annotation.startX + annotation.endX) / 2;
            const centerY = (annotation.startY + annotation.endY) / 2;
            const radius = Math.min(width, height) / 2;

            this.ctx.beginPath();
            this.ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
            this.ctx.stroke();

            // 繪製序號 (關鍵回歸功能)
            if (annotation.number) {
                this.ctx.font = 'bold 20px Inter, sans-serif';
                this.ctx.textAlign = 'center';
                this.ctx.textBaseline = 'middle';
                const numX = centerX - radius * 0.7;
                const numY = centerY - radius * 0.7;

                // 畫圈背景
                this.ctx.fillStyle = annotation.color;
                this.ctx.beginPath();
                this.ctx.arc(numX, numY, 15, 0, 2 * Math.PI);
                this.ctx.fill();

                // 畫文字
                this.ctx.fillStyle = 'white';
                this.ctx.fillText(annotation.number.toString(), numX, numY);
            }
        }
    }

    // 開始繪圖
    startDrawing(e) {
        if (this.currentTool === 'eraser') {
            this.saveState(); // 紀錄清除前的狀態
            this.clearAnnotations();
            return;
        }

        if (this.currentTool === 'pan') {
            if (this.zoom <= 1.0) {
                toast.info('請先放大照片再使用平移功能');
                return;
            }
            this.isPanning = true;
            this.lastPanX = e.clientX;
            this.lastPanY = e.clientY;
            this.canvas.style.cursor = 'grabbing';
            return;
        }

        const rect = this.canvas.getBoundingClientRect();
        const canvasX = (e.clientX - rect.left - this.panX) / this.zoom;
        const canvasY = (e.clientY - rect.top - this.panY) / this.zoom;

        if (this.currentTool === 'select') {
            const annotation = this.getAnnotationAt(canvasX, canvasY);
            if (annotation) {
                this.selectAnnotation(annotation);
                this.isMovingAnnotation = true;
                this.moveStartX = canvasX;
                this.moveStartY = canvasY;
                this.canvas.style.cursor = 'move';
                this.saveState(); // 開始移動前先存紀錄
            } else {
                this.selectAnnotation(null);
            }
            return;
        }

        this.isDrawing = true;
        this.startX = canvasX;
        this.startY = canvasY;
    }

    // 繪圖中
    draw(e) {
        if (this.isPanning) {
            this.panX += (e.clientX - this.lastPanX);
            this.panY += (e.clientY - this.lastPanY);
            this.lastPanX = e.clientX;
            this.lastPanY = e.clientY;
            this.redraw();
            return;
        }

        if (this.isMovingAnnotation && this.selectedAnnotation) {
            const rect = this.canvas.getBoundingClientRect();
            const canvasX = (e.clientX - rect.left - this.panX) / this.zoom;
            const canvasY = (e.clientY - rect.top - this.panY) / this.zoom;
            this.moveAnnotation(this.selectedAnnotation, canvasX - this.moveStartX, canvasY - this.moveStartY);
            this.moveStartX = canvasX;
            this.moveStartY = canvasY;
            this.redraw();
            return;
        }

        if (!this.isDrawing) return;

        const rect = this.canvas.getBoundingClientRect();
        const currentX = (e.clientX - rect.left - this.panX) / this.zoom;
        const currentY = (e.clientY - rect.top - this.panY) / this.zoom;

        this.redraw();
        this.ctx.save();
        this.ctx.translate(this.panX, this.panY);
        this.ctx.scale(this.zoom, this.zoom);
        this.ctx.strokeStyle = this.currentColor;
        this.ctx.lineWidth = this.brushSize;

        if (this.currentTool === 'circle') {
            const radius = Math.min(Math.abs(currentX - this.startX), Math.abs(currentY - this.startY)) / 2;
            this.ctx.beginPath();
            this.ctx.arc((this.startX + currentX) / 2, (this.startY + currentY) / 2, radius, 0, 2 * Math.PI);
            this.ctx.stroke();
        }
        this.ctx.restore();
    }

    // 停止繪圖
    stopDrawing(e) {
        if (this.isPanning) {
            this.isPanning = false;
            this.updateCursor();
            return;
        }

        if (this.isMovingAnnotation) {
            this.isMovingAnnotation = false;
            this.autoSave();
            this.updateCursor();
            return;
        }

        if (!this.isDrawing) return;
        this.isDrawing = false;
        this.updateCursor();

        const rect = this.canvas.getBoundingClientRect();
        const endX = (e.clientX - rect.left - this.panX) / this.zoom;
        const endY = (e.clientY - rect.top - this.panY) / this.zoom;

        if (Math.abs(endX - this.startX) > 10) {
            const circleCount = this.annotations.filter(a => a.type === 'circle').length;
            this.annotations.push({
                type: 'circle',
                startX: this.startX,
                startY: this.startY,
                endX: endX,
                endY: endY,
                color: this.currentColor,
                size: this.brushSize,
                number: circleCount + 1,
                timestamp: Date.now()
            });
            this.redraw();
            this.saveState(); // 畫完存紀錄
            this.autoSave();
        }
    }

    handleTouch(e) {
        e.preventDefault();
        const touch = e.touches[0];
        const type = e.type === 'touchstart' ? 'mousedown' : 'mousemove';
        const mouseEvent = new MouseEvent(type, { clientX: touch.clientX, clientY: touch.clientY });
        this.canvas.dispatchEvent(mouseEvent);
    }

    setTool(tool) {
        this.currentTool = tool;
        this.updateCursor();
    }

    updateCursor() {
        if (!this.canvas) return;
        switch (this.currentTool) {
            case 'pan': this.canvas.style.cursor = 'grab'; break;
            case 'select': this.canvas.style.cursor = 'default'; break;
            case 'circle': this.canvas.style.cursor = 'crosshair'; break;
            case 'eraser': this.canvas.style.cursor = 'pointer'; break;
            default: this.canvas.style.cursor = 'crosshair';
        }
    }

    setColor(color) { this.currentColor = color; }
    setBrushSize(size) { this.brushSize = size; }

    clearAnnotations() {
        this.annotations = [];
        this.redraw();
        this.autoSave();
        toast.info('已清除標注');
    }

    autoSave() {
        if (!this.currentPhoto) return;
        driveManager.saveAnnotations(this.currentPhoto.id, this.annotations);
        if (window.app) window.app.updateStats();
    }

    handleWheel(e) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;

        // 獲取滑鼠在畫布上的相對位置
        const rect = this.canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        this.zoomBy(delta, mouseX, mouseY);
    }

    zoomBy(delta, mouseX = null, mouseY = null) {
        const oldZoom = this.zoom;
        this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom + delta));

        // 如果有指定滑鼠位置，執行「對著滑鼠縮放」的數學計算
        if (mouseX !== null && mouseY !== null && oldZoom !== this.zoom) {
            // 計算滑鼠位置在圖片世界座標系中的點
            const worldX = (mouseX - this.panX) / oldZoom;
            const worldY = (mouseY - this.panY) / oldZoom;

            // 調整平移量，使得該世界座標點在縮放後依然維持在滑鼠位置
            this.panX = mouseX - worldX * this.zoom;
            this.panY = mouseY - worldY * this.zoom;
        }

        this.redraw();
        this.updateZoomDisplay();
    }

    resetZoom() {
        this.zoom = 1; this.panX = 0; this.panY = 0;
        this.redraw();
        this.updateZoomDisplay();
        toast.info('已重置縮放');
    }

    updateZoomDisplay() {
        const el = document.getElementById('zoomLevel');
        if (el) el.textContent = `${Math.round(this.zoom * 100)}%`;
    }

    getAnnotationAt(x, y) {
        for (let i = this.annotations.length - 1; i >= 0; i--) {
            const ann = this.annotations[i];
            const centerX = (ann.startX + ann.endX) / 2;
            const centerY = (ann.startY + ann.endY) / 2;
            const radius = Math.min(Math.abs(ann.endX - ann.startX), Math.abs(ann.endY - ann.startY)) / 2;
            const dist = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);
            if (dist <= radius + 10) return ann;
        }
        return null;
    }

    selectAnnotation(ann) {
        this.selectedAnnotation = ann;
        this.redraw();
        const deleteBtn = document.getElementById('deleteSelectedBtn');
        if (deleteBtn) deleteBtn.style.display = ann ? 'flex' : 'none';
    }

    deleteSelected() {
        if (!this.selectedAnnotation) return;
        this.saveState(); // 刪除前存紀錄
        const index = this.annotations.indexOf(this.selectedAnnotation);
        if (index !== -1) {
            this.annotations.splice(index, 1);
            this.renumberCircles();
            this.selectedAnnotation = null;
            this.redraw();
            this.autoSave();
            toast.success('已刪除');
        }
    }

    renumberCircles() {
        let count = 1;
        this.annotations.forEach(a => { if (a.type === 'circle') a.number = count++; });
    }

    moveAnnotation(ann, dx, dy) {
        ann.startX += dx; ann.startY += dy; ann.endX += dx; ann.endY += dy;
    }
}

window.annotationManager = new AnnotationManager();
