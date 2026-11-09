import { z } from 'zod';
import { requireUser } from '../auth/adminGuard.js';
import { ensureStickerSchema, listStickers, findSticker, saveSticker, validateStickerPng } from '../users/stickerStore.js';

const schema = z.object({ name: z.string().trim().min(1).max(24), dataUrl: z.string().max(350000).startsWith('data:image/png;base64,') }).strict();
export function registerStickerRoutes(app) {
  ensureStickerSchema();
  app.get('/auth/me/stickers', (req, reply) => {
    const user = requireUser(req, reply); if (!user) return reply;
    return { ok: true, stickers: listStickers(user.id) };
  });
  app.post('/auth/me/stickers', { bodyLimit: 360000 }, (req, reply) => {
    const user = requireUser(req, reply); if (!user) return reply;
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ ok: false, code: 'INVALID_PAYLOAD', message: '图片需小于 256KB，名称最多24字' });
    try {
      const base64 = parsed.data.dataUrl.slice(22);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4) throw new Error('图片格式无效');
      const image = validateStickerPng(Buffer.from(base64, 'base64'));
      return { ok: true, sticker: saveSticker(user.id, parsed.data.name, image) };
    } catch (error) { return reply.code(400).send({ ok: false, code: 'INVALID_STICKER', message: error.message?.includes('最多') ? error.message : '图片无效或过大，请重新导入 PNG/JPEG/WebP 图片' }); }
  });
  // 图片使用不可预测的资源ID，可被消息接收者直接加载；只返回已验证的PNG。
  app.get('/auth/stickers/assets/:id', (req, reply) => {
    if (!/^[a-f0-9-]{36}$/.test(req.params.id)) return reply.code(404).send();
    const row = findSticker(req.params.id); if (!row) return reply.code(404).send();
    return reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, max-age=86400').type('image/png').send(Buffer.from(row.image));
  });
}
