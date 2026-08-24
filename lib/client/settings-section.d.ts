import type { ClientSettings } from './types.js';
import type { WallpaperInfo, ProbeResult } from '../shared/types.js';
export interface WallpaperSettingsSectionProps {
    /** 读取当前设置（默认 RPC settings.describe） */
    fetchSettings?: () => Promise<ClientSettings>;
    /** 持久化设置（默认 RPC settings.update） */
    writeSettings?: (patch: Partial<ClientSettings>) => Promise<void>;
    /** 拉取壁纸列表（默认 GET /wallpapers/list） */
    fetchWallpapers?: () => Promise<WallpaperInfo[]>;
    /** 自动探测候选路径（默认 GET /wallpapers/probe） */
    fetchProbe?: () => Promise<ProbeResult>;
    /** 切换/取消壁纸（index.ts 注入 controller.select，空 id = 取消） */
    onSelect?: (id: string) => void;
}
export declare function setWallpaperSelectHandler(fn: (id: string) => void): void;
export declare function WallpaperSettingsSection(props: WallpaperSettingsSectionProps): JSX.Element;
