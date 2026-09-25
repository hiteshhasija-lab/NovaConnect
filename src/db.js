const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Postgres returns COUNT()/SUM() as bigint and AVG() as numeric, both of which
// node-postgres parses as STRINGS by default (bigint can exceed Number.MAX_SAFE_INTEGER).
// Parse them as plain numbers so the rest of the app can rely on that.
const { types: pgTypes } = require('pg');
pgTypes.setTypeParser(20, (val) => (val === null ? null : parseInt(val, 10))); // int8/bigint
pgTypes.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val))); // numeric

const knexInstance = require('knex')({
  client: 'pg',
  connection: {
    host: process.env.PGHOST || 'NOVAAPP01',
    port: process.env.PGPORT || 5432,
    user: process.env.PGUSER || 'novadesk',
    password: process.env.PGPASSWORD || 'novadesk_dev_pw',
    database: process.env.PGDATABASE || 'novaconnect'
  },
  pool: { min: 0, max: 10 }
});

// Every timestamp column is TEXT (not native TIMESTAMP), storing naive UTC strings
// formatted 'YYYY-MM-DD HH:MM:SS' — this avoids the pg driver silently turning
// timestamp columns into JS Date objects, which the rest of the app doesn't expect.
function nowStr() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}
function offsetStr(days = 0, hours = 0, minutes = 0) {
  const ms = Date.now() + days * 86400000 + hours * 3600000 + minutes * 60000;
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// Thin compatibility layer: db.prepare(sql).get/all/run(...) mirroring the
// synchronous node:sqlite shape — every call site just needs `await` added.
// @name bindings are translated to knex's :name style; a single non-array
// object argument is treated as named bindings, everything else positional.
function prepare(sql) {
  const pgSql = sql.replace(/@(\w+)/g, ':$1');
  const bindingsFrom = (args) => {
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      return args[0];
    }
    return args;
  };
  return {
    get: async (...args) => (await knexInstance.raw(pgSql, bindingsFrom(args))).rows[0],
    all: async (...args) => (await knexInstance.raw(pgSql, bindingsFrom(args))).rows,
    run: async (...args) => {
      const result = await knexInstance.raw(pgSql, bindingsFrom(args));
      return {
        lastInsertRowid: result.rows[0] ? result.rows[0].id : undefined,
        changes: result.rowCount
      };
    }
  };
}

const db = { transaction: fn => knexInstance.transaction(fn), prepare, raw: (sql, params) => knexInstance.raw(sql, params) };

const TS_DEFAULT = "DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))";

async function seedIfEmpty() {
  const userCount = (await db.prepare('SELECT COUNT(*) AS c FROM users').get()).c;
  if (Number(userCount) > 0) return;

  const insertUser = db.prepare(`
    INSERT INTO users (username, password_hash, full_name, email, role, title, status, status_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
  `);
  const mkHash = (pw) => bcrypt.hashSync(pw, 10);

  const admin = await insertUser.run('admin', mkHash('admin123'), 'Alex Admin', 'admin@corp.local', 'admin', 'Workspace Admin', 'online', null);
  const jdoe = await insertUser.run('jdoe', mkHash('member123'), 'Jane Doe', 'jane.doe@corp.local', 'member', 'Infrastructure Lead', 'offline', null);
  const bsmith = await insertUser.run('bsmith', mkHash('member123'), 'Bob Smith', 'bob.smith@corp.local', 'member', 'Network Engineer', 'offline', null);
  const mchen = await insertUser.run('mchen', mkHash('member123'), 'Maria Chen', 'maria.chen@corp.local', 'member', 'Finance Analyst', 'offline', null);
  const rpatel = await insertUser.run('rpatel', mkHash('member123'), 'Raj Patel', 'raj.patel@corp.local', 'member', 'Sales Executive', 'offline', 'On the road, back at 3pm');

  const ids = {
    admin: admin.lastInsertRowid, jdoe: jdoe.lastInsertRowid, bsmith: bsmith.lastInsertRowid,
    mchen: mchen.lastInsertRowid, rpatel: rpatel.lastInsertRowid
  };

  const insertTeam = db.prepare(`
    INSERT INTO teams (name, description, icon, created_by) VALUES (?, ?, ?, ?) RETURNING id
  `);
  const insertTeamMember = db.prepare(`
    INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)
  `);
  const insertChannel = db.prepare(`
    INSERT INTO channels (team_id, name, description, is_private, created_by) VALUES (?, ?, ?, ?, ?) RETURNING id
  `);
  const insertMessage = db.prepare(`
    INSERT INTO messages (channel_id, user_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id
  `);

  const it = await insertTeam.run('IT Operations', 'Everything infrastructure, support, and on-call.', 'bi-hdd-network-fill', ids.admin);
  const itId = it.lastInsertRowid;
  for (const [u, role] of [[ids.admin, 'owner'], [ids.jdoe, 'member'], [ids.bsmith, 'member']]) {
    await insertTeamMember.run(itId, u, role);
  }
  const itGeneral = (await insertChannel.run(itId, 'general', 'Team-wide announcements and chat', 0, ids.admin)).lastInsertRowid;
  const itIncidents = (await insertChannel.run(itId, 'incidents', 'Live incident coordination', 0, ids.admin)).lastInsertRowid;
  await insertMessage.run(itGeneral, ids.admin, 'Welcome to IT Operations! 👋 Post here for anything team-wide.', offsetStr(-1, -2), offsetStr(-1, -2));
  await insertMessage.run(itGeneral, ids.jdoe, 'Reminder: patch window for PRD-WEB cluster is Thursday 10pm.', offsetStr(-1, -1), offsetStr(-1, -1));
  await insertMessage.run(itIncidents, ids.bsmith, 'Core switch showing intermittent packet loss, investigating now.', offsetStr(0, -3), offsetStr(0, -3));
  await insertMessage.run(itIncidents, ids.jdoe, 'Seeing the same on my end, pulling logs.', offsetStr(0, -2, -50), offsetStr(0, -2, -50));

  const sales = await insertTeam.run('Sales & Marketing', 'Pipeline, campaigns, and customer wins.', 'bi-graph-up-arrow', ids.mchen);
  const salesId = sales.lastInsertRowid;
  for (const [u, role] of [[ids.mchen, 'owner'], [ids.rpatel, 'member'], [ids.admin, 'member']]) {
    await insertTeamMember.run(salesId, u, role);
  }
  const salesGeneral = (await insertChannel.run(salesId, 'general', 'General team chat', 0, ids.mchen)).lastInsertRowid;
  await insertMessage.run(salesGeneral, ids.rpatel, 'Closed the Meridian account today 🎉', offsetStr(0, -5), offsetStr(0, -5));
  await insertMessage.run(salesGeneral, ids.mchen, 'Amazing work Raj! Drinks on me Friday.', offsetStr(0, -4, -40), offsetStr(0, -4, -40));

  const insertEvent = db.prepare(`
    INSERT INTO calendar_events (team_id, title, description, location, start_at, end_at, all_day, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  await insertEvent.run(itId, 'PRD-WEB patch window', 'Rolling restart across the web cluster.', 'Remote', offsetStr(2, 22), offsetStr(2, 23), 0, ids.jdoe);
  await insertEvent.run(itId, 'On-call handoff', null, null, offsetStr(5, 9), offsetStr(5, 9, 30), 0, ids.admin);
  await insertEvent.run(itId, 'Quarterly DR drill', 'Full disaster-recovery failover test.', 'DC1 War Room', offsetStr(9), offsetStr(9), 1, ids.admin);
  await insertEvent.run(salesId, 'Meridian renewal call', null, 'Zoom', offsetStr(1, 14), offsetStr(1, 15), 0, ids.rpatel);
  await insertEvent.run(salesId, 'Q3 pipeline review', 'Bring updated forecast numbers.', 'HQ 2F Conf Room', offsetStr(4, 10), offsetStr(4, 11, 30), 0, ids.mchen);

  const insertConvo = db.prepare(`INSERT INTO dm_conversations (is_group, created_by) VALUES (?, ?) RETURNING id`);
  const insertParticipant = db.prepare(`INSERT INTO dm_participants (conversation_id, user_id) VALUES (?, ?)`);
  const insertDmMessage = db.prepare(`
    INSERT INTO messages (conversation_id, user_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
  `);
  const dm = await insertConvo.run(0, ids.admin);
  const dmId = dm.lastInsertRowid;
  await insertParticipant.run(dmId, ids.admin);
  await insertParticipant.run(dmId, ids.jdoe);
  await insertDmMessage.run(dmId, ids.admin, "Hey Jane — can you review the on-call rotation doc when you get a sec?", offsetStr(0, -6), offsetStr(0, -6));
}

// Idempotent — runs on every boot (unlike seedIfEmpty, which only fires on a brand-new
// database), so the decommission-workflow's bot user and its trigger channel exist
// regardless of whether this is a fresh install or an existing production database.
async function ensureDecomWorkflowSetup() {
  const bot = await db.prepare('SELECT id FROM users WHERE username = ?').get('novadesk-bot');
  if (!bot) {
    await db.prepare(`
      INSERT INTO users (username, password_hash, full_name, email, role, title, status, active)
      VALUES ('novadesk-bot', ?, 'NovaDesk', NULL, 'member', 'Automated notifications from NovaDesk ITSM', 'online', 1)
    `).run(bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10));
  }

  let team = await db.prepare("SELECT id FROM teams WHERE name = 'IT Operations'").get();
  if (!team) {
    const admin = await db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    team = await db.prepare(`
      INSERT INTO teams (name, description, icon, created_by) VALUES ('IT Operations', 'Everything infrastructure, support, and on-call.', 'bi-hdd-network-fill', ?) RETURNING id
    `).get(admin ? admin.id : null);
  }
  const channel = await db.prepare('SELECT id FROM channels WHERE team_id = ? AND name = ?').get(team.id, 'server-decom');
  if (!channel) {
    const admin = await db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    await db.prepare(`
      INSERT INTO channels (team_id, name, description, is_private, created_by) VALUES (?, 'server-decom', 'Say "decommission <hostname>" to start an automated server decommission.', 0, ?)
    `).run(team.id, admin ? admin.id : null);
  }
}

async function initDb() {
  await seedIfEmpty();
  await ensureDecomWorkflowSetup();
  const { ensureIndex, reindexAll } = require('./search');
  await ensureIndex().catch(e => console.error('Search index init failed:', e.message));
  reindexAll().then(() => console.log('Search reindex complete')).catch(e => console.error('Search reindex failed:', e.message));
}

module.exports = { db, initDb, nowStr, offsetStr };
