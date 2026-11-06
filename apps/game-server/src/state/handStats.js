import { recordHandStats } from '../users/statsStore.js';
import { evaluate7 } from '@2nkpoker/poker-engine';
import { CATEGORY_NAMES, CATEGORY_WEIGHT_BY_NAME, HAND_ODDS } from '../users/handOdds.js';
import { equityShares } from './equity.js';

const RANK_ORDER = '23456789TJQKA';

/**
 * 1326 组合归到 169 类：AA / AKs / AKo（高张在前）
 * @param {string[]} hole
 * @returns {string|null}
 */
export function handClassOf(hole) {
  if (!Array.isArray(hole) || hole.length !== 2) return null;
  const [a, b] = hole;
  if (a[0] === b[0]) return `${a[0]}${b[0]}`;
  const high = RANK_ORDER.indexOf(a[0]) >= RANK_ORDER.indexOf(b[0]) ? a : b;
  const low = high === a ? b : a;
  return `${high[0]}${low[0]}${a[1] === b[1] ? 's' : 'o'}`;
}

/**
 * 一手牌开始：初始化本手的统计累加器
 * @param {any} t
 */
export function beginHandStats(t) {
  t.handStats = { vpip: new Set(), at: Date.now(), runout: null };
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
  if (!t.handStats) t.handStats = { vpip: new Set(), at: Date.now(), runout: null };
  t.handStats.vpip.add(hs.userId);
}

/**
 * 本手进入"跑马"时记下当时的公共牌和仍在手玩家的底牌，
 * 结算时用它算 all-in 那一刻的 equity。
 * @param {any} t
 */
export function captureRunout(t) {
  const hand = t.handState;
  if (!hand || hand.settled || t.handStats?.runout) return;
  const canAct = hand.seats.filter((s) => !s.folded && !s.allIn && s.chips > 0).length;
  if (canAct > 1) return;
  if (!t.handStats) t.handStats = { vpip: new Set(), at: Date.now(), runout: null };
  t.handStats.runout = {
    board: [...hand.board],
    seats: hand.seats
      .filter((s) => !s.folded)
      .map((s) => ({ seat: s.seat, holeCards: [...s.holeCards] })),
  };
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
  const pot = hand.seats.reduce((n, s) => n + Number(s.totalCommitted ?? 0), 0);
  const showdown = Object.keys(revealed).length > 0;
  const anyAllIn = hand.seats.some((s) => s.allIn);

  /** @type {Map<number, number>|null} */
  let shares = null;
  const runoutSeats = new Set();
  if (showdown && anyAllIn) {
    const snap = t.handStats?.runout ?? {
      board: [],
      seats: hand.seats
        .filter((s) => !s.folded)
        .map((s) => ({ seat: s.seat, holeCards: [...s.holeCards] })),
    };
    try {
      shares = equityShares({ board: snap.board, seats: snap.seats, samples: 12000 });
      for (const s of snap.seats) runoutSeats.add(s.seat);
    } catch {
      shares = null;
    }
  }

  const rows = [];
  for (const s of hand.seats) {
    if (!s.userId) continue;
    const paid = Number(payouts[s.seat] ?? 0);
    const committed = Number(s.totalCommitted ?? 0);
    const net = paid - committed;
    const isShowdown = Boolean(revealed[s.seat]);

    /** @type {string|null} */
    let category = null;
    if (isShowdown) {
      try {
        const hv = evaluate7([...s.holeCards, ...hand.board]);
        category = CATEGORY_NAMES[hv.category] ?? null;
      } catch {
        category = null;
      }
    }

    const inRunout = Boolean(shares && runoutSeats.has(s.seat));
    const equity = inRunout ? (shares.get(s.seat) ?? 0) : null;
    const expectedNet =
      equity == null ? null : Math.round(equity * pot - committed);

    const handClass = handClassOf(s.holeCards);
    const playerCount = hand.seats.length;
    // 起手期望胜率：按实际入局人数取 169hands 的 vs (N-1) 个对手数据
    const odds = handClass ? HAND_ODDS[handClass] : null;
    const eqIndex = Math.min(7, Math.max(0, playerCount - 2));
    const equityPreflop = odds ? (odds.equityByPlayers?.[eqIndex] ?? odds.equity) : null;

    rows.push({
      handId: hand.handId,
      userId: s.userId,
      tableId: t.tableId,
      at,
      vpip: vpip.has(s.userId) ? 1 : 0,
      showdown: isShowdown ? 1 : 0,
      won: net > 0 ? 1 : 0,
      showdownWon: isShowdown && net > 0 ? 1 : 0,
      net,
      category,
      holeCards: Array.isArray(s.holeCards) ? s.holeCards.join('') : null,
      handClass,
      categoryWeight: category ? (CATEGORY_WEIGHT_BY_NAME[category] ?? null) : null,
      allin: inRunout ? 1 : 0,
      pot: inRunout ? pot : null,
      invested: committed,
      equityAllin: equity,
      expectedNet,
      playerCount,
      equityPreflop,
    });
  }

  t.handStats = null;
  return recordHandStats(rows);
}
