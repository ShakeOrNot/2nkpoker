import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getTable } from '../../state/tableManager.js';
import { findById } from '../../users/userStore.js';
import { BUILTIN_STICKERS, findSticker } from '../../users/stickerStore.js';

const roomSchema = z.object({ tableId: z.string().min(2).max(32) }).strict();
const common = { tableId: z.string().min(2).max(32), clientId: z.string().regex(/^[a-zA-Z0-9_-]{8,80}$/) };
const sendSchema = z.union([
  z.object({ ...common, text: z.string().trim().min(1).max(280) }).strict(),
  z.object({ ...common, stickerId: z.string().min(1).max(50) }).strict(),
]);
const recentSenders = new Map();

export function registerChat(nsp, socket) {
  function access(tableId) {
    try {
      const user = findById(socket.data.userId);
      if (!user || user.disabled || Number(user.token_version) !== socket.data.tokenVersion) return null;
      const table = getTable(tableId);
      if (!table || !socket.rooms.has(`table:${tableId}`)) return null;
      return { table, user };
    } catch { return null; }
  }
  socket.on('chat:history', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const parsed = roomSchema.safeParse(payload);
    if (!parsed.success) return ack({ ok: false, code: 'INVALID_PAYLOAD' });
    const context = access(parsed.data.tableId);
    if (!context) return ack({ ok: false, code: 'CHAT_FORBIDDEN', message: '请先进入房间并确认登录有效' });
    ack({ ok: true, messages: context.table.chatMessages ?? [] });
  });
  socket.on('chat:send', (payload, ack) => {
    if (typeof ack !== 'function') return;
    const parsed = sendSchema.safeParse(payload);
    if (!parsed.success) return ack({ ok: false, code: 'INVALID_PAYLOAD', message: '消息需为 1–280 字' });
    const { tableId, text, clientId, stickerId } = parsed.data;
    const context = access(tableId);
    if (!context) return ack({ ok: false, code: 'CHAT_FORBIDDEN', message: '请先进入房间并确认登录有效' });
    const { table, user } = context;
    const history = table.chatMessages ?? [];
    const duplicate = history.find(m => m.userId === user.id && m.clientId === clientId);
    if (duplicate) return ack({ ok: true, message: duplicate });
    let sticker;
    if (stickerId) {
      if (BUILTIN_STICKERS.includes(stickerId)) sticker = { id: stickerId, url: `/img/stickers/${stickerId}.svg` };
      else {
        const resource = findSticker(stickerId);
        if (!resource || resource.user_id !== user.id) return ack({ ok: false, code: 'INVALID_STICKER', message: '请先导入自己的表情' });
        sticker = { id: resource.id, name: resource.name, url: `/auth/stickers/assets/${resource.id}` };
      }
    }
    const now = Date.now();
    for (const [id, at] of recentSenders) if (now - at > 10000) recentSenders.delete(id);
    if (now - (recentSenders.get(user.id) ?? 0) < 800) return ack({ ok: false, code: 'CHAT_RATE_LIMIT', message: '发送太快，请稍后再试' });
    recentSenders.set(user.id, now);
    const message = { id: randomUUID(), clientId, tableId, userId: user.id, nickname: user.nickname, avatarId: user.avatar_id ?? 'lion', text: text ?? '', ...(sticker ? { sticker } : {}), at: now };
    table.chatMessages = [...history, message].slice(-80);
    nsp.to(`table:${tableId}`).emit('chat:message', message);
    ack({ ok: true, message });
  });
}
