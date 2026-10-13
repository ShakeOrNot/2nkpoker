/**
 * 本机牌局记录（后端还没有"创建牌局"接口时的兜底）
 * 只存 roomId + 配置 + 最近访问时间，用于"我创建的牌局 / 最近加入"列表。
 */

import { readStore, writeStore, STORAGE_KEYS } from '../core/config.js';

const MAX_RECORDS = 30;
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * @typedef {Object} RoomRecord
 * @property {string} roomId
 * @property {string} nickname
 * @property {boolean} isHost
 * @property {number} smallBlind
 * @property {number} bigBlind
 * @property {number} maxSeats
 * @property {number} buyIn
 * @property {number} createdAt
 * @property {number} lastSeenAt
 */

/**
 * @returns {RoomRecord[]}
 */
export function loadRecords() {
  const raw = readStore(STORAGE_KEYS.rooms);
  const list = Array.isArray(raw?.rooms) ? raw.rooms : [];
  const now = Date.now();
  return list
    .filter((r) => r && typeof r.roomId === 'string' && now - (r.lastSeenAt ?? 0) < MAX_AGE_MS)
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
}

/**
 * @param {RoomRecord[]} list
 */
function persist(list) {
  writeStore(STORAGE_KEYS.rooms, { rooms: list.slice(0, MAX_RECORDS) });
}

/**
 * 新增或更新一条记录
 * @param {Partial<RoomRecord> & { roomId: string }} patch
 * @returns {RoomRecord|null}
 */
export function upsertRecord(patch) {
  if (!patch?.roomId) return null;
  const now = Date.now();
  const list = loadRecords();
  const idx = list.findIndex((r) => r.roomId === patch.roomId);
  const prev = idx >= 0 ? list[idx] : null;
  /** @type {RoomRecord} */
  const next = {
    roomId: patch.roomId,
    nickname: patch.nickname ?? prev?.nickname ?? '',
    isHost: patch.isHost ?? prev?.isHost ?? false,
    smallBlind: patch.smallBlind ?? prev?.smallBlind ?? 10,
    bigBlind: patch.bigBlind ?? prev?.bigBlind ?? 20,
    maxSeats: patch.maxSeats ?? prev?.maxSeats ?? 6,
    buyIn: patch.buyIn ?? prev?.buyIn ?? 1000,
    createdAt: prev?.createdAt ?? now,
    lastSeenAt: now,
  };
  if (idx >= 0) list[idx] = next;
  else list.unshift(next);
  persist(list);
  return next;
}

/**
 * @param {string} roomId
 */
export function forgetRecord(roomId) {
  persist(loadRecords().filter((r) => r.roomId !== roomId));
}

/**
 * 把本机记录和后端列表合并（后端优先，后端没有的补上本机记录）
 * @param {any[]} remote
 * @returns {Array<{ roomId: string, source: 'server'|'local', players?: number, maxSeats: number, hasHand: boolean, smallBlind: number, bigBlind: number, createdAt: number, isHost?: boolean }>}
 */
export function mergeRooms(remote) {
  const now = Date.now();
  /** @type {Map<string, any>} */
  const map = new Map();

  for (const raw of remote ?? []) {
    const roomId = String(raw?.tableId ?? raw?.roomId ?? raw?.id ?? '').trim();
    if (!roomId) continue;
    map.set(roomId, {
      roomId,
      source: 'server',
      players: Number(raw.players ?? raw.seated ?? raw.seatCount ?? 0) || 0,
      maxSeats: Number(raw.maxSeats ?? 6) || 6,
      hasHand: Boolean(raw.hasHand ?? raw.inHand ?? false),
      smallBlind: Number(raw.smallBlind ?? 10) || 10,
      bigBlind: Number(raw.bigBlind ?? 20) || 20,
      createdAt: Number(raw.createdAt ?? now),
      isHost: false,
    });
  }

  for (const rec of loadRecords()) {
    if (map.has(rec.roomId)) continue;
    map.set(rec.roomId, {
      roomId: rec.roomId,
      source: 'local',
      players: 0,
      maxSeats: rec.maxSeats,
      hasHand: false,
      smallBlind: rec.smallBlind,
      bigBlind: rec.bigBlind,
      createdAt: rec.createdAt,
      isHost: Boolean(rec.isHost),
    });
  }

  return [...map.values()].sort((a, b) => b.createdAt - a.createdAt);
}
