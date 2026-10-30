import { recordHandStats } from '../users/statsStore.js';

/**
 * 一手牌开始：初始化本手的统计累加器
 * @param {any} t
 */
export function beginHandStats(t) {
  t.handStats = { vpip: new Set(), at: Date.now() };
}

/**
 * 记录翻牌前的主动投钱动作（计入入池率 VPIP）。
 * 盲注、过牌、弃牌都不算；跟注/下注/加注/全下算。
 * @param {any} t
 * @param {number} seat
 * @param {string} actionType
 */
export function notePreflopAction(t, seat, actionType) {
  if (!['call', 'bet', 'raise', 'all_in'].includes(String(actionType))) return;
  const hs = t.handState?.seats?.find((s) => s.seat === seat);
  if (!hs?.userId) return;
  if (!t.handStats) t.handStats = { vpip: new Set(), at: Date.now() };
  t.handStats.vpip.add(hs.userId);
}

/**
 * 一手牌结算：把每个参与者的战绩写入 player_hands。
 * 必须在 cleanupAfterHand 之前调用（要读 handState/result）。
 * @param {any} t
 * @returns {number} 写入的行数
 */
export function recordHandResult(t) {
  const hand = t.handState;
  if (!hand?.settled || !hand.result) return 0;

  const vpip = t.handStats?.vpip ?? new Set();
  const at = t.handStats?.at ?? Date.now();
  const revealed = hand.result.revealed ?? {};
  const payouts = hand.result.payouts ?? {};

  const rows = [];
  for (const s of hand.seats) {
    if (!s.userId) continue;
    const paid = Number(payouts[s.seat] ?? 0);
    const committed = Number(s.totalCommitted ?? 0);
    const net = paid - committed;
    const showdown = Boolean(revealed[s.seat]);
    rows.push({
      handId: hand.handId,
      userId: s.userId,
      tableId: t.tableId,
      at,
      vpip: vpip.has(s.userId) ? 1 : 0,
      showdown: showdown ? 1 : 0,
      won: net > 0 ? 1 : 0,
      showdownWon: showdown && net > 0 ? 1 : 0,
      net,
    });
  }

  t.handStats = null;
  return recordHandStats(rows);
}
