// Shared constants and touch/canvas helpers used by many suites: the 1x1 PIXEL, the phone context,
// synthetic and CDP touch gestures, the 1600x1067 gradient photo and the in-page canvas probes.
// Plain constants and helpers only: nothing here needs the browser or the server.
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

// the repository root (with a trailing slash), whatever file imports this
export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

// Mobile task: a phone-shaped context — real Touch/TouchEvent construction
// needs hasTouch, and DPR3 is what makes the responsive-width formula ask
// for something other than the desktop bucket.
export const MOBILE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 };

// Dispatches real TouchEvents on `selector` inside the page — Playwright has
// no built-in swipe/pinch, so gestures are driven with synthetic touches
// exactly as the task calls for. `sequence` is [{type, points: [{x,y,id}]}].
export async function touchSequence(page, selector, sequence) {
  await page.evaluate(({ selector, sequence }) => {
    const el = document.querySelector(selector);
    if (!el) throw new Error('touch target not found: ' + selector);
    for (const step of sequence) {
      const touches = (step.points || []).map(p => new Touch({
        identifier: p.id ?? 0, target: el, clientX: p.x, clientY: p.y, pageX: p.x, pageY: p.y,
      }));
      const ev = new TouchEvent(step.type, {
        touches: step.type === 'touchend' ? [] : touches,
        targetTouches: step.type === 'touchend' ? [] : touches,
        changedTouches: touches,
        bubbles: true, cancelable: true,
      });
      el.dispatchEvent(ev);
    }
  }, { selector, sequence });
}

// One-finger swipe from (x1,y1) to (x2,y2).
export async function swipeTouch(page, selector, x1, y1, x2, y2, steps = 6) {
  const seq = [{ type: 'touchstart', points: [{ x: x1, y: y1 }] }];
  for (let i = 1; i <= steps; i++) {
    seq.push({ type: 'touchmove', points: [{ x: x1 + (x2 - x1) * i / steps, y: y1 + (y2 - y1) * i / steps }] });
  }
  seq.push({ type: 'touchend', points: [{ x: x2, y: y2 }] });
  await touchSequence(page, selector, seq);
}

export async function tapTouch(page, selector, x, y) {
  await touchSequence(page, selector, [
    { type: 'touchstart', points: [{ x, y }] },
    { type: 'touchend', points: [{ x, y }] },
  ]);
}

export async function doubleTapTouch(page, selector, x, y, gapMs = 100) {
  await tapTouch(page, selector, x, y);
  await page.waitForTimeout(gapMs);
  await tapTouch(page, selector, x, y);
}

// Two-finger pinch, centred on (cx,cy), from startDist to endDist apart.
export async function pinchTouch(page, selector, cx, cy, startDist, endDist, steps = 6) {
  const half0 = startDist / 2;
  const seq = [{ type: 'touchstart', points: [{ x: cx - half0, y: cy, id: 0 }, { x: cx + half0, y: cy, id: 1 }] }];
  for (let i = 1; i <= steps; i++) {
    const half = (startDist + (endDist - startDist) * i / steps) / 2;
    seq.push({ type: 'touchmove', points: [{ x: cx - half, y: cy, id: 0 }, { x: cx + half, y: cy, id: 1 }] });
  }
  seq.push({ type: 'touchend', points: [] });
  await touchSequence(page, selector, seq);
}

// Real touch input through CDP (Input.dispatchTouchEvent): the browser hit-
// tests every point, so a finger lands on whatever is really there — unlike
// touchSequence above, which dispatches straight to one element.
export async function realTouch(page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type, pts) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i })) });
  const t = {
    async tap(x, y) { await send('touchStart', [{ x, y }]); await send('touchEnd', []); },
    async doubleTap(x, y, gapMs = 120) {
      await t.tap(x, y); await page.waitForTimeout(gapMs); await t.tap(x + 2, y + 1);
    },
    async drag(x1, y1, x2, y2, steps = 8) {
      await send('touchStart', [{ x: x1, y: y1 }]);
      for (let i = 1; i <= steps; i++) {
        await send('touchMove', [{ x: x1 + (x2 - x1) * i / steps, y: y1 + (y2 - y1) * i / steps }]);
      }
      await send('touchEnd', []);
    },
    async pinch(cx, cy, d0, d1, steps = 8) {
      const pts = d => [{ x: cx - d / 2, y: cy, id: 0 }, { x: cx + d / 2, y: cy, id: 1 }];
      await send('touchStart', pts(d0));
      for (let i = 1; i <= steps; i++) await send('touchMove', pts(d0 + (d1 - d0) * i / steps));
      await send('touchEnd', []);
    },
  };
  return t;
}

// A realistically sized landscape photo (1600x1067, like a real preview) —
// the 1x1 PIXEL hides every layout bug. A colour gradient, so a canvas pixel
// says which point of the photo is drawn there: R grows left→right, G grows
// top→bottom, B is a constant 60. Pure blue (annotation colour below) never
// occurs in it. Minimal dependency-free PNG encoder (RGB, filter 0).
export const BIG_W = 1600, BIG_H = 1067;
export const BIG_PHOTO = (() => {
  const { deflateSync, crc32 } = zlib;
  const raw = Buffer.alloc((BIG_W * 3 + 1) * BIG_H);
  for (let y = 0; y < BIG_H; y++) {
    const row = y * (BIG_W * 3 + 1);
    const g = Math.round(y * 255 / (BIG_H - 1));
    for (let x = 0; x < BIG_W; x++) {
      const o = row + 1 + x * 3;
      raw[o] = Math.round(x * 255 / (BIG_W - 1)); raw[o + 1] = g; raw[o + 2] = 60;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(BIG_W, 0); ihdr.writeUInt32BE(BIG_H, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
})();

// In-page: the preview canvas's pixel at screen point (x, y), or null when
// the point isn't on the canvas at all.
export const CANVAS_PX = ([x, y]) => {
  const c = document.getElementById('photoCanvas');
  const r = c.getBoundingClientRect();
  if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) return null;
  const d = c.getContext('2d').getImageData(Math.floor((x - r.left) * c.width / r.width),
    Math.floor((y - r.top) * c.height / r.height), 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
};

// In-page: where the photo sat on screen before the canvas filled its
// container — the old fitted rect, computed from first principles: scaled by
// min(container/photo, 1), the canvas bitmap truncated to whole pixels, and
// flex-centred inside .canvas-container's content box.
export const OLD_FIT_RECT = ([iw, ih]) => {
  const box = document.querySelector('.canvas-container');
  const cr = box.getBoundingClientRect();
  const cs = getComputedStyle(box);
  const left = cr.left + parseFloat(cs.borderLeftWidth), top = cr.top + parseFloat(cs.borderTopWidth);
  const cw = box.clientWidth, ch = box.clientHeight;
  const s = Math.min(cw / iw, ch / ih, 1);
  const w = Math.floor(iw * s), h = Math.floor(ih * s);
  return { left: left + (cw - w) / 2, top: top + (ch - h) / 2, w, h, s };
};
