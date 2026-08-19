// 全库粒子 json 的 material/operator 分布 + text 对象结构（研究用）
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
const json = (files, n) => { if (!files.has(n)) return null; try { return JSON.parse(Buffer.from(files.get(n)).toString('utf8')); } catch { return null; } };

const partFiles = new Set();
const operatorTypes = {};
let withMaterial = 0, withoutMaterial = 0;
const textObjs = [];
let totalParticles = 0;

for (const id of readdirSync(WALLPAPER_DIR)) {
  const pkgPath = join(WALLPAPER_DIR, id, 'scene.pkg');
  if (!existsSync(pkgPath)) continue;
  const files = unpack(id);
  const scene = json(files, 'scene.json');
  if (!scene) continue;
  for (const o of scene.objects ?? []) {
    // text 对象：有 text/font 字段或 name 含 Clock/Text
    const hasText = (typeof o.text === 'string' && o.text) || (typeof o.font === 'string' && o.font);
    if (hasText || /clock|text|label|time/i.test(o.name ?? '')) {
      textObjs.push({ id, oid: o.id, name: o.name, keys: Object.keys(o).filter(k => !['id','name','origin','scale','size','visible'].includes(k)), hasText, hasFont: typeof o.font === 'string' });
    }
    if (typeof o.particle === 'string' && o.particle && !partFiles.has(o.particle)) {
      partFiles.add(o.particle);
      totalParticles++;
      const spec = json(files, o.particle);
      if (!spec) continue;
      if (spec.material) withMaterial++; else withoutMaterial++;
      for (const op of spec.operator ?? []) {
        const t = op.type ?? op.name ?? '?';
        operatorTypes[t] = (operatorTypes[t] ?? 0) + 1;
      }
    }
  }
}

console.log(`粒子文件数: ${totalParticles}, 有 material: ${withMaterial}, 无 material: ${withoutMaterial}`);
console.log('operator 类型分布:', JSON.stringify(operatorTypes));
console.log(`\ntext 对象样例（前 8）:`);
for (const t of textObjs.slice(0, 8)) {
  console.log(`  [${t.id}] ${t.name} keys=${t.keys.join(',')} text=${t.hasText} font=${t.hasFont}`);
}
console.log(`text 对象总数: ${textObjs.length}`);
