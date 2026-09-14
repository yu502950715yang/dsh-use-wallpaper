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
- **未接入的路径**：`wasm-renderer.ts`（`createWasmSceneRenderer` / `createFallbackSceneRenderer`）与 `scene-renderer.ts` 的 `renderScene` **源码与单测保留，但运行时不再调用**（`index.ts` 仍 import wasm-renderer 但未使用）。wasm 渲染器有**完整的对象效果链**（对象 RT + 局部正交相机 + `EffectChain` ping-pong + 合成 quad UV 窗口 + GLSL→SPIR-V→WGSL 编译链）；three 路径**已接通对象级效果链（P1，2026-09-14）**，但**具名 RT 图链**（blur / blurprecise / godrays / bloom / shine / localcontrast / bokeh_blur，全库 **24 条**）仍未实现 —— 这是与 wasm 侧相比**剩余**的能力差，见 §7.1。
- `isThreeUse()` / `THREE_USE=1` 是历史遗留（three 早已是默认）。

### 2.2 host / client / shared 分层

- `src/host/`：Node 侧（Cordis 插件）。`scanner.ts` 扫描目录 → `WallpaperInfo`；`steam-paths.ts` 目录探测（`/wallpapers/probe`）；`pkg-reader.ts` 解包 PKGV0001；`routes.ts` HTTP 路由（读可变运行时目录，settings 热更新）；`settings.ts` 插件设置。
- `src/client/`：浏览器侧（esbuild → `dist/client.js`，external react 等 DSH 共享模块）。`index.ts` 入口（bootstrap + `window.__wallpaperEngine` + 注册设置菜单）；`settings-section.tsx` 设置面板；`wallpaper-controller.ts` 选择/竞态/回退链；**`three-renderer.ts` + `threejs-player.ts` 是当前渲染主路径**；`wasm-renderer.ts` / `scene-renderer.ts` 为未接入的备用实现；**`object-effects.ts`（`ObjectEffectStage` 编排器）+ `object-range.ts`（对象范围/合成几何/UV 窗口等纯函数）是主路径的对象级效果链模块**，`effect-runner.ts`（`EffectRunner` 执行器）与 `shader/effect-chain.ts`（`resolveEffectChain` 链解析）自 2026-09-14 起被它们**接入主路径**（此前仅被未接入的 `scene-renderer.ts` 使用）；`tex-loader.ts` TEXV0005 解码；`scene-json.ts` scene.json 解析；`background-layer.ts` / `settings.ts` / `styles.ts`。
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
15. **对象级 RT 的三条不变量（2026-09-14 真机 bug 修复回写，对应 `076ad36` / `ecfcc10` / `3fd6b00`；改这块先读代码注释）**：
    - ① **局部正交相机的 left/right/top/bottom 是「世界坐标范围」**，对象内容也以世界单位绘制 ⇒ 相机必须覆盖**完整对象世界尺寸**（`Math.abs(worldW/worldH)`，`threejs-player.ts:796-807`）。两个踩过的坑：**拿 RT 像素当范围**（`076ad36`）⇒ dpr>1 时相机多覆盖 dpr 倍、内容只占 RT 的 1/dpr、合成 quad 再按全窗口拉回世界尺寸 ⇒ 对象缩小 + 边缘 clamp 拉伸（HiDPI 真机整张壁纸错乱；headless 里 `dpr ≡ 1` 时 rt == world，故端到端漏检）；**按 `OBJECT_RT_MAX`(4096) 钳制范围**（`ecfcc10`）⇒ RT 只覆盖对象中央，UV 窗口外侧被 CLAMP 采样 ⇒ **边缘拉伸带**（GTR `3743126786` 背景对象世界宽 7430 > 4096 ⇒ 右侧 22% 画面宽是条纹）。超限对象的正确代价是「**分辨率低**」（欠采样），**不是**几何裁剪。
    - ② **RT 的像素尺寸 = `min(world × dpr, 视口 × dpr, 4096)`**（`resolveObjectRtSize`，`src/client/object-effects.ts:53-77`）—— 基准必须是**未钳制**的 `world`（image = `|size × scale|`、particle = `particleWorldSize`），**不能**用 `objectCameraRange` / `particleObjectRange` 的 `range`（那是「相机范围」语义、逐轴钳到 4096；`3fd6b00`）：实测 `resolveObjectRtSize(4096, 4096, 1, 1280, 720)` = **720×720**，贴回屏幕要放大 1.78× ⇒ 大幅背景壁纸整层明显模糊；改用 world `7430×4147` 得 `1280×714`。image 与 particle 两条路径都如此（`three-renderer.ts:325-336`、`:348-357`）。
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

## 6. 工作约定

- 回复、注释、文档、**提交信息一律简体中文**；代码、命令、文件名、技术术语保留原文。
- 提交信息格式：`type(scope): 中文标题` + 中文正文（正文说清「根因 / 改法 / 验证证据」）。
- 实施前读 `docs/superpowers/specs/` 对应设计文档；重大变更走技能流程（brainstorming → 设计文档 → writing-plans → TDD）。
- 渲染 / 坐标 / 粒子 / 材质语义的改动：先写失败测试，改完跑相关 vitest + 必要时用 §3.3 的端到端渲染验证，最后把结论与遗留如实写进本文件。
- **如实标注**：能力未达成就在 §7 写明，不要宣称「全库支持」。

## 7. 已知遗留（如实状态，勿虚标）

### three.js 默认路径（当前影响用户）

1. **对象级效果链（effects）：P1 已达成，P2 遗留 24 条具名 RT 图链** —— three 主路径已接通对象级效果链管线（player 对象隔离能力 + `ObjectEffectStage` 编排 + `three-renderer` 装配，接线见 §2.1），全库 **106/130 条效果引用（82%）** 可由既有 `EffectRunner` 正确执行（waterwaves 24 / shake 18 / opacity 8 / waterripple 7 / waterflow、pulse、perspective 各 5 / clouds、scroll、foliagesway 各 4 …）。**验收覆盖口径（如实标注）**：其中**端到端（真实 WebGL 逐像素）验证的样本**只有 `2683211654`（waterwaves 帧间差分）与 `2911105183`（对象级盒内外判据 + 具名 RT 降级告警）；其余效果类别的「可由现有执行器正确执行」是**分类学推断**（依据 `effect.json` 的 pass 结构与 `EffectRunner` 的线性语义），**不是逐个实测**。**P2 遗留**：**24 条**具名 RT 图链（blurprecise×13、blur×3、localcontrast×2、godrays×2、bloom×2、shine×1、bokeh_blur×1）需要「RT 图执行器」（具名 RT 池 + `fbos` 降采样 + `bind` 语义），当前**整条跳过 + 去重告警** —— **画面不画错，但那些效果不生效**。GTR 的 `opacity`（0.26 + mask）、`scroll`（云滚动）、`waterripple` 都属线性链、已纳入 P1 执行范围（改动前它们全部失效，表现为 GTR 的云比桌面端略亮）—— 但这三条挂在 cbm=7 的 `Clouds Back` 上，一度被混合守卫整条排除（云不滚动），已于 `6bb3d71` 修复生效（见下方 `colorBlendMode ∈ {6,7,31}` 条）。**wasm 备用路径有完整效果链**。（详细设计：`docs/superpowers/specs/2026-09-14-three-object-effects-pipeline-design.md`。）P2 补 RT 图执行器的成本比 wasm 侧低：three 是 WebGL，WE 的效果 GLSL 可直接用，无需 wasm 侧的 GLSL→SPIR-V→WGSL 编译链。
   - **性能门槛未验证（如实标注，勿据此宣称达标）**：设计文档 §7.4 自定「`1429403119`（23 对象 / 24 条链，全库最重）1080p **FPS ≥ 30**」为验收门槛、§7.5 列为 P1 验收项，但**该门槛尚未在真实 GPU 上验证**。本机唯一的端到端环境是 **headless Edge，其 WebGL 走 SwiftShader（软件光栅化）**，因此 `research/verify-object-effects.mjs` 的 [4] 段给出的只是**相对信号**：帧间隔与每帧耗时的中位数 / p95，外加该壁纸的**隔离对象数**与**对象 RT 总显存估算**（公式：`Σ_隔离对象 rtW × rtH × 4 字节 ×（1 张对象 RT + 有 runner 时 runner 的 2 张 ping-pong RT）`；runner 的 ping-pong 与对象 RT 同尺寸，见 `object-effects.mount`；不计 depth 附件、驱动对齐开销与纹理槽贴图）。**软件光栅化的数字不能替代真机 FPS** —— 门槛状态一律记为「未验证」，真机 FPS 待补验。（[4] 段对 **1280×720 与 1920×1080 两档**都出数：显存随预算变化，只测 720p 会与 §7.4 的 1080p 口径对不上；实测输出见 `research/object-effects/f1-run*.log` 与 `final-fix-report.md`。）
   - **音频响应效果不随频谱动（如实标注）**：three 主路径**没有音频源** —— `createAudioAnalyzer` 只被未接入的 `scene-renderer.ts` 引用，`ObjectEffectStage.advance` 每帧显式给 `EffectRunner` 传 `null`，音频 uniform 保持 binder 初始化的**全零**。因此 `Simple_Audio_Bars` / `audioline` 等属「**效果在、但不随频谱动**」，不是「不支持该效果」。接音频留 P2。
   - **`colorBlendMode ∈ {6,7,31}` 的对象已进入隔离路径、其效果生效（2026-09-14 修复，提交 `6bb3d71`）**：旧结论「这类对象被有意排除在隔离之外 ⇒ 效果不生效（GTR 的云不滚动）」**已作废**。当时排除的原因仍然成立：这类模式把内容材质的结果 alpha 钉成「背景的 alpha」（`blendSrcAlpha=Zero / blendDstAlpha=One`），而对象 RT 是新清空的缓冲（alpha 0）⇒ RT alpha 恒 0 ⇒ 合成 quad 片元被乘成 0 ⇒ 对象会**整体不可见**（相对改动前是用户可见回归），故 P1 用 `BLEND_ISOLATION_UNSAFE` 换「保可见、牺牲效果」。**修法：把 WE 的混合语义从「内容材质」搬到「合成 quad」** —— 隔离路径的内容材质（`createLayerMaterial(..., forIsolation=true)`）**不再套用** `colorBlendMode` 的 `CustomBlending`，只把自己的 rgb + alpha 用普通 alpha 混合写进清空的 RT；**非隔离**路径（主场景直出）语义逐字不变。`createCompositeQuadMaterial` **统一用 `MeshBasicMaterial`**（采样**非预乘**的对象 RT）并按 `colorBlendMode` 设 `CustomBlending`（Screen → `OneMinusDstColor/One`，alpha 仍 `Zero/One` 保持背景）。`three-renderer` 里的 `BLEND_ISOLATION_UNSAFE` 守卫及其 `warnOnce('blend-isolation:...')` 已删除 —— 这类对象现在**正常进入隔离**、效果**生效**。全库 3 个非零对象：`3743126786` Clouds Back=7、`2832263418` audio_rainbow=6、`2460786246` Clock=31。
        - **实测证据（headless Edge、`lib/` 生产代码、dpr=1、`--no-particles`；报告 `.superpowers/sdd/2026-09-14-three-object-effects-pipeline/cloud-scroll-report.md`）**：① `--only-effect=2944127259/scroll` 相位 5 vs 6 变化 **68604 像素（7.44%）**，**全部落在 Clouds Back 的 quad 矩形内、矩形外 0 变化**；最优位移 **dx = −17px**（向左），与 `scroll.vert` 的 `speedx²·g_Time`（0.14²×1s = 0.0196 UV × 869px = **17.0px**）吻合；② **对象仍可见**：云区与「无效果」地板对照 MAD=0.925、平均亮度 59.51 vs 59.59；③ 三条链都生效（仅 `effects/opacity` 时云区平均亮度 59.51→41.10）；所有运行 console error = 0；单测 112 项全过。
        - **如实标注**：`colorBlendMode` 的 Screen 语义（`op·B`）是靠「内容以普通 alpha 混合写进清空 RT ⇒ RT.rgb 天然带 ×content-alpha」实现的，**未与桌面 WE 做逐像素对照**；e2e 只跑了 **dpr=1** 且全关粒子（`--no-particles` + `wasm=none`），**粒子隔离路径未端到端复验**。
        - **测量口径澄清**：本条的局部化结论由 **bbox 判据**独立支撑（变化像素是否全部落在对象 quad 矩形内），**不依赖百分比** —— 临时脚本 `research/q-diff-grid.mjs` 早期按固定 **4 通道**步进解码，而 headless Edge 的截图是 **RGB 3 通道**，会把变化算到无关像素上（表现为「铺满整宽 + 周期性花纹」）；该 bug 已修，**早期基于它的百分比数字（如「68% 全图」「68%→4%」）不可用、不应引用**。
   - **粒子对象的效果链只有单测覆盖**：全库实测 **particle 挂载 effects = 0**（effects 挂载对象类型分布 `{util:10, image:109, particle:0, none:11}`），管线里的粒子隔离分支**无真实样本可验**，只有单测覆盖。
   - **21 条 effects 挂在 util / 音频等不参与渲染的对象类型上**（util:10 + none:11）：会被解析但**不会挂链**（`loadSceneToThree` 不渲染它们，也就没有隔离条目），每张壁纸打一条汇总 `warn`。属 P2 范围。
   - **text 对象的 effects 被静默丢弃（比 util/音频更彻底）**：`groupEffectsByObject`（`src/client/object-range.ts`）跳过 `kind === 'text'` 的对象，链在**解析阶段**就不进 `effectChains` —— 因此这类效果**连上面那条汇总 warn 都没有**。实测样本：`3765967112` 的 4 条 `blurprecise` 全部挂在 text 对象上（obj 71/79/89/117），这也是「拿该壁纸验证具名 RT 告警会得到 0 条」的原因。属 P2 范围（text 对象的渲染本身也是缺口）。
   - **`refraction` 在 GLSL3 下编译失败；失败缓存已修，效果本身仍未生效**（实测 2026-09-14）：`effects/refraction/effect.json`（`2911105183` obj 304）的 shader 写 `float(format) == FORMAT_RG88`（float 与 int 比较），报 `0:254: '==' wrong operand types`，该效果**实际未生效**（pass 级跳过 ⇒ 画面不画错）。**本轮已修的是「失败不被缓存」**（此前 `EffectRunner.getMaterial` 不缓存编译失败状态：`update()` 每帧重试 ⇒ 每帧重建材质 + 1×1 探针渲染 + 2 条 warning，实测该页 **146×2 条**刷屏）：现在 `failed` 集合按 pass key 缓存失败，同一 key 只试一次（`setChains` 时清空重试，链变了才重新尝试），告警也改为**每个失败 key 一条**、且带上壁纸 id / 具名 RT / 纹理槽等**可辨识标识的字符串**（此前把错误对象丢进 `console.warn`，日志里显示成 `Object Object`、不含对象 / 效果名）。⚠️ 该 shader 的编译错误本身（引擎源码缺陷）**未修**，效果仍不生效 —— 属 P2。
   - **链全为具名 RT 图链的对象不再隔离（P2 前置优化）**：`three-renderer` 的 isolate 准入从「有 effects」收紧为「**至少有一条线性链**」——链全是具名 RT 图链时 `setObjectChains` 整条跳过（不建 runner），对象 RT 的显存与每帧一次额外渲染 + 一次 RT 切换完全没有收益，而合成 quad 永远采样 RT 原图 ⇒ **隔离没有额外视觉收益**（口径提示：隔离路径与直接渲染**并非位级等价** —— 对象 RT 是 8 位量化、alpha 经预乘往返、预算收口时 quad 为放大采样；此处只主张「无收益」，不主张「逐像素相同」）。实测样本：`2132420420` obj 13（3840×2160，约 31.6 MB 对象 RT + 每帧一次额外渲染）。这类**渲染对象**的「具名 RT 未实现，跳过」告警**仍然打印**（带具名 RT 标识与对象 id，不因省掉隔离而静默），也不再计入「挂在未参与渲染的对象类型上」的汇总；util / text 对象照旧计入那条汇总（它们本来就不渲染，隔离与否与它们无关）。
   - **具名 RT 图链的告警**：按标识去重，**每张壁纸每个效果标识打印一次**（同一效果被多个对象引用不刷屏）。
2. **`colorBlendMode` 只实现了 6/7/31**：其余模式（Darken / Multiply / Overlay / Hue … 见 §5.6）回退普通 alpha 混合。全库目前只有那 3 个对象用到非零值，新出现未实现模式时要补。
3. **粒子 quad 不含 `rot`（自旋）**：`rotationrandom` / `angularvelocityrandom` 计算了但未参与渲染。

### 备用 wasm / JS 路径

4. **GPU（wasm）路径未消费 `instanceoverride`，也未应用对象 `angles`**：只接了 three 路径。用备用路径渲染同一张壁纸会有亮度与朝向差。
5. **wasm 效果链对 visualizer / text 对象不生效**：这两类对象恒走共享场景路径（绕过对象 RT / 效果链），带 effects 时效果被忽略（`groupEffectsByObject` 跳过 text；visualizer 是脚本控制节点）。
5. **3 张壁纸在 wasm 路径判为 STATIC**（`2851992662` / `3392903359` / `3760200530`）：均无对象级 effects，动画源是粒子（leaves/snow/bubbles）。内容保留、非黑屏、`ctx=webgpu`；对照 godrays `2937346640`（`diff500=98.8%` PASS）说明效果链正常 —— 根因是 **wasm 共享粒子路径动画未可见**，属独立问题待专项排查。
6. **particle 对象效果链未被真实壁纸验证**：`set_particle_object_effect` 已实现，但库内没有「带 effects 的 particle 对象」被触发。
7. **`g_ModelViewProjectionMatrix` 未由执行器提供**（材质 json 不给值 → 默认 0）。库内依赖 MVM 的效果都是「frag 效果 + vert passthrough」，故不受影响；仅 vert 阶段真正用 MVM 的效果链会出问题。
8. **`collect_bindings` 用文本扫描从 WGSL 提取纹理绑定**，对更复杂的多纹理 shader 待改进（库内 shader 已验证可用）。

### 验证与其它

9. **`verify-wasm-render.mjs` 跑不通**：硬编码 `?token=` 过期（401）。替代：`research/verify-colorblend.mjs` 的「自起 server + headless Edge + esbuild harness」模式（不依赖 token），以及 node 侧直接驱动 wasm `CpuParticleSim`（`research/gtr-verify-fix.mjs`）。
10. **headless Edge 的 WebGPU 是 SwiftShader（软件光栅化）**，非真实 GPU：性能 / FPS 与部分行为需在真实 GPU 上补验。
11. **全量 `vitest run` 有 15 项既有失败**（4 个文件：`wasm-renderer` 7 / `scene-renderer` 6 / `verify-real-library` 1 / `dom/bootstrap.dom` 1），均已确认在 v0.3.0 基线即失败；改动后请在 `git stash` 基线对比，**别把既有失败当成本次回归**。
    其中 `wasm-renderer` 那 7 项已定位到一半（2026-09-11）：`createWasmSceneRenderer.render()` 的**裸 `catch {}`** 把异常静默吞成「返回 false」，测试只看到 `expected false to be true`（现已补上 `console.warn`）。补日志后可见第一层真因是 **mock 与代码脱节**（mock scene 缺 `set_particle_sim` / `update_particles`）；但补全 mock 后 render 虽能成功，又会暴露更深一层的断言问题（`scene.add_particle` 未被调用，疑与 mock 的 fetch 匹配或分流条件有关），需专项排查 —— 那 7 项目前仍维持原状。
12. **e2e harness 多调一次 `onViewportResize`，掩盖了挂载期的 RT 尺寸缺陷（2026-09-14 补充，是本轮 `3fd6b00` 漏检的直接原因）**：`research/verify-hidpi-object-rt.mjs`（入口 `research/harness-object-effects-entry.mjs`）**走的就是生产入口** —— 它 import 并调用 `createThreeSceneRenderer()`（`harness-object-effects-entry.mjs:36` / `:295-296`），**没有自己复制一套 isolate 尺寸/装配逻辑**（只做只读观测）。真正让挂载期缺陷在 e2e 里消失的机制是它在页面就绪后**额外多调了一次** `window.__fxApplyViewport()`（`:164-170`）：该函数做 `player.resize(VW, VH)` + **`stage.onViewportResize(VW × dpr, VH × dpr)`**（`:169-170`），而 `onViewportResize` 按 stage 自己持有的**未钳制** `worldW/worldH` 重算 RT（`src/client/object-effects.ts:188-211`）—— **覆盖了 `three-renderer` 在挂载期算错的那次初始 RT 尺寸**（同一类缺陷的实测例：`resolveObjectRtSize(4096, 4096, 1, 1280, 720) = 720×720`，改用未钳制的 `world` 后为 `1280×714`，见 §5.15 ②）。于是生产（真机、从不 resize）首帧用的是 `range` 收口的错误值 ⇒ 糊，而 e2e 观测到的是 resize 后的正确值 ⇒ 全绿。**待改**：把断言钉在**挂载期**的 RT 尺寸上（而不是依赖一次 resize 去修正它），此后同类缺陷才能被 e2e 覆盖。（口径提示：`research/` 与 `.superpowers/` 均 gitignore，脚本改动不入提交。）
