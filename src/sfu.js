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
  getRoomPeers,
  closePeerTransports,
  rooms,
};