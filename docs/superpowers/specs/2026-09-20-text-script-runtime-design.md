# text 脚本运行时（quickjs 沙箱）— 设计文档

- 日期：2026-09-20
- 状态：**设计已确认，待写实施计划**（用户 2026-09-20 确认：既走 quickjs 沙箱方案，也要把 VHS 时钟一起交给脚本引擎）
- 项目根：`E:\code\dsh-use-wallpaper`
- 关联：
  - `AGENT.md` §7.1 第 6 条（text 对象已渲染、但脚本只覆盖 clock 一类；未识别写法已改为跳过）
  - `docs/superpowers/plans/2026-08-21-fix-all-rendering-issues.md` 的 P3 风险条（原裁定：**不做通用脚本引擎**，用内置模式识别）—— 本文**有意推翻**该裁定，理由与边界见 §8
  - `src/client/scene-script.ts`（quickjs 绑定层先例，含 handle 生命周期的坑）
  - `src/client/text-object.ts`（`drawTextToCanvas` / `createClockDriver`，本设计复用它）
  - `docs/technical-notes.md` §1.1（three 主路径）

## 1. 概述

text 对象现在会渲染（2026-09-20），但**脚本不执行**：只有 `detectScriptPattern === 'clock'` 那一类写法走字，其余 19 个文本层（6 张壁纸）因为"直接画作者的占位值会变成屏幕脏字"而被跳过。实测代价：

- `2980088441`（CodeTime，7 个文本层拼一个时间面板）**整张壁纸零内容 → 回退 preview 图**；
- `3765967112`（Crimson Horizon，4 层）、`3789452668`（Knight，3 层）、`2911105183`（3 层）、`2460786246`、`2816905191` 的对应文本层**保持空缺**。

本文实现一个**沙箱内的 WE text 脚本运行时**：执行作者的 `update(value)`，让这些文本层显示真实内容。

**本轮范围（已与用户确认）**：
- 只执行 **`text.script`**；执行优先、`clock` 硬编码兜底、都失败则跳过（**绝不画占位值**）。
- 用 **quickjs 沙箱**（`quickjs-emscripten` 已在生产依赖里）；不用 `new Function` 在主上下文执行第三方代码。
- 引擎**模块级单例**（整页一份，跨壁纸复用），wasm 体积按实测 **0.48 MB** 计入。

## 2. 事实基础（spike 实测）

### 2.1 WE text 脚本的形态

```js
'use strict';
export var scriptProperties = createScriptProperties()
  .addCheckbox({ name: 'use24hFormat', label: '…', value: true })
  .finish();
export function update(value) { /* 计算并 return 新文本 */ }
```

- `createScriptProperties()` 是 WE 注入的全局 builder（链式 `addCheckbox` / `addSlider` / `addComboBox` / … + `finish()`）；
- `update(value)` 由引擎每次刷新调用，返回值即该文本层的新内容；
- scene.json 的 `text.scriptproperties` 携带**作者/用户设定值**（形如 `{"showMinute": true}` 或 `{user, value}` 包装，后者已在 `script-patterns.parseScriptProperties` 解包）。

### 2.2 spike（已跑通，脚本用完即删）

用 `quickjs-emscripten` + 剥 `export` + IIFE 包装 + 最小 builder，对 `2980088441` 的 7 个真实脚本调用 `update()`：

| 对象 | 脚本意图 | spike 输出 |
|---|---|---|
| id=19 Clock | 小时 | `"15"` |
| id=35 ClockMinute | 分钟 | `"15"` ← **错误**，见 2.3 |
| id=38 PM-AM | 上下午 | `"PM"` |
| id=41 Day | 日 | `"20"` |
| id=44 Text Layer | 月份名 | `"September"` |
| id=47 Yeat | 年 | `"2026"` |
| id=59 vars | 标签列 | `hour:\n minute:\n frame:\n day:\n month:\n year:` |

⇒ 这张壁纸**不是一堆占位符**，而是 7 层拼出的时间面板（本文让它真正显示出来）。返回值原样渲染（作者对 ≥10 的数字**故意加了引号**，桌面版同样显示 `"15"` —— 不是我们的缺陷）。

### 2.3 必须注入 `scriptproperties`（正确性前提，不是优化）

spike 用 builder **默认值**时，`id=35` 的 `showHour` 落到默认 `true`，输出成了小时而不是分钟 ⇒ **`finish()` 必须返回"默认值 ← scene.json 的 scriptproperties 覆盖"**。缺了它，整张面板的时间数值会错位。

### 2.4 体积实测（回答"是否每张壁纸复制一份"）

| 项 | 大小 | 说明 |
|---|---|---|
| `quickjs-wasmfile-release-sync/dist/emscripten-module.wasm` | **0.48 MB** | **一个文件、随包发布一次**，所有壁纸共享 |
| JS glue（quickjs-emscripten-core） | 数十~上百 KB | 进 `dist/client.js` |
| 每张壁纸新增 | 脚本源码本身（CodeTime 约 1 KB/对象） | 本来就在 `scene.pkg` 内，走既有 `/wallpapers/scene/<id>/asset` 路由 |

⇒ 与壁纸数量无关；实施后按实测记录 `dist/` 增量（不引用估算）。**当前 `dist/client.js` 不含 quickjs**（`scene-script.ts` 只被未接入的 `wasm-renderer` 引用，被 tree-shaking 移除）。

## 3. 设计

### 3.1 模块与 API（新增 `src/client/text-script.ts`）

```ts
export interface TextScriptBinding {
  /** 调脚本 update(value) 取新文本；抛错/超时 → null（调用方保持上一帧）。 */
  update(): string | null;
  dispose(): void;
}
export interface TextScriptRuntime {
  /** 绑定一个 text 脚本；eval 失败/无 update/超时 → null（调用方回退）。 */
  bind(script: string, scriptProperties: Record<string, unknown>, initialValue: string): TextScriptBinding | null;
  dispose(): void;
}
/** 模块级单例：整页只实例化一次 QuickJS（跨壁纸复用）。不可用（wasm 缺失等）→ null。 */
export async function getTextScriptRuntime(): Promise<TextScriptRuntime | null>;
```

内部要点：
- 一个 QuickJS context；**每个脚本一个 IIFE**（`(function(){ <prelude>; <script 剥 export>; return {update, scriptProperties}; })()`）⇒ 各脚本的 `update` / `addCero` 等标识符互不冲突；
- `prelude` 提供宽松 `createScriptProperties()`：所有 `add*` 登记 `name/value` 并返回自身（未知方法不崩），`finish()` 返回 `{...默认值, ...注入的 scriptproperties}`；
- **interrupt handler**：每次 `update` 前重置步数预算，超限即中断（防第三方脚本死循环）；
- 单脚本抛错 → 只停该脚本（返回 `null`），不影响其它文本层与整帧。

### 3.2 数据流

```
scene.json（text.script / text.scriptproperties，已由 scene-json 解析）
  → three-renderer：组装 text 层时先尝试 runtime.bind(script, props, text.value)
      ├─ 成功 → ScriptTextDriver（每帧 update()，文本变化才 drawTextToCanvas + needsUpdate）
      ├─ 失败且 detectScriptPattern==='clock' → 现有 createClockDriver（兜底）
      └─ 都不可用 → 跳过该文本层（保持 2026-09-20 的裁定：不画占位值）
  → threejs-player 帧循环（已有 textDrivers 机制，无需改动）
```

### 3.3 生命周期

- runtime/context **跨壁纸保留**；切壁纸只 `dispose()` 旧壁纸的所有 binding（handles 释放照 `scene-script.ts` 的 `gc_obj_list` 坑：堆对象 handle 必须逐个 dispose，否则 `runtime.dispose()` 断言）；
- 壁纸 `teardown` 时同时释放 driver 与其 binding；
- 没有 text 脚本的壁纸**不创建** runtime（避免为 22 张无关壁纸付 wasm 实例化成本）。

### 3.4 构建接线

- `scripts/build-client.mjs`：把 quickjs 的 release-sync wasm 复制到 `dist/static/`（与既有 `glslang.wasm` 同处理），并让运行时能定位到它（**具体定位 API 以 `quickjs-emscripten` 的 release-sync 变体为准，实施时先核实**）；
- 构建后断言资产存在（缺失则构建失败，避免"线上静默降级成不执行脚本"）。

### 3.5 安全边界

- 脚本在 **quickjs wasm 沙箱**内执行：拿不到 DOM / `window` / `fetch` / 宿主闭包；
- 有步数上限（防死循环），单脚本错误隔离；
- **不改** `scene-script.ts` 的既有行为（它服务于未接入的 wasm 路径），新模块独立。

## 4. 非目标

- `visible.script`（可见性脚本）、visualizer / 音频条脚本：**不执行**（后者依赖 `createLayer` 造渲染对象，是另一个量级）；
- SceneScript 对象动画（`SceneScriptRuntime` 那条路）：不接入运行时；
- `scriptProperties` 的**用户可调 UI**（WE 的属性面板）：本轮只用 scene.json 里的既有值，不做可调面板；
- 通用 WE JS API（`createLayer` / `registerAudioBuffers` / `getLayer` 等）。

## 5. 验收标准

1. `2980088441`（CodeTime）**不再回退 preview**，画面上显示时间面板：各文本层按 `scriptproperties` 取到正确字段（小时 / 分钟 / 上下午 / 日 / 月份名 / 年）加标签列，且**分钟随时间变化**；
2. `2937346640`（VHS 时间与日期）脚本优先，画面内容**不劣于**现有 clock 输出；
3. 其余 5 张含 text 的壁纸（`3765967112` / `3789452668` / `2911105183` / `2460786246` / `2816905191`）文本层有内容或保持跳过，**无回归**（不出现占位脏字）；
4. `console error = 0`；切壁纸后 `renderer.info.memory.textures` **Δ 0**（无 handle/wasm 泄漏）;
5. `dist/` 增量实测并记录（预期 ≈ 0.48 MB wasm + glue）；
6. 单测覆盖 §7 全部条目。

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 第三方脚本死循环（`while(true)`） | interrupt handler 步数预算；超限中断并停该脚本 |
| 脚本抛错 / 语法不兼容（`export`、`let`、模板串） | 剥 `export` + IIFE；抛错只停该脚本；失败回退 clock → 跳过 |
| handle 泄漏（`gc_obj_list` 断言 / 显存） | 逐个 dispose（照 `scene-script.ts`）；切壁纸 e2e 用 `info.memory.textures` 判 Δ0 |
| wasm 资产未随包发布 | 构建期断言 + 运行时 null 降级（退 clock / 跳过，绝不白屏） |
| 每帧调用的 CPU 成本（7 个文本层） | 文本变化才重绘纹理；用 harness `[4]` 段口径实测每帧提交耗时 |
| 包体变大 | 已实测 0.48 MB；实施后记录实际增量 |

## 7. 测试计划

- **单测**（`tests/text-script.test.ts`，node）：builder 宽松性（未知 `add*` 不崩）、scriptproperties 注入优先级（默认值 ← 注入值）、`update` 返回值原样、抛错隔离、死循环中断、`bind` 失败返回 null、`dispose` 后可重复创建；
- **接线单测**（`tests/three-renderer.test.ts`）：脚本优先于 clock、脚本失败回退 clock、两者都失败则不下发 textLayers；
- **端到端**（`research/verify-hidpi-object-rt.mjs`）：`2980088441` 显示时间面板且不回退 preview；`2937346640` 回归；`console error = 0`。

## 8. 对既有裁定的改变（如实记录）

`docs/superpowers/plans/2026-08-21-fix-all-rendering-issues.md` 的 P3 风险条写着"**不做通用 JS 引擎**（安全与工作量），内置模式识别覆盖全库已知脚本"；`AGENT.md` §7.1 第 6 条也把它列为"后续候选，未做"。

本轮**有意推翻**它，理由：① 模式识别追不上作者写法（CodeTime 的 7 层拼装、VHS 的 3000 字符脚本各不相同），留下的是"整张壁纸回退 preview"；② 沙箱方案的成本已实测可控（0.48 MB、模块级单例）；③ 安全边界明确（wasm 沙箱 + 步数上限，不碰宿主上下文）。

**边界依旧是窄的**：只执行 `text.script` 的 `update()`，不执行 `visible.script`、不做 `createLayer`、不接 SceneScript 对象动画。若将来要扩到那些，需另立设计文档。
