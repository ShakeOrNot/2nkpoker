/**
 * HTTP 接口层。
 *
 * 后端已实现（见 docs/protocol.md）：
 *   GET  /health、GET /ready
 *   GET  /tables           牌局列表
 *   GET  /tables/:tableId  单个牌局详情
 *   POST /tables           创建/取回牌局
 *   POST /dev/token        仅开发环境的 JWT 签发
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
 * 发一个 JSON 请求（POST/PATCH/DELETE），并把服务端错误码原样带回来
 * @param {'POST'|'PATCH'|'DELETE'} method
 * @param {string} path
 * @param {any} body
 * @param {{ timeoutMs?: number, token?: string }} [options]
 * @returns {Promise<{ ok: boolean, data?: any, status: number, code?: string, message?: string }>}
 */
async function sendJson(method, path, body, options = {}) {
  const url = `${serverConfig.apiBase}${path}`;
  /** @type {Record<string, string>} */
  const headers = { 'Content-Type': 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const res = await request(url, {
    method,
    headers,
    body: JSON.stringify(body ?? {}),
    timeoutMs: options.timeoutMs ?? 10000,
  });
  if (!res.ok) {
    if (res.status === 0) {
      return { ok: false, status: 0, code: 'NETWORK', message: `${errorText('NETWORK')}（${url}）` };
    }
    const data = res.data ?? {};
    return {
      ok: false,
      status: res.status,
      code: data.code ?? 'AUTH_FAILED',
      message: data.message ?? errorText(data.code),
    };
  }
  return { ok: true, status: res.status, data: res.data ?? {} };
}

/**
 * 发 JSON POST（登录/注册/改口令/管理操作都用它）
 * @param {string} path
 * @param {any} body
 * @param {{ timeoutMs?: number, token?: string }} [options]
 */
async function postJson(path, body, options = {}) {
  return sendJson('POST', path, body, options);
}

/**
 * 带 token 的 GET（管理面板用）
 * @param {string} path
 * @param {{ timeoutMs?: number, token?: string }} [options]
 */
async function getJson(path, options = {}) {
  const url = `${serverConfig.apiBase}${path}`;
  /** @type {Record<string, string>} */
  const headers = {};
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const res = await request(url, { headers, timeoutMs: options.timeoutMs ?? 10000 });
  if (!res.ok) {
    if (res.status === 0) {
      return { ok: false, status: 0, code: 'NETWORK', message: `${errorText('NETWORK')}（${url}）` };
    }
    const data = res.data ?? {};
    return {
      ok: false,
      status: res.status,
      code: data.code ?? 'AUTH_FAILED',
      message: data.message ?? errorText(data.code),
    };
  }
  return { ok: true, status: res.status, data: res.data ?? {} };
}

/**
 * 把服务端的会话响应转成 store 用的形状
 * @param {any} data
 */
function toSession(data) {
  return {
    ok: true,
    token: data.accessToken ?? '',
    refreshToken: data.refreshToken ?? '',
    expiresAt: Number(data.expiresAt ?? Date.now() + 15 * 60 * 1000),
    userId: String(data.user?.id ?? ''),
    nickname: String(data.user?.nickname ?? ''),
    user: data.user ?? null,
  };
}

/**
 * 登录（昵称即登录名）
 * 后端：POST /auth/login { nickname, password } → { accessToken, refreshToken, expiresAt, user }
 * @param {string} nickname
 * @param {string} password
 */
export async function login(nickname, password) {
  const name = String(nickname ?? '').trim();
  if (!name) return { ok: false, code: 'NEED_USERNAME' };
  if (!password) return { ok: false, code: 'NEED_PASSWORD' };
  const res = await postJson('/auth/login', { nickname: name, password: String(password) });
  if (!res.ok) {
    return { ok: false, code: res.code, message: res.message, data: res.status === 429 ? { retryAfterMs: res.message } : undefined };
  }
  return toSession(res.data);
}

/**
 * 注册账号（成功即登录）
 * @param {string} nickname
 * @param {string} password
 */
export async function register(nickname, password) {
  const name = String(nickname ?? '').trim();
  if (!name) return { ok: false, code: 'NEED_USERNAME' };
  if (!password) return { ok: false, code: 'NEED_PASSWORD' };
  const res = await postJson('/auth/register', { nickname: name, password: String(password) });
  if (!res.ok) return { ok: false, code: res.code, message: res.message };
  return toSession(res.data);
}

/**
 * 用刷新令牌换新的 access token（旧刷新令牌会作废）
 * @param {string} refreshToken
 */
export async function refresh(refreshToken) {
  if (!refreshToken) return { ok: false, code: 'AUTH_REFRESH_INVALID' };
  const res = await postJson('/auth/refresh', { refreshToken });
  if (!res.ok) return { ok: false, code: res.code, message: res.message };
  return toSession(res.data);
}

/**
 * 吊销刷新令牌（登出）
 * @param {string} refreshToken
 */
export async function logout(refreshToken) {
  if (!refreshToken) return { ok: true };
  try {
    await postJson('/auth/logout', { refreshToken }, { timeoutMs: 4000 });
  } catch {
    /* 登出失败不重要，本地照样清 */
  }
  return { ok: true };
}

/**
 * 改口令：成功后返回一对新令牌（服务端会把旧令牌全部作废）
 * @param {string} token access token
 * @param {string} oldPassword
 * @param {string} newPassword
 */
export async function changePassword(token, oldPassword, newPassword) {
  if (!token) return { ok: false, code: 'AUTH_FAILED' };
  const res = await postJson(
    '/auth/change-password',
    { oldPassword: String(oldPassword ?? ''), newPassword: String(newPassword ?? '') },
    { token, timeoutMs: 15000 },
  );
  if (!res.ok) return { ok: false, code: res.code, message: res.message };
  return toSession(res.data);
}

/**
 * 当前用户（校验 access token）
 * @param {string} accessToken
 */
export async function me(accessToken) {
  const url = `${serverConfig.apiBase}/auth/me`;
  const res = await request(url, { headers: { Authorization: `Bearer ${accessToken}` }, timeoutMs: 6000 });
  if (!res.ok) return { ok: false, code: res.data?.code ?? 'AUTH_FAILED' };
  return { ok: true, user: res.data?.user ?? null };
}

/**
 * 开发用：无口令换一个"无名令牌"（POST /dev/token）
 * 仅用于联调/脚本兜底，正式登录走 /auth/login
 * @param {string} nickname
 */
export async function devLogin(nickname) {
  const name = String(nickname ?? '').trim();
  if (!name) return { ok: false, code: 'NEED_USERNAME' };
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
    refreshToken: '',
    expiresAt: Date.now() + 15 * 60 * 1000,
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

/* ================= 管理面板（只有 role=admin 能调） ================= */

const NO_TOKEN = { ok: false, code: 'NO_TOKEN', message: '需要管理员登录' };

/**
 * 账号列表（服务端分页 + 昵称搜索）
 * GET /auth/admin/users?q=&limit=&offset= → { ok, total, users }
 * @param {string} token
 * @param {{ q?: string, limit?: number, offset?: number }} [options]
 */
export async function adminUsers(token, options = {}) {
  if (!token) return { ...NO_TOKEN, users: [], total: 0 };
  const qs = new URLSearchParams({
    limit: String(options.limit ?? 50),
    offset: String(options.offset ?? 0),
  });
  const q = String(options.q ?? '').trim();
  if (q) qs.set('q', q);
  const res = await getJson(`/auth/admin/users?${qs}`, { token });
  if (!res.ok) return { ok: false, code: res.code, message: res.message, users: [], total: 0 };
  return {
    ok: true,
    total: Number(res.data.total ?? 0),
    users: Array.isArray(res.data.users) ? res.data.users : [],
  };
}

/**
 * 改角色 / 禁用启用
 * PATCH /auth/admin/users/:id { role?, disabled? } → { ok, user }
 * @param {string} token
 * @param {string} id
 * @param {{ role?: 'user'|'admin', disabled?: boolean }} patch
 */
export async function adminUpdateUser(token, id, patch) {
  if (!token) return NO_TOKEN;
  const res = await sendJson('PATCH', `/auth/admin/users/${encodeURIComponent(String(id))}`, patch, { token });
  if (!res.ok) return { ok: false, code: res.code, message: res.message };
  return { ok: true, user: res.data.user ?? null };
}

/**
 * 重置某个账号的口令（不需要旧口令）
 * POST /auth/admin/reset-password { nickname, newPassword }
 */
export async function adminResetPassword(token, nickname, newPassword) {
  if (!token) return NO_TOKEN;
  const res = await postJson(
    '/auth/admin/reset-password',
    { nickname: String(nickname ?? '').trim(), newPassword },
    { token, timeoutMs: 20000 }, // scrypt 要算一会儿
  );
  if (!res.ok) return { ok: false, code: res.code, message: res.message };
  return { ok: true };
}

/**
 * 审计日志
 * GET /auth/admin/audit?limit= → { ok, entries }
 * @param {string} token
 * @param {number} [limit]
 */
export async function adminAudit(token, limit = 50) {
  if (!token) return { ...NO_TOKEN, entries: [] };
  const res = await getJson(`/auth/admin/audit?limit=${encodeURIComponent(String(limit))}`, { token });
  if (!res.ok) return { ok: false, code: res.code, message: res.message, entries: [] };
  return { ok: true, entries: Array.isArray(res.data.entries) ? res.data.entries : [] };
}

/**
 * 管理员：所有牌桌（含座位）
 * GET /auth/admin/tables → { ok, tables }
 * @param {string} token
 */
export async function adminTables(token) {
  if (!token) return { ...NO_TOKEN, tables: [] };
  const res = await getJson('/auth/admin/tables', { token });
  if (!res.ok) return { ok: false, code: res.code, message: res.message, tables: [] };
  return { ok: true, tables: Array.isArray(res.data.tables) ? res.data.tables : [] };
}

/**
 * 管理员：强制解散牌局
 * POST /auth/admin/tables/:tableId/close
 */
export async function adminCloseTable(token, tableId) {
  if (!token) return NO_TOKEN;
  const res = await postJson(`/auth/admin/tables/${encodeURIComponent(String(tableId))}/close`, {}, { token });
  if (!res.ok) return { ok: false, code: res.code, message: res.message };
  return { ok: true };
}

/**
 * 管理员：把某个玩家踢出牌桌
 * POST /auth/admin/tables/:tableId/kick { userId }
 */
export async function adminKickUser(token, tableId, userId) {
  if (!token) return NO_TOKEN;
  const res = await postJson(
    `/auth/admin/tables/${encodeURIComponent(String(tableId))}/kick`,
    { userId: String(userId) },
    { token },
  );
  if (!res.ok) return { ok: false, code: res.code, message: res.message };
  return { ok: true };
}

/**
 * 管理员：全站战绩（入池率/胜率/摊牌率/摊牌胜率）
 * GET /auth/admin/stats?q=&limit=&offset= → { ok, total, stats }
 */
export async function adminStats(token, options = {}) {
  if (!token) return { ...NO_TOKEN, stats: [], total: 0 };
  const qs = new URLSearchParams({
    limit: String(options.limit ?? 100),
    offset: String(options.offset ?? 0),
  });
  if (options.q) qs.set('q', String(options.q));
  const res = await getJson(`/auth/admin/stats?${qs}`, { token });
  if (!res.ok) return { ok: false, code: res.code, message: res.message, stats: [], total: 0 };
  return {
    ok: true,
    total: Number(res.data.total ?? 0),
    stats: Array.isArray(res.data.stats) ? res.data.stats : [],
  };
}

/**
 * 我的战绩
 * GET /auth/me/stats → { ok, stats }
 */
export async function myStats(token) {
  if (!token) return NO_TOKEN;
  const res = await getJson('/auth/me/stats', { token });
  if (!res.ok) return { ok: false, code: res.code, message: res.message };
  return { ok: true, stats: res.data.stats ?? null };
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
