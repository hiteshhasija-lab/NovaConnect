'use strict';

const mediasoup = require('mediasoup');
const { logger } = require('./logger');
const { getConfig } = require('./config');

const cfg = getConfig();

const MEDIASOUP_WORKER_SETTINGS = {
  logLevel: cfg.NODE_ENV === 'production' ? 'warn' : 'debug',
  logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
  rtcMinPort: 40000,
  rtcMaxPort: 49999,
};

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

let worker = null;
let router = null;
const rooms = new Map(); // roomId -> { peers: Map, router }

async function createWorker() {
  if (worker) return worker;

  worker = await mediasoup.createWorker(MEDIASOUP_WORKER_SETTINGS);

  worker.on('died', () => {
    logger.error('mediasoup worker died, exiting in 2 seconds...');
    setTimeout(() => process.exit(1), 2000);
  });

  logger.info('mediasoup worker created');
  return worker;
}

async function getRouter() {
  if (router) return router;

  const w = await createWorker();
  router = await w.createRouter({ mediaCodecs: MEDIASOUP_ROUTER_OPTIONS.mediaCodecs });
  logger.info('mediasoup router created');
  return router;
}

async function createRoom(roomId) {
  if (rooms.has(roomId)) return rooms.get(roomId);

  const r = await getRouter();
  const room = {
    id: roomId,
    router: r,
    peers: new Map(), // peerId -> { transports, producers, consumers, rtpCapabilities }
  };
  rooms.set(roomId, room);
  logger.info({ roomId }, 'SFU room created');
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
  rooms.delete(roomId);
  logger.info({ roomId }, 'SFU room deleted');
  return true;
}

async function createTransport(room, peerId, direction) {
  const roomObj = getRoom(room);
  if (!roomObj) throw new Error('Room not found');

  const transport = await roomObj.router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp: null }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate: 1000000,
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
  const key = `${direction}-${transport.id}`;
  peer.transports.set(key, transport);

  transport.on('dtlsstatechange', (dtlsState) => {
    if (dtlsState === 'failed' || dtlsState === 'closed') {
      transport.close();
      peer.transports.delete(key);
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

  const consumer = await transport.consume({
    producerId,
    rtpCapabilities,
    paused: false,
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

  logger.info({ room, peerId, consumerId: consumer.id, producerId }, 'Consumer created');
  return {
    id: consumer.id,
    producerId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
    type: consumer.type,
    producerPaused: consumer.producerPaused,
  };
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

// ---------------- Recording ----------------
// mediasoup's PlainTransport sends RTP to an external destination it's told about via
// connect({ip, port}) — it has no in-process 'rtp' event. The standard pattern (mirroring
// mediasoup's own official recording demo) is: one PlainTransport+Consumer per producer,
// each pointed at its own loopback UDP port, and a single ffmpeg process fed an SDP file
// describing every stream so it can receive them all and composite them into one output.
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { uploadFile } = require('./storage');

const recordings = new Map(); // recordingId -> recorder state

const RECORDING_PORT_START = 50000;
const RECORDING_PORT_END = 50998;
let nextRecordingPort = RECORDING_PORT_START;
function allocateRecordingPort() {
  const port = nextRecordingPort;
  nextRecordingPort += 2;
  if (nextRecordingPort > RECORDING_PORT_END) nextRecordingPort = RECORDING_PORT_START;
  return port;
}

async function startRecording(roomId) {
  const room = getRoom(roomId);
  if (!room) throw new Error('Room not found');

  const peerProducers = [];
  for (const peer of room.peers.values()) {
    for (const [producerId, producer] of peer.producers.entries()) {
      peerProducers.push({ producerId, kind: producer.kind });
    }
  }
  if (peerProducers.length === 0) throw new Error('No active producers to record');

  const recordingId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const streams = [];

  for (const { producerId, kind } of peerProducers) {
    const port = allocateRecordingPort();
    const transport = await room.router.createPlainTransport({
      listenIp: { ip: '127.0.0.1' },
      rtcpMux: true,
      comedia: false,
    });
    await transport.connect({ ip: '127.0.0.1', port });
    // paused: true — mediasoup's own recommendation, so we don't start sending RTP
    // (and risk losing the first keyframe) before ffmpeg is actually listening.
    const consumer = await transport.consume({
      producerId,
      rtpCapabilities: room.router.rtpCapabilities,
      paused: true,
    });
    const codec = consumer.rtpParameters.codecs[0];
    streams.push({
      kind, port, transport, consumer,
      payloadType: codec.payloadType,
      codecName: codec.mimeType.split('/')[1].toUpperCase(),
      clockRate: codec.clockRate,
      channels: codec.channels,
    });
  }

  const sdpLines = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=NovaConnect Recording', 'c=IN IP4 127.0.0.1', 't=0 0'];
  for (const s of streams) {
    sdpLines.push(`m=${s.kind} ${s.port} RTP/AVP ${s.payloadType}`);
    sdpLines.push(s.kind === 'audio'
      ? `a=rtpmap:${s.payloadType} ${s.codecName}/${s.clockRate}/${s.channels || 2}`
      : `a=rtpmap:${s.payloadType} ${s.codecName}/${s.clockRate}`);
    sdpLines.push('a=recvonly');
  }
  const sdpPath = path.join(os.tmpdir(), `${recordingId}.sdp`);
  await fsp.writeFile(sdpPath, sdpLines.join('\n') + '\n');

  const tempDir = cfg.LOCAL_UPLOAD_ROOT || path.join(__dirname, '..', 'data', 'uploads');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const webmPath = path.join(tempDir, `${recordingId}.webm`);

  const videoStreams = streams.filter((s) => s.kind === 'video');
  const audioStreams = streams.filter((s) => s.kind === 'audio');
  const ffmpegArgs = ['-y', '-protocol_whitelist', 'file,udp,rtp', '-i', sdpPath];
  const filterParts = [];
  let videoMap = null;
  let audioMap = null;

  if (videoStreams.length === 1) {
    videoMap = `${streams.indexOf(videoStreams[0])}:v`;
  } else if (videoStreams.length > 1) {
    // Simple fixed grid — real gallery/large-view composition is out of MVP scope (see roadmap v2).
    const cols = Math.ceil(Math.sqrt(videoStreams.length));
    const rows = Math.ceil(videoStreams.length / cols);
    const tileW = Math.floor(1280 / cols);
    const tileH = Math.floor(720 / rows);
    videoStreams.forEach((s, i) => {
      filterParts.push(`[${streams.indexOf(s)}:v]scale=${tileW}:${tileH}[v${i}]`);
    });
    const layout = videoStreams.map((_, i) => `${(i % cols) * tileW}_${Math.floor(i / cols) * tileH}`).join('|');
    filterParts.push(`${videoStreams.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${videoStreams.length}:layout=${layout}[vout]`);
    videoMap = 'vout';
  }
  if (audioStreams.length === 1) {
    audioMap = `${streams.indexOf(audioStreams[0])}:a`;
  } else if (audioStreams.length > 1) {
    filterParts.push(`${audioStreams.map((s) => `[${streams.indexOf(s)}:a]`).join('')}amix=inputs=${audioStreams.length}:normalize=0[aout]`);
    audioMap = 'aout';
  }

  if (filterParts.length) ffmpegArgs.push('-filter_complex', filterParts.join(';'));
  if (videoMap) ffmpegArgs.push('-map', filterParts.some((f) => f.includes('[vout]')) ? '[vout]' : videoMap);
  if (audioMap) ffmpegArgs.push('-map', filterParts.some((f) => f.includes('[aout]')) ? '[aout]' : audioMap);
  ffmpegArgs.push('-c:v', 'libvpx-vp9', '-b:v', '2M', '-c:a', 'libopus', '-b:a', '128k', '-f', 'webm', webmPath);

  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
  ffmpeg.stderr.on('data', (d) => logger.debug({ recordingId, stderr: d.toString() }, 'ffmpeg stderr'));
  ffmpeg.on('error', (err) => logger.error({ recordingId, err }, 'ffmpeg spawn error'));

  const recorder = { roomId, recordingId, streams, ffmpeg, sdpPath, webmPath, startTime: Date.now() };
  recordings.set(recordingId, recorder);

  // Give ffmpeg time to bind its input sockets before RTP starts arriving.
  await new Promise((resolve) => setTimeout(resolve, 500));
  await Promise.all(streams.map((s) => s.consumer.resume()));

  logger.info({ recordingId, roomId, streamCount: streams.length }, 'Recording started');
  return { recordingId };
}

async function stopRecording(recordingId) {
  const recorder = recordings.get(recordingId);
  if (!recorder) throw new Error('Recording not found');
  recordings.delete(recordingId);

  for (const s of recorder.streams) {
    s.consumer.close();
    s.transport.close();
  }

  if (recorder.ffmpeg && !recorder.ffmpeg.killed) {
    recorder.ffmpeg.kill('SIGINT'); // ffmpeg's documented way to finalize/flush the container
    await new Promise((resolve) => {
      recorder.ffmpeg.once('close', resolve);
      setTimeout(resolve, 8000);
    });
  }
  await fsp.unlink(recorder.sdpPath).catch(() => {});

  const duration = Date.now() - recorder.startTime;

  // Second ffmpeg pass: transcode WebM (VP8/VP9+Opus, what mediasoup actually negotiates)
  // to MP4 for broad playback compatibility, without touching the SFU's codec preferences.
  let finalPath = recorder.webmPath;
  let finalName = `${recordingId}.webm`;
  let finalMime = 'video/webm';
  if (fs.existsSync(recorder.webmPath)) {
    const mp4Path = recorder.webmPath.replace(/\.webm$/, '.mp4');
    try {
      await new Promise((resolve, reject) => {
        const transcode = spawn('ffmpeg', ['-y', '-i', recorder.webmPath, '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', mp4Path]);
        transcode.on('error', reject);
        transcode.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg mp4 transcode exited ${code}`))));
      });
      finalPath = mp4Path;
      finalName = `${recordingId}.mp4`;
      finalMime = 'video/mp4';
      await fsp.unlink(recorder.webmPath).catch(() => {});
    } catch (err) {
      logger.error({ recordingId, err }, 'MP4 transcode failed, keeping WebM');
    }
  }

  let storageResult = { driver: 'local', url: `/uploads/${finalName}`, key: finalName };
  if (fs.existsSync(finalPath)) {
    try {
      const stats = fs.statSync(finalPath);
      const stored = await uploadFile({ path: finalPath, originalname: finalName, mimetype: finalMime, size: stats.size });
      storageResult = { driver: stored.driver, url: stored.url, key: stored.key };
    } catch (err) {
      logger.error({ recordingId, err }, 'Failed to upload recording');
    }
  }

  logger.info({ recordingId, duration }, 'Recording stopped');
  return { recordingId, duration, ...storageResult };
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
  };
}

module.exports = {
  createWorker,
  getRouter,
  createRoom,
  getRoom,
  deleteRoom,
  createTransport,
  connectTransport,
  produce,
  consume,
  resumeConsumer,
  startRecording,
  stopRecording,
  getRecordingStatus,
  getRoomPeers,
  closePeerTransports,
  rooms,
};