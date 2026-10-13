/**
 * DOM 小工具。刻意只做几件事，避免引入框架。
 */

/**
 * @param {string} sel
 * @param {ParentNode} [root]
 * @returns {HTMLElement|null}
 */
export function qs(sel, root = document) {
  return root.querySelector(sel);
}

/**
 * @param {string} sel
 * @param {ParentNode} [root]
 * @returns {HTMLElement[]}
 */
export function qsa(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

/**
 * 创建元素
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {Array<Node|string|null|undefined>} [children]
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'html') node.innerHTML = String(v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/**
 * 清空并批量添加子节点
 * @param {HTMLElement} node
 * @param {Array<Node|string>} children
 */
export function setChildren(node, children) {
  node.replaceChildren(...children);
}

/**
 * 只设置文本，内容变化时才写 DOM（避免无谓重排）
 * @param {HTMLElement|null} node
 * @param {string|number} text
 */
export function setText(node, text) {
  if (!node) return;
  const next = String(text);
  if (node.textContent !== next) node.textContent = next;
}

/**
 * @param {HTMLElement|null} node
 * @param {boolean} on
 */
export function setDisabled(node, on) {
  if (!node) return;
  if (on) node.setAttribute('disabled', 'disabled');
  else node.removeAttribute('disabled');
}

/**
 * 切换 class
 * @param {HTMLElement|null} node
 * @param {string} name
 * @param {boolean} on
 */
export function setClass(node, name, on) {
  if (!node) return;
  node.classList.toggle(name, on);
}

/**
 * 短暂显示一条 toast 提示
 * @param {string} message
 * @param {'info'|'error'|'success'} [kind]
 */
export function toast(message, kind = 'info') {
  const host = qs('#toast') ?? document.body.appendChild(el('div', { id: 'toast' }));
  const item = el('div', { class: `toast-item toast-${kind}`, text: message });
  host.appendChild(item);
  setTimeout(() => item.classList.add('toast-out'), 2200);
  setTimeout(() => item.remove(), 2600);
}

/**
 * 复制文本到剪贴板（不支持时回退到 prompt）
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 继续走回退 */
  }
  try {
    window.prompt('复制这条内容：', text);
    return true;
  } catch {
    return false;
  }
}
