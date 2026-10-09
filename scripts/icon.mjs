// Writes the Dashboard icon (32x32 PNG): a rounded blue square with a 2x2 grid of tiles.
// Generated at build time so the repository holds no binary asset.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};

export function writeIcon(file, size = 32) {
  const px = Buffer.alloc(size * (size * 4 + 1));
  const r = Math.round(size * 0.19), pad = Math.round(size * 0.16), gap = Math.max(1, Math.round(size * 0.09)), tile = (size - 2 * pad - gap) / 2;
  for (let y = 0; y < size; y++) {
    px[y * (size * 4 + 1)] = 0;                                   // filter: none
    for (let x = 0; x < size; x++) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const dx = Math.max(0, Math.max(r - x, x - (size - 1 - r))), dy = Math.max(0, Math.max(r - y, y - (size - 1 - r)));
      const inside = dx * dx + dy * dy <= r * r;
      if (!inside) continue;
      const tx = x - pad, ty = y - pad;
      const inTile = tx >= 0 && ty >= 0 && tx < 2 * tile + gap && ty < 2 * tile + gap && (tx < tile || tx >= tile + gap) && (ty < tile || ty >= tile + gap);
      const [R, G, B] = inTile ? [255, 255, 255] : [11, 87, 194];
      px[o] = R; px[o + 1] = G; px[o + 2] = B; px[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(px)), chunk("IEND", Buffer.alloc(0))]));
}
