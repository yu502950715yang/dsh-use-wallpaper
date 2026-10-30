import type { SceneDescription, SceneImageObject } from '../shared/types.js';
import { MEDIA_THUMBNAIL_TEXTURE } from '../shared/media.js';
import * as THREE from 'three';
import { parseSceneJson } from './scene-json.js';
import { loadTexTexture } from './tex-loader.js';
import type { ParticleEmitterSpec, ParticleInitializerSpec } from './particles.js';

function vec3(s: unknown): [number, number, number] {
  if (typeof s !== 'string') return [0, 0, 0];
  const p = s.trim().split(/\s+/).map(Number);
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}

// entry = pkg 内场景入口 json 名（WE 模板可能是 gifscene.json；缺省 scene.json）。
export async function fetchSceneDescription(id: string, entry = 'scene.json'): Promise<SceneDescription> {
  const resp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(entry)}`);
  if (!resp.ok) throw new Error(`${entry} fetch failed`);
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
      // rate/distanceMax 缺省值对齐真实 WE 语义（lwe：rate=10、distancemax=256）；缺 rate 字段时缺省 0 会导致永不发射
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
export function resolveTexPath(matRef: string, texName: string): string {
  return texName.includes('/')
    ? 'materials/' + texName + '.tex'
    : matRef.slice(0, matRef.lastIndexOf('/') + 1) + texName + '.tex';
}

// 图片对象资源：obj.image → models/xxx.json → { material, puppet } 一次拉取，再各取两条链（material → tex、
// puppet → `.mdl` 路径，本函数不下字节）。任一步失败按 null 返回（白图兜底），但**纹理失败不丢已解析的 puppetPath**。
// `spriteSheet` = 材质 `passes[0].combos.spritesheet`（帧动画标记；真实素材 key 有大小写两种写法）。
// `mediaThumbnail` = `instance.usertextures` 绑定 `$mediaThumbnail`（封面层：调用方改用共享封面纹理）。
export async function resolveImageAssets(
  id: string,
  obj: SceneImageObject,
): Promise<{ texture: THREE.Texture | null; puppetPath: string | null; spriteSheet: boolean; mediaThumbnail: boolean }> {
  let puppetPath: string | null = null;
  // 只依赖 scene.json 声明 ⇒ 提前定论：材质解析失败也不该丢掉封面绑定。
  const mediaThumbnail = hasMediaThumbnailTexture(obj);
  try {
    const modelResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(obj.image)}`);
    if (!modelResp.ok) return { texture: null, puppetPath: null, spriteSheet: false, mediaThumbnail };
    const model = await modelResp.json();
    puppetPath = typeof model?.puppet === 'string' && model.puppet ? String(model.puppet) : null;
    const matRef: unknown = model?.material;
    if (typeof matRef !== 'string' || !matRef) return { texture: null, puppetPath, spriteSheet: false, mediaThumbnail };
    const matResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(matRef)}`);
    if (!matResp.ok) return { texture: null, puppetPath, spriteSheet: false, mediaThumbnail };
    const mat = await matResp.json();
    const combos = mat?.passes?.[0]?.combos;
    const spriteSheet = combos?.spritesheet === 1 || combos?.SPRITESHEET === 1;
    const texName: unknown = mat?.passes?.[0]?.textures?.[0];
    if (typeof texName !== 'string' || !texName) return { texture: null, puppetPath, spriteSheet, mediaThumbnail };
    // instance.textures 覆盖材质纹理槽（名字相对 materials/ 的带 '/' 形式；与材质原槽相同 ⇒ 无操作）。
    const instanceTex = obj.instance?.textures?.[0];
    const texName2 = instanceTex && instanceTex.includes('/') ? instanceTex : texName;
    const url = `/wallpapers/scene/${id}/asset?name=${encodeURIComponent(resolveTexPath(matRef, texName2))}`;
    const texture = await loadTexTexture(url);
    // 标记落在纹理上：player 只拿到 texture（不重走材质），据此决定是否按帧切 UV。
    if (texture && spriteSheet) texture.userData.spritesheet = true;
    return { texture, puppetPath, spriteSheet, mediaThumbnail };
  } catch {
    return { texture: null, puppetPath, spriteSheet: false, mediaThumbnail };
  }
}

/** 对象是否绑定 WE 系统封面纹理（scene.json `instance.usertextures` 含 `$mediaThumbnail`）。 */
export function hasMediaThumbnailTexture(obj: SceneImageObject): boolean {
  return Array.isArray(obj.instance?.usertextures)
    && obj.instance!.usertextures!.some((u) => u?.name === MEDIA_THUMBNAIL_TEXTURE);
}

// `.mdl` 原始字节（走既有 scene asset 路由，pkg 内条目）；失败返回 null（调用方退化为普通贴图）。
export async function fetchMdlBytes(id: string, path: string): Promise<Uint8Array | null> {
  try {
    const resp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(path)}`);
    if (!resp.ok) return null;
    return new Uint8Array(await resp.arrayBuffer());
  } catch {
    return null;
  }
}

// 别名映射：部分壁纸粒子材质引用**不存在的全局纹理**（坏引用，桌面版 WE 同样 fallback 纯色），
// 映射到真实光柱纹理。值为**去 particle/ 前缀**的短形式（与下方 short 计算一致），拼回时统一加回 particle/。
const PARTICLE_TEX_ALIASES: Record<string, string> = {
  'presets/lightshaft': 'light/light_shafts_0',
};

// 粒子材质解析结果：渲染一个粒子层所需的**材质级**条件。
export interface ParticleMaterialRef {
  // 粒子材质 tex 的静态资源 URL（供 loadTexTexture 加载）；缺失/坏引用 → null（纯色粒子兜底）。
  texUrl: string | null;
  // 材质 json `passes[0].blending` **原文**（WE 权威混合模式）；拉取失败或无该字段 → null。
  blending: string | null;
  // 折射层（WE combo `REFRACT === 1`，唯一判据）：`REFRACT: 0` / 无 `combos` ⇒ false（失败开放）。
  refract: boolean;
  // 槽 1（法线/遮罩）走**与槽 0 同一条** particle-texture 路由；缺失 → null（调用方不装配该层）。
  normalTexUrl: string | null;
  // 材质 `constantshadervalues.ui_editor_properties_refract_amount`；缺失 → WE 缺省 0.05。
  refractAmount: number;
}

// 粒子纹理路由（槽 0/槽 1 共用）：name 是纹理的**原始相对路径**（多数 `particle/<...>`，也有
// `workshop/<id>/particle/<...>`）⇒ 不能无条件加前缀；带壁纸 id 让 host 先在 scene.pkg 内查。
function particleTextureUrl(id: string, texName: string): string {
  const short = texName.startsWith('particle/') ? texName.slice('particle/'.length) : texName;
  const aliased = PARTICLE_TEX_ALIASES[short];
  const name = aliased ? `particle/${aliased}` : texName;
  return `/wallpapers/particle-texture?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`;
}

// 解析粒子 spec 引用的材质 json（spec.material → passes[0]），一次拿到纹理 URL 与混合模式（同源于一份 json）。
// ⚠️ 混合模式必须取 `passes[0].blending` 字段值，不能按材质**文件名**猜：additive 材质的文件名里通常没有
// 相应字样，按名猜会判成 NormalBlending（纹理 alpha 恒 1 → 硬边黑方块）。
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
    const pass0 = (mat as {
      passes?: {
        textures?: unknown[];
        blending?: unknown;
        combos?: Record<string, unknown>;
        constantshadervalues?: Record<string, unknown>;
      }[];
    })?.passes?.[0];
    const blending = typeof pass0?.blending === 'string' ? pass0.blending : null;
    // 折射判据只认 WE 权威 combo（`REFRACT: 0` / 无 `combos` ⇒ false）：不做「白图/alpha 全 255」
    // 之类素材启发式——那会误伤 additive 材质（其槽 0 同样是白图）。
    const refract = pass0?.combos?.REFRACT === 1;
    const rawAmount = pass0?.constantshadervalues?.ui_editor_properties_refract_amount;
    const refractAmount = typeof rawAmount === 'number' && Number.isFinite(rawAmount) ? rawAmount : 0.05;
    const texName: unknown = pass0?.textures?.[0];
    // 槽 1 与槽 0 同一条路由（**不加** `materials/`、不走 resolveTexPath）；与 refract 无关地给出，
    // 由调用方决定是否加载（仅折射层会加载）。
    const normalName: unknown = pass0?.textures?.[1];
    const normalTexUrl = typeof normalName === 'string' && normalName
      ? particleTextureUrl(id, normalName)
      : null;
    if (typeof texName !== 'string' || !texName) {
      return { texUrl: null, blending, refract, normalTexUrl, refractAmount };
    }
    return {
      texUrl: particleTextureUrl(id, texName),
      blending,
      refract,
      normalTexUrl,
      refractAmount,
    };
  } catch {
    return null;
  }
}
