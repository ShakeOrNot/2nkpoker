/**
 * 登录页：输入用户名 → 拿 token → 进大厅。
 *
 * 设计要点（针对"点了没反应"）：
 *   - 后端连不上时，首屏直接给出「离线练习」大按钮，不让用户卡在登录
 *   - 登录失败一定会弹到脸上（顶部错误条 + toast），不留静默失败
 */

import { View, button, node, setDisabled, setText, tag } from './base.js';
import { toast } from '../core/dom.js';

export class LoginView extends View {
  /**
   * @param {import('../store.js').Store} store
   */
  constructor(store) {
    super(store);
    this.root.classList.add('view-login');
    this.build();
  }

  build() {
    const card = node('login-card');

    const brand = node('brand');
    brand.appendChild(tag('div', 'brand-mark', '♠'));
    const brandText = node('brand-text');
    brandText.appendChild(tag('h1', '', '2nk 德州扑克'));
    brandText.appendChild(tag('p', '', '输入用户名即可开局，手机竖屏、横屏都能玩'));
    brand.appendChild(brandText);
    card.appendChild(brand);

    /* 后端连不上时的醒目横幅：引导用离线练习，而不是让人卡在登录 */
    this.notice = node('notice notice-warn');
    card.appendChild(this.notice);

    const form = tag('form', 'login-form');
    form.autocomplete = 'off';

    const field = node('field');
    field.appendChild(tag('label', 'field-label', '用户名'));
    this.input = tag('input', 'input');
    this.input.type = 'text';
    this.input.placeholder = '例如：阿豪';
    this.input.maxLength = 24;
    this.input.autocapitalize = 'off';
    this.input.autocomplete = 'nickname';
    field.appendChild(this.input);
    form.appendChild(field);

    this.loginBtn = button({
      label: '进入牌局大厅',
      className: 'btn-primary btn-block btn-lg',
      type: 'submit',
    });
    form.appendChild(this.loginBtn);

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void this.submit();
    });
    card.appendChild(form);

    /* 首屏显眼的离线入口：后端没起也能立刻玩 */
    const divider = node('divider');
    divider.appendChild(tag('span', '', '或'));
    card.appendChild(divider);

    this.offlineBtn = button({
      label: '离线练习（不需要后端）',
      className: 'btn-accent btn-block btn-lg',
      onClick: () => void this.startOffline(),
    });
    card.appendChild(this.offlineBtn);
    card.appendChild(tag('p', 'hint hint-center', '用内置的本地对手引擎陪你打，用来熟悉操作与流程'));

    /* 后端状态 + 一键测试 */
    const statusRow = node('server-strip');
    this.serverStatus = node('server-status');
    statusRow.appendChild(this.serverStatus);
    this.testBtn = button({
      label: '测试后端连接',
      className: 'btn-ghost btn-xs',
      onClick: () => void this.testServer(),
    });
    statusRow.appendChild(this.testBtn);
    card.appendChild(statusRow);

    /* 服务器设置（默认折叠） */
    const details = tag('details', 'login-advanced');
    details.appendChild(tag('summary', '', '服务器与高级设置'));
    const body = node('advanced-body');

    this.apiInput = tag('input', 'input');
    this.apiInput.type = 'url';
    this.apiInput.placeholder = 'http://192.168.1.10:3001';
    body.appendChild(labelled('后端地址 (API)', this.apiInput));

    this.wsInput = tag('input', 'input');
    this.wsInput.type = 'url';
    this.wsInput.placeholder = '留空则与后端地址相同';
    body.appendChild(labelled('WebSocket 地址', this.wsInput));

    const serverRow = node('row');
    serverRow.appendChild(
      button({
        label: '保存并测试',
        className: 'btn-ghost',
        onClick: () => {
          this.store.setServer(this.apiInput.value, this.wsInput.value);
          toast('已保存服务器地址，正在测试连通性…', 'info');
          void this.testServer();
        },
      }),
    );
    body.appendChild(serverRow);

    this.tokenInput = tag('input', 'input');
    this.tokenInput.type = 'text';
    this.tokenInput.placeholder = '生产环境可粘贴 A 服务签发的 JWT';
    body.appendChild(labelled('手动 JWT（可选）', this.tokenInput));

    const offlineRow = node('row row-between');
    offlineRow.appendChild(tag('span', 'hint', '把「离线练习」设为默认登录方式'));
    this.offlineToggle = button({
      label: '默认离线练习：关',
      className: 'btn-ghost',
      onClick: () => {
        this.store.setOffline(!this.store.state.offline);
        this.render(this.store.state);
      },
    });
    offlineRow.appendChild(this.offlineToggle);
    body.appendChild(offlineRow);

    details.appendChild(body);
    card.appendChild(details);

    this.root.appendChild(card);
  }

  async testServer() {
    setDisabled(this.testBtn, true);
    setText(this.testBtn, '测试中…');
    try {
      await this.store.pingServer();
    } finally {
      setDisabled(this.testBtn, false);
      setText(this.testBtn, '测试后端连接');
      this.render(this.store.state);
    }
  }

  async startOffline() {
    const nickname = this.input.value.trim() || '练习玩家';
    this.input.value = nickname;
    if (!this.store.state.offline) this.store.setOffline(true);
    await this.submit();
  }

  async submit() {
    const nickname = this.input.value.trim();
    if (!nickname) {
      this.store.reportError('请输入用户名', { log: false });
      this.input.focus();
      return;
    }
    setDisabled(this.loginBtn, true);
    setText(this.loginBtn, '登录中…');

    const res = await this.store.login(nickname, this.tokenInput.value.trim());
    setDisabled(this.loginBtn, false);
    setText(this.loginBtn, '进入牌局大厅');

    // 失败提示由 store.reportError 统一弹出（顶部错误条 + toast），这里只补一句可操作建议
    if (!res?.ok && !this.store.state.offline) {
      toast('也可以直接点「离线练习」先玩起来', 'info');
    }
  }

  /**
   * @param {any} state
   */
  render(state) {
    if (document.activeElement !== this.input && !this.input.value && state.session?.nickname) {
      this.input.value = state.session.nickname;
    }
    const cfg = state.serverConfig;
    if (document.activeElement !== this.apiInput && !this.apiInput.value) this.apiInput.value = cfg.apiBase;
    if (document.activeElement !== this.wsInput && !this.wsInput.value) this.wsInput.value = cfg.wsBase;

    setText(this.offlineToggle, `默认离线练习：${state.offline ? '开' : '关'}`);
    this.tokenInput.disabled = Boolean(state.offline);
    setText(
      this.offlineBtn,
      state.offline ? '离线练习（已开启，点此进入）' : '离线练习（不需要后端）',
    );

    const map = {
      unknown: ['后端状态：未检测', 'status-idle'],
      ok: ['后端状态：可连接', 'status-ok'],
      fail: ['后端状态：连不上', 'status-fail'],
    };
    const [text, cls] = map[state.serverStatus] ?? map.unknown;
    setText(this.serverStatus, state.offline ? '离线练习模式已开启（不连后端）' : text);
    this.serverStatus.className = `server-status ${state.offline ? 'status-idle' : cls}`;

    // 后端连不上时，直接在首屏说明原因并给出出路
    this.notice.replaceChildren();
    if (state.serverStatus === 'fail' && !state.offline) {
      this.notice.className = 'notice notice-warn visible';
      this.notice.appendChild(
        tag(
          'div',
          '',
          `连不上后端（${state.serverConfig.apiBase}）。要么先在项目根目录启动后端，要么直接点下面的「离线练习」——不需要后端也能玩。`,
        ),
      );
    } else {
      this.notice.className = 'notice hidden';
    }

    setDisabled(this.loginBtn, Boolean(state.busy));
    setDisabled(this.offlineBtn, Boolean(state.busy));
  }
}

/**
 * 给输入框配一个标题
 * @param {string} label
 * @param {HTMLElement} input
 * @returns {HTMLElement}
 */
function labelled(label, input) {
  const wrap = node('field');
  wrap.appendChild(tag('label', 'field-label', label));
  wrap.appendChild(input);
  return wrap;
}
