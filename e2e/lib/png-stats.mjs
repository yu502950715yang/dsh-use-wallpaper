// 极简 PNG 解码（node:zlib inflate + unfilter，仅 8-bit 非隔行 RGB/RGBA/灰度）+
// 绿色光点像素统计。research 临时脚本，不入库。
// 用法：node research/png-stats.mjs <file.png> [--green|--bright]
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('仅支持 8-bit，实际 ' + bitDepth);
  if (interlace !== 0) throw new Error('不支持隔行 PNG');
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!ch) throw new Error('不支持 colorType ' + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = Buffer.alloc(stride * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
  }
  return { width, height, channels: ch, data: out };
}

// 绿色光点判据（Fireflies colorrandom = (0,128..255,0)，additive 叠加在暗背景上）
export function greenStats(img) {
  const { width, height, channels: ch, data } = img;
  let n = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, sx = 0, sy = 0, bright = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * ch;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      if (r + g + b > 300) bright++;
      if (g > 60 && g > r * 1.6 + 20 && g > b * 1.6 + 20) {
        n++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        sx += x; sy += y;
      }
    }
  }
  const round = (v) => Math.round(v * 10000) / 10000;
  return {
    size: [width, height],
    greenPixels: n,
    greenBBox: n
      ? { x0: round(minX / width), x1: round(maxX / width), y0: round(minY / height), y1: round(maxY / height),
          w: round((maxX - minX + 1) / width), h: round((maxY - minY + 1) / height) }
      : null,
    greenCentroid: n ? { x: round(sx / n / width), y: round(sy / n / height) } : null,
    brightPixels: bright,
  };
}

if (process.argv[1] && process.argv[1].endsWith('png-stats.mjs') && process.argv[2]) {
  const img = decodePng(readFileSync(process.argv[2]));
  console.log(JSON.stringify(greenStats(img), null, 1));
}
