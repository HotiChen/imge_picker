// Import a GUEST'S album layout (Layout JSON v2, docs/guest-shop.md "S3 — 客人相本排版") into book_editor as an ordinary,
// editable book. PURE: no DOM, no network, reads no image. Loaded as a plain script (adds ImportLayout) and by node as a
// module (module.exports), like spread_templates.js.
//
//   ImportLayout.layoutToBook(layout, { name, bleedMm, now, templates }) -> book   (throws Error with a Chinese message)
//
// The book: A4 spread sheets (42 x 29.7 cm, pagesPerSheet 2) inside, an A4 single page (21 x 29.7 cm) for the cover; one
// `cover` page, one `inner` page per spread, a `back-cover` page when the guest layout has a back. Each spread becomes the
// custom layout `custom-<templateId>[-m]` (the way book_editor stores them: embedded in the book as `_customLayouts`),
// slot rectangles = the template's fractions of the WHOLE spread x 100 (mirrored: x -> 1-x-w), a `span` slot stays one wide
// slot. Slots keep the template's order; fit and crop are carried as the guest set them (the Worker already holds crop x/y to ±5 and scale to 1, so a real order is never altered; a value outside that can only come from a hand-made layout and is clamped into range, scale 1 if out of (0, 10]).
//
// Everything the guest controls (photo keys) is checked with the Worker's own rule (bookPhotoIdSafe) before it goes in;
// the layout's name is a fixed label made from the template's own name, never guest text.
const ImportLayout = (() => {
    const MAX_SPREADS = 200;               // the Worker's own cap on a guest layout
    const CROP_MAX = 5;                    // what a guest layout may hold (Worker); the Worker's PUT accepts far more
    const BOOK_KEY_MAX = 1024;
    // worker.js UNSAFE_KEY_CHAR / bookPhotoIdSafe, copied (a test compares the verdicts on both)
    const UNSAFE_KEY_CHAR = /["<>`\\\x00-\x1f\x7f-\x9f\u{61c}\u{200e}\u{200f}\u{2028}\u{2029}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{feff}\u{d800}-\u{dfff}]/u;
    const keySafe = k => typeof k === 'string' && k.length > 0 && k.length <= BOOK_KEY_MAX && !UNSAFE_KEY_CHAR.test(k);
    const UNSAFE_KEY_CHARS = new RegExp(UNSAFE_KEY_CHAR.source, 'gu');
    const NAME_MAX = 60;
    const DEFAULT_NAME = '客人排版匯入';

    const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
    const round6 = n => Math.round(n * 1e6) / 1e6;

    function cleanName(raw) {
        let s = typeof raw === 'string' ? raw.replace(UNSAFE_KEY_CHARS, '').replace(/\s+/g, ' ').trim() : '';
        s = Array.from(s).slice(0, NAME_MAX).join('').trim();
        return s || DEFAULT_NAME;
    }

    function cropOf(c, where) {
        if (c === undefined || c === null) return { x: 0, y: 0, scale: 1 };
        const bad = () => new Error(`${where}的裁切資料格式不正確`);
        if (!isObj(c)) throw bad();
        const lim = v => {
            if (v === undefined) return 0;
            if (typeof v !== 'number' || !Number.isFinite(v)) throw bad();
            return Math.max(-CROP_MAX, Math.min(CROP_MAX, v));
        };
        let scale = c.scale === undefined ? 1 : c.scale;
        if (typeof scale !== 'number' || !Number.isFinite(scale)) throw bad();
        if (!(scale > 0 && scale <= 10)) scale = 1;
        return { x: lim(c.x), y: lim(c.y), scale };
    }

    function slotOf(s, where) {
        if (!isObj(s)) throw new Error(`${where}的內容不正確`);
        if (!keySafe(s.photo_key)) throw new Error(`${where}的照片路徑不正確或含有不允許的字元`);
        if (s.fit !== 'contain' && s.fit !== 'cover') throw new Error(`${where}的填滿方式不正確`);
        return { photoId: s.photo_key, crop: cropOf(s.crop, where), fit: s.fit };
    }

    function layoutToBook(layout, opts) {
        const o = isObj(opts) ? opts : {};
        const templates = o.templates || (typeof SpreadTemplates !== 'undefined' ? SpreadTemplates : null);
        if (!templates || typeof templates.byId !== 'function') throw new Error('版型資料庫尚未載入');
        if (!isObj(layout) || layout.v !== 2) throw new Error('這不是客人排的版面（格式不是 v2）');
        if (!Array.isArray(layout.spreads)) throw new Error('排版裡沒有跨頁清單');
        if (layout.spreads.length === 0) throw new Error('排版裡沒有任何跨頁');
        if (layout.spreads.length > MAX_SPREADS) throw new Error('排版的跨頁數過多');
        const bleed = typeof o.bleedMm === 'number' && Number.isFinite(o.bleedMm) && o.bleedMm >= 0 && o.bleedMm <= 10 ? o.bleedMm : 3;
        const now = typeof o.now === 'number' && Number.isFinite(o.now) ? o.now : Date.now();

        const pages = [];
        const custom = {};
        let n = 0;
        const page = (type, layoutId, slots) => ({
            id: `page-imp-${now}-${n++}`, type, layout: layoutId, slots,
            bg: '#ffffff', bgImage: null, textLayers: [], locked: false,
        });

        // cover (an empty cover page when the guest did not set one)
        const cv = layout.cover;
        pages.push(page('cover', 'full-bleed', [cv === null || cv === undefined
            ? { photoId: null, crop: { x: 0, y: 0, scale: 1 }, fit: 'cover' }
            : slotOf(cv, '封面')]));

        layout.spreads.forEach((sp, i) => {
            const where = `第${i + 1}跨頁`;
            if (!isObj(sp) || typeof sp.template !== 'string') throw new Error(`${where}沒有版型`);
            const t = templates.byId(sp.template);
            if (!isObj(t) || !Array.isArray(t.slots) || t.slots.length === 0) throw new Error(`${where}的版型不認得`);
            if (!Array.isArray(sp.slots) || sp.slots.length !== t.slots.length) throw new Error(`${where}的照片數和版型不符`);
            if (sp.mirrored !== undefined && typeof sp.mirrored !== 'boolean') throw new Error(`${where}的鏡像設定不正確`);
            const mirrored = sp.mirrored === true;
            const slots = sp.slots.map((s, j) => slotOf(s, `${where}第${j + 1}格`));
            const id = `custom-${t.id}${mirrored ? '-m' : ''}`;
            if (!/^custom-[a-z0-9-]+$/.test(id)) throw new Error(`${where}的版型代號不正確`);
            if (!custom[id]) {
                custom[id] = {
                    name: `客人排版・${typeof t.name === 'string' && t.name ? t.name : t.id}${mirrored ? '（鏡像）' : ''}`,
                    slots: t.slots.map(g => ({
                        x: round6((mirrored ? 1 - g.x - g.w : g.x) * 100),
                        y: round6(g.y * 100),
                        w: round6(g.w * 100),
                        h: round6(g.h * 100),
                    })),
                    isCustom: true,
                };
            }
            pages.push(page('inner', id, slots));
        });

        if (isObj(layout.back)) pages.push(page('back-cover', 'blank', []));

        return {
            name: cleanName(o.name),
            clientFolders: [],
            notifyUrl: '',
            settings: { width: 42, height: 29.7, unit: 'cm', dpi: 300, bleed, pagesPerSheet: 2 },
            coverSettings: { width: 21, height: 29.7, unit: 'cm', dpi: 300 },
            pages,
            _customLayouts: custom,
        };
    }

    return { layoutToBook, cleanName, keySafe, DEFAULT_NAME, NAME_MAX };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = ImportLayout;
