import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/host/index.js';

// C1 集成测试：apply(ctx) 除注册 settings 外，必须经 registerWallpaperRoutes
// 挂载壁纸路由，且 wallpaperDir 解析顺序：settings.wallpaperDir（用户设置）>
// config.wallpaperDir（cordis.patch.yml）> 缺省。settings 变更经 scope.watch
// 热更新路由使用的目录（无需重启）。

let dirA: string;
let dirB: string;
let registered: Array<{ kind: string; path: string }>;
let handlers: Map<string, (req: any, res: any) => void>;

interface CtxHandle {
  ctx: any;
  scope: any;
  /** 旧路径 `settings.register(ns, schema, options)` 的调用记录 */
  registerCalls: Array<{ ns: any; schema: any; options: any }>;
  /** 新路径 `settings.configure(presentation, owner)` 的 spy */
  configure: any;
}

/** 三种 settings 服务形状：legacy = ≤0.1.6（register），modern = ≥0.1.7（SettingsForms），none = 形状都不匹配。 */
type SettingsMode = 'legacy' | 'modern' | 'none';

function makeCtx(config?: Record<string, unknown>, mode: SettingsMode = 'legacy'): CtxHandle {
  const webServer = {
    register: (route: any) => {
      registered.push({ kind: route.kind, path: route.path });
      handlers.set(route.kind + ' ' + route.path, route.handler);
      return () => {};
    },
  };
  // 模拟 settings 注册：resolved 初始为空对象，watch 收集回调
  let resolved: Record<string, unknown> = {};
  const watchCbs: Array<(next: Record<string, unknown>) => void> = [];
  const scope = {
    get: () => resolved,
    watch: (cb: (next: Record<string, unknown>) => void) => { watchCbs.push(cb); return () => {}; },
    update: async (patch: Record<string, unknown>) => { resolved = { ...resolved, ...patch }; },
    _watchCbs: watchCbs,
    _setResolved(v: Record<string, unknown>) { resolved = v; },
  };
  const registerCalls: CtxHandle['registerCalls'] = [];
  const configure = vi.fn(() => () => {});
  const settings = mode === 'legacy'
    ? {
      register: (ns: any, schema: any, options: any) => {
        registerCalls.push({ ns, schema, options });
        return scope;
      },
    }
    : mode === 'modern' ? { configure } : {};
  const ctx = {
    config: config ?? {},
    fiber: { marker: 'plugin-fiber' },
    inject: (_svc: string[], fn: (c: any) => void) => fn({ settings, webServer }),
  } as any;
  return { ctx, scope, registerCalls, configure };
}

function makeRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as any,
    setHeader(k: string, v: string) { this.headers[k] = v; },
    writeHead(c: number, h: Record<string, string>) { this.statusCode = c; Object.assign(this.headers, h); },
    end(b?: any) { this.body = b; },
  };
  return res;
}

function seedWallpaper(dir: string, id: string) {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, 'project.json'), JSON.stringify({ title: 'W' + id, type: 'image' }));
}

async function listIds(dirCtx: { scope: any }, dir: string) {
  // 触发 watch（模拟 settings 发布）：resolved 更新后调用全部 watch 回调
  const res = makeRes();
  await handlers.get('exact /wallpapers/list')!({ url: '/wallpapers/list' }, res);
  const body = JSON.parse(res.body.toString('utf8'));
  return body.map((w: any) => w.id);
}

beforeEach(() => {
  dirA = mkdtempSync(join(tmpdir(), 'wp-a-'));
  dirB = mkdtempSync(join(tmpdir(), 'wp-b-'));
  registered = [];
  handlers = new Map();
});
afterEach(() => {
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

describe('apply (host entry)', () => {
  it('注册 settings 命名空间并挂载 7 条壁纸路由（含 /wallpapers/probe）', () => {
    apply(makeCtx().ctx);
    expect(registered).toEqual([
      { kind: 'exact', path: '/wallpapers/list' },
      { kind: 'prefix', path: '/wallpapers/media' },
      { kind: 'prefix', path: '/wallpapers/scene' },
      { kind: 'prefix', path: '/wallpapers/static' },
      { kind: 'prefix', path: '/wallpapers/web' },
      { kind: 'exact', path: '/wallpapers/particle-texture' },
      { kind: 'exact', path: '/wallpapers/probe' },
    ]);
  });
  it('路由扫描使用 config.wallpaperDir（settings 未配置时）', async () => {
    seedWallpaper(dirA, '9');
    apply(makeCtx().ctx, { wallpaperDir: dirA });
    const res = makeRes();
    await handlers.get('exact /wallpapers/list')!({ url: '/wallpapers/list' }, res);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body.toString('utf8'));
    expect(body.map((w: any) => w.id)).toEqual(['9']);
  });
  it('settings.wallpaperDir 优先于 config.wallpaperDir', async () => {
    seedWallpaper(dirA, 'a1');
    seedWallpaper(dirB, 'b1');
    const { ctx, scope } = makeCtx();
    scope._setResolved({ wallpaperDir: dirB });
    apply(ctx, { wallpaperDir: dirA });
    const ids = await listIds({ scope }, dirB);
    expect(ids).toEqual(['b1']);
  });
  it('settings 热更新：scope.watch 触发后 list 路由读取新目录', async () => {
    seedWallpaper(dirA, 'a1');
    seedWallpaper(dirB, 'b1');
    const { ctx, scope } = makeCtx();
    apply(ctx, { wallpaperDir: dirA });
    // 初始：config 目录
    let ids = await listIds({ scope }, dirA);
    expect(ids).toEqual(['a1']);
    // 模拟设置面板保存新路径 → watch 回调执行 → 路由立即读取新目录
    scope._setResolved({ wallpaperDir: dirB });
    for (const cb of scope._watchCbs) cb(scope.get());
    ids = await listIds({ scope }, dirB);
    expect(ids).toEqual(['b1']);
  });
});

// DSH 0.1.7-alpha.1 起 settings 服务换成 SettingsForms：没有 register，条目 Config 由
// loader 解析，profile 条目 id 即命名空间。host 必须两版都能跑（特性探测），且新版下
// config 是 volatile 活引用 —— 路由每次请求读实时值，不得在 apply 里快照。
describe('apply 双路径（0.1.7 新模型）', () => {
  it('settings 无 register 时不抛错、调用 configure({auto:false}, 插件 fiber)', () => {
    const { ctx, configure, registerCalls } = makeCtx(undefined, 'modern');
    expect(() => apply(ctx)).not.toThrow();
    expect(configure).toHaveBeenCalledWith({ auto: false }, ctx.fiber);
    expect(registerCalls).toHaveLength(0);
    // 路由仍全部挂载
    expect(registered).toHaveLength(7);
  });

  it('新版：路由读 loader config，且 config 是活引用（apply 之后改值即生效）', async () => {
    seedWallpaper(dirA, 'a1');
    seedWallpaper(dirB, 'b1');
    const config: Record<string, unknown> = { wallpaperDir: dirA };
    const { ctx } = makeCtx(undefined, 'modern');
    apply(ctx, config);
    const res1 = makeRes();
    await handlers.get('exact /wallpapers/list')!({ url: '/wallpapers/list' }, res1);
    expect(JSON.parse(res1.body.toString('utf8')).map((w: any) => w.id)).toEqual(['a1']);
    // 模拟 loader 就地更新 volatile 引用（_commitVolatile）
    config.wallpaperDir = dirB;
    const res2 = makeRes();
    await handlers.get('exact /wallpapers/list')!({ url: '/wallpapers/list' }, res2);
    expect(JSON.parse(res2.body.toString('utf8')).map((w: any) => w.id)).toEqual(['b1']);
  });

  it('新版：config 是 volatile 活引用（带 get()）时按当前值解析', async () => {
    // 0.1.7 loader 交给插件的 config 是 schemastery 的 Volatile（对象级 volatile），
    // 读值必须走 .get()；直接 config.wallpaperDir 得到 undefined（真机 list 为空的原因）。
    seedWallpaper(dirA, 'a1');
    seedWallpaper(dirB, 'b1');
    let current: Record<string, unknown> = { wallpaperDir: dirA };
    const volatileConfig = { get: () => current };
    const { ctx } = makeCtx(undefined, 'modern');
    apply(ctx, volatileConfig as any);
    const res1 = makeRes();
    await handlers.get('exact /wallpapers/list')!({ url: '/wallpapers/list' }, res1);
    expect(JSON.parse(res1.body.toString('utf8')).map((w: any) => w.id)).toEqual(['a1']);
    current = { wallpaperDir: dirB };
    const res2 = makeRes();
    await handlers.get('exact /wallpapers/list')!({ url: '/wallpapers/list' }, res2);
    expect(JSON.parse(res2.body.toString('utf8')).map((w: any) => w.id)).toEqual(['b1']);
  });

  it('旧版：register 传 base=config（旧版面板与自动恢复靠它读到 config）', () => {
    const config = { wallpaperDir: dirA, weAssetsDir: 'D:/WE' };
    const { ctx, registerCalls } = makeCtx();
    apply(ctx, config);
    expect(registerCalls).toHaveLength(1);
    expect(registerCalls[0].ns).toBe('wallpaper-engine');
    expect(registerCalls[0].options).toEqual({ base: config });
  });

  it('旧版路径不得使用 volatile schema（旧解析取不到普通值）', () => {
    const { ctx, registerCalls } = makeCtx();
    apply(ctx);
    expect((registerCalls[0].schema as any).meta?.volatile).toBeFalsy();
  });

  it('两种形状都不匹配时（未来再改）不抛错，仅降级', () => {
    const { ctx } = makeCtx(undefined, 'none');
    expect(() => apply(ctx)).not.toThrow();
    expect(registered).toHaveLength(7);
  });
});
