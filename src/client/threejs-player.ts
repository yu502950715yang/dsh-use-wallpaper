// three.js 播放器（renderer + 正交相机 cover + RAF 循环）。
//
// 坐标 / cover 语义与 scene-renderer.ts 同源（不重写，避免双份语义漂移）：
//   - coverRange(sceneW, sceneH, viewAspect)：场景固有尺寸（WE 正交视口 view_w×view_h）按视口
//     宽高比 cover 裁剪得相机视锥；视口缺省与场景同尺寸时 cover == 场景尺寸（无裁剪）。
//   - CAMERA_DISTANCE：相机沿 +z 放置，使 shader 里 300/-mv.z = 1（点尺寸 = 像素尺寸）。
//   - 正交相机 y 轴不翻转（WE 左下原点 y 向上与 three 正交相机一致，见 scene-renderer 文件头）。
import * as THREE from 'three';
// 几何/尺寸纯函数唯一实现在 object-range.ts（coverRange 在其处，scene-renderer 只做转手）。
import { coverRange, CAMERA_DISTANCE, materialModulation, createCompositeGeometry, flipGeometryUvY, screenScalePx } from './object-range.js';
// 对象 alignment：origin 是锚点，中心按锚点偏移（F13；与 text anchor 同口径）。
import { alignOffset } from './alignment.js';
import { parseSceneJson } from './scene-json.js';
// 渲染进对象 RT 必须透明清屏（清屏 alpha=0），否则内容透明处/效果降 alpha 处会变成不透明黑
// （根因见 rt-render.ts 与 AGENT.md §5.22）。
import { renderIntoRenderTarget } from './rt-render.js';
// 应用级 Glow 的注入点类型（装配在调用方）。
import type { GlowStage } from './glow-stage.js';
// 帧内快照：段渲染目标 + 消费者边界快照（语义 = WE 的 `_rt_FullFrameBuffer`）。
import type { FrameCapture } from './frame-capture.js';
// 段渲染末段把 frameRT 全屏合成回默认 fb（Glow 关闭时用）。
import { createCompositeQuad } from './composite-quad.js';
import type { CompositeQuad } from './composite-quad.js';
// 文本图层：帧内文本变化 → 按新 layout 同步 quad 尺寸与锚点中心（textLayerOffset）。
import { textLayerOffset } from './text-object.js';
import type { ClockDriver, TextLayout } from './text-object.js';
// 视差（Task 1 的纯数学层）：配置 + 指针 + 延迟插值 + 逐对象位移公式；唯一应用点 = 本文件的 tickParallax。
import { POINTER_CENTER, advancePointer, parallaxShift } from './parallax.js';
import type { ParallaxConfig, PointerFollow, PointerState } from './parallax.js';
// puppet（.mdl 蒙皮网格）：实例由调用方装配，本类只负责挂进场景、逐帧采样动画与释放。
import type { PuppetInstance } from './puppet.js';
// 动画层元数据（scene.json 的 `animationlayers`）类型取自 shared 的字段声明，避免两处漂移。
import type { SceneImageObject, UtilLayerKind } from '../shared/types.js';
// util 层内置材质（v0.8.2 F2）：solid 纯色 / 其余直通，与 pkg 纹理无关。
import { resolveUtilMaterial, type UtilMaterialSpec } from './util-material.js';
// 静态隐藏判定（visible:false / 用户属性关）：装配期跳过，避免无纹理 quad 渲染成白色全屏层。
import { isStaticallyHidden } from './visibility.js';
// 首帧缓存抓帧：GL 像素行序翻转 + PNG 编码（纯函数层，node 可注入 encoder 单测）。
import { readPixelsToPng, type ReadPixelsGl } from './frame-export.js';

// 背景图层条目：记录 WE 场景坐标与当前已应用状态，供 update_background 对齐既有
// update_image 语义（undefined = 保持现状；无变化则跳过）。
type BackgroundEntry = {
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
  // 视差：node = 实际承载世界位置的 three 对象（非隔离 = mesh，隔离 = 合成 quad）；
  // depth 来自 scene.json 的 parallaxDepth（缺省 undefined = 不参与视差）。
  parallaxNode: THREE.Object3D;
  parallaxDepth?: [number, number];
  // 本类**当前**是否在该 node 上留着位移（true ⇒ 关视差时写回一次基准位；见 tickParallax）。
  parallaxApplied?: boolean;
};

// image 精灵表图层：按 TEXS 帧网格逐帧把当前帧子矩形写进 quad 的 uv（材质 combos.spritesheet=1）。
// 帧率缺省 1fps（TEXS 的 frametime 未解析；WE 的 sequencemultiplier 在 image 材质中不存在）。
type SpriteSheetLayer = {
  // 所属背景图层计数器 id（resizeBackground 换几何后按它找回本层重写 UV）。
  backgroundId: number;
  mesh: THREE.Mesh;
  frames: number;
  cols: number;
  rows: number;
  elapsed: number;       // 已播秒数（dt 累加，不跟墙钟）
  fps: number;
  frame: number;         // 当前帧号（-1 = 尚未写入）
  // 脚本 pause 后不再自动推进（play 恢复）；无脚本控制时保持 v0.8.1 的自动播放。
  paused: boolean;
  // 原始（整图 [0,1]²）UV：每次按 base 重算子矩形——在已写过的 UV 上再映射会逐帧累积漂移。
  baseUv: Float32Array;
  uv: { u0: number; v0: number; u1: number; v1: number };
};

// 粒子图层条目：记录 three.js billboard quad 的 GPU 资源与配套模拟取顶点 getter。
// 每粒子一个**实例**（InstancedBufferGeometry 的 instanced attribute），顶点 shader 由
// 基础四边形角点（position=[-1,1]²）+ 每粒子位置/尺寸展开成屏幕对齐的 billboard。
type ParticleLayer = {
  id: number;
  // 每粒子数据来自 wasm `SceneParticleSim::build_instance_vertices`（摊平 Float32Array，
  // 每粒子 `[pos3,size,uv2,color3,alpha,rot3,vel3]` 16 浮点）。getter 每帧刷新时返回当前顶点。
  getter: () => Float32Array;
  frameCount: number;
  geometry: THREE.InstancedBufferGeometry;
  material: THREE.ShaderMaterial;
  // 承载 billboard quad 的 mesh（每粒子一个实例）。frustumCulled=false（粒子散布在场景，
  // 不用基础四边形包围球做视锥剔除，防对象中心离屏时整层被裁掉）。
  mesh: THREE.Mesh;
  // 各 instanced attribute（per-particle），updateParticles 直接写其 Float32Array + needsUpdate。
  positions: THREE.InstancedBufferAttribute;
  sizes: THREE.InstancedBufferAttribute;
  uvs: THREE.InstancedBufferAttribute;
  colors: THREE.InstancedBufferAttribute;
  alphas: THREE.InstancedBufferAttribute;
  // 粒子欧拉角（弧度，逐粒子三分量）与速度（世界单位/秒，spritetrail 用它算拖尾拉伸方向）。
  rots: THREE.InstancedBufferAttribute;
  velocities: THREE.InstancedBufferAttribute;
  // 实例缓冲**容量**（= 每个 instanced attribute 的 count，即一次能画的最大粒子数）。
  // ⚠️ three 只在**首次渲染**时把容量锁存进 `geometry._maxInstanceCount`（见 addParticle），
  // 故必须一次给足（sim 的 maxcount），运行期只改 `geometry.instanceCount`（0..capacity）。
  capacity: number;
  // 「粒子已产出」日志只打一次（首帧 instanceCount 由 0 变正时），防每帧刷屏。
  loggedFirstFrame: boolean;
  // 已记录过的粒子数（倍增/满池时再记一条，见 updateParticles）——供真机 console 看到计数增长
  // （旧日志只在首帧非零时打一条 count=1，极易被误读为「只发射了 1 个粒子」）。
  loggedCount: number;
  // 折射层（材质 combo REFRACT=1）：defines 里有 REFRACT，段边界快照写进 uniforms.refractBg。
  refract: boolean;
  // 折射诊断日志只打一次（首帧真的把快照接进 refractBg 时）。
  loggedRefract: boolean;
  // 视差：parallaxDepth 来自 scene.json；世界位移的落点分两处 —— 非隔离层写顶点 shader 的
  // u_Parallax（worldPos 偏移），隔离层必须写合成 quad 的 position（内容进对象 RT，在 RT 内
  // 平移会被 RT 边界裁掉）。parallaxCenter = objCenter 的 x/y（three 世界坐标）。
  parallaxDepth?: [number, number];
  parallaxCenter: [number, number];
  parallaxQuad?: THREE.Object3D;
  // opts.isolate 有值（= 本层渲染进对象 RT）即真：quad 意外缺失时 tickParallax 靠它跳过本层，
  // 不退化写 u_Parallax（RT 内平移会被 RT 边界裁掉）。
  parallaxIsolated?: boolean;
  // 本类**当前**是否在该层上留着位移（true ⇒ 关视差时写回一次；见 tickParallax）。
  parallaxApplied?: boolean;
};

// 粒子实例缓冲的**缺省容量**：每个 instanced attribute 的 count 必须 ≥ 模拟器最终产出的粒子数
// （sim 的 `maxcount`，WE spec 的 maxcount 字段）；上限与 wasm 粒子池 clamp [16, 2048]
// （render/particle_pass.rs）对齐，防异常 spec 爆内存。
export const DEFAULT_PARTICLE_CAPACITY = 1024;
export const MAX_PARTICLE_CAPACITY = 2048;

// 每粒子摊平顶点浮点数 = Rust `SceneParticleSim::build_instance_vertices` 的布局长度
// （`[pos3, size, uv2, color3, alpha, rot3, vel3]`）。⚠️ 与 wasm 侧是**同一份契约**：
// 改布局必须两侧同时改（Rust 用 `build_instance_vertices_flat_per_particle` 钉住 16）。
export const PARTICLE_FLOATS_PER_INSTANCE = 16;

// 从粒子 spec JSON 读 `maxcount`（= wasm `SceneParticleSim.maxcount`；WE 的 JSON 里也可能是
// 字符串 "50"）。缺省/非法/非正 → 0（调用方落到 DEFAULT_PARTICLE_CAPACITY）。
export function specMaxcount(specJson: string): number {
  try {
    const v = (JSON.parse(specJson) as { maxcount?: unknown }).maxcount;
    const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : 0;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

// 粒子渲染器（spec 顶层 `renderer[0]`）—— 缺省值与 wasm `parse_particle_spec` / WE/lwe/OWE
// 口径一致（length 0.05、maxlength 10、minlength 0）；rope/ropetrail 也按 sprite 兜底。
export interface ParticleRendererSpec {
  kind: 'sprite' | 'spritetrail';
  length: number;
  maxLength: number;
  minLength: number;
}

// 解析 spec JSON 的 `renderer[0]`。非法/缺失 → sprite（不启用拖尾，行为与旧版一致）。
export function specRenderer(specJson: string): ParticleRendererSpec {
  const sprite: ParticleRendererSpec = { kind: 'sprite', length: 0.05, maxLength: 10, minLength: 0 };
  try {
    const raw = (JSON.parse(specJson) as { renderer?: unknown }).renderer;
    const first = Array.isArray(raw) ? (raw[0] as { name?: unknown } | undefined) : undefined;
    if (!first || typeof first.name !== 'string' || first.name !== 'spritetrail') return sprite;
    const num = (v: unknown, dflt: number): number => {
      const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
      return Number.isFinite(n) ? n : dflt;
    };
    const r = first as { length?: unknown; maxlength?: unknown; minlength?: unknown };
    return {
      kind: 'spritetrail',
      length: num(r.length, 0.05),
      maxLength: num(r.maxlength, 10),
      minLength: num(r.minlength, 0),
    };
  } catch {
    return sprite;
  }
}

// 粒子纹理的「高/宽」比（WE `g_Texture0Resolution.y / g_Texture0Resolution.x`）：
// 精灵表按**单帧**尺寸算（WE 的 SPRITESHEET 分支用 g_RenderVar1.w = 单帧宽高比）；
// 缺省 1（无纹理 / 尺寸未知）。
export function textureTexelRatio(tex?: THREE.Texture): number {
  const grid = textureSpriteInfo(tex);
  const img = (Array.isArray(tex?.image) ? tex?.image[0] : tex?.image) as
    | { width?: unknown; height?: unknown }
    | undefined;
  if (!img || typeof img.width !== 'number' || typeof img.height !== 'number' || img.width <= 0 || img.height <= 0) {
    return 1;
  }
  const frameW = grid ? img.width / grid.cols : img.width;
  const frameH = grid ? img.height / grid.rows : img.height;
  return frameH / frameW;
}

// spec.flags 的 perspective 位（bit2 = 4，OWE `ParticleObject.cppm:97` `perspective = 2, // 4`）：
// 带该位时 WE 会给粒子对象换挂 `global_perspective` 相机（`SceneParticleObjectParser.cpp:397-398`），
// 粒子因此有强烈的近大远小。非法/缺失 → false（保持正交）。
export function specPerspective(specJson: string): boolean {
  try {
    const raw = (JSON.parse(specJson) as { flags?: unknown }).flags;
    const n = typeof raw === 'string' ? parseFloat(raw) : typeof raw === 'number' ? raw : 0;
    return Number.isFinite(n) && (Math.floor(n) & 4) !== 0;
  } catch {
    return false;
  }
}

// 「稀疏事件源」粒子：spec 同时满足 ① children 含 type=eventspawn ② maxcount ≤ 1
// ③ emitter[0].rate < 1。桌面**不渲染**这类粒子（本插件会画出直径约 200px 的白色柔光斑），
// 但机制未明（官方文档与 OWE/lwe 都认为此类父粒子应正常渲染）⇒ 本条按**观测**对齐，
// 条件收窄到全库只命中该壁纸的 26 个对象。非法/缺失 → false。
export function specSparseEventSource(specJson: string): boolean {
  try {
    const spec = JSON.parse(specJson) as { children?: unknown; maxcount?: unknown; emitter?: unknown };
    const children = Array.isArray(spec.children) ? spec.children : [];
    const hasEventSpawn = children.some((c) => (c as { type?: unknown } | null | undefined)?.type === 'eventspawn');
    if (!hasEventSpawn) return false;
    const maxcount = typeof spec.maxcount === 'string' ? parseFloat(spec.maxcount) : spec.maxcount;
    if (typeof maxcount !== 'number' || !Number.isFinite(maxcount) || maxcount > 1) return false;
    const first = Array.isArray(spec.emitter) ? (spec.emitter[0] as { rate?: unknown } | undefined) : undefined;
    const rate = typeof first?.rate === 'string' ? parseFloat(first.rate) : first?.rate;
    return typeof rate === 'number' && Number.isFinite(rate) && rate < 1;
  } catch {
    return false;
  }
}

// WE 的粒子透视相机参数（正交场景内）：
//   fov      = general.perspectiveoverridefov（>0 时），否则按**固定 1000 距离**反算
//   distance = 场景高 / (2·tan(fov/2))
// 对应 OWE `Algorism.cpp:8-17` 的 CalculatePersperctiveDistance / CalculatePersperctiveFov
// 与 `SceneObjectParsers.cpp:59-85`（相机置于 (center.x, center.y, distance)，看向 z=0 平面）。
export function particlePerspectiveCamera(opts: {
  fov: number;
  perspectiveOverrideFov: number;
  sceneH: number;
}): { fov: number; distance: number } {
  const height = Number.isFinite(opts.sceneH) && opts.sceneH > 0 ? opts.sceneH : 1080;
  const override = Number.isFinite(opts.perspectiveOverrideFov) ? opts.perspectiveOverrideFov : 0;
  if (override > 0) {
    const fov = override;
    const k = Math.tan(((fov / 2) * Math.PI) / 180) * 2;
    return { fov, distance: k > 0 ? height / k : 1000 };
  }
  // 无 override：距离固定 1000，fov 由它反算（OWE CalculatePersperctiveFov）。
  const distance = 1000;
  const k = height / distance / 2;
  const fov = ((Math.atan(k) * 2) * 180) / Math.PI;
  return { fov, distance };
}

// 由 WE 的透视相机参数构造**视图投影矩阵**（相机位于 (0,0,distance)、看向 -z、up=+Y，
// 对应 OWE 把 global_perspective 节点放在场景中心 x/y + z=distance）。
// near/far 只参与深度裁剪（正交场景里 WE 用反转 Z 5..15000），顶点 shader 会把 clip.z 归中（0），
// 故不影响可见性。缺省（未启用）返回单位透视矩阵 —— uniform 恒为合法 mat4。
function particlePerspMatrix(p?: { fov: number; distance: number; aspect: number }): THREE.Matrix4 {
  if (!p) return new THREE.Matrix4();
  const cam = new THREE.PerspectiveCamera(p.fov, p.aspect > 0 ? p.aspect : 1, 1, 1e6);
  cam.position.set(0, 0, p.distance);
  cam.updateProjectionMatrix();
  cam.updateMatrixWorld(true);
  return new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
}

// 从粒子 spec JSON 读 **emitter 的局部原点**（`emitter[0].origin`，WE 字符串 "x y z"）。
// 只用**第一个** emitter、缺省 [0,0,0]、y **不翻**（本仓库 three 路径与背景同系）。
// 非法/缺失 → [0,0,0]（绝不抛）。
export function specEmitterOrigin(specJson: string): [number, number, number] {
  const zero: [number, number, number] = [0, 0, 0];
  try {
    const spec = JSON.parse(specJson) as { emitter?: unknown };
    const list = spec.emitter;
    const first = Array.isArray(list) ? (list[0] as { origin?: unknown } | undefined) : undefined;
    const raw = first?.origin;
    if (typeof raw !== 'string') return zero;
    const parts = raw.trim().split(/\s+/).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) return zero;
    return [parts[0], parts[1], parts[2]];
  } catch {
    return zero;
  }
}

// wasm `SceneParticleSim` 在 spawn 时对**发射点**乘的硬编码对象 scale（wasm/src/particle/sim.rs
// `BLACKMYTH_OBJ_SCALE`）。three 路径的顶点 shader 要从模拟器输出里**减掉**这项才能拿到纯局部
// 坐标（散射 + 运动），再按真实对象 scale 重建 ⇒ 必须与 wasm 常量逐位一致（改动需同步）。
export const BLACKMYTH_OBJ_SCALE: [number, number, number] = [-2.05166, 2.1167, 1.0];

// 计算模拟器已加入 `particlePosition` 的发射点偏移：`BLACKMYTH_OBJ_SCALE ⊙ emitterOrigin`。
export function simEmitterOffset(emitterOrigin: [number, number, number]): [number, number, number] {
  return [
    emitterOrigin[0] * BLACKMYTH_OBJ_SCALE[0],
    emitterOrigin[1] * BLACKMYTH_OBJ_SCALE[1],
    emitterOrigin[2] * BLACKMYTH_OBJ_SCALE[2],
  ];
}

// 计算实例缓冲容量：declaredMax（spec 的 maxcount，0 = 未声明）优先，否则缺省；
// 再 clamp 到 [1, MAX_PARTICLE_CAPACITY]，并保证 ≥ 建层当帧已有的粒子数。
export function particleCapacity(declaredMax: number, aliveAtCreate: number): number {
  const declared = Number.isFinite(declaredMax) && declaredMax > 0 ? Math.floor(declaredMax) : 0;
  const cap = Math.min(declared > 0 ? declared : DEFAULT_PARTICLE_CAPACITY, MAX_PARTICLE_CAPACITY);
  return Math.max(1, cap, Math.max(0, Math.floor(aliveAtCreate)));
}

// 4 角点单位四边形（[-1,1]²，z=0）：作为 InstancedBufferGeometry 的基础顶点 position（角点），
// 顶点 shader 用它展开 billboard（pos + corner*half_size）。索引 [0,1,2, 0,2,3] 组成 2 个三角形
// （从 +z 相机方向看为逆时针 → FrontSide 可见）。
const PARTICLE_QUAD_CORNERS = new Float32Array([
  -1, -1, 0,
   1, -1, 0,
   1,  1, 0,
  -1,  1, 0,
]);
const PARTICLE_QUAD_INDEX: [number, number, number, number, number, number] = [0, 1, 2, 0, 2, 3];

// 粒子 billboard 顶点 shader：每粒子一个实例，基础四边形 position=[-1,1]² 作角点，
// worldPos = particlePosition + corner*half_size（half_size = particleSize/2，corner 先绕
// particleRot 自旋），再用 mvp 投影。只需补每粒子 instanced 属性（particlePosition/Size/Uv/
// Color/Alpha/Rot）与 varyings；position/normal/uv/矩阵由 three.js 自动注入。
const PARTICLE_VERTEX_SHADER = `
attribute vec3 particlePosition;
attribute float particleSize;
attribute vec2 particleUv;
attribute vec3 particleColor;
attribute float particleAlpha;
// 粒子欧拉角（弧度，**逐分量**）：由模拟器的 rotationrandom 初始化、
// angularmovement 每帧逐分量推进（p.rot[k] += angular_vel[k]*dt）。
attribute vec3 particleRot;
// 粒子当前速度（世界单位/秒，来自 wasm 顶点流末 3 浮点）。仅 spritetrail 渲染器消费。
attribute vec3 particleVelocity;
// 对象变换（WE 的粒子 model matrix 语义，见 loadSceneToThree 注释）：
//   objCenter     对象中心（世界坐标，we_to_three 后）
//   objScale      scene.json 的对象 scale（逐轴，可为负 = 镜像）
//   emitterOrigin spec 的 emitter 局部原点（原值，未缩放）
//   bmOffset      模拟器已加进 particlePosition 的偏移 = BLACKMYTH_OBJ_SCALE ⊙ emitterOrigin
uniform vec3 objCenter;
uniform vec3 objScale;
uniform vec3 emitterOrigin;
uniform vec3 bmOffset;
// spritetrail（WE genericparticle.vert + TRAILRENDERER combo）：
//   trailEnabled  1 = 按速度方向拉伸 billboard（renderer[0].name == "spritetrail"），0 = 原旋转 billboard
//   trailParams   (length, maxlength, minlength) —— 即 WE 的 g_RenderVar0.xyz
//   texelRatio    纹理 高/宽（WE g_Texture0Resolution.y/.x）；沿拖尾方向按它补偿纹理长宽比
uniform float trailEnabled;
uniform vec3 trailParams;
uniform float texelRatio;
// 粒子透视相机（spec.flags 的 perspective 位）：
//   perspEnabled  1 = 该层用 WE 的 global_perspective 相机投影（近大远小），0 = 主正交相机
//   persp         该透视相机的**视图投影矩阵**（相机在 (0,0,distance)，看向 -z）——
//                 shader 里的 worldPos 已是世界坐标，故直接相乘、不再叠 modelViewMatrix
//   perspEye      相机眼位（世界坐标）= WE 的 g_EyePosition，供 trail 逐粒子算 eyeDirection
uniform float perspEnabled;
uniform mat4 persp;
uniform vec3 perspEye;
// 对象欧拉角（**弧度**）—— WE model matrix = T·R·S 的 R 部分。
uniform vec3 objAngles;
// 对象级视差的**世界平移**（tickParallax 逐帧写；0 = 关视差）。等价于把整个对象沿世界轴平移，
// 与 model matrix 的 T 同语义 ⇒ 加在 worldPos 组装完成之后、投影之前。
uniform vec2 u_Parallax;
#ifdef REFRACT
// 屏幕空间折射（WE genericparticle.vert 的 REFRACT 分支）：位移强度来自材质
// ui_editor_properties_refract_amount，片元用它算屏幕 UV 偏移后采背景快照。
uniform float refractAmount;
varying vec3 vScreenCoord;      // gl_Position.xyw（.z 即 w，供片元做透视除法）
varying vec4 vScreenTangents;   // (rRight.x, rUp.x, rRight.y, rUp.y) * refractAmount
#endif
varying vec2 vCornerUv;
varying vec2 vParticleUv;
varying vec3 vParticleColor;
varying float vParticleAlpha;
// 对象旋转 R = Rz·Ry·Rx（官方 order：OWE ParticleRuntime.cpp:25-28 ControlpointRotation）。
// 每个分量都是右手系绕轴的主动旋转，与 Eigen AngleAxisd(theta, axis) 一致。
vec3 weObjectRotate(vec3 v, vec3 a) {
  float cx = cos(a.x), sx = sin(a.x);
  v = vec3(v.x, v.y * cx - v.z * sx, v.y * sx + v.z * cx);
  float cy = cos(a.y), sy = sin(a.y);
  v = vec3(v.x * cy + v.z * sy, v.y, -v.x * sy + v.z * cy);
  float cz = cos(a.z), sz = sin(a.z);
  return vec3(v.x * cz - v.y * sz, v.x * sz + v.y * cz, v.z);
}
void main() {
  vCornerUv = position.xy * 0.5 + 0.5;
  vParticleUv = particleUv;
  vParticleColor = particleColor;
  vParticleAlpha = particleAlpha;
  // 还原模拟器输出的**局部**坐标（剔除对象中心与模拟器已加的发射点偏移）：
  //   particlePosition = objCenter + bmOffset + (散射 + 运动)
  vec3 local = particlePosition - objCenter - bmOffset;
  // 按对象 model matrix 的 **R·S** 变换到场景空间（WE：mvp = viewProj × translate(origin)
  // × rotate(angles) × scale）。⚠️ 旋转**必须**在这里做：漏掉它会让粒子的局部朝向直接当世界
  // 朝向用 —— GTR 3743126786 的烟柱 angles.z = -1.20063 本应把局部 +Y（湍流的 forward）转到
  // 世界 (0.932, 0.362)（「从排气管向右侧飘」），漏掉旋转后烟就直着往上走。
  vec3 worldPos = objCenter + weObjectRotate(objScale * (emitterOrigin + local), objAngles);
  // 粒子 quad 的尺寸同样乘对象 scale（非均匀；abs 去掉镜像的符号）并随对象角度一起转；自旋先于对象
  // 旋转（WE ComputeParticleTangents，common_particles.h；R = Rz·Ry·Rx 与对象角度同一约定）。
  if (trailEnabled > 0.5 && length(particleVelocity) > 1e-6) {
    // spritetrail：复刻 WE ComputeParticleTrailTangents / ComputeParticlePosition（common_particles.h:42-59）——
    //   right = normalize(cross(eyeDirection, velocity))
    //   up    = normalize(velocity) * clamp(|velocity| * length, minlength, maxlength)
    //   pos   = p + size*right*(u-0.5) + size*up*(v-0.5)*textureRatio
    // |v|=0 的退化已在外层排除（避免 WE 的 normalize(0) NaN）。
    //
    // ⚠️ 符号：WE 原文是 minus size*up*(v-0.5)*ratio，其 v=0 是**纹理顶行**；本插件的纹理经
    // tex-loader 行反转（v=1 = 图像顶行，与 sprite 路径「corner +Y ↔ 图像顶行」自洽），故这里取
    // **正**号，让图像上端（雨滴亮头）落在 +速度方向 —— 否则拖尾头尾颠倒。
    // 正交相机的视线方向是常数（= viewMatrix 的相机 +Z 取反）；透视相机下逐粒子为 worldPos - eye。
    vec3 eyeDir = perspEnabled > 0.5
      ? normalize(worldPos - perspEye)
      : -normalize((viewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
    float speed = length(particleVelocity);
    vec3 right = normalize(cross(eyeDir, particleVelocity));
    float trailLen = clamp(speed * trailParams.x, trailParams.z, trailParams.y);
    vec3 up = (particleVelocity / speed) * trailLen;
    vec2 quadUv = position.xy * 0.5 + 0.5;
    vec3 offset = particleSize * (right * (quadUv.x - 0.5) + up * (quadUv.y - 0.5) * texelRatio);
    worldPos += weObjectRotate(abs(objScale) * offset, objAngles);
  } else {
    // sprite（既有路径，逐字不变）：三轴欧拉旋转 quad 角点；|v|=0 的 spritetrail 也退到这里
    // （WE 的 normalize(0) 会产出 NaN、粒子消失，本插件选择画出 size 方块而不是丢粒子）。
    vec3 spun = weObjectRotate(vec3(position.xy, 0.0), particleRot);
    vec3 corner = weObjectRotate(abs(objScale) * (spun * particleSize * 0.5), objAngles);
    worldPos += corner;
  }
  // 视差：沿世界轴平移整个对象（0 = 逐字不变）。
  worldPos.x += u_Parallax.x;
  worldPos.y += u_Parallax.y;
  // 投影：带 spec.flags perspective 位的粒子层走 WE 的 global_perspective 相机（近大远小），
  // 其余层走 three 注入的主（正交）投影矩阵 —— 非透视层的通路逐字不变（零回归）。
  // ⚠️ 透视分支用 persp（视图投影矩阵）直接乘 worldPos（已是世界坐标），**不**再乘 modelViewMatrix
  // （后者带的是主正交相机的视图）。
  gl_Position = perspEnabled > 0.5
    ? persp * vec4(worldPos, 1.0)
    : projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
  // ⚠️ 粒子是 2D billboard（无深度排序，z 不参与可见性）⇒ 把 NDC z 强制归中（0），配合
  // material.depthTest=false（忽略深度），保证散射到 ±750 的粒子不被相机 near/far 裁剪掉
  // （对齐 wasm billboard 的 clip.z=0 语义，见 particle_billboard.wgsl）。
  gl_Position.z = 0.0;
#ifdef REFRACT
  // 折射切线基（屏幕空间位移方向）：与上面 quad 角点展开**同一旋转约定与同一次序**
  // （先粒子自旋、再对象角度），对齐 WE ComputeParticleTangents（common_particles.h:26-39
  // 先算粒子切线、再由对象 orientation 变换；genericparticle.vert:85,117 同序）。
  // vScreenCoord 必须在 gl_Position 之后取。
  vec3 rRight = normalize(weObjectRotate(weObjectRotate(vec3(1.0, 0.0, 0.0), particleRot), objAngles));
  vec3 rUp = normalize(weObjectRotate(weObjectRotate(vec3(0.0, 1.0, 0.0), particleRot), objAngles));
  vScreenCoord = gl_Position.xyw;
  vScreenTangents = refractAmount * vec4(rRight.x, rUp.x, rRight.y, rUp.y);
#endif
}
`;

// 粒子 billboard fragment shader：多帧 uv 切片（frameCount，uv.x 帧子区，y 占满整高）→
// 采样纹理 → color*texel.rgb、alpha=texel.a*particle.alpha；softness 做中心→边缘软衰减。
// 混色（additive/alpha）由 three.js material.blending 承担，这里只输出 RGBA。
// 形状对齐 wasm `particle_billboard.wgsl` 的 mask_mode：
//   - mask_mode=1（真实纹理）：shape = texel.a（**不再额外乘圆盘**），保住光线/花瓣的形状；
//   - mask_mode=0（无纹理 1×1 白图兜底）：shape = 软圆盘（disk，softness 控制边缘）。
const PARTICLE_FRAGMENT_SHADER = `
uniform sampler2D map;
uniform float frameCount;
uniform float frameCols;
uniform float frameRows;
uniform float softness;
uniform float maskMode;
#ifdef REFRACT
// 折射层：refractNormal = 槽 1（法线/遮罩，与槽 0 同一帧子区 UV），refractBg = 本帧场景快照。
uniform sampler2D refractNormal;
uniform sampler2D refractBg;
varying vec3 vScreenCoord;
varying vec4 vScreenTangents;
#endif
varying vec2 vCornerUv;
varying vec2 vParticleUv;
varying vec3 vParticleColor;
varying float vParticleAlpha;
void main() {
  float n = max(frameCount, 1.0);
  // 帧号由 uv.x 编码（帧子区中心，sim frame_center_uv：(frame+0.5)/n）→ 反解出离散帧号。
  float frameIndex = floor(clamp(vParticleUv.x, 0.0, 0.999999) * n);
  frameIndex = min(frameIndex, n - 1.0);
  // 精灵表按**二维网格**切片（frameCols×frameRows；非精灵表 cols=n、rows=1）：WE 的 8×8=64 帧
  // 精灵表（DK 的 fire1/fog1）用横向等分会把每条 1/64 宽的**竖条**当一帧，必须按行列定位。
  float cols = max(frameCols, 1.0);
  float rows = max(frameRows, 1.0);
  float col = mod(frameIndex, cols);
  float row = floor(frameIndex / cols);
  // 帧 y：TEXS 的帧 y 是**纹理顶部向下**的行号，而 DataTexture 数据已被翻转为 bottom-up
  // （v=0=图像底部）→ row=0（表顶行）应落在 v 高段，故对帧内 v 做 (rows-1-row) 反转。
  float frameV = (rows - 1.0 - row + vCornerUv.y) / rows;
  vec2 texUv = vec2((col + vCornerUv.x) / cols, frameV);
  vec4 texel = texture2D(map, texUv);
  vec3 rgb = vParticleColor * texel.rgb;
#ifdef REFRACT
  // 屏幕空间折射（WE genericparticle.frag:103-116 逐行）：法线取 R/G/A 通道，位移再乘遮罩与粒子 alpha。
  vec4 nrm = texture2D(refractNormal, texUv);
  float nx = nrm.a * 2.0 - 1.0;
  float ny = nrm.g * 2.0 - 1.0;
  float mask = nrm.r;
  vec2 off = vScreenTangents.xy * nx + vScreenTangents.zw * ny;
  off.y = -off.y;
  off *= mask * vParticleAlpha;
  vec2 rsUv = vScreenCoord.xy / vScreenCoord.z * 0.5 + 0.5 + off;
  rgb *= texture2D(refractBg, rsUv).rgb;
#endif
  // 圆盘软衰减（center→edge）。softness ∈ [0,1]：0=硬边（仅在 quad 边缘收尾），1=全柔。
  float dist = length(vCornerUv - 0.5) * 2.0;
  float edgeStart = clamp(1.0 - softness, 0.0001, 0.9999);
  float disk = 1.0 - smoothstep(edgeStart, 1.0, dist);
  // mask_mode：1（真实纹理遮罩，形状=texel.a）↔ 0（无纹理软圆点，形状=disk）。
  float shape = mix(disk, texel.a, maskMode);
  float a = vParticleAlpha * shape;
  gl_FragColor = vec4(rgb, a);
}
`;

// 无纹理（opts.tex 缺省）时的 1×1 白色兜底（同 scene-renderer.createWhiteDataTexture 语义）：
// 纯色粒子不依赖纹理内容，颜色/透明度由 vParticleColor/vParticleAlpha 给定。
function createWhiteTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

// ── WE 图像颜色混合模式（`colorBlendMode` → shader combo `BLENDMODE`）────────────────────────
//
// image 对象带 `colorBlendMode != 0` 时 WE 会**额外追加一遍混合 pass**（材质
// `materials/util/effectpassthrough.json`，shader = `genericimage3`；lwe `CImage.cpp:751-767`），片元逻辑：
//   rgb = ApplyBlending(BLENDMODE, screen.rgb, gl_FragColor.rgb, gl_FragColor.a);  a = screen.a
// `ApplyBlending`（`shaders/common_blending.h`）= `mix(A, F(A,B), op)`，A=背景、B=对象颜色、op=对象
// alpha ⇒ three 侧用 `CustomBlending` + **预乘片元**（rgb × alpha）复刻，使
// `result = src·srcFactor + dst·dstFactor` 与 `mix(A, F(A,B), op)` 等价。已实现的三个模式
// （= 全库仅有的三个非零值）：7 Screen（src=op·B, srcFactor=ONE_MINUS_DST_COLOR, dst=ONE —— B=0
// 时结果 = A ⇒ **黑底完全不改变背景**）、31 A+B·op（src=op·B, ONE/ONE）、6 Lighten（equation=MAX）。
// 其余模式（1..5/8..30/32）未实现 → 返回 null，调用方回退普通 alpha 混合（不静默画错）。
/** WE `colorBlendMode` → three `CustomBlending` 设置；未实现的模式返回 null。 */
export function colorBlendModeToThree(mode: number): {
  blendEquation: THREE.BlendingEquation;
  blendSrc: THREE.BlendingSrcFactor | THREE.BlendingDstFactor;
  blendDst: THREE.BlendingDstFactor;
} | null {
  switch (mode) {
    case 7: // Screen
      return { blendEquation: THREE.AddEquation, blendSrc: THREE.OneMinusDstColorFactor, blendDst: THREE.OneFactor };
    case 31: // A + B×opacity（加算）
      return { blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor };
    case 6: // Lighten（op≈1 时 = max(A,B)）
      return { blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor };
    default:
      return null;
  }
}

// 带 colorBlendMode 的背景片元 shader：与 MeshBasicMaterial 的贴图路径语义一致
// （纹理 × tint，alpha = texel.a × opacity），但**预乘输出** —— WE 公式里需要 `op·B`
// （op = 对象 alpha），不预乘就拿不到这个乘数（`ONE_MINUS_DST_COLOR` 等因子只看 dst）。
const COLOR_BLEND_FRAGMENT_SHADER = `
uniform sampler2D map;
uniform vec3 tint;
uniform float opacity;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(map, vUv);
  float a = c.a * opacity;
  gl_FragColor = vec4(c.rgb * tint * a, a);
}
`;

const COLOR_BLEND_VERTEX_SHADER = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// 对象隔离条目（对象级效果链）：带 effects 的对象不直接画进主场景，而是
//   ① 内容进 localScene（对象中心 = 局部原点），渲染到 rt；
//   ② 主场景放一张合成 quad 顶在对象原位置，采样「效果链输出」或「rt 原图」。
// 局部内容只保留 scale（含负值镜像），position/rotation 归零 —— 效果因此作用在对象**自身
// 纹理空间**，旋转与位移由合成 quad 承载。
// rtWidth/rtHeight/rtTexture 是给效果链编排器的扁平视图（免它通过 rt 再取一层）。
export interface IsolatedObject {
  /** 键 = scene.json 的**对象 id**（不是本类图层的计数器 id，见 attachIsolated 注释）。 */
  id: number;
  kind: 'background' | 'particle';
  rt: THREE.WebGLRenderTarget;
  rtWidth: number;
  rtHeight: number;
  rtTexture: THREE.Texture;
  localScene: THREE.Scene;
  localCamera: THREE.OrthographicCamera;
  quad: THREE.Mesh;
  /** 合成 quad 的世界尺寸（= |对象 size/dist × scale|，未钳制幅值），resize 重建几何时用。 */
  worldW: number;
  worldH: number;
}

// 效果链编排器注入点（结构化接口，player 不 import object-effects.ts）。
// 隔离内容的渲染由 player 自己的私有方法完成（renderIsolatedContents），stage 只承担
// 「把合成 quad 绑到效果输出」与「推进链」两件事。
export interface ObjectEffectStage {
  bindOutputs(): void;
  advance(time: number): void;
  /** 段边界（消费者被绘制**之前**）同步通知：本帧快照 + 捕获当刻代号（语义见 object-effects.ts）。 */
  onSegmentBoundary?(objectId: number, frameTexture?: THREE.Texture | null, snapshotVersion?: number): void;
  /** 段边界快照同步（`_rt_FullFrameBuffer` 槽门控用；只有 allowFrameSnapshot 放行的链才绑它）。 */
  setFrameSnapshot?(frameTexture: THREE.Texture | null): void;
  /** 画布缓冲/视口变化：作废尚未被 advance 消费的在途快照（resize 会重建快照纹理）。 */
  notifyViewportResize?(): void;
}

// util 层内容输入（整帧快照）在内容 mesh UV 空间的覆盖矩形：快照贴到哪块 UV（可越界/含镜像负值）。
export interface UtilContentCover {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

const FULL_UV_COVER: UtilContentCover = { sx: 0, sy: 0, sw: 1, sh: 1 };

function sameCover(a: UtilContentCover, b: UtilContentCover): boolean {
  return a.sx === b.sx && a.sy === b.sy && a.sw === b.sw && a.sh === b.sh;
}

// util 层内容输入条目：段边界把整帧快照写成内容 → 效果链从「本帧画面」开始处理。
interface UtilContentEntry {
  mesh: THREE.Mesh;
  /** 内容几何基准 UV（未变换）：覆盖矩形变化时据此重写 UV，避免逐次累积。 */
  baseUv: Float32Array;
  /** 快照在内容 mesh UV 空间的覆盖矩形（= 当前生效值）。 */
  cover: UtilContentCover;
  texture: THREE.Texture | null;
  /** 内容世界矩形中心（场景坐标系，原点 = 场景中心；与合成 quad 同位置）。 */
  centerX: number;
  centerY: number;
}

// 渲染像素比 = 设备像素比 × 画质档位。画布缓冲与对象 RT 的屏幕密度都按它算，
// three-renderer 挂载期算屏幕密度必须调**同一个函数**（口径不一致会让整层模糊，见 AGENT.md §5.15）。
export function resolvePixelRatio(devicePixelRatio: number, qualityScale: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const scale = Number.isFinite(qualityScale) && qualityScale > 0 ? qualityScale : 1;
  return dpr * scale;
}

// alignment 锚点偏移 → 世界坐标：局部半尺寸先乘 scale（含镜像），再按对象 angles 旋转（与 mesh TRS 同序）。
function alignmentWorldOffset(
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

export class ThreeScenePlayer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
  // 承载渲染的 canvas —— **就是调用方 append 到 DOM 显示的那一个**（渲染目标与页面显示
  // 同一元素，不存在第二个离屏 canvas）。不变量（见 resize）：
  //   canvas.width/height === 视口逻辑尺寸 × pixelRatio，而 CSS `.wp-scene-canvas` 是 100%/100%
  // ⇒ 缓冲与物理像素 1:1，既不模糊也不拉伸（防「canvas 停在 HTML 默认 300×150 被 CSS 拉伸」）。
  readonly canvas: HTMLCanvasElement;

  // 场景固有尺寸（WE 正交视口 view_w×view_h；scene.json 未就绪前用构造传入的冗余值）与
  // 当前视口尺寸（canvas 逻辑像素）。
  private sceneWidth: number;
  private sceneHeight: number;
  private viewWidth: number;
  // 上次 resize 时用的 devicePixelRatio（供 render() 按需校准；DSH 桌面版窗口创建早于系统缩放生效）。
  private lastDpr = 0;
  private viewHeight: number;
  // 渲染缓冲像素比 = 设备像素比 × 画质档位（resize 时重读设备像素比，跨屏拖动自适应）。
  private pixelRatio: number;
  // 画质档位（< 1 = 降分辨率省显存/提流畅；1 = 原生 dpr）。
  private qualityScale: number;
  // 壁纸清屏色（WE general.clearcolor，0-255 → 工作色彩空间原值）；null = 用渲染器缺省黑。
  private clearColorValue: THREE.Color | null = null;
  // 暂停（省电）：停 RAF 排程，并把暂停时长从 elapsedSeconds 里扣除（恢复后 g_Time 不跳）。
  private paused = false;
  private pausedAt = 0;
  private pausedTotal = 0;
  // 已安装的帧回调（resume 时用它重新排程）。
  private loopFn: ((dt: number) => void) | null = null;
  // 未决抓帧请求（null = 无）：同一时刻只允许一个；render() 末尾在同一 JS 任务内读像素后 resolve。
  private pendingCapture: ((png: Uint8Array | null) => void) | null = null;

  private lastTime = 0;

  // 视差状态：配置 + 宿主指针目标 + 跟随值（延迟插值状态）。cfg 为 null 时 tickParallax 立即返回。
  private parallaxCfg: ParallaxConfig | null = null;
  private parallaxTarget: PointerState = { ...POINTER_CENTER };
  private parallaxFollow: PointerFollow = { value: { ...POINTER_CENTER }, elapsed: 0 };

  // 背景图层条目（按 addBackground 返回的 id 索引，供 update_background 引用）。
  private backgroundEntries = new Map<number, BackgroundEntry>();
  private nextBackgroundId = 0;
  // 精灵表图层（键 = scene.json 对象 id；仅 image 材质带 combos.spritesheet 且纹理有 TEXS 元数据时登记）。
  private readonly spritesheetLayers = new Map<number, SpriteSheetLayer>();

  // puppet 图层（键 = 同一把图层计数器 id）：instance 用于逐帧采样动画，dispose 时释放骨骼/资源。
  // layers = 已过滤 `visible !== false` 的动画层（null = scene.json **没有** animationlayers 字段）；
  // warned = 多条可见层的告警只打一次（防每帧刷屏）。
  private puppetLayers = new Map<number, {
    instance: PuppetInstance;
    layers: NonNullable<SceneImageObject['animationLayers']> | null;
    elapsed: number;
    warned?: boolean;
  }>();

  // 粒子图层条目：按 addParticle 返回的 id 索引，更新粒子时用其 getter 刷新缓冲区。
  private particleLayers = new Map<number, ParticleLayer>();
  private nextParticleLayerId = 0;

  // scene 对象 id → **最终显示**的 three 对象（非隔离 = 内容 mesh；隔离 = 合成 quad）。
  // 脚本的 LayerStateTable 键是 scene 对象 id，而 backgroundEntries/particleLayers 的键是图层
  // 计数器 id —— 这里补一份同键空间映射，免去又一层「对象 id → 计数器 id」的翻译。
  private readonly displayObjects = new Map<number, THREE.Object3D>();

  // 对象隔离条目（对象级效果链；空 Map = 本壁纸无带效果对象，帧序退化为原路径）。
  private isolated = new Map<number, IsolatedObject>();
  // util 层内容输入（整帧快照）：键 = scene.json 对象 id；solid 层无条目（保留纯色内容）。
  private readonly utilContents = new Map<number, UtilContentEntry>();
  // 最近一次段边界拍下的整帧快照（渲染器每帧同步给 ObjectEffectStage 的快照槽门控）。
  private lastFrameSnapshot: THREE.Texture | null = null;
  // SceneScript 音频可视化（visualizer）：脚本 init 动态 createLayer 的 64 条 bar 由 player 代建/逐帧更新。
  private visualizerBars: Array<{ id: number; baseY: number; barSizeH: number; scaleY: number }> = [];
  // 自定义 visualizer（pixel-bars 家族）：按对象 scale/angles 布局，静音高度 = minBarHeight。
  private pixelBars: Array<{
    id: number;
    barSizeH: number;
    minBarHeight: number;
    objScaleY: number;
    downscaleMode: 'max' | 'average';
    count: number;
  }> = [];
  private objectEffectStage: ObjectEffectStage | null = null;
  // 应用级 Glow 注入点（null = 本壁纸不开 Glow，帧序退化为原路径）。
  private glowStage: GlowStage | null = null;
  // 壁纸级 bloom 注入点（scene.json general.bloom*）：非空时先 bloom 再交给 Glow/合成。
  private bloomStage: GlowStage | null = null;
  // bloom 的中间结果 RT（全画布缓冲尺寸）：仅装配 bloom 时惰性创建，由 resize 同步。
  private bloomRT: THREE.WebGLRenderTarget | null = null;
  // 帧内快照注入点（null 或 active=false = 本壁纸无消费者 ⇒ 帧序与改动前逐字相同）。
  private frameCapture: FrameCapture | null = null;
  // 消费者集合（键 = scene.json 对象 id）：段渲染时每个消费者**开启新的一段**，段数 = 消费者数 + 1。
  private readonly frameConsumers = new Set<number>();
  // 折射层（键 = scene.json 对象 id → 粒子图层）：段边界把本帧快照写进它的 refractBg。
  private readonly refractLayers = new Map<number, ParticleLayer>();
  // 折射层「无可用快照 ⇒ 已隐藏」只做一次（防与脚本的 visible 状态每帧互踩）。
  private refractHidden = false;
  // 已告警过的未匹配消费者（防每帧刷屏）。
  private readonly warnedConsumers = new Set<number>();
  // 段边界快照失败只告警一次（防每帧刷屏）；失败时 util 层跳过、主场景继续。
  private frameSnapshotWarned = false;
  // 末段合成用的全屏 quad（惰性建：只有真的走段渲染且 Glow 关闭时才建）。
  private compositeQuad: CompositeQuad | null = null;
  // g_Time 时间原点（构造时刻），advance 传「自 player 创建起的秒数」。
  private readonly startedAt = typeof performance !== 'undefined' ? performance.now() : 0;

  constructor(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    // 可选注入 renderer：node/jsdom 无 WebGL 无法构造真 WebGLRenderer，测试用 mock 注入
    // （契约「可 mock renderer」）。缺省创建标准 antialias WebGLRenderer。
    renderer?: THREE.WebGLRenderer,
    // 画质档位（渲染像素比倍率，缺省 1 = 原生 dpr）；运行时用 setQualityScale 调整。
    qualityScale = 1,
    // 播放器选项：clearColor = 壁纸清屏色（WE general.clearcolor，0-255）。
    opts: { clearColor?: [number, number, number] } = {},
  ) {
    this.sceneWidth = width;
    this.sceneHeight = height;
    // 视口缺省与场景同尺寸 → cover == 场景尺寸（无裁剪）。resize(w,h) 后按视口裁剪。
    this.viewWidth = width;
    this.viewHeight = height;
    this.canvas = canvas;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    this.camera.position.z = CAMERA_DISTANCE;

    // 注意：构造器**不调用 renderer.setSize(width,height,false)**——否则会把 canvas 尺寸重置回
    // 场景尺寸、覆盖调用方预设的窗口尺寸（随后 resize 读到被覆盖的 canvas.width → cover 退化为
    // 「全场景无裁剪」+ CSS object-fit:fill 拉伸背景）。canvas 尺寸由调用方在构造后显式
    // `resize(vw,vh)` 设置（窗口尺寸），见 loadSceneToThree。
    this.renderer = renderer ?? new THREE.WebGLRenderer({ canvas, antialias: true });
    // 色彩管线对齐 wasm 参考（UNorm 非 sRGB、fragment 输出原始编码值，见 wasm/src/render/mod.rs）：
    // three 缺省 `outputColorSpace=SRGBColorSpace` 会把线性值再编码 ⇒ 画面偏亮/过曝。强制
    // LinearSRGBColorSpace 使 `linearToOutputTexel` 恒等，纹理原始值直出。
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    // 壁纸清屏色（WE general.clearcolor，0-255）；缺省保持渲染器缺省黑。
    if (opts.clearColor) {
      const [r, g, b] = opts.clearColor;
      this.clearColorValue = new THREE.Color(r / 255, g / 255, b / 255);
      this.renderer.setClearColor(this.clearColorValue, 1);
    }
    // ⚠️ 必须显式设像素比：three 缺省 `pixelRatio=1`（缓冲 = 视口 CSS 像素），而 `.wp-scene-canvas`
    // 铺满窗口 ⇒ HiDPI 屏上缓冲被放大会让整幅画面（含粒子）**模糊**；按 devicePixelRatio 设后
    // 缓冲 = 物理像素。mock renderer 无 setPixelRatio，防御式跳过。
    this.qualityScale = Number.isFinite(qualityScale) && qualityScale > 0 ? qualityScale : 1;
    this.pixelRatio = resolvePixelRatio(this.devicePixelRatio(), this.qualityScale);
    const withSetPixelRatio = this.renderer as { setPixelRatio?: (v: number) => void };
    if (typeof withSetPixelRatio.setPixelRatio === 'function') {
      withSetPixelRatio.setPixelRatio(this.pixelRatio);
    }
    this.applyCover();
  }

  // 视口尺寸变更（浏览器 resize / controller 设置 canvas 逻辑尺寸）：只改视口，重新按
  // cover 推导相机范围（cover 语义保持，裁剪方向随视口宽高比变化，不固定传 w/h），并把
  // **渲染缓冲**钉到 视口 × dpr（不变量，见 canvas 字段注释）。
  resize(width: number, height: number): void {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    this.viewWidth = w;
    this.viewHeight = h;
    // 重读设备像素比：窗口拖到另一块缩放比例不同的显示器后，缓冲必须按新 dpr 重推。
    this.pixelRatio = resolvePixelRatio(this.devicePixelRatio(), this.qualityScale);
    this.lastDpr = this.devicePixelRatio();
    this.applyCover();
    // ① 像素比 + 逻辑尺寸交给 renderer（幂等：写 _pixelRatio/_width/_height + viewport）。
    const r = this.renderer as {
      setPixelRatio?: (v: number) => void;
      setSize?: (w: number, h: number, updateStyle?: boolean) => void;
    };
    if (typeof r.setPixelRatio === 'function') r.setPixelRatio(this.pixelRatio);
    if (typeof r.setSize === 'function') r.setSize(w, h, false);
    // ② 显式兜底：three `setSize(w,h,false)` 本就会写 `canvas.width = floor(w*pixelRatio)`，此处
    //    再核对一次（仅在实际不符时才写），使「缓冲 = 视口×dpr」成为**本类自己保证**的不变量——
    //    任何 renderer 实现（含注入的 mock）都不会让 canvas 停在 HTML 默认 300×150 被 CSS 拉伸。
    const bufW = Math.floor(w * this.pixelRatio);
    const bufH = Math.floor(h * this.pixelRatio);
    if (this.canvas.width !== bufW) this.canvas.width = bufW;
    if (this.canvas.height !== bufH) this.canvas.height = bufH;
    // Glow 各级 RT 必须按画布缓冲尺寸建（与主相机 cover 口径一致）。mock renderer 无 domElement，
    // 退回本类自持的 canvas（生产路径 renderer.domElement 就是它）。
    const buf = (this.renderer as { domElement?: HTMLCanvasElement }).domElement ?? this.canvas;
    this.glowStage?.resize(buf.width, buf.height);
    this.bloomStage?.resize(buf.width, buf.height);
    this.bloomRT?.setSize(buf.width, buf.height);
    // 帧内快照的段目标/快照纹理同样按画布缓冲尺寸（否则 RT 被拉伸、快照与屏幕 UV 错位）。
    this.frameCapture?.resize(buf.width, buf.height);
    this.lastFrameSnapshot = null; // 快照已重建：上一帧的兜底引用作废，不得同步回 stage
    // 让编排器作废尚未被 advance 消费的在途快照（已被带进闭包的那份由实时代号比较兜底）。
    this.objectEffectStage?.notifyViewportResize?.();
    this.compositeQuad?.resize(buf.width, buf.height);
    // ③ 合成采样标志随**视口**重估（视口变化是密度变化的唯一入口）：编排器在「RT 像素尺寸未变」
    //    时会跳过 resizeObjectRT，而源纹理收口 4096 时新老尺寸可能恰好相同（判定反转却无重估 ⇒ 走样）。
    for (const entry of this.isolated.values()) {
      this.applyCompositeSampling(entry.rt, entry.worldW, entry.worldH);
    }
  }

  // bloom 的中间结果 RT：按画布缓冲尺寸惰性创建并同步（与 Glow 各级 RT 同源）。
  private ensureBloomRT(): THREE.WebGLRenderTarget {
    const dom = (this.renderer as { domElement?: HTMLCanvasElement }).domElement ?? this.canvas;
    const w = Math.max(1, dom.width);
    const h = Math.max(1, dom.height);
    if (!this.bloomRT) this.bloomRT = new THREE.WebGLRenderTarget(w, h);
    else if (this.bloomRT.width !== w || this.bloomRT.height !== h) this.bloomRT.setSize(w, h);
    return this.bloomRT;
  }

  /** 画质档位：走 resize 路径重推画布缓冲与屏幕密度（对象 RT 的基准随之变化）。 */
  setQualityScale(scale: number): void {
    const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
    if (s === this.qualityScale) return;
    this.qualityScale = s;
    this.resize(this.viewWidth, this.viewHeight);
  }

  /** 暂停帧循环（省电）：停 RAF 排程；暂停时长不计入 elapsedSeconds。 */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.pausedAt = this.nowMs();
    this.renderer.setAnimationLoop(null);
  }

  /** 恢复帧循环（暂停期间的时间被扣除，恢复后 g_Time 不跳变）。 */
  resume(): void {
    if (!this.paused) return;
    this.pausedTotal += this.nowMs() - this.pausedAt;
    this.paused = false;
    if (this.loopFn) this.installLoop();
  }

  isPaused(): boolean {
    return this.paused;
  }

  // 设备像素比：每次读取（跨屏拖动后由 resize 用新值重推缓冲）。
  private devicePixelRatio(): number {
    return typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
  }

  private nowMs(): number {
    return typeof performance !== 'undefined' ? performance.now() : this.startedAt;
  }

  // 场景固有尺寸（scene.json 的 general.orthogonalprojection）就绪后设置，同时重推 cover；
  // 构造传入的 width/height 只是缺省冗余值。
  setSceneSize(width: number, height: number): void {
    this.sceneWidth = width;
    this.sceneHeight = height;
    this.applyCover();
  }

  // 屏幕密度（设备像素 / 世界单位）：1 个世界单位在**画布缓冲**上占多少像素。与 applyCover
  // 同一套 cover 语义（同一份 sceneWidth/sceneHeight/viewWidth/viewHeight/pixelRatio）⇒ 与主相机
  // 铺满的像素网格同一把尺子；对象 RT 的尺寸口径（RT 像素 = 对象世界尺寸 × 本密度）用它，
  // 挂载期与 resize 期必须同源（见 AGENT.md §5.15）。
  screenScalePx(): number {
    return screenScalePx(
      this.sceneWidth, this.sceneHeight, this.viewWidth, this.viewHeight, this.pixelRatio,
    );
  }

  // 按 cover 语义把相机视锥设为场景尺寸的 cover 视图（中心原点，z 范围 -1000..1000 不变）。
  private applyCover(): void {
    const viewAspect = this.viewWidth / this.viewHeight;
    const fg = coverRange(this.sceneWidth, this.sceneHeight, viewAspect);
    this.camera.left = -fg.w / 2;
    this.camera.right = fg.w / 2;
    this.camera.top = fg.h / 2;
    this.camera.bottom = -fg.h / 2;
    this.camera.updateProjectionMatrix();
  }

  // 每帧扩展钩子：驱动粒子图层刷新 + puppet 动画采样；背景更新由 update_background 显式调用
  //（对齐 wasm update_image 语义）。
  update(dt: number): void {
    this.updateParticles(dt);
    this.tickPuppets(dt);
    this.updateSpriteSheets(dt);
  }

  // puppet 动画：按 dt × rate 推进已播时长 → 采样动画层选中的动画（v1 只应用第一条可见层）。
  // 选层、缺省与 `frameCount <= 0` 等边界口径一律见 AGENT.md §2.1 与 §7.40，此处不复述。
  private tickPuppets(dt: number): void {
    if (this.puppetLayers.size === 0) return;
    for (const [id, layer] of [...this.puppetLayers]) {
      const layers = layer.layers;
      const active = layers?.[0];
      const anim = layers === null
        ? layer.instance.animations[0]
        : (active ? layer.instance.animations.find((a) => a.id === active.animation) : undefined);
      if (!anim || anim.frameCount <= 0) continue;
      if (layers && layers.length > 1 && !layer.warned) {
        layer.warned = true;
        console.warn(`[three] puppet 图层 ${id} 有 ${layers.length} 条动画层，v1 只应用第一条（${anim.name}）`);
      }
      layer.elapsed += dt * (active ? Math.max(0, active.rate) : 1);
      // 帧号 = (已播秒数 × fps) % frameCount（循环播）；fps 非法时兜回 30（与改动前同一兜底）。
      const fps = anim.fps > 0 ? anim.fps : 30;
      try {
        layer.instance.applyFrame(anim, (layer.elapsed * fps) % anim.frameCount);
      } catch (e) {
        // 采样失败只丢该图层（不升级成渲染失败）：dispose 抛错也必须在 finally 里摘表，否则该图层每帧重复抛。
        // 为何必须摘表（释放点）与 dispose 抛错不吞帧的理由见 AGENT.md §2.1。
        try {
          layer.instance.dispose();
        } catch (de) {
          console.warn('[three] puppet 释放失败:', de instanceof Error ? de.message : String(de));
        } finally {
          this.puppetLayers.delete(id);
          // 同 id 的另两张表引用一并摘净：残留 backgroundEntries 条目会让 resizeBackground（只查
          // puppetLayers）把已 dispose 的蒙皮几何换成 PlaneGeometry；displayObjects 是脚本桥，不留悬垂引用。
          const entry = this.backgroundEntries.get(id);
          if (entry) {
            this.backgroundEntries.delete(id);
            for (const [objectId, obj] of this.displayObjects) {
              if (obj === entry.mesh) this.displayObjects.delete(objectId);
            }
          }
        }
        console.warn('[three] puppet 动画采样失败（已丢弃该图层动画）:', e instanceof Error ? e.message : String(e));
      }
    }
  }

  // 登记精灵表图层：记下帧网格/原始 UV 并立刻写第 0 帧（首帧 render 前 update 尚未跑过）。
  private registerSpriteSheet(
    backgroundId: number,
    objectId: number,
    mesh: THREE.Mesh,
    sprite: { frames: number; cols: number; rows: number },
  ): void {
    const attr = (mesh.geometry as THREE.BufferGeometry).attributes?.uv;
    const layer: SpriteSheetLayer = {
      backgroundId,
      mesh,
      frames: Math.max(1, Math.floor(sprite.frames)),
      cols: Math.max(1, Math.floor(sprite.cols)),
      rows: Math.max(1, Math.floor(sprite.rows)),
      elapsed: 0,
      fps: 1,
      frame: -1,
      paused: false,
      baseUv: attr ? Float32Array.from(attr.array as ArrayLike<number>) : new Float32Array(0),
      uv: { u0: 0, v0: 0, u1: 1, v1: 1 },
    };
    this.spritesheetLayers.set(objectId, layer);
    this.applySpriteSheetFrame(layer, 0);
  }

  // 写当前帧子矩形：frame 按**行优先**（col = frame % cols，row = floor(frame / cols)）。
  // v 方向：tex-loader 显示约定 v=0=图像底部，而 TEXS 的 row 0 = 表顶行 ⇒ 第 0 行落在高 v 段
  //（与粒子 shader 的 (rows-1-row) 同源）；帧内 v 继续沿用 quad 原始 0/1 取向，不额外翻转。
  private applySpriteSheetFrame(layer: SpriteSheetLayer, frame: number): void {
    const { cols, rows } = layer;
    const col = ((frame % cols) + cols) % cols;
    const row = Math.floor(frame / cols) % rows;
    const u0 = col / cols;
    const u1 = (col + 1) / cols;
    const v0 = (rows - 1 - row) / rows;
    const v1 = (rows - row) / rows;
    const attr = (layer.mesh.geometry as THREE.BufferGeometry).attributes?.uv;
    if (attr) {
      const arr = attr.array as Float32Array;
      const base = layer.baseUv;
      for (let i = 0; i < arr.length && i < base.length; i += 2) {
        arr[i] = u0 + base[i] * (u1 - u0);
        arr[i + 1] = v0 + base[i + 1] * (v1 - v0);
      }
      attr.needsUpdate = true;
    }
    layer.frame = frame;
    layer.uv = { u0, v0, u1, v1 };
  }

  // 逐帧推进精灵表动画：dt 累加（不跟墙钟，暂停/回退不跳帧），帧号 = floor(elapsed × fps) % frames。
  private updateSpriteSheets(dt: number): void {
    if (this.spritesheetLayers.size === 0) return;
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    for (const layer of this.spritesheetLayers.values()) {
      if (layer.paused) continue; // 脚本 pause 后停住；play 恢复
      layer.elapsed += step;
      const frame = Math.floor(layer.elapsed * layer.fps) % layer.frames;
      if (frame !== layer.frame) this.applySpriteSheetFrame(layer, frame);
    }
  }

  // ── 脚本的纹理动画控制（thisLayer.getTextureAnimation → 这里）；未登记 id 一律安全 no-op ──
  pauseSpriteSheet(objectId: number): void {
    const layer = this.spritesheetLayers.get(objectId);
    if (layer) layer.paused = true;
  }

  playSpriteSheet(objectId: number): void {
    const layer = this.spritesheetLayers.get(objectId);
    if (layer) layer.paused = false;
  }

  /** 停播并回到第 0 帧（对齐 AnimPlayback.stop 的语义）。 */
  stopSpriteSheet(objectId: number): void {
    const layer = this.spritesheetLayers.get(objectId);
    if (!layer) return;
    layer.paused = true;
    layer.elapsed = 0;
    this.applySpriteSheetFrame(layer, 0);
  }

  isSpriteSheetPlaying(objectId: number): boolean {
    return this.spritesheetLayers.get(objectId)?.paused === false;
  }

  /** 立即写 UV（越界钳到 [0, frames-1]）；同时把 elapsed 对齐到该帧，play 后从这里继续。 */
  setSpriteSheetFrame(objectId: number, frame: number): void {
    const layer = this.spritesheetLayers.get(objectId);
    if (!layer) return;
    const f = Number.isFinite(frame)
      ? Math.min(layer.frames - 1, Math.max(0, Math.trunc(frame)))
      : 0;
    layer.elapsed = layer.fps > 0 ? f / layer.fps : 0;
    this.applySpriteSheetFrame(layer, f);
  }

  getSpriteSheetFrame(objectId: number): number {
    return this.spritesheetLayers.get(objectId)?.frame ?? -1;
  }

  /** 测试用：取精灵表图层当前帧的 UV 子矩形（仅测试/诊断观测，不参与渲染）。 */
  spritesheetUvForTest(objectId: number): { u0: number; v0: number; u1: number; v1: number } | null {
    const layer = this.spritesheetLayers.get(objectId);
    return layer ? { ...layer.uv } : null;
  }

  /** 相机视差配置（null = 未启用/已拆除 ⇒ 逐帧零成本早退；enabled=false 时下一帧把对象写回基准位置）。 */
  setParallax(cfg: ParallaxConfig | null): void {
    this.parallaxCfg = cfg;
  }

  /** 宿主指针监听的最新归一化位置（[0,1]）；插值在本类的 tickParallax 内按 dt 推进。 */
  setParallaxPointer(p: PointerState): void {
    this.parallaxTarget = p;
  }

  /** 视差跟随的当前指针（插值后，[0,1] y 向下）：效果 shader 全局 uniform 的来源。 */
  parallaxPointer(): PointerState {
    return this.parallaxFollow.value;
  }

  /** 测试用：取某背景条目的 three 对象（隔离对象返回合成 quad）。 */
  backgroundMeshForTest(id: number): THREE.Object3D {
    return this.backgroundEntries.get(id)!.parallaxNode;
  }

  /** 测试用：直接推进一帧视差。 */
  tickParallaxForTest(dt: number): void {
    this.tickParallax(dt);
  }

  // 逐帧：推进指针插值，并按 parallaxDepth 把**对象平移**写进各自的落点（非隔离 = mesh、
  // 隔离 = 合成 quad、粒子 = 顶点 shader 的 u_Parallax）。相机不动 —— 视差只是 model 平移。
  // ⚠️ 「不参与视差」（关视差 / depth 缺失 / depth 两根轴全 0）只写回**一次**基准位：每帧无条件写
  // position 会盖掉脚本对同一对象的 origin 写入（layer-state.applyLayerState 直接写 three 对象）
  // ⇒ 动态网格静止；而全库 34 张里只有 1 张开视差，其 pkg 内仍有 3 个对象的 depth 真值为全 0。
  private tickParallax(dt: number): void {
    const cfg = this.parallaxCfg;
    if (!cfg) return;
    this.parallaxFollow = advancePointer(this.parallaxFollow, this.parallaxTarget, cfg, dt);
    for (const entry of this.backgroundEntries.values()) {
      // 基准位 = 锚点 origin（we_to_three）+ alignment 偏移；视差 node 仍取**锚点原点**（alignment
      // 是局部几何偏移，不参与视差的 node 坐标，否则 shift 会随锚点额外平移）。
      const bx = entry.origin[0] - entry.sceneW / 2;
      const by = entry.origin[1] - entry.sceneH / 2;
      const x = bx + entry.align[0];
      const y = by + entry.align[1];
      const z = entry.origin[2];
      // depth 全 0（scene.json 里有真值 "0.00000 0.00000"）与缺省同义 = 不参与视差：shift 恒 0，
      // 但**写**这个动作本身会覆盖脚本位移，故必须归到「不写」分支。
      const d = entry.parallaxDepth;
      const depth = d && (d[0] !== 0 || d[1] !== 0) ? d : null;
      if (!cfg.enabled || !depth) {
        if (entry.parallaxApplied) {
          entry.parallaxNode.position.set(x, y, z);
          entry.parallaxApplied = false;
        }
        continue;
      }
      const [sx, sy] = parallaxShift({
        pointer: this.parallaxFollow.value,
        // OWE 的 ortho 是**场景**正交尺寸（general.orthogonalprojection），不是窗口尺寸。
        orthoW: this.sceneWidth,
        orthoH: this.sceneHeight,
        nodeX: bx, nodeY: by,
        // three 坐标下主相机位于场景中心（we_to_three 已把中心移到原点）。
        camX: 0, camY: 0,
        depth,
        cfg,
      });
      entry.parallaxNode.position.set(x + sx, y + sy, z);
      entry.parallaxApplied = true;
    }
    // 粒子层：非隔离层把位移注入顶点 shader（= 对象局部的世界平移）；隔离层写合成 quad（在对象
    // RT 内平移会被 RT 边界裁掉）。
    for (const layer of this.particleLayers.values()) {
      const [cx, cy] = layer.parallaxCenter;
      const u = (layer.material.uniforms as Record<string, { value: THREE.Vector2 }>).u_Parallax;
      // 隔离层的位移落点只有 quad：quad 意外缺失时跳过本层，**不得**退化写 u_Parallax（那正是会
      // 被 RT 边界裁掉的落点）。
      if (layer.parallaxIsolated && !layer.parallaxQuad) continue;
      const d = layer.parallaxDepth;
      const depth = d && (d[0] !== 0 || d[1] !== 0) ? d : null;
      if (!cfg.enabled || !depth) {
        if (layer.parallaxApplied) {
          if (layer.parallaxQuad) layer.parallaxQuad.position.set(cx, cy, layer.parallaxQuad.position.z);
          else u?.value.set(0, 0);
          layer.parallaxApplied = false;
        }
        continue;
      }
      const [sx, sy] = parallaxShift({
        pointer: this.parallaxFollow.value,
        orthoW: this.sceneWidth,
        orthoH: this.sceneHeight,
        nodeX: cx, nodeY: cy,
        camX: 0, camY: 0,
        depth,
        cfg,
      });
      if (layer.parallaxQuad) layer.parallaxQuad.position.set(cx + sx, cy + sy, layer.parallaxQuad.position.z);
      else u?.value.set(sx, sy);
      layer.parallaxApplied = true;
    }
  }

  // 启动帧循环（renderer.setAnimationLoop 内部 RAF）。每帧：外部回调 fn(dt) → update(dt) →
  // render(scene, camera)。dt 用 performance.now 差分并 clamp 0.1s（防 tab 切后台后 dt 过大把粒子
  // 瞬移出视口）。fn(dt) 必须先于内部 update(dt)：fn 承载「模拟推进」，使 updateParticles 读到的
  // getter 是本帧**已推进**的顶点，避免一帧滞后。
  //
  // ⚠️ 帧体必须整体 try/catch：three r170 的 `WebGLAnimation.onAnimationFrame` 把下一帧的
  // `requestAnimationFrame` 重排写在回调**之后**且不包裹 try/catch（three.module.js 13612-13618）
  // ⇒ 回调抛出一次就**再也不会重排下一帧，RAF 循环永久停摆**（画面停在最后一次成功绘制，表现为
  // 「背景清晰但没有粒子」且再无诊断输出）。包住后单帧异常只丢该帧、循环自愈，异常只记一次 warn。
  setAnimationLoop(fn?: (dt: number) => void): void {
    this.loopFn = fn ?? null;
    // 暂停中装配（挂载即暂停）→ 不排程，等 resume 再装。
    if (this.paused) {
      this.renderer.setAnimationLoop(null);
      return;
    }
    this.installLoop();
  }

  // 安装帧体（setAnimationLoop 与 resume 共用）。
  private installLoop(): void {
    const fn = this.loopFn;
    this.lastTime = performance.now();
    let warned = false;
    this.renderer.setAnimationLoop(() => {
      try {
        // 暂停后可能仍有一帧已被排程（cancel 与回调的时序不保证）→ 帧内再挡一次。
        if (this.paused) return;
        const now = performance.now();
        const dt = Math.min((now - this.lastTime) / 1000, 0.1);
        this.lastTime = now;
        fn?.(dt);
        this.update(dt);
        this.tickParallax(dt);   // 视差是纯位置写入：无配置时立即返回
        // 帧序统一在 render() 内（隔离内容 → bindOutputs → Glow/主场景 → advance），两处不再漂移。
        this.render();
      } catch (e) {
        if (!warned) {
          warned = true;
          console.warn('[three] 帧循环异常（已丢弃该帧并继续循环）:', e instanceof Error ? e.message : String(e));
        }
      }
    });
  }

  // 手动渲染一帧（不依赖 RAF，供测试/调用方直接触发）。帧序：隔离内容 → bindOutputs →
  // Glow/主场景（或段渲染）→ advance。装配了 glowStage 时主场景渲染委托给它。
  // ★ 只有 frameCapture?.active（本壁纸真有消费者）时才改走段渲染（renderSegmented），
  //   否则调用序列与引入该分支前**逐字节一致**（结构性零回归）。
  render(): void {
    // 按需校准渲染分辨率：DSH 桌面版窗口创建**早于**系统缩放生效 ⇒ 装配时 devicePixelRatio 仍是 1，
    // 而 resize() 只在窗口尺寸变化时调用 ⇒ 缓冲小于屏幕物理像素、整幅画面被放大而**模糊**。
    // 每帧比一次（读 DPR + 比较，成本可忽略），顺带覆盖「窗口拖到另一块缩放比例不同的显示器」。
    if (this.devicePixelRatio() !== this.lastDpr) this.resize(this.viewWidth, this.viewHeight);
    if (this.isolated.size > 0) this.renderIsolatedContents();
    this.objectEffectStage?.bindOutputs();
    // 快照不可用（未注入/未激活）时折射层无从取样 ⇒ 隐藏一次（WE NORMALMAP=0 语义：输出≡背景）。
    this.hideRefractWithoutCapture();
    if (this.frameCapture?.active) this.renderSegmented();
    else if (this.bloomStage) {
      // 壁纸 bloom → 应用级 Glow（或 composite-quad）两级串联；中间结果落在 bloomRT。
      const bloomRT = this.ensureBloomRT();
      this.bloomStage.apply(this.renderer, this.scene, this.camera, undefined, bloomRT);
      if (this.glowStage) this.glowStage.apply(this.renderer, this.scene, this.camera, bloomRT);
      else {
        this.compositeQuad ??= createCompositeQuad(this.renderer);
        this.compositeQuad.composite(this.renderer, bloomRT.texture);
      }
    } else if (this.glowStage) this.glowStage.apply(this.renderer, this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
    // 抓帧必须在最终画面渲染后的**同一 JS 任务**内读默认 framebuffer（挪到 rAF/定时器后内容已换）。
    this.flushCapture();
    // 链推进是异步串行的（纹理槽可能仍在加载），不阻塞本帧；本帧贴的是上一帧输出。
    this.objectEffectStage?.advance(this.elapsedSeconds());
  }

  /**
   * 请求抓取**下一帧**渲染结果（PNG 字节；首帧缓存用）。已有未决请求时返回 null（一帧只抓一张）。
   * 必须在 render() 同一任务内读像素，故这里只登记请求、由 render() 末尾同步读取。
   */
  captureNextFrame(): Promise<Uint8Array | null> {
    if (this.pendingCapture) return Promise.resolve(null);
    return new Promise((resolve) => { this.pendingCapture = resolve; });
  }

  // render() 末尾调用：读像素/编码的失败只 warn 并 resolve(null)，绝不把异常抛进帧循环。
  private flushCapture(): void {
    const resolve = this.pendingCapture;
    if (!resolve) return;
    this.pendingCapture = null;
    try {
      const gl = this.renderer.getContext() as unknown as ReadPixelsGl & {
        drawingBufferWidth?: number;
        drawingBufferHeight?: number;
        isContextLost?: () => boolean;
      };
      // 上下文已丢失时 readPixels 只会读回全零（没有异常），会把「黑帧」写进首帧缓存 ⇒ 直接跳过。
      if (typeof gl.isContextLost === 'function' && gl.isContextLost()) {
        console.warn('[three] scene 抓帧失败（WebGL 上下文已丢失），已跳过首帧缓存');
        resolve(null);
        return;
      }
      const dom = (this.renderer as { domElement?: { width?: number; height?: number } }).domElement;
      // 画布缓冲尺寸优先取 GL 的 drawingBuffer*（= 实际可读像素区），mock/异常环境退回 domElement。
      const width = Math.floor(gl.drawingBufferWidth || dom?.width || 0);
      const height = Math.floor(gl.drawingBufferHeight || dom?.height || 0);
      void readPixelsToPng(gl, width, height).then((png) => {
        if (!png) console.warn('[three] scene 抓帧失败（读像素/编码不可用），已跳过首帧缓存');
        resolve(png);
      });
    } catch (e) {
      console.warn('[three] scene 抓帧失败（已跳过首帧缓存）:', e instanceof Error ? e.message : String(e));
      resolve(null);
    }
  }

  /** 注入帧内快照（null = 关闭）。契约见 frame-capture.ts；active=false 时帧序不变。 */
  setFrameCapture(capture: FrameCapture | null): void {
    this.frameCapture = capture;
    this.lastFrameSnapshot = null; // 新 capture 的快照尚未产生：旧引用（可能已 dispose）不得同步回 stage
    this.checkFrameConsumers();
  }

  /** 登记一个「需要帧内快照」的消费者（键 = scene.json 对象 id）：它开启新的一段，快照拍在它**之前**。 */
  registerFrameConsumer(objectId: number): void {
    this.frameConsumers.add(objectId);
    this.checkFrameConsumers();
  }

  // 消费者集合与 capture.active 的唯一收口：命中显示对象 ⇒ 激活段渲染；未命中 ⇒ 一次性告警（该段边界不存在）。
  private checkFrameConsumers(): void {
    for (const objectId of this.frameConsumers) {
      if (this.displayObjects.has(objectId)) { this.frameCapture?.use(); continue; }
      if (this.warnedConsumers.has(objectId)) continue;
      this.warnedConsumers.add(objectId);
      console.warn(`[three] 帧内快照消费者未匹配到显示对象（已忽略）: id=${objectId}`);
    }
  }

  // 折射层但没有可用快照（未注入 FrameCapture / 未激活）：不画（画出来只会是白方块），并告警一次。
  private hideRefractWithoutCapture(): void {
    if (this.refractHidden || this.refractLayers.size === 0) return;
    if (this.frameCapture?.active === true) return;
    this.refractHidden = true;
    for (const layer of this.refractLayers.values()) layer.mesh.visible = false;
    console.warn('[three] 折射层无可用帧内快照（FrameCapture 未激活）→ 隐藏该层，不画白方块');
  }

  /**
   * 段渲染：按 renderOrder 升序把主场景顶层对象切成若干段（消费者**开启**新的一段，段数 = 消费者数 + 1），
   * 逐段渲染进 frameCapture.target（段间 autoClear=false 累积），消费者段的快照拍在该段 render **之前**，
   * 末段合成回默认 fb。WE 对齐点：lwe CScene.cpp:351-361 按 m_objectsByRenderOrder 逐个 render()；
   * REFRACT 在画该层**前** blit 场景 FBO（CParticle.cpp:2069-2079）。
   */
  private renderSegmented(): void {
    const capture = this.frameCapture;
    if (!capture) return;
    const children = [...this.scene.children];
    // ① 保存运行期状态：autoClear / 清屏参数 / 各顶层对象 visible（段内临时改写，必须原值恢复）。
    const prevAutoClear = (this.renderer as { autoClear?: boolean }).autoClear !== false;
    const prevVisible = children.map((o) => o.visible);
    const prevClearColor = new THREE.Color();
    this.renderer.getClearColor(prevClearColor);
    const prevClearAlpha = this.renderer.getClearAlpha();
    // ② 消费者对象 → 它在 scene.children 里的下标（并记住 scene.json 对象 id，供折射层 refractBg 定位）。
    const consumerObjectIdByIndex = new Map<number, number>();
    for (let i = 0; i < children.length; i++) {
      const obj = children[i];
      for (const objectId of this.frameConsumers) {
        if (this.displayObjects.get(objectId) === obj) { consumerObjectIdByIndex.set(i, objectId); break; }
      }
    }
    // ③ 切段：按 renderOrder 升序（稳定排序 ⇒ 同序号保持 scene 内顺序），消费者**开启**新的一段、
    //    与其后的非消费者同段（段内至多一个消费者）⇒ 快照必然拍在该消费者被绘制**之前**。
    const order = children
      .map((obj, i) => ({ obj, i }))
      .sort((a, b) => a.obj.renderOrder - b.obj.renderOrder);
    const segments: Array<{ members: number[]; consumer: number | null }> = [];
    let current: { members: number[]; consumer: number | null } | null = null;
    for (const { i } of order) {
      const isConsumer = consumerObjectIdByIndex.has(i);
      if (current === null || isConsumer) {
        if (current !== null) segments.push(current);
        current = { members: [], consumer: isConsumer ? i : null };
      }
      current.members.push(i);
    }
    if (current !== null) segments.push(current);
    try {
      // ④ 段目标 = frameRT（画布缓冲尺寸）：清屏色与默认 fb 一致（壁纸清屏色 + alpha 1）。
      //    ⚠️ autoClear 只在段渲染范围内临时关闭——`rt-render.ts` 的 4 个调用点依赖它清屏。
      this.renderer.setRenderTarget(capture.target);
      this.renderer.setClearColor(this.clearColorValue ?? 0x000000, 1);
      this.renderer.clear();
      (this.renderer as { autoClear: boolean }).autoClear = false;
      for (const segment of segments) {
        // 只有本段对象可见：透明混合是累积的，留可见会被**再画一遍**（重复叠加）。
        const members = new Set(segment.members);
        for (let i = 0; i < children.length; i++) {
          children[i].visible = prevVisible[i] && members.has(i);
        }
        // ★ 快照拍在**本段 render 之前**：此刻 target 仍绑定 frameRT，内容 = 此前所有段已绘制的内容
        //   （WE「画该层之前 blit」语义；放在 render 之后会把消费者自己拍进去）。捕获无幂等性 ⇒ 每段一次。
        if (segment.consumer !== null) {
          const consumerObjectId = consumerObjectIdByIndex.get(segment.consumer);
          // 快照失败（copy 抛错/资源已释放）只丢 util 这一层：不把异常抛给帧循环（否则整帧丢失）。
          let snapshot: THREE.Texture | null = null;
          try {
            snapshot = capture.capture();
            // util 层：快照 = **层内容**（真实 util 链读 bind: previous）。写入内容材质并立即重渲
            // 该层 RT ⇒ 本帧 advance 的链输入就是本帧画面（不是上一帧的透明占位）。
            if (consumerObjectId !== undefined && this.utilContents.has(consumerObjectId)) {
              this.setUtilContentTexture(consumerObjectId, snapshot, {
                cover: this.utilContentCoverFor(consumerObjectId) ?? undefined,
              });
              this.renderUtilContent(consumerObjectId);
            }
          } catch (e) {
            snapshot = null;
            this.warnFrameSnapshotFailure(e);
          } finally {
            // 重渲会把目标复位成 null（异常早退时也可能停在中间态），段渲染要继续用 frameRT。
            this.renderer.setRenderTarget(capture.target);
          }
          this.lastFrameSnapshot = snapshot; // 槽门控的全局兜底（渲染器每帧同步给 stage）
          // 段边界**同步**通知编排器 ⇒ 该对象的效果链本帧用这张快照（而非上一帧）。携带纹理 =
          // 不重复 blit（同一张快照也供下面折射路径用）；代号供消费方在执行当刻比对作废。
          if (consumerObjectId !== undefined) {
            this.objectEffectStage?.setFrameSnapshot?.(snapshot);
            this.objectEffectStage?.onSegmentBoundary?.(consumerObjectId, snapshot, capture.snapshotVersion);
          }
          // 折射消费者：在它被绘制之前把本帧快照接进 refractBg（逐帧覆盖，段外不持有引用）。
          const refractLayer = consumerObjectId === undefined ? undefined : this.refractLayers.get(consumerObjectId);
          if (refractLayer !== undefined && consumerObjectId !== undefined && snapshot !== null) {
            refractLayer.material.uniforms.refractBg.value = snapshot;
            if (!refractLayer.loggedRefract) {
              refractLayer.loggedRefract = true;
              const size = (snapshot as { image?: { width?: number; height?: number } }).image;
              console.log(
                `[three] refract layer=${consumerObjectId} bg=${size?.width ?? 0}x${size?.height ?? 0}` +
                  ` amount=${refractLayer.material.uniforms.refractAmount.value}`,
              );
            }
          }
        }
        this.renderer.render(this.scene, this.camera);
      }
    } finally {
      (this.renderer as { autoClear: boolean }).autoClear = prevAutoClear;
      // 清屏参数是本帧临时改的全局状态，恢复原值（不得留在段渲染的清屏值上）。
      this.renderer.setClearColor(prevClearColor, prevClearAlpha);
      this.renderer.setRenderTarget(null);
      for (let i = 0; i < children.length; i++) children[i].visible = prevVisible[i];
    }
    // ⑤ 末段合成：有壁纸 bloom 时先 bloom（读 frameRT、写中间 RT），再 Glow 读中间 RT 合成到画布；
    //    无 bloom 时路径与引入 bloom 前逐字相同（Glow 读 frameRT / composite-quad 贴 frameRT）。
    if (this.bloomStage) {
      const bloomRT = this.ensureBloomRT();
      this.bloomStage.apply(this.renderer, this.scene, this.camera, capture.target, bloomRT);
      if (this.glowStage) this.glowStage.apply(this.renderer, this.scene, this.camera, bloomRT);
      else {
        this.compositeQuad ??= createCompositeQuad(this.renderer);
        this.compositeQuad.composite(this.renderer, bloomRT.texture);
      }
    } else if (this.glowStage) {
      this.glowStage.apply(this.renderer, this.scene, this.camera, capture.target);
    } else {
      this.compositeQuad ??= createCompositeQuad(this.renderer);
      this.compositeQuad.composite(this.renderer, capture.target.texture);
    }
  }

  // 段边界快照失败：只告警一次并跳过 util 层，主场景与后续帧继续（不把异常抛进帧循环）。
  private warnFrameSnapshotFailure(e: unknown): void {
    if (this.frameSnapshotWarned) return;
    this.frameSnapshotWarned = true;
    console.warn(
      '[wallpaper-engine] 帧快照失败，util 层跳过:',
      e instanceof Error ? e.message : String(e),
    );
  }

  // 对象级效果链的编排器注入点（null = 本壁纸无效果链，帧序退化为原路径）。
  setObjectEffectStage(stage: ObjectEffectStage | null): void {
    this.objectEffectStage = stage;
  }

  /** 装配应用级 Glow（null = 关闭）。关闭时帧序与本方法加入前逐字相同。 */
  setGlowStage(stage: GlowStage | null): void {
    this.glowStage = stage;
  }

  /** 装配壁纸级 bloom（null = 关闭）。关闭时帧序与本方法加入前逐字相同。 */
  setBloomStage(stage: GlowStage | null): void {
    this.bloomStage = stage;
  }

  /** 按 scene.json 对象 id 取最终显示的 three 对象（脚本图层桥用）。未登记 → undefined。 */
  displayObject(objectId: number): THREE.Object3D | undefined {
    return this.displayObjects.get(objectId);
  }

  // 隔离对象条目（只读视图，供编排器拿 RT 纹理与尺寸）。
  isolatedObjects(): IsolatedObject[] {
    return [...this.isolated.values()];
  }

  // 把某个隔离对象的合成 quad 切到给定的采样纹理（效果链输出；编排器在链未就绪时
  // 不调用本方法，quad 保持采样对象 RT 原图 → 对象正常显示、无效果，不黑屏）。
  // `id` = 隔离条目的键 = scene.json 的对象 id（编排器从 isolatedObjects()[].id 取用）。
  setObjectOutput(id: number, texture: THREE.Texture): void {
    const entry = this.isolated.get(id);
    if (!entry) return;
    const mat = entry.quad.material;
    if (mat instanceof THREE.ShaderMaterial) mat.uniforms.map.value = texture;
    else if (mat instanceof THREE.MeshBasicMaterial) mat.map = texture;
  }

  // 音频可视化条（visualizer 脚本，如 2937346640 Simple Visualizer）：按脚本语义代建 count 条 bar
  //（宽 = barWidth × 图宽、高 = average × scaleY × 图高，底部对齐），返回背景 id 列表。
  setVisualizerBars(opts: {
    origin: [number, number, number];
    barSize: [number, number];
    texture?: THREE.Texture;
    barWidth: number;
    scaleY: number;
    originX: number;
    sceneW: number;
    sceneH: number;
    renderOrder?: number;
    count?: number;
  }): number[] {
    const count = opts.count ?? 64;
    const ids: number[] = [];
    this.visualizerBars = [];
    for (let i = 0; i < count; i++) {
      const id = this.addBackground({
        origin: [opts.origin[0] + i * opts.originX, opts.origin[1], opts.origin[2]],
        size: [opts.barSize[0], opts.barSize[1]],
        // 初始高度 0（无音频时不可见）；宽度按脚本 barWidth。
        scale: [opts.barWidth, 0, 1],
        texture: opts.texture,
        sceneW: opts.sceneW,
        sceneH: opts.sceneH,
        renderOrder: (opts.renderOrder ?? 0) + i + 1,
      });
      ids.push(id);
      this.visualizerBars.push({
        id, baseY: opts.origin[1] - opts.sceneH / 2, barSizeH: opts.barSize[1], scaleY: opts.scaleY,
      });
    }
    return ids;
  }

  /**
   * 自定义 visualizer（pixel-bars 家族，如 3118949804）：按对象 scale/angles 布局 count 条；
   * 高度倍率默认 minBarHeight（静音仍可见，与脚本 Math.max(minBarHeight, …) 一致）。
   */
  setPixelVisualizerBars(opts: {
    origin: [number, number, number];
    scale: [number, number, number];
    angles: [number, number, number];
    barSize: [number, number];
    barWidth: number;
    minBarHeight: number;
    scaleY: number;
    barPath: string;
    downscaleMode: 'max' | 'average';
    sceneW: number;
    sceneH: number;
    renderOrder?: number;
    count: number;
    alignment?: string;
    texture?: THREE.Texture;
  }): number[] {
    const ids: number[] = [];
    this.pixelBars = [];
    const sx = opts.scale[0];
    const [, ay, az] = opts.angles;
    const halfBarWidth = sx / opts.count / 2;
    const cosAz = Math.cos(az), sinAz = Math.sin(az);
    const cosAy = Math.cos(ay), sinAy = Math.sin(ay);
    for (let i = 0; i < opts.count; i++) {
      // 脚本布局：x = scale.x × (i/count) − scale.x/2 + halfBarWidth，再按对象 angles 旋转到世界。
      const localX = sx * (i / opts.count) - sx / 2 + halfBarWidth;
      const rx = localX * cosAy * cosAz;
      const ry = localX * cosAy * sinAz;
      const rz = localX * -sinAy;
      const id = this.addBackground({
        origin: [opts.origin[0] + rx, opts.origin[1] + ry, opts.origin[2] + rz],
        size: [opts.barSize[0], opts.barSize[1]],
        scale: [opts.barWidth, opts.minBarHeight, 1],
        angles: opts.angles,
        alignment: opts.alignment,
        texture: opts.texture,
        sceneW: opts.sceneW,
        sceneH: opts.sceneH,
        renderOrder: (opts.renderOrder ?? 0) + i + 1,
      });
      ids.push(id);
      this.pixelBars.push({
        id,
        barSizeH: opts.barSize[1],
        minBarHeight: opts.minBarHeight,
        objScaleY: opts.scaleY,
        downscaleMode: opts.downscaleMode,
        count: opts.count,
      });
    }
    return ids;
  }

  /** 每帧更新可视化条高度：freqData = 64 bin 频谱（0-255）；null = 无音频 → 全部归零。 */
  updateVisualizerBars(freqData: Uint8Array | null): void {
    for (let i = 0; i < this.visualizerBars.length; i++) {
      const bar = this.visualizerBars[i];
      const entry = this.backgroundEntries.get(bar.id);
      if (!entry) continue;
      const bin = freqData && i < freqData.length ? freqData[i] / 255 : 0;
      const h = bar.barSizeH * Math.max(0, Math.min(1, bin)) * bar.scaleY;
      entry.mesh.scale.y = h / bar.barSizeH;
      // bottom 对齐：条底部固定在 origin.y（脚本 barAlignmentdir='bottom'）。
      entry.mesh.position.y = bar.baseY + h / 2;
    }
    // pixel-bars：脚本公式 max(minBarHeight, audio × 对象 scale.y × 0.25)；无音频回到 minBarHeight。
    for (let i = 0; i < this.pixelBars.length; i++) {
      const bar = this.pixelBars[i];
      const entry = this.backgroundEntries.get(bar.id);
      if (!entry) continue;
      const span = 64 / bar.count;
      const start = Math.floor(i * span);
      const end = Math.min(64, Math.max(start + 1, Math.floor((i + 1) * span)));
      let audio = 0;
      if (freqData) {
        const vals: number[] = [];
        for (let p = start; p < end; p++) vals.push((freqData[p] ?? 0) / 255);
        audio = bar.downscaleMode === 'average' ? vals.reduce((a, b) => a + b, 0) / vals.length : Math.max(0, ...vals);
      }
      entry.mesh.scale.y = Math.max(bar.minBarHeight, audio * bar.objScaleY * 0.25);
    }
  }

  // util 层内容 = 整帧快照（T3）：真实 util 链读 `bind: previous`（层内容），快照必须成为内容（solid 保留纯色）。
  // `opts.cover` = 快照在内容 mesh UV 空间的落点；UV 变换落在内容几何上（快照纹理共享，不能改 repeat/offset）。
  setUtilContentTexture(
    objectId: number,
    texture: THREE.Texture,
    opts: { cover?: UtilContentCover } = {},
  ): void {
    const entry = this.utilContents.get(objectId);
    if (!entry) return;
    const material = entry.mesh.material as THREE.MeshBasicMaterial;
    let changed = false;
    if (material.map !== texture) {
      material.map = texture;
      material.opacity = 1; // 透明占位 → 快照内容
      material.needsUpdate = true; // 无 map → 有 map：需重编 program（每次装配仅一次）
      entry.texture = texture;
      changed = true;
    }
    const cover = opts.cover ?? FULL_UV_COVER;
    if (changed || !sameCover(entry.cover, cover)) this.applyUtilContentCover(entry, cover);
  }

  /** 测试/诊断：util 内容当前纹理；solid / 非 util → null。 */
  utilContentTextureForTest(objectId: number): THREE.Texture | null {
    return this.utilContents.get(objectId)?.texture ?? null;
  }

  /** 测试/诊断：util 内容当前的快照覆盖矩形（内容 mesh UV 空间）。 */
  utilContentUvForTest(objectId: number): UtilContentCover | null {
    const cover = this.utilContents.get(objectId)?.cover;
    return cover ? { ...cover } : null;
  }

  /** 最近一次段边界快照（渲染器每帧同步给 ObjectEffectStage 的 `_rt_FullFrameBuffer` 槽门控）。 */
  currentFrameSnapshot(): THREE.Texture | null {
    return this.lastFrameSnapshot;
  }

  // 登记 util 内容条目（内容 mesh 与快照内容区域的世界锚点）；solid 不登记（纯色内容不被替换）。
  private registerUtilContent(
    objectId: number,
    mesh: THREE.Mesh,
    centerX: number,
    centerY: number,
  ): void {
    const uv = mesh.geometry.attributes?.uv;
    if (!uv) return;
    this.utilContents.set(objectId, {
      mesh,
      baseUv: Float32Array.from(uv.array as ArrayLike<number>),
      cover: FULL_UV_COVER,
      texture: null,
      centerX,
      centerY,
    });
  }

  // 快照覆盖矩形 = 主相机 cover 视锥（世界，中心 = 场景中心，与 applyCover 同源）在内容 mesh
  // UV 空间的反解：u_tex = (u - sx)/sw。世界尺寸取**当前** mesh.scale × 几何（含镜像负值）。
  private utilContentCoverFor(objectId: number): UtilContentCover | null {
    const entry = this.utilContents.get(objectId);
    if (!entry) return null;
    const geometry = entry.mesh.geometry as THREE.PlaneGeometry;
    const gw = geometry.parameters?.width ?? 0;
    const gh = geometry.parameters?.height ?? 0;
    const worldW = entry.mesh.scale.x * gw;
    const worldH = entry.mesh.scale.y * gh;
    if (!(Math.abs(worldW) > 1e-6) || !(Math.abs(worldH) > 1e-6)) return null;
    const cover = coverRange(this.sceneWidth, this.sceneHeight, this.viewWidth / this.viewHeight);
    const left = entry.centerX - worldW / 2;
    const bottom = entry.centerY - worldH / 2;
    return {
      sx: (-cover.w / 2 - left) / worldW,
      sy: (-cover.h / 2 - bottom) / worldH,
      sw: cover.w / worldW,
      sh: cover.h / worldH,
    };
  }

  // 按覆盖矩形重写内容几何 UV（uv' = (uv - sx)/sw）：v=0 = 画面底 ⇒ 快照 v 约定不额外翻转。
  private applyUtilContentCover(entry: UtilContentEntry, cover: UtilContentCover): void {
    entry.cover = cover;
    const uv = entry.mesh.geometry.attributes?.uv;
    if (!uv) return;
    const arr = uv.array as Float32Array;
    const rx = 1 / cover.sw;
    const ry = 1 / cover.sh;
    const ox = -cover.sx / cover.sw;
    const oy = -cover.sy / cover.sh;
    for (let i = 0; i < arr.length && i < entry.baseUv.length; i += 2) {
      arr[i] = entry.baseUv[i] * rx + ox;
      arr[i + 1] = entry.baseUv[i + 1] * ry + oy;
    }
    uv.needsUpdate = true;
  }

  // 段边界把快照内容立即重渲进该 util 层 RT（帧首那次用的是上一帧快照/透明占位）。
  // 不走 renderIsolatedContents：那是帧边界观测点（e2e 帧计数/计时依赖它每帧恰好一次）。
  private renderUtilContent(objectId: number): void {
    const entry = this.isolated.get(objectId);
    if (!entry) return;
    const renderer = this.renderer as { autoClear?: boolean };
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true; // RT 内容整块替换：自动清屏避免残留上一帧内容
    try {
      renderIntoRenderTarget(this.renderer, entry.rt, entry.localScene, entry.localCamera);
    } finally {
      renderer.autoClear = prevAutoClear;
    }
  }

  // 段边界快照的拉取入口（ObjectEffectHost 契约）：拍一张「到此刻为止已绘制内容」。
  // 无 FrameCapture / 未激活（本壁纸无消费者）→ null；dispose 后 capture() 抛错 ⇒ 同样降级 null。
  captureFullFrame(): THREE.Texture | null {
    if (this.frameCapture?.active !== true) return null;
    try {
      return this.frameCapture.capture();
    } catch {
      return null; // 快照资源已释放：调用方按「无快照」降级，不把异常抛进帧循环
    }
  }

  // 快照代号的**实时**读取入口（ObjectEffectHost 契约）：调用方在执行当刻读它并与捕获当刻的代号
  // 比较，不一致即说明那张快照已被 resize/dispose 换掉。无 FrameCapture 时返回 -1（视为已作废）。
  frameSnapshotVersion(): number {
    return this.frameCapture?.snapshotVersion ?? -1;
  }

  // 重设隔离对象的 RT 尺寸（视口/dpr 变化时由编排器调用）：**只改分辨率**。
  // ⚠️ 局部相机覆盖的世界范围（camW/camH）与合成几何的 UV 窗口只依赖**世界尺寸**，与 RT 像素无关，
  // 这里不得改动它们：按 RT 像素重设会让 dpr>1 的对象内容缩小到 1/dpr 并露出边缘。
  // `id` = 隔离条目的键 = scene.json 的对象 id。
  resizeObjectRT(id: number, width: number, height: number): void {
    const entry = this.isolated.get(id);
    if (!entry) return;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (entry.rt.width !== w || entry.rt.height !== h) {
      entry.rt.setSize(w, h);
      // 扁平视图（rtWidth/rtHeight）必须与 rt 实际尺寸同步：编排器只读这两个字段。
      entry.rtWidth = w;
      entry.rtHeight = h;
    }
    // ⚠️ 采样标志必须随**视口**重估，不能只在尺寸变化时算：resize 只改变屏占位，而 RT 像素尺寸
    // 可能不变（源纹理收口 4096 顶着上限）⇒ 本调用放在尺寸早退分支**之外**。
    this.applyCompositeSampling(entry.rt, entry.worldW, entry.worldH);
  }

  // 渲染所有隔离对象的内容到各自 RT（player 拥有 scene/camera，故渲染留在 player）。
  // ⚠️ 必须走 renderIntoRenderTarget（透明清屏），直接 setRenderTarget + render 会画出黑块。
  private renderIsolatedContents(): void {
    for (const entry of this.isolated.values()) {
      renderIntoRenderTarget(this.renderer, entry.rt, entry.localScene, entry.localCamera);
    }
    this.renderer.setRenderTarget(null);
  }

  // 隔离对象的帧推进时间（秒，自 player 创建起）——g_Time 语义。
  elapsedSeconds(): number {
    const now = this.nowMs();
    // 暂停期间（含当前这段）不计入：效果链的 g_Time 在恢复后不跳变。
    const inPause = this.paused ? now - this.pausedAt : 0;
    return (now - this.startedAt - this.pausedTotal - inPause) / 1000;
  }

  // 背景图层。用 we_to_three 中心化定位（three = we - scene/2，y 不翻）、size×scale 定尺寸、
  // alpha/brightness 走 materialModulation（复用 scene-renderer 语义，见 AGENT.md §2.3）。
  // sceneW/sceneH 为场景固有尺寸（we_to_three 基准）；返回背景 id，供 update_background 引用。
  addBackground(opts: {
    origin: [number, number, number];
    size?: [number, number];
    scale: [number, number, number];
    // 对象欧拉角（**弧度**，scene.json 的 angles；缺省 [0,0,0]）。three 的 Object3D 变换顺序
    // 正是 T·R·S，所以 mesh.rotation 直接承载它。
    angles?: [number, number, number];
    // WE 图像颜色混合模式（缺省 0）。非 0 且**已实现**（6/7/31）时改用预乘 ShaderMaterial
    // + CustomBlending 复刻 WE 的 ApplyBlending；0 或未实现的模式 → 维持普通 alpha 混合。
    colorBlendMode?: number;
    texture?: THREE.Texture;
    alpha?: number;
    brightness?: number;
    // v0.8.2 F2：util 层无 pkg 纹理，按 layerKind 用内置材质（solid 纯色 / 其余直通占位）。
    util?: UtilLayerKind;
    // 对象颜色（0-255）：image tint 乘进内容材质（F13）；util=solid 作纯色。
    color?: [number, number, number];
    // 对象 alignment（WE 9 值）：origin 是锚点，内容 mesh / 合成 quad 中心按锚点偏移（F13）。
    alignment?: string;
    sceneW: number;
    sceneH: number;
    // scene.json 的**对象 id**（脚本图层桥的键）：本字段**总是传**（非隔离对象也要能被脚本按
    // 对象 id 找到），与只在隔离时传的 isolate.objectId 区分。
    objectId?: number;
    // 唯一绘制序（= scene.json objects 数组下标，对齐 WE `m_objectsByRenderOrder`：lwe CScene.cpp:94-101）。
    // 缺省 0（背景在粒子之前绘制）。
    renderOrder?: number;
    // 对象隔离（对象级效果链）：五字段把三种量分开——
    //   objectId         = scene.json 的**对象 id**，即隔离条目的键（见 attachIsolated 注释）；
    //   rtWidth/rtHeight = 对象 RT 像素尺寸（object-range.isolatedRtSize：≥ 屏占位、源纹理收口 4096）；
    //   worldW/worldH    = 合成 quad 的世界尺寸（= |size × scale|，**未钳制**幅值）。
    // 缺省不隔离（内容直接进主 scene，帧序不变）。
    isolate?: { objectId: number; rtWidth: number; rtHeight: number; worldW: number; worldH: number };
    // 对象级视差深度（scene.json 的 parallaxDepth，两根轴）；缺省 undefined = 不参与视差。
    parallaxDepth?: [number, number];
  }): number {
    const sceneW = opts.sceneW;
    const sceneH = opts.sceneH;
    // util 的 project/fullscreen = 全屏层：WE 语义铺满视口，强制居中 + 场景尺寸（忽略对象 origin/scale/size）。
    // 2597392171 #54 三者全缺省 ⇒ 原实现把合成 quad 放在场景左下四分之一。
    const utilFull = opts.util === 'project' || opts.util === 'fullscreen';
    const origin: [number, number, number] = utilFull
      ? [sceneW / 2, sceneH / 2, 0]
      : [opts.origin[0], opts.origin[1], opts.origin[2]];
    const layerScale: [number, number, number] = utilFull
      ? [1, 1, 1]
      : [opts.scale[0], opts.scale[1], opts.scale[2] ?? 1];
    const size = utilFull ? ([sceneW, sceneH] as [number, number]) : opts.size;
    // 背景尺寸 = size × scale（geometry 未缩放、mesh.scale 承载 scale）；size 缺省回退纹理宽高。
    // 精灵表（材质声明 spritesheet）回退**单帧**宽高；有 TEXS 但未声明的仍按整表尺寸（旧语义）。
    // util 无纹理：compose/solid 缺 size 时按 1×1（与 utilWorldSize 同口径）。
    const sprite = opts.util
      ? undefined
      : (opts.texture?.userData?.spritesheet === true ? textureSpriteInfo(opts.texture) : undefined);
    const imgW = opts.texture?.image?.width as number | undefined;
    const imgH = opts.texture?.image?.height as number | undefined;
    const fallbackW = opts.util ? (utilFull ? sceneW : 1) : (sprite ? (imgW ?? 1) / sprite.cols : (imgW ?? 1));
    const fallbackH = opts.util ? (utilFull ? sceneH : 1) : (sprite ? (imgH ?? 1) / sprite.rows : (imgH ?? 1));
    const w = size?.[0] ?? fallbackW;
    const h = size?.[1] ?? fallbackH;
    const geometry = new THREE.PlaneGeometry(w, h);
    // 内容材质调制：image 的 color tint × brightness 与 alpha 一次烘进（隔离路径同样烘进 RT；
    // 合成 quad 保持中性，见 createCompositeQuadMaterial）。
    // colorBlendMode ≠ 0：WE 的追加混合 pass 以**对象内容原色**为 B（桌面实测 2832263418 的 bars 取
    // Rainboww 彩虹而非对象 color 蓝调）⇒ 不做 color tint，避免内容被对象色污染。
    const mod = materialModulation(
      opts.colorBlendMode ? undefined : opts.color, opts.alpha, opts.brightness,
    );
    // ⚠️ 隔离对象（opts.isolate）走 forIsolation=true：内容材质**不套** cb，混合语义全部交给
    // 合成 quad（见 createLayerMaterial / createCompositeQuadMaterial 注释）。
    const material = opts.util
      ? this.createUtilLayerMaterial(
        resolveUtilMaterial(opts.util, { color: opts.color, alpha: opts.alpha }),
        !!opts.isolate,
        opts.brightness,
      )
      : this.createLayerMaterial(opts.texture ?? null, opts.colorBlendMode ?? 0, mod, !!opts.isolate);
    const mesh = new THREE.Mesh(geometry, material);
    // renderOrder 唯一化（调用方按 objects 下标传入）；缺省 0 = 背景在粒子之前绘制（背景在下）。
    mesh.renderOrder = opts.renderOrder ?? 0;
    const s = layerScale;
    mesh.scale.set(s[0], s[1], s[2] ?? 1);
    // 对象角度（弧度）：PlaneGeometry 以几何中心为 pivot，mesh.rotation 即 T·R·S 的 R。
    const a = opts.angles ?? [0, 0, 0];
    mesh.rotation.set(a[0], a[1], a[2]);
    // alignment：origin 是锚点，中心 = origin + 偏移（偏移先乘 scale、再随 angles 旋转）。
    const align = alignmentWorldOffset([w, h], s, a, opts.alignment);
    // we_to_three：origin - scene/2（y 不翻）。
    mesh.position.set(
      origin[0] - sceneW / 2 + align[0],
      origin[1] - sceneH / 2 + align[1],
      origin[2],
    );

    // 图层 id（本方法返回值 = backgroundEntries 的键）由本类计数器分配；隔离条目的键是
    // **scene.json 的对象 id**（`opts.isolate.objectId`），两套编号互不相干（见 attachIsolated）。
    const id = this.nextBackgroundId++;
    // 世界尺寸（未钳制幅值）：隔离路径下作合成 quad 的几何尺寸（缩放已并入几何，quad 自身
    // scale 恒为 1）；优先用调用方传入的 worldW/worldH（isolate 把「RT 像素」与「世界尺寸」分开），
    // 缺省回退 |size × scale|。
    const worldW = opts.isolate?.worldW ?? Math.abs(w * s[0]);
    const worldH = opts.isolate?.worldH ?? Math.abs(h * s[1]);

    if (opts.isolate) {
      // 隔离：内容只保留 scale（含镜像），位移/旋转交给合成 quad 承载；colorBlendMode 落在
      // 「贴回画面」这一步。键 = scene.json 的对象 id（**不是**下面的图层计数器 id）。
      mesh.position.set(0, 0, 0);
      mesh.rotation.set(0, 0, 0);
      // util 的 alpha 作用在合成输出：内容占位透明、效果链输出自带 alpha ⇒ 只能在 quad 上收口。
      const compositeOpacity = opts.util ? mod.a : 1;
      this.attachIsolated(opts.isolate.objectId, 'background', mesh, worldW, worldH, {
        width: opts.isolate.rtWidth,
        height: opts.isolate.rtHeight,
      }, {
        x: origin[0] - sceneW / 2 + align[0],
        y: origin[1] - sceneH / 2 + align[1],
        z: origin[2],
      }, [a[0], a[1], a[2]], opts.colorBlendMode ?? 0, opts.renderOrder, compositeOpacity);
      // util 层内容输入（T3）：段边界把整帧快照写成内容。solid 的内容是纯色 ⇒ 不建条目。
      if (opts.util && opts.util !== 'solid') {
        this.registerUtilContent(opts.isolate.objectId, mesh, origin[0] - sceneW / 2, origin[1] - sceneH / 2);
      }
    } else {
      this.scene.add(mesh);
    }

    this.backgroundEntries.set(id, {
      mesh,
      origin: [origin[0], origin[1], origin[2]],
      size: [w, h],
      scale: [s[0], s[1], s[2] ?? 1],
      angles: [a[0], a[1], a[2]],
      align,
      alignment: opts.alignment,
      color: opts.color,
      alpha: mod.a,
      brightness: opts.brightness ?? 1,
      sceneW,
      sceneH,
      // 隔离时位移的载体是合成 quad（内容只进对象 RT）；attachIsolated 在本方法之前登记 quad。
      parallaxNode: opts.isolate ? (this.isolated.get(opts.isolate.objectId)?.quad ?? mesh) : mesh,
      parallaxDepth: opts.parallaxDepth,
    });
    // scene 对象 id → 显示对象（隔离时是合成 quad —— 内容 mesh 只渲染进对象 RT，不进主场景）。
    if (opts.objectId !== undefined) {
      const shown = opts.isolate ? this.isolated.get(opts.isolate.objectId)?.quad : mesh;
      if (shown) this.displayObjects.set(opts.objectId, shown);
    }
    // 精灵表：纹理带 spritesheet 标记 + TEXS 帧网格 ⇒ 逐帧接管 quad UV（缺任一条件保持整图）。
    if (opts.objectId !== undefined && sprite && opts.texture?.userData?.spritesheet === true) {
      this.registerSpriteSheet(id, opts.objectId, mesh, sprite);
    }
    return id;
  }

  // puppet 图层：SkinnedMesh（带骨骼）或静态网格 + 视差登记。返回图层 id（与 addBackground 同一编号空间）。
  // 几何/材质所有权在 PuppetInstance（dispose 时释放）；此处只把 mesh 挂进场景并登记视差/脚本桥。
  addPuppet(opts: {
    objectId: number;
    puppet: PuppetInstance;
    origin: [number, number, number];
    scale: [number, number, number];
    // 对象欧拉角（**弧度**，scene.json 的 angles；与 addBackground 同口径）。
    angles: [number, number, number];
    sceneW: number;
    sceneH: number;
    // 唯一绘制序（= scene.json objects 数组下标）；缺省 0（背景在粒子之前绘制）。
    renderOrder?: number;
    // 对象级 alpha/brightness（同 addBackground，缺省 1/1 = 不改材质）；走 materialModulation 烘进 puppet 材质。
    alpha?: number;
    brightness?: number;
    // 对象级视差深度（同 addBackground）；缺省 undefined = 不参与视差。
    parallaxDepth?: [number, number];
    // scene.json 的 `animationlayers`（T8）：undefined = 字段缺失（逐帧退回「播动画表首个」）。
    animationLayers?: SceneImageObject['animationLayers'];
  }): number {
    const { mesh } = opts.puppet;
    mesh.renderOrder = opts.renderOrder ?? 0;
    // 对象级调制：与背景同一份公式（MeshBasicMaterial → color 乘亮度、opacity 取 alpha）；缺省 1/1 即原样。
    const mod = materialModulation(undefined, opts.alpha, opts.brightness);
    const mat = mesh.material as THREE.MeshBasicMaterial;
    mat.color.setRGB(mod.r, mod.g, mod.b);
    mat.opacity = mod.a;
    const s = opts.scale;
    mesh.scale.set(s[0], s[1], s[2] ?? 1);
    mesh.rotation.set(opts.angles[0], opts.angles[1], opts.angles[2]);
    // we_to_three：origin - scene/2（y 不翻，见 AGENT.md §2.3）。
    mesh.position.set(opts.origin[0] - opts.sceneW / 2, opts.origin[1] - opts.sceneH / 2, opts.origin[2]);
    this.scene.add(mesh);
    const id = this.nextBackgroundId++;
    // 复用背景条目：视差逐帧写位、player.dispose 释放几何/材质、脚本层桥都走同一条路径。
    // （同一条目会被两条释放路径各 dispose 一次 —— three 的 dispose 幂等。）
    this.backgroundEntries.set(id, {
      mesh,
      origin: [opts.origin[0], opts.origin[1], opts.origin[2]],
      size: [0, 0],
      scale: [s[0], s[1], s[2] ?? 1],
      angles: [opts.angles[0], opts.angles[1], opts.angles[2]],
      align: [0, 0], // puppet 网格无 alignment 样本（F13 只覆盖 image quad；真实库 puppet 均为 center/缺省）
      alpha: mod.a,
      brightness: opts.brightness ?? 1,
      sceneW: opts.sceneW,
      sceneH: opts.sceneH,
      parallaxNode: mesh,
      parallaxDepth: opts.parallaxDepth,
    });
    // 动画层：字段缺失记 null（逐帧区分「无元数据」与「显式无可见层」），存在则先按 visible 过滤。
    this.puppetLayers.set(id, {
      instance: opts.puppet,
      layers: opts.animationLayers === undefined
        ? null
        : opts.animationLayers.filter((l) => l.visible !== false),
      elapsed: 0,
    });
    // scene 对象 id → 显示对象（脚本 layer.visible/alpha 的落点，与 addBackground 同语义）。
    this.displayObjects.set(opts.objectId, mesh);
    return id;
  }

  // 图层材质（**内容**材质）：colorBlendMode 已实现（6/7/31）→ 预乘 ShaderMaterial +
  // CustomBlending（复刻 WE 的 ApplyBlending）；否则 MeshBasicMaterial（普通 alpha 混合）。
  // 隔离对象的合成 quad **不**用它，而用 createCompositeQuadMaterial（见该方法注释）。
  private createLayerMaterial(
    texture: THREE.Texture | null,
    colorBlendMode: number,
    mod: { r: number; g: number; b: number; a: number },
    forIsolation = false,
  ): THREE.Material {
    // 隔离路径（forIsolation=true）：内容只把「自己的颜色与 alpha」写进**新清空的 RT**，WE 的
    // colorBlendMode 混合语义由**合成 quad** 承担（见 createCompositeQuadMaterial）⇒ 这里
    // **不套用** cb 的 CustomBlending，否则：① alpha 因子 Zero/One 在 RT 里没有背景可保持 ⇒
    // RT alpha 恒 0 ⇒ 预乘片元被乘成 0 ⇒ 对象整体不可见；② 预乘写进 RT 后 quad 再预乘 ⇒ rgb × a²。
    const cb = forIsolation ? null : colorBlendModeToThree(colorBlendMode);
    if (cb) {
      return new THREE.ShaderMaterial({
        uniforms: {
          map: { value: texture ?? createWhiteTexture() },
          tint: { value: new THREE.Vector3(mod.r, mod.g, mod.b) },
          opacity: { value: mod.a },
        },
        vertexShader: COLOR_BLEND_VERTEX_SHADER,
        fragmentShader: COLOR_BLEND_FRAGMENT_SHADER,
        transparent: true,
        // 背景是透明图层，不写深度（避免干扰其他透明对象）。粒子 depthTest=false 不受影响。
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.CustomBlending,
        blendEquation: cb.blendEquation,
        blendSrc: cb.blendSrc,
        blendDst: cb.blendDst,
        // WE：`gl_FragColor.a = screen.a` —— 结果 alpha 取**背景**的（自己的 alpha 只当混合权重）。
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
      });
    }
    const basic = new THREE.MeshBasicMaterial({
      map: texture ?? null,
      transparent: true,
      depthWrite: false,
      // 隔离路径：WE 在对象有多个 pass 时把**首个 pass 强制成 BlendingMode_Normal（ONE/ZERO 覆盖）**
      // （lwe CImage.cpp：`(*first)->setBlendingMode(BlendingMode_Normal)`）⇒ 覆盖写，RT.rgb 保持
      // 非预乘、透明度只走 alpha（AGENT.md §5.27）。
      blending: forIsolation ? THREE.NoBlending : THREE.NormalBlending,
      // 隔离内容渲染进**y 镜像的局部相机**（对象 RT 取 WE 的 v 约定，见 attachIsolated）⇒ 屏幕空间
      // 绕序被翻转，正面朝外的 quad 会被背面剔除（对象整体消失）⇒ 隔离路径必须双面。
      side: forIsolation ? THREE.DoubleSide : THREE.FrontSide,
    });
    basic.color.setRGB(mod.r, mod.g, mod.b);
    basic.opacity = mod.a;
    return basic;
  }

  // util 层内容材质（v0.8.2 F2）：solid = 纯色（color×brightness、opacity=alpha）；直通 = 透明占位
  //（真实内容由效果链/整帧快照覆盖，首帧无内容时不得白屏）。隔离混合约定与 createLayerMaterial 一致。
  private createUtilLayerMaterial(spec: UtilMaterialSpec, forIsolation: boolean, brightness?: number): THREE.Material {
    if (spec.kind === 'solid') {
      const mod = materialModulation(spec.color, spec.opacity, brightness);
      const solid = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        blending: forIsolation ? THREE.NoBlending : THREE.NormalBlending,
        side: forIsolation ? THREE.DoubleSide : THREE.FrontSide,
      });
      solid.color.setRGB(mod.r, mod.g, mod.b);
      solid.opacity = mod.a;
      return solid;
    }
    return new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      // 透明占位：内容由 T3 的整帧快照/效果链输出提供。
      opacity: 0,
      depthWrite: false,
      blending: forIsolation ? THREE.NoBlending : THREE.NormalBlending,
      side: forIsolation ? THREE.DoubleSide : THREE.FrontSide,
    });
  }

  // 合成 quad 的材质：只负责「把对象 RT 的像素采样回主场景」。三点关键（都踩过）：
  //   ① 必须独立构造，**不能 clone 内容材质**——粒子内容材质依赖逐实例属性，普通 PlaneGeometry 没有
  //      这些属性会让 alpha 恒为 0（粒子完全不可见）；
  //   ② **不再二次施加** alpha/brightness/color 调制（内容材质已把调制烘进 RT，再乘一次 alpha 变 a²）；
  //   ③ 统一用 MeshBasicMaterial，只有 cb 分支额外开 `premultipliedAlpha`。
  // WE 的 `ApplyBlending` 语义在**合成这一步**用 CustomBlending 因子复刻（alpha 取背景的 ⇒ Zero/One）；
  // 带非零 angles 的对象由 quad 承载旋转，超过 90° 会翻转绕序 ⇒ 与内容材质一致用 DoubleSide。
  private createCompositeQuadMaterial(
    texture: THREE.Texture,
    colorBlendMode: number,
    opacity = 1,
  ): THREE.Material {
    const mat = new THREE.MeshBasicMaterial({
      map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      // 缺省 1 = 中性合成（image/particle 的 alpha 已烘进 RT，再乘一次是二次调制）；仅 util 层
      // 传入对象 alpha（内容占位/效果输出都不承载它）。
      opacity: Math.max(0, Math.min(1, opacity)),
    });
    const cb = colorBlendModeToThree(colorBlendMode);
    if (cb) {
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = cb.blendEquation;
      mat.blendSrc = cb.blendSrc;
      mat.blendDst = cb.blendDst;
      mat.blendSrcAlpha = THREE.ZeroFactor;
      mat.blendDstAlpha = THREE.OneFactor;
      // cb 的颜色因子不看 alpha，而 WE 语义是 `mix(A, blend(A,B), opacity)` ⇒ 图层 alpha
      // （opacity × mask）必须由片元预乘进 rgb，否则云层全强度盖住人物、mask 也失效（AGENT.md §5.26）。
      mat.premultipliedAlpha = true;
    }
    return mat;
  }

  // 合成采样决策：RT 大于屏占位（源纹理收口 4096 的结果）⇒ 合成 quad 那一步是**缩小采样**，
  // 必须开 mipmap 防走样。调用点 ① attachIsolated ② resizeObjectRT ③ resize（同式子、同一份 this 状态）。
  private applyCompositeSampling(rt: THREE.WebGLRenderTarget, worldW: number, worldH: number): void {
    const minifying = Math.max(rt.width, rt.height)
      > Math.max(Math.abs(worldW), Math.abs(worldH)) * this.screenScalePx() + 0.5;
    const nextMin = minifying ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    const flipped = rt.texture.minFilter !== nextMin;
    rt.texture.generateMipmaps = minifying;
    rt.texture.minFilter = nextMin;
    // 判定翻转才 dispose 重建 RT：RT 纹理的采样参数只在 setupRenderTarget 下发（needsUpdate 无效，
    // 见 AGENT.md §5.44）⇒ 不 dispose 则 minFilter 到不了 GL；未翻转时 dispose 等于每帧重建。
    if (flipped) rt.dispose();
  }

  // 建立对象隔离条目：RT + 局部正交相机 + localScene + 主场景合成 quad；合成 quad 用
  // createCompositeGeometry（世界尺寸含缩放、UV 按钳制窗口映射），position 承载对象世界位置。
  //
  // ⚠️ 第一个参数是 **scene.json 的对象 id**（键），不是本类的图层计数器 id：背景层与粒子层各有
  // 一个从 0 起的独立计数器，拿它们当键时（同一壁纸同时隔离 image 与 particle）后建的粒子条目会
  // **覆盖**先建的背景条目 ⇒ 静默画错。用对象 id 才能与 ObjectEffectStage / wasm PendingChainStore
  // 共用同一把键。
  // ⚠️ 旋转的分工**不可「统一」**：quadAngles 由调用方按「RT 内容是否已含旋转」决定 —— 背景内容
  // 不旋转（quad 承载对象 angles）；粒子内容 shader 已施加 objAngles（quadAngles 传 [0,0,0]，
  // 否则同一份旋转被施加两次）。
  // compositeOpacity（缺省 1）只由 util 层传对象 alpha：其内容占位透明、效果输出自带 alpha，
  // 对象 alpha 只能在最终合成这一步收口；image/particle 的 alpha 已烘进 RT，不得二次施加。
  private attachIsolated(
    objectId: number,
    kind: 'background' | 'particle',
    content: THREE.Object3D,
    worldW: number,
    worldH: number,
    size: { width: number; height: number },
    position: { x: number; y: number; z: number },
    quadAngles: [number, number, number],
    colorBlendMode: number,
    // 宿主对象的唯一绘制序（= objects 下标，调用方透传）；缺省按 kind 回退（背景 0 / 粒子 1）。
    renderOrder?: number,
    compositeOpacity = 1,
  ): void {
    const rtW = Math.max(1, Math.round(size.width));
    const rtH = Math.max(1, Math.round(size.height));
    // MSAA 分型：只有「整块盖满 RT 的 background quad」内部没有轮廓边、MSAA 结构性无效 ⇒ 关掉；
    // 粒子 billboard 即使铺满整屏也**有硬边**，必须保留（故满屏判定同时要求 kind === 'background'）。
    const isFullscreen = kind === 'background'
      && Math.abs(worldW) >= this.sceneWidth * 0.98 && Math.abs(worldH) >= this.sceneHeight * 0.98;
    const rt = new THREE.WebGLRenderTarget(rtW, rtH, { samples: isFullscreen ? 0 : 4 });
    // 合成采样标志（缩小采样必须开 mipmap）——与 resizeObjectRT 共用同一处判定。
    this.applyCompositeSampling(rt, worldW, worldH);
    // ⚠️ 局部正交相机的 left/right/top/bottom 是**世界坐标范围**，必须覆盖**完整对象世界尺寸**；
    // RT 像素尺寸只决定分辨率（object-range.isolatedRtSize：≥ 屏占位、源纹理收口 4096）。两个坑：
    //   ① 拿 RT 像素当相机范围 → dpr>1 时相机多覆盖 dpr 倍 ⇒ 内容只占 RT 的 1/dpr、四周空白，
    //      合成 quad 再按全窗口拉回世界尺寸 ⇒ 对象缩小 + 边缘 clamp 拉伸；
    //   ② 把相机范围钳到 OBJECT_RT_MAX → UV 窗口外侧被 CLAMP 采样成**边缘拉伸带**。
    // 超限对象的代价只能是**分辨率低**（欠采样），硬上限属于 RT **像素**尺寸，由 isolatedRtSize 收口。
    const camW = Math.max(1, Math.abs(worldW));
    const camH = Math.max(1, Math.abs(worldH));
    // ⚠️ **y 镜像局部相机**（top = -camH/2 < bottom = +camH/2）：对象 RT 是**效果链的输入**，效果
    // shader（WE 明文 GLSL）把 `v_TexCoord.y` 当**图像空间**纵坐标用（带符号位移 / 旋转滚动 UV），
    // 而 WE/lwe 的纹理约定是 `.tex` 首行落在 v=0（图像顶部，`CTexture.cpp:84` 直接上传、无翻转）
    // ⇒ WE 里 v 沿图像**向下**增长。three 显示路径把 `.tex` 翻成 v=0=图像底部，对象 RT 若沿用该
    // 约定，效果链里 v 就沿图像**向上**增长 ⇒ 位移/滚动的纵分量整体上下颠倒（AGENT.md §5.20）。
    // 这里把局部场景整体 y 镜像 ⇒ RT 的 v=0 = 图像顶部（与 WE 一致），再由合成 quad 的
    // `flipGeometryUvY` 翻回显示约定贴回主场景 ⇒ **画面不颠倒**（镜像与反镜像精确抵消）。
    // 副作用（已处理）：投影 y 取负会翻转**屏幕空间绕序** ⇒ 内容材质必须双面渲染。
    const localCamera = new THREE.OrthographicCamera(-camW / 2, camW / 2, -camH / 2, camH / 2, -1000, 1000);
    localCamera.position.z = CAMERA_DISTANCE;
    const localScene = new THREE.Scene();
    // 内容 mesh 保留原有（已烘调制的）材质：调制必须继续烘进 RT，只是合成 quad 不再重复施加。
    localScene.add(content);
    // 合成 quad 的材质独立构造、采样对象 RT 纹理（效果链就绪后由 setObjectOutput 换成效果输出）。
    // 几何世界尺寸 = 未钳制的 worldW/worldH；UV 窗口按**相机覆盖的世界范围**（camW/camH）映射，
    // 钳制轴只采样 RT 可见段；再 `flipGeometryUvY` 把 RT 的 WE 约定翻回显示约定。
    const compositeGeometry = createCompositeGeometry(worldW, worldH, camW, camH);
    flipGeometryUvY(compositeGeometry);
    const quad = new THREE.Mesh(
      compositeGeometry,
      this.createCompositeQuadMaterial(rt.texture, colorBlendMode, compositeOpacity),
    );
    quad.position.set(position.x, position.y, position.z);
    quad.rotation.set(quadAngles[0], quadAngles[1], quadAngles[2]);
    // 合成 quad 的绘制序跟随宿主对象；缺省沿原语义（背景 0 / 粒子 1）。
    quad.renderOrder = renderOrder ?? (kind === 'particle' ? 1 : 0);
    this.scene.add(quad);
    // 键 = scene.json 的对象 id（调用方传入），不是本类自己的图层计数器 id——见本方法头注释。
    this.isolated.set(objectId, {
      id: objectId, kind, rt, rtWidth: rtW, rtHeight: rtH, rtTexture: rt.texture,
      localScene, localCamera, quad, worldW, worldH,
    });
  }

  // 更新背景图层状态，对齐既有 update_image 语义——undefined = 保持现状；与当前状态相等的字段跳过；
  // 未知 id → no-op。origin 是 WE 场景坐标，中心化后写承载位置的 node（隔离 = 合成 quad，内容 mesh 在 RT 内恒 0）。
  update_background(
    id: number,
    origin?: [number, number, number],
    scale?: [number, number, number],
    alpha?: number,
    brightness?: number,
  ): void {
    const entry = this.backgroundEntries.get(id);
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
  resizeBackground(id: number, size: [number, number]): void {
    const entry = this.backgroundEntries.get(id);
    if (!entry) return;
    // puppet 图层（size=[0,0]）：几何是蒙皮网格自己的，换成 PlaneGeometry 会 dispose 掉它 ⇒ 早退。
    if (this.puppetLayers.has(id)) return;
    const [w, h] = size;
    if (w === entry.size[0] && h === entry.size[1]) return;
    entry.size = [w, h];
    const old = entry.mesh.geometry;
    entry.mesh.geometry = new THREE.PlaneGeometry(w, h);
    old.dispose();
    // 精灵表图层：新几何的 UV 是整图 [0,1]² ⇒ 以它为新的 base 并立即重写当前帧子矩形。
    for (const layer of this.spritesheetLayers.values()) {
      if (layer.backgroundId !== id) continue;
      const attr = (layer.mesh.geometry as THREE.BufferGeometry).attributes?.uv;
      layer.baseUv = attr ? Float32Array.from(attr.array as ArrayLike<number>) : new Float32Array(0);
      this.applySpriteSheetFrame(layer, Math.max(0, layer.frame));
    }
    const map = (entry.mesh.material as { map?: THREE.Texture | null }).map;
    if (map && (map as THREE.CanvasTexture).isCanvasTexture) map.dispose();
  }

  // 粒子图层。`simVerticesGetter` 每帧返回模拟器当前顶点（摊平 Float32Array，每粒子
  // `[pos3, size, uv2, color3, alpha, rot3, vel3]` 16 浮点，来自 wasm `SceneParticleSim::build_instance_vertices`）；
  // 渲染用 three.js `ShaderMaterial` billboard quad（每粒子一个实例）；模拟逻辑仍由
  // `SceneParticleSim` 承担（不重写模拟，只换渲染引擎）。返回分配的图层 id。
  addParticle(
    simVerticesGetter: () => Float32Array,
    opts: {
      tex?: THREE.Texture;
      frameCount: number;
      // 精灵表网格（列×行）。非精灵表缺省 cols=frameCount、rows=1（横向等分）；
      // 精灵表（WE flags 位 2，如 DK 的 fire1/fog1 = 8×8=64 帧）由 `textureFrameGrid` 给出。
      frameCols?: number;
      frameRows?: number;
      blend: 'additive' | 'alpha';
      softness?: number;
      // 对象变换（WE model matrix 语义；缺省 = 不做缩放，保持旧行为）：
      //   objectCenter  对象中心（世界坐标，we_to_three 后）
      //   objectScale   scene.json 的对象 scale（逐轴，可为负）
      //   emitterOrigin spec 的 emitter 局部原点（simEmitterOffset 用它算 bmOffset）
      objectCenter?: [number, number, number];
      objectScale?: [number, number, number];
      // 对象欧拉角（**弧度**，scene.json 的 angles；缺省 [0,0,0] = 不旋转）。model matrix 的 R。
      objectAngles?: [number, number, number];
      emitterOrigin?: [number, number, number];
      // 实例缓冲容量上界（= sim/spec 的 maxcount；见 ParticleLayer.capacity 注释）。
      maxInstances?: number;
      // 拖尾渲染条件（spec.renderer[0] == "spritetrail" 时由 `specRenderer()` 给出；缺省不启用）。
      // 三参数语义见 WE `common_particles.h` ComputeParticleTrailTangents → trailParams uniform。
      trail?: { length: number; maxLength: number; minLength: number };
      // 粒子透视相机（spec.flags perspective 位；`particlePerspectiveCamera()` 给出参数）。
      // 缺省不启用 → 顶点 shader 走主正交投影。fov/distance = WE 的 global_perspective 相机参数。
      perspective?: { fov: number; distance: number; aspect: number };
      // 屏幕空间折射（材质 combo REFRACT=1；由 three-renderer 按 `ParticleMaterialRef` 下发）：
      //   normalTex = 槽 1 的法线/遮罩纹理（与 map 同一帧网格 UV）；amount = 位移强度。
      // 缺省不启用（`defines` 里没有 REFRACT ⇒ program 与非折射层完全同源）。
      refract?: { normalTex: THREE.Texture; amount: number };
      // scene.json 的**对象 id**（脚本图层桥的键，语义同 addBackground.objectId）：**总是传**。
      objectId?: number;
      // 唯一绘制序（= scene.json objects 数组下标，语义同 addBackground）；缺省 1（粒子在背景之上）。
      renderOrder?: number;
      // 对象隔离（对象级效果链；五字段语义同 addBackground，世界尺寸 = particleWorldSize 的
      // **未钳制**值）：粒子 spec 无 size 字段、player 也不知道 distanceMax，必须由调用方算好传入。
      isolate?: { objectId: number; rtWidth: number; rtHeight: number; worldW: number; worldH: number };
      // 对象级视差深度（scene.json 的 parallaxDepth，两根轴）；缺省 undefined = 不参与视差。
      parallaxDepth?: [number, number];
    },
  ): number {
    const frameCount = Math.max(1, Math.floor(opts.frameCount));
    // 网格列/行：缺省横向等分（cols=frameCount、rows=1）；精灵表由调用方按纹理元数据给出，
    // 非法值回退缺省（防御越界 spec/纹理）。
    const frameCols = Number.isFinite(opts.frameCols) && (opts.frameCols as number) > 0
      ? Math.max(1, Math.floor(opts.frameCols as number))
      : frameCount;
    const frameRows = Number.isFinite(opts.frameRows) && (opts.frameRows as number) > 0
      ? Math.max(1, Math.floor(opts.frameRows as number))
      : 1;
    // softness 缺省按有无纹理对齐 wasm `particle_billboard` 的 mask_mode：有纹理 → 0.15（mask_mode=1
    // 时形状由 texel.a 提供、softness 不参与，仅作兜底）；无纹理（1×1 白图兜底）→ 1.0（整盘软圆点）。
    // 缺省不能是 0 —— 那会让无纹理粒子变成**硬边白方块**。调用方显式传值时以其为准。
    const hasTex = !!opts.tex;
    const softness = opts.softness ?? (hasTex ? 0.15 : 1.0);
    // 折射门槛：隔离层渲染进对象 RT，其裁剪空间 ≠ 屏幕 UV ⇒ 不启用 REFRACT（等价 WE 的「不折射」）；
    // amount 非法回落 WE 缺省 0.05。
    const refractEnabled = !!opts.refract && !opts.isolate;
    const refractAmount = Number.isFinite(opts.refract?.amount) ? (opts.refract as { amount: number }).amount : 0.05;

    // InstancedBufferGeometry：基础 4 角点四边形（position）+ 索引；每粒子一个实例（instanced 属性）。
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(PARTICLE_QUAD_CORNERS, 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(PARTICLE_QUAD_INDEX), 1));
    geometry.instanceCount = 0;

    // 初始 getter 数据 → 首帧写入（容量固定，见下）。
    const initial = simVerticesGetter();
    const count = Math.floor(initial.length / PARTICLE_FLOATS_PER_INSTANCE);

    // ⚠️ 实例缓冲容量必须**一次给足、之后不再替换属性**：three r170 在 `setupVertexAttributes` 里
    // 对 InstancedBufferGeometry **只锁存一次**容量（three.module.js L15653-15657，`undefined` 判断
    // ⇒ 属性怎么变都不再更新，只有 `geometry.dispose()` 会清掉）：
    //   `geometry._maxInstanceCount = geometryAttribute.meshPerAttribute * geometryAttribute.count`
    // 绘制时取 `Math.min(geometry.instanceCount, geometry._maxInstanceCount)`（L29764-29767），而
    // `renderInstances` 首行是 `if (primcount === 0) return;`（L15861-15863）—— 计数 0 时**不画**。
    // 建层时模拟器还没推进，getter 返回 0 粒子：照粒子数分配属性（0 长度）会把容量锁存成 0 ⇒ 该层
    // **永远不画**（「背景清晰但没有粒子」）；首帧恰好 1 个粒子则锁死 1 ⇒ 永远只画 1 个粒子。
    // 故按 sim 的 maxcount（`opts.maxInstances`，缺省 DEFAULT_PARTICLE_CAPACITY）**预分配**全部
    // instanced 属性，运行期只改 `geometry.instanceCount`（0..capacity）。
    const capacity = particleCapacity(opts.maxInstances ?? 0, count);

    // per-particle（每个实例）属性：pos(3)/size(1)/uv(2)/color(3)/alpha(1)；itemSize 与字段对应。
    const positions = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    const sizes = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    const uvs = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    const colors = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    const alphas = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    const rots = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    const velocities = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    geometry.setAttribute('particlePosition', positions);
    geometry.setAttribute('particleSize', sizes);
    geometry.setAttribute('particleUv', uvs);
    geometry.setAttribute('particleColor', colors);
    geometry.setAttribute('particleAlpha', alphas);
    geometry.setAttribute('particleRot', rots);
    geometry.setAttribute('particleVelocity', velocities);

    // ShaderMaterial：billboard quad（pos + corner*half_size）+ 多帧 uv 切片 + additive/alpha blend；
    // maskMode：有纹理→1（形状由 texel.a 提供）；无纹理白图兜底→0（软圆盘），对齐 wasm particle_billboard。
    const material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: opts.tex ?? createWhiteTexture() },
        frameCount: { value: frameCount },
        frameCols: { value: frameCols },
        frameRows: { value: frameRows },
        softness: { value: softness },
        maskMode: { value: hasTex ? 1.0 : 0.0 },
        // 折射 uniform 只给折射层（非折射层连 uniform 都不建：零开销、零分歧）。refractBg 缺省
        // 1×1 白 = 不做位移（快照由段渲染在消费者绘制前写入）。
        ...(refractEnabled
          ? {
              refractNormal: { value: (opts.refract as { normalTex: THREE.Texture }).normalTex },
              refractBg: { value: createWhiteTexture() },
              refractAmount: { value: refractAmount },
            }
          : {}),
        // 对象变换（缺省恒等 → 顶点 shader 退化为旧的 worldPos = particlePosition + corner*size/2）。
        objCenter: { value: new THREE.Vector3(...(opts.objectCenter ?? [0, 0, 0])) },
        objScale: { value: new THREE.Vector3(...(opts.objectScale ?? [1, 1, 1])) },
        objAngles: { value: new THREE.Vector3(...(opts.objectAngles ?? [0, 0, 0])) },
        emitterOrigin: { value: new THREE.Vector3(...(opts.emitterOrigin ?? [0, 0, 0])) },
        bmOffset: { value: new THREE.Vector3(...simEmitterOffset(opts.emitterOrigin ?? [0, 0, 0])) },
        // spritetrail（缺省关闭 → 顶点 shader 走原旋转分支，既有壁纸逐像素不变）。
        trailEnabled: { value: opts.trail ? 1.0 : 0.0 },
        trailParams: {
          value: new THREE.Vector3(
            opts.trail?.length ?? 1,
            opts.trail?.maxLength ?? 1,
            opts.trail?.minLength ?? 0,
          ),
        },
        texelRatio: { value: textureTexelRatio(opts.tex) },
        // 粒子透视相机（缺省关闭 → 走主正交投影，既有壁纸逐像素不变）。
        perspEnabled: { value: opts.perspective ? 1.0 : 0.0 },
        persp: { value: particlePerspMatrix(opts.perspective) },
        perspEye: { value: new THREE.Vector3(0, 0, opts.perspective?.distance ?? 0) },
        // 对象级视差的世界平移（逐帧由 tickParallax 写；0 = 与加视差前逐像素相同）。
        u_Parallax: { value: new THREE.Vector2(0, 0) },
      },
      vertexShader: PARTICLE_VERTEX_SHADER,
      fragmentShader: PARTICLE_FRAGMENT_SHADER,
      // three 的 define 进 program cache key：非折射层的 program 与改动前完全同源（仅在折射时
      // 给 defines 键 —— 显式 undefined 会被 Material 构造器告警刷屏）。
      ...(refractEnabled ? { defines: { REFRACT: 1 } } : {}),
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: opts.blend === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    const mesh = new THREE.Mesh(geometry, material);
    // 粒子散布在场景（非基础四边形包围球），禁用视锥剔除防止对象中心离屏时整层消失。
    mesh.frustumCulled = false;
    // 双保险：`InstancedBufferGeometry.computeBoundingSphere()` 只看**基础四边形**（半径≈1.4）而
    // **不看** per-instance 位置，任何仍按 boundingSphere 剔除的代码路径（未来重构、旧 three 版本、
    // 自定义 renderer/WebXR）都会把整层判为「离屏」（粒子在世界坐标 ±1200 处，包围球在原点）⇒
    // 花瓣全丢。显式给无限半径包围球，使该不变量不依赖 `frustumCulled` 一处。
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), Number.POSITIVE_INFINITY);
    // renderOrder 唯一化（调用方按 objects 下标传入，同排透明队列按它排序 ⇒ 与 WE 绘制序一致）；
    // 缺省 1 = 粒子晚于背景（0）绘制，即「粒子不被背景盖住」的确定性保险。
    mesh.renderOrder = opts.renderOrder ?? 1;
    if (opts.isolate) {
      // 粒子隔离：世界位移改由「内容 mesh 的负中心平移」承载，**不要**改 objCenter/objAngles
      // uniform —— shader 用 `local = particlePosition - objCenter - bmOffset` 反解局部坐标，而
      // particlePosition 本身就含对象中心（sim 以对象中心为发射基准），置零会让反解错误、内容整体出画。
      //   mesh.position = -objCenter ⇒ 局部场景最终位置 = R(angles)·(scale·(emitterOrigin+local))
      const c = opts.objectCenter ?? [0, 0, 0];
      mesh.position.set(-c[0], -c[1], -c[2]);
    } else {
      this.scene.add(mesh);
    }

    // 图层 id（本方法返回值 = particleLayers 的键）由本类计数器分配；隔离条目的键是
    // **scene.json 的对象 id**（`opts.isolate.objectId`），两套编号互不相干（见 attachIsolated）。
    const id = this.nextParticleLayerId++;
    const layer: ParticleLayer = {
      id,
      getter: simVerticesGetter,
      frameCount,
      geometry,
      material,
      mesh,
      positions,
      sizes,
      uvs,
      colors,
      alphas,
      rots,
      velocities,
      capacity,
      loggedFirstFrame: false,
      loggedCount: 0,
      refract: refractEnabled,
      loggedRefract: false,
      parallaxDepth: opts.parallaxDepth,
      parallaxCenter: [(opts.objectCenter ?? [0, 0, 0])[0], (opts.objectCenter ?? [0, 0, 0])[1]],
    };
    this.particleLayers.set(id, layer);
    // 立即写入首帧数据，保持 geometry 与 getter 一致（后续由 updateParticles 逐帧刷新）。
    this.writeParticleData(layer, initial, count);
    if (opts.isolate) {
      const center = opts.objectCenter ?? [0, 0, 0];
      // 世界尺寸由调用方按 particleWorldSize 算好传入，与 RT 像素尺寸**不可混用**：quad 世界占位若
      // 误用 RT 像素会被 dpr/预算收口二次缩放。quadAngles 传 [0,0,0]（RT 内容已含 R(angles)，再转
      // 一次就是双重旋转；背景路径相反）；colorBlendMode 传 0（粒子走普通 alpha 混合）。
      // 键 = scene.json 的对象 id，不是上面的图层计数器 id。
      this.attachIsolated(opts.isolate.objectId, 'particle', mesh, opts.isolate.worldW, opts.isolate.worldH,
        { width: opts.isolate.rtWidth, height: opts.isolate.rtHeight },
        { x: center[0], y: center[1], z: center[2] }, [0, 0, 0], 0, opts.renderOrder);
      // 隔离层的视差落点是合成 quad（内容 mesh 在对象 RT 内坐标为 -objCenter，不能在那里平移）。
      layer.parallaxIsolated = true;
      layer.parallaxQuad = this.isolated.get(opts.isolate.objectId)?.quad;
    }
    // scene 对象 id → 显示对象（隔离时是合成 quad，否则是粒子对象本身）。
    if (opts.objectId !== undefined) {
      const shown = opts.isolate ? this.isolated.get(opts.isolate.objectId)?.quad : mesh;
      if (shown) this.displayObjects.set(opts.objectId, shown);
    }
    // 折射层必须在自己被绘制**之前**拿到本帧快照 ⇒ 它本身就是段边界消费者（displayObjects 已登记，
    // 由 checkFrameConsumers 激活；setFrameCapture 晚于本调用时，激活发生在它那次评估里）。
    if (refractEnabled && opts.objectId !== undefined) {
      this.refractLayers.set(opts.objectId, layer);
      this.registerFrameConsumer(opts.objectId);
    }
    return id;
  }

  // 每帧刷新所有粒子图层：调用各自的 `simVerticesGetter()` 取当前顶点并写回 BufferAttribute。
  // `dt` 用于诊断日志（证明帧循环真的在跑、dt 是真实帧间隔且 >0）。
  updateParticles(dt: number): void {
    for (const layer of this.particleLayers.values()) {
      const data = layer.getter();
      const count = Math.floor(data.length / PARTICLE_FLOATS_PER_INSTANCE);
      // 诊断日志（真机 console 用；确定性判据），每层最多两行：① 首次出现非零粒子时打一条，含 dt
      // 与容量（dt≈0 / 缺本行 ⇒ 帧循环没在推进模拟）；② 粒子数首次满池时再打一条（证明持续累积
      // 发射到 maxcount）。只打首帧 count=1 极易被误读成「模拟只发射了 1 个粒子」。
      if (count > 0 && !layer.loggedFirstFrame) {
        layer.loggedFirstFrame = true;
        layer.loggedCount = count;
        console.log(
          `[three] 粒子已产出 layer=${layer.id} count=${count} dt=${dt.toFixed(4)}s capacity=${layer.capacity}` +
            `（首帧非零；模拟每帧累积发射，满 capacity 时再打印一条）`,
        );
      } else if (layer.loggedCount < layer.capacity && count >= layer.capacity) {
        layer.loggedCount = count;
        console.log(`[three] 粒子已达 maxcount layer=${layer.id} count=${count} dt=${dt.toFixed(4)}s`);
      }
      this.writeParticleData(layer, data, count);
    }
  }

  // 把 per-particle 摊平顶点（每粒子 16 浮点）拆到 7 个 instanced 属性并标记需重传。
  // 容量不足时按需扩容（正常不会发生：容量 = sim 的 maxcount）——扩容后**必须**同步
  // `geometry._maxInstanceCount`（three 的首帧锁存值，见 addParticle 注释），否则 draw 仍按旧容量截断。
  private writeParticleData(layer: ParticleLayer, data: Float32Array, count: number): void {
    const ensure = (
      attr: THREE.InstancedBufferAttribute,
      itemSize: number,
      need: number,
      name: string,
    ): THREE.InstancedBufferAttribute => {
      const arr = attr.array as Float32Array;
      if (arr.length >= need) return attr;
      const grown = new Float32Array(Math.max(need, Math.max(arr.length * 2, 1)));
      grown.set(arr);
      const next = new THREE.InstancedBufferAttribute(grown, itemSize);
      layer.geometry.setAttribute(name, next);
      return next;
    };
    layer.positions = ensure(layer.positions, 3, count * 3, 'particlePosition');
    layer.sizes = ensure(layer.sizes, 1, count, 'particleSize');
    layer.uvs = ensure(layer.uvs, 2, count * 2, 'particleUv');
    layer.colors = ensure(layer.colors, 3, count * 3, 'particleColor');
    layer.alphas = ensure(layer.alphas, 1, count, 'particleAlpha');
    layer.rots = ensure(layer.rots, 3, count * 3, 'particleRot');
    layer.velocities = ensure(layer.velocities, 3, count * 3, 'particleVelocity');

    // 实际容量 = 最小的「每实例元素数」换算回粒子数（7 个属性同步扩容，取最小以保守）。
    const minCapacity = Math.min(
      Math.floor((layer.positions.array as Float32Array).length / 3),
      (layer.sizes.array as Float32Array).length,
      Math.floor((layer.uvs.array as Float32Array).length / 2),
      Math.floor((layer.colors.array as Float32Array).length / 3),
      (layer.alphas.array as Float32Array).length,
      Math.floor((layer.rots.array as Float32Array).length / 3),
      Math.floor((layer.velocities.array as Float32Array).length / 3),
    );
    if (minCapacity > layer.capacity) {
      // 超出预分配容量（spec 未声明 maxcount 或声明不准）→ 同步 three 锁存的实例容量。
      layer.capacity = minCapacity;
      (layer.geometry as unknown as { _maxInstanceCount?: number })._maxInstanceCount = minCapacity;
    }

    const pos = layer.positions.array as Float32Array;
    const size = layer.sizes.array as Float32Array;
    const uv = layer.uvs.array as Float32Array;
    const color = layer.colors.array as Float32Array;
    const alpha = layer.alphas.array as Float32Array;
    const rot = layer.rots.array as Float32Array;
    const vel = layer.velocities.array as Float32Array;
    for (let i = 0; i < count; i++) {
      const b = i * PARTICLE_FLOATS_PER_INSTANCE;
      pos[i * 3] = data[b];
      pos[i * 3 + 1] = data[b + 1];
      pos[i * 3 + 2] = data[b + 2];
      size[i] = data[b + 3];
      uv[i * 2] = data[b + 4];
      uv[i * 2 + 1] = data[b + 5];
      color[i * 3] = data[b + 6];
      color[i * 3 + 1] = data[b + 7];
      color[i * 3 + 2] = data[b + 8];
      alpha[i] = data[b + 9];
      rot[i * 3] = data[b + 10];
      rot[i * 3 + 1] = data[b + 11];
      rot[i * 3 + 2] = data[b + 12];
      vel[i * 3] = data[b + 13];
      vel[i * 3 + 1] = data[b + 14];
      vel[i * 3 + 2] = data[b + 15];
    }
    layer.positions.needsUpdate = true;
    layer.sizes.needsUpdate = true;
    layer.uvs.needsUpdate = true;
    layer.colors.needsUpdate = true;
    layer.alphas.needsUpdate = true;
    layer.rots.needsUpdate = true;
    layer.velocities.needsUpdate = true;
    layer.geometry.instanceCount = count;
  }

  // 停止循环并释放 renderer 资源。
  dispose(): void {
    // 未决抓帧请求随播放器释放一并作废（否则 Promise 永不 settle）。
    this.pendingCapture?.(null);
    this.pendingCapture = null;
    this.renderer.setAnimationLoop(null);
    // 释放背景图层几何/材质（texture 所有权通常在外，随 scene 清理，不在此 dispose）。
    for (const entry of this.backgroundEntries.values()) {
      entry.mesh.geometry.dispose();
      (entry.mesh.material as THREE.Material).dispose();
    }
    this.backgroundEntries.clear();
    // 精灵表图层只持有 mesh 引用，随背景释放一并失效。
    this.spritesheetLayers.clear();
    // puppet：骨骼纹理与实例资源由 PuppetInstance 释放（几何/材质与上面的条目共用，dispose 幂等）。
    for (const layer of this.puppetLayers.values()) layer.instance.dispose();
    this.puppetLayers.clear();
    // 释放粒子图层几何/材质（texture 所有权在外，随 scene 清理，不在此 dispose）。
    for (const layer of this.particleLayers.values()) {
      layer.geometry.dispose();
      layer.material.dispose();
    }
    this.particleLayers.clear();
    // 隔离对象：RT / 合成 quad / 局部场景内容一并释放（避免切壁纸后 VRAM 泄漏）。
    for (const entry of this.isolated.values()) {
      entry.rt.dispose();
      entry.quad.geometry.dispose();
      (entry.quad.material as THREE.Material).dispose();
      entry.localScene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
    }
    this.isolated.clear();
    // util 内容条目只持有引用（几何/材质随 isolated 释放），快照纹理归 FrameCapture ⇒ 只清引用。
    this.utilContents.clear();
    this.lastFrameSnapshot = null;
    // 显示对象映射只持有引用，随上面各表的 dispose 一并失效。
    this.displayObjects.clear();
    this.objectEffectStage = null;
    // 应用级 Glow 的 RT/shader 归 stage 所有，须在 renderer.dispose() 前释放。
    this.glowStage?.dispose();
    this.glowStage = null;
    // 壁纸 bloom 的 stage 与中间 RT 同理。
    this.bloomStage?.dispose();
    this.bloomStage = null;
    this.bloomRT?.dispose();
    this.bloomRT = null;
    // 帧内快照**不在此释放**：它由创建者（three-renderer）独占释放并跨壁纸复用，在此 dispose 会让
    // 下一个壁纸拿到「已释放」实例（use() 静默无效、读 target 抛错）。
    this.frameCapture = null;
    this.frameConsumers.clear();
    this.warnedConsumers.clear();
    this.refractLayers.clear();
    // 末段合成 quad 归本类所有，须在 renderer.dispose() 之前释放。
    this.compositeQuad?.dispose();
    this.compositeQuad = null;
    this.renderer.dispose();
  }
}

// ===== 把 WE 场景加载进 three.js 播放器（背景图层 + 粒子系统）=====
//
// `loadSceneToThree(sceneJson, assets, canvas, viewport?)` 复用既有解析（scene-json →
// SceneDescription）、既有坐标（addBackground 内部 we_to_three，y 不翻）、既有材质调制
// （materialModulation），把 WE 场景内容转成 three.js 可渲染对象：
//   ① image 对象 → player.addBackground({origin,size,scale,texture,alpha,brightness,sceneW,sceneH})
//   ② particle 对象 → 每对象一个 CPU 模拟器（wasm `CpuParticleSim`，经 assets.createParticleSim
//      工厂注入）→ sim.set_frame_count(纹理帧数) → player.addParticle(() => sim.vertices(), …)。
// 播放循环：fn 每帧先 sim.update(dt)，再由 player 内部 update(dt) 读 getter 刷新 BufferAttribute。
// 背景/粒子共用同一 cover 正交相机；resize 的视口必须传**窗口/视口尺寸**（viewport 参数）而非场景
// 尺寸，否则窗口比例 ≠ 场景比例时背景会被 object-fit:fill 拉伸。
//
// 注意：不直接 import wasm `CpuParticleSim`——wasm-bindgen 把它导出为**静态** `CpuParticleSim.new(...)`
// （非 `new CpuParticleSim(...)`），且 node/jsdom 无法实例化 wasm 模块，故由工厂抽象（测试传 mock）。

// 粒子模拟器接口（对齐 wasm `CpuParticleSim` 的 JS 形态，供 three 播放器读顶点/驱动）。
export interface ParticleSim {
  update(dt: number): void;
  vertices(): Float32Array;
  frame_count(): number;
  set_frame_count(n: number): void;
  particle_count(): number;
  free?(): void;
}

// 每粒子对象的渲染/材质条件（由调用方预组装：spec JSON 供 sim 解析、纹理/混合/软化供渲染）。
export interface LoadedParticleAssets {
  specJson: string;                            // 粒子规格 JSON（原始），供 CpuParticleSim::new 解析
  tex?: THREE.Texture;                         // 粒子 sprite sheet 纹理（缺省 = 白图兜底）
  blend: 'additive' | 'alpha';                 // 混合模式（three ShaderMaterial.blending）
  softness?: number;                           // 中心→边缘软衰减（0-1）
  // scene.json 对象级 instanceoverride 的**原始 JSON 文本**（缺省/无覆盖 → undefined）。模拟器按
  // 官方 OverrideSpawnProgram 语义消费（alpha/size/lifetime/speed 乘数 + color 覆盖 + emitter rate × count）。
  overrideJson?: string;
  // 折射层条件（材质 REFRACT=1 + 槽 1 法线纹理）：仅折射层下发；槽 1 缺失/加载失败时调用方
  // **不装配该层**（WE NORMALMAP=0 语义：位移恒 0、输出≡背景，绝不回退白方块）。
  refract?: { normalTex: THREE.Texture; amount: number };
}

// 粒子模拟器工厂：从粒子规格 JSON + 对象中心构造模拟器。
// 生产传 wasm `CpuParticleSim` 的包装；测试传 mock（无需 wasm）。
// `overrideJson` = scene.json 对象 instanceoverride 的原始 JSON（空串 = 无覆盖）。
export type ParticleSimFactory = (
  json: string,
  origin: [number, number, number],
  sceneW: number,
  sceneH: number,
  overrideJson: string,
) => ParticleSim;

// 场景装配输入：调用方把已解码的纹理/规格/模拟器工厂交给 `loadSceneToThree`。
export interface SceneAssets {
  // 可选注入 renderer（node/jsdom 无 WebGL，测试用 mock 注入；缺省构造标准 antialias WebGLRenderer）。
  renderer?: THREE.WebGLRenderer;
  // 背景纹理：image 对象 id → THREE.Texture（缺省 = 无纹理 MeshBasicMaterial，纯色/留白）。
  backgroundTextures?: Map<number, THREE.Texture>;
  // puppet 图层（scene 对象 id → 实例）：调用方解析 `.mdl` 并建好网格后交进来；缺条目 = 该 image
  // 对象按普通背景贴图渲染（本机唯一 .mdl 样本是静态族，走的就是这条路径的另一半）。
  puppetMeshes?: Map<number, PuppetInstance>;
  // 粒子条件：particle 对象 id → 规格/纹理/混合。
  particles?: Map<number, LoadedParticleAssets>;
  // 粒子模拟器构造器（wasm CpuParticleSim 的包装；测试注入 mock）。
  createParticleSim?: ParticleSimFactory;
  // 对象隔离请求（对象级效果链）：scene.json 的**对象 id** → 隔离条件。调用方只为「带效果的对象」
  // 下发本表，未列入的对象不隔离（内容直接进主 scene，帧序不变）。
  //   ⚠️ 值的 `objectId` 就是本表的键：player 用它作**隔离条目的键**（见 attachIsolated），从而与
  //   ObjectEffectStage / wasm PendingChainStore 共用同一把键，不再需要「对象 id → 图层计数器 id」
  //   的翻译层（那层在 image+particle 同时隔离时会键冲突）。其余字段见 addBackground 的 isolate 注释。
  isolate?: Map<number, { objectId: number; rtWidth: number; rtHeight: number; worldW: number; worldH: number }>;
  // 场景树世界变换（可选）：scene.json 的**对象 id** → 父链累积后的世界 origin/scale/angles。
  // 由调用方折叠后下发；缺省逐字段回退对象自身局部值（行为不变）。
  // ⚠️ 必须由调用方下发：本函数按 sceneJson 文本重新 parseSceneJson，拿不到调用方对 desc 的覆写。
  worldTransforms?: Map<number, { origin: [number, number, number]; scale: [number, number, number]; angles: [number, number, number] }>;
  // 装配期有效可见性（对象 id → 是否可见；含用户属性 condition 与父链继承）：调用方按同一份
  // userProps 算好下发（本函数重 parse sceneJson，不知道用户属性）；player 新增消费的可绑定字段必须同样写回/下发。
  effectiveVisible?: Map<number, boolean>;
  // 渲染像素比档位（<1 降分辨率省显存/提流畅；缺省 1）。调用方算屏幕密度时必须用同一个数。
  qualityScale?: number;
  // text 对象图层（对象 id → 纹理 + 可选时钟/脚本驱动）：与 image 同路径渲染为背景 quad；调用方负责
  // visible 过滤、纹理创建与字体加载。size = 装配期 canvas 尺寸（文本 + 2×padding），anchorOffset =
  // origin 锚点 → 中心偏移；driver.layout 是**最近一次文本**的布局，帧内文本变化时用它重算 quad。
  textLayers?: Map<number, {
    texture: THREE.Texture;
    driver?: ClockDriver;
    size?: [number, number];
    anchorOffset?: [number, number];
  }>;
  // 每帧扩展钩子（SceneScript 运行时）：在粒子/文本更新之前调用，可写 three 对象状态。
  onFrame?: (dt: number) => void;
}

// `loadSceneToThree` 返回：播放器 + 已装配的模拟器/图层 id（供调用方驱动/释放/校验）。
export interface ThreeSceneLoadResult {
  player: ThreeScenePlayer;
  // 已创建的粒子模拟器（按 scene.json objects 顺序）；长度 = 有粒子 spec + createParticleSim 的粒子对象数。
  sims: ParticleSim[];
  // 背景图层 id（addBackground / addPuppet 返回值，按 objects 顺序）；长度 = image 对象数 + 隔离 util 层数。
  backgroundIds: number[];
  // puppet 图层 id（addPuppet 返回值）：上面 backgroundIds 的子集，单独给出供调用方判定「有没有可见对象」。
  puppetLayers: number[];
  // 粒子图层 id（addParticle 返回值）与其对应 sim 的配对。
  particleLayers: Array<{ id: number; sim: ParticleSim }>;
}

  // 对齐 wasm `particle_render::frame_count_from_dims`：sprite sheet 横向帧数 = 纹理宽/高
  // （每帧方形）。u32 整除 → floor。
export function frameCountFromDims(width: number, height: number): number {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  return Math.max(1, Math.floor(w / h));
}

// 从 THREE.Texture 读实际纹理尺寸推导 sprite sheet 帧数。DataTexture.image={width,height,data}；
// CompressedTexture.image 为 mip 数组；ImageBitmap/HTMLImageElement.image.width/height。
// 缺省/未知 → 1（单帧）。
//
// ⚠️ 优先取**纹理自带的 sprite 元数据**（`tex.userData.sprite`，由 tex-loader 解析 TEXS0005 的
// TEXS000x 段写入）：对 WE 的精灵表动画纹理（flags 位 2），按宽高推帧数是**错的**——DK 的
// `fire1`/`fog1` 都是 1024×1024 的 8×8=64 帧精灵表，`w/h=1` 会推出「1 帧」⇒ 每个粒子把整张表
// 当一帧画出来（全屏密布亮点 + 整屏泛光）。
export function textureFrameCount(tex?: THREE.Texture): number {
  const sprite = textureSpriteInfo(tex);
  if (sprite) return Math.max(1, Math.floor(sprite.frames));
  if (!tex) return 1;
  const img = tex.image as { width?: unknown; height?: unknown } | undefined;
  if (
    img &&
    typeof img.width === 'number' && typeof img.height === 'number' &&
    img.width > 0 && img.height > 0
  ) {
    return frameCountFromDims(img.width, img.height);
  }
  if (Array.isArray(tex.image)) {
    const first = tex.image[0] as { width?: unknown; height?: unknown } | undefined;
    if (
      first &&
      typeof first.width === 'number' && typeof first.height === 'number' &&
      first.width > 0 && first.height > 0
    ) {
      return frameCountFromDims(first.width, first.height);
    }
  }
  return 1;
}

// 读纹理携带的精灵表元数据（tex-loader 解析 TEXS000x 后写入 `userData.sprite`）。
// 非法/缺失 → undefined（调用方回退「按宽高推帧数 + 横向等分」的旧语义）。
export function textureSpriteInfo(
  tex?: THREE.Texture,
): { frames: number; cols: number; rows: number } | undefined {
  const raw = (tex?.userData as { sprite?: unknown } | undefined)?.sprite;
  if (!raw || typeof raw !== 'object') return undefined;
  const s = raw as { frames?: unknown; cols?: unknown; rows?: unknown };
  const frames = typeof s.frames === 'number' ? Math.floor(s.frames) : 0;
  const cols = typeof s.cols === 'number' ? Math.floor(s.cols) : 0;
  const rows = typeof s.rows === 'number' ? Math.floor(s.rows) : 0;
  if (frames <= 0 || cols <= 0 || rows <= 0) return undefined;
  return { frames, cols, rows };
}

// 帧网格（列×行）：精灵表 → 真实网格；否则 → { cols: frameCount, rows: 1 }（横向等分，旧行为）。
export function textureFrameGrid(tex?: THREE.Texture): { cols: number; rows: number } {
  const sprite = textureSpriteInfo(tex);
  if (sprite) return { cols: sprite.cols, rows: sprite.rows };
  return { cols: textureFrameCount(tex), rows: 1 };
}

export function loadSceneToThree(
  sceneJson: string,
  assets: SceneAssets,
  canvas: HTMLCanvasElement,
  viewport?: { width: number; height: number },
): ThreeSceneLoadResult {
  const desc = parseSceneJson(sceneJson);
  const sceneW = desc.orthogonal.width;
  const sceneH = desc.orthogonal.height;
  // 场景树世界变换（由 three-renderer 折叠后下发）：**每个对象都取世界值**——本函数会按 scene.json
  // 文本重新解析，拿不到 renderer 侧对 desc 的覆写。缺省（旧调用方/测试）逐字段回退局部值。
  const world = (o: { id: number; origin: [number, number, number]; scale: [number, number, number]; angles?: [number, number, number] }) => {
    const w = assets.worldTransforms?.get(o.id);
    return w
      ? { origin: w.origin, scale: w.scale, angles: w.angles }
      : { origin: o.origin, scale: o.scale, angles: o.angles ?? [0, 0, 0] as [number, number, number] };
  };
  // 构造器传场景尺寸（视口缺省与场景同尺寸），再用**真实视口** resize：viewport 由调用方显式传入
  // （vw/vh = window.innerWidth/Height）；缺省回退场景尺寸（cover == 场景尺寸，无裁剪）。
  // 清屏色随装配一次传入（desc.clearColor 已由 scene-json 从 general.clearcolor 解析）。
  const player = new ThreeScenePlayer(
    canvas, sceneW, sceneH, assets.renderer, assets.qualityScale, { clearColor: desc.clearColor },
  );
  player.setSceneSize(sceneW, sceneH);
  const vw = viewport?.width ?? sceneW;
  const vh = viewport?.height ?? sceneH;
  if (vw > 0 && vh > 0) player.resize(vw, vh);

  const backgroundIds: number[] = [];
  const puppetLayers: number[] = [];
  const particleLayers: Array<{ id: number; sim: ParticleSim }> = [];
  const sims: ParticleSim[] = [];
  // text 对象的时钟/脚本驱动（每帧判文本是否变化，变了才置 needsUpdate + 同步 quad）。
  const textDrivers: Array<{
    texture: THREE.Texture;
    driver: ClockDriver;
    backgroundId: number;                    // resizeBackground / update_background 的键
    origin: [number, number, number];        // obj.origin（锚点，未加偏移）
    scale: [number, number, number];
    horizontalAlign?: string;
    verticalAlign?: string;
    alignment?: string;
    anchor?: string;                         // F12：文本变化后重算锚点偏移时同样优先
  }> = [];

  // renderOrder = objects 数组下标（每对象唯一）：对齐 WE 的绘制序 `m_objectsByRenderOrder`
  // （lwe CScene.cpp:94-101/262-295）；`continue` 分支不改变数组下标。
  // 静态隐藏对象（visible:false / 用户属性关 / condition / 父链继承）WE 不渲染：优先用装配期
  // effective 表；旧调用方无该表时回退空 userProps 的旧判定（纹理已被装载过滤，建 quad 会成白色层）。
  const effectiveVisible = assets.effectiveVisible;
  for (const [renderOrder, obj] of desc.objects.entries()) {
    const hidden = effectiveVisible
      ? effectiveVisible.get(obj.id) === false
      : isStaticallyHidden(obj.visible, {});
    if (hidden) continue;
    if (obj.kind === 'image') {
      const t = world(obj);
      // puppet 对象：几何/骨骼/材质已由调用方按 `.mdl` 建好 ⇒ 不走 addBackground 的 quad 路径
      //（贴图已作为 puppet 材质的 map 注入）。视差/脚本桥/绘制序与背景同口径。
      const puppet = assets.puppetMeshes?.get(obj.id);
      if (puppet) {
        const id = player.addPuppet({
          objectId: obj.id,
          puppet,
          origin: t.origin,
          scale: t.scale,
          angles: t.angles,
          sceneW,
          sceneH,
          renderOrder,
          // 对象级调制（alpha/brightness）：与背景 quad 同一份 scene.json 字段，同一套 materialModulation。
          alpha: obj.alpha,
          brightness: obj.brightness,
          parallaxDepth: obj.parallaxDepth,
          // 动画层（T8）：逐帧选层由 player 负责，装配期只透传解析结果（undefined = 字段缺失）。
          animationLayers: obj.animationLayers,
        });
        backgroundIds.push(id);
        puppetLayers.push(id);
        continue;
      }
      // 背景对象：we_to_three（addBackground 内部）+ 对象调制（color/alpha/brightness）
      // + alignment 锚点（F13）→ 背景图层。
      const id = player.addBackground({
        origin: t.origin,
        size: obj.size,
        scale: t.scale,
        // WE 对象角度（弧度）→ mesh.rotation（three 的 Object3D 变换顺序即 T·R·S）。
        angles: t.angles,
        // v0.8.2 F13：color tint（0-255）+ alignment（9 值锚点）。
        color: obj.color,
        alignment: obj.alignment,
        // WE 图像颜色混合模式（非 0 且已实现时改用预乘 + CustomBlending，见 addBackground）。
        colorBlendMode: obj.colorBlendMode,
        texture: assets.backgroundTextures?.get(obj.id),
        alpha: obj.alpha,
        brightness: obj.brightness,
        sceneW,
        sceneH,
        // 脚本图层桥的键 = scene 对象 id（**总是传**，与只在隔离时传的 isolate.objectId 区分）。
        objectId: obj.id,
        // 唯一绘制序 = 本对象在 objects 数组中的下标。
        renderOrder,
        // 对象级效果链：带效果的对象其内容进 localScene 渲染到对象 RT，主场景放合成 quad；
        // 缺省不隔离。隔离条目的键 = obj.id，与 ObjectEffectStage 的键空间一致。
        isolate: assets.isolate?.get(obj.id),
        // 视差深度：Task 2 修订后**所有 kind** 都带该字段（SceneObjectBase.parallaxDepth）⇒ 直接透传；
        // 写成 `obj.kind === 'image' ? … : undefined` 会丢掉 text 图层的视差（真实库 20 处）。
        parallaxDepth: obj.parallaxDepth,
      });
      backgroundIds.push(id);
    } else if (obj.kind === 'text') {
      // text 与 image 同路径（quad + 纹理）；缺条目 = 调用方按 visible 过滤掉了该对象。
      // 几何 = 实测 canvas 尺寸（不是 scene.json 的 size）；中心 = origin + 锚点偏移
      // （halign/valign 决定 origin 落在文本框哪条边，见 textLayerOffset）。
      const layer = assets.textLayers?.get(obj.id);
      if (!layer) continue;
      const off = layer.anchorOffset ?? [0, 0];
      const t = world(obj);
      const id = player.addBackground({
        origin: [t.origin[0] + off[0], t.origin[1] + off[1], t.origin[2]],
        size: layer.size,
        scale: t.scale,
        angles: t.angles,
        texture: layer.texture,
        // v0.8.2 F12：alpha → 内容材质 opacity（同 image；合成 quad 中性避免 a²）；brightness 已烘进纹理。
        // 边界：效果链若重写 alpha，对象 alpha 会丢失（与 image 同款，见 spec §3）。
        alpha: obj.alpha,
        sceneW,
        sceneH,
        objectId: obj.id,
        // 唯一绘制序 = 本对象在 objects 数组中的下标。
        renderOrder,
        // 对象级效果链：带效果的对象其内容进 localScene 渲染到对象 RT，主场景放合成 quad；
        // 缺省不隔离。隔离条目的键 = obj.id，与 ObjectEffectStage 的键空间一致。
        isolate: assets.isolate?.get(obj.id),
        // 视差深度同 image 分支：直接透传对象级字段（text 也有 parallaxDepth）。
        parallaxDepth: obj.parallaxDepth,
      });
      backgroundIds.push(id);
      if (layer.driver) {
        textDrivers.push({
          texture: layer.texture,
          driver: layer.driver,
          backgroundId: id,
          origin: t.origin,
          scale: t.scale,
          horizontalAlign: obj.horizontalAlign,
          verticalAlign: obj.verticalAlign,
          alignment: obj.alignment,
          anchor: obj.anchor,
        });
      }
    } else if (obj.kind === 'util') {
      // util 层（v0.8.2 F2）：只有带效果链（有 isolate 条目）的层接入隔离渲染；无条目保持不渲染，
      // 不引入白块。层内容 = 内置材质（solid 纯色 / 其余直通占位，T3 用整帧快照填内容）。
      const isolate = assets.isolate?.get(obj.id);
      if (!isolate) continue;
      const t = world(obj);
      const id = player.addBackground({
        origin: t.origin,
        size: obj.size,
        scale: t.scale,
        sceneW,
        sceneH,
        objectId: obj.id,
        renderOrder,
        util: obj.layerKind,
        color: obj.color,
        alpha: obj.alpha,
        brightness: obj.brightness,
        isolate,
        parallaxDepth: obj.parallaxDepth,
      });
      backgroundIds.push(id);
    } else if (obj.kind === 'particle' && obj.particle) {
      // 粒子对象：仅当调用方提供 spec + 模拟器工厂时装配（缺 spec/工厂 → 跳过该对象，绝不白屏，
      // 与缺失粒子纹理时白图兜底同语义）。
      const p = assets.particles?.get(obj.id);
      if (!p || !assets.createParticleSim) continue;
      // 桌面不渲染的「稀疏事件源」粒子（见 specSparseEventSource 注释）→ 整层跳过，不建模拟器。
      if (specSparseEventSource(p.specJson)) continue;
      const t = world(obj);
      // createParticleSim(json, origin, sceneW, sceneH, overrideJson)（经工厂抽象：生产 wasm /
      // 测试 mock）。第 5 参 = 该对象 instanceoverride 的原始 JSON（无覆盖 → 空串）。
      const sim = assets.createParticleSim(p.specJson, t.origin, sceneW, sceneH, p.overrideJson ?? '');
      // 帧数对齐：sim.set_frame_count(纹理帧数) 且 addParticle 的 opts.frameCount 取 sim.frame_count()
      // ——避免多帧 uv 切片与 sim 帧编号错位。帧数优先取纹理的精灵表元数据（TEXS000x），否则按宽高推。
      const frameCount = textureFrameCount(p.tex);
      const grid = textureFrameGrid(p.tex);
      sim.set_frame_count(frameCount);
      // 对象变换（WE model matrix）：对象中心 we_to_three + scene.json 的 scale + spec 的 emitter 原点。
      // 顶点 shader 需要它们把模拟器输出的**发射点已乘黑神话 scale** 的坐标还原成局部坐标，再按
      // **本对象**的真实 scale 重建（各层 scale 与黑神话差异极大，不做这步会画成全屏辉光斑）。
      const emitterOrigin = specEmitterOrigin(p.specJson);
      const trailSpec = specRenderer(p.specJson);
      const id = player.addParticle(() => sim.vertices(), {
        tex: p.tex,
        frameCount: sim.frame_count(),
        frameCols: grid.cols,
        frameRows: grid.rows,
        blend: p.blend,
        softness: p.softness,
        objectCenter: [t.origin[0] - sceneW / 2, t.origin[1] - sceneH / 2, t.origin[2]],
        objectScale: [t.scale[0], t.scale[1], t.scale[2] ?? 1],
        // 对象角度（弧度）：顶点 shader 用它把局部运动方向/发射点/quad 角点旋转到场景空间。
        objectAngles: t.angles,
        emitterOrigin,
        // 实例缓冲容量 = spec 的 maxcount（= 模拟器的发射上限）。three 只在首帧锁存该容量
        // （见 addParticle），必须按模拟器**最终**会产出的粒子数一次给足；缺 maxcount → 缺省兜底。
        maxInstances: specMaxcount(p.specJson),
        // 拖尾渲染（spec.renderer[0] == "spritetrail"）：雨丝/风痕靠沿速度方向拉伸 billboard
        // 呈现（WE ComputeParticleTrailTangents）；非 spritetrail → 不传（sprite 外观零变化）。
        trail: trailSpec.kind === 'spritetrail' ? trailSpec : undefined,
        // 粒子透视相机（spec.flags 的 perspective 位）：WE 给这类对象换挂 global_perspective 相机，
        // 于是雨/雪/樱花等有近大远小的层次。无该位 → 不传。
        perspective: specPerspective(p.specJson)
          ? (() => {
              const cam = particlePerspectiveCamera({
                fov: desc.fov ?? 50,
                perspectiveOverrideFov: desc.perspectiveOverrideFov ?? 0,
                sceneH,
              });
              return { fov: cam.fov, distance: cam.distance, aspect: sceneW / sceneH };
            })()
          : undefined,
        // 折射层（材质 combo REFRACT=1）：槽 1 法线/遮罩 + 位移强度；非折射层不传（零分歧）。
        refract: p.refract,
        // 脚本图层桥的键 = scene 对象 id（总是传）。
        objectId: obj.id,
        // 唯一绘制序 = 本对象在 objects 数组中的下标。
        renderOrder,
        // 对象级效果链：带效果的粒子对象同样隔离（对象 RT + 合成 quad）。世界尺寸由调用方按
        // `particleWorldSize(spec, scale)` 算好（player 不知道 spec 的 distanceMax）；缺省不隔离。
        isolate: assets.isolate?.get(obj.id),
        // 视差深度：真实库 parallaxDepth 有 106 处落在 particle 对象上（最大的一支）。
        parallaxDepth: obj.parallaxDepth,
      });
      particleLayers.push({ id, sim });
      sims.push(sim);
    }
  }

  // 播放循环：每帧先 sim.update(dt)（dt 由 setAnimationLoop 帧差分、clamp 0.1），再 player.update(dt)
  // （→ updateParticles 读 getter = sim.vertices()，sim 已在帧内推进）。
  player.setAnimationLoop((dt) => {
    // SceneScript 先跑：脚本状态是图层的权威来源，其写入在本帧渲染前生效。
    assets.onFrame?.(dt);
    for (const sim of sims) sim.update(dt);
    // 时钟/脚本文本：文本变化才重绘（同分钟不重绘）→ 置 needsUpdate 触发纹理上传，并按新文本的
    // 实测布局同步 quad 尺寸与锚点中心（origin 是锚点 ⇒ 原地生长/收缩）。
    for (const t of textDrivers) {
      if (!t.driver.update(new Date())) continue;
      t.texture.needsUpdate = true;
      const layout = t.driver.layout;
      const off = textLayerOffset(layout, t.horizontalAlign, t.verticalAlign, t.alignment, t.scale, t.anchor);
      const o = t.origin;
      player.update_background(t.backgroundId, [o[0] + off[0], o[1] + off[1], o[2]]);
      player.resizeBackground(t.backgroundId, [layout.width, layout.height]);
    }
  });

  return { player, sims, backgroundIds, particleLayers, puppetLayers };
}
