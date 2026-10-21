// Browser suites: the submit form remembers 與被攝者的關係 and Email after a submit that went through, so a second submit
// (before the photographer starts retouching) does not ask again (Tim 2026-10-18). Never after a refused submit.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const OWNER = "localStorage.setItem('pick_key:TOK', 'CAROL-KEY');";
const form = page => page.evaluate(() => ({ rel: document.getElementById('pickSubmitRelationship').value, email: document.getElementById('pickSubmitEmail').value,
  open: document.getElementById('pickSubmitModal').classList.contains('active') }));
const openForm = async page => { await page.click('#pickSubmitBtn'); await page.waitForSelector('#pickSubmitModal.active', { timeout: 5000 }); };

{
  const m = pickFakeWorker({ ownerName: 'Carol', ownerKey: 'CAROL-KEY' });
  await suite('submit form — a second submit remembers 關係 and Email; a refused one remembers nothing',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await openForm(page);
      const first = await form(page);
      ok('control: the first time the form is empty (請選擇)', first.open && first.rel === '' && first.email === '', JSON.stringify(first));
      // a refused submit (malformed email) stores nothing
      await page.selectOption('#pickSubmitRelationship', '家人');
      await page.fill('#pickSubmitEmail', 'not-an-email');
      await page.click('#pickSubmitConfirmBtn');
      await page.waitForTimeout(300);
      ok('a refused submit left nothing behind', (await page.evaluate(() => localStorage.getItem('pick_submit:TOK'))) === null);
      // a submit that goes through stores it
      await page.fill('#pickSubmitEmail', 'carol@example.com');
      await page.click('#pickSubmitConfirmBtn');
      await page.waitForFunction(() => !document.getElementById('pickSubmitModal').classList.contains('active'), null, { timeout: 4000 });
      ok('a submit that went through is remembered for this link', (await page.evaluate(() => localStorage.getItem('pick_submit:TOK'))) === JSON.stringify({ relationship: '家人', email: 'carol@example.com' }));
      // a second submit: change a heart, open the form again
      await page.click('.pick-heart-btn');
      await openForm(page);
      const second = await form(page);
      ok('the second time the form is prefilled: 家人 and the email', second.rel === '家人' && second.email === 'carol@example.com', JSON.stringify(second));
      // and after a reload too
      await page.reload();
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await openForm(page);
      const third = await form(page);
      ok('...and after reloading the page', third.rel === '家人' && third.email === 'carol@example.com', JSON.stringify(third));
      // changing it and submitting remembers the new choice
      await page.selectOption('#pickSubmitRelationship', '朋友');
      await page.fill('#pickSubmitEmail', '');
      await page.click('#pickSubmitConfirmBtn');
      await page.waitForFunction(() => !document.getElementById('pickSubmitModal').classList.contains('active'), null, { timeout: 4000 });
      ok('a changed choice replaces the old one', (await page.evaluate(() => localStorage.getItem('pick_submit:TOK'))) === JSON.stringify({ relationship: '朋友', email: '' }));
      return out;
    },
    { before: m.attach, initScript: OWNER });
}
{
  const m = pickFakeWorker({ ownerName: 'Carol', ownerKey: 'CAROL-KEY' });
  await suite('submit form — a junk memory is ignored (not an option → 請選擇, a non-string email → empty)',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await openForm(page);
      const f = await form(page);
      ok('a relationship that is not one of the options shows 請選擇, and no crash', f.open && f.rel === '', JSON.stringify(f));
      ok('the email from a corrupt memory is not shown either (a non-string field)', f.email === '', JSON.stringify(f));
      return out;
    },
    { before: m.attach, initScript: OWNER + `localStorage.setItem('pick_submit:TOK', JSON.stringify({ relationship: '<img src=x>', email: 5 }));` });
}
{
  const m = pickFakeWorker({ ownerName: 'Carol', ownerKey: 'CAROL-KEY' });
  await suite('submit form — another link\'s memory is not used (the memory is per link)',
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      ok('control: the other link\'s memory is really in storage', (await page.evaluate(() => localStorage.getItem('pick_submit:OTHER'))) !== null);
      await openForm(page);
      const f = await form(page);
      ok('this link\'s form is empty', f.open && f.rel === '' && f.email === '', JSON.stringify(f));
      return out;
    },
    { before: m.attach, initScript: OWNER + `localStorage.setItem('pick_submit:OTHER', JSON.stringify({ relationship: '家人', email: 'x@y.z' }));` });
}

}
