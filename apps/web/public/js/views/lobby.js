/**
 * 牌局大厅：创建牌局 / 加入牌局。
 *
 * 加入方式有三条路，优先级从高到低：
 *   1. 后端 /tables 列表（后端补上接口后自动出现）
 *   2. 本机创建/加入过的牌局记录（roomStore）
 *   3. 手动输入房号或粘贴分享链接
 */

import { View, button, node, setDisabled, setText, tag } from './base.js';
import { toast, copyText } from '../core/dom.js';
import { stakeText, ago } from '../core/format.js';
import { BLIND_LEVELS, MAX_SEATS, MIN_BUY_IN, MAX_BUY_IN } from '../core/constants.js';
import { defaultRoomConfig, normalizeRoomInput, isValidRoomId, shareUrl } from '../core/logic.js';
import { loadRecords, mergeRooms, forgetRecord } from '../net/roomStore.js';
import * as api from '../net/api.js';
import { notifyFailure } from '../net/api.js';

export class LobbyView extends View {
  /**
   * @param {import('../store.js').Store} store
   */
  constructor(store) {
    super(store);
    this.root.classList.add('view-lobby');
    this.mode = 'list'; // list | create | join
    this.rooms = [];
    this.listState = 'idle'; // idle | loading | ok | unavailable
    this.blindIndex = 0;
    /* 两张可折叠卡片是否展开：默认都折叠，点各自页签切换 */
    this.manualOpen = false;
    this.createOpen = false;
    this.build();
  }

  /**
   * 每次从牌桌/等待室回到大厅：重置到「加入牌局」列表页并强制刷新。
   * 否则上次展开的创建表单会挂着、刚创建/加入过的牌局不会出现在列表里，
   * 重复进出时看起来像"房间丢了"。
   * @param {HTMLElement} container
   */
  mount(container) {
    super.mount(container);
    this.manualOpen = false;
    this.createOpen = false;
    this.listState = 'idle';
    this.setMode('list');
  }

  build() {
    /* 顶栏 */
    const header = node('app-header');
    const who = node('who');
    this.avatar = node('avatar', '♠');
    this.userLabel = node('who-name');
    who.appendChild(this.avatar);
    who.appendChild(this.userLabel);
    header.appendChild(who);

    const actions = node('header-actions');
    this.logoutBtn = button({
      label: '退出',
      className: 'btn-ghost btn-sm',
      onClick: () => this.store.logout(),
    });
    actions.appendChild(this.logoutBtn);
    header.appendChild(actions);
    this.root.appendChild(header);

    /* 模式切换 */
    const tabs = node('tabs');
    this.tabList = button({ label: '加入牌局', className: 'tab tab-active', onClick: () => this.setMode('list', { toggleManual: true }) });
    this.tabCreate = button({ label: '创建牌局', className: 'tab', onClick: () => this.setMode('create', { toggleCreate: true }) });
    tabs.appendChild(this.tabList);
    tabs.appendChild(this.tabCreate);
    this.root.appendChild(tabs);

    /* 内容区 */
    this.body = node('lobby-body');
    this.root.appendChild(this.body);

    this.buildList();
    this.buildCreate();
    this.buildJoin();
    this.setMode('list');
  }

  /* ---------------- 列表 ---------------- */

  buildList() {
    this.panelList = node('panel panel-list');

    /* 「用房号加入」卡片：默认折叠（hidden），点「加入牌局」页签才展开。
       放在面板最前面，所以展开时正好落在页签正下方 */
    this.manualCard = node('card card-flat hidden');
    this.manualCard.appendChild(tag('h3', 'card-title', '用房号加入'));
    const manualRow = node('row');
    this.roomInput = tag('input', 'input');
    this.roomInput.type = 'text';
    this.roomInput.placeholder = '输入房号或粘贴邀请链接';
    this.roomInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') void this.joinByInput();
    });
    manualRow.appendChild(this.roomInput);
    manualRow.appendChild(button({ label: '加入', className: 'btn-primary', onClick: () => void this.joinByInput() }));
    this.manualCard.appendChild(manualRow);
    this.panelList.appendChild(this.manualCard);

    const bar = node('list-bar');
    this.refreshBtn = button({
      label: '刷新',
      className: 'btn-ghost btn-sm',
      onClick: () => void this.refresh(),
    });
    bar.appendChild(this.refreshBtn);
    this.listHint = node('hint');
    bar.appendChild(this.listHint);
    this.panelList.appendChild(bar);

    this.noticeWrap = node('notice notice-warn');
    this.panelList.appendChild(this.noticeWrap);

    this.roomList = node('room-list');
    this.panelList.appendChild(this.roomList);
  }

  async joinByInput() {
    const tableId = normalizeRoomInput(this.roomInput.value);
    if (!isValidRoomId(tableId)) {
      toast('请输入正确的房号（2~32 位字母或数字）', 'error');
      return;
    }
    const res = await this.store.joinRoom(tableId);
    if (!res.ok) notifyFailure(res, '加入失败');
  }

  async refresh() {
    this.listState = 'loading';
    this.renderRooms();
    if (this.store.state.offline) {
      this.listState = 'ok';
      this.rooms = mergeRooms([]);
      this.renderRooms();
      return;
    }
    const res = await api.listRooms();
    if (!res.ok) {
      this.listState = 'unavailable';
      this.rooms = mergeRooms([]);
    } else {
      this.listState = 'ok';
      this.rooms = mergeRooms(res.rooms);
    }
    this.renderRooms();
  }

  renderRooms() {
    setText(this.listHint, this.listState === 'loading' ? '加载中…' : `${this.rooms.length} 个牌局`);

    this.noticeWrap.replaceChildren();
    if (this.listState === 'unavailable') {
      this.noticeWrap.appendChild(
        tag('div', '', '牌局列表暂时取不到（后端 /tables 不可用？）：下面显示的是本机创建/加入过的牌局，也可以直接输入房号。'),
      );
      this.noticeWrap.classList.add('visible');
    } else {
      this.noticeWrap.classList.remove('visible');
    }

    this.roomList.replaceChildren();
    if (!this.rooms.length) {
      const empty = node('empty-state');
      empty.appendChild(tag('div', 'empty-icon', '♣'));
      empty.appendChild(tag('p', '', this.listState === 'loading' ? '正在获取牌局…' : '还没有牌局，点击创建牌局立即创建一个'));
      /* 这里原来有个「创建牌局」按钮，按需求删掉了（顶部页签仍可切到创建） */
      this.roomList.appendChild(empty);
      return;
    }

    for (const room of this.rooms) {
      this.roomList.appendChild(this.roomCard(room));
    }
  }

  /**
   * @param {any} room
   * @returns {HTMLElement}
   */
  roomCard(room) {
    const card = node('room-card');
    const main = node('room-main');

    const title = node('room-title');
    title.appendChild(tag('span', 'room-id', room.roomId));
    if (room.hasHand) title.appendChild(tag('span', 'badge badge-live', '进行中'));
    else title.appendChild(tag('span', 'badge', '等待中'));
    if (room.isHost) title.appendChild(tag('span', 'badge badge-host', '我创建的'));
    main.appendChild(title);

    const meta = node('room-meta');
    meta.appendChild(tag('span', '', stakeText(room)));
    meta.appendChild(tag('span', '', `座位 ${room.players ?? 0}/${room.maxSeats}`));
    if (room.createdAt) meta.appendChild(tag('span', '', ago(room.createdAt)));
    if (room.source === 'local') meta.appendChild(tag('span', 'tag-local', '本机记录'));
    main.appendChild(meta);
    card.appendChild(main);

    const side = node('room-side');
    side.appendChild(
      button({
        label: room.hasHand ? '进入等待' : '加入',
        className: 'btn-primary btn-sm',
        onClick: async () => {
          const res = await this.store.joinRoom(room.roomId);
          if (!res.ok) notifyFailure(res, '加入失败');
        },
      }),
    );
    const more = node('room-more');
    more.appendChild(
      button({
        label: '邀请',
        className: 'btn-ghost btn-xs',
        onClick: async () => {
          const url = shareUrl(window.location.href, room.roomId);
          const ok = await copyText(url);
          toast(ok ? '邀请链接已复制' : '复制失败，请手动复制', ok ? 'success' : 'error');
        },
      }),
    );
    if (room.source === 'local') {
      more.appendChild(
        button({
          label: '删除',
          className: 'btn-ghost btn-xs',
          onClick: () => {
            forgetRecord(room.roomId);
            this.rooms = this.rooms.filter((r) => r.roomId !== room.roomId);
            this.renderRooms();
            toast('已从本机记录移除', 'info');
          },
        }),
      );
    }
    side.appendChild(more);
    card.appendChild(side);
    return card;
  }

  /* ---------------- 创建 ---------------- */

  buildCreate() {
    this.panelCreate = node('panel panel-create');
    /* 「创建牌局」卡片：和「用房号加入」一样默认折叠，点「创建牌局」页签才展开 */
    this.createCard = node('card hidden');
    const card = this.createCard;
    card.appendChild(tag('h3', 'card-title', '创建牌局'));

    const cfg = defaultRoomConfig(0);

    const seatField = node('field');
    seatField.appendChild(tag('label', 'field-label', '座位数'));
    this.seatRow = node('chip-row');
    this.seatValue = MAX_SEATS;
    for (let n = 2; n <= MAX_SEATS; n++) {
      const b = button({
        label: `${n} 人`,
        className: n === MAX_SEATS ? 'chip chip-active' : 'chip',
        onClick: () => {
          this.seatValue = n;
          for (const child of this.seatRow.children) child.classList.remove('chip-active');
          b.classList.add('chip-active');
        },
      });
      this.seatRow.appendChild(b);
    }
    seatField.appendChild(this.seatRow);
    card.appendChild(seatField);

    const blindField = node('field');
    blindField.appendChild(tag('label', 'field-label', '盲注（小盲 / 大盲）'));
    this.blindRow = node('chip-row');
    BLIND_LEVELS.forEach((level, idx) => {
      const b = button({
        label: level.label,
        className: idx === 0 ? 'chip chip-active' : 'chip',
        onClick: () => {
          this.blindIndex = idx;
          for (const child of this.blindRow.children) child.classList.remove('chip-active');
          b.classList.add('chip-active');
          this.buyInInput.value = String(level.bigBlind * 50);
        },
      });
      this.blindRow.appendChild(b);
    });
    blindField.appendChild(this.blindRow);
    card.appendChild(blindField);

    const buyField = node('field');
    buyField.appendChild(tag('label', 'field-label', `带入筹码（${MIN_BUY_IN}~${MAX_BUY_IN}）`));
    this.buyInInput = tag('input', 'input input-number');
    this.buyInInput.type = 'number';
    this.buyInInput.inputMode = 'numeric';
    this.buyInInput.value = String(cfg.buyIn);
    this.buyInInput.min = String(MIN_BUY_IN);
    this.buyInInput.max = String(MAX_BUY_IN);
    this.buyInInput.step = '100';
    buyField.appendChild(this.buyInInput);

    const quickBuy = node('chip-row');
    for (const mult of [20, 50, 100]) {
      quickBuy.appendChild(
        button({
          label: `${mult} BB`,
          className: 'chip chip-sm',
          onClick: () => {
            const bb = BLIND_LEVELS[this.blindIndex]?.bigBlind ?? 20;
            this.buyInInput.value = String(Math.min(MAX_BUY_IN, bb * mult));
          },
        }),
      );
    }
    buyField.appendChild(quickBuy);
    card.appendChild(buyField);

    const hint = tag('p', 'hint', '创建后会进入等待室，把房号或邀请链接发给朋友即可加入。');
    card.appendChild(hint);

    this.createBtn = button({
      label: '创建并进入等待室',
      className: 'btn-primary btn-block btn-lg',
      onClick: () => void this.doCreate(),
    });
    card.appendChild(this.createBtn);
    this.panelCreate.appendChild(card);
  }

  async doCreate() {
    const level = BLIND_LEVELS[this.blindIndex] ?? BLIND_LEVELS[0];
    const cfg = {
      maxSeats: this.seatValue,
      smallBlind: level.smallBlind,
      bigBlind: level.bigBlind,
      buyIn: Math.floor(Number(this.buyInInput.value) || level.bigBlind * 50),
    };
    setDisabled(this.createBtn, true);
    const res = await this.store.createRoom(cfg);
    setDisabled(this.createBtn, false);
    if (!res.ok) notifyFailure(res, '创建失败');
    else toast(`牌局 ${res.tableId} 已创建`, 'success');
  }

  /* ---------------- 加入（占位面板，实际入口在列表里） ---------------- */

  buildJoin() {
    this.panelJoin = node('panel panel-join');
  }

  /**
   * 把面板挂到视图里（首次访问时补挂）。
   * 之前的 bug：面板建好了却忘了 append 到 body，页面上根本没有这个面板，
   * 点页签自然"没反应"，而且完全不报错。
   * @param {HTMLElement} panel
   */
  attach(panel) {
    if (!panel) return;
    if (!this.body.contains(panel)) this.body.appendChild(panel);
  }

  /**
   * @param {'list'|'create'|'join'} mode
   * @param {{ toggleManual?: boolean, toggleCreate?: boolean }} [opts]
   *        点页签时传对应的 toggle：用来展开/收起那张卡片（两张都默认折叠）
   */
  setMode(mode, { toggleManual = false, toggleCreate = false } = {}) {
    this.mode = mode;
    if (toggleManual) this.manualOpen = !this.manualOpen;
    if (toggleCreate) this.createOpen = !this.createOpen;
    this.manualCard.classList.toggle('hidden', !this.manualOpen);
    this.createCard.classList.toggle('hidden', !this.createOpen);
    this.attach(this.panelList);
    this.attach(this.panelCreate);
    this.attach(this.panelJoin);

    this.tabList.classList.toggle('tab-active', mode === 'list');
    this.tabCreate.classList.toggle('tab-active', mode === 'create');
    this.panelList.classList.toggle('hidden', mode !== 'list');
    this.panelCreate.classList.toggle('hidden', mode !== 'create');
    this.panelJoin.classList.toggle('hidden', mode !== 'join');
    if (mode === 'list' && this.listState === 'idle') void this.refresh();
  }

  /**
   * @param {any} state
   */
  render(state) {
    setText(this.userLabel, state.session?.nickname ? `${state.session.nickname}` : '未登录');
    setDisabled(this.createBtn, Boolean(state.busy));

    const offlineTag = state.offline ? '（离线练习）' : '';
    setText(
      this.listHint,
      this.listState === 'loading' ? '加载中…' : `${this.rooms.length} 个牌局${offlineTag}`,
    );

    if (this.listState === 'idle') void this.refresh();
  }
}
