import { describe, expect, it, vi, afterEach } from 'vitest';
import { readClientSettings, writeClientSettings } from '../src/client/settings.js';

// C3：DSH 设置是 POST RPC（settings.describe / settings.update），
// 不是 REST GET/PATCH。以下用例断言 wire 形态、响应解析与失败回退。

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as any;
}

const FULL_DEFAULTS = {
  selectedWallpaperId: '', overlayOpacity: 0.35,
  blurEnabled: false, blurRadius: 12, kenBurns: true,
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('readClientSettings (settings RPC)', () => {
  it('POST /api/settings.describe 并解析 wallpaper-engine 命名空间', async () => {
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      expect(url).toBe('/api/settings.describe');
      expect(init.method).toBe('POST');
      expect(init.headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(init.body);
      expect(body.type).toBe('client-request');
      expect(body.method).toBe('settings.describe');
      expect(body.payload).toEqual({});
      expect(typeof body.rpcId).toBe('string');
      return jsonResponse({
        type: 'server-response',
        rpcId: body.rpcId,
        result: {
          ok: true,
          value: {
            writable: true, hasDocument: true,
            namespaces: [
              { ns: 'other', value: { x: 1 } },
              {
                ns: 'wallpaper-engine',
                value: { selectedWallpaperId: '42', overlayOpacity: 0.5, blurEnabled: true, blurRadius: 20, kenBurns: false },
              },
            ],
          },
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const s = await readClientSettings();
    expect(s).toEqual({ selectedWallpaperId: '42', overlayOpacity: 0.5, blurEnabled: true, blurRadius: 20, kenBurns: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('命名空间缺失 → 回退默认值', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      type: 'server-response', rpcId: 'x',
      result: { ok: true, value: { writable: true, hasDocument: true, namespaces: [] } },
    })));
    expect(await readClientSettings()).toEqual(FULL_DEFAULTS);
  });
  it('rpc 错误码（ok:false）→ 回退默认值', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      type: 'server-response', rpcId: 'x',
      result: { ok: false, error: { code: 'settings-not-exposed', message: 'nope', details: { ns: 'wallpaper-engine' } } },
    })));
    expect(await readClientSettings()).toEqual(FULL_DEFAULTS);
  });
  it('fetch 失败 → 回退默认值', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net'); }));
    expect(await readClientSettings()).toEqual(FULL_DEFAULTS);
  });
  it('非 JSON 响应 → 回退默认值', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })));
    expect(await readClientSettings()).toEqual(FULL_DEFAULTS);
  });
});

describe('writeClientSettings (settings RPC)', () => {
  it('POST /api/settings.update 携带 ns + patch', async () => {
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      expect(url).toBe('/api/settings.update');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      expect(body.type).toBe('client-request');
      expect(body.method).toBe('settings.update');
      expect(body.payload).toEqual({ ns: 'wallpaper-engine', patch: { selectedWallpaperId: '7' } });
      return jsonResponse({
        type: 'server-response', rpcId: body.rpcId,
        result: { ok: true, value: { ns: 'wallpaper-engine', value: { selectedWallpaperId: '7' } } },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    await writeClientSettings({ selectedWallpaperId: '7' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('失败静默忽略（不抛错）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net'); }));
    await expect(writeClientSettings({ selectedWallpaperId: '7' })).resolves.toBeUndefined();
  });
});
