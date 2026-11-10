// 开机动画编排：读设置 → 判断是否播（开关 + 每页面会话一次）→ 组装素材 URL → 调 overlay。
// 失败一律静默（返回失败码供面板展示），不阻塞主界面、不抛异常。
import { createBootOverlay } from './boot-overlay.js';
import type { BootAsset, BootFitMode, BootOverlay, BootResult } from './boot-overlay.js';
import type { ClientSettings } from './types.js';
import { bootLocalVideoUrl, mediaFileUrl, mediaPreviewUrl } from '../shared/routes.js';

export const BOOT_PLAYED_KEY = 'we:boot-played';

const FIT_MODES: ReadonlySet<string> = new Set(['tile', 'contain', 'stretch', 'cover']);

export function normalizeBootFit(value: string): BootFitMode {
  return (FIT_MODES.has(value) ? value : 'cover') as BootFitMode;
}

export function bootAssetFromSettings(s: ClientSettings): BootAsset | null {
  if (s.bootAnimationSource === 'local') {
    const p = s.bootAnimationLocalPath.trim();
    return p ? { kind: 'video', url: bootLocalVideoUrl(p) } : null;
  }
  const id = s.bootAnimationWallpaperId.trim();
  const kind = s.bootAnimationWallpaperKind;
  if (!id || (kind !== 'video' && kind !== 'image')) return null;
  return kind === 'video'
    ? { kind: 'video', url: mediaFileUrl(id) }
    : { kind: 'image', url: mediaPreviewUrl(id) };
}

export function shouldPlayBoot(s: ClientSettings, storage: Pick<Storage, 'getItem'>): boolean {
  if (!s.bootAnimationEnabled) return false;
  try { return storage.getItem(BOOT_PLAYED_KEY) !== '1'; } catch { return true; }
}

export interface BootLastResult { result: BootResult; at: number; asset: BootAsset | null }

export interface BootPlayer {
  start(): Promise<BootResult>;
  play(opts?: { force?: boolean }): Promise<BootResult>;
  getLast(): BootLastResult | null;
  dispose(): void;
}

function sessionStorageSafe(): Pick<Storage, 'getItem' | 'setItem'> {
  try {
    if (typeof sessionStorage !== 'undefined') return sessionStorage;
  } catch { /* 隐私模式访问抛错 */ }
  return { getItem: () => null, setItem: () => {} };
}

export function createBootPlayer(opts: {
  readSettings: () => Promise<ClientSettings>;
  overlay?: BootOverlay;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  /** 真正播放区间回调（true = 开始播放、false = 结束）：供上层抑制壁纸声音等。 */
  onActiveChange?: (active: boolean) => void;
}): BootPlayer {
  const overlay = opts.overlay ?? createBootOverlay();
  const storage = opts.storage ?? sessionStorageSafe();
  let disposed = false;
  let last: BootLastResult | null = null;
  let running: Promise<BootResult> | null = null;

  const record = (result: BootResult, asset: BootAsset | null): BootResult => {
    last = { result, at: Date.now(), asset };
    return result;
  };

  async function run(force: boolean): Promise<BootResult> {
    if (disposed) return 'failed';
    let settings: ClientSettings;
    try { settings = await opts.readSettings(); } catch { return record('failed', null); }
    if (disposed) return 'failed';
    if (!force) {
      if (!settings.bootAnimationEnabled) return record('disabled', null);
      if (!shouldPlayBoot(settings, storage)) return record('already-played', null);
    }
    // 设置字段可能来自旧版本/手工写入的非 string：归一化失败按失败静默（不向调用方抛）。
    let asset: BootAsset | null;
    let fit: BootFitMode;
    try {
      asset = bootAssetFromSettings(settings);
      fit = normalizeBootFit(settings.bootAnimationFitMode);
    } catch {
      return record('failed', null);
    }
    if (!asset) return record('no-asset', null);
    if (!force) {
      try { storage.setItem(BOOT_PLAYED_KEY, '1'); } catch { /* 写不进就按播放处理，避免反复触发 */ }
    }
    // 真正播放区间：上层据此临时抑制壁纸声音（回调异常不得打断播放）。
    const setActive = (active: boolean): void => {
      if (typeof opts.onActiveChange !== 'function') return;
      try { opts.onActiveChange(active); } catch { /* 回调异常忽略 */ }
    };
    setActive(true);
    let result: BootResult;
    try {
      result = await overlay.play(asset, fit, settings.bootAnimationMaxDurationMs, {
        // 开机动画声音默认开；浏览器冷启动无手势时 overlay 内保持静音（自动播放策略）。
        soundEnabled: settings.bootAnimationSoundEnabled !== false,
        volume: settings.bootAnimationVolume ?? 1,
      });
    } catch {
      result = 'failed';
    } finally {
      setActive(false);
    }
    return record(result, asset);
  }

  return {
    start() {
      running ??= run(false).finally(() => { running = null; });
      return running;
    },
    play(opts) { return run(opts?.force ?? true); },
    getLast() { return last; },
    dispose() { disposed = true; overlay.dispose(); },
  };
}
