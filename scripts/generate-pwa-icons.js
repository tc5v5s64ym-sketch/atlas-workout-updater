#!/usr/bin/env node
/**
 * Generates the PWA icons (public/icons/icon-192.png, icon-512.png) without
 * any image dependencies: rasterizes a barbell glyph on a rounded blue square
 * and encodes the PNG by hand (zlib deflate + manual chunk CRCs).
 *
 * Run once and commit the output: node scripts/generate-pwa-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // compression, filter, interlace all 0

  // Each scanline is prefixed with filter type 0 (None)
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const BG = [0x25, 0x63, 0xeb]; // --accent blue
const FG = [0xff, 0xff, 0xff];

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const cornerRadius = size * 0.18;

  // Barbell geometry, relative to icon size
  const bar = { x0: 0.13, x1: 0.87, y0: 0.465, y1: 0.535 };
  const innerPlate = { y0: 0.28, y1: 0.72, halfW: 0.035, cxL: 0.305, cxR: 0.695 };
  const outerPlate = { y0: 0.35, y1: 0.65, halfW: 0.03, cxL: 0.205, cxR: 0.795 };

  const inRect = (px, py, x0, x1, y0, y1) => px >= x0 && px <= x1 && py >= y0 && py <= y1;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;

      // Rounded-corner alpha mask
      let alpha = 255;
      const cx = x < cornerRadius ? cornerRadius : x > size - cornerRadius ? size - cornerRadius : null;
      const cy = y < cornerRadius ? cornerRadius : y > size - cornerRadius ? size - cornerRadius : null;
      if (cx !== null && cy !== null) {
        const dist = Math.hypot(x - cx, y - cy);
        if (dist > cornerRadius) alpha = 0;
        else if (dist > cornerRadius - 1.5) alpha = Math.round(255 * (cornerRadius - dist) / 1.5);
      }

      const px = x / size;
      const py = y / size;
      const isGlyph =
        inRect(px, py, bar.x0, bar.x1, bar.y0, bar.y1) ||
        inRect(px, py, innerPlate.cxL - innerPlate.halfW, innerPlate.cxL + innerPlate.halfW, innerPlate.y0, innerPlate.y1) ||
        inRect(px, py, innerPlate.cxR - innerPlate.halfW, innerPlate.cxR + innerPlate.halfW, innerPlate.y0, innerPlate.y1) ||
        inRect(px, py, outerPlate.cxL - outerPlate.halfW, outerPlate.cxL + outerPlate.halfW, outerPlate.y0, outerPlate.y1) ||
        inRect(px, py, outerPlate.cxR - outerPlate.halfW, outerPlate.cxR + outerPlate.halfW, outerPlate.y0, outerPlate.y1);

      const color = isGlyph ? FG : BG;
      rgba[offset] = color[0];
      rgba[offset + 1] = color[1];
      rgba[offset + 2] = color[2];
      rgba[offset + 3] = alpha;
    }
  }

  return encodePng(size, size, rgba);
}

function main() {
  const outDir = path.join(__dirname, '..', 'public', 'icons');
  fs.mkdirSync(outDir, { recursive: true });
  for (const size of [192, 512]) {
    const file = path.join(outDir, `icon-${size}.png`);
    fs.writeFileSync(file, renderIcon(size));
    console.log(`Wrote ${file}`);
  }
}

if (require.main === module) main();

module.exports = { crc32, encodePng, renderIcon };
