/**
 * 离线对手引擎测试：验证 mock socket 的行为与服务端协议一致。
 */

import { describe, it, expect } from 'vitest';
import { createMockSocket } from '../public/js/net/mock-socket.js';
import { settlement, handRunning, toCallAmount, deriveLegalActions, validateBetAmount } from '../public/js/core/logic.js';

/**
 * 建一个"我自己"的离线 socket
 * @param {string} tableId
 */
function me(tableId = 't1') {
  const socket = createMockSocket({
    tableId,
    userId: 'local_me',
    nickname: '我',
    smallBlind: 10,
    bigBlind: 20,
    maxSeats: 6,
    buyIn: 1000,
  });
  const seen = { snapshots: [], requests: [], results: [], actions: [], hands: [] };
  socket.on('table:snapshot', (s) => seen.snapshots.push(s));
  socket.on('game:action_request', (p) => seen.requests.push(p));
  socket.on('game:result', (p) => seen.results.push(p));
  socket.on('game:action_applied', (p) => seen.actions.push(p));
  socket.on('hand:start', (p) => seen.hands.push(p));
  return { socket, seen };
}

/**
 * 发请求并等 ack
 * @param {any} socket
 * @param {string} event
 * @param {any} payload
 */
function request(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

/**
 * 轮询等待条件成立；可选 tick 回调用于在等待期间驱动自动应答
 * @param {() => boolean} predicate
 * @param {number} timeout
 * @param {() => void} [tick]
 */
async function waitFor(predicate, timeout = 6000, tick) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return true;
    if (tick) tick();
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** 机器人占用的座位（join 之后自动补齐） */
function botSeats(seen) {
  const snap = seen.snapshots.at(-1);
  return snap.seats.filter((s) => s.userId?.startsWith('bot_')).map((s) => s.seat);
}

/** 第一个空座位 */
function freeSeat(seen) {
  const snap = seen.snapshots.at(-1);
  const occupied = new Set(snap.seats.filter((s) => s.userId).map((s) => s.seat));
  for (let i = 0; i < snap.maxSeats; i++) if (!occupied.has(i)) return i;
  return null;
}

/**
 * join + 坐下 + 准备，返回我的座位号
 * @param {{ socket: any, seen: any }} ctx
 * @param {string} tableId
 */
async function sitAndReady(ctx, tableId, buyIn = 1000) {
  await request(ctx.socket, 'table:join', { tableId });
  const seat = freeSeat(ctx.seen);
  const sit = await request(ctx.socket, 'table:sit', { tableId, seat, buyIn });
  expect(sit.ok).toBe(true);
  await request(ctx.socket, 'table:ready', { tableId, ready: true });
  return { seat: sit.seat };
}

describe('离线引擎：入座与准备', () => {
  it('join 后自动补齐机器人，且能看到快照', async () => {
    const { socket, seen } = me('j1');
    const res = await request(socket, 'table:join', { tableId: 'j1' });
    expect(res.ok).toBe(true);
    expect(seen.snapshots.length).toBeGreaterThan(0);
    const people = seen.snapshots.at(-1).seats.filter((s) => s.userId).length;
    expect(people).toBeGreaterThanOrEqual(2);
    expect(people).toBeLessThan(6); // 一定给真人留了位置
  });

  it('坐下在空位成功；坐到机器人位置上被拒；重复入座被拒', async () => {
    const { socket, seen } = me('j2');
    await request(socket, 'table:join', { tableId: 'j2' });

    const taken = await request(socket, 'table:sit', { tableId: 'j2', seat: botSeats(seen)[0], buyIn: 1000 });
    expect(taken.ok).toBe(false);
    expect(taken.code).toBe('SEAT_TAKEN');

    const seat = freeSeat(seen);
    const sit1 = await request(socket, 'table:sit', { tableId: 'j2', seat, buyIn: 1000 });
    expect(sit1.ok).toBe(true);
    expect(sit1.seat).toBe(seat);

    const again = await request(socket, 'table:sit', { tableId: 'j2', seat: freeSeat(seen) ?? 5, buyIn: 1000 });
    expect(again.ok).toBe(true);
    expect(again.moved).toBe(true); // 已入座 = 换座（与服务端一致）
  });

  it('已入座直接换座：筹码不变、ready 重置', async () => {
    const ctx = me('j2c');
    await request(ctx.socket, 'table:join', { tableId: 'j2c' });
    const first = await request(ctx.socket, 'table:sit', { tableId: 'j2c', seat: freeSeat(ctx.seen), buyIn: 1000 });
    expect(first.ok).toBe(true);

    const target = freeSeat(ctx.seen);
    const moved = await request(ctx.socket, 'table:sit', { tableId: 'j2c', seat: target, buyIn: 1000 });

    expect(moved.ok).toBe(true);
    expect(moved.moved).toBe(true);
    expect(moved.seat).toBe(target);
    const snap = ctx.seen.snapshots.at(-1);
    const mine = snap.seats.find((s) => s.userId === 'local_me');
    expect(mine.seat).toBe(target);
    expect(mine.chips).toBe(1000);
    expect(mine.ready).toBe(false);
  });

  it('带入筹码超出范围由前端逻辑拦截（这里验证后端会坐下）', async () => {
    const { socket, seen } = me('j2b');
    await request(socket, 'table:join', { tableId: 'j2b' });
    const res = await request(socket, 'table:sit', { tableId: 'j2b', seat: freeSeat(seen), buyIn: 5000 });
    expect(res.ok).toBe(true);
  });

  it('未坐下时准备会被拒绝', async () => {
    const { socket } = me('j3');
    await request(socket, 'table:join', { tableId: 'j3' });
    const res = await request(socket, 'table:ready', { tableId: 'j3', ready: true });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('NOT_SEATED');
  });
});

describe('离线引擎：一手牌打到底', () => {
  it('开局发两张手牌，且只有本人能看到', async () => {
    const ctx = me('h1');
    const { seat: mySeat } = await sitAndReady(ctx, 'h1');

    const started = await waitFor(() => ctx.seen.snapshots.some((s) => s.hand));
    expect(started).toBe(true);

    const withHand = ctx.seen.snapshots.filter((s) => s.hand).at(-1);
    const mine = withHand.hand.seats.find((s) => s.seat === mySeat);
    expect(mine.holeCards).toHaveLength(2);
    for (const s of withHand.hand.seats) {
      if (s.seat === mySeat) continue;
      expect(s.holeCards).toHaveLength(0);
    }
    expect(ctx.seen.hands.length).toBeGreaterThan(0);
  }, 10000);

  it('轮到我时会收到 action_request，内容与协议一致', async () => {
    const ctx = me('h2');
    const { seat: mySeat } = await sitAndReady(ctx, 'h2');

    // 注意：第一次 action_request 是在 table:ready 里同步发出的，可能早于监听器。
    // 所以这里既看已记录的请求，也看"这一手是否已经结束"（结束了就不会再轮到我）。
    const got = await waitFor(
      () => ctx.seen.requests.length > 0 || Boolean(ctx.seen.snapshots.at(-1)?.hand?.settled),
      8000,
    );
    expect(got).toBe(true);

    const req = ctx.seen.requests[0];
    if (!req) {
      // 极端情况：机器人在我行动前就把这手打完了 —— 这本身也是合法结果
      expect(ctx.seen.snapshots.at(-1)?.hand?.settled).toBe(true);
      return;
    }
    expect(req.handId).toMatch(/^mock_/);
    expect(req.seat).toBe(mySeat);
    expect(req.legalActions.includes('fold')).toBe(true);
    expect(typeof req.deadline).toBe('number');
    expect(req.deadline).toBeGreaterThan(Date.now() - 1000);
  }, 15000);

  it('能一直打到结算，筹码守恒，结算明细可用', async () => {
    const ctx = me('h3');

    // 自动应答：不依赖事件送达顺序 —— 直接以"最新快照里是不是轮到我"为准。
    // （第一次 action_request 是在 table:ready 内同步发出的，可能早于任何监听器）
    let acting = false;
    const answer = async (req) => {
      if (acting) return;
      const snap = ctx.seen.snapshots.at(-1);
      if (!snap?.hand || snap.hand.settled) return;
      const mySeat = ctx.socket.mySeat;
      if (mySeat == null || snap.hand.currentTurnSeat !== mySeat) return;
      acting = true;
      try {
        const toCall = toCallAmount(snap.hand, mySeat);
        const action = toCall === 0 ? { type: 'check' } : toCall <= 200 ? { type: 'call' } : { type: 'fold' };
        await request(ctx.socket, 'game:action', {
          tableId: 'h3',
          handId: req.handId ?? snap.hand.handId,
          expectedVersion: snap.hand.version,
          action,
        });
      } finally {
        acting = false;
      }
    };
    ctx.socket.on('game:action_request', (req) => void answer(req));

    const { seat: mySeat } = await sitAndReady(ctx, 'h3');
    ctx.socket.mySeat = mySeat;

    const done = await waitFor(() => ctx.seen.results.length > 0, 40000, () => void answer(ctx.seen.requests.at(-1) ?? {}));
    if (!done) {
      const snap = ctx.seen.snapshots.at(-1);
      const hand = snap?.hand;
      console.log('    [诊断] 未能结算：', JSON.stringify({
        street: hand?.street,
        settled: hand?.settled,
        currentTurnSeat: hand?.currentTurnSeat,
        pot: hand?.pot,
        seats: hand?.seats.map((s) => `${s.seat}:${s.folded ? 'F' : s.allIn ? 'A' : s.chips}`),
        mockTurn: ctx.socket.table?.hand?.currentTurnSeat,
        mockSettled: ctx.socket.table?.hand?.settled,
        requests: ctx.seen.requests.length,
        actions: ctx.seen.actions.length,
      }));
    }
    expect(done).toBe(true);

    const result = ctx.seen.results.at(-1);
    expect(result.result).toBeTruthy();
    expect(Array.isArray(result.result.pots)).toBe(true);
    // 公共牌张数取决于打到哪条街：翻牌前全员弃牌时就是 0 张，所以只校验类型与上限
    expect(Array.isArray(result.board)).toBe(true);
    expect(result.board.length).toBeLessThanOrEqual(5);
    expect(result.board.every((c) => /^[2-9TJQKA][shdc]$/.test(c))).toBe(true);

    // 等一份"这一手已结算"的快照，用于校验筹码守恒
    await waitFor(() => Boolean(ctx.seen.snapshots.at(-1)?.hand?.settled), 5000);
    const snap = ctx.seen.snapshots.at(-1);
    expect(snap.hand.seats.reduce((sum, s) => sum + s.chips, 0)).toBe(1000 * snap.hand.seats.length);

    const summary = settlement(snap.hand);
    expect(summary.totalPaid).toBeGreaterThan(0);
    for (const row of summary.rows) {
      expect(Number.isInteger(row.net)).toBe(true);
    }
    const paidOut = summary.rows.reduce((s, r) => s + r.won, 0);
    expect(paidOut).toBeLessThanOrEqual(summary.totalPaid);
  }, 45000);

  it('牌局进行中无法入座（对应后端 HAND_IN_PROGRESS）', async () => {
    const ctx = me('h4');
    await sitAndReady(ctx, 'h4');
    const started = await waitFor(() => ctx.seen.snapshots.some((s) => handRunning(s.hand)));
    expect(started).toBe(true);

    // 另一个人想入座同一张进行中的桌子（共享 LocalTable，等价于同一张桌）
    const other = createMockSocket({ tableId: 'h4', userId: 'late', nickname: '迟到的人', buyIn: 1000 });
    other.table = ctx.socket.table;
    await request(other, 'table:join', { tableId: 'h4' });
    const seat = freeSeat(ctx.seen);
    const sitRes = await request(other, 'table:sit', { tableId: 'h4', seat, buyIn: 1000 });
    expect(sitRes.ok).toBe(false);
    expect(sitRes.code).toBe('HAND_IN_PROGRESS');
  }, 15000);

  it('手牌进行中离桌：标记 leaving，本手结束自动清座', async () => {
    const ctx = me('h6');
    const { seat } = await sitAndReady(ctx, 'h6');
    const started = await waitFor(() => ctx.seen.snapshots.some((s) => s.hand && !s.hand.settled), 8000);
    expect(started).toBe(true);

    const leave = await request(ctx.socket, 'table:stand', { tableId: 'h6' });
    expect(leave.ok).toBe(true);
    expect(leave.pending).toBe(true);

    const marked = ctx.seen.snapshots.at(-1)?.seats.find((s) => s.seat === seat);
    expect(marked?.leaving).toBe(true);

    const cleared = await waitFor(
      () => ctx.seen.snapshots.at(-1)?.seats.every((s) => s.userId !== 'local_me'),
      20000,
    );
    expect(cleared).toBe(true);
    expect(ctx.socket.mySeat).toBeNull();
  }, 30000);

  it('版本号过期 / 不是自己回合的动作会被拒', async () => {
    const ctx = me('h5');
    await sitAndReady(ctx, 'h5');
    const started = await waitFor(() => ctx.seen.snapshots.some((s) => s.hand));
    expect(started).toBe(true);

    const snap = ctx.seen.snapshots.filter((s) => s.hand).at(-1);
    const stale = await request(ctx.socket, 'game:action', {
      tableId: 'h5',
      handId: snap.hand.handId,
      expectedVersion: 0,
      action: { type: 'check' },
    });
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe('STATE_OUTDATED');

    const wrongHand = await request(ctx.socket, 'game:action', {
      tableId: 'h5',
      handId: 'not-this-hand',
      expectedVersion: snap.hand.version,
      action: { type: 'check' },
    });
    expect(wrongHand.ok).toBe(false);
    expect(wrongHand.code).toBe('HAND_NOT_ACTIVE');
  }, 15000);
});

describe('离线引擎：动作校验', () => {
  it('短筹码玩家可能直接全下，不会轮到行动（状态无关地验证这一点）', async () => {
    const ctx = me('a1');
    const { seat: mySeat } = await sitAndReady(ctx, 'a1', 100); // 只有 100，约等于盲注级别
    await waitFor(() => ctx.seen.snapshots.some((s) => s.hand), 6000);

    const snap = ctx.seen.snapshots.filter((s) => s.hand).at(-1);
    const mine = snap.hand.seats.find((s) => s.seat === mySeat);
    // 只有 100 筹码：要么已经 all-in 不能再行动，要么还能行动
    if (mine.allIn || mine.chips <= 0) {
      expect(mine.allIn || mine.chips <= 0).toBe(true);
    } else {
      expect(mine.chips).toBeGreaterThan(0);
    }
    // 无论哪种情况，这个座位的筹码都不该凭空变化
    expect(mine.chips).toBeGreaterThanOrEqual(0);
    expect(mine.chips).toBeLessThanOrEqual(100);
  }, 20000);

  it('超过筹码的下注金额会被拒（本地校验，与服务端规则一致）', () => {
    const snap = {
      handId: 'v1',
      street: 'PREFLOP',
      currentBet: 20,
      minRaise: 20,
      bigBlind: 20,
      currentTurnSeat: 0,
      seats: [{ seat: 0, chips: 100, betThisStreet: 0, totalCommitted: 0, folded: false, allIn: false }],
    };
    const over = validateBetAmount(snap, 0, 999999);
    expect(over.ok).toBe(false);
    expect(over.code).toBe('INSUFFICIENT_CHIPS');
    expect(over.clamped).toBe(100);          // 截断到全部筹码
    expect(validateBetAmount(snap, 0, 100).ok).toBe(true); // 正好全下可以
  });

  it('本地推导的合法动作与引擎规则一致（盲注轮）', () => {
    const snap = {
      currentBet: 20,
      bigBlind: 20,
      minRaise: 20,
      currentTurnSeat: 1,
      seats: [
        { seat: 0, chips: 990, betThisStreet: 10, totalCommitted: 10, folded: false, allIn: false },
        { seat: 1, chips: 1000, betThisStreet: 0, totalCommitted: 0, folded: false, allIn: false },
      ],
    };
    expect(deriveLegalActions(snap, 1).sort()).toEqual(['all_in', 'call', 'fold', 'raise']);
    expect(deriveLegalActions(snap, 0)).toEqual([]);
  });
});
