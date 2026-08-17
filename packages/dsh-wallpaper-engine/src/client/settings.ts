import type { ClientSettings } from './types.js';

const DEFAULTS: ClientSettings = {
  selectedWallpaperId: '', overlayOpacity: 0.35,
  blurEnabled: false, blurRadius: 12, kenBurns: true,
};

export async function readClientSettings(): Promise<ClientSettings> {
  // 优先经 dsh 设置服务（dsh-client-runtime 的 settings 镜像）；
  // 不可用时回退默认值。接入方式在集成阶段按实际可用 API 调整。
  try {
    const resp = await fetch('/api/settings/wallpaper-engine', { headers: { Accept: 'application/json' } });
    if (resp.ok) return { ...DEFAULTS, ...(await resp.json()) };
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

export async function writeClientSettings(patch: Partial<ClientSettings>): Promise<void> {
  try {
    await fetch('/api/settings/wallpaper-engine', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  } catch { /* ignore */ }
}
