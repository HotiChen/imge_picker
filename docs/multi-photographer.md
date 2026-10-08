# 多攝影師（multi-photographer）設計

狀態：**設計稿，尚未實作**（第 0 批）。2026-10-08 Tim 決定：不等「找 5 位驗證」，直接做多攝影師，
分批放行；範圍只到「我有興趣」，**金流與 S2 下單維持關閉**。順序變更已寫入 `docs/backlog.md`。

## 目標與不做的事

- 目標：另一位攝影師可以註冊 → 由平台方（Tim）審核開通 → 用自己的帳號上傳、建專案、發選片連結、交件、
  看「我有興趣」。看不到、也改不到別人的任何東西。
- 開放註冊，但**審核制**：沒開通的帳號什麼都做不了。之後可再放寬成自由開通（只是改一個預設值）。
- 不做：金流、S2 下單（對所有攝影師都維持 `GUEST_ORDERS=off`）、自助改密碼寄信、訂閱收費、
  攝影師之間共用專案、團隊成員。

## 現況（讀程式碼確認過）

- 攝影師身分只有一把 `PHOTOGRAPHER_TOKEN`（`isAdminToken`，31 處呼叫），所有 admin 路由都用常數
  `DEFAULT_PHOTOGRAPHER_ID`（60 處）。平台方是另一把 `OPERATOR_TOKEN`（`isOperatorToken`），兩把不得相同。
- 資料表 `projects`、`studio_settings`、`products`、`orders` 已有 `photographer_id`，目前全是 `'default'`。
  `studio_settings.photographer_id` 是主鍵。
- **名稱衝突**：既有 `users` / `permissions` / `sessions` 三張表是**舊的客人帳號系統**（客人註冊、攝影師核准、
  `folder_path`），不是攝影師。新帳號要用新表，不重用、不改它們。
- 既有密碼雜湊（`hashPassword`）是「單次 SHA-256 + salt」，太弱。新帳號用 **PBKDF2-SHA256**（WebCrypto，
  Workers 內建），迭代數寫進雜湊字串以便日後調高；舊客人帳號不動。
- R2 只有一個 bucket `imagepicker`，物件鍵就是資料夾路徑；Worker 自己的物件都以 `_` 開頭
  （`_books/`、`_thumbs/`、`_assets/`），`isInternalKey` 對外一律拒絕。R2 讀寫共 ~23 處
  （`env.imagepicker.get/head/list/put`）。
- Email（Cloudflare Email Routing）**尚未開通**，所以第一階段**不能靠 email 驗證或寄重設連結**。

## 設計

### 1. 帳號與登入（第 1 批）

新表（append-only，migration 手跑）：

```sql
CREATE TABLE photographers (
  id            TEXT PRIMARY KEY,        -- 'default' 保留給現有資料；新帳號為隨機短 id
  email         TEXT NOT NULL UNIQUE,    -- 小寫；未驗證，只當登入名與聯絡
  password_hash TEXT NOT NULL,           -- pbkdf2$<iters>$<salt>$<hash>
  display_name  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | active | suspended
  created_at    TEXT NOT NULL,
  approved_at   TEXT,
  last_login_at TEXT
);
CREATE TABLE photographer_sessions (
  token_hash      TEXT PRIMARY KEY,      -- 存 SHA-256(token)，資料庫外洩也拿不到可用 token
  photographer_id TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
```

- 登入 `POST /api/photographer/login` → 回 session token（`Authorization: Bearer`，與現有 `js/auth.js`
  同一條路徑，不放 URL）。`status != 'active'` 一律拒絕，且回應**不透露**帳號是否存在。
- **`PHOTOGRAPHER_TOKEN` 繼續存在，對應 `photographer_id = 'default'`**（Tim 自己的帳號、既有資料不動）。
  新的統一函式 `resolvePhotographer(request, env)` → `{id} | null`，取代 `isAdminToken`。
  **身分只來自它的回傳值，永遠不讀 request body／query／header 裡的 photographer_id。**
- 註冊 `POST /api/photographer/register` → 建 `pending` 帳號。防濫用：Cloudflare Turnstile（不需 email）+
  依 IP 限速 + email 唯一。回應一律「已收到，等待審核」。
- 審核：`operator.html` 新增「待審核攝影師」清單（已有 `OPERATOR_TOKEN` 保護）：核准／拒絕／停用。
  因為沒有 email，**新申請靠 operator 頁的紅點數字提醒**，不寄信。
- 忘記密碼：第一階段由 operator 在頁面上「重設為臨時密碼」，Tim 私下告知。email 開通後再做連結。
- 停用（suspended）要立刻生效：每個請求都查 `status`，並刪除該帳號所有 session。

**第 1 批實作（2026-10-08）**：migration `worker/migrations/2026-10-11-photographers.sql`（5 句，可重跑），
多一個欄位 `studio_note`（選填，工作室名稱／網站，≤300 字，給審核判斷）與一張限速表
`photographer_signups`（每 IP 每小時 5 次，存 IP 的 SHA-256）。註冊只有 `PHOTOGRAPHER_SIGNUP = "on"`
且設了 Secret `TURNSTILE_SECRET` 才開，其餘一律 403 `registration_closed`。路由：
`POST /api/photographer/register|login|logout`、`GET /api/photographer/me`；operator：
`GET /api/operator/photographers`、`POST …/:id/approve|reject|suspend|unsuspend|reset-password`。
`resolvePhotographer` 這批**只**給 `/me` 用：攝影師 session 打不開任何既有路由（有測試鎖住），
`PHOTOGRAPHER_TOKEN` 對應 `default` 留到第 2 批。登入沒有限速（PBKDF2 10 萬次本身是成本），第 5 批開放前再評估。

### 2. 資料隔離（第 2 批）

- 所有 `/api/admin/*`、`/api/upload`、`/api/books` 等攝影師路由：`const who = await resolvePhotographer(...)`，
  所有查詢與寫入的 `WHERE` 都帶 `photographer_id = who.id`。別人的資源回 **404**（不是 403，不洩漏存在）。
- 新增一支 worker 測試：**用兩位攝影師逐條路由試跨帳號讀／改／刪**，全部必須 404 且資料不變。
  另一支測試掃 `worker.js`，不允許新的 `DEFAULT_PHOTOGRAPHER_ID` 出現在 admin 路由以外的地方
  （做法比照現有「只有 `UPDATE revision_requests` 能設 `resolved_at`」的掃描測試）。
- 客人端路由（選片連結、`pickFinals`、輪次縮圖）一律用 **`project.photographer_id`**（連結所屬專案），
  不用 request、不用常數。`docs/guest-shop.md` 已列出 `orderLines` 與訂單查詢仍用常數的分岔點，一併修。
- `OPERATOR_TOKEN` 的路由不變；operator 看得到所有攝影師的帳號清單，但**看不到他們的專案內容**。

### 3. R2 路徑（第 3 批）

- **不搬現有資料**。`default` 的物件維持原位；其他攝影師的所有物件放在 `_t/<photographer_id>/` 底下
  （例如 `_t/ab12cd/2026-婚禮/IMG_001.jpg`、`_t/ab12cd/_thumbs/400/…`）。
- 因為 `_` 開頭本來就是內部命名空間（對外拒絕、列表隱藏），`default` 既有的列表與物件路由天然看不到
  `_t/`，不需要改規則。
- 所有 R2 讀寫改走單一入口 `r2Key(photographerId, logicalKey)`：`default` 原樣回傳，其他人加前綴。
  **邏輯鍵**（客人、前端、分享連結快照看到的）不含前綴；前綴只在 R2 邊界加上。
  `isInternalKey` 檢查在邏輯鍵上做、在加前綴**之前**，攝影師送來的鍵不可能自己寫出 `_t/…`。
- 縮圖、`_books/`、`_assets/` 同樣走 `r2Key`。分享連結／選片紀錄存的是邏輯鍵，所以現有資料不受影響。
- 列表（`list`）用 `prefix` 加上前綴再去掉，確保一位攝影師永遠列不到另一位的鍵。

### 4. 每人設定與通知（第 4 批）

- `studio_settings` 本來就以 `photographer_id` 為主鍵：工作室名稱、logo、預設選張數、連結訊息範本
  自然分開。新攝影師第一次進設定頁時建立一列。
- **通知信收件人**：目前寄給固定的 `PHOTOGRAPHER_EMAIL`（選片、修改、興趣、訂單 4 處）。改成讀
  `studio_settings` 的新欄位 `notify_email`（沒填就不寄，不退回 Tim 的信箱）。`default` 仍可用環境變數。
  Email 還沒開通前，新攝影師靠 `dashboard` 的待處理數字看通知。
- 每位攝影師的「我有興趣」只通知該專案的攝影師。
- 平台商品目錄（`platform_products`）是平台方共用的，所有攝影師看到同一份；攝影師自己的 `products` 仍分開。
- 每位攝影師的 `GUEST_ORDERS` 一律視為 off（沒有 per-studio 開關，直到金流決定）。

### 5. 開通與試用（第 5 批）

- 註冊頁（新）、登入頁改成 email + 密碼（保留舊 token 入口給 Tim）。
- Tim 手動核准第一位真實攝影師，跑一個真實案子，再決定是否放寬自由開通。
- 180 天自動刪除：註冊頁與設定頁都要明講「照片 180 天後自動刪除，請自行保留原檔」，
  專案頁顯示倒數（backlog 的 180-day countdown 這時一併做）。

## 批次與風險

| 批 | 內容 | 風險 | 合併後 `default` 行為 |
|---|---|---|---|
| 1 | 帳號表、註冊／登入、`resolvePhotographer`、operator 審核頁 | 高（身分） | 不變 |
| 2 | admin 路由改用身分、跨帳號測試 | 高（權限） | 不變 |
| 3 | R2 `r2Key`、`_t/` 前綴 | 高（資料／路徑） | 不變 |
| 4 | 每人設定、`notify_email`、通知 | 中 | 不變 |
| 5 | 註冊頁 UI、180 天提示、第一位真實攝影師 | 中 | 不變 |

第 1~3 批都走高風險流程：opus、完整 TDD、約 10 個 mutant、安全審查。每批獨立合併，且在第 5 批之前
註冊入口不對外（路由存在但頁面不連結、Turnstile 未設時一律關閉）。

## 待 Tim 決定

1. 註冊要收哪些欄位（email、顯示名稱、密碼；要不要工作室名稱、網站連結讓你審核時判斷）。
2. Turnstile：需要在 Cloudflare 開一組 site key／secret（免費）。
3. 攝影師的儲存空間上限／檔案大小上限要不要在這階段就設（R2 費用由平台負擔）。
4. 停用或刪除攝影師時，他的 R2 檔案怎麼處理（建議：停用只擋登入；刪除要人工確認，180 天到期自然清）。
