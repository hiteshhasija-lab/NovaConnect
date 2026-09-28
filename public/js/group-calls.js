(function () {
  'use strict';
  // Calls in group chats. Everyone's audio and video goes through the SFU (sfu-client.js);
  // the server side is src/group-calls.js. Uses the same call panel as 1:1 calls (calls.js),
  // in its grid layout — each button handler here acts only while a group call is current.
  window.createNovaGroupCalls = function (socket, notify, { otherCallActive = () => false } = {}) {
    const panel = document.getElementById('callPanel');
    const $ = id => document.getElementById(id);
    const grid = $('callGrid');
    const running = new Map();   // conversationId -> { id, mode, count } for calls in progress
    const listeners = new Set();
    let current = null, lastFocus = null;

    function request(event, data) {
      return new Promise((resolve, reject) => {
        if (!socket.connected) return reject(new Error('Connection lost. Please reconnect.'));
        socket.timeout(15000).emit(event, data, (err, reply) => {
          if (err || !reply?.ok) reject(new Error(reply?.error || 'Call request timed out.'));
          else resolve(reply);
        });
      });
    }
    function status(text) { $('callStatus').textContent = text; }
    function changed(conversationId) { listeners.forEach(fn => fn(conversationId)); }

    function show(c, text) {
      if (panel.hidden) lastFocus = document.activeElement;
      panel.hidden = false;
      $('callMedia1to1').hidden = true;
      grid.hidden = !c.joined;
      panel.classList.toggle('nc-call-video', !!c.joined);
      $('callName').textContent = c.title;
      $('callKind').textContent = c.mode === 'video' ? 'Group video call' : 'Group audio call';
      status(text);
      const ringing = c.incoming && !c.joined && !c.joining;
      $('callAccept').hidden = !ringing; $('callDecline').hidden = !ringing; $('callAccept').disabled = false;
      $('callHangup').hidden = ringing;
      $('callMute').hidden = !c.stream?.getAudioTracks().length;
      $('callCamera').hidden = !c.stream?.getVideoTracks().length;
      setCallToggle($('callMute'), false, 'Mute');
      setCallToggle($('callCamera'), false, 'Turn camera off');
      $('callScreenShare').hidden = true; $('callStopSharing').hidden = true; $('callPlayback').hidden = true;
      (ringing ? $('callAccept') : $('callHangup')).focus();
    }

    const allTiles = () => [...grid.querySelectorAll('.nc-video-tile'), ...$('callSelfTile').querySelectorAll('.nc-video-tile')];
    const initials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
    // Teams-style gallery: everyone else shares the stage; your own tile floats small in the corner
    // (and fills the stage while you're alone).
    function arrangeTiles() {
      const mine = allTiles().find(t => t.dataset.peerId === 'local');
      if (!mine) return;
      const others = [...grid.querySelectorAll('.nc-video-tile')].some(t => t.dataset.peerId !== 'local');
      const box = others ? $('callSelfTile') : grid;
      if (mine.parentNode !== box) { box.appendChild(mine); const v = mine.querySelector('video'); if (v.paused) v.play().catch(() => {}); }
    }
    function tile(id, name, media, local = false) {
      let t = allTiles().find(el => el.dataset.peerId === id);
      if (!t) {
        t = document.createElement('section'); t.className = 'nc-video-tile'; t.dataset.peerId = id;
        const v = document.createElement('video'); v.autoplay = true; v.playsInline = true; v.muted = local;
        if (local) v.className = 'nc-video-local';
        // Initials until a picture arrives (audio-only participants never have one).
        const avatar = document.createElement('div'); avatar.className = 'nc-avatar';
        const letters = document.createElement('span'); letters.textContent = initials(name); avatar.append(letters);
        v.addEventListener('resize', () => t.classList.toggle('nc-has-video', v.videoWidth > 0));
        const overlay = document.createElement('div'); overlay.className = 'nc-video-overlay';
        const label = document.createElement('p'); label.className = 'nc-video-name'; label.textContent = name;
        overlay.append(label); t.append(v, avatar, overlay); grid.append(t);
      }
      const v = t.querySelector('video');
      v.srcObject = media;
      // Autoplay with sound can be blocked until the user interacts; offer a play button then.
      v.play().catch(() => { if (current) $('callPlayback').hidden = false; });
      arrangeTiles();
    }
    function removeTile(id) { allTiles().find(el => el.dataset.peerId === id)?.remove(); arrangeTiles(); }

    function cleanup(c, message) {
      clearInterval(c.clock);
      c.session?.close();
      c.stream?.getTracks().forEach(t => t.stop());
      if (current !== c) return;
      current = null;
      changed(c.conversationId);
      allTiles().forEach(t => t.remove());
      panel.classList.remove('nc-call-video');
      grid.hidden = true; panel.hidden = true;
      if (lastFocus?.isConnected) lastFocus.focus();
      if (message) notify(new Error(message));
    }
    function stop(c, message) {
      if (c.id && (c.joined || c.joining)) request('gcall:leave', { id: c.id }).catch(() => {});
      else if (c.id && c.incoming) request('gcall:decline', { id: c.id }).catch(() => {});
      cleanup(c, message);
    }

    // Gets the microphone (and camera), starts the call if we are the caller, then joins it.
    async function join(c) {
      c.joining = true;
      show(c, 'Requesting microphone access…');
      try {
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Open NovaConnect over HTTPS to use your microphone and camera.');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: c.mode === 'video' });
        if (current !== c) { stream.getTracks().forEach(t => t.stop()); return; }
        c.stream = stream;
        status('Connecting…');
        if (!c.id) {
          const started = await request('gcall:start', { conversationId: c.conversationId, mode: c.mode });
          c.id = started.id; c.mode = started.mode;
          if (current !== c) { stream.getTracks().forEach(t => t.stop()); return; }
        }
        const r = await request('gcall:join', { id: c.id });
        if (current !== c) { request('gcall:leave', { id: c.id }).catch(() => {}); return; }
        c.joined = true; c.joining = false;
        changed(c.conversationId); // the header's Join button hides once we are in
        show(c, 'Connecting…');
        tile('local', 'You', stream, true);
        c.session = createSfuSession({
          request, roomId: r.roomId, routerRtpCapabilities: r.routerRtpCapabilities,
          onPeerStream: (peerId, name, media) => { if (current === c) tile(peerId, name, media); },
          onError: e => { if (current === c) status('Could not receive a participant\'s media: ' + e.message); },
        });
        await c.session.start();
        await c.session.publish(stream);
        if (current !== c) return;
        const started = Date.now();
        const tick = () => {
          const secs = Math.floor((Date.now() - started) / 1000);
          const count = running.get(c.conversationId)?.count || 1;
          status((count > 1 ? count + ' in call' : 'Waiting for others to join') + ' · ' + Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0'));
        };
        tick(); c.clock = setInterval(tick, 1000);
      } catch (e) { if (current === c) stop(c, e.message); }
    }

    socket.on('gcall:incoming', data => {
      if (current || otherCallActive()) return;
      const c = current = { id: data.id, conversationId: Number(data.conversationId), mode: data.mode, title: data.title || 'Group call', incoming: true };
      show(c, data.caller.name + ' is calling the group');
    });
    // Nobody picked up in time on this tab, or this person answered in another tab.
    socket.on('gcall:ring-stop', ({ id }) => { if (current?.id === id && !current.joined && !current.joining) cleanup(current); });
    socket.on('gcall:answered', ({ id, socketId }) => {
      if (current?.id === id && socketId !== socket.id && !current.joined && !current.joining) cleanup(current);
    });
    socket.on('gcall:ended', ({ id }) => { if (current?.id === id) cleanup(current); });
    socket.on('gcall:state', ({ conversationId, call }) => {
      conversationId = Number(conversationId);
      if (call) running.set(conversationId, call); else running.delete(conversationId);
      changed(conversationId);
    });
    socket.on('sfu:new-producer', p => { if (current?.joined) current.session?.newProducer(p); });
    socket.on('sfu:peer-left', ({ peerId }) => { if (!current?.joined) return; current.session?.removePeer(peerId); removeTile(peerId); });
    socket.on('disconnect', () => {
      if (current) cleanup(current, 'Connection lost. Call ended.');
      const ids = [...running.keys()]; running.clear(); ids.forEach(changed);
    });

    const ringing = () => current && current.incoming && !current.joined && !current.joining;
    $('callAccept').addEventListener('click', () => { if (ringing()) join(current); });
    $('callDecline').addEventListener('click', () => { if (ringing()) stop(current); });
    $('callHangup').addEventListener('click', () => { if (current) stop(current); });
    $('callMute').addEventListener('click', () => {
      const tracks = current?.stream?.getAudioTracks() || [];
      if (!tracks.length) return;
      const enabled = !tracks[0].enabled;
      tracks.forEach(t => { t.enabled = enabled; });
      setCallToggle($('callMute'), !enabled, enabled ? 'Mute' : 'Unmute');
    });
    $('callCamera').addEventListener('click', () => {
      const tracks = current?.stream?.getVideoTracks() || [];
      if (!tracks.length) return;
      const enabled = !tracks[0].enabled;
      tracks.forEach(t => { t.enabled = enabled; });
      setCallToggle($('callCamera'), !enabled, enabled ? 'Turn camera off' : 'Turn camera on');
    });
    $('callPlayback').addEventListener('click', () => {
      if (!current) return;
      allTiles().forEach(t => t.querySelector('video').play().catch(() => {}));
      $('callPlayback').hidden = true;
    });
    window.addEventListener('pagehide', () => { if (current) stop(current); });

    return {
      active: () => !!current,
      // The call in progress in this chat, if any: { id, mode, count }.
      running: conversationId => running.get(Number(conversationId)) || null,
      inCall: conversationId => !!current?.joined && current.conversationId === Number(conversationId),
      onChange(fn) { listeners.add(fn); },
      async refresh(conversationId) {
        conversationId = Number(conversationId);
        try {
          const { call } = await request('gcall:status', { conversationId });
          if (call) running.set(conversationId, call); else running.delete(conversationId);
          changed(conversationId);
        } catch { /* the header just won't show a Join button */ }
      },
      // Starts a call in this group chat, or joins the one already running there.
      start(conversationId, mode, title) {
        conversationId = Number(conversationId);
        if (current || otherCallActive()) return notify(new Error(current?.conversationId === conversationId && current.joined ? 'You are already in this call.' : 'Finish your current call first.'));
        const existing = running.get(conversationId);
        const c = current = { id: existing?.id || null, conversationId, mode: existing?.mode || mode, title, incoming: false };
        join(c);
      },
    };
  };
})();
