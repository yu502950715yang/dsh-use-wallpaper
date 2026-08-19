import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../src/host/index.js';

// C1 集成测试：apply(ctx) 除注册 settings 外，必须经 registerWallpaperRoutes
// 挂载 5 条壁纸路由，且 wallpaperDir 取自 ctx.config（缺省为 Steam workshop 路径）。

let dir: string;
let registered: Array<{ kind: string; path: string }>;
let handlers: Map<string, (req: any, res: any) => void>;

function makeCtx(config?: Record<string, unknown>) {
  const webServer = {
    register: (route: any) => {
      registered.push({ kind: route.kind, path: route.path });
      handlers.set(route.kind + ' ' + route.path, route.handler);
      return () => {};
    },
  };
  return {
    config: config ?? {},
    inject: (_svc: string[], fn: (c: any) => void) => fn({
      settings: { register: () => ({}) },
      webServer,
    }),
  } as any;
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp-apply-'));
  registered = [];
  handlers = new Map();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('apply (host entry)', () => {
  it('注册 settings 命名空间并挂载 5 条壁纸路由', () => {
    apply(makeCtx());
    expect(registered).toEqual([
      { kind: 'exact', path: '/wallpapers/list' },
      { kind: 'prefix', path: '/wallpapers/media' },
      { kind: 'prefix', path: '/wallpapers/scene' },
      { kind: 'prefix', path: '/wallpapers/static' },
      { kind: 'prefix', path: '/wallpapers/web' },
    ]);
  });
  it('路由扫描使用 config.wallpaperDir', async () => {
    mkdirSync(join(dir, '9'), { recursive: true });
    writeFileSync(join(dir, '9', 'project.json'), JSON.stringify({ title: 'W', type: 'image' }));
    apply(makeCtx(), { wallpaperDir: dir });
    const res = makeRes();
    await handlers.get('exact /wallpapers/list')!({ url: '/wallpapers/list' }, res);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body.toString('utf8'));
    expect(body.map((w: any) => w.id)).toEqual(['9']);
  });
  it('无 config 时使用缺省目录且 list 路由可用（缺省目录不存在 → 空列表）', async () => {
    apply(makeCtx());
    const res = makeRes();
    await handlers.get('exact /wallpapers/list')!({ url: '/wallpapers/list' }, res);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(JSON.parse(res.body.toString('utf8')))).toBe(true);
  });
});
