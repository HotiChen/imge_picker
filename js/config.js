const CONFIG = {
    // 照片儲存配置
    WORKER_URL: 'https://imagepicker.hotichen.workers.dev',
    DEFAULT_FOLDER: '', // 留空讓使用者手動輸入，或填入預設路徑 e.g. '2026/'

    // 雖然使用雲端儲存，但如果還是想把結果存回 Google Sheets，這裡可以保留
    GOOGLE_SHEETS_CONFIG: {
        API_KEY: 'YOUR_GOOGLE_API_KEY',
        CLIENT_ID: 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com',
        SCOPES: "https://www.googleapis.com/auth/spreadsheets",
        DISCOVERY_DOCS: ["https://sheets.googleapis.com/$discovery/rest"],
        TARGET_DRIVE_FOLDER_ID: 'YOUR_GOOGLE_DRIVE_FOLDER_ID'
    },

    STORAGE_KEYS: {
        RATINGS: 'r2_photo_picker_ratings',
        ANNOTATIONS: 'r2_photo_picker_annotations',
        NOTES: 'r2_photo_picker_notes'
    }
};

const API_CONFIG = {
    GAS_WEB_APP_URL: 'YOUR_GOOGLE_APPS_SCRIPT_URL'
};
