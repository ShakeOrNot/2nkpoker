import { describe, it, expect } from 'vitest';
import { collectionGuard } from './preview-flow.mjs';

const hand = (bets, street = 'PREFLOP') => ({ street, seats: bets.map(bet => ({ betThisStreet: bet })) });
describe('收筹码预览流程', () => {
  it('直接点击空下注不改变手牌或推进街道', () => {
    const state = hand([0, 0]);
    const before = JSON.stringify(state);
    expect(collectionGuard(state).ok).toBe(false);
    expect(collectionGuard(state).message).toContain('没有下注');
    expect(JSON.stringify(state)).toBe(before);
  });
  it('未跟齐不允许清空下注', () => {
    expect(collectionGuard(hand([40, 0])).ok).toBe(false);
    expect(collectionGuard(hand([120, 40])).message).toContain('跟齐');
  });
  it('跟齐后允许收池，再点不会多跳一轮', () => {
    const state = hand([120, 120]);
    const result = collectionGuard(state);
    expect(result.ok).toBe(true);
    expect(result.total).toBe(240);
    expect(result.next).toBe('flop');
    state.street = 'FLOP'; state.seats.forEach(s => { s.betThisStreet = 0; });
    expect(collectionGuard(state).ok).toBe(false);
    expect(state.street).toBe('FLOP');
  });
  it('全下或弃牌者不被要求补齐，无牌局和河牌结束有明确提示', () => {
    const state = hand([120, 40]);
    state.seats[1].allIn = true;
    expect(collectionGuard(state).ok).toBe(true);
    state.seats[1].allIn = false; state.seats[1].folded = true;
    expect(collectionGuard(state).ok).toBe(true);
    expect(collectionGuard(null).message).toContain('发手牌');
    expect(collectionGuard(hand([40, 40], 'RIVER')).message).toContain('结算预览');
  });
});
