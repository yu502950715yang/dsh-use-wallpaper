# AGENT.md

本文件供 AI 编程助手快速了解 `dsh-use-wallpaper` 仓库。**改动代码前请通读本文件**，并查阅 `docs/superpowers/specs/` 下对应的设计文档。

**本文只写现状、硬约束与真遗留**（结论直给，§5 每条 ≤3 行）。历史根因、实验数据、一次性扫描结果、已修记录的完整版在 `docs/fixes/`（索引见 §8）—— **新内容不要往本文件里堆数据**；测试项数、全库计数这类会漂的数字一律不在此钉死，以 `npm test` / e2e 的实测输出为准。文中出现的「**全库 N 条 / N 张 / N 个对象**」都是**本机壁纸库的快照**（会随素材增减而漂移），只作量级与影响面参考，**不要据此推断代码行为**。§5.x / §7.x 的**编号多处被代码注释引用，不得重排**（§5.35 是历史空号）。

三句话版本：单包 DSH 插件；scene 壁纸由 **three.js 播放器**在浏览器实时渲染（粒子模拟复用 wasm CPU 模拟器），失败回退 preview 图；渲染语义以 **Wallpaper Engine（WE）** 为准，参考实现是 `research/open-wallpaper-engine`（C++）与 `research/.lwe`（linux-wallpaperengine），**WE 安装目录下的 shader 与材质是明文的**（`<WE>/assets/shaders`、`<WE>/assets/materials`）—— 遇语义疑问先读它们。

## 1. 项目概述

- **形态**：单包仓库，仓库根即插件 `@dsh-use/wallpaper-engine`（`package.json` 声明了 `dsh.bundle`，可直接 `dsh plugin add github:...`）。
- **能力**：扫描 Steam workshop 壁纸目录（默认 `D:/Steam/steamapps/workshop/content/431960`，可自动探测 —— 注册表 + `libraryfolders.vdf` + 常见路径，见 `src/host/steam-paths.ts` —— 或手动配置，settings 热更新），在 DSH Web GUI 里渲染 scene 壁纸 / 播放视频 / 加载 web 页，其余回退 preview 图 + Ken Burns。
- **入口**：DSH 设置对话框侧边栏「壁纸」菜单（client 经 `settings.section` slot 注册，见 `src/client/settings-section.tsx`）。
- **技术栈**：TypeScript strict、ESM-only；浏览器侧 three.js（WebGL2）+ Rust（wasm，**仅 CPU 粒子模拟**，已无 wgpu/WebGPU）；宿主侧 Cordis 插件体系。Node 版本无 `engines` 声明，CI 用 Node 22。
- **自带解包**：host 侧自行解析 **PKGV 容器**（magic `PKGV` 在 offset 4，`src/host/pkg-reader.ts` 只校验这 4 字节，版本字段未使用）与 **TEXV0005 纹理**（`src/client/tex-loader.ts`）；不依赖 WE 运行时。

## 2. 架构

### 2.1 scene 渲染路径

- **接线**：`index.ts` → `createThreeSceneRenderer()`（`three-renderer.ts`：拉 scene.json + 背景纹理 + 粒子条件 + 纹理材质）→ `loadSceneToThree()`（`threejs-player.ts`：正交 cover 相机 + 背景 mesh + 粒子 billboard）→ `setAnimationLoop` 每帧 `sim.update(dt)` 后刷新粒子缓冲。
- **对象级效果链**：同一入口下多走两步 —— 解析每个对象的 `effects`（`shader/effect-chain.ts` 的 `resolveEffectChain`）→ `ObjectEffectStage`（`object-effects.ts`）编排：隔离对象进 `localScene` + 主场景放合成 quad，每帧 `renderIsolatedContents()`（内容 → 对象 RT）→ `stage.bindOutputs()` → 渲染主场景 → `stage.advance(time)`。无带效果对象时 stage 为 null，帧序退化为 `fn → update → render`。
- **粒子模拟不重写**：复用 wasm 的 `CpuParticleSim`（纯 CPU，无需 WebGPU）；renderer 只把 `sim.vertices()` 的**每粒子 16 浮点**（`[pos3,size,uv2,color3,alpha,rot3,vel3]`，见 `threejs-player.ts` 的 `PARTICLE_FLOATS_PER_INSTANCE`）画成 billboard。
- **失败重试**：`wallpaper-controller.ts` 在 `render()` 返回 false 后用**新 canvas** 重试一次（防 WebGL 上下文污染），仍失败才落 preview。
- **生命周期**：DSH 会在客户端 bundle 重建时**重新执行 bundle 并重挂载插件** —— 挂载必须幂等、必须有收尾（§5.43）。
- **唯一路径**：three.js 播放器是 scene 的**唯一**渲染路径。`wasm-renderer.ts` / `scene-renderer.ts` / `alignment.ts` / `scene-script.ts` / `shader/glsl-to-naga.ts` 与 Rust 侧 `wasm/src/render/**`、`wasm/shaders/` 已于 2026-09-22 整体删除（连带 `isThreeUse()` / `THREE_USE`）。

### 2.2 host / client / shared 分层

- `src/host/`：Node 侧（Cordis 插件）。`scanner.ts` 扫描目录 → `WallpaperInfo`；`steam-paths.ts` 目录探测（`/wallpapers/probe`）；`pkg-reader.ts` 解包 PKGV；`routes.ts` HTTP 路由（每次请求读实时目录，settings 热更新）；`settings.ts` 插件设置（双路径，见 §5.34）。
- `src/client/`：浏览器侧（esbuild → `dist/client.js`，external react 等 DSH 共享模块）。主路径：`index.ts`（bootstrap + `window.__wallpaperEngine` + 注册设置菜单）、`wallpaper-controller.ts`（选择/竞态/回退链）、`three-renderer.ts` + `threejs-player.ts`（渲染）、`object-effects.ts` + `object-range.ts` + `effect-runner.ts` + `effect-graph.ts`（对象级效果链）、`rt-render.ts`（「渲染进 RT」的唯一入口，透明清屏不变量落在这里）、`tex-loader.ts`（TEXV0005 解码）、`scene-json.ts` / `scene-graph.ts` / `visibility.ts`、`text-object.ts` + `text-script.ts` + `scene-script-vm.ts` + `scene-script-host.ts` + `scene-anim.ts` + `layer-state.ts` + `dynamic-mesh.ts`（text / 脚本 / 动态网格）、`glow-stage.ts`（应用级 Glow）、`audio-input.ts`、`background-layer.ts` / `settings.ts` / `styles.ts` / `settings-section.tsx`。
- `src/shared/`：跨 host/client 类型（`WallpaperInfo`、`SceneDescription`、`SceneObject` 等）。
- `src/client/shader/`：WE shader 方言转译层（`effect-chain.ts` 解析、`shader-preprocessor.ts` 预处理、`uniform-binder.ts`、`we-headers.ts`）。

### 2.3 坐标与对象变换约定（**勿再翻转 / 勿漏乘**）

- **WE 场景系 = 左下原点、y 向上**；three 正交相机 = 中心原点、y 向上。映射：`three = we − viewport/2`，**y 不翻转**。历史事故：曾用 `vh/2 − oy`，导致非居中对象上下镜像。新代码不得引入 y 翻转或 `scale.y` 取负。
- **对象 model matrix = T·R·S**；其中 `angles` 是**弧度**（OWE `SceneNode.cpp:15`），旋转顺序 **R = Rz·Ry·Rx**（OWE `ParticleRuntime.cpp:25-28`）。
- 粒子世界坐标：`worldPos = objCenter + R(angles) · (scale ⊙ (emitterOrigin + local))`（`threejs-player.ts` 的 `PARTICLE_VERTEX_SHADER`）。
- 背景 mesh：`position / rotation / scale` 直接对应 T / R / S（three 的 `Object3D` 变换顺序本就是 T·R·S）。

## 3. 构建、测试与集成

### 3.1 常用命令

```bash
npm test                 # vitest run（node + jsdom 双环境；全量约 7s，基线为空）
npm run build            # tsc -p tsconfig.json → lib/（strict）
npm run build:wasm       # cd wasm && wasm-pack build --no-opt --target web --release --features cpu-sim → wasm/pkg/
npm run build:client     # esbuild → dist/client.js，并把 wasm/pkg/ 复制到 dist/static/
npm run e2e:colorblend   # 渲染 e2e：colorBlendMode 逐像素判据（零本机素材依赖，可上 CI）
npm run e2e:card         # 计算样式 e2e：通知卡片与代码块同底（需本机 DSH 的 app.asar，不可上 CI）
npm run e2e:hidpi        # 渲染 e2e：dpr=1/2 的挂载期 RT 尺寸断言（需本机 WE 壁纸库）
npm run e2e:textclock    # 渲染 e2e：text 时钟层（魔兽之门 1922570576）是否真的画在画面上（需本机素材）
npm run e2e:compare      # A/B 截图逐像素对拍（零回归验收）
npx vitest run tests/xxx.test.ts --reporter=basic   # 跑单个文件
```

**铁律：改了 Rust 必须先 `build:wasm` 再 `build:client`** —— `build:client` 只把 `wasm/pkg/` 的现成产物复制到 `dist/static/`，顺序反了会复制旧 wasm；产物缺失时 `build:client` 直接报错。

### 3.2 集成到 DSH profile

- profile 用 **`link:` 符号链接**引用本包（在仓库根执行）：
  ```powershell
  dsh plugin --profile web add link:E:/code/dsh-use-wallpaper
  ```
  `dsh plugin` 会把本包追加进 `dsh.profile.bundles`（本包声明了 `dsh.bundle`），**不要**再手改 profile 的 `package.json` 或往 profile `cordis.patch.yml` 插条目（重复 insert 报 `duplicate loader entry id`）。`link:` 是符号链接而非快照复制，构建产物直接生效；若 `LinkType` 为空说明落成了实体副本，需手动复制产物。
- **client 侧改动（`dist/`）→ 自动热重载**：web 组合始终挂载 `@deepseek-ai/dsh-client-hmr`，host 半侧每 500ms stat 轮询各 client bundle（mtime/ctime/size），变化即 `clientModules.rebuilt(id)` 并经 SSE `/plugins/events` 推给浏览器，浏览器半侧**重新执行 bundle 并以全新状态重挂载插件**（旧 fiber 被 drain）⇒ 插件必须幂等挂载 + 正确收尾（§5.43）。
- **host 侧改动（`lib/`）→ 需重启 `dsh web`**：host 模块热重载在 dsh-base 里默认 disabled。
- **兜底**：HMR 未生效（SSE 断开 / 页面未打开 / 落成实体副本）时，把 `lib/`、`dist/` 复制进 profile 并重启 + 强刷。
- **设置位置**：DSH 0.1.7-alpha.1 起是 profile `cordis.patch.yml` 里条目 `dsh-wallpaper-engine` 的 `config`；≤0.1.6 是 `$DSH_HOME/settings.yaml`。**手工预置请写前者**（两版都读，见 §5.34）。
- `lib/` 与 `dist/` **纳入版本控制**（`.gitignore` 不含它们）；发布包 `files` = `lib` + `dist` + `cordis.patch.yml` ⇒ **提交与发布前两个产物都要是新的**。

### 3.3 验证手段

- **单测**：`tests/**/*.test.ts` 默认 node，`tests/dom/**` 走 jsdom（`vitest.config.ts`）；`scripts/known-failures.json` 是空的**新增失败**基线（CI 只对新增失败判红，见 §7.11）。
- **全库解析回归**：`tests/verify-real-library.test.ts`（全库 scene.pkg 的 scene.json / image 纹理 / particle 规格 / 效果链解析零失败）。**依赖本机壁纸库**，无库时 `skipIf` 跳过并告警 —— CI 上等于不跑。
- **端到端渲染（推荐）**：`e2e/`（自起 http server + headless Edge（自己 `spawn` + 手写裸 CDP，**不依赖 playwright**）+ esbuild 打包 harness，**用生产 `lib/`** 渲染真实素材并逐像素判定，**不依赖 DSH token**）。机器相关项一律走 `e2e/config.mjs`；判据失败**置非零退出码**（是 CI 门禁，不是日志）。
- **零回归对拍**：`npm run e2e:hidpi -- --tag=before` → 改动 → `--tag=after` → `npm run e2e:compare`。判据：最大差 ≤ 1 且「差≥2」像素为 0。
- **CI**：`.github/workflows/ci.yml`（tsc + `lib/`/`dist/client.js` 产物新鲜度守卫 / vitest 新增失败 / Windows 渲染 e2e）。已知失败基线在 `scripts/known-failures.json`。CI 的三个历史坑（动作运行时 Node24、runner 的 Edge、`pnpm-workspace.yaml` 需 `packages` 字段）与排查过程见 `docs/fixes/verification-ci-history.md`。
- **测试环境**：vitest / esbuild / headless Edge 都依赖 service 子进程，**受限沙箱下会失败**（见 §5.13）。

## 4. 目录

```
<repo root>                  # 仓库根即插件包（不是 monorepo）
  src/{host,client,shared}/  源码（client/shader/ 为 WE shader 方言层）
  wasm/                      Rust 引擎（wasm-bindgen；**只剩 CPU 粒子模拟**）
    src/{lib.rs,coords.rs,particle/}
    pkg/                     构建产物（gitignore；由 build:client 复制进 dist/static/）
    tests/                   Rust native 测试（cargo test，无需 wasm 目标）
  lib/                       tsc 产物（**入库**）
  dist/                      esbuild 产物 + dist/static/（wasm；**入库**）
  tests/                     单测；tests/dom/ 走 jsdom；tests/fixtures/ 真实素材 fixture
  e2e/                       端到端渲染验证（入库）：config.mjs 统一参数
    lib/ harness/ verify/    像素工具 / esbuild harness 入口 / 验收脚本
    fixtures/                零素材依赖的 fixture（clouds-dxt1.png）
    .out/                    运行产物（gitignore）
  scripts/                   build-client.mjs / check-known-failures.mjs / known-failures.json
  .github/workflows/ci.yml   CI：tsc + 产物新鲜度 / vitest 新增失败 / Windows 渲染 e2e
docs/superpowers/
  specs/                     设计文档（改动前必读）
  plans/                     实施计划与修复记录
docs/fixes/                  历史归档（§5/§7 的明细与已修记录，见 §8）
research/                    gitignore：截图 / 一次性探针 / 临时 profile（权威 e2e 已移入 e2e/）
  open-wallpaper-engine/     C++ 参考实现（语义对齐来源）
  .lwe/                      linux-wallpaperengine 源码（另一参考）
```

## 5. 硬约束（踩过的坑）

> 编号沿用历史（代码注释按 §5.x 引用，勿重排；§5.35 为空号）。每条只给结论与判据，**实测数据、推导与历史事故全文见 `docs/fixes/conventions-details.md` 的对应小节**。

1. **wasm 产物必须 `--target web`**：曾用 `--target module`（无默认导出 `__wbg_init`）导致 wasm 静默失败、一路回退。
2. **`research/`、`wasm/pkg/`、`dist/static/ptex-*.tex` 是 gitignore**；`lib/`、`dist/` 其余部分**必须提交**（见 §3.2）。
3. **对象 `angles`（弧度）必须应用**，否则局部朝向被当世界朝向。三个应用点：粒子顶点 shader、背景 `mesh.rotation`、util/text（字段解析保留，暂不做几何变换）。
4. **`turbulentvelocityrandom` = `forward` 绕 `normal` 旋转**（不是「沿 normal 偏移」）：方向恒在垂直 normal 的平面内。旧实现写成 `forward*cosθ + normal*sinθ*scale` ⇒ 速度进屏幕上不可见的 z 轴、粒子排成竖线（影响 9 张壁纸）。
5. **对象级 `instanceoverride`**（scene.json → 粒子）：`alpha/size/lifetime/speed` 是**乘数**，`color/colorn` 是**覆盖**（`UiColorToLinear` = v²，legacy `color` 先 /255），emitter rate **× `count`**；缺省恒等。JS 只透传原始 JSON，语义解析在 Rust。
6. **图像 `colorBlendMode`（→ shader combo `BLENDMODE`）不是 alpha 混合**，而是**额外追加一遍「读当前帧缓冲」的混合 pass**（WE 材质 `materials/util/effectpassthrough.json` / shader `genericimage3`；模式表在 WE 明文 `assets/shaders/common_blending.h`）。three 侧用**预乘片元** + `CustomBlending` 复刻；**未实现的模式回退普通 alpha 混合**（不静默画错）。全库非零的只有 3 个对象：`3743126786`=7、`2832263418`=6、`2460786246`=31。合成侧的三个约束见 §5.25/§5.26。
7. **粒子 alpha 属性链**：透明度 = 生命周期衰减 × alpha（`alpharandom` 等经属性链传入），JS ShaderMaterial 与 wasm 粒子层**双路径同语义**；改 alpha 相关逻辑要双路径验证。
8. **场景资源禁止浏览器缓存**：`/wallpapers/scene/<id>/asset` 返回 `Cache-Control: no-store`，改资源无需清缓存。
9. （**已作废**）wasm 效果链的 GLSL→SPIR-V→WGSL 卡点：整条链路与依赖**已随未接入的 WebGPU 渲染器删除**，主路径效果链走 three 的 GLSL 路径，与本条无关。
10. （**已作废**）对象级效果链管线的 **wasm 备用路径**（`wasm/src/render/**`）已随 §2.1 的删除一并移除；`OBJECT_RT_MAX = 4096` 这条事实已并入 §5.15/§5.21。现存唯一路径见 §2.1。
11. **效果链的一切编译/建管线必须在加载时一次性完成**（`resolveEffectChain` / `EffectRunner` 创建 / 探针编译）；`render_frame` / `render_object_effects` / `step` / `bindOutputs` / `advance` **不得**在帧内做编译或建管线（每帧只写 uniform + 建 bind group + 提交 pass）。
12. **音频管线**：`createAudioAnalyzer` 频谱 → EffectRunner 音频 uniform + visualizer 条高；壁纸 `sound` 数组经 `playWallpaperSound` 接入（autoplay 被拦时 context suspended、可视化全零，用户手势后恢复）；无 Web Audio → 全零静音；切壁纸必须 `context.close()`。
13. **测试沙箱**：vitest / esbuild 依赖 service 子进程（命名管道），受限沙箱下报 `spawn EPERM`；同一条限制也让 **headless Edge 起不来**（mojo 平台通道 `拒绝访问`）⇒ **单测与端到端验收都必须完整权限**（别误判成 flag 或 Edge 装坏了）。
14. **WE 内置纹理走 host 路由，不随包分发**：粒子/效果材质引用的 `particle/*`、`util/*` 等是 WE 的第三方素材，client 请求 `/wallpapers/particle-texture?name=<相对 assets/materials 的路径>`（可带 `id`），host **先在壁纸 `scene.pkg` 的 `materials/<name>.tex` 找、再回退 `<weAssetsDir>/assets/materials`**（顺序对齐 WE 挂载顺序）。`name` 是原始相对路径，**不能无条件加 `particle/` 前缀**；`util/*` 效果纹理也走同一路由（**不得**把 `util/noise` 与 `util/clouds_256` 映射成同一张程序化噪声）。普通 scene 素材（`fonts/*.ttf` 等）同样「pkg → 引擎 assets」两级查找。
15. **对象级 RT 的三条不变量**：① **局部正交相机的 left/right/top/bottom 是「世界坐标范围」**，必须覆盖**完整对象世界尺寸**（拿 RT 像素当范围 ⇒ HiDPI 下对象缩小 + 边缘 clamp 拉伸；按 4096 钳制范围 ⇒ 边缘拉伸带，超限对象的正确代价是「分辨率低」而非几何裁剪）；② **RT 像素尺寸 ≥ 屏占位**（**屏占位 = |未钳制世界尺寸| × 屏幕密度**；目标长边 = `max(屏占位, min(源纹理长边, 4096))`，**软预算 `budgetScale` 可把它压到两者之间**，见 §7.36①；单一等比收口 4096、**只升不降**；源纹理比屏占位小的对象保持屏占位，粒子 / 源尺寸未知的对象走 `object-range.objectRtSize` 的屏占位口径，见 `object-range.isolatedRtSize`）—— 密度 = 画布缓冲宽 / cover 视锥宽（`object-range.screenScalePx`），**mount 与 resize 必须同源**，基准必须是**未钳制**的世界尺寸；③ **`isolate` 的键是 `scene.json` 的对象 id**（不是图层计数器），`isolatedObjects()` / `setObjectOutput()` / `resizeObjectRT()` 同一把键。
16. **效果纹理槽编号 + sampler `combo` 派生**：**`textures[i] → g_Texture(i)`**（不是 `i+1`）；sampler 声明带 `"combo":"X"` 时，该槽被绑定即置 `X = 1`（`scene.json` 的 `pass.combos` 显式值优先，必须在 `preprocessWeShader` **之前**）。两者写错会让**所有效果的纹理槽整体错位**或 mask 分支永不启用（效果全图生效）。
17. **`g_TextureNResolution` 四分量一律同值（= mip0 记录尺寸）**；效果 shader 用 `.z/.x` 缩放遮罩 UV，比值必须为 1。插件**不按 `.tex` 头做 padding 分配**，故**填头里的分配尺寸**会让 NPOT 纹理的遮罩按 分配/内容 挤向画面左上（真机：湖水波动跑到树上）。⚠️ **唯一代码层例外**：`cropToMap` 对 `flags & 4`（sprite）**刻意不裁剪**（`tex-loader.ts:285`）⇒ 若将来出现「raw 像素载荷 + sprite 位 + header padding」的纹理，`.z/.x = 1` 对它不再成立（本机库 0 实例）。细节见 `docs/fixes/conventions-details.md`。
18. **R8 / RG88 有两套通道语义，不能混用**（`convertUnormToRgba(data, format, alphaPriority)`）：缺省 `true` = **粒子纹理**语义（形状/覆盖在 R 或 G 通道）；`false` = **效果纹理槽**语义（shader 直接读 `.r`/`.rg` 当遮罩数值）。**待办**：权威来源应是 `.tex` 头的 `TextureFlags_AlphaChannelPriority`（bit19），现由调用方路径推断。
19. **`.tex` 的 flags 必须被消费**：`ClampUVs = 2`（bit1）→ WE 默认 **REPEAT**、仅带此位才 CLAMP（曾一律 clamp ⇒ `clouds` 整屏偏白且越来越白）；**待办**：`NoInterpolation = 1`（bit0）应 `NearestFilter`、`ClampUVsBorder = 8`（bit3）语义未验证。⚠️ **RT 纹理必须保持 CLAMP**（别在别处一律改成 repeat）。
20. **纹理 v 轴约定**：WE 是 `v=0` = 图像顶部；显示路径翻行序后画面正确但**效果 shader 里的 v 语义与 WE 相反**（带符号方向量整体反向）。修法是**窄修**：只在效果链一侧按 WE 约定加载（`rowOrder` + 注入 topDown 加载器），并用「隔离局部相机 y 镜像 + 合成 quad `flipGeometryUvY`」抵消 —— **不要做全量迁移**（要改 4~8 个显示采样点，漏一处就是整图上下颠倒）。
21. **对象 RT 的尺寸口径 = 屏占位**（详见 §5.15 ②）：旧口径把「预算」当基准，与屏占位差 0.8% ⇒ 合成那一步的双线性 + 亚纹素漂移让**整层锐度 −52%**（实测 Laplacian 713 → 342）。密度必须与主相机 cover 同源、mount 与 resize 同源。
22. **渲染进 RenderTarget 必须「透明清屏」（clearAlpha = 0）**：three 的清屏 alpha 由 `WebGLRenderer({alpha})` 决定，主路径 `alpha` 缺省 false ⇒ **每个 RT 都被清成不透明黑**，效果降 alpha 处（opacity/mask）贴回主场景就是整片黑块（`2911105183` 实测黑像素 31.1% → 0.7%）。落点是 `src/client/rt-render.ts` 的唯一入口。**刻意不改 renderer 的 `alpha` 参数**（那是另一种可见行为变更）。
23. **WE 视频纹理（`flags` bit5 = Video）**：`.tex` 的 mip0 载荷是完整 mp4，交浏览器原生解码（`tex-loader.videoTextureFromMp4`，必须排在编码图像与原始像素两条分支**之前**）；判定要 `flags & 32` **且** mip0 前 8 字节是 mp4 的第一个 box。约束：**静音自动播放**、**不进 mip 链**（`generateMipmaps=false`）、**生命周期不归 GPU 管**（清理挂在纹理 `dispose` 事件上：pause + 清 `src` + `revokeObjectURL`）。不可播时返回 **1×1 透明纹理** + 可辨识 `console.warn`（不是 null）。
24. **uniform 注解里的嵌套对象必须完整解析**：非贪婪 `\{[\s\S]*?\}` 遇到内层 `}`（WE 注解普遍带 `"require":{...}`）会截断 ⇒ 注解整体丢失 ⇒ uniform 全零（`3303428996` 整屏黑）。要抓到行尾再用 `takeBalancedJson` 配对花括号。
25. **效果 pass 的 `blending: "normal"` = 覆盖（`ONE/ZERO`）**，不是 alpha 混合（lwe `CPass.cpp::setupRenderFramebuffer`）：`Normal`/未知 → `NoBlending`，`Additive` → Additive，`Translucent` → Normal。写成 three 的 `NormalBlending` 会让 rgb 每过一个 pass 再乘一次自身 alpha ⇒ 半透明图层逐级趋零（GTR 云消失）。
26. **`colorBlendMode ∈ {6,7,31}` 的合成 quad 必须把图层 alpha 预乘进 rgb**：`colorBlendMode` 语义是 `mix(A, Blend(A,B), opacity)`，而 Screen(7)/31/6 的颜色因子**都不看 alpha** ⇒ 不预乘就是全强度盖住画面（GTR「云挡住人物」）。内容侧已改普通 alpha 写入（混合语义整体移到合成 quad）。
27. **GTR 云亮度 vs 桌面 WE 的差异来自「应用级后处理」**（WE `config.json` 的 `general.user.postprocessing`，作用于整帧、不属于任何壁纸字段）—— 插件**已实现**（`glow-stage.ts`，缺省 `0.65/0.35`）且只覆盖 **scene** 壁纸。⚠️ 壁纸级 `general.bloom`（全库 3 张）**仍未实现**。
28. **具名 RT 图链的执行语义（P2）**：加载期由 `buildEffectPlan`（`effect-graph.ts`）编译成静态计划，`EffectRunner.setPlan` 建**具名 RT 池**；帧内只查表绑槽 + 提交 pass。要点：`bind.index` = `g_Texture<index>` 且 `bind` 优先于 `textures`；**`previous` = 进入 target 序列前的输入**（不是上一 pass 输出）；具名 RT = 对象 RT ÷ `fbos.scale`，**池作用域 = 单条链**；**写具名 RT 的 pass 编译失败 ⇒ 整条计划放弃**（回退对象 RT 原图）；引用链内不存在的 `_rt_*` 保持默认不绑白纹 + 去重告警；effect 级 `visible === false` 整条不挂链（作者正常内容，不打降级告警）。
29. **combo 宏必须跨 stage 合并**（`effect-chain.ts` 在两次 `preprocessWeShader` **之前**合并 vert/frag 两侧的 `[COMBO]` 默认值）：一侧从默认值取到 `NOISE 1`、另一侧被 `#if` 裸标识符兜底成 `0` ⇒ frag 引用 vert 未声明的 varying ⇒ **program 链接失败**（链接错误不在 shader info log 里）。**不要只特判某个宏**。
30. **web 壁纸 iframe 必须「与自身资源同源 + 与宿主跨源」**：`sandbox="allow-scripts"`（无 `allow-same-origin`）是 opaque origin，壁纸**自己的** img/video 也算跨源 ⇒ WebGL `texImage2D` 抛 SecurityError、画面空白。承载 origin 优先级（`planWebFrameOrigin`）：**桌面壳公布的宿主 HTTP origin**（`globalThis.__DSH_TRANSPORT__.streamBaseUrl`，不探活）→ **回环页换另一回环主机名 + 探活** → 其余退回 opaque origin 兜底。
31. **`project.json` 的 `type` 大小写不定**（实测 `"Web"`/`"Scene"`）：`kindFromProjectJson` 必须 `trim().toLowerCase()` 再比较，否则掉进 `unknown`、只剩 preview 图兜底（`3778198228` 被放大 10 倍的根因）。
32. **应用级 Glow 的颜色空间在本仓库是「字节域恒等」⇒ 链内不做任何转换**：`threejs-player` 强制 `outputColorSpace = LinearSRGBColorSpace`，且全库纹理未标 `colorSpace` ⇒ 全链路字节域恒等；按 spec 原设计插 `toSrgb()` 就是**二次编码**（阈值语义整体偏移，表现为「几乎不发光」而不报错）。**先确认 `outputColorSpace` 与纹理 `colorSpace` 的实际取值，再决定要不要手工对齐。**
33. **纹理槽必须在探针渲染前预建进 `material.uniforms`**：`uniformsList` 只在换 program 时重算，而 1×1 编译探针会先把 program 定下来 ⇒ 探针之后补的条目**永不上传**（`godrays_combine` 整屏近黑的根因）。槽数 = `max(textures.length, g_TextureN 最大下标 + 1)`，声明来源 = `samplerNames ∪ samplerModes`。
34. **DSH 设置系统双路径**（兼容 ≤0.1.6 与 ≥0.1.7-alpha.1）：新版命名空间 = **profile 条目 id**（`dsh-wallpaper-engine`）、`Config` 必须挂在默认导出 `apply` 上、volatile 值要用 `config.get()` 解引用且**不得在 `apply` 里快照**；**不得静态 import `dsh-settings`**（`settingsNamespace` 已不在导出里 ⇒ 链接期 SyntaxError）；`.volatile()` 需 `schemastery ≥3.18.4`。client 侧按候选 ns 探测并记住命中项。
36. **右侧栏「常驻遮罩」是 0.1.7 改了收起方式**：半透明底规则必须加 `[data-sidebar-right-open]` 限定**并** `:not([data-sidebar-right-panel="fullscreen"])`，fullscreen 的底与 `z-index:15` 也要带 open 限定，且 **z-index 必须写 `:where()` 低具体度**（否则压掉旧版 DSH 自己的 40）。**底与 z-index 拆成两条规则、两种具体度。** jsdom 的 `:where()` 具体度不可信，要真机验证。
37. **浮层菜单的底要覆盖两个 token**：0.1.7 的 `--dsw-specific-menu` 与 rc.2 起 `MenuSurface` 实际读的 `--dsw-menu-surface-fill`（旧 token 在新版只是别名）—— **两个都要覆盖**（浅 `.92` / 深 `.94`，保留 DSH 的 backdrop-filter）。通用教训：DSH 把某类浮层的底从 token A 迁到 token B 时，可读性覆盖必须同时覆盖两个。
38. **可见性有两套判定，别混用**：`resolveVisibility`（**text** 用；`script` 绑定按 `value` 静态定论）与 `isStaticallyHidden`（**image/particle** 用；**`script` 恒不隐藏**，交给 `visible.script` 的运行时通道）。混用会让脚本控制的图层在装载期被永久剔掉。
39. **设置面板的 DOM 钩子与样式断言被测试锁定**（`tests/dom/settings-section.dom.test.tsx` + `tests/styles.test.ts`）：重排结构时必须保留 `.wss-thumb` / `.wss-thumb-title`（textContent 精确等于壁纸名）/ `.wss-cancel` / `.wss-refresh` / `.wss-probe` / `.wss-save-dirs` / `.wss-adopt[data-path]` / `.wss-candidate[data-kind]` / `.wss-dir-*` / `.wss-glow-*` / `.wss-quality` / `.wss-sound`（**不能**并进 `.wss-power`，后者恰好 2 个复选框）/ 首个 `.wss-glow-row` 文本为「光晕（立即生效）」，以及样式侧 `var(--dsw-alias-label-primary` / `var(--dsw-alias-border-l2` 的存在。
40. **web 壁纸 iframe 必须「先挂载 + 强制布局，再赋 `src`」**：跨源子帧是 OOPIF，未挂载时冷启动读到的视口是 **0**；而部分壁纸把 `innerWidth/Height` **快照**成画布尺寸 ⇒ 画面永远 0×0，只有 resize 重建 iframe 才显示。`appendWebFrame` 的顺序（appendChild → `getBoundingClientRect()` → `src`）**即修复本身，勿调换**。
41. **贴壁纸文字颜色可手动配置 + 可选描边**（`auto/white/black/custom` + 0–3 档）：手动档**跳过 preview 测光**直接下发；auto 档按**壁纸 id 缓存**最近一次测光结果（设置变更同步复用、`select` 强制重测）。⚠️ `text-shadow` **可继承**，实底区域（气泡 / 卡片 / 行内 code）必须显式 `text-shadow:none` 复位。
42. **通知卡片与代码块在深色主题下不同底**：DSH 的卡片底 token 在深色取 8% 白半透明 ⇒ 透出壁纸后与代码块不一致。修法：浅/深分支各把 `--dsw-alias-turn-trigger-bg(-hover)` 覆盖为 `var(--dsw-alias-markdown-code-block)`，卡内文字按实底口径复位；⚠️ token 覆盖必须写进**浅/深分支**（具体度），卡内文字复位必须带 `[class*="flowItem"]` 前缀（否则压不过消息列反色规则）。
43. **插件被重挂载（client-hmr 的 `rebuilt`）后必须只剩一份背景层**：旧 fiber 被 drain 后旧 DOM 不会被自动移除 ⇒ 每次重载叠一份 `.wp-background-layer`，两层 `z-index` 同为 0、DOM 序在后的**最老实例压在最上面**且再也不会收到 select（真机层数 9 ⇒ 「切壁纸怎么点都不换」）。约束：**凡是「插入 DOM / 起循环 / 开上下文」的挂载点都要同时具备幂等与收尾**（`ctx.effect` 收尾 + `mount()` 单例清理 + `window.__wpEngineTeardown` 跨模块实例交接）。

44. **满屏隔离对象关 MSAA（结构性无效）+ RT 纹理的采样参数必须 `dispose()` 才下发**：① 满屏背景隔离对象的 RT 内只有一张盖满的 quad、没有轮廓边 ⇒ `samples=0` 与 `4` **逐像素相同（MAD=0.0000）**，关掉它把省下的显存换成分辨率；非满屏对象（贴片 / 粒子 billboard）保留 `4`（有真实几何边，一个都不能被关）；② **RT 纹理的采样参数只在 `setupRenderTarget`（首次使用或 `dispose()` 之后）下发**，`texture.needsUpdate` 对 RT 纹理**无效** ⇒ 采样判定翻转（mipmap 开 / 关）时必须 `rt.dispose()`，否则新的 `minFilter` 到不了 GL，且 `generateMipmaps=true` 会**每帧白生成 mip**。A/B 实测表与 three 源码行号见 `docs/fixes/conventions-details.md` §5.44。

## 6. 工作约定

- 回复、注释、文档、**提交信息一律简体中文**；代码、命令、文件名、技术术语保留原文。
- 提交信息**从简**：标题一行 `type(scope): 中文标题`；正文可选，**最多 3 行**（改了什么 / 关键根因一句话 / 怎么验证）。**不贴实验数据、不复述推理、不列文件清单** —— 细节写进本文件与 `docs/`。
- **注释从简**：默认只写一行「是什么 / 为什么」，最多 2 行。**禁止**复述代码、罗列实验数据、贴多段推理。根因与实测数字写进本文件或 `docs/`；代码里只留**一句结论 + `AGENT.md §x.y` 指针**。例外：涉及「不改就会踩回去」的硬约束（坐标 / 行序 / 混合因子）可留 2-3 行，但仍要指向 §5。
- **壁纸目录只读（用户明令）**：Steam 工坊目录里是**用户自己的作品**，**不得修改其中任何文件**（含 CSS/JS/HTML）。发现壁纸侧缺陷（资源 404、脚本报错、文档溢出等）**只记录 + 报告**，由用户在创作源里改；修复只能落在**插件侧**。
- 实施前读 `docs/superpowers/specs/` 对应设计文档；重大变更走技能流程（brainstorming → 设计文档 → writing-plans → TDD）。
- 渲染 / 坐标 / 粒子 / 材质语义的改动：先写失败测试，改完跑相关 vitest + 必要时用 §3.3 的端到端渲染验证，最后把结论与遗留如实写进本文件。
- **如实标注**：能力未达成就在 §7 写明，不要宣称「全库支持」。**不要在本文件里钉会漂的数字**（测试项数、全库计数）；需要时给「怎么测」而不是「测出来是多少」。

## 7. 当前遗留（如实状态，勿虚标）

> 编号沿用历史（代码注释按 §7.x 引用，勿重排）。**已修记录的完整版在 `docs/fixes/`**，这里只留「今天仍未达成 / 有明确边界」的条目。

> **编号沿用历史**（多处代码注释与 `docs/superpowers/` 按 §7.x 引用，勿重排）：**空号 = 该条已结案、记录已移入 `docs/fixes/`**（如 §7.2 起的各「已修」条目）。§7.30+ 是本次精简新增的续号。

1. **对象级效果链：执行器能力已覆盖，但有对象类型不挂链**：`text` 对象的 effects 在收链阶段就被跳过（`groupEffectsByObject`），`util` / 无媒体字段的对象拿不到隔离条目 ⇒ 全库有 **21 条** effects 永不挂链（util 10 + none 11，每张壁纸一条汇总 `warn`）；**text 的 effects 连 warn 都没有**。**粒子对象挂载 effects 全库为 0** ⇒ 粒子隔离分支只有单测覆盖、无真实样本。端到端只逐像素验过少数样本，其余是分类学推断（详见 `docs/fixes/threejs-path-fixes.md`）。
3. **粒子自旋的轴序偏差**：本项目用 `Rz·Ry·Rx`，WE 的 `ComputeParticleTangents` 是 `Rz·Rx·Ry` ⇒ **仅多轴自旋**（全库 6 个对象）结果可能与桌面不同，**未与桌面逐像素对照**；z-only 时两种顺序逐像素等价。
10. **headless Edge 的 WebGPU 是 SwiftShader**（软件光栅化），非真实 GPU。**订正**：该结论**只对 WebGPU 成立** —— WebGL 加 `--use-angle=d3d11 --ignore-gpu-blocklist` 就能拿真 GPU（真机验收的代价只是一个 flag）。
11. **测试基线口径**：`scripts/known-failures.json` 的基线**为空**（CI 只对**新增**失败判红；套件级错误不豁免）。全库计数是**本机壁纸库的快照**、随素材漂移 ⇒ 测试只断言非空，**不要在文档里钉数字**（当前实测打印：线性 42 种 / 168 次，具名 RT 11 种 / 38 次，解析失败 0）。
12. **e2e harness 与真 GPU 的边界**：`verify-hidpi-object-rt.mjs` 已加「挂载期 RT 尺寸」断言（含独立 oracle 与变异验证），`verify-isolated-rt-sharpness.mjs` 再加结构性判据 + 锐度双判据（口径见 §5.44 与 `TESTING.md`），但**不覆盖「RT 尺寸对而贴屏映射错」**这一类缺陷；而实测到的「背景糊」根因是**分辨率不足**（RT 只有屏占位 1×），不是贴屏映射错。软件光栅化的性能数字**不能**替代真机 FPS。
16. **`{animation}` 的关键帧轨道播放未实现**：`{script,value}` / `{animation,value}` 形态已按 `value` 静态兜底，但 track/keyframe/mode/fps **全部未解析** ⇒ 轨道驱动的位移/缩放/旋转仍不生效；「新位置与桌面一致」未证实。
30. **应用级 Glow 的范围边界**：只覆盖 **scene** 壁纸（且只测过 GTR 一张），而 WE 的 postprocessing 对 video 也生效 ⇒ **video / image / web 的亮部仍与桌面有差**；开启时 base RT **无 MSAA**（整帧从 canvas 的 `antialias:true` 掉到无 MSAA）；性能门槛（1080p FPS ≥ 30）**未在真机严格验证**（缺 GPU 耗时或有头浏览器帧率）；壁纸级 `general.bloom` **未实现**（全库 3 张：`2454403969`、`2937346640`、`3790775478`）。
31. **`copybackground` 语义未实现**（读背景副本做倒影/涟漪的场景会缺内容）；`_rt_FullFrameBuffer`（当前帧缓冲）不绑白纹、只打去重降级告警（全库 1 处 `2597392171`）；**`colorBlendMode` 只实现 6/7/31**，其余模式回退普通 alpha 混合。
32. **web 壁纸的 resize 与失败回退**：跨源 iframe 拿不到子帧错误 ⇒ **无失败回退**（渲染失败停在空白而非 preview 图）；resize 靠**重建 iframe** ⇒ 跨屏拖动导致的 **dpr 变化不触发重建**，且重建会让壁纸动画从头开始（跨源探测不到壁纸是否快照了视口，故统一重建）。
33. **非回环且非桌面壳的访问仍退回 opaque origin 沙箱**：局域网 IP / 隧道访问 GUI 时既无回环名也无 `__DSH_TRANSPORT__` ⇒ 依赖 WebGL 贴图的 web 壁纸空白（纯 DOM/CSS 的不受影响）。未做「另起端口」方案。
34. **DSH 旧版（≤0.1.6）适配层待删**：0.1.7 起设置系统与右侧栏行为都变了，插件因此并存两套代码与样式。**判据**：README 声明的最低 DSH 版本 ≥ `0.1.7-alpha.1`（目前 README 只声明兼容三版），且本机与 CI 都不再跑旧版验收；清理清单见 `docs/superpowers/plans/2026-09-23-dsh-settings-compat-migration.md` §9。
35. **壁纸侧的已知缺陷（不修，仅记录）**：`3789244610` 自身的 `city.jpg` 404、空 `<nav>` 让脚本抛 TypeError、文档溢出（见 §5.40 与 `docs/fixes/web-wallpaper-history.md`）；`3778198228` 给 video 写死 `object-fit:cover`（宽于 16:9 时裁掉约 15%）。

36. **隔离对象 RT 分辨率的已知边界**：① 显存预算是**软保证** —— 预算小到装不下全部屏占位时无法再降，只能保住「只升不降」；② 预算只覆盖 **image** 隔离对象：挂载期输入只含 image，resize 期同一函数按 `entries` 计入了粒子的屏占位 ⇒ 两期输入集合不同（粒子 RT 恒为屏占位）；③ 视频纹理**未就绪时回退屏占位**，不做「就绪后重设 RT」；④ 精灵表按**源尺寸未知**处理（回退屏占位）；⑤ e2e 锐度判据的样本里粒子 / 精灵表对象**各 0 个**（判据无真实样本）；⑥ 锐度判据余量偏薄（逐块中位数最低约 **1.11**，阈值 1.05）。详见 `docs/superpowers/specs/2026-10-12-isolated-object-rt-resolution-design.md` §5 与「实测（实现后）」，脚本用法见 `TESTING.md`。

37. **`g_TextureNResolution` 只保证「四分量同值 ⇒ `.z/.x` 为 1」，不保证取到实际上传尺寸**：原始像素载荷类（`mip0 记录 == 分配`）上传前经 `cropToMap` 裁到 image 尺寸，故其 `.x/.y` 与真实纹理尺寸仍差约 1.6×，凡把 `.x/.y` / `.z/.w` 当 texel 步长用的用法仍偏小。要彻底对齐需让 `fxRes` 等于各分支最终上传尺寸（独立行为变更，需单独 A/B 验证）。细节与审计口径（**库级真值在 §3–§4**，含 `type` 大小写不敏感的定域）见 `docs/superpowers/specs/2026-10-12-mask-uv-npot-design.md`，follow-up 与边界见该文档 §7。另：合并本分支**本身不改变运行时行为**，须重建 `lib/`、`dist/` 并真机复看才算修复生效（见该文档 §9）。

## 8. 历史归档

| 位置 | 内容 |
|---|---|
| `docs/fixes/conventions-details.md` | **§5 全部条目的原文**（含实测数据、推导、历史事故）—— 本文件 §5.x 的指针目标 |
| `docs/fixes/threejs-path-fixes.md` | §7 组一的完整记录（three.js 主路径的修复过程、效果链验收表、Glow 标定、显存与性能实测） |
| `docs/fixes/web-wallpaper-history.md` | web 壁纸的定位过程与已修记录 |
| `docs/fixes/verification-ci-history.md` | 验证手段、CI 三个坑、测试基线的历史记录 + 精简前的 §3.3 长段 |
| `docs/superpowers/specs/`、`docs/superpowers/plans/` | 各轮设计文档与实施计划（**改动前必读**） |
| git 历史（`AGENT.md` 的上一个版本） | 精简前含 §1–§4 / §6 旧措辞的完整文档 |

归档文件只作查阅：**新的结论、边界与遗留写回本文件的 §5 / §7**，不要往归档文件里追加。
