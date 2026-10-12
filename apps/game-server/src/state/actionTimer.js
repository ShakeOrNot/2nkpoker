import { playAction, cleanupAfterHand, maybeStartHand } from './handOrchestrator.js';
import { broadcastTable } from '../ws/handlers/table.sit.js';

const ACTION_TIMEOUT_MS = Number(process.env.ACTION_TIMEOUT_MS ?? 30000);

/** @type {Map<string, NodeJS.Timeout>} */
const timers = new Map();

export function clearActionTimer(tableId) {
  const t = timers.get(tableId);
  if (t) clearTimeout(t);
  timers.delete(tableId);
}

/** 广播"这手牌开始" */
export function broadcastHandStart(nsp, t) {
  if (!t.handState) return;
  nsp.to(`table:${t.tableId}`).emit('hand:start', {
    handId: t.handState.handId,
    buttonSeat: t.handState.buttonSeat,
    smallBlind: t.handState.smallBlind,
    bigBlind: t.handState.bigBlind,
  });
}

/** 广播"该谁行动"+ 启动超时计时器 */
export function broadcastActionRequest(nsp, t) {
  clearActionTimer(t.tableId);
  if (!t.handState || t.handState.settled) return;
  const turnSeat = t.handState.currentTurnSeat;
  if (turnSeat == null) return;

  const handId = t.handState.handId;
  const s = t.seats.get(turnSeat);

  // 只给当前行动者发 action_request
  if (s) {
    const socketId = findSocketByUserId(nsp, t.tableId, s.userId);
    if (socketId) {
      const sock = nsp.sockets.get(socketId);
      if (sock) {
        sock.emit('game:action_request', {
          handId,
          seat: turnSeat,
          legalActions: computeLegalActions(t, turnSeat),
          deadline: Date.now() + ACTION_TIMEOUT_MS,
        });
      }
    }
  }

  // 启动超时
  const timer = setTimeout(() => {
    timers.delete(t.tableId);
    t.actor.run(() => {
      // 校验 hand 未变、轮次未变
      if (!t.handState || t.handState.handId !== handId) return;
      if (t.handState.currentTurnSeat !== turnSeat) return;

      const hs = t.handState.seats.find((x) => x.seat === turnSeat);
      if (!hs) return;
      const toCall = t.handState.currentBet - hs.betThisStreet;
      const action = toCall === 0 ? { type: 'check' } : { type: 'fold' };

      const result = playAction(t, turnSeat, action, t.handState.version);
      if (!result.ok) return;

      nsp.to(`table:${t.tableId}`).emit('game:action_applied', {
        seat: turnSeat,
        action,
        handId,
        timeout: true,
      });
      broadcastTable(nsp, t);

      if (t.handState.settled) {
        broadcastResult(nsp, t, handId);
      } else {
        broadcastActionRequest(nsp, t);
      }
    });
  }, ACTION_TIMEOUT_MS);
  timers.set(t.tableId, timer);
}

/** 广播结算 + 清理 + 尝试开下一手 */
export function broadcastResult(nsp, t, handId) {
  nsp.to(`table:${t.tableId}`).emit('game:result', {
    handId,
    result: t.handState.result,
    board: t.handState.board,
  });
  cleanupAfterHand(t);
  broadcastTable(nsp, t);
  if (maybeStartHand(t)) {
    broadcastTable(nsp, t);
    broadcastHandStart(nsp, t);
    broadcastActionRequest(nsp, t);
  }
}

function computeLegalActions(t, seat) {
  const hs = t.handState;
  const s = hs.seats.find((x) => x.seat === seat);
  const toCall = Math.max(0, hs.currentBet - s.betThisStreet);
  const out = ['fold'];
  if (toCall === 0) out.push('check');
  if (toCall > 0) out.push('call');
  if (hs.currentBet === 0) out.push('bet');
  if (hs.currentBet > 0 && s.chips > toCall) out.push('raise');
  out.push('all_in');
  return out;
}

function findSocketByUserId(nsp, tableId, userId) {
  const room = nsp.adapter.rooms.get(`table:${tableId}`);
  if (!room) return null;
  for (const sid of room) {
    const s = nsp.sockets.get(sid);
    if (s && s.data.userId === userId) return sid;
  }
  return null;
}