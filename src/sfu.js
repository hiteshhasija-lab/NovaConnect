'use strict';

const mediasoup = require('mediasoup');
const { logger } = require('./logger');
const { getConfig } = require('./config');

const cfg = getConfig();

const MEDIASOUP_WORKER_SETTINGS = {
  logLevel: cfg.NODE_ENV === 'production' ? 'warn' : 'debug',
  logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
};
// The media UDP ports the pod publishes; each worker gets its own slice of them.
// UDP ports for call/meeting media, split evenly between the workers. Default 40000-49999 (the
// NOVAAPP01 lab's pasta networking forwards the whole range). Configurable because a compose
// bridge network (netavark + nftables) can't publish ranges much past 500 ports ("Message too
// long"), so the compose kit uses 40000-40499 — about 250 people in calls at once.
const RTC_PORT_MIN = cfg.MEDIASOUP_RTC_MIN_PORT, RTC_PORT_MAX = cfg.MEDIASOUP_RTC_MAX_PORT;

const MEDIASOUP_ROUTER_OPTIONS = {
  mediaCodecs: [
    {
      kind: 'audio',
      mimeType: 'audio/opus',
      clockRate: 48000,
      channels: 2,
    },
    {
      kind: 'video',
      mimeType: 'video/VP8',
      clockRate: 90000,
      parameters: {
        'x-google-start-bitrate': 1000,
      },
    },
    {
      kind: 'video',
      mimeType: 'video/VP9',
      clockRate: 90000,
      parameters: {
        'profile-id': 2,
        'x-google-start-bitrate': 1000,
      },
    },
    {
      kind: 'video',
      mimeType: 'video/h264',
      clockRate: 90000,
      parameters: {
        'packetization-mode': 1,
        'profile-level-id': '42e01f',
        'level-asymmetry-allowed': 1,
        'x-google-start-bitrate': 1000,
      },
    },
  ],
};

const rooms = new Map(); // roomId -> { peers: Map, router, worker }

// Media runs in mediasoup workers — separate processes, one core each — so there is one per core
// (MEDIASOUP_WORKERS overrides; at most 8). Each has one router; a new room goes to the worker
// with the fewest people in calls right now, so calls spread over every core (one call stays on
// one worker). If a worker dies the process exits and systemd restarts it (calls end cleanly
// as on any restart).
let workersReady = null;
const workers = []; // { worker, router, index }
function createWorkers() {
  workersReady ??= (async () => {
    const count = Math.max(1, Math.min(8, cfg.MEDIASOUP_WORKERS || require('os').availableParallelism?.() || require('os').cpus().length || 1));
    const span = Math.floor((RTC_PORT_MAX - RTC_PORT_MIN + 1) / count);
    for (let index = 0; index < count; index++) {
      const rtcMinPort = RTC_PORT_MIN + index * span;
      const rtcMaxPort = index === count - 1 ? RTC_PORT_MAX : rtcMinPort + span - 1;
      const worker = await mediasoup.createWorker({ ...MEDIASOUP_WORKER_SETTINGS, rtcMinPort, rtcMaxPort });
      worker.on('died', () => {
        logger.error({ index, pid: worker.pid }, 'mediasoup worker died, exiting in 2 seconds...');
        setTimeout(() => process.exit(1), 2000);
      });
      const router = await worker.createRouter({ mediaCodecs: MEDIASOUP_ROUTER_OPTIONS.mediaCodecs });
      workers.push({ worker, router, index });
      logger.info({ index, pid: worker.pid, rtcMinPort, rtcMaxPort }, 'mediasoup worker created');
    }
    return workers;
  })();
  return workersReady;
}
// How busy each worker is: people in its rooms, and rooms.
function workerLoad() {
  return workers.map(w => { let peers = 0, count = 0; for (const r of rooms.values()) if (r.worker === w) { peers += r.peers.size; count++; } return { index: w.index, pid: w.worker.pid, rooms: count, peers }; });
}
// A new room goes to the worker with the fewest people in calls (ties: fewest rooms, then the first).
async function pickWorker() {
  const list = await createWorkers();
  const load = workerLoad();
  return list[load.sort((a, b) => a.peers - b.peers || a.rooms - b.rooms || a.index - b.index)[0].index];
}

// Active speaker: each room's loudest microphone, reported (on change only) to the handler that
// meet-signaling.js registers, which tells the room so the speaker's tile can be highlighted.
let activeSpeakerHandler = null;
function setActiveSpeakerHandler(fn) { activeSpeakerHandler = fn; }
function announceSpeaker(room, peerId) {
  if (room.speaker === peerId || !rooms.has(room.id)) return;
  room.speaker = peerId;
  activeSpeakerHandler?.(room.id, peerId);
}

async function createRoom(roomId) {
  if (rooms.has(roomId)) return rooms.get(roomId);

  const w = await pickWorker();
  if (rooms.has(roomId)) return rooms.get(roomId);
  const r = w.router;
  const room = {
    id: roomId,
    router: r,
    worker: w,
    peers: new Map(), // peerId -> { transports, producers, consumers, rtpCapabilities }
    audioObserver: null,
    speaker: null,
  };
  rooms.set(roomId, room);
  try {
    room.audioObserver = await r.createAudioLevelObserver({ maxEntries: 1, threshold: -70, interval: 800 });
    room.audioObserver.on('volumes', (volumes) => announceSpeaker(room, volumes[0]?.producer.appData.sourcePeerId || null));
    room.audioObserver.on('silence', () => announceSpeaker(room, null));
  } catch (e) {
    logger.warn({ roomId, err: e.message }, 'Active-speaker detection unavailable');
  }
  logger.info({ roomId, worker: w.index }, 'SFU room created');
  return room;
}

function getRoom(roomId) {
  return rooms.get(roomId);
}

function deleteRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return false;

  // Close all peer transports
  for (const [peerId, peer] of room.peers) {
    for (const transport of peer.transports.values()) {
      transport.close();
    }
  }
  stopRecordingsInRoom(roomId);
  room.audioObserver?.close();
  rooms.delete(roomId);
  logger.info({ roomId }, 'SFU room deleted');
  return true;
}

async function createTransport(room, peerId, direction) {
  const roomObj = getRoom(room);
  if (!roomObj) throw new Error('Room not found');

  const transport = await roomObj.router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp: cfg.MEDIASOUP_ANNOUNCED_IP || null }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    // Start viewers' bandwidth estimate high enough for a full-resolution shared screen.
    initialAvailableOutgoingBitrate: 2000000,
  });

  if (!roomObj.peers.has(peerId)) {
    roomObj.peers.set(peerId, {
      transports: new Map(),
      producers: new Map(),
      consumers: new Map(),
      rtpCapabilities: null,
    });
  }

  const peer = roomObj.peers.get(peerId);
  // Keyed by the transport's own (globally-unique) id, matching the id returned to the
  // client below — connectTransport/produce/consume all look transports up by that same
  // id, so a direction-prefixed key here would make every one of those calls miss.
  peer.transports.set(transport.id, transport);

  transport.on('dtlsstatechange', (dtlsState) => {
    if (dtlsState === 'failed' || dtlsState === 'closed') {
      transport.close();
      peer.transports.delete(transport.id);
    }
  });

  return {
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
  };
}

async function connectTransport(room, peerId, transportId, dtlsParameters) {
  const roomObj = getRoom(room);
  if (!roomObj) throw new Error('Room not found');

  const peer = roomObj.peers.get(peerId);
  if (!peer) throw new Error('Peer not found');

  const transport = peer.transports.get(transportId);
  if (!transport) throw new Error('Transport not found');

  await transport.connect({ dtlsParameters });
}

async function produce(room, peerId, transportId, kind, rtpParameters, appData = {}) {
  const roomObj = getRoom(room);
  if (!roomObj) throw new Error('Room not found');

  const peer = roomObj.peers.get(peerId);
  if (!peer) throw new Error('Peer not found');

  const transport = peer.transports.get(transportId);
  if (!transport) throw new Error('Transport not found');

  const producer = await transport.produce({
    kind,
    rtpParameters,
    appData,
  });

  producer.on('transportclose', () => {
    producer.close();
    peer.producers.delete(producer.id);
  });

  peer.producers.set(producer.id, producer);
  if (kind === 'audio' && appData.source !== 'screen') roomObj.audioObserver?.addProducer({ producerId: producer.id }).catch(() => {});
  recordNewProducer(room, producer);

  logger.info({ room, peerId, producerId: producer.id, kind }, 'Producer created');
  return producer.id;
}

async function consume(room, peerId, transportId, producerId, rtpCapabilities, appData = {}) {
  const roomObj = getRoom(room);
  if (!roomObj) throw new Error('Room not found');

  const peer = roomObj.peers.get(peerId);
  if (!peer) throw new Error('Peer not found');

  const transport = peer.transports.get(transportId);
  if (!transport) throw new Error('Transport not found');

  const producer = roomObj.peers.get(appData.sourcePeerId)?.producers?.get(producerId);
  if (!producer) throw new Error('Producer not found');
  if (!roomObj.router.canConsume({ producerId, rtpCapabilities })) throw new Error('Cannot consume this stream');

  const consumer = await transport.consume({
    producerId,
    rtpCapabilities,
    // Starts paused; the client resumes it once its track is wired up, which also makes
    // mediasoup ask the sender for a fresh keyframe so video appears immediately.
    paused: true,
    appData,
  });

  consumer.on('transportclose', () => {
    consumer.close();
    peer.consumers.delete(consumer.id);
  });

  consumer.on('producerclose', () => {
    consumer.close();
    peer.consumers.delete(consumer.id);
  });

  peer.consumers.set(consumer.id, consumer);

  logger.info({ room, peerId, consumerId: consumer.id, producerId, type: consumer.type }, 'Consumer created');
  return {
    id: consumer.id,
    producerId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
    type: consumer.type,
    producerPaused: consumer.producerPaused,
  };
}

// Every producer in the room except the asking peer's own — what a newly admitted peer
// needs to consume to see and hear everyone already in the meeting.
function listProducers(roomId, exceptPeerId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  const out = [];
  for (const [peerId, peer] of room.peers.entries()) {
    if (peerId === exceptPeerId) continue;
    for (const producer of peer.producers.values()) {
      if (producer.closed) continue;
      out.push({ producerId: producer.id, peerId, kind: producer.kind, fullName: producer.appData.sourceFullName || '', source: producer.appData.source === 'screen' ? 'screen' : 'camera', paused: producer.paused });
    }
  }
  return out;
}

// Camera off / microphone muted: pausing the producer stops the stream at the server (a disabled
// track would still send black frames or silence). Returns the producer's kind.
async function setProducerPaused(roomId, peerId, producerId, paused) {
  const producer = getRoom(roomId)?.peers.get(peerId)?.producers.get(producerId);
  if (!producer) throw new Error('Producer not found');
  if (paused) await producer.pause(); else await producer.resume();
  return producer.kind;
}

// Stops one of a peer's streams (a screen share) without leaving; its consumers close via
// their 'producerclose' handlers.
function closeProducer(roomId, peerId, producerId) {
  const peer = getRoom(roomId)?.peers.get(peerId);
  const producer = peer?.producers.get(producerId);
  if (!producer) throw new Error('Producer not found');
  producer.close();
  peer.producers.delete(producerId);
}

function getRoomPeers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.peers.keys());
}

function closePeerTransports(room, peerId) {
  const roomObj = getRoom(room);
  if (!roomObj) return;

  const peer = roomObj.peers.get(peerId);
  if (!peer) return;

  for (const transport of peer.transports.values()) {
    transport.close();
  }
  peer.transports.clear();
  peer.producers.clear();
  peer.consumers.clear();
  roomObj.peers.delete(peerId);
}

async function resumeConsumer(roomId, peerId, consumerId) {
  const room = getRoom(roomId);
  if (!room) throw Error('Room not found');

  const peer = room.peers.get(peerId);
  if (!peer) throw Error('Peer not found');

  const consumer = peer.consumers.get(consumerId);
  if (!consumer) throw Error('Consumer not found');

  await consumer.resume();
}

// Simulcast: a camera arrives in three sizes (sfu-client.js publish). Each viewer asks for the size
// that fits where they show it (0 = smallest); mediasoup still goes lower on a short connection.
async function setConsumerLayers(roomId, peerId, consumerId, spatialLayer) {
  const consumer = getRoom(roomId)?.peers.get(peerId)?.consumers.get(consumerId);
  if (!consumer || consumer.closed || consumer.type !== 'simulcast') return;
  const layer = Math.max(0, Math.min(2, Number(spatialLayer) || 0));
  await consumer.setPreferredLayers({ spatialLayer: layer, temporalLayer: 2 });
  logger.debug({ roomId, peerId, consumerId, spatialLayer: layer }, 'Simulcast layer chosen');
}

// ---------------- Recording ----------------
// Each stream (a person's camera, microphone or shared screen) is recorded separately while the
// call runs: mediasoup sends its RTP to a loopback port (PlainTransport + Consumer), and one ffmpeg
// per stream copies it to a Matroska file as-is (no encoding, so it starts almost at once and is
// cheap). Streams that appear later (late joiners, a new screen share) get their own recorder;
// streams that stop just end. When the recording stops, one MP4 is composed from those files on a
// timeline: videos in a grid, each shown only while it was live (blank while a camera was off or
// after someone left), and all sound mixed with silence filling any gaps. Nothing waits on a live
// stream, so a stream stopping can't stall the recording, and nothing is lost to start-up probing.
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { uploadFile } = require('./storage');

const recordings = new Map(); // recordingId -> recorder

// Told when a recording has been composed (or failed): meet-signaling saves it and tells people.
let recordingFinishedHandler = null;
function setRecordingFinishedHandler(fn) { recordingFinishedHandler = fn; }

const RECORDING_PORT_START = 50000;
const RECORDING_PORT_END = 50998;
let nextRecordingPort = RECORDING_PORT_START;
function allocateRecordingPort() {
  const port = nextRecordingPort;
  nextRecordingPort += 2;
  if (nextRecordingPort > RECORDING_PORT_END) nextRecordingPort = RECORDING_PORT_START;
  return port;
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const recordingDir = id => path.join(cfg.LOCAL_UPLOAD_ROOT || path.join(__dirname, '..', 'data', 'uploads'), '.recording-' + id);

// Starts recording one producer into its own file.
async function recordStream(recorder, producer) {
  if (recorder.stopping || recorder.streams.some(s => s.producerId === producer.id)) return;
  const room = getRoom(recorder.roomId);
  if (!room || producer.closed) return;
  const index = recorder.nextIndex++;
  const port = allocateRecordingPort();
  const transport = await room.router.createPlainTransport({ listenIp: { ip: '127.0.0.1' }, rtcpMux: true, comedia: false });
  await transport.connect({ ip: '127.0.0.1', port });
  const consumer = await transport.consume({ producerId: producer.id, rtpCapabilities: room.router.rtpCapabilities, paused: true });
  const codec = consumer.rtpParameters.codecs[0];
  const codecName = codec.mimeType.split('/')[1].toUpperCase();
  const sdp = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=NovaConnect Recording', 'c=IN IP4 127.0.0.1', 't=0 0',
    `m=${consumer.kind} ${port} RTP/AVP ${codec.payloadType}`,
    consumer.kind === 'audio' ? `a=rtpmap:${codec.payloadType} ${codecName}/${codec.clockRate}/${codec.channels || 2}` : `a=rtpmap:${codec.payloadType} ${codecName}/${codec.clockRate}`,
    'a=recvonly'].join('\n') + '\n';
  const sdpPath = path.join(os.tmpdir(), `${recorder.recordingId}-${index}.sdp`);
  await fsp.writeFile(sdpPath, sdp);
  const file = path.join(recorder.dir, `${index}-${consumer.kind}.mkv`);
  // (Wall-clock packet timestamps were tried in 1.0.114 and broke ffmpeg's RTP reordering; the
  // file's real start is taken from mediasoup's keyframe trace instead — see below.)
  const ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'warning', '-protocol_whitelist', 'file,udp,rtp',
    '-analyzeduration', '2000000', '-probesize', '2000000', '-fflags', '+genpts',
    '-i', sdpPath, '-map', '0', '-c', 'copy', '-f', 'matroska', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  ffmpeg.stderr.on('data', d => logger.debug({ recordingId: recorder.recordingId, index, stderr: d.toString() }, 'ffmpeg (stream)'));
  ffmpeg.on('error', err => logger.error({ recordingId: recorder.recordingId, err }, 'ffmpeg spawn error'));

  const stream = {
    index, producerId: producer.id, kind: consumer.kind, source: producer.appData.source || 'camera',
    transport, consumer, ffmpeg, sdpPath, file, startedAt: null, endedAt: null,
    pauses: [], pausedSince: producer.paused ? Date.now() : null, done: false,
  };
  recorder.streams.push(stream);
  // Camera off / mute pauses the producer: remember when, so the composed video can show a blank
  // tile (not a frozen frame) for that stretch.
  consumer.on('producerpause', () => { if (!stream.pausedSince) stream.pausedSince = Date.now(); });
  consumer.on('producerresume', () => {
    if (stream.pausedSince) { stream.pauses.push([stream.pausedSince, Date.now()]); stream.pausedSince = null; }
    if (stream.kind === 'video') consumer.requestKeyFrame().catch(() => {});
  });
  consumer.on('producerclose', () => finishStream(stream).catch(() => {}));
  // mediasoup sends a video receiver nothing until the sender produces a keyframe, so a video file
  // really starts at its first keyframe — which for a camera that was already running can be
  // seconds after recording started. Note when it goes out, to place the file there.
  if (consumer.kind === 'video') {
    await consumer.enableTraceEvent(['keyframe']).catch(() => {});
    consumer.on('trace', trace => { if (trace.type === 'keyframe' && !stream.firstMediaAt) stream.firstMediaAt = Date.now(); });
  }

  // Give ffmpeg a moment to bind its socket, then start the RTP and ask for a keyframe (ffmpeg
  // can't size the video without one; asked twice in case the first is lost).
  await wait(400);
  if (stream.done) return;
  await consumer.resume();
  stream.startedAt = Date.now();
  if (stream.kind === 'audio') stream.firstMediaAt = stream.startedAt; // audio flows at once
  if (stream.kind === 'video') {
    // A stream that was already running needs a keyframe before anything can be recorded; senders
    // may ignore a request (rate-limited), so ask a few times in the first seconds.
    for (const ms of [0, 500, 1200, 2500, 4000]) setTimeout(() => { if (!stream.done) consumer.requestKeyFrame().catch(() => {}); }, ms);
  }
}

async function finishStream(stream) {
  if (stream.done) return;
  stream.done = true;
  stream.endedAt = Date.now();
  if (stream.pausedSince) { stream.pauses.push([stream.pausedSince, stream.endedAt]); stream.pausedSince = null; }
  // Stop ffmpeg while the stream still flows, then close it. ffmpeg finishes the file on SIGINT
  // (writing out what it has buffered — for a short recording that can be all of its sound), but a
  // first SIGINT is only noticed between packets: with nothing arriving (stream closed, camera off,
  // muted) it would sit until its 10 s network timeout and the file be composed unfinished. A second
  // SIGINT interrupts the waiting read; SIGKILL is the last resort.
  const ff = stream.ffmpeg;
  if (ff && ff.exitCode === null && ff.signalCode === null) {
    const exited = new Promise(resolve => ff.once('close', resolve));
    const within = ms => Promise.race([exited.then(() => true), wait(ms).then(() => false)]);
    ff.kill('SIGINT');
    if (!await within(1500)) { ff.kill('SIGINT'); if (!await within(5000)) { ff.kill('SIGKILL'); await within(2000); } }
  }
  try { stream.consumer.close(); } catch { /* already closed */ }
  try { stream.transport.close(); } catch { /* already closed */ }
  await fsp.unlink(stream.sdpPath).catch(() => {});
}

// meta: { startedBy, startedByName, meetingCode, scope } — handed back to the finished handler.
async function startRecording(roomId, meta = {}) {
  const room = getRoom(roomId);
  if (!room) throw new Error('Room not found');
  if ([...recordings.values()].some(r => r.roomId === roomId && !r.stopping)) throw new Error('This call is already being recorded.');
  const producers = [];
  for (const peer of room.peers.values()) for (const producer of peer.producers.values()) if (!producer.closed) producers.push(producer);
  if (producers.length === 0) throw new Error('Nothing to record yet: nobody has a camera, microphone or screen on.');

  const recordingId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const recorder = { recordingId, roomId, meta, dir: recordingDir(recordingId), streams: [], nextIndex: 0, startTime: Date.now(), stopping: false };
  await fsp.mkdir(recorder.dir, { recursive: true });
  recordings.set(recordingId, recorder);
  await Promise.all(producers.map(p => recordStream(recorder, p).catch(err => logger.error({ recordingId, err }, 'Could not record a stream'))));
  logger.info({ recordingId, roomId, streamCount: recorder.streams.length }, 'Recording started');
  return { recordingId, startTime: recorder.startTime };
}

// A producer created while a room is being recorded (someone joined, or started sharing).
function recordNewProducer(roomId, producer) {
  for (const recorder of recordings.values()) {
    if (recorder.roomId === roomId && !recorder.stopping) recordStream(recorder, producer).catch(err => logger.error({ recordingId: recorder.recordingId, err }, 'Could not record a stream'));
  }
}

// Builds the ffmpeg filter graph that lays the stream files out on the recording's timeline.
function composeArgs(recorder, stopTime, output) {
  const total = Math.max(1, (stopTime - recorder.startTime) / 1000);
  const usable = recorder.streams.filter(s => s.startedAt && fs.existsSync(s.file) && fs.statSync(s.file).size > 0);
  // Where each file really starts: when its first media went out (a video's first keyframe; see
  // recordStream), else when its stream was resumed.
  const firstAt = s => s.firstMediaAt || s.startedAt;
  const videos = usable.filter(s => s.kind === 'video');
  const audios = usable.filter(s => s.kind === 'audio');
  const args = ['-y', '-loglevel', 'error'];
  usable.forEach(s => args.push('-i', s.file));
  const inputOf = s => usable.indexOf(s);
  const at = ms => ((ms - recorder.startTime) / 1000).toFixed(3);
  const parts = [`color=c=0x1b1f3a:s=1280x720:r=15:d=${total.toFixed(3)}[base0]`];
  let last = 'base0';
  if (videos.length) {
    const cols = Math.ceil(Math.sqrt(videos.length)), rows = Math.ceil(videos.length / cols);
    const tileW = Math.floor(1280 / cols / 2) * 2, tileH = Math.floor(720 / rows / 2) * 2;
    videos.forEach((s, i) => {
      const x = (i % cols) * tileW + Math.floor((1280 - cols * tileW) / 2);
      const y = Math.floor(i / cols) * tileH + Math.floor((720 - rows * tileH) / 2);
      parts.push(`[${inputOf(s)}:v]setpts=PTS-STARTPTS+${at(firstAt(s))}/TB,scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease,pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2:color=black,fps=15[v${i}]`);
      // Shown only while live: from its start to its end, minus any time the camera was off.
      const hidden = s.pauses.map(([a, b]) => `between(t,${at(a)},${at(b)})`);
      const enable = `between(t,${at(s.startedAt)},${at(s.endedAt || stopTime)})` + (hidden.length ? `*not(${hidden.join('+')})` : '');
      parts.push(`[${last}][v${i}]overlay=${x}:${y}:eof_action=pass:enable='${enable}'[base${i + 1}]`);
      last = `base${i + 1}`;
    });
  }
  const maps = ['-map', `[${last}]`];
  if (audios.length) {
    audios.forEach((s, i) => {
      const delay = Math.max(0, Math.round(firstAt(s) - recorder.startTime));
      // async: fill gaps (muted stretches) with silence so later sound stays in sync.
      parts.push(`[${inputOf(s)}:a]aresample=48000:async=1000:first_pts=0,adelay=${delay}:all=1[a${i}]`);
    });
    parts.push(`${audios.map((_, i) => `[a${i}]`).join('')}amix=inputs=${audios.length}:normalize=0:duration=longest,apad[aout]`);
    maps.push('-map', '[aout]');
  }
  args.push('-filter_complex', parts.join(';'), ...maps,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
  if (audios.length) args.push('-c:a', 'aac', '-b:a', '128k');
  args.push('-t', total.toFixed(3), '-movflags', '+faststart', output);
  return { args, streamCount: usable.length };
}

// Stops recording now; the MP4 is composed in the background and reported to the finished
// handler (compose time grows with the recording's length). Returns right away.
async function stopRecording(recordingId, reason = 'stopped') {
  const recorder = recordings.get(recordingId);
  if (!recorder) throw new Error('Recording not found');
  if (recorder.stopping) return { recordingId, duration: recorder.stopTime - recorder.startTime };
  recorder.stopping = true;
  recorder.stopTime = Date.now();
  const duration = recorder.stopTime - recorder.startTime;
  logger.info({ recordingId, duration, reason }, 'Recording stopped; composing');
  finalizeRecording(recorder).catch(err => logger.error({ recordingId, err }, 'Recording finalize failed'));
  return { recordingId, duration };
}

async function finalizeRecording(recorder) {
  const { recordingId } = recorder;
  const duration = recorder.stopTime - recorder.startTime;
  let result = { recordingId, duration, failed: true };
  try {
    await Promise.all(recorder.streams.map(finishStream));
    const output = path.join(recorder.dir, `${recordingId}.mp4`);
    const { args, streamCount } = composeArgs(recorder, recorder.stopTime, output);
    if (!streamCount) throw new Error('No stream produced any media');
    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      ff.stderr.on('data', d => { err += d.toString(); });
      ff.on('error', reject);
      ff.on('close', code => (code === 0 ? resolve() : reject(new Error(`compose exited ${code}: ${err.slice(-400)}`))));
    });
    const stats = fs.statSync(output);
    if (!stats.size) throw new Error('Composed file is empty');
    let stored;
    try {
      // Recordings aren't user uploads: no chat-upload size cap (long meetings run to hundreds of MB).
      const up = await uploadFile({ path: output, originalname: `${recordingId}.mp4`, mimetype: 'video/mp4', size: stats.size }, { skipSizeLimit: true });
      stored = { driver: up.driver, url: up.url, key: up.key };
    } catch (err) {
      // Keep the file rather than lose it with the working folder: move it into the local uploads.
      logger.error({ recordingId, err }, 'Failed to upload recording; keeping it in local uploads');
      const root = cfg.LOCAL_UPLOAD_ROOT || path.join(__dirname, '..', 'data', 'uploads');
      await fsp.mkdir(root, { recursive: true });
      await fsp.copyFile(output, path.join(root, `${recordingId}.mp4`));
      stored = { driver: 'local', url: `/uploads/${recordingId}.mp4`, key: `${recordingId}.mp4` };
    }
    result = { recordingId, duration, failed: false, size: stats.size, ...stored };
    logger.info({ recordingId, duration, streamCount, bytes: stats.size }, 'Recording composed');
  } catch (err) {
    logger.error({ recordingId, err: err.message }, 'Recording produced no file');
  } finally {
    recordings.delete(recordingId);
    await fsp.rm(recorder.dir, { recursive: true, force: true }).catch(() => {});
  }
  try { await recordingFinishedHandler?.(result, recorder); } catch (err) { logger.error({ recordingId, err }, 'Recording finished handler failed'); }
}

// The room ended (last person left): finish any recording in it.
function stopRecordingsInRoom(roomId) {
  for (const recorder of recordings.values()) if (recorder.roomId === roomId && !recorder.stopping) stopRecording(recorder.recordingId, 'room ended').catch(() => {});
}

function getRecordingStatus(recordingId) {
  const recorder = recordings.get(recordingId);
  if (!recorder) return null;
  return {
    recordingId: recorder.recordingId,
    roomId: recorder.roomId,
    startTime: recorder.startTime,
    duration: Date.now() - recorder.startTime,
    streamCount: recorder.streams.length,
    stopping: recorder.stopping,
  };
}

// The recording running in a room, if any (so people who join late see the REC banner).
function recordingInRoom(roomId) {
  for (const recorder of recordings.values()) if (recorder.roomId === roomId && !recorder.stopping) return { recordingId: recorder.recordingId, startTime: recorder.startTime, startedByName: recorder.meta?.startedByName || '' };
  return null;
}

module.exports = {
  createWorkers,
  workerLoad,
  createRoom,
  getRoom,
  deleteRoom,
  createTransport,
  connectTransport,
  produce,
  consume,
  resumeConsumer,
  setConsumerLayers,
  startRecording,
  stopRecording,
  getRecordingStatus,
  recordingInRoom,
  setRecordingFinishedHandler,
  getRoomPeers,
  listProducers,
  closeProducer,
  setProducerPaused,
  setActiveSpeakerHandler,
  closePeerTransports,
  rooms,
};