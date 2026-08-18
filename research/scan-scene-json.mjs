// 扫描全部 scene.pkg 内 scene.json 的结构差异（研究用）：
// 统计 objects 的引用类型分布（particle/image/model/shader/无引用），
// 帮助定位"读取 SCENE 文件有问题"发生在哪一层。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';
const dirs = readdirSync(WALLPAPER_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

const refFiles = {}; // 引用文件 -> 次数
let totalObjects = 0;
const samples = [];

for (const id of dirs) {
  const pkgPath = join(WALLPAPER_DIR, id, 'scene.pkg');
  if (!existsSync(pkgPath)) continue;
  const buf = readFileSync(pkgPath);
  const magic = buf.toString('ascii', 4, 12);
  // 解析条目表
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
  try { root = JSON.parse(buf.toString('utf8', abs, abs + sc.size)); } catch (e) { console.log(`[${id}] scene.json 解析失败: ${e.message}`); continue; }

  const objects = Array.isArray(root.objects) ? root.objects : [];
  totalObjects += objects.length;
  const local = {};
  const objTypes = {};
  for (const o of objects) {
    // WE 对象字段：particle / image / model / shader（引用相对路径）；无引用对象仅有 transform
    let k = 'none';
    if (typeof o.particle === 'string' && o.particle) { k = 'particle'; refFiles[o.particle] = (refFiles[o.particle] ?? 0) + 1; }
    else if (typeof o.image === 'string' && o.image) { k = 'image'; refFiles[o.image] = (refFiles[o.image] ?? 0) + 1; }
    else if (typeof o.model === 'string' && o.model) { k = 'model'; refFiles[o.model] = (refFiles[o.model] ?? 0) + 1; }
    else if (typeof o.shader === 'string' && o.shader) { k = 'shader'; }
    objTypes[k] = (objTypes[k] ?? 0) + 1;
  }
  const keys = Object.keys(objTypes).sort().map(k => `${k}×${objTypes[k]}`);
  const line = `[${id}] ${magic}  objects=${objects.length}  ${keys.join(' ')}`;
  console.log(line);
  samples.push(line);
}

console.log('\n=== 汇总 ===');
console.log(`对象总数: ${totalObjects}`);
console.log('引用文件 Top:');
Object.entries(refFiles).sort((a, b) => b[1] - a[1]).slice(0, 15)
  .forEach(([f, n]) => console.log(`  ${String(n).padStart(3)}  ${f}`));
