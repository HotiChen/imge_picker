# Handoff · 選圖工作室 Studio Dark Redesign

完整 UI/UX 重新設計交接包 · 給工程師（或 Claude Code / Cursor）實作參照

---

## 1. 總覽 Overview

本案是把現有的 **選圖軟體 Drive Photo Picker** 從紫色漸層 Inter 風格，整套重新設計成 **Studio Dark — 攝影師暗房感** 的專業視覺系統，並補齊 **21 個新畫面 / 狀態**，涵蓋：

- 主要瀏覽（網格、詳細檢視、幻燈片）
- 新增功能（比較模式、批次選取、色標 / 旗標、AI 智慧分類、相簿排版工具）
- 所有空狀態 / 載入狀態 / 同步狀態
- 多資料夾 / 專案管理
- 完整模態彈窗（快捷鍵、匯出、同步、設定）
- 手機版 RWD

設計師原型已完成 React 高保真 mockup。**此交接包目標是請工程師將設計重現到現有的 vanilla JS + Google Drive API + Fabric.js 程式庫中**，保留現有的技術棧、API 整合與資料模型，只重新製作介面層與新增功能模組。

---

## 2. 關於這些檔案 About these design files

> ⚠️ 重要：`prototype/` 資料夾裡的檔案是用 React + JSX 寫的 **設計參考稿**，**不要直接複製進你的專案**。
>
> 你的目標是把這些畫面 **在你現有的 vanilla JS 程式庫（`image_picker/`）裡重新做出來**，沿用你原本的 `driveManager`、`ratingManager`、`annotationManager` 等模組，只把 **DOM 結構、CSS、互動邏輯、新功能** 套用過去。

如果你決定整個遷移到 React / Vue / Svelte，這些原型檔可以做為 component 設計的起點，但邏輯（Drive API、Sheets 同步、Local Storage）需要按你選的框架重寫。

---

## 3. 保真度 Fidelity

**High-fidelity（高保真）** — 所有顏色、字型、間距、邊框、陰影、互動狀態都是定稿。工程師應該 **像素級復現** 視覺，不要二次設計。

例外：
- 照片是用 `picsum.photos` 假圖；正式版用實際從 Drive 載入的照片。
- 部分圖示用 emoji 或文字符號占位（例：`✎`、`↗`、`⌕`）。**正式版請改用 SVG 或 icon font**，每個圖示都要做成元件以便重用，不要繼續用 emoji。

---

## 4. 目標技術棧 Target stack

對照原本 `image_picker/` 結構：

| 層 | 現況 | 建議 |
|---|---|---|
| HTML | `index.html` 單檔 | 維持單檔，重寫 DOM |
| CSS | `css/styles.css` 一份 | 重寫，採用本文件第 5 章的 token 系統。可拆 `tokens.css` + `components.css` + `screens.css` |
| JS 主邏輯 | `js/app.js` | 維持，但抽離 view 層 |
| Drive API | `js/drive.js` | 維持 |
| Rating | `js/rating.js` | 擴充支援 0–5（含 0 = 未評分） |
| Annotation | `js/annotation.js` | 維持，UI 重寫 |
| Toast | `js/toast.js` | 維持，視覺微調符合新風格 |
| 相簿排版 | `r2_version/r2_designer/` | 維持 Fabric.js，介面重寫 |

**新增模組**（建議檔案）：
- `js/flags.js` — 旗標管理（pick / reject / review）
- `js/colorLabels.js` — 色標管理（red / amber / green / blue / purple）
- `js/selection.js` — 批次選取狀態
- `js/keyboard.js` — 全域快捷鍵
- `js/compare.js` — 比較模式
- `js/aiAssist.js` — AI 智慧分組（先做 mock，之後接 API）
- `js/folders.js` — 多資料夾切換
- `js/settings.js` — 設定面板邏輯

---

## 5. 設計 Token Design Tokens

### 5.1 顏色 Color

所有顏色都應該定義成 CSS 變數，放在 `:root` 或一個 `tokens.css`。

```css
:root {
  /* 背景層級 */
  --bg:        #15120d;   /* 主畫面背景（最暗暖黑） */
  --bg-soft:   #1c1a14;   /* 次要背景 */
  --bg-deep:   #0e0c08;   /* 最深，用於 modal overlay 之下 */

  /* 表面層級 */
  --surface:   #1f1c16;   /* sidebar、header、modal */
  --card:      #26221b;   /* 卡片、輸入框、可點擊區塊 */
  --card-hi:   #2e2922;   /* 選中或 hover 的卡片 */

  /* 文字 */
  --ink:       #f1ead8;        /* 主文字 */
  --ink-70:    rgba(241,234,216,.72);   /* 次要文字 */
  --ink-55:    rgba(241,234,216,.55);   /* 標籤、metadata、mono 副文 */
  --ink-35:    rgba(241,234,216,.32);   /* 分隔符號、placeholder */
  --ink-15:    rgba(241,234,216,.12);   /* 灰星星、空評分 */

  /* 線條 */
  --border:    #332e25;     /* 卡片邊框 */
  --rule:      #2a261f;     /* 區塊分隔線（更細） */

  /* 重點色（單一強調，琥珀） */
  --accent:    #e5a448;
  --accent-dim:rgba(229,164,72,.18);   /* 重點色背景填色 */

  /* 旗標 / 狀態色（暖調暗化版本，不要太鮮豔） */
  --pick:      #9bbd6a;     /* 綠 · 精選 */
  --reject:    #c97a6a;     /* 紅 · 捨棄 */
  --review:    #d9a85a;     /* 黃 · 待覆審 */

  /* 色標（搭配深背景的飽和度，不刺眼） */
  --color-red:    #c14b3b;
  --color-amber:  #d99245;
  --color-green:  #5c8a55;
  --color-blue:   #4a7aa8;
  --color-purple: #7c5fa3;
}
```

**使用原則**：
- **不要** 在介面上隨意用其他顏色。整套系統只有：暖黑背景階層、琥珀重點、3 個旗標色、5 個色標。
- 文字一律用 `--ink*` 變數，不要直接寫 `#fff` 或 `#000`。
- 不要用 box-shadow 模擬發光以外的彩色光暈。

### 5.2 字型 Typography

只用兩個字型族：

```css
:root {
  --font-sans: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, "SF Mono", Monaco, monospace;
}
```

從 Google Fonts 載入：
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@300;400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
```

**字級用法**（全部 px，因為這是桌面工具）：

| 用途 | 字型 | 大小 | 粗細 | letter-spacing |
|---|---|---|---|---|
| 主標題 H1（畫面頂的「海邊系列」） | sans | 26 | 600 | -0.02em |
| 模態標題 | sans | 22 | 600 | -0.01em |
| 卡片標題 | sans | 16 | 600 | 0 |
| 卡片副標 / EXIF | sans | 13 | 400 | 0 |
| 內文 | sans | 12 | 400 | 0 |
| 小字（卡片角落、檔名） | mono | 10 | 400 | 0 |
| Mono 標籤（SIDEBAR TITLE） | mono | 9–10 | 500 | 0.16–0.22em，大寫 |
| kbd 按鍵 | mono | 10 | 600 | 0 |

**核心規則**：
- **所有英文標籤、metadata、檔名、技術數字** 用 `mono`。例：`F/2.8`、`PICK`、`247 / 247`、`14:32`、`IMG_0823.jpg`。
- **中文內容** 用 `sans`。
- **不要** 把 mono 用在中文段落上。
- 不要用任何其他字型（特別不要 Inter）。

### 5.3 間距 Spacing

採 4px 倍數系統：

```css
:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-7: 32px;
  --space-8: 48px;
}
```

常用 padding：
- Sidebar：18px 16px
- 卡片內：14px
- 模態內：22px 28px
- Header：高度 56px，左右 18px

### 5.4 邊框 / 圓角 / 陰影

- **圓角**：幾乎不用。整套設計刻意走 **直角硬邊**，凸顯攝影器材 / 暗房感。例外：頭像（圓形）、kbd 角 2px。
- **邊框**：1px solid，用 `--border`。重點選中時改成 `2px solid var(--accent)` 或 `1px solid var(--accent)`。
- **分隔線**：1px solid `--rule`（比 border 更暗），畫面內次要分隔用。
- **陰影**：
  - 一般卡片：無陰影。
  - 浮動 modal：`0 40px 100px rgba(0,0,0,.6)`。
  - 浮動操作列（批次工具列）：`0 12px 40px rgba(0,0,0,.45)`。
  - 詳細檢視中的照片：`0 20px 60px rgba(0,0,0,0.5)`。

---

## 6. 共用元件 Components

下面列出反覆出現的元件，請做成可重用模組。

### 6.1 Pill Button

文字 + 邊框小膠囊鍵。最常用按鈕。

```
spec:
  padding: 5px 10px
  font: mono 10px, letter-spacing 0.04em
  background: transparent
  border: 1px solid var(--border)
  color: var(--ink-70)

  &:hover  { color: var(--ink); }
  &.active {
    border-color: var(--accent);
    background: var(--accent-dim);
    color: var(--accent);
  }
```

### 6.2 Primary Button

實心強調按鈕。例：「同步 SHEETS」、「開始匯出」、「下載 PNG」。

```
spec:
  padding: 7–10px × 12–22px
  background: var(--accent)
  color: var(--bg)
  border: none
  font: mono 10–11px, weight 600–700, letter-spacing 0.12em, UPPERCASE
```

### 6.3 Side Title

Sidebar 區塊小標。

```html
<div class="side-title">01 / SOURCE</div>
```
```
font: mono 9px, letter-spacing 0.2em, color: --ink-55
padding-bottom: 6px
border-bottom: 1px solid var(--rule)
```

### 6.4 Photo Card

照片格網的單張卡片。**最重要的元件**。

```
結構：
  .photo-card
    .photo-card__media       (照片本體，div with background-image)
      .photo-card__flag      (左上 PICK/REJECT/REVIEW chip)
      .photo-card__color     (右上 10×10 色標方塊)
      .photo-card__anno      (✎ 標注 icon)
      .photo-card__check     (左下批次選取核取方塊；僅批次模式可見)
    .photo-card__meta        (檔名 + 星星)
      .photo-card__name      (mono 10px)
      .photo-card__stars

states:
  default        : border 1px var(--border)
  selected       : border 1px var(--accent)
  batched        : border 1px var(--ink-55)
  hover          : 加 outline 1px var(--ink-35)

密度（縮圖高度）:
  dense   : 96px  / 6 columns / gap 8
  medium  : 150px / 4 columns / gap 12   ← 預設
  sparse  : 200px / 3 columns / gap 16
```

### 6.5 Stars

星級評分元件。星星顏色 = `--accent`。空星 = `--ink-15`。

```
sizes:
  thumbnail card : 10px
  preview pane   : 20px
  mobile detail  : 26px

互動：
  hover : 預覽該星數高亮
  click : setRating(id, n)
  click on same star already filled : setRating(id, n-1) 或 toggle 為 0
```

### 6.6 Flag Chip

旗標標籤。卡片角落 + 詳細頁 + 過濾器都會用。

```
PICK    : background var(--pick),   color var(--bg), text "PICK"
REVIEW  : background var(--review), color var(--bg), text "REVIEW"
REJECT  : background var(--reject), color var(--bg), text "REJECT"

font: mono 8–10px, weight 700, letter-spacing 0.08–0.1em, UPPERCASE
padding: 2px 6px (卡片角落) / 2px 8px (詳細頁)
```

### 6.7 Color Label Swatch

色標。卡片角落為 10×10 純色塊（無圓角）。預覽窗按鈕為 30×30。

```
active state : border 2px var(--ink)
default      : border 1px var(--border)
```

### 6.8 KBD（鍵盤按鍵）

```
font: mono 10px, weight 600
padding: 2px 7px, min-width 18px, text-align center
background: var(--card)
border: 1px solid var(--border), border-bottom-width 2px
color: var(--ink)
```

### 6.9 Header

頂部 56px 高，三欄式 `260px / 1fr / 320px`：

- 左：logo 方塊（22×22，背景 `--accent`，字 `--bg`，內容「選」）+ 「選圖工作室」 + 「STUDIO」mono 標籤
- 中：麵包屑（mono 11px，用 `›` 分隔）+ 排序 / 檢視按鈕
- 右：「同步 SHEETS」主按鈕 + 30×30 圓形頭像

### 6.10 Left Sidebar (Filters)

寬 280px、`var(--surface)` 背景、右邊 1px `--rule` 邊框。內含 5 個區塊（每個區塊用 `.side-title` 分隔）：

1. SOURCE（資料夾資訊卡）
2. RATING（7 個星級篩選器）
3. FLAGS（3 個旗標卡片，水平排列）
4. COLOR（5 個色標清單）
5. AI ASSIST（4 個 AI 群組卡片）

### 6.11 Right Preview Pane

寬 320–360px。內容由上到下：

1. PREVIEW 標題
2. 4:3 照片預覽
3. 檔名 + EXIF mono 行
4. RATING（大星星 + 「按 1–5」提示）
5. FLAG（3 個 chip 按鈕）
6. COLOR（5 個色標方塊）
7. NOTE（卡片背景顯示備註內容，可點開編輯）
8. 「進入詳細 ↗」主按鈕（貼在最下方）

---

## 7. 畫面清單 Screens

共 **21 個畫面 / 狀態**，分 6 個 section。對應原型檔案：

### 01 · 主流程（5）

| ID | 畫面 | 尺寸 | 對應原型函式 |
|---|---|---|---|
| `grid` | 主頁網格 · Lightroom 雙欄 | 1440×900 | `BGrid` in `b-flow.jsx` |
| `detail` | 詳細檢視 + 標注 | 1440×900 | `BDetail` |
| `slide` | 全螢幕幻燈片 | 1440×810 | `BSlideshow` |
| `compare` | 比較模式 · 並排 3 張 | 1440×900 | `BCompare` |
| `batch` | 批次選取 · 浮動操作列 | 1440×900 | `BGridBatch` |

### 02 · 模態與彈窗（4）

| ID | 畫面 | 尺寸 | 對應原型函式 |
|---|---|---|---|
| `shortcuts` | 快捷鍵 + AI 智慧面板 | 1100×760 | `BShortcuts` in `b-modals.jsx` |
| `export` | 匯出面板 | 860×720 | `BExport` |
| `sync` | 同步進度 | 760×720 | `BSync` |
| `settings` | 設定面板（5 分頁） | 1040×680 | `BSettings` |

### 03 · 空狀態 / 載入（4）

| ID | 畫面 | 尺寸 | 對應原型函式 |
|---|---|---|---|
| `signin` | 未登入 | 1440×900 | `BEmptySignIn` in `b-states.jsx` |
| `nofolder` | 已登入但未載入 | 1440×900 | `BEmptyNoFolder` |
| `noresults` | 篩選後無結果 | 1440×900 | `BEmptyNoResults` |
| `loading` | 載入中（skeleton） | 1440×900 | `BLoading` |

### 04 · 專案 / 資料夾（1）

| ID | 畫面 | 尺寸 | 對應原型函式 |
|---|---|---|---|
| `folder-list` | 所有專案（6 個資料夾） | 1440×900 | `BFolders` in `b-modals.jsx` |

### 05 · 相簿排版工具（4）

| ID | 畫面 | 尺寸 | 對應原型函式 |
|---|---|---|---|
| `des-empty` | 空畫布 + 背景頁籤 | 1440×900 | `BDesignerEmpty` in `b-designer.jsx` |
| `des-layout` | 自動排版 + 圖層 | 1440×900 | `BDesignerLayout` |
| `des-ai` | AI 背景生成 | 1440×900 | `BDesignerAI` |
| `des-export` | 匯出彈窗 | 980×760 | `BDesignerExport` |

### 06 · 手機版 RWD（3）

| ID | 畫面 | 尺寸 | 對應原型函式 |
|---|---|---|---|
| `m-grid` | 主頁 2 欄網格 | 390×844 | `BMobileGrid` in `b-mobile.jsx` |
| `m-detail` | 詳細檢視 | 390×844 | `BMobileDetail` |
| `m-filter` | 篩選 Bottom Sheet | 390×844 | `BMobileFilters` |

> 詳細的版面結構、間距、內容請打開對應 `.jsx` 檔案直接閱讀。所有元素的 inline style 就是 source-of-truth 規格。
> 對照 `screens/` 資料夾裡的 PNG 截圖一起看更快。

### 7.1 截圖索引 Screen index

`screens/` 資料夾內按下表編號：

```
01-grid.png                主頁網格
02-detail.png              詳細檢視 + 標注
03-slideshow.png           全螢幕幻燈片
04-compare.png             比較模式
05-batch.png               批次選取
06-shortcuts.png           快捷鍵面板
07-export.png              匯出
08-sync.png                同步進度
09-settings.png            設定
10-signin.png              未登入
11-nofolder.png            未載入資料夾
12-noresults.png           篩選無結果
13-loading.png             載入中 skeleton
14-folders.png             多資料夾總覽
15-designer-empty.png      相簿排版 · 空畫布
16-designer-layout.png     相簿排版 · 自動排版
17-designer-ai.png         相簿排版 · AI 背景生成
18-designer-export.png     相簿排版 · 匯出
19-mobile-grid.png         手機版 · 主頁
20-mobile-detail.png       手機版 · 詳細
21-mobile-filter.png       手機版 · 篩選 sheet
```

---

## 8. 互動與行為 Interactions

### 8.1 鍵盤快捷鍵 Keyboard

全域監聽 keydown。當 focus 在 `input` / `textarea` / `contenteditable` 時 **不要** 觸發。

| 鍵 | 作用 | 範圍 |
|---|---|---|
| `1`–`5` | 設定選中照片的星級 | 全域 |
| `0` | 清除評分 | 全域 |
| `P` | 標選中照片為「精選」（再按一次取消） | 全域 |
| `X` | 標為「捨棄」（toggle） | 全域 |
| `R` | 標為「待覆審」（toggle） | 全域 |
| `G` | 開色標選單（紅 → 橘 → 綠 → 藍 → 紫 → 清除 循環） | 全域 |
| `←` `→` | 上 / 下一張 | 全域 |
| `↑` `↓` | 上 / 下一列（網格模式） | 網格 |
| `F` | 進入幻燈片 | 全域 |
| `Esc` | 退出模態 / 幻燈片 / 比較模式 | 全域 |
| `Space` | 快速預覽（按住） | 網格 |
| `C` | 進入比較模式 | 網格（選 2–4 張時） |
| `B` | 切換到畫圈標注工具 | 詳細頁 |
| `T` | 文字標注工具 | 詳細頁 |
| `E` | 橡皮擦 | 詳細頁 |
| `Z` | 縮放工具 | 詳細頁 / 比較 |
| `⌘S` | 儲存標注 | 詳細頁 |
| `⌘Z` | 復原 | 全域 |
| `⌘O` | 載入 Drive 資料夾 | 全域 |
| `⌘E` | 開匯出面板 | 全域 |
| `⌘⇧S` | 同步到 Google Sheets | 全域 |
| `?` | 切換快捷鍵面板 | 全域 |
| `⌘,` | 開設定 | 全域 |
| `⌘K` | 命令列搜尋（未實作，預留） | 全域 |

### 8.2 評分互動

- 點 N 顆星 = 設為 N 星。
- 點同一顆已亮的星 = 清為 N-1 星（或 toggle 為 0 — 任一種都可，請統一）。
- 評分變更 **即時儲存到 localStorage**（沿用 `ratingManager`）。

### 8.3 旗標互動

- 點任一旗標 = 切換該旗標。同一張照片同時只能有一個旗標。
- 同一張照片從「PICK」改成「REJECT」就直接覆蓋。
- 再點同一旗標 = 清除。

### 8.4 色標互動

- 點色標 = 切換。一張照片只能有一個色標。
- 再點同色 = 清除。

### 8.5 批次選取 Batch

- 點縮圖左下的核取方塊 = 加入 / 移出批次集合。
- `⌘A` 全選當前可見的照片。
- 批次集合大於 0 時，畫面底部彈出浮動 **批次操作列**（見 `BGridBatch`）。
- 批次操作：設定評分、加旗標、加色標、移到資料夾、匯出、刪除。
- 按 `Esc` 清除批次集合。

### 8.6 比較模式

- 按 `C`（已選 2–4 張時）進入。
- 並排顯示，可單選最佳、單張捨棄。
- 1 / 2 / 3 / 4 數字鍵 = 選對應位置為最佳。
- `X` = 把當前 hover 的捨棄。
- AI 提示列在底部顯示「建議第 X 張」。

### 8.7 拖放

- **照片排版工具**：從左 sidebar 拖照片到中央畫布。
- **資料夾載入**：拖一個 Drive URL 進畫面任何地方 = 嘗試載入。

### 8.8 動畫 / 轉場

整套設計刻意保持 **低動畫感**（攝影師工具）。允許：
- Pill button hover：背景色 120ms ease。
- Modal 開啟：opacity 180ms ease。
- Loading skeleton：`shimmer` 1.4s ease-in-out infinite（見 `b-states.jsx`）。
- 同步進度條：對角條紋持續流動。

**不要做**：彈跳、放大、3D 翻轉、彩色光暈過渡等。

### 8.9 Toast

沿用現有 `toast.js`，但改用 Studio Dark 顏色：

```
background: var(--surface)
border-left: 3px solid var(--accent)   (info)
border-left: 3px solid var(--pick)     (success)
border-left: 3px solid var(--reject)   (error)
color: var(--ink)
padding: 12px 16px
```

---

## 9. 資料模型 Data Model

每張照片要存的欄位（擴充自現有 `rating` 系統）：

```js
{
  id:        "drive-file-id",
  name:      "IMG_0823.jpg",
  src:       "thumbnail-url",
  src_full:  "full-resolution-url",
  date:      "2026/08/23 14:32",
  exif:      { camera, lens, focal, aperture, shutter, iso, dimensions },

  // 用戶資料（持久化）
  rating:    0–5,                              // 既有
  flag:      'pick' | 'reject' | 'review' | null,    // 新增
  color:     'red' | 'amber' | 'green' | 'blue' | 'purple' | null,  // 新增
  annotated: boolean,                          // 既有
  annotations: [...fabricJSON],                // 既有
  note:      "string",                         // 新增（已部分有）
}
```

**持久化位置**：
- 本機 localStorage（即時、離線可用）— 沿用現有結構，加上 `flag`、`color`、`note` 欄位。
- Google Sheets（按 `⌘⇧S` 同步）— 對應 columns 也要新增。

建議 Sheets schema：
```
| file_id | file_name | rating | flag | color_label | note | annotated | annotation_json | updated_at |
```

---

## 10. AI 智慧分組 AI Assist

**第一階段：mock 介面**

`b-system.jsx` 中的 `AI_GROUPS` 是寫死的假資料。第一版只要 UI 能顯示這 4 組就好。

```js
[
  { label: '相似組 · 海邊',  count: 3, kind: 'similar', suggest: 'IMG.jpg' },
  { label: '相似組 · 阿橘',  count: 2, kind: 'similar' },
  { label: '可能失焦',        count: 2, kind: 'blur'    },
  { label: '構圖最佳建議',    count: 6, kind: 'best'    },
]
```

**第二階段：實際 AI**

- **相似組**：用感知雜湊（pHash / dHash）對所有縮圖做兩兩比對，距離 < 10 視為相似，分群。
- **失焦偵測**：對縮圖做 Laplacian 變異數，<100 視為失焦。
- **構圖建議**：可呼叫 GPT-4 Vision / Gemini Vision API，傳 thumbnail，請它從一組相似中挑最佳。

第一階段建議只實作前兩個（純前端 canvas + math 就能做），第三個延後。

---

## 11. RWD / 手機版

斷點：

```css
@media (max-width: 900px)  { /* 平板：sidebar 收成抽屜 */ }
@media (max-width: 600px)  { /* 手機：完全切換到手機版 layout */ }
```

手機版主要差異（見 `b-mobile.jsx`）：
- Header 變高 + 簡化
- Sidebar 變成底部 sheet（從 `m-filter` 拉起）
- 網格 2 欄、正方比例
- 底部 5 個 tab nav（網格 / 幻燈片 / 比較 / 匯出 / 更多）
- 評分按鈕變大（26px 星星）
- 旗標 / 色標按鈕變大、跨整行

---

## 12. 相簿排版工具 Album Designer

對應現有 `r2_version/r2_designer/`。

### 12.1 維持的元素

- Fabric.js v5.3.1 — canvas 物件操作。
- `driveManager` 整合 — 從選圖工具同步 PICK 照片進素材庫。
- JSZip — 整本相簿匯出 ZIP。

### 12.2 重做的元素

- 整套視覺改成 Studio Dark token（不要白色背景的 sidebar）。
- 右側面板從 3 個 tab（背景 / 版面 / AI）擴成 **4 個**：背景、版面、**文字**、AI 創生。
- 版面 tab 加上：8 個自動排版模板（1, 2-h, 2-v, 3, 4, 4-large, 6, 9）、間距 slider、選中物件屬性面板、圖層列表。
- AI tab 加上：8 個快速風格 chip、歷史紀錄列、4 個候選背景縮圖。
- 畫布四角加上琥珀色尺規標記（`◤◥◣◢`）。
- 匯出面板擴充：支援 PNG / JPG / PDF + 印刷解析度 + 整本相簿 ZIP。

### 12.3 文字 tab（新增）

雖然原型沒有畫，但右側已預留 tab，請實作：
- 加文字框（雙擊畫布 = 新增）
- 字型選擇（IBM Plex Sans / Mono、Noto Serif、Noto Sans）
- 大小、粗細、顏色、對齊
- 文字陰影 / 描邊

---

## 13. Tweaks · 可調項

縮圖密度（dense / medium / sparse）目前是設計師原型用的 toggle。
正式版可以放在「設定 > 外觀」面板裡，或維持為頂部工具列的密度切換按鈕。

---

## 14. 實作建議順序 Suggested Phases

每個 phase 結束都可以發佈一版。

| Phase | 內容 | 時間估計 |
|---|---|---|
| **P1 · 視覺翻新** | 重寫 `styles.css` 採用 token 系統；重做 header、sidebar、photo card、preview pane；不加新功能 | 1 週 |
| **P2 · 旗標 + 色標** | 加 `flag` 與 `color` 欄位 + 對應 UI 與 localStorage 持久化 | 3 天 |
| **P3 · 鍵盤快捷鍵** | 全域 keydown + 完整快捷鍵面板（`?` 開） | 2 天 |
| **P4 · 批次選取 + 比較模式** | 多選 state + 浮動工具列 + 比較頁面 | 4 天 |
| **P5 · 新模態** | 設定面板、匯出面板、同步進度（強化現有）、空狀態翻新 | 3 天 |
| **P6 · 多資料夾** | Folder list view + 切換邏輯 | 2 天 |
| **P7 · 相簿排版工具** | 重做 designer 視覺、版面 tab、文字 tab、AI tab、匯出 | 1 週 |
| **P8 · AI 智慧分組** | pHash 相似偵測 + Laplacian 失焦偵測 | 4 天 |
| **P9 · RWD** | 手機版 layout + 觸控優化 | 3 天 |

---

## 15. 檔案清單 Files in this bundle

```
design_handoff_studio_dark/
├── README.md                  ← 你正在看的這份
├── prototype/                 ← React JSX 設計參考稿
│   ├── index.html
│   ├── shared.jsx             ← 假資料、Stars 元件、共用 helper
│   ├── b-system.jsx           ← 設計 token、store、Header、PhotoCard、Sidebar
│   ├── b-flow.jsx             ← Grid、Detail、Compare、Slideshow、BatchBar
│   ├── b-modals.jsx           ← Shortcuts、Export、Sync、Settings、Folders
│   ├── b-states.jsx           ← 4 個空 / 載入狀態
│   ├── b-mobile.jsx           ← 3 個手機版畫面
│   ├── b-designer.jsx         ← 4 個相簿排版工具畫面
│   ├── app.jsx                ← Design canvas + Tweaks 組裝
│   ├── design-canvas.jsx      ← 設計師用的展示框架（不需重做）
│   └── tweaks-panel.jsx       ← 設計師用的 tweak 面板（不需重做）
```

### 如何讀原型

1. 在原型專案目錄裡跑 `python3 -m http.server 8000`，開 `localhost:8000/index.html`，可以看到所有 21 個畫面排在 design canvas 上。
2. 點任何一個畫面右上「↗」可以全螢幕看那一個。
3. 互動真的會作用 — 你可以在主頁網格上點星星、按 P / X / R 試試。
4. 工具列開 Tweaks 可以切縮圖密度。

### 如何把規格抽出來

每個元件的 spec 都寫在 JSX inline style 裡。例：

```jsx
<button style={{
  padding: '7px 12px', background: T.accent, color: T.bg,
  border: 'none', fontFamily: T.mono, fontSize: 10,
  letterSpacing: '0.12em', textTransform: 'uppercase',
  fontWeight: 600, cursor: 'pointer',
}}>同步 SHEETS</button>
```

對應 CSS：

```css
.btn-primary {
  padding: 7px 12px;
  background: var(--accent);
  color: var(--bg);
  border: none;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-weight: 600;
  cursor: pointer;
}
```

`T.bg` / `T.accent` 等變數對應規範請對照本文件第 5 章。

---

## 16. 設計師備註

- 整套設計刻意 **沒有用漸層、發光、模糊** — 攝影師工具要看起來像專業器材，不是消費級 app。
- 整套設計只有 **一個** 重點色（琥珀）。如果你想加新功能、想加新顏色 → **不要**，請改用 mono、灰階分層、加底線、加大字級來表達層級。
- 字型大小已壓到最小可讀範圍（10–12px）。**不要把字放大** — 桌面工具的密度感是設計重點。
- 所有色標 / 旗標 / 星星都 **不要動畫** — 點下去就是直接變，不要 fade / scale。

有問題回頭找設計師。

---

*文件版本 1.0 · 2026/05/19*
