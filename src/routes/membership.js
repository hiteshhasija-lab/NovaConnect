const router = require('../asyncRouter')();
const { db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { resyncUserRooms, emitToUser } = require('../realtime');
router.use(requireAuth);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
async function context(trx, kind, id, userId, lock = false) {
  let channel = kind === 'channels' ? await trx('channels').where({ id }).first() : null;
  if (kind === 'channels' && !channel) fail(404, 'Channel not found.');
  const teamId = channel ? channel.team_id : id;
  let query = trx('teams').where({ id: teamId });
  if (lock) query = query.forUpdate();
  const team = await query.first();
  if (!team) fail(404, 'Team not found.');
  const member = await trx('team_members').where({ team_id: teamId, user_id: userId }).first();
  if (!member) fail(403, 'You are not a member of this team.');
  const cm = channel && await trx('channel_members').where({ channel_id: id, user_id: userId }).first();
  const teamManager = ['owner','admin'].includes(member.role);
  if (channel?.is_private && !cm && !teamManager) fail(403, 'This channel is private.');
  return { team, channel, teamId, teamManager, canManage: teamManager || cm?.role === 'owner' };
}
function endpoint(fn) { return async(req,res) => { try { await fn(req,res); } catch(e) { if(e.status) res.status(e.status).json({error:e.message}); else throw e; } }; }
for(const kind of ['teams','channels']) {
  router.get(`/api/${kind}/:id/membership`, endpoint(async(req,res)=>{
    const result = await db.transaction(async trx=>{
      const c = await context(trx,kind,Number(req.params.id),req.session.user.id);
      let members;
      if(c.channel?.is_private) members = await trx('channel_members as m').join('users as u','u.id','m.user_id').where('m.channel_id',c.channel.id).select('u.id','u.full_name','u.username','m.role');
      else {
        members = await trx('team_members as m').join('users as u','u.id','m.user_id').where('m.team_id',c.teamId).select('u.id','u.full_name','u.username','m.role');
        if(c.channel) {
          const owners = await trx('channel_members').where({channel_id:c.channel.id,role:'owner'});
          members = members.map(m=>({...m,role:owners.some(o=>o.user_id===m.id)?'owner':'member'}));
        }
      }
      return {members,canManage:c.canManage,name:c.channel?.name||c.team.name,inherited:!!c.channel&&!c.channel.is_private};
    }); res.json(result);
  }));
  router.post(`/api/${kind}/:id/membership`, endpoint(async(req,res)=>{
    const id=Number(req.params.id), userId=Number(req.body.user_id), role=req.body.role;
    if(!Number.isSafeInteger(id)||!Number.isSafeInteger(userId)||!['member','owner'].includes(role)) fail(400,'Choose a user and a valid role.');
    let teamId;
    await db.transaction(async trx=>{
      const c=await context(trx,kind,id,req.session.user.id,true); teamId=c.teamId;
      if(!c.canManage) fail(403,'Only owners or team admins can manage membership.');
      if(!await trx('users').where({id:userId,active:1}).first()) fail(404,'Active user not found.');
      const existing=await trx('team_members').where({team_id:teamId,user_id:userId}).first();
      if(kind==='teams') {
        if(existing?.role==='owner'&&role!=='owner') {
          const owners=await trx('team_members').where({team_id:teamId,role:'owner'});
          if(owners.length<=1) fail(400,'Keep at least one team owner.');
        }
        await trx('team_members').insert({team_id:teamId,user_id:userId,role}).onConflict(['team_id','user_id']).merge({role});
      } else {
        if(!existing&&!c.teamManager) fail(403,'A team owner must add this person to the team first.');
        if(!existing) await trx('team_members').insert({team_id:teamId,user_id:userId,role:'member'});
        await trx('channel_members').insert({channel_id:id,user_id:userId,role}).onConflict(['channel_id','user_id']).merge({role});
      }
    });
    await resyncUserRooms(userId); emitToUser(userId,'membership:changed',{teamId}); res.json({ok:true});
  }));
}
router.get('/api/channels/:id/assets', endpoint(async(req,res)=>{
  const result=await db.transaction(async trx=>{
    const c=await context(trx,'channels',Number(req.params.id),req.session.user.id);
    // A private channel's contents require explicit membership, even for team managers.
    if(c.channel.is_private&&!await trx('channel_members').where({channel_id:c.channel.id,user_id:req.session.user.id}).first()) fail(403,'Join this private channel to view its files.');
    const before=Number(req.query.before)||2147483647;
    return trx('attachments as a').join('messages as m','m.id','a.message_id').where('m.channel_id',c.channel.id).where('m.deleted',0).where('a.id','<',before).orderBy('a.id','desc').limit(100).select('a.*');
  });res.json(result);
}));
router.patch('/api/channels/:id/settings',endpoint(async(req,res)=>{
  const name=String(req.body.name||'').trim().toLowerCase().replace(/\s+/g,'-');
  const description=String(req.body.description||'').trim();
  if(!/^[a-z0-9-]{1,80}$/.test(name)||description.length>1000) fail(400,'Use a channel name of 1–80 letters, numbers or hyphens, and a description up to 1000 characters.');
  try { await db.transaction(async trx=>{const c=await context(trx,'channels',Number(req.params.id),req.session.user.id,true);if(!c.canManage) fail(403,'Only owners or team admins can change settings.');await trx('channels').where({id:c.channel.id}).update({name,description});}); }
  catch(e){if(e.code==='23505')fail(400,'A channel with this name already exists.');throw e;}
  res.json({ok:true});
}));
module.exports=router;
