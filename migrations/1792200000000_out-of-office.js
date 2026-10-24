// Out of office (Phase 3, "Presence"): a person's own switch, a message people see on their profile
// card and above the composer when they write to them, and an optional window (UTC
// 'YYYY-MM-DD HH:MM:SS', like every other time column). Off by default, so an upgrade changes nobody.
// The index serves the presence sweep's "which meetings are on right now" lookup (src/realtime.js):
// meetings that already ended drop out on end_at.
exports.up = (pgm) => {
  pgm.addColumn('users', {
    ooo_enabled: { type: 'integer', notNull: true, default: 0 },
    ooo_message: { type: 'text' },
    ooo_start_at: { type: 'text' },
    ooo_end_at: { type: 'text' },
  });
  pgm.createIndex('meetings', 'end_at', { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropIndex('meetings', 'end_at', { ifExists: true });
  pgm.dropColumn('users', ['ooo_enabled', 'ooo_message', 'ooo_start_at', 'ooo_end_at']);
};
