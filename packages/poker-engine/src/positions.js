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
 * 把"有人坐的座位"规范成从小到大的一圈。
 *
 * 不传 seatRing 时就退化成连续的 0..n-1（旧行为，保持向后兼容）；
 * 传了就按真实座位号绕环——有人输光离座后座位号会出现空洞，
 * 这类桌子只能靠 seatRing 表达（见 nextOccupiedSeat）。
 *
 * @param {number[]|null|undefined} seatRing
 * @param {number} numPlayers
 * @returns {number[]}
 */
function normalizeRing(seatRing, numPlayers) {
  if (!seatRing) return Array.from({ length: numPlayers }, (_, i) => i);
  const ring = [...new Set(seatRing)].sort((a, b) => a - b);
  if (ring.length !== numPlayers) {
    throw new Error(`seatRing 长度 ${ring.length} 与 numPlayers ${numPlayers} 不一致`);
  }
  return ring;
}

/** 从环上 startIndex 开始，按座位号递增取一圈 */
function rotateFrom(ring, startIndex) {
  return [...ring.slice(startIndex), ...ring.slice(0, startIndex)];
}

function buttonIndex(ring, buttonSeat, fnName) {
  const i = ring.indexOf(buttonSeat);
  if (i < 0) {
    throw new Error(`${fnName}: buttonSeat ${buttonSeat} 不在座位列表 [${ring}] 里`);
  }
  return i;
}

/**
 * 找 fromSeat 顺时针之后的第一个有人坐的座位（绕回最小座位）
 * @param {number[]} occupiedSeats 有人坐的座位号（顺序不限、可重复）
 * @param {number} fromSeat
 * @returns {number|null} 一个都没有时返回 null
 */
export function nextOccupiedSeat(occupiedSeats, fromSeat) {
  const ring = [...new Set(occupiedSeats)].sort((a, b) => a - b);
  if (ring.length === 0) return null;
  return ring.find((seat) => seat > fromSeat) ?? ring[0];
}

/**
 * 翻前行动顺序
 * 6-max: UTG -> HJ -> CO -> BTN -> SB -> BB
 * 2 人：BTN/SB -> BB
 *
 * @param {number} buttonSeat
 * @param {number} numPlayers
 * @param {number[]} [seatRing] 有人坐的真实座位号；不传则按 0..n-1 连续座位算
 * @returns {number[]} 座位号数组，按行动顺序
 */
export function preflopOrder(buttonSeat, numPlayers, seatRing = null) {
  const ring = normalizeRing(seatRing, numPlayers);
  const btn = buttonIndex(ring, buttonSeat, 'preflopOrder');
  // 单挑：BTN(=SB) 先；3 人以上：BB 的下一位（UTG）先
  const start = numPlayers === 2 ? btn : (btn + 3) % numPlayers;
  return rotateFrom(ring, start);
}

/**
 * 翻后行动顺序
 * 6-max: SB -> BB -> UTG -> HJ -> CO -> BTN
 * 2 人：BB -> BTN/SB
 *
 * @param {number} buttonSeat
 * @param {number} numPlayers
 * @param {number[]} [seatRing] 有人坐的真实座位号；不传则按 0..n-1 连续座位算
 * @returns {number[]} 座位号数组，按行动顺序
 */
export function postflopOrder(buttonSeat, numPlayers, seatRing = null) {
  const ring = normalizeRing(seatRing, numPlayers);
  const btn = buttonIndex(ring, buttonSeat, 'postflopOrder');
  // 翻后永远从按钮的下一位（SB）开始
  const start = (btn + 1) % numPlayers;
  return rotateFrom(ring, start);
}