// 研究：对照引擎内置 shader 头文件，扫描全库壁纸 shader 实际调用的头文件符号，
// 确定 we-headers.ts 需要补全的精确清单（含调用点所属壁纸）。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';

// 真实引擎头文件符号清单（从 D:\Steam\...\assets\shaders\ 逐字核对）
const SYMBOLS = {
  'common.h': ['hsv2rgb', 'rgb2hsv', 'greyscale', 'M_PI_2', 'M_PI_HALF', 'SQRT_2', 'SQRT_3'],
  'common_blending.h': ['Desaturate', 'RGBToHSL', 'HSLToRGB', 'HueToRGB', 'ContrastSaturationBrightness',
    'BlendHue', 'BlendSaturation', 'BlendColor', 'BlendLuminosity',
    'BlendDarken', 'BlendMultiply', 'BlendColorBurn', 'BlendSubstract', 'BlendLighten', 'BlendScreen',
    'BlendColorDodge', 'BlendAdd', 'BlendOverlay', 'BlendSoftLight', 'BlendHardLight', 'BlendVividLight',
    'BlendLinearLight', 'BlendPinLight', 'BlendHardMix', 'BlendDifference', 'BlendExclusion', 'BlendReflect',
    'BlendGlow', 'BlendPhoenix', 'BlendAverage', 'BlendNegation', 'BlendTint', 'BlendLinearDodge',
    'BlendLinearBurn', 'BlendNormal', 'BlendLighten', 'BlendOpacity'],
  'common_composite.h': ['ApplyComposite', 'ApplyCompositeOffset'],
  'common_fragment.h': ['DecompressNormal', 'DecompressNormalWithMask', 'ComputeMaterialSpecularPower',
    'ComputeMaterialSpecularStrength', 'ComputeLight', 'ComputeLightSpecular', 'ConvertSampleR8',
    'ConvertTexture0Format', 'ConvertTextureFormat'],
  'common_vertex.h': ['BuildTangentSpace'],
  'common_perspective.h': ['squareToQuad'],
  'common_blur.h': ['blur13a', 'blur7a', 'blur3a'],
  'common_particles.h': ['ComputeParticleTangents', 'ComputeParticleTrailTangents', 'ComputeParticlePosition',
    'ComputeSpriteFrame', 'ComputeScreenRefractionTangents', 'ComputeScreenRefractionCoord'],
};

const useCount = new Map(); // symbol -> {count, wallpapers:Set}
for (const syms of Object.values(SYMBOLS)) for (const s of syms) useCount.set(s, { count: 0, wallpapers: new Set() });

for (const id of readdirSync(WALLPAPER_DIR)) {
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
    if (!e.name.startsWith('shaders/') || !/\.(frag|vert)$/.test(e.name)) continue;
    const text = Buffer.from(buf.subarray(dataStart + e.off, dataStart + e.off + e.size)).toString('utf8');
    for (const [header, syms] of Object.entries(SYMBOLS)) {
      for (const s of syms) {
        // 词边界匹配（避免 BlendColor 命中 BlendColorBurn 等子串）
        const re = new RegExp(`\\b${s}\\b`, 'g');
        if (re.test(text)) {
          const rec = useCount.get(s);
          rec.count++;
          rec.wallpapers.add(id);
        }
      }
    }
  }
}

console.log('=== 全库 shader 调用的引擎头符号（按频次）===');
for (const [sym, rec] of [...useCount.entries()].sort((a, b) => b[1].count - a[1].count)) {
  if (rec.count > 0) console.log(`${String(rec.count).padStart(4)} 次  ${String(rec.wallpapers.size).padStart(2)} 壁纸  ${sym}  [${[...rec.wallpapers].join(',')}]`);
}
console.log('\n=== 未被调用（we-headers 可暂缺）===');
for (const [sym, rec] of [...useCount.entries()].sort((a, b) => b[1].count - a[1].count)) {
  if (rec.count === 0) console.log(`   ${sym}`);
}
