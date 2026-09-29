(()=>{'use strict';
// Meeting room: everyone sends and receives media through the mediasoup SFU on the server.
// Joining goes through a lobby — the meeting owner (creator of the link) enters straight away,
// everyone else waits until the owner admits them.
const socket=io(),code=document.querySelector('[data-code]').dataset.code,status=document.getElementById('meetStatus'),videos=document.getElementById('meetVideos'),mic=document.getElementById('meetMic'),camera=document.getElementById('meetCamera'),enter=document.getElementById('meetEnter'),exit=document.getElementById('meetLeave');
const lobby=document.getElementById('meetLobby'),lobbyQueue=document.getElementById('meetLobbyQueue'),lobbyList=document.getElementById('meetLobbyList');
const recordingControls=document.getElementById('recordingControls'),recordBtn=document.getElementById('recordBtn'),stopRecordBtn=document.getElementById('stopRecordBtn');
let stream=null,joined=false,joining=false,waiting=false,isOwner=false,roomId=null,routerRtpCapabilities=null,session=null,currentRecordingId=null;
const shareBtn=document.getElementById('meetShare'),shareStage=document.getElementById('meetShareStage'),shareVideo=document.getElementById('meetShareVideo'),shareLabel=document.getElementById('meetShareLabel');
let display=null;              // our own screen while we share
let ownPeerId=null,ownUserId=null; // our ids in the meeting room (to tell our own tile / messages apart)
const screens=new Map();       // peerId -> { name, stream } for screens others share
const focusStage=document.getElementById('meetFocusStage');
let focusPeer=null;            // pinned or spotlighted person (call-extras.js onFocus), shown large
const allTiles=()=>[...videos.children,...focusStage.children];
// Before joining (Teams-style): microphone and camera start as you left them last time — off the
// first time — and a live preview shows your camera while it's on. The preview's camera is the one
// you join with, so it doesn't restart.
const prejoin=document.getElementById('meetPrejoin'),previewVideo=document.getElementById('meetPreviewVideo');
const PREFS={mic:'nc.meet.mic',camera:'nc.meet.camera'};
const prefOn=k=>{try{return localStorage.getItem(PREFS[k])==='1'}catch{return false}};
const setPref=(k,on)=>{try{localStorage.setItem(PREFS[k],on?'1':'0')}catch{}};
let preview=null;              // camera stream shown before joining
mic.checked=prefOn('mic');camera.checked=prefOn('camera');
async function showPreview(){
  if(joined||joining||waiting)return;
  if(!camera.checked||!navigator.mediaDevices?.getUserMedia){stopPreview();return}
  if(preview?.getVideoTracks()[0]?.readyState==='live')return;
  try{
    const s=await navigator.mediaDevices.getUserMedia({video:NovaDevices.video()});
    if(!camera.checked||joined||joining||waiting){s.getTracks().forEach(t=>t.stop());return}
    stopPreview();preview=s;previewVideo.srcObject=s;prejoin.classList.add('on');devicePicker.refresh();
  }catch(e){camera.checked=false;setPref('camera',false);stopPreview();status.textContent='Your camera is not available: '+e.message}
}
function stopPreview(keepTrack=false){if(!keepTrack)preview?.getTracks().forEach(t=>t.stop());preview=null;previewVideo.srcObject=null;prejoin.classList.remove('on')}
const waitingPeople=new Map(); // owner only: peerId -> fullName

function request(event,data){return new Promise((resolve,reject)=>socket.timeout(15000).emit(event,data,(err,r)=>err?reject(Error('Connection timed out.')):r?.ok?resolve(r):reject(Error(r?.error||'Unable to connect.'))))}

function tile(id,name,media,muted=false){
  let item=document.getElementById('peer-'+id);
  if(!item){
    item=document.createElement('section');item.className='meet-video';item.id='peer-'+id;item.dataset.peerId=id;
    const v=document.createElement('video');v.autoplay=true;v.playsInline=true;v.muted=muted;
    // Initials until a picture arrives, and whenever their camera is off (meet.css).
    const av=document.createElement('div');av.className='meet-avatar';const ini=document.createElement('span');
    ini.textContent=name.split(/\s+/).filter(Boolean).slice(0,2).map(w=>w[0].toUpperCase()).join('')||'?';av.append(ini);
    v.addEventListener('resize',()=>item.classList.toggle('has-video',v.videoWidth>0));
    const p=document.createElement('p');const micIcon=document.createElement('i');micIcon.className='bi bi-mic-mute-fill meet-tile-mic';micIcon.setAttribute('role','img');micIcon.setAttribute('aria-label','Muted');
    p.append(micIcon,document.createTextNode(name));
    const hand=document.createElement('span');hand.className='nc-tile-hand';hand.setAttribute('role','img');hand.setAttribute('aria-label','Hand raised');hand.textContent='✋';
    item.append(v,av,hand,p);videos.append(item);
    extras.decorate(item,id);
    if(!muted)session?.watchSize(id,item); // simulcast: receive the size that fits
  }
  const v=item.querySelector('video');v.srcObject=media;
  if(!muted)NovaDevices.applySpeaker(v);
  v.play().catch(()=>{status.textContent='Click the participant video to play their audio.';item.onclick=()=>v.play()});
  arrangeFocus();
}
// Camera off → initials; microphone muted → muted icon (their stream is paused at the server).
function setTileState(id,kind,paused){document.getElementById('peer-'+id)?.classList.toggle(kind==='audio'?'mic-off':'camera-off',paused)}
// Teams-style: once anyone else is here, your own tile floats small in the corner (meet.css).
function updateSelfView(){videos.classList.toggle('has-remote',allTiles().some(el=>el.id!=='peer-local'))}
// Pin / spotlight: that person's tile moves to the stage above, the rest shrink to a strip
// (meet.css .focus), like a shared screen — which wins while there is one.
function arrangeFocus(){
  const id=focusPeer?(focusPeer===ownPeerId?'local':focusPeer):null;
  const focused=shareStage.hidden&&id?document.getElementById('peer-'+id):null;
  const move=(t,box)=>{if(t.parentNode===box)return;box.append(t);const v=t.querySelector('video');if(v?.paused)v.play().catch(()=>{})};
  [...focusStage.children].forEach(t=>{if(t!==focused)move(t,videos)});
  if(focused)move(focused,focusStage);
  focusStage.hidden=!focused;
  document.querySelector('.meet-room').classList.toggle('focus',!!focused);
  updateSelfView();
}

function removePeer(peerId){
  session?.removePeer(peerId);
  document.getElementById('peer-'+peerId)?.remove();
  arrangeFocus();
}

// Teams-style presentation: the latest screen someone else shares fills the stage and the
// participant tiles shrink to a strip (meet.css .presenting). Your own share isn't shown back to you.
function renderShare(){
  const latest=[...screens.values()].pop();
  shareStage.hidden=!latest;
  document.querySelector('.meet-room').classList.toggle('presenting',!!latest);
  if(shareVideo.srcObject!==(latest?.stream||null)){shareVideo.srcObject=latest?.stream||null;if(latest)shareVideo.play().catch(()=>{})}
  shareLabel.textContent=latest?latest.name+' is sharing their screen':'';
  arrangeFocus();
}
function setShareButton(){
  shareBtn.hidden=!joined||!navigator.mediaDevices?.getDisplayMedia;
  shareBtn.querySelector('span').textContent=display?'Stop sharing':'Share screen';
  shareBtn.classList.toggle('btn-warning',!!display);shareBtn.classList.toggle('btn-outline-secondary',!display);
}
async function startShare(){
  if(!joined||!session||display)return;
  let d;
  try{
    d=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:30,max:30}},audio:false});
    if(!joined||!session||display){d.getTracks().forEach(t=>t.stop());return}
    const track=d.getVideoTracks()[0];
    display=d;track.onended=stopShare; // the browser's own "Stop sharing" bar
    await session.shareScreen(track);
    status.textContent='You are sharing your screen.';
  }catch(e){d?.getTracks().forEach(t=>t.stop());if(display===d)display=null;if(e.name!=='NotAllowedError')status.textContent='Screen sharing failed: '+e.message}
  setShareButton();
}
async function stopShare(){
  const d=display;if(!d)return;display=null;
  d.getTracks().forEach(t=>{t.onended=null;t.stop()});
  await session?.stopScreen();
  if(joined)status.textContent='You stopped sharing.';
  setShareButton();
}
shareBtn.onclick=()=>display?stopShare():startShare();

// Devices (devices.js): choose before joining or during the meeting. Mid-meeting, switching the
// microphone/camera replaces the track being sent (no reconnect) and keeps muted/camera-off.
const devicePicker=NovaDevices.bind(
  {audioinput:document.getElementById('meetMicSelect'),videoinput:document.getElementById('meetCameraSelect'),audiooutput:document.getElementById('meetSpeakerSelect')},
  (kind,id)=>switchDevice(kind,id).catch(e=>{status.textContent='Could not switch device: '+e.message}));
async function switchDevice(kind,id){
  if(kind==='audiooutput'){allTiles().forEach(t=>{if(t.id!=='peer-local')NovaDevices.applySpeaker(t.querySelector('video'))});return}
  if(!joined){if(kind==='videoinput'&&preview){stopPreview();showPreview()}return} // otherwise used when you join
  if(!stream)return;
  const short=kind==='audioinput'?'audio':'video';
  const old=short==='audio'?stream.getAudioTracks()[0]:stream.getVideoTracks()[0];
  if(!old)return;
  const size=short==='video'?NovaDevices.video():{}; // keep 720p for simulcast (devices.js)
  const fresh=(await navigator.mediaDevices.getUserMedia({[short]:id?{...size,deviceId:{exact:id}}:(short==='video'?size:true)}))[short==='audio'?'getAudioTracks':'getVideoTracks']()[0];
  if(!joined){fresh.stop();return}
  fresh.enabled=old.enabled;
  await session?.replaceTrack(short,fresh);
  stream.removeTrack(old);old.stop();stream.addTrack(fresh);
  if(short==='audio')extras.micChanged(); // captions follow the new microphone
  const mine=document.querySelector('#peer-local video');if(mine)mine.srcObject=new MediaStream(stream.getTracks());
  status.textContent=(short==='audio'?'Microphone':'Camera')+' switched.';
}

// In-call extras (participants, raise hand, reactions, chat, active speaker): call-extras.js.
const $=id=>document.getElementById(id);
const extras=createCallExtras({
  socket,request,notify:e=>{status.textContent=e.message},
  tiles:allTiles,
  tileFor:peerId=>document.getElementById('peer-'+(peerId===ownPeerId?'local':peerId)),
  reactionHost:()=>shareStage.hidden?null:shareStage,
  fallbackHost:videos,
  onFocus:peerId=>{focusPeer=peerId;arrangeFocus()},
  els:{
    participantsBtn:$('meetParticipantsBtn'),participantsBadge:$('meetParticipantsBadge'),participantsPanel:$('meetParticipantsPanel'),
    participantCount:$('meetParticipantCount'),participantList:$('meetParticipantList'),handBtn:$('meetHandBtn'),
    reactionsBtn:$('meetReactionsBtn'),reactionsPanel:$('meetReactionsPanel'),reactionGrid:$('meetReactionGrid'),
    chatBtn:$('meetChatBtn'),chatBadge:$('meetChatBadge'),chatPanel:$('meetChatPanel'),chatMessages:$('meetChatMessages'),
    chatForm:$('meetChatForm'),chatInput:$('meetChatInput'),notices:$('meetNotices'),
    captionsBtn:$('meetCaptionsBtn'),captionsBox:$('meetCaptions'),
  },
  micTrack:()=>joined?stream?.getAudioTracks()[0]||null:null,
});

function cleanup(){
  joined=false;joining=false;waiting=false;isOwner=false;roomId=null;routerRtpCapabilities=null;
  display?.getTracks().forEach(t=>{t.onended=null;t.stop()});display=null;
  screens.clear();renderShare();extras.stop();ownPeerId=null;
  session?.close();session=null;
  waitingPeople.clear();renderLobbyQueue();
  stream?.getTracks().forEach(t=>t.stop());stream=null;
  videos.replaceChildren();focusStage.replaceChildren();focusStage.hidden=true;focusPeer=null;document.querySelector('.meet-room').classList.remove('focus');updateSelfView();lobby.hidden=true;
  if(recordingControls)recordingControls.hidden=true;
  hideRecordingIndicator();currentRecordingId=null;
  enter.hidden=false;enter.disabled=false;exit.hidden=true;mic.disabled=false;camera.disabled=false;prejoin.hidden=false;
  setShareButton();
}

// Called once we are actually in the meeting — straight away for the owner, on admission for others.
async function enterMeeting(){
  if(joined||!roomId)return;
  joined=true;joining=false;waiting=false;
  lobby.hidden=true;enter.hidden=true;exit.hidden=false;
  mic.disabled=!stream?.getAudioTracks().length;camera.disabled=!navigator.mediaDevices?.getUserMedia;prejoin.hidden=true;
  if(recordingControls)recordingControls.hidden=!isOwner;
  if(stream){tile('local','You',stream,true);setTileState('local','audio',!mic.checked)} // joined muted: show it
  status.textContent='Connected.';
  try{
    if(isOwner){
      const l=await request('meet:lobby-list',{roomId});
      for(const w of l.waiting)waitingPeople.set(w.peerId,w.fullName);
      renderLobbyQueue();
    }
    session=window.createSfuSession({request,roomId,routerRtpCapabilities,
      onPeerStream:(peerId,name,media)=>tile(peerId,name,media),
      onPeerState:(peerId,kind,paused)=>setTileState(peerId,kind,paused),
      onPeerScreen:(peerId,name,media)=>{screens.delete(peerId);if(media)screens.set(peerId,{name,stream:media});renderShare()},
      onError:e=>{if(joined)status.textContent='Could not receive a participant\'s media: '+e.message}});
    const existing=await session.start();
    if(!existing&&!session.peerCount)status.textContent='You are the first participant. Share the meeting link to invite others.';
    try{await session.publish(stream)}catch(e){status.textContent='Your camera/microphone could not be published: '+e.message}
    setShareButton();
    extras.start({roomId,peerId:ownPeerId,userId:ownUserId});
    syncRecording();
  }catch(e){leaveMeeting();status.textContent=e.message}
}

// meet:leave, not sfu:leave — the server's request handlers ignore events sent without an ack.
function leaveMeeting(){if(joined||waiting||joining)socket.emit('meet:leave');cleanup()}

// Owner's list of people waiting in the lobby, with Admit / Deny.
function renderLobbyQueue(){
  if(!lobbyQueue)return;
  lobbyList.replaceChildren();
  for(const [peerId,name] of waitingPeople){
    const li=document.createElement('li');
    const who=document.createElement('span');who.textContent=name;
    const admit=document.createElement('button');admit.type='button';admit.className='btn btn-primary btn-sm';admit.textContent='Admit';
    const deny=document.createElement('button');deny.type='button';deny.className='btn btn-outline-secondary btn-sm';deny.textContent='Deny';
    const decide=async(event,btns)=>{btns.forEach(b=>b.disabled=true);try{await request(event,{roomId,peerId});waitingPeople.delete(peerId);renderLobbyQueue()}catch(e){status.textContent=e.message;waitingPeople.delete(peerId);renderLobbyQueue()}};
    admit.onclick=()=>decide('meet:admit',[admit,deny]);
    deny.onclick=()=>decide('meet:deny',[admit,deny]);
    li.append(who,admit,deny);lobbyList.append(li);
  }
  lobbyQueue.hidden=!joined||!isOwner||waitingPeople.size===0;
}

socket.on('sfu:new-producer',p=>{if(joined)session?.newProducer(p)});
socket.on('sfu:producer-closed',p=>{if(joined)session?.producerClosed(p)});
socket.on('sfu:producer-paused',p=>{if(joined)session?.producerPaused(p)});
socket.on('sfu:peer-joined',({fullName})=>{if(joined)status.textContent=`${fullName} joined.`});
socket.on('sfu:peer-left',({peerId,fullName})=>{if(!session?.hasPeer(peerId)&&!document.getElementById('peer-'+peerId))return;removePeer(peerId);if(joined)status.textContent=`${fullName||'A participant'} left.`});
socket.on('disconnect',()=>{if(joined||waiting||joining){cleanup();status.textContent='Disconnected. Join again when your connection returns.'}});

// Lobby events
socket.on('meet:admitted',()=>{if(waiting||joining)enterMeeting()});
socket.on('meet:denied',()=>{cleanup();showPreview();status.textContent='The meeting owner declined your request to join.'});
socket.on('meet:lobby-waiting',({peerId,fullName})=>{if(!joined||!isOwner)return;waitingPeople.set(peerId,fullName);renderLobbyQueue();status.textContent=`${fullName} is waiting to join.`});
socket.on('meet:lobby-left',({peerId})=>{if(waitingPeople.delete(peerId))renderLobbyQueue()});

enter.onclick=async()=>{
  if(joining||joined||waiting)return;
  joining=true;enter.disabled=true;status.textContent='Connecting…';
  try{
    // Browsers only offer camera/microphone on https (or localhost); on plain http, join to watch and listen.
    const noDevices=(mic.checked||camera.checked)&&!navigator.mediaDevices?.getUserMedia;
    if(noDevices){mic.checked=false;camera.checked=false}
    if(navigator.mediaDevices?.getUserMedia){
      // The microphone is always opened — muted if it's off, so unmuting later just works. The
      // camera only while it's on: the preview's, else a fresh one (turning it on later adds it).
      let audio=null,video=camera.checked?preview?.getVideoTracks()[0]||null:null;
      stopPreview(!!video);
      try{audio=(await navigator.mediaDevices.getUserMedia({audio:NovaDevices.audio()})).getAudioTracks()[0]}catch{if(mic.checked)status.textContent='Your microphone is not available; joining without it.'}
      if(camera.checked&&!video)try{video=(await navigator.mediaDevices.getUserMedia({video:NovaDevices.video()})).getVideoTracks()[0]}catch{camera.checked=false}
      if(audio)audio.enabled=mic.checked;else mic.checked=false;
      const tracks=[audio,video].filter(Boolean);
      if(tracks.length)stream=new MediaStream(tracks);
      devicePicker.refresh(); // device names are only readable once access is granted
    }
    if(!joining){stream?.getTracks().forEach(t=>t.stop());stream=null;return}
    const r=await request('meet:join',{code});
    roomId=r.roomId;isOwner=r.isOwner;routerRtpCapabilities=r.routerRtpCapabilities;ownPeerId=r.peerId;ownUserId=r.userId;
    const a=await request('meet:request-join',{roomId});
    if(a.admitted){await enterMeeting();if(noDevices&&joined)status.textContent='Joined without camera and microphone: your browser only allows them on a secure (https) connection.';return}
    joining=false;waiting=true;
    lobby.hidden=false;enter.hidden=true;exit.hidden=false;
    status.textContent='Waiting for the meeting owner to let you in…';
  }catch(e){leaveMeeting();status.textContent=e.message}
};

// In the meeting these also pause the stream at the server, so everyone else is told.
// Your choice is remembered for next time. Before joining, the camera switch starts/stops the preview.
mic.onchange=()=>{setPref('mic',mic.checked);stream?.getAudioTracks().forEach(t=>t.enabled=mic.checked);if(joined){setTileState('local','audio',!mic.checked);session?.setPaused('audio',!mic.checked);extras.micChanged()}};
camera.onchange=()=>{
  setPref('camera',camera.checked);
  if(!joined){showPreview();return}
  if(camera.checked&&!stream?.getVideoTracks().length){addCamera();return}
  stream?.getVideoTracks().forEach(t=>t.enabled=camera.checked);setTileState('local','video',!camera.checked);session?.setPaused('video',!camera.checked);
};
// Joined with the camera off: turning it on opens it now and sends it as a new stream.
async function addCamera(){
  try{
    const track=(await navigator.mediaDevices.getUserMedia({video:NovaDevices.video()})).getVideoTracks()[0];
    if(!joined||!camera.checked){track.stop();return}
    if(!stream)stream=new MediaStream();
    stream.addTrack(track);
    const mine=document.querySelector('#peer-local video');
    if(mine)mine.srcObject=new MediaStream(stream.getTracks());else tile('local','You',stream,true);
    setTileState('local','video',false);
    await session?.publish(new MediaStream([track]));
  }catch(e){camera.checked=false;setPref('camera',false);status.textContent='Could not turn on your camera: '+e.message}
}
exit.onclick=()=>{const wasWaiting=waiting;leaveMeeting();showPreview();status.textContent=wasWaiting?'You left the lobby.':'You left the meeting.'};
window.addEventListener('pagehide',leaveMeeting);

// Recording (controls are shown to the meeting owner only; everyone sees the REC banner).
// Stopping returns at once; the video is composed on the server and announced with
// meet:recording-ready, which carries the download link for the owner.
function setRecording(recordingId,startTime){
  currentRecordingId=recordingId;
  if(recordingId)showRecordingIndicator(startTime);else hideRecordingIndicator();
  if(recordBtn){recordBtn.classList.toggle('d-none',!!recordingId);recordBtn.disabled=false}
  if(stopRecordBtn){stopRecordBtn.classList.toggle('d-none',!recordingId);stopRecordBtn.disabled=false}
}
socket.on('meet:recording-started',({roomId:r,recordingId,startedBy,startTime})=>{
  if(r&&r!==roomId)return;
  status.textContent=`Recording started by ${startedBy}. Everyone in the meeting can see this.`;
  setRecording(recordingId,startTime);
});
socket.on('meet:recording-stopped',({roomId:r,stoppedBy})=>{
  if(r&&r!==roomId)return;
  setRecording(null);
  status.textContent=`Recording stopped by ${stoppedBy}. Preparing the video…`;
});
socket.on('meet:recording-ready',({roomId:r,failed,duration,downloadUrl})=>{
  if(r&&r!==roomId)return;
  if(failed){status.textContent='The recording failed: no video or audio was captured.';return}
  status.textContent=`The recording is ready (${formatDuration(duration)}).`+(downloadUrl?'':' The meeting owner can download it.');
  if(downloadUrl)showDownloadLink(downloadUrl,duration);
});
// Joining while a recording is already running: show the banner (and, for the owner, Stop).
async function syncRecording(){
  try{const {recording}=await request('meet:recording-status',{roomId});if(recording)setRecording(recording.recordingId,recording.startTime)}catch{}
}

function showRecordingIndicator(startTime=Date.now()){
  hideRecordingIndicator();
  const indicator=document.createElement('div');
  indicator.id='recordingIndicator';
  indicator.className='meet-recording-indicator';
  indicator.setAttribute('role','status');
  indicator.innerHTML='<span class="recording-dot"></span><span>REC</span><span id="recordingTimer">00:00</span>';
  document.body.appendChild(indicator);
  const timerEl=document.getElementById('recordingTimer');
  const tick=()=>{timerEl.textContent=formatDuration(Math.max(0,Date.now()-startTime))};
  tick();window.recordingTimerInterval=setInterval(tick,1000);
}

function hideRecordingIndicator(){
  document.getElementById('recordingIndicator')?.remove();
  if(window.recordingTimerInterval){clearInterval(window.recordingTimerInterval);window.recordingTimerInterval=null}
}

function showDownloadLink(downloadUrl,duration){
  status.parentNode.querySelectorAll('.meet-download-link').forEach(l=>l.remove());
  const link=document.createElement('a');
  link.href=downloadUrl;
  link.className='meet-download-link btn btn-success mt-2';
  link.textContent=`Download recording (${formatDuration(duration)})`;
  status.parentNode.appendChild(link);
}

function formatDuration(ms){
  const seconds=Math.floor(ms/1000);
  return `${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`;
}

async function startRecording(){
  if(!joined||!isOwner)return;
  try{
    recordBtn.disabled=true;
    const result=await request('meet:start-recording',{roomId});
    setRecording(result.recordingId,Date.now());
  }catch(e){status.textContent=e.message;recordBtn.disabled=false}
}

async function stopRecording(){
  if(!currentRecordingId)return;
  try{
    stopRecordBtn.disabled=true;
    await request('meet:stop-recording',{roomId,recordingId:currentRecordingId});
  }catch(e){status.textContent=e.message;stopRecordBtn.disabled=false}
}

if(recordBtn)recordBtn.onclick=startRecording;
if(stopRecordBtn)stopRecordBtn.onclick=stopRecording;
showPreview();
})();
