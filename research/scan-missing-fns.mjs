// 全库搜索 ApplyComposite/ApplyCompositeOffset 调用签名 + 其他缺失函数（研究用）
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';

function unpack(id) {
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
  return files;
}

const targets = ['ApplyComposite', 'ApplyCompositeOffset', 'texSample2D', 'v_NoiseTexCoord', 'DitherVoxel'];
const hits = {};
for (const id of readdirSync(WALLPAPER_DIR)) {
  const pkgPath = join(WALLPAPER_DIR, id, 'scene.pkg');
  if (!existsSync(pkgPath)) continue;
  const files = unpack(id);
  for (const [name, data] of files) {
    if (!/\.(frag|vert)$/.test(name)) continue;
    const src = Buffer.from(data).toString('utf8');
    for (const t of targets) {
      if (src.includes(t)) {
        (hits[t] ??= []).push({ id, file: name });
        if (t === 'ApplyComposite' || t === 'ApplyCompositeOffset') {
          const m = src.match(new RegExp('.{0,50}' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^;]{0,150}'));
          console.log(`[${id}] ${name}: ${m ? m[0].replace(/\s+/g, ' ').trim() : ''}`);
        }
      }
    }
  }
}
console.log('\n=== 缺失函数命中分布 ===');
for (const [t, arr] of Object.entries(hits)) console.log(`${t}: ${arr.length} 处 (${[...new Set(arr.map(a => a.id))].join(',')})`);
