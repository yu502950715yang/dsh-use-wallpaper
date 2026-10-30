// 全库真实 scene.pkg 回归验证（研究性测试）：
// 用项目真实代码（parseSceneJson / particlesFromSpec / parseTex / 纹理推导链路）
// 处理本机 Wallpaper Engine 壁纸库的全部 scene.pkg，硬断言读取链路零失败。
// 依赖本机真实库路径（D:\Steam\...\431960），库不存在时自动跳过；
// 新增壁纸若出现未支持结构会在此暴露（提示需研究，而非静默失败）。
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseSceneJson } from '../src/client/scene-json.js';
import { particlesFromSpec, resolveParticleMaterial } from '../src/client/scene-assets.js';
import { parseTex, TEX_FORMAT, FIF } from '../src/client/tex-loader.js';
import { resolveEffectChain } from '../src/client/shader/effect-chain.js';

const WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';
const hasLibrary = existsSync(WALLPAPER_DIR);
// WE 引擎内置素材目录（与 e2e/config.mjs 的 WE_ASSETS 同源）：仅作「引擎确实提供该材质」的
// 本机佐证；目录不在已知位置时该条断言跳过，不影响「materials/util/* = 引擎内置」的分类判据。
const WE_ENGINE_ASSETS = join(
  process.env.WE_ASSETS ?? 'D:/Steam/steamapps/common/wallpaper_engine',
  'assets',
);

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
//
// 特例：WE 把**引擎 assets 目录也挂载在 VFS 根上**（host `/wallpapers/scene/<id>/asset` 的
// 「pkg → <WE>/assets」两级查找），因此 `materials/util/*` 这类引擎内置材质**不在 scene.pkg 内**
// 是正常形态（3797976859 的封面模型就指向 `materials/util/solidlayer_instance.json`）。
// 判据：只有已知引擎内置前缀的缺失材质视作「引擎提供」、不计入 evidence；其它缺失仍按链路断报错。
const ENGINE_MATERIAL_PREFIXES = ['materials/util/'];

function isEngineProvidedMaterial(matRef: string): boolean {
  return ENGINE_MATERIAL_PREFIXES.some((prefix) => matRef.startsWith(prefix));
}

function resolveImageTexPath(
  objImage: string,
  files: Map<string, Uint8Array>,
): { texPath: string | null; reason: string; engineProvided?: boolean } {
  const modelRaw = files.get(objImage);
  if (!modelRaw) return { texPath: null, reason: `model 不存在: ${objImage}` };
  let model: any;
  try { model = JSON.parse(Buffer.from(modelRaw).toString('utf8')); }
  catch { return { texPath: null, reason: `model 非 JSON: ${objImage}` }; }
  const matRef = model?.material;
  if (typeof matRef !== 'string' || !matRef) return { texPath: null, reason: `model 无 material 字段: ${objImage}` };
  const matRaw = files.get(matRef);
  if (!matRaw) {
    if (isEngineProvidedMaterial(matRef)) return { texPath: null, reason: '', engineProvided: true };
    return { texPath: null, reason: `material 不存在: ${matRef}` };
  }
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

// 无本机壁纸库时**显式 skip**（而非在用例体内 return —— 那会让 CI 上「通过但什么都没测」的假绿）。
// CI 上本用例必然 skip，全库解析回归只能在装了 WE 壁纸库的机器上跑。
if (!hasLibrary) {
  console.warn(`[verify-real-library] 未找到壁纸库 ${WALLPAPER_DIR} —— 全库解析回归本次跳过（CI 上属预期）`);
}

describe.skipIf(!hasLibrary)('全库 scene.pkg 回归验证', () => {
  it('scene 读取链路零失败（scene.json / image 纹理 / particle 规格 / util 效果链）', async () => {
    const dirs = readdirSync(WALLPAPER_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory()).map(d => d.name);
    const evidence: string[] = [];
    let okScene = 0, failScene = 0, okImg = 0, failImg = 0, okParticle = 0, failParticle = 0;
    let okEffect = 0, failEffect = 0;
    // 引擎内置材质（`materials/util/*`）不在 pkg 内：只计数，不计入 evidence（见 resolveImageTexPath 注释）。
    let engineMaterial = 0;
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
            if (r.engineProvided) engineMaterial++;
            else {
              evidence.push(`[${id}] ${magic} image "${obj.name}" (${obj.image}) 链路断: ${r.reason}`);
              failImg++;
            }
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
    console.log(`image 材质: 引擎内置（materials/util/*，pkg 内无文件、运行时由 <WE>/assets 提供） ${engineMaterial}`);
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
    // 防「静默漏收集」：收集逻辑若回归（丢掉 image 对象 effects、退化为仅 util），
    // 数量会掉但不产生 evidence ⇒ 这里只要求**非空**。
    // ⚠️ 不再钉具体数字：全库计数是本机壁纸库的快照（122 → 129 → 169 一路随素材漂移，
    // 三方 A/B 已证与代码无关，见 AGENT.md §7.11）。**精确计数与语义**由确定性层
    // `tests/synthetic-library.test.ts`（合成 fixture，不依赖本机素材）负责。
    expect(okEffect).toBeGreaterThan(0);
  });
});

// 引擎内置材质的分类（确定性，不依赖本机壁纸库）：缺失 ≠ 链路断的唯一豁免是已知引擎前缀。
describe('引擎内置材质判定', () => {
  const filesWithMaterial = (material: string) => new Map<string, Uint8Array>([
    ['models/x.json', Buffer.from(JSON.stringify({ material }))],
  ]);

  it('materials/util/* 缺失 ⇒ 视作引擎提供、不计入 evidence', () => {
    const r = resolveImageTexPath('models/x.json', filesWithMaterial('materials/util/solidlayer_instance.json'));
    expect(r.engineProvided).toBe(true);
    expect(r.texPath).toBeNull();
    expect(r.reason).toBe('');
  });

  it('其它路径的缺失材质仍按「material 不存在」报链路断（不弱化证据）', () => {
    const r = resolveImageTexPath('models/x.json', filesWithMaterial('materials/workshop/9999/missing.json'));
    expect(r.engineProvided).toBeFalsy();
    expect(r.reason).toContain('material 不存在');
  });

  it('本机 WE 引擎目录存在时，solidlayer_instance.json 确实由引擎提供', () => {
    if (!existsSync(WE_ENGINE_ASSETS)) return; // 引擎不在已知位置 ⇒ 无法佐证，跳过该断言
    expect(existsSync(join(WE_ENGINE_ASSETS, 'materials/util/solidlayer_instance.json'))).toBe(true);
  });
});

// 粒子 REFRACT 真库对照（Task 4）：死亡搁浅 2897292240 的雨层（obj #25/#36）材质
// `materials/workshop/2446129945/particle/halo_50_1.json` 带 `combos.REFRACT = 1` + 槽 1 法线图；
// 全库其余粒子材质都没有该 combo（⇒ 一律走既有路径，零分歧）。
const REFRACT_WID = '2897292240';
const REFRACT_MATERIAL = 'materials/workshop/2446129945/particle/halo_50_1.json';
const REFRACT_PKG = join(WALLPAPER_DIR, REFRACT_WID, 'scene.pkg');
const hasRefractAsset = existsSync(REFRACT_PKG);
const REFRACT_SCAN = 'output/blur-analysis/refract-scan.json';

/** 取一张壁纸 scene.pkg 内的文件表（缺 pkg → null）。 */
function pkgFiles(id: string): Map<string, Uint8Array> | null {
  const p = join(WALLPAPER_DIR, id, 'scene.pkg');
  if (!existsSync(p)) return null;
  return unpack(new Uint8Array(readFileSync(p))).files;
}

/** 基线（`output/blur-analysis/refract-scan.json`）里 `combos.REFRACT === 1` 的材质名集合；
 *  基线文件缺失 / 不可解析 / 没有任何条目 → null（调用方跳过该交叉对照）。
 *  ⚠️ 「存在但缺 `rows` / 为空」必须同样返回 null：返回空集会退化成「每个本机材质都判红」，
 *  与「不可解析 → 跳过」的承诺相反（基线被 .gitignore 忽略，不该因它红）。 */
function baselineRefractMaterials(): Set<string> | null {
  if (!existsSync(REFRACT_SCAN)) return null;
  try {
    const rows = (JSON.parse(readFileSync(REFRACT_SCAN, 'utf8')) as { rows?: unknown })?.rows;
    if (!Array.isArray(rows)) return null;
    const out = new Set<string>();
    for (const r of rows as Array<{ combos?: { REFRACT?: unknown }; material?: unknown }>) {
      if (r?.combos?.REFRACT === 1 && typeof r.material === 'string') out.add(r.material);
    }
    return out.size > 0 ? out : null;
  } catch {
    return null;
  }
}

describe.skipIf(!hasLibrary || !hasRefractAsset)('粒子 REFRACT 真库对照', () => {
  it('halo_50_1.json：refract=true、槽 1 非空（走同一条 particle-texture 路由）、amount 缺省 0.05', async () => {
    const files = pkgFiles(REFRACT_WID);
    expect(files).not.toBeNull();
    const matRaw = files!.get(REFRACT_MATERIAL);
    expect(matRaw).toBeTruthy(); // 本机素材确实带该材质（否则该用例应整块 skip）
    // fetch 打桩：只服务材质 json（resolveParticleMaterial 的唯一请求），走真实解析链路。
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => JSON.parse(Buffer.from(matRaw!).toString('utf8')),
    })));
    try {
      const r = await resolveParticleMaterial(REFRACT_WID, JSON.stringify({ material: REFRACT_MATERIAL }));
      expect(r).not.toBeNull();
      expect(r!.refract).toBe(true);
      expect(r!.blending).toBe('translucent');
      expect(r!.refractAmount).toBe(0.05); // 该材质无 ui_editor_properties_refract_amount
      expect(r!.normalTexUrl).toBe(
        '/wallpapers/particle-texture?id=2897292240&name=workshop%2F2446129945%2Fparticle%2Fparticles%20256x1280N',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // ⚠️ 本用例只有**一条硬判据**：本机确实解析出 `halo_50_1.json` 这一条 `refract=true`
  //（无该素材时 describe.skipIf 已整块跳过，不存在「空集合恒真」）。
  //
  // 与研究者基线（`output/blur-analysis/refract-scan.json`）的交叉核对**降级为 console.warn**：
  //   - 基线在 .gitignore 内、不入库 ⇒ CI 上 `existsSync` 失败、该核对被静默跳过，**仅本机生效**；
  //   - 上一轮把它写成 `expect(baseline).toContain(m)` 时给的理由「消除『新装折射壁纸 ⇒ 假失败』」
  //     **不成立**：新装素材不在基线里，那样写照样红（本轮才真正不再假失败）；
  //   - 放宽的实际收益只是「本机多出、但基线也覆盖了」的材质不再假失败 —— 旧的
  //     `toEqual([halo_50_1.json])` 写法会因此变红（本文件既有约定是**不钉本机素材快照**）。
  it('全库扫描：本机解析出的 REFRACT 材质包含 halo_50_1.json（与基线不一致只告警）', () => {
    const refractMaterials = new Set<string>();
    for (const dir of readdirSync(WALLPAPER_DIR, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const files = pkgFiles(dir.name);
      const scRaw = files?.get('scene.json');
      if (!files || !scRaw) continue;
      let desc;
      try { desc = parseSceneJson(Buffer.from(scRaw).toString('utf8')); } catch { continue; }
      for (const obj of desc.objects) {
        if (obj.kind !== 'particle' || !obj.particle) continue;
        const specRaw = files.get(obj.particle);
        if (!specRaw) continue;
        let matRef: unknown;
        try { matRef = JSON.parse(Buffer.from(specRaw).toString('utf8'))?.material; } catch { continue; }
        if (typeof matRef !== 'string' || !matRef) continue;
        const matRaw = files.get(matRef);
        if (!matRaw) continue;
        try {
          const pass0 = JSON.parse(Buffer.from(matRaw).toString('utf8'))?.passes?.[0];
          if (pass0?.combos?.REFRACT === 1) refractMaterials.add(matRef);
        } catch { /* 非法 json 由上面那条回归用例兜底 */ }
      }
    }
    // ① 能力仍被本机真实素材验证（唯一的硬判据）。
    expect(refractMaterials).toContain(REFRACT_MATERIAL);
    // ② 与研究者基线交叉核对（口径漂移诊断）：只告警、不判红 —— 基线不入库，本库素材也会漂移。
    const baseline = baselineRefractMaterials();
    if (baseline) {
      const missing = [...refractMaterials].filter((m) => !baseline.has(m));
      if (missing.length > 0) {
        console.warn(
          `[verify-real-library] 本机扫到的 REFRACT 材质不在基线内（新装素材或解析口径已变）: ${missing.join(', ')}`,
        );
      }
    }
  });
});

// F21 真库回归：2859263090 的 2233/2236 把 instanceoverride 的 colorn/rate 写成 WE 的
// {user|script,value} 包装 → 未解包时 wasm 得 vec3(对象)=[0,0,0]，additive 雪层变黑不可见。
const F21_WID = '2859263090';
const F21_PKG = join(WALLPAPER_DIR, F21_WID, 'scene.pkg');

describe.skipIf(!hasLibrary || !existsSync(F21_PKG))('F21 instanceoverride 包装解包真库回归', () => {
  it('2859263090 的 2233/2236：colorn/rate 的 {user|script,value} 包装解成标量', () => {
    const files = pkgFiles(F21_WID);
    expect(files).not.toBeNull();
    const scRaw = files!.get('scene.json');
    expect(scRaw).toBeTruthy();
    const desc = parseSceneJson(Buffer.from(scRaw!).toString('utf8'));
    const byId = new Map(desc.objects.map((o) => [o.id, o]));
    const o2233 = byId.get(2233);
    const o2236 = byId.get(2236);
    expect(o2233?.kind).toBe('particle');
    expect(o2236?.kind).toBe('particle');
    const json2233 = JSON.parse((o2233 as { instanceOverrideJson?: string }).instanceOverrideJson!);
    const json2236 = JSON.parse((o2236 as { instanceOverrideJson?: string }).instanceOverrideJson!);
    expect(json2233.colorn).toBe('1.000 1.000 1.000'); // {user:null,value} → 标量（白色雪层）
    expect(json2233.rate).toBe(1); // {script,value} → 标量
    expect(json2236.colorn).toBe('1 1 1'); // 普通字符串不受影响
    expect(json2236.rate).toBe(1);
  });
});
