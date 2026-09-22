# 移除未接入渲染路径设计（2026-09-22）

## 1. 背景与目标

`index.ts:4-5` import 了 `renderScene` / `createWasmSceneRenderer` / `createFallbackSceneRenderer`，**全文 161 行内从未调用**（运行时唯一路径是 `createThreeSceneRenderer()`，`index.ts:38`）。这两条备用路径（wasm/WebGPU、JS/WebGL）自 v0.3.0 起只保留源码与单测，当前是**纯负债**：

- 占 `src/client` 约 18% 的代码量，且 13/15 项既有失败测试出自它们。
- 维护时每次语义改动都要判断「要不要同步改备用路径」（`AGENT.md` 多处记录了这个负担）。
- 让 `@webgpu/glslang` 这个 922 KB wasm 与一整段 Emscripten 打包机制常驻依赖与产物。

**初始估算（「删 2 个文件 = 1358 行」）是错的**：可达性分析显示 8 个 export 仍被主路径使用，必须迁移；实际可删面约 8000 行（TS ~2400 + Rust ~5500）。

## 2. 现状证据（逐导出可达性）

### 2.1 必须迁移的 8 个活 export

| export | 现状位置 | 主路径消费者 | 新家 |
|---|---|---|---|
| `resolveTexPath` | `scene-renderer.ts:579-583` | `three-renderer.ts:26,608` | `scene-assets.ts` |
| `resolveImageTexture` | `scene-renderer.ts:588-604` | `three-renderer.ts:26,341` | `scene-assets.ts` |
| `resolveParticleMaterial` + `PARTICLE_TEX_ALIASES` + `ParticleMaterialRef` | `wasm-renderer.ts:357-410` | `three-renderer.ts:28,350` | `scene-assets.ts` |
| `defaultLoadWasm`（含 `STATIC_BASE`/`WASM_GLUE_FILE`/`WASM_BIN_FILE`） | `wasm-renderer.ts:297-319` | `three-renderer.ts:28,211` | `three-renderer.ts` |
| `LoadWasm` / `WasmSceneModule` | `wasm-renderer.ts:247` / `:242` | `three-renderer.ts:29,208` / `:29,61,214` | `three-renderer.ts` |
| `SceneRendererLike` | `wasm-renderer.ts:250-260` | `three-renderer.ts:29,210` | `wallpaper-controller.ts`（L10-13 已内联同形状结构类型） |

`lz4js.d.ts` **必须保留**（`tex-loader.ts:2` 在用，且被 tsc include）。

### 2.2 整文件死代码

| 文件 | 行数 | 依据 |
|---|---|---|
| `src/client/shader/glsl-to-naga.ts` | 756 | 唯一 src 消费者是死掉的 `createWasmSceneRenderer`（`wasm-renderer.ts:9`） |
| `src/client/scene-script.ts` | 356 | 只被 `wasm-renderer.ts:7` 用；主路径走的是**另一套** `scene-script-vm.ts` |
| `src/client/alignment.ts` | 55 | `applyAlignment` 两个调用点（`scene-renderer.ts:33`、`wasm-renderer.ts:5`）都在待删文件里 |
| `src/client/scene-renderer.ts` | 732 → 保留 ~62 | 除 2.1 的两个函数外全死 |
| `src/client/wasm-renderer.ts` | 675 → 保留 ~0 | 除 2.1 的 5 个 export 外全死 |
| `object-range.ts:195-203` `containRange` | 9 | 无人引用（连测试都没有） |
| `index.ts:20-26` `isThreeUse()` | 7 | 定义后从未调用 |

### 2.3 连带收益

`@webgpu/glslang` 全仓唯一消费者是 `glsl-to-naga.ts:21` ⇒ 可删：`package.json` 依赖、`scripts/build-client.mjs:36-90`（alias + `glslang-web-patch` 插件）、`:125-135`（wasm 复制）、`dist/static/glslang.wasm`（**922 KB，已入库**）、bundle 内 Emscripten glue。

### 2.4 Rust 侧

| 只服务 WebGPU 渲染器 | 行数 |
|---|---|
| `wasm/src/render/{mod,effect,particle_pass,particle_render,effect_pass,texture,camera}.rs` | 4212 |
| `wasm/src/shaders/*.wgsl` | 474 |
| `wasm/src/lib.rs` 的 `WeScene` 段 + `init_wasm_runtime` | ~252 |
| `wasm/src/scene.rs` / `wasm/src/tex.rs` | 119 / 449 |

**主路径仍在用、必须保留**：`particle/{mod,sim,spec_to_emitter}.rs`（2570 行，`CpuParticleSim` 依赖）、`coords.rs` 的 `we_to_three`、`lib.rs:262-339` 的 `CpuParticleSim`。

**关键约束**：`CpuParticleSim` 被 `#[cfg(feature = "render")]` 门控（`lib.rs:275`），因为它要 `js-sys`（`lib.rs:335-338`）⇒ **`render` feature 不能删**，只能瘦成 `["dep:js-sys"]` 并改名为 `cpu-sim`（名字要诚实），同步 `package.json:21`、`scripts/build-client.mjs:114` 的提示文案。

## 3. 方案与阶段划分

### A1 迁移（无行为变更）
8 个活 export 搬新家，改 `three-renderer.ts` 的 import 与 `tests/three-renderer.test.ts` 的 `vi.mock` 目标。

**最费工处**：`defaultLoadWasm` 搬进 `three-renderer.ts` 本体后**不能再 mock 被测模块自己**，约 60 处 mock 调用点须改走 `createThreeSceneRenderer({ loadWasm })` 注入口（`three-renderer.ts:206` 已有该口子）。

### A2 删 TS
删 5 个文件 + `index.ts:4-5` + `isThreeUse()` + `containRange`；删 6 个纯死测试文件。

`tests/scene-renderer.test.ts` **改 import 到 `object-range.js` 并保留**——它是那 6 项既有失败的唯一位置，整删等于掩盖。`tests/object-range.test.ts:193-202` 的「同一函数对象」断言（锁定的就是待删 shim）必删。

### A3 删 Rust
删 `render/**` + `shaders/*.wgsl` + `WeScene` + `scene.rs`/`tex.rs`（连带去 `wgpu`/`web-sys`/`wasm-bindgen-futures`/`console_error_panic_hook`/`naga`/`spirv-webgpu-transform`/`lz4_flex`/`png`/`jpeg-decoder`）；`render` feature 瘦身改名；删 16 个 `render::` 相关 `wasm/tests/*.rs`。

### A4 构建 / 产物 / 文档
删 glslang 机制与 `dist/static/glslang.wasm`；**手工清 `lib/` 的 10 个陈旧产物**（tsc 不清理，而 `package.json:80-84 files: ["lib","dist"]` 会把它们发到 npm）；重建 `lib/` + `dist/`；回写 `AGENT.md` §2.1/§2.2/§3/§7 与 `docs/technical-notes.md` §5。

## 4. 已拍板的决策

| # | 决策 | 结论 |
|---|---|---|
| 1 | `alignment.ts` 去留 | **删**（three 主路径确实未实现 WE alignment，`threejs-player.ts:1599-1605` 明说 origin 直传） |
| 2 | Rust `scene.rs`/`tex.rs` 去留 | **删**（JS 侧 `tex-loader.ts` 自己解码 TEXV0005） |
| 3 | `render` feature | **改名 `cpu-sim`** 并瘦成只留 `dep:js-sys` |
| 4 | 那 6 项陈旧断言（期望 2048 / 实现 4096） | **修成 4096**，不删用例 |
| 5 | fixture `clouds-dxt1.png` | **入库**（壁纸包内派生图，非引擎素材） |

## 5. 验收口径

- `npm run build`（tsc strict）通过。
- `npx vitest run` 失败数 **15 → 8**，且 8 项**身份逐项不变、零新增**：
  - `tests/scene-renderer.test.ts` 6 项（陈旧 2048 期望，**目标是随决策 4 一并修成 4096 后归零**）
  - `tests/verify-real-library.test.ts` 1 项（素材漂移 `expected 130 to be 129`）
  - `tests/dom/bootstrap.dom.test.ts` 1 项（I1）
- `cargo test`（native）通过。
- `npm run build:wasm` + `npm run build:client` 通过。
- `git status` 无陈旧 `lib/` 产物残留。
- **端到端零回归**：A 前后用 B1 harness 对 `3743126786`（GTR）与 `2683211654` 逐像素对拍，变化须落在帧间噪声地板内。

## 6. 已知边界（如实）

- Rust 侧未编译验证：feature 瘦身后 `js-sys` 是否足矣、删 `render/` 后 14 个 wasm 测试是否纯死代码、wasm 体积下降幅度 —— 均**待 A3 实测**。
- `tests/three-renderer.test.ts` 约 60 处 mock 调用点是否全部可改用 `opts.loadWasm` 注入 —— 只抽读，**未逐行验证**。
- `dist/` 重建依赖 `wasm/pkg/`（gitignore）与 Rust 工具链，本机是否具备**未检查**。
- 删掉备用 WebGPU 路径后，若将来要恢复须从 git 历史取回；本设计以「主路径已是唯一路径」为前提。
