/**
 * 牌面与筹码的 DOM 片段
 */

import { cardText, isRedCard, chips as fmtChips } from '../core/format.js';

/**
 * 一张牌
 * @param {string} card 例如 'As'
 * @param {{ hidden?: boolean, size?: 'sm'|'md'|'lg', dim?: boolean, highlight?: boolean }} [options]
 * @returns {HTMLElement}
 */
export function cardEl(card, options = {}) {
  const el = document.createElement('span');
  el.className = ['card', `card-${options.size ?? 'md'}`].join(' ');
  if (options.hidden) {
    el.classList.add('card-back');
    el.textContent = '';
    return el;
  }
  if (isRedCard(card)) el.classList.add('card-red');
  if (options.dim) el.classList.add('card-dim');
  if (options.highlight) el.classList.add('card-hi');
  el.textContent = cardText(card);
  el.title = String(card ?? '');
  return el;
}

/**
 * 一组牌
 * @param {string[]} cards
 * @param {{ hidden?: boolean, size?: 'sm'|'md'|'lg', dim?: boolean, highlight?: boolean, empty?: string }} [options]
 * @returns {HTMLElement}
 */
export function cardRow(cards, options = {}) {
  const row = document.createElement('div');
  row.className = 'card-row';
  const list = Array.isArray(cards) ? cards : [];
  if (!list.length) {
    if (options.empty) {
      const ph = document.createElement('span');
      ph.className = 'card-empty';
      ph.textContent = options.empty;
      row.appendChild(ph);
    }
    return row;
  }
  for (const card of list) row.appendChild(cardEl(card, options));
  return row;
}

/**
 * 公共牌位：固定 5 个位置，没有牌就显示占位
 * @param {string[]} board
 * @param {{ size?: 'sm'|'md'|'lg' }} [options]
 * @returns {HTMLElement}
 */
export function boardEl(board, options = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'board';
  const cards = Array.isArray(board) ? board : [];
  for (let i = 0; i < 5; i++) {
    if (cards[i]) wrap.appendChild(cardEl(cards[i], { size: options.size ?? 'lg' }));
    else {
      const slot = document.createElement('span');
      slot.className = `card card-slot card-${options.size ?? 'lg'}`;
      wrap.appendChild(slot);
    }
  }
  return wrap;
}

/**
 * 筹码数字（带单位后缀）
 * @param {number} amount
 * @param {{ prefix?: string, signed?: boolean }} [options]
 * @returns {HTMLElement}
 */
export function chipText(amount, options = {}) {
  const el = document.createElement('span');
  const value = Number(amount) || 0;
  const sign = options.signed && value > 0 ? '+' : options.signed && value < 0 ? '−' : '';
  el.className = 'chip-text';
  if (options.signed) el.classList.add(value > 0 ? 'chip-up' : value < 0 ? 'chip-down' : 'chip-flat');
  el.textContent = `${options.prefix ?? ''}${sign}${fmtChips(Math.abs(value))}`;
  el.title = String(Math.abs(value));
  return el;
}
