const { randomUUID } = require('node:crypto');
const { createRoom, deleteRoom, closePeerTransports } = require('./sfu');
const { postToScope, updatePost, formatDuration } = require('./callPosts');
const { nowStr } = require('./db');
const { logger } = require('./logger');
const { redis } = require('./redis');

// Calls through the SFU, in three kinds of place:
//   - a group chat: starting one rings every member; anyone in the chat can join while it runs;
//   - a 1:1 chat: rings the other person; ends if they decline or don't answer, and ends when
//     either person hangs up (like a phone call);
//   - a channel ("Meet now"): rings nobody; it's announced in the channel (a post, and a Join
//     button in the channel header) and anyone who can see the channel can join.
// A call ends when the last person leaves. Media goes through the mediasoup SFU; this module only
// manages who is in which call. The transport/produce/consume events themselves (and the in-call
// extras) are served by meet-signaling.js, for any socket whose roomUserMap entry names the room.
function createGroupCalls(io, db, sfuInstance, { ringMs = 30000, inDirectCall = () => false } = {}) {
  const calls = new Map();   // callId -> call
  const byScope = new Map(); // 'dm:<conversationId>' | 'ch:<channelId>' -> callId
  const emitUser = (id, event, payload) => io.to(`user:${id}`).emit(event, payload);

  async function activeUser(socket) {
    const session = socket.request.session;
    await new Promise((resolve, reject) => session.reload(err => err ? reject(new Error('Please sign in again.')) : resolve()));
    if (session.user?.id !== socket.user.id) throw new Error('Please sign in again.');
    const user = await db.prepare('SELECT id, full_name, active FROM users WHERE id = ?').get(socket.user.id);
    if (!user?.active) throw new Error('This account is inactive.');
    return user;
  }

  // Where a call lives, validated against the database, and whether this user may be in it.
  function parseScope(data) {
    const conversationId = Number(data.conversationId), channelId = Number(data.channelId);
    if (Number.isSafeInteger(channelId) && channelId > 0) return { type: 'channel', id: channelId, key: 'ch:' + channelId };
    if (Number.isSafeInteger(conversationId) && conversationId > 0) return { type: 'dm', id: conversationId, key: 'dm:' + conversationId };
    throw new Error('Invalid call request.');
  }
  async function access(scope, userId) {
    if (scope.type === 'channel') {
      const ch = await db.prepare('SELECT id, name, team_id, is_private FROM channels WHERE id = ?').get(scope.id);
      if (!ch) throw new Error('Channel not found.');
      const inTeam = await db.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?').get(ch.team_id, userId);
      const inChannel = !ch.is_private || await db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?').get(ch.id, userId);
      if (!inTeam || !inChannel) throw new Error('Meetings are available to members of this channel.');
      return { title: '#' + ch.name, members: null, direct: false };
    }
    const convo = await db.prepare('SELECT id, name, is_group FROM dm_conversations WHERE id = ?').get(scope.id);
    const members = convo ? await db.prepare(`SELECT u.id, u.full_name FROM dm_participants dp
      JOIN users u ON u.id = dp.user_id WHERE dp.conversation_id = ? AND u.active = 1`).all(scope.id) : [];
    if (!members.some(m => m.id === userId)) throw new Error('Calls are available to members of this chat.');
    const direct = !convo.is_group;
    if (direct && members.length !== 2) throw new Error('Calls require a chat with two active members.');
    return { title: convo.name || null, members, direct };
  }

  function inGroupCall(userId, exceptCallId = null) {
    for (const call of calls.values()) {
      if (call.id === exceptCallId) continue;
      for (const m of call.members.values()) if (m.userId === userId) return true;
    }
    return false;
  }
  const distinctUsers = call => new Set([...call.members.values()].map(m => m.userId)).size;

  function summary(call) {
    return { id: call.id, conversationId: call.scope.type === 'dm' ? call.scope.id : undefined, channelId: call.scope.type === 'channel' ? call.scope.id : undefined, mode: call.mode, count: distinctUsers(call), direct: call.direct };
  }
  // Tell everyone who can see the chat/channel: send an event to its members, or its channel room.
  function tellScope(call, event, payload) {
    if (call.scope.type === 'channel') io.to(`channel:${call.scope.id}`).emit(event, payload);
    else for (const id of call.userIds) emitUser(id, event, payload);
  }
  // Lets headers show whether a call is running there and how many are in it.
  function broadcastState(call, active = true) {
    const where = call.scope.type === 'channel' ? { channelId: call.scope.id } : { conversationId: call.scope.id };
    tellScope(call, 'gcall:state', { ...where, call: active ? summary(call) : null });
  }

  // What the chat/channel shows once a call is over (Teams-style): the channel's "Started a meeting"
  // post becomes "Meeting ended · 12m"; a chat gets "Call ended · 5m" or "Missed call".
  // A 1:1 call that never connected says why: declined, not answered, or cancelled by the caller.
  const UNCONNECTED = { 'Call declined': '📞 Call declined', 'No answer': '📞 Missed call' };
  // rec is a live call or a record recovered after a crash (same fields). A recovered call's end
  // time is only known to within the 30s heartbeat, so its length says "about … (interrupted)".
  async function postOutcome(rec, reason, { endedAt = Date.now(), interrupted = false } = {}) {
    const len = from => (interrupted ? 'about ' : '') + formatDuration(endedAt - from) + (interrupted ? ' (interrupted)' : '');
    const talked = rec.connectedAt ? len(rec.connectedAt) : null;
    const since = len(rec.startedAt);
    if (rec.scope.type === 'channel') {
      if (rec.postId) await updatePost(io, rec.scope, rec.postId, `📹 Meeting ended · ${since}`, { call: 'ended', callId: rec.id });
    } else if (rec.direct) {
      const text = talked ? `📞 Call ended · ${talked}` : (UNCONNECTED[reason] || '📞 Call cancelled');
      const kind = talked ? 'ended' : reason === 'Call declined' ? 'declined' : reason === 'No answer' ? 'missed' : 'cancelled';
      await postToScope(io, rec.scope, rec.startedBy, text, { call: kind, callId: rec.id });
    } else {
      await postToScope(io, rec.scope, rec.startedBy, talked ? `📞 Group call ended · ${since}` : '📞 Missed group call', { call: talked ? 'ended' : 'missed', callId: rec.id });
    }
  }

  // Running calls are also recorded in Redis (refreshed every 30s), so if the server dies without
  // a clean shutdown, the next start can still post each call's outcome (startup sweep below).
  const REDIS_PREFIX = 'nc:gcall:';
  function persist(call) {
    const rec = { id: call.id, scope: call.scope, startedBy: call.startedBy, direct: call.direct, startedAt: call.startedAt, connectedAt: call.connectedAt, postId: call.postId, lastSeenAt: Date.now() };
    redis.set(REDIS_PREFIX + call.id, JSON.stringify(rec), 'EX', 7 * 24 * 3600).catch(() => {});
  }
  const heartbeat = setInterval(() => { for (const call of calls.values()) persist(call); }, 30000);
  heartbeat.unref?.();

  // Resolves once the outcome is posted and the Redis record dropped (awaited on clean shutdown).
  function end(call, reason = null) {
    if (!calls.delete(call.id)) return Promise.resolve();
    const posted = postOutcome(call, reason).then(() => redis.del(REDIS_PREFIX + call.id)).catch(() => {});
    byScope.delete(call.scope.key);
    clearTimeout(call.ringTimer);
    // Anyone still connected (the other person in a 1:1 call) is taken out of the room first.
    for (const [sid, m] of call.members) {
      if (sfuInstance.roomUserMap.get(sid)?.roomId === call.roomId) sfuInstance.roomUserMap.delete(sid);
      io.in(sid).socketsLeave('sfu:' + call.roomId);
      closePeerTransports(call.roomId, m.peerId);
    }
    call.members.clear();
    deleteRoom(call.roomId);
    tellScope(call, 'gcall:ended', { id: call.id, reason });
    broadcastState(call, false);
    return posted;
  }

  // Clean shutdown (a release restarts the server): end every call properly — everyone is told,
  // and each chat/channel gets its normal outcome post with the real length.
  async function endAll(reason) {
    const all = [...calls.values()].map(call => end(call, reason));
    await Promise.race([Promise.all(all), new Promise(resolve => setTimeout(resolve, 3000))]);
  }

  function leave(socket, call) {
    const m = call.members.get(socket.id);
    if (!m) return;
    call.members.delete(socket.id);
    if (sfuInstance.roomUserMap.get(socket.id)?.roomId === call.roomId) sfuInstance.roomUserMap.delete(socket.id);
    closePeerTransports(call.roomId, m.peerId);
    socket.leave('sfu:' + call.roomId);
    io.to('sfu:' + call.roomId).emit('sfu:peer-left', { peerId: m.peerId, userId: m.userId, fullName: m.fullName });
    // A 1:1 call ends when either person hangs up, once both had been in it.
    if (call.members.size === 0) end(call);
    else if (call.direct && call.connected && distinctUsers(call) < 2) end(call, 'Call ended');
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

    // Starts a call in a chat or channel, or returns the one already running there.
    handle('gcall:start', async (data, user) => {
      if (!['audio', 'video'].includes(data.mode)) throw new Error('Invalid call request.');
      const scope = parseScope(data);
      const place = await access(scope, user.id);
      const running = calls.get(byScope.get(scope.key));
      if (running) return { id: running.id, mode: running.mode, title: running.title };
      if (inDirectCall(user.id) || inGroupCall(user.id)) throw new Error('Finish your current call first.');

      const others = (place.members || []).filter(m => m.id !== user.id);
      if (place.direct) {
        const other = others[0];
        if (!(await io.in(`user:${other.id}`).fetchSockets()).length) throw new Error(other.full_name + ' is offline.');
        if (inDirectCall(other.id) || inGroupCall(other.id)) throw new Error(other.full_name + ' is in another call.');
      }
      const call = {
        id: randomUUID(), scope, mode: data.mode, startedBy: user.id, direct: place.direct, connected: false,
        startedAt: Date.now(), connectedAt: null, postId: null,
        userIds: (place.members || []).map(m => m.id), members: new Map(), ringTimer: null,
      };
      call.roomId = 'gcall:' + call.id;
      // For a 1:1 call each side sees the other's name; group chats show the chat's name.
      call.title = place.title || others.map(m => m.full_name).join(', ');
      calls.set(call.id, call);
      byScope.set(scope.key, call.id);

      if (scope.type === 'dm') {
        for (const m of others) {
          emitUser(m.id, 'gcall:incoming', {
            id: call.id, conversationId: scope.id, mode: call.mode, direct: call.direct,
            title: call.direct ? user.full_name : call.title, caller: { id: user.id, name: user.full_name },
          });
        }
      } else {
        // Meet now: post in the channel so people who aren't looking at it right now find out.
        // The post is rewritten to "Meeting ended · …" when it's over.
        try {
          const post = await postToScope(io, scope, user.id, `📹 Started a ${call.mode === 'video' ? 'video' : 'audio'} meeting in this channel. Use **Join** at the top of the channel to join.`, { call: 'started', callId: call.id });
          call.postId = post.id;
        } catch { /* the header Join button still announces it */ }
      }
      persist(call);
      // Stop ringing after a while. A 1:1 call nobody answered ends ("No answer"); a group or
      // channel call stays joinable, unless the caller never actually joined.
      call.ringTimer = setTimeout(() => {
        if (scope.type === 'dm') tellScope(call, 'gcall:ring-stop', { id: call.id });
        if (call.members.size === 0) end(call);
        else if (call.direct && !call.connected) end(call, 'No answer');
      }, ringMs);
      call.ringTimer.unref?.();
      broadcastState(call);
      return { id: call.id, mode: call.mode, title: call.title };
    });

    handle('gcall:join', async (data, user) => {
      const call = calls.get(data.id);
      if (!call) throw new Error('This call has ended.');
      await access(call.scope, user.id);
      if (call.members.has(socket.id)) throw new Error('You are already in this call.');
      // Joining the same call from a second device or tab is fine (as in Teams); another call isn't.
      if (inDirectCall(user.id) || inGroupCall(user.id, call.id)) throw new Error('Finish your current call first.');
      if (sfuInstance.roomUserMap.has(socket.id)) throw new Error('Leave your meeting first.');

      const room = await createRoom(call.roomId);
      if (!calls.has(call.id)) throw new Error('This call has ended.');
      const peerId = `${user.id}-${socket.id}`;
      const member = { userId: user.id, peerId, fullName: user.full_name };
      call.members.set(socket.id, member);
      // Connected = two different people have been in it (a call's length is counted from then).
      if (!call.connectedAt && distinctUsers(call) >= 2) { call.connectedAt = Date.now(); persist(call); }
      if (call.direct && distinctUsers(call) >= 2) { call.connected = true; clearTimeout(call.ringTimer); }
      sfuInstance.roomUserMap.set(socket.id, { roomId: call.roomId, peerId, userId: user.id, fullName: user.full_name, inLobby: false });
      socket.join('sfu:' + call.roomId);
      socket.to('sfu:' + call.roomId).emit('sfu:peer-joined', { peerId, userId: user.id, fullName: user.full_name });
      emitUser(user.id, 'gcall:answered', { id: call.id, socketId: socket.id });
      broadcastState(call);
      return { roomId: call.roomId, peerId, mode: call.mode, direct: call.direct, routerRtpCapabilities: room.router.rtpCapabilities };
    });

    // Group chat: stops the ringing in this person's other tabs; the call carries on.
    // 1:1 chat: the other person said no, so the call ends for the caller too.
    handle('gcall:decline', (data, user) => {
      const call = calls.get(data.id);
      if (!call) return {};
      if (call.direct && !call.connected && call.startedBy !== user.id) end(call, 'Call declined');
      else emitUser(user.id, 'gcall:ring-stop', { id: data.id });
      return {};
    });

    handle('gcall:leave', data => {
      const call = calls.get(data.id);
      if (call) {
        // The caller giving up before anyone answered a 1:1 call cancels it for the other side.
        if (call.direct && !call.connected && call.members.has(socket.id) && call.members.size === 1) end(call, 'Call cancelled');
        else leave(socket, call);
      }
      return {};
    });

    handle('gcall:status', async (data, user) => {
      const scope = parseScope(data);
      await access(scope, user.id);
      const call = calls.get(byScope.get(scope.key));
      return { call: call ? summary(call) : null };
    });

    socket.on('disconnect', () => {
      for (const call of [...calls.values()]) leave(socket, call);
    });
  }

  // Calls live only in this process's memory, so after a restart no meeting is running: any
  // "Started a … meeting" post still saying so is stale (e.g. the server restarted mid-meeting,
  // or the meeting predates the "Meeting ended" rewrite). Mark them ended; the length isn't known.
  // (Delayed: this module is set up before the database has finished initialising.)
  setTimeout(async () => {
    // Calls that were running when the server last died without a clean shutdown: post their
    // outcome now, timed to their last heartbeat.
    try {
      const keys = await redis.keys(REDIS_PREFIX + '*');
      for (const key of keys) {
        let rec = null; try { rec = JSON.parse(await redis.get(key)); } catch {}
        if (rec && !calls.has(rec.id)) {
          await postOutcome(rec, 'Interrupted', { endedAt: rec.lastSeenAt || Date.now(), interrupted: true }).catch(() => {});
          await redis.del(key);
        }
      }
      if (keys.length) logger.info({ recovered: keys.length }, 'Posted outcomes for calls interrupted by a restart');
    } catch (e) { logger.warn({ err: e.message }, 'Interrupted-call recovery failed'); }
    try {
      const stale = await db.prepare(`SELECT id, metadata FROM messages WHERE channel_id IS NOT NULL AND deleted = 0
        AND body LIKE '📹 Started a % meeting in this channel.%'`).all();
      let fixed = 0;
      for (const row of stale) {
        let meta = null; try { meta = row.metadata ? JSON.parse(row.metadata) : null; } catch {}
        if (meta && meta.call && meta.call !== 'started') continue;
        if (meta?.callId && calls.has(meta.callId)) continue; // started since this process came up
        await db.prepare('UPDATE messages SET body = ?, metadata = ?, updated_at = ? WHERE id = ?')
          .run('📹 Meeting ended', JSON.stringify({ call: 'ended', callId: meta?.callId || null }), nowStr(), row.id);
        fixed++;
      }
      if (fixed) logger.info({ fixed }, 'Marked stale "Started a meeting" posts as ended');
    } catch (e) { logger.warn({ err: e.message }, 'Stale meeting post sweep failed'); }
  }, 5000).unref?.();

  // The chat or channel a call room belongs to (for saving its in-call chat), if any.
  function scopeForRoom(roomId) {
    for (const call of calls.values()) if (call.roomId === roomId) return call.scope;
    return null;
  }

  return { attach, isBusy: inGroupCall, scopeForRoom, endAll };
}

module.exports = { createGroupCalls };
