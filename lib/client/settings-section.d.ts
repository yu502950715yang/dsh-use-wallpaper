import type { ClientSettings } from './types.js';
import type { WallpaperInfo, ProbeResult } from '../shared/types.js';
import type { HealthSnapshot } from './render-health.js';
export interface WallpaperSettingsSectionProps {
    /** 读取当前设置（默认 RPC settings.describe） */
    fetchSettings?: () => Promise<ClientSettings>;
    /** 持久化设置（默认 RPC settings.update）；返回 false = 未写入（服务端拒绝/无可用命名空间） */
    writeSettings?: (patch: Partial<ClientSettings>) => Promise<boolean | void>;
    /** 拉取壁纸列表（默认 GET /wallpapers/list） */
    fetchWallpapers?: () => Promise<WallpaperInfo[]>;
    /** 自动探测候选路径（默认 GET /wallpapers/probe） */
    fetchProbe?: () => Promise<ProbeResult>;
    /** 切换/取消壁纸（index.ts 注入 controller.select，空 id = 取消） */
    onSelect?: (id: string) => void;
    /** 运行期设置（光晕参数/暂停/画质档位）变更：index.ts 注入后立即下发给渲染器，无需重选壁纸 */
    onRuntimeSettings?: (patch: Partial<ClientSettings>) => void;
    /** 当前壁纸的渲染健康快照（由 index.ts 经 subscribeWallpaperHealth 推送；null = 还没选壁纸） */
    health?: HealthSnapshot | null;
    /** 重试实时渲染（默认走共享 handler 的 retry） */
    onRetryLive?: () => void;
    /** 清空失败记忆（默认走共享 handler 的 clearFailures） */
    onClearRenderFailures?: () => void;
}
export declare function setWallpaperSelectHandler(fn: (id: string) => void): void;
export declare function setWallpaperRuntimeHandler(fn: (patch: Partial<ClientSettings>) => void): void;
/** 面板「实时渲染」卡片要的三件事：读状态、重试当前壁纸、清空全部失败记忆。 */
export interface WallpaperHealthHandler {
    get(): HealthSnapshot | null;
    retry(): void;
    clearFailures(): void;
}
/** 注册/撤销共享 handler（传 null = 撤销：面板回退到「读不到状态」的初始态）。 */
export declare function setWallpaperHealthHandler(handler: WallpaperHealthHandler | null): void;
/** 订阅健康变化（组件挂载时订阅、卸载时退订；index.ts 调 notifyWallpaperHealth 推送）。 */
export declare function subscribeWallpaperHealth(cb: (s: HealthSnapshot | null) => void): () => void;
/** 由 index.ts 的健康事件调用；也用于组件挂载时补一次当前值。 */
export declare function notifyWallpaperHealth(snap: HealthSnapshot | null): void;
export declare function WallpaperSettingsSection(props: WallpaperSettingsSectionProps): JSX.Element;
