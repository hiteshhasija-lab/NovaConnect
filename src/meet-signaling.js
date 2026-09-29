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
  // Live captions: whether anyone in a room has them on, and telling the room when that changes.
  function captionsWanted(roomId) {
    for (const m of roomUserMap.values()) if (m.roomId === roomId && !m.inLobby && m.captions) return true;
    return false;
  }
  function announceCaptions(roomId) {
    const room = getRoom(roomId), wanted = captionsWanted(roomId);
    if (!room || !!room.captionsWanted === wanted) return;
    room.captionsWanted = wanted;
    io.to('sfu:' + roomId).emit('sfu:captions-state', { roomId, wanted });
  }

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
  // Meeting rooms are 'meet:<code>'; its breakout rooms 'meet:<code>:br<n>' (roadmap 2.7, below).
  // mainOf: the meeting a room belongs to. meetCode: the same, but only for the main room — breakout
  // chat stays in memory rather than joining the meeting's saved chat.
  const mainOf = roomId => (roomId.startsWith('meet:') ? roomId.slice(5).split(':br')[0] : null);
  const meetCode = roomId => (roomId.startsWith('meet:') && !roomId.includes(':br') ? roomId.slice(5) : null);
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
      if (mainOf(m.roomId) === mainOf(roomId) && m.userId === ownerId && !m.inLobby) io.to(sid).emit(event, payload);
    }
  }

  // ---- Breakout rooms (Teams-style, roadmap 2.7) ----
  // The meeting owner splits a meeting into smaller rooms — each its own SFU room, 'meet:<code>:br<n>'
  // — and moves people between them; closing them (or the timer) brings everyone back. Assignments are
  // per connection (peerId), so one person's two devices can be placed separately. State lives here,
  // per meeting code, while anyone is in the meeting.
  const breakouts = new Map();   // code -> { rooms: [name], assign: Map(peerId -> index), open, endsAt, timer }
  const setRoomOf = new Map();   // socket.id -> sets that connection's current room (in attach)
  const breakoutRoomId = (code, i) => `meet:${code}:br${i + 1}`;
  const inMeeting = code => [...roomUserMap.entries()].filter(([, m]) => !m.inLobby && mainOf(m.roomId) === code);
  function breakoutState(code) {
    const b = breakouts.get(code);
    return b ? { rooms: b.rooms, open: b.open, endsAt: b.endsAt } : { rooms: [], open: false, endsAt: null };
  }
  const tellMeeting = (code, event, payload) => { for (const [sid] of inMeeting(code)) io.to(sid).emit(event, payload); };
  // Moves one connection to another room of the same meeting: it leaves the old room's media (the
  // others see it leave), joins the new one's socket rooms, and is told to reconnect its media there.
  async function moveSocket(sid, target, name) {
    const m = roomUserMap.get(sid);
    if (!m || m.inLobby || m.roomId === target) return;
    const from = m.roomId;
    closePeerTransports(from, m.peerId);
    io.to('sfu:' + from).except(sid).emit('sfu:peer-left', { peerId: m.peerId, userId: m.userId, fullName: m.fullName });
    io.in(sid).socketsLeave(['sfu:' + from, from]);
    const room = await createRoom(target);
    Object.assign(m, { roomId: target, hand: false, micOff: false, camOff: false, captions: false });
    roomUserMap.set(sid, m);               // (presence: still in a meeting)
    setRoomOf.get(sid)?.(target);
    io.in(sid).socketsJoin(['sfu:' + target, target]);
    io.to('sfu:' + target).except(sid).emit('sfu:peer-joined', { peerId: m.peerId, userId: m.userId, fullName: m.fullName });
    const old = getRoom(from);
    if (old && old.peers.size === 0) deleteRoom(from);
    announceCaptions(from);
    io.to(sid).emit('meet:breakout-move', { roomId: target, name, main: !target.includes(':br'), routerRtpCapabilities: room.router.rtpCapabilities });
  }
  async function closeBreakouts(code, why) {
    const b = breakouts.get(code);
    if (!b) return;
    clearTimeout(b.timer); b.timer = null; b.open = false; b.endsAt = null;
    const main = 'meet:' + code;
    for (const [sid, m] of inMeeting(code)) if (m.roomId !== main) await moveSocket(sid, main, 'Main meeting');
    tellMeeting(code, 'meet:breakout-state', breakoutState(code));
    if (why) tellMeeting(code, 'meet:breakout-notice', { text: why });
  }
  function endBreakoutsIfEmpty(code) {
    if (!code || inMeeting(code).length) return;
    const b = breakouts.get(code);
    if (b) { clearTimeout(b.timer); breakouts.delete(code); }
  }

  function attach(socket) {
    let roomCode = null;
    let meetingId = null;
    let inLobby = false;
    let isAdmitted = false;
    setRoomOf.set(socket.id, room => { roomCode = room; });  // breakout moves (moveSocket)
    socket.on('disconnect', () => setRoomOf.delete(socket.id));

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
          if (mapping.captions) announceCaptions(roomCode); // maybe nobody wants captions now
        }
      }
      const roomAfter = getRoom(roomCode);
      if (roomAfter && roomAfter.peers.size === 0) deleteRoom(roomCode);
      socket.leave(roomCode);
      socket.leave('sfu:' + roomCode);
      endBreakoutsIfEmpty(mainOf(roomCode));
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
      return { participants, speaker: room?.speaker || null, spotlight, canSpotlight: await maySpotlight(roomId, u), captions: captionsWanted(roomId), board: !!room?.board?.open, together: !!room?.together };
    });
    // ---- Breakout rooms: the owner's actions, and anyone's "return to the main meeting" ----
    async function breakoutOwner(roomId, u) {
      admitted(roomId);
      const code = mainOf(roomId);
      if (!code) throw Error('Breakout rooms are only for meetings.');
      if ((await meetingOwnerId(code)) !== u.id) throw Error('Only the meeting owner can manage breakout rooms.');
      return code;
    }
    const roomIndexOf = m => (m.roomId.includes(':br') ? Number(m.roomId.split(':br')[1]) - 1 : -1);
    const sidOfPeer = (code, peerId) => inMeeting(code).find(([, m]) => m.peerId === peerId)?.[0];
    handle('sfu:breakout-get', async ({ roomId }, u) => {
      admitted(roomId);
      const code = mainOf(roomId);
      const state = breakoutState(code);
      if ((await meetingOwnerId(code)) !== u.id) return { state, isOwner: false };
      const b = breakouts.get(code);
      return {
        state, isOwner: true,
        assign: b ? Object.fromEntries(b.assign) : {},
        people: inMeeting(code).map(([, m]) => ({ peerId: m.peerId, fullName: m.fullName, owner: m.userId === u.id, room: roomIndexOf(m) })),
      };
    });
    // Set up (or redo) the rooms while they're closed: how many, and who goes where — given, or spread
    // evenly (everyone but the owner, in random order).
    handle('sfu:breakout-setup', async ({ roomId, count, assign }, u) => {
      const code = await breakoutOwner(roomId, u);
      if (breakouts.get(code)?.open) throw Error('Close the breakout rooms first.');
      const n = Math.max(1, Math.min(20, Number(count) || 0));
      const rooms = Array.from({ length: n }, (_, i) => 'Room ' + (i + 1));
      const map = new Map();
      if (assign && typeof assign === 'object') {
        for (const [peerId, idx] of Object.entries(assign)) if (Number.isInteger(idx) && idx >= 0 && idx < n) map.set(peerId, idx);
      } else {
        const people = inMeeting(code).map(([, m]) => m).filter(m => m.userId !== u.id).sort(() => Math.random() - 0.5);
        people.forEach((m, i) => map.set(m.peerId, i % n));
      }
      breakouts.set(code, { rooms, assign: map, open: false, endsAt: null, timer: null });
      tellMeeting(code, 'meet:breakout-state', breakoutState(code));
      return {};
    });
    handle('sfu:breakout-assign', async ({ roomId, peerId, index }, u) => {
      const code = await breakoutOwner(roomId, u);
      const b = breakouts.get(code);
      if (!b || typeof peerId !== 'string') throw Error('Set up breakout rooms first.');
      const idx = Number.isInteger(index) && index >= 0 && index < b.rooms.length ? index : -1;
      if (idx < 0) b.assign.delete(peerId); else b.assign.set(peerId, idx);
      const sid = b.open && sidOfPeer(code, peerId);
      if (sid) await moveSocket(sid, idx < 0 ? 'meet:' + code : breakoutRoomId(code, idx), idx < 0 ? 'Main meeting' : b.rooms[idx]);
      return {};
    });
    handle('sfu:breakout-open', async ({ roomId, minutes }, u) => {
      const code = await breakoutOwner(roomId, u);
      const b = breakouts.get(code);
      if (!b) throw Error('Set up breakout rooms first.');
      if (b.open) return {};
      const mins = Math.max(0, Math.min(240, Number(minutes) || 0));
      b.open = true;
      b.endsAt = mins ? Date.now() + mins * 60000 : null;
      if (mins) b.timer = setTimeout(() => closeBreakouts(code, 'Time is up: everyone is back in the main meeting.').catch(() => {}), mins * 60000);
      for (const [peerId, idx] of b.assign) {
        const sid = sidOfPeer(code, peerId);
        if (sid) await moveSocket(sid, breakoutRoomId(code, idx), b.rooms[idx]);
      }
      tellMeeting(code, 'meet:breakout-state', breakoutState(code));
      tellMeeting(code, 'meet:breakout-notice', { text: 'Breakout rooms are open' + (mins ? ' for ' + mins + ' minute' + (mins === 1 ? '' : 's') : '') + '.' });
      return {};
    });
    handle('sfu:breakout-close', async ({ roomId }, u) => {
      const code = await breakoutOwner(roomId, u);
      await closeBreakouts(code, 'The breakout rooms are closed: everyone is back in the main meeting.');
      return {};
    });
    handle('sfu:breakout-message', async ({ roomId, text }, u) => {
      const code = await breakoutOwner(roomId, u);
      const body = String(text || '').trim().slice(0, 300);
      if (!body) throw Error('Type a message first.');
      tellMeeting(code, 'meet:breakout-notice', { text: u.full_name + ' (to all rooms): ' + body });
      return {};
    });
    // The owner visits a room (index) or goes back to the main meeting (-1).
    handle('sfu:breakout-join', async ({ roomId, index }, u) => {
      const code = await breakoutOwner(roomId, u);
      const b = breakouts.get(code);
      const idx = b?.open && Number.isInteger(index) && index >= 0 && index < b.rooms.length ? index : -1;
      await moveSocket(socket.id, idx < 0 ? 'meet:' + code : breakoutRoomId(code, idx), idx < 0 ? 'Main meeting' : b.rooms[idx]);
      return {};
    });
    handle('sfu:breakout-return', async ({ roomId }) => {
      const m = admitted(roomId);
      const code = mainOf(roomId);
      if (code && m.roomId !== 'meet:' + code) await moveSocket(socket.id, 'meet:' + code, 'Main meeting');
      return {};
    });
    // ---- Together mode (together.js) ----
    // Everyone shown cut out of their video and seated in one shared scene. A room-wide switch, like
    // spotlight: meeting owner in meetings, anyone in calls. While it's on, each browser sends its
    // camera cut out on green (background-effects.js) and draws the scene itself.
    handle('sfu:together', async ({ roomId, on }, u) => {
      admitted(roomId);
      if (!await maySpotlight(roomId, u)) throw Error('Only the meeting owner can turn on Together mode.');
      const room = getRoom(roomId);
      if (!room) throw Error('This call has ended.');
      room.together = on === true;
      io.to(`sfu:${roomId}`).emit('sfu:together-state', { roomId, on: room.together, byName: u.full_name });
      return { on: room.together };
    });
    // ---- Whiteboard (whiteboard.js) ----
    // One board per call room, kept on the SFU room object for the life of the call (so late
    // joiners and reopening see the drawing; gone when the call ends — people can download it).
    // Anyone in the call opens/closes it for everyone; clearing it follows the spotlight rule
    // (meeting owner in meetings, anyone in calls). Points are 0–1 board coordinates.
    const boardOf = roomId => { const room = getRoom(roomId); if (!room) throw Error('This call has ended.'); return (room.board ??= { open: false, strokes: new Map(), points: 0 }); };
    handle('sfu:wb-open', async ({ roomId, open }, u) => {
      admitted(roomId);
      const board = boardOf(roomId);
      board.open = open === true;
      io.to(`sfu:${roomId}`).emit('sfu:wb-state', { roomId, open: board.open, byName: u.full_name });
      return {};
    });
    handle('sfu:wb-get', async ({ roomId }, u) => {
      admitted(roomId);
      const board = boardOf(roomId);
      return { open: board.open, strokes: [...board.strokes.values()], canClear: await maySpotlight(roomId, u) };
    });
    handle('sfu:wb-clear', async ({ roomId }, u) => {
      admitted(roomId);
      if (!await maySpotlight(roomId, u)) throw Error('Only the meeting owner can clear the whiteboard.');
      const board = boardOf(roomId);
      board.strokes.clear(); board.points = 0;
      io.to(`sfu:${roomId}`).emit('sfu:wb-clear', { roomId, byName: u.full_name });
      return {};
    });
    // Strokes stream in while someone draws (a batch every ~50 ms), so no per-event session reload;
    // being in the room is checked, and sizes are capped (per batch, per stroke, per board).
    const validPoint = p => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === 'number' && n >= 0 && n <= 1);
    socket.on('sfu:wb-stroke', ({ roomId, id, color, width, points } = {}) => {
      const m = roomUserMap.get(socket.id);
      if (!m || m.roomId !== roomId || m.inLobby || typeof id !== 'string' || id.length > 40) return;
      const room = getRoom(roomId); if (!room) return;
      const board = (room.board ??= { open: false, strokes: new Map(), points: 0 });
      if (!Array.isArray(points) || points.length > 500 || !points.every(validPoint)) return;
      const key = m.peerId + ':' + id;
      let s = board.strokes.get(key);
      if (!s) {
        if (!/^#[0-9a-f]{6}$/i.test(String(color)) || !(Number(width) >= 1 && Number(width) <= 40)) return;
        s = { id: key, peerId: m.peerId, color: String(color), width: Number(width), points: [] };
        board.strokes.set(key, s);
      }
      if (s.points.length + points.length > 5000 || board.points + points.length > 200000) return;
      s.points.push(...points); board.points += points.length;
      socket.to(`sfu:${roomId}`).emit('sfu:wb-stroke', { roomId, id: key, peerId: m.peerId, color: s.color, width: s.width, points });
    });
    socket.on('sfu:wb-erase', ({ roomId, ids } = {}) => {
      const m = roomUserMap.get(socket.id);
      if (!m || m.roomId !== roomId || m.inLobby || !Array.isArray(ids) || ids.length > 500) return;
      const board = getRoom(roomId)?.board; if (!board) return;
      const gone = ids.filter(id => typeof id === 'string' && board.strokes.has(id));
      gone.forEach(id => { board.points -= board.strokes.get(id).points.length; board.strokes.delete(id); });
      if (gone.length) socket.to(`sfu:${roomId}`).emit('sfu:wb-erase', { roomId, ids: gone });
    });
    // Live captions (Teams-style, roadmap 2.8): speech is turned into text in each speaker's own
    // browser (call-extras.js) and relayed here only to the people in the room who turned captions
    // on. While anyone has them on, everyone's browser transcribes its own unmuted microphone.
    handle('sfu:captions', async ({ roomId, on }) => {
      const m = admitted(roomId);
      m.captions = on === true;
      announceCaptions(roomId);
      return { wanted: captionsWanted(roomId) };
    });
    // Several a second while someone talks, so no per-event session reload (the socket was
    // authenticated on connect; being in the room is checked). At most 20 lines a second each.
    let captionWindow = 0, captionCount = 0;
    socket.on('sfu:caption', ({ roomId, text, final, unavailable } = {}) => {
      const m = roomUserMap.get(socket.id);
      if (!m || m.roomId !== roomId || m.inLobby) return;
      const now = Date.now();
      if (now - captionWindow > 1000) { captionWindow = now; captionCount = 0; }
      if (++captionCount > 20) return;
      const line = { roomId, peerId: m.peerId, fullName: m.fullName, text: String(text || '').slice(0, 300), final: final === true, unavailable: unavailable === true };
      for (const [sid, x] of roomUserMap.entries()) if (x.roomId === roomId && !x.inLobby && x.captions) io.to(sid).emit('sfu:caption', line);
    });
    // Spotlight: one person's video shown large for everyone in the call (Teams "Spotlight for
    // everyone"). Meetings: the owner. Calls: anyone in the call, as with recording. null clears it.
    async function maySpotlight(roomId, u) {
      return !roomId.startsWith('meet:') || (await meetingOwnerId(mainOf(roomId))) === u.id;
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
        if ((await meetingOwnerId(mainOf(roomId))) !== u.id) throw Error('Only the meeting owner can record this meeting.');
        return { meetingCode: mainOf(roomId), scope: null };
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