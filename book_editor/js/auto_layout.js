// 自動排版演算法
const AutoLayout = {

    // 入口：photos 為照片陣列，style 為排版風格
    async run(photos, style = 'magazine') {
        if (!photos || photos.length === 0) return [];

        // 取得所有照片方向（用縮圖，速度快）
        const withOrient = await Promise.all(photos.map(p => this._getOrientation(p)));

        switch (style) {
            case 'uniform':  return this._uniformLayout(withOrient);
            case 'story':    return this._storyLayout(withOrient);
            case 'byRating': return this._ratingLayout(withOrient);
            default:         return this._magazineLayout(withOrient);
        }
    },

    _getOrientation(photo) {
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => {
                const orient = img.naturalWidth >= img.naturalHeight ? 'landscape' : 'portrait';
                resolve({ ...photo, orientation: orient });
            };
            img.onerror = () => resolve({ ...photo, orientation: 'landscape' });
            img.src = driveManager.getImageUrl(photo, true);
        });
    },

    _makeSlots(photoIds) {
        return photoIds.map(id => ({ photoId: id || null, crop: { x: 0, y: 0, scale: 1 } }));
    },

    _makePage(layout, photoIds) {
        const layoutDef = LAYOUTS[layout];
        const slots = layoutDef.slots.map((_, idx) => ({
            photoId: photoIds[idx] || null,
            crop: { x: 0, y: 0, scale: 1 }
        }));
        return {
            id: `page-auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: 'inner',
            layout,
            slots,
            bg: '#ffffff'
        };
    },

    // 整齊型：固定每頁 2 張
    _uniformLayout(photos) {
        const pages = [];
        for (let i = 0; i < photos.length; i += 2) {
            if (i + 1 < photos.length) {
                pages.push(this._makePage('2-up-h', [photos[i].id, photos[i + 1].id]));
            } else {
                pages.push(this._makePage('1-up', [photos[i].id]));
            }
        }
        return pages;
    },

    // 雜誌型：5星全版，依數量混搭版型
    _magazineLayout(photos) {
        const sorted = [...photos].sort((a, b) => (b.rating || 0) - (a.rating || 0));
        const pages = [];
        let i = 0;

        while (i < sorted.length) {
            const p = sorted[i];
            const r = p.rating || 0;

            if (r >= 5) {
                pages.push(this._makePage('full-bleed', [p.id]));
                i++;
            } else if (i + 3 < sorted.length) {
                pages.push(this._makePage('4-grid', sorted.slice(i, i + 4).map(x => x.id)));
                i += 4;
            } else if (i + 2 < sorted.length) {
                pages.push(this._makePage('3-up', sorted.slice(i, i + 3).map(x => x.id)));
                i += 3;
            } else if (i + 1 < sorted.length) {
                const p2 = sorted[i + 1];
                const layout = (p.orientation === 'landscape' && p2.orientation === 'landscape') ? '2-up-v' : '2-up-h';
                pages.push(this._makePage(layout, [p.id, p2.id]));
                i += 2;
            } else {
                pages.push(this._makePage('1-up', [p.id]));
                i++;
            }
        }
        return pages;
    },

    // 故事型：照片順序排列，橫式配橫式，直式配直式
    _storyLayout(photos) {
        const pages = [];
        let i = 0;

        while (i < photos.length) {
            const p = photos[i];

            if (i + 1 < photos.length) {
                const p2 = photos[i + 1];
                if (p.orientation === 'portrait' && p2.orientation === 'portrait') {
                    pages.push(this._makePage('2-up-h', [p.id, p2.id]));
                } else if (p.orientation === 'landscape' && p2.orientation === 'landscape') {
                    pages.push(this._makePage('2-up-v', [p.id, p2.id]));
                } else {
                    pages.push(this._makePage('3-up', [
                        p.id,
                        p2.id,
                        photos[i + 2]?.id || null
                    ]));
                    i += (photos[i + 2] ? 3 : 2);
                    continue;
                }
                i += 2;
            } else {
                pages.push(this._makePage('full-bleed', [p.id]));
                i++;
            }
        }
        return pages;
    },

    // 以評分決定：5星全版，4星單張，3星兩張，其餘四格
    _ratingLayout(photos) {
        const sorted = [...photos].sort((a, b) => (b.rating || 0) - (a.rating || 0));
        const pages = [];
        let i = 0;

        while (i < sorted.length) {
            const p = sorted[i];
            const r = p.rating || 0;

            if (r >= 5) {
                pages.push(this._makePage('full-bleed', [p.id]));
                i++;
            } else if (r >= 4) {
                pages.push(this._makePage('1-up', [p.id]));
                i++;
            } else if (r >= 3 && i + 1 < sorted.length) {
                pages.push(this._makePage('2-up-h', [p.id, sorted[i + 1].id]));
                i += 2;
            } else if (i + 3 < sorted.length) {
                pages.push(this._makePage('4-grid', sorted.slice(i, i + 4).map(x => x.id)));
                i += 4;
            } else {
                pages.push(this._makePage('1-up', [p.id]));
                i++;
            }
        }
        return pages;
    }
};
