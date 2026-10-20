// Browser suites (2026-10-20): the project page at phone width must never be wider than the screen. Tim's iPhone showed the page
// cut off on the right (⋯ half visible, cards flush against the edge). Each state below is measured at 390px and 360px: the page's
// scrollWidth, every element's right edge (except inside the two deliberate scrollers: the top nav strip and wide tables), the ⋯
// button fully inside the screen, and the cards keeping their right gutter. A floor on the elements scanned keeps an empty scan
// from passing.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { openSettings } from '../lib/project-helpers.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const URL_ = `${base}/admin.html#project=proj-ov`;
const LONG_CJK = '很長的專案名稱'.repeat(8);
const LONG_FINAL = '20261020 123/' + '精修很長很長的資料夾名稱'.repeat(3) + '/';
const sub = (at, keys) => ({ id: 's-' + at, picker_id: 'picker-0', relationship: '本人', email: 'a-very-long-address-without-any-break-' + 'x'.repeat(40) + '@example.com', photo_keys: keys, count: keys.length, pick_limit: null, extra_price: null, created_at: at, notified: 0 });

const STATES = [
  ['Tim: 20261020 123, 親子, nobody claimed yet (準備中)', { title: '20261020 123', folders: ['20261020 123/毛片/'], bucketFolders: ['20261020 123/'], ownerName: undefined, shootDate: '2026-10-20', projectType: '親子' }],
  ['very long CJK title', { title: '20261020 ' + LONG_CJK, folders: ['20261020 ' + LONG_CJK + '/毛片/'], bucketFolders: ['20261020 ' + LONG_CJK + '/', '20261020 ' + LONG_CJK + '/毛片/'], ownerName: undefined, shootDate: '2026-10-20', projectType: '親子' }],
  ['very long title without any break', { title: 'A'.repeat(120), folders: ['A/毛片/'], bucketFolders: ['A/', 'A/毛片/'], ownerName: 'B'.repeat(60), shootDate: '2026-10-20', projectType: 'C'.repeat(20) }],
  ['delivered, long final folder name, an open round with a long message', { title: '20261020 123', ownerName: 'Zoe', phase: 'retouching', deliveredAt: '2026-09-20T00:00:00.000Z', finalFolders: [LONG_FINAL],
    folders: ['20261020 123/毛片/'], bucketFolders: ['20261020 123/', '20261020 123/毛片/', LONG_FINAL],
    revisions: [{ id: 'r1', message: 'x'.repeat(200), picker_id: 'picker-0', created_at: '2026-09-22T04:00:00.000Z', resolved_at: null }] }],
  ['a real-length share token (43 characters) in 挑選人與連結', { title: '20261020 123', ownerName: 'Zoe', listToken: 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hJ3lO6rU9xA2b', folders: ['20261020 123/毛片/'], bucketFolders: ['20261020 123/', '20261020 123/毛片/'] }],
  ['submitted, two submissions', { title: '20261020 123', ownerName: 'Zoe', phase: 'submitted', folders: ['20261020 123/毛片/'], bucketFolders: ['20261020 123/', '20261020 123/毛片/'], submissions: 2 }],
];

const SCAN = () => {
  const vw = innerWidth, bad = [];
  let n = 0;
  const scroller = e => e.closest('.side-nav-list, .table-wrap');
  for (const e of document.querySelectorAll('body *')) {
    const b = e.getBoundingClientRect();
    if (!b.width || getComputedStyle(e).position === 'fixed' || scroller(e)) continue;
    n++;
    if (b.right > vw + 0.5) bad.push((e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + e.className) + ' right=' + Math.round(b.right));
  }
  const more = document.getElementById('pd-more-btn').getBoundingClientRect();
  const cards = [...document.querySelectorAll('#pd-status, #pd-photos, #pd-progress')].map(c => Math.round(c.getBoundingClientRect().right));
  return { vw, sw: document.scrollingElement.scrollWidth, n, bad: bad.slice(0, 8), moreL: Math.round(more.left), moreR: Math.round(more.right), cards };
};

for (const width of [390, 360]) {
  for (const [name, o] of STATES) {
    const subs = o.submissions; delete o.submissions;
    const m = pickFakeWorker({ projectId: 'proj-ov', ...o });
    if (subs) m.state.submissions.push(sub('2026-10-10T02:00:00.000Z', ['20261020 123/毛片/a.jpg']), sub('2026-10-12T02:00:00.000Z', ['20261020 123/毛片/' + 'long'.repeat(20) + '.jpg']));
    await suite(`phone overflow — ${width}px, ${name}: page not wider than the screen, ⋯ fully inside, cards keep their right gutter`, URL_, async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('#pd-more-btn', { timeout: 5000 });
      await page.waitForSelector('#pd-photos[data-target="ready"], #pd-photos[data-target="failed"]', { state: 'attached', timeout: 5000 });
      await page.waitForTimeout(300);
      if (subs) for (const b of await page.$$('.pd-step-toggle')) await b.click();
      for (const b of await page.$$('.pd-sec-btn[aria-expanded="false"]')) await b.click();   // every section open: the widest content is on screen
      ok('positive: all three sections are open and the share token row is on screen', await page.evaluate(() => [...document.querySelectorAll('.pd-sec-body')].length === 3 &&
        [...document.querySelectorAll('.pd-sec-body')].every(b => b.getClientRects().length > 0) && document.querySelectorAll('[data-token-row]').length >= 1 &&
        document.querySelector('[data-token-row]').getClientRects().length > 0));
      let r = await page.evaluate(SCAN);
      ok('scanned plenty of elements (floor)', r.n >= 40, String(r.n));
      ok('scrollWidth <= innerWidth', r.sw <= r.vw, JSON.stringify(r));
      ok('no element sticks out to the right', r.bad.length === 0, JSON.stringify(r.bad));
      ok('⋯ is fully inside the screen with room to spare (right <= width - 8)', r.moreL >= 0 && r.moreR <= r.vw - 8, JSON.stringify(r));
      ok('the cards end inside the gutter (right <= width - 8)', r.cards.length === 3 && r.cards.every(x => x <= r.vw - 8), JSON.stringify(r.cards));
      await page.click('#pd-more-btn');
      r = await page.evaluate(SCAN);
      ok('with the ⋯ menu open: still not wider than the screen', r.sw <= r.vw && r.bad.length === 0, JSON.stringify(r));
      await page.keyboard.press('Escape');
      await openSettings(page);
      r = await page.evaluate(SCAN);
      ok('with the 設定 modal open: still not wider than the screen', r.sw <= r.vw && r.bad.length === 0, JSON.stringify(r));
      return out;
    }, { before: m.attach, initScript: ADMIN, contextOptions: { ...MOBILE, viewport: { width, height: 844 } } });
  }
}

}
