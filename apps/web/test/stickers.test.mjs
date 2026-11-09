import { describe, it, expect } from 'vitest';
import { STICKERS, stickerUrl, importStickerImage } from '../public/js/core/stickers.js';
import { RoomChat } from '../public/js/core/room-chat.js';

describe('表情资源与消息', () => {
  it('内置资源只接受固定ID，自定义资源不能使用任意外链或脚本URL', () => {
    expect(STICKERS.length).toBe(6);
    expect(stickerUrl({ id: 'allin', url: 'javascript:alert(1)' })).toBe('/img/stickers/allin.svg');
    expect(stickerUrl({ id: '../private', url: 'https://evil.invalid' })).toBe('');
    const id = '00000000-0000-4000-8000-000000000000';
    expect(stickerUrl({ id, url: 'https://evil.invalid' }).includes('evil')).toBe(false);
    expect(stickerUrl({ id, url: 'data:image/svg+xml,<svg/>' }, true).includes('svg')).toBe(false);
  });
  it('拒绝SVG、GIF和过大原图，不进入浏览器解码', async () => {
    for (const file of [{type:'image/svg+xml'}, {type:'image/gif'}, {type:'image/png',size:6*1024*1024}]) {
      let failed = false; try { await importStickerImage(file); } catch { failed = true; }
      expect(failed).toBe(true);
    }
  });
  it('在线表情只发送资源ID，重试去重且不携带图片数据', async () => {
    const payloads = [];
    const store = { state: { room: { tableId: 'room' }, session: { userId: 'me' }, connection: 'online' }, onChange() {}, usesRemoteAdapter: () => false,
      socket: { request: async (_event,payload) => { payloads.push(payload); return payloads.length === 1 ? {ok:false} : {ok:true,message:{id:'1',tableId:'room',text:'',sticker:{id:'allin'},at:1}}; } } };
    const chat = new RoomChat(store); chat.reset('room');
    expect(await chat.send('',{id:'allin',url:'unused'})).toBe(false);
    expect(await chat.send('',{id:'allin',url:'unused'})).toBe(true);
    expect(payloads[0].stickerId).toBe('allin'); expect(payloads[0].clientId).toBe(payloads[1].clientId);
    expect(payloads[0].text).toBeUndefined(); expect(payloads[0].url).toBeUndefined();
    expect(chat.messages[0].sticker.id).toBe('allin');
  });
});
