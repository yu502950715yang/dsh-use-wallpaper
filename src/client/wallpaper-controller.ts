import type { WallpaperInfo } from '../shared/types.js';
import type { BackgroundLayer } from './background-layer.js';
import { resolveBackground } from './background-layer.js';
import { measureLuma, lumaToTextColor } from './luma.js';

// scene 渲染器的接口形态（three-renderer 的生产实现与测试替身都按此形状提供）。
export interface SceneRendererLike {
  render(id: string, fg: HTMLCanvasElement, bg?: HTMLCanvasElement): Promise<boolean>;
  // 释放渲染器持有的场景资源（壁纸切换/卸载时调用，防泄漏）。
  dispose?(): void;
  // 以下为可选运行期下发；未实现的渲染器忽略即可。
  setPaused?(paused: boolean): void;
  setQualityScale?(scale: number): void;
  // 应用级 Glow 的运行期参数（开关/阈值/强度）；已装配时即时生效，无需重选壁纸。
  setGlow?(patch: { enabled?: boolean; threshold?: number; strength?: number }): void;
}

export interface WallpaperControllerOptions {
  fetchList: () => Promise<WallpaperInfo[]>;
  // Finding 2：dispose 可选——每次 select（含取消/切壁纸）时调用，释放渲染器持有的资源（防泄漏）。
  sceneRenderer?: SceneRendererLike;
}

// 文字颜色跟随壁纸亮度（2026-09-03）：测 preview 图平均亮度，选文字色写 --wp-chat-fg。
// previewUrl 对 scene/video/image/web 均可用（渲染失败本就回退 preview），是跨类型最稳数据源。
// 竞态防护：用 gen 校验，防止乱序覆盖。
function applyChatFg(layer: BackgroundLayer, info: WallpaperInfo | undefined, gen: number, check: () => boolean): void {
  const url = info?.previewUrl;
  if (!url) { layer.setChatFg(''); return; }
  void measureLuma(url).then((luma) => {
    if (luma === null) { layer.setChatFg(''); return; } // 测量失败 → 回主题默认
    if (check()) layer.setChatFg(lumaToTextColor(luma));
  }).catch(() => { layer.setChatFg(''); });
}

export function createWallpaperController(
  layer: BackgroundLayer,
  opts: WallpaperControllerOptions,
) {
  let list: WallpaperInfo[] = [];
  // I3：select 竞态防护 —— 每次 select 递增 generation，异步完成后（scene
  // 渲染回调等）校验 generation 未变才应用，防止乱序覆盖最新选择。
  let selectGeneration = 0;

  async function load(): Promise<WallpaperInfo[]> {
    list = await opts.fetchList();
    return list;
  }

  async function select(id: string): Promise<void> {
    const gen = ++selectGeneration;
    // Finding 2：壁纸切换/取消时释放当前 scene 渲染器资源（wasm 场景 + 脚本运行时）。
    // 旧渲染器的 raf 循环随 canvas 被替换/移除终止，但其持有的 scene/quickjs 需显式释放。
    opts.sceneRenderer?.dispose?.();
    // 取消壁纸：空 id 直接清空背景层（恢复默认背景，露出 DSH 原生背景）。
    // 同步生效并递增 generation，使进行中的旧选择异步回调被竞态防护丢弃。
    if (id === '') {
      layer.showNone();
      layer.setChatFg(''); // 清文字颜色，回主题默认
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
    // I1 修复：controller 缓存的 list 只在为空时刷新（见上方），而设置面板的列表是
    // 独立 fetch 维护的——新添加的壁纸会出现在面板列表却不在 controller 缓存里。
    // 若 list.find(id) 找不到（旧缓存过期），重新拉取一次列表再查找，避免
    // 「列表可见却选不中（无任何反应）」。重试后仍找不到才放弃。
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
      case 'video': layer.showVideo(plan.url); break;
      case 'image': layer.showImage(plan.url, plan.kenBurns); break;
      case 'web': layer.showWeb(plan.url); break;
      case 'scene': {
        if (opts.sceneRenderer) {
          // ⚠️ 只创建**一个** canvas（前景 = 渲染目标）——它就是页面上显示的那个。
          // 2026-09-10 Task5 修复：此前这里额外 `document.createElement('canvas')` 出 `bg`
          // 并交给 `showSceneCanvas(fg, bg)`，background-layer 会把它作为 `.wp-scene-blur`
          // **先** append 进 `.wp-bg-fill`（DOM 序在前）。而**没有任何**存活路径给它设过尺寸
          // （wasm-renderer 明确「bg 参数忽略」，three-renderer 的 `_bg` 同样忽略）→ 它永远停在
          // HTML canvas 默认 **300×150**，再被 CSS `.wp-scene-blur{width:100%;height:100%;
          // transform:scale(1.1)}` 拉伸到全屏。于是 `document.querySelector('canvas')`
          // （取文档里第一个 canvas = 这个空的 300×150）读到的**不是** three 真正渲染的 canvas，
          // 真机排查因此被误导成「渲染缓冲没设成视口尺寸 → 画面被放大模糊」。
          // 现在不再创建这个死 canvas：DOM 里只剩 three 渲染/显示的那一个（尺寸 = 视口×dpr）。
          const fg = document.createElement('canvas');
          try {
            let ok = await opts.sceneRenderer.render(plan.wallpaperId, fg);
            if (!ok) {
              // Task 9 语义保留：wasm 失败时 fg 可能已被绑定 WebGPU context → 重建 canvas
              // 重试一次（组合层对已失败壁纸直接返回 false；2026-08-21 起 JS 渲染已禁用，
              // 重试仍走 wasm/组合层，最终失败落入下方 preview 回退）
              const fg2 = document.createElement('canvas');
              ok = await opts.sceneRenderer.render(plan.wallpaperId, fg2);
              if (ok) {
                if (gen !== selectGeneration) return;
                layer.showSceneCanvas(fg2);
                break;
              }
            }
            if (gen !== selectGeneration) return; // 期间已切换 → 丢弃旧渲染结果
            if (ok) { layer.showSceneCanvas(fg); break; }
          } catch {
            if (gen !== selectGeneration) return;
            // 渲染异常（reject）→ 与失败同等对待，落入回退
          }
        }
        if (gen !== selectGeneration) return;
        // 渲染不可用/失败 → 回退 preview
        if (info.previewUrl) layer.showImage(info.previewUrl, !info.hasPreviewGif);
        else layer.showNone();
        break;
      }
      case 'none': layer.showNone(); break;
    }
    // 文字颜色跟随壁纸亮度：switch 展示壁纸后，异步测 preview 亮度选文字色。
    // applyChatFg 内部用 gen 校验防竞态；无 preview（测量失败）则清变量回主题默认。
    applyChatFg(layer, info, gen, () => gen === selectGeneration);
  }

  return { load, select };
}
