import { describe, expect, it, beforeEach, afterEach } from 'vitest';
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

interface CtxHandle { ctx: any; scope: any }

function makeCtx(config?: Record<string, unknown>): CtxHandle {
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
  const ctx = {
    config: config ?? {},
    inject: (_svc: string[], fn: (c: any) => void) => fn({
      settings: { register: () => scope },
      webServer,
    }),
  } as any;
  return { ctx, scope };
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
