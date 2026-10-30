/**
 * 纯逻辑层：所有"算一算"的事情都放这里，不碰 DOM、不碰网络，方便直接单测。
 *
 * 关键语义（与 docs/protocol.md 一致）：
 *   - bet / raise 的 amount 是"本街下注到的目标总额"，不是增量
 *   - 所有金额都是整数
 *   - raise 的目标必须 ≥ currentBet + minRaise
 */

import { MAX_SEATS, BUY_IN_BB, MAX_BUY_IN_UNITS, BLIND_LEVELS } from './constants.js';

/** 牌型中文名，索引与 poker-engine 的 Category 对齐 */
export const CATEGORY_NAMES = [
  '高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺', '皇家同花顺',
];

/** 位置顺序（按人数压缩），与 poker-engine/positions.js 一致 */
const POSITION_TABLE = {
  2: ['BTN', 'BB'],
  3: ['BTN', 'SB', 'BB'],
  4: ['BTN', 'SB', 'BB', 'UTG'],
  5: ['BTN', 'SB', 'BB', 'UTG', 'CO'],
  6: ['BTN', 'SB', 'BB', 'UTG', 'HJ', 'CO'],
};

/**
 * 按**桌子快照**算每个座位的位次名（不需要有进行中的手牌，等候室也能用）
 * 按钮位可能停在空座位上（还没开过手）→ 顺延到其后第一个有人坐的座位
 * @param {any} snapshot TableSnapshot
 * @returns {Map<number, string>} seat -> BTN/SB/BB/UTG/HJ/CO
 */
export function tablePositions(snapshot) {
  /** @type {Map<number, string>} */
  const map = new Map();
  const seats = (snapshot?.seats ?? [])
    .filter((s) => s.userId)
    .map((s) => s.seat)
    .sort((a, b) => a - b);
  const n = seats.length;
  const table = POSITION_TABLE[n];
  if (!table) return map;

  let btnIdx = seats.indexOf(snapshot.buttonSeat);
  if (btnIdx < 0) {
    const nextSeat = seats.find((s) => s > snapshot.buttonSeat);
    btnIdx = seats.indexOf(nextSeat ?? seats[0]);
  }
  seats.forEach((seat, i) => {
    map.set(seat, table[(((i - btnIdx) % n) + n) % n]);
  });
  return map;
}

/**
 * 某个座位的位次名（空座位返回空串）
 * @param {any} snapshot
 * @param {number|null} seat
 * @returns {string}
 */
export function tablePositionOf(snapshot, seat) {
  if (seat == null) return '';
  return tablePositions(snapshot).get(seat) ?? '';
}

/** 快捷按钮上的金额简写（与 core/format.js 的 chips() 同规则，此处自持以便纯逻辑单测） */
function shortChips(n) {
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

/* ------------------------------------------------------------------ *
 * 桌子 / 房间
 * ------------------------------------------------------------------ */

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/**
 * 生成牌局 ID：易读、无歧义字符（去掉 i l o 0 1）
 * @param {number} [len]
 * @returns {string}
 */
export function makeRoomId(len = 6) {
  let out = '';
  const buf = new Uint32Array(len);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < len; i++) buf[i] = Math.floor(Math.random() * 0xffffffff);
  }
  for (let i = 0; i < len; i++) out += ID_ALPHABET[buf[i] % ID_ALPHABET.length];
  return out;
}

export const ROOM_ID_RE = /^[A-Za-z0-9_-]{2,32}$/;

/**
 * @param {string} raw
 * @returns {boolean}
 */
export function isValidRoomId(raw) {
  return ROOM_ID_RE.test(String(raw ?? '').trim());
}

/**
 * 把用户输入规范化成 tableId（支持直接粘贴整条分享链接）
 * @param {string} raw
 * @returns {string}
 */
export function normalizeRoomInput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  const fromQuery = /[?&]table=([A-Za-z0-9_-]+)/.exec(text);
  if (fromQuery) return fromQuery[1];
  const fromHash = /#\/?table\/([A-Za-z0-9_-]+)/.exec(text);
  if (fromHash) return fromHash[1];
  return text;
}

/**
 * 生成分享链接
 * @param {string} baseUrl
 * @param {string} tableId
 * @returns {string}
 */
export function shareUrl(baseUrl, tableId) {
  const base = String(baseUrl || '').split('#')[0].split('?')[0];
  return `${base}?table=${encodeURIComponent(tableId)}`;
}

/**
 * 校验买入：必须是 1~50 个买入单位（1 个买入 = 100BB）
 * @param {number} buyIn
 * @param {number} [bigBlind]
 * @returns {{ ok: boolean, code?: string, message?: string }}
 */
export function validateBuyIn(buyIn, bigBlind = 20) {
  const v = Math.floor(Number(buyIn));
  const unit = Math.max(1, Number(bigBlind) || 20) * BUY_IN_BB;
  if (!Number.isFinite(v) || v < unit || v > unit * MAX_BUY_IN_UNITS || v % unit !== 0) {
    return {
      ok: false,
      code: 'INVALID_BUY_IN',
      message: `买入必须是整数个买入单位（1 个买入 = ${unit} 筹码 = 100BB），最多 ${MAX_BUY_IN_UNITS} 个`,
    };
  }
  return { ok: true };
}

/**
 * 校验自建牌局配置
 * @param {{ maxSeats?: number, smallBlind?: number, bigBlind?: number, buyIn?: number, ante?: number }} cfg
 * @returns {{ ok: boolean, code?: string, message?: string }}
 */
export function validateRoomConfig(cfg) {
  const seats = Number(cfg?.maxSeats ?? 6);
  if (!Number.isInteger(seats) || seats < 2 || seats > MAX_SEATS) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: '座位数只能是 2~6' };
  }
  const sb = Number(cfg?.smallBlind ?? 10);
  const bb = Number(cfg?.bigBlind ?? 20);
  if (!(sb > 0) || !(bb > sb)) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: '盲注设置不合法' };
  }
  const ante = Number(cfg?.ante ?? 5);
  if (!Number.isInteger(ante) || ante < 0 || ante > 1000) {
    return { ok: false, code: 'INVALID_PAYLOAD', message: '前注（ante）不合法' };
  }
  return validateBuyIn(cfg?.buyIn ?? bb * BUY_IN_BB, bb);
}

/**
 * 默认自建牌局配置：1 个买入 = 100BB，默认带 1 个买入
 * @param {number} [blindIndex]
 * @returns {{ maxSeats: number, smallBlind: number, bigBlind: number, ante: number, buyIn: number }}
 */
export function defaultRoomConfig(blindIndex = 0) {
  const level = BLIND_LEVELS[blindIndex] ?? BLIND_LEVELS[0];
  return {
    maxSeats: MAX_SEATS,
    smallBlind: level.smallBlind,
    bigBlind: level.bigBlind,
    ante: 5,
    buyIn: level.bigBlind * BUY_IN_BB,
  };
}

/* ------------------------------------------------------------------ *
 * 牌局状态
 * ------------------------------------------------------------------ */

/**
 * 手牌是否进行中
 * @param {any} hand
 * @returns {boolean}
 */
export function handRunning(hand) {
  return Boolean(hand) && !hand.settled;
}

/**
 * 正在参与本手牌（未弃牌）的座位
 * @param {any} hand
 * @returns {any[]}
 */
export function liveSeats(hand) {
  if (!hand?.seats) return [];
  return hand.seats.filter((s) => !s.folded);
}

/**
 * 我的座位对象
 * @param {any} hand
 * @param {number|null} seat
 * @returns {any|null}
 */
export function myHandSeat(hand, seat) {
  if (!hand?.seats || seat == null) return null;
  return hand.seats.find((s) => s.seat === seat) ?? null;
}

/**
 * 我需要跟注多少（已扣掉本街已下注）
 * @param {any} hand
 * @param {number|null} seat
 * @returns {number}
 */
export function toCallAmount(hand, seat) {
  const me = myHandSeat(hand, seat);
  if (!me) return 0;
  return Math.max(0, (hand.currentBet ?? 0) - (me.betThisStreet ?? 0));
}

/**
 * 我本街最多能下注到多少（= 我本街已下注 + 剩余筹码）
 * @param {any} hand
 * @param {number|null} seat
 * @returns {number}
 */
export function maxBetTarget(hand, seat) {
  const me = myHandSeat(hand, seat);
  if (!me) return 0;
  return (me.betThisStreet ?? 0) + (me.chips ?? 0);
}

/**
 * 全下金额（= 自己剩余筹码，天然不会超过筹码量）
 * @param {any} hand
 * @param {number|null} seat
 * @returns {number}
 */
export function allInAmount(hand, seat) {
  const me = myHandSeat(hand, seat);
  return me?.chips ?? 0;
}

/**
 * 下注目标是否合法
 * @param {any} hand
 * @param {number|null} seat
 * @param {number} target 本街下注到的总额
 * @returns {{ ok: boolean, code?: string, reason?: string, clamped: number }}
 */
export function validateBetAmount(hand, seat, target) {
  const me = myHandSeat(hand, seat);
  const max = maxBetTarget(hand, seat);
  if (!me) return { ok: false, code: 'NOT_SEATED', clamped: 0 };

  const t = Math.floor(Number(target));
  if (!Number.isFinite(t) || t < 0) {
    return { ok: false, code: 'BAD_AMOUNT', reason: '金额必须是正整数', clamped: 0 };
  }
  if (t > max) {
    return {
      ok: false,
      code: 'INSUFFICIENT_CHIPS',
      reason: `最多只能下到 ${max}（你的全部筹码）`,
      clamped: max,
    };
  }

  const isRaise = (hand.currentBet ?? 0) > 0;
  if (isRaise) {
    const minTarget = (hand.currentBet ?? 0) + (hand.minRaise ?? hand.bigBlind ?? 0);
    if (t < minTarget && t !== max) {
      return {
        ok: false,
        code: 'INVALID_ACTION',
        reason: `加注至少要到 ${minTarget}（或直接全下 ${max}）`,
        clamped: Math.min(minTarget, max),
      };
    }
  } else if (t < (hand.bigBlind ?? 1) && t !== max) {
    return {
      ok: false,
      code: 'INVALID_ACTION',
      reason: `下注不能小于大盲 ${hand.bigBlind}`,
      clamped: Math.min(hand.bigBlind ?? 0, max),
    };
  }
  return { ok: true, clamped: t };
}

/**
 * 按底池比例算出下注/加注目标（语义与 poker-engine/betSizing.js 一致）
 * @param {{ pot: number, fraction: number, currentBet: number, myBetThisStreet: number, chips: number, minRaise: number, bigBlind: number }} input
 * @returns {number} 本街下注到的目标额（已按筹码截断）
 */
export function potFractionTarget(input) {
  const pot = Math.max(0, Number(input.pot) || 0);
  const fraction = Number(input.fraction) || 0;
  const currentBet = Number(input.currentBet) || 0;
  const myBet = Number(input.myBetThisStreet) || 0;
  const chips = Number(input.chips) || 0;
  const minRaise = Number(input.minRaise) || 0;
  const bigBlind = Number(input.bigBlind) || 0;
  const toCall = Math.max(0, currentBet - myBet);

  let target;
  if (currentBet === 0) {
    target = Math.round(fraction * pot);
    if (target < bigBlind) target = bigBlind;
  } else {
    target = Math.round(currentBet + fraction * (pot + 2 * toCall));
    const minTarget = currentBet + minRaise;
    if (target < minTarget) target = minTarget;
  }
  const max = myBet + chips;
  return Math.min(target, max);
}

/**
 * 快捷下注比例（按底池的倍数）。
 * 顺序 = 界面上按钮的左右顺序：由小到大。
 * amount 的语义是"本街下注到的总额"，与 poker-engine/betSizing.js 的算法一致。
 */
const PRESETS = [
  { key: 'third', label: '1/3 池', fraction: 1 / 3 },
  { key: 'half', label: '半池', fraction: 0.5 },
  { key: 'twoThirds', label: '2/3 池', fraction: 2 / 3 },
  { key: 'full', label: '满池', fraction: 1 },
  { key: 'onePointTwo', label: '1.2 池', fraction: 1.2 },
];

/**
 * 生成快捷下注按钮：
 *   跟注 / 1/3 池 / 半池 / 2/3 池 / 满池 / 1.2 池 / 最小下注(加注) / 全下
 * 低于最小下注额或与自己筹码上限重复的项会被自动跳过（避免出现无效按钮）。
 * @param {any} hand
 * @param {number|null} seat
 * @returns {Array<{ key: string, label: string, amount: number, kind: 'call'|'preset'|'min'|'allin', fraction?: number }>}
 */
export function quickBets(hand, seat) {
  const me = myHandSeat(hand, seat);
  if (!me) return [];

  const out = [];
  const toCall = toCallAmount(hand, seat);
  const max = maxBetTarget(hand, seat);
  const isRaise = (hand.currentBet ?? 0) > 0;
  const minTarget = isRaise
    ? (hand.currentBet ?? 0) + (hand.minRaise ?? hand.bigBlind ?? 0)
    : (hand.bigBlind ?? 0);
  const base = {
    pot: hand.pot ?? 0,
    currentBet: hand.currentBet ?? 0,
    myBetThisStreet: me.betThisStreet ?? 0,
    chips: me.chips ?? 0,
    minRaise: hand.minRaise ?? hand.bigBlind ?? 0,
    bigBlind: hand.bigBlind ?? 0,
  };

  if (toCall > 0) {
    out.push({ key: 'call', label: `跟注 ${shortChips(toCall)}`, amount: 0, kind: 'call' });
  }

  for (const p of PRESETS) {
    const amount = potFractionTarget({ ...base, fraction: p.fraction });
    if (amount <= toCall) continue;   // 不足以加注
    if (amount >= max) continue;      // 与全下重复
    if (amount < minTarget) continue; // 不足最小加注
    out.push({
      key: p.key,
      label: `${p.label} ${shortChips(amount)}`,
      amount,
      kind: 'preset',
      fraction: p.fraction,
    });
  }

  const minAmount = Math.min(minTarget, max);
  if (minAmount > toCall && minAmount < max && !out.some((x) => x.amount === minAmount)) {
    out.push({
      key: 'min',
      label: `最小${isRaise ? '加注' : '下注'} ${shortChips(minAmount)}`,
      amount: minAmount,
      kind: 'min',
    });
  }

  if (max > 0) out.push({ key: 'allin', label: `全下 ${shortChips(max)}`, amount: max, kind: 'allin' });
  return out;
}

/**
 * 服务端没给 legalActions 时的兜底推导（与 poker-engine/actions.js 规则一致）
 * @param {any} hand
 * @param {number|null} seat
 * @returns {string[]}
 */
export function deriveLegalActions(hand, seat) {
  const me = myHandSeat(hand, seat);
  if (!me || me.folded || me.allIn) return [];
  if (hand.currentTurnSeat !== seat) return [];
  const toCall = toCallAmount(hand, seat);
  const out = ['fold'];
  if (toCall === 0) out.push('check');
  if (toCall > 0) out.push('call');
  if ((hand.currentBet ?? 0) === 0 && me.chips > 0) out.push('bet');
  if ((hand.currentBet ?? 0) > 0 && me.chips > toCall) out.push('raise');
  if (me.chips > 0) out.push('all_in');
  return out;
}

/**
 * 是否轮到我
 * @param {any} hand
 * @param {number|null} seat
 * @returns {boolean}
 */
export function isMyTurn(hand, seat) {
  return Boolean(hand) && !hand.settled && seat != null && hand.currentTurnSeat === seat;
}

/**
 * 我的位置名（BTN/SB/BB/UTG/HJ/CO）
 * @param {any} hand
 * @param {number|null} seat
 * @returns {string}
 */
export function positionOf(hand, seat) {
  if (!hand || seat == null || !hand.seats?.length) return '';
  const seats = [...hand.seats].map((s) => s.seat).sort((a, b) => a - b);
  const n = seats.length;
  const table = POSITION_TABLE[n];
  if (!table) return '';
  const idx = seats.indexOf(hand.buttonSeat);
  if (idx < 0) return '';
  const offset = ((seats.indexOf(seat) - idx) % n + n) % n;
  return table[offset] ?? '';
}

/* ------------------------------------------------------------------ *
 * 结算
 * ------------------------------------------------------------------ */

/**
 * 结算明细：谁赢、赢多少、净变化
 * @param {any} hand
 * @returns {{ rows: Array<any>, totalPaid: number, winnerSeats: number[], deadMoney: number }}
 */
export function settlement(hand) {
  const result = hand?.result;
  if (!result) return { rows: [], totalPaid: 0, winnerSeats: [], deadMoney: 0 };

  const payouts = result.payouts ?? {};
  const pots = result.pots ?? [];
  const totalPaid = pots.reduce((sum, p) => sum + (p.amount ?? 0), 0);

  const rows = (hand?.seats ?? []).map((s) => {
    const won = Number(payouts[s.seat] ?? 0);
    const committed = s.totalCommitted ?? 0;
    return {
      seat: s.seat,
      userId: s.userId,
      nickname: s.nickname || `座位 ${s.seat}`,
      won,
      committed,
      net: won - committed,
      folded: Boolean(s.folded),
      allIn: Boolean(s.allIn),
      isWinner: won > 0,
      /** 赢的钱不超过自己投入 → 只是把无人争的孤池退回来 */
      refundOnly: won > 0 && won <= committed,
      holeCards: result.revealed?.[s.seat] ?? [],
    };
  });

  rows.sort((a, b) => b.won - a.won || b.net - a.net);

  return {
    rows,
    totalPaid,
    winnerSeats: rows.filter((r) => r.won > 0 && !r.refundOnly).map((r) => r.seat),
    deadMoney: Math.max(0, totalPaid - rows.reduce((s, r) => s + r.won, 0)),
  };
}

/**
 * 一手牌里每个座位的净变化，用于在牌桌上直接显示 +/-
 * @param {any} hand 结算后的 hand（含 result）
 * @returns {Map<number, number>} seat -> 净变化
 */
export function chipDelta(hand) {
  /** @type {Map<number, number>} */
  const out = new Map();
  if (!hand?.result) return out;
  const payouts = hand.result.payouts ?? {};
  for (const s of hand.seats ?? []) {
    const committed = s.totalCommitted ?? 0;
    const won = Number(payouts[s.seat] ?? 0);
    const stackBefore = (s.chips ?? 0) - won + committed;
    out.set(s.seat, (s.chips ?? 0) - stackBefore);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 牌面格式互转（对接不同后端时用）
 * ------------------------------------------------------------------ */

/** 我们内部的写法是 rank + 字母花色：'As' / 'Td' / '2c' */

const SUIT_TO_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };

/** 符号花色 → 字母花色（同时接受本来就是字母的写法） */
const SYMBOL_TO_SUIT = {
  '♠': 's', '♥': 'h', '♦': 'd', '♣': 'c',
  s: 's', h: 'h', d: 'd', c: 'c',
  S: 's', H: 'h', D: 'd', C: 'c',
};

/**
 * 我们的牌 → 符号写法：'As' → 'A♠'
 * @param {string} card
 * @returns {string}
 */
export function cardToSymbol(card) {
  if (typeof card !== 'string' || card.length < 2) return String(card ?? '');
  const rank = card.slice(0, -1).toUpperCase();
  const suit = SUIT_TO_SYMBOL[card.slice(-1).toLowerCase()];
  return suit ? `${rank}${suit}` : String(card);
}

/**
 * 符号写法 → 我们的牌：'A♠' → 'As'；本来就是 'As' 时原样返回
 * @param {string} card
 * @returns {string} 无法识别时返回空串
 */
export function cardFromSymbol(card) {
  if (typeof card !== 'string') return '';
  const text = card.trim();
  if (!text) return '';
  if (text.length === 2) {
    const mapped = SYMBOL_TO_SUIT[text[1]];
    if (mapped) return `${text[0].toUpperCase()}${mapped}`;
  }
  // 兼容 '10♠' / '10s'
  const m = /^(10|[2-9TJQKA])\s*(.)$/i.exec(text);
  if (m) {
    const rank = m[1].toUpperCase() === '10' ? 'T' : m[1].toUpperCase();
    const mapped = SYMBOL_TO_SUIT[m[2]];
    if (mapped) return `${rank}${mapped}`;
  }
  return '';
}

/**
 * 整段牌数组转换（无法识别的会被丢掉）
 * @param {string[]} cards
 * @returns {string[]}
 */
export function cardsFromSymbols(cards) {
  if (!Array.isArray(cards)) return [];
  return cards.map(cardFromSymbol).filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * 牌型
 * ------------------------------------------------------------------ */

const RANK_VALUE = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

/**
 * 枚举 n 选 5 的全部组合
 * @param {string[]} cards
 * @returns {string[][]}
 */
export function combinations5(cards) {
  const out = [];
  const n = cards.length;
  if (n < 5) return out;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) out.push([cards[a], cards[b], cards[c], cards[d], cards[e]]);
  return out;
}

/**
 * 5 张牌的可比较值（与 poker-engine 的 evaluate5 规则一致）
 * @param {string[]} cards
 * @returns {{ category: number, tiebreakers: number[] }}
 */
export function evaluate5(cards) {
  const ranks = cards.map((c) => RANK_VALUE[c[0]] ?? 0).sort((a, b) => b - a);
  const isFlush = cards.every((c) => c[1] === cards[0][1]);
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const grouped = [...counts.entries()]
    .map(([rank, count]) => ({ rank, count }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
  const unique = [...new Set(ranks)].sort((a, b) => b - a);

  let straightHigh = 0;
  if (unique.length === 5) {
    if (unique[0] - unique[4] === 4) straightHigh = unique[0];
    else if (unique[0] === 14 && unique[1] === 5 && unique[2] === 4 && unique[3] === 3 && unique[4] === 2) {
      straightHigh = 5;
    }
  }

  if (isFlush && straightHigh === 14) return { category: 9, tiebreakers: [14] };
  if (isFlush && straightHigh) return { category: 8, tiebreakers: [straightHigh] };
  if (grouped[0].count === 4) return { category: 7, tiebreakers: [grouped[0].rank, grouped[1].rank] };
  if (grouped[0].count === 3 && grouped[1]?.count === 2) {
    return { category: 6, tiebreakers: [grouped[0].rank, grouped[1].rank] };
  }
  if (isFlush) return { category: 5, tiebreakers: ranks };
  if (straightHigh) return { category: 4, tiebreakers: [straightHigh] };
  if (grouped[0].count === 3) {
    return { category: 3, tiebreakers: [grouped[0].rank, ...grouped.slice(1).map((g) => g.rank)] };
  }
  if (grouped[0].count === 2 && grouped[1]?.count === 2) {
    const hi = Math.max(grouped[0].rank, grouped[1].rank);
    const lo = Math.min(grouped[0].rank, grouped[1].rank);
    return { category: 2, tiebreakers: [hi, lo, grouped[2].rank] };
  }
  if (grouped[0].count === 2) {
    return { category: 1, tiebreakers: [grouped[0].rank, ...grouped.slice(1).map((g) => g.rank)] };
  }
  return { category: 0, tiebreakers: ranks };
}

/**
 * 比较两手牌
 * @param {{category:number,tiebreakers:number[]}} a
 * @param {{category:number,tiebreakers:number[]}} b
 * @returns {number} a 更强大时返回正数
 */
export function compareHands(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  const len = Math.max(a.tiebreakers.length, b.tiebreakers.length);
  for (let i = 0; i < len; i++) {
    const av = a.tiebreakers[i] ?? 0;
    const bv = b.tiebreakers[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * 5~7 张里取最佳 5 张
 * @param {string[]} cards
 * @returns {{ category: number, tiebreakers: number[], bestFive: string[] }|null}
 */
export function evaluate7(cards) {
  if (!Array.isArray(cards) || cards.length < 5) return null;
  if (cards.length === 5) return { ...evaluate5(cards), bestFive: [...cards] };
  let best = null;
  let bestFive = null;
  for (const combo of combinations5(cards)) {
    const v = evaluate5(combo);
    if (!best || compareHands(v, best) > 0) {
      best = v;
      bestFive = combo;
    }
  }
  return best ? { ...best, bestFive } : null;
}

/**
 * 牌力数值化，供分层底池比较（越大越强）
 * @param {string[]} hole
 * @param {string[]} board
 * @returns {number}
 */
export function strengthOf(hole, board) {
  const v = evaluate7([...(hole ?? []), ...(board ?? [])]);
  if (!v) return -1;
  let n = v.category;
  for (const t of v.tiebreakers) n = n * 100 + t;
  return n;
}

/**
 * 用自己手牌 + 公共牌算出当前最好牌型名（纯展示，判定以服务端为准）
 * @param {string[]} holeCards
 * @param {string[]} board
 * @returns {{ category: number, name: string }|null}
 */
export function bestCategory(holeCards, board) {
  const v = evaluate7([...(holeCards ?? []).filter(Boolean), ...(board ?? []).filter(Boolean)]);
  if (!v) return null;
  return { category: v.category, name: CATEGORY_NAMES[v.category] ?? '' };
}

/**
 * 从正好 5 张牌算出的牌型编号，否则 -1
 * @param {string[]} cards
 * @returns {number}
 */
export function evaluateFive(cards) {
  return cards.length === 5 ? evaluate5(cards).category : -1;
}

/**
 * 按每个座位的累计投入切层，生成主池与边池
 * @param {Array<{seat:number,amount:number,folded:boolean}>} contributions
 * @returns {Array<{amount:number, eligibleSeats:number[]}>}
 */
export function buildPots(contributions) {
  if (!contributions?.length) return [];
  const levels = [...new Set(contributions.map((c) => c.amount))]
    .filter((a) => a > 0)
    .sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    const contributors = contributions.filter((c) => c.amount >= level);
    const amount = (level - prev) * contributors.length;
    const eligibleSeats = contributors
      .filter((c) => !c.folded)
      .map((c) => c.seat)
      .sort((a, b) => a - b);
    if (amount > 0) pots.push({ amount, eligibleSeats });
    prev = level;
  }
  return pots;
}

/**
 * 按牌力分配每一层底池（并列平分，余数给座位号最小者）
 * @param {Array<{amount:number, eligibleSeats:number[]}>} pots
 * @param {Map<number, number>} strengthBySeat
 * @returns {Map<number, number>} seat -> 赢得筹码
 */
export function awardPots(pots, strengthBySeat) {
  const winnings = new Map();
  const add = (seat, amount) => winnings.set(seat, (winnings.get(seat) ?? 0) + amount);
  for (const pot of pots) {
    if (!pot.eligibleSeats.length) continue;
    let best = -Infinity;
    for (const seat of pot.eligibleSeats) best = Math.max(best, strengthBySeat.get(seat) ?? -Infinity);
    const winners = pot.eligibleSeats
      .filter((seat) => (strengthBySeat.get(seat) ?? -Infinity) === best)
      .sort((a, b) => a - b);
    if (winners.length === 1) {
      add(winners[0], pot.amount);
      continue;
    }
    const share = Math.floor(pot.amount / winners.length);
    for (const seat of winners) add(seat, share);
    add(winners[0], pot.amount - share * winners.length);
  }
  return winnings;
}
