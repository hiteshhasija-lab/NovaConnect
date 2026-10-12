const { db } = require('./db');

// Who may act on a decommission (approve, reject, pre-checks, Confirm Destroy, Cancel) from the
// chat: the person who requested THIS decommission, or an owner or admin of the team that owns
// #server-decom or of the channel itself. A NovaConnect-wide admin who is neither is not included,
// and neither is anyone else. NovaDesk used to look the person up in its own user list and answer
// "Only a NovaDesk admin can ...", which refused a team admin who simply has no NovaDesk account of
// the same name. NovaConnect knows its own teams and who asked, so it decides and sends the answer
// with each action (acting_user.authorized); NovaDesk follows it on the shared-secret channel.
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

// Did this user ask for decommission <changeId>? The approval card carries who asked: the user id
// for requests made since 1.0.186, the full name for older ones.
async function isRequester(userId, changeId) {
  if (!userId || !changeId) return false;
  const user = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(userId);
  if (!user) return false;
  const card = await db.prepare(`
    SELECT metadata FROM messages
    WHERE metadata LIKE '%decom_approval%' AND (metadata::json->>'cardType') = 'decom_approval' AND (metadata::json->>'changeId') = ?
    ORDER BY id LIMIT 1
  `).get(String(changeId));
  if (!card || !card.metadata) return false;
  let meta;
  try { meta = JSON.parse(card.metadata); } catch (e) { return false; }
  if (meta.requestedByUserId != null) return Number(meta.requestedByUserId) === Number(userId);
  return !!meta.requestedBy && meta.requestedBy === user.full_name;
}

// The acting user as sent to NovaDesk with every decommission action.
async function actingUser(userId, changeId) {
  const u = await db.prepare('SELECT username, full_name FROM users WHERE id = ?').get(userId);
  if (!u) return null;
  const requester = await isRequester(userId, changeId);
  const admin = requester ? false : await isServerDecomAdmin(userId);
  return { username: u.username, full_name: u.full_name, authorized: requester || admin, basis: requester ? 'requester' : admin ? 'server-decom admin' : null };
}

module.exports = { isServerDecomAdmin, isRequester, actingUser };
