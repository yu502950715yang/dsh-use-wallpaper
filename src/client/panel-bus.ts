// 面板总线（审查 P0-10）：把设置面板与宿主之间的 8 个共享处理器与健康/媒体订阅收口到一个
// **可注入的 PanelBus 实例**，取代原先散落在 settings-section.tsx 的模块级可变变量。
// index.ts 创建并注入（setPanelBus）；测试可注入隔离实例（每个用例 new PanelBus()）避免跨用例泄漏。
import type { ClientSettings } from './types.js';
import type { HealthSnapshot } from './render-health.js';
import type { MediaFailure } from './media-health.js';
import type { MediaIntegrationStatus } from '../shared/media.js';
import type { VideoHealthSnapshot } from './video-health.js';
import type { SystemAudioFailure } from './system-audio.js';

// 系统音频（v0.9 P1）：浏览器模式经 getDisplayMedia 捕获系统音频驱动频谱；桌面 App 宿主禁用。
export interface SystemAudioHandlers {
  start(): Promise<SystemAudioFailure | 'ok'>;
  stop(): void;
}

/** 面板「实时渲染」卡片要的三件事：读状态、重试当前壁纸、清空全部失败记忆。 */
export interface WallpaperHealthHandler {
  get(): HealthSnapshot | null;
  retry(): void;
  clearFailures(): void;
}

/** 面板「媒体失败提示」要的两件事：读当前失败 / 清除。 */
export interface WallpaperMediaHandler {
  get(): MediaFailure | null;
  clear(): void;
}

/** 媒体集成状态（面板状态行）：由 index.ts 注入 renderer.getMediaStatus（只读、不含曲目）。 */
export interface WallpaperMediaIntegrationHandler {
  get(): MediaIntegrationStatus | null;
}

/** 视频壁纸健康状态行：index.ts 注入 layer.getVideoHealth（只读快照；非视频壁纸返回 null）。 */
export interface WallpaperVideoHealthHandler {
  get(): VideoHealthSnapshot | null;
}

export interface PanelHandlers {
  onSelect?: ((id: string) => void) | null;
  onRuntimeSettings?: ((patch: Partial<ClientSettings>) => void) | null;
  onReselect?: ((id: string) => void) | null;
  systemAudio?: SystemAudioHandlers | null;
  health?: WallpaperHealthHandler | null;
  media?: WallpaperMediaHandler | null;
  mediaIntegration?: WallpaperMediaIntegrationHandler | null;
  videoHealth?: WallpaperVideoHealthHandler | null;
}

export class PanelBus {
  private handlers: PanelHandlers = {};
  private readonly healthSubs = new Set<(s: HealthSnapshot | null) => void>();
  private readonly mediaSubs = new Set<(f: MediaFailure | null) => void>();

  /** 注册/覆盖处理器槽位（undefined 槽位保持现状；显式 null = 撤销该槽位）。 */
  setHandlers(patch: Partial<PanelHandlers>): void {
    Object.assign(this.handlers, patch);
    // 媒体 handler 变更时立即同步提示态（撤销 → 面板回「无失败」初始态）。
    if ('media' in patch) this.pushMedia(patch.media?.get() ?? null);
  }

  get(): PanelHandlers {
    return this.handlers;
  }

  subscribeHealth(cb: (s: HealthSnapshot | null) => void): () => void {
    this.healthSubs.add(cb);
    return () => { this.healthSubs.delete(cb); };
  }

  notifyHealth(snap: HealthSnapshot | null): void {
    for (const cb of Array.from(this.healthSubs)) {
      try { cb(snap); } catch { /* 单个订阅者异常不影响其它订阅者 */ }
    }
  }

  subscribeMedia(cb: (failure: MediaFailure | null) => void): () => void {
    this.mediaSubs.add(cb);
    return () => { this.mediaSubs.delete(cb); };
  }

  /** handler 未注册时不推（面板已回初始态，迟到的失败不得复活提示）。 */
  notifyMedia(failure: MediaFailure | null): void {
    if (!this.handlers.media) return;
    this.pushMedia(failure);
  }

  private pushMedia(failure: MediaFailure | null): void {
    for (const cb of Array.from(this.mediaSubs)) {
      try { cb(failure); } catch { /* 单个订阅者异常不影响其它订阅者 */ }
    }
  }
}
