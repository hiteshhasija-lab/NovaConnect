// A GIF search popover backed by /api/gifs/* (Giphy, proxied server-side). Mirrors
// emoji-picker.js's shape (open(anchorEl)/close()) so it wires into the composer the same way.
window.createGifPicker = function (api, onPick) {
  let panel = null, outsideHandler = null, keyHandler = null, currentAnchor = null;

  function close() {
    if (!panel) return;
    panel.remove();
    panel = null;
    document.removeEventListener('pointerdown', outsideHandler);
    document.removeEventListener('keydown', keyHandler);
  }

  function renderGifs(grid, gifs) {
    grid.replaceChildren();
    if (!gifs.length) { grid.innerHTML = '<p class="emoji-picker-empty">No GIFs found.</p>'; return; }
    gifs.forEach(g => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'gif-picker-item'; b.title = g.title;
      b.innerHTML = '<img src="' + g.preview + '" alt="' + g.title.replace(/"/g, '&quot;') + '" loading="lazy">';
      b.onclick = () => { onPick(g.url); close(); };
      grid.appendChild(b);
    });
  }

  function open(anchorEl) {
    if (panel) { const same = currentAnchor === anchorEl; close(); if (same) return; }
    currentAnchor = anchorEl;
    panel = document.createElement('div');
    panel.className = 'emoji-picker-popover gif-picker-popover';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Search GIFs');
    panel.innerHTML =
      '<input type="search" class="emoji-picker-search" placeholder="Search GIFs" aria-label="Search GIFs">' +
      '<div class="gif-picker-grid"></div>';
    document.body.appendChild(panel);

    const grid = panel.querySelector('.gif-picker-grid');
    const search = panel.querySelector('.emoji-picker-search');
    let generation = 0;

    function load(url) {
      const gen = ++generation;
      grid.innerHTML = '<p class="emoji-picker-empty">Loading…</p>';
      api(url).then(data => {
        if (gen !== generation) return;
        if (!data.configured) { grid.innerHTML = '<p class="emoji-picker-empty">GIF search isn\'t set up yet — ask your admin to add a GIPHY_API_KEY.</p>'; return; }
        renderGifs(grid, data.gifs);
      }).catch(() => { if (gen === generation) grid.innerHTML = '<p class="emoji-picker-empty">Could not load GIFs.</p>'; });
    }
    load('/api/gifs/trending');

    let searchTimer;
    search.oninput = () => {
      clearTimeout(searchTimer);
      const q = search.value.trim();
      searchTimer = setTimeout(() => load(q ? '/api/gifs/search?q=' + encodeURIComponent(q) : '/api/gifs/trending'), 300);
    };

    const rect = anchorEl.getBoundingClientRect();
    panel.style.visibility = 'hidden';
    requestAnimationFrame(() => {
      const pw = panel.offsetWidth, ph = panel.offsetHeight;
      let left = Math.min(rect.left, window.innerWidth - pw - 8);
      let top = rect.top - ph - 8;
      if (top < 8) top = Math.min(rect.bottom + 8, window.innerHeight - ph - 8);
      panel.style.left = Math.max(8, left) + 'px';
      panel.style.top = Math.max(8, top) + 'px';
      panel.style.visibility = 'visible';
    });

    outsideHandler = (e) => { if (panel && !panel.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) close(); };
    keyHandler = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', outsideHandler);
    document.addEventListener('keydown', keyHandler);
  }

  return { open, close };
};
