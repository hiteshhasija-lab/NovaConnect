const path = require('path');
const { runner } = require('node-pg-migrate');
const { pgConnection } = require('./db');

// Applies pending database migrations (migrations/, node-pg-migrate) before the app starts, so a
// fresh install creates its own tables and every upgrade brings its own schema changes — no more
// applying them by hand. All pending migrations run in one transaction under node-pg-migrate's
// advisory lock (two instances starting together can't both migrate). A failure stops startup
// rather than letting the app run against a half-updated schema; the release pipeline's health
// check then rolls back. Set MIGRATE_ON_START=false to apply migrations some other way.
async function runMigrations(logger) {
  if (process.env.MIGRATE_ON_START === 'false') {
    logger.warn('MIGRATE_ON_START=false: database migrations were not checked at startup.');
    return [];
  }
  const applied = await runner({
    databaseUrl: pgConnection,
    dir: path.join(__dirname, '..', 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count: Infinity,
    singleTransaction: true,
    // node-pg-migrate prints every SQL statement through its logger; keep only warnings/errors.
    logger: { debug() {}, info() {}, warn: (m) => logger.warn(m), error: (m) => logger.error(m) },
  });
  if (applied.length) logger.info({ migrations: applied.map((m) => m.name) }, `Database migrations applied: ${applied.length}`);
  else logger.info('Database schema is up to date.');
  return applied;
}

module.exports = { runMigrations };
