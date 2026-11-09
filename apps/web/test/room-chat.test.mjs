import { describe, it, expect } from 'vitest';
import { RoomChat } from '../public/js/core/room-chat.js';
import { Store } from '../public/js/store.js';
import { ChatView } from '../public/js/views/chat.js';
function setup() {
  const store = { state: { room: { tableId: 'r1' }, session: { userId: 'me', nickname: '我' }, connection: 'online' }, onChange() {}, usesRemoteAdapter: () => false };
  const chat = new RoomChat(store); chat.reset('r1');
  return { chat, store };
}
const message = (id, extra = {}) => ({ id, tableId: 'r1', userId: 'other', text: '你好', at: 1, ...extra });
describe('房间聊天状态', () => {
  it('直接加入已有房间时初始化聊天，离开房间后清空', async () => {
    const store = new Store(); store.state.offline = true;
    store.state.session = { userId: 'me', nickname: '我' }; store.state.connection = 'online';
    store.ensureSocket = async () => ({ ok: true });
    store.socket = { request: async () => ({ ok: true }) };
    expect((await store.joinRoom('existing')).ok).toBe(true);
    expect(store.chat.tableId).toBe('existing');
    expect(await store.chat.send('你好')).toBe(true); expect(store.chat.messages.length).toBe(1);
    store.patchRoom({ tableId: '' }); expect(store.chat.messages.length).toBe(0);
  });
  it('拒绝跨房消息，重复广播/历史只入库一次', () => {
    const { chat } = setup();
    chat.receive(message('1')); chat.receive(message('1')); chat.receive(message('2', { tableId: 'r2' }));
    expect(chat.messages.length).toBe(1); expect(chat.unread).toBe(1);
    chat.receive(message('3'), true); expect(chat.unread).toBe(1);
    chat.toggle(true); expect(chat.unread).toBe(0);
    chat.receive(message('4')); expect(chat.unread).toBe(0);
  });
  it('记录最多保留80条，自发消息不增加未读', () => {
    const { chat } = setup();
    for (let i = 0; i < 85; i++) chat.receive(message(String(i), { at: i, userId: 'me' }));
    expect(chat.messages.length).toBe(80); expect(chat.messages[0].id).toBe('5'); expect(chat.unread).toBe(0);
  });
  it('读旧消息时保留滚动位置并提示新消息', () => {
    const { chat, store } = setup(); store.chat = chat; store.state.phase = 'waiting'; chat.loaded = true; chat.open = true;
    const view = new ChatView(store); view.render(store.state);
    view.list.scrollHeight = 600; view.list.clientHeight = 200; view.list.scrollTop = 10;
    chat.receive(message('new', { text: '<b>普通文本</b>' })); view.render(store.state);
    expect(view.list.scrollTop).toBe(10); expect(view.newMessage.classList.contains('hidden')).toBe(false);
  });
  it('未确认发送重试使用相同clientId，确认后不重复回显', async () => {
    const { chat, store } = setup(); const ids = [];
    store.socket = { request: async (_event, payload) => {
      ids.push(payload.clientId);
      if (ids.length === 1) return { ok: false };
      const m = message('confirmed', { userId: 'me' }); chat.receive(m);
      return { ok: true, message: m };
    } };
    expect(await chat.send('你好')).toBe(false); expect(await chat.send('你好')).toBe(true);
    expect(ids[0]).toBe(ids[1]); expect(chat.messages.length).toBe(1);
  });
  it('切房后迟到的发送确认和历史不能污染新房', async () => {
    const { chat, store } = setup(); let respond;
    store.socket = { request: () => new Promise(resolve => { respond = resolve; }) };
    const sending = chat.send('旧房消息'); chat.reset('r2'); store.state.room.tableId = 'r2';
    respond({ ok: true, message: message('old') });
    expect(await sending).toBe(false); expect(chat.messages.length).toBe(0); expect(chat.sending).toBe(false);
    const loading = chat.load(); chat.reset('r3'); store.state.room.tableId = 'r3';
    respond({ ok: true, messages: [message('late')] }); await loading;
    expect(chat.messages.length).toBe(0); expect(chat.loaded).toBe(false);
  });
  it('断网和超长空白内容不会发送，离线消息有自己的身份', async () => {
    const { chat, store } = setup(); let sent = 0;
    store.socket = { request: () => { sent++; } };
    expect(await chat.send(' '.repeat(10))).toBe(false);
    expect(await chat.send('长'.repeat(281))).toBe(false);
    store.state.connection = 'offline'; expect(await chat.send('你好')).toBe(false); expect(sent).toBe(0);
    store.state.connection = 'online'; store.state.offline = true;
    expect(await chat.send('<img onerror=alert(1)>')).toBe(true);
    expect(chat.messages[0].text).toBe('<img onerror=alert(1)>'); expect(chat.messages[0].userId).toBe('me');
  });
});
