# Drive Photo Picker - 變更日誌

## [版本還原] 2026-01-02 23:59

### 📝 變更摘要
本次更新將專案從「包含 GAS 雲端同步的版本 (v1.0.6)」還原至「純 Google API 版本 (v1.0.5，昨晚穩定版）」

---

## 🔄 今天的完整變更歷程

### 階段 1: GAS 整合與測試 (今早 ~ 下午)
**目標**: 實現完全免登入的客戶選圖體驗

#### 新增功能
- ✅ Google Apps Script (GAS) Web App 部署
- ✅ `loadPhotosViaGAS()`: 透過 GAS 代理載入照片
- ✅ `syncToCloud()`: 自動背景同步客戶進度
- ✅ `loadFromCloud()`: 從雲端還原進度
- ✅ `finalizeToCloud()`: 完成選圖並建立 Google Sheet
- ✅ Email 回報功能
- ✅ 免登入自動載入邏輯

#### 遇到的問題
1. **瀏覽器快取問題**: 即便更新代碼，瀏覽器仍載入舊版 JS 檔案
2. **GAS 權限錯誤**: 無法讀取公開分享的資料夾
3. **OAuth 登入卡死**: 點擊登入後無限轉圈圈

#### 嘗試的解決方案
- 多次更新版本號 (v1.0.5 → v1.0.6 → v2.0.0)
- 新增快取破解機制
- 添加 8 秒逾時保護
- 修復 `undefined` 顯示問題

### 階段 2: 還原決策 (下午 ~ 晚上)
**原因**: GAS 整合問題難以解決，決定回到穩定的純 API 版本

---

## 📦 當前版本狀態 (v1.0.5 - 昨晚版本)

### ✅ 已移除的 GAS 功能

#### config.js
```javascript
// BEFORE (GAS 版本)
GAS_WEB_APP_URL: 'https://script.google.com/macros/s/...'

// AFTER (純 API 版本)
GAS_WEB_APP_URL: '' // 不使用 GAS
```

#### app.js
**移除的方法**:
- `loadFromCloud()` - 從 GAS 讀取進度
- `syncToCloud()` - 背景同步到 GAS
- `finalizeToCloud()` - 完成選圖並建表
- `updateSidebarVisibility()` - 動態顯示按鈕
- `sendResultsViaEmail()` - Email 回報功能

**修改的邏輯**:
- `handleLoadPhotos()`: 移除自動載入雲端進度
- `saveToSheetsBtn`: 改為必須登入才能使用
- `saveCurrentNote()`: 移除自動同步調用
- `renderFolderNav()`: 移除動態按鈕控制

#### drive.js
**修改**:
- `loadPhotosFromFolder()`: 未登入時顯示錯誤，不再嘗試 GAS 載入

**殘留** (無影響):
- `loadPhotosViaGAS()` - 仍存在但不會被調用
- `manageFolderStack()` - 仍存在但不會被調用

#### rating.js
```javascript
// 移除評分後的自動同步
// BEFORE
if (window.app && window.app.syncToCloud) {
    window.app.syncToCloud('sync');
}
// AFTER
// (已移除)
```

#### annotation.js
```javascript
// 移除標注後的自動同步
// BEFORE
if (window.app && window.app.syncToCloud) {
    window.app.syncToCloud('sync');
}
// AFTER
// (已移除)
```

#### index.html
**UI 變更**:
- ❌ 移除「Email 回報選圖」按鈕區塊 (`guestActionSection`)
- ✅ 恢復「請先登入 Google 帳戶」的引導文字
- ✅ 版本標記改回 `v=1.0.5`

---

## 🎯 當前功能清單

### ✅ 可用功能
1. **Google 登入驗證**
   - OAuth 2.0 身分驗證
   - 自動記住登入狀態

2. **照片管理**
   - 從 Google Drive 載入照片（需登入）
   - 資料夾導航（麵包屑）
   - 子資料夾瀏覽

3. **評分與標注**
   - 1-5 星評分系統
   - 繪圖標注工具
   - 照片備註功能
   - 本地 localStorage 儲存

4. **篩選與排序**
   - 依星級篩選
   - 依標注狀態篩選
   - 依檔名/評分/日期排序

5. **資料匯出**
   - 儲存到 Google Sheets（需登入）
   - 同步整個專案或單一資料夾
   - 從 Sheets 讀取資料

### ❌ 已移除功能
1. 免登入瀏覽照片
2. 雲端進度同步
3. GAS 自動建表
4. Email 回報功能
5. 客戶專用按鈕

### ⚠️ 已知限制
1. 必須登入 Google 帳戶才能使用
2. 評分與標注僅存於本地瀏覽器
3. 更換裝置或清除快取會遺失進度
4. 客戶需要您的 Google 帳戶才能查看照片

---

## 🔧 技術架構

### 核心依賴
- **Google Drive API v3**: 照片載入與資料夾瀏覽
- **Google Sheets API v4**: 資料匯出與讀取
- **Google Identity Services**: OAuth 2.0 登入
- **LocalStorage**: 本地資料持久化

### 檔案結構
```
/image_picker
├── index.html           # 主頁面 (v1.0.5)
├── js/
│   ├── config.js       # API 配置 (含 API Key)
│   ├── app.js          # 主邏輯 (v1.0.5)
│   ├── drive.js        # Drive API 整合
│   ├── rating.js       # 評分系統
│   ├── annotation.js   # 標注工具
│   └── toast.js        # 通知系統
├── css/
│   └── styles.css      # 樣式表 (v1.1.0)
├── privacy.html        # 隱私權政策
└── README.md          # 說明文件
```

---

## 📊 版本對照表

| 項目 | v1.0.5 (昨晚) | v1.0.6 (今早-下午) | v2.0.0 (下午嘗試) | 當前版本 |
|------|--------------|-------------------|------------------|---------|
| 登入需求 | ✅ 必須 | ❌ 不需要 | ❌ 不需要 | ✅ 必須 |
| GAS 整合 | ❌ 無 | ✅ 完整 | ✅ 完整 | ❌ 無 |
| 雲端同步 | ❌ 無 | ✅ 有 | ✅ 有 | ❌ 無 |
| Email 回報 | ❌ 無 | ✅ 有 | ✅ 有 | ❌ 無 |
| 穩定性 | ✅ 穩定 | ⚠️ 有問題 | ⚠️ 有問題 | ✅ 穩定 |

---

## 🚀 部署檢查清單

### 必須上傳的檔案
- [ ] `index.html` (已更新)
- [ ] `js/app.js` (已更新)
- [ ] `js/rating.js` (已更新)
- [ ] `js/annotation.js` (已更新)
- [ ] `js/config.js` (已填入 API Key)
- [ ] `js/drive.js` (已修改，但有殘留方法)

### 可選上傳的檔案
- `js/toast.js` (無變動)
- `css/styles.css` (無變動)
- `privacy.html` (無變動)

### 上傳後驗證
1. ✅ Console 顯示 `v1.0.5`
2. ✅ 未登入時顯示「請先登入」錯誤
3. ✅ 登入後能正常載入照片
4. ✅ 評分與標注功能正常
5. ✅ 儲存到 Google Sheets 正常

---

## 🐛 已知問題

### drive.js 殘留代碼
**問題**: `loadPhotosViaGAS()` 和 `manageFolderStack()` 方法仍存在於檔案中

**影響**: 無實際影響，因為：
- `GAS_WEB_APP_URL` 已清空
- `loadPhotosFromFolder()` 不會調用這些方法

**建議**: 若需完全清理，可手動編輯 `drive.js` 刪除第 294-362 行

### 瀏覽器快取
**問題**: 部分用戶可能仍看到舊版介面

**解決方案**:
1. 使用者按 `Ctrl + F5` (或 `Cmd + Shift + R`)
2. 清除瀏覽器快取
3. 使用無痕模式測試

---

## 📝 開發備註

### Google Cloud Console 設定
```
專案 ID: [REDACTED]
API Key: [REDACTED - 請見 config.js 的 API_KEY 欄位]
Client ID: [REDACTED - 請見 config.js 的 CLIENT_ID 欄位]
```

### 已授權網域
- `http://localhost:8000`
- `https://imhoti.tw`

### LocalStorage Keys
```javascript
RATINGS: 'drive_photo_picker_ratings'
ANNOTATIONS: 'drive_photo_picker_annotations'
NOTES: 'drive_photo_picker_notes'
```

---

## 🔮 未來考量

### 若要重新啟用 GAS 功能
需要解決的問題：
1. GAS 資料夾權限設定
2. CORS 跨域請求處理
3. OAuth 登入彈窗問題
4. 瀏覽器快取策略

### 替代方案
1. 使用 Firebase 作為中間層
2. 自建後端 API 服務
3. 使用 Google Picker API
4. 改用分享連結 + 公開存取

---

## 📞 支援資訊

**開發者**: Antigravity AI  
**最後更新**: 2026-01-02 23:59  
**版本**: v1.0.5 (穩定版)  
**狀態**: ✅ 可正常使用

---

_本日誌記錄了 2026-01-02 的所有變更與還原過程，供日後參考或問題追溯使用。_
