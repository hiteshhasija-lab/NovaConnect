(function () {
  'use strict';
  // One participant's connection to an SFU room: a send transport for our own camera/microphone
  // (and screen, while sharing) and a receive transport for everyone else's streams. Used by
  // meeting rooms (meet-room.js) and group calls in chat (group-calls.js). The page owns the socket
  // listeners and forwards sfu:new-producer / sfu:producer-closed / sfu:peer-left here.
  //   onPeerStream(peerId, name, stream)        — their camera + microphone
  //   onPeerScreen(peerId, name, stream | null) — the screen they share (null when they stop)
  //   onPeerState(peerId, kind, paused)          — their camera turned off/on, microphone muted/unmuted
  window.createSfuSession = function ({ request, roomId, routerRtpCapabilities, onPeerStream, onPeerScreen, onPeerState, onError }) {
    let device = null, sendTransport = null, recvTransport = null, recvReady = false, closed = false;
    let screenProducer = null;
    const ownProducers = {};      // kind -> our camera/microphone producer
    const peers = new Map();      // peerId -> { name, consumers: Map(consumerId -> { consumer, source }) }
    const consumed = new Set();
    let pending = [];             // producers announced before the receive transport existed

    function wire(transport) {
      transport.on('connect', ({ dtlsParameters }, callback, errback) => {
        request('sfu:connect-transport', { roomId, transportId: transport.id, dtlsParameters }).then(() => callback()).catch(errback);
      });
    }
    async function ensureSendTransport() {
      if (sendTransport) return sendTransport;
      const info = await request('sfu:create-transport', { roomId, direction: 'send' });
      if (closed) throw new Error('The call has ended.');
      const transport = sendTransport = device.createSendTransport(info);
      wire(transport);
      transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
        request('sfu:produce', { roomId, transportId: transport.id, kind, rtpParameters, appData }).then(r => callback({ id: r.producerId })).catch(errback);
      });
      return transport;
    }
    const cameraStream = p => new MediaStream([...p.consumers.values()].filter(x => x.source !== 'screen').map(x => x.consumer.track));

    async function consume({ producerId, peerId, fullName, source }) {
      if (closed || !recvTransport || consumed.has(producerId)) return;
      consumed.add(producerId);
      try {
        const r = await request('sfu:consume', { roomId, transportId: recvTransport.id, producerId, rtpCapabilities: device.rtpCapabilities, appData: { sourcePeerId: peerId } });
        const consumer = await recvTransport.consume({ id: r.id, producerId: r.producerId, kind: r.kind, rtpParameters: r.rtpParameters });
        if (closed) { consumer.close(); return; }
        let p = peers.get(peerId);
        if (!p) { p = { name: fullName || 'Participant', consumers: new Map() }; peers.set(peerId, p); }
        p.consumers.set(consumer.id, { consumer, source: source === 'screen' ? 'screen' : 'camera' });
        if (source === 'screen') onPeerScreen?.(peerId, p.name, new MediaStream([consumer.track]));
        else {
          onPeerStream(peerId, p.name, cameraStream(p));
          if (r.producerPaused) onPeerState?.(peerId, r.kind, true); // camera already off / already muted
        }
        // Consumers start paused on the server; resuming also asks the sender for a keyframe.
        await request('sfu:resume-consumer', { roomId, consumerId: consumer.id });
      } catch (e) {
        consumed.delete(producerId);
        if (!closed) onError?.(e);
      }
    }

    return {
      // Loads the device and receives everything already in the room. Returns how many streams were there.
      async start() {
        device = new mediasoupClientBundle.Device();
        await device.load({ routerRtpCapabilities });
        const info = await request('sfu:create-transport', { roomId, direction: 'recv' });
        if (closed) return 0;
        recvTransport = device.createRecvTransport(info);
        wire(recvTransport);
        recvReady = true;
        const { producers } = await request('sfu:get-producers', { roomId });
        const queued = pending; pending = [];
        for (const p of [...producers, ...queued]) await consume(p);
        return producers.length;
      },
      // Sends every track of our local camera/microphone stream to the room.
      async publish(stream) {
        if (closed || !stream) return;
        const transport = await ensureSendTransport();
        for (const track of stream.getTracks()) {
          ownProducers[track.kind] = await transport.produce({ track, appData: { source: 'camera' } });
          if (!track.enabled) await this.setPaused(track.kind, true); // joined with it off
        }
      },
      // Camera off / microphone muted: pause our stream at the server so others are told (a
      // disabled track alone still sends black frames or silence and looks like a live camera).
      async setPaused(kind, paused) {
        const producer = ownProducers[kind];
        if (!producer || closed) return;
        if (paused) producer.pause(); else producer.resume();
        await request('sfu:pause-producer', { roomId, producerId: producer.id, paused }).catch(e => onError?.(e));
      },
      // Screen sharing: an extra stream alongside the camera, so the camera keeps going.
      // Screens carry text, so keep full resolution and give up frame rate instead when bandwidth
      // is short (WebRTC's default does the opposite and blurs small text).
      async shareScreen(track) {
        if (closed) return;
        const transport = await ensureSendTransport();
        track.contentHint = 'detail';
        screenProducer = await transport.produce({
          track,
          encodings: [{ maxBitrate: 2500000, maxFramerate: 30 }],
          codecOptions: { videoGoogleStartBitrate: 1500 },
          appData: { source: 'screen' },
        });
        try {
          const sender = screenProducer.rtpSender;
          const params = sender.getParameters();
          params.degradationPreference = 'maintain-resolution';
          await sender.setParameters(params);
        } catch { /* contentHint alone already prefers resolution */ }
      },
      async stopScreen() {
        const producer = screenProducer; screenProducer = null;
        if (!producer) return;
        producer.close();
        if (!closed) await request('sfu:close-producer', { roomId, producerId: producer.id }).catch(() => {});
      },
      newProducer(p) {
        if (closed) return;
        if (!recvReady) pending.push(p); else consume(p);
      },
      producerPaused({ peerId, kind, paused }) {
        if (!closed) onPeerState?.(peerId, kind, paused);
      },
      // Someone stopped one stream (a screen share) but stayed in the call.
      producerClosed({ producerId, peerId }) {
        const p = peers.get(peerId);
        if (!p) return;
        for (const [id, x] of p.consumers) {
          if (x.consumer.producerId !== producerId) continue;
          x.consumer.close(); p.consumers.delete(id); consumed.delete(producerId);
          if (x.source === 'screen') onPeerScreen?.(peerId, p.name, null);
          else onPeerStream(peerId, p.name, cameraStream(p));
        }
      },
      removePeer(peerId) {
        const p = peers.get(peerId);
        if (!p) return;
        let hadScreen = false;
        for (const x of p.consumers.values()) { consumed.delete(x.consumer.producerId); x.consumer.close(); if (x.source === 'screen') hadScreen = true; }
        peers.delete(peerId);
        if (hadScreen) onPeerScreen?.(peerId, p.name, null);
      },
      hasPeer: peerId => peers.has(peerId),
      get peerCount() { return peers.size; },
      close() {
        closed = true;
        screenProducer?.close(); screenProducer = null;
        for (const id of [...peers.keys()]) this.removePeer(id);
        sendTransport?.close(); recvTransport?.close();
        sendTransport = recvTransport = null;
      },
    };
  };
})();
