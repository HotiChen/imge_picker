// The 驗收頁 as the 毛片 page (docs/delivery.md, "The 驗收頁 is the 毛片 page"): a delivered, not yet confirmed
// project shows the standard photo grid and the standard preview (zoom, pins through PickController).
// Shared by the 驗收頁 suites (91 onwards). The fake Worker is the revision-pins world
// (test/lib/revision-pins-fake.mjs) on the album world's SVG finals.
import { base } from './harness.mjs';
import { albKeys } from './album-world.mjs';
import { pinsWorld } from './revision-pins-fake.mjs';

export const RS_OWNER = "localStorage.setItem('pick_key:TOK', 'ZOE-KEY');";
export const rsUrl = `${base}/index.html?t=TOK`;
export const rsKey = i => albKeys(8)[i - 1];                    // shoot/精修/IMG_000i.jpg (1 = landscape, 2 = portrait, ...)
export const rsWorld = (o = {}) => pinsWorld({ n: 8, ...o, fake: { title: '婚禮精修', ...(o.fake || {}) } });
export const rsSleep = ms => new Promise(r => setTimeout(r, ms));
export const rsLine = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
export const rsHas = (page, sel) => page.evaluate(s => !!document.querySelector(s), sel);

// Opens photo `i` in the standard preview and waits until its own picture (not the stand-in) is on the canvas.
export async function rsOpen(page, i) {
  const sel = `.photo-card[data-photo-id="${rsKey(i)}"]`;
  await page.waitForSelector(sel, { timeout: 6000 });
  await page.click(sel);
  await page.waitForSelector('#photoModal.active', { timeout: 5000 });
  await rsSettled(page, i);
}
export const rsSettled = (page, i) => page.waitForFunction(k => {
  const a = window.annotationManager;
  return !!a && a.currentPhoto && a.currentPhoto.id === k && a.imageElement && a.imageElement.naturalWidth > 0 && a.fitW > 0 && !a.canvas.parentElement.classList.contains('photo-loading') &&
    document.querySelector('#photoModal .modal-content').getAnimations().length === 0;
}, rsKey(i), { timeout: 6000 });
