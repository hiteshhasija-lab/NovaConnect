// Calendar delegates (Calendar): someone you choose can see your meetings, send meetings as you,
// answer your invitations and cancel meetings you organize, like a delegate in Outlook. You manage
// them from the avatar menu ("Calendar delegates"); they are told when you add them, and you are
// told when they answer an invitation for you. Up to 10.
//
// Every meeting route takes an optional on_behalf_of (body) or for (query): the person acted for.
// actingFor() says whose calendar a request is about: yourself, or someone who made you a delegate.
const { db } = require('./db');

const MAX_DELEGATES = 10;

// The user id a request acts as: { id } or { status, error }.
async function actingFor(req, raw) {
  const me = req.session.user.id;
  if (raw === undefined || raw === null || raw === '' || Number(raw) === me) return { id: me, self: true };
  const owner = Number(raw);
  if (!Number.isSafeInteger(owner) || owner < 1) return { status: 400, error: 'Invalid calendar.' };
  const ok = await db.prepare('SELECT 1 FROM calendar_delegates WHERE owner_id = ? AND delegate_id = ?').get(owner, me);
  if (!ok) return { status: 403, error: "You aren't a delegate for that calendar." };
  return { id: owner, self: false };
}

const list = (where, id) => db.prepare(`
  SELECT u.id, u.full_name, u.username, u.title FROM calendar_delegates d JOIN users u ON u.id = d.${where === 'owner' ? 'delegate_id' : 'owner_id'}
  WHERE d.${where === 'owner' ? 'owner_id' : 'delegate_id'} = ? AND u.active = 1 ORDER BY u.full_name
`).all(id);
// { delegates: people who manage my calendar, owners: people whose calendars I manage }
async function delegationOf(userId) {
  return { delegates: await list('owner', userId), owners: await list('delegate', userId) };
}

module.exports = { actingFor, delegationOf, MAX_DELEGATES };
