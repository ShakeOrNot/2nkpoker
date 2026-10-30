import { getDb } from './db.js';

/**
 * @typedef {Object} HandStatRow
 * @property {string} handId
 * @property {string} userId
 * @property {string} tableId
 * @property {number} at
 * @property {number} vpip
 * @property {number} showdown
 * @property {number} won
 * @property {number} showdownWon
 * @property {number} net
 */

/**
 * 一手牌结算后批量写入（同一手重复调用会被主键忽略）
 * @param {HandStatRow[]} rows
 * @returns {number} 实际写入行数
 */
export function recordHandStats(rows) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO player_hands
       (hand_id, user_id, table_id, played_at, vpip, showdown, won, showdown_won, net)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let written = 0;
  const tx = db.prepare('BEGIN');
  try {
    tx.run();
    for (const row of rows) {
      const res = stmt.run(
        row.handId,
        row.userId,
        row.tableId,
        row.at,
        row.vpip ? 1 : 0,
        row.showdown ? 1 : 0,
        row.won ? 1 : 0,
        row.showdownWon ? 1 : 0,
        Number(row.net) || 0,
      );
      written += Number(res.changes ?? 0);
    }
    db.prepare('COMMIT').run();
  } catch (err) {
    try {
      db.prepare('ROLLBACK').run();
    } catch {
      /* 忽略 */
    }
    throw err;
  }
  return written;
}

/**
 * 把聚合行转成接口用的形状（比率保留原始精度，前端格式化）
 * @param {any} row
 */
export function toStats(row) {
  const hands = Number(row?.hands ?? 0);
  const vpipHands = Number(row?.vpip_hands ?? 0);
  const wins = Number(row?.wins ?? 0);
  const showdowns = Number(row?.showdowns ?? 0);
  const showdownWins = Number(row?.showdown_wins ?? 0);
  const rate = (n, d) => (d > 0 ? n / d : 0);
  return {
    userId: row?.id ?? row?.user_id ?? null,
    nickname: row?.nickname ?? '',
    role: row?.role ?? 'user',
    hands,
    vpipHands,
    wins,
    showdowns,
    showdownWins,
    net: Number(row?.net ?? 0),
    lastPlayedAt: row?.last_played_at ?? null,
    vpipRate: rate(vpipHands, hands),
    winRate: rate(wins, hands),
    showdownRate: rate(showdowns, hands),
    showdownWinRate: rate(showdownWins, showdowns),
  };
}

const STATS_COLUMNS = `
  u.id, u.nickname, u.role,
  COUNT(p.hand_id) AS hands,
  COALESCE(SUM(p.vpip), 0) AS vpip_hands,
  COALESCE(SUM(p.won), 0) AS wins,
  COALESCE(SUM(p.showdown), 0) AS showdowns,
  COALESCE(SUM(p.showdown_won), 0) AS showdown_wins,
  COALESCE(SUM(p.net), 0) AS net,
  MAX(p.played_at) AS last_played_at`;

/**
 * 某个账号的历史战绩（没打过牌就是全 0）
 * @param {string} userId
 */
export function statsForUser(userId) {
  const row = getDb()
    .prepare(
      `SELECT ${STATS_COLUMNS}
       FROM users u
       LEFT JOIN player_hands p ON p.user_id = u.id
       WHERE u.id = ?
       GROUP BY u.id`,
    )
    .get(String(userId));
  return row ? toStats(row) : null;
}

/**
 * 所有账号的战绩（管理员面板用，支持昵称搜索/分页）
 * @param {{ q?: string, limit?: number, offset?: number }} [options]
 * @returns {Array<any>}
 */
export function listUserStats(options = {}) {
  const q = String(options.q ?? '').trim();
  const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));
  const offset = Math.max(0, Number(options.offset) || 0);
  const rows = getDb()
    .prepare(
      `SELECT ${STATS_COLUMNS}
       FROM users u
       LEFT JOIN player_hands p ON p.user_id = u.id
       WHERE (? = '' OR u.nickname LIKE ? COLLATE NOCASE)
       GROUP BY u.id
       ORDER BY hands DESC, u.created_at ASC
       LIMIT ? OFFSET ?`,
    )
    .all(q, q ? `%${q}%` : '', limit, offset);
  return rows.map(toStats);
}

/**
 * 清空战绩（测试/重置用）
 * @returns {number}
 */
export function clearAllStats() {
  const res = getDb().prepare('DELETE FROM player_hands').run();
  return Number(res.changes ?? 0);
}
