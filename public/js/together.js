(function () {
  'use strict';
  // Together mode (Teams-style, roadmap 2.9): everyone cut out of their video and seated in one shared
  // scene. Used by the call panel (group-calls.js) and the meeting page (meet-room.js). A room-wide
  // switch (server: sfu:together); while it's on, every browser sends its camera cut out on pure green
  // (background-effects.js 'cutout') and this module keys the green out of everyone's video and draws
  // them into seats — front rows larger, desks in front, names on the desks.
  //
  //   host               element the scene canvas is drawn into; the page shows/hides it
  //   sources()          [{ id, name, video, camOff }] people to seat, in order (you included)
  //   onChange(on, byName)  Together mode turned on/off for this call
  const SCENE_W = 1600, SCENE_H = 900, FPS = 20;
  const MAX_SEATS = 18;

  window.createTogether = function ({ socket, request, notify, host, sources, onChange = () => {} }) {
    let ctx = null, on = false, canToggle = false, raf = 0, lastDraw = 0;
    host.classList.add('nc-together');
    host.innerHTML = '<canvas role="img" aria-label="Together mode: everyone seated in a shared scene"></canvas>';
    const canvas = host.querySelector('canvas'), g = canvas.getContext('2d');
    const seatCanvases = new Map(); // id -> { c, g } scratch canvas for keying that person's video

    function fit() {
      const box = host.getBoundingClientRect();
      if (!box.width || !box.height) return;
      let w = box.width, h = w * SCENE_H / SCENE_W;
      if (h > box.height) { h = box.height; w = h * SCENE_W / SCENE_H; }
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    }
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    ro?.observe(host);

    // Rows from back to front; the front row is largest. Fewer people -> fewer rows.
    function layout(n) {
      const rows = n <= 4 ? 1 : n <= 10 ? 2 : 3;
      const perRow = Math.ceil(n / rows), out = [];
      let placed = 0;
      for (let r = 0; r < rows; r++) {
        const count = Math.min(perRow, n - placed); if (count <= 0) break;
        const depth = rows === 1 ? 1 : 0.62 + 0.38 * (r / (rows - 1));          // back 0.62 → front 1
        const seatW = Math.min(380, 1500 / Math.max(perRow, 3)) * depth, seatH = seatW * 1.05;
        const deskY = SCENE_H * (rows === 1 ? 0.86 : 0.5 + 0.36 * (r / (rows - 1)));
        const span = count * seatW * 0.92, x0 = (SCENE_W - span) / 2;
        for (let i = 0; i < count; i++) out.push({ x: x0 + i * seatW * 0.92 + seatW * 0.04, y: deskY - seatH * 0.82, w: seatW * 0.84, h: seatH, deskY, row: r, rowCount: count, x0, span, depth });
        placed += count;
      }
      return out;
    }

    function drawRoom(k) {
      const sky = g.createLinearGradient(0, 0, 0, SCENE_H * k);
      sky.addColorStop(0, '#0d1b33'); sky.addColorStop(0.55, '#16325a'); sky.addColorStop(1, '#0a1426');
      g.fillStyle = sky; g.fillRect(0, 0, SCENE_W * k, SCENE_H * k);
      // Soft stage light and a back wall panel line.
      const glow = g.createRadialGradient(SCENE_W * k / 2, SCENE_H * k * 0.15, 10, SCENE_W * k / 2, SCENE_H * k * 0.15, SCENE_W * k * 0.6);
      glow.addColorStop(0, 'rgba(80,213,255,0.18)'); glow.addColorStop(1, 'rgba(80,213,255,0)');
      g.fillStyle = glow; g.fillRect(0, 0, SCENE_W * k, SCENE_H * k);
    }
    function drawDesk(seats, row, k) {
      const s = seats.find(x => x.row === row); if (!s) return;
      // Tall enough to hide where each person's picture ends (seats reach 0.18 of their height below).
      const pad = 30 * s.depth, x = (s.x0 - pad) * k, w = (s.span + pad * 2) * k, y = s.deskY * k, h = (s.h * 0.22 + 6) * k;
      const wood = g.createLinearGradient(0, y, 0, y + h);
      wood.addColorStop(0, '#2d4a74'); wood.addColorStop(1, '#1a2f4f');
      g.fillStyle = wood;
      g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, 8 * k) : g.rect(x, y, w, h); g.fill();
      g.fillStyle = 'rgba(153,234,255,0.35)'; g.fillRect(x, y, w, 2 * k); // desk edge highlight
    }
    const initials = name => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';

    // The person in a seat: their video with the green keyed out (partial alpha at the edges, and green
    // spill removed), cropped to the middle of the frame.
    function drawPerson(src, seat, k) {
      const w = Math.max(8, Math.round(seat.w * k)), h = Math.max(8, Math.round(seat.h * k));
      const v = src.video;
      if (src.camOff || !v || !v.videoWidth) {
        const r = Math.min(w, h) * 0.22, cx = seat.x * k + w / 2, cy = seat.y * k + h * 0.48;
        g.fillStyle = '#0755d9'; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#fff'; g.font = '600 ' + Math.round(r * 0.8) + 'px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(initials(src.name), cx, cy + 1);
        return;
      }
      let sc = seatCanvases.get(src.id);
      if (!sc) { const c = document.createElement('canvas'); sc = { c, g: c.getContext('2d', { willReadFrequently: true }) }; seatCanvases.set(src.id, sc); }
      if (sc.c.width !== w || sc.c.height !== h) { sc.c.width = w; sc.c.height = h; }
      // Crop the camera's middle to the seat's shape (people sit in the centre of the frame).
      const vw = v.videoWidth, vh = v.videoHeight, want = w / h;
      let cw = vw, ch = vh; if (vw / vh > want) cw = vh * want; else ch = vw / want;
      sc.g.clearRect(0, 0, w, h);
      sc.g.drawImage(v, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, w, h);
      const img = sc.g.getImageData(0, 0, w, h), d = img.data;
      let keyed = 0;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], gr = d[i + 1], b = d[i + 2], m = r > b ? r : b, diff = gr - m;
        if (gr > 90 && diff > 60) { d[i + 3] = 0; keyed++; }
        else if (gr > 60 && diff > 20) { d[i + 3] = Math.min(d[i + 3], 255 * (1 - (diff - 20) / 40)); d[i + 1] = m; }
        else if (diff > 8) d[i + 1] = m + 8; // green spill on hair and shoulders
      }
      sc.g.putImageData(img, 0, 0);
      // Not cut out (their browser can't): show them as a small framed picture in the seat instead.
      if (keyed < d.length / 4 * 0.05) {
        const fw = w * 0.8, fh = h * 0.62, fx = seat.x * k + (w - fw) / 2, fy = seat.y * k + h * 0.12;
        g.save(); g.beginPath(); g.roundRect ? g.roundRect(fx, fy, fw, fh, 10 * k) : g.rect(fx, fy, fw, fh); g.clip();
        g.drawImage(sc.c, fx, fy, fw, fh); g.restore();
        return;
      }
      g.drawImage(sc.c, seat.x * k, seat.y * k);
    }
    function drawName(src, seat, k) {
      const size = Math.max(11, Math.round(20 * seat.depth * k));
      g.font = '600 ' + size + 'px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#e5f1ff';
      const label = src.name.length > 22 ? src.name.slice(0, 21) + '…' : src.name;
      g.fillText(label, (seat.x + seat.w / 2) * k, (seat.deskY + seat.h * 0.11 + 3) * k);
    }

    function draw(now) {
      raf = requestAnimationFrame(draw);
      if (now - lastDraw < 1000 / FPS) return;
      lastDraw = now;
      if (!canvas.width) { fit(); if (!canvas.width) return; }
      const k = canvas.width / SCENE_W;
      const people = sources().slice(0, MAX_SEATS);
      const seats = layout(people.length);
      drawRoom(k);
      const rows = [...new Set(seats.map(s => s.row))];
      for (const row of rows) {                       // back to front: each row, then its desk
        seats.forEach((seat, i) => { if (seat.row === row) drawPerson(people[i], seat, k); });
        drawDesk(seats, row, k);
        seats.forEach((seat, i) => { if (seat.row === row) drawName(people[i], seat, k); });
      }
    }
    function run(value) {
      cancelAnimationFrame(raf); raf = 0;
      if (value) { requestAnimationFrame(fit); raf = requestAnimationFrame(draw); }
      else { seatCanvases.clear(); }
    }
    function apply(value, byName) {
      if (on === value) return;
      on = value; run(on); onChange(on, byName);
    }
    const ours = roomId => ctx && roomId === ctx.roomId;
    socket.on('sfu:together-state', ({ roomId, on: value, byName }) => { if (ours(roomId)) apply(value, byName); });

    return {
      start({ roomId }, { on: already = false, canToggle: may = true } = {}) { ctx = { roomId }; canToggle = may; if (already) apply(true); },
      // From sfu:participants (late joiners, and who may switch it).
      sync({ on: value, canToggle: may }) { if (!ctx) return; if (may !== undefined) canToggle = may; if (value !== undefined) apply(!!value); },
      stop() { const was = on; ctx = null; on = false; run(false); if (was) onChange(false); },
      toggle() {
        if (!ctx) return;
        request('sfu:together', { roomId: ctx.roomId, on: !on }).catch(e => notify(e));
      },
      get isOn() { return on; },
      get canToggle() { return canToggle; },
      fit,
    };
  };
})();
