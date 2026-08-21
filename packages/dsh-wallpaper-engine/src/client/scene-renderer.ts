import * as THREE from 'three';
import type { SceneDescription, SceneImageObject, SceneObject, SceneParticleObject, SceneTextObject } from '../shared/types.js';
import { createParticleSystem } from './particles.js';
import type { ParticleEmitterSpec, ParticleInitializerSpec } from './particles.js';
import { fetchSceneDescription, fetchParticleSpec } from './scene-assets.js';
import { loadTexTexture } from './tex-loader.js';
import { createTextTexture, textCanvasSize } from './text-object.js';
import type { TextTextureOptions } from './text-object.js';
import { EffectRunner } from './effect-runner.js';
import { resolveEffectChain } from './shader/effect-chain.js';
import { fetchWithRetry } from './fetch-util.js';
import { createAudioAnalyzer, playWallpaperSound } from './audio-input.js';
import type { AudioAnalyzer } from './audio-input.js';
import { detectScriptPattern, formatClockText, VISUALIZER_BAR_COUNT } from './script-patterns.js';
import { applyAlignment } from './alignment.js';
import { resolveVisibility } from './visibility.js';

// 编译后效果链（T1.3）：每组对象的独立链集合（一条链 = CompiledEffectPass[]，逐 pass ping-pong）
type CompiledEffectChains = import('./shader/effect-chain.js').CompiledEffectPass[][];

export interface SceneRenderer {
  setScene(desc: SceneDescription): void;
  setImageObject(tex: THREE.Texture | null, obj: SceneImageObject): void;
  // text 对象（T3.1）：静态文本 CanvasTexture → 共享场景 quad。始终走共享场景路径
  // （不经过对象 RT/效果路径——text 对象带 effects 时仍渲染静态 quad，效果超本期范围）。
  setTextObject(tex: THREE.CanvasTexture, obj: SceneTextObject): void;
  // 脚本内置模式（T3.3）：visualizer（image 对象 visible.script 识别）→ 64 条音频条
  // （共享 bar 纹理，每帧按频谱刷新条高）；clock（text 对象 text.script 识别）→
  // 每帧生成时间文本刷新纹理（复用 createTextTexture，旧纹理 dispose）。
  // 与 setTextObject 一致始终走共享场景路径（不经过对象 RT/效果路径）。
  setVisualizerObject(tex: THREE.Texture, obj: SceneImageObject): void;
  setClockObject(obj: SceneTextObject): void;
  // 粒子对象（T1.4）：带效果粒子与 image 对象同走对象 RT 路径（obj.effects 非空 →
  // 对象局部相机 + 对象 RT + 合成 quad，效果链在 RT 上执行后贴回共享场景）；
  // 无效果粒子保持共享场景路径。
  addParticleSystem(spec: { emitter: ParticleEmitterSpec; init: ParticleInitializerSpec }, obj: SceneParticleObject): void;
  // 对象级效果链（T1.3）：给指定对象 id 挂载/替换其效果链（每个带效果对象一个独立
  // EffectRunner，共享同一 renderer；chains 为空 → 移除 runner，quad 回退原始对象 RT）。
  setObjectEffectChains(objId: number, chains: CompiledEffectChains | null, wallpaperId: string): void;
  start(): void;
  stop(): void;
}

// 坐标映射（2026-08-20 方向修正，全库目检证实）：
// Wallpaper Engine 场景系 = 左下原点、y 向上（origin.y 是距底部的距离，非距顶部）；
// three 正交相机 = 中心原点、y 向上。
// 映射：three.x = we.x - vw/2；three.y = we.y - vh/2（y 不做翻转，两系 y 同向）。
// 对象锚点（origin）是 WE 中的中心点：中心映射为 (ox - vw/2, oy - vh/2)。
// 实测证据：NERV logo origin.y=150（2832263418）官方渲染在右下角（距底 150）；
//   Orange 部件 Тело origin.y=384 官方叠在少女身上（距底 384 = 距顶 1056）；
//   旧实现 `vh/2 - we.y`（y 翻转）把两者镜像到顶部 → 部件漂浮在少女头顶（1429403119 问题图）。
// EVA 主图 origin=(1200,777.5)=size/2 恰居中（oy=sh/2）故新旧公式结果相同，早期验收漏过。
const CAMERA_DISTANCE = 300; // 相机沿 +z 放置，使 shader 中 300/-mv.z = 1（点尺寸=像素尺寸）

// 对象级渲染目标尺寸上限：防止超大对象（如 6144px 贴图）的对象 RT 撑爆 VRAM
// （逐轴钳制，见 objectCameraRange 注释）。
const OBJECT_RT_MAX = 2048;

// 材质调制系数（T4.3）：WE 对象 color/alpha/brightness → three 材质输入。
//   color：0-255 量级（optColor 归一化输出）→ /255 到 0-1；
//   brightness：乘法系数（缺省 1），MeshBasicMaterial 无亮度通道 → 乘入 color，
//     结果 clamp 0-1（brightness 超 1 时颜色饱和到纯色而非溢出）；
//   alpha：解析器已归一化 0-1（缺省 1）→ material.opacity（材质 transparent 已置位）。
// 输出 {r,g,b,a} 0-1；全缺省 → {1,1,1,1}（无调制，不改变材质默认值）。
export function materialModulation(
  color?: [number, number, number],
  alpha?: number,
  brightness?: number,
): { r: number; g: number; b: number; a: number } {
  const b = brightness ?? 1;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const c = color ?? [255, 255, 255];
  return {
    r: clamp01((c[0] / 255) * b),
    g: clamp01((c[1] / 255) * b),
    b: clamp01((c[2] / 255) * b),
    a: clamp01(alpha ?? 1),
  };
}

// 对象局部正交相机范围 = |对象尺寸 × 缩放|（中心原点），逐轴钳制 2048、下限 1。
// 相机范围（场景像素）同时作为对象 RT 的分辨率基准：不钳制时对象 quad 精确填满 RT，
// 效果链 UV 0-1 与 foliagesway_mask 等 mask 纹理对齐对象局部空间。
// 钳制时该轴对象超出相机视锥被裁剪（超大对象保护性降采样，T1.3 合成时按 UV 语义映射）。
// T4.4：范围是**幅值**（负 scale 是对象自身镜像，不改变可见大小）——负 scale.y 下
// RT 分辨率取 |size×scale|，镜像由 quad/几何承载（mesh.scale 或 RT 内容），相机不参与
// 镜像；若用带符号乘积，负值会被下限钳成 1px → RT 退化、镜像内容不可见（2460786246
// scale.y=-0.18 实测语义，task-4.4 报告）。
export function objectCameraRange(objSize: [number, number], scale: [number, number]): { w: number; h: number } {
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
function effectiveParticleDistance(spec: { distanceMax?: number }): number {
  const dist = spec.distanceMax ?? 0;
  return dist > 0 ? dist : PARTICLE_DEFAULT_DISTANCE;
}

// 粒子对象局部正交相机范围（T1.4）：粒子动态发射（随时间持续产生）、对象无静态 size
// 字段，用发射器世界包围盒估计 |distanceMax × scale| 逐轴钳制 2048、下限 1（与
// objectCameraRange 同语义）。钳制轴由合成 quad 的 UV 窗口映射（复用 T1.3 机制）。
// T4.4：范围取幅值——负 scale 的粒子布局绕 origin 镜像由 points.scale / shader 的
// scale 直乘承担，相机范围只关心可见大小（负值钳成 1px 会使 RT 退化，见 objectCameraRange）。
export function particleObjectRange(spec: { distanceMax?: number }, scale: [number, number]): { w: number; h: number } {
  const eff = effectiveParticleDistance(spec);
  return {
    w: Math.max(1, Math.min(Math.abs(eff * scale[0]), OBJECT_RT_MAX)),
    h: Math.max(1, Math.min(Math.abs(eff * scale[1]), OBJECT_RT_MAX)),
  };
}

// 粒子对象合成 quad 世界尺寸（T1.4）：未钳制 distanceMax × scale（同图片对象「未钳制
// size×scale」语义）；钳制轴粒子超出视锥部分在 RT 中不存在，由 UV 窗口只采样可见段。
export function particleWorldSize(spec: { distanceMax?: number }, scale: [number, number]): { w: number; h: number } {
  const eff = effectiveParticleDistance(spec);
  return { w: eff * scale[0], h: eff * scale[1] };
}

// 对象级渲染目标：按分辨率创建（浮点取整为整数像素，0/负数钳制 1 —— 保证
// EffectRunner.ensureTargets 收到的尺寸恒为干净的正整数，不产生退化 RT）。
export function createObjectRenderTarget(width: number, height: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
}

// 对象级效果路径调度谓词（T1.4）：effects 非空数组 → 走对象 RT 路径。image 与
// particle 对象共用（Ruling 5：粒子对象同样可挂效果链，与 image/util 一致按 objects
// 顺序分组）；无效果对象保持共享场景路径。类型谓词让调用方分支内获得 effects 收窄。
export function shouldUseObjectPath(obj: { effects?: unknown }): obj is { effects: unknown[] } {
  return Array.isArray(obj.effects) && obj.effects.length > 0;
}

// 对象级效果链分组（T1.3）：按 scene.json objects 顺序提取带效果对象（effects 非空数组），
// 每组保留该对象自己的 effects 数组（不展平——旧全屏路径 flatMap 展平导致 foliagesway 等
// 对象级效果整屏生效，T1.3 起每对象独立执行链）。
// T3.1：text 对象不参与分组——text 永远走共享场景路径（不经过对象 RT/效果执行器），
// 其 effects 超出本期范围（SceneTextObject 无 effects 字段，见 shared/types.ts）。
export function groupEffectsByObject(objects: SceneObject[]): Array<{ obj: SceneObject; effects: unknown[] }> {
  const groups: Array<{ obj: SceneObject; effects: unknown[] }> = [];
  for (const obj of objects) {
    if (obj.kind === 'text') continue;
    if (shouldUseObjectPath(obj)) {
      groups.push({ obj, effects: obj.effects });
    }
  }
  return groups;
}

// 效果链挂载暂存器（I1 竞态修复）：renderScene 的链解析 IIFE（await resolveEffectChain，
// 内部多次 await loadFile 网络请求）与纹理加载循环（await resolveImageTexture 后
// setImageObject 创建条目）并发交错、无顺序屏障——链可能先于对象条目就绪。
// 本类做「条目存在即应用 / 缺失即暂存」的纯决策（node 可测，不触碰 renderer/runner）：
//   applyIfReady 返回 true → 调用方立即挂链；返回 false → 已按 objId 暂存，
//   setImageObject/addParticleSystem 创建条目后 take 补挂（否则链被静默丢弃 → 对象级效果不生效）。
// 同一 objId 后到的链覆盖先到的（最新链生效）；条目最终未创建（纹理加载失败）时
// stop() 调用 clear() 清理暂存，无残留。
export class PendingChainStore<T> {
  private stash = new Map<number, T>();
  applyIfReady(objId: number, chains: T, hasEntry: boolean): boolean {
    if (hasEntry) return true;
    this.stash.set(objId, chains);
    return false;
  }
  take(objId: number): T | undefined {
    const chains = this.stash.get(objId);
    if (chains !== undefined) this.stash.delete(objId);
    return chains;
  }
  clear(): void {
    this.stash.clear();
  }
}

// ── T3.3 脚本内置模式驱动 ──────────────────────────────────────────────
// visualizer / clock 为纯逻辑 + THREE 变换操作（node 可测，不触碰 WebGLRenderer），
// 渲染器每帧调用；语义对齐 2937346640 真实脚本（fixture 见 tests/fixtures/2937346640/）。

// scriptProperties 数值字段兜底：数值/数字字符串 → 有限值；缺省/非法 → fallback
// （WE 属性在 scene.json 中总是携带，此处防御渲染侧数据缺失）。
function toFiniteNum(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// alignment 锚点 → 中心锚定 quad 的 y 偏移（Ruling P4-1 的 applyAlignment 语义，
// 本任务先做中心锚定近似；T4.1 抽共享函数后复用）：
//   centre/缺省 → 0（quad 中心 = 锚点）；
//   bottom（锚点=底边）→ +h/2（quad 中心上移半高，条自锚点向上生长）；
//   top（锚点=顶边）→ -h/2（quad 中心下移半高，条自锚点向下生长）。
export function barAnchorOffsetY(alignment: string | undefined, height: number): number {
  if (alignment === 'bottom') return height / 2;
  if (alignment === 'top') return -height / 2;
  return 0;
}

// visualizer 每帧刷新（对齐 Simple Visualizer 脚本语义）：
//   scale.y = amt × scriptProperties.scaleY（amt = freqData[i]/255，无分析器 → 0）；
//   origin.y += 0（锚点 y 恒定，只按 alignment 做中心锚定偏移）；
//   origin.x += originX 在脚本循环内逐条累积——创建期已按 (i+1)×originX 写入
//   position.x（脚本先 += 再赋值：第 i 条 x = baseX + (i+1)×originX），本函数不改 x。
// 64 条共享同一几何/材质，每帧仅改 scale.y 与 position.y（64 次标量运算，开销可忽略）。
export function updateVisualizerBars(
  bars: readonly THREE.Mesh[],
  anchorY: number,                       // 三坐标系锚点 y（对象 origin 的中心映射，不翻转）
  props: Record<string, unknown>,        // 已解包的 scriptProperties
  freqData: Uint8Array | null,           // 音频频谱缓冲（T3.2，字节 0-255）；null → 全零
): void {
  const scaleY = toFiniteNum(props.scaleY, 10);
  const alignment = typeof props.barAlignmentdir === 'string' ? props.barAlignmentdir : 'bottom';
  const len = freqData?.length ?? 0;
  for (let i = 0; i < bars.length; i++) {
    const amp = len > 0 ? (freqData![i % len] / 255) : 0;
    const h = amp * scaleY;
    const bar = bars[i];
    bar.scale.y = h;
    bar.position.y = anchorY + barAnchorOffsetY(alignment, h);
  }
}

// clock 文本驱动：每帧生成时间文本，文本变化才重建 CanvasTexture（同分钟不重绘，
// 每分钟至多 1 次纹理重建）；旧纹理必须 dispose（防逐分钟纹理泄漏）。
// 构造即生成初始纹理（material.map 恒非空，无需 needsUpdate 重编译）。
export class ClockTextDriver {
  private lastText = '';
  private lastTex: THREE.CanvasTexture | null = null;

  constructor(
    private mesh: THREE.Mesh,
    private opts: TextTextureOptions,
    private props: Record<string, unknown>,
  ) {
    this.update(new Date());
  }

  update(now: Date): void {
    const text = formatClockText(now, this.props);
    if (text === this.lastText) return; // 文本未变化（同一分钟）→ 不重建纹理
    const tex = createTextTexture(text, this.opts);
    (this.mesh.material as THREE.MeshBasicMaterial).map = tex;
    this.lastTex?.dispose(); // 释放旧纹理
    this.lastTex = tex;
    this.lastText = text;
  }

  dispose(): void {
    this.lastTex?.dispose();
    this.lastTex = null;
    this.lastText = '';
  }
}

// visualizer 纹理解析失败兜底：1×1 白色 DataTexture（bar.tex 本体即 4×4 白纹理，
// 纯色条不依赖纹理内容，白图即可正确着色）。
function createWhiteDataTexture(): THREE.DataTexture {
  const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  tex.needsUpdate = true;
  return tex;
}

// 合成 quad 的 UV 窗口（T1.3）：对象 RT 只含局部相机视锥内的可见段（钳制轴 = RT 像素），
// 而合成 quad 世界尺寸 = 未钳制 size×scale。每轴窗口 = 可见段在对象局部空间的占比：
// uvStart = ((W-C)/2)/W（W=未钳制世界范围，C=钳制后范围=RT 像素），uvEnd = 1 - uvStart
// （窗口恒居中）；未钳制轴（C ≥ W）或非正 W → 全窗口 [0,1]。
export function uvWindow(unclamped: number, clamped: number): { start: number; end: number } {
  if (unclamped <= 0 || clamped >= unclamped) return { start: 0, end: 1 };
  const start = (unclamped - clamped) / 2 / unclamped;
  return { start, end: 1 - start };
}

// 把 PlaneGeometry 的 UV 从 [0,1]² 线性**展开**映射到可见窗口外侧（每顶点
// UV' = (uv - start) / (end - start)）：start/end 是世界空间占比（见 uvWindow），
// 钳制轴时中间 [start, end] 世界区间与 RT [0,1] 一一对应（RT 像素与场景像素 1:1，
// M13），窗口外侧超出 [0,1] 的 UV 由采样器 CLAMP 到 0/1（three 纹理默认
// ClampToEdgeWrapping）——quad 左/下边采样 RT 左缘之前（CLAMP 0）、右/上边采样
// RT 右缘之后（CLAMP 1），世界中心不动点 1:1。I2 修复：旧实现 UV' = start +
// uv*(end-start) 把窗口当纹理占比收缩（角色用反），导致钳制轴可见段被拉伸铺满
// quad、内容放大 (W/C)² 且两侧各裁 ~15.2%。未钳制轴窗口 [0,1] 时 (uv-0)/1 = uv，
// 与旧式等价、精确 1:1（回归保护）。
function applyUvWindow(geometry: THREE.PlaneGeometry, ux: { start: number; end: number }, uy: { start: number; end: number }): void {
  const uvs = geometry.attributes.uv.array as Float32Array;
  const wx = ux.end - ux.start;
  const wy = uy.end - uy.start;
  for (let i = 0; i < uvs.length; i += 2) {
    uvs[i] = wx > 0 ? (uvs[i] - ux.start) / wx : uvs[i];
    uvs[i + 1] = wy > 0 ? (uvs[i + 1] - uy.start) / wy : uvs[i + 1];
  }
  geometry.attributes.uv.needsUpdate = true;
}

// 合成 quad 几何（T1.3）：世界尺寸 = 未钳制 size×scale 的**幅值**；UV 逐轴映射进对象
// RT 的可见窗口（rtW/rtH = 钳制后范围 = RT 像素 = 局部相机范围，M13 对齐：RT 像素与
// 场景像素 1:1）。
// T4.4：quad 帧尺寸必须取幅值——对象 RT 路径的镜像已由局部 mesh 的负 scale 渲染进 RT
// 内容（局部场景 = 对象忠实渲染），合成 quad 只是显示帧；帧几何若用负 worldH
// （PlaneGeometry 翻转顶点）会把 RT 内已镜像的内容二次翻转回正（镜像抵消，输出不镜像）。
// 即「相机范围与 quad 帧用幅值，镜像活在 mesh/RT 内容」的职责分离（task-4.4 报告）。
export function createCompositeGeometry(worldW: number, worldH: number, rtW: number, rtH: number): THREE.PlaneGeometry {
  const w = Math.abs(worldW);
  const h = Math.abs(worldH);
  const geometry = new THREE.PlaneGeometry(w, h);
  applyUvWindow(geometry, uvWindow(w, rtW), uvWindow(h, rtH));
  return geometry;
}

// 按「contain」语义计算正交相机范围：场景完整可见、不变形，多出的方向留白（透明）。
function containRange(width: number, height: number, viewAspect: number) {
  const sceneAspect = width / height;
  if (sceneAspect > viewAspect) {
    // 场景更宽 → 宽度铺满相机，垂直留白
    return { w: width, h: width / viewAspect };
  }
  // 场景更窄 → 高度铺满相机，水平留白
  return { w: height * viewAspect, h: height };
}

// 按「cover」语义计算正交相机范围：场景铺满视口、不变形，超出方向被裁剪。
function coverRange(width: number, height: number, viewAspect: number) {
  const sceneAspect = width / height;
  if (viewAspect > sceneAspect) {
    // 视口更宽 → 场景宽度铺满，垂直裁剪
    return { w: width, h: width / viewAspect };
  }
  // 视口更窄 → 场景高度铺满，水平裁剪
  return { w: height * viewAspect, h: height };
}

export function createSceneRenderer(
  fgCanvas: HTMLCanvasElement,
  bgCanvas?: HTMLCanvasElement,
  audioAnalyzer?: AudioAnalyzer | null,
): SceneRenderer {
  // 前景：contain 完整显示，透明清屏（透明边缘露出模糊背景）
  const renderer = new THREE.WebGLRenderer({ canvas: fgCanvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  camera.position.z = CAMERA_DISTANCE;

  // 场景渲染目标：离屏 RT（共享场景含对象级合成 quad），最终经全屏 quad 贴到 canvas
  const sceneRT = new THREE.WebGLRenderTarget(1, 1);
  // 贴屏相机：独立 NDC 正交相机（场景相机是 contain 范围，不能复用）
  const screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  screenCamera.position.z = CAMERA_DISTANCE;
  const screenScene = new THREE.Scene();
  // 贴屏 quad 必须 transparent：contain 留白区（场景未覆盖处）alpha 为 0，
  // 否则 OPAQUE 强制 alpha=1 → 黑边并完全遮挡 bg 模糊层（spec §3.1）
  const screenQuad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({ map: sceneRT.texture, transparent: true }),
  );
  screenQuad.frustumCulled = false;
  screenScene.add(screenQuad);

  // 背景（可选）：cover 铺满，作为模糊填充层（clearColor 由 setScene 设置）
  let bgRenderer: THREE.WebGLRenderer | null = null;
  let bgCamera: THREE.OrthographicCamera | null = null;
  if (bgCanvas) {
    bgRenderer = new THREE.WebGLRenderer({ canvas: bgCanvas, antialias: true, alpha: false });
    bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    bgCamera.position.z = CAMERA_DISTANCE;
  }

  let raf = 0;
  let running = false;
  let ortho: { width: number; height: number } = { width: 1920, height: 1080 };

  const clock = new THREE.Clock();
  const particleSystems: Array<{ system: ReturnType<typeof createParticleSystem>; points: THREE.Points }> = [];
  // T3.3 脚本内置模式条目：
  //   visualizerEntries — 每条 = 64 个共享几何/材质的音频条 + 锚点 y + 已解包属性；
  //   clockDrivers — 每时钟对象一个驱动（帧循环 update 刷新文本纹理）。
  const visualizerEntries: Array<{ bars: THREE.Mesh[]; anchorY: number; props: Record<string, unknown> }> = [];
  const clockDrivers: ClockTextDriver[] = [];
  // 对象级渲染条目：带效果 image/particle 对象渲染进各自独立 RT（局部正交相机，中心原点），
  // 效果链（T1.3/T1.4）在对象 RT 上执行，输出经合成 quad 贴回共享场景（世界坐标 = 对象中心、
  // 尺寸 = 未钳制 size×scale 或 distanceMax×scale、UV 只采样 RT 可见窗口）。无效果对象不走此
  // 路径（保持共享场景）。
  type ObjectEntry = {
    id: number;
    scene: THREE.Scene;                    // 局部场景（仅该对象 mesh）
    camera: THREE.OrthographicCamera;      // 局部相机（中心原点，范围 = RT 分辨率）
    rt: THREE.WebGLRenderTarget;           // 对象 RT（效果链输入 + 原始回退）
    quad: THREE.Mesh;                      // 共享场景中的合成 quad（map = 效果输出或 rt.texture）
    runner: EffectRunner | null;           // 该对象自己的效果执行器（T1.3，共享同一 renderer）
  };
  const objectEntries = new Map<number, ObjectEntry>();
  // 效果链异步挂载暂存（I1 竞态修复）：链解析与纹理加载并发，链可能先于条目就绪。
  // 条目缺失时暂存，setImageObject/addParticleSystem 创建条目后补挂（防对象级效果静默丢失）。
  const pendingChains = new PendingChainStore<{ chains: CompiledEffectChains | null; wallpaperId: string }>();
  // 对象效果链异步串行化（T1.3）：多个 runner 共享同一 renderer，promise 链保证同一时刻
  // 只有一个 runner 触碰 RT/绑定状态（并发交错破坏状态 → 黑屏/闪烁）。
  let objectChain: Promise<unknown> = Promise.resolve();

  function disposeObjectEntry(entry: ObjectEntry): void {
    scene.remove(entry.quad);
    entry.rt.dispose();
    entry.quad.geometry.dispose();
    (entry.quad.material as THREE.Material).dispose();
    entry.runner?.dispose();
  }

  // 给已创建条目挂载/替换效果链（空链 → 移除 runner，合成 quad 回退对象 RT 原始纹理）
  function applyObjectChains(objId: number, chains: CompiledEffectChains | null, wallpaperId: string): void {
    const entry = objectEntries.get(objId);
    if (!entry) return;
    if (!chains || chains.length === 0) {
      entry.runner?.dispose();
      entry.runner = null;
      return;
    }
    if (!entry.runner) {
      // 每带效果对象一个独立 runner（共享同一 renderer）；RT 尺寸 = 对象 RT 分辨率
      entry.runner = new EffectRunner(renderer, entry.rt.width, entry.rt.height);
    }
    entry.runner.setChains(chains, wallpaperId, { width: entry.rt.width, height: entry.rt.height });
  }

  // 对象级条目装配（T1.4 抽取，image/particle 双路径共用）：创建对象 RT + 局部相机
  // （范围 = 钳制后 RT 分辨率）+ 局部场景（容纳对象内容，内容保持 (0,0,0)——对象中心
  // 即局部原点）+ 合成 quad（世界尺寸 = 未钳制，UV 展开映射只采样 RT 可见段，初始
  // map = rt.texture，链就绪前显示原始对象）；按对象 id 替换注册（M14）；随后补挂
  // pendingChains 暂存链（I1 竞态修复）。行为与 T1.3/T1.4 原装配逐点一致。
  function createObjectEntry(
    objId: number,
    origin: [number, number, number],
    worldW: number,
    worldH: number,
    range: { w: number; h: number },
    content: THREE.Object3D,
  ): void {
    const rt = createObjectRenderTarget(range.w, range.h);
    const localCamera = new THREE.OrthographicCamera(
      -rt.width / 2, rt.width / 2, rt.height / 2, -rt.height / 2, -1000, 1000,
    );
    localCamera.position.z = CAMERA_DISTANCE;
    const localScene = new THREE.Scene();
    localScene.add(content); // content 保持 (0,0,0)：对象中心即局部原点
    // 合成 quad：世界尺寸 = 未钳制（钳制轴对象超出视锥部分在 RT 中不存在，由 UV 展开
    // 映射只采样 RT 可见段）；初始 map = rt.texture（链就绪前显示原始对象）。
    const quad = new THREE.Mesh(
      createCompositeGeometry(worldW, worldH, rt.width, rt.height),
      new THREE.MeshBasicMaterial({ map: rt.texture, transparent: true }),
    );
    quad.position.set(origin[0] - ortho.width / 2, origin[1] - ortho.height / 2, origin[2]);
    scene.add(quad);
    // 按对象 id 替换（M14）：同 id 重设时先清理旧条目（quad/RT/runner），避免残留
    const existing = objectEntries.get(objId);
    if (existing) disposeObjectEntry(existing);
    objectEntries.set(objId, { id: objId, scene: localScene, camera: localCamera, rt, quad, runner: null });
    // I1 竞态修复：链可能在条目创建前已解析完成（暂存）→ 创建后立即补挂，不丢失
    const pending = pendingChains.take(objId);
    if (pending) applyObjectChains(objId, pending.chains, pending.wallpaperId);
  }

  function frame() {
    // 音频频谱刷新（T3.2）：每帧先取一次频谱写入共享缓冲，runner 渲染前读同一引用
    // 注入音频 uniform；无分析器（audioAnalyzer null）→ 跳过，runner 保持全零（静音，不回归）。
    audioAnalyzer?.update();
    // T3.3 脚本内置模式刷新：visualizer 条高/锚定随频谱逐帧更新（无分析器 → freqData
    // null → 全零条高）；clock 文本每分钟至多重建一次纹理（见 ClockTextDriver.update）。
    const freqData = audioAnalyzer?.freqData ?? null;
    for (const v of visualizerEntries) updateVisualizerBars(v.bars, v.anchorY, v.props, freqData);
    for (const c of clockDrivers) c.update(new Date());
    const dt = Math.min(clock.getDelta(), 0.05);
    for (const ps of particleSystems) {
      ps.system.update(dt);
      ps.system.positions(); // 关键：update 只改内部粒子数组，必须再次同步到 positions 缓冲（否则每帧重传同一份全零数据）
      ps.points.geometry.attributes.position.needsUpdate = true;
      ps.points.geometry.attributes.aColor.needsUpdate = true;
      ps.points.geometry.attributes.aSize.needsUpdate = true;
      ps.points.geometry.attributes.aAlpha.needsUpdate = true;
      ps.points.geometry.setDrawRange(0, ps.system.count());
    }
    // 对象级渲染：带效果对象渲染进各自对象 RT（局部相机，中心原点）。
    for (const entry of objectEntries.values()) {
      renderer.setRenderTarget(entry.rt);
      renderer.render(entry.scene, entry.camera);
    }
    // 合成贴回：quad 采样效果链最近完成输出；链尚未就绪（编译/纹理加载中）回退对象 RT
    // 原始纹理（对象正常显示、无效果，不黑屏）。map 更新必须在共享场景渲染之前。
    for (const entry of objectEntries.values()) {
      (entry.quad.material as THREE.MeshBasicMaterial).map = entry.runner?.lastOutput() ?? entry.rt.texture;
    }
    // 场景渲染到离屏 RT（共享场景现含合成 quad → 效果输出已贴回场景）
    renderer.setRenderTarget(sceneRT);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    // 贴屏（T1.3 起无全屏效果链：直接贴场景 RT；对象级效果已在场景内）
    (screenQuad.material as THREE.MeshBasicMaterial).map = sceneRT.texture;
    renderer.render(screenScene, screenCamera);
    // 对象级效果链异步串行更新：promise 链保证同一时刻只有一个 runner 触碰 renderer
    // RT/绑定状态（并发交错 → 黑屏/闪烁）；每 runner 内部保留 updateInFlight 防重入，
    // 纹理槽缓存后稳态更新近乎同步。失败不阻断后续帧（catch 保持链存活）。
    for (const entry of objectEntries.values()) {
      const runner = entry.runner;
      if (!runner) continue;
      // 注入共享频谱缓冲引用（每帧同引用，update 时读当前频谱；null → 全零静音）
      runner.setAudioSpectrumSource(audioAnalyzer?.freqData ?? null);
      objectChain = objectChain
        .then(() => runner.update(clock.elapsedTime, entry.rt.texture))
        .catch((e) => console.warn('[wallpaper-engine] 对象效果链更新失败:', e));
    }
    // 背景层：cover 渲染对象级效果后的完整共享场景（含合成 quad）——bg 自身不跑效果链
    // （不二次叠加，只做模糊填充层）
    if (bgRenderer && bgCamera) bgRenderer.render(scene, bgCamera);
    if (running && fgCanvas.isConnected) raf = requestAnimationFrame(frame);
    else stop(); // canvas 被 controller 移除（切换壁纸）时自动终止 raf，防止泄漏
  }

  return {
    setScene(desc: SceneDescription) {
      scene.clear();
      scene.background = null; // 清掉上一场景残留背景（Task 8 minor）
      ortho = desc.orthogonal;
      const { width, height } = desc.orthogonal;
      const vw = Math.max(1, Math.round(window.innerWidth || width));
      const vh = Math.max(1, Math.round(window.innerHeight || height));
      const viewAspect = vw / vh;

      // 前景相机：contain（完整显示，边缘透明）
      const fg = containRange(width, height, viewAspect);
      camera.left = -fg.w / 2; camera.right = fg.w / 2;
      camera.top = fg.h / 2; camera.bottom = -fg.h / 2;
      camera.updateProjectionMatrix();
      renderer.setSize(vw, vh, false);
      sceneRT.setSize(vw, vh);

      // 背景相机：cover（铺满，作为模糊层）
      if (bgRenderer && bgCamera) {
        const bg = coverRange(width, height, viewAspect);
        bgCamera.left = -bg.w / 2; bgCamera.right = bg.w / 2;
        bgCamera.top = bg.h / 2; bgCamera.bottom = -bg.h / 2;
        bgCamera.updateProjectionMatrix();
        const cc = desc.clearColor;
        bgRenderer.setClearColor(cc ? new THREE.Color(cc[0], cc[1], cc[2]) : 0x111114, 1);
        bgRenderer.setSize(vw, vh, false);
      }
    },
    setImageObject(tex, obj) {
      // 平面几何尺寸：scene.json 对象 size（WE 像素）优先，缺省回退纹理宽高
      const tw = tex?.image?.width ?? 1;
      const th = tex?.image?.height ?? 1;
      const w = obj.size?.[0] ?? tw;
      const h = obj.size?.[1] ?? th;
      const geometry = new THREE.PlaneGeometry(w, h);
      const material = new THREE.MeshBasicMaterial({ map: tex ?? undefined, transparent: true });
      // T4.3：对象调制在**源渲染材质**上施加（color/alpha/brightness → color/opacity）。
      // 两条路径共用本 mesh：共享场景路径直接渲染；对象 RT 路径本 mesh 是 RT 的源
      // （对象局部场景内容），RT 已含调制 → 合成 quad 只采样效果输出/RT 纹理、不再
      // 二次调制（quad 材质保持默认白色 opacity 1，见 createObjectEntry）。
      const mod = materialModulation(obj.color, obj.alpha, obj.brightness);
      material.color.setRGB(mod.r, mod.g, mod.b);
      material.opacity = mod.a;
      const mesh = new THREE.Mesh(geometry, material);
      const s = obj.scale;
      mesh.scale.set(s[0], s[1], s[2] ?? 1);
      // T4.1：alignment 锚点 → 中心（世界尺寸 = 未缩放尺寸 × scale，场景像素）。锚点
      // 偏移同时作用于两条路径——对象 RT 路径（合成 quad 的世界位置）与共享场景路径
      // （mesh.position）；对象局部渲染内容保持 (0,0,0)（中心锚定，不重复偏移）。
      const worldW = w * s[0];
      const worldH = h * s[1];
      const center = applyAlignment(obj.origin, [worldW, worldH], obj.alignment);
      // 对象级效果链路径：带效果 image 对象渲染进独立对象 RT（局部正交相机，中心原点）。
      // 局部相机范围 = 取整后的 RT 分辨率（M13：RT 像素与场景像素 1:1，合成 UV 展开映射
      // 精确对应相机视锥，效果链 UV 0-1 与 mask 纹理对齐对象局部空间）。效果链在对象 RT
      // 上执行，输出经合成 quad 贴回共享场景（世界尺寸 = 未钳制 size×scale，UV 只采样可见段）。
      if (shouldUseObjectPath(obj)) {
        createObjectEntry(
          obj.id, center, worldW, worldH,
          objectCameraRange([w, h], [s[0], s[1]]),
          mesh,
        );
        return;
      }
      // 无效果对象：共享场景路径（对象中心是 WE 场景中的锚点换算中心：中心映射 = (cx - vw/2, cy - vh/2)。
      // 旧实现 `vh/2 - oy` 把非居中对象上下镜像（EVA 主图 oy=sh/2 恰好 0 故漏过），
      // 导致 Orange 少女部件被渲染到头顶（问题图漂浮现象）——2026-08-20 修正为不翻转。）
      mesh.position.set(center[0] - ortho.width / 2, center[1] - ortho.height / 2, center[2]);
      scene.add(mesh);
    },
    setTextObject(tex, obj) {
      // 与 setImageObject 共享场景路径一致：世界尺寸 = size × scale（size 缺省回退纹理
      // 宽高）；中心映射 (ox - vw/2, oy - vh/2)，y 不做翻转（WE 系左下原点 y 向上，
      // 见文件头坐标注释）。纹理为透明 canvas（文字区域外 alpha=0），material transparent。
      const tw = tex?.image?.width ?? 1;
      const th = tex?.image?.height ?? 1;
      const w = obj.size?.[0] ?? tw;
      const h = obj.size?.[1] ?? th;
      const geometry = new THREE.PlaneGeometry(w, h);
      const material = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
      const mesh = new THREE.Mesh(geometry, material);
      const s = obj.scale;
      mesh.scale.set(s[0], s[1], s[2] ?? 1);
      mesh.position.set(obj.origin[0] - ortho.width / 2, obj.origin[1] - ortho.height / 2, obj.origin[2]);
      scene.add(mesh);
    },
    setVisualizerObject(tex, obj) {
      // T3.3 visualizer（visible.script 识别）：渲染 64 条音频条，语义对齐 Simple
      // Visualizer 脚本——脚本每帧以 `scale.y = amt × scaleY`、`origin.x += originX`
      // 覆盖 64 条 layer 的变换。本实现：
      //   几何：1 条 PlaneGeometry(barWidth, 1) + 1 个 MeshBasicMaterial（共享 bar 纹理）
      //     复用给 64 个 mesh（每帧仅改 scale.y / position.y）；
      //   世界尺寸：宽 = barWidth（几何宽），高 = scale.y（脚本直赋，不经对象 scale——
      //     脚本每帧整体覆盖 scale，scene.json 的 scale 字段不参与）；
      //   位置：锚点 = 对象 origin 的中心映射（不翻转）；第 i 条 x = 锚点x + (i+1)×originX
      //     （脚本先 origin.x += originX 再赋给 bar：第 0 条即偏移一个 originX）；
      //   对齐：barAlignmentdir（bottom/centre/top）→ 中心锚定 y 偏移（barAnchorOffsetY）。
      // 始终走共享场景路径（visualizer 对象为脚本控制节点，不经过对象 RT/效果路径）。
      const props = obj.scriptProperties ?? {};
      const barWidth = Math.max(0.0001, toFiniteNum(props.barWidth, 1));
      const originX = toFiniteNum(props.originX, 10);
      const anchorX = obj.origin[0] - ortho.width / 2;
      const anchorY = obj.origin[1] - ortho.height / 2;
      const geometry = new THREE.PlaneGeometry(barWidth, 1);
      const material = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
      const bars: THREE.Mesh[] = [];
      for (let i = 0; i < VISUALIZER_BAR_COUNT; i++) {
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(anchorX + (i + 1) * originX, anchorY, obj.origin[2]);
        scene.add(mesh);
        bars.push(mesh);
      }
      visualizerEntries.push({ bars, anchorY, props });
    },
    setClockObject(obj) {
      // T3.3 clock（text.script 识别）：每帧按 scriptProperties 生成时间文本并刷新
      // 纹理（文本变化才重建，见 ClockTextDriver）。画布尺寸 = 对象 size（WE 像素，
      // 缺省按当前时间文本长度估算）；quad 尺寸/位置与静态文本一致（共享场景路径）。
      const props = obj.scriptProperties ?? {};
      const size = textCanvasSize(formatClockText(new Date(), props), obj.pointsize, obj.size);
      const geometry = new THREE.PlaneGeometry(size.w, size.h);
      const material = new THREE.MeshBasicMaterial({ transparent: true });
      const mesh = new THREE.Mesh(geometry, material);
      const s = obj.scale;
      mesh.scale.set(s[0], s[1], s[2] ?? 1);
      mesh.position.set(obj.origin[0] - ortho.width / 2, obj.origin[1] - ortho.height / 2, obj.origin[2]);
      scene.add(mesh);
      const driver = new ClockTextDriver(mesh, {
        font: obj.font,
        pointsize: obj.pointsize,
        color: obj.color,
        width: size.w,
        height: size.h,
      }, props);
      clockDrivers.push(driver);
    },
    addParticleSystem(spec, obj) {
      const system = createParticleSystem(spec.emitter, spec.init, { maxParticles: 2048 });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(system.positions(), 3));
      geometry.setAttribute('aColor', new THREE.BufferAttribute(system.colors(), 3));
      geometry.setAttribute('aSize', new THREE.BufferAttribute(system.sizes(), 1));
      geometry.setAttribute('aAlpha', new THREE.BufferAttribute(system.alphas(), 1));
      geometry.setDrawRange(0, 0);
      // 每粒子颜色（WE colorrandom，0-255 → 0-1）与尺寸（WE 场景像素）
      const material = new THREE.ShaderMaterial({
        vertexShader: `attribute vec3 aColor; attribute float aSize; attribute float aAlpha; varying vec3 vColor; varying float vLife;
          void main(){ vLife = aAlpha; vColor = aColor; vec4 mv = modelViewMatrix * vec4(position,1.0);
          gl_PointSize = aSize * (300.0 / -mv.z); gl_Position = projectionMatrix * mv; }`,
        fragmentShader: `varying vec3 vColor; varying float vLife; void main(){
          vec2 c = gl_PointCoord - 0.5; float d = length(c);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.0, d) * vLife;
          gl_FragColor = vec4(vColor, a); }`,
        transparent: true, depthWrite: false, depthTest: false,
        blending: THREE.AdditiveBlending,
      });
      const points = new THREE.Points(geometry, material);
      // 粒子模拟在 WE 系（y 向上）生成局部坐标：发射原点按中心映射平移（同图片对象，
      // 左下原点 y 向上 → 中心原点 y 向上，不翻转）；scale.y 不取负（旧实现取负是配合
      // 错误的 y 翻转，2026-08-20 修正——snowflat 速度 vy∈[-90,-50] 为向下运动即证据）。
      const s = obj.scale;
      points.scale.set(s[0], s[1] ?? s[0], s[2] ?? 1);
      // 对象级效果链路径（T1.4）：带效果粒子对象渲染进独立对象 RT（局部正交相机，中心
      // 原点）——机制与 setImageObject 完全一致（共用 createObjectEntry，无重复实现）。
      // 粒子对象无 size 字段，局部相机范围 = 发射器世界包围盒估计 distanceMax×scale
      // （无/零 distanceMax → 默认 64，见 particleObjectRange）；合成 quad 世界尺寸 =
      // 未钳制 distanceMax×scale，UV 展开映射只采样 RT 可见段。
      // T4.1：alignment 锚点 → 中心。粒子无 size 字段，世界尺寸用 particleWorldSize
      // 的发射距离×scale 估计（同合成 quad 世界尺寸基准）；无发射距离时对齐退化为
      // center（距离未知即无尺寸，alignment 无效果）。偏移同时作用于对象 RT 路径
      // （合成 quad 世界位置）与共享场景路径（points.position，即发射原点）。
      const world = particleWorldSize(spec.emitter, [s[0], s[1]]);
      const center = applyAlignment(obj.origin, [world.w, world.h], obj.alignment);
      if (shouldUseObjectPath(obj)) {
        const range = particleObjectRange(spec.emitter, [s[0], s[1]]);
        createObjectEntry(obj.id, center, world.w, world.h, range, points);
        // 粒子系统仍需进 particleSystems：帧循环 update + 缓冲同步后，动态发射的粒子
        // 写入对象 RT（entry.scene 渲染），再经合成 quad 贴回共享场景
        particleSystems.push({ system, points });
        return;
      }
      // 无效果粒子：共享场景路径（发射原点按锚点换算中心映射平移，不翻转）
      points.position.set(center[0] - ortho.width / 2, center[1] - ortho.height / 2, center[2]);
      scene.add(points);
      particleSystems.push({ system, points });
    },
    setObjectEffectChains(objId: number, chains: CompiledEffectChains | null, wallpaperId: string) {
      // I1 竞态修复：链解析与条目创建并发——条目缺失时暂存（不再静默丢弃），
      // setImageObject/addParticleSystem 创建条目后 take 补挂
      if (!pendingChains.applyIfReady(objId, { chains, wallpaperId }, objectEntries.has(objId))) return;
      applyObjectChains(objId, chains, wallpaperId);
    },
    start() {
      if (running) return;
      running = true;
      clock.start();
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      // 释放音频分析器（T3.2）：context.close() 释放 Web Audio 资源（重复 close 会
      // reject，静默吞掉；renderScene 异常兜底路径可能再次 close）
      audioAnalyzer?.context.close().catch(() => {});
      // 释放对象级条目：对象 RT、合成 quad 几何/材质、效果 runner（M15；换壁纸/停止必须回收）
      for (const entry of objectEntries.values()) disposeObjectEntry(entry);
      objectEntries.clear();
      pendingChains.clear(); // 条目最终未创建（纹理加载失败）的暂存链一并清理
      // 释放 clock 驱动当前纹理（visualizer 条与共享场景 quad 同既有路径：随 scene
      // 清理 + JS GC，纹理为 renderScene 传入的外部资源，所有权不在 renderer）
      for (const c of clockDrivers) c.dispose();
      clockDrivers.length = 0;
      visualizerEntries.length = 0;
      renderer.dispose();
      bgRenderer?.dispose();
    },
  };
}

// 材质引用 → tex 资源路径推导。
// WE 语义（全库实测验证）：material json 的 passes[0].textures[0] 是纹理槽位名，
//   不含 '/' → 材质同目录下同名 .tex（EVA 等常规布局）；
//   含 '/'   → 相对 materials/ 的路径（workshop 子目录纹理），拼 "materials/" + texName + ".tex"。
// 修复：旧实现直接 texName + ".tex"，丢失 materials/ 前缀，导致子目录纹理加载失败。
export function resolveTexPath(matRef: string, texName: string): string {
  return texName.includes('/')
    ? 'materials/' + texName + '.tex'
    : matRef.slice(0, matRef.lastIndexOf('/') + 1) + texName + '.tex';
}

// 图片对象纹理：obj.image 指向 models/xxx.json（材料引用），实际 .tex 需经
// 模型 json → material 字段 → materials/xxx.json → passes[0].textures[0] 推导。
async function resolveImageTexture(id: string, obj: SceneImageObject): Promise<THREE.Texture | null> {
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

// renderScene 可选参数（T4.2）：可见性 user 绑定的用户属性查询 getter 由调用方注入
// （renderScene 不硬依赖设置存储——node 可测；缺省 → 恒 undefined，user 绑定回退
// 绑定 value）。localStorage 实现见 settings.ts 的 getUserPropertyValue。
export interface RenderSceneOptions {
  getUserProperty?: (key: string) => unknown;
}

export async function renderScene(
  id: string,
  fgCanvas: HTMLCanvasElement,
  bgCanvas?: HTMLCanvasElement,
  opts?: RenderSceneOptions,
): Promise<boolean> {
  let renderer: SceneRenderer | null = null;
  // T3.2：音频频谱分析器生命周期 = 本壁纸场景渲染周期（createSceneRenderer 之前创建、
  // stop() 时 close 释放）。无 Web Audio → null，EffectRunner 保持全零静音（行为不变）。
  const analyzer = createAudioAnalyzer();
  const getUserProperty = opts?.getUserProperty ?? (() => undefined);
  try {
    const desc = await fetchSceneDescription(id);
    // T3.4：壁纸音频播放——scene.json 对象级 sound 数组（如 2937346640 id=35 的 flac）
    // 经场景资源路由取原始字节（/wallpapers/scene/<id>/asset 按 pkg 条目名原样返回，
    // 见 host/routes.ts，flac/mp3 均已验证），解码后接入频谱分析器
    // （source → analyser → destination，visualizer 条/频谱效果获得真实数据）。
    // fire-and-forget：失败静默（返回 false 不抛错），不阻断纹理/效果渲染；
    // autoplay 被拦时 context 保持 suspended（可视化条全零），用户手势后自动恢复
    // （见 playWallpaperSound / armGestureResume）。无分析器（无 Web Audio）→ 跳过。
    if (analyzer) {
      for (const s of desc.sounds ?? []) {
        void playWallpaperSound(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(s)}`, analyzer);
      }
    }
    renderer = createSceneRenderer(fgCanvas, bgCanvas, analyzer);
    renderer.setScene(desc);
    // T4.2 可见性解析（user/script 绑定）：先按 desc.objects 一次扫描收集所有
    // user 绑定引用的用户属性键（getter 查询 → userProps 表），再以
    // resolveVisibility 过滤出可见对象。不可见对象**整体跳过**——不渲染
    // （setImageObject/setTextObject/addParticleSystem 均不调用）、不挂效果链
    // （groupEffectsByObject 用过滤后列表）、不计入 rendered（全不可见 →
    // rendered===0 → preview 回退）。script 绑定保持 value（脚本求值超出本期范围）。
    const userProps: Record<string, unknown> = {};
    for (const obj of desc.objects) {
      const v = obj.visible;
      if (v?.kind === 'user' && v.key) userProps[v.key] = getUserProperty(v.key);
    }
    const visibleObjects = desc.objects.filter((o) => resolveVisibility(o, userProps));
    // 对象级效果链（T1.3）：按对象分组（替换旧全屏展平路径——Ruling 5 的全屏执行导致
    // foliagesway 等对象级效果整屏生效/摇晃）。每组在 renderer 内拥有独立 EffectRunner，
    // 链输入 = 对象 RT，输出合成回共享场景；无效果对象路径不变。
    // T4.2：仅对可见对象挂链（不可见对象不进入效果链解析/挂载）。
    const effectGroups = groupEffectsByObject(visibleObjects);
    // 异步加载效果链（失败链 → null 过滤；加载中画面保持原样）
    void (async () => {
      for (const group of effectGroups) {
        const chains: CompiledEffectChains = [];
        for (const fx of group.effects) {
          if (typeof (fx as { file?: unknown } | null)?.file !== 'string') continue;
          const chain = await resolveEffectChain(fx as { file: string; passes?: unknown[] }, async (name) => {
            return fetchWithRetry(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(name)}`);
          });
          if (chain) chains.push(chain);
          // spec §4.4：效果链解析失败 → console.warn（解析器静默返回 null，warn 职责在本层）
          else console.warn('[wallpaper-engine] 效果链解析失败，跳过:', (fx as { file?: unknown }).file);
        }
        renderer.setObjectEffectChains(group.obj.id, chains, id);
      }
    })();
    let rendered = 0;
    for (const obj of visibleObjects) {
      if (obj.kind === 'image') {
        // T3.3：visible.script 识别为 visualizer → 64 条音频条路径（纹理解析失败用
        // 1×1 白色 DataTexture 兜底——bar.tex 本体即纯白 4×4，纯色条不依赖纹理内容）；
        // 其余 image 对象维持原路径（纹理解析失败 → 跳过该对象）。
        if (obj.script && detectScriptPattern(obj.script) === 'visualizer') {
          let tex = await resolveImageTexture(id, obj);
          if (!tex) tex = createWhiteDataTexture();
          renderer.setVisualizerObject(tex, obj);
          rendered++;
          continue;
        }
        const tex = await resolveImageTexture(id, obj);
        if (!tex) continue; // 纹理缺失 → 跳过该对象（骨架注记：失败即跳过）
        renderer.setImageObject(tex, obj);
        rendered++;
      } else if (obj.kind === 'particle' && obj.particle) {
        const spec = await fetchParticleSpec(id, obj.particle);
        if (spec) {
          renderer.addParticleSystem(spec, obj);
          rendered++;
        }
      } else if (obj.kind === 'text') {
        // T3.3：text.script 识别为 clock → 动态时钟路径（每帧刷新时间文本纹理）；
        // 其余 text 对象维持 T3.1 静态路径（text.value 直用）。
        if (obj.script && detectScriptPattern(obj.script) === 'clock') {
          renderer.setClockObject(obj);
          rendered++;
          continue;
        }
        // T3.1 静态文本：text.value 直用（脚本动态文本见 T3.3）。画布尺寸 = 对象 size
        // （WE 像素，缺省由 textCanvasSize 按字号/文本长度估算）；纹理贴到共享场景 quad
        // （setTextObject 始终共享场景路径，不经过对象 RT/效果路径）。
        const size = textCanvasSize(obj.text, obj.pointsize, obj.size);
        const tex = createTextTexture(obj.text, {
          font: obj.font,
          pointsize: obj.pointsize,
          color: obj.color,
          width: size.w,
          height: size.h,
        });
        renderer.setTextObject(tex, obj);
        rendered++;
      }
      // kind === 'util'：WE 内置合成层/效果对象（models/util/*），一期跳过
      // （不 fetch、不计数；effects 效果链渲染属二期，见 shared/types.ts SceneUtilObject）
    }
    // 全部对象渲染失败 → 返回 false，让 controller 走 preview 回退（回退链接线）
    if (rendered === 0) {
      renderer.stop();
      return false;
    }
    renderer.start();
    return true;
  } catch {
    renderer?.stop();
    // renderer 未创建（createSceneRenderer 抛异常）时兜底释放分析器（stop() 已 close 则
    // 此处重复 close 会 reject，静默吞掉）
    analyzer?.context.close().catch(() => {});
    return false;
  }
}
