// 查看包含 models/util 引用对象的原始字段（研究用）：
// 确认 WE 场景对象引用 models/*.json 时用的字段名（model? image? 其他）
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';
const dirs = readdirSync(WALLPAPER_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

for (const id of dirs) {
  const pkgPath = join(WALLPAPER_DIR, id, 'scene.pkg');
  if (!existsSync(pkgPath)) continue;
  const buf = readFileSync(pkgPath);
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
  const sc = entries.find(e => e.name.endsWith('scene.json'));
  if (!sc) continue;
  const abs = dataStart + sc.off;
  let root;
  try { root = JSON.parse(buf.toString('utf8', abs, abs + sc.size)); } catch { continue; }
  const objects = Array.isArray(root.objects) ? root.objects : [];
  const hits = objects.filter(o => JSON.stringify(o).includes('models/util'));
  for (const o of hits) {
    const keys = Object.keys(o).filter(k => typeof o[k] === 'string' && /\.(json|tex|png)$/i.test(o[k]));
    console.log(`[${id}]`, JSON.stringify({ id: o.id, name: o.name, refs: Object.fromEntries(keys.map(k => [k, o[k]])) }));
  }
}
