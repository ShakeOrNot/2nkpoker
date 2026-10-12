import { GameActionSchema, parseOrError } from '../validate.js';
import { getTable } from '../../state/tableManager.js';
import { playAction, cleanupAfterHand, maybeStartHand } from '../../state/handOrchestrator.js';
import { broadcastTable } from './table.sit.js';

/**
 * @param {import('socket.io').Namespace} nsp
 * @param {import('socket.io').Socket} socket
 */
export function registerGameAction(nsp, socket) {
  socket.on('game:action', (payload, ack) => {
    const parsed = parseOrError(GameActionSchema, payload);
    if (!parsed.ok) return replyAck(ack, { ok: false, code: parsed.code, message: parsed.message });
    const { tableId, handId, expectedVersion, action } = parsed.data;
    const t = getTable(tableId);
    if (!t) return replyAck(ack, { ok: false, code: 'TABLE_NOT_FOUND' });

    const seat = t.userToSeat.get(socket.data.userId);
    if (seat == null) return replyAck(ack, { ok: false, code: 'NOT_SEATED' });
    if (t.handState?.handId !== handId) {
      return replyAck(ack, { ok: false, code: 'HAND_NOT_ACTIVE' });
    }

    t.actor.run(() => {
      const result = playAction(t, seat, action, expectedVersion);
      if (!result.ok) return replyAck(ack, result);

      // 广播动作 + 新快照
      nsp.to(`table:${tableId}`).emit('game:action_applied', {
        seat,
        action,
        handId,
      });
      broadcastTable(nsp, t);

      // 摊牌
      if (t.handState.settled) {
        nsp.to(`table:${tableId}`).emit('game:result', {
          handId,
          result: t.handState.result,
          board: t.handState.board,
        });
        cleanupAfterHand(t);
        broadcastTable(nsp, t);
        // 若还满足开局条件，再开一局
        if (maybeStartHand(t)) {
          broadcastTable(nsp, t);
          broadcastHandStart(nsp, t);
          broadcastActionRequest(nsp, t);
        }
      } else {
        broadcastActionRequest(nsp, t);
      }

      replyAck(ack, { ok: true });
    });
  });
}

/**
 * 广播"这手牌开始"，让前端知道要开始发牌动画
 * @param {import('socket.io').Namespace} nsp
 * @param {any} t
 */
export function broadcastHandStart(nsp, t) {
  if (!t.handState) return;
  nsp.to(`table:${t.tableId}`).emit('hand:start', {
    handId: t.handState.handId,
    buttonSeat: t.handState.buttonSeat,
    smallBlind: t.handState.smallBlind,
    bigBlind: t.handState.bigBlind,
  });
}

/**
 * 广播"该谁行动了"。仅给当前行动者发 action_request（里面有合法动作），
 * 其他人只通过 table:snapshot 看到状态
 * @param {import('socket.io').Namespace} nsp
 * @param {any} t
 */
export function broadcastActionRequest(nsp, t) {
  if (!t.handState || t.handState.settled) return;
  const turnSeat = t.handState.currentTurnSeat;
  if (turnSeat == null) return;

  const s = t.seats.get(turnSeat);
  if (!s) return;
  const socketId = findSocketByUserId(nsp, t.tableId, s.userId);
  if (!socketId) return;

  const sock = nsp.sockets.get(socketId);
  if (!sock) return;

  // 该玩家能做的动作（此处为了简单让客户端自己算，也可以后端算好）
  const legal = computeLegalActions(t, turnSeat);
  sock.emit('game:action_request', {
    handId: t.handState.handId,
    seat: turnSeat,
    legalActions: legal,
    deadline: Date.now() + 30000,
  });
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

function replyAck(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}