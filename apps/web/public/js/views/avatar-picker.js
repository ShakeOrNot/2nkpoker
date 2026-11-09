import { node, tag, button } from './base.js';
import { AVATARS, avatarId } from '../core/avatars.js';
import { avatarEl, paintAvatar } from './avatar.js';

export class AvatarPicker {
  constructor(store) {
    this.store = store;
    this.root = node('modal-overlay avatar-overlay');
    const card = node('modal-card avatar-picker');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', '选择头像');
    card.appendChild(tag('div', 'avatar-eyebrow', 'THE PRIVATE TABLE'));
    card.appendChild(tag('h3', 'modal-title', '你的牌桌形象'));
    this.hero = avatarEl('lion', 'avatar-hero');
    card.appendChild(this.hero);
    this.name = tag('div', 'avatar-choice-name'); card.appendChild(this.name);
    const grid = node('avatar-grid');
    this.options = AVATARS.map(item => {
      const option = button({ label: item.name, className: 'avatar-option', onClick: () => this.select(item.id) });
      option.replaceChildren(avatarEl(item.id), tag('span', '', item.name));
      grid.appendChild(option);
      return option;
    });
    card.appendChild(grid);
    this.hint = tag('p', 'modal-hint'); card.appendChild(this.hint);
    this.status = tag('p', 'avatar-status'); this.status.setAttribute('role', 'status'); card.appendChild(this.status);
    const actions = node('modal-actions');
    this.cancel = button({ label: '取消', className: 'btn-ghost', onClick: () => this.close() });
    this.save = button({ label: '保存头像', className: 'btn-primary', onClick: () => void this.submit() });
    actions.append(this.cancel, this.save); card.appendChild(actions); this.root.appendChild(card);
    this.root.addEventListener('click', e => { if (e.target === this.root) this.close(); });
    this.root.addEventListener('keydown', e => {
      if (e.key === 'Escape') this.close();
      if (e.key === 'Tab') {
        const controls = [...this.options, this.cancel, this.save].filter(el => !el.disabled);
        const index = controls.indexOf(document.activeElement);
        e.preventDefault(); controls[(index + (e.shiftKey ? controls.length - 1 : 1)) % controls.length]?.focus();
      }
    });
  }
  select(id) {
    this.value = avatarId(id); paintAvatar(this.hero, this.value);
    this.name.textContent = AVATARS.find(a => a.id === this.value).name;
    this.options.forEach((el, i) => el.setAttribute('aria-pressed', String(AVATARS[i].id === this.value)));
  }
  open() {
    this.focusBefore = document.activeElement;
    this.select(this.store.state.session?.user?.avatarId);
    this.hint.textContent = this.store.state.offline ? '保存在本机，下一次登录继续使用。' : '保存到账号，牌友也能看到你的新形象。';
    this.status.textContent = '';
    this.root.classList.add('visible'); this.options[0].focus?.();
  }
  close() { this.root.classList.remove('visible'); this.focusBefore?.focus?.(); }
  async submit() {
    if (this.save.disabled) return;
    this.save.disabled = true; this.status.textContent = '正在保存…';
    try {
      const result = await this.store.updateAvatar(this.value);
      if (result.ok) this.close();
      else this.status.textContent = result.message || '保存失败，请重试';
    } catch { this.status.textContent = '保存失败，请重试'; }
    finally { this.save.disabled = false; }
  }
}
