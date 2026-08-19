// 查看壁纸 scene.json 的 camera/general/正交配置（研究用）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';
const id = process.argv[2] ?? '2911105183';

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
const sc = entries.find(e => e.name === 'scene.json');
const raw = buf.subarray(dataStart + sc.off, dataStart + sc.off + sc.size);
const scene = JSON.parse(Buffer.from(raw).toString('utf8'));
console.log(JSON.stringify({ camera: scene.camera, general: scene.general }, null, 2).slice(0, 2000));
console.log('\n--- 前 6 对象 ---');
for (const o of (scene.objects ?? []).slice(0, 6)) {
  console.log(JSON.stringify({ id: o.id, name: o.name, origin: o.origin, scale: o.scale, size: o.size, z: o.z }, null, 1));
}
