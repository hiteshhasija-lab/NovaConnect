// SFU-based meeting signaling with lobby support. Media goes through mediasoup SFU (./sfu).
// roomUserMap (socket.id -> { roomId, peerId, userId, ... }) is shared with group-calls.js: it
// says which call or meeting room each socket is in, and the sfu:* media events below are served
// for whatever room it names.
// scopeForRoom(roomId) → the chat/channel a call room belongs to (group-calls.js), so its in-call
// chat can be saved there; meeting rooms have none.
function createMeetSignaling(io, db, roomUserMap, { scopeForRoom = () => null } = {}) {
  const {
    createRoom, getRoom, deleteRoom, createTransport, connectTransport,
    produce, consume, resumeConsumer, setConsumerLayers, listProducers, closeProducer, setProducerPaused, setActiveSpeakerHandler, closePeerTransports,
    startRecording, stopRecording, getRecordingStatus, recordingInRoom, setRecordingFinishedHandler,
  } = require('./sfu');
  const { nowStr } = require('./db');

  // The loudest microphone in a call room (sfu.js), so everyone can highlight that tile.
  setActiveSpeakerHandler((roomId, peerId) => io.to('sfu:' + roomId).emit('sfu:active-speaker', { roomId, peerId }));
  const REACTIONS = ['👍', '❤️', '😂', '😮', '👏', '🎉'];
  const { postToScope, formatDuration } = require('./callPosts');

  // A recording has been composed (sfu.js). Meetings: saved for the meeting owner, who alone can
  // download it. Calls: posted into the call's chat or channel as a file — everyone who can see
  // that chat/channel can download it there — and saved for retention.
  setRecordingFinishedHandler(async (result, recorder) => {
    const { roomId, meta = {} } = recorder;
    const scope = meta.scope || null;
    let downloadUrl = null;
    if (!result.failed && scope) {
      const stamp = new Date(recorder.startTime).toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
      const post = await postToScope(io, scope, meta.startedBy, `🔴 Recording · ${formatDuration(result.duration)}`, { recording: result.recordingId },
        { originalName: `Recording ${stamp} UTC.mp4`, mimeType: 'video/mp4', size: result.size || null, storageDriver: result.driver, storageKey: result.key });
      const att = post.attachments?.[0];
      if (att) downloadUrl = `/api/attachments/${att.id}/download`;
    } else if (!result.failed) {
      downloadUrl = `/api/recordings/${encodeURIComponent(result.recordingId)}/download`;
    } else if (scope) {
      await postToScope(io, scope, meta.startedBy, '🔴 The recording failed: nothing was captured.', { recording: result.recordingId, failed: true }).catch(() => {});
    }
    await db.prepare(
      `INSERT INTO recordings (id, room_id, meeting_link_code, scope_type, scope_id, started_by, status, storage_driver, storage_key, download_url, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(result.recordingId, roomId, meta.meetingCode || null, scope?.type || null, scope?.id || null, meta.startedBy || null,
      result.failed ? 'failed' : 'completed', result.driver || null, result.key || null, downloadUrl, result.duration, nowStr());
    // Tell whoever is still there. A meeting's download link goes only to its owner's connections.
    const ready = { roomId, recordingId: result.recordingId, failed: !!result.failed, duration: result.duration };
    for (const [sid, m] of roomUserMap.entries()) {
      if (m.roomId !== roomId || m.inLobby) continue;
      const mayDownload = scope ? true : m.userId === meta.startedBy;
      io.to(sid).emit('meet:recording-ready', { ...ready, downloadUrl: mayDownload ? downloadUrl : null });
    }
  });
  // Call rooms: in-call chat so far, for people who join late (kept while the room exists).
  // Meeting rooms read theirs from meet_chat_messages instead.
  const chatHistory = new Map();
  function rememberChat(roomId, m) {
    for (const id of chatHistory.keys()) if (!getRoom(id)) chatHistory.delete(id);
    const list = chatHistory.get(roomId) || [];
    list.push(m);
    if (list.length > 200) list.shift();
    chatHistory.set(roomId, list);
  }

  // A standalone meeting's chat is saved (meet_chat_messages) and shown again the next time the
  // meeting link is used, and on the Meet page afterwards to everyone who was let in.
  const meetCode = roomId => (roomId.startsWith('meet:') ? roomId.slice(5) : null);
  const utcIso = s => String(s).replace(' ', 'T') + 'Z';
  async function savedMeetingChat(code) {
    const rows = await db.prepare(`SELECT c.id, c.user_id, c.body, c.created_at, u.full_name FROM meet_chat_messages c
      LEFT JOIN users u ON u.id = c.user_id WHERE c.meet_link_code = ? ORDER BY c.id DESC LIMIT 200`).all(code);
    return rows.reverse().map(r => ({ roomId: 'meet:' + code, peerId: null, userId: r.user_id, fullName: r.full_name || 'Former user',
      text: r.body, at: utcIso(r.created_at), messageId: 'meet-' + r.id }));
  }

  async function meetingOwnerId(code) {
    const link = await db.prepare('SELECT created_by FROM meet_links WHERE code = ?').get(code);
    return link ? link.created_by : null;
  }

  // Lobby notices go only to the owner's connections that are inside this meeting.
  function notifyOwners(roomId, ownerId, event, payload) {
    for (const [sid, m] of roomUserMap.entries()) {
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
      const mapping = roomUserMap.get(socket.id);
      if (mapping) {
        roomUserMap.delete(socket.id);
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
      roomUserMap.touch?.(mapping.userId); // now in the meeting: call presence (realtime.js)
      const code = meetCode(mapping.roomId);
      if (code) db.prepare('INSERT INTO meet_attendees (meet_link_code, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(code, mapping.userId)
        .catch(e => console.error('Could not record meeting attendee', e.message));
      io.in(sid).socketsJoin('sfu:' + mapping.roomId);
      io.to(sid).emit('meet:admitted', { roomId: mapping.roomId });
      io.to('sfu:' + mapping.roomId).except(sid).emit('sfu:peer-joined', {
        peerId: mapping.peerId,
        userId: mapping.userId,
        fullName: mapping.fullName,
      });
    }

    function findInLobby(roomId, peerId) {
      for (const [sid, m] of roomUserMap.entries()) {
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

      roomUserMap.set(socket.id, {
        roomId, peerId, userId: u.id, fullName: u.full_name, ownerId: link.created_by, inLobby: true, waiting: false,
      });
      socket.join(roomId);

      return {
        title: link.title,
        roomId,
        peerId,
        userId: u.id,
        routerRtpCapabilities: room.router.rtpCapabilities,
        isOwner: link.created_by === u.id,
      };
    });

    // Ask to enter: the meeting owner goes straight in; anyone else waits for the owner.
    handle('meet:request-join', async ({ roomId }, u) => {
      if (roomId !== 'meet:' + meetingId) throw Error('Not in meeting room');
      const mapping = roomUserMap.get(socket.id);
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

      roomUserMap.delete(sid);
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
      for (const m of roomUserMap.values()) {
        if (m.roomId === roomId && m.inLobby && m.waiting) waiting.push({ peerId: m.peerId, userId: m.userId, fullName: m.fullName });
      }
      return { waiting };
    });

    // SFU signaling events (real mediasoup transport/producer/consumer operations). These serve
    // any SFU room this socket has been admitted to — a meeting (meet:join) or a group call in
    // chat (group-calls.js) — as recorded in its roomUserMap entry.
    function admitted(roomId) {
      const mapping = roomUserMap.get(socket.id);
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
      if (source === 'screen') roomUserMap.touch?.(u.id); // "Presenting" (realtime.js)
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

    // In-call extras (any call room): participant list, raise hand, reactions, in-call chat.
    handle('sfu:participants', async ({ roomId }, u) => {
      admitted(roomId);
      const participants = [];
      for (const m of roomUserMap.values()) {
        if (m.roomId === roomId && !m.inLobby) participants.push({ peerId: m.peerId, userId: m.userId, fullName: m.fullName, hand: !!m.hand, micOff: !!m.micOff, camOff: !!m.camOff });
      }
      // Who is talking right now: speaker changes are only announced as they happen. The spotlight
      // is dropped once that person has left.
      const room = getRoom(roomId);
      const spotlight = participants.some(p => p.peerId === room?.spotlight) ? room.spotlight : null;
      return { participants, speaker: room?.speaker || null, spotlight, canSpotlight: await maySpotlight(roomId, u) };
    });
    // Spotlight: one person's video shown large for everyone in the call (Teams "Spotlight for
    // everyone"). Meetings: the owner. Calls: anyone in the call, as with recording. null clears it.
    async function maySpotlight(roomId, u) {
      return !roomId.startsWith('meet:') || (await meetingOwnerId(roomId.slice(5))) === u.id;
    }
    handle('sfu:spotlight', async ({ roomId, peerId }, u) => {
      admitted(roomId);
      if (!await maySpotlight(roomId, u)) throw Error('Only the meeting owner can spotlight someone.');
      const room = getRoom(roomId);
      if (!room) throw Error('This call has ended.');
      const target = peerId == null ? null : [...roomUserMap.values()].find(m => m.roomId === roomId && !m.inLobby && m.peerId === peerId);
      if (peerId != null && !target) throw Error('That person has left the call.');
      room.spotlight = target ? target.peerId : null;
      io.to(`sfu:${roomId}`).emit('sfu:spotlight', { roomId, peerId: room.spotlight, fullName: target?.fullName || null, byName: u.full_name });
      return {};
    });
    handle('sfu:hand', async ({ roomId, raised }) => {
      const m = admitted(roomId);
      m.hand = raised === true;
      io.to(`sfu:${roomId}`).emit('sfu:hand', { roomId, peerId: m.peerId, fullName: m.fullName, raised: m.hand });
      return {};
    });
    let lastReaction = 0;
    handle('sfu:reaction', async ({ roomId, emoji }) => {
      const m = admitted(roomId);
      if (!REACTIONS.includes(emoji)) throw Error('Unknown reaction.');
      if (Date.now() - lastReaction < 400) return {}; // a burst of clicks sends one
      lastReaction = Date.now();
      io.to(`sfu:${roomId}`).emit('sfu:reaction', { roomId, peerId: m.peerId, fullName: m.fullName, emoji });
      return {};
    });
    // A call's chat is saved into the chat or channel the call belongs to, and a standalone
    // meeting's into meet_chat_messages, so it's still there afterwards (as in Teams).
    handle('sfu:chat', async ({ roomId, text }) => {
      const m = admitted(roomId);
      const body = String(text || '').trim().slice(0, 2000);
      if (!body) throw Error('Type a message first.');
      const msg = { roomId, peerId: m.peerId, userId: m.userId, fullName: m.fullName, text: body, at: new Date().toISOString() };
      const scope = scopeForRoom(roomId);
      const code = meetCode(roomId);
      if (scope) {
        const saved = await postToScope(io, scope, m.userId, body, { callChat: true, room: roomId });
        msg.messageId = saved.id;
      } else if (code) {
        const saved = await db.prepare('INSERT INTO meet_chat_messages (meet_link_code, user_id, body) VALUES (?, ?, ?) RETURNING id, created_at').get(code, m.userId, body);
        msg.messageId = 'meet-' + saved.id;
        msg.at = utcIso(saved.created_at);
      }
      if (!code) rememberChat(roomId, msg);
      io.to(`sfu:${roomId}`).emit('sfu:chat', msg);
      return {};
    });
    handle('sfu:chat-history', async ({ roomId }) => {
      admitted(roomId);
      const code = meetCode(roomId);
      return { messages: code ? await savedMeetingChat(code) : chatHistory.get(roomId) || [] };
    });

    // Stop one of your own streams (a screen share) while staying in the call.
    handle('sfu:close-producer', async ({ roomId, producerId }) => {
      const mapping = admitted(roomId);
      closeProducer(roomId, mapping.peerId, producerId);
      roomUserMap.touch?.(mapping.userId); // a screen share may have ended ("Presenting")
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
    // Which size of someone's camera to receive (simulcast), from how large their tile is shown.
    handle('sfu:set-layers', async ({ roomId, consumerId, spatialLayer }) => {
      const m = admitted(roomId);
      await setConsumerLayers(roomId, m.peerId, consumerId, spatialLayer);
      return {};
    });

    handle('sfu:leave', async ({ roomId }, u) => {
      if (roomId === roomCode) leave();
      return { success: true };
    });

    // Recording. Meetings: the meeting owner. Calls (1:1, group chats, channel meetings): anyone in
    // the call, as in Teams. Everyone in the room sees a REC banner while it runs.
    async function recordingPlace(roomId, u) {
      admitted(roomId);
      if (roomId.startsWith('meet:')) {
        if ((await meetingOwnerId(roomId.slice(5))) !== u.id) throw Error('Only the meeting owner can record this meeting.');
        return { meetingCode: roomId.slice(5), scope: null };
      }
      const scope = scopeForRoom(roomId);
      if (!scope) throw Error('Recording is not available here.');
      return { meetingCode: null, scope };
    }
    handle('meet:start-recording', async ({ roomId }, u) => {
      const place = await recordingPlace(roomId, u);
      const result = await startRecording(roomId, { startedBy: u.id, startedByName: u.full_name, ...place });
      io.to(`sfu:${roomId}`).emit('meet:recording-started', { roomId, recordingId: result.recordingId, startedBy: u.full_name, startTime: result.startTime });
      return { recordingId: result.recordingId };
    });
    // Stops at once; the video is composed in the background and announced with meet:recording-ready.
    handle('meet:stop-recording', async ({ roomId, recordingId }, u) => {
      await recordingPlace(roomId, u);
      const status = getRecordingStatus(recordingId);
      if (!status || status.roomId !== roomId || status.stopping) throw Error('This recording has already stopped.');
      const result = await stopRecording(recordingId);
      io.to(`sfu:${roomId}`).emit('meet:recording-stopped', { roomId, recordingId, stoppedBy: u.full_name, duration: result.duration, processing: true });
      return { success: true };
    });
    // Whether this room is being recorded right now (for people who join mid-recording).
    handle('meet:recording-status', async ({ roomId }) => {
      admitted(roomId);
      return { recording: recordingInRoom(roomId) };
    });

    socket.on('meet:leave', leave);
    socket.on('disconnect', leave);
  }

  return { attach };
}

module.exports = { createMeetSignaling };