/**
 * 实时连接层：socket.io 客户端 + 统一的事件回调 + 带超时的 ack 请求。
 *
 * 说明：socket.io 客户端从 CDN 懒加载（多源回退），所以不需要 npm 安装。
 * 所有服务端事件先落到这里，再由 store 决定怎么进状态。
 */

import { gameNamespaceUrl } from '../core/config.js';

/** socket.io 客户端来源，按顺序尝试 */
const CLIENT_SOURCES = [
  'https://cdn.socket.io/4.7.5/socket.io.min.js',
  'https://cdn.jsdelivr.net/npm/socket.io-client@4.7.5/dist/socket.io.min.js',
  'https://unpkg.com/socket.io-client@4.7.5/dist/socket.io.min.js',
];

/**
 * @typedef {Object} SocketHandlers
 * @property {(info: { userId: string }) => void} [onConnect]
 * @property {(reason: string) => void} [onDisconnect]
 * @property {(err: { code: string, message: string }) => void} [onConnectError]
 * @property {(snapshot: any) => void} [onSnapshot]
 * @property {(payload: any) => void} [onHandStart]
 * @property {(payload: any) => void} [onActionRequest]
 * @property {(payload: any) => void} [onActionApplied]
 * @property {(payload: any) => void} [onResult]
 * @property {(payload: any) => void} [onServerError]
 */

/** @type {any} */
let ioLib = null;
let libPromise = null;

/**
 * 懒加载 socket.io 客户端
 * @returns {Promise<any>}
 */
function loadIoLib() {
  if (globalThis.io) return Promise.resolve(globalThis.io);
  if (libPromise) return libPromise;

  libPromise = (async () => {
    for (const src of CLIENT_SOURCES) {
      try {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = src;
          script.async = true;
          script.onload = () => resolve(true);
          script.onerror = () => reject(new Error(`load failed: ${src}`));
          document.head.appendChild(script);
        });
        if (globalThis.io) {
          ioLib = globalThis.io;
          return ioLib;
        }
      } catch {
        /* 换下一个源 */
      }
    }
    throw new Error('socket.io 客户端加载失败，请检查网络或改用离线练习');
  })();
  return libPromise;
}

/** 服务端只发这一种错误事件；ack 里的 code 走各请求自己的返回 */
const EVENT_MAP = {
  'table:snapshot': 'onSnapshot',
  'hand:start': 'onHandStart',
  'game:action_request': 'onActionRequest',
  'game:action_applied': 'onActionApplied',
  'game:result': 'onResult',
  error: 'onServerError',
};

export class GameSocket {
  /**
   * @param {SocketHandlers} handlers
   */
  constructor(handlers = {}) {
    /** @type {SocketHandlers} */
    this.handlers = handlers;
    /** @type {any} */
    this.socket = null;
    this.connected = false;
    /** 最近一次握手用的 token，重连时复用 */
    this.token = '';
    this.wsBase = '';
    /** @type {Map<string, { resolve: (v: any) => void, timer: any, label: string }>} */
    this.pending = new Map();
    this.seq = 0;
  }

  /**
   * @param {Partial<SocketHandlers>} handlers
   */
  setHandlers(handlers) {
    Object.assign(this.handlers, handlers);
  }

  /**
   * 建立连接
   * @param {{ wsBase: string, token: string }} options
   * @returns {Promise<{ ok: boolean, code?: string, message?: string }>}
   */
  async connect({ wsBase, token }) {
    this.token = token;
    this.wsBase = wsBase;
    const io = await loadIoLib();
    this.close();

    const url = gameNamespaceUrl(wsBase);
    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const socket = io(url, {
        auth: { token },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 8,
        reconnectionDelay: 800,
        reconnectionDelayMax: 4000,
        timeout: 8000,
      });
      this.socket = socket;

      socket.on('connect', () => {
        this.connected = true;
        this.handlers.onConnect?.({ userId: socket.id ?? '' });
        done({ ok: true });
      });

      socket.on('connect_error', (err) => {
        this.connected = false;
        const code = String(err?.message ?? 'AUTH_FAILED');
        this.handlers.onConnectError?.({ code, message: code });
        done({ ok: false, code, message: code });
      });

      socket.on('disconnect', (reason) => {
        this.connected = false;
        this.failAllPending('NOT_CONNECTED');
        this.handlers.onDisconnect?.(String(reason));
      });

      for (const [event, handlerName] of Object.entries(EVENT_MAP)) {
        socket.on(event, (payload) => {
          const fn = this.handlers[/** @type {keyof SocketHandlers} */ (handlerName)];
          if (typeof fn === 'function') fn(payload);
        });
      }
    });
  }

  /**
   * 发一个带 ack 的请求
   * @param {string} event
   * @param {any} payload
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<{ ok: boolean, code?: string, message?: string, [k: string]: any }>}
   */
  request(event, payload, options = {}) {
    const timeoutMs = options.timeoutMs ?? 8000;
    if (!this.socket || !this.connected) {
      return Promise.resolve({ ok: false, code: 'NOT_CONNECTED' });
    }
    const label = `${event}#${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(label);
        resolve({ ok: false, code: 'NETWORK', message: '服务端没有响应（超时）' });
      }, timeoutMs);
      this.pending.set(label, { resolve, timer, label });
      try {
        this.socket.emit(event, payload, (res) => {
          const entry = this.pending.get(label);
          if (!entry) return;
          clearTimeout(entry.timer);
          this.pending.delete(label);
          resolve(res ?? { ok: false, code: 'INTERNAL_ERROR', message: '服务端返回了空响应' });
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(label);
        resolve({ ok: false, code: 'NETWORK', message: String(err?.message ?? err) });
      }
    });
  }

  /**
   * 断开并清空挂起请求
   * @param {string} [reason]
   */
  close(reason = 'client close') {
    this.failAllPending('NOT_CONNECTED');
    if (this.socket) {
      try {
        this.socket.removeAllListeners?.();
        this.socket.disconnect?.();
        this.socket.close?.();
      } catch {
        /* 忽略 */
      }
    }
    this.socket = null;
    this.connected = false;
    void reason;
  }

  /**
   * 与 socket.io 客户端保持一致的名字
   */
  disconnect() {
    this.close('client disconnect');
  }

  /**
   * @param {string} code
   */
  failAllPending(code) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, code });
    }
    this.pending.clear();
  }
}

/**
 * 判断某个连接错误是否属于"登录态失效"
 * @param {string} code
 * @returns {boolean}
 */
export function isAuthError(code) {
  return code === 'AUTH_FAILED' || code === 'AUTH_EXPIRED' || code === 'jwt expired';
}
