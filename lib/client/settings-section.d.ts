import type { ClientSettings } from './types.js';
import type { WallpaperInfo, ProbeResult } from '../shared/types.js';
import { type WallpaperPropertiesResponse } from './wallpaper-properties.js';
import type { HealthSnapshot } from './render-health.js';
import type { MediaIntegrationStatus } from '../shared/media.js';
import type { MediaFailure } from './media-health.js';
import type { VideoHealthSnapshot } from './video-health.js';
export interface WallpaperSettingsSectionProps {
    /** 读取当前设置（默认 RPC settings.describe） */
    fetchSettings?: () => Promise<ClientSettings>;
    /** 持久化设置（默认 RPC settings.update）；返回 false = 未写入（服务端拒绝/无可用命名空间） */
    writeSettings?: (patch: Partial<ClientSettings>) => Promise<boolean | void>;
    /** 拉取壁纸列表（refresh 时带 ?refresh=1 强制重扫） */
    fetchWallpapers?: (opts?: {
        refresh?: boolean;
    }) => Promise<WallpaperInfo[]>;
    /** 自动探测候选路径（默认 GET /wallpapers/probe） */
    fetchProbe?: () => Promise<ProbeResult>;
    /** 拉取当前 scene 壁纸的用户属性（默认 GET /wallpapers/properties） */
    fetchProperties?: (id: string) => Promise<WallpaperPropertiesResponse>;
    /** 切换/取消壁纸（index.ts 注入 controller.select，空 id = 取消） */
    onSelect?: (id: string) => void;
    /** 用户属性切换后重装配当前壁纸（默认走共享 handler 的 controller.select） */
    onReselect?: (id: string) => void;
    /** 运行期设置（光晕参数/暂停/画质档位）变更：index.ts 注入后立即下发给渲染器，无需重选壁纸 */
    onRuntimeSettings?: (patch: Partial<ClientSettings>) => void;
    /** 当前壁纸的渲染健康快照（由 index.ts 经 subscribeWallpaperHealth 推送；null = 还没选壁纸） */
    health?: HealthSnapshot | null;
    /** 重试实时渲染（默认走共享 handler 的 retry） */
    onRetryLive?: () => void;
    /** 清空失败记忆（默认走共享 handler 的 clearFailures） */
    onClearRenderFailures?: () => void;
}
import { PanelBus } from './panel-bus.js';
import type { SystemAudioHandlers, WallpaperHealthHandler, WallpaperMediaHandler, WallpaperMediaIntegrationHandler, WallpaperVideoHealthHandler } from './panel-bus.js';
export type { SystemAudioHandlers, WallpaperHealthHandler, WallpaperMediaHandler, WallpaperMediaIntegrationHandler, WallpaperVideoHealthHandler, } from './panel-bus.js';
/** 注入面板总线（null = 卸载；下次访问自动建临时实例，保证组件不崩）。 */
export declare function setPanelBus(bus: PanelBus | null): void;
/** 当前总线（未注入时懒建临时实例——仅测试/异常路径会遇到）。 */
export declare function getPanelBus(): PanelBus;
export declare function setWallpaperSelectHandler(fn: ((id: string) => void) | null): void;
export declare function setWallpaperRuntimeHandler(fn: ((patch: Partial<ClientSettings>) => void) | null): void;
export declare function setWallpaperReselectHandler(handler: ((id: string) => void) | null): void;
export declare function setWallpaperSystemAudioHandlers(handlers: SystemAudioHandlers | null): void;
export declare function setWallpaperHealthHandler(handler: WallpaperHealthHandler | null): void;
export declare function subscribeWallpaperHealth(cb: (s: HealthSnapshot | null) => void): () => void;
export declare function notifyWallpaperHealth(snap: HealthSnapshot | null): void;
export declare function setWallpaperMediaHandler(handler: WallpaperMediaHandler | null): void;
export declare function subscribeWallpaperMedia(cb: (failure: MediaFailure | null) => void): () => void;
export declare function notifyWallpaperMedia(failure: MediaFailure | null): void;
export declare function setWallpaperMediaIntegrationHandler(handler: WallpaperMediaIntegrationHandler | null): void;
export declare function setWallpaperVideoHealthHandler(handler: WallpaperVideoHealthHandler | null): void;
/** 状态行文案：分辨率 · 实测帧率 · 近 1s 丢帧 · 最近循环停顿 · 状态。 */
export declare function formatVideoHealthLine(h: VideoHealthSnapshot): string;
/** 面板状态行文案：启用时给隐私说明；失败 reason 给明确原因（不显示曲目信息）。 */
export declare function mediaIntegrationHint(enabled: boolean, status: MediaIntegrationStatus | null): string;
export declare function WallpaperSettingsSection(props: WallpaperSettingsSectionProps): JSX.Element;
