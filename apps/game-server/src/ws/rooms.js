import { randomUUID } from 'node:crypto';

/**
 * 内存房间表：tableId -> { tableId, handId, version, members:Set<userId>, createdAt }
 * 以后换 Redis 时改这一层就行
 */
export const rooms = new Map();

export function getOrCreateRoom(tableId) {
  let room = rooms.get(tableId);
  if (!room) {
    room = {
      tableId,
      handId: randomUUID(),
      version: 0,
      members: new Set(),
      createdAt: Date.now(),
    };
    rooms.set(tableId, room);
  }
  return room;
}

export function leaveRoom(tableId, userId) {
  const room = rooms.get(tableId);
  if (!room) return;
  room.members.delete(userId);
  if (room.members.size === 0) rooms.delete(tableId);
}

/**
 * @param {ReturnType<typeof getOrCreateRoom>} room
 */
export function toSnapshot(room) {
  return {
    tableId: room.tableId,
    version: room.version,
    street: 'WAITING',
    handId: null,
    buttonSeat: 0,
    smallBlind: 1,
    bigBlind: 2,
    board: [],
    pots: [],
    seats: [],
    currentTurnSeat: null,
    actionDeadline: null,
  };
}