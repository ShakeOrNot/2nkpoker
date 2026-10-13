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
  quickBets,
  toCallAmount,
  maxBetTarget,
  makeRoomId,
} from '../core/logic.js';

const SUITS = ['s', 'h', 'd', 'c'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
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

    const sbSeat = this.n === 2 ? this.buttonSeat : this.nextSeat(this.buttonSeat);
    const bbSeat = this.nextSeat(sbSeat);
    this.postBlind(sbSeat, this.smallBlind);
    this.postBlind(bbSeat, this.bigBlind);

    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < this.n; i++) {
        const idx = (sbSeat + i) % this.n;
        this.seats[idx].holeCards.push(this.deck.shift());
      }
    }
    this.lastAggressor = bbSeat;
    this.currentTurnSeat = this.firstToActPreflop();
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

  /**
   * @param {number} from
   * @returns {number}
   */
  nextSeat(from) {
    return (from + 1) % this.n;
  }

  /**
   * @returns {number|null}
   */
  firstToActPreflop() {
    if (this.n === 2) return this.buttonSeat;
    // UTG 起：BB 的下一位
    const bb = this.seats.findIndex((s) => s.betThisStreet === this.bigBlind);
    const start = bb >= 0 ? this.nextSeat(bb) : this.nextSeat(this.buttonSeat);
    return this.firstAbleFrom(start);
  }

  /**
   * @param {number} from
   * @returns {number|null}
   */
  firstAbleFrom(from) {
    for (let i = 0; i < this.n; i++) {
      const seat = (from + i) % this.n;
      const s = this.seats[seat];
      if (!s.folded && !s.allIn && s.chips > 0) return seat;
    }
    return null;
  }

  /**
   * @returns {number|null}
   */
  nextToAct(from) {
    for (let i = 1; i <= this.n; i++) {
      const seat = (from + i) % this.n;
      const s = this.seats[seat];
      if (s.folded || s.allIn || s.chips <= 0) continue;
      if (!s.hasActedThisStreet || s.betThisStreet < this.currentBet) return seat;
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
   * 执行动作，返回本步产生的事件
   * @param {number} seat
   * @param {{type: string, amount?: number}} action
   * @returns {{ ok: boolean, code?: string, events: any[] }}
   */
  act(seat, action) {
    if (this.settled) return { ok: false, code: 'HAND_NOT_ACTIVE', events: [] };
    if (this.currentTurnSeat !== seat) return { ok: false, code: 'NOT_YOUR_TURN', events: [] };
    const me = this.seats.find((s) => s.seat === seat);
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

    const next = this.nextToAct(seat);
    if (next == null) {
      const advanced = this.advanceStreet();
      events.push(...advanced);
    } else {
      this.currentTurnSeat = next;
      events.push({ type: 'turn', seat: next });
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

    const start = this.street === 'PREFLOP' ? this.buttonSeat : this.nextSeat(this.buttonSeat);
    this.currentTurnSeat = this.firstAbleFrom(start);
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
   * 机器人决策：便宜就看，牌力好就加注，偶尔诈唬
   * @param {number} seat
   * @returns {{type: string, amount?: number}}
   */
  botAction(seat) {
    const snap = this.snapshot(null);
    const me = this.seats.find((s) => s.seat === seat);
    const toCall = toCallAmount(snap, seat);
    const strength = strengthOf(me.holeCards, this.board);
    const category = Math.floor(strength / 100 ** 5) || 0;
    const aggression = Math.random();

    // 牌力很差又得掏钱 → 多数弃牌
    if (toCall > 0 && category <= 0 && aggression < 0.62) return { type: 'fold' };
    if (toCall === 0 && category >= 2 && aggression < 0.55) {
      const options = quickBets(snap, seat).filter((b) => b.kind === 'preset');
      if (options.length) {
        const pick = options[Math.min(options.length - 1, Math.floor(aggression * options.length))];
        return { type: this.currentBet === 0 ? 'bet' : 'raise', amount: pick.amount };
      }
      return { type: 'check' };
    }
    if (toCall > 0) {
      if (category >= 3 && aggression < 0.32) {
        const max = maxBetTarget(snap, seat);
        return { type: 'all_in', amount: max };
      }
      return { type: 'call' };
    }
    if (category >= 1 && aggression < 0.4) {
      const options = quickBets(snap, seat).filter((b) => b.kind === 'preset');
      if (options.length) {
        return { type: 'bet', amount: options[0].amount };
      }
    }
    return { type: 'check' };
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
    this.buyIn = cfg.buyIn ?? 1000;
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
          ? { seat: s.seat, userId: s.userId, nickname: s.nickname, chips: s.chips, ready: s.ready, connected: s.connected }
          : { seat: i, userId: null, nickname: '', chips: 0, ready: false, connected: false },
      );
    }
    return {
      tableId: this.tableId,
      version: this.version,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
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
      buyIn: cfg.buyIn ?? 1000,
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
        if (this.mySeat != null && t.seats.get(this.mySeat)?.userId === this.userId) {
          return { ok: false, code: 'ALREADY_SEATED' };
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
        if (t.hand && !t.hand.settled) return { ok: false, code: 'HAND_IN_PROGRESS' };
        t.seats.delete(this.mySeat);
        this.mySeat = null;
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
    this.broadcast();

    if (t.hand?.settled) {
      this.fire('game:result', {
        handId: t.hand.handId,
        result: t.hand.result,
        board: [...t.hand.board],
      });
      this.stopBot();
      return;
    }
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
      const action = t.hand.botAction(seat);
      const out = t.hand.act(seat, action);
      if (!out.ok) {
        // 兜底：动作不合法就直接过牌/弃牌
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

  /** 所有人 ready 就开下一手 */
  maybeStartHand() {
    const t = this.table;
    if (!t || (t.hand && !t.hand.settled)) return;
    if (t.seats.size < 2) return;
    const allReady = [...t.seats.values()].every((s) => s.ready);
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
      players: [...t.seats.values()].map((s) => ({
        seat: s.seat,
        userId: s.userId,
        nickname: s.nickname,
        chips: s.chips,
      })),
    });
    // 盲注与手牌已经扣在 LocalHand 里，同步回座位
    for (const hs of t.hand.seats) {
      const s = t.seats.get(hs.seat);
      if (s) {
        s.chips = hs.chips;
        s.ready = false;
      }
    }
    t.buttonSeat = (t.buttonSeat + 1) % t.maxSeats;
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
