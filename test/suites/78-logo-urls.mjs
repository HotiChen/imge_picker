// Browser suites: where the studio logo comes from now that each photographer has his own. The guest page asks
// /api/pick/logo?t=<link token> (the link says whose logo); the settings preview fetches the caller's own
// /api/admin/settings/logo with the Authorization header and shows it from a blob URL. The public default-only
// /api/studio/logo is no longer used by either page. Registered by test/run.mjs in file-name order; see test/README.md.
import { base, suite } from '../lib/harness.mjs';
import { PIXEL } from '../lib/env.mjs';
import { dashSettingsMock, SEED_TOKEN } from '../lib/dashboard-mocks.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {
  const imgs = page => page.$$eval('#logo-preview-box img', es => es.map(e => ({ src: e.src, w: e.naturalWidth })));

  {
    const m = dashSettingsMock({ settings: { has_logo: true, logo_type: 'image/png' } });
    await suite('settings logo preview — fetched with the Authorization header, shown from a blob URL (never the public default logo)',
      `${base}/settings.html`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.waitForSelector('#logo-preview-box img', { timeout: 5000 });
        const first = await imgs(page);
        ok('a preview <img> is shown, from a blob: URL', first.length === 1 && first[0].src.startsWith('blob:'), JSON.stringify(first));
        await page.waitForFunction(() => document.querySelector('#logo-preview-box img')?.complete && document.querySelector('#logo-preview-box img').naturalWidth > 0);
        ok('and it really decoded (the bytes were an image)', true);
        const get = m.seen.filter(r => r.method === 'GET' && r.path === '/api/admin/settings/logo');
        ok('the logo was read from /api/admin/settings/logo with the Bearer token', get.length >= 1 && get.every(r => r.auth === 'Bearer adm'), JSON.stringify(get));
        ok('the public /api/studio/logo was never requested', !m.seen.some(r => r.path === '/api/studio/logo'));
        ok('the remove button is offered', await page.isVisible('#logo-remove-btn'));

        // remove, then upload again: the preview follows, always from a fresh authed read
        await page.click('#logo-remove-btn');
        await page.waitForFunction(() => document.getElementById('logo-preview-box').textContent.includes('尚未上傳'));
        ok('after 移除 the box says 尚未上傳 and holds no <img>', (await imgs(page)).length === 0);
        const before = m.seen.filter(r => r.path === '/api/admin/settings/logo' && r.method === 'GET').length;
        await page.setInputFiles('#logo-file-input', { name: 'l.png', mimeType: 'image/png', buffer: PIXEL });
        await page.waitForSelector('#logo-preview-box img', { timeout: 4000 });
        const after = m.seen.filter(r => r.path === '/api/admin/settings/logo' && r.method === 'GET').length;
        const second = await imgs(page);
        ok('after an upload the preview is read again from the Worker (a new blob)', after === before + 1 && second.length === 1 && second[0].src.startsWith('blob:') && second[0].src !== first[0].src, `${before}->${after} ${JSON.stringify(second)}`);
        ok('nothing ever asked for /api/studio/logo', !m.seen.some(r => r.path === '/api/studio/logo'));
        return out;
      },
      { before: m.attach, initScript: SEED_TOKEN });
  }

  {
    const m = dashSettingsMock({ settings: { has_logo: true } });
    // the Worker answers 404 when there is no logo bytes (imageResponse): the box must not stay on a broken image
    m.state.settings.has_logo = true;
    await suite('settings logo preview — a failed read says so instead of leaving a broken image',
      `${base}/settings.html`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.waitForFunction(() => document.getElementById('logo-preview-box').textContent.includes('預覽載入失敗'), null, { timeout: 5000 });
        ok('the box says 預覽載入失敗 and holds no <img>', (await imgs(page)).length === 0);
        return out;
      },
      { before: async page => {
        await m.attach(page);
        await page.route('**/api/admin/settings/logo', route => (route.request().method() === 'GET'
          ? route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Not found"}' }) : route.fallback()));
      }, initScript: SEED_TOKEN });
  }

  {
    const w = pickFakeWorker({ ownerName: 'Ann', ownerKey: 'ANN-KEY', studio: { name: '海邊影像工作室', has_logo: true } });
    const logoReqs = [];
    await suite('guest page logo — /api/pick/logo?t=<link>, no Authorization, never the public default logo',
      `${base}/index.html?t=PICK-TOKEN`,
      async page => {
        const out = [];
        const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
        await page.evaluate(() => localStorage.setItem('pick_key:PICK-TOKEN', 'ANN-KEY'));
        await page.reload({ waitUntil: 'load' });
        await page.waitForSelector('.logo-mark-img', { timeout: 5000 });
        const src = await page.$eval('.logo-mark-img', e => e.getAttribute('src'));
        ok('the header logo points at the link’s own logo route', src.endsWith('/api/pick/logo?t=PICK-TOKEN'), src);
        await page.waitForFunction(() => document.querySelector('.logo-mark-img')?.complete);
        ok('it was requested with the link token and without a photographer credential',
          logoReqs.length >= 1 && logoReqs.every(r => r.path === '/api/pick/logo' && r.t === 'PICK-TOKEN' && r.auth === null), JSON.stringify(logoReqs));
        ok('/api/studio/logo was never requested', !logoReqs.some(r => r.path === '/api/studio/logo'));
        return out;
      },
      { before: async page => {
        await w.attach(page);
        await page.route('**/imagepicker.hotichen.workers.dev/api/*/logo**', async route => {
          const u = new URL(route.request().url());
          logoReqs.push({ path: u.pathname, t: u.searchParams.get('t'), auth: (await route.request().allHeaders())['authorization'] ?? null });
          route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
        });
      } });
  }
}
