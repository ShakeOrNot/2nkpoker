import './helpers/env.js';
import { describe, it, expect } from 'vitest';
import { initDb } from '../src/users/db.js';
import { createUser } from '../src/users/userStore.js';
import { clearAllStats, listUserStats, recordHandStats, statsForUser } from '../src/users/statsStore.js';
import { recordHandResult, notePreflopAction, beginHandStats } from '../src/state/handStats.js';

/**
 * 建两个账号（昵称带唯一后缀：initDb(':memory:') 在同一路径下会复用同一个库，
 * 直接用 stats_a 会在第二个用例撞 UNIQUE）
 */
let seq = 0;
function seedUsers() {
  initDb(':memory:');
  const tag = `st${Date.now().toString(36)}${seq++}`;
  const a = createUser({ nickname: `${tag}_a`, passwordHash: 'x' });
  const b = createUser({ nickname: `${tag}_b`, passwordHash: 'x' });
  return { a, b, tag };
}

describe('战绩存取', () => {
  it('按用户聚合：手数 / 入池 / 胜率 / 摊牌 / 摊牌胜率', () => {
    const { a, b } = seedUsers();
    recordHandStats([
      // a：3 手，2 手入池，1 手赢，2 手摊牌、摊牌赢 1 次
      { handId: 's1', userId: a.id, tableId: 't', at: 1, vpip: 1, showdown: 1, won: 1, showdownWon: 1, net: 100 },
      { handId: 's2', userId: a.id, tableId: 't', at: 2, vpip: 0, showdown: 0, won: 0, showdownWon: 0, net: -20 },
      { handId: 's3', userId: a.id, tableId: 't', at: 3, vpip: 1, showdown: 1, won: 0, showdownWon: 0, net: -30 },
      // b：1 手，没入池，摊牌输
      { handId: 's1', userId: b.id, tableId: 't', at: 1, vpip: 0, showdown: 1, won: 0, showdownWon: 0, net: -50 },
    ]);

    const sa = statsForUser(a.id);
    expect(sa.hands).toBe(3);
    expect(sa.vpipHands).toBe(2);
    expect(Math.round(sa.vpipRate * 1000) / 1000).toBe(0.667);
    expect(Math.round(sa.winRate * 1000) / 1000).toBe(0.333);
    expect(Math.round(sa.showdownRate * 1000) / 1000).toBe(0.667);
    expect(sa.showdownWinRate).toBe(0.5);
    expect(sa.net).toBe(50);

    const sb = statsForUser(b.id);
    expect(sb.hands).toBe(1);
    expect(sb.vpipRate).toBe(0);
    expect(sb.showdownRate).toBe(1);
    expect(sb.showdownWinRate).toBe(0);

    // 没打过牌的账号：全 0
    const c = createUser({ nickname: 'solo_never_played', passwordHash: 'x' });
    const sc = statsForUser(c.id);
    expect(sc.hands).toBe(0);
    expect(sc.vpipRate).toBe(0);
  });

  it('列表按手数排序、支持搜索，0 手的账号也在列表里', () => {
    const { a, b, tag } = seedUsers();
    recordHandStats([
      { handId: 's4', userId: a.id, tableId: 't', at: 1, vpip: 1, showdown: 1, won: 1, showdownWon: 1, net: 10 },
      { handId: 's5', userId: a.id, tableId: 't', at: 2, vpip: 0, showdown: 0, won: 0, showdownWon: 0, net: -10 },
      { handId: 's4', userId: b.id, tableId: 't', at: 1, vpip: 0, showdown: 0, won: 0, showdownWon: 0, net: 0 },
    ]);
    const all = listUserStats({ q: tag, limit: 10 });
    expect(all.length).toBe(2);
    expect(all[0].nickname).toBe(a.nickname);
    expect(all[0].hands).toBe(2);
    expect(all[1].hands).toBe(1);

    const onlyB = listUserStats({ q: b.nickname });
    expect(onlyB.length).toBe(1);
    expect(onlyB[0].nickname).toBe(b.nickname);

    clearAllStats();
    const after = listUserStats({ q: tag, limit: 10 });
    expect(after.length).toBe(2); // 账号还在，只是手数为 0
    expect(after[0].hands).toBe(0);
  });

  it('同一手重复写入不会翻倍（INSERT OR IGNORE）', () => {
    const { a } = seedUsers();
    const row = { handId: 'dup', userId: a.id, tableId: 't', at: 1, vpip: 1, showdown: 1, won: 1, showdownWon: 1, net: 10 };
    recordHandStats([row]);
    recordHandStats([row]);
    expect(statsForUser(a.id).hands).toBe(1);
  });
});

describe('结算记账', () => {
  it('recordHandResult：从 handState 算出每人一行', () => {
    const { a, b } = seedUsers();
    const t = {
      tableId: 't1',
      handStats: { vpip: new Set([a.id]), at: 123 },
      handState: {
        handId: 'hand_x',
        settled: true,
        seats: [
          { seat: 0, userId: a.id, totalCommitted: 100 },
          { seat: 1, userId: b.id, totalCommitted: 100 },
        ],
        result: {
          payouts: { 0: 200 },
          revealed: { 0: ['As', 'Ks'], 1: ['2c', '7d'] },
          forcedWinnerSeat: null,
        },
      },
    };
    const written = recordHandResult(t);
    expect(written).toBe(2);

    const sa = statsForUser(a.id);
    expect(sa.hands).toBe(1);
    expect(sa.vpipHands).toBe(1);
    expect(sa.wins).toBe(1);
    expect(sa.showdowns).toBe(1);
    expect(sa.showdownWins).toBe(1);
    expect(sa.net).toBe(100);

    const sb = statsForUser(b.id);
    expect(sb.hands).toBe(1);
    expect(sb.vpipHands).toBe(0);
    expect(sb.wins).toBe(0);
    expect(sb.showdowns).toBe(1);
    expect(sb.showdownWins).toBe(0);
    expect(sb.net).toBe(-100);
  });

  it('notePreflopAction：跟注/加注算入池，过牌/弃牌不算', () => {
    const { a, b } = seedUsers();
    const t = {
      handState: { seats: [{ seat: 0, userId: a.id }, { seat: 1, userId: b.id }] },
    };
    beginHandStats(t);
    notePreflopAction(t, 0, 'call');
    notePreflopAction(t, 1, 'check');
    notePreflopAction(t, 0, 'fold');
    expect(t.handStats.vpip.has(a.id)).toBe(true);
    expect(t.handStats.vpip.has(b.id)).toBe(false);
  });
});
