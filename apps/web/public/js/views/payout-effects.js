import { node, tag } from './base.js';
import { chips } from '../core/format.js';
import { settlement } from '../core/logic.js';

// 最后一堆筹码 180ms 后出发，飞行 1200ms，落座保留 500ms。
export const PAYOUT_REVEAL_MS = 1880;

// 所有正数派彩（包括分池和返还）都显示到账；只有净收益为正的座位用赢家金框。
export function payoutRecipients(hand) {
  return settlement(hand).rows.filter((row) => row.won > 0).map((row) => ({
    seat: row.seat, amount: row.won, winner: row.net > 0,
  }));
}

export class PayoutEffects {
  constructor(host) {
    this.host = host;
    this.targets = [];
    this.clear = this.clear.bind(this);
  }

  clear() {
    clearTimeout(this.timer);
    this.timer = null;
    this.layer?.remove();
    this.layer = null;
    for (const el of this.targets) el.classList.remove('seat-payout-winner', 'seat-payout-recipient');
    this.targets = [];
    window.removeEventListener?.('resize', this.clear);
    window.removeEventListener?.('orientationchange', this.clear);
    this.stage?.removeEventListener?.('scroll', this.clear);
  }

  play(hand, pot, seatNodes, stage) {
    this.clear();
    // 不为了动画把屏外座位滚进来；减少动态模式直接显示结算明细。
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ||
        document.visibilityState === 'hidden' || !pot?.getBoundingClientRect) return false;
    const origin = pot.getBoundingClientRect();
    const bounds = stage.getBoundingClientRect();
    const sx = origin.left + origin.width / 2;
    const sy = origin.top + origin.height / 2;
    if (!origin.width || !bounds.width || sx < 0 || sx > window.innerWidth || sy < 0 || sy > window.innerHeight) return false;
    const destinations = payoutRecipients(hand).flatMap((row) => {
      const el = seatNodes.get(row.seat);
      const rect = el?.getBoundingClientRect?.();
      if (!rect?.width) return [];
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (x < Math.max(0, bounds.left) || x > Math.min(window.innerWidth, bounds.right) ||
          y < Math.max(0, bounds.top) || y > Math.min(window.innerHeight, bounds.bottom)) return [];
      return [{ ...row, el, x, y, rect }];
    });
    if (!destinations.length) return false;
    const layer = node('payout-effects');
    layer.setAttribute('aria-hidden', 'true');
    for (const row of destinations) {
      row.el.classList.add(row.winner ? 'seat-payout-winner' : 'seat-payout-recipient');
      this.targets.push(row.el);
      for (let i = 0; i < 3; i++) {
        const stack = node('payout-stack');
        const offset = (i - 1) * 24;
        stack.style.setProperty('--from-x', `${sx + offset}px`);
        stack.style.setProperty('--from-y', `${sy}px`);
        stack.style.setProperty('--to-x', `${row.x - sx}px`);
        stack.style.setProperty('--to-y', `${row.y - sy + row.rect.height / 2 - 8}px`);
        stack.style.setProperty('--delay', `${i * 90}ms`);
        for (let j = 0; j < 4; j++) {
          const chip = tag('span', 'payout-chip', '♠');
          chip.style.setProperty('--chip-level', String(j));
          stack.appendChild(chip);
        }
        layer.appendChild(stack);
      }
      const label = tag('span', 'payout-arrival', `派彩 +${chips(row.amount)}`);
      label.style.left = `${row.x}px`;
      label.style.top = `${Math.min(window.innerHeight - 25, row.y + row.rect.height / 2 + 24)}px`;
      layer.appendChild(label);
      if (row.winner) {
        const halo = node('payout-halo');
        halo.style.left = `${row.x}px`;
        halo.style.top = `${row.y}px`;
        halo.style.width = `${row.rect.width + 18}px`;
        halo.style.height = `${row.rect.height + 18}px`;
        layer.appendChild(halo);
        const badge = tag('span', 'payout-winner-badge', '♛ 赢得底池');
        badge.style.left = `${row.x}px`;
        badge.style.top = `${Math.max(22, row.rect.top - 12)}px`;
        layer.appendChild(badge);
      }
    }
    this.layer = layer;
    this.stage = stage;
    this.host.appendChild(layer);
    window.addEventListener?.('resize', this.clear);
    window.addEventListener?.('orientationchange', this.clear);
    stage.addEventListener?.('scroll', this.clear, { passive: true });
    this.timer = setTimeout(this.clear, PAYOUT_REVEAL_MS + 50);
    return true;
  }
}
