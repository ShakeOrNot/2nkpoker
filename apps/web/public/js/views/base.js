/**
 * 视图基类：每个视图负责自己那块 DOM 的创建与更新。
 * render(state) 会被高频调用，所以实现里要尽量做增量更新。
 */

export class View {
  /**
   * @param {import('../store.js').Store} store
   */
  constructor(store) {
    this.store = store;
    this.root = document.createElement('section');
    this.root.className = 'view hidden';
    this.mounted = false;
  }

  /**
   * 显示这个视图（并确保它挂在容器里）
   *
   * 实现说明：视图对象建好后一直留在容器里，靠 `hidden` 类控制显隐 ——
   * 切换零延迟、不用重建 DOM。但隐藏的视图必须是真正的 display:none，
   * 否则页面里会同时存在多套界面的按钮（曾经的 bug：DOM 里塞了 4 套 UI）。
   *
   * @param {HTMLElement} container
   */
  mount(container) {
    if (this.root.parentNode !== container) container.appendChild(this.root);
    this.mounted = true;
    this.root.classList.remove('hidden');
    this.root.classList.add('view-active');
  }

  unmount() {
    this.root.classList.add('hidden');
    this.root.classList.remove('view-active');
  }

  /**
   * 当前是否可见
   * @returns {boolean}
   */
  get isActive() {
    return this.root.classList.contains('view-active') && !this.root.classList.contains('hidden');
  }

  /**
   * @param {any} _state
   */
  render(_state) {
    /* 子类实现 */
  }
}

/**
 * 只创建一次文本节点，之后靠 textContent 更新
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
export function node(className = '', text = '') {
  const el = document.createElement('div');
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
export function tag(tagName, className = '', text = '') {
  const el = document.createElement(tagName);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
}

/**
 * 按钮：dom 里只建一次，后续只改 disabled / 文本
 * @param {{ label: string, className?: string, onClick?: (ev: Event) => void, type?: string }} options
 * @returns {HTMLButtonElement}
 */
export function button({ label, className = '', onClick, type = 'button' }) {
  const el = document.createElement('button');
  el.type = type;
  el.className = `btn ${className}`.trim();
  el.textContent = label;
  if (onClick) el.addEventListener('click', onClick);
  return el;
}

/**
 * 把文本写进节点（内容变化时才写）
 * @param {HTMLElement|null} el
 * @param {string|number} text
 */
export function setText(el, text) {
  if (!el) return;
  const next = String(text ?? '');
  if (el.textContent !== next) el.textContent = next;
}

/**
 * @param {HTMLElement|null} el
 * @param {boolean} on
 */
export function setDisabled(el, on) {
  if (!el) return;
  if (on) el.setAttribute('disabled', 'disabled');
  else el.removeAttribute('disabled');
}

/**
 * @param {HTMLElement|null} el
 * @param {string} name
 * @param {boolean} on
 */
export function toggleClass(el, name, on) {
  if (!el) return;
  el.classList.toggle(name, Boolean(on));
}
