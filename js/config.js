const CONFIG = {
    // 照片儲存配置
    WORKER_URL: 'https://imagepicker.hotichen.workers.dev',
    DEFAULT_FOLDER: '', // 留空讓使用者手動輸入，或填入預設路徑 e.g. '2026/'
    PHOTOGRAPHER_TOKEN: '1f74d94d96d4ac34070c2eb1ff6beab965eb048e1c58772fa415b539bd992cee', // 攝影師 secret token，與 Worker 環境變數 PHOTOGRAPHER_TOKEN 相同

    STORAGE_KEYS: {
        RATINGS: 'r2_photo_picker_ratings',
        ANNOTATIONS: 'r2_photo_picker_annotations',
        NOTES: 'r2_photo_picker_notes'
    }
};

const API_CONFIG = {
    GAS_WEB_APP_URL: 'YOUR_GOOGLE_APPS_SCRIPT_URL'
};
