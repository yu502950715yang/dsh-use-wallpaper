// three.js 播放器（renderer + 正交相机 cover + RAF 循环）。
//
// 坐标 / cover 语义与 scene-renderer.ts 同源（不重写，避免双份语义漂移）：
//   - coverRange(sceneW, sceneH, viewAspect)：场景固有尺寸（WE 正交视口 view_w×view_h）按视口
//     宽高比 cover 裁剪得相机视锥；视口缺省与场景同尺寸时 cover == 场景尺寸（无裁剪）。
//   - CAMERA_DISTANCE：相机沿 +z 放置，使 shader 里 300/-mv.z = 1（点尺寸 = 像素尺寸）。
//   - 正交相机 y 轴不翻转（WE 左下原点 y 向上与 three 正交相机一致，见 scene-renderer 文件头）。
import * as THREE from 'three';
// 几何/尺寸纯函数唯一实现在 object-range.ts（coverRange 在其处，scene-renderer 只做转手）。
import { coverRange, CAMERA_DISTANCE, materialModulation, createCompositeGeometry, flipGeometryUvY, screenScalePx, effectScreenMatrix } from './object-range.js';
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
import { ParallaxRuntime } from './parallax-runtime.js';
import { SpriteSheetRuntime } from './sprite-sheet-runtime.js';
import { UtilContentRuntime } from './util-content-runtime.js';
import { VisualizerRuntime } from './visualizer-runtime.js';
import { createWhiteTexture, createLayerMaterial, createUtilLayerMaterial, createCompositeQuadMaterial, applyCompositeSampling } from './layer-material-factory.js';
import {
  PARTICLE_QUAD_CORNERS, PARTICLE_QUAD_INDEX, PARTICLE_VERTEX_SHADER, PARTICLE_FRAGMENT_SHADER,
  PARTICLE_FLOATS_PER_INSTANCE, particleCapacity, simEmitterOffset, textureTexelRatio, particlePerspMatrix,
  specMaxcount, specRenderer, specPerspective, specSparseEventSource, specEmitterOrigin, particlePerspectiveCamera,
  frameCountFromDims, textureFrameCount, textureSpriteInfo, textureFrameGrid,
} from './particle-assets.js';
import { attachIsolated } from './layer-factory.js';
import { addParticle, updateParticles } from './particle-layer-factory.js';
import {
  alignmentWorldOffset, updateBackgroundTransform, setBackgroundAnchorOffset, updateBackground, resizeBackground,
} from './background-layer-factory.js';
import { addBackground, addPuppet } from './background-assembly.js';
import type { BackgroundAssemblyHost } from './background-assembly.js';
import { FrameCaptureRuntime } from './frame-capture-runtime.js';
import type { IsolatedObject } from './layer-factory.js';
import type { UtilContentCover } from './util-content-runtime.js';
import type { ParallaxConfig, PointerState } from './parallax.js';
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
// 背景条目类型与状态更新已迁入 background-layer-factory.ts（审查 P0-9 阶段 2c-3）。
import type { BackgroundEntry, BackgroundLayerHost } from './background-layer-factory.js';

// 精灵表图层类型已迁入 sprite-sheet-runtime.ts（审查 P0-9 阶段 1）。

// 粒子图层类型与装配已迁入 particle-layer-factory.ts（审查 P0-9 阶段 2c-2b）。
import type { ParticleLayer, ParticleLayerHost, AddParticleOptions } from './particle-layer-factory.js';



// 粒子资产（常量/spec 纯函数/shader）已迁入 particle-assets.ts（审查 P0-9 阶段 2c-2 前置）。
export * from './particle-assets.js';



// 材质/混合/shader 工厂已迁入 layer-material-factory.ts（审查 P0-9 阶段 2c）。
export { colorBlendModeToThree } from './layer-material-factory.js';

// 对象隔离类型与装配已迁入 layer-factory.ts（审查 P0-9 阶段 2c-2）。
export type { IsolatedObject } from './layer-factory.js';

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

// util 内容输入类型已迁入 util-content-runtime.ts（审查 P0-9 阶段 2）。
export type { UtilContentCover } from './util-content-runtime.js';

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

  private lastTime = 0;
  private readonly frameCaptureRuntime: FrameCaptureRuntime;

  // 视差状态（配置/指针/插值）已迁入 parallax-runtime.ts（审查 P0-9 阶段 1）。
  private readonly parallax = new ParallaxRuntime();

  // 背景图层条目（按 addBackground 返回的 id 索引，供 update_background 引用）。
  private backgroundEntries = new Map<number, BackgroundEntry>();
  private nextBackgroundId = 0;
  // 时间线世界变换：scene 对象 id → 图层 id（backgroundEntries 的键）。只含可直渲的背景/puppet；
  // 粒子单独映射（只支持 origin 平移增量：粒子内容由 shader 定位，mesh 不能写绝对中心）。
  private readonly objectToBackground = new Map<number, number>();
  private readonly objectToParticle = new Map<number, ParticleLayer>();
  private readonly warnedTransformUnsupported = new Set<number>();
  // 精灵表图层（键 = scene.json 对象 id；仅 image 材质带 combos.spritesheet 且纹理有 TEXS 元数据时登记）。
  private readonly spriteSheets = new SpriteSheetRuntime();

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
  private readonly utilContents = new UtilContentRuntime();
  // 最近一次段边界拍下的整帧快照（渲染器每帧同步给 ObjectEffectStage 的快照槽门控）。
  private lastFrameSnapshot: THREE.Texture | null = null;
  // 可视化条运行时（SceneScript 64 条 + pixel-bars 家族）：已迁入 visualizer-runtime.ts（阶段 2）。
  private readonly visualizers: VisualizerRuntime;
  private readonly particleHost: ParticleLayerHost;
  private readonly backgroundHost: BackgroundLayerHost;
  private readonly backgroundAssemblyHost: BackgroundAssemblyHost;
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
    this.visualizers = new VisualizerRuntime({
      addBackground: (o) => this.addBackground(o),
      entryMesh: (id) => this.backgroundEntries.get(id)?.mesh,
    });
    const self = this;
    this.particleHost = {
      scene: this.scene,
      get sceneWidth() { return self.sceneWidth; },
      get sceneHeight() { return self.sceneHeight; },
      nextLayerId: () => self.nextParticleLayerId++,
      addLayer: (layer) => { self.particleLayers.set(layer.id, layer); },
      attachIsolated: (objectId, kind, content, worldW, worldH, size, position, quadAngles, colorBlendMode, renderOrder) =>
        self.attachIsolated(objectId, kind, content, worldW, worldH, size, position, quadAngles, colorBlendMode, renderOrder),
      isolatedQuad: (objectId) => self.isolated.get(objectId)?.quad,
      setDisplayObject: (objectId, shown) => { self.displayObjects.set(objectId, shown); },
      setObjectToParticle: (objectId, layer) => { self.objectToParticle.set(objectId, layer); },
      setRefractLayer: (objectId, layer) => { self.refractLayers.set(objectId, layer); },
      registerFrameConsumer: (objectId) => { self.registerFrameConsumer(objectId); },
      layers: () => self.particleLayers.values(),
    };
    this.backgroundHost = {
      get sceneWidth() { return self.sceneWidth; },
      get sceneHeight() { return self.sceneHeight; },
      entryById: (id) => self.backgroundEntries.get(id),
      backgroundIdOf: (objectId) => self.objectToBackground.get(objectId),
      particleOf: (objectId) => self.objectToParticle.get(objectId),
      isIsolated: (objectId) => self.isolated.has(objectId),
      hasPuppetLayer: (id) => self.puppetLayers.has(id),
      rebaseSpriteSheet: (id) => self.spriteSheets.rebaseForBackground(id),
      warnedUnsupportedTransform: self.warnedTransformUnsupported,
    };
    this.backgroundAssemblyHost = {
      scene: this.scene,
      nextBackgroundId: () => self.nextBackgroundId++,
      addEntry: (id, entry) => { self.backgroundEntries.set(id, entry); },
      attachIsolated: (objectId, kind, content, worldW, worldH, size, position, quadAngles, colorBlendMode, renderOrder, compositeOpacity, attachQuad, puppet) =>
        self.attachIsolated(objectId, kind, content, worldW, worldH, size, position, quadAngles, colorBlendMode, renderOrder, compositeOpacity, attachQuad, puppet),
      isolatedQuad: (objectId) => self.isolated.get(objectId)?.quad,
      setDisplayObject: (objectId, shown) => { self.displayObjects.set(objectId, shown); },
      setObjectToBackground: (objectId, id) => { self.objectToBackground.set(objectId, id); },
      registerSpriteSheet: (backgroundId, objectId, mesh, sprite) => { self.registerSpriteSheet(backgroundId, objectId, mesh, sprite); },
      registerUtilContent: (objectId, mesh, cx, cy) => { self.registerUtilContent(objectId, mesh, cx, cy); },
      setPuppetLayer: (id, layer) => { self.puppetLayers.set(id, layer); },
    };
    this.frameCaptureRuntime = new FrameCaptureRuntime(this.renderer);
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
      applyCompositeSampling(entry.rt, entry.worldW, entry.worldH, this.screenScalePx());
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

  // 对象效果链的 `g_EffectModelViewProjectionMatrix`（pass NDC → 画布 NDC，见 object-range.effectScreenMatrix）：
  // 对象效果链的 `_rt_FullFrameBuffer` 消费点用它把对象窗口坐标换算成整帧快照的屏幕 UV。
  // 无隔离条目（端口未挂链/已释放）→ null（runner 保持单位阵）。
  effectScreenMatrix(objectId: number): THREE.Matrix4 | null {
    const iso = this.isolated.get(objectId);
    if (!iso) return null;
    const q = iso.quad;
    return effectScreenMatrix({
      worldW: iso.worldW,
      worldH: iso.worldH,
      position: { x: q.position.x, y: q.position.y },
      angles: [q.rotation.x, q.rotation.y, q.rotation.z],
      sceneW: this.sceneWidth,
      sceneH: this.sceneHeight,
      viewW: this.viewWidth,
      viewH: this.viewHeight,
      dpr: this.pixelRatio,
    });
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
            for (const [objectId, bgId] of this.objectToBackground) {
              if (bgId === id) this.objectToBackground.delete(objectId);
            }
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
  // 精灵表动画实现已迁入 sprite-sheet-runtime.ts（审查 P0-9 阶段 1）。
  private registerSpriteSheet(
    backgroundId: number,
    objectId: number,
    mesh: THREE.Mesh,
    sprite: { frames: number; cols: number; rows: number; frametime?: number },
  ): void {
    this.spriteSheets.register(backgroundId, objectId, mesh, sprite);
  }

  private updateSpriteSheets(dt: number): void {
    this.spriteSheets.update(dt);
  }

  pauseSpriteSheet(objectId: number): void { this.spriteSheets.pause(objectId); }
  playSpriteSheet(objectId: number): void { this.spriteSheets.play(objectId); }
  stopSpriteSheet(objectId: number): void { this.spriteSheets.stop(objectId); }
  isSpriteSheetPlaying(objectId: number): boolean { return this.spriteSheets.isPlaying(objectId); }
  setSpriteSheetFrame(objectId: number, frame: number): void { this.spriteSheets.setFrame(objectId, frame); }
  getSpriteSheetFrame(objectId: number): number { return this.spriteSheets.getFrame(objectId); }
  /** 测试用：取精灵表图层当前帧的 UV 子矩形（仅测试/诊断观测，不参与渲染）。 */
  spritesheetUvForTest(objectId: number): { u0: number; v0: number; u1: number; v1: number } | null {
    return this.spriteSheets.uvForTest(objectId);
  }

  /** 相机视差配置（null = 未启用/已拆除 ⇒ 逐帧零成本早退；enabled=false 时下一帧把对象写回基准位置）。 */
  setParallax(cfg: ParallaxConfig | null): void {
    this.parallax.setConfig(cfg);
  }

  /** 宿主指针监听的最新归一化位置（[0,1]）；插值在 ParallaxRuntime 内按 dt 推进。 */
  setParallaxPointer(p: PointerState): void {
    this.parallax.setPointer(p);
  }

  /** 视差跟随的当前指针（插值后，[0,1] y 向下）：效果 shader 全局 uniform 的来源。 */
  parallaxPointer(): PointerState {
    return this.parallax.pointer();
  }

  /** 测试用：取某背景条目的 three 对象（隔离对象返回合成 quad）。 */
  backgroundMeshForTest(id: number): THREE.Object3D {
    return this.backgroundEntries.get(id)!.parallaxNode;
  }

  /** 测试用：直接推进一帧视差。 */
  tickParallaxForTest(dt: number): void {
    this.tickParallax(dt);
  }

  // 逐帧视差推进（实现与语义注释见 parallax-runtime.ts 的 tick）。
  private tickParallax(dt: number): void {
    this.parallax.tick(dt, {
      sceneWidth: this.sceneWidth,
      sceneHeight: this.sceneHeight,
      backgrounds: this.backgroundEntries.values(),
      particles: this.particleLayers.values(),
    });
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
    this.frameCaptureRuntime.flush();
    // 链推进是异步串行的（纹理槽可能仍在加载），不阻塞本帧；本帧贴的是上一帧输出。
    this.objectEffectStage?.advance(this.elapsedSeconds());
  }

  /** 把当前帧抓成 PNG（读像素实现见 frame-capture-runtime.ts；null = 不支持/失败）。 */
  captureNextFrame(): Promise<Uint8Array | null> {
    return this.frameCaptureRuntime.nextFrame();
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

  /**
   * 时间线动画：按 scene 对象 id 写入**世界变换**。
   * 支持非隔离背景/puppet（mesh TRS）与非隔离粒子的 origin 平移增量（粒子内容由 shader 定位，
   * 写绝对中心会双重平移）；隔离对象（对象级效果链的合成 quad）暂不支持 → false + 告警一次。
   */
  /**
   * 时间线动画：按 scene 对象 id 写入**世界变换**（实现与语义见 background-layer-factory.ts）。
   */
  updateBackgroundTransform(objectId: number, wt: {
    origin: [number, number, number];
    scale: [number, number, number];
    angles: [number, number, number];
  }): boolean {
    return updateBackgroundTransform(this.backgroundHost, objectId, wt);
  }

    /**
   * 刷新背景图层的锚点偏移（renderOffset = 渲染中心 − 对象锚点）。文本标题/字号变化后
   * 由 text driver 按新 layout 调用；只记偏移，位置由随后的 update_background / syncWorld 写入。
   */
  setBackgroundAnchorOffset(backgroundId: number, offset: [number, number]): boolean {
    return setBackgroundAnchorOffset(this.backgroundHost, backgroundId, offset);
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
    // puppet：效果链输出是**贴图空间**的结果（WE 语义，webwallgl drawPuppetDirect 的 overrideTex
    // 同口径）⇒ 直接换网格材质采样源，而不是贴合成 quad。输出 RT 与图片对象同一套 **WE v 约定**
    //（v=0=图像顶部），而 puppet 几何 uv 是显示约定（v=0=底部，见 puppet.ts 的 flipGeometryUvY）
    // ⇒ 采样处补一次垂直翻转（uvTransform），否则输出整体上下颠倒（图集会散架）。
    if (entry.puppet) {
      const mat = entry.puppet.mesh.material as THREE.MeshBasicMaterial;
      // 翻转挂在**纹理**上（每帧导出的 RT 纹理固定两种：runner 的 ping-pong RT），幂等设置。
      if (texture.repeat.y !== -1) {
        texture.repeat.set(1, -1);
        texture.offset.set(0, 1);
        texture.matrixAutoUpdate = true;
      }
      if (mat.map !== texture) {
        mat.map = texture;
        mat.needsUpdate = true;
      }
    }
    if (!entry.quadAttached) return;
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
    return this.visualizers.setBars(opts);
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
    return this.visualizers.setPixelBars(opts);
  }

  /** 每帧更新可视化条高度：freqData = 64 bin 频谱（0-255）；null = 无音频 → 全部归零。 */
  updateVisualizerBars(freqData: Uint8Array | null): void {
    this.visualizers.update(freqData);
  }

  // util 层内容 = 整帧快照（T3）：真实 util 链读 `bind: previous`（层内容），快照必须成为内容（solid 保留纯色）。
  // `opts.cover` = 快照在内容 mesh UV 空间的落点；UV 变换落在内容几何上（快照纹理共享，不能改 repeat/offset）。
  setUtilContentTexture(
    objectId: number,
    texture: THREE.Texture,
    opts: { cover?: UtilContentCover } = {},
  ): void {
    this.utilContents.setTexture(objectId, texture, opts);
  }

  /** 测试/诊断：util 内容当前纹理；solid / 非 util → null。 */
  utilContentTextureForTest(objectId: number): THREE.Texture | null {
    return this.utilContents.textureForTest(objectId);
  }

  /** 测试/诊断：util 内容当前的快照覆盖矩形（内容 mesh UV 空间）。 */
  utilContentUvForTest(objectId: number): UtilContentCover | null {
    return this.utilContents.uvForTest(objectId);
  }

  /** 最近一次段边界快照（渲染器每帧同步给 ObjectEffectStage 的 `_rt_FullFrameBuffer` 槽门控）。 */
  currentFrameSnapshot(): THREE.Texture | null {
    return this.lastFrameSnapshot;
  }

  // 登记 util 内容条目（内容 mesh 与快照内容区域的世界锚点）；solid 不登记（纯色内容不被替换）。
  private registerUtilContent(objectId: number, mesh: THREE.Mesh, centerX: number, centerY: number): void {
    this.utilContents.register(objectId, mesh, centerX, centerY);
  }

  // 快照覆盖矩形（算法与注释见 util-content-runtime.ts 的 coverFor）。
  private utilContentCoverFor(objectId: number): UtilContentCover | null {
    return this.utilContents.coverFor(objectId, {
      sceneWidth: this.sceneWidth,
      sceneHeight: this.sceneHeight,
      viewWidth: this.viewWidth,
      viewHeight: this.viewHeight,
    });
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
    applyCompositeSampling(entry.rt, entry.worldW, entry.worldH, this.screenScalePx());
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
    // color 来自 `{user|script,value}` 绑定（WE 运行期动态驱动；我们只有静态默认值）：
    // colorBlendMode ≠ 0 时跳过 tint，保留内容原色（见 addBackground 的调制注释）。
    colorUserBound?: boolean;
    // 对象 alignment（WE 9 值）：origin 是锚点，内容 mesh / 合成 quad 中心按锚点偏移（F13）。
    alignment?: string;
    sceneW: number;
    sceneH: number;
    // scene.json 的**对象 id**（脚本图层桥的键）：本字段**总是传**（非隔离对象也要能被脚本按
    // 对象 id 找到），与只在隔离时传的 isolate.objectId 区分。
    objectId?: number;
    // 时间线世界变换的锚点 origin（缺省 = origin）。text 的 origin 已含 anchorOffset，这里传
    // 未偏移的对象原点是给 updateBackgroundTransform 回推偏移用；image/util 不传。
    transformOrigin?: [number, number, number];
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
    // 动态 color 禁用（text 图层）：静态色已烘进纹理，脚本/时间线 color 不再乘材质（AGENT §7.44）。
    disableDynamicColor?: boolean;
  }): number {
    return addBackground(this.backgroundAssemblyHost, opts);
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
    // 对象贴图（= 建 puppet 材质时的 map）：效果链在**贴图空间**跑，隔离内容就是这张贴图的平面。
    texture?: THREE.Texture | null;
    // 对象隔离（对象级效果链）：字段与 addBackground 的 isolate 相同（见其注释）。
    isolate?: { objectId: number; rtWidth: number; rtHeight: number; worldW: number; worldH: number };
  }): number {
    return addPuppet(this.backgroundAssemblyHost, opts);
  }

  // 图层材质（**内容**材质）：colorBlendMode 已实现（6/7/31）→ 预乘 ShaderMaterial +
  // CustomBlending（复刻 WE 的 ApplyBlending）；否则 MeshBasicMaterial（普通 alpha 混合）。
  // 隔离对象的合成 quad **不**用它，而用 createCompositeQuadMaterial（见该方法注释）。
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
    kind: 'background' | 'particle' | 'puppet',
    content: THREE.Object3D,
    worldW: number,
    worldH: number,
    size: { width: number; height: number },
    position: { x: number; y: number; z: number },
    quadAngles: [number, number, number],
    colorBlendMode: number,
    renderOrder?: number,
    compositeOpacity = 1,
    attachQuad = true,
    puppet?: PuppetInstance,
  ): void {
    attachIsolated(
      {
        sceneWidth: this.sceneWidth,
        sceneHeight: this.sceneHeight,
        screenScale: this.screenScalePx(),
        scene: this.scene,
        isolated: this.isolated,
      },
      {
        objectId, kind, content, worldW, worldH, size, position, quadAngles, colorBlendMode,
        renderOrder, compositeOpacity, attachQuad, puppet,
      },
    );
  }

  // 更新背景图层状态，对齐既有 update_image 语义——undefined = 保持现状；与当前状态相等的字段跳过；
  // 未知 id → no-op。origin 是 WE 场景坐标，中心化后写承载位置的 node（隔离 = 合成 quad，内容 mesh 在 RT 内恒 0）。
  // 更新背景图层状态（实现与语义见 background-layer-factory.ts 的 updateBackground）。
  update_background(
    id: number,
    origin?: [number, number, number],
    scale?: [number, number, number],
    alpha?: number,
    brightness?: number,
  ): void {
    updateBackground(this.backgroundHost, id, origin, scale, alpha, brightness);
  }

  // 文本图层 resize：按新画布尺寸重建 quad 几何（PlaneGeometry 尺寸不可变），scale 不变 ⇒
  // 世界尺寸 = 新尺寸 × scale。未知 id / 尺寸未变 → no-op。
  // ⚠️ 画布纹理必须 dispose：three r170 在 WebGL2 用**不可变** texStorage2D，画布尺寸变了以后
  // texSubImage2D 越界、上传被 GL 静默丢弃 ⇒ 屏幕上仍是旧画布被拉伸；dispose 后才按新尺寸分配存储。
  // 文本图层 resize（实现与语义见 background-layer-factory.ts 的 resizeBackground）。
  resizeBackground(id: number, size: [number, number]): void {
    resizeBackground(this.backgroundHost, id, size);
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
    return addParticle(this.particleHost, simVerticesGetter, opts);
  }


  // 每帧刷新所有粒子图层：调用各自的 `simVerticesGetter()` 取当前顶点并写回 BufferAttribute。
  // `dt` 用于诊断日志（证明帧循环真的在跑、dt 是真实帧间隔且 >0）。
  updateParticles(dt: number): void {
    updateParticles(this.particleHost, dt);
  }

    // 停止循环并释放 renderer 资源。
  dispose(): void {
    // 未决抓帧请求随播放器释放一并作废（否则 Promise 永不 settle）。
    this.frameCaptureRuntime.dispose();
    this.renderer.setAnimationLoop(null);
    // 释放背景图层几何/材质（texture 所有权通常在外，随 scene 清理，不在此 dispose）。
    for (const entry of this.backgroundEntries.values()) {
      entry.mesh.geometry.dispose();
      (entry.mesh.material as THREE.Material).dispose();
    }
    this.backgroundEntries.clear();
    // 精灵表图层只持有 mesh 引用，随背景释放一并失效。
    this.spriteSheets.clear();
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
    this.objectToBackground.clear();
    this.objectToParticle.clear();
    this.warnedTransformUnsupported.clear();
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
          // 对象级效果链（we 的 puppet 效果在贴图空间跑，输出当贴图）：贴图 + 隔离尺寸透传。
          texture: assets.backgroundTextures?.get(obj.id) ?? null,
          isolate: assets.isolate?.get(obj.id),
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
        // color 是否 {user,value} 绑定（cb≠0 时据此决定是否烘 tint，见 addBackground）。
        colorUserBound: obj.colorUserBound,
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
        // 时间线世界变换按对象锚点下发：把未含 anchorOffset 的 t.origin 也带上，写回时补偏移。
        transformOrigin: [t.origin[0], t.origin[1], t.origin[2]],
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
        // text 的静态色已烘进 canvas：脚本/时间线 color 不应用（AGENT §7.44）。
        disableDynamicColor: true,
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
      // 锚点偏移随文本宽度变化：先写回条目，否则下一帧 syncWorld 用装配期偏移（空文本 = 0）
      // 覆盖位置，换标题持续半宽错位。
      player.setBackgroundAnchorOffset(t.backgroundId, off);
      player.update_background(t.backgroundId, [o[0] + off[0], o[1] + off[1], o[2]]);
      player.resizeBackground(t.backgroundId, [layout.width, layout.height]);
    }
  });

  return { player, sims, backgroundIds, particleLayers, puppetLayers };
}
