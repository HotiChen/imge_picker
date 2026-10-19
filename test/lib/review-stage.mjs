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
// ── pins (suite 92 onwards)
export const rsPin = (x, y, note = '') => ({ x, y, note });
export const rsUntil = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await rsSleep(40); } return false; };
export const rsPuts = w => w.calls.filter(c => c.method === 'PUT' && c.path === '/api/pick/revision-pins');
// The screen point of a fraction of the photo as the canvas shows it now (zoom and pan included).
export const rsPoint = (page, fx, fy) => page.evaluate(([fx, fy]) => {
  const a = window.annotationManager;
  const r = a.canvas.getBoundingClientRect();
  return { x: r.left + a.offsetX + a.panX + a.zoom * fx * a.fitW, y: r.top + a.offsetY + a.panY + a.zoom * fy * a.fitH };
}, [fx, fy]);
// what the canvas holds for the photo on show
export const rsMarks = page => page.evaluate(() => window.annotationManager.marks.map(m => ({ ...m })));

// ── the action button and its dialogs (suite 93 onwards)
export const rsRounds = w => w.calls.filter(c => c.method === 'POST' && c.path === '/api/pick/revision-round');
export const rsModalActive = (page, id) => page.evaluate(i => { const e = document.getElementById(i); return !!e && e.classList.contains('active') && getComputedStyle(e).display !== 'none'; }, id);

export const rsSettled = (page, i) => page.waitForFunction(k => {
  const a = window.annotationManager;
  return !!a && a.currentPhoto && a.currentPhoto.id === k && a.imageElement && a.imageElement.naturalWidth > 0 && a.fitW > 0 && !a.canvas.parentElement.classList.contains('photo-loading') &&
    document.querySelector('#photoModal .modal-content').getAnimations().length === 0;
}, rsKey(i), { timeout: 6000 });
