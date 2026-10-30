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
import { RemoteProtocolSocket } from './net/remote-protocol.js';
import { upsertRecord } from './net/roomStore.js';

/** @typedef {'login'|'lobby'|'waiting'|'table'|'admin'} Phase */

const MAX_LOG_LINES = 120;

/**
 * localStorage 里的登录态
 * @returns {{ token: string, refreshToken: string, userId: string, nickname: string, expiresAt: number, user: any }|null}
 */
function loadSession() {
  const raw = readStore(STORAGE_KEYS.session);
  if (!raw?.token) return null;
  return {
    token: String(raw.token),
    refreshToken: String(raw.refreshToken ?? ''),
    userId: String(raw.userId ?? ''),
    nickname: String(raw.nickname ?? ''),
    expiresAt: Number(raw.expiresAt ?? 0),
    /** 登录用户信息（含 role），刷新页面后靠它判断是不是管理员 */
    user: raw.user && typeof raw.user === 'object' ? raw.user : null,
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
      /** access token 续期失败：顶部横幅提示，但当前页面保持不动 */
      authExpired: false,
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
        /** 手牌进行中点了"排队等待下一手"：等本手结束会自动入座 */
        queued: false,
        /** 手牌进行中点了"离桌"：本手结束、座位清掉后自动退房回大厅 */
        pendingLeave: false,
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
    /** 重连后重新订阅房间是否正在进行（防止重复 join） */
    this.rejoining = false;
    /** access token 自动续期定时器 */
    this.refreshTimer = null;
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
   * 退出离线练习：关掉离线开关 + 清登录态，回到登录页（默认连真实后端）。
   * 只 logout 是不够的 —— 离线开关会留在 localStorage 里，下次登录还是离线。
   * @param {string} [message]
   */
  exitOffline(message = '已退出离线练习') {
    this.setOffline(false);
    this.logout(message);
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
   * 登录（昵称即登录名 + 口令）；成功后存 session 并自动续期
   * @param {string} nickname
   * @param {string} [password]
   * @param {string} [manualToken] 生产环境可直接粘贴 JWT（跳过口令）
   * @returns {Promise<{ ok: boolean, code?: string, message?: string }>}
   */
  async login(nickname, password = '', manualToken = '') {
    const name = String(nickname ?? '').trim();
    if (!name) return { ok: false, code: 'NEED_USERNAME' };
    this.patch({ busy: true });

    let session;
    if (manualToken) {
      session = { token: manualToken.trim(), userId: name, nickname: name, expiresAt: 0, refreshToken: '', user: null };
    } else if (this.state.offline) {
      session = {
        token: 'offline',
        userId: `local_${name}`,
        nickname: name,
        expiresAt: Date.now() + TOKEN_TTL_MS,
        refreshToken: '',
        user: { id: `local_${name}`, nickname: name, role: 'user' },
      };
    } else if (this.usesRemoteAdapter()) {
      // 适配模式下后端不做鉴权：只用昵称做身份，不需要 token
      session = { token: '', userId: name, nickname: name, expiresAt: 0, refreshToken: '', user: null };
      this.log('目标服务器不需要登录，直接用昵称进入（协议适配模式）');
    } else {
      const res = await api.login(name, password);
      if (!res.ok) {
        this.patch({ busy: false });
        return { ok: false, code: res.code, message: this.reportError(res.message ?? errorText(res.code, '登录失败'), { code: res.code, log: false }) };
      }
      session = {
        token: res.token ?? '',
        refreshToken: res.refreshToken ?? '',
        userId: res.userId ?? name,
        nickname: res.nickname ?? name,
        expiresAt: res.expiresAt ?? Date.now() + TOKEN_TTL_MS,
        user: res.user ?? null,
      };
    }

    this.installSession(session);
    this.patch({ busy: false });
    const room = this.state.room.tableId || roomFromQuery();
    if (room) await this.joinRoom(room);
    return { ok: true };
  }

  /**
   * 注册账号（成功后直接进入大厅）
   * @param {string} nickname
   * @param {string} password
   * @returns {Promise<{ ok: boolean, code?: string, message?: string }>}
   */
  async register(nickname, password) {
    const name = String(nickname ?? '').trim();
    if (!name) return { ok: false, code: 'NEED_USERNAME' };
    if (this.state.offline) return { ok: false, code: 'OFFLINE_NO_ACCOUNT', message: '离线练习不需要注册' };
    this.patch({ busy: true });
    const res = await api.register(name, password);
    if (!res.ok) {
      this.patch({ busy: false });
      return { ok: false, code: res.code, message: this.reportError(res.message ?? errorText(res.code, '注册失败'), { code: res.code, log: false }) };
    }
    this.installSession({
      token: res.token ?? '',
      refreshToken: res.refreshToken ?? '',
      userId: res.userId ?? name,
      nickname: res.nickname ?? name,
      expiresAt: res.expiresAt ?? Date.now() + TOKEN_TTL_MS,
      user: res.user ?? null,
    });
    this.patch({ busy: false });
    this.log(`注册成功，欢迎 ${name}`);
    return { ok: true };
  }

  /**
   * 落库 + 切大厅 + 排续期（登录/注册成功后用）
   * @param {{ token: string, refreshToken?: string, userId: string, nickname: string, expiresAt: number }} session
   */
  installSession(session) {
    writeStore(STORAGE_KEYS.session, session);
    this.patch({ session, phase: 'lobby', busy: false, authExpired: false });
    this.log(`已登录：${session.nickname}`);
    this.scheduleTokenRefresh();
  }

  /**
   * 只更新会话、不动当前页面（续期/改口令后用，避免把人从牌桌上踢回大厅）
   * @param {any} session
   */
  applySession(session) {
    writeStore(STORAGE_KEYS.session, session);
    this.patch({ session, authExpired: false });
    this.socket?.updateAuth?.(session.token);
    this.scheduleTokenRefresh();
  }

  /** 到期前 60 秒自动续期（只有带 refreshToken 的会话需要） */
  scheduleTokenRefresh() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    const session = this.state.session;
    if (!session?.refreshToken) return;
    const delay = Math.max(5000, Number(session.expiresAt ?? 0) - Date.now() - TOKEN_REFRESH_MARGIN_MS);
    this.refreshTimer = setTimeout(() => void this.refreshAccessToken(), delay);
  }

  /**
   * 用刷新令牌换新的 access token。
   * 刷新失败**不再直接把页面切回登录**：只置 authExpired，让顶部横幅提示，
   * 当前牌桌/等待室还在，用户点"重新登录"再回登录页（否则打一半被踢走）。
   * @returns {Promise<boolean>}
   */
  async refreshAccessToken() {
    const session = this.state.session;
    if (!session?.refreshToken) return false;
    const res = await api.refresh(session.refreshToken);
    if (!res.ok) {
      this.patch({ authExpired: true });
      this.log('登录已过期，请点顶部「重新登录」');
      return false;
    }
    const next = {
      ...session,
      token: res.token,
      refreshToken: res.refreshToken || session.refreshToken,
      expiresAt: res.expiresAt,
      nickname: res.nickname || session.nickname,
      userId: res.userId || session.userId,
      user: res.user ?? session.user ?? null,
    };
    this.applySession(next);
    return true;
  }

  /** 顶部横幅上的"重新登录"：清掉本地会话回登录页 */
  reLogin() {
    this.logout('');
    this.patch({ authExpired: false });
  }

  /**
   * 改口令：成功后服务端会发一对新令牌，这里直接换上（不用重新登录）
   * @param {string} oldPassword
   * @param {string} newPassword
   * @returns {Promise<{ ok: boolean, code?: string, message?: string }>}
   */
  async changePassword(oldPassword, newPassword) {
    const session = this.state.session;
    if (!session?.token) return { ok: false, code: 'AUTH_FAILED' };
    const res = await api.changePassword(session.token, oldPassword, newPassword);
    if (!res.ok) {
      return {
        ok: false,
        code: res.code,
        message: this.reportError(res.message ?? errorText(res.code, '改口令失败'), { code: res.code, log: false }),
      };
    }
    this.applySession({
      ...session,
      token: res.token,
      refreshToken: res.refreshToken || session.refreshToken,
      expiresAt: res.expiresAt,
      nickname: res.nickname || session.nickname,
      userId: res.userId || session.userId,
      user: res.user ?? session.user ?? null,
    });
    this.log('口令已修改');
    return { ok: true };
  }

  /**
   * @param {string} [message]
   */
  logout(message = '') {
    const refreshToken = this.state.session?.refreshToken;
    if (refreshToken) void api.logout(refreshToken);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    clearStore(STORAGE_KEYS.session);
    this.closeSocket();
    this.patch({
      session: null,
      phase: 'login',
      connection: 'idle',
      lastHoleCards: [],
      authExpired: false,
    });
    this.patchRoom({ tableId: '', snapshot: null, actionRequest: null, lastResult: null, log: [], notice: '' });
    if (message) toast(message, 'info');
  }

  /* ------------------------------------------------------------------ *
   * 管理面板（只有 role=admin 可用；服务端还有一道 requireAdmin）
   * ------------------------------------------------------------------ */

  /** 当前账号是不是管理员 */
  get isAdmin() {
    return this.state.session?.user?.role === 'admin';
  }

  /** 进管理面板（从大厅进）；不是管理员就提示并留在原地 */
  openAdmin() {
    if (!this.isAdmin) {
      this.reportError('只有管理员可以打开管理面板');
      return false;
    }
    this.patch({ phase: 'admin' });
    return true;
  }

  /** 退出管理面板回大厅 */
  exitAdmin() {
    this.patch({ phase: 'lobby' });
  }

  /**
   * 账号列表（服务端分页 + 搜索）
   * @param {{ q?: string, limit?: number, offset?: number }} [options]
   */
  async adminListUsers(options = {}) {
    const token = this.state.session?.token;
    if (!this.isAdmin || !token) return { ok: false, code: 'FORBIDDEN', message: '只有管理员可以查看账号' };
    return api.adminUsers(token, options);
  }

  /**
   * 改角色 / 禁用启用
   * @param {string} id
   * @param {{ role?: 'user'|'admin', disabled?: boolean }} patch
   */
  async adminUpdateUser(id, patch) {
    const token = this.state.session?.token;
    if (!this.isAdmin || !token) return { ok: false, code: 'FORBIDDEN', message: '只有管理员可以修改账号' };
    return api.adminUpdateUser(token, id, patch);
  }

  /**
   * 重置某个账号的口令（忘记口令时用）
   * @param {string} nickname
   * @param {string} newPassword
   */
  async adminResetPassword(nickname, newPassword) {
    const token = this.state.session?.token;
    if (!this.isAdmin || !token) return { ok: false, code: 'FORBIDDEN', message: '只有管理员可以重置口令' };
    const res = await api.adminResetPassword(token, nickname, newPassword);
    if (res.ok) this.log(`已重置 ${nickname} 的口令`);
    return res;
  }

  /** 审计日志 @param {number} [limit] */
  async adminAudit(limit = 50) {
    const token = this.state.session?.token;
    if (!this.isAdmin || !token) return { ok: false, code: 'FORBIDDEN', message: '只有管理员可以看审计日志' };
    return api.adminAudit(token, limit);
  }

  /** 所有牌桌（含座位） */
  async adminTables() {
    const token = this.state.session?.token;
    if (!this.isAdmin || !token) return { ok: false, code: 'FORBIDDEN', message: '只有管理员可以看牌桌', tables: [] };
    return api.adminTables(token);
  }

  /**
   * 强制解散牌局
   * @param {string} tableId
   */
  async adminCloseTable(tableId) {
    const token = this.state.session?.token;
    if (!this.isAdmin || !token) return { ok: false, code: 'FORBIDDEN', message: '只有管理员可以解散牌局' };
    const res = await api.adminCloseTable(token, tableId);
    if (res.ok) this.log(`已解散牌局 ${tableId}`);
    return res;
  }

  /**
   * 把玩家踢出牌桌
   * @param {string} tableId
   * @param {string} userId
   */
  async adminKickUser(tableId, userId) {
    const token = this.state.session?.token;
    if (!this.isAdmin || !token) return { ok: false, code: 'FORBIDDEN', message: '只有管理员可以踢人' };
    const res = await api.adminKickUser(token, tableId, userId);
    if (res.ok) this.log(`已把 ${userId} 踢出 ${tableId}`);
    return res;
  }

  /**
   * 全站战绩（管理员）
   * @param {{ q?: string, limit?: number, offset?: number }} [options]
   */
  async adminStats(options = {}) {
    const token = this.state.session?.token;
    if (!this.isAdmin || !token) return { ok: false, code: 'FORBIDDEN', message: '只有管理员可以看战绩', stats: [], total: 0 };
    return api.adminStats(token, options);
  }

  /** 我的战绩 */
  async myStats() {
    const token = this.state.session?.token;
    if (!token) return { ok: false, code: 'AUTH_FAILED', message: '请先登录' };
    return api.myStats(token);
  }

  /**
   * 管理员解散了当前牌局：清掉房间状态回大厅
   * @param {any} payload
   */
  handleTableClosed(payload) {
    const tableId = String(payload?.tableId ?? '');
    this.patchRoom({
      tableId: '',
      snapshot: null,
      actionRequest: null,
      lastResult: null,
      queued: false,
      pendingLeave: false,
    });
    this.patch({ phase: 'lobby' });
    this.log(`牌局 ${tableId} 已被管理员解散`);
  }

  /**
   * 被管理员移出牌桌
   * @param {any} payload
   */
  handleTableKicked(payload) {
    const tableId = String(payload?.tableId ?? '');
    this.patchRoom({ tableId: '', snapshot: null, actionRequest: null, lastResult: null, queued: false, pendingLeave: false });
    this.patch({ phase: 'lobby' });
    this.log(`你已被管理员移出牌局 ${tableId}`);
    toast('你已被管理员移出牌局', 'info');
  }

  /**
   * 当前是否要使用"远端另一种协议"的适配层。
   * 只在显式 ?proto=remote 时启用：不能再按 IP 猜，
   * 否则把项目部署到 43.135.53.83 后，同源访问会被误判成远端协议，表现为
   * "能登录但连不上服务器"。
   * @returns {boolean}
   */
  usesRemoteAdapter() {
    if (this.state.offline) return false;
    return this.state.proto === 'remote';
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

    // access token 快过期了就先续期，否则握手会被拒
    if (
      session.refreshToken &&
      session.expiresAt &&
      session.expiresAt - Date.now() < TOKEN_REFRESH_MARGIN_MS
    ) {
      const ok = await this.refreshAccessToken();
      if (!ok) return { ok: false, code: 'AUTH_EXPIRED', message: '登录已过期，请重新登录' };
    }
    const active = this.state.session ?? session;

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
        ante: 5,
        maxSeats: 6,
        buyIn: 2000,
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

    let res = await transport.connect({
      wsBase: this.state.serverConfig.wsBase,
      token: active.token,
    });

    // 握手被拒（AUTH_FAILED 多半是 access 刚好过期，或服务端重启后计时偏差）：
    // 先自动续期一次再重连，别直接把用户踢回登录页。
    if (!res.ok && isAuthError(String(res.code)) && this.state.session?.refreshToken) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        res = await transport.connect({
          wsBase: this.state.serverConfig.wsBase,
          token: this.state.session?.token ?? '',
        });
      }
    }

    if (!res.ok) {
      this.patch({ connection: 'idle' });
      if (isAuthError(String(res.code))) {
        // 保留当前页面，用顶部横幅提示；用户点「重新登录」才回登录页
        this.patch({ authExpired: true });
        return { ok: false, code: 'AUTH_EXPIRED', message: '登录已失效，请点顶部「重新登录」' };
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
        // socket.io 重连会换一个新的 socket.id，而服务端的房间成员是按 socket 算的：
        // 不重新 table:join 的话，页面看着"已连接"却再也收不到任何快照。
        const tableId = this.state.room.tableId;
        if (tableId && (this.state.phase === 'waiting' || this.state.phase === 'table')) {
          void this.rejoinRoom(tableId);
        }
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
      onTableClosed: (payload) => this.handleTableClosed(payload),
      onTableKicked: (payload) => this.handleTableKicked(payload),
      onServerError: (payload) => {
        this.log(`服务端错误：${errorText(payload?.code, payload?.message)}`, 'error');
      },
    };
  }

  closeSocket() {
    this.socket?.close?.();
    this.socket = null;
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.pendingRequest = null;
  }

  /**
   * 重连后重新订阅房间，并主动拉一次快照补上断线期间漏掉的广播。
   * @param {string} tableId
   */
  async rejoinRoom(tableId) {
    if (this.state.offline || this.rejoining) return;
    if (!this.socket || typeof this.socket.request !== 'function') return;
    if (this.socket.connected === false) return;

    this.rejoining = true;
    try {
      const res = await this.socket.request('table:join', { tableId });
      if (!res?.ok) return;
      // 服务端可能已经把座位弄丢了（超过宽限期），ack 里会告诉我们有没有恢复
      if (res.restored) this.log(`已恢复座位 ${res.seat}`);
      const state = await this.socket.request('table:request_state', { tableId });
      if (state?.ok && state.snapshot) this.applySnapshot(state.snapshot);
    } catch {
      /* 重连期间的失败不打扰用户：下一次 onConnect 还会再试 */
    } finally {
      this.rejoining = false;
    }
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

    // 阶段推进：只在 waiting 或 table 之间自动切换，lobby 保持不变
    /** @type {Phase} */  
    let phase = this.state.phase;
    if (this.state.phase === 'waiting' || this.state.phase === 'table') {
      const seated = snapshot.seats.some((s) => s.userId === this.state.session?.userId);
      if (seated && handRunning(hand)) phase = 'table';
      else if (seated || this.state.phase === 'waiting') phase = this.state.phase === 'table' && !seated ? 'waiting' : phase;
    }

    // 已经结算过的手牌 → 记住结算数据（连座位一起），等 user 看完再走
    let lastResult = this.state.room.lastResult;
    if (hand?.settled && hand.result && lastResult?.handId !== hand.handId) {
      lastResult = {
        handId: hand.handId,
        result: hand.result,
        board: [...(hand.board ?? [])],
        seats: (hand.seats ?? []).map((s) => ({ ...s })),
        at: Date.now(),
      };
      this.showResultOverlay(hand);
    }

    const tableId = snapshot.tableId ?? this.state.room.tableId;
    const nowSeated = snapshot.seats?.some((s) => s.userId === this.state.session?.userId);
    const wasPendingLeave = Boolean(this.state.room.pendingLeave);
    this.state.room = {
      ...this.state.room,
      tableId,
      snapshot,
      lastResult,
      // 一旦真的坐上座位，"排队中"状态就结束了
      queued: nowSeated ? false : this.state.room.queued,
      // 离桌请求：座位清掉之前一直挂着
      pendingLeave: nowSeated ? wasPendingLeave : false,
      actionRequest: hand?.settled ? null : this.state.room.actionRequest,
    };
    this.state.phase = phase;
    this.onChange();

    // 手牌进行中点的"离桌"已完成（座位没了 + 本手结束）→ 自动退房回大厅
    if (wasPendingLeave && !nowSeated && !handRunning(snapshot.hand)) {
      void this.leaveRoom();
    }
  }

  /**
   * @param {any} payload
   */
    applyActionRequest(payload) {
    /* 契约是"只发给当前行动者"；为稳妥再校验一次座位，
       别人的请求绝不能当成我的（否则操作会被服务端拒绝） */
    const mySeat = this.mySeat();
    if (payload?.seat != null && mySeat != null && payload.seat !== mySeat) return;

    // 如果当前不在牌桌界面（在大厅或等待室），直接立刻代打
    if (this.state.phase !== 'table') {
      this.log('挂机中（不在牌桌），自动为你过牌/弃牌', 'warn');
      this.autoAction(payload);
      return;
    }

    this.pendingRequest = payload;
    this.patchRoom({ actionRequest: payload });
    if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
    
    const ms = Math.max(0, (payload?.deadline ?? 0) - Date.now());
    
    // 倒计时结束：玩家在牌桌发呆，前端主动代打，不等待后端超时
    this.deadlineTimer = setTimeout(() => {
      this.patchRoom({ actionRequest: null });
      this.log('操作超时，自动为你过牌/弃牌', 'warn');
      this.autoAction(payload);
    }, ms + 200); // 延迟 200ms 保证后端也认可这个时间点

    if (payload?.seat != null) this.log('轮到你了');
  }

  // 新增一个自动代打方法
  async autoAction(req) {
    const hand = this.state.room.snapshot?.hand;
    if (!hand || hand.handId !== req.handId) return;
    const me = hand.seats.find(s => s.seat === req.seat);
    if (!me) return;
    
    const toCall = Math.max(0, (hand.currentBet ?? 0) - (me.betThisStreet ?? 0));
    const action = toCall === 0 ? { type: 'check' } : { type: 'fold' };
    await this.act(action);
  }

  /**
   * @param {any} payload
   */
  applyResult(payload) {
    const handId = payload?.handId ?? '';
    const prev = this.state.room.lastResult;
    const hand = this.state.room.snapshot?.hand;
    // 服务端紧接着会清空 handState 并推一份 hand=null 的快照，
    // 所以结算明细需要的座位（昵称/投入/弃牌）必须在这里固定下来，
    // 否则浮层会因为"没有 seats"而画不出来（联机模式少结算框的原因）。
    const seats =
      (Array.isArray(payload?.seats) && payload.seats.length ? payload.seats : null) ??
      (prev?.handId === handId ? prev.seats : null) ??
      (hand?.seats ?? []);
    const lastResult = {
      handId,
      result: payload?.result ?? null,
      board: [...(payload?.board ?? [])],
      seats: seats.map((s) => ({ ...s })),
      at: Date.now(),
    };
    this.pendingRequest = null;
    this.patchRoom({ lastResult, actionRequest: null });
    this.showResultOverlay(hand ?? { seats, result: payload?.result, board: payload?.board });
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
      if (!res.ok) this.log('牌局登记失败（后端 POST /tables 不可用？），先按本机牌局开局', 'warn');
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

    // 先进了另一张桌：先把旧房间退订，避免两张桌的快照互相覆盖
    const previous = this.state.room.tableId;
    if (previous && previous !== tableId && this.socket && this.state.connection === 'online') {
      try {
        await this.socket.request('table:leave', { tableId: previous });
      } catch {
        /* 旧房间退订失败不影响进新桌 */
      }
      this.patchRoom({ pendingLeave: false, queued: false });
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

    // 已经在座 → 这次是换座：不重新买入，沿用当前筹码（可能已经低于最低买入）
    const mySeat = this.mySeat();
    const moving = mySeat != null;
    const me = moving ? this.state.room.snapshot?.seats?.find((s) => s.seat === mySeat) : null;
    const stake = moving ? Math.max(1, Number(me?.chips ?? 1)) : buyIn;
    if (!moving) {
      const bb = Number(this.state.room.snapshot?.bigBlind ?? 20);
      const check = validateBuyIn(buyIn, bb);
      if (!check.ok) return { ok: false, code: 'INVALID_BUY_IN', message: check.message ?? errorText('INVALID_BUY_IN') };
    }

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
        buyIn: Math.floor(stake),
      });
    } catch (err) {
      res = { ok: false, code: 'NETWORK', message: String(err?.message ?? err) };
    } finally {
      this.patch({ busy: false });
    }

      if (!res?.ok) {
      if (res?.queued) {
        this.patchRoom({ queued: true });
        toast('已加入排队，本手结束后自动入座', 'info');
        return { ok: true, queued: true }; // 告诉 UI 排队成功了
      }
      const message = errorText(res?.code, '入座失败');
      this.reportError(`入座失败：${message}`, { log: false });
      return { ok: false, code: res?.code, message };
    }
    this.patchRoom({ queued: false });
    if (res.moved) {
      this.log(`已换到座位 ${res.seat}（筹码不变）`);
      return { ok: true, seat: res.seat, moved: true };
    }
    if (res.unchanged) return { ok: true, seat: res.seat };
    this.log(`已入座（座位 ${res.seat}），带入 ${stake}`);
    upsertRecord({ roomId: tableId, buyIn: Math.floor(stake), nickname: this.state.session?.nickname ?? '' });
    return { ok: true, seat: res.seat };
  }

  /**
   * 补码（买入）：units 个单位，1 个单位 = 100BB。
   * 手牌进行中提交 → 服务端记 pending，本手结算后补码（不会立刻生效）。
   * @param {number} [units]
   * @returns {Promise<{ ok: boolean, code?: string, message?: string, pending?: boolean, amount?: number, chips?: number }>}
   */
  async rebuy(units = 1) {
    const tableId = this.state.room.tableId;
    if (!tableId) return { ok: false, code: 'TABLE_NOT_FOUND' };
    if (this.mySeat() == null) return { ok: false, code: 'NOT_SEATED' };
    const n = Math.max(1, Math.floor(Number(units) || 1));
    const conn = await this.ensureSocket();
    if (!conn.ok) return conn;

    this.patch({ busy: true });
    let res;
    try {
      res = await this.socket.request('table:rebuy', { tableId, units: n });
    } catch (err) {
      res = { ok: false, code: 'NETWORK', message: String(err?.message ?? err) };
    } finally {
      this.patch({ busy: false });
    }
    if (!res?.ok) {
      const message = errorText(res?.code, '补码失败');
      this.reportError(`补码失败：${message}`, { log: false });
      return { ok: false, code: res?.code, message };
    }
    if (res.pending) {
      this.log(`已申请 ${n} 个买入（${res.amount}），本手结算后补码`);
      toast('已提交买入，本手结算后补码', 'info');
    } else {
      this.log(`已买入 ${n} 个（+${res.amount}），当前筹码 ${res.chips}`);
      toast(`买入成功，当前筹码 ${res.chips}`, 'info');
    }
    return res;
  }

  /**
   * 离座
   * @returns {Promise<{ ok: boolean, code?: string, message?: string }>}
   */
  async stand() {
    const tableId = this.state.room.tableId;
    if (!tableId) return { ok: false, code: 'TABLE_NOT_FOUND' };
    const wasSeated = this.mySeat() != null;
    // 既没座位、也不在排队 → 本来就不用打扰服务端
    if (!wasSeated && !this.state.room.queued) return { ok: true };
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
    // 手牌进行中：服务端只标记"本手结束后离桌"
    if (res.pending) {
      this.patchRoom({ pendingLeave: true, actionRequest: null, queued: false });
      this.log('本手结束后自动离桌');
      return { ok: true, pending: true };
    }
    this.log(wasSeated ? '已离座' : '已取消排队');
    this.patchRoom({ actionRequest: null, queued: false });
    return { ok: true };
  }

  /**
   * 主动离桌：自动离座 + 退出房间（"返回大厅"按钮走这里）。
   * 手牌进行中服务端只会标记"本手结束后离桌"，此时先回大厅等结算，
   * 结算后座位消失时由 applySnapshot 自动退房。
   * @returns {Promise<{ ok: boolean, code?: string, message?: string, pending?: boolean }>}
   */
  async leaveTable() {
    if (!this.state.room.tableId) return { ok: true };
    const inHand = handRunning(this.state.room.snapshot?.hand);

    if (this.mySeat() != null) {
      const res = await this.stand();
      if (!res.ok) return res;
      if (res.pending || inHand) {
        // 保持订阅挂机：轮到你会自动过牌/弃牌，结算后再退房
        this.patch({ phase: 'lobby' });
        return { ok: true, pending: true };
      }
    } else if (this.state.room.queued) {
      await this.stand(); // 只是取消排队
    }

    await this.leaveRoom();
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
  /**
   * 退出房间：退订服务端房间 + 清空本地牌局状态，并回到大厅。
   * （只离座不要调这个 —— 离座用 stand()，人还留在房间里）
   * @returns {Promise<void>}
   */
  async leaveRoom() {
  if (!this.state.room.tableId) return;
  // 通知后端退订
  if (this.socket && this.state.connection === 'online') {
    await this.socket.request('table:leave', { tableId: this.state.room.tableId });
  }
  // 清空前端本地状态
  this.patchRoom({ tableId: '', snapshot: null, actionRequest: null, lastResult: null, log: [], notice: '', queued: false, pendingLeave: false });
  // 房间都没了还停在 waiting/table 只会渲染出一个空壳界面（房号 ----、按钮全灰）
  if (this.state.phase === 'waiting' || this.state.phase === 'table') {
    this.patch({ phase: 'lobby' });
  }
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
