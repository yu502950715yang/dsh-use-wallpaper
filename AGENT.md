# AGENT.md

本文件供 AI 编程助手快速了解 `dsh-use-wallpaper` 仓库。改动代码前请通读本文件与相关设计文档（见 §5）。

## 1. 项目概述

**dsh-use-wallpaper** 是一个 DSH（DeepSeek Harness）插件仓库，为 DSH Web GUI 提供 **Wallpaper Engine 壁纸背景**：扫描 Steam workshop 壁纸目录（默认 `D:/Steam/steamapps/workshop/content/431960`，2026-08-21 起不再写死——设置 → 壁纸 面板可自动探测（注册表 + libraryfolders.vdf + 常见路径，见 `src/host/steam-paths.ts`）或手动填写，settings 热更新），在浏览器中渲染 scene 壁纸 / 播放视频壁纸 / 加载 web 壁纸，其余回退 preview 图 + Ken Burns。壁纸切换入口在 **DSH 设置对话框侧边栏「壁纸」菜单**（client 经 `settings.section` slot 注册，见 `src/client/settings-section.tsx`）。

- 仓库形态：**monorepo**（npm workspaces），核心包 `packages/dsh-wallpaper-engine`（`@dsh-use/wallpaper-engine`）。
- 技术栈：Node ≥ 18、TypeScript strict、ESM-only；浏览器侧 Three.js（WebGL）+ Rust/WebGPU（wasm）；宿主侧 Cordis 插件体系。
- 不依赖 Wallpaper Engine 运行时：host 侧解包壁纸资源（`PKGV0001` 容器、`TEXV0005` 纹理），client 侧渲染。

## 2. 关键架构

### 2.1 双渲染器 + 回退链

scene 壁纸存在**两条渲染路径**，由 `createFallbackSceneRenderer`（`src/client/wasm-renderer.ts`）组合：

```
WebGPU 可用 → wasm 渲染器（Rust/wgpu，图片对象 + GPU 粒子）
  ↓ 无 WebGPU / 加载/初始化/渲染失败 / 检测到对象效果链（resolve false）
JS 渲染器（Three.js，`scene-renderer.ts`，图片 + 粒子 + 对象级效果链）
  ↓ 同样失败
preview 图回退（Ken Burns）
```

- **wasm 渲染器**：图片平面 + GPU 粒子模拟，**不含效果链执行器**（waterwaves/shake 等后处理动画只在 JS 侧）。渲染前 `hasEffectChains`（`src/client/wasm-renderer.ts`）检测任一对象 `effects` 非空 → 在绑定 WebGPU 之前返回 false，自动回退 JS 渲染器（Phase 2，wasm 不再把效果链壁纸渲染成 STATIC）。因此 wasm 实际服务**无效果链/纯粒子**壁纸；JS 渲染器按需承担其余壁纸。
- **JS 渲染器**：Three.js 渲染场景到离屏 RT，效果链为**对象级**（Phase 1/2：每带效果对象独立对象 RT + 局部正交相机 + EffectRunner，输出经合成 quad 贴回共享场景；已替代旧的全屏 ping-pong 展平路径）。
- wasm 失败后 fg canvas 已被 WebGPU context 占用 → 组合层**不自行换 canvas**，返回 false 让 controller 重建 canvas 重试（防污染）。

### 2.2 host / client / shared 分层（`src/` 下）

- `src/host/`：Node 侧（Cordis 插件）。`scanner.ts` 扫描壁纸目录 → `WallpaperInfo`；`steam-paths.ts` Steam 目录自动探测（注册表 SteamPath + libraryfolders.vdf + 常见根，`/wallpapers/probe`）；`pkg-reader.ts` 解包 PKGV0001；`routes.ts` 注册 HTTP 路由（读 `WallpaperRuntimeState` 可变目录，settings 热更新）；`settings.ts` 插件设置（含 wallpaperDir/weAssetsDir，空 = 回退 config → 缺省）。
- `src/client/`：浏览器侧（esbuild 打包为 `dist/client.js`，external react 等 DSH 共享模块）。`index.ts` 入口（bootstrap + `window.__wallpaperEngine` + 注册设置 `settings.section` 菜单）；`settings-section.tsx` 设置面板（壁纸网格/取消/路径配置）；`wallpaper-controller.ts` 选择/竞态/回退链；`scene-renderer.ts` Three.js 渲染器；`wasm-renderer.ts` wasm 胶水 + 回退组合；`effect-runner.ts` 效果链执行；`particles.ts` 粒子模拟 v1；`tex-loader.ts` TEXV0005 解码；`background-layer.ts` / `settings.ts` / `styles.ts`。
- `src/shared/`：跨 host/client 类型（`WallpaperInfo`、`SceneDescription`、`SceneObject` 等）。
- `src/client/shader/`：WE shader 方言转译层（`effect-chain.ts` 解析、`shader-preprocessor.ts` 预处理、`uniform-binder.ts`、`we-headers.ts` 内置头）。

### 2.3 坐标约定（重要，勿再翻转）

**WE 场景系 = 左下原点、y 向上**（`origin.y` 是距底部距离）；three 正交相机 = 中心原点、y 向上。映射：

```
three.x = we.x - vw/2；three.y = we.y - vh/2（y 不做翻转）
```

2026-08-20 曾误用 y 翻转（`vh/2 - oy`），导致非居中对象上下镜像（Orange 部件漂浮到少女头顶）。**新代码不得再引入 y 翻转或 `scale.y` 取负**——粒子速度 `vy<0` 即向下运动（snowflat 实测）。

## 3. 常用命令

```bash
# 单测（node + jsdom 双环境，vitest）
npm test                                   # 仓库根，委托 workspace

# 包内命令（在 packages/dsh-wallpaper-engine 下）
npm run build                              # tsc -p tsconfig.json → lib/（strict）
npm run build:wasm                         # wasm-pack 构建（见下）→ wasm/pkg/
npm run build:client                       # esbuild 打包 client → dist/client.js
                                           # + 复制 wasm 产物到 dist/static/
                                           # ⚠ 依赖 wasm/pkg/ 最新产物：改过 Rust 必须先
                                           #   build:wasm 再 build:client（产物缺失直接报错）
npx vitest run                             # 全量单测（373 个）

# wasm（Rust）构建 —— 注意必须 --target web；构建顺序：改 Rust → build:wasm → build:client
npm run build:wasm                         # 等价于下面两条的 wasm-pack 形式（在 wasm/ 下执行）
cd packages/dsh-wallpaper-engine/wasm
wasm-pack build --target web --release --features render   # → wasm/pkg/
# 或等价：cargo build --target wasm32-unknown-unknown --release --features render
#         + wasm-bindgen <cdylib.wasm> --target web --out-dir wasm/pkg
```

### 3.1 集成到 DSH profile（重要）

profile（`C:\Users\<user>\.dsh\profiles\web`）通过 `file:` 依赖引用本包，且是**快照复制**：

- 改完代码后 `pnpm add "@dsh-use/wallpaper-engine@file:<本包绝对路径>"` 通常**不会刷新快照**（pnpm 认为 up-to-date）。
- **可靠方式**：手动把构建产物复制进 profile 的 node_modules：

```bash
$src = '<repo>\packages\dsh-wallpaper-engine'
$dst = "$env:USERPROFILE\.dsh\profiles\web\node_modules\@dsh-use\wallpaper-engine"
Copy-Item "$src\lib\*"  "$dst\lib\"  -Recurse -Force
Copy-Item "$src\dist\*" "$dst\dist\" -Recurse -Force
```

- 然后刷新 `http://127.0.0.1:3080`（浏览器可能需强刷；路由带 rev hash）。
- host 侧代码（`lib/`）需要**重启 dsh web** 生效；client 侧（`dist/client.js`）刷新页面即可。

## 4. 关键目录

```
packages/dsh-wallpaper-engine/
  src/{host,client,shared}/   源码（含 client/shader 方言层）
  wasm/                       Rust 引擎（wasm-bindgen + wgpu）
    src/{coords,scene,tex,particle,render}/   Rust 源码
    pkg/                      构建产物（gitignore，不入库——规则在 wasm/.gitignore 的 /pkg/）
    tests/                    Rust native 测试（cargo test）
  lib/                        tsc 产物（gitignore）
  dist/                       esbuild 产物 + dist/static（gitignore）
  tests/                      单测（node）；tests/dom/（jsdom）
  scripts/build-client.mjs    client 打包 + wasm 产物复制
docs/superpowers/
  specs/                      设计文档（改动前必读）
  plans/                      实施计划（含历史修复决策）
research/                     调研产物（gitignore：截图/验证脚本/参考实现）
  open-wallpaper-engine/      参考实现（C++ 场景引擎，语义对齐来源）
  verify-wasm-render.mjs      全库 headless 验证脚本（WebGPU/JS 双模式）
```

## 5. 重要注意事项（踩过的坑）

1. **wasm 产物必须是 `--target web`**。曾用 `--target module`（wasm ESM 静态导入格式、无 `__wbg_init` 默认导出）导致 wasm 静默失败、一直回退 JS 渲染器。`wasm-renderer.ts` 的加载代码期望 `--target web`：动态 import 入口 + 调用默认导出 `mod.default(wasmUrl)` 初始化（不调 init 则 `WeScene.create` 内 wasm 未定义）。
2. **wasm 渲染器无效果链执行器（已自动回退，不再 STATIC）**：`hasEffectChains` 检测到任一对象 effects 非空 → render() 在绑定 WebGPU 之前返回 false，走 JS 渲染器（对象级效果链，动画完整）。曾长期是已知局限（效果壁纸 wasm 下 STATIC），Phase 2 起已消除。
3. **对象级效果链（已替代 Ruling 5 全屏展平）**：每带效果对象独立对象 RT + 局部相机 + EffectRunner，输出经合成 quad 贴回共享场景；合成 quad 按 UV 窗口（uvWindow）只采样 RT 可见段（超大对象钳制轴），不再把对象效果整屏生效。旧全屏 flatMap 展平（Orange 持续摇晃+模糊）已废弃。
4. **坐标方向**：左下原点、y 向上，不做翻转（见 §2.3）。
5. **场景资源禁止浏览器缓存**：`/wallpapers/scene/<id>/asset` 返回 `Cache-Control: no-store`；改资源后无需清缓存。
6. **测试沙箱**：vitest/esbuild 依赖 service 子进程（命名管道），在受限沙箱下报 `spawn EPERM`——需完整权限运行。
7. **`research/` 整体 gitignore**：验证脚本、截图、临时 profile 都不入库。
8. **粒子 alpha 属性链**：粒子透明度 = 生命周期衰减 × alpha（alpharandom 等随机化经属性链传入），JS ShaderMaterial 与 wasm 粒子层双路径同语义；改粒子 alpha 相关逻辑需双路径验证（`wasm/tests/particle_alpha_tests.rs` + `tests/particles.test.ts`）。
9. **对象级效果链的已知边界**：visualizer（visible.script 识别）与 text 对象**恒走共享场景路径**（绕过对象 RT/效果链）——它们带 effects 时效果被忽略（`groupEffectsByObject` 跳过 text；visualizer 为脚本控制节点）。注意 `hasEffectChains` 仍会因这类 effects 触发 wasm→JS 回退（仅路径差异，无错误）。
10. **wasm 成功路径可见性过滤（已修）**：wasm `render()` 对象循环与 JS 路径一致用 `resolveVisibility` 过滤不可见对象；wasm 无用户属性注入（settings 查询仅 JS 路径有），传 `{}` → user 绑定回退绑定 value（无用户属性存储 = 缺省语义）。
11. **音频管线（T3.2/T3.4）**：`createAudioAnalyzer` 频谱（freqData Uint8Array）→ EffectRunner 音频 uniform + visualizer 条高；壁纸 sound 数组经 `playWallpaperSound` 接入分析器（fire-and-forget；autoplay 被拦时 context suspended、可视化全零，用户手势后恢复）。无 Web Audio → 全零静音。
12. **构建顺序（改 Rust 必先 build:wasm 再 build:client）**：build:client 把 `wasm/pkg/` 产物复制到 `dist/static/`（页面加载的就是这份）——Rust 改动后直接 build:client 会复制旧 wasm（行为不更新）；产物缺失时 build:client 报错并提示先 `npm run build:wasm`。

## 6. 测试与验证

- **单测**：vitest，`tests/**/*.test.ts` 默认 node 环境，`tests/dom/**` 走 jsdom（`vitest.config.ts` 的 `environmentMatchGlobs`）。覆盖解析/加载/渲染器胶水/回退链等纯逻辑与 DOM 行为。
- **全库回归**：`tests/verify-real-library.test.ts` 断言 24 个 scene 壁纸的 scene.json / 纹理 / 粒子 / 效果链解析零失败。
- **浏览器验证**（改渲染逻辑后必跑）：

```bash
node research/verify-wasm-render.mjs               # WebGPU（wasm）路径
node research/verify-wasm-render.mjs --no-webgpu   # JS 回退链
```

输出判定表（OK/STATIC/BLACK）+ 渲染路径统计（webgpu=wasm / webgl2=JS）+ FPS；截图存 `research/wasm-shots/`。需要真实浏览器（headless Edge）+ 完整权限。

## 7. 工作约定

- 回复与注释/提交信息使用**简体中文**；代码、命令、文件名、技术术语保留原文。
- 实施前先读 `docs/superpowers/specs/` 对应设计文档；重大变更走技能流程（brainstorming → 设计文档 → writing-plans → TDD）。
- 改动渲染/坐标/效果链逻辑后，跑全量单测 + `verify-wasm-render.mjs` 双验证再提交。
