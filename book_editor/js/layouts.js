// 版型定義 — 每個 slot 用百分比座標 {x, y, w, h}
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

// 產生縮圖用 URL（?w=240，不支援 CF Image Resizing 時回傳原圖）
function _thumbUrl(photoId, w = 240) {
    return `${CONFIG.WORKER_URL}/${photoId}?w=${w}`;
}

function _escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 產生文字層 HTML
function _renderTextLayerHTML(t, displayW, selectedId) {
    const fontSize = Math.max(8, Math.round(t.size / 100 * displayW));
    const fw = t.bold ? '700' : '400';
    const fs = t.italic ? 'italic' : 'normal';
    const isSelected = t.id === selectedId;
    const zIndex = t.layer === 'below' ? 1 : 5;
    const lines = _escapeHtml(t.text || '').split('\n').join('<br>');
    return `<div class="page-text-layer${isSelected ? ' text-layer-selected' : ''}" data-text-layer-id="${t.id}"
        style="position:absolute;left:${t.x}%;top:${t.y}%;width:${t.w}%;transform:translate(-50%,-50%);text-align:${t.align};cursor:move;user-select:none;z-index:${zIndex};pointer-events:auto;">
        <span style="font-family:${t.font};font-size:${fontSize}px;font-weight:${fw};font-style:${fs};color:${t.color};line-height:1.35;white-space:pre-wrap;display:block;text-shadow:0 1px 4px rgba(0,0,0,0.55);">${lines || '&#8203;'}</span>
    </div>`;
}

// 產生頁面預覽 HTML（用於中欄編輯區）
function renderPageHTML(page, displayW, displayH, cropSlotIdx = -1) {
    const layout = LAYOUTS[page.layout] || LAYOUTS['blank'];
    const bg = page.bg || '#ffffff';

    // ─── 底圖層 ───────────────────────────────────────────────────
    let bgImageHTML = '';
    if (page.bgImage?.photoId) {
        const src = _thumbUrl(page.bgImage.photoId, 1200);
        const fit = page.bgImage.fit || 'cover';
        const opacity = page.bgImage.opacity ?? 1;
        if (fit === 'repeat') {
            const repeatSize = page.bgImage.repeatSize || 10;
            bgImageHTML = `<div class="page-bgimage" style="position:absolute;inset:0;z-index:0;opacity:${opacity};pointer-events:none;background-image:url('${src}');background-size:${repeatSize}%;background-repeat:repeat;"></div>`;
        } else {
            bgImageHTML = `<div class="page-bgimage" style="position:absolute;inset:0;z-index:0;opacity:${opacity};pointer-events:none;overflow:hidden;"><img src="${src}" draggable="false" style="width:100%;height:100%;object-fit:${fit};display:block;pointer-events:none;"></div>`;
        }
    }

    // ─── 文字層 ───────────────────────────────────────────────────
    const selectedId = window.bookEditor?.selectedTextLayerId;
    const textLayers = page.textLayers || [];
    const textBelow = textLayers.filter(t => t.layer === 'below').map(t => _renderTextLayerHTML(t, displayW, selectedId)).join('');
    const textAbove = textLayers.filter(t => t.layer !== 'below').map(t => _renderTextLayerHTML(t, displayW, selectedId)).join('');

    // ─── 照片格子層 ───────────────────────────────────────────────
    const slotsHTML = layout.slots.map((slotDef, idx) => {
        const slot = page.slots[idx] || { photoId: null, crop: { x: 0, y: 0, scale: 1 } };
        const isCropActive = idx === cropSlotIdx;
        const crop = slot.crop || { x: 0, y: 0, scale: 1 };
        const scale = crop.scale || 1;
        const cropX = (crop.x || 0) * 100;
        const cropY = (crop.y || 0) * 100;
        const rotation = crop.rotation || 0;
        const sx = slot.override?.x ?? slotDef.x;
        const sy = slot.override?.y ?? slotDef.y;
        const sw = slot.override?.w ?? slotDef.w;
        const sh = slot.override?.h ?? slotDef.h;

        let innerHTML = '';
        if (slot.photoId) {
            const src = _thumbUrl(slot.photoId, 1200);
            const fitMode = slot.fit || 'cover';
            if (fitMode === 'contain') {
                innerHTML = `
                    <div style="position:absolute;inset:0;overflow:hidden;">
                        <div class="slot-crop-wrapper" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">
                            <img src="${src}" draggable="false" style="max-width:100%;max-height:100%;object-fit:contain;display:block;pointer-events:none;">
                        </div>
                    </div>
                    <button class="slot-clear-btn" data-slot-idx="${idx}" title="移除照片">×</button>
                `;
            } else if (fitMode === 'fit-width') {
                innerHTML = `
                    <div class="slot-crop-wrapper" style="position:absolute;inset:0;overflow:hidden;">
                        <img src="${src}" draggable="false" style="
                            position:absolute;
                            width:${100 * scale}%; height:auto;
                            left:${50 + cropX}%; top:${50 + cropY}%;
                            transform:translate(-50%,-50%);
                            display:block; pointer-events:none;">
                    </div>
                    <button class="slot-clear-btn" data-slot-idx="${idx}" title="移除照片">×</button>
                    ${isCropActive ? '<div class="crop-hint">拖移平移 · 滾輪縮放 · ↻ 拖旋轉鈕</div>' : ''}
                `;
            } else if (fitMode === 'fit-height') {
                innerHTML = `
                    <div class="slot-crop-wrapper" style="position:absolute;inset:0;overflow:hidden;">
                        <img src="${src}" draggable="false" style="
                            position:absolute;
                            width:auto; height:${100 * scale}%;
                            left:${50 + cropX}%; top:${50 + cropY}%;
                            transform:translate(-50%,-50%);
                            display:block; pointer-events:none;">
                    </div>
                    <button class="slot-clear-btn" data-slot-idx="${idx}" title="移除照片">×</button>
                    ${isCropActive ? '<div class="crop-hint">拖移平移 · 滾輪縮放 · ↻ 拖旋轉鈕</div>' : ''}
                `;
            } else {
                innerHTML = `
                    <div class="slot-crop-wrapper" style="position:absolute;inset:0;overflow:hidden;">
                        <img src="${src}" draggable="false" style="
                            position:absolute;
                            width:${100 * scale}%; height:${100 * scale}%;
                            left:${50 + cropX}%; top:${50 + cropY}%;
                            transform:translate(-50%,-50%);
                            object-fit:cover; display:block; pointer-events:none;">
                    </div>
                    <button class="slot-clear-btn" data-slot-idx="${idx}" title="移除照片">×</button>
                    ${isCropActive ? '<div class="crop-hint">拖移平移 · 滾輪縮放 · ↻ 拖旋轉鈕</div>' : ''}
                `;
            }
        } else {
            innerHTML = `<div class="slot-empty-hint"><span>+</span><small>點擊放入照片</small></div>`;
        }

        if (slot.photoId && !isCropActive) {
            innerHTML += `<div class="slot-rc-hint">右鍵</div>`;
        }

        return `
            <div class="page-slot ${slot.photoId ? 'has-photo' : 'empty'} ${isCropActive ? 'crop-active' : ''}"
                 data-slot-idx="${idx}"
                 data-slot-w="${sw}" data-slot-h="${sh}"
                 style="position:absolute; left:${sx}%; top:${sy}%; width:${sw}%; height:${sh}%; box-sizing:border-box; z-index:2; transform:rotate(${rotation}deg); transform-origin:center center;">
                ${innerHTML}
            </div>
        `;
    }).join('');

    return `
        <div class="page-canvas" style="width:${displayW}px; height:${displayH}px; background:${bg}; position:relative; flex-shrink:0; box-shadow:0 4px 24px rgba(0,0,0,0.4);">
            ${bgImageHTML}
            ${textBelow}
            ${slotsHTML}
            ${textAbove}
        </div>
    `;
}

// 產生縮圖 HTML（用於左欄頁面清單）
function renderPageThumbnailHTML(page) {
    const layout = LAYOUTS[page.layout] || LAYOUTS['blank'];
    const bg = page.bg || '#ffffff';

    // 底圖縮圖
    let bgThumbHTML = '';
    if (page.bgImage?.photoId) {
        const src = _thumbUrl(page.bgImage.photoId, 240);
        const fit = page.bgImage.fit || 'cover';
        const opacity = page.bgImage.opacity ?? 1;
        bgThumbHTML = `<div style="position:absolute;inset:0;opacity:${opacity};pointer-events:none;overflow:hidden;z-index:0;"><img src="${src}" style="width:100%;height:100%;object-fit:${fit};display:block;"></div>`;
    }

    const slotsHTML = layout.slots.map((slotDef, idx) => {
        const slot = page.slots[idx] || { photoId: null, crop: { x: 0, y: 0, scale: 1 } };
        const tsx = slot.override?.x ?? slotDef.x;
        const tsy = slot.override?.y ?? slotDef.y;
        const tsw = slot.override?.w ?? slotDef.w;
        const tsh = slot.override?.h ?? slotDef.h;
        if (!slot.photoId) {
            return `<div style="position:absolute;left:${tsx}%;top:${tsy}%;width:${tsw}%;height:${tsh}%;background:rgba(255,255,255,0.08);box-sizing:border-box;z-index:2;"></div>`;
        }
        const scale = slot.crop?.scale || 1;
        const cropX = (slot.crop?.x || 0) * 100;
        const cropY = (slot.crop?.y || 0) * 100;
        const src = _thumbUrl(slot.photoId, 240);
        return `
            <div style="position:absolute;left:${tsx}%;top:${tsy}%;width:${tsw}%;height:${tsh}%;overflow:hidden;box-sizing:border-box;z-index:2;">
                <img src="${src}" style="
                    position:absolute;
                    width:${100*scale}%;height:${100*scale}%;
                    left:${50+cropX}%;top:${50+cropY}%;
                    transform:translate(-50%,-50%);
                    object-fit:cover;display:block;">
            </div>
        `;
    }).join('');

    return `<div style="position:relative;width:100%;height:100%;background:${bg};overflow:hidden;">${bgThumbHTML}${slotsHTML}</div>`;
}
