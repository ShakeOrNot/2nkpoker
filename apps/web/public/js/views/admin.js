/**
 * 管理面板（role=admin）：账号列表 / 禁用启用 / 提权降权 / 重置口令 / 审计日志。
 *
 * 注意：这里隐藏什么、禁用什么都只是体验优化，真正的权限在服务端
 * （每个 /auth/admin/* 接口都会再校验一次 role + 令牌版本）。
 */

import { View, button, labelled, node, setDisabled, setText, tag } from './base.js';
import { toast } from '../core/dom.js';
import { ago, clock } from '../core/format.js';

const PAGE_SIZE = 20;
const AUDIT_LIMIT = 50;

export class AdminView extends View {
  /**
   * @param {import('../store.js').Store} store
   */
  constructor(store) {
    super(store);
    this.root.classList.add('view-admin');
    this.tab = 'users'; // users | audit
    this.q = '';
    this.offset = 0;
    this.users = [];
    this.total = 0;
    this.loading = false;
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
    this.auditTab = button({ label: '审计日志', className: 'btn-ghost btn-sm', onClick: () => this.switchTab('audit') });
    tabs.appendChild(this.usersTab);
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
    card.appendChild(labelled('新口令', this.pwInput));
    const modalActions = node('modal-actions');
    modalActions.appendChild(button({ label: '取消', className: 'btn-ghost', onClick: () => this.closeReset() }));
    this.pwSubmit = button({ label: '确认重置', className: 'btn-primary', onClick: () => void this.submitReset() });
    modalActions.appendChild(this.pwSubmit);
    card.appendChild(modalActions);
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

  /** @param {'users'|'audit'} tab */
  switchTab(tab) {
    this.tab = tab;
    this.renderTabs();
    if (tab === 'audit') void this.refreshAudit();
  }

  renderTabs() {
    this.usersPanel.classList.toggle('hidden', this.tab !== 'users');
    this.auditPanel.classList.toggle('hidden', this.tab !== 'audit');
    this.usersTab.classList.toggle('active', this.tab === 'users');
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
    this.pwOverlay.classList.add('visible');
    this.pwInput.focus?.();
  }

  closeReset() {
    this.pwOverlay.classList.remove('visible');
    this.resetTarget = null;
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
    this.closeReset();
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
}
