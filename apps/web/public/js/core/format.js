/**
 * 纯展示用格式化（不依赖 DOM，可单测）
 */

const SUIT_ORDER = { s: 0, h: 1, d: 2, c: 3 };

/**
 * 筹码简写：1000 → 1k，12500 → 12.5k，1500000 → 1.5m
 * 与 packages/shared/format.js 的 formatChips 结果一致（此处避免跨包 import）
 * @param {number} n
 * @returns {string}
 */
export function chips(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '0';
  if (v < 1000) return String(Math.floor(v));
  if (v < 1_000_000) {
    const k = v / 1000;
    return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, '')}k`;
  }
  const m = v / 1_000_000;
  return m >= 100 ? `${Math.round(m)}m` : `${m.toFixed(1).replace(/\.0$/, '')}m`;
}

/**
 * 千分位（下注输入框旁显示完整数字用）
 * @param {number} n
 * @returns {string}
 */
export function fullChips(n) {
  const v = Math.floor(Number(n) || 0);
  return v.toLocaleString('en-US');
}

/**
 * 占底池百分比：50/200 → "25%"
 * @param {number} amount
 * @param {number} pot
 * @returns {string}
 */
export function potPercent(amount, pot) {
  if (!Number.isFinite(amount) || !Number.isFinite(pot) || pot <= 0) return '0%';
  return `${Math.round((amount / pot) * 100)}%`;
}

/**
 * 毫秒 → "12s"
 * @param {number} ms
 * @returns {string}
 */
export function seconds(ms) {
  const s = Math.max(0, Math.ceil(Number(ms) / 1000));
  return `${s}s`;
}

/**
 * 牌面显示：'As' → 'A♠'，未知牌 → '?'
 * @param {string} card
 * @returns {string}
 */
export function cardText(card) {
  if (typeof card !== 'string' || card.length !== 2) return '?';
  const rank = card[0];
  const suit = card[1];
  const glyph = { s: '♠', h: '♥', d: '♦', c: '♣' }[suit] ?? '?';
  return `${rank}${glyph}`;
}

/**
 * 牌是否红色（用于着色）
 * @param {string} card
 * @returns {boolean}
 */
export function isRedCard(card) {
  return typeof card === 'string' && (card[1] === 'h' || card[1] === 'd');
}

/**
 * 座位牌排序：按花色再点数，仅影响展示顺序
 * @param {string[]} cards
 * @returns {string[]}
 */
export function sortCards(cards) {
  return [...(cards ?? [])].sort((a, b) => {
    const sa = SUIT_ORDER[a?.[1]] ?? 9;
    const sb = SUIT_ORDER[b?.[1]] ?? 9;
    if (sa !== sb) return sa - sb;
    return (b?.[0] ?? '').localeCompare(a?.[0] ?? '');
  });
}

/**
 * 时间戳 → HH:MM:SS（牌局日志用）
 * @param {number} ts
 * @returns {string}
 */
export function clock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 把 stake 配置显示成 "10/20 · 6人桌"
 * @param {{smallBlind?:number,bigBlind?:number,maxSeats?:number}} cfg
 * @returns {string}
 */
export function stakeText(cfg) {
  const sb = cfg?.smallBlind ?? 10;
  const bb = cfg?.bigBlind ?? 20;
  const seats = cfg?.maxSeats ?? 6;
  const ante = Number(cfg?.ante ?? 0);
  const anteText = ante > 0 ? ` ante ${ante}` : '';
  return `${sb}/${bb}${anteText} · ${seats}人桌`;
}

/**
 * 相对时间："刚刚" / "3 分钟前"
 * @param {number} ts
 * @param {number} [now]
 * @returns {string}
 */
export function ago(ts, now = Date.now()) {
  const diff = Math.max(0, now - (Number(ts) || 0));
  if (diff < 60_000) return '刚刚';
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/**
 * 比率 → 百分比文案；分母为 0（没有样本）时显示「—」
 * @param {number} rate 0~1
 * @param {number} base 样本数（手数/摊牌数）
 * @returns {string}
 */
export function percent(rate, base) {
  if (!Number(base)) return '—';
  return `${(Number(rate ?? 0) * 100).toFixed(1)}%`;
}
