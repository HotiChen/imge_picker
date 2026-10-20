// Browser suite: on the project page 「目前選取」 sits inside the 照片 card, below its download buttons, above 進度 (2026-10-20).
import { base, suite } from '../lib/harness.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const m = pickFakeWorker({ projectId: 'proj-sel', title: '選取專案', ownerName: '你好', folders: ['20261020 選取專案/毛片/'],
  bucketFolders: ['20261020 選取專案/', '20261020 選取專案/毛片/'] });

await suite('project page — 目前選取 sits inside the 照片 card, below its buttons, before 進度', `${base}/admin.html#project=proj-sel`, async page => {
  const out = [], ok = line(out);
  await page.waitForSelector('#pd-photos', { timeout: 5000 });
  const g = await page.evaluate(() => {
    const photos = document.getElementById('pd-photos'), sec = document.getElementById('pd-sec-selections'), prog = document.getElementById('pd-progress');
    const dl = photos && photos.querySelector('.pd-photos-dl');
    return { all: !!(photos && sec && prog && dl), inside: !!photos && photos.contains(sec),
      belowButtons: !!dl && !!sec && !!(dl.compareDocumentPosition(sec) & Node.DOCUMENT_POSITION_FOLLOWING),
      before進度: !!sec && !!prog && !!(sec.compareDocumentPosition(prog) & Node.DOCUMENT_POSITION_FOLLOWING), one: document.querySelectorAll('#pd-sec-selections').length };
  });
  ok('all parts exist, exactly one 目前選取', g.all && g.one === 1, JSON.stringify(g));
  ok('it is inside the 照片 card, below the download buttons, before 進度', g.inside && g.belowButtons && g.before進度, JSON.stringify(g));
  ok('it is a collapsible section still (a title button with aria-expanded)', await page.$eval('#pd-sec-selections-btn', b => b.hasAttribute('aria-expanded')));
  return out;
}, { before: m.attach, initScript: ADMIN });

}
