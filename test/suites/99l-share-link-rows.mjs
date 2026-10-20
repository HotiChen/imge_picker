// Browser suites (2026-10-20): 挑選人與連結 on the project page, Tim's iPhone screenshots.
//  - the collapsed title row is two lines: line 1 = the title + a real 複製連結 button (a sibling of the toggle, not inside it),
//    line 2 = the summary text; with no live link the button is grayed with 「沒有有效連結」 and does nothing
//  - each link row (opened) is two lines: line 1 = the token (one line, ellipsis) + 複製連結 / 撤銷 at its end, line 2 = the badge
//  - nothing leaves the card, buttons >= 44px, no sideways scroll at 390 / 360 / 320, collapsed and open.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN_PLAIN as ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const URL_ = `${base}/admin.html#project=proj-lk`;
const TOKEN = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hJ3lO6rU9xA2b';
const fx = (o = {}) => pickFakeWorker({ projectId: 'proj-lk', title: '連結專案', ownerName: undefined, listToken: TOKEN, folders: ['shoot/毛片/'], bucketFolders: ['shoot/', 'shoot/毛片/'], ...o });
const waitReady = page => page.waitForSelector('#pd-photos[data-target="ready"], #pd-photos[data-target="failed"]', { state: 'attached', timeout: 5000 });
const R = e => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height, cy: (b.top + b.bottom) / 2 }; };

for (const width of [390, 360, 320, 800]) {
  // a second, revoked link (when the fake supports it) is added below by editing the state
  const m = fx();
  m.state.tokens.unshift({ token: 'REVOKED-' + TOKEN, created_at: '2025-12-01T00:00:00.000Z', expires_at: '2027-01-01T00:00:00.000Z', revoked_at: '2026-01-02T00:00:00.000Z' });
  await suite(`share link rows — ${width}px: collapsed title row = 2 lines (title + 複製連結 / summary), open link rows = 2 lines, nothing leaves the card`, URL_, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#pd-more-btn', { timeout: 5000 });
    await waitReady(page);
    // collapsed
    let g = await page.evaluate(`(${(() => {
      const R = e => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, h: b.height, cy: (b.top + b.bottom) / 2 }; };
      const sec = document.getElementById('pd-sec-people');
      const copy = document.getElementById('pd-sec-people-copy'), btn = document.getElementById('pd-sec-people-btn'), sum = document.getElementById('pd-sec-people-sum'), title = btn.querySelector('.pd-sec-title');
      return { iw: innerWidth, sw: document.scrollingElement.scrollWidth, open: btn.getAttribute('aria-expanded'), copy: R(copy), btn: R(btn), sum: R(sum), title: R(title), sec: R(sec),
        nested: !!btn.querySelector('button, a') || !!copy.parentElement.closest('button'), sumText: sum.textContent, copyText: copy.textContent, disabled: copy.getAttribute('aria-disabled') };
    }).toString()})()`);
    ok('collapsed to start with (positive)', g.open === 'false', g.open);
    ok('複製連結 is a real <button>, a sibling of the toggle (not nested), >= 44px', !g.nested && g.copy.h >= 44 && g.copyText.trim() === '複製連結', JSON.stringify(g));
    ok('line 1 holds the title and the button (their centres are on the same line); line 2 = the summary below both', Math.abs(g.copy.cy - g.title.cy) <= 6 && g.sum.t >= g.title.b - 2 && g.sum.t >= g.copy.b - 8, JSON.stringify(g));
    ok('the summary keeps its text', /^尚無人認領 · 連結有效 1 條$/.test(g.sumText), g.sumText);
    ok('the button is inside the card and the screen, no sideways scroll', g.copy.r <= g.sec.r && g.copy.l >= g.sec.l && g.copy.r <= g.iw && g.sw <= g.iw && g.sec.r <= g.iw, JSON.stringify(g));
    // a click on 複製連結 copies and does not toggle
    await page.click('#pd-sec-people-copy');
    await page.waitForSelector('#pd-share-link', { timeout: 3000 });
    ok('a click on 複製連結 does not open the section', await page.$eval('#pd-sec-people-btn', b => b.getAttribute('aria-expanded')) === 'false');
    ok('and gives the same feedback as the other 複製連結 (the share dialog shows this link)', await page.evaluate(t => document.body.textContent.includes(t), TOKEN));
    await page.keyboard.press('Escape');
    // open
    await page.evaluate(() => { document.getElementById('pd-share-link')?.remove(); });
    await page.click('#pd-sec-people-btn');
    await page.waitForFunction(() => document.querySelectorAll('[data-token-row]').length === 2 && document.querySelector('[data-token-row]').getClientRects().length > 0);
    const o = await page.evaluate(`(${(() => {
      const R = e => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, h: b.height, w: b.width, cy: (b.top + b.bottom) / 2 }; };
      const sec = R(document.getElementById('pd-sec-people'));
      const rows = [...document.querySelectorAll('[data-token-row]')].map(row => {
        const top = row.querySelector('.pd-link-top'), tok = row.querySelector('code'), info = row.querySelector('.pd-link-info');
        const btns = [...row.querySelectorAll('button')].map(R);
        return { top: R(top), tok: R(tok), info: R(info), btns, nb: btns.length, row: R(row), badge: row.querySelector('.badge')?.textContent,
          ell: getComputedStyle(tok).textOverflow === 'ellipsis' && getComputedStyle(tok).whiteSpace === 'nowrap', infoHasBadge: !!info.querySelector('.badge'), buttonsInTop: [...row.querySelectorAll('button')].every(b => top.contains(b)) };
      });
      const all = [...document.querySelectorAll('#pd-sec-people-body *')].filter(e => e.getClientRects().length);
      return { iw: innerWidth, sw: document.scrollingElement.scrollWidth, sec, rows, n: all.length, out: all.filter(e => e.getBoundingClientRect().right > sec.r + 0.5).map(e => e.tagName + '.' + e.className).slice(0, 6) };
    }).toString()})()`);
    ok('floor: scanned the open section (>= 15 elements) and both rows', o.n >= 15 && o.rows.length === 2, String(o.n));
    const live = o.rows[0], dead = o.rows[1];
    ok('live row: 2 buttons (複製連結, 撤銷), both >= 44px tall and wide, both inside the card’s right edge', live.nb === 2 && live.btns.every(b => b.h >= 44 && b.w >= 44 && b.r <= o.sec.r && b.l >= o.sec.l), JSON.stringify(live.btns));
    ok('live row: line 1 contains the buttons (right-aligned, after the token), line 2 (the badge) is below line 1', live.buttonsInTop && live.btns[0].l >= live.tok.r - 1 && live.info.t >= live.top.b - 1 && live.infoHasBadge && live.badge === '有效', JSON.stringify(live));
    ok('live row: the token is one line with an ellipsis, not wrapped (43 characters)', live.ell && live.tok.h <= 24 && live.tok.r <= o.sec.r, JSON.stringify(live.tok));
    ok('the buttons are right-aligned: the last button ends at the card padding', live.btns[1].r >= o.sec.r - 30, JSON.stringify([live.btns[1].r, o.sec.r]));
    ok('revoked row: no buttons, badge on line 2', dead.nb === 0 && dead.infoHasBadge && dead.info.t >= dead.top.b - 1 && dead.badge === '已撤銷', JSON.stringify(dead));
    ok('nothing in the section sticks out past the card; no sideways scroll', o.out.length === 0 && o.sw <= o.iw, JSON.stringify(o.out));
    return out;
  }, { before: m.attach, initScript: ADMIN, contextOptions: { ...MOBILE, viewport: { width, height: 844 } } });
}

// ── no live link: the copy button is grayed with its reason and does nothing ──
{
  const m = fx({ listToken: null });
  await suite('share link rows — no live link: 複製連結 in the title row is grayed (aria-disabled), reason visible, a click does nothing', URL_, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#pd-more-btn', { timeout: 5000 });
    await waitReady(page);
    const r = await page.$eval('#pd-sec-people-copy', b => ({ off: b.getAttribute('aria-disabled'), tag: b.tagName, reason: b.querySelector('small')?.textContent, vis: b.querySelector('small')?.getClientRects().length > 0, h: b.getBoundingClientRect().height, op: getComputedStyle(b).opacity }));
    ok('grayed button with the visible reason 沒有有效連結, >= 44px, not an opacity gray', r.off === 'true' && r.tag === 'BUTTON' && r.reason === '沒有有效連結' && r.vis && r.h >= 44 && r.op === '1', JSON.stringify(r));
    ok('collapsed before the click (positive)', await page.$eval('#pd-sec-people-btn', b => b.getAttribute('aria-expanded')) === 'false');
    ok('it really looks grayed (the --rule background and --ink-70 text, as the grayed ⋯ items)', await page.$eval('#pd-sec-people-copy', b => getComputedStyle(b).backgroundColor === 'rgb(239, 230, 216)' && getComputedStyle(b).color === 'rgb(91, 79, 66)'));
    ok('the button is the topmost element at its own centre', await page.$eval('#pd-sec-people-copy', b => { b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); const e = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2); return b.contains(e) ? 'yes' : e.tagName + '#' + e.id + '.' + e.className; }) === 'yes');
    await page.click('#pd-sec-people-copy', { force: true });
    await page.waitForTimeout(200);
    ok('a click does nothing: no share dialog', (await page.$('#pd-share-link')) === null);
    ok('still collapsed', await page.$eval('#pd-sec-people-btn', b => b.getAttribute('aria-expanded')) === 'false', await page.$eval('#pd-sec-people', s => s.outerHTML.slice(0, 700)));
    ok('no overflow at 390', await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth));
    return out;
  }, { before: m.attach, initScript: ADMIN, contextOptions: { ...MOBILE, viewport: { width: 390, height: 844 } } });
}

}
