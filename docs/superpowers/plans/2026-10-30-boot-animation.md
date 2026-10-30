# 开机动画（视频/图片素材）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `@dsh-use/wallpaper-engine` 增加与日常壁纸完全独立的「开机动画」能力：WE 库视频/图片壁纸或本地视频文件作素材，四种展示方式，每次冷启动播一次。

**Architecture:** host 侧新增两条只读路由（本地视频流式 + 路径校验，仅回环来源）；client 侧新增独立 `.wp-boot-layer` 全屏播放器（不碰背景层），由 `boot-player` 编排「读设置 → 判是否播 → 组装素材 URL → 调 overlay」，设置面板以独立 `settings.section` 挂载（`wbs-*` 新类名）。

**Tech Stack:** TypeScript strict、React 18（DSH client slot）、Node 22（Cordis host）、vitest（node + jsdom 双环境）、esbuild、schemastery、DSH Typert 设置通道。

**Spec:** `docs/superpowers/specs/2026-10-30-boot-animation-design.md`（必读，本计划据此展开）

## Global Constraints

- 默认**关闭**、固定**静音**（`muted + playsInline`）、**每次页面会话只播一次**（`sessionStorage: 'we:boot-played'`，刷新/HMR 不重播）。
- 本地视频路由**仅回环来源可用**（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`），扩展名白名单 `{.mp4,.webm,.mov,.m4v,.ogv}`。
- 与日常壁纸零耦合：不改 `body[data-we-wallpaper]`、不调 background-layer、不影响轮播/暂停/健康状态。
- 新面板类名一律 `wbs-*`；**不得**改动现有 `wss-*` 契约（`tests/dom/settings-section.dom.test.tsx` + `tests/styles.test.ts` 锁定）。
- 遵守 `verify:arch`：client 不 import host、shared 纯、host 禁 three/react。
- 提交前必须 `npm run build && npm run build:client`（`lib/`、`dist/` 入库）；注释一行说清「是什么/为什么」，中文。
- 超时兜底：素材 8 秒未就绪必须静默跳过，**任何失败都不得阻塞主界面**。

---

## File Structure

**新增**
| 文件 | 职责 |
|---|---|
| `src/client/boot-overlay.ts` | 全屏播放器：视频/图片 + 四种 fit + 跳过 + 超时 + 淡出，幂等 dispose |
| `src/client/boot-player.ts` | 纯函数（素材/是否播）+ 编排器（start/play/getLast/dispose） |
| `src/client/boot-settings-section.tsx` | 独立设置面板（启用/素材/展示方式/时长/试播/校验） |
| `tests/boot-asset.test.ts` | host 纯函数 + 两条路由 |
| `tests/dom/boot-overlay.dom.test.ts` | overlay 行为（jsdom） |
| `tests/boot-player.test.ts` | player 纯函数 + 编排 |
| `tests/dom/boot-settings-section.dom.test.tsx` | 面板渲染/交互 |

**修改**
| 文件 | 改动 |
|---|---|
| `src/host/settings.ts` | +7 个 `bootAnimation*` 字段（含取值约束） |
| `src/host/routes.ts` | +`isLoopbackRemote` / `resolveBootVideoPath` / 两条路由 |
| `src/client/types.ts` | `ClientSettings` +7 字段；`BootFitMode`/`BootAsset`/`BootResult` 类型放 `boot-overlay.ts` |
| `src/client/settings.ts` | `DEFAULTS` +7 字段 |
| `src/client/index.ts` | 创建并启动 bootPlayer、暴露 `window.__wallpaperEngineBoot`、注册第二个 section、teardown 清理、清残留 `.wp-boot-layer` |
| `src/client/styles.ts` | `.wp-boot-layer` + `wbs-*` 样式追加到 CSS 常量 |
| `tests/settings.test.ts` / `tests/client-settings.test.ts` / `tests/dom/settings-section.dom.test.tsx` | 默认值断言/完整字面量补新字段 |
| `tests/dom/plugin-lifecycle.dom.test.ts` | 新用例：无 `.wp-boot-layer` 残留、teardown 摘掉 boot API |
| `AGENT.md` | 能力、模块清单、边界 |

---

### Task 1: 设置字段（host schema + client 类型/DEFAULTS）

**Files:**
- Modify: `src/host/settings.ts:44`（schema 末尾追加字段）
- Modify: `src/client/types.ts:49`（`ClientSettings` 末尾追加）
- Modify: `src/client/settings.ts:29`（`DEFAULTS` 末尾追加）
- Test: `tests/settings.test.ts`、`tests/client-settings.test.ts`、`tests/dom/settings-section.dom.test.tsx:55-63`（`BASE_SETTINGS` 字面量补字段）

**Interfaces:**
- Produces（后续任务依赖，字段名不可改）：
  - `bootAnimationEnabled: boolean`（缺省 `false`）
  - `bootAnimationSource: string`（缺省 `'we'`）
  - `bootAnimationWallpaperId: string`（缺省 `''`）
  - `bootAnimationWallpaperKind: string`（缺省 `''`，`'video'|'image'`）
  - `bootAnimationLocalPath: string`（缺省 `''`）
  - `bootAnimationFitMode: string`（缺省 `'cover'`）
  - `bootAnimationMaxDurationMs: number`（缺省 `6000`，schema 钳 0–30000）

- [ ] **Step 1: 写失败测试（host schema）**

在 `tests/settings.test.ts` 的 `describe` 内追加：

```ts
it('开机动画字段有缺省值且边界受钳', () => {
  const v = WallpaperSettingsSchema({});
  expect(v).toMatchObject({
    bootAnimationEnabled: false,
    bootAnimationSource: 'we',
    bootAnimationWallpaperId: '',
    bootAnimationWallpaperKind: '',
    bootAnimationLocalPath: '',
    bootAnimationFitMode: 'cover',
    bootAnimationMaxDurationMs: 6000,
  });
  expect(() => WallpaperSettingsSchema({ bootAnimationMaxDurationMs: -1 })).toThrow();
  expect(() => WallpaperSettingsSchema({ bootAnimationMaxDurationMs: 30001 })).toThrow();
  expect(WallpaperSettingsSchema({ bootAnimationSource: 'whatever' }).bootAnimationSource).toBe('whatever');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/settings.test.ts --reporter=basic`
Expected: FAIL（`bootAnimationEnabled` 为 undefined）

- [ ] **Step 3: 实现 host schema**

`src/host/settings.ts` 的 `WallpaperSettingsSchema` 内、`frameCacheEnabled` 之后追加：

```ts
  // 开机动画（v0.10）：与壁纸设置完全独立，默认关闭。source/fitMode 用宽松 string
  // （白名单归一在 client，防旧值被 schema 拒绝）。
  bootAnimationEnabled: z.boolean().default(false),
  bootAnimationSource: z.string().default('we'),
  bootAnimationWallpaperId: z.string().default(''),
  // 'video' | 'image'：面板选 WE 壁纸时与 id 一起写入，启动时免拉列表判断类型
  bootAnimationWallpaperKind: z.string().default(''),
  bootAnimationLocalPath: z.string().default(''),
  bootAnimationFitMode: z.string().default('cover'),
  bootAnimationMaxDurationMs: z.number().min(0).max(30000).default(6000),
```

- [ ] **Step 4: 跑 host 测试确认通过**

Run: `npx vitest run tests/settings.test.ts --reporter=basic`
Expected: PASS

- [ ] **Step 5: 写失败测试（client DEFAULTS）**

`tests/client-settings.test.ts`：`FULL_DEFAULTS` 追加 7 字段（与 Step 3 缺省值一致），并把第 51 行的 `toEqual({...})` 期望对象也补上同样 7 字段：

```ts
  bootAnimationEnabled: false, bootAnimationSource: 'we',
  bootAnimationWallpaperId: '', bootAnimationWallpaperKind: '',
  bootAnimationLocalPath: '', bootAnimationFitMode: 'cover',
  bootAnimationMaxDurationMs: 6000,
```

`tests/dom/settings-section.dom.test.tsx` 的 `BASE_SETTINGS`（约第 56 行）追加同一组字段。

- [ ] **Step 6: 跑测试确认失败**

Run: `npx vitest run tests/client-settings.test.ts --reporter=basic`
Expected: FAIL（实际值缺少 boot 字段）

- [ ] **Step 7: 实现 client 字段**

`src/client/types.ts` 的 `ClientSettings` 内追加（带一行注释说明分组）：

```ts
  // 开机动画（独立于壁纸）：默认关闭；source: 'we'|'local'；fitMode: 'tile'|'contain'|'stretch'|'cover'
  bootAnimationEnabled: boolean;
  bootAnimationSource: string;
  bootAnimationWallpaperId: string;
  bootAnimationWallpaperKind: string;
  bootAnimationLocalPath: string;
  bootAnimationFitMode: string;
  bootAnimationMaxDurationMs: number;
```

`src/client/settings.ts` 的 `DEFAULTS` 对象内追加：

```ts
  bootAnimationEnabled: false, bootAnimationSource: 'we',
  bootAnimationWallpaperId: '', bootAnimationWallpaperKind: '',
  bootAnimationLocalPath: '', bootAnimationFitMode: 'cover',
  bootAnimationMaxDurationMs: 6000,
```

- [ ] **Step 8: 跑测试确认通过 + 类型检查**

Run: `npx vitest run tests/settings.test.ts tests/client-settings.test.ts --reporter=basic && npm run typecheck:tests`
Expected: PASS（typecheck 退出码 0；若报其它 ClientSettings 字面量缺字段，按报错补同一组字段）

- [ ] **Step 9: Commit**

```bash
git add src/host/settings.ts src/client/types.ts src/client/settings.ts tests/settings.test.ts tests/client-settings.test.ts tests/dom/settings-section.dom.test.tsx
git commit -m "feat(settings): 开机动画设置字段（默认关闭，独立于壁纸）"
```

---

### Task 2: host 本地视频路由 + 纯函数

**Files:**
- Modify: `src/host/routes.ts:1-14`（import `isAbsolute`）、`:314-330` 后（两条新路由）、文件内新增两个导出函数（放在 `parseUrl` 附近）
- Test: `tests/boot-asset.test.ts`（新建）

**Interfaces:**
- Produces：
  - `isLoopbackRemote(remoteAddress: string | undefined | null): boolean`
  - `resolveBootVideoPath(raw: string | null | undefined): { ok: true; file: string; size: number } | { ok: false; code: 400 | 404 }`
  - `GET /wallpapers/boot/local-video?path=<绝对路径>` → 200/206 流式、403 非回环、400/404
  - `GET /wallpapers/boot/probe?path=<绝对路径>` → `{ ok, exists, isFile, size, playable }`

- [ ] **Step 1: 写失败测试（纯函数 + 路由）**

新建 `tests/boot-asset.test.ts`：

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWallpaperRoutes, isLoopbackRemote, resolveBootVideoPath } from '../src/host/routes.js';

let dir: string;
let routes: Map<string, (req: any, res: any) => void>;

function makeCtx() {
  const webServer = {
    register: (route: any) => { routes.set(route.path, route.handler); return () => {}; },
  };
  return { inject: (_s: string[], fn: (c: any) => void) => fn({ webServer }) } as any;
}

function makeReq(url: string, remoteAddress = '127.0.0.1') {
  return { url, method: 'GET', headers: {} as Record<string, string>, socket: { remoteAddress } };
}

function makeStreamRes() {
  const chunks: Buffer[] = [];
  const res: any = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  res.statusCode = 200;
  res.headers = {} as Record<string, string>;
  res.setHeader = (k: string, v: string) => { res.headers[k] = v; };
  res.writeHead = (c: number, h: Record<string, string>) => { res.statusCode = c; Object.assign(res.headers, h); };
  res.done = new Promise<void>((resolve) => res.on('finish', resolve));
  Object.defineProperty(res, 'body', { get: () => Buffer.concat(chunks) });
  return res;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp-boot-'));
  routes = new Map();
  registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('isLoopbackRemote', () => {
  it('只认回环地址', () => {
    for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(isLoopbackRemote(a)).toBe(true);
    for (const a of ['192.168.1.5', '10.0.0.1', '::ffff:8.8.8.8', undefined, '']) expect(isLoopbackRemote(a)).toBe(false);
  });
});

describe('resolveBootVideoPath', () => {
  it('拒绝相对路径与非白名单扩展名', () => {
    expect(resolveBootVideoPath('boot.mp4')).toEqual({ ok: false, code: 400 });
    expect(resolveBootVideoPath('')).toEqual({ ok: false, code: 400 });
    expect(resolveBootVideoPath(null)).toEqual({ ok: false, code: 400 });
    expect(resolveBootVideoPath(join(dir, 'a.exe'))).toEqual({ ok: false, code: 400 });
  });
  it('不存在的文件 404；合法 mp4 返回 size', () => {
    expect(resolveBootVideoPath(join(dir, 'missing.mp4'))).toEqual({ ok: false, code: 404 });
    const p = join(dir, 'ok.mp4');
    writeFileSync(p, 'abcdef');
    expect(resolveBootVideoPath(p)).toEqual({ ok: true, file: p, size: 6 });
  });
});

const handler = (path: string) => routes.get(path)!;

describe('GET /wallpapers/boot/local-video', () => {
  it('非回环 403', async () => {
    const res = makeStreamRes();
    handler('/wallpapers/boot/local-video')(makeReq('/wallpapers/boot/local-video?path=x', '10.1.2.3'), res);
    await res.done;
    expect(res.statusCode).toBe(403);
  });
  it('合法 mp4 整块返回 200；Range 返回 206', async () => {
    const p = join(dir, 'clip.mp4');
    writeFileSync(p, Buffer.from('0123456789'));
    const url = '/wallpapers/boot/local-video?path=' + encodeURIComponent(p);

    const res = makeStreamRes();
    handler('/wallpapers/boot/local-video')(makeReq(url), res);
    await res.done;
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('video/mp4');
    expect(res.body.toString()).toBe('0123456789');

    const res2 = makeStreamRes();
    const req2 = { ...makeReq(url), headers: { range: 'bytes=2-4' } };
    handler('/wallpapers/boot/local-video')(req2, res2);
    await res2.done;
    expect(res2.statusCode).toBe(206);
    expect(res2.headers['Content-Range']).toBe('bytes 2-4/10');
    expect(res2.body.toString()).toBe('234');
  });
  it('相对路径 400、不存在 404', async () => {
    const r1 = makeStreamRes();
    handler('/wallpapers/boot/local-video')(makeReq('/wallpapers/boot/local-video?path=a.mp4'), r1);
    await r1.done;
    expect(r1.statusCode).toBe(400);
    const r2 = makeStreamRes();
    handler('/wallpapers/boot/local-video')(makeReq('/wallpapers/boot/local-video?path=' + encodeURIComponent(join(dir, 'no.mp4'))), r2);
    await r2.done;
    expect(r2.statusCode).toBe(404);
  });
});

describe('GET /wallpapers/boot/probe', () => {
  it('存在返回元数据、非回环 403', async () => {
    const p = join(dir, 'probe.mp4');
    writeFileSync(p, '12345');
    const res = makeStreamRes();
    handler('/wallpapers/boot/probe')(makeReq('/wallpapers/boot/probe?path=' + encodeURIComponent(p)), res);
    await res.done;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body.toString())).toMatchObject({ ok: true, exists: true, isFile: true, size: 5, playable: true });

    const res2 = makeStreamRes();
    handler('/wallpapers/boot/probe')(makeReq('/wallpapers/boot/probe?path=x', '8.8.8.8'), res2);
    await res2.done;
    expect(res2.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/boot-asset.test.ts --reporter=basic`
Expected: FAIL（`isLoopbackRemote` 未导出 / 路由未注册）

- [ ] **Step 3: 实现纯函数**

`src/host/routes.ts` import 行改为（增加 `isAbsolute`）：

```ts
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
```

在 `parseUrl` 附近新增：

```ts
// ── 开机动画本地视频 ────────────────────────────────────────────────────────────────
// 本地视频素材由宿主代读（浏览器无法直接打开任意路径），只允许本机回环来源：
// dsh web 可绑 0.0.0.0，不设此闸就等于给远程访问者一个任意文件读取口子。
export function isLoopbackRemote(remoteAddress: string | undefined | null): boolean {
  const addr = String(remoteAddress ?? '').trim().toLowerCase();
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

const BOOT_VIDEO_EXTS: ReadonlySet<string> = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);

// 返回绝对路径 + 文件大小；path 来自设置面板手填，必须拦下相对路径/非视频扩展名。
export function resolveBootVideoPath(
  raw: string | null | undefined,
): { ok: true; file: string; size: number } | { ok: false; code: 400 | 404 } {
  const p = String(raw ?? '').trim();
  if (!p || !isAbsolute(p) || p.includes('\0')) return { ok: false, code: 400 };
  const ext = '.' + (p.split('.').pop() ?? '').toLowerCase();
  if (!BOOT_VIDEO_EXTS.has(ext)) return { ok: false, code: 400 };
  try {
    const st = statSync(p);
    if (!st.isFile()) return { ok: false, code: 404 };
    return { ok: true, file: p, size: st.size };
  } catch {
    return { ok: false, code: 404 };
  }
}
```

- [ ] **Step 4: 实现两条路由**

在 `registerWallpaperRoutes` 内、`/wallpapers/media` 的 `server.register` 之后插入：

```ts
    // 开机动画：本地视频流式（仅回环）。sendSceneAsset 复用 Range/HEAD/206/416 语义。
    server.register({
      kind: 'exact', path: '/wallpapers/boot/local-video',
      handler: (req: any, res: any) => {
        if (!isLoopbackRemote(req.socket?.remoteAddress)) return json(res, 403, { error: 'loopback only' });
        const { search } = parseUrl(req);
        const parsed = resolveBootVideoPath(search.get('path'));
        if (!parsed.ok) return json(res, parsed.code, { error: parsed.code === 404 ? 'not found' : 'bad path' });
        sendSceneAsset(req, res, parsed.file, {
          size: parsed.size,
          readAll: () => readFileSync(parsed.file),
          openRange: (start, end) => createReadStream(parsed.file, { start, end }),
        }, 0);
      },
    });

    // 开机动画：本地路径校验（设置面板「校验」按钮；不读内容、不探测编码）
    server.register({
      kind: 'exact', path: '/wallpapers/boot/probe',
      handler: (req: any, res: any) => {
        if (!isLoopbackRemote(req.socket?.remoteAddress)) return json(res, 403, { error: 'loopback only' });
        const { search } = parseUrl(req);
        const raw = search.get('path') ?? '';
        const ext = '.' + (raw.split('.').pop() ?? '').toLowerCase();
        if (!raw || !isAbsolute(raw)) return json(res, 400, { error: 'bad path' });
        if (!BOOT_VIDEO_EXTS.has(ext)) {
          return json(res, 400, { ok: false, exists: false, isFile: false, size: 0, playable: false, error: 'unsupported extension' });
        }
        try {
          const st = statSync(raw);
          return json(res, 200, { ok: true, exists: true, isFile: st.isFile(), size: st.size, playable: st.isFile(), ext });
        } catch {
          return json(res, 404, { ok: false, exists: false, isFile: false, size: 0, playable: false, error: 'not found' });
        }
      },
    });
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/boot-asset.test.ts --reporter=basic`
Expected: PASS（全部用例）

- [ ] **Step 6: Commit**

```bash
git add src/host/routes.ts tests/boot-asset.test.ts
git commit -m "feat(host): 开机动画本地视频路由（回环限制 + Range 流式）"
```

---

### Task 3: client 全屏播放器 `boot-overlay.ts`

**Files:**
- Create: `src/client/boot-overlay.ts`
- Test: `tests/dom/boot-overlay.dom.test.ts`

**Interfaces:**
- Produces：
  - `type BootFitMode = 'tile' | 'contain' | 'stretch' | 'cover'`
  - `type BootAsset = { kind: 'video'; url: string } | { kind: 'image'; url: string }`
  - `type BootResult = 'ended' | 'skipped' | 'timeout' | 'failed' | 'already-played' | 'disabled' | 'no-asset'`
  - `createBootOverlay(opts?: { readyTimeoutMs?: number; fadeMs?: number; imageDurationMs?: number; doc?: Document }): BootOverlay`
  - `BootOverlay.play(asset: BootAsset, fit: BootFitMode, maxDurationMs?: number): Promise<BootResult>`（`maxDurationMs` 0 = 视频播完/图片固定时长）
  - `BootOverlay.dispose(): void`（幂等）

- [ ] **Step 1: 写失败测试**

新建 `tests/dom/boot-overlay.dom.test.ts`：

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createBootOverlay } from '../../src/client/boot-overlay.js';

// jsdom 不解码媒体：测试用事件派发 + fake timers 驱动状态机；play() 被 stub 避免 not-implemented。
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  document.documentElement.innerHTML = '<body></body>';
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.documentElement.innerHTML = '<body></body>';
});

const layer = () => document.querySelector<HTMLElement>('.wp-boot-layer');

describe('createBootOverlay', () => {
  it('视频：loadeddata 后按 maxDuration 结束，淡出后移除层', async () => {
    const overlay = createBootOverlay({ readyTimeoutMs: 1000, fadeMs: 50 });
    const p = overlay.play({ kind: 'video', url: '/v.mp4' }, 'cover', 300);
    const video = layer()!.querySelector('video')!;
    expect(video.style.objectFit).toBe('cover');
    video.dispatchEvent(new Event('loadeddata'));
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(50);
    await expect(p).resolves.toBe('ended');
    expect(layer()).toBeNull();
  });

  it('视频 ended 提前结束', async () => {
    const overlay = createBootOverlay({ fadeMs: 10 });
    const p = overlay.play({ kind: 'video', url: '/v.mp4' }, 'contain', 0);
    const video = layer()!.querySelector('video')!;
    video.dispatchEvent(new Event('loadeddata'));
    video.dispatchEvent(new Event('ended'));
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe('ended');
  });

  it('图片：平铺用 repeat 背景 div；到时长结束', async () => {
    const overlay = createBootOverlay({ imageDurationMs: 200, fadeMs: 10 });
    const p = overlay.play({ kind: 'image', url: '/p.png' }, 'tile', 0);
    const tile = layer()!.querySelector<HTMLElement>('.wp-boot-tile')!;
    expect(tile.style.backgroundRepeat).toBe('repeat');
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe('ended');
  });

  it('跳过：pointerdown 立即结束（skipped）', async () => {
    const overlay = createBootOverlay({ fadeMs: 10 });
    const p = overlay.play({ kind: 'image', url: '/p.png' }, 'cover', 0);
    window.dispatchEvent(new Event('pointerdown'));
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe('skipped');
  });

  it('就绪超时 → timeout', async () => {
    const overlay = createBootOverlay({ readyTimeoutMs: 500, fadeMs: 10 });
    const p = overlay.play({ kind: 'video', url: '/v.mp4' }, 'cover', 0);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe('timeout');
  });

  it('dispose 幂等且移除层', async () => {
    const overlay = createBootOverlay({ fadeMs: 10 });
    const p = overlay.play({ kind: 'image', url: '/p.png' }, 'cover', 0);
    overlay.dispose();
    overlay.dispose();
    expect(layer()).toBeNull();
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toBe('skipped');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/dom/boot-overlay.dom.test.ts --reporter=basic`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/client/boot-overlay.ts`**

```ts
// 开机动画全屏播放器：独立于背景层（不碰 body[data-we-wallpaper] / background-layer 状态）。
// 一次 play() = 建层 → 等首帧 → 播到上限/跳过/超时 → 淡出 → 移除；任何失败都不抛。
export type BootFitMode = 'tile' | 'contain' | 'stretch' | 'cover';
export type BootAsset = { kind: 'video'; url: string } | { kind: 'image'; url: string };
export type BootResult = 'ended' | 'skipped' | 'timeout' | 'failed' | 'already-played' | 'disabled' | 'no-asset';

export interface BootOverlay {
  play(asset: BootAsset, fit: BootFitMode, maxDurationMs?: number): Promise<BootResult>;
  dispose(): void;
}

export interface BootOverlayOptions {
  readyTimeoutMs?: number;
  fadeMs?: number;
  imageDurationMs?: number;
  doc?: Document;
}

const LAYER_CLASS = 'wp-boot-layer';

export function createBootOverlay(opts: BootOverlayOptions = {}): BootOverlay {
  const doc = opts.doc ?? document;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 8000;
  const fadeMs = opts.fadeMs ?? 300;
  const imageDurationMs = opts.imageDurationMs ?? 4000;
  let layer: HTMLElement | null = null;
  let disposed = false;
  let finishCurrent: ((r: BootResult) => void) | null = null;

  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
    return t;
  };
  const clearTimers = () => { for (const t of timers) clearTimeout(t); timers.clear(); };

  const onSkip = (ev: Event) => {
    ev.preventDefault?.();
    finishCurrent?.('skipped');
  };
  const attachSkip = () => {
    window.addEventListener('pointerdown', onSkip, true);
    window.addEventListener('keydown', onSkip, true);
  };
  const detachSkip = () => {
    window.removeEventListener('pointerdown', onSkip, true);
    window.removeEventListener('keydown', onSkip, true);
  };

  function mediaStyle(el: HTMLElement, fit: BootFitMode): void {
    if (fit === 'tile') return; // 平铺走背景 div，不作用于元素
    el.style.objectFit = fit === 'stretch' ? 'fill' : fit;
  }

  function disposeLayer(): void {
    clearTimers();
    detachSkip();
    finishCurrent = null;
    layer?.remove();
    layer = null;
  }

  async function fadeAndRemove(): Promise<void> {
    const el = layer;
    if (!el) return;
    el.style.opacity = '0';
    await new Promise<void>((resolve) => later(resolve, fadeMs));
    disposeLayer();
  }

  return {
    play(asset, fit, maxDurationMs = 0) {
      if (disposed) return Promise.resolve('failed');
      disposeLayer(); // 同一实例重复 play（面板试播）：先收掉上一次
      const el = doc.createElement('div');
      el.className = LAYER_CLASS;
      el.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:#000;overflow:hidden;opacity:1;transition:opacity ' + fadeMs + 'ms linear';
      doc.documentElement.appendChild(el);
      layer = el;
      attachSkip();
      return new Promise<BootResult>((resolve) => {
        let settled = false;
        const finish = (result: BootResult) => {
          if (settled) return;
          settled = true;
          finishCurrent = null;
          clearTimers();
          detachSkip();
          void fadeAndRemove().then(() => resolve(result));
        };
        finishCurrent = finish;
        const timeout = later(() => finish('timeout'), readyTimeoutMs);
        const started = (mediaEl: HTMLElement) => {
          clearTimeoutByHandle(timeout);
          const duration = asset.kind === 'image'
            ? Math.min(maxDurationMs > 0 ? maxDurationMs : imageDurationMs, imageDurationMs || (maxDurationMs || imageDurationMs))
            : maxDurationMs;
          if (duration > 0) later(() => finish('ended'), duration);
          void mediaEl;
        };
        const clearTimeoutByHandle = (t: ReturnType<typeof setTimeout>) => {
          if (timers.delete(t)) clearTimeout(t);
        };

        if (asset.kind === 'video') {
          const video = doc.createElement('video');
          video.autoplay = true;
          video.muted = true;
          video.playsInline = true;
          video.preload = 'auto';
          video.style.cssText = 'width:100%;height:100%;border:0;display:block';
          mediaStyle(video, fit);
          video.addEventListener('loadeddata', () => started(video), { once: true });
          video.addEventListener('ended', () => finish('ended'), { once: true });
          video.addEventListener('error', () => finish('failed'), { once: true });
          el.appendChild(video);
          video.src = asset.url;
          try { void video.play().catch(() => {}); } catch { /* jsdom/自动播放拒绝 */ }
        } else {
          const startedImage = () => started(el);
          if (fit === 'tile') {
            const tile = doc.createElement('div');
            tile.className = 'wp-boot-tile';
            tile.style.cssText = 'position:absolute;inset:0;background-image:url("' + asset.url.replace(/"/g, '%22') + '");background-repeat:repeat;background-position:center';
            el.appendChild(tile);
            const probe = doc.createElement('img');
            probe.style.display = 'none';
            probe.addEventListener('load', startedImage, { once: true });
            probe.addEventListener('error', () => finish('failed'), { once: true });
            probe.src = asset.url;
            el.appendChild(probe);
          } else {
            const img = doc.createElement('img');
            img.style.cssText = 'width:100%;height:100%;display:block';
            mediaStyle(img, fit);
            img.addEventListener('load', startedImage, { once: true });
            img.addEventListener('error', () => finish('failed'), { once: true });
            el.appendChild(img);
            img.src = asset.url;
          }
        }
      });
    },
    dispose() {
      disposed = true;
      disposeLayer();
    },
  };
}
```

> 实现提示：`started()` 里图片时长表达式可简化为 `const duration = asset.kind === 'image' ? (maxDurationMs > 0 ? Math.min(imageDurationMs, maxDurationMs) : imageDurationMs) : maxDurationMs;`（以上代码块中该行请按此简化后再落盘，避免重复计算）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/dom/boot-overlay.dom.test.ts --reporter=basic`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/client/boot-overlay.ts tests/dom/boot-overlay.dom.test.ts
git commit -m "feat(client): 开机动画全屏播放器（四种适配 + 跳过/超时/淡出）"
```

---

### Task 4: `boot-player.ts`（素材解析 + 是否播 + 编排）

**Files:**
- Create: `src/client/boot-player.ts`
- Test: `tests/boot-player.test.ts`

**Interfaces:**
- Consumes：`BootAsset`/`BootFitMode`/`BootOverlay`/`BootResult`（Task 3）；`ClientSettings`（Task 1）
- Produces：
  - `BOOT_PLAYED_KEY = 'we:boot-played'`
  - `bootAssetFromSettings(s: ClientSettings): BootAsset | null`
  - `shouldPlayBoot(s: ClientSettings, storage: Pick<Storage, 'getItem'>): boolean`
  - `createBootPlayer(opts: { readSettings: () => Promise<ClientSettings>; overlay?: BootOverlay; storage?: Pick<Storage, 'getItem' | 'setItem'> }): BootPlayer`
  - `BootPlayer.start()`、`play({ force?: boolean })`、`getLast(): BootLastResult | null`、`dispose()`
  - `BootLastResult = { result: BootResult; at: number; asset: BootAsset | null }`

- [ ] **Step 1: 写失败测试**

新建 `tests/boot-player.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { BOOT_PLAYED_KEY, bootAssetFromSettings, createBootPlayer, shouldPlayBoot } from '../src/client/boot-player.js';
import type { ClientSettings } from '../src/client/types.js';
import { DEFAULTS } from '../src/client/settings.js';

const S = (patch: Partial<ClientSettings> = {}): ClientSettings => ({ ...DEFAULTS, ...patch });

function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, dump: () => Object.fromEntries(m) };
}

describe('bootAssetFromSettings', () => {
  it('本地视频 → boot 路由 URL（路径编码）', () => {
    expect(bootAssetFromSettings(S({ bootAnimationSource: 'local', bootAnimationLocalPath: 'E:\\clips\\a b.mp4' })))
      .toEqual({ kind: 'video', url: '/wallpapers/boot/local-video?path=' + encodeURIComponent('E:\\clips\\a b.mp4') });
  });
  it('WE 视频/图片壁纸 → media 路由', () => {
    expect(bootAssetFromSettings(S({ bootAnimationWallpaperId: '9', bootAnimationWallpaperKind: 'video' })))
      .toEqual({ kind: 'video', url: '/wallpapers/media/9/file' });
    expect(bootAssetFromSettings(S({ bootAnimationWallpaperId: '9', bootAnimationWallpaperKind: 'image' })))
      .toEqual({ kind: 'image', url: '/wallpapers/media/9/preview' });
  });
  it('缺字段 → null', () => {
    expect(bootAssetFromSettings(S())).toBeNull();
    expect(bootAssetFromSettings(S({ bootAnimationWallpaperId: '9', bootAnimationWallpaperKind: '' }))).toBeNull();
  });
});

describe('shouldPlayBoot', () => {
  it('关闭或已播过 → false', () => {
    expect(shouldPlayBoot(S(), memStorage())).toBe(false);
    expect(shouldPlayBoot(S({ bootAnimationEnabled: true }), memStorage({ [BOOT_PLAYED_KEY]: '1' }))).toBe(false);
    expect(shouldPlayBoot(S({ bootAnimationEnabled: true }), memStorage())).toBe(true);
  });
});

describe('createBootPlayer', () => {
  it('start：播放并写标记、记录结果', async () => {
    const storage = memStorage();
    const overlay = { play: vi.fn(async () => 'ended' as const), dispose: vi.fn() };
    const player = createBootPlayer({
      readSettings: async () => S({ bootAnimationEnabled: true, bootAnimationSource: 'local', bootAnimationLocalPath: '/a.mp4' }),
      overlay, storage,
    });
    await expect(player.start()).resolves.toBe('ended');
    expect(overlay.play).toHaveBeenCalledTimes(1);
    expect(storage.dump()[BOOT_PLAYED_KEY]).toBe('1');
    expect(player.getLast()?.asset).toEqual({ kind: 'video', url: '/wallpapers/boot/local-video?path=' + encodeURIComponent('/a.mp4') });
  });
  it('未启用 → disabled；已播过 → already-played（不调 overlay）', async () => {
    const overlay = { play: vi.fn(async () => 'ended' as const), dispose: vi.fn() };
    const off = createBootPlayer({ readSettings: async () => S(), overlay });
    await expect(off.start()).resolves.toBe('disabled');

    const storage = memStorage({ [BOOT_PLAYED_KEY]: '1' });
    const done = createBootPlayer({
      readSettings: async () => S({ bootAnimationEnabled: true, bootAnimationSource: 'local', bootAnimationLocalPath: '/a.mp4' }),
      overlay, storage,
    });
    await expect(done.start()).resolves.toBe('already-played');
    expect(overlay.play).not.toHaveBeenCalled();
  });
  it('无素材 → no-asset；力播放（force）绕过开关与标记', async () => {
    const overlay = { play: vi.fn(async () => 'skipped' as const), dispose: vi.fn() };
    const storage = memStorage({ [BOOT_PLAYED_KEY]: '1' });
    const player = createBootPlayer({
      readSettings: async () => S({ bootAnimationEnabled: true, bootAnimationSource: 'local', bootAnimationLocalPath: '/a.mp4' }),
      overlay, storage,
    });
    await expect(player.play({ force: true })).resolves.toBe('skipped');
    await expect(player.play({ force: true })).resolves.toBe('skipped');

    const empty = createBootPlayer({ readSettings: async () => S({ bootAnimationEnabled: true }), overlay });
    await expect(empty.start()).resolves.toBe('no-asset');
  });
  it('overlay 抛错 → failed，不抛出；dispose 后不再播放', async () => {
    const overlay = { play: vi.fn(async () => { throw new Error('boom'); }), dispose: vi.fn() };
    const player = createBootPlayer({
      readSettings: async () => S({ bootAnimationEnabled: true, bootAnimationSource: 'local', bootAnimationLocalPath: '/a.mp4' }),
      overlay, storage: memStorage(),
    });
    await expect(player.start()).resolves.toBe('failed');
    player.dispose();
    expect(overlay.dispose).toHaveBeenCalledTimes(1);
    await expect(player.play({ force: true })).resolves.toBe('failed');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/boot-player.test.ts --reporter=basic`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `src/client/boot-player.ts`**

```ts
// 开机动画编排：读设置 → 判断是否播（开关 + 每页面会话一次）→ 组装素材 URL → 调 overlay。
// 失败一律静默（返回失败码供面板展示），不阻塞主界面、不抛异常。
import { createBootOverlay } from './boot-overlay.js';
import type { BootAsset, BootFitMode, BootOverlay, BootResult } from './boot-overlay.js';
import type { ClientSettings } from './types.js';

export const BOOT_PLAYED_KEY = 'we:boot-played';

const FIT_MODES: ReadonlySet<string> = new Set(['tile', 'contain', 'stretch', 'cover']);

export function normalizeBootFit(value: string): BootFitMode {
  return (FIT_MODES.has(value) ? value : 'cover') as BootFitMode;
}

export function bootAssetFromSettings(s: ClientSettings): BootAsset | null {
  if (s.bootAnimationSource === 'local') {
    const p = s.bootAnimationLocalPath.trim();
    return p ? { kind: 'video', url: '/wallpapers/boot/local-video?path=' + encodeURIComponent(p) } : null;
  }
  const id = s.bootAnimationWallpaperId.trim();
  const kind = s.bootAnimationWallpaperKind;
  if (!id || (kind !== 'video' && kind !== 'image')) return null;
  return kind === 'video'
    ? { kind: 'video', url: `/wallpapers/media/${encodeURIComponent(id)}/file` }
    : { kind: 'image', url: `/wallpapers/media/${encodeURIComponent(id)}/preview` };
}

export function shouldPlayBoot(s: ClientSettings, storage: Pick<Storage, 'getItem'>): boolean {
  if (!s.bootAnimationEnabled) return false;
  try { return storage.getItem(BOOT_PLAYED_KEY) !== '1'; } catch { return true; }
}

export interface BootLastResult { result: BootResult; at: number; asset: BootAsset | null }

export interface BootPlayer {
  start(): Promise<BootResult>;
  play(opts?: { force?: boolean }): Promise<BootResult>;
  getLast(): BootLastResult | null;
  dispose(): void;
}

function sessionStorageSafe(): Pick<Storage, 'getItem' | 'setItem'> {
  try {
    if (typeof sessionStorage !== 'undefined') return sessionStorage;
  } catch { /* 隐私模式访问抛错 */ }
  return { getItem: () => null, setItem: () => {} };
}

export function createBootPlayer(opts: {
  readSettings: () => Promise<ClientSettings>;
  overlay?: BootOverlay;
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
}): BootPlayer {
  const overlay = opts.overlay ?? createBootOverlay();
  const storage = opts.storage ?? sessionStorageSafe();
  let disposed = false;
  let last: BootLastResult | null = null;
  let running: Promise<BootResult> | null = null;

  const record = (result: BootResult, asset: BootAsset | null): BootResult => {
    last = { result, at: Date.now(), asset };
    return result;
  };

  async function run(force: boolean): Promise<BootResult> {
    if (disposed) return 'failed';
    let settings: ClientSettings;
    try { settings = await opts.readSettings(); } catch { return record('failed', null); }
    if (disposed) return 'failed';
    if (!force) {
      if (!settings.bootAnimationEnabled) return record('disabled', null);
      if (!shouldPlayBoot(settings, storage)) return record('already-played', null);
    }
    const asset = bootAssetFromSettings(settings);
    if (!asset) return record('no-asset', null);
    if (!force) {
      try { storage.setItem(BOOT_PLAYED_KEY, '1'); } catch { /* 写不进就按播放处理，避免反复触发 */ }
    }
    let result: BootResult;
    try {
      result = await overlay.play(asset, normalizeBootFit(settings.bootAnimationFitMode), settings.bootAnimationMaxDurationMs);
    } catch {
      result = 'failed';
    }
    return record(result, asset);
  }

  return {
    start() {
      running ??= run(false).finally(() => { running = null; });
      return running;
    },
    play(opts) { return run(opts?.force ?? true); },
    getLast() { return last; },
    dispose() { disposed = true; overlay.dispose(); },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/boot-player.test.ts --reporter=basic`
Expected: PASS（`start` 并发去重用同一 Promise，测试顺序调用不受影响）

- [ ] **Step 5: Commit**

```bash
git add src/client/boot-player.ts tests/boot-player.test.ts
git commit -m "feat(client): 开机动画编排（素材解析/只播一次/静默失败）"
```

---

### Task 5: 独立设置面板 + 样式

**Files:**
- Create: `src/client/boot-settings-section.tsx`
- Modify: `src/client/styles.ts`（CSS 常量末尾追加 `wp-boot-layer` + `wbs-*`）
- Test: `tests/dom/boot-settings-section.dom.test.tsx`

**Interfaces:**
- Consumes：`readClientSettings`/`writeClientSettings`（`settings.ts`）、`WallpaperInfo`（`shared/types.ts`）、Task 1 字段、`window.__wallpaperEngineBoot.play/getLast`（Task 6 注入）。
- Produces：`BootSettingsSection(props: BootSettingsSectionProps): JSX.Element`；props：
  - `fetchSettings?: () => Promise<ClientSettings>`（默认 `readClientSettings`）
  - `writeSettings?: (patch: Partial<ClientSettings>) => Promise<boolean | void>`（默认 `writeClientSettings`）
  - `fetchWallpapers?: () => Promise<WallpaperInfo[]>`（默认 `GET /wallpapers/list`）
  - `probePath?: (path: string) => Promise<{ ok: boolean; exists?: boolean; isFile?: boolean; size?: number; playable?: boolean; error?: string }>`（默认 `GET /wallpapers/boot/probe`）
  - `playPreview?: () => Promise<string>`（默认 `window.__wallpaperEngineBoot?.play({force:true}) ?? 'failed'`）
  - `getLast?: () => { result: string; at: number } | null`（默认读 `window.__wallpaperEngineBoot?.getLast()`）
- 类名契约（测试断言用）：`.wbs-root`、`.wbs-enable`、`.wbs-source-we`、`.wbs-source-local`、`.wbs-wallpaper`、`.wbs-local-path`、`.wbs-probe`、`.wbs-probe-result`、`.wbs-fit-{tile,contain,stretch,cover}`、`.wbs-max-duration`、`.wbs-preview`、`.wbs-last`、`.wbs-message`。

- [ ] **Step 1: 写失败测试**

新建 `tests/dom/boot-settings-section.dom.test.tsx`：

```tsx
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { BootSettingsSection } from '../../src/client/boot-settings-section.js';
import type { ClientSettings } from '../../src/client/types.js';
import { DEFAULTS } from '../../src/client/settings.js';

const SETTINGS: ClientSettings = { ...DEFAULTS };
const LIST = [
  { id: '1', title: 'Scene', type: 'scene', hasScene: true, hasPreviewGif: false, previewUrl: '/p1' },
  { id: '2', title: 'Clip', type: 'video', file: 'a.mp4', hasScene: false, hasPreviewGif: false, previewUrl: '/p2' },
  { id: '3', title: 'Photo', type: 'image', hasScene: false, hasPreviewGif: false, previewUrl: '/p3' },
] as any[];

let container: HTMLElement;
let root: Root;
let writeSettings: ReturnType<typeof vi.fn>;

function render(props: Partial<React.ComponentProps<typeof BootSettingsSection>> = {}) {
  writeSettings = vi.fn(async () => true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const fetchSettings = vi.fn(async () => ({ ...SETTINGS }));
  act(() => {
    root.render(<BootSettingsSection
      fetchSettings={fetchSettings}
      writeSettings={writeSettings}
      fetchWallpapers={async () => LIST}
      probePath={async () => ({ ok: true, exists: true, isFile: true, size: 1024, playable: true })}
      playPreview={async () => 'ended'}
      getLast={() => null}
      {...props}
    />);
  });
  return { fetchSettings };
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

describe('BootSettingsSection', () => {
  it('默认关闭；WE 素材只列 video/image 两类', async () => {
    await act(async () => { render(); });
    const enable = document.querySelector<HTMLInputElement>('.wbs-enable')!;
    expect(enable.checked).toBe(false);
    const opts = Array.from(document.querySelectorAll<HTMLOptionElement>('.wbs-wallpaper option')).map((o) => o.value);
    expect(opts).toEqual(['', '2', '3']);
  });

  it('选择 WE 视频壁纸写入 id + kind；视频时平铺禁用', async () => {
    await act(async () => { render(); });
    const select = document.querySelector<HTMLSelectElement>('.wbs-wallpaper')!;
    await act(async () => { select.value = '2'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(writeSettings).toHaveBeenCalledWith({ bootAnimationWallpaperId: '2', bootAnimationWallpaperKind: 'video' });
    const tile = document.querySelector<HTMLInputElement>('.wbs-fit-tile')!;
    expect(tile.disabled).toBe(true);
  });

  it('本地路径校验显示结果；试播调用 playPreview', async () => {
    await act(async () => { render(); });
    const local = document.querySelector<HTMLInputElement>('.wbs-source-local')!;
    await act(async () => { local.click(); });
    const input = document.querySelector<HTMLInputElement>('.wbs-local-path')!;
    await act(async () => { input.value = 'E:\\a.mp4'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => { document.querySelector<HTMLButtonElement>('.wbs-probe')!.click(); });
    expect(document.querySelector('.wbs-probe-result')!.textContent).toContain('可播放');
    await act(async () => { document.querySelector<HTMLButtonElement>('.wbs-preview')!.click(); });
    expect(document.querySelector('.wbs-message')!.textContent).toContain('ended');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/dom/boot-settings-section.dom.test.tsx --reporter=basic`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现 `src/client/boot-settings-section.tsx`**

```tsx
// DSH 设置对话框「开机动画」独立 section（wbs-* 类）：与「Wallpaper 壁纸」页互不影响。
// 数据与动作经 props 注入（默认走真实 API / window.__wallpaperEngineBoot），便于 jsdom 单测。
import { useEffect, useState } from 'react';
import type { ClientSettings } from './types.js';
import type { WallpaperInfo } from '../shared/types.js';
import { readClientSettings, writeClientSettings } from './settings.js';

interface ProbeInfo { ok: boolean; exists?: boolean; isFile?: boolean; size?: number; playable?: boolean; error?: string }

export interface BootSettingsSectionProps {
  fetchSettings?: () => Promise<ClientSettings>;
  writeSettings?: (patch: Partial<ClientSettings>) => Promise<boolean | void>;
  fetchWallpapers?: () => Promise<WallpaperInfo[]>;
  probePath?: (path: string) => Promise<ProbeInfo>;
  playPreview?: () => Promise<string>;
  getLast?: () => { result: string; at: number } | null;
}

async function defaultFetchWallpapers(): Promise<WallpaperInfo[]> {
  return (await fetch('/wallpapers/list')).json();
}
async function defaultProbePath(path: string): Promise<ProbeInfo> {
  const r = await fetch('/wallpapers/boot/probe?path=' + encodeURIComponent(path));
  return r.json();
}
function bootApi(): any { return (globalThis as any).__wallpaperEngineBoot; }
async function defaultPlayPreview(): Promise<string> {
  return bootApi()?.play?.({ force: true }) ?? 'disabled';
}

const FITS: Array<{ value: string; label: string }> = [
  { value: 'tile', label: '平铺' },
  { value: 'contain', label: '居中' },
  { value: 'stretch', label: '挤压' },
  { value: 'cover', label: '裁切填满' },
];
const RESULT_TEXT: Record<string, string> = {
  ended: '播放完成', skipped: '已跳过', timeout: '素材超时（已跳过）', failed: '播放失败（已跳过）',
  'already-played': '本次会话已播过', disabled: '未启用', 'no-asset': '未选择素材',
};
const formatSize = (n?: number) => (typeof n === 'number' ? (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB') : '-');

export function BootSettingsSection(props: BootSettingsSectionProps): JSX.Element {
  const fetchSettings = props.fetchSettings ?? readClientSettings;
  const save = props.writeSettings ?? writeClientSettings;
  const fetchWallpapers = props.fetchWallpapers ?? defaultFetchWallpapers;
  const probePath = props.probePath ?? defaultProbePath;
  const playPreview = props.playPreview ?? defaultPlayPreview;
  const getLast = props.getLast ?? (() => bootApi()?.getLast?.() ?? null);

  const [settings, setSettings] = useState<ClientSettings | null>(null);
  const [wallpapers, setWallpapers] = useState<WallpaperInfo[]>([]);
  const [probe, setProbe] = useState<ProbeInfo | null>(null);
  const [message, setMessage] = useState('');
  const [last, setLast] = useState<{ result: string; at: number } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [s, list] = await Promise.all([fetchSettings(), fetchWallpapers().catch(() => [] as WallpaperInfo[])]);
      if (!alive) return;
      setSettings(s);
      setWallpapers(list.filter((w) => w.type === 'video' || w.type === 'image'));
      setLast(getLast());
    })();
    return () => { alive = false; };
  }, []);

  if (!settings) return <div className="wbs-root wbs-loading">加载中…</div>;
  const patch = async (p: Partial<ClientSettings>) => {
    const next = { ...settings, ...p };
    setSettings(next);
    const ok = await save(p);
    if (ok === false) setMessage('保存失败：设置服务不可用');
  };
  const source = settings.bootAnimationSource === 'local' ? 'local' : 'we';
  const selectedKind = settings.bootAnimationWallpaperKind;
  const isVideoAsset = source === 'local' || selectedKind === 'video';

  return (
    <div className="wbs-root">
      <section className="wbs-section">
        <h4 className="wbs-title">开机动画 · 与日常壁纸互不影响</h4>
        <p className="wbs-desc">打开 DSH 时全屏播一段片头，播完淡出进入界面；固定静音，每次启动/新窗口只播一次（刷新不重播）。</p>
        <label className="wbs-row">
          <input type="checkbox" className="wbs-enable" checked={settings.bootAnimationEnabled}
            onChange={(e) => void patch({ bootAnimationEnabled: e.target.checked })} />
          <span>启用开机动画</span>
        </label>
        {last && <p className="wbs-last">上次播放：{RESULT_TEXT[last.result] ?? last.result}</p>}
      </section>

      <section className="wbs-section">
        <h4 className="wbs-title">素材</h4>
        <label className="wbs-row">
          <input type="radio" className="wbs-source-we" checked={source === 'we'}
            onChange={() => void patch({ bootAnimationSource: 'we' })} />
          <span>从 Wallpaper Engine 库选择（仅视频 / 图片类）</span>
        </label>
        <select className="wbs-wallpaper" value={settings.bootAnimationWallpaperId}
          onChange={(e) => {
            const w = wallpapers.find((x) => x.id === e.target.value);
            void patch({
              bootAnimationWallpaperId: e.target.value,
              bootAnimationWallpaperKind: w ? (w.type === 'image' ? 'image' : 'video') : '',
            });
          }}>
          <option value="">（未选择）</option>
          {wallpapers.map((w) => <option key={w.id} value={w.id}>{w.title} · {w.type === 'image' ? '图片' : '视频'}</option>)}
        </select>
        {wallpapers.length === 0 && <p className="wbs-desc">壁纸列表为空：请先在「Wallpaper 壁纸」页配置目录或点刷新。</p>}

        <label className="wbs-row">
          <input type="radio" className="wbs-source-local" checked={source === 'local'}
            onChange={() => void patch({ bootAnimationSource: 'local' })} />
          <span>本地视频文件（绝对路径）</span>
        </label>
        <div className="wbs-row">
          <input type="text" className="wbs-local-path" placeholder="E:\\clips\\boot.mp4"
            value={settings.bootAnimationLocalPath}
            onChange={(e) => setSettings({ ...settings, bootAnimationLocalPath: e.target.value })}
            onBlur={(e) => void patch({ bootAnimationLocalPath: e.target.value })} />
          <button type="button" className="wbs-probe" onClick={async () => setProbe(await probePath(settings.bootAnimationLocalPath))}>校验</button>
        </div>
        {probe && (
          <p className="wbs-probe-result">
            {probe.ok ? `文件存在 · ${formatSize(probe.size)} · ${probe.playable ? '可播放' : '扩展名不支持'}` : `不可用：${probe.error ?? '路径无效'}`}
          </p>
        )}
      </section>

      <section className="wbs-section">
        <h4 className="wbs-title">展示方式</h4>
        {FITS.map((f) => (
          <label className="wbs-row" key={f.value}>
            <input type="radio" className={'wbs-fit-' + f.value} checked={settings.bootAnimationFitMode === f.value}
              disabled={f.value === 'tile' && isVideoAsset}
              onChange={() => void patch({ bootAnimationFitMode: f.value })} />
            <span>{f.label}{f.value === 'tile' && isVideoAsset ? '（视频不支持平铺）' : ''}</span>
          </label>
        ))}
      </section>

      <section className="wbs-section">
        <h4 className="wbs-title">最长播放</h4>
        <label className="wbs-row">
          <input type="range" className="wbs-max-duration" min={0} max={30} step={1}
            value={Math.round(settings.bootAnimationMaxDurationMs / 1000)}
            onChange={(e) => void patch({ bootAnimationMaxDurationMs: Number(e.target.value) * 1000 })} />
          <span className="wbs-duration-value">{settings.bootAnimationMaxDurationMs === 0 ? '播完 / 不限' : Math.round(settings.bootAnimationMaxDurationMs / 1000) + ' 秒'}</span>
        </label>
        <p className="wbs-desc">0 = 视频播完为止；图片固定约 4 秒。素材 8 秒未就绪会自动跳过。</p>
      </section>

      <div className="wbs-row">
        <button type="button" className="wbs-preview" onClick={async () => { setMessage('播放中…'); setMessage('结果：' + (RESULT_TEXT[await playPreview()] ?? '失败')); }}>试播</button>
      </div>
      {message && <p className="wbs-message">{message}</p>}
    </div>
  );
}
```

- [ ] **Step 4: 追加样式**

`src/client/styles.ts` 的 CSS 常量末尾（反引号前）追加：

```css
/* ── 开机动画（独立全屏层 + 独立设置面板 wbs-*） ── */
.wp-boot-layer{position:fixed;inset:0;z-index:2147483000;background:#000;overflow:hidden;pointer-events:auto}
.wbs-root{display:flex;flex-direction:column;gap:14px;padding:4px 2px}
.wbs-section{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--wp-panel-border);border-radius:10px;background:var(--wp-panel-bg)}
.wbs-title{margin:0;font-size:14px;color:var(--wp-text)}
.wbs-desc{margin:0;font-size:12px;line-height:1.5;opacity:.75}
.wbs-row{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--wp-text)}
.wbs-row input[type=text]{flex:1;min-width:160px;padding:6px 8px;border-radius:6px;border:1px solid var(--wp-panel-border);background:transparent;color:var(--wp-text)}
.wbs-row select{padding:6px 8px;border-radius:6px;border:1px solid var(--wp-panel-border);background:transparent;color:var(--wp-text)}
.wbs-row button{padding:5px 10px;border-radius:6px;border:1px solid var(--wp-panel-border);background:transparent;color:var(--wp-text);cursor:pointer}
.wbs-row button:disabled,.wbs-row input:disabled{opacity:.45;cursor:not-allowed}
.wbs-probe-result,.wbs-last,.wbs-message{font-size:12px;margin:0;color:var(--wp-text)}
.wbs-message{opacity:.85}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/dom/boot-settings-section.dom.test.tsx --reporter=basic`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/client/boot-settings-section.tsx src/client/styles.ts tests/dom/boot-settings-section.dom.test.tsx
git commit -m "feat(client): 开机动画独立设置面板（wbs-*，含试播/校验）"
```

---

### Task 6: `index.ts` 集成（启动/收尾/第二个 section/清理残留）

**Files:**
- Modify: `src/client/index.ts`（import、bootstrap 创建与启动、window API、第二个 section、teardown、残留清理）
- Test: `tests/dom/plugin-lifecycle.dom.test.ts`（新增用例）

**Interfaces:**
- Consumes：`createBootPlayer`（Task 4）、`BootSettingsSection`（Task 5）
- Produces：
  - `window.__wallpaperEngineBoot = { play(opts?: { force?: boolean }): Promise<BootResult>; getLast(): BootLastResult | null }`
  - teardown 后：无 `.wp-boot-layer`、`window.__wallpaperEngineBoot` 删除
  - 设置菜单：`settings.section` 新增 `{ id: 'wallpaper-engine-boot', order: 21, label: '开机动画' }`

- [ ] **Step 1: 写失败测试**

`tests/dom/plugin-lifecycle.dom.test.ts` 的 `describe` 内追加：

```ts
  it('teardown 摘掉开机动画层与 boot API；mount 清理无主 boot 层', async () => {
    const stale = document.createElement('div');
    stale.className = 'wp-boot-layer';
    document.documentElement.appendChild(stale);

    const api = await applyFresh();
    expect(document.querySelectorAll('.wp-boot-layer')).toHaveLength(0); // mount 兜底清掉无主残留
    expect(typeof (window as any).__wallpaperEngineBoot?.play).toBe('function');

    for (const dispose of disposers) dispose();
    expect((window as any).__wallpaperEngineBoot).toBeUndefined();
    expect(document.querySelectorAll('.wp-boot-layer')).toHaveLength(0);
    void api;
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/dom/plugin-lifecycle.dom.test.ts --reporter=basic`
Expected: FAIL（`__wallpaperEngineBoot` 未定义 / 残留层未清）

- [ ] **Step 3: 实现集成**

`src/client/index.ts`：

1）import 区追加：

```ts
import { createBootPlayer } from './boot-player.js';
import { BootSettingsSection } from './boot-settings-section.js';
```

2）`bootstrap()` 内、`injectWallpaperStyles()` 之后创建并尽早启动：

```ts
  // 开机动画：独立于壁纸层（不参与 mount/controller），页面加载后尽早覆盖。
  const bootPlayer = createBootPlayer({ readSettings: readClientSettings });
  (window as any).__wallpaperEngineBoot = {
    play: (opts?: { force?: boolean }) => bootPlayer.play(opts),
    getLast: () => bootPlayer.getLast(),
  };
  void bootPlayer.start();
```

3）`teardown` 内、`root?.remove()` 之后追加：

```ts
    bootPlayer.dispose();
    delete (window as any).__wallpaperEngineBoot;
    // 无主残留（老版本/HMR 中断）一并摘掉：层独立于背景层，不会自己消失。
    for (const el of Array.from(document.querySelectorAll('.wp-boot-layer'))) el.remove();
```

4）`mount()` 的 `dropStaleLayers()` 内、遍历 `.wp-background-layer` 之前追加同样一行残留清理：

```ts
    for (const el of Array.from(document.querySelectorAll('.wp-boot-layer'))) el.remove();
```

5）settings.section 注册回调内，现有 `ctx.slots.register(... WallpaperSettingsSection)` 之后追加第二个注册：

```ts
    ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: 'wallpaper-engine-boot',
      order: 21,
      label: () => '开机动画',
    }, BootSettingsSection));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/dom/plugin-lifecycle.dom.test.ts tests/dom/bootstrap.dom.test.ts --reporter=basic`
Expected: PASS（若 bootstrap 测试因 window 属性残留断言失败，在用例 afterEach 补 `delete (window as any).__wallpaperEngineBoot`）

- [ ] **Step 5: Commit**

```bash
git add src/client/index.ts tests/dom/plugin-lifecycle.dom.test.ts
git commit -m "feat(client): 挂载开机动画播放器与独立设置 section"
```

---

### Task 7: 文档、产物与全量验收

**Files:**
- Modify: `AGENT.md`（§1 能力、§2.2 模块清单、§5 新增一条约束、§7 边界）
- Modify: `lib/**`、`dist/**`（构建产物，入库）
- Test: 全量

- [ ] **Step 1: 更新 AGENT.md**

- §1 项目概述「能力」段追加一句：`开机动画：独立设置项，素材为 WE 库 video/image 壁纸或本地视频绝对路径（host 仅回环来源流式），四种展示方式，每次冷启动播一次、固定静音、8s 超时静默跳过。`
- §2.2 host 列表追加 `routes.ts` 的 boot 路由 + `client/boot-overlay.ts`、`client/boot-player.ts`、`client/boot-settings-section.tsx`。
- §5 硬约束追加一条（编号接续现有最大号）：`开机动画只做「视频/图片素材的全屏层」，scene/web 不做实时渲染；本地视频路由必须仅回环来源（dsh web 可绑 0.0.0.0，否则等于任意文件读取口子）。`
- §7 已知边界追加：桌面壳自身闪屏无法替换，插件只能在页面加载后覆盖；固定静音；平铺仅图片。

- [ ] **Step 2: 构建产物**

Run: `npm run build && npm run build:client`
Expected: 退出码 0；`lib/client/boot-*.js` 与 `dist/client.js` 更新

- [ ] **Step 3: 全量测试与门禁**

Run: `npm test`
Expected: 全部 PASS（基线为空，无新增失败）

Run: `npm run typecheck:tests && npm run verify:arch`
Expected: 退出码 0

- [ ] **Step 4: 提交**

```bash
git add AGENT.md lib dist
git commit -m "docs+chore: 开机动画能力文档与构建产物

独立设置项；WE video/image 素材或本地视频路径；四种展示方式；只播一次、静默失败。"
```

- [ ] **Step 5: 手工验收（真机，可选但推荐）**

1. `dsh plugin --profile desktop ...`（桌面端用插件页/市场重装）→ 完全退出 DSH 重开。
2. 设置 → 开机动画：开启；WE 素材选一个 video 壁纸 → 保存 → 重开/新窗口看片头；试播确认四种展示方式。
3. 本地视频：填 `E:\...\x.mp4` → 校验显示大小/可播放 → 试播。
4. 刷新页面确认不重播；设置 → Wallpaper 壁纸确认日常壁纸行为未变。

---

## Self-Review（计划自查）

**Spec 覆盖**：设置字段（Task 1）、host 两条路由与安全边界（Task 2）、overlay 四模式/跳过/超时/淡出（Task 3）、只播一次与素材解析（Task 4）、独立面板（Task 5）、生命周期与残留清理（Task 6）、文档与产物（Task 7）——spec §1–§15 均有对应任务。

**占位符扫描**：无 TBD/TODO；每个实现步骤给可落盘代码与确切测试命令。

**类型一致性**：`BootResult` 7 个值在 Task 3/4/5 一致；`bootAnimation*` 7 字段在 Task 1/4/5/6 一致；`window.__wallpaperEngineBoot` 形状在 Task 4/5/6 一致；`normalizeBootFit` 在 Task 4 定义、Task 6 间接使用。
