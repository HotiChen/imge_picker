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
  （第 3 批安全審查後才真的成立，見 §3 的「停用／重設／刪除」：同一個 batch 撤掉他的 studio token，
  他專案的選片連結在解析時查擁有者狀態，停用期間失效、恢復後回來。）

**第 1 批實作（2026-10-08）**：migration `worker/migrations/2026-10-11-photographers.sql`（5 句，可重跑），
多一個欄位 `studio_note`（選填，工作室名稱／網站，≤300 字，給審核判斷）與一張限速表
`photographer_signups`（每 IP 每小時 5 次，存 IP 的 SHA-256）。註冊只有 `PHOTOGRAPHER_SIGNUP = "on"`
且設了 Secret `TURNSTILE_SECRET` 才開，其餘一律 403 `registration_closed`。路由：
`POST /api/photographer/register|login|logout`、`GET /api/photographer/me`；operator：
`GET /api/operator/photographers`、`POST …/:id/approve|reject|suspend|unsuspend|reset-password`。
`resolvePhotographer` 這批**只**給 `/me` 用：攝影師 session 打不開任何既有路由（有測試鎖住），
`PHOTOGRAPHER_TOKEN` 對應 `default` 留到第 2 批。

安全審查後補上（同一個 migration，Tim 尚未跑過，原地修改；現為 7 句）：
- 登入限速：`photographer_login_failures`，同一 IP（IPv6 以 /64 計）或同一 email 15 分鐘內失敗 10 次就回
  429 `too_many_attempts`（在 PBKDF2 之前）。每次嘗試先預留一列、成功時刪掉自己那列，所以並行猜測也過不了上限；
  成功不會清掉 IP 的失敗計數。代價：別人可以故意把某個 email 鎖 15 分鐘。
- 登入與重設密碼賽跑：session 只在帳號仍是 active **且密碼雜湊仍是剛驗證的那個**時寫入。
- 搶註 email：重複註冊仍回同一個 202，但在原帳號記 `dup_attempts` / `last_dup_at`；operator 頁顯示
  「此 email 有重複申請 N 次」，待審核清單提醒「核准前請用別的管道確認對方身分」。
- Email 只收可列印 ASCII（擋全形相似字、IDN、引號、反斜線、角括號）。註冊限速 IPv6 以 /64 計；待審核超過 200 筆時
  新註冊回 429 `registration_busy`；operator 清單最多 500 筆（`pending_count` 仍算全部）。
- Turnstile：5 秒逾時即失敗；設了 `TURNSTILE_HOSTNAME` 才檢查 hostname（`action` 尚未檢查）。

**第 2 批的前提**：第 2 批讓 session 打開任何既有路由**之前**，必須先做改密碼路由 + `must_change_password` 旗標
（重設後強制先改密碼，改之前 session 只能呼叫改密碼）。

**第 2a 批實作（2026-10-12，只有 Worker）**：migration `worker/migrations/2026-10-15-photographer-must-change-password.sql`
（1 句 `ALTER TABLE photographers ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0`，不可重跑）。
- `POST /api/photographer/change-password {current_password, new_password}` → `{ok:true, token}`（2b-0 起多 `token`，見下）。要有效 session（旗標在時也可）；
  新密碼規則同註冊（10–200 字元）且不得等於目前密碼；輸入錯誤 400（`invalid_current_password` / `invalid_password` /
  `same_password`，不跑 PBKDF2、不記次數）。目前密碼錯 403 `wrong_password`，和登入**共用** `photographer_login_failures`
  的同一組鍵（IP、email），所以偷到 session 也不能多猜；超過 429 `too_many_attempts`。對錯都跑兩次 PBKDF2（驗證＋新雜湊）。
  成功時一個 batch：新雜湊、清旗標、刪掉此帳號**所有** session（含目前這個），再發一個新 session，回應 `{ok:true, token}`
  （2b-0 改：改密碼前被偷的 token 一起失效，前端要換成新 token）；只在「目前 session 還活著、帳號 active、
  雜湊仍是剛驗證的那個」時寫入，否則 409 `password_change_conflict`、什麼都不寫（重設、停用、登出、另一次改密碼搶先時）。
  先驗 session 再讀 body（2b-0 改）：沒有有效 session 一律 401，不會先回 413 / 400。
- operator 重設密碼：新雜湊與 `must_change_password = 1` 同一句、同一個 batch 刪所有 session；回應多 `must_change_password: true`。
  operator 帳號清單每列多 `must_change_password`（true / false；migration 前為 null，清單照常）。
- 登入回應與 `GET /me` 多一個頂層欄位 `must_change_password`（true / false；migration 前為 null）。
- 守門在 `resolvePhotographer(request, env)`：回 `{who}` 或 `{refused}`；旗標為 true 時只放行
  `GET /api/photographer/me`、`POST …/logout`、`POST …/change-password`，其餘 403 `must_change_password`；旗標未知（欄位不存在）
  其餘一律 500 `password_change_unavailable`。2b-0 改：放行與否**由守門自己讀 request 的 method + 路徑**（空段落去掉，和路由器
  一樣），不再收呼叫端傳的 route id，所以把 `/me` 的呼叫抄到別條路由也繞不過。讀 `photographer_sessions` 的 SELECT 只能在
  `lookupPhotographerSession` 裡（測試掃描）。
- Migration 前：登入、`/me` 照常（旗標 null）；改密碼 500 `password_change_unavailable` 不寫入；operator 重設密碼
  **500 `must_change_unavailable`、什麼都不寫**（2b-0 改：原本會換密碼但不強制更換，臨時密碼可能永遠不換，比不重設更糟）。

### 2. 資料隔離（第 2 批）

**第 2b-0 批（身分入口與總開關，只有 Worker，無 migration）**：
- `requirePhotographer(request, env, {optional, unauthorized})` 是所有攝影師路由唯一的身分入口，回 `{who}` 或 `{refused}`：
  `PHOTOGRAPHER_TOKEN` → `{id:'default'}`（沒設 secret 一律拒絕）；攝影師 session → 經 `resolvePhotographer`（含改密碼守門）→ `{id}`；
  其他 → 該路由今天對「沒 token」的原回應。名為 `'default'` 的 session 一律當成沒登入：只有 token 才是 default。
  `isAdminToken` 只剩在 `requirePhotographer` 裡用（31 處呼叫全換掉）。
- 總開關 `photographerRoutesOpen(env)`：wrangler var `PHOTOGRAPHER_ROUTES`，只有 `"on"` 才開，其他值／打錯／沒設都算關。
  關的時候 session 打任何既有路由（`/api/photographer/*` 以外）得到的回應和不認得的 token **完全相同**（測試逐條比對 status + body），
  所以合併後誰的行為都不變。之後 operator 頁的開關只要改這個函式。
- `requireDefault(...)`：還沒按攝影師隔離的路由，非 default 一律 404、什麼都不寫，開關開著也一樣。每個呼叫點都標
  `// default-only until <批次>`（2b-1 專案／連結、2b-2 商品／訂單、2b-3 設定／儀表板、batch 3 碰 R2 或資料夾、retired 舊客人帳號），
  該批次合併時把它換成 `requirePhotographer` + `who.id`。訂單的 `photo_keys`（R2 鍵）另有 `defaultOnly(auth.who)` 標 `batch 3`，
  2b-2 打開商品／訂單區塊時這兩條仍關著。這批只有 `GET /api/auth/verify-admin` 對任何攝影師開放（只回 `{ok:true}`，沒有資料）。
- 測試 `worker/test/photographer-routes.test.mjs`：路由表 52 條（下限 45），用插樁的 worker.js 證明每個呼叫點都被表裡至少一條路由走到、
  標記和表一致；開關關（含 `ON`、` on`、`true` 等錯拼）／開兩種情況下非 default session 的回應與整個 D1 + R2 快照；
  `DEFAULT_PHOTOGRAPHER_ID` 依所在函式計數（精確數字，之後每批往下減）；不准從 body／query／header 讀攝影師 id。
  兩位攝影師 fixture 在 `worker/test/tenant-helpers.mjs`（`seedPhotographer`、`twoTenants`、`snapshot`），給 2b-1..3 用。
- 安全審查後補上（同批）：
  - **前門閘**（`export default fetch` → `routeRequest`）：`photographerOnlyPath` 列出只有攝影師能到的路徑（`/api/admin/*`、
    `/api/shares/minted*`、`/api/shares/:t/revoke*`、`/api/auth/studio-token`、`/api/auth/verify-admin`）。這些路徑在任何 handler
    跑之前先問身分，沒有就回該路由原本的 401，handler 根本不會執行；handler 回應後，若這個 request 沒呼叫過
    `requirePhotographer` / `requireDefault`（per-request `GUARDED`），回應換成 401。所以新路由忘了守門、或自己比對 token，
    都會失敗關閉。限制：用 default token 打一條「自己比對 token」的新路由時，handler 的寫入已經發生，只是回應變 401
    （匿名或其他攝影師到不了 handler）。書、`?list=`、物件、上傳這些也接分享連結的路由不在前門，自己用 `optional` 守。
  - 身分每個 request 只查一次（`identify` 的結果按 request 快取，前門和路由共用）。
  - `isAdminToken` 改成常數時間比對（`sameSecret`），沒設或空字串的 secret 一律 false。
  - 名為 `'default'` 的 session（不論有沒有 must_change 旗標）在所有路由一律 401，含分享連結也到得了的路由。
  - 分享連結也到得了的路由：查 session 時 D1 出錯，不會讓帶分享連結的訪客 500，改當匿名、照連結檢查走；只有攝影師能到的路由照樣丟錯。
  - `PUT /api/admin/orders/:id` 只有 body 帶 `lines` / `photo_keys` 時才是 default-only（batch 3），只改備註、折扣不受影響（2b-2 生效）。
  - 測試：`photographer-route-gate.test.mjs`（審查的 PoC：注入沒守門／自己比對 token 的路由；掃 worker.js 裡所有 `/api/...`
    路徑逐一以各種身分、五種 method 打；`PHOTOGRAPHER_TOKEN` 只能出現 2 次；`isAdminToken` 不得被別名或當值傳遞）。
    `photographer-routes.test.mjs` 多了 `scoped` 標記（`// scoped to the caller`，必須用 `requirePhotographer`），2b-1 只要換標記；
    並禁止 `?? / || DEFAULT_PHOTOGRAPHER_ID` 與 `who?.`。

**第 2b-1 批（專案路由按攝影師隔離，只有 Worker，無 migration）**：
- 改成 `requirePhotographer` + `who.id`（標 `// scoped to the caller (who.id)`）：`GET /api/admin/projects`、
  `GET / PATCH / DELETE /api/admin/projects/:id`、`POST …/:id/reset-seat | start-retouch | reopen | archive | unarchive | links | confirm`。
  每句 SELECT / UPDATE / DELETE 都帶 `photographer_id = who.id`。別人的專案 = 不存在的 id：同樣 404、同樣 body、
  **同樣的 SQL 語句序列**（測試逐條比對），D1 + R2 全快照不變。清單只列自己的（沒有就是空清單，不是 404）。
- **default 不是超級使用者**：`PHOTOGRAPHER_TOKEN` 只看得到 `photographer_id = 'default'`，對別人的專案一樣 404。
- `PUT / POST /api/admin/projects/:id`（405）：標 `open`，任何攝影師、任何 id 都回同一個 405，不查 D1。
- PATCH 先驗 body 再查專案：B 送壞 body 到 A 的專案得 400，和不存在的 id 完全相同（不洩漏存在），沿用原本順序。
- 語句內再檢查擁有者（防與刪除／轉移賽跑）：`links` 的 INSERT、`resolveRevisionsIfConfirmed`（admin 與客人 confirm 都傳專案擁有者）、
  `extraPickWrites(env, ownerId, …)`（系統單以擁有者查、以擁有者寫）、`latestSubmission(env, id, ownerId)`
  （別人的專案讀起來像沒有送出，所以 start-retouch 的語句序列和不存在的 id 一樣）。
- 仍是 default 專用（batch 3，碰 R2 資料夾）：`POST /api/admin/projects`（建立）、`deliver`、`undeliver`。
  **所以非 default 攝影師目前無法建立專案**，只能管理「被指派」給他的專案（現在沒有路由會指派，測試直接改 D1）。
  （第 3 批已改成 scoped，見 §3 的 3 notes。）
- 通知信：`mailsDefaultInbox(project)`，五個寄信函式第一行都問它；`project.photographer_id !== 'default'` 就不寄、不警告
  （選片送出、要求修改、修改輪次、客人確認、我有興趣、客人訂單）。選片送出因此留在該攝影師的未通知數字裡。
- 測試：`worker/test/project-scope.test.mjs`（每條 scoped 路由 × 兩個方向 × 各自正向控制、競態、通知、客人端不讀請求裡的攝影師 id）。
- 未處理（之後的批次）：公開 logo、設定／儀表板（2b-3 已處理，見下）。（`guestOrdersEnabled` 與商品／訂單見 2b-2。）

**第 2b-2 批（商品／訂單按攝影師隔離，只有 Worker，無 migration）**：
- 改成 `requirePhotographer` + `who.id`（整個區塊一個呼叫點，標 `// scoped to the caller (who.id): products and orders`）：
  `GET / POST /api/admin/products`、`GET /api/admin/platform-products`、`POST …/products/from-platform`、`PUT …/products/:id`、
  `POST …/products/:id/retire | restore`、`GET /api/admin/orders`、`GET / POST /api/admin/projects/:id/orders`、
  `PUT /api/admin/orders/:id`、`POST …/orders/:id/erase-contact | payment | status`。別人的商品／訂單／專案 = 不存在的 id：
  同樣 404、同樣 body、同樣的 SQL 語句序列，D1 + R2 全快照不變；default token 一樣看不到別人的。清單只列自己的。
  方法不對的 405 在查 id 之前決定，對任何 id 都一樣。
- 平台目錄（`platform_products`）共用唯讀；`adopted_product_id` 與「已採用 409」都只看自己的；採用的商品是採用者自己的。
- 輔助函式不再有預設擁有者：`readProducts(env, photographerId, id)`、`readOrders(env, photographerId, …)`、`readOrder(env, photographerId, id)`、
  `orderLines(…, {photographerId})`（沒傳就丟錯）、`catalogueWrites(env, t, ownerId, …)`（平台表傳 null）。
- 語句內再檢查擁有者：商品選項的 UPDATE / INSERT（`catalogueWrites`）、採用時的選項 INSERT、訂單品項的 INSERT（新增訂單）
  與 DELETE / UPDATE / INSERT（改訂單，`same` 閘多帶 `photographer_id`）。
- 仍是 default 專用（batch 3，`photo_keys` 是 R2 鍵）：`POST /api/admin/projects/:id/orders`（整條），以及 `PUT /api/admin/orders/:id`
  body 帶 `lines` 或 `photo_keys` 時。所以非 default 攝影師目前**不能新增訂單或改品項**，只能看、改備註／折扣、收款、改狀態、清聯絡資料。
  （之後另一個 commit 把所有訂單路由對非 default 暫停成 404；第 3 批拿掉 `photo_keys` 閘，暫停仍在。）
- `guestOrdersEnabled(env, project)`：專案不是 default 的一律 off（不論 `GUEST_ORDERS` on / pilot）：`/api/pick/shop` 的 `ordering`
  為 null、`POST /api/pick/orders` 403 `ordering_disabled`。客人看自己的訂單、取消 `requested` 的訂單不受開關影響（設計如此）。
- 客人商店與「我有興趣」只讀連結專案攝影師的商品（原本就是 `project.photographer_id`，這批加測試）。
- 2b-1 安全審查補上：`POST /api/shares/:token/revoke` 只撤「沒有專案的連結」或「呼叫者自己專案的連結」，別人的 = 不存在的 token（404）；
  這條仍是 default 專用（batch 3）。另補兩條行為測試：客人確認時解決該專案（非 default）的修改要求、B 改名自己的專案會改到 B 的連結名稱。
- 測試：`worker/test/product-order-scope.test.mjs`。

**第 2b-3 批（設定／logo／儀表板按攝影師隔離，只有 Worker，無 migration）** — 2b-3 notes：
- 改成 `requirePhotographer` + `who.id`（標 `// scoped to the caller (who.id)`）：`GET /api/admin/stats`、`GET / PUT /api/admin/settings`、
  `PUT / DELETE /api/admin/settings/logo`。每句 SELECT / INSERT / UPDATE 都綁 `who.id`；default token 一樣只讀寫 `'default'` 那列。
  B 第一次 PUT 設定時建立自己的 `studio_settings` 列（主鍵本來就是 `photographer_id`，**不需要 migration**）；body 裡的 `photographer_id` 照舊忽略。
  B 沒有設定列時 GET 讀到全 null、`has_logo:false`；儀表板只算自己的專案與訂單（`ORDER_SCOPE_SQL` 本來就以擁有者 join），沒有就全是 0。
  晚到的欄位（`default_extra_max` / `transfer_info` / `pick_link_message`）在 migration 前照舊：讀為 null、寫入回 500 `*_unavailable` 且什麼都不寫，對每位攝影師都一樣。
- **logo 存在 D1（`studio_settings.logo` BLOB），不在 R2**：沒有任何 R2 鍵，所以沒有 default 前綴碰撞的問題（第 3 批不用管 logo）。
  所有 logo 讀取走 `readLogo(env, photographerId)`，呼叫端各自給擁有者。
- 新增 `GET /api/admin/settings/logo`：呼叫者自己的 logo（設定頁預覽用），`private, no-store`、`Vary: Authorization`；沒有 = 404，和誰都沒有時完全相同。
  要帶 Authorization，所以 `<img src>` 不能直接用：settings.html 要改成 fetch → blob（前端，尚未改）。
- 新增 `GET /api/pick/logo?t=<選片連結>`（或 `X-Share-Token`）：連結所屬專案的 `project.photographer_id` 的 logo，絕不讀 request 裡的 id。
  任何有效連結都可（挑選人、協作者、檢視者，和 `/state` 的 studio 區塊一致）；連結無效／撤銷／專案封存 → 401（同 pick 區塊）；非 GET → 405；
  該攝影師沒有 logo → 404，和 default 專案沒設 logo 時完全相同（不會退回 default 的 logo）。`Cache-Control: private, max-age=300`（URL 帶連結，不給共用快取）。
  客人頁（`js/pick.js` 三處）要改打這條（前端，尚未改）。
- 舊的公開 `GET /api/studio/logo` 保留，**只給 default**（`DEFAULT_PHOTOGRAPHER_ID` 在 `routeRequest` 剩 9 處：batch 3 的建立專案／交件／取消交件，和這條；第 3 批後只剩這條）。
  B 的 logo 永遠不會從這裡出去。前端全部改走上面兩條後可以移除。
- 測試：`worker/test/settings-scope.test.mjs`（兩個方向的讀寫、body 帶 id、壞 body 不寫、logo 上傳／刪除互不影響、兩條 logo 讀取路由、
  `/api/studio/logo` 仍只給 default、stats 各算各的、migration 前、開關關時 401）；`photographer-routes` 路由表這 6 條改 `scoped`
  （多了 `GET …/settings/logo`），`photographer-route-gate` 爬蟲允許 B 在這三條路徑拿到 200 / 405 / 415，但只能寫自己那列 `studio_settings`。
- 不在這批：`notify_email`（第 4 批）；前端改打新 logo 路由。

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

**第 3 批實作（2026-10-12，只有 Worker）— 3 notes**：migration `worker/migrations/2026-10-17-share-token-owner.sql`
（1 句 `ALTER TABLE share_tokens ADD COLUMN photographer_id TEXT`，**合併前**由 Tim 在 D1 Console 手跑；重跑出現
「duplicate column name」代表已經跑過）。`PHOTOGRAPHER_ROUTES` 仍是 `"off"`。
- **單一入口 `bucketFor(env, photographerId)`**（回 `{get, head, put, list}`）：`default` 鍵不變，其他人加 `_t/<id>/`。
  `env.imagepicker` 只准出現在它裡面（`r2-isolation.test.mjs` 掃描）。id 必須符合 `^[0-9a-z][0-9a-z_-]{0,63}$`
  （實際的 id 是 16 個小寫 hex），否則在任何讀寫之前丟錯（Worker 500），不會拼出路徑。
  - **`_t/` 對所有人保留**，在邏輯鍵上、加前綴之前、在 helper 裡檢查（`isTenantKey`：`_t` 或 `_t/…`）：get / head 當作不存在
    （null → 404，和沒有這個物件完全相同）、list 回空、put 丟錯（上傳路由先回 400 `invalid_key`）。default 也一樣：
    default 的鍵沒有前綴，若讓 default 寫 `_t/B/x` 就等於寫 B 的物件。`%5Ft/`、`%2F`、`..`、反斜線（URL 先正規化成 `/`）
    都試過；`../`、`//` 開頭這類只是 R2 的字面鍵，落在寫入者自己的前綴裡，碰不到別人。
  - list 回來的鍵去掉前綴、只留呼叫者自己的；default 的 list 也濾掉 `_t/`（原本 `_` 開頭的資料夾就不顯示，這是第二道）。
    分頁（cursor）照舊跟到底。
- **誰的檔案**：攝影師路由 → `who.id`；選片連結（`?list=`、物件、縮圖、下載、`/api/pick/rounds/:id/photo`、列印訂單的 `head`）
  → 連結專案的 `project.photographer_id`；studio token → 該列的 `share_tokens.photographer_id`（NULL = default）。
  都在 `shareOwner(share)`，**從不讀 request**。相本連結、舊客人 session token 沒有其他擁有者，算 default。
- **改成 `requirePhotographer` + `who.id`**（標 `// scoped to the caller (who.id)`）：`POST /api/auth/studio-token`、
  `POST /api/admin/projects`（建立；`studioDefaultExtraMax` 也讀呼叫者自己的）、`deliver` / `undeliver`、`GET /api/shares/minted`、
  `POST /api/shares/minted/revoke-all`、`POST /api/shares/:token/revoke`、上傳 `PUT`、`?list=`、物件 GET（含 `?w=`、`?download=1`）。
  訂單的兩個 `photo_keys` 閘（`default-only until batch 3 (photo_keys)`）拿掉了：photo_keys 是呼叫者自己專案資料夾裡的邏輯鍵
  （`orderLines` 對專案檢查，不讀 R2）。**訂單路由本身對非 default 仍全部暫停 404**（`ORDER_ROUTES_PAUSED`，沒動）。
- **studio token 一人一列**：「同時只留一列」變成每位攝影師一列；發／撤 X 的不會碰到 Y 的列。`minted` 只列自己的
  （default 另外看得到舊客人 session token），`revoke-all` 只撤自己的。`revoke` 單一 token：有專案的連結看專案擁有者
  （不管該列自己的欄位寫什麼），沒專案的看 `photographer_id`（NULL = default），條件寫在 UPDATE 裡（專案中途換手也不會撤到）；
  別人的 = 不存在的 token（同樣 404、同樣 body、同樣的 SQL 語句）。
- **migration 前**：default 一切照舊（舊語句）；非 default 的 `studio-token` / `minted` / `revoke-all` 回 500
  `share_owner_unavailable`、什麼都不寫；`revoke` 照專案判斷，沒專案的 token 只有 default 能撤。
- **仍是 default 專用**：`/api/books/*` 與相本的 `_books/` 物件（標 `// default-only until books`，走 `bookBucket(env)` = default 的
  bucket）：相本與相本連結還沒有擁有者，要另一個 migration；非 default 一律 404。舊客人帳號路由（`default-only until retired`）。
  `routeRequest` 裡的 `DEFAULT_PHOTOGRAPHER_ID` 只剩公開的 `/api/studio/logo`。
- **default 行為的唯二差別**：default 上傳 `_t…` 鍵改回 400、讀 `_t/…` 回 404（以前這個命名空間不存在）。其餘逐條相同（舊測試全過）。
- 測試：`worker/test/r2-isolation.test.mjs`（A = default、B、C 兩位非 default，每條 R2 路徑：上傳落點、保留鍵與各種編碼、list 去前綴
  與分頁、物件／縮圖退回自己的原檔／下載／Range／304、studio token、B 專案的選片連結即使同一邏輯鍵也只讀 B 的、交件閘、
  輪次縮圖、建立專案、不安全的 id、原始碼掃描）；`worker/test/r2-studio-token.test.mjs`（migration、一人一列、minted / revoke-all /
  revoke 擁有權含語句序列與競態、migration 前）；`product-order-scope.test.mjs` 補 2b-2 審查的三個缺口（付款／清聯絡資料／狀態的
  語句內擁有者競態、商品換手後商品列本身不變、B 對 C 跑每條商品／訂單路由）。
- **Tim 要確認**：(1) 合併前在 D1 Console 跑 `2026-10-17-share-token-owner.sql`，再用
  `SELECT photographer_id FROM share_tokens LIMIT 1` 確認欄位在；(2) 合併後用自己的帳號在 admin / 選片頁看照片、縮圖、下載、上傳、
  相本編輯器都正常（default 路徑不變）；(3) `PHOTOGRAPHER_ROUTES` 仍 `"off"`，開之前要安全審查這批。
- 已知限制（之後處理）：R2 180 天 lifecycle 仍是整桶規則；相本擁有權要另一批。
  （原本的「停用只刪 session，studio token 還能讀 12 小時」已在下面的安全審查修掉。）

**第 3 批安全審查後補上（`claude/r2-hardening`，只有 Worker，無 migration）**：
- **停用／重設密碼／刪除**：operator 的 `suspend`、`reset-password`、`reject`（唯一的刪除）在刪 session 的**同一個 batch**
  撤掉該帳號所有還活著的 studio token（`kind = 'studio' AND photographer_id = <id>`）。撤銷條件是帳號那句跑完後的**最終狀態**
  （停用：已是 suspended；重設：帳號仍存在；reject：帳號已不存在），不是「這次有沒有改到」：所以 pending 帳號被按停用、active 帳號被按 reject（409）
  都不撤；但對已停用的帳號再按停用（409）、reject 不存在的 id（404）也會跑撤銷，無害（這些帳號本來就不可能有能用的 token）。
  default 沒有帳號列，永遠不碰（NULL 或字面 `'default'` 的列都不會）。
  恢復（unsuspend）**不會**把 studio token 還回來（12 小時的憑證，重新登入再發一個就好）。share-token-owner migration 前沒有欄位、
  也不可能有非 default 的 studio token，batch 就不帶這句。
- **選片連結（Tim 的決定：可逆）**：`resolveShareToken` 在**本來就要跑的那句 SELECT** 裡帶一個子查詢，看連結擁有者（選片連結 = 專案的
  `photographer_id`；其他連結 = 該列的 `photographer_id`）是否為 `active` 帳號（熱路徑不多一次 D1 來回）。default（NULL 或 `'default'`）永遠算有效，
  不看帳號表。停用、待審核、帳號被刪掉的擁有者 → 連結解析為 null，回應和不存在的連結**完全相同**；連結列本身沒被撤，所以 unsuspend 後立刻恢復。
  封存／專案不存在的行為不變。帳號表或擁有者欄位不存在時（migration 前）退回舊語句：default 照常，其他擁有者一律失效。
- **上傳 PUT 是最後的 fall-through，只收得到照片鍵**：`PUT /`、`/_assets/`、只有斜線的鍵 → 400 `invalid_key`；鍵（去掉 `_assets/` 之後）
  第一段是 `api`（含 `%61pi`、`//api/…`）→ 404；不是合法 percent-encoding → 400（原本 500）。都不寫。先驗身分，匿名仍是 401。
  `2026/api/x.jpg`、`apiary/…` 這類照常。測試：`worker/test/upload-paths.test.mjs`。
- **上傳只收照片、物件一律不能當網頁**：上傳 PUT 看鍵的副檔名**和** Content-Type（`uploadContentType`）。副檔名只收 upload.html 的
  `IMAGE_EXTS`（jpg/jpeg/png/webp/avif/gif/heic/heif/tif/tiff/bmp，大小寫不拘），型別看副檔名（參數、大小寫去掉後存）：
  選片格線會列出的 .jpg/.jpeg/.png/.webp/.avif 只收 jpeg/png/webp/avif 四種（所以格線、縮圖退回原檔、燈箱拿到的永遠是行內圖片，不會變下載）；
  .gif 只收 image/gif；HEIC/HEIF/TIFF/BMP 收自己的型別或 `application/octet-stream`（瀏覽器常不知道它們的型別，upload.html 就送這個）。
  這些格式 `?list=` 本來就不列，只當檔案保存、以下載送出。沒帶型別時存副檔名的型別。
  縮圖 `_thumbs/<數字>/<照片鍵>.thumb` 只收 jpeg/png/webp/avif（沒帶 = jpeg，和以前一樣）。其餘（text/html、SVG、XML、JS、text/plain、
  沒有副檔名、`.thumb` 不在 `_thumbs/` 下）一律 415 `unsupported_type`、不寫。物件路由的**每個**回應（200、Range 206、304、`?w=` 縮圖、
  `?download=1`，攝影師或任何連結）都帶 `X-Content-Type-Options: nosniff` 與 `Content-Security-Policy: default-src 'none'; sandbox`；
  存的型別不是 jpeg/png/webp/avif 的（舊的上傳、HEIC/TIFF/GIF/BMP 原檔）改成 `application/octet-stream` + attachment。
  前端沒改：upload.html 遇到 415 會顯示「HTTP 415」。舊測試用字串 body（`Request` 自動標 `text/plain`）上傳的幾條改成帶照片型別。
  測試：`worker/test/upload-types.test.mjs`。
- 測試：`worker/test/photographer-suspend-links.test.mjs`。三個舊測試把專案直接改成 `'other'`（沒有帳號）來證明「看專案擁有者」，
  現在要先建一個 active 的 `'other'` 帳號；`guest-shop-read` 的「專案沒有攝影師」從空商店改成 401（連結根本不解析，更嚴）。

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
