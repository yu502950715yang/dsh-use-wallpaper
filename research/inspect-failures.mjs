// 研究：dump 指定壁纸 scene.json 中失败对象的完整定义 + 验证 B 类 tex 修正规则
import { readFileSync } from 'node:fs';
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

// A 类：composelayer 等对象的完整定义
for (const id of ['2911105183', '1429403119', '2832263418']) {
  const files = unpack(id);
  const scene = JSON.parse(Buffer.from(files.get('scene.json')).toString('utf8'));
  console.log(`\n========== [${id}] 特殊对象定义 ==========`);
  for (const o of scene.objects ?? []) {
    const s = JSON.stringify(o);
    if (s.includes('composelayer') || s.includes('fullscreenlayer') || s.includes('projectlayer') || /global|rainbow|music bar/i.test(o.name ?? '')) {
      console.log(`\n--- id=${o.id} name=${JSON.stringify(o.name)} ---`);
      console.log(JSON.stringify(o, null, 2).slice(0, 1200));
    }
  }
}

// B 类：tex 修正规则验证（materials/ + texName）
for (const [id, modelPath, texName] of [
  ['2832263418', 'models/workshop/2077932499/Rainboww.json', 'workshop/2077932499/Rainboww'],
  ['2937346640', 'models/workshop/2652493753/bar.json', 'workshop/2652493753/bar'],
  ['3743126786', 'models/workshop/2944127259/clouds2.json', 'workshop/2944127259/clouds'],
  ['3765967112', 'models/workshop/3732231168/dayNightToggleSprite.json', 'workshop/3732231168/dayNightToggleSprite'],
]) {
  const files = unpack(id);
  const model = JSON.parse(Buffer.from(files.get(modelPath)).toString('utf8'));
  const matRef = model.material;
  const mat = JSON.parse(Buffer.from(files.get(matRef)).toString('utf8'));
  const t0 = mat.passes?.[0]?.textures?.[0];
  console.log(`\n[${id}] model=${modelPath} material=${matRef}`);
  console.log(`  textures[0]=${JSON.stringify(t0)}`);
  const cand1 = t0 + '.tex';                      // 旧规则
  const cand2 = 'materials/' + t0 + '.tex';       // 新规则
  console.log(`  旧规则候选: ${cand1} -> ${files.has(cand1) ? '存在' : '不存在'}`);
  console.log(`  新规则候选: ${cand2} -> ${files.has(cand2) ? '存在 ✓' : '不存在'}`);
  // 该 material 目录下所有文件，帮助看清规则
  const dir = matRef.slice(0, matRef.lastIndexOf('/') + 1);
  const dirFiles = [...files.keys()].filter(n => n.startsWith(dir));
  console.log(`  ${dir} 目录条目(${dirFiles.length}): ${dirFiles.join(', ')}`);
}
