// SFU-based meeting signaling (replaces peer-to-peer mesh). Media goes through mediasoup SFU.
function createMeetSignaling(io, db) {
  const sfu = require('./sfu-signaling');
  const { getRoom } = require('./sfu');

  function attach(socket) {
    let roomCode = null;
    let meetingId = null;

    function leave() {
      if (!roomCode) return;
      const room = sfu.getRoom(roomCode);
      if (room) {
        const mapping = sfu.roomUserMap?.get(socket.id);
        if (mapping) {
          sfu.closePeerTransports(roomCode, mapping.peerId);
          io.to(`sfu:${roomCode}`).emit('sfu:peer-left', {
            peerId: mapping.peerId,
            userId: socket.user.id,
            fullName: socket.user.full_name,
          });
        }
      }
      if (roomCode) {
        socket.leave('meet:' + roomCode);
        socket.leave('sfu:' + roomCode);
      }
      roomCode = null;
      meetingId = null;
    }

    async function authorized() {
      await new Promise((resolve, reject) =>
        socket.request.session.reload(e => e ? reject(Error('Sign in again.')) : resolve())
      );
      if (socket.request.session.user?.id !== socket.user.id) throw Error('Sign in again.');
      const u = await db.prepare('SELECT id, full_name, active FROM users WHERE id = ?').get(socket.user.id);
      if (!u?.active) throw Error('Account unavailable.');
      return u;
    }

    function handle(name, fn) {
      socket.on(name, async (data, ack) => {
        if (typeof ack !== 'function') return;
        try {
          const u = await authorized();
          if (!socket.connected) return;
          ack({ ok: true, ...await fn(data || {}, u) });
        } catch (e) {
          ack({ ok: false, error: e.message });
        }
      });
    }

    // Join meeting via SFU
    handle('meet:join', async ({ code }, u) => {
      if (typeof code !== 'string' || !/^[a-f0-9]{24}$/.test(code)) throw Error('Enter a valid meeting ID.');

      const link = await db.prepare('SELECT title FROM meet_links WHERE code = ? AND active = 1').get(code);
      if (!link) throw Error('Meeting not found.');

      // Get or create SFU room for this meeting code
      const roomId = 'meet:' + code;
      const room = await sfu.createRoom(roomId);
      const peerId = `${u.id}-${socket.id}`;

      // Leave any previous room
      if (roomCode) leave();

      roomCode = roomId;
      meetingId = code;

      // Track this socket's SFU membership
      sfu.roomUserMap.set(socket.id, { roomId, peerId, userId: u.id });

      // Join socket.io rooms
      socket.join('meet:' + code);
      socket.join('sfu:' + roomCode);

      // Get existing peers in the SFU room
      const peers = sfu.getRoomPeers(roomCode).filter(p => p !== peerId);
      const peerDetails = [];
      for (const pid of peers) {
        // Find the socket for this peer to get user info
        for (const [sid, info] of sfu.roomUserMap.entries()) {
          if (info.peerId === pid) {
            peerDetails.push({
              peerId: pid,
              userId: info.userId,
              fullName: info.userId ? (await getUserFullName(db, info.userId)) : 'Unknown',
            });
            break;
          }
        }
      }

      // ICE servers
      let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
      try {
        if (process.env.WEBRTC_ICE_SERVERS) iceServers = JSON.parse(process.env.WEBRTC_ICE_SERVERS);
      } catch {}

      return {
        peers: peerDetails,
        title: link.title,
        iceServers,
        roomId,
        peerId,
        routerRtpCapabilities: room.router.rtpCapabilities,
      };
    });

    // SFU signaling events (delegate to sfu-signaling)
    handle('sfu:create-transport', async ({ roomId, direction }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');
      return await sfu.createTransport(roomId, `${u.id}-${socket.id}`, direction);
    });

    handle('sfu:connect-transport', async ({ roomId, transportId, dtlsParameters }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');
      await sfu.connectTransport(roomId, `${u.id}-${socket.id}`, transportId, dtlsParameters);
      return { success: true };
    });

    handle('sfu:produce', async ({ roomId, transportId, kind, rtpParameters, appData }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');
      const producerId = await sfu.produce(roomId, `${u.id}-${socket.id}`, transportId, kind, rtpParameters, {
        ...appData,
        sourcePeerId: `${u.id}-${socket.id}`,
        sourceUserId: u.id,
        sourceFullName: u.full_name,
      });
      return { producerId };
    });

    handle('sfu:consume', async ({ roomId, transportId, producerId, rtpCapabilities, appData }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');
      return await sfu.consume(roomId, `${u.id}-${socket.id}`, transportId, producerId, rtpCapabilities, {
        ...appData,
        sourcePeerId: appData?.sourcePeerId,
      });
    });

    handle('sfu:resume-consumer', async ({ roomId, consumerId }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');
      await sfu.resumeConsumer(roomId, `${u.id}-${socket.id}`, consumerId);
      return { success: true };
    });

    handle('sfu:leave', async ({ roomId }, u) => {
      if (roomId === roomCode) leave();
      return { success: true };
    });

    socket.on('meet:leave', leave);
    socket.on('disconnect', leave);
  }

  async function getUserFullName(db, userId) {
    try {
      const row = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(userId);
      return row?.full_name || 'Unknown';
    } catch {
      return 'Unknown';
    }
  }

  return { attach };
}

module.exports = { createMeetSignaling };