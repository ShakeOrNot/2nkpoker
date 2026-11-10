/**
 * 牌桌视图：公共牌、底池、6 个座位、我的手牌、操作栏。
 *
 * 布局策略：
 *   - 用 CSS 媒体查询按方向切换"竖屏纵向排列"和"横屏椭圆桌"
 *   - 用 JS 计算座位顺序（把自己转到最下方）和椭圆角度（传进 CSS 变量）
 */

import { View, button, labelled, node, setDisabled, setText, tag } from './base.js';
import { toast } from '../core/dom.js';
import { chips, cardText } from '../core/format.js';
import { BUY_IN_BB, MAX_BUY_IN_UNITS, RESULT_HOLD_MS } from '../core/constants.js';
import {
  bestCategory,
  settlement,
  chipDelta,
  positionOf,
  tablePositionOf,
  maxBetTarget,
  shareUrl,
  isValidRoomId,
} from '../core/logic.js';
import { cardEl, cardRow, dealtCardEl } from './cards.js';
import { ControlsView } from './controls.js';
import { streetText } from './waiting.js';
import { PayoutEffects, PAYOUT_REVEAL_MS } from './payout-effects.js';
import { TableMotion, BoardView, deckVisualState } from './table-motion.js';
import { BetEffects } from './bet-effects.js';
import { avatarEl, paintAvatar } from './avatar.js';
import { playerAvatar } from '../core/avatars.js';
import { PlayerPanel } from './player-panel.js';

export class TableView extends View {
  /**
   * @param {import('../store.js').Store} store
   */
  constructor(store) {
    super(store);
    this.root.classList.add('view-table');
    /** @type {Map<number, HTMLElement>} */
    this.seatNodes = new Map();
    this.logOpen = false;
    this.resultDismissedFor = '';
    this.resultShownFor = '';
    this.payoutEffects = new PayoutEffects(this.root);
    this.motion = new TableMotion();
    this.betEffects = new BetEffects(this.root);
    this.wagerNodes = new Map();
    this.playerPanel = new PlayerPanel(this.store);
    this.build();
  }

  dismissResult() {
    clearTimeout(this.resultTimer);
    clearTimeout(this.resultRevealTimer);
    this.resultRevealTimer = null;
    this.payoutEffects.clear();
    this.resultTimer = null;
    this.resultDismissedFor = this.resultShownFor;
    this.resultOverlay.classList.remove('visible');
    if (document.activeElement === this.resultCloseBtn) this.resultPreviousFocus?.focus?.();
    this.resultOverlay.replaceChildren();
  }

  unmount() {
    super.unmount();
    this.dismissResult();
    this.motion.disconnect();
    this.betEffects.disconnect();
  }

  mount(container) {
    super.mount(container);
    this.motion.connect();
    this.betEffects.connect(this.stageEl);
  }

  build() {
    /* 顶栏 */
    const header = node('app-header table-header');
    this.leaveBtn = button({
      label: '返回大厅',
      className: 'btn-ghost btn-sm',
      onClick: () => {
        // 主动离桌 = 自动离座 + 退出房间（手牌进行中则本手结束后自动离桌）
        void (async () => {
          const res = await this.store.leaveTable();
          if (!res.ok) toast(res.message || '离桌失败', 'error');
          else if (res.pending) toast('本手结束后自动离桌，可先在大厅等待', 'info');
        })();
      },
    });
    header.appendChild(this.leaveBtn);

    const info = node('table-info');
    this.roomIdEl = tag('div', 'table-room', '----');
    this.connEl = tag('div', 'table-conn', '');
    info.appendChild(this.roomIdEl);
    info.appendChild(this.connEl);
    header.appendChild(info);

    const headerActions = node('header-actions');
    this.inviteBtn = button({
      label: '邀请',
      className: 'btn-ghost btn-sm',
      onClick: () => this.copyInvite(),
    });
    this.logBtn = button({
      label: '日志',
      className: 'btn-ghost btn-sm',
      onClick: () => {
        this.logOpen = !this.logOpen;
        this.logPanel.classList.toggle('open', this.logOpen);
      },
    });
    headerActions.appendChild(this.inviteBtn);
    headerActions.appendChild(this.logBtn);
    this.exitBtn = button({
      label: '退出',
      className: 'btn-ghost btn-sm',
      onClick: () => this.doExit(),
    });
    headerActions.appendChild(this.exitBtn);
    header.appendChild(headerActions);
    this.root.appendChild(header);

    /* 主区域：舞台中央是一张纯 CSS 画的椭圆牌桌（木边 + 呢绒面），
       座位环绕在桌沿；竖屏时桌子缩小、座位改成桌下方的列表 */
    const main = node('table-main');

    const stage = node('table-stage');
    this.stageEl = stage;

    const oval = node('table-oval');
    const center = node('table-center');
    const potRow = node('pot-pill');
    this.potEl = node('pot-value', '0');
    potRow.appendChild(tag('span', 'pot-label', '底池'));
    potRow.appendChild(this.potEl);
    this.streetEl = tag('span', 'street-tag', '');
    potRow.appendChild(this.streetEl);
    const dealerRow = node('table-dealer-row');
    this.deckEl = node('table-deck');
    this.deckEl.setAttribute('role', 'img');
    this.deckEl.setAttribute('aria-label', '发牌牌堆');
    for (let i = 0; i < 8; i++) {
      const edge = node('deck-layer');
      edge.style.setProperty('--deck-level', String(i));
      this.deckEl.appendChild(edge);
    }
    this.deckTopEl = cardEl('', { hidden: true, size: 'sm' });
    this.deckTopEl.style.setProperty('--deck-level', '8');
    this.deckEl.appendChild(this.deckTopEl);
    dealerRow.appendChild(this.deckEl);
    dealerRow.appendChild(potRow);
    center.appendChild(dealerRow);

    this.boardWrap = node('board-wrap');
    this.boardView = new BoardView(this.motion);
    this.boardWrap.appendChild(this.boardView.root);
    center.appendChild(this.boardWrap);
    oval.appendChild(center);
    this.wagerSpots = node('wager-spots');
    oval.appendChild(this.wagerSpots);

    /* 座位层：横屏铺在椭圆上（--seat-x/y 定位），竖屏是桌下的列表 */
    this.seatsOval = node('seats seats-oval');
    oval.appendChild(this.seatsOval);
    stage.appendChild(oval);

    main.appendChild(stage);

    /* 日志面板 */
    this.logPanel = node('log-panel');
    this.logPanel.appendChild(tag('div', 'log-title', '牌局日志'));
    this.logList = node('log-list');
    this.logPanel.appendChild(this.logList);
    main.appendChild(this.logPanel);

    this.root.appendChild(main);

    /* 我的区域 */
    const mine = node('my-zone');
    const myCards = node('my-cards');
    this.myHoleEl = node('card-row');
    myCards.appendChild(this.myHoleEl);
    const myInfo = node('my-info');
    this.myNameEl = tag('div', 'my-name', '');
    this.myChipsEl = tag('div', 'my-chips', '');
    this.myHandEl = tag('div', 'my-hand', '');
    myInfo.appendChild(this.myNameEl);
    myInfo.appendChild(this.myChipsEl);
    myInfo.appendChild(this.myHandEl);
    this.rebuyBtn = button({
      label: '买入',
      className: 'btn-ghost btn-xs',
      onClick: () => this.openRebuy(),
    });
    myInfo.appendChild(this.rebuyBtn);
    myCards.appendChild(myInfo);
    mine.appendChild(myCards);
    this.myZoneEl = mine;
    this.root.appendChild(mine);

    /* 操作栏 */
    this.controls = new ControlsView(this.store, {
      onAction: (action) => void this.sendAction(action),
    });
    this.root.appendChild(this.controls.root);

    /* 旁观入座条 */
    this.spectateBar = node('spectate-bar');
    this.spectateBar.appendChild(tag('span', '', '你正在旁观这张牌桌'));
    this.sitNowBtn = button({
      label: '入座并等待下一手',
      className: 'btn-primary btn-sm',
      onClick: () => void this.sitNow(),
    });
    this.spectateBar.appendChild(this.sitNowBtn);
    this.root.appendChild(this.spectateBar);

    /* 结算浮层 */
    this.resultOverlay = node('result-overlay');
    this.root.appendChild(this.resultOverlay);

    /* 买入（补码）弹窗：手牌中提交 → 本手结算后生效 */
    this.rebuyOverlay = node('modal-overlay');
    const rebuyCard = node('modal-card');
    rebuyCard.appendChild(tag('h3', 'modal-title', '买入（补码）'));
    this.rebuyHint = tag('p', 'modal-hint', '');
    rebuyCard.appendChild(this.rebuyHint);
    this.rebuyInput = tag('input', 'input');
    this.rebuyInput.type = 'number';
    this.rebuyInput.min = '1';
    this.rebuyInput.max = String(MAX_BUY_IN_UNITS);
    this.rebuyInput.step = '1';
    this.rebuyInput.value = '1';
    rebuyCard.appendChild(labelled('买入个数（1 个 = 100BB）', this.rebuyInput));
    const rebuyActions = node('modal-actions');
    rebuyActions.appendChild(button({ label: '取消', className: 'btn-ghost', onClick: () => this.closeRebuy() }));
    this.rebuySubmit = button({ label: '确认买入', className: 'btn-primary', onClick: () => void this.submitRebuy() });
    rebuyActions.appendChild(this.rebuySubmit);
    rebuyCard.appendChild(rebuyActions);
    this.rebuyOverlay.appendChild(rebuyCard);
    this.rebuyOverlay.addEventListener('click', (ev) => {
      if (ev.target === this.rebuyOverlay) this.closeRebuy();
    });
    this.root.appendChild(this.rebuyOverlay);

    /* 跑马协商：牌没发完时，所有 all-in 玩家选同一个次数 */
    this.runoutPanel = node('runout-panel');
    this.runoutPanel.appendChild(tag('div', 'runout-title', '跑马次数'));
    this.runoutHint = tag('p', 'runout-hint', '');
    this.runoutPanel.appendChild(this.runoutHint);
    const runoutRow = node('runout-controls');
    this.runoutInput = tag('input', 'input runout-input');
    this.runoutInput.type = 'number';
    this.runoutInput.min = '1';
    this.runoutInput.step = '1';
    this.runoutInput.value = '1';
    runoutRow.appendChild(this.runoutInput);
    this.runoutSubmit = button({
      label: '提议',
      className: 'btn-primary btn-sm',
      onClick: () => void this.submitRunout(),
    });
    runoutRow.appendChild(this.runoutSubmit);
    this.runoutPanel.appendChild(runoutRow);
    this.runoutProposals = node('runout-proposals');
    this.runoutPanel.appendChild(this.runoutProposals);
    this.root.appendChild(this.runoutPanel);

    /* 多 board 逐个亮牌 */
    this.runoutBoardsView = node('runout-boards-view');
    this.root.appendChild(this.runoutBoardsView);
    this.runoutBoardsCount = 0;
  }

  /** 退出：离线模式顺手关掉离线开关，避免下次登录还是离线 */
  doExit() {
    if (this.store.state.offline) this.store.exitOffline();
    else this.store.logout();
  }

  async copyInvite() {
    const tableId = this.store.state.room.tableId;
    if (!isValidRoomId(tableId)) return;
    const { copyText } = await import('../core/dom.js');
    const ok = await copyText(shareUrl(window.location.href, tableId));
    toast(ok ? '邀请链接已复制' : '复制失败', ok ? 'success' : 'error');
  }

  async sitNow() {
    const snap = this.store.state.room.snapshot;
    const buyIn = Number(snap?.bigBlind ?? 20) * BUY_IN_BB;
    const res = await this.store.sit(null, buyIn);
    if (!res.ok) {
      toast(res.message || '入座失败（牌局进行中需要等本手结束）', 'error');
      return;
    }
    // 旁观条点进来的语义就是"下一手我要打"：坐下后直接准备，
    // 否则 ready=false 会一直等不到开局（输光后重新入座的 bug）。
    if (!res.queued) {
      const ready = await this.store.setReady(true);
      if (ready?.ok) toast('已入座，等待下一手开始', 'info');
    }
  }

  /**
   * @param {{ type: string, amount?: number }} action
   */
  async sendAction(action) {
    const res = await this.store.act(action);
    if (!res.ok) {
      if (res.code === 'STATE_OUTDATED') toast('牌局状态已更新，已用最新版本重试', 'info');
      else toast(res.message || '操作失败', 'error');
    }
  }

  /**
   * 座位显示顺序：把自己转到最下方
   * @param {number} maxSeats
   * @param {number|null} mySeat
   * @returns {number[]}
   */
  seatOrder(maxSeats, mySeat) {
    if (mySeat == null) return Array.from({ length: maxSeats }, (_, i) => i);
    const out = [];
    for (let i = 0; i < maxSeats; i++) out.push((mySeat + i) % maxSeats);
    return out;
  }

  /**
   * @param {number} index 从"我"开始的序号（0 = 我）
   * @param {number} maxSeats
   * @returns {{ x: number, y: number, angle: number }}
   */
  ovalPosition(index, maxSeats) {
    const total = Math.max(2, maxSeats);
    const angle = (index / total) * Math.PI * 2 + Math.PI / 2;
    const x = 50 + 44 * Math.cos(angle);
    const y = 50 + 38 * Math.sin(angle);
    return { x, y, angle };
  }

  /**
   * @param {any} state
   */
  render(state) {
    const snap = state.room.snapshot;
    const liveHand = snap?.hand ?? null;
    const last = state.room.lastResult;
    // 服务端结算后马上发 hand=null；短暂保留本手桌面供派彩演出，下一手永远优先。
    const hand = liveHand ?? (last?.result && Date.now() - last.at < RESULT_HOLD_MS
      ? { ...last, settled: true, street: 'SETTLED', pot: (last.result.pots ?? []).reduce((n, p) => n + p.amount, 0) }
      : null);
    const seats = snap?.seats ?? [];
    const maxSeats = snap?.maxSeats ?? 6;
    const mySeat = this.store.mySeat();
    const me = seats.find((s) => s.seat === mySeat);
    const myHandSeat = hand?.seats?.find((s) => s.seat === mySeat) ?? null;
    const ctx = this.store.actionContext();
    const handKey = `${state.room.tableId}:${hand?.handId ?? ''}`;
    if (this.handMotionKey !== handKey) this.motion.clear();
    this.handMotionKey = handKey;
    const deck = deckVisualState(hand);
    this.deckEl.style.setProperty('--deck-thickness', `${deck.thickness}px`);
    this.pendingDeal = [];
    this.allowDeal = Boolean(hand && !hand.settled && hand.street === 'PREFLOP');

    setText(this.roomIdEl, `房号 ${state.room.tableId || '----'}`);
    setText(this.connEl, state.connection === 'online' ? '已连接' : state.connection === 'connecting' ? '连接中…' : '已断开');
    setText(this.exitBtn, state.offline ? '退出离线' : '退出');

    /* 底池与阶段 */
    setText(this.potEl, hand ? chips(hand.pot ?? 0) : '0');
    setText(this.streetEl, hand ? streetText(hand.street) : '等待开局');

    /* 座位：始终环绕椭圆桌（竖屏也围在桌边，不再单独列在下方） */
    const order = this.seatOrder(maxSeats, mySeat);
    const portrait = this.isPortraitLayout(state.layout);
    this.stageEl.classList.toggle('is-portrait', portrait);
    const seatsWrap = this.seatsOval;
    const occupied = seats.filter((s) => s.userId).length;
    const delta = hand?.result ? chipDelta(hand) : new Map();

    const visibleOrder = order;

    // 按顺序写 DOM（保证 MVP 在最后 → 视觉上在最下方）
    const seatsKey = visibleOrder.join(',');
    const reorder = this.seatsKey !== seatsKey;
    const frag = reorder ? document.createDocumentFragment() : null;
    if (reorder) { this.motion.clear(); this.betEffects.reset(); }
    const betTargets = new Map();
    visibleOrder.forEach((seat, index) => {
      const el = this.seatNode(seat);
      const pos = this.ovalPosition(index, visibleOrder.length);
      el.style.setProperty('--seat-x', `${pos.x.toFixed(2)}%`);
      el.style.setProperty('--seat-y', `${pos.y.toFixed(2)}%`);
      el.style.setProperty('--seat-rot', `${(pos.angle * 180) / Math.PI + 90}deg`);
      el.style.setProperty('--seat-index', String(index));
      this.paintSeat(el, {
        avatar: playerAvatar(state, seats.find(s => s.seat === seat)),
        seat,
        seatInfo: seats.find((s) => s.seat === seat),
        handSeat: hand?.seats?.find((s) => s.seat === seat),
        isTurn: hand?.currentTurnSeat === seat && !hand?.settled,
        isMe: seat === mySeat,
        isButton: hand?.buttonSeat === seat || (!hand && snap?.buttonSeat === seat),
        isWinner: (delta.get(seat) ?? 0) > 0,
        position: hand ? positionOf(hand, seat) : tablePositionOf(snap, seat),
        delta: delta.get(seat) ?? 0,
        settled: Boolean(hand?.settled),
      });
      let wager = this.wagerNodes.get(seat);
      if (!wager) {
        wager = node('wager-marker');
        wager.setAttribute('role', 'group');
        this.wagerNodes.set(seat, wager);
        this.wagerSpots.appendChild(wager);
      }
      const amount = hand?.seats?.find(s => s.seat === seat)?.betThisStreet ?? 0;
      wager.style.left = `${50 + (pos.x - 50) * 0.75}%`;
      wager.style.top = `${50 + (pos.y - 50) * 0.75}%`;
      wager.classList.toggle('visible', amount > 0 && !hand?.settled);
      wager.setAttribute('aria-label', `${seats.find(s => s.seat === seat)?.nickname ?? '玩家'} 本街下注 ${amount}`);
      setText(wager, chips(amount));
      betTargets.set(seat, wager);
      if (frag) frag.appendChild(el);
    });
    if (frag) seatsWrap.replaceChildren(frag);
    this.seatsKey = seatsKey;
    for (const [seat, wager] of this.wagerNodes) {
      if (!visibleOrder.includes(seat)) wager.classList.remove('visible');
    }

    /* 底部：旁观条 / 我的牌 */
    const seated = Boolean(me);
    this.spectateBar.classList.toggle('visible', !seated);
    this.myZoneEl.classList.toggle('hidden', !seated);

    /* 我的手牌 */
    const holeCards = myHandSeat?.holeCards ?? (state.lastHoleCards ?? []);
    const holeKey = `${handKey}:${holeCards.join(',')}`;
    if (this.holeKey !== holeKey) {
      this.holeKey = holeKey;
      this.myHoleEl.replaceChildren();
      if (holeCards.length) {
        for (const c of holeCards) {
          const el = dealtCardEl(c, { size: 'lg' });
          this.myHoleEl.appendChild(el);
          if (this.allowDeal) this.pendingDeal.push(el);
        }
      }
    }

    const category = holeCards.length ? bestCategory(holeCards, hand?.board ?? []) : null;
    const myPos = positionOf(hand, mySeat) || tablePositionOf(snap, mySeat);
    setText(this.myNameEl, me ? `${me.nickname}${myPos ? ` · ${myPos}` : ''}` : '未入座');
    const pendingBuyIn = Number(me?.pendingBuyIn ?? 0);
    const pendingText = pendingBuyIn > 0 ? `（+${chips(pendingBuyIn)} 结算后补码）` : '';
    setText(
      this.myChipsEl,
      `${myHandSeat ? `筹码 ${chips(myHandSeat.chips)}` : me ? `筹码 ${chips(me.chips)}` : ''}${pendingText}`,
    );
    // 只有坐下的人才能买入
    this.rebuyBtn.classList.toggle('hidden', !seated);
    setText(
      this.myHandEl,
      category ? `牌型：${category.name}` : myHandSeat?.folded ? '已弃牌' : '',
    );

    /* 操作栏 */
    this.controls.render(state, ctx);

    /* 日志 */
    this.renderLog(state);

    // 布局更新完成后再测量牌堆和目标牌位，旋屏也能保持正确出牌路径。
    this.boardView.update(handKey, hand?.board ?? [], Boolean(hand?.settled), this.deckTopEl);
    this.pendingDeal.forEach((el, i) => el.classList.contains('board-card')
      ? this.motion.reveal(el, this.deckTopEl, i, 65)
      : this.motion.deal(el, this.deckTopEl, i));
    const turnKey = hand && !hand.settled ? `${handKey}:${hand.currentTurnSeat}` : '';
    if (turnKey !== this.turnMotionKey) {
      this.turnMotionKey = turnKey;
      const target = this.seatNodes.get(hand?.currentTurnSeat);
      this.motion.play(target, [
        { boxShadow: '0 0 0 0 rgba(246,196,83,.9)' },
        { boxShadow: '0 0 0 10px rgba(246,196,83,0)' },
      ], { duration: 650 });
    }

    if (state.connection === 'online') {
      this.betEffects.update(state.room.tableId, liveHand, this.seatNodes, betTargets, this.potEl);
    } else this.betEffects.reset();

    /* 结算浮层 */
    this.renderResult(state, hand);
    this.renderRunout(state);
    this.renderRunoutBoards(state);
  }

  /**
   * @param {string} layout
   * @returns {boolean}
   */
  isPortraitLayout(layout) {
    if (layout === 'portrait') return true;
    if (layout === 'landscape') return false;
    return window.matchMedia('(orientation: portrait)').matches;
  }

  /**
   * @param {number} seat
   * @returns {HTMLElement}
   */
  seatNode(seat) {
    let el = this.seatNodes.get(seat);
    if (el) return el;
    el = node('seat');
    el.appendChild(node('seat-top'));
    el.appendChild(avatarEl('lion', 'seat-avatar'));
    el.appendChild(node('seat-turn-marker', '行动中'));
    el.appendChild(node('seat-name'));
    el.appendChild(node('seat-chips'));
    el.appendChild(node('seat-bet'));
    el.appendChild(node('seat-cards'));
    el.appendChild(node('seat-tags'));
    el.appendChild(node('seat-delta'));
    el.addEventListener('click', () => {
      const snap = this.store.state.room.snapshot;
      const info = snap?.seats?.find((s) => s.seat === seat);
      // 点已入座的玩家：打开玩家面板（自己也可以看）
      if (info?.userId) {
        this.playerPanel.open(info.userId, info.nickname);
        return;
      }
      const hand = snap?.hand;
      const running = Boolean(hand && !hand.settled);
      const mySeat = this.store.mySeat();
      // 已入座的人：牌局进行中不能换座；旁观者点空位 = 排队/入座
      if (running && mySeat != null) return;
      void this.sitAt(seat);
    });
    this.seatNodes.set(seat, el);
    return el;
  }

  /**
   * @param {number} seat
   */
  async sitAt(seat) {
    const snap = this.store.state.room.snapshot;
    const buyIn = Number(snap?.bigBlind ?? 20) * BUY_IN_BB;
    const moving = this.store.mySeat() != null;
    const res = await this.store.sit(seat, buyIn);
    if (!res.ok) toast(res.message || (moving ? '换座失败' : '该座位入座失败'), 'error');
    else if (res.moved) toast(`已换到座位 ${Number(res.seat) + 1}`, 'success');
  }

  /**
   * @param {HTMLElement} el
   * @param {any} info
   */
  paintSeat(el, info) {
    const { seatInfo, handSeat, isTurn, isMe, isButton, isWinner, position, delta, settled } = info;
    const taken = Boolean(seatInfo?.userId);
    const avatar = el.querySelector('.seat-avatar');
    paintAvatar(avatar, info.avatar);
    avatar.classList.toggle('hidden', !taken);

    el.classList.toggle('seat-empty', !taken);
    el.classList.toggle('seat-me', Boolean(isMe));
    el.classList.toggle('seat-turn', Boolean(isTurn));
    el.querySelector('.seat-turn-marker').classList.toggle('visible', Boolean(isTurn));
    el.classList.toggle('seat-folded', Boolean(handSeat?.folded));
    el.classList.toggle('seat-allin', Boolean(handSeat?.allIn));
    el.classList.toggle('seat-winner', Boolean(isWinner && settled));
    el.classList.toggle('seat-offline', Boolean(taken && !seatInfo.connected));

    const top = el.querySelector('.seat-top');
    setText(top, `${position || (isButton ? 'BTN' : '')}`.trim() || ' ');

    setText(el.querySelector('.seat-name'), taken ? seatInfo.nickname || '玩家' : '空位');

    const chipValue = handSeat ? handSeat.chips : seatInfo?.chips ?? 0;
    setText(el.querySelector('.seat-chips'), taken ? chips(chipValue) : '');

    const bet = handSeat?.betThisStreet ?? 0;
    const betEl = el.querySelector('.seat-bet');
    betEl.textContent = bet > 0 ? `下注 ${chips(bet)}` : '';
    betEl.classList.toggle('visible', bet > 0);

    const cardsEl = el.querySelector('.seat-cards');
    const cards = handSeat?.holeCards ?? [];
    const wasFolded = Boolean(handSeat?.folded);
    // 未亮牌但已入局 → 显示牌背
    const showBacks = Boolean(handSeat) && !wasFolded && cards.length === 0 && !settled;
    const cardsKey = `${this.handMotionKey}|${cards.join(',')}|${showBacks ? 'b' : ''}|${wasFolded ? 'f' : ''}`;
    if (cardsEl.datasetKey !== cardsKey) {
      cardsEl.datasetKey = cardsKey;
      cardsEl.replaceChildren();
      if (cards.length) {
        for (const c of cards) cardsEl.appendChild(dealtCardEl(c, { size: 'sm', highlight: Boolean(isWinner && settled) }));
      } else if (showBacks) {
        cardsEl.appendChild(cardEl('', { hidden: true, size: 'sm' }));
        cardsEl.appendChild(cardEl('', { hidden: true, size: 'sm' }));
      }
      if (this.allowDeal) this.pendingDeal.push(...cardsEl.children);
    }
    for (const el of cardsEl.children) el.classList.toggle('card-hi', Boolean(isWinner && settled));

    const tags = el.querySelector('.seat-tags');
    tags.replaceChildren();
    if (isButton) tags.appendChild(tag('span', 'tag tag-btn', 'D'));
    if (handSeat?.allIn) tags.appendChild(tag('span', 'tag tag-allin', 'ALL IN'));
    if (!taken) tags.appendChild(tag('span', 'tag tag-sit', '点按入座'));

    const deltaEl = el.querySelector('.seat-delta');
    if (settled && delta) {
      deltaEl.textContent = `${delta > 0 ? '+' : '−'}${chips(Math.abs(delta))}`;
      deltaEl.className = `seat-delta visible ${delta > 0 ? 'delta-up' : 'delta-down'}`;
    } else {
      deltaEl.className = 'seat-delta';
      deltaEl.textContent = '';
    }
    void seatInfo;
  }

  /**
   * @param {any} state
   */
  renderLog(state) {
    const log = state.room.log ?? [];
    if (this.logCount === log.length) return;
    this.logCount = log.length;
    this.logList.replaceChildren();
    for (const line of log.slice(-60)) {
      const item = node(`log-line log-${line.kind ?? 'info'}`);
      item.appendChild(tag('span', 'log-time', new Date(line.at).toLocaleTimeString('zh-CN', { hour12: false })));
      item.appendChild(tag('span', 'log-text', line.text));
      this.logList.appendChild(item);
    }
    this.logList.scrollTop = this.logList.scrollHeight;
  }

  /**
   * @param {any} state
   * @param {any} hand
   */
  /* ---------------- 买入（补码） ---------------- */

  openRebuy() {
    const snap = this.store.state.room.snapshot;
    const mySeat = this.store.mySeat();
    if (mySeat == null) {
      toast('先坐下才能买入', 'info');
      return;
    }
    const bb = Number(snap?.bigBlind ?? 20);
    const unit = bb * BUY_IN_BB;
    const me = snap?.seats?.find((s) => s.seat === mySeat);
    const pending = Number(me?.pendingBuyIn ?? 0);
    const pendingText = pending > 0 ? `；已有 ${pending} 筹码等待本手结算后补码` : '';
    setText(
      this.rebuyHint,
      `1 个买入 = ${unit} 筹码（100BB）；当前筹码 ${me?.chips ?? 0}；最多 ${MAX_BUY_IN_UNITS} 个买入${pendingText}。手牌进行中会延到本手结算后补码。`,
    );
    this.rebuyInput.value = '1';
    this.rebuyOverlay.classList.add('visible');
    this.rebuyInput.focus?.();
  }

  closeRebuy() {
    this.rebuyOverlay.classList.remove('visible');
  }

  async submitRebuy() {
    const units = Math.max(1, Math.floor(Number(this.rebuyInput.value) || 1));
    if (units > MAX_BUY_IN_UNITS) {
      toast(`最多 ${MAX_BUY_IN_UNITS} 个买入`, 'error');
      return;
    }
    setDisabled(this.rebuySubmit, true);
    const res = await this.store.rebuy(units);
    setDisabled(this.rebuySubmit, false);
    if (res.ok) this.closeRebuy();
  }

  /** @param {any} state */
  renderRunout(state) {
    const runout = state.room.runout;
    const mySeat = this.store.mySeat();
    const show = Boolean(runout) && mySeat != null && Array.isArray(runout.seats) && runout.seats.includes(mySeat);
    this.runoutPanel.classList.toggle('visible', show);
    if (!show) return;

    const seconds = Math.max(0, Math.ceil(((runout.deadline ?? 0) - Date.now()) / 1000));
    setText(
      this.runoutHint,
      `牌还没发完，最多可跑 ${runout.maxRuns} 次；所有 all-in 玩家选同一个数才开始（剩 ${seconds} 秒）`,
    );
    this.runoutInput.max = String(runout.maxRuns);
    if (Number(this.runoutInput.value) > runout.maxRuns) {
      this.runoutInput.value = String(runout.maxRuns);
    }

    const seats = state.room.snapshot?.seats ?? [];
    this.runoutProposals.replaceChildren();
    for (const p of runout.proposals ?? []) {
      const seat = seats.find((s) => s.seat === p.seat);
      this.runoutProposals.appendChild(
        tag('div', 'runout-proposal', `${seat?.nickname ?? `座位 ${p.seat}`}：跑 ${p.runs} 次`),
      );
    }
  }

  async submitRunout() {
    const runs = Math.floor(Number(this.runoutInput.value) || 1);
    setDisabled(this.runoutSubmit, true);
    const res = await this.store.proposeRunout(runs);
    setDisabled(this.runoutSubmit, false);
    if (!res.ok) toast(res.message || '提议失败', 'error');
  }

  /** @param {any} state */
  renderRunoutBoards(state) {
    const info = state.room.runoutBoards;
    const boards = info?.boards ?? [];
    this.runoutBoardsView.classList.toggle('visible', boards.length > 0);
    if (!boards.length) {
      this.runoutBoardsView.replaceChildren();
      this.runoutBoardsCount = 0;
      return;
    }
    if (this.runoutBoardsCount === boards.length) return;

    this.runoutBoardsView.replaceChildren();
    this.runoutBoardsView.appendChild(
      tag('div', 'runout-boards-title', `跑马 ${info.runs} 次`),
    );
    boards.forEach((board, index) => {
      const row = node('runout-board-line');
      row.appendChild(tag('span', 'runout-board-no', `${index + 1}`));
      for (const c of board) row.appendChild(cardEl(c, { size: 'sm' }));
      this.runoutBoardsView.appendChild(row);
      if (index === boards.length - 1) {
        this.motion.play(
          row,
          [
            { opacity: 0, transform: 'translateY(8px)' },
            { opacity: 1, transform: 'translateY(0)' },
          ],
          { duration: 320 },
        );
      }
    });
    this.runoutBoardsCount = boards.length;
  }

  renderResult(state, hand) {
    const last = state.room.lastResult;
    const hasResult = Boolean(last?.result) || Boolean(hand?.settled && hand?.result);
    if (!hasResult) {
      this.dismissResult();
      return;
    }
    const currentResult = hand?.settled && hand.result ? hand : last;
    const handId = currentResult?.handId ?? '';
    const resultKey = `${state.room.tableId}:${handId}`;
    // 下一手一到就让出操作区；重绘与重复事件不重建浮层、不延长计时。
    if (hand && !hand.settled && hand.handId !== handId) {
      this.dismissResult();
      this.resultDismissedFor = resultKey;
      return;
    }
    const age = last?.handId === handId && last.at ? Math.max(0, Date.now() - last.at) : 0;
    if (age >= RESULT_HOLD_MS) {
      this.dismissResult();
      this.resultDismissedFor = resultKey;
      return;
    }
    // 同一手牌只展示一次；想调试可临时打开 views.table._dbg
    if (this.resultDismissedFor === resultKey || this.resultShownFor === resultKey) {
      if (this._dbg) console.log('[table] 结算浮层已收起过，跳过', handId);
      return;
    }

    const lastSeatRows = Array.isArray(last?.seats) && last.seats.length ? last.seats : null;
    const pseudoHand = hand?.result
      ? hand
      : {
          ...(this.store.state.room.snapshot?.hand ?? {}),
          seats: lastSeatRows ?? this.store.state.room.snapshot?.hand?.seats ?? [],
          result: last?.result ?? null,
          board: last?.board ?? [],
        };
    let summary = settlement(pseudoHand);

    // 兜底：某些后端（协议适配模式）的结算里可能没有 hand.seats，
    // settlement() 就会返回空行。用最后一次快照的座位补上，别让浮层悄悄消失。
    if (!summary.rows.length) {
      const seats = pseudoHand?.seats ?? [];
      const payouts = pseudoHand?.result?.payouts ?? {};
      const rows = seats.map((s) => {
        const won = Number(payouts[s.seat] ?? 0);
        const committed = s.totalCommitted ?? 0;
        return {
          seat: s.seat,
          userId: s.userId,
          nickname: s.nickname || `座位 ${s.seat}`,
          won,
          committed,
          net: won - committed,
          folded: Boolean(s.folded),
          allIn: Boolean(s.allIn),
          isWinner: won > 0,
          refundOnly: won > 0 && won <= committed,
          holeCards: pseudoHand?.result?.revealed?.[s.seat] ?? [],
        };
      });
      rows.sort((a, b) => b.won - a.won || b.net - a.net);
      const pots = pseudoHand?.result?.pots ?? [];
      summary = {
        rows,
        totalPaid: pots.reduce((sum, p) => sum + (p.amount ?? 0), 0),
        winnerSeats: rows.filter((r) => r.won > 0 && !r.refundOnly).map((r) => r.seat),
        deadMoney: 0,
      };
    }

    if (!summary.rows.length) {
      // 兜底也拼不出行时不显示浮层（正常流程不会走到这里）
      this.resultOverlay.classList.remove('visible');
      return;
    }
    if (this._dbg) console.log('[table] 显示结算浮层，行数 =', summary.rows.length);

    const mine = summary.rows.find((r) => state.session?.userId
      ? r.userId === state.session.userId
      : r.seat === this.store.mySeat());
    const mySeat = mine?.seat;
    const headline = mine
      ? mine.net > 0
        ? `你赢了 ${chips(mine.net)}`
        : mine.net < 0
          ? `你输了 ${chips(Math.abs(mine.net))}`
          : '本手打平'
      : '本手结算';

    this.dismissResult();
    this.resultShownFor = resultKey;
    const outcome = !mine ? 'spectator' : mine.net > 0 ? 'win' : mine.net < 0 ? 'lose' : 'tie';
    const card = node(`result-card result-${outcome}`);
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', headline);
    const emblem = node('result-emblem', outcome === 'win' ? '♛' : outcome === 'lose' ? '♠' : '◇');
    if (outcome === 'tie') {
      emblem.textContent = '';
      emblem.appendChild(tag('span', 'result-duel-card', '♠'));
      emblem.appendChild(tag('span', 'result-duel-card', '♦'));
    }
    emblem.setAttribute('aria-hidden', 'true');
    card.appendChild(emblem);
    card.appendChild(tag('div', 'result-eyebrow', outcome === 'win' ? 'WINNER · 赢家时刻' : outcome === 'lose' ? '本手惜败' : outcome === 'tie' ? 'WELL PLAYED · 好局相逢' : '本手结算'));

    const boards = pseudoHand?.result?.boards;
    if (Array.isArray(boards) && boards.length > 1) {
      card.appendChild(tag('div', 'result-runs', `跑马 ${boards.length} 次`));
      const wrap = node('result-boards');
      boards.forEach((board, index) => {
        const row = node('result-board-row');
        row.appendChild(tag('span', 'result-board-no', `${index + 1}`));
        for (const c of board) row.appendChild(cardEl(c, { size: 'sm' }));
        wrap.appendChild(row);
      });
      card.appendChild(wrap);
    }
    if (outcome === 'tie' || outcome === 'lose') {
      if (outcome === 'tie') {
        card.appendChild(tag('div', 'result-morale-title', '棋逢对手'));
        card.appendChild(tag('div', 'result-morale-copy', '这一手不分高下，精彩留在牌桌上。'));
      }
      const glints = node('result-morale-glints');
      glints.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 8; i++) {
        const glint = tag('span', '', '✧');
        glint.style.setProperty('--glint-index', String(i));
        glints.appendChild(glint);
      }
      card.appendChild(glints);
    }
    if (outcome === 'win') {
      const sparks = node('result-sparks');
      sparks.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 24; i++) {
        const angle = (i / 24) * Math.PI * 2;
        const radius = 110 + (i % 4) * 32;
        const spark = tag('span', i % 3 === 0 ? 'result-spark result-flying-chip' : 'result-spark', i % 3 === 0 ? '♠' : '✦');
        spark.style.setProperty('--spark-dx', `${Math.cos(angle) * radius}px`);
        spark.style.setProperty('--spark-dy', `${Math.sin(angle) * radius}px`);
        spark.style.setProperty('--spark-rotation', `${i * 43}deg`);
        spark.style.setProperty('--spark-delay', `${160 + (i % 6) * 75}ms`);
        sparks.appendChild(spark);
      }
      card.appendChild(sparks);
    }
    const title = tag('h2', `result-headline ${mine && mine.net > 0 ? 'win' : mine && mine.net < 0 ? 'lose' : ''}`, headline);
    if (outcome === 'win') {
      title.textContent = '';
      title.setAttribute('aria-label', headline);
      const winLabel = tag('span', 'result-win-label', '你赢了！');
      const winAmount = tag('span', 'result-win-amount', `+${chips(mine.net)}`);
      winAmount.setAttribute('aria-hidden', 'true');
      title.appendChild(winLabel);
      title.appendChild(winAmount);
      title.appendChild(tag('span', 'result-win-caption', '本手净赢筹码'));
    }
    card.appendChild(title);
    if (outcome === 'lose') card.appendChild(tag('div', 'result-morale-copy', '稳住，下一手见。'));

    const pots = pseudoHand?.result?.pots ?? [];
    if (pots.length) {
      card.appendChild(tag('div', 'result-pots', pots.map((p, i) => `${pots.length > 1 ? `池${i + 1} ` : '底池 '}${chips(p.amount)}`).join('　')));
    }

    const board = pseudoHand?.board ?? [];
    if (board.length) {
      const row = node('result-board');
      row.appendChild(tag('span', 'result-board-label', '公共牌'));
      row.appendChild(cardRow(board, { size: 'md' }));
      card.appendChild(row);
    }

    const list = node('result-list');
    for (const row of summary.rows) {
      const line = node(`result-line ${row.seat === mySeat ? 'me' : ''} ${row.net > 0 ? 'win' : row.net < 0 ? 'lose' : ''}`);
      line.appendChild(tag('span', 'result-name', `${row.nickname}${row.seat === mySeat ? '（你）' : ''}`));

      const cards = node('result-cards');
      if (row.holeCards?.length) {
        cards.appendChild(cardRow(row.holeCards, { size: 'sm' }));
      } else if (row.folded) {
        cards.appendChild(tag('span', 'result-folded', '已弃牌'));
      } else {
        cards.appendChild(tag('span', 'result-folded', '未亮牌'));
      }
      line.appendChild(cards);

      const amount = node('result-amount');
      if (row.net > 0) amount.textContent = `+${chips(row.net)}`;
      else if (row.net < 0) amount.textContent = `−${chips(Math.abs(row.net))}`;
      else amount.textContent = '±0';
      line.appendChild(amount);
      list.appendChild(line);
    }
    card.appendChild(list);

    this.resultCloseBtn = button({ label: outcome === 'tie' ? '好局继续 · 回到牌桌' : outcome === 'lose' ? '回到牌桌' : '继续牌局', className: 'btn-ghost btn-block result-close', onClick: () => this.dismissResult() });
    card.appendChild(this.resultCloseBtn);
    card.appendChild(tag('div', 'result-note', '自动收起 · 下一手开始立即继续'));

    if (summary.deadMoney > 0) {
      card.appendChild(tag('div', 'result-note', `有 ${chips(summary.deadMoney)} 无人认领（孤池），按规则留在桌上`));
    }

    this.resultOverlay.replaceChildren(card);
    const reveal = () => {
      this.resultRevealTimer = null;
      this.payoutEffects.clear();
      this.resultOverlay.classList.add('visible');
      this.resultPreviousFocus = document.activeElement;
      this.resultCloseBtn.focus?.({ preventScroll: true });
    };
    // 先派彩、再出现结算卡；不推迟服务端状态，也不延长总展示时间。
    if (age < 500 && this.payoutEffects.play(pseudoHand, this.potEl, this.seatNodes, this.stageEl)) {
      this.resultRevealTimer = setTimeout(reveal, PAYOUT_REVEAL_MS);
    } else reveal();

    // 自动收起
    this.resultTimer = setTimeout(() => this.dismissResult(), RESULT_HOLD_MS - age);
    this.resultOverlay.onkeydown = (ev) => {
      if (ev.key === 'Escape') this.dismissResult();
      if (ev.key === 'Tab') { ev.preventDefault(); this.resultCloseBtn.focus?.(); }
    };

    // 点一下也可以立即收起
    this.resultOverlay.onclick = (ev) => {
      if (ev.target === this.resultOverlay) this.dismissResult();
    };
  }
}
