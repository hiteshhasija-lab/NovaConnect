const { db } = require('./db');

// Who may act on a decommission (approve, reject, pre-checks, Confirm Destroy, Cancel) from the
// chat: an owner or admin of the team that owns #server-decom, or of the channel itself. NovaDesk
// used to look the person up in its own user list and answer "Only a NovaDesk admin can ...", which
// refused a team admin who simply has no NovaDesk account of the same name. NovaConnect knows its
// own teams, so it vouches (acting_user.novaconnect_admin) and NovaDesk accepts the voucher on the
// shared-secret channel. A NovaConnect-wide admin who is not an owner or admin of that team or
// channel is not included: the rule is "admin of the server-decom team", as asked.
const ADMIN_ROLES = ['owner', 'admin'];

async function isServerDecomAdmin(userId) {
  if (!userId) return false;
  const row = await db.prepare(`
    SELECT 1 AS ok FROM channels c
    WHERE c.name = 'server-decom' AND (
      EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = c.team_id AND tm.user_id = ? AND tm.role IN (?, ?))
      OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ? AND cm.role IN (?, ?))
    )
    LIMIT 1
  `).get(userId, ADMIN_ROLES[0], ADMIN_ROLES[1], userId, ADMIN_ROLES[0], ADMIN_ROLES[1]);
  return !!row;
}

// The acting user as sent to NovaDesk with every decommission action.
async function actingUser(userId) {
  const u = await db.prepare('SELECT username, full_name FROM users WHERE id = ?').get(userId);
  if (!u) return null;
  return { username: u.username, full_name: u.full_name, novaconnect_admin: await isServerDecomAdmin(userId) };
}

module.exports = { isServerDecomAdmin, actingUser };
