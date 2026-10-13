/**
 * 协议适配层测试：
 *   1. 牌面在「我们的写法 'Kh'」与「远端写法 'K♥'」之间互转
 *   2. 适配层能把远端的 gameState / playerList / showdownResult
 *      （真实抓包样本）翻译成我们格式的快照与结果
 *   3. 动作翻译：bet/raise/all_in 都会变成远端的 raise + amount
 */

import { describe, it, expect } from 'vitest';
import { cardToSymbol, cardFromSymbol, cardsFromSymbols } from '../public/js/core/logic.js';
import { RemoteProtocolSocket, needsRemoteAdapter } from '../public/js/net/remote-protocol.js';

/** 造一个适配层实例（不连网），并记录它推出的快照 */
function makeAdapter() {
  const adapter = new RemoteProtocolSocket({
    baseUrl: 'http://43.135.53.83:3000',
    roomId: 'testroom',
    playerName: '我',
    maxSeats: 6,
  });
  const seen = { snapshots: [], requests: [], results: [], errors: [] };
  adapter.setHandlers({
    onSnapshot: (s) => seen.snapshots.push(s),
    onActionRequest: (r) => seen.requests.push(r),
    onResult: (r) => seen.results.push(r),
    onServerError: (e) => seen.errors.push(e),
  });
  return { adapter, seen };
}

/** 远端真实抓包样本（两人局，我到目前只出了一次 raise 后跟注） */
const remoteState = {
  players: [
    { id: 'sock-A', name: '对手', chips: 990, seat: 1, status: 'active', currentBet: 10, hasActed: false, ready: true },
    { id: 'sock-B', name: '我', chips: 980, seat: 2, status: 'active', currentBet: 20, hasActed: true, ready: true },
  ],
  pot: 30,
  currentTurn: 1,
  currentBet: 20,
  phase: 'preflop',
  communityCards: [],
  started: true,
  dealerSeat: 1,
  smallBlind: 10,
  bigBlind: 20,
  lastRaiseAmount: 20,
};

describe('牌面格式互转', () => {
  it('我们的写法 → 远端写法', () => {
    expect(cardToSymbol('As')).toBe('A♠');
    expect(cardToSymbol('Th')).toBe('T♥');
    expect(cardToSymbol('2d')).toBe('2♦');
    expect(cardToSymbol('Kc')).toBe('K♣');
  });

  it('远端写法 → 我们的写法', () => {
    expect(cardFromSymbol('A♠')).toBe('As');
    expect(cardFromSymbol('J♥')).toBe('Jh');
    expect(cardFromSymbol('T♦')).toBe('Td');
    expect(cardFromSymbol('9♣')).toBe('9c');
  });

  it('已经是我们的写法时原样返回（大小写也归一）', () => {
    expect(cardFromSymbol('As')).toBe('As');
    expect(cardFromSymbol('ah')).toBe('Ah');
  });

  it('兼容 10 的两种写法，无法识别时返回空串', () => {
    expect(cardFromSymbol('10♠')).toBe('Ts');
    expect(cardFromSymbol('10s')).toBe('Ts');
    expect(cardFromSymbol('??')).toBe('');
    expect(cardFromSymbol('')).toBe('');
  });

  it('数组转换会丢掉无法识别的牌', () => {
    expect(cardsFromSymbols(['2♠', 'J♥'])).toEqual(['2s', 'Jh']);
    expect(cardsFromSymbols(['K♥', 'bad', '7♦'])).toEqual(['Kh', '7d']);
    expect(cardsFromSymbols(null)).toEqual([]);
  });
});

describe('远端地址识别', () => {
  it('已知远端 IP 会自动走适配层', () => {
    expect(needsRemoteAdapter('http://43.135.53.83:3000')).toBe(true);
    expect(needsRemoteAdapter('http://127.0.0.1:3001')).toBe(false);
    expect(needsRemoteAdapter('')).toBe(false);
  });
});

describe('gameState → 我们的快照', () => {
  it('座位号从 1 起转换成从 0 起，盲注/底池/当前行动者都带上', () => {
    const { adapter, seen } = makeAdapter();
    adapter.mySeat = 2;
    adapter.handleGameState(remoteState);

    const snap = seen.snapshots.at(-1);
    expect(snap.tableId).toBe('testroom');
    expect(snap.smallBlind).toBe(10);
    expect(snap.bigBlind).toBe(20);
    expect(snap.maxSeats).toBe(6);
    expect(snap.seats[0].userId).toBe('对手');
    expect(snap.seats[1].userId).toBe('我');
    expect(snap.seats[1].chips).toBe(980);

    const hand = snap.hand;
    expect(hand.street).toBe('PREFLOP');
    expect(hand.pot).toBe(30);
    expect(hand.currentBet).toBe(20);
    expect(hand.minRaise).toBe(20);
    expect(hand.buttonSeat).toBe(0);              // 远端 dealerSeat=1 → 0
    expect(hand.currentTurnSeat).toBe(0);         // 远端 currentTurn=1 → 0
    expect(hand.seats.map((s) => s.seat)).toEqual([0, 1]);
    expect(hand.seats[0].betThisStreet).toBe(10);
    expect(hand.seats[1].betThisStreet).toBe(20);
  });

  it('我的底牌只出现在我的座位上，且已转成我们的写法', () => {
    const { adapter, seen } = makeAdapter();
    adapter.mySeat = 2;
    adapter.handleMyHand(['2♠', 'J♥']);
    adapter.handleGameState(remoteState);

    const hand = seen.snapshots.at(-1).hand;
    expect(hand.seats[1].holeCards).toEqual(['2s', 'Jh']);
    expect(hand.seats[0].holeCards).toEqual([]);
  });

  it('公共牌也会转换', () => {
    const { adapter, seen } = makeAdapter();
    adapter.mySeat = 2;
    adapter.handleGameState({ ...remoteState, phase: 'flop', communityCards: ['K♥', '8♥', '2♦'] });
    const hand = seen.snapshots.at(-1).hand;
    expect(hand.street).toBe('FLOP');
    expect(hand.board).toEqual(['Kh', '8h', '2d']);
  });

  it('轮到我时发 action_request，合法动作符合当前局面', () => {
    const { adapter, seen } = makeAdapter();
    adapter.mySeat = 2;
    adapter.handleGameState({ ...remoteState, currentTurn: 2 });
    const req = seen.requests.at(-1);
    expect(req).toBeTruthy();
    expect(req.seat).toBe(2);
    // 我本街已下 20 = 当前注，所以可以过牌，也可以加注/全下
    expect(req.legalActions).toContain('check');
    expect(req.legalActions).toContain('fold');
    expect(req.legalActions).toContain('all_in');
  });

  it('不是我的回合就不发 action_request', () => {
    const { adapter, seen } = makeAdapter();
    adapter.mySeat = 2;
    adapter.handleGameState(remoteState);   // currentTurn = 1
    expect(seen.requests).toHaveLength(0);
  });
});

describe('showdownResult → 我们的结果', () => {
  it('赢家金额与座位号翻译正确，并补上自己的底牌', () => {
    const { adapter, seen } = makeAdapter();
    adapter.mySeat = 2;
    adapter.handleMyHand(['A♦', 'J♥']);
    adapter.handleGameState(remoteState);
    adapter.handleShowdown({ winners: [{ name: '我', seat: 2, amount: 80 }], share: 80 });

    const result = seen.results.at(-1);
    expect(result.result.pots).toEqual([{ amount: 80, eligibleSeats: [2] }]);
    expect(result.result.payouts).toEqual({ 2: 80 });
    expect(result.result.revealed[2]).toEqual(['Ad', 'Jh']);
    expect(result.result.forcedWinnerSeat).toBe(2);
  });

  it('结算后 started=false 时，快照仍保留刚打完那一手（供结算浮层展示）', () => {
    const { adapter, seen } = makeAdapter();
    adapter.mySeat = 2;
    adapter.handleGameState(remoteState);                       // 一手进行中
    adapter.handleShowdown({ winners: [{ name: '对手', seat: 1, amount: 80 }], share: 80 });
    adapter.handleGameState({                                    // 远端摊牌后的帧
      ...remoteState,
      players: remoteState.players.map((p) => ({ ...p, currentBet: 0, hasActed: false })),
      pot: 0,
      phase: 'showdown',
      started: false,
      communityCards: ['K♥', '8♥', '2♦', 'K♦', '7♥'],
    });

    const hand = seen.snapshots.at(-1).hand;
    expect(hand).toBeTruthy();                 // 不能变成 null
    expect(hand.settled).toBe(true);
    expect(hand.seats).toHaveLength(2);        // 结算浮层需要座位
    expect(hand.board).toEqual(['Kh', '8h', '2d', 'Kd', '7h']);
    expect(hand.result?.payouts).toEqual({ 1: 80 });
  });
});

describe('动作翻译 → 远端 playerAction', () => {
  /** 造一个能捕获 emit 的假 socket；forceTurn 用来把回合改成我 */
  function connectedAdapter(state = remoteState, forceTurn = true) {
    const { adapter, seen } = makeAdapter();
    adapter.mySeat = 2;
    const sent = [];
    adapter.socket = { emit: (event, payload) => sent.push({ event, payload }) };
    adapter.connected = true;
    adapter.handleGameState({ ...state, ...(forceTurn ? { currentTurn: 2 } : {}) });
    return { adapter, seen, sent };
  }

  it('过牌 / 跟注 / 弃牌原样透传', async () => {
    const { adapter, sent } = connectedAdapter();
    await adapter.request('game:action', { action: { type: 'check' } });
    await adapter.request('game:action', { action: { type: 'call' } });
    await adapter.request('game:action', { action: { type: 'fold' } });
    expect(sent.map((s) => s.payload.action)).toEqual(['check', 'call', 'fold']);
  });

  it('bet / raise 会变成远端的 raise，并带上"本街下注到多少"', async () => {
    const { adapter, sent } = connectedAdapter();
    await adapter.request('game:action', { action: { type: 'raise', amount: 60 } });
    expect(sent.at(-1).payload).toEqual({ roomId: 'testroom', action: 'raise', amount: 60 });
  });

  it('all_in 会换算成 raise 到全部筹码（远端没有 all_in 动作）', async () => {
    const { adapter, sent } = connectedAdapter();
    await adapter.request('game:action', { action: { type: 'all_in' } });
    // 我 remaining 980 + 本街已下 20 = 1000
    expect(sent.at(-1).payload).toEqual({ roomId: 'testroom', action: 'raise', amount: 1000 });
  });

  it('超过自己筹码的金额会被拦下，不会发出去', async () => {
    const { adapter, sent } = connectedAdapter();
    const res = await adapter.request('game:action', { action: { type: 'raise', amount: 99999 } });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('INSUFFICIENT_CHIPS');
    expect(sent).toHaveLength(0);
  });

  it('加注低于最小幅度（且不是全下）会被拦下', async () => {
    const { adapter, sent } = connectedAdapter();
    const res = await adapter.request('game:action', { action: { type: 'raise', amount: 25 } });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('INVALID_ACTION');
    expect(sent).toHaveLength(0);
  });

  it('不是我的回合 → NOT_YOUR_TURN', async () => {
    const { adapter, sent } = connectedAdapter({ ...remoteState, currentTurn: 1 }, false);
    const res = await adapter.request('game:action', { action: { type: 'check' } });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('NOT_YOUR_TURN');
    expect(sent).toHaveLength(0);
  });
});
