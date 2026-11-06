#!/usr/bin/env node
/**
 * 生成起手牌数据表：
 *   apps/game-server/src/users/hand-odds.json
 *
 * 内容（169 类起手牌）：
 *   - equity：vs 1 个对手的翻前胜率，来源 169hands.com（精确枚举）
 *   - probs：随机发 5 张公共牌后，最终最佳牌型落在 10 类的概率（蒙特卡洛）
 *   - mu / sigma：按 w_i = 1 - log10(P(>=i)) 权重算出的理论均值/标准差
 *
 * 用法：node scripts/build-hand-odds.mjs [--samples 20000]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate7, makeDeck } from '../packages/poker-engine/src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const csvPath = resolve(root, 'apps/game-server/data/169hands-equity.csv');
const outPath = resolve(root, 'apps/game-server/src/users/hand-odds.json');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
/** 每类模拟多少块牌（20k 精度约 ±0.1%） */
const SAMPLES = Math.max(1000, Math.floor(arg('--samples', 20000)));

/** 近似 7 张牌最佳牌型概率（高牌…皇家同花顺），用于算权重 */
const CATEGORY_PROBS = [
  0.17411915, // 高牌
  0.43822546, // 一对
  0.23495536, // 两对
  0.04829870, // 三条
  0.04619382, // 顺子
  0.03025494, // 同花
  0.02596102, // 葫芦
  0.00168067, // 四条
  0.00027851, // 同花顺（不含皇家）
  0.00003232, // 皇家同花顺
];

/** w_i = 1 - log10(P(最终牌型 >= i))；高牌权重固定 1 */
function buildWeights(probs) {
  const weights = [];
  let cum = 0;
  for (let i = probs.length - 1; i >= 0; i--) {
    cum += probs[i];
    if (i === 0) weights[i] = 1; // P>=高牌 = 100%
    else weights[i] = 1 - Math.log10(cum);
  }
  return weights;
}

/* ---------------- 读取 169hands 的 equity ---------------- */
async function loadEquityTable() {
  let text;
  if (existsSync(csvPath)) {
    text = readFileSync(csvPath, 'utf8');
  } else {
    const res = await fetch('https://169hands.com/169hands-equity.csv');
    if (!res.ok) throw new Error(`下载 equity 表失败：HTTP ${res.status}`);
    text = await res.text();
    mkdirSync(dirname(csvPath), { recursive: true });
    writeFileSync(csvPath, text);
    console.log(`已缓存 ${csvPath}`);
  }
  const rows = new Map();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = t.split(',');
    if (parts.length < 12) continue;
    const hand = parts[1];
    // 第 5~12 列：vs 1~8 个对手
    const equities = parts.slice(4, 12).map((x) => Number(x) / 100);
    if (!hand || !equities.every((x) => Number.isFinite(x))) continue;
    rows.set(hand, { equity: equities[0], equityByPlayers: equities });
  }
  return rows;
}

/* ---------------- 牌型分布模拟 ---------------- */
const RANK_ORDER = '23456789TJQKA';
const SUITS = ['s', 'h', 'd', 'c'];

/**
 * 生成某类起手牌的代表底牌
 * @param {string} cls 例如 AA / AKs / AKo
 */
function holeCardsOf(cls) {
  if (cls.length === 2) return [`${cls[0]}s`, `${cls[1]}h`];
  const [a, b, suffix] = [cls[0], cls[1], cls[2]];
  return suffix === 's' ? [`${a}s`, `${b}s`] : [`${a}s`, `${b}h`];
}

/** 确定性 PRNG，保证重跑结果一致 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 模拟某类起手牌最终牌型分布
 * @param {string} cls
 * @param {number} samples
 */
function simulateClass(cls, samples) {
  const hole = holeCardsOf(cls);
  const deck = makeDeck().filter((c) => !hole.includes(c));
  const rand = mulberry32(
    [...cls].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7),
  );
  const counts = new Array(10).fill(0);
  const board = [];
  for (let i = 0; i < samples; i++) {
    // 从 50 张里随机抽 5 张（部分 Fisher-Yates，不动原数组）
    const picked = new Set();
    while (picked.size < 5) picked.add(Math.floor(rand() * deck.length));
    board.length = 0;
    for (const idx of picked) board.push(deck[idx]);
    const hv = evaluate7([...hole, ...board]);
    counts[hv.category] += 1;
  }
  return counts.map((n) => n / samples);
}

/* ---------------- 主流程 ---------------- */
const equity = await loadEquityTable();
if (equity.size !== 169) throw new Error(`equity 表不是 169 行：${equity.size}`);

const weights = buildWeights(CATEGORY_PROBS);
const hands = {};
const classes = [...equity.keys()];

// 只更新多人 equity 时可用 --reuse：复用上次模拟出来的 probs/mu/sigma
const REUSE = process.argv.includes('--reuse');
const old = REUSE && existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : null;

for (let i = 0; i < classes.length; i++) {
  const cls = classes[i];
  const eq = equity.get(cls);
  let probs;
  let mu;
  let sigma;
  if (old?.hands?.[cls]?.probs?.length === 10) {
    probs = old.hands[cls].probs;
    mu = old.hands[cls].mu;
    sigma = old.hands[cls].sigma;
  } else {
    probs = simulateClass(cls, SAMPLES);
    mu = 0;
    for (let k = 0; k < 10; k++) mu += probs[k] * weights[k];
    let variance = 0;
    for (let k = 0; k < 10; k++) variance += probs[k] * (weights[k] - mu) ** 2;
    sigma = Math.sqrt(variance);
  }
  hands[cls] = {
    equity: eq.equity,
    equityByPlayers: eq.equityByPlayers,
    probs,
    mu,
    sigma,
  };
  if (!old && (i + 1) % 20 === 0) console.log(`模拟进度 ${i + 1}/${classes.length}`);
}

const out = {
  meta: {
    source: '169hands.com',
    sourceUrl: 'https://169hands.com/169hands-equity.csv',
    equityMethod:
      'vs 1 opponent: exact enumeration (2,097,572,400 deals per hand); vs 2~8 opponents: Monte Carlo (169hands.com)',
    categoryProbs: CATEGORY_PROBS,
    weights,
    samples: SAMPLES,
    generatedAt: new Date().toISOString(),
    note: 'probs/mu/sigma 为蒙特卡洛估计，仅用于短期牌力偏差',
  },
  hands,
};

writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`写入 ${outPath}`);
console.log('权重:', weights.map((w) => w.toFixed(3)).join(' '));
console.log('样本数:', SAMPLES);
