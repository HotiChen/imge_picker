# Drive Photo Picker - 專業照片選擇與標注系統

一個現代化的 Web 應用程式，可以從 Google Drive 載入照片，進行星級評分、篩選和圖片標注。

## ✨ 功能特色

- 🔐 **Google Drive 整合** - 安全登入並存取 Drive 資料夾
- ⭐ **星級評分系統** - 為每張照片設定 1-5 星評分
- 🔍 **強大的篩選功能** - 依據星級、標注狀態排序和篩選
- 🎨 **圖片標注** - 在照片上畫圈標記，支援多種顏色和筆刷大小
- 📊 **統計資訊** - 即時顯示照片數量、評分和標注狀態
- 💾 **本地儲存** - 評分和標注資料自動儲存在瀏覽器中
- 📤 **資料匯出** - 匯出所有評分和標注資料為 JSON 檔案
- 🌙 **深色主題** - 現代化的深色介面設計
- 📱 **響應式設計** - 支援桌面和行動裝置

## 🚀 快速開始

### 1. Google Cloud Platform 設定

#### 建立專案
1. 前往 [Google Cloud Console](https://console.cloud.google.com/)
2. 建立新專案或選擇現有專案（你的專案：focused-premise-451917-c2）

#### 啟用 API
1. 在左側選單中，進入「API 和服務」→「程式庫」
2. 搜尋並啟用以下 API：
   - **Google Drive API**
   - **Google Picker API**（選用）

#### 建立憑證

##### OAuth 2.0 用戶端 ID
1. 進入「API 和服務」→「憑證」
2. 點擊「建立憑證」→「OAuth 用戶端 ID」
3. 應用程式類型選擇「網頁應用程式」
4. 設定以下資訊：
   - 名稱：Drive Photo Picker
   - 已授權的 JavaScript 來源：
     - `http://localhost:8000`
     - `http://127.0.0.1:8000`
     - （如果有正式網域，也要加入）
   - 已授權的重新導向 URI：
     - `http://localhost:8000`
5. 建立後，複製「用戶端 ID」

##### API 金鑰
1. 點擊「建立憑證」→「API 金鑰」
2. 建立後，複製「API 金鑰」
3. （建議）點擊「限制金鑰」：
   - 應用程式限制：選擇「網站」
   - 加入你的網站網址
   - API 限制：選擇「Google Drive API」

### 2. 設定應用程式

開啟 `js/config.js` 檔案，填入你的憑證：

```javascript
const CONFIG = {
    CLIENT_ID: 'YOUR_CLIENT_ID.apps.googleusercontent.com',  // 替換為你的 OAuth 用戶端 ID
    API_KEY: 'YOUR_API_KEY',  // 替換為你的 API 金鑰
    // ... 其他設定保持不變
};
```

### 3. 執行應用程式

#### 使用 Python 啟動本地伺服器

```bash
# Python 3
python3 -m http.server 8000

# 或 Python 2
python -m SimpleHTTPServer 8000
```

#### 使用 Node.js 啟動本地伺服器

```bash
# 安裝 http-server（只需執行一次）
npm install -g http-server

# 啟動伺服器
http-server -p 8000
```

#### 使用 PHP 啟動本地伺服器

```bash
php -S localhost:8000
```

### 4. 開啟應用程式

在瀏覽器中開啟：`http://localhost:8000`

## 📖 使用說明

### 載入照片

1. 點擊右上角的「登入 Google」按鈕
2. 選擇你的 Google 帳戶並授權應用程式
3. 在 Google Drive 中找到你想要處理的照片資料夾
4. 複製資料夾的分享連結（開啟資料夾 → 右上角「分享」→ 複製連結）
5. 將連結貼到左側「Drive 資料夾連結」欄位
6. 點擊「載入照片」按鈕

### 評分功能

- 在照片卡片上直接點擊星星來評分
- 或在照片詳細檢視中評分
- 評分會自動儲存

### 篩選照片

- **星級篩選**：選擇要顯示的星級（全部、5★、4★ 等）
- **標注狀態**：篩選已標注或未標注的照片
- **排序方式**：依檔名、評分或日期排序

### 標注照片

1. 點擊照片卡片開啟詳細檢視
2. 在左側選擇工具：
   - **畫圈**：在照片上畫圈標記
   - **清除**：清除所有標注
3. 選擇顏色（紅、橙、藍、綠、白）
4. 調整筆刷大小
5. 在照片上拖曳滑鼠來畫圈
6. 點擊「儲存標注」按鈕

### 導航照片

- 點擊「上一張」/「下一張」按鈕
- 或使用鍵盤方向鍵（← →）
- 按 ESC 關閉照片檢視

### 匯出資料

點擊左側的「匯出資料」按鈕，會下載包含以下資訊的 JSON 檔案：
- 照片清單
- 每張照片的評分
- 標注狀態
- 建立/修改時間

## 🎨 功能展示

### 主要介面
- 深色主題設計
- 響應式照片網格
- 即時篩選和排序

### 照片檢視
- 全螢幕照片顯示
- 互動式標注工具
- 流暢的導航體驗

### 評分系統
- 直覺的星級評分
- 即時更新統計
- 持久化儲存

## 🔧 技術架構

- **前端框架**：純 JavaScript（無框架依賴）
- **樣式**：原生 CSS with CSS Variables
- **API 整合**：Google Drive API v3
- **認證**：Google Identity Services
- **儲存**：LocalStorage
- **畫布**：HTML5 Canvas API

## 📂 專案結構

```
/image_picker
├── index.html              # 主要 HTML 檔案
├── css/
│   └── styles.css         # 所有樣式和設計系統
├── js/
│   ├── config.js          # API 憑證設定
│   ├── app.js             # 主要應用程式邏輯
│   ├── drive.js           # Google Drive API 整合
│   ├── rating.js          # 星級評分系統
│   ├── annotation.js      # 圖片標注功能
│   └── toast.js           # 通知系統
└── README.md              # 說明文件
```

## 🔒 隱私與安全

- 所有資料儲存在你的瀏覽器本地端
- 不會上傳照片到任何伺服器
- 只讀取 Google Drive 資料（不會修改你的 Drive 檔案）
- 可隨時撤銷應用程式的 Google 帳戶存取權限

## 🐛 疑難排解

### 無法載入照片
- 確認資料夾連結正確
- 確認資料夾權限設定（至少要有檢視權限）
- 檢查 Console 是否有錯誤訊息

### 認證失敗
- 確認 `config.js` 中的憑證正確
- 確認 OAuth 設定中有加入正確的來源網址
- 清除瀏覽器快取並重新整理

### 評分或標注沒有儲存
- 檢查瀏覽器的 LocalStorage 是否啟用
- 確認沒有使用無痕模式
- 檢查瀏覽器 Console 是否有錯誤

## 🚀 進階功能（未來規劃）

- [ ] 匯出標注的圖片
- [ ] 支援更多標注工具（箭頭、文字、矩形）
- [ ] 整合 Google Sheets 匯出
- [ ] 批次操作功能
- [ ] 自訂評分標準
- [ ] 照片比較模式
- [ ] 協作功能

## 📝 授權

MIT License

## 👨‍💻 開發者

Built with ❤️ by Antigravity AI

---

需要協助？歡迎提出問題或建議！
