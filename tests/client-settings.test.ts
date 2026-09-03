import { describe, expect, it, vi, afterEach } from 'vitest';
import { readClientSettings, writeClientSettings, getUserPropertyValue, setSettingsCtx } from '../src/client/settings.js';

// DSH 0.1.2-rc.1：设置走 ctx.remote.settings（Typert 远程方法），
// describe() 读取、update(ns, patch) 深合并写入。插件经 setSettingsCtx(ctx) 注入 ctx。

const FULL_DEFAULTS = {
  selectedWallpaperId: '', wallpaperDir: '', weAssetsDir: '',
  overlayOpacity: 0.35, blurEnabled: false, blurRadius: 12, kenBurns: true,
};

afterEach(() => { vi.unstubAllGlobals(); setSettingsCtx(null); });

function stubRemote(remote: any) {
  setSettingsCtx({ remote: { settings: remote } });
}

function describeValue(namespacesVal: any) {
  return { ok: true, value: {
    writable: true, hasDocument: true,
    namespaces: [
      { ns: 'other', value: { x: 1 } },
      { ns: 'wallpaper-engine', value: namespacesVal },
    ],
  } };
}

describe('readClientSettings (ctx.remote.settings.describe)', () => {
  it('describe() 并解析 wallpaper-engine 命名空间', async () => {
    const describe = vi.fn(async () => describeValue({
      selectedWallpaperId: '42', wallpaperDir: 'D:/Steam/w', weAssetsDir: 'D:/WE',
      overlayOpacity: 0.5, blurEnabled: true, blurRadius: 20, kenBurns: false,
    }));
    stubRemote({ describe });
    const s = await readClientSettings();
    expect(s).toEqual({ selectedWallpaperId: '42', wallpaperDir: 'D:/Steam/w', weAssetsDir: 'D:/WE', overlayOpacity: 0.5, blurEnabled: true, blurRadius: 20, kenBurns: false });
    expect(describe).toHaveBeenCalledTimes(1);
  });
  it('命名空间缺失 → 回退默认值', async () => {
    stubRemote({ describe: vi.fn(async () => ({ ok: true, value: { writable: true, hasDocument: true, namespaces: [] } })) });
    expect(await readClientSettings()).toEqual(FULL_DEFAULTS);
  });
  it('describe ok:false → 回退默认值', async () => {
    stubRemote({ describe: vi.fn(async () => ({ ok: false, error: { message: 'nope' } })) });
    expect(await readClientSettings()).toEqual(FULL_DEFAULTS);
  });
  it('describe 抛异常 → 回退默认值', async () => {
    stubRemote({ describe: vi.fn(async () => { throw new Error('net'); }) });
    expect(await readClientSettings()).toEqual(FULL_DEFAULTS);
  });
  it('无 ctx.remote.settings → 回退默认值（node/SSR 防御）', async () => {
    setSettingsCtx(null);
    expect(await readClientSettings()).toEqual(FULL_DEFAULTS);
  });
});

describe('writeClientSettings (ctx.remote.settings.update)', () => {
  it('update(ns, patch) 深合并写入 wallpaper-engine 命名空间', async () => {
    const update = vi.fn(async () => ({ ok: true, value: { ns: 'wallpaper-engine', value: { selectedWallpaperId: '7' } } }));
    stubRemote({ update });
    await writeClientSettings({ selectedWallpaperId: '7' });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('wallpaper-engine', { selectedWallpaperId: '7' }, undefined);
  });
  it('失败静默忽略（不抛错）', async () => {
    stubRemote({ update: vi.fn(async () => { throw new Error('net'); }) });
    await expect(writeClientSettings({ selectedWallpaperId: '7' })).resolves.toBeUndefined();
  });
});

// T4.2 WE 用户属性读取：插件设置（ClientSettings）不含壁纸级用户属性存储，
// visible:{user,value} 绑定按 key 查询用户切换值——localStorage 持久化
// （键 we:userprop:<key>，JSON 值）。缺失/损坏/无存储环境 → undefined，
// resolveVisibility 据此回退绑定 value（不误杀对象）。
describe('getUserPropertyValue（WE 用户属性 localStorage 存储）', () => {
  const storage = () => ({ getItem: vi.fn() } as any);

  it('读取已存布尔值（JSON 解析，false 精确返回）', () => {
    const ls = storage();
    ls.getItem.mockReturnValue('false');
    vi.stubGlobal('localStorage', ls);
    expect(getUserPropertyValue('timeand')).toBe(false);
    expect(ls.getItem).toHaveBeenCalledWith('we:userprop:timeand');
  });

  it('缺失键（null）→ undefined（resolveVisibility 回退绑定 value）', () => {
    const ls = storage();
    ls.getItem.mockReturnValue(null);
    vi.stubGlobal('localStorage', ls);
    expect(getUserPropertyValue('nope')).toBeUndefined();
  });

  it('无 localStorage（node/SSR 环境）→ undefined（不抛错）', () => {
    expect(getUserPropertyValue('x')).toBeUndefined();
  });

  it('损坏 JSON → undefined（不抛错，防御）', () => {
    const ls = storage();
    ls.getItem.mockReturnValue('{oops');
    vi.stubGlobal('localStorage', ls);
    expect(getUserPropertyValue('x')).toBeUndefined();
  });
});
