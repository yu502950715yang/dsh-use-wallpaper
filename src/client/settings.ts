import type { ClientSettings } from './types.js';

// DSH 0.1.2-rc.1 起设置系统改用 Typert 远程方法（ctx.remote.settings）：
// describe() 读取、update(ns, patch, revision) 深合并写入——取代旧版
// fetch('/api/settings.describe') 的 client-request RPC（新版已不识别该接口，
// 导致设置读写静默回退默认值 → 保存丢失/刷新后壁纸消失）。
// 插件 client 须在 index.ts 的 inject 声明 'remote','remote.settings'，并在
// bootstrap 时 setSettingsCtx(ctx)，使本模块能经 ctx.remote.settings 访问。

const NS = 'wallpaper-engine';

export const DEFAULTS: ClientSettings = {
  selectedWallpaperId: '', wallpaperDir: '', weAssetsDir: '',
  overlayOpacity: 0.35, blurEnabled: false, blurRadius: 12, kenBurns: true,
};

/** client cordis ctx（经 setSettingsCtx 注入，供 remote.settings 访问）。 */
let settingsCtx: any = null;

/** 注入 client ctx：bootstrap(ctx) 时调用；无 ctx（node 测试/SSR）时回退默认值。 */
export function setSettingsCtx(ctx: any): void {
  settingsCtx = ctx;
}

/** remote.settings.describe() 的响应：{ ok, value } / { ok:false, error }。 */
interface RemoteResponse { ok: boolean; value?: any; error?: { message?: string } }

function settingsRemote(): any {
  return settingsCtx?.remote?.settings ?? null;
}

export async function readClientSettings(): Promise<ClientSettings> {
  const remote = settingsRemote();
  if (!remote) return { ...DEFAULTS };
  try {
    const resp: RemoteResponse = await remote.describe();
    const value = resp?.ok ? resp.value : undefined;
    if (typeof value === 'object' && value !== null) {
      const namespaces = (value as { namespaces?: Array<{ ns?: unknown; value?: unknown }> }).namespaces;
      const nsRow = namespaces?.find((n) => n.ns === NS);
      const nsValue = nsRow?.value;
      if (typeof nsValue === 'object' && nsValue !== null) {
        return { ...DEFAULTS, ...(nsValue as Partial<ClientSettings>) };
      }
    }
  } catch {
    // 读取失败 → 静默回退默认值
  }
  return { ...DEFAULTS };
}

export async function writeClientSettings(patch: Partial<ClientSettings>): Promise<void> {
  const remote = settingsRemote();
  if (!remote) return;
  try {
    // update(ns, patch, revision)：revision 不传（undefined）→ 无条件写。
    await remote.update(NS, patch, undefined);
  } catch {
    // 写入失败静默（插件不因此中断）
  }
}

// WE 用户属性读取（T4.2）：scene.json 的 visible:{user,value} 绑定按 key 查询用户
// 切换值。插件设置（ClientSettings）不含壁纸级用户属性存储——轻量实现用
// localStorage 持久化（键 we:userprop:<key>，JSON 值；未来 picker/设置面板可按
// 同一键写入，即用户切换入口）。无存储环境（node 测试/SSR）/键缺失/解析失败
// → undefined（resolveVisibility 回退绑定 value，不误杀对象）。
// 注：本函数不直接供 renderScene 调用——渲染器经 RenderSceneOptions.getUserProperty
// 注入（见 scene-renderer.ts），测试可注入 stub 而不依赖存储。
const USERPROP_PREFIX = 'we:userprop:';

export function getUserPropertyValue(key: string): unknown {
  if (typeof localStorage === 'undefined') return undefined;
  const raw = localStorage.getItem(USERPROP_PREFIX + key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
