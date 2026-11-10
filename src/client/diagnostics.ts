// 诊断信息：面板「关于」区的「复制诊断信息」——用户提 issue 时贴一段即可定位环境，
// 降低来回追问成本（1.0 可观测性）。
//
// 隐私边界：只输出「目录是否已配置」（布尔），不输出真实路径；不含曲目名/封面/个人数据。

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
export function buildDiagnosticsText(input: DiagnosticsInput): string {
  return JSON.stringify({
    plugin: {
      version: input.pluginVersion,
      webgl2: input.hasWebGL2,
      mediaIntegrationEnabled: input.mediaIntegrationEnabled ?? null,
    },
    host: { userAgent: input.ua },
    wallpaper: input.wallpaper
      ? { id: input.wallpaper.id, kind: input.wallpaper.kind, title: input.wallpaper.title }
      : null,
    config: {
      wallpaperDirConfigured: input.wallpaperDirConfigured,
      weAssetsDirConfigured: input.weAssetsDirConfigured,
    },
    health: input.health,
    videoHealth: input.videoHealth,
    copiedAt: new Date().toISOString(),
  }, null, 2);
}

/**
 * 复制文本到剪贴板：优先 Clipboard API，失败时降级为隐藏 textarea + execCommand。
 * 返回值 = 是否成功（面板据此给用户反馈，不静默）。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒 / 非安全上下文 → 走降级
  }
  if (typeof document === 'undefined') return false;
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
