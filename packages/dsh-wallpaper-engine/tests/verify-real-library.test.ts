// 全库真实 scene.pkg 回归验证（研究性测试）：
// 用项目真实代码（parseSceneJson / particlesFromSpec / parseTex / 纹理推导链路）
// 处理本机 Wallpaper Engine 壁纸库的全部 scene.pkg，硬断言读取链路零失败。
// 依赖本机真实库路径（D:\Steam\...\431960），库不存在时自动跳过；
// 新增壁纸若出现未支持结构会在此暴露（提示需研究，而非静默失败）。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseSceneJson } from '../src/client/scene-json.js';
import { particlesFromSpec } from '../src/client/scene-assets.js';
import { parseTex, TEX_FORMAT, FIF } from '../src/client/tex-loader.js';
import { resolveEffectChain } from '../src/client/shader/effect-chain.js';

const WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';
const hasLibrary = existsSync(WALLPAPER_DIR);

interface Entry { name: string; off: number; size: number }

function unpack(buf: Uint8Array): { entries: Entry[]; dataStart: number; files: Map<string, Uint8Array> } {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const entries: Entry[] = [];
  let pos = 16, dataStart = -1;
  while (pos + 8 <= b.length) {
    const nameLen = b.readUInt32LE(pos);
    if (nameLen <= 0 || nameLen > 1024) { dataStart = pos; break; }
    const nameStart = pos + 4;
    const name = b.toString('utf8', nameStart, nameStart + nameLen);
    const off = b.readUInt32LE(nameStart + nameLen);
    const size = b.readUInt32LE(nameStart + nameLen + 4);
    entries.push({ name, off, size });
    pos = nameStart + nameLen + 8;
  }
  const files = new Map<string, Uint8Array>();
  for (const e of entries) {
    files.set(e.name, b.subarray(dataStart + e.off, dataStart + e.off + e.size));
  }
  return { entries, dataStart, files };
}

// 模拟 scene-renderer.resolveImageTexture 的 JSON 推导链路（内存版，使用修正后的 tex 路径规则）
function resolveImageTexPath(objImage: string, files: Map<string, Uint8Array>): { texPath: string | null; reason: string } {
  const modelRaw = files.get(objImage);
  if (!modelRaw) return { texPath: null, reason: `model 不存在: ${objImage}` };
  let model: any;
  try { model = JSON.parse(Buffer.from(modelRaw).toString('utf8')); }
  catch { return { texPath: null, reason: `model 非 JSON: ${objImage}` }; }
  const matRef = model?.material;
  if (typeof matRef !== 'string' || !matRef) return { texPath: null, reason: `model 无 material 字段: ${objImage}` };
  const matRaw = files.get(matRef);
  if (!matRaw) return { texPath: null, reason: `material 不存在: ${matRef}` };
  let mat: any;
  try { mat = JSON.parse(Buffer.from(matRaw).toString('utf8')); }
  catch { return { texPath: null, reason: `material 非 JSON: ${matRef}` }; }
  const passes = Array.isArray(mat?.passes) ? mat.passes : [];
  if (passes.length === 0) return { texPath: null, reason: `material 无 passes: ${matRef}` };
  const texName = passes[0]?.textures?.[0];
  if (typeof texName !== 'string' || !texName) return { texPath: null, reason: `passes[0].textures[0] 非字符串: ${matRef}` };
  // 修正规则：texName 含 '/' 时是相对 materials/ 的路径；不含 '/' 时是材质同目录文件名
  const texPath = texName.includes('/')
    ? 'materials/' + texName + '.tex'
    : matRef.slice(0, matRef.lastIndexOf('/') + 1) + texName + '.tex';
  if (!files.has(texPath)) return { texPath: null, reason: `tex 不存在: ${texPath} (来自 textures[0]=${JSON.stringify(texName)})` };
  return { texPath, reason: '' };
}

describe('全库 scene.pkg 回归验证', () => {
  it('scene 读取链路零失败（scene.json / image 纹理 / particle 规格 / util 效果链）', async () => {
    if (!hasLibrary) {
      console.log('本机无壁纸库，跳过全库验证');
      return;
    }
    const dirs = readdirSync(WALLPAPER_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
    const evidence: string[] = [];
    let okScene = 0, failScene = 0, okImg = 0, failImg = 0, okParticle = 0, failParticle = 0;
    let okEffect = 0, failEffect = 0;
    const texFormats = new Map<number, number>();
    const texContainers = new Map<string, number>();
    const texImageFormats = new Map<number, number>();

    for (const id of dirs) {
      const pkgPath = join(WALLPAPER_DIR, id, 'scene.pkg');
      if (!existsSync(pkgPath)) continue;
      const buf = new Uint8Array(readFileSync(pkgPath));
      const magic = Buffer.from(buf.subarray(4, 12)).toString('ascii');
      const { files } = unpack(buf);
      const scRaw = files.get('scene.json');
      if (!scRaw) { evidence.push(`[${id}] ${magic} 无 scene.json`); failScene++; continue; }
      let desc;
      try {
        desc = parseSceneJson(Buffer.from(scRaw).toString('utf8'));
        okScene++;
      } catch (e: any) {
        evidence.push(`[${id}] ${magic} parseSceneJson 失败: ${e.message}`);
        failScene++;
        continue;
      }
      // 所有对象效果链收集（Ruling 5：所有对象 kind 不限的 effects 按 objects 顺序展平，
      // 与 renderScene 收集一致——全库 122 条中 105 条挂在 image 对象上；循环结束后逐条解析）
      const utilEffects: { file: string; passes?: unknown[] }[] = [];
      for (const obj of desc.objects) {
        // Ruling 5：不再限定 util kind，任意对象带 effects 都按序收集
        if (Array.isArray(obj.effects)) {
          for (const fx of obj.effects) {
            const e = fx as { file?: string; passes?: unknown[] } | null | undefined;
            if (typeof e?.file === 'string') utilEffects.push({ file: e.file, passes: e.passes });
          }
        }
        if (obj.kind === 'image') {
          const r = resolveImageTexPath(obj.image, files);
          if (r.texPath) {
            // 验证 tex 可解析
            const info = parseTex(files.get(r.texPath)!);
            if (info) {
              okImg++;
              texFormats.set(info.format, (texFormats.get(info.format) ?? 0) + 1);
              if (info.imageFormat !== undefined) texImageFormats.set(info.imageFormat, (texImageFormats.get(info.imageFormat) ?? 0) + 1);
              const container = Buffer.from(files.get(r.texPath)!.subarray(46, 55)).toString('ascii').replace(/\0$/, '');
              texContainers.set(container, (texContainers.get(container) ?? 0) + 1);
            } else {
              evidence.push(`[${id}] ${magic} image "${obj.name}" tex 解析失败: ${r.texPath} (${files.get(r.texPath)!.length}B)`);
              failImg++;
            }
          } else {
            evidence.push(`[${id}] ${magic} image "${obj.name}" (${obj.image}) 链路断: ${r.reason}`);
            failImg++;
          }
        } else if (obj.kind === 'particle' && obj.particle) {
          const pRaw = files.get(obj.particle);
          if (!pRaw) { evidence.push(`[${id}] ${magic} particle "${obj.name}" 资源不存在: ${obj.particle}`); failParticle++; continue; }
          let root: any;
          try { root = JSON.parse(Buffer.from(pRaw).toString('utf8')); }
          catch { evidence.push(`[${id}] ${magic} particle "${obj.name}" 非 JSON: ${obj.particle}`); failParticle++; continue; }
          const spec = particlesFromSpec(root);
          if (spec) okParticle++;
          else {
            evidence.push(`[${id}] ${magic} particle "${obj.name}" 无有效 emitter: ${obj.particle} keys=${Object.keys(root).join(',')}`);
            failParticle++;
          }
        }
      }
      // 循环后：逐条解析 util 效果链（effect.json → material → shader，合并 scene.json 覆写）
      for (const fx of utilEffects) {
        const chain = await resolveEffectChain(fx, async (name) => files.get(name) ?? null);
        if (chain) okEffect++;
        else {
          evidence.push(`[${id}] ${magic} 效果链解析失败: ${fx.file}`);
          failEffect++;
        }
      }
    }

    console.log(`\n=== 汇总 ===`);
    console.log(`scene.json 解析: 成功 ${okScene} / 失败 ${failScene}`);
    console.log(`image 对象: 成功 ${okImg} / 失败 ${failImg}`);
    console.log(`particle 对象: 成功 ${okParticle} / 失败 ${failParticle}`);
    console.log(`效果链（所有对象）: 成功 ${okEffect} / 失败 ${failEffect}`);
    console.log(`tex 格式分布: ${JSON.stringify(Object.fromEntries([...texFormats.entries()].map(([k, v]) => [k, v])))}`);
    console.log(`tex imageFormat(FIF) 分布: ${JSON.stringify(Object.fromEntries([...texImageFormats.entries()].map(([k, v]) => [k, v])))}`);
    console.log(`tex 容器分布: ${JSON.stringify(Object.fromEntries(texContainers))}`);
    if (evidence.length === 0) console.log('无失败证据 ✓');
    else {
      console.log(`\n失败证据 ${evidence.length} 条:`);
      for (const e of evidence) console.log('  ' + e);
    }
    // 硬断言：全库 scene 读取链路（解析/纹理推导/粒子规格）必须零失败
    expect(evidence).toEqual([]);
  });
});
