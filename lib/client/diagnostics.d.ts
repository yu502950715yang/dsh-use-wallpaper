import type { HealthSnapshot } from './render-health.js';
import type { VideoHealthSnapshot } from './video-health.js';
export interface DiagnosticsWallpaper {
    id: string;
    kind: string;
    title: string;
}
export interface DiagnosticsInput {
    pluginVersion: string;
    ua: string;
    hasWebGL2: boolean | null;
    health: HealthSnapshot | null;
    videoHealth: VideoHealthSnapshot | null;
    wallpaper: DiagnosticsWallpaper | null;
    wallpaperDirConfigured: boolean;
    weAssetsDirConfigured: boolean;
    mediaIntegrationEnabled?: boolean;
}
/** 组装诊断 JSON（美化 2 空格，便于直接贴 issue）。 */
export declare function buildDiagnosticsText(input: DiagnosticsInput): string;
/**
 * 复制文本到剪贴板：优先 Clipboard API，失败时降级为隐藏 textarea + execCommand。
 * 返回值 = 是否成功（面板据此给用户反馈，不静默）。
 */
export declare function copyText(text: string): Promise<boolean>;
