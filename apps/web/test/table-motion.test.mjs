import { describe, it, expect } from 'vitest';
import { BoardView, TableMotion, deckVisualState } from '../public/js/views/table-motion.js';

describe('增量发牌与翻牌', () => {
  it('牌堆按本手人数及公开牌递减，重复快照不重复扣牌，新手牌恢复', () => {
    const seats = [{ seat: 0 }, { seat: 1 }];
    const preflop = deckVisualState({ seats, board: [] });
    const flop = deckVisualState({ seats, board: ['As', 'Kd', '7c'] });
    const turn = deckVisualState({ seats, board: ['As', 'Kd', '7c', '2h'] });
    const river = deckVisualState({ seats, board: ['As', 'Kd', '7c', '2h', '9s'] });
    expect([preflop.remaining, flop.remaining, turn.remaining, river.remaining]).toEqual([48, 45, 44, 43]);
    expect(preflop.thickness).toBeGreaterThan(flop.thickness);
    expect(flop.thickness).toBeGreaterThan(turn.thickness);
    expect(turn.thickness).toBeGreaterThan(river.thickness);
    expect(deckVisualState({ seats, board: [] })).toEqual(preflop);
    expect(deckVisualState(null).remaining).toBe(52);
    expect(deckVisualState({ seats: Array(6).fill({}), board: [] }).remaining).toBe(40);
  });
  it('新增公共牌有正反两面，并传递固定牌堆作为发牌源', () => {
    const calls = [];
    const deck = document.createElement('div');
    const board = new BoardView({ reveal: (...args) => calls.push(args) });
    board.update('t:h1', [], false, deck);
    board.update('t:h1', ['As'], false, deck);
    expect(calls[0][1]).toBe(deck);
    expect(calls[0][0].children.length).toBe(2);
    expect(calls[0][0].children[1].classList.contains('card-back')).toBe(true);
  });
  it('翻牌→转牌→河牌只翻新增牌，旧牌节点不被重建', () => {
    const played = [];
    const board = new BoardView({ reveal: (el) => played.push(el) });
    board.update('t:h1', []);
    board.update('t:h1', ['As', 'Kd', '7c']);
    const ace = board.slots[0].children[0];
    expect(played.length).toBe(3);
    board.update('t:h1', ['As', 'Kd', '7c', '2h']);
    expect(played.length).toBe(4);
    expect(board.slots[0].children[0]).toBe(ace);
    board.update('t:h1', ['As', 'Kd', '7c', '2h', '9s']);
    expect(played.length).toBe(5);
  });
  it('重复快照不重播，同牌面新手牌也能重新翻牌', () => {
    const played = [];
    const board = new BoardView({ reveal: (el) => played.push(el) });
    board.update('t:h1', []); board.update('t:h1', ['As']);
    board.update('t:h1', ['As']);
    expect(played.length).toBe(1);
    board.update('t:h2', []); board.update('t:h2', ['As']);
    expect(played.length).toBe(2);
  });
  it('中途重连和结算快照直接显示公共牌，不重播旧动画', () => {
    const played = [];
    const board = new BoardView({ reveal: (el) => played.push(el) });
    board.update('t:h1', ['As', 'Kd', '7c']);
    expect(played.length).toBe(0);
    board.update('t:h1', ['As', 'Kd', '7c', '2h', '9s'], true);
    expect(played.length).toBe(0);
  });
  it('减少动态模式不启动动画；离桌清理所有活动动画', () => {
    const motion = new TableMotion();
    let started = 0;
    let canceled = 0;
    motion.preference = { matches: true };
    motion.play({ animate: () => { started++; } }, []);
    expect(started).toBe(0);
    motion.active.add({ cancel: () => { canceled++; } });
    motion.disconnect();
    expect(canceled).toBe(1);
    expect(motion.active.size).toBe(0);
  });
});
