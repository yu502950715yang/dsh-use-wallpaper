// 研究：dump 2911105183 壁纸的 effects 系统数据结构（effect.json / shader / 相关 json）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';
const id = '2911105183';
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
const files = new Map();
for (const e of entries) files.set(e.name, buf.subarray(dataStart + e.off, dataStart + e.off + e.size));

const targets = process.argv.slice(2);
for (const t of targets.length ? targets : [
  'effects/waterwaves/effect.json',
  'effects/scroll/effect.json',
  'shaders/effects/waterwaves.frag',
  'shaders/effects/waterwaves.vert',
  'materials/effects/waterwaves.json',
  'effects/workshop/2084198056/Simple_Audio_Bars/effect.json',
]) {
  const raw = files.get(t);
  console.log(`\n========== ${t} (${raw?.length ?? '?'}B) ==========`);
  if (!raw) { console.log('  不存在'); continue; }
  const text = Buffer.from(raw).toString('utf8');
  console.log(text.length > 2500 ? text.slice(0, 2500) + '\n...' : text);
}
