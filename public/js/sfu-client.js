(function () {
  'use strict';
  // One participant's connection to an SFU room: a send transport for our own camera/microphone
  // and a receive transport for everyone else's streams. Used by meeting rooms (meet-room.js)
  // and group calls in chat (group-calls.js). The page owns the socket listeners and forwards
  // sfu:new-producer / sfu:peer-left here.
  window.createSfuSession = function ({ request, roomId, routerRtpCapabilities, onPeerStream, onError }) {
    let device = null, sendTransport = null, recvTransport = null, recvReady = false, closed = false;
    const peers = new Map();      // peerId -> { name, consumers: Map(consumerId -> consumer) }
    const consumed = new Set();
    let pending = [];             // producers announced before the receive transport existed

    function wire(transport) {
      transport.on('connect', ({ dtlsParameters }, callback, errback) => {
        request('sfu:connect-transport', { roomId, transportId: transport.id, dtlsParameters }).then(() => callback()).catch(errback);
      });
    }

    async function consume({ producerId, peerId, fullName }) {
      if (closed || !recvTransport || consumed.has(producerId)) return;
      consumed.add(producerId);
      try {
        const r = await request('sfu:consume', { roomId, transportId: recvTransport.id, producerId, rtpCapabilities: device.rtpCapabilities, appData: { sourcePeerId: peerId } });
        const consumer = await recvTransport.consume({ id: r.id, producerId: r.producerId, kind: r.kind, rtpParameters: r.rtpParameters });
        if (closed) { consumer.close(); return; }
        let p = peers.get(peerId);
        if (!p) { p = { name: fullName || 'Participant', consumers: new Map() }; peers.set(peerId, p); }
        p.consumers.set(consumer.id, consumer);
        onPeerStream(peerId, p.name, new MediaStream([...p.consumers.values()].map(c => c.track)));
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
      // Sends every track of our local stream to the room.
      async publish(stream) {
        if (closed || !stream || sendTransport) return;
        const info = await request('sfu:create-transport', { roomId, direction: 'send' });
        if (closed) return;
        const transport = sendTransport = device.createSendTransport(info);
        wire(transport);
        transport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
          request('sfu:produce', { roomId, transportId: transport.id, kind, rtpParameters }).then(r => callback({ id: r.producerId })).catch(errback);
        });
        for (const track of stream.getTracks()) await transport.produce({ track });
      },
      newProducer(p) {
        if (closed) return;
        if (!recvReady) pending.push(p); else consume(p);
      },
      removePeer(peerId) {
        const p = peers.get(peerId);
        if (p) for (const c of p.consumers.values()) { consumed.delete(c.producerId); c.close(); }
        peers.delete(peerId);
      },
      hasPeer: peerId => peers.has(peerId),
      get peerCount() { return peers.size; },
      close() {
        closed = true;
        for (const id of [...peers.keys()]) this.removePeer(id);
        sendTransport?.close(); recvTransport?.close();
        sendTransport = recvTransport = null;
      },
    };
  };
})();
