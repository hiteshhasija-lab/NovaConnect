'use strict';

const { Worker } = require('mediasoup');
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

  worker = await Worker.create(MEDIASOUP_WORKER_SETTINGS);

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

// Recording functionality
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getConfig } = require('./config');
const { uploadFile } = require('./storage');

const recordings = new Map(); // recordingId -> { roomId, recorder, filePath, startTime, peerIds }

// Start recording a room
async function startRecording(roomId, options = {}) {
  const room = getRoom(roomId);
  if (!room) throw new Error('Room not found');

  const recordingId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  const cfg = getConfig();
  
  // Create a plain RTP transport for recording (receives all audio/video)
  const recordingTransport = await room.router.createPlainRtpTransport({
    listenIp: { ip: '127.0.0.1', announcedIp: '127.0.0.1' },
    rtcpMux: true,
    comedia: false,
  });

  // Create a plain RTP producer for each active producer in the room
  const peerProducers = [];
  for (const [peerId, peer] of room.peers.entries()) {
    for (const [producerId, producer] of peer.producers.entries()) {
      peerProducers.push({ peerId, producerId, producer, kind: producer.kind });
    }
  }

  if (peerProducers.length === 0) {
    throw new Error('No active producers to record');
  }

  const recorder = {
    roomId,
    recordingId,
    transport: recordingTransport,
    consumers: new Map(),
    startTime: Date.now(),
    peerIds: new Set(),
  };

  // Consume all producers into the recording transport
  for (const { peerId, producerId, producer, kind } of peerProducers) {
    try {
      const consumer = await recordingTransport.consume({
        producerId,
        rtpCapabilities: room.router.rtpCapabilities,
        paused: false,
        appData: { sourcePeerId: producerId },
      });

      consumer.on('transportclose', () => {
        consumer.close();
      });

      consumer.on('producerclose', () => {
        consumer.close();
      });

      recorder.consumers.set(producerId, consumer);
    }
  }

  // Pipe RTP to ffmpeg
  const { recordingId: recId } = recorder;
  const fileName = `recording-${recId}.webm`;
  const tempDir = cfg.LOCAL_UPLOAD_ROOT || path.join(__dirname, '..', 'data', 'uploads');
  const filePath = path.join(tempDir, fileName);
  
  // Ensure directory exists
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // Create ffmpeg process
  const ffmpeg = spawn('ffmpeg', [
    '-y',
    '-f', 'matroska',
    '-i', 'pipe:0',
    '-c:v', 'libvpx-vp9',
    '-b:v', '2M',
    '-c:a', 'libopus',
    '-b:a', '128k',
    '-f', 'webm',
    filePath,
  ], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });

  recorder.ffmpeg = ffmpeg;

  ffmpeg.stderr.on('data', (data) => {
    logger.debug({ recordingId: recId, stderr: data.toString() }, 'FFmpeg stderr');
  });

  ffmpeg.on('error', (err) => {
    logger.error({ recId, err }, 'FFmpeg error');
  });

  ffmpeg.on('close', (code) => {
    logger.info({ recId, code }, 'FFmpeg process closed');
  });

  // Pipe RTP from recording transport to ffmpeg
  recordingTransport.on('rtp', (rtpPacket) => {
    if (recorder.ffmpeg && !recorder.ffmpeg.killed) {
      recorder.ffmpeg.stdin.write(rtpPacket);
    }
  });

  recordings.set(recId, recorder);
  logger.info({ recId, roomId, producerCount: peerProducers.length }, 'Recording started');

  // Notify room participants
  const room = getRoom(recordingTransport.appData?.roomId);
  if (room) {
    // Broadcast recording started event
    // This would be handled by the signaling layer
  }

  return { recordingId: recId, filePath };
}

// Stop recording
async function stopRecording(recordingId) {
  const recorder = recordings.get(recordingId);
  if (!recorder) {
    throw new Error('Recording not found');
  }

  // Close all consumers
  for (const consumer of recorder.consumers.values()) {
    consumer.close();
  }
  recorder.consumers.clear();

  // Close recording transport
  recorder.transport.close();

  // Close ffmpeg
  if (recorder.ffmpeg && !recorder.ffmpeg.killed) {
    recorder.ffmpeg.stdin.end();
    await new Promise((resolve) => {
      recorder.ffmpeg.once('close', resolve);
      setTimeout(resolve, 5000); // Force kill after 5s
    });
  }

  const recording = recordings.get(recordingId);
  recordings.delete(recordingId);

  const duration = Date.now() - recorder.startTime;
  const filePath = path.join(cfg.LOCAL_UPLOAD_ROOT || path.join(__dirname, '..', 'data', 'uploads'), `recording-${recordingId}.webm`);

  // Upload to storage if S3 configured
  let storageResult = { driver: 'local', url: `/uploads/recording-${recordingId}.webm` };
  if (cfg.STORAGE_DRIVER === 's3' && fs.existsSync(filePath)) {
    try {
      const stats = fs.statSync(filePath);
      const stored = await uploadFile({
        path: filePath,
        originalname: `recording-${recordingId}.webm`,
        mimetype: 'video/webm',
        size: stats.size,
      });
      storageResult = { driver: stored.driver, url: stored.url, key: stored.key };
    } catch (err) {
      logger.error({ recId: recordingId, err }, 'Failed to upload recording to S3');
    }
  }

  logger.info({ recId: recordingId, duration }, 'Recording stopped');

  return { recordingId, filePath, duration, ...storageResult };
}

// Get recording status
function getRecordingStatus(recordingId) {
  const recorder = recordings.get(recordingId);
  if (!recorder) return null;
  return {
    recordingId: recorder.recordingId,
    roomId: recorder.roomId,
    startTime: recorder.startTime,
    duration: Date.now() - recorder.startTime,
    peerCount: recorder.peerIds.size,
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