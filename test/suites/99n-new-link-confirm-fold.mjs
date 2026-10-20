// Browser suite (2026-10-20): 產生新連結 kills the project's other live links (Worker), so the project page
//  - asks first (dialog); cancel sends nothing; the text names the consequence only when a live link exists
//  - shows only the live links in 挑選連結; revoked / expired ones fold into a real <button> 「另有 N 條已失效」
//    (>= 44px, aria-expanded) that opens them dimmed, with no copy / 撤銷 buttons; no dead link, no such line
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ADMIN_PLAIN as ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const URL_ = `${base}/admin.html#project=proj-nl`;
const fx = (o = {}) => pickFakeWorker({ projectId: 'proj-nl', title: '新連結專案', ownerName: undefined, listToken: 'LIVE-TOKEN-1', folders: ['shoot/毛片/'], bucketFolders: ['shoot/', 'shoot/毛片/'], ...o });
const waitReady = page => page.waitForSelector('#pd-photos[data-target="ready"], #pd-photos[data-target="failed"]', { state: 'attached', timeout: 5000 });
const posts = m => m.requests.filter(r => r.method === 'POST' && r.path === '/api/admin/projects/proj-nl/links');
const openPeople = async page => { await page.waitForSelector('#pd-more-btn', { timeout: 5000 }); await waitReady(page); await page.click('#pd-sec-people-btn'); await page.waitForSelector('#pd-new-link-btn', { state: 'visible' }); };
const rowsVisible = page => page.evaluate(() => [...document.querySelectorAll('[data-token-row]')].filter(r => r.getClientRects().length).map(r => r.dataset.tokenRow));

{
  const m = fx();
  await suite('new link — a live link exists: the confirm names the consequence; cancel sends nothing; accept revokes the old one, lists only the new one live', URL_, async page => {
    const out = [], ok = line(out);
    await openPeople(page);
    ok('positive: one live row to start with', (await rowsVisible(page)).join() === 'LIVE-TOKEN-1');
    let msg = '';
    page.once('dialog', d => { msg = d.message(); d.dismiss(); });
    await page.click('#pd-new-link-btn');
    await page.waitForTimeout(300);
    ok('the confirm says the old links die at once and the picks stay', msg.includes('舊連結會立刻失效') && msg.includes('選片紀錄不會掉') && msg.endsWith('確定嗎？'), msg);
    ok('cancel: nothing was posted', posts(m).length === 0);
    ok('cancel: the button is usable again (not left disabled)', await page.$eval('#pd-new-link-btn', b => !b.disabled));
    page.once('dialog', d => d.accept());
    await page.click('#pd-new-link-btn');
    await page.waitForFunction(() => document.querySelector('[data-token-row="PICK-TOKEN-2"]'), null, { timeout: 5000 });
    ok('accept: exactly one POST', posts(m).length === 1);
    ok('only the new link is live in the list', (await rowsVisible(page)).join() === 'PICK-TOKEN-2', JSON.stringify(await rowsVisible(page)));
    ok('the old one is folded: 「另有 1 條已失效」', await page.$eval('#pd-dead-links-btn', b => b.textContent.trim()) === '另有 1 條已失效');
    return out;
  }, { before: m.attach, initScript: ADMIN, contextOptions: MOBILE });
}

{
  const m = fx({ listToken: null });
  await suite('new link — no live link: plain confirm without the revoke sentence, no fold line when nothing is dead', URL_, async page => {
    const out = [], ok = line(out);
    await openPeople(page);
    ok('no dead link: no fold line (positive: the list section is open)', (await page.$('#pd-dead-links-btn')) === null && (await page.$('#pd-tokens')) !== null);
    let msg = '';
    page.once('dialog', d => { msg = d.message(); d.accept(); });
    await page.click('#pd-new-link-btn');
    await page.waitForFunction(() => document.querySelector('[data-token-row="PICK-TOKEN-1"]'), null, { timeout: 5000 });
    ok('the confirm is asked, without 失效', msg !== '' && !msg.includes('失效'), msg);
    ok('posted once', posts(m).length === 1);
    return out;
  }, { before: m.attach, initScript: ADMIN, contextOptions: MOBILE });
}

{
  const m = fx();
  m.state.tokens.unshift(
    { token: 'DEAD-REVOKED', created_at: '2025-12-01T00:00:00.000Z', expires_at: '2027-01-01T00:00:00.000Z', revoked_at: '2026-01-02T00:00:00.000Z' },
    { token: 'DEAD-EXPIRED', created_at: '2025-01-01T00:00:00.000Z', expires_at: '2025-04-01T00:00:00.000Z', revoked_at: null });
  await suite('new link — dead links fold into one 另有 N 條已失效 button (>= 44px, aria-expanded); opened they are dimmed with no buttons', URL_, async page => {
    const out = [], ok = line(out);
    await openPeople(page);
    ok('only the live link is shown; the summary still says 連結有效 1 條', (await rowsVisible(page)).join() === 'LIVE-TOKEN-1' && (await page.$eval('#pd-sec-people-sum', e => e.textContent)).includes('連結有效 1 條'));
    const b = await page.$eval('#pd-dead-links-btn', e => ({ tag: e.tagName, t: e.textContent.trim(), h: e.getBoundingClientRect().height, x: e.getAttribute('aria-expanded'), c: e.getAttribute('aria-controls'), hidden: document.getElementById(e.getAttribute('aria-controls')).hidden }));
    ok('a real button, 另有 2 條已失效, >= 44px, collapsed, controls a hidden region', b.tag === 'BUTTON' && b.t === '另有 2 條已失效' && b.h >= 44 && b.x === 'false' && b.hidden, JSON.stringify(b));
    await page.click('#pd-dead-links-btn');
    const o = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#pd-dead-links [data-token-row]')];
      return { x: document.getElementById('pd-dead-links-btn').getAttribute('aria-expanded'), n: rows.length, shown: rows.every(r => r.getClientRects().length > 0),
        btns: rows.reduce((a, r) => a + r.querySelectorAll('button').length, 0), op: rows.map(r => getComputedStyle(r).opacity), badges: rows.map(r => r.querySelector('.badge').textContent),
        live: document.querySelectorAll('[data-token-row="LIVE-TOKEN-1"] button').length };
    });
    ok('opened: 2 dead rows on screen, aria-expanded true, badges 已撤銷 / 已過期', o.x === 'true' && o.n === 2 && o.shown && o.badges.slice().sort().join() === '已撤銷,已過期', JSON.stringify(o));
    ok('dead rows are dimmed and carry no buttons; the live row keeps its 2', o.btns === 0 && o.op.every(v => Number(v) < 1) && o.live === 2, JSON.stringify(o));
    await page.click('#pd-dead-links-btn');
    ok('toggled shut again', (await rowsVisible(page)).join() === 'LIVE-TOKEN-1' && await page.$eval('#pd-dead-links-btn', e => e.getAttribute('aria-expanded')) === 'false');
    return out;
  }, { before: m.attach, initScript: ADMIN, contextOptions: MOBILE });
}

}
