# Album preview: the layout engine

Status: engine built; stage 1 guest preview built (see "Stage 1: the guest preview" at the end); the preview is now
an **A4 portrait album with a single-page cover and two-page spreads** (see "A4 album: spreads and the template
library"). Roadmap anchor: `docs/backlog.md` THE ORDER #3 "Album chain" and `docs/guest-shop.md` S3.

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
- `book_editor/js/spread_templates.js`: the spread template library (data plus a
  validator). Adds one global, `SpreadTemplates`; also `module.exports` for node.
  No side effects. Only `AutoLayout.planSpreads` and the guest viewer use it.
- `book_editor/js/layouts.js`: unchanged. The guest page needs it for
  `LAYOUTS`, `renderPageHTML` (full-size page) or `renderPageThumbnailHTML`
  (small, 400 px), `fitCoverImage`. Load order: `config.js`, `layouts.js`,
  `auto_layout.js`. It does **not** need `book_editor.js`, `drive.js` or
  `exporter.js`.
- Tests (pure, seconds, CI does not run them): `node --test book_editor/test/auto_layout.test.mjs`
  (analyze / plan / run, with the legacy golden), `book_editor/test/spread_templates.test.mjs`
  (every template through the validator, and the validator against bad data) and
  `book_editor/test/plan_spreads.test.mjs` (the spread planner). Browser: the
  suite "auto layout — the smart style and the old styles in the editor, on real
  pixels" and the "album preview …" suites in `test/run.mjs`.
- `node book_editor/test/render-templates.mjs [outDir]` draws the library and sample plans as PNGs (see
  "Seeing the library").

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

AutoLayout.planSpreads(items, { templates, coverAspect = 210/297, spreadAspect = 420/297, hashThreshold = 6, window = 5,
                                maxPerFace = 4, seed = 0, order = 'natural', back = false })
  -> { cover: { photoId, crop } | null,
       spreads: [{ id: 'spread-n', template: <template id>, slots: [{ photoId, crop: {x, y, scale: 1}, slot: {x, y, w, h, face} }] }],
       back: null | {},                       // {} = a blank closing page (only with back: true and a book to close)
       dropped: [ same as plan ] }            // see "A4 album: spreads and the template library"

AutoLayout.run(photos, style)   // the editor's five old styles; same output as before
AutoLayout.DEFAULTS             // the numbers below
AutoLayout.SPREAD_DEFAULTS      // the planSpreads numbers (price per spread, hero gap, ...)
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

## A4 album: spreads and the template library

The guest album is A4 portrait (210 x 297 mm). The **cover and back are one
page** (aspect 0.7071); the inside is **spreads**, two A4 pages side by side
(420 x 297 mm, aspect 1.4142). **At most 4 photos on each page of a spread**
(so 8 on a spread), only a through-spread (`hero`) may put a photo across the
fold. `plan` (the square-page engine above) is unchanged and still used by the
editor; the guest viewer calls `planSpreads`.

### Template data (`book_editor/js/spread_templates.js`)

```
{ id, name, tags, facing: { left, right }, margin?, gutter?,
  slots: [{ x, y, w, h, face: 'left' | 'right' | 'span', prefer: 'landscape' | 'portrait' | 'any' }] }
```

- `x, y, w, h` are fractions (0..1) of the **whole spread**: x and w of the
  420 mm width, y and h of the 297 mm height. The left page is x in [0, 0.5], the
  right page x in [0.5, 1]. `span` crosses the fold (x < 0.5 < x + w).
- Slots are in reading order (left page first, top to bottom, left to right).
- `facing` = how many slots on each page (span slots are not counted); it is
  stored, not derived, and the validator checks it against the slots.
- `prefer` = the slot's own shape (w/h >= 1.05 landscape, <= 1/1.05 portrait, else
  `any`); the planner decides by real crop loss, `prefer` is for people and tools.
- `margin` (outer) and `gutter` (between photos) are millimetres and informational.
- `tags[0]` is the **family**: the planner never puts one family on three spreads
  running. The tag vocabulary is `SpreadTemplates.TAGS` (hero, single, pair, 1-2,
  3-up, 1-3, 2+2, 3+3, 4+4, grid, collage, mosaic, stagger, band, quiet, golden,
  mixed). **`hero` is the only tag that may have a `span` slot, and has exactly one.**
- The data are frozen at load. To add a template: add an entry to `TEMPLATES`,
  run `node --test book_editor/test/spread_templates.test.mjs` (it names the
  template and the rule it breaks), and look at it with `render-templates.mjs`.

`SpreadTemplates.validate(templates)` -> `{ ok, errors: [{ id, code, message }] }`
(never throws, never modifies). Every template must pass:

| code | rule |
|---|---|
| `bad-id`, `dup-id` | an id string, unique |
| `no-slots`, `bad-slot` | at least one slot, finite x, y and positive w, h |
| `bad-tag` | a non-empty list of known tags, none twice |
| `out-of-range` | every slot inside the spread (0.2 mm slack) |
| `overlap` | no two slots overlap (touching is fine) |
| `face-mismatch`, `crosses-fold` | a `left` slot lies in x <= 0.5, a `right` one in x >= 0.5 (0.2 mm slack), a `span` one really crosses |
| `span-not-hero`, `hero-without-span` | only `hero` templates have a span slot (one), and every `hero` has it |
| `face-limit` | at most 4 slots on each page |
| `too-small` | no slot under 25 mm either way, measured on the 420 x 297 mm spread |
| `prefer-mismatch` | `prefer` is a known word and agrees with the slot's shape |
| `facing-mismatch` | `facing` equals the real count per page |

### The library (43 templates; 5 / 4 / 6 / 9 / 6 / 5 / 5 / 3 for 1 ... 8 photos)

| id | 名稱 | 張數 | 左+右 | tags |
|---|---|---|---|---|
| `hero-bleed` | 通頁滿版 | 1 | 0+0+通頁1 | hero, single |
| `hero-frame` | 通頁留白相框 | 1 | 0+0+通頁1 | hero, quiet |
| `hero-wide` | 通頁寬幅 | 1 | 0+0+通頁1 | hero, band |
| `solo-right` | 右頁單張留白 | 1 | 0+1 | single, quiet |
| `solo-left` | 左頁單張留白 | 1 | 1+0 | single, quiet |
| `pair-portraits` | 左右各一直式 | 2 | 1+1 | pair, quiet |
| `pair-stagger` | 上下錯落兩張 | 2 | 1+1 | pair, stagger |
| `pair-bleed-small` | 左滿版右小圖 | 2 | 1+1 | pair, mixed |
| `pair-landscapes` | 左右各一橫式 | 2 | 1+1 | pair, quiet |
| `one-two-right` | 左大右二小 | 3 | 1+2 | 1-2, mixed |
| `two-one-left` | 左二小右大 | 3 | 2+1 | 1-2, mixed |
| `one-two-golden` | 左大右二小（黃金比） | 3 | 1+2 | 1-2, golden |
| `one-two-wide` | 左橫圖右二橫圖 | 3 | 1+2 | 3-up, band |
| `three-portraits` | 左直式右雙直式 | 3 | 1+2 | 3-up, quiet |
| `triptych` | 左橫圖右雙直幅 | 3 | 1+2 | 3-up, quiet |
| `big-three` | 左大圖右三小 | 4 | 1+3 | 1-3, mixed |
| `three-big` | 左三小右大圖 | 4 | 3+1 | 1-3, mixed |
| `quad-stacks` | 左右各上下兩張 | 4 | 2+2 | 2+2, grid |
| `quad-columns` | 左右各雙直幅 | 4 | 2+2 | 2+2, quiet |
| `gallery-4` | 直式四連幅 | 4 | 2+2 | 2+2, quiet |
| `quad-stagger` | 四張錯落 | 4 | 2+2 | 2+2, stagger |
| `wide-three-one` | 左三橫條右橫圖 | 4 | 3+1 | 1-3, band |
| `cascade-4` | 橫圖階梯 | 4 | 2+2 | 2+2, stagger |
| `hero-strip` | 通頁大圖加三小 | 4 | 1+2+通頁1 | hero, band |
| `grid4-big` | 左四宮格右大圖 | 5 | 4+1 | grid, mixed |
| `big-grid4` | 左大圖右四宮格 | 5 | 1+4 | grid, mixed |
| `collage-5a` | 拼貼五張（寬圖加雙格） | 5 | 3+2 | collage, mixed |
| `collage-5b` | 拼貼五張（直幅領頭） | 5 | 3+2 | collage, stagger |
| `five-wide` | 五張橫圖 | 5 | 3+2 | collage, band |
| `portrait-five` | 直式五連幅 | 5 | 2+3 | collage, quiet |
| `portrait-six` | 左右各三連幅 | 6 | 3+3 | 3+3, quiet |
| `trios` | 左右各一大兩小 | 6 | 3+3 | 3+3, mixed |
| `triple-bands` | 左右各三橫條 | 6 | 3+3 | 3+3, band |
| `triple-ladder` | 左右各一直二小（階梯） | 6 | 3+3 | 3+3, collage |
| `triple-airy` | 左右各三張（寬鬆留白） | 6 | 3+3 | 3+3, quiet |
| `collage-3-4` | 左三右四拼貼 | 7 | 3+4 | collage, mosaic |
| `collage-4-3` | 左四右三拼貼 | 7 | 4+3 | collage, mosaic |
| `mosaic-7` | 大圖加小圖馬賽克 | 7 | 4+3 | mosaic, collage |
| `seven-wide` | 七張橫條 | 7 | 3+4 | collage, band |
| `portrait-seven` | 直式七張（一大兩小加四宮格） | 7 | 3+4 | mosaic, quiet |
| `grid-4-4` | 左右各四宮格 | 8 | 4+4 | 4+4, grid |
| `mosaic-4-4` | 左右各一大三小 | 8 | 4+4 | 4+4, mosaic |
| `bands-4-4` | 左右各四橫條 | 8 | 4+4 | 4+4, band |

Shapes include one-big-two-small both ways (also on a golden-ratio cut), one big
and three small both ways, 2+2 (stacked, in columns, staggered, a four-up
gallery), a four-up grid beside a big picture and its mirror, 3+3, 4+4 (grid,
mosaic, strips), staggered pairs, quiet single pages, a bleed-free frame around a
through-spread and a through-spread with a strip of three below it. Some are made
for landscape photos (bands, strips, cascades), some for portraits (galleries,
portrait grids), some for both.

### Seeing the library

`NODE_PATH=<playwright> node book_editor/test/render-templates.mjs <outDir>` writes
`templates.png` (every template as coloured boxes with the slot numbers, the fold,
id, name, count and tags) and `plan-40.png`, `plan-5.png`, `plan-3.png`,
`plan-2.png`, `plan-1.png` (what `planSpreads` makes of sample photo sets, drawn
with the real `fitCoverImage` crops).

### `planSpreads`: rules, defaults, trade-offs

Same first steps as `plan`: natural order of the ids (`order: 'given'` keeps the
caller's), the same dedupe (dHash, `hashThreshold` 6, `window` 5, the sharpest of
a group survives, `dropped` has the same shape), the same cover pick (now against
`coverAspect` 0.7071, so a portrait wins) and the same focus crop (`crop` is
computed for the slot's own shape, covers the slot with no gap, `scale` stays 1).
Pure and deterministic (no `Math.random`, clock or DOM), never mutates `items`.

- **How many photos where.** One photo: the cover only, no spread. Two or three: the
  cover plus exactly one spread with the others (the cover photo is not repeated). Four
  or more: the cover photo also appears inside, as in `plan`.
- **Choosing templates** is a dynamic programme over the shooting order: a spread is
  the next k photos poured into a k-slot template, seated by an optimal assignment
  (Hungarian) that minimises crop loss with a small pull to keep the shooting order
  along the reading order. A spread costs its seating + a price (0.55) + a rhythm
  charge by photo count (2 or 3 photos is sparse, 4 to 6 is the sweet spot, 7 and 8
  are busy: 0.3, 0.14, 0.04, 0, 0.1, 0.25, 0.4) + a small jitter that depends on the
  template id, the position and `seed` (so equal templates take turns; another
  `seed` gives another valid book, the same one the same bytes).
- **Hard rules** (relaxed one at a time, the last first, only when they cannot hold):
  the next spread never uses the same template; one family never on three spreads
  running; a `hero` spread needs 4 other spreads before the next (at most 1 in any 5);
  a lone photo only on a hero spread, and the last spread is never a stray non-hero
  photo (unless the whole book is one photo); every page holds at most `maxPerFace`
  (4) photos; only `hero` templates may cross the fold (also checked here, for
  libraries passed in).
- **Hero spreads** pay for a blurry or non-landscape photo and are never the cover
  photo, and earn a bonus (0.65): the sharpest landscapes get them, as often as the
  cap allows (about 1 spread in 10 for a landscape-heavy book).
- **Variety**: the cheapest book leans on a few templates, so it is polished after the
  fact: each spread tries the other templates with the same number of slots and
  takes a swap when it lowers (cost + a charge for the same template again within 2,
  3, 4 or more spreads, 0.5 / 0.35 / 0.2 / 0.1) — hard rules re-checked on each
  candidate.
- **Trade-offs.** Photos keep their shooting order inside a spread and across the
  book, so a hero can only land where the group boundaries fall on a good photo; a
  book of one shape (all landscape, all portrait) has fewer fitting templates and
  repeats more (about 4 to 6 different ones in 40 photos) — more templates for that
  shape is the fix, not a looser rule. A 40-photo mixed book makes 8 to 12 spreads
  (about 4.4 photos a spread). 240 photos plan in about 0.1 s.
- **Errors.** A `templates` list that cannot seat the photos (no template for the
  counts needed, empty) throws `AutoLayout.planSpreads: the templates given cannot seat ...`;
  without the `templates` option it needs the global `SpreadTemplates` (throws and
  says to load `spread_templates.js`). A template with a broken slot is skipped.
- `back: true` returns `back: {}` (a blank closing page) when there is a book to
  close; the default is `null`. Nothing puts a photo on the back yet.

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
- Manual editing on the phone, saving, ordering: stages 2 and 3. In particular
  **not built yet for the A4 album: swapping a photo, picking another template for a
  spread, saving the layout, a share link of its own, and face detection** (the
  focus is still the gradient centroid).

## Needs real photos to confirm

- Is `hashThreshold` 6 / `window` 5 right for real bursts and for wedding
  sets with many similar-looking shots (white dress, same wall)?
- Do the focus crops look natural, or is a gradient centroid too naive on
  portraits (a centred face with a busy background pulls the crop)?
- Safari / LINE in-app browser: the `crossOrigin` image + canvas read, and
  speed with 200+ thumbnails on a phone.

## Stage 1: the guest preview (built)

Files: `js/album-preview.js` (loaded by `index.html` after `pick.js`; one
global, `AlbumPreview`), a hook in `js/pick.js` (`_renderAlbumEntry`, called
from `_applyView`), a block of `.album-*` classes near the end of
`css/styles.css`. No `:root` change, no `worker/` change. Browser suites:
"album preview …" in `test/run.mjs`. (Stage 1 first laid the album out as square
single pages; it is now the A4 cover + spreads described here.)

**What the guest sees.** In the delivered gallery (`mode === 'delivered'` and
the finals view, with at least one final folder) one row sits right under the
確認完成 block: 「✨ 看看你的照片排成相本」 and 「這是系統自動排版的示意，實際相本可
由攝影師調整」. Owner and viewers both get it (read-only). It is **removed from
the DOM** while picking, after 取消交件 / 退回挑片 (the finals stay on the
project but `delivered_at` is null, so the mode is `picking`) and in the
下載毛片原檔 list. Pressing it opens a full-screen dark viewer: progress
「正在為你排版… 23/120」 with 取消 → the cover (`封面`, one A4 page, centred), the
spreads (`n / 總跨頁`), and the back (`封底`) if the plan has one, flipped by ‹ ›,
← →, or a swipe. Esc / ✕ close it and give the
focus back to the entry.

**Loading.** Nothing of the engine is loaded before the press. The press loads
`book_editor/js/layouts.js`, `spread_templates.js`, then `auto_layout.js` (a script
tag each, once per page life) with the **same `?v=` as `album-preview.js` itself**,
read from its own `document.currentScript.src` (fallback: the `pick.js` tag) — no
version string is written in the code. `book_editor.js` / `exporter.js` are never
loaded. `layouts.js` adds 12 globals (it overrides none on this page; checked by
grep; it is only here for `fitCoverImage`), `spread_templates.js` adds `SpreadTemplates`.

**Pipeline.** (1) list the finals: `GET /?list=<folder>` for each final folder
and, recursively, every subfolder (never outside them, 4 at a time, at most
`LIST_MAX_FOLDERS` = 200 folders); (2) natural-sort the ids
(`AutoLayout.util.naturalCompare`, the engine's own shooting-order proxy — the
duplicate window needs `IMG_9` before `IMG_10`, which the gallery's
`localeCompare` would not give) and keep the first `MAX_PHOTOS` = 240, saying
「已先用前 240 張排版」; (3) `AutoLayout.analyze` on `CHUNK` = 24 photos at a
time (it has no progress callback; chunking gives real progress and the same
result, since every photo is measured on its own), all with one
`AbortController`; (4) `AutoLayout.planSpreads(items, { ...AlbumPreview.PLAN_OPTS, coverAspect: 210/297,
spreadAspect: 420/297 })`; (5) render. Order of the photos is not the gallery's
per-folder name sort but the natural order above (the gallery has no order of
its own beyond that sort).

**Shapes.** The cover and back are one A4 portrait page (0.7071), a spread is 1.4142.
Phone and desktop both show spreads: on a 390 px upright phone a spread takes the
whole width (no side gutter), about 390 x 276; the cover keeps a 16 px side gutter;
a landscape phone (height <= 500) uses 12 / 8 px gutters; a desktop 24 px. The same
constants go to `planSpreads` and to the renderer, so a crop is drawn on the shape it
was made for. A spread has a soft shade down its middle (`::after`, over the photos)
to show the fold.

**Rendering.** Built with DOM calls (no `innerHTML`; a photo key never becomes
markup — `renderPageHTML` writes keys into HTML strings, adds the editor's
x / right-click buttons and fixes the width at 1600). Each slot draws its photo
with `fitCoverImage` from `layouts.js` (re-run on rotation / resize), so the
crop is the one the exporter draws. Only the current page and its two
neighbours exist in the DOM (at most 3 pages, ≤ 24 `<img>`: a spread holds up to 8), all
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

**Zoom, pan and the swipe.** Once the album is up the stage takes every touch itself
(`touch-action: none`, `overscroll-behavior: none`, the page behind locked by
`html.album-open`, `user-select: none`), so zooming never scrolls the page or starts
the browser's own pinch or back gesture.
- **Double tap** (two taps within 300 ms and 40 px) or **double click**: 2.5x about the
  spot, a second one restores 1x. A tap is a touch that moves under 10 px and lasts
  under 350 ms. A double click that follows a touch double tap is ignored.
- **Pinch** (two fingers): 1x to 4x, anchored on the middle of the fingers (the picture
  point between them follows them); ending below 1.02x lands on exactly 1x. **Wheel**:
  zooms about the cursor (ctrl+wheel / trackpad pinch faster), clamped 1x to 4x.
- **Pan**: one finger (or the mouse, while zoomed) drags the picture, held inside what
  keeps the page covering the window on every side it is bigger than (never a blank
  edge; a spread on a phone at 2.5x is wider than the window but a little shorter, so it
  pans sideways and stays centred up and down).
- **No flipping while zoomed**: a one-finger swipe pans instead; ‹ ›, ← → still flip, and
  the new page always starts at 1x (so does a resize / rotation). Swiping flips again
  at 1x. One finger only flips: a drag turns horizontal after 10 px if clearly more
  sideways than down, and flips at max(40 px, 12% of the width). A touch that starts
  within 24 px of a screen edge is ignored (the system's back gesture), zoomed or not.
- The state is on the stage as `data-zoom` (`1.00` ... `4.00`); the zoomed page is
  `transform: translate() scale()` on `.album-page` (layout size, and so the thumbnail
  bucket, do not change when zooming: zoom asks for nothing new).
- **Hint**: on a phone-width window (<= 600 px) one line, 「雙擊放大・橫放手機看更大」,
  sits at the bottom of the stage for 4.5 s, or until the first touch / wheel / flip,
  then fades (and is removed); none on a desktop; the timers are cleared on close.

**No writes, no storage.** No POST / PUT, nothing in `localStorage` /
`sessionStorage`; every open recomputes (the plan is deterministic).

**Known limits / not done.** Not on the phone yet (needs a real device): the
crossOrigin canvas read in iOS Safari / the LINE in-app browser (if it fails,
the engine lays photos out by shape only: no duplicate detection, no focus
crop); **the pinch, double tap and swipe on real hardware** (iOS Safari, the LINE
in-app browser: `touch-action: none` and the page lock were only tested with
synthetic and CDP touches in Chromium, including a real two-finger CDP pinch); the
8-photo spreads are tiny on a 390 px phone (zoom is the answer); speed and memory
at 100+ photos (each open re-analyses; there is no cache between opens); the bottom
bar of the browser (the viewer uses `100dvh` and `env(safe-area-inset-*)`). A
zoomed page shows the same thumbnail bucket (1200 / 1600), not a sharper re-request.
**Not built: swapping a photo, choosing another template for a spread, saving the
layout, a share link of its own, a purchase button or price (stages 2 and 3), face
detection.** `analyze` has no `onProgress`; adding one would let the chunking go.
