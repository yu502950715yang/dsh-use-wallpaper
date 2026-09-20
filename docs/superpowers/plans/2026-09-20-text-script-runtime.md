# text 脚本运行时（quickjs 沙箱）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 quickjs 沙箱里执行 WE 的 `text.script` 的 `update(value)`，让 CodeTime 等 6 张壁纸的 19 个未识别文本层显示真实内容。

**Architecture:** 新增 `src/client/text-script.ts`（模块级单例 QuickJS runtime，每脚本一个 IIFE 绑定，注入 `createScriptProperties` builder）；`three-renderer` 组装 text 层时按「脚本 → clock 硬编码 → 跳过」取驱动；wasm 经 `dist/static/` 由既有 `/wallpapers/static/` 路由服务。

**Tech Stack:** TypeScript（ESM/strict）、quickjs-emscripten 0.32（`RELEASE_SYNC` 变体）、three.js、vitest、esbuild。

**Spec:** `docs/superpowers/specs/2026-09-20-text-script-runtime-design.md`

## Global Constraints

- 回复、注释、文档、提交信息一律**简体中文**；代码/命令/文件名/术语保留原文。
- **注释从简**：一行说清「是什么 / 为什么」，最多 2 行；不复述代码、不贴实测数字（写进 AGENT.md/docs）。
- 提交信息：标题一行 `type(scope): 中文标题`，正文最多 3 行。
- 仅改 `text.script`；**不执行** `visible.script`、不做 visualizer/`createLayer`、不接 SceneScript 对象动画。
- 脚本不可用/失败时**绝不画占位值**：回退 clock → 跳过（保持 2026-09-20 的裁定）。
- 第三方脚本必须在 quickjs 沙箱内执行，且有步数上限（防死循环）。
- 改完必须 `npm run build`（tsc → `lib/`）+ `npm run build:client`（esbuild → `dist/`），并把 `lib/`、`dist/` 一起提交。
- 测试命令一律用**文件列表**，不要跑全量 `npx vitest run`（本机 `tests/shader` 会挂起）。
- 已知既有失败：`tests/dom/bootstrap.dom.test.ts` 的 I1（改动前基线即失败），不是回归。

---

### Task 1: text-script 运行时（builder + scriptproperties 注入 + bind/update/dispose）

**Files:**
- Create: `src/client/text-script.ts`
- Test: `tests/text-script.test.ts`

**Interfaces:**
- Consumes: `quickjs-emscripten` 的 `getQuickJS()`（与 `src/client/scene-script.ts` 同款用法）
- Produces:
  - `interface TextScriptBinding { update(): string | null; dispose(): void }`
  - `interface TextScriptRuntime { bind(script: string, scriptProperties: Record<string, unknown>, initialValue: string): TextScriptBinding | null; dispose(): void }`
  - `getTextScriptRuntime(): Promise<TextScriptRuntime | null>`（模块级单例；不可用返回 null）

- [ ] **Step 1: 写失败测试**

`tests/text-script.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { getTextScriptRuntime } from '../src/client/text-script.js';

// WE text 脚本真实形态：builder 声明属性 + update(value) 返回新文本。
const SCRIPT = `'use strict';
export var scriptProperties = createScriptProperties()
  .addCheckbox({ name: 'showHour', label: 'x', value: true })
  .finish();
export function update(value) {
  return scriptProperties.showHour ? 'H' + scriptProperties.extra : 'M' + scriptProperties.extra;
}`;

describe('getTextScriptRuntime', () => {
  it('注入的 scriptproperties 覆盖 builder 默认值', async () => {
    const rt = await getTextScriptRuntime();
    expect(rt).not.toBeNull();
    const a = rt!.bind(SCRIPT, { showHour: true, extra: '7' }, 'init');
    const b = rt!.bind(SCRIPT, { showHour: false, extra: '9' }, 'init');
    expect(a!.update()).toBe('H7');
    expect(b!.update()).toBe('M9');
    a!.dispose();
    b!.dispose();
  });

  it('未知 add* 方法不崩（宽松 builder）', async () => {
    const rt = await getTextScriptRuntime();
    const s = `export function update(v){ return 'ok'; }`;
    const b = rt!.bind(s, {}, '');
    expect(b!.update()).toBe('ok');
    b!.dispose();
  });

  it('没有 update 的脚本 → bind 返回 null', async () => {
    const rt = await getTextScriptRuntime();
    expect(rt!.bind(`var x = 1;`, {}, '')).toBeNull();
  });

  it('语法错误的脚本 → bind 返回 null（不抛）', async () => {
    const rt = await getTextScriptRuntime();
    expect(rt!.bind(`export function update( {`, {}, '')).toBeNull();
  });

  it('update 的入参是上一次返回的文本', async () => {
    const rt = await getTextScriptRuntime();
    const b = rt!.bind(`export function update(v){ return '[' + v + ']'; }`, {}, '');
    expect(b!.update()).toBe('[]');
    expect(b!.update()).toBe('[[]]');
    b!.dispose();
  });

  it('dispose 后重复 bind 仍可用（单例不被销毁）', async () => {
    const rt = await getTextScriptRuntime();
    const first = rt!.bind(`export function update(v){ return 'a'; }`, {}, '');
    first!.dispose();
    const second = rt!.bind(`export function update(v){ return 'b'; }`, {}, '');
    expect(second!.update()).toBe('b');
    second!.dispose();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/text-script.test.ts --reporter=basic`
Expected: FAIL（`text-script.js` 不存在 → 模块解析失败）

- [ ] **Step 3: 实现 `src/client/text-script.ts`**

```ts
// src/client/text-script.ts —— WE text 脚本（text.script 的 update）的 quickjs 沙箱运行时。
// 只执行 update(value)；沙箱内拿不到 DOM/window/fetch，且有步数上限防死循环。
import { getQuickJS } from 'quickjs-emscripten';
import type { QuickJSContext, QuickJSRuntime, QuickJSHandle } from 'quickjs-emscripten';

export interface TextScriptBinding {
  /** 调脚本 update(value) 取新文本；抛错/超时 → null（调用方保持上一帧）。 */
  update(): string | null;
  dispose(): void;
}

export interface TextScriptRuntime {
  /** 绑定一个 text 脚本；eval 失败/无 update → null（调用方回退）。 */
  bind(script: string, scriptProperties: Record<string, unknown>, initialValue: string): TextScriptBinding | null;
  dispose(): void;
}

// 单次调用（eval/update）的指令预算：正常脚本远低于此；死循环在此被中断。
const STEP_BUDGET = 1_000_000;

// WE 注入的 scriptProperties builder。宽松实现：未知 add* 方法登记后返回自身、不崩；
// finish() = {...builder 默认值, ...scene.json 的 scriptproperties}（注入值优先，见 spec §2.3）。
const PRELUDE = `
function createScriptProperties() {
  var injected = (typeof __weScriptProps === 'object' && __weScriptProps) ? __weScriptProps : {};
  var defaults = {};
  var api = {
    addCheckbox: add, addSlider: add, addComboBox: add, addColor: add,
    addText: add, addTextInput: add, addFont: add, addUserProperty: add,
    finish: function () { return Object.assign({}, defaults, injected); }
  };
  function add(o) { if (o && o.name) defaults[o.name] = o.value; return api; }
  return api;
}
true;
`;

class QuickJSTextRuntime implements TextScriptRuntime {
  private budget = 0;

  constructor(private readonly ctx: QuickJSContext, private readonly runtime: QuickJSRuntime) {}

  private resetBudget(): void {
    this.budget = STEP_BUDGET;
  }

  bind(
    script: string,
    scriptProperties: Record<string, unknown>,
    initialValue: string,
  ): TextScriptBinding | null {
    if (typeof script !== 'string' || !script) return null;
    const ctx = this.ctx;
    this.resetBudget();

    // 注入 scene.json 的 scriptproperties（{user,value} 包装已在 parseScriptProperties 解包）
    const props = ctx.newObject();
    for (const [key, value] of Object.entries(scriptProperties ?? {})) {
      if (typeof value === 'boolean') ctx.setProp(props, key, value ? ctx.true : ctx.false);
      else if (typeof value === 'number') ctx.setProp(props, key, ctx.newNumber(value));
      else if (typeof value === 'string') ctx.setProp(props, key, ctx.newString(value));
    }
    ctx.setProp(ctx.global, '__weScriptProps', props);

    // 剥 export + IIFE 隔离（各脚本的 update/addCero 等标识符互不冲突）
    const sanitized = script.replace(/\bexport\s+/g, '');
    const r = ctx.evalCode(
      `(function(){ ${PRELUDE} ${sanitized}
        return (typeof update === 'function') ? { update: update } : null;
      })()`,
    );
    if (r.error) {
      r.error.dispose();
      props.dispose();
      return null;
    }
    const mod = r.value;
    if (ctx.typeof(mod) !== 'object' || ctx.dump(mod) === null) {
      mod.dispose();
      props.dispose();
      return null;
    }
    const updateFn = ctx.getProp(mod, 'update');
    if (ctx.typeof(updateFn) !== 'function') {
      updateFn.dispose();
      mod.dispose();
      props.dispose();
      return null;
    }

    let last = initialValue ?? '';
    let disposed = false;
    return {
      update: (): string | null => {
        if (disposed) return null;
        this.resetBudget();
        const arg = ctx.newString(last);
        const out = ctx.callFunction(updateFn, ctx.undefined, arg);
        arg.dispose();
        if (out.error) {
          out.error.dispose();
          return null; // 单脚本抛错/被中断 → 只停该脚本
        }
        const v = ctx.dump(out.value);
        out.value.dispose();
        last = typeof v === 'string' ? v : String(v ?? '');
        return last;
      },
      dispose: (): void => {
        if (disposed) return;
        disposed = true;
        updateFn.dispose();
        mod.dispose();
        props.dispose();
      },
    };
  }

  dispose(): void {
    try { this.ctx.dispose(); } catch { /* noop */ }
    try { this.runtime.dispose(); } catch { /* gc 断言可忽略 */ }
  }
}

// 模块级单例：整页只实例化一次 QuickJS（跨壁纸复用，见 spec §3.3）。
let runtimePromise: Promise<TextScriptRuntime | null> | null = null;

async function createRuntime(): Promise<TextScriptRuntime | null> {
  try {
    const QuickJS = await getQuickJS();
    const runtime = QuickJS.newRuntime();
    const ctx = runtime.newContext();
    const pre = ctx.evalCode(PRELUDE);
    if (pre.error) {
      pre.error.dispose();
      ctx.dispose();
      runtime.dispose();
      return null;
    }
    pre.value.dispose();
    return new QuickJSTextRuntime(ctx, runtime);
  } catch {
    return null;
  }
}

export async function getTextScriptRuntime(): Promise<TextScriptRuntime | null> {
  runtimePromise ??= createRuntime();
  return runtimePromise;
}

export function resetTextScriptRuntimeForTest(): void {
  runtimePromise = null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/text-script.test.ts --reporter=basic`
Expected: PASS（6 项）

- [ ] **Step 5: 提交**

```bash
git add src/client/text-script.ts tests/text-script.test.ts
git commit -m "feat(text): quickjs text 脚本运行时(builder/scriptproperties 注入/update)"
```

---

### Task 2: 健壮性——抛错隔离、死循环中断

**Files:**
- Modify: `src/client/text-script.ts`
- Test: `tests/text-script.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 的 `QuickJSTextRuntime`（`step()` / `outOfBudget()`）
- Produces: 同上，无新导出

- [ ] **Step 1: 追加失败测试**

```ts
  it('脚本抛错 → update 返回 null（隔离，不抛给宿主）', async () => {
    const rt = await getTextScriptRuntime();
    const b = rt!.bind(`export function update(v){ throw new Error('boom'); }`, {}, '');
    expect(b!.update()).toBeNull();
    b!.dispose();
  });

  it('死循环脚本被步数预算中断 → update 返回 null，且 runtime 仍可用', async () => {
    const rt = await getTextScriptRuntime();
    const bad = rt!.bind(`export function update(v){ while(true){} }`, {}, '');
    expect(bad!.update()).toBeNull();
    bad!.dispose();
    const good = rt!.bind(`export function update(v){ return 'still-alive'; }`, {}, '');
    expect(good!.update()).toBe('still-alive');
    good!.dispose();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/text-script.test.ts -t 死循环 --reporter=basic`
Expected: FAIL（测试挂起或超时 → 说明预算未生效）

- [ ] **Step 3: 实现预算接口**

在 `QuickJSTextRuntime` 上加两个方法（供 interrupt handler 使用），把 `budget` 的递减/判定集中在这里：

```ts
  /** interrupt handler 每执行一批指令调一次：递减预算。 */
  step(): void {
    this.budget -= 1000;
  }

  /** 预算耗尽 → 让 quickjs 中断当前脚本（抛 interrupt 错误）。 */
  outOfBudget(): boolean {
    return this.budget <= 0;
  }
```

再把这两个方法接到 runtime 上（`createRuntime()` 里、`newContext()` **之前**注册；handler 通过闭包拿实例）：

```ts
    const runtime = QuickJS.newRuntime();
    let self: QuickJSTextRuntime | null = null;
    runtime.setInterruptHandler(() => {
      if (!self) return false;
      self.step();
      return self.outOfBudget();
    });
    const ctx = runtime.newContext();
    // …（PRELUDE 求值不变）
    pre.value.dispose();
    self = new QuickJSTextRuntime(ctx, runtime);
    return self;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/text-script.test.ts --reporter=basic`
Expected: PASS（8 项）

- [ ] **Step 5: 提交**

```bash
git add src/client/text-script.ts tests/text-script.test.ts
git commit -m "test(text): 脚本抛错与死循环隔离(步数预算中断)"
```

---

### Task 3: 构建接线（wasm 进 dist/static + 体积实测）

**Files:**
- Modify: `scripts/build-client.mjs`

**Interfaces:**
- Consumes: `node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm`（实测 491 KB）
- Produces: `dist/static/quickjs.wasm`；运行时用 `newQuickJSWASMModuleFromVariant(RELEASE_SYNC, { wasmLocation: '/wallpapers/static/quickjs.wasm' })`（`wasmLocation` 已在 quickjs-emscripten-core 的类型里核实）

- [ ] **Step 1: 在 build-client.mjs 里加 wasm 复制**

照抄同文件里 `GLSLANG_WASM_SRC` 那段的风格（`join(here, '..', 'node_modules', …)` + `existsSync` + `copyFileSync` + `console.log`），并在文件顶部 `node:fs` 的 import 里补上 `statSync`：

```js
// text 脚本沙箱（quickjs）：wasm 复制到 dist/static/，运行时用 RELEASE_SYNC 变体 +
// wasmLocation = '/wallpapers/static/quickjs.wasm'。与 glslang 不同：缺失即中止构建
// （否则线上会静默退化成「脚本不执行」，用户看到的是空文本层）。
const QUICKJS_WASM_SRC = join(here, '..', 'node_modules', '@jitl', 'quickjs-wasmfile-release-sync', 'dist', 'emscripten-module.wasm');
if (!existsSync(QUICKJS_WASM_SRC)) {
  throw new Error(`[build:client] 未找到 ${QUICKJS_WASM_SRC}，text 脚本沙箱不可用 —— 构建中止`);
}
copyFileSync(QUICKJS_WASM_SRC, join(outStatic, 'quickjs.wasm'));
console.log(`quickjs.wasm copied to dist/static/ (${(statSync(QUICKJS_WASM_SRC).size / 1024).toFixed(0)} KB)`);
```

- [ ] **Step 2: 改运行时加载方式**

`src/client/text-script.ts` 的 `createRuntime()` 改为用变体 + `wasmLocation`：

```ts
import { newQuickJSWASMModuleFromVariant, RELEASE_SYNC } from 'quickjs-emscripten';

// 浏览器：wasm 由 host 的 /wallpapers/static/ 提供（build:client 复制到 dist/static/quickjs.wasm）；
// Node 测试环境无 window → 交给库默认定位（fs 读取）。
const wasmLocation = typeof window !== 'undefined' ? '/wallpapers/static/quickjs.wasm' : undefined;
const QuickJS = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC, wasmLocation ? { wasmLocation } : undefined);
```

- [ ] **Step 3: 构建并实测体积**

Run: `npm run build:client`
Expected: 输出里有 `quickjs.wasm` 的复制日志；`dist/static/quickjs.wasm` 存在（≈491 KB）

Run 记录增量：`Get-ChildItem dist -Recurse -File | Measure-Object Length -Sum`（构建前后各一次，写进 Task 5 的文档）

- [ ] **Step 4: 跑单测确认 Node 环境不受影响**

Run: `npx vitest run tests/text-script.test.ts --reporter=basic`
Expected: PASS（8 项）

- [ ] **Step 5: 提交**

```bash
git add scripts/build-client.mjs src/client/text-script.ts dist/static/quickjs.wasm
git commit -m "build(text): quickjs wasm 复制到 dist/static 并由 /wallpapers/static 服务"
```

---

### Task 4: 接入 three-renderer（脚本优先 → clock 兜底 → 跳过）

**Files:**
- Modify: `src/client/text-object.ts`（新增 `createScriptDriver`）
- Modify: `src/client/three-renderer.ts`（组装 + teardown 释放）
- Test: `tests/text-object.test.ts`、`tests/three-renderer.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `TextScriptRuntime` / `TextScriptBinding`
- Produces:
  - `createScriptDriver(canvas: HTMLCanvasElement, opts: TextTextureOptions, binding: TextScriptBinding): ClockDriver`（复用既有 `ClockDriver` 的 `update(now: Date): boolean` 形态，忽略 `now`）
  - `createThreeSceneRenderer(opts?: { loadWasm?: LoadWasm; getTextScriptRuntime?: () => Promise<TextScriptRuntime | null> })`（新增可注入项，便于单测替身）

- [ ] **Step 1: 写失败测试（text-object）**

```ts
  it('createScriptDriver：脚本文本变化才重绘并返回 true', () => {
    let text = 'a';
    const binding = { update: () => text, dispose: () => {} };
    const canvas = document.createElement('canvas');
    const driver = createScriptDriver(canvas, { width: 10, height: 10 }, binding);
    expect(driver.update(new Date())).toBe(true);   // 与初始 '' 不同 → 重绘
    expect(driver.update(new Date())).toBe(false);  // 未变
    text = 'b';
    expect(driver.update(new Date())).toBe(true);
  });

  it('createScriptDriver：脚本返回 null（抛错/超时）时不动纹理', () => {
    const binding = { update: () => null, dispose: () => {} };
    const driver = createScriptDriver(document.createElement('canvas'), { width: 10, height: 10 }, binding);
    expect(driver.update(new Date())).toBe(false);
  });
```

- [ ] **Step 2: 写失败测试（three-renderer，注入替身 runtime）**

```ts
  // 公共 player 替身（与既有 helper 同风格）
  const scriptPlayer = () => ({
    dispose: vi.fn(), resize: vi.fn(), setGlowStage: vi.fn(), setObjectEffectStage: vi.fn(),
    isolatedObjects: () => [],
  });

  it('text 脚本可用 → 脚本驱动优先（clock 形态也走脚本）', async () => {
    const update = vi.fn(() => 'SCRIPTED');
    const bind = vi.fn(() => ({ update, dispose: vi.fn() }));
    stubAssetFetch(sceneWithText({ text: { value: '12:34', script: CLOCK_SCRIPT } }), {});
    stubTextRender();
    loadSceneToThree.mockReturnValue({ player: scriptPlayer(), sims: [], backgroundIds: [0], particleLayers: [] } as never);
    const r = createThreeSceneRenderer({
      loadWasm: defaultLoadWasm,
      getTextScriptRuntime: async () => ({ bind, dispose: vi.fn() }),
    });
    await r.render('2851992662', document.createElement('canvas'), null);
    const assets = loadSceneToThree.mock.calls[0][1] as { textLayers: Map<number, { texture: unknown; driver?: { update(now: Date): boolean } }> };
    expect(bind).toHaveBeenCalledTimes(1);
    expect(ctx2d.fillText.mock.calls[0][0]).toBe('SCRIPTED'); // 初始文本来自脚本，不是 clock 格式
    expect(assets.textLayers.get(5)!.driver).toBeTruthy();
    r.dispose();
  });

  it('脚本 bind 失败 + 识别为 clock → 回退 clock 驱动', async () => {
    stubAssetFetch(sceneWithText({ text: { value: '12:34', script: CLOCK_SCRIPT } }), {});
    stubTextRender();
    loadSceneToThree.mockReturnValue({ player: scriptPlayer(), sims: [], backgroundIds: [0], particleLayers: [] } as never);
    const r = createThreeSceneRenderer({
      loadWasm: defaultLoadWasm,
      getTextScriptRuntime: async () => ({ bind: () => null, dispose: vi.fn() }),
    });
    await r.render('2851992662', document.createElement('canvas'), null);
    // clock 分支产出的是时钟格式（HH:MM + 日期），不是 text.value 占位串
    expect(String(ctx2d.fillText.mock.calls[0][0])).toMatch(/\d{2}:\d{2}/);
    r.dispose();
  });

  it('脚本 bind 失败 + 非 clock 的脚本文本 → 跳过（不下发 textLayers）', async () => {
    stubAssetFetch(sceneWithText({
      text: { value: '"12"', script: "export function update(v){ var d = new Date(); return '' + d.getFullYear(); }" },
    }), {});
    stubTextRender();
    loadSceneToThree.mockReturnValue({ player: scriptPlayer(), sims: [], backgroundIds: [0], particleLayers: [] } as never);
    const r = createThreeSceneRenderer({
      loadWasm: defaultLoadWasm,
      getTextScriptRuntime: async () => ({ bind: () => null, dispose: vi.fn() }),
    });
    await r.render('2851992662', document.createElement('canvas'), null);
    expect((loadSceneToThree.mock.calls[0][1] as { textLayers: Map<number, unknown> }).textLayers.size).toBe(0);
    expect(ctx2d.fillText).not.toHaveBeenCalled();
    r.dispose();
  });

  it('dispose 释放脚本绑定（切壁纸不留 handle）', async () => {
    const disposeBinding = vi.fn();
    stubAssetFetch(sceneWithText({ text: { value: '12:34', script: CLOCK_SCRIPT } }), {});
    stubTextRender();
    loadSceneToThree.mockReturnValue({ player: scriptPlayer(), sims: [], backgroundIds: [0], particleLayers: [] } as never);
    const r = createThreeSceneRenderer({
      loadWasm: defaultLoadWasm,
      getTextScriptRuntime: async () => ({ bind: () => ({ update: () => 'x', dispose: disposeBinding }), dispose: vi.fn() }),
    });
    await r.render('2851992662', document.createElement('canvas'), null);
    r.dispose();
    expect(disposeBinding).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/text-object.test.ts tests/three-renderer.test.ts --reporter=basic`
Expected: FAIL（`createScriptDriver` 未定义 / `getTextScriptRuntime` 选项无效）

- [ ] **Step 4: 实现**

`text-object.ts` 加：

```ts
// 脚本文本驱动：每帧问脚本要新文本，变化才重绘（与 clock 驱动同形态，忽略 now）。
export function createScriptDriver(
  canvas: HTMLCanvasElement,
  opts: TextTextureOptions,
  binding: TextScriptBinding,
): ClockDriver {
  let last = '';
  return {
    update(_now: Date): boolean {
      const text = binding.update();
      if (text === null || text === '' || text === last) return false;
      drawTextToCanvas(canvas, text, opts);
      last = text;
      return true;
    },
  };
}
```

`three-renderer.ts`：
- `createThreeSceneRenderer` 增加 `opts.getTextScriptRuntime`（缺省 `getTextScriptRuntime`，从 `./text-script.js` 导入）；
- 组装 text 层时：`obj.script` 且 `bind` 成功 → `createScriptDriver`，并把 binding 收进模块级 `currentScriptBindings`，`continue`；
- `bind` 失败 → 落到既有 clock/跳过分支；
- `teardown()` 里 `for (const b of currentScriptBindings) b.dispose(); currentScriptBindings = [];`
- **仅在存在 text 脚本时**才 `await runtime`（避免无关壁纸付 wasm 实例化成本）。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/text-object.test.ts tests/three-renderer.test.ts tests/threejs-player.test.ts --reporter=basic`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/client/text-object.ts src/client/three-renderer.ts tests/text-object.test.ts tests/three-renderer.test.ts
git commit -m "feat(text): 脚本驱动优先、clock 兜底，切壁纸释放绑定"
```

---

### Task 5: 端到端验证、文档回写与最终提交

**Files:**
- Modify: `AGENT.md`（§7.1 第 6 条）、`README.md`（「使用前请了解」）、`docs/technical-notes.md`（§1.1）
- Modify: `lib/`、`dist/`（构建产物）

- [ ] **Step 1: 构建**

Run: `npm run build; npm run build:client`
Expected: 均 exit 0

- [ ] **Step 2: 端到端验证 CodeTime（核心验收）**

Run: `node research/verify-hidpi-object-rt.mjs --id=2980088441 --dprs=1 --phase=5 --no-particles --tag=script --out=verify-text`
Expected: `harness ok=true`（**不再回退 preview**）、主场景出现 7 个文本 quad、`console error 条数=0`；`research/verify-text/script-dpr1.png` 目检可见时间面板（小时/分钟/上下午/日/月份名/年 + 标签列）

- [ ] **Step 3: 回归 VHS 时钟与一张无关壁纸**

Run: `node research/verify-hidpi-object-rt.mjs --id=2937346640 --dprs=1 --phase=5 --no-particles --tag=vhs3 --out=verify-text`
Expected: `harness ok=true`、text quad 仍在、`console error = 0`

Run: `node research/verify-hidpi-object-rt.mjs --id=3743126786 --dprs=1 --phase=5 --no-particles --tag=gtr --out=verify-text`
Expected: 与本次改动前一致（无 text 对象的壁纸不受影响）

- [ ] **Step 4: 记录实测体积增量与泄漏口径**

对比 `dist/` 总大小（改动前 ≈8.7 MB）并记录 `quickjs.wasm` 实际字节数，写进文档（**用实测数字，不用估算**）。

⚠️ **泄漏测量的诚实边界**：本 harness 每次 `runPage` 都新建页面，**测不到「同页切壁纸」的 handle 泄漏**。因此 spec §5 第 4 条的「切壁纸 textures Δ0」本轮**只能由单测覆盖**（Task 4 断言 `binding.dispose()` 被调用）+ 代码审查（每个堆对象 handle 都显式 dispose）；**不得**在 AGENT.md 里写成「已验证 Δ0」。若要用整数计数实测，需另写一个「同页连续 render 两次」的 harness（不在本计划范围）。

- [ ] **Step 5: 回写文档**

- `AGENT.md` §7.1 第 6 条：把「带脚本但未识别的 text 一律跳过」订正为「**脚本在 quickjs 沙箱内执行**」+ 实测结论、边界（仍不执行 visible/visualizer/SceneScript）、逐条如实标注未验证项；
- `README.md`「使用前请了解」：把 `2980088441` 那条从「不会显示」订正为「会显示真实时间」（并保留仍不适用的说明）；
- `docs/technical-notes.md` §1.1 / §5：补 text 脚本运行时与 wasm 资产说明。

- [ ] **Step 6: 跑受影响的单测**

Run: `npx vitest run tests/text-script.test.ts tests/text-object.test.ts tests/threejs-player.test.ts tests/three-renderer.test.ts tests/dom --reporter=basic`
Expected: 通过（唯一失败应为既有的 `bootstrap.dom` I1）

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "docs(text): 回写脚本运行时的实测与边界；补构建产物"
```

---

## 完成判据

- spec §5 的 6 条验收全部有证据（其中「分钟随时间变化」用两次不同 `--phase` 或等待后重跑对比截图）；
- 若某条未达成（例如 VHS 脚本在沙箱里报错），**如实写进 AGENT.md §7.1**，不要把「脚本优先」写成已生效。
