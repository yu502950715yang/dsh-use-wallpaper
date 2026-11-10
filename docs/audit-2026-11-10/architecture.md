# 架构与可维护性审查

> 范围：`src/`（host/client/shared）、`wasm/src/`、`scripts/`；口径以 `AGENT.md` §2/§5/§6 为参照。
> 基准：HEAD `f639e62`（v0.13.1 + 1.0 发布说明草稿）。**只读审查**：未改源码、未跑 build/test。
> 本文只报**结构性债务**（巨型单元 / 耦合 / 重复 / 类型洞 / 死代码 / 一致性 / 文档漂移 / 构建链），
> 不重复功能缺口与 `AGENT.md` §7 已记录的已知边界。
>
> 规模：`src` 95 文件 / **25,902** 行 · `wasm/src` 5 文件 / **3,334** 行 · `scripts` 8 文件 / **1,079** 行。
> 依赖边 223 条，`src` 内**唯一**的 import 环 = `host/routes ↔ host/scene-media-probe`。
> 结论：**P0 3 条 / P1 9 条 / P2 10 条**。类型纪律（strict、`@ts-ignore` = 0、`any` 70 处 / 52 行）与
> 门禁纪律（产物逐字节守卫、规则自带红测）明显高于同规模仓库；主要风险集中在**少数巨型单元**与
> **一条没有门禁的跨端契约**上。

---

## P0（会阻碍长期维护/易引入回归的结构性问题）

### P0-1 `threejs-player.ts` 3414 行：scene 唯一渲染路径被一个 God class 吞掉

**证据**

- `src/client/threejs-player.ts:704` `export class ThreeScenePlayer`，类体到 `:2968`，**2,265 行**；
  全文件 **3,414 行**（code 2,385 / 注释 878 / 空行 151），是第二名的 **2.1 倍**。
- 类内 **70 个方法**，覆盖 8 个互不相干的职责：

  | 职责 | 锚点 | 体量 |
  |---|---|---|
  | 粒子图层装配（4 种模式 × 实例属性） | `addParticle` `:2558` | 244 行 |
  | 背景 / image 图层装配 | `addBackground` `:1980` | 186 行 |
  | 段渲染 + 帧内快照 | `renderSegmented` `:1425` | 119 行 |
  | 对象隔离 / 效果合成 quad | `attachIsolated` `:2397`、`renderIsolatedContents` `:1962` | ~90 行 |
  | puppet 逐帧采样与释放 | `tickPuppets` `:1016` | 46 行 |
  | 视差（配置 + 指针 + 延迟时钟） | `tickParallax` `:1201` | 79 行 |
  | 精灵表帧推进 | `:1062-1170`（6 个方法） | ~110 行 |
  | 音频可视化条 | `setVisualizerBars` `:1690`、`setPixelVisualizerBars` `:1728` | ~120 行 |
- 类之外还有 **700 行自由函数 + GLSL 字符串**（`:149-702`）：`specMaxcount` / `specRenderer` /
  `specPerspective` / `specSparseEventSource` / `specEmitterOrigin`（spec JSON 每次重新 `JSON.parse`）、
  `PARTICLE_VERTEX_SHADER` `:343`（146 行）、`PARTICLE_FRAGMENT_SHADER` `:489`、`createWhiteTexture` `:549`、
  `colorBlendModeToThree` `:567`（**全仓 0 调用**，只有单测用）。
- **5 个** `*ForTest` 公有方法（`:1166` `spritesheetUvForTest`、`:1187` `backgroundMeshForTest`、
  `:1192` `tickParallaxForTest`、`:1835` `utilContentTextureForTest`、`:1840` `utilContentUvForTest`）
  把测试接缝钉在**生产类的公开 API** 上。

**为什么是问题**

- 这是 scene 渲染的**唯一**路径（`AGENT.md` §2.1），任何粒子/背景/puppet/util/后处理改动都落到同一个
  文件；`AGENT.md` §5 里 20+ 条硬约束（坐标、v 轴、混合因子、RT 尺寸）全部在这一个类的不同方法里
  互相耦合，**改 A 看到 B 的条件分支**是常态。
- 单文件 70 个方法 ⇒ 无法用「一个模块一个职责」判据 review；`git log` 冲突面集中在单文件。
- spec 解析函数每次调用重新 `JSON.parse` 同一字符串（`specMaxcount`/`specRenderer`/`specEmitterOrigin`
  各解析一次，实测 `:161`、`:182` 均为独立 `JSON.parse`），是职责混杂导致的**重复解析**，不是性能问题。

**建议（L）**

按「渲染单元」切成 4 个模块 + 1 个纯函数层，`ThreeScenePlayer` 只留帧序编排与 RT/相机状态：

1. `player/particles.ts`：`addParticle` + `writeParticleData` + 4 个粒子 composable（`ParticleLayer` 自管
   实例属性 / 容量扩容 / 视角矩阵），**收益最大**（244 行 + 3 个 per-layer map）。
2. `player/backgrounds.ts`：`addBackground` + alignment/color/tint + 精灵表帧控制。
3. `player/isolated.ts`：`attachIsolated` / `setObjectOutput` / `utilContents` / `renderIsolatedContents` /
   合成 quad（v 约定集中一处，§5.20/§5.46 的易错点只在一个文件里出现）。
4. `player/spec.ts`：`:149-330` 的 10 个纯函数（spec 解析 / 相机 / 容量）+ **解析结果缓存**（同一 spec
   现在被 `specMaxcount` `:159`、`specRenderer` `:179`、`specPerspective`、`specSparseEventSource`、
   `specEmitterOrigin` 各 `JSON.parse` 一次）。
5. `*ForTest` 改为注入式探针（构造参数 `{ probes?: PlayerProbeSink }`）或 `tests/` 侧的
   `(player as any)`，从生产 API 摘掉。

风险与收益：切片本身不改变行为（可用 `e2e:compare` + 既有 `tests/threejs-player.test.ts` 兜底），
但 **一次性 L 级改动会覆盖最敏感的文件**，建议分 4 个 PR、每个只搬一个职责并跑一次 `e2e:compare`。
收益 = 后续每个渲染改动的可读面积从 3.4k 行降到 ~400 行；`AGENT.md` §5 的锚点也能落到稳定文件。

### P0-2 `settings-section.tsx` 1499 行：一个组件 + 10 个模块级可变槽组成的面板「隐式总线」

**证据**

- `src/client/settings-section.tsx:312` `WallpaperSettingsSection`，函数体到 `:1499`，**1,188 行**
  （全仓最长函数，第二名 480 行）。组件内 **8 个 `useEffect` + 16 个 `useCallback` + 2 个 `useMemo` +
  3 个 `useRef`**，另有从 `:690` 起的 ~800 行 JSX —— 即「状态机 + 副作用编排 + 视图」三层全在一个函数里。
- 同文件还导出 **12 个跨模块注册函数**：`setWallpaperSelectHandler` `:68`、`setWallpaperRuntimeHandler` `:75`、
  `setWallpaperReselectHandler` `:83`、`setWallpaperSystemAudioHandlers` `:95`、`setWallpaperHealthHandler` `:125`、
  `subscribeWallpaperHealth` `:130`、`notifyWallpaperHealth` `:136`、`setWallpaperMediaHandler` `:151`、
  `subscribeWallpaperMedia` `:157`、`notifyWallpaperMedia` `:163`、`setWallpaperMediaIntegrationHandler` `:181`、
  `setWallpaperVideoHealthHandler` `:192`。
- 支撑它们的 **10 个模块级可变槽**：`:66/73/81/92/121/122/147/148/178/189`
  （8 个 `let xxxHandler = null` + 2 个 `new Set()` 订阅表）。
- `index.ts:10` 一次性 import 其中 **10 个** setter，`teardown`（`index.ts:223-230`）逐个手工置 null。

**为什么是问题**

- 「UI 组件文件」同时是**跨模块事件总线**：`index → settings-section → 面板` 的反向依赖让面板成为
  单例注册表，而生命周期靠 `bootstrap` 的手工顺序维持。DSH 的 client-hmr **会重新执行 bundle**
  （`AGENT.md` §3.2）⇒ 旧模块实例的 `let` 全丢，新实例的 setter 指向新槽位；任何一处漏挂/漏清
  （`index.ts:223-230` 目前 8 行）就是「面板按钮点了没反应」，且**没有任何编译期或门禁信号**。
- 单文件 1,188 行函数 = 无法局部测试；`AGENT.md` §5.39 的 58 个 `.wss-*` 类名契约全部压在同一文件，
  重排风险与行数成正比。

**建议（M）**

1. 把 `:66-197` 的注册槽 + 12 个导出搬到新模块 `client/panel-bridge.ts`（纯 TS，无 React），
   `settings-section.tsx` 只 import 读快照的 hook。**成本 S**，收益：注册表可单测、生命周期可断言。
2. 把 JSX 按页签切 4 个组件：`library`（库/搜索/收藏/筛选）/ `display`（显示效果 + 声音 + 画质）/
   `runtime`（实时渲染 + 视频健康 + 环境自检）/ `properties`（用户属性）。**成本 M**，
   收益：最长函数从 1,188 → <300 行；`.wss-*` 契约按组件分片，`tests/dom/settings-section.dom.test.tsx`
   的重排风险下降。
3. 顺手删掉 `:225` 的恒等函数 `const weT = (s: string): string => s`（1 处定义 + 3 处调用，只为当译者，
   属改名残留）。

### P0-3 host 路由契约在 client 里散落 35 处、14 个模块，且没有任何门禁能拦住改名

**证据**

- host 侧单点注册 **13 条**路由：`src/host/routes.ts:318` `registerWallpaperRoutes`（480 行单函数），
  `server.register({...})` 于 `:369 /wallpapers/list`、`:387 /wallpapers/media`、`:434 /wallpapers/boot/local-video`、
  `:450 /wallpapers/boot/probe`、`:468 /wallpapers/scene`、`:546 /wallpapers/frame`、`:594 /wallpapers/static`、
  `:631 /wallpapers/web`、`:675 /wallpapers/particle-texture`、`:718 /wallpapers/probe`、
  `:733 /wallpapers/now-playing`、`:743 /wallpapers/now-playing/thumbnail`、`:761 /wallpapers/properties`。
- client 侧**代码行**（已排除注释）里出现 `/wallpapers/...` 字面量 **35 处 / 14 个模块**：

  | 模块 | 处数 | 模块 | 处数 |
  |---|---|---|---|
  | `scene-assets.ts` | 8 | `effect-runner.ts` | 2 |
  | `three-renderer.ts` | 7 | `boot-settings-section.tsx` | 2 |
  | `boot-player.ts` | 3 | `background-layer.ts` | 2 |
  | `scene-fallback.ts` | 3 | `index.ts` / `media-input.ts` / `wallpaper-properties.ts` / `wasm-loader.ts` / `scene-script-vm.ts` / `text-script.ts` | 各 1 |
  | `settings-section.tsx` | 2 | | |

  典型：`scene-assets.ts:16/55/80/86/96/110/144/158`、`three-renderer.ts:104/419/586/744/871/1235/1305`、
  `scene-fallback.ts:30/31/37`、`index.ts:37`（用正则 `/\/wallpapers\/media\/([^/]+)\/file/` **反解**壁纸 id）。
- `src/shared/` **没有**路由常量模块（`ls src/shared` = `media / pointer-shim / types / user-refs / web-audio-shim`）。
- `scripts/verify-arch.mjs`（212 行）只拦 6 类边界（`:25-62`：host↔client、shared 纯、`node:*`、浏览器库、
  产物反向依赖），**规则里没有任何「跨端字符串契约」检查**；它连 import 环都不查（见 P1-3）。

**为什么是问题**

- 这是本仓**唯一没有任何门禁**的跨端契约：改一条路由名（如 `/wallpapers/particle-texture` →
  `/wallpapers/texture`）编译器全绿、`verify:arch` 全绿、单测全绿（单测用 mock fetch），**只在真机/e2e 才炸**，
  而 e2e 只覆盖 colorblend 等少数用例。查询参数契约（`?id=&name=`、`?refresh=1`、`?rev=`、`?path=`）
  同样只存在于字符串里。
- 反向依赖更隐蔽：`index.ts:37` 靠 URL 正则反推壁纸 id，`wasm-loader.ts:12` 硬编码 `/wallpapers/static`，
  `scene-script-vm.ts:456` / `text-script.ts:296` 各自硬编码 `/wallpapers/static/quickjs.wasm` —— 同一路径
  4 个模块各写一遍（重复实现清单第 6 项）。

**建议（M）**

1. 新增 `src/shared/routes.ts`：导出 `ROUTES` 常量 + `sceneAssetUrl(id, name)` / `particleTextureUrl(...)` /
   `nowPlayingUrl(title)` 等**唯一构造器**（纯函数，`shared` 允许）；host 的 `server.register` 与 client
   的 `fetch` 都从它取。改路由 ⇒ 编译期就能发现构造器调用点。
2. `verify-arch.mjs` 加一条规则：`src/client/**` 出现 `/wallpapers/` 字面量即报红（白名单只留 `shared/routes.ts`）。
   **成本 S**，规则自带红测样本（沿用现有 `SELF_SAMPLES` 机制），收益 = 这条契约从此受门禁保护。
3. 顺带把 `index.ts:37` 的 URL→id 反解改成由调用方传 id（`videoWallpaperId` 的正则本就只服务一条失败提示）。

---

## P1（应排期重构）

### P1-1 `three-renderer.ts` 1598 行、直接依赖 **39** 个模块：全仓耦合中心

**证据**：`src/client/three-renderer.ts:258` `createThreeSceneRenderer`（**1,340 行**闭包）；头部 import
39 条（fan-out 全仓第一，第二 `settings-section` 16、第三 `index` 16）。职责从注释自带标签就能数出来：
`// puppet（.mdl）→ 网格/蒙皮：解析、网格装配与材质都在这里接线`（`:8`）、
`// 帧内快照…`（`:24`）、`// 指针输入…`（`:52`）、`// WE 字体…FontFace`（`:86-125`）、
`particleBlend`（`:126`）、`collectUserKeys`（`:159`）、`collectObjectEffectChains`（`:180`）、
`collectScriptSources`（`:209`）、材质解析（`:1222`）、媒体编排接线（`:305`）。
它还是唯一 import `wallpaper-controller.ts` **接口**的渲染器（`:14` `import type { SceneRendererLike }`）——
接口定义在**消费者**（controller，`:12`）而不是中立 types 模块。

**为什么是问题**：39 条边的模块是「任何改动都要重编」的语义中心；它同时承担
①资源拉取 ②puppet 装配 ③字体加载 ④媒体/脚本接线 ⑤后处理管线 ⑥kinds 判定。
`AGENT.md` §2.1 说它是「接线层」，实际已是第二个 God module。

**建议（M）**：拆成 `renderer/assets.ts`（fetch + 字体 + 材质）、`renderer/scripts.ts`
（`collectScriptSources` / `collectObjectEffectChains` / 媒体接线）、`renderer/puppets.ts`（`.mdl` 装配），
`three-renderer.ts` 只留 `render()` 生命周期与 kinds 调度。收益：fan-out 39 → ~15，跨壁纸复用与
单测接缝都变清晰。`SceneRendererLike` 建议迁到 `client/types.ts` 或新的 `client/scene-renderer.ts`，
让 controller 与 renderer **都依赖第三个模块**（现在方向是 renderer → controller）。

### P1-2 `index.ts` 的 `bootstrap` 437 行闭包：20+ 个捕获变量手写生命周期

**证据**：`src/client/index.ts:42` `export function bootstrap(ctx?: any)` 到 `:478`（**437 行**）。
闭包内 20+ 个可变捕获：`bootActive / layer / controller / settings / disposed / backgroundToken /
onVisibility / healthStore / sceneRenderer / rotationPaused / rotationListLoadAttempted / rotation /
autoRetryTimers / …`。收尾全在 `teardown`（`:213-243`）+ `dropStaleLayers`（`:246-266`）两处手工枚举。
**设置被缓存两份**：`index.ts:75` `let settings = { ...DEFAULTS }` 与 `settings.ts:48` `let lastGood`
（`show()` 每次都 `settings = { ...settings, selectedWallpaperId }` 制造新对象，`:402/422/426/435/442/448`）。

**为什么是问题**：`AGENT.md` §5.43 的「幂等挂载 + 收尾」硬约束完全靠这段代码维持；HMR 每次重载都赌
「该清的都清了」。20+ 个捕获变量的生命周期没有类型约束，新增一个订阅/定时器时**漏清不会红**。
双设置缓存则让「面板改了值、全局 API 读到旧值」这类时序问题只能靠人记。

**建议（M）**：抽出 `createPluginRuntime()` 返回 `{ mount, teardown, settings }` 的显式对象，
把「注册即登记、收尾统一遍历」做成 `disposables: Array<() => void>`（现有 8 行 setter 置 null 变成
注册时 push）。设置统一走 `readClientSettings()`（去掉 `bootstrap.settings` 本地副本，改用
`settings.ts` 的单一缓存）。收益：新增订阅零成本、卸载正确性可被单测断言。

### P1-3 host 唯一的 import 环 + `routes.ts` 里 22 行 / 36 处 `any`（req/res 全靠 `any`）

**证据**

- **全仓唯一的 import 环**（`src`/`wasm/src`/`scripts` 全量扫描 223 条边，环只此一处）：
  `src/host/routes.ts:12` `import { extractEmbeddedMp4, probeEmbeddedMp4 } from './scene-media-probe.js'`
  ↔ `src/host/scene-media-probe.ts:5` `import { getPkgReader } from './routes.js'`。
  后果：`tests/scene-media-probe.test.ts` 为了测 mp4 探测，必须把整个 HTTP 层（含 `media-session` /
  `steam-paths` / PowerShell watcher 模块）一起加载。
- `routes.ts` 的模块级单例：`:39` `const READER_CACHE = new Map<...>()`（32 个 `PkgReader` 常驻，每个持
  整个 pkg buffer）+ `:42` `export function getPkgReader`。`AGENT.md` §7.42 ④ 自己记了「`PkgReader` 仍整包
  常驻内存（147MB 级 pkg）」，缓存键 = pkgPath+mtime，**没有任何释放点**（无 `dispose`/`ctx.effect`）。
- 类型洞：`routes.ts` 22 行 / **36 处** `any`（行号 `:120/136/177/229/257/286/298/318/319/370/389/435/
  451/470/548/597/633/683/722/735/745/764`），核心是 `ctx: any`（`:318`）、
  `(httpCtx: any)`（`:319`）、`handler: async (_req: any, res: any)`（13 个 handler 全同款）、
  `json(res: any, ...)`（`:120`）、`sendTexture(res: any, ...)`（`:136`）。全仓 `any` 70 处，这一个文件占 **51%**。

**为什么是问题**：环让 host 的单元不可独立测试；单例缓存无生命周期是「长会话内存只增」的结构性来源；
13 个 handler 的 req/res 全 `any` ⇒ DSH 侧 WebRoute 接口变化**编译器不会报**，只能等运行时 500。

**建议（M）**：① 把 `getPkgReader` + `READER_CACHE` 抽到 `host/pkg-cache.ts`（打破环，`routes` 与
`scene-media-probe` 都依赖它；`verify-arch` 加环检测防回归，见 P1-9）；② 给 `WebRoute` 的
req/res 定义最小 `interface`（`{ search: URLSearchParams }` / `{ writeHead/setHeader/end }`）放
`host/http-types.ts`，13 个 handler 换成它（`any` 70 → ~20）；③ 缓存加 `dispose`/`ctx.effect` 释放。

### P1-4 设置契约有三份副本，只有一条测试在中间拉着

**证据**

| 副本 | 位置 | 形态 |
|---|---|---|
| 类型 | `src/client/types.ts:14` `ClientSettings` | 33 字段 TS interface |
| client 默认值 | `src/client/settings.ts:15` `DEFAULTS` | 33 字段运行时常量 |
| host 校验 + 默认值 | `src/host/settings.ts:5` `WallpaperSettingsSchema` | 33 字段 schemastery（含 min/max/default） |

此外 client 只经 `settings.ts:63` `readClientSettings()` 的 `remote.describe()` 取**字符串键**，
`settings-section.tsx` 里还额外维护 `KNOWN_USERPROP_TYPES`（`:242`）与 `host/user-props.ts:7` `TYPES`
两份用户属性类型白名单。

**为什么是问题**：新增一个设置项要改 3 个文件；**漏改 schema 的后果是静默的** —— host 侧 schemastery
不认识该键 ⇒ 面板写入不落盘，下次读回退 `DEFAULTS`，用户看到「改了又变回来」；漏改 `DEFAULTS` 则
`undefined` 流进 UI（严格模式下 `ClientSettings` 会报错，只有这条兜住）。当前三份**内容一致**
（`overview.md` §3 已核对），但一致性只由一条测试维持，不属结构保证。

**建议（M）**：以 host schema 为单一事实源 —— ① `DEFAULTS` 改为 `WallpaperSettingsSchema(dummy)` 式的
「解析空对象得到默认值」（schemastery 支持），client 不再手写默认值；② `ClientSettings` 用
`typeof WallpaperSettingsSchema['__type']` 或 `as const` 派生，禁止手写第三份字段表；
③ 用户属性 `{bool,slider,color,combo}` 白名单下沉 `shared/` 一份。收益：删掉两份手抄表，
新增设置项从 3 处降为 1 处，且漂移从「测试发现」变「编译期不可能」。

### P1-5 `sim.rs` 1905 行：4 个职责 + 602 行内联测试

**证据**：`wasm/src/particle/sim.rs` 1,905 行 = 生产 **1,303** 行 + `#[cfg(test)] mod tests`（`:1304` 起）
**602** 行 + 注释 502 行。生产段可切成 4 块：`rand/perlin/curl` 噪声（`:35-337`，约 300 行）、
`ParticleOperator` 枚举 + `apply`（`:339-641`，**212 行的巨型 match**）、`SceneParticleSim` 生命周期
（`:699-1267`，含 `spawn_with_age_frac` **245 行** `:1008`）、`build_instance_vertices`（`:1268`）。
`spec_to_emitter.rs` 590 行、`mod.rs` 734 行（`parse_particle_spec` 130 行）。

**为什么是问题**：单文件混合「噪声数学 / 算子语义 / 模拟循环 / 顶点序列化 / 测试」，
而 `apply()` 的 match 臂对应 WE 的算子语义（`AGENT.md` §5.4/§5.5 的硬约束都落在这里），
加一个算子要在 212 行 match 里找位置。Rust 侧**没有 CI 门禁**（`overview.md` §3 已记 cargo 未进 CI），
所以这里的行为回归只能靠 `cargo test` 手工跑 + wasm 溯源。

**建议（M）**：`noise.rs`（perlin/curl）、`operators.rs`（枚举 + `apply`，按算子族再拆 3 个
`fn apply_*`）、`sim.rs`（生命周期）、`vertices.rs`；测试移到 `wasm/tests/`（现已有一个
`wasm/tests/` 目录，把内联测试搬过去即可，无需改断言）。收益：单文件 1,905 → 4×~400；
`apply` 的 212 行 match 可按算子族审阅。风险低（纯搬迁 + `cargo test` 兜底），但需先补 CI。

### P1-6 `scene-script-vm.ts` 1098 行：268 行 JS「prelude」以模板字符串形式承担脚本 ABI

**证据**：`src/client/scene-script-vm.ts:104` `const PRELUDE = \`` 到 `:371` 结束 = **268 行**
被 QuickJS 执行的 JS（`Vec2/Vec3/Vec4`、`createScriptProperties`、`__wrap`、`__mkLayer`…），
之后 `:430` 起是 `SceneScriptVm` 类（`installPrelude` `:492` 159 行、`anim` `:688` 107 行、
`dispatchMedia` `:879`、`buildMediaEvent` `:932`）。同款字符串在 `text-script.ts:38-100` 另有一份
（`__weScriptProps` / `__weModule` 的注入与 `import` 改写）。

**为什么是问题**：WE 场景脚本的**全部 ABI**（`thisScene` / `thisLayer` / `engine` / `localStorage` /
`MediaPlaybackEvent` 常量）写在字符串里 ⇒ ① `tsc` 完全看不到，改名/漏改只在运行时抛；
② 无语法校验（拼错模板变量会静默生成坏脚本）；③ 两处 prelude 各自演进而无共享契约
（`__weScriptProps` 在 `:121` 与 `text-script.ts:38` 各拼一遍）。

**建议（M）**：把 prelude 抽成 `src/client/script-runtime/prelude.js`（**含 JSDoc 类型**），
用 esbuild 的 `text` loader 或构建期 `readFileSync` 内联（`scripts/build-client.mjs` 已能注入
`__PLUGIN_VERSION__`，同法注入字符串）。**收益**：prelude 获得语法检查与编辑器补全；
`tests/` 可直接 `new Function(prelude)` 做冒烟。成本主要在构建链改一处。

### P1-7 `effect-runner.ts` 979 行：25 个导出、纯函数与 WebGL 执行器混住

**证据**：`src/client/effect-runner.ts` 导出 **25** 个符号；前 400 行是「为 node 单测导出的纯函数」
（`resolveTextureSlotPath` `:14`、`resolveBuiltinTexture` `:114`、`resolveEmptySlotTexture` `:171`、
`effectSlotCount` `:201`、`resolveSlotFallback` `:218`、`loadEffectTextureSlot` `:265`、
`pickWriteTarget` `:327`、`resolveTargetSize` `:341`、`resolveTextureResolution4` `:354`、
`fillAudioSpectrumUniform` `:374`、`describeEffectPass` `:383`），后 560 行是 `EffectRunner` 类
（`getMaterial` `:581` **119 行**、`resolveTextureSlot` `:782` **162 行**）。
模块级缓存 3 个：`:53 BUILTIN_CACHE`、`:97 frameSnapshotWarned`、`:169 EMPTY_SLOT_CACHE`（均无释放钩子）。

**为什么是问题**：一半是纯函数库、一半是有 GL 状态的执行器；类里 `getMaterial` 与 `resolveTextureSlot`
合计 281 行，是 §5.11「加载期建 RT / 帧内只写 uniform」这条硬约束的落点，改动时无隔离面。
`BUILTIN_CACHE`/`EMPTY_SLOT_CACHE` 跨壁纸常驻（`Map<string, Texture>`），没有清空入口。

**建议（M）**：`effect/slots.ts`（纹理槽解析纯函数，~400 行，node 可测）+ `effect/runner.ts`
（执行器 + 材质编译）。`BUILTIN_CACHE` 加 `clearBuiltins()` 并挂到 `sceneRenderer.dispose`。

### P1-8 横切小件各自实现：warn-once ×3、白纹理 ×3、PRNG ×2、日志前缀 ×4、dispose ×38

**证据**（详见「重复实现清单」）：同一语义在 2~3 个模块里各写一份：

- **warn-once**：`three-renderer.ts:70-74`（`warnedKeys` + `warnOnce`，`render()` 内 `clear()`）、
  `effect-runner.ts:503`（`private warnOnce`）、`threejs-player.ts:751` + `:807`（两个 `Set<number>`
  各自判重）。三种实现、三种失效语义（全局/每次 render/永久）。
- **1×1 白纹理**：`threejs-player.ts:549`（**每次装配新建**，`addParticle` 里 3 个地方调用
  `:2276/2662/2673`）、`mesh-material.ts:67`（模块级 `whiteTex` 单例，**永不 dispose**）、
  `effect-runner.ts:136`（`BUILTIN_CACHE` 里 key=`white`）。语义相同、生命周期三种。
- **`mulberry32` PRNG**：`particles.ts:29` 与 `effect-runner.ts:43` 逐字重复。
- **日志前缀 4 套**：`[wallpaper-engine]`（约 40 处）、`[three]`（17 处）、`[text-script]`（3 处）、
  `[mdl]`（1 处，`mdl-parser.ts:591`，`AGENT.md` 未记）。
- **dispose/teardown 38 个**：无统一基类/接口，`index.ts` 只能手工逐个调。

**为什么是问题**：每多一处「自己再写一遍」，就多一条**漏改**路径；warn-once 的三套语义已经导致
「同一告警在切壁纸后重复刷屏 / 永不重报」两种相反行为并存。

**建议（M）**：新增 `client/diagnostics.ts` 导出 `warnOnce(key, msg, { scope })` + 统一
`[wallpaper-engine]` 前缀（如要保留子系统标签就定为 `[wallpaper-engine:three]` 等**二级标签**）；
白纹理收一个 `shared-textures.ts`（含 `disposeSharedTextures()` 挂到 renderer dispose）；
PRNG 收一个 `rand.ts`。**收益**：删 ~120 行重复，日志可 grep 归纳。注意：改日志前缀会影响
`AGENT.md` §5.39 之外的排查习惯与 e2e 里的字符串断言（`verify-v082.mjs` 断言 warn 文案），
需同步扫一遍 `e2e/`。

### P1-9 `verify-arch.mjs` 的规则盲区：不查环、不查跨端契约、只扫 `src/`

**证据**：`scripts/verify-arch.mjs:25-62` 6 条规则全部是「目录级 import 归属」，判定发生在
`:112-134`；`:191` `scan()` 只 `walk(join(REPO,'src'))`；`:114` 对**相对说明符**才做目录判定，
裸说明符走不到分层规则。因此：① `routes ↔ scene-media-probe` 环**能通过**（同为 `src/host`）；
② P0-3 的 35 处 `/wallpapers/` 字符串能通过；③ `wasm/`、`scripts/` 完全不在扫描范围（`wasm` 侧
`spec_to_emitter` 与 `sim` 的相互依赖、`scripts` 与 `lib` 的依赖都无人管）；④ `host-no-browser-lib`
白名单只 4 个包（`three/react/react-dom/react/jsx-runtime`），`quickjs-emscripten` 之类进 host 不会红。

**为什么是问题**：这是本仓**唯一的架构门禁**（CI typecheck job 第一步、`verify:local` 门禁 0），
它自带红测样本（`:139-157`）说明作者有「规则要可信」的意识 —— 但规则集合本身停在「分层」阶段，
没覆盖已经出现的真实问题（环 + 跨端契约）。

**建议（S/M）**：

1. **环检测**（S）：把 `:112-134` 的边集合复用成图，DFS 找环，环即报红。现有唯一环会立刻被抓到，
   修完 P1-3 后成为防回归网。
2. **路由字面量规则**（S）：`src/client/**` 出现 `/wallpapers/` 即红，白名单 `shared/routes.ts`。
3. **扫描范围**（S）：`walk` 增加 `wasm/src`（只查跨 crate 引用）与 `scripts`。
4. 收益：三条规则 ~60 行，把 P0-3 与 P1-3 从「靠纪律」变成「靠门禁」，且反哺规则自检样本。

---

## P2（建议）

### P2-1 死代码：120 行 JS 粒子实现、1 个 0 调用的导出、1 个只服务单测的可见性函数、5 个 `*ForTest`

**证据**

| 对象 | 位置 | 现状 |
|---|---|---|
| `createParticleSystem`（77 行）+ `alphaAt` | `src/client/particles.ts:44` / `:40` | 120 行模块；生产只用 `import type`（`scene-assets.ts:6`），实现**只被 `tests/` 调用**（12 / 6 次） |
| `fetchParticleSpec` | `src/client/scene-assets.ts:54` | `rg` 全仓 **0 调用**（仅定义） |
| `resolveVisibility` | `src/client/visibility.ts:83` | 注释自认「该导出现仅单测使用」 |
| `spritesheetUvForTest` / `backgroundMeshForTest` / `tickParallaxForTest` / `utilContentTextureForTest` / `utilContentUvForTest` | `threejs-player.ts:1166/1187/1192/1835/1840` | 生产类的测试专用公有方法 |
| `colorBlendModeToThree` | `threejs-player.ts:567` | 生产 0 调用，仅单测 |
| `weT` 恒等函数 | `settings-section.tsx:225` | 改名残留（1 定义 + 3 调用） |

`TODO/FIXME/XXX/HACK` 在 `src/` + `wasm/src/` 里 **0 处**（全仓 55 处匹配全在 `e2e/`、`scripts/` 或
中文「临时」注释里），注释掉的代码 **0 处** —— 这两项纪律很好，死代码问题集中在「只为测试而活」的导出上。

**建议（S）**：`particles.ts` 只留 3 个 `interface`（改名为 `particle-spec-types.ts`），删实现
（需要 oracle 就在 `tests/fixtures/` 保留）；`fetchParticleSpec` 与 `weT` 直接删；
`*ForTest` 改注入探针（见 P0-1 第 5 点）。收益：删 ~150 行 + 缩小生产 API 面；风险：低
（有测试反向约束，删完跑 vitest 即可）。

### P2-2 代码注释引用已删模块 19 处（7 个文件）/ 引用 gitignore 的 `research/` 3 处

**证据**：`AGENT.md` §2.1 明确 `wasm-renderer.ts` / `scene-renderer.ts` / `scene-script.ts` /
`shader/glsl-to-naga.ts` 已于 2026-09-22 删除，但代码里仍在引用（按文件计 **19 处**）：

- `threejs-player.ts` **6** 处（`:3/7/9/547/843/1978`，其中 `:843` 指向 `wasm/src/render/mod.rs` ——
  该目录已删）、`three-renderer.ts` **5** 处（`:266/550/583/623/679`）、
  `shader-preprocessor.ts` **2** 处（`:65/85`，指向 `glsl-to-naga`）、`object-range.ts` **2** 处
  （`:2-3`）、`effect-chain.ts` **2** 处（`:88/112`）、`scene-json.ts` **1** 处（`:397`）、
  `effect-runner.ts` **1** 处（`:424`）。
- `tex-loader.ts:279`、`:521`、`parallax.ts:2` 引用 `research/.lwe/src/...`（`research/` 在
  `.gitignore:8`，新克隆机器上不存在，「查证路径」对贡献者不可用）。

**建议（S）**：把「历史来源」类引用统一改成 `AGENT.md §2.1` 指针（`AGENT.md` §6 已经这么要求：
「代码里只留一句结论 + `AGENT.md §x` 指针」）；`research/` 引用改成文字结论（如「对齐 lwe 的
`CTexture.cpp:176-183`」不写本地路径）。收益：新贡献者不再追一个不存在的文件。

### P2-3 生产路径上的 `console.log` 无开关（5 处，含每场景一次 + 每粒子层两次）

**证据**：`three-renderer.ts:1250`（每次装配带脚本的场景打一条 `[three] scene scripts id=…`）、
`:1465`（每次 `scene loaded`）、`threejs-player.ts:1509`（每次段渲染 `[three] refract layer=…`）、
`:2812` + `:2818`（每个粒子层首帧 + 满池各一条）、`index.ts:46`（`console.info` 版本横幅）。
`src/client/diagnostics.ts`（78 行）已经是「诊断信息」模块，但**没有日志级别开关**接这些点。

**建议（S）**：加 `client/debug-log.ts` 的 `debugLog(...)`，开关 = `localStorage['we:debug']` 或
`ctx.config.debug`（缺省关）。收益：控制台噪声从「每次切壁纸 3-5 行」降到 0；排查时一键打开。

### P2-4 插件自有 window 全局有三套前缀，其中一处未进文档

**证据**：`window.__wallpaperEngine`（`index.ts:392`，公开 API）、`window.__wallpaperEngineBoot`
（`:72`）、`window.__wpEngineTeardown`（`:31`，内部交接）、`globalThis.__weAudioDebug`
（`audio-input.ts:178-179`，诊断快照）。`AGENT.md` 只记了前两个（§2.1/§3.2/§5.56）；
`__weAudioDebug` 与 `__wpEngineTeardown` 未进文档，`__we*` 前缀还与 QuickJS 沙箱内的
`__weScriptProps` / `__weModule`（沙箱 ABI，合理）撞风格。

**建议（S）**：全局名收一张表（`client/globals.ts` 的常量 + 一句文档），调试钩子统一 `__wp*`；
在 `AGENT.md` §7 补一行「调试全局清单」。

### P2-5 构建产物门禁的三个缺口（都靠人纪律）

**证据**

1. **`dist/client.js.map` 不在任何 diff 门禁内**：`ci.yml` 的产物守卫是
   `rm -f dist/client.js dist/client.js.map; node scripts/build-client.mjs || true; git diff --exit-code -- dist/client.js`
   —— 只 diff `client.js`；`verify-local.mjs:46-52`（门禁 1c）同样只 diff `client.js`。而 map 占发布包
   一半体积（`overview.md` §3 已记 51.4%），map 与 bundle 不同步时调试器映射到错行。
2. **`dist/static/` 的 wasm 三件只在 `check-release.mjs:24-31` 里校验**（sha256 + `WASM_BUILD.json` +
   源码 commit 基线），而 **CI 不跑 `check-release`**（`ci.yml` 三个 job 只跑 verify-arch / tsc /
   产物 diff / tests 类型棘轮 / vitest / e2e colorblend）。⇒ 改了 `wasm/src` 却没重建 wasm 的 PR，
   CI 全绿，只有发布时才红（`AGENT.md` §3.1 的「铁律」仍靠人记）。
3. **`wasm/pkg/` 是 gitignore，`dist/static/` 入库**：产物由 `build:client` 复制（`build-client.mjs:70-80`
   有缺失即报错的守卫，这点很好），但「Rust 改了 → build:wasm → build:client → gen:wasm-manifest」这条
   四步链只在 `AGENT.md` §3.1 与脚本注释里，**没有一条命令能替人记住顺序**。

**建议（S/M）**：① CI 的产物守卫加 `git diff --exit-code -- dist/client.js.map`（S）；
② CI 增加 `node scripts/check-release.mjs` 的 ①②两项（产物 + wasm 溯源，不跑 npm pack）（S）——
这样 Rust 改动不重建会在 PR 阶段红；③ 新增 `npm run build:all`（`build:wasm && build:client &&
gen:wasm-manifest`）并在 `AGENT.md` §3.1 置顶（S）。收益：把 3 条人纪律转成 3 条门禁。

### P2-6 `package.json` 20 个 scripts：10 个 e2e 包装器 + 2 个门禁无别名

**证据**：20 个 script（`npm pkg get scripts | …`）：`test / typecheck:tests / build / build:wasm /
build:client`（5 个真实动作）+ `e2e:*` **10 个**（每个都是一行 `node e2e/verify/xxx.mjs`）+
`verify:arch / verify:local / check:release / gen:wasm-manifest`（4 个）。而 CI 里实际执行的两条门禁
`node scripts/check-known-failures.mjs`（`ci.yml` test job）与 `tsc --noEmit` **没有 npm 别名**，
`e2e:media-perf` 也不在 `verify:local` 里。

**建议（S）**：`e2e:*` 收敛为 `e2e -- <case>` 单入口（`node e2e/verify/run.mjs <case>`，10 个包装器
合并成 1 个 + case 表）；给 `check:known-failures`、`check:types` 补别名，让「CI 跑什么」与
「`npm run` 能跑什么」一一对应。收益：scripts 20 → ~11，`AGENT.md` §3.1 的命令表不再漏项。

### P2-7 `as unknown as` 类型漏斗 30 处，其中 7 处集中在用户属性解析

**证据**：全仓 `as unknown as` / `as any` **30 处**（`rg -n 'as unknown as|as any' src`）。最集中的是
`src/client/user-bindings.ts` 的泛型解析器 `resolveUserValue<T>`（`:55-81`，7 处
`... as unknown as T`）—— 它把 `{user,value}` 的任意 JSON 值强行转成 `T`（`bool/color/vec3/number`），
类型系统在这里完全失效。其余是合理的「宿主 API 未类型化」补偿（`navigator.userActivation` ×2、
`three` 私有字段 `_maxInstanceCount`、`ReadPixelsGl`、`Clipboard` 等）。

**为什么只是 P2**：这是 WE 数据形态（作者 JSON 里同一个字段可能是 `"1 0 0"` / `[1,0,0]` / `1`）
决定的，强行建模成本高于收益；风险局限在装配期（错误值走「回退作者值」路径）。

**建议（S）**：给 `resolveUserValue` 加一个**显式判别参数**（`kind: 'bool'|'number'|'vec3'|'color'`）
返回 discriminated union，去掉 `as unknown as T`；其余 23 处保留并在 `AGENT.md` 记一句「类型洞清单」，
避免下次审查重复发现。

### P2-8 注释密度与 §6「注释从简」的张力

**证据**：`AGENT.md` §6 要求「注释默认只写一行，最多 2 行；禁止复述代码/罗列实验数据」。
实测：`threejs-player.ts` 注释 878 行 / 2,385 代码 = **37%**；`effect-runner.ts` 213/706 = 30%；
`sim.rs` 502/1,303 = 39%。最长连续注释块 14-15 行（`threejs-player.ts:2969`、`effect-runner.ts:154`），
内容多为「历史根因 + 实测数字」（如 `three-renderer.ts:120-125` 讲 DK WOTLK 黑方块、`impact` 数字）。

**为什么是问题**：这些正是 §6 明确要求「写进 AGENT.md/docs、代码只留一句 + §x 指针」的内容；
它们现在是**第三份事实源**（`AGENT.md` / `docs/fixes/` / 代码注释），漂移时没人知道该信哪份
（本文「文档漂移」节已实证 9/16 锚点失效）。

**建议（M）**：对 5 个最大文件做一轮「注释瘦身」：保留结论句 + `AGENT.md §x`，长段搬进
`docs/fixes/`。**不建议机械去重**（§5 的硬约束确实需要上下文），优先处理「已与代码不一致」的
注释（P2-2 那 19 处）。收益：文件行数 −600~800，且事实源回到 2 份。

### P2-9 一个模块一个职责被破坏的三处（`settings-section` 之外）

**证据**：① `settings-section.tsx` 兼事件总线（P0-2）；② `three-renderer.ts` 兼资源层
（P1-1）；③ `effect-runner.ts` 兼纯函数库（P1-7）。另有 `shared/types.ts` **291 行 / 27 个导出**
承担 host+client+scene.json+userprop+media 全部类型，任何一侧加字段都改这个文件（fan-in **32**，
全仓第一）；`client/types.ts`（66 行）与它职责重叠（`ClientSettings` 放 client，`WallpaperInfo`
放 shared）。

**建议（S/M）**：`shared/types.ts` 按域拆 `types/scene.ts`（`SceneDescription`/`SceneObject`）、
`types/wallpaper.ts`（`WallpaperInfo`）、`types/userprop.ts`、`types/media.ts`，各文件 re-export 到
`types.ts` 保持 import 兼容（零改动迁移）。收益：fan-in 32 的文件变成 4 个 ~60 行文件，
新增字段的冲突面收敛到域。

### P2-10 `AGENT.md` 缺失「谁在写、谁在读」的模块归属表

**证据**：`AGENT.md` §2.2 用两段散文列出 host/client/shared 的模块，**不做「模块 ↔ 职责 ↔ 禁止依赖」的
表**；因此每次新增模块都在散文里加一句（实际已漏 16 个文件，见漂移节）。`README.md:343-374` 的目录树
更旧（漏 ~30 个模块），两份文档与代码的**唯一校验**是人工比对。

**建议（S）**：把 §2.2 改成表格（模块 / 职责一句话 / 允许依赖层 / 公开出口），并由
`verify-arch.mjs` 顺手校验「`src/**` 每个文件都在表里」（解析 AGENT.md 的表格即可，S 级）。
收益：新增模块漏登记会在门禁红；反哺 P1-9。

---

## 关键量化表

### 1. 文件行数 TOP10（`@(Get-Content).Count`，含空行/注释）

| # | 文件 | 总行 | 代码 | 注释 | 空行 | 主要职责数 |
|---|---|---|---|---|---|---|
| 1 | `src/client/threejs-player.ts` | **3,414** | 2,385 | 878 | 151 | 8+（见 P0-1） |
| 2 | `wasm/src/particle/sim.rs` | **1,905** | 1,326 | 502 | 77 | 4（含 602 行内联测试） |
| 3 | `src/client/three-renderer.ts` | **1,598** | 1,215 | 357 | 26 | 6（见 P1-1） |
| 4 | `src/client/settings-section.tsx` | **1,499** | 1,341 | 86 | 72 | 2（UI + 事件总线） |
| 5 | `src/client/scene-script-vm.ts` | **1,098** | 905 | 127 | 66 | 3（prelude / VM / 媒体派发） |
| 6 | `src/client/effect-runner.ts` | **979** | 706 | 213 | 60 | 2（纯函数库 + 执行器） |
| 7 | `src/client/shader/we-headers.ts` | **807** | 695 | 44 | 68 | 1（GLSL 头，合理） |
| 8 | `src/host/routes.ts` | **797** | 654 | 102 | 41 | 3（13 路由 + 缓存 + 校验） |
| 9 | `src/client/styles.ts` | **780** | — | — | — | 1（CSS 字符串，合理） |
| 10 | `wasm/src/particle/mod.rs` | **734** | — | — | — | 2（spec 解析 + 导出） |

> 参考：`tex-loader.ts` 722 · `shader-preprocessor.ts` 697 · `mdl-parser.ts` 638 ·
> `background-layer.ts` 615 · `spec_to_emitter.rs` 590 · `scene-json.ts` 552 · `scene-timeline.ts` 543。
> **>800 行文件 = 7 个**（TS 6 + Rust 1：`threejs-player` `sim.rs` `three-renderer`
> `settings-section` `scene-script-vm` `effect-runner` `we-headers`）；**>500 行 = 17 个**。

### 2. 最长函数（brace-matching，仅列 ≥150 行）

| 行数 | 位置 | 函数 |
|---|---|---|
| **1,188** | `settings-section.tsx:312` | `WallpaperSettingsSection` |
| **480** | `host/routes.ts:318` | `registerWallpaperRoutes`（闭包内含 13 个 handler） |
| **437** | `client/index.ts:42` | `bootstrap`（20+ 捕获变量） |
| **436** | `background-layer.ts:180` | `createBackgroundLayer` |
| **293** | `boot-settings-section.tsx:116` | `BootSettingsSection` |
| **262** | `scene-timeline.ts:282` | `createTimelineRuntime` |
| **245** | `sim.rs:1008` | `spawn_with_age_frac` |
| **212** | `sim.rs:419` | `ParticleOperator::apply`（巨型 match） |
| **207** | `boot-overlay.ts:64` | `createBootOverlay` |
| **201** | `media-session.ts:190` | `createMediaSessionService` |
| **195** | `scene-json.ts:317` | `parseSceneJson` |
| 244 / 186 / 162 / 159 / 149 / 130 | `threejs-player.ts:2558` / `:1980` / `effect-runner.ts:782` / `scene-script-vm.ts:492` / `tex-loader.ts:490` / `mod.rs:389` | `addParticle` / `addBackground` / `resolveTextureSlot` / `installPrelude` / `textureFromTex` / `parse_particle_spec` |

> 「>200 行函数」共 **10 个**（TS 8 + Rust 2，其中 `spawn_with_age_frac` 与 `apply` 同属 `sim.rs`；`parseSceneJson` 195 行未计）。
> `settings-section.tsx` 的 hooks 本身不超标（8 个 `useEffect` 最长 34 行），问题在**总量与耦合**：
> 20+ 个 hook 与 800 行 JSX 共享同一函数作用域。

### 3. `any` 计数 TOP8（按类型位置计，含 `as any`；「行」= 含 `any` 的行，「处」= 出现次数）

| # | 文件 | 行 | 处 | 行号 | 主要形态 |
|---|---|---|---|---|---|
| 1 | `src/host/routes.ts` | **22** | **36** | 120,136,177,229,257,286,298,318,319,370,389,435,451,470,548,597,633,683,722,735,745,764 | `ctx: any` / `(httpCtx: any)` / `(req: any, res: any)` ×13 / `json(res: any)` |
| 2 | `src/client/index.ts` | **9** | 12 | 20,42,72,240,242,247,381,392,484 | `bootstrap(ctx?: any)` / `(window as any).__wp*` ×6 / `apply(ctx: any)` |
| 3 | `src/client/scene-assets.ts` | **6** | 6 | 21,26,27,28,29,30 | `particlesFromSpec(root: any)` 及 spec 解包 |
| 4 | `src/client/settings.ts` | **5** | 5 | 44,51,57,59,91 | `settingsCtx: any` / `remote: any` / `resp: any` |
| 5 | `src/host/index.ts` | **4** | 5 | 37,41,51,81 | `(config as any).get()` / `(apply as any).Config` |
| 6 | `src/client/scene-json.ts` | **3** | 3 | 273,318,325 | 原始 JSON 解包 |
| 7 | `src/client/boot-settings-section.tsx` | **2** | 2 | 37,38 | `(globalThis as any).__wallpaperEngineBoot` |
| 8 | `src/client/setup-tip.tsx` | **1** | 1 | 25 | slots ctx |

> 合计 **70 处 / 52 行**（其中 `as any` 12 处）；`@ts-ignore` **0** / `@ts-expect-error` **0**；
> `as unknown as` **18 处**（`user-bindings` 7）。**类型纪律优于同规模仓库**，问题集中在一个文件。

### 4. 模块级可变状态清单（**28 个槽 + 4 个 window 全局**）

| 模块 | 槽 | 语义 | 释放点 |
|---|---|---|---|
| `settings-section.tsx` | `:66 sharedOnSelect` · `:73 sharedOnRuntimeSettings` · `:81 sharedOnReselect` · `:92 sharedSystemAudio` · `:121 healthHandler` · `:122 healthSubscribers(Set)` · `:147 mediaHandler` · `:148 mediaSubscribers(Set)` · `:178 mediaIntegrationHandler` · `:189 videoHealthHandler` | 面板事件总线（**10 个**） | 仅 `index.ts:223-230` 手工置 null |
| `three-renderer.ts` | `:70 warnedKeys(Set)` · `:78 lastWorldTransforms` · `:84 subscriberWarned` · `:88 FONT_CACHE(Map)` · `:89 fontSeq` | 告警去重 / 测试快照 / 字体缓存 | `:560` 清 warnedKeys；其余无 |
| `effect-runner.ts` | `:53 BUILTIN_CACHE(Map<Texture>)` · `:97 frameSnapshotWarned` · `:169 EMPTY_SLOT_CACHE(Map<DataTexture>)` | 内置纹理缓存 / 一次性告警 | **无**（跨壁纸常驻显存） |
| `settings.ts` | `:44 settingsCtx: any` · `:48 lastGood` | ctx 注入 / 设置缓存 | `:53` ctx 换时清 lastGood |
| `index.ts` | `:31 TEARDOWN_KEY` · `:33 bootstrapLogged` | 跨实例交接 / 日志一次 | teardown 里删 key |
| `host/routes.ts` | `:39 READER_CACHE(Map<PkgReader>)` | pkg 解包缓存（整包 buffer） | **无** |
| `host/scene-media-probe.ts` | `:28 PROBE_CACHE(Map)` | mp4 探测缓存 | **无**（上限 32） |
| `mesh-material.ts` | `:67 whiteTex: DataTexture` | 共享白图 | **无** |
| `scene-fallback.ts` | `:47 frameInFlight(Map<Promise>)` | 抓帧去重 | 完成后自删 |
| `text-script.ts` | `:291 runtimePromise` | QuickJS 单例 | `:333` 仅测试钩子 |
| `audio-input.ts` | `:81 gestureArmedContexts(WeakSet)` | 手势解锁去重 | GC 兜底（合理） |
| window 全局 | `__wallpaperEngine`(index:392) · `__wallpaperEngineBoot`(:72) · `__wpEngineTeardown`(:31) · `__weAudioDebug`(audio-input:178) | 公开 API / HMR 交接 / 诊断 | 前三个 teardown 清；`__weAudioDebug` 不清 |

**风险分级**：无释放点的 3 个纹理/pkg 缓存（`BUILTIN_CACHE`、`EMPTY_SLOT_CACHE`、`whiteTex`）+
`READER_CACHE` 是长会话内存单调增长的结构性来源；`settings-section` 的 10 个槽是「重挂载后按钮
失灵」的唯一来源（P0-2）。

### 5. 重复实现清单

| 语义 | 实现处 | 差异 | 是否建议合并 |
|---|---|---|---|
| 1×1 白纹理 | `threejs-player.ts:549`（每次新建）/ `mesh-material.ts:67`（单例）/ `effect-runner.ts:136`（缓存内） | 生命周期三种 | ✅ 合并（P1-8） |
| PRNG `mulberry32` | `particles.ts:29` / `effect-runner.ts:43` | 逐字相同 | ✅ 合并（P1-8） |
| warn-once | `three-renderer.ts:71` / `effect-runner.ts:503` / `threejs-player.ts:751,807` | 全局 / 每次 render 清空 / 永久 | ✅ 合并 + 显式 scope |
| 日志前缀 | `[wallpaper-engine]` 40 / `[three]` 17 / `[text-script]` 3 / `[mdl]` 1 | 4 套，`[mdl]` 未文档化 | ✅ 统一 + 二级标签 |
| 路由构造 | 35 处字面量 / 14 模块（P0-3）；`/wallpapers/static` 在 4 个模块各写 | 无 | ✅ 合并（P0-3） |
| 设置契约 | `client/types.ts:14` / `client/settings.ts:15` / `host/settings.ts:5` | 手抄三份 | ✅ 单一事实源（P1-4） |
| 设置缓存 | `index.ts:75` / `settings.ts:48` | 两份副本，`show()` 每次换对象 | ✅ 合并（P1-2） |
| 用户属性类型白名单 | `settings-section.tsx:242` / `host/user-props.ts:7` | 4 值手抄两份 | ✅ 下沉 shared |
| hex/颜色解析 | `text-color.ts:29 normalizeHexColor`+`:49 hexLuma` / `settings-section.tsx:292 colorTripletToHex`+`:300 hexToColorTriplet` | 各自实现 | ⚠️ 部分（triplet↔hex 是面板专用，可留，但应复用 normalizeHexColor — 已复用，仅建议移到一处） |
| dispose/teardown | 38 个方法，无接口/基类 | 语义各自定义 | ⚠️ 不建议强行统一（GL 资源生命周期差异大），但建议统一 **接口形状** `{ dispose(): void }` |
| 错误文案 | `object-effects.ts:464` 与 `:471` 同一句「对象效果链更新失败」 | 两个 catch 各写一遍 | ✅ 抽一个 `warnEffectChainFailed(e)` |
| 「渲染器接口」 | `SceneRendererLike`（`wallpaper-controller.ts:12`，1 个必需 + 13 个可选方法） | 消费者定义、实现者依赖 | ✅ 迁中立模块（P1-1） |

> 说明「不合并的理由」：`dispose` 与 `SceneRendererLike` 的**可选方法**形态是当前降级链的刻意设计
> （渲染器可缺能力），强行收成抽象基类会增加耦合；建议只做「形状统一 + 归属修正」，不做实现合并。

### 6. 依赖耦合（223 条边）

| 类型 | TOP |
|---|---|
| fan-out（直接依赖数） | `three-renderer` **39** > `settings-section` 16 = `index` 16 > `threejs-player` 14 > `host/routes` 11 > `wallpaper-controller` 8 |
| fan-in（被依赖数） | `shared/types` **32** > `shared/media` 11 > `client/types` 8 > `client/settings` 6 > `render-health`/`layer-state`/`user-bindings` 5 |
| import 环 | **1 个**：`host/routes ↔ host/scene-media-probe`（`routes.ts:12` / `scene-media-probe.ts:5`），client 侧 **0 环** |

`shared/` 纯度：仅 import `./types` / `./pointer-shim`，**不碰 host/client、不 import `node:*`**
（`web-audio-shim.ts:8` → `pointer-shim.ts`），合规；但 `shared/` 里有 2 个**可执行字符串**
（`pointer-shim.ts:19`、`web-audio-shim.ts:16` 各 ~70 行用模板字符串写的 JS），它们是**被注入到用户
壁纸 iframe 的运行时**，只被 host 侧引用（`routes.ts:7`）—— 属「shared 里放 host 专用资源」的轻微
职责错位，且这两段字符串同样没有语法校验（与 P1-6 同病）。

---

## 文档漂移抽查结果

### A. `AGENT.md` 的 `file:line` 锚点：**16 个里 9 个已失效**（56%）

命令：正则抽取 `` `file.ts:NNN` `` 全部 16 处，逐条读目标行。

| 锚点 | 文档出处 | 声称内容 | 目标行实际内容 | 结论 |
|---|---|---|---|---|
| `three-renderer.ts:1073-1080` | §2.1、§5.46（**两处**） | 帧快照消费者门控 `allowFrameSnapshot` | `currentTimeline?.advance(dt);` | ❌ 漂移（`registerFrameConsumer` 现 `:1185`，`allowFrameSnapshot` 现 `:1395-1397`） |
| `threejs-player.ts:1903-1905` | §5.3 | 对象 `angles` 应用点 | `arr[i + 1] = entry.baseUv[i + 1] * ry + oy;`（精灵表 UV） | ❌ 漂移 |
| `threejs-player.ts:1398-1404` | §5.22 | 段渲染 `frameRT` 清屏 | `}` | ❌ 漂移 |
| `tex-loader.ts:240-254` | §5.19 | `.tex` flags 消费（ClampUVs） | `const v = intCoords ? readI32...; return v;`（`parseSpriteSection`） | ❌ 漂移 |
| `tex-loader.ts:269-272` | §5.17 | sprite 刻意不裁 padding | mip 选择注释 | ❌ 漂移 |
| `styles.ts:3` | §5.48 | 背景层 `pointer-events:none` | CSS 注释（规则现 `:31`） | ❌ 漂移 |
| `effect-runner.ts:674-689` | §7.42⑫ | `g_PointerPosition` 写入 | `if (compileFailed) {`（`getMaterial` 编译失败分支） | ❌ 漂移 |
| `parallax.ts:86-103` | §7.42⑫ | `g_ParallaxPosition` 公式 | `parallax.ts` 全文仅 **94 行** | ❌ 范围越界 |
| `tests/object-effects.test.ts:106` | §7.11 | `[全库分类]` 行 | 命中 | ✅ |
| `mod.rs:168-175` | §5.5 | `instanceoverride` rate 乘数 | `/// emitter.rate 乘数` | ✅ |
| `mesh-shaders.ts:26-32` | §5.17 | `g_Texture0Resolution` 语义 | 命中 | ✅ |
| `text-object.ts:312-320` | §7.42⑩ | brightness 实现 | 命中 | ✅ |
| `text-object.ts:130-139` | §7.42⑩ | limitwidth 阈值 | 命中 | ✅ |
| `scene-json.ts:434-439` | §7.42⑫ | `cameraparallax` 解析 | 命中（`horizontalAlign` 邻域，同函数内） | ✅ 近似 |
| `user-bindings.ts:350-357` | §7.42⑫ | `out.parallax` 写入 | `out.parallax = {` | ✅ |

**为什么是问题**：§5 的条目靠锚点定位「应用点」，锚点失效后读者会照着错行改（
`three-renderer.ts:1073` 恰好落在 `currentTimeline?.advance(dt)`，很容易被误改成时间线代码）。
`AGENT.md` §6 已明确要求「代码里只留一句 + §x 指针」，但**反向的坑没防**：§5 大量引用行号，
而这些文件正是 3,414 / 1,598 行的高频改动文件。

**建议（S/M）**：① §5 的 `file:line` 一律改成**符号名**（``"`three-renderer.ts` 的
`registerFrameConsumer`"``），永不再钉行号；② 新增 `scripts/check-doc-anchors.mjs`（S）：抽取
AGENT.md 的 `` `path:line` ``，断言行号在范围内且行内容包含文档里的反引号标识符 —— 可接进
`verify:local`，允许人工 `--update` 重钉。

### B. `AGENT.md` 事实性断言抽查（§1 / §2 / §4 / §5）

| 断言 | 出处 | 代码现状 | 结论 |
|---|---|---|---|
| 「Node 版本**无 `engines` 声明**，CI 用 Node 22」 | §1 `:14` | `package.json:12-15` 有 `engines: { node: ">=20", dsh: ">=0.2.0-rc.1 <0.3.0" }` | ❌ **错**（且 `check-release.mjs` 的 ④ 强依赖 `engines.dsh`，自相矛盾） |
| `wasm-renderer / scene-renderer / scene-script / glsl-to-naga` 已删 | §2.1 `:31` | 4 个文件均不存在 | ✅ |
| scene 渲染路径 = `index → createThreeSceneRenderer → loadSceneToThree → setAnimationLoop` | §2.1 `:21` | 命中（`index.ts:91`、`three-renderer.ts:258`、`threejs-player.ts:3139`） | ✅ |
| 「`particles.ts` 的旧 JS 实现只服务单测」 | §5.7 | 命中（生产仅 `import type`，实现只被测试调用） | ✅ |
| 「`NoInterpolation`（bit0）→ NearestFilter，`applySampling`」 | §5.19 | 命中（`tex-loader.ts:509-519`） | ✅ |
| §4 目录树 `scripts/` = 6 项 | §4 `:115` | 实际 8 个 `.mjs` + 2 个 `.json`；**漏** `verify-arch.mjs`、`check-release.mjs`、`gen-wasm-manifest.mjs`、`lib/quickjs-wasm-path.mjs` | ❌ 不完整 |
| §2.2 模块清单 | §2.2 `:35-38` | **16 个文件未登记**：client 13 个（`diagnostics` `env-check` `fetch-util` `luma` `mdl-parser` `mesh-material` `pointer-input` `scene-instance` `script-patterns` `setup-tip` `text-color` `util-material` `version` `wasm-loader` — 其中 `mdl-parser` 只在测试文件名里出现过）+ host `mp4-audio-probe` + shared `media.ts` `user-refs.ts` | ❌ 不完整（约 900 行未登记） |
| §2.2「`src/shared/`：跨端类型与常量/纯函数」 | §2.2 `:37` | 另含 2 个「注入到壁纸 iframe 的运行时字符串」（`web-audio-shim.ts` 62 行、`pointer-shim.ts` 97 行），性质是 host 专用资源 | ⚠️ 描述偏窄 |

### C. `docs/technical-notes.md`（175 行）过期点

| 位置 | 文档说法 | 代码现状 | 结论 |
|---|---|---|---|
| `:31` | 「`build_instance_vertices()` 输出每粒子 `[pos3, size, uv2, color3, alpha]`（**10 浮点**）」 | `sim.rs:1268` `with_capacity(len * 16)`、`threejs-player.ts:155 PARTICLE_FLOATS_PER_INSTANCE = 16`（`pos3,size,uv2,color3,alpha,rot3,vel3`） | ❌ 数字错（10 → 16），且漏了自旋/速度 6 分量 |
| `:14` | 「实例属性 `particlePosition/Size/Uv/Color/Alpha` 按 maxcount **一次性预分配**」 | `threejs-player.ts:2827 writeParticleData` 有**容量不足时扩容**分支（并同步 `_maxInstanceCount`）；属性名现为重排后的 7 个 | ⚠️ 语义过期 |
| `:58` | 「`NoInterpolation = 1`（bit0）—— **待办**：`applyLinearSampling` 无条件设 `LinearFilter`」 | 函数名已是 `applySampling`（`tex-loader.ts:509`），且**已消费**该 flag（`:510-512` Nearest）；`AGENT.md` §5.19/§5.53 也记「已修」 | ❌ 与 `AGENT.md` + 代码**三方矛盾** |
| `:46` | 「`ClampUVs` … 全库 477 张 `.tex` 中 105 张因此由 clamp 改 repeat」 | 数字属会漂的本机快照 —— 违反 `AGENT.md` 开头「不要在文档里钉会漂的数字」 | ⚠️ 口径违规（应改为「怎么测」） |

### D. `README.md` 架构章节（`:343-374`）

- 目录树列 **22 个** client 模块（`:356-366`），实际 **71 个**（`ls src/client/*.ts*` 去掉 `lz4js.d.ts`），漏掉整族：
  `boot-*`（3）、`media-*`（4）、`text-*` + `scene-script-*` + `scene-anim` + `scene-timeline` +
  `layer-state` + `dynamic-mesh`（8）、`glow-stage` / `bloom-stage` / `frame-capture` / `composite-quad` /
  `rt-render`（5）、`puppet` / `mdl-parser`（2）、`parallax` / `pointer-input` / `pointer-post`（3）、
  `render-health` / `video-health` / `diagnostics` / `env-check`（4）、`object-range` / `effect-graph` 等。
- `scripts/` 一行只写 2 个（`build-client.mjs`、`check-known-failures.mjs`），实际 8 个。
- 降级链图（`:378-395`）与 `scene-fallback.ts` / `wallpaper-controller.ts` 现状一致 ✅。

### E. 与 `overview.md` 不重复的说明

本文**不重复** `overview.md` 已记录的项：`schemastery` 版本范围、缺 `packageManager`、
sourcemap 体积/含第三方源码、README 配置表漏 4 字段、`release.yml` npm CLI 版本、cargo 未进 CI。
其中「cargo 未进 CI」与本文 P1-5 相关（Rust 重构前需先补），但归 `overview.md` 追踪。

---

## 附：本次审查用到的只读命令（可复现）

```powershell
# 行数（真实行数，空行也计）
Get-ChildItem -Recurse src,wasm/src,scripts -File -Include *.ts,*.tsx,*.rs,*.mjs |
  ForEach-Object { [PSCustomObject]@{ N=@(Get-Content -LiteralPath $_.FullName).Count; F=$_.FullName } } |
  Sort-Object N -Descending | Select-Object -First 20

# any / ts-ignore / ts-expect-error（按文件出现次数排序；区分「行」与「处」）
Get-ChildItem -Recurse src -File -Include *.ts,*.tsx |
  ForEach-Object { $t = Get-Content -Raw -LiteralPath $_.FullName
    [PSCustomObject]@{ F=$_.Name; any=([regex]::Matches($t,'\bany\b')).Count
                       asAny=([regex]::Matches($t,'\bas\s+any\b')).Count
                       ignore=([regex]::Matches($t,'@ts-ignore|@ts-expect-error')).Count } } |
  Sort-Object any -Descending | Select-Object -First 10

# 依赖图 + 环：正则抽相对说明符 → 去 .js → 邻接表 → 从每个节点 BFS 找回到起点的简单路径
#   实测唯一环：src/host/routes -> src/host/scene-media-probe -> src/host/routes
#   （脚本内联在本次会话中执行，未落盘；核心 20 行：foreach 文件 → Matches("from\s+'(\.{1,2}/[^']+)'")
#     → 解析 ../ → 键去扩展名 → BFS 记录 path，命中起点即环）

# 模块级可变状态
Get-ChildItem -Recurse src -File -Include *.ts,*.tsx |
  ForEach-Object { Select-String -LiteralPath $_.FullName -Pattern '^(export\s+)?(let|var)\s+|=\s*new\s+(Map|Set|WeakMap)' }

# 死代码：先抽 `^export (function|const|class|interface|type)` 的名字，再数「其它 src 文件」引用为 0 的，
# 最后到 tests/ + e2e/ 里复核（= 仅测试引用）或彻底 0（= 真死代码）

# 文档锚点
Select-String -Path AGENT.md -Pattern '`([\w./-]+\.(?:ts|tsx|rs|mjs|json)):(\d+)' -AllMatches
```
