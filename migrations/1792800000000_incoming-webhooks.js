// Incoming webhooks (Extensibility; src/webhooks.js): a channel's secret URL that another system
// posts messages to. Only a hash of the secret is stored (the URL is shown once, when it is made);
// a revoked webhook answers 404 like one that never existed. Goes with its channel.
exports.up = (pgm) => {
  pgm.createTable('channel_webhooks', {
    id: 'id',
    channel_id: { type: 'integer', notNull: true, references: 'channels', onDelete: 'CASCADE' },
    name: { type: 'text', notNull: true },
    secret_hash: { type: 'text', notNull: true },
    created_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'text', notNull: true },
    revoked_by: { type: 'integer', references: 'users', onDelete: 'SET NULL' },
    revoked_at: { type: 'text' },
    last_used_at: { type: 'text' },
    use_count: { type: 'integer', notNull: true, default: 0 },
  });
  pgm.createIndex('channel_webhooks', 'channel_id');
};

exports.down = (pgm) => {
  pgm.dropTable('channel_webhooks');
};
