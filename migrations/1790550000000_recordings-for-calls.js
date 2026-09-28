/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

// Recordings of calls (1:1 chats, group chats, channel meetings), not just meeting links: a call
// recording has no meeting link, and says instead which chat or channel it belongs to (it is
// posted there as a file). Additive, so the previous app version keeps working.
exports.up = (pgm) => {
  pgm.alterColumn('recordings', 'meeting_link_code', { notNull: false });
  pgm.addColumns('recordings', {
    scope_type: { type: 'text' },    // 'dm' | 'channel' for call recordings; null for meetings
    scope_id: { type: 'integer' },   // dm_conversations.id or channels.id
  });
};

exports.down = (pgm) => {
  pgm.dropColumns('recordings', ['scope_type', 'scope_id']);
  pgm.alterColumn('recordings', 'meeting_link_code', { notNull: true });
};
