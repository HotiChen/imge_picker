/**
 * R2 Photo Picker - 系統日誌與追蹤工具
 * 用途：記錄關鍵操作、錯誤與效能指標，支援持久化儲存。
 */

class SystemLogger {
    constructor() {
        this.LOG_KEY = 'r2_photo_picker_logs';
        this.MAX_LOGS = 200; // 最多保留 200 筆
        this.logs = this.loadLogs();
    }

    loadLogs() {
        try {
            return JSON.parse(localStorage.getItem(this.LOG_KEY) || '[]');
        } catch (e) {
            return [];
        }
    }

    /**
     * 加入一筆日誌
     * @param {string} type - INFO, WARN, ERROR, SUCCESS
     * @param {string} module - 功能模組 (App, Drive, Annotation, etc.)
     * @param {string} message - 日誌內容
     */
    log(type, module, message) {
        const entry = {
            id: Date.now(),
            time: new Date().toLocaleString(),
            type: type.toUpperCase(),
            module: module,
            message: message
        };

        this.logs.unshift(entry);
        if (this.logs.length > this.MAX_LOGS) {
            this.logs = this.logs.slice(0, this.MAX_LOGS);
        }

        this.save();

        // 同步輸出到瀏覽器 Console，增加色彩辨識度
        const colors = {
            INFO: '#1e90ff',
            WARN: '#ffa500',
            ERROR: '#ff4757',
            SUCCESS: '#2ed573'
        };
        console.log(`%c[${entry.type}] %c[${module}] %c${message}`, `color: ${colors[entry.type] || '#fff'}; font-weight: bold;`, "color: #fff; font-weight: bold;", "color: #ccc;");
    }

    info(module, msg) { this.log('INFO', module, msg); }
    warn(module, msg) { this.log('WARN', module, msg); }
    error(module, msg) { this.log('ERROR', module, msg); }
    success(module, msg) { this.log('SUCCESS', module, msg); }

    save() {
        localStorage.setItem(this.LOG_KEY, JSON.stringify(this.logs));
    }

    clear() {
        this.logs = [];
        this.save();
        toast.info('系統日誌已清空');
    }

    exportLogs() {
        const blob = new Blob([JSON.stringify(this.logs, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `PhotoPicker_System_Logs_${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }
}

window.sysLogger = new SystemLogger();
