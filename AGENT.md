# AGENT.md

本文件供 AI 编程助手快速了解 `dsh-use-wallpaper` 仓库。**改动代码前请通读本文件**，并查阅 `docs/superpowers/specs/` 下对应的设计文档。

三句话版本：单包 DSH 插件；scene 壁纸由 **three.js 播放器**在浏览器实时渲染（粒子模拟复用 wasm CPU 模拟器），失败回退 preview 图；所有渲染语义以 **Wallpaper Engine（WE）** 为准，参考实现是 `research/open-wallpaper-engine`（C++）与 `research/.lwe`（linux-wallpaperengine），**WE 安装目录下的 shader 与材质是明文的**（`<WE>/assets/shaders`、`<WE>/assets/materials`）——遇语义疑问先读它们。

## 1. 项目概述

- **形态**：单包仓库，仓库根即插件 `@dsh-use/wallpaper-engine`（`package.json` 已声明 `dsh.bundle`，可直接 `dsh plugin add github:...`）。
- **能力**：扫描 Steam workshop 壁纸目录（默认 `D:/Steam/steamapps/workshop/content/431960`，可自动探测——注册表 + `libraryfolders.vdf` + 常见路径，见 `src/host/steam-paths.ts`——或手动配置，settings 热更新），在 DSH Web GUI 里渲染 scene 壁纸 / 播放视频 / 加载 web 页，其余回退 preview 图 + Ken Burns。
- **入口**：DSH 设置对话框侧边栏「壁纸」菜单（client 经 `settings.section` slot 注册，见 `src/client/settings-section.tsx`）。
- **技术栈**：Node ≥ 18、TypeScript strict、ESM-only；浏览器侧 three.js（WebGL）+ Rust/wgpu（wasm，仅粒子 CPU 模拟在用）；宿主侧 Cordis 插件体系。
- **不依赖 WE 运行时**：host 侧自行解包 `PKGV0001` 容器与 `TEXV0005` 纹理（`src/host/pkg-reader.ts`、`src/client/tex-loader.ts`）。

## 2. 架构

### 2.1 scene 渲染路径

```
scene 壁纸 ──► three.js 播放器（**唯一路径**，v0.3.0 起）
                 │  渲染失败 / 渲染出 0 个可见对象
                 ▼
             preview 图 + Ken Burns（永不白屏）
```

- **接线**：`index.ts` → `createThreeSceneRenderer()`（`three-renderer.ts`，拉 scene.json + 背景纹理 + 粒子条件 + 纹理材质）→ `loadSceneToThree()`（`threejs-player.ts`，正交 cover 相机 + 背景 mesh + 粒子 billboard）→ `setAnimationLoop` 每帧 `sim.update(dt)` 后刷新粒子缓冲。
- **对象级效果链（effects）的接线位置**（2026-09-14 起，P1）：同一入口下多走两步 —— `createThreeSceneRenderer()`（`three-renderer.ts`：解析每个对象的 `effects` → `resolveEffectChain`，算隔离尺寸 `resolveObjectRtSize`，装配 `ObjectEffectStage`）→ `loadSceneToThree()`（`threejs-player.ts`：隔离对象进 `localScene` + 主场景放合成 quad + 注入帧钩子）→ 每帧 `renderIsolatedContents()`（player 私有方法：内容 `setRenderTarget(objRT)` + `render(localScene, localCamera)`）→ `stage.bindOutputs()` → 渲染主场景（合成 quad 采样效果输出，链未就绪则采样对象 RT）→ `stage.advance(time)`（串行推进 `EffectRunner`，异步不阻塞本帧）。无带效果对象时 stage 为 null，帧序退化为原来的 `fn → update → render`（零回归）。达成与遗留见 §7.1。
- **粒子模拟不重写**：复用 wasm 里的 `CpuParticleSim`（Rust `particle::SceneParticleSim`，**纯 CPU，不需要 WebGPU**）。renderer 只负责把 `sim.vertices()` 的 10 浮点/粒子画成 billboard。
- **失败重试**：`wallpaper-controller.ts` 在 `render()` 返回 false 后用**新 canvas** 重试一次（防 WebGL/WebGPU context 污染），仍失败才落 preview。
- **未接入的路径**：`wasm-renderer.ts`（`createWasmSceneRenderer` / `createFallbackSceneRenderer`）与 `scene-renderer.ts` 的 `renderScene` **源码与单测保留，但运行时不再调用**（`index.ts` 仍 import wasm-renderer 但未使用）。wasm 渲染器有**完整的对象效果链**（对象 RT + 局部正交相机 + `EffectChain` ping-pong + 合成 quad UV 窗口 + GLSL→SPIR-V→WGSL 编译链）；three 路径**已接通对象级效果链（P1，2026-09-14）**并**支持具名 RT 图链（P2，2026-09-15）** —— blur / blurprecise / godrays / bloom / shine / localcontrast / bokeh_blur（全库 **24 条**）与线性链由**同一执行器**按计划执行（`effect-graph.ts` 的 `buildEffectPlan` + `EffectRunner.setPlan`）—— 这句说的是**执行器能力**：24 条的**模板均已覆盖**，**不等于 24 条都在画面上生效**（其中 10 条不挂链，见 §7.1）。**与 wasm 侧的能力差已消除**（语义见 §5.28，达成与遗留见 §7.1）。**计数口径**：`106 线性 + 24 RT`（130 条效果引用）是**声明口径**（按 effect 链数、不过滤 `visible`），其中 1 条线性链的 effect 级 `visible=false` 在生产侧整条跳过 ⇒ three 的**执行口径 = 105 线性 + 24 RT**。wasm 备用路径**有**完整的对象效果链，但其 RT 图执行的 `bind` 索引语义与 lwe 不符（`bind[0] → g_Texture1`；lwe 是 `bind.index → g_Texture<index>`），未接入运行时、本次未改（见 §7「备用 wasm / JS 路径」第 8 条）。
- `isThreeUse()` / `THREE_USE=1` 是历史遗留（three 早已是默认）。

### 2.2 host / client / shared 分层

- `src/host/`：Node 侧（Cordis 插件）。`scanner.ts` 扫描目录 → `WallpaperInfo`；`steam-paths.ts` 目录探测（`/wallpapers/probe`）；`pkg-reader.ts` 解包 PKGV0001；`routes.ts` HTTP 路由（读可变运行时目录，settings 热更新）；`settings.ts` 插件设置。
- `src/client/`：浏览器侧（esbuild → `dist/client.js`，external react 等 DSH 共享模块）。`index.ts` 入口（bootstrap + `window.__wallpaperEngine` + 注册设置菜单）；`settings-section.tsx` 设置面板；`wallpaper-controller.ts` 选择/竞态/回退链；**`three-renderer.ts` + `threejs-player.ts` 是当前渲染主路径**；`wasm-renderer.ts` / `scene-renderer.ts` 为未接入的备用实现；**`object-effects.ts`（`ObjectEffectStage` 编排器）+ `object-range.ts`（对象范围/合成几何/UV 窗口等纯函数）是主路径的对象级效果链模块**，`effect-runner.ts`（`EffectRunner` 执行器）与 `shader/effect-chain.ts`（`resolveEffectChain` 链解析）自 2026-09-14 起被它们**接入主路径**（此前仅被未接入的 `scene-renderer.ts` 使用）；**`rt-render.ts`（`renderIntoRenderTarget`）是「渲染进 RenderTarget」的唯一入口，「渲染到 RT 必须透明清屏」这条不变量就落在这里（见 §5.22）**；`tex-loader.ts` TEXV0005 解码；`scene-json.ts` scene.json 解析；`background-layer.ts` / `settings.ts` / `styles.ts`。
- `src/shared/`：跨 host/client 类型（`WallpaperInfo`、`SceneDescription`、`SceneObject` 等）。
- `src/client/shader/`：WE shader 方言转译层（`effect-chain.ts` 解析、`shader-preprocessor.ts` 预处理、`glsl-to-naga.ts` 产 SPIR-V pass 描述、`uniform-binder.ts`、`we-headers.ts`）。

### 2.3 坐标与对象变换约定（**勿再翻转 / 勿漏乘**）

- **WE 场景系 = 左下原点、y 向上**；three 正交相机 = 中心原点、y 向上。映射：`three = we − viewport/2`，**y 不翻转**。历史事故：曾用 `vh/2 − oy`，导致非居中对象上下镜像。新代码不得引入 y 翻转或 `scale.y` 取负。
- **对象 model matrix = T·R·S**；其中 `angles` 是**弧度**（OWE `SceneNode.cpp:15`：`m_rotation is in radians. Static scene.json angles are already radians`），旋转顺序 **R = Rz·Ry·Rx**（OWE `ParticleRuntime.cpp:25-28`）。
- 粒子世界坐标：`worldPos = objCenter + R(angles) · (scale ⊙ (emitterOrigin + local))`（`threejs-player.ts` 的 `PARTICLE_VERTEX_SHADER`）。
- 背景 mesh：`position / rotation / scale` 直接对应 T / R / S（three 的 `Object3D` 变换顺序本身就是 T·R·S）。

## 3. 构建、测试与集成

### 3.1 常用命令

```bash
npm test                 # vitest run（node + jsdom 双环境）
npm run build            # tsc -p tsconfig.json → lib/（strict）
npm run build:wasm       # cd wasm && wasm-pack build --no-opt --target web --release --features render → wasm/pkg/
npm run build:client     # esbuild → dist/client.js，并把 wasm/pkg/ 复制到 dist/static/
npx vitest run tests/xxx.test.ts --reporter=basic   # 跑单个文件（全量较慢，且有既有失败，见 §7）
```

**铁律：改了 Rust 必须先 `build:wasm` 再 `build:client`** —— `build:client` 只把 `wasm/pkg/` 的现成产物复制到 `dist/static/`（页面加载的就是这份），顺序反了会复制旧 wasm；产物缺失时 `build:client` 直接报错。

### 3.2 集成到 DSH profile

profile（`%USERPROFILE%\.dsh\profiles\web`）用 **`link:` 符号链接**引用本包 —— 在**仓库根**执行：

```powershell
dsh plugin --profile web add link:E:/code/dsh-use-wallpaper
```

`dsh plugin` 转发给 profile 目录的 pnpm，之后**自动**把本包追加进 `dsh.profile.bundles`（本包声明了 `dsh.bundle`），**不要**再手改 profile 的 `package.json` 或往 profile `cordis.patch.yml` 插条目（重复 insert 报 `duplicate loader entry id`）。`link:` 是符号链接而非 `file:` 快照复制，所以构建产物直接生效：

```powershell
$i = Get-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\@dsh-use\wallpaper-engine"
$i.LinkType   # SymbolicLink / Junction；为空 = 落成了实体副本，需手动复制产物
```

- **client 侧改动（`dist/`）→ 自动热重载，无需重启**：web profile 始终挂载 `@deepseek-ai/dsh-client-hmr`（`dsh-web-app/cordis.patch.yml` 的 `client-hmr` 行，*always mounted*），它每 500ms 轮询每个 client bundle 的 `mtime`/`size`，变化即 `clientModules.rebuilt(id)` 重算 rev，并经 SSE `/plugins/events` 推给浏览器半重载。前提是 **bundle 文件真的被重写** —— `link:` 下重建仓库即可；`file:` 快照副本不会变，这正是旧结论「必须重启」的来源。
- **host 侧改动（`lib/`）→ 需重启 `dsh web`**：host 侧模块热重载 `@deepseek-ai/cordis-plugin-hmr` 在 `dsh-base` 里是 `disabled: true`（*Module reload is opt-in per profile*），默认不生效。
- **兜底**：HMR 未生效（SSE 断开 / 页面未打开 / 落成实体副本）时，把 `lib/`、`dist/` 复制进 profile 并重启 `dsh web` + 浏览器强刷。
- `lib/` 与 `dist/` **纳入版本控制**（`.gitignore` 不含它们；`wasm/pkg/` 与 `dist/static/ptex-*.tex` 才是忽略的）。发布包 `files` 白名单 = `lib` + `dist` + `cordis.patch.yml`，所以**提交与发布前两个产物都要是新的**。

### 3.3 验证手段

- **单测**：`tests/**/*.test.ts` 默认 node，`tests/dom/**` 走 jsdom（`vitest.config.ts`）。覆盖解析 / 加载 / 渲染器胶水 / 回退链。
- **全库解析回归**：`tests/verify-real-library.test.ts`（全库 scene.pkg 的 scene.json / image 纹理 / particle 规格 / 效果链解析零失败）。
- **端到端渲染（推荐）**：`research/verify-colorblend.mjs` 的模式 —— 自起 http server + headless Edge + esbuild 打包 harness，**用生产代码**（`lib/client/threejs-player.js`）渲染真实纹理并逐像素判定。**不依赖 DSH token**，是当前最可靠的渲染端到端验证方式。
- **全库浏览器回归**：`research/verify-wasm-render.mjs` —— **当前跑不通**（硬编码的 `?token=` 已过期，服务端 401），需从 `dsh web` 启动时打印的 URL 取新 token。

## 4. 目录

```
<repo root>                  # 仓库根即插件包（不是 monorepo；packages/ 是已废弃遗留，被 gitignore）
  src/{host,client,shared}/  源码（client/shader/ 为 WE shader 方言层）
  wasm/                      Rust 引擎（wasm-bindgen + wgpu）
    src/{coords,scene,tex,particle,render}/
    pkg/                     构建产物（gitignore；由 build:client 复制进 dist/static/）
    tests/                   Rust native 测试（cargo test，无需 wasm 目标）
  lib/                       tsc 产物（**入库**）
  dist/                      esbuild 产物 + dist/static/（wasm 与粒子纹理；**入库**，ptex-*.tex 除外）
  tests/                     单测；tests/dom/ 走 jsdom
  scripts/build-client.mjs   client 打包 + wasm/粒子纹理复制
docs/superpowers/
  specs/                     设计文档（改动前必读）
  plans/                     实施计划与修复记录
research/                    gitignore：截图 / 验证脚本 / 临时 profile
  open-wallpaper-engine/     C++ 参考实现（语义对齐来源）
  .lwe/                      linux-wallpaperengine 源码（另一参考）
```

## 5. 关键约定（踩过的坑）

1. **wasm 产物必须 `--target web`**：曾用 `--target module`（无默认导出 `__wbg_init`）导致 wasm 静默失败、一路回退。加载侧期望「动态 import + 调默认导出 `mod.default(wasmUrl)` 初始化」。
2. **`research/`、`wasm/pkg/`、`dist/static/ptex-*.tex` 是 gitignore**；`lib/`、`dist/` 其余部分**必须提交**（见 §3.2）。
3. **对象 `angles`（弧度）必须应用**，否则局部朝向被直接当世界朝向。全库 **79 个对象带非零 angles**（粒子 75 / image 2 / text 1 / other 1，涉及 15 张壁纸）。回归：GTR `3743126786` 烟柱 `angles.z = -1.20063`（≈ −68.8°）应把局部 +Y 转到世界 `(0.932, 0.362)` = 向右偏上；漏掉就变成直着向上。三个应用点：粒子顶点 shader、背景 `mesh.rotation`、util/text（字段解析保留，暂不做几何变换）。
4. **`turbulentvelocityrandom` = `forward` 绕 `normal` 旋转**（不是「沿 normal 偏移」）：官方 `TurbulentVelocityRandomProgram`（OWE `ParticleParser.cpp:326-357`）= curl 噪声采样 → 投影到垂直 normal 的平面 → 与 forward 求夹角 → `AngleAxisf(angle*scale + offset, normal) * forward`。方向**恒在垂直 normal 的平面内**（缺省 normal=+Z / forward=+Y 时 z 恒 0、x/y 随机）。旧实现写成 `forward*cosθ + normal*sinθ*scale`，得到 `(0, cosθ, sinθ)`：x 恒 0、速度全进屏幕上不可见的 z 轴 → 粒子排成一条竖线。影响全库 **9 张壁纸**（2011060960 / 2236329190 / 2460786246 / 2597392171 / 2851992662 / 2859263090 / 2897292240 / 3743126786 / 3760200530，且都没显式写 normal/forward）。实现见 `sim.rs`（复用既有 `curl_noise`，采样位置跨 spawn 累积，`offset/timescale/phasemin/phasemax` 全部参与）。GPU 路径的 `turb_velocity` 本就是球面均匀随机，不受影响。
5. **对象级 `instanceoverride`**（scene.json → 粒子）：`alpha/size/lifetime/speed` 是**乘数**，`color/colorn` 是**覆盖**（`UiColorToLinear` = v²，legacy `color` 先 /255），emitter rate **× `count`**；缺省恒等。JS 侧只透传原始 JSON（`SceneParticleObject.instanceOverrideJson` → `CpuParticleSim.new` 第 5 参，**空串 = 无覆盖**），语义解析在 Rust（`particle::parse_particle_override`）。回归：GTR 烟柱 `alpha 0.03` 是它在桌面端几乎不可见的原因（未实现时实测粒子 alpha 均值 0.797）。
6. **图像 `colorBlendMode`（→ shader combo `BLENDMODE`）不是 alpha 混合**，而是**额外追加一遍「读当前帧缓冲」的混合 pass**（WE 材质 `materials/util/effectpassthrough.json`，shader `genericimage3`；lwe `CImage.cpp:751-767`）：`ApplyBlending(BLENDMODE, A=背景, B=自己, 自己的 alpha)`，alpha 保持背景的。模式表在 **WE 明文 shader** `<WE>/assets/shaders/common_blending.h`：1=Darken 2=Multiply 3=ColorBurn … **6=Lighten 7=Screen** … 30=Tint **31=A+B×opacity** 32=A+A×B。three 侧用**预乘片元**（`vec4(rgb×tint×a, a)`）+ `CustomBlending` 复刻：7 → `(OneMinusDstColor, One)`、31 → `(One, One)`、6 → `MaxEquation`，alpha 用 `(Zero, One)`（**2026-09-14 `6bb3d71` 起**：对象级**隔离**路径不再复用这套内容材质 —— 混合语义整体移到**合成 quad**（`MeshBasicMaterial` + 同一套 `CustomBlending` 因子，采样的是非预乘的对象 RT），隔离内容材质只做普通 alpha 写入；见 §7.1 的 `colorBlendMode ∈ {6,7,31}` 条）。**未实现的模式回退普通 alpha 混合**（不静默画错）。关键性质：`BlendScreen(A, 0) = A` —— Screen 下纯黑底完全不改变背景（GTR 左上角黑块就是漏了这条：`clouds.tex` 78% 是不透明纯黑）。全库非零的只有 3 个对象：3743126786=7、2832263418=6、2460786246=31。
7. **粒子 alpha 属性链**：透明度 = 生命周期衰减 × alpha（`alpharandom` 等经属性链传入），JS ShaderMaterial 与 wasm 粒子层双路径同语义；改 alpha 相关逻辑要双路径验证（`wasm/tests/particle_alpha_tests.rs` + `tests/particles.test.ts`）。
8. **场景资源禁止浏览器缓存**：`/wallpapers/scene/<id>/asset` 返回 `Cache-Control: no-store`，改资源无需清缓存。
9. **wasm 效果链的历史卡点（已绕开，勿重走）**：naga 24/25 的 **glsl frontend 编译不了含 `uniform sampler2D` 的 GLSL**（`NotImplemented("variable qualifier")`），而几乎全部 WE 效果 shader 都采样 `g_Texture0`。现行链路是 **GLSL → `@webgpu/glslang` → SPIR-V → `spirv-webgpu-transform`（把组合采样拆成独立 texture+sampler）→ naga `spv-in` → WGSL**（`glsl-to-naga.ts` 产 `chain_desc`，wasm 侧 `effect.rs::spv_to_wgsl` 编译）；`chain_desc` 为空/解析失败才回退内置演示 pass（绝不白屏）。
10. **对象级效果链管线要点**（`wasm/src/render/mod.rs`，备用路径）：每带效果对象一条 `ObjectEffectEntry` / `ParticleObjectEffect`，流水线 = 内容 → 对象 RT → 效果链 ping-pong → 输出 RT → 合成 quad 贴回 surface；对象 RT 尺寸逐轴钳制 `[1, 4096]`，合成 quad **不钳制**、靠 UV 窗口只采样可见段。效果链创建失败 → 合成 quad 采样内容纹理（对象正常显示、无效果）。
    - **订正**：本条早先记「钳制 `[1, 2048]`」，与代码不符。实际值是 **4096** —— wasm 侧 `wasm/src/render/effect.rs:225` 的 `OBJECT_RT_MAX = 4096.0`，three 主路径 `src/client/object-range.ts:15` 的 `OBJECT_RT_MAX = 4096`（两条路径同值）。2048 会把满屏主图（如 2560×1440）钳小、主图被裁剪且合成 quad 只剩钳制窗口（Clamp 出竖直色条），故当初已提到 4096，只是文档没跟上（2026-09-14 订正）。
11. **效果链的一切编译/建管线必须在加载时一次性完成**（`EffectChain::new` / `set_object_effect` / `set_particle_object_effect`）；`render_frame` / `render_object_effects` / `step` / `EffectChain::render` **不得**做 naga 编译或建管线（每帧只写 uniform + 建 bind group + 提交 pass）。
12. **音频管线**：`createAudioAnalyzer` 频谱 → EffectRunner 音频 uniform + visualizer 条高；壁纸 `sound` 数组经 `playWallpaperSound` 接入（autoplay 被拦时 context suspended、可视化全零，用户手势后恢复）；无 Web Audio → 全零静音。
13. **测试沙箱**：vitest / esbuild 依赖 service 子进程（命名管道），受限沙箱下报 `spawn EPERM` —— 需完整权限运行。
14. **WE 内置粒子纹理走 host 路由，不随包分发（2026-09-11）**：粒子材质引用的纹理（`particle/fog/fog1`、`particle/halo` …）是 **WE 的第三方素材**。早先由 `build:client` 从本机 WE 目录复制成 `dist/static/ptex-*.tex`，结果被 `files: ["dist"]` 一并打进 npm 包（解包 43 MB 里 33 MB 是它）。现在 client 请求 **`/wallpapers/particle-texture?name=<相对 assets/materials 的路径>`**（路由见 `src/host/routes.ts`），由 host 从用户本机 `<weAssetsDir>/assets/materials` 直读。要点：
    - **`name` 就是材质纹理的原始相对路径，不能无条件加 `particle/` 前缀** —— 全库有 `workshop/<id>/particle/...` 这类路径（`2897292240` 的雨粒子）；
    - 别名表 `PARTICLE_TEX_ALIASES` 的值是「去 `particle/` 前缀」的短形式，命中后要补回前缀；
    - 代价：该路由属 host 侧，**升级插件后需重启 `dsh web`** 才注册；weAssetsDir 探测失败时纹理缺失 → 回退纯色粒子（不白屏）；
    - 验证脚本：`research/verify-particle-tex-fallback.mjs`（全库扫描每个粒子的纹理路径能否解析到真实文件）。
    - **`util/*` 效果纹理槽也走同一路由（2026-09-14，提交 `78e898f`）**：效果链引用的 WE 内置素材（`util/noise`、`util/clouds_256`、`util/white` …）同样不在壁纸 pkg 内，**必须优先从 WE 安装目录取真身**（`loadEffectTextureSlot`：① `util/*` 真身走 `/wallpapers/particle-texture` → ② 程序化回退 → ③ 壁纸 pkg 资源；沿用 `alphaPriority: false` 的效果遮罩语义）。踩过的坑：`resolveBuiltinTexture` 曾把 `util/noise` 与 `util/clouds_256` 映射到**同一张**程序化**均匀白噪声**（`mulberry32` 逐像素随机），而 WE 里它们是两张**结构化噪声**（263 KB / 200 KB）⇒ `vhs` 拿它调制扫描线/失真，结果变成**满屏杂乱条纹**（CP2077 `2454403969` 真机截图；修复前 Laplacian 均方 152.3 → 修复后 39.3，且「本该平滑区的高通残差」天空 2.35→1.08、扫描线区 4.37→1.81，证明下降来自去掉白噪声而非细节损失）。回退路径现在把两者拆成两个 key、两个不同种子。注意 `_rt_*` **不试真身**（WE 目录下无任何 `_rt_*` 文件，尝试必然 404），保留程序化回退且不告警。
15. **对象级 RT 的三条不变量（2026-09-14 真机 bug 修复回写，对应 `076ad36` / `ecfcc10` / `3fd6b00`；改这块先读代码注释）**：
    - ① **局部正交相机的 left/right/top/bottom 是「世界坐标范围」**，对象内容也以世界单位绘制 ⇒ 相机必须覆盖**完整对象世界尺寸**（`Math.abs(worldW/worldH)`，`threejs-player.ts:796-807`）。两个踩过的坑：**拿 RT 像素当范围**（`076ad36`）⇒ dpr>1 时相机多覆盖 dpr 倍、内容只占 RT 的 1/dpr、合成 quad 再按全窗口拉回世界尺寸 ⇒ 对象缩小 + 边缘 clamp 拉伸（HiDPI 真机整张壁纸错乱；headless 里 `dpr ≡ 1` 时 rt == world，故端到端漏检）；**按 `OBJECT_RT_MAX`(4096) 钳制范围**（`ecfcc10`）⇒ RT 只覆盖对象中央，UV 窗口外侧被 CLAMP 采样 ⇒ **边缘拉伸带**（GTR `3743126786` 背景对象世界宽 7430 > 4096 ⇒ 右侧 22% 画面宽是条纹）。超限对象的正确代价是「**分辨率低**」（欠采样），**不是**几何裁剪。
    - ② **RT 的像素尺寸 = `|world| × 屏幕密度`（= 对象在画布缓冲上的**占位像素**），等比收口到 4096**（`object-range.objectRtSize`，`src/client/object-range.ts:270-289`；密度 = `object-range.screenScalePx` = 画布缓冲宽 / cover 视锥宽，`:230-249`）。**2026-09-14 换口径**（详见 §5.21）：旧口径「`min(world × dpr, 视口 × dpr, 4096)`」把**预算当成了基准**，与屏上占位差 0.8%（GTR 实测 RT `1280×714` vs 占位 `1290×720`）⇒ 合成那一步是比 0.992 的双线性缩小 + 亚纹素相位漂移 ⇒ 整层锐度 −52%。基准必须是**未钳制**的 `world`（image = `|size × scale|`、particle = `particleWorldSize`），**不能**用 `objectCameraRange` / `particleObjectRange` 的 `range`（那是「相机范围」语义、逐轴钳到 4096；`3fd6b00`）：实测拿 range 当基准得 **720×720**（7430×4147 对象、1280×720 视口），贴回屏幕要放大 1.78× ⇒ 大幅背景壁纸整层明显模糊。image 与 particle 两条路径都如此（`three-renderer.ts:300-341`）。
    - ③ **`isolate` 的键是 `scene.json` 的对象 id**（`isolate.objectId`），**不是** player 的图层计数器 id —— 背景 / 粒子各有一个从 0 起的独立计数器，撞键会让同一壁纸的隔离 image 与 particle 互相覆盖（后建覆盖先建，quad 从此采样一张永不被渲染的 RT）。`isolatedObjects()` / `setObjectOutput(id, …)` / `resizeObjectRT(id, …)` 收的都是对象 id（`threejs-player.ts:766-771, 824-825`；`three-renderer.ts:337-340`）。
16. **效果纹理槽编号 + sampler `combo` 派生（遮罩是否生效由这两条共同决定）**：
    - **`textures[i] → g_Texture(i)`**（**不是** `g_Texture(i+1)`）：WE 官方文档明写 textures 依次绑到 `g_Texture0, g_Texture1, …`（`.superpowers/we-layerd-src/third_party/wallpaper-engine-renderer/wpdoc/scenejson.md:22`），实现见 `effect-runner.ts:429-435`。写错会让**所有效果的纹理槽整体错位一个** ⇒ mask / 方向图落到别的 sampler、shader 采到默认纹理（shake 的 flowmask 采白 ⇒ `flowMask≈1.0` ⇒ 全图位移）。
    - **sampler 声明带 `"combo":"X"` 时，该槽被绑定（scene.json 的 `textures` 对应项非 null）即置 `X = 1`**，`scene.json` 的 `pass.combos` 显式值优先（`shader/effect-chain.ts:77-95`，必须在 `preprocessWeShader` **之前**）。缺失会让 `#if MASK` 的**局部作用分支永不启用** ⇒ 效果全图生效（`pulse` / `foliagesway` 的 mask 分支）。
    - 这两条加上下面两条纹理语义，就是 GTR 从「整屏晃动 + 整屏脉冲」回到桌面 WE「只抖排气管、女孩脸上反光一闪一闪」的全部原因（`3031158`）。
17. **`g_TextureNResolution` 的 vec4 分量是 `(mip0.w, mip0.h, header.w, header.h)`**（lwe 约定），**不是** `(w, h, 1/w, 1/h)`：效果 shader 用 `.z/.x` 缩放遮罩 UV（`shake.vert` 的 `v_TexCoord.zw = uv * g_Texture1Resolution.z / g_Texture1Resolution.x`），`.z` 填 `1/w` ⇒ `.z/.x = 1/w²` ⇒ 遮罩 UV 被压成 ~0 ⇒ 所有像素采到同一角 ⇒ 本该只作用于 mask 区域的效果变成**全图等量位移**。为此 `textureFromTex` 把 `[mip.width, mip.height, info.textureWidth, info.textureHeight]` 写进 `tex.userData.fxRes`（`tex-loader.ts:335-343`；header 尺寸可大于 image 尺寸 —— NPOT padding）；`resolveTextureResolution4` 读该字段，**RT 等无该字段的纹理按 lwe 约定视为 `(w, h, w, h)`**（`effect-runner.ts:108-130`、`:436-448`）。
18. **R8 / RG88 有两套通道语义，不能混用**：`convertUnormToRgba(data, format, alphaPriority = true)`（`tex-loader.ts:490-515`）——
    - 缺省 `true` = **粒子纹理**语义（`TextureFlags_AlphaChannelPriority`：形状 / 覆盖写在 R（R8）或 G（RG88）通道）：R8 → `vec4(1,1,1,r)`、RG88 → `vec4(r,r,r,g)`；
    - `false` = **效果纹理槽**语义：R8 → `(r,r,r,1)`、RG88 → `(r,g,0,1)` —— 效果 shader 直接读 `.r` / `.rg` 当**遮罩数值**（`pulse.frag` 的 `float mask = texSample2D(g_Texture2, v_TexCoord.zw).r;`、`shake.frag` 用 `.rg` 取两个方向分量），按粒子语义会让 `.r` 恒为 1 ⇒ mask 失效 ⇒ 本该局部的效果覆盖全图（真机「GTR 整屏脉冲 / 整屏抖动」的主因）。
    - 调用方：`EffectRunner.resolveTextureSlot` 传 `{ alphaPriority: false }`（`effect-runner.ts:390-393`）；粒子纹理路径保持缺省 `true`（`tex-loader.ts:531-537`）。
    - ⚠️ **待办（2026-09-14 发现）**：这个语义的**权威来源应是 `.tex` 头的 `TextureFlags_AlphaChannelPriority`（bit19 = 524288）**，现在却由**调用方路径**推断（效果槽一律 `false`）。对当前库恰好正确，但语义来源错了。全库 **82 张** `.tex` 带此位。
19. **`.tex` 的 flags 必须被消费（2026-09-14，提交 `9306ae6`；权威定义见 `research/.lwe/.../Data/Assets/Texture.h:91-97`）**：`textureFromTex` 曾只读格式与尺寸、**把 flags 整个丢掉**（sprite 那一位除外），已暴露三类语义偏差：
    - **`ClampUVs = 2`（bit1）—— 已修**：WE 默认 **REPEAT**，**仅带此位才 CLAMP**（lwe `CTexture.cpp:176-183`）。曾一律落到 three 默认 `ClampToEdgeWrapping` ⇒ `clouds.frag` 有意把第二组 UV 旋转到负象限（`cloudTexCoods.zw = vec2(-w, z)`，u ∈ [-0.5, 0]），clamp 下 `cloud1` **全部塌到纹理最左一列**（该列 R 均值 0.706 vs 全图 0.494）⇒ `cloudColor = cloud0*cloud1` 从推导的 ≈0.24 抬到 **0.419** ⇒ CP2077（`2454403969`）**整屏偏白**，且**随时间越来越白**（相位 60 s 亮度 105.93；修复后 68.91）。**全库 477 张 `.tex` 中 105 张因此由 clamp 改 repeat**（pkg 内 12/166、素材库 93/311）。
    - **`NoInterpolation = 1`（bit0）—— 待办**：`applyLinearSampling` **无条件**设 `LinearFilter` + `LinearMipmapLinearFilter`，带此位的纹理（全库 **4 张**）本该 `NearestFilter` ⇒ 被插值偏糊。
    - **`ClampUVsBorder = 8`（bit3）**：按 lwe 的 `CTexture` 路径落 REPEAT（全库 **0 张**带此位，当前无实际影响，语义未验证）。
    - ⚠️ **RT 纹理必须保持 CLAMP**：`object-range.ts` 的对象合成 quad 依赖它。`WebGLRenderTarget` 不经 `textureFromTex`，所以只要不改 RT 创建处就安全 —— **别在别处一律改成 repeat**。
20. **纹理 v 轴约定：WE 是 `v=0` = 图像顶部；效果链一侧必须按 WE 约定、显示路径保持现状（2026-09-14，提交 `426446c`；报告 `v-convention-report.md`）**：
    - **WE/lwe 证据**：`research/.lwe/.../CTexture.cpp:84` 直接 `glTexImage2D(..., dataptr)` 上传 `.tex` 原始字节，**只有 `glPixelStorei(GL_UNPACK_ALIGNMENT, 1)`、无任何垂直翻转** ⇒ `.tex` 第一行 → `v=0`，v 沿图像**向下**。
    - **我们的显示路径**：`textureFromTex` 翻行序（`v=0` = 图像底部）+ mesh UV 不翻 ⇒ **画面正确**（不颠倒），但**效果 shader 里的 v 语义与 WE 相反** ⇒ **用 v 表达的方向量整体反向**（`waterflow` 带符号位移的**纵分量**、`clouds` 旋转 UV、`foliagesway` 摆动、相位图）。真机表现 = 「**方向对但位置/斜度不对**」（Crimson Horizon `3765967112` 的水流）。注意：流动区域的**位置**取决于两侧是否同约定 —— 一直是**对的**（别误判成"条带被镜像"）。
    - **修法（窄修，勿全量迁移）**：只在**效果链一侧**按 WE 约定加载（`tex-loader` 的 `rowOrder` 参数 + `effect-runner` 的 `{load}` 注入点 + `object-effects` 注入 topDown 加载器），并用「**隔离局部相机 y 镜像** + 合成 quad 的 `flipGeometryUvY` 反镜像**精确抵消**」⇒ RT 内容与 mask 同约定、画面仍正立。**显示路径（背景 / 粒子 / text / 共享场景 / scene-renderer）一行未改**。
    - **为什么不做全量迁移**：那要改 4~8 个显示采样点（含**未接入、无法端到端验证**的 `scene-renderer` 与 text），**漏一处就是整图上下颠倒**；收益却与窄修相同。
    - **判据（权威对照）**：第三方 WE 约定 CPU 参照（`research/dsh-wallpaper-engine-v0.7.1` 的 we-renderer `effectWaterflow` 逐字调用）在流动 band 内 —— **修复后 0.04/255**、修复前 1.29/255 ⇒ 修复后与 WE 约定的实现几乎逐像素一致（仅 `PERSPECTIVE=0` 路径可对照）。
21. **对象 RT 的尺寸口径 = 屏占位；屏幕密度必须与主相机 cover 同源、mount 与 resize 同源（2026-09-14，用户「scene 壁纸不如桌面 WE 清楚」的机械归因）**：
    - **现象与归因**（证据：`.superpowers/sdd/2026-09-14-three-object-effects-pipeline/clarity-report.md`，逐环节把 RT/效果输出读回后测同口径 Laplacian）：隔离路径相对**直渲**锐度 −52%（Laplacian 均方 `713.2 → 341.5`，与 dpr 无关、与 MSAA 无关）。定界结果：内容→对象 RT **712.9**（−0.04%）、效果 pass **711.2**（−0.24%）、**合成 quad→屏幕 341.5（−52%）** ⇒ 纯 RT 往返无损，损失 100% 在最后一步重采样。机制 = RT 像素网格与对象在屏上的**占位像素网格**不一致（旧口径 `1280×714` vs 占位 `1290×720`，比 0.992）⇒ 双线性 + 亚纹素相位漂移把最高频成对平均掉。
    - **口径（现）**：`RT 像素 = |世界尺寸| × 屏幕密度`，单一等比收口到 4096。密度 = **画布缓冲宽 / cover 视锥宽**（`object-range.screenScalePx`，与 `ThreeScenePlayer.applyCover` 共用 `coverRange`）。**为什么两者必须同源**：screenScale 是「世界 → 设备像素」的线性映射，用视口宽当分子、用场景宽当分母就退化成旧口径（差 0.8%）。**mount 与 resize 必须是同一个数**：挂载期由 `three-renderer` 用纯函数算（player 此刻还不存在），resize 期取 `player.screenScalePx()`（player 的 state 刚被 `resize()` 更新）—— 旧实现「两处各算一份预算」正是 `3fd6b00` 那类「挂载期对、任何一次 resize 又被打回」地雷的同源结构（已删：`ObjectEffectStage` 不再持有 dpr/预算，只持一个 `screenScale`）。
    - **实测（GTR `3743126786`，headless Edge/SwiftShader，声明视口 1280×720，相位 5 s，`--no-particles`）**：隔离（纯 `shake` 对照）**711.1** vs 直渲 **713.2（−0.3%）**、逐像素 MAD **0.0414**（修复前 341.5 / MAD 1.804）；全效果链 **675.1**（修复前 313.3；与归因实验的仪器值 675.1 逐位吻合）；`dpr=1 vs dpr=2` 下采样后 MAD **2.075**（= 直渲地板 2.105；修复前隔离 5.503）；挂载期 RT `1612×900`（窗口 1400×900@1）→ `__fxApplyViewport()` 后 `1290×720`，两次都与独立 oracle 相符（唯一 ID 断言为门禁）。
    - **显存代价（全库 15 个带线性效果链的壁纸 / 40 个隔离对象，审计脚本 `research/q-rt-vram-sweep.mjs`）**：`1920×1080@dpr1` 合计 530 MB（旧口径 386 MB）、单壁纸最大 **131.8 MB / 中位 27.9 MB**（旧 39.0 / 23.7；最坏倍数 3.38×，来自把 3840×6000 的对象整体按屏密度栅格化 —— 它比屏幕高 2.8×，可见区只占 1/3）；`@dpr2` 与 `4K@dpr1` 单壁纸最大 **245.7 MB**（旧 156.1，1.57×）、中位 95.0（旧 94.9 / 63.2）。结论：**典型代价 ≈ +18%、最坏 +3.4×（均为 dpr=1）**，4096 硬上限仍把单对象钉在 ~107 MB。`objectRtSize` 保留第 4 个参数 `cap` 作为**逐对象字节预算**的预留口子（实测 `cap = min(4096, 1.5×视口长边)` 只收窄 2/40 个对象、最坏降到 121.5 MB；`2×` 一个都不收窄 —— 因为超屏对象的问题在**短边**，真要用得按轴设），需要时只改调用点 + oracle，不动口径。
    - **已知边界**：未与桌面 WE 做像素对照（只证明「我们比自己直渲糊 52%」⇒ 已修到 ±0.3%）；WE 的对象 RT 是**源纹理真实尺寸**（lwe `CImage::getSize()`，GTR 相当于 5.76× 超采样），我们取 1:1（最小无损）**不复制**其超采样（需 352 MB/对象）；对象远大于屏幕（占位 > 4096）时仍是无 mipmap 的缩小 ⇒ 锯齿，真超采样要「×2 占位 + RT mipmap」（归因报告里的方案 F，**未验证**）；`scene-renderer.ts`（wasm 备用路径）仍是旧口径，本期未动。

22. **渲染进 RenderTarget 必须「透明清屏」（清屏 alpha = 0）——「整片黑块」的根因（2026-09-15，用户报告 `2911105183 Subway Station` 很多地方是黑的）**：
    - **机制**：three 的清屏 alpha 由 `WebGLRenderer` 的 `alpha` 构造参数决定（`WebGLBackground`：`let clearAlpha = alpha === true ? 0 : 1`）。主路径是 `new THREE.WebGLRenderer({ canvas, antialias: true })`（`alpha` 缺省 **false**）⇒ **clearAlpha = 1**；这份状态是 renderer 级的，`renderer.render()` 渲染到**任何 RenderTarget** 时**同样生效** ⇒ 每个 RT 都被清成**不透明黑 `(0,0,0,1)`**。于是：
      - **对象 RT**：隔离对象内容本身透明的地方（WE 图层普遍带 mask / alpha）留成不透明黑；
      - **效果链 ping-pong RT**：效果把 alpha 降下去的地方（`opacity`、各类 `*mask`）——normal 混合的 rgb 因子是 `SrcAlpha` ⇒ rgb 被乘成 0；而 alpha 通道的 blendFunc 是 `(ONE, ONE_MINUS_SRC_ALPHA)` ⇒ **alpha 只增不减、恒为 1**（不是「透明的黑」，是**不透明黑**）；
      - **合成 quad** 用 `MeshBasicMaterial` 采样这张 RT（普通 alpha 混合）⇒ 采到 alpha=1 的黑 ⇒ **直接盖在主场景上**。注意：走 `colorBlendMode ∈ {6,7,31}` 的合成 quad 用 CustomBlending（`blendSrcAlpha=Zero/blendDstAlpha=One`、颜色因子不看 alpha）⇒ **不受影响**（GTR 全隔离对象都是 cbm=7，A/B 实测逐像素无差）。
    - **实测（headless Edge/SwiftShader + `lib/` 生产代码，1280×720，`research/tmp-2911105183/render-lab.mjs`）**：`2911105183` 全画面纯黑（RGB 全 <12）像素 **31.1% → 0.7%**；其中 **obj 130**（一张全屏背景 + 带 mask 的 `opacity` 效果）单独就占 **26.3 个百分点**（只渲染 obj 13 + obj 130 两个对象时黑像素仍是 26.3%，剥掉该对象的效果则 0.7%）。定界实验：把 `opacity.frag` 改成 `albedo.a = 1.0`（不降 alpha）→ 黑区消失（0.7%）；改成 `albedo.a = 0.0`（全透明）→ 全屏 **100%** 黑 ⇒ 链路上「alpha 降下去 ⇒ 输出不透明黑」确凿。
    - **修法**：`src/client/rt-render.ts` 的 `renderIntoRenderTarget()` —— 渲染前置 0、渲染后恢复原值。两个调用点：`threejs-player.renderIsolatedContents()`（对象 RT）与 `effect-runner.update()`（ping-pong RT，编译探针的 1×1 RT 也走同一入口）。**刻意不改 renderer 的 `alpha` 参数**：`alpha: true` 会让画布在未绘制处变成透明（画布背后是 DSH 页面），是另一种可见行为变更、波及全库。
    - **顺带修掉的既有遗留（§7.4 旧条目）**：`2597392171`（`copybackground: true` 的两个全屏图层走隔离路径「接近全黑」）的**真因就是本条**，不是 copybackground 语义缺失 —— 同一 A/B（把 `setClearAlpha` 打成 no-op 复现旧行为）实测：旧行为全画面均值 **14.03/255**（与早先记录的 15.3 / 14.98 一致），修复后 **83.99/255**（与「去掉 effects 不隔离直渲」的 81.0 对齐），黑像素 86.6% → **0.0%**。
    - **GTR `3743126786` 无回归**：同一 A/B 下旧行为/修复后黑像素都是 12.0%，全画面均值 47.78 vs 47.77（原因见上：其隔离对象全是 cbm=7 的 Screen 合成 quad，混合因子不看 alpha）。
    - **回归测试**：`tests/rt-render.test.ts`（置 0 → 渲染 → 恢复；无 get/setClearAlpha 的 mock 静默跳过）、`tests/threejs-player.test.ts`「隔离内容渲染用透明清屏（clearAlpha=0），主场景渲染保持原值」、`tests/effect-runner.test.ts`「pass 渲染时清屏 alpha=0，渲染后恢复原值」。

23. **WE 视频纹理（`flags` bit5 = Video）已实现（2026-09-15）：`.tex` 的 mip0 载荷是完整 mp4，直接交给浏览器解码**
    - **形态**：带此位的纹理（权威定义 `research/.lwe/.../Data/Assets/Texture.h` 的 `TextureFlags_Video`）mip0 **不是像素数据**，而是一个**完整 mp4 文件**。实测样本（全库唯一）`2911105183` 的 `CP_ads_01/02.tex`：`ftyp isom/iso2/avc1/mp41`、H.264、1280×720、**27.41s / 27.73s**、1024 万字节、**无音轨**（moov 里只有 `avc1`）。此前按原始 RGBA 解 ⇒ 广告牌画成乱码（清屏修复前是不透明黑块，修复后是透明）。
    - **判定**（纯函数 `isVideoTexPayload`，node 可测）：`flags & 32` **且** mip0 前 8 字节是 mp4 的第一个 box（`?? ?? ?? ?? 'ftyp'`）。两个条件都要 —— 只看 flags 会把「标了 Video 位其实是像素」的包当视频，只看 magic 会误判恰好以该四字节开头的像素数据。
    - **建纹理**（`tex-loader.videoTextureFromMp4`，必须排在**编码图像与原始像素两条分支之前**）：`Blob(video/mp4)` → `URL.createObjectURL` → 离屏 `<video muted loop playsInline preload=auto>` → 等 `loadeddata`（5s 超时）→ `THREE.VideoTexture`。实测（`research/tmp-2911105183/probe-video-play.mjs`，headless Edge）：`readyState=4`、`duration=27.41`、静音 `play()` 成功、`texImage2D(…, video)` 后 `glError=0` ⇒ 浏览器原生解码即可，不需要解封装/前端解码器。
    - **三个不显然的约束**：① **静音自动播放**（壁纸没有用户手势）：`muted + playsInline` 才允许起播，被策略拒绝时挂一次性 `pointerdown/keydown` 重试；② **不进 mip 链**（`VideoTexture` 每帧 `needsUpdate`，`generateMipmaps` 会每帧重建整条 mip）⇒ 强制 `LinearFilter` + `generateMipmaps=false`；③ **生命周期不归 GPU 管**：`renderer.dispose()` 只释放 WebGL 资源、**不会停解码**，故清理挂在纹理的 `dispose` 事件上（`tex.addEventListener('dispose', release)` → pause + 清 `src` + `revokeObjectURL`），并要求调用方**真的 dispose 纹理**（见下条）。
    - **行序**：与 ImageBitmap 分支同一套语义 —— 显示约定（`rowOrder` 缺省 bottomUp）`flipY=true`；效果槽约定（`topDown` = WE 的 v=0=顶部）`flipY=false`。
    - **不可播时的降级**：返回 **1×1 透明纹理** + 一条可辨识 `console.warn`（**不是** null、**不是**当像素解码）。理由：`createLayerMaterial(map: null)` 会退回**白色不透明**面板；而 mp4 位流当 RGBA 解是乱码，且载荷常比 `w×h×4` 小 ⇒ 原始路径的 `flipRows` 会**越界抛错**。
    - **附带补的一处资源所有权缺口**：`three-renderer` 此前不释放本次装配的背景纹理（注释口径是「随 `renderer.dispose` 清理」，对 GPU 纹理成立、对视频不成立）⇒ 现在 `teardown()` 显式 `texture.dispose()` 本次 `backgroundTextures`，壁纸切换即停播 + 撤销 Blob（否则每切一次漏一个仍在解码的视频 + 一份 10MB Blob）。**边界**：效果**纹理槽**用的纹理（`EffectRunner` 的 `this.textures` 缓存）仍不 dispose（槽里混有模块级共享的空槽常量纹理，误 dispose 会波及其他 runner；库内也无「视频纹理当效果槽」的用法）。
    - **验证**：单测 `tests/tex-loader.test.ts`（判定正/反例）+ `tests/dom/tex-loader-video.dom.test.ts`（jsdom + FakeVideo：VideoTexture/flipY/wrap/fxRes/dispose 清理/error 降级）+ `tests/three-renderer.test.ts`（teardown 释放纹理，切壁纸与 dispose 两条路径）；端到端 `research/tmp-2911105183/render-lab.mjs` 的 `bg-ads` 变体（只留静态背景 + 三个广告牌）两帧连拍：**只有两块广告牌区域在动**（粗网格 8×6 变化率 10.4%/5.2% 与 4.7%/2.1%，其余全 0.0%），整屏黑像素仍 **0.7%**、广告牌区域暗像素 **0.0%**。`research/verify-object-effects.mjs` 的 [2] 判据同步升级为「盒外 = 去掉全部**动画源**（时间驱动效果对象 **+ 视频纹理对象**）」——视频是独立于效果链的动画源，不建模它会把广告牌误判成「效果漫出盒子」（升级前该判据 FAIL：盒外最大差 155；升级后 PASS：盒外最大差 0）。

24. **uniform 注解里的**嵌套对象**必须完整解析（2026-09-15，用户报告 `3303428996 死亡搁浅-玛玛` 整屏黑）**：
    - **根因**：`extractUniformAnnotations` 用非贪婪 `\{[\s\S]*?\}` 抓 `// {...}` 注解，遇到**内层 `}`**（WE 注解普遍带 `"require":{"DIRECTDRAW":0}`、`"options":{...}`）就截断 ⇒ `JSON.parse` 失败 ⇒ **注解整体丢失** ⇒ binder 拿不到 `material` 映射与 `default`，uniform 落到「按类型全零」。修法：正则改为抓到行尾，再用 `takeBalancedJson`（配对花括号扫描）截出首个完整对象。
    - **为什么现在才炸**：`3303428996` 的唯一效果是 `effects/lightshafts`，其 **vert** 用 `inverse(squareToQuad(g_Point0..3))` 算透视矩阵 —— 四个点全 0 ⇒ 矩阵退化 ⇒ `v_TexCoordFx.z = 0` ⇒ `fxCoordRef.y` 为 Inf/NaN ⇒ `albedo.rgb = A + B*fx` 里 `B*0 = NaN` ⇒ 输出 NaN ⇒ 渲染成**不透明黑**（实测效果输出 RT 全 `(0,0,0,255)`，整屏 100% 黑）。此前这条 pass 因为 `float(format) == FORMAT_RG88`（§7.1 已修）**编译失败被跳过**，墙上那张图是「效果没跑」的状态；修好编译后效果真的跑起来，才暴露这个注解解析缺陷。
    - **影响面（全库 194 个 shader 扫描，`research/tmp-2911105183/scan-annotation-impact.mjs`）**：仅 **10** 条注解从「丢失」变「解析成功」——4 条是 `lightshafts` 的 `g_Point0..3`（本条修复对象）、5 条是 `blur_precise_gaussian` 的 `g_Texture2`（`mode:opacitymask` + `combo:MASK`；那些链属**具名 RT 图链**，2026-09-15 P2 落地后**注解已参与绑定** —— 但链是否真的挂载取决于它挂在什么对象上（全库有 10 条挂在 text/util 上不挂链），见 §7.1）、1 条是 `lightshafts` 的 `g_Texture2`（`RENDERING==1` 才用）。
    - **验证**：单测 `tests/shader-preprocessor.test.ts` 两条（嵌套 `require` 的 vec 注解完整解析；sampler 注解的 `mode`/`combo` 不丢）；端到端 `3303428996` 黑像素 **100% → 7.2%**（7.2% 是该图自身的暗部，与 `preview.jpg` 对比画面与「光柱」效果一致）；`2911105183` 复测仍 **0.7%**（无回归）。

25. **效果 pass 的 `blending: "normal"` = 覆盖（`ONE/ZERO`），不是 alpha 混合（2026-09-15，用户报告 GTR 左上云消失）**：
    - **WE 语义（参考实现逐字）**：`research/.lwe .../Render/Objects/Effects/CPass.cpp::setupRenderFramebuffer` —— `Normal → glBlendFuncSeparate(ONE, ZERO, ONE, ZERO)`（**直接覆盖**）、`Translucent → (SRC_ALPHA, ONE_MINUS_SRC_ALPHA, …)`、`Additive → (SRC_ALPHA, ONE)`；`MaterialParser::parseBlendMode` 未知值也回落 Normal。我们的 `blendModeToThree` 曾把 `normal` 映射成 three 的 `NormalBlending`（`SrcAlpha/OneMinusSrcAlpha`）⇒ pass 写 ping-pong RT（每 pass 都清成透明）时 **rgb 被乘一次自身 alpha、每过一个 pass 再乘一次**。
    - **症状与定界（GTR `3743126786` obj 246「Clouds Back」：scroll + waterripple + opacity，内容 alpha 0.5）**：修复前该对象的效果输出 RT **rgb 全 0**（alpha 0.13 = 0.5×0.26），合成是 cbm=7 Screen（颜色因子不看 alpha）⇒ 加 0 ⇒ **云整层不可见**；修复后输出均值 rgb 0→21.7（云的游动/涟漪可见）。为什么以前看不出来：§5.22 那轮修复之前 RT 被清成**不透明黑**，alpha 通道被 alpha blendFunc 钉在 1（不会逐级衰减），rgb 恰好不被继续乘 ⇒ 这个缺陷被「不透明清屏」掩盖了；§5.22 让 alpha 变真实后立刻显形。
    - **修法**：`blendModeToThree` 改为 `normal`/未知 → `THREE.NoBlending`（= `ONE/ZERO`），`additive/add` → Additive，`translucent/alpha` → Normal，保留 `multiply/subtract`（WE pass 枚举里没有，属我们既有扩展）。**注意**：pass 不再预乘 alpha 后，cbm 6/7/31 的合成就必须自己把图层 alpha 乘回来（见 §5.26，否则云层全强度盖住人物）。
    - **验证**：`tests/effect-runner.test.ts` 改断言（旧断言把 `normal` 记成 NormalBlending，是错的语义）；端到端 GTR 云层恢复（含 scroll 游动）；`2911105183` 复测 **0.7%**、`3303428996` 复测 **7.2%** 均无回归；验收脚本 [1][2][2-归因×2][2-有效性][3b][4] PASS。

26. **cbm 6/7/31 的合成 quad 必须把图层 alpha 预乘进 rgb（2026-09-15，用户报告 GTR 云挡住人物）**：
    - **WE 语义**：`colorBlendMode` 是 `mix(A, Blend(A, B), opacity)`（A=背景、B=图层、opacity=图层 alpha）——**opacity 参与**。我们的合成 quad 用 CustomBlending 复刻，而 Screen(7) 的颜色因子 `(OneMinusDstColor, One)`、31 的 `(One, One)`、6 的 `MaxEquation` **都不看 alpha** ⇒ 图层 alpha（`alpha 0.5` × `opacity 0.26` × mask）必须由片元预乘进 rgb。
    - **症状**：§5.25 让 pass 不再预乘 alpha 之后，云层以**全强度**Screen 叠加 ⇒ 人物区均值 61.6 → **85.8**（被云洗亮、「云挡住人物」），mask 也整个失效。修法：cb 分支的合成 quad 开 `mat.premultipliedAlpha = true`（three 的 `<premultiplied_alpha_fragment>` 会做 `gl_FragColor.rgb *= gl_FragColor.a`）。
    - **实测（GTR `3743126786`，同分辨率逐区域均值）**：人物区 85.8 → **58.7**（基线 5d4e3da 61.6）、云/天空区 65.8 → **43.0**（基线 46.4）、全屏 53.3 → 48.2（基线 48.9）⇒ 回到本会话之前的观感（云在人物之后、被 mask 排除）。
    - **已知近似（未做到 WE 的严格数学）**：对象 RT 的 rgb 本来就是「内容 alpha 预乘过」的（内容渲染走普通 alpha 混合），合成再乘一次最终 alpha ⇒ 半透明图层的贡献仍带一次多余的内容 alpha（GTR 云实到 `0.5×0.13`，WE 是 `0.13`）。要严格对齐得让内容侧写非预乘 rgb（或按 alpha 反除），改动面更大，本期不做。
    - **验证**：`tests/threejs-player.test.ts` 断言 cb quad `premultipliedAlpha === true`、cbm=0 quad 为 `false`；其它 cbm 用例（`2832263418` cbm=6、`2460786246` cbm=31）端到端黑像素正常（0.0% / 8.8%）。

27. **GTR 云 vs 桌面 WE 的量化对照（2026-09-15，用户提供桌面截图后实测）**：桌面截图（1920×1039，裁掉任务栏）缩到 1280×693 后对齐残差 5.97、scale 0.99、dx=dy=0（`research/tmp-2911105183/compare-desktop.mjs`）。区域亮度（我们 / 桌面）：云区 **46.3 / 48.1**（中位 40/41、云区核心 40.2/41.3）、天空无云 58.5/59.5、**城市灯 58.3/63.4**、全屏 46.0/47.9。⇒ **云层本身已与桌面一致（均值差 1~2/255）**；差异集中在**亮部发光**：云区 p99 **199 / 225**、城市灯 p90 133/147，且桌面的发丝/路灯有明显的 bloom 光晕（`research/tmp-2911105183/lab/cloud-ab.png` 上下拼图可见）。结论：**这不是云层公式问题，而是被跳过的具名 RT 图链**（本壁纸背景对象链里的 `workshop/2822917890/bloom`，属 §7.1 记录的 24 条未实现链之一）——要对齐桌面得做 P2「具名 RT 图执行器」。（**2026-09-15 补**：P2 已落地，该 bloom 链现已执行；但 `[5]` 实测它只带来**局部增亮**、不抬全屏 p99，见 §7.1。）

28. **具名 RT 图链的执行语义（P2，2026-09-15；设计文档 `docs/superpowers/specs/2026-09-15-three-rt-graph-executor-design.md`）**：加载期由纯函数 `buildEffectPlan`（`effect-graph.ts`）把链编译成静态计划，`EffectRunner.setPlan` 按计划建**具名 RT 池**；帧内只查表绑槽 + 提交 pass（§5.11）。
    - **尺寸与作用域**：具名 RT = 对象 RT ÷ `fbos.scale`（未声明 = 1），**池作用域 = 单条链**（key 带链序号 ⇒ 两条链同名 RT 各持一份）；
    - **`bind.index` = `g_Texture<index>`**（**不是** `g_Texture<index+1>`），且 `bind` 优先于 `textures`；
    - **`previous` = 进入 target 序列前的输入**（即对象 RT 原图），**不是**上一 pass 输出 —— 按后者实现会让合成基底变成自己的模糊结果；
    - **写具名 RT 的 pass 编译失败 ⇒ 整条计划放弃**（回退对象 RT 原图）：派生读端会读到空 RT，P1 的「跳该 pass、读端不变」在这里不成立；
    - 引用链内不存在的 `_rt_*`（全库仅 1 处，全局运行时 RT `_rt_FullFrameBuffer`）⇒ 该槽**保持默认、不绑白纹** + 一条去重告警；
    - effect 级 `visible === false` 整条不挂链（全库 1 条，**不打降级告警** —— 作者正常内容）；本期**未做显存 cap**；清屏沿用透明清屏（§5.22），与 lwe 的 `LoadOp::Load` 有差异，但写具名 RT 的 pass 全是全屏覆盖写 ⇒ 清与不清同结果（**全库复核 2026-09-15**：**62** 个写具名 RT 的 pass 的 `blendMode` **全部**为 `normal` —— 即 `blendModeToThree` 映射到 `NoBlending`(ONE/ZERO)，**0 例外**；脚本 `research/q-named-rt-blendmode.mjs`，只读、gitignore）。
29. **combo 宏必须跨 stage 合并（2026-09-15，提交 `eab01aa`；缺陷早于 P2，P2 放开准入后才暴露）**：`effect-chain.ts` 在两次 `preprocessWeShader` **之前**，把 vert/frag **两侧**的 `[COMBO]` 默认值合并进同一份 `combos`（序同 wasm 路径 `glsl-to-naga.passCombos`）。依据：WE/lwe 的 combo 是 **per-pass**（lwe `ShaderUnit.cpp:694-714` 互并、WE layerd 两个 unit 共用一份 `shader_info->combos`），而预处理器按**单个 stage** 兜底 ⇒ 一侧从 `[COMBO]` 取 `NOISE 1`、另一侧被 `#if` 裸标识符兜底成 `0` ⇒ frag 引用 vert 未声明的 varying ⇒ **program 链接失败**（链接错误不在 shader info log 里，旧告警看不到原因）⇒ 命中「写具名 RT 的 pass 失败即整条计划放弃」。**不要只特判某个宏**：修掉 `NOISE` 后 `KERNEL` 的 varying 数组长度不匹配会立刻顶上。

## 6. 工作约定

- 回复、注释、文档、**提交信息一律简体中文**；代码、命令、文件名、技术术语保留原文。
- 提交信息**从简**（2026-09-15 用户要求）：标题一行 `type(scope): 中文标题`；正文可选，**最多 3 行**，每行一句（改了什么 / 关键根因一句话 / 怎么验证）。**不贴实验数据、不复述推理过程、不列文件清单** —— 根因、实测数字与遗留一律写进本文件（§5 / §7）与 `docs/` 下的报告，提交信息只留结论与指针。
- **注释从简（用户要求，长期有效）**：默认**只写一行**「是什么 / 为什么」，最多 2 行。**禁止**复述代码、罗列实验数据、贴多段推理或"踩坑史回顾"。
  - 反例（本仓库曾大量存在、已被要求整改）：文件头 25 行根因推导、函数前 10 行背景铺垫、把 A/B 测量数字抄进注释。
  - 正例：`// RT 必须透明清屏，否则效果降 alpha 处会变成黑块（AGENT.md §5.22）`。
  - 根因、实测数字、历史事故一律写进本文件（§5 / §7）或 `docs/`；代码里只留**一句结论 + `AGENT.md §x.y` 指针**。
  - 例外：涉及「不改就会踩回去」的硬约束（如坐标/行序/混合因子），可保留必要的 2-3 行说明，但仍要指向 §5 对应条目。
- 实施前读 `docs/superpowers/specs/` 对应设计文档；重大变更走技能流程（brainstorming → 设计文档 → writing-plans → TDD）。
- 渲染 / 坐标 / 粒子 / 材质语义的改动：先写失败测试，改完跑相关 vitest + 必要时用 §3.3 的端到端渲染验证，最后把结论与遗留如实写进本文件。
- **如实标注**：能力未达成就在 §7 写明，不要宣称「全库支持」。

## 7. 已知遗留（如实状态，勿虚标）

### three.js 默认路径（当前影响用户）

1. **对象级效果链（effects）：P1（2026-09-14）与 P2「具名 RT 图执行器」（2026-09-15）均已达成** —— three 主路径已接通对象级效果链管线（player 对象隔离能力 + `ObjectEffectStage` 编排 + `three-renderer` 装配，接线见 §2.1）；线性链与**具名 RT 图链**由同一执行器按计划执行（语义见 §5.28），**原先「整条跳过 + 去重告警」的降级已删除**，**24 条 RT 图链**（blurprecise×13、blur×3、localcontrast×2、godrays×2、bloom×2、shine×1、bokeh_blur×1）的**模板均已覆盖、链按计划执行** —— 这一句只说**执行器能力**，**不等于画面都已生效**：其中 **10 条不挂链**（下一条）。GTR 的 `opacity`（0.26 + mask）、`scroll`（云滚动）、`waterripple` 属线性链、P1 起生效（曾因混合守卫整条排除，`6bb3d71` 修复，见下方 `colorBlendMode ∈ {6,7,31}` 条）。
   - **计数口径（别混）**：`106 线性 + 24 RT`（130 条效果引用）是**声明口径**（按 effect 链数、不过滤 `visible`）；其中 **1 条线性链的 effect 级 `visible=false`**（`2597392171` obj50 的 `effects/shake`）在生产侧整条跳过（§5.28）⇒ **three 的执行口径 = 105 线性 + 24 RT**。
   - **24 条里有 10 条在画面上看不见（如实标注，不是能力差）**：**7 条挂在 `text` 对象**（收链阶段就被 `groupEffectsByObject` 过滤）、**3 条挂在 `util` 对象**（进链表但拿不到隔离条目 ⇒ 不挂链，只进「未参与渲染的对象类型」的汇总告警）。执行器语义覆盖这些模板，**画面没有变化**；text 对象的渲染本身是独立缺口。
   - **验收覆盖口径（如实标注）**：端到端（headless Edge 真实 WebGL 逐像素）跑过的是下表 11 段样本；其余效果类别的「可正确执行」是**分类学推断**（依据 `effect.json` 的 pass 结构与执行器语义），**不是逐个实测**。
   - **端到端实测**（headless Edge / SwiftShader + `lib/` 生产代码，1280×720，日志 `research/object-effects/rt-graph-run4.log`；脚本在 gitignore 的 `research/`）：**30 PASS / 2 FAIL**，两项 FAIL 都是 `[5]` 的**归因对照**（见下），**不是回归**。

     | 段 | 样本 | 具名 RT 形态 | 实测 |
     |---|---|---|---|
     | `[1]` | `2683211654` | —（线性 waterwaves） | 帧间差分 40.02% PASS |
     | `[2]` | `2911105183` obj210 | —（线性） | 盒内 4019px / **盒外最大差 0** PASS |
     | `[3a]` | `3765967112` | blurprecise 挂 `text`（链不挂载） | 零 console error PASS（**「零跳过告警」这条自 P2 删除该告警起恒真，只作回归占位**） |
     | `[3b]` | `2911105183` | blurprecise（1 张全尺寸） | 同上（此段无帧间差分判据） |
     | `[3d]` | `2011060960` obj634 | blur + localcontrast（**双链同名 RT**） | 帧间 718500px（77.96%）/ 静态贡献 834700px PASS |
     | `[3e]` | `2937346640` obj44 | godrays（scale=2，2 张） | 帧间 **0 → 90px** / 静态贡献 921552px PASS |
     | `[3f]` | `1968789468` obj13 | shine（scale=2，2 张） | 帧间 **0 → 313564px（34.02%）** PASS |
     | `[3g]` | `2597392171` obj50 | godrays | 帧间 863208px（93.66%）/ 静态贡献 739026px PASS |
     | `[3c]` | `3743126786` | bloom 16 pass / **8 张**（scale 2/4/8/16） | isolated=2、零 console error PASS（跳过告警判据同属回归占位） |
     | `[5]` | `3743126786` obj17 | 同上的 bloom 可见性 | 局部增亮 28913px（3.14%）/ **全屏 p99 Δ=0** |
     | `[4]` | `1429403119` | —（性能相对信号） | 两档帧间隔中位数 16.7 ms（SwiftShader，**非门槛**） |

   - 修 §5.29 的 combo 合并**之前**，`[3e]`/`[3f]` 是「pass 编译失败 2 条 + 帧间差分 0px」（写具名 RT 的 pass 失败 ⇒ 整条计划放弃、对象一个效果都没跑），修复后编译失败 **0**。
   - **证据口径的收窄（勿引申）**：`[3e]` 的「静态贡献 921552px（99.99%）」≈ 全画布，更像「摘掉该对象的链后**该对象自身**不再渲染」⇒ 结论只能写到「**链在执行**」，**不可**引申为「godrays 可见」（`[3f]`/`[3g]` 的静态对照同此口径）。
   - **GTR bloom 的可见性只有弱证据（如实标注）**：全屏 p99 **无提升**（Δ=0 —— 「只保留 bloom 链」与「只摘 bloom 链」两种归因对照都是 0；主判据表面的 +17 全部来自同对象其它链 pulse 等）；bloom 的证据只有**局部增亮**（更亮 28913px = 3.14%、maxΔ103、平均亮度 +0.507）。**未与桌面 WE 逐像素对照**（用户未提供截图）。
   - **具名 RT 显存（Task 9 实测）**：下表是**静态分配估算**（不含 mipmap / 驱动对齐 / 纹理与粒子缓冲），**非 GPU 实测**。

     | 指标 | 1080p@dpr1 | 1080p@dpr2 |
     |---|---|---|
     | 具名 RT 全库合计 | **39.0 MB / 28 张** | **124.0 MB / 28 张** |
     | 单壁纸最大 | **11.0 MB**（`2597392171`） | 31.6 MB（`3789452668`） |
     | 单张最大 | **7.91 MB**（`3789452668` 的 `_rt_FullCompoBuffer1`，1920×1080） | 31.6 MB（同一张 3840×2160） |
     | GTR `3743126786` | **5.3 MB / 8 张**（scale 2/4/8/16 的降采样金字塔） | 21.2 MB |
     | 占全库显存（3×对象 RT + 具名 RT） | 约 **6.6%** | 约 **6.6%** |

   - ⇒ 具名 RT 是「对象 RT + ping-pong」主项之外的**小头**，本期**不做显存 cap** 的裁定站得住（落点留在 `buildEffectPlan` 的尺寸计算处）。**注意**：本计划的 spec 早先按「GTR 那 8 张是全尺寸」估过一版（比实测大一个数量级），**那是错的**（已在 spec 订正，实测 5.3 MB）——别再引用那版估算。
   - **仍未修的一条（按裁定不在本次范围）**：`3789452668` 的 `effects/color_grading`（**线性链**）有一个与 §5.29 无关的缺陷 —— `varying` 类型不匹配（`vec4` vs `vec2`）⇒ 该链不生效（改动前后一致）。
   - **`_rt_FullFrameBuffer` 的降级（1 处）**：`2597392171` 的 godrays（pass 5）引用了全局运行时 RT，执行器**不绑白纹**（保持该槽默认）+ 一条去重告警；它的完整语义（当前帧缓冲）属**非目标**。
   - **性能门槛未验证（如实标注，勿据此宣称达标）**：设计文档 §7.4 自定「`1429403119`（23 对象 / 24 条链，全库最重）1080p **FPS ≥ 30**」为验收门槛、§7.5 列为 P1 验收项，但**该门槛尚未在真实 GPU 上验证**。本机唯一的端到端环境是 **headless Edge，其 WebGL 走 SwiftShader（软件光栅化）**，因此 `research/verify-object-effects.mjs` 的 [4] 段给出的只是**相对信号**：帧间隔与每帧耗时的中位数 / p95，外加该壁纸的**隔离对象数**与**对象 RT 总显存估算**（公式：`Σ_隔离对象 rtW × rtH × 4 字节 ×（1 张对象 RT + 有 runner 时 runner 的 2 张 ping-pong RT）`；runner 的 ping-pong 与对象 RT 同尺寸，见 `object-effects.mount`；不计 depth 附件、驱动对齐开销与纹理槽贴图）。**软件光栅化的数字不能替代真机 FPS** —— 门槛状态一律记为「未验证」，真机 FPS 待补验。（[4] 段对 **1280×720 与 1920×1080 两档**都出数：显存随预算变化，只测 720p 会与 §7.4 的 1080p 口径对不上；实测输出见 `research/object-effects/f1-run*.log` 与 `final-fix-report.md`。）
   - **音频响应效果不随频谱动（如实标注）**：three 主路径**没有音频源** —— `createAudioAnalyzer` 只被未接入的 `scene-renderer.ts` 引用，`ObjectEffectStage.advance` 每帧显式给 `EffectRunner` 传 `null`，音频 uniform 保持 binder 初始化的**全零**。因此 `Simple_Audio_Bars` / `audioline` 等属「**效果在、但不随频谱动**」，不是「不支持该效果」。**接音频仍未做**（P2「具名 RT 图执行器」不含音频）。
   - **`colorBlendMode ∈ {6,7,31}` 的对象已进入隔离路径、其效果生效（2026-09-14 修复，提交 `6bb3d71`）**：旧结论「这类对象被有意排除在隔离之外 ⇒ 效果不生效（GTR 的云不滚动）」**已作废**。当时排除的原因仍然成立：这类模式把内容材质的结果 alpha 钉成「背景的 alpha」（`blendSrcAlpha=Zero / blendDstAlpha=One`），而对象 RT 是新清空的缓冲（alpha 0）⇒ RT alpha 恒 0 ⇒ 合成 quad 片元被乘成 0 ⇒ 对象会**整体不可见**（相对改动前是用户可见回归），故 P1 用 `BLEND_ISOLATION_UNSAFE` 换「保可见、牺牲效果」。**修法：把 WE 的混合语义从「内容材质」搬到「合成 quad」** —— 隔离路径的内容材质（`createLayerMaterial(..., forIsolation=true)`）**不再套用** `colorBlendMode` 的 `CustomBlending`，只把自己的 rgb + alpha 用普通 alpha 混合写进清空的 RT；**非隔离**路径（主场景直出）语义逐字不变。`createCompositeQuadMaterial` **统一用 `MeshBasicMaterial`**（采样**非预乘**的对象 RT）并按 `colorBlendMode` 设 `CustomBlending`（Screen → `OneMinusDstColor/One`，alpha 仍 `Zero/One` 保持背景）。`three-renderer` 里的 `BLEND_ISOLATION_UNSAFE` 守卫及其 `warnOnce('blend-isolation:...')` 已删除 —— 这类对象现在**正常进入隔离**、效果**生效**。全库 3 个非零对象：`3743126786` Clouds Back=7、`2832263418` audio_rainbow=6、`2460786246` Clock=31。
        - **实测证据（headless Edge、`lib/` 生产代码、dpr=1、`--no-particles`；报告 `.superpowers/sdd/2026-09-14-three-object-effects-pipeline/cloud-scroll-report.md`）**：① `--only-effect=2944127259/scroll` 相位 5 vs 6 变化 **68604 像素（7.44%）**，**全部落在 Clouds Back 的 quad 矩形内、矩形外 0 变化**；最优位移 **dx = −17px**（向左），与 `scroll.vert` 的 `speedx²·g_Time`（0.14²×1s = 0.0196 UV × 869px = **17.0px**）吻合；② **对象仍可见**：云区与「无效果」地板对照 MAD=0.925、平均亮度 59.51 vs 59.59；③ 三条链都生效（仅 `effects/opacity` 时云区平均亮度 59.51→41.10）；所有运行 console error = 0；单测 112 项全过。
        - **如实标注**：`colorBlendMode` 的 Screen 语义（`op·B`）是靠「内容以普通 alpha 混合写进清空 RT ⇒ RT.rgb 天然带 ×content-alpha」实现的，**未与桌面 WE 做逐像素对照**；e2e 只跑了 **dpr=1** 且全关粒子（`--no-particles` + `wasm=none`），**粒子隔离路径未端到端复验**。
        - **测量口径澄清**：本条的局部化结论由 **bbox 判据**独立支撑（变化像素是否全部落在对象 quad 矩形内），**不依赖百分比** —— 临时脚本 `research/q-diff-grid.mjs` 早期按固定 **4 通道**步进解码，而 headless Edge 的截图是 **RGB 3 通道**，会把变化算到无关像素上（表现为「铺满整宽 + 周期性花纹」）；该 bug 已修，**早期基于它的百分比数字（如「68% 全图」「68%→4%」）不可用、不应引用**。
   - **粒子对象的效果链只有单测覆盖**：全库实测 **particle 挂载 effects = 0**（effects 挂载对象类型分布 `{util:10, image:109, particle:0, none:11}`），管线里的粒子隔离分支**无真实样本可验**，只有单测覆盖。
   - **21 条 effects 挂在 util / 音频等不参与渲染的对象类型上**（util:10 + none:11）：会被解析但**不会挂链**（`loadSceneToThree` 不渲染它们，也就没有隔离条目），每张壁纸打一条汇总 `warn`。**P2 后依旧如此** —— 执行器已支持这些链的模板，缺的是这类对象本身的渲染，属遗留。
   - **text 对象的 effects 被静默丢弃（比 util/音频更彻底）**：`groupEffectsByObject`（`src/client/object-range.ts`）跳过 `kind === 'text'` 的对象，链在**解析阶段**就不进 `effectChains` —— 因此这类效果**连上面那条汇总 warn 都没有**。实测样本：`3765967112` 的 4 条 `blurprecise` 全部挂在 text 对象上（obj 71/79/89/117），这也是「拿该壁纸验证具名 RT 告警会得到 0 条」的原因。**P2 已落地但不覆盖它**（执行器支持这类链的模板，缺的是 text 对象渲染本身）。
   - **`refraction` 在 GLSL3 下的编译失败：已修（2026-09-15）**：报错源码是 `common_fragment.h` 的 `ConvertTextureFormat(const int format, …)` —— 预处理把 `if (format == FORMAT_RG88 || format == FORMAT_RG1616F)` 里的 `format` 包成了 `float(format)`，生成 `float(format) == FORMAT_RG88`（float 与 int 比较）⇒ `0:254: '==' : wrong operand types` ⇒ `2911105183` obj 304 的 `effects/refraction` 整条 pass 被跳过。**根因**是 `floatifyIntVarUses` 里两条**单侧**比较保护规则的**顺序错了**：右侧规则（`(op)\s*ident`）先跑，把运算符一起吞进保护段，左侧规则再也匹配不到左操作数，剩下的 int 变量被 float() 包裹。**修法**：把比较表达式 `LHS op RHS` 整体先保护（整条规则在前），单侧规则退化为兜底；回归用例见 `tests/shader-preprocessor.test.ts`（`format == FORMAT_RG88` 保持 int、不再出现 `float(format) ==`）。复验：同一页面（`research/tmp-2911105183/render-lab.mjs`）console 里**不再有**「效果 pass 编译失败」告警。**上一轮（2026-09-14）已修的是「失败不被缓存」**（此前 `EffectRunner.getMaterial` 不缓存编译失败状态：`update()` 每帧重试 ⇒ 每帧重建材质 + 1×1 探针渲染 + 2 条 warning，实测该页 **146×2 条**刷屏）：现在 `failed` 集合按 pass key 缓存失败，同一 key 只试一次（`setChains` 时清空重试），告警也改为**每个失败 key 一条**、且带上壁纸 id / 具名 RT / 纹理槽等**可辨识标识**。
   - **`CP_ads_01/02` 的 WE 视频纹理已实现（2026-09-15）**：这两张 `.tex` 的载荷是完整 mp4（`flags=35`/bit5 Video、`imageFormat=-1`），现在走 `<video>` + `THREE.VideoTexture` 原生解码，广告牌恢复成动态广告（此前被当原始像素解码 ⇒ 乱码/黑块/透明）。实现、约束与实测见 §5.23；**未实现**：视频音频（这两个 mp4 本身无音轨）、与场景时间同步、H.265/WebM、精灵表式视频、视频纹理当效果槽时的独立释放。
   - ~~**链全为具名 RT 图链的对象不再隔离（P2 前置优化）**~~：**已作废（2026-09-15，P2）** —— `rtGraphOnly` 分支、其「不再隔离」告警与下面那条「具名 RT 图链的告警」全部删除，isolate 准入回到「至少有一条**可见**链」（§5.28）；原先因全为具名 RT 链而不隔离的对象（`2132420420` obj13 等）重新进入隔离路径 —— 付出对象 RT 显存与每帧一次额外渲染，换来效果生效。**以下为该优化存在时的历史描述**：`three-renderer` 的 isolate 准入从「有 effects」收紧为「**至少有一条线性链**」——链全是具名 RT 图链时 `setObjectChains` 整条跳过（不建 runner），对象 RT 的显存与每帧一次额外渲染 + 一次 RT 切换完全没有收益，而合成 quad 永远采样 RT 原图 ⇒ **隔离没有额外视觉收益**（口径提示：隔离路径与直接渲染**并非位级等价** —— 对象 RT 是 8 位量化、alpha 经预乘往返、预算收口时 quad 为放大采样；此处只主张「无收益」，不主张「逐像素相同」）。实测样本：`2132420420` obj 13（3840×2160，约 31.6 MB 对象 RT + 每帧一次额外渲染）。这类**渲染对象**的「具名 RT 未实现，跳过」告警**仍然打印**（带具名 RT 标识与对象 id，不因省掉隔离而静默），也不再计入「挂在未参与渲染的对象类型上」的汇总；util / text 对象照旧计入那条汇总（它们本来就不渲染，隔离与否与它们无关）。
   - **具名 RT 图链的跳过告警**：**已删除（2026-09-15）** —— 具名 RT 链现已可执行，不再有「效果需要具名 RT（P2 未实现），跳过」这条告警（原先按标识去重、每张壁纸每个效果标识打印一次）。
2. **`colorBlendMode` 只实现了 6/7/31**：其余模式（Darken / Multiply / Overlay / Hue … 见 §5.6）回退普通 alpha 混合。全库目前只有那 3 个对象用到非零值，新出现未实现模式时要补。
3. **粒子 quad 不含 `rot`（自旋）**：`rotationrandom` / `angularvelocityrandom` 计算了但未参与渲染。
4. ~~**`copybackground: true` 的图层走隔离路径时接近全黑**~~ —— **已修（2026-09-15）**：真因不是 `copybackground` 语义缺失，而是「渲染进 RT 时清屏 alpha=1 ⇒ 内容透明处变不透明黑」（见 §5.22）。同一 A/B（把 `renderer.setClearAlpha` 打成 no-op 复现旧行为）：旧行为 `2597392171` 成品均值 **14.03/255**（与 2026-09-14 记录的 15.3 / 14.98 一致）、黑像素 86.6%；修复后 **83.99/255**（对齐「去掉 effects 直渲」的 81.0）、黑像素 **0.0%**。当初的「疑因（RT 清成透明黑 ⇒ 内容近乎空）」方向对了，但**清的不是透明黑而是不透明黑**，这才是整屏发黑的关键。**仍存**：`copybackground` 的「先拷贝下方背景再跑效果链」语义仍未实现（水面倒影/涟漪读背景副本的场景会缺内容）。（**2026-09-15 订正**：effect 级 `visible === false` **现已解析** —— 全库 1 条 = 该对象 obj50 的 `effects/shake`，按 lwe `CImage::setupPasses` 语义整条跳过、**不打降级告警**；绑定脚本属性的其它可见性仍未处理。）

### 备用 wasm / JS 路径

4. **GPU（wasm）路径未消费 `instanceoverride`，也未应用对象 `angles`**：只接了 three 路径。用备用路径渲染同一张壁纸会有亮度与朝向差。
5. **wasm 效果链对 visualizer / text 对象不生效**：这两类对象恒走共享场景路径（绕过对象 RT / 效果链），带 effects 时效果被忽略（`groupEffectsByObject` 跳过 text；visualizer 是脚本控制节点）。
5. **3 张壁纸在 wasm 路径判为 STATIC**（`2851992662` / `3392903359` / `3760200530`）：均无对象级 effects，动画源是粒子（leaves/snow/bubbles）。内容保留、非黑屏、`ctx=webgpu`；对照 godrays `2937346640`（`diff500=98.8%` PASS）说明效果链正常 —— 根因是 **wasm 共享粒子路径动画未可见**，属独立问题待专项排查。
6. **particle 对象效果链未被真实壁纸验证**：`set_particle_object_effect` 已实现，但库内没有「带 effects 的 particle 对象」被触发。
7. **`g_ModelViewProjectionMatrix` 未由执行器提供**（材质 json 不给值 → 默认 0）。库内依赖 MVM 的效果都是「frag 效果 + vert passthrough」，故不受影响；仅 vert 阶段真正用 MVM 的效果链会出问题。
8. **`collect_bindings` 用文本扫描从 WGSL 提取纹理绑定**，对更复杂的多纹理 shader 待改进（库内 shader 已验证可用）。**另：其 RT 图执行器的 `bind` 索引语义与 lwe 不符** —— `resolve_pass_read`（`effect.rs`）只取 `bind[0]` 决定唯一读端、按 `g_Texture(i+1)` 对齐，权威语义是 `bind.index → g_Texture<index>`；该路径未接入运行时，本次未改（§2.1）。

### 验证与其它

9. **`verify-wasm-render.mjs` 跑不通**：硬编码 `?token=` 过期（401）。替代：`research/verify-colorblend.mjs` 的「自起 server + headless Edge + esbuild harness」模式（不依赖 token），以及 node 侧直接驱动 wasm `CpuParticleSim`（`research/gtr-verify-fix.mjs`）。
10. **headless Edge 的 WebGPU 是 SwiftShader（软件光栅化）**，非真实 GPU：性能 / FPS 与部分行为需在真实 GPU 上补验。
11. **全量 `vitest run` 有 15 项既有失败**（4 个文件：`wasm-renderer` 7 / `scene-renderer` 6 / `verify-real-library` 1 / `dom/bootstrap.dom` 1），均已确认在 v0.3.0 基线即失败；改动后请在 `git stash` 基线对比，**别把既有失败当成本次回归**。
    其中 `wasm-renderer` 那 7 项已定位到一半（2026-09-11）：`createWasmSceneRenderer.render()` 的**裸 `catch {}`** 把异常静默吞成「返回 false」，测试只看到 `expected false to be true`（现已补上 `console.warn`）。补日志后可见第一层真因是 **mock 与代码脱节**（mock scene 缺 `set_particle_sim` / `update_particles`）；但补全 mock 后 render 虽能成功，又会暴露更深一层的断言问题（`scene.add_particle` 未被调用，疑与 mock 的 fetch 匹配或分流条件有关），需专项排查 —— 那 7 项目前仍维持原状。
12. **e2e harness 多调一次 `onViewportResize`，掩盖了挂载期的 RT 尺寸缺陷（2026-09-14 补充，是本轮 `3fd6b00` 漏检的直接原因）**：`research/verify-hidpi-object-rt.mjs`（入口 `research/harness-object-effects-entry.mjs`）**走的就是生产入口** —— 它 import 并调用 `createThreeSceneRenderer()`（`harness-object-effects-entry.mjs:36` / `:295-296`），**没有自己复制一套 isolate 尺寸/装配逻辑**（只做只读观测）。真正让挂载期缺陷在 e2e 里消失的机制是它在页面就绪后**额外多调了一次** `window.__fxApplyViewport()`（`:164-170`）：该函数做 `player.resize(VW, VH)` + **`stage.onViewportResize(VW × dpr, VH × dpr)`**（`:169-170`），而 `onViewportResize` 按 stage 自己持有的**未钳制** `worldW/worldH` 重算 RT（`src/client/object-effects.ts:188-211`）—— **覆盖了 `three-renderer` 在挂载期算错的那次初始 RT 尺寸**（同一类缺陷的实测例：`resolveObjectRtSize(4096, 4096, 1, 1280, 720) = 720×720`，改用未钳制的 `world` 后为 `1280×714`，见 §5.15 ②）。于是生产（真机、从不 resize）首帧用的是 `range` 收口的错误值 ⇒ 糊，而 e2e 观测到的是 resize 后的正确值 ⇒ 全绿。**已落地（2026-09-14）**：harness 已新增**挂载期 RT 尺寸断言** —— 在 `window.__fxApplyViewport()` **之前**采样 `player.isolatedObjects()` 的 `rtWidth/rtHeight`，配**独立 oracle** 期望值（**2026-09-14 换口径后为 `|world| × 屏幕密度`（画布缓冲宽 / cover 视锥宽）等比收口 4096**，改动前为 `min(world × dpr, 视口 × dpr, 4096)`；刻意不 import lib 的尺寸函数，oracle 自己重实现 cover 数学），verify 在偏差时标红 + `[FAIL]` + 非零退出；**变异实验**（把 `three-renderer` 两处临时改回 `range` 基准）证明它确实有效：基线 `[PASS]/EXIT=0`、变异 `[FAIL]/EXIT=1`，且变异输出里同时可见「挂载期 = 缺陷公式值」与「resize 后 = 正确值」——掩盖机制当场暴露。⚠️ 断言的期望口径必须是**实际挂载期视口/密度**（headless 窗口为 1400×900），**不能**拿声明视口（1280×720）当预算，否则未变异的基线也会假阳性；`__fxApplyViewport()` 现在按**生产同一路径**调 `stage.onViewportResize(player.screenScalePx())`（旧签名是传 `VW×dpr, VH×dpr` 两个预算数）。仍存的两个边界：该断言不覆盖「RT 尺寸对但贴屏映射错」类缺陷；掩盖假设依赖「`ThreeScenePlayer.resize()` 不改隔离 RT、只有 `ObjectEffectStage.onViewportResize` 会覆盖」这一源码事实（若 harness 将来在 `render()` 前/中触发 resize，掩盖可能重现）。（口径提示：`research/` 与 `.superpowers/` 均 gitignore，脚本改动不入提交。）
