import { node, tag, button } from './base.js';
import { STICKERS, stickerUrl, importStickerImage } from '../core/stickers.js';
import { readStore, writeStore } from '../core/config.js';
import * as api from '../net/api.js';

export function stickerImage(sticker, offline) {
  const wrap = node('sticker-image'); const img = tag('img');
  const name = STICKERS.find(s => s.id === sticker.id)?.name || sticker.name || '自定义表情';
  img.alt = name; img.src = stickerUrl(sticker, offline); img.width = 128; img.height = 128;
  const fallback = tag('span', 'hidden sticker-fallback', '表情加载失败');
  img.onerror = () => { img.classList.add('hidden'); fallback.classList.remove('hidden'); };
  wrap.append(img, fallback); return wrap;
}

export class StickerPicker {
  constructor(store, onSelect) {
    this.store = store; this.onSelect = onSelect; this.custom = []; this.root = node('sticker-picker');
    this.selected = node('sticker-selected hidden'); this.root.appendChild(this.selected);
    this.gallery = node('sticker-gallery hidden');
    this.gallery.appendChild(tag('div', 'sticker-section-title', '牌桌表情 · 选择后点击发送'));
    const builtin = node('sticker-grid');
    for (const sticker of STICKERS) builtin.appendChild(this.option(sticker));
    this.gallery.appendChild(builtin);
    const heading = node('sticker-library-heading'); heading.appendChild(tag('span', 'sticker-section-title', '我的表情'));
    this.importButton = button({ label: '＋ 导入图片', className: 'btn-ghost btn-xs', onClick: () => this.fileInput.click() });
    heading.appendChild(this.importButton); this.gallery.appendChild(heading);
    this.fileInput = tag('input', 'hidden'); this.fileInput.type = 'file'; this.fileInput.accept = 'image/png,image/jpeg,image/webp';
    this.fileInput.addEventListener('change', () => { const file = this.fileInput.files?.[0]; this.fileInput.value = ''; if (file) void this.upload(file); });
    this.gallery.appendChild(this.fileInput);
    this.library = node('sticker-grid'); this.gallery.appendChild(this.library);
    this.gallery.appendChild(tag('p', 'sticker-help', 'PNG / JPEG / WebP · 原图≤5MB · 最多12张'));
    this.status = tag('p', 'sticker-status'); this.status.setAttribute('role', 'status'); this.gallery.appendChild(this.status);
    this.reload = button({ label: '重试加载', className: 'btn-ghost btn-xs hidden', onClick: () => void this.load() }); this.gallery.appendChild(this.reload);
    this.root.appendChild(this.gallery);
  }
  option(sticker) {
    const label = sticker.name || '自定义表情';
    const option = button({ label, className: 'sticker-option', onClick: () => this.select(sticker) });
    option.setAttribute('aria-label', `选择表情：${label}`);
    option.replaceChildren(stickerImage(sticker, this.store.state.offline), tag('span', '', label)); return option;
  }
  toggle() { this.gallery.classList.toggle('hidden'); }
  select(sticker) {
    this.selection = sticker; this.selected.replaceChildren();
    this.selected.append(stickerImage(sticker, this.store.state.offline), tag('span', '', `待发送：${sticker.name || '自定义表情'}`), button({ label: '取消表情', className: 'btn-ghost btn-xs', onClick: () => this.clear() }));
    this.selected.classList.remove('hidden'); this.gallery.classList.add('hidden'); this.onSelect();
  }
  clear() { this.selection = null; this.selected.classList.add('hidden'); this.onSelect(); }
  renderLibrary() {
    this.library.replaceChildren();
    for (const sticker of this.custom) this.library.appendChild(this.option(sticker));
    if (!this.custom.length) this.library.appendChild(tag('p', 'sticker-empty', '导入一张，做你的牌桌暗号。'));
  }
  render(state) {
    const key = `${state.offline ? 'offline' : state.serverConfig?.apiBase ?? ''}:${state.session?.userId}`;
    if (key !== this.owner) {
      this.owner = key; this.selection = null; this.selected.classList.add('hidden'); this.gallery.classList.add('hidden');
      this.custom = []; this.renderLibrary(); void this.load();
    }
  }
  async load() {
    const owner = this.owner; const state = this.store.state;
    this.reload.classList.add('hidden'); this.status.textContent = '正在加载…';
    if (!state.offline && !state.session?.token) { this.status.textContent = '登录后可保存自定义表情'; return; }
    try {
      if (state.offline) this.custom = readStore(`2nk.stickers.${state.session.userId}`) ?? [];
      else if (this.store.usesRemoteAdapter()) throw new Error('当前服务器暂不支持表情');
      else {
        const result = await api.listStickers(state.session.token);
        if (owner !== this.owner) return;
        if (!result.ok) throw new Error(result.message || '表情加载失败');
        this.custom = result.stickers;
      }
      if (owner !== this.owner) return;
      this.status.textContent = ''; this.renderLibrary();
    } catch (error) {
      if (owner === this.owner) { this.status.textContent = error.message; this.reload.classList.remove('hidden'); }
    }
  }
  async upload(file) {
    if (this.importButton.disabled) return;
    if (this.custom.length >= 12) { this.status.textContent = '最多保存12张自定义表情'; return; }
    const owner = this.owner; const session = this.store.state.session; const offline = this.store.state.offline;
    const room = this.store.state.room.tableId;
    this.importButton.disabled = true; this.status.textContent = '正在处理图片…';
    try {
      const image = await importStickerImage(file);
      if (owner !== this.owner) return;
      let sticker;
      if (offline) {
        sticker = { id: crypto.randomUUID(), name: image.name, url: image.dataUrl };
        if (!writeStore(`2nk.stickers.${session.userId}`, [...this.custom, sticker])) throw new Error('本机存储空间不足，导入失败');
      } else {
        const result = await api.uploadSticker(session.token, image);
        if (!result.ok) throw new Error(result.message || '上传失败，请重试');
        sticker = result.sticker;
      }
      if (owner !== this.owner) return;
      if (!this.custom.some(s => s.id === sticker.id)) this.custom.push(sticker);
      this.renderLibrary(); this.status.textContent = '';
      if (room === this.store.state.room.tableId) this.select(sticker);
    } catch (error) { if (owner === this.owner) this.status.textContent = error.message || '图片导入失败，请重试'; }
    finally { this.importButton.disabled = false; }
  }
}
