// Browser suites: the project page's ＋上傳毛片 is grayed out (not a link) once the project is in 精修, because proofs are
// no longer uploaded then (Tim 2026-10-18). Before 精修 it stays the link it always was.
// Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { ADMIN } from '../lib/auth-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';
import { PF_ROOT } from '../lib/project-helpers.mjs';

export default async function register() {

const line = out => (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
const world = phase => pickFakeWorker({ projectId: 'proj-new', title: PF_ROOT, phase, folders: [`${PF_ROOT}/毛片/`], pickFiles: [`${PF_ROOT}/毛片/IMG_1.jpg`] });
const btn = page => page.evaluate(() => {
  const e = document.getElementById('pd-upload-proofs-btn');
  if (!e) return null;
  const s = getComputedStyle(e);
  return { tag: e.tagName, href: e.getAttribute('href'), disabled: e.disabled === true ? 'true' : null, text: e.textContent.trim(), title: e.title,
    bg: s.backgroundColor, sibBg: document.getElementById('pd-upload-final-btn') ? getComputedStyle(document.getElementById('pd-upload-final-btn')).backgroundColor : null, cursor: s.cursor, shown: s.display !== 'none' };
});

{
  const m = world('retouching');
  await suite('project page — in 精修 the ＋上傳毛片 button is grayed out and goes nowhere',
    `${base}/admin.html#project=proj-new`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('#pd-upload-final-btn', { timeout: 5000 });
      const b = await btn(page);
      ok('control: the button is still there and says ＋上傳毛片 and why it is off', !!b && b.shown && b.text === '＋上傳毛片（已進入精修）', JSON.stringify(b));
      ok('it is not a link any more (no href)', !!b && b.href === null, JSON.stringify(b));
      ok('it is a disabled <button> (not focusable, announced as disabled)', !!b && b.tag === 'BUTTON' && b.disabled === 'true', JSON.stringify(b));
      ok('it looks grayed out (its own background, not-allowed cursor)', !!b && b.bg !== b.sibBg && b.cursor === 'not-allowed', JSON.stringify(b));
      const geo = await page.evaluate(() => { const r = document.getElementById('pd-upload-proofs-btn').getBoundingClientRect(), f = document.getElementById('pd-download-btn').getBoundingClientRect();
        return { w: r.width, dh: Math.abs(r.height - f.height), dTop: Math.abs(r.top - f.top) }; });
      ok('same height as its sibling button and on the same row (the row does not jump)', geo.w > 20 && geo.dh <= 2 && geo.dTop < 40, JSON.stringify(geo));
      const look = () => page.$eval('#pd-upload-proofs-btn', e => { const c = getComputedStyle(e); return [c.backgroundColor, c.borderTopColor, c.color, c.opacity].join('|'); });
      const rest = await look();
      await page.hover('#pd-upload-proofs-btn', { force: true });
      ok('hovering it changes nothing (a disabled button does not react)', (await look()) === rest, `${rest} -> ${await look()}`);
      ok('its title says why', !!b && b.title.includes('精修'), JSON.stringify(b));
      ok('＋上傳精修 is untouched: still a link', await page.$eval('#pd-upload-final-btn', e => !!e.getAttribute('href')));
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

{
  const m = world('picking');
  await suite('project page — before 精修 the ＋上傳毛片 button is the link it always was',
    `${base}/admin.html#project=proj-new`,
    async page => {
      const out = [], ok = line(out);
      await page.waitForSelector('#pd-upload-proofs-btn', { timeout: 5000 });
      const b = await btn(page);
      ok('it is a link to upload.html locked on 毛片', !!b && b.tag === 'A' && /^upload\.html\?/.test(b.href || '') && b.disabled === null && b.cursor !== 'not-allowed', JSON.stringify(b));
      const u = new URL(b.href, base);
      ok('it names this project and the 毛片 folder, locked', u.searchParams.get('project') === 'proj-new' && u.searchParams.get('folder') === `${PF_ROOT}/毛片/` && u.searchParams.get('lock') === '1', b.href);
      await page.goto(u.href, { waitUntil: 'load' });
      ok('following it lands on the upload page locked on 毛片',
        (await page.$eval('#targetDisplay', e => e.textContent)) === `${PF_ROOT}/毛片/` && (await page.$eval('#targetBar', e => e.dataset.locked)) === '1');
      return out;
    },
    { before: m.attach, initScript: ADMIN });
}

}
