/**
 * @typedef {Object} Contribution
 * @property {number} seat
 * @property {number} amount
 * @property {boolean} folded
 */

/**
 * @typedef {Object} Pot
 * @property {number} amount
 * @property {number[]} eligibleSeats
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

    if (amount > 0) {
      pots.push({ amount, eligibleSeats });
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