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
      $('callKind').textContent = kindLabel(c);
      status(text);
      const ringing = c.incoming && !c.joined && !c.joining;
      $('callAccept').hidden = !ringing; $('callDecline').hidden = !ringing; $('callAccept').disabled = false;
      $('callHangup').hidden = ringing;
      $('callMute').hidden = !c.stream?.getAudioTracks().length;
      $('callCamera').hidden = !c.stream?.getVideoTracks().length;
      setCallToggle($('callMute'), false, 'Mute');
      setCallToggle($('callCamera'), false, 'Turn camera off');
      $('callScreenShare').hidden = !(c.joined && navigator.mediaDevices?.getDisplayMedia) || !!c.display;
      $('callStopSharing').hidden = !c.display; $('callPlayback').hidden = true;
      for (const id of ['callParticipants', 'callHand', 'callReactions', 'callChat']) $(id).hidden = !c.joined;
      (ringing ? $('callAccept') : $('callHangup')).focus();
    }
    function kindLabel(c) {
      const presenter = c.screens && [...c.screens.values()].pop();
      return c.display ? 'You are sharing your screen'
        : presenter ? presenter.name + ' is sharing their screen'
        : c.mode === 'video' ? 'Group video call' : 'Group audio call';
    }

    // Teams-style presentation: a screen someone else shares fills the stage and the gallery
    // becomes a strip down the side (calls.css .nc-call-presenting). The latest share wins.
    // Your own share isn't shown back to you — you keep the gallery, like Teams' presenter view.
    function renderShare(c) {
      if (current !== c) return;
      const latest = [...c.screens.values()].pop();
      panel.classList.toggle('nc-call-presenting', !!latest);
      $('callShareStage').hidden = !latest;
      if ($('callShareVideo').srcObject !== (latest?.stream || null)) {
        $('callShareVideo').srcObject = latest?.stream || null;
        if (latest) $('callShareVideo').play().catch(() => {});
      }
      $('callKind').textContent = kindLabel(c);
      arrangeTiles();
    }
    async function shareScreen(c) {
      if (!navigator.mediaDevices?.getDisplayMedia) return notify(new Error('Screen sharing requires a supported browser over HTTPS.'));
      let display;
      try {
        display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
        if (current !== c || !c.joined || !c.session || c.display) { display.getTracks().forEach(t => t.stop()); return; }
        const track = display.getVideoTracks()[0];
        c.display = display;
        track.onended = () => stopScreen(c); // the browser's own "Stop sharing" bar
        await c.session.shareScreen(track);
        $('callScreenShare').hidden = true; $('callStopSharing').hidden = false;
        $('callKind').textContent = kindLabel(c);
      } catch (e) {
        display?.getTracks().forEach(t => t.stop());
        if (c.display === display) c.display = null;
        if (e.name !== 'NotAllowedError') notify(e); // NotAllowedError = picker cancelled
      }
    }
    async function stopScreen(c) {
      const display = c.display;
      if (!display) return;
      c.display = null;
      display.getTracks().forEach(t => { t.onended = null; t.stop(); });
      await c.session?.stopScreen();
      if (current !== c) return;
      $('callStopSharing').hidden = true; $('callScreenShare').hidden = !navigator.mediaDevices?.getDisplayMedia;
      $('callKind').textContent = kindLabel(c);
    }

    const allTiles = () => [...grid.querySelectorAll('.nc-video-tile'), ...$('callSelfTile').querySelectorAll('.nc-video-tile')];
    const initials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
    // Teams-style gallery: everyone else shares the stage; your own tile floats small in the corner
    // (and fills the stage while you're alone).
    function arrangeTiles() {
      const mine = allTiles().find(t => t.dataset.peerId === 'local');
      if (!mine) return;
      const others = [...grid.querySelectorAll('.nc-video-tile')].some(t => t.dataset.peerId !== 'local');
      // While someone presents, everyone (you included) sits in the side strip.
      const box = others && !panel.classList.contains('nc-call-presenting') ? $('callSelfTile') : grid;
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
        const mic = document.createElement('i'); mic.className = 'bi bi-mic-mute-fill nc-tile-mic'; mic.setAttribute('role', 'img'); mic.setAttribute('aria-label', 'Muted');
        label.prepend(mic);
        const hand = document.createElement('span'); hand.className = 'nc-tile-hand'; hand.setAttribute('role', 'img'); hand.setAttribute('aria-label', 'Hand raised'); hand.textContent = '✋';
        overlay.append(label); t.append(v, avatar, hand, overlay); grid.append(t);
      }
      const v = t.querySelector('video');
      v.srcObject = media;
      // Autoplay with sound can be blocked until the user interacts; offer a play button then.
      v.play().catch(() => { if (current) $('callPlayback').hidden = false; });
      arrangeTiles();
    }
    // Camera off → initials; microphone muted → muted icon on their tile.
    function setTileState(id, kind, paused) {
      const t = allTiles().find(el => el.dataset.peerId === id);
      if (t) t.classList.toggle(kind === 'audio' ? 'nc-mic-off' : 'nc-camera-off', paused);
    }
    function removeTile(id) { allTiles().find(el => el.dataset.peerId === id)?.remove(); arrangeTiles(); }

    function cleanup(c, message) {
      clearInterval(c.clock);
      c.display?.getTracks().forEach(t => { t.onended = null; t.stop(); }); c.display = null;
      c.session?.close();
      c.stream?.getTracks().forEach(t => t.stop());
      if (current !== c) return;
      current = null;
      changed(c.conversationId);
      allTiles().forEach(t => t.remove());
      panel.classList.remove('nc-call-video', 'nc-call-presenting');
      resetExtras();
      $('callShareStage').hidden = true; $('callShareVideo').srcObject = null;
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
        c.joined = true; c.joining = false; c.roomId = r.roomId; c.peerId = r.peerId;
        changed(c.conversationId); // the header's Join button hides once we are in
        show(c, 'Connecting…');
        tile('local', 'You', stream, true);
        c.screens = new Map(); // peerId -> { name, stream } for screens being shared
        c.session = createSfuSession({
          request, roomId: r.roomId, routerRtpCapabilities: r.routerRtpCapabilities,
          onPeerStream: (peerId, name, media) => { if (current === c) tile(peerId, name, media); },
          onPeerState: (peerId, kind, paused) => { if (current === c) setTileState(peerId, kind, paused); },
          onPeerScreen: (peerId, name, media) => {
            if (current !== c) return;
            c.screens.delete(peerId);
            if (media) c.screens.set(peerId, { name, stream: media });
            renderShare(c);
          },
          onError: e => { if (current === c) status('Could not receive a participant\'s media: ' + e.message); },
        });
        await c.session.start();
        await c.session.publish(stream);
        if (current !== c) return;
        refreshParticipants(c);
        const started = Date.now();
        const tick = () => {
          const secs = Math.floor((Date.now() - started) / 1000);
          const count = running.get(c.conversationId)?.count || 1;
          status((count > 1 ? count + ' in call' : 'Waiting for others to join') + ' · ' + Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0'));
        };
        tick(); c.clock = setInterval(tick, 1000);
      } catch (e) { if (current === c) stop(c, e.message); }
    }

    // ---------- In-call extras: participants, raise hand, reactions, chat, active speaker ----------
    const REACTIONS = ['👍', '❤️', '😂', '😮', '👏', '🎉'];
    const SIDE_PANELS = { callParticipants: 'callParticipantsPanel', callReactions: 'callReactionsPanel', callChat: 'callChatPanel' };
    let unreadChat = 0, participantsTimer = null;
    const tileFor = peerId => allTiles().find(t => t.dataset.peerId === (peerId === current?.peerId ? 'local' : peerId));

    function openSidePanel(buttonId) {
      for (const [btn, panelId] of Object.entries(SIDE_PANELS)) {
        const open = btn === buttonId && $(panelId).hidden;
        $(panelId).hidden = !open;
        $(btn).setAttribute('aria-expanded', String(open));
      }
      if (buttonId === 'callChat' && !$('callChatPanel').hidden) { unreadChat = 0; badge('callChatCount', 0); $('callChatInput').focus(); }
      if (buttonId === 'callParticipants' && !$('callParticipantsPanel').hidden && current) refreshParticipants(current);
    }
    function badge(id, n) { $(id).textContent = String(n); $(id).hidden = !n; }
    // A short notice over the call (hand raised, chat preview while the chat is closed).
    function notice(text) {
      const el = document.createElement('div'); el.className = 'nc-call-notice'; el.textContent = text;
      $('callNotices').appendChild(el);
      while ($('callNotices').children.length > 3) $('callNotices').firstElementChild.remove();
      setTimeout(() => el.remove(), 4500);
    }
    // Participant list, refreshed (debounced) whenever someone joins/leaves or changes state.
    function refreshParticipants(c) {
      clearTimeout(participantsTimer);
      participantsTimer = setTimeout(async () => {
        if (current !== c || !c.roomId) return;
        let list, speaker;
        try { ({ participants: list, speaker } = await request('sfu:participants', { roomId: c.roomId })); } catch { return; }
        if (current !== c) return;
        if (speaker && !allTiles().some(t => t.classList.contains('nc-speaking'))) tileFor(speaker)?.classList.add('nc-speaking');
        badge('callParticipantCount', list.length);
        $('participantCount').textContent = String(list.length);
        $('participantList').replaceChildren(...list.sort((a, b) => (b.hand - a.hand) || a.fullName.localeCompare(b.fullName)).map(p => {
          const row = document.createElement('div'); row.className = 'nc-participant-item';
          const av = document.createElement('span'); av.className = 'nc-participant-avatar'; av.textContent = initials(p.fullName);
          const info = document.createElement('div'); info.className = 'nc-participant-info';
          const name = document.createElement('div'); name.className = 'nc-participant-name'; name.textContent = p.fullName + (p.peerId === c.peerId ? ' (You)' : '');
          const st = document.createElement('div'); st.className = 'nc-participant-status';
          const icon = (cls, label) => { const i = document.createElement('i'); i.className = 'bi ' + cls; i.setAttribute('role', 'img'); i.setAttribute('aria-label', label); i.title = label; return i; };
          if (p.hand) { const h = document.createElement('span'); h.textContent = '✋'; h.setAttribute('role', 'img'); h.setAttribute('aria-label', 'Hand raised'); st.append(h); }
          st.append(p.micOff ? icon('bi-mic-mute-fill', 'Muted') : icon('bi-mic-fill', 'Microphone on'));
          st.append(p.camOff ? icon('bi-camera-video-off-fill', 'Camera off') : icon('bi-camera-video-fill', 'Camera on'));
          info.append(name, st); row.append(av, info);
          return row;
        }));
      }, 250);
    }
    function setHand(c, raised) {
      c.hand = raised;
      $('callHand').setAttribute('aria-pressed', String(raised));
      $('callHand').title = raised ? 'Lower hand' : 'Raise hand'; $('callHand').setAttribute('aria-label', $('callHand').title);
      $('callHand').classList.toggle('nc-active', raised);
    }
    function flyReaction(peerId, emoji) {
      const host = panel.classList.contains('nc-call-presenting') ? $('callShareStage') : (tileFor(peerId) || $('callMedia'));
      const el = document.createElement('span'); el.className = 'nc-float-reaction'; el.textContent = emoji; el.setAttribute('aria-hidden', 'true');
      el.style.left = (20 + Math.random() * 60) + '%';
      host.appendChild(el);
      el.addEventListener('animationend', () => el.remove());
      setTimeout(() => el.remove(), 3500);
    }
    function addChatMessage(c, m) {
      const mine = m.peerId === c.peerId;
      const row = document.createElement('div'); row.className = 'nc-chat-message' + (mine ? ' local' : '');
      const who = document.createElement('span'); who.className = 'nc-chat-sender'; who.textContent = mine ? 'You' : m.fullName;
      const text = document.createElement('div'); text.className = 'nc-chat-text'; text.textContent = m.text;
      const time = document.createElement('span'); time.className = 'nc-chat-time'; time.textContent = new Date(m.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      row.append(who, text, time);
      const box = $('callChatMessages'); box.appendChild(row); box.scrollTop = box.scrollHeight;
      if ($('callChatPanel').hidden && !mine) { badge('callChatCount', ++unreadChat); notice(m.fullName + ': ' + m.text.slice(0, 80)); }
    }
    function resetExtras() {
      for (const [btn, panelId] of Object.entries(SIDE_PANELS)) { $(panelId).hidden = true; $(btn).setAttribute('aria-expanded', 'false'); }
      for (const id of ['callParticipants', 'callHand', 'callReactions', 'callChat']) $(id).hidden = true;
      $('callChatMessages').replaceChildren(); $('participantList').replaceChildren(); $('callNotices').replaceChildren();
      unreadChat = 0; badge('callChatCount', 0); badge('callParticipantCount', 0);
      $('callHand').setAttribute('aria-pressed', 'false'); $('callHand').classList.remove('nc-active');
    }

    $('reactionGrid').replaceChildren(...REACTIONS.map(e => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'nc-reaction-btn'; b.textContent = e; b.setAttribute('aria-label', 'React ' + e);
      b.onclick = () => { if (current?.joined) request('sfu:reaction', { roomId: current.roomId, emoji: e }).catch(err => notify(err)); };
      return b;
    }));
    for (const btn of Object.keys(SIDE_PANELS)) $(btn).addEventListener('click', () => { if (current?.joined) openSidePanel(btn); });
    for (const panelId of Object.values(SIDE_PANELS)) $(panelId).querySelector('.nc-btn-close')?.addEventListener('click', () => { $(panelId).hidden = true; });
    $('callHand').addEventListener('click', () => {
      const c = current; if (!c?.joined) return;
      const raised = !c.hand; setHand(c, raised);
      request('sfu:hand', { roomId: c.roomId, raised }).catch(e => { setHand(c, !raised); notify(e); });
    });
    $('callChatForm').addEventListener('submit', e => {
      e.preventDefault();
      const c = current, input = $('callChatInput');
      if (!c?.joined || !input.value.trim()) return;
      const text = input.value; input.value = '';
      request('sfu:chat', { roomId: c.roomId, text }).catch(err => { input.value = text; notify(err); });
    });
    socket.on('sfu:hand', ({ roomId, peerId, fullName, raised }) => {
      const c = current; if (!c?.joined || roomId !== c.roomId) return;
      tileFor(peerId)?.classList.toggle('nc-hand', raised);
      if (peerId === c.peerId) setHand(c, raised);
      else if (raised) notice(fullName + ' raised their hand');
      refreshParticipants(c);
    });
    socket.on('sfu:reaction', ({ roomId, peerId, emoji }) => { if (current?.joined && roomId === current.roomId) flyReaction(peerId, emoji); });
    socket.on('sfu:chat', m => { if (current?.joined && m.roomId === current.roomId) addChatMessage(current, m); });
    socket.on('sfu:active-speaker', ({ roomId, peerId }) => {
      if (!current?.joined || roomId !== current.roomId) return;
      allTiles().forEach(t => t.classList.remove('nc-speaking'));
      if (peerId) tileFor(peerId)?.classList.add('nc-speaking');
    });
    socket.on('sfu:peer-joined', () => { if (current?.joined) refreshParticipants(current); });

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
    socket.on('sfu:producer-closed', p => { if (current?.joined) current.session?.producerClosed(p); });
    socket.on('sfu:producer-paused', p => { if (current?.joined) { current.session?.producerPaused(p); refreshParticipants(current); } });
    socket.on('sfu:peer-left', ({ peerId }) => { if (!current?.joined) return; current.session?.removePeer(peerId); removeTile(peerId); refreshParticipants(current); });
    socket.on('disconnect', () => {
      if (current) cleanup(current, 'Connection lost. Call ended.');
      const ids = [...running.keys()]; running.clear(); ids.forEach(changed);
    });

    const ringing = () => current && current.incoming && !current.joined && !current.joining;
    $('callAccept').addEventListener('click', () => { if (ringing()) join(current); });
    $('callDecline').addEventListener('click', () => { if (ringing()) stop(current); });
    $('callHangup').addEventListener('click', () => { if (current) stop(current); });
    // Mute / camera off also pause the stream at the server, so everyone else is told.
    function toggleOwn(kind) {
      const c = current;
      const tracks = (kind === 'audio' ? c?.stream?.getAudioTracks() : c?.stream?.getVideoTracks()) || [];
      if (!tracks.length) return;
      const enabled = !tracks[0].enabled;
      tracks.forEach(t => { t.enabled = enabled; });
      if (kind === 'audio') setCallToggle($('callMute'), !enabled, enabled ? 'Mute' : 'Unmute');
      else setCallToggle($('callCamera'), !enabled, enabled ? 'Turn camera off' : 'Turn camera on');
      setTileState('local', kind, !enabled);
      c.session?.setPaused(kind, !enabled)?.then(() => refreshParticipants(c));
    }
    $('callMute').addEventListener('click', () => toggleOwn('audio'));
    $('callCamera').addEventListener('click', () => toggleOwn('video'));
    $('callScreenShare').addEventListener('click', () => { if (current?.joined) shareScreen(current); });
    $('callStopSharing').addEventListener('click', () => { if (current?.display) stopScreen(current); });
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
