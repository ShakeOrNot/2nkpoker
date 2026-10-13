/**
 * 运行期配置：地址、存储键、可覆盖项。
 *
 * 网络地址优先级：
 *   1. URL 查询参数      ?api=http://host:3001&ws=http://host:3001
 *   2. localStorage      （登录页"服务器"折叠项里填的）
 *   3. 同源              （由 dev-server.mjs 代理 /api、/socket.io 时使用）
 *   4. 本机默认          http://<当前主机名>:3001
 */

export const STORAGE_KEYS = {
  /** { token, userId, nickname, expiresAt } */
  session: '2nk.session',
  /** { apiBase, wsBase } */
  server: '2nk.server',
  /** { roomId, nickname, config, createdAt } 本机创建过的牌局，用于本地列表兜底 */
  rooms: '2nk.rooms',
  /** 'portrait' | 'landscape' | 'auto' */
  layout: '2nk.layout',
  /** '1' 时使用离线对手引擎 */
  offline: '2nk.offline',
};

export const DEFAULT_GAME_PORT = 3001;

/** JWT 由后端签发 15 分钟；提前 60 秒视为过期，避免交接瞬间失效 */
export const TOKEN_TTL_MS = 15 * 60 * 1000;
export const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

function param(name) {
  try {
    return new URLSearchParams(window.location.search).get(name) ?? '';
  } catch {
    return '';
  }
}

function trimSlash(u) {
  return String(u || '').replace(/\/+$/, '');
}

/**
 * 读取 localStorage（隐私模式下会抛异常）
 * @param {string} key
 */
function readStore(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * 写 localStorage
 * @param {string} key
 * @param {any} value
 */
export function writeStore(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} key
 */
export function clearStore(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

/**
 * 计算 API / WS 基地址
 * @returns {{ apiBase: string, wsBase: string, source: string }}
 */
export function resolveServerConfig() {
  const saved = readStore(STORAGE_KEYS.server) ?? {};

  const apiParam = trimSlash(param('api'));
  const wsParam = trimSlash(param('ws'));

  if (apiParam || wsParam) {
    const apiBase = apiParam || wsParam;
    return { apiBase, wsBase: wsParam || apiBase, source: 'query' };
  }

  if (saved.apiBase || saved.wsBase) {
    const apiBase = trimSlash(saved.apiBase || saved.wsBase);
    return { apiBase, wsBase: trimSlash(saved.wsBase || saved.apiBase), source: 'storage' };
  }

  // 同源：dev-server 已经把 /api 和 /socket.io 代理到后端
  const origin = window.location.origin;
  const sameOrigin = origin && origin !== 'null' && !origin.startsWith('file:');
  if (sameOrigin) {
    return { apiBase: origin, wsBase: origin, source: 'same-origin' };
  }

  const host = window.location.hostname || 'localhost';
  const fallback = `http://${host}:${DEFAULT_GAME_PORT}`;
  return { apiBase: fallback, wsBase: fallback, source: 'default' };
}

/**
 * socket.io 命名空间地址：始终以 /game 结尾
 * @param {string} wsBase
 * @returns {string}
 */
export function gameNamespaceUrl(wsBase) {
  const base = trimSlash(wsBase);
  if (/\/game$/.test(base)) return base;
  return `${base}/game`;
}

/**
 * 页面启动时可能带着 ?table=xxx 来的（分享链接）
 * @returns {string}
 */
export function roomFromQuery() {
  return (param('table') || '').trim();
}

export { readStore };
