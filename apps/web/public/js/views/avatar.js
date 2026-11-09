import { tag } from './base.js';
import { avatarId } from '../core/avatars.js';
export function paintAvatar(el, value) {
  const id = avatarId(value);
  const src = `/img/avatars/${id}.svg?v=casino-2`;
  if (el.getAttribute('src') !== src) el.setAttribute('src', src);
}
export function avatarEl(value, className = '') {
  const el = tag('img', `player-avatar ${className}`);
  el.setAttribute('alt', '');
  el.setAttribute('aria-hidden', 'true');
  paintAvatar(el, value);
  return el;
}
