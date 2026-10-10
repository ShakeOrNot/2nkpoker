/**
 * @typedef {'s'|'h'|'d'|'c'} Suit
 * @typedef {'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'T'|'J'|'Q'|'K'|'A'} Rank
 * @typedef {`${Rank}${Suit}`} Card
 */

/** @type {Suit[]} */
export const SUITS = ['s', 'h', 'd', 'c'];

/** @type {Rank[]} */
export const RANKS = [
  '2','3','4','5','6','7','8','9','T','J','Q','K','A'
];

/**
 * @param {unknown} v
 * @returns {v is Card}
 */
export function isCard(v) {
  if (typeof v !== 'string' || v.length !== 2) return false;
  return SUITS.includes(v[1]) && RANKS.includes(v[0]);
}