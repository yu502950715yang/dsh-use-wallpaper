// 研究：全库 24 个 scene 壁纸的对象构成分类（评估两条路线工作量）
// 分类维度：image 对象数 / particle 对象数 / effects 链数 / text 对象数 / util 数
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
const json = (f, n) => { if (!f.has(n)) return null; try { return JSON.parse(Buffer.from(f.get(n)).toString('utf8')); } catch { return null; } };

const rows = [];
for (const id of readdirSync(WALLPAPER_DIR)) {
  const pkgPath = join(WALLPAPER_DIR, id, 'scene.pkg');
  if (!existsSync(pkgPath)) continue;
  const files = unpack(id);
  const scene = json(files, 'scene.json');
  if (!scene) continue;
  let img = 0, part = 0, util = 0, text = 0, none = 0, eff = 0;
  for (const o of scene.objects ?? []) {
    const kind = o.particle ? 'particle' : o.image ? (o.image.startsWith('models/util/') ? 'util' : 'image') : (o.text || o.font ? 'text' : 'none');
    if (kind === 'image') img++;
    else if (kind === 'particle') part++;
    else if (kind === 'util') util++;
    else if (kind === 'text') text++;
    else none++;
    if (Array.isArray(o.effects)) eff += o.effects.length;
  }
  rows.push({ id, img, part, util, text, none, eff });
}

// 分类：A=纯静态图 / B=image+effects / C=image+particle / D=全部混合 / E=纯text / F=image+text
console.log('id'.padEnd(12), 'img', 'part', 'util', 'text', 'none', 'eff', '类型');
const cats = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
for (const r of rows.sort((a, b) => a.id.localeCompare(b.id))) {
  let cat;
  if (r.text && r.img === 0 && r.part === 0 && r.eff === 0) cat = 'E 纯text';
  else if (r.eff > 0 && r.part > 0) cat = 'D 混合(eff+particle)';
  else if (r.eff > 0) cat = 'B image+effects';
  else if (r.part > 0) cat = 'C image+particle';
  else if (r.text > 0) cat = 'F image+text';
  else cat = 'A 纯静态图';
  const key = cat[0];
  cats[key] = (cats[key] ?? 0) + 1;
  console.log(r.id.padEnd(12), String(r.img).padStart(3), String(r.part).padStart(4), String(r.util).padStart(4), String(r.text).padStart(4), String(r.none).padStart(4), String(r.eff).padStart(3), cat);
}
console.log('\n=== 分类汇总 ===');
for (const [k, v] of Object.entries(cats)) console.log(`  ${k}: ${v} 个`);
const totalEff = rows.reduce((s, r) => s + r.eff, 0);
const totalPart = rows.reduce((s, r) => s + r.part, 0);
console.log(`效果链总数: ${totalEff}，粒子系统总数: ${totalPart}`);
