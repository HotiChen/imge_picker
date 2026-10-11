// Browser suite: the photo grid never scrolls sideways because of long file names (a Mac window of ~1050px, the real case:
// 20180402-Logo-20180402-007.jpg ...). A nowrap file name used to stretch its `1fr` track past the column.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {
  const LONG = '20180402-Logo-20180402-0000007-LONGNAME-FOR-A-REAL-SHOOT.jpg';
  const m = pickFakeWorker({ ownerName: 'Lia', ownerKey: 'LIA-KEY' });
  for (const width of [1050, 900, 600]) {
    await suite(`photo grid — long file names do not make the grid scroll sideways (${width}px window)`, `${base}/index.html?t=TOK`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.waitForSelector('.photo-card', { timeout: 5000 });
        const r = await page.evaluate(long => {
          document.querySelectorAll('.photo-name').forEach(n => { n.textContent = long; });
          const g = document.querySelector('.photo-grid');
          const scrollers = [...document.querySelectorAll('*')].filter(e => e.scrollWidth > e.clientWidth + 1 &&
            ['auto', 'scroll'].includes(getComputedStyle(e).overflowX)).map(e => `${e.id || e.className || e.tagName}:${e.clientWidth}/${e.scrollWidth}`);
          const cards = [...document.querySelectorAll('.photo-card')].map(c => c.getBoundingClientRect());
          return { cards: cards.length, grid: [g.clientWidth, g.scrollWidth], docOver: document.documentElement.scrollWidth - innerWidth, scrollers };
        }, LONG);
        ok('the fixture rendered at least 3 cards (a scan floor: an empty page cannot pass)', r.cards >= 3, String(r.cards));
        ok('the grid is not wider than its box', r.grid[1] <= r.grid[0] + 1, JSON.stringify(r.grid));
        ok('no scroll container is scrolling sideways', r.scrollers.length === 0, r.scrollers.join(' | '));
        ok('the page itself does not scroll sideways', r.docOver <= 1, String(r.docOver));
        return out;
      },
      { contextOptions: { viewport: { width, height: 700 } }, initScript: `localStorage.setItem('pick_key:TOK','LIA-KEY')`, before: m.attach });
  }
}
