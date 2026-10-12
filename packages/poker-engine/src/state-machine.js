import { makeDeck, shuffle } from './deck.js';
import { evaluate7 } from './evaluator.js';
import { buildPots, awardPots, totalPot } from './pot.js';
import { preflopOrder, postflopOrder } from './positions.js';
import { validateAction, ActionError } from './actions.js';

export const Street = Object.freeze({
  PREFLOP: 'PREFLOP',
  FLOP: 'FLOP',
  TURN: 'TURN',
  RIVER: 'RIVER',
  SETTLED: 'SETTLED',
});

const STREETS = ['PREFLOP', 'FLOP', 'TURN', 'RIVER'];

/**
 * @typedef {Object} HandSeat
 * @property {number} seat
 * @property {string|null} userId
 * @property {string} nickname
 * @property {number} startingChips
 * @property {number} chips
 * @property {string[]} holeCards
 * @property {number} betThisStreet
 * @property {number} totalCommitted
 * @property {boolean} folded
 * @property {boolean} allIn
 * @property {boolean} sittingOut
 * @property {boolean} hasActedThisStreet
 */

/**
 * @typedef {Object} StartHandInput
 * @property {string} handId
 * @property {number} buttonSeat
 * @property {number} smallBlind
 * @property {number} bigBlind
 * @property {Array<{seat:number,userId?:string,nickname?:string,chips:number}>} players
 */

/**
 * 一手新牌开局
 * @param {StartHandInput} input
 * @returns {{ state: any, events: any[] }}
 */
export function startHand(input) {
  const { handId, buttonSeat, smallBlind, bigBlind, players } = input;

  if (!Array.isArray(players) || players.length < 2 || players.length > 6) {
    throw new Error('startHand: players must be 2~6');
  }

  const sorted = [...players].sort((a, b) => a.seat - b.seat);
  const n = sorted.length;
  for (let i = 0; i < n; i++) {
    if (sorted[i].seat !== i) {
      throw new Error('startHand: seats must be 0..n-1 consecutive');
    }
    if (sorted[i].chips <= 0) {
      throw new Error(`startHand: seat ${i} has 0 chips`);
    }
  }
  if (buttonSeat < 0 || buttonSeat >= n) {
    throw new Error('startHand: buttonSeat out of range');
  }

  const deck = shuffle(makeDeck());

  /** @type {HandSeat[]} */
  const seats = sorted.map((p) => ({
    seat: p.seat,
    userId: p.userId ?? null,
    nickname: p.nickname ?? `seat_${p.seat}`,
    startingChips: p.chips,
    chips: p.chips,
    holeCards: [],
    betThisStreet: 0,
    totalCommitted: 0,
    folded: false,
    allIn: false,
    sittingOut: false,
    hasActedThisStreet: false,
  }));

  // 盲注座位
  const sbSeat = n === 2 ? buttonSeat : nextOccupied(seats, buttonSeat);
  const bbSeat = nextOccupied(seats, sbSeat);

  postBlind(seats, sbSeat, smallBlind);
  postBlind(seats, bbSeat, bigBlind);

  // 发两张手牌：从 SB 起，绕两圈
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < n; i++) {
      const idx = (sbSeat + i) % n;
      seats[idx].holeCards.push(deck.shift());
    }
  }

  const state = {
    handId,
    street: Street.PREFLOP,
    deck,
    board: [],
    buttonSeat,
    smallBlind,
    bigBlind,
    seats,
    currentTurnSeat: null,
    lastAggressorSeat: bbSeat,
    currentBet: bigBlind,
    minRaise: bigBlind,
    version: 1,
    settled: false,
    result: null,
    actionLog: [],
  };

  // 检查是否直接进摊牌：所有人都 all-in 或只剩一个人能下注
  const canBetCount = state.seats.filter(
    (s) => !s.folded && !s.allIn && s.chips > 0,
  ).length;

  if (canBetCount < 2) {
    while (state.board.length < 5) state.board.push(state.deck.shift());
    const alive = state.seats.filter((s) => !s.folded);
    return settle(state, alive.length === 1 ? alive[0].seat : null);
  }

  // 翻前第一个行动者
  const order = preflopOrder(buttonSeat, n);
  state.currentTurnSeat = firstAliveIn(order, state);

  return { state, events: [] };
}

/**
 * 应用一个动作
 * @param {any} state
 * @param {number} seat
 * @param {{type:string,amount?:number}} action
 * @returns {{ state: any, events: any[] }}
 */
export function applyAction(state, seat, action) {
  if (state.settled) throw new Error('applyAction: hand already settled');
  if (state.currentTurnSeat !== seat) {
    throw new Error(ActionError.NOT_YOUR_TURN);
  }

  const { pay, isRaise, isAllIn } = validateAction(
    {
      bigBlind: state.bigBlind,
      minRaise: state.minRaise,
      currentBet: state.currentBet,
      currentTurnSeat: state.currentTurnSeat,
      seats: state.seats,
    },
    seat,
    action,
  );

  const next = cloneState(state);
  const ns = next.seats.find((x) => x.seat === seat);

  ns.chips -= pay;
  ns.betThisStreet += pay;
  ns.totalCommitted += pay;
  ns.hasActedThisStreet = true;
  if (action.type === 'fold') ns.folded = true;
  if (ns.chips === 0 || isAllIn) ns.allIn = true;

  // 更新 currentBet / minRaise
  if (ns.betThisStreet > next.currentBet) {
    const raiseSize = ns.betThisStreet - next.currentBet;
    if (raiseSize >= next.minRaise) {
      next.minRaise = raiseSize;
      for (const x of next.seats) {
        if (x.seat !== seat) x.hasActedThisStreet = false;
      }
    }
    next.currentBet = ns.betThisStreet;
    next.lastAggressorSeat = seat;
  }

  next.actionLog.push({ seat, action, pay, isRaise });
  next.version += 1;

  // 只剩一个未弃牌
  const alive = next.seats.filter((s) => !s.folded);
  if (alive.length === 1) {
    return settle(next, alive[0].seat);
  }

  // 找下一个行动者
  const nextSeat = findNextToAct(next, seat);
  if (nextSeat == null) {
    return advanceStreet(next);
  }
  next.currentTurnSeat = nextSeat;

  return {
    state: next,
    events: [
      { type: 'action', seat, action, pay, isRaise },
      { type: 'turn', seat: nextSeat },
    ],
  };
}

/**
 * 生成客户端可见快照（隐藏其他人的手牌）
 * @param {any} state
 * @param {number|null} forSeat
 */
export function toSnapshot(state, forSeat = null) {
  const pot = totalPot(
    state.seats.map((s) => ({ seat: s.seat, amount: s.totalCommitted, folded: false })),
  );
  return {
    handId: state.handId,
    street: state.street,
    board: [...state.board],
    buttonSeat: state.buttonSeat,
    smallBlind: state.smallBlind,
    bigBlind: state.bigBlind,
    seats: state.seats.map((s) => ({
      seat: s.seat,
      userId: s.userId,
      nickname: s.nickname,
      chips: s.chips,
      betThisStreet: s.betThisStreet,
      totalCommitted: s.totalCommitted,
      folded: s.folded,
      allIn: s.allIn,
      sittingOut: s.sittingOut,
      holeCards: s.seat === forSeat ? [...s.holeCards] : [],
    })),
    currentTurnSeat: state.currentTurnSeat,
    currentBet: state.currentBet,
    minRaise: state.minRaise,
    pot,
    version: state.version,
    settled: state.settled,
    result: state.result,
  };
}

// ---------- 内部函数 ----------

function cloneState(state) {
  return {
    ...state,
    deck: [...state.deck],
    board: [...state.board],
    seats: state.seats.map((s) => ({ ...s, holeCards: [...s.holeCards] })),
    actionLog: state.actionLog.map((a) => ({ ...a })),
  };
}

function postBlind(seats, seat, amount) {
  const s = seats[seat];
  const pay = Math.min(amount, s.chips);
  s.chips -= pay;
  s.betThisStreet += pay;
  s.totalCommitted += pay;
  if (s.chips === 0) s.allIn = true;
}

function nextOccupied(seats, fromSeat) {
  const n = seats.length;
  for (let i = 1; i <= n; i++) {
    const idx = (fromSeat + i) % n;
    if (!seats[idx].sittingOut) return idx;
  }
  return fromSeat;
}

function firstAliveIn(order, state) {
  for (const seat of order) {
    const s = state.seats[seat];
    if (!s) continue;
    if (s.folded || s.allIn || s.sittingOut || s.chips <= 0) continue;
    return seat;
  }
  return null;
}

function findNextToAct(state, fromSeat) {
  const n = state.seats.length;
  if (n === 0) return null;
  for (let i = 1; i <= n; i++) {
    const idx = (fromSeat + i) % n;
    const s = state.seats[idx];
    if (s.folded || s.allIn || s.sittingOut || s.chips <= 0) continue;
    if (!s.hasActedThisStreet || s.betThisStreet < state.currentBet) return s.seat;
  }
  return null;
}

function advanceStreet(state) {
  // 重置本街
  for (const s of state.seats) {
    s.betThisStreet = 0;
    s.hasActedThisStreet = false;
  }
  state.currentBet = 0;
  state.minRaise = state.bigBlind;

  const idx = STREETS.indexOf(state.street);
  if (idx < 0 || idx >= STREETS.length - 1) {
    return settle(state, null);
  }

  const next = STREETS[idx + 1];
  state.street = next;
  const toDraw = next === 'FLOP' ? 3 : 1;
  for (let i = 0; i < toDraw; i++) state.board.push(state.deck.shift());
  state.version += 1;

  // 检查是否还有至少两人能下注
  const canBetCount = state.seats.filter(
    (s) => !s.folded && !s.allIn && s.chips > 0,
  ).length;
  if (canBetCount < 2) {
    // 直接把剩余公共牌发完
    return advanceStreet(state);
  }

  const order = postflopOrder(state.buttonSeat, state.seats.length);
  state.currentTurnSeat = firstAliveIn(order, state);

  return {
    state,
    events: [{ type: 'street', street: state.street, board: [...state.board] }],
  };
}

function settle(state, forcedWinnerSeat) {
  state.street = Street.SETTLED;
  state.settled = true;
  state.currentTurnSeat = null;
  state.version += 1;

  const contributions = state.seats.map((s) => ({
    seat: s.seat,
    amount: s.totalCommitted,
    folded: s.folded,
  }));
  const pots = buildPots(contributions);

  /** @type {Map<number, number>} */
  const payouts = new Map();
  const addPayout = (seat, amt) => {
    if (amt <= 0) return;
    payouts.set(seat, (payouts.get(seat) ?? 0) + amt);
  };

  if (forcedWinnerSeat != null) {
    for (const pot of pots) {
      addPayout(forcedWinnerSeat, pot.amount);
    }
  } else {
    const strength = new Map();
    for (const s of state.seats) {
      if (s.folded) continue;
      const cards = [...s.holeCards, ...state.board];
      const hv = evaluate7(cards);
      strength.set(s.seat, handValueToStrength(hv));
    }
    const w = awardPots(pots, strength);
    for (const [seat, amt] of w.entries()) addPayout(seat, amt);
  }

  for (const [seat, amt] of payouts.entries()) {
    const s = state.seats.find((x) => x.seat === seat);
    if (s) s.chips += amt;
  }

  const revealed = {};
  if (forcedWinnerSeat == null) {
    for (const s of state.seats) {
      if (!s.folded) revealed[s.seat] = [...s.holeCards];
    }
  }

  state.result = {
    pots,
    payouts: Object.fromEntries(payouts),
    revealed,
    forcedWinnerSeat,
  };

  return {
    state,
    events: [{ type: 'settled', result: state.result }],
  };
}

function handValueToStrength(hv) {
  let n = hv.category;
  for (let i = 0; i < hv.tiebreakers.length; i++) {
    n = n * 100 + hv.tiebreakers[i];
  }
  return n;
}