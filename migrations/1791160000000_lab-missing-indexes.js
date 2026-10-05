// The lab database (NOVAAPP01) was created by the app's own CREATE TABLE statements before
// node-pg-migrate existed, and it never got the lookup indexes that 1737800000000_initial_schema
// creates on a fresh install. Found by the clean-install schema drift check (#24, 2026-10-04).
// IF NOT EXISTS makes this a no-op on a fresh install, where the initial migration already made them.
const INDEXES = [
  ['messages', 'channel_id'],
  ['messages', 'conversation_id'],
  ['messages', 'user_id'],
  ['messages', 'parent_message_id'],
  ['messages', 'created_at'],
  ['messages', ['channel_id', 'parent_message_id']],
  ['dm_participants', 'user_id'],
  ['notifications', 'user_id'],
  ['notifications', 'is_read'],
  ['team_members', 'user_id'],
  ['channel_members', 'user_id'],
  ['attachments', 'message_id'],
];

exports.up = (pgm) => {
  for (const [table, columns] of INDEXES) pgm.createIndex(table, columns, { ifNotExists: true });
};

exports.down = (pgm) => {
  for (const [table, columns] of INDEXES) pgm.dropIndex(table, columns, { ifExists: true });
};
