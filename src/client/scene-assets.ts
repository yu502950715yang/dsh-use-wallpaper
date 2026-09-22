import type { SceneDescription, SceneImageObject } from '../shared/types.js';
import * as THREE from 'three';
import { parseSceneJson } from './scene-json.js';
import { loadTexTexture } from './tex-loader.js';
import type { ParticleEmitterSpec, ParticleInitializerSpec } from './particles.js';

function vec3(s: unknown): [number, number, number] {
  if (typeof s !== 'string') return [0, 0, 0];
  const p = s.trim().split(/\s+/).map(Number);
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}

export async function fetchSceneDescription(id: string): Promise<SceneDescription> {
  const resp = await fetch(`/wallpapers/scene/${id}/asset?name=scene.json`);
  if (!resp.ok) throw new Error('scene.json fetch failed');
  return parseSceneJson(await resp.text());
}

export function particlesFromSpec(root: any): { emitter: ParticleEmitterSpec; init: ParticleInitializerSpec } | null {
  if (typeof root !== 'object' || root === null) return null;
  const em = Array.isArray(root.emitter) ? root.emitter[0] : undefined;
  const inits = Array.isArray(root.initializer) ? root.initializer : [];
  if (!em) return null;
  const life = inits.find((i: any) => i.name === 'lifetimerandom');
  const size = inits.find((i: any) => i.name === 'sizerandom');
  const vel = inits.find((i: any) => i.name === 'velocityrandom');
  const color = inits.find((i: any) => i.name === 'colorrandom');
  const alpha = inits.find((i: any) => i.name === 'alpharandom');
  return {
    emitter: {
      // rate/distanceMax 缺省值对齐真实 WE 语义（linux-wallpaperengine 逆向源码：
      // rate=10、distancemax=256）；EVA Ashes 等 emitter 无 rate 字段，缺省 0 会导致永不发射
      rate: Number(em.rate ?? 10),
      directions: vec3(em.directions),
      distanceMin: Number(em.distancemin ?? 0),
      distanceMax: Number(em.distancemax ?? 256),
    },
    init: {
      lifetimeMin: Number(life?.min ?? 1),
      lifetimeMax: Number(life?.max ?? 1),
      sizeMin: Number(size?.min ?? 16),
      sizeMax: Number(size?.max ?? 16),
      velocityMin: vec3(vel?.min),
      velocityMax: vec3(vel?.max),
      colorMin: color ? vec3(color.min) : undefined,
      colorMax: color ? vec3(color.max) : undefined,
      alphaMin: alpha ? Number(alpha.min ?? 1) : undefined,
      alphaMax: alpha ? Number(alpha.max ?? 1) : undefined,
    },
  };
}

export async function fetchParticleSpec(id: string, assetName: string): Promise<{ emitter: ParticleEmitterSpec; init: ParticleInitializerSpec } | null> {
  const resp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(assetName)}`);
  if (!resp.ok) return null;
  return particlesFromSpec(JSON.parse(await resp.text()));
}

// WE 语义：material json 的 passes[0].textures[0] 是纹理槽位名 ——
// 不含 '/' → 材质同目录下同名 .tex；含 '/' → 相对 materials/ 的路径（workshop 子目录纹理）。
// 回归：旧实现丢 materials/ 前缀导致子目录纹理加载失败（见 git log）。
export function resolveTexPath(matRef: string, texName: string): string {
  return texName.includes('/')
    ? 'materials/' + texName + '.tex'
    : matRef.slice(0, matRef.lastIndexOf('/') + 1) + texName + '.tex';
}

// 图片对象纹理：obj.image → models/xxx.json → material → passes[0].textures[0] → .tex。
// 任一步失败返回 null（调用方走白图兜底，不阻断渲染）。
export async function resolveImageTexture(id: string, obj: SceneImageObject): Promise<THREE.Texture | null> {
  try {
    const modelResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(obj.image)}`);
    if (!modelResp.ok) return null;
    const model = await modelResp.json();
    const matRef: unknown = model?.material;
    if (typeof matRef !== 'string' || !matRef) return null;
    const matResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(matRef)}`);
    if (!matResp.ok) return null;
    const mat = await matResp.json();
    const texName: unknown = mat?.passes?.[0]?.textures?.[0];
    if (typeof texName !== 'string' || !texName) return null;
    return loadTexTexture(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(resolveTexPath(matRef, texName))}`);
  } catch {
    return null;
  }
}

// 别名映射：部分壁纸粒子材质引用**不存在的全局纹理**（坏引用，桌面版 WE 同样 fallback 纯色）——
// 1280029027(EVA) 的 "presets/lightshaft" 在 WE 安装目录无对应文件，映射到真实光柱纹理。
// 值为**去 particle/ 前缀**的短形式（与下方 short 计算一致），拼回时统一加回 particle/。
const PARTICLE_TEX_ALIASES: Record<string, string> = {
  'presets/lightshaft': 'light/light_shafts_0',
};

// 粒子材质解析结果：渲染一个粒子层所需的**材质级**条件。
export interface ParticleMaterialRef {
  // 粒子材质 tex 的静态资源 URL（供 loadTexTexture 加载）；缺失/坏引用 → null（纯色粒子兜底）。
  texUrl: string | null;
  // 材质 json `passes[0].blending` **原文**（WE 权威混合模式）；拉取失败或无该字段 → null。
  blending: string | null;
}

// 解析粒子 spec 引用的材质 json（spec.material → passes[0]），一次拿到纹理 URL 与混合模式
// （同源于一份 json，分开 fetch 会多一次往返）。
// ⚠️ 混合模式必须取 `passes[0].blending` 字段值，不能按材质**文件名**猜：DK 等 44 层粒子的
// 材质名里没有 "additive" 字样，按名猜会判成 NormalBlending（纹理 alpha 恒 1 → 硬边黑方块）。
export async function resolveParticleMaterial(
  id: string,
  specText: string,
): Promise<ParticleMaterialRef | null> {
  try {
    const spec: unknown = JSON.parse(specText);
    const matRef: unknown = (spec as { material?: unknown })?.material;
    if (typeof matRef !== 'string' || !matRef) return null;
    const matResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(matRef)}`);
    if (!matResp.ok) return null;
    const mat: unknown = await matResp.json();
    const pass0 = (mat as { passes?: { textures?: unknown[]; blending?: unknown }[] })?.passes?.[0];
    const blending = typeof pass0?.blending === 'string' ? pass0.blending : null;
    const texName: unknown = pass0?.textures?.[0];
    if (typeof texName !== 'string' || !texName) return { texUrl: null, blending };
    // 路由以 `<weAssetsDir>/assets/materials` 为基准，name 是纹理的**原始相对路径** —— 多数是
    // `particle/<...>`，但也有 `workshop/<id>/particle/<...>`（如 2897292240 的雨），
    // 所以**不能无条件加 `particle/` 前缀**；唯例外是别名表（命中后把前缀补回来）。
    const short = texName.startsWith('particle/') ? texName.slice('particle/'.length) : texName;
    const aliased = PARTICLE_TEX_ALIASES[short];
    const name = aliased ? `particle/${aliased}` : texName;
    return {
      texUrl: `/wallpapers/particle-texture?name=${encodeURIComponent(name)}`,
      blending,
    };
  } catch {
    return null;
  }
}
