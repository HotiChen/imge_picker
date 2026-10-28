# 轉出精挑相片 XMP（給 Lightroom）

專案詳情 → 照片卡 → 「轉出精挑相片 XMP」（在「下載需求表 (CSV)」旁邊）。把客人挑的照片轉成 Lightroom 認得的
sidecar `.xmp`，星等、色標、旗標一次帶進去，不用再手動標。

- 純前端：沒有 Worker 變更、沒有 migration，什麼都不寫進伺服器。
- 程式：`js/xmp-export.js`（純函式，node 可測）、對話框在 `admin.html`（`showXmpDialog`）。
- 測試：`test/unit/xmp-export.test.mjs`（node）、`test/suites/99w-xmp-export.mjs`（瀏覽器）。
- zip 用和「下載全部精修」同一個 cdnjs JSZip（3.10.1），admin.html 另外載入同一支。

## 設定（每項都可以「不設定」）

| 設定 | 選項 | 預設 |
|---|---|---|
| 星等 | 不設定 / 跟客人的星等（1–5）/ 固定 1–5 星 | 跟客人的星等 |
| 色標 | 不設定 / 紅 Red / 黃 Yellow / 綠 Green / 藍 Blue / 紫 Purple | Green |
| 有修改標示（釘子）的照片改用 | 跟上面一樣 / 另一個顏色 | Red |
| 旗標 | 不設定 / Pick | 不設定 |

設定存在這個瀏覽器的 localStorage（`xmp_export_settings_v1`），換瀏覽器要重設。localStorage 讀寫失敗時，對話框照常用預設值運作。
色標設成「不設定」時，釘子顏色不會單獨出現（選單會停用）。

## 轉出哪些照片

只轉客人挑了的（`rating >= 1`）。檔名 = `photo_key` 最後一段去掉副檔名，加 `.xmp`（`20260819/IMG_001.CR3` → `IMG_001.xmp`）。
不同資料夾有同名照片時（大小寫視為相同），只轉出第一張，其餘列在對話框的警告裡，不會互相覆蓋。
檔名裡的路徑符號、控制字元會被拿掉；拿掉後是空的就跳過並提示。
zip 檔名 `<專案名稱>-xmp.zip`，內容是這些 `.xmp` 加一份 `README.txt`。客人的備註、釘子文字不會進 XMP。

## XMP 內容範例

只有開啟的設定會出現在 `rdf:Description` 上；`begin="…"` 引號內是一個 BOM 字元（U+FEFF）。

```xml
<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="imge-picker">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpDM="http://ns.adobe.com/xmp/1.0/DynamicMedia/" xmp:Rating="4" xmp:Label="Green" xmpDM:pick="1"/>
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
```

## 在 Lightroom 試一次

1. 下載 zip，**不要解壓縮到已經有 `.xmp` 的資料夾**：同名的 `.xmp` 會被蓋掉，Lightroom 裡已經調好的修圖設定也會不見。
2. 把 `.xmp` 放在 RAW 檔旁邊，檔名相同（`IMG_001.CR3` 配 `IMG_001.xmp`）。
3. 在 Lightroom 選取這些照片 → 中繼資料 (Metadata) → 從檔案讀取中繼資料 (Read Metadata from File)。
4. 星等、色標應該出現在照片上。先拿一兩張試，確認沒問題再大量用。

## 還沒驗證的

- **沒有用真正的 Lightroom 試過。** 星等 (`xmp:Rating`) 和色標 (`xmp:Label`) 是標準 XMP 欄位；色標只用 Lightroom 預設色標組的英文名稱
  （Red / Yellow / Green / Blue / Purple），如果你改過色標組，名字對不上就不會顯示。
- **旗標 (`xmpDM:pick`) 特別沒驗證**：不確定 Lightroom 是否從 sidecar 讀這個欄位。請先拿一張照片試，沒出現就把旗標設成「不設定」。
- 其他 Lightroom 版本（Classic / 雲端版）、Capture One、Bridge 沒測。
- 已經在 Lightroom 目錄裡的照片，「從檔案讀取中繼資料」會以檔案為準蓋掉目錄裡的星等 / 色標。
