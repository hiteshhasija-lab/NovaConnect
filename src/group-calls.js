const { randomUUID } = require('node:crypto');
const { createRoom, deleteRoom, closePeerTransports } = require('./sfu');

// Calls in group chats. Starting one rings every member; anyone in the chat can join while it
// runs, and it ends when the last person leaves. Media goes through the mediasoup SFU: this
// module only manages who is in which call. The transport/produce/consume events themselves are
// served by meet-signaling.js, which accepts any socket whose roomUserMap entry names that room.
function createGroupCalls(io, db, sfuInstance, { ringMs = 30000, inDirectCall = () => false } = {}) {
  const calls = new Map();          // callId -> call
  const byConversation = new Map(); // conversationId -> callId
  const emitUser = (id, event, payload) => io.to(`user:${id}`).emit(event, payload);

  async function activeUser(socket) {
    const session = socket.request.session;
    await new Promise((resolve, reject) => session.reload(err => err ? reject(new Error('Please sign in again.')) : resolve()));
    if (session.user?.id !== socket.user.id) throw new Error('Please sign in again.');
    const user = await db.prepare('SELECT id, full_name, active FROM users WHERE id = ?').get(socket.user.id);
    if (!user?.active) throw new Error('This account is inactive.');
    return user;
  }

  async function groupMembers(conversationId, userId) {
    const members = await db.prepare(`SELECT u.id, u.full_name FROM dm_participants dp
      JOIN users u ON u.id = dp.user_id JOIN dm_conversations dc ON dc.id = dp.conversation_id
      WHERE dc.id = ? AND dc.is_group = 1 AND u.active = 1`).all(conversationId);
    if (!members.some(m => m.id === userId)) throw new Error('Calls are available to members of this group chat.');
    return members;
  }

  function inGroupCall(userId, exceptCallId = null) {
    for (const call of calls.values()) {
      if (call.id === exceptCallId) continue;
      for (const m of call.members.values()) if (m.userId === userId) return true;
    }
    return false;
  }

  function summary(call) {
    return { id: call.id, conversationId: call.conversationId, mode: call.mode, count: call.members.size };
  }

  // Lets every member's chat header show whether a call is running and how many are in it.
  function broadcastState(call, active = true) {
    for (const id of call.userIds) emitUser(id, 'gcall:state', { conversationId: call.conversationId, call: active ? summary(call) : null });
  }

  function end(call) {
    if (!calls.delete(call.id)) return;
    byConversation.delete(call.conversationId);
    clearTimeout(call.ringTimer);
    deleteRoom(call.roomId);
    for (const id of call.userIds) emitUser(id, 'gcall:ended', { id: call.id });
    broadcastState(call, false);
  }

  function leave(socket, call) {
    const m = call.members.get(socket.id);
    if (!m) return;
    call.members.delete(socket.id);
    if (sfuInstance.roomUserMap.get(socket.id)?.roomId === call.roomId) sfuInstance.roomUserMap.delete(socket.id);
    closePeerTransports(call.roomId, m.peerId);
    socket.leave('sfu:' + call.roomId);
    io.to('sfu:' + call.roomId).emit('sfu:peer-left', { peerId: m.peerId, userId: m.userId, fullName: m.fullName });
    if (call.members.size === 0) end(call);
    else broadcastState(call);
  }

  function attach(socket) {
    const handle = (event, fn) => socket.on(event, async (data, ack) => {
      if (typeof ack !== 'function') return;
      try {
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid call request.');
        const user = await activeUser(socket);
        if (!socket.connected) return;
        ack({ ok: true, ...await fn(data, user) });
      } catch (err) { ack({ ok: false, error: err.message }); }
    });

    // Starts a call in a group chat, or returns the one already running there.
    handle('gcall:start', async (data, user) => {
      const conversationId = Number(data.conversationId);
      if (!Number.isSafeInteger(conversationId) || conversationId < 1 || !['audio', 'video'].includes(data.mode)) throw new Error('Invalid call request.');
      const members = await groupMembers(conversationId, user.id);
      const running = calls.get(byConversation.get(conversationId));
      if (running) return { id: running.id, mode: running.mode };
      if (inDirectCall(user.id) || inGroupCall(user.id)) throw new Error('Finish your current call first.');

      const call = {
        id: randomUUID(), conversationId, mode: data.mode, startedBy: user.id,
        userIds: members.map(m => m.id), members: new Map(), ringTimer: null,
      };
      call.roomId = 'gcall:' + call.id;
      calls.set(call.id, call);
      byConversation.set(conversationId, call.id);

      const convo = await db.prepare('SELECT name FROM dm_conversations WHERE id = ?').get(conversationId);
      const title = convo?.name || members.filter(m => m.id !== user.id).map(m => m.full_name).join(', ');
      for (const m of members) {
        if (m.id !== user.id) emitUser(m.id, 'gcall:incoming', { id: call.id, conversationId, mode: call.mode, title, caller: { id: user.id, name: user.full_name } });
      }
      // Stop ringing after a while; the call stays joinable from the chat. If the caller never
      // actually joined (e.g. they denied microphone access), drop the empty call.
      call.ringTimer = setTimeout(() => {
        for (const id of call.userIds) emitUser(id, 'gcall:ring-stop', { id: call.id });
        if (call.members.size === 0) end(call);
      }, ringMs);
      call.ringTimer.unref?.();
      broadcastState(call);
      return { id: call.id, mode: call.mode, title };
    });

    handle('gcall:join', async (data, user) => {
      const call = calls.get(data.id);
      if (!call) throw new Error('This call has ended.');
      await groupMembers(call.conversationId, user.id);
      if (call.members.has(socket.id)) throw new Error('You are already in this call.');
      // Joining the same call from a second device or tab is fine (as in Teams); another call isn't.
      if (inDirectCall(user.id) || inGroupCall(user.id, call.id)) throw new Error('Finish your current call first.');
      if (sfuInstance.roomUserMap.has(socket.id)) throw new Error('Leave your meeting first.');

      const room = await createRoom(call.roomId);
      if (!calls.has(call.id)) throw new Error('This call has ended.');
      const peerId = `${user.id}-${socket.id}`;
      const member = { userId: user.id, peerId, fullName: user.full_name };
      call.members.set(socket.id, member);
      sfuInstance.roomUserMap.set(socket.id, { roomId: call.roomId, peerId, userId: user.id, fullName: user.full_name, inLobby: false });
      socket.join('sfu:' + call.roomId);
      socket.to('sfu:' + call.roomId).emit('sfu:peer-joined', { peerId, userId: user.id, fullName: user.full_name });
      emitUser(user.id, 'gcall:answered', { id: call.id, socketId: socket.id });
      broadcastState(call);
      return { roomId: call.roomId, peerId, mode: call.mode, routerRtpCapabilities: room.router.rtpCapabilities };
    });

    // Stops the ringing in this person's other tabs; the call itself carries on.
    handle('gcall:decline', (data, user) => {
      if (calls.has(data.id)) emitUser(user.id, 'gcall:ring-stop', { id: data.id });
      return {};
    });

    handle('gcall:leave', data => {
      const call = calls.get(data.id);
      if (call) leave(socket, call);
      return {};
    });

    handle('gcall:status', async (data, user) => {
      const conversationId = Number(data.conversationId);
      if (!Number.isSafeInteger(conversationId) || conversationId < 1) throw new Error('Invalid call request.');
      await groupMembers(conversationId, user.id);
      const call = calls.get(byConversation.get(conversationId));
      return { call: call ? summary(call) : null };
    });

    socket.on('disconnect', () => {
      for (const call of [...calls.values()]) leave(socket, call);
    });
  }

  return { attach, isBusy: inGroupCall };
}

module.exports = { createGroupCalls };
