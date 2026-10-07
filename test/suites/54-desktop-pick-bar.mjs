// Desktop (>=1025px) guest pick page: the bottom bar is ONE compact pill that lives inside the
// 280px sidebar column (it used to be a 372px one-row pill that covered the first grid column).
// <=1024px must stay the full-width phone/tablet bar. Registered by test/run.mjs in file-name order.
import { base, suite } from '../lib/harness.mjs';
import { pickFakeWorker } from '../lib/pick-fake.mjs';

export default async function register() {
const PH = { 'A/': Array.from({ length: 40 }, (_, i) => ({ id: `A/a${String(i).padStart(2, '0')}.jpg`, name: `a${i}.jpg`, size: 9e6, rating: 0 })),
  'B/': [{ id: 'B/b0.jpg', name: 'b0.jpg', size: 9e6, rating: 0 }] };
const box = `(e => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; })`;
const PROPS = ['display', 'position', 'left', 'right', 'bottom', 'flexDirection', 'justifyContent', 'alignItems', 'padding', 'borderTopWidth', 'borderRadius', 'gap', 'width', 'flexGrow', 'marginLeft', 'fontSize', 'whiteSpace'];

for (const [w, h] of [[1100, 760], [1280, 800], [1500, 950], [1920, 1000]]) {
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['A/', 'B/'], photosByFolder: PH, pickLimit: 4, extraMax: 2, title: 't' });
  await suite(`desktop pick-bar ${w}px — one compact pill inside the sidebar column, never over a photo`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('.photo-card', { timeout: 5000 });
      await page.waitForSelector('#pickCounter', { timeout: 5000 });
      const measure = () => page.evaluate(`(() => {
        const box = ${box}; const q = s => document.querySelector(s);
        const bar = q('#mobileActionBar'), cnt = q('#pickCounter'), btn = q('#pickSubmitBtn');
        const sb = box(q('aside.sidebar')), b = box(bar);
        const cards = [...document.querySelectorAll('.photo-card')];
        return { bar: b, cnt: box(cnt), btn: box(btn), sb, nCards: cards.length, vw: innerWidth, vh: innerHeight,
          disp: getComputedStyle(bar).display, lines: Math.round(cnt.getBoundingClientRect().height / parseFloat(getComputedStyle(cnt).lineHeight)),
          overCards: cards.filter(c => { const x = c.getBoundingClientRect(); return x.left < b.r && x.right > b.l && x.top < b.b && x.bottom > b.t; }).length,
          sbPad: parseFloat(getComputedStyle(q('aside.sidebar')).paddingBottom),
          text: cnt.textContent };
      })()`);
      const r = await measure();
      ok('positive control: bar shown, 40 cards, counter text found', r.disp === 'flex' && r.nCards >= 30 && r.text.startsWith('已選 0 / 4 張'), JSON.stringify(r));
      ok('pill is inside the sidebar column (right edge < sidebar right)', r.bar.l >= 0 && r.bar.r < r.sb.r, `${r.bar.r} vs ${r.sb.r}`);
      ok('pill covers no photo card', r.overCards === 0, String(r.overCards));
      ok('compact: narrower than 280px, no empty gap (button fills the pill width)', r.bar.w <= 280 && r.btn.w >= r.bar.w - 40, JSON.stringify(r.bar));
      ok('counter and button inside the pill, counter above the button, one text line', r.cnt.b <= r.btn.t + 1 && r.cnt.l >= r.bar.l && r.cnt.r <= r.bar.r && r.btn.r <= r.bar.r && r.lines === 1, JSON.stringify([r.cnt, r.btn, r.lines]));
      ok('inside the viewport, bottom-left', r.bar.b <= r.vh && r.bar.l <= 16, JSON.stringify(r.bar));
      ok('the sidebar bottom padding keeps its last row clear of the pill', r.sbPad >= r.bar.h + 8, `${r.sbPad} vs ${r.bar.h}`);
      // over-cap text + draft status: pill stays the same width/height, still one line
      await page.evaluate(() => { const c = document.getElementById('pickCounter'); c.textContent = '已選 7 張（上限 6 張，需減 1 張）'; c.className = 'pick-counter over-cap';
        const s = document.getElementById('pickSaveStatus'); s.textContent = '儲存失敗，重試中…'; s.dataset.state = 'retry'; });
      const o = await measure();
      ok('over-cap + retry status: still inside the sidebar, one line, no card covered', o.bar.r < o.sb.r && o.lines === 1 && o.overCards === 0, JSON.stringify(o));
      ok('the status line does not make the pill jump (same height)', Math.abs(o.bar.h - r.bar.h) < 1 && Math.abs(o.bar.t - r.bar.t) < 1, `${o.bar.h} vs ${r.bar.h}`);
      ok('over-cap colour equals the --danger token (computed)', await page.evaluate(() => {
        const probe = document.createElement('i'); probe.style.color = 'var(--danger)'; document.body.append(probe);
        const danger = getComputedStyle(probe).color; probe.remove();
        const col = getComputedStyle(document.getElementById('pickCounter')).color;
        return danger !== '' && danger !== 'rgb(0, 0, 0)' && col === danger;
      }));
      ok('the button is clickable (hit-test)', await page.evaluate(() => { const b = document.getElementById('pickSubmitBtn').getBoundingClientRect(); return document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2)?.closest('#pickSubmitBtn') !== null; }));
      return out;
    }, { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: { viewport: { width: w, height: h } } });
}

// <=1024: the phone/tablet bar stays as it was.
for (const [w, h] of [[390, 844], [1024, 768]]) {
  const m = pickFakeWorker({ ownerName: 'Zoe', ownerKey: 'ZOE-KEY', folders: ['A/', 'B/'], photosByFolder: PH, pickLimit: 4, extraMax: 2, title: 't' });
  await suite(`desktop pick-bar ${w}px — phone/tablet bar computed styles unchanged`,
    `${base}/index.html?t=TOK`,
    async page => {
      const out = [];
      const ok = (n, c, d = '') => out.push(`${c ? 'ok  ' : 'FAIL'}  ${n}${c ? '' : `   [${d}]`}`);
      await page.waitForSelector('#pickCounter', { timeout: 5000 });
      const got = await page.evaluate(props => {
        const res = {};
        for (const [k, sel] of [['bar', '#mobileActionBar'], ['status', '#mobileActionStatus'], ['btn', '#pickSubmitBtn'], ['cnt', '#pickCounter']]) {
          const cs = getComputedStyle(document.querySelector(sel)); res[k] = {};
          for (const p of props) res[k][p] = cs[p];
        }
        const b = document.getElementById('mobileActionBar').getBoundingClientRect();
        res.rect = [b.left, b.right, b.width];
        res.contentPad = getComputedStyle(document.querySelector('.content')).paddingBottom;
        return res;
      }, PROPS);
      const g = got.bar;
      ok('positive control: bar found and shown', g.display === 'flex' && got.btn.display !== 'none');
      ok('full-width bar: fixed, left 0 / right 0, row, space-between', g.position === 'fixed' && g.left === '0px' && g.right === '0px' && g.flexDirection === 'row' && g.justifyContent === 'space-between' && g.bottom === '0px' && g.width === `${w}px`, JSON.stringify(g));
      ok('button keeps flex:1 and margin-left 15px; counter keeps 14px, no nowrap override', got.btn.flexGrow === '1' && got.btn.marginLeft === '15px' && got.cnt.fontSize === '14px' && got.cnt.whiteSpace === 'normal', JSON.stringify([got.btn, got.cnt]));
      ok('no pill border/radius on the phone bar', g.borderRadius === '0px' && g.gap === 'normal', JSON.stringify(g));
      return out;
    }, { before: m.attach, initScript: () => localStorage.setItem('pick_key:TOK', 'ZOE-KEY'), contextOptions: { viewport: { width: w, height: h } } });
}
}
