// 模拟 client 端 renderScene 的资源解析链路（研究用）：
// 对全库每个 scene.pkg：解析 scene.json → 每个对象按 scene-json.ts 分类 → 
// image 对象模拟 resolveImageTexture（model json → material → passes[0].textures[0] → tex 存在性）
// particle 对象模拟 fetchParticleSpec（particles json 存在性）
// 统计：每个壁纸有多少对象能成功解析、哪些失败及原因 → 评估"能渲染的壁纸占比"
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

function json(files, name) {
  if (!files.has(name)) return null;
  try { return JSON.parse(Buffer.from(files.get(name)).toString('utf8')); } catch { return null; }
}

// 与 client resolveTexPath 相同的路径推导
function resolveTexPath(matRef, texName) {
  return texName.includes('/')
    ? 'materials/' + texName + '.tex'
    : matRef.slice(0, matRef.lastIndexOf('/') + 1) + texName + '.tex';
}

const results = [];
let totalObj = 0, okObj = 0;
let imgTotal = 0, imgOk = 0, partTotal = 0, partOk = 0;

for (const id of readdirSync(WALLPAPER_DIR)) {
  const pkgPath = join(WALLPAPER_DIR, id, 'scene.pkg');
  if (!existsSync(pkgPath)) continue;
  const files = unpack(id);
  const scene = json(files, 'scene.json');
  if (!scene) { results.push(`[${id}] scene.json 解析失败`); continue; }

  const rows = [];
  let ok = 0;
  for (const o of scene.objects ?? []) {
    let kind = 'none';
    if (typeof o.particle === 'string' && o.particle) kind = 'particle';
    else if (typeof o.image === 'string' && o.image) kind = o.image.startsWith('models/util/') ? 'util' : 'image';

    if (kind === 'image') {
      imgTotal++;
      totalObj++;
      const model = json(files, o.image);
      if (!model) { rows.push(`image ${o.image} → model 缺失/非JSON`); continue; }
      const matRef = model.material;
      if (typeof matRef !== 'string' || !matRef) { rows.push(`image ${o.image} → 无 material`); continue; }
      const mat = json(files, matRef);
      if (!mat) { rows.push(`image ${o.image} → material ${matRef} 缺失`); continue; }
      const texName = mat?.passes?.[0]?.textures?.[0];
      if (typeof texName !== 'string' || !texName) { rows.push(`image ${o.image} → material 无 textures[0]`); continue; }
      const texPath = resolveTexPath(matRef, texName);
      if (!files.has(texPath)) {
        // 尝试直接 texName.tex（部分布局 tex 与材质同目录但 texture 槽是名字）
        const alt = matRef.slice(0, matRef.lastIndexOf('/') + 1) + texName + '.tex';
        if (!files.has(alt)) { rows.push(`image ${o.image} → tex ${texPath} 缺失（alt ${alt} 也缺失）`); continue; }
        rows.push(`image ${o.image} → tex alt ${alt} 命中`); ok++; imgOk++; continue;
      }
      rows.push(`image ${o.image} → tex ${texPath} 命中`); ok++; imgOk++; continue;
    }
    if (kind === 'particle') {
      partTotal++;
      totalObj++;
      const spec = json(files, o.particle);
      if (!spec) { rows.push(`particle ${o.particle} → spec 缺失`); continue; }
      rows.push(`particle ${o.particle} → spec 命中`); ok++; partOk++; continue;
    }
    if (kind === 'util') {
      totalObj++;
      rows.push(`util ${o.image} → 跳过(不渲染)`);
      continue;
    }
    if (kind === 'none') {
      totalObj++;
      rows.push(`none → 不渲染`);
    }
  }
  results.push(`[${id}] objects=${scene.objects?.length ?? 0} 可渲染对象=${ok}${rows.length ? '\n    ' + rows.join('\n    ') : ''}`);
}

console.log(results.join('\n'));
console.log(`\n=== 汇总 ===`);
console.log(`对象总数: ${totalObj}，可渲染: ${okObj}，不可渲染: ${totalObj - okObj}`);
console.log(`image 对象: ${imgTotal}，可渲染: ${imgOk}`);
console.log(`particle 对象: ${partTotal}，可渲染: ${partOk}`);
