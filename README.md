# Image Picker Studio — 攝影師選圖與相本工具

一個專為攝影師設計的工作流程工具，從 Cloudflare R2 載入照片、評分標注、快速篩選交付，並支援相本排版與 JPG 匯出。

---

## 功能概覽

- **R2 照片庫** — 直接從 Cloudflare R2 載入資料夾，無需 Google 帳號
- **評分系統** — 每張照片 1–5 星，支援批次評分
- **旗標（Flags）** — Pick / Review / Reject 三種狀態標記
- **圖片標注** — 在照片上手繪圈記，多色 + 可調筆刷
- **備註** — 每張照片可附文字備註
- **即時預覽窗格** — 滑鼠懸停立即大圖預覽，無需開啟 Modal
- **篩選 + 排序** — 依星級、旗標、標注狀態、檔名快速過濾
- **相本排版編輯器** — 多頁版型、自動排版、匯出每頁 JPG（ZIP）
- **相簿排版工具** — 基於 Fabric.js 的自由排版畫布
- **本地儲存** — 評分、標注、備註全存 localStorage，換機不丟失
- **資料匯出** — 下載含評分 + 標注資料的 JSON

---

## 技術架構

| 層次 | 技術 |
|------|------|
| 前端 | 純 JavaScript（無框架） |
| 樣式 | 原生 CSS + CSS Variables（Studio Dark 設計系統） |
| 字型 | IBM Plex Sans + IBM Plex Mono |
| 照片儲存 | Cloudflare R2 |
| 後端 API | Cloudflare Worker（`imagepicker.hotichen.workers.dev`）|
| 本地資料 | localStorage |
| 畫布 | HTML5 Canvas API + Fabric.js（r2_designer）|
| 打包匯出 | JSZip |

---

## 專案結構

```
imge_picker/
├── index.html              # 主選圖介面
├── tutorial.html           # 使用說明頁
├── css/
│   └── styles.css          # Studio Dark 設計系統
├── js/
│   ├── config.js           # Worker URL + Token 設定
│   ├── app.js              # 主應用邏輯
│   ├── drive.js            # R2 資料載入（舊名保留）
│   ├── rating.js           # 星級評分系統
│   ├── annotation.js       # 圖片標注工具
│   ├── logger.js           # 開發除錯 Logger
│   ├── diagnostics.js      # 診斷工具
│   └── toast.js            # 通知系統
├── book_editor/            # 相本書編輯器（Phase 1 完成）
│   ├── index.html
│   ├── view.html           # 客戶預覽頁
│   ├── css/
│   └── js/
│       ├── layouts.js      # 版型定義
│       ├── auto_layout.js  # 自動排版演算法
│       ├── book_editor.js  # 主狀態管理
│       ├── exporter.js     # Canvas 渲染 + ZIP 匯出
│       ├── layout_editor.js
│       ├── viewer.js
│       └── tour.js
├── r2_designer/            # 自由排版工具（Fabric.js）
│   ├── index.html
│   ├── css/
│   └── js/
│       └── designer_core.js
├── worker/                 # Cloudflare Worker
│   ├── worker.js
│   └── wrangler.toml
├── design_handoff_studio_dark/  # 設計規格文件
└── .claude/
    └── settings.json       # PreToolUse 程式碼審查 Hook
```

---

## 快速開始

### 1. 設定 Worker URL 與 Token

開啟 `js/config.js`：

```javascript
const CONFIG = {
    WORKER_URL: 'https://imagepicker.hotichen.workers.dev',
    PHOTOGRAPHER_TOKEN: 'YOUR_TOKEN',  // 與 Worker 的 PHOTOGRAPHER_TOKEN secret 相同
    // ...
};
```

### 2. 部署 Cloudflare Worker

```bash
cd worker
npx wrangler login
npx wrangler deploy

# 設定 secret（需與 config.js 中的 token 一致）
npx wrangler secret put PHOTOGRAPHER_TOKEN
```

Worker 提供以下端點：
- `GET /api/list?prefix=FOLDER/` — 列出 R2 物件
- `GET /api/photo?key=PATH` — 取得照片（帶授權快取）
- `PUT /_assets/PATH` — 上傳素材（需 Bearer Token）
- `POST /api/books/:id/approve` — 核准相本，觸發 Webhook

### 3. 本地執行

```bash
# Python
python3 -m http.server 8000

# Node.js
npx http-server -p 8000
```

開啟瀏覽器：`http://localhost:8000`

---

## 使用說明

### 載入照片

1. 在左側欄「SOURCE」區輸入 R2 資料夾路徑（例如 `2026/wedding/`）
2. 點擊「LOAD」
3. 照片以網格方式顯示，支援子資料夾導航

### 評分

- 在照片卡片上直接點擊星星
- 或在預覽窗格（右側）評分
- 支援鍵盤 1–5 快速評分（待實作）

### 旗標

- **PICK** — 選取交付
- **REVIEW** — 待確認
- **REJECT** — 淘汰

### 標注

1. 點擊照片開啟 Modal
2. 選擇顏色 + 調整筆刷大小
3. 在照片上拖曳畫圈
4. 點「儲存標注」

### 預覽窗格

滑鼠懸停照片卡片即可在右側窗格預覽大圖，無需開啟 Modal。
寬度不足 1200px 時窗格自動隱藏。

### 相本排版

點擊頁首「相本排版」進入 `book_editor/`：

1. 設定書本尺寸（cm）與 DPI
2. 選取照片 → 執行「自動排版」
3. 手動調整頁面版型（全出血、單張、左右兩張、四格等）
4. 雙擊格子進入裁切模式
5. 「匯出 JPG」→ 下載 ZIP

### 匯出資料

點擊側欄「SYNC」區的匯出按鈕，下載含評分 + 標注的 JSON 檔。

---

## 設計系統：Studio Dark

本專案採用 Studio Dark 設計語言：

| Token | 值 | 用途 |
|-------|----|------|
| `--bg` | `#15120d` | 頁面背景 |
| `--surface` | `#1d1a14` | 卡片背景 |
| `--card` | `#221f18` | 元件背景 |
| `--accent` | `#e5a448` | 主強調色（琥珀）|
| `--ink-90` | `#e8e3da` | 主文字 |
| `--ink-55` | `#8c8375` | 次要文字 |
| `--rule` | `#2e2a22` | 分隔線 |
| `--border` | `#3a3528` | 元件邊框 |

字型：IBM Plex Sans（內文）+ IBM Plex Mono（標籤、badge）

---

## 開發工具

### Claude Code Hook（自動程式碼審查）

每次 `git commit` / `git push` 前，Hook 會自動執行四軸審查：

1. **SCOPE** — 是否只改了本次任務相關的程式碼？
2. **CORRECTNESS** — 邏輯是否正確？有無邊界條件漏洞？
3. **STYLE** — 是否符合現有程式碼風格？
4. **MINIMALITY** — 變動是否可以更精簡？

發現問題自動用繁體中文說明並阻止 commit。

設定檔：`.claude/settings.json`

---

## Cloudflare 部署

### Worker 部署

```bash
cd worker
npx wrangler deploy
npx wrangler secret put PHOTOGRAPHER_TOKEN
```

### 靜態檔案

整個根目錄可部署到任何靜態主機：
- Cloudflare Pages
- Cloudways（FTP 上傳即可）
- GitHub Pages
- 任意 HTTP 伺服器

---

## 版本路線圖

| 階段 | 狀態 | 內容 |
|------|------|------|
| P1 視覺翻新 | ✅ 完成 | Studio Dark 設計系統、預覽窗格 |
| P2 旗標系統 | 🔲 規劃中 | Pick/Review/Reject 持久化儲存 |
| P3 鍵盤快捷鍵 | 🔲 規劃中 | 數字鍵評分、方向鍵導航 |
| P4 批次操作 | 🔲 規劃中 | 多選 + 批次評分 / 旗標 |
| P5 比較模式 | 🔲 規劃中 | 並排比較兩張照片 |
| P6 相本 Phase 2 | 🔲 規劃中 | R2 儲存、客戶預覽連結 |
| P7 協作 | 🔲 規劃中 | 多人同時標注 |

---

## 授權

MIT License

## 開發者

Built by Antigravity AI
