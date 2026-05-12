// 自訂版型編輯器
const LayoutEditor = {
    slots: [],
    dragging: null,
    canvas: null,
    snapGrid: 5, // 對齊到 5% 格點

    open() {
        this.slots = [];
        this.dragging = null;
        document.getElementById('layoutName').value = '';
        this._render();
        document.getElementById('layoutEditorModal').classList.add('active');
    },

    close() {
        document.getElementById('layoutEditorModal').classList.remove('active');
    },

    _snap(v) {
        return Math.round(v / this.snapGrid) * this.snapGrid;
    },

    _pxToPercent(px, total) {
        return this._snap(Math.max(0, Math.min(100, (px / total) * 100)));
    },

    _render() {
        if (!this.canvas) return;
        this.canvas.innerHTML = this.slots.map((slot, idx) => `
            <div class="editor-slot" data-idx="${idx}" style="
                position:absolute;
                left:${slot.x}%; top:${slot.y}%;
                width:${slot.w}%; height:${slot.h}%;
            ">
                <span class="editor-slot-num">${idx + 1}</span>
                <button class="editor-slot-del" data-idx="${idx}">×</button>
                <div class="rh rh-nw" data-idx="${idx}" data-dir="nw"></div>
                <div class="rh rh-ne" data-idx="${idx}" data-dir="ne"></div>
                <div class="rh rh-se" data-idx="${idx}" data-dir="se"></div>
                <div class="rh rh-sw" data-idx="${idx}" data-dir="sw"></div>
            </div>
        `).join('');

        // 刪除按鈕
        this.canvas.querySelectorAll('.editor-slot-del').forEach(btn => {
            btn.addEventListener('click', e => {
                e.stopPropagation();
                this.slots.splice(parseInt(btn.dataset.idx), 1);
                this._render();
            });
        });

        // 移動
        this.canvas.querySelectorAll('.editor-slot').forEach(el => {
            el.addEventListener('mousedown', e => {
                if (e.target.classList.contains('rh') || e.target.classList.contains('editor-slot-del')) return;
                e.stopPropagation();
                const idx = parseInt(el.dataset.idx);
                const rect = this.canvas.getBoundingClientRect();
                this.dragging = {
                    type: 'move', idx,
                    startX: e.clientX, startY: e.clientY,
                    origX: this.slots[idx].x, origY: this.slots[idx].y,
                    cW: rect.width, cH: rect.height
                };
            });
        });

        // Resize handles
        this.canvas.querySelectorAll('.rh').forEach(handle => {
            handle.addEventListener('mousedown', e => {
                e.stopPropagation();
                const idx = parseInt(handle.dataset.idx);
                const rect = this.canvas.getBoundingClientRect();
                this.dragging = {
                    type: 'resize', idx,
                    dir: handle.dataset.dir,
                    startX: e.clientX, startY: e.clientY,
                    orig: { ...this.slots[idx] },
                    cW: rect.width, cH: rect.height
                };
            });
        });
    },

    initCanvas() {
        this.canvas = document.getElementById('layoutEditorCanvas');
        if (!this.canvas || this.canvas._bound) return;
        this.canvas._bound = true;

        // 拖拉建立新格子
        this.canvas.addEventListener('mousedown', e => {
            if (e.target !== this.canvas) return;
            const rect = this.canvas.getBoundingClientRect();
            this.dragging = {
                type: 'create',
                startX: e.clientX, startY: e.clientY,
                startPX: this._pxToPercent(e.clientX - rect.left, rect.width),
                startPY: this._pxToPercent(e.clientY - rect.top, rect.height),
                cW: rect.width, cH: rect.height,
                preview: null
            };
        });

        document.addEventListener('mousemove', e => {
            if (!this.dragging) return;
            const d = this.dragging;

            if (d.type === 'create') {
                const rect = this.canvas.getBoundingClientRect();
                const curX = this._pxToPercent(e.clientX - rect.left, rect.width);
                const curY = this._pxToPercent(e.clientY - rect.top, rect.height);
                const x = Math.min(d.startPX, curX);
                const y = Math.min(d.startPY, curY);
                const w = Math.abs(curX - d.startPX);
                const h = Math.abs(curY - d.startPY);
                if (!d.preview) {
                    d.preview = document.createElement('div');
                    d.preview.className = 'editor-slot-preview';
                    this.canvas.appendChild(d.preview);
                }
                Object.assign(d.preview.style, {
                    left: x + '%', top: y + '%', width: w + '%', height: h + '%'
                });
            }

            if (d.type === 'move') {
                const dx = (e.clientX - d.startX) / d.cW * 100;
                const dy = (e.clientY - d.startY) / d.cH * 100;
                const slot = this.slots[d.idx];
                slot.x = this._snap(Math.max(0, Math.min(100 - slot.w, d.origX + dx)));
                slot.y = this._snap(Math.max(0, Math.min(100 - slot.h, d.origY + dy)));
                const el = this.canvas.querySelector(`.editor-slot[data-idx="${d.idx}"]`);
                if (el) { el.style.left = slot.x + '%'; el.style.top = slot.y + '%'; }
            }

            if (d.type === 'resize') {
                const dx = (e.clientX - d.startX) / d.cW * 100;
                const dy = (e.clientY - d.startY) / d.cH * 100;
                const slot = this.slots[d.idx];
                const o = d.orig;
                const dir = d.dir;

                if (dir.includes('n')) {
                    slot.y = this._snap(Math.min(o.y + dy, o.y + o.h - 10));
                    slot.h = this._snap(Math.max(10, o.h - dy));
                }
                if (dir.includes('s')) slot.h = this._snap(Math.max(10, o.h + dy));
                if (dir.includes('e')) slot.w = this._snap(Math.max(10, o.w + dx));
                if (dir.includes('w')) {
                    slot.x = this._snap(Math.min(o.x + dx, o.x + o.w - 10));
                    slot.w = this._snap(Math.max(10, o.w - dx));
                }

                const el = this.canvas.querySelector(`.editor-slot[data-idx="${d.idx}"]`);
                if (el) {
                    el.style.left = slot.x + '%'; el.style.top = slot.y + '%';
                    el.style.width = slot.w + '%'; el.style.height = slot.h + '%';
                }
            }
        });

        document.addEventListener('mouseup', e => {
            if (!this.dragging) return;
            const d = this.dragging;

            if (d.type === 'create' && d.preview) {
                d.preview.remove();
                const rect = this.canvas.getBoundingClientRect();
                const curX = this._pxToPercent(e.clientX - rect.left, rect.width);
                const curY = this._pxToPercent(e.clientY - rect.top, rect.height);
                const x = Math.min(d.startPX, curX);
                const y = Math.min(d.startPY, curY);
                const w = Math.abs(curX - d.startPX);
                const h = Math.abs(curY - d.startPY);
                if (w >= 5 && h >= 5) {
                    this.slots.push({
                        x: this._snap(x), y: this._snap(y),
                        w: this._snap(Math.max(10, w)), h: this._snap(Math.max(10, h))
                    });
                    this._render();
                }
            }
            this.dragging = null;
        });
    },

    save() {
        const name = document.getElementById('layoutName')?.value.trim();
        if (!name) { toast.warning('請輸入版型名稱'); return; }
        if (this.slots.length === 0) { toast.warning('請至少建立一個格子'); return; }

        const id = `custom-${Date.now()}`;
        const layout = { name, slots: this.slots.map(s => ({ ...s })), isCustom: true };
        LAYOUTS[id] = layout;

        const saved = JSON.parse(localStorage.getItem('custom_layouts') || '{}');
        saved[id] = layout;
        localStorage.setItem('custom_layouts', JSON.stringify(saved));

        if (window.bookEditor) window.bookEditor.addCustomLayoutBtn(id, name);
        toast.success(`版型「${name}」已儲存`);
        this.close();
    },

    deleteCustom(id) {
        delete LAYOUTS[id];
        const saved = JSON.parse(localStorage.getItem('custom_layouts') || '{}');
        delete saved[id];
        localStorage.setItem('custom_layouts', JSON.stringify(saved));
    },

    loadSaved() {
        try {
            const saved = JSON.parse(localStorage.getItem('custom_layouts') || '{}');
            Object.assign(LAYOUTS, saved);
            return Object.keys(saved);
        } catch (e) { return []; }
    }
};
