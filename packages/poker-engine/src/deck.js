import { randomInt } from 'node:crypto';
import { SUITS, RANKS } from '@2nkpoker/shared';

/**
 * 造一副标准 52 张牌（未洗）
 * @returns {import('@2nkpoker/shared').Card[]}
 */
export function makeDeck() {
  /** @type {string[]} */
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push(`${r}${s}`);
    }
  }
  return deck;
}

/**
 * Fisher-Yates 洗牌，用 crypto.randomInt 保证随机质量
 * 不修改入参，返回新数组
 * @template T
 * @param {T[]} arr
 * @returns {T[]}
 */
export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

/**
 * 从牌堆顶部取 n 张
 * 返回 [取出的牌, 剩下的牌]
 * @param {string[]} deck
 * @param {number} n
 * @returns {[string[], string[]]}
 */
export function draw(deck, n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`draw: n must be a non-negative integer, got ${n}`);
  }
  if (n > deck.length) {
    throw new Error(`draw: not enough cards, need ${n}, have ${deck.length}`);
  }
  return [deck.slice(0, n), deck.slice(n)];
}