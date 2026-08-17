// 批量扫描所有 scene.pkg 内部文件类型（研究用）
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';
const dirs = readdirSync(WALLPAPER_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

let total = 0;
const summary = [];
for (const id of dirs) {
  const dir = join(WALLPAPER_DIR, id);
  const pkgPath = join(dir, 'scene.pkg');
  if (!existsSync(pkgPath)) continue;
  const buf = readFileSync(pkgPath);
  // 解析
  const entries = [];
  let pos = 16;
  let tableEnd = -1;
  while (pos + 8 <= buf.length) {
    const nameLen = buf.readUInt32LE(pos);
    if (nameLen <= 0 || nameLen > 1024) { tableEnd = pos; break; }
    const nameStart = pos + 4;
    const name = buf.toString('utf8', nameStart, nameStart + nameLen);
    const off = buf.readUInt32LE(nameStart + nameLen);
    const size = buf.readUInt32LE(nameStart + nameLen + 4);
    entries.push({ name, off, size });
    pos = nameStart + nameLen + 8;
    if (entries.length > 10000) break;
  }
  const dataStart = tableEnd < 0 ? pos : tableEnd;
  const ext = {};
  const videos = [];
  for (const e of entries) {
    const m = e.name.match(/\.([a-z0-9]+)$/i);
    const k = m ? m[1].toLowerCase() : '(none)';
    ext[k] = 1 + (ext[k] ?? 0);
    if (['mp4', 'webm', 'mov', 'avi', 'wmv', 'm4v'].includes(k)) {
      const abs = dataStart + e.off;
      videos.push({ name: e.name, size: e.size, abs });
    }
  }
  const order = Object.entries(ext).sort((a, b) => b[1] - a[1]);
  const line = `[${id}] ${buf.length} bytes | ${order.map(([k, v]) => `${k}×${v}`).join(' ')}` + (videos.length ? ` | 视频素材: ${videos.map(v => `${v.name}(${v.size})`).join(', ')}` : '');
  console.log(line);
  summary.push({ id, size: buf.length, ext, videos });
  total++;
}
console.log(`\n共 ${total} 个 scene.pkg`);
