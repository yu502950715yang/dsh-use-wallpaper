// 检查指定壁纸 tex 的容器版本与 imageFormat（研究用）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';
const id = process.argv[2] ?? '2911105183';
const texName = process.argv[3] ?? 'materials/102107202_p0.tex';

const buf = readFileSync(join(WALLPAPER_DIR, id, 'scene.pkg'));
const entries = [];
let pos = 16, dataStart = -1;
while (pos + 8 <= buf.length) {
  const nameLen = buf.readUInt32LE(pos);
  if (nameLen <= 0 || nameLen > 1024) { dataStart = pos; break; }
  const nameStart = pos + 4;
  const name = buf.toString('utf8', nameStart, nameStart + nameLen);
  const off = buf.readUInt32LE(nameStart + nameLen);
  const size = buf.readUInt32LE(nameStart + nameLen + 4);
  entries.push({ name, off, size });
  pos = nameStart + nameLen + 8;
}
const e = entries.find(x => x.name === texName);
if (!e) { console.log('no entry', texName); process.exit(0); }
const t = buf.subarray(dataStart + e.off, dataStart + e.off + e.size);
const ascii = (p, n) => Buffer.from(t.subarray(p, p + n)).toString('ascii');
console.log(`magic: ${ascii(0, 9)} ${ascii(9, 9)}`);
console.log(`format=${t.readInt32LE(18)} flags=${t.readInt32LE(22)} texW=${t.readInt32LE(26)} texH=${t.readInt32LE(30)} imgW=${t.readInt32LE(34)} imgH=${t.readInt32LE(38)}`);
const container = ascii(46, 9);
console.log(`container: ${container}`);
let p = 55;
const imageCount = t.readInt32LE(p); p += 4;
console.log(`imageCount=${imageCount}`);
if (container === 'TEXB0003\0' || container === 'TEXB0004\0') {
  const imageFormat = t.readInt32LE(p); p += 4;
  console.log(`imageFormat(FIF)=${imageFormat} (JPEG=2 PNG=13 WEBP=21)`);
  if (container === 'TEXB0004\0') { p += 4; }
}
const mipCount = t.readInt32LE(p); p += 4;
console.log(`mipCount=${mipCount}`);
const v2 = container === 'TEXB0002\0';
const v3 = container === 'TEXB0003\0' || container === 'TEXB0004\0';
for (let m = 0; m < Math.min(mipCount, 8); m++) {
  const mw = t.readInt32LE(p), mh = t.readInt32LE(p + 4);
  const isLZ4 = (v2 || v3) ? t.readInt32LE(p + 8) : 0;
  const dec = (v2 || v3) ? t.readInt32LE(p + 12) : 0;
  const len = (v2 || v3) ? t.readInt32LE(p + 16) : t.readInt32LE(p + 8);
  console.log(`  mip[${m}]: ${mw}x${mh} isLZ4=${isLZ4} decompressed=${dec} bytes=${len}`);
  p += (v2 || v3) ? 20 : 12;
  p += len;
}
