# Agent Note: 媒体集成（Windows SMTC）+ SceneScript media 事件 + 时间线属性动画

Status: implemented

## Problem

壁纸 `3797976859`（小作 2(有声)）在插件里常驻一个白色方块：它的 5 个媒体图层（封面框 / 封面 / 歌名 / 歌手 / 媒体区）的隐藏逻辑只挂在 `mediaPlaybackChanged(PLAYBACK_STOPPED)` 上，而本插件从未派发任何媒体事件；`$mediaThumbnail` 实例纹理也未实现，封面回退成 `util/white` 纯白。同时 `{animation}` 时间线轨道从未解析，媒体层的淡入/滑入与 Fog 的 loop 漂移都不会播放。设计见 [2026-10-30-media-integration-design.md](../../../../docs/superpowers/specs/2026-10-30-media-integration-design.md)，实施计划见 [2026-10-30-media-integration.md](../../../../docs/superpowers/plans/2026-10-30-media-integration.md)，现状契约见 `AGENT.md` §5.54。

## Decision

- **host 常驻 watcher、懒启动、空闲退出**：仅 win32；首个 `now-playing` 请求才 spawn 一个 PowerShell（WinRT SMTC，每 700ms 采样，只在会话签名变化时输出一行 JSON，封面随行携带、单张 ≤512KB）；单实例、空闲 20s 退出（5s 检查一次）、异常退出由下一次轮询重新拉起（启动失败 5s 退避，60s 内 3 次失败降级 60s），插件 dispose 时 kill。数据只留在内存，**不落盘、不写日志**（日志只允许状态/原因计数），路由 `GET /wallpapers/now-playing?title=…` 与 `GET /wallpapers/now-playing/thumbnail?rev=N`。
- **客户端 1s 轮询而不是 SSE**：快照本就是 host 内存里的一个 GET，1s 本地轮询毫秒级；SSE 要维护 host→多标签页的事件流、重连与生命周期，收益不抵复杂度。仅当装配期判定「场景需要媒体」（媒体事件脚本或 `$mediaThumbnail`）才创建轮询，其余壁纸零请求。
- **会话选择的启发式**：`selectSession` 先剔除自身 `appId`（`path.basename(process.execPath)`）与 `title === document.title` 的会话（Chromium 为壁纸音效 `<audio>` 注册的自会话），再按 playing > paused → artist 非空 → 最近变化排序。页面标题过滤不可能完备，边界写入 `AGENT.md` §5.54/§7.44 并由面板开关兜底。
- **rev 语义 = 「封面变化」而非「递增序号」**：host 的 rev 全局单调、仅作内存缓存键；客户端只做 `!==` 比较（回退也算变化），不假设顺序或单调，避免关→开、淘汰后重取时把「不同图」误判成同一张。
- **事件层**：`SceneScriptHost/VM` 派发 `mediaPlaybackChanged` / `mediaStatusChanged` / `mediaPropertiesChanged` / `mediaThumbnailChanged`，`MediaPlaybackEvent` 常量按 WE 官方 **0/1/2 = stopped/playing/paused**；每对象多脚本（visible + 属性脚本不再互相丢弃）；`thisObject.getAnimation()` 返回时间线播放器；文本脚本额外广播 `mediaPropertiesChanged`。
- **时间线只覆盖 layer 属性**：`scene-timeline.ts` 解析 `alpha/origin/scale/angles/color` 的 `{animation:{c0,c1,c2,options}}`，支持贝塞尔（按本机样本校准的近似）、single/loop/mirror、startpaused、relative、父子 `parent/children` 与 `name`；时序固定为「时间线写状态表 → 脚本 tick 覆盖 → 重算世界变换」。**keep-out**：`general.*` / effect / material 属性不做（本机唯一受影响的 `3812518176` 的 `general.bloomstrength` 保持静态），隔离对象合成 quad 不做世界变换，粒子只应用 origin 平移。
- **封面 flipY 约定**：`createImageBitmap(blob, { imageOrientation: 'flipY' })` + 共享纹理 `flipY = false`——ImageBitmap 上传忽略 `UNPACK_FLIP_Y_WEBGL`，若再翻一次就是上下颠倒；所有 `$mediaThumbnail` 对象共享同一张 `THREE.Texture`，切歌先清旧图再设新图；主色用客户端 32×32 直方图 + 3 类 k-means 启发式（非 WE 原算法）。
- **R7：PowerShell 泛型名必须双反引号**（`"IAsyncOperation``1"`）：单反引号在 PS 双引号串里是转义符，会被吞成 `IAsyncOperation1` ⇒ `$asTask` 为 null、watcher 启动即 `Cannot index into a null array.`（Task 1 实测）。
- **R8：`lib/**` 与 `dist/**` 随提交**：本仓 `lib/` 是 npm 分发产物且纳入版本控制，改 `src/` 的每个 Task 都要 `npm run build` 并把对应 `lib/**` 变更随提交；`dist/client.js` 只在 client 变化时重建并提交。
- **Task 7 的 alpha 回滚在 Task 10 解除**：属性脚本的 media 回调常先写 `alpha=0` 再播放淡入；Task 7 尚无时间线，写入会永久透明 ⇒ 无 timeline 时只回滚这次 alpha≈0 写入（其余属性照常）。Task 10 起含动画场景会传入 timeline ⇒ 回滚自动解除（淡入交给时间线）。
- **基线红处置**：`tests/verify-real-library.test.ts` 曾对 `3797976859` 报 `materials/util/solidlayer_instance.json` 不存在——该材质由 WE 引擎目录在运行时提供（host 路由 pkg → `<WE>/assets` 两级查找），不是 pkg 链断。测试改为「已知引擎前缀（`materials/util/`）的缺失材质**与纹理**视作引擎提供、不计入 evidence」，其它缺失仍判红，并加确定性单测断言。

## Errata

- **watcher 启动失败退避 = 固定 5s（2026-10-30，review round 1）**：设计 §4.1 写「watcher 异常退出 → 1s 起指数退避、上限 8s」，代码未按原文落地——`media-session.ts` 的 `START_RETRY_MS = 5000` 是**固定 5s** 的启动失败重试窗口；进程 exit 不指数退避（下一次请求直接重启），60s 内 3 次失败降级 60s 不变。**以代码 5s 为准。**

## Alternatives considered

**每次请求短命 spawn PowerShell / 用 `exec` 一次性查询**：冷启动约 1.2s，而客户端 1s 轮询意味着几乎每个请求都要冷启动，成本与进程抖动不可接受；否决。

**SSE / WebSocket 推送**：见 Decision——快照本身是内存读取，1s 轮询更简单，失败退避与多标签页生命周期都无需新机制；否决。

**客户端直接读取 SMTC**：浏览器没有 WinRT/SMTC 能力，只能 host 侧读；否决。

**host 侧解码封面并取主色**：host 没有 canvas/图像库，且主色要跟随渲染纹理与切歌时序；client 侧 `createImageBitmap` + 32×32 直方图更直接、失败可降级中性色；否决。

**严格逐位复刻 WE 的贝塞尔/取色算法**：本机样本与权威参考不足，先按样本校准近似、以真机视觉验收兜底，边界写入文档；否决「一次做到位」。

**用轮询结果动态决定是否启动媒体**：那会让无媒体壁纸也先发一次请求；改为装配期静态判定 `sceneNeedsMedia`，把「零开销」做成结构性承诺；否决。

## Consequences

**收益：** 目标壁纸白框消失、播放时封面/歌名/歌手/主色/淡入滑入联动；时间线让 3 张既有壁纸中的淡入与 Fog loop 真正播放；无媒体脚本的壁纸零请求；媒体数据只在内存。

**代价：** 仅 Windows 有数据源；只读不控、不派发 `mediaTimelineChanged`；色板与贝塞尔都是近似；页面标题过滤可能误选（可关开关）；watcher 活跃时多一个 PowerShell 进程（约 30–60MB）；`color` 时间线已接线但本机无真实样本；隔离对象与 `general.*` 时间线仍缺。基线红处置放宽的是「已知引擎前缀」（材质与纹理同口径），其它证据不变。

**已知边界（review round 1 补记，判据见 `AGENT.md` §7.44）：** text 动画在父级 `scale` 时间线播放期间按装配期静态 scale 算左锚点 ⇒ 文本中心短暂漂移（静息归位；`0954b16` 已让文本变化刷新偏移，但「静态 scale」假设保留）；alpha 属性脚本的 `init/update` 守卫会连带跳过其 `cursorClick`（当前无该形态素材）；`clamp01` 对非有限值返回 1（不可达）；`TimelineRuntimeOptions.worldTransforms` 为死参数、`options.wraploop` 未消费；「timeline 存在时 alpha 不回滚」是 scene 级判定；只有 text 媒体脚本、无 scene 脚本/时间线的场景不会创建媒体轮询（事件无处派发）；媒体 e2e 与其它 headless e2e 必须串行并留 1–2s 间隔（紧跑有环境性失败），回归 `[R2]`/`[R3]` 是结构性弱断言、`[R1]` 不含 CDP `Log.entryAdded` 的 error。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `6246f70` `361a3e0` `fe9243c` `ff5995e` `8462c26` `b97c9d7` `c80b8d3` `3c95962` `7071d51` `7ffd6f7` `78194da` `1a60219` `a920187` `6a7e7ff` `d06bc49` `0954b16` `2f4d2d7`

## Final Fix Wave（final review 后修复轮）

> 触发：最终全分支 review 判 Merge-ready: NO（2 阻断 + 6 Important）。以下逐条落修法、测试/证据与剩余风险；不认领并发会话文件。

### B1 面板未显示媒体集成原因/隐私说明（DoD §14.4 / spec §4.5）

- **修法**：`shared/media.ts` 新增 `MediaIntegrationStatus { available; reason; enabled }`（纯类型、无曲目字段）；`media-orchestration` 在快照/开关变化时记录并暴露 `getStatus()`；`SceneRendererLike` 新增可选 `getMediaStatus?()`（renderer teardown 保留最近值、dispose 清空、不泄漏 title/artist）；设置面板把媒体开关从「性能与省电」移到 spec 要求的**「显示效果」组**，开关下方新增 `.wss-media-status` 说明行（启用 = 隐私说明；reason ∈ unsupported-platform/no-powershell/watcher-failed = 对应中文原因；关闭 = 已关闭），读取时机 = 挂载 + 1s 轮询。
- **证据**：`tests/media-orchestration.test.ts` 新增 getStatus 状态迁移与「只有三键」隐私断言；`tests/three-renderer.test.ts` 新增「无媒体场景 null / $mediaThumbnail 场景 no-session / 关闭 disabled / dispose null」；`tests/dom/settings-section.dom.test.tsx` 新增 3 例（开关在显示效果组 + 默认说明；文案随 reason 四态变化；关闭变已关闭 + data-state）；`index.ts` 注入共享 handler 并在 teardown 撤销。

### B2 applyLayerState 动态 color 破坏 text 静态色（回归）

- **修法**：`threejs-player.addBackground` 新增 `disableDynamicColor`，text 分支传 `true`，把 `userData.dynamicColorDisabled` 打到内容材质（隔离时也打到合成 quad 材质）；`applyLayerState.writeColor` 对带标记材质跳过 `color`，origin/scale/angles/alpha/visible 照常。
- **证据**：`tests/layer-state.test.ts` 两例（tint 与 MeshBasicMaterial 均不被写入、其余字段照常）；`tests/threejs-player.test.ts` 断言 text 直渲与隔离 quad 材质都带标记；`verify-media-layer --regression` 新增 `2980088441` 与 `[R6]`：obj54 材质 color≈`[1,1,1]`、可见、文本区红像素 539（脚本 color 若生效会压暗到 ≈116,0,0）；截图 `e2e/.out/media/regression-2980088441.png` 供人工复看。

### I1 迟到封面被 watcher 输出门丢弃

- **修法**：watcher 脚本新增 `$artDirty`：成功取到新封面时置 `$true`，输出条件加 `-or $artDirty`，输出后清 `$false`（`$lastArt` 语义不变，仍只在成功取到时更新）。
- **证据**：`tests/media-session.test.ts` 静态断言初始化/置位/输出条件/清除顺序。

### I2 stdout 跨块 UTF-8 解码

- **修法**：`media-session.ts` 用 `node:string_decoder` 的 `StringDecoder('utf8')` 累积解码；stop/start-error/exit/超长清空时重置 decoder。
- **证据**：`tests/media-session.test.ts` 把含中文假标题的 JSON 行按字节切在「测」的三字节中间分两块喂入，断言 title/artist/album 完整且 `badLines=0`（旧实现得 U+FFFD）。

### I3 applyInitial 重置脚本 init 的 play/setFrame

- **修法**：`TimelineRuntime` 拆出 `primeInitial()`（只重置 frame/playing/rate/finished）与 `applyInitial()`（只写值 + syncWorld，不再重置）；renderer 在 `SceneScriptHost.create` **之前** primeInitial、之后 applyInitial。
- **证据**：`tests/scene-timeline.test.ts` 新增集成用例：脚本 `init()` 里 `thisObject.getAnimation().play()/setFrame(7)`（origin 属性）→ applyInitial 后仍 isPlaying、frame=7、写入第 7 帧值；既有 15 处时间线用例同步改为 primeInitial + applyInitial。

### I4 既有 e2e 回归 + 性能量化证据

- 新增 `e2e/verify/verify-media-perf.mjs`（Node，不依赖浏览器/素材）：用生产 `lib/client/scene-timeline.js` + 内联 10 条动画，测 `advance+sampleAndWrite+syncWorld` N=2000 均值，断言 <50µs；`package.json` 新增 `e2e:media-perf`。
- `harness-media-entry.mjs` 增加 `__fpsProbe(ms)` / `__glRendererInfo()`（参考 text-clock harness）；媒体 e2e 末尾输出 FPS/GPU（诊断、不参与判据）。
- **实测（本机一次）**：时间线 13.0 / 14.6µs/帧（两次，10 条动画、N=2000、warmup=200，max 282–320µs 为 GC 尖峰）；媒体壁纸 FPS 60.3（真 GPU：NVIDIA RTX 3060 D3D11，headless 1600×900）。
- **串行 e2e**：`e2e:media` 13/13 PASS exit 0；`--regression` 5 张 22/22 PASS exit 0；`verify-colorblend` PASS；`verify-v081-gaps` exit 0；`verify-v082` PASS；`verify-text-clock-layer --no-teeth` exit 0；`verify-web-pointer-parallax` 7/7 PASS。既有红/不可运行（与本次无关）：`verify-hidpi-object-rt` 挂载期 RT 尺寸断言（v0.8.0 基线即 FAIL，TESTING §2.16 记录）；`verify-isolated-rt-sharpness` 的 `2132420420` 多隔离 obj37 与 `2911105183` 锐度阈值（素材/基线状态，本次未触 isolate/RT 代码）；`verify-turn-trigger-card` 因本机 DSH asar 缺 `CodeBlock.module.css` 无法运行（环境缺失）。

### I5 真机 M1–M8

- TESTING §2.17 顶部与勾选清单明确标注「以下 M1–M8 需真机手动勾选，当前未验」，全部保持未勾选；M8 判据改为断言面板状态行原因文案。

### I6 `obj.script` 派生契约不一致

- 不改代码；AGENT §7.44 新增边界 6：`obj.script` 仅对 `visible.kind==='script'` 派生（visualizer 识别用）与 `collectScriptSources` 支持 user+script 的契约不一致，后续统一。

### 剩余风险

- 真机 M1–M8（SMTC 会话选择、封面方向/主色观感、隐私与 watcher 残留、失败路径面板原因）仍需人工验收；B2 的「WE 是否对 text 应用 layer color」也待真机对照。
- 面板状态行 1s 轮询是简化实现（无推送通道）；状态在切到非媒体壁纸后保留最近值，可能显示旧的失败 reason，属可接受的提示口径。
- `verify-isolated-rt-sharpness` 的既有失败与本次修复无关，但未在本次建立独立基线证明（只核对了未触相关代码路径）。
