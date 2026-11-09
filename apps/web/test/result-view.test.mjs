import { describe, it, expect } from 'vitest';
import { TableView } from '../public/js/views/table.js';

function fixture() {
  const state = { session: { userId: 'me' }, room: { tableId: 't1', snapshot: {}, lastResult: {
    handId: 'h1', at: Date.now(), board: [],
    seats: [{ seat: 0, userId: 'me', nickname: '我', totalCommitted: 10 }, { seat: 1, userId: 'other', nickname: '牌友', totalCommitted: 10 }],
    result: { payouts: { 0: 20 }, pots: [{ amount: 20 }], revealed: {} },
  } } };
  const view = new TableView({ state, mySeat: () => 0 });
  return { state, view };
}

describe('结算展示生命周期', () => {
  it('派彩期间下一手到来取消待显示浮层，不会稍后遮住新手牌', () => {
    const { state, view } = fixture();
    try {
      view.payoutEffects.play = () => true;
      view.renderResult(state, null);
      expect(view.resultOverlay.classList.contains('visible')).toBe(false);
      expect(Boolean(view.resultRevealTimer)).toBe(true);
      view.renderResult(state, { handId: 'h2', settled: false });
      expect(view.resultRevealTimer).toBeNull();
      expect(view.resultTimer).toBeNull();
      expect(view.resultOverlay.children.length).toBe(0);
    } finally { view.dismissResult(); }
  });
  it('重复结果与普通重绘不替换浮层、不重置计时器', () => {
    const { state, view } = fixture();
    try {
      view.renderResult(state, null);
      const card = view.resultOverlay.children[0];
      const timer = view.resultTimer;
      view.renderResult(state, null);
      expect(view.resultOverlay.children[0]).toBe(card);
      expect(view.resultTimer).toBe(timer);
    } finally { view.dismissResult(); }
  });
  it('下一手立即收起旧结果，旧事件不会再次遮挡操作区', () => {
    const { state, view } = fixture();
    try {
      view.renderResult(state, null);
      view.renderResult(state, { handId: 'h2', settled: false });
      view.renderResult(state, null);
      expect(view.resultOverlay.classList.contains('visible')).toBe(false);
      expect(view.resultTimer).toBeNull();
    } finally { view.dismissResult(); }
  });
  it('关闭后不重播；另一房间相同 handId 可正常显示', () => {
    const { state, view } = fixture();
    try {
      view.renderResult(state, null); view.dismissResult();
      view.renderResult(state, null);
      expect(view.resultOverlay.classList.contains('visible')).toBe(false);
      state.room.tableId = 't2';
      view.renderResult(state, null);
      expect(view.resultOverlay.classList.contains('visible')).toBe(true);
    } finally { view.dismissResult(); }
  });
  it('过期历史结果不庆祝，离开视图清理计时器', () => {
    const { state, view } = fixture();
    try {
      state.room.lastResult.at = Date.now() - 10000;
      view.renderResult(state, null);
      expect(view.resultOverlay.classList.contains('visible')).toBe(false);
      state.room.lastResult = { ...state.room.lastResult, handId: 'h2', at: Date.now() };
      view.renderResult(state, null); view.unmount();
      expect(view.resultTimer).toBeNull();
      expect(view.resultOverlay.classList.contains('visible')).toBe(false);
    } finally { view.dismissResult(); }
  });
  it('按用户身份识别本人，旁观者不会因座位号被当成赢家', () => {
    const { state, view } = fixture();
    try {
      state.session.userId = 'spectator';
      view.renderResult(state, null);
      expect(view.resultOverlay.children[0].classList.contains('result-spectator')).toBe(true);
    } finally { view.dismissResult(); }
  });
  it('退款后净变化为零显示平局，净负收益显示失败', () => {
    const { state, view } = fixture();
    try {
      state.room.lastResult.result.payouts = { 0: 10, 1: 10 };
      view.renderResult(state, null);
      expect(view.resultOverlay.children[0].classList.contains('result-tie')).toBe(true);
      state.room.lastResult = { ...state.room.lastResult, handId: 'h2', result: { ...state.room.lastResult.result, payouts: { 1: 20 } } };
      view.renderResult(state, null);
      expect(view.resultOverlay.children[0].classList.contains('result-lose')).toBe(true);
    } finally { view.dismissResult(); }
  });
});
