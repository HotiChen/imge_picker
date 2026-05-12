# R2 Photo Picker Pro - 開發誌 (Development Log)

本文檔記錄了系統從基礎版本進化至 Pro 等級的所有重大更新與技術決策。

## 📅 2026-01-28 核心功能大爆發

### 🚀 1. 智慧對焦縮放系統 (Smart Zoom)
- **功能**：實現了「指針中心縮放」邏輯，滑鼠滾輪捲動時會以指針位置為中心進行放大。
- **技術**：CSS Transform + Origin 動態計算，支援劇院模式平滑平移。

### 🗂️ 2. 全方位批量處理 (Bulk Management)
- **功能**：新增右上方一鍵全選、Shift 連選、Ctrl 多選。
- **連動**：批量評分條、批量下載選取。
- **持久化**：切換星級篩選時，已勾選的清單（籃子）會完整保留。

### 🎨 3. R2 Designer 相簿排版 (Alpha)
- **功能**：全新的 Fabric.js 繪圖室，支援拖放 R2 照片、AI 背景生成。
- **架構**：獨立於 Picker 但共享同一個 DriveManager 核心。

### 🛡️ 4. 系統安全防禦線
- **Log 系統**：新增 `logger.js`，持久化紀錄所有 INFO/ERROR，支援匯出。
- **自動診斷**：`diagnostics.js` 支援 Worker 延遲測試與 LocalStorage 空間檢查。
- **雲端偵測**：進入新資料夾時自動掃描 Google Sheets 歷史，並彈出優雅的還原詢問視窗。

## 📅 2026-02-18 穩定性與自動化強化

### ⌛ 1. 180 天伺服器對時銷毀系統
- **功能**：將專案有效期限統一設定為 180 天。
- **技術**：R2 版本不再僅依賴本地模擬時間，而是自動從 Cloudflare Worker 抓取「最早檔案上傳日」作為專案起點，確保倒數計時的公平性與精準度。
- **視覺**：新增呼吸燈效果的 `expiry-badge` 提醒剩餘天數。

### 💾 2. 5 分鐘背景自動存擋 (Auto-Save)
- **功能**：為了防止編輯長篇備註或複雜標記時意外遺失資料，新增每 5 分鐘一次的自動備份機制。
- **流程**：採用靜默同步模式，在不影響使用者操作的情況下，自動將最新評分與標註傳送至雲端備份。

### 🧹 3. 側邊欄精簡化 (Minimalist Sidebar)
- **設計**：移除冗餘的統計區塊，將進階與管理工具（如清除快取、匯出備份）收納至「進階功能」折疊選單中。
- **導航**：保留「切換相簿」路徑輸入框，維持快速切換案件的靈活性。

---

## 🏗️ 系統架構圖 (Current Stack)
- **Frontend**: Vanilla JS (ES6+), Fabric.js (Designer)
- **Storage**: Cloudflare R2 (Photos), Google Sheets (Data Sync / Backup)
- **Local**: LocalStorage (Persistent Cache), JSZip (Client-side Archiving)

---
*此日誌由 Antigravity AI 協助整理備份。*
