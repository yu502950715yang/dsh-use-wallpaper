// 媒体编排：装配期初始派发（首帧前隐藏媒体层）、轮询快照 → 脚本事件、运行期开关/暂停/释放。
// 纯逻辑 + 注入（host/bindings/输入工厂/脏写入应用），不依赖 three/Node，renderer 只做接线。
import type {
  MediaIntegrationStatus, MediaPlaybackState, MediaPropertiesPayload,
} from '../shared/media.js';
import { applyMediaSnapshot } from './media-input.js';
import type { MediaDispatchSink, MediaInput, MediaInputOptions, MediaThumbnailEventPayload } from './media-input.js';
import type { DisplayTarget, LayerWrite } from './layer-state.js';
import type { MediaThumbnailPayload } from './scene-script-vm.js';

/** 媒体事件/开关的宿主落点（生产 = SceneScriptHost；测试注入 fake）。 */
export interface MediaOrchestrationHost {
  mediaStatus(enabled: boolean): void;
  mediaPlayback(state: MediaPlaybackState): void;
  mediaProperties(props: MediaPropertiesPayload): void;
  mediaThumbnail(thumb: MediaThumbnailPayload): void;
  applyExternal(writes: Map<number, LayerWrite>): void;
  drainDirty(): Map<number, LayerWrite>;
}

/** 事件通道上的文本脚本 binding（只需这一个方法）。 */
export interface MediaScriptBinding {
  dispatchMediaProperties(props: MediaPropertiesPayload): void;
}

export type MediaObjectLookup = (objectId: number) => DisplayTarget | undefined;

export interface MediaOrchestrationOptions {
  host: MediaOrchestrationHost;
  bindings: readonly MediaScriptBinding[];
  /** 输入工厂（生产 = createMediaInput；测试注入 fake，不碰网络/定时器）。 */
  createInput: (opts: MediaInputOptions) => MediaInput;
  /** 把脚本脏写入落到渲染对象（生产 = applyLayerState(…, lookup)）。 */
  applyDirty: (dirty: Map<number, LayerWrite>, lookup: MediaObjectLookup) => void;
  lookup: MediaObjectLookup;
  /** 媒体集成开关当前值（面板下发后由 renderer 维护）；调用 setEnabled 前必须先更新它。 */
  getEnabled: () => boolean;
  /** 封面事件改写（Task 8 主色/纹理）；返回 null = 由调用方异步处理并自行派发（编排不再派发中性色）。 */
  onThumbnail?: (payload: MediaThumbnailEventPayload) => MediaThumbnailPayload | null;
  /** 单个消费者异常（host/binding/脏写入）不阻断其余派发。 */
  onError?: (error: unknown) => void;
  /** 透传输入的 pageTitle/intervalMs 等；onSnapshot/onError 由编排接管。 */
  inputOptions?: Omit<MediaInputOptions, 'onSnapshot' | 'onError'>;
}

export interface MediaOrchestration {
  /** 初始派发（status → stopped → 脏写入落地）并在启用时启动轮询；重复调用 no-op。 */
  start(): void;
  /** 面板开关：关闭 = status(false)+stopped+停轮询；开启 = status(true)+重开轮询（首帧重放快照）。 */
  setEnabled(enabled: boolean): void;
  /** 省电暂停：转发给输入；恢复时仅在启用态重新启动。 */
  setPaused(paused: boolean): void;
  /** 释放输入（幂等）；之后的迟到响应全部忽略。 */
  dispose(): void;
  /** 面板只读状态（available/reason/enabled；不含曲目/封面）。 */
  getStatus(): MediaIntegrationStatus;
}

export function createMediaOrchestration(opts: MediaOrchestrationOptions): MediaOrchestration {
  const { host, bindings } = opts;
  let started = false;
  let disposed = false;
  let paused = false;
  let input: MediaInput | null = null;
  // 面板状态：只记 reason/available/enabled；绝不缓存 title/artist（隐私）。
  let status: MediaIntegrationStatus = {
    available: false,
    reason: opts.getEnabled() ? 'no-session' : 'disabled',
    enabled: opts.getEnabled(),
  };

  const report = (error: unknown): void => {
    try { opts.onError?.(error); } catch { /* 错误消费者异常不阻断媒体链路 */ }
  };
  const safely = (fn: () => void): void => {
    try { fn(); } catch (error) { report(error); }
  };

  const neutralThumbnail = (payload: MediaThumbnailEventPayload): MediaThumbnailPayload => ({
    hasThumbnail: payload.hasThumbnail,
    primaryColor: payload.palette.primary,
    secondaryColor: payload.palette.secondary,
    tertiaryColor: payload.palette.tertiary,
    textColor: payload.palette.text,
    highContrastColor: payload.palette.highContrast,
  });

  const sink: MediaDispatchSink = {
    status: (enabled) => safely(() => host.mediaStatus(enabled)),
    playback: (state) => safely(() => host.mediaPlayback(state)),
    properties: (props) => {
      safely(() => host.mediaProperties(props));
      // 文本脚本 binding 逐个隔离：一个脚本异常不影响其余 binding 与后续 thumbnail。
      for (const binding of bindings) safely(() => binding.dispatchMediaProperties(props));
    },
    thumbnail: (payload) => safely(() => {
      const mapped = opts.onThumbnail ? opts.onThumbnail(payload) : neutralThumbnail(payload);
      if (mapped) host.mediaThumbnail(mapped);
    }),
  };

  const applyDirty = (): void => safely(() => opts.applyDirty(host.drainDirty(), opts.lookup));

  const ensureInput = (): MediaInput => {
    if (input) return input;
    const created = opts.createInput({
      ...opts.inputOptions,
      onSnapshot: (next, prev) => {
        if (disposed) return; // dispose 后迟到响应不得落到已释放的 host/脚本
        // 快照先记状态（reason 只用于面板提示，不含曲目字段）。
        status = { ...status, available: next.available, reason: next.reason };
        applyMediaSnapshot(prev, next, sink);
      },
      onError: report,
    });
    input = created;
    return created;
  };

  return {
    start() {
      if (started || disposed) return;
      started = true;
      const enabled = opts.getEnabled();
      status = { available: false, reason: enabled ? 'no-session' : 'disabled', enabled };
      sink.status(enabled);
      sink.playback('stopped');
      applyDirty(); // 必须在首帧前同步落地（否则媒体层先画一帧白色占位）
      if (!enabled) return; // 关闭态只派事件、不建轮询
      const active = ensureInput();
      if (!paused) active.start();
    },
    setEnabled(enabled) {
      if (disposed) return;
      status = { available: false, reason: enabled ? 'no-session' : 'disabled', enabled };
      sink.status(enabled);
      if (!enabled) {
        sink.playback('stopped');
        input?.stop();
        applyDirty();
        return;
      }
      const active = ensureInput();
      // stop() 已清 prev ⇒ 首个 poll 按首帧重放完整快照（status/playback/properties/thumbnail）。
      if (!paused) active.start();
    },
    setPaused(value) {
      if (disposed || value === paused) return;
      paused = value;
      if (!input) return; // 输入尚未创建：启用/start 时按 paused 决定是否启动
      input.setPaused(value);
      if (!value && opts.getEnabled()) input.start();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const active = input;
      input = null;
      active?.dispose();
    },
    getStatus() {
      return { ...status };
    },
  };
}
