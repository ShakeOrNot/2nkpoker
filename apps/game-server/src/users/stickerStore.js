import { randomUUID, createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { getDb } from './db.js';

export const BUILTIN_STICKERS = ['nice', 'bravo', 'allin', 'again', 'steady', 'gg'];
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// 客户端统一转 PNG；服务端验证实际结构、CRC、尺寸与有界解压，去除附加元数据。
export function validateStickerPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > 262144 || !buffer.subarray(0, 8).equals(signature)) throw new Error('图片格式无效');
  const chunks = []; const data = []; let offset = 8; let width; let height; let ended = false; let dataEnded = false;
  while (offset + 12 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    if (offset + size + 12 > buffer.length) throw new Error('图片不完整');
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const payload = buffer.subarray(offset + 8, offset + 8 + size);
    if (crc32(buffer.subarray(offset + 4, offset + 8 + size)) !== buffer.readUInt32BE(offset + 8 + size)) throw new Error('图片校验失败');
    if (!width && type !== 'IHDR') throw new Error('缺少图片信息');
    if (type === 'IHDR') {
      if (width || size !== 13) throw new Error('图片信息无效');
      width = payload.readUInt32BE(0); height = payload.readUInt32BE(4);
      if (!width || !height || width > 512 || height > 512 || payload[8] !== 8 || ![2, 6].includes(payload[9]) || payload[10] || payload[11] || payload[12]) throw new Error('图片尺寸或编码不支持');
      chunks.push(buffer.subarray(offset, offset + size + 12));
    } else if (type === 'IDAT') {
      if (dataEnded) throw new Error('图片数据无效');
      data.push(payload); chunks.push(buffer.subarray(offset, offset + size + 12));
    } else if (type === 'IEND') {
      if (size || !data.length) throw new Error('图片不完整');
      chunks.push(buffer.subarray(offset, offset + 12)); ended = true; offset += 12; break;
    } else {
      if (!['sRGB', 'gAMA', 'cHRM', 'pHYs'].includes(type)) throw new Error('图片编码不支持，请重新导入');
      if (data.length) dataEnded = true;
    }
    offset += size + 12;
  }
  if (!ended || offset !== buffer.length) throw new Error('图片不完整');
  const channels = buffer[25] === 6 ? 4 : 3;
  const stride = width * channels + 1;
  const pixels = inflateSync(Buffer.concat(data), { maxOutputLength: stride * height });
  if (pixels.length !== stride * height) throw new Error('图片数据长度无效');
  for (let row = 0; row < height; row++) if (pixels[row * stride] > 4) throw new Error('图片滤镜无效');
  return Buffer.concat([signature, ...chunks]);
}
export function ensureStickerSchema() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS stickers (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, digest TEXT NOT NULL, image BLOB NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(user_id, digest)
  )`);
}
export const stickerInfo = row => ({ id: row.id, name: row.name, url: `/auth/stickers/assets/${row.id}` });
export function listStickers(userId) {
  return getDb().prepare('SELECT id,name FROM stickers WHERE user_id=? ORDER BY created_at').all(userId).map(stickerInfo);
}
export function findSticker(id) { return getDb().prepare('SELECT * FROM stickers WHERE id=?').get(id); }
export function saveSticker(userId, name, image) {
  const digest = createHash('sha256').update(image).digest('hex');
  const old = getDb().prepare('SELECT id,name FROM stickers WHERE user_id=? AND digest=?').get(userId, digest);
  if (old) return stickerInfo(old);
  if (listStickers(userId).length >= 12) throw new Error('最多保存 12 张自定义表情');
  const row = { id: randomUUID(), name };
  getDb().prepare('INSERT INTO stickers(id,user_id,name,digest,image,created_at) VALUES(?,?,?,?,?,?)').run(row.id, userId, name, digest, image, Date.now());
  return stickerInfo(row);
}
