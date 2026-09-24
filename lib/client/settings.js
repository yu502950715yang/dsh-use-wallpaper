// DSH 0.1.2-rc.1 起设置系统改用 Typert 远程方法（ctx.remote.settings）：
// describe() 读取、update(ns, patch, revision) 深合并写入——取代旧版
// fetch('/api/settings.describe') 的 client-request RPC（新版已不识别该接口，
// 导致设置读写静默回退默认值 → 保存丢失/刷新后壁纸消失）。
// 插件 client 须在 index.ts 的 inject 声明 'remote','remote.settings'，并在
// bootstrap 时 setSettingsCtx(ctx)，使本模块能经 ctx.remote.settings 访问。
//
// ns：≤0.1.6 = 插件短名 `wallpaper-engine`，≥0.1.7 = profile 条目 id `dsh-wallpaper-engine`
// ⇒ 按候选探测，命中后记住写回。
const NS_CANDIDATES = ['dsh-wallpaper-engine', 'wallpaper-engine'];
export const DEFAULTS = {
    selectedWallpaperId: '', wallpaperDir: '', weAssetsDir: '',
    overlayOpacity: 0.35, blurEnabled: false, blurRadius: 12, kenBurns: true,
    // 光晕默认值 = 2026-09-21 用户在真机面板上定档（低阈值保留光晕、低强度压住过曝；
    // 旧 A 档 0.65/1.0 在亮部多的壁纸上过曝，见 AGENT.md §7.1）。
    glowEnabled: true, glowThreshold: 0.65, glowStrength: 0.35,
    paused: false, pauseOnHidden: true, qualityScale: 1,
    // 壁纸音效（sound 对象 + 频谱驱动效果）：默认开启，与桌面 WE 一致；面板可关。
    soundEnabled: true,
};
/** client cordis ctx（经 setSettingsCtx 注入，供 remote.settings 访问）。 */
let settingsCtx = null;
// 上次**成功**读取的值：describe 瞬时失败（网络抖动 / 热重载）时沿用它，**不回 DEFAULTS**
// —— DEFAULTS.glowEnabled = true，回默认会把用户明确关掉的 Glow 悄悄重新打开（约 12 MB 显存 + 每帧开销）。
let lastGood = null;
/** 最近一次 describe 命中的命名空间（写入优先用它，避免写错版本）。 */
let activeNs = null;
/** 注入 client ctx：bootstrap(ctx) 时调用；无 ctx（node 测试/SSR）时回退默认值。 */
export function setSettingsCtx(ctx) {
    settingsCtx = ctx;
    lastGood = null; // ctx 换了（bootstrap / 换实例）⇒ 旧缓存不可信
    activeNs = null;
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
                // 候选顺序 = 条目 id 优先（0.1.7），再退旧短名（≤0.1.6）；只认实际存在的那一行。
                for (const ns of NS_CANDIDATES) {
                    const nsValue = namespaces?.find((n) => n.ns === ns)?.value;
                    if (typeof nsValue === 'object' && nsValue !== null) {
                        activeNs = ns;
                        // 未给的字段由「上次成功值（首次则 DEFAULTS）」补齐：一次读到残缺值也不该翻掉已知的开关。
                        lastGood = { ...(lastGood ?? DEFAULTS), ...nsValue };
                        return { ...lastGood };
                    }
                }
            }
        }
        catch {
            // 读取失败 → 沿用上次成功值
        }
    }
    return { ...(lastGood ?? DEFAULTS) };
}
/** 写入成功返回 true；全部候选 ns 都失败返回 false（供面板提示，不再谎报已保存）。 */
export async function writeClientSettings(patch) {
    const remote = settingsRemote();
    if (!remote)
        return false;
    // 写入顺序：最近读到的 ns 优先，其余候选按序兜底（未读先写时也能落到正确版本）。
    const order = activeNs
        ? [activeNs, ...NS_CANDIDATES.filter((n) => n !== activeNs)]
        : [...NS_CANDIDATES];
    let lastError;
    for (const ns of order) {
        try {
            // update(ns, patch, revision)：revision 不传（undefined）→ 无条件写。
            const resp = await remote.update(ns, patch, undefined);
            if (resp && resp.ok === false) {
                lastError = resp.error;
                continue;
            }
            return true;
        }
        catch (error) {
            lastError = error;
        }
    }
    // 全部失败不再静默（此前服务端 rejected，面板仍提示「已保存」）。
    console.warn(`[wallpaper-engine] 设置写入失败（已尝试 ${order.join(' / ')}）：`, lastError);
    return false;
}
// WE 用户属性读取（T4.2）：scene.json 的 visible:{user,value} 绑定按 key 查询用户
// 切换值。插件设置（ClientSettings）不含壁纸级用户属性存储——轻量实现用
// localStorage 持久化（键 we:userprop:<key>，JSON 值；未来 picker/设置面板可按
// 同一键写入，即用户切换入口）。无存储环境（node 测试/SSR）/键缺失/解析失败
// → undefined（resolveVisibility 回退绑定 value，不误杀对象）。
// 注：本函数不直接供 renderScene 调用——渲染器经 RenderSceneOptions.getUserProperty
// 注入（见 scene-renderer.ts），测试可注入 stub 而不依赖存储。
const USERPROP_PREFIX = 'we:userprop:';
export function getUserPropertyValue(key) {
    if (typeof localStorage === 'undefined')
        return undefined;
    const raw = localStorage.getItem(USERPROP_PREFIX + key);
    if (raw === null)
        return undefined;
    try {
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
