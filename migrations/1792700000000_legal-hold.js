// Legal hold (Admin and compliance; src/legalHold.js): an admin keeps a person's, a channel's or a
// chat's messages from being destroyed while a case is open. A held message is skipped by message
// retention; when someone deletes one, it disappears for everyone as usual, but a copy (with its
// edit history and the list of its files) is kept in preserved_messages for admins. Releasing a hold
// ends that; what was preserved stays. scope_id is a users, channels or dm_conversations id,
// depending on scope_type ('person' | 'channel' | 'chat'); no foreign key, so a hold outlives what
// it names. Times are UTC 'YYYY-MM-DD HH:MM:SS' text, like every other time column.
exports.up = (pgm) => {
  pgm.createTable('legal_holds', {
    id: 'id',
    name: { type: 'text', notNull: true },
    reason: { type: 'text', notNull: true, default: '' },
    scope_type: { type: 'text', notNull: true },
    scope_id: { type: 'integer', notNull: true },
    scope_label: { type: 'text', notNull: true },
    created_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'text', notNull: true },
    released_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    released_at: { type: 'text' },
  });
  pgm.createIndex('legal_holds', ['scope_type', 'scope_id']);

  pgm.createTable('preserved_messages', {
    id: 'id',
    message_id: { type: 'integer', notNull: true },
    hold_ids: { type: 'text', notNull: true },
    author_id: { type: 'integer' },
    author_name: { type: 'text' },
    channel_id: { type: 'integer' },
    conversation_id: { type: 'integer' },
    place: { type: 'text' },
    body: { type: 'text', notNull: true, default: '' },
    metadata: { type: 'text' },
    edits: { type: 'text' },
    attachments: { type: 'text' },
    message_created_at: { type: 'text' },
    reason: { type: 'text', notNull: true },
    by_user_id: { type: 'integer' },
    preserved_at: { type: 'text', notNull: true },
  });
  pgm.createIndex('preserved_messages', 'message_id');
};

exports.down = (pgm) => {
  pgm.dropTable('preserved_messages');
  pgm.dropTable('legal_holds');
};
