# Album preview: the layout engine

Status (2026-10-08): engine built; stage 3's data path is partly there (S2 guest ordering
stores `order_items.layout = {"v":1,"mode":"photographer","source":"all_finals","spreads":N}`
on an album line, built dark behind `GUEST_ORDERS`; the guest's own layout is still not saved);
stage 1 guest preview built (see "Stage 1: the guest preview" at the end); the preview is now
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
- Tests (pure, seconds, CI does not run them; `node --test book_editor/test/*.test.mjs` runs them all, including
  `fold_risk.test.mjs` and `plan_spreads_foldsafe.test.mjs` for "Fold safety"): `node --test book_editor/test/auto_layout.test.mjs`
  (analyze / plan / run, with the legacy golden), `book_editor/test/spread_templates.test.mjs`
  (every template through the validator, and the validator against bad data) and
  `book_editor/test/plan_spreads.test.mjs` (the spread planner). Browser: the
  suite "auto layout — the smart style and the old styles in the editor, on real
  pixels" (`test/suites/01-editor-layout.mjs`) and the "album preview …" suites
  (`test/suites/26-album-preview.mjs`, `27-album-preview-spreads.mjs`, `40-album-bleed.mjs`,
  `53-album-cover-title-relayout.mjs`, `55-album-relayout-feedback.mjs`). The planner's own
  options each have a node test file in `book_editor/test/` (`plan_variety`, `plan_hero`,
  `preferred_per_spread`, `plan_variant`, `plan_variant_small`, `plan_spreads_contain`,
  `plan_spreads_foldsafe`, `plan_spreads_minspreads`, `plan_spreads_maxspreads`,
  `plan_spreads_separate`).
- `node book_editor/test/render-templates.mjs [outDir]` draws the library and sample plans as PNGs (see
  "Seeing the library").

## API

```
AutoLayout.analyze(photoIds, { urlFor(id) -> url, loadImage?(url, {signal, aspectOnly}) -> Promise<ImageLike>,
                               pixelsOf?(image, w, h) -> RGBA bytes, concurrency = 6, signal?, aspectOnly? })
  -> Promise<Array<{ id, ok, aspect, orientation: 'landscape'|'portrait'|'square',
                     hash /* dHash, 16 hex, '' = unknown */, sharpness, focus: {x, y} /* 0.2..0.8 */,
                     foldRisk /* 0..1, or null = unknown: see "Fold safety" */ }>>

AutoLayout.plan(items /* analyze() output */, { style = 'auto', layouts, pages, pageAspect = 1, coverAspect = pageAspect,
                                                 hashThreshold = 6, window = 5, order = 'natural' })
  -> { cover: { photoId, crop } | null,
       pages: [{ id, type: 'inner', layout, slots: [{ photoId, crop: {x, y, scale: 1} }], bg: '#ffffff' }],
       dropped: [{ id, reason: 'duplicate', of } | { id, reason: 'failed' }] }

AutoLayout.planSpreads(items, { fit = 'contain', templates, coverAspect = 210/297, spreadAspect = 420/297, hashThreshold = 6, window = 5,
                                maxPerFace = 4, seed = 0, order = 'natural', back = false,
                                dedupe = 'separate', similarThreshold = 12, similarWindow = 7,   // near-duplicates, see below
                                minSpreads, maxSpreads,                                          // spread-count bounds, see below
                                foldSafe = true })                                               // no high-risk photo across the fold, see "Fold safety"
  -> { cover: { photoId, crop, fit? } | null,
       spreads: [{ id: 'spread-n', template: <template id>, slots: [{ photoId, fit?, crop: {x, y, scale: 1}, slot: {x, y, w, h, face} }] }],
       back: null | {},                       // {} = a blank closing page (only with back: true and a book to close)
       dropped: [ same as plan ],             // see "A4 album: spreads and the template library"
       similarPairs?, similarSpreads?,        // only when look-alikes exist: see "Near-duplicates"
       minSpreads?, maxSpreads?,              // only when asked for: see "Spread-count bounds"
       foldSpans?, foldAvoided? }             // only when > 0 (and foldSafe): see "Fold safety"

AutoLayout.run(photos, style)   // the editor's five old styles; same output as before
AutoLayout.DEFAULTS             // the numbers below
AutoLayout.SPREAD_DEFAULTS      // the planSpreads numbers (price per spread, hero gap, ...)
AutoLayout.FOLD                 // the fold-risk constants (frozen): W, H, BAND, FLOOR, MIN_MEAN, RATIO_LO, RATIO_HI, OFFSET_MAX, LIMIT
AutoLayout.util                 // pure helpers (tests): naturalCompare, dHash, hamming, sharpnessOf, focusOf, cropFor, toGray,
                                // foldStatsOf(gray, w, h) -> {ratio, offset, mean, flat} | null, foldRiskOf(gray, w, h) -> 0..1 (1 = unusable),
                                // wasteOf(photoAspect, slotAspect), containBox(natW, natH, slotW, slotH, crop) -> {left, top, w, h}
```

`planSpreads` takes `fit: 'contain' | 'cover'`, **default `'contain'`** (anything else is the default). See "Whole photos: fit contain".

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
caller's), the same dedupe **only with `dedupe: 'drop'`** (dHash, `hashThreshold` 6, `window` 5, the sharpest of
a group survives, `dropped` has the same shape; the default is now `'separate'`: nothing is dropped for being
similar, see "Near-duplicates, minimum and maximum spreads"), the same cover pick (now against
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
- (Costs below are cover mode's: contain mode swaps the crop loss for the waste, see "Whole photos: fit contain".)
- **Hero spreads** pay for a blurry or non-landscape photo and are never the cover
  photo, and earn a bonus (0.65): the sharpest landscapes get them, as often as the
  cap allows (about 1 spread in 10 for a landscape-heavy book).
- **Variety**: the cheapest book leans on a few templates, so it is polished after the
  fact: each spread tries the other templates with the same number of slots and
  takes a swap when it lowers (cost + a charge for the same template again within 2,
  3, 4 or more spreads, 0.9 / 0.6 / 0.35 / 0.15; raised from 0.5 / 0.35 / 0.2 / 0.1 after a 30-book check: no template carries more than 3 spreads of a 40-photo book instead of 4, and the mean share of each photo kept by its crop moves only from 0.869 to 0.864) — hard rules re-checked on each
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

## Near-duplicates, minimum and maximum spreads (`planSpreads`)

Decisions by Tim (owner): near-identical shots are **not dropped any more, but kept apart** (the real case: four
same-pose studio frames of one couple on one spread), and the product (相本書) sets a **minimum** and a **maximum** of
inside spreads. The unit of both bounds is the **spread inside the book**: the cover and the back are not counted.
All of it is in `planSpreads` only (`plan` and `run` do not call it and are untouched).

### Near-duplicates: `dedupe`

| option | default | meaning |
|---|---|---|
| `dedupe` | `'separate'` | `'separate'`: only failed photos and the same id twice leave `dropped`; look-alikes are kept and kept off the same spread. `'drop'`: the old behaviour (near-duplicates go to `dropped`, `hashThreshold` / `window`), no separation. Anything else means `'separate'`. |
| `similarThreshold` | 12 | two photos are look-alikes when their dHashes differ in at most this many of 64 bits |
| `similarWindow` | 7 | ...and are at most this many places apart in shooting order (inclusive; 7 because a spread holds 8 at most) |

A photo without a hash (`''`: the canvas read failed) is never similar to anything.

**How the planner separates.** (1) Look-alike pairs are found. (2) The planner tries the shooting order and, if look-alikes
sit close together, up to four mild reorders (`AutoLayout.util.similarEdges`, `spreadOutOrder`): look-alikes at least
3 / 4 / 5 / 6 places apart, nobody moved more than 6 / 8 / 10 / 12 places from their shooting-order place (on top of the
usual seating inside a spread), deterministic, so the overall order stays chronological and **no photo is ever dropped**.
(3) On each order the spread DP forbids a group that holds two look-alikes. This is a hard rule, but the softest one: it is
relaxed before any other rule or waste floor, and only if no order can satisfy it at that rule set; the first order that
works (the mildest reorder) wins. (4) If none can, a soft pass charges 3 per look-alike pair sharing a spread and takes the
order that leaves the fewest. When it is unavoidable (six look-alikes, one spread; 2 or 3 photos in all) the pair is allowed.
A bound (`maxSpreads` / `minSpreads`) outranks the separation: a plan inside the bounds with look-alikes together beats one
outside them without.

**Result.** `similarPairs` (number of look-alike pairs still on one spread) and `similarSpreads` (their spread ids,
`['spread-3', ...]`) are present **only when the book has at least one look-alike pair**; absent means none, so a book
without look-alikes returns exactly the old object (the cover golden hash is unchanged). `similarPairs: 0` means they
were all separated.

**The threshold 12, and why.** Chosen on synthetic hash sets, **not real photos** (none were available). Model: the chance
that one hash bit differs between two photos is q, so the distance is Binomial(64, q); share of pairs at or under T:

| pair type | T=6 | 8 | 10 | **12** | 14 | 16 |
|---|---|---|---|---|---|---|
| same pose, 5% of bits flip | 96% | 99.6% | 100% | 100% | 100% | 100% |
| same pose, 10% flip | 54% | 81% | 95% | **99%** | 99.9% | 100% |
| same pose, 15% flip | 14% | 36% | 64% | **85%** | 95% | 99% |
| same pose, 20% flip | 1.8% | 8% | 24% | **48%** | 71% | 88% |
| same set, other pose, q = .30 | 0 | 0.1% | 0.6% | **3%** | 9.7% | 23% |
| same set, other pose, q = .35 | 0 | 0 | 0 | **0.3%** | 1.7% | 5.8% |
| unrelated, q = .50 | 0 | 0 | 0 | **~0** | ~0 | 0.004% |

The old drop threshold 6 catches only about half of a 10%-flip same-pose pair, which is why looser is needed. 12 catches
99% of those, 85% of a noisier 15% pair, and a very similar *different* pose of the same set (q .30) only 3% of the time.
A false positive is cheap now (a little reordering, about 1.4 more spreads per 60 photos), a miss is what Tim reported, so
the threshold errs loose; 14 is the next step if real bursts still meet. **Limits:** real dHash bits are correlated (a white
backdrop, the same dress), so real "different pose" pairs are probably closer than the q = .30 row, and a studio set could
make many photos "similar"; then the planner just reorders more and some pairs stay together (reported in `similarPairs`).
Tim must look at real photos. Measured on synthetic books of 40 to 100 photos with clusters of 2 to 5 frames: 0 pairs left
in 160 of 160 books (347 and 714 pairs together in the 30-book samples without it), 1.4 to 2.3 more spreads, mean waste
unchanged (0.100 vs 0.099); clusters of 8 or more in a row cannot always be split (4 of 40 books kept a pair). Cost: with
look-alikes the planner solves up to five orders (about 0.3 s for 240 photos); without them nothing changes.

### Spread-count bounds: `minSpreads`, `maxSpreads`

Both are integers >= 1 (a fraction is rounded down; anything else, `0`, a negative, `NaN`, a string, means "not given" and
the result has no key for it). Neither ever crops (`fit` stays what was asked: `'contain'` by default, every slot
`fit: 'contain'`, crop `{0,0,1}`), neither ever drops a photo, neither throws, and the hard rules stay (hero gap: at most
1 hero in any 5 spreads; <= 4 photos per face; <= 8 per spread; template validity).

```
result.minSpreads = { wanted, achieved, met, photosNeeded }       // only when opts.minSpreads was given
result.maxSpreads = { wanted, achieved, met, photosAllowed }      // only when opts.maxSpreads was given
```
`achieved` = `spreads.length`. `met` = `achieved >= wanted` (min) / `achieved <= wanted` (max). When the plan is already inside
the bound nothing else changes: the result is exactly the one without the option plus the report (40 photos with
`minSpreads: 10` is byte for byte the plan without it, tested).

**minSpreads.** The planner uses fewer photos on each spread, then single-photo spreads, then through-spreads (heroes).
Rule order when the minimum needs it: (1) the strict rules with a spread-count constraint (the DP has a count dimension);
(2) a lone photo on a quiet single page (`solo-left` / `solo-right`) is allowed; (3) the same-family run rule goes; (4) the
last-spread-is-not-a-lone-photo rule goes; (5) the adjacent-same-template rule goes. **The hero gap never goes.** Inside each
step the waste floor still relaxes 45% -> 60% -> none before the next rule goes, so **the minimum is met with emptier spreads
(more paper around the photos) rather than failed**: single-photo spreads have up to about 60% waste, never a crop. If even
that cannot reach it (too few photos), the plan with the most spreads reachable is returned with `met: false`.
`photosNeeded` = the smallest photo count for which the planner CAN reach `wanted`, found by planning synthetic photos with the
same aspect (and sharpness) mix as the real ones (evenly resampled, no hashes), galloping up from `wanted` (+1, +2, +4 ...) and
binary-searching the last gap; `null` if `wanted > 60` or nothing up to 8 * wanted + 16 photos reaches it (a template list
with no single-photo spread). It assumes more photos never hurt (pinned on uniform books). **It is the bare minimum, not a
comfortable count**: with the full library `photosNeeded` equals `wanted` (one photo on each spread); 14 photos make 10 spreads
with mean waste about 0.12 and a worst slot about 0.3, while 10 to 12 photos reach 60% waste on single pages. A UI that wants a
nicer album should ask for more than `photosNeeded`.

**maxSpreads.** The planner packs more photos on each spread (templates with up to 8 photos, <= 4 per face): the DP has an
exact spread-count dimension that forbids exceeding it and prunes states that cannot seat the photos left in the spreads left.
Rules that go, in order: the family-run rule, then the adjacent-template rule (dense templates are few); the hero gap,
lone-photo and last-spread rules stay. If it cannot be met even so, `met: false` and the **densest** plan the rules allow is
returned (a very high price per spread; ceil(photos / 8) spreads with the full library), **all photos kept**: the UI is
expected to tell the guest to deselect. `photosAllowed` = the largest photo count that fits in `wanted` spreads, in closed
form: `k * wanted`, k = slots of the biggest non-hero template (8 in the library; tested against real planning: `8 * N` photos
fit N spreads, `8 * N + 1` do not; for a template list without every size 2..k it is only an upper bound); `null` if
`wanted > 60`. A capacity under 4 photos is probed by planning (the cover is not repeated inside below 4 photos).

**Both.** `minSpreads <= maxSpreads`: the plan lands inside the window when it can; each bound reports its own `met`.
**`minSpreads > maxSpreads` is a caller error:** no throw; the **minimum is ignored** (the maximum is the hard limit; the plan
is the one `maxSpreads` alone gives), both reports carry `met: false`, `error: 'minSpreads-greater-than-maxSpreads'`,
`ignored: 'minSpreads'`, and `photosNeeded` / `photosAllowed` are `null`.

**Not verified:** all of it ran on synthetic photos only. How a book of single pages looks, and whether 8-photo spreads are
readable on a phone, is for Tim to see (the 45% floor is relaxed there). The browser preview is not wired to these options yet
(`AlbumPreview.PLAN_OPTS` passes any of `{ minSpreads, maxSpreads, dedupe, similarThreshold, similarWindow }` straight through).
The viewer's note 「已略過 N 張相近的照片」 reads `dropped`, which is now empty by default.

**Tests.** `book_editor/test/plan_spreads_separate.test.mjs`, `plan_spreads_minspreads.test.mjs`,
`plan_spreads_maxspreads.test.mjs` (`plan_spreads.test.mjs` runs its two duplicate-drop assertions with `dedupe: 'drop'`;
the 6-book cover golden is unchanged).

### Preferred photos per spread: `preferredPerSpread` (default **5**)

Tim's rule: a spread normally holds **at most 5 photos**. `opts.preferredPerSpread`: an integer >= 1 (a fraction rounds
down); `undefined` or a non-number string = the default 5; `0`, `null` or a negative = no cap (the engine as it was, no
report key). It is a **preference, not a rule**:

- The plan is first made with only the templates of <= N photos (the library keeps 1 to 5: 5 / 4 / 6 / 9 / 6 templates).
  Hero (through-spread) templates count by their photos like any other.
- A hard bound wins. If that plan misses `maxSpreads` (too many spreads) or `minSpreads`, the cap is raised **one photo
  at a time** (6, 7, ... up to the library's real limit, 8 with the shipped library, where it is simply the old planner
  with all templates) and the first plan inside the bounds is taken; if none is, the closest one (the old densest-plan
  fallback applies at the top). So 40 photos in `maxSpreads: 6` use spreads of up to 7 photos, not 8.
- `minSpreads` needs fewer photos per spread, so the cap rarely matters to it; it is still checked and the uncapped
  plan is tried if the capped one falls short.
- `photosAllowed` stays `k * wanted` with the library's real k (8 per spread), **not** 5 per spread: it is the hard
  capacity. A UI that wants to warn "more than 5 per spread on average" must compute that itself (`5 * maxSpreads`).
- `dedupe`, `foldSafe`, similar grouping and `fit` are untouched (the cap only filters the template list the same search
  runs on). `photosNeeded` is computed with the cap on (it is smaller: more spreads per photo).

```
result.preferredPerSpread = { wanted, met, overflowSpreads }   // present unless the cap is off
```
`overflowSpreads` = spreads with more than `wanted` photos; `met` = `overflowSpreads === 0`. Only the cap of the *final*
plan is reported. The cap costs some template variety (the 44-photo periodic test book: 8 templates over 12 spreads
uncapped, 10 over 14 with the cap; a few more, emptier spreads).

**Callers.** `AlbumPreview.PLAN_OPTS` and `completion-page.js` (`_applyBounds`) need nothing: the default is on inside the
planner, `maxSpreads` from `max_pages` still wins. To switch it off or change it, put `preferredPerSpread` in
`PLAN_OPTS`. **Tests:** `book_editor/test/preferred_per_spread.test.mjs`; the older `plan_spreads*.test.mjs` wrappers now
pass `preferredPerSpread: 0` (they pin the engine without the cap), and `plan_spreads_foldsafe` lists the new result key.
**Not verified:** synthetic photos only; whether 5 per spread looks right on real albums is for Tim to see.

### Variety: `variety` (default **on**; `0` / `false` / `null` = the cheapest book as before)

**Problem (Tim).** A ~20-photo preview looked flat: with `maxSpreads: 4` every spread held exactly 5 photos, and a lone
through-spread (hero) was rare. He wants 1 to 5 photos per spread and "a bit of change on every page". All soft: the hard
rules (`maxSpreads` / `minSpreads`, every photo kept under `dedupe: 'separate'`, `foldSafe`, `fit: 'contain'`, the hero gap,
look-alikes kept apart) still win, and `variety` can only choose among plans that obey them.

**Measurable rules** (`result.variety` reports them; recomputed from the spreads in the tests):

1. At most **2** spreads in a row with the same photo count, and never the same template twice running.
2. From **6 spreads** on: at least **3 distinct photo counts**, and a lone-photo through-spread when a suitable photo exists
   (landscape or square, sharper than the median, not the cover, and fold-safe: with no `foldRisk` a photo counts as high-risk,
   so such a book gets no hero, as before). The hero gap (4 other spreads between) holds.
3. Under a tight `maxSpreads` (average over 5 per spread) the counts still vary (20 photos in 4 spreads: 4,5,5,6 or 6,4,5,5, not
   5,5,5,5). The preferred cap (`preferredPerSpread`) may rise by **one more** photo than the least that fits when that makes the
   plan less flat; the overflow is still reported in `preferredPerSpread`, and `photosAllowed` is unchanged (8 per spread).
4. When the counts are forced (a library with only 5-photo templates, 20 photos in 4 spreads) the **templates** still differ: the
   polish charges a repeated template `SP_VAR_NEAR` (10) times the old near-repeat charge.

**How.** (a) the DP state gets "spreads in a row with this photo count" (1..2); a third costs `SP_VAR_KRUN` (soft, so it still
finds a plan when one is forced). (b) `varietyRounds`: up to 10 re-solves of the same bounds and rules with a price on every photo
count that carries more than max(2, a third) of the spreads, and, for books of >= 6 spreads with a suitable photo and no hero, a
growing bonus on lone through-spreads (0.15, 0.3, 0.5, 0.8, 1.2, 2: the gentlest that yields one); the plan that lacks least
wins. (c) `planCore`, with a hard `maxSpreads`: the cap loop does not stop at the first cap that meets the bound but also tries
one cap higher and takes the plan that lacks least (the bounds still come first). Everything is deterministic.

```
result.variety = { distinctCounts, maxSameRun, repeatedTemplates, distinctTemplates, heroSpreads, heroWanted }   // absent with variety off
```
`repeatedTemplates` = spreads using the template of the spread right before; `heroSpreads` = lone through-spreads.

**Cost (synthetic books, 6 seeds x 30 and 44 photos, no bounds).** Mean waste of a photo in its slot 8.8% -> 10.4% (the worst
slot 0.33 -> 0.43, still under the 0.45 floor), 10.0 -> 10.5 spreads on average (a lone hero and a few pairs). Most of the waste
comes from rule 4 (`SP_VAR_NEAR`; 3 gives 9.4%). **Tests:** `book_editor/test/plan_variety.test.mjs` (the old plans fail its
rules: no hero in 8 of its control books, a run of one count over 2 in 14, 5,5,5,5 on every seed of the 20-in-4 example). The older `plan_spreads*.test.mjs` and
`preferred_per_spread.test.mjs` wrappers pass `variety: 0` (they pin the engine without it), `plan_spreads_foldsafe` lists the new
result key. `AlbumPreview.PLAN_OPTS` needs nothing (default on). **Not verified:** tuned on synthetic photos only; whether the
mix looks right, whether the lone through-spread lands on a photo worth it, and the extra white from rule 4 need a real album.

### More full-bleed spreads: `heroRate` (default **0.2**; `0` / `false` / `null` = the previous behaviour)

**Why (Tim, a ~20-photo preview: "滿版單張多一點").** The variety rounds wanted exactly one hero, and only from 6 spreads on; the
`planSpreads` bonus alone also seats weak photos on a through-spread now and then. `heroRate` asks for more, from suitable photos only.
`result.variety.heroWanted` is what the plan was asked for, `heroSpreads` what it has (fewer is fine and reported).

- **Wanted**: `round(spreads * heroRate)` from 8 spreads (0.2 = about one per 5), at least 1 from 4 spreads (a 20-photo book),
  0 below that; with `heroRate: 0` the old rule (1 from 6 spreads). Capped by the number of suitable photos and by the gap
  (`ceil(spreads / 5)`: a hero needs 4 other spreads before the next).
- **Suitable** = landscape or square, sharpness at or above the book's median (a tie counts), fold-safe, not the cover. The bonus
  of the variety rounds (`SP_HERO_STEPS`, growing each round while heroes are short) is paid for those photos only, and in a book
  of >= 8 photos a lone photo below the median on a through-spread costs `SP_HERO_WEAK` extra (soft). Hard rules unchanged: the gap,
  `foldSafe`, `min/maxSpreads` (they win; the rounds solve under the same bounds), deterministic.
- **Cost.** More, smaller spreads: 30 photos 8.8 -> 9.7 spreads on average, 44 photos 12.2 -> 13.7, 60 photos up to +37% on one seed
  (so `plan_variety`'s "within 30%" became 40%, 30% kept for `heroRate: 0`). Synthetic books, 6 seeds, known-low fold risk:
  heroes over the 6 seeds 4 -> 4 / 4 -> 6 / 8 -> 12 / 6 -> 16 for 12 / 20 / 30 / 44 photos.

**Why the real preview can still have no hero: `foldRisk`.** The preview does measure it: `AutoLayout.analyze` (called with only
`urlFor` and `signal`) reads the 400px thumbnail three times (9x8 hash, 32x32 sharpness/focus, 64x40 fold grid) and sets
`foldRisk`. It is `null` only when the pixels cannot be read (tainted canvas after the no-CORS fallback in `defaultLoadImage`, a
failed read); then sharpness is 0 and the hash empty too. Unknown counts as high risk (default deny, pinned by
`fold_risk.test.mjs` / `plan_spreads_foldsafe.test.mjs`): a hero with the subject on the gutter is a visible print defect, a missing
hero is only less variety, so **unknown is deliberately not relaxed**. The result now says how many photos were unknown:
`result.foldUnknown` (absent when 0). A measured high risk (subject in the centre band) also forbids a hero by design; a book of
portraits of a couple in the middle has few suitable photos and gets few heroes. Which of the two Tim's album was, is not known
from here: check `plan.foldUnknown` and the photos' `foldRisk` in the console on the real album.

## Fold safety: no photo across the fold when its subject is on the fold

**Problem (Tim, an iPhone screenshot).** A through-spread (`hero-bleed`, `hero-frame`, `hero-wide`, `hero-strip`: the only
templates with a `face: 'span'` slot) draws one photo over both pages. The bride's face sat exactly on the fold, and the
gutter shadow cut it. The engine does not know where a subject is. **Decision (Tim, option B):** do not span a photo across
the fold when the content of the photo sits on the fold; span only when the middle of the photo is low-risk. No face
detection (a later stage): a cheap, deterministic heuristic on pixels the engine already reads.

### The heuristic (`foldRisk`, 0..1)

Computed in `analyze()` from a **third canvas read of the same `?w=400` thumbnail** (a `FOLD.W x FOLD.H` = 64 x 40 grey grid,
after the 9x8 hash read and the 32x32 sharpness/focus read): no extra network request. The browser (`defaultPixelsOf`, a
canvas) and the node tests (any `pixelsOf` mock) take the very same path, `o.pixelsOf(img, w, h)`; `js/album-preview.js`
passes `analyze`'s items straight to `planSpreads`, so nothing changed there. The grid does not keep the photo's aspect: only
the horizontal fractions matter.

```
e(x,y)   = max(0, |g(x+1,y) - g(x,y)| + |g(x,y+1) - g(x,y)| - FLOOR)        detail (forward differences, so a 1-pixel pattern shows)
c[x]     = sum over y of e(x,y)                                              detail per column
ratio    = (mean of c over the BAND, columns weighted by their overlap with it) / (mean of c over the whole photo)
offset   = | sum(c[x] * position(x)) / sum(c) - 0.5 |                       detail-weighted centroid's distance from the middle (fractions of the width)
risk     = clamp((ratio - RATIO_LO) / (RATIO_HI - RATIO_LO)) * clamp(1 - offset / OFFSET_MAX)
flat     : mean e per pixel < MIN_MEAN  ->  risk 0 (nothing to cut)
unusable : no pixels / wrong length / NaN / grid under 3x3  ->  risk 1
high     : risk >= LIMIT
```

| constant | value | why |
|---|---|---|
| `FOLD.W x FOLD.H` | 64 x 40 | 2560 px: cheap, and the band is about 9 columns wide |
| `BAND` | 0.14 | a photo on a through-spread has the fold at its centre (`contain` centres every slot; the hero slots are symmetric about the fold). 14% of 420 mm = 59 mm = a 10 mm gutter + about 25 mm each side for the binding and the shadow |
| `FLOOR` | 12 grey levels | `|dx| + |dy|` under this is noise or a smooth ramp (a sky, a studio backdrop, a gradient) and counts as no detail |
| `MIN_MEAN` | 0.25 | a picture with essentially no detail after the floor has no subject: risk 0 |
| `RATIO_LO` / `RATIO_HI` | 0.8 / 2.0 | the band as busy as 0.8x the photo's average scores 0, twice as busy scores 1 |
| `OFFSET_MAX` | 0.3 | the detail's centroid 30% of the width from the middle (or more) scores 0 |
| `LIMIT` | 0.5 | high risk from 0.5 up; e.g. a band 1.4x as busy as the average **and** a centroid dead centre is exactly 0.5 |

The ratio is the gate (a subject on the fold must make the band busier than the rest); the centroid only lowers a score when
the detail's mass sits far from the middle. On synthetic 64 x 40 grids (a textured block on flat grey, as in
`fold_risk.test.mjs`):

| picture | ratio | offset | risk |
|---|---|---|---|
| subject 40-60% wide | 5.3 | 0.004 | 0.99 high |
| subject 30-70% | 2.4 | 0.004 | 0.99 high |
| small subject 44-50% (touching the fold) | 7.0 | 0.027 | 0.91 high |
| subject 36-42% (just outside the band) | 0 | 0.105 | 0 |
| subject 15-35% or 65-85% | 0 | 0.25 | 0 |
| two subjects at 15-30% and 70-85% (centroid on the middle, nothing on the fold) | 0 | 0.00 | 0 |
| noise everywhere (+-100 grey levels) | 1.0 | 0.006 | 0.17 low |
| plain gradient, uniform, faint noise | 0 | 0 | 0 |

**Noise everywhere** (a crowd, foliage): the ratio is about 1 and the centroid on the middle, so the score is about 0.17,
**low**. Decision: a uniformly busy picture has no particular subject on the fold, and nothing about it says where to avoid;
the heuristic finds busy *centres*, not busy photos. **No data** (a hash-only item, `aspectOnly`, a tainted canvas, a failed
read) is **high risk (default deny)**: `analyze` reports `foldRisk: null` and the planner reads any non-number as 1. A number
below 0 or above 1 is clamped.

Through the real browser canvas (Chromium, 600 x 400 drawn people about 180 px wide on a flat sky): a person at the centre
0.98, at 42% 0.75, at 33% 0.02, at 25% 0; a couple at 40% + 60% (the gap on the fold) 0.96, a couple at 30% + 70% 0; a 60 px
subject at the centre 0.99; a flat sky 0. (Checked once by hand, not a committed suite.)

### The planner: `foldSafe` (default **true**)

`planSpreads(items, { foldSafe })`: anything but an explicit `false` is on. With it on, **a template with a `face: 'span'`
slot takes a photo in that slot only if its `foldRisk < FOLD.LIMIT`**; a high-risk photo (or one with no `foldRisk`) is seated
on a non-span template (single-face or grid slots) or nowhere. It is a hard rule inside the seating itself (a span seat for a
high-risk photo costs 1e9, so a group that needs it is never a candidate), so **nothing relaxes it**: not the waste floors,
the hero-gap, solo and last-spread relaxations, `minSpreads` (the minimum reports `met: false` instead of cutting a face),
`maxSpreads`, the similar-photo reorders, the variety polish or `fit: 'cover'`. Every photo is still placed (none dropped,
none cropped; `fit: 'contain'` unchanged: whole photo, `crop {0,0,1}`). For safe photos nothing changes: a book whose photos
are all low-risk plans byte for byte as with `foldSafe: false` (tested).

Plannable always: the library has a span-free template for every photo count 1 to 8 (`solo-left` / `solo-right` for a lone
photo, which the "a lone photo only on a hero" rule normally forbids but the relaxation ladder allows once a hero is
impossible; tested for every n from 1 to 45 with every photo high-risk). **A library passed in with `templates` that can
seat a photo only on a span** (a hero-only list) cannot take a high-risk photo: it throws `...cannot seat...` like any
library that cannot seat the photos (`foldSafe: false` plans it as before). `photosNeeded` / `photosAllowed` plan synthetic
photos that carry the real book's risk mix; a synthetic count the library cannot seat under the rule counts as "does not
meet" instead of throwing.

`foldSafe: false` is the old planner: any photo may take a span, and **the result has no new key**. The older test files
(`plan_spreads*.test.mjs`) have no pixels, so they run through a one-line wrapper that adds `foldSafe: false`.

**Result keys** (only with `foldSafe`, only when > 0, so a book with nothing to report is the old object):

| key | meaning |
|---|---|
| `foldSpans` | number of spreads that use a span slot (photos across the fold; all of them low-risk) |
| `foldAvoided` | number of high-risk photos that the plan **without** the rule would have put on a span: the cost of the rule, for tests and a UI note. Needs a second planning when the book has any high-risk photo (about +50 ms for 240 photos; not done for the synthetic plans of `photosNeeded`) |

### Limits (read before trusting it)

- **It cannot find a face.** It finds *busy, sharp centres*: detail in the middle band much denser than the rest of the
  photo. A centred subject on a plain or blurred background is caught (a person, a couple, a cake). A face with busier detail
  elsewhere (a lace curtain, foliage, a crowd on both sides) is **not**: the band is not busier than the average. A subject
  that fills most of the frame is not caught either (the ratio is about 1). A subject with a smooth texture (a bald head,
  a white dress on white: detail only on the silhouette) can score low if its silhouette lies outside the band.
- **Only the centre of the photo is considered.** It assumes the fold lands at the photo's centre: true for `fit: 'contain'`
  (every slot centres the photo) and for the symmetric hero slots. With `fit: 'cover'` a focus crop can move the content
  off-centre, so the risk is only approximate there.
- **Tuned on synthetic data only** (drawn blocks, noise, gradients, drawn people through the real canvas). **Tim must look at
  real photos**: open the preview of a real wedding folder and check (a) no through-spread has a face or a couple's join on
  the fold, (b) through-spreads still appear for landscapes and wide scenes. `foldAvoided` is the number to watch: a book that
  loses every hero is too strict.
- **What to tune.** Too strict (landscapes and wide scenes never span): raise `FOLD.LIMIT` (0.5 to 0.6-0.7), or raise
  `RATIO_LO` / `RATIO_HI` so a busy centre has to be busier, or narrow `BAND` (0.14 to 0.10). Too lax (a face on the fold
  still gets through): lower `LIMIT` (0.5 to 0.35), lower `RATIO_LO` (0.8 to 0.6), raise `OFFSET_MAX` (0.3 to 0.4), lower
  `FLOOR` (12 to 8) if real subjects show little detail at 64 x 40, widen `BAND`. All constants are in `AutoLayout.FOLD`;
  `fold_risk.test.mjs` pins the numbers above, so change both together.
- **A good photo is lost for a hero when its middle is busy.** That is the intent (better a quiet page than a cut face); the
  cost is reported in `foldAvoided`. The editor's `plan()` has no spans and is untouched.
- **Cost per photo:** three canvas reads instead of two (one `drawImage` + `getImageData` of 2560 pixels, under a
  millisecond) and about 12 microseconds of arithmetic. The planner needs a second planning when a book has any
  high-risk photo (for `foldAvoided`): +50 ms at 240 photos.

**Tests.** `book_editor/test/fold_risk.test.mjs` (the helper on synthetic arrays: a centred subject, subjects at 25% / 75%,
a flat centre, uniform / gradient / faint noise, noise everywhere, missing data, the band edges, mirror symmetry, grid-size
independence; `analyze` wiring: one load per photo, three reads, `null` without pixels) and
`book_editor/test/plan_spreads_foldsafe.test.mjs` (default on, no data = no span, the only hero candidate high-risk vs
`foldSafe: false`, a low-risk landscape still spans, the limit boundary, junk values, 60 random books, cover mode and the
other options, every n 1..45 all high-risk, `minSpreads` / `maxSpreads`, a span-only library, `hero-strip` seating, result
keys, determinism, template validity).

## Whole photos: fit `contain` (the default) and how to switch back to `cover`

**Decision (Tim, checking the A4 preview in the iPhone LINE browser):** do not crop; cropping to fill a slot "cuts off
heads" (a portrait cropped into a landscape slot, a landscape cropped narrow). So the album shows every photo whole,
centred on the white paper, never cropped, never stretched. The cost is white space around photos whose shape does not
match their slot; the planner is therefore built to pick shapes that match.

**The contract.** `planSpreads(items, { fit })`:

| `fit` | slots and `cover` | the viewer draws |
|---|---|---|
| `'contain'` (default) | every slot `{ photoId, fit: 'contain', crop: {x:0, y:0, scale:1}, slot }`; `cover` `{ photoId, fit: 'contain', crop: {0,0,1} }` | `AutoLayout.util.containBox`: the whole photo, centred, touching its frame on one axis |
| `'cover'` | exactly the engine before `fit` existed (byte for byte, pinned by a golden hash in `plan_spreads.test.mjs`): focus-offset `crop`, **no `fit` key** (absent = cover, as `slot.fit \|\| 'cover'` in `layouts.js`) | `fitCoverImage` (crop to fill), the frame's old `#ece8de` ground |

`containBox(natW, natH, slotW, slotH, crop)`: `k = min(scale*slotW/natW, scale*slotH/natH)`, size `natW*k x natH*k`, centred,
then moved by `crop.x * slotW` / `crop.y * slotH` (zero from the planner). The focus point plays no part in contain mode.

**Switching back to cover:** set `AlbumPreview.PLAN_OPTS = { fit: 'cover' }` (`js/album-preview.js`; a one-line default
change there, or pass it from `js/pick.js`). The viewer draws by each slot's `fit`, so nothing else changes; the cover
mode suite ("album preview cover mode …") keeps that path green.

**Cost model (contain).** A slot's waste = `1 - min(p, s) / max(p, s)` for photo aspect `p` and slot aspect `s`: the share
of the slot the whole photo does not cover (the same number cover mode called the crop loss). Cost of a seat =
`2 * (waste + 2*(waste-0.3)+ + 6*(waste-0.45)+)` (weight `SP_WASTE_WEIGHT = 2`; weight 1 gave a mean waste of 11% on
mixed 40-photo books, 2 gives 10% with a worst slot of 35% for about half a spread more, 3 only 9.5%) plus the
unchanged seating pull, big-slot sharpness and spread terms. The Hungarian seating, the template DP, the rhythm and
price, the hard rules and their relaxation order (adjacent, family run, hero gap, lone photo, last spread) are untouched,
so the planner prefers templates and seats whose shape is close to the photo's.

**Hard floor.** A slot may waste at most **45%**. Each rule set is tried at floor 45%, then 60%, then no floor (the floor
relaxes before a rule does, as the crush rule did): an unsolvable library degrades step by step and never throws. On
normal photo shapes no slot of 30 books wastes more than 45% (worst seen 36% to 43%); the harsh pool (panoramas, 2:5
tall) tops out at 44%. A through-spread for a portrait (below).

**Heroes.** The orientation charge for a non-landscape, non-square photo on a through-spread is 2.4 in contain mode
(0.8 in cover): a 2:3 photo in a 1.414 spread would be a small box between two bands (53% waste, already over the floor).
For aspects 0.78 to 0.95 the waste term alone (at least 0.96 against a 0.65 bonus) already keeps them off, so the charge
is a belt: deleting it changes no book in the 900 compared (mutant E5/E10, equivalent by domination). A hero-only library
still seats a portrait when it is the only way.

**Cover.** One tall A4 page, so a 3:2 would be a small strip. Contain-mode pick: among survivors wasting at most **25%** of
the page (aspect 0.53 to 0.94: a portrait in practice) the sharpest (earlier on a tie); none: at most 45%; none: the one
wasting least (sharper on a tie). `plan()` (the editor) keeps its own pick.

**Variety.** Waste is a sharper taste than crop loss, so a book whose photos repeat a shape (a long run of 3:2 with a
portrait now and then, or a periodic set) leaned on one or two templates (one of 12 spreads' templates five times).
Contain mode therefore re-solves after the first pass with a usage price (`spreadOutUsage`): a template may carry
`max(3, a fifth of the spreads)` spreads for free, each spread over adds 0.4 to its cost per round, up to 8 rounds, same
rules; the swap polish runs after it. Measured: periodic books go from 5 to 2 spreads of the busiest template; mixed
books pay nothing (mean waste 0.0995 either way); a book of one landscape shape pays 7 to 10 points of whitespace
(0.05 to 0.11-0.15) for not repeating one layout 5 times in 12 spreads.

**Numbers (30 mixed 40-photo books, `NORMAL` shapes, cover mode in brackets):** mean waste 0.0995 (0.120), worst slot 0.36
(0.55; 12 books had a slot over 45%), 6 to 10 templates a book, no template over 3 spreads; a fixed template per size
wastes 0.27 and a random one 0.31. Harsh pool: 0.13 (0.15).

**Viewer.** `js/album-preview.js` marks a contain frame `data-fit="contain"`, sizes the `<img>` with `containBox` in px
(from the frame's layout size, so a zoomed page does not distort it) and re-fits on rotation. CSS: the frame is transparent
and does not clip, so the paper shows; the photo has a 1px hairline and a soft lift (`--album-photo-edge`,
`--album-photo-lift` on `.album-page`) so a white sky does not melt into the white paper. Zoom, pan, loading, thumbnail
buckets and the no-writes rule are unchanged.

**Tests.** `book_editor/test/plan_spreads_contain.test.mjs` (the contract, `containBox` geometry on every slot of 30
books, waste numbers vs fixed / random baselines, the floor, hero, cover, variety, purity); `plan_spreads.test.mjs`
runs every old assertion through `planCover` (`fit: 'cover'`) plus the golden; browser suites "album preview contain
desktop 1280 / phone 390" (every `<img>` box inside its frame, shown ratio = natural ratio within 0.5%, centred, nothing
clips it, pixels of a screenshot: paper beside the photo, picture just inside its edge) and "album preview cover mode".

**Not verified here:** the real iPhone LINE browser (hairline and shadow rendering on a white sky, `containBox` in px
at DPR 3 on a 40 px slot); real photographs (the suites use synthetic shapes and SVG pictures).

## Not done, and why

- **Faces.** `FaceDetector` does not exist in Safari, which is most of the
  clients. A subject-aware crop is the gradient centroid for now; a face
  detector can later feed `focus` (and a better `foldRisk`) without changing the
  contract. Until then the fold is guarded by the detail heuristic in "Fold safety".
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
  sets with many similar-looking shots (white dress, same wall)? And the album path's `similarThreshold` 12 /
  `similarWindow` 7 (chosen on synthetic hash sets only, see "Near-duplicates")?
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

**Rendering.** (Photos are drawn whole by default: see "Whole photos: fit contain"; the cover-fit description in this paragraph is the `fit: 'cover'` path.) Built with DOM calls (no `innerHTML`; a photo key never becomes
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

## Bleed (出血) — 2026-10-07

`platform_products.bleed_mm` (docs/products-orders.md "bleed_mm", `GET /api/pick/shop` → `products[].bleed_mm`,
`null` = 0) is the mm the printer trims off every **outer** edge of the sheet. Three places show or honour it:

**Editor (already there, now product-driven).** The book keeps one number, `book.settings.bleed` (the 出血 box
`#bookBleed`, default 3 mm). `appendPageGuides` (layouts.js) draws the red bleed ring, the blue 3 mm safe margin and the
green spine line in the editor and in `view.html`; `exporter.js` makes the sheet bigger by the bleed on every side and
lets a slot that touches a page edge keep painting into it (`outL/outT/outR/outB`); `exportSizeHint` says the
exported size in cm. New: `book_editor/index.html?bleed=<mm>` sets `book.settings.bleed` (only a plain number 0–10;
anything else is ignored and the book keeps its own). Page size in mm is known there (`settings.width/height`, cm), so
nothing is derived. Captions / text layers are not moved by the exporter: keeping them inside the blue safe margin is
still the photographer's job (not enforced).

**Guest preview (`js/album-preview.js`).** The preview knows no real size: its pages are nominal A4 (a spread is two,
420 × 297 mm), so bleed becomes a fraction of that (`bleed/210` of a cover width, `bleed/420` of a spread width,
`bleed/297` of the height). `AlbumPreview.bleedMm` (default 0; also `AlbumPreview.syncEntry({ …, bleedMm })`) is
normalised: a finite number above 0, capped at 10; null, 0, junk and negatives are 0.
- `bleedMm` 0: the markup is exactly the old one (no `data-bleed`, no guide; tested equal across 0/null/undefined/junk).
- `bleedMm` > 0: the page box is the whole printed sheet; the template's fractions are mapped into the trim rectangle
  inside it. `page.dataset.bleed` carries the number; an `.album-bleed-guide` (dashed trim line, the strip outside it
  dimmed, `pointer-events:none`, `aria-hidden`) is drawn above the photos. A `fit: 'cover'` slot that touches an outer
  edge of the sheet is extended to the sheet edge (picture runs into the bleed); the fold in the middle of a spread is
  not an edge. A `fit: 'contain'` photo (the default plan) stays inside the trim: nothing is put in the strip.
- Not done: faces in an extended cover photo are not steered away from the strip (the planner is unchanged).

**Wiring the completion page** (`js/completion-page.js`, not touched here): after the shop products load, set the
album product's number before the viewer opens, e.g. `AlbumPreview.bleedMm = Number(albumProduct.bleed_mm) || 0;` or pass
`bleedMm` in the `syncEntry({ show, after, folders, bleedMm })` call that pick.js / the completion page already makes.
To open the editor with the same number: `book_editor/index.html?bleed=<bleed_mm>`.

## Cover title and 再次編排 (re-layout) — 2026-10-07

Both are only in the guest's preview viewer (the 完成頁 「相本預覽」). Nothing is stored, ordered or written; the book editor is
unchanged.

### Cover title
- `AlbumPreview.coverTitle` (a string; `js/completion-page.js` sets it from the same `ctx.title` as the page hero, in `_fillHero`,
  and clears it on unmount). Empty, blank, missing or not a string: **nothing is added** and the cover markup is byte-identical to
  before (tested). The hero's own fallback 「精修成品」 is *not* passed on: no title, no text on the cover.
- Drawn by `renderPage` on the **cover page only** (not the back, not any spread). `textContent`, `dir="auto"`, never `innerHTML`.
- Top of the cover, white on a soft dark top gradient (`.album-cover-title`, `css/completion-page.css`), centred, `pointer-events: none`
  (the viewer's swipe / pinch / double tap never see it). Inside the trim: with `bleedMm` > 0 the block is padded in by the bleed
  (`bleed / 210` of the page width, which is what `%` padding means), so the text is never in the dimmed strip.
- Sized in container units (`container-type: inline-size` on the titled cover, `cqw`), so it scales from a 390px phone to 1500px.
  Four tiers by weighted length (a CJK character counts 2): 7 / 5.6 / 4.6 / 3.8 cqw. At most two lines, then an ellipsis
  (`-webkit-line-clamp: 2`). Serif stack of the completion page (`--cp-serif`, repeated because the viewer is outside `.cp`).

### 再次編排 / 回到原本
- Planner option **`variant`** (`AutoLayout.planSpreads`): a non-negative integer. **0, absent or junk = exactly the plan as before**
  (byte for byte; `plan_variant.test.mjs` pins it with digests made on the commit before it existed; `result.variant` is absent then).
  `n > 0` multiplies the soft jitter on the spread cost by `VARIANT_JITTER` (8) and hashes it with the variant, so only choices that were
  near-ties change. Everything hard is untouched: all photos kept, min / maxSpreads, preferredPerSpread, foldSafe, hero
  gap, fit. Deterministic for (photos, options, variant). `result.variant = n` when n > 0. (Why 8: 4 left small books with only 2
  distinct plans; 12 added waste.) The synthetic min/max searches always run with variant 0.
- Measured on 11 books x 5 seeds (12..60 photos, with and without bounds): variants 1..5 give at least 3 distinct plans on every
  free book; mean slot waste +0.005 (worst single book about +0.065). Test bounds: mean +0.02, any one book +0.08 (waste is 0..1 of
  one frame, so 0.08 is 8 percentage points). A book forced by a tight bound (20 photos in 4 spreads) has nothing to vary: counted,
  not demanded.
- Viewer: `再次編排` (44px, under the page controls) calls `planSpreads` again on the **already analysed photos** (no network) with
  `variant + 1`; `回到原本` (hidden until a variant is active) shows the first plan again. The page index is kept, clamped to the new
  page count; `n / total`, the bounds sentence (`boundsHint`, also reported through `AlbumPreview.onResult`) and the cover title follow
  the new plan; `minSpreads` / `maxSpreads` from the shop product stay in `PLAN_OPTS`. The variant lives in the open viewer only
  and is forgotten on close. Caption under the buttons: 「這是系統自動排版的示意，換個排法看看」.
- Tests: `book_editor/test/plan_variant.test.mjs`, `test/suites/53-album-cover-title-relayout.mjs`. Synthetic photos, Chromium only:
  how it looks on a real album and on an iPhone / LINE browser needs Tim.

### Re-layout feedback and small books — 2026-10-07
Tim pressed 再次編排 on a 4-photo project: nothing changed and nothing said so (for small books most variants were the same plan).
- **Planner, variant > 0 only** (variant 0 stays byte for byte): besides the louder jitter on the template choice,
  (a) with 4+ photos the **cover** is the candidate `variant mod 3` among the 3 sharpest photos that pass the same cover rules as the
  normal pick (the same waste tier: <= 25% of the A4 page, else <= 45%; 60% fit in cover mode); under 4 photos the cover is untouched;
  (b) inside one spread two photos of the **same orientation** may trade slots when the waste cost grows by at most 0.3 and neither
  slot ends up wasting more than max(before, 30%); (c) a spread may be **mirrored** left-right (`spread.mirrored = true`, slot x -> 1 - x - w,
  left <-> right face, a span slot stays a span slot with the same photo, so the fold rule holds exactly as before). Photos never leave
  their spread, so the shooting-order grouping, spread count, hero spacing and bounds are untouched. Deterministic (hashed with the variant).
- Distinct plans among variants 1..5, signature = cover + template + mirror + slot position of every photo (6 seeds each), before -> after:
  4 photos 2..4 -> 4..5; 6: 2..5 -> 5; 8: 2..5 -> 5; 10: 3..5 -> 5; 12: 3..5 -> 5; 20, 30, 60: 5 -> 5. Test bound: at least 3 everywhere,
  mean waste +0.03, any one book +0.2 (the worst is a 4-photo book where a variant picks 2 spreads instead of 1).
- **Viewer**: a status line next to the buttons (`#albumRelayoutStatus`, role=status, aria-live=polite, textContent): 「已換成排法 N」
  (N = variant + 1; the first plan is 排法 1), 「已回到原本排法」, or 「這本相本照片不多，目前只有這個排法」. A chip 「排法 N」 sits next to
  回到原本 while a variant is shown. The viewer compares a **signature of what is shown** (`planSignature`: cover photo, template, mirror,
  slot positions) and never presents an unchanged plan as new: 再次編排 moves on to the next variant that looks different (up to 12
  tried); if none does, it says the sentence above and leaves the plan, the number and the button alone. A ~250ms fade of the stage
  (`.album-redraw`) shows the pages were drawn again; none under prefers-reduced-motion.
- Tests: `book_editor/test/plan_variant_small.test.mjs`, `test/suites/55-album-relayout-feedback.mjs`. Synthetic photos; the real album
  look, the fade on an iPhone and in the LINE browser need Tim.
