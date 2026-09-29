/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

// Per-chat and per-channel notification level (Teams-style): 'all' (every message alerts),
// 'mentions' (only when you're @mentioned), 'off' (no alerts, no unread dot). Mentions still reach
// the Activity feed at every level. A chat's old is_muted flag becomes 'off' and is kept in step
// (routes/dm.js). A channel with no row is 'all'. Additive, so the previous app version keeps working.
exports.up = (pgm) => {
  pgm.addColumns('dm_participants', {
    notify_level: { type: 'text', notNull: true, default: 'all', check: "notify_level IN ('all', 'mentions', 'off')" },
  });
  pgm.sql("UPDATE dm_participants SET notify_level = 'off' WHERE is_muted = 1");
  pgm.createTable('channel_notification_settings', {
    user_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    channel_id: { type: 'integer', notNull: true, references: 'channels', onDelete: 'CASCADE' },
    level: { type: 'text', notNull: true, check: "level IN ('all', 'mentions', 'off')" },
  }, { constraints: { primaryKey: ['user_id', 'channel_id'] } });
};

exports.down = (pgm) => {
  pgm.dropTable('channel_notification_settings');
  pgm.dropColumns('dm_participants', ['notify_level']);
};
