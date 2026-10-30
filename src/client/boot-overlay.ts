// 开机动画全屏播放器：独立全屏层，不碰背景层状态与 body[data-we-wallpaper]。
// 一次 play() = 建层 → 首帧/立即计时 → 结束/跳过/超时/失败 → 淡出移除；任何失败都不抛。

export type BootFitMode = 'tile' | 'contain' | 'stretch' | 'cover';
export type BootAsset = { kind: 'video'; url: string } | { kind: 'image'; url: string };
export type BootResult = 'ended' | 'skipped' | 'timeout' | 'failed' | 'already-played' | 'disabled' | 'no-asset';

export interface BootOverlay {
  play(asset: BootAsset, fit: BootFitMode, maxDurationMs?: number): Promise<BootResult>;
  dispose(): void;
}

export interface BootOverlayOptions {
  readyTimeoutMs?: number;
  fadeMs?: number;
  imageDurationMs?: number;
  /** DSH 启动页（[data-dsh-boot]）存在时的硬上限；默认 30s（极慢机器兜底，避免无限黑屏）。 */
  bootHoldMaxMs?: number;
  doc?: Document;
}

const LAYER_CLASS = 'wp-boot-layer';
const TILE_CLASS = 'wp-boot-tile';
const Z_INDEX = 2147483000;
// DSH 前端在插件加载阶段渲染的启动页（HARNESS / "Loading plugins…"）：插件 apply 时它还在 DOM 里。
// 动画要接管它 —— 存在期间持续播放（视频循环 / 图片保持），它消失（主界面挂载）后再淡出。
const DSH_BOOT_SELECTOR = '[data-dsh-boot]';

type TimerHandle = ReturnType<typeof setTimeout>;

interface ActivePlay {
  el: HTMLElement;
  video: HTMLVideoElement | null;
  resolve: (result: BootResult) => void;
  /** 非 null = 结果已定、正在淡出。 */
  result: BootResult | null;
  readyTimer: TimerHandle | null;
  /** 等待 DSH 启动页消失的观察器（仅 hold 模式）；收尾时必须 disconnect。 */
  bootObserver: MutationObserver | null;
}

export function createBootOverlay(opts: BootOverlayOptions = {}): BootOverlay {
  const doc = opts.doc ?? document;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 8000;
  const fadeMs = opts.fadeMs ?? 300;
  const imageDurationMs = opts.imageDurationMs ?? 4000;
  const bootHoldMaxMs = opts.bootHoldMaxMs ?? 30000;

  let disposed = false;
  let active: ActivePlay | null = null;
  const timers = new Set<TimerHandle>();

  const later = (fn: () => void, ms: number): TimerHandle => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };
  const cancel = (t: TimerHandle | null): void => {
    if (t === null) return;
    timers.delete(t);
    clearTimeout(t);
  };
  const clearTimers = (): void => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };

  // 视频收尾：停播 + 断源，避免淡出期间还在解码/占网络。
  function stopVideo(video: HTMLVideoElement | null): void {
    if (video === null) return;
    try {
      video.pause();
    } catch {
      /* jsdom / 元素已卸载 */
    }
    video.removeAttribute('src');
  }

  function finish(result: BootResult): void {
    const entry = active;
    if (entry === null || entry.result !== null) return;
    entry.result = result;
    clearTimers();
    entry.readyTimer = null;
    entry.bootObserver?.disconnect();
    entry.bootObserver = null;
    detachSkip();
    stopVideo(entry.video);
    entry.el.style.opacity = '0';
    later(() => {
      if (active !== entry) return;
      active = null;
      entry.el.remove();
      entry.resolve(result);
    }, fadeMs);
  }

  // 立即收尾：不等淡出，进行中的 play() 立即以 result 解出（dispose / 再次 play）。
  function teardown(result: BootResult): void {
    const entry = active;
    if (entry === null) return;
    active = null;
    clearTimers();
    entry.bootObserver?.disconnect();
    entry.bootObserver = null;
    detachSkip();
    stopVideo(entry.video);
    entry.el.remove();
    entry.resolve(result);
  }

  const onSkip = (ev: Event): void => {
    ev.preventDefault();
    finish('skipped');
  };
  function attachSkip(): void {
    window.addEventListener('pointerdown', onSkip, true);
    window.addEventListener('keydown', onSkip, true);
  }
  function detachSkip(): void {
    window.removeEventListener('pointerdown', onSkip, true);
    window.removeEventListener('keydown', onSkip, true);
  }

  function applyFit(el: HTMLElement, fit: BootFitMode): void {
    if (fit === 'tile') return; // 平铺走背景 div，object-fit 无平铺语义
    el.style.objectFit = fit === 'stretch' ? 'fill' : fit;
  }

  return {
    play(asset, fit, maxDurationMs = 0) {
      if (disposed) return Promise.resolve('failed');
      teardown('skipped'); // 面板重复试播：先收掉上一次，旧 promise 不悬挂

      const el = doc.createElement('div');
      el.className = LAYER_CLASS;
      el.style.cssText =
        `position:fixed;inset:0;z-index:${Z_INDEX};background:#000;overflow:hidden;opacity:1;` +
        `transition:opacity ${fadeMs}ms linear`;
      doc.documentElement.appendChild(el);

      let resolve: (result: BootResult) => void = () => {};
      const promise = new Promise<BootResult>((res) => {
        resolve = res;
      });
      // DSH 启动页存在 ⇒ hold 模式：持续播放到它消失（视频循环、图片保持），最长 bootHoldMaxMs。
      const holdForBoot = doc.querySelector(DSH_BOOT_SELECTOR) !== null;
      const entry: ActivePlay = { el, video: null, resolve, result: null, readyTimer: null, bootObserver: null };
      active = entry;
      attachSkip();
      entry.readyTimer = later(() => finish('timeout'), readyTimeoutMs);
      if (holdForBoot) {
        // 主界面挂载时 React 会替换 #root 内容 ⇒ 观察 body 子树即可捕获启动页移除。
        const root = doc.body ?? doc.documentElement;
        entry.bootObserver = new MutationObserver(() => {
          if (doc.querySelector(DSH_BOOT_SELECTOR) !== null) return;
          entry.bootObserver?.disconnect();
          entry.bootObserver = null;
          finish('ended');
        });
        entry.bootObserver.observe(root, { childList: true, subtree: true });
        later(() => finish('ended'), bootHoldMaxMs); // 极慢机器兜底，避免无限黑屏
      }

      // 首帧就绪（或图片创建完成）后开始计时；视频 maxDurationMs=0 时等 ended。
      // hold 模式不按素材时长结束——由启动页消失或硬上限决定。
      const started = (): void => {
        if (active !== entry || entry.result !== null) return;
        cancel(entry.readyTimer);
        entry.readyTimer = null;
        if (holdForBoot) return;
        const duration =
          asset.kind === 'image'
            ? maxDurationMs > 0
              ? Math.min(imageDurationMs, maxDurationMs)
              : imageDurationMs
            : maxDurationMs;
        if (asset.kind === 'image') {
          later(() => finish('ended'), Math.max(0, duration));
        } else if (duration > 0) {
          later(() => finish('ended'), duration);
        }
      };

      try {
        if (asset.kind === 'video') {
          const video = doc.createElement('video');
          video.autoplay = true;
          video.muted = true;
          video.playsInline = true;
          video.preload = 'auto';
          video.loop = holdForBoot; // 启动页存在期间循环，播到主界面就绪
          video.style.cssText = 'width:100%;height:100%;border:0;display:block';
          applyFit(video, fit);
          video.addEventListener('loadeddata', started, { once: true });
          video.addEventListener('ended', () => {
            if (holdForBoot) return; // loop 模式下正常不会 ended；被浏览器打断时也不结束
            finish('ended');
          }, { once: true });
          video.addEventListener('error', () => finish('failed'), { once: true });
          el.appendChild(video);
          entry.video = video;
          video.src = asset.url;
          try {
            void video.play().catch(() => {
              /* 自动播放被拒：继续等事件/就绪超时 */
            });
          } catch {
            /* jsdom 未实现 play() */
          }
        } else if (fit === 'tile') {
          // 背景图没有加载事件：创建即计时，error 只在 <img> 分支可得。
          const tile = doc.createElement('div');
          tile.className = TILE_CLASS;
          tile.style.cssText =
            `position:absolute;inset:0;background-image:url("${asset.url.replace(/"/g, '%22')}");` +
            'background-repeat:repeat;background-position:center';
          el.appendChild(tile);
          started();
        } else {
          const img = doc.createElement('img');
          img.style.cssText = 'width:100%;height:100%;display:block';
          applyFit(img, fit);
          img.addEventListener('error', () => finish('failed'), { once: true });
          el.appendChild(img);
          img.src = asset.url;
          started(); // 不等 load：计时本就不依赖解码完成
        }
      } catch {
        finish('failed');
      }

      return promise;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      teardown('skipped');
    },
  };
}
