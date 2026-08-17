import type { ClientSettings } from './types.js';

// DSH 设置是 POST RPC（apiproxy settings.schema.js）：settings.describe /
// settings.update 走 /api/<method> 的 client-request envelope，非 REST GET/PATCH。
// 任何失败（网络、非 JSON、错误码）都静默回退默认值。

const NS = 'wallpaper-engine';

const DEFAULTS: ClientSettings = {
  selectedWallpaperId: '', overlayOpacity: 0.35,
  blurEnabled: false, blurRadius: 12, kenBurns: true,
};

function newRpcId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

interface RpcResult { ok: boolean; value: unknown }

async function rpc(method: string, payload: unknown): Promise<RpcResult | null> {
  try {
    const resp = await fetch('/api/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: newRpcId(), method, payload }),
    });
    if (!resp.ok) return null;
    const body: unknown = await resp.json();
    if (typeof body !== 'object' || body === null) return null;
    const result = (body as { result?: { ok?: boolean; value?: unknown } }).result;
    if (!result) return null;
    return { ok: result.ok === true, value: result.value };
  } catch {
    return null;
  }
}

export async function readClientSettings(): Promise<ClientSettings> {
  const res = await rpc('settings.describe', {});
  const value = res?.ok ? res.value : undefined;
  if (typeof value === 'object' && value !== null) {
    const namespaces = (value as { namespaces?: Array<{ ns?: unknown; value?: unknown }> }).namespaces;
    const nsRow = namespaces?.find((n) => n.ns === NS);
    const nsValue = nsRow?.value;
    if (typeof nsValue === 'object' && nsValue !== null) {
      return { ...DEFAULTS, ...(nsValue as Partial<ClientSettings>) };
    }
  }
  return { ...DEFAULTS };
}

export async function writeClientSettings(patch: Partial<ClientSettings>): Promise<void> {
  await rpc('settings.update', { ns: NS, patch });
}
