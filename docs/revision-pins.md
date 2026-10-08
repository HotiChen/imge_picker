# 交件後的修改標示（Revision pins）— 設計稿

狀態（2026-10-08）：**Worker 與前端都已實作並合併**（Worker WP1 2026-10-06；客人端與攝影師端 2026-10-06／07，見 §14）。
migration `2026-10-07-revision-pins.sql` 需在 D1 執行（4 句）。Tim 已決定 §11 全部照建議。
下面 §1–§12 是設計稿原文，保留當歷史；現況以 §13、§14 與程式為準。
實作與本稿不同的地方集中列在 **§13**（以 §13 與程式為準）。
基準：`main` a645be2（已部署版本）。
相關文件：`docs/delivery.md`（交件、客戶確認、要求修改）、`docs/guest-picking.md`（毛片標示的存檔規則）、
`docs/backlog.md`（THE ORDER）、`CLAUDE.md`（不變量、不做清單、風險分級）。

---

## 1. 目標與不做的事

交件後，客人可以在**新的精修照片**上直接點位置、寫說明（跟挑片時的毛片標示一樣），
再按「送出修改（N 張）」一次送出，N = 有標示的照片數。這個流程**取代**現在
`js/pick.js` 的「需要修改」自由文字框；「確認完成」不變。每一輪修改都用新檔案
（精修二、精修三…），所以不同輪的標示不會互相覆蓋。送出後那一輪的標示凍結不能改；
送出前的草稿可以改。驗收頁有「上一輪的修改資訊」按鈕，唯讀地顯示上一輪選了哪些
照片、標了什麼。攝影師在後台看每一輪、每張照片的標示，並可下載這一輪的修圖需求表（CSV）。

不做（不要在實作時偷偷加進來）：

- **不做檔名配對**：不嘗試把精修二的 `IMG_0012.jpg` 對回精修一的 `IMG_0012.jpg`。每輪各自獨立。
- **不做版本表**：沒有 per-version 的表；版本就是資料夾（CLAUDE.md「Decided not to do」）。
  一輪 = `revision_requests` 的一列。
- **不做期限、輪數上限、到期自動完成**（CLAUDE.md「Decided not to do」）。只有防濫用的系統上限
  （沿用 `REVISION_TOTAL_MAX = 50`）。
- **觀看者（家人、朋友）不能寫**：標示、說明、送出、看歷史都只限座位持有人（seat owner）。
- 不在 完成頁（已確認）加任何新東西（見 §11 Q11）。
- 不做精修照片的縮放（pinch zoom）標示；第一版標示位置是「大概位置 + 文字」（見 §11 Q14）。
- 不改 `pickReadScope` / 一般物件讀取路徑 / `?list=`（見 §4.5：新的縮圖規則走獨立路由）。

> **與既有文件的衝突（要先處理）**：`docs/delivery.md` 的「Not done, on purpose」寫著
> 「per-photo marks on a revision request (the text says which photo; pins stay a picking feature)」。
> Tim 這次的決定推翻了這一條；實作合併時要同步改 `docs/delivery.md`。CLAUDE.md 本身沒有禁止這件事。
> 另外 `docs/backlog.md` 的 THE ORDER 說「list 以外不做新的大功能」：本功能是第 1 項
> 「Client confirmation + revision requests」的延伸，由 Tim 決定，這裡只記一筆。

---

## 2. 名詞與輪次

| 名詞 | 意思 | 存在哪 |
|---|---|---|
| 草稿標示（draft pins） | 客人在目前精修上點的標示，還沒送出，可改可刪 | 新表 `revision_pins`，一張照片一列 |
| 一輪修改（round） | 一次「送出修改」= `revision_requests` 一列，`marks` 是凍結的快照 | `revision_requests`（加欄位） |
| 舊式文字需求（legacy text） | 現在的「需要修改」文字，`marks IS NULL` | `revision_requests`（舊列） |
| 挑片輪（selection round） | 第一次交件前的「上一輪」= 最新一筆 `submissions` 的 `photo_keys` + `marks` | `submissions`（不動） |
| 開著的一輪（open） | `resolved_at IS NULL` | — |

「上一輪」的定義：把**最新一筆 submission**（挑片輪）和這個專案所有 `revision_requests`
依 `created_at`（同時間用 rowid）由新到舊排在一起，**最新的那一個**就是「上一輪」。
歷史面板預設打開它，下面列出更早的輪次可以點開。這個定義只看資料，不需要記「第幾次交件」。

狀態 → 歷史按鈕顯示什麼（座位持有人，交件中、未確認）：

| 狀態 | 歷史面板預設顯示 | 說明 |
|---|---|---|
| 第一次交件，還沒送過修改 | 挑片輪：挑的毛片 + 毛片標示（`submissions.marks`） | 毛片已不在 `pickFinals`，靠 §4.5 的縮圖規則 |
| 已送出一輪，攝影師還沒更換精修 | 剛送出的那一輪（照片是**目前**的精修，唯讀） | 狀態列寫「已送出修改（N 張），攝影師處理中」；不能再畫草稿 |
| 攝影師按「更換精修」交了精修二 | 上一輪（標在精修一上的標示） | 精修一已不在 `pickFinals`，縮圖靠 §4.5 |
| 最新的一輪是舊式文字需求 | 文字卡片（沒有照片） | 只有座位持有人看得到文字 |
| 退回挑片（reopen）→ 重新送出 → 再交件 | 新的挑片輪（比所有舊輪次新） | 舊輪次仍在列表下方 |
| 取消交件（undeliver）/ 退回挑片後尚未交件 | 沒有歷史（頁面回到挑片模式，路由 409） | — |
| 已確認完成（完成頁） | 不顯示（見 §11 Q11） | 路由仍允許，前端不放按鈕 |
| 觀看者 / 沒有 key / 舊 key | 沒有按鈕；路由 403 | — |

undeliver / reopen / redeliver 之後：

- **輪次本身永遠不變**（凍結）。只有 `resolved_at` 會被既有規則改：每次交件、每次確認都結案開著的輪次；
  undeliver / reopen 不結案（沿用 `docs/delivery.md`）。
- **草稿**綁在「哪一次交件」上（`delivered_at` + `final_folders`，見 §3.3），所以：
  同資料夾重複交件 → 草稿還在；換資料夾交件、或 undeliver/reopen 後再交件（新的 `delivered_at`）→ 草稿自動失效。

---

## 3. 資料模型

### 3.1 Migration（append-only，Tim 在 D1 Console 一句一句執行，合併前）

檔名 `worker/migrations/2026-10-07-revision-pins.sql`，
`worker/schema.sql` 的 `revision_requests`（約第 413 行）後面照既有慣例加 `-- ALTER …` 註解與新欄位，並新增 `revision_pins`。

```sql
-- 1) 凍結的標示快照：JSON {photo_key: [{x,y,note}]}，key 排序，只含有標示的照片。NULL = 舊式文字需求
ALTER TABLE revision_requests ADD COLUMN marks TEXT;
-- 2) 送出當下的交件資料夾（projects.final_folders 原字串）。NULL = 舊式文字需求
ALTER TABLE revision_requests ADD COLUMN finals TEXT;
-- 3) 1 = message 是 Worker 填的固定字，不是客人的話（客人沒寫總說明時）
ALTER TABLE revision_requests ADD COLUMN message_auto INTEGER NOT NULL DEFAULT 0;
-- 4) 草稿
CREATE TABLE IF NOT EXISTS revision_pins (
  project_id    TEXT NOT NULL,
  photo_key     TEXT NOT NULL,      -- 目前精修裡的一張
  marks         TEXT NOT NULL,      -- JSON [{x,y,note}]，1–10 個；沒有標示就沒有這一列（永不存 '[]'）
  delivery_at     TEXT NOT NULL,    -- 存檔當下的 projects.delivered_at（實作改名，見 §13）
  delivery_finals TEXT NOT NULL,    -- 存檔當下的 projects.final_folders（原字串）
  updated_by    TEXT NOT NULL,      -- picker id
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (project_id, photo_key)
);
```

- 三個 `ALTER` 重跑會報 duplicate column（代表已跑過，可忽略）；`CREATE TABLE IF NOT EXISTS` 可重跑。
- 索引：`revision_pins` 的 PK 已涵蓋 `project_id` 查詢；`revision_requests` 已有
  `idx_revision_requests_project (project_id, resolved_at)`。不需要新索引。
- **為什麼 `message` 要填固定字**：既有表 `message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 1000)`，
  append-only 規則下不能放寬 CHECK（要重建表）。所以客人沒寫總說明時，Worker 存
  `REVISION_PINS_MESSAGE = '請見照片上的標示'` 並設 `message_auto = 1`；前端與 email 一律不把它當客人的話顯示。
- （可選）DB 層凍結 trigger：`CREATE TRIGGER ... BEFORE UPDATE OF marks, finals, message ON revision_requests ... RAISE(ABORT)`。
  **我沒辦法確認 D1 Console 能不能貼含分號的 trigger 本體**，所以不列為必要；凍結由程式 + 測試保證（§3.4）。

### 3.2 JSON 形狀與上限

| 東西 | 形狀 | 上限（沿用常數，集中在 worker.js 一處） |
|---|---|---|
| 一張照片的標示 | `[{x, y, note}]`，x/y 0–1（4 位小數），note trim 後 ≤ 100 字、不含控制字元 | `pickMarks()`：`PICK_MARKS_MAX = 10`、`PICK_MARK_NOTE_MAX = 100`，**直接重用，不另寫驗證** |
| 一輪的照片數 | 有標示的照片 | 新 `REVISION_PHOTOS_MAX`，建議 100（§11 Q3） |
| 一輪的標示總數 | — | `PICK_MARKS_TOTAL_MAX = 300`（草稿存檔時在 SQL 內檢查，同 selections） |
| 快照位元組 | `{photo_key: [...]}` | `PICK_MARKS_SNAPSHOT_MAX = 446,400`（送出的 INSERT 內檢查；正常存檔做不出更大的） |
| 總說明（可選） | 字串 | `revisionMessage()`：1–1000 字，規則同現在 |
| 輪次總數 | — | `REVISION_TOTAL_MAX = 50`（既有，含舊文字需求） |
| 開著的標示輪 | — | **同時只能有 1 輪開著**（任何開著的 `revision_requests` 都擋新的一輪，§11 Q4） |
| 草稿存檔一次 | `{items: [{photo_key, marks}]}` | ≤ 20 項，body ≤ 128 KB（新 `REVISION_PINS_BODY_MAX`） |

### 3.3 草稿 vs 快照，以及各動作對草稿的影響

草稿列帶著它所屬的交件（`delivered_at`, `final_folders`）。**「有效草稿」= 這兩欄等於專案目前的值**，
且 `photo_key` 在 `pickFinals(project)` 的資料夾內。讀取、送出都只看有效草稿；失效的列在下一次存檔時順手刪掉。

這樣設計的理由：**不用動既有的 deliver / undeliver / reopen / confirm 批次**。那幾個批次是不變量的核心
（清確認、結案），而且已經有「只跑了 client-confirm migration」的 fallback；在裡面加
`DELETE FROM revision_pins` 會讓「新表不存在」時整批掉到 `stamp('')`，連確認都不清（我實際讀了
`/deliver` 的 `withoutMissingSchema` fallback，這個風險是真的）。用「綁交件」的方式就完全避開。

| 動作 | 草稿 | 輪次 |
|---|---|---|
| 送出修改 | 有效草稿 → 凍結進新列，**同一批次刪除** | 新增 1 列（open） |
| 重複交件、資料夾相同 | `delivered_at` 不變（COALESCE）、資料夾相同 → 還有效 | 開著的全部結案（既有） |
| 重複交件、換資料夾 | 失效（下次存檔清掉） | 結案（既有） |
| 取消交件 | 保留但讀不到（不在交件模式）；之後再交件 `delivered_at` 是新的 → 失效 | 不動（既有） |
| 退回挑片 | 同上 | 不動（既有） |
| 確認完成（客人/攝影師） | 保留但不顯示（已確認時草稿路由 409） | 結案（既有） |

已知邊角：確認後攝影師又用**同資料夾**重複交件 → 確認被清掉、草稿重新出現。這是客人自己沒送出的字，可接受。

### 3.4 凍結如何保證

1. 程式：除了既有的 `SET resolved_at = ?`，沒有任何地方 `UPDATE revision_requests`；`marks` / `finals` /
   `message` / `message_auto` 只在送出的 `INSERT` 寫一次。
2. 測試 A（原始碼掃描）：讀 `worker/worker.js`，找出所有 `UPDATE revision_requests SET …`，斷言每一個只設 `resolved_at`。
   同時斷言至少找到 3 處（deliver、confirm、guest confirm），避免「一個都沒掃到也通過」。
3. 測試 B（行為）：送出一輪 → 存草稿、交件、取消交件、退回挑片、確認、再送一輪 → 第一列的 `marks`/`finals`/`message`
   逐字不變（直接讀 fake D1）。
4. 讀出時一律經 `parseMarksSnapshot()` 再驗證（手改的列讀起來 = 沒有標示）。

### 3.5 Migration 還沒跑時（never fail open）

目前 prod 已跑 client-confirm、沒跑本 migration。每條路由只看自己碰到的欄位/表：

| 路由 | 沒跑 migration 時 |
|---|---|
| `GET /api/pick/state` | 正常；`revision_drafts: null`（= 功能未啟用），`revision_open_photos: null` |
| `PUT /api/pick/revision-pins` | 500 `revision_pins_unavailable`，什麼都沒寫 |
| `POST /api/pick/revision-round` | 500 `revision_pins_unavailable`，什麼都沒寫、不寄信 |
| `GET /api/pick/rounds`、`/rounds/:id` | 500 `revision_pins_unavailable` |
| `GET /api/pick/rounds/:id/photo` | 500 `revision_pins_unavailable`；**絕不退回去用一般讀取規則送圖** |
| `POST /api/pick/revision`（舊文字） | 不變 |
| `GET /api/admin/projects/:id` | 正常；`withoutMissingColumn` 退回舊欄位，每列 `kind: 'text'`、`marks: null` |
| deliver / undeliver / reopen / confirm / save / submit | **完全不變**（本設計不改它們） |

前端看到 `revision_drafts: null` → 不顯示標示模式、不顯示「送出修改」，只留「確認完成」和一行
「如需修改請直接聯絡攝影師」。

---

## 4. API

共同規則：全部在 `/api/pick/` 下，先 `resolveShareToken` + `resolvePick`（401），座位用
`isOwner`（403）。回應帶 `SHARED_LINK_HEADERS`。檢查順序固定：
**401 連結 → 403 座位 → 409 not_delivered → 413/400 body → 500 migration → 409 狀態/上限 → 寫入**；
寫入沒改到任何列時重讀專案說明原因（同 `/api/pick/confirm` 的寫法）。

### 4.1 `GET /api/pick/state`（改）

只在交件模式、且是座位持有人時多兩個 key（觀看者**沒有這兩個 key**，同 `marks` 的作法）：

- `revision_drafts`: `[{photo_key, marks}]`（有效草稿，key 排序；未確認時才有內容，已確認為 `[]`），migration 沒跑為 `null`。
- `revision_open_photos`: 開著的標示輪的照片數，沒有則 `null`。
- 既有的 `revision_message`：開著的那列若 `message_auto = 1` → 回 `null`（不把固定字當客人的話）。

### 4.2 `PUT /api/pick/revision-pins`（新）草稿存檔

Body：`{items: [{photo_key, marks}]}`，1–20 項。每項是**整張照片的完整標示**（順序 = ①②③），
`marks: []` = 刪掉那張的草稿。同一 key 出現兩次以最後一次為準。

| 順序 | 狀況 | 回應 |
|---|---|---|
| 1 | 連結死/封存/撤銷/過期、非 pick 連結 | 401 |
| 2 | 不是座位持有人 | 403 |
| 3 | 不在交件模式 | 409 `not_delivered` |
| 4 | body 太大 | 413 `too_large` |
| 5 | JSON 壞、不是物件、items 不是 1–20 的陣列 | 400 `Invalid JSON` / `invalid_body` |
| 6 | key 格式（`pickKeyValid`）/ 標示格式（`pickMarks`） | 400 `invalid_photo_key` / `invalid_marks` |
| 7 | key 不在**目前精修**資料夾（`pickKeyAllowed({folders: scope.finals})`，毛片不算，即使開了下載） | 403 `not_in_finals` |
| 8 | 新表/欄位不存在 | 500 `revision_pins_unavailable` |
| 9 | 已確認 | 409 `already_confirmed` |
| 10 | 有開著的一輪 | 409 `revision_open` |
| 11 | 照片數 / 標示總數超過 | 409 `revision_photos_cap` / `marks_cap`（含 `max`） |
| — | 成功 | 200 `{ok: true}` |

寫入：一個 batch，每一句都帶同一個 gate（D1 batch = transaction）：

```
gate = EXISTS (SELECT 1 FROM projects p WHERE p.id = ?1 AND p.owner_picker_id = ?2
  AND p.archived_at IS NULL AND p.phase = 'retouching'
  AND p.delivered_at = ?3 AND p.final_folders = ?4          -- 路由讀到的那次交件
  AND p.client_confirmed_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM revision_requests r WHERE r.project_id = ?1 AND r.resolved_at IS NULL)
  AND <存完後的有效草稿照片數 ≤ REVISION_PHOTOS_MAX 或不多於現在>
  AND <存完後的標示總數 ≤ PICK_MARKS_TOTAL_MAX 或不多於現在>)
1) DELETE FROM revision_pins WHERE project_id = ?1 AND (delivery_at IS NOT ?3 OR delivery_finals IS NOT ?4) AND gate   -- 清失效
2) INSERT … ON CONFLICT(project_id, photo_key) DO UPDATE …（marks 非空的項目） WHERE gate
3) DELETE FROM revision_pins WHERE project_id = ?1 AND photo_key IN (marks 為空的項目) AND gate
```

`?3/?4` 綁的是路由讀到的值，所以「攝影師剛換了精修」時這次存檔整批不生效（重讀後回 409 `not_delivered`
或前端重整）。上限的寫法照抄 `PUT /api/pick/selections` 的 `marksFit`（「之後 ≤ 上限，或不多於現在」）。
第一句當 gate 的 row-count 判斷要改成一句永遠會碰到專案的 `UPDATE projects SET id = id WHERE …gate…`（同 selections 的作法），
因為 DELETE 可能 0 列。

### 4.3 `POST /api/pick/revision-round`（新）送出修改

Body：`{note?: string, expect: [{k: photo_key, n: 標示數}]}`。`expect` 是頁面認為要送出的照片與每張的標示數（key 排序），
用來抓「另一個分頁剛改了」的情況。

| 順序 | 狀況 | 回應 |
|---|---|---|
| 1–3 | 同 4.2 | 401 / 403 / 409 `not_delivered` |
| 4 | body > `PICK_SUBMIT_BODY_MAX`（16 KB 不夠時改 64 KB） | 413 |
| 5 | 壞 JSON / 不是物件 / expect 不是陣列或 > `REVISION_PHOTOS_MAX` 項 | 400 |
| 6 | note 有給但不合 `revisionMessage()` | 400 `invalid_message` |
| 7 | migration 沒跑 | 500 `revision_pins_unavailable` |
| 8 | 已確認 | 409 `already_confirmed` |
| 9 | 有開著的一輪（含舊文字需求） | 409 `revision_open` |
| 10 | 沒有有效草稿 | 409 `no_pins` |
| 11 | 有效草稿 ≠ expect | 409 `draft_changed`（前端重讀草稿再讓客人確認一次） |
| 12 | 輪次總數 ≥ 50 | 409 `revision_cap` |
| 13 | 快照 > 446,400 bytes（只有手改資料才可能） | 409 `marks_cap` |
| — | 成功 | 200 `{ok, id, created_at, photo_count}` |

寫入：一個 batch。

```
1) INSERT INTO revision_requests (id, project_id, picker_id, message, message_auto, marks, finals, created_at)
   SELECT ?id, p.id, ?picker, ?msg, ?auto, <snapshot>, p.final_folders, ?at FROM projects p
   WHERE p.id = ? AND p.owner_picker_id = ? AND p.archived_at IS NULL AND p.phase = 'retouching'
     AND p.delivered_at IS NOT NULL AND p.final_folders IS NOT NULL AND p.client_confirmed_at IS NULL
     AND NOT EXISTS (開著的 revision_requests)
     AND (SELECT COUNT(*) FROM revision_requests WHERE project_id = p.id) < 50
     AND <有效草稿數> BETWEEN 1 AND REVISION_PHOTOS_MAX
     AND <有效草稿的 json_group_array(json_object('k',photo_key,'n',json_array_length(marks)))> = ?expectJson
     AND length(CAST(<snapshot> AS BLOB)) <= PICK_MARKS_SNAPSHOT_MAX
   snapshot = (SELECT json_group_object(photo_key, json(marks)) FROM (有效草稿 ORDER BY photo_key))
   有效草稿 = revision_pins d WHERE d.project_id = p.id AND d.delivery_at = p.delivered_at AND d.delivery_finals = p.final_folders
2) DELETE FROM revision_pins WHERE project_id = ? AND EXISTS (SELECT 1 FROM revision_requests WHERE id = ?id)
```

`?expectJson` 由 Worker 把客人的 `expect` 驗證後排序、`JSON.stringify` 出來；要有測試證明它和 SQLite
`json_group_array` 的輸出逐字相同（中文、引號、反斜線的 key）。**若證明不可靠，退回只比 key 清單**（§12）。
成功後在背景寄信（§6.4），失敗不影響回應。

舊路由 `POST /api/pick/revision {message}` **保留不動**（已快取的舊 pick.js 還可能呼叫，§11 Q12）。

### 4.4 `GET /api/pick/rounds` 與 `GET /api/pick/rounds/:id`（新）歷史

順序：401 → 403（觀看者）→ 409 `not_delivered` → 500 migration → 404（`:id` 不存在/不屬於這個專案/格式不對）→ 200。

- 列表：`{rounds: [{id, kind, created_at, open, photo_count, has_note}]}`，新到舊，最多 51 筆。
  `kind`：`'selection'`（id 固定 `'selection'`，只代表**最新**一筆 submission）、`'pins'`、`'text'`。
- 單輪：`{id, kind, created_at, open, note, photos: [{i, name, pins}]}`。
  - `note`：客人的總說明；`message_auto = 1` → `null`；舊文字需求 → 那段文字。
  - `photos`：`pins` 輪 = 快照裡的照片；挑片輪 = 該 submission 所有 `photo_keys`，有標示的排前面。
  - `i` = 該照片在 **Worker 排序後的 key 清單**中的位置（`roundPhotoKeys(row)`：`Object.keys(...).sort()` /
    `parsePhotoKeys`，列表、單輪、縮圖三處共用同一個函式）。
  - `name` = 檔名（`key.split('/').pop()`）。**不回完整 key、不回 `finals`**：
    客人不需要舊資料夾名稱，而且守住 CLAUDE.md「guest routes must not return `final_folders`」的字面意思。
- `:id` 格式：`selection` 或 UUID（`/^[0-9a-f-]{36}$/`），其他 404。查詢一律 `WHERE id = ? AND project_id = ?`，
  `project_id` 來自連結，絕不來自 request。

### 4.5 縮圖規則：`GET /api/pick/rounds/:id/photo?i=<n>&w=<400|1200>`（新）

**為什麼是獨立路由、不改 `pickReadScope`**：

- `<img src>` 送不出 `X-Picker-Key`，現在的物件路由只認 `?t=`（`js/config.js` 註解、`resolvePick` 只讀 header）。
  「只有座位持有人能看」在一般 `<img>` 路徑上**做不到**，除非把 picker key 放進網址（`js/pick.js` 明說不行）。
  所以前端用 `fetch`（帶 `X-Share-Token` + `X-Picker-Key`）→ `blob` → `URL.createObjectURL`。
- 一般物件路由、`?list=`、`pickReadScope` 完全不變：舊精修/毛片在那裡仍是 401，原檔/下載路徑不會因本功能多開任何東西。
- 請求裡**沒有 key**，只有輪次 id + 索引，所以 `..`、`%2e%2e`、`_books/`、雙重編碼這整類攻擊不存在。

精確規則（依序，任何一步不過就停）：

1. `s = resolveShareToken`，`ctx = resolvePick(s)`；不是活的 pick 連結（撤銷、過期、封存、相本/客戶/studio token）→ 401。
2. `ctx.isOwner`（key 的 hash 屬於**這個專案**的 picker，且就是 `owner_picker_id`）→ 否則 403。
3. `pickReadScope(s).mode === 'delivered'`（`delivered_at` 有值且 `final_folders` 能解析）→ 否則 409 `not_delivered`。
4. 有 `download` 參數 → 400；`w` 必須是字串 `'400'` 或 `'1200'`（§11 Q9）→ 否則 400 `invalid_width`。
5. 找輪次：`selection` → `SELECT photo_keys FROM submissions WHERE project_id = ? ORDER BY rowid DESC LIMIT 1`，
   允許資料夾 = `pickFolders(project.folders)` ∪ `s.folders`；UUID → `SELECT marks, finals FROM revision_requests
   WHERE id = ? AND project_id = ?`，`marks` 解析不出照片 → 404，允許資料夾 = `finalFolders(JSON.parse(finals))`，null → 404。
6. `i` 必須符合 `/^\d{1,4}$/` 且 `< keys.length` → 否則 404。
7. `key = keys[i]` 再驗一次：`pickKeyValid(key)`、`!isInternalKey(key)`、`shareCovers({folders: 允許資料夾}, key)`
   （它已拒絕 `.`/`..` 段）→ 否則 404（只有手改資料會走到）。
8. 只讀**一個**物件：`_thumbs/<w>/<key>.thumb`。不存在 → 404 `no_thumbnail`。**絕不退回原檔**、絕不加 `Content-Disposition`。
9. 回應：`Cache-Control: private, no-store`、`Vary: X-Share-Token, X-Picker-Key`、`X-Content-Type-Options: nosniff`，
   不支援 Range（整張回傳）。

必須擋下的濫用（每一條都要有測試）：

| 嘗試 | 結果 |
|---|---|
| 別的專案的輪次 id（猜到 UUID） | 404（`project_id` 不符） |
| 自己專案輪次但用觀看者 / 沒 key / 別專案的 key | 403 |
| seat reset 之前的舊 key | 403（picker 列還在但不是 owner） |
| `w=1600`、`w=9999`、`w=0`、`w=400abc`、`download=1` | 400 |
| 想拿原檔：一般物件路由 `GET /精修一/IMG.jpg?t=…` | 仍 401（不在 preview scope）——**本功能不改它** |
| `i=-1`、`i=1e3`、`i=99999`、`i=` | 404 |
| 手改的列：key 是 `_books/x.json`、`../x`、資料夾外 | 404 |
| 縮圖不存在（舊上傳或 180 天後被刪） | 404，不送原檔 |
| 取消交件 / 退回挑片之後 | 409 |
| 撤銷 / 封存 / 過期的連結 | 401 |
| 換精修後讀上一輪（精修一） | **200**（這是 Tim 要的行為）——只限縮圖、只限座位持有人 |
| 挑片輪：讀更早（非最新）submission 的照片 | 不可能（只有最新那筆算 `selection`） |

### 4.6 Admin（改）

- `GET /api/admin/projects/:id`：`revision_requests` 每列加 `kind`、`marks`（`parseMarksSnapshot`）、
  `finals`（解析後陣列）、`message_auto`（boolean）、`photo_count`。舊資料庫退回舊欄位（`withoutMissingColumn`）。
  最壞大小 50 × 446 KB，但「同時只開一輪」代表每一輪之間都要攝影師交件一次，客人單方面做不出來。
- 列表的 `open_revision_count` 不變（標示輪也是 `revision_requests`）。
- 攝影師看舊精修縮圖：既有的 studio token / admin 讀取本來就能讀全部，不需新路由。

---

## 5. 閘門與不變量

| CLAUDE.md 不變量 | 本設計怎麼守 |
|---|---|
| 只有 `delivered_at` 有值才算交件 | 新路由全部先檢查 `pickReadScope(s).mode === 'delivered'`（它內部就是 `pickFinals`）；寫入的 SQL gate 也帶 `delivered_at` |
| `final_folders` 非 null ≠ 交件 | 同上；草稿綁 `delivered_at` + `final_folders` 兩欄，不只看資料夾 |
| `client_confirmed_at` 只在交件中設、永不自動 | 本功能不寫 `client_confirmed_at`；送出與草稿都要求它是 NULL |
| 每次交件/取消/退回清確認；每次交件、每次確認同批結案開著的需求 | **不改**這些批次；標示輪就是 `revision_requests`，自動被結案 |
| 已確認不會和開著的需求並存 | 送出的 INSERT 內含 `client_confirmed_at IS NULL`；確認批次結案全部。兩者並發時任一順序都成立（§8） |
| 客人讀精修都經過 `pickFinals` | 草稿 key 驗證用 `scope.finals`；縮圖路由先要求目前交件中。**唯一例外**是舊輪次的縮圖，見下方新不變量 |
| 標示 = `[{x,y,note}]`、0–1、空 note 允許 | 重用 `pickMarks()`、`parseMarksSnapshot()`；空 note 照樣允許 |
| 客人頁維持暗色，完成頁例外 | 本功能只動驗收頁（暗色）；完成頁不加東西；不改 `css/styles.css` 的 `:root` |

建議加進 CLAUDE.md「Invariants」的文字（英文，與現有條目一致）：

> - Revision rounds are `revision_requests` rows. `marks` / `finals` / `message` / `message_auto` are written
>   once by the submit `INSERT` and never updated; the only `UPDATE revision_requests` allowed sets
>   `resolved_at` (a worker test scans for this). Draft pins (`revision_pins`) count only while their
>   `delivered_at` and `final_folders` equal the project's; at most one round is open at a time.
> - The one guest read outside `pickFinals`: `GET /api/pick/rounds/:id/photo` serves `_thumbs/400|1200/<key>.thumb`
>   (never an original, never a download) of a key at index `i` of one of this project's frozen snapshots (the
>   latest submission or a `revision_requests.marks`), to the seat owner only, only while delivered. It never takes
>   a key from the request. `pickReadScope`, the object route and `?list=` must not learn about old rounds.

---

## 6. 前端

### 6.1 客人：驗收頁（交件中、未確認、座位持有人）

| 部分 | 內容 | 重用 / 新寫 |
|---|---|---|
| 燈箱標示模式 | `FinalsGallery` 燈箱工具列多一個「標示修改」。開啟後：點照片 = 加一個標示；下方抽屜列出 ①②③ 與說明輸入（≤100 字、計數）、× 刪除；左右滑動在標示模式中停用（‹ › 鍵仍可換張）；「完成」離開 | 燈箱、計數規則重用；疊圖層用新的 `js/pin-layer.js`（§7）；抽屜仿 `pick.js` `_renderPinList` 但新寫 |
| 自動存檔 | 每張照片 600 ms debounce，`PUT /api/pick/revision-pins`；失敗 0/429/5xx 保留重試，4xx 顯示錯誤；`pagehide` 用 keepalive 送出 | 仿 `pick.js` 的 autosave 佇列（不共用程式，避免碰 selections 邏輯） |
| 照片牆標記 | 有草稿的照片右下角一個數字徽章（標示數），純 CSS | 新：`FinalsGallery` 加 `tileBadge(photo)` hook |
| 狀態列 | 「確認完成」+「送出修改（N 張）」（N=0 時 disabled，提示「點照片進入標示修改」）；觀看者看不到按鈕，只看到狀態字 | 改 `js/delivery-done.js`（從 pick.js 搬出，§7） |
| 送出對話框 | 標題「送出 N 張照片的修改？」；N 張小縮圖 + 每張標示數；可選總說明（≤1000 字）；若有標示沒寫說明：「有 K 個標示沒有寫說明，攝影師只看得到位置」；說明「送出後這一輪就不能再改，攝影師更新照片後會再通知你」；送出前先 flush 存檔佇列，再重讀 state（沿用 `_doneGuard` 的「頁面過期」判斷） | 對話框殼重用 `_ensureDoneModals` 的樣式 |
| 送出後 | 狀態「已送出修改（N 張），攝影師處理中」；標示模式消失；燈箱裡該輪的標示以唯讀顯示（§11 Q6） | 新 |
| 確認對話框 | 若有未送出草稿：「你還有 N 張照片的標示沒有送出，確認完成後不會送給攝影師」 | 改既有文字 |
| 歷史面板 | 「上一輪的修改資訊」按鈕 → 全螢幕面板：標題（「挑片時的標示 · 日期」或「第 k 輪修改 · 日期」），總說明（若有），照片格（400 縮圖，`fetch`→blob，IntersectionObserver 延遲載入，關閉時 `revokeObjectURL`）；點一張 → 唯讀大圖（1200）+ `PinLayer` 唯讀 + 說明列表；下方「更早的輪次」列表 | 新；文字一律 `textContent` |
| 空/錯/離線 | 沒有任何輪次：按鈕不出現。列表讀失敗：「暫時無法載入，重試」。縮圖 404：灰底「照片已不在雲端」。離線存檔：狀態列「尚未儲存，連線後會自動送出」。送出時 409 `draft_changed`：重讀草稿後重新顯示對話框；`revision_open`：重讀 state 顯示「已送出」；`not_delivered`：沿用「攝影師剛更新了照片，請重新整理」 | 新 |

完成頁（已確認）：**不變**，不顯示標示、不顯示歷史（§11 Q11）。

### 6.2 攝影師：admin.html

- 交件區的「客人要求修改」清單改成**依輪次**：「第 k 輪 · 日期 · N 張 · 未處理/已處理 · 客人名」，
  總說明（`message_auto` 時不顯示），每張照片一列：縮圖（既有 admin 讀圖方式，`?w=400`）+ `PinLayer` 唯讀疊圖 + ①②③ 說明。
  舊式文字需求照舊顯示文字。全部 `textContent`，說明元素加 `dir="auto"` 與 `unicode-bidi: isolate`。
- 點縮圖 → 簡單 modal：1200 圖 + `PinLayer` 唯讀 + 說明列表（新寫，**不經過** `project-view.js` / `annotation.js`，
  避免碰那組耦合）。
- 每一輪一個「下載此輪需求表 (CSV)」：`js/selection-export.js` 新增 `revisionToCsv(round)`，欄位
  `檔名, 標示`（重用 `pinsText`、`csvCell`；檔名用完整 key 的檔名部分，第一列可加總說明）。原本挑片的 CSV 不變。
- 「請上傳新版精修資料夾後按『更換精修資料夾』」提示文字保留。

### 6.3 文字（建議）

- 按鈕：「送出修改（N 張）」「標示修改」「完成」「上一輪的修改資訊」。
- 燈箱提示：「點照片上要修改的位置（這張已標 n/10）」。

### 6.4 Email

沿用 `sendClientNotification`，把 `oneLine` 提到模組層共用：

- 主旨：`[要求修改] <title> — <name>（N 張）`，全部經 `oneLine`。
- 內文：前言「客人在交件的精修照片上標示了要修改的地方：」；總說明（若是客人寫的）；
  每張照片一行 `IMG_0012.jpg：①臉修瘦一點 ②去掉路人`，最多 20 張，其餘「…另 N 張，請到後台查看」；
  檔名與說明在文字版逐行經 `oneLine`（去掉 bidi 控制字元），HTML 版經 `escapeHtml`。後台連結同現在。
- 不節流：同時只開一輪、每輪之間要攝影師交件，最多 50 輪。

---

## 7. 程式碼獨立（本功能需要的部分）

### 7.1 `js/pin-layer.js`（新）

DOM 疊圖（絕對定位的 `<button>`），不是 canvas。理由：精修燈箱、歷史面板、admin 都是 `<img>`，
而且 `.fg-lb-img` 是 `object-fit: contain`（`css/styles.css`），必須算出圖片實際顯示的矩形。

```js
window.PinLayer = {
  clean(arr, max = Infinity),              // = 現在的 window.cleanPinMarks（搬過來；annotation.js 留別名）
  contentRect(img),                        // object-fit:contain 下照片實際顯示的 DOMRect（用 naturalWidth/Height）
  toFraction(rect, clientX, clientY),      // → {x, y}（4 位小數）或 null（點在黑邊）
  attach(host, img, { readOnly, max, onAdd(x, y), onSelect(i) }) → {
    set(marks), select(i), setReadOnly(bool), destroy()
  },
};
```

- 編號、`aria-label`（「標示 1：說明」）全用 `textContent` / `setAttribute`。
- 圖片 `load`、`ResizeObserver` 時重排；`readOnly` 時不接受點擊新增，只觸發 `onSelect`。
- 遷移路徑（每步都保持現有測試綠）：
  1. 新增 `pin-layer.js`，`window.cleanPinMarks = PinLayer.clean` 留別名；`annotation.js`、`project-view.js` 不改行為。
  2. 新功能（燈箱、歷史、admin）只用 `PinLayer.attach`。
  3. **不**把 `annotation.js` 的 canvas 標示改成 DOM（它要跟縮放/平移，風險高，不屬於本功能）。

### 7.2 `FinalsGallery` 的掛勾（`js/finals-gallery.js`）

保持它不知道「標示」是什麼。`mount(content, opts)` 多兩個可選項：

- `lightboxExtras: { toolbar(barEl, api), onShow(photo, stage, img), onClose(), blockSwipe() }`
- `tileBadge(photo) → string | null`

沒給就完全是現在的行為（`28-finals-gallery.mjs` 必須不改一行就綠）。

### 7.3 `js/delivery-done.js`（新，從 `js/pick.js` 搬出）

搬走（約 290 行，`pick.js` 484–775 附近）：`_applyConfirmFields`、`_renderDone`、`_removeDoneModals`、
`_ensureDoneModals`、`_doneModal`、`_doneErr`、`_openDoneModal`、`_closeDoneModal`、`_doneShowErr`、
`_doneErrorText`、`_doneGuard`、`_doneSubmit`，以及 `confirmDelivery` / `requestRevision` 的呼叫。

留在 `pick.js`：模式/視圖判斷（`_applyView`、`_completionWanted`）、`fetchState`、`_json`（帶 header 的 fetch）、
`confirmedAt` 等狀態欄位的擁有權、`_fmtDate`。介面：

```js
DeliveryDone.render({ bar, isOwner, state }, ctx)   // ctx: { json(path, body, method), fetchState(), fmtDate(iso), onChanged() }
DeliveryDone.remove()
```

順序：**先純搬移、行為與 DOM id 一字不差**（`deliveryDone`、`doneConfirmBtn`、`doneReviseBtn`、`doneConfirmModal`、
`doneReviseModal`、`doneReviseText`…），全部既有 suite 綠，單獨 commit；**之後**才把「需要修改」換成標示流程。

### 7.4 搬移前要先寫的特性測試（characterisation）

- `test/suites/15-guest-confirm.mjs`、`17-admin-revisions.mjs`、`33-completion-page.mjs` 已涵蓋大部分；搬之前先補一個新 suite
  `test/suites/34-delivery-done-baseline.mjs`，鎖住：三種狀態的 DOM 結構與文字、觀看者無按鈕（**同一 fixture 先斷言座位持有人有按鈕**）、
  modal 在非交件模式「不在 DOM」（不是 hidden）、頁面過期 guard、`already_confirmed`、離線錯誤字。
- 風險：`pick.js` 其他地方直接呼叫 `this._renderDone()`（`_applyView` 等）——搬之前 `grep` 所有呼叫點列清單；
  `this` 綁定改成 ctx 後最容易漏的是 `_doneBusy` 與 keydown handler 的移除。

---

## 8. 安全審查清單

| 項目 | 檢查點 |
|---|---|
| IDOR | 所有查詢的 `project_id` 來自連結；輪次查詢 `WHERE id = ? AND project_id = ?`；縮圖用索引不用 key |
| 跨專案 / 跨攝影師 | picker key 只在同專案查（`resolvePick`）；admin 路由照舊 `photographer_id = DEFAULT_PHOTOGRAPHER_ID` |
| Token 種類 | 只有 pick 連結；相本/客戶/studio token 在 `resolvePick` 就是 401 |
| 座位 key | 每個寫入與每個讀取（草稿、歷史、縮圖）都要 `isOwner`；寫入的 SQL 再驗 `owner_picker_id = ?` |
| 繞過精修閘門 | 草稿 key 必須在 `scope.finals`；state 回草稿時再過濾一次 |
| 繞過縮圖規則 | §4.5 九步與濫用表；不改 `pickReadScope`；不退回原檔；`w` 白名單 |
| SQL injection | 全部 bind；`expectJson` 是 bind 值不是字串拼接 |
| 說明裡的標記 | 前端 `textContent` / `.value`；admin 同；email HTML `escapeHtml` |
| 控制字元 / bidi | `pickMarks` 拒絕控制字元；bidi（U+202E 等）目前**允許**存進 note → 顯示端 `unicode-bidi: isolate` + `dir="auto"`，email 經 `oneLine`，CSV 經 `csvCell`（公式前綴） |
| 濫用與上限 | 每張 10 個、每輪 100 張、總標示 300、快照 446,400 bytes、body 128 KB / 16–64 KB、同時一輪、總 50 輪 |
| 競態：連點兩次送出 | 第二次 409 `revision_open` 或 `no_pins`；前端按鈕 busy |
| 送出 vs 交件 | 交件換資料夾後，草稿不再有效 → 送出 `no_pins`/`draft_changed`；送出先到、交件後到 → 被交件結案（攝影師可能沒看到，§12） |
| 送出 vs 確認（兩個分頁） | INSERT 要求未確認；確認批次結案全部；任一順序都不會「已確認 + 開著」 |
| 草稿 vs 送出 | 草稿 gate 要求沒有開著的輪；`expect` 比對抓到另一分頁的增減 |
| Email injection | 主旨只含標題、名字、張數，經 `oneLine`；客人文字只在內文 |
| 缺 migration | §3.5：每條新路由 500，不退回更寬的讀取 |
| 快取 | 縮圖 `private, no-store`、`Vary` 含 picker key；blob URL 用完 revoke |

---

## 9. 測試計畫

### 9.1 Worker（`node --test "worker/test/*.test.mjs"`，新檔案，不改既有檔案的斷言）

- `worker/test/revision-pins.test.mjs`（草稿 + 送出 + state）：
  - migration 檔：三個 ALTER + 一個 CREATE，一句一行；schema.sql 有註記（仿 `client-confirm.test.mjs` 第一個 test）。
  - 草稿：座位持有人存、讀回（state）、整張取代、`[]` 刪除；觀看者 403 且**同一 fixture 先證明座位持有人 200**；
    毛片 key（即使開了原檔下載）403；格式 400；上限 409（照片數、總標示數，含「已超過時刪除仍可」）。
  - 綁交件：同資料夾重複交件草稿還在；換資料夾交件後 state 不回、存檔順手清掉；undeliver→deliver 後失效。
  - 送出：快照逐字正確（中文 key、引號、反斜線）、草稿同批刪除、`finals` 等於當時 `final_folders`、`message_auto`；
    `expect` 不符 409、無草稿 409、已確認 409、已有開著的（含舊文字需求）409、50 輪 409；email 內容（主旨一行、20 張截斷、HTML 跳脫）。
  - 凍結：§3.4 的原始碼掃描（至少找到 3 處）與行為測試。
  - 競態（仿 `client-confirm.test.mjs` 的 races）：送出與確認同時送；送出與交件同時送；兩個送出同時送。結論斷言「已確認 ⇒ 無開著」。
  - 缺 migration：用只跑到 client-confirm 的 schema，所有既有路由照舊、新路由 500 且沒寫任何東西。
- `worker/test/revision-rounds-gate.test.mjs`（歷史 + 縮圖閘門）：
  - fake R2 同時放 `精修一/a.jpg`（內容 `ORIG`）與 `_thumbs/400/精修一/a.jpg.thumb`（內容 `T400`），
    斷言座位持有人拿到的 body **等於 `T400`**（不是只看 200），沒有縮圖時 404 而且 body 不是 `ORIG`。
  - §4.5 濫用表每一列一個案例，每個案例都用**座位持有人 key**（除了測座位的那幾條），避免被前面的 403 擋掉而假通過。
  - 換精修後讀上一輪 200；undeliver 後 409；封存/撤銷/過期 401；舊 key 403。
  - 一般物件路由讀舊精修原檔仍 401、縮圖仍 401（證明 `pickReadScope` 沒被放寬）。
  - 列表/單輪：觀看者 403、`message_auto` 回 `null`、不回完整 key、不回 `finals`、`selection` 只代表最新 submission。

### 9.2 Mutation（Worker，約 12 個，每個先 `node --input-type=module --check < worker/worker.js`）

1. 縮圖路由拿掉 `isOwner` → 觀看者案例紅。
2. 拿掉 delivered 檢查 → undeliver 案例紅。
3. 輪次查詢拿掉 `AND project_id = ?` → 跨專案案例紅。
4. `w` 接受 1600 / 任意值 → 寬度案例紅。
5. 縮圖不存在時把原 key 加進候選 → `ORIG` 案例紅。
6. 拿掉第 7 步的再驗證 → 手改列（`_books/`、資料夾外）案例紅。
7. 草稿 gate 拿掉 `final_folders = ?4` → 換精修後存舊草稿案例紅。
8. 送出拿掉 `client_confirmed_at IS NULL` → 確認後送出案例紅。
9. 送出拿掉「無開著的輪」 → 連送兩次案例紅。
10. 送出 batch 拿掉 DELETE 草稿 → 送出後 state 仍有草稿案例紅。
11. state 對觀看者也回 `revision_drafts` → 觀看者案例紅。
12. `selection` 改成任意 submission（拿掉 `ORDER BY rowid DESC LIMIT 1`）→ 舊 submission 案例紅。
13. （額外）`UPDATE revision_requests SET marks = …` 加進任一路由 → 原始碼掃描紅。

每條規則的「先紅」證明：先寫測試、在現在的 main 上跑一次（路由不存在 → 404 而非預期碼），確認失敗理由是「規則不存在」而不是 fixture 錯。

### 9.3 瀏覽器（新 suite，各自一個檔案）

- `34-delivery-done-baseline.mjs`：§7.4 的特性測試，**在搬移前**寫好、在 main 上綠。
- `35-pin-layer.mjs`：`contentRect` 在橫/直圖、`object-fit: contain` 的黑邊；`toFraction` 黑邊回 null；唯讀不新增；數字用 textContent。
- `36-revision-pins-guest.mjs`：燈箱標示模式（加/改/刪、滑動停用、重整後草稿還在）、N 的計數、送出對話框與 flush、
  送出後狀態、觀看者無按鈕（同 fixture 先證明座位持有人有）、歷史面板（blob 請求帶 header、404 佔位圖、關閉 revoke）、
  migration 沒跑時（`revision_drafts: null`）只有確認、離線錯誤字、完成頁沒有任何新元素（從 DOM 移除而非 hidden）。
- `37-admin-revision-pins.mjs`：依輪次列表、疊圖位置（以元素實際座標驗證，並設最少掃描數）、舊文字需求仍顯示、CSV 內容逐字（BOM、①②、公式前綴）。
- `28-finals-gallery.mjs`、`23-retouch-pins.mjs`、`15`、`17`、`33` 必須不改斷言就綠。

---

## 10. 工作切分與順序

| 包 | 內容 | 模型 | 檔案範圍（互不重疊） | 依賴 | Token 估計（±40%） |
|---|---|---|---|---|---|
| WP1 | migration SQL、schema.sql、Worker 新路由與 state/admin 改動、`oneLine` 抽出、email、worker 測試、mutation | opus（High） | `worker/**` | 本文定稿 | 約 700k |
| WP2 | WP1 的對抗式安全審查（只讀 + 跑測試 + 補攻擊案例） | opus | 只讀；補的測試放 `worker/test/revision-rounds-gate.test.mjs` | WP1 | 約 200k |
| WP3 | 特性測試 34、`js/pin-layer.js`、`js/delivery-done.js` 純搬移、`FinalsGallery` 掛勾、suite 35 | sonnet（Normal，但碰 pick.js 要小心） | `js/pick.js`、`js/delivery-done.js`、`js/pin-layer.js`、`js/finals-gallery.js`、`js/annotation.js`（只留別名）、`js/project-view.js`（只換 clean）、`index.html` script tag、`test/suites/34-*`、`35-*` | 無（可與 WP1 並行） | 約 450k |
| WP5 | admin 依輪次列表、modal、`revisionToCsv`、suite 37 | sonnet | `admin.html`、`js/selection-export.js`、`test/suites/37-*` | WP1 API（依本文契約，可先用 fake）、WP3 的 `pin-layer.js` | 約 350k |
| WP4 | 客人端：燈箱標示、草稿佇列、送出流程、歷史面板、新 CSS 檔、suite 36 | sonnet | `js/delivery-done.js`、`js/finals-gallery.js`（只接掛勾）、新 `css/revision-pins.css`、`index.html`、`test/suites/36-*` | WP1 + WP3 | 約 600k |
| 合併 | 合併、衝突、`?v=` 一次、全部 suite、更新 `docs/delivery.md` 與 CLAUDE.md 不變量 | orchestrator | — | 全部 | 約 250k |

合計約 2.5M token（±40%）。最多同時 2 個 agent：

1. 第一段：WP1 ‖ WP3
2. 第二段：WP2 ‖ WP5
3. 第三段：WP4（碰 `delivery-done.js`、`index.html`，必須在 WP3 之後）
4. 第四段：合併、全測、（建議）用 opus 小範圍看一次 WP4 的 blob fetch 與 header 處理

每個 agent 開工前先 `git log` 確認 base，base 不對就回報，不要自己 reset（CLAUDE.md）。

Tim 要手動做的：

- **合併前**：在 D1 Console 依序執行 migration 的四句（三個 ALTER、一個 CREATE TABLE）。
- 合併後：GitHub Actions 部署成功；Purge Everything（Worker 與靜態檔都有改）。
- 真機（iPhone Safari、LINE 內建瀏覽器）：
  1. 座位持有人打開已交件連結 → 燈箱「標示修改」→ 點兩處、寫說明 → 重整後還在。
  2. 標示模式下左右滑不會換張；離開後可以。
  3. 「送出修改（N 張）」N 正確 → 送出 → 攝影師信箱收到含照片清單的信。
  4. 後台該輪的標示位置與客人點的一致；CSV 用 Excel 打開中文、①② 正常。
  5. 攝影師上傳精修二、按更換精修 → 客人頁「上一輪的修改資訊」看到精修一縮圖與標示。
  6. 另一支沒 key 的手機（觀看者）看不到任何按鈕與歷史。
  7. 確認完成 → 完成頁沒有任何標示相關元素。

---

## 11. 未決問題（Tim 要決定）

1. **送出時要不要總說明欄？** 建議：可選。取捨：必填會擋住只想點幾個點的客人；完全不給則無法說「整體再亮一點」。
   因 DB 的 CHECK，空白時存固定字 + `message_auto = 1`。
2. **標示可以不寫說明嗎？** 建議：可以（CLAUDE.md 已寫空 note 是刻意允許的），但送出對話框提醒「有 K 個標示沒寫說明」。
   取捨：精修上的空白標示比毛片更容易讓攝影師猜錯。
3. **一輪最多幾張？** 建議 100（加上總標示 300）。取捨：婚禮精修可能 300 張以上，但一次要改 100 張以上通常該直接溝通；上限太低客人會卡住。
4. **同時只開一輪，還是允許「追加」？** 建議：只開一輪。取捨：客人送出後想到漏了一張只能聯絡攝影師；
   允許追加則同一批精修上會有兩輪標示，「上一輪」定義變複雜，也違背「每輪新檔案」的前提。
5. **攝影師可以「退回」一個已送出的輪次讓客人改嗎？** 建議：第一版不做（凍結就是凍結）；真實案子需要再加
   「結案此輪」（只設 `resolved_at`，不碰確認），不會破壞不變量。
6. **等攝影師更新期間客人看到什麼？** 建議：狀態「已送出修改（N 張），攝影師處理中」，燈箱裡顯示該輪標示（唯讀）。
   取捨：唯讀顯示要多一次 `/rounds/:id` 讀取，但能避免客人以為沒送出。
7. **草稿在重新交件後要不要保留？** 建議：綁 `delivered_at` + `final_folders`（同資料夾重複交件保留，換資料夾或 undeliver 後失效）。
   取捨：攝影師誤按取消交件再交件，客人沒送出的草稿會不見。
8. **挑片輪顯示全部已選照片還是只顯示有標示的？** 建議：有標示的在前，其餘收合「其他已選 N 張」延遲載入。
9. **歷史縮圖開放哪些尺寸？** 建議 400 + 1200（看得清楚標示），不開 1600。取捨：1200 已足夠辨識臉部細節；開越大越接近原檔。
10. **seat reset 之後，新座位持有人看得到之前的輪次嗎？** 建議：看得到（輪次屬於專案，跟 selections/notes 一樣）。
    注意：這與「their own frozen snapshots」字面上不同——若 Tim 的意思是「只看自己 picker_id 送的」，客人換手機後歷史會是空的。
11. **完成頁要不要顯示歷史？** 建議：不要（Tim 的決定只提到驗收頁；完成頁保持乾淨）。Worker 路由已允許，日後要加只改前端。
12. **舊的文字路由 `/api/pick/revision` 怎麼辦？** 建議：保留一個版本不動（快取中的舊頁面），UI 不再呼叫；下一次清理時移除。
    副作用：部署時若有專案正開著舊文字需求，客人要等攝影師交件後才能送標示。
13. **每次送出都寄信（不節流）？** 建議：是。上限由「同時一輪 + 每輪要攝影師交件」自然限制。
14. **精修燈箱要不要支援縮放後標示？** 建議：第一版不做，真機試過再說。取捨：不縮放在手機上點臉部細節不準，靠文字補；
    做縮放要碰 `FinalsGallery` 的手勢，成本約多 200k token 與一輪真機測試。
15. **要不要加 D1 trigger 凍結輪次？** 建議：先不加，由測試保證；Tim 若能確認 D1 Console 可貼多句 trigger，再加作為第二道鎖。

---

## 12. 風險與我不確定的地方

- **D1 的 JSON 輸出與 `JSON.stringify` 是否逐字相同**（`expect` 比對）：fake D1 是 node 的 SQLite，D1 也是 SQLite，
  但我沒有在真 D1 上驗證中文、引號的 key。若不可靠，改成只比排序後的 key 清單。
- **D1 batch 內 `INSERT … SELECT` 與 `json_group_object` 的大小**：446 KB 的快照在 bind 上限內，但我沒在真 D1 上測過接近上限的情況。
- **送出與交件幾乎同時**：送出先落地、交件後落地時，該輪會被這次交件立刻結案，攝影師可能沒看過。
  這是既有文字需求就有的問題；email 仍會寄出、後台看得到（已處理）。建議後台在「`resolved_at` 與 `created_at` 相差 < 1 分鐘」時加註。
- **手機上標示的準確度**：精修燈箱沒有縮放，`object-fit: contain` 的黑邊、iOS 的手勢、LINE 內建瀏覽器的工具列都可能讓點擊位置偏移；需要真機驗證。
- **EXIF 方向**：縮圖是上傳時在瀏覽器裡重畫的，標示座標以顯示方向為準；若有原檔方向和縮圖不一致的情況，位置會對不上。我沒有實際測過帶 EXIF 旋轉的檔案。
- **180 天 R2 生命週期**：較舊的輪次縮圖可能已被刪，歷史面板會出現「照片已不在雲端」；標示文字仍在。
- **blob fetch 的記憶體**：挑片輪最多 500 張縮圖，靠延遲載入與 revoke 控制；舊 iPhone 上沒有實測。
- **Token 估計**：`worker.js` 4,400 行、`pick.js` 2,100 行，agent 光讀上下文就很貴；估計誤差可能超過 ±40%。

---

## 13. 實作紀錄（Worker，2026-10-06）與本稿的差異

以下以程式與測試為準（`worker/worker.js`，`worker/test/revision-pins.test.mjs`、
`revision-rounds-gate.test.mjs`、`revision-security.test.mjs`）。

1. **草稿表欄位改名**：`revision_pins.delivery_at` / `delivery_finals`（本稿寫 `delivered_at` / `final_folders`）。
   原因：既有的 `pick-archive.test.mjs` 用整份 schema.sql 檢查「沒有 `delivered_at|final_folders`」來確認 fixture，
   用同名欄位會讓這個與本功能無關的檢查失效。意思不變：存檔當下專案的交件時間與 finals 原字串。
2. **`expect` 比對方式**：不比對 `json_group_array` 與 `JSON.stringify` 的逐字輸出（§12 的風險），
   改在 SQL 裡用集合比對：有效草稿數 = `expect` 項數，且每一項 `{k, n}` 都有一張草稿 key 相同、標示數相同。
   與順序無關、不靠序列化。`expect` 內 key 重複 → 400 `invalid_body`；`expect: []` 合法（→ `no_pins` 或 `draft_changed`）。
   `n` 必須是 1–10 的整數。
3. **送出 body 上限 128 KB**（`REVISION_ROUND_BODY_MAX`）：100 個 256 字元的 key（最壞 4 bytes/字）+ 1000 字總說明約 110 KB，
   16 KB / 64 KB 都不夠。
4. **寫入綁「路由讀到的那次交件」**：草稿存檔與送出的 SQL 都要求 `delivered_at` 與 `final_folders` 等於路由讀到的值。
   送出途中攝影師換資料夾／取消交件 → 409 `not_delivered`（本稿 §8 寫 `no_pins`/`draft_changed`；前端照 `not_delivered` 處理：請重新整理）。
5. **方法不對 → 405**（帶 `Allow`）；403 帶 `code: 'not_owner'`；404 帶 `code: 'not_found'`；
   縮圖路由的 `download` 參數（任何值）→ 400 `invalid_request`；`w` 出現兩次 → 400 `invalid_width`；`i` 出現兩次 → 404。
6. **總說明**：`note` 缺、`null`、空字串或只有空白 = 沒寫（存固定字、`message_auto = 1`）；非字串或超過 1000 字 → 400 `invalid_message`。
7. **原始碼掃描找到 2 處** `UPDATE revision_requests SET`（本稿 §3.4 寫至少 3 處）：兩種確認共用 `resolveRevisionsIfConfirmed`，
   所以原始碼只有它與 deliver 兩處；測試斷言 ≥ 2 處且每處只設 `resolved_at`，並斷言沒有 `DELETE FROM` / `REPLACE INTO` / `INSERT OR … INTO revision_requests`。
8. **縮圖 Content-Type 白名單**（安全審查新增）：只送 `image/jpeg|png|webp|avif`，其他（例如 `image/svg+xml`、`text/html`）一律標成
   `image/jpeg`，加 `nosniff`。不傳任何其他 R2 metadata（不會帶出 `Content-Disposition`）。
9. **`revision_open_photos`** 是「最新一個開著的**標示輪**」的照片數（舊文字需求同時開著也不影響）；沒有開著的標示輪 → `null`。
10. **歷史列表排序**：`selection`（最新一筆 submission）依 `created_at` 插入請求列之間；同時間時請求排前面。
11. **migration 偵測**：新路由用一個探測查詢同時確認 `revision_pins` 表與三個欄位都在，缺任何一個 → 500 `revision_pins_unavailable`
    （包含「只跑了 CREATE TABLE」與「只跑了 ALTER」兩種半套狀態）。state 在同樣情況下回 `revision_drafts: null`。
12. **排序**：`i` 用的 key 順序是 code point 順序（= SQLite BINARY 對 UTF-8 的順序），去重；列表、單輪、縮圖共用 `roundPhotoKeys`。
13. **既有測試的修改**（只因 schema / 契約擴充）：`client-confirm.test.mjs` 的 migration 測試（revision_requests 欄位比較排除三個新欄位）
    與 admin 列的欄位清單（加 `kind/marks/finals/message_auto/photo_count`）；`pick-projects.test.mjs` 的 migration 串列加上本檔。

### 13.1 API 契約（前端照這個寫）

共同：全部 `SHARED_LINK_HEADERS`（`Cache-Control: private, no-store`）。檢查順序：
401 連結 → 405 方法 → 403 座位 → 409 `not_delivered` → 413/400 body → （縮圖：400 `invalid_request`/`invalid_width`）→ 500 `revision_pins_unavailable` → 409 狀態/上限 → 寫入。

| 路由 | 成功 | 錯誤碼 |
|---|---|---|
| `PUT /api/pick/revision-pins` `{items:[{photo_key, marks}]}`（1–20 項，`marks: []` = 刪除） | 200 `{ok:true}` | 401；403 `not_owner`；409 `not_delivered`；413 `too_large`；400 `Invalid JSON`（無 code）/ `invalid_body` / `invalid_photo_key` / `invalid_marks`；403 `not_in_finals`；500；409 `already_confirmed` / `revision_open` / `revision_photos_cap`（`max:100`）/ `marks_cap`（`max:300`） |
| `POST /api/pick/revision-round` `{note?, expect:[{k, n}]}` | 200 `{ok, id, created_at, photo_count}` | 401；403；409 `not_delivered`；413；400 `Invalid JSON` / `invalid_body` / `invalid_message`（`max:1000`）；500；409 `already_confirmed` / `revision_open` / `no_pins` / `draft_changed` / `revision_cap`（`max:50`）/ `marks_cap` |
| `GET /api/pick/rounds` | 200 `{rounds:[{id, kind:'selection'\|'pins'\|'text', created_at, open, photo_count, has_note}]}`（新到舊，≤ 51） | 401；405；403；409 `not_delivered`；500 |
| `GET /api/pick/rounds/:id`（`selection` 或 UUID） | 200 `{id, kind, created_at, open, note, photos:[{i, name, pins:[{x,y,note}]}]}` | 同上 + 404 `not_found` |
| `GET /api/pick/rounds/:id/photo?i=<0–9999>&w=400\|1200` | 200 圖片（`Cache-Control: private, no-store`、`Vary: X-Share-Token, X-Picker-Key`、`nosniff`，不支援 Range） | 同上 + 400 `invalid_request`（有 `download`）/ `invalid_width`；404 `not_found` / `no_thumbnail` |

`GET /api/pick/state`（交件中、座位持有人才有）：`revision_drafts: [{photo_key, marks}] | null`（null = migration 未跑），
`revision_open_photos: number | null`；`revision_message` 在 `message_auto = 1` 時為 `null`。觀看者與非交件模式沒有這兩個 key。

`GET /api/admin/projects/:id` 的 `revision_requests[]` 多 `kind`（`'pins'|'text'`）、`marks`（`{key:[pins]}` 或 null）、
`finals`（陣列或 null）、`message_auto`（boolean）、`photo_count`。`message_auto` 為 true 時 `message` 是固定字，不要當客人的話顯示。

客人寫的字（`note`、pin 的 `note`、`name`）可能含 bidi 字元（U+202E 等，Worker 允許存）：顯示一律 `textContent` + `dir="auto"` +
`unicode-bidi: isolate`。

### 13.2 沒有驗證到的

- 真的 D1：`json_each` / `json_group_object` / 巢狀 `NOT EXISTS` 在 D1 上的行為只在 node:sqlite 上測過（D1 也是 SQLite，現有路由已用同類語法）。
- 接近 446,400 bytes 快照的 INSERT 在真 D1 上沒測過。
- `UPDATE projects SET id = id` 在 D1 上的 `meta.changes`（SQLite 語意是算到列；selections 存檔用的是同類寫法）。

---

## 14. 前端實作紀錄（2026-10-06／07）

程式是準。檔案與測試：

- 客人（驗收頁，座位持有人、已交件、未確認）：`js/revision-pins.js`（草稿 store、存檔佇列：debounce、重試、離開前 flush，
  對應 `PUT /api/pick/revision-pins`）、`js/pin-layer.js`（pin 資料規則與疊在 `<img>` 上的 pin 圖層，也被毛片標示共用）、
  `js/revision-history.js`（「上一輪的修改資訊」唯讀面板，pin 畫在舊照片上，縮圖走 `GET /api/pick/rounds/:id/photo`）、
  `js/delivery-done.js`（確認完成／「送出修改（N 張）」按鈕，從 `js/pick.js` 搬出；送出前會重讀 state，
  攝影師剛換過精修就擋下並請客人重新整理），`js/finals-gallery.js` 的 lightbox 掛勾；樣式 `css/revision-pins.css`。
- 攝影師：`js/revision-rounds-view.js`（一輪一張卡片：第 k 輪、標示 N 張、時間、客人、未處理／已處理、總說明；
  可摺疊的照片清單，pin 唯讀；點照片看 1200px；「下載此輪需求表 (CSV)」），`admin.html` 的交件區與
  `js/project-view.js`（`index.html?project=<id>`）共用；樣式 `css/revision-rounds-view.css`。
  照片用管理員憑證放在 Authorization header（fetch → blob），token 不進網址。
- 完成頁（已確認）沒有任何標示元素（§11 Q11）。migration 沒跑（`revision_drafts: null`）時，客人頁沒有標示相關元素。
- 瀏覽器測試：`test/suites/37-finals-pins-client.mjs`、`38-finals-pins-admin.mjs`（假 Worker：`test/lib/revision-pins-fake.mjs`）。
- 沒有真機驗證：iPhone Safari／LINE 內建瀏覽器上放 pin 與長清單的缺圖（舊輪縮圖超過 180 天會被 R2 刪掉，面板顯示「照片已不在雲端」）。
