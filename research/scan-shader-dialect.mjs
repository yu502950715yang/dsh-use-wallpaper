// 研究：扫描全库 shader 的方言特征 —— include 文件、combo 宏、内置标识符、uniform 参数映射
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';
const dirs = readdirSync(WALLPAPER_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory()).map(d => d.name);

const includes = new Map();      // include 名 -> 次数
const combos = new Map();        // combo 宏 -> Set<值>
const builtinCalls = new Map();  // 疑似内置函数调用 -> 次数
const uniformMaterials = new Map(); // uniform 名 -> Set<material 参数名>
const texSampleUsers = new Set();

for (const id of dirs) {
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
    if (!e.name.startsWith('shaders/') || !e.name.endsWith('.frag')) continue;
    const text = Buffer.from(buf.subarray(dataStart + e.off, dataStart + e.off + e.size)).toString('utf8');
    for (const m of text.matchAll(/#include\s+"([^"]+)"/g)) {
      includes.set(m[1], (includes.get(m[1]) ?? 0) + 1);
    }
    // combo 声明注释 // [COMBO] {...} 或 uniform 注释里的 "combo":"X"
    for (const m of text.matchAll(/\[COMBO\]\s*(\{[^}]*\})/g)) {
      try {
        const c = JSON.parse(m[1]);
        if (c.combo) {
          const set = combos.get(c.combo) ?? new Set();
          if (c.options) Object.values(c.options).forEach(v => set.add(v));
          else if (c.default !== undefined) set.add(c.default);
          combos.set(c.combo, set);
        }
      } catch { /* ignore */ }
    }
    // uniform 声明的 material 映射注释 {"material":"xxx"}
    for (const m of text.matchAll(/uniform\s+[\w]+\s+(\w+);\s*\/\/\s*(\{[^}]*\})/g)) {
      try {
        const ann = JSON.parse(m[2]);
        if (ann.material) {
          const set = uniformMaterials.get(m[1]) ?? new Set();
          set.add(ann.material);
          uniformMaterials.set(m[1], set);
        }
      } catch { /* ignore */ }
    }
    // 内置函数调用（非标准 GLSL 函数名）
    const candidates = ['texSample2D', 'mul', 'rotateVec2', 'squareToQuad', 'inverse', 'texSample2DLod', 'clampToEdge', 'linearToSRGB', 'sRGBToLinear', 'mod2', 'mix', 'smoothstep'];
    for (const fn of candidates) {
      if (text.includes(fn)) builtinCalls.set(fn, (builtinCalls.get(fn) ?? 0) + 1);
    }
    if (text.includes('g_AudioSpectrum')) texSampleUsers.add(id);
  }
}

console.log('=== include 文件 ===');
for (const [inc, n] of [...includes.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${inc}`);
console.log('\n=== combo 宏及取值 ===');
for (const [c, vals] of [...combos.entries()].sort()) console.log(`  ${c}: [${[...vals].join(', ')}]`);
console.log('\n=== uniform → material 参数映射 ===');
for (const [u, mats] of [...uniformMaterials.entries()].sort()) console.log(`  ${u} → ${[...mats].join(', ')}`);
console.log('\n=== 内置函数调用 ===');
for (const [fn, n] of [...builtinCalls.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${fn}`);
console.log(`\n含 g_AudioSpectrum 的壁纸: ${[...texSampleUsers].join(', ')}`);
