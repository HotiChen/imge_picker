const CONFIG = {
    // 照片儲存配置
    WORKER_URL: 'https://imagepicker.hotichen.workers.dev',
    DEFAULT_FOLDER: '', // 留空讓使用者手動輸入，或填入預設路徑 e.g. '2026/'
    PHOTOGRAPHER_TOKEN: '', // 由 auth.js 從 sessionStorage 載入，不在原始碼中儲存

    STORAGE_KEYS: {
        RATINGS: 'r2_photo_picker_ratings',
        ANNOTATIONS: 'r2_photo_picker_annotations',
        NOTES: 'r2_photo_picker_notes'
    }
};

// Names on screen come from R2 keys, which are whatever the uploader called the
// file. Quotes matter as much as angle brackets here: most of these names land
// in attributes (title=, value=, data-photo-id=), where a bare " ends the
// attribute and everything after it is parsed as markup.
function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
