// Draws the spread template library, and what planSpreads makes of sample photo sets, as PNGs.
//
//   NODE_PATH=/opt/node-tools/node_modules node book_editor/test/render-templates.mjs [outDir]
//
// Needs Playwright's chromium (the same install test/run.mjs uses). Writes into outDir
// (default: ./template-shots):
//   templates.png        every template: coloured boxes (one hue per slot), the slot numbers in reading
//                        order, the fold, id, name, photo count, tags, facing
//   plan-40.png          planSpreads on 40 mixed portrait / landscape photos with repeats: the cover and every spread
//   plan-1.png ... plan-5.png   the small cases (1, 2, 3 and 5 photos)
// It only reads book_editor/js and writes the PNGs; nothing is served and nothing is stored.
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const js = f => fs.readFileSync(path.join(dir, '..', 'js', f), 'utf8');
const outDir = path.resolve(process.argv[2] || 'template-shots');
fs.mkdirSync(outDir, { recursive: true });

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* try the global one */ }
  const root = (await import('node:child_process')).execSync('npm root -g', { encoding: 'utf8' }).trim();
  return import(path.join(root, 'playwright', 'index.mjs'));
}

// ── the engine, loaded like a page loads it ────────────────────────────────
vm.runInThisContext(js('layouts.js'), { filename: 'layouts.js' });
vm.runInThisContext(js('spread_templates.js'), { filename: 'spread_templates.js' });
vm.runInThisContext(js('auto_layout.js'), { filename: 'auto_layout.js' });
const AutoLayout = vm.runInThisContext('AutoLayout');
const ST = vm.runInThisContext('SpreadTemplates');

// ── synthetic photos (what analyze() would return) ─────────────────────────
const HEX = '0123456789abcdef';
const hashOf = n => { let s = (n + 1) * 2654435761 >>> 0, h = ''; for (let i = 0; i < 16; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; h += HEX[s >>> 28]; } return h; };
const orientationOf = a => (Math.abs(a - 1) <= 0.05 ? 'square' : a > 1 ? 'landscape' : 'portrait');
function makePhotos(n, { seed = 5, dup = [] } = {}) {
  let s = seed * 7919;
  const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const pool = [1.5, 1.5, 1.5, 1.333, 0.667, 0.667, 0.8, 1.0, 1.778, 0.5625, 2.4, 0.667];
  const items = [];
  for (let i = 0; i < n; i++) {
    const aspect = pool[Math.floor(rnd() * pool.length)];
    items.push({ id: `IMG_${String(i + 1).padStart(3, '0')}.jpg`, ok: true, aspect, orientation: orientationOf(aspect),
      hash: hashOf(seed * 1000 + i), sharpness: Math.floor(rnd() * 100), focus: { x: 0.25 + rnd() * 0.5, y: 0.25 + rnd() * 0.5 } });
  }
  for (const [i, of] of dup) { items[i].hash = items[of].hash; items[i].aspect = items[of].aspect; items[i].orientation = items[of].orientation; }
  return items;
}

// ── the page that draws ────────────────────────────────────────────────────
const CSS = `
  body { margin: 0; background: #1b1a18; color: #eee; font: 13px/1.35 -apple-system, "Noto Sans CJK TC", "Microsoft JhengHei", sans-serif; }
  h1 { margin: 0; padding: 14px 18px 4px; font-size: 18px; }
  p.sub { margin: 0; padding: 0 18px 12px; color: #aaa; }
  .grid { display: grid; grid-template-columns: repeat(var(--cols), 1fr); gap: 14px; padding: 0 18px 18px; }
  .card { background: #262421; padding: 8px; border-radius: 6px; }
  .cap { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 5px; font-size: 12px; }
  .cap b { color: #fff; } .cap .tags { color: #9ab; } .cap .id { color: #e8c; font-family: monospace; }
  .spread { position: relative; width: 100%; aspect-ratio: 420 / 297; background: #fff; overflow: hidden; }
  .cover { position: relative; width: 100%; aspect-ratio: 210 / 297; background: #fff; overflow: hidden; }
  .spread::after { content: ''; position: absolute; top: 0; bottom: 0; left: 50%; width: 5%; transform: translateX(-50%); pointer-events: none; z-index: 3;
    background: linear-gradient(90deg, rgba(0,0,0,0), rgba(0,0,0,.14) 44%, rgba(0,0,0,.22) 50%, rgba(0,0,0,.14) 56%, rgba(0,0,0,0)); }
  .slot { position: absolute; overflow: hidden; }
  .slot.tpl { display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; font-size: 20px; text-shadow: 0 1px 2px #000; }
  .slot.tpl small { position: absolute; left: 3px; bottom: 2px; font-size: 9px; font-weight: 400; opacity: .9; }
  .crop { position: absolute; inset: 0; overflow: hidden; }
  .crop img { position: absolute; max-width: none; }
  .fold { position: absolute; left: 50%; top: 0; bottom: 0; border-left: 1px dashed rgba(0,0,0,.35); z-index: 2; }
  .tag-hero { outline: 2px solid #e8c; }
`;
const PAGE = (title, sub, cols, body) => `<!doctype html><meta charset="utf-8"><style>${CSS}</style><body style="--cols:${cols}"><h1>${title}</h1><p class="sub">${sub}</p><div class="grid">${body}</div>`;
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function templateCard(t) {
  const f = ST.facing(t);
  const boxes = t.slots.map((s, i) => {
    const hue = (i * 47 + 200) % 360;
    const a = ((s.w * 420) / (s.h * 297)).toFixed(2);
    return `<div class="slot tpl" style="left:${s.x * 100}%;top:${s.y * 100}%;width:${s.w * 100}%;height:${s.h * 100}%;background:hsl(${hue},55%,${s.face === 'span' ? 38 : 45}%)">${i + 1}<small>${s.face[0].toUpperCase()} ${a}</small></div>`;
  }).join('');
  return `<div class="card"><div class="cap"><span><span class="id">${esc(t.id)}</span> <b>${esc(t.name)}</b></span><span>${t.slots.length} 張 (L${f.left}/R${f.right}${f.span ? '/S' + f.span : ''})</span></div>`
    + `<div class="spread${t.tags.includes('hero') ? ' tag-hero' : ''}">${boxes}<div class="fold"></div></div><div class="cap"><span class="tags">${esc(t.tags.join(' · '))}</span><span>margin ${t.margin ?? '-'} / gutter ${t.gutter ?? '-'} mm</span></div></div>`;
}

// a photo drawn as a recognisable picture: its own hue, a number, a marker where its subject (focus) is
const photoSvg = (p, n) => {
  const w = 600, h = Math.max(100, Math.round(600 / p.aspect));
  const hue = (n * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},60%,35%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},60%,58%)"/></linearGradient></defs>`
    + `<rect width="${w}" height="${h}" fill="url(#g)"/><circle cx="${p.focus.x * w}" cy="${p.focus.y * h}" r="${Math.min(w, h) * 0.12}" fill="none" stroke="#fff" stroke-width="6"/>`
    + `<text x="${w / 2}" y="${h * 0.62}" font-size="${Math.round(Math.min(w, h) * 0.36)}" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff" stroke="#000" stroke-width="3">${n}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};
function planCards(plan, items) {
  const byId = new Map(items.map(p => [p.id, p]));
  const num = id => items.findIndex(p => p.id === id) + 1;
  const slotHtml = (s, kind) => {
    const p = byId.get(s.photoId), sd = s.slot;
    // fit: 'contain' (the default): the whole photo, centred (the viewer's drawing); no fit key = cover, drawn with fitCoverImage
    if (s.fit === 'contain') return `<div class="slot" style="left:${sd.x * 100}%;top:${sd.y * 100}%;width:${sd.w * 100}%;height:${sd.h * 100}%"><div class="crop"><img data-keep="1" style="inset:0;width:100%;height:100%;object-fit:contain;box-shadow:0 0 0 1px rgba(0,0,0,.14)" src="${photoSvg(p, num(s.photoId))}"></div></div>`;
    return `<div class="slot" style="left:${sd.x * 100}%;top:${sd.y * 100}%;width:${sd.w * 100}%;height:${sd.h * 100}%"><div class="crop"><img data-scale="${s.crop.scale}" data-cropx="${s.crop.x}" data-cropy="${s.crop.y}" data-rot="0" src="${photoSvg(p, num(s.photoId))}" onload="fitCoverImage(this)"></div></div>`;
  };
  const cards = [];
  if (plan.cover) {
    const one = { photoId: plan.cover.photoId, crop: plan.cover.crop, fit: plan.cover.fit, slot: { x: 0, y: 0, w: 1, h: 1 } };
    cards.push(`<div class="card"><div class="cap"><span><b>封面</b> #${num(plan.cover.photoId)}</span><span>A4 單頁 210×297</span></div><div class="cover">${slotHtml(one)}</div></div>`);
  }
  plan.spreads.forEach((sp, i) => {
    const t = ST.byId(sp.template);
    cards.push(`<div class="card"><div class="cap"><span><b>${i + 1}</b> <span class="id">${esc(sp.template)}</span></span><span>${sp.slots.length} 張 ${esc(t.tags.join('·'))}</span></div><div class="spread${t.tags.includes('hero') ? ' tag-hero' : ''}">${sp.slots.map(s => slotHtml(s)).join('')}</div></div>`);
  });
  if (plan.back) cards.push(`<div class="card"><div class="cap"><span><b>封底</b></span><span>空白</span></div><div class="cover"></div></div>`);
  return cards.join('');
}

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1800, height: 900 } });
const layoutsSrc = js('layouts.js');
const shoot = async (name, html, width = 1800) => {
  await page.setViewportSize({ width, height: 900 });
  await page.setContent(html, { waitUntil: 'load' });
  await page.addScriptTag({ content: layoutsSrc });
  await page.evaluate(() => Promise.all([...document.images].map(i => (i.complete ? 0 : new Promise(r => { i.onload = i.onerror = r; })))));
  await page.evaluate(() => document.querySelectorAll('img').forEach(i => !i.dataset.keep && typeof fitCoverImage === 'function' && fitCoverImage(i)));
  await page.screenshot({ path: path.join(outDir, name), fullPage: true });
  console.log('wrote', path.join(outDir, name));
};

// 1. the library
await shoot('templates.png', PAGE(`版型庫 — ${ST.TEMPLATES.length} 種跨頁版型（420×297mm，左右各 A4 直式）`,
  '每格一種顏色，編號是閱讀順序；虛線是摺線；粉紅外框 = hero（唯一可跨摺線）；格內小字：L/R/S = 左頁/右頁/跨頁，數字 = 格子長寬比。',
  4, ST.TEMPLATES.map(templateCard).join('')));

// 2. what the planner makes
const sets = {
  'plan-40.png': { n: 40, label: '40 張直橫混合（含 4 張重複）', dup: [[4, 3], [11, 10], [20, 19], [31, 30]] },
  'plan-5.png': { n: 5, label: '5 張' },
  'plan-3.png': { n: 3, label: '3 張（封面 + 一個跨頁，封面不重複）' },
  'plan-2.png': { n: 2, label: '2 張（封面 + 一個通頁）' },
  'plan-1.png': { n: 1, label: '1 張（只有封面）' },
};
for (const [file, c] of Object.entries(sets)) {
  const items = makePhotos(c.n, { dup: c.dup || [] });
  const plan = AutoLayout.planSpreads(items, { back: c.n >= 20, foldSafe: false });
  const dups = plan.dropped.filter(d => d.reason === 'duplicate').map(d => `#${items.findIndex(p => p.id === d.id) + 1}`);
  await shoot(file, PAGE(`planSpreads — ${c.label}`,
    `封面 + ${plan.spreads.length} 個跨頁${dups.length ? `；略過重複：${dups.join(' ')}` : ''}。圖上的數字是檔名順序，白圈是主體焦點（裁切會把它拉向格子中央）。`,
    c.n >= 20 ? 4 : 3, planCards(plan, items)), c.n >= 20 ? 1800 : 1300);
}
await browser.close();
