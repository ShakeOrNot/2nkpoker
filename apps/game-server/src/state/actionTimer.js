import { playAction, cleanupAfterHand, maybeStartHand } from './handOrchestrator.js';
import { recordHandResult } from './handStats.js';
import { advancePendingStreet, buildPots, evaluate7 } from '@2nkpoker/poker-engine';
import { equityShares } from './equity.js';
import { broadcastTable } from '../ws/handlers/table.sit.js';

const ACTION_TIMEOUT_MS = Number(process.env.ACTION_TIMEOUT_MS ?? 30000);
/** 一条街结束到下一条街发牌之间的停顿（给前端做翻牌动画） */
const STREET_DELAY_MS = Number(process.env.STREET_DELAY_MS ?? 1200);
// 一手结束后停多久再开下一手：留给前端放结算动画/浮层。
// 以前这里是立刻开下一手，浮层刚出现就被 hand:start 冲掉了。
const SETTLE_HOLD_MS = Number(process.env.SETTLE_HOLD_MS ?? 5000);

/** @type {Map<string, NodeJS.Timeout>} */
const timers = new Map();
/** 结算后"等一会儿再开下一手"的定时器，每桌一个，防重复 */
/** @type {Map<string, NodeJS.Timeout>} */
const nextHandTimers = new Map();
/** 街道推进延迟定时器（翻牌/转牌/河牌前的 1 秒） */
/** @type {Map<string, NodeJS.Timeout>} */
const streetTimers = new Map();
/** 跑马协商定时器（15 秒没人达成一致就按 1 次发） */
/** @type {Map<string, NodeJS.Timeout>} */
const runoutTimers = new Map();
/** 跑马多 board 逐个亮牌的定时器 */
/** @type {Map<string, NodeJS.Timeout>} */
const revealTimers = new Map();
const RUNOUT_TIMEOUT_MS = Number(process.env.RUNOUT_TIMEOUT_MS ?? 30000);
const RUNOUT_BOARD_MS = Number(process.env.RUNOUT_BOARD_MS ?? 3000);

/** 取消跑马协商/亮牌定时器 */
export function clearRunoutTimer(tableId) {
  for (const map of [runoutTimers, revealTimers]) {
    const timer = map.get(tableId);
    if (timer) clearTimeout(timer);
    map.delete(tableId);
  }
}

/** 牌力数字（与引擎内部一致，用于比大小） */
function handStrength(hv) {
  let n = hv.category;
  for (const t of hv.tiebreakers) n = n * 100 + t;
  return n;
}

/**
 * 按"这次跑第几个 board"给底池分层发钱：
 * 每层池子分成 runs 份，余数给前几个 board，保证 N 个 board 加起来刚好是一个底池。
 */
function awardRun(pots, strength, runIndex, runs) {
  const winnings = new Map();
  const add = (seat, amount) => {
    if (amount > 0) winnings.set(seat, (winnings.get(seat) ?? 0) + amount);
  };

  for (const pot of pots) {
    const amount = Math.floor(pot.amount / runs) + (runIndex < pot.amount % runs ? 1 : 0);
    if (amount <= 0) continue;
    if (!pot.eligibleSeats.length) {
      const seats = [...new Set(pot.contributorSeats ?? [])].sort((a, b) => a - b);
      if (!seats.length) continue;
      const share = Math.floor(amount / seats.length);
      const rem = amount - share * seats.length;
      for (const seat of seats) add(seat, share);
      add(seats[0], rem);
      continue;
    }
    let best = -Infinity;
    for (const seat of pot.eligibleSeats) best = Math.max(best, strength.get(seat) ?? -Infinity);
    const winners = pot.eligibleSeats
      .filter((seat) => (strength.get(seat) ?? -Infinity) === best)
      .sort((a, b) => a - b);
    const share = Math.floor(amount / winners.length);
    const rem = amount - share * winners.length;
    for (const seat of winners) add(seat, share);
    add(winners[0], rem);
  }
  return winnings;
}

/**
 * 本手进入跑马且牌还没发完时，先停下来问双方跑几次。
 * @returns {boolean} true = 已进入协商（调用方不要再 scheduleStreetAdvance）
 */
export function maybeOfferRunout(nsp, t) {
  const hand = t.handState;
  if (!hand || hand.settled || hand.board.length >= 5) return false;
  if (t.runout && t.runout.handId === hand.handId) return true;

  const live = hand.seats.filter((s) => !s.folded);
  if (live.length < 2) return false;
  // 只有"没人还能继续下注"才是跑马；普通一条街打完不能弹协商
  const canAct = hand.seats.filter((s) => !s.folded && !s.allIn && s.chips > 0).length;
  if (canAct >= 2) return false;
  const need = 5 - hand.board.length;
  const maxRuns = Math.floor(hand.deck.length / need);
  if (maxRuns < 2) return false;

  const seats = live.map((s) => s.seat);
  t.runout = {
    handId: hand.handId,
    seats,
    maxRuns,
    deadline: Date.now() + RUNOUT_TIMEOUT_MS,
    proposals: new Map(),
    timer: null,
  };

  nsp.to(`table:${t.tableId}`).emit('game:runout_offer', {
    handId: hand.handId,
    board: [...hand.board],
    seats,
    maxRuns,
    deadline: t.runout.deadline,
  });

  t.runout.timer = setTimeout(() => {
    runoutTimers.delete(t.tableId);
    t.actor.run(() => {
      const r = t.runout;
      if (!r || r.handId !== hand.handId) return;
      t.runout = null;
      nsp.to(`table:${t.tableId}`).emit('game:runout_agreed', {
        handId: hand.handId,
        runs: 1,
        timeout: true,
      });
      publishRunoutReveal(nsp, t, 1);
      // 只跑 1 次：回到正常逐街发牌动画
      scheduleStreetAdvance(nsp, t);
    });
  }, RUNOUT_TIMEOUT_MS);
  runoutTimers.set(t.tableId, t.runout.timer);
  return true;
}

/**
 * 玩家提议跑几次；所有参与 all-in 的人都选同一个数才执行。
 * @returns {{ ok: boolean, code?: string, message?: string }}
 */
export function handleRunoutPropose(nsp, t, seat, handId, runs) {
  const r = t.runout;
  if (!r || r.handId !== handId) return { ok: false, code: 'NO_RUNOUT', message: '当前没有跑马协商' };
  if (!r.seats.includes(seat)) return { ok: false, code: 'NOT_IN_HAND', message: '你不在本手里' };
  const n = Number(runs);
  if (!Number.isInteger(n) || n < 1 || n > r.maxRuns) {
    return { ok: false, code: 'INVALID_RUNS', message: `只能跑 1~${r.maxRuns} 次` };
  }

  r.proposals.set(seat, n);
  nsp.to(`table:${t.tableId}`).emit('game:runout_state', {
    handId: r.handId,
    maxRuns: r.maxRuns,
    deadline: r.deadline,
    proposals: [...r.proposals.entries()].map(([s, v]) => ({ seat: s, runs: v })),
  });

  const values = [...r.proposals.values()];
  if (r.proposals.size === r.seats.length && values.every((v) => v === values[0])) {
    clearRunoutTimer(t.tableId);
    const agreed = values[0];
    t.runout = null;
    nsp.to(`table:${t.tableId}`).emit('game:runout_agreed', { handId: r.handId, runs: agreed });
    publishRunoutReveal(nsp, t, agreed);
    if (agreed === 1) {
      // 跑 1 次：走正常的逐街发牌 + 1 秒延迟动画
      scheduleStreetAdvance(nsp, t);
    } else {
      settleRunout(nsp, t, agreed);
    }
  }
  return { ok: true };
}

/**
 * 次数确定后公开所有 all-in 玩家的底牌，并广播当前胜率。
 */
function publishRunoutReveal(nsp, t, runs) {
  const hand = t.handState;
  if (!hand) return;
  const live = hand.seats.filter((s) => !s.folded);
  const seats = live.map((s) => ({
    seat: s.seat,
    userId: s.userId,
    nickname: s.nickname,
    holeCards: [...s.holeCards],
  }));
  /** @type {Array<{ seat: number, equity: number }>} */
  let equities = [];
  try {
    const shares = equityShares({
      board: hand.board,
      seats: seats.map((s) => ({ seat: s.seat, holeCards: s.holeCards })),
      samples: 8000,
    });
    equities = seats.map((s) => ({ seat: s.seat, equity: shares.get(s.seat) ?? 0 }));
  } catch {
    equities = [];
  }
  t.runoutReveal = { handId: hand.handId, runs, seats, equities };
  nsp.to(`table:${t.tableId}`).emit('game:runout_reveal', {
    handId: hand.handId,
    runs,
    seats,
    equities,
  });
}

/**
 * 按商定的次数一次性发完 N 个 board 并结算（各 board 各自分池，边池完整处理）。
 */
function settleRunout(nsp, t, runs) {
  const hand = t.handState;
  if (!hand || hand.settled) return;
  const base = [...hand.board];
  const need = 5 - base.length;
  const deck = [...hand.deck];
  const live = hand.seats.filter((s) => !s.folded);
  const pots = buildPots(
    hand.seats.map((s) => ({ seat: s.seat, amount: s.totalCommitted, folded: s.folded })),
  );

  /** @type {Map<number, number>} */
  const payouts = new Map();
  const boards = [];
  /** @type {number[][]} */
  const boardWinners = [];
  for (let runIndex = 0; runIndex < runs; runIndex++) {
    const cards = deck.splice(0, need);
    if (cards.length < need) break;
    const board = [...base, ...cards];
    boards.push(board);
    const strength = new Map(
      live.map((s) => [s.seat, handStrength(evaluate7([...s.holeCards, ...board]))]),
    );
    let best = -Infinity;
    for (const seat of strength.values()) best = Math.max(best, seat);
    boardWinners.push(
      [...strength.entries()].filter(([, v]) => v === best).map(([seat]) => seat),
    );
    const w = awardRun(pots, strength, runIndex, runs);
    for (const [seat, amount] of w) payouts.set(seat, (payouts.get(seat) ?? 0) + amount);
  }

  if (!boards.length) return;

  hand.settled = true;
  hand.street = 'SETTLED';
  hand.currentTurnSeat = null;
  hand.board = boards[0];
  hand.version += 1;
  hand.result = {
    pots,
    payouts: Object.fromEntries(payouts),
    revealed: Object.fromEntries(live.map((s) => [s.seat, [...s.holeCards]])),
    forcedWinnerSeat: null,
    boards,
    runs: boards.length,
  };
  for (const [seat, amount] of payouts) {
    const seatState = hand.seats.find((s) => s.seat === seat);
    if (seatState) seatState.chips += amount;
  }
  for (const hs of hand.seats) {
    const seatState = t.seats.get(hs.seat);
    if (seatState) seatState.chips = hs.chips;
  }

  revealRunoutBoards(nsp, t, hand.handId, boards, boardWinners);
}

/**
 * 多 board 逐个亮牌：每 RUNOUT_BOARD_MS 发一个 game:runout_board，
 * 全部亮完后再广播 game:result（前端因此能逐张看牌）。
 */
function revealRunoutBoards(nsp, t, handId, boards, boardWinners = []) {
  let index = 0;
  const step = () => {
    if (!t.handState || t.handState.handId !== handId) return;
    if (index < boards.length) {
      nsp.to(`table:${t.tableId}`).emit('game:runout_board', {
        handId,
        index,
        runs: boards.length,
        board: boards[index],
        winners: boardWinners[index] ?? [],
      });
      index += 1;
      const timer = setTimeout(step, RUNOUT_BOARD_MS);
      revealTimers.set(t.tableId, timer);
      return;
    }
    const timer = setTimeout(() => {
      revealTimers.delete(t.tableId);
      if (t.handState && t.handState.handId === handId) broadcastResult(nsp, t, handId);
    }, RUNOUT_BOARD_MS);
    revealTimers.set(t.tableId, timer);
  };
  step();
}

export function clearActionTimer(tableId) {
  const t = timers.get(tableId);
  if (t) clearTimeout(t);
  timers.delete(tableId);
}

/** 取消"下一手"的排队定时器（离桌/断线清理时用） */
export function clearNextHandTimer(tableId) {
  const t = nextHandTimers.get(tableId);
  if (t) clearTimeout(t);
  nextHandTimers.delete(tableId);
}

/** 取消街道推进定时器（解散/清桌时用） */
export function clearStreetTimer(tableId) {
  const t = streetTimers.get(tableId);
  if (t) clearTimeout(t);
  streetTimers.delete(tableId);
}

/**
 * 本街结束后延迟推进下一条街（1 秒动画时间）：
 * 期间 board 不变、没有 action_request；到点后再广播新街 + 公共牌。
 * @param {import('socket.io').Namespace} nsp
 * @param {any} t
 */
export function scheduleStreetAdvance(nsp, t) {
  clearStreetTimer(t.tableId);
  const handId = t.handState?.handId;
  const timer = setTimeout(() => {
    streetTimers.delete(t.tableId);
    t.actor.run(() => {
      if (!t.handState || t.handState.handId !== handId || !t.handState.pendingStreetAdvance) return;
      const { state } = advancePendingStreet(t.handState);
      t.handState = state;
      t.version += 1;

      if (t.handState.settled) {
        clearActionTimer(t.tableId);
        broadcastResult(nsp, t, handId);
        return;
      }
      broadcastTable(nsp, t);
      // 跑马（只跑 1 次）时每条街更新一次胜率，前端实时显示
      let equities = null;
      if (t.runoutReveal && t.runoutReveal.handId === handId) {
        try {
          const shares = equityShares({
            board: t.handState.board,
            seats: t.runoutReveal.seats.map((s) => ({ seat: s.seat, holeCards: s.holeCards })),
            samples: 8000,
          });
          equities = t.runoutReveal.seats.map((s) => ({
            seat: s.seat,
            equity: shares.get(s.seat) ?? 0,
          }));
          t.runoutReveal.equities = equities;
        } catch {
          equities = null;
        }
      }
      // 给前端的显式动画事件（没有监听也不影响）
      nsp.to(`table:${t.tableId}`).emit('game:street', {
        handId,
        street: t.handState.street,
        board: [...t.handState.board],
        ...(equities ? { equities } : {}),
      });
      // 跑马时引擎每次只发一条街：还有下一条就继续按节奏推进
      if (t.handState.pendingStreetAdvance) {
        scheduleStreetAdvance(nsp, t);
        return;
      }
      broadcastActionRequest(nsp, t);
    });
  }, STREET_DELAY_MS);
  streetTimers.set(t.tableId, timer);
}

/** 广播"这手牌开始" */
export function broadcastHandStart(nsp, t) {
  if (!t.handState) return;
  nsp.to(`table:${t.tableId}`).emit('hand:start', {
    handId: t.handState.handId,
    buttonSeat: t.handState.buttonSeat,
    smallBlind: t.handState.smallBlind,
    bigBlind: t.handState.bigBlind,
  });
}

/** 广播"该谁行动"+ 启动超时计时器 */
export function broadcastActionRequest(nsp, t) {
  clearActionTimer(t.tableId);
  if (!t.handState || t.handState.settled) return;
  const turnSeat = t.handState.currentTurnSeat;
  if (turnSeat == null) return;

  const handId = t.handState.handId;
  const s = t.seats.get(turnSeat);

  // 只给当前行动者发 action_request
  if (s) {
    const socketId = findSocketByUserId(nsp, t.tableId, s.userId);
    if (socketId) {
      const sock = nsp.sockets.get(socketId);
      if (sock) {
        sock.emit('game:action_request', {
          handId,
          seat: turnSeat,
          legalActions: computeLegalActions(t, turnSeat),
          deadline: Date.now() + ACTION_TIMEOUT_MS,
          version: t.handState.version,
        });
      }
    }
  }

  // 启动超时
   const player = t.seats.get(turnSeat);
   // 掉线的、或已经点了"本手结束后离桌"的：别让整桌等他 30 秒，100ms 后直接代打
   const delay = (player && (!player.connected || player.leaving)) ? 100 : ACTION_TIMEOUT_MS;
   const timer = setTimeout(() => {
    timers.delete(t.tableId);
    t.actor.run(() => {
      console.log('[TIMER] 超时回调触发, tableId=', t.tableId, 'handId=', handId, 'handState=', t.handState ? t.handState.handId : 'null');
      // 没有进行中的手牌：可能是上一手结束、下一手没开起来
      if (!t.handState) {
        if (maybeStartHand(t)) {
          broadcastTable(nsp, t);
          broadcastHandStart(nsp, t);
          broadcastActionRequest(nsp, t);
        }
        return;
      }
      // hand 已经换了（比如开了新的一手）：旧计时器作废
      if (t.handState.handId !== handId) return;
      if (t.handState.currentTurnSeat !== turnSeat) return;

      const hs = t.handState.seats.find((x) => x.seat === turnSeat);
      if (!hs) return;
      const toCall = t.handState.currentBet - hs.betThisStreet;
      const action = toCall === 0 ? { type: 'check' } : { type: 'fold' };

      const result = playAction(t, turnSeat, action, t.handState.version, { deferStreet: true });
      if (!result.ok) return;

      nsp.to(`table:${t.tableId}`).emit('game:action_applied', {
        seat: turnSeat,
        action,
        handId,
        timeout: true,
      });
      broadcastTable(nsp, t);

      if (t.handState.settled) {
        broadcastResult(nsp, t, handId);
      } else if (t.handState.pendingStreetAdvance) {
        // 跑马且牌没发完：先问双方跑几次；否则按 1 秒推进
        if (!maybeOfferRunout(nsp, t)) scheduleStreetAdvance(nsp, t);
      } else {
        broadcastActionRequest(nsp, t);
      }
    });
  }, delay);
  timers.set(t.tableId, timer);
}

/** 广播结算 + 清理 + 尝试开下一手 */
export function broadcastResult(nsp, t, handId) {
  clearStreetTimer(t.tableId);
  clearRunoutTimer(t.tableId);
  t.runout = null;
  t.runoutReveal = null;
  // 结算明细需要的座位信息（昵称/投入/弃牌）必须随结果一起发出去：
  // 紧接着 cleanupAfterHand 会把 handState 清空，客户端手里就没有座位数据，
  // 结算浮层会因为"没有 seats"画不出来（这就是联机模式少结算框的原因）。
  // 注意：不含 holeCards，亮牌只走 result.revealed，避免泄露未亮牌的手牌。
  const publicSeats = t.handState.seats.map((s) => ({
    seat: s.seat,
    userId: s.userId,
    nickname: s.nickname,
    chips: s.chips,
    betThisStreet: s.betThisStreet,
    totalCommitted: s.totalCommitted,
    folded: s.folded,
    allIn: s.allIn,
  }));

  nsp.to(`table:${t.tableId}`).emit('game:result', {
    handId,
    result: t.handState.result,
    board: t.handState.board,
    seats: publicSeats,
  });

  // 结算后 5 秒内允许参与者主动秀牌（已 showdown 亮过的不重复）
  t.lastHand = {
    handId,
    at: Date.now(),
    seats: t.handState.seats.map((s) => ({
      seat: s.seat,
      userId: s.userId,
      nickname: s.nickname,
      holeCards: [...s.holeCards],
      folded: s.folded,
    })),
    revealed: t.handState.result.revealed ?? {},
    shown: new Set(),
    shownCards: new Map(),
  };

  // 手牌进行中排队要秀的牌：结算时自动亮出
  const queued = t.showQueue ?? new Map();
  t.showQueue = new Map();
  for (const [seat, item] of queued) {
    t.lastHand.shown.add(seat);
    t.lastHand.shownCards.set(seat, item.cards);
    nsp.to(`table:${t.tableId}`).emit('game:show_cards', {
      handId,
      seat,
      nickname: item.nickname,
      cards: item.cards,
    });
  }

  // 战绩入库（必须在 cleanupAfterHand 清空 handState 之前）
  try {
    recordHandResult(t);
  } catch (err) {
    console.error('[stats] record failed', err?.message ?? err);
  }

  const seated = cleanupAfterHand(t);

  // 排队补位的人：把座位写回他们的 socket。
  // 不写的话他们拿不到自己的手牌、也点不了准备 —— 整桌会卡在一个永远不 ready 的幽灵座位上。
  for (const { userId, seat } of seated) {
    const sid = findSocketByUserId(nsp, t.tableId, userId);
    const sock = sid ? nsp.sockets.get(sid) : null;
    if (!sock) {
      // 人已经不在了（关页面/断线）：不留幽灵座位，让他下次重新排队
      t.seats.delete(seat);
      t.userToSeat.delete(userId);
      t.version += 1;
      continue;
    }
    sock.data.tableId = t.tableId;
    sock.data.seat = seat;
    sock.join(`table:${t.tableId}`);
  }

  broadcastTable(nsp, t);

  // 结算后停 SETTLE_HOLD_MS 再开下一手：让前端有时间播结算浮层/动画。
  // 期间有人离座/取消准备的话，maybeStartHand 会自然返回 false。
  clearNextHandTimer(t.tableId);
  const timer = setTimeout(() => {
    nextHandTimers.delete(t.tableId);
    t.actor.run(() => {
      if (!maybeStartHand(t)) return;
      broadcastTable(nsp, t);
      broadcastHandStart(nsp, t);
      broadcastActionRequest(nsp, t);
    });
  }, SETTLE_HOLD_MS);
  nextHandTimers.set(t.tableId, timer);
}

function computeLegalActions(t, seat) {
  const hs = t.handState;
  const s = hs.seats.find((x) => x.seat === seat);
  const toCall = Math.max(0, hs.currentBet - s.betThisStreet);
  const out = ['fold'];
  if (toCall === 0) out.push('check');
  if (toCall > 0) out.push('call');
  if (hs.currentBet === 0) out.push('bet');
  if (hs.currentBet > 0 && s.chips > toCall) out.push('raise');
  out.push('all_in');
  return out;
}

function findSocketByUserId(nsp, tableId, userId) {
  const room = nsp.adapter.rooms.get(`table:${tableId}`);
  if (!room) return null;
  for (const sid of room) {
    const s = nsp.sockets.get(sid);
    if (s && s.data.userId === userId) return sid;
  }
  return null;
}