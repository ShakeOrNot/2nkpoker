export class RoomChat {
  constructor(store) { this.store = store; this.reset(''); }
  reset(tableId) {
    this.tableId = tableId; this.messages = []; this.unread = 0; this.open = false;
    this.error = ''; this.pending = null; this.sending = false; this.loaded = false;
    this.generation = (this.generation ?? 0) + 1;
  }
  notify() { this.store.onChange(); }
  receive(message, history = false) {
    if (!message?.id || message.tableId !== this.tableId || message.tableId !== this.store.state.room.tableId ||
        typeof message.text !== 'string' || this.messages.some(m => m.id === message.id)) return;
    this.messages = [...this.messages, message].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)).slice(-80);
    if (!history && !this.open && message.userId !== this.store.state.session?.userId) this.unread++;
    if (!history) this.notify();
  }
  async load() {
    if (!this.tableId || this.store.state.offline || this.store.usesRemoteAdapter()) { this.loaded = true; return; }
    const generation = this.generation;
    const result = await this.store.socket?.request('chat:history', { tableId: this.tableId });
    if (generation !== this.generation) return;
    if (result?.ok) {
      for (const message of result.messages ?? []) this.receive(message, true);
      this.loaded = true; this.error = '';
    } else this.error = result?.message || '聊天记录加载失败，请重试';
    this.notify();
  }
  toggle(open = !this.open) {
    this.open = open;
    if (open) { this.unread = 0; if (!this.loaded) void this.load(); }
    this.notify();
  }
  async send(text, sticker = null) {
    const value = String(text ?? '').trim();
    if (this.sending || (!value && !sticker) || value.length > 280) return false;
    if (this.store.state.connection !== 'online') { this.error = '连接已断开，消息未发送'; this.notify(); return false; }
    if (this.store.usesRemoteAdapter() && !this.store.state.offline) { this.error = '当前服务器暂不支持房间聊天'; this.notify(); return false; }
    const generation = this.generation;
    const key = sticker ? `sticker:${sticker.id}` : `text:${value}`;
    const clientId = this.pending?.key === key ? this.pending.clientId : `msg_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
    this.pending = { text: value, key, clientId }; this.sending = true; this.error = ''; this.notify();
    try {
      let result;
      if (this.store.state.offline) {
        const session = this.store.state.session;
        result = { ok: true, message: { id: clientId, clientId, tableId: this.tableId, userId: session.userId, nickname: session.nickname, avatarId: session.user?.avatarId, text: sticker ? '' : value, ...(sticker ? { sticker } : {}), at: Date.now() } };
      } else result = await this.store.socket.request('chat:send', { tableId: this.tableId, ...(sticker ? { stickerId: sticker.id } : { text: value }), clientId });
      if (generation !== this.generation) return false;
      if (!result?.ok) { this.error = result?.message || '发送未确认，重试将避免重复消息'; return false; }
      this.receive(result.message); this.pending = null; return true;
    } catch { if (generation === this.generation) this.error = '发送未确认，请重试'; return false; }
    finally { if (generation === this.generation) { this.sending = false; this.notify(); } }
  }
}
