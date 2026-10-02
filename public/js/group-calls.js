(function () {
  'use strict';
  // All calls: 1:1 chats, group chats and channel "Meet now". Everyone's audio and video goes
  // through the SFU (sfu-client.js); the server side is src/group-calls.js. The call panel's
  // maximize/full-screen controls and setCallToggle are in calls.js.
  window.createNovaGroupCalls = function (socket, notify) {
    const panel = document.getElementById('callPanel');
    const $ = id => document.getElementById(id);
    const grid = $('callGrid');
    // Calls are keyed by where they live: 'dm:<conversationId>' (group or 1:1 chat) or 'ch:<channelId>'.
    // The public API also accepts a bare conversation id.
    const keyOf = target => typeof target === 'string' ? target : 'dm:' + Number(target);
    const scopeOf = key => key.startsWith('ch:') ? { channelId: Number(key.slice(3)) } : { conversationId: Number(key.slice(3)) };
    const running = new Map();   // key -> { id, mode, count } for calls in progress
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
    function changed(key) { listeners.forEach(fn => fn(key)); }

    function show(c, text) {
      if (panel.hidden) lastFocus = document.activeElement;
      panel.hidden = false;
      grid.hidden = !c.joined;
      panel.classList.toggle('nc-call-video', !!c.joined);
      fitShareLayout();
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
      $('callRecord').hidden = !c.joined;
      $('callWhiteboard').hidden = !c.joined;
      $('callView').hidden = !c.joined;
      $('callFrame').hidden = !c.joined;
      $('callTogether').hidden = !c.joined || !together.canToggle;
      (ringing ? $('callAccept') : $('callHangup')).focus();
    }
    function kindLabel(c) {
      const presenter = c.screens && [...c.screens.values()].pop();
      return c.display ? 'You are sharing your screen'
        : presenter ? presenter.name + ' is sharing their screen'
        : c.key?.startsWith('ch:') ? 'Meeting in channel'
        : c.direct ? (c.mode === 'video' ? 'Video call' : 'Audio call')
        : c.mode === 'video' ? 'Group video call' : 'Group audio call';
    }

    // Teams-style presentation: a screen someone else shares fills the stage and the gallery
    // becomes a strip down the side (calls.css .nc-call-presenting). The latest share wins.
    // Your own share isn't shown back to you — you keep the gallery, like Teams' presenter view.
    // The whiteboard (whiteboard.js) takes the same stage when it's open and nobody is sharing.
    function renderShare(c) {
      if (current !== c) return;
      const latest = [...c.screens.values()].pop();
      const boardShown = !latest && board.isOpen;
      const togetherShown = !latest && !boardShown && together.isOn; // share > whiteboard > Together mode
      panel.classList.toggle('nc-call-presenting', !!latest || boardShown);
      panel.classList.toggle('nc-call-together', togetherShown);
      $('callShareStage').hidden = !latest;
      $('callBoardStage').hidden = !boardShown;
      $('callTogetherStage').hidden = !togetherShown;
      if (boardShown) requestAnimationFrame(() => board.fit());
      if (togetherShown) requestAnimationFrame(() => together.fit());
      $('callTogether').setAttribute('aria-pressed', String(together.isOn));
      $('callTogether').classList.toggle('nc-active', together.isOn);
      $('callWhiteboard').setAttribute('aria-pressed', String(board.isOpen));
      $('callWhiteboard').classList.toggle('nc-active', board.isOpen);
      if ($('callShareVideo').srcObject !== (latest?.stream || null)) {
        $('callShareVideo').srcObject = latest?.stream || null;
        if (latest) $('callShareVideo').play().catch(() => {});
      }
      $('callKind').textContent = kindLabel(c);
      arrangeTiles();
    }
    async function shareScreen(c, chosen = null) {
      if (!chosen && !navigator.mediaDevices?.getDisplayMedia) return notify(new Error('Screen sharing requires a supported browser over HTTPS.'));
      let display;
      try {
        display = chosen || await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false });
        if (current !== c || !c.joined || !c.session || c.display) { display.getTracks().forEach(t => t.stop()); return; }
        const track = display.getVideoTracks()[0];
        c.display = display;
        track.onended = () => stopScreen(c); // the browser's own "Stop sharing" bar
        await c.session.shareScreen(track);
        $('callScreenShare').hidden = true; $('callStopSharing').hidden = false;
        $('callKind').textContent = kindLabel(c);
        fitShareLayout();
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
      fitShareLayout();
    }

    const allTiles = () => [...grid.querySelectorAll('.nc-video-tile'), ...$('callSelfTile').querySelectorAll('.nc-video-tile'), ...$('callFocusStage').querySelectorAll('.nc-video-tile')];
    let focusPeer = null; // pinned or spotlighted person (call-extras.js onFocus), shown large
    const initials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
    // Teams-style gallery: everyone else shares the stage; your own tile floats small in the corner
    // (and fills the stage while you're alone). A pinned or spotlighted person fills the stage
    // instead and everyone else (you included) sits in the side strip, as with a shared screen —
    // which wins while there is one.
    const moveTile = (t, box) => { if (t.parentNode === box) return; box.appendChild(t); const v = t.querySelector('video'); if (v?.paused) v.play().catch(() => {}); };
    function arrangeTiles() {
      const presenting = panel.classList.contains('nc-call-presenting');
      const stage = $('callFocusStage');
      const focusId = focusPeer && current ? (focusPeer === current.peerId ? 'local' : focusPeer) : null;
      const focused = !presenting && focusId ? allTiles().find(t => t.dataset.peerId === focusId) : null;
      [...stage.querySelectorAll('.nc-video-tile')].forEach(t => { if (t !== focused) moveTile(t, grid); });
      if (focused) moveTile(focused, stage);
      stage.hidden = !focused;
      panel.classList.toggle('nc-call-focus', !!focused);
      const mine = allTiles().find(t => t.dataset.peerId === 'local');
      if (mine && mine !== focused) {
        const others = allTiles().some(t => t.dataset.peerId !== 'local');
        moveTile(mine, others && !presenting && !focused ? $('callSelfTile') : grid);
      }
      fitShareLayout();
      gallery.refresh();
    }
    // While a screen is shared, as in Teams, only people whose camera is on get a tile: no black
    // boxes with initials next to the shared screen (for the viewer, who then sees the screen
    // alone when nobody has video) or in the presenter's call window. The presenter's window
    // shrinks to a small bar (name, timer, controls) while nobody has video, and comes back —
    // maximized again if it was — when the share ends.
    const liveVideo = t => t.classList.contains('nc-has-video') && !t.classList.contains('nc-camera-off');
    function fitShareLayout() {
      const c = current;
      if (!c) return;
      const viewing = panel.classList.contains('nc-call-presenting');
      const presenting = !!c.display && !viewing;
      allTiles().forEach(t => t.classList.toggle('nc-tile-hidden', (viewing || presenting) && !liveVideo(t)));
      const compact = presenting && !allTiles().some(liveVideo);
      if (compact && !c.compact) {
        c.restoreMax = panel.classList.contains('nc-call-max');
        if (c.restoreMax) $('callMaximize').click();
        if (document.fullscreenElement && panel.contains(document.fullscreenElement)) document.exitFullscreen().catch(() => {});
      } else if (!compact && c.compact && c.restoreMax) {
        c.restoreMax = false;
        if (!panel.classList.contains('nc-call-max')) $('callMaximize').click();
      }
      c.compact = compact;
      panel.classList.toggle('nc-call-compact', compact);
      panel.classList.toggle('nc-call-video', !!c.joined && !compact);
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
        v.addEventListener('resize', () => { t.classList.toggle('nc-has-video', v.videoWidth > 0); fitShareLayout(); });
        const overlay = document.createElement('div'); overlay.className = 'nc-video-overlay';
        const label = document.createElement('p'); label.className = 'nc-video-name'; label.textContent = name;
        const mic = document.createElement('i'); mic.className = 'bi bi-mic-mute-fill nc-tile-mic'; mic.setAttribute('role', 'img'); mic.setAttribute('aria-label', 'Muted');
        label.prepend(mic);
        const hand = document.createElement('span'); hand.className = 'nc-tile-hand'; hand.setAttribute('role', 'img'); hand.setAttribute('aria-label', 'Hand raised'); hand.textContent = '✋';
        overlay.append(label); t.append(v, avatar, hand, overlay); grid.append(t);
        extras.decorate(t, id);
        if (!local) current?.session?.watchSize(id, t); // simulcast: receive the size that fits
      }
      const v = t.querySelector('video');
      v.srcObject = media;
      if (!local) NovaDevices.applySpeaker(v);
      // Autoplay with sound can be blocked until the user interacts; offer a play button then.
      v.play().catch(() => { if (current) $('callPlayback').hidden = false; });
      arrangeTiles();
    }
    // Camera off → initials; microphone muted → muted icon on their tile.
    function setTileState(id, kind, paused) {
      const t = allTiles().find(el => el.dataset.peerId === id);
      if (t) t.classList.toggle(kind === 'audio' ? 'nc-mic-off' : 'nc-camera-off', paused);
      fitShareLayout();
    }
    function removeTile(id) { allTiles().find(el => el.dataset.peerId === id)?.remove(); arrangeTiles(); }

    function cleanup(c, message) {
      clearInterval(c.clock);
      c.display?.getTracks().forEach(t => { t.onended = null; t.stop(); }); c.display = null;
      c.pendingDisplay?.getTracks().forEach(t => t.stop()); c.pendingDisplay = null;
      c.session?.close();
      c.stream?.getTracks().forEach(t => t.stop());
      c.effect?.stop(); c.camera?.stop(); c.effect = c.camera = null;
      if (current !== c) return;
      current = null;
      changed(c.key);
      allTiles().forEach(t => t.remove());
      panel.classList.remove('nc-call-video', 'nc-call-presenting', 'nc-call-compact', 'nc-call-focus');
      $('callFocusStage').hidden = true; focusPeer = null;
      extras.stop(); board.stop(); together.stop();
      clearInterval(recTimer); $('callRecBanner').hidden = true; $('callRecord').hidden = true;
      $('callShareStage').hidden = true; $('callShareVideo').srcObject = null; $('callBoardStage').hidden = true; $('callWhiteboard').hidden = true;
      $('callTogetherStage').hidden = true; $('callTogether').hidden = true; panel.classList.remove('nc-call-together');
      $('callView').hidden = true; $('callFrame').hidden = true; gallery.clear();
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
        const stream = await navigator.mediaDevices.getUserMedia({ audio: NovaDevices.audio(), video: c.mode === 'video' ? NovaDevices.video() : false });
        devicePicker.refresh(); // device names are only readable once access is granted
        if (current !== c) { stream.getTracks().forEach(t => t.stop()); return; }
        const cam = stream.getVideoTracks()[0];
        if (cam) { // background blur: show and send the processed camera
          const { track } = await applyBackground(c, cam);
          if (track !== cam) { stream.removeTrack(cam); stream.addTrack(track); }
        }
        c.stream = stream;
        status('Connecting…');
        if (!c.id) {
          const started = await request('gcall:start', { ...scopeOf(c.key), mode: c.mode });
          c.id = started.id; c.mode = started.mode;
          if (current !== c) { stream.getTracks().forEach(t => t.stop()); return; }
        }
        const r = await request('gcall:join', { id: c.id });
        if (current !== c) { request('gcall:leave', { id: c.id }).catch(() => {}); return; }
        c.joined = true; c.joining = false; c.roomId = r.roomId; c.peerId = r.peerId; c.direct = !!r.direct;
        changed(c.key); // the header's Join button hides once we are in
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
        extras.start({ roomId: c.roomId, peerId: c.peerId, userId: window.__NC__?.currentUser?.id ?? null });
        board.start({ roomId: c.roomId, peerId: c.peerId });
        together.start({ roomId: c.roomId });
        request('meet:recording-status', { roomId: c.roomId }).then(({ recording }) => { if (recording && current === c) setRecording(c, recording.recordingId, recording.startTime); }).catch(() => {});
        if (c.pendingDisplay) { const d = c.pendingDisplay; c.pendingDisplay = null; shareScreen(c, d); }
        let started = Date.now();
        const tick = () => {
          const count = running.get(c.key)?.count || 1;
          // A 1:1 call counts from when the other person picks up, like a phone call.
          if (c.direct && count < 2) { started = Date.now(); return status(c.incoming ? 'Connecting…' : 'Calling…'); }
          const secs = Math.floor((Date.now() - started) / 1000), clock = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
          status(c.direct ? 'Connected · ' + clock : (count > 1 ? count + ' in call' : 'Waiting for others to join') + ' · ' + clock);
        };
        tick(); c.clock = setInterval(tick, 1000);
      } catch (e) { if (current === c) stop(c, e.message); }
    }

    // In-call extras (participants, raise hand, reactions, chat, active speaker): call-extras.js.
    const tileFor = peerId => allTiles().find(t => t.dataset.peerId === (peerId === current?.peerId ? 'local' : peerId));
    const extras = createCallExtras({
      socket, request, notify, tiles: allTiles, tileFor, fallbackHost: $('callMedia'),
      reactionHost: () => !$('callShareStage').hidden ? $('callShareStage') : !$('callBoardStage').hidden ? $('callBoardStage') : null,
      els: {
        participantsBtn: $('callParticipants'), participantsBadge: $('callParticipantCount'), participantsPanel: $('callParticipantsPanel'),
        participantCount: $('participantCount'), participantList: $('participantList'), handBtn: $('callHand'),
        reactionsBtn: $('callReactions'), reactionsPanel: $('callReactionsPanel'), reactionGrid: $('reactionGrid'),
        chatBtn: $('callChat'), chatBadge: $('callChatCount'), chatPanel: $('callChatPanel'), chatMessages: $('callChatMessages'),
        chatForm: $('callChatForm'), chatInput: $('callChatInput'), notices: $('callNotices'),
        captionsBtn: $('callCaptions'), captionsBox: $('callCaptionsBox'),
      },
      extraPanels: [[$('callSettings'), $('callSettingsPanel')]],
      micTrack: () => (current?.joined ? current.stream?.getAudioTracks()[0] || null : null),
      onRoomState: state => {
        together.sync({ on: state.together, canToggle: state.canSpotlight });
        if (current?.joined) $('callTogether').hidden = !together.canToggle;
      },
      onFocus: peerId => { focusPeer = peerId; if (current) arrangeTiles(); },
    });

    // Shared whiteboard (whiteboard.js): opens for everyone on the stage, like a shared screen.
    const board = createWhiteboard({
      socket, request, notify, host: $('callBoardStage'),
      onOpenChange: (open, byName) => {
        if (current?.joined) renderShare(current);
        if (byName) extras.notice(byName + (open ? ' opened the whiteboard' : ' closed the whiteboard'));
      },
    });
    $('callWhiteboard').addEventListener('click', () => { if (current?.joined) board.toggle(); });

    // Together mode (together.js): everyone seated in one scene. Its people are the call's tiles
    // (kept playing off-screen, at simulcast's small size, while the scene is shown).
    const together = createTogether({
      socket, request, notify, host: $('callTogetherStage'),
      sources: () => allTiles().map(t => ({
        id: t.dataset.peerId, name: t.dataset.peerId === 'local' ? 'You' : (t.querySelector('.nc-video-name')?.textContent || ''),
        video: t.querySelector('video'), camOff: t.classList.contains('nc-camera-off') || !t.classList.contains('nc-has-video'),
      })),
      onChange: (on, byName) => {
        const c = current;
        if (c?.joined) { renderShare(c); if (c.camera) swapCamera(c, c.camera).catch(e => notify(e)); }
        if (byName) extras.notice(byName + (on ? ' turned on Together mode' : ' turned off Together mode'));
      },
    });
    $('callTogether').addEventListener('click', () => { if (current?.joined) together.toggle(); });

    // Gallery / Large gallery (gallery.js): lays out the call's tiles while nothing else has the stage.
    // Your own tile floats in the corner (callSelfTile) and isn't part of it.
    const gallery = createGallery({
      grid,
      tiles: () => [...grid.querySelectorAll(':scope > .nc-video-tile')],
      active: () => !!current?.joined && !['nc-call-presenting', 'nc-call-focus', 'nc-call-together', 'nc-call-compact'].some(k => panel.classList.contains(k)),
      fixedHeight: () => panel.classList.contains('nc-call-max') || document.fullscreenElement === panel,
      onViewChange: paintView,
    });
    function paintView(view = gallery.view) {
      const next = view === 'large' ? 'Gallery' : 'Large gallery';
      $('callView').title = 'Switch to ' + next + (next === 'Large gallery' ? ' (up to 49 people)' : ' (up to 9 people)');
      $('callView').setAttribute('aria-label', 'Switch to ' + next);
      $('callView').querySelector('i').className = 'bi ' + (view === 'large' ? 'bi-grid' : 'bi-grid-3x3-gap');
    }
    paintView();
    $('callView').addEventListener('click', () => { if (current?.joined) gallery.toggle(); });
    let fitFrame = (() => { try { return localStorage.getItem('nc.callFrame') === 'fit'; } catch { return false; } })();
    function paintFrame() {
      panel.classList.toggle('nc-call-fit', fitFrame);
      $('callFrame').setAttribute('aria-pressed', String(fitFrame));
      $('callFrame').title = fitFrame ? 'Fill frame' : 'Fit to frame';
      $('callFrame').setAttribute('aria-label', $('callFrame').title);
    }
    paintFrame();
    $('callFrame').addEventListener('click', () => {
      fitFrame = !fitFrame;
      try { localStorage.setItem('nc.callFrame', fitFrame ? 'fit' : 'fill'); } catch { /* current call still updates */ }
      paintFrame(); gallery.refresh();
    });

    // Recording (anyone in the call, as in Teams). Everyone sees the banner; when it stops, the video
    // is composed on the server and posted into this chat/channel as a file (meet:recording-ready).
    let recTimer = null;
    function setRecording(c, recordingId, startTime) {
      c.recordingId = recordingId;
      const on = !!recordingId;
      $('callRecord').classList.toggle('nc-active', on);
      $('callRecord').setAttribute('aria-pressed', String(on));
      $('callRecord').title = on ? 'Stop recording' : 'Start recording'; $('callRecord').setAttribute('aria-label', $('callRecord').title);
      $('callRecBanner').hidden = !on;
      clearInterval(recTimer);
      if (on) {
        const tick = () => { const s = Math.max(0, Math.floor((Date.now() - startTime) / 1000)); $('callRecTimer').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
        tick(); recTimer = setInterval(tick, 1000);
      }
    }
    $('callRecord').addEventListener('click', async () => {
      const c = current; if (!c?.joined) return;
      $('callRecord').disabled = true;
      try {
        if (c.recordingId) await request('meet:stop-recording', { roomId: c.roomId, recordingId: c.recordingId });
        else { const r = await request('meet:start-recording', { roomId: c.roomId }); if (current === c && !c.recordingId) setRecording(c, r.recordingId, Date.now()); }
      } catch (e) { notify(e); }
      $('callRecord').disabled = false;
    });
    socket.on('meet:recording-started', ({ roomId, recordingId, startedBy, startTime }) => {
      const c = current; if (!c?.joined || roomId !== c.roomId) return;
      setRecording(c, recordingId, startTime || Date.now());
      extras.notice(startedBy + ' started recording');
    });
    socket.on('meet:recording-stopped', ({ roomId, stoppedBy }) => {
      const c = current; if (!c?.joined || roomId !== c.roomId) return;
      setRecording(c, null);
      extras.notice(stoppedBy + ' stopped recording — it will be posted in the chat');
    });
    socket.on('meet:recording-ready', ({ roomId, failed }) => {
      const c = current; if (!c?.joined || roomId !== c.roomId) return;
      extras.notice(failed ? 'The recording failed: nothing was captured' : 'The recording is ready in the chat');
    });

    // Devices panel (devices.js): switching microphone/camera mid-call replaces the track being sent
    // (same stream, no reconnect) and keeps muted/camera-off as it was; the speaker applies to
    // everyone's sound at once.
    const devicePicker = NovaDevices.bind(
      { audioinput: $('callMicSelect'), videoinput: $('callCameraSelect'), audiooutput: $('callSpeakerSelect') },
      (kind, id) => switchDevice(kind, id).catch(e => notify(e)),
    );
    async function switchDevice(kind, id) {
      const c = current;
      if (kind === 'audiooutput') {
        allTiles().forEach(t => { if (t.dataset.peerId !== 'local') NovaDevices.applySpeaker(t.querySelector('video')); });
        return;
      }
      if (!c?.joined || !c.stream) return; // used next time
      const short = kind === 'audioinput' ? 'audio' : 'video';
      const old = short === 'audio' ? c.stream.getAudioTracks()[0] : c.stream.getVideoTracks()[0];
      if (!old) return; // e.g. choosing a camera during an audio call — used next time
      const size = short === 'video' ? NovaDevices.video() : {}; // keep 720p for simulcast (devices.js)
      const wanted = id ? { ...size, deviceId: { exact: id } } : (short === 'video' ? size : true);
      const fresh = (await navigator.mediaDevices.getUserMedia({ [short]: wanted }))[short === 'audio' ? 'getAudioTracks' : 'getVideoTracks']()[0];
      if (current !== c) { fresh.stop(); return; }
      fresh.enabled = old.enabled; // stay muted / camera-off if you were
      if (short === 'video') { await swapCamera(c, fresh); return; }
      await c.session?.replaceTrack(short, fresh);
      c.stream.removeTrack(old); old.stop(); c.stream.addTrack(fresh);
      showOwnVideo(c);
      extras.micChanged(); // captions follow the new microphone
    }
    const showOwnVideo = c => {
      const mine = allTiles().find(t => t.dataset.peerId === 'local')?.querySelector('video');
      if (mine) mine.srcObject = new MediaStream(c.stream.getTracks());
    };

    // Background blur (background-effects.js): the camera is processed on this device before it is
    // shown and sent. c.camera is the camera itself, c.effect the processing (its track is what's in
    // c.stream and sent). Swapping (new camera, blur on/off) replaces the sent track first, then stops
    // the old processing, so the video doesn't blank in between.
    // While Together mode is on, the camera goes out cut out on green instead (together.js).
    async function applyBackground(c, camera, mode = together.isOn ? 'cutout' : NovaBackground.mode()) {
      const effect = await NovaBackground.process(camera, mode);
      if (effect.error) notify(new Error('Background blur isn\u2019t available in this browser; your camera is shown as it is.'));
      const previous = c.effect; c.effect = effect; c.camera = camera;
      return { track: effect.track, previous };
    }
    async function swapCamera(c, camera) {
      const old = c.stream.getVideoTracks()[0], oldCamera = c.camera;
      const { track, previous } = await applyBackground(c, camera);
      if (current !== c) { track.stop(); return; }
      track.enabled = camera.enabled = old ? old.enabled : true;
      await c.session?.replaceTrack('video', track);
      if (old) c.stream.removeTrack(old);
      c.stream.addTrack(track);
      previous?.stop();
      if (old && old !== track && old !== camera) old.stop();
      if (oldCamera && oldCamera !== camera) oldCamera.stop();
      showOwnVideo(c);
    }
    const bgSelect = $('callBackgroundSelect');
    $('callBackgroundRow').hidden = !NovaBackground.available;
    bgSelect.value = NovaBackground.mode();
    bgSelect.addEventListener('change', () => {
      NovaBackground.setMode(bgSelect.value);
      const c = current;
      if (c?.joined && c.camera) swapCamera(c, c.camera).catch(e => notify(e));
    });

    socket.on('gcall:incoming', data => {
      if (current) return;
      const c = current = { id: data.id, key: 'dm:' + Number(data.conversationId), mode: data.mode, title: data.title || 'Group call', direct: !!data.direct, incoming: true };
      show(c, data.direct ? 'Incoming ' + (data.mode === 'video' ? 'video' : 'audio') + ' call' : data.caller.name + ' is calling the group');
    });
    // Nobody picked up in time on this tab, or this person answered in another tab.
    socket.on('gcall:ring-stop', ({ id }) => { if (current?.id === id && !current.joined && !current.joining) cleanup(current); });
    socket.on('gcall:answered', ({ id, socketId }) => {
      if (current?.id === id && socketId !== socket.id && !current.joined && !current.joining) cleanup(current);
    });
    // The call ended for everyone (last person left; a 1:1 call was declined, unanswered or hung up).
    const SAY_WHY = new Set(['Call declined', 'No answer']);
    socket.on('gcall:ended', ({ id, reason }) => {
      if (current?.id !== id) return;
      const say = reason === 'The server is restarting' ? (current.joined ? 'The call ended because the server is restarting.' : null)
        : !current.incoming && SAY_WHY.has(reason) ? reason : null;
      cleanup(current, say);
    });
    // Chats/channels whose header asked whether a call is running there. Opening the app straight
    // onto one asks before the connection is up, and a call can start or end while it's down, so
    // ask again for each whenever the connection (re)opens.
    const watched = new Set();
    socket.on('connect', () => watched.forEach(key => api.refresh(key)));
    socket.on('gcall:state', ({ conversationId, channelId, call }) => {
      const key = channelId ? 'ch:' + Number(channelId) : 'dm:' + Number(conversationId);
      if (call) running.set(key, call); else running.delete(key);
      changed(key);
    });
    socket.on('sfu:new-producer', p => { if (current?.joined) current.session?.newProducer(p); });
    // The call's chat is the chat/channel it belongs to: messages posted there during the call show
    // in the call too. (Messages sent from the call are saved there already and arrive via sfu:chat.)
    socket.on('message:new', msg => {
      const c = current;
      if (!c?.joined || msg.parent_message_id || msg.metadata?.callChat || msg.metadata?.call) return;
      const key = msg.channel_id ? 'ch:' + msg.channel_id : 'dm:' + msg.conversation_id;
      if (key === c.key && msg.body) extras.addExternal({ userId: msg.author?.id, fullName: msg.author?.full_name || 'Someone', text: msg.body, messageId: msg.id });
    });
    socket.on('sfu:producer-closed', p => { if (current?.joined) current.session?.producerClosed(p); });
    socket.on('sfu:producer-paused', p => { if (current?.joined) current.session?.producerPaused(p); });
    socket.on('sfu:peer-left', ({ peerId }) => { if (!current?.joined) return; current.session?.removePeer(peerId); removeTile(peerId); });
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
      if (kind === 'video' && c.camera) c.camera.enabled = enabled; // the camera behind a blurred track
      if (kind === 'audio') setCallToggle($('callMute'), !enabled, enabled ? 'Mute' : 'Unmute');
      else setCallToggle($('callCamera'), !enabled, enabled ? 'Turn camera off' : 'Turn camera on');
      setTileState('local', kind, !enabled);
      if (kind === 'audio') extras.micChanged(); // no captions of you while muted
      c.session?.setPaused(kind, !enabled)?.then(() => extras.refresh());
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

    const api = {
      active: () => !!current,
      // Targets are a conversation id, or a key: 'dm:<conversationId>' / 'ch:<channelId>'.
      keyOf,
      // The call in progress there, if any: { id, mode, count }.
      running: target => running.get(keyOf(target)) || null,
      inCall: target => !!current?.joined && current.key === keyOf(target),
      onChange(fn) { listeners.add(fn); },
      async refresh(target) {
        const key = keyOf(target);
        watched.add(key);
        if (!socket.connected) return; // asked again once connected (below)
        try {
          const { call } = await request('gcall:status', scopeOf(key));
          if (call) running.set(key, call); else running.delete(key);
          changed(key);
        } catch { /* the header just won't show a Join button */ }
      },
      // Starts a call there, or joins the one already running there.
      start(target, mode, title, { display = null } = {}) {
        const key = keyOf(target);
        if (current) {
          display?.getTracks().forEach(t => t.stop());
          return notify(new Error(current?.key === key && current.joined ? 'You are already in this call.' : 'Finish your current call first.'));
        }
        const existing = running.get(key);
        const c = current = { id: existing?.id || null, key, mode: existing?.mode || mode, title, incoming: false, pendingDisplay: display };
        join(c);
      },
      // Share your screen: in the call you're in there, or start a video call by sharing. The screen
      // is chosen first, because browsers only open the picker straight after a click.
      async share(target, title) {
        const key = keyOf(target);
        if (current?.joined && current.key === key) return shareScreen(current);
        if (current) return notify(new Error('Finish your current call first.'));
        if (!navigator.mediaDevices?.getDisplayMedia) return notify(new Error('Screen sharing requires a supported browser over HTTPS.'));
        let display;
        try { display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false }); }
        catch (e) { if (e.name !== 'NotAllowedError') notify(e); return; }
        this.start(key, 'video', title, { display });
      },
    };
    return api;
  };
})();
