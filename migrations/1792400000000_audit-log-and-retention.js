// Audit log and message retention (Phase 3, "Admin and compliance").
//
// audit_log: who did what, when, from where: sign-ins (and failed ones), administration, team and
// channel changes, message deletions, retention changes and runs (src/audit.js). The app only ever
// inserts into it; nothing in it is updated or deleted. Never holds message text or passwords.
// actor_name / target_name are copies taken at the time, so the record still reads right after a
// rename. Times are UTC 'YYYY-MM-DD HH:MM:SS' text like every other time column.
//
// org_settings: organisation-wide settings an admin changes in the app (not .env): the retention
// policy is the first (src/retention.js). Nothing is stored until an admin saves, so an upgrade
// keeps every message.
exports.up = (pgm) => {
  pgm.createTable('audit_log', {
    id: 'id',
    at: { type: 'text', notNull: true },
    actor_id: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    actor_name: { type: 'text' },
    action: { type: 'text', notNull: true },
    target_type: { type: 'text' },
    target_id: { type: 'text' },
    target_name: { type: 'text' },
    ip: { type: 'text' },
    user_agent: { type: 'text' },
    details: { type: 'text' },
  });
  pgm.createIndex('audit_log', 'at');
  pgm.createIndex('audit_log', 'action');
  pgm.createIndex('audit_log', 'actor_id');

  pgm.createTable('org_settings', {
    key: { type: 'text', primaryKey: true },
    value: { type: 'text', notNull: true },
    updated_at: { type: 'text', notNull: true },
    updated_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('org_settings');
  pgm.dropTable('audit_log');
};
