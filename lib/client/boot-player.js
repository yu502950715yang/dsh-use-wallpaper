// 开机动画编排：读设置 → 判断是否播（开关 + 每页面会话一次）→ 组装素材 URL → 调 overlay。
// 失败一律静默（返回失败码供面板展示），不阻塞主界面、不抛异常。
import { createBootOverlay } from './boot-overlay.js';
export const BOOT_PLAYED_KEY = 'we:boot-played';
const FIT_MODES = new Set(['tile', 'contain', 'stretch', 'cover']);
export function normalizeBootFit(value) {
    return (FIT_MODES.has(value) ? value : 'cover');
}
export function bootAssetFromSettings(s) {
    if (s.bootAnimationSource === 'local') {
        const p = s.bootAnimationLocalPath.trim();
        return p ? { kind: 'video', url: '/wallpapers/boot/local-video?path=' + encodeURIComponent(p) } : null;
    }
    const id = s.bootAnimationWallpaperId.trim();
    const kind = s.bootAnimationWallpaperKind;
    if (!id || (kind !== 'video' && kind !== 'image'))
        return null;
    return kind === 'video'
        ? { kind: 'video', url: `/wallpapers/media/${encodeURIComponent(id)}/file` }
        : { kind: 'image', url: `/wallpapers/media/${encodeURIComponent(id)}/preview` };
}
export function shouldPlayBoot(s, storage) {
    if (!s.bootAnimationEnabled)
        return false;
    try {
        return storage.getItem(BOOT_PLAYED_KEY) !== '1';
    }
    catch {
        return true;
    }
}
function sessionStorageSafe() {
    try {
        if (typeof sessionStorage !== 'undefined')
            return sessionStorage;
    }
    catch { /* 隐私模式访问抛错 */ }
    return { getItem: () => null, setItem: () => { } };
}
export function createBootPlayer(opts) {
    const overlay = opts.overlay ?? createBootOverlay();
    const storage = opts.storage ?? sessionStorageSafe();
    let disposed = false;
    let last = null;
    let running = null;
    const record = (result, asset) => {
        last = { result, at: Date.now(), asset };
        return result;
    };
    async function run(force) {
        if (disposed)
            return 'failed';
        let settings;
        try {
            settings = await opts.readSettings();
        }
        catch {
            return record('failed', null);
        }
        if (disposed)
            return 'failed';
        if (!force) {
            if (!settings.bootAnimationEnabled)
                return record('disabled', null);
            if (!shouldPlayBoot(settings, storage))
                return record('already-played', null);
        }
        const asset = bootAssetFromSettings(settings);
        if (!asset)
            return record('no-asset', null);
        if (!force) {
            try {
                storage.setItem(BOOT_PLAYED_KEY, '1');
            }
            catch { /* 写不进就按播放处理，避免反复触发 */ }
        }
        let result;
        try {
            result = await overlay.play(asset, normalizeBootFit(settings.bootAnimationFitMode), settings.bootAnimationMaxDurationMs);
        }
        catch {
            result = 'failed';
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
