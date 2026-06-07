// 照片儲存管理員 (支援完整選圖功能：評分、標注、備註、同步)
if (typeof sysLogger === 'undefined') window.sysLogger = { info: () => {}, success: () => {}, error: () => {}, warn: () => {} };
class DriveManager {
    constructor() {
        this.isSignedIn = false;
        this.photos = [];
        this.currentFolderId = CONFIG.DEFAULT_FOLDER;
        this.currentFolderName = '';
        this.onAuthSuccess = null;
    }

    async initialize() {
        console.log('照片儲存初始化成功');
        return Promise.resolve();
    }

    getImageUrl(photo) {
        if (!photo || !photo.id) return '';
        return `${CONFIG.WORKER_URL}/${photo.id}`;
    }

    // 載入資料庫中的照片清單
    async loadPhotosFromFolder(folderPath) {
        if (!folderPath) folderPath = CONFIG.DEFAULT_FOLDER;
        if (folderPath && !folderPath.endsWith('/')) folderPath += '/';

        this.currentFolderId = folderPath;
        this.currentFolderName = folderPath.split('/').filter(x => x).pop() || folderPath;

        sysLogger?.info('Drive', `正在載入路徑: ${folderPath}`);

        try {
            const loadingEl = document.getElementById('loadingState');
            if (loadingEl) loadingEl.style.display = 'flex';

            const url = `${CONFIG.WORKER_URL}/?list=${encodeURIComponent(folderPath)}`;
            const response = await fetch(url);
            const result = await response.json();

            if (result && result.status === 'success') {
                // 找出最早的檔案上傳時間作為專案建立時間
                let projectCreatedTime = null;

                this.photos = result.data.map(file => {
                    const uploadedTime = new Date(file.uploaded).getTime();
                    if (!projectCreatedTime || uploadedTime < projectCreatedTime) {
                        projectCreatedTime = uploadedTime;
                    }

                    return {
                        id: file.id,
                        name: file.name,
                        size: file.size,
                        uploaded: file.uploaded,
                        thumbnailLink: this.getImageUrl({ id: file.id }),
                        rating: 0,
                        note: '',
                        annotations: [],
                        hasAnnotations: false
                    };
                });

                this.loadSavedData();
                if (loadingEl) loadingEl.style.display = 'none';

                sysLogger?.success('Drive', `成功載入 ${this.photos.length} 張照片`);

                return {
                    photos: this.photos,
                    folders: (result.folders || []),
                    currentName: this.currentFolderName,
                    projectCreatedTime: projectCreatedTime ? new Date(projectCreatedTime).toISOString() : null,
                    canGoBack: !!folderPath
                };
            } else {
                throw new Error(result.message || '無法讀取照片資料夾');
            }
        } catch (error) {
            sysLogger?.error('Drive', `載入路徑失敗: ${error.message}`);
            console.error('照片載入失敗:', error);
            toast.error('檔案載入失敗，請檢查 Worker 設定');
            const loadingEl = document.getElementById('loadingState');
            if (loadingEl) loadingEl.style.display = 'none';
            return { photos: [], folders: [] };
        }
    }

    // 載入已儲存的評分與標注 (LocalStorage)
    loadSavedData() {
        try {
            const savedRatings = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.RATINGS) || '{}');
            const savedAnnotations = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.ANNOTATIONS) || '{}');
            const savedNotes = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.NOTES) || '{}');

            this.photos.forEach(photo => {
                if (savedRatings[photo.id]) photo.rating = savedRatings[photo.id];
                if (savedAnnotations[photo.id]) {
                    photo.annotations = savedAnnotations[photo.id];
                    photo.hasAnnotations = photo.annotations.length > 0;
                }
                if (savedNotes[photo.id]) photo.note = savedNotes[photo.id];
            });
        } catch (error) {
            console.error('載入儲存資料失敗:', error);
        }
    }

    saveRating(photoId, rating) {
        const ratings = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.RATINGS) || '{}');
        ratings[photoId] = rating;
        localStorage.setItem(CONFIG.STORAGE_KEYS.RATINGS, JSON.stringify(ratings));
        const photo = this.photos.find(p => p.id === photoId);
        if (photo) photo.rating = rating;
    }

    saveNote(photoId, note) {
        const notes = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.NOTES) || '{}');
        notes[photoId] = note;
        localStorage.setItem(CONFIG.STORAGE_KEYS.NOTES, JSON.stringify(notes));
        const photo = this.photos.find(p => p.id === photoId);
        if (photo) photo.note = note;
    }

    saveAnnotations(photoId, annotations) {
        const all = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.ANNOTATIONS) || '{}');
        all[photoId] = annotations;
        localStorage.setItem(CONFIG.STORAGE_KEYS.ANNOTATIONS, JSON.stringify(all));
        const photo = this.photos.find(p => p.id === photoId);
        if (photo) {
            photo.annotations = annotations;
            photo.hasAnnotations = annotations.length > 0;
        }
    }

    // [核心下載邏輯] 通用的打包下載方法
    async downloadPhotos(photoList, zipName = 'Photos.zip') {
        if (!photoList || photoList.length === 0) {
            toast.warning('目前沒有照片可供下載');
            return;
        }

        toast.info(`正在準備打包 ${photoList.length} 張照片...`);
        const zip = new JSZip();

        try {
            // 分割批次下載，避免瀏覽器瞬間請求過多導致崩潰
            const batchSize = 5;
            for (let i = 0; i < photoList.length; i += batchSize) {
                const batch = photoList.slice(i, i + batchSize);
                await Promise.all(batch.map(async (photo) => {
                    const url = this.getImageUrl(photo);
                    const response = await fetch(url);
                    const blob = await response.blob();
                    zip.file(photo.name, blob);
                }));
                const progress = Math.min(i + batchSize, photoList.length);
                console.log(`打包進度: ${progress}/${photoList.length}`);
            }

            toast.info('正在產生 ZIP 壓縮檔，請稍候...');
            const content = await zip.generateAsync({ type: "blob" });

            const url = URL.createObjectURL(content);
            const a = document.createElement('a');
            a.href = url;
            a.download = zipName;
            a.click();
            URL.revokeObjectURL(url);
            toast.success('打包下載完成！');
        } catch (error) {
            console.error('打包下載失敗:', error);
            toast.error('打包連線出錯，請稍後再試');
        }
    }

    // 下載目前資料夾內「所有」照片
    async downloadAllPhotos() {
        const zipName = `All_${this.currentFolderName || 'Photos'}.zip`;
        return this.downloadPhotos(this.photos, zipName);
    }

    // 下載目前「選取」的照片
    async downloadSelectedPhotos(selectedIds) {
        if (!selectedIds || selectedIds.size === 0) return;
        const selectedList = this.photos.filter(p => selectedIds.has(p.id));
        const zipName = `Selected_${selectedList.length}_Photos.zip`;
        return this.downloadPhotos(selectedList, zipName);
    }

    // [相容性保留] 打包下載 5 星照片
    async downloadFiveStarPhotos() {
        const fiveStarPhotos = this.photos.filter(p => p.rating === 5);
        if (fiveStarPhotos.length === 0) {
            toast.warning('目前沒有 5 星的照片可供下載');
            return;
        }
        return this.downloadPhotos(fiveStarPhotos, `FiveStar_${this.currentFolderName}.zip`);
    }

    // [新功能] 本地全資料備份外帶
    backupData() {
        const backup = {
            timestamp: new Date().toISOString(),
            ratings: JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.RATINGS) || '{}'),
            annotations: JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.ANNOTATIONS) || '{}'),
            notes: JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEYS.NOTES) || '{}')
        };

        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `PhotoPicker_Backup_${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success('本地備份檔已下載');
        sysLogger?.success('Backup', `已完成本地資料備份外帶 (${backup.timestamp})`);
    }
}

window.driveManager = new DriveManager();
