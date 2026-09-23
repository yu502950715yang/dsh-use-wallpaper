import type { ClientSettings } from './types.js';
import type { WallpaperInfo, ProbeResult } from '../shared/types.js';
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
}
export declare function setWallpaperSelectHandler(fn: (id: string) => void): void;
export declare function setWallpaperRuntimeHandler(fn: (patch: Partial<ClientSettings>) => void): void;
export declare function WallpaperSettingsSection(props: WallpaperSettingsSectionProps): JSX.Element;
