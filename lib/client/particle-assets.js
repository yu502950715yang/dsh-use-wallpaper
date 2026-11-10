// 粒子资产：渲染常量 / spec 纯函数 / billboard shader。从 ThreeScenePlayer 拆出（审查 P0-9 阶段 2c-2 前置）。
// 无状态纯函数与 GLSL 常量；player 用 `export *` 保持公开 API 不变。
import * as THREE from 'three';
// 粒子实例缓冲的**缺省容量**：每个 instanced attribute 的 count 必须 ≥ 模拟器最终产出的粒子数
// （sim 的 `maxcount`，WE spec 的 maxcount 字段）。wasm 侧已把 maxcount clamp 到
// `MAX_PARTICLES = 16384`（particle/mod.rs，1.0 P0-2 加固），这里的 MAX 只是渲染侧**建议**上限；
// `aliveAtCreate` 高于它时按实际数量分配（但那已被 wasm 侧硬上限约束，不会无界放大）。
export const DEFAULT_PARTICLE_CAPACITY = 1024;
export const MAX_PARTICLE_CAPACITY = 2048;
/** 纵深兜底：与 wasm 侧 `MAX_PARTICLES` 同口径，防旧 wasm 产物/异常实现把实例缓冲放大。 */
export const MAX_PARTICLE_HARD_CAP = 16384;
// 每粒子摊平顶点浮点数 = Rust `SceneParticleSim::build_instance_vertices` 的布局长度
// （`[pos3, size, uv2, color3, alpha, rot3, vel3]`）。⚠️ 与 wasm 侧是**同一份契约**：
// 改布局必须两侧同时改（Rust 用 `build_instance_vertices_flat_per_particle` 钉住 16）。
export const PARTICLE_FLOATS_PER_INSTANCE = 16;
// 从粒子 spec JSON 读 `maxcount`（= wasm `SceneParticleSim.maxcount`；WE 的 JSON 里也可能是
// 字符串 "50"）。缺省/非法/非正 → 0（调用方落到 DEFAULT_PARTICLE_CAPACITY）。
export function specMaxcount(specJson) {
    try {
        const v = JSON.parse(specJson).maxcount;
        const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : 0;
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    }
    catch {
        return 0;
    }
}
// 解析 spec JSON 的 `renderer[0]`。非法/缺失 → sprite（不启用拖尾，行为与旧版一致）。
export function specRenderer(specJson) {
    const sprite = { kind: 'sprite', length: 0.05, maxLength: 10, minLength: 0 };
    try {
        const raw = JSON.parse(specJson).renderer;
        const first = Array.isArray(raw) ? raw[0] : undefined;
        if (!first || typeof first.name !== 'string' || first.name !== 'spritetrail')
            return sprite;
        const num = (v, dflt) => {
            const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
            return Number.isFinite(n) ? n : dflt;
        };
        const r = first;
        return {
            kind: 'spritetrail',
            length: num(r.length, 0.05),
            maxLength: num(r.maxlength, 10),
            minLength: num(r.minlength, 0),
        };
    }
    catch {
        return sprite;
    }
}
// 粒子纹理的「高/宽」比（WE `g_Texture0Resolution.y / g_Texture0Resolution.x`）：
// 精灵表按**单帧**尺寸算（WE 的 SPRITESHEET 分支用 g_RenderVar1.w = 单帧宽高比）；
// 缺省 1（无纹理 / 尺寸未知）。
export function textureTexelRatio(tex) {
    const grid = textureSpriteInfo(tex);
    const img = (Array.isArray(tex?.image) ? tex?.image[0] : tex?.image);
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
export function specPerspective(specJson) {
    try {
        const raw = JSON.parse(specJson).flags;
        const n = typeof raw === 'string' ? parseFloat(raw) : typeof raw === 'number' ? raw : 0;
        return Number.isFinite(n) && (Math.floor(n) & 4) !== 0;
    }
    catch {
        return false;
    }
}
// 「稀疏事件源」粒子：spec 同时满足 ① children 含 type=eventspawn ② maxcount ≤ 1
// ③ emitter[0].rate < 1。桌面**不渲染**这类粒子（本插件会画出直径约 200px 的白色柔光斑），
// 但机制未明（官方文档与 OWE/lwe 都认为此类父粒子应正常渲染）⇒ 本条按**观测**对齐，
// 条件收窄到全库只命中该壁纸的 26 个对象。非法/缺失 → false。
export function specSparseEventSource(specJson) {
    try {
        const spec = JSON.parse(specJson);
        const children = Array.isArray(spec.children) ? spec.children : [];
        const hasEventSpawn = children.some((c) => c?.type === 'eventspawn');
        if (!hasEventSpawn)
            return false;
        const maxcount = typeof spec.maxcount === 'string' ? parseFloat(spec.maxcount) : spec.maxcount;
        if (typeof maxcount !== 'number' || !Number.isFinite(maxcount) || maxcount > 1)
            return false;
        const first = Array.isArray(spec.emitter) ? spec.emitter[0] : undefined;
        const rate = typeof first?.rate === 'string' ? parseFloat(first.rate) : first?.rate;
        return typeof rate === 'number' && Number.isFinite(rate) && rate < 1;
    }
    catch {
        return false;
    }
}
// WE 的粒子透视相机参数（正交场景内）：
//   fov      = general.perspectiveoverridefov（>0 时），否则按**固定 1000 距离**反算
//   distance = 场景高 / (2·tan(fov/2))
// 对应 OWE `Algorism.cpp:8-17` 的 CalculatePersperctiveDistance / CalculatePersperctiveFov
// 与 `SceneObjectParsers.cpp:59-85`（相机置于 (center.x, center.y, distance)，看向 z=0 平面）。
export function particlePerspectiveCamera(opts) {
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
export function particlePerspMatrix(p) {
    if (!p)
        return new THREE.Matrix4();
    const cam = new THREE.PerspectiveCamera(p.fov, p.aspect > 0 ? p.aspect : 1, 1, 1e6);
    cam.position.set(0, 0, p.distance);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    return new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
}
// 从粒子 spec JSON 读 **emitter 的局部原点**（`emitter[0].origin`，WE 字符串 "x y z"）。
// 只用**第一个** emitter、缺省 [0,0,0]、y **不翻**（本仓库 three 路径与背景同系）。
// 非法/缺失 → [0,0,0]（绝不抛）。
export function specEmitterOrigin(specJson) {
    const zero = [0, 0, 0];
    try {
        const spec = JSON.parse(specJson);
        const list = spec.emitter;
        const first = Array.isArray(list) ? list[0] : undefined;
        const raw = first?.origin;
        if (typeof raw !== 'string')
            return zero;
        const parts = raw.trim().split(/\s+/).map(Number);
        if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n)))
            return zero;
        return [parts[0], parts[1], parts[2]];
    }
    catch {
        return zero;
    }
}
// wasm `SceneParticleSim` 在 spawn 时对**发射点**乘的硬编码对象 scale（wasm/src/particle/sim.rs
// `BLACKMYTH_OBJ_SCALE`）。three 路径的顶点 shader 要从模拟器输出里**减掉**这项才能拿到纯局部
// 坐标（散射 + 运动），再按真实对象 scale 重建 ⇒ 必须与 wasm 常量逐位一致（改动需同步）。
export const BLACKMYTH_OBJ_SCALE = [-2.05166, 2.1167, 1.0];
// 计算模拟器已加入 `particlePosition` 的发射点偏移：`BLACKMYTH_OBJ_SCALE ⊙ emitterOrigin`。
export function simEmitterOffset(emitterOrigin) {
    return [
        emitterOrigin[0] * BLACKMYTH_OBJ_SCALE[0],
        emitterOrigin[1] * BLACKMYTH_OBJ_SCALE[1],
        emitterOrigin[2] * BLACKMYTH_OBJ_SCALE[2],
    ];
}
// 计算实例缓冲容量：declaredMax（spec 的 maxcount，0 = 未声明）优先，否则缺省；
// 再 clamp 到 [1, MAX_PARTICLE_CAPACITY]，并保证 ≥ 建层当帧已有的粒子数。
export function particleCapacity(declaredMax, aliveAtCreate) {
    const declared = Number.isFinite(declaredMax) && declaredMax > 0 ? Math.floor(declaredMax) : 0;
    const cap = Math.min(declared > 0 ? declared : DEFAULT_PARTICLE_CAPACITY, MAX_PARTICLE_CAPACITY);
    // 容量不得小于建层当帧已有粒子数；再叠一层与 wasm 一致的硬上限（1.0 P0-2 纵深）。
    return Math.min(MAX_PARTICLE_HARD_CAP, Math.max(1, cap, Math.max(0, Math.floor(aliveAtCreate))));
}
// 4 角点单位四边形（[-1,1]²，z=0）：作为 InstancedBufferGeometry 的基础顶点 position（角点），
// 顶点 shader 用它展开 billboard（pos + corner*half_size）。索引 [0,1,2, 0,2,3] 组成 2 个三角形
// （从 +z 相机方向看为逆时针 → FrontSide 可见）。
export const PARTICLE_QUAD_CORNERS = new Float32Array([
    -1, -1, 0,
    1, -1, 0,
    1, 1, 0,
    -1, 1, 0,
]);
export const PARTICLE_QUAD_INDEX = [0, 1, 2, 0, 2, 3];
// 粒子 billboard 顶点 shader：每粒子一个实例，基础四边形 position=[-1,1]² 作角点，
// worldPos = particlePosition + corner*half_size（half_size = particleSize/2，corner 先绕
// particleRot 自旋），再用 mvp 投影。只需补每粒子 instanced 属性（particlePosition/Size/Uv/
// Color/Alpha/Rot）与 varyings；position/normal/uv/矩阵由 three.js 自动注入。
export const PARTICLE_VERTEX_SHADER = `
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
// 对象角度旋转 R = Rz·Ry·Rx（OWE ParticleRuntime.cpp:25-28 ControlpointRotation；对象路径沿用，勿改）。
// 每个分量都是右手系绕轴的主动旋转，与 Eigen AngleAxisd(theta, axis) 一致。
vec3 weObjectRotate(vec3 v, vec3 a) {
  float cx = cos(a.x), sx = sin(a.x);
  v = vec3(v.x, v.y * cx - v.z * sx, v.y * sx + v.z * cx);
  float cy = cos(a.y), sy = sin(a.y);
  v = vec3(v.x * cy + v.z * sy, v.y, -v.x * sy + v.z * cy);
  float cz = cos(a.z), sz = sin(a.z);
  return vec3(v.x * cz - v.y * sz, v.x * sz + v.y * cz, v.z);
}
// 粒子自旋 R = Rz·Rx·Ry（WE common_particles.h:26-35 ComputeParticleTangents，与对象角度顺序不同）。
// 同列向量右乘约定；仅用于自旋，z-only 时与 weObjectRotate 逐像素等价。
vec3 weParticleSpinRotate(vec3 v, vec3 a) {
  float cy = cos(a.y), sy = sin(a.y);
  v = vec3(v.x * cy + v.z * sy, v.y, -v.x * sy + v.z * cy);
  float cx = cos(a.x), sx = sin(a.x);
  v = vec3(v.x, v.y * cx - v.z * sx, v.y * sx + v.z * cx);
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
  // 粒子 quad 尺寸乘对象 scale（非均匀；abs 去掉镜像符号）并随对象角度转；自旋用 WE 轴序 Rz·Rx·Ry，
  // 对象角度仍用 Rz·Ry·Rx（两序 z-only 等价）—— 见 weParticleSpinRotate。
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
    vec3 spun = weParticleSpinRotate(vec3(position.xy, 0.0), particleRot);
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
  // 折射切线基（屏幕空间位移方向）：与上面 quad 角点展开同一约定/同一次序（先粒子自旋〔WE 轴序〕、
  // 再对象角度），对齐 WE ComputeParticleTangents（common_particles.h:26-39；genericparticle.vert:85,117 同序）。
  // vScreenCoord 必须在 gl_Position 之后取。
  vec3 rRight = normalize(weObjectRotate(weParticleSpinRotate(vec3(1.0, 0.0, 0.0), particleRot), objAngles));
  vec3 rUp = normalize(weObjectRotate(weParticleSpinRotate(vec3(0.0, 1.0, 0.0), particleRot), objAngles));
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
export const PARTICLE_FRAGMENT_SHADER = `
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
// 纹理帧数/精灵表元数据（粒子渲染器与背景精灵表共用；从 player 迁入）。
export function frameCountFromDims(width, height) {
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
export function textureFrameCount(tex) {
    const sprite = textureSpriteInfo(tex);
    if (sprite)
        return Math.max(1, Math.floor(sprite.frames));
    if (!tex)
        return 1;
    const img = tex.image;
    if (img &&
        typeof img.width === 'number' && typeof img.height === 'number' &&
        img.width > 0 && img.height > 0) {
        return frameCountFromDims(img.width, img.height);
    }
    if (Array.isArray(tex.image)) {
        const first = tex.image[0];
        if (first &&
            typeof first.width === 'number' && typeof first.height === 'number' &&
            first.width > 0 && first.height > 0) {
            return frameCountFromDims(first.width, first.height);
        }
    }
    return 1;
}
// 读纹理携带的精灵表元数据（tex-loader 解析 TEXS000x 后写入 `userData.sprite`）。
// 非法/缺失 → undefined（调用方回退「按宽高推帧数 + 横向等分」的旧语义）。
export function textureSpriteInfo(tex) {
    const raw = tex?.userData?.sprite;
    if (!raw || typeof raw !== 'object')
        return undefined;
    const s = raw;
    const frames = typeof s.frames === 'number' ? Math.floor(s.frames) : 0;
    const cols = typeof s.cols === 'number' ? Math.floor(s.cols) : 0;
    const rows = typeof s.rows === 'number' ? Math.floor(s.rows) : 0;
    const frametime = typeof s.frametime === 'number' && Number.isFinite(s.frametime) && s.frametime > 0
        ? s.frametime
        : undefined;
    if (frames <= 0 || cols <= 0 || rows <= 0)
        return undefined;
    return frametime !== undefined ? { frames, cols, rows, frametime } : { frames, cols, rows };
}
// 帧网格（列×行）：精灵表 → 真实网格；否则 → { cols: frameCount, rows: 1 }（横向等分，旧行为）。
export function textureFrameGrid(tex) {
    const sprite = textureSpriteInfo(tex);
    if (sprite)
        return { cols: sprite.cols, rows: sprite.rows };
    return { cols: textureFrameCount(tex), rows: 1 };
}
