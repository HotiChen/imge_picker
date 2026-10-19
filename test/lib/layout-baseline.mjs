// Comparing a page's layout with a recorded baseline when part of it is set in the machine's fallback fonts.
//
// The pages ask Google Fonts for IBM Plex Sans / Mono; the harness has no network for it (sandbox, offline), so text is
// set in whatever fallback fonts the machine has (Inter / WenQuanYi / Noto Color Emoji here, others elsewhere). A box
// whose size comes from its text (a button's width, a line's height) and every box placed after it then differs by a
// px or more from a baseline recorded on another machine, although no CSS changed (suites 50 and 51 failed that way).
//
// So each measured value is classified ON THIS MACHINE: the page is measured once more with the text metrics pushed
// (letter-spacing and line-height forced); a value that moves under that push depends on text metrics and is compared
// with ±tol px, every other value (declared styles, fixed sizes, positions that do not follow text) stays exact.
const PUSH = '* { letter-spacing: 0.37px !important; line-height: 2.3 !important; }';
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

// measure() twice: as the page is, and with the text metrics pushed (the push is removed again afterwards)
export async function measureWithTextPush(page, measure) {
  const now = await measure();
  const tag = await page.addStyleTag({ content: PUSH });
  await settle(page);
  const pushed = await measure();
  await tag.evaluate(e => e.remove());
  await settle(page);
  return { now, pushed };
}

// numbers inside a value ("74.75px", "18px 846.9px", [258,101,994,38], 12) and the text around them
const parts = v => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return { nums: (s.match(/-?\d+(\.\d+)?/g) || []).map(Number), shape: s.replace(/-?\d+(\.\d+)?/g, '#') };
};
// equal, or (when textDependent) the same shape with every number within ±tol
export function closeEnough(a, b, textDependent, tol) {
  if (JSON.stringify(a) === JSON.stringify(b)) return true;
  if (!textDependent) return false;
  const pa = parts(a), pb = parts(b);
  return pa.shape === pb.shape && pa.nums.length === pb.nums.length && pa.nums.every((n, i) => Math.abs(n - pb.nums[i]) <= tol);
}

// baseline / now / pushed: { key: { field: value } }. Returns { compared, loose, bad: [...] }; `loose` counts the
// values that were compared with the tolerance (text-dependent on this machine).
export function compareToBaseline(baseline, now, pushed, tol, skip = () => false) {
  const bad = [];
  let compared = 0, loose = 0;
  for (const k of Object.keys(baseline)) {
    for (const f of Object.keys(baseline[k])) {
      if (skip(k, f)) continue;
      compared++;
      const a = now[k] && now[k][f], p = pushed[k] && pushed[k][f];
      const dep = JSON.stringify(a) !== JSON.stringify(p);
      if (dep) loose++;
      if (!closeEnough(a, baseline[k][f], dep, tol)) bad.push(`${k} ${f}: ${JSON.stringify(baseline[k][f])} -> ${JSON.stringify(a)}${dep ? ` (text-dependent, ±${tol})` : ' (exact)'}`);
    }
  }
  return { compared, loose, bad };
}
