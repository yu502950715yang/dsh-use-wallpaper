// 检查指定壁纸的 image 对象材质链（研究用）
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
const files = new Map();
for (const e of entries) files.set(e.name, buf.subarray(dataStart + e.off, dataStart + e.off + e.size));
const json = (n) => { if (!files.has(n)) return null; try { return JSON.parse(Buffer.from(files.get(n)).toString('utf8')); } catch { return null; } };

const scene = json('scene.json');
console.log(`[${id}] objects=${scene.objects.length}`);
for (const o of scene.objects) {
  if (typeof o.image !== 'string' || !o.image || o.image.startsWith('models/util/')) continue;
  const model = json(o.image);
  if (!model) { console.log(`  ${o.name}: model ${o.image} 缺失`); continue; }
  const matRef = model.material;
  const mat = typeof matRef === 'string' ? json(matRef) : null;
  const passes = mat?.passes ?? [];
  const tex0 = passes[0]?.textures?.[0];
  const blend = passes[0]?.blendmode;
  const shaders = passes.map(p => p.shader ?? '').filter(Boolean);
  const texs = passes.map(p => p.textures ?? []).flat().join(',');
  console.log(`  ${o.name} | size=${o.size ?? '?'} | tex0=${tex0} | blend=${blend} | shader=[${shaders.join(',')}] | texs=${texs}`);
}
