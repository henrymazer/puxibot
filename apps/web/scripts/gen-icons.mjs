// Gera os ícones PNG do PWA a partir das mesmas formas do favicon.svg, sem dependências
// (rasterização própria com supersampling + PNG via zlib). Uso: node scripts/gen-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const out = join(dirname(fileURLToPath(import.meta.url)), "../public/icons");
mkdirSync(out, { recursive: true });

const GREEN = [0x2f, 0x6f, 0x62];
const CREAM = [0xf6, 0xf5, 0xf1];
const AMBER = [0xe9, 0xb8, 0x72];

// Formas no espaço 32x32 do favicon.
function roundRect(x, y, w, h, r) {
  return (px, py) => {
    if (px < x || py < y || px > x + w || py > y + h) return false;
    const cx = Math.min(Math.max(px, x + r), x + w - r);
    const cy = Math.min(Math.max(py, y + r), y + h - r);
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
  };
}
const circle = (cx, cy, r) => (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r;

function render(size, { maskable = false } = {}) {
  // maskable: fundo cheio e marca reduzida para caber na zona segura (80%).
  const bg = maskable ? (() => true) : roundRect(0, 0, 32, 32, 9);
  const scale = maskable ? 0.72 : 1;
  const t = (v) => 16 + (v - 16) * scale;
  const dot = circle(t(12), t(16), 4.5 * scale);
  const sq = roundRect(t(17.5), t(11.5), 9 * scale, 9 * scale, 2.5 * scale);
  const S = 4;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const px = ((x + (sx + 0.5) / S) / size) * 32;
          const py = ((y + (sy + 0.5) / S) / size) * 32;
          let c = null;
          if (bg(px, py)) c = GREEN;
          if (c && dot(px, py)) c = CREAM;
          if (c && sq(px, py)) c = AMBER;
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      const n = S * S;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      // Cor não pré-multiplicada.
      const cov = a / 255;
      raw[o] = cov ? Math.round(r / cov) : 0;
      raw[o + 1] = cov ? Math.round(g / cov) : 0;
      raw[o + 2] = cov ? Math.round(b / cov) : 0;
      raw[o + 3] = Math.round(a / n);
    }
  }
  return png(size, size, raw);
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const files = {
  "icon-192.png": render(192),
  "icon-512.png": render(512),
  "maskable-512.png": render(512, { maskable: true }),
  "maskable-192.png": render(192, { maskable: true }),
  // iOS aplica as próprias bordas: fundo cheio.
  "apple-touch-icon.png": render(180, { maskable: true }),
};
for (const [name, buf] of Object.entries(files)) writeFileSync(join(out, name), buf);
console.log("ícones gerados em", out, Object.keys(files).join(", "));
