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

        for (let i = 0; i < book.pages.length; i++) {
            const page = book.pages[i];
            const settings = page.type === 'inner'
                ? book.settings
                : (book.coverSettings || book.settings);

            try {
                const jpeg = await this._renderPage(page, settings);
                const typeLabel = { cover: 'cover', inner: `page_${String(i).padStart(3, '0')}`, 'back-cover': 'back' }[page.type] || `page_${i}`;
                zip.file(`${typeLabel}.jpg`, jpeg.split(',')[1], { base64: true });
            } catch (e) {
                errors.push(`頁面 ${i + 1}: ${e.message}`);
            }
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
        const pxW = Math.round(settings.width * dpi / 2.54);
        const pxH = Math.round(settings.height * dpi / 2.54);

        const canvas = document.createElement('canvas');
        canvas.width = pxW;
        canvas.height = pxH;
        const ctx = canvas.getContext('2d');

        // ① 背景色
        ctx.fillStyle = page.bg || '#ffffff';
        ctx.fillRect(0, 0, pxW, pxH);

        // ② 底圖
        if (page.bgImage?.photoId) {
            const bgImg = await this._loadImage(`${CONFIG.WORKER_URL}/${page.bgImage.photoId}`).catch(() => null);
            if (bgImg) {
                const opacity = page.bgImage.opacity ?? 1;
                const fit = page.bgImage.fit || 'cover';
                ctx.save();
                ctx.globalAlpha = opacity;
                if (fit === 'repeat') {
                    const pattern = ctx.createPattern(bgImg, 'repeat');
                    if (pattern) { ctx.fillStyle = pattern; ctx.fillRect(0, 0, pxW, pxH); }
                } else if (fit === 'contain') {
                    const s = Math.min(pxW / bgImg.naturalWidth, pxH / bgImg.naturalHeight);
                    const dw = bgImg.naturalWidth * s, dh = bgImg.naturalHeight * s;
                    ctx.drawImage(bgImg, (pxW - dw) / 2, (pxH - dh) / 2, dw, dh);
                } else { // cover
                    const s = Math.max(pxW / bgImg.naturalWidth, pxH / bgImg.naturalHeight);
                    const dw = bgImg.naturalWidth * s, dh = bgImg.naturalHeight * s;
                    ctx.drawImage(bgImg, (pxW - dw) / 2, (pxH - dh) / 2, dw, dh);
                }
                ctx.restore();
            }
        }

        // ③ 文字層（照片下方）
        this._drawTextLayers(ctx, (page.textLayers || []).filter(t => t.layer === 'below'), pxW, pxH);

        const layout = LAYOUTS[page.layout];
        if (!layout || layout.slots.length === 0) {
            // ⑤ 文字層（照片上方）even on blank pages
            this._drawTextLayers(ctx, (page.textLayers || []).filter(t => t.layer !== 'below'), pxW, pxH);
            return canvas.toDataURL('image/jpeg', 0.95);
        }

        const slotsArray = Array.isArray(page.slots) ? page.slots : [];

        // ④ 預載所有照片
        const images = await Promise.all(
            slotsArray.map(slot => {
                if (!slot?.photoId) return Promise.resolve(null);
                return this._loadImage(`${CONFIG.WORKER_URL}/${slot.photoId}`);
            })
        );

        // ④ 繪製每個 slot
        layout.slots.forEach((slotDef, idx) => {
            const img = images[idx];
            if (!img) return;

            const slot = slotsArray[idx] || {};
            const sx = slot.override?.x ?? slotDef.x;
            const sy = slot.override?.y ?? slotDef.y;
            const sw = slot.override?.w ?? slotDef.w;
            const sh = slot.override?.h ?? slotDef.h;
            const slotRotDeg = slot.override?.rotation ?? 0;

            const slotX = sx / 100 * pxW;
            const slotY = sy / 100 * pxH;
            const slotW = sw / 100 * pxW;
            const slotH = sh / 100 * pxH;
            const crop = slot.crop || { x: 0, y: 0, scale: 1 };

            ctx.save();

            // Rotate entire slot (frame + photo) around its center before clipping
            if (slotRotDeg !== 0) {
                const cx = slotX + slotW / 2;
                const cy = slotY + slotH / 2;
                ctx.translate(cx, cy);
                ctx.rotate(slotRotDeg * Math.PI / 180);
                ctx.translate(-cx, -cy);
            }

            ctx.beginPath();
            ctx.rect(slotX, slotY, slotW, slotH);
            ctx.clip();

            const rotationDeg = crop.rotation || 0;
            if (rotationDeg !== 0) {
                const cx = slotX + slotW / 2;
                const cy = slotY + slotH / 2;
                ctx.translate(cx, cy);
                ctx.rotate(rotationDeg * Math.PI / 180);
                ctx.translate(-cx, -cy);
            }

            if (slot.fit === 'contain') {
                const s = Math.min(slotW / img.naturalWidth, slotH / img.naturalHeight);
                const drawW = img.naturalWidth * s;
                const drawH = img.naturalHeight * s;
                const drawX = slotX + (slotW - drawW) / 2;
                const drawY = slotY + (slotH - drawH) / 2;
                ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, drawX, drawY, drawW, drawH);
            } else if (slot.fit === 'fit-width') {
                const s = slotW / img.naturalWidth;
                const drawW = slotW;
                const drawH = img.naturalHeight * s;
                const drawX = slotX;
                const drawY = slotY + (slotH - drawH) / 2;
                ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, drawX, drawY, drawW, drawH);
            } else if (slot.fit === 'fit-height') {
                const s = slotH / img.naturalHeight;
                const drawH = slotH;
                const drawW = img.naturalWidth * s;
                const drawX = slotX + (slotW - drawW) / 2;
                const drawY = slotY;
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
                const wW = cropScale * slotW;
                const wH = cropScale * slotH;
                const s = Math.max(wW / img.naturalWidth, wH / img.naturalHeight);
                const drawW = img.naturalWidth * s;
                const drawH = img.naturalHeight * s;
                const destImgX = slotX + (slotW - drawW) / 2 + (crop.x || 0) * slotW;
                const destImgY = slotY + (slotH - drawH) / 2 + (crop.y || 0) * slotH;
                ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, destImgX, destImgY, drawW, drawH);
            }
            ctx.restore();
        });

        // ⑤ 文字層（照片上方）
        this._drawTextLayers(ctx, (page.textLayers || []).filter(t => t.layer !== 'below'), pxW, pxH);

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

    _loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`無法載入: ${src}`));
            img.src = src;
        });
    }
};
