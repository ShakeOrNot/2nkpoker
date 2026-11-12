import { getDb } from './db.js';
import { HAND_ODDS } from './handOdds.js';

/** 每种起手牌至少 10 手才参与“幸运/倒霉”排名 */
export const MIN_SAMPLE = 10;

/**
 * 每个玩家的幸运/倒霉手牌：
 *   1. 跑马收益偏移（all-in 摊牌：实际净收益 − 期望净收益）
 *   2. 起手牌胜率偏差（实际胜率 − 169 表期望胜率），按 Z 值比较
 *   3. 牌力质量偏差（实际加权牌型 − 理论 μ），按 Z 值比较
 * 每项指标各取一个最大、一个最小。
 * @param {string} userId
 */
export function luckForUser(userId) {
  const db = getDb();

  /* ---------- 1. 跑马 ---------- */
  const runouts = db
    .prepare(
      `SELECT hand_id, hole_cards, hand_class, pot, invested, equity_allin, expected_net, net
       FROM player_hands
       WHERE user_id = ? AND allin = 1 AND expected_net IS NOT NULL`,
    )
    .all(String(userId));

  const runoutItems = runouts.map((r) => {
    const actual = Number(r.net);
    const expected = Number(r.expected_net);
    return {
      kind: 'runout',
      title: '跑马收益',
      handClass: r.hand_class,
      holeCards: r.hole_cards,
      n: 1,
      actual,
      expected,
      deviation: actual - expected,
      z: null,
      pot: Number(r.pot ?? 0),
      equity: Number(r.equity_allin ?? 0),
    };
  });

  /* ---------- 2 & 3. 起手牌维度 ---------- */
  const rows = db
    .prepare(
      `SELECT hand_class,
              MAX(hole_cards) AS hole_cards,
              COUNT(*) AS n,
              COALESCE(SUM(won), 0) AS wins,
              COALESCE(SUM(CASE WHEN category_weight IS NOT NULL THEN 1 ELSE 0 END), 0) AS wn,
              COALESCE(SUM(CASE WHEN category_weight IS NOT NULL THEN category_weight ELSE 0 END), 0) AS wsum,
              COALESCE(SUM(equity_preflop), 0) AS eqsum,
              COALESCE(SUM(CASE WHEN equity_preflop IS NOT NULL THEN 1 ELSE 0 END), 0) AS eqn
       FROM player_hands
       WHERE user_id = ? AND hand_class IS NOT NULL
       GROUP BY hand_class`,
    )
    .all(String(userId));

  /** @type {any[]} */
  const winrateItems = [];
  /** @type {any[]} */
  const strengthItems = [];

  for (const r of rows) {
    const odds = HAND_ODDS[r.hand_class];
    if (!odds) continue;

    const n = Number(r.n);
    if (n >= MIN_SAMPLE) {
      const actual = Number(r.wins) / n;
      const eqn = Number(r.eqn);
      const expected = eqn > 0 ? Number(r.eqsum) / eqn : odds.equity;
      const se = Math.sqrt((expected * (1 - expected)) / n);
      winrateItems.push({
        kind: 'winrate',
        title: '起手牌胜率',
        handClass: r.hand_class,
        holeCards: r.hole_cards,
        n,
        actual,
        expected,
        deviation: actual - expected,
        z: se > 0 ? (actual - expected) / se : 0,
      });
    }

    const wn = Number(r.wn);
    if (wn >= MIN_SAMPLE) {
      const actual = Number(r.wsum) / wn;
      const expected = odds.mu;
      const se = odds.sigma / Math.sqrt(wn);
      strengthItems.push({
        kind: 'strength',
        title: '牌力质量',
        handClass: r.hand_class,
        holeCards: r.hole_cards,
        n: wn,
        actual,
        expected,
        deviation: actual - expected,
        z: se > 0 ? (actual - expected) / se : 0,
      });
    }
  }

  const maxBy = (arr, key) =>
    arr.length ? arr.reduce((a, b) => (b[key] > a[key] ? b : a)) : null;
  const minBy = (arr, key) =>
    arr.length ? arr.reduce((a, b) => (b[key] < a[key] ? b : a)) : null;

  return {
    minSample: MIN_SAMPLE,
    lucky: [
      maxBy(runoutItems, 'deviation'),
      maxBy(winrateItems, 'z'),
      maxBy(strengthItems, 'z'),
    ].filter(Boolean),
    unlucky: [
      minBy(runoutItems, 'deviation'),
      minBy(winrateItems, 'z'),
      minBy(strengthItems, 'z'),
    ].filter(Boolean),
    runoutCount: runoutItems.length,
  };
}
