// 版型定義 — 每個 slot 用百分比座標 {x, y, w, h}
// 可任意新增版型，只需加一個物件即可
const LAYOUTS = {
    'full-bleed': {
        name: '全出血',
        preview: '⬛',
        slots: [{ x: 0, y: 0, w: 100, h: 100 }]
    },
    '1-up': {
        name: '單張留白',
        preview: '▪',
        slots: [{ x: 8, y: 8, w: 84, h: 84 }]
    },
    '2-up-h': {
        name: '左右兩張',
        preview: '▪▪',
        slots: [
            { x: 0, y: 0, w: 50, h: 100 },
            { x: 50, y: 0, w: 50, h: 100 }
        ]
    },
    '2-up-v': {
        name: '上下兩張',
        preview: '▪\n▪',
        slots: [
            { x: 0, y: 0, w: 100, h: 50 },
            { x: 0, y: 50, w: 100, h: 50 }
        ]
    },
    '3-up': {
        name: '三格',
        preview: '▪▪▪',
        slots: [
            { x: 0, y: 0, w: 58, h: 100 },
            { x: 59, y: 0, w: 41, h: 49 },
            { x: 59, y: 51, w: 41, h: 49 }
        ]
    },
    '4-grid': {
        name: '四格',
        preview: '▪▪\n▪▪',
        slots: [
            { x: 0, y: 0, w: 50, h: 50 },
            { x: 50, y: 0, w: 50, h: 50 },
            { x: 0, y: 50, w: 50, h: 50 },
            { x: 50, y: 50, w: 50, h: 50 }
        ]
    },
    'blank': {
        name: '空白頁',
        preview: '□',
        slots: []
    }
};

// 產生頁面預覽 HTML（用於中欄編輯區）
function renderPageHTML(page, displayW, displayH, cropSlotIdx = -1) {
    const layout = LAYOUTS[page.layout] || LAYOUTS['blank'];
    const bg = page.bg || '#ffffff';

    const slotsHTML = layout.slots.map((slotDef, idx) => {
        const slot = page.slots[idx] || { photoId: null, crop: { x: 0, y: 0, scale: 1 } };
        const isCropActive = idx === cropSlotIdx;
        const scale = slot.crop?.scale || 1;
        const cropX = (slot.crop?.x || 0) * 100;
        const cropY = (slot.crop?.y || 0) * 100;
        const sx = slot.override?.x ?? slotDef.x;
        const sy = slot.override?.y ?? slotDef.y;
        const sw = slot.override?.w ?? slotDef.w;
        const sh = slot.override?.h ?? slotDef.h;

        let innerHTML = '';
        if (slot.photoId) {
            const src = `https://images.weserv.nl/?url=${CONFIG.WORKER_URL.replace(/^https?:\/\//, '')}/${slot.photoId}&w=800&q=80`;
            const isContain = slot.fit === 'contain';
            if (isContain) {
                innerHTML = `
                    <div class="slot-crop-wrapper" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">
                        <img src="${src}" draggable="false" style="max-width:100%;max-height:100%;object-fit:contain;display:block;pointer-events:none;">
                    </div>
                    <button class="slot-clear-btn" data-slot-idx="${idx}" title="移除照片">×</button>
                `;
            } else {
                innerHTML = `
                    <div class="slot-crop-wrapper" style="
                        position:absolute; overflow:hidden;
                        width:${100 * scale}%; height:${100 * scale}%;
                        top:50%; left:50%;
                        transform:translate(-50%,-50%);
                    ">
                        <img src="${src}" draggable="false" style="width:100%;height:100%;object-fit:cover;object-position:${50+cropX}% ${50+cropY}%;display:block;pointer-events:none;">
                    </div>
                    <button class="slot-clear-btn" data-slot-idx="${idx}" title="移除照片">×</button>
                    ${isCropActive ? '<div class="crop-hint">拖移平移 · 滾輪縮放</div>' : ''}
                `;
            }
        } else {
            innerHTML = `<div class="slot-empty-hint"><span>+</span><small>點擊放入照片</small></div>`;
        }

        return `
            <div class="page-slot ${slot.photoId ? 'has-photo' : 'empty'} ${isCropActive ? 'crop-active' : ''}"
                 data-slot-idx="${idx}"
                 style="position:absolute; left:${sx}%; top:${sy}%; width:${sw}%; height:${sh}%; overflow:hidden; box-sizing:border-box;">
                ${innerHTML}
            </div>
        `;
    }).join('');

    return `
        <div class="page-canvas" style="width:${displayW}px; height:${displayH}px; background:${bg}; position:relative; flex-shrink:0; box-shadow:0 4px 24px rgba(0,0,0,0.4);">
            ${slotsHTML}
        </div>
    `;
}

// 產生縮圖 HTML（用於左欄頁面清單）
function renderPageThumbnailHTML(page) {
    const layout = LAYOUTS[page.layout] || LAYOUTS['blank'];
    const bg = page.bg || '#ffffff';

    const slotsHTML = layout.slots.map((slotDef, idx) => {
        const slot = page.slots[idx] || { photoId: null, crop: { x: 0, y: 0, scale: 1 } };
        const tsx = slot.override?.x ?? slotDef.x;
        const tsy = slot.override?.y ?? slotDef.y;
        const tsw = slot.override?.w ?? slotDef.w;
        const tsh = slot.override?.h ?? slotDef.h;
        if (!slot.photoId) {
            return `<div style="position:absolute;left:${tsx}%;top:${tsy}%;width:${tsw}%;height:${tsh}%;background:rgba(255,255,255,0.08);box-sizing:border-box;"></div>`;
        }
        const scale = slot.crop?.scale || 1;
        const cropX = (slot.crop?.x || 0) * 100;
        const cropY = (slot.crop?.y || 0) * 100;
        const src = `https://images.weserv.nl/?url=${CONFIG.WORKER_URL.replace(/^https?:\/\//, '')}/${slot.photoId}&w=120&q=60`;
        return `
            <div style="position:absolute;left:${tsx}%;top:${tsy}%;width:${tsw}%;height:${tsh}%;overflow:hidden;box-sizing:border-box;">
                <div style="position:absolute;overflow:hidden;width:${100*scale}%;height:${100*scale}%;top:50%;left:50%;transform:translate(-50%,-50%);">
                    <img src="${src}" style="width:100%;height:100%;object-fit:cover;object-position:${50+cropX}% ${50+cropY}%;display:block;">
                </div>
            </div>
        `;
    }).join('');

    return `<div style="position:relative;width:100%;height:100%;background:${bg};overflow:hidden;">${slotsHTML}</div>`;
}
