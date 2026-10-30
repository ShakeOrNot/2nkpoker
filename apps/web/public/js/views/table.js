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
import { boardEl, cardEl, cardRow } from './cards.js';
import { ControlsView } from './controls.js';
import { streetText } from './waiting.js';

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
    this.build();
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
    center.appendChild(potRow);

    this.boardWrap = node('board-wrap');
    center.appendChild(this.boardWrap);
    oval.appendChild(center);

    /* 座位层：横屏铺在椭圆上（--seat-x/y 定位），竖屏是桌下的列表 */
    this.seatsOval = node('seats seats-oval');
    oval.appendChild(this.seatsOval);
    stage.appendChild(oval);

    this.seatsList = node('seats seats-portrait');
    stage.appendChild(this.seatsList);

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
    this.root.appendChild(this.rebuyOverlay);  }

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
    if (!res.ok) toast(res.message || '入座失败（牌局进行中需要等本手结束）', 'error');
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
    const hand = snap?.hand ?? null;
    const seats = snap?.seats ?? [];
    const maxSeats = snap?.maxSeats ?? 6;
    const mySeat = this.store.mySeat();
    const me = seats.find((s) => s.seat === mySeat);
    const myHandSeat = hand?.seats?.find((s) => s.seat === mySeat) ?? null;
    const ctx = this.store.actionContext();

    setText(this.roomIdEl, `房号 ${state.room.tableId || '----'}`);
    setText(this.connEl, state.connection === 'online' ? '已连接' : state.connection === 'connecting' ? '连接中…' : '已断开');
    setText(this.exitBtn, state.offline ? '退出离线' : '退出');

    /* 底池与阶段 */
    setText(this.potEl, hand ? chips(hand.pot ?? 0) : '0');
    setText(this.streetEl, hand ? streetText(hand.street) : '等待开局');

    /* 公共牌 */
    const boardKey = (hand?.board ?? []).join(',');
    if (this.boardKey !== boardKey) {
      this.boardKey = boardKey;
      this.boardWrap.replaceChildren(boardEl(hand?.board ?? [], { size: 'lg' }));
    }

    /* 座位：横屏环绕椭圆，竖屏桌下列表（两套容器，只渲染可见那套） */
    const order = this.seatOrder(maxSeats, mySeat);
    const portrait = this.isPortraitLayout(state.layout);
    this.stageEl.classList.toggle('is-portrait', portrait);
    this.seatsOval.classList.toggle('hidden', portrait);
    this.seatsList.classList.toggle('hidden', !portrait);
    const seatsWrap = portrait ? this.seatsList : this.seatsOval;
    const occupied = seats.filter((s) => s.userId).length;
    const delta = hand?.result ? chipDelta(hand) : new Map();

    const visibleOrder = portrait
      ? order.filter((seat) => seats.find((s) => s.seat === seat)?.userId || seat === mySeat)
      : order;

    // 按顺序写 DOM（保证 MVP 在最后 → 视觉上在最下方）
    const frag = document.createDocumentFragment();
    visibleOrder.forEach((seat, index) => {
      const el = this.seatNode(seat);
      const pos = this.ovalPosition(index, visibleOrder.length);
      el.style.setProperty('--seat-x', `${pos.x.toFixed(2)}%`);
      el.style.setProperty('--seat-y', `${pos.y.toFixed(2)}%`);
      el.style.setProperty('--seat-rot', `${(pos.angle * 180) / Math.PI + 90}deg`);
      el.style.setProperty('--seat-index', String(index));
      this.paintSeat(el, {
        seat,
        seatInfo: seats.find((s) => s.seat === seat),
        handSeat: hand?.seats?.find((s) => s.seat === seat),
        isTurn: hand?.currentTurnSeat === seat && !hand?.settled,
        isMe: seat === mySeat,
        isButton: hand?.buttonSeat === seat || (!hand && snap?.buttonSeat === seat),
        isWinner: Boolean(hand?.result && (hand.result.payouts?.[seat] ?? 0) > 0),
        position: hand ? positionOf(hand, seat) : tablePositionOf(snap, seat),
        delta: delta.get(seat) ?? 0,
        settled: Boolean(hand?.settled),
      });
      frag.appendChild(el);
    });
    seatsWrap.replaceChildren(frag);

    /* 底部：旁观条 / 我的牌 */
    const seated = Boolean(me);
    this.spectateBar.classList.toggle('visible', !seated);
    this.myZoneEl.classList.toggle('hidden', !seated);

    /* 我的手牌 */
    const holeCards = myHandSeat?.holeCards ?? (state.lastHoleCards ?? []);
    const holeKey = holeCards.join(',');
    if (this.holeKey !== holeKey) {
      this.holeKey = holeKey;
      this.myHoleEl.replaceChildren();
      if (holeCards.length) {
        for (const c of holeCards) this.myHoleEl.appendChild(cardEl(c, { size: 'lg' }));
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

    /* 结算浮层 */
    this.renderResult(state, hand);
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
    el.appendChild(node('seat-name'));
    el.appendChild(node('seat-chips'));
    el.appendChild(node('seat-bet'));
    el.appendChild(node('seat-cards'));
    el.appendChild(node('seat-tags'));
    el.appendChild(node('seat-delta'));
    el.addEventListener('click', () => {
      const snap = this.store.state.room.snapshot;
      const hand = snap?.hand;
      const running = Boolean(hand && !hand.settled);
      const taken = Boolean(snap?.seats?.find((s) => s.seat === seat)?.userId);
      const mySeat = this.store.mySeat();
      if (taken || mySeat === seat) return;
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

    el.classList.toggle('seat-empty', !taken);
    el.classList.toggle('seat-me', Boolean(isMe));
    el.classList.toggle('seat-turn', Boolean(isTurn));
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
    const cardsKey = `${cards.join(',')}|${showBacks ? 'b' : ''}|${wasFolded ? 'f' : ''}`;
    if (cardsEl.datasetKey !== cardsKey) {
      cardsEl.datasetKey = cardsKey;
      cardsEl.replaceChildren();
      if (cards.length) {
        for (const c of cards) cardsEl.appendChild(cardEl(c, { size: 'sm', highlight: Boolean(isWinner && settled) }));
      } else if (showBacks) {
        cardsEl.appendChild(cardEl('', { hidden: true, size: 'sm' }));
        cardsEl.appendChild(cardEl('', { hidden: true, size: 'sm' }));
      }
    }

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

  renderResult(state, hand) {
    const last = state.room.lastResult;
    const hasResult = Boolean(last?.result) || Boolean(hand?.settled && hand?.result);
    if (!hasResult) {
      this.resultOverlay.classList.remove('visible');
      this.resultDismissedFor = '';
      return;
    }
    const handId = last?.handId ?? hand?.handId ?? '';
    // 同一手牌只展示一次；想调试可临时打开 views.table._dbg
    if (this.resultDismissedFor === handId) {
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

    const mySeat = this.store.mySeat();
    const mine = summary.rows.find((r) => r.seat === mySeat);
    const headline = mine
      ? mine.net > 0
        ? `你赢了 ${chips(mine.net)}`
        : mine.net < 0
          ? `你输了 ${chips(Math.abs(mine.net))}`
          : '本手打平'
      : '本手结算';

    const card = node('result-card');
    card.appendChild(tag('h2', `result-headline ${mine && mine.net > 0 ? 'win' : mine && mine.net < 0 ? 'lose' : ''}`, headline));

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

    if (summary.deadMoney > 0) {
      card.appendChild(tag('div', 'result-note', `有 ${chips(summary.deadMoney)} 无人认领（孤池），按规则留在桌上`));
    }

    this.resultOverlay.replaceChildren(card);
    this.resultOverlay.classList.add('visible');

    // 自动收起
    if (this.resultTimer) clearTimeout(this.resultTimer);
    this.resultTimer = setTimeout(() => {
      this.resultDismissedFor = handId;
      this.resultOverlay.classList.remove('visible');
    }, RESULT_HOLD_MS);

    // 点一下也可以立即收起
    this.resultOverlay.onclick = () => {
      this.resultDismissedFor = handId;
      this.resultOverlay.classList.remove('visible');
    };
  }
}
