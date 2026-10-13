/**
 * HTTP 接口层。
 *
 * 已实现于后端的：POST /dev/token        （仅开发环境挂载）
 * 仍需后端补的：  GET  /tables           （牌局列表，见 docs/backend-todo-rooms.md）
 *                POST /tables           （创建牌局，可选）
 *                GET  /tables/:id       （单个牌局详情，可选）
 *
 * 列表接口拿不到时不报错阻塞，交给上层降级成"手输房号 / 本机记录"。
 */

import { toast } from '../core/dom.js';
import { errorText } from '../core/constants.js';

/** @type {{ apiBase: string, wsBase: string, source: string }} */
let serverConfig = { apiBase: '', wsBase: '', source: 'unset' };

/**
 * @param {{ apiBase: string, wsBase: string, source: string }} cfg
 */
export function setServerConfig(cfg) {
  serverConfig = cfg;
}

/**
 * @returns {{ apiBase: string, wsBase: string, source: string }}
 */
export function getServerConfig() {
  return serverConfig;
}

/**
 * 带超时的 fetch
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, status: number, data: any, error?: string }>}
 */
export async function request(url, options = {}) {
  const { timeoutMs = 8000, ...init } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return { ok: false, status: 0, data: null, error: aborted ? 'timeout' : String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 登录：用用户名换取 JWT
 * 后端：POST /dev/token  { userId?, nickname? } → { ok, token, userId, nickname }
 * @param {string} nickname
 * @returns {Promise<{ ok: boolean, code?: string, message?: string, token?: string, userId?: string, nickname?: string }>}
 */
export async function login(nickname) {
  const name = String(nickname ?? '').trim();
  if (!name) return { ok: false, code: 'NEED_USERNAME' };
  if (name.length > 24) return { ok: false, code: 'INVALID_PAYLOAD', message: '用户名最多 24 个字符' };

  const url = `${serverConfig.apiBase}/dev/token`;
  const res = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: name }),
  });

  if (!res.ok) {
    if (res.status === 0) return { ok: false, code: 'NETWORK', message: `${errorText('NETWORK')}（${url}）` };
    return {
      ok: false,
      code: 'AUTH_FAILED',
      message: `取 token 失败（HTTP ${res.status}）。开发环境请确认后端已启动，或直接粘贴 JWT。`,
    };
  }
  const data = res.data ?? {};
  if (!data.token) return { ok: false, code: 'AUTH_FAILED', message: '服务端没有返回 token' };
  return {
    ok: true,
    token: data.token,
    userId: data.userId ?? data.sub ?? name,
    nickname: data.nickname ?? name,
  };
}

/**
 * 牌局列表（后端待实现）
 * @returns {Promise<{ ok: boolean, rooms: any[], code?: string, message?: string }>}
 */
export async function listRooms() {
  const url = `${serverConfig.apiBase}/tables`;
  const res = await request(url, { timeoutMs: 6000 });
  if (!res.ok) {
    return {
      ok: false,
      rooms: [],
      code: 'ROOM_LIST_UNAVAILABLE',
      message: res.status ? `HTTP ${res.status}` : res.error,
    };
  }
  const data = res.data;
  const rooms = Array.isArray(data) ? data : Array.isArray(data?.tables) ? data.tables : [];
  return { ok: true, rooms };
}

/**
 * 创建牌局（后端待实现）
 * @param {{ tableId: string, maxSeats: number, smallBlind: number, bigBlind: number }} cfg
 * @returns {Promise<{ ok: boolean, room?: any, code?: string, message?: string }>}
 */
export async function createRoom(cfg) {
  const url = `${serverConfig.apiBase}/tables`;
  const res = await request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  });
  if (!res.ok) {
    return { ok: false, code: 'ROOM_LIST_UNAVAILABLE', message: res.status ? `HTTP ${res.status}` : res.error };
  }
  return { ok: true, room: res.data?.table ?? res.data };
}

/**
 * 健康检查，给登录页做"服务器连通性"提示
 * @returns {Promise<boolean>}
 */
export async function ping() {
  const res = await request(`${serverConfig.apiBase}/health`, { timeoutMs: 4000 });
  return res.ok;
}

/**
 * 统一的失败提示
 * @param {{ code?: string, message?: string }} res
 * @param {string} [fallback]
 */
export function notifyFailure(res, fallback) {
  const text = res?.message || errorText(res?.code, fallback);
  toast(text, 'error');
  return text;
}
