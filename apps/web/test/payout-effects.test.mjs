import { describe, it, expect } from 'vitest';
import { PayoutEffects, payoutRecipients } from '../public/js/views/payout-effects.js';

const hand = {
  seats: [
    { seat: 0, totalCommitted: 100 },
    { seat: 1, totalCommitted: 200 },
    { seat: 2, totalCommitted: 300 },
  ],
  result: { payouts: { 0: 300, 1: 200, 2: 100 }, pots: [] },
};

function withGeometry(run) {
  const previous = { width: window.innerWidth, height: window.innerHeight, match: window.matchMedia };
  window.innerWidth = 1000; window.innerHeight = 800;
  window.matchMedia = () => ({ matches: false });
  const host = document.createElement('div');
  const pot = document.createElement('div');
  pot.getBoundingClientRect = () => ({ left: 400, top: 200, width: 100, height: 40 });
  const stage = document.createElement('div');
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 700, width: 1000 });
  const seat = document.createElement('div');
  seat.getBoundingClientRect = () => ({ left: 200, top: 350, width: 100, height: 70 });
  const effects = new PayoutEffects(host);
  try { run({ host, pot, stage, seat, effects }); }
  finally {
    effects.clear();
    window.innerWidth = previous.width; window.innerHeight = previous.height; window.matchMedia = previous.match;
  }
}

describe('牌桌派彩演出', () => {
  it('多层边池所有正数派彩都到账，退款和净亏损不冒充净赢', () => {
    expect(payoutRecipients(hand)).toEqual([
      { seat: 0, amount: 300, winner: true },
      { seat: 1, amount: 200, winner: false },
      { seat: 2, amount: 100, winner: false },
    ]);
  });
  it('从实际底池位置生成筹码，并在清理时移除层和高亮', () => withGeometry(({ host, pot, stage, seat, effects }) => {
    expect(effects.play(hand, pot, new Map([[0, seat]]), stage)).toBe(true);
    expect(host.children.length).toBe(1);
    expect(effects.layer.children.length).toBe(6);
    expect(effects.layer.children[0].children.length).toBe(4);
    expect(seat.classList.contains('seat-payout-winner')).toBe(true);
    effects.clear();
    expect(host.children.length).toBe(0);
    expect(effects.timer).toBeNull();
    expect(seat.classList.contains('seat-payout-winner')).toBe(false);
  }));
  it('屏外或被滚动区裁掉的座位不生成错误飞行目标', () => withGeometry(({ pot, stage, seat, effects }) => {
    seat.getBoundingClientRect = () => ({ left: 20, top: 720, width: 100, height: 70 });
    expect(effects.play(hand, pot, new Map([[0, seat]]), stage)).toBe(false);
  }));
  it('减少动态效果时直接跳过飞行', () => withGeometry(({ pot, stage, seat, effects }) => {
    window.matchMedia = () => ({ matches: true });
    expect(effects.play(hand, pot, new Map([[0, seat]]), stage)).toBe(false);
    expect(effects.layer).toBeNull();
  }));
});
