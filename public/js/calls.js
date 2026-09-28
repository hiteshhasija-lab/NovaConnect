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
      // No empty video boxes: your preview appears once your camera starts (video calls only),
      // the other person's once a real frame of their video arrives (see the resize handler).
      $('callLocal').hidden = true;
      $('callRemote').hidden = false; $('callRemote').classList.add('nc-video-waiting');
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
    // Presentation layout while either side shares its screen (calls.css .nc-call-pip): the shared
    // screen (or, for the presenter, the other person) fills the area, the other video floats small.
    function layout(c) {
      if (current !== c) return;
      panel.classList.toggle('nc-call-pip', !!(c.display || c.remoteSharing));
      panel.classList.toggle('nc-local-screen', !!c.display);
      $('callKind').textContent = c.display ? 'You are sharing your screen'
        : c.remoteSharing ? c.name + ' is sharing their screen'
        : c.mode === 'video' ? 'Video call' : 'Audio call';
    }
    function announceShare(c) {
      layout(c);
      if (c.id && c.pc?.connectionState === 'connected') request('call:share', { id: c.id, sharing: !!c.display }).catch(() => {});
    }
    function cleanup(c, message) {
      clearTimeout(c.timer); clearTimeout(c.disconnectTimer); clearInterval(c.clock);
      c.pc?.close(); c.camera?.stop(); c.stream?.getTracks().forEach(t => t.stop()); c.display?.getTracks().forEach(t => t.stop());
      if (current !== c) return;
      current = null;
      panel.classList.remove('nc-call-pip', 'nc-local-screen');
      $('callLocal').srcObject = null; $('callRemote').srcObject = null; $('callRemoteAudio').srcObject = null;
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
      if (c.display) {
        const screen = c.display.getVideoTracks()[0];
        if (!screen || screen.readyState === 'ended') throw new Error('Screen sharing was cancelled.');
        stream.addTrack(screen); screen.onended = () => stopSharing(c);
        $('callStopSharing').hidden = false;
        layout(c);
      }
      $('callLocal').srcObject = stream;
      $('callLocal').hidden = !stream.getVideoTracks().length;
      $('callMute').hidden = false;
      $('callCamera').hidden = !c.camera || !!c.display;
      $('callScreenShare').hidden = !navigator.mediaDevices.getDisplayMedia;
      const pc = c.pc = new RTCPeerConnection({ iceServers: config.iceServers });
      c.candidates = [];
      stream.getTracks().forEach(t => {
        const sender = pc.addTrack(t, stream); if (t.kind === 'video') c.videoSender = sender;
      });
      if (!c.videoSender && !c.incoming) c.videoSender = pc.addTransceiver('video', { direction:'sendrecv', streams:[stream] }).sender;
      pc.onicecandidate = ({ candidate }) => {
        if (candidate && current === c && c.id) request('call:signal', { id: c.id, signal: { candidate: candidate.toJSON() } }).catch(e => { if (current === c) stop(c, e.message); });
      };
      pc.ontrack = ({ streams, track }) => {
        const remote = streams[0] || new MediaStream([track]);
        // Pictures go to the (muted) video element, sound to its own audio element: in audio calls
        // the video element is hidden, and Chromium never plays a display:none video — which on
        // macOS also left the microphone sending silence.
        $('callRemote').srcObject = remote;
        $('callRemoteAudio').srcObject = remote;
        $('callRemote').play().catch(() => {});
        $('callRemoteAudio').play().then(() => { if (current === c) $('callPlayback').hidden = true; }).catch(() => { if (current === c && $('callRemoteAudio').paused) $('callPlayback').hidden = false; });
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
        const video = c.pc.getTransceivers().find(t => t.mid !== null && t.receiver.track.kind === 'video');
        if (video) {
          video.direction = 'sendrecv'; c.videoSender = video.sender;
          video.sender.setStreams(c.stream);
          const track = c.stream.getVideoTracks()[0];
          if (track && video.sender.track !== track) await video.sender.replaceTrack(track);
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
      // In an audio call the remote video only exists while they share.
      if (!c.remoteSharing && c.mode !== 'video') $('callRemote').classList.add('nc-video-waiting');
      // Sharing again at the same size fires no resize event, so reveal on the share notice too.
      if (c.remoteSharing && $('callRemote').videoWidth > 0) $('callRemote').classList.remove('nc-video-waiting');
      layout(c);
    });
    socket.on('disconnect', () => { if (current) cleanup(current, 'Connection lost. Call ended.'); });
    // A remote video track can report itself live before any picture arrives (the caller's side of
    // an audio call does), so reveal the box only once a frame has actually been decoded.
    $('callRemote').addEventListener('resize', () => { if (current && $('callRemote').videoWidth > 0) $('callRemote').classList.remove('nc-video-waiting'); });
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
      const tracks = current?.stream?.getVideoTracks() || [];
      if (!tracks.length) return;
      const enabled = !tracks[0].enabled;
      tracks.forEach(t => { t.enabled = enabled; });
      setCallToggle($('callCamera'), !enabled, enabled ? 'Turn camera off' : 'Turn camera on');
    };
    $('callScreenShare').onclick = () => { if (current && (!current.incoming || current.accepted)) controller.share(current.conversationId, current.name); };
    $('callPlayback').onclick = () => { if (!current) return; $('callRemote').play().catch(() => {}); $('callRemoteAudio').play().then(() => { $('callPlayback').hidden = true; }).catch(() => {}); };
    window.addEventListener('pagehide', () => { if (current) stop(current); });
    async function stopSharing(c) {
      const display = c.display; c.display = null;
      if (!display) return;
      display.getTracks().forEach(t => { t.onended = null; t.stop(); c.stream?.removeTrack(t); });
      if (current !== c) return;
      try { await c.videoSender?.replaceTrack(c.camera); } catch (e) { stop(c, e.message); return; }
      if (c.camera && !c.stream.getVideoTracks().includes(c.camera)) c.stream.addTrack(c.camera);
      $('callLocal').srcObject = c.stream;
      $('callLocal').hidden = !c.camera;
      $('callCamera').hidden = !c.camera;
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
        if (existing.display) await stopSharing(existing);
        const track = display.getVideoTracks()[0];
        await existing.videoSender.replaceTrack(track);
        existing.display = display;
        existing.stream.getVideoTracks().forEach(t => existing.stream.removeTrack(t));
        existing.stream.addTrack(track);
        track.onended = () => stopSharing(existing);
        $('callLocal').srcObject = existing.stream; $('callLocal').hidden = false;
        $('callCamera').hidden = true; $('callStopSharing').hidden = false;
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
