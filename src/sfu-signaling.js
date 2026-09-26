'use strict';

const { createRoom, getRoom, deleteRoom, createTransport, connectTransport, produce, consume, getRoomPeers, closePeerTransports } = require('./sfu');
const { logger } = require('./logger');

function createSfuSignaling(io, db) {
  let ioInstance = io;
  const roomUserMap = new Map(); // socket.id -> { roomId, peerId, userId }

  function attach(socket) {
    const userId = socket.user.id;
    const fullName = socket.user.full_name;

    // Join SFU room
    socket.on('sfu:join', async ({ roomId }, callback) => {
      try {
        if (!roomId) return callback?.({ ok: false, error: 'roomId required' });

        const room = await createRoom(roomId);
        const peerId = `${userId}-${socket.id}`;

        // Track this socket's room membership
        roomUserMap.set(socket.id, { roomId, peerId, userId });

        // Join socket.io room for SFU signaling
        socket.join(`sfu:${roomId}`);

        // Notify others in the room
        ioInstance.to(`sfu:${roomId}`).emit('sfu:peer-joined', {
          peerId,
          userId,
          fullName,
        });

        // Get existing peers
        const peers = getRoomPeers(roomId).filter(p => p !== peerId);
        const peerDetails = [];
        for (const pid of peers) {
          // Find the socket for this peer to get user info
          for (const [sid, info] of roomUserMap.entries()) {
            if (info.peerId === pid) {
              peerDetails.push({
                peerId: pid,
                userId: info.userId,
                fullName: info.userId ? (await getUserFullName(db, info.userId)) : 'Unknown',
              });
              break;
            }
          }
        }

        callback?.({
          ok: true,
          peerId,
          peers: peerDetails,
          routerRtpCapabilities: room.router.rtpCapabilities,
        });
      } catch (err) {
        logger.error({ err, roomId, userId }, 'SFU join failed');
        callback?.({ ok: false, error: err.message });
      }
    });

    // Create WebRTC transport
    socket.on('sfu:create-transport', async ({ roomId, direction }, callback) => {
      try {
        const mapping = roomUserMap.get(socket.id);
        if (!mapping || mapping.roomId !== roomId) {
          return callback?.({ ok: false, error: 'Not in room' });
        }

        const transportInfo = await createTransport(roomId, mapping.peerId, direction);
        callback?.({ ok: true, ...transportInfo });
      } catch (err) {
        logger.error({ err, roomId, userId: socket.user.id }, 'Create transport failed');
        callback?.({ ok: false, error: err.message });
      }
    });

    // Connect transport
    socket.on('sfu:connect-transport', async ({ roomId, transportId, dtlsParameters }, callback) => {
      try {
        const mapping = roomUserMap.get(socket.id);
        if (!mapping || mapping.roomId !== roomId) {
          return callback?.({ ok: false, error: 'Not in room' });
        }

        await connectTransport(roomId, mapping.peerId, transportId, dtlsParameters);
        callback?.({ ok: true, success: true });
      } catch (err) {
        logger.error({ err, roomId, userId: socket.user.id }, 'Connect transport failed');
        callback?.({ ok: false, error: err.message });
      }
    });

    // Produce media
    socket.on('sfu:produce', async ({ roomId, transportId, kind, rtpParameters, appData }, callback) => {
      try {
        const mapping = roomUserMap.get(socket.id);
        if (!mapping || mapping.roomId !== roomId) {
          return callback?.({ ok: false, error: 'Not in room' });
        }

        const producerId = await produce(roomId, mapping.peerId, transportId, kind, rtpParameters, {
          ...appData,
          sourcePeerId: mapping.peerId,
          sourceUserId: userId,
          sourceFullName: fullName,
        });

        // Notify others in the room
        ioInstance.to(`sfu:${roomId}`).emit('sfu:new-producer', {
          producerId,
          peerId: mapping.peerId,
          userId,
          fullName,
          kind,
        });

        callback?.({ ok: true, producerId });
      } catch (err) {
        logger.error({ err, roomId, userId: socket.user.id }, 'Produce failed');
        callback?.({ ok: false, error: err.message });
      }
    });

    // Consume media
    socket.on('sfu:consume', async ({ roomId, transportId, producerId, rtpCapabilities, appData }, callback) => {
      try {
        const mapping = roomUserMap.get(socket.id);
        if (!mapping || mapping.roomId !== roomId) {
          return callback?.({ ok: false, error: 'Not in room' });
        }

        const consumerInfo = await consume(roomId, mapping.peerId, transportId, producerId, rtpCapabilities, {
          ...appData,
          sourcePeerId: appData?.sourcePeerId,
        });

        callback?.({ ok: true, ...consumerInfo });
      } catch (err) {
        logger.error({ err, roomId, userId: socket.user.id }, 'Consume failed');
        callback?.({ ok: false, error: err.message });
      }
    });

    // Resume consumer
    socket.on('sfu:resume-consumer', async ({ roomId, consumerId }, callback) => {
      try {
        const mapping = roomUserMap.get(socket.id);
        if (!mapping || mapping.roomId !== roomId) {
          return callback?.({ ok: false, error: 'Not in room' });
        }

        const room = getRoom(roomId);
        if (!room) return callback?.({ ok: false, error: 'Room not found' });

        const peer = room.peers.get(mapping.peerId);
        if (!peer) return callback?.({ ok: false, error: 'Peer not found' });

        const consumer = peer.consumers.get(consumerId);
        if (!consumer) return callback?.({ ok: false, error: 'Consumer not found' });

        await consumer.resume();
        callback?.({ ok: true, success: true });
      } catch (err) {
        logger.error({ err, roomId, userId: socket.user.id }, 'Resume consumer failed');
        callback?.({ ok: false, error: err.message });
      }
    });

    // Handle disconnect from SFU room
    socket.on('sfu:leave', async ({ roomId }, callback) => {
      try {
        const mapping = roomUserMap.get(socket.id);
        if (mapping && mapping.roomId === roomId) {
          await handleLeave(roomId, mapping.peerId, userId, fullName);
        }
        callback?.({ ok: true, success: true });
      } catch (err) {
        logger.error({ err, roomId, userId: socket.user.id }, 'SFU leave failed');
        callback?.({ ok: false, error: err.message });
      }
    });

    // Handle socket disconnect
    socket.on('disconnect', async () => {
      const mapping = roomUserMap.get(socket.id);
      if (mapping) {
        await handleLeave(mapping.roomId, mapping.peerId, userId, fullName);
        roomUserMap.delete(socket.id);
      }
    });
  }

  async function handleLeave(roomId, peerId, userId, fullName) {
    try {
      // Notify others
      const room = getRoom(roomId);
      if (room) {
        ioInstance.to(`sfu:${roomId}`).emit('sfu:peer-left', { peerId, userId, fullName });
      }

      // Clean up peer
      closePeerTransports(roomId, peerId);

      // Check if room is empty
      const roomAfter = getRoom(roomId);
      if (roomAfter && roomAfter.peers.size === 0) {
        deleteRoom(roomId);
      }
    } catch (err) {
      logger.error({ err, roomId, peerId }, 'SFU leave cleanup failed');
    }
  }

  // Helper to get user full name
  async function getUserFullName(db, userId) {
    try {
      const row = await db.prepare('SELECT full_name FROM users WHERE id = ?').get(userId);
      return row?.full_name || 'Unknown';
    } catch {
      return 'Unknown';
    }
  }

  function setIo(io) {
    ioInstance = io;
  }

  return { attach, setIo, roomUserMap, createTransport, connectTransport, produce, consume, getRoomPeers, closePeerTransports, resumeConsumer: async (roomId, peerId, consumerId) => {
    const room = getRoom(roomId);
    if (!room) throw Error('Room not found');
    const peer = room.peers.get(peerId);
    if (!peer) throw Error('Peer not found');
    const consumer = peer.consumers.get(consumerId);
    if (!consumer) throw Error('Consumer not found');
    await consumer.resume();
  } };
}

module.exports = { createSfuSignaling };