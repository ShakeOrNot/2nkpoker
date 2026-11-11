import { getTable } from '../../state/tableManager.js';

const SHOW_WINDOW_MS = Number(process.env.SHOW_CARDS_MS ?? 5000);
const replyAck = (ack, res) => {
  if (typeof ack === 'function') ack(res);
};

/**
 * 秀牌：可以只秀一张或两张。
 * - 手牌进行中：先记到 showQueue，结算时自动亮出
 * - 结算后 5 秒内：立即亮出
 * ws: game:show_cards { tableId, handId, cards?: string[] }
 */
export function registerShowCards(nsp, socket) {
  socket.on('game:show_cards', (payload, ack) => {
    const tableId = String(payload?.tableId ?? '');
    const t = tableId ? getTable(tableId) : null;
    if (!t) return replyAck(ack, { ok: false, code: 'TABLE_NOT_FOUND' });
    const seat = t.userToSeat.get(socket.data.userId);
    if (seat == null) return replyAck(ack, { ok: false, code: 'NOT_SEATED' });

    t.actor.run(() => {
      const handId = String(payload?.handId ?? '');
      const live =
        t.handState && !t.handState.settled && t.handState.handId === handId ? t.handState : null;
      const last = t.lastHand && t.lastHand.handId === handId ? t.lastHand : null;
      const row = live
        ? live.seats.find((s) => s.seat === seat)
        : last?.seats.find((s) => s.seat === seat);
      if (!row) return replyAck(ack, { ok: false, code: 'NOT_IN_HAND', message: '你不在本手里' });

      const hole = row.holeCards ?? [];
      const wanted = Array.isArray(payload?.cards) && payload.cards.length ? payload.cards : hole;
      const unique = [...new Set(wanted.filter((c) => hole.includes(c)))];
      if (!unique.length || unique.length > 2) {
        return replyAck(ack, { ok: false, code: 'INVALID_CARDS', message: '只能秀自己的一张或两张牌' });
      }

      // 手牌进行中：排队，结算时亮（可以一张一张点，合并）
      if (live) {
        if (!t.showQueue) t.showQueue = new Map();
        const prev = t.showQueue.get(seat)?.cards ?? [];
        const merged = [...new Set([...prev, ...unique])];
        t.showQueue.set(seat, { seat, nickname: row.nickname, cards: merged });
        return replyAck(ack, { ok: true, queued: true, cards: merged });
      }

      // 结算后：立即亮（5 秒窗口），可以分两次各点一张
      if (!last) return replyAck(ack, { ok: false, code: 'NO_HAND', message: '没有可秀的牌' });
      if (Date.now() - last.at > SHOW_WINDOW_MS) {
        return replyAck(ack, { ok: false, code: 'SHOW_TOO_LATE', message: '秀牌时间已过' });
      }
      if (!last.shownCards) last.shownCards = new Map();
      const prev = last.shownCards.get(seat) ?? [];
      const merged = [...new Set([...prev, ...unique])];
      if (merged.length === prev.length) {
        return replyAck(ack, { ok: false, code: 'ALREADY_SHOWN', message: '这张牌已经秀过' });
      }
      last.shown.add(seat);
      last.shownCards.set(seat, merged);
      nsp.to(`table:${t.tableId}`).emit('game:show_cards', {
        handId,
        seat,
        nickname: row.nickname,
        cards: merged,
      });
      replyAck(ack, { ok: true, cards: merged });
    });
  });
}
