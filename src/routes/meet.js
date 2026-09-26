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
// Recordings are served through here (signed-in users only), like chat attachments —
// nothing serves the local upload folder directly.
router.get('/api/recordings/:id/download',async(req,res)=>{
 const rec=await db.prepare("SELECT storage_key,storage_driver,created_at FROM recordings WHERE id=? AND status='completed'").get(req.params.id);
 if(!rec||!rec.storage_key)return res.status(404).render('error',{title:'Not Found',message:'Recording not found.'});
 if(rec.storage_driver==='s3'||STORAGE_DRIVER==='s3')return res.redirect(await getPublicUrl(rec.storage_key,rec.storage_driver));
 res.download(path.join(LOCAL_UPLOAD_ROOT,rec.storage_key),`NovaConnect recording ${String(rec.created_at).replace(/:/g,'-')}${path.extname(rec.storage_key)}`);
});
router.get('/api/meet/scheduled',async(req,res)=>res.json(await db.prepare(`SELECT m.id,m.title,m.start_at,m.end_at,m.timezone,m.meet_code FROM meetings m JOIN meeting_attendees a ON a.meeting_id=m.id WHERE a.user_id=? AND m.end_at >= to_char(NOW() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS') ORDER BY m.start_at LIMIT 100`).all(req.session.user.id)));
module.exports=router;
