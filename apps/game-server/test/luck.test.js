import './helpers/env.js';
import { describe, it, expect } from 'vitest';
import { initDb } from '../src/users/db.js';
import { createUser } from '../src/users/userStore.js';
import { recordHandStats } from '../src/users/statsStore.js';
import { luckForUser } from '../src/users/luck.js';
import { equityShares } from '../src/state/equity.js';
import { handClassOf } from '../src/state/handStats.js';

function seedUser() {
  initDb(':memory:');
  return createUser({ nickname: `luck_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, passwordHash: 'x' });
}

describe('跑马 equity', () => {
  it('河牌已定：皇家同花顺 100%', () => {
    const shares = equityShares({
      board: ['As', 'Ks', 'Qs', '2d', '7c'],
      seats: [
        { seat: 0, holeCards: ['Js', 'Ts'] },
        { seat: 1, holeCards: ['2c', '7d'] },
      ],
    });
    expect(shares.get(0)).toBe(1);
    expect(shares.get(1)).toBe(0);
  });

  it('转牌精确枚举：44 张河牌，AA 领先 KK', () => {
    const shares = equityShares({
      board: ['2c', '7d', '9h', 'Jd'],
      seats: [
        { seat: 0, holeCards: ['As', 'Ah'] },
        { seat: 1, holeCards: ['Ks', 'Kh'] },
      ],
    });
    const a = shares.get(0);
    const b = shares.get(1);
    expect(a + b).toBeCloseTo(1, 6);
    expect(a).toBeGreaterThan(0.8);
  });

  it('翻前蒙特卡洛：AA vs KK 在合理区间', () => {
    const shares = equityShares({
      board: [],
      seats: [
        { seat: 0, holeCards: ['As', 'Ah'] },
        { seat: 1, holeCards: ['Ks', 'Kh'] },
      ],
      samples: 8000,
    });
    const a = shares.get(0);
    expect(a).toBeGreaterThan(0.72);
    expect(a).toBeLessThan(0.9);
  });
});

describe('起手牌归类', () => {
  it('AA / AKs / AKo', () => {
    expect(handClassOf(['As', 'Ah'])).toBe('AA');
    expect(handClassOf(['As', 'Ks'])).toBe('AKs');
    expect(handClassOf(['Ad', 'Kh'])).toBe('AKo');
    expect(handClassOf(['7s', '2d'])).toBe('72o');
  });
});

describe('Lucky / Unlucky', () => {
  it('三项指标各取最大/最小；手牌需 10 手样本', () => {
    const u = seedUser();
    const uid = u.id;
    const rows = [];
    let seq = 0;
    const push = (over) => {
      seq += 1;
      rows.push({
        handId: `${uid}_${seq}`,
        userId: uid,
        tableId: 't',
        at: seq,
        vpip: 0,
        showdown: 0,
        won: 0,
        showdownWon: 0,
        net: 0,
        ...over,
      });
    };

    // 跑马：两手，一好一坏
    push({ handId: `${uid}_r1`, allin: 1, pot: 1000, invested: 500, equityAllin: 0.2, expectedNet: 100, net: 500, won: 1, handClass: 'AA', category: 'ONE_PAIR' });
    push({ handId: `${uid}_r2`, allin: 1, pot: 1000, invested: 500, equityAllin: 0.8, expectedNet: 300, net: -500, handClass: 'KK', category: 'HIGH_CARD' });

    // 胜率 + 牌力：AA 10 手全胜且都是四条；72o 10 手全败且都是高牌
    for (let i = 0; i < 10; i++) {
      push({ handClass: 'AA', won: 1, net: 10, category: 'FOUR_OF_A_KIND', categoryWeight: 3.7 });
    }
    for (let i = 0; i < 10; i++) {
      push({ handClass: '72o', won: 0, net: -10, category: 'HIGH_CARD', categoryWeight: 1 });
    }

    recordHandStats(rows);
    const luck = luckForUser(uid);

    const luckyRunout = luck.lucky.find((x) => x.kind === 'runout');
    expect(luckyRunout.deviation).toBe(400);
    expect(luckyRunout.handClass).toBe('AA');

    const unluckyRunout = luck.unlucky.find((x) => x.kind === 'runout');
    expect(unluckyRunout.deviation).toBe(-800);
    expect(unluckyRunout.handClass).toBe('KK');

    const luckyWin = luck.lucky.find((x) => x.kind === 'winrate');
    expect(luckyWin.handClass).toBe('AA');

    const unluckyWin = luck.unlucky.find((x) => x.kind === 'winrate');
    expect(unluckyWin.handClass).toBe('72o');

    const luckyStrength = luck.lucky.find((x) => x.kind === 'strength');
    expect(luckyStrength.handClass).toBe('AA');
    const unluckyStrength = luck.unlucky.find((x) => x.kind === 'strength');
    expect(unluckyStrength.handClass).toBe('72o');

    // 样本不足的牌不参与排名
    for (let i = 0; i < 3; i++) push({ handClass: 'QQ', won: 1, net: 10 });
    recordHandStats([
      { handId: `${uid}_qq_${seq}`, userId: uid, tableId: 't', at: 99, handClass: 'QQ', won: 1, net: 10 },
    ]);
    const again = luckForUser(uid);
    expect(again.lucky.find((x) => x.kind === 'winrate').handClass).toBe('AA');
  });

  it('没有跑马记录时 lucky/unlucky 只含手牌两项', () => {
    const u = seedUser();
    recordHandStats([
      {
        handId: `${u.id}_a1`,
        userId: u.id,
        tableId: 't',
        at: 1,
        handClass: 'AA',
        won: 1,
        net: 10,
        category: 'ONE_PAIR',
        categoryWeight: 1.08,
      },
    ]);
    const luck = luckForUser(u.id);
    expect(luck.runoutCount).toBe(0);
    expect(luck.lucky.some((x) => x.kind === 'runout')).toBe(false);
    // 只有 1 手，达不到 10 手门槛，所以三个列表都为空
    expect(luck.lucky.length).toBe(0);
    expect(luck.unlucky.length).toBe(0);
  });
});
