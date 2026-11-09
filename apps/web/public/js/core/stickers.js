import { getServerConfig } from '../net/api.js';

export const STICKERS = [
  { id: 'nice', name: '好牌' }, { id: 'bravo', name: '漂亮' }, { id: 'allin', name: 'ALL IN' },
  { id: 'again', name: '再战' }, { id: 'steady', name: '稳住' }, { id: 'gg', name: '好局' },
];
export function stickerUrl(sticker, offline = false) {
  if (STICKERS.some(s => s.id === sticker?.id)) return `/img/stickers/${sticker.id}.svg`;
  if (!/^[a-f0-9-]{36}$/.test(sticker?.id ?? '')) return '';
  if (offline && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(sticker.url ?? '') && sticker.url.length <= 350000) return sticker.url;
  return `${getServerConfig().apiBase}/auth/stickers/assets/${sticker.id}`;
}
export async function importStickerImage(file) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片');
  if (file.size > 5 * 1024 * 1024) throw new Error('原图不能超过 5MB');
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 16777216) throw new Error('图片尺寸过大，请选择较小的图片');
    const scale = Math.min(1, 256 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    if (dataUrl.length > 349550) throw new Error('图片压缩后仍过大，请换一张图片');
    return { name: file.name.replace(/\.[^.]+$/, '').slice(0, 24).trim() || '我的表情', dataUrl };
  } finally { bitmap?.close(); }
}
