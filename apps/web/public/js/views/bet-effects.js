import { node, tag } from './base.js';
import { chips } from '../core/format.js';

// 仅保存下注公开信息，不能因减筹码、补码或重复快照误播下注。
export function betSnapshot(tableId, hand) {
  return hand ? {
    key: `${tableId}:${hand.handId}`, street: hand.street, settled: Boolean(hand.settled), version: hand.version,
    seats: (hand.seats ?? []).map(s => ({ seat: s.seat, bet: Number(s.betThisStreet ?? 0), committed: Number(s.totalCommitted ?? 0) })),
  } : null;
}

export function betTransitions(previous, current) {
  if (!previous || !current || previous.key !== current.key || previous.settled || current.settled) return [];
  if (Number.isFinite(previous.version) && Number.isFinite(current.version) && current.version < previous.version) return [];
  const changedStreet = previous.street !== current.street;
  // 最后一笔跟注可能直接触发换街，新快照已清空本街下注。
  // 用累计投入差补回该笔金额，并扣除新街已经投入的部分。
  const events = changedStreet ? previous.seats.map(prior => {
    const seat = current.seats.find(s => s.seat === prior.seat);
    const amount = seat ? Math.max(0, prior.bet + seat.committed - prior.committed - seat.bet) : prior.bet;
    return { type: 'collect', seat: prior.seat, amount };
  }).filter(event => event.amount > 0) : [];
  for (const seat of current.seats) {
    const prior = previous.seats.find(s => s.seat === seat.seat);
    if (!prior) continue;
    const increase = changedStreet ? seat.bet : seat.bet - prior.bet;
    const committed = seat.committed - prior.committed;
    const amount = Math.min(increase, committed);
    if (amount > 0) events.push({ type: 'bet', seat: seat.seat, amount });
  }
  return events;
}

function center(el) {
  const rect = el?.getBoundingClientRect?.();
  return rect?.width && rect.height ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
}

export class BetEffects {
  constructor(host) {
    this.host = host;
    this.batches = new Set();
    this.preference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.reset = this.reset.bind(this);
    this.onVisibility = () => { if (document.visibilityState === 'hidden') this.reset(); };
    this.onPreference = () => { if (this.preference?.matches) this.reset(); };
  }

  connect(stage) {
    this.stage = stage;
    window.addEventListener?.('resize', this.reset);
    stage.addEventListener?.('scroll', this.reset, { passive: true });
    document.addEventListener?.('visibilitychange', this.onVisibility);
    this.preference?.addEventListener?.('change', this.onPreference);
  }

  clear() {
    for (const batch of this.batches) { clearTimeout(batch.timer); batch.layer.remove(); }
    this.batches.clear();
  }

  reset() { this.clear(); this.previous = null; this.positions = new Map(); }

  disconnect() {
    this.reset();
    window.removeEventListener?.('resize', this.reset);
    this.stage?.removeEventListener?.('scroll', this.reset);
    document.removeEventListener?.('visibilitychange', this.onVisibility);
    this.preference?.removeEventListener?.('change', this.onPreference);
  }

  update(tableId, hand, seats, targets, pot) {
    const current = betSnapshot(tableId, hand);
    if (current && this.previous?.key === current.key && Number.isFinite(current.version) &&
        Number.isFinite(this.previous.version) && current.version < this.previous.version) return;
    const before = this.previous;
    const events = betTransitions(before, current);
    const oldPositions = this.positions ?? new Map();
    if (!current || this.previous?.key !== current.key || current.settled || events.some(e => e.type === 'collect')) this.clear();
    this.previous = current;
    this.positions = new Map();
    for (const row of current?.seats ?? []) {
      if (row.bet > 0) this.positions.set(row.seat, center(targets.get(row.seat)));
    }
    if (!events.length || this.preference?.matches || document.visibilityState === 'hidden' || !this.stage?.getBoundingClientRect) return;
    const bounds = this.stage.getBoundingClientRect();
    const inside = point => point && point.x >= Math.max(0, bounds.left) && point.x <= Math.min(window.innerWidth, bounds.right) &&
      point.y >= Math.max(0, bounds.top) && point.y <= Math.min(window.innerHeight, bounds.bottom);
    const layer = node('bet-effects');
    layer.setAttribute('aria-hidden', 'true');
    let collectionLabelAdded = false;
    for (const event of events) {
      const seatCenter = center(seats.get(event.seat)?.querySelector('.seat-name'));
      const source = event.type === 'collect' ? oldPositions.get(event.seat) ?? seatCenter : seatCenter;
      const target = event.type === 'collect' ? center(pot) : this.positions.get(event.seat);
      if (!inside(source) || !inside(target)) continue;
      for (let i = 0; i < 2; i++) {
        const stack = node('payout-stack bet-stack');
        stack.style.setProperty('--from-x', `${source.x + i * 9}px`);
        stack.style.setProperty('--from-y', `${source.y}px`);
        stack.style.setProperty('--to-x', `${target.x - source.x}px`);
        stack.style.setProperty('--to-y', `${target.y - source.y}px`);
        stack.style.setProperty('--delay', `${i * 65}ms`);
        for (let j = 0; j < 3; j++) {
          const chip = tag('span', 'payout-chip', '♠');
          chip.style.setProperty('--chip-level', String(j));
          stack.appendChild(chip);
        }
        layer.appendChild(stack);
      }
      if (event.type === 'collect' && collectionLabelAdded) continue;
      const amount = event.type === 'collect' ? events.filter(e => e.type === 'collect').reduce((sum, e) => sum + e.amount, 0) : event.amount;
      if (event.type === 'collect') collectionLabelAdded = true;
      const priorMax = Math.max(0, ...(before?.seats ?? []).map(s => s.bet));
      const currentBet = current.seats.find(s => s.seat === event.seat)?.bet ?? 0;
      const action = event.type === 'collect' ? '收池' : priorMax === 0 ? '下注' : currentBet > priorMax ? '加注' : '跟注';
      const label = tag('span', 'bet-transfer-label', `${action} +${chips(amount)}`);
      label.style.left = `${target.x}px`;
      label.style.top = `${target.y - 25}px`;
      layer.appendChild(label);
    }
    if (!layer.children.length) return;
    this.host.appendChild(layer);
    const batch = { layer, timer: null };
    batch.timer = setTimeout(() => { layer.remove(); this.batches.delete(batch); }, 1050);
    this.batches.add(batch);
  }
}
