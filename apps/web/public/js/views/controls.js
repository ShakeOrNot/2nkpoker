/**
 * 紧凑操作栏：
 *   主按钮：弃牌 / 过牌（或跟注） / 下注（弹出金额面板） / 买入
 *   快捷：最多 5 个下注筹码（1/3、半池、2/3、满池、全下等）
 * 金额输入、滑块、加减号放进"下注"弹出面板，默认不占桌面空间。
 */
import { node, setDisabled, setText, tag } from './base.js';
import { chips, potPercent } from '../core/format.js';
import { validateBetAmount, maxBetTarget } from '../core/logic.js';

export class ControlsView {
  /**
   * @param {import('../store.js').Store} store
   * @param {{ onAction: (action: any) => void, onRebuy?: () => void }} options
   */
  constructor(store, options) {
    this.store = store;
    this.onAction = options.onAction;
    this.onRebuy = options.onRebuy;
    this.handKey = '';
    this.customTouched = false;
    this.root = node('controls');
    this.build();
  }

  build() {
    /* 主按钮行：弃牌 / 过牌(跟注) / 下注 / 买入 */
    const primary = node('ctrl-row ctrl-primary');
    this.foldBtn = this.mkAction('弃牌', 'btn-fold', { type: 'fold' });
    this.checkBtn = document.createElement('button');
    this.checkBtn.type = 'button';
    this.checkBtn.className = 'btn btn-check';
    this.checkBtn.textContent = '过牌';
    this.checkBtn.addEventListener('click', () => {
      const ctx = this.store.actionContext();
      if (ctx.legal.includes('check')) this.onAction({ type: 'check' });
      else if (ctx.legal.includes('call')) this.onAction({ type: 'call' });
    });

    this.betBtn = document.createElement('button');
    this.betBtn.type = 'button';
    this.betBtn.className = 'btn btn-primary btn-bet';
    this.betBtn.textContent = '下注';
    this.betBtn.addEventListener('click', () => this.openBetPanel());

    this.rebuyBtn = document.createElement('button');
    this.rebuyBtn.type = 'button';
    this.rebuyBtn.className = 'btn btn-ghost btn-rebuy';
    this.rebuyBtn.textContent = '买入';
    this.rebuyBtn.addEventListener('click', () => this.onRebuy?.());

    // 兼容旧代码/测试：跟注按钮保留但不再显示（跟注合并在"过牌"按钮上）
    this.callBtn = this.mkAction('跟注', 'btn-call hidden', { type: 'call' });

    primary.appendChild(this.foldBtn);
    primary.appendChild(this.checkBtn);
    primary.appendChild(this.betBtn);
    primary.appendChild(this.rebuyBtn);
    this.root.appendChild(primary);

    /* 快捷下注：最多 5 个 */
    this.quickRow = node('ctrl-quicks');
    this.root.appendChild(this.quickRow);

    /* 下注弹出面板 */
    this.betPopup = node('bet-popup');
    const head = node('bet-popup-head');
    head.appendChild(tag('span', 'bet-popup-title', '下注金额（本街下注到）'));
    this.popupClose = document.createElement('button');
    this.popupClose.type = 'button';
    this.popupClose.className = 'btn btn-ghost btn-step';
    this.popupClose.textContent = '×';
    this.popupClose.addEventListener('click', () => this.closeBetPanel());
    head.appendChild(this.popupClose);
    this.betPopup.appendChild(head);

    this.amountInput = tag('input', 'input input-number');
    this.amountInput.type = 'number';
    this.amountInput.inputMode = 'numeric';
    this.amountInput.step = '1';
    this.amountInput.min = '0';
    this.amountInput.addEventListener('input', () => {
      this.customTouched = true;
      this.syncFromInput();
    });

    const inputRow = node('row row-tight');
    inputRow.appendChild(this.amountInput);
    this.minusBtn = this.mkStep('−', () => this.bump(-1));
    this.plusBtn = this.mkStep('+', () => this.bump(1));
    inputRow.appendChild(this.minusBtn);
    inputRow.appendChild(this.plusBtn);
    this.betPopup.appendChild(inputRow);

    this.slider = tag('input', 'slider');
    this.slider.type = 'range';
    this.slider.min = '0';
    this.slider.max = '100';
    this.slider.value = '0';
    this.slider.addEventListener('input', () => {
      this.customTouched = true;
      this.amountInput.value = String(this.slider.value);
      this.syncFromInput();
    });
    this.betPopup.appendChild(this.slider);

    this.amountHint = node('amount-hint');
    this.betPopup.appendChild(this.amountHint);

    const submitRow = node('ctrl-row ctrl-submit');
    this.submitBtn = document.createElement('button');
    this.submitBtn.type = 'button';
    this.submitBtn.className = 'btn btn-primary btn-lg btn-grow';
    this.submitBtn.addEventListener('click', () => this.submitAmount());
    submitRow.appendChild(this.submitBtn);

    this.allInBtn = document.createElement('button');
    this.allInBtn.type = 'button';
    this.allInBtn.className = 'btn btn-allin btn-lg';
    this.allInBtn.textContent = '全下';
    this.allInBtn.addEventListener('click', () => this.onAction({ type: 'all_in' }));
    submitRow.appendChild(this.allInBtn);
    this.betPopup.appendChild(submitRow);
    this.root.appendChild(this.betPopup);

    this.amountLabel = tag('label', 'field-label', '');
    this.amountLabel.classList.add('hidden');

    /* 非我回合提示 + 倒计时 */
    this.waiting = node('ctrl-waiting', '等待其他玩家行动…');
    this.root.appendChild(this.waiting);
    this.countdownEl = node('ctrl-countdown-row');
    this.countdownEl.appendChild(tag('span', 'ctrl-cd-label', '你的行动倒计时'));
    this.countdown = tag('span', 'ctrl-countdown', '');
    this.countdownEl.appendChild(this.countdown);
    this.root.appendChild(this.countdownEl);

    this.disabledOverlay = node('ctrl-disabled');
    this.root.appendChild(this.disabledOverlay);

    this.countdownTimer = setInterval(() => this.renderCountdown(), 300);
  }

  openBetPanel() {
    const hand = this.store.state.room.snapshot?.hand;
    if (!hand) return;
    const seat = this.store.mySeat();
    const ctx = this.store.actionContext();
    if (!ctx.legal.includes('bet') && !ctx.legal.includes('raise')) return;
    this.resetAmount(hand, seat);
    this.betPopup.classList.add('open');
    this.amountInput.focus?.();
  }

  closeBetPanel() {
    this.betPopup.classList.remove('open');
  }

  renderCountdown() {
    const active = this.root.classList.contains('controls-active');
    const deadline = Number(this.store.state.room.actionRequest?.deadline ?? 0);
    const show = active && deadline > 0;
    this.countdownEl.classList.toggle('visible', show);
    if (!show) {
      if (this.countdown.textContent) this.countdown.textContent = '';
      this.countdown.classList.remove('urgent');
      return;
    }
    const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    const text = left > 0 ? `剩余 ${left}s` : '时间到';
    if (this.countdown.textContent !== text) {
      this.countdown.textContent = text;
      this.countdown.classList.toggle('urgent', left > 0 && left <= 8);
    }
  }

  /**
   * @param {string} label
   * @param {string} className
   * @param {{ type: string, amount?: number }} action
   */
  mkAction(label, className, action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${className}`;
    btn.textContent = label;
    btn.addEventListener('click', () => this.onAction(action));
    return btn;
  }

  /** @param {string} label @param {() => void} onClick */
  mkStep(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-step';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /** @param {number} direction */
  bump(direction) {
    const hand = this.store.state.room.snapshot?.hand;
    if (!hand) return;
    const step = Math.max(1, Math.round((hand.bigBlind ?? 20) / 2));
    const next = Number(this.amountInput.value || 0) + direction * step;
    this.customTouched = true;
    this.amountInput.value = String(Math.max(0, next));
    this.syncFromInput();
  }

  syncFromInput() {
    const hand = this.store.state.room.snapshot?.hand;
    if (!hand) return;
    const seat = this.store.mySeat();
    const value = Math.floor(Number(this.amountInput.value) || 0);
    this.slider.value = String(Math.min(value, this.slider.max));
    this.refreshAmountState(hand, seat, value);
  }

  refreshAmountState(hand, seat, value) {
    const max = maxBetTarget(hand, seat);
    const check = validateBetAmount(hand, seat, value);
    const isRaise = (hand.currentBet ?? 0) > 0;
    const verb = isRaise ? '加注到' : '下注';
    const target = check.clamped || value;
    const potText =
      value > 0 && Number(hand.pot ?? 0) > 0 ? ` · ${potPercent(target, hand.pot)}pot` : '';
    setText(this.submitBtn, `${verb} ${value > 0 ? chips(target) : '—'}${potText}`);
    setDisabled(this.submitBtn, !check.ok);

    const parts = [];
    if (value > 0) {
      parts.push(`占底池 ${potPercent(target, hand.pot ?? 0)}pot`);
      parts.push(`可用筹码 ${chips(max)}`);
    } else {
      parts.push(`可用筹码 ${chips(max)}`);
    }
    if (!check.ok && check.reason) parts.push(check.reason);
    setText(this.amountHint, parts.join(' · '));
    this.amountHint.classList.toggle('amount-error', !check.ok && value > 0);

    this.amountInput.max = String(max);
    this.slider.max = String(max);
    setDisabled(this.minusBtn, value <= 0);
    setDisabled(this.plusBtn, value >= max);
  }

  submitAmount() {
    const hand = this.store.state.room.snapshot?.hand;
    if (!hand) return;
    const seat = this.store.mySeat();
    const value = Math.floor(Number(this.amountInput.value) || 0);
    const check = validateBetAmount(hand, seat, value);
    if (!check.ok) return;
    this.onAction({ type: (hand.currentBet ?? 0) > 0 ? 'raise' : 'bet', amount: check.clamped });
    this.closeBetPanel();
  }

  resetAmount(hand, seat) {
    const minTarget =
      (hand.currentBet ?? 0) > 0
        ? (hand.currentBet ?? 0) + (hand.minRaise ?? hand.bigBlind ?? 0)
        : (hand.bigBlind ?? 20);
    const max = maxBetTarget(hand, seat);
    const initial = Math.min(Math.max(minTarget, 0), max);
    this.amountInput.value = String(initial);
    this.slider.max = String(max);
    this.slider.value = String(initial);
    this.customTouched = false;
    this.refreshAmountState(hand, seat, initial);
  }

  /** 快捷下注：直接提交；跟注/全下也走这里 */
  quickAction(hand, seat, q) {
    if (q.kind === 'call') {
      this.onAction({ type: 'call' });
      return;
    }
    if (q.kind === 'allin') {
      this.onAction({ type: 'all_in' });
      return;
    }
    const check = validateBetAmount(hand, seat, q.amount);
    if (!check.ok) return;
    this.onAction({ type: (hand.currentBet ?? 0) > 0 ? 'raise' : 'bet', amount: check.clamped });
  }

  /**
   * @param {any} state
   * @param {{ legal: string[], quicks: any[], isMyTurn: boolean, needToCall: number }} ctx
   */
  render(state, ctx) {
    const hand = state.room.snapshot?.hand;
    const seat = this.store.mySeat();
    const snap = state.room.snapshot;
    const me = snap?.seats?.find((s) => s.seat === seat);
    const seated = Boolean(me);

    const active = ctx.isMyTurn && Boolean(hand) && !hand.settled && seated;
    this.root.classList.toggle('controls-active', active);
    this.root.classList.toggle('controls-idle', !active);
    this.disabledOverlay.classList.toggle('visible', !active);
    this.waiting.classList.toggle('hidden', active || !seated);
    if (!active) this.closeBetPanel();

    if (!seated) {
      setText(this.waiting, '你正在旁观，入座后即可参与');
    } else if (!hand) {
      setText(this.waiting, '等待开局…');
    } else if (hand.settled) {
      setText(this.waiting, '本手已结束');
    } else if (!active) {
      const turnSeat = hand.currentTurnSeat;
      const turnName = hand.seats?.find((s) => s.seat === turnSeat)?.nickname;
      setText(this.waiting, turnName ? `等待 ${turnName} 行动…` : '等待其他玩家行动…');
    }

    const legal = new Set(ctx.legal ?? []);
    const callAmount = ctx.needToCall ?? 0;

    this.foldBtn.classList.toggle('hidden', !legal.has('fold'));
    const canCheck = legal.has('check');
    const canCall = legal.has('call');
    this.checkBtn.classList.toggle('hidden', !(canCheck || canCall));
    const callPotText =
      canCall && callAmount > 0 && Number(hand?.pot ?? 0) > 0
        ? ` · ${potPercent(callAmount, hand.pot)}pot`
        : '';
    setText(
      this.checkBtn,
      canCheck ? '过牌' : canCall ? `跟注 ${chips(callAmount)}${callPotText}` : '过牌',
    );

    const canBet = legal.has('bet') || legal.has('raise');
    this.betBtn.classList.toggle('hidden', !canBet);
    setText(this.betBtn, legal.has('raise') ? '加注' : '下注');
    this.rebuyBtn.classList.toggle('hidden', !seated);

    if (hand && active) {
      const key = `${hand.handId ?? ''}:${hand.street ?? ''}:${hand.currentBet ?? 0}:${hand.version ?? 0}`;
      if (this.handKey !== key) {
        this.handKey = key;
        if (!this.betPopup.classList.contains('open')) this.resetAmount(hand, seat);
      }
    }

    /* 快捷下注：最多 5 个（4 个池比例 + 全下；不足用最小加注补） */
    const quicks = ctx.quicks ?? [];
    const presets = quicks.filter((q) => q.kind === 'preset').slice(0, 5);
    const allin = quicks.find((q) => q.kind === 'allin');
    const minBet = quicks.find((q) => q.kind === 'min');
    const list = [...presets];
    if (list.length < 5 && minBet) list.push(minBet);
    if (allin) list.push(allin);
    const quick = list.slice(0, 6);

    const quickKey = quick.map((q) => `${q.key}:${q.amount}`).join('|');
    if (this.quickKey !== quickKey) {
      this.quickKey = quickKey;
      this.quickRow.replaceChildren();
      this.quickRow.classList.toggle('hidden', !quick.length);
      for (const q of quick) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `chip chip-action chip-${q.kind}`;
        btn.textContent = q.label;
        btn.addEventListener('click', () => this.quickAction(hand, seat, q));
        this.quickRow.appendChild(btn);
      }
    }

    setDisabled(this.foldBtn, !active);
    setDisabled(this.checkBtn, !active);
    setDisabled(this.betBtn, !active);
    setDisabled(this.rebuyBtn, !seated);
    setDisabled(this.allInBtn, !active);
    setDisabled(this.amountInput, !active || !canBet);
    setDisabled(this.slider, !active || !canBet);
    this.renderCountdown();
  }
}
