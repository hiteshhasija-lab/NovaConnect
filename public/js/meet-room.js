(()=>{'use strict';
const socket=io(),code=document.querySelector('[data-code]').dataset.code,peers=new Map(),status=document.getElementById('meetStatus'),videos=document.getElementById('meetVideos'),mic=document.getElementById('meetMic'),camera=document.getElementById('meetCamera'),enter=document.getElementById('meetEnter'),exit=document.getElementById('meetLeave');
let stream=null,joined=false,joining=false,localPeerId=null,inLobby=false,isAdmitted=false,localStream=null,currentRecordingId=null,iceServers=[],device=null,sendTransport=null;
const recordingControls=document.getElementById('recordingControls'),recordBtn=document.getElementById('recordBtn'),stopRecordBtn=document.getElementById('stopRecordBtn');

function request(event,data){return new Promise((resolve,reject)=>socket.timeout(15000).emit(event,data,(err,r)=>err?reject(Error('Connection timed out.')):r?.ok?resolve(r):reject(Error(r?.error||'Unable to connect.'))))}
function sfuRequest(event,data){return new Promise((resolve,reject)=>socket.timeout(15000).emit(event,data,(err,r)=>err?reject(Error('Connection timed out.')):r?.ok?resolve(r):reject(Error(r?.error||'SFU request failed.'))))}
function tile(id,name,media,muted=false){let item=document.getElementById('peer-'+id);if(!item){item=document.createElement('section');item.className='meet-video';item.id='peer-'+id;const v=document.createElement('video');v.autoplay=true;v.playsInline=true;v.muted=muted;item.append(v);const p=document.createElement('p');p.textContent=name;item.append(p);videos.append(item)}item.querySelector('video').srcObject=media;item.querySelector('video').play().catch(()=>{status.textContent='Click the participant video to play their audio.';item.onclick=()=>item.querySelector('video').play()});}
function remove(id){peers.get(id)?.pc.close();peers.delete(id);document.getElementById('peer-'+id)?.remove()}
function cleanup(){joined=false;inLobby=false;isAdmitted=false;for(const id of [...peers.keys()])remove(id);stream?.getTracks().forEach(t=>t.stop());stream=null;sendTransport?.close();sendTransport=null;device=null;videos.replaceChildren();enter.hidden=false;enter.disabled=false;exit.hidden=true;mic.disabled=false;camera.disabled=false;}
function peer(id,name){if(peers.has(id))return peers.get(id);const pc=new RTCPeerConnection({iceServers});const p={pc,pending:[]};peers.set(id,p);for(const kind of['audio','video']){const track=stream?.getTracks().find(t=>t.kind===kind);if(track)pc.addTrack(track,stream);else pc.addTransceiver(kind,{direction:'recvonly'})}pc.onicecandidate=e=>{if(e.candidate)request('meet:signal',{to:id,candidate:e.candidate.toJSON()}).catch(e=>{if(joined)status.textContent=e.message})};pc.ontrack=e=>tile(id,name,e.streams[0]||new MediaStream([e.track]));pc.onconnectionstatechange=()=>{if(pc.connectionState==='failed')status.textContent='A participant could not connect. A TURN relay may be needed for this network.'};return p;}

// Real mediasoup-client integration. This exists solely so the server has a genuine
// Producer (with real, negotiated RTP parameters) to feed into recording's PlainTransport
// consumers — seeing/hearing other participants is handled entirely by the P2P mesh above.
async function ensureDevice(routerRtpCapabilities){
  if(device)return device;
  device=new mediasoupClientBundle.Device();
  await device.load({routerRtpCapabilities});
  return device;
}
async function produceMedia(roomId){
  if(!stream||!device||sendTransport)return;
  const info=await sfuRequest('sfu:create-transport',{roomId,direction:'send'});
  const transport=device.createSendTransport(info);
  sendTransport=transport;
  transport.on('connect',({dtlsParameters},callback,errback)=>{
    sfuRequest('sfu:connect-transport',{roomId,transportId:transport.id,dtlsParameters}).then(()=>callback()).catch(errback);
  });
  transport.on('produce',({kind,rtpParameters},callback,errback)=>{
    sfuRequest('sfu:produce',{roomId,transportId:transport.id,kind,rtpParameters}).then(r=>callback({id:r.producerId})).catch(errback);
  });
  for(const track of stream.getTracks()){
    await transport.produce({track});
  }
}

socket.on('sfu:peer-joined', async ({peerId,userId,fullName})=>{if(peerId===localPeerId)return;const p=peer(peerId,fullName);await p.pc.setLocalDescription(await p.pc.createOffer());await request('sfu:signal',{to:peerId,description:p.pc.localDescription.toJSON()})});
socket.on('meet:peer-joined', async ({peerId,userId,fullName})=>{if(peerId===localPeerId)return;const p=peer(peerId,fullName);await p.pc.setLocalDescription(await p.pc.createOffer());await request('sfu:signal',{to:peerId,description:p.pc.localDescription.toJSON()})});
socket.on('sfu:peer-left',({peerId})=>remove(peerId));
socket.on('sfu:signal',async({from,name,description,candidate})=>{if(!joined&&!inLobby)return;try{const p=peer(from,name);if(description){await p.pc.setRemoteDescription(description);for(const c of p.pending)await p.pc.addIceCandidate(c);p.pending=[];if(description.type==='offer'){await p.pc.setLocalDescription(await p.pc.createAnswer());await request('sfu:signal',{to:from,description:p.pc.localDescription.toJSON()})}}else if(candidate){if(p.pc.remoteDescription)await p.pc.addIceCandidate(candidate);else p.pending.push(candidate)}}catch(e){status.textContent=e.message}});
socket.on('sfu:left',cleanup);
socket.on('disconnect',()=>{if(joined||inLobby){cleanup();status.textContent='Disconnected. Join again when your connection returns.'}});

// Lobby events
socket.on('meet:admitted', async ({roomId,routerRtpCapabilities,iceServers:admittedIceServers})=>{
  iceServers=admittedIceServers;
  joined=true;inLobby=false;isAdmitted=true;
  enter.hidden=true;exit.hidden=false;
  if(recordingControls)recordingControls.hidden=false;
  status.textContent='Connected.';
  try {
    if(mic.checked||camera.checked){
      stream=await navigator.mediaDevices.getUserMedia({audio:true,video:true});
      localStream=stream;
      stream.getAudioTracks().forEach(t=>t.enabled=false); // muted by default
      stream.getVideoTracks().forEach(t=>t.enabled=false); // video off by default
      mic.checked=false;camera.checked=false;
    }
    if(stream)tile('local','You',stream,true);
    if(stream){
      await ensureDevice(routerRtpCapabilities);
      try{await produceMedia(roomId)}catch(e){status.textContent='Media publish failed: '+e.message}
    }
  }catch(e){socket.emit('sfu:leave',{roomId:'meet:'+code});cleanup();status.textContent=e.message}
});

socket.on('meet:denied',()=>{cleanup();status.textContent='Meeting request denied by host.';enter.hidden=false;enter.disabled=false;});

// Recording events
socket.on('meet:recording-started',({recordingId,startedBy})=>{
  status.textContent=`Recording started by ${startedBy}`;
  showRecordingIndicator(recordingId);
});

socket.on('meet:recording-stopped',({recordingId,stoppedBy,duration,downloadUrl})=>{
  status.textContent=`Recording stopped by ${stoppedBy} (${formatDuration(duration)})`;
  hideRecordingIndicator();
  currentRecordingId=null;
  if(recordBtn){recordBtn.classList.remove('d-none');recordBtn.disabled=false;}
  if(stopRecordBtn){stopRecordBtn.classList.add('d-none');stopRecordBtn.disabled=false;}
  if (downloadUrl) {
    showDownloadLink(downloadUrl, recordingId);
  }
});

socket.on('meet:recording-status',({status})=>{
  if (status && status.recordingId) {
    updateRecordingStatus(status);
  }
});

socket.on('meet:lobby-waiting',({peerId,userId,fullName})=>{if(joined){status.textContent=`${fullName} is waiting in lobby`;}});
socket.on('meet:lobby-left',({peerId})=>{remove(peerId);});

function showJoinMeetingButton(){
  const joinBtn=document.createElement('button');
  joinBtn.className='btn btn-primary mt-2';
  joinBtn.textContent='Join Meeting';
  joinBtn.id='meetJoinBtn';
  joinBtn.onclick=async()=>{
    joinBtn.disabled=true;
    joinBtn.textContent='Requesting entry…';
    try{
      await sfuRequest('meet:request-join',{roomId:'meet:'+code});
      status.textContent='Waiting for host to admit you…';
    }catch(e){
      status.textContent=e.message;
      joinBtn.disabled=false;
      joinBtn.textContent='Join Meeting';
    }
  };
  const statusEl=document.getElementById('meetStatus');
  statusEl.parentNode.insertBefore(joinBtn,statusEl.nextSibling);
}

// Join Meeting button click handler
enter.onclick=async()=>{
  if(joining)return;
  if(inLobby){
    const joinBtn=document.getElementById('meetJoinBtn');
    if(joinBtn){
      joinBtn.disabled=true;
      joinBtn.textContent='Requesting entry…';
      try{
        await sfuRequest('meet:request-join',{roomId:'meet:'+code});
        status.textContent='Waiting for host to admit you…';
        document.getElementById('meetJoinBtn').remove();
      }catch(e){
        status.textContent=e.message;
      }
    }
    return;
  }
  joining=true;
  enter.disabled=true;
  status.textContent='Connecting…';
  try{
    if(mic.checked||camera.checked){
      stream=await navigator.mediaDevices.getUserMedia({audio:mic.checked,video:camera.checked});
      localStream=stream;
    }
    if(!joining){stream?.getTracks().forEach(t=>t.stop());return}
    // meet-signaling.js always puts a new peer in a lobby state first (meet:join), then
    // requires meet:request-join to actually admit them — there's no separate host-approval
    // UI yet, so we self-admit immediately, which also matches the "instant join" UX this
    // page has always shown. sfu:join (the old flat join) talks to a different, legacy
    // module (sfu-signaling.js) that races meet-signaling.js's handlers for the same events
    // and doesn't share its lobby/admission state, so it can never work for real media.
    const r=await request('meet:join',{code});
    await request('meet:request-join',{roomId:r.roomId});
    iceServers=r.iceServers;
    joined=true;
    joining=false;
    enter.hidden=true;
    exit.hidden=false;
    mic.disabled=!stream?.getAudioTracks().length;
    camera.disabled=!stream?.getVideoTracks().length;
    if(stream)tile('local','You',stream,true);
    if(recordingControls)recordingControls.hidden=false;
    status.textContent=r.peers.length?'Connected.':'You are the first participant. Share the meeting link to invite others.';
    if(stream){
      try{
        await ensureDevice(r.routerRtpCapabilities);
        await produceMedia(r.roomId);
      }catch(e){status.textContent='Media publish failed: '+e.message}
    }
    for(const u of r.peers){const p=peer(u.peerId,u.fullName);await p.pc.setLocalDescription(await p.pc.createOffer());await request('sfu:signal',{to:u.peerId,description:p.pc.localDescription.toJSON()})}
  }catch(e){socket.emit('sfu:leave',{roomId:'meet:'+code});cleanup();status.textContent=e.message}
};

mic.onchange=()=>stream?.getAudioTracks().forEach(t=>t.enabled=mic.checked);camera.onchange=()=>stream?.getVideoTracks().forEach(t=>t.enabled=camera.checked);exit.onclick=()=>{socket.emit('sfu:leave',{roomId:'meet:'+code});cleanup();status.textContent='You left the meeting.'};window.addEventListener('pagehide',()=>{socket.emit('sfu:leave',{roomId:'meet:'+code});cleanup()});

// Recording helper functions
function showRecordingIndicator() {
  const indicator = document.createElement('div');
  indicator.id = 'recordingIndicator';
  indicator.className = 'meet-recording-indicator';
  indicator.innerHTML = '<span class="recording-dot"></span><span>REC</span><span id="recordingTimer">00:00</span>';
  document.body.appendChild(indicator);

  let seconds = 0;
  const timerEl = document.getElementById('recordingTimer');
  if (timerEl) {
    window.recordingTimerInterval = setInterval(() => {
      seconds++;
      const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
      const secs = (seconds % 60).toString().padStart(2, '0');
      timerEl.textContent = `${mins}:${secs}`;
    }, 1000);
  }
}

function hideRecordingIndicator() {
  const indicator = document.getElementById('recordingIndicator');
  if (indicator) indicator.remove();
  if (window.recordingTimerInterval) {
    clearInterval(window.recordingTimerInterval);
    window.recordingTimerInterval = null;
  }
}

function showDownloadLink(downloadUrl, recordingId) {
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.className = 'meet-download-link btn btn-success mt-2';
  link.target = '_blank';
  link.textContent = `Download recording (${recordingId})`;
  document.getElementById('meetStatus').parentNode.appendChild(link);
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function updateRecordingStatus(recStatus) {
  if (recStatus.recordingId && document.getElementById('recordingIndicator')) {
    const statusEl = document.getElementById('recordingIndicator').querySelector('.recording-status');
    if (statusEl) statusEl.textContent = recStatus.status || '';
  }
}

async function startRecording() {
  if ((!joined && !isAdmitted) || !recordBtn || !stopRecordBtn) return;
  try {
    recordBtn.disabled = true;
    const result = await sfuRequest('meet:start-recording', { roomId: 'meet:' + code });
    currentRecordingId = result.recordingId;
    recordBtn.classList.add('d-none');
    stopRecordBtn.classList.remove('d-none');
    stopRecordBtn.disabled = false;
    status.textContent = 'Recording started';
  } catch (e) {
    status.textContent = e.message;
    recordBtn.disabled = false;
  }
}

async function stopRecording() {
  if (!currentRecordingId || !stopRecordBtn) return;
  try {
    stopRecordBtn.disabled = true;
    await sfuRequest('meet:stop-recording', { roomId: 'meet:' + code, recordingId: currentRecordingId });
    // Button/indicator state resets on the meet:recording-stopped broadcast below,
    // so it stays correct even if another participant is the one who actually sees this ack.
  } catch (e) {
    status.textContent = e.message;
    stopRecordBtn.disabled = false;
  }
}

if (recordBtn) recordBtn.onclick = startRecording;
if (stopRecordBtn) stopRecordBtn.onclick = stopRecording;
})();
