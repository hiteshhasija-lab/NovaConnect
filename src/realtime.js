const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { redis } = require('./redis');
const { db, nowStr } = require('./db');
const { createGroupCalls } = require('./group-calls');
const { isOutOfOffice, shownStatus, deviceOf, CALENDAR_BUSY_SQL } = require('./presenceRules');

let io = null;
let endAllCalls = async () => {}; // set in attach(): ends running calls cleanly on shutdown
// userId -> Set of live socket ids. A user counts as "online" while this set is non-empty.
const onlineSockets = new Map();
// Per-device presence: socket.id -> { userId, device ('web' | 'desktop' | 'iphone' | 'mobile'), idle }.
// The web and desktop clients say when they go idle (no input for 5 minutes) and come back
// ('presence:activity'); someone shows Away only when every device they have open is idle.
const socketInfo = new Map();
function allIdle(userId) {
  const ids = [...(onlineSockets.get(userId) || [])];
  return ids.length > 0 && ids.every(id => socketInfo.get(id)?.idle);
}
// Where someone is signed in right now, for their profile card: [{ device, active }], one per kind.
function devicesOf(userId) {
  const byDevice = new Map();
  for (const id of onlineSockets.get(userId) || []) {
    const info = socketInfo.get(id);
    if (!info) continue;
    byDevice.set(info.device, (byDevice.get(info.device) || false) || !info.idle);
  }
  return [...byDevice].map(([device, active]) => ({ device, active }));
}
const { createPresenceGrace } = require('./presence-grace');
const presenceGrace = createPresenceGrace({
  isConnected: id => !!onlineSockets.get(id)?.size,
  // Gone offline: people see Offline, or Out of office while that is on (presenceRules.js).
  write: async (id, _offline, lastSeen) => {
    const row = await db.prepare('SELECT ooo_enabled, ooo_start_at, ooo_end_at FROM users WHERE id = ?').get(id);
    const status = shownStatus({ connected: false, outOfOffice: isOutOfOffice(row, nowStr()) });
    await db.prepare('UPDATE users SET status = ?, last_seen_at = ? WHERE id = ?').run(status, lastSeen, id);
    await broadcastPresence(id, status);
  }
});

async function roomsForUser(userId) {
  const channels = await db.prepare(`
    SELECT c.id FROM channels c
    JOIN team_members tm ON tm.team_id = c.team_id AND tm.user_id = ?
    WHERE c.is_private = 0
    UNION
    SELECT cm.channel_id AS id FROM channel_members cm WHERE cm.user_id = ?
  `).all(userId, userId);
  const convos = await db.prepare(`SELECT conversation_id AS id FROM dm_participants WHERE user_id = ?`).all(userId);
  return {
    channelRooms: channels.map(c => `channel:${c.id}`),
    dmRooms: convos.map(c => `dm:${c.id}`)
  };
}

async function broadcastPresence(userId, status) {
  if (!io) return;
  io.emit('presence:update', { userId, status });
}

// Presence from calls, the calendar and out of office (Teams-style): while you're in a call your
// status reads "In a call" (1:1 and group chats) or "In a meeting" (channel meetings, meeting links),
// and "Presenting" while you share your screen; a busy meeting on your calendar reads "In a meeting"
// and out of office reads "Out of office". The order between them, and which chosen statuses win, is
// in presenceRules.js. The result is written to users.status like any status, so every view shows it,
// and your chosen status (presence_preference) comes back when the call, meeting or absence ends.
// Recomputed shortly after anything that could change it (the call room map, CallRoomMap below; a
// lobby admit; a screen share; a meeting or out-of-office change), and by the scheduler's sweep when
// a meeting or an absence starts or ends (refreshScheduledPresence).
let callActivity = () => null; // userId -> 'presenting' | 'inmeeting' | 'incall' | null; set in attach()
const presenceTimers = new Map();
function touchPresence(userId) {
  if (!userId) return;
  clearTimeout(presenceTimers.get(userId));
  presenceTimers.set(userId, setTimeout(() => {
    presenceTimers.delete(userId);
    refreshPresence(userId).catch(err => console.error('presence refresh failed:', err.message));
  }, 300));
}
const PRESENCE_COLUMNS = 'id, status, presence_preference, ooo_enabled, ooo_start_at, ooo_end_at';
// The status to show for one person; `chosen` replaces their saved choice (presence:set).
async function presenceFor(userId, chosen) {
  const now = nowStr();
  const row = await db.prepare(`SELECT ${PRESENCE_COLUMNS} FROM users WHERE id = ?`).get(userId);
  if (!row) return null;
  const meeting = await db.prepare(CALENDAR_BUSY_SQL + ' AND a.user_id = ? LIMIT 1').get(now, now, userId);
  const shown = shownStatus({
    connected: isOnline(userId), chosen: chosen === undefined ? row.presence_preference : chosen,
    call: callActivity(userId), calendarMeeting: !!meeting, outOfOffice: isOutOfOffice(row, now), idle: allIdle(userId)
  });
  return { row, shown };
}
// Writes the status only if nothing changed it since it was read (a status change or another refresh
// in between wins), and tells everyone.
async function writePresence(row, shown) {
  if (shown === row.status) return;
  const result = await db.prepare('UPDATE users SET status = ? WHERE id = ? AND status = ? AND presence_preference IS NOT DISTINCT FROM ?')
    .run(shown, row.id, row.status, row.presence_preference);
  if (result.changes) await broadcastPresence(row.id, shown);
}
async function refreshPresence(userId) {
  if (!isOnline(userId)) return; // going offline: the disconnect handler (presence grace) sets that
  const r = await presenceFor(userId);
  if (r) await writePresence(r.row, r.shown);
}
// The scheduler's sweep (every 15 s): meetings and absences start and end on the clock, with no
// event to react to. Looks at everyone connected plus everyone with out of office on (or showing).
// A person who isn't connected is only changed once they have settled as Offline / Out of office,
// so this never cuts short the reconnect grace (presence-grace.js).
async function refreshScheduledPresence() {
  const now = nowStr();
  const connected = [...onlineSockets].filter(([, sockets]) => sockets.size).map(([id]) => id);
  const busy = new Set((await db.prepare(CALENDAR_BUSY_SQL).all(now, now)).map(r => r.user_id));
  const rows = await db.prepare(`SELECT ${PRESENCE_COLUMNS} FROM users WHERE ooo_enabled = 1 OR status = 'ooo'` +
    (connected.length ? ` OR id IN (${connected.map(() => '?').join(',')})` : '')).all(...connected);
  for (const row of rows) {
    const online = isOnline(row.id);
    if (!online && !['offline', 'ooo'].includes(row.status)) continue;
    const shown = shownStatus({
      connected: online, chosen: row.presence_preference, call: callActivity(row.id),
      calendarMeeting: busy.has(row.id), outOfOffice: isOutOfOffice(row, now), idle: allIdle(row.id)
    });
    await writePresence(row, shown);
  }
}
// socket.id -> { roomId, peerId, userId, inLobby, ... } for every call/meeting room a socket is in,
// shared by group-calls.js and meet-signaling.js; joining or leaving one updates call presence.
class CallRoomMap extends Map {
  set(key, value) { super.set(key, value); touchPresence(value?.userId); return this; }
  delete(key) { const value = this.get(key); const removed = super.delete(key); if (value) touchPresence(value.userId); return removed; }
  touch(userId) { touchPresence(userId); }
}

function attach(server, sessionMiddleware) {
  // socket.io's Engine.IO instance can bind to more than one underlying http(s) server —
  // when both the plain-HTTP and TLS listeners are running, attach() is called twice and
  // the second call must bind the existing Server rather than create a second, disconnected one.
  if (io) {
    io.attach(server);
    return io;
  }

  io = new Server(server, { cors: { origin: false } });

  // Redis adapter for horizontal scaling: pub/sub across multiple Node workers.
  const pubClient = redis.duplicate();
  const subClient = redis.duplicate();
  io.adapter(createAdapter(pubClient, subClient));

  // Reuse the express-session middleware so each socket has req.session.user available,
  // the same identity the HTTP routes trust — no separate socket auth scheme needed.
  const wrap = (mw) => (socket, next) => mw(socket.request, {}, next);
  io.use(wrap(sessionMiddleware));

  io.use((socket, next) => {
    const user = socket.request.session && socket.request.session.user;
    if (!user) return next(new Error('unauthorized'));
    // A temporary password has to be replaced first: no live events until then.
    if (user.must_change_password) return next(new Error('password change required'));
    socket.user = user;
    next();
  });

  // socket.io does not catch a rejected promise returned from an async listener — it becomes
  // an unhandled rejection that crashes the whole process (taking every connected user down
  // with it) the moment the database hiccups. Every listener body below is guarded accordingly.
  // All calls (1:1 chats, group chats, channel "Meet now") and meetings go through the SFU.
  // group-calls.js decides who is in which call; meet-signaling.js runs meetings and serves the
  // media (sfu:*) events for both. roomUserMap (socket.id -> the room it's in) is how they share it.
  const roomUserMap = new CallRoomMap();
  const groupCalls = createGroupCalls(io, db, roomUserMap);
  const { getRoom, createWorkers } = require('./sfu');
  // Start the media workers now (one per core) rather than on the first call.
  createWorkers().catch(err => console.error('mediasoup workers failed to start:', err.message));
  callActivity = userId => {
    let kind = null;
    for (const m of roomUserMap.values()) {
      if (m.userId !== userId || m.inLobby) continue;
      const peer = getRoom(m.roomId)?.peers.get(m.peerId);
      if (peer && [...peer.producers.values()].some(p => !p.closed && p.appData?.source === 'screen')) return 'presenting';
      const meeting = m.roomId.startsWith('meet:') || groupCalls.scopeForRoom(m.roomId)?.type === 'channel';
      kind = meeting ? 'inmeeting' : kind || 'incall';
    }
    return kind;
  };
  endAllCalls = reason => groupCalls.endAll(reason);
  const meet = require('./meet-signaling').createMeetSignaling(io, db, roomUserMap, { scopeForRoom: roomId => groupCalls.scopeForRoom(roomId) });
  io.on('connection', (socket) => {
    meet.attach(socket);
    groupCalls.attach(socket);
    const userId = socket.user.id;

    (async () => {
      const settledPresence = presenceGrace.reconnect(userId);
      const wasOffline = !onlineSockets.has(userId) || onlineSockets.get(userId).size === 0;
      if (!onlineSockets.has(userId)) onlineSockets.set(userId, new Set());
      onlineSockets.get(userId).add(socket.id);
      socketInfo.set(socket.id, { userId, device: deviceOf(socket.handshake.headers['user-agent']), idle: false });
      if (!wasOffline) touchPresence(userId);   // a new active device brings an idle "Away" back

      await settledPresence;
      const { channelRooms, dmRooms } = await roomsForUser(userId);
      channelRooms.forEach(r => socket.join(r));
      dmRooms.forEach(r => socket.join(r));
      socket.join(`user:${userId}`);

      if (wasOffline) {
        const nextStatus = (await presenceFor(userId))?.shown || 'online';
        await db.prepare('UPDATE users SET status = ?, last_seen_at = ? WHERE id = ?').run(nextStatus, nowStr(), userId);
        await broadcastPresence(userId, nextStatus);
      } else {
        const row = await db.prepare('SELECT status FROM users WHERE id = ?').get(userId);
        socket.emit('presence:update', { userId, status: row?.status || 'online' });
      }
    })().catch((err) => console.error('socket connection setup failed:', err.message));

    socket.on('typing', ({ scope, id }) => {
      if (!scope || !id) return;
      const room = scope === 'channel' ? `channel:${id}` : `dm:${id}`;
      socket.to(room).emit('typing', { scope, id: Number(id), userId, fullName: socket.user.full_name });
    });

    socket.on('presence:set', ({ status }) => {
      const allowed = ['online', 'away', 'brb', 'busy', 'dnd', 'offline', 'reset'];
      if (!allowed.includes(status)) return;
      // In a call, a chosen status other than Do not disturb / Appear offline shows once it ends.
      const chosen = status === 'reset' ? null : status;
      presenceFor(userId, chosen)
        .then(async (r) => {
          if (!r) return;
          await db.prepare('UPDATE users SET status = ?, presence_preference = ? WHERE id = ?').run(r.shown, chosen, userId);
          await broadcastPresence(userId, r.shown);
        })
        .catch((err) => console.error('presence:set failed:', err.message));
    });

    // The native app sends this before closing its idle background socket.
    // It never changes the user's explicit presence preference.
    socket.on('presence:background', (_payload, ack) => {
      socket.backgroundPresence = true;
      if (typeof ack === 'function') ack({ ok: true });
    });
    // Per-device presence: this device went idle (no input for 5 minutes) or came back.
    socket.on('presence:activity', (payload) => {
      const info = socketInfo.get(socket.id);
      const idle = !!(payload && payload.idle === true);
      if (!info || info.idle === idle) return;
      info.idle = idle;
      touchPresence(userId);
    });
    socket.on('disconnect', () => {
      socketInfo.delete(socket.id);
      const set = onlineSockets.get(userId);
      if (!set) return;
      set.delete(socket.id);
      if (set.size > 0) touchPresence(userId);   // the devices left open may all be idle
      if (set.size === 0) presenceGrace.disconnect(userId, socket.backgroundPresence === true,
        err => console.error('offline transition failed:', err.message));
    });
  });

  return io;
}

function getIO() {
  return io;
}

function isOnline(userId) {
  return onlineSockets.has(userId) && onlineSockets.get(userId).size > 0;
}

// Emit helpers used by REST route handlers after a DB write, so both socket-connected
// clients and the acting user's own other tabs see the change immediately.
function emitToChannel(channelId, event, payload) {
  if (io) io.to(`channel:${channelId}`).emit(event, payload);
}
function emitToConversation(conversationId, event, payload) {
  if (io) io.to(`dm:${conversationId}`).emit(event, payload);
}
function emitToUser(userId, event, payload) {
  if (io) io.to(`user:${userId}`).emit(event, payload);
}
// After a user joins/leaves a team, channel, or DM their socket needs to (un)subscribe
// to the corresponding rooms without waiting for a reconnect.
async function resyncUserRooms(userId) {
  if (!io) return;
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  if (sockets.length === 0) return;
  const { channelRooms, dmRooms } = await roomsForUser(userId);
  const want = new Set([...channelRooms, ...dmRooms, `user:${userId}`]);
  for (const s of sockets) {
    for (const room of s.rooms) {
      if (room !== s.id && !want.has(room)) s.leave(room);
    }
    want.forEach(r => s.join(r));
  }
}

// Clean shutdown: end running calls (posts their outcomes), then drop every socket so the HTTP
// servers can actually close (open websockets otherwise keep server.close() waiting forever).
async function shutdownRealtime(reason) {
  try { await endAllCalls(reason); } catch { /* best effort */ }
  if (io) io.disconnectSockets(true);
}


// Nobody is in a call right after a (re)start: clear call statuses left from before it. Called by
// server.js once the database is ready (on a fresh install the tables don't exist until the
// migrations have run, so this can't run when the sockets are attached).
function resetCallPresence() {
  return db.prepare(`UPDATE users SET status = 'offline' WHERE status IN ('incall', 'inmeeting', 'presenting')`).run()
    .catch(err => console.error('call presence reset failed:', err.message));
}

// Closes every open socket of a person (their sessions were revoked); a client that is still
// signed in reconnects by itself.
function disconnectUser(userId) {
  if (io) io.in(`user:${userId}`).disconnectSockets(true);
}

module.exports = { disconnectUser, resetCallPresence, touchPresence, refreshScheduledPresence, devicesOf, attach, getIO, isOnline, emitToChannel, emitToConversation, emitToUser, resyncUserRooms, shutdownRealtime };
