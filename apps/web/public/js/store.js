/**
 * 状态层：把传输层（真 socket 或离线 mock）的事件收敛成一份 UI 可直接渲染的状态。
 *
 * 视图只做两件事：订阅 onChange(state) → 渲染；调用 action 方法 → 改状态。
 */

import { errorText } from './core/constants.js';
import {
  readStore,
  writeStore,
  clearStore,
  resolveServerConfig,
  resolveProto,
  gameNamespaceUrl,
  roomFromQuery,
  STORAGE_KEYS,
  TOKEN_TTL_MS,
  TOKEN_REFRESH_MARGIN_MS,
} from './core/config.js';
import { toast } from './core/dom.js';
import { clock } from './core/format.js';
import {
  makeRoomId,
  normalizeRoomInput,
  isValidRoomId,
  defaultRoomConfig,
  validateRoomConfig,
  validateBuyIn,
  handRunning,
  isMyTurn,
  toCallAmount,
  quickBets,
  deriveLegalActions,
  maxBetTarget,
  settlement,
} from './core/logic.js';
import * as api from './net/api.js';
import { GameSocket, isAuthError } from './net/socket.js';
import { createMockSocket } from './net/mock-socket.js';
import { RemoteProtocolSocket, needsRemoteAdapter } from './net/remote-protocol.js';
import { upsertRecord } from './net/roomStore.js';

/** @typedef {'login'|'lobby'|'waiting'|'table'} Phase */

const MAX_LOG_LINES = 120;

/**
 * localStorage 里的登录态
 * @returns {{ token: string, userId: string, nickname: string, expiresAt: number }|null}
 */
function loadSession() {
  const raw = readStore(STORAGE_KEYS.session);
  if (!raw?.token) return null;
  return {
    token: String(raw.token),
    userId: String(raw.userId ?? ''),
    nickname: String(raw.nickname ?? ''),
    expiresAt: Number(raw.expiresAt ?? 0),
  };
}

export class Store {
  constructor() {
    const serverConfig = resolveServerConfig();
    api.setServerConfig(serverConfig);

    const session = loadSession();

    this.state = {
      /** @type {Phase} */
      phase: 'login',
      /** @type {{ token: string, userId: string, nickname: string, expiresAt: number }|null} */
      session,
      serverConfig,
      /** 登录页上的网络状态：unknown | ok | fail */
      serverStatus: 'unknown',
      offline: readStore(STORAGE_KEYS.offline) === '1',
      /** 协议模式：'auto' | 'local'（本仓库 game-server） | 'remote'（另一种协议的后端） */
      proto: resolveProto(),
      layout: readStore(STORAGE_KEYS.layout) ?? 'auto',
      /** 连接状态 */
      connection: 'idle', // idle | connecting | online | offline
      /** 当前牌局 */
      room: {
        tableId: '',
        /** @type {any} */
        snapshot: null,
        /** @type {any} */
        actionRequest: null,
        /** @type {{ handId: string, result: any, board: string[], at: number }|null} */
        lastResult: null,
        /** @type {Array<{ at: number, text: string, kind?: string }>} */
        log: [],
        /** @type {string|null} */
        notice: '',
      },
      /** 我的手牌历史，用于结算后仍显示上一手底牌 */
      lastHoleCards: [],
      /** 是否正在等待服务端响应 */
      busy: false,
    };

    /** @type {Set<(s: any) => void>} */
    this.listeners = new Set();
    this.socket = null;
    /** @type {any} */
    this.pendingRequest = null;
    this.deadlineTimer = null;
    this.autoSitWanted = false;
    this.resultTimer = null;
  }

  /* ------------------------------------------------------------------ *
   * 订阅
   * ------------------------------------------------------------------ */

  /**
   * @param {(s: any) => void} fn
   * @returns {() => void} 取消订阅
   */
  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  onChange() {
    for (const fn of this.listeners) {
      try {
        fn(this.state);
      } catch (err) {
        console.error('[store] listener error', err);
      }
    }
  }

  /**
   * 统一把失败"喊出来"：顶部错误条 + toast。
   * 目的：绝不再出现"点了没反应又没有提示"。
   * @param {string} message
   * @param {{ code?: string, log?: boolean }} [options]
   */
  reportError(message, options = {}) {
    const text = String(message ?? '').trim() || errorText(options.code);
    try {
      const banner = typeof document !== 'undefined' ? document.getElementById('error-banner') : null;
      if (banner) {
        banner.textContent = text;
        banner.classList.add('visible');
        clearTimeout(this.bannerTimer);
        this.bannerTimer = setTimeout(() => banner.classList.remove('visible'), 8000);
      }
    } catch {
      /* 无 DOM 时忽略 */
    }
    toast(text, 'error');
    if (options.log !== false) this.log(text, 'error');
    return text;
  }

  /**
   * 局部更新并通知
   * @param {Partial<any>} patch
   */
  patch(patch) {
    Object.assign(this.state, patch);
    this.onChange();
  }

  /**
   * 更新 room 子树
   * @param {Partial<any>} patch
   */
  patchRoom(patch) {
    this.state.room = { ...this.state.room, ...patch };
    this.onChange();
  }

  /* ------------------------------------------------------------------ *
   * 日志
   * ------------------------------------------------------------------ */

  /**
   * 往牌桌日志里加一条
   * @param {string} text
   * @param {string} [kind]
   */
  log(text, kind = 'info') {
    const line = { at: Date.now(), text, kind };
    const log = [...this.state.room.log, line].slice(-MAX_LOG_LINES);
    this.patchRoom({ log });
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  async boot() {
    // 先探测服务器，登录页据此给出提示
    this.pingServer();

    const room = roomFromQuery();
    if (room && this.state.session) {
      this.log(`检测到分享链接，准备加入牌局 ${room}`);
      this.state.room.tableId = room;
    }

    if (this.state.session) {
      if (this.isTokenExpired()) {
        this.logout('登录已过期，请重新登录');
      } else {
        this.patch({ phase: 'lobby' });
      }
    }
    this.onChange();
  }

  async pingServer() {
    if (this.state.offline) {
      this.patch({ serverStatus: 'ok' });
      return;
    }
    const ok = await api.ping();
    this.patch({ serverStatus: ok ? 'ok' : 'fail' });
  }

  /**
   * @returns {boolean}
   */
  isTokenExpired() {
    const s = this.state.session;
    if (!s?.token) return true;
    if (!s.expiresAt) return false;
    return Date.now() > s.expiresAt - TOKEN_REFRESH_MARGIN_MS;
  }

  /* ------------------------------------------------------------------ *
   * 登录 / 登出
   * ------------------------------------------------------------------ */

  /**
   * 切换离线练习模式
   * @param {boolean} on
   */
  setOffline(on) {
    writeStore(STORAGE_KEYS.offline, on ? '1' : '0');
    this.patch({ offline: Boolean(on), serverStatus: on ? 'ok' : 'unknown' });
    if (!on) this.pingServer();
  }

  /**
   * @param {string} layout
   */
  setLayout(layout) {
    writeStore(STORAGE_KEYS.layout, layout);
    this.patch({ layout });
  }

  /**
   * 手动设置服务器地址
   * @param {string} apiBase
   * @param {string} wsBase
   */
  setServer(apiBase, wsBase) {
    const norm = (u) => String(u ?? '').trim().replace(/\/+$/, '');
    const apiBaseNorm = norm(apiBase);
    const wsBaseNorm = norm(wsBase || apiBase);
    if (!apiBaseNorm) return;
    const cfg = { apiBase: apiBaseNorm, wsBase: wsBaseNorm || apiBaseNorm, source: 'manual' };
    writeStore(STORAGE_KEYS.server, cfg);
    api.setServerConfig(cfg);
    this.patch({ serverConfig: cfg, serverStatus: 'unknown' });
    this.pingServer();
  }

  /**
   * 登录（拿 token 并存下来）
   * @param {string} nickname
   * @param {string} [manualToken] 生产环境可直接粘贴 JWT
   * @returns {Promise<{ ok: boolean, code?: string, message?: string }>}
   */
  async login(nickname, manualToken = '') {
    const name = String(nickname ?? '').trim();
    if (!name) return { ok: false, code: 'NEED_USERNAME' };
    this.patch({ busy: true });

    let session;
    if (manualToken) {
      session = { token: manualToken.trim(), userId: name, nickname: name, expiresAt: 0 };
    } else if (this.state.offline) {
      session = { token: 'offline', userId: `local_${name}`, nickname: name, expiresAt: Date.now() + TOKEN_TTL_MS };
    } else if (this.usesRemoteAdapter()) {
      // 适配模式下后端不做鉴权：只用昵称做身份，不需要 token
      session = { token: '', userId: name, nickname: name, expiresAt: 0 };
      this.log('目标服务器不需要登录，直接用昵称进入（协议适配模式）');
    } else {
      const res = await api.login(name);
      if (!res.ok) {
        this.patch({ busy: false });
        return { ok: false, code: res.code, message: this.reportError(res.message ?? errorText(res.code, '登录失败'), { code: res.code, log: false }) };
      }
      session = {
        token: res.token ?? '',
        userId: res.userId ?? name,
        nickname: res.nickname ?? name,
        expiresAt: Date.now() + TOKEN_TTL_MS,
      };
    }

    writeStore(STORAGE_KEYS.session, session);
    this.patch({ session, phase: 'lobby', busy: false });
    this.log(`已登录：${session.nickname}`);

    const room = this.state.room.tableId || roomFromQuery();
    if (room) await this.joinRoom(room);
    return { ok: true };
  }

  /**
   * @param {string} [message]
   */
  logout(message = '') {
    clearStore(STORAGE_KEYS.session);
    this.closeSocket();
    this.patch({
      session: null,
      phase: 'login',
      connection: 'idle',
      lastHoleCards: [],
    });
    this.patchRoom({ tableId: '', snapshot: null, actionRequest: null, lastResult: null, log: [], notice: '' });
    if (message) toast(message, 'info');
  }

  /**
   * 当前是否要使用"远端另一种协议"的适配层。
   * ?proto=remote|local 是硬开关；auto 时按地址自动判断（含已知远端 IP）。
   * @returns {boolean}
   */
  usesRemoteAdapter() {
    if (this.state.offline) return false;
    if (this.state.proto === 'remote') return true;
    if (this.state.proto === 'local') return false;
    const { wsBase, apiBase } = this.state.serverConfig;
    return needsRemoteAdapter(wsBase) || needsRemoteAdapter(apiBase);
  }

  /* ------------------------------------------------------------------ *
   * 传输层
   * ------------------------------------------------------------------ */

  /**
   * 建立一个传输连接（真 socket 或离线 mock）
   * @returns {Promise<{ ok: boolean, code?: string, message?: string }>}
   */
  async ensureSocket() {
    const session = this.state.session;
    if (!session) return { ok: false, code: 'AUTH_FAILED' };
    if (this.socket && this.state.connection === 'online') return { ok: true };
    if (this.socket && this.state.connection === 'connecting') return { ok: false, code: 'NETWORK', message: '正在连接…' };

    this.patch({ connection: 'connecting' });

    /** @type {any} */
    let transport;
    if (this.state.offline) {
      transport = createMockSocket({
        tableId: this.state.room.tableId || 'practice',
        userId: session.userId,
        nickname: session.nickname,
        smallBlind: 10,
        bigBlind: 20,
        maxSeats: 6,
        buyIn: 1000,
      });
      // 关键：离线传输也要注册回调，否则连不上状态层（曾因此导致点了没反应）
      transport.setHandlers?.(this.buildHandlers());
      await new Promise((resolve) => setTimeout(resolve, 120));
      this.socket = transport;
      this.patch({ connection: 'online' });
      this.log('离线练习模式：已连接本地对手引擎');
      return { ok: true };
    }

    // 远端服务器用的是另一套协议 → 走协议适配层（详见 net/remote-protocol.js）
    if (this.usesRemoteAdapter()) {
      transport = new RemoteProtocolSocket({
        baseUrl: this.state.serverConfig.wsBase,
        roomId: this.state.room.tableId || 'main',
        playerName: session.nickname || session.userId || '玩家',
        maxSeats: 6,
        onLog: (line) => this.log(line, 'info'),
      });
      transport.setHandlers(this.buildHandlers());
      this.socket = transport;
      const remoteRes = await transport.connect({ wsBase: this.state.serverConfig.wsBase });
      if (!remoteRes.ok) {
        this.patch({ connection: 'offline' });
        return { ok: false, code: remoteRes.code, message: remoteRes.message ?? errorText(remoteRes.code) };
      }
      this.patch({ connection: 'online' });
      this.log(`已连接远端服务器（协议适配模式）：${this.state.serverConfig.wsBase}`);
      return { ok: true };
    }

    transport = new GameSocket({});
    this.socket = transport;
    transport.setHandlers(this.buildHandlers());

    const res = await transport.connect({
      wsBase: this.state.serverConfig.wsBase,
      token: session.token,
    });

    if (!res.ok) {
      this.patch({ connection: 'offline' });
      if (isAuthError(String(res.code))) {
        this.logout('登录已失效，请重新登录');
      }
      return { ok: false, code: res.code, message: errorText(res.code) };
    }
    this.patch({ connection: 'online' });
    return { ok: true };
  }

  /**
   * 服务端事件 → store
   * @returns {any}
   */
  buildHandlers() {
    return {
      onConnect: () => {
        this.patch({ connection: 'online' });
        this.log('已连接牌局服务');
      },
      onDisconnect: (reason) => {
        this.patch({ connection: 'offline' });
        this.log(`连接断开（${reason}），正在自动重连…`, 'warn');
      },
      onConnectError: (err) => {
        this.patch({ connection: 'offline' });
        this.log(`连接失败：${errorText(err.code)}`, 'error');
      },
      onSnapshot: (snapshot) => this.applySnapshot(snapshot),
      onHandStart: (payload) => {
        this.log(`新一手开始：${payload.handId}`);
        this.patchRoom({ lastResult: null, notice: '' });
      },
      onActionRequest: (payload) => this.applyActionRequest(payload),
      onActionApplied: (payload) => {
        const verb = actionText(payload.action);
        this.log(`座位 ${payload.seat} ${verb}${payload.timeout ? '（超时自动）' : ''}`);
      },
      onResult: (payload) => this.applyResult(payload),
      onServerError: (payload) => {
        this.log(`服务端错误：${errorText(payload?.code, payload?.message)}`, 'error');
      },
    };
  }

  closeSocket() {
    this.socket?.close?.();
    this.socket = null;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.resultTimer) clearTimeout(this.resultTimer);
    this.pendingRequest = null;
  }

  /* ------------------------------------------------------------------ *
   * 服务端事件 → 状态
   * ------------------------------------------------------------------ */

  /**
   * @param {any} snapshot
   */
  applySnapshot(snapshot) {
    if (!snapshot) return;
    const prevSeat = this.mySeat();
    const hand = snapshot.hand;
    const me = hand?.seats?.find((s) => s.seat === prevSeat);

    if (me?.holeCards?.length) this.state.lastHoleCards = [...me.holeCards];

    // 阶段推进：已经坐下 → 进牌桌；否则留在等待室
    /** @type {Phase} */
    let phase = this.state.phase;
    if (this.state.phase === 'lobby' || this.state.phase === 'waiting' || this.state.phase === 'table') {
      const seated = snapshot.seats.some((s) => s.userId === this.state.session?.userId);
      if (seated && handRunning(hand)) phase = 'table';
      else if (seated || this.state.phase === 'waiting') phase = this.state.phase === 'table' && !seated ? 'waiting' : phase;
      if (this.state.phase === 'lobby') phase = 'waiting';
    }

    // 已经结算过的手牌 → 记住结算数据，等 user 看完再走
    let lastResult = this.state.room.lastResult;
    if (hand?.settled && hand.result && lastResult?.handId !== hand.handId) {
      lastResult = { handId: hand.handId, result: hand.result, board: [...(hand.board ?? [])], at: Date.now() };
      this.showResultOverlay(hand);
    }

    const tableId = snapshot.tableId ?? this.state.room.tableId;
    this.state.room = {
      ...this.state.room,
      tableId,
      snapshot,
      lastResult,
      actionRequest: hand?.settled ? null : this.state.room.actionRequest,
    };
    this.state.phase = phase;
    this.onChange();
  }

  /**
   * @param {any} payload
   */
  applyActionRequest(payload) {
    this.pendingRequest = payload;
    this.patchRoom({ actionRequest: payload });
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    const ms = Math.max(0, (payload?.deadline ?? 0) - Date.now());
    this.deadlineTimer = setTimeout(() => {
      this.patchRoom({ actionRequest: null });
    }, ms + 200);
    if (payload?.seat != null) this.log('轮到你了');
  }

  /**
   * @param {any} payload
   */
  applyResult(payload) {
    const handId = payload?.handId ?? '';
    const lastResult = { handId, result: payload?.result ?? null, board: [...(payload?.board ?? [])], at: Date.now() };
    const hand = this.state.room.snapshot?.hand;
    this.patchRoom({ lastResult, actionRequest: null });
    this.showResultOverlay(hand ?? { ...(this.state.room.snapshot?.hand ?? {}), result: payload?.result, board: payload?.board });

    // 给结算浮层留出展示时间，再收起
    if (this.resultTimer) clearTimeout(this.resultTimer);
    this.resultTimer = setTimeout(() => {
      this.patchRoom({ dismissResult: true });
    }, 6000);
  }

  /**
   * 结算浮层展示逻辑放在视图层，这里只标记"有一手待展示的结果"
   * @param {any} hand
   */
  showResultOverlay(hand) {
    const summary = settlement(hand);
    if (!summary.rows.length) return;
    const winners = summary.rows.filter((r) => r.net > 0).map((r) => r.nickname);
    this.log(`本手结束，${winners.length ? `${winners.join('、')} 赢得筹码` : '筹码已结算'}`, 'result');
  }

  /**
   * @returns {number|null}
   */
  mySeat() {
    const seats = this.state.room.snapshot?.seats ?? [];
    const userId = this.state.session?.userId;
    const found = seats.find((s) => s.userId && s.userId === userId);
    return found ? found.seat : null;
  }

  /* ------------------------------------------------------------------ *
   * 牌局动作
   * ------------------------------------------------------------------ */

  /**
   * 创建牌局：本地生成房号 + 记住配置（后端 /tables 就绪后会自动上报）
   * @param {{ maxSeats: number, smallBlind: number, bigBlind: number, buyIn: number }} cfg
   * @returns {Promise<{ ok: boolean, tableId?: string, code?: string, message?: string }>}
   */
  async createRoom(cfg) {
    const check = validateRoomConfig(cfg);
    if (!check.ok) return check;

    const tableId = makeRoomId();
    this.patch({ busy: true });
    this.state.room.tableId = tableId;
    upsertRecord({ roomId: tableId, nickname: this.state.session?.nickname ?? '', isHost: true, ...cfg });

    // 后端支持的话就登记一下；不支持也不影响开局
    if (!this.state.offline) {
      const res = await api.createRoom({ tableId, ...cfg });
      if (!res.ok) this.log('后端还没有创建牌局接口，先按本机牌局开局（见 docs/backend-todo-rooms.md）', 'warn');
    }

    const joined = await this.joinRoom(tableId, { asHost: true });
    this.patch({ busy: false });
    if (!joined.ok) return joined;
    return { ok: true, tableId };
  }

  /**
   * 加入牌局
   * @param {string} rawTableId
   * @param {{ asHost?: boolean }} [options]
   * @returns {Promise<{ ok: boolean, code?: string, message?: string }>}
   */
  async joinRoom(rawTableId, options = {}) {
    const tableId = normalizeRoomInput(rawTableId);
    if (!isValidRoomId(tableId)) {
      return { ok: false, code: 'INVALID_PAYLOAD', message: '房号格式不对（2~32 位字母数字）' };
    }

    this.patch({ busy: true });
    this.state.room.tableId = tableId;
    const conn = await this.ensureSocket();
    if (!conn.ok) {
      this.patch({ busy: false });
      this.reportError(`加入失败：${errorText(conn.code, conn.message)}`, { log: false });
      return conn;
    }

    let res;
    try {
      res = await this.socket.request('table:join', { tableId });
    } catch (err) {
      res = { ok: false, code: 'NETWORK', message: String(err?.message ?? err) };
    }
    this.patch({ busy: false });
    if (!res?.ok) {
      const message = errorText(res?.code, '加入牌局失败');
      this.reportError(`加入失败：${message}`, { log: false });
      return { ok: false, code: res?.code, message };
    }

    upsertRecord({
      roomId: tableId,
      nickname: this.state.session?.nickname ?? '',
      isHost: Boolean(options.asHost),
    });

    if (this.state.phase === 'lobby') this.patch({ phase: 'waiting' });
    this.log(res.restored ? `已回到牌局 ${tableId}（断线恢复座位）` : `已进入牌局 ${tableId}`);

    // 分享链接带过来的、或者上次就在座位的，自动补一个坐下请求
    if (this.autoSitWanted && this.mySeat() == null) {
      this.autoSitWanted = false;
      await this.sit(null, this.currentBuyIn());
    }
    return { ok: true };
  }

  /**
   * @returns {number}
   */
  currentBuyIn() {
    const snap = this.state.room.snapshot;
    return Number(snap?.bigBlind ?? 20) * 50;
  }

  /**
   * 入座
   * @param {number|null} seat
   * @param {number} buyIn
   * @returns {Promise<{ ok: boolean, code?: string, message?: string, seat?: number }>}
   */
  async sit(seat, buyIn) {
    const tableId = this.state.room.tableId;
    if (!tableId) return { ok: false, code: 'TABLE_NOT_FOUND' };
    const check = validateBuyIn(buyIn);
    if (!check.ok) return { ok: false, code: 'INVALID_BUY_IN', message: errorText('INVALID_BUY_IN') };

    const conn = await this.ensureSocket();
    if (!conn.ok) {
      this.patch({ busy: false });
      const message = errorText(conn.code, conn.message);
      this.reportError(`入座失败：${message}`, { log: false });
      return { ok: false, code: conn.code, message };
    }

    this.patch({ busy: true });
    let res;
    try {
      res = await this.socket.request('table:sit', {
        tableId,
        seat: Number.isInteger(seat) ? seat : -1,
        buyIn: Math.floor(buyIn),
      });
    } catch (err) {
      res = { ok: false, code: 'NETWORK', message: String(err?.message ?? err) };
    } finally {
      this.patch({ busy: false });
    }

    if (!res?.ok) {
      const message = errorText(res?.code, '入座失败');
      this.reportError(`入座失败：${message}`, { log: false });
      return { ok: false, code: res?.code, message };
    }
    this.log(`已入座（座位 ${res.seat}），带入 ${buyIn}`);
    upsertRecord({ roomId: tableId, buyIn: Math.floor(buyIn), nickname: this.state.session?.nickname ?? '' });
    return { ok: true, seat: res.seat };
  }

  /**
   * 离座
   * @returns {Promise<{ ok: boolean, code?: string, message?: string }>}
   */
  async stand() {
    const tableId = this.state.room.tableId;
    if (!tableId) return { ok: false, code: 'TABLE_NOT_FOUND' };
    const conn = await this.ensureSocket();
    if (!conn.ok) return conn;

    this.patch({ busy: true });
    let res;
    try {
      res = await this.socket.request('table:stand', { tableId });
    } catch (err) {
      res = { ok: false, code: 'NETWORK', message: String(err?.message ?? err) };
    } finally {
      this.patch({ busy: false });
    }
    if (!res?.ok) {
      const message = errorText(res?.code, '离座失败');
      this.reportError(`离座失败：${message}`, { log: false });
      return { ok: false, code: res?.code, message };
    }
    this.log('已离座');
    this.patchRoom({ actionRequest: null });
    return { ok: true };
  }

  /**
   * 准备 / 取消准备
   * @param {boolean} ready
   * @returns {Promise<{ ok: boolean, code?: string, message?: string }>}
   */
  async setReady(ready) {
    const tableId = this.state.room.tableId;
    if (!tableId) return { ok: false, code: 'TABLE_NOT_FOUND' };
    const conn = await this.ensureSocket();
    if (!conn.ok) {
      const message = errorText(conn.code, conn.message);
      this.reportError(`准备失败：${message}`, { log: false });
      return { ok: false, code: conn.code, message };
    }

    let res;
    try {
      res = await this.socket.request('table:ready', { tableId, ready: Boolean(ready) });
    } catch (err) {
      res = { ok: false, code: 'NETWORK', message: String(err?.message ?? err) };
    }
    if (!res?.ok) {
      const message = errorText(res?.code, '准备失败');
      this.reportError(`准备失败：${message}`, { log: false });
      return { ok: false, code: res?.code, message };
    }
    this.log(ready ? '已准备，等待开局' : '已取消准备');
    return { ok: true };
  }

  /**
   * 发动作
   * @param {{ type: string, amount?: number }|string} action
   * @returns {Promise<{ ok: boolean, code?: string, message?: string }>}
   */
  async act(action) {
    const req = this.pendingRequest;
    const hand = this.state.room.snapshot?.hand;
    if (!hand) return { ok: false, code: 'HAND_NOT_ACTIVE', message: errorText('HAND_NOT_ACTIVE') };
    const payload = typeof action === 'string' ? { type: action } : action;
    const tableId = this.state.room.tableId;

    const conn = await this.ensureSocket();
    if (!conn.ok) {
      const message = errorText(conn.code, conn.message);
      this.reportError(`操作失败：${message}`, { log: false });
      return { ok: false, code: conn.code, message };
    }

    // 用最新快照里的 hand.version，比 action_request 里的更可靠
    const expectedVersion = Number.isInteger(hand.version) ? hand.version : Number(req?.version ?? 0);
    let res;
    try {
      res = await this.socket.request('game:action', {
        tableId,
        handId: hand.handId,
        expectedVersion,
        action: payload,
      });
    } catch (err) {
      res = { ok: false, code: 'NETWORK', message: String(err?.message ?? err) };
    }

    if (!res?.ok) {
      const message = errorText(res?.code, '操作失败');
      this.reportError(`操作失败：${message}`, { log: false });
      return { ok: false, code: res?.code, message };
    }
    this.patchRoom({ actionRequest: null });
    return { ok: true };
  }

  /* ------------------------------------------------------------------ *
   * 供视图调用的派生数据
   * ------------------------------------------------------------------ */

  /**
   * 当前可用的动作与快捷金额
   * @returns {{ legal: string[], quicks: any[], request: any, needToCall: number, canBet: boolean }}
   */
  actionContext() {
    const hand = this.state.room.snapshot?.hand;
    const seat = this.mySeat();
    const request = this.state.room.actionRequest;
    const legal = request?.legalActions?.length ? request.legalActions : deriveLegalActions(hand, seat);
    const myTurn = isMyTurn(hand, seat) || Boolean(request);
    return {
      legal: myTurn ? legal : [],
      quicks: myTurn && hand ? quickBets(hand, seat) : [],
      request,
      needToCall: hand ? toCallAmount(hand, seat) : 0,
      maxTarget: hand ? maxBetTarget(hand, seat) : 0,
      isMyTurn: myTurn,
    };
  }
}

/**
 * 动作中文名
 * @param {{ type?: string }|string} action
 * @returns {string}
 */
export function actionText(action) {
  const type = typeof action === 'string' ? action : action?.type;
  return (
    {
      fold: '弃牌',
      check: '过牌',
      call: '跟注',
      bet: '下注',
      raise: '加注',
      all_in: '全下',
    }[String(type)] ?? String(type)
  );
}

export { gameNamespaceUrl, clock };
