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
  doc?: Document;
}

const LAYER_CLASS = 'wp-boot-layer';
const TILE_CLASS = 'wp-boot-tile';
const Z_INDEX = 2147483000;

type TimerHandle = ReturnType<typeof setTimeout>;

interface ActivePlay {
  el: HTMLElement;
  video: HTMLVideoElement | null;
  resolve: (result: BootResult) => void;
  /** 非 null = 结果已定、正在淡出。 */
  result: BootResult | null;
  readyTimer: TimerHandle | null;
}

export function createBootOverlay(opts: BootOverlayOptions = {}): BootOverlay {
  const doc = opts.doc ?? document;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 8000;
  const fadeMs = opts.fadeMs ?? 300;
  const imageDurationMs = opts.imageDurationMs ?? 4000;

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
      const entry: ActivePlay = { el, video: null, resolve, result: null, readyTimer: null };
      active = entry;
      attachSkip();
      entry.readyTimer = later(() => finish('timeout'), readyTimeoutMs);

      // 首帧就绪（或图片创建完成）后开始计时；视频 maxDurationMs=0 时等 ended。
      const started = (): void => {
        if (active !== entry || entry.result !== null) return;
        cancel(entry.readyTimer);
        entry.readyTimer = null;
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
          video.style.cssText = 'width:100%;height:100%;border:0;display:block';
          applyFit(video, fit);
          video.addEventListener('loadeddata', started, { once: true });
          video.addEventListener('ended', () => finish('ended'), { once: true });
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
