// Browser suites: the 👁 button on the photographer's password fields (js/password-toggle.js): home.html, admin.html's
// login, operator.html and the js/auth.js overlay (upload.html). One click shows what was typed, the next hides it; the
// field is hidden again when focus leaves the group, and the button never submits the form.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';

export default async function register() {

const PAGES = [
  ['home.html', '#loginTokenInput', async page => { await page.click('#heroLoginBtn'); }],
  ['admin.html', '#admin-token-input', async () => {}],
  ['operator.html', '#op-token', async () => {}],
  ['upload.html', '#auth-input', async () => {}],
];

for (const [file, sel, open] of PAGES) {
  await suite(`password eye — ${file}: the 👁 button shows and hides what was typed`,
    `${base}/${file}`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      const posts = [];
      page.on('request', r => { if (r.method() !== 'GET' && !r.url().startsWith(base)) posts.push(r.url()); });
      await open(page);
      await page.waitForSelector(sel, { state: 'visible', timeout: 5000 });
      const eye = page.locator(`${sel} ~ .pw-eye, .pw-wrap:has(${sel}) .pw-eye`).first();
      ok('an eye button sits with the field (positive: it exists)', (await eye.count()) === 1);
      const type = () => page.$eval(sel, e => e.type);
      ok('the field starts hidden', (await type()) === 'password');
      ok('the button says 顯示密碼 and is not pressed', (await eye.getAttribute('aria-label')) === '顯示密碼' && (await eye.getAttribute('aria-pressed')) === 'false');
      await page.fill(sel, 'my-secret-123');
      await eye.click();
      ok('one click: the field shows the text', (await type()) === 'text' && (await page.inputValue(sel)) === 'my-secret-123', await type());
      ok('and the button says 隱藏密碼, pressed', (await eye.getAttribute('aria-label')) === '隱藏密碼' && (await eye.getAttribute('aria-pressed')) === 'true');
      await eye.click();
      ok('a second click hides it again, the text is kept', (await type()) === 'password' && (await page.inputValue(sel)) === 'my-secret-123');
      const box = await eye.boundingBox();
      ok('the button is at least 40px wide and tall (a thumb can hit it)', box && box.width >= 40 && box.height >= 40, JSON.stringify(box));
      ok('it sits inside the field (right edge), not on the text', await page.evaluate(([s]) => {
        const f = document.querySelector(s).getBoundingClientRect(), b = document.querySelector(s).parentElement.querySelector('.pw-eye').getBoundingClientRect();
        return b.left >= f.left && b.right <= f.right + 1 && getComputedStyle(document.querySelector(s)).paddingRight !== '0px';
      }, [sel]));
      // a press on the eye does not take the focus off the field, so show then hide works while typing
      await page.focus(sel);
      await eye.click();
      ok('with the field focused: one tap shows, the field keeps the focus', (await type()) === 'text' && (await page.evaluate(s => document.activeElement === document.querySelector(s), sel)));
      await eye.click();
      ok('and the next tap hides it again', (await type()) === 'password');
      // shown, then focus goes elsewhere: hidden again
      await eye.click();
      ok('(shown again)', (await type()) === 'text');
      await page.evaluate(() => { const o = document.createElement('button'); o.id = 'elsewhere'; o.textContent = 'x'; document.body.appendChild(o); o.focus(); });
      ok('focus leaves the group: hidden again', (await type()) === 'password');
      ok('the eye never sent a request', posts.length === 0, JSON.stringify(posts));
      return out;
    },
    { contextOptions: MOBILE });
}

await suite('password eye — home.html: a login reopened after being closed with the text showing starts hidden',
  `${base}/home.html`,
  async page => {
    const out = [];
    const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
    await page.click('#heroLoginBtn');
    await page.waitForSelector('#loginTokenInput', { state: 'visible', timeout: 5000 });
    await page.fill('#loginTokenInput', 'abc');
    await page.locator('.pw-eye').click();
    ok('(shown)', (await page.$eval('#loginTokenInput', e => e.type)) === 'text');
    // closed by script, so no focusout from the eye button: the reopen itself must hide it again
    await page.evaluate(() => document.getElementById('loginOverlay').classList.remove('open'));
    await page.evaluate(() => document.getElementById('heroLoginBtn').click());   // a script click moves no focus
    await page.waitForSelector('#loginTokenInput', { state: 'visible', timeout: 5000 });
    ok('reopened: hidden again and empty', (await page.$eval('#loginTokenInput', e => e.type)) === 'password' && (await page.inputValue('#loginTokenInput')) === '');
    return out;
  },
  { contextOptions: MOBILE });
}
