/**
 * 位置命名（6-max）
 * 从 BTN 顺时针：BTN -> SB -> BB -> UTG -> HJ -> CO
 * 少人时按顺序压缩：
 *   2 人：BTN(=SB), BB
 *   3 人：BTN, SB, BB
 *   4 人：BTN, SB, BB, UTG
 *   5 人：BTN, SB, BB, UTG, CO
 *   6 人：BTN, SB, BB, UTG, HJ, CO
 */
export const Position = Object.freeze({
  BTN: 'BTN',
  SB: 'SB',
  BB: 'BB',
  UTG: 'UTG',
  HJ: 'HJ',
  CO: 'CO',
});

/**
 * 返回从 BTN 开始、按顺时针排列的位置名数组
 * 数组 index i 对应 seat = (buttonSeat + i) % numPlayers
 * @param {number} numPlayers 2~6
 * @returns {string[]}
 */
export function positionsFor(numPlayers) {
  switch (numPlayers) {
    case 2: return ['BTN', 'BB'];            // heads-up: BTN 也是 SB
    case 3: return ['BTN', 'SB', 'BB'];
    case 4: return ['BTN', 'SB', 'BB', 'UTG'];
    case 5: return ['BTN', 'SB', 'BB', 'UTG', 'CO'];
    case 6: return ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'];
    default:
      throw new Error(`positionsFor: unsupported numPlayers=${numPlayers}`);
  }
}

/**
 * 给定座位号和按钮位，返回该座位的位置名
 * @param {number} seat
 * @param {number} buttonSeat
 * @param {number} numPlayers
 * @returns {string}
 */
export function positionOf(seat, buttonSeat, numPlayers) {
  const positions = positionsFor(numPlayers);
  const idx = ((seat - buttonSeat) % numPlayers + numPlayers) % numPlayers;
  return positions[idx];
}

/**
 * 返回 seat -> position 的映射
 * @param {number} buttonSeat
 * @param {number} numPlayers
 * @returns {Map<number, string>}
 */
export function seatPositions(buttonSeat, numPlayers) {
  const positions = positionsFor(numPlayers);
  /** @type {Map<number, string>} */
  const map = new Map();
  for (let i = 0; i < numPlayers; i++) {
    const seat = (buttonSeat + i) % numPlayers;
    map.set(seat, positions[i]);
  }
  return map;
}

/**
 * 翻前行动顺序
 * 6-max: UTG -> HJ -> CO -> BTN -> SB -> BB
 * 2 人：BTN/SB -> BB
 * @param {number} buttonSeat
 * @param {number} numPlayers
 * @returns {number[]} 座位号数组，按行动顺序
 */
export function preflopOrder(buttonSeat, numPlayers) {
  if (numPlayers === 2) {
    return [buttonSeat, (buttonSeat + 1) % 2];
  }
  const positions = positionsFor(numPlayers);
  const bbIdx = positions.indexOf('BB');
  /** @type {number[]} */
  const order = [];
  for (let i = 1; i <= numPlayers; i++) {
    const idx = (bbIdx + i) % numPlayers;
    order.push((buttonSeat + idx) % numPlayers);
  }
  return order;
}

/**
 * 翻后行动顺序
 * 6-max: SB -> BB -> UTG -> HJ -> CO -> BTN
 * 2 人：BB -> BTN/SB
 * @param {number} buttonSeat
 * @param {number} numPlayers
 * @returns {number[]} 座位号数组，按行动顺序
 */
export function postflopOrder(buttonSeat, numPlayers) {
  if (numPlayers === 2) {
    return [(buttonSeat + 1) % 2, buttonSeat];
  }
  const positions = positionsFor(numPlayers);
  const sbIdx = positions.indexOf('SB');
  /** @type {number[]} */
  const order = [];
  for (let i = 0; i < numPlayers; i++) {
    const idx = (sbIdx + i) % numPlayers;
    order.push((buttonSeat + idx) % numPlayers);
  }
  return order;
}