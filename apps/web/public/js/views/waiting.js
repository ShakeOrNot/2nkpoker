/**
 * 等待室：坐下 / 准备 / 等人齐。
 * 牌局已经开始时，这里就是"观战 + 等下一手"的地方。
 */

import { View, button, node, setDisabled, setText, tag } from './base.js';
import { toast, copyText } from '../core/dom.js';
import { chips, stakeText } from '../core/format.js';
import { MAX_BUY_IN, MIN_BUY_IN } from '../core/constants.js';
import { handRunning, shareUrl, isValidRoomId } from '../core/logic.js';

export class WaitingView extends View {
  /**
   * @param {import('../store.js').Store} store
   */
  constructor(store) {
    super(store);
    this.root.classList.add('view-waiting');
    this.build();
  }

  /* ---------- 背景轮播：6 张照片自动循环 ---------- */

  /**
   * 显示第 i 张，其余淡出
   * @param {number} i
   */
  showSlide(i) {
    this.bgIndex = i;
    this.bgSlides.forEach((el, idx) => el.classList.toggle('is-active', idx === i));
  }

  /** 每 6 秒换一张（进等待室开始，离开就停，避免白占 CPU） */
  startSlideshow() {
    if (this.slideTimer || !this.bgSlides.length) return;
    /* 图片 URL 到这里才写：视图是应用启动时就建好的，
       如果 build() 里就写上，登录页/大厅会提前下载这 6 张照片 */
    this.bgSlides.forEach((el, i) => {
      if (!el.style.backgroundImage) el.style.backgroundImage = `url('./img/waiting-${i + 1}.jpg')`;
    });
    this.showSlide(0);
    this.slideTimer = setInterval(() => {
      this.showSlide((this.bgIndex + 1) % this.bgSlides.length);
    }, 4000);
  }

  stopSlideshow() {
    if (this.slideTimer) {
      clearInterval(this.slideTimer);
      this.slideTimer = null;
    }
  }

  /**
   * @param {HTMLElement} container
   */
  mount(container) {
    super.mount(container);
    this.startSlideshow();
  }

  unmount() {
    super.unmount();
    this.stopSlideshow();
  }

  build() {
    /* 背景轮播层：6 张照片各占一层叠在一起，靠 opacity 交叉淡入淡出。
       放在最前面，配合 index.html 里的 z-index 让它待在内容下面 */
    this.bgSlides = [];
    this.bgIndex = 0;
    this.slideTimer = null;
    const bg = node('waiting-bg');
    for (let i = 1; i <= 6; i++) {
      const slide = node('waiting-bg-slide');
      bg.appendChild(slide);
      this.bgSlides.push(slide);
    }
    this.root.appendChild(bg);

    const header = node('app-header');
    this.backBtn = button({
      label: '返回大厅',
      className: 'btn-ghost btn-sm',
      onClick: () => {
        this.store.patch({ phase: 'lobby' });
      },
    });
    header.appendChild(this.backBtn);
    header.appendChild(tag('div', 'header-title', '等待室'));
    this.connBadge = node('badge');
    header.appendChild(this.connBadge);
    this.root.appendChild(header);

    const body = node('waiting-body');

    /* 房号卡片 */
    const roomCard = node('card card-hero');
    roomCard.appendChild(tag('div', 'card-label', '房号'));
    const idRow = node('row row-between');
    this.roomIdEl = tag('div', 'room-id-big', '------');
    idRow.appendChild(this.roomIdEl);
    this.copyBtn = button({
      label: '复制邀请链接',
      className: 'btn-primary btn-sm',
      onClick: async () => {
        const tableId = this.store.state.room.tableId;
        if (!isValidRoomId(tableId)) return;
        const ok = await copyText(shareUrl(window.location.href, tableId));
        toast(ok ? '邀请链接已复制，发给朋友即可加入' : '复制失败，请手动复制', ok ? 'success' : 'error');
      },
    });
    idRow.appendChild(this.copyBtn);
    roomCard.appendChild(idRow);
    this.stakeEl = tag('div', 'room-stake', '');
    roomCard.appendChild(this.stakeEl);
    body.appendChild(roomCard);

    /* 状态提示 */
    this.notice = node('notice');
    body.appendChild(this.notice);

    /* 座位列表 */
    const seatCard = node('card');
    const seatHead = node('row row-between');
    seatHead.appendChild(tag('h3', 'card-title', '座位'));
    this.seatCountEl = node('hint');
    seatHead.appendChild(this.seatCountEl);
    seatCard.appendChild(seatHead);
    this.seatGrid = node('seat-grid');
    seatCard.appendChild(this.seatGrid);
    body.appendChild(seatCard);

    /* 带入与操作 */
    const actionCard = node('card');
    this.buyRow = node('field');
    this.buyRow.appendChild(tag('label', 'field-label', `带入筹码（${MIN_BUY_IN}~${MAX_BUY_IN}）`));
    this.buyInput = tag('input', 'input input-number');
    this.buyInput.type = 'number';
    this.buyInput.inputMode = 'numeric';
    this.buyInput.min = String(MIN_BUY_IN);
    this.buyInput.max = String(MAX_BUY_IN);
    this.buyInput.step = '100';
    this.buyInput.value = '1000';
    this.buyRow.appendChild(this.buyInput);
    actionCard.appendChild(this.buyRow);

    this.sitBtn = button({
      label: '坐下',
      className: 'btn-primary btn-block btn-lg',
      onClick: () => void this.doSit(),
    });
    actionCard.appendChild(this.sitBtn);

    this.readyBtn = button({
      label: '准备开始',
      className: 'btn-accent btn-block btn-lg',
      onClick: () => void this.toggleReady(),
    });
    actionCard.appendChild(this.readyBtn);

    this.standBtn = button({
      label: '离座',
      className: 'btn-ghost btn-block',
      onClick: () => void this.doStand(),
    });
    actionCard.appendChild(this.standBtn);

    body.appendChild(actionCard);

    /* 进行中的牌局预览（坐下不了的时候至少能看） */
    this.liveCard = node('card card-live');
    this.liveCard.appendChild(tag('h3', 'card-title', '当前牌局'));
    this.liveInfo = node('live-info');
    this.liveCard.appendChild(this.liveInfo);
    body.appendChild(this.liveCard);

    this.root.appendChild(body);
  }

  /**
   * @returns {number}
   */
  buyInValue() {
    const snap = this.store.state.room.snapshot;
    const bb = Number(snap?.bigBlind ?? 20);
    const fallback = bb * 50;
    const value = Math.floor(Number(this.buyInput.value) || fallback);
    return Math.min(MAX_BUY_IN, Math.max(MIN_BUY_IN, value));
  }

  async doSit() {
    setDisabled(this.sitBtn, true);
    const res = await this.store.sit(null, this.buyInValue());
    setDisabled(this.sitBtn, false);
    if (!res.ok) toast(res.message || '入座失败', 'error');
  }

  async toggleReady() {
    const snap = this.store.state.room.snapshot;
    const seat = this.store.mySeat();
    const me = snap?.seats?.find((s) => s.seat === seat);
    if (!me) {
      toast('请先坐下', 'error');
      return;
    }
    setDisabled(this.readyBtn, true);
    const res = await this.store.setReady(!me.ready);
    setDisabled(this.readyBtn, false);
    if (!res.ok) toast(res.message || '操作失败', 'error');
  }

  async doStand() {
    setDisabled(this.standBtn, true);
    const res = await this.store.stand();
    setDisabled(this.standBtn, false);
    if (!res.ok) toast(res.message || '离座失败', 'error');
  }

  /**
   * @param {any} state
   */
  render(state) {
    const snap = state.room.snapshot;
    const tableId = state.room.tableId;

    setText(this.roomIdEl, tableId || '------');
    setText(this.stakeEl, snap ? stakeText(snap) : '盲注 10/20 · 6人桌');

    const connMap = {
      online: ['已连接', 'badge-ok'],
      connecting: ['连接中…', 'badge-warn'],
      offline: ['已断开', 'badge-bad'],
      idle: ['未连接', 'badge'],
    };
    const [connText, connCls] = connMap[state.connection] ?? connMap.idle;
    setText(this.connBadge, connText);
    this.connBadge.className = `badge ${connCls}`;

    const seats = snap?.seats ?? [];
    const occupied = seats.filter((s) => s.userId).length;
    const maxSeats = snap?.maxSeats ?? 6;
    const live = handRunning(snap?.hand);
    const mySeat = this.store.mySeat();
    const me = seats.find((s) => s.seat === mySeat);
    const readyCount = seats.filter((s) => s.ready).length;

    setText(this.seatCountEl, `${occupied}/${maxSeats} 已入座 · ${readyCount} 已准备`);

    /* 状态提示 */
    this.notice.replaceChildren();
        if (live) {
      this.notice.className = 'notice notice-live visible';
      if (me) {
        // 如果自己有座位，说明本来就在局里（或者是点返回大厅还没离座的）
        this.notice.appendChild(tag('div', '', '牌局进行中，点击回到牌桌继续操作。'));
        this.notice.appendChild(
          button({
            label: '回到牌桌',
            className: 'btn-primary btn-sm',
            onClick: () => this.store.patch({ phase: 'table' }),
          }),
        );
      } else {
        // 没座位，才是真旁观
        this.notice.appendChild(tag('div', '', '牌局进行中，你可以点“排队等待下一手”，本手结束后自动入座。'));
        this.notice.appendChild(
          button({
            label: '进入观战',
            className: 'btn-ghost btn-sm',
            onClick: () => this.store.patch({ phase: 'table' }),
          }),
        );
      }
    }
     else if (me && me.ready) {
      this.notice.className = 'notice notice-ok visible';
      this.notice.appendChild(tag('div', '', readyCount === occupied ? '所有人已准备，正在发牌…' : '已准备，等待其他玩家准备'));
    } else if (occupied < 2) {
      this.notice.className = 'notice visible';
      this.notice.appendChild(tag('div', '', '至少需要 2 位玩家准备后才能开局，把房号发给朋友吧'));
    } else {
      this.notice.className = 'notice hidden';
    }

    /* 座位 */
    this.seatGrid.replaceChildren();
    for (let i = 0; i < maxSeats; i++) {
      const seat = seats.find((s) => s.seat === i) ?? { seat: i, userId: null };
      const cell = node('seat-cell');
      if (!seat.userId) cell.classList.add('seat-empty');
      if (seat.seat === mySeat) cell.classList.add('seat-me');
      if (seat.ready) cell.classList.add('seat-ready');
      if (seat.userId && !seat.connected) cell.classList.add('seat-offline');

      cell.appendChild(tag('div', 'seat-no', `座位 ${i + 1}`));
      cell.appendChild(tag('div', 'seat-name', seat.userId ? seat.nickname || '玩家' : '空位'));
      cell.appendChild(tag('div', 'seat-chips', seat.userId ? `${chips(seat.chips)} 筹码` : '—'));
      if (seat.userId) {
        const badges = node('seat-badges');
        if (seat.ready) badges.appendChild(tag('span', 'badge badge-ok', '已准备'));
        if (!seat.connected) badges.appendChild(tag('span', 'badge badge-bad', '断线'));
        if (seat.seat === mySeat) badges.appendChild(tag('span', 'badge badge-host', '我'));
        cell.appendChild(badges);
      } else if (!live) {
        cell.appendChild(
          button({
            label: '坐这里',
            className: 'btn-ghost btn-xs',
            onClick: async () => {
              const res = await this.store.sit(i, this.buyInValue());
              if (!res.ok) toast(res.message || '入座失败', 'error');
            },
          }),
        );
      }
      this.seatGrid.appendChild(cell);
    }

    /* 按钮状态 */
    const canSit = !me && occupied < maxSeats;
    const canReady = Boolean(me) && !live;
    const canStand = Boolean(me) && !live;

    setDisabled(this.sitBtn, !canSit);
    setDisabled(this.readyBtn, !canReady);
    setDisabled(this.standBtn, !canStand);
    setText(this.readyBtn, me?.ready ? '取消准备' : '准备开始');
    this.buyRow.classList.toggle('hidden', Boolean(me));

    if (live && occupied < maxSeats) {
      setText(this.sitBtn, '排队等待下一手');
    } else if (occupied >= maxSeats) {
      setText(this.sitBtn, '座位已满');
    } else {
      setText(this.sitBtn, '坐下');
    }

    /* 进行中信息 */
    if (live) {
      this.liveCard.classList.remove('hidden');
      const hand = snap.hand;
      const alive = (hand.seats ?? []).filter((s) => !s.folded);
      this.liveInfo.replaceChildren(
        tag('div', '', `阶段：${streetText(hand.street)}`),
        tag('div', '', `底池：${chips(hand.pot)}`),
        tag('div', '', `公共牌：${(hand.board ?? []).join(' ') || '—'}`),
        tag('div', '', `仍在局中：${alive.map((s) => s.nickname || `座位${s.seat}`).join('、') || '—'}`),
      );
    } else {
      this.liveCard.classList.add('hidden');
    }
  }
}

/**
 * @param {string} street
 * @returns {string}
 */
export function streetText(street) {
  return (
    {
      PREFLOP: '翻牌前',
      FLOP: '翻牌',
      TURN: '转牌',
      RIVER: '河牌',
      SETTLED: '已结算',
    }[String(street)] ?? String(street ?? '')
  );
}
