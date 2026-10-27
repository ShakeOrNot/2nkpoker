/**
 * @typedef {Object} Contribution
 * @property {number} seat
 * @property {number} amount
 * @property {boolean} folded
 */

/**
 * @typedef {Object} Pot
 * @property {number} amount             这一层的筹码总额
 * @property {number[]} eligibleSeats    未弃牌、有资格争这层的人（升序）
 * @property {number[]} contributorSeats 为这层投过钱的人（含已弃牌，升序）
 */

/**
 * 根据每位玩家的总投入分层生成主池和边池
 * 每层独立输出，不做合并
 * @param {Contribution[]} contributions
 * @returns {Pot[]}
 */
export function buildPots(contributions) {
  if (contributions.length === 0) return [];

  const levels = [...new Set(contributions.map((c) => c.amount))]
    .filter((a) => a > 0)
    .sort((a, b) => a - b);

  /** @type {Pot[]} */
  const pots = [];
  let prev = 0;

  for (const level of levels) {
    const layerHeight = level - prev;
    const contributors = contributions.filter((c) => c.amount >= level);
    const amount = layerHeight * contributors.length;

    const eligibleSeats = contributors
      .filter((c) => !c.folded)
      .map((c) => c.seat)
      .sort((a, b) => a - b);

    const contributorSeats = contributors.map((c) => c.seat).sort((a, b) => a - b);

    if (amount > 0) {
      pots.push({ amount, eligibleSeats, contributorSeats });
    }
    prev = level;
  }

  return pots;
}

/**
 * @param {Pot[]} pots
 */
export function totalPot(pots) {
  return pots.reduce((s, p) => s + p.amount, 0);
}
/**
 * 决定每层池子归谁，返回每个座位赢得的筹码
 *
 * 规则：
 * - 每层池子，取 eligibleSeats 中牌力最大的
 * - 多个并列第一 → 平分
 * - 除不尽 → 余数给座位号最小的赢家
 * - 某层没有任何人有资格争（eligibleSeats 为空）→ **原路退还**给这层的出资者，
 *   不能凭空蒸发（否则筹码不守恒）。这种层在当前状态机里产生不出来，
 *   属于防御性处理：将来若出现"投钱后弃牌且没人跟到"的路径也不会漏钱。
 *
 * @param {Pot[]} pots
 * @param {Map<number, number>} handStrengthBySeat  座位 -> 牌力（数字越大越强）
 * @returns {Map<number, number>}  座位 -> 赢得的筹码
 */
export function awardPots(pots, handStrengthBySeat) {
  /** @type {Map<number, number>} */
  const winnings = new Map();

  const add = (seat, amount) => {
    winnings.set(seat, (winnings.get(seat) ?? 0) + amount);
  };

  for (const pot of pots) {
    if (pot.eligibleSeats.length === 0) {
      refundLayer(pot, add);
      continue;
    }

    // 找出本层最高牌力
    let best = -Infinity;
    for (const seat of pot.eligibleSeats) {
      const s = handStrengthBySeat.get(seat) ?? -Infinity;
      if (s > best) best = s;
    }

    // 找出所有并列第一的座位
    const winners = pot.eligibleSeats
      .filter((seat) => (handStrengthBySeat.get(seat) ?? -Infinity) === best)
      .sort((a, b) => a - b);

    if (winners.length === 1) {
      add(winners[0], pot.amount);
      continue;
    }

    // 平分，余数给座位号最小的赢家
    const share = Math.floor(pot.amount / winners.length);
    const remainder = pot.amount - share * winners.length;
    for (const seat of winners) add(seat, share);
    add(winners[0], remainder);
  }

  return winnings;
}

/**
 * 无人可争的池层：退还给这层的出资者。
 * 同一层里每个出资者投的钱必然一样多（层高相同），所以平分即按投入比例退还。
 * @param {Pot} pot
 * @param {(seat: number, amount: number) => void} add
 */
function refundLayer(pot, add) {
  const seats = [...new Set(pot.contributorSeats ?? [])].sort((a, b) => a - b);
  if (!seats.length || pot.amount <= 0) return;
  const share = Math.floor(pot.amount / seats.length);
  const remainder = pot.amount - share * seats.length;
  for (const seat of seats) add(seat, share);
  add(seats[0], remainder);
}