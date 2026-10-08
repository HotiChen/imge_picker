// Browser suite: 複製連結 (project list row, create result, project detail links) also opens a dialog with a
// ready-to-send message (title + link + how to open) in an editable textarea (the default text is set in 設定, suite 57), so it can be tweaked or selected by hand
// where the clipboard is blocked. The link itself is still copied at once (suite 35 pins that).
import { base, suite } from '../lib/harness.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const ADMIN_SRC = `(${ADMIN.toString()})();`;
const okFn = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const CLIP = `${ADMIN_SRC}
  window.__clip = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async t => { window.__clip.push(t); } } });`;
const world = () => pickFakeWorker({ projectId: 'proj-sl', title: '王小明 & 陳小美 婚紗', ownerName: 'Zoe', folders: ['shoot/毛片/'], phase: 'picking', listToken: 'SL-TOK' });
const dlg = page => page.evaluate(() => {
  const o = document.getElementById('pd-share-link');
  if (!o) return null;
  const box = o.querySelector('[role="dialog"]'), ta = document.getElementById('sl-text'), r = box.getBoundingClientRect();
  return { text: ta.value, readOnly: ta.readOnly, visible: r.width > 100 && r.height > 100, copy: document.getElementById('sl-copy-btn')?.textContent || '' };
});

{
  const m = world();
  await suite('56 複製連結 — 列上的「複製連結」：連結照舊先複製，並跳出可複製的文字視窗（標題 + 連結 + 使用說明）',
    `${base}/admin.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('[data-project-row] [data-copy-link]', { timeout: 5000 });
      ok('before the click there is no dialog (positive: the button is there)', (await page.$('#pd-share-link')) === null);
      await page.click('[data-project-row] [data-copy-link]');
      await page.waitForSelector('#pd-share-link', { timeout: 3000 });
      const d = await dlg(page);
      ok('the dialog is visible with an editable textarea', !!d && d.visible && !d.readOnly, JSON.stringify(d));
      ok('the text names the project', d.text.includes('王小明 & 陳小美 婚紗'), d.text);
      ok('the text carries the pick link', /index\.html\?t=SL-TOK/.test(d.text), d.text);
      ok('the text says to open it on a phone and to submit', d.text.includes('手機') && d.text.includes('完成提交'), d.text);
      const clip = await page.evaluate(() => window.__clip);
      ok('the link alone was still copied once, at the click', clip.length === 1 && /index\.html\?t=SL-TOK$/.test(clip[0]), JSON.stringify(clip));
      await page.click('#sl-copy-btn');
      await page.waitForFunction(() => window.__clip.length === 2, null, { timeout: 3000 });
      const clip2 = await page.evaluate(() => window.__clip[1]);
      ok('複製 copies the whole message', clip2 === d.text, clip2);
      ok('the status says 已複製', (await page.$eval('#sl-status', e => e.textContent)).includes('已複製'));
      await page.click('#sl-close-btn');
      ok('關閉 removes the dialog', (await page.$('#pd-share-link')) === null);
      ok('the project detail did not open (hash empty)', (await page.evaluate(() => location.hash)) === '');
      await page.click('[data-project-row] [data-copy-link]');
      await page.waitForSelector('#pd-share-link', { timeout: 3000 });
      await page.keyboard.press('Escape');
      ok('Esc closes it', (await page.$('#pd-share-link')) === null);
      return out;
    },
    { before: m.attach, initScript: CLIP });
}

{
  const m = world();
  await suite('56 複製連結 — 剪貼簿被擋也沒關係：視窗裡的文字可以手動選取複製，狀態提示手動複製',
    `${base}/admin.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('[data-project-row] [data-copy-link]', { timeout: 5000 });
      await page.click('[data-project-row] [data-copy-link]');
      await page.waitForSelector('#pd-share-link', { timeout: 3000 });
      const d = await dlg(page);
      ok('the dialog still opens when the clipboard rejects', !!d && d.visible && /index\.html\?t=SL-TOK/.test(d.text), JSON.stringify(d));
      await page.click('#sl-copy-btn');
      await page.waitForFunction(() => document.getElementById('sl-status').textContent.length > 0, null, { timeout: 3000 });
      ok('the status asks to copy by hand (長按)', (await page.$eval('#sl-status', e => e.textContent)).includes('長按'), await page.$eval('#sl-status', e => e.textContent));
      return out;
    },
    { before: m.attach, initScript: `${ADMIN_SRC} Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('blocked'); } } }); document.execCommand = () => false;` });
}

{
  const m = world();
  await suite('56 複製連結 — 專案詳情「挑選人與連結」裡的「複製連結」也一樣；標題用專案名稱（改名後跟著變）',
    `${base}/admin.html#project=proj-sl`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#project-detail-body [data-copy-link]', { timeout: 6000 });
      await page.click('#project-detail-body [data-copy-link]');
      await page.waitForSelector('#pd-share-link', { timeout: 3000 });
      const d = await dlg(page);
      ok('the dialog opens from the detail too, with title and link', !!d && d.text.includes('王小明 & 陳小美 婚紗') && /index\.html\?t=SL-TOK/.test(d.text), JSON.stringify(d));
      return out;
    },
    { before: m.attach, initScript: CLIP });
}

{
  const m = pickFakeWorker({ projectId: 'proj-xss', title: '<img src=x onerror="window.__pwn=1"> 婚紗', ownerName: 'Zoe', folders: ['shoot/毛片/'], phase: 'picking', listToken: 'XSS-TOK' });
  await suite('56 複製連結 — 專案名稱有 HTML / 引號也只是純文字，不執行',
    `${base}/admin.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('[data-project-row] [data-copy-link]', { timeout: 5000 });
      await page.click('[data-project-row] [data-copy-link]');
      await page.waitForSelector('#pd-share-link', { timeout: 3000 });
      const d = await dlg(page);
      ok('the title is in the text as typed', d.text.includes('<img src=x onerror="window.__pwn=1"> 婚紗'), d.text);
      ok('nothing ran and no img element was made in the dialog', (await page.evaluate(() => window.__pwn === undefined && !document.querySelector('#pd-share-link img'))));
      return out;
    },
    { before: m.attach, initScript: CLIP });
}

{
  const m = world();
  await suite('56 複製連結 — 連按兩次「複製連結」只有一個視窗，也不留下沒清掉的 Esc 監聽',
    `${base}/admin.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('[data-project-row] [data-copy-link]', { timeout: 5000 });
      await page.evaluate(() => {
        window.__keydown = 0;
        const add = document.addEventListener.bind(document), rm = document.removeEventListener.bind(document);
        document.addEventListener = (t, f, o) => { if (t === 'keydown') window.__keydown++; return add(t, f, o); };
        document.removeEventListener = (t, f, o) => { if (t === 'keydown') window.__keydown--; return rm(t, f, o); };
      });
      await page.click('[data-project-row] [data-copy-link]');
      await page.waitForSelector('#pd-share-link', { timeout: 3000 });
      await page.evaluate(() => document.querySelector('[data-project-row] [data-copy-link]').click());
      await page.waitForTimeout(150);
      ok('only one dialog exists after two opens', (await page.$$('#pd-share-link')).length === 1);
      await page.click('#sl-close-btn');
      ok('關閉 closes it', (await page.$('#pd-share-link')) === null);
      ok('no keydown listener is left behind (adds − removes = 0)', (await page.evaluate(() => window.__keydown)) === 0, String(await page.evaluate(() => window.__keydown)));
      return out;
    },
    { before: m.attach, initScript: CLIP });
}

{
  const m = pickFakeWorker({ pickFiles: [] });
  await suite('56 複製連結 — 建立專案後的「複製連結」也跳出視窗，標題是剛建立的專案名稱',
    `${base}/admin.html`,
    async page => {
      const out = [], ok = okFn(out);
      await page.waitForSelector('#admin-view', { state: 'visible', timeout: 5000 });
      await page.fill('#proj-title', '新專案 A&B');
      await page.click('#proj-create-btn');
      await page.waitForSelector('#proj-create-result', { state: 'visible', timeout: 5000 });
      ok('positive: no dialog before the click', (await page.$('#pd-share-link')) === null);
      await page.click('#proj-copy-link-btn');
      await page.waitForSelector('#pd-share-link', { timeout: 3000 });
      const d = await dlg(page);
      ok('the dialog carries the new project title and a pick link', !!d && d.text.includes('新專案 A&B') && /index\.html\?t=[A-Za-z0-9_-]+/.test(d.text), JSON.stringify(d));
      const clip = await page.evaluate(() => window.__clip);
      ok('the link alone was copied once', clip.length === 1 && /index\.html\?t=[A-Za-z0-9_-]+$/.test(clip[0]), JSON.stringify(clip));
      return out;
    },
    { before: m.attach, initScript: CLIP });
}
}
