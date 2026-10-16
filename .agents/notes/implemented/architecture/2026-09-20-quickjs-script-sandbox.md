# Agent Note: WE 第三方脚本一律走 quickjs 沙箱

Status: implemented

## Problem

WE 场景里带脚本的壁纸（`visible.script`、text 的脚本、`createLayer`、音频脚本）**只能靠真正的 JS 引擎执行** —— 作者的写法千变万化，没有可枚举的模式。实测反例很有说服力：壁纸 `3798688689` 的全部动画都在 **17 个 SceneScript** 里，任何一种"识别常见写法"的方案都覆盖不到，代价是整张壁纸回退 preview 图。

但执行第三方代码不能用 `eval` / `new Function`：脚本可能是死循环，也可能试图访问宿主；而且脚本与渲染之间需要一个**可测**的接口，不能直接攥着 three 对象。

## Decision

**quickjs-emscripten wasm 沙箱 + 数据驱动状态表。**

- 脚本在 **quickjs 沙箱**里跑（模块级单例，`quickjs-emscripten` 的 wasm 由 `scripts/build-client.mjs` 复制到 `dist/static/`），不进主上下文、不用 `new Function`；**步数预算**限制死循环，且**每次调用前重置预算**（不是累计，否则一次超时会永久毒化后续调用）；单脚本抛错/超时**只停该脚本**，不穿出帧循环。
- 运行时**不持有 three 对象**：SceneScript 走「**数据驱动状态表 + 渲染侧 applier**」（`layer-state.ts` 的 `LayerStateTable` / `applyLayerState`）。**单 ctx、按 `objects` 顺序装载**，脚本之间靠 `shared.*` 互通（顺序是契约的一部分，换顺序会改变脚本可见的共享状态）。
- **text 脚本优先级 = 脚本 → `clock` 兜底 → 跳过**：脚本 `bind()` 失败时**绝不画 `text.value` 占位值**（用户实测：屏幕上会出现脏字），跳过是正确降级。
- **`layer.visible = false` 折算成 `alpha = 0`**，**不动**引擎既有的 scene.json 可见性过滤：全库有 121 个既有 `visible:false` 对象，改过滤会让它们的画面变化，与零回归冲突。
- 动画必须按**该动画自身的 fps** 推进（同一张壁纸里可能 60 与 1200 并存，差 20 倍；统一按 60 只会慢 20 倍而且**不报错**，属于最难发现的一类错）。
- **不扩展旧 `scene-script.ts`**（其 class / `IThisPropertyObject` 语义与本 VM 不同，且该文件已随 wasm 渲染路径删除）；**`text.script` 也不收进 SceneScript VM** —— 它顶层调用 `createScriptProperties()`，在新 VM 里必然失败（把两者混收时收集数从 17 变 15 才对，这个数字本身就是判据）。
- 未实现的 WE API 用 **Proxy 兜底**，否则一个 `TypeError` 会让整个脚本停摆。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `9afc674` `11c27cf`

## Alternatives considered

**用内置模式识别代替通用脚本引擎（识别 Simple Visualizer、时钟等常见写法）。** 理由：不必引入 JS 引擎与 wasm 体积，行为完全可控，也不用担心沙箱逃逸。这是前一期的实际裁定，本期**有意推翻**：真机 `3798688689` 的全部动画都在 17 个 SceneScript 里，识别覆盖率上不去，而失败的代价是整张壁纸回退 preview；沙箱实测只增加 0.48MB 且是模块级单例。

**直接 `eval` / `new Function` 执行脚本。** 理由：零依赖、零体积，语法与 WE 完全一致。不用它是因为要对**第三方**代码负责：死循环会卡死渲染循环，脚本也能随意触及宿主环境；而沙箱只是多一层 API 桥，脚本作者的代码本身不用改。

**把脚本引擎编进 Rust wasm，或用 `update_image` 回写像素。** 理由：与渲染同侧、少一次跨边界调用。不用它是因为该路线随 wasm 渲染路径整体删除，且"回写图像"与"数据驱动状态表"是两种架构 —— 后者可测、可单测，前者只能对着像素猜。

**让 SceneScript 与 text 脚本共用一个 ctx。** 理由：少一套生命周期、共享代码更省事。不用它是因为两者语义不同（一个是图层状态，一个是文本内容与 `createScriptProperties`），共用会让 `text.script` 的重复收集问题扩散到全部脚本。

## Consequences

**收益：** 脚本编排的壁纸真的动了起来（`3798688689` 恢复为脚本编排的场景、歌名字标重影消除）；沙箱边界明确（步数预算 + 每次调用前重置 + 单脚本失败隔离），第三方脚本不能再影响帧循环；状态表让"脚本 → 渲染"这一段可以在 node 下单测，不必对着画面猜。

**代价：** ① 产物变大：`dist` 多出 `quickjs.wasm`（约 491 KB），`client.js` 增约 93 KB；② 未实现的 WE API 靠 Proxy 兜底 ⇒ 属于"静默降级"，脚本不会报错但行为可能不完整；③ 能力仍不完整（`createLayer` 等的生产侧映射、部分音频脚本未接），这些边界记在 `AGENT.md` §7；④ 旧 `scene-script.ts` 的语义**不复刻**，依赖那套 class 语义的脚本不会被支持。

设计与逐项契约见 [scene 脚本运行时设计](../../../../docs/superpowers/specs/2026-09-22-scene-script-runtime-design.md) 与 [text 脚本运行时设计](../../../../docs/superpowers/specs/2026-09-20-text-script-runtime-design.md)。
