# D1 備份、還原與 migration 檢查

D1 `imagepicker-db` 存著所有專案、選片、交件、訂單，還有**客人的姓名、email 和 share token（選片連結）**。
這份文件說明三件事：

1. **每週自動備份**到你的 Google Drive（GitHub Actions：`D1 weekly backup`）
2. **D1 Time Travel**：Cloudflare 內建的「時光機」，把資料庫倒回過去某個時間（GitHub Actions：`D1 time travel`）
3. **檢查 migration 是否都跑過**（在 D1 Console 貼一段查詢）

> 這個 repo 是**公開的**：任何人都能看 GitHub Actions 的 log。所以備份一定加密、log 不印任何資料內容，
> 也不使用 GitHub 的 artifact（公開 repo 的 artifact 任何登入的人都能下載）。

---

## 一、一次性設定（照順序做，只要做一次）

需要設定 4 個 GitHub secret。位置都一樣：
GitHub → `hotichen/imge_picker` → **Settings** → 左邊 **Secrets and variables** → **Actions** →
**New repository secret**（Name 填名稱、Secret 貼值 → **Add secret**）。

| Secret | 用途 | 已經有了嗎 |
|---|---|---|
| `CF_API_TOKEN` | 讓 GitHub 能匯出 D1 / 用 Time Travel | 有（部署在用），但**不確定有沒有 D1 權限**，見 (a) |
| `CF_ACCOUNT_ID` | Cloudflare 帳號 ID | 有 |
| `BACKUP_PASSPHRASE` | 備份檔的加密密碼 | 要新增，見 (c) |
| `RCLONE_CONF_B64` | 上傳 Google Drive 的授權 | 要新增，見 (b) |

### (a) Cloudflare API token 要有 D1 權限

1. 登入 Cloudflare → 右上角頭像 → **My Profile** → **API Tokens**。
2. 找到部署用的那把 token（GitHub 的 `CF_API_TOKEN` 就是它）→ **Edit**。
3. 在 **Permissions** 確認有一列 **Account · D1 · Edit**（名稱以 Cloudflare 頁面為準，重點是「D1」而且是可寫入的那個，
   不是只有 Read）。沒有就按 **Add more** 加上 → **Continue to summary** → **Update token**。
   - 改權限通常不會換 token 值，GitHub 的 secret 不用動。如果 Cloudflare 給了一個新的 token 值，
     就把 GitHub 的 `CF_API_TOKEN` 換成新的值（**Update secret**）。
4. 匯出（備份）和 Time Travel 都需要這個權限；沒有的話，workflow 會在「匯出 D1」那步失敗，訊息會提示 D1 權限。

### (b) 讓 GitHub 能把備份放進你的 Google Drive（rclone）

這一步要在你自己的電腦做一次（Mac 用內建的「終端機」App；Windows 用「PowerShell」）。

1. **下載 rclone**：到 <https://rclone.org/downloads/> 下載你電腦的版本（Mac：macOS；Windows：Windows 64 bit），解壓縮。
2. **打開終端機，進到 rclone 所在的資料夾**：
   - Mac：打開「終端機」，輸入 `cd ` （後面有空格），把解壓出來的資料夾拖進終端機視窗，按 Enter。
   - Windows：在解壓出來的資料夾空白處按住 Shift＋右鍵 →「在這裡開啟 PowerShell 視窗」。
3. **建立名為 `gdrive` 的設定**：輸入（Windows 把 `./rclone` 換成 `.\rclone.exe`）

   ```
   ./rclone config
   ```

   依序回答（題目編號每個版本不同，**看文字選**）：
   - `n`（New remote）→ name 輸入 **`gdrive`**（一定要這個名字）
   - Storage 選 **Google Drive**（輸入 `drive`）
   - `client_id`、`client_secret`：直接按 Enter 留空
   - `scope`：選 **`drive.file`**（只能看到 rclone 自己建立的檔案，比較安全；不要選完整的 `drive`）
   - `service_account_file`：Enter 留空
   - Edit advanced config：`n`
   - Use web browser to automatically authenticate：`y` → 瀏覽器會開 Google 登入，登入**要放備份的那個 Google 帳號**並按允許
   - Configure this as a Shared Drive：`n`
   - 確認：`y`，然後 `q` 離開
   - （進階：也可以用 `./rclone authorize "drive"` 只取得 token，再自己寫設定檔；用上面的 `rclone config` 比較不會出錯。）
4. **把設定檔轉成一行 base64，複製起來**：
   - Mac：`base64 -i ~/.config/rclone/rclone.conf | pbcopy`
   - Windows（PowerShell）：
     `[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:APPDATA\rclone\rclone.conf")) | Set-Clipboard`
   - 找不到檔案的話，`./rclone config file` 會印出設定檔的位置。
5. 到 GitHub 新增 secret **`RCLONE_CONF_B64`**，貼上剛剛複製的內容。
6. 注意：
   - 這個設定檔裡有 Google 的授權 token，**等於可以存取那個 Drive 裡 rclone 建立的檔案**。貼進 GitHub 之後，
     可以把電腦上的 rclone 設定刪掉（`./rclone config delete gdrive`）。
   - **不要自己先在 Drive 建 `imagepicker-backups` 資料夾**：`drive.file` 權限看不到你手動建的資料夾，
     rclone 會自己建一個同名的。第一次備份後它就會出現在「我的雲端硬碟」。
   - 以後如果備份在「先確認 Google Drive 連得上」那步失敗、訊息提到 token / invalid_grant，
     代表授權失效了（例如你在 Google 帳號撤銷了 rclone 的存取權）：重做這一節的 3～5。

### (c) 設定備份密碼 `BACKUP_PASSPHRASE`

1. 想一個**很長**的密碼（至少 16 個字元；建議用密碼管理器產生 30 字以上）。
2. 到 GitHub 新增 secret **`BACKUP_PASSPHRASE`**，貼上。
3. **把這個密碼另外存好**（密碼管理器、或寫在紙上收好）。**GitHub 存進去之後你再也看不到它；
   密碼遺失 = 所有備份都打不開，沒有任何辦法救回。**
4. 不要把這個密碼存在同一個 Google Drive 裡（備份和鑰匙放一起，等於沒加密）。
5. 換密碼：直接更新 secret。之後的新備份用新密碼；**舊的備份仍然要用舊密碼解**，舊密碼也要留著，
   直到舊備份都被輪替刪掉（約 3 個月）。

### (d) 手動跑一次，確認成功

1. GitHub → **Actions** → 左邊選 **D1 weekly backup** → 右邊 **Run workflow** → **Run workflow**。
2. 等它跑完（通常幾分鐘）。綠色勾勾 = 成功；紅色叉叉 = 失敗，點進去看哪一步紅了，訊息會說原因。
3. 成功時應該看到：
   - 「完整性檢查」：`完整性檢查通過（… bytes，核心表 6 張都在）`
   - 「還原演練」：`還原演練：載入 N 張表`，以及 `migration 檢查：0 項缺少`（如果有黃色 warning，
     表示正式庫少跑了某個 migration，見第四節）
   - 「上傳到 Google Drive 並核對」：`已上傳並核對：gdrive:imagepicker-backups/imagepicker-db-…sql.enc`
4. 打開 Google Drive，「我的雲端硬碟」裡應該多了 `imagepicker-backups` 資料夾和一個 `.sql.enc` 檔。
5. 之後每週日 18:17 UTC（台灣週一凌晨 02:17）自動跑。

**失敗會通知你嗎？** GitHub 會寄信，但要確認設定：GitHub 右上角頭像 → **Settings** → **Notifications** →
**System** 的 **Actions** 勾 **Email**，並選 **Only notify for failed workflows**。
- 手動跑的失敗通知寄給按下 Run 的人；排程跑的失敗通知寄給**最後修改這個 workflow 排程的人**
  （GitHub 的規則）。如果合併這個檔案的不是你的帳號，你可能收不到排程失敗的信：
  最簡單的確認法是之後每個月看一次 Actions 頁的 `D1 weekly backup` 是不是都是綠色。

---

## 二、每週備份做了什麼（給想知道的人）

`.github/workflows/d1-backup.yml`，每一步失敗都會讓整個 workflow 變紅，不會「靜靜地傳一個空檔」：

1. 檢查 4 個 secret 都有設（密碼至少 16 字）。
2. 安裝固定版本的 rclone（Ubuntu 24.04 官方套件，下載後比對 sha256）。
3. 先確認 Google Drive 連得上（避免匯出完才發現傳不上去）。
4. `wrangler d1 export imagepicker-db --remote` 匯出整個資料庫成 `.sql`（明文只存在 GitHub 的臨時機器上）。
   - **匯出期間 D1 會暫停回應查詢**（Cloudflare 的限制），所以排在半夜。資料量小時只有幾秒。
   - wrangler 會印出一個一小時有效、可以直接下載明文備份的網址：workflow 會把 log 裡所有網址遮掉。
5. **完整性檢查**：檔案至少 10 KB、有 `CREATE TABLE`、6 張核心表（projects、share_tokens、selections、
   pickers、submissions、studio_settings）都在、projects 至少有一筆資料。不通過就停，不加密不上傳。
6. **還原演練**：把備份檔載入一個全新的 SQLite 資料庫（D1 底層就是 SQLite），確認核心表都回來了，
   再跑一次第四節的 migration 檢查。只印表的數量與缺少的 migration 名稱，不印任何資料。
7. **加密**：`openssl` AES-256-CBC、PBKDF2 600000 次、隨機 salt，密碼只經環境變數傳入。
   加密後立刻試解一次、比對和原檔完全相同，才刪掉（`shred`）明文。
8. **上傳**到 `gdrive:imagepicker-backups/imagepicker-db-<UTC 時間>.sql.enc`，上傳後核對雲端檔案的大小和 MD5。
9. **輪替**：保留最新 12 份（約 3 個月）。更舊的、而且超過 90 天的才刪（Drive 會先移到垃圾桶，30 天內還能救回）。
   保險：只刪檔名完全符合 `imagepicker-db-YYYYMMDDTHHMMSSZ.sql.enc` 的檔案；資料夾裡最新的那份必須是這次剛上傳並核對過的，
   否則一份都不刪；一次最多刪 4 份。
10. 還原演練若失敗：備份照樣上傳（多一份總比沒有好），但整個 workflow 最後會變紅提醒你。
11. 不論成功失敗，最後清掉臨時機器上的明文與 rclone 設定。

---

## 三、還原

先分清楚兩種情況：

| 情況 | 用什麼 |
|---|---|
| 30 天內（免費方案可能更短）誤刪、改壞資料，想倒回某個時間 | **D1 Time Travel**（第三-1 節），不需要備份檔，最快 |
| 更久以前、或整個 Cloudflare 帳號出事 | **Google Drive 的備份檔**（第三-2 節） |

### 三-1、D1 Time Travel

**是什麼**：Cloudflare 對 D1 自動做的「時光機」，不用設定、不用另外付費。可以把整個資料庫倒回過去任一分鐘。
保留期間：依 Cloudflare 官方文件，**Workers 付費方案 30 天、免費方案 7 天**（以
<https://developers.cloudflare.com/d1/reference/time-travel/> 為準，待你確認自己是哪個方案）。

**重要**：還原會**覆蓋整個正式資料庫**——指定時間之後的所有新資料（新的選片、送出、交件、訂單…）都會不見，
正在進行的查詢會被中斷。客人在那段時間做的事要重做。

**bookmark** 是資料庫某個時間點的代號（一串英數字和 `-`）。

#### 先看（安全，只讀）

GitHub → **Actions** → **D1 time travel** → **Run workflow**：
- mode：`info`
- timestamp：可以留空；或填一個時間，看那個時間對應的 bookmark
- 其他留空 → **Run workflow**

跑完點進去，「查看目前的 bookmark」那步會印 `目前（還原前）的 bookmark：…`。
**建議的演練方式：平常就只跑 info**，確認 token 權限正常、看得到 bookmark。不要為了演練去還原正式庫。

#### 真的要還原到某個時間

1. 先決定時間點，**要寫時區**，例如台灣時間 2026 年 10 月 21 日上午 9 點 30 分：`2026-10-21T09:30:00+08:00`
   （沒寫 `+08:00` 或 `Z` 會被拒絕，避免差 8 小時）。
2. **Run workflow**：
   - mode：`restore`
   - timestamp：上面的時間
   - bookmark：留空
   - confirm：一字不差輸入 `RESTORE imagepicker-db`
3. 跑完看 log 或該次執行的 Summary：
   - 「目前（還原前）的 bookmark」：還原**之前**的狀態
   - 「還原完成」區塊裡的 **previous bookmark**：**這就是反悔用的鑰匙，請抄下來**
4. 輸入有任何不對（格式、超過 30 天、在未來、confirm 打錯），workflow 會在「驗證輸入」就停下，不會動到資料庫。

#### 反悔（還原回去）

**Run workflow**：
- mode：`restore-bookmark`
- bookmark：剛剛抄下的 **previous bookmark**（或「還原前的 bookmark」）
- timestamp：留空
- confirm：`RESTORE imagepicker-db`

### 三-2、用 Google Drive 的備份檔還原

> **永遠不要直接蓋掉正式庫。** 先還原到一個新的「測試用」D1，確認內容對了，再決定怎麼做
> （通常是請 Claude 幫你把需要的資料搬回去，或在確認後切換）。

這一段需要在電腦上用終端機（Mac「終端機」／Windows 用 Git for Windows 附的「Git Bash」，它內建 openssl），
也需要 Node.js 才能用 `npx wrangler`。不熟的話，可以請 Claude 在旁邊一步一步帶你做。

1. **下載**：到 Google Drive 的 `imagepicker-backups`，下載你要的那份 `imagepicker-db-…sql.enc`。
2. **解密**（在下載的資料夾開終端機）：

   ```
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -in imagepicker-db-XXXX.sql.enc -out restored.sql
   ```

   它會問 `enter AES-256-CBC decryption password:`，輸入 `BACKUP_PASSPHRASE`（打字時畫面不會顯示）。
   - 密碼錯會顯示 `bad decrypt`，不會產生正確的檔案。
   - 參數必須和加密時完全一樣（`-aes-256-cbc -pbkdf2 -iter 600000`）。
   - Mac 內建的 openssl 其實是 LibreSSL，**是否支援 `-pbkdf2 -iter` 待驗證**；不行的話先裝 Homebrew 再
     `brew install openssl@3`，用 `$(brew --prefix openssl@3)/bin/openssl` 代替上面的 `openssl`。
   - **`restored.sql` 是明文，含客人個資**：用完就刪，不要上傳到任何地方、不要寄信。
3. **建立測試用的 D1 並匯入**：

   ```
   npx wrangler login
   npx wrangler d1 create imagepicker-restore-test
   npx wrangler d1 execute imagepicker-restore-test --remote --file=restored.sql
   ```

   完成後在 Cloudflare 的 D1 頁面打開 `imagepicker-restore-test`，用 Console 查資料是否正確
   （例如 `SELECT id, title FROM projects ORDER BY created_at DESC LIMIT 10;`）。
4. 確認完，**刪掉測試庫**（D1 頁面 → `imagepicker-restore-test` → Settings → Delete）和 `restored.sql`。

**匯出檔的限制（據實）：**
- D1 的匯出**不支援虛擬表**（例如 FTS5 全文搜尋表）。目前 schema 沒有任何虛擬表（已檢查
  `worker/schema.sql` 與所有 migration），所以不受影響；將來若加虛擬表，備份流程要調整。
- 匯出只含資料庫本身。**R2 的照片不在備份裡**（照片在 R2，而且 R2 會在上傳 180 天後自動刪除）；
  Worker 的 secret（`PHOTOGRAPHER_TOKEN` 等）也不在裡面。
- 匯出檔匯入到**空的**新資料庫才保證沒問題；匯入到已經有表的資料庫會因為表已存在而失敗。
- 每週備份的「還原演練」會把檔案載入 SQLite 確認可以還原，但**還沒有實際匯入到一個真的 D1 測試過**（待第一次手動演練）。

---

## 四、檢查 migration 是否都跑過

`worker/tools/check-migrations.sql` 是一段**只讀**的查詢（不會改任何資料），列出正式庫「缺少」的表、欄位與索引。

1. Cloudflare → **Storage & Databases** → **D1** → `imagepicker-db` → **Console**。
2. 打開 GitHub 上的 `worker/tools/check-migrations.sql` → 右上角 **Copy raw file**（複製整個檔案）。
3. 貼到 Console → **Execute**。
4. 看結果：
   - **0 列（沒有結果）= 全部 migration 都跑過了。**
   - 每一列是一個缺少的項目：`from_file` 是要跑的檔案（在 `worker/migrations/`），`missing` 是缺什麼
     （`表 xxx`、`欄位 表.欄位`、`索引 名稱（表）`）。表不存在時只會列「表」，不會再把它的每個欄位列出來。
5. 補跑：照 CLAUDE.md 的規定，打開 `from_file` 那支檔案，**一條一條**貼到 Console 執行（照檔案裡的順序）。
   跑完再執行一次檢查，直到 0 列。
   - `from_file` 是 `schema.sql` 的項目：是最早的基本表，或只寫在 `worker/schema.sql` 的索引。
     索引可以直接從 `schema.sql` 複製那一行 `CREATE INDEX IF NOT EXISTS …` 來跑；表缺少的話請先問 Claude，不要自己建。
6. 如果 Console 不接受這麼長的查詢、或回報 `pragma_table_info` 之類的錯誤（**在真的 D1 Console 上還沒驗證過**）：
   每週備份的「還原演練」那一步也會跑同一段檢查（在備份的複本上），缺少的項目會以黃色 warning 顯示在
   GitHub Actions 的 log 裡，可以直接看那裡。
7. 給開發者：新增 migration 後要重新產生這個檔案：`node worker/tools/gen-migration-check.mjs`
   （worker 測試 `migration-check.test.mjs` 會在檔案過期時失敗，CI 會擋）。

---

## 五、已知限制與風險

- **公開 repo 的排程 60 天沒活動會被停用**：GitHub 的規則是 repo 60 天沒有任何活動（commit 等），排程 workflow 會被自動停用，
  GitHub 會寄信通知。要重新啟用：Actions → `D1 weekly backup` → **Enable workflow**。
- **備份含個資**：所以一定加密後才離開 GitHub 的臨時機器；Drive 上的檔案沒有密碼就打不開。
  密碼遺失 = 備份全部作廢。
- **備份放在不同廠商（Google）**：Cloudflare 帳號出問題（被鎖、誤刪資料庫、token 外洩被刪庫）時，Google Drive 的備份不受影響；
  Time Travel 則跟著 Cloudflare，帳號或資料庫本身沒了就沒了。兩者互補。
- **CBC 加密沒有防竄改檢查**：有人能改 Drive 上的檔案時，解出來的內容可能是壞的（多半會直接 `bad decrypt`）。
  Drive 只有你的帳號能寫，風險低。
- **匯出時 D1 會短暫停止回應**：排在台灣週一凌晨；資料變多後時間會變長。
- **誰能還原**：任何對這個 repo 有寫入權限的人都能按 `D1 time travel`。目前只有你；以後加協作者要記得這點
  （可以在 GitHub 的 Environments 加「需要核准」再保護一層）。
- **還沒有端到端演練過**的部分（第一次手動跑時要確認）：
  - `CF_API_TOKEN` 是否有 D1 權限、`wrangler d1 export` 在 GitHub 上實際成功；
  - 真實 D1 匯出檔的格式能通過完整性檢查與還原演練（目前用 SQLite 自己產生的同格式檔案測過）；
  - rclone 上傳到真的 Google Drive、`drive.file` 權限、token 能自動續期；
  - `wrangler d1 time-travel info / restore` 實際輸出（目前依 wrangler 4.148.0 原始碼寫成，沒有對真的資料庫執行過）；
  - Mac 內建 openssl 能不能解密；
  - D1 Console 能不能執行 `check-migrations.sql`。
