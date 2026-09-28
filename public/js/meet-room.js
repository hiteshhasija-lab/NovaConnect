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
const screens=new Map();       // peerId -> { name, stream } for screens others share
const waitingPeople=new Map(); // owner only: peerId -> fullName

function request(event,data){return new Promise((resolve,reject)=>socket.timeout(15000).emit(event,data,(err,r)=>err?reject(Error('Connection timed out.')):r?.ok?resolve(r):reject(Error(r?.error||'Unable to connect.'))))}

function tile(id,name,media,muted=false){
  let item=document.getElementById('peer-'+id);
  if(!item){item=document.createElement('section');item.className='meet-video';item.id='peer-'+id;const v=document.createElement('video');v.autoplay=true;v.playsInline=true;v.muted=muted;item.append(v);const p=document.createElement('p');p.textContent=name;item.append(p);videos.append(item)}
  const v=item.querySelector('video');v.srcObject=media;
  v.play().catch(()=>{status.textContent='Click the participant video to play their audio.';item.onclick=()=>v.play()});
  updateSelfView();
}
// Teams-style: once anyone else is here, your own tile floats small in the corner (meet.css).
function updateSelfView(){videos.classList.toggle('has-remote',[...videos.children].some(el=>el.id!=='peer-local'))}

function removePeer(peerId){
  session?.removePeer(peerId);
  document.getElementById('peer-'+peerId)?.remove();
  updateSelfView();
}

// Teams-style presentation: the latest screen someone else shares fills the stage and the
// participant tiles shrink to a strip (meet.css .presenting). Your own share isn't shown back to you.
function renderShare(){
  const latest=[...screens.values()].pop();
  shareStage.hidden=!latest;
  document.querySelector('.meet-room').classList.toggle('presenting',!!latest);
  if(shareVideo.srcObject!==(latest?.stream||null)){shareVideo.srcObject=latest?.stream||null;if(latest)shareVideo.play().catch(()=>{})}
  shareLabel.textContent=latest?latest.name+' is sharing their screen':'';
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
    d=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});
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

function cleanup(){
  joined=false;joining=false;waiting=false;isOwner=false;roomId=null;routerRtpCapabilities=null;
  display?.getTracks().forEach(t=>{t.onended=null;t.stop()});display=null;
  screens.clear();renderShare();
  session?.close();session=null;
  waitingPeople.clear();renderLobbyQueue();
  stream?.getTracks().forEach(t=>t.stop());stream=null;
  videos.replaceChildren();updateSelfView();lobby.hidden=true;
  if(recordingControls)recordingControls.hidden=true;
  enter.hidden=false;enter.disabled=false;exit.hidden=true;mic.disabled=false;camera.disabled=false;
  setShareButton();
}

// Called once we are actually in the meeting — straight away for the owner, on admission for others.
async function enterMeeting(){
  if(joined||!roomId)return;
  joined=true;joining=false;waiting=false;
  lobby.hidden=true;enter.hidden=true;exit.hidden=false;
  mic.disabled=!stream?.getAudioTracks().length;camera.disabled=!stream?.getVideoTracks().length;
  if(recordingControls)recordingControls.hidden=!isOwner;
  if(stream)tile('local','You',stream,true);
  status.textContent='Connected.';
  try{
    if(isOwner){
      const l=await request('meet:lobby-list',{roomId});
      for(const w of l.waiting)waitingPeople.set(w.peerId,w.fullName);
      renderLobbyQueue();
    }
    session=window.createSfuSession({request,roomId,routerRtpCapabilities,
      onPeerStream:(peerId,name,media)=>tile(peerId,name,media),
      onPeerScreen:(peerId,name,media)=>{screens.delete(peerId);if(media)screens.set(peerId,{name,stream:media});renderShare()},
      onError:e=>{if(joined)status.textContent='Could not receive a participant\'s media: '+e.message}});
    const existing=await session.start();
    if(!existing&&!session.peerCount)status.textContent='You are the first participant. Share the meeting link to invite others.';
    try{await session.publish(stream)}catch(e){status.textContent='Your camera/microphone could not be published: '+e.message}
    setShareButton();
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
socket.on('sfu:peer-joined',({fullName})=>{if(joined)status.textContent=`${fullName} joined.`});
socket.on('sfu:peer-left',({peerId,fullName})=>{if(!session?.hasPeer(peerId)&&!document.getElementById('peer-'+peerId))return;removePeer(peerId);if(joined)status.textContent=`${fullName||'A participant'} left.`});
socket.on('disconnect',()=>{if(joined||waiting||joining){cleanup();status.textContent='Disconnected. Join again when your connection returns.'}});

// Lobby events
socket.on('meet:admitted',()=>{if(waiting||joining)enterMeeting()});
socket.on('meet:denied',()=>{cleanup();status.textContent='The meeting owner declined your request to join.'});
socket.on('meet:lobby-waiting',({peerId,fullName})=>{if(!joined||!isOwner)return;waitingPeople.set(peerId,fullName);renderLobbyQueue();status.textContent=`${fullName} is waiting to join.`});
socket.on('meet:lobby-left',({peerId})=>{if(waitingPeople.delete(peerId))renderLobbyQueue()});

enter.onclick=async()=>{
  if(joining||joined||waiting)return;
  joining=true;enter.disabled=true;status.textContent='Connecting…';
  try{
    // Browsers only offer camera/microphone on https (or localhost); on plain http, join to watch and listen.
    const noDevices=(mic.checked||camera.checked)&&!navigator.mediaDevices?.getUserMedia;
    if(noDevices){mic.checked=false;camera.checked=false}
    if(mic.checked||camera.checked)stream=await navigator.mediaDevices.getUserMedia({audio:mic.checked,video:camera.checked});
    if(!joining){stream?.getTracks().forEach(t=>t.stop());stream=null;return}
    const r=await request('meet:join',{code});
    roomId=r.roomId;isOwner=r.isOwner;routerRtpCapabilities=r.routerRtpCapabilities;
    const a=await request('meet:request-join',{roomId});
    if(a.admitted){await enterMeeting();if(noDevices&&joined)status.textContent='Joined without camera and microphone: your browser only allows them on a secure (https) connection.';return}
    joining=false;waiting=true;
    lobby.hidden=false;enter.hidden=true;exit.hidden=false;
    status.textContent='Waiting for the meeting owner to let you in…';
  }catch(e){leaveMeeting();status.textContent=e.message}
};

mic.onchange=()=>stream?.getAudioTracks().forEach(t=>t.enabled=mic.checked);
camera.onchange=()=>stream?.getVideoTracks().forEach(t=>t.enabled=camera.checked);
exit.onclick=()=>{const wasWaiting=waiting;leaveMeeting();status.textContent=wasWaiting?'You left the lobby.':'You left the meeting.'};
window.addEventListener('pagehide',leaveMeeting);

// Recording events (recording controls are shown to the meeting owner only)
socket.on('meet:recording-started',({startedBy})=>{
  status.textContent=`Recording started by ${startedBy}`;
  showRecordingIndicator();
});

socket.on('meet:recording-stopped',({recordingId,stoppedBy,duration,downloadUrl,failed})=>{
  status.textContent=failed
    ? `Recording stopped by ${stoppedBy}, but it failed: no video or audio was captured.`
    : `Recording stopped by ${stoppedBy} (${formatDuration(duration)})`;
  hideRecordingIndicator();
  currentRecordingId=null;
  if(recordBtn){recordBtn.classList.remove('d-none');recordBtn.disabled=false;}
  if(stopRecordBtn){stopRecordBtn.classList.add('d-none');stopRecordBtn.disabled=false;}
  if(downloadUrl)showDownloadLink(downloadUrl,recordingId);
});

function showRecordingIndicator(){
  hideRecordingIndicator();
  const indicator=document.createElement('div');
  indicator.id='recordingIndicator';
  indicator.className='meet-recording-indicator';
  indicator.innerHTML='<span class="recording-dot"></span><span>REC</span><span id="recordingTimer">00:00</span>';
  document.body.appendChild(indicator);
  let seconds=0;
  const timerEl=document.getElementById('recordingTimer');
  window.recordingTimerInterval=setInterval(()=>{
    seconds++;
    timerEl.textContent=`${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`;
  },1000);
}

function hideRecordingIndicator(){
  document.getElementById('recordingIndicator')?.remove();
  if(window.recordingTimerInterval){clearInterval(window.recordingTimerInterval);window.recordingTimerInterval=null}
}

function showDownloadLink(downloadUrl,recordingId){
  const link=document.createElement('a');
  link.href=downloadUrl;
  link.className='meet-download-link btn btn-success mt-2';
  link.target='_blank';
  link.textContent=`Download recording (${recordingId})`;
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
    currentRecordingId=result.recordingId;
    recordBtn.classList.add('d-none');
    stopRecordBtn.classList.remove('d-none');
    stopRecordBtn.disabled=false;
    status.textContent='Recording started';
  }catch(e){status.textContent=e.message;recordBtn.disabled=false}
}

async function stopRecording(){
  if(!currentRecordingId)return;
  try{
    stopRecordBtn.disabled=true;
    // Button/indicator state resets on the meet:recording-stopped event.
    await request('meet:stop-recording',{roomId,recordingId:currentRecordingId});
  }catch(e){status.textContent=e.message;stopRecordBtn.disabled=false}
}

if(recordBtn)recordBtn.onclick=startRecording;
if(stopRecordBtn)stopRecordBtn.onclick=stopRecording;
})();
