import { describe, expect, it, vi, afterEach } from 'vitest';
import { readClientSettings, writeClientSettings, getUserPropertyValue, setSettingsCtx, DEFAULTS } from '../src/client/settings.js';

// DSH 0.1.2-rc.1：设置走 ctx.remote.settings（Typert 远程方法），
// describe() 读取、update(ns, patch) 深合并写入。插件经 setSettingsCtx(ctx) 注入 ctx。

const FULL_DEFAULTS = {
  selectedWallpaperId: '', wallpaperDir: '', weAssetsDir: '',
  overlayOpacity: 0.35, blurEnabled: false, blurRadius: 12, kenBurns: true,
  glowEnabled: true, glowThreshold: 0.65, glowStrength: 0.35,
  paused: false, pauseOnHidden: true, qualityScale: 1,
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

/** 只带一行、可指定 ns 的 describe 响应（0.1.7 的 ns = profile 条目 id）。 */
function describeValueWithNs(ns: string, value: any) {
  return { ok: true, value: {
    writable: true, hasDocument: true,
    namespaces: [{ ns, value }],
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
    // 命名空间未给的字段由 DEFAULTS 补齐（含 Glow 三字段）
    expect(s).toEqual({ selectedWallpaperId: '42', wallpaperDir: 'D:/Steam/w', weAssetsDir: 'D:/WE', overlayOpacity: 0.5, blurEnabled: true, blurRadius: 20, kenBurns: false, glowEnabled: true, glowThreshold: 0.65, glowStrength: 0.35, paused: false, pauseOnHidden: true, qualityScale: 1 });
    expect(describe).toHaveBeenCalledTimes(1);
  });
  it('命名空间缺失 → 回退默认值', async () => {
    stubRemote({ describe: vi.fn(async () => ({ ok: true, value: { writable: true, hasDocument: true, namespaces: [] } })) });
    expect(await readClientSettings()).toEqual(FULL_DEFAULTS);
  });
  it('describe ok:false → 回退默认值（尚无成功读取可沿用）', async () => {
    stubRemote({ describe: vi.fn(async () => ({ ok: false, error: { message: 'nope' } })) });
    expect(await readClientSettings()).toEqual(FULL_DEFAULTS);
  });
  it('describe 抛异常 → 回退默认值（尚无成功读取可沿用）', async () => {
    stubRemote({ describe: vi.fn(async () => { throw new Error('net'); }) });
    expect(await readClientSettings()).toEqual(FULL_DEFAULTS);
  });
  it('成功读取后再失败 → 返回**上次成功值**，不回 DEFAULTS（否则会悄悄重开用户关掉的 Glow）', async () => {
    const describe = vi.fn(async () => describeValue({ glowEnabled: false, glowStrength: 0.5 }));
    stubRemote({ describe });
    const first = await readClientSettings();
    expect(first.glowEnabled).toBe(false);
    // 同一次会话内 describe 瞬时失败（网络抖动 / 热重载）
    describe.mockImplementation(async () => { throw new Error('net'); });
    const second = await readClientSettings();
    expect(second).toEqual(first);
    expect(second.glowEnabled).toBe(false); // 不是 DEFAULTS 的 true
    // ok:false 同样沿用上次成功值
    describe.mockImplementation(async () => ({ ok: false, error: { message: 'nope' } }));
    expect((await readClientSettings()).glowEnabled).toBe(false);
  });
  it('无 ctx.remote.settings → 回退默认值（node/SSR 防御）', async () => {
    setSettingsCtx(null);
    expect(await readClientSettings()).toEqual(FULL_DEFAULTS);
  });
});

describe('writeClientSettings (ctx.remote.settings.update)', () => {
  it('读到旧版短名后，写回同一 ns（向后兼容）', async () => {
    const update = vi.fn(async () => ({ ok: true, value: { ns: 'wallpaper-engine', value: { selectedWallpaperId: '7' } } }));
    stubRemote({ describe: vi.fn(async () => describeValue({})), update });
    await readClientSettings();
    await writeClientSettings({ selectedWallpaperId: '7' });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('wallpaper-engine', { selectedWallpaperId: '7' }, undefined);
  });
  it('未读过时先试条目 id，被拒后自动退旧短名', async () => {
    const update = vi.fn(async (ns: string) => {
      if (ns === 'wallpaper-engine') return { ok: true };
      throw new Error('No configurable plugin entry');
    });
    stubRemote({ update });
    await writeClientSettings({ selectedWallpaperId: '7' });
    expect(update.mock.calls.map((c) => c[0])).toEqual(['dsh-wallpaper-engine', 'wallpaper-engine']);
  });
  it('全部失败 → console.warn，返回 false（不抛错、不再静默丢弃）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubRemote({ update: vi.fn(async () => { throw new Error('net'); }) });
    await expect(writeClientSettings({ selectedWallpaperId: '7' })).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it('远端返回 ok:false 也算失败，继续试下一个 ns', async () => {
    const update = vi.fn(async (ns: string) => (ns === 'wallpaper-engine'
      ? { ok: true }
      : { ok: false, error: { message: 'settings/rejected' } }));
    stubRemote({ update });
    await writeClientSettings({ selectedWallpaperId: '7' });
    expect(update.mock.calls.map((c) => c[0])).toEqual(['dsh-wallpaper-engine', 'wallpaper-engine']);
  });
  it('返回布尔供面板提示（成功 true / 全失败 false）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubRemote({ update: vi.fn(async () => ({ ok: true })) });
    expect(await writeClientSettings({ selectedWallpaperId: '7' })).toBe(true);
    stubRemote({ update: vi.fn(async () => { throw new Error('net'); }) });
    expect(await writeClientSettings({ selectedWallpaperId: '7' })).toBe(false);
    warn.mockRestore();
  });
});

// DSH 0.1.7-alpha.1 起 settings 命名空间是 **profile 条目 id**（cordis.patch.yml 的 id），
// 不再是插件短名；两版都要能读到值 ⇒ 需要按候选列表探测。
describe('命名空间探测（新旧两版）', () => {
  it('新版：ns=dsh-wallpaper-engine 时读到值', async () => {
    stubRemote({ describe: vi.fn(async () => describeValueWithNs('dsh-wallpaper-engine', {
      wallpaperDir: 'D:/w', weAssetsDir: 'D:/WE', selectedWallpaperId: '42', glowStrength: 0.5,
    })) });
    const s = await readClientSettings();
    expect(s.wallpaperDir).toBe('D:/w');
    expect(s.selectedWallpaperId).toBe('42');
    expect(s.glowStrength).toBe(0.5);
  });
  it('两行都在时优先取条目 id 行', async () => {
    stubRemote({ describe: vi.fn(async () => ({ ok: true, value: {
      writable: true, hasDocument: true,
      namespaces: [
        { ns: 'wallpaper-engine', value: { wallpaperDir: 'OLD' } },
        { ns: 'dsh-wallpaper-engine', value: { wallpaperDir: 'NEW' } },
      ],
    } })) });
    expect((await readClientSettings()).wallpaperDir).toBe('NEW');
  });
  it('两行都没有时回退 DEFAULTS（不误报配置）', async () => {
    stubRemote({ describe: vi.fn(async () => describeValueWithNs('some-other', { wallpaperDir: 'X' })) });
    expect((await readClientSettings()).wallpaperDir).toBe('');
  });
});

// 应用级 Glow 三字段的客户端缺省值（与 host schema 默认一致）。
describe('DEFAULTS（客户端缺省值）', () => {
  it('DEFAULTS 含 Glow 三字段（默认开启 / 真机定档参数）', () => {
    expect(DEFAULTS.glowEnabled).toBe(true);
    expect(DEFAULTS.glowThreshold).toBe(0.65);
    expect(DEFAULTS.glowStrength).toBe(0.35);
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
