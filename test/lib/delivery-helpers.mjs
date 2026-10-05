// Helpers shared by the guest 確認完成, admin 交件 and guest download / delivered suites.
// Shared by more than one file in test/suites/; helpers used by a single suite file stay in that file.

// ═══════════════════════════════════════════════════════════════════════════
// Client confirmation (docs/delivery.md) — the guest's 確認完成 / 需要修改
// ═══════════════════════════════════════════════════════════════════════════

export const DONE_FILES = ['shoot/毛片/a.jpg', 'shoot/精修/f1.jpg', 'shoot/精修/f2.jpg', 'shoot/精修二/g1.jpg'];
export const doneOpts = (o = {}) => ({
  ownerName: 'Zoe', ownerKey: 'ZOE-KEY', phase: 'retouching', folders: ['shoot/毛片/'], finalFolders: ['shoot/精修/'],
  deliveredAt: '2026-09-20T00:00:00.000Z', pickFiles: DONE_FILES, title: 'D 專案', ...o });
export const donePosts = (m, what) => m.requests.filter(r => r.method === 'POST' && r.path === `/api/pick/${what}`);
// the luminance of a computed rgb()/rgba() colour, 0..1
export const LUM = `(c => { const m = c.match(/[\\d.]+/g).map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; })`;
export const modalShown = (page, id) => page.evaluate(i => {
  const el = document.getElementById(i);
  return !!el && el.classList.contains('active') && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0;
}, id);

// ═══════════════════════════════════════════════════════════════════════════
// Delivered projects (docs/dashboard-settings.md) — admin.html project detail
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// Delivery (docs/delivery.md) — admin.html 交件 block + the proof-download
// switch, and the guest link's delivery gallery
// ═══════════════════════════════════════════════════════════════════════════

export const WORKER = 'https://imagepicker.hotichen.workers.dev';
export const ADMIN_BUCKET = ['shoot/', 'shoot/毛片/', 'shoot/精修/', 'shoot/精修二/', 'shoot/毛片/sub/', '_hidden/'];

// Opens the folder picker's overlay, walks into `path` (a list of prefixes,
// each entered from the one before) and ticks `folders`, then confirms.
export async function adminPickFinals(page, enterPath, folders) {
  await page.waitForSelector('#folder-picker[style*="flex"]', { timeout: 3000 });
  for (const prefix of enterPath) {
    await page.click(`#folder-picker [data-browse="${prefix}"]`);
    await page.waitForFunction(p => document.getElementById('folder-picker-path').textContent === p, prefix, { timeout: 3000 });
  }
  for (const f of folders) {
    await page.waitForSelector(`#folder-picker [data-pick-folder="${f}"]`, { timeout: 3000 });
    await page.evaluate(x => {
      const box = document.querySelector(`#folder-picker [data-pick-folder="${x}"]`);
      if (!box.checked) box.click();
    }, f);
  }
  await page.click('#folder-picker [data-confirm-folders]');
}
// The 交件 chooser of a project whose proofs are in <root>/毛片/ starts on the newest 精修 folder under
// <root>/ (docs/delivery.md). Waits for that preselection, checks it is `folder`, and drops it so a test
// that is about something else goes on from the empty draft it always started from.
export async function adminDropDefaultFinal(page, ok, folder) {
  await page.waitForSelector('#pd-final-chips [data-final-chip]', { timeout: 5000 }).catch(() => {});
  const chips = await page.$$eval('#pd-final-chips [data-final-chip]', els => els.map(e => e.dataset.finalChip));
  ok(`the newest 精修 folder (${folder}) is preselected and 交件 is enabled`,
    JSON.stringify(chips) === JSON.stringify([folder]) && !(await page.$eval('#pd-deliver-btn', b => b.disabled)), JSON.stringify(chips));
  await page.click(`#pd-final-chips [data-remove-final="${folder}"]`);
}
export const chipTexts = (page, sel) => page.$$eval(sel, els => els.map(e => e.dataset.finalChip));

// ═══════════════════════════════════════════════════════════════════════════
// Client confirmation (docs/delivery.md) — admin.html: list badge, the 交件
// block's confirmation state, the revision requests, 標記完成
// ═══════════════════════════════════════════════════════════════════════════

export const ADM_REVS = () => [
  { message: '最舊：已處理的要求', picker_id: 'picker-0', created_at: '2026-09-20T02:00:00.000Z', resolved_at: '2026-09-21T01:00:00.000Z' },
  { message: '第二點 f1.jpg 偏黃', picker_id: 'picker-0', created_at: '2026-09-21T03:00:00.000Z' },
  { message: '最新：背景路人', picker_id: 'picker-0', created_at: '2026-09-22T04:00:00.000Z' },
];
export const admDelivered = (o = {}) => ({ projectId: 'proj-cf', title: '確認專案', phase: 'retouching', ownerName: 'Zoe', folders: ['shoot/毛片/'],
  finalFolders: ['shoot/精修/'], deliveredAt: '2026-09-20T00:00:00.000Z', bucketFolders: ADMIN_BUCKET, ...o });
export const DL = key => `${WORKER}/${key}?download=1&t=TOK`;
export const listed = m => m.requests.filter(r => r.search.includes('list=')).map(r => decodeURIComponent(new URLSearchParams(r.search).get('list')));
