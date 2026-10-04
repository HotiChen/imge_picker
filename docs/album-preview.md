# Album preview: the layout engine

Status: engine built; stage 1 guest preview built (see "Stage 1: the guest preview" at the end). Roadmap anchor:
`docs/backlog.md` THE ORDER #3 "Album chain" and `docs/guest-shop.md` S3.

## Goal

After delivery the client opens the finish page and sees **an album laid out
from their own finals**, automatically, in the browser. Stage 1 is preview
only: nothing is saved, nothing is ordered. The photographer can later offer
it as a purchase. Everything is local arithmetic on the `?w=400` thumbnails
(no AI, no external service, no EXIF, no original downloaded).

| Stage | What the client gets | Maps to `guest-shop.md` | Needs |
|---|---|---|---|
| 1 | Read-only preview, page flip, 「換風格 / 調整照片」 not yet | S3 minus the line/controls | this engine + `js/album-preview.js` with a hook in `js/pick.js` (built) |
| 2 | Product info beside it: album options, price, page/photo counts | S1 (購買資訊) | S1 worker/UI |
| 3 | 「加入購物車」 stores the layout on the order line; photographer checks and prints | S2 + S3 worker (`order_items.layout`, validator + parity test) | S2/S3 worker, security review |

## Files

- `book_editor/js/auto_layout.js`: the engine. Adds one global, `AutoLayout`.
  Loading it has no side effects (no DOM, no network).
- `book_editor/js/layouts.js`: unchanged. The guest page needs it for
  `LAYOUTS`, `renderPageHTML` (full-size page) or `renderPageThumbnailHTML`
  (small, 400 px), `fitCoverImage`. Load order: `config.js`, `layouts.js`,
  `auto_layout.js`. It does **not** need `book_editor.js`, `drive.js` or
  `exporter.js`.
- Tests: `node --test book_editor/test/auto_layout.test.mjs` (pure, ~2 s; CI
  does not run it). Browser: the suite "auto layout — the smart style and the
  old styles in the editor, on real pixels" in `test/run.mjs`.

## API

```
AutoLayout.analyze(photoIds, { urlFor(id) -> url, loadImage?(url, {signal, aspectOnly}) -> Promise<ImageLike>,
                               pixelsOf?(image, w, h) -> RGBA bytes, concurrency = 6, signal?, aspectOnly? })
  -> Promise<Array<{ id, ok, aspect, orientation: 'landscape'|'portrait'|'square',
                     hash /* dHash, 16 hex, '' = unknown */, sharpness, focus: {x, y} /* 0.2..0.8 */ }>>

AutoLayout.plan(items /* analyze() output */, { style = 'auto', layouts, pages, pageAspect = 1, coverAspect = pageAspect,
                                                 hashThreshold = 6, window = 5, order = 'natural' })
  -> { cover: { photoId, crop } | null,
       pages: [{ id, type: 'inner', layout, slots: [{ photoId, crop: {x, y, scale: 1} }], bg: '#ffffff' }],
       dropped: [{ id, reason: 'duplicate', of } | { id, reason: 'failed' }] }

AutoLayout.run(photos, style)   // the editor's five old styles; same output as before
AutoLayout.DEFAULTS             // the numbers below
AutoLayout.util                 // pure helpers (tests): naturalCompare, dHash, hamming, sharpnessOf, focusOf, cropFor, toGray
```

- `analyze` never rejects because of one photo (it comes back `ok: false`,
  `aspect: 1`, empty hash). It rejects with `AbortError` when `signal` fires.
  At most `concurrency` loads are in flight. The default loader sets
  `crossOrigin = 'anonymous'` (the Worker answers photo reads with
  `Access-Control-Allow-Origin: *`); if that load fails it retries plain, so
  the photo is still laid out by shape but has no hash/sharpness (`hash: ''`
  is never a duplicate of anything). A tainted canvas is handled the same way.
- `plan` is pure and deterministic: no `Math.random`, no DOM, no clock; the
  same input gives byte-identical output. It never mutates `items`.
- `pageAspect` = page width / height as the book will be printed (editor:
  `book.settings.width / height`; default 1 = square). The slot shapes, and so
  every crop, depend on it. `coverAspect` likewise for the cover.
- `order: 'given'` keeps the caller's order instead of sorting by file name
  (use it if the delivered gallery has its own order).
- `layouts`: a `{id: layoutDef}` whitelist. Default = the six built-ins out of
  the global `LAYOUTS` (never `custom-*`). A whitelist must contain a
  single-photo layout, or `plan` throws (it cannot seat an odd photo).
- `style`: only `'auto'`; anything else throws (the old styles live in `run`).
- Apply a result to the editor with ids made unique (`page-auto-<time>-<n>`),
  as `book_editor.js` `_planSmartLayout` / `runAutoLayout` does.

## The 'auto' rules and defaults

1. **Order.** Natural sort of the id (`IMG_9` < `IMG_10`, case-insensitive,
   numbers as numbers) stands in for shooting order. Thumbnails carry no EXIF.
2. **Duplicates.** dHash 9x8 grey; sharpness = variance of the 4-neighbour
   Laplacian on a 32x32 grey. A shot within `window` (5) positions of a kept
   shot, at Hamming distance <= `hashThreshold` (6 of 64 bits), is the same
   picture. The sharpest of a group survives (the earlier on a tie), the rest
   go to `dropped` with `of` = the survivor. Compared against kept shots only,
   not transitively: a slow pan through similar frames is not one picture.
   The same id twice counts as a duplicate of itself. Failed loads (or a
   non-positive aspect) go to `dropped` with `reason: 'failed'`.
3. **Pacing** (dynamic programming over the order; a page is the next k photos
   poured into a k-slot layout, seated to minimise crop loss):
   - cost of a slot = share of the photo cut away (heavier past 45%, never
     below 40% kept unless the rules make that impossible), so two portraits
     go side by side (`2-up-h`) and two landscapes stack (`2-up-v`) on a
     square page; on a spread (`pageAspect` 2) the same arithmetic picks what
     fits;
   - **hero** (`full-bleed`): at most 1 in any 4 consecutive pages; cheaper for
     sharp photos, +0.8 for a photo of the wrong orientation (landscape on a
     square or wide page); the cover photo is kept off it (it is already that picture);
   - never the same layout three pages running (twice costs a little);
   - the last page is not a lone photo unless it is a full-bleed closer (or the
     whole book is one photo);
   - a 3-slot layout takes no mixed orientation (square counts as either);
   - single non-hero pages (`1-up`) are the costly choice, groups of 2-4 the
     cheap one;
   - page count: target `round(n / 2.5)` (at least `n / 4`) as a soft pull; an
     explicit `pages` is hit as closely as the rules allow. Rule order when
     the layouts cannot satisfy everything: first allow squeezing a photo,
     then drop the run rule, then the hero cap, then the last-page rule.
4. **Cover.** Among survivors whose shape keeps >= 60% of the photo in the
   cover, the sharpest (the earlier on a tie). Not just "first". With 4+
   photos it also appears inside the book (nothing is wasted on the cover);
   with 2 or 3 it does not (a cover plus the same photo as the only page is
   silly); with 1 it does.
5. **Crop focus.** `focus` = centre of gradient energy of the 32x32 grey,
   clamped to 0.2..0.8. In a slot the photo is drawn exactly as
   `fitCoverImage` / `exporter.js` draw it at `scale: 1` (only one axis
   overflows). `crop.x` (or `crop.y`) = `r * (0.5 - focus)` with `r` the
   overflow factor, clamped to what keeps the slot covered and truncated
   toward zero. So the subject moves toward the middle as far as the photo
   allows and the photo never leaves a gap. `scale` stays 1: no enlarging, so
   no resolution lost.

Cost: n = 300 plans in ~0.1 s, n = 1000 in ~0.25 s on the main thread.
`analyze` is the slow part (network + one canvas read pair per photo).

## Not done, and why

- **Faces.** `FaceDetector` does not exist in Safari, which is most of the
  clients. A subject-aware crop is the gradient centroid for now; a face
  detector can later feed `focus` without changing the contract.
- **EXIF time / burst grouping by time.** The thumbnails have no EXIF and the
  originals must not be fetched for a preview (size, and the original gate).
  File-name order is the proxy. Real grouping (by scene) would need the
  originals or a thumbnail EXIF carried at upload time.
- **AI** layout or selection: parked in THE ORDER; this engine is rule-based
  and must be called 自動編排, not "AI 編排".
- **Ratings.** The client has none; the photographer's ratings are used by
  the old editor styles only.
- Manual editing on the phone, saving, ordering: stages 2 and 3.

## Needs real photos to confirm

- Is `hashThreshold` 6 / `window` 5 right for real bursts and for wedding
  sets with many similar-looking shots (white dress, same wall)?
- Do the focus crops look natural, or is a gradient centroid too naive on
  portraits (a centred face with a busy background pulls the crop)?
- Safari / LINE in-app browser: the `crossOrigin` image + canvas read, and
  speed with 200+ thumbnails on a phone.

## Stage 1: the guest preview (built)

Files: `js/album-preview.js` (new, loaded by `index.html` after `pick.js`; one
global, `AlbumPreview`), a hook in `js/pick.js` (`_renderAlbumEntry`, called
from `_applyView`), a block of new `.album-*` classes at the end of
`css/styles.css`. No `:root` change, no `book_editor/` or `worker/` change.
Browser suites: "album preview …" in `test/run.mjs`.

**What the guest sees.** In the delivered gallery (`mode === 'delivered'` and
the finals view, with at least one final folder) one row sits right under the
確認完成 block: 「✨ 看看你的照片排成相本」 and 「這是系統自動排版的示意，實際相本可
由攝影師調整」. Owner and viewers both get it (read-only). It is **removed from
the DOM** while picking, after 取消交件 / 退回挑片 (the finals stay on the
project but `delivered_at` is null, so the mode is `picking`) and in the
下載毛片原檔 list. Pressing it opens a full-screen dark viewer: progress
「正在為你排版… 23/120」 with 取消 → the cover (`封面`) and the inner pages
(`n / 總頁`), flipped by ‹ ›, ← →, or a swipe. Esc / ✕ close it and give the
focus back to the entry.

**Loading.** Nothing of the engine is loaded before the press. The press loads
`book_editor/js/layouts.js` then `auto_layout.js` (a script tag each, once per
page life) with the **same `?v=` as `album-preview.js` itself**, read from its
own `document.currentScript.src` (fallback: the `pick.js` tag) — no version
string is written in the code. `book_editor.js` / `exporter.js` are never loaded.
`layouts.js` adds 12 globals (it overrides none on this page; checked by grep).

**Pipeline.** (1) list the finals: `GET /?list=<folder>` for each final folder
and, recursively, every subfolder (never outside them, 4 at a time, at most
`LIST_MAX_FOLDERS` = 200 folders); (2) natural-sort the ids
(`AutoLayout.util.naturalCompare`, the engine's own shooting-order proxy — the
duplicate window needs `IMG_9` before `IMG_10`, which the gallery's
`localeCompare` would not give) and keep the first `MAX_PHOTOS` = 240, saying
「已先用前 240 張排版」; (3) `AutoLayout.analyze` on `CHUNK` = 24 photos at a
time (it has no progress callback; chunking gives real progress and the same
result, since every photo is measured on its own), all with one
`AbortController`; (4) `AutoLayout.plan(items, {style:'auto', pageAspect: 1,
coverAspect: 1})`; (5) render. Order of the photos is not the gallery's
per-folder name sort but the natural order above (the gallery has no order of
its own beyond that sort).

**pageAspect = 1: one square sheet at a time.** The editor's default book is
20 x 20 cm for pages and cover, `view.html` shows one sheet at the book's own
aspect, and a spread (2) would be about 195 px tall on a 390 px phone. The same
constant goes to `plan` and to the renderer.

**Rendering.** Built with DOM calls (no `innerHTML`; a photo key never becomes
markup — `renderPageHTML` writes keys into HTML strings, adds the editor's
x / right-click buttons and fixes the width at 1600). Each slot draws its photo
with `fitCoverImage` from `layouts.js` (re-run on rotation / resize), so the
crop is the one the exporter draws. Only the current page and its two
neighbours exist in the DOM (at most 3 pages, ≤ 12 `<img>`), all
`decoding="async"`; they slide by CSS (`--cur`, `--drag`), no timers.
Photo widths: `?w=400` for analysis, then the bucket `driveManager.previewWidth`
gives for the displayed size (400 / 1200 / 1600, the Worker's pre-generated
thumbnails: `THUMB_BUCKETS`; a 390 px DPR 3 phone asks 1200). An original is
never requested (no `?w=`-less URL, no `download=1`).

**Notes line** (small, muted, only when non-empty): 「已略過 N 張相近的照片」,
「已先用前 240 張排版」, 「N 張照片讀取失敗，未放入相本」.

**States.** Fewer than 2 usable photos (after dropping repeats) → 「至少需要 2
張不同的照片，才能排成相本」, no album. Listing / engine load failure, or every
photo failing → an error with 重試 (a new run). Cancel aborts the analysis
(`signal`), the in-flight loads are cancelled and nothing is left: no request,
no timer, no listener on `window` / `document` (tested over repeated
open / close).

**Touch.** One finger only; a drag turns horizontal after 10 px if clearly
more sideways than down; it flips at max(40 px, 12% of the width). A touch that
starts within 24 px of a screen edge is ignored (the system's back gesture);
`touch-action: pan-y` and `overscroll-behavior: none` keep it from fighting
the page, and the page behind is locked (`html.album-open`).

**No writes, no storage.** No POST / PUT, nothing in `localStorage` /
`sessionStorage`; every open recomputes (the plan is deterministic).

**Known limits / not done.** Not on the phone yet (needs a real device): the
crossOrigin canvas read in iOS Safari / the LINE in-app browser (if it fails,
the engine lays photos out by shape only: no duplicate detection, no focus
crop); swipe vs. the browser's own gestures; speed and memory at 100+ photos
(each open re-analyses; there is no cache between opens); the bottom bar of
the browser (the viewer uses `100dvh` and `env(safe-area-inset-*)`). No pinch
zoom in the viewer (`touch-action: pan-y`). No style change, no photo swap, no
saving, no purchase button, no price (stages 2 and 3). `analyze` has no
`onProgress`; adding one would let the chunking go.
