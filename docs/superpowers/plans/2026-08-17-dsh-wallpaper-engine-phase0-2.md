# DSH Wallpaper Engine 壁纸背景插件（阶段 0-2）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 DSH Web GUI 背景可以使用本机 Wallpaper Engine 壁纸库：全库 26 个壁纸均有可用背景（视频播放 / GIF / 静态图 + Ken Burns），其中 EVA 壁纸（1280029027）由 Three.js 在浏览器实时渲染出动态粒子场景。

**Architecture:** 一个 Cordis 插件包（`dsh-wallpaper-engine`）双面实现：host 侧（Node）负责 PKGV 解包、壁纸扫描、HTTP 路由、设置注册；client 侧（浏览器，`__ModuleLoader__` 模块）负责背景渲染层（多级回退）与 Three.js scene 渲染器。全部复用 DSH 自带 webserver，同源无跨域。

**Tech Stack:** TypeScript（strict、ESM）、Node ≥ 22、cordis（`@deepseek-ai/cordis` peer）、`@deepseek-ai/schemastery`（设置 schema）、three（WebGL 渲染）、esbuild（client 打包）、vitest + jsdom（测试）。

**Spec:** `docs/superpowers/specs/2026-08-17-dsh-wallpaper-engine-design.md`（本计划从该 spec 推导，执行者需同时阅读两者）

## Global Constraints

- 包形式：`packages/dsh-wallpaper-engine`，ESM-only，TypeScript `strict: true`。
- 壁纸库路径默认 `D:\Steam\steamapps\workshop\content\431960`，可经插件 config 覆盖。
- 所有 HTTP 路由挂在 DSH webserver 服务（`ctx.webServer.register`），不另起端口。
- 文件读写仅限壁纸库目录与项目目录；所有来自 URL 的路径参数必须做规范化与穿越防护。
- 提交信息使用中文（项目 AGENTS.md 要求）。
- 测试命令：`npm test`（= `vitest run`）；client 构建：`npm run build:client`。
- 不引入任何 Wallpaper Engine 运行时依赖；PKGV/TEX 解析全部自研。
- TDD：每个任务先写失败测试，再实现，测试通过后提交。

## File Structure

```
E:\code\dsh-use-wallpaper\
├─ package.json                    # workspace 根（private，脚本转发）
├─ .gitignore
├─ packages/dsh-wallpaper-engine/
│  ├─ package.json                 # 插件包（exports 含 ./client）
│  ├─ tsconfig.json
│  ├─ cordis.patch.yml             # 插件行注册（id: dsh-wallpaper-engine）
│  ├─ scripts/build-client.mjs     # esbuild 打包 client 入口 → dist/client.js
│  ├─ src/
│  │  ├─ shared/types.ts           # WallpaperInfo / PkgEntry / SceneJson 等共享类型
│  │  ├─ host/
│  │  │  ├─ index.ts               # apply(ctx)：注册设置 + 路由
│  │  │  ├─ settings.ts            # 设置命名空间与 schema
│  │  │  ├─ pkg-reader.ts          # PKGV0001 解包（parsePkg / PkgReader）
│  │  │  ├─ scanner.ts             # 目录扫描 → WallpaperInfo[]
│  │  │  └─ routes.ts              # wallpapers 路由（list/preview/file/scene asset）
│  │  └─ client/
│  │     ├─ index.ts               # __ModuleLoader__.load 入口（注册组件/样式）
│  │     ├─ background-layer.ts    # 全屏背景层 + 多级回退
│  │     ├─ scene-json.ts          # scene.json → 场景描述（纯函数）
│  │     ├─ scene-renderer.ts      # Three.js 渲染器（canvas + 相机 + 图片对象）
│  │     ├─ particles.ts           # 粒子模拟器 v1（emitter/initializer/operator）
│  │     ├─ tex-loader.ts          # .tex → DDS 块 → THREE.CompressedTexture
│  │     └─ picker.ts              # 壁纸缩略图选择 UI
│  └─ tests/
│     ├─ fixtures/eva/             # 从 EVA pkg 提取的真实资源（scene.json 等）
│     ├─ pkg-reader.test.ts
│     ├─ scanner.test.ts
│     ├─ routes.test.ts
│     ├─ scene-json.test.ts
│     ├─ particles.test.ts
│     └─ tex-loader.test.ts
└─ docs/superpowers/plans/        # 本计划
```

## Interfaces（跨任务契约，全部任务共用）

```ts
// src/shared/types.ts
export type WallpaperKind = 'scene' | 'video' | 'web' | 'image' | 'unknown';

export interface WallpaperInfo {
  id: string;                  // workshop id（目录名）
  title: string;
  type: WallpaperKind;
  file?: string;               // project.json 的 file 字段
  hasPreviewGif: boolean;
  hasScene: boolean;           // 存在 scene.pkg
  previewUrl: string;          // `/wallpapers/media/${id}/preview`
}

export interface PkgEntry { name: string; offset: number; size: number; }

export interface SceneImageObject {
  kind: 'image'; id: number; name: string;
  origin: [number, number, number]; scale: [number, number, number];
  image: string;               // 资源名，如 "models/xxx.json"
}
export interface SceneParticleObject {
  kind: 'particle'; id: number; name: string;
  origin: [number, number, number]; scale: [number, number, number];
  particle: string;            // 资源名，如 "particles/presets/lightshafts.json"
}
export type SceneObject = SceneImageObject | SceneParticleObject;

export interface SceneDescription {
  camera: { center: [number, number, number]; eye: [number, number, number]; up: [number, number, number] };
  orthogonal: { width: number; height: number };
  clearColor?: [number, number, number];
  objects: SceneObject[];
}
```

```ts
// src/host/pkg-reader.ts
export function parsePkg(buf: Uint8Array): { entries: PkgEntry[]; dataStart: number }
export class PkgReader {
  constructor(pkgPath: string)
  listEntries(): PkgEntry[]
  readEntry(name: string): Buffer | null   // 未知条目返回 null
}
```

```ts
// src/host/scanner.ts
export async function scanWallpapers(dir: string): Promise<WallpaperInfo[]>
export function kindFromProjectJson(pj: Record<string, unknown>): WallpaperKind
```

```ts
// src/host/settings.ts
export const WALLPAPER_NS = 'wallpaper-engine';
export const WallpaperSettingsSchema: import('@deepseek-ai/schemastery').default.Object
// 字段：selectedWallpaperId: string（默认 ''）、overlayOpacity: number（默认 0.35）、
//       blurEnabled: boolean（默认 false）、blurRadius: number（默认 12）、
//       kenBurns: boolean（默认 true）
```

```ts
// src/host/routes.ts
export interface WallpaperRoutesOptions { wallpaperDir: string }
export function registerWallpaperRoutes(ctx: unknown, opts: WallpaperRoutesOptions): void
// 挂载：GET /wallpapers/list | GET /wallpapers/media/:id/preview | GET /wallpapers/media/:id/file
//       | GET /wallpapers/scene/:id/asset?name=<pkg内条目名>
```

```ts
// src/client/scene-json.ts
export function parseSceneJson(raw: string): SceneDescription
```

```ts
// src/client/tex-loader.ts
export interface TexInfo { width: number; height: number; dds: Uint8Array; glFormat: number }
export function parseTex(buf: Uint8Array): TexInfo | null   // 非压缩变体返回 null
export function glFormatForDds(fourCC: string): number      // 'DXT1'→0x83F1 等
```

```ts
// src/client/particles.ts
export interface ParticleEmitterSpec { rate: number; directions: [number, number, number]; distanceMin: number; distanceMax: number }
export interface ParticleInitializerSpec { lifetimeMin: number; lifetimeMax: number; sizeMin: number; sizeMax: number; velocityMin: [number, number, number]; velocityMax: [number, number, number] }
export interface ParticleSystem { count(): number; update(dt: number): void; positions(): Float32Array }
export function createParticleSystem(emitter: ParticleEmitterSpec, init: ParticleInitializerSpec, opts: { maxParticles: number }): ParticleSystem
```

---

### Task 1: 项目脚手架与 host 插件骨架（可加载）

**Files:**
- Create: `package.json`（workspace 根）、`.gitignore`
- Create: `packages/dsh-wallpaper-engine/package.json`
- Create: `packages/dsh-wallpaper-engine/tsconfig.json`
- Create: `packages/dsh-wallpaper-engine/vitest.config.ts`
- Create: `packages/dsh-wallpaper-engine/scripts/build-client.mjs`
- Create: `packages/dsh-wallpaper-engine/src/shared/types.ts`（Interfaces 中的类型原文）
- Create: `packages/dsh-wallpaper-engine/src/host/settings.ts`
- Create: `packages/dsh-wallpaper-engine/src/host/index.ts`
- Create: `packages/dsh-wallpaper-engine/cordis.patch.yml`
- Test: `packages/dsh-wallpaper-engine/tests/settings.test.ts`
- Test: `packages/dsh-wallpaper-engine/tests/smoke.test.ts`

**Interfaces:**
- Consumes: 无（第一个任务）
- Produces: `apply(ctx)` 导出（cordis 插件入口）；`WALLPAPER_NS` / `WallpaperSettingsSchema`；`WallpaperInfo` 等共享类型

- [ ] **Step 1: 创建 workspace 根与 .gitignore**

`package.json`：
```json
{
  "name": "dsh-use-wallpaper",
  "private": true,
  "scripts": {
    "test": "npm --workspace @dsh-use/wallpaper-engine test",
    "build:client": "npm --workspace @dsh-use/wallpaper-engine run build:client"
  },
  "workspaces": ["packages/*"]
}
```

`.gitignore`：
```
node_modules/
dist/
*.log
research/*.bmp
```

- [ ] **Step 2: 创建插件包 package.json**

`packages/dsh-wallpaper-engine/package.json`：
```json
{
  "name": "@dsh-use/wallpaper-engine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./client": { "default": "./dist/client.js" },
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "scripts": {
    "test": "vitest run",
    "build": "tsc -p tsconfig.json",
    "build:client": "node scripts/build-client.mjs"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1"
  },
  "dependencies": {
    "@deepseek-ai/schemastery": "^3.18.1",
    "three": "^0.170.0"
  },
  "devDependencies": {
    "esbuild": "^0.24.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "dsh": {
    "profile": { "bundles": ["@dsh-use/wallpaper-engine"] }
  }
}
```

- [ ] **Step 3: 创建 tsconfig 与 vitest 配置**

`packages/dsh-wallpaper-engine/tsconfig.json`：
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "outDir": "lib",
    "rootDir": "src",
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

`packages/dsh-wallpaper-engine/vitest.config.ts`：
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: 写共享类型（Interfaces 原文）**

`packages/dsh-wallpaper-engine/src/shared/types.ts`：按 Interfaces 一节逐字写入全部类型定义（`WallpaperKind`、`WallpaperInfo`、`PkgEntry`、`SceneImageObject`、`SceneParticleObject`、`SceneObject`、`SceneDescription`）。

- [ ] **Step 5: 写失败的设置测试**

`packages/dsh-wallpaper-engine/tests/settings.test.ts`：
```ts
import { describe, expect, it } from 'vitest';
import { WALLPAPER_NS, WallpaperSettingsSchema } from '../src/host/settings.js';

describe('wallpaper settings schema', () => {
  it('applies defaults', () => {
    const value = WallpaperSettingsSchema.validate({});
    expect(value).toMatchObject({
      selectedWallpaperId: '',
      overlayOpacity: 0.35,
      blurEnabled: false,
      blurRadius: 12,
      kenBurns: true,
    });
  });
  it('rejects opacity outside [0,1]', () => {
    expect(() => WallpaperSettingsSchema.validate({ overlayOpacity: 2 })).toThrow();
  });
  it('exposes the wallpaper-engine namespace', () => {
    expect(WALLPAPER_NS).toBe('wallpaper-engine');
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run tests/settings.test.ts`
Expected: FAIL —— `Cannot find module '../src/host/settings.js'`（模块不存在）

- [ ] **Step 7: 实现 settings.ts**

`packages/dsh-wallpaper-engine/src/host/settings.ts`：
```ts
import z from '@deepseek-ai/schemastery';

export const WALLPAPER_NS = 'wallpaper-engine';

export const WallpaperSettingsSchema = z.object({
  selectedWallpaperId: z.string().default(''),
  overlayOpacity: z.number().min(0).max(1).default(0.35),
  blurEnabled: z.boolean().default(false),
  blurRadius: z.number().min(0).max(64).default(12),
  kenBurns: z.boolean().default(true),
});
```

- [ ] **Step 8: 运行测试确认通过**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run tests/settings.test.ts`
Expected: PASS（3 个用例全过）

- [ ] **Step 9: 实现 host 入口 apply(ctx) 与冒烟测试**

`packages/dsh-wallpaper-engine/src/host/index.ts`：
```ts
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { WALLPAPER_NS, WallpaperSettingsSchema } from './settings.js';

export function apply(ctx: any): void {
  ctx.inject(['settings'], (settingsCtx: any) => {
    settingsCtx.settings.register(settingsNamespace(WALLPAPER_NS), WallpaperSettingsSchema);
  });
}
```
> 注：`@deepseek-ai/dsh-settings` 为 dsh-web-app 传递依赖，若安装时报缺失则将其加入 dependencies。

`packages/dsh-wallpaper-engine/tests/smoke.test.ts`：
```ts
import { describe, expect, it } from 'vitest';
import * as host from '../src/host/index.js';

describe('host entry', () => {
  it('exports an apply function', () => {
    expect(typeof host.apply).toBe('function');
  });
  it('apply registers the settings namespace when settings is injected', () => {
    const registered: string[] = [];
    const fakeSettings = { register: (ns: string) => registered.push(ns) };
    const ctx = { inject: (_svc: string[], fn: (c: any) => void) => fn({ settings: fakeSettings }) };
    host.apply(ctx);
    expect(registered).toContain('wallpaper-engine');
  });
});
```

- [ ] **Step 10: 运行全部测试并提交**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run`
Expected: PASS（4 个用例）

```bash
git add -A
git commit -m "chore: 初始化 dsh-wallpaper-engine 插件脚手架与 host 骨架"
```

- [ ] **Step 11: 创建 cordis.patch.yml 注册行（暂不启用，阶段 3 前接入 profile）**

`packages/dsh-wallpaper-engine/cordis.patch.yml`：
```yaml
- insert:
    - id: dsh-wallpaper-engine
      name: '@dsh-use/wallpaper-engine'
      config:
        wallpaperDir: 'D:/Steam/steamapps/workshop/content/431960'
```
> 说明：后续接入 profile 时将该文件内容并入 `C:\Users\0009\.dsh\profiles\web\cordis.patch.yml`（或经 `dsh plugin` 链接包后由 bundle 机制加载）。本任务不修改 profile。

---

### Task 2: PkgReader —— PKGV0001 解包（TDD）

**Files:**
- Create: `packages/dsh-wallpaper-engine/src/host/pkg-reader.ts`
- Test: `packages/dsh-wallpaper-engine/tests/pkg-reader.test.ts`
- Create: `packages/dsh-wallpaper-engine/tests/fixtures/make-pkg.ts`（测试用造包工具）

**Interfaces:**
- Consumes: 无（独立模块）
- Produces: `parsePkg(buf)`、`PkgReader`（签名见 Interfaces 一节）

- [ ] **Step 1: 写失败的解析测试（含造包工具）**

`packages/dsh-wallpaper-engine/tests/fixtures/make-pkg.ts`：
```ts
// 按已验证的 PKGV0001 格式构造内存包：
// 头部16B = version(4,=8) + "PKGV0001"(8) + entryCount(4)
// 条目 = nameLen(u32) + name + off(u32) + size(u32)，off 相对数据段起点
import { Buffer } from 'node:buffer';

export function makePkg(files: Array<{ name: string; data: Uint8Array }>): Buffer {
  const nameBytes = files.map((f) => Buffer.from(f.name, 'utf8'));
  const header = Buffer.alloc(16);
  header.writeUInt32LE(8, 0);
  header.write('PKGV0001', 4, 'ascii');
  header.writeUInt32LE(files.length, 12);
  const table: Buffer[] = [];
  let offset = 0;
  for (let i = 0; i < files.length; i++) {
    const nb = nameBytes[i];
    const row = Buffer.alloc(4 + nb.length + 8);
    row.writeUInt32LE(nb.length, 0);
    nb.copy(row, 4);
    row.writeUInt32LE(offset, 4 + nb.length);
    row.writeUInt32LE(files[i].data.length, 4 + nb.length + 4);
    table.push(row);
    offset += files[i].data.length;
  }
  return Buffer.concat([header, ...table, ...files.map((f) => Buffer.from(f.data))]);
}
```

`packages/dsh-wallpaper-engine/tests/pkg-reader.test.ts`：
```ts
import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { parsePkg, PkgReader } from '../src/host/pkg-reader.js';
import { makePkg } from './fixtures/make-pkg.js';

const pkg = makePkg([
  { name: 'scene.json', data: Buffer.from('{"objects":[]}', 'utf8') },
  { name: 'materials/a.tex', data: new Uint8Array([0x44, 0x44, 0x53, 0x20]) },
]);

describe('parsePkg', () => {
  it('parses entry table with offsets relative to data segment', () => {
    const { entries, dataStart } = parsePkg(pkg);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ name: 'scene.json', offset: 0, size: 15 });
    expect(entries[1]).toEqual({ name: 'materials/a.tex', offset: 15, size: 4 });
    expect(dataStart).toBe(16 + (4 + 10 + 8) + (4 + 15 + 8)); // header + 两条目
  });
  it('rejects truncated buffer', () => {
    expect(() => parsePkg(pkg.subarray(0, 20))).toThrow();
  });
});

describe('PkgReader', () => {
  it('reads entry bytes by name', () => {
    const r = new PkgReader(pkg);
    const scene = r.readEntry('scene.json')!;
    expect(scene.toString('utf8')).toBe('{"objects":[]}');
    const tex = r.readEntry('materials/a.tex')!;
    expect([...tex]).toEqual([0x44, 0x44, 0x53, 0x20]);
  });
  it('returns null for unknown entry and rejects traversal names', () => {
    const r = new PkgReader(pkg);
    expect(r.readEntry('../secret')).toBeNull();
    expect(r.readEntry('nope.json')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run tests/pkg-reader.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 pkg-reader.ts**

`packages/dsh-wallpaper-engine/src/host/pkg-reader.ts`：
```ts
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import type { PkgEntry } from '../shared/types.js';

const HEADER_SIZE = 16;

export function parsePkg(buf: Uint8Array): { entries: PkgEntry[]; dataStart: number } {
  if (buf.length < HEADER_SIZE) throw new Error('PKG too small');
  if (buf[4] !== 0x50 || buf[5] !== 0x4b || buf[6] !== 0x47 || buf[7] !== 0x56) {
    throw new Error('Bad PKG magic');
  }
  const entries: PkgEntry[] = [];
  let pos = HEADER_SIZE;
  while (pos + 8 <= buf.length) {
    const nameLen = buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24);
    if (nameLen <= 0 || nameLen > 1024) break; // 文件表结束
    const nameStart = pos + 4;
    const name = Buffer.from(buf.slice(nameStart, nameStart + nameLen)).toString('utf8');
    const off =
      buf[nameStart + nameLen] |
      (buf[nameStart + nameLen + 1] << 8) |
      (buf[nameStart + nameLen + 2] << 16) |
      (buf[nameStart + nameLen + 3] << 24);
    const size =
      buf[nameStart + nameLen + 4] |
      (buf[nameStart + nameLen + 5] << 8) |
      (buf[nameStart + nameLen + 6] << 16) |
      (buf[nameStart + nameLen + 7] << 24);
    if (off < 0 || size < 0 || off + size > buf.length - 0) throw new Error('Entry out of bounds');
    entries.push({ name, offset: off, size });
    pos = nameStart + nameLen + 8;
    if (entries.length > 10000) throw new Error('Too many entries');
  }
  return { entries, dataStart: pos };
}

function isSafeName(name: string): boolean {
  return !name.includes('..') && !name.startsWith('/') && !name.includes('\\');
}

export class PkgReader {
  private buf: Buffer;
  private entries: PkgEntry[];
  private dataStart: number;

  constructor(pkgPathOrBuf: string | Uint8Array) {
    const buf = typeof pkgPathOrBuf === 'string' ? readFileSync(pkgPathOrBuf) : Buffer.from(pkgPathOrBuf);
    const parsed = parsePkg(buf);
    this.buf = buf;
    this.entries = parsed.entries;
    this.dataStart = parsed.dataStart;
  }

  listEntries(): PkgEntry[] {
    return this.entries.map((e) => ({ ...e }));
  }

  readEntry(name: string): Buffer | null {
    if (!isSafeName(name)) return null;
    const e = this.entries.find((x) => x.name === name);
    if (!e) return null;
    return this.buf.subarray(this.dataStart + e.offset, this.dataStart + e.offset + e.size);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run tests/pkg-reader.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: 用真实 EVA pkg 冒烟验证**

Run（在项目根）：
```bash
node -e "import('./packages/dsh-wallpaper-engine/lib/host/pkg-reader.js').then(async m => { const tsc = await import('node:child_process'); })" 2>/dev/null || true
cd packages/dsh-wallpaper-engine && npx tsc -p tsconfig.json && node -e "
import { PkgReader } from './lib/host/pkg-reader.js';
const r = new PkgReader('D:/Steam/steamapps/workshop/content/431960/1280029027/scene.pkg');
const e = r.listEntries();
console.log('entries:', e.length, '| scene.json size:', e.find(x => x.name === 'scene.json')?.size);
const scene = r.readEntry('scene.json');
console.log('scene.json starts with:', scene?.toString('utf8', 0, 30).replace(/\n/g, ' '));
"
```
Expected: `entries: 17` 且 `scene.json starts with: { "camera" : { "center" : "35.9...`

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat: PKGV0001 解包器（parsePkg/PkgReader）含真实壁纸冒烟验证"
```

---

### Task 3: WallpaperScanner —— 目录扫描与 project.json 解析

**Files:**
- Create: `packages/dsh-wallpaper-engine/src/host/scanner.ts`
- Test: `packages/dsh-wallpaper-engine/tests/scanner.test.ts`

**Interfaces:**
- Consumes: `WallpaperInfo`（shared/types）
- Produces: `scanWallpapers(dir)`、`kindFromProjectJson(pj)`

- [ ] **Step 1: 写失败的测试（临时目录 fixture）**

`packages/dsh-wallpaper-engine/tests/scanner.test.ts`：
```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanWallpapers, kindFromProjectJson } from '../src/host/scanner.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wp-scan-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function addWallpaper(id: string, pj: Record<string, unknown>, extraFiles: string[] = []) {
  const d = join(dir, id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'project.json'), JSON.stringify(pj));
  for (const f of extraFiles) writeFileSync(join(d, f), 'x');
}

describe('kindFromProjectJson', () => {
  it('maps types', () => {
    expect(kindFromProjectJson({ type: 'scene' })).toBe('scene');
    expect(kindFromProjectJson({ type: 'video' })).toBe('video');
    expect(kindFromProjectJson({ type: 'web' })).toBe('web');
    expect(kindFromProjectJson({ type: 'image' })).toBe('image');
    expect(kindFromProjectJson({})).toBe('unknown');
  });
});

describe('scanWallpapers', () => {
  it('scans workshop dir into WallpaperInfo list', async () => {
    addWallpaper('111', { title: 'A', type: 'video', file: 'a.mp4' }, ['a.mp4', 'preview.gif']);
    addWallpaper('222', { title: 'B', type: 'scene' }, ['scene.pkg', 'preview.jpg']);
    addWallpaper('333', { title: 'C', type: 'web', file: 'index.html' }, ['index.html', 'preview.jpg']);
    const list = await scanWallpapers(dir);
    expect(list).toHaveLength(3);
    const a = list.find((w) => w.id === '111')!;
    expect(a.title).toBe('A');
    expect(a.type).toBe('video');
    expect(a.hasPreviewGif).toBe(true);
    expect(a.previewUrl).toBe('/wallpapers/media/111/preview');
    const b = list.find((w) => w.id === '222')!;
    expect(b.hasScene).toBe(true);
    expect(b.type).toBe('scene');
  });
  it('skips dirs without project.json', async () => {
    mkdirSync(join(dir, 'empty'), { recursive: true });
    const list = await scanWallpapers(dir);
    expect(list).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run tests/scanner.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 scanner.ts**

`packages/dsh-wallpaper-engine/src/host/scanner.ts`：
```ts
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WallpaperInfo, WallpaperKind } from '../shared/types.js';

export function kindFromProjectJson(pj: Record<string, unknown>): WallpaperKind {
  const t = String(pj.type ?? '');
  if (t === 'scene' || t === 'video' || t === 'web' || t === 'image') return t;
  return 'unknown';
}

export async function scanWallpapers(dir: string): Promise<WallpaperInfo[]> {
  const out: WallpaperInfo[] = [];
  let ids: string[];
  try {
    ids = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const id of ids) {
    const pjPath = join(dir, id, 'project.json');
    if (!existsSync(pjPath)) continue;
    let pj: Record<string, unknown>;
    try {
      pj = JSON.parse(readFileSync(pjPath, 'utf8'));
    } catch {
      continue;
    }
    const hasScene = existsSync(join(dir, id, 'scene.pkg'));
    const preview = existsSync(join(dir, id, 'preview.gif')) ? 'gif' : existsSync(join(dir, id, 'preview.jpg')) ? 'jpg' : null;
    out.push({
      id,
      title: String(pj.title ?? id),
      type: kindFromProjectJson(pj),
      file: typeof pj.file === 'string' ? pj.file : undefined,
      hasPreviewGif: preview === 'gif',
      hasScene,
      previewUrl: preview ? `/wallpapers/media/${id}/preview` : '',
    });
  }
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run tests/scanner.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: 壁纸目录扫描器（project.json → WallpaperInfo）"
```

---

### Task 4: HTTP 路由 —— list / preview / file / scene asset

**Files:**
- Create: `packages/dsh-wallpaper-engine/src/host/routes.ts`
- Test: `packages/dsh-wallpaper-engine/tests/routes.test.ts`

**Interfaces:**
- Consumes: `scanWallpapers`、`PkgReader`、`WallpaperInfo`
- Produces: `registerWallpaperRoutes(ctx, { wallpaperDir })`（内部调用 `ctx.webServer.register`）

- [ ] **Step 1: 写失败的路由测试（捕获注册的 handler 直接调用）**

`packages/dsh-wallpaper-engine/tests/routes.test.ts`：
```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerWallpaperRoutes } from '../src/host/routes.js';

let dir: string;
let routes: Map<string, (req: any, res: any) => void>;
let captured: Array<{ kind: string; path: string }>;

function makeCtx() {
  return {
    inject: (_s: string[], fn: (c: any) => void) => fn({ webServer: ctx.webServer }),
    webServer: {
      register: (route: any) => {
        captured.push({ kind: route.kind, path: route.path });
        routes.set(route.kind + ' ' + route.path, route.handler);
        return () => {};
      },
    },
  } as any;
}
function makeRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: null as any,
    ended: false,
    setHeader(k: string, v: string) { this.headers[k] = v; },
    writeHead(c: number, h: Record<string, string>) { this.statusCode = c; Object.assign(this.headers, h); },
    end(b?: any) { this.body = b; this.ended = true; },
  };
  return res;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp-route-'));
  routes = new Map();
  captured = [];
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('registerWallpaperRoutes', () => {
  it('registers list route returning scanned wallpapers', async () => {
    mkdirSync(join(dir, '1'), { recursive: true });
    writeFileSync(join(dir, '1', 'project.json'), JSON.stringify({ title: 'T', type: 'video', file: 'a.mp4' }));
    writeFileSync(join(dir, '1', 'a.mp4'), 'fake');
    const ctx = makeCtx();
    registerWallpaperRoutes(ctx, { wallpaperDir: dir });
    const h = routes.get('GET /wallpapers/list')!;
    const res = makeRes();
    await h({}, res);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body.toString('utf8'));
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('1');
  });
  it('serves preview file with content type by extension', async () => {
    mkdirSync(join(dir, '2'), { recursive: true });
    writeFileSync(join(dir, '2', 'project.json'), JSON.stringify({ type: 'scene' }));
    writeFileSync(join(dir, '2', 'preview.gif'), 'GIF89a');
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const res = makeRes();
    await routes.get('GET /wallpapers/media/:id/preview')!({ params: { id: '2' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('image/gif');
    expect(res.body.toString('utf8')).toBe('GIF89a');
  });
  it('rejects path traversal in id and asset name', async () => {
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const res1 = makeRes();
    await routes.get('GET /wallpapers/media/:id/preview')!({ params: { id: '..' } }, res1);
    expect(res1.statusCode).toBe(400);
    const res2 = makeRes();
    await routes.get('GET /wallpapers/scene/:id/asset')!({ params: { id: '1' }, query: { name: '../../etc/passwd' } }, res2);
    expect(res2.statusCode).toBe(400);
  });
  it('serves scene asset from pkg by entry name', async () => {
    // 构造一个含 scene.pkg 的壁纸目录（用 makePkg）
    const { makePkg } = await import('./fixtures/make-pkg.js');
    const pkg = makePkg([{ name: 'scene.json', data: Buffer.from('{"objects":[]}', 'utf8') }]);
    const d = join(dir, '3');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'project.json'), JSON.stringify({ type: 'scene' }));
    writeFileSync(join(d, 'scene.pkg'), pkg);
    registerWallpaperRoutes(makeCtx(), { wallpaperDir: dir });
    const res = makeRes();
    await routes.get('GET /wallpapers/scene/:id/asset')!({ params: { id: '3' }, query: { name: 'scene.json' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('application/json');
    expect(res.body.toString('utf8')).toBe('{"objects":[]}');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run tests/routes.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 routes.ts**

`packages/dsh-wallpaper-engine/src/host/routes.ts`：
```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanWallpapers } from './scanner.js';
import { PkgReader } from './pkg-reader.js';
import type { WallpaperInfo } from '../shared/types.js';

export interface WallpaperRoutesOptions { wallpaperDir: string }

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.json': 'application/json',
  '.tex': 'application/octet-stream',
};

function isSafeToken(s: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(s) && !s.includes('..');
}

function json(res: any, code: number, value: unknown) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  res.end(body);
}

export function registerWallpaperRoutes(ctx: any, opts: WallpaperRoutesOptions): void {
  ctx.inject(['webServer'], (httpCtx: any) => {
    const server = httpCtx.webServer;

    server.register({
      kind: 'GET', path: '/wallpapers/list',
      handler: async (_req: any, res: any) => {
        const list = await scanWallpapers(opts.wallpaperDir);
        json(res, 200, list);
      },
    });

    server.register({
      kind: 'GET', path: '/wallpapers/media/:id/preview',
      handler: (_req: any, res: any) => {
        const id = _req.params?.id;
        if (!isSafeToken(id)) return json(res, 400, { error: 'bad id' });
        const base = join(opts.wallpaperDir, id);
        for (const ext of ['.gif', '.jpg', '.jpeg', '.png']) {
          const p = join(base, 'preview' + ext);
          if (existsSync(p)) {
            const body = readFileSync(p);
            res.writeHead(200, { 'Content-Type': MIME[ext], 'Content-Length': body.length });
            return res.end(body);
          }
        }
        json(res, 404, { error: 'no preview' });
      },
    });

    server.register({
      kind: 'GET', path: '/wallpapers/media/:id/file',
      handler: (_req: any, res: any) => {
        const id = _req.params?.id;
        if (!isSafeToken(id)) return json(res, 400, { error: 'bad id' });
        // file 名来自 project.json（扫描结果），这里按 id 读取 project.json 获得
        try {
          const pj = JSON.parse(readFileSync(join(opts.wallpaperDir, id, 'project.json'), 'utf8'));
          const file = String(pj.file ?? '');
          if (!file || file.includes('..') || file.includes('/') || file.includes('\\')) {
            return json(res, 400, { error: 'bad file' });
          }
          const p = join(opts.wallpaperDir, id, file);
          if (!existsSync(p)) return json(res, 404, { error: 'no file' });
          const body = readFileSync(p);
          const ext = '.' + file.split('.').pop()?.toLowerCase();
          res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Content-Length': body.length });
          res.end(body);
        } catch {
          json(res, 404, { error: 'not found' });
        }
      },
    });

    server.register({
      kind: 'GET', path: '/wallpapers/scene/:id/asset',
      handler: (_req: any, res: any) => {
        const id = _req.params?.id;
        const name: string = _req.query?.name ?? '';
        if (!isSafeToken(id)) return json(res, 400, { error: 'bad id' });
        if (!name || !/^[A-Za-z0-9._\/-]+$/.test(name) || name.includes('..')) {
          return json(res, 400, { error: 'bad name' });
        }
        const pkgPath = join(opts.wallpaperDir, id, 'scene.pkg');
        if (!existsSync(pkgPath)) return json(res, 404, { error: 'no scene pkg' });
        try {
          const reader = new PkgReader(pkgPath);
          const entry = reader.readEntry(name);
          if (!entry) return json(res, 404, { error: 'no such asset' });
          const ext = '.' + name.split('.').pop()?.toLowerCase();
          res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Content-Length': entry.length });
          res.end(entry);
        } catch (e: any) {
          json(res, 500, { error: String(e?.message ?? e) });
        }
      },
    });
  });
}
```

> 注：`ctx.webServer.register` 的 route 对象形态（`kind/path/handler` 与 `params/query` 注入方式）以 `dsh-host-webserver` 的 `WebRoute` 类型为准；若实际为 `method/pathname` 或 `req.params` 结构不同，本任务 Step 4 适配为实际形态（保持路由路径与测试语义不变）。

- [ ] **Step 4: 运行测试，适配路由对象形态差异**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run tests/routes.test.ts`
Expected: PASS。若因 webserver 实际注册形态（如 `{ method, pathname, handler(req, res) }`、`req.params` 在 `req.query` 之外）导致失败，按真实 `WebRoute` 类型修正 `registerWallpaperRoutes` 内部取参方式与测试的调用方式，直至全绿。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: wallpapers HTTP 路由（list/preview/file/scene asset + 穿越防护）"
```

---

### Task 5: client 入口与背景层（静态图 / GIF / Ken Burns）

**Files:**
- Create: `packages/dsh-wallpaper-engine/src/client/background-layer.ts`
- Create: `packages/dsh-wallpaper-engine/src/client/index.ts`
- Create: `packages/dsh-wallpaper-engine/src/client/styles.ts`
- Test: `packages/dsh-wallpaper-engine/tests/background-layer.test.ts`（jsdom）
- Modify: `packages/dsh-wallpaper-engine/vitest.config.ts`（jsdom 环境开关）

**Interfaces:**
- Consumes: `WallpaperInfo`；`resolveBackground(info)` 决策函数（本任务产出）
- Produces: `createBackgroundLayer(root: HTMLElement): BackgroundLayer`；`resolveBackground(info: WallpaperInfo): BackgroundPlan`；`applyKenBurns(el: HTMLElement, enabled: boolean)`

```ts
export type BackgroundPlan =
  | { kind: 'image'; url: string; kenBurns: boolean }
  | { kind: 'video'; url: string }
  | { kind: 'scene'; wallpaperId: string }
  | { kind: 'none' };
```

- [ ] **Step 1: 写失败的回退决策测试（纯函数，node 环境）**

`packages/dsh-wallpaper-engine/tests/background-layer.test.ts`：
```ts
import { describe, expect, it } from 'vitest';
import { resolveBackground } from '../src/client/background-layer.js';

const base = { previewUrl: '/p.png', hasPreviewGif: false, hasScene: false } as any;

describe('resolveBackground', () => {
  it('scene with hasScene prefers scene plan', () => {
    const plan = resolveBackground({ ...base, id: '1', type: 'scene', hasScene: true });
    expect(plan.kind).toBe('scene');
  });
  it('video uses video plan with file url', () => {
    const plan = resolveBackground({ ...base, id: '2', type: 'video', hasPreviewGif: true });
    expect(plan).toEqual({ kind: 'video', url: '/wallpapers/media/2/file' });
  });
  it('image plan for scene without pkg and for unknown', () => {
    expect(resolveBackground({ ...base, id: '3', type: 'scene', hasScene: false }).kind).toBe('image');
    expect(resolveBackground({ ...base, id: '4', type: 'unknown' }).kind).toBe('image');
  });
  it('gif preview sets kenBurns false, jpg sets true', () => {
    const gif = resolveBackground({ ...base, id: '5', type: 'unknown', hasPreviewGif: true });
    expect(gif).toEqual({ kind: 'image', url: '/wallpapers/media/5/preview', kenBurns: false });
    const jpg = resolveBackground({ ...base, id: '6', type: 'unknown', hasPreviewGif: false });
    expect(jpg).toEqual({ kind: 'image', url: '/wallpapers/media/6/preview', kenBurns: true });
  });
  it('none plan when no preview url', () => {
    expect(resolveBackground({ ...base, id: '7', type: 'unknown', previewUrl: '' }).kind).toBe('none');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run tests/background-layer.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 resolveBackground 与背景层**

`packages/dsh-wallpaper-engine/src/client/background-layer.ts`：
```ts
import type { WallpaperInfo } from '../shared/types.js';
import type { BackgroundPlan } from './types.js';

export function resolveBackground(info: WallpaperInfo): BackgroundPlan {
  if (info.type === 'scene' && info.hasScene) {
    return { kind: 'scene', wallpaperId: info.id };
  }
  if (info.type === 'video' && info.file) {
    return { kind: 'video', url: `/wallpapers/media/${info.id}/file` };
  }
  if (info.previewUrl) {
    return { kind: 'image', url: info.previewUrl, kenBurns: !info.hasPreviewGif };
  }
  return { kind: 'none' };
}

export function applyKenBurns(el: HTMLElement, enabled: boolean): void {
  el.classList.toggle('wp-kenburns', enabled);
}

export interface BackgroundLayer {
  root: HTMLElement;
  showImage(url: string, kenBurns: boolean): void;
  showVideo(url: string): void;
  showSceneCanvas(canvas: HTMLCanvasElement): void;
  showNone(): void;
  setOverlayOpacity(v: number): void;
  setBlur(enabled: boolean, radius: number): void;
}

export function createBackgroundLayer(root: HTMLElement): BackgroundLayer {
  root.classList.add('wp-background-layer');
  const fill = document.createElement('div');
  fill.className = 'wp-bg-fill';
  root.appendChild(fill);
  const overlay = document.createElement('div');
  overlay.className = 'wp-bg-overlay';
  root.appendChild(overlay);

  function clear() { fill.replaceChildren(); }

  return {
    root,
    showImage(url, kenBurns) {
      clear();
      const img = document.createElement('img');
      img.src = url;
      applyKenBurns(img, kenBurns);
      fill.appendChild(img);
    },
    showVideo(url) {
      clear();
      const video = document.createElement('video');
      video.src = url;
      video.autoplay = true;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      fill.appendChild(video);
    },
    showSceneCanvas(canvas) {
      clear();
      canvas.classList.add('wp-scene-canvas');
      fill.appendChild(canvas);
    },
    showNone() { clear(); },
    setOverlayOpacity(v) { overlay.style.opacity = String(v); },
    setBlur(enabled, radius) {
      fill.style.filter = enabled ? `blur(${radius}px)` : '';
    },
  };
}
```

- [ ] **Step 4: 创建 client 类型与样式注入**

`packages/dsh-wallpaper-engine/src/client/types.ts`：
```ts
export type BackgroundPlan =
  | { kind: 'image'; url: string; kenBurns: boolean }
  | { kind: 'video'; url: string }
  | { kind: 'scene'; wallpaperId: string }
  | { kind: 'none' };
```

`packages/dsh-wallpaper-engine/src/client/styles.ts`：
```ts
const CSS = `
.wp-background-layer{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none}
.wp-bg-fill{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.wp-bg-fill img,.wp-bg-fill video,.wp-scene-canvas{width:100%;height:100%;object-fit:cover}
.wp-bg-fill img{user-select:none}
.wp-kenburns{animation:wp-kenburns 24s ease-in-out infinite alternate}
@keyframes wp-kenburns{from{transform:scale(1) translate(0,0)}to{transform:scale(1.12) translate(-2%,-1%)}}
.wp-bg-overlay{position:absolute;inset:0;background:#000;opacity:.35}
`;
export function injectWallpaperStyles(): void {
  const id = 'dsh-wallpaper-engine/styles';
  if (document.querySelector(`style[data-plugin-css="${id}"]`)) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-wallpaper-engine';
  tag.dataset.pluginCss = id;
  tag.textContent = CSS;
  document.head.appendChild(tag);
}
```

- [ ] **Step 5: 创建 client 入口（__ModuleLoader__）与构建脚本**

`packages/dsh-wallpaper-engine/src/client/index.ts`：
```ts
import { injectWallpaperStyles } from './styles.js';
import { createBackgroundLayer } from './background-layer.js';
import type { BackgroundPlan } from './types.js';

declare global {
  interface Window { __ModuleLoader__?: any; __DSH_BOOT__?: any; }
}

export function bootstrap(): void {
  injectWallpaperStyles();
  let layer: ReturnType<typeof createBackgroundLayer> | null = null;
  const mount = () => {
    if (layer) return;
    const root = document.createElement('div');
    document.body.appendChild(root);
    layer = createBackgroundLayer(root);
  };
  // 延迟到 DOM 就绪
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
  // 暴露渲染 API（picker 与设置面板调用）
  (window as any).__wallpaperEngine = {
    mount,
    show(plan: BackgroundPlan, opts?: { opacity?: number; blur?: boolean; blurRadius?: number }) {
      mount();
      if (!layer) return;
      switch (plan.kind) {
        case 'image': layer.showImage(plan.url, plan.kenBurns); break;
        case 'video': layer.showVideo(plan.url); break;
        case 'scene': break; // 阶段 2 接入 SceneRenderer
        case 'none': layer.showNone(); break;
      }
      if (opts?.opacity !== undefined) layer.setOverlayOpacity(opts.opacity);
      if (opts?.blur !== undefined) layer.setBlur(opts.blur, opts.blurRadius ?? 12);
    },
  };
}

if (typeof window !== 'undefined') {
  const loader = window.__ModuleLoader__;
  if (loader?.load) {
    loader.load({
      id: '@dsh-use/wallpaper-engine',
      factory: () => { bootstrap(); return { bootstrap }; },
    });
  } else {
    bootstrap();
  }
}
```

`packages/dsh-wallpaper-engine/scripts/build-client.mjs`：
```js
import { build } from 'esbuild';
await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/client.js',
  external: [],
  sourcemap: true,
});
console.log('client bundle written to dist/client.js');
```

- [ ] **Step 6: jsdom 冒烟测试背景层 DOM**

修改 `vitest.config.ts`：
```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    environmentMatchGlobs: [['tests/dom/**', 'jsdom']],
  },
});
```

创建 `packages/dsh-wallpaper-engine/tests/dom/background-layer.dom.test.ts`：
```ts
import { describe, expect, it } from 'vitest';
import { createBackgroundLayer } from '../../src/client/background-layer.js';

describe('createBackgroundLayer (DOM)', () => {
  it('renders image into fill and toggles kenburns class', () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    const layer = createBackgroundLayer(root);
    layer.showImage('/p.gif', false);
    const img = root.querySelector('.wp-bg-fill img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.src).toContain('/p.gif');
    expect(img.classList.contains('wp-kenburns')).toBe(false);
    layer.showImage('/q.jpg', true);
    const img2 = root.querySelector('.wp-bg-fill img') as HTMLImageElement;
    expect(img2.classList.contains('wp-kenburns')).toBe(true);
  });
  it('applies overlay opacity', () => {
    const root = document.createElement('div');
    const layer = createBackgroundLayer(root);
    layer.setOverlayOpacity(0.5);
    const overlay = root.querySelector('.wp-bg-overlay') as HTMLElement;
    expect(overlay.style.opacity).toBe('0.5');
  });
});
```

- [ ] **Step 7: 运行全部测试 + 构建 client**

Run:
```bash
cd packages/dsh-wallpaper-engine && npx vitest run
```
Expected: PASS（新增 dom 2 个用例）

Run:
```bash
cd packages/dsh-wallpaper-engine && npm run build:client
```
Expected: 输出 `dist/client.js` 且无报错

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "feat: client 背景层（静态图/GIF/Ken Burns + 样式注入 + 构建脚本）"
```

---

### Task 6: 背景层 video 与完整回退链接线

**Files:**
- Modify: `packages/dsh-wallpaper-engine/src/client/background-layer.ts`（已含 showVideo；本任务补回退链编排）
- Create: `packages/dsh-wallpaper-engine/src/client/wallpaper-controller.ts`
- Test: `packages/dsh-wallpaper-engine/tests/wallpaper-controller.test.ts`

**Interfaces:**
- Consumes: `resolveBackground`、`BackgroundLayer`、`WallpaperInfo`
- Produces: `createWallpaperController(layer, { fetchList }): { load(): Promise<WallpaperInfo[]>; select(id: string): Promise<void> }`

- [ ] **Step 1: 写失败的回退编排测试**

`packages/dsh-wallpaper-engine/tests/wallpaper-controller.test.ts`：
```ts
import { describe, expect, it } from 'vitest';
import { createWallpaperController } from '../src/client/wallpaper-controller.js';

function fakeLayer() {
  const calls: string[] = [];
  return {
    calls,
    showImage: (u: string) => calls.push('image:' + u),
    showVideo: (u: string) => calls.push('video:' + u),
    showSceneCanvas: () => calls.push('scene'),
    showNone: () => calls.push('none'),
    setOverlayOpacity: () => {},
    setBlur: () => {},
  } as any;
}

const list = [
  { id: '1', type: 'video', file: 'a.mp4', hasScene: false, hasPreviewGif: false, previewUrl: '/p1', title: 'v' },
  { id: '2', type: 'scene', hasScene: true, hasPreviewGif: false, previewUrl: '/p2', title: 's' },
  { id: '3', type: 'unknown', hasScene: false, hasPreviewGif: true, previewUrl: '/p3', title: 'g' },
];

describe('createWallpaperController', () => {
  it('loads the wallpaper list once', async () => {
    const layer = fakeLayer();
    const c = createWallpaperController(layer, { fetchList: async () => list as any });
    const got = await c.load();
    expect(got).toHaveLength(3);
  });
  it('select video -> video plan', async () => {
    const layer = fakeLayer();
    const c = createWallpaperController(layer, { fetchList: async () => list as any });
    await c.load();
    await c.select('1');
    expect(layer.calls.at(-1)).toBe('video:/wallpapers/media/1/file');
  });
  it('select scene -> falls back to image when scene renderer absent', async () => {
    const layer = fakeLayer();
    const c = createWallpaperController(layer, { fetchList: async () => list as any });
    await c.load();
    await c.select('2');
    // 阶段 2 前 scene 无渲染器 → 回退 preview 图
    expect(layer.calls.at(-1)).toBe('image:/p2');
  });
  it('select gif wallpaper -> image without kenburns', async () => {
    const layer = fakeLayer();
    const c = createWallpaperController(layer, { fetchList: async () => list as any });
    await c.load();
    await c.select('3');
    expect(layer.calls.at(-1)).toBe('image:/p3');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run tests/wallpaper-controller.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 wallpaper-controller.ts**

`packages/dsh-wallpaper-engine/src/client/wallpaper-controller.ts`：
```ts
import type { WallpaperInfo } from '../shared/types.js';
import type { BackgroundLayer } from './background-layer.js';
import { resolveBackground } from './background-layer.js';

export interface WallpaperControllerOptions {
  fetchList: () => Promise<WallpaperInfo[]>;
  sceneRenderer?: { render(wallpaperId: string, canvas: HTMLCanvasElement): Promise<boolean> };
}

export function createWallpaperController(
  layer: BackgroundLayer,
  opts: WallpaperControllerOptions,
) {
  let list: WallpaperInfo[] = [];

  async function load(): Promise<WallpaperInfo[]> {
    list = await opts.fetchList();
    return list;
  }

  async function select(id: string): Promise<void> {
    const info = list.find((w) => w.id === id);
    if (!info) return;
    const plan = resolveBackground(info);
    switch (plan.kind) {
      case 'video': layer.showVideo(plan.url); break;
      case 'image': layer.showImage(plan.url, plan.kenBurns); break;
      case 'scene': {
        if (opts.sceneRenderer) {
          const canvas = document.createElement('canvas');
          const ok = await opts.sceneRenderer.render(plan.wallpaperId, canvas);
          if (ok) { layer.showSceneCanvas(canvas); break; }
        }
        // 渲染不可用/失败 → 回退 preview
        if (info.previewUrl) layer.showImage(info.previewUrl, !info.hasPreviewGif);
        else layer.showNone();
        break;
      }
      case 'none': layer.showNone(); break;
    }
  }

  return { load, select };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run tests/wallpaper-controller.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: 壁纸控制器（列表加载 + 选择渲染 + scene 回退）"
```

---

### Task 7: 壁纸选择 UI 与设置持久化

**Files:**
- Create: `packages/dsh-wallpaper-engine/src/client/picker.ts`
- Create: `packages/dsh-wallpaper-engine/src/client/settings.ts`（client 侧设置读写）
- Modify: `packages/dsh-wallpaper-engine/src/client/index.ts`（挂 picker 入口）
- Test: `packages/dsh-wallpaper-engine/tests/dom/picker.dom.test.ts`

**Interfaces:**
- Consumes: `WallpaperInfo`、`createWallpaperController`；host 设置命名空间 `wallpaper-engine`
- Produces: `mountPicker(root, controller): void`；`readClientSettings(): Promise<ClientSettings>`；`writeClientSettings(patch): Promise<void>`

```ts
export interface ClientSettings {
  selectedWallpaperId: string;
  overlayOpacity: number;
  blurEnabled: boolean;
  blurRadius: number;
  kenBurns: boolean;
}
```

- [ ] **Step 1: 写失败的设置读写与 picker 测试**

`packages/dsh-wallpaper-engine/tests/dom/picker.dom.test.ts`：
```ts
import { describe, expect, it, vi } from 'vitest';
import { mountPicker } from '../../src/client/picker.js';

describe('mountPicker', () => {
  it('renders thumbnails and click selects wallpaper', async () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    const selected: string[] = [];
    const controller = {
      load: async () => ([
        { id: '1', title: 'EVA', type: 'scene', hasScene: true, hasPreviewGif: false, previewUrl: '/p1' },
        { id: '2', title: 'Video', type: 'video', file: 'a.mp4', hasScene: false, hasPreviewGif: false, previewUrl: '/p2' },
      ] as any),
      select: async (id: string) => { selected.push(id); },
    };
    await mountPicker(root, controller as any, { currentId: '1', onSelect: (id) => controller.select(id) });
    const thumbs = root.querySelectorAll('.wp-thumb');
    expect(thumbs.length).toBe(2);
    expect((root.querySelector('.wp-thumb-title') as HTMLElement).textContent).toBe('EVA');
    (thumbs[1] as HTMLElement).click();
    expect(selected).toEqual(['2']);
  });
  it('marks current selection', async () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    await mountPicker(root, { load: async () => ([{ id: '1', title: 'A' }] as any), select: async () => {} } as any, { currentId: '1' });
    expect(root.querySelector('.wp-thumb')!.classList.contains('wp-selected')).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run tests/dom/picker.dom.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 picker.ts**

`packages/dsh-wallpaper-engine/src/client/picker.ts`：
```ts
import type { WallpaperInfo } from '../shared/types.js';

export interface PickerOptions {
  currentId: string;
  onSelect: (id: string) => void;
}

export async function mountPicker(
  root: HTMLElement,
  controller: { load(): Promise<WallpaperInfo[]> },
  opts: PickerOptions,
): Promise<void> {
  const list = await controller.load();
  root.classList.add('wp-picker');
  root.replaceChildren();
  const grid = document.createElement('div');
  grid.className = 'wp-grid';
  for (const w of list) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'wp-thumb' + (w.id === opts.currentId ? ' wp-selected' : '');
    item.dataset.id = w.id;
    const img = document.createElement('img');
    if (w.previewUrl) img.src = w.previewUrl;
    img.alt = w.title;
    const badge = document.createElement('span');
    badge.className = 'wp-badge';
    badge.textContent = w.type.toUpperCase();
    const title = document.createElement('span');
    title.className = 'wp-thumb-title';
    title.textContent = w.title;
    item.append(img, badge, title);
    item.addEventListener('click', () => opts.onSelect(w.id));
    grid.appendChild(item);
  }
  root.appendChild(grid);
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.textContent = '刷新壁纸列表';
  refresh.addEventListener('click', () => void mountPicker(root, controller, opts));
  root.appendChild(refresh);
}
```

在 `styles.ts` 的 CSS 中追加 picker 样式（`wp-picker` 面板、`wp-grid` 网格、`.wp-thumb` 缩略图、`.wp-selected` 高亮、`.wp-badge` 角标）。实现时直接追加字符串即可，样式值自定（缩略图 96px 圆角卡片、badge 右上角）。

- [ ] **Step 4: client 设置读写（经 host settings 服务）**

`packages/dsh-wallpaper-engine/src/client/settings.ts`：
```ts
import type { ClientSettings } from './types.js';

const DEFAULTS: ClientSettings = {
  selectedWallpaperId: '', overlayOpacity: 0.35,
  blurEnabled: false, blurRadius: 12, kenBurns: true,
};

export async function readClientSettings(): Promise<ClientSettings> {
  // 优先经 dsh 设置服务（dsh-client-runtime 的 settings 镜像）；
  // 不可用时回退默认值。接入方式在集成阶段按实际可用 API 调整。
  try {
    const resp = await fetch('/api/settings/wallpaper-engine', { headers: { Accept: 'application/json' } });
    if (resp.ok) return { ...DEFAULTS, ...(await resp.json()) };
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

export async function writeClientSettings(patch: Partial<ClientSettings>): Promise<void> {
  try {
    await fetch('/api/settings/wallpaper-engine', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  } catch { /* ignore */ }
}
```

> 注：`/api/settings/...` 的准确端点由 dsh 设置服务的真实形态决定（可能是 RPC 而非 REST）；集成阶段若不一致，改用 dsh-client-runtime 提供的设置 store（参照 `dsh-client-ui-theme` 的 `createAppearanceRowStore` 模式：`defineStore` + apply-world 同步）。本任务先保证接口形状稳定。

- [ ] **Step 5: client 入口挂接 picker 与设置应用**

修改 `src/client/index.ts` 的 `bootstrap()`：在 `mount()` 后调用 `readClientSettings()` 并把结果应用到 `layer`（opacity/blur/kenBurns），暴露 `mountPicker(root, controller)` 到 `window.__wallpaperEngine`。controller 的 `fetchList` 用 `fetch('/wallpapers/list').then(r => r.json())`。本任务保持 scene 分支为回退（Task 11 接入渲染器）。

- [ ] **Step 6: 运行测试 + 构建**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run && npm run build:client`
Expected: PASS 且构建无报错

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat: 壁纸选择 UI（缩略图网格）与客户端设置读写"
```

---

### Task 8: scene.json 解析与 Three.js 渲染器骨架

**Files:**
- Create: `packages/dsh-wallpaper-engine/src/client/scene-json.ts`
- Create: `packages/dsh-wallpaper-engine/src/client/scene-renderer.ts`
- Test: `packages/dsh-wallpaper-engine/tests/scene-json.test.ts`
- Create: `packages/dsh-wallpaper-engine/tests/fixtures/eva/scene.json`（真实 EVA 文件，见 Step 1）

**Interfaces:**
- Consumes: `SceneDescription`；`parseTex`
- Produces: `parseSceneJson(raw): SceneDescription`；`createSceneRenderer(canvas): { setScene(desc): void; setImageObject(tex: THREE.Texture, obj): void; start(): void; stop(): void }`

- [ ] **Step 1: 提取 EVA 真实 scene.json 作 fixture**

Run（一次性提取，写入测试 fixture）：
```bash
cd packages/dsh-wallpaper-engine && npx tsc -p tsconfig.json && node -e "
import { PkgReader } from './lib/host/pkg-reader.js';
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('tests/fixtures/eva', { recursive: true });
const r = new PkgReader('D:/Steam/steamapps/workshop/content/431960/1280029027/scene.pkg');
for (const name of ['scene.json', 'particles/presets/lightshafts.json', 'particles/Ashes.json', 'models/neon-genesis-evangelion-wallpaper-3.json', 'materials/neon-genesis-evangelion-wallpaper-3.json']) {
  const b = r.readEntry(name);
  if (b) writeFileSync('tests/fixtures/eva/' + name.replace(/\//g, '_'), b);
}
console.log('fixtures written');
"
```
Expected: `fixtures written`（5 个文件）

- [ ] **Step 2: 写失败的 scene.json 解析测试**

`packages/dsh-wallpaper-engine/tests/scene-json.test.ts`：
```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSceneJson } from '../src/client/scene-json.js';

const raw = readFileSync(new URL('./fixtures/eva/scene.json', import.meta.url), 'utf8');

describe('parseSceneJson', () => {
  it('parses camera and orthogonal projection', () => {
    const desc = parseSceneJson(raw);
    expect(desc.camera.center).toEqual([35.931, -6.317, 0]);
    expect(desc.orthogonal).toEqual({ width: 2400, height: 1555 });
  });
  it('parses objects into image and particle kinds', () => {
    const desc = parseSceneJson(raw);
    const imageObj = desc.objects.find((o) => o.kind === 'image') as any;
    expect(imageObj.image).toBe('models/neon-genesis-evangelion-wallpaper-3.json');
    const particleObjs = desc.objects.filter((o) => o.kind === 'particle');
    expect(particleObjs.length).toBeGreaterThanOrEqual(4);
  });
  it('falls back to a default camera when absent', () => {
    const desc = parseSceneJson('{"objects":[]}');
    expect(desc.camera.center).toEqual([0, 0, 0]);
  });
  it('throws on non-object input', () => {
    expect(() => parseSceneJson('[]')).toThrow();
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run tests/scene-json.test.ts`
Expected: FAIL

- [ ] **Step 4: 实现 scene-json.ts**

`packages/dsh-wallpaper-engine/src/client/scene-json.ts`：
```ts
import type { SceneDescription, SceneObject } from '../shared/types.js';

function vec3(s: unknown): [number, number, number] {
  if (typeof s !== 'string') return [0, 0, 0];
  const parts = s.trim().split(/\s+/).map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

export function parseSceneJson(raw: string): SceneDescription {
  const root: any = JSON.parse(raw);
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new Error('scene.json root must be an object');
  }
  const cam = root.camera ?? {};
  const gen = root.general ?? {};
  const ortho = gen.orthogonalprojection ?? {};
  const objects: SceneObject[] = (Array.isArray(root.objects) ? root.objects : []).map((o: any) => {
    const base = {
      id: Number(o.id ?? 0),
      name: String(o.name ?? ''),
      origin: vec3(o.origin),
      scale: vec3(o.scale),
    };
    if (typeof o.particle === 'string' && o.particle) {
      return { ...base, kind: 'particle' as const, particle: o.particle };
    }
    if (typeof o.image === 'string' && o.image) {
      return { ...base, kind: 'image' as const, image: o.image };
    }
    return { ...base, kind: 'particle' as const, particle: '' }; // 无引用对象按空粒子处理（不渲染）
  });
  const cc = typeof gen.clearcolor === 'string' ? vec3(gen.clearcolor) : undefined;
  return {
    camera: {
      center: vec3(cam.center),
      eye: vec3(cam.eye),
      up: vec3(cam.up),
    },
    orthogonal: {
      width: Number(ortho.width ?? 1920),
      height: Number(ortho.height ?? 1080),
    },
    clearColor: cc,
    objects,
  };
}
```

- [ ] **Step 5: 运行解析测试确认通过**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run tests/scene-json.test.ts`
Expected: PASS

- [ ] **Step 6: 实现 Three.js 渲染器骨架（场景图构建为纯函数，便于测试）**

`packages/dsh-wallpaper-engine/src/client/scene-renderer.ts`：
```ts
import * as THREE from 'three';
import type { SceneDescription, SceneImageObject } from '../shared/types.js';

export interface SceneRenderer {
  setScene(desc: SceneDescription): void;
  setImageObject(tex: THREE.Texture | null, obj: SceneImageObject): void;
  start(): void;
  stop(): void;
}

export function createSceneRenderer(canvas: HTMLCanvasElement): SceneRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
  let raf = 0;
  let running = false;

  const clock = new THREE.Clock();

  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);
    scene.traverse((obj) => {
      const upd = (obj as any).userData?.update;
      if (typeof upd === 'function') upd(dt);
    });
    renderer.render(scene, camera);
    if (running) raf = requestAnimationFrame(frame);
  }

  return {
    setScene(desc: SceneDescription) {
      scene.clear();
      const { width, height } = desc.orthogonal;
      camera.left = -width / 2; camera.right = width / 2;
      camera.top = height / 2; camera.bottom = -height / 2;
      camera.updateProjectionMatrix();
      if (desc.clearColor) {
        scene.background = new THREE.Color(desc.clearColor[0], desc.clearColor[1], desc.clearColor[2]);
      }
      renderer.setSize(width, height, false);
    },
    setImageObject(tex, obj) {
      const geometry = new THREE.PlaneGeometry(1, 1);
      const material = new THREE.MeshBasicMaterial({ map: tex ?? undefined, transparent: true });
      const mesh = new THREE.Mesh(geometry, material);
      const s = obj.scale;
      mesh.scale.set(s[0], s[1], s[2]);
      mesh.position.set(obj.origin[0], obj.origin[1], obj.origin[2]);
      scene.add(mesh);
    },
    start() {
      if (running) return;
      running = true;
      clock.start();
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      renderer.dispose();
    },
  };
}
```

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat: scene.json 解析器与 Three.js 渲染器骨架（含 EVA 真实 fixture）"
```

---

### Task 9: TEX 纹理加载器（WebGL 压缩纹理直载）

**Files:**
- Create: `packages/dsh-wallpaper-engine/src/client/tex-loader.ts`
- Test: `packages/dsh-wallpaper-engine/tests/tex-loader.test.ts`
- Create: `packages/dsh-wallpaper-engine/tests/fixtures/make-tex.ts`

**Interfaces:**
- Consumes: 无
- Produces: `parseTex(buf)`、`glFormatForDds(fourCC)`、`loadTexTexture(url): Promise<THREE.CompressedTexture | null>`

- [ ] **Step 1: 写失败测试（构造最小 .tex 头 + DDS 块）**

`packages/dsh-wallpaper-engine/tests/fixtures/make-tex.ts`：
```ts
import { Buffer } from 'node:buffer';
// Wallpaper Engine .tex 容器：版本/尺寸头 + 内嵌 DDS 数据。
// 本工具生成最小可测容器：前 16 字节头（magic 'WETEX' + width/height u32），
// 随后直接是 DDS 头 + BC1 块数据。
export function makeTex(width: number, height: number, fourCC: string, blockData: Uint8Array): Buffer {
  const ddsHeader = Buffer.alloc(128);
  ddsHeader.write('DDS ', 0, 'ascii');
  ddsHeader.writeUInt32LE(124, 4);            // DDS_HEADER size
  ddsHeader.writeUInt32LE(0x1007, 8);         // flags: CAPS|HEIGHT|WIDTH|PIXELFORMAT|LINEARSIZE
  ddsHeader.writeUInt32LE(height, 12);
  ddsHeader.writeUInt32LE(width, 16);
  ddsHeader.writeUInt32LE(blockData.length, 20);
  ddsHeader.writeUInt32LE(0x1000, 76);        // DDPF_FOURCC
  ddsHeader.write(fourCC, 80, 'ascii');
  ddsHeader.writeUInt32LE(0x1000, 108);       // DDSCAPS_TEXTURE
  const header = Buffer.alloc(16);
  header.write('WETEX', 0, 'ascii');
  header.writeUInt32LE(width, 8);
  header.writeUInt32LE(height, 12);
  return Buffer.concat([header, ddsHeader, Buffer.from(blockData)]);
}
```

`packages/dsh-wallpaper-engine/tests/tex-loader.test.ts`：
```ts
import { describe, expect, it } from 'vitest';
import { parseTex, glFormatForDds } from '../src/client/tex-loader.js';
import { makeTex } from './fixtures/make-tex.js';

describe('glFormatForDds', () => {
  it('maps fourCC to GL compressed formats', () => {
    expect(glFormatForDds('DXT1')).toBe(0x83f1);
    expect(glFormatForDds('DXT5')).toBe(0x83f3);
    expect(glFormatForDds('BC5U')).toBe(0x8fbd);
    expect(glFormatForDds('????')).toBe(0);
  });
});

describe('parseTex', () => {
  it('extracts dds bytes and dimensions', () => {
    const buf = makeTex(64, 32, 'DXT1', new Uint8Array(64 * 32 / 2).fill(0xff));
    const info = parseTex(buf)!;
    expect(info.width).toBe(64);
    expect(info.height).toBe(32);
    expect(info.glFormat).toBe(0x83f1);
    expect(info.dds.byteLength).toBe(128 + 64 * 32 / 2);
  });
  it('returns null for non-tex or non-compressed payloads', () => {
    expect(parseTex(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run tests/tex-loader.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 tex-loader.ts**

`packages/dsh-wallpaper-engine/src/client/tex-loader.ts`：
```ts
import * as THREE from 'three';

const FORMAT_MAP: Record<string, number> = {
  DXT1: 0x83f1, DXT3: 0x83f2, DXT5: 0x83f3,
  BC4U: 0x8fbd, BC4S: 0x8fbe, BC5U: 0x8fbf, BC5S: 0x8fc0,
};

export function glFormatForDds(fourCC: string): number {
  return FORMAT_MAP[fourCC] ?? 0;
}

export interface TexInfo {
  width: number;
  height: number;
  dds: Uint8Array;   // 自 DDS 头起（含 128B 头）
  glFormat: number;
}

export function parseTex(buf: Uint8Array): TexInfo | null {
  if (buf.length < 16) return null;
  const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3], buf[4]);
  if (magic !== 'WETEX') return null;
  const width = buf[8] | (buf[9] << 8) | (buf[10] << 16) | (buf[11] << 24);
  const height = buf[12] | (buf[13] << 8) | (buf[14] << 16) | (buf[15] << 24);
  const rest = buf.subarray(16);
  if (rest.length < 128) return null;
  const ddsMagic = String.fromCharCode(rest[0], rest[1], rest[2], rest[3]);
  if (ddsMagic !== 'DDS ') return null;
  const fourCC = String.fromCharCode(rest[80], rest[81], rest[82], rest[83]);
  const glFormat = glFormatForDds(fourCC);
  if (!glFormat) return null;
  return { width, height, dds: rest, glFormat };
}

export async function loadTexTexture(url: string): Promise<THREE.CompressedTexture | null> {
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const buf = new Uint8Array(await resp.arrayBuffer());
  const info = parseTex(buf);
  if (!info) return null;
  // THREE.CompressedTextureLoader 需要 DDS 解析：这里用其内部 ddsParser 的公开等价流程
  // （CompressedTextureLoader 的 load 接受 ArrayBuffer 且自动识别 DDS 头）。
  const loader = new THREE.CompressedTextureLoader();
  const tex = await loader.loadAsync(url);
  return tex;
}
```

> 注：`CompressedTextureLoader.loadAsync(url)` 会再次 fetch；若需避免双请求，可改用 `THREE.DDSLoader` 的 `parse(buffer, loadMipmaps)`（three 示例扩展，非核心包）。实现时若 `three/examples/jsm/loaders/DDSLoader.js` 可用则优先 `DDSLoader().parse(ddsBuffer)`，`loadTexTexture` 改为：fetch 一次 → `parseTex` → `DDSLoader.parse` → 返回 texture。测试只约束 `parseTex`/`glFormatForDds` 纯函数。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run tests/tex-loader.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: TEX 纹理容器解析与 WebGL 压缩纹理格式映射"
```

---

### Task 10: 粒子模拟器 v1（emitter / initializer / operator）

**Files:**
- Create: `packages/dsh-wallpaper-engine/src/client/particles.ts`
- Test: `packages/dsh-wallpaper-engine/tests/particles.test.ts`

**Interfaces:**
- Consumes: 无（纯数据驱动）
- Produces: `createParticleSystem(emitter, init, opts)`（签名见 Interfaces 一节）；`particlesFromSpec(json): { emitter, init } | null`（解析 Wallpaper Engine 粒子 json 的 v1 子集）

- [ ] **Step 1: 写失败的粒子模拟测试**

`packages/dsh-wallpaper-engine/tests/particles.test.ts`：
```ts
import { describe, expect, it } from 'vitest';
import { createParticleSystem } from '../src/client/particles.js';

const emitter = { rate: 10, directions: [1, 0, 0], distanceMin: 0, distanceMax: 5 };
const init = {
  lifetimeMin: 1, lifetimeMax: 1,
  sizeMin: 8, sizeMax: 20,
  velocityMin: [0, 0, 0] as [number, number, number],
  velocityMax: [1, 0, 0] as [number, number, number],
};

describe('createParticleSystem', () => {
  it('emits particles at rate and caps at maxParticles', () => {
    const ps = createParticleSystem(emitter, init, { maxParticles: 100 });
    for (let i = 0; i < 10; i++) ps.update(0.1); // 累计 1s，rate=10 → 约10个
    expect(ps.count()).toBeGreaterThanOrEqual(8);
    expect(ps.count()).toBeLessThanOrEqual(12);
  });
  it('removes particles after lifetime elapses', () => {
    const ps = createParticleSystem(emitter, init, { maxParticles: 100 });
    ps.update(0.5);  // 发射 5 个
    ps.update(1.0);  // 再过 1s → 第一批已到寿命（lifetime=1）
    expect(ps.count()).toBeLessThanOrEqual(10);
    ps.update(2.0);  // 全部过期
    expect(ps.count()).toBe(0);
  });
  it('moves particles along velocity', () => {
    const ps = createParticleSystem(emitter, init, { maxParticles: 10 });
    ps.update(1.0); // 10 个粒子，velocity ∈ [0,1]x
    const before = ps.positions();
    ps.update(0.5);
    const after = ps.positions();
    for (let i = 0; i < ps.count(); i++) {
      expect(after[i * 3]).toBeGreaterThanOrEqual(before[i * 3]);
    }
  });
  it('is deterministic given a fixed seed', () => {
    const a = createParticleSystem(emitter, init, { maxParticles: 10, seed: 42 });
    const b = createParticleSystem(emitter, init, { maxParticles: 10, seed: 42 });
    a.update(1); b.update(1);
    expect([...a.positions()]).toEqual([...b.positions()]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run tests/particles.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 particles.ts**

`packages/dsh-wallpaper-engine/src/client/particles.ts`：
```ts
export interface ParticleEmitterSpec {
  rate: number;
  directions: [number, number, number];
  distanceMin: number;
  distanceMax: number;
}
export interface ParticleInitializerSpec {
  lifetimeMin: number; lifetimeMax: number;
  sizeMin: number; sizeMax: number;
  velocityMin: [number, number, number];
  velocityMax: [number, number, number];
}
export interface ParticleSystemOptions { maxParticles: number; seed?: number }

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; maxLife: number;
  size: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createParticleSystem(
  emitter: ParticleEmitterSpec,
  init: ParticleInitializerSpec,
  opts: ParticleSystemOptions,
) {
  const rand = mulberry32(opts.seed ?? (Math.random() * 0xffffffff) >>> 0);
  const particles: Particle[] = [];
  let accumulator = 0;
  const positions = new Float32Array(opts.maxParticles * 3);

  function spawn(): void {
    if (particles.length >= opts.maxParticles) return;
    const life = init.lifetimeMin + rand() * (init.lifetimeMax - init.lifetimeMin);
    const size = init.sizeMin + rand() * (init.sizeMax - init.sizeMin);
    const dist = emitter.distanceMin + rand() * (emitter.distanceMax - emitter.distanceMin);
    const dir = emitter.directions;
    const dirLen = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    particles.push({
      x: (dir[0] / dirLen) * dist * (rand() * 2 - 1),
      y: (dir[1] / dirLen) * dist * (rand() * 2 - 1),
      z: (dir[2] / dirLen) * dist * (rand() * 2 - 1),
      vx: init.velocityMin[0] + rand() * (init.velocityMax[0] - init.velocityMin[0]),
      vy: init.velocityMin[1] + rand() * (init.velocityMax[1] - init.velocityMin[1]),
      vz: init.velocityMin[2] + rand() * (init.velocityMax[2] - init.velocityMin[2]),
      life, maxLife: life, size,
    });
  }

  function update(dt: number): void {
    accumulator += dt * emitter.rate;
    while (accumulator >= 1) {
      spawn();
      accumulator -= 1;
    }
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
    }
  }

  function syncPositions(): void {
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
    }
  }

  return {
    count: () => particles.length,
    update,
    positions: () => { syncPositions(); return positions; },
  };
}
```

- [ ] **Step 4: 运行测试确认通过（如随机断言抖动则固定 seed 或用区间）**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run tests/particles.test.ts`
Expected: PASS（4 个用例）。若 `lifetime 移除` 用例因 update 步进导致发射/移除计数与预期不符，调整断言区间（保留语义：过期必移除、不超 maxParticles）。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: 粒子模拟器 v1（发射/初始化/生命周期/速度，可种子复现）"
```

---

### Task 11: scene asset 路由完善 + EVA 集成 + 回退链接线（阶段 2 里程碑）

**Files:**
- Modify: `packages/dsh-wallpaper-engine/src/host/routes.ts`（scene asset 响应头完善）
- Modify: `packages/dsh-wallpaper-engine/src/client/index.ts`（接入 SceneRenderer 与粒子）
- Create: `packages/dsh-wallpaper-engine/src/client/scene-assets.ts`（按资源名拉取 + 粒子 json 解析 v1）
- Modify: `packages/dsh-wallpaper-engine/src/client/scene-renderer.ts`（接入粒子系统渲染）
- Test: `packages/dsh-wallpaper-engine/tests/scene-assets.test.ts`

**Interfaces:**
- Consumes: `parseSceneJson`、`parseTex`/`loadTexTexture`、`createParticleSystem`、`createSceneRenderer`
- Produces: `fetchSceneDescription(id): Promise<SceneDescription>`；`renderScene(id, canvas): Promise<boolean>`（供 controller 的 sceneRenderer 使用）

- [ ] **Step 1: 写失败的 scene-assets 测试**

`packages/dsh-wallpaper-engine/tests/scene-assets.test.ts`：
```ts
import { describe, expect, it, vi } from 'vitest';
import { particlesFromSpec } from '../src/client/scene-assets.js';
import { readFileSync } from 'node:fs';

describe('particlesFromSpec (v1 subset)', () => {
  it('maps Wallpaper Engine particle json to emitter/init spec', () => {
    const raw = JSON.stringify({
      emitter: [{ name: 'sphererandom', rate: 0.3, directions: '1 0.03 0', distancemin: 10, distancemax: 320 }],
      initializer: [
        { name: 'lifetimerandom', min: 8, max: 20 },
        { name: 'sizerandom', min: 350, max: 750 },
        { name: 'velocityrandom', min: '-20 0 0', max: '-5 10 0' },
      ],
    });
    const spec = particlesFromSpec(JSON.parse(raw))!;
    expect(spec.emitter.rate).toBe(0.3);
    expect(spec.init.lifetimeMin).toBe(8);
    expect(spec.init.lifetimeMax).toBe(20);
    expect(spec.init.sizeMin).toBe(350);
    expect(spec.init.velocityMin).toEqual([-20, 0, 0]);
  });
  it('returns null when emitter or initializers missing', () => {
    expect(particlesFromSpec({})).toBeNull();
    expect(particlesFromSpec({ emitter: [] })).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run tests/scene-assets.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 scene-assets.ts**

`packages/dsh-wallpaper-engine/src/client/scene-assets.ts`：
```ts
import type { SceneDescription } from '../shared/types.js';
import { parseSceneJson } from './scene-json.js';
import type { ParticleEmitterSpec, ParticleInitializerSpec } from './particles.js';

function vec3(s: unknown): [number, number, number] {
  if (typeof s !== 'string') return [0, 0, 0];
  const p = s.trim().split(/\s+/).map(Number);
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}

export async function fetchSceneDescription(id: string): Promise<SceneDescription> {
  const resp = await fetch(`/wallpapers/scene/${id}/asset?name=scene.json`);
  if (!resp.ok) throw new Error('scene.json fetch failed');
  return parseSceneJson(await resp.text());
}

export function particlesFromSpec(root: any): { emitter: ParticleEmitterSpec; init: ParticleInitializerSpec } | null {
  if (typeof root !== 'object' || root === null) return null;
  const em = Array.isArray(root.emitter) ? root.emitter[0] : undefined;
  const inits = Array.isArray(root.initializer) ? root.initializer : [];
  if (!em) return null;
  const life = inits.find((i: any) => i.name === 'lifetimerandom');
  const size = inits.find((i: any) => i.name === 'sizerandom');
  const vel = inits.find((i: any) => i.name === 'velocityrandom');
  return {
    emitter: {
      rate: Number(em.rate ?? 0),
      directions: vec3(em.directions),
      distanceMin: Number(em.distancemin ?? 0),
      distanceMax: Number(em.distancemax ?? 0),
    },
    init: {
      lifetimeMin: Number(life?.min ?? 1),
      lifetimeMax: Number(life?.max ?? 1),
      sizeMin: Number(size?.min ?? 16),
      sizeMax: Number(size?.max ?? 16),
      velocityMin: vec3(vel?.min),
      velocityMax: vec3(vel?.max),
    },
  };
}

export async function fetchParticleSpec(id: string, assetName: string): Promise<{ emitter: ParticleEmitterSpec; init: ParticleInitializerSpec } | null> {
  const resp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(assetName)}`);
  if (!resp.ok) return null;
  return particlesFromSpec(JSON.parse(await resp.text()));
}
```

- [ ] **Step 4: 渲染器接入粒子与图片对象**

修改 `scene-renderer.ts`：在 `setScene(desc)` 后新增 `addParticleSystem(spec, { sizeAttenuation })`，用 `THREE.BufferGeometry` + `THREE.Points` + `ShaderMaterial`（点精灵、加法混合、每粒子尺寸/透明度衰减）。帧循环里对每个注册的粒子系统调用 `system.update(dt)` 并 `geometry.attributes.position.needsUpdate = true`。图片对象纹理经 `loadTexTexture('/wallpapers/scene/:id/asset?name=' + materialRef)` 获取后调用 `setImageObject`（若返回 null 则跳过该对象）。

关键实现要点（代码骨架）：
```ts
// 在 createSceneRenderer 内部新增：
const particleSystems: Array<{ system: ReturnType<typeof createParticleSystem>; points: THREE.Points }> = [];
function addParticleSystem(spec: { emitter: any; init: any }, sizeAttenuation = true) {
  const system = createParticleSystem(spec.emitter, spec.init, { maxParticles: 2048 });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(system.positions(), 3));
  geometry.setDrawRange(0, 0);
  const material = new THREE.ShaderMaterial({
    uniforms: { uSize: { value: 16 } },
    vertexShader: `attribute float aSize; varying float vLife;
      void main(){ vLife = 1.0; vec4 mv = modelViewMatrix * vec4(position,1.0);
      gl_PointSize = aSize * (300.0 / -mv.z); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying float vLife; void main(){
      vec2 c = gl_PointCoord - 0.5; float d = length(c);
      if (d > 0.5) discard;
      float a = smoothstep(0.5, 0.0, d) * vLife;
      gl_FragColor = vec4(1.0, 1.0, 1.0, a); }`,
    transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  scene.add(points);
  particleSystems.push({ system, points });
}
```
并在帧循环中：
```ts
for (const ps of particleSystems) {
  ps.system.update(dt);
  ps.points.geometry.attributes.position.needsUpdate = true;
  ps.points.geometry.setDrawRange(0, ps.system.count());
}
```
> 注：`aSize` 顶点属性（每粒子尺寸）在后续扩展中补充；v1 先以 uniform 固定尺寸渲染，视觉接近即可。

- [ ] **Step 5: 提供 renderScene 入口并接入 controller**

`src/client/scene-renderer.ts` 导出：
```ts
export async function renderScene(id: string, canvas: HTMLCanvasElement): Promise<boolean> {
  try {
    const desc = await fetchSceneDescription(id);
    const renderer = createSceneRenderer(canvas);
    renderer.setScene(desc);
    for (const obj of desc.objects) {
      if (obj.kind === 'image') {
        const tex = await loadTexTexture(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(obj.image)}`);
        renderer.setImageObject(tex, obj);
      } else if (obj.kind === 'particle' && obj.particle) {
        const spec = await fetchParticleSpec(id, obj.particle);
        if (spec) renderer.addParticleSystem(spec);
      }
    }
    renderer.start();
    return true;
  } catch {
    return false;
  }
}
```
> 注：`obj.image` 指向 `models/xxx.json`（材料引用），实际纹理在其 `material` 字段指向的 `materials/xxx.json`；本任务 v1 简化：先尝试直接以 `obj.image` 名为 asset 名加载 tex（EVA 的模型 json 不含内嵌 tex 名时按 `materials/<模型名>.json` 推测纹理路径再解析其 `file` 字段）。实现时对 EVA 实测调整，失败即返回 false 走回退。

在 `client/index.ts` 的 `__wallpaperEngine.show` 的 `case 'scene'` 中调用 `renderScene(plan.wallpaperId, canvas)`（canvas 由 controller 创建），controller 的 `sceneRenderer` 选项改为指向该实现。

- [ ] **Step 6: 运行全部测试 + 构建**

Run: `cd packages/dsh-wallpaper-engine && npx vitest run && npm run build:client`
Expected: 全部 PASS，构建无报错

- [ ] **Step 7: 手动集成验证（阶段 2 里程碑）**

1. 将插件包链接进 profile（执行者按环境选择）：
   - `C:\Users\0009\.dsh\profiles\web\package.json` 的 dependencies 加入 `"@dsh-use/wallpaper-engine": "file:E:/code/dsh-use-wallpaper/packages/dsh-wallpaper-engine"`；
   - 或经 `dsh plugin --profile web` 安装；
   - 将 `cordis.patch.yml` 中插件行并入 `C:\Users\0009\.dsh\profiles\web\cordis.patch.yml`。
2. 启动/刷新 DSH Web GUI（`http://127.0.0.1:3080`），确认：
   - 设置面板出现壁纸引擎设置项；
   - 打开壁纸选择面板，列表显示 26 个壁纸缩略图；
   - 选择 EVA（1280029027）：背景出现 Three.js 渲染的动态粒子场景（灰烬/光柱/雾在动）；
   - 选择视频壁纸：mp4 循环播放；
   - 选择其他 scene 壁纸：回退 preview 图 + Ken Burns；
   - 修改透明度/模糊并刷新页面，设置保持。
3. 浏览器 DevTools Performance：EVA 场景 FPS ≥ 30（1080p）。

- [ ] **Step 8: 提交并收尾**

```bash
git add -A
git commit -m "feat: scene 渲染集成（EVA 粒子壁纸实时渲染 + 全回退链）"
```

更新 `packages/dsh-wallpaper-engine/README.md`：安装/构建/验证步骤；并把 `research/` 下的解析器原型与扫描脚本整理进文档（`docs/` 或包内 `README` 引用）。

---

## Self-Review 记录

（执行者开始前先阅读本计划与 spec，若发现下述核对项有遗漏，先补齐再动手。）

- [ ] **Spec 覆盖核对**：spec §5.1 路由表（list/preview/file/scene asset）→ Task 4/11；§5.2 PkgReader → Task 2；§5.3 TEX 直载 → Task 9；§5.4 SceneRenderer（scene.json/粒子）→ Task 8/10/11；§5.5 BackgroundLayer 回退链 → Task 5/6；§5.6 Picker/设置 → Task 7；§7 设置命名空间 → Task 1；§8 测试策略 → 各任务 TDD；§9 阶段 0-2 → Task 1-11；§11 验收标准 → Task 11 Step 7。
- [ ] **占位符核对**：除 Task 1 Step 9 的 `@deepseek-ai/dsh-settings` 依赖注记、Task 4 Step 4 与 Task 7 Step 4 的"以实际形态适配"注记（均为执行期适配项，非空承诺）外，无 TBD/TODO。
- [ ] **类型一致性核对**：`WallpaperInfo`/`PkgEntry`/`SceneDescription` 全计划一致；`resolveBackground` 产出 `BackgroundPlan`（Task 5 定义）与 controller/`show` 使用一致；`createParticleSystem` 签名在 Task 10/11 一致；`parseTex` 返回 `TexInfo | null` 与 `glFormatForDds` 一致。
