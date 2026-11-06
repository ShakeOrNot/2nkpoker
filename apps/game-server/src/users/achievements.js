/**
 * 成就系统：定义 + 计算。
 *
 * 等级用罗马数字 I~VI 表示，第 N 级对应 levels[N-1]。
 * 只在这里放定义，接口返回计算好的结果，前端只负责画。
 */

export const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI'];

/** 三大累计类成就 */
export const SERIES = [
  {
    key: 'hands',
    name: '牌海行者',
    desc: '打的手牌数',
    metric: 'hands',
    unit: '手',
    levels: [1, 10, 100, 1000, 10000, 100000],
  },
  {
    key: 'wins',
    name: '常胜将军',
    desc: '赢下的手牌数',
    metric: 'wins',
    unit: '胜',
    levels: [1, 10, 100, 1000, 10000, 100000],
  },
  {
    key: 'profit',
    name: '筹码巨鳄',
    desc: '累计盈利（只算赢下的手，不扣亏损）',
    metric: 'profit',
    unit: '筹码',
    levels: [1000, 5000, 20000, 100000, 500000, 2000000],
  },
];

/** 牌型收集：每种牌型分别计数（摊牌亮出的最终牌型） */
export const HAND_TYPES = [
  { key: 'ROYAL_FLUSH', name: '天选之人', desc: '皇家同花顺' },
  { key: 'STRAIGHT_FLUSH', name: '同花顺大师', desc: '同花顺' },
  { key: 'FOUR_OF_A_KIND', name: '四条风暴', desc: '四条' },
  { key: 'FULL_HOUSE', name: '葫芦收藏家', desc: '葫芦' },
  { key: 'FLUSH', name: '同花收割者', desc: '同花' },
  { key: 'STRAIGHT', name: '顺子行家', desc: '顺子' },
  { key: 'THREE_OF_A_KIND', name: '三条猎手', desc: '三条' },
  { key: 'TWO_PAIR', name: '两对专家', desc: '两对' },
  { key: 'ONE_PAIR', name: '一对学徒', desc: '一对' },
  { key: 'HIGH_CARD', name: '高牌过客', desc: '高牌' },
];

export const HAND_LEVELS = [1, 10, 100, 1000, 10000, 100000];

/**
 * 数值达到第几级（0 = 未解锁）
 * @param {number} value
 * @param {number[]} levels
 */
export function levelOf(value, levels) {
  const v = Number(value) || 0;
  let lv = 0;
  for (let i = 0; i < levels.length; i++) {
    if (v >= levels[i]) lv = i + 1;
  }
  return lv;
}

/**
 * 生成某个成就的展示数据
 * @param {{ key: string, name: string, desc?: string, unit?: string, levels: number[] }} def
 * @param {number} value
 */
function build(def, value) {
  const v = Number(value) || 0;
  const level = levelOf(v, def.levels);
  const next = level < def.levels.length ? def.levels[level] : null;
  return {
    key: def.key,
    name: def.name,
    desc: def.desc ?? '',
    unit: def.unit ?? '',
    value: v,
    level,
    levelName: level ? ROMAN[level] : '',
    next,
    levels: def.levels,
  };
}

/**
 * 从 stats（含 categories）算出成就
 * @param {any} stats
 */
export function computeAchievements(stats = {}) {
  return {
    series: SERIES.map((def) => build(def, stats[def.metric] ?? 0)),
    handTypes: HAND_TYPES.map((def) => build({ ...def, levels: HAND_LEVELS }, stats.categories?.[def.key] ?? 0)),
  };
}
