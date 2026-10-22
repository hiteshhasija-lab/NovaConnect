// Signing a person out everywhere: deleting their stored sessions and closing their sockets.
// Used when an administrator resets a password and when someone changes theirs, so a session
// that was open before (a lost laptop, a hijacked cookie) does not survive the change.
const { redis } = require('./redis');

const PREFIX = 'nc:sess:';   // must match the RedisStore prefix in server.js

// Deletes every stored session that belongs to userId, except `exceptSessionId` (the one making
// the change). Returns how many were removed.
async function revokeUserSessions(userId, exceptSessionId = null) {
  let cursor = '0';
  let removed = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', PREFIX + '*', 'COUNT', 200);
    cursor = next;
    if (keys.length) {
      const values = await redis.mget(keys);
      const doomed = keys.filter((key, i) => {
        if (exceptSessionId && key === PREFIX + exceptSessionId) return false;
        try { const s = JSON.parse(values[i]); return Boolean(s && s.user && Number(s.user.id) === Number(userId)); } catch { return false; }
      });
      if (doomed.length) removed += await redis.del(...doomed);
    }
  } while (cursor !== '0');
  return removed;
}

module.exports = { revokeUserSessions, PREFIX };
