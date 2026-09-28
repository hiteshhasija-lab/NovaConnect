// SFU-based meeting signaling with lobby support. Media goes through mediasoup SFU.
// sfuInstance is the createSfuSignaling(io, db) instance from realtime.js — only its
// roomUserMap is used (shared peer-mapping state); every actual media/room operation
// below comes straight from ./sfu, since sfu-signaling.js's own copies are just
// unchanged re-exports of the same functions.
function createMeetSignaling(io, db, sfuInstance) {
  const {
    createRoom, getRoom, deleteRoom, createTransport, connectTransport,
    produce, consume, resumeConsumer, listProducers, closeProducer, setProducerPaused, closePeerTransports,
    startRecording, stopRecording, getRecordingStatus,
  } = require('./sfu');
  const { nowStr } = require('./db');

  async function meetingOwnerId(code) {
    const link = await db.prepare('SELECT created_by FROM meet_links WHERE code = ?').get(code);
    return link ? link.created_by : null;
  }

  // Lobby notices go only to the owner's connections that are inside this meeting.
  function notifyOwners(roomId, ownerId, event, payload) {
    for (const [sid, m] of sfuInstance.roomUserMap.entries()) {
      if (m.roomId === roomId && m.userId === ownerId && !m.inLobby) io.to(sid).emit(event, payload);
    }
  }

  function attach(socket) {
    let roomCode = null;
    let meetingId = null;
    let inLobby = false;
    let isAdmitted = false;

    function leave() {
      if (!roomCode) return;
      const mapping = sfuInstance.roomUserMap?.get(socket.id);
      if (mapping) {
        sfuInstance.roomUserMap.delete(socket.id);
        if (mapping.inLobby) {
          // Left while waiting — take them off the owner's lobby list.
          notifyOwners(roomCode, mapping.ownerId, 'meet:lobby-left', { peerId: mapping.peerId });
        } else {
          closePeerTransports(roomCode, mapping.peerId);
          io.to(`sfu:${roomCode}`).emit('sfu:peer-left', {
            peerId: mapping.peerId,
            userId: socket.user.id,
            fullName: socket.user.full_name,
          });
        }
      }
      const roomAfter = getRoom(roomCode);
      if (roomAfter && roomAfter.peers.size === 0) deleteRoom(roomCode);
      socket.leave(roomCode);
      socket.leave('sfu:' + roomCode);
      roomCode = null;
      meetingId = null;
      inLobby = false;
      isAdmitted = false;
    }

    // Moves a lobby entry into the meeting: it starts receiving room broadcasts only now.
    function admitSocket(sid, mapping) {
      mapping.inLobby = false;
      io.in(sid).socketsJoin('sfu:' + mapping.roomId);
      io.to(sid).emit('meet:admitted', { roomId: mapping.roomId });
      io.to('sfu:' + mapping.roomId).except(sid).emit('sfu:peer-joined', {
        peerId: mapping.peerId,
        userId: mapping.userId,
        fullName: mapping.fullName,
      });
    }

    function findInLobby(roomId, peerId) {
      for (const [sid, m] of sfuInstance.roomUserMap.entries()) {
        if (m.roomId === roomId && m.peerId === peerId && m.inLobby) return [sid, m];
      }
      return [null, null];
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

    // Join a meeting: everyone starts in the lobby and receives nothing from the meeting yet.
    handle('meet:join', async ({ code }, u) => {
      if (typeof code !== 'string' || !/^[a-f0-9]{24}$/.test(code)) throw Error('Enter a valid meeting ID.');

      const link = await db.prepare('SELECT title, created_by FROM meet_links WHERE code = ? AND active = 1').get(code);
      if (!link) throw Error('Meeting not found.');

      const roomId = 'meet:' + code;
      const room = await createRoom(roomId);
      const peerId = `${u.id}-${socket.id}`;

      if (roomCode) leave();
      roomCode = roomId;
      meetingId = code;
      inLobby = true;
      isAdmitted = false;

      sfuInstance.roomUserMap.set(socket.id, {
        roomId, peerId, userId: u.id, fullName: u.full_name, ownerId: link.created_by, inLobby: true, waiting: false,
      });
      socket.join(roomId);

      return {
        title: link.title,
        roomId,
        peerId,
        routerRtpCapabilities: room.router.rtpCapabilities,
        isOwner: link.created_by === u.id,
      };
    });

    // Ask to enter: the meeting owner goes straight in; anyone else waits for the owner.
    handle('meet:request-join', async ({ roomId }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');
      const mapping = sfuInstance.roomUserMap.get(socket.id);
      if (!mapping) throw Error('Not in lobby');
      if (!mapping.inLobby) return { admitted: true };

      if (mapping.ownerId === u.id) {
        admitSocket(socket.id, mapping);
        inLobby = false;
        isAdmitted = true;
        return { admitted: true };
      }

      mapping.waiting = true;
      notifyOwners(roomId, mapping.ownerId, 'meet:lobby-waiting', { peerId: mapping.peerId, userId: u.id, fullName: u.full_name });
      return { admitted: false };
    });

    // Meeting owner admits someone waiting in the lobby
    handle('meet:admit', async ({ roomId, peerId }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');
      if ((await meetingOwnerId(meetingId)) !== u.id) throw Error('Only the meeting owner can admit participants');
      if (!getRoom(roomId)) throw Error('Room not found');

      const [sid, target] = findInLobby(roomId, peerId);
      if (!target || !target.waiting) throw Error('That person is no longer waiting');

      admitSocket(sid, target);
      notifyOwners(roomId, u.id, 'meet:lobby-left', { peerId });
      return { success: true };
    });

    // Meeting owner turns someone away from the lobby
    handle('meet:deny', async ({ roomId, peerId }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');
      if ((await meetingOwnerId(meetingId)) !== u.id) throw Error('Only the meeting owner can deny participants');

      const [sid, target] = findInLobby(roomId, peerId);
      if (!target || !target.waiting) throw Error('That person is no longer waiting');

      sfuInstance.roomUserMap.delete(sid);
      io.in(sid).socketsLeave(roomId);
      io.to(sid).emit('meet:denied', { roomId });
      notifyOwners(roomId, u.id, 'meet:lobby-left', { peerId });
      return { success: true };
    });

    // Who is currently waiting (owner only) — used when the owner (re)joins.
    handle('meet:lobby-list', async ({ roomId }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');
      if ((await meetingOwnerId(meetingId)) !== u.id) throw Error('Only the meeting owner can view the lobby');

      const waiting = [];
      for (const m of sfuInstance.roomUserMap.values()) {
        if (m.roomId === roomId && m.inLobby && m.waiting) waiting.push({ peerId: m.peerId, userId: m.userId, fullName: m.fullName });
      }
      return { waiting };
    });

    // SFU signaling events (real mediasoup transport/producer/consumer operations). These serve
    // any SFU room this socket has been admitted to — a meeting (meet:join) or a group call in
    // chat (group-calls.js) — as recorded in its roomUserMap entry.
    function admitted(roomId) {
      const mapping = sfuInstance.roomUserMap.get(socket.id);
      if (!mapping || mapping.roomId !== roomId || mapping.inLobby) throw Error('Not admitted to this call');
      return mapping;
    }

    handle('sfu:create-transport', async ({ roomId, direction }, u) => {
      admitted(roomId);
      return await createTransport(roomId, `${u.id}-${socket.id}`, direction);
    });

    handle('sfu:connect-transport', async ({ roomId, transportId, dtlsParameters }, u) => {
      admitted(roomId);
      await connectTransport(roomId, `${u.id}-${socket.id}`, transportId, dtlsParameters);
      return { success: true };
    });

    handle('sfu:produce', async ({ roomId, transportId, kind, rtpParameters, appData }, u) => {
      const mapping = admitted(roomId);
      const source = appData?.source === 'screen' ? 'screen' : 'camera';
      const producerId = await produce(roomId, `${u.id}-${socket.id}`, transportId, kind, rtpParameters, {
        ...appData,
        source,
        sourcePeerId: `${u.id}-${socket.id}`,
        sourceUserId: u.id,
        sourceFullName: u.full_name,
      });
      // Everyone already in the meeting starts receiving this new stream from the SFU.
      socket.to(`sfu:${roomId}`).emit('sfu:new-producer', {
        producerId, peerId: mapping.peerId, kind, fullName: u.full_name, source,
      });
      return { producerId };
    });

    // Camera off / microphone muted (or back on): everyone else shows initials / a muted icon.
    handle('sfu:pause-producer', async ({ roomId, producerId, paused }) => {
      const mapping = admitted(roomId);
      const kind = await setProducerPaused(roomId, mapping.peerId, producerId, paused === true);
      if (kind === 'audio') mapping.micOff = paused === true; else mapping.camOff = paused === true;
      socket.to(`sfu:${roomId}`).emit('sfu:producer-paused', { producerId, peerId: mapping.peerId, kind, paused: paused === true });
      return { success: true };
    });

    // Stop one of your own streams (a screen share) while staying in the call.
    handle('sfu:close-producer', async ({ roomId, producerId }) => {
      const mapping = admitted(roomId);
      closeProducer(roomId, mapping.peerId, producerId);
      socket.to(`sfu:${roomId}`).emit('sfu:producer-closed', { producerId, peerId: mapping.peerId });
      return { success: true };
    });

    // What a newly admitted peer should consume: every stream already in the meeting.
    handle('sfu:get-producers', async ({ roomId }) => {
      const mapping = admitted(roomId);
      return { producers: listProducers(roomId, mapping.peerId) };
    });

    handle('sfu:consume', async ({ roomId, transportId, producerId, rtpCapabilities, appData }, u) => {
      admitted(roomId);
      return await consume(roomId, `${u.id}-${socket.id}`, transportId, producerId, rtpCapabilities, {
        ...appData,
        sourcePeerId: appData?.sourcePeerId,
      });
    });

    handle('sfu:resume-consumer', async ({ roomId, consumerId }, u) => {
      admitted(roomId);
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

      // Notify all participants that recording stopped. Only the owner (who is the one stopping
      // it) gets the download link — the download route refuses everyone else anyway.
      const stoppedEvent = {
        recordingId: result.recordingId,
        stoppedBy: u.full_name,
        duration: result.duration,
        failed: Boolean(result.failed),
      };
      socket.to(`sfu:${roomId}`).emit('meet:recording-stopped', { ...stoppedEvent, downloadUrl: null });
      socket.emit('meet:recording-stopped', { ...stoppedEvent, downloadUrl: result.url || null });

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

  return { attach };
}

module.exports = { createMeetSignaling };