// Waiting for the guest tour (js/guest-tour.js) to settle before measuring its ring and card (suites 47, 52).
//
// Opening the lightbox runs its slideUp (300ms, translateY 24px). The tour places the ring at the click (mid-slide)
// and again on its next 300ms tick, and the ring glides there (.18s transition in css/guest-tour.css), so the ring
// reaches the real arrows only ~450ms after the click, later under load. A fixed ~300ms sleep measured the ring
// mid-glide (step 3/7 failed at 390px and 1500px). Settled = no finite animation or transition running on the ring,
// the card or the lightbox, twice in a row one placement tick (320ms) apart. Infinite animations (spinners) are
// ignored, so a page with nothing moving (no card at all included) settles in ~320ms, the old fixed sleep. Gives up
// after `ms` and returns false, like suite 52's earlier until(…, 4000): the caller measures anyway and its assertion
// reports what it saw.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const quiet = page => page.evaluate(() => document.getAnimations().every(a => {
  const t = a.effect && a.effect.target;
  if (!t || !t.closest || !t.closest('.gt-ring, .gt-card, #photoModal')) return true;
  return a.effect.getComputedTiming().iterations === Infinity || a.playState !== 'running';
}));
export async function tourSettled(page, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await quiet(page)) { await sleep(320); if (await quiet(page)) return true; } else await sleep(40);
  }
  return false;
}
