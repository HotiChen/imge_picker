// The photo viewers (the enlarged photo, the finals lightbox) must sit inside the part of the page the guest can actually
// see. On iOS Chrome and in LINE the browser's top and bottom bars come and go, and the layout viewport (what position:
// fixed and 100dvh follow) does not always move with them: the ✕ ended up under the top bar and the footer under the
// bottom one. visualViewport is the visible area; this mirrors it into --vv-top / --vv-h, which css/styles.css reads
// with the old 0 / 100dvh as fallback. While the page itself is pinch-zoomed (scale > 1) the visible area is a small
// window onto a zoomed page, so the last values are kept.
(function () {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  function sync() {
    if (vv.scale > 1.01) return;
    root.style.setProperty('--vv-top', `${vv.offsetTop}px`);
    root.style.setProperty('--vv-h', `${vv.height}px`);
  }
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  sync();
})();
