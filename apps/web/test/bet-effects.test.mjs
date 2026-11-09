import { describe, it, expect } from 'vitest';
import { BetEffects, betSnapshot, betTransitions } from '../public/js/views/bet-effects.js';

function hand(street = 'PREFLOP', bets = [0, 0], committed = bets, version = 1) {
  return { handId: 'h1', street, version, seats: bets.map((bet, seat) => ({ seat, betThisStreet: bet, totalCommitted: committed[seat] })) };
}
const snap = h => betSnapshot('t1', h);

describe('下注与收池反馈', () => {
  it('初次进入或重复快照不重播下注', () => {
    const state = snap(hand('FLOP', [40, 40], [140, 140]));
    expect(betTransitions(null, state)).toEqual([]);
    expect(betTransitions(state, state)).toEqual([]);
  });
  it('下注、跟注和加注只呈现新增投入，不把加注到的总额重复飞入', () => {
    const first = snap(hand('PREFLOP', [40, 0], [40, 0], 2));
    expect(betTransitions(snap(hand()), first)).toEqual([{ type: 'bet', seat: 0, amount: 40 }]);
    const call = snap(hand('PREFLOP', [40, 40], [40, 40], 3));
    expect(betTransitions(first, call)).toEqual([{ type: 'bet', seat: 1, amount: 40 }]);
    expect(betTransitions(call, snap(hand('PREFLOP', [120, 40], [120, 40], 4)))).toEqual([{ type: 'bet', seat: 0, amount: 80 }]);
  });
  it('换街只收本街下注，累计投入不重复进入底池', () => {
    const old = snap(hand('FLOP', [40, 80], [140, 180], 5));
    expect(betTransitions(old, snap(hand('TURN', [0, 0], [140, 180], 6)))).toEqual([
      { type: 'collect', seat: 0, amount: 40 }, { type: 'collect', seat: 1, amount: 80 },
    ]);
  });
  it('新一手、另一房间、结算和过期版本不播旧下注', () => {
    const old = snap(hand('FLOP', [40, 40], [40, 40], 5));
    expect(betTransitions(old, betSnapshot('t2', hand()))).toEqual([]);
    expect(betTransitions(old, snap({ ...hand(), handId: 'h2' }))).toEqual([]);
    expect(betTransitions(old, snap({ ...hand('FLOP', [80, 40], [80, 40], 6), settled: true }))).toEqual([]);
    expect(betTransitions(old, snap(hand('FLOP', [80, 40], [80, 40], 4)))).toEqual([]);
  });
  it('跟注与换街合并时仍收齐最后一笔，不混入新街下注', () => {
    const old = snap(hand('PREFLOP', [40, 0], [40, 0], 2));
    expect(betTransitions(old, snap(hand('FLOP', [0, 0], [40, 40], 3)))).toEqual([
      { type: 'collect', seat: 0, amount: 40 }, { type: 'collect', seat: 1, amount: 40 },
    ]);
    expect(betTransitions(old, snap(hand('FLOP', [20, 0], [60, 40], 4)))).toEqual([
      { type: 'collect', seat: 0, amount: 40 }, { type: 'collect', seat: 1, amount: 40 },
      { type: 'bet', seat: 0, amount: 20 },
    ]);
  });
  it('换街发生未跟注返还时不收走已经退回的筹码', () => {
    expect(betTransitions(snap(hand('FLOP', [100, 40], [200, 140], 5)),
      snap(hand('TURN', [0, 0], [140, 140], 6)))).toEqual([
      { type: 'collect', seat: 0, amount: 40 }, { type: 'collect', seat: 1, amount: 40 },
    ]);
  });
  it('补码、退回或仅修改下注显示不冒充新增投入', () => {
    const old = snap(hand('FLOP', [40, 40], [140, 140], 5));
    expect(betTransitions(old, snap(hand('FLOP', [80, 40], [140, 140], 6)))).toEqual([]);
    expect(betTransitions(old, snap(hand('FLOP', [20, 40], [120, 140], 6)))).toEqual([]);
  });
  it('记录的是公开数值副本，源对象后续修改不影响比较基线', () => {
    const source = hand();
    const old = snap(source);
    source.seats[0].betThisStreet = 40; source.seats[0].totalCommitted = 40;
    expect(old.seats[0].bet).toBe(0);
    expect(betTransitions(old, snap(source))).toEqual([{ type: 'bet', seat: 0, amount: 40 }]);
  });
  it('离桌或重置清理活动层和待清理计时器', () => {
    const host = document.createElement('div');
    const effects = new BetEffects(host);
    const layer = document.createElement('div'); host.appendChild(layer);
    effects.batches.add({ layer, timer: setTimeout(() => {}, 1000) });
    effects.previous = snap(hand());
    effects.disconnect();
    expect(effects.batches.size).toBe(0);
    expect(effects.previous).toBeNull();
    expect(host.children.length).toBe(0);
  });
  it('连续下注层可并存，重复快照不增层，收池清掉旧层并合并提示', () => {
    const previousSize = [window.innerWidth, window.innerHeight];
    window.innerWidth = 1000; window.innerHeight = 800;
    const host = document.createElement('div');
    const effects = new BetEffects(host);
    effects.preference = { matches: false };
    const rectNode = (x, y) => {
      const el = document.createElement('div');
      el.getBoundingClientRect = () => ({ left: x, top: y, width: 40, height: 30 });
      return el;
    };
    const stage = rectNode(0, 0);
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, right: 1000, bottom: 700 });
    const names = [rectNode(100, 400), rectNode(700, 400)];
    const seats = new Map(names.map((name, i) => [i, { querySelector: () => name }]));
    const targets = new Map([[0, rectNode(250, 300)], [1, rectNode(550, 300)]]);
    const pot = rectNode(400, 200);
    try {
      effects.connect(stage);
      effects.update('t1', hand(), seats, targets, pot);
      const bet = hand('PREFLOP', [40, 0], [40, 0], 2);
      effects.update('t1', bet, seats, targets, pot);
      expect(effects.batches.size).toBe(1);
      effects.update('t1', bet, seats, targets, pot);
      expect(effects.batches.size).toBe(1);
      effects.update('t1', hand('PREFLOP', [40, 40], [40, 40], 3), seats, targets, pot);
      expect(effects.batches.size).toBe(2);
      effects.update('t1', hand('FLOP', [0, 0], [40, 40], 4), seats, targets, pot);
      expect(effects.batches.size).toBe(1);
      const layer = [...effects.batches][0].layer;
      expect(layer.children.length).toBe(5);
      expect(layer.children[2].textContent).toBe('收池 +80');
    } finally {
      effects.disconnect();
      [window.innerWidth, window.innerHeight] = previousSize;
    }
  });
});
