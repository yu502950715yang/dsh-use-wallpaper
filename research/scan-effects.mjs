// 研究：统计全库 util 对象（composelayer 等）的 effects 链引用 → 确定二期效果渲染范围
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';
const dirs = readdirSync(WALLPAPER_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory()).map(d => d.name);

const effectRefs = new Map(); // effect.json 路径 -> {壁纸数, 引用次数}
const byWallpaper = new Map(); // id -> effect 列表

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
  const files = new Map();
  for (const e of entries) files.set(e.name, buf.subarray(dataStart + e.off, dataStart + e.off + e.size));
  const scRaw = files.get('scene.json');
  if (!scRaw) continue;
  let scene;
  try { scene = JSON.parse(Buffer.from(scRaw).toString('utf8')); } catch { continue; }
  const list = [];
  for (const o of scene.objects ?? []) {
    if (Array.isArray(o.effects)) {
      for (const fx of o.effects) {
        if (typeof fx.file === 'string') {
          list.push(fx.file);
          const rec = effectRefs.get(fx.file) ?? { wallpapers: new Set(), count: 0 };
          rec.wallpapers.add(id);
          rec.count++;
          effectRefs.set(fx.file, rec);
        }
      }
    }
  }
  if (list.length) byWallpaper.set(id, list);
}

console.log('=== 全库 effects 引用统计 ===');
const sorted = [...effectRefs.entries()].sort((a, b) => b[1].count - a[1].count);
for (const [file, rec] of sorted) {
  console.log(`${String(rec.count).padStart(3)} 次  ${String(rec.wallpapers.size).padStart(2)} 壁纸  ${file}`);
}
console.log('\n=== 各壁纸 effects 列表 ===');
for (const [id, list] of byWallpaper) {
  console.log(`[${id}] ${list.join(', ')}`);
}
