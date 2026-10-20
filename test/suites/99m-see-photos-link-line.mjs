// Browser suites (2026-10-20): in the 照片 card, the 「看照片 →」 link of the 目前選取 section sits on the same line as the
// 「目前選取 N 張」 title row (collapsed and open), at 390 / 360 px and on desktop; the title button stays >= 40px tall and the
// link is a >= 44px tap target.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN_PLAIN as ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const URL_ = `${base}/admin.html#project=proj-sp`;
const waitReady = page => page.waitForSelector('#pd-photos[data-target="ready"], #pd-photos[data-target="failed"]', { state: 'attached', timeout: 5000 });
const GEO = () => {
  const link = document.querySelector('#pd-sec-selections .pd-sec-head a.pd-link'), btn = document.getElementById('pd-sec-selections-btn');
  const l = link.getBoundingClientRect(), b = btn.getBoundingClientRect(), card = document.getElementById('pd-photos').getBoundingClientRect();
  return { l: { t: l.top, b: l.bottom, h: l.height, r: l.right, l: l.left, cy: (l.top + l.bottom) / 2 }, b: { t: b.top, b: b.bottom, h: b.height, r: b.right }, card: { r: card.right }, open: btn.getAttribute('aria-expanded'),
    text: link.textContent.trim(), sum: document.getElementById('pd-sec-selections-sum').textContent, sw: document.scrollingElement.scrollWidth, iw: innerWidth };
};

for (const [name, ctx] of [['390px', { ...MOBILE, viewport: { width: 390, height: 844 } }], ['360px', { ...MOBILE, viewport: { width: 360, height: 800 } }], ['desktop', { viewport: { width: 1280, height: 800 } }]]) {
  const m = pickFakeWorker({ projectId: 'proj-sp', title: '看照片專案', ownerName: '你好', folders: ['shoot/毛片/'], bucketFolders: ['shoot/', 'shoot/毛片/'] });
  for (let i = 0; i < 12; i++) m.state.selections.set(`shoot/毛片/p${i}.jpg`, { rating: 5, note: '', updated_by: 'picker-0', updated_at: '2026-10-01T00:00:00Z' });
  await suite(`看照片 link on the title line — ${name}: the link's vertical centre is inside the 目前選取 title row, collapsed and open`, URL_, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#pd-more-btn', { timeout: 5000 });
    await waitReady(page);
    for (const state of ['collapsed', 'open']) {
      if (state === 'open') await page.click('#pd-sec-selections-btn');
      const g = await page.evaluate(GEO);
      ok(`${state}: positive: the section is ${state} and says 目前選取 with a count and the link reads 看照片 →`, g.open === (state === 'open' ? 'true' : 'false') && /\d+ 張/.test(g.sum) && g.text === '看照片 →', JSON.stringify(g));
      ok(`${state}: the link's centre is within the title row's box`, g.l.cy >= g.b.t && g.l.cy <= g.b.b, JSON.stringify(g));
      ok(`${state}: the link sits to the right of the title row inside the card (same line, not below)`, g.l.t < g.b.b - 4 && g.l.r <= g.card.r + 0.5 && g.l.l >= 0, JSON.stringify(g));
      ok(`${state}: title button >= 40px tall, link >= 44px tall, no sideways scroll`, g.b.h >= 40 && g.l.h >= 44 && g.sw <= g.iw, JSON.stringify(g));
    }
    return out;
  }, { before: m.attach, initScript: ADMIN, contextOptions: ctx });
}

}
