# 第三方 Wallpaper Engine scene 渲染器技术对标（2026-10-19）

> 调研对象：不依赖 Wallpaper Engine 官方运行时、能渲染 WE scene 的开源实现。本文服务于本项目 `@dsh-use/wallpaper-engine`（three.js + Rust/WASM，浏览器端）的技术对标。
> 数据采样：2026-10-19，stars/license/pushed_at 取自 `api.github.com/repos/<owner>/<repo>` 未认证接口；功能结论以各仓 README 与源码路径为据，无据则标「未核实」。
> 本项目现状依据：`README.md`、`AGENT.md` §5/§7、`src/client/` 模块名与源码注释（只读，未改动任何仓库源码）。

## 0. 结论摘要

1. **浏览器端最直接的对标不是 WEwebLoader，而是 WebWallGL（`oneincase/webwallgl`，13★，MIT）**：它是 npm 包（v3.0.0），被 DSH 生态头部插件 `elysia395/dsh-wallpaper-engine`（1568★ MIT）作为内置场景引擎使用，覆盖 image 层 / HLSL 转译效果 / puppet 骨骼 / 粒子 / 文本 / SceneScript / 鼠标视差 / 音频反应，并且**带一个能导出官方 `scene.pkg` 的 scene 编辑器**——这是本项目目前完全空白的一块。
2. **本项目在「WE 语义细节的工程化」上是竞品里做得最深的之一**（混合模式/行序/对象级 RT/具名 RT 效果图链/段渲染快照都有成体系的文档与测试），但在**能力广度**上明显落后：puppet 全栈（蒙皮/多段动画/attachments/MDMP/骨骼模拟）、3D 模型、相机路径/抖动、`copybackground`、完整 `colorBlendMode`、壁纸级 bloom/PBR、频谱柱状可视化均未实现（`AGENT.md` §7 已如实记录）。
3. **原生实现**（OWE / we-layerd / lwe / kirie / Loomscreen）普遍支持 scene 的「深水区」能力；其中 **we-layerd 的渲染子模块能力面最全**（puppet 蒙皮+多段动画+attachments+MDMP 解析、copybackground、HDR bloom、SceneScript 运行时、多输出、音频频谱），但 `Aromatic05/we-layerd` 仓库**无 LICENSE（保留所有权利）**，且其渲染子模块为 GPL-2.0-only，许可证上不可借用。
4. **许可证格局**：MIT 阵营 = 本项目 / WebWallGL / elysia / Loomscreen / wallpaper-kit / skwd-wall；GPL-3 = WEwebLoader / lwe / AnisPaper；GPL-2 = OWE / KDE 插件 / we-layerd 渲染子模块；AGPL-3 = kirie；we-layerd 宿主无许可。若本项目要保持 MIT 可分发，**只有 WebWallGL / Loomscreen 的行为结论可参考**，其余只能作行为对照（本项目 README 已声明语义对齐 lwe 但未复制代码）。

## 1. 对象速览

| 项目 | 链接 | ★ | 许可证 | 语言/后端 | 平台 | 定位 |
|---|---|---|---|---|---|---|
| 本项目 | [dsh-use-wallpaper](https://github.com/yu502950715yang/dsh-use-wallpaper) | — | MIT | TS + Rust/WASM；WebGL2（three.js） | 浏览器（Windows 实测） | DSH 插件，scene/web/video/image 壁纸 |
| WebWallGL | [oneincase/webwallgl](https://github.com/oneincase/webwallgl) | 13 | MIT | JS；WebGL2 | 浏览器 / Tauri·Electron·WebView / 有桌面安装包 | 渲染核心 + scene 编辑器 + 导出 `scene.pkg` |
| elysia dsh 插件 | [elysia395/dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine) | 1568 | MIT | JS；内置 WebWallGL | DSH（Win/mac/Linux） | **同宿主直接竞品**，内置 WebWallGL |
| WEwebLoader | [XHR666/wallpaper-engine-web-loader](https://github.com/XHR666/wallpaper-engine-web-loader) | 1 | GPL-3.0-or-later（npm 0.5.20） | JS；WebGL2 + CPU 回退 | 浏览器 + 本机 Node 服务 | `scene.pkg`/`.mpkg`/workshop 目录渲染器 |
| OWE | [waywallen/open-wallpaper-engine](https://github.com/waywallen/open-wallpaper-engine) | 253 | GPL-2.0 | C++20 modules；Vulkan 1.1 + render graph | Linux（waywallen 插件 / 独立 viewer），web 用 CEF | scene 渲染器 |
| lwe | [Almamu/linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine) | 4666 | GPL-3.0 | C++；OpenGL 3.3 | Linux（X11/Wayland） | 事实标准级 Linux WE 运行时 |
| we-layerd | [Aromatic05/we-layerd](https://github.com/Aromatic05/we-layerd) | 140 | **无 LICENSE（保留所有权利）**；渲染子模块 GPL-2.0-only | Rust 宿主 + C++ 渲染子模块 | Linux/Wayland | 原生 Wayland 运行时（scene/video/web） |
| Loomscreen | [Paradox07127/macos-wallpaperengine](https://github.com/Paradox07127/macos-wallpaperengine) | 64 | MIT | Swift；Metal | macOS 14.6+（Pro 仅 Apple Silicon） | macOS 壁纸 App（Pro 渲染 WE scene） |
| kirie | [UnhingedSoftware/kirie](https://github.com/UnhingedSoftware/kirie) | 3 | AGPL-3.0-or-later | Rust；wgpu（Vulkan/Metal） | Linux + macOS | 独立渲染器（scene/video/image/web） |
| AnisPaper | [NixaXI/AnisPaper](https://github.com/NixaXI/AnisPaper) | 37 | GPL-3.0-or-later | C++/Qt + KDE Plasma 6，scene 静态链接 lwe 核心 | Linux（KDE Plasma 6） | KDE 壁纸插件 |
| KDE 插件（活跃 fork） | [RainyPixel/wallpaper-engine-kde-plugin](https://github.com/RainyPixel/wallpaper-engine-kde-plugin) | 80 | GPL-2.0 | C++；Vulkan 1.1 | Linux（Plasma 6） | KDE 壁纸插件 |
| KDE 插件（原仓） | [catsout/wallpaper-engine-kde-plugin](https://github.com/catsout/wallpaper-engine-kde-plugin) | 2700 | GPL-2.0 | QML/C++ | Linux（Plasma） | **已归档**，由上面的 fork 接续 |
| catsout scene renderer | [catsout/wallpaper-scene-renderer](https://github.com/catsout/wallpaper-scene-renderer) | 43 | GPL-2.0 | C++ | Linux | **已归档**，README 仅一行「Moved to waywallen/open-wallpaper-engine」 |
| wallpaper-kit | [pySam1459/wallpaper-kit](https://github.com/pySam1459/wallpaper-kit) | 1 | MIT | Rust；Direct3D 11 | Windows | 面向「应用内嵌背景」的早期渲染器 |
| skwd-wall | [liixini/skwd-wall](https://github.com/liixini/skwd-wall) | 1083 | MIT | Rust/Quickshell | Linux/Wayland | 壁纸选择器；**scene 渲染委托 lwe**，自身不渲染 |
| wallgl | [lucaschnabel42/wallgl](https://github.com/lucaschnabel42/wallgl) | 0 | 无 | 未知 | 未知 | 仓库 API 存在但 README 在 main/master 均 404，**未核实/不可用** |

> 注：README 没有列 feature list 的项目（lwe、skwd-wall 等）功能结论来自源码路径 grep，见第 3 节。`catsout` 原仓与 `waywallen/open-wallpaper-engine` 的逐文件血缘未在本轮核实。

## 2. 能力矩阵

状态口径：**有** = README/源码明确实现；**部分** = 有实现但有明确范围/回退；**无** = 明确未实现（文档或源码缺失）；**未核实** = 本轮无证据，不臆断。
本项目列后缀为源码路径或文档条目，即该项依据。

### 2.1 scene 能力

| 能力 | 本项目 | WebWallGL | WEwebLoader | OWE | lwe | we-layerd | Loomscreen | 其他 |
|---|---|---|---|---|---|---|---|---|
| 图层（image/composition/fullscreen） | 有 `background-layer.ts`、`scene-graph.ts` | 有 | 有（image 图层 + 组合容器） | 有（Image/Composition/Fullscreen） | 有（`Render/Objects/CImage.*`） | 有（scene 后端 parser） | 有（scene.pkg） | kirie/AnisPaper/KDE 有；wallpaper-kit 部分 |
| 文本对象 | 有 `text-object.ts`（时间/日期滚动） | 有（text/clock/date 编辑器） | 有（CFF 文本 + 随仓字体） | 有（Layer: Text） | 有（`CText.*`） | 有（`WPTextObject.*`） | 未核实 | KDE 有 |
| 效果链（多 pass / FBO / 具名 RT） | 有 `effect-graph.ts`、`effect-runner.ts`、`rt-render.ts` | 有 | 有（blur/cloud/water/godrays/DOF；`elysia/we-renderer/effects/**`） | 有（Effect: Basic/Mouse/Parallax/Depth） | 有（`Effects/CPass.*`） | 有（自定义 shader/pass，测试 `migrated_features_regression_test`） | 有（shader effects） | kirie 有（full effect pipeline）；wallpaper-kit 部分 |
| 粒子系统 | 有 `particles.ts` + Rust/WASM CPU 模拟 + `spritetrail` | 有 | 有（算子 + 指针交互） | 有（Renderers/Emitters/Initializers/Operators/Control Points/Children/Audio Response） | 有（`CParticle.*`） | 有（`WPParticleParser`/`ParticleSystem`） | 有（particles） | kirie 有；AnisPaper 有（继承 lwe）；wallpaper-kit 部分 |
| puppet 蒙皮 | 部分 `puppet.ts` 有 SkinnedMesh 路径，但本机无蒙皮样本（`AGENT.md` §7.40） | 有（WebWallGL 支持 puppet 骨骼，细节未核实） | 有（`core/puppet-skin.js`） | 有（Puppet: Mesh/Skeleton/Animation） | 部分（`CImage::loadPuppetMesh` 只读静态 MDLV 网格） | 有（`WPPuppet::genFrame` 蒙皮矩阵） | 有（puppet-warp animation） | kirie 有；AnisPaper 有（lwe）；wallpaper-kit **无**（README 明说 puppet 变形/动画层不支持） |
| puppet 骨骼动画（MDLA，多段） | 部分 `puppet.ts applyFrame`；只应用第一条可见动画层，blend/additive 未混合（§7.40） | 有（同上，细节未核实） | 有（`core/we-animation.mjs`） | 有（Puppet: Animation） | 部分（`ObjectParser` 解析 `animationlayers`，消费路径未核实） | 有（`WPPuppetLayer` 多动画层 + blend/single 模式） | 未核实 | kirie 有 |
| puppet attachments（MDAT） | 无（`AGENT.md` §7.40 未实现） | 未核实 | 有（`core/attach-transform.mjs`，附件锚点变换） | 有（Attachments MDAT） | 未核实 | 有（`WPPuppet::Attachment` + `WPNodeTransformResolver` BoneAttachment） | 未核实 | kirie 未核实 |
| puppet mesh masks | 无 | 未核实 | 未核实 | 有（Mesh masks） | 未核实 | 未核实 | 未核实 | — |
| MDMP morph | 无 | 未核实 | 未核实 | 无（README `[ ] Morph (MDMP)`） | 无源码证据（grep 无 MDMP） | 部分（`WPMdlParser` 解析 `morph_sections`；渲染消费未核实） | 未核实 | — |
| 骨骼模拟（bone simulation） | 无 | 未核实 | 未核实 | 无（README `[ ] Bone simulation`） | 未核实 | 未核实 | 未核实 | — |
| 3D 模型（.mdl / obj / glTF） | 部分 `mdl-parser.ts`（MDLV0013~0023 静态网格）；无 obj/gltf | 有（模型层；编辑器可导入 glTF/GLB/FBX/OBJ/DAE/STL/PLY/3DS） | 部分（MDL 网格） | 有（`[x] 3D model`） | 部分（`ModelParser` 仅 `puppet` 字段，独立 3D model 未核实） | 有（MDL 网格 + scene 后端 mesh） | 未核实 | kirie 有；wallpaper-kit 无 |
| SceneScript | 有 `scene-script-vm.ts`/`scene-script-host.ts`（脚本跑不通时降级，README） | 有 | 有（`elysia/scene-scripts.js` + WE API shim） | 有（`[x] Scenescript`） | 有（`src/WallpaperEngine/Scripting/`） | 有（`WPSceneScriptHost`，feature 开关） | 未核实 | kirie 有 |
| user properties | 部分（VM 注入 `userProperties`；无属性面板编辑） | 有（`setProperties()` + 绑定可见/透明度/亮度/缩放/颜色/文本） | 部分（`project.json` 查找链、测试台属性保存；渲染侧绑定未核实） | 有（`[x] User Properties`） | 未核实 | 有（we-gui 暴露 toggle/slider/choice/color/text/file/dir） | 有（scene presets / custom settings） | kirie 未核实 |
| 相机 zoom / shake / path | 部分（`scene-json.ts` 解析 camera、cover 正交相机；无 zoom/shake/path 动画） | 部分（场景设置含相机/相机抖动/鼠标视差；path 未核实） | 未核实 | 有（Camera: Zoom/Shake/Path） | 未核实（`Camera.h` 存在；三项未核实） | 未核实 | 未核实 | — |
| 音频 loop / random | 有（README `soundEnabled`；`audio-input.ts`） | 有（音频反应、系统频谱） | 有（sound 清单与播放） | 有（Audio: Loop/Random） | 有（`CSound`/PulseAudio） | 有（`SoundManager`，兼容选项强制 loop） | 有（audio-reactive layers） | kirie 有；AnisPaper 有 |
| 音频可视化 / 音频驱动效果 | 部分（频谱驱动 uniform；柱状可视化未支持，README） | 有（README 音频可视化 + 系统实况频谱） | 有（`core/audio-band-array.mjs`） | 有（Audio: Visualization；粒子 Audio Response） | 有（FFTW3 + visualizer） | 有（64-bin stereo spectrum → shader/SceneScript） | 有（system audio-driven VFX，Pro） | kirie 有（Linux；macOS 无采集）；AnisPaper 有 |
| 鼠标交互 | 有 `pointer-input.ts`/`pointer-post.ts`/`parallax.ts` | 有（指针/交互） | 有（`we-particle-pointer.mjs`/`we-pointer-source.mjs`） | 有（鼠标延迟/视差） | 有（`CImage` cursor 事件、cameraparallax） | 有（pointer/click/scroll 转发） | 有（cursor effects） | KDE/AnisPaper 有 |
| colorBlendMode | 部分（仅 6/7/31，其余回退 alpha，`AGENT.md` §5.6/§7.31） | 未核实 | 未核实 | 有（`[x] ColorBlendMode`） | 未核实 | 有（`ResolveImageColorBlendPlan` 测试） | 未核实 | — |
| copybackground | 无（`AGENT.md` §7.31） | 未核实 | 未核实 | 未核实 | 无（grep 无 `copybackground`） | 有（`WPTextObject` 字段 + 测试） | 未核实 | — |
| 全局 bloom / 后处理 | 部分（应用级 glow `glow-stage.ts`；壁纸级 `general.bloom` 未实现，§7.30） | 有（场景设置 bloom/HDR） | 部分（质量档 `pp` 后处理链；bloom 未核实） | 有（`[x] Global bloom`） | 有（`CScene.cpp` 自建 bloom 效果链） | 有（HDR bloom 节点测试） | 未核实 | kirie 有 |
| PBR | 无（`src/client` 无实现） | 未核实 | 未核实 | 有（`[x] PBR light`） | 无（grep 无 pbr） | 未核实 | 未核实 | — |
| 视频壁纸 / 视频纹理 / 视频后处理 | 部分（video 壁纸交 `<video>`；`.tex` 内嵌 mp4 纹理；无视频后处理链） | 有（视频壁纸、视频层、非 H264 自动转码） | 有（内嵌 mp4 / 视频纹理） | 部分（有 CEF Web Renderer；视频壁纸未列） | 有（MPV `VideoPlayback`） | 有（scene/video/web 三类） | 有（mp4/m4v/mov/avi，HDR aware） | AnisPaper 有；kirie 有；wallpaper-kit 部分 |

### 2.2 工程与平台

| 维度 | 本项目 | WebWallGL | WEwebLoader | OWE | lwe | we-layerd | Loomscreen | 其他 |
|---|---|---|---|---|---|---|---|---|
| 渲染后端 | WebGL2（three.js）；无 WebGPU（旧 WebGPU 渲染器已删） | WebGL2；无 GPU 时熔断回软渲染（elysia 文档） | WebGL2，无 GPU 回退 CPU 路径（明显更慢） | Vulkan 1.1 + render graph | OpenGL 3.3 | 未核实（DMA-BUF 呈现，后端未在 README 明示） | Metal | kirie wgpu；wallpaper-kit D3D11；KDE Vulkan 1.1 |
| 语言/构建 | TS（esbuild）+ Rust/WASM（wasm-bindgen） | JS/npm 包 | JS（Node ≥20 + 浏览器，ESM only） | C++20 modules | C++ | Rust 宿主 + C++ 渲染模块 | Swift | kirie Rust；AnisPaper C++/Qt |
| 许可证 | MIT | MIT（npm v3.0.0 MIT） | GPL-3.0-or-later | GPL-2.0 | GPL-3.0 | **无许可证**（保留所有权利）；渲染子模块 GPL-2.0-only | MIT | kirie AGPL-3.0-or-later；AnisPaper GPL-3.0-or-later；KDE GPL-2.0；wallpaper-kit MIT；skwd-wall MIT |
| 平台 | 浏览器（仅 Windows 实测，macOS 未测） | 浏览器 + 桌面壳（mac/win/linux） | 浏览器 + 本机 Node 服务 | Linux | Linux | Linux/Wayland | macOS 14.6+ | kirie Linux/macOS；AnisPaper/KDE Linux；wallpaper-kit Windows |
| 多显示器 / 多输出 | 无（单 canvas 背景层） | 未核实（嵌入 canvas 定位） | 未核实 | 未核实 | 有（X11/Wayland outputs） | 有（per-output 独立 surface/renderer worker） | 有（per-display，可 span） | AnisPaper/KDE 有；kirie 每屏一窗 |
| 性能手段 | 对象级 RT + 具名 RT 池、段渲染帧快照、屏占位分辨率预算、CPU 粒子 WASM、暂停/后台暂停、分辨率 0.5× | 优先 GPU、无 GPU 软渲染回退、帧率档位；编辑器支持多 pass FBO | 质量档 `?q/?aa/?pp`、CPU 回退、基线 FPS 回归闸门 | render graph 自动 pass 依赖、shader/blob 缓存 | 未核实 | DMA-BUF 零拷贝 + shared-memory 回退、帧回调限流 | Metal、自适应帧率、per-display 渲染线程 | kirie：预烘焙 scene-bundle 缓存（hash keyed）、多线程；AnisPaper：独立渲染进程（1080p 实测约 58–60FPS） |
| 缓存 | 场景资源 `Cache-Control: no-store`（AGENT §5.8）；无 bundle 缓存 | 未核实 | PWA 缓存（明确排除用户壁纸）；`.mpkg` 容器 | shader/blob 缓存（`-C`） | 未核实 | 未核实 | 未核实 | kirie scene-bundle 缓存；elysia：`scene.pkg` ETag 可重验证缓存（`HOW-IT-WORKS.md`） |
| 自动化测试 | 有：vitest（node+jsdom）、headless Edge e2e 逐像素、CI 基线门禁（README「构建与开发」；AGENT §3.3） | 未核实（README 未列测试） | 有：242 项回归 + 3 项静态闸门 + 基线 FPS 回归闸门（README §6） | 未核实 | 未核实 | 有：ctest 契约/场景/渲染单测（renderer README validation、`src/test/**`） | 未核实（README 提 `make verify`/发布门禁） | wallpaper-kit 有验证脚本；kirie 有兼容性清单与 CI |
| 运行依赖 | 无 WE 进程；须本机装 WE 取内置素材；WebGL2 | 纯浏览器 | 需 Node 服务（只读模式可静态托管） | 需 WE assets | 需 WE assets | 需 WE assets | 需 WE 安装（Pro） | — |
| 编辑器 / 导出 | 无（只读播放） | **有 scene 编辑器，可导出官方 `scene.pkg`** | 无编辑器（有 pkg 重打包工具 `pkg-patch.mjs` 做 A/B） | 无 | 无 | 无 | 无（有预设/工坊下载） | 无 |

> 说明：WebWallGL 的「无 GPU 熔断回软渲染」与「puppet 骨骼」来自 elysia 插件的 `docs/HOW-IT-WORKS.md` 与 README（它 vendored/依赖 WebWallGL）；WebWallGL 自身 README 未逐项列全，标「有」但细节未核实处已注明。

## 3. 依据与逐项说明（含 URL）

### 3.1 WebWallGL（[oneincase/webwallgl](https://github.com/oneincase/webwallgl)，13★，MIT，npm v3.0.0）
- README 明示：WebGL2 渲染核心；播放 **scene 壁纸（`scene.pkg` / 松散工程目录）、网页壁纸、视频壁纸**；「还原图层、效果、粒子、模型、SceneScript 脚本、用户属性与音频可视化」；自带**壁纸播放器 + scene 编辑器**，可导出官方 WE 能加载的 `scene.pkg`；npm 包 `webwallgl`、`@webwallgl/core`、`@webwallgl/editor`（均 MIT，v3.0.0）。
- 编辑器能力（README「场景编辑器」）：图层含图片/文字（文字·时钟·日期）/粒子（雪、雨、火花、光点）/视频/声音/模型/容器层/全屏后期层/相机与灯光层；模型可导入 glTF/GLB/FBX/OBJ/DAE/STL/PLY/3DS，带骨骼转 puppet；效果支持多 pass + FBO；SceneScript 8 类生命周期模板；场景设置含相机、相机抖动、鼠标视差、泛光/HDR。
- **同宿主竞品用法**：`elysia395/dsh-wallpaper-engine` README「能做什么」写「内置 **WebWallGL** 渲染 Scene / Web 壁纸，支持粒子、puppet 骨骼、SceneScript、鼠标交互与音频反应」；其 `docs/HOW-IT-WORKS.md` 进一步说明渲染器是 npm 依赖 `webwallgl`（版本钉在 package.json）+ 本仓 `lib/webwallgl/` 适配页，场景由 WebGL2 解析对象树、HLSL 转译后在 GPU 执行 shader 效果、puppet 骨骼模型、粒子、文本、SceneScript，鼠标驱动视差/光标交互，音频驱动音频反应；**无 GPU 时熔断回软渲染**；实时帧率 15/30/60；曾有的 CPU 兜底出图链已在 P2-12 删除（改为「要么真画面、要么明确留空」）。
- 未核实项：copybackground、colorBlendMode 全集、PBR、多显示器、渲染细节回归测试——WebWallGL 的 README 不逐项展开，本轮无源码级核对。

### 3.2 WEwebLoader（[XHR666/wallpaper-engine-web-loader](https://github.com/XHR666/wallpaper-engine-web-loader)，1★，GPL-3.0-or-later，npm 0.5.20）
- README §2：输入支持 `scene.pkg`、自制 `.mpkg` 容器、workshop 源目录；渲染管线含 TEX 解码（TEXV0005+TEXI0001+TEXB0001~0004）、MDL 网格、image 图层与组合容器、**附件锚点变换**（`core/attach-transform.mjs`）、**蒙皮**（`core/puppet-skin.js`）、**动画**（`core/we-animation.mjs`）、CFF 文本、粒子系统与算子（`sphererandom`/`vortex`/`turbulence`/`controlpointattract`/…）、指针交互、效果链（模糊/云/水波/上帝光/景深视差，`elysia/we-renderer/effects/**`，HLSL→GLSL 转译器 vendored）、SceneScript 运行时 + WE API shim、音频频段数组、内嵌 mp4/视频纹理。
- README §2「明确不做的」：需 WebGL2、无 GPU 回退 CPU 路径明显更慢；**复杂蒙皮/粒子/效果链仍在持续完善**（未结项清单在 `tests/known-issues.json`）；不分发真实壁纸与 WE 官方资产。
- 测试/工程：242 项回归 + docs/publish/diag 三项静态闸门 + 基线 FPS 回归闸门；代码血缘自述见 README §11（`elysia/**` 移植自 elysia395 插件的 `lib/we-renderer/**`；FXAA 与 HLSL 转译器来自 WebWallGL，MIT）。
- 许可注意：渲染器 GPL-3.0-or-later，**不可被 MIT 项目直接借用代码**；其 README 自己也声明上游参考实现仅作行为对照。

### 3.3 OWE（[waywallen/open-wallpaper-engine](https://github.com/waywallen/open-wallpaper-engine)，253★，GPL-2.0，C++/Vulkan）
- README「Feature list」逐项：Layer: Image / Composition / Fullscreen / Text 全部 `[x]`；Effect: Basic / Mouse position with delay / Parallax / Depth Parallax / **ColorBlendMode** / **PBR light** / **Global bloom** 全部 `[x]`；Camera: **Zoom / Shake / Path** `[x]`；Audio: Loop / Random / Visualization `[x]`；Particle: Renderers / Emitters / Initializers / Operators / Control Points（含 Mouse Follow）/ Children / Audio Response `[x]`；Puppet: Mesh / Skeleton / Animation / **Attachments (MDAT)** / **Mesh masks** `[x]`，**Bone simulation `[ ]`、Morph (MDMP) `[ ]`**；3D model / Scenescript / User Properties `[x]`。
- 架构：Vulkan 1.1 + render graph（自动 pass 依赖）；独立 `SceneViewer`（GLFW+Vulkan，支持 `--cache-path` shader/blob 缓存、`--graphviz` dump render graph）与 CEF `WebViewer`。
- 上游：`catsout/wallpaper-scene-renderer`（43★，GPL-2.0，已归档）README 只有一行「Moved to https://github.com/waywallen/open-wallpaper-engine」；两者逐文件血缘本轮未核实。

### 3.4 linux-wallpaperengine（[Almamu/linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine)，4666★，GPL-3.0，C++/OpenGL 3.3）
- README 无 feature list（定位为「educational project… expect limitations」）；能力依据源码：
  - 图层：`src/WallpaperEngine/Render/Objects/` 含 `CImage`/`CText`/`CParticle`/`CSound`，`Wallpapers/` 含 `CScene`/`CVideo`/`CWeb` → image/text/particle/sound + scene/video/web 四类壁纸有。
  - 效果链：`Render/Objects/Effects/CPass.*`、`CFBO.*`、`FBOProvider.*` → 有。
  - puppet：`CImage::loadPuppetMesh` 读 `MDLV0021`/`MDLV0023` 静态网格；`ObjectParser.cpp` 解析 `animationlayers`；蒙皮/骨骼动画的消费路径未核实 → **部分**。
  - SceneScript：`src/WallpaperEngine/Scripting/`（QuickJS，`SceneObject.cpp` 等）→ 有。
  - bloom：`Wallpapers/CScene.cpp` 自建 `_rt_Bloom` + 效果链模拟相机 bloom → 有。
  - 音频：PulseAudio + FFTW3（README 依赖）→ loop/可视化有。
  - 缺失证据：`copybackground`、`MDMP`、`MDAT`、`MDLE`、`pbr` 在 `src/**/*.cpp` grep 均无命中 → 对应矩阵「无/未核实」。
- 项目 README 自述是 Linux WE 兼容的事实基准之一；本项目 README「许可与致谢」也写明语义对齐自 lwe。

### 3.5 we-layerd（[Aromatic05/we-layerd](https://github.com/Aromatic05/we-layerd)，140★，无许可证）与渲染子模块
- 宿主 README：原生 Wayland 运行时，无需 Wine 即可渲染 **scene / video / web**；读取壁纸 user properties 并在 GUI 暴露 toggle/slider/choice/color/text/file/dir；支持 64-bin stereo desktop audio spectrum 给 scene/web；转发 pointer/click/scroll；每输出独立 surface/renderer worker；DMA-BUF 零拷贝 + shared-memory 回退；输出热插拔；帧回调限流；播放列表/多输出分配。
- 渲染子模块 `.superpowers/we-layerd-src/third_party/wallpaper-engine-renderer`（Aromatic05/wallpaper-engine-renderer，GPL-2.0-only，pin 于 `.gitmodules`）源码证据：
  - puppet：`src/backend/scene/internal/animation/WPPuppet.*`（骨骼、`genFrame` 蒙皮矩阵、`Attachment`、`AnimationLayer` 多段 + blend、PlayMode）；`parser/mdl/` 有 `MorphSectionData`（MDMP 解析）与 `MDLA/MDAT/MDLE` 段测试。
  - 文本/合成：`wpscene/WPTextObject.cpp` 处理 `copybackground`；`test/scene/composition/image_color_blend_test.cpp` 覆盖 `copybackground` → effect combo、`ResolveImageColorBlendPlan`。
  - 效果/HDR bloom：`test/scene/migrated_features_regression_test.cpp` 覆盖 `bloomhdrstrength/threshold/scatter/feather/iterations` 的多 mip 节点与自定义 shader 材质。
  - 粒子：`parser/WPParticleParser.*`、`particle/ParticleSystem`；音频频谱：`scenescript/WPSceneScriptHost::GetAudioSpectrum`、`WPShaderValueUpdater` 的 `has_audio_spectrum_*`。
  - SceneScript：`scenescript/WPSceneScriptHost.*`，`WESceneRuntimeDriver` 有 `WP_ENABLE_SCENESCRIPT_RUNTIME` 开关。
- **许可证是硬约束**：`we-layerd` 仓库无 LICENSE（GitHub API `license: null`），其渲染核心子模块为 GPL-2.0-only → 只能作行为对照，不可借用代码/逐行移植。

### 3.6 Loomscreen / macos-wallpaperengine（[Paradox07127/macos-wallpaperengine](https://github.com/Paradox07127/macos-wallpaperengine)，64★，MIT，Swift/Metal）
- README「Wallpaper types」：**Pro** 用原生 Metal 渲染 `scene.pkg`——particles、shader effects、**puppet-warp animation**、audio-reactive layers、cursor effects；支持导入本地工程目录或从 Steam 工坊下载（含社区预设）；「Compatibility varies by project」。
- 其余能力（video/web/Aerials、多显示器、播放列表）为 App 层；Lite 版不含 WE 渲染器。矩阵中场景深度项多为「未核实」（README 未展开到 MDMP/PBR 等）。

### 3.7 其他
- **kirie**（[UnhingedSoftware/kirie](https://github.com/UnhingedSoftware/kirie)，3★，AGPL-3.0-or-later，Rust/wgpu）：README 明示 scene/video/image/web 四类；audio-reactive visualizers、SceneScript、3D puppet/model、full effect pipeline；hash-keyed **prebaked scene-bundle 缓存**；`--screenshot` 无头单帧；控制 socket；维护「与 WE 逐张对拍」的兼容性清单；macOS 上音频反应实际不反应（无采集）、点击需 `--interactive`。
- **AnisPaper**（[NixaXI/AnisPaper](https://github.com/NixaXI/AnisPaper)，37★，GPL-3.0-or-later）：KDE Plasma 6；scene 路径**静态链接 lwe 核心**到 `anis-paper-scene-engine`（`-Wl,--whole-archive wallpaperengine-core`），因此自身能力继承 lwe；实测 1080p scene 约 58 FPS，312 个本地 scene 扫描 306 动画/6 静态回退/0 崩溃；多显示器 working；**web 壁纸 broken**。
- **KDE 插件**（[RainyPixel/wallpaper-engine-kde-plugin](https://github.com/RainyPixel/wallpaper-engine-kde-plugin)，80★，GPL-2.0；原仓 catsout 2700★ 已归档）：C++/Qt6/Vulkan 1.1；Support Status：Scene(2D) supported、Web 基础 API、Video 走 QtMultimedia/MPV；已知部分 scene 可能崩 KDE；另有 hyprland web-only host。
- **wallpaper-kit**（[pySam1459/wallpaper-kit](https://github.com/pySam1459/wallpaper-kit)，1★，MIT，Rust/D3D11，Windows）：早期阶段——TEX 页解码、部分 image 播放与粒子（Gojo 星/流星/烟花）、Periodic Shake 部分；**puppet mesh deformation 与 animation layers 明确不支持**、effects 部分未实现；以 65 张本地素材做保真审计。
- **skwd-wall**（[liixini/skwd-wall](https://github.com/liixini/skwd-wall)，1083★，MIT）：壁纸选择器/UI，scene 渲染**委托 linux-wallpaperengine**（可选依赖），自身不是渲染器 → 矩阵能力不单列。
- **wallgl**（[lucaschnabel42/wallgl](https://github.com/lucaschnabel42/wallgl)，0★，无许可证）：GitHub API 元数据存在，但 README 在 `main`/`master` 均 404、语言为空 → 视为不可用/未核实。

## 4. 竞品有而本项目没有（按补齐价值排序）

| 序 | 差距 | 竞品证据 | 本项目现状 |
|---|---|---|---|
| 1 | **puppet 全栈**：蒙皮骨骼动画真实素材、attachments、masks、MDMP morph、骨骼模拟 | OWE（Mesh/Skeleton/Animation/Attachments/Masks；bone sim 与 MDMP 也无）、we-layerd（蒙皮+多段动画+Attachment+MDMP 解析）、WebWallGL（puppet 骨骼）、WEwebLoader（skin+anim+attach）、kirie、Loomscreen（puppet-warp） | 静态网格解析可用；本机无蒙皮样本，attachments/masks/MDMP/bone sim 未实现（§7.40） |
| 2 | **scene 编辑器 + 导出 `scene.pkg`** | 仅 WebWallGL 有（图层/模型导入/效果/逻辑/导出兼容检查） | 无（只读播放） |
| 3 | **3D 模型导入与渲染**（obj/glTF/GLB/FBX…） | WebWallGL 编辑器全格式导入；OWE 3D model | 仅 WE `.mdl` 静态网格 |
| 4 | **相机系统**（zoom / shake / path） | OWE 三项全 `[x]` | 仅基础相机解析 + cover 取景 |
| 5 | **copybackground** | we-layerd（`WPTextObject` + 测试） | 无（§7.31） |
| 6 | **colorBlendMode 全集** | OWE `[x]`；we-layerd 有完整 plan | 仅 6/7/31（§5.6/§7.31） |
| 7 | **壁纸级 bloom/HDR、PBR light** | OWE（Global bloom、PBR light）、we-layerd（HDR bloom）、WebWallGL（bloom/HDR）、lwe（camera bloom） | 仅应用级 glow；壁纸 `general.bloom` 未实现（§7.30） |
| 8 | **user properties 面板/绑定** | we-layerd（GUI 六类控件）、WebWallGL（属性绑定图层字段+`setProperties`） | 只有 VM 注入，无面板 |
| 9 | **音频可视化（频谱柱/音频响应粒子）** | OWE（Audio Visualization + Particle Audio Response）、we-layerd（64-bin spectrum）、WebWallGL、lwe（FFTW） | 频谱驱动 uniform 有，柱状可视化未支持 |
| 10 | **多显示器 / 多输出** | we-layerd（per-output worker）、lwe（X11/Wayland outputs）、AnisPaper/KDE、Loomscreen、kirie（每屏一窗） | 无（单 canvas） |
| 11 | **性能/缓存工程** | kirie 预烘焙 scene-bundle、we-layerd DMA-BUF、OWE render graph、AnisPaper 实测 58–60FPS | 性能门槛（1080p FPS≥30）未真机严格验证（§7.30/§7.36）；无 bundle 缓存 |
| 12 | **SceneScript / 脚本覆盖度** | WEwebLoader 有较完整 WE API shim；we-layerd/OWE/lwe 均有脚本运行时 | 有 VM 与降级，但「跑不通退回内置时钟」说明兼容面有限（README） |

## 5. 本项目有而竞品没有 / 更强

1. **宿主内嵌度最高（DSH 插件形态）**：自动探测 Steam（注册表 + `libraryfolders.vdf` + 多库）、设置即改即生效、`window.__wallpaperEngine.select(id)` 切换、永久不白屏的**降级链**（three → preview+Ken Burns）、`render-health.ts` 看护（README / §7.38）。同类 DSH 竞品只有 elysia 插件，且它把渲染交给 WebWallGL。
2. **WE 语义的细粒度工程化**：`colorBlendMode` 按 WE 材质再追加一遍读帧缓冲的混合 pass、行序/坐标/RT 采样/`g_TextureNResolution`/`fxRes` 等踩坑已固化为 §5 硬约束与单测；具名 RT 图链在加载期编译、帧内只绑槽（§5.28）；对象级 RT 按「屏占位」定分辨率预算（§5.15/§5.36）；段渲染 + `_rt_FullFrameBuffer` 帧内快照（§5.45/§5.46）。竞品 README 未见同等粒度的公开约束记录（未核实其代码深度）。
3. **纯浏览器 + 零外部服务**：无本机 Node 服务（对比 WEwebLoader 需 Node 静态服务器或静态站点），宿主内完成资产路由与 WE 素材两级查找（pkg → 引擎 assets，§5.14）。
4. **不重新分发第三方素材、许可证干净（MIT）**：WE 内置纹理运行时从用户本机读取；相对 GPL/AGPL/无许可阵营可自由分发（本项目 README 已明示）。
5. **应用级 glow 与 GUI 可读性配套**（`glow-stage.ts`、遮罩、壁纸取色决定文字颜色/描边 `text-color.ts`）：这不是 scene 能力，但决定「壁纸当背景」的可用性；同类竞品面向桌面，无此问题域。
6. **失败/健康看护与 CI 基线**：`scripts/known-failures.json` 棘轮、`scripts/known-type-errors.json` 类型棘轮、headless Edge 逐像素 e2e、`e2e:colorblend` 不依赖本机素材可上 CI。竞品中只有 WEwebLoader 有同等规模的测试门禁（242 项）。

## 6. 架构与工程差异小结

- **渲染后端**：本项目/WebWallGL/WEwebLoader 走 WebGL2；本项目是唯一 three.js 场景图 + Rust/WASM CPU 粒子混合的；OWE/we-layerd/lwe/KDE 走 Vulkan/OpenGL 原生；Loomscreen 用 Metal；kirie 用 wgpu；wallpaper-kit 用 D3D11。**本项目已删除 WebGPU 路径**，短期不构成差异优势。
- **性能手段**：本项目偏向「按 WE 语义正确性换性能预算」（对象 RT 分辨率、段渲染、单帧快照），原生阵营偏向零拷贝/多线程/render graph/预烘焙缓存；浏览器端 WebWallGL 用「GPU 优先 + 软渲染熔断」保底。
- **缓存**：本项目场景资源强制 `no-store`（便于改资源不脏缓存），竞品多有构建期/运行时缓存（kirie bundle、OWE shader/blob、elysia `scene.pkg` ETag、PWA 缓存）。**本项目缺少大包加载/首帧预算治理**（elysia 已有按包大小现算首帧预算 + 载荷账本 + 失败记忆，`HOW-IT-WORKS.md`），这是可借鉴的工程点。
- **测试**：本项目 vitest + headless Edge e2e + 基线棘轮成熟；WEwebLoader 242 项回归 + 静态闸门，we-layerd 有 ctest 契约测试；原生项目多数未公开测试规模（未核实）。
- **平台限制**：本项目仅 Windows 实测、需 WebGL2、需本机装 WE 取素材；原生项目把「多输出/多显示器/系统音频」做进了运行时，本项目受浏览器宿主形态限制，短期不补。

## 7. 对下一步的启示（供 Lead 判断）

- **最值得抄的行为（不抄代码）**：WebWallGL 的 scene 编辑器 + 导出 `scene.pkg` 是差异化护城河；若本项目要守住「DSH 内实时渲染」定位，优先级应是 ①puppet 真实素材验证与 attachments/masks ②copybackground ③colorBlendMode 全集 ④壁纸级 bloom/PBR ⑤相机 path/shake；编辑器不在当前工程量级内。
- **最值得借鉴的工程**：elysia 的「按包大小算首帧预算 + 载荷账本 + 失败记忆 + ETag 缓存」与 WebWallGL 的「无 GPU 熔断」；均与 MIT 兼容，但只能借鉴行为结论。
- **许可证红线**：we-layerd（无许可）、OWE/lwe/WEwebLoader/KDE（GPL）、kirie（AGPL）只能作行为对照，不得复制/逐行翻译；MIT 可参考：WebWallGL、elysia、Loomscreen、wallpaper-kit、skwd-wall。

---
补记（如实）：本轮未逐项核实 WebWallGL 源码（仅 README + elysia 文档），未核实 OWE 与 catsout 原仓的逐文件血缘，未核实 lwe 的 puppet 蒙皮/骨骼动画消费路径、we-layerd 渲染后端枚举；上述在矩阵中均按「未核实/部分」标注。统计数字（stars/license/pushed_at）为 2026-10-19 GitHub API 快照。
