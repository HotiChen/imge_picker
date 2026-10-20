// Browser suite: on the project page 「目前選取」 sits directly under the 照片 card, above 進度 (2026-10-20).
import { base, suite } from '../lib/harness.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const m = pickFakeWorker({ projectId: 'proj-sel', title: '選取專案', ownerName: '你好', folders: ['20261020 選取專案/毛片/'],
  bucketFolders: ['20261020 選取專案/', '20261020 選取專案/毛片/'] });

await suite('project page — 目前選取 sits right under the 照片 card, before 進度', `${base}/admin.html#project=proj-sel`, async page => {
  const out = [], ok = line(out);
  await page.waitForSelector('#pd-photos', { timeout: 5000 });
  const order = await page.$$eval('#pd-photos, #pd-sec-selections, #pd-progress', els => els.map(e => e.id));
  ok('order in the page: 照片, 目前選取, 進度 (all three exist)', JSON.stringify(order) === JSON.stringify(['pd-photos', 'pd-sec-selections', 'pd-progress']), JSON.stringify(order));
  ok('it follows the 照片 card directly (nothing in between)', await page.$eval('#pd-photos', e => e.nextElementSibling && e.nextElementSibling.id) === 'pd-sec-selections');
  ok('it is a collapsible section still (a title button with aria-expanded)', await page.$eval('#pd-sec-selections-btn', b => b.hasAttribute('aria-expanded')));
  return out;
}, { before: m.attach, initScript: ADMIN });

}
