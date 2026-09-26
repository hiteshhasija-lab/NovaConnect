// SFU-based meeting signaling with lobby support. Media goes through mediasoup SFU.
// sfuInstance is the createSfuSignaling(io, db) instance from realtime.js — only its
// roomUserMap is used (shared peer-mapping state); every actual media/room operation
// below comes straight from ./sfu, since sfu-signaling.js's own copies are just
// unchanged re-exports of the same functions.
function createMeetSignaling(io, db, sfuInstance) {
  const {
    createRoom, getRoom, deleteRoom, createTransport, connectTransport,
    produce, consume, resumeConsumer, getRoomPeers, closePeerTransports,
    startRecording, stopRecording, getRecordingStatus,
  } = require('./sfu');
  const { nowStr } = require('./db');

  function attach(socket) {
    let roomCode = null;
    let meetingId = null;
    let inLobby = false;
    let isAdmitted = false;

    function leave() {
      if (!roomCode) return;
      const room = getRoom(roomCode);
      if (room) {
        const mapping = sfuInstance.roomUserMap?.get(socket.id);
        if (mapping) {
          closePeerTransports(roomCode, mapping.peerId);
          sfuInstance.roomUserMap.delete(socket.id);
          io.to(`sfu:${roomCode}`).emit('sfu:peer-left', {
            peerId: mapping.peerId,
            userId: socket.user.id,
            fullName: socket.user.full_name,
          });
        }
        const roomAfter = getRoom(roomCode);
        if (roomAfter && roomAfter.peers.size === 0) deleteRoom(roomCode);
      }
      if (roomCode) {
        socket.leave('meet:' + roomCode);
        socket.leave('sfu:' + roomCode);
      }
      roomCode = null;
      meetingId = null;
      inLobby = false;
      isAdmitted = false;
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

    // Join meeting via SFU (enters lobby first)
    handle('meet:join', async ({ code }, u) => {
      if (typeof code !== 'string' || !/^[a-f0-9]{24}$/.test(code)) throw Error('Enter a valid meeting ID.');

      const link = await db.prepare('SELECT title FROM meet_links WHERE code = ? AND active = 1').get(code);
      if (!link) throw Error('Meeting not found.');

      // Get or create SFU room for this meeting code
      const roomId = 'meet:' + code;
      const room = await createRoom(roomId);
      const peerId = `${u.id}-${socket.id}`;

      // Leave any previous room
      if (roomCode) leave();

      roomCode = roomId;
      meetingId = code;
      inLobby = true;
      isAdmitted = false;

      // Track this socket's SFU membership
      sfuInstance.roomUserMap.set(socket.id, { roomId, peerId, userId: u.id, inLobby: true });

      // Join socket.io rooms
      socket.join('meet:' + code);
      socket.join('sfu:' + roomCode);

      // Get existing peers in the SFU room (only admitted ones)
      const peers = getRoomPeers(roomCode).filter(p => p !== peerId);
      const peerDetails = [];
      for (const pid of peers) {
        for (const [sid, info] of sfuInstance.roomUserMap.entries()) {
          if (info.peerId === pid && !info.inLobby) {
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
        inLobby: true,
        isAdmitted: false,
      };
    });

    // Request to join from lobby (user clicks "Join Meeting" after preview)
    handle('meet:request-join', async ({ roomId }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');

      const room = getRoom(roomId);
      if (!room) throw Error('Room not found');

      const mapping = sfuInstance.roomUserMap.get(socket.id);
      if (!mapping) throw Error('Not in lobby');

      mapping.inLobby = false;
      inLobby = false;
      isAdmitted = true;

      // Notify others that user has joined
      io.to(`sfu:${roomId}`).emit('sfu:peer-joined', {
        peerId: mapping.peerId,
        userId: u.id,
        fullName: u.full_name,
      });

      // Return router capabilities for media setup
      return {
        routerRtpCapabilities: room.router.rtpCapabilities,
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      };
    });

    // Lobby: request to join (from waiting user)
    handle('meet:lobby-request', async ({ roomId }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');

      const room = getRoom(roomId);
      if (!room) throw Error('Room not found');

      const mapping = sfuInstance.roomUserMap.get(socket.id);
      if (!mapping || !mapping.inLobby) throw Error('Not in lobby');

      // Notify meeting owner/admins that someone is waiting
      io.to(`sfu:${roomId}`).emit('meet:lobby-waiting', {
        peerId: mapping.peerId,
        userId: u.id,
        fullName: u.full_name,
      });
      
      return { success: true };
    });

    // Meeting owner admits user from lobby
    handle('meet:admit', async ({ roomId, peerId }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');

      const room = getRoom(roomId);
      if (!room) throw Error('Room not found');

      // Check if user is meeting owner (creator of the link)
      const link = await db.prepare('SELECT created_by FROM meet_links WHERE code = ?').get(meetingId);
      if (!link || link.created_by !== u.id) throw Error('Only meeting owner can admit participants');

      const targetMapping = Array.from(sfuInstance.roomUserMap.values()).find(m => m.peerId === peerId && m.roomId === roomId);
      if (!targetMapping || !targetMapping.inLobby) throw Error('User not in lobby');
      
      targetMapping.inLobby = false;
      
      // Notify the admitted user
      io.to(`user:${targetMapping.userId}`).emit('meet:admitted', {
        roomId,
        routerRtpCapabilities: room.router.rtpCapabilities,
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      
      // Notify others in the room
      io.to(`sfu:${roomId}`).emit('sfu:peer-joined', {
        peerId: targetMapping.peerId,
        userId: targetMapping.userId,
        fullName: (await getUserFullName(db, targetMapping.userId)) || 'Unknown',
      });
      
      return { success: true };
    });

    // Meeting owner denies user from lobby
    handle('meet:deny', async ({ roomId, peerId }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');
      
      const link = await db.prepare('SELECT created_by FROM meet_links WHERE code = ?').get(meetingId);
      if (!link || link.created_by !== u.id) throw Error('Only meeting owner can deny participants');
      
      const targetMapping = Array.from(sfuInstance.roomUserMap.values()).find(m => m.peerId === peerId && m.roomId === roomId);
      if (!targetMapping || !targetMapping.inLobby) throw Error('User not in lobby');

      // Notify the denied user
      io.to(`user:${targetMapping.userId}`).emit('meet:denied', { roomId });

      // Clean up
      closePeerTransports(roomId, peerId);
      const idx = Array.from(sfuInstance.roomUserMap.entries()).findIndex(([_, m]) => m.peerId === peerId && m.roomId === roomId);
      if (idx >= 0) {
        const [sid] = Array.from(sfuInstance.roomUserMap.entries())[idx];
        sfuInstance.roomUserMap.delete(sid);
      }
      
      io.to(`sfu:${roomId}`).emit('meet:lobby-left', { peerId });
      
      return { success: true };
    });

    // Get lobby waiting list
    handle('meet:lobby-list', async ({ roomId }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');
      
      const link = await db.prepare('SELECT created_by FROM meet_links WHERE code = ?').get(meetingId);
      if (!link || link.created_by !== u.id) throw Error('Only meeting owner can view lobby');
      
      const waiting = [];
      for (const [sid, mapping] of sfuInstance.roomUserMap.entries()) {
        if (mapping.roomId === roomId && mapping.inLobby) {
          waiting.push({
            peerId: mapping.peerId,
            userId: mapping.userId,
            fullName: (await getUserFullName(db, mapping.userId)) || 'Unknown',
          });
        }
      }
      
      return { waiting };
    });

    // SFU signaling events (real mediasoup transport/producer/consumer operations)
    handle('sfu:create-transport', async ({ roomId, direction }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');
      const mapping = sfuInstance.roomUserMap.get(socket.id);
      if (!mapping || mapping.inLobby) throw Error('Not admitted to meeting');
      return await createTransport(roomId, `${u.id}-${socket.id}`, direction);
    });

    handle('sfu:connect-transport', async ({ roomId, transportId, dtlsParameters }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');
      const mapping = sfuInstance.roomUserMap.get(socket.id);
      if (!mapping || mapping.inLobby) throw Error('Not admitted to meeting');
      await connectTransport(roomId, `${u.id}-${socket.id}`, transportId, dtlsParameters);
      return { success: true };
    });

    handle('sfu:produce', async ({ roomId, transportId, kind, rtpParameters, appData }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');
      const mapping = sfuInstance.roomUserMap.get(socket.id);
      if (!mapping || mapping.inLobby) throw Error('Not admitted to meeting');
      const producerId = await produce(roomId, `${u.id}-${socket.id}`, transportId, kind, rtpParameters, {
        ...appData,
        sourcePeerId: `${u.id}-${socket.id}`,
        sourceUserId: u.id,
        sourceFullName: u.full_name,
      });
      return { producerId };
    });

    handle('sfu:consume', async ({ roomId, transportId, producerId, rtpCapabilities, appData }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');
      const mapping = sfuInstance.roomUserMap.get(socket.id);
      if (!mapping || mapping.inLobby) throw Error('Not admitted to meeting');
      return await consume(roomId, `${u.id}-${socket.id}`, transportId, producerId, rtpCapabilities, {
        ...appData,
        sourcePeerId: appData?.sourcePeerId,
      });
    });

    handle('sfu:resume-consumer', async ({ roomId, consumerId }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');
      const mapping = sfuInstance.roomUserMap.get(socket.id);
      if (!mapping || mapping.inLobby) throw Error('Not admitted to meeting');
      await resumeConsumer(roomId, `${u.id}-${socket.id}`, consumerId);
      return { success: true };
    });

    handle('sfu:leave', async ({ roomId }, u) => {
      if (roomId === roomCode) leave();
      return { success: true };
    });

    // Recording handlers
    handle('meet:start-recording', async ({ roomId }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');

      // Check if user is meeting owner (creator of the link)
      const link = await db.prepare('SELECT created_by FROM meet_links WHERE code = ?').get(meetingId);
      if (!link || link.created_by !== u.id) throw Error('Only meeting owner can start recording');

      const result = await startRecording(roomId);

      // Notify all participants that recording started
      io.to(`sfu:${roomId}`).emit('meet:recording-started', {
        recordingId: result.recordingId,
        startedBy: u.full_name,
      });

      return { recordingId: result.recordingId };
    });

    handle('meet:stop-recording', async ({ roomId, recordingId }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');

      // Check if user is meeting owner
      const link = await db.prepare('SELECT created_by FROM meet_links WHERE code = ?').get(meetingId);
      if (!link || link.created_by !== u.id) throw Error('Only meeting owner can stop recording');

      const result = await stopRecording(recordingId);
      // Served by the signed-in-only download route in routes/meet.js, not the raw storage URL.
      if (!result.failed) result.url = `/api/recordings/${encodeURIComponent(result.recordingId)}/download`;

      await db.prepare(
        `INSERT INTO recordings (id, room_id, meeting_link_code, started_by, status, storage_driver, storage_key, download_url, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(result.recordingId, roomId, meetingId, u.id, result.failed ? 'failed' : 'completed',
        result.driver || null, result.key || null, result.url || null, result.duration, nowStr());

      // Notify all participants that recording stopped
      io.to(`sfu:${roomId}`).emit('meet:recording-stopped', {
        recordingId: result.recordingId,
        stoppedBy: u.full_name,
        duration: result.duration,
        downloadUrl: result.url || null,
        failed: Boolean(result.failed),
      });

      return { success: true, recording: result };
    });

    handle('meet:get-recording-status', async ({ roomId, recordingId }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');

      const status = getRecordingStatus(recordingId);
      return { status };
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