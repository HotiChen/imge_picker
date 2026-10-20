// Browser suite (2026-10-20): 進度 shows the link_reissued event (docs/delivery.md, "Activity log"):
// 「重新產生挑選連結（舊連結 N 條失效）」, or 「產生新挑選連結」 when nothing was revoked; with date + time, textContent only.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const URL_ = `${base}/admin.html#project=proj-lr`;
const fx = (o = {}) => pickFakeWorker({ projectId: 'proj-lr', title: '連結紀錄', ownerName: 'Lin', folders: ['shoot/毛片/'], ...o });
const EV = () => [...document.querySelectorAll('#pd-steps [data-kind]')].map(li => ({ kind: li.dataset.kind, label: li.querySelector('.pd-step-label')?.textContent.trim(), date: li.querySelector('.pd-step-date')?.textContent.trim() ?? '', html: li.querySelector('.pd-step-label')?.innerHTML }));
const TIME = /^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/;

{
  const m = fx({ events: [
    { at: '2026-10-18T02:00:00.000Z', kind: 'link_reissued', data: { revoked: 2 } },
    { at: '2026-10-19T02:00:00.000Z', kind: 'link_reissued', data: { revoked: 0 } },
    { at: '2026-10-19T03:00:00.000Z', kind: 'link_reissued', data: { revoked: '<img src=x onerror=alert(1)>' } },
    { at: '2026-10-19T04:00:00.000Z', kind: 'future_kind_we_do_not_know', data: { x: 1 } }] });
  await suite('99o link_reissued in 進度 — worded by how many died, dated with the time, unknown kinds still skipped, text only', URL_, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#pd-steps [data-kind="link_reissued"]', { state: 'attached', timeout: 5000 });
    const ev = await page.evaluate(EV);
    const re = ev.filter(e => e.kind === 'link_reissued');
    ok('three link_reissued rows (positive) and no row for the unknown kind', re.length === 3 && !ev.some(e => e.kind === 'future_kind_we_do_not_know'), JSON.stringify(ev));
    ok('revoked 2 -> 重新產生挑選連結（舊連結 2 條失效）', re[0].label === '重新產生挑選連結（舊連結 2 條失效）', re[0].label);
    ok('revoked 0 -> 產生新挑選連結', re[1].label === '產生新挑選連結', re[1].label);
    ok('a non-numeric revoked is not rendered as markup (falls back to the plain wording)', !/<img/i.test(re[2].html) && re[2].label === '產生新挑選連結', re[2].html);
    ok('each row has date + time', re.every(e => TIME.test(e.date)), JSON.stringify(re.map(e => e.date)));
    return out;
  }, { before: m.attach, initScript: ADMIN, contextOptions: MOBILE });
}

{
  const m = fx({ listToken: 'T-OLD' });
  await suite('99o link_reissued — the real 產生新連結 click puts the event into 進度 (fake mirrors the Worker)', URL_, async page => {
    const out = [], ok = line(out);
    await page.waitForSelector('#pd-more-btn', { timeout: 5000 });
    await page.waitForSelector('#pd-photos[data-target="ready"], #pd-photos[data-target="failed"]', { state: 'attached', timeout: 5000 });
    ok('no such row before (control)', (await page.evaluate(EV)).every(e => e.kind !== 'link_reissued'));
    if (await page.$eval('#pd-sec-people-btn', b => b.getAttribute('aria-expanded')) !== 'true') await page.click('#pd-sec-people-btn');
    await page.waitForSelector('#pd-new-link-btn', { state: 'visible' });
    page.once('dialog', d => d.accept());
    await page.click('#pd-new-link-btn');
    await page.waitForSelector('#pd-steps [data-kind="link_reissued"]', { state: 'attached', timeout: 5000 });
    const re = (await page.evaluate(EV)).filter(e => e.kind === 'link_reissued');
    ok('one row, 舊連結 1 條失效', re.length === 1 && re[0].label === '重新產生挑選連結（舊連結 1 條失效）' && TIME.test(re[0].date), JSON.stringify(re));
    return out;
  }, { before: m.attach, initScript: ADMIN, contextOptions: MOBILE });
}

}
