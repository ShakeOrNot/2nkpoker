/**
 * 管理面板（role=admin）：账号列表 / 禁用启用 / 提权降权 / 重置口令 / 审计日志。
 *
 * 注意：这里隐藏什么、禁用什么都只是体验优化，真正的权限在服务端
 * （每个 /auth/admin/* 接口都会再校验一次 role + 令牌版本）。
 */

import { View, button, labelled, node, setDisabled, setText, tag } from './base.js';
import { copyText, toast } from '../core/dom.js';
import { ago, clock } from '../core/format.js';

const PAGE_SIZE = 20;
const AUDIT_LIMIT = 50;

/**
 * 生成 12 位随机口令：字母+数字，保证至少一个字母（口令策略不允许纯数字）
 * @returns {string}
 */
function randomPassword() {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(12);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  if (/^\d+$/.test(out)) out = alphabet[out.charCodeAt(0) % 52] + out.slice(1);
  return out;
}

export class AdminView extends View {
  /**
   * @param {import('../store.js').Store} store
   */
  constructor(store) {
    super(store);
    this.root.classList.add('view-admin');
    this.tab = 'users'; // users | tables | audit
    this.q = '';
    this.offset = 0;
    this.users = [];
    this.total = 0;
    this.loading = false;
    this.tables = [];
    this.auditEntries = [];
    /** @type {any} */
    this.resetTarget = null;
    this.build();
  }

  /**
   * 每次进入：回到账号列表第一页并拉一次最新数据
   * @param {HTMLElement} container
   */
  mount(container) {
    super.mount(container);
    this.tab = 'users';
    this.offset = 0;
    this.renderTabs();
    void this.refreshUsers();
  }

  build() {
    /* 顶栏 */
    const header = node('app-header');
    header.appendChild(tag('h2', 'admin-title', '管理面板'));
    const actions = node('header-actions');
    actions.appendChild(
      button({ label: '返回大厅', className: 'btn-ghost btn-sm', onClick: () => this.store.exitAdmin() }),
    );
    header.appendChild(actions);
    this.root.appendChild(header);

    /* 页签 */
    const tabs = node('admin-tabs');
    this.usersTab = button({ label: '账号', className: 'btn-ghost btn-sm', onClick: () => this.switchTab('users') });
    this.tablesTab = button({ label: '牌桌', className: 'btn-ghost btn-sm', onClick: () => this.switchTab('tables') });
    this.auditTab = button({ label: '审计日志', className: 'btn-ghost btn-sm', onClick: () => this.switchTab('audit') });
    tabs.appendChild(this.usersTab);
    tabs.appendChild(this.tablesTab);
    tabs.appendChild(this.auditTab);
    this.root.appendChild(tabs);

    /* 账号面板 */
    this.usersPanel = node('admin-panel');
    const searchRow = node('admin-search');
    this.searchInput = tag('input', 'input');
    this.searchInput.placeholder = '按昵称搜索';
    this.searchInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') this.doSearch();
    });
    searchRow.appendChild(this.searchInput);
    searchRow.appendChild(button({ label: '搜索', className: 'btn-ghost btn-sm', onClick: () => this.doSearch() }));
    searchRow.appendChild(button({ label: '刷新', className: 'btn-ghost btn-sm', onClick: () => void this.refreshUsers() }));
    this.usersPanel.appendChild(searchRow);

    this.list = node('admin-list');
    this.usersPanel.appendChild(this.list);

    this.pager = node('admin-pager');
    this.prevBtn = button({ label: '上一页', className: 'btn-ghost btn-sm', onClick: () => this.page(-1) });
    this.pageLabel = node('admin-page-label');
    this.nextBtn = button({ label: '下一页', className: 'btn-ghost btn-sm', onClick: () => this.page(1) });
    this.pager.appendChild(this.prevBtn);
    this.pager.appendChild(this.pageLabel);
    this.pager.appendChild(this.nextBtn);
    this.usersPanel.appendChild(this.pager);
    this.root.appendChild(this.usersPanel);

    /* 审计面板 */
    this.auditPanel = node('admin-panel');
    const auditBar = node('admin-search');
    auditBar.appendChild(button({ label: '刷新日志', className: 'btn-ghost btn-sm', onClick: () => void this.refreshAudit() }));
    this.auditPanel.appendChild(auditBar);
    this.auditList = node('admin-list');
    this.auditPanel.appendChild(this.auditList);
    this.root.appendChild(this.auditPanel);

    /* 牌桌面板：所有桌子 + 座位，可解散/踢人 */
    this.tablesPanel = node('admin-panel');
    const tableBar = node('admin-search');
    tableBar.appendChild(
      button({ label: '刷新牌桌', className: 'btn-ghost btn-sm', onClick: () => void this.refreshTables() }),
    );
    tableBar.appendChild(tag('span', 'admin-hint', '解散会立刻踢掉所有人；手牌进行中不能单独踢人'));
    this.tablesPanel.appendChild(tableBar);
    this.tableList = node('admin-list');
    this.tablesPanel.appendChild(this.tableList);
    this.root.appendChild(this.tablesPanel);

    /* 重置口令弹窗 */
    this.pwOverlay = node('modal-overlay');
    const card = node('modal-card');
    card.appendChild(tag('h3', 'modal-title', '重置口令'));
    this.pwWho = tag('p', 'modal-hint', '');
    card.appendChild(this.pwWho);
    this.pwInput = tag('input', 'input');
    this.pwInput.type = 'password';
    this.pwInput.autocomplete = 'new-password';
    this.pwInput.placeholder = '新口令（至少 8 位，不能是纯数字）';
    this.pwInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') void this.submitReset();
    });
    this.pwField = labelled('新口令', this.pwInput);
    card.appendChild(this.pwField);

    /* 随机生成 + 一次性展示 */
    this.pwTools = node('admin-pw-tools');
    this.pwRandomBtn = button({
      label: '随机生成',
      className: 'btn-ghost btn-sm',
      onClick: () => this.generatePassword(),
    });
    this.pwTools.appendChild(this.pwRandomBtn);
    this.pwTools.appendChild(tag('span', 'admin-hint', '重置后只显示这一次，请复制给玩家'));
    card.appendChild(this.pwTools);

    this.pwDone = node('admin-pw-done hidden');
    this.pwDoneText = tag('div', 'admin-pw-value', '');
    this.pwDone.appendChild(this.pwDoneText);
    const pwDoneRow = node('modal-actions');
    pwDoneRow.appendChild(
      button({ label: '复制口令', className: 'btn-ghost', onClick: () => void this.copyPassword() }),
    );
    pwDoneRow.appendChild(button({ label: '完成', className: 'btn-primary', onClick: () => this.closeReset() }));
    this.pwDone.appendChild(pwDoneRow);
    card.appendChild(this.pwDone);

    this.modalActions = node('modal-actions');
    this.modalActions.appendChild(
      button({ label: '取消', className: 'btn-ghost', onClick: () => this.closeReset() }),
    );
    this.pwSubmit = button({ label: '确认重置', className: 'btn-primary', onClick: () => void this.submitReset() });
    this.modalActions.appendChild(this.pwSubmit);
    card.appendChild(this.modalActions);
    this.pwOverlay.appendChild(card);
    this.pwOverlay.addEventListener('click', (ev) => {
      if (ev.target === this.pwOverlay) this.closeReset();
    });
    this.root.appendChild(this.pwOverlay);

    this.renderTabs();
  }

  /**
   * @param {any} state
   */
  render(state) {
    // 会话续期后角色可能被别的管理员改掉：自动退回大厅
    if (this.isActive && !state.session?.user || (this.isActive && state.session?.user?.role !== 'admin')) {
      if (this.isActive && !this.kicked) {
        this.kicked = true;
        toast('当前账号已不是管理员，返回大厅', 'info');
        setTimeout(() => this.store.exitAdmin(), 0);
      }
    }
  }

  /* ---------------- 页签 ---------------- */

  /** @param {'users'|'tables'|'audit'} tab */
  switchTab(tab) {
    this.tab = tab;
    this.renderTabs();
    if (tab === 'audit') void this.refreshAudit();
    if (tab === 'tables') void this.refreshTables();
  }

  renderTabs() {
    this.usersPanel.classList.toggle('hidden', this.tab !== 'users');
    this.tablesPanel.classList.toggle('hidden', this.tab !== 'tables');
    this.auditPanel.classList.toggle('hidden', this.tab !== 'audit');
    this.usersTab.classList.toggle('active', this.tab === 'users');
    this.tablesTab.classList.toggle('active', this.tab === 'tables');
    this.auditTab.classList.toggle('active', this.tab === 'audit');
  }

  /* ---------------- 账号列表 ---------------- */

  doSearch() {
    this.q = this.searchInput.value;
    this.offset = 0;
    void this.refreshUsers();
  }

  /** @param {-1|1} dir */
  page(dir) {
    const next = this.offset + dir * PAGE_SIZE;
    if (next < 0) return;
    if (dir > 0 && next >= this.total) return;
    this.offset = next;
    void this.refreshUsers();
  }

  async refreshUsers() {
    if (this.loading) return;
    this.loading = true;
    const res = await this.store.adminListUsers({ q: this.q, limit: PAGE_SIZE, offset: this.offset });
    this.loading = false;
    if (!res.ok) {
      this.list.textContent = '';
      toast(res.message ?? '加载账号失败', 'error');
      return;
    }
    this.users = res.users;
    this.total = res.total;
    // 最后一页被删空 / 改搜索条件后越界：退回到还能显示数据的位置
    if (!this.users.length && this.offset > 0) {
      this.offset = Math.max(0, this.offset - PAGE_SIZE);
      void this.refreshUsers();
      return;
    }
    this.renderUsers();
  }

  renderUsers() {
    this.list.textContent = '';
    if (!this.users.length) {
      this.list.appendChild(tag('p', 'admin-empty', '没有匹配的账号'));
    }
    for (const user of this.users) this.list.appendChild(this.userRow(user));
    const from = this.users.length ? this.offset + 1 : 0;
    setText(this.pageLabel, `${from}-${this.offset + this.users.length} / ${this.total}`);
    setDisabled(this.prevBtn, this.offset === 0);
    setDisabled(this.nextBtn, this.offset + this.users.length >= this.total);
  }

  /**
   * @param {any} user
   */
  userRow(user) {
    const row = node('admin-row');

    const info = node('admin-cell');
    info.appendChild(tag('div', 'admin-name', String(user.nickname ?? '')));
    const roleText = user.role === 'admin' ? '管理员' : '玩家';
    const stateText = user.disabled ? '已禁用' : '正常';
    info.appendChild(tag('div', 'admin-sub', `${roleText} · ${stateText} · 令牌版本 ${user.tokenVersion ?? 0}`));
    row.appendChild(info);

    const ops = node('admin-actions');
    const isSelf = String(this.store.state.session?.user?.id ?? '') === String(user.id ?? '');
    if (isSelf) {
      ops.appendChild(tag('span', 'admin-hint', '当前账号'));
    } else {
      const nextRole = user.role === 'admin' ? 'user' : 'admin';
      ops.appendChild(
        button({
          label: nextRole === 'admin' ? '提为管理员' : '降为玩家',
          className: 'btn-ghost btn-sm',
          onClick: () => void this.updateUser(user, { role: nextRole }),
        }),
      );
      ops.appendChild(
        button({
          label: user.disabled ? '启用' : '禁用',
          className: 'btn-ghost btn-sm',
          onClick: () => void this.updateUser(user, { disabled: !user.disabled }),
        }),
      );
      ops.appendChild(
        button({ label: '重置口令', className: 'btn-ghost btn-sm admin-reset-btn', onClick: () => this.openReset(user) }),
      );
    }
    row.appendChild(ops);
    return row;
  }

  /**
   * @param {any} user
   * @param {{ role?: 'user'|'admin', disabled?: boolean }} patch
   */
  async updateUser(user, patch) {
    const text = patch.role
      ? patch.role === 'admin'
        ? `把「${user.nickname}」提为管理员？对方会被踢下线，需要用新身份重新登录。`
        : `把「${user.nickname}」降为玩家？对方会被踢下线。`
      : patch.disabled
        ? `禁用「${user.nickname}」？该账号所有登录会立即失效。`
        : `启用「${user.nickname}」？`;
    if (!this.confirm(text)) return;

    const res = await this.store.adminUpdateUser(user.id, patch);
    if (!res.ok) {
      toast(res.message ?? '操作失败', 'error');
      return;
    }
    toast('已保存', 'info');
    void this.refreshUsers();
  }

  /**
   * 高危操作二次确认（测试环境没有 window.confirm 时直接放行）
   * @param {string} text
   */
  confirm(text) {
    return typeof window?.confirm === 'function' ? window.confirm(text) : true;
  }

  /* ---------------- 重置口令 ---------------- */

  /** @param {any} user */
  openReset(user) {
    this.resetTarget = user;
    setText(this.pwWho, `给「${user.nickname}」设置新口令（对方其它设备会立即失效）`);
    this.pwInput.value = '';
    this.pwInput.type = 'password';
    this.pwField.classList.remove('hidden');
    this.pwTools.classList.remove('hidden');
    this.pwDone.classList.add('hidden');
    this.modalActions.classList.remove('hidden');
    setDisabled(this.pwSubmit, false);
    setText(this.pwSubmit, '确认重置');
    this.pwOverlay.classList.add('visible');
    this.pwInput.focus?.();
  }

  closeReset() {
    this.pwOverlay.classList.remove('visible');
    this.resetTarget = null;
  }

  /** 生成一个随机口令并填进去（改成明文显示，方便复制） */
  generatePassword() {
    this.pwInput.value = randomPassword();
    this.pwInput.type = 'text';
    this.pwInput.focus?.();
    toast('已生成随机口令', 'info');
  }

  /** 复制弹窗里展示的新口令 */
  async copyPassword() {
    const text = String(this.pwDoneText.textContent ?? '');
    if (!text) return;
    await copyText(text);
    toast('口令已复制', 'info');
  }

  async submitReset() {
    const target = this.resetTarget;
    if (!target) return;
    const password = this.pwInput.value;
    if (password.length < 8) {
      toast('口令至少 8 位', 'error');
      return;
    }
    setDisabled(this.pwSubmit, true);
    const res = await this.store.adminResetPassword(target.nickname, password);
    setDisabled(this.pwSubmit, false);
    if (!res.ok) {
      toast(res.message ?? '重置失败', 'error');
      return;
    }
    // 只显示这一次：口令是单向哈希，关掉窗口就再也查不到了
    setText(this.pwWho, `「${target.nickname}」的口令已重置，复制给他后让对方自行修改：`);
    setText(this.pwDoneText, password);
    this.pwField.classList.add('hidden');
    this.pwTools.classList.add('hidden');
    this.modalActions.classList.add('hidden');
    this.pwDone.classList.remove('hidden');
    toast(`已重置「${target.nickname}」的口令`, 'info');
  }

  /* ---------------- 审计日志 ---------------- */

  async refreshAudit() {
    const res = await this.store.adminAudit(AUDIT_LIMIT);
    if (!res.ok) {
      this.auditList.textContent = '';
      toast(res.message ?? '加载审计日志失败', 'error');
      return;
    }
    this.auditEntries = res.entries;
    this.renderAudit();
  }

  renderAudit() {
    this.auditList.textContent = '';
    if (!this.auditEntries.length) {
      this.auditList.appendChild(tag('p', 'admin-empty', '还没有审计记录'));
      return;
    }
    for (const entry of this.auditEntries) {
      const row = node('admin-row');
      const info = node('admin-cell');
      const failed = entry.ok === false ? '（失败）' : '';
      info.appendChild(tag('div', 'admin-name', `${entry.action}${failed} · ${entry.nickname ?? '—'}`));
      const when = Number(entry.at ?? 0) || Date.now();
      info.appendChild(tag('div', 'admin-sub', `${clock(when)} · ${ago(when)} · ${entry.ip || '—'}`));
      row.appendChild(info);
      this.auditList.appendChild(row);
    }
  }

  /* ---------------- 牌桌管理 ---------------- */

  async refreshTables() {
    const res = await this.store.adminTables();
    if (!res.ok) {
      this.tableList.textContent = '';
      toast(res.message ?? '加载牌桌失败', 'error');
      return;
    }
    this.tables = res.tables;
    this.renderTables();
  }

  renderTables() {
    this.tableList.textContent = '';
    if (!this.tables.length) {
      this.tableList.appendChild(tag('p', 'admin-empty', '当前没有牌桌'));
      return;
    }
    for (const table of this.tables) this.tableCard(table);
  }

  /** @param {any} table */
  tableCard(table) {
    const card = node('admin-table');

    const head = node('admin-row');
    const info = node('admin-cell');
    info.appendChild(tag('div', 'admin-name', `#${table.tableId}`));
    const stateText = table.hasHand ? '牌局进行中' : '空闲';
    info.appendChild(
      tag(
        'div',
        'admin-sub',
        `盲注 ${table.smallBlind}/${table.bigBlind} · ${table.seats.length}/${table.maxSeats} 人 · ${stateText}`,
      ),
    );
    head.appendChild(info);

    const ops = node('admin-actions');
    ops.appendChild(
      button({
        label: '解散牌局',
        className: 'btn-ghost btn-sm admin-close-table',
        onClick: () => void this.closeTable(table),
      }),
    );
    head.appendChild(ops);
    card.appendChild(head);

    for (const seat of table.seats) {
      const line = node('admin-seat');
      const who = node('admin-cell');
      who.appendChild(tag('div', 'admin-sub', `座位 ${seat.seat} · ${seat.nickname}${seat.leaving ? '（离桌中）' : ''}`));
      who.appendChild(tag('div', 'admin-hint', `筹码 ${seat.chips} · ${seat.connected ? '在线' : '掉线'}${seat.ready ? ' · 已准备' : ''}`));
      line.appendChild(who);

      const seatOps = node('admin-actions');
      const kick = button({
        label: '踢出',
        className: 'btn-ghost btn-sm admin-kick',
        onClick: () => void this.kickUser(table, seat),
      });
      if (table.hasHand) {
        setDisabled(kick, true);
        kick.title = '手牌进行中不能踢人（可以先解散牌局）';
      }
      seatOps.appendChild(kick);
      line.appendChild(seatOps);
      card.appendChild(line);
    }

    this.tableList.appendChild(card);
  }

  /** @param {any} table */
  async closeTable(table) {
    if (!this.confirm(`解散牌局 #${table.tableId}？房间里所有人会被立刻移出。`)) return;
    const res = await this.store.adminCloseTable(table.tableId);
    if (!res.ok) {
      toast(res.message ?? '解散失败', 'error');
      return;
    }
    toast(`已解散牌局 #${table.tableId}`, 'info');
    void this.refreshTables();
  }

  /**
   * @param {any} table
   * @param {any} seat
   */
  async kickUser(table, seat) {
    if (!this.confirm(`把「${seat.nickname}」踢出牌局 #${table.tableId}？`)) return;
    const res = await this.store.adminKickUser(table.tableId, seat.userId);
    if (!res.ok) {
      toast(res.message ?? '踢人失败', 'error');
      return;
    }
    toast(`已踢出「${seat.nickname}」`, 'info');
    void this.refreshTables();
  }
}
