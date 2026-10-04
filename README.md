# Image Picker Studio — 攝影師選圖工作室

攝影師的選圖工作室（imhoti.tw/studio）：照片上傳後把一條連結傳給客人，客人在手機上挑片，
攝影師收到選片結果、排相本、記錄加購訂單。目前是攝影師自用，方向是做成多攝影師的 SaaS
（`projects.photographer_id` 已存在，目前都是 `default`）。

---

## 架構

| 層 | 技術 |
|---|---|
| 前端 | 純 JavaScript 靜態頁（無框架），用 SFTP 上傳到 imhoti.tw/studio |
| API | Cloudflare Worker：`worker/worker.js`（設定在 `worker/wrangler.toml`） |
| 照片儲存 | R2 bucket `imagepicker`（所有讀取都經過 Worker 的 token 閘門；r2.dev 公開網址已關閉） |
| 資料庫 | D1 `imagepicker-db`（專案、分享連結、選片、訂單、設定等，結構見 `worker/schema.sql`） |

注意：R2 有 lifecycle，**上傳 180 天後刪除 bucket 內所有物件**（沒有 prefix 例外）。
要長期保存的東西（logo、長期備份）不能放在這個 bucket。

---

## 頁面

| 檔案 | 用途 |
|---|---|
| `home.html` | 入口首頁（明亮版），登入後進 dashboard |
| `dashboard.html` | 攝影師後台儀表板：專案、已交付狀態、營收 |
| `admin.html` | 專案 / 客戶管理：分享連結、選片狀態、交件（含「＋上傳精修」、預填上次精修資料夾）、訂單、下載選片 / 需求表 CSV。專案詳情的交件、設定、目前選取、訂單、送出紀錄、挑選人與連結各是一個可收合的區塊（標題列＋一行摘要；展開狀態記在瀏覽器 localStorage，只是便利） |
| `settings.html` | 工作室設定（名稱、logo、預設方案）與商品目錄（從平台加入商品、定價） |
| `orders.html` | 訂單列表與編輯 |
| `operator.html` | 平台營運者（OPERATOR_TOKEN）管理平台商品 |
| `upload.html` | 上傳照片到 R2；從專案進來（`?project=<id>`）時返回鍵回專案 |
| `index.html` | 選圖介面：客人用選片連結開啟（挑片、標示修改 pins、交件後的精修 gallery）；攝影師從專案的「看照片」進入是唯讀的 Review 模式（`js/project-view.js`，沒有標注工具，pins 列在右欄 / 照片下方） |
| `client-login.html` | 客戶登入 |
| `tutorial.html` | 操作說明 |
| `ping.html` | 連線診斷 |
| `book_editor/` | 相本排版：`index.html` 編輯器（自動排版、匯出 JPG ZIP）、`view.html` 客戶預覽 / 核准 |
| `r2_designer/` | 自由排版畫布（Fabric.js） |

設計文件在 `docs/`：`backlog.md`（路線圖與待辦）、`guest-picking.md`（客人挑片與 pins）、
`delivery.md`（交件）、`project-plan.md`（方案與加挑上限）、`dashboard-settings.md`、
`products-orders.md`、`guest-shop.md`、`pick-handover.md`、`photographer-interviews.md`。
`CLAUDE.md` 是工作約定。

### 主題

攝影師端頁面（`home` / `dashboard` / `admin` / `upload` / `settings` / `orders` / `operator`）
一律用 `home.html` 的米色亮色主題（`--bg:#fff8ee`）。客戶端（`index.html` 客人模式、
`client-login.html`、`book_editor/view.html`）維持深色。`book_editor/index.html`（攝影師用的相本編輯器）
目前還是自己的深藍主題，尚未統一。

---

## 專案流程（目前的樣子）

專案狀態：挑片 → 已送出 → 精修中 → 已交件（`delivered_at`）。

- **一條連結兩個畫面**：交件前客人看到挑片畫面；交件後同一條連結變成精修 gallery（只顯示精修資料夾）。
- **交件狀態只看 `delivered_at`**。`projects.final_folders` 是「上次選定的精修資料夾」，
  **取消交件**和**開放修改（reopen）**都只清 `delivered_at`、保留它，下次交件時 admin 會預填
  （可修改，按「交件」才生效）。未交件時任何連結都讀不到精修資料夾。
- **標示修改（pins）**：客人在 ♥ 的照片上點位置放編號 pin，放下後自動跳出輸入框填文字；
  資料是 `selections.marks`（0–1 比例座標）。攝影師在 Review 看到，也可用「下載需求表 (CSV)」
  匯出（檔名、備註、標示；UTF-8 含 BOM）給修圖師。
- **建專案時自動決定資料夾**（`js/project-folders.js` 是命名的唯一出處）：填「專案名稱」「拍攝日期」，
  專案資料夾是 `YYYYMMDD 專案名稱/`，毛片 `…/毛片/`，精修 `…/精修/`，第二版起 `精修二`、`精修三`…
  `精修十`，之後 `精修11`。R2 沒有真正的資料夾，傳第一張照片時才會出現；資料夾名稱建立後不能改（title 可改）。
  專案頁的「＋上傳毛片」「＋上傳精修」會鎖定目標資料夾，精修自動取下一版編號，不會蓋掉前一版；
  同名資料夾已有照片時建立表單會提示「會沿用」。舊專案的資料夾不動。
- 精修 / 毛片請放在各自獨立的資料夾（慣例 `<shoot>/毛片/` 與 `<shoot>/精修/` 並排）；
  精修資料夾不可與毛片資料夾重疊。
- 同名檔案上傳會**直接覆蓋**（PUT 不檢查），要保留版本請放不同資料夾。

---

## 部署

Push 到 `main` 才會部署（`.github/workflows/deploy.yml`）：

1. CI 跑 Worker 測試與前端 JS 語法檢查（不跑瀏覽器測試）
2. 用 SFTP 上傳靜態檔案到 `/public_html/studio/`（排除 `worker/`、`*.md` 等）
3. `wrangler deploy` 部署 Worker
4. 部署後手動：Cloudflare → imhoti.tw → Caching → Purge Everything

前端每次改動要更新資源的 `?v=` 版本戳。開發在 `claude/<topic>` 分支，Tim 說了才 push main。

### Secrets 與變數（只列名稱，值不進 repo）

- Secrets（`wrangler secret put <名稱>`）：`PHOTOGRAPHER_TOKEN`、`OPERATOR_TOKEN`、`PHOTOGRAPHER_EMAIL`
- `[vars]`（`worker/wrangler.toml`）：`NOTIFY_FROM`、`CUSTOM_PRODUCTS`
- Bindings：R2 `imagepicker`、D1 `DB`、send_email `NOTIFY_EMAIL`

**任何 token 都不能放進 `js/config.js`**：它是公開檔案。攝影師 token 只在登入時由使用者輸入，
存在瀏覽器 sessionStorage。

### D1 migration

Schema 只做 append-only 變更（`ALTER TABLE ... ADD COLUMN`）。SQL 放在 `worker/migrations/`，
並記在 `worker/schema.sql`。**由 Tim 在 D1 Console 手動執行，要在需要它的那次 merge 之前跑。**

---

## 測試

```bash
# Worker（幾秒）
node --test "worker/test/*.test.mjs"
node --input-type=module --check < worker/worker.js   # 抓得到語法錯；單純 node --check 抓不到

# 瀏覽器（幾分鐘；Playwright 在 repo 外，Chromium 在 /opt/pw-browsers）
NODE_PATH=/tmp/pwinstall/node_modules node test/run.mjs
# 只跑符合名稱的 suite（沒有任何 suite 符合會失敗）
ONLY=<suite 名稱片段> NODE_PATH=/tmp/pwinstall/node_modules node test/run.mjs
```

開發時只跑相關測試，commit / merge 前全部跑。CI 只跑 Worker 測試。

已知 flaky：book_editor「no token is minted for an empty folder set」在高負載下會失敗；
單獨跑會過。若 `/tmp/pwinstall` 不存在，Playwright 可能在 `/opt/node-tools/node_modules`。

---

## Claude Code Hook

`.claude/settings.json` 有一個 PreToolUse hook：`git commit` 前自動做四軸審查
（範圍、正確性、風格、精簡），有問題會用繁體中文回報並擋下這次 commit；它只審查，不會動檔案。

---

## 授權

授權：待定（商業化前需決定）
