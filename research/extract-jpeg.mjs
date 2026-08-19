// 从 tex 容器提取内嵌 JPEG 并保存（研究用，验证数据有效性）
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';
const id = process.argv[2] ?? '2911105183';
const texName = process.argv[3] ?? 'materials/102107202_p0.tex';
const outFile = process.argv[4] ?? 'research/tmp-extract.jpg';

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
if (!e) { console.log('no entry'); process.exit(1); }
const t = buf.subarray(dataStart + e.off, dataStart + e.off + e.size);
// TEXB0003: magic18 + header28 + container9 + imageCount4 + imageFormat4 + mipCount4 + mip record 20
let p = 55;
const imageCount = t.readInt32LE(p); p += 4;
const imageFormat = t.readInt32LE(p); p += 4; // FIF.JPEG=2
const mipCount = t.readInt32LE(p); p += 4;
for (let m = 0; m < mipCount; m++) {
  const mw = t.readInt32LE(p), mh = t.readInt32LE(p + 4);
  const isLZ4 = t.readInt32LE(p + 8);
  const dec = t.readInt32LE(p + 12);
  const len = t.readInt32LE(p + 16);
  p += 20;
  if (m === 0) {
    const jpeg = t.subarray(p, p + len);
    writeFileSync(outFile, jpeg);
    console.log(`imageCount=${imageCount} imageFormat=${imageFormat} mip0=${mw}x${mh} isLZ4=${isLZ4} len=${len}`);
    console.log(`JPEG magic: ${jpeg[0].toString(16)} ${jpeg[1].toString(16)} (应 ff d8)`);
    console.log(`已保存: ${outFile} (${len} bytes)`);
  }
  p += len;
}
