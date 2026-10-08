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
| `dashboard.html` | 攝影師後台儀表板：專案、已交付狀態、營收、待辦（待確認訂單、未付款訂單等） |
| `admin.html` | 專案 / 客戶管理。專案列表有搜尋、狀態與類別篩選、「待我處理」排序（篩選記在網址 hash）；點進專案是獨立的詳情畫面（可改名、拍攝日期、類別、方案）：分享連結（複製連結會跳出可直接傳給客人的訊息）、選片狀態、交件（含「＋上傳精修」、預填上次精修資料夾）、客人的修改輪次與標示、客人興趣、訂單（含客人自助下的單）、下載選片 / 需求表 CSV。詳情的各區塊（交件、設定、目前選取、訂單、送出紀錄、挑選人與連結）可收合（展開狀態記在瀏覽器 localStorage，只是便利） |
| `settings.html` | 工作室設定（名稱、logo、預設方案、匯款資訊）與商品目錄（從平台加入商品、定價） |
| `orders.html` | 訂單列表與編輯 |
| `operator.html` | 平台營運者（OPERATOR_TOKEN）管理平台商品（含相本最少 / 最多頁數、加頁價格、出血 mm） |
| `upload.html` | 上傳照片到 R2（手機版面、失敗的檔案可重試）；從專案進來（`?project=<id>`）時返回鍵回專案 |
| `index.html` | 選圖介面：客人用選片連結開啟（首次使用導覽、挑片、標示修改 pins、交件後的精修 gallery 與驗收頁、確認後的完成頁）；攝影師從專案的「看照片」進入是唯讀的 Review 模式（`js/project-view.js`，沒有標注工具，pins 列在右欄 / 照片下方） |
| `client-login.html` | 客戶登入 |
| `tutorial.html` | 操作說明 |
| `ping.html` | 連線診斷 |
| `book_editor/` | 相本排版：`index.html` 編輯器（自動排版、匯出 JPG ZIP）、`view.html` 客戶預覽 / 核准 |
| `r2_designer/` | 自由排版畫布（Fabric.js） |

設計文件在 `docs/`：`backlog.md`（路線圖與待辦）、`guest-picking.md`（客人挑片與 pins）、
`delivery.md`（交件、客戶確認、完成頁、拍攝日期 / 類別 / 改名）、`revision-pins.md`（交件後的修改標示）、
`project-plan.md`（方案與加挑上限）、`dashboard-settings.md`、`products-orders.md`、`guest-shop.md`
（客人商店與自助訂購）、`album-preview.md`（相本排版引擎與客人預覽）、`pick-handover.md`（協作者提案，大部分是歷史）、
`photographer-interviews.md`、`claude-template.md`（給新 repo 的 CLAUDE.md 範本）。
`CLAUDE.md` 是工作約定。`CHANGELOG.md`、`DEVELOPMENT_LOG.md`（Google Drive 時代）與
`design_handoff_studio_dark/`（舊設計稿）只是歷史。

### 專案結構

| 路徑 | 內容 |
|---|---|
| `worker/` | `worker.js`（API，一個檔案）、`wrangler.toml`、`schema.sql`、`migrations/`（手動執行的 SQL）、`test/`（Worker 測試） |
| `js/` `css/` | 各頁共用的前端程式與樣式。`util.js` 是共用小工具（`escHtml`、`fmtDate`、`todayTaipei`、`formatPrice`），要比用到它的 script 先載入；`pick.js` 客人頁；`project-view.js` 攝影師 Review；`app.js` 共用照片格與預覽；`finals-gallery.js` / `completion-page.js` / `album-preview.js` 交件後畫面；`guest-order.js` 客人訂購；`guest-tour.js` 首次導覽；`side-nav.js` + `css/side-nav.css` 攝影師頁面側邊選單（手機是一排 pill） |
| `book_editor/` | 相本編輯器與排版引擎（`js/auto_layout.js`、`js/spread_templates.js`），自己的 CSS 與 `test/` |
| `test/` | 瀏覽器測試（`run.mjs` 只是 runner，suite 在 `suites/NN-<主題>.mjs`，共用假 Worker 與 helper 在 `lib/`），說明見 `test/README.md` |
| `docs/` | 設計文件（上表） |
| `.github/workflows/deploy.yml` | CI 與部署 |

返回鍵慣例（攝影師頁面）：左上角「← 返回」或「← 上一層」，高 44px。

### 主題

攝影師端頁面（`home` / `dashboard` / `admin` / `upload` / `settings` / `orders` / `operator`）
一律用 `home.html` 的米色亮色主題（`--bg:#fff8ee`）。客戶端（`index.html` 客人模式、
`client-login.html`、`book_editor/view.html`）維持深色。`book_editor/index.html`（攝影師用的相本編輯器）
目前還是自己的深藍主題，尚未統一。

---

## 專案流程（目前的樣子）

專案狀態：挑片 → 已送出 → 精修中 → 已交件（`delivered_at`）→ 客人確認完成（`client_confirmed_at`，也可由攝影師標記）。

- **一條連結兩個畫面**：交件前客人看到挑片畫面；交件後同一條連結變成精修 gallery（只顯示精修資料夾）。
- **交件狀態只看 `delivered_at`**。`projects.final_folders` 是「上次選定的精修資料夾」，
  **取消交件**和**開放修改（reopen）**都只清 `delivered_at`、保留它，下次交件時 admin 會預填
  （可修改，按「交件」才生效）。未交件時任何連結都讀不到精修資料夾。
- **客人驗收與修改**：交件後客人按「確認完成」，或在精修照片上放 pin、寫說明，按「送出修改（N 張）」送出一輪
  （送出後凍結，可看上一輪）。攝影師在後台看每一輪、下載該輪需求表 CSV，換新的精修資料夾後按「更換精修」
  就是下一版。**絕不會自動確認**。設計：`docs/delivery.md`、`docs/revision-pins.md`。
- **完成頁**：客人確認後，同一條連結變成淺色的完成頁（精修 gallery、拍攝日期、下載全部精修、商品區
  「把這段回憶留下來」與「我有興趣」、相本預覽）。
- **客人自助訂購（S2）已做好但預設關閉**：由 `worker/wrangler.toml` 的 `GUEST_ORDERS` 控制（見下）。關閉時客人
  只看到「我有興趣」。設計：`docs/guest-shop.md`。
- **標示修改（pins，挑片階段）**：客人在 ♥ 的照片上點位置放編號 pin，放下後自動跳出輸入框填文字；
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

1. CI（push 與 pull request 都跑）：Worker 測試，加上對每個 `.js` 跑 `node --check`（這個語法檢查很弱，
   見 `docs/backlog.md` 技術債；不跑瀏覽器測試、不跑 `book_editor/test`）
2. 只有 `main`：用 SFTP 上傳靜態檔案到 `/public_html/studio/`（排除 `worker/`、`*.md`、`.claude/` 等）
3. 只有 `main`：`wrangler deploy --no-bundle` 部署 Worker
4. 部署後手動：Cloudflare → imhoti.tw → Caching → Purge Everything（靜態檔或 Worker 有改才需要；只改文件不用）

前端每次改動要更新資源的 `?v=` 版本戳。開發在 `claude/<topic>` 分支，Tim 說了才 push main。

### Secrets 與變數（只列名稱，值不進 repo）

- Secrets（`wrangler secret put <名稱>`）：`PHOTOGRAPHER_TOKEN`、`OPERATOR_TOKEN`、`PHOTOGRAPHER_EMAIL`
- `[vars]`（`worker/wrangler.toml`）：`NOTIFY_FROM`、`CUSTOM_PRODUCTS`（預設 `off`）、
  `GUEST_ORDERS`（客人自助訂購：`off` 預設 / `pilot` 只開 `GUEST_ORDERS_PILOT` 列的專案 id（逗號分隔）/ `on`；
  其他值或打錯都算關）
- Bindings：R2 `imagepicker`、D1 `DB`、send_email `NOTIFY_EMAIL`

**任何 token 都不能放進 `js/config.js`**：它是公開檔案。攝影師 token 只在登入時由使用者輸入，
存在瀏覽器 sessionStorage。

### D1 migration

Schema 只做 append-only 變更（`ALTER TABLE ... ADD COLUMN`）。SQL 放在 `worker/migrations/`，
並記在 `worker/schema.sql`。**由 Tim 在 D1 Console 手動執行，要在需要它的那次 merge 之前跑。**
Console 一次只能跑一句，檔案內多句要一句一句貼；ALTER 不能重跑（第二次會 "duplicate column name"，代表已跑過，可忽略）。
沒跑的 migration 不會弄壞其他功能：Worker 會退回舊行為，只有用到新欄位的那一個動作回 500（各檔開頭註解寫明）。

目前全部的 migration（檔名日期序；**repo 看不到 D1，哪些已經跑過只有 Tim 知道**，下表「跑了嗎」要由他確認）：

| 檔案 | 新增 | 備註 / 順序 | 跑了嗎 |
|---|---|---|---|
| `2026-09-27-guest-picking.sql` | `projects` `pickers` `submissions` `selections` `project_members`、`share_tokens.project_id` | 最早，客人挑片 | 待 Tim 確認 |
| `2026-09-28-project-archive.sql` | `projects.archived_at` | 在 guest-picking 之後 | 待 Tim 確認 |
| `2026-09-28-dashboard-settings.sql` | `projects.delivered_at`、`studio_settings` | 在 archive 之後 | 待 Tim 確認 |
| `2026-09-29-products-orders.sql` | `products`、`product_options`、訂單相關表、平台商品 | 在 dashboard-settings 之後 | backlog 記載已跑（products / orders ✅） |
| `2026-09-30-delivery.sql` | `projects.final_folders`、`allow_proof_download` | 交件 | 待 Tim 確認 |
| `2026-09-30-retouch-pins.sql` | `selections.marks`、`submissions.marks` | 在 delivery 之後 | 待 Tim 確認 |
| `2026-09-30-extra-max.sql` | `projects.extra_max`、`studio_settings.default_extra_max` | 在 retouch-pins 之後 | 待 Tim 確認 |
| `2026-10-04-client-confirm.sql` | `projects.client_confirmed_at/_by`、`revision_requests` | 4 句；在 extra-max 之後 | 待 Tim 確認 |
| `2026-10-06-product-min-pages.sql` | `platform_products.min_pages` | 在 client-confirm 之後 | 待 Tim 確認 |
| `2026-10-06-product-max-pages.sql` | `platform_products.max_pages` | 與 min-pages 各自獨立 | 待 Tim 確認 |
| `2026-10-07-revision-pins.sql` | `revision_requests.marks/finals/message_auto`、`revision_pins` | 4 句；在 client-confirm 之後 | 待 Tim 確認 |
| `2026-10-07-product-bleed.sql` | `platform_products.bleed_mm` | 出血 | 待 Tim 確認 |
| `2026-10-07-product-extra-page-price.sql` | `platform_products.extra_page_price` | 加頁價格 | 待 Tim 確認 |
| `2026-10-07-project-shoot-date.sql` | `projects.shoot_date` | 與 project-type 各自獨立 | 待 Tim 確認 |
| `2026-10-07-project-type.sql` | `projects.project_type` | 專案類別 | 待 Tim 確認 |
| `2026-10-08-product-interests.sql` | 表 `product_interests` | 「我有興趣」；沒跑時 `POST /api/pick/interest` 回 500 | 待 Tim 確認 |
| `2026-10-09-guest-orders.sql` | `orders`（request_id、聯絡資料、consent…）、`order_items.list_price/layout`、`studio_settings.transfer_info`，11 句 | **S2：打開 `GUEST_ORDERS` 之前一定要跑**（沒跑時客人訂單路由回 500 `orders_unavailable`、設定的匯款資訊存不進去） | 待 Tim 確認 |

`worker/schema.sql` 是這些的合併版（新資料庫可以照它建）。
---

## 測試

```bash
# Worker（幾秒）
node --test "worker/test/*.test.mjs"
node --input-type=module --check < worker/worker.js   # 抓得到語法錯；單純 node --check 抓不到

# 相本排版引擎與模板（幾秒；CI 不跑）
node --test book_editor/test/*.test.mjs
node book_editor/test/render-templates.mjs <outDir>   # 把模板庫畫成 PNG 總覽

# 瀏覽器（幾分鐘；Playwright 在 repo 外，Chromium 在 /opt/pw-browsers）
NODE_PATH=/tmp/pwinstall/node_modules node test/run.mjs
# 只跑 suite 名稱含該文字的（| 分隔多個；沒有任何 suite 符合會失敗）
ONLY=<suite 名稱片段> NODE_PATH=/tmp/pwinstall/node_modules node test/run.mjs
```

開發時只跑相關測試，commit / merge 前全部跑。**CI 只跑 Worker 測試**（瀏覽器與相本測試要自己跑）。
瀏覽器 suite 的寫法、檔案配置與 `ONLY` 見 `test/README.md`（suite 檔案編號 01–56，沒有 44）。

已知 flaky（高負載下才紅、單獨跑會過）列在 `CLAUDE.md`：book_editor「no token is minted for an empty folder set」
等數個 suite。看到紅燈先用 `ONLY=` 單獨重跑，不要直接當成 regression。
若 `/tmp/pwinstall` 不存在，Playwright 可能在 `/opt/node-tools/node_modules`。

---

## Claude Code Hook

`.claude/settings.json` 有一個 PreToolUse hook：`git commit` 前自動做四軸審查
（範圍、正確性、風格、精簡），有問題會用繁體中文回報並擋下這次 commit；它只審查，不會動檔案。

---

## 授權

授權：待定（商業化前需決定）
