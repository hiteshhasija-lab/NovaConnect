const { Server } = require('socket.io');
const { db, nowStr } = require('./db');
const { createCalls } = require('./calls');

let io = null;
// userId -> Set of live socket ids. A user counts as "online" while this set is non-empty.
const onlineSockets = new Map();
// userId -> pending setTimeout for the debounced "went offline" transition, so a quick
// page refresh (disconnect immediately followed by reconnect) doesn't flash offline.
const offlineTimers = new Map();
const OFFLINE_GRACE_MS = 4000;

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

function attach(server, sessionMiddleware) {
  // socket.io's Engine.IO instance can bind to more than one underlying http(s) server —
  // when both the plain-HTTP and TLS listeners are running, attach() is called twice and
  // the second call must bind the existing Server rather than create a second, disconnected one.
  if (io) {
    io.attach(server);
    return io;
  }

  io = new Server(server, { cors: { origin: false } });

  // Reuse the express-session middleware so each socket has req.session.user available,
  // the same identity the HTTP routes trust — no separate socket auth scheme needed.
  const wrap = (mw) => (socket, next) => mw(socket.request, {}, next);
  io.use(wrap(sessionMiddleware));

  io.use((socket, next) => {
    const user = socket.request.session && socket.request.session.user;
    if (!user) return next(new Error('unauthorized'));
    socket.user = user;
    next();
  });

  // socket.io does not catch a rejected promise returned from an async listener — it becomes
  // an unhandled rejection that crashes the whole process (taking every connected user down
  // with it) the moment the database hiccups. Every listener body below is guarded accordingly.
  const calls = createCalls(io, db);
  const meet = require('./meet-signaling').createMeetSignaling(io,db);
  io.on('connection', (socket) => {
    calls.attach(socket);
    meet.attach(socket);
    const userId = socket.user.id;

    (async () => {
      if (offlineTimers.has(userId)) {
        clearTimeout(offlineTimers.get(userId));
        offlineTimers.delete(userId);
      }
      const wasOffline = !onlineSockets.has(userId) || onlineSockets.get(userId).size === 0;
      if (!onlineSockets.has(userId)) onlineSockets.set(userId, new Set());
      onlineSockets.get(userId).add(socket.id);

      const { channelRooms, dmRooms } = await roomsForUser(userId);
      channelRooms.forEach(r => socket.join(r));
      dmRooms.forEach(r => socket.join(r));
      socket.join(`user:${userId}`);

      if (wasOffline) {
        const row = await db.prepare('SELECT status, presence_preference FROM users WHERE id = ?').get(userId);
        const nextStatus = row?.presence_preference || 'online';
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
      db.prepare('UPDATE users SET status = ?, presence_preference = ? WHERE id = ?').run(status === 'reset' ? 'online' : status, status === 'reset' ? null : status, userId)
        .then(() => broadcastPresence(userId, status === 'reset' ? 'online' : status))
        .catch((err) => console.error('presence:set failed:', err.message));
    });

    socket.on('disconnect', () => {
      const set = onlineSockets.get(userId);
      if (!set) return;
      set.delete(socket.id);
      if (set.size === 0) {
        const timer = setTimeout(() => {
          offlineTimers.delete(userId);
          if ((onlineSockets.get(userId) || new Set()).size > 0) return;
          db.prepare('UPDATE users SET status = ?, last_seen_at = ? WHERE id = ?').run('offline', nowStr(), userId)
            .then(() => broadcastPresence(userId, 'offline'))
            .catch((err) => console.error('offline transition failed:', err.message));
        }, OFFLINE_GRACE_MS);
        offlineTimers.set(userId, timer);
      }
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

module.exports = { attach, getIO, isOnline, emitToChannel, emitToConversation, emitToUser, resyncUserRooms };
