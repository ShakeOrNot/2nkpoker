import { cardEl, dealtCardEl } from './cards.js';
import { node } from './base.js';

// 只使用本手参与人数与公开的公共牌数量；当前引擎没有额外烧牌。
export function deckVisualState(hand) {
  const players = hand?.seats?.length ?? 0;
  const dealt = hand ? players * 2 + Math.min(5, hand.board?.length ?? 0) : 0;
  return { remaining: Math.max(0, 52 - dealt), thickness: Math.max(5, 18 - dealt * 0.8) };
}

export class TableMotion {
  constructor() {
    this.active = new Set();
    this.preference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.onVisibility = () => { if (document.visibilityState === 'hidden') this.clear(); };
    this.onPreference = () => { if (this.preference?.matches) this.clear(); };
    this.onResize = () => this.clear();
  }

  connect() {
    document.addEventListener?.('visibilitychange', this.onVisibility);
    this.preference?.addEventListener?.('change', this.onPreference);
    window.addEventListener?.('resize', this.onResize);
  }

  disconnect() {
    this.clear();
    document.removeEventListener?.('visibilitychange', this.onVisibility);
    this.preference?.removeEventListener?.('change', this.onPreference);
    window.removeEventListener?.('resize', this.onResize);
  }

  clear() {
    for (const animation of this.active) animation.cancel();
    this.active.clear();
  }

  play(el, frames, options = {}) {
    if (!el?.animate || this.preference?.matches || document.visibilityState === 'hidden') return;
    const animation = el.animate(frames, { duration: 400, easing: 'cubic-bezier(.2,.8,.2,1)', ...options });
    this.active.add(animation);
    // 结束或取消后都释放引用，不为无关状态更新重建动画。
    animation.finished.then(() => this.active.delete(animation), () => this.active.delete(animation));
  }

  deal(el, deck, index = 0) {
    const source = deck?.getBoundingClientRect?.();
    const target = el?.getBoundingClientRect?.();
    if (!source?.width || !target?.width) return;
    const x = source.left + source.width / 2 - target.left - target.width / 2;
    const y = source.top + source.height / 2 - target.top - target.height / 2;
    this.play(el, [
      { transform: `translate(${x}px, ${y}px) rotate(-8deg) scale(.75)`, opacity: 1 },
      { transform: 'translate(0, 0) rotate(0) scale(1)', opacity: 1 },
    ], { duration: 420, delay: index * 65, fill: 'backwards' });
  }

  reveal(el, deck, index = 0, stagger = 110) {
    const source = deck?.getBoundingClientRect?.();
    const target = el?.getBoundingClientRect?.();
    const x = source?.width && target?.width ? source.left + source.width / 2 - target.left - target.width / 2 : 0;
    const y = source?.width && target?.width ? source.top + source.height / 2 - target.top - target.height / 2 : 0;
    this.play(el, [
      { transform: `perspective(600px) translate(${x}px, ${y}px) rotate(-8deg) rotateY(180deg) scale(.75)`, offset: 0 },
      { transform: 'perspective(600px) translate(0, 0) rotate(0) rotateY(180deg) scale(1)', offset: 0.6 },
      { transform: 'perspective(600px) translate(0, 0) rotate(0) rotateY(0) scale(1)', offset: 1 },
    ], { duration: 640, delay: index * stagger, fill: 'backwards' });
  }
}

// 固定五个牌位。只替换发生变化的那张，翻转新牌时旧牌节点保持不动。
export class BoardView {
  constructor(motion) {
    this.motion = motion;
    this.root = node('board');
    this.slots = Array.from({ length: 5 }, () => {
      const slot = node('board-position');
      slot.appendChild(cardEl('', { size: 'lg' }));
      slot.children[0].classList.add('card-slot');
      slot.children[0].textContent = '';
      this.root.appendChild(slot);
      return slot;
    });
    this.cards = [];
    this.handKey = '';
  }

  update(handKey, cards = [], settled = false, deck = null) {
    const sameHand = Boolean(handKey) && this.handKey === handKey;
    for (let i = 0; i < 5; i++) {
      const next = cards[i] ?? '';
      if (sameHand && (this.cards[i] ?? '') === next) continue;
      const el = next ? dealtCardEl(next, { size: 'lg' }) : cardEl('', { size: 'lg' });
      if (!next) { el.classList.add('card-slot'); el.textContent = ''; }
      this.slots[i].replaceChildren(el);
      if (sameHand && next && !this.cards[i] && !settled) {
        this.motion.reveal(el, deck, Math.max(0, i - this.cards.length));
      }
    }
    this.handKey = handKey;
    this.cards = [...cards];
  }
}
