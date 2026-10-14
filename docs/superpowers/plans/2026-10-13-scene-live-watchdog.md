# scene 实时渲染看护（耗时打点 + 失败分级记忆 + 面板重试）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 scene 实时渲染的失败**可观测、可记忆、可重试**：装配/首帧耗时打点；失败按「硬失败（这张壁纸渲染不出来）/ 软失败（这次没供上）」分级记忆（硬失败按壁纸落盘、软失败仅会话内并冷却自动重试一次）；设置面板给出状态行与「重试实时渲染」「清除失败记忆」两个入口。

**Architecture:** 新增纯逻辑模块 `src/client/render-health.ts`（分级规则 + 记忆 + 文案格式化，存储与时钟注入 ⇒ node 可测）。`three-renderer.ts` 的 `render()` 把原来单一的 `false` 细化为结构化失败原因（`scene-json` / `load-error` / `no-visible-objects` / `context-lost` / `exception`），并在装配返回与首帧回调两处打点；对外**保持 `render(): Promise<boolean>` 契约不变**，失败详情另经 `getLastHealth()` 暴露。`index.ts` 订阅健康事件：硬失败写 store、软失败排一次冷却重试；面板经「共享 handler + 订阅式 emitter」读状态（与既有 `setWallpaperSelectHandler` / `setWallpaperRuntimeHandler` 同族）。

**Tech Stack:** TypeScript、three.js r170、vitest（node + jsdom 双环境）、`localStorage`

**Spec:** 无独立设计文档（bounded 变更：改的都是仓库里已有的渲染/设置/面板流程）。判据来源 = `AGENT.md` §2.1（scene 渲染路径 + 失败重试）、§5.39（面板 DOM 钩子被测试锁定）、§5.43（挂载幂等 + 收尾）、§6（壁纸目录只读 / 注释与提交从简）。

## Global Constraints

- **不改渲染像素路径**：本计划只加打点、记忆与 UI。验收必须含 `npm run e2e:compare`（判据 `maxAbs ≤ 1 && 差≥2 像素 = 0`）。
- **不改 `SceneRendererLike.render(): Promise<boolean>` 契约**（`wallpaper-controller.ts:8-21` 依赖它，controller 的「换新 canvas 重试一次」语义不许动）。
- **壁纸目录只读**（`AGENT.md` §6）：失败路径的验证只能靠注入（`vi.stubGlobal('fetch', …)` / e2e 里拦请求），**不得**改动 Steam 工坊里的任何文件。
- **存储用 `localStorage` 键 `we:renderfail:<wallpaperId>`**，不用 host settings。理由：① 仓库既有 per-wallpaper 客户端记忆就是 localStorage（`settings.ts:108` 的 `we:userprop:`）；② 失败记忆是**设备本地事实**（本机 GPU / 本浏览器解码能力），不该经 host settings 跨机器同步；③ 同 origin 的多个窗口共享 localStorage ⇒ 咨询时选定的「硬失败落盘、跨窗口共享」照样成立。已知边界：从另一个 origin（远程代理）打开 GUI 时不共享 —— 写进 §7 遗留。
- 新监听/定时器必须随实例收尾（`ctx.effect` + `wallpaper-controller` 的 `dispose`），遵守 §5.43（HMR 重挂不得叠加）。
- **只新增** `.wss-*` 类名，不得改动 §5.39 钉住的既有钩子结构/文本（`.wss-glow-*` / `.wss-quality` / `.wss-power` 恰 2 个复选框 / 首个 `.wss-glow-row` 文本 等）。
- 注释一行说清「是什么 / 为什么」（§6）；提交信息标题一行 + 正文 ≤3 行；文档/注释/提交一律简体中文。
- 铁律：`lib/` 与 `dist/client.js` 都要重新生成并提交（CI 有产物新鲜度守卫，见 §3.3）。
- 测试需完整权限（vitest/esbuild 走 service 子进程，受限沙箱会 `spawn EPERM`，§5.13）。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/client/render-health.ts`（新增） | 纯逻辑：硬/软分级规则、记忆读写（存储注入）、会话内软失败 + 自动重试闸、耗时快照、面板文案格式化 |
| `src/client/three-renderer.ts`（改） | `render()` 产出结构化失败原因 + 装配/首帧打点；新增 `getLastHealth()` / `setOnHealth()` |
| `src/client/index.ts`（改） | 建 store、订阅健康事件（写记忆 + 软失败冷却重试）、暴露 `__wallpaperEngine.health()` / `.retryLive()` / `.clearRenderFailures()` |
| `src/client/settings-section.tsx`（改） | 新增「实时渲染」卡片：状态行 + `wss-live-retry` / `wss-live-forget` 两个按钮；新增 `setWallpaperHealthHandler` / `subscribeWallpaperHealth` 两组共享入口 |
| `src/client/styles.ts`（改） | 新增 `.wss-live-status` / `.wss-live-retry` / `.wss-live-forget` 样式；把两个新按钮类名加进既有按钮选择器列表与 reduced-motion 列表 |
| `tests/render-health.test.ts`（新增） | 分级规则 / 落盘与读回 / 会话软失败 / 冷却重试 / 文案（node） |
| `tests/three-renderer.test.ts`（改） | 五种失败原因的分类 + 计时打点（jsdom + mock fetch） |
| `tests/dom/settings-section.dom.test.tsx`（改） | 三态状态行渲染 + 两个按钮回调（jsdom） |
| `tests/styles.test.ts`（改） | 新类名存在性 |
| `AGENT.md` / `TESTING.md`（改） | §2.1 增补「渲染看护」；§7 增补遗留边界（origin 不共享记忆 / 软失败不落盘）；TESTING.md 增补手工验收步骤 |

---

### Task 1: 看护纯逻辑模块 `render-health.ts`

**Files:**
- Create: `src/client/render-health.ts`
- Test: `tests/render-health.test.ts`

**Interfaces:**
- Consumes: 无（不 import 仓库其它模块，保持 node 可测）
- Produces:
  - `type HardFailureKind = 'scene-json' | 'no-visible-objects' | 'context-lost' | 'exception'`
  - `type SoftFailureKind = 'load-error'`
  - `type FailureKind = HardFailureKind | SoftFailureKind`
  - `isHardFailure(kind: FailureKind): boolean`
  - `interface RenderTiming { assembleMs: number; firstFrameMs: number }`
  - `interface HealthSnapshot { wallpaperId: string; ok: boolean | null; failure: HealthEntry | null; timing: RenderTiming | null }`
  - `interface HealthEntry { kind: FailureKind; hard: boolean; at: number; detail: string }`
  - `createRenderHealthStore(opts?: { storage?: StorageLike | null; now?: () => number; softCooldownMs?: number }): RenderHealthStore`
  - `RenderHealthStore`：`recordHard(id, kind, detail)` · `recordSoft(id, kind, detail)` · `recordOk(id, timing)` · `clear(id)` · `clearAll()` · `snapshot(id): HealthSnapshot` · `shouldAutoRetry(id): boolean` · `markAutoRetried(id): void`
  - `formatHealthLine(snapshot: HealthSnapshot, t: (s: string) => string): string`
  - `HEALTH_KEY_PREFIX = 'we:renderfail:'`

- [ ] **Step 1: 写失败测试** `tests/render-health.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  HEALTH_KEY_PREFIX, createRenderHealthStore, formatHealthLine, isHardFailure,
} from '../src/client/render-health.js';

// 内存 storage：与 localStorage 同形（node 环境无 localStorage）。
function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
    dump: () => m,
  };
}

describe('render-health 分级', () => {
  it('硬失败 = 有证据表明这张壁纸渲染不出来', () => {
    expect(isHardFailure('scene-json')).toBe(true);
    expect(isHardFailure('no-visible-objects')).toBe(true);
    expect(isHardFailure('context-lost')).toBe(true);
    expect(isHardFailure('exception')).toBe(true);
    expect(isHardFailure('load-error')).toBe(false);
  });
});

describe('render-health 记忆', () => {
  it('硬失败落盘、可读回；软失败只进会话', () => {
    const s = memStorage();
    let clock = 1000;
    const store = createRenderHealthStore({ storage: s, now: () => (clock += 10) });
    store.recordHard('3303428996', 'no-visible-objects', 'background=0 particleLayers=0');
    store.recordSoft('3303428996', 'load-error', 'fetch threw');
    const snap = store.snapshot('3303428996');
    // 硬失败优先呈现（软失败是「这次没供上」，不覆盖已确认的硬结论）
    expect(snap.failure?.kind).toBe('no-visible-objects');
    expect(snap.failure?.hard).toBe(true);
    expect(s.dump().has(HEALTH_KEY_PREFIX + '3303428996')).toBe(true);
    // 软失败不得落盘：换一个 store 实例（模拟重开 App）只剩硬失败
    const reopened = createRenderHealthStore({ storage: s });
    expect(reopened.snapshot('3303428996').failure?.kind).toBe('no-visible-objects');
    reopened.clear('3303428996');
    expect(reopened.snapshot('3303428996').failure).toBeNull();
  });

  it('软失败在冷却后只自动重试一次', () => {
    let clock = 0;
    const store = createRenderHealthStore({ storage: null, now: () => clock, softCooldownMs: 3000 });
    store.recordSoft('1', 'load-error', 'network');
    expect(store.shouldAutoRetry('1')).toBe(false); // 冷却未到
    clock = 3000;
    expect(store.shouldAutoRetry('1')).toBe(true);
    store.markAutoRetried('1');
    expect(store.shouldAutoRetry('1')).toBe(false); // 每会话只一次
    // 硬失败不触发自动重试（重试同一张渲染不出来的壁纸只会重复失败）
    clock = 99999;
    store.recordHard('2', 'exception', 'boom');
    expect(store.shouldAutoRetry('2')).toBe(false);
  });

  it('recordOk 清软失败并记计时；硬失败保持到显式 clear', () => {
    const s = memStorage();
    const store = createRenderHealthStore({ storage: s });
    store.recordSoft('7', 'load-error', 'network');
    store.recordOk('7', { assembleMs: 120, firstFrameMs: 480 });
    const snap = store.snapshot('7');
    expect(snap.ok).toBe(true);
    expect(snap.failure).toBeNull();
    expect(snap.timing).toEqual({ assembleMs: 120, firstFrameMs: 480 });
    store.recordHard('7', 'scene-json', '404');
    expect(store.snapshot('7').ok).toBe(false);
    expect(store.snapshot('7').failure?.kind).toBe('scene-json');
  });

  it('clearAll 清掉全部记忆键（面板「清除失败记忆」）', () => {
    const s = memStorage();
    const store = createRenderHealthStore({ storage: s });
    store.recordHard('a', 'exception', 'x');
    store.recordHard('b', 'context-lost', 'y');
    store.clearAll();
    expect(store.snapshot('a').failure).toBeNull();
    expect(store.snapshot('b').failure).toBeNull();
    expect(s.dump().size).toBe(0);
  });

  it('storage 抛错（隐私模式/配额）不冒泡，退化为会话内记忆', () => {
    const throwing = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
      key: () => null, length: 0,
    };
    const store = createRenderHealthStore({ storage: throwing });
    expect(() => store.recordHard('1', 'exception', 'x')).not.toThrow();
    expect(store.snapshot('1').failure?.kind).toBe('exception');
  });
});

describe('render-health 文案', () => {
  it('三种状态各有可读文案（不出现 undefined / 原始枚举）', () => {
    const store = createRenderHealthStore({ storage: null, now: () => 0 });
    const t = (s: string) => s;
    expect(formatHealthLine(store.snapshot('1'), t)).toContain('未渲染');
    store.recordOk('1', { assembleMs: 120, firstFrameMs: 480 });
    const okLine = formatHealthLine(store.snapshot('1'), t);
    expect(okLine).toContain('120');
    expect(okLine).toContain('480');
    store.recordHard('1', 'no-visible-objects', '');
    const line = formatHealthLine(store.snapshot('1'), t);
    expect(line).toContain('没有可显示的对象');
    expect(line).not.toContain('no-visible-objects');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/render-health.test.ts --reporter=basic`
Expected: FAIL —— `Failed to resolve import "../src/client/render-health.js"`

- [ ] **Step 3: 实现** `src/client/render-health.ts`

```ts
// scene 实时渲染看护：失败分级记忆 + 装配/首帧耗时打点。
// 纯逻辑（存储与时钟注入）⇒ node 可测；硬失败落 localStorage、软失败仅会话内。
// 分级的含义见 isHardFailure 注释与 AGENT.md §7.x「看护」条。

export type HardFailureKind = 'scene-json' | 'no-visible-objects' | 'context-lost' | 'exception';
export type SoftFailureKind = 'load-error';
export type FailureKind = HardFailureKind | SoftFailureKind;

const HARD_KINDS = ['scene-json', 'no-visible-objects', 'context-lost', 'exception'] as const;

/** 硬失败 = 有证据表明「这张壁纸渲染不出来」⇒ 可落盘；软失败 = 可能是这次没供上 ⇒ 只记会话。 */
export function isHardFailure(kind: FailureKind): kind is HardFailureKind {
  return (HARD_KINDS as readonly string[]).includes(kind);
}

export interface RenderTiming { assembleMs: number; firstFrameMs: number }
export interface HealthEntry { kind: FailureKind; hard: boolean; at: number; detail: string }
export interface HealthSnapshot {
  wallpaperId: string;
  ok: boolean | null;
  failure: HealthEntry | null;
  timing: RenderTiming | null;
}

export const HEALTH_KEY_PREFIX = 'we:renderfail:';
const SCHEMA_VERSION = 1;
const DEFAULT_SOFT_COOLDOWN_MS = 3000;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export interface RenderHealthStore {
  recordHard(id: string, kind: HardFailureKind, detail: string): void;
  recordSoft(id: string, kind: SoftFailureKind, detail: string): void;
  recordOk(id: string, timing: RenderTiming): void;
  clear(id: string): void;
  clearAll(): void;
  snapshot(id: string): HealthSnapshot;
  shouldAutoRetry(id: string): boolean;
  markAutoRetried(id: string): void;
}

function defaultStorage(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function createRenderHealthStore(opts: {
  storage?: StorageLike | null;
  now?: () => number;
  softCooldownMs?: number;
} = {}): RenderHealthStore {
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const now = opts.now ?? (() => Date.now());
  const cooldown = opts.softCooldownMs ?? DEFAULT_SOFT_COOLDOWN_MS;
  // 会话内（不落盘）：软失败、自动重试闸、最近结果与计时。
  const soft = new Map<string, { detail: string; at: number }>();
  const retried = new Set<string>();
  const session = new Map<string, { ok: boolean | null; timing: RenderTiming | null }>();

  const keyOf = (id: string) => HEALTH_KEY_PREFIX + id;

  const readHard = (id: string): HealthEntry | null => {
    if (!storage || !id) return null;
    let raw: string | null = null;
    try { raw = storage.getItem(keyOf(id)); } catch { return null; }
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as { v?: number; kind?: unknown; detail?: unknown; at?: unknown };
      if (v?.v !== SCHEMA_VERSION || typeof v.kind !== 'string') return null;
      const kind = v.kind as FailureKind;
      if (!isHardFailure(kind)) return null;
      return { kind, hard: true, at: Number(v.at) || 0, detail: String(v.detail ?? '') };
    } catch { return null; }
  };
  const writeHard = (id: string, kind: HardFailureKind, detail: string): void => {
    if (!storage || !id) return;
    try {
      storage.setItem(keyOf(id), JSON.stringify({
        v: SCHEMA_VERSION, kind, detail: String(detail).slice(0, 200), at: now(),
      }));
    } catch { /* 配额/隐私模式：记忆退化为会话内，不影响渲染 */ }
  };

  return {
    recordHard(id, kind, detail) {
      const prev = session.get(id) ?? { ok: null, timing: null };
      session.set(id, { ...prev, ok: false });
      writeHard(id, kind, detail);
    },
    recordSoft(id, kind, detail) {
      soft.set(id, { detail: detail + (kind ? ' (' + kind + ')' : ''), at: now() });
      // 软失败不覆盖会话内的 ok：一次网络抖动不代表这次装配成功/失败
      const prev = session.get(id) ?? { ok: null, timing: null };
      if (prev.ok === null) session.set(id, prev);
    },
    recordOk(id, timing) {
      soft.delete(id);
      session.set(id, { ok: true, timing });
    },
    clear(id) {
      soft.delete(id);
      retried.delete(id);
      session.delete(id);
      if (storage && id) { try { storage.removeItem(keyOf(id)); } catch { /* ignore */ } }
    },
    clearAll() {
      soft.clear();
      retried.clear();
      session.clear();
      if (storage) {
        const keys: string[] = [];
        try {
          for (let i = 0; i < storage.length; i++) {
            const k = storage.key(i);
            if (k && k.startsWith(HEALTH_KEY_PREFIX)) keys.push(k);
          }
        } catch { /* ignore */ }
        for (const k of keys) { try { storage.removeItem(k); } catch { /* ignore */ } }
      }
    },
    snapshot(id) {
      const hard = readHard(id);
      const s = session.get(id) ?? { ok: null, timing: null };
      if (hard) {
        return { wallpaperId: id, ok: s.ok === true ? true : false, failure: hard, timing: s.timing };
      }
      const softHit = soft.get(id);
      return {
        wallpaperId: id,
        ok: s.ok,
        failure: softHit ? { kind: 'load-error', hard: false, at: softHit.at, detail: softHit.detail } : null,
        timing: s.timing,
      };
    },
    shouldAutoRetry(id) {
      if (!id || retried.has(id)) return false;
      const hard = readHard(id);
      if (hard) return false; // 硬失败不自动重试（重试同一张渲染不出来的壁纸只会重复失败）
      const hit = soft.get(id);
      if (!hit) return false;
      return now() - hit.at >= cooldown;
    },
    markAutoRetried(id) { if (id) retried.add(id); },
  };
}

/** 面板状态行文案（不含 HTML；时间用「已记忆」而不写死相对时间，避免文案随实现漂移）。 */
export function formatHealthLine(snap: HealthSnapshot, t: (s: string) => string): string {
  const timing = snap.timing
    ? t('装配 {assemble} ms · 首帧 {first} ms')
        .replace('{assemble}', String(Math.round(snap.timing.assembleMs)))
        .replace('{first}', String(Math.round(snap.timing.firstFrameMs)))
    : '';
  if (snap.failure) {
    const reason = FAILURE_TEXT[snap.failure.kind] ?? t('渲染失败');
    return t('上次失败：{reason}')
      .replace('{reason}', reason)
      + (snap.failure.hard ? t('（已记忆，重开仍走降级）') : t('（本次会话内记忆）'))
      + (timing ? ' · ' + timing : '');
  }
  if (snap.ok === true) return t('实时渲染正常') + (timing ? ' · ' + timing : '');
  return t('尚未渲染（选择一张 scene 壁纸后这里显示状态）');
}

const FAILURE_TEXT: Record<FailureKind, string> = {
  'scene-json': '拿不到 scene.json',
  'no-visible-objects': '没有可显示的对象',
  'context-lost': 'WebGL 上下文丢失',
  'exception': '装配异常',
  'load-error': '资源加载中断',
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/render-health.test.ts --reporter=basic`
Expected: PASS（11 个断言组全绿）

- [ ] **Step 5: 提交**

```bash
git add src/client/render-health.ts tests/render-health.test.ts
git commit -m "feat(health): 新增 scene 渲染看护纯逻辑模块

失败分硬/软两级：硬失败落 localStorage、软失败仅会话内 + 冷却一次自动重试。
存储与时钟注入，node 可测。"
```

---

### Task 2: `three-renderer.render()` 产出结构化失败原因 + 打点

**Files:**
- Modify: `src/client/three-renderer.ts:350-356`（返回值对象开头）、`:358-380`（render 开头与 scene.json 拉取）、`:801-817`（成功/失败出口）
- Test: `tests/three-renderer.test.ts`（在文件末尾追加 describe）

**Interfaces:**
- Consumes: Task 1 的 `HardFailureKind` / `SoftFailureKind` / `RenderTiming`
- Produces:
  - `createThreeSceneRenderer(opts?: { …, healthStore?: RenderHealthStore })`（新增可选参数）
  - 返回对象新增 `getLastHealth(): HealthSnapshot | null`、`setOnHealth(cb: ((s: HealthSnapshot) => void) | null): void`
  - 每次 `render()` 结束时对**当前壁纸 id** 调 `healthStore.recordHard/recordSoft/recordOk`

- [ ] **Step 1: 写失败测试**（追加到 `tests/three-renderer.test.ts`）

```ts
describe('scene 渲染看护：失败分类与打点', () => {
  it('scene.json 404 → 硬失败 scene-json', async () => {
    const store = createRenderHealthStore({ storage: null });
    const r = createThreeSceneRenderer({ healthStore: store });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })));
    const fg = document.createElement('canvas');
    expect(await r.render('wid-404', fg)).toBe(false);
    expect(store.snapshot('wid-404').failure?.kind).toBe('scene-json');
    expect(store.snapshot('wid-404').failure?.hard).toBe(true);
  });

  it('scene.json fetch 抛错 → 软失败 load-error（不落盘、可自动重试）', async () => {
    const store = createRenderHealthStore({ storage: null, softCooldownMs: 0 });
    const r = createThreeSceneRenderer({ healthStore: store });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const fg = document.createElement('canvas');
    expect(await r.render('wid-net', fg)).toBe(false);
    const snap = store.snapshot('wid-net');
    expect(snap.failure?.kind).toBe('load-error');
    expect(snap.failure?.hard).toBe(false);
    expect(store.shouldAutoRetry('wid-net')).toBe(true);
  });

  it('装配成功 → 记 ok 与装配耗时，并在首帧回调处补 firstFrameMs', async () => {
    const store = createRenderHealthStore({ storage: null });
    let onFrame: ((dt: number) => void) | null = null;
    loadSceneToThree.mockImplementation((_json, assets: any) => {
      onFrame = assets.onFrame; // 宿主注入的每帧钩子：首帧计时挂在这里
      return { player: { setAnimationLoop: vi.fn(), pause: vi.fn(), dispose: vi.fn() }, sims: [], backgroundIds: [1], particleLayers: [] };
    });
    const r = createThreeSceneRenderer({ healthStore: store });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => SCENE_ONE_IMAGE })));
    expect(await r.render('wid-ok', document.createElement('canvas'))).toBe(true);
    const before = store.snapshot('wid-ok').timing;
    expect(before?.assembleMs).toBeGreaterThanOrEqual(0);
    expect(before?.firstFrameMs).toBe(-1); // 首帧还没发生
    onFrame?.(0.016);
    expect(store.snapshot('wid-ok').timing?.firstFrameMs).toBeGreaterThanOrEqual(0);
  });
});
```

`SCENE_ONE_IMAGE` 与 `loadSceneToThree` 的 mock 已存在于该测试文件顶部（`vi.mock('../src/client/threejs-player.js', … loadSceneToThree: vi.fn()`，见 `tests/three-renderer.test.ts:10-14`）；若该文件尚无 `SCENE_ONE_IMAGE` 常量，用下面这份最小 scene.json：

```ts
const SCENE_ONE_IMAGE = JSON.stringify({
  general: { orthogonalprojection: { width: 1920, height: 1080 } },
  objects: [{ id: 1, name: 'bg', image: 'models/bg.json', origin: '960.00000 540.00000 0.00000', size: '1920.00000 1080.00000' }],
});
```

⚠️ 装配**成功**路径（本节第三例）必须让 `loadWasm` 的 mock 返回一个可用 stub：该文件顶部是 `vi.mock('../src/client/wasm-loader.js', () => ({ defaultLoadWasm: vi.fn() }))`，`vi.fn()` 返回 `undefined`，装配期一旦触碰 `mod.CpuParticleSim` 就会落进 catch、被记成 `exception`。做法二选一：① 在 `loadWasm` 的 mock 里 `mockResolvedValue({ CpuParticleSim: class { … } })`；② 直接复用该文件里**已有的成功用例**（它必然已经解决了同一问题），只在其断言里补看护相关三条。**不得**为了让测试过而改 `three-renderer.ts` 的错误分类顺序。

新增 import：

```ts
import { createRenderHealthStore } from '../src/client/render-health.js';
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/three-renderer.test.ts -t "看护" --reporter=basic`
Expected: FAIL —— `getLastHealth is not a function` / `store.snapshot(...).failure` 为 `null`

- [ ] **Step 3: 改 `three-renderer.ts` —— 参数与状态**

在文件顶部的 import 区加：

```ts
import { createRenderHealthStore } from './render-health.js';
import type { HealthSnapshot, RenderHealthStore, RenderTiming } from './render-health.js';
```

签名（`three-renderer.ts:187-190`）改为：

```ts
export function createThreeSceneRenderer(opts?: {
  loadWasm?: LoadWasm;
  getTextScriptRuntime?: () => Promise<TextScriptRuntime | null>;
  // 看护存储：不传则自建一个（localStorage 可用时落盘）。注入点存在是为了单测不碰真实存储。
  healthStore?: RenderHealthStore;
}): SceneRendererLike
```

在函数体（`warnOnce` 附近）加状态：

```ts
  // ── 渲染看护状态（Task 2）────────────────────────────────────────────────
  const health = opts?.healthStore ?? createRenderHealthStore();
  let currentHealthId = '';
  let healthHandler: ((s: HealthSnapshot) => void) | null = null;
  let renderStartedAt = 0;
  // 首帧耗时只在「本次装配的第一次 onFrame」记一次；-1 = 还没出帧。
  let firstFrameAt = -1;
  const publish = (snap: HealthSnapshot) => {
    if (!healthHandler) return;
    try { healthHandler(snap); } catch { /* 订阅者异常不得影响渲染 */ }
  };
  const fail = (kind: HardFailureKind | SoftFailureKind, detail: string) => {
    const hard = isHardFailure(kind);
    if (hard) health.recordHard(currentHealthId, kind as HardFailureKind, detail);
    else health.recordSoft(currentHealthId, kind as SoftFailureKind, detail);
    publish(health.snapshot(currentHealthId));
  };
  const succeed = (assembleMs: number) => {
    health.recordOk(currentHealthId, { assembleMs, firstFrameMs: firstFrameAt });
    publish(health.snapshot(currentHealthId));
  };
```

（`HardFailureKind` / `SoftFailureKind` / `isHardFailure` 一并 import。）

- [ ] **Step 4: 改 `render()` 的各出口**

`render()` 开头（`:351-358` 现有 `warnedKeys.clear()` / `contextLost = false` / `frameCapture?.reset()` 之后）加：

```ts
      currentHealthId = id;
      renderStartedAt = performance.now();
      firstFrameAt = -1;
```

scene.json 拉取（`:370-372`）改为**单独 try/catch**，把「网络中断」与「服务端明确说不」分开：

```ts
        let sceneJsonResp: Response;
        try {
          sceneJsonResp = await fetch(`/wallpapers/scene/${id}/asset?name=scene.json`);
        } catch (e) {
          // 网络/磁盘一时没供上 ⇒ 软失败（不落盘，冷却后自动重试一次）
          fail('load-error', e instanceof Error ? e.message : String(e));
          return false;
        }
        if (!sceneJsonResp.ok) {
          // 服务端明确回答「这份 scene.json 拿不到」⇒ 硬失败
          fail('scene-json', 'http ' + sceneJsonResp.status);
          return false;
        }
```

`abortIfContextLost()` 为真而返回的那 8 处（`:368, 373, 448, 509, 550, 643, 736, 801`）不改控制流，也**不在这里记原因**（见下）：上下文丢失的记录点只能有一处，否则同一次丢失会被记两遍。

```ts
  function abortIfContextLost(): boolean {
    if (!contextLost) return false;
    // 记录点在 onContextLost（唯一一次事件）——本函数只负责中止装配。
    teardown();
    return true;
  }
```

**上下文丢失的记录点在 `onContextLost`（`:292-305`，原文见下）**，因为「装配完成后、帧循环已经跑起来才丢上下文」是生产上最常见的路径（浏览器回收 / GPU 复位），而那条路径不会经过任何 `abortIfContextLost()` 调用点。只需在既有函数体里插一行 `fail(...)`（`fail`/`publish` 定义在 `:257-270`，在本函数之前 ⇒ 无 TDZ 问题；`currentHealthId` 与 `contextLostId` 同源于本次 render）：

```ts
  const onContextLost = (e: Event) => {
    e.preventDefault();
    contextLost = true;
    const id = contextLostId;                  // teardown 可能清掉它 ⇒ 先取（既有代码顺序，勿调换）
    // 硬失败：记在事件侧 ⇒ 覆盖「装配期丢失」与「运行期丢失」两条路径，且每次丢失恰好一条。
    fail('context-lost', 'webglcontextlost');
    try { teardown(); } catch { /* 释放失败不得掩盖回退 */ }
    …（以下既有告警与 contextLostHandler?.(id) 原样保留）
  };
```

（`{once: true}` 的监听 + `render()` 开头复位 `contextLost` ⇒ 同一次丢失只会触发一次；重新装配是新 canvas + 新监听，属新的一次丢失。无 id 的全静默场景由 Task 1 的空 id 守卫兜住，`fail` 成为 no-op。）

零可见对象出口（`:806-810`）改为：

```ts
        if (result.backgroundIds.length === 0 && result.particleLayers.length === 0) {
          fail('no-visible-objects', `background=0 particleLayers=0`);
          teardown();
          return false;
        }
```

成功出口（`:803-811`）：

```ts
        console.log(
          `[three] scene loaded id=${id} background=${result.backgroundIds.length} particleLayers=${result.particleLayers.length}`,
        );
        succeed(performance.now() - renderStartedAt);
        if (result.backgroundIds.length === 0 && result.particleLayers.length === 0) { … }  // 见上
        return true;
```

⚠️ 顺序：`succeed()` 必须在零可见对象判定**之后**（否则空场景会被记成成功）。正确写法：

```ts
        console.log(
          `[three] scene loaded id=${id} background=${result.backgroundIds.length} particleLayers=${result.particleLayers.length}`,
        );
        if (result.backgroundIds.length === 0 && result.particleLayers.length === 0) {
          fail('no-visible-objects', 'background=0 particleLayers=0');
          teardown();
          return false;
        }
        succeed(performance.now() - renderStartedAt);
        return true;
```

catch 出口（`:812-816`）改为：

```ts
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[three] scene render failed:', msg);
        fail('exception', msg);
        teardown();
        return false;
      }
```

- [ ] **Step 5: 首帧计时挂到 `assets.onFrame` 上**

在装配 `assets`（`:404-446` 之后、`loadSceneToThree` 调用 `:647` 之前）处包装每帧钩子：

```ts
        // 首帧耗时：宿主注入的 onFrame 第一次被调用即「真的画出了一帧」。
        const userOnFrame = assets.onFrame;
        assets.onFrame = (dt: number) => {
          if (firstFrameAt < 0) {
            firstFrameAt = performance.now() - renderStartedAt;
            health.recordOk(id, { assembleMs: performance.now() - renderStartedAt, firstFrameMs: firstFrameAt });
            publish(health.snapshot(id));
          }
          userOnFrame?.(dt);
        };
```

- [ ] **Step 6: 暴露读接口**

返回对象（`:350` 起的字面量）末尾追加：

```ts
    // 看护读接口：设置面板与 `window.__wallpaperEngine.health()` 用它取当前壁纸状态。
    getLastHealth(): HealthSnapshot | null {
      return currentHealthId ? health.snapshot(currentHealthId) : null;
    },
    setOnHealth(cb: ((s: HealthSnapshot) => void) | null): void {
      healthHandler = cb;
    },
```

并同步 `wallpaper-controller.ts:8-21` 的 `SceneRendererLike` 接口，加两个可选成员：

```ts
  getLastHealth?(): HealthSnapshot | null;
  setOnHealth?(cb: ((s: HealthSnapshot) => void) | null): void;
```

- [ ] **Step 7: 跑测试**

Run: `npx vitest run tests/three-renderer.test.ts --reporter=basic`
Expected: PASS（含既有断言，无回归）

- [ ] **Step 8: 提交**

```bash
git add src/client/three-renderer.ts src/client/wallpaper-controller.ts tests/three-renderer.test.ts
git commit -m "feat(health): render 失败细化为结构化原因并打点

scene-json/空场景/contextlost/异常 = 硬失败，fetch 中断 = 软失败；
装配耗时与首帧耗时分别记在 render 返回与首次 onFrame。"
```

---

### Task 3: `index.ts` 接线（写记忆 + 软失败冷却自动重试 + 全局入口）

**Files:**
- Modify: `src/client/index.ts:32`（创建 renderer）、`:42-59`（运行期下发附近）、`:145-172`（`__wallpaperEngine` 暴露）、`:62-72`（teardown）
- Test: `tests/dom/wallpaper-health.dom.test.tsx`（新增，jsdom）

**Interfaces:**
- Consumes: Task 2 的 `getLastHealth()` / `setOnHealth()`；Task 1 的 store
- Produces:
  - `window.__wallpaperEngine.health(): HealthSnapshot | null`
  - `window.__wallpaperEngine.retryLive(): void`（清本壁纸记忆 + 重选一次）
  - `window.__wallpaperEngine.clearRenderFailures(): void`（清全部记忆）
  - bootstrap 内的**局部函数** `retryLive()` / `clearRenderFailures()`（Task 4 的共享 handler 直接复用它们，不重复实现）
  - 面板订阅入口 `setWallpaperHealthHandler` / `notifyWallpaperHealth` 在 Task 4 定义（本 Task 只做「选壁纸后补推一次」的调用点）

- [ ] **Step 1: 写失败测试** `tests/dom/wallpaper-health.dom.test.tsx`

```tsx
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn(async () => {});
vi.mock('../../src/client/background-layer.js', () => ({
  createBackgroundLayer: () => ({ root: document.createElement('div'), setOverlayOpacity() {}, setBlur() {}, setPaused() {}, showNone() {}, showImage() {}, showVideo() {}, showWeb() {} }),
}));
vi.mock('../../src/client/wallpaper-controller.js', () => ({
  createWallpaperController: () => ({ load: async () => {}, select: selectMock, applyTextStyle() {} }),
}));
// settings-section 是 .tsx（依赖 React）：本测试只验 index.ts 的接线，把它整体替身掉
vi.mock('../../src/client/settings-section.js', () => ({
  WallpaperSettingsSection: () => null,
  setWallpaperSelectHandler: vi.fn(),
  setWallpaperRuntimeHandler: vi.fn(),
  setWallpaperHealthHandler: vi.fn(),
  notifyWallpaperHealth: vi.fn(),
}));
vi.mock('../../src/client/styles.js', () => ({ injectWallpaperStyles: vi.fn() }));
const rendererMock = vi.hoisted(() => ({
  getLastHealth: vi.fn(() => ({ wallpaperId: 'w1', ok: true, failure: null, timing: { assembleMs: 10, firstFrameMs: 20 } })),
  setOnHealth: vi.fn(),
  setPaused: vi.fn(), setQualityScale: vi.fn(), setGlow: vi.fn(), setSoundEnabled: vi.fn(), dispose: vi.fn(),
}));
vi.mock('../../src/client/three-renderer.js', () => ({ createThreeSceneRenderer: () => rendererMock }));

import { bootstrap } from '../../src/client/index.js';

describe('window.__wallpaperEngine 看护入口', () => {
  beforeEach(() => { document.body.innerHTML = ''; vi.clearAllMocks(); localStorage.clear(); });
  it('health / retryLive / clearRenderFailures 都在，且 retryLive 会清记忆并重选', async () => {
    bootstrap();
    await new Promise((r) => setTimeout(r, 0));
    const api = (window as any).__wallpaperEngine;
    expect(api.health().ok).toBe(true);
    localStorage.setItem('we:renderfail:w1', JSON.stringify({ v: 1, kind: 'exception', detail: 'x', at: 1 }));
    api.clearRenderFailures();
    expect(localStorage.getItem('we:renderfail:w1')).toBeNull();
    // retryLive 只清「当前选中壁纸」的记忆 ⇒ 先选中 w1（select 同步写本实例的 settings）
    api.select('w1');
    await new Promise((r) => setTimeout(r, 0));
    localStorage.setItem('we:renderfail:w1', JSON.stringify({ v: 1, kind: 'exception', detail: 'x', at: 1 }));
    api.retryLive();
    expect(localStorage.getItem('we:renderfail:w1')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/dom/wallpaper-health.dom.test.tsx --reporter=basic`
Expected: FAIL —— `api.health is not a function`

- [ ] **Step 3: 改 `index.ts`**

顶部 import 增加：

```ts
import { createRenderHealthStore } from './render-health.js';
import type { HealthSnapshot } from './render-health.js';
```

`bootstrap` 内（`const sceneRenderer = createThreeSceneRenderer();` 处）改为：

```ts
  // 看护存储：与 renderer 共用同一实例（面板/全局入口读的是同一份记忆）。
  const healthStore = createRenderHealthStore();
  const sceneRenderer = createThreeSceneRenderer({ healthStore });
  // 两个可复用入口：全局 API 与面板共享 handler 都调它们（只此一份实现）。
  const clearRenderFailures = () => { healthStore.clearAll(); };
  const retryLive = () => {
    const id = settings.selectedWallpaperId;
    if (id) healthStore.clear(id);
    if (!id || !controller) return;
    void controller.select(id);
  };
  // 软失败冷却后自动重试一次（同一壁纸、每会话一次）；硬失败不自动重试。
  let autoRetryTimer = 0;
  const onHealth = (snap: HealthSnapshot) => {
    if (!snap.wallpaperId) return;
    if (!healthStore.shouldAutoRetry(snap.wallpaperId)) return;
    healthStore.markAutoRetried(snap.wallpaperId);
    if (autoRetryTimer) clearTimeout(autoRetryTimer);
    autoRetryTimer = window.setTimeout(() => {
      autoRetryTimer = 0;
      if (disposed || !controller) return;
      // 只有「这张壁纸仍是当前选择」才重试，避免用户已切走却被拽回。
      if (settings.selectedWallpaperId !== snap.wallpaperId) return;
      void controller.select(snap.wallpaperId);
    }, 0);
  };
  sceneRenderer.setOnHealth?.(onHealth);
```

`teardown()`（`:62-72`）内补 `if (autoRetryTimer) { clearTimeout(autoRetryTimer); autoRetryTimer = 0; }`，并撤销订阅 `sceneRenderer.setOnHealth?.(null);`。

`(window as any).__wallpaperEngine = { … }`（`:145`）追加三个入口：

```ts
    // 看护入口（面板与排查用）：读状态 / 重试当前壁纸 / 清空全部失败记忆。
    health: () => sceneRenderer.getLastHealth?.() ?? null,
    retryLive,
    clearRenderFailures,
```

- [ ] **Step 4: 跑测试**

Run: `npx vitest run tests/dom/wallpaper-health.dom.test.tsx --reporter=basic`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/client/index.ts tests/dom/wallpaper-health.dom.test.tsx
git commit -m "feat(health): 接线看护存储与软失败冷却重试

新增 __wallpaperEngine.health/retryLive/clearRenderFailures；收尾清定时器与订阅。"
```

---

### Task 4: 设置面板「实时渲染」卡片

**Files:**
- Modify: `src/client/settings-section.tsx:12-25`（props）、`:39-48`（共享 handler）、`:186-232` 后插入卡片、`:378`（message 行上方）
- Modify: `src/client/styles.ts:198-216`（按钮选择器列表与 reduced-motion）
- Test: `tests/dom/settings-section.dom.test.tsx`（追加）、`tests/styles.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `HealthSnapshot` / `formatHealthLine`；Task 3 的 store（经共享 handler 回传）
- Produces:
  - `WallpaperSettingsSectionProps` 新增 `health?: HealthSnapshot | null`、`onRetryLive?: () => void`、`onClearRenderFailures?: () => void`
  - 导出 `setWallpaperHealthHandler(h: WallpaperHealthHandler): void`、`subscribeWallpaperHealth(cb): () => void`
  - `interface WallpaperHealthHandler { retry(): void; clearFailures(): void; get(): HealthSnapshot | null; }`
  - DOM 钩子：`.wss-live-status`（状态行）、`.wss-live-retry`、`.wss-live-forget`

- [ ] **Step 1: 写失败测试**（追加到 `tests/dom/settings-section.dom.test.tsx`）

```tsx
it('实时渲染卡片：三态状态行 + 两个按钮回调', async () => {
  const onRetryLive = vi.fn();
  const onClearRenderFailures = vi.fn();
  const { container } = mount({
    ...BASE_SETTINGS,
    health: { wallpaperId: 'w1', ok: false, failure: { kind: 'no-visible-objects', hard: true, at: 1, detail: '' }, timing: { assembleMs: 120, firstFrameMs: -1 } },
    onRetryLive,
    onClearRenderFailures,
  } as any);
  const status = container.querySelector('.wss-live-status');
  expect(status?.textContent).toContain('没有可显示的对象');
  await act(async () => { (container.querySelector('.wss-live-retry') as HTMLButtonElement).click(); });
  expect(onRetryLive).toHaveBeenCalledTimes(1);
  await act(async () => { (container.querySelector('.wss-live-forget') as HTMLButtonElement).click(); });
  expect(onClearRenderFailures).toHaveBeenCalledTimes(1);
});

it('未渲染时不显示失败文案', async () => {
  const { container } = mount({ ...BASE_SETTINGS, health: { wallpaperId: 'w1', ok: null, failure: null, timing: null } } as any);
  expect(container.querySelector('.wss-live-status')?.textContent).toContain('尚未渲染');
});
```

（`mount` / `BASE_SETTINGS` / `act` 已存在于该文件，见 `tests/dom/settings-section.dom.test.tsx:1-64`；新增字段记得同步 `BASE_SETTINGS`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/dom/settings-section.dom.test.tsx --reporter=basic`
Expected: FAIL —— 找不到 `.wss-live-status`

- [ ] **Step 3: 改 `settings-section.tsx`**

import 区加：

```ts
import { formatHealthLine } from './render-health.js';
import type { HealthSnapshot } from './render-health.js';
```

props 接口（`:12-25`）追加：

```ts
  /** 当前壁纸的渲染健康快照（由 index.ts 经 subscribeWallpaperHealth 推送；null = 还没选壁纸）。 */
  health?: HealthSnapshot | null;
  onRetryLive?: () => void;
  onClearRenderFailures?: () => void;
```

共享入口（紧邻 `setWallpaperRuntimeHandler`，`:46-48` 下方）：

```ts
/** 面板「实时渲染」卡片要的三件事：读状态、重试当前壁纸、清空全部失败记忆。 */
export interface WallpaperHealthHandler {
  get(): HealthSnapshot | null;
  retry(): void;
  clearFailures(): void;
}
let healthHandler: WallpaperHealthHandler | null = null;
const healthSubscribers = new Set<(s: HealthSnapshot | null) => void>();

export function setWallpaperHealthHandler(handler: WallpaperHealthHandler): void { healthHandler = handler; }

/** 订阅健康变化（组件挂载时订阅、卸载时退订；index.ts 调 notifyWallpaperHealth 推送）。 */
export function subscribeWallpaperHealth(cb: (s: HealthSnapshot | null) => void): () => void {
  healthSubscribers.add(cb);
  return () => { healthSubscribers.delete(cb); };
}

/** 由 index.ts 的健康事件调用；也用于组件挂载时补一次当前值。 */
export function notifyWallpaperHealth(snap: HealthSnapshot | null): void {
  for (const cb of Array.from(healthSubscribers)) {
    try { cb(snap); } catch { /* 单个订阅者异常不影响其它订阅者 */ }
  }
}
```

组件内（`const [message, setMessage] = useState('')` 附近）加本地状态与订阅：

```tsx
  const [health, setHealth] = useState<HealthSnapshot | null>(props.health ?? null);
  useEffect(() => {
    setHealth(props.health ?? healthHandler?.get() ?? null);
    return subscribeWallpaperHealth((s) => setHealth(s));
  }, [props.health]);
```

卡片（插在「显示效果」卡片 `:232` 之后）：

```tsx
      {/* 实时渲染：状态行 + 重试/清除入口（scene 壁纸失败时用户唯一能自救的地方） */}
      <section className="wss-section">
        <h4 className="wss-section-title">实时渲染</h4>
        <p className="wss-section-desc wss-live-status">
          {formatHealthLine(health ?? { wallpaperId: '', ok: null, failure: null, timing: null }, weT)}
        </p>
        <div className="wss-row">
          <button type="button" className="wss-live-retry" onClick={() => { if (props.onRetryLive) props.onRetryLive(); else healthHandler?.retry(); setMessage('已重试实时渲染'); }}>
            重试实时渲染
          </button>
          <button type="button" className="wss-live-forget" onClick={() => { if (props.onClearRenderFailures) props.onClearRenderFailures(); else healthHandler?.clearFailures(); setMessage('已清除失败记忆'); }}>
            清除失败记忆
          </button>
        </div>
      </section>
```

（`weT` 是本文件既有的翻译函数；若文件内的调用名不同，用文件内既有的那个 —— 以 `grep -n "weT(" src/client/settings-section.tsx | head` 的实际结果为准。）

- [ ] **Step 4: 改 `styles.ts`**

按钮基样式的选择器列表（`:198-200`）追加 `.wss-live-retry`、`.wss-live-forget`；reduced-motion 列表（`:216`）同上；并加状态行样式：

```css
/* 实时渲染状态行：失败原因用提示色，正常时沿用次级文字色（不抢眼）。 */
.wss-live-status { margin-bottom: 8px; }
.wss-live-status[data-state="failed"] { color: var(--wp-accent-strong); }
```

在组件里给状态行补 `data-state`：`data-state={health?.failure ? 'failed' : 'ok'}`。

`tests/styles.test.ts` 追加断言：样式串里出现 `.wss-live-retry`、`.wss-live-forget`、`.wss-live-status`。

- [ ] **Step 5: 在 `index.ts` 里把 handler 与推送接上**

先把两个新符号加进 `index.ts:5` 那条既有的 settings-section import（**同一个 import 语句里追加**，不要新开一条）：

```ts
import { WallpaperSettingsSection, setWallpaperSelectHandler, setWallpaperRuntimeHandler, setWallpaperHealthHandler, notifyWallpaperHealth } from './settings-section.js';
```

```ts
    setWallpaperHealthHandler({
      get: () => sceneRenderer.getLastHealth?.() ?? null,
      retry: retryLive,
      clearFailures: () => { clearRenderFailures(); notifyWallpaperHealth(null); },
    });
```

把 Task 3 的 `onHealth` 改为同时推送面板（`notifyWallpaperHealth` 来自 Task 4 Step 3 的同文件导出）：

```ts
  const onHealth = (snap: HealthSnapshot) => {
    notifyWallpaperHealth(snap);
    …（Task 3 的软失败冷却重试逻辑不变）
  };
```

选中壁纸后 `notifyWallpaperHealth(sceneRenderer.getLastHealth?.() ?? null)`（在 `selectWallpaper` 的 `.then` 里补一次），使面板切换壁纸即刷新状态行。

- [ ] **Step 6: 跑测试**

Run: `npx vitest run tests/dom/settings-section.dom.test.tsx tests/styles.test.ts --reporter=basic`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/client/settings-section.tsx src/client/styles.ts src/client/index.ts tests/dom/settings-section.dom.test.tsx tests/styles.test.ts
git commit -m "feat(health): 设置面板加实时渲染状态行与重试入口

只新增 .wss-live-* 类名，不动既有被测试锁定的面板钩子。"
```

---

### Task 5: 全量验证 + 文档

**Files:**
- Modify: `AGENT.md`（§2.1 增一条、§7 增一条）、`TESTING.md`（增手工验收步骤）

- [ ] **Step 1: 跑本机过关最小集（CI 判据）**

```bash
pnpm exec tsc -p tsconfig.json --noEmit
pnpm exec tsc -p tsconfig.json
git add -A -- lib/ && git diff --cached --exit-code -- lib/
node scripts/build-client.mjs
git diff --exit-code -- dist/client.js
pnpm exec vitest run --reporter=json --outputFile=.vitest-report.json
node scripts/check-known-failures.mjs .vitest-report.json
```

Expected: 全部 exit 0（`check-known-failures` 输出「无新增失败」）

- [ ] **Step 2: 零回归对拍**

```bash
npm run e2e:hidpi -- --tag=before   # 在改动前的工作树上跑（本任务开始前先跑一次）
npm run e2e:hidpi -- --tag=after    # 改动后
npm run e2e:compare
```

Expected: `compare-shots` exit 0（`maxAbs ≤ 1` 且「差≥2」像素为 0）。若 before 没来得及跑，用 `git stash` 回退到改动前补跑。

- [ ] **Step 3: 真机手工验收（写进 TESTING.md，逐条勾）**

在 DSH Web GUI 里：

1. 选一张 scene 壁纸 → Console 应出现 `[three] scene loaded id=…`，设置面板「实时渲染」状态行显示「实时渲染正常 · 装配 N ms · 首帧 M ms」。
2. 在 Console 执行 `__wallpaperEngine.health()` → 返回 `ok:true` 与 timing。
3. 模拟软失败：Console 执行下面这段（只影响当前页面，不碰磁盘），状态行应显示「上次失败：资源加载中断（本次会话内记忆）」，且 **localStorage 里不应出现 `we:renderfail:` 键**：

```js
// 拦一次 scene.json 请求并抛错，复现「网络中断」软失败
const raw = window.fetch;
let once = true;
window.fetch = function (u, o) {
  if (once && String(u).includes('scene.json')) { once = false; window.fetch = raw; return Promise.reject(new TypeError('Failed to fetch')); }
  return raw.call(this, u, o);
};
__wallpaperEngine.select(__wallpaperEngine.health?.()?.wallpaperId || '');
```

4. 冷却后（≥3s）应看到一次自动重选（Console 出现新的 `[three] scene loaded`），且**只重试一次**。
5. 模拟硬失败：把 fetch 改成对 `scene.json` 恒返回 `{ ok: false, status: 404 }`，重选壁纸 → 状态行显示「上次失败：拿不到 scene.json（已记忆，重开仍走降级）」，`localStorage.getItem('we:renderfail:<id>')` 有值。
6. 点「重试实时渲染」→ 记忆被清、壁纸重新装配；点「清除失败记忆」→ 所有 `we:renderfail:` 键消失。
7. 重开 App（或强刷页面）→ 若第 6 步没清，仍能看到上次的硬失败记忆。

- [ ] **Step 4: 更新文档**

`AGENT.md` §2.1 追加一条：

```markdown
- **渲染看护**（2026-10-13）：`render()` 的失败细化为结构化原因（`scene-json` / `no-visible-objects` / `context-lost` / `exception` = **硬失败**，`load-error` = **软失败**），经 `render-health.ts` 分级记忆：硬失败按壁纸落 `localStorage`（`we:renderfail:<id>`）、软失败仅会话内并在冷却后自动重试一次；面板「实时渲染」卡片显示状态并提供重试/清除；排查入口 `__wallpaperEngine.health()`。对渲染像素路径**零改动**（`e2e:compare` 零回归）。
```

`AGENT.md` §7 追加一条（**如实标注边界**）：

```markdown
38. **看护的已知边界**：① 失败记忆落在 **localStorage**（同 origin 多窗口共享，但从另一个 origin 访问 GUI 时不共享，且不同步到其它机器）；② 软失败只记会话内，**重开即忘**；③ 首帧耗时是「宿主 `onFrame` 第一次被调用」，不等于「首帧已上屏」（浏览器合成时机不可观测）；④ 无装配**超时中断**（慢盘上仍会一直等），本计划只观测不打断。
```

`TESTING.md` 增补 Task 5 Step 3 的 7 步手工验收清单（原文照抄）。

- [ ] **Step 5: 提交**

```bash
git add AGENT.md TESTING.md lib dist
git commit -m "docs(health): 记录渲染看护机制、边界与手工验收清单"
```

---

## Self-Review

- **Spec 覆盖**：咨询选定的三件（①首帧/装配耗时打点 ②失败分级记忆：真失败落盘 + 软失败会话内 ③面板重试入口）分别落在 Task 2、Task 1+3、Task 4。
- **命名一致性**：`RenderHealthStore` / `HealthSnapshot` / `HealthEntry` / `RenderTiming` / `isHardFailure` / `HEALTH_KEY_PREFIX` / `formatHealthLine` 在 Task 1 定义后，Task 2/3/4 引用同名；`.wss-live-status` / `.wss-live-retry` / `.wss-live-forget` 在 Task 4 内部一致。
- **与咨询口径的一处偏差（已注明理由）**：记忆介质用 localStorage 而非 host settings —— 理由写在 Global Constraints，并作为 §7 遗留条目记录边界。
- **未覆盖但已知**：装配超时中断（YAGNI，已列为遗留）；跨 origin 共享失败记忆（已列为遗留）。
