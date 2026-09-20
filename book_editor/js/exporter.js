// 相本書 JPG 匯出模組
const BookExporter = {

    async exportAll(book) {
        if (!book || !book.pages || book.pages.length === 0) {
            toast.warning('目前沒有頁面可以匯出');
            return;
        }

        // Wait for all fonts to be ready before canvas rendering
        await document.fonts.ready;

        toast.info(`正在渲染 ${book.pages.length} 頁，請稍候...`);

        const zip = new JSZip();
        const errors = [];

        try {
            for (let i = 0; i < book.pages.length; i++) {
                const page = book.pages[i];
                const base = page.type === 'inner'
                    ? book.settings
                    : (book.coverSettings || book.settings);
                // bleed belongs to the print job, not to one page size
                const settings = { ...base, bleed: book.settings?.bleed ?? 0 };

                try {
                    const jpeg = await this._renderPage(page, settings);
                    const typeLabel = { cover: 'cover', inner: `page_${String(i).padStart(3, '0')}`, 'back-cover': 'back' }[page.type] || `page_${i}`;
                    zip.file(`${typeLabel}.jpg`, this._jpegWithDpi(jpeg, settings.dpi || 300));
                } catch (e) {
                    errors.push(`頁面 ${i + 1}: ${e.message}`);
                }
            }
        } finally {
            // full-resolution decodes — don't hold them past the export
            this._clearImageCache();
        }

        if (errors.length > 0) {
            toast.error(`${errors.length} 頁渲染失敗，其餘頁面仍會下載`);
        }

        const content = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${book.name || '相本'}_pages.zip`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success('匯出完成！');
    },

    /**
     * Renders a single book page onto a canvas and exports it as a JPEG data URL.
     * Pre-conditions:
     *   - `page` must be a valid page object.
     *   - `settings` must be a valid settings object containing width, height, and dpi.
     * Post-conditions:
     *   - Returns a Promise that resolves to a JPEG data URL string.
     *   - Safely parses page slots defensively to handle undefined or null pages.slots arrays.
     */
    async _renderPage(page, settings) {
        const dpi = settings.dpi || 300;

        if (!settings?.width || !settings?.height) {
            throw new Error('匯出設定缺少尺寸資料，請檢查相本設定');
        }

        // Layout stays in trim coordinates throughout: pxW/pxH are the finished
        // page. The sheet is bigger by the bleed on every side, and the printer
        // cuts it back down, so anything meant to run off the edge has to be
        // painted out into that margin or the cut exposes bare paper.
        const pxW = Math.round(settings.width * dpi / 2.54);
        const pxH = Math.round(settings.height * dpi / 2.54);
        const bleedPx = Math.round(Math.max(0, settings.bleed || 0) / 10 * dpi / 2.54);
        const sheetW = pxW + bleedPx * 2;
        const sheetH = pxH + bleedPx * 2;

        const MAX_CANVAS_PX = 16383;
        if (sheetW >= MAX_CANVAS_PX || sheetH >= MAX_CANVAS_PX) {
            throw new Error(`尺寸超過瀏覽器限制 (${sheetW}×${sheetH}px)，請降低 DPI 或縮小尺寸`);
        }

        const canvas = document.createElement('canvas');
        canvas.width = sheetW;
        canvas.height = sheetH;
        const ctx = canvas.getContext('2d');

        // ① 背景色 — across the whole sheet, bleed included
        ctx.fillStyle = page.bg || '#ffffff';
        ctx.fillRect(0, 0, sheetW, sheetH);

        // ② 底圖
        if (page.bgImage?.photoId) {
            const bgImg = await this._loadImage(`${CONFIG.WORKER_URL}/${page.bgImage.photoId}`).catch(() => null);
            if (bgImg) {
                const opacity = page.bgImage.opacity ?? 1;
                const fit = page.bgImage.fit || 'cover';
                ctx.save();
                ctx.globalAlpha = opacity;
                // a page background is by definition edge-to-edge, so it fills
                // the sheet rather than stopping at the trim
                if (fit === 'repeat') {
                    const pattern = ctx.createPattern(bgImg, 'repeat');
                    if (pattern) {
                        if (bgImg.naturalWidth > 0) {
                            const tilePx = (page.bgImage.repeatSize || 10) / 100 * pxW;
                            const sc = tilePx / bgImg.naturalWidth;
                            try { pattern.setTransform(new DOMMatrix([sc, 0, 0, sc, 0, 0])); } catch (_) {}
                        }
                        ctx.fillStyle = pattern;
                        ctx.fillRect(0, 0, sheetW, sheetH);
                    }
                } else if (fit === 'contain') {
                    // contain is meant to sit inside the page, so it keeps to the trim
                    const s = Math.min(pxW / bgImg.naturalWidth, pxH / bgImg.naturalHeight);
                    const dw = bgImg.naturalWidth * s, dh = bgImg.naturalHeight * s;
                    ctx.drawImage(bgImg, bleedPx + (pxW - dw) / 2, bleedPx + (pxH - dh) / 2, dw, dh);
                } else { // cover
                    const s = Math.max(sheetW / bgImg.naturalWidth, sheetH / bgImg.naturalHeight);
                    const dw = bgImg.naturalWidth * s, dh = bgImg.naturalHeight * s;
                    ctx.drawImage(bgImg, (sheetW - dw) / 2, (sheetH - dh) / 2, dw, dh);
                }
                ctx.restore();
            }
        }

        // everything from here is positioned in trim coordinates
        ctx.translate(bleedPx, bleedPx);

        const layout = LAYOUTS[page.layout];
        const slotsArray = Array.isArray(page.slots) ? page.slots : [];

        // ③ 預載所有照片
        const images = await Promise.all(
            slotsArray.map(slot => {
                if (!slot?.photoId) return Promise.resolve(null);
                return this._loadImage(`${CONFIG.WORKER_URL}/${slot.photoId}`);
            })
        );

        const drawSlot = (slotDef, idx) => {
            const img = images[idx];
            if (!img) return;

            const slot = slotsArray[idx] || {};
            const sx = slot.override?.x ?? slotDef.x;
            const sy = slot.override?.y ?? slotDef.y;
            const sw = slot.override?.w ?? slotDef.w;
            const sh = slot.override?.h ?? slotDef.h;
            const slotRotDeg = slot.override?.rotation ?? 0;

            // the finished rectangle, which is what the preview shows and what
            // the crop offsets below are relative to
            const trimX = sx / 100 * pxW;
            const trimY = sy / 100 * pxH;
            const trimW = sw / 100 * pxW;
            const trimH = sh / 100 * pxH;

            // A slot sitting on the page edge has to keep going into the bleed,
            // or the cut lands on bare paper. Only the edges that actually
            // touch grow — an inner slot of a two-up spread keeps its inside
            // edge where it is.
            const EDGE = 0.01;
            const outL = bleedPx && sx <= EDGE ? bleedPx : 0;
            const outT = bleedPx && sy <= EDGE ? bleedPx : 0;
            const outR = bleedPx && sx + sw >= 100 - EDGE ? bleedPx : 0;
            const outB = bleedPx && sy + sh >= 100 - EDGE ? bleedPx : 0;

            const slotX = trimX - outL;
            const slotY = trimY - outT;
            const slotW = trimW + outL + outR;
            const slotH = trimH + outT + outB;
            const crop = slot.crop || { x: 0, y: 0, scale: 1 };

            ctx.save();

            const trimCx = trimX + trimW / 2;
            const trimCy = trimY + trimH / 2;

            // Rotate entire slot (frame + photo) around the trim centre before clipping
            if (slotRotDeg !== 0) {
                ctx.translate(trimCx, trimCy);
                ctx.rotate(slotRotDeg * Math.PI / 180);
                ctx.translate(-trimCx, -trimCy);
            }

            ctx.beginPath();
            ctx.rect(slotX, slotY, slotW, slotH);
            ctx.clip();

            const rotationDeg = crop.rotation || 0;
            // cover/contain: rotate the whole slot around its center (matches DOM slot-level rotation)
            // fit-width/fit-height: rotation is applied per-image around image center below
            const useSlotRotation = slot.fit !== 'fit-width' && slot.fit !== 'fit-height';
            if (rotationDeg !== 0 && useSlotRotation) {
                ctx.translate(trimCx, trimCy);
                ctx.rotate(rotationDeg * Math.PI / 180);
                ctx.translate(-trimCx, -trimCy);
            }

            if (slot.fit === 'contain') {
                const s = Math.min(trimW / img.naturalWidth, trimH / img.naturalHeight);
                const drawW = img.naturalWidth * s;
                const drawH = img.naturalHeight * s;
                const drawX = trimX + (trimW - drawW) / 2;
                const drawY = trimY + (trimH - drawH) / 2;
                ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, drawX, drawY, drawW, drawH);
            } else if (slot.fit === 'fit-width') {
                const cropScale = crop.scale || 1;
                const s = cropScale * trimW / img.naturalWidth;
                const drawW = img.naturalWidth * s;
                const drawH = img.naturalHeight * s;
                const imgCx = trimX + (0.5 + (crop.x || 0)) * trimW;
                const imgCy = trimY + (0.5 + (crop.y || 0)) * trimH;
                const drawX = imgCx - drawW / 2;
                const drawY = imgCy - drawH / 2;
                if (rotationDeg !== 0) {
                    ctx.translate(imgCx, imgCy);
                    ctx.rotate(rotationDeg * Math.PI / 180);
                    ctx.translate(-imgCx, -imgCy);
                }
                ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, drawX, drawY, drawW, drawH);
            } else if (slot.fit === 'fit-height') {
                const cropScale = crop.scale || 1;
                const s = cropScale * trimH / img.naturalHeight;
                const drawH = img.naturalHeight * s;
                const drawW = img.naturalWidth * s;
                const imgCx = trimX + (0.5 + (crop.x || 0)) * trimW;
                const imgCy = trimY + (0.5 + (crop.y || 0)) * trimH;
                const drawX = imgCx - drawW / 2;
                const drawY = imgCy - drawH / 2;
                if (rotationDeg !== 0) {
                    ctx.translate(imgCx, imgCy);
                    ctx.rotate(rotationDeg * Math.PI / 180);
                    ctx.translate(-imgCx, -imgCy);
                }
                ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, drawX, drawY, drawW, drawH);
            } else {
                /**
                 * 繪製單一相片插槽至 Canvas 上，支援 Cover 縮放與平移擷取（使用目標座標繪製以完美支援超出邊界的自由平移）。
                 *
                 * @pre
                 * - `img` 必須是已完成載入的 HTMLImageElement。
                 * - `slot.crop` 必須包含合理的 `scale` (>=1)、`x` (平移比例) 與 `y` (平移比例)。
                 * - Canvas 2D 上下文 `ctx` 必須處於可用狀態。
                 *
                 * @post
                 * - 計算影像在插槽內的目標繪製寬高及位置，在剪裁區域內進行繪製，保證平移超出邊界時亦不會發生拉伸或截斷。
                 */
                const cropScale = crop.scale || 1;
                // Grow symmetrically by the larger of the two sides so the
                // photo still covers an asymmetric expansion while staying
                // centred where the preview put it.
                const coverW = trimW + 2 * Math.max(outL, outR);
                const coverH = trimH + 2 * Math.max(outT, outB);
                const s = Math.max(cropScale * coverW / img.naturalWidth,
                                   cropScale * coverH / img.naturalHeight);
                const drawW = img.naturalWidth * s;
                const drawH = img.naturalHeight * s;
                const destImgX = trimCx - drawW / 2 + (crop.x || 0) * trimW;
                const destImgY = trimCy - drawH / 2 + (crop.y || 0) * trimH;
                ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, destImgX, destImgY, drawW, drawH);
            }
            ctx.restore();
        };

        // ④ 依共用的圖層順序繪製 — the preview walks this same list, so what
        // sits in front on screen sits in front in the file
        const textLayers = page.textLayers || [];
        for (const item of pageZOrder(page)) {
            if (item.kind === 'slot') {
                const slotDef = layout?.slots?.[item.idx];
                if (slotDef) drawSlot(slotDef, item.idx);
            } else {
                const t = textLayers[item.idx];
                if (t) this._drawTextLayers(ctx, [t], pxW, pxH);
            }
        }

        return canvas.toDataURL('image/jpeg', 0.95);
    },

    _drawTextLayers(ctx, layers, pxW, pxH) {
        for (const t of layers) {
            if (!t.text?.trim()) continue;
            const fontSize = Math.max(8, Math.round(t.size / 100 * pxW));
            const fw = t.bold ? 'bold' : 'normal';
            const fs = t.italic ? 'italic' : 'normal';
            ctx.save();
            ctx.font = `${fs} ${fw} ${fontSize}px ${t.font}`.replace(/\s+/g, ' ').trim();
            ctx.fillStyle = t.color || '#ffffff';
            ctx.textAlign = t.align || 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.55)';
            ctx.shadowBlur = Math.max(4, fontSize * 0.06);
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = Math.max(1, fontSize * 0.02);

            const boxW = t.w / 100 * pxW;
            const centerX = t.x / 100 * pxW;
            let textX;
            if (t.align === 'center') textX = centerX;
            else if (t.align === 'left') textX = centerX - boxW / 2;
            else textX = centerX + boxW / 2; // right

            const lines = t.text.split('\n');
            const lineH = fontSize * 1.35;
            const totalH = lines.length * lineH;
            const startY = t.y / 100 * pxH - totalH / 2 + lineH / 2;
            lines.forEach((line, li) => {
                ctx.fillText(line, textX, startY + li * lineH);
            });
            ctx.restore();
        }
    },

    // A photo reused across pages (a cover also used inside, a repeated
    // background) would otherwise be downloaded again for every page it
    // appears on — at full print resolution.
    _imageCache: new Map(),

    _loadImage(src) {
        const cached = this._imageCache.get(src);
        if (cached) return cached;
        const promise = new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`無法載入: ${src}`));
            img.src = src;
        });
        promise.catch(() => this._imageCache.delete(src));
        this._imageCache.set(src, promise);
        return promise;
    },

    _clearImageCache() {
        this._imageCache.clear();
    },

    /**
     * 將 canvas.toDataURL 產生的 JPEG 寫入真實 DPI 資訊。
     * 瀏覽器輸出的 JPEG 沒有密度資訊（JFIF units=0），看圖軟體會預設當成 72 dpi，
     * 導致「像素正確但公分數看起來放大 3~4 倍」。這裡直接改寫 JFIF APP0 的
     * density 欄位（units=1 inch, X/Y density = dpi），像素資料完全不動。
     * 回傳 Uint8Array 可直接交給 JSZip。
     */
    _jpegWithDpi(dataUrl, dpi) {
        const b64 = dataUrl.split(',')[1];
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

        // SOI(FFD8) + APP0(FFE0) + len + "JFIF\0" + version + units + Xdensity + Ydensity
        const isJfif = bytes[0] === 0xFF && bytes[1] === 0xD8 &&
                       bytes[2] === 0xFF && bytes[3] === 0xE0 &&
                       bytes[6] === 0x4A && bytes[7] === 0x46 &&   // 'J','F'
                       bytes[8] === 0x49 && bytes[9] === 0x46 &&   // 'I','F'
                       bytes[10] === 0x00;
        if (isJfif) {
            const d = Math.max(1, Math.min(65535, Math.round(dpi)));
            bytes[13] = 1;                  // units: dots per inch
            bytes[14] = (d >> 8) & 0xFF;    // Xdensity high byte
            bytes[15] = d & 0xFF;           // Xdensity low byte
            bytes[16] = (d >> 8) & 0xFF;    // Ydensity high byte
            bytes[17] = d & 0xFF;           // Ydensity low byte
        }
        return bytes;
    }
};
