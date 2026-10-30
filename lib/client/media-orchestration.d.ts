import type { MediaPlaybackState, MediaPropertiesPayload } from '../shared/media.js';
import type { MediaInput, MediaInputOptions, MediaThumbnailEventPayload } from './media-input.js';
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
    /** 封面事件改写（Task 8 主色/纹理）；缺省派发中性调色板。 */
    onThumbnail?: (payload: MediaThumbnailEventPayload) => MediaThumbnailPayload;
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
}
export declare function createMediaOrchestration(opts: MediaOrchestrationOptions): MediaOrchestration;
