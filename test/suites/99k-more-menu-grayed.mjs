// Browser suites (2026-10-20): the project page's ⋯ menu never hides an item that does not apply: it stays in the same
// place, grayed (aria-disabled, a token gray, never red), with the reason in small text on the item. A click on it does
// nothing; the arrow keys pass over it. 看全部毛片 (menu) and the 毛片 row's 「看」 gray out when there is no 毛片.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { openMore } from '../lib/project-helpers.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const URL_ = `${base}/admin.html#project=proj-gm`;
const PROOFS = ['shoot/', 'shoot/毛片/'];
const fx = (o = {}) => pickFakeWorker({ projectId: 'proj-gm', title: '灰項專案', ownerName: '你好', folders: ['shoot/毛片/'], bucketFolders: PROOFS, ...o });
const ORDER = ['設定', '看全部毛片', '複製交件通知文案', '開放修改', '取消交件', '—', '重設主人', '封存', '刪除'];
const sub = at => ({ id: 's-' + at, picker_id: 'picker-0', relationship: '本人', email: 'a@example.com', photo_keys: ['shoot/毛片/a.jpg'], count: 1, pick_limit: null, extra_price: null, created_at: at, notified: 0 });
// every item: label, reason, aria-disabled, colour, height, href
const MENU = () => [...document.querySelectorAll('#pd-more-menu [role="menuitem"], #pd-more-menu [role="separator"]')].map(e => {
  if (e.getAttribute('role') === 'separator') return { label: '—' };
  const cs = getComputedStyle(e);
  return { id: e.id, label: e.querySelector('.pd-more-label')?.textContent.trim(), reason: e.querySelector('.pd-more-reason')?.textContent.trim() || '',
    off: e.getAttribute('aria-disabled') === 'true', color: cs.color, bg: cs.backgroundColor, h: Math.round(e.getBoundingClientRect().height),
    href: e.getAttribute('href'), tag: e.tagName, reasonVisible: !!e.querySelector('.pd-more-reason') && e.querySelector('.pd-more-reason').getClientRects().length > 0 };
});
const menu = async page => { await openMore(page); return page.evaluate(MENU); };
const byId = (items, id) => items.find(i => i.id === id);
const waitReady = page => page.waitForSelector('#pd-photos[data-target="ready"], #pd-photos[data-target="failed"]', { state: 'attached', timeout: 5000 });
const lum = c => { const [r, g, b] = c.match(/\d+/g).slice(0, 3).map(Number).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
const CTX = { ...MOBILE, viewport: { width: 390, height: 844 } };

// ── 1. every rule, in the fixed order ──
const CASES = [
  ['picking, nobody claimed, no submission, no 毛片 folder', { ownerName: undefined, bucketFolders: ['shoot/'], folders: [] },
    { '複製交件通知文案': '尚未交件', '取消交件': '尚未交件', '開放修改': '還沒送出選片', '看全部毛片': '還沒有毛片', '重設主人': '還沒有人認領', '刪除': '' }],
  ['folders recorded on the project but the listing of its root has no 毛片 folder (the 準備中 knowledge)', { bucketFolders: ['shoot/'] },
    { '複製交件通知文案': '尚未交件', '取消交件': '尚未交件', '開放修改': '還沒送出選片', '看全部毛片': '還沒有毛片', '重設主人': '', '刪除': '' }],
  ['picking, owner, 毛片 present', {},
    { '複製交件通知文案': '尚未交件', '取消交件': '尚未交件', '開放修改': '還沒送出選片', '看全部毛片': '', '重設主人': '', '刪除': '' }],
  ['submitted + a submission', { phase: 'submitted', submissions: 1 },
    { '複製交件通知文案': '尚未交件', '取消交件': '尚未交件', '開放修改': '', '看全部毛片': '', '重設主人': '', '刪除': '已有送出紀錄，不能刪' }],
  ['delivered', { phase: 'retouching', deliveredAt: '2026-09-20T00:00:00.000Z', finalFolders: ['shoot/精修/'], bucketFolders: [...PROOFS, 'shoot/精修/'] },
    { '複製交件通知文案': '', '取消交件': '', '開放修改': '', '看全部毛片': '', '重設主人': '', '刪除': '' }],
  ['retouching, not delivered (reopen is meaningful)', { phase: 'retouching' },
    { '複製交件通知文案': '尚未交件', '取消交件': '尚未交件', '開放修改': '', '看全部毛片': '', '重設主人': '', '刪除': '' }],
];
for (const [name, o0, want] of CASES) {
  const o = { ...o0 };
  const subs = o.submissions; delete o.submissions;
  const m = fx(o);
  if (subs) m.state.submissions.push(sub('2026-10-10T02:00:00.000Z'));
  await suite(`⋯ menu grayed — ${name}: same order, reasons on the items`, URL_, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#pd-more-btn', { timeout: 5000 });
    await waitReady(page);
    const items = await menu(page);
    ok('same fixed order, nothing missing or hidden', JSON.stringify(items.map(i => i.label)) === JSON.stringify(ORDER), JSON.stringify(items.map(i => i.label)));
    for (const [label, reason] of Object.entries(want)) {
      const it = items.find(i => i.label === label);
      ok(`${label}: ${reason ? `grayed, reason「${reason}」 visible` : 'active, no reason'}`,
        !!it && it.off === !!reason && it.reason === reason && (!reason || it.reasonVisible), JSON.stringify(it));
    }
    ok('設定 and 封存 stay active', !byId(items, 'pd-settings-btn').off && !byId(items, 'pd-archive-btn').off);
    ok('every item >= 44px (positive: 8 items)', items.filter(i => i.id).length === 8 && items.filter(i => i.id).every(i => i.h >= 44), JSON.stringify(items.map(i => i.h)));
    const offs = items.filter(i => i.off), ons = items.filter(i => i.id && !i.off);
    const red = byId(items, 'pd-archive-btn').color;
    // text-only gray (Tim): no fill on a grayed item; contrast is measured against the menu's own surface
    const menuBg = await page.$eval('#pd-more-menu', e => getComputedStyle(e).backgroundColor);
    ok('grayed items have no fill of their own and a lighter text colour than an active item (as many grayed as expected)', offs.length === Object.values(want).filter(Boolean).length &&
      offs.every(i => i.bg === 'rgba(0, 0, 0, 0)' && lum(i.color) > lum(byId(items, 'pd-settings-btn').color)), JSON.stringify(offs.map(i => [i.label, i.color, i.bg])));
    ok('grayed items use the gray (never the danger red, contrast >= 4.5); active danger items stay red', offs.length === Object.values(want).filter(Boolean).length &&
      red !== byId(items, 'pd-settings-btn').color && offs.every(i => i.color !== red && contrast(i.color, menuBg) >= 4.5) &&
      ons.filter(i => ['pd-reset-seat-btn', 'pd-archive-btn', 'pd-delete-btn'].includes(i.id)).every(i => i.color === red),
      JSON.stringify(items.map(i => [i.label, i.color, i.bg])));
    ok('grayed is not an opacity trick (fully opaque)', await page.$$eval('#pd-more-menu .is-off', els => els.every(e => getComputedStyle(e).opacity === '1')));
    // the lock is CSS-generated (textContent stays the plain reason): read it from the pseudo-element
    const locks = await page.$$eval('#pd-more-menu .pd-more-item', els => els.map(e => ({ off: e.getAttribute('aria-disabled') === 'true',
      lock: (() => { const r = e.querySelector('.pd-more-reason'); return r ? getComputedStyle(r, '::before').content : 'none'; })() })));
    ok('every grayed item shows a lock before its reason, no active item does (as many locks as grayed items)',
      locks.filter(l => l.off).length === offs.length && locks.filter(l => l.off).every(l => l.lock.includes('\u{1F512}')) && locks.filter(l => !l.off).every(l => !l.lock.includes('\u{1F512}')),
      JSON.stringify(locks));
    return out;
  }, { before: m.attach, initScript: ADMIN, contextOptions: CTX });
}

// ── 2. a click on a grayed item does nothing; the menu stays; the link has no href ──
{
  const m = fx({ ownerName: undefined, bucketFolders: ['shoot/'], folders: [] });
  await suite('⋯ menu grayed — clicking grayed items sends nothing, navigates nowhere, the menu stays open', URL_, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#pd-more-btn', { timeout: 5000 });
    await waitReady(page);
    await openMore(page);
    const writes = () => m.requests.filter(r => r.method !== 'GET').length;
    const w0 = writes(), url0 = page.url();
    page.on('dialog', d => { out.push('FAIL  a dialog opened: ' + d.message()); d.dismiss(); });
    ok('positive: 重設主人, 開放修改, 取消交件, 複製交件通知文案, 看全部毛片 are all grayed here',
      await page.$$eval('#pd-reset-seat-btn.is-off, #pd-reopen-btn.is-off, #pd-undeliver-btn.is-off, #pd-copy-notice-btn.is-off, #pd-view-all-btn.is-off', e => e.length === 5));
    for (const id of ['pd-reset-seat-btn', 'pd-reopen-btn', 'pd-undeliver-btn', 'pd-copy-notice-btn', 'pd-view-all-btn']) {
      await page.click('#' + id, { force: true });   // Playwright treats aria-disabled as not enabled; a real finger still lands
      await page.waitForTimeout(80);
    }
    ok('no write request was sent', writes() === w0, JSON.stringify(m.requests.filter(r => r.method !== 'GET').map(r => r.method + r.path)));
    ok('the page did not navigate', page.url() === url0, page.url());
    ok('the menu is still open', await page.$eval('#pd-more-menu', e => !e.hidden));
    ok('看全部毛片 grayed has no href', await page.$eval('#pd-view-all-btn', a => !a.hasAttribute('href') && a.getAttribute('aria-disabled') === 'true'));
    return out;
  }, { before: m.attach, initScript: ADMIN, contextOptions: CTX });
}

// ── 3. keyboard: arrows pass over grayed items ──
{
  const m = fx({ phase: 'submitted' });
  m.state.submissions.push(sub('2026-10-10T02:00:00.000Z'));
  await suite('⋯ menu grayed — arrows skip grayed items (focus order: 設定, 看全部毛片, 開放修改, 重設主人, 封存), wrapping', URL_, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#pd-more-btn', { timeout: 5000 });
    await waitReady(page);
    await openMore(page);
    const active = () => page.evaluate(() => document.activeElement.id);
    ok('opens on 設定', (await active()) === 'pd-settings-btn');
    const seen = [];
    for (let i = 0; i < 5; i++) { await page.keyboard.press('ArrowDown'); seen.push(await active()); }
    ok('ArrowDown visits only the active items and wraps', JSON.stringify(seen) === JSON.stringify(['pd-view-all-btn', 'pd-reopen-btn', 'pd-reset-seat-btn', 'pd-archive-btn', 'pd-settings-btn']), JSON.stringify(seen));
    await page.keyboard.press('ArrowUp');
    ok('ArrowUp from the first wraps to the last ACTIVE item (刪除 is grayed here)', (await active()) === 'pd-archive-btn', await active());
    await page.keyboard.press('Home');
    ok('Home -> 設定', (await active()) === 'pd-settings-btn');
    await page.keyboard.press('End');
    ok('End -> 封存', (await active()) === 'pd-archive-btn');
    await page.keyboard.press('Escape');
    ok('Esc closes, focus on ⋯', (await active()) === 'pd-more-btn' && await page.$eval('#pd-more-menu', e => e.hidden));
    return out;
  }, { before: m.attach, initScript: ADMIN, contextOptions: CTX });
}

// ── 4. active items still act (positive: the gray gate does not swallow real clicks) ──
{
  const m = fx({ phase: 'submitted' });
  await suite('⋯ menu grayed — an active 開放修改 still sends its request', URL_, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#pd-more-btn', { timeout: 5000 });
    await waitReady(page);
    await openMore(page);
    ok('開放修改 is active here', await page.$eval('#pd-reopen-btn', b => b.getAttribute('aria-disabled') !== 'true'));
    await page.click('#pd-reopen-btn');
    await page.waitForTimeout(300);
    ok('POST .../reopen was sent', m.requests.some(r => r.method === 'POST' && r.path.endsWith('/reopen')));
    return out;
  }, { before: m.attach, initScript: ADMIN, contextOptions: CTX });
}

// ── 5. the 毛片 row's 看 ──
for (const [name, o, grayed] of [['no 毛片 folder in the listing', { bucketFolders: ['shoot/'], folders: [] }, true], ['毛片 present', {}, false]]) {
  const m = fx(o);
  await suite(`⋯ menu grayed — the 照片 card's 毛片 row 看 is ${grayed ? 'grayed with its reason' : 'a live link'} (${name})`, URL_, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#pd-more-btn', { timeout: 5000 });
    await waitReady(page);
    const r = await page.$eval('[data-version="proofs"]', row => {
      const v = row.querySelector('[data-view]');
      return { tag: v.tagName, disabled: v.disabled || v.getAttribute('aria-disabled') === 'true', href: v.getAttribute('href'), text: row.textContent, h: Math.round(v.getBoundingClientRect().height) };
    });
    ok(grayed ? 'a real disabled button, no href, the row says 還沒有毛片' : 'an anchor with an href to the review view, not disabled',
      grayed ? r.tag === 'BUTTON' && r.disabled && !r.href && r.text.includes('還沒有毛片') : r.tag === 'A' && !r.disabled && /mode=all/.test(r.href) && !r.text.includes('還沒有毛片'), JSON.stringify(r));
    ok('>= 44px', r.h >= 44, String(r.h));
    return out;
  }, { before: m.attach, initScript: ADMIN, contextOptions: CTX });
}

}
