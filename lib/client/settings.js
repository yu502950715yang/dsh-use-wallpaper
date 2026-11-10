// DSH 0.1.2-rc.1 起设置系统改用 Typert 远程方法（ctx.remote.settings）：
// describe() 读取、update(ns, patch, revision) 深合并写入——取代旧版
// fetch('/api/settings.describe') 的 client-request RPC（新版已不识别该接口，
// 导致设置读写静默回退默认值 → 保存丢失/刷新后壁纸消失）。
// 插件 client 须在 index.ts 的 inject 声明 'remote','remote.settings'，并在
// bootstrap 时 setSettingsCtx(ctx)，使本模块能经 ctx.remote.settings 访问。
//
// ns：1.0 起只支持 DSH ≥0.1.7 的设置命名空间（= profile 条目 id `dsh-wallpaper-engine`）。
// ≤0.1.6 的旧短名 `wallpaper-engine` 回退已随 1.0 移除（AGENT.md §7.34）。
const NS = 'dsh-wallpaper-engine';
export const DEFAULTS = {
    selectedWallpaperId: '', wallpaperDir: '', weAssetsDir: '',
    overlayOpacity: 0.35, blurEnabled: false, blurRadius: 12, kenBurns: true,
    // 光晕默认值 = 2026-09-21 用户在真机面板上定档（低阈值保留光晕、低强度压住过曝；
    // 旧 A 档 0.65/1.0 在亮部多的壁纸上过曝，见 AGENT.md §7.1）。
    glowEnabled: true, glowThreshold: 0.65, glowStrength: 0.35,
    paused: false, pauseOnHidden: true, qualityScale: 1,
    // 壁纸音效（sound 对象 + 频谱驱动效果）：默认开启，与桌面 WE 一致；面板可关。
    soundEnabled: true,
    // 壁纸声音音量（scene sound 对象 + 视频壁纸共用）：默认 1，不改变既有听感。
    soundVolume: 1,
    // 媒体集成（Windows SMTC 只读，默认开启；数据仅内存、不落盘、不上传）。
    mediaIntegrationEnabled: true,
    // 文字可读性（2026-10-01）：默认 auto + 无描边 = 与加此功能前的老用户观感一致（零回归）。
    textColorMode: 'auto', textColor: '#ffffff', textOutline: 0,
    // v0.8 显示/轮播：默认 cover / 关闭轮播 / 5 分钟 / 顺序 / 开帧缓存。
    fitMode: 'cover', rotationEnabled: false, rotationIntervalMs: 300000,
    rotationOrder: 'sequential', frameCacheEnabled: true,
    bootAnimationEnabled: false, bootAnimationSource: 'we',
    bootAnimationWallpaperId: '', bootAnimationWallpaperKind: '',
    bootAnimationLocalPath: '', bootAnimationFitMode: 'cover',
    bootAnimationMaxDurationMs: 6000,
    // 开机动画声音（2026-11-04）：默认开；桌面壳直接出声，浏览器无手势时保持静音。
    bootAnimationSoundEnabled: true,
    // 开机动画音量：默认 1。
    bootAnimationVolume: 1,
    // 纹理解压预算（1.0 S3；与 tex-loader.DEFAULT_TEX_BUDGET 保持一致，profile config 可调）
    texMaxMipBytes: 512 * 1024 * 1024,
    texMaxTextureBytes: 1024 * 1024 * 1024,
    texMaxMipCount: 4096,
    texMaxDimension: 16384,
};
/** client cordis ctx（经 setSettingsCtx 注入，供 remote.settings 访问）。 */
let settingsCtx = null;
// 上次**成功**读取的值：describe 瞬时失败（网络抖动 / 热重载）时沿用它，**不回 DEFAULTS**
// —— DEFAULTS.glowEnabled = true，回默认会把用户明确关掉的 Glow 悄悄重新打开（约 12 MB 显存 + 每帧开销）。
let lastGood = null;
/** 注入 client ctx：bootstrap(ctx) 时调用；无 ctx（node 测试/SSR）时回退默认值。 */
export function setSettingsCtx(ctx) {
    settingsCtx = ctx;
    lastGood = null; // ctx 换了（bootstrap / 换实例）⇒ 旧缓存不可信
}
function settingsRemote() {
    return settingsCtx?.remote?.settings ?? null;
}
export async function readClientSettings() {
    const remote = settingsRemote();
    if (remote) {
        try {
            const resp = await remote.describe();
            const value = resp?.ok ? resp.value : undefined;
            if (typeof value === 'object' && value !== null) {
                const namespaces = value.namespaces;
                const nsValue = namespaces?.find((n) => n.ns === NS)?.value;
                if (typeof nsValue === 'object' && nsValue !== null) {
                    // 未给的字段由「上次成功值（首次则 DEFAULTS）」补齐：一次读到残缺值也不该翻掉已知的开关。
                    lastGood = { ...(lastGood ?? DEFAULTS), ...nsValue };
                    return { ...lastGood };
                }
            }
        }
        catch {
            // 读取失败 → 沿用上次成功值
        }
    }
    return { ...(lastGood ?? DEFAULTS) };
}
/** 写入成功返回 true；失败返回 false（供面板提示，不再谎报已保存）。 */
export async function writeClientSettings(patch) {
    const remote = settingsRemote();
    if (!remote)
        return false;
    try {
        // update(ns, patch, revision)：revision 不传（undefined）→ 无条件写。
        const resp = await remote.update(NS, patch, undefined);
        if (resp && resp.ok === false) {
            console.warn(`[wallpaper-engine] 设置写入失败（ns=${NS}）：`, resp.error);
            return false;
        }
        return true;
    }
    catch (error) {
        console.warn(`[wallpaper-engine] 设置写入失败（ns=${NS}）：`, error);
        return false;
    }
}
// WE 用户属性读取（T4.2）：scene.json 的 visible:{user,value} 绑定按 key 查询用户
// 切换值。插件设置（ClientSettings）不含壁纸级用户属性存储——轻量实现用
// localStorage 持久化（键 we:userprop:<wallpaperId>:<key>，JSON 值；旧版全局键
// we:userprop:<key> 仅作读回退，迁移兼容）。无存储环境（node 测试/SSR）/键缺失/解析失败
// → undefined（装配期视为未设置，绑定回退作者 value，不误杀对象）。
// 注：本函数不直接供 renderScene 调用——渲染器直接查本函数聚成 userProps
// （见 three-renderer.ts），测试可注入 stub 而不依赖存储。
export const USERPROP_PREFIX = 'we:userprop:';
export function getUserPropertyValue(key, wallpaperId) {
    if (typeof localStorage === 'undefined')
        return undefined;
    // 隐私模式/禁用存储时 getItem 可能抛 SecurityError ⇒ 兜底 undefined（面板不崩，绑定回退作者值）P1
    let raw;
    try {
        // 带 id 时 per-wallpaper 键优先；缺失回退旧全局键（升级前的用户覆盖值仍生效）。
        const scoped = wallpaperId ? localStorage.getItem(USERPROP_PREFIX + wallpaperId + ':' + key) : null;
        raw = scoped ?? localStorage.getItem(USERPROP_PREFIX + key);
    }
    catch {
        return undefined;
    }
    if (raw === null)
        return undefined;
    try {
        const value = JSON.parse(raw);
        // 四类型值只认 JSON 标量；null/对象/数组按坏值处理（下游回退默认值）。
        return typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string'
            ? value
            : undefined;
    }
    catch {
        return undefined;
    }
}
