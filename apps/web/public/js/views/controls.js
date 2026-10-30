/**
 * 操作栏：弃牌 / 过牌 / 跟注 / 下注（自定义金额 + 快捷比例）/ 全下。
 *
 * 关键约束：下注金额是"本街下注到的总额"，且不能超过"自己本街已下注 + 剩余筹码"，
 * 也就是永远不会超过自己当前的筹码量（界面上还会额外给出提示与截断）。
 */

import { node, setDisabled, setText, tag } from './base.js';
import { chips, potPercent } from '../core/format.js';
import { validateBetAmount, maxBetTarget } from '../core/logic.js';

export class ControlsView {
  /**
   * @param {import('../store.js').Store} store
   * @param {{ onAction: (action: any) => void }} options
   */
  constructor(store, options) {
    this.store = store;
    this.onAction = options.onAction;
    this.handKey = '';
    this.customTouched = false;
    this.root = node('controls');
    this.build();
  }

  build() {
    /* 第一行：弃牌 / 过牌 / 跟注 */
    const primary = node('ctrl-row ctrl-primary');
    this.foldBtn = this.mkAction('弃牌', 'btn-fold', { type: 'fold' });
    this.checkBtn = this.mkAction('过牌', 'btn-check', { type: 'check' });
    this.callBtn = this.mkAction('跟注', 'btn-call', { type: 'call' });
    primary.appendChild(this.foldBtn);
    primary.appendChild(this.checkBtn);
    primary.appendChild(this.callBtn);
    this.root.appendChild(primary);

    /* 第二行：下注/加注金额 */
    const amountRow = node('ctrl-amount');
    this.amountLabel = tag('label', 'field-label', '下注金额（本街下注到）');
    amountRow.appendChild(this.amountLabel);

    const inputRow = node('row row-tight');
    this.amountInput = tag('input', 'input input-number');
    this.amountInput.type = 'number';
    this.amountInput.inputMode = 'numeric';
    this.amountInput.step = '1';
    this.amountInput.min = '0';
    this.amountInput.addEventListener('input', () => {
      this.customTouched = true;
      this.syncFromInput();
    });
    inputRow.appendChild(this.amountInput);

    this.minusBtn = this.mkStep('−', () => this.bump(-1));
    this.plusBtn = this.mkStep('+', () => this.bump(1));
    inputRow.appendChild(this.minusBtn);
    inputRow.appendChild(this.plusBtn);
    amountRow.appendChild(inputRow);

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
    amountRow.appendChild(this.slider);

    this.amountHint = node('amount-hint');
    amountRow.appendChild(this.amountHint);
    this.root.appendChild(amountRow);

    /* 第三行：快捷金额 */
    this.quickRow = node('ctrl-quicks');
    this.root.appendChild(this.quickRow);

    /* 第四行：执行下注/加注 + 全下 */
    const submitRow = node('ctrl-row ctrl-submit');
    this.submitBtn = node('btn btn-primary btn-lg btn-grow');
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
    this.root.appendChild(submitRow);

    /* 非我回合时的提示 + 我的行动倒计时（两个独立元素，避免 setText 互相清空） */
    this.waiting = node('ctrl-waiting', '等待其他玩家行动…');
    this.root.appendChild(this.waiting);

    this.countdownEl = node('ctrl-countdown-row');
    this.countdownEl.appendChild(tag('span', 'ctrl-cd-label', '你的行动倒计时'));
    this.countdown = tag('span', 'ctrl-countdown', '');
    this.countdownEl.appendChild(this.countdown);
    this.root.appendChild(this.countdownEl);

    this.disabledOverlay = node('ctrl-disabled');
    this.root.appendChild(this.disabledOverlay);

    /* 倒计时刷新：只在轮到我且有时限时跑 */
    this.countdownTimer = setInterval(() => this.renderCountdown(), 300);
  }

  /**
   * 行动倒计时：轮到我且服务端给了 deadline 时显示剩余秒数（<8s 变红）
   */
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
   * @returns {HTMLButtonElement}
   */
  mkAction(label, className, action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${className}`;
    btn.textContent = label;
    btn.addEventListener('click', () => this.onAction(action));
    return btn;
  }

  /**
   * @param {string} label
   * @param {() => void} onClick
   * @returns {HTMLButtonElement}
   */
  mkStep(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-step';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /**
   * 滑块/加减号：按底池或大盲的粒度调整
   * @param {number} direction
   */
  bump(direction) {
    const hand = this.store.state.room.snapshot?.hand;
    if (!hand) return;
    const step = Math.max(1, Math.round((hand.bigBlind ?? 20) / 2));
    const next = Number(this.amountInput.value || 0) + direction * step;
    this.customTouched = true;
    this.amountInput.value = String(Math.max(0, next));
    this.syncFromInput();
  }

  /** 输入变化 → 更新滑块与按钮 */
  syncFromInput() {
    const hand = this.store.state.room.snapshot?.hand;
    if (!hand) return;
    const seat = this.store.mySeat();
    const value = Math.floor(Number(this.amountInput.value) || 0);
    this.slider.value = String(Math.min(value, this.slider.max));
    this.refreshAmountState(hand, seat, value);
  }

  /**
   * @param {any} hand
   * @param {number|null} seat
   * @param {number} value
   */
  refreshAmountState(hand, seat, value) {
    const max = maxBetTarget(hand, seat);
    const check = validateBetAmount(hand, seat, value);
    const isRaise = (hand.currentBet ?? 0) > 0;
    const verb = isRaise ? '加注到' : '下注';

    const target = check.clamped || value;
    const potText = value > 0 && Number(hand.pot ?? 0) > 0 ? ` · ${potPercent(target, hand.pot)}pot` : '';
    setText(this.submitBtn, `${verb} ${value > 0 ? chips(target) : '—'}${potText}`);
    setDisabled(this.submitBtn, !check.ok);
    const parts = [];
    if (value > 0) {
      parts.push(`占底池 ${potPercent(value, hand.pot ?? 0)}`);
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
  }

  /**
   * 每次轮到我都重置一次金额（不需要重新创建 DOM）
   * @param {any} hand
   * @param {number|null} seat
   */
  resetAmount(hand, seat) {
    const minTarget = (hand.currentBet ?? 0) > 0
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
    this.checkBtn.classList.toggle('hidden', !legal.has('check'));
    this.callBtn.classList.toggle('hidden', !legal.has('call'));
    const callPotText =
      callAmount > 0 && Number(hand?.pot ?? 0) > 0 ? ` · ${potPercent(callAmount, hand.pot)}pot` : '';
    setText(this.callBtn, callAmount > 0 ? `跟注 ${chips(callAmount)}${callPotText}` : '跟注');

    const canBet = legal.has('bet') || legal.has('raise');
    this.amountLabel.parentElement?.classList.toggle('hidden', !canBet);
    this.submitBtn.classList.toggle('hidden', !canBet);
    this.allInBtn.classList.toggle('hidden', !legal.has('all_in'));

    // 手牌换了 / 刚轮到我 → 重置金额
    const key = `${hand?.handId ?? ''}:${hand?.street ?? ''}:${hand?.currentBet ?? 0}:${hand?.version ?? 0}`;
    if (hand && active && (this.handKey !== key || !this.customTouched)) {
      this.handKey = key;
      this.resetAmount(hand, seat);
    } else if (hand) {
      this.refreshAmountState(hand, seat, Math.floor(Number(this.amountInput.value) || 0));
    }

    // 快捷按钮
    const quicks = ctx.quicks ?? [];
    const quickKey = quicks.map((q) => `${q.key}:${q.amount}`).join('|');
    if (this.quickKey !== quickKey) {
      this.quickKey = quickKey;
      this.quickRow.replaceChildren();
      if (!quicks.length) {
        this.quickRow.classList.add('hidden');
      } else {
        this.quickRow.classList.remove('hidden');
        for (const q of quicks) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `chip chip-action chip-${q.kind}`;
          btn.textContent = q.label;
          btn.addEventListener('click', () => {
            if (q.kind === 'call') {
              this.onAction({ type: 'call' });
              return;
            }
            this.customTouched = true;
            this.amountInput.value = String(q.amount);
            this.slider.value = String(Math.min(q.amount, Number(this.slider.max)));
            this.refreshAmountState(hand, seat, q.amount);
          });
          this.quickRow.appendChild(btn);
        }
      }
    }

    setDisabled(this.foldBtn, !active);
    setDisabled(this.checkBtn, !active);
    setDisabled(this.callBtn, !active);
    setDisabled(this.allInBtn, !active);
    setDisabled(this.amountInput, !active || !canBet);
    setDisabled(this.slider, !active || !canBet);
  }
}
