// 相本書 JPG 匯出模組
const BookExporter = {

    async exportAll(book) {
        if (!book || !book.pages || book.pages.length === 0) {
            toast.warning('目前沒有頁面可以匯出');
            return;
        }

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

    async _renderPage(page, settings) {
        const dpi = settings.dpi || 300;
        const pxW = Math.round(settings.width * dpi / 2.54);
        const pxH = Math.round(settings.height * dpi / 2.54);

        const canvas = document.createElement('canvas');
        canvas.width = pxW;
        canvas.height = pxH;
        const ctx = canvas.getContext('2d');

        // 背景
        ctx.fillStyle = page.bg || '#ffffff';
        ctx.fillRect(0, 0, pxW, pxH);

        const layout = LAYOUTS[page.layout];
        if (!layout || layout.slots.length === 0) {
            return canvas.toDataURL('image/jpeg', 0.95);
        }

        // 預載所有照片
        const images = await Promise.all(
            page.slots.map(slot => {
                if (!slot?.photoId) return Promise.resolve(null);
                return this._loadImage(`${CONFIG.WORKER_URL}/${slot.photoId}`);
            })
        );

        // 繪製每個 slot
        layout.slots.forEach((slotDef, idx) => {
            const img = images[idx];
            if (!img) return;

            const slot = page.slots[idx] || {};
            const sx = slot.override?.x ?? slotDef.x;
            const sy = slot.override?.y ?? slotDef.y;
            const sw = slot.override?.w ?? slotDef.w;
            const sh = slot.override?.h ?? slotDef.h;

            const slotX = sx / 100 * pxW;
            const slotY = sy / 100 * pxH;
            const slotW = sw / 100 * pxW;
            const slotH = sh / 100 * pxH;
            const crop = slot.crop || { x: 0, y: 0, scale: 1 };

            ctx.save();
            ctx.beginPath();
            ctx.rect(slotX, slotY, slotW, slotH);
            ctx.clip();

            if (slot.fit === 'contain') {
                // Fit longest edge — letterbox/pillarbox, no cropping
                const s = Math.min(slotW / img.naturalWidth, slotH / img.naturalHeight);
                const drawW = img.naturalWidth * s;
                const drawH = img.naturalHeight * s;
                const drawX = slotX + (slotW - drawW) / 2;
                const drawY = slotY + (slotH - drawH) / 2;
                ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight, drawX, drawY, drawW, drawH);
            } else {
                // Cover — crop to fill slot (object-position formula)
                const cropScale = crop.scale || 1;
                const wW = cropScale * slotW;
                const wH = cropScale * slotH;
                const s = Math.max(wW / img.naturalWidth, wH / img.naturalHeight);
                const ox = img.naturalWidth * s - wW;
                const oy = img.naturalHeight * s - wH;
                const cx = 0.5 + (crop.x || 0);
                const cy = 0.5 + (crop.y || 0);
                const srcX = (ox * cx + (wW - slotW) / 2) / s;
                const srcY = (oy * cy + (wH - slotH) / 2) / s;
                const srcW = slotW / s;
                const srcH = slotH / s;
                ctx.drawImage(img, srcX, srcY, srcW, srcH, slotX, slotY, slotW, slotH);
            }
            ctx.restore();
        });

        return canvas.toDataURL('image/jpeg', 0.95);
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
