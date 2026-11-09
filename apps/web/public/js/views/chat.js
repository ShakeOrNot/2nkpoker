import { node, tag, button } from './base.js';
import { avatarEl } from './avatar.js';
import { StickerPicker, stickerImage } from './sticker-picker.js';

export class ChatView {
  constructor(store) {
    this.store = store; this.chat = store.chat;
    this.root = node('room-chat hidden');
    this.launcher = button({ label: '房间聊天', className: 'chat-launcher', onClick: () => this.toggle() });
    this.launcher.setAttribute('aria-controls', 'room-chat-panel');
    this.root.appendChild(this.launcher);
    this.panel = node('chat-panel hidden'); this.panel.id = 'room-chat-panel';
    this.panel.setAttribute('role', 'region'); this.panel.setAttribute('aria-label', '房间聊天');
    const header = node('chat-header');
    const title = node(''); title.append(tag('small', 'chat-eyebrow', 'TABLE TALK'), tag('h3', '', '牌桌闲聊'));
    header.appendChild(title);
    header.appendChild(button({ label: '关闭聊天', className: 'btn-ghost btn-sm', onClick: () => this.toggle(false) }));
    this.panel.appendChild(header);
    this.hint = tag('p', 'chat-hint'); this.panel.appendChild(this.hint);
    this.list = node('chat-messages'); this.list.setAttribute('role', 'log'); this.list.setAttribute('aria-label', '聊天消息');
    this.list.setAttribute('aria-live', 'polite'); this.panel.appendChild(this.list);
    this.newMessage = button({ label: '查看新消息 ↓', className: 'chat-new hidden', onClick: () => { this.list.scrollTop = this.list.scrollHeight; this.newMessage.classList.add('hidden'); } });
    this.panel.appendChild(this.newMessage);
    this.status = tag('p', 'chat-status'); this.status.setAttribute('role', 'status'); this.panel.appendChild(this.status);
    this.retry = button({ label: '重新加载记录', className: 'btn-ghost btn-xs hidden', onClick: () => void this.chat.load() }); this.panel.appendChild(this.retry);
    const compose = node('chat-compose');
    this.stickers = new StickerPicker(store, () => this.updateComposer());
    compose.appendChild(this.stickers.root);
    this.input = tag('textarea', 'input chat-input'); this.input.rows = 2; this.input.maxLength = 280;
    this.input.placeholder = '聊两句，下一手见…'; this.input.setAttribute('aria-label', '聊天内容');
    this.input.addEventListener('input', () => this.updateComposer());
    this.input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void this.submit(); } });
    compose.appendChild(this.input);
    const footer = node('chat-compose-footer'); this.counter = tag('span', 'chat-counter', '0/280');
    this.stickerButton = button({ label: '表情包', className: 'btn-ghost btn-sm', onClick: () => this.stickers.toggle() });
    footer.appendChild(this.stickerButton);
    this.send = button({ label: '发送', className: 'btn-primary btn-sm', onClick: () => void this.submit() });
    footer.append(this.counter, this.send); compose.appendChild(footer); this.panel.appendChild(compose); this.root.appendChild(this.panel);
    this.root.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); this.toggle(false); } });
  }
  toggle(open = !this.chat.open) {
    if (open) this.newMessage.classList.add('hidden');
    this.chat.toggle(open);
    if (open) this.input.focus?.({ preventScroll: true }); else this.launcher.focus?.();
  }
  updateComposer() {
    this.counter.textContent = `${this.input.value.length}/280`;
    this.send.disabled = this.chat.sending || (!this.input.value.trim() && !this.stickers.selection) || this.store.state.connection !== 'online';
    this.send.textContent = this.chat.sending ? '发送中…' : '发送';
  }
  async submit() {
    if (this.send.disabled) return;
    const text = this.input.value; const room = this.chat.tableId;
    const sticker = this.stickers.selection;
    this.list.scrollTop = this.list.scrollHeight;
    this.newMessage.classList.add('hidden');
    if (await this.chat.send(sticker ? '' : text, sticker)) {
      if (room === this.chat.tableId && !sticker && this.input.value === text) this.input.value = '';
      if (room === this.chat.tableId && sticker === this.stickers.selection) this.stickers.clear();
      this.updateComposer();
    }
  }
  render(state) {
    const active = Boolean(state.room.tableId) && ['waiting', 'table'].includes(state.phase);
    this.root.classList.toggle('hidden', !active);
    if (!active) { this.chat.open = false; this.wasOpen = false; return; }
    if (this.roomKey !== this.chat.tableId) {
      this.roomKey = this.chat.tableId; this.input.value = ''; this.lastMessages = null;
      this.renderedMessageIds = new Set();
      this.newMessage.classList.add('hidden');
      this.stickers.selection = null; this.stickers.selected.classList.add('hidden'); this.stickers.gallery.classList.add('hidden');
    }
    this.stickers.render(state);
    this.launcher.textContent = `房间聊天${this.chat.unread ? ` · ${Math.min(99, this.chat.unread)} 未读` : ''}`;
    this.launcher.setAttribute('aria-expanded', String(this.chat.open));
    this.panel.classList.toggle('hidden', !this.chat.open);
    this.hint.textContent = state.offline ? '离线练习 · 消息仅在本机显示' : `房间 ${state.room.tableId} · 最近 80 条 · Enter 发送`;
    this.status.textContent = this.chat.error || (state.connection !== 'online' ? '连接已断开，草稿已保留' : '');
    this.retry.classList.toggle('hidden', this.chat.loaded || !this.chat.error);
    this.updateComposer();
    if (!this.chat.open) { this.wasOpen = false; return; }
    if (this.lastMessages !== this.chat.messages) {
      const bottom = !this.wasOpen || this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 45;
      const top = this.list.scrollTop;
      this.list.replaceChildren();
      if (!this.chat.messages.length) this.list.appendChild(tag('p', 'chat-empty', '牌局有胜负，牌友有话聊。'));
      for (const message of this.chat.messages) {
        const row = node(`chat-message${message.userId === state.session?.userId ? ' chat-mine' : ''}`);
        row.appendChild(avatarEl(message.avatarId));
        const content = node('chat-message-content');
        const meta = node('chat-message-meta');
        meta.append(tag('span', '', message.nickname), tag('time', '', new Date(message.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })));
        content.appendChild(meta);
        const body = message.sticker ? stickerImage(message.sticker, state.offline) : tag('p', 'chat-text', message.text);
        if (message.sticker && this.wasOpen && !this.renderedMessageIds?.has(message.id)) body.classList.add('sticker-new');
        content.appendChild(body);
        row.appendChild(content); this.list.appendChild(row);
      }
      if (bottom) this.list.scrollTop = this.list.scrollHeight;
      else { this.list.scrollTop = top; this.newMessage.classList.remove('hidden'); }
      this.lastMessages = this.chat.messages;
      this.renderedMessageIds = new Set(this.chat.messages.map(m => m.id));
    } else if (!this.wasOpen) this.list.scrollTop = this.list.scrollHeight;
    this.wasOpen = true;
  }
}
