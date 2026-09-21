const CONFIG = {
    // 照片儲存配置
    WORKER_URL: 'https://imagepicker.hotichen.workers.dev',
    DEFAULT_FOLDER: '', // 留空讓使用者手動輸入，或填入預設路徑 e.g. '2026/'
    PHOTOGRAPHER_TOKEN: '', // 由 auth.js 從 sessionStorage 載入，不在原始碼中儲存
    // 能放進網址（?t=）的唯讀權杖。<img> 沒辦法送 header，所以縮圖網址得靠它。
    // 兩種來源，同一個欄位：客戶由 viewer.js 從分享連結的 ?t= 讀入；攝影師由
    // studio-token.js 拿 PHOTOGRAPHER_TOKEN 去 /api/auth/studio-token 換一個
    // 十二小時到期的唯讀權杖。fetch() 不用它 —— 能送 header 的就送 header。
    SHARE_TOKEN: '',

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
