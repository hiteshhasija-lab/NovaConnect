(function () {
  'use strict';
  // Shared whiteboard for calls and meetings (Teams-style, roadmap Phase 2), used by the call panel
  // (group-calls.js) and the meeting page (meet-room.js). Anyone in the call can open it; it opens
  // for everyone and takes the stage like a shared screen. Strokes stream through the server
  // (meet-signaling.js sfu:wb-*), which keeps the board while the call lasts, so late joiners see
  // what's there. Points are stored 0–1 on a 16:9 board, so every screen size shows the same drawing.
  //
  //   host         element the board (toolbar + canvas) is drawn into; the page shows/hides it
  //   onOpenChange(open) the board opened/closed for this call (the page switches its stage)
  const COLORS = [['#1b1f3a', 'Black'], ['#0755d9', 'Blue'], ['#d1344b', 'Red'], ['#1e9e5a', 'Green'], ['#f08c00', 'Orange']];
  const WIDTHS = [[3, 'Thin'], [6, 'Medium'], [12, 'Thick']];
  const BOARD_W = 1600, BOARD_H = 900;        // logical board size; widths are in these units
  const SEND_MS = 50;                          // batch points while drawing
  const ERASE_RADIUS = 14;                     // logical px

  window.createWhiteboard = function ({ socket, request, notify, host, onOpenChange = () => {} }) {
    let ctx = null;                            // { roomId, peerId } while in a call
    let open = false, canClear = false;
    let color = COLORS[1][0], width = WIDTHS[1][0], erasing = false;
    const strokes = new Map();                 // id -> { id, peerId, color, width, points: [[x,y]...] }
    const mine = [];                           // ids of my strokes, for undo
    let drawing = null, pending = [], sendTimer = null, seq = 0;

    host.classList.add('nc-board');
    host.innerHTML = '<div class="nc-board-tools" role="toolbar" aria-label="Whiteboard tools"></div><div class="nc-board-surface"><canvas aria-label="Shared whiteboard" role="img"></canvas></div>';
    const tools = host.querySelector('.nc-board-tools');
    const surface = host.querySelector('.nc-board-surface');
    const canvas = host.querySelector('canvas');
    const g = canvas.getContext('2d');

    // ---- toolbar ----
    const btn = (label, html, onClick, cls = '') => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'nc-board-btn ' + cls;
      b.title = label; b.setAttribute('aria-label', label); b.innerHTML = html; b.addEventListener('click', onClick); return b;
    };
    const colorBtns = COLORS.map(([c, name]) => { const b = btn(name + ' pen', '<span class="nc-board-swatch" style="background:' + c + '"></span>', () => { color = c; erasing = false; paintTools(); }); b.dataset.color = c; return b; });
    const widthBtns = WIDTHS.map(([w, name]) => { const b = btn(name + ' line', '<span class="nc-board-width" style="height:' + Math.max(2, w / 2) + 'px"></span>', () => { width = w; erasing = false; paintTools(); }); b.dataset.width = w; return b; });
    const eraserBtn = btn('Eraser (removes whole strokes)', '<i class="bi bi-eraser" aria-hidden="true"></i>', () => { erasing = !erasing; paintTools(); });
    const undoBtn = btn('Undo my last stroke', '<i class="bi bi-arrow-counterclockwise" aria-hidden="true"></i>', undo);
    const clearBtn = btn('Clear the board for everyone', '<i class="bi bi-trash3" aria-hidden="true"></i>', () => {
      if (ctx && confirm('Clear the whiteboard for everyone?')) request('sfu:wb-clear', { roomId: ctx.roomId }).catch(e => notify(e));
    });
    const saveBtn = btn('Download as image', '<i class="bi bi-download" aria-hidden="true"></i>', download);
    const closeBtn = btn('Close the whiteboard for everyone', '<i class="bi bi-x-lg" aria-hidden="true"></i> Close', () => setOpen(false), 'nc-board-close');
    const sep = () => { const s = document.createElement('span'); s.className = 'nc-board-sep'; return s; };
    tools.append(...colorBtns, sep(), ...widthBtns, sep(), eraserBtn, undoBtn, clearBtn, saveBtn, sep(), closeBtn);
    function paintTools() {
      colorBtns.forEach(b => b.setAttribute('aria-pressed', String(!erasing && b.dataset.color === color)));
      widthBtns.forEach(b => b.setAttribute('aria-pressed', String(!erasing && Number(b.dataset.width) === width)));
      eraserBtn.setAttribute('aria-pressed', String(erasing));
      clearBtn.hidden = !canClear;
      undoBtn.disabled = !mine.some(id => strokes.has(id));
      canvas.style.cursor = erasing ? 'cell' : 'crosshair';
    }

    // ---- drawing ----
    // The canvas keeps the board's 16:9 shape inside whatever space the page gives it.
    function fit() {
      const box = surface.getBoundingClientRect();
      if (!box.width || !box.height) return;
      let w = box.width, h = w * BOARD_H / BOARD_W;
      if (h > box.height) { h = box.height; w = h * BOARD_W / BOARD_H; }
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      redraw();
    }
    const scale = () => canvas.width / BOARD_W;
    function drawSegment(s, from) {
      const k = scale(), pts = s.points;
      if (!pts.length) return;
      g.strokeStyle = s.color; g.lineWidth = s.width * k; g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath();
      const start = Math.max(0, from - 1);
      g.moveTo(pts[start][0] * canvas.width, pts[start][1] * canvas.height);
      if (pts.length === 1) g.lineTo(pts[0][0] * canvas.width + 0.01, pts[0][1] * canvas.height); // a dot
      for (let i = start + 1; i < pts.length; i++) g.lineTo(pts[i][0] * canvas.width, pts[i][1] * canvas.height);
      g.stroke();
    }
    function redraw() {
      g.fillStyle = '#ffffff'; g.fillRect(0, 0, canvas.width, canvas.height);
      for (const s of strokes.values()) drawSegment(s, 0);
    }
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
    ro?.observe(surface);

    const toBoard = e => { const r = canvas.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]; };
    function flush(done = false) {
      clearTimeout(sendTimer); sendTimer = null;
      if (!drawing || (!pending.length && !done)) return;
      socket.emit('sfu:wb-stroke', { roomId: ctx.roomId, id: drawing.localId, color: drawing.color, width: drawing.width, points: pending, done });
      pending = [];
    }
    canvas.addEventListener('pointerdown', e => {
      if (!ctx || !open || e.button > 0) return;
      canvas.setPointerCapture(e.pointerId);
      if (erasing) { eraseAt(toBoard(e)); drawing = { erasing: true }; return; }
      const localId = 's' + (++seq) + '-' + Date.now().toString(36);
      const s = { id: ctx.peerId + ':' + localId, peerId: ctx.peerId, color, width, points: [toBoard(e)] };
      strokes.set(s.id, s); mine.push(s.id);
      drawing = { localId, color, width, stroke: s };
      pending = [s.points[0]];
      drawSegment(s, 0); paintTools();
      sendTimer = setTimeout(flush, SEND_MS);
    });
    canvas.addEventListener('pointermove', e => {
      if (!drawing) return;
      if (drawing.erasing) { eraseAt(toBoard(e)); return; }
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      const s = drawing.stroke, before = s.points.length;
      for (const ev of events) {
        const p = toBoard(ev), last = s.points[s.points.length - 1];
        if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 0.0012) continue; // skip jitter
        s.points.push(p); pending.push(p);
      }
      if (s.points.length > before) drawSegment(s, before);
      if (s.points.length > 5000) { flush(true); drawing = null; return; } // very long stroke: end it
      if (!sendTimer) sendTimer = setTimeout(flush, SEND_MS);
    });
    const endStroke = () => { if (!drawing) return; if (!drawing.erasing) flush(true); drawing = null; };
    canvas.addEventListener('pointerup', endStroke);
    canvas.addEventListener('pointercancel', endStroke);

    // Eraser: removes every stroke passing within reach of the pointer (Teams' ink eraser).
    function eraseAt([x, y]) {
      const r = ERASE_RADIUS / BOARD_W, hit = [];
      for (const s of strokes.values()) {
        const reach = r + (s.width / 2) / BOARD_W;
        if (s.points.some(([px, py]) => Math.hypot((px - x), (py - y) * BOARD_H / BOARD_W) < reach)) hit.push(s.id);
      }
      if (hit.length) removeStrokes(hit, true);
    }
    function removeStrokes(ids, tellOthers) {
      let changed = false;
      for (const id of ids) changed = strokes.delete(id) || changed;
      if (!changed) return;
      redraw(); paintTools();
      if (tellOthers && ctx) socket.emit('sfu:wb-erase', { roomId: ctx.roomId, ids });
    }
    function undo() {
      while (mine.length && !strokes.has(mine[mine.length - 1])) mine.pop();
      const id = mine.pop();
      if (id) removeStrokes([id], true);
    }
    function download() {
      const a = document.createElement('a');
      a.download = 'Whiteboard ' + new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.') + '.png';
      a.href = canvas.toDataURL('image/png'); a.click();
    }

    // ---- sync ----
    // The board's strokes (and, on joining, whether it's already open for this call).
    async function load(syncOpen = false) {
      const mineCtx = ctx;
      try {
        const r = await request('sfu:wb-get', { roomId: ctx.roomId });
        if (ctx !== mineCtx) return;
        strokes.clear(); for (const s of r.strokes) strokes.set(s.id, s);
        canClear = !!r.canClear; redraw(); paintTools();
        if (syncOpen && r.open) applyOpen(true, null, false);
      } catch (e) { if (!syncOpen) notify(e); }
    }
    function applyOpen(value, byName, reload = true) {
      if (open === value) return;
      open = value;
      onOpenChange(open, byName);
      if (open) { if (reload) load(); requestAnimationFrame(fit); }
      else if (drawing) endStroke();
    }
    function setOpen(value) {
      if (!ctx) return;
      request('sfu:wb-open', { roomId: ctx.roomId, open: value }).catch(e => notify(e));
    }
    const ours = roomId => ctx && roomId === ctx.roomId;
    socket.on('sfu:wb-state', ({ roomId, open: value, byName }) => { if (ours(roomId)) applyOpen(value, byName); });
    socket.on('sfu:wb-stroke', ({ roomId, id, peerId, color: c, width: w, points }) => {
      if (!ours(roomId)) return;
      let s = strokes.get(id);
      if (!s) { s = { id, peerId, color: c, width: w, points: [] }; strokes.set(id, s); }
      const from = s.points.length;
      s.points.push(...points);
      if (open) drawSegment(s, from);
    });
    socket.on('sfu:wb-erase', ({ roomId, ids }) => { if (ours(roomId)) removeStrokes(ids, false); });
    socket.on('sfu:wb-clear', ({ roomId }) => { if (!ours(roomId)) return; strokes.clear(); mine.length = 0; redraw(); paintTools(); });

    return {
      // Call once you are in the room: loads the board, and shows it if it's already open.
      start({ roomId, peerId }) {
        ctx = { roomId, peerId }; strokes.clear(); mine.length = 0; open = false; erasing = false;
        paintTools(); load(true);
      },
      stop() {
        if (drawing) endStroke();
        const wasOpen = open;
        ctx = null; open = false; strokes.clear(); mine.length = 0; redraw();
        if (wasOpen) onOpenChange(false);
      },
      toggle() { setOpen(!open); },
      get isOpen() { return open; },
      fit,
    };
  };
})();
