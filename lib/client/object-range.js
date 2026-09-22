// src/client/object-range.ts
// 对象级效果链所需的几何 / 尺寸 / 分组 / 竞态纯函数 —— **唯一实现**。
//
// 这些函数一期在 scene-renderer.ts 中实现并已单测；three 主路径的对象级效果链
// （object-effects.ts）同样需要它们，故移到本模块，scene-renderer.ts 改为
// import + 重新导出（既有 import 方零改动、单测零改动）。
// 移动是纯机械的：实现逐字保持不变。
import * as THREE from 'three';
export const CAMERA_DISTANCE = 300; // 相机沿 +z 放置，使 shader 中 300/-mv.z = 1（点尺寸=像素尺寸）
// 对象级渲染目标尺寸上限：防止超大对象（如 6144px 贴图）的对象 RT 撑爆 VRAM
// （逐轴钳制，见 objectCameraRange 注释）。
export const OBJECT_RT_MAX = 4096;
// 材质调制系数（T4.3）：WE 对象 color/alpha/brightness → three 材质输入。
//   color：0-255 量级 → /255 到 0-1；
//   brightness：乘法系数（缺省 1），MeshBasicMaterial 无亮度通道 → 乘入 color，结果 clamp 0-1；
//   alpha：解析器已归一化 0-1（缺省 1）→ material.opacity（材质 transparent 已置位）。
// 输出 {r,g,b,a} 0-1；全缺省 → {1,1,1,1}（无调制，不改变材质默认值）。
export function materialModulation(color, alpha, brightness) {
    const b = brightness ?? 1;
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const c = color ?? [255, 255, 255];
    return {
        r: clamp01((c[0] / 255) * b),
        g: clamp01((c[1] / 255) * b),
        b: clamp01((c[2] / 255) * b),
        a: clamp01(alpha ?? 1),
    };
}
// 对象局部正交相机范围 = |对象尺寸 × 缩放|（中心原点），逐轴钳制 OBJECT_RT_MAX（= 4096）、下限 1。
// 相机范围（场景像素）同时作为对象 RT 的分辨率基准：不钳制时对象 quad 精确填满 RT，
// 效果链 UV 0-1 与 foliagesway_mask 等 mask 纹理对齐对象局部空间。
// T4.4：范围取**幅值**——负 scale 是对象自身镜像、不改变可见大小，镜像由 quad/几何承载
// （mesh.scale 或 RT 内容），相机不参与镜像；若用带符号乘积，负值会被下限钳成 1px →
// RT 退化、镜像内容不可见（实测 scale.y=-0.18 语义，见 git log）。
export function objectCameraRange(objSize, scale) {
    return {
        w: Math.max(1, Math.min(Math.abs(objSize[0] * scale[0]), OBJECT_RT_MAX)),
        h: Math.max(1, Math.min(Math.abs(objSize[1] * scale[1]), OBJECT_RT_MAX)),
    };
}
// 粒子对象默认发射距离（T1.4）：粒子对象无 size 字段（如 fog1），且部分 spec 缺
// distanceMax——无/零 distanceMax 时按此估计世界包围盒（64px，保证对象 RT 不退化到
// 1px 而看不见内容）。
export const PARTICLE_DEFAULT_DISTANCE = 64;
// 粒子发射距离有效值：无/零 distanceMax → 默认 64。是粒子局部相机范围与合成 quad
// 世界尺寸的共同基准，保证「钳制只发生在 RT 范围、quad 世界尺寸始终未钳制」两处一致。
function effectiveParticleDistance(spec) {
    const dist = spec.distanceMax ?? 0;
    return dist > 0 ? dist : PARTICLE_DEFAULT_DISTANCE;
}
// 粒子对象局部正交相机范围（T1.4）：粒子动态发射（随时间持续产生）、对象无静态 size
// 字段，用发射器世界包围盒估计 |distanceMax × scale| 逐轴钳制 OBJECT_RT_MAX（= 4096）、下限 1（与
// objectCameraRange 同语义）。钳制轴由合成 quad 的 UV 窗口映射（复用 T1.3 机制）。
// T4.4：范围取幅值——负 scale 的粒子布局绕 origin 镜像由 points.scale / shader 的 scale
// 直乘承担，相机范围只关心可见大小（负值钳成 1px 会使 RT 退化，见 objectCameraRange）。
export function particleObjectRange(spec, scale) {
    const eff = effectiveParticleDistance(spec);
    return {
        w: Math.max(1, Math.min(Math.abs(eff * scale[0]), OBJECT_RT_MAX)),
        h: Math.max(1, Math.min(Math.abs(eff * scale[1]), OBJECT_RT_MAX)),
    };
}
// 粒子对象合成 quad 世界尺寸（T1.4）：未钳制 distanceMax × scale（同图片对象「未钳制
// size×scale」语义）；钳制轴粒子超出视锥部分在 RT 中不存在，由 UV 窗口只采样可见段。
export function particleWorldSize(spec, scale) {
    const eff = effectiveParticleDistance(spec);
    return { w: eff * scale[0], h: eff * scale[1] };
}
// 对象级渲染目标：按分辨率创建（浮点取整为整数像素，0/负数钳制 1 —— 保证
// EffectRunner.ensureTargets 收到的尺寸恒为干净的正整数，不产生退化 RT）。
export function createObjectRenderTarget(width, height) {
    return new THREE.WebGLRenderTarget(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
}
// 对象级效果路径调度谓词（T1.4）：effects 非空数组 → 走对象 RT 路径。image 与 particle
// 对象共用（粒子对象同样可挂效果链，与 image 一致按 objects 顺序分组）；无效果对象保持
// 共享场景路径。类型谓词让调用方分支内获得 effects 收窄。
export function shouldUseObjectPath(obj) {
    return Array.isArray(obj.effects) && obj.effects.length > 0;
}
// 对象级效果链分组（T1.3）：按 scene.json objects 顺序提取带效果对象（effects 非空数组），
// 每组保留该对象自己的 effects 数组（不展平——旧全屏路径 flatMap 展平导致 foliagesway 等
// 对象级效果整屏生效，T1.3 起每对象独立执行）。
// T3.1：text 对象不参与分组——text 永远走共享场景路径（不经过对象 RT/效果执行器），
// 其 effects 超出本期范围（SceneTextObject 无 effects 字段，见 shared/types.ts）。
export function groupEffectsByObject(objects) {
    const groups = [];
    for (const obj of objects) {
        if (obj.kind === 'text')
            continue;
        if (shouldUseObjectPath(obj)) {
            groups.push({ obj, effects: obj.effects });
        }
    }
    return groups;
}
// 效果链挂载暂存器：renderScene 的链解析 IIFE（await resolveEffectChain，内部多次 await
// loadFile 网络请求）与纹理加载循环（await resolveImageTexture 后 setImageObject 创建条目）
// 并发交错、无顺序屏障——链可能先于对象条目就绪。
// 本类做「条目存在即应用 / 缺失即暂存」的纯决策（node 可测，不触碰 renderer/runner）：
//   applyIfReady 返回 true → 调用方立即挂链；返回 false → 已按 objId 暂存，
//   setImageObject/addParticleSystem 创建条目后 take 补挂（否则链被静默丢弃 → 对象级效果不生效）。
// 同一 objId 后到的链覆盖先到的（最新链生效）；条目最终未创建（纹理加载失败）时
// stop() 调用 clear() 清理暂存，无残留。
export class PendingChainStore {
    stash = new Map();
    applyIfReady(objId, chains, hasEntry) {
        if (hasEntry)
            return true;
        this.stash.set(objId, chains);
        return false;
    }
    take(objId) {
        const chains = this.stash.get(objId);
        if (chains !== undefined)
            this.stash.delete(objId);
        return chains;
    }
    clear() {
        this.stash.clear();
    }
}
// 合成 quad 的 UV 窗口（T1.3）：对象 RT 只含局部相机视锥内的可见段（钳制轴 = RT 像素），
// 而合成 quad 世界尺寸 = 未钳制 size×scale。每轴窗口 = 可见段在对象局部空间的占比：
// uvStart = ((W-C)/2)/W（W=未钳制世界范围，C=钳制后范围=RT 像素），uvEnd = 1 - uvStart
// （窗口恒居中）；未钳制轴（C ≥ W）或非正 W → 全窗口 [0,1]。
export function uvWindow(unclamped, clamped) {
    if (unclamped <= 0 || clamped >= unclamped)
        return { start: 0, end: 1 };
    const start = (unclamped - clamped) / 2 / unclamped;
    return { start, end: 1 - start };
}
// 把 PlaneGeometry 的 UV 从 [0,1]² 线性**展开**映射到可见窗口外侧（每顶点
// UV' = (uv - start)/(end - start)）：start/end 是世界空间占比（见 uvWindow）。
// 钳制轴时中间 [start, end] 世界区间与 RT [0,1] 一一对应（RT 像素与场景像素 1:1），
// 窗口外侧超出 [0,1] 的 UV 由采样器 CLAMP 到 0/1（three 默认 ClampToEdgeWrapping）
// ——quad 左/下边采样 RT 左缘之前（CLAMP 0）、右/上边采样 RT 右缘之后（CLAMP 1），
// 世界中心不动点 1:1。未钳制轴窗口 [0,1] 时 (uv-0)/1 = uv，精确 1:1。
// 旧实现 UV' = start + uv*(end-start) 把窗口当纹理占比收缩导致内容放大，见 git log。
function applyUvWindow(geometry, ux, uy) {
    const uvs = geometry.attributes.uv.array;
    const wx = ux.end - ux.start;
    const wy = uy.end - uy.start;
    for (let i = 0; i < uvs.length; i += 2) {
        uvs[i] = wx > 0 ? (uvs[i] - ux.start) / wx : uvs[i];
        uvs[i + 1] = wy > 0 ? (uvs[i + 1] - uy.start) / wy : uvs[i + 1];
    }
    geometry.attributes.uv.needsUpdate = true;
}
// 合成 quad 几何（T1.3）：世界尺寸 = 未钳制 size×scale 的**幅值**；UV 逐轴映射进对象
// RT 的可见窗口（rtW/rtH = 钳制后范围 = RT 像素 = 局部相机范围，RT 像素与场景像素 1:1）。
// T4.4：quad 帧尺寸必须取幅值——对象 RT 路径的镜像已由局部 mesh 的负 scale 渲染进 RT
// 内容（局部场景 = 对象忠实渲染），合成 quad 只是显示帧；帧几何若用负 worldH
// （PlaneGeometry 翻转顶点）会把 RT 内已镜像的内容二次翻转回正（镜像抵消，输出不镜像）。
// 即「相机范围与 quad 帧用幅值，镜像活在 mesh/RT 内容」的职责分离。
//
// ⚠️ 本函数**不含** v 约定翻转：对象 RT 的 v 约定由调用方决定（three 主路径的隔离 RT 是
// **WE 约定** v=0=图像顶部，见 `threejs-player.attachIsolated`，其合成 quad 需再调
// `flipGeometryUvY`；未迁移的调用方保持默认）。默认参数下行为与引入翻转前逐字一致。
export function createCompositeGeometry(worldW, worldH, rtW, rtH) {
    const w = Math.abs(worldW);
    const h = Math.abs(worldH);
    const geometry = new THREE.PlaneGeometry(w, h);
    applyUvWindow(geometry, uvWindow(w, rtW), uvWindow(h, rtH));
    return geometry;
}
// 逐顶点 uvs[i+1] → 1 - uvs[i+1]（**v 约定翻转**）。用途：对象 RT 采用 WE 约定
// （v=0=图像顶部，见 `threejs-player.attachIsolated` 的 y 镜像局部相机）后，合成 quad 必须
// 再把 v 翻回 three 的显示约定（v=0=quad 底边）才能正立贴回主场景。
// 与 UV 窗口映射（applyUvWindow，窗口恒居中 ⇒ start+end=1）**可交换**：
//   (1-v-start)/wy == (end-v)/wy == 1-(v-start)/wy，两种顺序结果相同。
export function flipGeometryUvY(geometry) {
    const uvs = geometry.attributes.uv.array;
    for (let i = 1; i < uvs.length; i += 2)
        uvs[i] = 1 - uvs[i];
    geometry.attributes.uv.needsUpdate = true;
}
// 按「cover」语义计算正交相机范围：场景铺满视口、不变形，超出方向被裁剪。
// 导出供 threejs-player.ts 复用（同一源语义，不重写）。
//   场景固有尺寸 width×height × 视口宽高比 viewAspect → { w, h }（正交相机视锥尺寸）。
export function coverRange(width, height, viewAspect) {
    const sceneAspect = width / height;
    if (viewAspect > sceneAspect) {
        // 视口更宽 → 场景宽度铺满，垂直裁剪
        return { w: width, h: width / viewAspect };
    }
    // 视口更窄 → 场景高度铺满，水平裁剪
    return { w: height * viewAspect, h: height };
}
// 「屏幕密度」= 每个世界单位占多少**设备像素**（画布缓冲像素，不是 CSS 像素）。
//
// 这是对象 RT 尺寸口径的唯一基准（2026-09-14 清晰度归因，commit 见 git log）：
// 主相机按 coverRange 把场景宽 `coverW` 个世界单位铺满画布缓冲宽 `floor(viewW × dpr)` 个像素，
// cover 的两轴比例**天然相同**（coverRange 构造使然），故一个标量就完整描述「世界 → 屏幕」的
// 线性映射：`设备像素 = 世界单位 × screenScalePx(...)`。
//
// 为什么需要它：对象 RT 之前按「世界 × dpr，再等比收口到视口 × dpr」定尺寸，而合成 quad 在屏上
// 的占位是 `世界 × 屏幕密度`（两者**不同**：前者用视口宽收口、后者用 cover 宽；GTR 3743126786
// 实测 1280×714 vs 1290×720，差 0.8%）⇒ 合成那一步是「比 0.992 的双线性缩小 + 亚纹素相位漂移」
// ⇒ 整层背景锐度实测掉 52%（Laplacian 均方 713 → 342），且与 dpr 无关、与 MSAA 无关
// （见 .superpowers/sdd/2026-09-14-three-object-effects-pipeline/clarity-report.md）。
export function screenScalePx(sceneW, sceneH, viewW, viewH, dpr) {
    const sw = Number.isFinite(sceneW) && sceneW > 0 ? sceneW : 1;
    const sh = Number.isFinite(sceneH) && sceneH > 0 ? sceneH : 1;
    const vw = Number.isFinite(viewW) && viewW > 0 ? viewW : 1;
    const vh = Number.isFinite(viewH) && viewH > 0 ? viewH : 1;
    const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    const cover = coverRange(sw, sh, vw / vh);
    // 分子取**画布缓冲**宽（= player.resize 的 `canvas.width = floor(viewW × pixelRatio)`），
    // 与主相机实际铺满的像素网格同一把尺子。
    const bufferW = Math.max(1, Math.floor(vw * ratio));
    return bufferW / cover.w;
}
// 对象 RT 像素尺寸（spec §5.2；2026-09-14 换口径）：
//   RT 像素 = |对象世界尺寸| × 屏幕密度（= 对象在画布缓冲上的**占位像素**），
//   再**等比**收口到硬上限（缺省 OBJECT_RT_MAX = 4096）。
//
// 为什么是「屏幕占位」：隔离路径是「内容 → 对象 RT → 合成 quad → 屏幕」两跳。只有
//   ① RT 覆盖**整个对象**（相机范围 = 未钳制世界尺寸，见 threejs-player.attachIsolated），且
//   ② RT 的像素网格 = 对象在屏上的占位像素网格
// 同时成立时，第二跳的采样比才恒为 1.0 ⇒ 隔离路径与直渲近似位级等价（实测 Laplacian
// 711.1 vs 713.2、MAD 0.041）。任一不满足都退化成重采样：比值 <1 是双线性模糊（相位漂移把
// 最高频成对平均掉），>1 是无 mipmap 的缩小锯齿。反例（都实测过）：
//   - 旧口径「世界 × dpr 收口到视口 × dpr」：GTR 得 1280×714 vs 占位 1290×720 → 锐度 −52%；
//   - 预算放宽到 4096：Laplacian 虚高到 2574 但相对直渲 MAD 3.818（走样），显存 ×10.2；
//   - RT = 源纹理真实尺寸（WE 的 lwe 口径，本壁纸 7430×4147）：显存 352 MB/对象，超硬上限。
// 与桌面 WE 的关系：WE 的对象 RT = **纹理真实尺寸**（与屏幕解耦，本壁纸相当于 5.76× 超采样），
// 本口径取 1:1（最小无损），方向一致（RT 恒覆盖整个对象、且不小于屏占位）但不复制其超采样 ——
// 那需要 352 MB/对象，我们的 4096 硬上限 + 3 张 RT 的显存模型支撑不起。
//
// 单一比例（等比）：逐轴独立 clamp 会把 8192×4608 压成 4096×4096、破坏依赖 aspect 的效果
// （竞品 perf-audit 2026-08-29 记录的真实事故）。
// 非有限输入（NaN / ±Infinity）按 0 处理：`Math.abs(NaN)` 仍是 NaN，会一路传到
// `new THREE.WebGLRenderTarget(NaN, NaN)`（非法 GL 尺寸，建不出 RT）；收口成 0 后由下限归一到 1。
export function objectRtSize(worldW, worldH, screenScale, cap = OBJECT_RT_MAX) {
    const scale = Number.isFinite(screenScale) && screenScale > 0 ? screenScale : 1;
    const abs = (v) => (Number.isFinite(v) ? Math.abs(v) : 0);
    const rawW = abs(worldW) * scale;
    const rawH = abs(worldH) * scale;
    const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : OBJECT_RT_MAX;
    // 两轴共用同一比例；rawW/rawH 均为 0 时比例取 1（避免除零，下限再归一到 1×1）
    const k = Math.min(1, limit / Math.max(rawW, rawH, 1));
    const width = Math.max(1, Math.round(rawW * k));
    const height = Math.max(1, Math.round(rawH * k));
    return { width, height };
}
