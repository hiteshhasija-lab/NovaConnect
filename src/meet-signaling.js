// Small authenticated WebRTC rooms. Media stays peer-to-peer; limit mesh rooms to six.
function createMeetSignaling(io,db) {
 const rooms=new Map();
 function attach(socket){
  let roomCode=null;
  function leave(){if(!roomCode)return;const room=rooms.get(roomCode);room?.delete(socket.id);socket.to('meet:'+roomCode).emit('meet:left',{id:socket.id});socket.leave('meet:'+roomCode);if(room?.size===0)rooms.delete(roomCode);roomCode=null;}
  async function authorized(){
   await new Promise((resolve,reject)=>socket.request.session.reload(e=>e?reject(Error('Sign in again.')):resolve()));
   if(socket.request.session.user?.id!==socket.user.id)throw Error('Sign in again.');
   const u=await db.prepare('SELECT id,full_name,active FROM users WHERE id=?').get(socket.user.id);if(!u?.active)throw Error('Account unavailable.');return u;
  }
  function handle(name,fn){socket.on(name,async(data,ack)=>{if(typeof ack!=='function')return;try{const u=await authorized();if(!socket.connected)return;ack({ok:true,...await fn(data||{},u)});}catch(e){ack({ok:false,error:e.message});}})}
  handle('meet:join',async({code},u)=>{
   if(typeof code!=='string'||! /^[a-f0-9]{24}$/.test(code))throw Error('Enter a valid meeting ID.');
   const link=await db.prepare('SELECT title FROM meet_links WHERE code=? AND active=1').get(code);if(!link)throw Error('Meeting not found.');
   if(roomCode===code)throw Error('You have already joined this meeting.');
   const room=rooms.get(code)||new Map();if(room.size>=6)throw Error('This meeting is full (six participants).');
   leave();roomCode=code;const peers=[...room.values()];room.set(socket.id,{id:socket.id,name:u.full_name});rooms.set(code,room);socket.join('meet:'+code);
   let iceServers=[{urls:'stun:stun.l.google.com:19302'}];try{if(process.env.WEBRTC_ICE_SERVERS)iceServers=JSON.parse(process.env.WEBRTC_ICE_SERVERS);}catch{}
   return {peers,title:link.title,iceServers};
  });
  handle('meet:signal',async({to,description,candidate})=>{
   if(!roomCode||!rooms.get(roomCode)?.has(to)||to===socket.id)throw Error('Participant unavailable.');
   if(JSON.stringify({description,candidate}).length>70000)throw Error('Signal too large.');
   if(description&&!['offer','answer'].includes(description.type))throw Error('Invalid signal.');
   io.to(to).emit('meet:signal',{from:socket.id,name:socket.user.full_name,description,candidate});return {};
  });
  socket.on('meet:leave',leave);socket.on('disconnect',leave);
 }
 return {attach};
}
module.exports={createMeetSignaling};
