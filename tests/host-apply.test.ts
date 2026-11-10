import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/host/index.js';

// C1 集成测试：apply(ctx) 除声明设置面板外，必须经 registerWallpaperRoutes
// 挂载壁纸路由；wallpaperDir 解析来源 = loader config（cordis.patch.yml 的
// `dsh-wallpaper-engine` 条目），且 0.1.7 的 config 是 volatile 活引用，
// 路由每次请求读实时值（不得在 apply 里快照）。
// 1.0 起只支持 ≥0.1.7 路径：≤0.1.6 的 settings.register / scope.watch 已移除（AGENT.md §7.34）。

let dirA: string;
let dirB: string;
let savedDataDirEnv: string | undefined;
let registered: Array<{ kind: string; path: string }>;
let handlers: Map<string, (req: any, res: any) => void>;

interface CtxHandle {
  ctx: any;
  /** `settings.configure(presentation, owner)` 的 spy */
  configure: any;
}

/** 两种 settings 服务形状：modern = ≥0.1.7（SettingsForms），none = 形状都不匹配。 */
type SettingsMode = 'modern' | 'none';

function makeCtx(config?: Record<string, unknown>, mode: SettingsMode = 'modern'): CtxHandle {
  const webServer = {
    register: (route: any) => {
      registered.push({ kind: route.kind, path: route.path });
      handlers.set(route.kind + ' ' + route.path, route.handler);
      return () => {};
    },
  };
  const configure = vi.fn(() => () => {});
  const settings = mode === 'modern' ? { configure } : {};
  const ctx = {
    config: config ?? {},
    fiber: { marker: 'plugin-fiber' },
    inject: (_svc: string[], fn: (c: any) => void) => fn({ settings, webServer }),
  } as any;
  return { ctx, configure };
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

async function listIds(): Promise<string[]> {
  const res = makeRes();
  await handlers.get('exact /wallpapers/list')!({ url: '/wallpapers/list' }, res);
  const body = JSON.parse(res.body.toString('utf8'));
  return body.map((w: any) => w.id);
}

beforeEach(() => {
  dirA = mkdtempSync(join(tmpdir(), 'wp-a-'));
  dirB = mkdtempSync(join(tmpdir(), 'wp-b-'));
  // 数据目录指向临时目录，避免单测写入真实 ~/.dsh-use-wallpaper
  savedDataDirEnv = process.env.DSH_USE_WALLPAPER_DATA_DIR;
  process.env.DSH_USE_WALLPAPER_DATA_DIR = join(dirA, 'data');
  registered = [];
  handlers = new Map();
});
afterEach(() => {
  // 恢复到全局 setup 注入的临时目录，不能 delete（否则后续用例退回真实 home）
  if (savedDataDirEnv !== undefined) process.env.DSH_USE_WALLPAPER_DATA_DIR = savedDataDirEnv;
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

describe('apply (host entry)', () => {
  it('声明设置面板策略并挂载 13 条壁纸路由（含 /wallpapers/properties 与 now-playing）', () => {
    const { ctx, configure } = makeCtx();
    apply(ctx);
    expect(configure).toHaveBeenCalledWith({ auto: false }, ctx.fiber);
    expect(registered).toEqual([
      { kind: 'exact', path: '/wallpapers/list' },
      { kind: 'prefix', path: '/wallpapers/media' },
      { kind: 'exact', path: '/wallpapers/boot/local-video' },
      { kind: 'exact', path: '/wallpapers/boot/probe' },
      { kind: 'prefix', path: '/wallpapers/scene' },
      { kind: 'prefix', path: '/wallpapers/frame' },
      { kind: 'prefix', path: '/wallpapers/static' },
      { kind: 'prefix', path: '/wallpapers/web' },
      { kind: 'exact', path: '/wallpapers/particle-texture' },
      { kind: 'exact', path: '/wallpapers/probe' },
      { kind: 'exact', path: '/wallpapers/now-playing' },
      { kind: 'exact', path: '/wallpapers/now-playing/thumbnail' },
      { kind: 'exact', path: '/wallpapers/properties' },
    ]);
  });
  it('数据目录无法创建时不阻断加载：路由仍挂载，抓帧写接口降级 500', async () => {
    // env 指向一个普通文件 ⇒ mkdirSync 抛错；插件仍须完整加载（路由 13 条），抓帧退化为 500。
    const blocker = join(dirA, 'not-a-dir');
    writeFileSync(blocker, 'x');
    process.env.DSH_USE_WALLPAPER_DATA_DIR = blocker;
    expect(() => apply(makeCtx().ctx)).not.toThrow();
    expect(registered).toHaveLength(13);
    const frameRoute = handlers.get('prefix /wallpapers/frame')!;
    const req: any = { method: 'POST', url: '/wallpapers/frame/f1', headers: { 'content-type': 'image/png' } };
    const res = makeRes();
    await frameRoute(req, res);
    expect(res.statusCode).toBe(500);
  });
  it('抓帧路由写入 apply 接线后的数据目录', async () => {
    seedWallpaper(dirA, 'f1');
    apply(makeCtx().ctx);
    const frameRoute = handlers.get('prefix /wallpapers/frame')!;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
    const req: any = new EventEmitter();
    req.url = '/wallpapers/frame/f1';
    req.method = 'POST';
    req.headers = { 'content-type': 'image/png', 'content-length': String(png.length) };
    req.resume = () => {};
    setImmediate(() => { req.emit('data', png); req.emit('end'); });
    const res = makeRes();
    await frameRoute(req, res);
    expect(res.statusCode).toBe(201);
    expect(existsSync(join(dirA, 'data', 'frames', 'f1.png'))).toBe(true);
  });
  it('路由扫描使用 config.wallpaperDir', async () => {
    seedWallpaper(dirA, '9');
    apply(makeCtx().ctx, { wallpaperDir: dirA });
    const res = makeRes();
    await handlers.get('exact /wallpapers/list')!({ url: '/wallpapers/list' }, res);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body.toString('utf8')).map((w: any) => w.id)).toEqual(['9']);
  });
});

// DSH 0.1.7-alpha.1 起 settings 服务换成 SettingsForms：没有 register，条目 Config 由
// loader 解析，profile 条目 id 即命名空间。1.0 起只走这一条路径（AGENT.md §7.34）。
describe('apply 设置路径（0.1.7 SettingsForms，1.0 单路径）', () => {
  it('settings 存在时调用 configure({auto:false}, 插件 fiber)', () => {
    const { ctx, configure } = makeCtx();
    expect(() => apply(ctx)).not.toThrow();
    expect(configure).toHaveBeenCalledWith({ auto: false }, ctx.fiber);
    // 路由仍全部挂载
    expect(registered).toHaveLength(13);
  });

  it('路由读 loader config，且 config 是活引用（apply 之后改值即生效）', async () => {
    seedWallpaper(dirA, 'a1');
    seedWallpaper(dirB, 'b1');
    const config: Record<string, unknown> = { wallpaperDir: dirA };
    const { ctx } = makeCtx();
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

  it('config 是 volatile 活引用（带 get()）时按当前值解析', async () => {
    // 0.1.7 loader 交给插件的 config 是 schemastery 的 Volatile（对象级 volatile），
    // 读值必须走 .get()；直接 config.wallpaperDir 得到 undefined（真机 list 为空的原因）。
    seedWallpaper(dirA, 'a1');
    seedWallpaper(dirB, 'b1');
    let current: Record<string, unknown> = { wallpaperDir: dirA };
    const volatileConfig = { get: () => current };
    const { ctx } = makeCtx();
    apply(ctx, volatileConfig as any);
    const res1 = makeRes();
    await handlers.get('exact /wallpapers/list')!({ url: '/wallpapers/list' }, res1);
    expect(JSON.parse(res1.body.toString('utf8')).map((w: any) => w.id)).toEqual(['a1']);
    current = { wallpaperDir: dirB };
    const res2 = makeRes();
    await handlers.get('exact /wallpapers/list')!({ url: '/wallpapers/list' }, res2);
    expect(JSON.parse(res2.body.toString('utf8')).map((w: any) => w.id)).toEqual(['b1']);
  });

  it('settings 形状不匹配时（无 configure）不抛错，仅降级', () => {
    const { ctx } = makeCtx(undefined, 'none');
    expect(() => apply(ctx)).not.toThrow();
    expect(registered).toHaveLength(13);
  });

  it('settings.configure 抛错时不阻断插件主体（路由仍挂载）', () => {
    const { ctx } = makeCtx();
    ctx.inject = (_svc: string[], fn: (c: any) => void) => fn({
      settings: { configure: () => { throw new Error('boom'); } },
      webServer: { register: (route: any) => { registered.push({ kind: route.kind, path: route.path }); handlers.set(route.kind + ' ' + route.path, route.handler); return () => {}; } },
    });
    expect(() => apply(ctx)).not.toThrow();
    expect(registered).toHaveLength(13);
  });
});
