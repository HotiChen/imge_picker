// Browser suites: co-picking, the OWNER's side of the guest pick page (docs/co-picking.md, batch 2): 邀請協作者 (period, the
// 8-digit code, copy, the 1-hour countdown), the collaborator list (remove, change period), renewal requests (badge, banner,
// 核准 / 拒絕, the 30-second poll and its toast), and that nobody but the owner sees any of it. js/co-picking-owner.js.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const FUTURE = days => new Date(Date.now() + days * 86400000).toISOString();
const PAST = new Date(Date.now() - 3600000).toISOString();
const XSS = '<img src=x onerror="window.__xss=1">';
// addInitScript serialises a function (no closures), so the script is built as a string
const initOwner = (key = 'LIA-KEY', poll) => `
  if (${JSON.stringify(key)}) localStorage.setItem('pick_key:TOK', ${JSON.stringify(key)});
  window.__copied = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: t => { window.__copied.push(t); return Promise.resolve(); } } });
  ${poll ? `window.CO_PICKING_POLL_MS = ${Number(poll)};` : ''}
`;
const world = (o = {}) => pickFakeWorker({ ownerName: 'Lia', ownerKey: 'LIA-KEY', ...o });
const url = `${base}/index.html?t=TOK`;
const reqs = (m, method, re) => m.requests.filter(r => r.method === method && re.test(r.path));
const open = async page => {
  await page.waitForSelector('#coPickEntry', { timeout: 5000 });
  await page.click('#coPickEntry');
  await page.waitForSelector('#coPanel:not([hidden])', { timeout: 3000 });
};
const rows = page => page.$$eval('#coList .co-item', els => els.map(e => ({
  id: e.dataset.pickerId, name: e.querySelector('.co-name')?.textContent, joined: e.querySelector('.co-joined')?.textContent,
  until: e.querySelector('.co-until')?.textContent, status: e.dataset.status, text: e.textContent,
})));

// ── 1. invite: period, code, copy, countdown, 390px layout ─────────────────
{
  const m = world();
  await suite('co-picking owner — 邀請協作者: period choice posts window_days, the code is grouped 1234 5678, copy works, a 1-hour countdown runs (390px)',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await open(page);
      ok('the panel starts with no code and no list rows', (await page.$('#coCode:not([hidden])')) === null && (await rows(page)).length === 0);
      await page.click('[data-co-days="7"]');
      await page.click('#coInviteBtn');
      await page.waitForSelector('#coCode:not([hidden])', { timeout: 3000 });
      const post = reqs(m, 'POST', /\/api\/pick\/invites$/);
      ok('one POST /api/pick/invites with {window_days: 7}', post.length === 1 && JSON.stringify(post[0].body) === '{"window_days":7}', JSON.stringify(post.map(r => r.body)));
      ok('the request carried the picker key and the link', post[0]?.key === 'LIA-KEY' && post[0]?.t === 'TOK');
      const code = m.state.invites[0].code;
      const shown = (await page.textContent('#coCode')).trim();
      ok('the code is shown as 1234 5678', /^\d{4} \d{4}$/.test(shown) && shown.replace(' ', '') === code, shown);
      const cd = (await page.textContent('#coCountdown')).trim();
      ok('the countdown reads about an hour (59:xx or 60:00)', /(59:\d\d|60:00)/.test(cd), cd);
      await page.click('#coCopyBtn');
      const copied = await page.evaluate(() => window.__copied);
      ok('copy puts the 8 digits (no space) on the clipboard', copied.length === 1 && copied[0] === code, JSON.stringify(copied));
      const lay = await page.evaluate(() => {
        const p = document.getElementById('coPanel').getBoundingClientRect();
        return { w: innerWidth, sw: document.documentElement.scrollWidth, left: Math.round(p.left), right: Math.round(p.right),
          btn: Math.round(document.getElementById('coInviteBtn').getBoundingClientRect().height) };
      });
      ok('390px: no horizontal page scroll, the panel sits inside the screen, buttons are touch-sized',
        lay.w === 390 && lay.sw <= 390 && lay.left >= 0 && lay.right <= 390 && lay.btn >= 40, JSON.stringify(lay));
      // the list now counts the invite as a pending code
      ok('the pending invite is mentioned (1 個邀請碼尚未使用)', /1/.test(await page.textContent('#coInviteInfo')) , await page.textContent('#coInviteInfo'));
      return out;
    },
    { before: m.attach, initScript: initOwner(), contextOptions: MOBILE });
}

{
  const m = world();
  await suite('co-picking owner — 今天 posts 1, 到專案結束 posts null',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await open(page);
      await page.click('[data-co-days="1"]');
      await page.click('#coInviteBtn');
      await page.waitForSelector('#coCode:not([hidden])', { timeout: 3000 });
      await page.click('[data-co-days="null"]');
      await page.click('#coInviteBtn');
      await page.waitForFunction(() => document.querySelectorAll('#coCode').length === 1 && document.getElementById('coCode').textContent.trim() !== '', null, { timeout: 3000 });
      await page.waitForTimeout(200);
      const bodies = reqs(m, 'POST', /\/api\/pick\/invites$/).map(r => JSON.stringify(r.body));
      ok('bodies are {"window_days":1} then {"window_days":null}', bodies.join() === '{"window_days":1},{"window_days":null}', bodies.join());
      const shown = (await page.textContent('#coCode')).replace(' ', '');
      ok('the newest code replaces the old one', shown === m.state.invites[1].code, shown);
      return out;
    },
    { before: m.attach, initScript: initOwner(), contextOptions: MOBILE });
}

{
  const m = world({ now: () => Date.now() - 3597000 });   // the fake's clock runs 3597 s behind: its 1-hour code ends ~3 s from now
  await suite('co-picking owner — the countdown reaches 0: the code is hidden and says it has expired',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await open(page);
      await page.click('#coInviteBtn');
      await page.waitForSelector('#coCode:not([hidden])', { timeout: 3000 });
      const before = (await page.textContent('#coCountdown')).trim();
      ok('before the end the countdown shows 00:0x', /^.*00:0\d/.test(before), before);
      await page.waitForFunction(() => document.getElementById('coCode').hidden, null, { timeout: 8000 });
      ok('after the end the code is hidden (not just dimmed)', await page.$eval('#coCode', e => e.hidden));
      ok('and an 已失效 line is shown', /已失效/.test(await page.textContent('#coCountdown')), await page.textContent('#coCountdown'));
      ok('the copy button is gone with it', await page.$eval('#coCopyBtn', e => e.hidden));
      return out;
    },
    { before: m.attach, initScript: initOwner(), contextOptions: MOBILE });
}

// ── 2. invite errors in plain Chinese ──────────────────────────────────────
{
  const m = world({ collaborators: [{ name: 'Ann', expires_at: FUTURE(3) }, { name: 'Bob', expires_at: null }] });
  await suite('co-picking owner — 409 collaborator_limit is shown in plain Chinese (and no code appears)',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await open(page);
      await page.click('#coInviteBtn');
      await page.waitForFunction(() => document.getElementById('coInviteErr').textContent.trim() !== '', null, { timeout: 3000 });
      const t = await page.textContent('#coInviteErr');
      ok('the message names the limit of 2 collaborators', /協作者/.test(t) && /2/.test(t) && !/collaborator_limit/.test(t), t);
      ok('no code was shown', await page.$eval('#coCode', e => e.hidden));
      ok('the error line is visible', await page.$eval('#coInviteErr', e => getComputedStyle(e).display !== 'none'));
      return out;
    },
    { before: m.attach, initScript: initOwner(), contextOptions: MOBILE });
}

{
  const m = world();
  await suite('co-picking owner — 409 retouching and 403 not_owner are shown in plain Chinese',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await open(page);
      m.state.project.phase = 'retouching';
      await page.click('#coInviteBtn');
      await page.waitForFunction(() => document.getElementById('coInviteErr').textContent.trim() !== '', null, { timeout: 3000 });
      const t1 = await page.textContent('#coInviteErr');
      ok('retouching: says the photographer has started retouching', /修圖|精修/.test(t1) && !/retouching/.test(t1), t1);
      m.state.project.phase = 'picking';
      m.state.project.owner_picker_id = 'someone-else';   // the photographer reset the seat meanwhile
      await page.click('#coInviteBtn');
      await page.waitForFunction(() => /挑選人|主人/.test(document.getElementById('coInviteErr').textContent), null, { timeout: 3000 });
      const t2 = await page.textContent('#coInviteErr');
      ok('not_owner: says only the picker may do this', /只有/.test(t2) && !/not_owner/.test(t2), t2);
      ok('still no code', await page.$eval('#coCode', e => e.hidden));
      return out;
    },
    { before: m.attach, initScript: initOwner(), contextOptions: MOBILE });
}

// ── 3. the list ────────────────────────────────────────────────────────────
{
  const m = world({ collaborators: [
    { name: 'Ann', joined_at: '2026-10-11T02:05:00.000Z', expires_at: '2099-10-18T02:05:00.000Z' },
    { name: 'Bob', joined_at: '2026-10-11T03:30:00.000Z', expires_at: null },
    { name: 'Cat', joined_at: '2026-10-10T01:00:00.000Z', expires_at: PAST },
    { name: 'Dan', joined_at: '2026-10-09T01:00:00.000Z', expires_at: null, revoked_at: '2026-10-10T00:00:00.000Z' },
  ] });
  await suite('co-picking owner — the list: name, joined time in Taipei, valid until (or 不限), status; actions only where they make sense',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await open(page);
      await page.waitForSelector('#coList .co-item', { timeout: 3000 });
      const r = await rows(page);
      ok('four rows, in the server order', r.map(x => x.name).join() === 'Ann,Bob,Cat,Dan', r.map(x => x.name).join());
      ok('joined time is Taipei time (02:05Z -> 10:05)', /10:05/.test(r[0].joined) && /10\/11/.test(r[0].joined), r[0].joined);
      ok('Bob (no end) reads 不限', /不限/.test(r[1].until), r[1].until);
      ok('Ann has a real end date', /2099|10\/18|10\/1\d/.test(r[0].until) && !/不限/.test(r[0].until), r[0].until);
      ok('statuses are exposed: active / expired / removed', r.map(x => x.status).join() === 'active,active,expired,removed', r.map(x => x.status).join());
      ok('an expired row says 已過期 and a removed row 已移除', /已過期/.test(r[2].text) && /已移除/.test(r[3].text), r[2].text + '|' + r[3].text);
      const acts = await page.$$eval('#coList .co-item', els => els.map(e => ({ rm: !!e.querySelector('.co-remove'), per: !!e.querySelector('.co-period-sel') })));
      ok('active and expired rows can be removed / re-timed; a removed row has no action', acts[0].rm && acts[1].rm && acts[2].rm && acts[0].per && !acts[3].rm && !acts[3].per, JSON.stringify(acts));
      return out;
    },
    { before: m.attach, initScript: initOwner(), contextOptions: MOBILE });
}

{
  const m = world({ collaborators: [{ name: 'Ann', expires_at: FUTURE(3) }, { name: 'Bob', expires_at: null }] });
  await suite('co-picking owner — remove asks first (cancel = no request), then DELETE and the row reads 已移除',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await open(page);
      await page.waitForSelector('#coList .co-item', { timeout: 3000 });
      await page.click('#coList .co-item:nth-child(1) .co-remove');
      ok('a confirmation appears, nothing deleted yet', (await page.$('.co-confirm')) !== null && reqs(m, 'DELETE', /collaborators/).length === 0);
      ok('the confirmation names the person', /Ann/.test(await page.textContent('.co-confirm')), await page.textContent('.co-confirm'));
      await page.click('.co-confirm .co-confirm-no');
      ok('取消 closes it with no request', (await page.$('.co-confirm')) === null && reqs(m, 'DELETE', /collaborators/).length === 0);
      await page.click('#coList .co-item:nth-child(1) .co-remove');
      await page.click('.co-confirm .co-confirm-yes');
      await page.waitForFunction(() => document.querySelector('#coList .co-item')?.dataset.status === 'removed', null, { timeout: 3000 });
      const del = reqs(m, 'DELETE', /collaborators/);
      ok('one DELETE /api/pick/collaborators/<id>', del.length === 1 && del[0].path === '/api/pick/collaborators/collab-1', JSON.stringify(del.map(d => d.path)));
      ok('the server now has it revoked', !!m.state.collaborators.get('collab-1').revoked_at);
      ok('Bob is untouched', (await rows(page))[1].status === 'active');
      return out;
    },
    { before: m.attach, initScript: initOwner(), contextOptions: MOBILE });
}

{
  const m = world({ collaborators: [{ name: 'Ann', expires_at: FUTURE(1) }] });
  await suite('co-picking owner — change period: PATCH {window_days} and the valid-until updates',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await open(page);
      await page.waitForSelector('#coList .co-item', { timeout: 3000 });
      await page.selectOption('#coList .co-period-sel', 'null');
      await page.click('#coList .co-period-apply');
      await page.waitForFunction(() => /不限/.test(document.querySelector('#coList .co-until')?.textContent || ''), null, { timeout: 3000 });
      const p = reqs(m, 'PATCH', /collaborators/);
      ok('one PATCH with {window_days: null}', p.length === 1 && JSON.stringify(p[0].body) === '{"window_days":null}' && p[0].path === '/api/pick/collaborators/collab-1', JSON.stringify(p.map(r => [r.path, r.body])));
      await page.selectOption('#coList .co-period-sel', '7');
      await page.click('#coList .co-period-apply');
      await page.waitForFunction(() => !/不限/.test(document.querySelector('#coList .co-until')?.textContent || ''), null, { timeout: 3000 });
      const p2 = reqs(m, 'PATCH', /collaborators/);
      ok('then {window_days: 7}', p2.length === 2 && JSON.stringify(p2[1].body) === '{"window_days":7}', JSON.stringify(p2.map(r => r.body)));
      return out;
    },
    { before: m.attach, initScript: initOwner(), contextOptions: MOBILE });
}

{
  const m = world({ collaborators: [
    { name: 'Ann', expires_at: FUTURE(3) }, { name: 'Bob', expires_at: null }, { name: 'Cat', expires_at: PAST }] });
  await suite('co-picking owner — PATCH 409 collaborator_limit is shown on the row, in plain Chinese; the row stays as it was',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await open(page);
      await page.waitForSelector('#coList .co-item', { timeout: 3000 });
      await page.selectOption('#coList .co-item:nth-child(3) .co-period-sel', '7');
      await page.click('#coList .co-item:nth-child(3) .co-period-apply');
      await page.waitForFunction(() => (document.querySelector('#coList .co-item:nth-child(3) .co-row-err')?.textContent || '').trim() !== '', null, { timeout: 3000 });
      const t = await page.textContent('#coList .co-item:nth-child(3) .co-row-err');
      ok('the message says the limit is 2', /協作者/.test(t) && /2/.test(t) && !/collaborator_limit/.test(t), t);
      ok('Cat is still expired', (await rows(page))[2].status === 'expired');
      return out;
    },
    { before: m.attach, initScript: initOwner(), contextOptions: MOBILE });
}

// ── 4. renewal ─────────────────────────────────────────────────────────────
const renewalWorld = () => world({ collaborators: [
  { name: 'Ann', expires_at: FUTURE(3) },
  { name: 'Cat', expires_at: PAST, renewal_requested_at: new Date(Date.now() - 600000).toISOString() },
] });

{
  const m = renewalWorld();
  await suite('co-picking owner — a renewal request shows a badge and a banner 「Cat 想繼續協作」; 核准 asks for the period, then POSTs decision',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#coPickEntry', { timeout: 5000 });
      await page.waitForSelector('#coRenewalBanner:not([hidden])', { timeout: 3000 });
      ok('opening the page with a request already waiting raises no toast (the banner is the notice)', (await page.$$('.toast')).length === 0);
      ok('the entry button carries a badge of 1', (await page.textContent('#coPickBadge')).trim() === '1', await page.textContent('#coPickBadge'));
      ok('the banner says 想繼續協作 with the name', /Cat 想繼續協作/.test(await page.textContent('#coRenewalBanner')), await page.textContent('#coRenewalBanner'));
      ok('the banner is visible (a real box)', await page.$eval('#coRenewalBanner', e => e.getBoundingClientRect().height > 20));
      ok('Ann (no request) is not in the banner', !/Ann/.test(await page.textContent('#coRenewalBanner')));
      await page.click('#coRenewalBanner .co-approve');
      ok('核准 does not post yet: it asks for a period first', reqs(m, 'POST', /decision/).length === 0 && (await page.$$('#coRenewalBanner [data-approve-days]')).length === 3);
      await page.click('#coRenewalBanner [data-approve-days="1"]');
      await page.waitForFunction(() => document.getElementById('coRenewalBanner').hidden, null, { timeout: 3000 });
      const d = reqs(m, 'POST', /decision/);
      ok('POST /collaborators/collab-2/decision {approve:true, window_days:1}', d.length === 1 && d[0].path === '/api/pick/collaborators/collab-2/decision' && JSON.stringify(d[0].body) === '{"approve":true,"window_days":1}', JSON.stringify(d.map(x => [x.path, x.body])));
      ok('the badge is gone', await page.$eval('#coPickBadge', e => e.hidden || e.textContent.trim() === ''));
      await open(page);
      await page.waitForFunction(() => document.querySelectorAll('#coList .co-item')[1]?.dataset.status === 'active', null, { timeout: 3000 });
      ok('and Cat is active in the list', (await rows(page))[1].status === 'active');
      return out;
    },
    { before: m.attach, initScript: initOwner(), contextOptions: MOBILE });
}

{
  const m = renewalWorld();
  await suite('co-picking owner — 拒絕 posts {approve:false}; the banner and badge go, Cat stays expired',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#coRenewalBanner:not([hidden])', { timeout: 5000 });
      await page.click('#coRenewalBanner .co-decline');
      await page.waitForFunction(() => document.getElementById('coRenewalBanner').hidden, null, { timeout: 3000 });
      const d = reqs(m, 'POST', /decision/);
      ok('one POST with {approve:false} (no window_days)', d.length === 1 && JSON.stringify(d[0].body) === '{"approve":false}', JSON.stringify(d.map(x => x.body)));
      ok('the badge is gone', await page.$eval('#coPickBadge', e => e.hidden || e.textContent.trim() === ''));
      await open(page);
      await page.waitForSelector('#coList .co-item', { timeout: 3000 });
      ok('Cat is still expired in the list', (await rows(page))[1].status === 'expired');
      return out;
    },
    { before: m.attach, initScript: initOwner(), contextOptions: MOBILE });
}

{
  const m = world({ collaborators: [{ name: 'Ann', expires_at: FUTURE(3) }, { name: 'Bob', expires_at: null }, { name: 'Cat', expires_at: PAST, renewal_requested_at: new Date().toISOString() }] });
  await suite('co-picking owner — approving into a full house shows the 409 collaborator_limit in plain Chinese and keeps the request',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#coRenewalBanner:not([hidden])', { timeout: 5000 });
      await page.click('#coRenewalBanner .co-approve');
      await page.click('#coRenewalBanner [data-approve-days="7"]');
      await page.waitForFunction(() => document.getElementById('coRenewalErr').textContent.trim() !== '', null, { timeout: 3000 });
      const t = await page.textContent('#coRenewalErr');
      ok('the message names the limit of 2', /協作者/.test(t) && /2/.test(t) && !/collaborator_limit/.test(t), t);
      ok('the banner is still there (the request is not lost)', await page.$eval('#coRenewalBanner', e => !e.hidden));
      return out;
    },
    { before: m.attach, initScript: initOwner(), contextOptions: MOBILE });
}

{
  // The Worker already hides a 'declined:<iso>' marker; the page must not show one even if it ever arrived.
  const m = world({ collaborators: [{ name: 'Cat', expires_at: PAST }] });
  await suite('co-picking owner — a declined: marker in renewal_requested_at is never shown as a request',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.route('**/api/pick/collaborators', async route => {
        if (route.request().method() !== 'GET') return route.fallback();
        const body = {
          collaborators: [{ picker_id: 'collab-1', name: 'Cat', joined_at: '2026-10-11T02:00:00.000Z', expires_at: PAST, revoked_at: null, status: 'expired',
            last_seen_at: null, renewal_requested_at: 'declined:' + new Date().toISOString() }],
          invites: { pending: 0, soonest_expires_at: null }, pending_renewals: 0, max: 2,
        };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      });
      await page.reload();
      await open(page);
      await page.waitForSelector('#coList .co-item', { timeout: 3000 });
      ok('the row is there (the answer was used)', (await rows(page))[0].name === 'Cat');
      ok('but no banner, no badge, no toast', (await page.$eval('#coRenewalBanner', e => e.hidden)) && (await page.$eval('#coPickBadge', e => e.hidden)) && (await page.$$('.toast')).length === 0);
      return out;
    },
    { before: m.attach, initScript: initOwner(), contextOptions: MOBILE });
}

// ── 5. polling and the toast ───────────────────────────────────────────────
{
  const m = world({ collaborators: [{ name: 'Ann', expires_at: FUTURE(3) }, { name: 'Cat', expires_at: PAST }] });
  await suite('co-picking owner — polls GET /collaborators while visible; a NEW request raises one toast, a badge and the banner; no polling while hidden',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#coPickEntry', { timeout: 5000 });
      ok('no banner and no toast at the start', (await page.$eval('#coRenewalBanner', e => e.hidden)) && (await page.$$('.toast')).length === 0);
      const gets = () => reqs(m, 'GET', /\/api\/pick\/collaborators$/).length;
      const g0 = gets();
      await page.waitForTimeout(900);
      ok('it polls on its own (interval 250 ms in this test)', gets() >= g0 + 2, `${g0} -> ${gets()}`);
      // hidden: no polling
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForTimeout(100);
      const gh = gets();
      m.state.collaborators.get('collab-2').renewal_requested_at = new Date().toISOString();
      await page.waitForTimeout(900);
      ok('while hidden no request goes out and the new request is not seen yet', gets() === gh && (await page.$eval('#coRenewalBanner', e => e.hidden)), `${gh} -> ${gets()}`);
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForSelector('#coRenewalBanner:not([hidden])', { timeout: 3000 });
      ok('back visible: polling resumes and the banner shows Cat', /Cat 想繼續協作/.test(await page.textContent('#coRenewalBanner')));
      ok('the badge is 1', (await page.textContent('#coPickBadge')).trim() === '1');
      const toasts = await page.$$eval('.toast .toast-message', els => els.map(e => e.textContent));
      ok('exactly one toast, naming Cat', toasts.length === 1 && /Cat/.test(toasts[0]) && /繼續協作/.test(toasts[0]), JSON.stringify(toasts));
      await page.waitForTimeout(900);
      ok('more polls do not raise it again', (await page.$$('.toast')).length === 1);
      return out;
    },
    { before: m.attach, initScript: initOwner('LIA-KEY', 250), contextOptions: MOBILE });
}

// ── 6. only the owner ──────────────────────────────────────────────────────
{
  const m = world({ collaborators: [{ name: 'Ann', key: 'ANN-KEY', expires_at: FUTURE(3) }, { name: 'Cat', key: 'CAT-KEY', expires_at: PAST }, { name: 'Dan', key: 'DAN-KEY', revoked_at: PAST }] });
  const nothing = async (page, label, out) => {
    await page.waitForSelector('.photo-card', { timeout: 5000 });
    await page.waitForTimeout(600);
    const dom = await page.evaluate(() => ['coPickBar', 'coPickEntry', 'coPanel', 'coRenewalBanner', 'coPickBadge'].filter(id => document.getElementById(id)));
    out.push(`${dom.length === 0 ? 'ok  ' : 'FAIL'}  ${label}: none of the owner panel is in the DOM${dom.length ? `   [${dom}]` : ''}`);
    const calls = m.requests.filter(r => /\/api\/pick\/(collaborators|invites)/.test(r.path));
    out.push(`${calls.length === 0 ? 'ok  ' : 'FAIL'}  ${label}: no co-picking request was made${calls.length ? `   [${calls.map(c => c.path)}]` : ''}`);
  };
  for (const [who, key] of [['an active collaborator', 'ANN-KEY'], ['an expired collaborator', 'CAT-KEY'], ['a removed collaborator', 'DAN-KEY'], ['a viewer with no key', '']]) {
    await suite(`co-picking owner — ${who} sees nothing of the owner panel`,
      url,
      async page => { const out = []; await nothing(page, who, out); return out; },
      { before: m.attach, initScript: initOwner(key, 250), contextOptions: MOBILE });
  }
  await suite('co-picking owner — the same page for the owner DOES have the panel entry (positive control)',
    url,
    async page => {
      const out = [];
      await page.waitForSelector('#coPickEntry', { timeout: 5000 });
      out.push(`${(await page.$eval('#coPickEntry', e => e.getBoundingClientRect().height)) > 20 ? 'ok  ' : 'FAIL'}  the owner has a visible entry button`);
      return out;
    },
    { before: m.attach, initScript: initOwner(), contextOptions: MOBILE });
}

{
  const m = world({ coPicking: false });
  await suite('co-picking owner — 500 co_picking_unavailable hides the panel cleanly; the page still works',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.waitForTimeout(600);
      ok('the owner panel is not in the DOM', await page.evaluate(() => ['coPickBar', 'coPickEntry', 'coPanel', 'coRenewalBanner'].every(id => !document.getElementById(id))));
      ok('the server was asked (so this is not just the owner check)', reqs(m, 'GET', /\/api\/pick\/collaborators$/).length >= 1);
      await page.waitForTimeout(700);
      ok('and it does not keep polling an unavailable feature', reqs(m, 'GET', /\/api\/pick\/collaborators$/).length === 1, String(reqs(m, 'GET', /\/api\/pick\/collaborators$/).length));
      await page.evaluate(() => PickController._syncCoPicking());   // the page syncs again (e.g. after a claim): it must not retry
      await page.waitForTimeout(300);
      ok('a later sync does not ask again or bring the panel back', reqs(m, 'GET', /\/api\/pick\/collaborators$/).length === 1 && (await page.$('#coPickBar')) === null);
      ok('no toast about it', (await page.$$('.toast')).length === 0);
      return out;
    },
    { before: m.attach, initScript: initOwner('LIA-KEY', 250), contextOptions: MOBILE });
}

{
  const m = world({ phase: 'retouching', folders: ['shoot/毛片/'], finalFolders: ['shoot/精修/'], deliveredAt: '2026-10-01T00:00:00.000Z',
    pickFiles: ['shoot/毛片/a.jpg', 'shoot/精修/f1.jpg', 'shoot/精修/f2.jpg'] });
  await suite('co-picking owner — a delivered project (the gallery) has no invite panel',
    url,
    async page => {
      const out = [];
      await page.waitForSelector('.fg-tile', { timeout: 5000 });
      await page.waitForTimeout(500);
      out.push(`ok    (the page really is the delivered gallery: the finals tiles are up)`);
      const dom = await page.evaluate(() => ['coPickEntry', 'coPanel'].filter(id => document.getElementById(id)));
      out.push(`${dom.length === 0 ? 'ok  ' : 'FAIL'}  not in the DOM when delivered${dom.length ? `  [${dom}]` : ''}`);
      const calls = m.requests.filter(r => /\/api\/pick\/collaborators/.test(r.path));
      out.push(`${calls.length === 0 ? 'ok  ' : 'FAIL'}  and nothing was asked of /collaborators`);
      return out;
    },
    { before: m.attach, initScript: initOwner(), contextOptions: MOBILE });
}

// ── 7. names are user input ────────────────────────────────────────────────
{
  const m = world({ collaborators: [{ name: XSS, expires_at: PAST, renewal_requested_at: new Date().toISOString() }] });
  await suite('co-picking owner — a collaborator named <img onerror=…> is text everywhere: list, banner, confirm, toast',
    url,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#coRenewalBanner:not([hidden])', { timeout: 5000 });
      ok('banner shows the literal characters', (await page.textContent('#coRenewalBanner')).includes(XSS));
      await open(page);
      await page.waitForSelector('#coList .co-item', { timeout: 3000 });
      ok('list shows the literal characters', (await page.textContent('#coList .co-name')).includes(XSS));
      await page.click('#coList .co-remove');
      ok('confirm shows the literal characters', (await page.textContent('.co-confirm')).includes(XSS));
      // a toast for a second, new request with the same kind of name
      m.state.collaborators.set('collab-x', { picker_id: 'collab-x', invited_by: m.state.project.owner_picker_id, joined_at: new Date().toISOString(),
        expires_at: PAST, revoked_at: null, last_seen_at: null, renewal_requested_at: new Date().toISOString() });
      m.state.pickers.set('collab-x', { id: 'collab-x', name: XSS + 'B', key: 'X' });
      await page.waitForSelector('.toast .toast-message', { timeout: 4000 });
      ok('the toast shows the literal characters', (await page.textContent('.toast .toast-message')).includes('<img'));
      const bad = await page.evaluate(() => ({
        xss: window.__xss || null,
        imgs: document.querySelectorAll('#coPanel img, #coRenewalBanner img, .toast img[src="x"], #coList img').length,
      }));
      ok('no image element was created and no handler ran', bad.xss === null && bad.imgs === 0, JSON.stringify(bad));
      return out;
    },
    { before: m.attach, initScript: initOwner('LIA-KEY', 250), contextOptions: MOBILE });
}

}
