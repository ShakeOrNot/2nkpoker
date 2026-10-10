/**
 * 计算 amount 占 pot 的百分比，返回整数字符串
 * @param {number} amount
 * @param {number} pot
 * @returns {string} 例如 "50%"、"120%"、"0%"
 */
export function potPercent(amount, pot) {
  if (!Number.isFinite(amount) || !Number.isFinite(pot) || pot <= 0) return '0%';
  const pct = Math.round((amount / pot) * 100);
  return `${pct}%`;
}

/**
 * 把筹码数格式化成短字符串（1k、1.2k、1m），用于大厅和牌桌显示
 * @param {number} n
 * @returns {string}
 */
export function formatChips(n) {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(Math.floor(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  const m = n / 1_000_000;
  return m >= 100 ? `${Math.round(m)}m` : `${m.toFixed(1).replace(/\.0$/, '')}m`;
}

/**
 * 时间戳（毫秒）转 "30s" / "1m" / "1h"
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}