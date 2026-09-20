// Task 1：three.js 场景骨架（renderer + 正交相机 cover + RAF 循环）。
// 这是「WE 场景 → three.js 播放器」思路的第一步：先把播放器骨架搭好，后续 Task 2/3/4
// 往里加背景 Sprite 与粒子。
//
// 坐标 / cover 语义复用 scene-renderer.ts（不重写，避免双份语义漂移）：
//   - coverRange(sceneW, sceneH, viewAspect)：把场景固有尺寸（WE 正交视口 view_w×view_h）
//     按视口宽高比做 cover 裁剪（铺满、不变形、超出方向裁掉），得到正交相机视锥尺寸
//     view_w/view_h。构造传入的 width/height 是场景固有尺寸（scene.json 未就绪前的冗余值）；
//     视口缺省与场景同尺寸，此时 cover == contain == 场景尺寸（无裁剪）。
//   - CAMERA_DISTANCE：相机沿 +z 放置，使 shader 里 300/-mv.z = 1（点尺寸=像素尺寸）。
//   - 正交相机 y 轴不做翻转（WE 系左下原点 y 向上与 three 正交相机一致，见 scene-renderer
//     文件头坐标注释；背景/粒子用同一相机，保持 cover 与 we_to_three 语义）。
import * as THREE from 'three';
// 几何/尺寸纯函数来自 object-range.ts（唯一实现）：coverRange 是 scene-renderer 重新导出的
// 同一份实现；CAMERA_DISTANCE / materialModulation 此前经由 scene-renderer 转手，本任务
// 改为直接从 object-range.js 取（createCompositeGeometry 也在这里），避免多一层转手。
import { coverRange, CAMERA_DISTANCE, materialModulation, createCompositeGeometry, flipGeometryUvY, screenScalePx } from './object-range.js';
import { parseSceneJson } from './scene-json.js';
// 渲染进对象 RT 必须透明清屏（清屏 alpha=0），否则内容透明处/效果降 alpha 处会变成不透明黑。
// 根因见 rt-render.ts 与 AGENT.md §5.22。
import { renderIntoRenderTarget } from './rt-render.js';
// 应用级 Glow 的注入点类型（本任务只加 hook，装配在后续 Task）。
import type { GlowStage } from './glow-stage.js';
// 文本图层：帧内文本变化 → 按新 layout 同步 quad 尺寸与锚点中心（textLayerOffset）。
import { textLayerOffset } from './text-object.js';
import type { ClockDriver, TextLayout } from './text-object.js';

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
  alpha: number;         // 已应用 material.opacity（0-1）
  brightness: number;    // 亮度乘法系数（原始值，materialModulation 内部 clamp）
  // 该背景创建时用的场景固有尺寸（we_to_three 中心化基准 = origin - scene/2）。
  sceneW: number;
  sceneH: number;
};

// 粒子图层条目（Task 3）：记录 three.js billboard quad 的 GPU 资源与配套模拟取顶点 getter。
// 每粒子一个**实例**（InstancedBufferGeometry 的 instanced attribute），顶点 shader 由
// 基础四边形角点（position=[-1,1]²）+ 每粒子位置/尺寸展开成屏幕对齐的 billboard。
type ParticleLayer = {
  id: number;
  // 每粒子数据来自 wasm `SceneParticleSim::build_instance_vertices`（摊平 Float32Array，
  // 每粒子 `[pos3,size,uv2,color3,alpha]` 10 浮点）。getter 每帧刷新时返回当前顶点。
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
  // 实例缓冲**容量**（= 每个 instanced attribute 的 count，即一次能画的最大粒子数）。
  // 关键：three 只在**首次渲染**时把该容量锁存进 `geometry._maxInstanceCount`（见 addParticle
  // 注释），故容量必须一次给足（sim 的 maxcount），运行期只改 `geometry.instanceCount`（0..capacity）。
  capacity: number;
  // 「粒子已产出」日志只打一次（首帧 instanceCount 由 0 变正时），防每帧刷屏。
  loggedFirstFrame: boolean;
  // 已记录过的粒子数（倍增时再记一条，见 updateParticles）：用于在真机 console 里**看到计数增长**
  // （旧日志只在首帧非零时打一次 count=1，极易被误读为「只发射了 1 个粒子」）。
  loggedCount: number;
};

// 粒子实例缓冲的**缺省容量**与上限。容量 = 「本层一次最多画多少个粒子」= 每个 instanced attribute
// 的 count，必须 ≥ 模拟器最终会产出的粒子数（sim 的 `maxcount`，WE spec 的 maxcount 字段）。
// 生产路径由 `loadSceneToThree` 传入 spec 的 maxcount（黑神话 leaves5 = 50）；spec 缺 maxcount
// （旧格式，wasm 侧 `maxcount=0` → 模拟器不发射）或测试注入 mock sim 时用缺省值兜底。
// 上限与 wasm 粒子池 clamp [16, 2048]（render/particle_pass.rs）对齐，防异常 spec 爆内存。
export const DEFAULT_PARTICLE_CAPACITY = 1024;
export const MAX_PARTICLE_CAPACITY = 2048;

// 从粒子 spec JSON 读 `maxcount`（= wasm `SceneParticleSim.maxcount`，同一份 JSON 的同一字段；
// WE 的 JSON 里也可能是字符串 "50"）。缺省/非法/非正 → 0（调用方落到 DEFAULT_PARTICLE_CAPACITY）。
export function specMaxcount(specJson: string): number {
  try {
    const v = (JSON.parse(specJson) as { maxcount?: unknown }).maxcount;
    const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : 0;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

// 从粒子 spec JSON 读 **emitter 的局部原点**（`emitter[0].origin`，WE 字符串 "x y z"）。
// 与 wasm `spec_to_emitter::parse_particle_spec` 同源语义：只用**第一个** emitter、缺省 [0,0,0]、
// 缺省 y **不翻**（本仓库 three 路径的 y 与背景同系，不翻）。非法/缺失 → [0,0,0]（绝不抛）。
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

// wasm `SceneParticleSim` 在 spawn 时对 **发射点** 乘的硬编码对象 scale（黑神话 Sakura 的
// scene.json scale，见 wasm/src/particle/sim.rs `BLACKMYTH_OBJ_SCALE`）。three 路径的顶点 shader
// 要从模拟器输出里**减掉**这项才能拿到纯局部坐标（散射 + 运动），再按真实对象 scale 重建 ——
// 因此这里必须与 wasm 常量逐位一致（两边同源，改动需同步）。
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
// worldPos = particlePosition + corner*half_size（half_size = particleSize/2），再用
// modelViewMatrix×projectionMatrix（mvp）投影。position/normal/uv/矩阵由 three.js 自动注入；
// 这里只补每粒子 instanced 属性（particlePosition/Size/Uv/Color/Alpha）与传递 varyings。
const PARTICLE_VERTEX_SHADER = `
attribute vec3 particlePosition;
attribute float particleSize;
attribute vec2 particleUv;
attribute vec3 particleColor;
attribute float particleAlpha;
// 对象变换（WE 的粒子 model matrix 语义，见 loadSceneToThree 注释）：
//   objCenter     对象中心（世界坐标，we_to_three 后）
//   objScale      scene.json 的对象 scale（逐轴，可为负 = 镜像）
//   emitterOrigin spec 的 emitter 局部原点（原值，未缩放）
//   bmOffset      模拟器已加进 particlePosition 的偏移 = BLACKMYTH_OBJ_SCALE ⊙ emitterOrigin
uniform vec3 objCenter;
uniform vec3 objScale;
uniform vec3 emitterOrigin;
uniform vec3 bmOffset;
// 对象欧拉角（**弧度**）—— WE model matrix = T·R·S 的 R 部分。
uniform vec3 objAngles;
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
  // × rotate(angles) × scale）。⚠️ 旋转**必须**在这里做：全库 79 个对象带非零 angles
  // （粒子 75 个），漏掉它会让粒子的局部朝向直接当世界朝向用 —— GTR 3743126786 的烟柱
  // angles.z = -1.20063（≈ -68.8°）本应把局部 +Y（湍流的 forward）转到世界 (0.932, 0.362)
  // =「从排气管向右侧飘」，漏掉旋转后烟就直着往上走。
  vec3 worldPos = objCenter + weObjectRotate(objScale * (emitterOrigin + local), objAngles);
  // 粒子 quad 的尺寸同样乘对象 scale（非均匀；abs 去掉镜像的符号），并随对象角度一起转。
  vec3 corner = weObjectRotate(abs(objScale) * vec3(position.xy * particleSize * 0.5, 0.0), objAngles);
  worldPos += corner;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(worldPos, 1.0);
  // ⚠️ 修正：粒子是 2D billboard（无深度排序，z 不参与可见性）。three 正交相机 far/near 会把
  // 视锥外的 z 裁剪掉，而 wasm billboard 早已把投影矩阵 z 行全 0（clip.z=0，见 particle_billboard.wgsl）
  // 防「emitter 球壳散射可到 ±750 的粒子被 z 裁剪 → 粒子不可见」。这里把 NDC z 强制归中（0），
  // 配合 material.depthTest=false（忽略深度），保证粒子不被相机深度范围裁剪（对齐 wasm 语义）。
  gl_Position.z = 0.0;
}
`;

// 粒子 billboard fragment shader：多帧 uv 切片（frameCount，uv.x 帧子区，y 占满整高）→
// 采样纹理 → color*texel.rgb、alpha=texel.a*particle.alpha；softness 做中心→边缘软衰减。
// 混色（additive/alpha）由 three.js material.blending 承担（openGL blending），这里只输出 RGBA。
// 形状对齐 wasm `particle_billboard.wgsl` 的 mask_mode（2026-09-09）：
//   - mask_mode=1（真实纹理）：shape = texel.a（alpha 遮罩提供形状，**不再额外乘圆盘**）→
//     光线/花瓣/雪片保持纹理本身的形状，不被软圆盘裁成圆形；
//   - mask_mode=0（无纹理 1×1 白图兜底）：shape = 软圆盘（disk，softness 控制边缘）→ 纯色软圆点。
// 此前恒 `texel.a*falloff`（=mask_mode=1 还叠加圆盘）→ 有纹理粒子也被裁成软圆盘（丢形状），
// 且无纹理粒子呈硬边白块（softness=0 旧病，已由缺省 softness 修正）。
const PARTICLE_FRAGMENT_SHADER = `
uniform sampler2D map;
uniform float frameCount;
uniform float frameCols;
uniform float frameRows;
uniform float softness;
uniform float maskMode;
varying vec2 vCornerUv;
varying vec2 vParticleUv;
varying vec3 vParticleColor;
varying float vParticleAlpha;
void main() {
  float n = max(frameCount, 1.0);
  // 帧号由 uv.x 编码（帧子区中心，sim frame_center_uv：(frame+0.5)/n）→ 反解出离散帧号。
  float frameIndex = floor(clamp(vParticleUv.x, 0.0, 0.999999) * n);
  frameIndex = min(frameIndex, n - 1.0);
  // 精灵表按**二维网格**切片（frameCols×frameRows；非精灵表 cols=n、rows=1，与旧的横向等分等价）。
  // ⚠️ 旧实现只做横向等分（texUv.x=(frameIndex+corner.x)/n），对 WE 的 8×8=64 帧精灵表
  // （DK 的 fire1/fog1）会把每条 1/64 宽的**竖条**当一帧 → 必须用网格行列定位。
  float cols = max(frameCols, 1.0);
  float rows = max(frameRows, 1.0);
  float col = mod(frameIndex, cols);
  float row = floor(frameIndex / cols);
  // 帧 y：TEXS 的帧 y 是**纹理顶部向下**的行号，而 DataTexture 数据已被翻转为 bottom-up
  // （v=0=图像底部）→ row=0（表顶行）应落在 v 高段，故对帧内 v 做 (rows-1-row) 反转。
  float frameV = (rows - 1.0 - row + vCornerUv.y) / rows;
  vec2 texUv = vec2((col + vCornerUv.x) / cols, frameV);
  vec4 texel = texture2D(map, texUv);
  // 圆盘软衰减（center→edge）。softness ∈ [0,1]：0=硬边（仅在 quad 边缘收尾），1=全柔（中心→边缘平滑衰减）。
  float dist = length(vCornerUv - 0.5) * 2.0;
  float edgeStart = clamp(1.0 - softness, 0.0001, 0.9999);
  float disk = 1.0 - smoothstep(edgeStart, 1.0, dist);
  // mask_mode：1（真实纹理遮罩，形状=texel.a）↔ 0（无纹理软圆点，形状=disk）。
  float shape = mix(disk, texel.a, maskMode);
  float a = vParticleAlpha * shape;
  gl_FragColor = vec4(vParticleColor * texel.rgb, a);
}
`;

// 无纹理（opts.tex 缺省）时的 1×1 白色兜底（同 scene-renderer.createWhiteDataTexture 语义）：
// 纯色粒子不依赖纹理内容，白图 → texel=白、alpha=1，颜色/透明度由 vParticleColor/vParticleAlpha 给定。
function createWhiteTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

// ── WE 图像颜色混合模式（`colorBlendMode` → shader combo `BLENDMODE`）────────────────────────
//
// WE 的 image 对象带 `colorBlendMode != 0` 时会**额外追加一遍混合 pass**
// （材质 `materials/util/effectpassthrough.json`，shader = `genericimage3`；
//  见 lwe `CImage.cpp:751-767`）。该 pass 的片元逻辑（WE 明文 shader）：
//
//   vec4 screen = texSample2D(g_Texture4, screenUV);            // g_Texture4 = 当前帧缓冲（背景 A）
//   gl_FragColor.rgb = ApplyBlending(BLENDMODE, screen.rgb, gl_FragColor.rgb, gl_FragColor.a);
//   gl_FragColor.a   = screen.a;                                 // alpha 保持背景的
//
// 而 `ApplyBlending`（`shaders/common_blending.h`）对每个模式给出 `mix(A, F(A,B), op)`，
// 其中 A=背景、B=对象颜色、op=对象自身的 alpha。three 侧用 `CustomBlending` 复刻：
// 片元**预乘**输出（rgb × alpha），再配 `blendSrc/blendDst`，使
//   result = src·srcFactor + dst·dstFactor
// 与 WE 的 `mix(A, F(A,B), op)` 等价。已实现的三个模式（= 全库仅有的三个非零值）：
//
//   7  Screen  F = A + B − A·B  →  mix = A + op·B − op·A·B = (op·B)·(1−A) + A
//              ⇔ src=(op·B), blendSrc=ONE_MINUS_DST_COLOR, blendDst=ONE
//              关键性质：B=0（纯黑）时结果 = A —— **黑底完全不改变背景**（GTR 的 Clouds Back）。
//   31 A + B·op → src=(op·B), blendSrc=ONE, blendDst=ONE
//   6  Lighten F = max(A,B)（op≈1）→ blendEquation=MAX
//
// 其余模式（1..5/8..30/32）暂未实现 → 返回 null，调用方回退普通 alpha 混合（不静默画错）。

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
// （纹理 × tint，alpha = texel.a × opacity），但**预乘输出** —— CustomBlending 的
// src 因子作用在 src.rgb 上，WE 公式里需要 `op·B`（op = 对象 alpha），
// 不预乘就拿不到这个乘数（`ONE_MINUS_DST_COLOR` 等因子只看 dst）。
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
// 局部内容只保留 scale（含负值镜像），position/rotation 归零——效果因此作用在对象**自身
// 纹理空间**，旋转与位移由合成 quad 承载（spec §2.3 论据 b）。
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
}

// 渲染像素比 = 设备像素比 × 画质档位。画布缓冲与对象 RT 的屏幕密度都按它算，
// three-renderer 挂载期算屏幕密度必须调**同一个函数**（口径不一致会让整层模糊，见 AGENT.md §5.15）。
export function resolvePixelRatio(devicePixelRatio: number, qualityScale: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const scale = Number.isFinite(qualityScale) && qualityScale > 0 ? qualityScale : 1;
  return dpr * scale;
}

export class ThreeScenePlayer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
  // 承载渲染的 canvas —— **就是调用方 append 到 DOM 显示的那一个**（three 渲染目标 + 页面显示
  // 同一元素，不存在第二个离屏 canvas）。渲染缓冲尺寸不变量（见 resize）：
  //   canvas.width/height === 视口逻辑尺寸 × pixelRatio（dpr）
  // 而 CSS（`.wp-scene-canvas{width:100%;height:100%}`）= 视口逻辑尺寸 → 缓冲与物理像素 1:1，
  // 既不模糊也不拉伸（2026-09-10 Task5：显式钉住该不变量，防「canvas 停在 HTML 默认 300×150
  // 被 CSS 拉伸放大」这一整类回退）。
  readonly canvas: HTMLCanvasElement;

  // 场景固有尺寸（WE 正交视口 view_w×view_h；scene.json 未就绪前用构造传入值，越过后
  // 用 setSceneSize 更新）与当前视口尺寸（canvas 逻辑像素）。
  private sceneWidth: number;
  private sceneHeight: number;
  private viewWidth: number;
  private viewHeight: number;
  // 渲染缓冲像素比 = 设备像素比 × 画质档位（resize 时重读设备像素比，跨屏拖动自适应）。
  private pixelRatio: number;
  // 画质档位（< 1 = 降分辨率省显存/提流畅；1 = 原生 dpr）。
  private qualityScale: number;
  // 暂停（省电）：停 RAF 排程，并把暂停时长从 elapsedSeconds 里扣除（恢复后 g_Time 不跳）。
  private paused = false;
  private pausedAt = 0;
  private pausedTotal = 0;
  // 已安装的帧回调（resume 时用它重新排程）。
  private loopFn: ((dt: number) => void) | null = null;

  private lastTime = 0;

  // 背景图层条目（按 addBackground 返回的 id 索引，供 update_background 引用）。
  private backgroundEntries = new Map<number, BackgroundEntry>();
  private nextBackgroundId = 0;

  // 粒子图层条目（Task 3）：按 addParticle 返回的 id 索引，更新粒子时用其 getter 刷新缓冲区。
  private particleLayers = new Map<number, ParticleLayer>();
  private nextParticleLayerId = 0;

  // 对象隔离条目（对象级效果链；空 Map = 本壁纸无带效果对象，帧序退化为原路径）。
  private isolated = new Map<number, IsolatedObject>();
  private objectEffectStage: ObjectEffectStage | null = null;
  // 应用级 Glow 注入点（null = 本壁纸不开 Glow，帧序退化为原路径）。
  private glowStage: GlowStage | null = null;
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

    // 注意：构造器**不调用 renderer.setSize(width,height,false)**——否则会把 canvas 尺寸重置回场景
    // 尺寸，覆盖调用方预设的窗口/视口尺寸（Task5 bug 根因：随后的 resize 读到被覆盖的 canvas.width
    // → viewport=场景尺寸 → cover 退化为「全场景无裁剪」+ CSS object-fit:fill 拉伸背景）。真正的
    // canvas 尺寸由调用方在构造后显式 `resize(vw,vh)` 设置（窗口尺寸），见 loadSceneToThree。
    this.renderer = renderer ?? new THREE.WebGLRenderer({ canvas, antialias: true });
    // 色彩管线对齐 wasm 参考（非 sRGB UNorm 管线，见 wasm/src/render/mod.rs / tex.rs 注释）：
    //   wasm 纹理用 UNorm（非 sRGB）、fragment 输出**原始编码值**、surface 直接显示——若 surface 是
    //   sRGB 会把线性值再编码 → 画面偏亮/过曝。three.js 缺省 `outputColorSpace=SRGBColorSpace`
    //   会对所有未标 `colorSpace` 的纹理做 linear→sRGB 再编码（同样偏亮/过曝，根因「整体偏白/过曝」）。
    //   这里强制 LinearSRGBColorSpace → `linearToOutputTexel` 恒等（不转换），纹理原始值直出，
    //   与 wasm 参考的非 sRGB 管线一致（壁纸恢复自然亮度，不再蒙白膜/过曝）。
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    // 画布/渲染分辨率（关键，修复「画面模糊」——HiDPI 屏幕像素比过低导致的整图放大模糊）：
    // three.js WebGLRenderer 缺省 `pixelRatio=1`（渲染缓冲 = 视口 CSS 像素），而 `.wp-scene-canvas`
    // 以 `width:100%`/`height:100%` 铺满窗口。在 HiDPI（devicePixelRatio>1）屏幕上，1× 缓冲被
    // 放大到 devicePixelRatio× 物理像素 → 整幅画面（背景 + 粒子）**模糊**，粒子（花瓣等）也被
    // 模糊成不可辨的小色块——这正是 headless SwiftShader（dpr=1）无法复现、真机可见的原因之一。
    // 按 `window.devicePixelRatio` 设置像素比，使渲染缓冲 = 物理像素（1:1 锐利），与 wasm 参考
    // 的视口语义一致。node/jsdom 测试用 mock renderer 注入（无 setPixelRatio），防御式跳过。
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
    this.applyCover();
    // ① 像素比 + 逻辑尺寸交给 renderer（幂等：写 _pixelRatio/_width/_height + viewport）。
    const r = this.renderer as {
      setPixelRatio?: (v: number) => void;
      setSize?: (w: number, h: number, updateStyle?: boolean) => void;
    };
    if (typeof r.setPixelRatio === 'function') r.setPixelRatio(this.pixelRatio);
    if (typeof r.setSize === 'function') r.setSize(w, h, false);
    // ② 显式兜底：three `setSize(w,h,false)` 本就会写 `canvas.width = floor(w*pixelRatio)`，此处
    //    再核对一次（仅在实际不符时才写，避免多余的绘制缓冲重置），使「缓冲 = 视口×dpr」成为
    //    **本类自己保证**的不变量——任何 renderer 实现（含注入的 mock/异常实现）都不会让 canvas
    //    停留在 HTML 默认 300×150 而被 CSS `width:100%` 拉伸放大（模糊根因之一）。
    const bufW = Math.floor(w * this.pixelRatio);
    const bufH = Math.floor(h * this.pixelRatio);
    if (this.canvas.width !== bufW) this.canvas.width = bufW;
    if (this.canvas.height !== bufH) this.canvas.height = bufH;
    // Glow 各级 RT 必须按画布缓冲尺寸建（与主相机 cover 口径一致）。mock renderer 无 domElement，
    // 退回本类自持的 canvas（生产路径 renderer.domElement 就是它）。
    const buf = (this.renderer as { domElement?: HTMLCanvasElement }).domElement ?? this.canvas;
    this.glowStage?.resize(buf.width, buf.height);
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

  // 场景固有尺寸（scene.json 的 general.orthogonalprojection）就绪后设置，同时重推 cover。
  // 构造传入的 width/height 只是缺省冗余值（「缺省用传入 width/height」）。
  setSceneSize(width: number, height: number): void {
    this.sceneWidth = width;
    this.sceneHeight = height;
    this.applyCover();
  }

  // 屏幕密度（设备像素 / 世界单位）：1 个世界单位在**画布缓冲**上占多少像素。
  // 与 applyCover 同一套 cover 语义（同一份 sceneWidth/sceneHeight/viewWidth/viewHeight/pixelRatio
  // ⇒ 同一个 coverRange）⇒ 与主相机实际铺满的像素网格同一把尺子。
  // 消费者：对象 RT 的尺寸口径（RT 像素 = 对象世界尺寸 × 本密度 = 对象在屏上的占位像素，
  // 见 object-range.objectRtSize）。挂载期由 three-renderer 用纯函数算出同一个数，resize 期
  // 直接取本方法（player 的 state 刚被 resize 更新，天然与 cover 同源）。
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

  // 每帧扩展钩子：驱动粒子图层刷新（Task 3）。Task 1 空实现；背景更新由 update_background
  // 显式调用（对齐 wasm update_image 语义）。后续 Task 4 可在此挂背景/效果链更新。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  update(_dt: number): void {
    this.updateParticles(_dt);
  }

  // 启动帧循环（renderer.setAnimationLoop 内部 RAF）。每帧：外部回调 fn(dt) → update(dt)
  // （内部钩子）→ render(scene, camera)。dt 用 performance.now 差分，clamp 0.1s 防 tab 切
  // 后台 / RAF 停顿后 dt 过大把粒子瞬移出视口（同 wasm-renderer 语义）。
  // Task 4 关键：fn(dt) 先于内部 update(dt)——fn 承载「模拟推进」（如 CpuParticleSim.update），
  // 使 update（→ updateParticles 读 getter）拿到**本帧已推进**的顶点（sim 已在帧内 advance），
  // 避免「先读旧顶点再推进」的一帧滞后。
  //
  // ⚠️ 帧体必须整体 try/catch（关键，修复「黑神话花瓣不可见」这类「背景清晰但粒子永不出现」）：
  // three r170 的 `WebGLAnimation.onAnimationFrame` 实现为
  //   `animationLoop(time, frame); requestId = context.requestAnimationFrame(onAnimationFrame);`
  // （three.module.js 13612-13618）——**重排下一帧的语句在回调之后**，且 three 不包裹 try/catch。
  // 因此只要本帧回调抛出一次（wasm 模拟器 panic、顶点 getter 返回异常数据、纹理/材质 GL 错误…），
  // `requestAnimationFrame` 就再也**不会被重新排程 → RAF 循环永久停摆**：canvas 停在最后成功绘制的
  // 那一帧（= `loadSceneToThree` 时的首帧，此时 `instanceCount===0`）→ 用户看到「背景清晰但没有粒子」
  // 且再无任何动画/诊断输出（sim 从未推进，粒子永远不出现）。此处把帧体包进 try/catch（**不重抛**），
  // 保证 three 每帧都能重新排程 RAF：单帧异常只丢该帧，循环自愈；异常只记一次 warn（防刷屏）。
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

  // 手动渲染一帧（不依赖 RAF，供测试/调用方直接触发）。
  // 帧序与 setAnimationLoop 的帧体一致（不带 dt）：隔离内容 → bindOutputs → 主场景 → advance。
  // 装配了 glowStage 时主场景渲染委托给它（stage 内部渲染主场景到 RT 再做全屏 glow 合成）。
  render(): void {
    if (this.isolated.size > 0) this.renderIsolatedContents();
    this.objectEffectStage?.bindOutputs();
    if (this.glowStage) this.glowStage.apply(this.renderer, this.scene, this.camera);
    else this.renderer.render(this.scene, this.camera);
    // 链推进是异步串行的（纹理槽可能仍在加载），不阻塞本帧；本帧贴的是上一帧输出。
    this.objectEffectStage?.advance(this.elapsedSeconds());
  }

  // 对象级效果链的编排器注入点（null = 本壁纸无效果链，帧序退化为原路径）。
  setObjectEffectStage(stage: ObjectEffectStage | null): void {
    this.objectEffectStage = stage;
  }

  /** 装配应用级 Glow（null = 关闭）。关闭时帧序与本方法加入前逐字相同。 */
  setGlowStage(stage: GlowStage | null): void {
    this.glowStage = stage;
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

  // 重设隔离对象的 RT 尺寸（视口/dpr 变化时由编排器调用）：**只改分辨率**。
  // 局部相机覆盖的世界范围（camW/camH）与合成几何的 UV 窗口都只依赖**世界尺寸**，与 RT 像素
  // 无关，因此这里不得改动它们 —— 曾在此按 RT 像素重设相机视锥并重建几何，使 dpr>1 的对象
  // 内容被缩小到 1/dpr 并露出边缘（真机 HiDPI 整张壁纸错乱的同一根因）。
  // `id` = 隔离条目的键 = scene.json 的对象 id。
  resizeObjectRT(id: number, width: number, height: number): void {
    const entry = this.isolated.get(id);
    if (!entry) return;
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (entry.rt.width === w && entry.rt.height === h) return;
    entry.rt.setSize(w, h);
    // 扁平视图（rtWidth/rtHeight）必须与 rt 实际尺寸同步：编排器只读这两个字段，
    // 留旧值会让它按过期尺寸算效果链的纹理槽分辨率。
    entry.rtWidth = w;
    entry.rtHeight = h;
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

  // Task 2：背景图层（Sprite/Mesh）。用 we_to_three 中心化定位（three = we - scene/2，
  // 左下原点 y 向上 → 中心原点 y 向上，y 不翻，与背景一致）；size×scale 定尺寸；
  // alpha → material.opacity、brightness 调色（复用 scene-renderer.materialModulation：
  // color 缺省全白 → rgb = clamp01(brightness)，a = clamp01(alpha)）。
  // sceneW/sceneH 为场景固有尺寸（we_to_three 基准，通常 == setSceneSize 注入值）。
  // 返回分配的背景 id，供 update_background 引用；与后续粒子共用同一相机（Task 1 cover）。
  addBackground(opts: {
    origin: [number, number, number];
    size?: [number, number];
    scale: [number, number, number];
    // 对象欧拉角（**弧度**，scene.json 的 angles；缺省 [0,0,0]）。three 的 Object3D 变换顺序
    // 正是 T·R·S，所以 mesh.rotation 直接承载它（全库 2 个 image 对象带非零 angles）。
    angles?: [number, number, number];
    // WE 图像颜色混合模式（缺省 0）。非 0 且**已实现**（6/7/31）时改用预乘 ShaderMaterial
    // + CustomBlending 复刻 WE 的 ApplyBlending；0 或未实现的模式 → 维持普通 alpha 混合。
    colorBlendMode?: number;
    texture?: THREE.Texture;
    alpha?: number;
    brightness?: number;
    sceneW: number;
    sceneH: number;
    // 对象隔离（对象级效果链）：五字段把三种量分开——
    //   objectId       = scene.json 的**对象 id**，即本隔离条目的键（见 attachIsolated 注释）；
    //   rtWidth/rtHeight = 对象 RT 的像素尺寸（= 世界尺寸 × 屏幕密度的屏占位，等比收口到 4096）；
    //   worldW/worldH = 合成 quad 的世界尺寸（= |size × scale|，**未钳制**幅值）。
    // 缺省不隔离（内容直接进主 scene，帧序与今天逐字相同）。
    isolate?: { objectId: number; rtWidth: number; rtHeight: number; worldW: number; worldH: number };
  }): number {
    const sceneW = opts.sceneW;
    const sceneH = opts.sceneH;
    // 背景尺寸 = size × scale。geometry 用未缩放 size、mesh.scale 承载 scale（同
    // scene-renderer.setImageObject 语义），世界尺寸 = size*scale；size 缺省回退纹理宽高。
    const w = opts.size?.[0] ?? (opts.texture?.image?.width as number | undefined) ?? 1;
    const h = opts.size?.[1] ?? (opts.texture?.image?.height as number | undefined) ?? 1;
    const geometry = new THREE.PlaneGeometry(w, h);
    const mod = materialModulation(undefined, opts.alpha, opts.brightness);
    // 材质：WE `colorBlendMode` 已实现的模式（6/7/31）→ 预乘 ShaderMaterial + CustomBlending
    // （复刻 ApplyBlending，见文件上方 COLOR_BLEND_* 注释）；0 / 未实现模式 → 既有
    // MeshBasicMaterial（普通 alpha 混合）。
    // ⚠️ 隔离对象（opts.isolate）走 forIsolation=true：内容材质**不套** cb，混合语义全部交给
    // 合成 quad（见 createLayerMaterial / createCompositeQuadMaterial 注释）。
    const material = this.createLayerMaterial(opts.texture ?? null, opts.colorBlendMode ?? 0, mod, !!opts.isolate);
    const mesh = new THREE.Mesh(geometry, material);
    // renderOrder 0（缺省且显式）：背景在粒子（renderOrder 1）之前绘制（背景在下）。
    mesh.renderOrder = 0;
    const s = opts.scale;
    mesh.scale.set(s[0], s[1], s[2] ?? 1);
    // 对象角度（弧度）：PlaneGeometry 以几何中心为 pivot，mesh.rotation 即 T·R·S 的 R。
    const a = opts.angles ?? [0, 0, 0];
    mesh.rotation.set(a[0], a[1], a[2]);
    // we_to_three：origin - scene/2（y 不翻）。
    mesh.position.set(opts.origin[0] - sceneW / 2, opts.origin[1] - sceneH / 2, opts.origin[2]);

    // 图层 id（本方法返回值 = backgroundEntries 的键）由本类计数器分配；隔离条目的键是
    // **scene.json 的对象 id**（`opts.isolate.objectId`），两套编号互不相干（见 attachIsolated）。
    const id = this.nextBackgroundId++;
    // 对象世界尺寸（未钳制幅值）：隔离路径下用于合成 quad 的几何尺寸（缩放已并入几何，
    // quad 自身 scale 恒为 1）；非隔离路径下仅用于记录，行为不变。
    // 优先用调用方传入的 worldW/worldH（isolate 的形状把「RT 像素」与「世界尺寸」分开），
    // 缺省回退内部计算 = |size × scale|。
    const worldW = opts.isolate?.worldW ?? Math.abs(w * s[0]);
    const worldH = opts.isolate?.worldH ?? Math.abs(h * s[1]);

    if (opts.isolate) {
      // 隔离：内容只保留 scale（含镜像），位移/旋转交给合成 quad。
      mesh.position.set(0, 0, 0);
      mesh.rotation.set(0, 0, 0);
      // 背景的 RT 内容不含旋转 → 旋转由合成 quad 承载（见 attachIsolated 的旋转分工注释）；
      // colorBlendMode 落在「贴回画面」这一步。
      // 键 = scene.json 的对象 id（调用方传入），**不是**下面的 nextBackgroundId 图层计数器 id。
      this.attachIsolated(opts.isolate.objectId, 'background', mesh, worldW, worldH, {
        width: opts.isolate.rtWidth,
        height: opts.isolate.rtHeight,
      }, {
        x: opts.origin[0] - sceneW / 2,
        y: opts.origin[1] - sceneH / 2,
        z: opts.origin[2],
      }, [a[0], a[1], a[2]], opts.colorBlendMode ?? 0);
    } else {
      this.scene.add(mesh);
    }

    this.backgroundEntries.set(id, {
      mesh,
      origin: [opts.origin[0], opts.origin[1], opts.origin[2]],
      size: [w, h],
      scale: [s[0], s[1], s[2] ?? 1],
      angles: [a[0], a[1], a[2]],
      alpha: mod.a,
      brightness: opts.brightness ?? 1,
      sceneW,
      sceneH,
    });
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
    // 隔离路径（forIsolation=true）：内容渲染到**新清空的 RT**，这里只做「把自己的颜色与 alpha
    // 写进 RT」；WE 的 colorBlendMode 混合语义由**合成 quad** 承担（见 createCompositeQuadMaterial）。
    // 因此隔离时**不套用** cb 的 CustomBlending，否则：
    //   ① alpha 因子 Zero/One（「保持背景的 alpha」）在 RT 里没有背景可保持 ⇒ RT alpha 恒 0
    //      ⇒ 合成 quad 的预乘片元被乘成 0 ⇒ 对象整体不可见；
    //   ② 预乘写进 RT 后 quad 再预乘一次 ⇒ rgb × a²。
    // 注：内容用普通 alpha 混合写进清空后的 RT（dst=(0,0,0,0)）时，RT.rgb 自然带上「× 自身 alpha」
    // 的预乘（= 合成 quad 需要的 `op·B`），RT.a = a²（quad 的 alpha 走 Zero/One，不读它）。
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
      // 非预乘、透明度只走 alpha；否则 rgb 被预乘一次、合成再乘一次 ⇒ 半透明图层只剩一半亮度（§5.27）。
      blending: forIsolation ? THREE.NoBlending : THREE.NormalBlending,
      // 隔离内容渲染进**y 镜像的局部相机**（对象 RT 取 WE 的 v 约定，见 attachIsolated）⇒
      // 屏幕空间绕序被翻转，正面朝外的 quad 会被背面剔除掉（对象整体消失）。故隔离路径改双面；
      // 非隔离（主场景直渲）继续保持 FrontSide，行为与引入前逐字一致。
      side: forIsolation ? THREE.DoubleSide : THREE.FrontSide,
    });
    basic.color.setRGB(mod.r, mod.g, mod.b);
    basic.opacity = mod.a;
    return basic;
  }

  // 合成 quad 的材质：只负责「把对象 RT 的像素采样回主场景」。
  // ⚠️ 三点关键（都是踩过的坑）：
  //   ① 必须独立构造，**不能 clone 内容材质**——粒子对象的内容材质是 InstancedBufferGeometry
  //      专用的 billboard shader（依赖逐实例属性），普通 PlaneGeometry 没有这些属性会让
  //      alpha 恒为 0（粒子隔离后完全不可见）；
  //   ② **不再二次施加** alpha/brightness/color 调制——内容 mesh 的材质已把调制烘进 RT
  //      （scene-renderer.ts 的既有结论），clone 后再乘一次会让 alpha=0.5 变成 0.25。
  //   ③ **统一用 MeshBasicMaterial**：本 quad 采样的是对象 RT（内容材质在隔离路径不套 cb），
  //      只有 cb（6/7/31）分支额外开 `premultipliedAlpha`（见下）。
  // WE 的 `ApplyBlending` 语义用 three 的 CustomBlending 因子**在合成这一步**复刻，
  // alpha 仍取背景的（`gl_FragColor.a = screen.a` ⇒ Zero/One）。
  // 背景对象带非零 angles 时 quad 承载旋转，超过 90° 的旋转会翻转三角形绕序 —— 与内容材质
  // （原 cb 分支用 DoubleSide）保持一致用 DoubleSide，避免旋转到背面时整块被背面剔除掉。
  private createCompositeQuadMaterial(texture: THREE.Texture, colorBlendMode: number): THREE.Material {
    const mat = new THREE.MeshBasicMaterial({
      map: texture, transparent: true, depthWrite: false, side: THREE.DoubleSide,
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
      // （opacity × mask）必须由片元预乘进 rgb，否则云层全强度盖住人物、mask 也失效（§5.26）。
      mat.premultipliedAlpha = true;
    }
    return mat;
  }

  // 建立对象隔离条目：RT + 局部正交相机 + localScene + 主场景合成 quad。
  // localCamera 范围 = RT 分辨率（对象中心为原点，与场景像素 1:1）；合成 quad 用
  // createCompositeGeometry（世界尺寸含缩放、UV 按钳制窗口映射），position 承载对象在世界中
  // 的位置。
  //
  // ⚠️ 第一个参数是 **scene.json 的对象 id**（键），不是本类的图层计数器 id：背景层与粒子层
  // 各有一个从 0 起的独立计数器（nextBackgroundId / nextParticleLayerId），若拿它们当隔离条目的
  // 键，同一壁纸同时有隔离 image 与隔离 particle 时两边都从 0 开始 → 后建的粒子条目**覆盖**先建的
  // 背景条目（背景的 quad 从此采样一张永不被渲染的 RT，且 stageKey 把两个对象映到同一个键）→
  // 静默画错。用对象 id 作键则与「isolate 表 / ObjectEffectStage / wasm PendingChainStore」
  // 共用同一把键（全库实测对象 id = 12/13/17/20/…，两套计数器无法表达）。
  //
  // ⚠️ 旋转的分工**不可「统一」**：quadAngles 由调用方按「RT 内容是否已含旋转」决定——
  //   - 背景：内容 mesh 的 rotation 已归零（RT 内容**不含**旋转）→ quad 承载对象 angles；
  //   - 粒子：内容 shader 里已施加 objAngles（RT 内容**已含**旋转）→ quadAngles 传 [0,0,0]，
  //     否则同一份旋转被施加两次。
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
  ): void {
    const rtW = Math.max(1, Math.round(size.width));
    const rtH = Math.max(1, Math.round(size.height));
    // MSAA 显式开（主 canvas 是 `antialias: true`，而 `WebGLRenderTarget` 的 `samples` 缺省 0）：
    // 隔离内容里的**轮廓边**（粒子 billboard 的硬边）需要它。
    // ⚠️ 但它**不是**「大幅背景壁纸整体变糊」的根因（2026-09-14 归因实测，此前这里的注释把它
    // 当成了根因）：背景隔离内容是**一整块铺满 RT 的 quad**，RT 内没有任何轮廓边，samples=0 与
    // samples=4 的成品**逐像素完全相同（MAD = 0.0000）**——MSAA 对该对象是结构性无效，不是被
    // headless/SwiftShader 忽略（探针实测 MAX_SAMPLES=8、样例 FBO 正常、samples=4 时斜置边有
    // 79 个混合像素）。真正的根因是**对象 RT 尺寸与屏占位不符导致的合成重采样**（比 0.992 的
    // 双线性 + 亚纹素相位漂移 ⇒ 锐度 −52%），已由 object-range.objectRtSize 的「屏占位」口径
    // 修掉，详见 .superpowers/sdd/2026-09-14-three-object-effects-pipeline/clarity-report.md。
    const rt = new THREE.WebGLRenderTarget(rtW, rtH, { samples: 4 });
    // ⚠️ 局部正交相机的 left/right/top/bottom 是**世界坐标范围**（内容以世界单位绘制），
    // 所以相机必须覆盖**完整对象世界尺寸**；RT 的像素尺寸只决定分辨率（= 世界尺寸 × 屏幕密度，
    // 由调用方按屏占位算出、上限 4096）。这里两个坑都踩过：
    //   ① 拿 RT 像素当相机范围 → dpr>1 时相机多覆盖 dpr 倍 ⇒ 内容只占 RT 的 1/dpr、四周空白，
    //      合成 quad 再按全窗口拉回世界尺寸 ⇒ 对象缩小 + 边缘 clamp 拉伸（真机 HiDPI 整张壁纸错乱）；
    //   ② 把相机范围钳到 OBJECT_RT_MAX → RT 只覆盖对象的中央一块，UV 窗口外侧被 CLAMP 采样成
    //      **边缘拉伸带**（实测 GTR 3743126786 对象世界宽 7430 > 4096 ⇒ 右侧 22% 画面宽是条纹）。
    // 超限对象现在的代价只是**分辨率低**（欠采样），不再有几何错位 —— 硬上限属于 RT **像素**尺寸，
    // 由 object-range.objectRtSize 负责钳制。
    const camW = Math.max(1, Math.abs(worldW));
    const camH = Math.max(1, Math.abs(worldH));
    // ⚠️ **y 镜像局部相机**（top = -camH/2 < bottom = +camH/2，2026-09-14 v 约定修复）：
    // 对象 RT 是**效果链的输入**，效果 shader（WE 明文 GLSL）把 `v_TexCoord.y` 当**图像空间**
    // 纵坐标用：`waterflow.frag` 的 `flowUVOffset = flowMask * …`（带符号位移）、`clouds.frag`
    // 的旋转/滚动 UV、`foliagesway` 的摆动方向… 而 WE/lwe 的纹理约定是 `.tex` 首行落在 v=0
    // （图像顶部，`CTexture.cpp:84` 直接上传、无翻转）⇒ WE 里 v 沿图像**向下**增长。
    // three 显示路径此前把 `.tex` 翻成 v=0=图像底部（见 tex-loader.TexRowOrder），若对象 RT 也
    // 沿用该约定，效果链里 v 就沿图像**向上**增长 ⇒ 位移/滚动的纵分量整体上下颠倒：
    // Crimson `effects/waterflow` 的 mask 落在正确水面区域（位置由「两侧同约定」保证），
    // 但水流纵分量反向 = 用户所见的「方向对但位置/斜度不对」。
    // 这里把局部场景整体 y 镜像 ⇒ RT 的 v=0 = 图像顶部（与 WE 一致），效果链两侧（RT 与
    // 纹理槽，见 object-effects.WE_V_ROW_ORDER）因此同一套 WE 约定；再由合成 quad 的
    // `flipGeometryUvY` 把 RT 翻回显示约定贴回主场景 ⇒ **画面不颠倒**（镜像与反镜像精确抵消，
    // 对象的负 scale/旋转语义不变）。
    // 副作用（已处理）：投影 y 取负会翻转**屏幕空间绕序** ⇒ 内容材质必须能双面渲染
    // （背景内容材质在 createLayerMaterial 的 forIsolation 分支置 DoubleSide；粒子 billboard
    // 材质本就是 DoubleSide）。正交视锥的平面集合仍自洽（three 的 Frustum 从矩阵取平面，
    // 镜像后仍能正确判定内外），故剔除行为不变。
    const localCamera = new THREE.OrthographicCamera(-camW / 2, camW / 2, -camH / 2, camH / 2, -1000, 1000);
    localCamera.position.z = CAMERA_DISTANCE;
    const localScene = new THREE.Scene();
    // 内容 mesh 保留原有（已烘调制的）材质：调制必须继续烘进 RT，只是合成 quad 不再重复施加。
    localScene.add(content);
    // 合成 quad 的材质独立构造、采样对象 RT 纹理（效果链就绪后由 setObjectOutput 换成效果输出）。
    // 几何世界尺寸 = 未钳制的 worldW/worldH；UV 窗口按**相机覆盖的世界范围**（camW/camH）映射，
    // 钳制轴只采样 RT 可见段；再 `flipGeometryUvY` 把 RT 的 WE 约定（v=0=图像顶部）翻回显示
    // 约定（见上面 localCamera 的 y 镜像注释——两处镜像精确抵消，画面正立）。
    const compositeGeometry = createCompositeGeometry(worldW, worldH, camW, camH);
    flipGeometryUvY(compositeGeometry);
    const quad = new THREE.Mesh(
      compositeGeometry,
      this.createCompositeQuadMaterial(rt.texture, colorBlendMode),
    );
    quad.position.set(position.x, position.y, position.z);
    quad.rotation.set(quadAngles[0], quadAngles[1], quadAngles[2]);
    // renderOrder 与对象原语义一致（背景 0 / 粒子 1），保证合成顺序不变。
    quad.renderOrder = kind === 'particle' ? 1 : 0;
    this.scene.add(quad);
    // 键 = scene.json 的对象 id（调用方传入），不是本类自己的图层计数器 id——见本方法头注释。
    this.isolated.set(objectId, {
      id: objectId, kind, rt, rtWidth: rtW, rtHeight: rtH, rtTexture: rt.texture,
      localScene, localCamera, quad, worldW, worldH,
    });
  }

  // Task 2：更新背景图层状态，对齐既有 update_image 语义——undefined = 保持现状；
  // 传入值若无变化（与当前已应用状态相等）则跳过该字段；未知 id → no-op。
  // origin 为 WE 场景坐标，先按 we_to_three 中心化（origin - scene/2）再写 mesh.position。
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
        entry.mesh.position.set(ox - entry.sceneW / 2, oy - entry.sceneH / 2, oz);
      }
    }
    if (scale) {
      const [sx, sy, sz] = scale;
      if (sx !== entry.scale[0] || sy !== entry.scale[1] || sz !== entry.scale[2]) {
        entry.scale = [sx, sy, sz];
        entry.mesh.scale.set(sx, sy, sz);
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
        // brightness 调色：rgb = clamp01(brightness)，a 用当前 opacity（复用调制函数）。
        const mod = materialModulation(undefined, entry.alpha, brightness);
        const mat = entry.mesh.material as THREE.MeshBasicMaterial | THREE.ShaderMaterial;
        if (mat instanceof THREE.ShaderMaterial) (mat.uniforms.tint.value as THREE.Vector3).set(mod.r, mod.g, mod.b);
        else mat.color.setRGB(mod.r, mod.g, mod.b);
      }
    }
  }

  // 文本图层 resize：按新画布尺寸重建 quad 几何（PlaneGeometry 尺寸不可变），scale 不变
  // ⇒ 世界尺寸 = 新尺寸 × scale。未知 id / 尺寸未变 → no-op（不重建几何）。
  // ⚠️ 画布纹理必须 dispose：three r170 在 WebGL2 用**不可变** texStorage2D（只在首次上传
  // 分配存储），画布尺寸变了以后 texSubImage2D 越界、上传被 GL 静默丢弃 ⇒ 屏幕上仍是旧画布
  // 被拉伸。dispose 后下一次渲染按新尺寸重新分配存储。
  resizeBackground(id: number, size: [number, number]): void {
    const entry = this.backgroundEntries.get(id);
    if (!entry) return;
    const [w, h] = size;
    if (w === entry.size[0] && h === entry.size[1]) return;
    entry.size = [w, h];
    const old = entry.mesh.geometry;
    entry.mesh.geometry = new THREE.PlaneGeometry(w, h);
    old.dispose();
    const map = (entry.mesh.material as { map?: THREE.Texture | null }).map;
    if (map && (map as THREE.CanvasTexture).isCanvasTexture) map.dispose();
  }

  // Task 3：粒子图层。`simVerticesGetter` 每帧返回模拟器当前顶点（摊平 Float32Array，
  // 每粒子 `[pos3, size, uv2, color3, alpha]` 10 浮点——来自 wasm `SceneParticleSim::build_instance_vertices`）。
  // 渲染用 three.js `ShaderMaterial` billboard quad（每粒子一个实例，shader 由基础角点+位置/尺寸展开），
  // 模拟逻辑仍由 `SceneParticleSim` 承担（思路 1 核心：不重写模拟，只换渲染引擎）。
  // 返回分配的图层 id，供更新/释放引用。
  addParticle(
    simVerticesGetter: () => Float32Array,
    opts: {
      tex?: THREE.Texture;
      frameCount: number;
      // 精灵表网格（列×行）。非精灵表缺省 cols=frameCount、rows=1（横向等分，与旧行为一致）；
      // 精灵表（WE flags 位 2，如 DK 的 fire1/fog1 = 8×8=64 帧）由 `textureFrameGrid` 给出。
      frameCols?: number;
      frameRows?: number;
      blend: 'additive' | 'alpha';
      softness?: number;
      // 对象变换（WE model matrix 语义；缺省 = 不做缩放，保持旧行为／测试语义）：
      //   objectCenter  对象中心（世界坐标，we_to_three 后）
      //   objectScale   scene.json 的对象 scale（逐轴，可为负）
      //   emitterOrigin spec 的 emitter 局部原点（simEmitterOffset 用它算 bmOffset）
      objectCenter?: [number, number, number];
      objectScale?: [number, number, number];
      // 对象欧拉角（**弧度**，scene.json 的 angles；缺省 [0,0,0] = 不旋转）。model matrix 的 R。
      objectAngles?: [number, number, number];
      emitterOrigin?: [number, number, number];
      // 实例缓冲容量上界（= sim 的 maxcount / spec 的 maxcount；见 ParticleLayer.capacity 注释）。
      // 缺省 DEFAULT_PARTICLE_CAPACITY。
      maxInstances?: number;
      // 对象隔离（对象级效果链；粒子对象同样可挂效果链）。五字段语义同 addBackground：
      //   objectId       = scene.json 的**对象 id**，即隔离条目的键；
      //   rtWidth/rtHeight = 对象 RT 像素尺寸（= 世界尺寸 × 屏幕密度的屏占位，等比收口到 4096）；
      //   worldW/worldH = 合成 quad 世界尺寸（= particleWorldSize 的**未钳制**值）。
      // 粒子 spec 无 size 字段、player 也不知道 distanceMax，故世界尺寸必须由调用方算好传入。
      // 缺省不隔离（内容直接进主 scene，帧序与今天逐字相同）。
      isolate?: { objectId: number; rtWidth: number; rtHeight: number; worldW: number; worldH: number };
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
    // softness 默认按有无纹理对齐 wasm `particle_billboard` 的 mask_mode（Task 5 + 2026-09-09 深挖）：
    //   有纹理（真实 alpha 遮罩）→ 0.15（若 mask_mode=0 才用到的圆盘默认值；mask_mode=1 时形状由
    //     texel.a 提供，softness 不参与）——保留该默认值作兜底/精细控制；
    //   无纹理（1×1 白图兜底）→ 1.0（整盘软圆点）。
    // 此前恒 0 → 无纹理粒子是**硬边白方块**（叠在背景上呈白斑/偏白，单个粒子看作方块）。
    // 调用方显式传 softness 时以其为准（测试/精细控制）。
    const hasTex = !!opts.tex;
    const softness = opts.softness ?? (hasTex ? 0.15 : 1.0);

    // InstancedBufferGeometry：基础 4 角点四边形（position）+ 索引；每粒子一个实例（instanced 属性）。
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(PARTICLE_QUAD_CORNERS, 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(PARTICLE_QUAD_INDEX), 1));
    geometry.instanceCount = 0;

    // 初始 getter 数据 → 首帧写入（容量固定，见下）。
    const initial = simVerticesGetter();
    const count = Math.floor(initial.length / 10);

    // ⚠️ 实例缓冲容量必须**一次给足、之后不再替换属性**——这是「黑神话花瓣不可见 / 只有 1 个粒子」
    // 的根因（2026-09-10 定位，headless Edge + 真 GPU 实测）：
    //
    // three r170 在 `setupVertexAttributes` 里对 InstancedBufferGeometry **只锁存一次**容量：
    //   `if (object.isInstancedMesh !== true && geometry._maxInstanceCount === undefined) {
    //        geometry._maxInstanceCount = geometryAttribute.meshPerAttribute * geometryAttribute.count; }`
    //   （three.module.js L15653-15657；`undefined` 判断 ⇒ 之后无论属性怎么变都不会再更新，
    //     只有 `geometry.dispose()` 才会 `delete geometry._maxInstanceCount`）
    // 绘制时（同上 L29764-29767）：
    //   `const instanceCount = Math.min(geometry.instanceCount, geometry._maxInstanceCount);`
    // 而 `renderInstances` 首行就是 `if (primcount === 0) return;`（L15861-15863）——
    // **primcount===0 时直接不画**。
    //
    // 建层时模拟器还没推进（`CpuParticleSim` 首帧才 update），getter 返回 0 粒子；若照粒子数
    // 分配属性（0 长度），则首次渲染锁存 `_maxInstanceCount = 0` → 该层**永远不画**
    // （真机实测：`drawElementsInstanced` 计数恒 0，而背景 `drawElements` 每帧照画 60fps）；
    // 若首帧恰好已有 1 个粒子，容量就锁死 1 → **永远只画 1 个粒子**（用户真机 console 的
    // `粒子已产出 count=1` 正是同一帧的采样值，与「只发射了 1 个粒子」无关——模拟本身
    // 每帧累积发射，实测 150 帧即到 maxcount=50）。
    //
    // 因此：按 sim 的 maxcount（`opts.maxInstances`，缺省 DEFAULT_PARTICLE_CAPACITY）**预分配**
    // 全部 instanced 属性，运行期只改 `geometry.instanceCount`（0..capacity），容量不再变化。
    const capacity = particleCapacity(opts.maxInstances ?? 0, count);

    // per-particle（每个实例）属性：pos(3)/size(1)/uv(2)/color(3)/alpha(1)；itemSize 与字段对应。
    const positions = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    const sizes = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    const uvs = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    const colors = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    const alphas = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    geometry.setAttribute('particlePosition', positions);
    geometry.setAttribute('particleSize', sizes);
    geometry.setAttribute('particleUv', uvs);
    geometry.setAttribute('particleColor', colors);
    geometry.setAttribute('particleAlpha', alphas);

    // ShaderMaterial：billboard quad（pos + corner*half_size，mvp 用相机投影/视图）、
    // fragment 多帧 uv 切片（frame_count）、additive/alpha blend、softness、color*texel.rgb、alpha=texel.a*particle.alpha。
    // maskMode：有纹理→1（形状由 texel.a 提供）；无纹理白图兜底→0（软圆盘）。对齐 wasm particle_billboard 的 mask_mode。
    const material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: opts.tex ?? createWhiteTexture() },
        frameCount: { value: frameCount },
        frameCols: { value: frameCols },
        frameRows: { value: frameRows },
        softness: { value: softness },
        maskMode: { value: hasTex ? 1.0 : 0.0 },
        // 对象变换（缺省恒等 → 顶点 shader 退化为旧的 worldPos = particlePosition + corner*size/2）。
        objCenter: { value: new THREE.Vector3(...(opts.objectCenter ?? [0, 0, 0])) },
        objScale: { value: new THREE.Vector3(...(opts.objectScale ?? [1, 1, 1])) },
        objAngles: { value: new THREE.Vector3(...(opts.objectAngles ?? [0, 0, 0])) },
        emitterOrigin: { value: new THREE.Vector3(...(opts.emitterOrigin ?? [0, 0, 0])) },
        bmOffset: { value: new THREE.Vector3(...simEmitterOffset(opts.emitterOrigin ?? [0, 0, 0])) },
      },
      vertexShader: PARTICLE_VERTEX_SHADER,
      fragmentShader: PARTICLE_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: opts.blend === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    const mesh = new THREE.Mesh(geometry, material);
    // 粒子散布在场景（非基础四边形包围球），禁用视锥剔除防止对象中心离屏时整层消失。
    mesh.frustumCulled = false;
    // 双保险：`InstancedBufferGeometry.computeBoundingSphere()` 只看**基础四边形**（[-1,1]²，半径≈1.4）
    // 而**不看** per-instance 位置，任何仍按 boundingSphere 剔除的代码路径（未来重构、旧 three 版本、
    // 自定义 renderer/WebXR 路径）都会把整层判为「离屏」（粒子在世界坐标 ±1200 处，包围球在原点）
    // → 整层不绘制 = 花瓣全丢。显式给一个无限半径的包围球，使该不变量不依赖 `frustumCulled` 一处。
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), Number.POSITIVE_INFINITY);
    // renderOrder 固定为 1：保证粒子 billboard 在透明渲染队列中**晚于**背景图层（renderOrder 0）
    // 绘制，使粒子叠在背景之上（背景 transparent 同排透明队列，靠插入顺序易受排序扰动，见
    // ThreeScenePlayer 背景/粒子同 z 的 reversePainterSortStable 稳定序）。这是「粒子不可见 /
    // 与背景竞争」的确定性保险（第 4 条：确认粒子被画出来且不被背景盖住）。
    mesh.renderOrder = 1;
    if (opts.isolate) {
      // 粒子隔离：世界位移改由「内容 mesh 的负中心平移」承载，**不要**改 objCenter/objAngles
      // uniform——shader 用 `local = particlePosition - objCenter - bmOffset` 反解局部坐标，
      // 而 particlePosition 本身就含对象中心（sim 以对象中心为发射基准），置零会让反解错误、
      // 内容整体出画（局部相机只有对象 RT 那么大）。
      //   worldPos(shader) = objCenter + R(angles)·(scale·(emitterOrigin+local))
      //   mesh.position    = -objCenter
      //   ⇒ 局部场景中的最终位置 = R(angles)·(scale·(emitterOrigin+local))，中心已归零 ✓
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
      capacity,
      loggedFirstFrame: false,
      loggedCount: 0,
    };
    this.particleLayers.set(id, layer);
    // 立即写入首帧数据，保持 geometry 与 getter 一致（后续由 updateParticles 逐帧刷新）。
    this.writeParticleData(layer, initial, count);
    if (opts.isolate) {
      const center = opts.objectCenter ?? [0, 0, 0];
      // 世界尺寸由调用方（three-renderer 侧）按 particleWorldSize 算好传入；RT 像素尺寸
      // 单列。二者不可混用：quad 世界占位若误用 RT 像素会被 dpr/预算收口二次缩放。
      // quadAngles 传 [0,0,0]：RT 内容已含 R(angles)（见上面的负中心平移注释），quad 再转一次
      // 就是双重旋转；背景路径相反（内容不旋转，旋转由 quad 承载）。
      // colorBlendMode 传 0：粒子走普通 alpha 混合。
      // 键 = scene.json 的对象 id（调用方传入），不是上面的 nextParticleLayerId 图层计数器 id。
      this.attachIsolated(opts.isolate.objectId, 'particle', mesh, opts.isolate.worldW, opts.isolate.worldH,
        { width: opts.isolate.rtWidth, height: opts.isolate.rtHeight },
        { x: center[0], y: center[1], z: center[2] }, [0, 0, 0], 0);
    }
    return id;
  }

  // 每帧刷新所有粒子图层：调用各自的 `simVerticesGetter()` 取当前顶点并写回 BufferAttribute。
  // `dt` 用于诊断日志（证明帧循环真的在跑、dt 是真实帧间隔且 >0）。
  updateParticles(dt: number): void {
    for (const layer of this.particleLayers.values()) {
      const data = layer.getter();
      const count = Math.floor(data.length / 10);
      // 诊断日志（真机 console 用；确定性判据），每层最多两行：
      //   ① 首次出现非零粒子时打一条，含 dt 与容量 —— dt≈0 / 缺本行 ⇒ 帧循环没在推进模拟；
      //   ② 粒子数首次达到容量（maxcount 满池）时再打一条 —— 证明「持续累积发射到 maxcount」。
      // 旧实现只在首帧非零时打一条 `count=1`（rate=20、60fps 下首个非零帧必然只有 1 个粒子），
      // 极易被误读成「模拟只发射了 1 个粒子」；②号日志正是为消除该误读而加（真机实测 ~2.5s 到 50）。
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

  // 把 per-particle 摊平顶点（每粒子 10 浮点）拆到 5 个 instanced 属性并标记需重传。
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

    // 实际容量 = 最小的「每实例元素数」换算回粒子数（5 个属性同步扩容，取最小以保守）。
    const minCapacity = Math.min(
      Math.floor((layer.positions.array as Float32Array).length / 3),
      (layer.sizes.array as Float32Array).length,
      Math.floor((layer.uvs.array as Float32Array).length / 2),
      Math.floor((layer.colors.array as Float32Array).length / 3),
      (layer.alphas.array as Float32Array).length,
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
    for (let i = 0; i < count; i++) {
      const b = i * 10;
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
    }
    layer.positions.needsUpdate = true;
    layer.sizes.needsUpdate = true;
    layer.uvs.needsUpdate = true;
    layer.colors.needsUpdate = true;
    layer.alphas.needsUpdate = true;
    layer.geometry.instanceCount = count;
  }

  // 停止循环并释放 renderer 资源。
  dispose(): void {
    this.renderer.setAnimationLoop(null);
    // 释放背景图层几何/材质（texture 所有权通常在外，随 scene 清理，不在此 dispose）。
    for (const entry of this.backgroundEntries.values()) {
      entry.mesh.geometry.dispose();
      (entry.mesh.material as THREE.Material).dispose();
    }
    this.backgroundEntries.clear();
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
    this.objectEffectStage = null;
    // 应用级 Glow 的 RT/shader 归 stage 所有，须在 renderer.dispose() 前释放。
    this.glowStage?.dispose();
    this.glowStage = null;
    this.renderer.dispose();
  }
}

// ===== Task 4：把 WE 场景加载进 three.js 播放器（背景图层 + 粒子系统）=====
//
// `loadSceneToThree(sceneJson, assets, canvas, viewport?)` 复用既有解析（scene-json → SceneDescription）、
// 既有坐标（addBackground 内部 we_to_three，y 不翻）、既有材质调制（materialModulation），
// 把 WE 场景内容转换成 three.js 可渲染对象：
//   ① 背景对象（image）→ player.addBackground({origin,size,scale,texture,alpha,brightness,sceneW,sceneH})
//   ② 粒子对象（particle）→ 每对象 new 一个 CPU 模拟器（SceneParticleSim 的 wasm 导出
//      CpuParticleSim，经 assets.createParticleSim 工厂注入）→ set_frame_count(纹理帧数) →
//      player.addParticle(() => sim.vertices(), {tex, frameCount: sim.frame_count(), blend, softness})。
// 播放循环（Task 4）：player.setAnimationLoop(fn)——fn 每帧先 sim.update(dt)（帧差分 clamp 0.1，
// 见 setAnimationLoop），再由 player 内部 update(dt)（→ updateParticles(dt)）读 getter 刷新
// BufferAttribute（sim 已在帧内推进，无一帧滞后）。
// 背景/粒子共用同一 cover 正交相机（Task 1/2 裁决：构造器传场景尺寸 + setSceneSize + resize）；
// Task 5 修复：resize 的视口=窗口/视口尺寸（viewport 参数），而非场景尺寸——cover 按窗口比例裁剪，
// 避免窗口比例 ≠ 场景比例时背景被 object-fit:fill 拉伸（对照 wasm 用 window.innerWidth/Height 的 cover）。
//
// 注意：`loadSceneToThree` 不直接 import wasm `CpuParticleSim`——wasm-bindgen 把它导出为**静态**
// `CpuParticleSim.new(...)`（非 `new CpuParticleSim(...)`），且 node/jsdom 无法实例化 wasm 模块。
// 故由 `assets.createParticleSim` 工厂抽象：生产传 wasm 包装（`CpuParticleSim.new(json, Float32Array.from(origin), w, h)`），
// 测试传 mock。three 播放器与 wasm 解耦（思路 1：不重写模拟，只换渲染引擎）。

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
  // scene.json 对象级 instanceoverride 的**原始 JSON 文本**（缺省/无覆盖 → undefined）。
  // 模拟器按官方 OverrideSpawnProgram 语义消费（alpha/size/lifetime/speed 乘数 + color 覆盖 +
  // emitter rate × count）。GTR 3743126786 的烟柱靠它把 alpha 压到 0.03（桌面端几乎不可见）。
  overrideJson?: string;
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
  // 粒子条件：particle 对象 id → 规格/纹理/混合。
  particles?: Map<number, LoadedParticleAssets>;
  // 粒子模拟器构造器（wasm CpuParticleSim 的包装；测试注入 mock）。
  createParticleSim?: ParticleSimFactory;
  // 对象隔离请求（对象级效果链）：scene.json 的**对象 id** → 隔离条件。
  //   调用方（three-renderer）只为「带效果的对象」下发本表；未列入的对象不隔离
  //   （内容直接进主 scene，帧序与今天逐字相同）。
  //   ⚠️ 值的 `objectId` 就是本表的键（同一个 obj.id 写两次）：player 用它作**隔离条目的键**
  //   （见 attachIsolated），从而与 ObjectEffectStage / wasm PendingChainStore 共用同一把键，
  //   不再需要「对象 id → 图层计数器 id」的翻译层（那层在 image+particle 同时隔离时会键冲突）。
  //   其余字段把两种量分开（见 addBackground/addParticle 的 isolate 注释）：
  //   rtWidth/rtHeight = 对象 RT 的像素尺寸（= 世界尺寸 × 屏幕密度的屏占位，等比收口到 4096）；
  //   worldW/worldH = 合成 quad 的世界尺寸（未钳制幅值）。
  isolate?: Map<number, { objectId: number; rtWidth: number; rtHeight: number; worldW: number; worldH: number }>;
  // 渲染像素比档位（<1 降分辨率省显存/提流畅；缺省 1）。调用方算屏幕密度时必须用同一个数。
  qualityScale?: number;
  // text 对象图层（对象 id → 纹理 + 可选时钟/脚本驱动）：与 image 同路径渲染为背景 quad。
  // 调用方负责 visible 过滤、纹理创建与字体加载；此处只消费。
  // size = 装配期实测 canvas（文本 + 2×padding），anchorOffset = origin 锚点 → 中心偏移。
  // driver.layout 是**最近一次文本**的实测布局：帧内文本变化时用它重算 quad 尺寸与锚点中心。
  textLayers?: Map<number, {
    texture: THREE.Texture;
    driver?: ClockDriver;
    size?: [number, number];
    anchorOffset?: [number, number];
  }>;
}

// `loadSceneToThree` 返回：播放器 + 已装配的模拟器/图层 id（供调用方驱动/释放/校验）。
export interface ThreeSceneLoadResult {
  player: ThreeScenePlayer;
  // 已创建的粒子模拟器（按 scene.json objects 顺序）；长度 = 有粒子 spec + createParticleSim 的粒子对象数。
  sims: ParticleSim[];
  // 背景图层 id（addBackground 返回值，按 objects 顺序）；长度 = image 对象数。
  backgroundIds: number[];
  // 粒子图层 id（addParticle 返回值）与其对应 sim 的配对。
  particleLayers: Array<{ id: number; sim: ParticleSim }>;
}

// 对齐 wasm `particle_render::frame_count_from_dims`：sprite sheet 横向帧数 = 纹理宽/高
// （每帧方形；rosepetals 512×128 → 4；单帧 → 1）。u32 整除 → floor。
export function frameCountFromDims(width: number, height: number): number {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  return Math.max(1, Math.floor(w / h));
}

// 从 THREE.Texture 读实际纹理尺寸推导 sprite sheet 帧数。
// DataTexture.image={width,height,data}；CompressedTexture.image 为 mip 数组 [{width,height,data},...]；
// ImageBitmap/HTMLImageElement.image.width/height。缺省/未知 → 1（单帧）。
//
// ⚠️ 优先取**纹理自带的 sprite 元数据**（`tex.userData.sprite`，由 tex-loader 解析 TEXV0005 的
// TEXS000x 段写入）：对 WE 的精灵表动画纹理（flags 位 2），按宽高推帧数是**错的**——DK 的
// `particle/fire/fire1` 与 `particle/fog/fog1` 都是 1024×1024 的 8×8=64 帧精灵表，`w/h=1`
// 会推出「1 帧」→ 每个粒子把整张表当一帧画出来（37 层火把 → 全屏密布亮点 + 整屏泛光）。
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
  // 构造器传场景尺寸（Task 1 裁决：视口缺省与场景同尺寸）；setSceneSize 冗余同步 + 用**真实视口**
  // resize（Task 5 修复：视口必须是窗口/视口尺寸，而非场景尺寸）。viewport 由调用方显式传入
  // （createThreeSceneRenderer.render 的 vw/vh = window.innerWidth/Height）；缺省回退场景尺寸
  // （构造器缺省 viewport=scene → cover==场景尺寸无裁剪，保持默认语义）。
  const player = new ThreeScenePlayer(canvas, sceneW, sceneH, assets.renderer, assets.qualityScale);
  player.setSceneSize(sceneW, sceneH);
  const vw = viewport?.width ?? sceneW;
  const vh = viewport?.height ?? sceneH;
  if (vw > 0 && vh > 0) player.resize(vw, vh);

  const backgroundIds: number[] = [];
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
  }> = [];

  for (const obj of desc.objects) {
    if (obj.kind === 'image') {
      // 背景对象：we_to_three（addBackground 内部）+ 对象调制（alpha/brightness）→ 背景图层。
      // alignment 缺省 centre（addBackground 签名无 alignment，Task 2 裁决）；origin 直传。
      const id = player.addBackground({
        origin: obj.origin,
        size: obj.size,
        scale: obj.scale,
        // WE 对象角度（弧度）→ mesh.rotation（three 的 Object3D 变换顺序即 T·R·S）。
        angles: obj.angles,
        // WE 图像颜色混合模式（非 0 且已实现时改用预乘 + CustomBlending，见 addBackground）。
        colorBlendMode: obj.colorBlendMode,
        texture: assets.backgroundTextures?.get(obj.id),
        alpha: obj.alpha,
        brightness: obj.brightness,
        sceneW,
        sceneH,
        // 对象级效果链：本对象带效果（调用方下发了隔离条件）→ 内容进 localScene 渲染到对象 RT，
        // 主场景放合成 quad；缺省不隔离，行为与今天逐字相同。隔离条目的键 = obj.id（值里的
        // objectId 同值），与 ObjectEffectStage 的键空间一致。
        isolate: assets.isolate?.get(obj.id),
      });
      backgroundIds.push(id);
    } else if (obj.kind === 'text') {
      // text 与 image 同路径（quad + 纹理）；缺条目 = 调用方按 visible 过滤掉了该对象。
      // 几何 = 实测 canvas 尺寸（不是 scene.json 的 size）；中心 = origin + 锚点偏移
      // （halign/valign 决定 origin 落在文本框哪条边，见 textLayerOffset）。
      const layer = assets.textLayers?.get(obj.id);
      if (!layer) continue;
      const off = layer.anchorOffset ?? [0, 0];
      const id = player.addBackground({
        origin: [obj.origin[0] + off[0], obj.origin[1] + off[1], obj.origin[2]],
        size: layer.size,
        scale: obj.scale,
        angles: obj.angles,
        texture: layer.texture,
        sceneW,
        sceneH,
      });
      backgroundIds.push(id);
      if (layer.driver) {
        textDrivers.push({
          texture: layer.texture,
          driver: layer.driver,
          backgroundId: id,
          origin: obj.origin,
          scale: obj.scale,
          horizontalAlign: obj.horizontalAlign,
          verticalAlign: obj.verticalAlign,
          alignment: obj.alignment,
        });
      }
    } else if (obj.kind === 'particle' && obj.particle) {
      // 粒子对象：仅当调用方提供 spec + 模拟器工厂时装配（缺 spec/工厂 → 跳过该对象，绝不白屏，
      // 与缺失粒子纹理时白图兜底同语义）。
      const p = assets.particles?.get(obj.id);
      if (!p || !assets.createParticleSim) continue;
      // new CpuParticleSim(json, origin, sceneW, sceneH, overrideJson)（经工厂抽象：生产 wasm /
      // 测试 mock）。第 5 参 = 该对象 instanceoverride 的原始 JSON（无覆盖 → 空串）。
      const sim = assets.createParticleSim(p.specJson, obj.origin, sceneW, sceneH, p.overrideJson ?? '');
      // FrameCount 对齐（Task 3 Minor）：sim.set_frame_count(纹理帧数)，addParticle 的
      // opts.frameCount 取 sim.frame_count()——避免多帧 uv 切片与 sim 帧编号错位。
      // 帧数优先取纹理携带的精灵表元数据（TEXS000x，DK 的 fire1/fog1 = 64 帧），否则按宽高推。
      const frameCount = textureFrameCount(p.tex);
      const grid = textureFrameGrid(p.tex);
      sim.set_frame_count(frameCount);
      // 对象变换（WE model matrix）：对象中心 we_to_three + scene.json 的 scale + spec 的 emitter 原点。
      // 顶点 shader 需要它们把模拟器输出的**发射点已乘黑神话 scale** 的坐标还原成局部坐标，
      // 再按**本对象**的真实 scale 重建（DK 的 Ice/Torch 等层 scale 与黑神话差异极大，
      // 不做这一步会把它们画成全屏辉光斑，见 PARTICLE_VERTEX_SHADER 注释）。
      const emitterOrigin = specEmitterOrigin(p.specJson);
      const id = player.addParticle(() => sim.vertices(), {
        tex: p.tex,
        frameCount: sim.frame_count(),
        frameCols: grid.cols,
        frameRows: grid.rows,
        blend: p.blend,
        softness: p.softness,
        objectCenter: [obj.origin[0] - sceneW / 2, obj.origin[1] - sceneH / 2, obj.origin[2]],
        objectScale: [obj.scale[0], obj.scale[1], obj.scale[2] ?? 1],
        // 对象角度（弧度）：顶点 shader 用它把局部运动方向/发射点/quad 角点旋转到场景空间。
        objectAngles: obj.angles,
        emitterOrigin,
        // 实例缓冲容量 = spec 的 maxcount（= wasm `SceneParticleSim.maxcount`，模拟器的发射上限）。
        // three 只在首帧锁存该容量（见 addParticle），必须按模拟器**最终**会产出的粒子数一次给足；
        // 缺 maxcount（旧格式/解析失败）→ addParticle 用 DEFAULT_PARTICLE_CAPACITY 兜底。
        maxInstances: specMaxcount(p.specJson),
        // 对象级效果链：带效果的粒子对象同样隔离（对象 RT + 合成 quad）。世界尺寸由调用方按
        // `particleWorldSize(spec, scale)` 算好（player 不知道 spec 的 distanceMax）；缺省不隔离。
        // 隔离条目的键 = obj.id（值里的 objectId 同值），与 ObjectEffectStage 的键空间一致。
        isolate: assets.isolate?.get(obj.id),
      });
      particleLayers.push({ id, sim });
      sims.push(sim);
    }
  }

  // 播放循环：RAF 每帧先 sim.update(dt)（dt 由 setAnimationLoop 帧差分、clamp 0.1）再
  // player.update(dt)（→ updateParticles(dt) 读 getter = sim.vertices()，sim 已在帧内推进）。
  player.setAnimationLoop((dt) => {
    for (const sim of sims) sim.update(dt);
    // 时钟/脚本文本：文本变化才重绘（同分钟不重绘）→ 置 needsUpdate 触发纹理上传，
    // 并按新文本的实测布局同步 quad 尺寸与锚点中心（origin 是锚点 ⇒ 原地生长/收缩）。
    for (const t of textDrivers) {
      if (!t.driver.update(new Date())) continue;
      t.texture.needsUpdate = true;
      const layout = t.driver.layout;
      const off = textLayerOffset(layout, t.horizontalAlign, t.verticalAlign, t.alignment, t.scale);
      const o = t.origin;
      player.update_background(t.backgroundId, [o[0] + off[0], o[1] + off[1], o[2]]);
      player.resizeBackground(t.backgroundId, [layout.width, layout.height]);
    }
  });

  return { player, sims, backgroundIds, particleLayers };
}
