import type { ClientSettings } from './types.js';
import type { WallpaperInfo } from '../shared/types.js';
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
}
export declare function BootSettingsSection(props: BootSettingsSectionProps): JSX.Element;
export {};
