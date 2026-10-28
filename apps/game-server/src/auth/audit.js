import { getDb } from '../users/db.js';

/**
 * 写一条审计记录（登录/注册/改密/刷新失败等）。
 * 审计失败不能影响主流程，所以内部吞异常。
 * @param {{ action: string, userId?: string|null, nickname?: string|null, ip?: string, ua?: string, ok: boolean }} entry
 */
export function writeAudit({ action, userId = null, nickname = null, ip = '', ua = '', ok }) {
  try {
    getDb()
      .prepare('INSERT INTO audit_log (at, action, user_id, nickname, ip, ua, ok) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), action, userId, nickname, String(ip ?? '').slice(0, 64), String(ua ?? '').slice(0, 120), ok ? 1 : 0);
  } catch {
    /* 审计失败忽略 */
  }
}

/**
 * @param {number} [limit]
 * @returns {any[]}
 */
export function listAudit(limit = 50) {
  return getDb().prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?').all(limit);
}
