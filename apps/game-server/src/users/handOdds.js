import { readFileSync } from 'node:fs';

/** hand-odds.json：169 类起手牌的 equity / 最终牌型分布 / 加权均值与标准差 */
const data = JSON.parse(readFileSync(new URL('./hand-odds.json', import.meta.url), 'utf8'));

export const HAND_ODDS = data.hands;

/** 牌型权重（高牌=1 … 皇家同花顺≈5.49），由概率分布算得 */
export const CATEGORY_WEIGHTS = data.meta.weights;

/** 引擎牌型编号 0~9 对应的字符串（与 player_hands.category 一致） */
export const CATEGORY_NAMES = [
  'HIGH_CARD',
  'ONE_PAIR',
  'TWO_PAIR',
  'THREE_OF_A_KIND',
  'STRAIGHT',
  'FLUSH',
  'FULL_HOUSE',
  'FOUR_OF_A_KIND',
  'STRAIGHT_FLUSH',
  'ROYAL_FLUSH',
];

/** 牌型字符串 → 权重 */
export const CATEGORY_WEIGHT_BY_NAME = Object.fromEntries(
  CATEGORY_NAMES.map((name, i) => [name, CATEGORY_WEIGHTS[i]]),
);

export const HAND_CLASSES = Object.keys(HAND_ODDS);
