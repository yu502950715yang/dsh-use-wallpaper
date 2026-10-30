import type { WallpaperInfo } from '../shared/types.js';
import type { BackgroundLayer } from './background-layer.js';
import { resolveBackground } from './background-layer.js';
import { measureLuma, lumaToTextColor } from './luma.js';
import { type TextColorMode, manualTextColor, normalizeMode, normalizeOutlineLevel } from './text-color.js';
import type { HealthSnapshot } from './render-health.js';
import type { MediaFallback } from './media-health.js';
import type { MediaIntegrationStatus } from '../shared/media.js';
import type { SystemAudioFailure } from './system-audio.js';

// scene 渲染器的接口形态（three-renderer 的生产实现与测试替身都按此形状提供）。
export interface SceneRendererLike {
  /** entry = pkg 内场景入口 json 名（WE 模板可能是 gifscene.json；缺省 scene.json）。 */
  render(id: string, fg: HTMLCanvasElement, bg?: HTMLCanvasElement, sceneEntry?: string): Promise<boolean>;
  // 释放渲染器持有的场景资源（壁纸切换/卸载时调用，防泄漏）。
  dispose?(): void;
  // 以下为可选运行期下发；未实现的渲染器忽略即可。
  setPaused?(paused: boolean): void;
  setQualityScale?(scale: number): void;
  // 应用级 Glow 的运行期参数（开关/阈值/强度）；已装配时即时生效，无需重选壁纸。
  setGlow?(patch: { enabled?: boolean; threshold?: number; strength?: number }): void;
  // 壁纸音效开关（含频谱驱动效果）：关掉即时停声并释放 AudioContext；打开按上次规格重播。
  setSoundEnabled?(enabled: boolean): void;
  // 媒体集成开关（面板即时生效；关闭后媒体图层隐藏且停轮询）。
  setMediaIntegration?(enabled: boolean): void;
  // 媒体集成状态（面板状态行）：只含 available/reason/enabled，不含曲目/封面。
  getMediaStatus?(): MediaIntegrationStatus | null;
  // 系统音频（v0.9 P1）：浏览器模式捕获系统音频驱动频谱；桌面 App 宿主禁用 → 返回失败码（面板提示）。
  startSystemAudio?(): Promise<SystemAudioFailure | 'ok'>;
  stopSystemAudio?(): void;
  // 上下文丢失（显存耗尽/驱动重置）回调：渲染器停播后交回壁纸 id，由控制器换回该壁纸 preview。
  setOnContextLost?(cb: ((id: string) => void) | null): void;
  // scene 渲染看护（Task 2）：当前壁纸的健康快照 + 每次打点的订阅（面板/全局入口消费）。
  getLastHealth?(): HealthSnapshot | null;
  setOnHealth?(cb: ((s: HealthSnapshot) => void) | null): void;
  // 抓取当前场景一帧 PNG（v0.8 首帧缓存）；不支持/失败 → null，绝不抛。
  captureFrame?(): Promise<Uint8Array | null>;
}

/** 贴壁纸文字样式（设置面板可改）：实时读取，故由 index.ts 以 getter 注入。 */
export interface TextStyleSettings {
  /** 'auto' | 'white' | 'black' | 'custom'（非法值按 auto 处理）。 */
  mode: string;
  /** 自定义色（仅 custom 档使用）。 */
  custom: string;
  /** 描边档位 0-3（0 = 关）。 */
  outline: number;
}

export interface WallpaperControllerOptions {
  fetchList: () => Promise<WallpaperInfo[]>;
  // dispose 可选 —— 每次 select（含取消/切壁纸）时调用，释放渲染器持有的资源（防泄漏）。
  sceneRenderer?: SceneRendererLike;
  /** 文字颜色/描边设置（实时读取）。缺省 = auto 档、无描边（既有行为）。 */
  textStyle?: () => TextStyleSettings;
  /** preview 亮度测量；缺省用 luma.measureLuma（测试注入替身用）。 */
  measurePreviewLuma?: (url: string) => Promise<number | null>;
  /** 视频解码失败（编码不支持/首帧超时）→ 面板提示用；`fallback` 为控制器实际回退的结果。 */
  onMediaFailure?: (id: string, result: 'unsupported' | 'timeout', fallback: MediaFallback) => void;
  /** scene 成功显示后的通知（index 用它触发首帧缓存抓帧）；不得阻塞渲染。 */
  onSceneLive?: (info: WallpaperInfo) => void;
  /** scene 渲染失败/不可用时的降级链（内嵌视频 → 抓帧 → preview）；抛错时控制器落回 preview。 */
  sceneFallback?: (info: WallpaperInfo) => Promise<void>;
}

// 贴壁纸文字颜色与描边：
//   · 手动档（white/black/custom）直接下发固定色，**不测 preview** —— 否则异步测量结果会覆盖手选色；
//   · auto 档按 preview 亮度测量（暗壁纸白字 / 亮壁纸黑字）；描边档位随文字色一起下发（对立色阴影由
//     background-layer 按文字色亮度算）。
// 竞态防护：gen 校验（换了壁纸不覆盖）+ 落地前重读模式（期间改手动则不覆盖手选色）。
function createTextStyler(layer: BackgroundLayer, opts: WallpaperControllerOptions, genOf: () => number) {
  const measure = opts.measurePreviewLuma ?? measureLuma;
  // 最近一次 auto 测光的结果及其壁纸 id：设置变更（改档位/描边）时**同步**复用该结果，用户拖滑杆即时
  // 可见且不必重新测图；换壁纸时 id 不匹配 ⇒ 不复用（各自重新测光）。
  let autoColor: string | null = null;
  let autoColorFor: string | undefined;

  function readStyle(): { mode: TextColorMode; custom: string; outline: number } {
    const s = opts.textStyle?.();
    return {
      mode: normalizeMode(s?.mode),
      custom: typeof s?.custom === 'string' ? s.custom : '',
      outline: normalizeOutlineLevel(s?.outline),
    };
  }
  function clear(): void {
    autoColor = null;
    autoColorFor = undefined;
    layer.setChatFg('');
    layer.setChatOutline('', 0);
  }
  /** forceMeasure：select 展示壁纸时强制重测（新壁纸/重选）；设置变更时用缓存即可。 */
  function apply(info: WallpaperInfo | undefined, forceMeasure = false): void {
    const { mode, custom, outline } = readStyle();
    const manual = manualTextColor(mode, custom);
    if (manual !== null) {
      autoColor = null;
      autoColorFor = undefined;
      layer.setChatFg(manual);
      layer.setChatOutline(manual, outline);
      return;
    }
    const cached = autoColorFor === info?.id ? autoColor : null;
    if (cached) {
      layer.setChatFg(cached);
      layer.setChatOutline(cached, outline);
      if (!forceMeasure) return; // 设置变更：直接用缓存，不再测图（拖动描边零延迟）
    }
    const url = info?.previewUrl;
    if (!url) { if (!cached) clear(); return; } // 无 preview 可测 → 回主题默认（有缓存则保留）
    const gen = genOf();
    void measure(url).then((luma) => {
      if (gen !== genOf()) return;                                  // 期间已切换壁纸
      if (readStyle().mode !== 'auto') return;                      // 期间已改成手动档
      if (luma === null) { if (!cached) clear(); return; }           // 测光失败：有上次结果则保留（不闪）
      const color = lumaToTextColor(luma);
      autoColor = color;
      autoColorFor = info?.id;
      layer.setChatFg(color);
      layer.setChatOutline(color, readStyle().outline);              // 用最新档位
    }).catch(() => { if (gen === genOf() && !cached) clear(); });
  }
  return { apply, clear };
}

export function createWallpaperController(
  layer: BackgroundLayer,
  opts: WallpaperControllerOptions,
) {
  let list: WallpaperInfo[] = [];
  // select 竞态防护：每次 select 递增 generation，异步完成后校验 generation 未变才应用，防乱序覆盖最新选择。
  let selectGeneration = 0;
  // 当前展示的壁纸：设置面板改文字颜色/描边后，无需重选壁纸即可重新下发（applyTextStyle）。
  let currentInfo: WallpaperInfo | undefined;
  const textStyler = createTextStyler(layer, opts, () => selectGeneration);
  // WebGL 上下文丢失回退：渲染器重置（显存耗尽/驱动重置）后画面就是一块空白 ⇒ 换成该壁纸的 preview 图。
  // 优先按回调参数 id 在当前列表里找：select 进行中丢上下文时 currentInfo 还是**上一张**壁纸，只读它会先闪
  // 出上一张的 preview；找不到再退回 currentInfo。⚠️ 回调在**调用时**读闭包（不是注册时快照）：注册发生在
  // 构造期，那时还没有任何壁纸。
  opts.sceneRenderer?.setOnContextLost?.((id) => {
    const fallback = list.find((w) => w.id === id) ?? currentInfo;
    console.warn(`[wallpaper-engine] scene 渲染不可用（WebGL 上下文丢失），已回退 preview（壁纸 ${id}）`);
    if (fallback?.previewUrl) layer.showImage(fallback.previewUrl, !fallback.hasPreviewGif);
    else layer.showNone();
  });

  async function load(): Promise<WallpaperInfo[]> {
    list = await opts.fetchList();
    return list;
  }

  // scene 成功显示后的通知（onSceneLive）：回调异常不得破坏 select（显示已完成，回调只负责后台抓帧）。
  function notifyLive(info: WallpaperInfo): void {
    try { opts.onSceneLive?.(info); } catch { /* 回调异常只吞掉，不影响已完成的显示 */ }
  }

  async function select(id: string): Promise<void> {
    const gen = ++selectGeneration;
    // 壁纸切换/取消时释放当前 scene 渲染器资源（wasm 场景 + 脚本运行时）；旧渲染器的 raf 循环随 canvas
    // 被替换/移除终止，但其持有的 scene/quickjs 需显式释放。
    opts.sceneRenderer?.dispose?.();
    // 取消壁纸：空 id 直接清空背景层（恢复默认背景，露出 DSH 原生背景）。
    // 同步生效并递增 generation，使进行中的旧选择异步回调被竞态防护丢弃。
    if (id === '') {
      layer.showNone();
      currentInfo = undefined;
      textStyler.clear(); // 清文字颜色与描边，回主题默认
      return;
    }
    // 列表未加载时自动拉取（show() 委托 select 的前提）；加载失败则静默放弃本次选择
    if (list.length === 0) {
      try {
        await load();
      } catch {
        return;
      }
    }
    if (gen !== selectGeneration) return;
    // controller 缓存的 list 只在为空时刷新（见上方），而设置面板的列表是独立 fetch 维护的 —— 新添加的
    // 壁纸会出现在面板列表却不在 controller 缓存里。若 list.find(id) 找不到（旧缓存过期），重新拉取一次
    // 列表再查找，避免「列表可见却选不中」；重试后仍找不到才放弃。
    let info = list.find((w) => w.id === id);
    if (!info) {
      try {
        await load();
      } catch {
        return;
      }
      if (gen !== selectGeneration) return;
      info = list.find((w) => w.id === id);
      if (!info) return;
    }
    const plan = resolveBackground(info);
    switch (plan.kind) {
      case 'video': {
        const result = await layer.showVideo(plan.url);
        if (gen !== selectGeneration) return; // 期间已切换：旧视频的失败结果不得覆盖新壁纸
        if (result !== 'ok') {
          const fallback: MediaFallback = info.previewUrl ? 'preview' : 'none';
          opts.onMediaFailure?.(info.id, result, fallback);
          if (info.previewUrl) layer.showImage(info.previewUrl, !info.hasPreviewGif);
          else layer.showNone();
        }
        break;
      }
      case 'image': layer.showImage(plan.url, plan.kenBurns); break;
      case 'web': layer.showWeb(plan.url); break;
      case 'scene': {
        if (opts.sceneRenderer) {
          // ⚠️ 只创建**一个** canvas（前景 = 渲染目标）——它就是页面上显示的那个。额外造一个空的 `bg` 交给
          // background-layer 会在 DOM 里多一个**从未被设置尺寸**的 canvas（两个渲染路径都忽略 bg 参数），
          // 它停在 HTML canvas 默认尺寸再被 CSS 拉伸到全屏，使 `document.querySelector('canvas')` 读到
          // **不是**真正渲染的那个，真机排查因此被误导。
          const fg = document.createElement('canvas');
          try {
            let ok = await opts.sceneRenderer.render(plan.wallpaperId, fg, undefined, plan.sceneEntry);
            if (!ok) {
              // 失败时 fg 可能已被绑定 WebGPU context ⇒ 重建 canvas 重试一次（组合层对已失败壁纸直接返回
              // false，重试仍失败就落入下方降级链）。
              const fg2 = document.createElement('canvas');
              ok = await opts.sceneRenderer.render(plan.wallpaperId, fg2, undefined, plan.sceneEntry);
              if (ok) {
                if (gen !== selectGeneration) return;
                layer.showSceneCanvas(fg2);
                notifyLive(info);
                break;
              }
            }
            if (gen !== selectGeneration) return; // 期间已切换 → 丢弃旧渲染结果
            if (ok) {
              layer.showSceneCanvas(fg);
              notifyLive(info);
              break;
            }
          } catch {
            if (gen !== selectGeneration) return;
            // 渲染异常（reject）→ 与失败同等对待，落入降级链
          }
        }
        if (gen !== selectGeneration) return;
        // 渲染不可用/失败 → 可注入降级链（内嵌视频 → 抓帧 → preview）；降级自身抛错必须落回 preview。
        if (opts.sceneFallback) {
          try {
            await opts.sceneFallback(info);
            if (gen !== selectGeneration) return;
            break;
          } catch {
            if (gen !== selectGeneration) return;
          }
        }
        if (gen !== selectGeneration) return;
        if (info.previewUrl) layer.showImage(info.previewUrl, !info.hasPreviewGif);
        else layer.showNone();
        break;
      }
      case 'none': layer.showNone(); break;
    }
    // 贴壁纸文字颜色与描边：展示壁纸后下发（手动档＝固定色；auto 档＝异步测 preview 亮度）。
    // 此处 forceMeasure=true：换了壁纸（或重选）必须重新测光，不复用上一张的缓存。
    currentInfo = info;
    textStyler.apply(info, true);
  }

  return {
    load,
    select,
    // 已加载的壁纸列表（轮播按它算轮播池；空 = 还没 load）。
    getList(): WallpaperInfo[] { return list; },
    // 设置面板改了文字颜色/描边 → 立即重新下发（不必重选壁纸）。
    applyTextStyle(): void { textStyler.apply(currentInfo); },
  };
}
