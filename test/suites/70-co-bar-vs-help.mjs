// Browser suite: the owner's 協作者 entry never sits on top of the ？ tour replay button (desktop: both bottom-right).
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {
  const m = pickFakeWorker({ ownerName: 'Lia', ownerKey: 'LIA-KEY' });
  const cases = [['desktop 1500px', { viewport: { width: 1500, height: 950 } }], ['desktop 1050px', { viewport: { width: 1050, height: 700 } }],
    ['phone 390px', MOBILE]];
  for (const [label, contextOptions] of cases) {
    await suite(`co-picking entry vs ？ help button — they do not overlap (${label})`, `${base}/index.html?t=TOK`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.waitForSelector('#coPickEntry', { timeout: 5000 });
        await page.waitForSelector('.gt-help', { timeout: 5000 });
        const r = await page.evaluate(() => {
          const box = s => { const b = document.querySelector(s).getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
          const a = box('#coPickEntry'), h = box('.gt-help');
          const overlap = a.l < h.r && h.l < a.r && a.t < h.b && h.t < a.b;
          return { a, h, overlap, vw: innerWidth, vh: innerHeight };
        });
        ok('both buttons are on screen', r.a.r <= r.vw && r.a.b <= r.vh && r.h.r <= r.vw && r.h.b <= r.vh, JSON.stringify(r));
        ok('they do not overlap', !r.overlap, JSON.stringify({ a: r.a, h: r.h }));
        return out;
      },
      { contextOptions, initScript: `localStorage.setItem('pick_key:TOK','LIA-KEY')`, before: m.attach });
  }
}
