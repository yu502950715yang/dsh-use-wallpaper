import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchWallpaperProperties, readBoolProperty, readUserProperty, resetUserProperty,
  writeBoolProperty, writeUserProperty,
} from '../src/client/wallpaper-properties.js';
import type { WallpaperUserProperty } from '../src/shared/types.js';

// v0.8 Task 7 client 侧：属性拉取 + 用户四类型值 localStorage 读写。
// 存储契约：带壁纸 id 时键 we:userprop:<wallpaperId>:<key>（跨壁纸隔离），
// 读侧缺键回退旧全局键 we:userprop:<key>（迁移兼容）；无 id 读写沿用旧全局键，reset 无 id 不动作。
// 只认 JSON 标量（bool/number/string），键缺失/坏 JSON/其它类型 → undefined，写入无存储环境静默。

const CLOUDS: WallpaperUserProperty = {
  key: 'clouds', label: '云层', type: 'bool', value: true, order: 2.5, usedBy: [],
};

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

  it('per-wallpaper 键：同一 key 两个 id 互不串值；旧全局键只读回退', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    writeBoolProperty('newproperty1', false, '2832263418');
    expect(storage.getItem('we:userprop:2832263418:newproperty1')).toBe('false');
    expect(storage.getItem('we:userprop:newproperty1')).toBeNull(); // 不再写全局键
    expect(readBoolProperty('newproperty1', '2832263418')).toBe(false);
    // 另一张同名属性的壁纸看不到这家的覆盖值（真实串键场景：EVA × 另一张 bool newproperty1）
    expect(readBoolProperty('newproperty1', '3811798465')).toBeUndefined();
    writeBoolProperty('newproperty1', true, '3811798465');
    expect(storage.getItem('we:userprop:3811798465:newproperty1')).toBe('true');
    expect(readBoolProperty('newproperty1', '2832263418')).toBe(false);
    expect(readBoolProperty('newproperty1', '3811798465')).toBe(true);
  });

  it('旧全局键回退：per-id 缺键时读旧值；per-id 有键时优先', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem('we:userprop:clouds', 'false'); // 升级前写入的旧值
    expect(readBoolProperty('clouds', '42')).toBe(false); // 迁移兼容：仍读得到
    storage.setItem('we:userprop:42:clouds', 'true');
    expect(readBoolProperty('clouds', '42')).toBe(true); // 新键优先
    expect(readBoolProperty('clouds', '43')).toBe(false); // 其它壁纸仍回退旧值
  });

  it('无 id 保持旧行为（读写全局键 we:userprop:<key>）', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    writeBoolProperty('clouds', false);
    expect(storage.getItem('we:userprop:clouds')).toBe('false');
    expect(readBoolProperty('clouds')).toBe(false);
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

describe('readUserProperty / writeUserProperty / resetUserProperty（四类型）', () => {
  it('四类型值往返（bool/number/string）', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    writeUserProperty('a', true, 'id1');
    writeUserProperty('b', 0.4, 'id1');
    writeUserProperty('c', '1', 'id1');
    expect(readUserProperty('a', 'id1')).toBe(true);
    expect(readUserProperty('b', 'id1')).toBe(0.4);
    expect(readUserProperty('c', 'id1')).toBe('1');
  });

  it('per-wallpaper 隔离与恢复默认', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    writeUserProperty('a', false, 'id1');
    writeUserProperty('a', true, 'id2');
    expect(readUserProperty('a', 'id1')).toBe(false);
    resetUserProperty('a', 'id1');
    expect(readUserProperty('a', 'id1')).toBeUndefined();
    expect(readUserProperty('a', 'id2')).toBe(true);
    expect(storage.getItem('we:userprop:id1:a')).toBeNull();
    expect(storage.getItem('we:userprop:id2:a')).toBe('true');
    expect(storage.getItem('we:userprop:a')).toBeNull(); // 不写旧全局键
  });

  it('旧全局键仍可读（迁移兼容）；reset 只删 per-id 键、不动旧全局键', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem('we:userprop:oldkey', 'true');
    expect(readUserProperty('oldkey', 'id1')).toBe(true);
    resetUserProperty('oldkey', 'id1');
    expect(storage.getItem('we:userprop:oldkey')).toBe('true');
    expect(readUserProperty('oldkey', 'id1')).toBe(true); // 仍回退旧值
  });

  it('写 JSON 标量到 per-id 键；无 id 读写旧全局键，且无 id reset 不删该键', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    writeUserProperty('speed', 0.4, 'id1');
    expect(storage.getItem('we:userprop:id1:speed')).toBe('0.4');
    writeUserProperty('clouds', false);
    expect(storage.getItem('we:userprop:clouds')).toBe('false');
    expect(readUserProperty('clouds')).toBe(false);
    // 旧全局键是 per-id 缺键时的迁移回退，无 id reset 不得删除
    resetUserProperty('clouds');
    expect(storage.getItem('we:userprop:clouds')).toBe('false');
    expect(readUserProperty('clouds')).toBe(false);
  });

  it('per-id 与旧全局键并存：带 id reset 只删 per-id，读取回退旧全局值', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem('we:userprop:clouds', 'true');
    writeUserProperty('clouds', false, 'id1');
    expect(readUserProperty('clouds', 'id1')).toBe(false); // per-id 优先
    resetUserProperty('clouds', 'id1');
    expect(storage.getItem('we:userprop:id1:clouds')).toBeNull();
    expect(storage.getItem('we:userprop:clouds')).toBe('true');
    expect(readUserProperty('clouds', 'id1')).toBe(true); // 回退旧全局值
  });

  it('坏 JSON / null / 对象等非标量 → undefined；readBoolProperty 只认布尔', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    storage.setItem('we:userprop:bad', '{oops');
    storage.setItem('we:userprop:id1:null', 'null');
    storage.setItem('we:userprop:id1:obj', '{"x":1}');
    expect(readUserProperty('bad', 'id1')).toBeUndefined();
    expect(readUserProperty('null', 'id1')).toBeUndefined();
    expect(readUserProperty('obj', 'id1')).toBeUndefined();
    writeUserProperty('num', 0.4, 'id1');
    expect(readBoolProperty('num', 'id1')).toBeUndefined();
  });

  it('无 localStorage / 存储抛错：读 undefined，写与 reset 静默', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readUserProperty('x', 'id')).toBeUndefined();
    expect(() => writeUserProperty('x', 1, 'id')).not.toThrow();
    expect(() => resetUserProperty('x', 'id')).not.toThrow();

    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('quota'); },
      removeItem: () => { throw new Error('quota'); },
    });
    expect(() => writeUserProperty('x', 1)).not.toThrow();
    expect(() => resetUserProperty('x', 'id')).not.toThrow(); // 走 removeItem 抛错分支
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
