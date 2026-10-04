// Spread template library for the A4 album (docs/album-preview.md).
//
// Pure data plus a validator; no DOM, no network, no side effects. Loaded as a
// plain script (adds one global, SpreadTemplates) and by node as a module
// (module.exports), so the tests and the browser read the very same file.
//
// The page: A4 portrait, 210 x 297 mm. The cover and back are one page; the
// inside is spreads — two pages side by side, 420 x 297 mm (aspect 1.4142).
//
// A template:
//   { id, name, tags, facing: { left, right }, margin?, gutter?,
//     slots: [{ x, y, w, h, face: 'left' | 'right' | 'span', prefer: 'landscape' | 'portrait' | 'any' }] }
//   - slots are fractions (0..1) of the WHOLE spread: x, w of the 420 mm width,
//     y, h of the 297 mm height. The left page is x in [0, 0.5], the right page
//     x in [0.5, 1]. `face` says which page a slot sits on; `span` crosses the
//     fold and is only for templates tagged `hero`.
//   - slots are listed in reading order (left page first, top to bottom, left to
//     right): the planner seats photos in shooting order as far as shapes allow.
//   - `prefer` is the shape of the slot (a slot at least 5% wider than tall is
//     `landscape`, at least 5% taller than wide `portrait`, else `any`).
//   - `facing` is the number of slots on each page (span slots are not counted).
//   - `margin` and `gutter` are millimetres, informational: the designer's
//     outer margin and the gap between photos. The slots are already final.
//   - `tags[0]` is the template's family (the planner never puts one family on
//     three spreads running); the other tags are descriptive.
const SpreadTemplates = (() => {
    const SPREAD_MM = Object.freeze({ w: 420, h: 297 });
    const MAX_PER_FACE = 4;           // photos on one page
    const MIN_MM = 25;                // no photo smaller than this, either way
    const EPS = 5e-4;                 // 0.2 mm of rounding / "touching the fold" slack
    const SHAPE_TOLERANCE = 1.05;     // prefer 'landscape' needs w/h >= 1.05, 'portrait' <= 1/1.05
    const TAGS = Object.freeze([
        'hero', 'single', 'pair', '1-2', '3-up', '1-3', '2+2', '3+3', '4+4', 'grid',
        'collage', 'mosaic', 'stagger', 'band', 'quiet', 'golden', 'mixed',
    ]);
    const FACES = ['left', 'right', 'span'];
    const PREFERS = ['landscape', 'portrait', 'any'];

    const deepFreeze = o => {
        Object.values(o).forEach(v => { if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v); });
        return Object.freeze(o);
    };

    // The data. Designed in millimetres (12 mm outer margin, 10 mm at the fold,
    // 4 mm between photos unless a template says otherwise), written as fractions.
    const TEMPLATES = deepFreeze([
        { id: 'hero-bleed', name: '通頁滿版', tags: ['hero', 'single'], margin: 0, gutter: 0, facing: { left: 0, right: 0 },
          slots: [
            { x: 0, y: 0, w: 1, h: 1, face: 'span', prefer: 'landscape' },
          ] },
        { id: 'hero-frame', name: '通頁留白相框', tags: ['hero', 'quiet'], margin: 22, gutter: 0, facing: { left: 0, right: 0 },
          slots: [
            { x: 0.0524, y: 0.0741, w: 0.8952, h: 0.8519, face: 'span', prefer: 'landscape' },
          ] },
        { id: 'hero-wide', name: '通頁寬幅', tags: ['hero', 'band'], margin: 0, gutter: 0, facing: { left: 0, right: 0 },
          slots: [
            { x: 0, y: 0.1616, w: 1, h: 0.6768, face: 'span', prefer: 'landscape' },
          ] },
        { id: 'solo-right', name: '右頁單張留白', tags: ['single', 'quiet'], margin: 24, gutter: 0, facing: { left: 0, right: 1 },
          slots: [
            { x: 0.5524, y: 0.0808, w: 0.3905, h: 0.8384, face: 'right', prefer: 'portrait' },
          ] },
        { id: 'solo-left', name: '左頁單張留白', tags: ['single', 'quiet'], margin: 24, gutter: 0, facing: { left: 1, right: 0 },
          slots: [
            { x: 0.0571, y: 0.0808, w: 0.3905, h: 0.8384, face: 'left', prefer: 'portrait' },
          ] },
        { id: 'pair-portraits', name: '左右各一直式', tags: ['pair', 'quiet'], margin: 20, gutter: 0, facing: { left: 1, right: 1 },
          slots: [
            { x: 0.0476, y: 0.0673, w: 0.4048, h: 0.8653, face: 'left', prefer: 'portrait' },
            { x: 0.5476, y: 0.0673, w: 0.4048, h: 0.8653, face: 'right', prefer: 'portrait' },
          ] },
        { id: 'pair-stagger', name: '上下錯落兩張', tags: ['pair', 'stagger'], margin: 12, gutter: 4, facing: { left: 1, right: 1 },
          slots: [
            { x: 0.0286, y: 0.4714, w: 0.4476, h: 0.4882, face: 'left', prefer: 'landscape' },
            { x: 0.5238, y: 0.0404, w: 0.4476, h: 0.4882, face: 'right', prefer: 'landscape' },
          ] },
        { id: 'pair-bleed-small', name: '左滿版右小圖', tags: ['pair', 'mixed'], margin: 0, gutter: 4, facing: { left: 1, right: 1 },
          slots: [
            { x: 0, y: 0, w: 0.5, h: 1, face: 'left', prefer: 'portrait' },
            { x: 0.5667, y: 0.5589, w: 0.3619, h: 0.3569, face: 'right', prefer: 'landscape' },
          ] },
        { id: 'pair-landscapes', name: '左右各一橫式', tags: ['pair', 'quiet'], margin: 12, gutter: 4, facing: { left: 1, right: 1 },
          slots: [
            { x: 0.0286, y: 0.2626, w: 0.4476, h: 0.4747, face: 'left', prefer: 'landscape' },
            { x: 0.5238, y: 0.2626, w: 0.4476, h: 0.4747, face: 'right', prefer: 'landscape' },
          ] },
        { id: 'one-two-right', name: '左大右二小', tags: ['1-2', 'mixed'], margin: 12, gutter: 4, facing: { left: 1, right: 2 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.4476, h: 0.9192, face: 'left', prefer: 'portrait' },
            { x: 0.5238, y: 0.0404, w: 0.4476, h: 0.4529, face: 'right', prefer: 'landscape' },
            { x: 0.5238, y: 0.5067, w: 0.4476, h: 0.4529, face: 'right', prefer: 'landscape' },
          ] },
        { id: 'two-one-left', name: '左二小右大', tags: ['1-2', 'mixed'], margin: 12, gutter: 4, facing: { left: 2, right: 1 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.4476, h: 0.4529, face: 'left', prefer: 'landscape' },
            { x: 0.0286, y: 0.5067, w: 0.4476, h: 0.4529, face: 'left', prefer: 'landscape' },
            { x: 0.5238, y: 0.0404, w: 0.4476, h: 0.9192, face: 'right', prefer: 'portrait' },
          ] },
        { id: 'one-two-golden', name: '左大右二小（黃金比）', tags: ['1-2', 'golden'], margin: 12, gutter: 4, facing: { left: 1, right: 2 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.4476, h: 0.9192, face: 'left', prefer: 'portrait' },
            { x: 0.5238, y: 0.0404, w: 0.4476, h: 0.5598, face: 'right', prefer: 'landscape' },
            { x: 0.5238, y: 0.6136, w: 0.4476, h: 0.346, face: 'right', prefer: 'landscape' },
          ] },
        { id: 'one-two-wide', name: '左橫圖右二橫圖', tags: ['3-up', 'band'], margin: 12, gutter: 4, facing: { left: 1, right: 2 },
          slots: [
            { x: 0.0286, y: 0.2626, w: 0.4476, h: 0.4747, face: 'left', prefer: 'landscape' },
            { x: 0.5238, y: 0.0404, w: 0.4476, h: 0.4529, face: 'right', prefer: 'landscape' },
            { x: 0.5238, y: 0.5067, w: 0.4476, h: 0.4529, face: 'right', prefer: 'landscape' },
          ] },
        { id: 'three-portraits', name: '左直式右雙直式', tags: ['3-up', 'quiet'], margin: 20, gutter: 4, facing: { left: 1, right: 2 },
          slots: [
            { x: 0.0476, y: 0.0673, w: 0.4048, h: 0.8653, face: 'left', prefer: 'portrait' },
            { x: 0.5286, y: 0.2357, w: 0.219, h: 0.4646, face: 'right', prefer: 'portrait' },
            { x: 0.7571, y: 0.2357, w: 0.219, h: 0.4646, face: 'right', prefer: 'portrait' },
          ] },
        { id: 'triptych', name: '左橫圖右雙直幅', tags: ['3-up', 'quiet'], margin: 24, gutter: 4, facing: { left: 1, right: 2 },
          slots: [
            { x: 0.0286, y: 0.2222, w: 0.4476, h: 0.4747, face: 'left', prefer: 'landscape' },
            { x: 0.5238, y: 0.1347, w: 0.219, h: 0.7306, face: 'right', prefer: 'portrait' },
            { x: 0.7524, y: 0.1347, w: 0.219, h: 0.7306, face: 'right', prefer: 'portrait' },
          ] },
        { id: 'big-three', name: '左大圖右三小', tags: ['1-3', 'mixed'], margin: 12, gutter: 4, facing: { left: 1, right: 3 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.4476, h: 0.9192, face: 'left', prefer: 'portrait' },
            { x: 0.5238, y: 0.0404, w: 0.4476, h: 0.494, face: 'right', prefer: 'landscape' },
            { x: 0.5238, y: 0.5479, w: 0.219, h: 0.4117, face: 'right', prefer: 'portrait' },
            { x: 0.7524, y: 0.5479, w: 0.219, h: 0.4117, face: 'right', prefer: 'portrait' },
          ] },
        { id: 'three-big', name: '左三小右大圖', tags: ['1-3', 'mixed'], margin: 12, gutter: 4, facing: { left: 3, right: 1 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.4476, h: 0.494, face: 'left', prefer: 'landscape' },
            { x: 0.0286, y: 0.5479, w: 0.219, h: 0.4117, face: 'left', prefer: 'portrait' },
            { x: 0.2571, y: 0.5479, w: 0.219, h: 0.4117, face: 'left', prefer: 'portrait' },
            { x: 0.5238, y: 0.0404, w: 0.4476, h: 0.9192, face: 'right', prefer: 'portrait' },
          ] },
        { id: 'quad-stacks', name: '左右各上下兩張', tags: ['2+2', 'grid'], margin: 12, gutter: 4, facing: { left: 2, right: 2 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.4476, h: 0.4529, face: 'left', prefer: 'landscape' },
            { x: 0.0286, y: 0.5067, w: 0.4476, h: 0.4529, face: 'left', prefer: 'landscape' },
            { x: 0.5238, y: 0.0404, w: 0.4476, h: 0.4529, face: 'right', prefer: 'landscape' },
            { x: 0.5238, y: 0.5067, w: 0.4476, h: 0.4529, face: 'right', prefer: 'landscape' },
          ] },
        { id: 'quad-columns', name: '左右各雙直幅', tags: ['2+2', 'quiet'], margin: 24, gutter: 4, facing: { left: 2, right: 2 },
          slots: [
            { x: 0.0286, y: 0.1212, w: 0.219, h: 0.7576, face: 'left', prefer: 'portrait' },
            { x: 0.2571, y: 0.1212, w: 0.219, h: 0.7576, face: 'left', prefer: 'portrait' },
            { x: 0.5238, y: 0.1212, w: 0.219, h: 0.7576, face: 'right', prefer: 'portrait' },
            { x: 0.7524, y: 0.1212, w: 0.219, h: 0.7576, face: 'right', prefer: 'portrait' },
          ] },
        { id: 'gallery-4', name: '直式四連幅', tags: ['2+2', 'quiet'], margin: 12, gutter: 4, facing: { left: 2, right: 2 },
          slots: [
            { x: 0.0286, y: 0.2694, w: 0.219, h: 0.4646, face: 'left', prefer: 'portrait' },
            { x: 0.2571, y: 0.2694, w: 0.219, h: 0.4646, face: 'left', prefer: 'portrait' },
            { x: 0.5238, y: 0.2694, w: 0.219, h: 0.4646, face: 'right', prefer: 'portrait' },
            { x: 0.7524, y: 0.2694, w: 0.219, h: 0.4646, face: 'right', prefer: 'portrait' },
          ] },
        { id: 'quad-stagger', name: '四張錯落', tags: ['2+2', 'stagger'], margin: 12, gutter: 4, facing: { left: 2, right: 2 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.3333, h: 0.3569, face: 'left', prefer: 'landscape' },
            { x: 0.1238, y: 0.4242, w: 0.3524, h: 0.5354, face: 'left', prefer: 'any' },
            { x: 0.5238, y: 0.0404, w: 0.3524, h: 0.5354, face: 'right', prefer: 'any' },
            { x: 0.6381, y: 0.6027, w: 0.3333, h: 0.3569, face: 'right', prefer: 'landscape' },
          ] },
        { id: 'wide-three-one', name: '左三橫條右橫圖', tags: ['1-3', 'band'], margin: 12, gutter: 4, facing: { left: 3, right: 1 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.4476, h: 0.2974, face: 'left', prefer: 'landscape' },
            { x: 0.0286, y: 0.3513, w: 0.4476, h: 0.2974, face: 'left', prefer: 'landscape' },
            { x: 0.0286, y: 0.6622, w: 0.4476, h: 0.2974, face: 'left', prefer: 'landscape' },
            { x: 0.5238, y: 0.2626, w: 0.4476, h: 0.4747, face: 'right', prefer: 'landscape' },
          ] },
        { id: 'cascade-4', name: '橫圖階梯', tags: ['2+2', 'stagger'], margin: 12, gutter: 4, facing: { left: 2, right: 2 },
          slots: [
            { x: 0.0286, y: 0.0471, w: 0.3571, h: 0.3367, face: 'left', prefer: 'landscape' },
            { x: 0.119, y: 0.4175, w: 0.3571, h: 0.3367, face: 'left', prefer: 'landscape' },
            { x: 0.5238, y: 0.202, w: 0.3571, h: 0.3367, face: 'right', prefer: 'landscape' },
            { x: 0.6143, y: 0.5724, w: 0.3571, h: 0.3367, face: 'right', prefer: 'landscape' },
          ] },
        { id: 'hero-strip', name: '通頁大圖加三小', tags: ['hero', 'band'], margin: 12, gutter: 4, facing: { left: 1, right: 2 },
          slots: [
            { x: 0, y: 0, w: 1, h: 0.6263, face: 'span', prefer: 'landscape' },
            { x: 0.0286, y: 0.6599, w: 0.4476, h: 0.2997, face: 'left', prefer: 'landscape' },
            { x: 0.5238, y: 0.6599, w: 0.219, h: 0.2997, face: 'right', prefer: 'any' },
            { x: 0.7524, y: 0.6599, w: 0.219, h: 0.2997, face: 'right', prefer: 'any' },
          ] },
        { id: 'grid4-big', name: '左四宮格右大圖', tags: ['grid', 'mixed'], margin: 12, gutter: 4, facing: { left: 4, right: 1 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.219, h: 0.4529, face: 'left', prefer: 'portrait' },
            { x: 0.2571, y: 0.0404, w: 0.219, h: 0.4529, face: 'left', prefer: 'portrait' },
            { x: 0.0286, y: 0.5067, w: 0.219, h: 0.4529, face: 'left', prefer: 'portrait' },
            { x: 0.2571, y: 0.5067, w: 0.219, h: 0.4529, face: 'left', prefer: 'portrait' },
            { x: 0.5, y: 0, w: 0.5, h: 1, face: 'right', prefer: 'portrait' },
          ] },
        { id: 'big-grid4', name: '左大圖右四宮格', tags: ['grid', 'mixed'], margin: 12, gutter: 4, facing: { left: 1, right: 4 },
          slots: [
            { x: 0, y: 0, w: 0.5, h: 1, face: 'left', prefer: 'portrait' },
            { x: 0.5238, y: 0.0404, w: 0.219, h: 0.4529, face: 'right', prefer: 'portrait' },
            { x: 0.7524, y: 0.0404, w: 0.219, h: 0.4529, face: 'right', prefer: 'portrait' },
            { x: 0.5238, y: 0.5067, w: 0.219, h: 0.4529, face: 'right', prefer: 'portrait' },
            { x: 0.7524, y: 0.5067, w: 0.219, h: 0.4529, face: 'right', prefer: 'portrait' },
          ] },
        { id: 'collage-5a', name: '拼貼五張（寬圖加雙格）', tags: ['collage', 'mixed'], margin: 12, gutter: 4, facing: { left: 3, right: 2 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.4476, h: 0.4418, face: 'left', prefer: 'landscape' },
            { x: 0.0286, y: 0.4957, w: 0.219, h: 0.4639, face: 'left', prefer: 'portrait' },
            { x: 0.2571, y: 0.4957, w: 0.219, h: 0.4639, face: 'left', prefer: 'portrait' },
            { x: 0.5238, y: 0.0404, w: 0.4476, h: 0.4529, face: 'right', prefer: 'landscape' },
            { x: 0.5238, y: 0.5067, w: 0.4476, h: 0.4529, face: 'right', prefer: 'landscape' },
          ] },
        { id: 'collage-5b', name: '拼貼五張（直幅領頭）', tags: ['collage', 'stagger'], margin: 12, gutter: 4, facing: { left: 3, right: 2 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.2476, h: 0.9192, face: 'left', prefer: 'portrait' },
            { x: 0.2857, y: 0.0404, w: 0.1905, h: 0.4529, face: 'left', prefer: 'portrait' },
            { x: 0.2857, y: 0.5067, w: 0.1905, h: 0.4529, face: 'left', prefer: 'portrait' },
            { x: 0.5238, y: 0.0404, w: 0.4476, h: 0.5434, face: 'right', prefer: 'landscape' },
            { x: 0.5238, y: 0.5973, w: 0.4476, h: 0.3623, face: 'right', prefer: 'landscape' },
          ] },
        { id: 'five-wide', name: '五張橫圖', tags: ['collage', 'band'], margin: 12, gutter: 4, facing: { left: 3, right: 2 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.4476, h: 0.2974, face: 'left', prefer: 'landscape' },
            { x: 0.0286, y: 0.3513, w: 0.4476, h: 0.2974, face: 'left', prefer: 'landscape' },
            { x: 0.0286, y: 0.6622, w: 0.4476, h: 0.2974, face: 'left', prefer: 'landscape' },
            { x: 0.5238, y: 0.0404, w: 0.4476, h: 0.4529, face: 'right', prefer: 'landscape' },
            { x: 0.5238, y: 0.5067, w: 0.4476, h: 0.4529, face: 'right', prefer: 'landscape' },
          ] },
        { id: 'portrait-five', name: '直式五連幅', tags: ['collage', 'quiet'], margin: 12, gutter: 4, facing: { left: 2, right: 3 },
          slots: [
            { x: 0.0286, y: 0.2694, w: 0.219, h: 0.4646, face: 'left', prefer: 'portrait' },
            { x: 0.2571, y: 0.2694, w: 0.219, h: 0.4646, face: 'left', prefer: 'portrait' },
            { x: 0.5286, y: 0.3535, w: 0.1429, h: 0.303, face: 'right', prefer: 'portrait' },
            { x: 0.681, y: 0.3535, w: 0.1429, h: 0.303, face: 'right', prefer: 'portrait' },
            { x: 0.8333, y: 0.3535, w: 0.1381, h: 0.303, face: 'right', prefer: 'portrait' },
          ] },
        { id: 'portrait-six', name: '左右各三連幅', tags: ['3+3', 'quiet'], margin: 12, gutter: 4, facing: { left: 3, right: 3 },
          slots: [
            { x: 0.0286, y: 0.3367, w: 0.1429, h: 0.303, face: 'left', prefer: 'portrait' },
            { x: 0.181, y: 0.3367, w: 0.1429, h: 0.303, face: 'left', prefer: 'portrait' },
            { x: 0.3333, y: 0.3367, w: 0.1429, h: 0.303, face: 'left', prefer: 'portrait' },
            { x: 0.5238, y: 0.3367, w: 0.1429, h: 0.303, face: 'right', prefer: 'portrait' },
            { x: 0.6762, y: 0.3367, w: 0.1429, h: 0.303, face: 'right', prefer: 'portrait' },
            { x: 0.8286, y: 0.3367, w: 0.1429, h: 0.303, face: 'right', prefer: 'portrait' },
          ] },
        { id: 'trios', name: '左右各一大兩小', tags: ['3+3', 'mixed'], margin: 12, gutter: 4, facing: { left: 3, right: 3 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.4476, h: 0.4845, face: 'left', prefer: 'landscape' },
            { x: 0.0286, y: 0.5383, w: 0.219, h: 0.4213, face: 'left', prefer: 'portrait' },
            { x: 0.2571, y: 0.5383, w: 0.219, h: 0.4213, face: 'left', prefer: 'portrait' },
            { x: 0.5238, y: 0.0404, w: 0.219, h: 0.4213, face: 'right', prefer: 'portrait' },
            { x: 0.7524, y: 0.0404, w: 0.219, h: 0.4213, face: 'right', prefer: 'portrait' },
            { x: 0.5238, y: 0.4751, w: 0.4476, h: 0.4845, face: 'right', prefer: 'landscape' },
          ] },
        { id: 'triple-bands', name: '左右各三橫條', tags: ['3+3', 'band'], margin: 12, gutter: 4, facing: { left: 3, right: 3 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.4476, h: 0.2974, face: 'left', prefer: 'landscape' },
            { x: 0.0286, y: 0.3513, w: 0.4476, h: 0.2974, face: 'left', prefer: 'landscape' },
            { x: 0.0286, y: 0.6622, w: 0.4476, h: 0.2974, face: 'left', prefer: 'landscape' },
            { x: 0.5238, y: 0.0404, w: 0.4476, h: 0.2974, face: 'right', prefer: 'landscape' },
            { x: 0.5238, y: 0.3513, w: 0.4476, h: 0.2974, face: 'right', prefer: 'landscape' },
            { x: 0.5238, y: 0.6622, w: 0.4476, h: 0.2974, face: 'right', prefer: 'landscape' },
          ] },
        { id: 'triple-ladder', name: '左右各一直二小（階梯）', tags: ['3+3', 'collage'], margin: 12, gutter: 4, facing: { left: 3, right: 3 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.239, h: 0.9192, face: 'left', prefer: 'portrait' },
            { x: 0.2771, y: 0.0404, w: 0.1991, h: 0.4529, face: 'left', prefer: 'portrait' },
            { x: 0.2771, y: 0.5067, w: 0.1991, h: 0.4529, face: 'left', prefer: 'portrait' },
            { x: 0.5238, y: 0.0404, w: 0.1991, h: 0.4529, face: 'right', prefer: 'portrait' },
            { x: 0.5238, y: 0.5067, w: 0.1991, h: 0.4529, face: 'right', prefer: 'portrait' },
            { x: 0.7325, y: 0.0404, w: 0.239, h: 0.9192, face: 'right', prefer: 'portrait' },
          ] },
        { id: 'triple-airy', name: '左右各三張（寬鬆留白）', tags: ['3+3', 'quiet'], margin: 28, gutter: 6, facing: { left: 3, right: 3 },
          slots: [
            { x: 0.0667, y: 0.0943, w: 0.3667, h: 0.451, face: 'left', prefer: 'landscape' },
            { x: 0.0667, y: 0.5588, w: 0.1762, h: 0.3469, face: 'left', prefer: 'portrait' },
            { x: 0.2571, y: 0.5588, w: 0.1762, h: 0.3469, face: 'left', prefer: 'portrait' },
            { x: 0.5667, y: 0.0943, w: 0.1762, h: 0.3469, face: 'right', prefer: 'portrait' },
            { x: 0.7571, y: 0.0943, w: 0.1762, h: 0.3469, face: 'right', prefer: 'portrait' },
            { x: 0.5667, y: 0.4547, w: 0.3667, h: 0.451, face: 'right', prefer: 'landscape' },
          ] },
        { id: 'collage-3-4', name: '左三右四拼貼', tags: ['collage', 'mosaic'], margin: 12, gutter: 4, facing: { left: 3, right: 4 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.4476, h: 0.4744, face: 'left', prefer: 'landscape' },
            { x: 0.0286, y: 0.5283, w: 0.219, h: 0.4313, face: 'left', prefer: 'portrait' },
            { x: 0.2571, y: 0.5283, w: 0.219, h: 0.4313, face: 'left', prefer: 'portrait' },
            { x: 0.5238, y: 0.0404, w: 0.219, h: 0.4529, face: 'right', prefer: 'portrait' },
            { x: 0.7524, y: 0.0404, w: 0.219, h: 0.4529, face: 'right', prefer: 'portrait' },
            { x: 0.5238, y: 0.5067, w: 0.219, h: 0.4529, face: 'right', prefer: 'portrait' },
            { x: 0.7524, y: 0.5067, w: 0.219, h: 0.4529, face: 'right', prefer: 'portrait' },
          ] },
        { id: 'collage-4-3', name: '左四右三拼貼', tags: ['collage', 'mosaic'], margin: 12, gutter: 4, facing: { left: 4, right: 3 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.219, h: 0.4529, face: 'left', prefer: 'portrait' },
            { x: 0.2571, y: 0.0404, w: 0.219, h: 0.4529, face: 'left', prefer: 'portrait' },
            { x: 0.0286, y: 0.5067, w: 0.219, h: 0.4529, face: 'left', prefer: 'portrait' },
            { x: 0.2571, y: 0.5067, w: 0.219, h: 0.4529, face: 'left', prefer: 'portrait' },
            { x: 0.5238, y: 0.0404, w: 0.219, h: 0.4313, face: 'right', prefer: 'portrait' },
            { x: 0.7524, y: 0.0404, w: 0.219, h: 0.4313, face: 'right', prefer: 'portrait' },
            { x: 0.5238, y: 0.4852, w: 0.4476, h: 0.4744, face: 'right', prefer: 'landscape' },
          ] },
        { id: 'mosaic-7', name: '大圖加小圖馬賽克', tags: ['mosaic', 'collage'], margin: 12, gutter: 4, facing: { left: 4, right: 3 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.4476, h: 0.5032, face: 'left', prefer: 'landscape' },
            { x: 0.0286, y: 0.5571, w: 0.1429, h: 0.4025, face: 'left', prefer: 'portrait' },
            { x: 0.181, y: 0.5571, w: 0.1429, h: 0.4025, face: 'left', prefer: 'portrait' },
            { x: 0.3333, y: 0.5571, w: 0.1429, h: 0.4025, face: 'left', prefer: 'portrait' },
            { x: 0.5238, y: 0.0404, w: 0.219, h: 0.9192, face: 'right', prefer: 'portrait' },
            { x: 0.7524, y: 0.0404, w: 0.219, h: 0.4529, face: 'right', prefer: 'portrait' },
            { x: 0.7524, y: 0.5067, w: 0.219, h: 0.4529, face: 'right', prefer: 'portrait' },
          ] },
        { id: 'seven-wide', name: '七張橫條', tags: ['collage', 'band'], margin: 12, gutter: 4, facing: { left: 3, right: 4 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.4476, h: 0.2974, face: 'left', prefer: 'landscape' },
            { x: 0.0286, y: 0.3513, w: 0.4476, h: 0.2974, face: 'left', prefer: 'landscape' },
            { x: 0.0286, y: 0.6622, w: 0.4476, h: 0.2974, face: 'left', prefer: 'landscape' },
            { x: 0.5238, y: 0.0404, w: 0.4476, h: 0.2197, face: 'right', prefer: 'landscape' },
            { x: 0.5238, y: 0.2736, w: 0.4476, h: 0.2197, face: 'right', prefer: 'landscape' },
            { x: 0.5238, y: 0.5067, w: 0.4476, h: 0.2197, face: 'right', prefer: 'landscape' },
            { x: 0.5238, y: 0.7399, w: 0.4476, h: 0.2197, face: 'right', prefer: 'landscape' },
          ] },
        { id: 'portrait-seven', name: '直式七張（一大兩小加四宮格）', tags: ['mosaic', 'quiet'], margin: 12, gutter: 4, facing: { left: 3, right: 4 },
          slots: [
            { x: 0.0286, y: 0.1347, w: 0.2952, h: 0.6263, face: 'left', prefer: 'portrait' },
            { x: 0.3333, y: 0.1347, w: 0.1429, h: 0.303, face: 'left', prefer: 'portrait' },
            { x: 0.3333, y: 0.4579, w: 0.1429, h: 0.303, face: 'left', prefer: 'portrait' },
            { x: 0.5238, y: 0.0404, w: 0.219, h: 0.4646, face: 'right', prefer: 'portrait' },
            { x: 0.7524, y: 0.0404, w: 0.219, h: 0.4646, face: 'right', prefer: 'portrait' },
            { x: 0.5238, y: 0.5185, w: 0.219, h: 0.4646, face: 'right', prefer: 'portrait' },
            { x: 0.7524, y: 0.5185, w: 0.219, h: 0.4646, face: 'right', prefer: 'portrait' },
          ] },
        { id: 'grid-4-4', name: '左右各四宮格', tags: ['4+4', 'grid'], margin: 12, gutter: 4, facing: { left: 4, right: 4 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.219, h: 0.4529, face: 'left', prefer: 'portrait' },
            { x: 0.2571, y: 0.0404, w: 0.219, h: 0.4529, face: 'left', prefer: 'portrait' },
            { x: 0.0286, y: 0.5067, w: 0.219, h: 0.4529, face: 'left', prefer: 'portrait' },
            { x: 0.2571, y: 0.5067, w: 0.219, h: 0.4529, face: 'left', prefer: 'portrait' },
            { x: 0.5238, y: 0.0404, w: 0.219, h: 0.4529, face: 'right', prefer: 'portrait' },
            { x: 0.7524, y: 0.0404, w: 0.219, h: 0.4529, face: 'right', prefer: 'portrait' },
            { x: 0.5238, y: 0.5067, w: 0.219, h: 0.4529, face: 'right', prefer: 'portrait' },
            { x: 0.7524, y: 0.5067, w: 0.219, h: 0.4529, face: 'right', prefer: 'portrait' },
          ] },
        { id: 'mosaic-4-4', name: '左右各一大三小', tags: ['4+4', 'mosaic'], margin: 12, gutter: 4, facing: { left: 4, right: 4 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.4476, h: 0.5574, face: 'left', prefer: 'landscape' },
            { x: 0.0286, y: 0.6112, w: 0.1429, h: 0.3484, face: 'left', prefer: 'portrait' },
            { x: 0.181, y: 0.6112, w: 0.1429, h: 0.3484, face: 'left', prefer: 'portrait' },
            { x: 0.3333, y: 0.6112, w: 0.1429, h: 0.3484, face: 'left', prefer: 'portrait' },
            { x: 0.5238, y: 0.0404, w: 0.1429, h: 0.3484, face: 'right', prefer: 'portrait' },
            { x: 0.6762, y: 0.0404, w: 0.1429, h: 0.3484, face: 'right', prefer: 'portrait' },
            { x: 0.8286, y: 0.0404, w: 0.1429, h: 0.3484, face: 'right', prefer: 'portrait' },
            { x: 0.5238, y: 0.4022, w: 0.4476, h: 0.5574, face: 'right', prefer: 'landscape' },
          ] },
        { id: 'bands-4-4', name: '左右各四橫條', tags: ['4+4', 'band'], margin: 12, gutter: 4, facing: { left: 4, right: 4 },
          slots: [
            { x: 0.0286, y: 0.0404, w: 0.4476, h: 0.2197, face: 'left', prefer: 'landscape' },
            { x: 0.0286, y: 0.2736, w: 0.4476, h: 0.2197, face: 'left', prefer: 'landscape' },
            { x: 0.0286, y: 0.5067, w: 0.4476, h: 0.2197, face: 'left', prefer: 'landscape' },
            { x: 0.0286, y: 0.7399, w: 0.4476, h: 0.2197, face: 'left', prefer: 'landscape' },
            { x: 0.5238, y: 0.0404, w: 0.4476, h: 0.2197, face: 'right', prefer: 'landscape' },
            { x: 0.5238, y: 0.2736, w: 0.4476, h: 0.2197, face: 'right', prefer: 'landscape' },
            { x: 0.5238, y: 0.5067, w: 0.4476, h: 0.2197, face: 'right', prefer: 'landscape' },
            { x: 0.5238, y: 0.7399, w: 0.4476, h: 0.2197, face: 'right', prefer: 'landscape' },
          ] },
    ]);

    const facing = t => {
        const n = { left: 0, right: 0, span: 0 };
        for (const s of (t && t.slots) || []) if (s && n[s.face] !== undefined) n[s.face]++;
        return n;
    };
    const byId = id => TEMPLATES.find(t => t.id === id) || null;

    // The checks every template must pass. Returns { ok, errors: [{ id, code, message }] };
    // never throws, never modifies its input. Codes:
    //   bad-id, dup-id, no-slots, bad-tag, bad-slot, out-of-range, overlap,
    //   face-mismatch, crosses-fold, span-not-hero, hero-without-span,
    //   face-limit, too-small, prefer-mismatch, facing-mismatch
    function validate(templates) {
        const errors = [];
        if (!Array.isArray(templates)) {
            return { ok: false, errors: [{ id: null, code: 'bad-id', message: 'templates must be an array' }] };
        }
        const seen = new Set();
        templates.forEach((t, n) => {
            const id = t && typeof t.id === 'string' && t.id ? t.id : null;
            const label = id || `#${n}`;
            const err = (code, message) => errors.push({ id, code, message: `${label}: ${message}` });
            if (!t || typeof t !== 'object') { err('bad-id', 'not an object'); return; }
            if (!id) err('bad-id', 'needs an id string');
            else if (seen.has(id)) err('dup-id', 'id used twice');
            else seen.add(id);
            if (!Array.isArray(t.tags) || t.tags.length === 0 || t.tags.some(x => !TAGS.includes(x)) || new Set(t.tags).size !== t.tags.length) {
                err('bad-tag', `tags must be a non-empty list of known tags, got ${JSON.stringify(t.tags)}`);
            }
            const slots = Array.isArray(t.slots) ? t.slots : [];
            if (slots.length === 0) { err('no-slots', 'has no slots'); return; }
            let left = 0, right = 0, span = 0;
            const sound = [];
            slots.forEach((s, i) => {
                const at = `slot ${i}`;
                if (!s || ['x', 'y', 'w', 'h'].some(k => !Number.isFinite(s[k])) || !(s.w > 0) || !(s.h > 0)) {
                    err('bad-slot', `${at} needs finite x, y and positive w, h`); return;
                }
                if (!FACES.includes(s.face)) { err('face-mismatch', `${at}: face ${JSON.stringify(s.face)}`); return; }
                sound.push(s);
                if (s.x < -EPS || s.y < -EPS || s.x + s.w > 1 + EPS || s.y + s.h > 1 + EPS) err('out-of-range', `${at} leaves the spread`);
                const wmm = s.w * SPREAD_MM.w, hmm = s.h * SPREAD_MM.h;
                if (wmm < MIN_MM - 0.05 || hmm < MIN_MM - 0.05) err('too-small', `${at} is ${wmm.toFixed(1)} x ${hmm.toFixed(1)} mm, under ${MIN_MM}`);
                const aspect = wmm / hmm;
                if (!PREFERS.includes(s.prefer)
                    || (s.prefer === 'landscape' && aspect < SHAPE_TOLERANCE)
                    || (s.prefer === 'portrait' && aspect > 1 / SHAPE_TOLERANCE)) {
                    err('prefer-mismatch', `${at} prefers ${JSON.stringify(s.prefer)} but is ${aspect.toFixed(2)}:1`);
                }
                if (s.face === 'left') {
                    left++;
                    if (s.x >= 0.5 - EPS) err('face-mismatch', `${at} is labelled left but sits on the right page`);
                    else if (s.x + s.w > 0.5 + EPS) err('crosses-fold', `${at} is on the left page but crosses the fold`);
                } else if (s.face === 'right') {
                    right++;
                    if (s.x + s.w <= 0.5 + EPS) err('face-mismatch', `${at} is labelled right but sits on the left page`);
                    else if (s.x < 0.5 - EPS) err('crosses-fold', `${at} is on the right page but crosses the fold`);
                }
                else {
                    span++;
                    if (!(s.x < 0.5 - EPS && s.x + s.w > 0.5 + EPS)) err('face-mismatch', `${at} is "span" but does not cross the fold`);
                }
            });
            for (let a = 0; a < sound.length; a++) for (let b = a + 1; b < sound.length; b++) {
                const p = sound[a], q = sound[b];
                const ox = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
                const oy = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
                if (ox > EPS && oy > EPS) err('overlap', `slots ${slots.indexOf(p)} and ${slots.indexOf(q)} overlap`);
            }
            const hero = Array.isArray(t.tags) && t.tags.includes('hero');
            if (span > 0 && !hero) err('span-not-hero', 'crosses the fold without the hero tag');
            if (hero && span === 0) err('hero-without-span', 'is tagged hero but has no span slot');
            if (span > 1) err('span-not-hero', `${span} span slots (one at most)`);
            if (left > MAX_PER_FACE || right > MAX_PER_FACE) err('face-limit', `${left} photos on the left and ${right} on the right (at most ${MAX_PER_FACE} a page)`);
            const f = t.facing;
            if (!f || f.left !== left || f.right !== right) {
                err('facing-mismatch', `facing ${JSON.stringify(f)} but the slots say ${JSON.stringify({ left, right })}`);
            }
        });
        return { ok: errors.length === 0, errors };
    }

    return { SPREAD_MM, MAX_PER_FACE, MIN_MM, TAGS, TEMPLATES, validate, facing, byId };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SpreadTemplates;
