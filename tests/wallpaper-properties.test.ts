import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchWallpaperProperties, readBoolProperty, writeBoolProperty,
} from '../src/client/wallpaper-properties.js';
import type { WallpaperUserProperty } from '../src/shared/types.js';

// v0.8 Task 7 client 侧：属性拉取 + 用户布尔值 localStorage 读写。
// 存储契约与 getUserPropertyValue 一致：键 we:userprop:<key>，JSON 值；
// 非 boolean（键缺失/坏 JSON/其它类型）→ undefined，写入无存储环境静默。

const CLOUDS: WallpaperUserProperty = { key: 'clouds', label: '云层', type: 'bool', value: true, order: 2.5 };

function memoryStorage() {
  const map = new Map<string, string>();
  const storage = {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
  };
  return storage;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('readBoolProperty / writeBoolProperty（localStorage 存储）', () => {
  it('writeBoolProperty 写 JSON 布尔；readBoolProperty 精确读回 false', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    writeBoolProperty('clouds', false);
    expect(storage.getItem('we:userprop:clouds')).toBe('false');
    expect(readBoolProperty('clouds')).toBe(false);
    writeBoolProperty('clouds', true);
    expect(storage.getItem('we:userprop:clouds')).toBe('true');
    expect(readBoolProperty('clouds')).toBe(true);
  });

  it('键缺失 / 坏 JSON / 非 boolean → undefined（复用 getUserPropertyValue 契约）', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    expect(readBoolProperty('missing')).toBeUndefined();
    storage.setItem('we:userprop:bad', '{oops');
    expect(readBoolProperty('bad')).toBeUndefined();
    storage.setItem('we:userprop:num', '1');
    expect(readBoolProperty('num')).toBeUndefined();
    storage.setItem('we:userprop:str', '"yes"');
    expect(readBoolProperty('str')).toBeUndefined();
    storage.setItem('we:userprop:null', 'null');
    expect(readBoolProperty('null')).toBeUndefined();
  });

  it('无 localStorage（node/SSR）→ 读 undefined、写静默不抛', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readBoolProperty('clouds')).toBeUndefined();
    expect(() => writeBoolProperty('clouds', true)).not.toThrow();
  });
});

describe('fetchWallpaperProperties（GET /wallpapers/properties）', () => {
  it('请求带编码后的 id，返回 properties 数组', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ properties: [CLOUDS] }) }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchWallpaperProperties('a/b')).resolves.toEqual([CLOUDS]);
    expect(fetchMock).toHaveBeenCalledWith('/wallpapers/properties?id=a%2Fb');
  });

  it('非 2xx → 空数组（面板据此不渲染 section）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    expect(await fetchWallpaperProperties('42')).toEqual([]);
  });

  it('properties 缺失/非数组/坏 JSON → 空数组', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    expect(await fetchWallpaperProperties('42')).toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ properties: 'nope' }) })));
    expect(await fetchWallpaperProperties('42')).toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new SyntaxError('bad json'); }));
    expect(await fetchWallpaperProperties('42')).toEqual([]);
  });

  it('网络异常 → 空数组，不向调用方抛错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
    expect(await fetchWallpaperProperties('42')).toEqual([]);
  });
});
