/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

// A standalone meeting's chat (meeting links, /app/meet/<code>), kept after the meeting like in
// Teams: shown again when the meeting link is used later, and readable from the Meet page by
// whoever took part. Calls in chats and channels already save their chat there instead.
// Additive, so the previous app version keeps working.
exports.up = (pgm) => {
  pgm.createTable('meet_chat_messages', {
    id: 'id',
    meet_link_code: { type: 'text', notNull: true, references: 'meet_links', onDelete: 'CASCADE' },
    user_id: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    body: { type: 'text', notNull: true },
    created_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
  });
  pgm.createIndex('meet_chat_messages', ['meet_link_code', 'id']);
  // Everyone who has been let into a meeting (the owner included): who may read its chat later.
  pgm.createTable('meet_attendees', {
    meet_link_code: { type: 'text', notNull: true, references: 'meet_links', onDelete: 'CASCADE' },
    user_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    first_joined_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
  }, { constraints: { primaryKey: ['meet_link_code', 'user_id'] } });
  pgm.createIndex('meet_attendees', 'user_id');
};

exports.down = (pgm) => {
  pgm.dropTable('meet_attendees');
  pgm.dropTable('meet_chat_messages');
};
