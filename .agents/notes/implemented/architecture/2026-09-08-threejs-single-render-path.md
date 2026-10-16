# Agent Note: three.js 是 scene 的唯一渲染路径

Status: implemented

## Problem

scene 壁纸要「在网页里尽量接近 Windows 上的 Wallpaper Engine」。早期路线是在 wasm 里**逐像素复刻 WE 的粒子渲染器**（对着 linux-wallpaperengine 逐行对齐），结果是：粒子仍然不对，且 15 项失败测试里 13 项出自这条路径。根因不是实现不够努力 —— **WE 是闭源的完整渲染器**（材质、combo、后处理、RT 图），照着参考实现重写的工程量与最终相似度都无法预估，每加一个语义就要判断「备用路径要不要同步改」。

只要这一条路线还在，维护者就得同时维护两套渲染语义，且没有任何机制能证明其中一套是对的。

## Decision

scene 走 **three.js 播放器**，且它是**唯一**渲染路径：把 WE 场景**转换成 three.js 可渲染内容**（数据映射），而不是重写 GPU 管线。

- **复用**解析与模拟：`scene-json.ts`（scene.json）、`scene-assets.ts`（纹理/粒子材质解析）、`tex-loader.ts`（TEXV0005 解码）、`coords.rs` 的 `we_to_three`、wasm 的 `CpuParticleSim`（纯 CPU 粒子模拟，`threejs-player.ts` 只把 `sim.vertices()` 的每粒子 16 浮点画成 billboard）。
- **新写**渲染层：`three-renderer.ts` + `threejs-player.ts`（正交 cover 相机 + 背景 mesh + 粒子 billboard + `setAnimationLoop`）。
- **备用路径整支删除**（2026-09-22，`3eea1c9`）：`wasm-renderer.ts` / `scene-renderer.ts` / `alignment.ts` / `scene-script.ts` / `shader/glsl-to-naga.ts` 与 Rust 侧 `wasm/src/render/**`、`wasm/shaders/` 全部移除（连带 `isThreeUse()` / `THREE_USE`），Rust `render` feature 改名 `cpu-sim` 并瘦成只留 `dep:js-sys`。
- 渲染失败不再"换备用渲染器"，而是**回退 preview 图 + Ken Burns**（`wallpaper-controller.ts` 用新 canvas 重试一次后落 preview）。

WE 语义疑问的权威来源随之固定为：**WE 安装目录下的明文 shader/材质**（`<WE>/assets/shaders`、`<WE>/assets/materials`）与 `research/open-wallpaper-engine`（C++）、`research/.lwe`（linux-wallpaperengine）。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `dcd28c1` `3eea1c9`

## Alternatives considered

**继续在 wasm/WebGPU 里复刻 WE 渲染器。** 它最强的理由是**能逐像素对齐 WE**：不受 three.js 引擎能力限制，`colorBlendMode`、后处理、RT 图都能按 WE 原语义实现，而映射到 three 必然要手工复刻（本仓库至今只实现 `colorBlendMode` 的 6/7/31，其余回退普通 alpha 混合）。不用它是因为：WE 闭源、复刻面（材质/combo/后处理/RT）无法封顶，且这条路径当时已是纯负债 —— 它占 `src/client` 约 18% 代码量，却从未被运行时调用。

**保留未接入的备用路径当"后备"。** 理由听起来合理：主路径出问题时有兜底。不用它是因为它**不是兜底**：`wasm-renderer.ts` / `scene-renderer.ts` 自 v0.3.0 起只保留源码与单测、运行时从不调用（`index.ts` 里 import 了却从不调用），真正的兜底是 preview 图回退链；留着的唯一效果是每次语义改动都要判断"备用路径要不要同步改"，以及让 922 KB 的 `@webgpu/glslang` 常驻产物。

**用 three.js 渲染，但同时保留 wasm 渲染器做对照验收。** 理由：双实现可以对拍，比单实现更可信。不用它是因为对拍无法自动判读 —— 唯一可信的判据是**与 WE 真机的截图逐像素对拍**，而这件事后来由 `e2e/` 的 harness 与 `npm run e2e:compare` 承担，不需要第二套渲染器。

## Consequences

**收益：** 渲染语义只有一处，改一处不必再问"另一套要不要改"；删掉约 10344 行（TS ~2400 + Rust ~5500 + WGSL）后，`we_scene_wasm_bg.wasm` 从 3108 KB 降到 161 KB；并且这次删除**端到端逐像素最大差为 0**（dpr=1/2 对拍），证明删的确实是死代码而非行为。

**代价：** 受 three.js 引擎能力约束 —— WE 的语义要手工翻译（`colorBlendMode` 只实现 6/7/31，应用级 Glow 要自己写 `glow-stage.ts`），做不到的只能如实记为遗留（`AGENT.md` §7）。另外删除是不可逆的行为选择：恢复备用路径要从 git 历史取回，删除前 HEAD = `65f759c`。

设计与逐导出的可达性证据见 [移除未接入渲染路径设计](../../../../docs/superpowers/specs/2026-09-22-remove-unwired-render-paths-design.md)、选型原文见 [WE 场景 → three.js 播放器设计](../../../../docs/superpowers/specs/2026-09-08-scene-threejs-player.md)。
