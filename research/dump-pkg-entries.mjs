// 研究：dump 指定 pkg 的条目表 + 查看特殊对象（composelayer 等）与 tex 推导失败的细节
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';
const targets = process.argv.slice(2);
if (targets.length === 0) targets.push('2911105183', '2832263418', '2937346640', '3743126786', '3765967112', '1429403119');

for (const id of targets) {
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
  console.log(`\n========== [${id}] ${entries.length} 条目 ==========`);
  for (const e of entries) console.log(`  ${e.size.toString().padStart(9)}  ${e.name}`);
}
