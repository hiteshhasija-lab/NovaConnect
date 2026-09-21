const { randomUUID } = require('node:crypto');

// One active call per user, bound to the browser tabs that place/answer it.
// Media travels over WebRTC; this module only relays authenticated signaling.
function createCalls(io, db, { ringMs = 30000, connectMs = 45000 } = {}) {
  const calls = new Map();
  const busy = new Map();
  const attempts = new Map();
  const emitUser = (id, event, payload) => io.to(`user:${id}`).emit(event, payload);
  function end(call, reason) {
    if (!calls.delete(call.id)) return;
    clearTimeout(call.timer);
    busy.delete(call.from); busy.delete(call.to);
    for (const id of [call.from, call.to]) emitUser(id, 'call:ended', { id: call.id, reason });
  }
  function arm(call, ms, reason) {
    clearTimeout(call.timer);
    call.timer = setTimeout(() => end(call, reason), ms);
    call.timer.unref?.();
  }
  async function activeUser(socket) {
    const session = socket.request.session;
    await new Promise((resolve, reject) => session.reload(err => err ? reject(new Error('Please sign in again.')) : resolve()));
    if (session.user?.id !== socket.user.id) throw new Error('Please sign in again.');
    const user = await db.prepare('SELECT id, full_name, active FROM users WHERE id = ?').get(socket.user.id);
    if (!user?.active) throw new Error('This account is inactive.');
    return user;
  }
  function boundCall(socket, id) {
    const call = calls.get(id);
    if (!call || (call.callerSocket !== socket.id && call.calleeSocket !== socket.id)) throw new Error('Call is no longer available.');
    return call;
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
    handle('call:config', () => {
      let iceServers;
      try { iceServers = JSON.parse(process.env.WEBRTC_ICE_SERVERS || '[]'); }
      catch { throw new Error('Calling is not configured correctly. Contact your administrator.'); }
      if (!Array.isArray(iceServers)) throw new Error('Invalid calling configuration.');
      return { iceServers };
    });
    handle('call:start', async (data, user) => {
      const conversationId = Number(data.conversationId);
      if (!Number.isSafeInteger(conversationId) || conversationId < 1 || !['audio', 'video'].includes(data.mode)) throw new Error('Invalid call request.');
      const last = attempts.get(user.id) || 0;
      if (Date.now() - last < 2000) throw new Error('Please wait a moment before calling again.');
      attempts.set(user.id, Date.now());
      const members = await db.prepare(`SELECT u.id, u.full_name, u.active FROM dm_participants dp
        JOIN users u ON u.id = dp.user_id JOIN dm_conversations dc ON dc.id = dp.conversation_id
        WHERE dc.id = ? AND dc.is_group = 0`).all(conversationId);
      if (members.length !== 2 || !members.some(m => m.id === user.id) || members.some(m => !m.active)) throw new Error('Calls require a direct conversation with two active members.');
      const other = members.find(m => m.id !== user.id);
      const peers = await io.in(`user:${other.id}`).fetchSockets();
      if (!peers.length) throw new Error('This person is offline.');
      if (!socket.connected) throw new Error('Disconnected.');
      if (busy.has(user.id) || busy.has(other.id)) throw new Error('You or this person are already in a call.');
      const call = { id: randomUUID(), from: user.id, to: other.id, callerSocket: socket.id, calleeSocket: null, state: 'ringing', mode: data.mode, conversationId, ready: new Set() };
      calls.set(call.id, call); busy.set(user.id, call.id); busy.set(other.id, call.id);
      arm(call, ringMs, 'No answer');
      emitUser(other.id, 'call:incoming', { id: call.id, mode: call.mode, conversationId, caller: { id: user.id, name: user.full_name } });
      return { id: call.id, peer: other.full_name };
    });
    handle('call:accept', (data, user) => {
      const call = calls.get(data.id);
      if (!call || call.to !== user.id || call.state !== 'ringing') throw new Error('Call is no longer available.');
      call.calleeSocket = socket.id; call.state = 'connecting';
      arm(call, connectMs, 'Unable to connect');
      io.to(call.callerSocket).emit('call:accepted', { id: call.id });
      emitUser(user.id, 'call:answered', { id: call.id, socketId: socket.id });
      return {};
    });
    handle('call:decline', (data, user) => {
      const call = calls.get(data.id);
      if (!call || call.to !== user.id || call.state !== 'ringing') throw new Error('Call is no longer available.');
      end(call, 'Call declined'); return {};
    });
    handle('call:end', data => { end(boundCall(socket, data.id), 'Call ended'); return {}; });
    handle('call:connected', data => {
      const call = boundCall(socket, data.id);
      if (call.state === 'ringing') throw new Error('Call has not been accepted.');
      call.ready.add(socket.id);
      if (call.ready.size === 2) { clearTimeout(call.timer); call.state = 'connected'; }
      return {};
    });
    handle('call:signal', data => {
      const call = boundCall(socket, data.id);
      if (call.state === 'ringing') throw new Error('Call has not been accepted.');
      const s = data.signal;
      if (!s || JSON.stringify(s).length > 65536) throw new Error('Invalid call signal.');
      const caller = socket.id === call.callerSocket;
      if (s.description) {
        if (s.description.type !== (caller ? 'offer' : 'answer') || typeof s.description.sdp !== 'string') throw new Error('Invalid call description.');
      } else if (!s.candidate || typeof s.candidate.candidate !== 'string') throw new Error('Invalid call candidate.');
      io.to(caller ? call.calleeSocket : call.callerSocket).emit('call:signal', { id: call.id, signal: s });
      return {};
    });
    socket.on('disconnect', () => {
      for (const call of calls.values()) {
        if (call.callerSocket === socket.id || call.calleeSocket === socket.id) end(call, 'Connection lost');
      }
      if (!busy.has(socket.user.id)) attempts.delete(socket.user.id);
    });
  }
  return { attach };
}
module.exports = { createCalls };
