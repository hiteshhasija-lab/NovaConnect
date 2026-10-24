// Edit history (Phase 3, "Messages"): every edit keeps the version it replaced, so anyone who can see
// a message can see how it read before ("(edited)" opens the list). body and metadata are the old
// version's (metadata carries an announcement's banner); replaced_at is when the edit replaced it
// (UTC 'YYYY-MM-DD HH:MM:SS', like every other time column). Deleting a message drops its history
// with it (routes/messages.js), the same as the deleted text itself.
// Messages edited before this existed have no earlier versions to show: edits_untracked marks them,
// so the history says so instead of calling the oldest version it has the original.
exports.up = (pgm) => {
  pgm.createTable('message_edits', {
    id: 'id',
    message_id: { type: 'integer', notNull: true, references: 'messages', onDelete: 'CASCADE' },
    body: { type: 'text', notNull: true, default: '' },
    metadata: { type: 'text' },
    replaced_at: { type: 'text', notNull: true },
  });
  pgm.createIndex('message_edits', 'message_id');
  pgm.addColumn('messages', { edits_untracked: { type: 'integer', notNull: true, default: 0 } });
  pgm.sql('UPDATE messages SET edits_untracked = 1 WHERE edited = 1');
};

exports.down = (pgm) => {
  pgm.dropColumn('messages', 'edits_untracked');
  pgm.dropTable('message_edits');
};
