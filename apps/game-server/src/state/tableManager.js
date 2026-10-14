import { TableActor } from './tableActor.js';

/**
 * @typedef {Object} TableSeat
 * @property {number} seat
 * @property {string} userId
 * @property {string} nickname
 * @property {number} chips
 * @property {boolean} ready
 * @property {boolean} connected
 */

/**
 * @typedef {Object} Table
 * @property {string} tableId
 * @property {number} version
 * @property {number} smallBlind
 * @property {number} bigBlind
 * @property {number} buttonSeat
 * @property {Map<number, TableSeat>} seats       // seat -> 座位信息
 * @property {Map<string, number>} userToSeat     // userId -> seat
 * @property {any} handState                       // 从 state-machine 拿
 * @property {TableActor} actor
 * @property {number} maxSeats
 */

/** @type {Map<string, Table>} */
const tables = new Map();
/** 被 POST /tables 显式创建过的桌子，不会被自动清理 */
const explicitlyCreated = new Set();

/**
 * @param {string} tableId
 * @returns {Table}
 */
export function getOrCreateTable(tableId) {
  let t = tables.get(tableId);
  if (!t) {
        t = {
      tableId,
      version: 0,
      smallBlind: 10,
      bigBlind: 20,
      buttonSeat: 0,
      seats: new Map(),
      userToSeat: new Map(),
      handState: null,
      actor: new TableActor(tableId),
      maxSeats: 6,
      createdAt: Date.now(),
    };
    tables.set(tableId, t);
  }
  return t;
}

/**
 * @param {string} tableId
 * @returns {Table|null}
 */
export function getTable(tableId) {
  return tables.get(tableId) ?? null;
}

/**
 * 显式创建一张桌子（POST /tables 用），保存用户指定的配置
 * @param {string} tableId
 * @param {{ maxSeats?: number, smallBlind?: number, bigBlind?: number }} config
 * @returns {any}
 */
export function createTable(tableId, config = {}) {
  const t = getOrCreateTable(tableId);
  if (config.maxSeats != null) {
    const n = Number(config.maxSeats);
    if (Number.isInteger(n) && n >= 2 && n <= 6) t.maxSeats = n;
  }
  if (config.smallBlind != null) {
    const n = Number(config.smallBlind);
    if (Number.isFinite(n) && n > 0) t.smallBlind = n;
  }
  if (config.bigBlind != null) {
    const n = Number(config.bigBlind);
    if (Number.isFinite(n) && n > 0) t.bigBlind = n;
  }
  t.createdAt = Date.now();
  explicitlyCreated.add(tableId);
  return t;
}

/**
 * 返回所有活跃桌子的摘要列表（GET /tables 用）
 * @returns {Array<any>}
 */
export function listTables() {
  /** @type {Array<any>} */
  const out = [];
  for (const t of tables.values()) {
    // 空桌子不列出（除非显式创建过，给房主留一手）
    if (t.seats.size === 0 && !explicitlyCreated.has(t.tableId)) continue;
    out.push({
      tableId: t.tableId,
      players: t.seats.size,
      maxSeats: t.maxSeats,
      hasHand: Boolean(t.handState && !t.handState.settled),
      smallBlind: t.smallBlind,
      bigBlind: t.bigBlind,
      createdAt: t.createdAt ?? Date.now(),
    });
  }
  // 新桌在前
  out.sort((a, b) => b.createdAt - a.createdAt);
  return out;
}

/**
 * 如果桌子空了，从表里清掉（显式创建过的除外）
 * @param {string} tableId
 */
export function removeTableIfEmpty(tableId) {
  const t = tables.get(tableId);
  if (!t) return;
  if (t.seats.size > 0 || t.handState) return;
  if (explicitlyCreated.has(tableId)) return;
  tables.delete(tableId);
}
export function seatOfUser(tableId, userId) {
  const t = tables.get(tableId);
  if (!t) return null;
  return t.userToSeat.get(userId) ?? null;
}

/**
 * 找一个空座位号，没有返回 null
 * @param {Table} t
 * @param {number} preferred
 */
export function findFreeSeat(t, preferred) {
  if (preferred != null && preferred >= 0 && preferred < t.maxSeats) {
    if (!t.seats.has(preferred)) return preferred;
  }
  for (let i = 0; i < t.maxSeats; i++) {
    if (!t.seats.has(i)) return i;
  }
  return null;
}