// Procedural NOVA AI Core Icon Generator (pure Node.js, zero copyrighted assets)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const outDir = path.resolve("src-tauri/icons");
fs.mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function renderNovaPng(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const rMax = size * 0.46;

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter type 0
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 4;
      const dx = (x - cx) / rMax;
      const dy = (y - cy) / rMax;
      const dist = Math.hypot(dx, dy);

      // Rounded squircle mask
      const sx = Math.abs((x - cx) / (size * 0.45));
      const sy = Math.abs((y - cy) / (size * 0.45));
      const squircle = Math.pow(sx, 4) + Math.pow(sy, 4);

      if (squircle > 1.05) {
        raw[px] = 0;
        raw[px + 1] = 0;
        raw[px + 2] = 0;
        raw[px + 3] = 0;
        continue;
      }

      const edgeAlpha = squircle > 0.92 ? Math.max(0, 1 - (squircle - 0.92) / 0.13) : 1;

      // Deep obsidian base
      let r = 8;
      let g = 12;
      let b = 22;

      // Outer orbital ring (cyan-violet gradient)
      const ring1 = Math.exp(-Math.pow((dist - 0.72) / 0.08, 2));
      // Inner core glow
      const core = Math.exp(-Math.pow(dist / 0.36, 2));
      const hotCenter = Math.exp(-Math.pow(dist / 0.16, 2));

      const angle = Math.atan2(dy, dx);
      const wave = 0.5 + 0.5 * Math.sin(angle * 2 + 0.8);

      r += ring1 * (45 + 130 * wave) + core * 36 + hotCenter * 210;
      g += ring1 * (215 - 65 * wave) + core * 195 + hotCenter * 235;
      b += ring1 * 255 + core * 245 + hotCenter * 255;

      raw[px] = Math.min(255, Math.round(r));
      raw[px + 1] = Math.min(255, Math.round(g));
      raw[px + 2] = Math.min(255, Math.round(b));
      raw[px + 3] = Math.min(255, Math.round(edgeAlpha * 255));
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function buildIco(png32, png256) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // ICO
  header.writeUInt16LE(2, 4); // 2 entries

  const dir1 = Buffer.alloc(16);
  dir1[0] = 32;
  dir1[1] = 32;
  dir1.writeUInt16LE(1, 4);
  dir1.writeUInt16LE(32, 6);
  dir1.writeUInt32LE(png32.length, 8);
  dir1.writeUInt32LE(6 + 32, 12);

  const dir2 = Buffer.alloc(16);
  dir2[0] = 0; // 256
  dir2[1] = 0;
  dir2.writeUInt16LE(1, 4);
  dir2.writeUInt16LE(32, 6);
  dir2.writeUInt32LE(png256.length, 8);
  dir2.writeUInt32LE(6 + 32 + png32.length, 12);

  return Buffer.concat([header, dir1, dir2, png32, png256]);
}

const p32 = renderNovaPng(32);
const p128 = renderNovaPng(128);
const p256 = renderNovaPng(256);

fs.writeFileSync(path.join(outDir, "32x32.png"), p32);
fs.writeFileSync(path.join(outDir, "128x128.png"), p128);
fs.writeFileSync(path.join(outDir, "128x128@2x.png"), p256);
fs.writeFileSync(path.join(outDir, "icon.png"), p256);
fs.writeFileSync(path.join(outDir, "icon.ico"), buildIco(p32, p256));
console.log("Generated NOVA procedural icons in src-tauri/icons/");
