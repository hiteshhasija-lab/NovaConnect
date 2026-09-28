const router=require('../asyncRouter')();
const {randomBytes}=require('node:crypto');
const {db}=require('../db');
const {requireAuth}=require('../middleware/auth');
const path=require('path');
const {getPublicUrl,STORAGE_DRIVER,LOCAL_UPLOAD_ROOT}=require('../storage');
router.use(requireAuth);
router.get('/api/meet/links',async(req,res)=>res.json(await db.prepare('SELECT code,title,created_at FROM meet_links WHERE created_by=? AND active=1 ORDER BY created_at DESC LIMIT 100').all(req.session.user.id)));
router.post('/api/meet/links',async(req,res)=>{
 const title=String(req.body.title||'New meeting').trim().slice(0,200)||'New meeting';
 const count=await db.prepare('SELECT COUNT(*) AS n FROM meet_links WHERE created_by=? AND active=1').get(req.session.user.id);
 if(Number(count.n)>=250)return res.status(400).json({error:'You have reached the limit of 250 meeting links.'});
 const code=randomBytes(12).toString('hex');
 const row=await db.prepare('INSERT INTO meet_links(code,title,created_by) VALUES(?,?,?) RETURNING code,title,created_at').get(code,title,req.session.user.id);res.status(201).json(row);
});
router.get('/api/meet/links/:code',async(req,res)=>{
 const row=await db.prepare('SELECT code,title FROM meet_links WHERE code=? AND active=1').get(req.params.code);
 if(!row)return res.status(404).json({error:'Meeting not found or no longer available.'});res.json(row);
});
// Meeting chats kept after the meeting: those of meetings you own or were let into.
router.get('/api/meet/chats',async(req,res)=>res.json(await db.prepare(`SELECT l.code,l.title,l.active,COUNT(c.id) AS messages,MAX(c.created_at) AS last_at FROM meet_links l
 JOIN meet_chat_messages c ON c.meet_link_code=l.code
 WHERE l.created_by=? OR EXISTS(SELECT 1 FROM meet_attendees a WHERE a.meet_link_code=l.code AND a.user_id=?)
 GROUP BY l.code,l.title,l.active ORDER BY MAX(c.id) DESC LIMIT 50`).all(req.session.user.id,req.session.user.id)));
router.get('/api/meet/links/:code/chat',async(req,res)=>{
 const link=await db.prepare('SELECT code,title,active,created_by FROM meet_links WHERE code=?').get(req.params.code);
 const attended=link&&(link.created_by===req.session.user.id||await db.prepare('SELECT 1 FROM meet_attendees WHERE meet_link_code=? AND user_id=?').get(link.code,req.session.user.id));
 if(!attended)return res.status(404).json({error:'Meeting chat not found.'});
 const rows=await db.prepare('SELECT c.id,c.user_id,c.body,c.created_at,u.full_name FROM meet_chat_messages c LEFT JOIN users u ON u.id=c.user_id WHERE c.meet_link_code=? ORDER BY c.id DESC LIMIT 500').all(link.code);
 res.json({code:link.code,title:link.title,active:!!link.active,messages:rows.reverse().map(r=>({id:r.id,userId:r.user_id,fullName:r.full_name||'Former user',text:r.body,at:r.created_at.replace(' ','T')+'Z'}))});
});
// Recordings are served through here, like chat attachments — nothing serves the local upload
// folder directly. Only the meeting's owner (creator of the meeting link) may download them.
router.get('/api/recordings/:id/download',async(req,res)=>{
 const rec=await db.prepare("SELECT r.storage_key,r.storage_driver,r.created_at,m.created_by FROM recordings r JOIN meet_links m ON m.code=r.meeting_link_code WHERE r.id=? AND r.status='completed'").get(req.params.id);
 if(!rec||!rec.storage_key)return res.status(404).render('error',{title:'Not Found',message:'Recording not found.'});
 if(rec.created_by!==req.session.user.id)return res.status(403).render('error',{title:'Access Denied',message:'Only the meeting owner can download this recording.'});
 if(rec.storage_driver==='s3'||STORAGE_DRIVER==='s3')return res.redirect(await getPublicUrl(rec.storage_key,rec.storage_driver));
 res.download(path.join(LOCAL_UPLOAD_ROOT,rec.storage_key),`NovaConnect recording ${String(rec.created_at).replace(/:/g,'-')}${path.extname(rec.storage_key)}`);
});
router.get('/api/meet/scheduled',async(req,res)=>res.json(await db.prepare(`SELECT m.id,m.title,m.start_at,m.end_at,m.timezone,m.meet_code FROM meetings m JOIN meeting_attendees a ON a.meeting_id=m.id WHERE a.user_id=? AND m.end_at >= to_char(NOW() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS') ORDER BY m.start_at LIMIT 100`).all(req.session.user.id)));
module.exports=router;
