(function () {
  'use strict';
  window.createNovaCalls = function (socket, notify) {
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
      $('callAccept').disabled = false;
      $('callMute').textContent = 'Mute';
      $('callCamera').textContent = 'Turn camera off';
      $('callMute').setAttribute('aria-pressed', 'false');
      $('callCamera').setAttribute('aria-pressed', 'false');
      (c.incoming ? $('callAccept') : $('callHangup')).focus();
    }
    function cleanup(c, message) {
      clearTimeout(c.timer); clearTimeout(c.disconnectTimer); clearInterval(c.clock);
      c.pc?.close(); c.camera?.stop(); c.stream?.getTracks().forEach(t => t.stop()); c.display?.getTracks().forEach(t => t.stop());
      if (current !== c) return;
      current = null;
      $('callLocal').srcObject = null; $('callRemote').srcObject = null;
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
      }
      $('callLocal').srcObject = stream;
      $('callLocal').hidden = c.mode !== 'video';
      $('callRemote').hidden = c.mode !== 'video';
      $('callMute').hidden = false;
      $('callCamera').hidden = !c.camera || !!c.display;
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
        $('callRemote').srcObject = streams[0] || new MediaStream([track]);
        if (track.kind === 'video') track.onunmute = () => { if (current === c) $('callRemote').hidden = false; };
        $('callRemote').play().then(() => { if (current === c) $('callPlayback').hidden = true; }).catch(() => { if (current === c && $('callRemote').paused) $('callPlayback').hidden = false; });
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
      if (current) return;
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
    socket.on('disconnect', () => { if (current) cleanup(current, 'Connection lost. Call ended.'); });
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
    $('callMute').onclick = () => {
      const tracks = current?.stream?.getAudioTracks() || [];
      const enabled = !tracks[0]?.enabled;
      tracks.forEach(t => { t.enabled = enabled; });
      $('callMute').textContent = enabled ? 'Mute' : 'Unmute';
      $('callMute').setAttribute('aria-pressed', String(!enabled));
    };
    $('callCamera').onclick = () => {
      const tracks = current?.stream?.getVideoTracks() || [];
      const enabled = !tracks[0]?.enabled;
      tracks.forEach(t => { t.enabled = enabled; });
      $('callCamera').textContent = enabled ? 'Turn camera off' : 'Turn camera on';
      $('callCamera').setAttribute('aria-pressed', String(!enabled));
    };
    $('callPlayback').onclick = () => { $('callRemote').play().then(() => { $('callPlayback').hidden = true; }).catch(() => {}); };
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
      } catch (e) {
        display?.getTracks().forEach(t => t.stop());
        if (e.name !== 'NotAllowedError') notify(e);
      }
    }, async start(conversationId, mode, name, display = null) {
      if (current) { display?.getTracks().forEach(t => t.stop()); return notify(new Error('Finish your current call first.')); }
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
