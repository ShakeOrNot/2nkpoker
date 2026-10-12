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
 * 如果桌子空了，从表里清掉
 * @param {string} tableId
 */
export function removeTableIfEmpty(tableId) {
  const t = tables.get(tableId);
  if (t && t.seats.size === 0 && !t.handState) {
    tables.delete(tableId);
  }
}

/**
 * @param {string} tableId
 * @param {string} userId
 * @returns {number|null}
 */
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