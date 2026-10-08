// Helpers shared by the project, preview and pick-counter suites.
// Shared by more than one file in test/suites/; helpers used by a single suite file stay in that file.

// ═══════════════════════════════════════════════════════════════════════════
// Admin — the guest-picking project panel (docs/guest-picking.md)
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// 資料夾流程 (docs/delivery.md「資料夾慣例」): 建專案時由「拍攝日期 + 專案名稱」決定資料夾，
// 上傳與精修自動進對的資料夾。js/project-folders.js 是命名的唯一出處。
// ═══════════════════════════════════════════════════════════════════════════
export const PF_ROOT = '20261004 王小明';
export const pfLists = m => m.requests.filter(r => r.method === 'GET' && new URLSearchParams(r.search).has('list'))
  .map(r => ({ prefix: new URLSearchParams(r.search).get('list'), auth: r.auth }));
export const PF_NAMES = ['精修', '精修二', '精修三', '精修四', '精修五', '精修六', '精修七', '精修八', '精修九', '精修十', '精修11', '精修12'];

// In-page: the big photo is loaded and the modal's slideUp entrance has
// finished — until then every rect is still moving.
export const PREVIEW_SETTLED = () => annotationManager.imageElement?.naturalWidth === 1600
  && document.querySelector('#photoModal .modal-content').getAnimations().length === 0;

export async function openBigGuestPreview(page) {
  await page.waitForSelector('.photo-card', { timeout: 5000 });
  await page.locator('.photo-card').first().tap();
  await page.waitForSelector('#photoModal.active', { timeout: 5000 });
  await page.waitForFunction(PREVIEW_SETTLED, null, { timeout: 5000 });
  await page.waitForTimeout(100);
  const box = await page.locator('.canvas-container').boundingBox();
  return { cx: Math.round(box.x + box.width / 2), cy: Math.round(box.y + box.height / 2) };
}

// ── one pick counter (bottom-left), over-limit colour, over-limit submit modal ──
export const pickHeart = (page, i) => page.locator('.photo-card').nth(i).locator('.pick-heart-btn').click();
export const pickSubmits = m => m.requests.filter(r => r.method === 'POST' && r.path === '/api/pick/submit');

// admin.html: the create form sits behind 「＋ 新增專案」 (closed on load). Opens it; a re-open resets the fields.
export async function openCreateForm(page) {
  if (await page.$eval('#project-create-panel', e => e.hidden)) await page.click('#proj-new-btn');
  await page.waitForSelector('#project-create-panel:not([hidden]) #proj-title', { state: 'visible', timeout: 5000 });
}
