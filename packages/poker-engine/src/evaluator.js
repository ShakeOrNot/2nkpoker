import { SUITS, RANKS } from '@2nkpoker/shared';

/** @typedef {import('@2nkpoker/shared').Card} Card */

export const Category = Object.freeze({
  HIGH_CARD: 0,
  ONE_PAIR: 1,
  TWO_PAIR: 2,
  THREE_OF_A_KIND: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  FOUR_OF_A_KIND: 7,
  STRAIGHT_FLUSH: 8,
  ROYAL_FLUSH: 9,
});

/** @type {Record<string, number>} */
const RANK_VALUE = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
};

/**
 * @param {Card} card
 * @returns {number}
 */
function rankOf(card) {
  return RANK_VALUE[card[0]];
}

/**
 * @param {Card} card
 * @returns {string}
 */
function suitOf(card) {
  return card[1];
}

/**
 * 从 5 张牌算出可比较的 HandValue
 * @param {Card[]} cards  必须正好 5 张
 * @returns {{ category: number, tiebreakers: number[], bestFive: Card[] }}
 */
export function evaluate5(cards) {
  if (cards.length !== 5) {
    throw new Error(`evaluate5: need 5 cards, got ${cards.length}`);
  }

  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const suits = cards.map(suitOf);
  const isFlush = suits.every((s) => s === suits[0]);

  // 统计每个点数出现次数
  /** @type {Map<number, number>} */
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);

  // 按 [出现次数降序, 点数降序] 排序
  const grouped = [...counts.entries()]
    .map(([rank, count]) => ({ rank, count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);

  // 顺子检测（含 A2345 轮子）
  const uniqueRanks = [...new Set(ranks)].sort((a, b) => b - a);
  let straightHigh = 0;
  if (uniqueRanks.length === 5) {
    if (uniqueRanks[0] - uniqueRanks[4] === 4) {
      straightHigh = uniqueRanks[0];
    } else if (
      uniqueRanks[0] === 14 &&
      uniqueRanks[1] === 5 &&
      uniqueRanks[2] === 4 &&
      uniqueRanks[3] === 3 &&
      uniqueRanks[4] === 2
    ) {
      // A2345 轮子，5 为最高
      straightHigh = 5;
    }
  }

  // 皇家同花顺
  if (isFlush && straightHigh === 14) {
    return { category: Category.ROYAL_FLUSH, tiebreakers: [14], bestFive: cards };
  }

  // 同花顺
  if (isFlush && straightHigh) {
    return { category: Category.STRAIGHT_FLUSH, tiebreakers: [straightHigh], bestFive: cards };
  }

  // 四条
  if (grouped[0].count === 4) {
    return {
      category: Category.FOUR_OF_A_KIND,
      tiebreakers: [grouped[0].rank, grouped[1].rank],
      bestFive: cards,
    };
  }

  // 葫芦
  if (grouped[0].count === 3 && grouped[1].count === 2) {
    return {
      category: Category.FULL_HOUSE,
      tiebreakers: [grouped[0].rank, grouped[1].rank],
      bestFive: cards,
    };
  }

  // 同花
  if (isFlush) {
    return { category: Category.FLUSH, tiebreakers: ranks, bestFive: cards };
  }

  // 顺子
  if (straightHigh) {
    return { category: Category.STRAIGHT, tiebreakers: [straightHigh], bestFive: cards };
  }

  // 三条
  if (grouped[0].count === 3) {
    const kickers = grouped.slice(1).map((g) => g.rank);
    return {
      category: Category.THREE_OF_A_KIND,
      tiebreakers: [grouped[0].rank, ...kickers],
      bestFive: cards,
    };
  }

  // 两对
  if (grouped[0].count === 2 && grouped[1].count === 2) {
    const highPair = Math.max(grouped[0].rank, grouped[1].rank);
    const lowPair = Math.min(grouped[0].rank, grouped[1].rank);
    const kicker = grouped[2].rank;
    return {
      category: Category.TWO_PAIR,
      tiebreakers: [highPair, lowPair, kicker],
      bestFive: cards,
    };
  }

  // 一对
  if (grouped[0].count === 2) {
    const kickers = grouped.slice(1).map((g) => g.rank);
    return {
      category: Category.ONE_PAIR,
      tiebreakers: [grouped[0].rank, ...kickers],
      bestFive: cards,
    };
  }

  // 高牌
  return { category: Category.HIGH_CARD, tiebreakers: ranks, bestFive: cards };
}

/**
 * 比较两个 HandValue
 * @returns {number} a > b 返回正数，a < b 返回负数，平局返回 0
 */
export function compareHands(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  const len = Math.max(a.tiebreakers.length, b.tiebreakers.length);
  for (let i = 0; i < len; i++) {
    const av = a.tiebreakers[i] ?? 0;
    const bv = b.tiebreakers[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * 从 n 张牌里取 k 张的所有组合
 * @template T
 * @param {T[]} arr
 * @param {number} k
 * @returns {T[][]}
 */
function combinations(arr, k) {
  /** @type {T[][]} */
  const out = [];
  const n = arr.length;
  const idx = Array.from({ length: k }, (_, i) => i);

  while (true) {
    out.push(idx.map((i) => arr[i]));
    let i = k - 1;
    while (i >= 0 && idx[i] === i + n - k) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
  return out;
}

/**
 * 从 5~7 张牌里选最佳 5 张，返回最大 HandValue
 * @param {Card[]} cards
 */
export function evaluate7(cards) {
  if (cards.length < 5 || cards.length > 7) {
    throw new Error(`evaluate7: need 5~7 cards, got ${cards.length}`);
  }
  if (cards.length === 5) return evaluate5(cards);

  let best = null;
  for (const combo of combinations(cards, 5)) {
    const v = evaluate5(combo);
    if (!best || compareHands(v, best) > 0) best = v;
  }
  return best;
}

// 顺手导出常量，测试和前端都会用
export { RANK_VALUE, rankOf, suitOf, SUITS, RANKS };