// Calendar delegates (Calendar; src/delegates.js): someone you choose sees your meetings, sends
// meetings as you, answers your invitations and cancels the meetings you organize. meetings.
// scheduled_by records the delegate who sent a meeting for its organizer (NULL when they sent it).
exports.up = (pgm) => {
  pgm.createTable('calendar_delegates', {
    owner_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    delegate_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    created_at: { type: 'text', notNull: true },
  }, { constraints: { primaryKey: ['owner_id', 'delegate_id'] } });
  pgm.createIndex('calendar_delegates', 'delegate_id');
  pgm.addColumn('meetings', { scheduled_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' } });
};

exports.down = (pgm) => {
  pgm.dropColumn('meetings', 'scheduled_by');
  pgm.dropTable('calendar_delegates');
};
