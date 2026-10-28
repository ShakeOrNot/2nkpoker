/**
 * 登录失败限流 / 锁定（单进程内存实现）。
 *
 * 规则：
 *  - 同一账号（昵称小写）连续失败 MAX_ATTEMPTS 次 → 锁 LOCK_MS
 *  - 同一 IP 在 IP_WINDOW_MS 内失败超过 IP_MAX_ATTEMPTS 次 → 同样拒绝
 *  - 登录成功会清掉账号维度的计数
 *
 * 多实例部署时要换成 Redis（现在就是单进程，够用）。
 */

import { env } from '../env.js';

const MAX_ATTEMPTS = env.AUTH_MAX_ATTEMPTS;
const LOCK_MS = env.AUTH_LOCK_MS;
const WINDOW_MS = env.AUTH_WINDOW_MS;
const IP_MAX_ATTEMPTS = env.AUTH_IP_MAX_ATTEMPTS;

/** @type {Map<string, { count: number, firstAt: number, lockUntil: number }>} */
const buckets = new Map();

const now = () => Date.now();
const accountKey = (nickname) => `u:${String(nickname ?? '').trim().toLowerCase()}`;
const ipKey = (ip) => `ip:${String(ip ?? 'unknown')}`;

/**
 * 取/建一个桶，并顺手清掉过期状态
 * @param {string} key
 * @param {number} t
 */
function bucketOf(key, t) {
  let b = buckets.get(key);
  if (!b) {
    b = { count: 0, firstAt: t, lockUntil: 0 };
    buckets.set(key, b);
  }
  if (b.lockUntil && b.lockUntil <= t) {
    b.lockUntil = 0;
    b.count = 0;
    b.firstAt = t;
  }
  if (!b.lockUntil && b.count > 0 && t - b.firstAt > WINDOW_MS) {
    b.count = 0;
    b.firstAt = t;
  }
  return b;
}

/**
 * 现在允许尝试登录吗？
 * @param {{ nickname?: string, ip?: string }} subject
 * @returns {{ ok: boolean, code?: string, retryAfterMs?: number }}
 */
export function checkLoginAllowed({ nickname = '', ip = '' } = {}) {
  const t = now();
  const acc = bucketOf(accountKey(nickname), t);
  if (acc.lockUntil > t) {
    return { ok: false, code: 'AUTH_LOCKED', retryAfterMs: acc.lockUntil - t };
  }
  const byIp = bucketOf(ipKey(ip), t);
  if (byIp.count >= IP_MAX_ATTEMPTS) {
    return { ok: false, code: 'RATE_LIMITED', retryAfterMs: Math.max(0, byIp.firstAt + WINDOW_MS - t) };
  }
  return { ok: true };
}

/**
 * 记一次失败；返回是否因此被锁
 * @param {{ nickname?: string, ip?: string }} subject
 * @returns {{ locked: boolean, retryAfterMs: number }}
 */
export function recordLoginFailure({ nickname = '', ip = '' } = {}) {
  const t = now();
  const acc = bucketOf(accountKey(nickname), t);
  acc.count += 1;
  if (acc.count >= MAX_ATTEMPTS) {
    acc.lockUntil = t + LOCK_MS;
    acc.count = 0;
    acc.firstAt = t;
  }
  const byIp = bucketOf(ipKey(ip), t);
  byIp.count += 1;

  return { locked: acc.lockUntil > t, retryAfterMs: acc.lockUntil > t ? acc.lockUntil - t : 0 };
}

/**
 * 登录成功：清账号维度计数（IP 维度保留，防同一 IP 换号爆破）
 * @param {string} nickname
 */
export function clearLoginFailures(nickname) {
  buckets.delete(accountKey(nickname));
}

/** 测试用：清空所有计数 */
export function resetRateLimit() {
  buckets.clear();
}

/** 测试/排查用：看看某个账号当前状态 */
export function peekRateLimit(nickname) {
  const b = buckets.get(accountKey(nickname));
  return b ? { ...b } : null;
}
