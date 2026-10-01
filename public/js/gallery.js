(function () {
  'use strict';
  // Gallery views (Teams-style, roadmap 2.9), used by the call panel (group-calls.js) and the meeting
  // page (meet-room.js): Gallery shows up to 9 people, Large gallery up to 49 (7×7). Tiles are laid out
  // to be as large as fits — the column count that gives the biggest 16:9 tiles without scrolling (or,
  // where the height isn't fixed, a square-ish grid no narrower than a readable tile). People with their camera on come first, and whoever
  // is talking is swapped into view if they'd be left out; anyone beyond the limit is behind a "+N"
  // tile (which opens Large gallery) — still playing (sound), and at simulcast's smallest size.
  //
  //   grid         the element holding the tiles
  //   tiles()      the tiles to lay out (not your own floating self-view)
  //   active()     whether the gallery is showing (not a shared screen, pin, Together mode, …)
  //   fixedHeight()  whether the grid's height is fixed (maximized / full screen), so rows must fit it
  //   tileHeight(w)  a tile's height for width w (default 16:9)
  const CAPS = { gallery: 9, large: 49 };
  const KEY = 'nc.galleryView';

  window.createGallery = function ({ grid, tiles, active, fixedHeight = () => false, minTile = 150, fillFrame = false, tileHeight = w => w * 9 / 16, onViewChange = () => {} }) {
    let view = (() => { try { return localStorage.getItem(KEY) === 'large' ? 'large' : 'gallery'; } catch { return 'gallery'; } })();
    let more = null, signature = '', scheduled = 0;

    function clear() {
      grid.style.gridTemplateColumns = grid.style.gridAutoRows = grid.style.justifyContent = grid.style.alignContent = '';
      for (const t of grid.children) { t.style.order = ''; t.style.width = ''; t.classList.remove('nc-tile-overflow'); }
      more?.remove(); more = null; signature = '';
    }
    const videoOn = t => (t.classList.contains('nc-has-video') || t.classList.contains('has-video')) && !t.classList.contains('nc-camera-off') && !t.classList.contains('camera-off');
    const speaking = t => t.classList.contains('nc-speaking');

    function apply() {
      scheduled = 0;
      if (!active()) { if (signature) clear(); return; }
      const list = tiles();
      // client dimensions are CSS pixels; bounding rectangles include the panel zoom.
      const box = { width: grid.clientWidth, height: grid.clientHeight };
      const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
      const key = [view, Math.round(box.width), fixedHeight() ? Math.round(box.height) : 0, ...list.map(t => t.dataset.peerId + (videoOn(t) ? 'v' : '') + (speaking(t) ? 's' : ''))].join('|');
      if (key === signature) return;
      signature = key;
      // Who is visible: cameras on first (keeping everyone's order otherwise), the speaker kept in view.
      const cap = CAPS[view];
      const order = list.map((t, i) => ({ t, i })).sort((a, b) => (videoOn(b.t) - videoOn(a.t)) || a.i - b.i).map(x => x.t);
      const overflow = order.length > cap;
      const shown = overflow ? cap - 1 : order.length;           // one slot for the "+N" tile
      const talker = order.findIndex(speaking);
      if (overflow && talker >= shown) { const [s] = order.splice(talker, 1); order.splice(shown - 1, 0, s); }
      order.forEach((t, i) => { t.style.order = String(i); t.classList.toggle('nc-tile-overflow', i >= shown); });
      if (overflow) {
        if (!more) {
          more = document.createElement('button'); more.type = 'button'; more.className = 'nc-gallery-more';
          more.addEventListener('click', () => setView('large'));
        }
        const hidden = order.length - shown;
        more.textContent = '+' + hidden;
        more.title = hidden + ' more ' + (hidden === 1 ? 'person' : 'people') + (view === 'gallery' ? ': show Large gallery' : '');
        more.setAttribute('aria-label', more.title);
        more.style.order = String(shown);
        if (more.parentNode !== grid) grid.appendChild(more);
      } else { more?.remove(); more = null; }
      // Size: the column count giving the largest tiles (fitting the height when it's fixed).
      const n = shown + (overflow ? 1 : 0), W = box.width, H = box.height;
      let cols = 1, w = 0;
      if (fixedHeight() && H > 0) {
        for (let c = 1; c <= n; c++) {
          const rows = Math.ceil(n / c);
          const cw = Math.min((W - gap * (c - 1)) / c, tileWidthFor((H - gap * (rows - 1)) / rows));
          if (cw > w + 0.5) { w = cw; cols = c; }
        }
      } else {
        // Height grows with the rows: a square-ish grid, no narrower than a readable tile.
        cols = Math.max(1, Math.min(Math.ceil(Math.sqrt(n)), Math.floor((W + gap) / (minTile + gap)) || 1));
        w = (W - gap * (cols - 1)) / cols;
      }
      w = Math.floor(Math.max(minTile * 0.6, w));
      grid.style.gridTemplateColumns = fillFrame ? 'repeat(' + cols + ', minmax(0, 1fr))' : 'repeat(' + cols + ', ' + w + 'px)';
      grid.style.gridAutoRows = fixedHeight() ? (fillFrame ? 'minmax(0, 1fr)' : Math.floor(tileHeight(w)) + 'px') : '';
      grid.style.justifyContent = 'center'; grid.style.alignContent = 'center';
    }
    // The widest tile whose height (tileHeight) fits h.
    function tileWidthFor(h) { let lo = 0, hi = 4000; for (let i = 0; i < 20; i++) { const mid = (lo + hi) / 2; if (tileHeight(mid) <= h) lo = mid; else hi = mid; } return lo; }

    const schedule = () => { if (!scheduled) scheduled = requestAnimationFrame(apply); };
    new MutationObserver(schedule).observe(grid, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    if (typeof ResizeObserver === 'function') new ResizeObserver(schedule).observe(grid);

    function setView(next) {
      view = next === 'large' ? 'large' : 'gallery';
      try { localStorage.setItem(KEY, view); } catch { /* not remembered */ }
      signature = ''; schedule(); onViewChange(view);
    }
    return {
      get view() { return view; },
      setView,
      toggle() { setView(view === 'large' ? 'gallery' : 'large'); },
      refresh() { signature = ''; schedule(); },
      clear,
    };
  };
})();
