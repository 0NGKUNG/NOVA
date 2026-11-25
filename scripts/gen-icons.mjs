// Procedural NOVA Mascot App Icon Generator (pure Node.js, zero external dependencies)
// Renders the finalized circular NOVA mascot with violet orbital ring (16x 4x4 SSAA):
// - Circular silhouette (no squircle box) with dark obsidian inner disc behind core/ring gap
// - Violet (#a78bfa) ambient aura & sleek circular orbital ring
// - Solid purple (#a78bfa) core
// - Coucou-style 3D spherical rounded-pill eyes
// - Lower-right orbiting white moon with violet-white lunar glow (clean on dark & light taskbars)
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const tauriIconsDir = path.resolve("src-tauri/icons");
const publicDir = path.resolve("public");
fs.mkdirSync(tauriIconsDir, { recursive: true });
fs.mkdirSync(publicDir, { recursive: true });

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

// Premultiplied Porter-Duff source-over helper
function over(dst, sr, sg, sb, sa) {
  if (sa <= 0) return;
  const inv = 1 - sa;
  dst[0] = sr * sa + dst[0] * inv;
  dst[1] = sg * sa + dst[1] * inv;
  dst[2] = sb * sa + dst[2] * inv;
  dst[3] = sa + dst[3] * inv;
}

function encodePng(size, raw) {
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

function renderNovaMascotPng(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const cx = (size - 1) * 0.5;
  const cy = (size - 1) * 0.5;

  // Circular mascot geometry matching NovaOrb.tsx proportions
  const orbSize = size * 0.98;
  const baseR = orbSize * 0.34;
  const haloInnerR = baseR * 0.15;
  const haloOuterR = size * 0.5;
  const ringRadius = baseR * 1.17;
  const ringHalfStroke = Math.max(
    size <= 24 ? 0.58 : size <= 32 ? 0.66 : 0.45,
    orbSize * 0.033 * 0.5
  );
  const coreR = baseR * 0.94;

  // Coucou spherical eye constants from NovaOrb.tsx
  const EYE_SP = 0.34;
  const EYE_P = 0.06;
  const eyeW = Math.max(size <= 24 ? 1.45 : 0, orbSize * 0.078);
  const eyeH = Math.max(size <= 24 ? 3.05 : 0, orbSize * 0.168);
  const pillR = Math.min(eyeW * 0.5, eyeH * 0.5);
  const pillHalfW = eyeW * 0.5 - pillR;
  const pillHalfH = eyeH * 0.5 - pillR;

  const cp = Math.cos(EYE_P);
  const eyes = [-1, 1].map((sd) => {
    const eyeYaw = sd * EYE_SP;
    return {
      ex: cx + Math.sin(eyeYaw) * cp * (coreR * 0.86),
      ey: cy - Math.sin(EYE_P) * (coreR * 0.84),
      fx: Math.max(0.24, Math.cos(eyeYaw)),
      fy: Math.max(0.28, cp),
    };
  });

  // Orbiting moon at lower-right (~4 o'clock) along the violet orbital ring
  const moonAngle = 0.58;
  const moonX = cx + Math.cos(moonAngle) * ringRadius;
  const moonY = cy + Math.sin(moonAngle) * ringRadius;
  const moonCoreR = Math.max(size <= 24 ? 0.85 : 0, orbSize * 0.043);
  const moonBloomR = Math.max(size <= 24 ? 1.35 : 0, orbSize * 0.072);
  const moonAuraR = Math.max(size <= 24 ? 1.95 : 0, orbSize * 0.108);

  // Violet aura & Purple core RGB (#a78bfa -> 167, 139, 250)
  const [pr, pg, pb] = [167, 139, 250];

  const subOffsets = [-0.375, -0.125, 0.125, 0.375];
  const sample = [0, 0, 0, 0];

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // PNG filter type 0 (None)

    for (let x = 0; x < size; x++) {
      let accR = 0;
      let accG = 0;
      let accB = 0;
      let accA = 0;

      for (let syi = 0; syi < 4; syi++) {
        const sy = y + subOffsets[syi];
        const dy = sy - cy;

        for (let sxi = 0; sxi < 4; sxi++) {
          const sx = x + subOffsets[sxi];
          const dx = sx - cx;
          const dist = Math.hypot(dx, dy);

          sample[0] = 0;
          sample[1] = 0;
          sample[2] = 0;
          sample[3] = 0;

          // 1. Soft ambient violet aura glow (space between core and ring stays transparent)
          if (dist < haloOuterR) {
            const t = Math.max(0, (dist - haloInnerR) / (haloOuterR - haloInnerR));
            const haloAlpha =
              t <= 0.65
                ? 0.18 + (0.04 - 0.18) * (t / 0.65)
                : 0.04 * Math.max(0, 1 - (t - 0.65) / 0.35);
            over(sample, pr, pg, pb, haloAlpha);
          }

          // 2. Sleek violet circular orbital ring
          if (Math.abs(dist - ringRadius) <= ringHalfStroke) {
            over(sample, pr, pg, pb, 0.68);
          }

          // 4. Solid purple core (#a78bfa) + clipped 3D spherical eyes
          if (dist <= coreR) {
            over(sample, pr, pg, pb, 1.0);

            for (let ei = 0; ei < 2; ei++) {
              const e = eyes[ei];
              const lx = (sx - e.ex) / e.fx;
              const ly = (sy - e.ey) / e.fy;
              const qx = Math.abs(lx) - pillHalfW;
              const qy = Math.abs(ly) - pillHalfH;
              const sdf =
                Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
                Math.min(Math.max(qx, qy), 0) -
                pillR;
              if (sdf <= 0) {
                over(sample, 3, 5, 12, 0.94);
              }
            }
          }

          // 5. Orbiting white moon with violet-framed lunar glow so it reads cleanly
          //    against both dark surfaces and pure-white backgrounds
          const moonDist = Math.hypot(sx - moonX, sy - moonY);
          if (moonDist < moonAuraR) {
            const at = Math.max(0, (moonDist - moonCoreR * 0.7) / (moonAuraR - moonCoreR * 0.7));
            over(sample, 139, 92, 246, 0.55 * Math.pow(1 - at, 1.8));
          }
          if (moonDist < moonBloomR) {
            const bt = Math.max(0, (moonDist - moonCoreR * 0.8) / (moonBloomR - moonCoreR * 0.8));
            over(sample, 255, 255, 255, 0.5 * Math.pow(1 - bt, 2.0));
          }
          if (moonDist <= moonCoreR) {
            over(sample, 255, 255, 255, 0.99);
          }

          accR += sample[0];
          accG += sample[1];
          accB += sample[2];
          accA += sample[3];
        }
      }

      const px = rowStart + 1 + x * 4;
      if (accA <= 0.0005) {
        raw[px] = 0;
        raw[px + 1] = 0;
        raw[px + 2] = 0;
        raw[px + 3] = 0;
      } else {
        // Un-premultiply averaged RGBA
        raw[px] = Math.min(255, Math.max(0, Math.round(accR / accA)));
        raw[px + 1] = Math.min(255, Math.max(0, Math.round(accG / accA)));
        raw[px + 2] = Math.min(255, Math.max(0, Math.round(accB / accA)));
        raw[px + 3] = Math.min(255, Math.max(0, Math.round((accA / 16) * 255)));
      }
    }
  }

  return encodePng(size, raw);
}

function buildMultiResIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // Type 1 = ICO
  header.writeUInt16LE(count, 4);

  const dirs = [];
  let offset = 6 + count * 16;

  for (const { size, png } of entries) {
    const dir = Buffer.alloc(16);
    dir[0] = size >= 256 ? 0 : size;
    dir[1] = size >= 256 ? 0 : size;
    dir[2] = 0;
    dir[3] = 0;
    dir.writeUInt16LE(1, 4); // color planes
    dir.writeUInt16LE(32, 6); // bits per pixel
    dir.writeUInt32LE(png.length, 8);
    dir.writeUInt32LE(offset, 12);
    dirs.push(dir);
    offset += png.length;
  }

  return Buffer.concat([header, ...dirs, ...entries.map((e) => e.png)]);
}

const p16 = renderNovaMascotPng(16);
const p24 = renderNovaMascotPng(24);
const p32 = renderNovaMascotPng(32);
const p48 = renderNovaMascotPng(48);
const p64 = renderNovaMascotPng(64);
const p128 = renderNovaMascotPng(128);
const p256 = renderNovaMascotPng(256);
const p512 = renderNovaMascotPng(512);

// Tauri desktop bundle & window/tray icons
fs.writeFileSync(path.join(tauriIconsDir, "32x32.png"), p32);
fs.writeFileSync(path.join(tauriIconsDir, "128x128.png"), p128);
fs.writeFileSync(path.join(tauriIconsDir, "128x128@2x.png"), p256);
fs.writeFileSync(path.join(tauriIconsDir, "icon.png"), p512);
fs.writeFileSync(
  path.join(tauriIconsDir, "icon.ico"),
  buildMultiResIco([
    { size: 16, png: p16 },
    { size: 24, png: p24 },
    { size: 32, png: p32 },
    { size: 48, png: p48 },
    { size: 64, png: p64 },
    { size: 256, png: p256 },
  ])
);

// Web / Mobile PWA favicons
fs.writeFileSync(path.join(publicDir, "favicon.png"), p64);
fs.writeFileSync(path.join(publicDir, "icon-192.png"), renderNovaMascotPng(192));
fs.writeFileSync(path.join(publicDir, "icon-512.png"), p512);

console.log("Generated circular violet-ring NOVA mascot icons in src-tauri/icons/ and public/");
