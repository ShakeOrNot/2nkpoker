import { compareHands, evaluate7, makeDeck } from '@2nkpoker/poker-engine';

/**
 * 计算"跑马"胜率份额：给定已发公共牌 + 仍在手玩家的底牌，
 * 枚举/模拟剩余公共牌，返回每个座位的期望赢池比例（平局平分）。
 *
 * 注意：按"总池平分"估算，没有拆边池；娱乐统计够用，不用于结算。
 *
 * @param {{ board: string[], seats: Array<{ seat: number, holeCards: string[] }>, samples?: number }} input
 * @returns {Map<number, number>} seat -> equity (0~1)
 */
export function equityShares({ board = [], seats = [], samples = 20000 }) {
  const live = seats.filter((s) => Array.isArray(s.holeCards) && s.holeCards.length === 2);
  const shares = new Map(live.map((s) => [s.seat, 0]));
  if (!live.length) return shares;

  const known = new Set([...board, ...live.flatMap((s) => s.holeCards)]);
  const deck = makeDeck().filter((c) => !known.has(c));
  const need = Math.max(0, 5 - board.length);

  let total = 0;
  const addRunout = (cards) => {
    const fullBoard = [...board, ...cards];
    const values = live.map((s) => ({
      seat: s.seat,
      hv: evaluate7([...s.holeCards, ...fullBoard]),
    }));
    let best = values[0];
    for (const x of values) if (compareHands(x.hv, best.hv) > 0) best = x;
    const winners = values.filter((x) => compareHands(x.hv, best.hv) === 0);
    const each = 1 / winners.length;
    for (const w of winners) shares.set(w.seat, shares.get(w.seat) + each);
    total += 1;
  };

  if (need === 0) {
    addRunout([]);
  } else {
    // 组合数不多 → 精确枚举（翻牌 990、转牌 44、河牌 1）
    const combos = combinationCount(deck.length, need);
    if (combos <= 3000) {
      enumerateCombos(deck, need, addRunout);
    } else {
      // 翻前 all-in：蒙特卡洛，2 万次约 ±0.5%
      for (let i = 0; i < samples; i++) {
        const picked = new Set();
        while (picked.size < need) picked.add(Math.floor(Math.random() * deck.length));
        addRunout([...picked].map((idx) => deck[idx]));
      }
    }
  }

  if (total === 0) return shares;
  for (const [seat, share] of shares) shares.set(seat, share / total);
  return shares;
}

/** C(n, k) */
function combinationCount(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/**
 * 枚举组合并回调
 * @param {string[]} arr
 * @param {number} k
 * @param {(picked: string[]) => void} onCombo
 */
function enumerateCombos(arr, k, onCombo) {
  const picked = [];
  const walk = (start, depth) => {
    if (depth === k) {
      onCombo([...picked]);
      return;
    }
    for (let i = start; i <= arr.length - (k - depth); i++) {
      picked.push(arr[i]);
      walk(i + 1, depth + 1);
      picked.pop();
    }
  };
  walk(0, 0);
}
