// 背景图层状态工厂（阶段 2c-3a）：从 ThreeScenePlayer 拆出的背景变换/尺寸/调制更新逻辑（审查 P0-9）。
// 纯状态更新（不改渲染管线）；图层条目的所有权仍在 player，通过 host 注入访问。
import * as THREE from 'three';
import { materialModulation } from './object-range.js';
import { alignOffset } from './alignment.js';
import type { ParticleLayer } from './particle-layer-factory.js';
import type { IsolatedObject } from './layer-factory.js';

export type BackgroundEntry = {
  mesh: THREE.Mesh;
  // WE 场景坐标（创建时的 origin，未中心化）——update_background 用它重算 we_to_three 位置。
  origin: [number, number, number];
  // 几何尺寸（世界单位，未缩放；mesh.scale 承载 WE scale）——resizeBackground 用它判定是否需重建。
  size: [number, number];
  scale: [number, number, number];
  // WE 对象欧拉角（弧度；T·R·S 的 R）。记录创建值（update_background 暂不改角度）。
  angles: [number, number, number];
  // alignment 锚点偏移（世界坐标，已含 scale/angles）：基准位 = origin - scene/2 + 本值。
  align: [number, number];
  alignment?: string;
  color?: [number, number, number]; // 对象 color（0-255）；brightness 更新时保持 tint 不被重置
  alpha: number;         // 已应用 material.opacity（0-1）
  brightness: number;    // 亮度乘法系数（原始值，materialModulation 内部 clamp）
  // 该背景创建时用的场景固有尺寸（we_to_three 中心化基准 = origin - scene/2）。
  sceneW: number;
  sceneH: number;
  // 渲染 origin 与「对象锚点」的差（text 的 origin 含 anchorOffset；image/util 为 0）。
  // 时间线世界变换按对象锚点下发，写回时补上它才是 quad 中心的真实位置。
  // text 的文本变化会改变锚点偏移 ⇒ 由 setBackgroundAnchorOffset 刷新，不能只存装配期值。
  renderOffset: [number, number, number];
  // 视差：node = 实际承载世界位置的 three 对象（非隔离 = mesh，隔离 = 合成 quad）；
  // depth 来自 scene.json 的 parallaxDepth（缺省 undefined = 不参与视差）。
  parallaxNode: THREE.Object3D;
  parallaxDepth?: [number, number];
  // 本条目**当前**是否在该 node 上留着位移（true ⇒ 关视差时写回一次基准位；见 parallax-runtime）。
  parallaxApplied?: boolean;
};

export interface BackgroundLayerHost {
  readonly sceneWidth: number;
  readonly sceneHeight: number;
  entryById(backgroundId: number): BackgroundEntry | undefined;
  backgroundIdOf(objectId: number): number | undefined;
  particleOf(objectId: number): ParticleLayer | undefined;
  isIsolated(objectId: number): boolean;
  hasPuppetLayer(id: number): boolean;
  /** 换几何后按 backgroundId 重写精灵表 UV 的 base（见 sprite-sheet-runtime.rebaseForBackground）。 */
  rebaseSpriteSheet(backgroundId: number): void;
  /** 同对象只告警一次（防每帧刷屏）。 */
  warnedUnsupportedTransform: Set<number>;
}

/** alignment 锚点偏移的世界坐标：局部半尺寸先乘 scale（含镜像），再按对象 angles 旋转（与 mesh TRS 同序）。 */
export function alignmentWorldOffset(
  size: [number, number],
  scale: [number, number, number],
  angles: [number, number, number],
  alignment?: string,
): [number, number] {
  const off = alignOffset(size[0], size[1], alignment);
  if (off.x === 0 && off.y === 0) return [0, 0];
  const v = new THREE.Vector3(off.x * scale[0], off.y * scale[1], 0)
    .applyEuler(new THREE.Euler(angles[0], angles[1], angles[2]));
  return [v.x, v.y];
}

function vec3Close(a: readonly number[], b: readonly number[]): boolean {
  return Math.abs(a[0]! - b[0]!) < 1e-6 && Math.abs(a[1]! - b[1]!) < 1e-6 && Math.abs(a[2]! - b[2]!) < 1e-6;
}

function warnUnsupportedTransform(host: BackgroundLayerHost, objectId: number, message: string): void {
  if (host.warnedUnsupportedTransform.has(objectId)) return;
  host.warnedUnsupportedTransform.add(objectId);
  console.warn(`[three] ${message}`);
}

/**
 * 时间线动画：按 scene 对象 id 写入**世界变换**。
 * 支持非隔离背景/puppet（mesh TRS）与非隔离粒子的 origin 平移增量（粒子内容由 shader 定位，
 * 写绝对中心会双重平移）；隔离对象（对象级效果链的合成 quad）暂不支持 → false + 告警一次。
 */
export function updateBackgroundTransform(
  host: BackgroundLayerHost,
  objectId: number,
  wt: { origin: [number, number, number]; scale: [number, number, number]; angles: [number, number, number] },
): boolean {
  // 防御畸形/非有限值：一条 NaN 会把 three 矩阵污染成整层消失。
  if (![wt.origin, wt.scale, wt.angles].every((v) => Array.isArray(v)
    && v.length >= 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n)))) return false;
  if (host.isIsolated(objectId)) {
    warnUnsupportedTransform(host, objectId,
      `隔离对象 ${objectId}（对象级效果链）的世界变换暂不支持时间线动画，已忽略`);
    return false;
  }
  const particle = host.particleOf(objectId);
  if (particle) {
    // 粒子内容由 shader 的 objCenter/objScale/objAngles 定位（顶点已在 worldPos 里），mesh 只能
    // 承载「相对装配期世界 origin 的平移增量」——applyLayerState 的绝对坐标写会被本方法覆盖掉。
    const dx = wt.origin[0] - particle.baseWorldOrigin[0];
    const dy = wt.origin[1] - particle.baseWorldOrigin[1];
    const dz = wt.origin[2] - particle.baseWorldOrigin[2];
    particle.mesh.position.set(dx, dy, dz);
    particle.mesh.scale.set(1, 1, 1);
    particle.mesh.rotation.set(0, 0, 0);
    if (!vec3Close(wt.scale, particle.baseWorldScale) || !vec3Close(wt.angles, particle.baseWorldAngles)) {
      warnUnsupportedTransform(host, objectId, `粒子对象 ${objectId} 的 scale/angles 时间线动画暂不支持（只应用 origin）`);
    }
    // 视差的屏幕位置基准跟随世界位移（它只影响 shift 计算，不参与平移本身）。
    particle.parallaxCenter = [
      wt.origin[0] - host.sceneWidth / 2,
      wt.origin[1] - host.sceneHeight / 2,
    ];
    return true;
  }
  const backgroundId = host.backgroundIdOf(objectId);
  if (backgroundId === undefined) return false;
  const entry = host.entryById(backgroundId);
  if (!entry) return false;
  // renderOffset：text 的 origin 含 anchorOffset（渲染中心 ≠ 对象锚点），补回才是 quad 中心。
  const ox = wt.origin[0] + entry.renderOffset[0];
  const oy = wt.origin[1] + entry.renderOffset[1];
  const oz = wt.origin[2] + entry.renderOffset[2];
  entry.origin = [ox, oy, oz];
  entry.scale = [wt.scale[0], wt.scale[1], wt.scale[2]];
  entry.angles = [wt.angles[0], wt.angles[1], wt.angles[2]];
  const align = alignmentWorldOffset(entry.size, entry.scale, entry.angles, entry.alignment);
  entry.align = [align[0], align[1]];
  entry.mesh.scale.set(entry.scale[0], entry.scale[1], entry.scale[2]);
  entry.mesh.rotation.set(entry.angles[0], entry.angles[1], entry.angles[2]);
  entry.mesh.position.set(
    ox - entry.sceneW / 2 + align[0],
    oy - entry.sceneH / 2 + align[1],
    oz,
  );
  entry.parallaxApplied = false; // 让 tickParallax 下一帧按新基准重写
  return true;
}

/**
 * 刷新背景图层的锚点偏移（renderOffset = 渲染中心 − 对象锚点）。文本标题/字号变化后
 * 由 text driver 按新 layout 调用；只记偏移，位置由随后的 update_background / syncWorld 写入。
 */
export function setBackgroundAnchorOffset(
  host: BackgroundLayerHost,
  backgroundId: number,
  offset: [number, number],
): boolean {
  const entry = host.entryById(backgroundId);
  if (!entry) return false;
  if (!Array.isArray(offset) || offset.length < 2
    || !offset.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  entry.renderOffset = [offset[0], offset[1], entry.renderOffset[2]];
  return true;
}

// 更新背景图层状态，对齐既有 update_image 语义——undefined = 保持现状；与当前状态相等的字段跳过；
// 未知 id → no-op。origin 是 WE 场景坐标，中心化后写承载位置的 node（隔离 = 合成 quad，内容 mesh 在 RT 内恒 0）。
export function updateBackground(
  host: BackgroundLayerHost,
  id: number,
  origin?: [number, number, number],
  scale?: [number, number, number],
  alpha?: number,
  brightness?: number,
): void {
  const entry = host.entryById(id);
  if (!entry) return;
  if (origin) {
    const [ox, oy, oz] = origin;
    if (ox !== entry.origin[0] || oy !== entry.origin[1] || oz !== entry.origin[2]) {
      entry.origin = [ox, oy, oz];
      entry.parallaxNode.position.set(
        ox - entry.sceneW / 2 + entry.align[0],
        oy - entry.sceneH / 2 + entry.align[1],
        oz,
      );
    }
  }
  if (scale) {
    const [sx, sy, sz] = scale;
    if (sx !== entry.scale[0] || sy !== entry.scale[1] || sz !== entry.scale[2]) {
      entry.scale = [sx, sy, sz];
      entry.mesh.scale.set(sx, sy, sz);
      // 锚点偏移随 scale 缩放；只有偏移真的变了才动位置（否则会把视差/脚本位移覆盖回基准位）。
      const align = alignmentWorldOffset(entry.size, entry.scale, entry.angles, entry.alignment);
      if (align[0] !== entry.align[0] || align[1] !== entry.align[1]) {
        entry.parallaxNode.position.x += align[0] - entry.align[0];
        entry.parallaxNode.position.y += align[1] - entry.align[1];
        entry.align = align;
      }
    }
  }
  if (alpha !== undefined) {
    const a = Math.max(0, Math.min(1, alpha));
    if (a !== entry.alpha) {
      entry.alpha = a;
      // colorBlendMode 背景用预乘 ShaderMaterial（opacity 是 uniform），其余用内置材质的 opacity。
      const mat = entry.mesh.material as THREE.MeshBasicMaterial | THREE.ShaderMaterial;
      if (mat instanceof THREE.ShaderMaterial) mat.uniforms.opacity.value = a;
      else mat.opacity = a;
    }
  }
  if (brightness !== undefined) {
    if (brightness !== entry.brightness) {
      entry.brightness = brightness;
      // brightness 调色：rgb = clamp01(color/255 × brightness)；color 缺省 = 白（不丢 image tint）。
      const mod = materialModulation(entry.color, entry.alpha, brightness);
      const mat = entry.mesh.material as THREE.MeshBasicMaterial | THREE.ShaderMaterial;
      if (mat instanceof THREE.ShaderMaterial) (mat.uniforms.tint.value as THREE.Vector3).set(mod.r, mod.g, mod.b);
      else mat.color.setRGB(mod.r, mod.g, mod.b);
    }
  }
}

// 文本图层 resize：按新画布尺寸重建 quad 几何（PlaneGeometry 尺寸不可变），scale 不变 ⇒
// 世界尺寸 = 新尺寸 × scale。未知 id / 尺寸未变 → no-op。
// ⚠️ 画布纹理必须 dispose：three r170 在 WebGL2 用**不可变** texStorage2D，画布尺寸变了以后
// texSubImage2D 越界、上传被 GL 静默丢弃 ⇒ 屏幕上仍是旧画布被拉伸；dispose 后才按新尺寸分配存储。
export function resizeBackground(host: BackgroundLayerHost, id: number, size: [number, number]): void {
  const entry = host.entryById(id);
  if (!entry) return;
  // puppet 图层（size=[0,0]）：几何是蒙皮网格自己的，换成 PlaneGeometry 会 dispose 掉它 ⇒ 早退。
  if (host.hasPuppetLayer(id)) return;
  const [w, h] = size;
  if (w === entry.size[0] && h === entry.size[1]) return;
  entry.size = [w, h];
  const old = entry.mesh.geometry;
  entry.mesh.geometry = new THREE.PlaneGeometry(w, h);
  old.dispose();
  // 精灵表图层：新几何的 UV 是整图 [0,1]² ⇒ 以它为新的 base 并立即重写当前帧子矩形。
  host.rebaseSpriteSheet(id);
  const map = (entry.mesh.material as { map?: THREE.Texture | null }).map;
  if (map && (map as THREE.CanvasTexture).isCanvasTexture) map.dispose();
}
