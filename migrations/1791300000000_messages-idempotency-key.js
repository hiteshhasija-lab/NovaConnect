// NovaDesk's decommission cards are posted with an idempotency key (see routes/integrationsIn.js),
// so a retried post whose first try was already saved cannot show the card twice. Additive: the
// previous version of the app ignores the column. The unique index is partial (NULL keys are every
// ordinary message), so it adds nothing to normal chat traffic.
exports.up = (pgm) => {
  pgm.addColumn('messages', { idempotency_key: { type: 'text' } }, { ifNotExists: true });
  pgm.createIndex('messages', 'idempotency_key', {
    name: 'messages_idempotency_key_uq',
    unique: true,
    where: 'idempotency_key IS NOT NULL',
    ifNotExists: true,
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('messages', 'idempotency_key', { name: 'messages_idempotency_key_uq', ifExists: true });
  pgm.dropColumn('messages', 'idempotency_key', { ifExists: true });
};
