(function () {
  'use strict';
  // Mute/camera buttons show an icon; these keep the icon, label and pressed state in sync.
  // Shared with group-calls.js, which uses the same call panel.
  window.setCallToggle = function (button, off, label) {
    button.setAttribute('aria-pressed', String(off));
    button.setAttribute('aria-label', label); button.title = label;
    const [on, offIcon] = button.querySelectorAll('svg');
    if (on && offIcon) { on.hidden = off; offIcon.hidden = !off; } else button.textContent = label;
  };
  // Call panel view controls, shared by 1:1 and group calls: Maximize fills the window, Full
  // screen uses the whole display, and double-clicking any video shows just that video full screen.
  document.addEventListener('DOMContentLoaded', () => {
    const panel = document.getElementById('callPanel');
    const max = document.getElementById('callMaximize'), full = document.getElementById('callFullscreen');
    if (!panel || !max || !full) return;
    const setMax = on => {
      panel.classList.toggle('nc-call-max', on);
      max.setAttribute('aria-pressed', String(on));
      max.title = on ? 'Restore' : 'Maximize'; max.setAttribute('aria-label', on ? 'Restore call size' : 'Maximize call');
      max.querySelector('.icon-max').hidden = on; max.querySelector('.icon-restore').hidden = !on;
    };
    max.onclick = () => setMax(!panel.classList.contains('nc-call-max'));
    full.hidden = !document.fullscreenEnabled;
    full.onclick = () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else panel.requestFullscreen().catch(() => {}); };
    document.addEventListener('fullscreenchange', () => {
      const on = !!document.fullscreenElement && panel.contains(document.fullscreenElement);
      full.title = on ? 'Exit full screen' : 'Full screen'; full.setAttribute('aria-label', full.title);
    });
    panel.addEventListener('dblclick', e => {
      const video = e.target.closest('video');
      if (!video || !document.fullscreenEnabled) return;
      if (document.fullscreenElement === video) document.exitFullscreen().catch(() => {});
      else video.requestFullscreen().catch(() => {});
    });
    // A call ending hides the panel: leave full screen and go back to the normal size.
    new MutationObserver(() => {
      if (!panel.hidden) return;
      if (document.fullscreenElement && panel.contains(document.fullscreenElement)) document.exitFullscreen().catch(() => {});
      setMax(false);
    }).observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  });
  window.createNovaCalls = function (socket, notify, { otherCallActive = () => false } = {}) {
    const panel = document.getElementById('callPanel');
    const $ = id => document.getElementById(id);
    let current = null;
    let lastFocus;
    function request(event, data) {
      return new Promise((resolve, reject) => {
        if (!socket.connected) return reject(new Error('Connection lost. Please reconnect.'));
        socket.timeout(10000).emit(event, data, (err, reply) => {
          if (err || !reply?.ok) reject(new Error(reply?.error || 'Call request timed out.'));
          else resolve(reply);
        });
      });
    }
    function status(text) { $('callStatus').textContent = text; }
    function show(c, text) {
      lastFocus = document.activeElement;
      panel.hidden = false;
      $('callGrid').hidden = true; $('callMedia1to1').hidden = false;
      arrange(c);
      $('callName').textContent = c.name;
      $('callKind').textContent = c.mode === 'video' ? 'Video call' : 'Audio call';
      status(text);
      $('callAccept').hidden = !c.incoming;
      $('callDecline').hidden = !c.incoming;
      $('callHangup').hidden = c.incoming;
      $('callMute').hidden = true;
      $('callCamera').hidden = true;
      $('callPlayback').hidden = true;
      $('callStopSharing').hidden = true;
      $('callScreenShare').hidden = true;
      $('callAccept').disabled = false;
      setCallToggle($('callMute'), false, 'Mute');
      setCallToggle($('callCamera'), false, 'Turn camera off');
      (c.incoming ? $('callAccept') : $('callHangup')).focus();
    }
    // Teams-style 1:1 layout. One video fills the stage — a screen the other person shares, else
    // their camera, else (until their picture arrives) your own camera — and the rest float as small
    // tiles in the corner: your camera, their camera while they share, a preview of what you share.
    // Everything else is parked: rendered but invisible, so a remote video can be seen to start
    // (a remote track can report itself live without any picture, e.g. in audio calls).
    const hasPicture = v => !!v.srcObject && v.videoWidth > 0;
    function arrange(c) {
      if (current !== c) return;
      const remoteCam = hasPicture($('callRemote')) && !c.remoteCameraOff;
      const remoteScreen = !!c.remoteSharing && hasPicture($('callRemoteScreen'));
      const myCam = !!c.camera && c.camera.readyState === 'live' && c.camera.enabled;
      if (remoteCam) c.remoteSeen = true;
      // Your own camera only fills the stage until their picture first appears (like Teams' preview).
      const main = remoteScreen ? $('callRemoteScreen') : remoteCam ? $('callRemote')
        : myCam && !c.display && !c.remoteSeen ? $('callLocal') : null;
      const tiles = [
        remoteScreen && remoteCam ? $('callRemote') : null,
        myCam && main !== $('callLocal') ? $('callLocal') : null,
        c.display ? $('callLocalScreen') : null,
      ].filter(Boolean);
      const place = (v, box) => { if (v.parentNode !== box) box.appendChild(v); if (v.paused && v.srcObject) v.play().catch(() => {}); };
      for (const v of [$('callRemote'), $('callRemoteScreen'), $('callLocal'), $('callLocalScreen')]) {
        if (v === main) place(v, $('callStageMain'));
        else if (tiles.includes(v)) place(v, $('callTiles'));
        else place(v, $('callPark'));
      }
      tiles.forEach(v => $('callTiles').appendChild(v)); // keep tile order
      panel.classList.toggle('nc-call-video', !!(main || tiles.length));
      $('callKind').textContent = c.display ? 'You are sharing your screen'
        : c.remoteSharing ? c.name + ' is sharing their screen'
        : c.mode === 'video' ? 'Video call' : 'Audio call';
    }
    function announceShare(c) {
      arrange(c);
      if (c.id && c.pc?.connectionState === 'connected') request('call:share', { id: c.id, sharing: !!c.display }).catch(() => {});
    }
    function cleanup(c, message) {
      clearTimeout(c.timer); clearTimeout(c.disconnectTimer); clearInterval(c.clock);
      c.pc?.close(); c.camera?.stop(); c.stream?.getTracks().forEach(t => t.stop()); c.display?.getTracks().forEach(t => t.stop());
      if (current !== c) return;
      current = null;
      panel.classList.remove('nc-call-video');
      for (const id of ['callLocal', 'callLocalScreen', 'callRemote', 'callRemoteScreen', 'callRemoteAudio']) $(id).srcObject = null;
      for (const id of ['callLocal', 'callLocalScreen', 'callRemote', 'callRemoteScreen']) $('callPark').appendChild($(id));
      panel.hidden = true;
      if (lastFocus?.isConnected) lastFocus.focus();
      if (message) notify(new Error(message));
    }
    function stop(c, message) {
      if (c.id) request(c.incoming && !c.accepted ? 'call:decline' : 'call:end', { id: c.id }).catch(() => {});
      cleanup(c, message);
    }
    function supported() {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Open NovaConnect over HTTPS to use your microphone and camera.');
      if (!window.RTCPeerConnection) throw new Error('Your browser does not support calling.');
    }
    async function prepare(c) {
      supported();
      const config = await request('call:config', {});
      if (current !== c) return false;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: c.mode === 'video' && !c.display });
      if (current !== c) { stream.getTracks().forEach(t => t.stop()); return false; }
      c.stream = stream;
      c.camera = stream.getVideoTracks()[0] || null;
      c.screenStream = new MediaStream();
      if (c.display) {
        const screen = c.display.getVideoTracks()[0];
        if (!screen || screen.readyState === 'ended') throw new Error('Screen sharing was cancelled.');
        screen.onended = () => stopSharing(c);
        $('callLocalScreen').srcObject = c.display;
        $('callStopSharing').hidden = false;
      }
      if (c.camera) $('callLocal').srcObject = new MediaStream([c.camera]);
      $('callMute').hidden = false;
      $('callCamera').hidden = !c.camera;
      $('callScreenShare').hidden = !navigator.mediaDevices.getDisplayMedia;
      const pc = c.pc = new RTCPeerConnection({ iceServers: config.iceServers });
      c.candidates = [];
      // Media slots, in this order on both sides: audio, camera video, screen video. The screen has
      // its own slot so sharing never replaces the camera (both are seen, as in Teams), and both
      // video slots exist from the start so sharing needs no renegotiation. The caller creates them
      // all; the callee's slots come from the offer (see description()).
      const audio = stream.getAudioTracks()[0];
      if (audio) pc.addTrack(audio, stream);
      if (c.camera) c.videoSender = pc.addTrack(c.camera, stream);
      if (!c.incoming) {
        if (!c.videoSender) c.videoSender = pc.addTransceiver('video', { direction: 'sendrecv', streams: [stream] }).sender;
        c.screenSender = pc.addTransceiver('video', { direction: 'sendrecv', streams: [c.screenStream] }).sender;
        if (c.display) await c.screenSender.replaceTrack(c.display.getVideoTracks()[0]);
      }
      arrange(c);
      pc.onicecandidate = ({ candidate }) => {
        if (candidate && current === c && c.id) request('call:signal', { id: c.id, signal: { candidate: candidate.toJSON() } }).catch(e => { if (current === c) stop(c, e.message); });
      };
      pc.ontrack = ({ track, transceiver }) => {
        // Sound plays through its own <audio> element, never through a video element: a video
        // element that isn't shown doesn't play, which on macOS also left the microphone silent.
        if (track.kind === 'audio') {
          $('callRemoteAudio').srcObject = new MediaStream([track]);
          $('callRemoteAudio').play().then(() => { if (current === c) $('callPlayback').hidden = true; }).catch(() => { if (current === c && $('callRemoteAudio').paused) $('callPlayback').hidden = false; });
          return;
        }
        // The first video slot is their camera, the second their screen.
        const videoSlots = pc.getTransceivers().filter(t => t.receiver.track.kind === 'video' && t.mid !== null).sort((a, b) => Number(a.mid) - Number(b.mid));
        const el = videoSlots.indexOf(transceiver) === 1 ? $('callRemoteScreen') : $('callRemote');
        el.srcObject = new MediaStream([track]);
        el.play().catch(() => {});
      };
      pc.onconnectionstatechange = () => {
        if (current !== c) return;
        if (pc.connectionState === 'connected') {
          clearTimeout(c.timer); clearTimeout(c.disconnectTimer);
          request('call:connected', { id: c.id }).catch(e => { if (current === c) stop(c, e.message); });
          c.started = c.started || Date.now();
          const tick = () => {
            const secs = Math.floor((Date.now() - c.started) / 1000);
            status('Connected · ' + Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0'));
          };
          clearInterval(c.clock); tick(); c.clock = setInterval(tick, 1000);
          if (c.display) announceShare(c);
        } else if (pc.connectionState === 'failed') stop(c, 'The call could not connect. Try again or contact your administrator.');
        else if (pc.connectionState === 'disconnected') {
          clearInterval(c.clock); status('Reconnecting…');
          clearTimeout(c.disconnectTimer);
          c.disconnectTimer = setTimeout(() => { if (current === c) stop(c, 'Connection lost.'); }, 12000);
        }
      };
      return true;
    }
    async function description(c, d) {
      await c.pc.setRemoteDescription(d);
      if (d.type === 'offer') {
        // Answer every slot the caller offered: first video = camera, second = screen.
        const [camera, screen] = c.pc.getTransceivers().filter(t => t.mid !== null && t.receiver.track.kind === 'video').sort((a, b) => Number(a.mid) - Number(b.mid));
        if (camera) {
          camera.direction = 'sendrecv'; c.videoSender = camera.sender;
          camera.sender.setStreams(c.stream);
          if (c.camera && camera.sender.track !== c.camera) await camera.sender.replaceTrack(c.camera);
        }
        if (screen) {
          screen.direction = 'sendrecv'; c.screenSender = screen.sender;
          screen.sender.setStreams(c.screenStream);
        }
      }
      for (const candidate of c.candidates.splice(0)) await c.pc.addIceCandidate(candidate);
      if (d.type === 'offer') {
        await c.pc.setLocalDescription(await c.pc.createAnswer());
        await request('call:signal', { id: c.id, signal: { description: c.pc.localDescription.toJSON() } });
      }
    }
    function timeout(c) {
      clearTimeout(c.timer);
      c.timer = setTimeout(() => { if (current === c) stop(c, 'Call timed out.'); }, 60000);
    }
    async function offer(c) {
      if (current !== c || c.offered) return;
      c.offered = true; c.accepted = true;
      status('Connecting…'); timeout(c);
      try {
        await c.pc.setLocalDescription(await c.pc.createOffer());
        await request('call:signal', { id: c.id, signal: { description: c.pc.localDescription.toJSON() } });
      } catch (e) { if (current === c) stop(c, e.message); }
    }
    socket.on('call:incoming', data => {
      // Another tab may be originating this user's call. Do not disturb it.
      if (current || otherCallActive()) return;
      const c = current = { conversationId: data.conversationId, id: data.id, name: data.caller.name, mode: data.mode, incoming: true, queue: Promise.resolve() };
      show(c, 'Incoming call'); timeout(c);
    });
    socket.on('call:accepted', data => {
      const c = current;
      if (!c || c.incoming) return;
      // An answer can arrive before the call:start acknowledgement.
      if (!c.id) { c.earlyAccepted = data.id; return; }
      if (c.id === data.id) offer(c);
    });
    socket.on('call:answered', data => {
      if (current?.id === data.id && data.socketId !== socket.id) cleanup(current);
    });
    socket.on('call:ended', data => {
      if (current?.id === data.id) cleanup(current, data.reason);
      else if (current && !current.id) current.earlyEnded = data;
    });
    socket.on('call:signal', data => {
      const c = current;
      if (!c || c.id !== data.id || !c.pc) return;
      c.queue = c.queue.then(async () => {
        if (current !== c) return;
        if (data.signal.description) await description(c, data.signal.description);
        else if (c.pc.remoteDescription) await c.pc.addIceCandidate(data.signal.candidate);
        else c.candidates.push(data.signal.candidate);
      }).catch(e => { if (current === c) stop(c, e.message); });
    });
    socket.on('call:share', data => {
      const c = current;
      if (!c || c.id !== data.id) return;
      c.remoteSharing = !!data.sharing;
      arrange(c);
    });
    // Their camera turned off or on (enabled=false still sends black frames, so it must be told).
    socket.on('call:camera', data => {
      const c = current;
      if (!c || c.id !== data.id) return;
      c.remoteCameraOff = !data.on;
      arrange(c);
    });
    socket.on('disconnect', () => { if (current) cleanup(current, 'Connection lost. Call ended.'); });
    // A picture starting (or changing size) on any video can change what belongs on the stage.
    for (const id of ['callRemote', 'callRemoteScreen', 'callLocal', 'callLocalScreen']) $(id).addEventListener('resize', () => { if (current) arrange(current); });
    $('callAccept').onclick = async () => {
      const c = current;
      if (!c || c.accepting) return;
      c.accepting = true; $('callAccept').disabled = true; status('Requesting microphone access…');
      try {
        if (!await prepare(c)) return;
        await request('call:accept', { id: c.id });
        if (current !== c) return;
        c.accepted = true;
        $('callAccept').hidden = true; $('callDecline').hidden = true; $('callHangup').hidden = false;
        $('callHangup').focus(); status('Connecting…'); timeout(c);
      } catch (e) { if (current === c) stop(c, e.message); }
    };
    $('callDecline').onclick = $('callHangup').onclick = () => { if (current) stop(current); };
    // The panel's buttons are shared with group calls, so each handler acts only on a 1:1 call.
    $('callMute').onclick = () => {
      const tracks = current?.stream?.getAudioTracks() || [];
      if (!tracks.length) return;
      const enabled = !tracks[0].enabled;
      tracks.forEach(t => { t.enabled = enabled; });
      setCallToggle($('callMute'), !enabled, enabled ? 'Mute' : 'Unmute');
    };
    $('callCamera').onclick = () => {
      const c = current, cam = c?.camera;
      if (!cam) return;
      cam.enabled = !cam.enabled;
      setCallToggle($('callCamera'), !cam.enabled, cam.enabled ? 'Turn camera off' : 'Turn camera on');
      arrange(c);
      if (c.id && c.pc?.connectionState === 'connected') request('call:camera', { id: c.id, on: cam.enabled }).catch(() => {});
    };
    $('callScreenShare').onclick = () => { if (current && (!current.incoming || current.accepted)) controller.share(current.conversationId, current.name); };
    $('callPlayback').onclick = () => { if (!current) return; $('callRemoteAudio').play().then(() => { $('callPlayback').hidden = true; }).catch(() => {}); };
    window.addEventListener('pagehide', () => { if (current) stop(current); });
    async function stopSharing(c) {
      const display = c.display; c.display = null;
      if (!display) return;
      display.getTracks().forEach(t => { t.onended = null; t.stop(); });
      if (current !== c) return;
      $('callLocalScreen').srcObject = null;
      try { await c.screenSender?.replaceTrack(null); } catch (e) { stop(c, e.message); return; }
      $('callStopSharing').hidden = true;
      announceShare(c);
    }
    $('callStopSharing').onclick = () => { if (current) stopSharing(current); };
    const controller = { async share(conversationId, name) {
      const existing = current;
      if (existing && (Number(existing.conversationId) !== Number(conversationId) || existing.pc?.connectionState !== 'connected')) return notify(new Error('Finish connecting or end the current call before sharing.'));
      if (!navigator.mediaDevices?.getDisplayMedia) return notify(new Error('Screen sharing requires a supported browser over HTTPS.'));
      let display;
      try {
        display = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:false });
        if (existing && current !== existing) { display.getTracks().forEach(t => t.stop()); return; }
        if (!existing) { await controller.start(conversationId, 'video', name, display); return; }
        if (!existing.screenSender) throw new Error('The other person needs to reload NovaConnect before you can share your screen with them.');
        if (existing.display) await stopSharing(existing);
        const track = display.getVideoTracks()[0];
        await existing.screenSender.replaceTrack(track);
        existing.display = display;
        track.onended = () => stopSharing(existing);
        $('callLocalScreen').srcObject = display;
        $('callStopSharing').hidden = false;
        announceShare(existing);
      } catch (e) {
        display?.getTracks().forEach(t => t.stop());
        if (e.name !== 'NotAllowedError') notify(e);
      }
    }, active: () => !!current, async start(conversationId, mode, name, display = null) {
      if (current || otherCallActive()) { display?.getTracks().forEach(t => t.stop()); return notify(new Error('Finish your current call first.')); }
      const c = current = { mode, name, display, conversationId, queue: Promise.resolve() };
      show(c, 'Requesting microphone access…'); timeout(c);
      try {
        if (!await prepare(c)) return;
        const reply = await request('call:start', { conversationId, mode });
        c.id = reply.id;
        if (current !== c) { request('call:end', { id: c.id }).catch(() => {}); return; }
        status('Ringing…'); timeout(c);
        if (c.earlyEnded?.id === c.id) cleanup(c, c.earlyEnded.reason);
        else if (c.earlyAccepted === c.id) offer(c);
      } catch (e) { if (current === c) stop(c, e.message); }
    } };
    return controller;
  };
})();
