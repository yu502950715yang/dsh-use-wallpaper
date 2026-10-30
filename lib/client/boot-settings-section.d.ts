import type { ClientSettings } from './types.js';
import type { WallpaperInfo } from '../shared/types.js';
declare global {
    interface Window {
        __DSH_HOST_PATHS__?: {
            pathFor(file: File): string;
        };
    }
}
interface ProbeInfo {
    ok: boolean;
    exists?: boolean;
    isFile?: boolean;
    size?: number;
    playable?: boolean;
    error?: string;
}
export interface BootSettingsSectionProps {
    fetchSettings?: () => Promise<ClientSettings>;
    writeSettings?: (patch: Partial<ClientSettings>) => Promise<boolean | void>;
    fetchWallpapers?: () => Promise<WallpaperInfo[]>;
    probePath?: (path: string) => Promise<ProbeInfo>;
    playPreview?: () => Promise<string>;
    getLast?: () => {
        result: string;
        at: number;
    } | null;
    /** 系统文件选择器 → 绝对路径；null = 当前环境不支持（回退手填）。默认用桌面壳 hostPaths API。 */
    pickLocalFile?: (() => Promise<string | null>) | null;
}
export declare function BootSettingsSection(props: BootSettingsSectionProps): JSX.Element;
export {};
