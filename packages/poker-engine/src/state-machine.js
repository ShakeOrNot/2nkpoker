import { makeDeck, shuffle } from './deck.js';
import { evaluate7 } from './evaluator.js';
import { buildPots, awardPots, totalPot } from './pot.js';
import { preflopOrder, postflopOrder, nextOccupiedSeat } from './positions.js';
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
 * @property {number} buttonSeat   必须是 players 里的某个真实座位；不合法时顺时针顺延
 * @property {number} smallBlind
 * @property {number} bigBlind
 * @property {Array<{seat:number,userId?:string,nickname?:string,chips:number}>} players
 *   座位号只需唯一（0 起），**不需要连续**——6 个固定座位里有人离座会留下空洞
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
    const p = sorted[i];
    // 座位号只要求"非负整数 + 不重复"，**不要求连续**：
    // 有人输光离座/主动换座后座位号会留下空洞，牌局必须能继续。
    if (!Number.isInteger(p.seat) || p.seat < 0) {
      throw new Error(`startHand: seat must be a non-negative integer, got ${p.seat}`);
    }
    if (i > 0 && sorted[i - 1].seat === p.seat) {
      throw new Error(`startHand: duplicate seat ${p.seat}`);
    }
    if (!(p.chips > 0)) {
      throw new Error(`startHand: seat ${p.seat} has 0 chips`);
    }
  }

  // 有人坐的真实座位，从小到大——后面所有"下一家"都沿这个环走
  const ring = sorted.map((p) => p.seat);
  // 按钮位必须落在一个真实座位上；否则顺时针顺延到下一个有人坐的座位
  const btnSeat = ring.includes(buttonSeat) ? buttonSeat : nextOccupiedSeat(ring, buttonSeat);

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

  // 盲注座位（单挑时按钮位就是 SB）
  const sbSeat = n === 2 ? btnSeat : nextOccupiedSeat(ring, btnSeat);
  const bbSeat = nextOccupiedSeat(ring, sbSeat);

  postBlind(seats, sbSeat, smallBlind);
  postBlind(seats, bbSeat, bigBlind);

  // 发两张手牌：从 SB 起，沿座位环绕两圈
  const dealOrder = rotateRing(ring, sbSeat);
  for (let round = 0; round < 2; round++) {
    for (const seat of dealOrder) {
      findSeat(seats, seat).holeCards.push(deck.shift());
    }
  }

  const state = {
    handId,
    street: Street.PREFLOP,
    deck,
    board: [],
    buttonSeat: btnSeat,
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
  const order = preflopOrder(btnSeat, n, ring);
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
  const s = findSeat(seats, seat);
  if (!s) throw new Error(`postBlind: seat ${seat} not found`);
  const pay = Math.min(amount, s.chips);
  s.chips -= pay;
  s.betThisStreet += pay;
  s.totalCommitted += pay;
  if (s.chips === 0) s.allIn = true;
}

/** 按座位号取座位（座位号可能不连续，不能用下标索引） */
function findSeat(seats, seat) {
  return seats.find((s) => s.seat === seat) ?? null;
}

/** 从环上的 startSeat 开始取一圈（座位号递增，绕回） */
function rotateRing(ring, startSeat) {
  const i = ring.indexOf(startSeat);
  if (i < 0) return [...ring];
  return [...ring.slice(i), ...ring.slice(0, i)];
}

function firstAliveIn(order, state) {
  for (const seat of order) {
    const s = findSeat(state.seats, seat);
    if (!s) continue;
    if (s.folded || s.allIn || s.sittingOut || s.chips <= 0) continue;
    return seat;
  }
  return null;
}

function findNextToAct(state, fromSeat) {
  const ring = state.seats.map((s) => s.seat);
  if (ring.length === 0) return null;
  const start = ring.indexOf(fromSeat);
  if (start < 0) return null;
  for (let i = 1; i <= ring.length; i++) {
    const s = findSeat(state.seats, ring[(start + i) % ring.length]);
    if (!s) continue;
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

  const order = postflopOrder(
    state.buttonSeat,
    state.seats.length,
    state.seats.map((s) => s.seat),
  );
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