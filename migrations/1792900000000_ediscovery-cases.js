// eDiscovery cases (Admin and compliance; src/ediscovery.js): an admin's case with one search —
// where to look (people, channels, chats; everywhere when none) and conditions (dates, words) — that
// is run, previewed and exported. criteria is JSON; the case keeps the last run's count. Closing a
// case keeps it (read-only). Times are UTC 'YYYY-MM-DD HH:MM:SS' text.
exports.up = (pgm) => {
  pgm.createTable('ediscovery_cases', {
    id: 'id',
    name: { type: 'text', notNull: true },
    description: { type: 'text', notNull: true, default: '' },
    criteria: { type: 'text', notNull: true, default: '{}' },
    created_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'text', notNull: true },
    last_run_at: { type: 'text' },
    last_count: { type: 'integer' },
    closed_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    closed_at: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('ediscovery_cases');
};
