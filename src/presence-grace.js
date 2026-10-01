// Serializes disconnect writes with reconnects so a late database write cannot
// overwrite a newly connected user's presence. Does not alter their preference.
function createPresenceGrace({ isConnected, write, schedule = setTimeout, cancel = clearTimeout, now = () => new Date().toISOString() }) {
  const states = new Map();
  const queues = new Map();
  function enqueue(id, work) {
    const next = (queues.get(id) || Promise.resolve()).catch(() => {}).then(work);
    queues.set(id, next);
    next.finally(() => { if (queues.get(id) === next) queues.delete(id); }).catch(() => {});
    return next;
  }
  function reconnect(id) {
    const state = states.get(id);
    if (state) cancel(state.timer);
    states.delete(id);
    return enqueue(id, () => {});
  }
  function disconnect(id, background, onError) {
    const previous = states.get(id);
    if (previous) cancel(previous.timer);
    const state = { lastSeen: now() };
    states.set(id, state);
    const valid = () => states.get(id) === state && !isConnected(id);
    state.timer = schedule(() => {
      enqueue(id, async () => {
        if (!valid()) return;
        await write(id, 'offline', state.lastSeen);
        if (states.get(id) === state) states.delete(id);
      }).catch(onError);
    }, background ? 0 : 4000);
  }
  return { reconnect, disconnect };
}
module.exports = { createPresenceGrace };
