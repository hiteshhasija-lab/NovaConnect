/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
exports.shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
exports.up = (pgm) => {
  // id is the app-generated 'rec-<ts>-<rand>' string from sfu.js, not a serial int.
  pgm.createTable('recordings', {
    id: { type: 'text', primaryKey: true },
    room_id: { type: 'text', notNull: true },
    meeting_link_code: { type: 'text', notNull: true },
    started_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    status: { type: 'text', notNull: true, default: 'completed' },
    storage_driver: { type: 'text' },
    storage_key: { type: 'text' },
    download_url: { type: 'text' },
    duration_ms: { type: 'bigint' },
    created_at: { type: 'text', notNull: true, default: pgm.func("to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')") },
  });
  pgm.createIndex('recordings', 'created_at');
  pgm.createIndex('recordings', 'meeting_link_code');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @param run {() => void | undefined}
 * @returns {Promise<void> | void}
 */
exports.down = (pgm) => {
  pgm.dropTable('recordings');
};
