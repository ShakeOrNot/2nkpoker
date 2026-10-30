/**
 * 离线对手引擎：一个实现了 socket.io 最小接口的假 socket。
 *
 * 用途：
 *   1. 后端跑不起来时也能完整演练 UI（登录 → 建房 → 等待室 → 牌桌 → 结算）
 *   2. 给"牌局已开始，需要等待"这条路径一个可复现的演示入口
 *
 * 它只实现本前端用到的方法：on / off / emit / close / disconnect，
 * 事件名与载荷与服务端完全一致，所以 store 层不需要任何特殊分支。
 */

import { MAX_SEATS } from '../core/constants.js';
import {
  buildPots,
  awardPots,
  strengthOf,
  validateBetAmount,
  toCallAmount,
  maxBetTarget,
  makeRoomId,
} from '../core/logic.js';

const SUITS = ['s', 'h', 'd', 'c'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const RANK_VALUE = Object.fromEntries(RANKS.map((r, i) => [r, i + 2]));
const BOT_NAMES = ['阿豪', '小美', '老张', 'Kiki', '大熊', '阿杰', 'Nana', '老王', '豆豆'];

const STREETS = ['PREFLOP', 'FLOP', 'TURN', 'RIVER'];

/** 事件名 → store 的 handler 名（与 net/socket.js 的 EVENT_MAP 保持一致） */
const HANDLER_BY_EVENT = {
  'table:snapshot': 'onSnapshot',
  'hand:start': 'onHandStart',
  'game:action_request': 'onActionRequest',
  'game:action_applied': 'onActionApplied',
  'game:result': 'onResult',
  error: 'onServerError',
};

/**
 * @returns {string[]} 洗好的 52 张
 */
function newDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(`${r}${s}`);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 本地一手牌：规则与服务端 state-machine.js 保持一致
 */
class LocalHand {
  /**
   * @param {{ handId: string, buttonSeat: number, smallBlind: number, bigBlind: number, players: Array<any> }} input
   */
  constructor(input) {
    this.handId = input.handId;
    this.smallBlind = input.smallBlind;
    this.bigBlind = input.bigBlind;
    this.buttonSeat = input.buttonSeat;
    this.ante = input.ante ?? 0;
    this.deck = newDeck();
    this.board = [];
    this.street = 'PREFLOP';
    this.settled = false;
    this.result = null;
    this.version = 1;
    this.currentBet = input.bigBlind;
    this.minRaise = input.bigBlind;
    this.actionLog = [];

    const sorted = [...input.players].sort((a, b) => a.seat - b.seat);
    this.seats = sorted.map((p) => ({
      seat: p.seat,
      userId: p.userId,
      nickname: p.nickname,
      chips: p.chips,
      holeCards: [],
      betThisStreet: 0,
      totalCommitted: 0,
      folded: false,
      allIn: false,
      hasActedThisStreet: false,
    }));
    this.n = this.seats.length;

    /* 座位号 ↔ 下标分离：this.seats 是按座位号排序的参局者数组，
       内部环形计算（盲注/发牌/行动顺序）一律用下标，
       对外（currentTurnSeat/lastAggressor）一律用座位号。
       之前的实现拿座位号当数组下标，座位不连续时（如 0/2/5）
       盲注扣错人、行动顺序错乱、轮到的人亮错灯。 */
    this.idxOfSeat = (seat) => {
      const idx = this.seats.findIndex((s) => s.seat === seat);
      return idx >= 0 ? idx : 0;
    };
    this.seatOfIdx = (idx) => (idx == null ? null : this.seats[idx].seat);

    const buttonIdx = this.idxOfSeat(this.buttonSeat);
    const sbIdx = this.n === 2 ? buttonIdx : this.nextSeat(buttonIdx);
    const bbIdx = this.nextSeat(sbIdx);
    this.postBlind(sbIdx, this.smallBlind);
    this.postBlind(bbIdx, this.bigBlind);
    if (this.ante > 0) this.postAnte(this.ante);

    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < this.n; i++) {
        const idx = (sbIdx + i) % this.n;
        this.seats[idx].holeCards.push(this.deck.shift());
      }
    }
    this.lastAggressor = this.seats[bbIdx].seat;
    // 翻前第一个行动者：BB 的下一位（heads-up 即按钮位/SB）
    this.currentTurnSeat = this.seatOfIdx(this.firstAbleFrom((bbIdx + 1) % this.n));
  }

  /**
   * @param {number} seat
   */
  postBlind(seat, amount) {
    const s = this.seats[seat];
    const pay = Math.min(amount, s.chips);
    s.chips -= pay;
    s.betThisStreet += pay;
    s.totalCommitted += pay;
    if (s.chips === 0) s.allIn = true;
  }

  /** 前注：每个人都要交，但不算本街下注 */
  postAnte(amount) {
    for (const s of this.seats) {
      const pay = Math.min(amount, s.chips);
      s.chips -= pay;
      s.totalCommitted += pay;
      if (s.chips === 0) s.allIn = true;
    }
  }

  /**
   * @param {number} from
   * @returns {number}
   */
  nextSeat(from) {
    return (from + 1) % this.n;
  }

  /**
   * 从 from 下标起，找到第一个还能行动的参局者下标
   * @param {number} from
   * @returns {number|null}
   */
  firstAbleFrom(from) {
    for (let i = 0; i < this.n; i++) {
      const idx = (from + i) % this.n;
      const s = this.seats[idx];
      if (!s.folded && !s.allIn && s.chips > 0) return idx;
    }
    return null;
  }

  /**
   * 从 from 下标的下一位起找下一个要行动的人（下标）
   * @param {number} from
   * @returns {number|null}
   */
  nextToActIdx(from) {
    for (let i = 1; i <= this.n; i++) {
      const idx = (from + i) % this.n;
      const s = this.seats[idx];
      if (s.folded || s.allIn || s.chips <= 0) continue;
      if (!s.hasActedThisStreet || s.betThisStreet < this.currentBet) return idx;
    }
    return null;
  }

  /**
   * @returns {number}
   */
  potTotal() {
    return this.seats.reduce((sum, s) => sum + s.totalCommitted, 0);
  }

  /**
   * 对外快照（隐藏别人手牌）
   * @param {number|null} forSeat
   */
  snapshot(forSeat) {
    return {
      handId: this.handId,
      street: this.street,
      board: [...this.board],
      buttonSeat: this.buttonSeat,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      ante: this.ante,
      seats: this.seats.map((s) => ({
        seat: s.seat,
        userId: s.userId,
        nickname: s.nickname,
        chips: s.chips,
        betThisStreet: s.betThisStreet,
        totalCommitted: s.totalCommitted,
        folded: s.folded,
        allIn: s.allIn,
        sittingOut: false,
        holeCards: s.seat === forSeat ? [...s.holeCards] : [],
      })),
      currentTurnSeat: this.currentTurnSeat,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      pot: this.potTotal(),
      version: this.version,
      settled: this.settled,
      result: this.result,
    };
  }

  /**
   * 执行动作（seat 为真实座位号；内部按下标定位）
   * @param {number} seat
   * @param {{type: string, amount?: number}} action
   * @returns {{ ok: boolean, code?: string, events: any[] }}
   */
  act(seat, action) {
    if (this.settled) return { ok: false, code: 'HAND_NOT_ACTIVE', events: [] };
    if (this.currentTurnSeat !== seat) return { ok: false, code: 'NOT_YOUR_TURN', events: [] };
    const idx = this.idxOfSeat(seat);
    const me = this.seats[idx];
    if (!me || me.folded || me.allIn) return { ok: false, code: 'INVALID_ACTION', events: [] };

    const toCall = toCallAmount(this.snapshot(null), seat);
    const maxTarget = maxBetTarget(this.snapshot(null), seat);
    let pay = 0;
    let isRaise = false;

    switch (action.type) {
      case 'fold':
        me.folded = true;
        break;
      case 'check':
        if (toCall !== 0) return { ok: false, code: 'INVALID_ACTION', events: [] };
        break;
      case 'call':
        if (toCall === 0) return { ok: false, code: 'INVALID_ACTION', events: [] };
        pay = Math.min(toCall, me.chips);
        break;
      case 'bet':
      case 'raise': {
        const check = validateBetAmount(this.snapshot(null), seat, action.amount ?? 0);
        if (!check.ok) return { ok: false, code: check.code ?? 'INVALID_ACTION', events: [] };
        pay = check.clamped - me.betThisStreet;
        isRaise = true;
        break;
      }
      case 'all_in':
        pay = me.chips;
        isRaise = me.betThisStreet + pay > this.currentBet;
        break;
      default:
        return { ok: false, code: 'INVALID_ACTION', events: [] };
    }

    if (pay > me.chips) return { ok: false, code: 'INSUFFICIENT_CHIPS', events: [] };
    me.chips -= pay;
    me.betThisStreet += pay;
    me.totalCommitted += pay;
    me.hasActedThisStreet = true;
    if (me.chips === 0) me.allIn = true;
    void maxTarget;

    if (me.betThisStreet > this.currentBet) {
      const raiseSize = me.betThisStreet - this.currentBet;
      if (raiseSize >= this.minRaise) {
        this.minRaise = raiseSize;
        for (const s of this.seats) if (s.seat !== seat) s.hasActedThisStreet = false;
      }
      this.currentBet = me.betThisStreet;
      this.lastAggressor = seat;
    }
    this.version += 1;
    this.actionLog.push({ seat, action, pay });

    const events = [{ type: 'action', seat, action, pay, isRaise, handId: this.handId }];

    const alive = this.seats.filter((s) => !s.folded);
    if (alive.length === 1) {
      this.settle(alive[0].seat);
      events.push({ type: 'settled' });
      return { ok: true, events };
    }

    const nextIdx = this.nextToActIdx(idx);
    if (nextIdx == null) {
      const advanced = this.advanceStreet();
      events.push(...advanced);
    } else {
      this.currentTurnSeat = this.seatOfIdx(nextIdx);
      events.push({ type: 'turn', seat: this.currentTurnSeat });
    }
    return { ok: true, events };
  }

  /**
   * @returns {any[]} 事件
   */
  advanceStreet() {
    for (const s of this.seats) {
      s.betThisStreet = 0;
      s.hasActedThisStreet = false;
    }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;

    const idx = STREETS.indexOf(this.street);
    if (idx < 0 || idx >= STREETS.length - 1) {
      this.settle(null);
      return [{ type: 'settled' }];
    }
    const next = STREETS[idx + 1];
    this.street = next;
    const draw = next === 'FLOP' ? 3 : 1;
    for (let i = 0; i < draw; i++) this.board.push(this.deck.shift());
    this.version += 1;

    const ableToBet = this.seats.filter((s) => !s.folded && !s.allIn && s.chips > 0).length;
    if (ableToBet < 2) {
      // 都 all-in 了：直接发完剩余公共牌
      return [{ type: 'street', street: next, board: [...this.board] }, ...this.advanceStreet()];
    }

    const buttonIdx = this.idxOfSeat(this.buttonSeat);
    const start = this.street === 'PREFLOP' ? buttonIdx : this.nextSeat(buttonIdx);
    this.currentTurnSeat = this.seatOfIdx(this.firstAbleFrom(start));
    return [{ type: 'street', street: next, board: [...this.board] }];
  }

  /**
   * @param {number|null} forcedWinnerSeat
   */
  settle(forcedWinnerSeat) {
    this.settled = true;
    this.street = 'SETTLED';
    this.currentTurnSeat = null;
    this.version += 1;

    const pots = buildPots(
      this.seats.map((s) => ({ seat: s.seat, amount: s.totalCommitted, folded: s.folded })),
    );

    /** @type {Map<number, number>} */
    const payouts = new Map();
    const add = (seat, amount) => {
      if (amount > 0) payouts.set(seat, (payouts.get(seat) ?? 0) + amount);
    };

    if (forcedWinnerSeat != null) {
      for (const pot of pots) add(forcedWinnerSeat, pot.amount);
    } else {
      const strength = new Map();
      for (const s of this.seats) {
        if (s.folded) continue;
        strength.set(s.seat, strengthOf(s.holeCards, this.board));
      }
      for (const [seat, amount] of awardPots(pots, strength)) add(seat, amount);
    }

    for (const [seat, amount] of payouts) {
      const s = this.seats.find((x) => x.seat === seat);
      if (s) s.chips += amount;
    }

    const revealed = {};
    if (forcedWinnerSeat == null) {
      for (const s of this.seats) if (!s.folded) revealed[s.seat] = [...s.holeCards];
    }

    this.result = {
      pots,
      payouts: Object.fromEntries(payouts),
      revealed,
      forcedWinnerSeat,
    };
  }

  /**
   * 机器人决策（移植自成熟单机版的 AI）：
   *   翻前按起手牌力评分，翻后按 7 张评估的牌型 + 同花/顺子听牌加成，
   *   结合底池赔率决定弃/跟/加；加注量随底池定量。
   * @param {number} seat
   * @returns {{type: string, amount?: number}}
   */
  botAction(seat) {
    const snap = this.snapshot(null);
    const me = this.seats.find((s) => s.seat === seat);
    const toCall = toCallAmount(snap, seat);
    const maxTarget = maxBetTarget(snap, seat);
    const canRaise = maxTarget > (snap.currentBet ?? 0);
    const s = this.botStrength(me) + (Math.random() * 0.12 - 0.06);
    const pot = snap.pot ?? 0;
    const bb = snap.bigBlind ?? 20;

    /** @param {number} fraction */
    const raiseTo = (fraction) => {
      const currentBet = snap.currentBet ?? 0;
      const myBet = me.betThisStreet ?? 0;
      const minTarget = currentBet > 0 ? currentBet + (snap.minRaise ?? bb) : bb;
      let to = currentBet > 0
        ? Math.round(currentBet + fraction * (pot + 2 * Math.max(0, currentBet - myBet)))
        : Math.max(Math.round(fraction * pot), bb);
      to = Math.max(to, minTarget);
      return Math.min(to, maxTarget);
    };

    if (toCall === 0) {
      const verb = (snap.currentBet ?? 0) > 0 ? 'raise' : 'bet';
      if (canRaise && s > 0.82) return { type: verb, amount: raiseTo(0.6) };
      if (canRaise && s > 0.46 && Math.random() < 0.22) return { type: verb, amount: raiseTo(0.45) };
      return { type: 'check' };
    }

    const potOdds = toCall / (pot + toCall);
    let callThresh = potOdds + 0.06;
    if (toCall >= (me.chips ?? 0) * 0.5) callThresh += 0.18;

    if (canRaise && s > 0.9) return { type: 'raise', amount: raiseTo(0.7) };
    if (s > callThresh) return { type: 'call' };
    if (canRaise && (this.board?.length ?? 0) >= 3 && Math.random() < 0.05 && toCall <= (me.chips ?? 0) * 0.25) {
      return { type: 'raise', amount: raiseTo(0.5) };
    }
    return { type: 'fold' };
  }

  /**
   * 机器人对当前手牌的实力评分（0.05~0.99，越高越强）
   * @param {any} me 本座位的手牌数据
   * @returns {number}
   */
  botStrength(me) {
    const hole = me.holeCards ?? [];
    const board = this.board ?? [];

    if (!board.length) {
      /* 翻前：高对 > 大张 > 对子 > 同花连张，弱牌压分 */
      const ranks = hole.map((c) => RANK_VALUE[c[0]] ?? 2).sort((a, b) => b - a);
      const high = ranks[0] ?? 2;
      const low = ranks[1] ?? 2;
      const suited = hole[0]?.[1] === hole[1]?.[1];
      let s = 0.25 + ((high - 2) / 12) * 0.45;
      if (high === low) s += 0.22 + ((high - 2) / 12) * 0.18;
      else if (suited) s += 0.06;
      if (high - low <= 2) s += 0.06;
      if (high >= 13) s += 0.05;
      if (high <= 9 && low <= 7 && high !== low) s -= 0.08;
      return Math.max(0.08, Math.min(0.97, s));
    }

    /* 翻后：7 张评估的牌型类别映射 */
    const strength = strengthOf(hole, board);
    const cat = Math.floor(strength / 100 ** 5) || 0;
    let s;
    if (cat >= 8) s = 0.99;
    else if (cat === 7) s = 0.98;
    else if (cat === 6) s = 0.95;
    else if (cat === 5) s = 0.89;
    else if (cat === 4) s = 0.85;
    else if (cat === 3) s = 0.86;
    else if (cat === 2) s = 0.76;
    else if (cat === 1) s = 0.48 + ((Math.floor(strength / 100 ** 4) % 100) / 14) * 0.22;
    else s = 0.18 + ((Math.floor(strength / 100 ** 4) % 100) / 14) * 0.25;

    /* 同花听牌 / 顺子听牌小加成 */
    const all = [...hole, ...board];
    const suits = {};
    for (const c of all) suits[c[1]] = (suits[c[1]] ?? 0) + 1;
    if (Object.values(suits).some((n) => n >= 4)) s += 0.08;
    const rs = [...new Set(all.map((c) => RANK_VALUE[c[0]] ?? 0))].sort((a, b) => a - b);
    for (let i = 0; i < rs.length; i++) {
      let run = 1;
      while (i + run < rs.length && rs[i + run] - rs[i] === run) run++;
      if (run >= 4) { s += 0.06; break; }
    }
    return Math.max(0.05, Math.min(0.99, s));
  }
}

/**
 * 一张离线牌桌
 */
class LocalTable {
  /**
   * @param {{ tableId: string, smallBlind?: number, bigBlind?: number, maxSeats?: number, buyIn?: number }} cfg
   */
  constructor(cfg) {
    this.tableId = cfg.tableId;
    this.smallBlind = cfg.smallBlind ?? 10;
    this.bigBlind = cfg.bigBlind ?? 20;
    this.maxSeats = Math.min(MAX_SEATS, cfg.maxSeats ?? 6);
    this.ante = cfg.ante ?? 5;
    this.buyIn = cfg.buyIn ?? 2000;
    this.version = 0;
    this.buttonSeat = Math.floor(Math.random() * this.maxSeats);
    /** @type {Map<number, any>} */
    this.seats = new Map();
    /** @type {LocalHand|null} */
    this.hand = null;
    this.botTimer = null;
  }

  /**
   * 补机器人：保证"真人 + 机器人"不少于 minPlayers，同时永远留一个空位给真人
   * @param {number} minPlayers
   */
  fillBots(minPlayers = 2) {
    const target = Math.min(Math.max(minPlayers, 2), this.maxSeats);
    const occupied = this.seats.size;
    if (occupied >= target) return;
    const names = shuffle(BOT_NAMES);
    let i = 0;
    for (let seat = 0; seat < this.maxSeats && this.seats.size < target; seat++) {
      if (this.seats.has(seat)) continue;
      this.seats.set(seat, {
        seat,
        userId: `bot_${seat}`,
        nickname: names[i++ % names.length],
        chips: this.buyIn,
        ready: true,
        connected: true,
        isBot: true,
      });
    }
  }

  snapshotFor(forSeat) {
    const seats = [];
    for (let i = 0; i < this.maxSeats; i++) {
      const s = this.seats.get(i);
      seats.push(
        s
          ? { seat: s.seat, userId: s.userId, nickname: s.nickname, chips: s.chips, ready: s.ready, connected: s.connected, leaving: Boolean(s.leaving) }
          : { seat: i, userId: null, nickname: '', chips: 0, ready: false, connected: false, leaving: false },
      );
    }
    return {
      tableId: this.tableId,
      version: this.version,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      ante: this.ante,
      buttonSeat: this.buttonSeat,
      maxSeats: this.maxSeats,
      seats,
      hand: this.hand ? this.hand.snapshot(forSeat) : null,
    };
  }
}

export class MockGameSocket {
  /**
   * @param {{ tableId?: string, smallBlind?: number, bigBlind?: number, maxSeats?: number, buyIn?: number }} [cfg]
   */
  constructor(cfg = {}) {
    this.cfg = {
      tableId: cfg.tableId ?? 'practice',
      smallBlind: cfg.smallBlind ?? 10,
      bigBlind: cfg.bigBlind ?? 20,
      maxSeats: cfg.maxSeats ?? 6,
      buyIn: cfg.buyIn ?? 2000,
    };
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
    /** 与 GameSocket 一致的回调表：store 会调 setHandlers 注册 */
    this.handlers = {};
    /** @type {LocalTable|null} */
    this.table = null;
    this.userId = '';
    this.mySeat = null;
    this.connected = false;
    this.disconnectReason = '';
  }

  /* --- socket.io 兼容接口 --- */

  /**
   * 与 GameSocket.setHandlers 同名：store 用它注册事件回调
   * @param {Record<string, Function>} handlers
   */
  setHandlers(handlers) {
    this.handlers = { ...this.handlers, ...handlers };
  }

  /**
   * 调用 store 注册的回调（同时兼容 on(...) 订阅）
   * @param {string} name
   * @param {any} payload
   */
  notify(name, payload) {
    const fn = this.handlers?.[name];
    if (typeof fn === 'function') {
      try {
        fn(payload);
      } catch (err) {
        console.error('[mock] handler error', name, err);
      }
    }
  }

  /**
   * @param {string} event
   * @param {Function} fn
   */
  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)?.add(fn);
    return this;
  }

  /**
   * @param {string} event
   * @param {Function} fn
   */
  off(event, fn) {
    if (fn) this.listeners.get(event)?.delete(fn);
    else this.listeners.delete(event);
    return this;
  }

  removeAllListeners() {
    this.listeners.clear();
    return this;
  }

  /**
   * @param {string} event
   * @param {...any} args
   */
  emit(event, ...args) {
    if (event === 'connect') {
      this.connected = true;
      this.fire('connect');
      return;
    }
    const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    const payload = args[0];
    const result = this.handle(event, payload);
    if (ack) setTimeout(() => ack(result), 30);
  }

  /**
   * 与 GameSocket.request 同名同语义：发请求并等 ack。
   * store 层只认这一个方法，所以离线模式必须实现它。
   * @param {string} event
   * @param {any} payload
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{ ok: boolean, code?: string, [k: string]: any }>}
   */
  request(event, payload, options = {}) {
    const timeoutMs = options.timeoutMs ?? 8000;
    if (!this.connected) return Promise.resolve({ ok: false, code: 'NOT_CONNECTED' });
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, code: 'NETWORK', message: '本地引擎没有响应（超时）' });
      }, timeoutMs);
      const done = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res ?? { ok: false, code: 'INTERNAL_ERROR', message: '空响应' });
      };
      try {
        this.emit(event, payload, done);
      } catch (err) {
        done({ ok: false, code: 'INTERNAL_ERROR', message: String(err?.message ?? err) });
      }
    });
  }

  close() {
    this.stopBot();
    this.connected = false;
  }

  /** 与 GameSocket 对齐：socket.io 客户端也有 disconnect() */
  disconnect() {
    this.close();
  }

  disconnect() {
    this.close();
  }

  /* --- 内部 --- */

  /**
   * 触发事件：on(...) 订阅者 + store 注册的 handler 都会收到
   * @param {string} event
   * @param {any} [payload]
   */
  fire(event, payload) {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        fn(payload);
      } catch (err) {
        console.error('[mock] listener error', event, err);
      }
    }
    const handlerName = HANDLER_BY_EVENT[event];
    if (handlerName) this.notify(handlerName, payload);
  }

  /**
   * @param {string} event
   * @param {any} payload
   * @returns {{ ok: boolean, code?: string, [k: string]: any }}
   */
  handle(event, payload) {
    const t = this.table ?? (this.table = new LocalTable({ ...this.cfg, tableId: payload?.tableId ?? this.cfg.tableId }));
    if (payload?.tableId && t.tableId !== payload.tableId) {
      t.tableId = payload.tableId;
    }

    switch (event) {
      case 'table:join': {
        const existing = this.mySeat != null ? t.seats.get(this.mySeat) : null;
        if (existing && existing.userId === this.userId) {
          this.broadcast();
          return { ok: true, restored: true, seat: this.mySeat };
        }
        t.fillBots(3);
        this.broadcast();
        return { ok: true };
      }

      case 'table:sit': {
        // 已在座 → 换座（与服务端一致：不用先离座，筹码不变、ready 重置）
        if (this.mySeat != null && t.seats.get(this.mySeat)?.userId === this.userId) {
          if (t.hand && !t.hand.settled) {
            return { ok: false, code: 'HAND_IN_PROGRESS', message: '牌局进行中，本手结束后才能换座' };
          }
          const target = Number.isInteger(payload?.seat) && payload.seat >= 0 ? payload.seat : this.mySeat;
          if (target === this.mySeat) return { ok: true, seat: this.mySeat, unchanged: true };
          if (target < 0 || target >= t.maxSeats) return { ok: false, code: 'SEAT_INVALID' };
          if (t.seats.has(target)) return { ok: false, code: 'SEAT_TAKEN' };

          const mine = t.seats.get(this.mySeat);
          t.seats.delete(this.mySeat);
          mine.seat = target;
          mine.ready = false;
          delete mine.leaving;
          t.seats.set(target, mine);
          this.mySeat = target;
          t.version += 1;
          this.broadcast();
          return { ok: true, seat: target, moved: true };
        }

        const seat = Number.isInteger(payload?.seat) && payload.seat >= 0 ? payload.seat : this.firstFreeSeat();
        if (seat == null || seat < 0 || seat >= t.maxSeats) return { ok: false, code: 'SEAT_INVALID' };
        if (t.seats.has(seat) && t.seats.get(seat)?.userId !== this.userId) return { ok: false, code: 'SEAT_TAKEN' };
        if (t.hand && !t.hand.settled) return { ok: false, code: 'HAND_IN_PROGRESS' };

        t.seats.set(seat, {
          seat,
          userId: this.userId,
          nickname: this.nickname ?? this.userId,
          chips: payload?.buyIn ?? t.buyIn,
          ready: false,
          connected: true,
          isBot: false,
        });
        this.mySeat = seat;
        t.version += 1;
        this.broadcast();
        return { ok: true, seat };
      }

      case 'table:stand': {
        if (this.mySeat == null) return { ok: false, code: 'NOT_SEATED' };
        const mine = t.seats.get(this.mySeat);

        // 手牌进行中：只标记"本手结束后离桌"，轮到自己就当场弃牌（与服务端一致）
        if (t.hand && !t.hand.settled) {
          if (mine) {
            mine.leaving = true;
            mine.ready = false;
          }
          if (t.hand.currentTurnSeat === this.mySeat) {
            const toCall = toCallAmount(t.hand.snapshot(null), this.mySeat);
            const out = t.hand.act(this.mySeat, toCall > 0 ? { type: 'fold' } : { type: 'check' });
            if (out.ok) this.applyEvents(t, out.events);
          }
          t.version += 1;
          this.broadcast();
          return { ok: true, pending: true, message: '本手结束后离桌' };
        }

        t.seats.delete(this.mySeat);
        this.mySeat = null;
        // 人都走了就别再排队开下一手了
        clearTimeout(t.nextHandTimer);
        t.nextHandTimer = null;
        t.version += 1;
        this.broadcast();
        return { ok: true };
      }

      case 'table:ready': {
        if (this.mySeat == null) return { ok: false, code: 'NOT_SEATED' };
        const s = t.seats.get(this.mySeat);
        if (s) s.ready = Boolean(payload?.ready);
        t.version += 1;
        this.broadcast();
        this.maybeStartHand();
        return { ok: true };
      }

      case 'game:action': {
        if (!t.hand || t.hand.settled) return { ok: false, code: 'HAND_NOT_ACTIVE' };
        if (payload?.handId && payload.handId !== t.hand.handId) return { ok: false, code: 'HAND_NOT_ACTIVE' };
        if (Number.isInteger(payload?.expectedVersion) && payload.expectedVersion !== t.hand.version) {
          return { ok: false, code: 'STATE_OUTDATED', message: `expected ${t.hand.version}` };
        }
        const seat = this.mySeat;
        if (seat == null) return { ok: false, code: 'NOT_SEATED' };
        const out = t.hand.act(seat, payload.action);
        if (!out.ok) return { ok: false, code: out.code };
        this.applyEvents(t, out.events);
        return { ok: true };
      }

      default:
        return { ok: false, code: 'INVALID_PAYLOAD', message: `mock 未实现 ${event}` };
    }
  }

  /**
   * @returns {number|null}
   */
  firstFreeSeat() {
    const t = this.table;
    if (!t) return 0;
    for (let i = 0; i < t.maxSeats; i++) if (!t.seats.has(i)) return i;
    return null;
  }

  /**
   * 有手牌就把事件按服务端语义广播出去
   * @param {LocalTable} t
   * @param {any[]} events
   * @param {{ timeout?: boolean }} [options]
   */
  applyEvents(t, events, options = {}) {
    for (const ev of events) {
      if (ev.type === 'action') {
        this.fire('game:action_applied', {
          seat: ev.seat,
          action: ev.action,
          handId: ev.handId,
          pay: ev.pay,
          timeout: Boolean(options.timeout),
        });
      }
    }
    if (t.hand?.settled) {
      // 结算：把最终筹码写回桌面座位（否则下一手还用着扣盲注前的旧筹码），
      // 并清掉"本手结束后离桌"的人
      for (const hs of t.hand.seats) {
        const s = t.seats.get(hs.seat);
        if (s) s.chips = hs.chips;
      }
      for (const [seat, s] of [...t.seats.entries()]) {
        if (!s.leaving) continue;
        t.seats.delete(seat);
        if (this.mySeat === seat) this.mySeat = null;
      }
      t.version += 1;
      this.broadcast();
      this.fire('game:result', {
        handId: t.hand.handId,
        result: t.hand.result,
        board: [...t.hand.board],
        // 结算框要用座位昵称/投入，这里一并发出去（服务端同样带 seats）
        seats: t.hand.seats.map((s) => ({
          seat: s.seat,
          userId: s.userId,
          nickname: s.nickname,
          chips: s.chips,
          betThisStreet: s.betThisStreet,
          totalCommitted: s.totalCommitted,
          folded: s.folded,
          allIn: s.allIn,
        })),
      });
      this.stopBot();
      // 结算后停一会儿再开下一手（与后端 SETTLE_HOLD_MS 一致），给结算框留时间
      clearTimeout(t.nextHandTimer);
      t.nextHandTimer = setTimeout(() => {
        t.nextHandTimer = null;
        this.maybeStartHand();
      }, 2500);
      return;
    }
    this.broadcast();
    if (t.hand?.currentTurnSeat != null) this.promptTurn(t);
  }

  /** 给每个人发各自的快照 */
  broadcast() {
    if (!this.table) return;
    this.fire('table:snapshot', this.table.snapshotFor(this.mySeat));
    void this.userId;
  }

  /**
   * 该谁行动：真人就发 action_request，机器人就排个定时器
   * @param {LocalTable} t
   */
  promptTurn(t) {
    const hand = t.hand;
    if (!hand || hand.settled) return;
    const seat = hand.currentTurnSeat;
    if (seat == null) return;
    const s = t.seats.get(seat);
    if (!s) return;

    if (seat === this.mySeat) {
      this.stopBot();
      // 已经点了"离桌"：别把牌局卡在自己身上，直接过牌/弃牌
      if (s.leaving) {
        const toCall = toCallAmount(hand.snapshot(null), seat);
        const out = hand.act(seat, toCall > 0 ? { type: 'fold' } : { type: 'check' });
        if (out.ok) this.applyEvents(t, out.events);
        return;
      }
      this.fire('game:action_request', {
        handId: hand.handId,
        seat,
        legalActions: this.legalActions(hand, seat),
        deadline: Date.now() + 30000,
        version: hand.version,
      });
      return;
    }

    this.stopBot();
    t.botTimer = setTimeout(() => {
      if (!t.hand || t.hand.settled || t.hand.currentTurnSeat !== seat) return;
      let action;
      try {
        action = t.hand.botAction(seat);
      } catch (err) {
        console.error('[mock] botAction failed', err);
        action = null;
      }
      const out = action ? t.hand.act(seat, action) : { ok: false };
      if (!out.ok) {
        // 兜底：动作不合法/决策异常就直接过牌/弃牌，绝不让牌局卡死
        const toCall = toCallAmount(t.hand.snapshot(null), seat);
        t.hand.act(seat, toCall > 0 ? { type: 'fold' } : { type: 'check' });
        this.broadcast();
        if (t.hand.currentTurnSeat != null) this.promptTurn(t);
        return;
      }
      this.applyEvents(t, out.events);
    }, 700 + Math.random() * 900);
  }

  stopBot() {
    if (this.table?.botTimer) {
      clearTimeout(this.table.botTimer);
      this.table.botTimer = null;
    }
  }

  /**
   * @param {LocalHand} hand
   * @param {number} seat
   * @returns {string[]}
   */
  legalActions(hand, seat) {
    const snap = hand.snapshot(null);
    const me = snap.seats.find((s) => s.seat === seat);
    if (!me) return [];
    const toCall = toCallAmount(snap, seat);
    const out = ['fold'];
    if (toCall === 0) out.push('check');
    if (toCall > 0) out.push('call');
    if (snap.currentBet === 0 && me.chips > 0) out.push('bet');
    if (snap.currentBet > 0 && me.chips > toCall) out.push('raise');
    if (me.chips > 0) out.push('all_in');
    return out;
  }

  /** 所有真人 ready 就开下一手（机器人视为永远准备，否则重进后永远凑不齐） */
  maybeStartHand() {
    const t = this.table;
    if (!t || (t.hand && !t.hand.settled)) return;
    if (t.seats.size < 2) return;
    // 真人离桌后就别自己开牌了（否则会变成一群机器人自娱自乐）
    if (![...t.seats.values()].some((s) => !s.isBot)) return;
    const allReady = [...t.seats.values()].every((s) => s.ready || s.isBot);
    if (!allReady) return;

    // 筹码见底的人自动补码（真人）或离座（机器人）
    for (const [seat, s] of [...t.seats.entries()]) {
      if (s.chips > 0) continue;
      if (s.isBot) t.seats.delete(seat);
      else s.chips = t.buyIn;
    }
    if (t.seats.size < 2) return;

    t.hand = new LocalHand({
      handId: `mock_${t.tableId}_${Date.now()}`,
      buttonSeat: t.buttonSeat % t.maxSeats,
      smallBlind: t.smallBlind,
      bigBlind: t.bigBlind,
      ante: t.ante,
      players: [...t.seats.values()].map((s) => ({
        seat: s.seat,
        userId: s.userId,
        nickname: s.nickname,
        chips: s.chips,
      })),
    });
    // 盲注与手牌已经扣在 LocalHand 里，同步回座位
    // 机器人保持 ready（下一手自动凑齐）；真人每手重新准备
    for (const hs of t.hand.seats) {
      const s = t.seats.get(hs.seat);
      if (s) {
        // 只同步筹码，**不重置 ready**：和后端一致，准备过一次就连续参与，
        // 否则离线模式打一手就得回等待室点准备（牌桌界面没有准备按钮）
        s.chips = hs.chips;
      }
    }
    // 按钮位轮转到下一个有人坐的座位（空位轮过去会让盲注位错乱）
    const seatsAsc = [...t.seats.keys()].sort((a, b) => a - b);
    const cur = seatsAsc.indexOf(t.buttonSeat % t.maxSeats);
    t.buttonSeat = seatsAsc[(cur + 1) % seatsAsc.length] ?? t.buttonSeat;
    t.version += 1;

    this.fire('hand:start', {
      handId: t.hand.handId,
      buttonSeat: t.hand.buttonSeat,
      smallBlind: t.hand.smallBlind,
      bigBlind: t.hand.bigBlind,
    });
    this.broadcast();
    this.promptTurn(t);
  }

  /**
   * 让真人有机会在离线模式下也能"准备好"
   * @param {string} userId
   * @param {string} nickname
   */
  identify(userId, nickname) {
    this.userId = userId;
    this.nickname = nickname;
  }
}

/**
 * 创建一个离线 socket（已连上）
 * @param {{ tableId?: string, userId: string, nickname: string, smallBlind?: number, bigBlind?: number, maxSeats?: number, buyIn?: number }} cfg
 * @returns {MockGameSocket}
 */
export function createMockSocket(cfg) {
  const socket = new MockGameSocket(cfg);
  socket.identify(cfg.userId, cfg.nickname);
  socket.connected = true;
  // 模仿 socket.io：连接后异步触发 connect
  setTimeout(() => socket.fire('connect'), 80);
  return socket;
}

export { makeRoomId };
