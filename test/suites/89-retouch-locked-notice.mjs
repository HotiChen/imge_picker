// Browser suites: once the photographer has started retouching, a guest who taps a ♥ (or whose change comes back 409
// retouching, or who tries to submit) gets a notice in the middle of the screen: 攝影師已安排精修, contact the photographer
// (Tim 2026-10-18). Warning and error toasts are in the middle too.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const OWNER = "localStorage.setItem('pick_key:TOK', 'CAROL-KEY');";
const DESK = { viewport: { width: 1280, height: 900 } };
const FILES = ['20260819/a.jpg', '20260819/b.jpg', '20260819/c.jpg'];
const world = o => pickFakeWorker({ ownerName: 'Carol', ownerKey: 'CAROL-KEY', folders: ['20260819/'], pickFiles: FILES, ...o });
const notice = page => page.evaluate(() => {
  const m = document.getElementById('pickNoticeModal'), c = m && m.querySelector('.modal-content'), r = c && c.getBoundingClientRect();
  return { active: !!m && m.classList.contains('active'), text: document.getElementById('pickNoticeBody')?.textContent || '', title: document.getElementById('pickNoticeTitle')?.textContent || '',
    cx: r ? r.left + r.width / 2 : null, cy: r ? r.top + r.height / 2 : null, vw: innerWidth, vh: innerHeight, toasts: document.querySelectorAll('#toastContainer .toast').length };
});
const centered = n => Math.abs(n.cx - n.vw / 2) <= 2 && Math.abs(n.cy - n.vh / 2) <= n.vh * 0.15;
const puts = m => m.requests.filter(r => r.method === 'PUT' && r.path.endsWith('/api/pick/selections')).length;

for (const [label, co] of [['phone 390px', MOBILE], ['desktop 1280px', DESK]]) {
  const m = world({ phase: 'retouching' });
  await suite(`retouching (${label}) — a tap on a ♥ says 攝影師已安排精修, in the middle of the screen; nothing is changed`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const before = await page.evaluate(() => ({ cards: document.querySelectorAll('.photo-card').length, on: document.querySelectorAll('.pick-heart-btn.on').length, buttons: document.querySelectorAll('button.pick-heart-btn').length }));
      ok('control: the grid is up, the page knows picking is closed (the banner says so), the hearts are read-only', before.cards === 3 && before.buttons === 0 && /攝影師已安排精修/.test(await page.textContent('#pickBanner')), JSON.stringify(before));
      await page.click('.photo-card .pick-heart-btn');
      const n = await notice(page);
      ok('a notice is open, titled 已安排精修, saying to contact the photographer', n.active && n.title === '已安排精修' && /攝影師已安排精修/.test(n.text) && /聯絡攝影師/.test(n.text), JSON.stringify(n));
      ok('it is in the middle of the screen, and it is not a corner toast', centered(n) && n.toasts === 0, JSON.stringify(n));
      ok('the photo did not open and nothing was sent or changed', !(await page.evaluate(() => document.getElementById('photoModal')?.classList.contains('active'))) && puts(m) === 0 &&
        (await page.evaluate(() => document.querySelectorAll('.pick-heart-btn.on').length)) === before.on);
      await page.click('#pickNoticeOkBtn');
      ok('「知道了」 closes it', !(await notice(page)).active);
      await page.click('.photo-card .pick-heart-btn');
      ok('and a tap on a heart opens it again', (await notice(page)).active);
      return out;
    },
    { before: m.attach, initScript: OWNER, contextOptions: co });
}

{
  const m = world({});
  await suite('picking is open — a tap on a ♥ hearts the photo and shows no notice (positive control)',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.click('.photo-card .pick-heart-btn');
      await page.waitForFunction(() => document.querySelectorAll('.pick-heart-btn.on').length === 1, null, { timeout: 3000 });
      const n = await notice(page);
      ok('the heart is on and no notice is open', !n.active, JSON.stringify(n));
      return out;
    },
    { before: m.attach, initScript: OWNER, contextOptions: DESK });
}

{
  const m = world({});
  await suite('the photographer starts retouching while the page is open — the next heart is refused (409) and the notice says why',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      m.state.project.phase = 'retouching';
      await page.click('.photo-card .pick-heart-btn');
      await page.waitForFunction(() => document.getElementById('pickNoticeModal')?.classList.contains('active'), null, { timeout: 5000 });
      const n = await notice(page);
      ok('the notice opens in the middle', n.active && /攝影師已安排精修/.test(n.text) && centered(n), JSON.stringify(n));
      await page.waitForFunction(() => document.querySelectorAll('.photo-card button.pick-heart-btn').length === 0, null, { timeout: 3000 }).catch(() => {});
      ok('the grid is read-only now: its hearts are no longer buttons', (await page.evaluate(() => document.querySelectorAll('.photo-card button.pick-heart-btn').length)) === 0);
      return out;
    },
    { before: m.attach, initScript: OWNER, contextOptions: DESK });
}

{
  const m = world({});
  await suite('the photographer starts retouching while the submit form is open — the submit is refused (409) and the notice says why',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.click('.photo-card .pick-heart-btn');
      await page.waitForFunction(() => document.querySelectorAll('.pick-heart-btn.on').length === 1, null, { timeout: 3000 });
      await page.click('#pickSubmitBtn');
      await page.waitForSelector('#pickSubmitModal.active', { timeout: 5000 });
      await page.selectOption('#pickSubmitRelationship', '朋友');
      for (let i = 0; i < 60 && puts(m) < 1; i++) await page.waitForTimeout(100);   // the heart is saved: only the submit itself can come back 409
      ok('control: the heart was saved before the phase changed', puts(m) >= 1);
      m.state.project.phase = 'retouching';
      await page.click('#pickSubmitConfirmBtn');
      await page.waitForFunction(() => document.getElementById('pickNoticeModal')?.classList.contains('active'), null, { timeout: 5000 });
      const n = await notice(page);
      ok('the notice opens in the middle and the submit form is closed', n.active && /攝影師已安排精修/.test(n.text) && centered(n) &&
        !(await page.evaluate(() => document.getElementById('pickSubmitModal').classList.contains('active'))), JSON.stringify(n));
      return out;
    },
    { before: m.attach, initScript: OWNER, contextOptions: DESK });
}

{
  const m = world({ phase: 'retouching' });
  await suite('retouching — the submit button gives the same notice in the middle (no corner toast)',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('control: the submit button is there', (await page.$('#pickSubmitBtn')) !== null);
      await page.click('#pickSubmitBtn');
      const n = await notice(page);
      ok('the notice is open in the middle, and the submit form did not open', n.active && /攝影師已安排精修/.test(n.text) && centered(n) && n.toasts === 0 &&
        !(await page.evaluate(() => document.getElementById('pickSubmitModal').classList.contains('active'))), JSON.stringify(n));
      return out;
    },
    { before: m.attach, initScript: OWNER, contextOptions: DESK });
}

{
  const m = world({});
  await suite('a centred warning does not eat taps meant for the photos; a toast with a button stays clickable',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.evaluate(() => { toast.warning('一則警告', 5000); toast.withAction('可以按的', 'warning', '復原', () => { window.__undone = true; }, 5000); });
      await page.waitForTimeout(450);
      const r = await page.evaluate(() => {
        const [plain, withBtn] = [...document.querySelectorAll('#toastContainer .toast')];
        const at = el => { const b = el.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return { hitsToast: !!hit && el.contains(hit), pe: getComputedStyle(el).pointerEvents }; };
        const btn = withBtn.querySelector('button').getBoundingClientRect();
        const hitBtn = document.elementFromPoint(btn.left + btn.width / 2, btn.top + btn.height / 2);
        return { plain: at(plain), withBtn: { pe: getComputedStyle(withBtn).pointerEvents, hitsButton: hitBtn === withBtn.querySelector('button') }, n: document.querySelectorAll('#toastContainer .toast').length };
      });
      ok('control: both toasts are up', r.n === 2, JSON.stringify(r));
      ok('a plain warning lets a tap through to what is under it', r.plain.pe === 'none' && !r.plain.hitsToast, JSON.stringify(r.plain));
      ok('a toast with a button is still clickable, and the button gets the tap', r.withBtn.pe === 'all' && r.withBtn.hitsButton, JSON.stringify(r.withBtn));
      return out;
    },
    { before: m.attach, initScript: OWNER, contextOptions: DESK });
}

{
  const m = world({ phase: 'retouching' });
  await suite('retouching — warning and error toasts are in the middle of the screen, a success toast keeps the corner',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      const at = type => page.evaluate(t => { toast[t]('測試訊息', 4000); const el = [...document.querySelectorAll('#toastContainer .toast')].pop(); const r = el.getBoundingClientRect();
        return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, vw: innerWidth, vh: innerHeight, left: r.left }; }, type);
      for (const type of ['warning', 'error']) {
        await page.waitForTimeout(0);
        const p = await at(type);
        await page.waitForTimeout(450);   // past the toast's fade-in
        Object.assign(p, await page.evaluate(() => { const r = [...document.querySelectorAll('#toastContainer .toast')].pop().getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }));
        ok(`a ${type} toast is centred horizontally and vertically`, Math.abs(p.cx - p.vw / 2) <= 2 && Math.abs(p.cy - p.vh / 2) <= p.vh * 0.1, JSON.stringify(p));
        await page.evaluate(() => document.querySelectorAll('#toastContainer .toast').forEach(e => e.remove()));
      }
      // a success toast shown while a warning is up still keeps the corner
      await page.evaluate(() => toast.warning('先出現的警告', 4000));
      const mixed = await at('success');
      await page.waitForTimeout(450);
      Object.assign(mixed, await page.evaluate(() => { const r = [...document.querySelectorAll('#toastContainer .toast.success')].pop().getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }));
      ok('a success toast shown while a warning is up stays in the top-right corner', mixed.cx > mixed.vw * 0.6 && mixed.cy < mixed.vh * 0.2, JSON.stringify(mixed));
      await page.evaluate(() => document.querySelectorAll('#toastContainer .toast').forEach(e => e.remove()));
      const s = await at('success');
      await page.waitForTimeout(450);
      Object.assign(s, await page.evaluate(() => { const r = [...document.querySelectorAll('#toastContainer .toast')].pop().getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; }));
      ok('a success toast stays in the top-right corner', s.cx > s.vw * 0.6 && s.cy < s.vh * 0.2, JSON.stringify(s));
      return out;
    },
    { before: m.attach, initScript: OWNER, contextOptions: DESK });
}

}
