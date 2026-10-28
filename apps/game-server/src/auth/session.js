import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getDb } from '../users/db.js';
import { env } from '../env.js';

/** 刷新令牌有效期（毫秒），默认 7 天 */
export const REFRESH_TTL_MS = env.REFRESH_TTL_MS;

/**
 * @param {string} token
 * @returns {string}
 */
function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/**
 * 新建刷新令牌（只存 sha256，不存明文）
 * @param {string} userId
 * @param {{ rotatedFrom?: string|null }} [options]
 * @returns {{ token: string, expiresAt: number }}
 */
export function createRefreshToken(userId, { rotatedFrom = null } = {}) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = now + REFRESH_TTL_MS;
  getDb()
    .prepare(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, revoked_at, created_at, rotated_from)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(randomUUID(), userId, hashToken(token), expiresAt, now, rotatedFrom);
  return { token, expiresAt };
}

/**
 * @param {string} token
 * @returns {boolean} 是否真的撤销了一条
 */
export function revokeRefreshToken(token) {
  const res = getDb()
    .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(Date.now(), hashToken(token));
  return Number(res.changes ?? 0) > 0;
}

/**
 * 撤销某账号的全部刷新令牌（改密/重置/封禁时用）
 * @param {string} userId
 * @returns {number}
 */
export function revokeAllForUser(userId) {
  const res = getDb()
    .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
    .run(Date.now(), userId);
  return Number(res.changes ?? 0);
}

/**
 * 用旧令牌换新令牌（轮换）。
 * 已经用过的令牌再次出现 = 可能被盗用 → 撤销该账号全部刷新令牌。
 * @param {string} token
 * @returns {{ ok: true, userId: string, refreshToken: string, expiresAt: number } | { ok: false, reason: string }}
 */
export function consumeRefreshToken(token) {
  const db = getDb();
  const hash = hashToken(token);
  const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(hash);
  if (!row) return { ok: false, reason: 'AUTH_REFRESH_INVALID' };

  if (row.revoked_at) {
    revokeAllForUser(row.user_id);
    return { ok: false, reason: 'AUTH_REFRESH_INVALID' };
  }
  if (Number(row.expires_at) < Date.now()) {
    db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?').run(Date.now(), row.id);
    return { ok: false, reason: 'AUTH_REFRESH_INVALID' };
  }

  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?').run(Date.now(), row.id);
  const next = createRefreshToken(row.user_id, { rotatedFrom: row.id });
  return { ok: true, userId: row.user_id, refreshToken: next.token, expiresAt: next.expiresAt };
}

/**
 * 清理过期/久已撤销的令牌（启动时跑一次即可）
 * @returns {number}
 */
export function cleanupExpiredTokens(now = Date.now()) {
  const res = getDb()
    .prepare('DELETE FROM refresh_tokens WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)')
    .run(now, now - REFRESH_TTL_MS);
  return Number(res.changes ?? 0);
}
