(function () {
  'use strict';
  // Breakout rooms panel for the meeting owner (Teams-style, roadmap 2.7), on the meeting page
  // (meet-room.js). Set up rooms (how many; assign automatically or by hand), open them with an
  // optional time limit, move people, visit a room, message every room, close them. The server side
  // is meet-signaling.js (sfu:breakout-*); moving people's media is meet-room.js's (meet:breakout-move).
  //
  //   roomId()   the room you're in now (the main meeting or a breakout room)
  window.createBreakoutPanel = function ({ socket, request, notify, roomId }) {
    let dialog = null, data = null, tick = 0;
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const call = (event, body = {}) => request(event, { roomId: roomId(), ...body }).then(load).catch(e => { notify(e); load(); });

    async function load() {
      if (!dialog?.open) return;
      try { data = await request('sfu:breakout-get', { roomId: roomId() }); } catch (e) { notify(e); return; }
      render();
    }
    const left = () => { const ms = (data?.state.endsAt || 0) - Date.now(); if (ms <= 0) return ''; const s = Math.ceil(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
    function roomSelect(p) {
      const opts = ['<option value="-1">Main meeting</option>', ...data.state.rooms.map((r, i) => '<option value="' + i + '"' + ((data.state.open ? p.room : data.assign[p.peerId] ?? -1) === i ? ' selected' : '') + '>' + esc(r) + '</option>')];
      return '<select data-peer="' + esc(p.peerId) + '" aria-label="Room for ' + esc(p.fullName) + '">' + opts.join('') + '</select>';
    }
    function render() {
      const body = dialog.querySelector('.channel-dialog-body');
      const { state, people = [] } = data;
      let html = '';
      if (!state.rooms.length) {
        html = '<form data-form="setup"><label>How many rooms?<input name="count" type="number" min="1" max="20" value="' + Math.min(20, Math.max(2, Math.ceil(people.length / 3))) + '" required></label>'
          + '<fieldset class="bo-choice"><legend>Assign people</legend><label><input type="radio" name="how" value="auto" checked> Automatically (spread evenly)</label><label><input type="radio" name="how" value="manual"> Manually</label></fieldset>'
          + '<button type="submit" class="bo-primary">Create rooms</button></form>';
      } else {
        const inRoom = i => people.filter(p => p.room === i);
        html += '<p class="bo-status">' + (state.open ? '<strong>Rooms are open.</strong>' + (state.endsAt ? ' Closing in <span data-left>' + left() + '</span>.' : '') : 'Rooms are set up but not open yet. Assign people, then open them.') + '</p>';
        html += '<table class="bo-people"><thead><tr><th>Person</th><th>' + (state.open ? 'In' : 'Goes to') + '</th></tr></thead><tbody>'
          + people.map(p => '<tr><td>' + esc(p.fullName) + (p.owner ? ' <small>(you)</small>' : '') + '</td><td>' + (p.owner ? esc(p.room < 0 ? 'Main meeting' : state.rooms[p.room]) : roomSelect(p)) + '</td></tr>').join('')
          + '</tbody></table>';
        if (state.open) {
          html += '<div class="bo-rooms">' + state.rooms.map((r, i) => '<div class="bo-room"><strong>' + esc(r) + '</strong> <small>' + inRoom(i).length + ' in room</small> <button type="button" data-join="' + i + '">Join</button></div>').join('')
            + '<div class="bo-room"><strong>Main meeting</strong> <small>' + inRoom(-1).length + ' here</small> <button type="button" data-join="-1">Go back</button></div></div>';
          html += '<form data-form="message" class="bo-inline"><input name="text" maxlength="300" placeholder="Message to all rooms" aria-label="Message to all rooms"><button type="submit">Send</button></form>';
          html += '<div class="bo-actions"><button type="button" data-action="close" class="bo-danger">Close rooms</button></div>';
        } else {
          html += '<form data-form="open" class="bo-inline"><label>Time limit <input name="minutes" type="number" min="0" max="240" value="0" aria-label="Time limit in minutes"> min <small>(0 = none)</small></label><button type="submit" class="bo-primary">Open rooms</button></form>';
          html += '<div class="bo-actions"><button type="button" data-action="redo">Start over</button></div>';
        }
      }
      body.innerHTML = html + '<p class="bo-error" role="alert"></p>';
      body.querySelector('[data-form="setup"]')?.addEventListener('submit', e => {
        e.preventDefault();
        const f = e.target, count = Number(f.count.value), auto = f.how.value === 'auto';
        call('sfu:breakout-setup', auto ? { count } : { count, assign: {} });
      });
      body.querySelector('[data-form="open"]')?.addEventListener('submit', e => { e.preventDefault(); call('sfu:breakout-open', { minutes: Number(e.target.minutes.value) || 0 }); });
      body.querySelector('[data-form="message"]')?.addEventListener('submit', e => { e.preventDefault(); const t = e.target.text.value.trim(); if (t) { e.target.text.value = ''; call('sfu:breakout-message', { text: t }); } });
      body.querySelector('[data-action="close"]')?.addEventListener('click', () => call('sfu:breakout-close'));
      body.querySelector('[data-action="redo"]')?.addEventListener('click', () => { data.state.rooms = []; render(); });
      body.querySelectorAll('select[data-peer]').forEach(s => s.addEventListener('change', () => call('sfu:breakout-assign', { peerId: s.dataset.peer, index: Number(s.value) })));
      body.querySelectorAll('[data-join]').forEach(b => b.addEventListener('click', () => call('sfu:breakout-join', { index: Number(b.dataset.join) })));
    }

    function open() {
      if (dialog?.open) return;
      dialog = document.createElement('dialog'); dialog.className = 'channel-dialog breakout-dialog';
      dialog.innerHTML = '<header><h2>Breakout rooms</h2><button type="button" aria-label="Close">×</button></header><div class="channel-dialog-body"><p>Loading…</p></div>';
      document.body.append(dialog);
      dialog.querySelector('header button').onclick = () => dialog.close();
      dialog.addEventListener('close', () => { clearInterval(tick); dialog.remove(); dialog = null; });
      dialog.showModal();
      tick = setInterval(() => { const el = dialog?.querySelector('[data-left]'); if (el) el.textContent = left(); }, 1000);
      load();
    }
    // Keep the panel current as rooms open/close and people come and go.
    for (const ev of ['meet:breakout-state', 'sfu:peer-joined', 'sfu:peer-left', 'meet:breakout-move']) socket.on(ev, () => setTimeout(load, 300));
    return { open, close() { dialog?.close(); } };
  };
})();
