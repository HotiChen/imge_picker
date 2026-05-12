/**
 * R2 Photo Picker - 系統自我診斷工具 v2.0
 */

class DiagnosticsManager {
    constructor() {
        this.results = [];
    }

    async runAll() {
        this.results = [];
        toast.info('🚀 正在啟動全方位系統檢測...');
        sysLogger.info('Diagnostics', '開始執行全系統自檢');

        // 1. 檢查 Worker 連線
        await this.checkR2Connection();

        // 2. 檢查四大元件狀態
        this.checkComponents();

        // 3. 檢查 LocalStorage 狀態
        this.checkStorage();

        // 4. 檢查 R2 資源庫設定
        this.checkR2Config();

        this.summarize();
    }

    async checkR2Connection() {
        try {
            const start = Date.now();
            const response = await fetch(CONFIG.WORKER_URL);
            const latency = Date.now() - start;

            if (response.ok) {
                this.addResult('Worker 連線', 'PASS', `延遲: ${latency}ms`);
                sysLogger.success('Diagnostics', `Worker 連線正常，延遲 ${latency}ms`);
            } else {
                this.addResult('Worker 連線', 'FAIL', `狀態碼: ${response.status}`);
                sysLogger.error('Diagnostics', `Worker 返回異常狀態: ${response.status}`);
            }
        } catch (e) {
            this.addResult('Worker 連線', 'FAIL', '連線失敗，請檢查網路或 Worker 是否存活');
            sysLogger.error('Diagnostics', `Worker 連線失敗: ${e.message}`);
        }
    }

    checkComponents() {
        const components = [
            { name: 'App Manager', ref: window.app },
            { name: 'Drive Manager', ref: window.driveManager },
            { name: 'Annotation Manager', ref: window.annotationManager },
            { name: 'Rating Manager', ref: window.ratingManager }
        ];

        components.forEach(c => {
            if (c.ref) {
                this.addResult(`${c.name} 初始化`, 'PASS', '組件就緒');
            } else {
                this.addResult(`${c.name} 初始化`, 'FAIL', '組件未啟動');
                sysLogger.warn('Diagnostics', `${c.name} 尚未完全就緒`);
            }
        });
    }

    checkStorage() {
        try {
            const testKey = 'diag_test_temp';
            localStorage.setItem(testKey, 'test');
            localStorage.removeItem(testKey);

            const usage = (JSON.stringify(localStorage).length / 1024 / 1024).toFixed(2);
            this.addResult('LocalStorage 存取', 'PASS', `目前佔用約 ${usage} MB`);
            sysLogger.info('Diagnostics', `LocalStorage 空間使用中: ${usage}MB`);
        } catch (e) {
            this.addResult('LocalStorage 存取', 'FAIL', '無法寫入，可能是無痕模式或空間不足');
            sysLogger.error('Diagnostics', 'LocalStorage 寫入失敗');
        }
    }

    checkR2Config() {
        if (CONFIG.WORKER_URL.includes('workers.dev') || CONFIG.WORKER_URL.includes('http')) {
            this.addResult('R2 設定格式', 'PASS', 'URL 格式正確');
        } else {
            this.addResult('R2 設定格式', 'WARN', 'Worker URL 可能未正確設定');
            sysLogger.warn('Diagnostics', 'Worker URL 設定似乎不完整');
        }
    }

    addResult(test, status, detail) {
        this.results.push({ test, status, detail });
    }

    summarize() {
        const failCount = this.results.filter(r => r.status === 'FAIL').length;
        const warnCount = this.results.filter(r => r.status === 'WARN').length;

        if (failCount === 0) {
            toast.success('🎉 系統檢查完成！一切運作良好。');
            sysLogger.success('Diagnostics', '一鍵自檢完成：全數通過');
        } else {
            toast.warning(`⚠️ 檢查完成：發現 ${failCount} 個異常。請開啟 Console 查看詳情。`);
            sysLogger.error('Diagnostics', `一檢自檢完成：發現 ${failCount} 個異常`);
        }

        console.table(this.results);
    }
}

window.diagnostics = new DiagnosticsManager();
