import { deflateSync } from 'node:zlib';
function chunk(type, data) {
  const buffer = Buffer.alloc(data.length + 12); buffer.writeUInt32BE(data.length); buffer.write(type, 4); data.copy(buffer, 8);
  let crc = 0xffffffff;
  for (const b of buffer.subarray(4, -4)) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  buffer.writeUInt32BE((crc ^ 0xffffffff) >>> 0, buffer.length - 4); return buffer;
}
export function makeStickerPng(width = 64, height = 64, seed = 0) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const radius = Math.hypot(x - width / 2, y - height / 2) / (Math.min(width, height) / 2);
    const gold = radius > .65 && radius < .85;
    const offset = y * (width * 4 + 1) + 1 + x * 4;
    rows[offset] = gold ? 230 : 110 + seed; rows[offset + 1] = gold ? 190 : 35; rows[offset + 2] = gold ? 105 : 45; rows[offset + 3] = radius < .9 ? 255 : 0;
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
