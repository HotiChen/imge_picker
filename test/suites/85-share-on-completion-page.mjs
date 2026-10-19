// Browser suites: the share button lives on the 完成頁 only (Tim 2026-10-15). The 驗收頁 (delivered, not yet
// confirmed) has no share button: the album is not final. The link, its fallbacks and its privacy rules
// (js/pick.js shareLink) are unchanged; they moved here from 28-finals-gallery.mjs together with the button.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { MOBILE } from '../lib/env.mjs';
import { ALB_DESK, albumWorld } from '../lib/album-world.mjs';
import { shopProductsFake } from '../lib/pick-fake.mjs';

export default async function register() {

const T0 = '2026-09-21T03:00:00.000Z';
const STUDIO = { name: '光影工作室', booking_url: null, has_logo: true };
const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
// a confirmed project on the 完成頁 (the album world's default photos), and the same project not confirmed (the 驗收頁)
const cpWorld = () => albumWorld({ n: 6, fake: { title: '婚禮精修', confirmedAt: T0, studio: STUDIO, shopProducts: shopProductsFake() } });
const cpReady = page => page.waitForFunction(() => document.querySelectorAll('#completionPage .fg-tile').length === 6, null, { timeout: 8000 });

// ── 1. the 驗收頁 has no share button, anywhere
for (const [who, init, co] of [['owner', "localStorage.setItem('pick_key:TOK', 'ZOE-KEY');", ALB_DESK], ['viewer', '', MOBILE]]) {
  const w = albumWorld({ n: 6, fake: { title: '婚禮精修', confirmedAt: null, studio: STUDIO } });
  await suite(`share — the unconfirmed 驗收頁 (${who}) has no share button`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [], ok = line(out);
      // EDITED 2026-10-19: the 驗收頁 is the 毛片 page (the standard cards, no web album)
      await page.waitForFunction(() => document.querySelectorAll('#photoGrid .photo-card').length === 6, null, { timeout: 8000 });
      await page.waitForTimeout(400);
      const s = await page.evaluate(() => ({
        gallery: !document.getElementById('finalsGallery') && document.querySelectorAll('#photoGrid .photo-card').length === 6, hero: !document.getElementById('fgHero'), cp: !!document.getElementById('completionPage'),
        done: document.getElementById('deliveryDone')?.dataset.state,
        shares: document.querySelectorAll('#fgShare, #cpShare, .fg-share, [aria-label="分享這個相簿"]').length,
        shareText: [...document.querySelectorAll('button, a')].filter(b => /分享/.test(b.textContent)).map(b => b.textContent.trim()),
      }));
      ok('control: the delivered, unconfirmed page is up (the 6 cards, no web album, status block open), not the 完成頁', s.gallery && s.hero && !s.cp && s.done === 'open', JSON.stringify(s));
      ok('no share button of any kind, by id, class, label or text', s.shares === 0 && s.shareText.length === 0, JSON.stringify(s));
      return out;
    },
    { before: w.before, initScript: init, contextOptions: co });
}

// ── 2. the 完成頁's share: the link only, never the owner's key
const SHARE_URL = `${base}/index.html?t=TOK`;
const DIRTY = `${base}/index.html?t=TOK&k=ZOE-KEY&owner_key=ZOE-KEY&utm=x#h=ZOE-KEY`;
const shareInit = (mode, who = 'owner') => `
  ${who === 'owner' ? `localStorage.setItem('pick_key:TOK', 'ZOE-KEY'); sessionStorage.setItem('picker_key', 'ZOE-KEY'); localStorage.setItem('h', 'ZOE-KEY');` : ''}
  window.__shared = []; window.__copied = []; window.__exec = [];
  const def = (o, k, v) => Object.defineProperty(o, k, { value: v, configurable: true, writable: true });
  ${mode === 'share' ? `def(navigator, 'share', async d => { window.__shared.push(d); });` : ''}
  ${mode === 'cancel' ? `def(navigator, 'share', async d => { window.__shared.push(d); throw new DOMException('cancelled', 'AbortError'); });` : ''}
  ${mode === 'sharefail' ? `def(navigator, 'share', async d => { window.__shared.push(d); throw new DOMException('no', 'NotAllowedError'); });` : ''}
  ${['copy', 'sharefail'].includes(mode) ? `def(navigator, 'clipboard', { writeText: async t => { window.__copied.push(t); } });` : ''}
  ${mode === 'execcopy' ? `def(navigator, 'clipboard', { writeText: async () => { throw new Error('denied'); } }); document.execCommand = c => { window.__exec.push([c, document.activeElement && document.activeElement.value]); return true; };` : ''}
  ${mode === 'nocopy' ? `def(navigator, 'clipboard', { writeText: async () => { throw new Error('denied'); } }); document.execCommand = () => false;` : ''}
  ${['copy', 'execcopy', 'nocopy'].includes(mode) ? `def(navigator, 'share', undefined);` : ''}
`;
for (const [name, mode, who, expectKey] of [
  ['Web Share API (owner, a dirty URL with the key in it)', 'share', 'owner', true],
  ['no Web Share: copied to the clipboard + a toast (owner, dirty URL)', 'copy', 'owner', true],
  ['no clipboard permission: the textarea + execCommand fallback copies (owner, dirty URL)', 'execcopy', 'owner', true],
  ['a viewer (no key anywhere) shares the same clean link', 'share', 'viewer', false],
]) {
  const w = cpWorld();
  await suite(`completion page share — ${name}`,
    expectKey ? DIRTY : SHARE_URL,
    async page => {
      const out = [], ok = line(out);
      await cpReady(page);
      if (expectKey) {
        const leak = await page.evaluate(() => ({ href: location.href, store: localStorage.getItem('pick_key:TOK') }));
        ok('control: the page\'s own URL and storage DO carry the key (so a naive share would leak it)', leak.href.includes('ZOE-KEY') && leak.store === 'ZOE-KEY', JSON.stringify(leak));
      }
      await page.click('#cpShare');
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => ({ shared: window.__shared, copied: window.__copied, exec: window.__exec, toast: document.querySelector('.toast.success .toast-message')?.textContent || null, err: document.querySelector('.toast.error') !== null }));
      const sent = mode === 'share' ? r.shared[0]?.url : mode === 'copy' ? r.copied[0] : r.exec[0]?.[1];
      ok('the link that went out is exactly origin + path + ?t=<token>', sent === SHARE_URL, JSON.stringify(r));
      ok('nothing that went out carries the owner key, an extra query or a hash', !JSON.stringify(r).includes('ZOE-KEY') && !/owner_key|utm|#|[?&]k=/.test(sent || ''), JSON.stringify(r));
      if (mode === 'share') ok('the share sheet gets the project title and exactly one url', r.shared.length === 1 && r.shared[0].title === '婚禮精修' && r.copied.length === 0 && r.toast === null, JSON.stringify(r));
      if (mode === 'copy') ok('copied once, and the toast says 已複製連結', r.copied.length === 1 && r.toast === '已複製連結', JSON.stringify(r));
      if (mode === 'execcopy') ok('copy command ran once on the textarea holding the link, the toast says 已複製連結, no textarea left behind', r.exec.length === 1 && r.exec[0][0] === 'copy' && r.toast === '已複製連結' && (await page.$('textarea[data-fg-copy]')) === null, JSON.stringify(r));
      return out;
    },
    { before: w.before, initScript: shareInit(mode, who), contextOptions: who === 'owner' ? ALB_DESK : MOBILE });
}
{
  const w = cpWorld();
  await suite('completion page share — cancelling the share sheet is silent',
    SHARE_URL,
    async page => {
      const out = [], ok = line(out);
      await cpReady(page);
      await page.click('#cpShare');
      await page.waitForTimeout(250);
      const r = await page.evaluate(() => ({ shared: window.__shared.length, copied: window.__copied.length, toasts: document.querySelectorAll('.toast').length }));
      ok('AbortError (the guest closed the sheet): the sheet was asked once, nothing copied, no toast at all', r.shared === 1 && r.copied === 0 && r.toasts === 0, JSON.stringify(r));
      return out;
    },
    { before: w.before, initScript: shareInit('cancel'), contextOptions: ALB_DESK });
}
{
  const w = cpWorld();
  await suite('completion page share — a share sheet that fails (not a cancel) falls back to copying the same clean link',
    SHARE_URL,
    async page => {
      const out = [], ok = line(out);
      await cpReady(page);
      await page.click('#cpShare');
      await page.waitForSelector('.toast.success', { timeout: 3000 });
      const r = await page.evaluate(() => ({ shared: window.__shared.length, copied: window.__copied, toast: document.querySelector('.toast.success .toast-message')?.textContent }));
      ok('asked the sheet once, then copied the clean link and said so', r.shared === 1 && JSON.stringify(r.copied) === JSON.stringify([SHARE_URL]) && r.toast === '已複製連結', JSON.stringify(r));
      return out;
    },
    { before: w.before, initScript: shareInit('sharefail'), contextOptions: ALB_DESK });
}
{
  const w = cpWorld();
  await suite('completion page share — nothing can copy: a plain error toast, no crash',
    SHARE_URL,
    async page => {
      const out = [], ok = line(out);
      await cpReady(page);
      await page.click('#cpShare');
      await page.waitForSelector('.toast.error', { timeout: 3000 });
      ok('says 無法複製連結', (await page.textContent('.toast.error .toast-message')) === '無法複製連結');
      ok('no textarea left behind', (await page.$('textarea[data-fg-copy]')) === null);
      return out;
    },
    { before: w.before, initScript: shareInit('nocopy'), contextOptions: ALB_DESK });
}

}
