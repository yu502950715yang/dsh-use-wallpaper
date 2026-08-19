// 研究：effects 挂载对象类型分布（util/image/particle/none）+ image 对象带 effects 样例
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';
const byKind = { util: 0, image: 0, particle: 0, none: 0 };
const byWallpaper = new Map();

for (const id of readdirSync(WALLPAPER_DIR)) {
  const p = join(WALLPAPER_DIR, id, 'scene.pkg');
  if (!existsSync(p)) continue;
  const buf = readFileSync(p);
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
  let total = 0;
  for (const o of scene.objects ?? []) {
    if (!Array.isArray(o.effects) || o.effects.length === 0) continue;
    let kind = 'none';
    if (typeof o.image === 'string' && o.image.startsWith('models/util/')) kind = 'util';
    else if (typeof o.image === 'string') kind = 'image';
    else if (typeof o.particle === 'string') kind = 'particle';
    byKind[kind] += o.effects.length;
    total += o.effects.length;
  }
  if (total) byWallpaper.set(id, total);
}
console.log('effects 挂载对象类型分布:', JSON.stringify(byKind));
console.log('带 effects 的壁纸数:', byWallpaper.size, [...byWallpaper.entries()].map(([k, v]) => `${k}:${v}`).join(' '));

console.log('\n--- image 对象带 effects 样例 ---');
let shown = 0;
for (const id of readdirSync(WALLPAPER_DIR)) {
  const p = join(WALLPAPER_DIR, id, 'scene.pkg');
  if (!existsSync(p)) continue;
  const buf = readFileSync(p);
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
  for (const o of scene.objects ?? []) {
    if (!Array.isArray(o.effects) || o.effects.length === 0) continue;
    if (typeof o.image !== 'string' || o.image.startsWith('models/util/')) continue;
    if (shown++ >= 8) break;
    const fx = o.effects.map((e) => e.file).join(',');
    console.log(`[${id}] name=${o.name} size=${o.size ?? '?'} image=${o.image} effects=${fx}`);
  }
  if (shown >= 8) break;
}
