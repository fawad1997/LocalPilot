// Generates icons/icon-{16,48,128}.png with no dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Rounded blue square with a white "cursor" arrow, anti-aliased by 4x supersampling.
function inside(x, y, s) {
  const u = x / s;
  const v = y / s;
  const r = 0.22;
  const cx = Math.min(Math.max(u, r), 1 - r);
  const cy = Math.min(Math.max(v, r), 1 - r);
  const bg = (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
  // Cursor triangle: (0.30,0.24) (0.30,0.78) (0.72,0.56)
  const tri = (p, a, b) => (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
  const P = [u, v];
  const A = [0.3, 0.22];
  const B = [0.3, 0.78];
  const C = [0.74, 0.56];
  const d1 = tri(P, A, B);
  const d2 = tri(P, B, C);
  const d3 = tri(P, C, A);
  const fg = !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  return { bg, fg };
}
function pixel(x, y, s) {
  let bg = 0;
  let fg = 0;
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      const p = inside(x - 0.5 + (i + 0.5) / 4, y - 0.5 + (j + 0.5) / 4, s);
      if (p.bg) bg += 1;
      if (p.bg && p.fg) fg += 1;
    }
  }
  const a = bg / 16;
  const f = bg ? fg / bg : 0;
  const blue = [47, 111, 219];
  const mix = blue.map((c) => Math.round(c * (1 - f) + 255 * f));
  return [...mix, Math.round(a * 255)];
}

mkdirSync(path.join(root, 'icons'), { recursive: true });
for (const size of [16, 48, 128]) {
  writeFileSync(path.join(root, 'icons', `icon-${size}.png`), png(size, pixel));
}
console.log('icons written');
