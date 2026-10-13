/**
 * 协议适配层：把"另一种后端协议"翻译成我们前端认识的协议。
 *
 * 背景：43.135.53.83:3000 上的后端不是我们仓库里的 game-server，它用的是另一套
 * Socket.IO 协议（无鉴权、无 table:* / game:* 事件），实测到的协议如下：
 *
 *   客户端 → 服务端
 *     joinRoom    { roomId, playerName }
 *     playerReady { roomId }
 *     playerAction{ roomId, action, amount }      action: check | call | fold | raise
 *
 *   服务端 → 客户端
 *     playerList     [ { id, name, chips, seat, status, currentBet, hasActed, ready } ]
 *     myHand         [ '2♠', 'J♥' ]               只有本人拿到
 *     joinSuccess    { seat, name }
 *     joinFailed     '错误文案'
 *     gameState      { players, pot, currentTurn, currentBet, phase, communityCards,
 *                      started, dealerSeat, smallBlind, bigBlind, lastRaiseAmount }
 *     showdownResult { winners: [ { name, seat, amount } ], share }
 *     errorMsg       '错误文案'
 *
 *   其中：
 *     - 牌面是"点数 + 花色符号"（'K♥'），我们是 'Kh' → 用 logic.js 的转换函数
 *     - raise 的 amount 同样是"本街下注到多少"（已实测：bet 20 → raise 40 后该玩家 currentBet=40）
 *     - phase: preflop | flop | turn | river | showdown
 *     - 玩家 status: waiting | active | folded | allin
 *     - 没有盲注/带入的入座概念，"加入房间"即入座，准备后才发牌
 *
 * 本文件把这套协议**双向翻译**成我们前端的 table:join / table:sit / table:ready /
 * game:action 与 table:snapshot / game:action_request / game:result，
 * 于是 store.js 与所有视图一行都不用改。
 */

import { cardsFromSymbols } from '../core/logic.js';
import { loadSocketIoClient } from './socket.js';

/** 他们的 phase → 我们的 street */
const PHASE_TO_STREET = {
  preflop: 'PREFLOP',
  flop: 'FLOP',
  turn: 'TURN',
  river: 'RIVER',
  showdown: 'SETTLED',
};

/** 我们的动作类型 → 他们的 action */
const ACTION_TO_REMOTE = {
  fold: 'fold',
  check: 'check',
  call: 'call',
  bet: 'raise',    // 他们只有 raise；无人下注时的 raise 等价于我们的 bet
  raise: 'raise',
};

/**
 * @param {string} type
 * @returns {string}
 */
function remoteActionOf(type) {
  return ACTION_TO_REMOTE[type] ?? '';
}

/**
 * @typedef {Object} RemoteAdapterOptions
 * @property {string} baseUrl      例如 http://43.135.53.83:3000
 * @property {string} roomId       房间号（他们的 roomId 可以是任意字符串）
 * @property {string} playerName   玩家名（他们没有账号体系）
 * @property {number} [maxSeats]   仅用于界面展示
 * @property {(ev: any) => void} [onLog] 调试日志
 */

export class RemoteProtocolSocket {
  /**
   * @param {RemoteAdapterOptions} options
   */
  constructor(options) {
    this.baseUrl = String(options.baseUrl ?? '').replace(/\/+$/, '');
    this.roomId = String(options.roomId ?? 'main');
    this.playerName = String(options.playerName ?? '玩家');
    this.maxSeats = options.maxSeats ?? 6;
    this.onLog = options.onLog ?? (() => {});

    /** @type {any} */
    this.handlers = {};
    /** @type {any} */
    this.socket = null;
    this.connected = false;

    /** 最近一次 gameState */
    this.gameState = null;
    /** 我的座位号 */
    this.mySeat = null;
    /** 我的底牌（我们的写法） */
    this.myHand = [];
    /** 上一手结算（用于 game:result） */
    this.lastResult = null;
    /** 房间配置（盲注来自对局状态） */
    this.config = { smallBlind: 10, bigBlind: 20, maxSeats: this.maxSeats };
    /** 是否已准备 */
    this.ready = false;
    /** 本手每个座位的累计投入（远端不提供，靠筹码变化推算，用于结算展示） */
    this.committed = {};
    /** 上一手的摊牌结果 */
    this.lastShownHandId = null;
  }

  /* ------------------------------------------------------------------ *
   * 与 GameSocket 一致的外壳
   * ------------------------------------------------------------------ */

  /**
   * @param {Record<string, Function>} handlers
   */
  setHandlers(handlers) {
    this.handlers = { ...this.handlers, ...handlers };
  }

  /**
   * @param {string} name
   * @param {any} payload
   */
  notify(name, payload) {
    const fn = this.handlers?.[name];
    if (typeof fn === 'function') {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[remote] handler ${name} 出错`, err);
      }
    }
  }

  /**
   * 建立连接（socket.io 客户端由 socket.js 懒加载，这里复用全局 io）
   * @param {{ wsBase?: string, token?: string }} [options]
   * @returns {Promise<{ ok: boolean, code?: string, message?: string }>}
   */
  async connect(options = {}) {
    let ioLib = globalThis.io;
    if (typeof ioLib !== 'function') {
      try {
        ioLib = await loadSocketIoClient();
      } catch (err) {
        return { ok: false, code: 'NETWORK', message: String(err?.message ?? 'socket.io 客户端加载失败') };
      }
    }
    if (typeof ioLib !== 'function') {
      return { ok: false, code: 'NETWORK', message: 'socket.io 客户端未加载（请检查网络或改用离线练习）' };
    }
    const url = options.wsBase ? String(options.wsBase).replace(/\/+$/, '') : this.baseUrl;
    this.onLog(`连接远端 ${url}（房间 ${this.roomId}）`);

    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      // 远端没有命名空间，也无需鉴权
      const socket = ioLib(url, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 800,
        timeout: 8000,
      });
      this.socket = socket;

      socket.on('connect', () => {
        this.connected = true;
        this.notify('onConnect', { userId: socket.id ?? '' });
        done({ ok: true });
      });
      socket.on('connect_error', (err) => {
        this.connected = false;
        const message = String(err?.message ?? '连接失败');
        this.onLog(`连接失败：${message}`);
        this.notify('onConnectError', { code: 'NETWORK', message });
        done({ ok: false, code: 'NETWORK', message });
      });
      socket.on('disconnect', (reason) => {
        this.connected = false;
        this.notify('onDisconnect', String(reason));
      });

      /* 远端事件 → 我们的状态与事件 */
      socket.on('playerList', (list) => this.handlePlayerList(list));
      socket.on('joinSuccess', (payload) => this.handleJoinSuccess(payload));
      socket.on('joinFailed', (message) => this.handleJoinFailed(message));
      socket.on('myHand', (cards) => this.handleMyHand(cards));
      socket.on('gameState', (state) => this.handleGameState(state));
      socket.on('showdownResult', (result) => this.handleShowdown(result));
      socket.on('errorMsg', (message) => this.notify('onServerError', { code: 'INVALID_ACTION', message: String(message) }));
    });
  }

  /**
   * @param {string} event
   * @param {any} payload
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{ ok: boolean, code?: string, message?: string, [k: string]: any }>}
   */
  async request(event, payload, options = {}) {
    void options;
    if (!this.socket || !this.connected) return { ok: false, code: 'NOT_CONNECTED', message: '还没连上服务器' };

    switch (event) {
      case 'table:join': {
        if (payload?.tableId) this.roomId = String(payload.tableId);
        return this.joinRoom();
      }
      case 'table:sit': {
        // 他们的"加入房间"就等于入座；已在座时幂等返回
        if (this.mySeat != null) return { ok: true, seat: this.mySeat - 1 };
        return this.joinRoom();
      }
      case 'table:stand':
        return { ok: false, code: 'INVALID_ACTION', message: '这个服务器不支持离座' };
      case 'table:ready': {
        return this.setReady(Boolean(payload?.ready));
      }
      case 'game:action': {
        return this.sendAction(payload?.action, payload);
      }
      default:
        return { ok: false, code: 'INVALID_PAYLOAD', message: `远端协议不支持 ${event}` };
    }
  }

  close() {
    try {
      this.socket?.removeAllListeners?.();
      this.socket?.disconnect?.();
    } catch {
      /* 忽略 */
    }
    this.socket = null;
    this.connected = false;
  }

  disconnect() {
    this.close();
  }

  /* ------------------------------------------------------------------ *
   * 我们的请求 → 远端事件
   * ------------------------------------------------------------------ */

  /**
   * 加入房间（= 入座）。等 joinSuccess / joinFailed 回来再 resolve。
   * 重复调用是幂等的：已经在座就直接返回，避免远端报"名字被占用"。
   * @returns {Promise<{ ok: boolean, code?: string, message?: string, seat?: number }>}
   */
  joinRoom() {
    if (this.mySeat != null) {
      // 已经在座：不重复请求，直接按当前状态推一份快照
      this.publishSnapshot();
      return Promise.resolve({ ok: true, seat: this.mySeat - 1, restored: true });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingJoin = null;
        resolve({ ok: false, code: 'NETWORK', message: '加入房间超时' });
      }, 8000);
      this.pendingJoin = (result) => {
        clearTimeout(timer);
        this.pendingJoin = null;
        resolve(result);
      };
      this.onLog(`emit joinRoom { roomId: ${this.roomId}, playerName: ${this.playerName} }`);
      this.socket.emit('joinRoom', { roomId: this.roomId, playerName: this.playerName });
    });
  }

  /**
   * @param {boolean} ready
   * @returns {Promise<{ ok: boolean, code?: string, message?: string }>}
   */
  setReady(ready) {
    if (this.mySeat == null) return Promise.resolve({ ok: false, code: 'NOT_SEATED', message: '还没入座' });
    if (ready === this.ready) return Promise.resolve({ ok: true });
    this.ready = ready;
    // 他们的 playerReady 相当于"切换准备"，没有取消准备的接口
    this.onLog(`emit playerReady { roomId: ${this.roomId} }`);
    this.socket.emit('playerReady', { roomId: this.roomId });
    return Promise.resolve({ ok: true });
  }

  /**
   * @param {{ type: string, amount?: number }} action
   * @param {any} payload
   * @returns {Promise<{ ok: boolean, code?: string, message?: string }>}
   */
  sendAction(action, payload) {
    void payload;
    const type = String(action?.type ?? '');
    if (!ACTION_TO_REMOTE[type] && type !== 'all_in') {
      return Promise.resolve({ ok: false, code: 'INVALID_ACTION', message: `远端不支持 ${type}` });
    }
    const state = this.gameState;
    if (!state?.started) return Promise.resolve({ ok: false, code: 'HAND_NOT_ACTIVE', message: '当前没有进行中的牌局' });
    if (state.currentTurn !== this.mySeat) return Promise.resolve({ ok: false, code: 'NOT_YOUR_TURN', message: '还没轮到你' });

    const me = this.me();
    if (!me) return Promise.resolve({ ok: false, code: 'NOT_SEATED', message: '你不在座位上' });

    const maxTarget = (me.currentBet ?? 0) + (me.chips ?? 0);
    const toCall = Math.max(0, (state.currentBet ?? 0) - (me.currentBet ?? 0));

    /** 远端只认 amount = "本街下注到的总额" */
    let amount;
    if (type === 'all_in') {
      // 他们只有 raise，全下就等于"加注到自己的全部筹码"；如果不够跟注也照样推出去
      amount = maxTarget;
    } else if (type === 'bet' || type === 'raise') {
      amount = Math.floor(Number(action?.amount));
      if (!Number.isFinite(amount) || amount <= 0) {
        return Promise.resolve({ ok: false, code: 'INVALID_ACTION', message: '下注金额不合法' });
      }
      if (amount > maxTarget) {
        return Promise.resolve({ ok: false, code: 'INSUFFICIENT_CHIPS', message: `最多只能下到 ${maxTarget}` });
      }
      const minRaiseTo = (state.currentBet ?? 0) + (state.lastRaiseAmount ?? state.bigBlind ?? 20);
      if (amount < minRaiseTo && amount !== maxTarget) {
        return Promise.resolve({ ok: false, code: 'INVALID_ACTION', message: `加注至少要到 ${minRaiseTo}（或直接全下 ${maxTarget}）` });
      }
    }

    /** 远端只有 raise；bet / raise / all_in 统一发 raise，并带上"本街下注到多少" */
    const isAggressive = type === 'bet' || type === 'raise' || type === 'all_in';
    const remoteAction = isAggressive ? 'raise' : remoteActionOf(type);

    const outgoing = { roomId: this.roomId, action: remoteAction };
    if (isAggressive) outgoing.amount = amount;
    this.onLog(`emit playerAction ${JSON.stringify(outgoing)}`);
    this.socket.emit('playerAction', outgoing);
    void toCall;
    return Promise.resolve({ ok: true });
  }

  /* ------------------------------------------------------------------ *
   * 远端事件 → 我们的状态
   * ------------------------------------------------------------------ */

  /** 强制全下：筹码不够跟注时，他们的 raise 需要显式金额 */
  allInAmount() {
    const me = this.me();
    return (me?.currentBet ?? 0) + (me?.chips ?? 0);
  }

  /**
   * @returns {any}
   */
  me() {
    return this.gameState?.players?.find((p) => p.seat === this.mySeat) ?? null;
  }

  /**
   * 远端玩家的稳定标识。
   * 用昵称而不是 socket.id：他们的 id 每次连接都会变，而 store 与界面都靠这个
   * 字段认出"哪個座位是我"（远端本身也用昵称做唯一标识）。
   * @param {any} p
   * @returns {string}
   */
  userIdOf(p) {
    return String(p?.name ?? p?.id ?? '');
  }

  /**
   * @param {any[]} list
   */
  handlePlayerList(list) {
    if (!Array.isArray(list)) return;
    this.onLog(`playerList：${list.length} 人`);
    // 没有 gameState 时也要能渲染出座位
    if (!this.gameState) {
      this.gameState = {
        players: list,
        pot: 0,
        currentTurn: null,
        currentBet: 0,
        phase: 'preflop',
        communityCards: [],
        started: false,
        dealerSeat: null,
        smallBlind: this.config.smallBlind,
        bigBlind: this.config.bigBlind,
      };
    } else {
      this.gameState.players = list;
    }
    this.publishSnapshot();
  }

  /**
   * @param {{ seat: number, name: string }} payload
   */
  handleJoinSuccess(payload) {
    this.mySeat = payload?.seat ?? null;
    this.playerName = payload?.name ?? this.playerName;
    this.onLog(`joinSuccess：座位 ${this.mySeat}`);
    if (this.pendingJoin) this.pendingJoin({ ok: true, seat: this.mySeat ?? undefined });
    this.publishSnapshot();
  }

  /**
   * @param {string} message
   */
  handleJoinFailed(message) {
    const text = String(message ?? '加入房间失败');
    this.onLog(`joinFailed：${text}`);
    if (this.pendingJoin) this.pendingJoin({ ok: false, code: 'TABLE_FULL', message: text });
    this.notify('onServerError', { code: 'TABLE_FULL', message: text });
  }

  /**
   * @param {string[]} cards
   */
  handleMyHand(cards) {
    this.myHand = cardsFromSymbols(cards);
    this.onLog(`myHand：${this.myHand.join(' ')}`);
    this.publishSnapshot();
  }

  /**
   * @param {any} state
   */
  handleGameState(state) {
    if (!state) return;
    const prev = this.gameState;
    this.gameState = state;
    if (state.smallBlind) this.config.smallBlind = state.smallBlind;
    if (state.bigBlind) this.config.bigBlind = state.bigBlind;

    // 同步我的座位（他们也会在 gameState 里带）
    const mine = state.players?.find((p) => p.name === this.playerName);
    if (mine && this.mySeat == null) this.mySeat = mine.seat;

    // 本手累计投入（远端不提供，靠筹码变化推算）
    this.trackCommitted(prev, state);

    this.publishSnapshot();

    // 阶段变化 → 日志里提示一下
    if (prev?.phase !== state.phase) this.onLog(`阶段：${prev?.phase ?? '-'} → ${state.phase}`);

    // 轮到我了 → 发我们的 game:action_request
    const myTurn = state.started && state.currentTurn != null && state.currentTurn === this.mySeat;
    if (myTurn) {
      this.notify('onActionRequest', {
        handId: this.handId(),
        seat: this.mySeat,
        legalActions: this.legalActions(),
        deadline: Date.now() + 30000,
        version: 1,
      });
    }

    // 一手结束（他们用 phase=showdown + started=false 表示）
    if (state.phase === 'showdown' && prev?.phase !== 'showdown' && this.lastResult) {
      this.notify('onResult', {
        handId: this.handId(),
        result: this.lastResult,
        board: this.board(),
      });
    }
  }

  /**
   * @param {{ winners?: Array<{name:string,seat:number,amount:number,cards?:string[]}>, share?: number }} payload
   */
  handleShowdown(payload) {
    const winners = Array.isArray(payload?.winners) ? payload.winners : [];
    this.onLog(`showdownResult：${winners.map((w) => `${w.name} +${w.amount}`).join('、')}`);
    const payouts = {};
    for (const w of winners) {
      if (typeof w?.seat === 'number') payouts[w.seat] = (payouts[w.seat] ?? 0) + (Number(w.amount) || 0);
    }
    const total = winners.reduce((sum, w) => sum + (Number(w.amount) || 0), 0);

    // 远端不在 showdownResult 里带牌面：只能亮出自己的底牌；
    // 若远端以后补上（winners[].cards），这里会自动用上。
    const revealed = {};
    for (const w of winners) {
      const cards = cardsFromSymbols(w?.cards ?? []);
      if (cards.length && typeof w.seat === 'number') revealed[w.seat] = cards;
    }
    if (Object.keys(revealed).length === 0 && this.mySeat != null && this.myHand.length) {
      revealed[this.mySeat] = [...this.myHand];
    }

    this.lastResult = {
      pots: total > 0
        ? [{ amount: total, eligibleSeats: winners.map((w) => w.seat).filter((s) => typeof s === 'number') }]
        : [],
      payouts,
      revealed,
      forcedWinnerSeat: winners.length === 1 ? winners[0].seat : null,
    };
    // 摊牌后立刻推一次结果（桌面上的 ± 变化要马上显示）
    this.notify('onResult', {
      handId: this.handId(),
      result: this.lastResult,
      board: this.board(),
    });
  }

  /* ------------------------------------------------------------------ *
   * 组装我们格式的快照
   * ------------------------------------------------------------------ */

  /**
   * @returns {string}
   */
  handId() {
    return `remote_${this.roomId}`;
  }

  /**
   * @returns {string[]} 我们的牌面写法
   */
  board() {
    return cardsFromSymbols(this.gameState?.communityCards ?? []);
  }

  /**
   * 本手累计投入：远端只给"本街已下注"，靠前后帧的筹码变化推算到整手
   * @param {any} prev
   * @param {any} state
   */
  trackCommitted(prev, state) {
    if (!state?.players) return;
    const newHand = prev && !prev.started && state.started;
    if (newHand) this.committed = {};
    for (const p of state.players) {
      const before = prev?.players?.find((x) => x.seat === p.seat);
      const chips = Number(p.chips) || 0;
      if (!before) {
        // 新手入局：以当前筹码为本手起点
        if (!(p.seat in this.committed)) this.committed[p.seat] = 0;
        this.chipsSeen = this.chipsSeen ?? {};
        this.chipsSeen[p.seat] = chips;
        continue;
      }
      const prevChips = Number(before.chips) || 0;
      this.chipsSeen = this.chipsSeen ?? {};
      if (!(p.seat in this.committed)) this.committed[p.seat] = 0;
      if (prevChips > chips) this.committed[p.seat] += prevChips - chips;
      this.chipsSeen[p.seat] = chips;
    }
  }

  /**
   * 远端状态 → 我们的 legalActions
   * @returns {string[]}
   */
  legalActions() {
    const state = this.gameState;
    const me = this.me();
    if (!state?.started || !me) return [];
    if (state.currentTurn !== this.mySeat) return [];
    if (me.status === 'folded' || me.status === 'allin') return [];

    const toCall = Math.max(0, (state.currentBet ?? 0) - (me.currentBet ?? 0));
    const out = ['fold'];
    if (toCall === 0) out.push('check');
    if (toCall > 0) out.push('call');
    // 他们的 raise 需要目标金额；筹码不足以加注时不给 raise，但仍可全下
    const maxTarget = (me.currentBet ?? 0) + (me.chips ?? 0);
    const minRaiseTo = (state.currentBet ?? 0) + (state.lastRaiseAmount ?? state.bigBlind ?? 20);
    if (state.currentBet === 0 && me.chips > 0) out.push('bet');
    if (state.currentBet > 0 && maxTarget > state.currentBet && maxTarget >= minRaiseTo) out.push('raise');
    if (me.chips > 0) out.push('all_in');
    return out;
  }

  /**
   * 生成我们格式的 TableSnapshot 并推给 store
   */
  publishSnapshot() {
    const state = this.gameState;
    const players = Array.isArray(state?.players) ? state.players : [];
    const started = Boolean(state?.started);
    const street = started ? PHASE_TO_STREET[state?.phase] ?? 'PREFLOP' : 'WAITING';

    /** 座位表：他们的座位号是 1 起，我们转成 0 起 */
    const seats = [];
    for (let i = 0; i < this.maxSeats; i++) {
      const p = players.find((x) => x.seat === i + 1);
      seats.push({
        seat: i,
        userId: p ? this.userIdOf(p) : null,
        nickname: p ? String(p.name) : '',
        chips: p ? Number(p.chips) || 0 : 0,
        ready: Boolean(p?.ready),
        connected: Boolean(p),
      });
    }

    const mySeatIndex = this.mySeat != null ? this.mySeat - 1 : null;
    const handSeats = players.map((p) => ({
      seat: p.seat - 1,
      userId: this.userIdOf(p),
      nickname: String(p.name),
      chips: Number(p.chips) || 0,
      betThisStreet: Number(p.currentBet) || 0,
      totalCommitted: this.committed?.[p.seat] ?? 0,
      folded: p.status === 'folded',
      allIn: p.status === 'allin',
      sittingOut: p.status === 'waiting',
      holeCards: p.seat - 1 === mySeatIndex ? [...this.myHand] : [],
    }));

    const hand = started || street !== 'WAITING'
      ? {
        handId: this.handId(),
        street,
        board: this.board(),
        buttonSeat: (state.dealerSeat ?? 1) - 1,
        smallBlind: Number(state.smallBlind) || this.config.smallBlind,
        bigBlind: Number(state.bigBlind) || this.config.bigBlind,
        seats: handSeats,
        currentTurnSeat: state.currentTurn != null ? state.currentTurn - 1 : null,
        currentBet: Number(state.currentBet) || 0,
        minRaise: Number(state.lastRaiseAmount) || Number(state.bigBlind) || 20,
        pot: Number(state.pot) || 0,
        version: 1,
        settled: street === 'SETTLED',
        result: street === 'SETTLED' ? this.lastResult : null,
      }
      : null;

    if (hand) this.lastHand = hand;

    this.notify('onSnapshot', {
      tableId: this.roomId,
      version: 1,
      smallBlind: Number(state?.smallBlind) || this.config.smallBlind,
      bigBlind: Number(state?.bigBlind) || this.config.bigBlind,
      buttonSeat: (state?.dealerSeat ?? 1) - 1,
      maxSeats: this.maxSeats,
      seats,
      // 结算帧用"保留的那一手 + 最新公共牌/结算数据"，否则浮层会缺最后一张牌
      hand: hand ?? (this.lastHand
        ? {
          ...this.lastHand,
          board: this.board(),
          settled: true,
          currentTurnSeat: null,
          result: this.lastResult ?? this.lastHand.result ?? null,
        }
        : null),
    });
  }
}

/**
 * 判断某个地址是否是"另一种协议"的远端（用于自动切换适配层）
 * @param {string} wsBase
 * @returns {boolean}
 */
export function needsRemoteAdapter(wsBase) {
  return /43\.135\.53\.83/i.test(String(wsBase ?? ''));
}
