// VIP people (Phase 3, "Notifications"; Teams' "priority access"): each person's own list of people
// whose messages always reach them — through Do not disturb and Presenting, and in chats and
// channels set to "mentions only" or "off" (src/vip.js, public/js/workspace.js). Private to its
// owner: nobody is told they are on someone's list.
exports.up = (pgm) => {
  pgm.createTable('vip_people', {
    user_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    vip_id: { type: 'integer', notNull: true, references: 'users', onDelete: 'CASCADE' },
    created_at: { type: 'text', notNull: true },
  }, { constraints: { primaryKey: ['user_id', 'vip_id'] } });
};

exports.down = (pgm) => {
  pgm.dropTable('vip_people');
};
