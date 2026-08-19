// 研究：逐「对象×效果链引用」排查解析失败（scene.json 的 pass 覆写导致）
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

// 与 resolveEffectChain 相同的判定
function chainFails(id, files, fx) {
  const file = fx.file;
  const effect = json(files, file);
  if (!effect) return `effect.json 不存在: ${file}`;
  const passes = Array.isArray(effect.passes) ? effect.passes : [];
  if (passes.length === 0) return `passes 为空: ${file}`;
  const scenePasses = Array.isArray(fx.passes) ? fx.passes : [];
  let skippedAll = true;
  for (let i = 0; i < passes.length; i++) {
    const matRef = scenePasses[i]?.material ?? passes[i].material;
    if (typeof matRef !== 'string') return `pass${i} matRef 非字符串`;
    if (matRef.startsWith('materials/util/')) continue; // 引擎内置 pass，跳过
    skippedAll = false;
    if (!files.has(matRef)) return `pass${i} material 缺失: ${matRef}`;
    const mat = json(files, matRef);
    const shaderName = mat?.passes?.[0]?.shader;
    if (typeof shaderName !== 'string') return `pass${i} 无 shader: ${matRef}`;
    if (!files.has(`shaders/${shaderName}.vert`) || !files.has(`shaders/${shaderName}.frag`))
      return `pass${i} shader 缺失: ${shaderName}`;
  }
  if (skippedAll) return `全部 pass 为 util 材质（无真实 pass）`;
  return null;
}

// 7 个"浏览器报失败"的壁纸，全量检查其所有效果链引用
const TARGETS = ['1429403119', '2011060960', '2597392171', '2897292240', '2911105183', '3743126786', '3765967112'];
for (const id of TARGETS) {
  const files = unpack(id);
  const scene = json(files, 'scene.json');
  if (!scene) continue;
  console.log(`\n=== [${id}] ===`);
  let failCount = 0;
  for (const o of scene.objects ?? []) {
    for (const fx of Array.isArray(o.effects) ? o.effects : []) {
      if (typeof fx.file !== 'string') continue;
      const reason = chainFails(id, files, fx);
      if (reason) {
        failCount++;
        console.log(`  ❌ 对象 "${o.name}" → ${fx.file}: ${reason}`);
      }
    }
  }
  if (failCount === 0) console.log('  ✓ 所有效果链引用文件层正常（失败原因在别处）');
  else console.log(`  → 共 ${failCount} 条引用文件层失败`);
}
