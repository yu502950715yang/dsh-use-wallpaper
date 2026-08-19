// 研究：扫描 include common_composite.h 的 shader，确认 ApplyComposite/ApplyCompositeOffset
// 调用点与所属壁纸/效果链（决定 we-headers A4 补全的必要性与范围）
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';

for (const id of readdirSync(WALLPAPER_DIR)) {
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
  for (const e of entries) {
    if (!e.name.startsWith('shaders/') || !/\.(frag|vert)$/.test(e.name)) continue;
    const text = Buffer.from(buf.subarray(dataStart + e.off, dataStart + e.off + e.size)).toString('utf8');
    if (text.includes('common_composite.h')) {
      const ac = (text.match(/ApplyComposite\b/g) || []).length;
      const aco = (text.match(/ApplyCompositeOffset\b/g) || []).length;
      console.log(`[${id}] ${e.name} | ApplyComposite=${ac} ApplyCompositeOffset=${aco}`);
      if (ac + aco > 0) {
        for (const line of text.split('\n')) {
          if (/ApplyComposite/.test(line)) console.log('    ' + line.trim().slice(0, 160));
        }
      }
    }
  }
}
