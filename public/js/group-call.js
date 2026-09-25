(function () {
  'use strict';

  window.createGroupCall = function (socket, notify) {
    const panel = document.getElementById('callPanel');
    const $ = id => document.getElementById(id);
    const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

    let current = null;
    let localStream = null;
    let screenStream = null;
    let sfuRoomId = null;
    let localPeerId = null;
    let peers = new Map(); // peerId -> { transports, producers, consumers, name, userId, fullName }
    let localRtpCapabilities = null;
    let iceServers = [];
    let lastFocus = null;
    let raisedHand = false;
    let screenSharing = false;

    const grid = $('callGrid');
    const media1to1 = $('callMedia1to1');
    const template = document.getElementById('videoTileTemplate');

    // Helpers
    function request(event, data) {
      return new Promise((resolve, reject) => {
        if (!socket.connected) return reject(new Error('Connection lost. Please reconnect.'));
        socket.timeout(15000).emit(event, data, (err, reply) => {
          if (err || !reply?.ok) reject(new Error(reply?.error || 'Request timed out.'));
          else resolve(reply);
        });
      });
    }

    function status(text) { $('callStatus').textContent = text; }

    function getRtpCapabilities() {
      const pc = new RTCPeerConnection();
      const caps = RTCRtpSender.getCapabilities('video');
      pc.close();
      return caps;
    }

    function show(c) {
      lastFocus = document.activeElement;
      const panel = document.getElementById('callPanel');
      panel.hidden = false;
      $('callName').textContent = c.name;
      $('callKind').textContent = c.mode === 'video' ? 'Group video call' : 'Group audio call';
      status(c.incoming ? 'Incoming group call…' : 'Joining…');
      $('callAccept').hidden = !c.incoming;
      $('callDecline').hidden = !c.incoming;
      $('callHangup').hidden = c.incoming;
      $('callMute').hidden = false;
      $('callCamera').hidden = !c.camera;
      $('callScreenShare').hidden = false;
      $('callStopSharing').hidden = true;
      $('callAccept').disabled = false;
      $('callMute').textContent = 'Mute';
      $('callMute').setAttribute('aria-pressed', 'false');
      $('callCamera').textContent = 'Turn camera off';
      $('callCamera').setAttribute('aria-pressed', 'false');
      $('callScreenShare').textContent = 'Share screen';
      (c.incoming ? $('callAccept') : $('callHangup')).focus();
    }

    function cleanup(c, message) {
      clearTimeout(c.timer);
      clearInterval(c.clock);
      c.pc?.close?.();
      if (localStream) localStream.getTracks().forEach(t => t.stop());
      if (screenStream) screenStream.getTracks().forEach(t => t.stop());
      if (c.pc) c.pc.close();
      if (screenStream) screenStream.getTracks().forEach(t => t.stop());

      if (current !== c) return;
      current = null;
      peers.clear();
      sfuRoomId = null;
      localPeerId = null;
      localRtpCapabilities = null;
      iceServers = [];
      raisedHand = false;
      screenSharing = false;

      const grid = document.getElementById('callGrid');
      const media1to1 = document.getElementById('callMedia1to1');
      grid.hidden = true;
      grid.innerHTML = '';
      document.getElementById('callMedia1to1').hidden = true;
      document.getElementById('callMedia1to1').innerHTML = '';
      panel.hidden = true;

      if (lastFocus?.isConnected) lastFocus.focus();
      if (message) notify(new Error(message));
    }

    function stop(c, message) {
      if (c.id) request(c.incoming && !c.accepted ? 'sfu:leave' : 'sfu:leave', { roomId: sfuRoomId }).catch(() => {});
      cleanup(c, message);
    }

    function supported() {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Open NovaConnect over HTTPS to use your microphone and camera.');
      if (!window.RTCPeerConnection) throw new Error('Your browser does not support calling.');
    }

    // --- SFU Signaling ---
    function sfuRequest(event, data) {
      return new Promise((resolve, reject) => {
        if (!socket.connected) return reject(new Error('Connection lost.'));
        socket.timeout(15000).emit(event, data, (err, reply) => {
          if (err || !reply?.ok) reject(new Error(reply?.error || 'SFU request failed.'));
          else resolve(reply);
        });
      });
    }

    async function joinSfuRoom(c) {
      const mode = c.mode;
      const name = c.name;
      sfuRoomId = `group:${c.conversationId || c.id}`;
      localPeerId = `${c.userId || 'local'}-${Math.random().toString(36).slice(2)}`;

      // Get RTP capabilities
      localRtpCapabilities = getRtpCapabilities();

      // Join SFU room
      const joinResult = await sfuRequest('sfu:join', { roomId: sfuRoomId });
      if (!joinResult.ok) throw new Error(joinResult.error);

      iceServers = joinResult.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
      const routerRtpCapabilities = joinResult.routerRtpCapabilities;

      // Create WebRTC transport for sending
      const sendTransportInfo = await sfuRequest('sfu:create-transport', { roomId: sfuRoomId, direction: 'send' });
      const sendTransport = createSendTransport(sendTransportInfo);

      // Create recv transport
      const recvTransportInfo = await sfuRequest('sfu:create-transport', { roomId: sfuRoomId, direction: 'recv' });
      const recvTransport = createRecvTransport(recvTransportInfo);

      // Get local stream
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: c.mode === 'video' });
      localStream = stream;

      // Produce audio and video
      for (const track of stream.getTracks()) {
        const producerId = await sfuRequest('sfu:produce', {
          roomId: sfuRoomId,
          transportId: sendTransportInfo.id,
          kind: track.kind,
          rtpParameters: track.kind === 'video' ? getVideoRtpParameters(track) : getAudioRtpParameters(track),
          appData: { sourcePeerId: localPeerId, sourceUserId: c.userId, sourceFullName: c.name }
        });
      }

      // Consume existing producers in the room
      // This would be handled by the server sending existing producers on join
    }

    function createSendTransport(info) {
      const pc = new RTCPeerConnection({ iceServers });
      pc.ondatachannel = () => {};
      return pc;
    }

    function createRecvTransport(info) {
      const pc = new RTCPeerConnection({ iceServers });
      return pc;
    }

    function getVideoRtpParameters(track) {
      return {
        codecs: [{
          mimeType: 'video/VP8',
          clockRate: 90000,
          parameters: {}
        }],
        headerExtensions: [
          { uri: 'urn:ietf:params:rtp-hdrext:sdes:mid' },
          { uri: 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id' },
          { uri: 'urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id' }
        ],
        rtcp: { cname: localPeerId }
      };
    }

    function getAudioRtpParameters(track) {
      return {
        codecs: [{
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
          parameters: {}
        }],
        headerExtensions: [
          { uri: 'urn:ietf:params:rtp-hdrext:sdes:mid' },
          { uri: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level' }
        ],
        rtcp: { cname: localPeerId }
      };
    }

    // --- UI: Video Grid ---
    function addVideoTile(peerId, name, stream, isLocal = false) {
      const grid = document.getElementById('callGrid');
      const template = document.getElementById('videoTileTemplate');
      const tile = template.content.cloneNode(true);
      const section = tile.querySelector('.nc-video-tile');
      section.dataset.peerId = peerId;

      const video = section.querySelector('video');
      video.srcObject = stream;
      video.muted = isLocal;
      video.play().catch(() => {});

      section.querySelector('.nc-video-name').textContent = name + (isLocal ? ' (You)' : '');
      section.querySelector('.nc-muted-badge').hidden = true;
      section.querySelector('.nc-speaking-indicator').hidden = true;
      section.querySelector('.nc-pinned-badge').hidden = true;
      section.querySelector('.nc-hand-raised').hidden = true;

      // Audio level monitoring
      if (!isLocal) {
        const audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const checkAudio = () => {
          if (!current) return;
          analyser.getByteFrequencyData(dataArray);
          const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
          const indicator = document.querySelector(`.nc-video-tile[data-peer-id="${peerId}"] .nc-speaking-indicator`);
          if (indicator) indicator.hidden = avg < 5;
        };
        setInterval(checkAudio, 100);
      }

      grid.appendChild(section);
      updateGridLayout();
    }

    function removeVideoTile(peerId) {
      const tile = document.querySelector(`.nc-video-tile[data-peer-id="${peerId}"]`);
      if (tile) tile.remove();
      updateGridLayout();
    }

    function updateGridLayout() {
      const gridEl = document.getElementById('callGrid');
      const tiles = gridEl.querySelectorAll('.nc-video-tile');
      const count = tiles.length;
      if (count === 0) {
        gridEl.hidden = true;
      } else {
        gridEl.hidden = false;
        gridEl.style.gridTemplateColumns = `repeat(${Math.min(count, 4)}, 1fr)`;
      }
    }

    function showLocalVideo(stream) {
      const localVideo = document.getElementById('callLocal');
      localVideo.srcObject = stream;
      localVideo.hidden = false;
    }

    function updateParticipantList() {
      const list = document.getElementById('participantList');
      const count = peers.size + 1; // +1 for local
      const badge = document.getElementById('participantCount');
      badge.textContent = count;
      badge.hidden = count === 0;

      list.innerHTML = '';
      // Add local user
      const localPeer = peers.get(localPeerId) || { name: 'You (me)', userId: 'local' };
      const localItem = createParticipantItem('local', localPeer.name + ' (You)', true, false, false, false);
      list.appendChild(localItem);

      for (const [peerId, peer] of peers) {
        if (peerId === localPeerId) continue;
        const item = createParticipantItem(peerId, peer.fullName || peer.name, false, peer.muted, peer.raisedHand, peer.pinned);
        list.appendChild(item);
      }
      document.getElementById('participantCount').textContent = peers.size + 1;
    }

    function createParticipantItem(peerId, name, isLocal, muted, raisedHand, pinned) {
      const item = document.createElement('div');
      item.className = 'nc-participant-item';
      item.dataset.peerId = peerId;
      item.innerHTML = `
        <div class="nc-participant-avatar">${name.charAt(0).toUpperCase()}</div>
        <div class="nc-participant-info">
          <span class="nc-participant-name">${name}${isLocal ? ' (You)' : ''}</span>
          <div class="nc-participant-status">
            ${muted ? '<span class="nc-status-muted">🔇 Muted</span>' : ''}
            ${raisedHand ? '<span class="nc-status-raised">✋ Raised hand</span>' : ''}
            ${pinned ? '<span class="nc-status-pinned">📌 Pinned</span>' : ''}
          </div>
        </div>
        <div class="nc-participant-actions">
          ${!isLocal ? `
            <button class="nc-btn-icon" aria-label="Pin" title="Pin"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 17v5"/><path d="M9 12l3 3 3-3"/></svg></button>
            <button class="nc-btn-icon" aria-label="Mute" title="Mute"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/></svg></button>
          ` : ''}
        </div>
      `;
      return item;
    }

    // --- Panel Toggles ---
    function togglePanel(panelId, buttonId) {
      const panel = document.getElementById(panelId);
      const button = document.getElementById(buttonId);
      const isHidden = panel.hidden;
      panel.hidden = !isHidden;
      button.setAttribute('aria-expanded', String(!isHidden));
      if (!isHidden) {
        // Focus first focusable element
        const focusable = panel.querySelector('button, input, select, [tabindex]:not([tabindex="-1"])');
        if (focusable) focusable.focus();
      }
    }

    // --- Reactions ---
    const reactions = ['👍', '👎', '❤️', '😂', '😮', '😢', '🎉', '🙏', '👏', '🔥'];
    function renderReactions() {
      const grid = document.getElementById('reactionGrid');
      grid.innerHTML = '';
      for (const emoji of reactions) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nc-reaction-btn';
        btn.textContent = emoji;
        btn.title = emoji;
        btn.onclick = () => sendReaction(emoji);
        grid.appendChild(btn);
      }
    }

    function sendReaction(emoji) {
      if (!current || !sfuRoomId) return;
      socket.emit('sfu:reaction', { roomId: sfuRoomId, reaction: emoji });
      togglePanel('callReactionsPanel', 'callReactions');
    }

    // --- Chat ---
    function renderChatMessages() {
      const container = document.getElementById('callChatMessages');
      // Chat messages would be stored in current.chatMessages
      if (!current.chatMessages) return;
      container.innerHTML = '';
      for (const msg of current.chatMessages) {
        const div = document.createElement('div');
        div.className = 'nc-chat-message' + (msg.isLocal ? ' local' : '');
        div.innerHTML = `<span class="nc-chat-sender">${msg.sender}</span><span class="nc-chat-text">${escapeHtml(msg.text)}</span><span class="nc-chat-time">${formatTime(msg.time)}</span>`;
        container.appendChild(div);
      }
      container.scrollTop = container.scrollHeight;
    }

    function sendChatMessage(text) {
      if (!current || !sfuRoomId || !text.trim()) return;
      socket.emit('sfu:chat', { roomId: sfuRoomId, text });
      // Add locally
      if (!current.chatMessages) current.chatMessages = [];
      current.chatMessages.push({ sender: 'You', text, time: Date.now(), isLocal: true });
      renderChatMessages();
      document.getElementById('callChatInput').value = '';
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function formatTime(ts) {
      const d = new Date(ts);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    // --- Settings ---
    function loadSettings() {
      // Load from localStorage
      const saved = localStorage.getItem('novaconnect-call-settings');
      if (saved) {
        try {
          const settings = JSON.parse(saved);
          applySettings(settings);
        } catch {}
      }
    }

    function applySettings(settings) {
      // Apply to local stream
      if (localStream) {
        const audioTracks = localStream.getAudioTracks();
        if (audioTracks[0]) {
          audioTracks[0].applyConstraints({
            echoCancellation: settings.echoCancellation,
            noiseSuppression: settings.noiseSuppression,
            autoGainControl: settings.autoGainControl,
            volume: settings.inputVolume / 100
        });
        }
        const videoTracks = localStream.getVideoTracks();
        if (videoTracks[0]) {
          videoTracks[0].applyConstraints({
            width: { ideal: parseInt(settings.resolution?.split('x')[0]) },
            height: { ideal: parseInt(settings.resolution?.split('x')[1]) },
            frameRate: { ideal: parseInt(settings.frameRate) }
        });
        }
      }
    }

    function saveSettings() {
      const settings = {
        echoCancellation: document.getElementById('settingEchoCancellation').checked,
        noiseSuppression: document.getElementById('settingNoiseSuppression').checked,
        autoGainControl: document.getElementById('settingAutoGainControl').checked,
        inputVolume: parseInt(document.getElementById('settingInputVolume').value),
        resolution: document.getElementById('settingResolution').value,
        frameRate: parseInt(document.getElementById('settingFrameRate').value),
        mirrorVideo: document.getElementById('settingMirrorVideo').checked,
        hardwareAcceleration: document.getElementById('settingHardwareAcceleration').checked
      };
      localStorage.setItem('novaconnect-call-settings', JSON.stringify(settings));
    }

    // --- Event Handlers ---
    function handleRemoteProducer(peerId, producerId, kind, appData) {
      // Consume the remote producer
      // This would be triggered by 'sfu:new-producer' event
    }

    function handlePeerLeft(peerId) {
      peers.delete(peerId);
      removeVideoTile(peerId);
      updateParticipantList();
    }

    function handlePeerJoined(peerId, userId, fullName) {
      peers.set(peerId, { name: fullName, userId, muted: false, raisedHand: false, pinned: false });
      updateParticipantList();
    }

    // --- Socket Event Handlers ---
    function setupSocketHandlers() {
      socket.on('sfu:peer-joined', ({ peerId, userId, fullName }) => {
        if (peerId === localPeerId) return;
        handlePeerJoined(peerId, userId, fullName);
      });

      socket.on('sfu:peer-left', ({ peerId, userId, fullName }) => {
        handlePeerLeft(peerId);
      });

      socket.on('sfu:new-producer', ({ producerId, peerId, userId, fullName, kind }) => {
        // Handle new producer from remote peer
        // We would need to consume this producer
      });

      socket.on('sfu:reaction', ({ peerId, reaction }) => {
        // Show reaction animation on peer's tile
        const tile = document.querySelector(`.nc-video-tile[data-peer-id="${peerId}"]`);
        if (tile) {
          const indicator = tile.querySelector('.nc-reaction-pop');
          // Show reaction animation
        }
      });

      socket.on('sfu:chat', ({ peerId, text, sender }) => {
        if (!current.chatMessages) current.chatMessages = [];
        current.chatMessages.push({ sender, text, time: Date.now(), isLocal: false });
        renderChatMessages();
        if (document.getElementById('callChatPanel').hidden) {
          document.getElementById('chatCount').textContent = parseInt(document.getElementById('chatCount').textContent || 0) + 1;
          document.getElementById('chatCount').hidden = false;
        }
      });

      socket.on('sfu:hand-raised', ({ peerId, raised }) => {
        const tile = document.querySelector(`.nc-video-tile[data-peer-id="${peerId}"]`);
        if (tile) {
          tile.querySelector('.nc-hand-raised').hidden = !raised;
        }
        const peer = peers.get(peerId);
        if (peer) peer.raisedHand = raised;
        updateParticipantList();
      });

      socket.on('sfu:hand-lowered', ({ peerId }) => {
        const tile = document.querySelector(`.nc-video-tile[data-peer-id="${peerId}"]`);
        if (tile) {
          tile.querySelector('.nc-hand-raised').hidden = true;
        }
        const peer = peers.get(peerId);
        if (peer) peer.raisedHand = false;
        updateParticipantList();
      });

      socket.on('sfu:pin', ({ peerId, pinned }) => {
        const tile = document.querySelector(`.nc-video-tile[data-peer-id="${peerId}"]`);
        if (tile) {
          tile.querySelector('.nc-pinned-badge').hidden = !pinned;
        }
      });
    }

    // --- Public API ---
    async function start(conversationId, mode, name) {
      if (current) return notify(new Error('Finish your current call first.'));
      const c = current = { mode, name, conversationId, queue: Promise.resolve() };
      show(c, 'Joining group call…');
      try {
        await joinSfuRoom(c);
        if (current !== c) return;
        // Call started successfully
        status('Connected');
      } catch (e) {
        stop(c, e.message);
      }
    }

    // Return public API
    return {
      start,
      stop: () => { if (current) stop(current); },
      toggleMute: () => {
        const tracks = localStream?.getAudioTracks() || [];
        const enabled = !tracks[0]?.enabled;
        tracks.forEach(t => t.enabled = enabled);
        document.getElementById('callMute').textContent = tracks[0]?.enabled ? 'Mute' : 'Unmute';
        document.getElementById('callMute').setAttribute('aria-pressed', String(!tracks[0]?.enabled));
      },
      toggleCamera: () => {
        const tracks = localStream?.getVideoTracks() || [];
        const enabled = !tracks[0]?.enabled;
        tracks.forEach(t => t.enabled = enabled);
        document.getElementById('callCamera').textContent = tracks[0]?.enabled ? 'Turn camera off' : 'Turn camera on';
        document.getElementById('callCamera').setAttribute('aria-pressed', String(!tracks[0]?.enabled));
      },
      toggleScreenShare: () => {
        // Screen share implementation
      },
      togglePanel: (panelId, buttonId) => togglePanel(panelId, buttonId),
      sendReaction,
      sendChatMessage: (text) => { sendChatMessage(text); },
      raiseHand: () => {
        raisedHand = !raisedHand;
        socket.emit('sfu:hand-raised', { roomId: sfuRoomId, raised: raisedHand });
      },
      leave: () => { if (current) stop(current); }
    };
  };
})();