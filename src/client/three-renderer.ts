// three.js 播放器生产入口：实现 `SceneRendererLike` 供 wallpaper-controller 使用（2026-09-22 起是 scene 的唯一渲染路径）。
// 粒子模拟复用 wasm 的纯 CPU 模拟器，无需 WebGPU。
import type { Material, Texture, WebGLRenderer } from 'three';
import { loadSceneToThree, resolvePixelRatio, type LoadedParticleAssets, type ParticleSim, type SceneAssets, type ThreeSceneLoadResult } from './threejs-player.js';
import { parseSceneJson, sceneJsonWithResolvedModulation } from './scene-json.js';
import { resolveWorldTransforms, type WorldTransform } from './scene-graph.js';
import { resolveImageAssets, fetchMdlBytes, resolveTexPath, resolveParticleMaterial } from './scene-assets.js';
// puppet（.mdl）→ three 网格/蒙皮：解析、网格装配与材质都在这里接线（SceneAssets.puppetMeshes）。
import { parseMdl } from './mdl-parser.js';
import { createPuppetMaterial, createPuppetMesh, type PuppetInstance } from './puppet.js';
import { loadTexTexture } from './tex-loader.js';
import { defaultLoadWasm } from './wasm-loader.js';
import type { LoadWasm, WasmSceneModule } from './wasm-loader.js';
import type { SceneRendererLike } from './wallpaper-controller.js';
import type { ObjectScriptProperty, SceneDescription, SceneImageObject, SceneSoundObject, SceneUtilObject } from '../shared/types.js';
import {
  fitIsolatedBudget, groupEffectsByObject, isolatedRtSize, objectRtSize, particleWorldSize,
  screenScalePx, sourcePixelsFromTexture, textWorldSize, utilWorldSize,
} from './object-range.js';
import { ObjectEffectStage } from './object-effects.js';
import { createGlowStage, type GlowStage } from './glow-stage.js';
import { createBloomStage } from './bloom-stage.js';
// 帧内快照：段渲染目标 + 消费者边界快照；按创建它的 renderer 复用，renderer 变化时换绑。
import { createFrameCapture, type FrameCapture } from './frame-capture.js';
import { readClientSettings, getUserPropertyValue } from './settings.js';
import { fetchWallpaperProperties } from './wallpaper-properties.js';
import { resolveEffectChain, type CompiledEffectPass } from './shader/effect-chain.js';
import { createTextTexture, measureTextLayout, textLayerOffset, createClockDriver, createScriptDriver } from './text-object.js';
import type { ClockDriver } from './text-object.js';
import { getTextScriptRuntime } from './text-script.js';
import type { TextScriptBinding, TextScriptRuntime } from './text-script.js';
import { detectScriptPattern, detectVisualizerFamily, computePixelBarLayout, formatClockText, type PixelBarLayout } from './script-patterns.js';
import { computeEffectiveVisibility } from './visibility.js';
import { parseUserRef, propertyConditionMet, resolveSceneUserBindings } from './user-bindings.js';
import { createAudioAnalyzer, playWallpaperSound, type AudioAnalyzer, type PlaybackHandle } from './audio-input.js';
import { startSystemAudioCapture, type SystemAudioCapture, type SystemAudioFailure } from './system-audio.js';
import { SceneScriptHost } from './scene-script-host.js';
import { applyLayerState } from './layer-state.js';
import { DynamicMeshRegistry } from './dynamic-mesh.js';
import { createMeshMaterial, parseMeshMaterial } from './mesh-material.js';
import { createRenderHealthStore, isHardFailure } from './render-health.js';
import type { HardFailureKind, HealthSnapshot, RenderHealthStore, SoftFailureKind } from './render-health.js';
// 指针输入（相机视差的宿主侧）：归一化 [0,1] + 幂等装/卸。
import { createPointerTracker } from './pointer-input.js';
import { effectPointerUniforms } from './parallax.js';

// wasm `CpuParticleSim` 的构造器形态（wasm-bindgen 静态 `new`；`ParticleSim` 接口见 threejs-player.ts）。
type CpuParticleSimLike = {
  new: (
    json: string,
    origin: Float32Array,
    sceneW: number,
    sceneH: number,
    overrideJson: string,
  ) => ParticleSim;
};

type ThreeWasmModule = WasmSceneModule & { CpuParticleSim?: CpuParticleSimLike };

// 去重告警（同一 key 只打印一次，防刷屏）。⚠️ 生命周期 = 当前壁纸：render() 开头清空一次，避免跨壁纸累积而漏报。
const warnedKeys = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(`[wallpaper-engine] ${message}`);
}

// 最近一次 render 计算出的世界变换表（只读，供测试断言接线；生产不消费）。
let lastWorldTransforms: Map<number, WorldTransform> | null = null;
export function lastWorldTransformOf(id: number): WorldTransform | null {
  return lastWorldTransforms?.get(id) ?? null;
}

// 订阅者异常只告警一次（模块级 once）：完全静默会让面板的 UI bug 不可见，每次刷屏又没用。
let subscriberWarned = false;

// WE 字体（pkg 内 otf/ttf）经 FontFace 加载后按家族名绘制；失败或环境不支持（jsdom 无 FontFace）→ 回退系统 sans-serif。
// 按「壁纸 id + 字体路径」缓存：同一壁纸的多个 text 对象共用一次加载。
const FONT_CACHE = new Map<string, Promise<string | null>>();
let fontSeq = 0;
async function loadWallpaperFont(wallpaperId: string, font: string | undefined): Promise<string | undefined> {
  if (typeof font !== 'string' || !font) return undefined;
  // `systemfont_<family>` 是 WE 的**宿主系统字体别名**，永远不会在 pkg / 引擎 assets 目录里：直接交给
  // resolveFontFamily 映射 CSS 家族，省一次必然落空的请求。必须按 **basename** 判 —— scene.json 里也存在
  // `fonts/systemfont_arial` 这种带目录前缀的写法（OWE SceneTextObjectParser.cpp:290-292），按全路径判会去加载文件、失败后落 sans-serif。
  const base = font.split('/').pop() ?? font;
  if (base.toLowerCase().startsWith('systemfont_')) return undefined;
  if (!/\.(otf|ttf|ttc|woff2?)$/i.test(font)) return undefined; // 家族名直接用
  if (typeof FontFace === 'undefined' || typeof document === 'undefined' || !document.fonts) return undefined;
  const key = `${wallpaperId}:${font}`;
  let pending = FONT_CACHE.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const r = await fetch(`/wallpapers/scene/${wallpaperId}/asset?name=${encodeURIComponent(font)}`);
        if (!r.ok) return null;
        const family = `we-font-${++fontSeq}`;
        const face = new FontFace(family, await r.arrayBuffer());
        await face.load();
        document.fonts.add(face);
        return family;
      } catch {
        return null; // 字体取不到/非法 → 上层回退默认字体（不阻断渲染）
      }
    })();
    FONT_CACHE.set(key, pending);
  }
  return (await pending) ?? undefined;
}

// 粒子混合模式：**优先读材质 json 的 `passes[0].blending`**（WE 权威字段），缺失时才回退按材质名启发式
//（对齐 wasm `BlendMode::from_material`）。
//
// ⚠️ 按路径名启发式会静默失效：WE 的辉光语义写在**材质 json 的 `blending` 字段**里，而**路径名里通常没有**
// 相应字样 —— additive 材质的粒子会走 alpha 混合，其纹理（如 `particle/chromaticdot`：alpha 全 255、形状写在 rgb）
// 画成**不透明黑方块**（DK WOTLK 满屏黑色小方块的根因），被画成方块噪声而非辉光。
export function particleBlend(
  blending: string | null | undefined,
  specText: string,
): 'additive' | 'alpha' {
  if (typeof blending === 'string' && blending) {
    // WE 枚举：add / additive 为加算；alpha / translucent / normal / opaque 等为普通透明叠加。
    return /^(add|additive)$/i.test(blending.trim()) ? 'additive' : 'alpha';
  }
  // 材质 json 不可得（拉取失败/无 passes）→ 回退旧启发式（材质名含 lightshaft/glow/additive）。
  try {
    const spec = JSON.parse(specText) as { material?: unknown };
    const mat = spec.material;
    if (typeof mat === 'string' && /lightshaft|glow|additive/i.test(mat)) return 'additive';
  } catch {
    /* 解析失败 → alpha */
  }
  return 'alpha';
}

// 空粒子模拟器兜底：spec 解析失败（`CpuParticleSim.new` throw）时返回**零粒子**模拟器，
// 使 loadSceneToThree 不因单个坏 spec 整场失败（对齐「失败只丢单个对象」原则）。
function createEmptySim(): ParticleSim {
  return {
    update: () => {},
    vertices: () => new Float32Array(0),
    frame_count: () => 1,
    set_frame_count: () => {},
    particle_count: () => 0,
  };
}

// 递归收集 scene 内所有被 {user} 引用的属性键（渲染器无 project.json，只能从 scene 反推）。
// 绑定节点不再下钻（与 host 的 usedBy 扫描口径一致）。
function collectUserKeys(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectUserKeys(item, out);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const obj = node as Record<string, unknown>;
  const ref = parseUserRef(obj.user);
  if (ref) {
    out.add(ref.name);
    return;
  }
  for (const value of Object.values(obj)) collectUserKeys(value, out);
}

// 收集并解析「带效果对象」的链：按 scene.json objects 顺序，每对象保留自身 effects（不展平）。
// 解析失败的链过滤掉并 warn（该对象回退无效果显示，不黑屏）。
//
// ⚠️ 收链口径含 `models/util/*` 的 util 对象（合成层/全屏层）——它们不渲染 ⇒ 永远没有隔离条目；
// 调用方按「是否真的隔离成功」再过滤一次（见 render() 的挂链循环），本函数保持「解析与分类」单一职责。
// `loadFile` 内部是多次 await fetch，全部发生在**加载期**：帧内只写 uniform + 提交 pass，不建管线/不 fetch。
export async function collectObjectEffectChains(
  desc: SceneDescription,
  loadFile: (name: string) => Promise<Uint8Array | null>,
  // 静态隐藏判定（可选）：隐藏对象不参与渲染 ⇒ 也不解析它的链（省掉整条链的 fetch 与 runner）。
  // 缺省不过滤 → 既有调用/单测行为逐字不变。
  isHidden?: (obj: SceneDescription['objects'][number]) => boolean,
): Promise<Map<number, CompiledEffectPass[][]>> {
  const out = new Map<number, CompiledEffectPass[][]>();
  for (const group of groupEffectsByObject(desc.objects)) {
    if (isHidden?.(group.obj)) continue;
    const chains: CompiledEffectPass[][] = [];
    for (const fx of group.effects as Array<{ file?: string; passes?: unknown[]; visible?: boolean }>) {
      if (typeof fx?.file !== 'string') continue;
      // effect 级可见性：lwe CImage::setupPasses 对 visible=false 的 effect 整条跳过（正常内容，不告警）
      if (fx.visible === false) continue;
      const chain = await resolveEffectChain({ file: fx.file, passes: fx.passes }, loadFile);
      if (!chain) {
        console.warn('[wallpaper-engine] 效果链解析失败，跳过:', fx.file);
        continue;
      }
      chains.push(chain);
    }
    if (chains.length > 0) out.set(group.obj.id, chains);
  }
  return out;
}

// 收集本次装配要执行的 SceneScript（按 scene.json 的 objects 顺序）。
//
// ⚠️ 收集范围**不能**限定在「参与渲染的对象」：无 image/particle/text 字段的纯控制器对象会被
// parseSceneJson 归到空粒子兜底分支，只按媒体字段派生 script 会静默丢掉它们，画面就仍然不动。
// 脚本来源优先级：visible.script（可见性/视觉脚本）> objectScript（angles 等转换字段，对象级脚本）；
// objectScript 额外带 property（angles/origin/scale/color），供 VM 的 update(value) 契约写回。
export function collectScriptSources(
  desc: SceneDescription,
): Array<{
  objectId: number;
  source: string;
  scriptProperties?: Record<string, unknown>;
  property?: ObjectScriptProperty;
}> {
  const out: Array<{
    objectId: number;
    source: string;
    scriptProperties?: Record<string, unknown>;
    property?: ObjectScriptProperty;
  }> = [];
  for (const obj of desc.objects) {
    // `obj.script` 对 text 对象装的是 `text.script`，那类归既有的 text-script.ts 运行时
    // —— 在这里一并收会与 text 路径重复装载（多份 runtime 状态）。
    const visibleScript = obj.visible?.kind === 'script'
      ? (obj as { script?: unknown }).script
      : undefined;
    const fromVisible = typeof visibleScript === 'string' && visibleScript.length > 0;
    const source = fromVisible ? visibleScript : obj.objectScript;
    if (typeof source !== 'string' || source.length === 0) continue;
    const scriptProperties = fromVisible ? obj.visible?.scriptProperties : obj.objectScriptProperties;
    const property = fromVisible ? undefined : obj.objectScriptProperty;
    out.push({
      objectId: obj.id,
      source,
      ...(scriptProperties ? { scriptProperties } : {}),
      ...(property ? { property } : {}),
    });
  }
  return out;
}

// 创建 three.js 播放器场景渲染器（sceneRenderer 接口）。opts 两项可注入（测试），缺省用生产实现。
//
// 已知边界：粒子 quad 自旋按 WE `ComputeParticleTangents` 三轴欧拉旋转基向量；可见性统一走
// computeEffectiveVisibility（含对象形态 condition 与父链继承，script 绑定不在装载期定论）。
// loadSceneToThree 沿用「缺 spec/工厂则跳过该粒子对象」语义，绝不全屏失败。
export function createThreeSceneRenderer(opts?: {
  loadWasm?: LoadWasm;
  getTextScriptRuntime?: () => Promise<TextScriptRuntime | null>;
  // 看护存储：不传则自建一个（localStorage 可用时落盘）。注入点存在是为了单测不碰真实存储。
  healthStore?: RenderHealthStore;
}): SceneRendererLike {
  const loadWasm = opts?.loadWasm ?? defaultLoadWasm;
  const resolveTextScriptRuntime = opts?.getTextScriptRuntime ?? getTextScriptRuntime;
  // 模块加载缓存：同一 renderer 内多次 render 只加载/初始化一次 wasm（对齐 wasm-renderer）。
  let modulePromise: Promise<WasmSceneModule | null> | null = null;
  // 跨 render 持有本次装配的 three 播放器 + sim（供替换/dispose 释放）。
  let current: ThreeSceneLoadResult | null = null;
  // 本次装配的对象级效果链编排器（模块内闭包持有，供 window.resize 同步预算与 teardown 释放）。
  let currentStage: ObjectEffectStage | null = null;
  // 本次装配的应用级 Glow stage（同上：闭包持有，teardown 释放）。
  let currentGlow: GlowStage | null = null;
  // 本次装配的壁纸级 bloom stage（参数来自 scene.json general.bloom*，同上 teardown 释放）。
  let currentBloom: GlowStage | null = null;
  // 帧内快照：按**创建它的 renderer** 复用同一实例（换 canvas/renderer 必须换新实例，否则拍到旧画布）；
  // 每次装配开始 `reset()` 复位 active，否则换壁纸后会永久走段渲染路径。
  let frameCapture: FrameCapture | null = null;
  let frameCaptureRenderer: WebGLRenderer | null = null;
  // 应用级 Glow 的**运行期**下发值（面板改阈值/强度/开关）：非空即优先于设置的持久值。
  let glowOverride: { enabled?: boolean; threshold?: number; strength?: number } | null = null;
  // 最近一次装配时从设置读到的 Glow 值：运行期只改一项时，其余项以它为基准。
  let glowFromSettings: { enabled: boolean; threshold: number; strength: number } | null = null;
  // Glow stage 的尺寸基准 = 画布缓冲尺寸（运行期「打开」需要新建 stage 时用；resize 时同步）。
  let glowSize = { width: 1, height: 1 };
  // 省电与画质档位（跨 render 有效）：render 内读设置同步，装配时就地应用。
  let paused = false;
  let qualityScale = 1;
  // window.resize 监听：窗口尺寸变化时按新窗口比例重推 cover（对齐 wasm 窗口视口语义）。
  let onWindowResize: (() => void) | null = null;
  // 本次装配的背景纹理：teardown 时显式 dispose（视频的 `<video>`/Blob URL 清理挂在纹理 dispose 事件上，
  // renderer.dispose() 不会停解码）。见 AGENT.md §5.23。
  let currentTextures: Map<number, Texture> | null = null;
  // 本次装配的 text 脚本 binding（每个持 quickjs 堆 handle），teardown 必须逐个 dispose。
  let currentScriptBindings: TextScriptBinding[] = [];
  // 本次装配的 SceneScript 运行时（visible.script）：持有 quickjs ctx/handle，teardown 释放。
  let currentScriptHost: SceneScriptHost | null = null;
  // 本次装配的动态网格注册表（脚本 createModelData/createLayer 建的运行时 mesh），teardown 释放。
  let currentMeshRegistry: DynamicMeshRegistry | null = null;
  // canvas 上的点击监听（脚本的 cursorClick，触发脚本内的切换特效）。
  let scriptClick: (() => void) | null = null;
  let scriptClickTarget: HTMLCanvasElement | null = null;
  // ── 壁纸音效 ───────────────────────────────────────────────────────────────────
  // sound 对象 → playWallpaperSound → analyser；频谱每帧喂给效果链（Simple_Audio_Bars 等）。
  let currentAudio: {
    analyzer: AudioAnalyzer;
    id: string;
    sounds: SceneSoundObject[];
    handles: PlaybackHandle[];
  } | null = null;
  // 系统音频（v0.9 P1）：浏览器模式 getDisplayMedia 捕获；桌面 App 宿主禁用 → 失败开放。
  let currentSystemAudio: SystemAudioCapture | null = null;
  let systemAudioStarting = false;
  const stopSystemAudioCapture = () => {
    const cap = currentSystemAudio;
    currentSystemAudio = null;
    try { cap?.stop(); } catch { /* 收尾不抛 */ }
  };
  // 运行期音效开关（面板 soundEnabled）：null = 未下发 ⇒ 用装配期读到的设置值。
  let soundEnabledOverride: boolean | null = null;
  // 最近一次装配的音频规格：运行期重新打开时按它重播（不必重选壁纸）。
  let lastAudioSpec: { id: string; sounds: SceneSoundObject[] } | null = null;
  // 上下文丢失回调（由控制器注册：只有它知道当前壁纸的 preview 地址）。
  let contextLostHandler: ((id: string) => void) | null = null;
  // 本次装配的壁纸 id（闭包持有）：不往调用方的 canvas 写 `data-wp-id`（外部 DOM 副作用），
  // 也不再有「dataset 必须先于监听注册」的隐式次序依赖。
  let contextLostId: string | null = null;
  // 本次装配注册了 `webglcontextlost` 监听的 canvas：teardown 必须移除（跨壁纸/跨 canvas 不残留）。
  let contextLostCanvas: HTMLCanvasElement | null = null;
  // 「上下文在本次 render 进行中丢失」标记：onContextLost 置位、render 入口复位；长异步的 render
  // 靠它在每个 await 后作废自己，不把回退掀翻。
  let contextLost = false;

  // ── 渲染看护状态（Task 2）────────────────────────────────────────────────
  const health = opts?.healthStore ?? createRenderHealthStore();
  let currentHealthId = '';
  let healthHandler: ((s: HealthSnapshot) => void) | null = null;
  const publish = (snap: HealthSnapshot) => {
    if (!healthHandler) return;
    try { healthHandler(snap); } catch (e) {
      // 订阅者异常不得影响渲染，但首次必须留痕（否则 UI bug 彻底隐形）。
      if (!subscriberWarned) {
        subscriberWarned = true;
        console.warn('[wallpaper-engine] 健康订阅者抛错（同类异常不再重复告警）:', e instanceof Error ? e.message : String(e));
      }
    }
  };
  // id 由调用方按**本次 render 的作用域**传入：render 可重叠（controller 允许 select 竞态），
  // 用实例级 currentHealthId 会把被取代那次 render 的结论记到新壁纸键上。
  const fail = (id: string, kind: HardFailureKind | SoftFailureKind, detail: string) => {
    const hard = isHardFailure(kind);
    if (hard) health.recordHard(id, kind as HardFailureKind, detail);
    else health.recordSoft(id, kind as SoftFailureKind, detail);
    publish(health.snapshot(id));
  };
  const succeed = (id: string, assembleMs: number, firstFrameMs: number) => {
    health.recordOk(id, { assembleMs, firstFrameMs });
    publish(health.snapshot(id));
  };

  // 省电暂停音频：挂起 context 冻结解码路径，流式元素另需 pause/play（保留播放位置）。
  const applyAudioPause = (audio: NonNullable<typeof currentAudio>, value: boolean) => {
    if (value) {
      for (const handle of audio.handles) {
        try { handle.pause?.(); } catch { /* 单个失败不阻断其余 */ }
      }
      audio.analyzer.setSuspended(true);
    } else {
      audio.analyzer.setSuspended(false);
      for (const handle of audio.handles) {
        try { handle.resume?.(); } catch { /* 同上 */ }
      }
    }
  };

  const stopAudio = () => {
    const audio = currentAudio;
    currentAudio = null;
    if (!audio) return;
    // 先停各 sound（buffer source / <audio>），再 close context（不释放会累积到浏览器上限）
    for (const handle of audio.handles) {
      try { handle.stop(); } catch { /* 单个失败不阻断其余收尾 */ }
    }
    audio.handles.length = 0;
    void audio.analyzer.context.close().catch(() => {});
  };

  const startAudio = (id: string, sounds: SceneSoundObject[], enabled: boolean) => {
    if (!enabled || sounds.length === 0) return;
    const analyzer = createAudioAnalyzer();
    if (!analyzer) return; // 无 Web Audio → 静音回退（不阻断渲染）
    const audio = { analyzer, id, sounds, handles: [] as PlaybackHandle[] };
    currentAudio = audio;
    // 失败的 sound（404/解码失败）在 playWallpaperSound 内部静默降级，不影响其余与画面。
    for (const s of sounds) {
      // 每个 sound 对象选一首（OWE SoundParser：loop 从第一首起，random/single 随机起点）。
      const file = s.playbackmode === 'loop'
        ? s.files[0]
        : s.files[Math.floor(Math.random() * s.files.length)];
      void playWallpaperSound(
        `/wallpapers/scene/${id}/asset?name=${encodeURIComponent(file)}`,
        analyzer,
        { volume: s.volume, loop: s.playbackmode !== 'single' },
      ).then((handle) => {
        if (!handle) return;
        // 播放期间已被 stop/切壁纸 → 立即停掉迟到句柄，避免泄漏
        if (currentAudio !== audio) {
          try { handle.stop(); } catch { /* 已释放 */ }
          return;
        }
        audio.handles.push(handle);
        // 暂停期间迟到的句柄：立即挂起，避免最小化中突然出声
        if (paused) { try { handle.pause?.(); } catch { /* 已释放 */ } }
      }).catch(() => {});
    }
    if (paused) applyAudioPause(audio, true); // 装配期已在暂停态（最小化中换壁纸）：创建即挂起
  };

  // 上下文丢失（显存耗尽/驱动重置）→ 停播并交给上层换回该壁纸 preview（比留一块空白背景好）。
  // 一次性语义：只注册在本次装配的 canvas 上、`once` + teardown 移除 ⇒ 最多回调一次。
  const onContextLost = (e: Event) => {
    e.preventDefault();
    // 先作废仍在飞的 render：它若继续装好 player 并返回 true，控制器会把 preview 换回失效 canvas。
    contextLost = true;
    const id = contextLostId;
    // 硬失败只在这里记一次（事件驱动）：覆盖「装配进行中」与「装配完成、帧循环已跑起来后」两条路径；
    // abortIfContextLost 只管中止装配，不再记录（否则同一次丢失会被记两遍）。归属用监听所属的那次装配。
    fail(id ?? '', 'context-lost', 'webglcontextlost');
    try { teardown(); } catch { /* 释放失败不得掩盖回退 */ }
    // 先告警再早退：没有 id 也不得让上下文丢失完全静默（诊断上必须留痕）。
    if (!id) {
      console.warn('[wallpaper-engine] WebGL 上下文丢失，但无本次装配的壁纸 id，已停播（不回退 preview）');
      return;
    }
    console.warn(`[wallpaper-engine] WebGL 上下文丢失，已回退 preview（壁纸 ${id}）`);
    contextLostHandler?.(id);
  };

  const teardown = () => {
    if (onWindowResize) {
      window.removeEventListener('resize', onWindowResize);
      onWindowResize = null;
    }
    // 指针监听随本次装配一并卸掉（tracker 自身幂等，重复调用安全）——见 AGENT.md §5.43。
    pointer.dispose();
    // 上下文丢失监听随本次装配一起移除（否则切壁纸后旧 canvas 的丢失事件还会回调新状态）。
    if (contextLostCanvas) {
      contextLostCanvas.removeEventListener('webglcontextlost', onContextLost);
      contextLostCanvas = null;
    }
    contextLostId = null;
    // 顺序契约：先释放编排器（其 runner 持有对象 RT/材质），再释放播放器（player.dispose 会释放 renderer
    // 与隔离 RT）——反了会让 runner 的 dispose 触碰已释放的 GL 资源。
    currentStage?.dispose();
    currentStage = null;
    // Glow stage 持有自己的 RT/材质，同样要在 player.dispose（释放 renderer）之前释放。
    currentGlow?.dispose();
    currentGlow = null;
    currentBloom?.dispose();
    currentBloom = null;
    current?.player.dispose();
    for (const sim of current?.sims ?? []) sim.free?.();
    current = null;
    // 纹理放在播放器之后释放（GPU 侧已随 renderer.dispose 收口，再触发纹理自身的清理钩子）。
    for (const tex of currentTextures?.values() ?? []) tex.dispose();
    currentTextures = null;
    // 脚本 binding 独立于 GL 资源，但同样只在本次装配内有效（切壁纸不留 handle）；SceneScript 运行时同理。
    for (const b of currentScriptBindings) b.dispose();
    currentScriptBindings = [];

    if (scriptClickTarget && scriptClick) scriptClickTarget.removeEventListener('click', scriptClick);
    scriptClickTarget = null;
    scriptClick = null;
    currentScriptHost?.dispose();
    currentScriptHost = null;
    currentMeshRegistry?.dispose();
    currentMeshRegistry = null;
    // 壁纸音效随本次装配一起释放（AudioContext 不 close 会一路累积到浏览器上限）。
    stopAudio();
    // 系统音频捕获属于本渲染器实例：卸载/换渲染器时一并停止（用户可重新授权）。
    stopSystemAudioCapture();
  };
  // 失败出口一律收尾；收尾自身抛错不得改写已记下的失败原因（照 onContextLost 的写法）。
  const teardownQuietly = () => {
    try { teardown(); } catch { /* 收尾失败不掩盖失败原因 */ }
  };
  // 上下文已在本次 render 进行中丢失 ⇒ 作废本次装配：清理丢失后新建的残余对象，收尾与失败路径一致。
  const abortIfContextLost = () => {
    if (!contextLost) return false;
    // 记录点在 onContextLost（唯一一次事件）——本函数只负责中止装配。
    // 收尾失败不得掩盖 context-lost 结论（裸 teardown 抛错会被外层 catch 改写成 exception）。
    teardownQuietly();
    return true;
  };
  // 当前生效的 Glow 三值：运行期下发 > 装配时读到的设置（缺省交给 glow-stage 归一）。
  const effectiveGlow = () => ({
    enabled: glowOverride?.enabled ?? glowFromSettings?.enabled ?? true,
    threshold: glowOverride?.threshold ?? glowFromSettings?.threshold,
    strength: glowOverride?.strength ?? glowFromSettings?.strength,
  });
  // 运行期即时应用 Glow（面板改完立刻可见，不必重选壁纸）：已装配 → 就地改 uniform 或装卸 stage；
  // 未装配 → 只记状态，下次装配按新值生效。
  const applyGlowRuntime = () => {
    if (!current) return;
    const glow = effectiveGlow();
    if (!glow.enabled) {
      if (currentGlow) { currentGlow.dispose(); currentGlow = null; current.player.setGlowStage(null); }
      return;
    }
    // 已装配：只改两个 uniform（不重建 RT），拖动滑杆每帧调用也只是写两个 float。
    if (currentGlow) { currentGlow.setOptions({ threshold: glow.threshold, strength: glow.strength }); return; }
    currentGlow = createGlowStage(glowSize.width, glowSize.height, { threshold: glow.threshold, strength: glow.strength });
    current.player.setGlowStage(currentGlow);
  };
  // 当前窗口/视口尺寸（clamp ≥1，对齐 wasm-renderer 的 vw/vh 推导）。
  const viewportSize = () => ({
    width: Math.max(1, Math.round(window.innerWidth || 0)),
    height: Math.max(1, Math.round(window.innerHeight || 0)),
  });
  // 指针：整个 renderer 生命周期一个 tracker（幂等装/卸），每次 render 把最新值下发给 player。
  const pointer = createPointerTracker();
  return {
    async render(id, fg, _bg) {
      // 诊断去重集合的生命周期 = 当前壁纸：每次 render 清空，避免跨壁纸累积而漏报新壁纸的告警。
      warnedKeys.clear();
      // 新一次装配（新 canvas）重新开始：复位上一次的上下文丢失标记。
      contextLost = false;
      // 每次装配开始复位 active（消费者集合换了）——否则上一张壁纸的消费者会让新壁纸也永久走段渲染路径。
      frameCapture?.reset();
      // 看护归属：本次装配的壁纸 id。计时是**本次 render 的局部状态**（render 可重叠）：
      // 实例级共享会把被取代那次的起点算进本次的装配/首帧耗时。
      currentHealthId = id;
      const timer = { startedAt: performance.now(), firstFrameAt: -1 };
      // 装配耗时（本次 render 作用域）：装配出口记一次，首帧回填沿用它 —— 否则首帧慢时
      // 「首帧时刻 − 起始」会被当成装配耗时写回，面板显示装配 ≈ 首帧，夸大装配。
      let assembledMs = -1;
      try {
        // 替换/切壁纸前先释放上次播放器资源（首次渲染 no-op）。
        teardown();
        // 上下文丢失监听绑定在**本次装配的 canvas** 上（id 存入闭包 contextLostId，teardown 一并移除）。
        contextLostId = id;
        contextLostCanvas = fg;
        fg.addEventListener('webglcontextlost', onContextLost, { once: true });
        // `CpuParticleSim` 是纯 CPU（无需 WebGPU）；模块初始化失败 → 仍可渲染背景，仅跳过粒子。
        modulePromise ??= loadWasm();
        const mod = await modulePromise;
        if (abortIfContextLost()) return false;
        // 拉取场景描述并解析（与 wasm-renderer 共用 parseSceneJson，对象归类/正交尺寸一致）。
        let sceneJsonResp: Response;
        try {
          sceneJsonResp = await fetch(`/wallpapers/scene/${id}/asset?name=scene.json`);
        } catch (e) {
          // 网络/磁盘一时没供上 ⇒ 软失败（不落盘，冷却后自动重试一次）
          fail(id, 'load-error', e instanceof Error ? e.message : String(e));
          teardownQuietly();
          return false;
        }
        if (!sceneJsonResp.ok) {
          // 服务端明确回答「这份 scene.json 拿不到」⇒ 硬失败
          fail(id, 'scene-json', 'http ' + sceneJsonResp.status);
          teardownQuietly();
          return false;
        }
        const sceneJson = await sceneJsonResp.text();
        if (abortIfContextLost()) return false;
        const parsedDesc = parseSceneJson(sceneJson);
        // 用户属性表：localStorage override ?? host/project 默认值（spec §4.4）。键来自 scene 内
        // 所有 {user} 引用（不止 visible）；fetch 失败 → 空表（失败开放，不阻断渲染）。
        const userKeys = new Set<string>();
        collectUserKeys(JSON.parse(sceneJson) as unknown, userKeys);
        const propertiesResponse = await fetchWallpaperProperties(id);
        if (abortIfContextLost()) return false;
        const propertyDefs = propertiesResponse.properties;
        const defaults = new Map(propertyDefs.map((p) => [p.key, p.value]));
        const userProps: Record<string, unknown> = {};
        for (const key of userKeys) {
          const value = getUserPropertyValue(key, id) ?? defaults.get(key);
          if (value !== undefined) userProps[key] = value;
        }
        // 属性级 condition 不满足 ⇒ 属性不可用：删除键使下游回退作者 value（spec §4.1）。
        // 先按完整表求值再统一删，避免依赖 propertyDefs 的遍历顺序。
        const unavailable = propertyDefs
          .filter((def) => def.condition && !propertyConditionMet(def.condition, userProps))
          .map((def) => def.key);
        for (const key of unavailable) delete userProps[key];
        // 装配前统一 resolve：之后所有消费（worldTransforms/effects/instanceoverride/脚本）都用静态值。
        const desc = resolveSceneUserBindings(parsedDesc, userProps);
        // 前景 canvas 逻辑尺寸 = 视口（对齐 wasm-renderer 的 vw/vh；cover 相机按此裁剪）。
        const vw = Math.max(1, Math.round(window.innerWidth || desc.orthogonal.width));
        const vh = Math.max(1, Math.round(window.innerHeight || desc.orthogonal.height));
        fg.width = vw;
        fg.height = vh;
        // ── 场景树：折叠出每个对象的**世界变换** ────────────────────────────────────────
        // ⚠️ 位置：任何消费对象变换的动作之前（纹理/粒子/隔离尺寸/文本锚点）；世界值随 assets 下发给
        // loadSceneToThree，由它统一替换 obj.origin/scale/angles。
        const worldTransforms = resolveWorldTransforms(desc.objects);
        lastWorldTransforms = worldTransforms;
        for (const obj of desc.objects) {
          const wt = worldTransforms.get(obj.id);
          if (wt) {
            obj.origin = wt.origin;
            obj.scale = wt.scale;
            obj.angles = wt.angles;
          }
        }
        // ── 组装 SceneAssets：背景纹理 + 粒子条件 + 模拟器工厂 ──────────────────────────
        const backgroundTextures = new Map<number, Texture>();
        currentTextures = backgroundTextures; // teardown 负责 dispose（见 currentTextures 注释）
        // puppet 实例（对象 id → 网格）：所有权交给 player（addPuppet 后由 player.dispose 释放）。
        const puppetMeshes = new Map<number, PuppetInstance>();
        const particles = new Map<number, LoadedParticleAssets>();
        // 有效可见性 = 自身绑定（含 condition）&& 父链继承：装配期一次定论，供下列所有过滤点共用。
        const effectiveVisible = computeEffectiveVisibility(desc.objects, userProps);
        // 音频可视化（visualizer 脚本）对象：装配后由 player 代建 64 条 bar（脚本 init 的动态层）。
        const visualizerSpecs: Array<{
          family: 'simple' | 'pixel-bars';
          origin: [number, number, number];
          scale: [number, number, number];
          angles: [number, number, number];
          alignment?: string;
          texture?: Texture;
          props: Record<string, unknown>;
          renderOrder: number;
          layout?: PixelBarLayout;
          barTexture?: Texture;
          barPath?: string;
        }> = [];
        for (const obj of desc.objects) {
          // 装载期静态隐藏：布尔 / 用户属性（含 condition 与父链）在此定论；script 绑定不在装载期剔掉。
          if (effectiveVisible.get(obj.id) === false) continue;
          if (obj.kind === 'image') {
            // 图片对象资源（与 scene-renderer 同一套模型→材质→tex 推导）：纹理与 puppet 路径同源于一次
            // model json 拉取。
            const { texture, puppetPath } = await resolveImageAssets(id, obj);
            if (texture) backgroundTextures.set(obj.id, texture);
            // SceneScript 音频可视化（Simple Visualizer）：64 条 bar 由脚本 init 动态 createLayer 创建，
            // three 路径由 player 代建并按音频频谱更新（bar 贴图 = 对象自身 image 的白色 4×4 纹理）。
            // 音频可视化（visualizer 脚本）：v0.9 起区分家族（Simple Visualizer / pixel-bars 自定义家族）。
            if (obj.script) {
              const props = (obj.scriptProperties ?? {}) as Record<string, unknown>;
              const family = detectVisualizerFamily(obj.script, props);
              if (family) {
                const spec: (typeof visualizerSpecs)[number] = {
                  family,
                  origin: obj.origin,
                  scale: obj.scale,
                  angles: obj.angles ?? [0, 0, 0],
                  alignment: obj.alignment,
                  texture: texture ?? undefined,
                  props,
                  renderOrder: desc.objects.indexOf(obj),
                };
                if (family === 'pixel-bars') {
                  const layout = computePixelBarLayout(props, obj.scale);
                  const barAssets = await resolveImageAssets(id, { ...obj, image: layout.barPath });
                  spec.layout = layout;
                  spec.barPath = layout.barPath;
                  spec.barTexture = barAssets.texture ?? undefined;
                }
                visualizerSpecs.push(spec);
                continue;
              }
            }
            if (puppetPath) {
              // puppet：.mdl → 蒙皮网格（有骨骼段才是 SkinnedMesh，本机样本是静态族 → 普通 Mesh）。
              // 材质 = three 内建材质 + 普通 alpha（WE 的 colorBlendMode 自定义混合不复刻）。
              try {
                const bytes = await fetchMdlBytes(id, puppetPath);
                const parsed = bytes ? parseMdl(bytes) : { ok: false as const, error: 'mdl-fetch-failed' };
                if (parsed.ok) {
                  const puppet = createPuppetMesh(
                    parsed.puppet,
                    createPuppetMaterial(texture ?? null, obj.colorBlendMode),
                  );
                  puppetMeshes.set(obj.id, puppet);
                } else {
                  // 取字节/解析失败 ⇒ 该对象退化成普通背景贴图（本节拍出图来源链的最末一级），只留一条告警。
                  warnOnce(`puppet:${id}:${obj.id}`, `puppet 解析失败（object=${obj.id} ${puppetPath}）：${parsed.error}`);
                }
              } catch (e) {
                // 畸形 .mdl 不得把整张壁纸拖成硬失败：退化成普通贴图（同「解析失败」口径）。
                warnOnce(`puppet-throw:${id}:${obj.id}`,
                  `puppet 装配异常（object=${obj.id} ${puppetPath}）：${e instanceof Error ? e.message : String(e)}`);
              }
            }
          } else if (obj.kind === 'particle' && obj.particle) {
            // 粒子 spec json（raw，供 CpuParticleSim::new 解析）。
            const specResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(obj.particle)}`);
            if (!specResp.ok) continue;
            const specText = await specResp.text();
            // 材质 json → 静态纹理 URL（ptex-*.tex）+ 混合模式（`passes[0].blending`）。
            // 无纹理/解析失败 → 白图兜底；材质不可得 → blending null → 名启发式兜底。
            const mat = await resolveParticleMaterial(id, specText);
            const tex = mat?.texUrl ? (await loadTexTexture(mat.texUrl)) ?? undefined : undefined;
            // 折射层（材质 REFRACT=1）另需槽 1 的法线/遮罩纹理：缺失或加载失败 ⇒ **不装配该层**
            //（WE NORMALMAP=0 语义：位移恒 0、输出≡背景）。绝不回退白方块：槽 0 在这类材质里是 RGBA 全 255 的占位图。
            let refract: { normalTex: Texture; amount: number } | undefined;
            if (mat?.refract) {
              const normalTex = mat.normalTexUrl
                ? (await loadTexTexture(mat.normalTexUrl)) ?? undefined
                : undefined;
              if (!normalTex) {
                warnOnce(`refract-normal:${id}:${obj.id}`,
                  `折射层槽 1 法线纹理缺失/加载失败，跳过该层（不画白方块）：object=${obj.id} ${mat.normalTexUrl ?? '(无槽1)'}`);
                continue;
              }
              refract = { normalTex, amount: mat.refractAmount };
            }
            particles.set(obj.id, {
              specJson: specText,
              tex,
              blend: particleBlend(mat?.blending, specText),
              refract,
              // 对象级 instanceoverride：由 wasm `CpuParticleSim` 按官方 OverrideSpawnProgram 语义应用
              //（alpha/size/lifetime/speed 乘数 + color 覆盖 + emitter rate × count）。无覆盖 → undefined → 工厂传空串。
              overrideJson: obj.instanceOverrideJson,
              // softness 缺省由 addParticle 按有无纹理推导（有纹理 0.15 / 无纹理 1.0，对齐 wasm
              // particle_render SOFTNESS_*）；不得硬编码 0：无纹理白图兜底时硬边白方块会叠成白斑。
            });
          }
        }
        // 上面的 image/particle 资源 await（贴图/粒子 spec/材质）可能横跨丢失事件。
        if (abortIfContextLost()) return false;
        // ── text 对象 ────────────────────────────────────────────────────────────────
        // text 与 image/particle 共用 effectiveVisible（含 condition 与父链）：不过滤会叠出本应隐藏的时钟。
        const textLayers = new Map<number, {
          texture: Texture;
          driver?: ClockDriver;
          size?: [number, number];        // 画布尺寸（字体像素）= 文本 + 2×padding
          anchorOffset?: [number, number]; // origin 锚点 → quad 中心偏移（世界单位）
        }>();
        // 只有可见的 text 脚本才实例化 quickjs runtime —— 无脚本壁纸不该付 wasm 实例化成本。
        let scriptRuntime: TextScriptRuntime | null = null;
        if (desc.objects.some((o) => o.kind === 'text' && o.script && effectiveVisible.get(o.id) !== false)) {
          scriptRuntime = (await resolveTextScriptRuntime().catch(() => null)) ?? null;
        }
        for (const obj of desc.objects) {
          if (obj.kind !== 'text') continue;
          if (effectiveVisible.get(obj.id) === false) continue;
          const props = obj.scriptProperties ?? {};
          const isClock = obj.script ? detectScriptPattern(obj.script) === 'clock' : false;
          // 优先序：脚本 bind 成功 → 脚本驱动；bind 失败且是 clock 形态 → 回退 clock；都不可用 → 跳过。
          // **绝不画 `text.value`**：它只是作者占位值，画出来比不画更糟。
          const binding = obj.script && scriptRuntime ? scriptRuntime.bind(obj.script, props, obj.text) : null;
          if (obj.script && !binding && !isClock) continue;
          // pkg 内字体经 FontFace 加载后返回家族名；未加载（系统字体名/加载失败）→ 传回 WE 原始字体名，交给
          // resolveFontFamily 映射（systemfont_consolas → Consolas；否则会被当成未知字体回退 sans-serif）。
          const initial = binding ? (binding.update() ?? '') : isClock ? formatClockText(new Date(), props) : obj.text;
          const font = (await loadWallpaperFont(id, obj.font)) ?? obj.font;
          const measureOpts = {
            font,
            pointsize: obj.pointsize,
            padding: obj.padding,
            horizontalAlign: obj.horizontalAlign,
            // v0.8.2 F12：限宽换行参与布局测量（驱动器重绘沿用同一 opts）
            limitwidth: obj.limitwidth,
            maxwidth: obj.maxwidth,
          };
          // 图层尺寸 = measureText 文本 + 2×padding（scene.json 的 size 字段不参与）
          const layout = measureTextLayout(initial, measureOpts);
          const size = { w: layout.width, h: layout.height };
          const opts = { ...measureOpts, color: obj.color, brightness: obj.brightness, width: size.w, height: size.h };
          // F12：anchor（非 none）优先决定 origin 落在文本框哪条边
          const anchorOffset = textLayerOffset(
            layout, obj.horizontalAlign, obj.verticalAlign, obj.alignment, obj.scale, obj.anchor,
          );
          if (binding) {
            // 初值取脚本首帧输出（传给 driver 避免首帧以相同文本重绘一次）。
            currentScriptBindings.push(binding);
            const scriptTexture = createTextTexture(initial, opts);
            textLayers.set(obj.id, {
              texture: scriptTexture,
              driver: createScriptDriver(scriptTexture.image as HTMLCanvasElement, opts, binding, initial),
              size: [size.w, size.h],
              anchorOffset,
            });
            continue;
          }
          const texture = createTextTexture(initial, opts);
          textLayers.set(obj.id, {
            texture,
            // 时钟：每帧判文本是否变化（同分钟不重绘），变了由 player 置 needsUpdate 上传。
            driver: isClock ? createClockDriver(texture.image as HTMLCanvasElement, opts, props, initial) : undefined,
            size: [size.w, size.h],
            anchorOffset,
          });
        }
        // 上面的 text 资源 await（字体加载）同样可能横跨丢失事件（此后会推入脚本 binding）。
        if (abortIfContextLost()) return false;
        // `createParticleSim`：wasm CpuParticleSim 构造器（测试可注入 loadWasm 得到假模块）；模块无
        // CpuParticleSim → undefined → loadSceneToThree 自动跳过粒子对象（只渲染背景）。
        const cpSim = (mod as ThreeWasmModule | null)?.CpuParticleSim;
        const createParticleSim = cpSim
          ? (
              json: string,
              origin: [number, number, number],
              sceneW: number,
              sceneH: number,
              overrideJson: string,
            ): ParticleSim => {
              try {
                return cpSim.new(json, Float32Array.from(origin), sceneW, sceneH, overrideJson);
              } catch (e) {
                console.warn('[three] 粒子模拟器构造失败（用零粒子兜底）:', e instanceof Error ? e.message : String(e));
                return createEmptySim();
              }
            }
          : undefined;

        // ── 对象级效果链：解析 + 隔离尺寸预算 ─────────────────────────────────────────
        // ⚠️ 位置：必须在「组装 SceneAssets」的 objects 循环**之后**（本段依赖已被填充的
        // backgroundTextures/particles：图片尺寸兜底、粒子 spec 的 distanceMax），且在 loadSceneToThree 之前。
        // ⚠️ 全部在**加载期**完成（resolveEffectChain 的多次 loadFile、EffectRunner 创建与探针编译）。
        const loadFile = async (name: string): Promise<Uint8Array | null> => {
          const r = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(name)}`);
          if (!r.ok) return null;
          return new Uint8Array(await r.arrayBuffer());
        };
        const effectChains = await collectObjectEffectChains(
          desc, loadFile, (o) => effectiveVisible.get(o.id) === false,
        );
        // ── SceneScript 运行时（visible.script）──────────────────────────────────────────
        // 收集范围含 util 与纯控制器对象（见 collectScriptSources）；脚本按 objects 顺序装载，靠全局
        // shared 互通（拆成多个 ctx 会静默失效）。
        const scriptSources = collectScriptSources(desc);
        // 插件设置：一次读取。画质档位必须在算屏幕密度**之前**拿到——对象 RT 尺寸基准与画布缓冲必须用
        // 同一个渲染像素比（口径不一致会让整层模糊，见 AGENT.md §5.15/§5.21）。
        const settings = await readClientSettings();
        // 设置读取之后要建渲染状态（画质档位/音频/glow），丢失则不再往下走。
        if (abortIfContextLost()) return false;
        qualityScale = settings.qualityScale ?? 1;
        // 壁纸音效：sound 对象默认播放（对齐桌面 WE，可用面板关掉）。关掉时**不创建** AudioContext。
        lastAudioSpec = desc.sounds && desc.sounds.length > 0 ? { id, sounds: desc.sounds } : null;
        startAudio(id, desc.sounds ?? [], soundEnabledOverride ?? (settings.soundEnabled !== false));
        // Glow 三值来自持久设置；运行期下发过则以后者为准（effectiveGlow 里合并）。
        glowFromSettings = {
          enabled: settings.glowEnabled,
          threshold: settings.glowThreshold,
          strength: settings.glowStrength,
        };
        const dpr = resolvePixelRatio(
          typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1,
          qualityScale,
        );
        // 屏幕密度（设备像素 / 世界单位）= 对象 RT 尺寸的**唯一基准**，与主相机共用同一套 cover 语义
        //（object-range.screenScalePx 与 player.applyCover 共用 coverRange）。窗口 resize 时用
        // `player.screenScalePx()` 重算同一个量，**不得**另起一套「视口 × dpr 预算」。
        const screenScale = screenScalePx(desc.orthogonal.width, desc.orthogonal.height, vw, vh, dpr);
        // 隔离对象的尺寸表（挂载期唯一来源）：世界尺寸 = 未钳制 |size × 世界 scale|（含父链；缺 size 按纹理
        // 像素兜底，不得改用逐轴钳 4096 的相机范围），RT = min(源纹理长边, 4096) 等比收口、下限屏占位、按预算收窄。
        // 准入判定抽成局部谓词：下面 isolate 段（只认 image）复用同一份条件，避免两处各写一份后漂移。
        const isAdmittedImage = (o: SceneDescription['objects'][number]): o is SceneImageObject =>
          o.kind === 'image'
          && effectiveVisible.get(o.id) !== false
          && (effectChains.get(o.id)?.length ?? 0) > 0;
        // util 层（v0.8.2 F2）：有链才隔离；world 按 utilWorldSize（project/fullscreen=场景，其余=size×|scale|）。
        const isAdmittedUtil = (o: SceneDescription['objects'][number]): o is SceneUtilObject =>
          o.kind === 'util'
          && effectiveVisible.get(o.id) !== false
          && (effectChains.get(o.id)?.length ?? 0) > 0;
        // puppet 对象由直渲网格承载（对象 RT 隔离未覆盖蒙皮网格）⇒ 既不进隔离表，也不占源尺寸与显存预算。
        const isPuppetRendered = (o: SceneDescription['objects'][number]): boolean =>
          o.kind === 'image' && puppetMeshes.has(o.id);
        // 带类型谓词，filter 后仍收窄成 SceneImageObject（下面要读 size）。
        const isIsolatedImage = (o: SceneDescription['objects'][number]): o is SceneImageObject =>
          isAdmittedImage(o) && !isPuppetRendered(o);
        const isolateItems = desc.objects
          .filter(isIsolatedImage)
          .map((o) => {
            const tex = backgroundTextures.get(o.id);
            const s = o.scale;
            const w = (o.size?.[0] ?? (tex?.image?.width as number | undefined) ?? 1) * s[0];
            const h = (o.size?.[1] ?? (tex?.image?.height as number | undefined) ?? 1) * s[1];
            return {
              objId: o.id, worldW: Math.abs(w), worldH: Math.abs(h),
              source: sourcePixelsFromTexture(tex),
            };
          });
        const budgetScale = fitIsolatedBudget(isolateItems, screenScale);
        const isolatedSizes = new Map(isolateItems.map((it) => [it.objId, {
          rt: isolatedRtSize(it.worldW, it.worldH, screenScale, it.source, { budgetScale }),
          worldW: it.worldW, worldH: it.worldH,
        }]));
        // 源纹理尺寸表（键 = 对象 id）：与挂载期的尺寸计算**同一份数据**，resize 期同源复用（不重算）。
        // 粒子对象不在表内 ⇒ 源未知 ⇒ 回退屏占位。
        const sourceOf = new Map(isolateItems.map((it) => [it.objId, it.source]));
        // util 层**不参与**隔离预算（spec §2.2）：RT 恒为屏占位，不挤占 image 的 4096 升级幅度。
        const utilSizes = new Map<number, {
          rt: { width: number; height: number }; worldW: number; worldH: number;
        }>();
        for (const o of desc.objects) {
          if (!isAdmittedUtil(o)) continue;
          const world = utilWorldSize(
            o.layerKind, o.size, [o.scale[0], o.scale[1]], desc.orthogonal.width, desc.orthogonal.height,
          );
          utilSizes.set(o.id, { rt: objectRtSize(world.w, world.h, screenScale), worldW: world.w, worldH: world.h });
        }
        // isolate 的键 = scene.json 的**对象 id**（值里的 objectId 同值）：player 的隔离条目（attachIsolated）
        // 与 ObjectEffectStage 用同一把键 ⇒ 三者同键空间，没有「对象 id → 图层计数器 id」翻译层，也就不会撞键。
        const isolate = new Map<
          number,
          { objectId: number; rtWidth: number; rtHeight: number; worldW: number; worldH: number }
        >();
        // resize 期预算输入集合 = 挂载期 isolateItems 的同一个集合（只有 image）。util/particle/text
        // 的 RT 恒按屏占位，计入预算会在一次 resize 后把 image 的升级幅度挤回去。
        const budgetedIds = new Set<number>();
        // isolate 准入 = 「有链」：线性链与具名 RT 图链都由 ObjectEffectStage 建 runner 与计划执行。
        for (const obj of desc.objects) {
          // 静态隐藏的对象不隔离：隔离会给它建对象 RT + 合成 quad ⇒ 本应隐藏的层又画回来。
          if (effectiveVisible.get(obj.id) === false) continue;
          const chains = effectChains.get(obj.id);
          // 无链 → 早退（effectChains 只在链非空时入表）。
          if (!chains || chains.length === 0) continue;
          if (obj.kind === 'image') {
            // puppet 对象走直渲网格：隔离/效果链不支持，且不得留幽灵条目挤占其它对象的 RT 预算 ⇒ fail-loud。
            if (isPuppetRendered(obj)) {
              warnOnce(`puppet-isolate:${id}:${obj.id}`,
                `puppet 对象不支持对象级效果链，已按直渲处理（id=${obj.id}）`);
              continue;
            }
            // 准入条件与上面的 isAdmittedImage 同一份（该谓词已含 effectChains 非空）。
            if (!isAdmittedImage(obj)) continue;
            // 尺寸取自上面的 isolateItems 段（同条件、同口径）；此处只做键空间转换。
            const sized = isolatedSizes.get(obj.id);
            // 条件同 isAdmittedImage ⇒ 正常走不到这里；真漂移了**不得**悄悄不隔离：那会让「有链的
            // 对象」退化成直渲（比给它一张小 RT 更违背「只升不降」）。
            if (!sized) continue;
            isolate.set(obj.id, {
              objectId: obj.id,
              rtWidth: sized.rt.width, rtHeight: sized.rt.height,
              worldW: sized.worldW, worldH: sized.worldH,
            });
            budgetedIds.add(obj.id);
          } else if (obj.kind === 'particle') {
            const p = particles.get(obj.id);
            if (!p) continue;
            let spec: { distanceMax?: number } = {};
            try { spec = JSON.parse(p.specJson) as { distanceMax?: number }; } catch { /* 缺省 distanceMax */ }
            // 世界尺寸用**未钳制**的 distanceMax × 世界 scale（quad 的世界占位，也是 RT 尺寸的唯一基准）；
            // 局部相机范围由 player 按同一世界尺寸建立（见 particleWorldSize）。
            const s = obj.scale;
            const world = particleWorldSize(spec, [s[0], s[1]]);
            // RT 像素尺寸 = 屏占位（世界尺寸 × 屏幕密度），等比收口到 4096。⚠️ 粒子不进预算
            //（isolateItems 只含 image）、RT 恒用屏占位口径而不按源纹理升级（见 AGENT.md §7.36②）。
            const rt = objectRtSize(world.w, world.h, screenScale);
            isolate.set(obj.id, {
              objectId: obj.id,
              rtWidth: rt.width, rtHeight: rt.height,
              worldW: Math.abs(world.w), worldH: Math.abs(world.h),
            });
          } else if (obj.kind === 'text') {
            // text 世界尺寸取装配期实测布局（时钟变宽时保持装配期尺寸，见 spec D1 边界）。
            const layer = textLayers.get(obj.id);
            if (!layer?.size) continue;
            const world = textWorldSize(layer.size, [obj.scale[0], obj.scale[1]]);
            // 源分辨率下限 = 布局 canvas 像素（与 image 的 source 口径同源）：只按屏占位会把小字号
            // 文本降到几十像素再跑效果链，blur 半径相对笔画过强 ⇒ 文字糊成一团（Spider Man 日期/时钟）。
            const source = { width: layer.size[0], height: layer.size[1] };
            const rt = isolatedRtSize(world.w, world.h, screenScale, source);
            sourceOf.set(obj.id, source);
            isolate.set(obj.id, {
              objectId: obj.id,
              rtWidth: rt.width, rtHeight: rt.height,
              worldW: world.w, worldH: world.h,
            });
          } else if (obj.kind === 'util') {
            // 尺寸取自 utilSizes（同一份计算，RT = 屏占位、不进预算）；此处的 chains 早退已保证有链。
            const sized = utilSizes.get(obj.id);
            if (!sized) continue;
            isolate.set(obj.id, {
              objectId: obj.id,
              rtWidth: sized.rt.width, rtHeight: sized.rt.height,
              worldW: sized.worldW, worldH: sized.worldH,
            });
          }
        }

        // 装配前的最后一道闸：丢失则绝不安装 player（装上就是无人回收的僵尸帧循环 + GL 资源）。
        if (abortIfContextLost()) return false;
        // 装配并启动播放。viewport 显式传真实窗口尺寸：ThreeScenePlayer 不再把 canvas 重置回场景尺寸，
        // 由 player.resize(vw,vh) 使 cover 相机按窗口宽高比裁剪（窗口比例 ≠ 场景比例时是裁切而非拉伸）。
        const assets: SceneAssets = {
          backgroundTextures, particles, createParticleSim, isolate, textLayers, qualityScale, worldTransforms,
          // 绘制链路与装配期共用同一份有效可见性（含 condition/父链），player 不再用空 userProps 重判。
          effectiveVisible,
          puppetMeshes,
          // SceneScript 帧钩子：脚本状态是本帧渲染的权威来源，先 tick → 应用脏写入，
          // 再走原有的粒子/文本更新与 render。host 未就绪（quickjs 加载中/失败）时直接返回。
          onFrame: (dt) => {
            // 音频频谱：本帧渲染前刷新一次；runner 读同一缓冲（无音频 → null）。
            // v0.9 P1：系统音频授权后优先用它（浏览器模式），否则回落包内 sound 的 analyser。
            const audioSource = currentSystemAudio ?? currentAudio?.analyzer;
            audioSource?.update();
            currentStage?.setAudioSpectrum(audioSource?.freqData ?? null);
            // 音频可视化条（visualizer）：与频谱同步刷新高度（无音频 → null → 归零）。
            current?.player.updateVisualizerBars?.(audioSource?.freqData ?? null);
            // util 快照槽门控：把 player 最近一次段边界快照同步给编排器（`_rt_FullFrameBuffer` 兜底）。
            currentStage?.setFrameSnapshot(current?.player.currentFrameSnapshot?.() ?? null);
            const host = currentScriptHost;
            const loaded = current;
            if (!host || !loaded) return;
            const dirty = host.tick(dt);
            if (dirty.size === 0) return;
            applyLayerState(dirty, (objectId) => {
              const obj = loaded.player.displayObject(objectId);
              return obj ? { object: obj, sceneW: desc.orthogonal.width, sceneH: desc.orthogonal.height } : undefined;
            });
          },
        };
        // 首帧耗时：宿主注入的 onFrame 第一次被调用即「真的画出了一帧」。
        // 归属与计时都用本闭包捕获的本次 render 局部量（与出口打点同一套）。
        const userOnFrame = assets.onFrame;
        assets.onFrame = (dt: number) => {
          // 视差：每帧把指针的最新值下发给 player（插值在 player 的 tickParallax 内按 dt 推进）。
          const pointerState = pointer.target();
          current?.player.setParallaxPointer(pointerState);
          // 效果 shader 全局 uniform（F18）：视差跟随值读上一帧（1 帧滞后）；无 stage 不分配。
          if (currentStage) {
            const follow = current?.player.parallaxPointer?.() ?? pointerState;
            currentStage.setGlobalUniforms(effectPointerUniforms(pointerState, desc.parallax, follow));
          }
          if (timer.firstFrameAt < 0) {
            timer.firstFrameAt = performance.now() - timer.startedAt;
            // 只补 firstFrameMs：沿用装配出口记下的耗时；装配还没到出口（-1）时先用首帧时刻占位，
            // 随后的出口会用真实装配耗时纠正它。
            succeed(id, assembledMs >= 0 ? assembledMs : timer.firstFrameAt, timer.firstFrameAt);
          }
          userOnFrame?.(dt);
        };
        const result = loadSceneToThree(sceneJsonWithResolvedModulation(sceneJson, desc), assets, fg, {
          width: vw,
          height: vh,
        });
        current = result;
        // 音频可视化条（visualizer）：按家族代建（pixel-bars 用脚本 props + 对象 scale/angles）。
        for (const spec of visualizerSpecs) {
          const num = (v: unknown, def: number) => (typeof v === 'number' && isFinite(v) ? v : def);
          if (spec.family === 'pixel-bars' && spec.layout) {
            const layout = spec.layout;
            result.player.setPixelVisualizerBars({
              origin: spec.origin,
              scale: spec.scale,
              angles: spec.angles,
              barSize: [
                (spec.barTexture?.image?.width as number | undefined) ?? 1,
                (spec.barTexture?.image?.height as number | undefined) ?? 2,
              ],
              barWidth: layout.barWidth,
              minBarHeight: layout.minBarHeight,
              scaleY: layout.scaleY,
              barPath: layout.barPath,
              downscaleMode: layout.downscaleMode,
              texture: spec.barTexture ?? spec.texture,
              alignment: spec.alignment,
              sceneW: desc.orthogonal.width,
              sceneH: desc.orthogonal.height,
              renderOrder: spec.renderOrder,
              count: layout.count,
            });
            continue;
          }
          result.player.setVisualizerBars({
            origin: spec.origin,
            barSize: [
              (spec.texture?.image?.width as number | undefined) ?? 4,
              (spec.texture?.image?.height as number | undefined) ?? 4,
            ],
            texture: spec.texture,
            barWidth: num(spec.props.barWidth, 0.83),
            scaleY: num(spec.props.scaleY, 23.89),
            originX: num(spec.props.originX, 12.67),
            sceneW: desc.orthogonal.width,
            sceneH: desc.orthogonal.height,
            renderOrder: spec.renderOrder,
          });
        }
        // 把帧内快照 capture 注入本播放器（无消费者时 active=false ⇒ 走现状路径，零回归）。
        // renderer 身份变了（换 canvas/上下文）⇒ 旧实例绑的是旧 renderer，释放后按新 renderer 重建。
        const captureRenderer = result.player.renderer;
        if (frameCapture && frameCaptureRenderer !== captureRenderer) {
          frameCapture.dispose();
          frameCapture = null;
        }
        if (frameCapture === null) frameCapture = createFrameCapture(captureRenderer);
        frameCaptureRenderer = captureRenderer;
        result.player.setFrameCapture(frameCapture);
        // util 层内容输入（v0.8.2 T3）：passthrough 层（project/fullscreen/compose）登记帧消费者，段边界写快照。
        // solid 层内容是纯色（不随画面变化）⇒ 不登记、不参与快照槽门控。
        const utilContentIds = new Set<number>();
        for (const objId of isolate.keys()) {
          const obj = desc.objects.find((o) => o.id === objId);
          if (obj?.kind === 'util' && obj.layerKind !== 'solid') utilContentIds.add(objId);
        }
        for (const utilId of utilContentIds) result.player.registerFrameConsumer(utilId);

        // 装配 SceneScript 运行时。失败（quickjs 不可用）→ host 为 null，onFrame 直接返回，画面等于现状；
        // 绝不把脚本异常抛进帧循环。
        if (scriptSources.length > 0) {
          // ── 动态网格：脚本 createModelData/createLayer/applyData 的落点 ──
          // 材质表先为空、materialFor 返回兜底白图；脚本装载期收集到路径后立刻解析填表 ⇒ 最前面
          // 1~2 帧用兜底材质，之后换真实材质。
          const materialTable = new Map<string, Material>();
          const materialPaths = new Set<string>();
          const fallbackMaterial = createMeshMaterial(null, null);
          const meshRegistry = new DynamicMeshRegistry({
            parent: result.player.scene,
            materialFor: (p) => (p ? materialTable.get(p) ?? fallbackMaterial : fallbackMaterial),
            onWarn: (m) => warnOnce(`mesh:${id}`, m),
          });
          currentMeshRegistry = meshRegistry;

          currentScriptHost = await SceneScriptHost.create({
            scripts: scriptSources,
            userProperties: userProps,
            wallpaperId: id,
            dynamicMesh: meshRegistry,
            onAsset: (p) => materialPaths.add(p),
            onWarn: (m) => console.warn(`[wallpaper-engine] ${m}`),
            // 对象级脚本的 thisLayer.getTextureAnimation → 本次 player 的精灵表控制。
            textureAnimation: {
              pause: (objId) => result.player.pauseSpriteSheet(objId),
              play: (objId) => result.player.playSpriteSheet(objId),
              stop: (objId) => result.player.stopSpriteSheet(objId),
              isPlaying: (objId) => result.player.isSpriteSheetPlaying(objId),
              setFrame: (objId, frame) => result.player.setSpriteSheetFrame(objId, frame),
              getFrame: (objId) => result.player.getSpriteSheetFrame(objId),
            },
          });
          // 解析材质资产：material json → three 材质；纹理 `source/xxx` → materials/source/xxx.tex
          for (const p of materialPaths) {
            if (materialTable.has(p)) continue;
            try {
              const matRaw = await loadFile(p.endsWith('.json') ? p : `${p}.json`);
              if (!matRaw) { warnOnce(`mesh-mat:${id}:${p}`, `动态网格材质文件缺失：${p}`); continue; }
              const spec = parseMeshMaterial(new TextDecoder().decode(matRaw));
              if (!spec) { warnOnce(`mesh-mat:${id}:${p}`, `动态网格材质解析失败：${p}`); continue; }
              let tex: Texture | null = null;
              if (spec.texturePath) {
                // 纹理走与 resolveImageAssets **同源**的路径推导 + 路由 URL（用 Blob URL 会绕开
                // loadTexTexture 依赖的 `/wallpapers/...` 路由与 .tex 解码链路）。
                const texPath = resolveTexPath(p, spec.texturePath);
                tex = await loadTexTexture(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(texPath)}`);
                if (!tex) warnOnce(`mesh-tex:${id}:${texPath}`, `动态网格纹理加载失败：${texPath}（白图兜底）`);
              }
              const mat = createMeshMaterial(spec, tex);
              materialTable.set(p, mat);
              // 回填：脚本 init 期已建好的 mesh 此刻还挂着兜底白图材质（材质解析是异步的）。
              meshRegistry.setMaterialForPath(p, mat);
            } catch { /* 单个材质失败 → 保持兜底白图，不影响其他网格 */ }
          }
          if (currentScriptHost) {
            scriptClick = () => currentScriptHost?.click();
            scriptClickTarget = fg;
            // 生产不可达（背景层 pointer-events:none）；按 2026-10-20 产品决策不转发点击，
            // 该监听只服务 e2e/harness（GUI 内点击循环为已知边界）。
            fg.addEventListener?.('click', scriptClick);
            console.log(
              `[three] scene scripts id=${id} collected=${scriptSources.length} loaded=${currentScriptHost.scriptCount} active=${currentScriptHost.activeCount} meshes=${meshRegistry.modelCount} materials=${materialTable.size}`,
            );
          }
        }

        // SceneScript 宿主的创建/材质解析也是 await：丢失则连宿主带 player 一起作废。
        if (abortIfContextLost()) return false;
        // ── 装配 ObjectEffectStage（对象级效果链的编排器）──────────────────────────────
        // 键空间：isolate 表的键、player 隔离条目的 id（isolatedObjects()[].id）、stage 的键**都是
        // scene.json 的对象 id**。⚠️ 不得再引入「对象 id → 图层计数器 id」翻译层：对侧一改建层条件/顺序，
        // 测试全绿而效果链静默全失效，且两个计数器都从 0 起、同一壁纸的隔离 image/particle 会撞键。
        //
        // 挂在「不参与渲染的对象类型」（缺粒子 spec/资源、音频空对象）上的效果拿不到隔离条目、无法挂链——
        // 为免静默丢弃（诊断上完全不可见），按壁纸汇总一条告警（每壁纸一条，不按对象刷屏）。
        let stage: ObjectEffectStage | null = null;
        let droppedEffects = 0;
        for (const [objId, chains] of effectChains) {
          // 没有隔离条目 = 对象不参与渲染（缺粒子资源），并入本条汇总告警。
          if (isolate.has(objId)) continue;
          // puppet 对象**参与渲染**（只是不套效果链），已由上面那条专属告警说明 ⇒ 不并入「未参与渲染」汇总。
          if (puppetMeshes.has(objId)) continue;
          droppedEffects += chains.length;
        }
        if (droppedEffects > 0) {
          warnOnce(`unrendered-effects:${id}`,
            `${droppedEffects} 条效果挂在未参与渲染的对象类型上（缺粒子资源/音频），已跳过`);
        }
        // 有对象被真正隔离才需要编排器。
        if (isolate.size > 0) {
          stage = new ObjectEffectStage(result.player, {
            wallpaperId: id, screenScale,
            // util 专用快照槽门控：只有 util 内容层允许把整帧快照绑到 `_rt_FullFrameBuffer`；
            // 对象链门控（ENABLE_CHAIN_FRAME_SNAPSHOT_CONSUMER）保持关闭。无 util 内容层 ⇒ 不下发。
            allowFrameSnapshot: utilContentIds.size > 0
              ? (objId) => utilContentIds.has(objId)
              : undefined,
          });
          // 顺序契约：先 setWorldSize（尺寸的唯一来源），再 setObjectChains（后者不覆盖世界尺寸）。
          // 世界尺寸直接用 isolate 里已算好的值（同一份计算的两个消费者），不另存一份映射；键一律用对象 id。
          for (const [objId, iso] of isolate) {
            // 源尺寸与挂载期同一份数据（sourceOf）；未知（粒子对象/纹理未就绪）显式下发 null（统一形状）。
            // 第 5 参 = 是否进 resize 期预算（与挂载期 isolateItems 同集合 = image）。
            stage.setWorldSize(
              objId, iso.worldW, iso.worldH, sourceOf.get(objId) ?? null, budgetedIds.has(objId),
            );
          }
          for (const [objId, chains] of effectChains) {
            // 没有隔离条目的对象不挂链：挂也找不到 view，只会产生误导性的「调用顺序错误」告警且画不出内容。
            if (!isolate.has(objId)) continue;
            stage.setObjectChains(objId, chains);
          }
          result.player.setObjectEffectStage(stage);
          currentStage = stage;
        }
        // 壁纸级 bloom：参数来自 scene.json general.bloom*（作者设定，非用户设置）；尺寸用画布缓冲。
        // 仅有该字段时装配（新 player 的 bloomStage 初始即 null，无需显式清除）。
        if (desc.bloom) {
          currentBloom = createBloomStage(fg.width, fg.height, {
            strength: desc.bloom.strength,
            threshold: desc.bloom.threshold,
          });
          // 非法视口（0/NaN）时 stage 为 null：不阻断装配，但要留痕（否则 bloom 静默失效）。
          if (!currentBloom) {
            console.warn(`[wallpaper-engine] 壁纸 ${id} 的 bloom 视口非法（${fg.width}×${fg.height}），已跳过壁纸级 bloom`);
          }
          result.player.setBloomStage(currentBloom);
        }
        // 应用级 Glow：按插件设置装配（关闭时零资源）。⚠️ 必须在 isolate 块**之外** —— Glow 与「有无对象被
        // 隔离」无关；尺寸用画布缓冲，resize 由 player.resize 内部单点同步，此处不重复。
        currentGlow?.dispose();
        const glow = effectiveGlow();
        currentGlow = glow.enabled
          ? createGlowStage(fg.width, fg.height, {
              threshold: glow.threshold,
              strength: glow.strength,
            })
          : null;
        glowSize = { width: fg.width, height: fg.height }; // 运行期「开 Glow」新建 stage 的尺寸基准
        result.player.setGlowStage(currentGlow);
        // 相机视差：配置来自 scene.json（缺省全 0 = 与加此功能前观感一致）。关闭态一律用 enabled:false
        // 的**具体配置**表达（player 据此把对象写回一次基准位），绝不传 null —— null 会让 tickParallax
        // 整体早退、不复位。
        result.player.setParallax(desc.parallax);
        pointer.install();
        // 省电：装配时若已处于暂停态（如切到后台时换壁纸）→ 直接不排程。
        if (paused) result.player.pause();
        // 窗口尺寸变化 → 按新窗口比例重推 cover（对齐 wasm 路径的 window.innerWidth/Height 语义），并把新的
        // **屏幕密度**同步给效果链编排器（隔离对象 RT 随视口重设）。⚠️ 密度取自 `player.screenScalePx()`
        //（与 applyCover 同一套 state，与刚执行的 `player.resize` 天然同源）——挂载期与 resize 期各算一遍
        // 正是「RT 尺寸被 resize 打回旧口径」那类漏检的结构性原因。
        onWindowResize = () => {
          if (!current) return;
          const { width, height } = viewportSize();
          current.player.resize(width, height);
          glowSize = { width: fg.width, height: fg.height }; // 运行期开 Glow 的尺寸基准随视口同步
          currentStage?.onViewportResize(current.player.screenScalePx());
        };
        window.addEventListener('resize', onWindowResize);
        // 返回 true 之前的最后一道兜底：不得把「已丢失」的装配报告成成功（否则护栏被掀翻）。
        if (abortIfContextLost()) return false;
        // 观测：确认走的是 three 路径（浏览器回归探测用）。
        console.log(
          `[three] scene loaded id=${id} background=${result.backgroundIds.length} particleLayers=${result.particleLayers.length} puppetLayers=${result.puppetLayers.length}`,
        );
        // 零背景 + 零粒子 + 零 puppet → 无内容，返回 false 由 controller 走 preview 兜底（不显示空 canvas）。
        if (
          result.backgroundIds.length === 0
          && result.particleLayers.length === 0
          && result.puppetLayers.length === 0
        ) {
          fail(id, 'no-visible-objects', 'background=0 particleLayers=0 puppetLayers=0');
          teardownQuietly();
          return false;
        }
        // 打点必须在零可见对象判定**之后**：空场景不是成功。
        assembledMs = performance.now() - timer.startedAt;
        succeed(id, assembledMs, timer.firstFrameAt);
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[three] scene render failed:', msg);
        fail(id, 'exception', msg);
        teardownQuietly();
        return false;
      }
    },
    // 省电：暂停/恢复当前播放器的帧循环（无播放器时只记状态，下次装配时就地应用）。
    setPaused(value: boolean) {
      paused = value;
      if (currentAudio) applyAudioPause(currentAudio, value);
      if (!current) return;
      if (value) current.player.pause();
      else current.player.resume();
    },
    // 画质档位：改渲染像素比后重推画布缓冲，并把新屏幕密度同步给效果链编排器（对象 RT 随其重设）。
    setQualityScale(scale: number) {
      qualityScale = scale;
      if (!current) return;
      current.player.setQualityScale(scale);
      currentStage?.onViewportResize(current.player.screenScalePx());
    },
    // 上下文丢失回调（控制器注册，见 onContextLost）：传 null 撤销，可重复设。
    setOnContextLost(cb: ((id: string) => void) | null): void {
      contextLostHandler = cb;
    },
    // 应用级 Glow 的运行期参数（面板即时生效）：已装配就地重配 / 装卸 stage，不必重选壁纸。
    setGlow(patch: { enabled?: boolean; threshold?: number; strength?: number }) {
      glowOverride = { ...(glowOverride ?? {}), ...patch };
      applyGlowRuntime();
    },
    // 系统音频（v0.9 P1）：浏览器模式捕获系统/标签页音频驱动频谱；桌面 App 宿主禁用 → 返回失败码。
    async startSystemAudio(): Promise<SystemAudioFailure | 'ok'> {
      if (systemAudioStarting) return 'error';
      systemAudioStarting = true;
      stopSystemAudioCapture();
      try {
        let cap: SystemAudioCapture | null = null;
        const result = await startSystemAudioCapture(() => {
          if (cap && currentSystemAudio === cap) currentSystemAudio = null;
        });
        if (typeof result === 'string') return result;
        cap = result;
        currentSystemAudio = cap;
        return 'ok';
      } finally {
        systemAudioStarting = false;
      }
    },
    stopSystemAudio() {
      stopSystemAudioCapture();
    },
    // 音效开关（面板即时生效）：关 → 停声并释放 AudioContext；开 → 按上次规格重播。
    setSoundEnabled(value: boolean) {
      soundEnabledOverride = value;
      if (!value) { stopAudio(); return; }
      if (!currentAudio && lastAudioSpec) startAudio(lastAudioSpec.id, lastAudioSpec.sounds, true);
    },
    // 抓帧（v0.8 首帧缓存）：读取下一帧渲染结果；未装配/不支持 → null（调用方只跳过）。
    async captureFrame(): Promise<Uint8Array | null> {
      return current?.player?.captureNextFrame?.() ?? null;
    },
    // 释放当前 three 播放器 + wasm 模拟器（切壁纸/卸载时防泄漏）。
    // `frameCapture` 绑定创建它的 renderer（换 renderer 时已在 render 内换绑），随本 renderer 一并释放。
    dispose() {
      teardown();
      frameCapture?.dispose();
      frameCapture = null;
      frameCaptureRenderer = null;
    },
    // 看护读接口：设置面板与 `window.__wallpaperEngine.health()` 用它取当前壁纸状态。
    getLastHealth(): HealthSnapshot | null {
      return currentHealthId ? health.snapshot(currentHealthId) : null;
    },
    setOnHealth(cb: ((s: HealthSnapshot) => void) | null): void {
      healthHandler = cb;
    },
  };
}
