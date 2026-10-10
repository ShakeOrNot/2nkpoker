export const BetFraction = Object.freeze({
  THIRD: 1 / 3,
  HALF: 0.5,
  TWO_THIRDS: 2 / 3,
  FULL: 1,
  ONE_POINT_TWO: 1.2,
});

/**
 * @typedef {Object} BetSizeInput
 * @property {number} pot                当前底池总额（不含本街尚未收的注）
 * @property {number} fraction           目标比例，如 0.5 表示 1/2 pot
 * @property {number} currentBet         本街当前最高下注（0 表示无人下注）
 * @property {number} myBetThisStreet    我本街已下注
 * @property {number} chips              我的剩余筹码
 * @property {number} minRaise           最小加注幅度（一般 = bigBlind）
 * @property {number} bigBlind           大盲
 *
 * @typedef {Object} BetSizeResult
 * @property {'bet'|'raise'} type
 * @property {number} amount   本街下注到的总额（等于 actions.js 里 bet/raise 的 amount）
 * @property {boolean} capped  是否因为筹码不足被截断
 * @property {boolean} isAllIn 是否正好等于全部筹码
 * @property {number} fraction 回显比例
 */

/**
 * @param {BetSizeInput} input
 * @returns {BetSizeResult}
 */
export function calcBetSize(input) {
  const { pot, fraction, currentBet, myBetThisStreet, chips, minRaise, bigBlind } = input;

  if (!(fraction > 0)) throw new Error('calcBetSize: fraction must be > 0');
  if (!(pot >= 0)) throw new Error('calcBetSize: pot must be >= 0');
  if (!(chips > 0)) throw new Error('calcBetSize: chips must be > 0');

  const toCall = Math.max(0, currentBet - myBetThisStreet);
  const isRaise = currentBet > 0;

  let target;
  if (!isRaise) {
    // 无人下注，直接按 pot 比例
    target = Math.round(fraction * pot);
    if (target < bigBlind) target = bigBlind;
  } else {
    // 有人下注：加注到 = currentBet + fraction * (pot + 2 * toCall)
    target = Math.round(currentBet + fraction * (pot + 2 * toCall));
    const minTarget = currentBet + minRaise;
    if (target < minTarget) target = minTarget;
  }

  const maxTarget = myBetThisStreet + chips;
  let capped = false;
  if (target > maxTarget) {
    target = maxTarget;
    capped = true;
  }

  return {
    type: isRaise ? 'raise' : 'bet',
    amount: target,
    capped,
    isAllIn: target === maxTarget,
    fraction,
  };
}