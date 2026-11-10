# 项目全面审查：汇总（2026-11-10）

> 审查方法：`code-review-skill` 分级（🔴 P0 阻塞 / 🟡 P1 应修 / 🟢 P2 建议）+ `dispatching-parallel-agents` 按领域并行。
> 基准 HEAD `d5ff886`（1.0 P0 收口后）。**6 个领域报告 + Lead 高层自审**，逐条给 `path:line` 证据；Lead 已对全部 P0 做代码级交叉验证。
> 各领域明细报告已清理（只保留本总表）；原 8 篇见 git 历史 `docs/audit-2026-11-10/`。各领域全文：`host.md`（待补）· client-runtime.md · rendering-correctness.md · rust-wasm.md · testing-gates.md · architecture.md（待补）· overview.md（Lead 高层/自审）

## 0. 结论摘要

**共 14 个 P0（3 个安全 + 8 个运行时/门禁 + 3 个结构性，全部经 Lead 代码级复核或证据抽查成立）**，另有 P1 约 45 条、P2 约 70 条。

一句话：**功能与发布流程已经成熟，但有三个层面的系统性问题——① 安全：web 壁纸沙箱可被绕过（读任意本地视频 / 逃逸到 GUI origin）、`.tex` LZ4 炸弹可让渲染进程 OOM；② 健壮性：第三方素材可触发 wasm 层 DoS（死循环/OOM/panic），渲染器在竞态与纹理所有权上不闭环；③ 质量门禁只判「红」不判「消失」，删测试/放宽基线可以全绿通过。** 另有 3 条结构性 P0（God class、面板隐式总线、跨端路由契约无门禁），属长期维护风险，不阻塞发布。

对 1.0 发布的判定：
- **建议 1.0 前修**：Rust 3 个 P0 的**解析层加固**（非有限值 clamp + `rem_euclid` + `Result` 化，改动小、风险低）+ 渲染 P0-1/P0-2（竞态守卫 + 纹理释放）。不修则「第三方素材锁死页面」「连点壁纸卡住」「轮播久后 context-lost」三类真实用户故障仍可能发生。
- **可放 1.0.1**：测试门禁 3 个 P0（开发流程风险，不直接影响用户）。

> ⚠️ 全部结论来自**只读静态审查**，未构造恶意素材或复现运行时故障；P0 的触发条件均已给出可构造路径，建议修复时先用单测钉住。

## 1. P0 清单（按「用户可感知 × 触发概率」排序）

### 1.0 安全 P0（最高优先级，`host.md` P0-1/2/3）

| # | 问题 | 证据 | 触发条件 | 影响 | 1.0 |
|---|---|---|---|---|---|
| S1 | **不可信 web 壁纸可读取任意本地视频文件** | `background-layer.ts:46-51/96`（iframe 用另一回环主机名承载 + `allow-same-origin`）；`routes.ts:237-258` 的 `isLoopbackRequest` 只判「是否回环」，**不区分 GUI 与同源 iframe** | 任意 web 壁纸脚本 `fetch('/wallpapers/boot/local-video?path=' + encodeURIComponent('C:\\任意\\a.mp4'))`：iframe 的 `remoteAddress=127.0.0.1`、`Host=localhost:<port>`，两道闸门全过 | 恶意 web 壁纸把用户磁盘**任意目录的任意视频**读成字节并外传；`/boot/probe` 还提供路径存在性/大小 oracle。直接推翻 `SECURITY.md:54`「不提供任意文件读取」 | **必须** |
| S2 | **web 壁纸 iframe 可自我导航回 GUI origin，取得 `parent.document` / `localStorage`** | `background-layer.ts:92-97`（`sandbox='allow-scripts allow-same-origin'`）、`routes.ts:630-671`（同一服务双回环主机名） | 壁纸脚本 `location.href='http://127.0.0.1:<port>/wallpapers/web/<id>/index.html'`（GUI 在 localhost 时反向）→ 新文档 origin 变成 GUI origin，sandbox 的 `allow-same-origin` 仍在 | 恶意 web 壁纸从「跨源不可信页」升级为「与 GUI 同源的脚本」：可读聊天 DOM/设置/localStorage、代用户调宿主 API 并外传。**待浏览器实测确认**（若被 CSP `frame-src` 拦住则降 P1） | **必须** |
| S3 | **恶意 `.tex` 的 LZ4 解压炸弹 → 渲染进程 OOM** | `tex-loader.ts:151-198`（imageCount ≤64、mipmapCount ≤256）、`:190-192`（`decompressedBytes ≤ 1<<30` **每条独立**）、`:263-266`（空载荷仍保留 1GB buffer）；`lz4js` 对空 `src` 返回 0 不抛错 | 恶意 `scene.pkg` 放一个约 328KB 的 `TEXB0002`：64 image × 256 mip，每条声明 1GB 输出、`bytesLen=0` | 第三方不可信素材可让 GUI 渲染进程 OOM/崩溃（前几条就触发） | **必须** |


### 1.1 运行时 / 门禁 P0（P0-1…P0-8）

| # | 领域 | 问题 | 证据 | 触发条件 | 影响 | 1.0 |
|---|---|---|---|---|---|---|
| P0-1 | Rust | **角度归一化 `while` 死循环** | `wasm/src/particle/sim.rs:444-449` | 粒子 spec 的 `rotationrandom`/`angularvelocityrandom` 含 `inf`/`1e39`，或 `angularmovement.drag` 大负值使角速度指数放大 | `rot = inf` 时 `while (rot > π) rot -= 2π` 永不终止；wasm 循环无法被 JS/AbortController 打断 ⇒ **整页卡死**；`prewarm` 在构造期执行，壁纸一加载就发生 | **阻塞** |
| P0-2 | Rust | **`maxcount` 无上限 → 构造期 OOM** | `wasm/src/particle/mod.rs:450`（`as u32` 饱和到 `u32::MAX`）、`sim.rs:875-892`（`clamp(1, maxcount)` + 无界 `spawn`） | 粒子 spec 的 `maxcount: 1e9`（或 `1e39`/`Infinity`） | 主线程连续 push 数亿 `SimParticle` ⇒ 标签页冻结/OOM；JS 侧 `MAX_PARTICLE_CAPACITY=2048` 被 `aliveAtCreate` 绕过，注释引用的 rust clamp 已随旧文件删除 | **阻塞** |
| P0-3 | 渲染 | **重叠 `select()`/`render()` 覆盖单例 `current`** | `src/client/three-renderer.ts:574/1104`；`wallpaper-controller.ts:158-230` 的 `selectGeneration` 只保护上屏 | 快速连点壁纸、轮播与手动选择交叉 | 后完成的装配覆盖 `current`，先完成的 player 无人释放（RAF 永续 + GL 不回收）；暂停/画质/光晕/声音作用到不可见 player；显示可能冻结在旧画布 | **阻塞** |
| P0-4 | 渲染 | **纹理/材质所有权不闭环 → VRAM 泄漏** | `threejs-player.ts` `dispose()` 注释「texture 所有权在外，不在此 dispose」；`three-renderer.ts:650` 的 `currentTextures` 只收 `backgroundTextures` | 每次切壁纸 | 粒子贴图（含折射法线）、text 画布纹理、pixel-bars 条纹理、动态网格纹理全部不释放 ⇒ 每切一张泄漏数 MB～数十 MB；轮播久了触发 `webglcontextlost` | **阻塞** |
| P0-5 | Rust | **不可信 JSON `expect` panic（契约自相矛盾）** | `wasm/src/particle/mod.rs:390`；`lib.rs:41-47` 声明 `Result` 但解析无 `Result` 通道 | 损坏/截断/超 128 层嵌套的粒子 JSON | wasm trap（`unreachable`）→ `try/catch` 兜底成零粒子：**粒子层静默消失**，无 panic 位置；每次失败泄漏一块 wasm 内存 | 应修 |
| P0-6 | 测试门禁 | **门禁只判「红」不判「测试消失」** | `scripts/check-known-failures.mjs:31-50`（只收集 `failed`，`numTotalTests` 仅打印） | 删除测试文件 / 清空 `testResults` / 把 `expect` 删剩 `expect(true)` | 三道门禁全绿：连 `settings-section.dom.test.tsx`（58 个 DOM 契约的唯一权威）整文件删掉都不会红 | 1.0.1 |
| P0-7 | 测试门禁 | **类型棘轮 `--update` 无守卫** | `scripts/check-known-type-errors.mjs:95-107`（无条件写基线 + exit 0）；CI 不 diff 基线文件 | 同一 PR 提交「引入回归 + `--update` 放宽基线」 | 495 条类型债可继续增长而门禁全绿；PR diff 里基线 JSON 增长易被忽略 | 1.0.1 |
| P0-8 | 测试门禁 | **`verify:local` 可能复用陈旧 vitest 报告** | `scripts/verify-local.mjs:66-71`（运行前不删 `.vitest-report.json`，跑完才删） | 上次运行被 Ctrl-C/超时打断留下报告 + 本次 vitest 崩溃 | 本地验收 PASS 而 CI 红（「本地绿 ≠ CI 绿」的典型） | 1.0.1 |

### 结构性 P0（长期维护风险，**不阻塞 1.0 发布**）

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| P0-9 | **`threejs-player.ts` 3414 行 God class**：`ThreeScenePlayer` 2,265 行 / 70 方法 / 8 职责，覆盖 scene 渲染唯一路径 | `threejs-player.ts:704-2968`；`AGENT.md` §5 的 20+ 条硬约束全在这一个类的不同方法里交叉 | 任何渲染改动都落进同一文件；`§5` 的 file:line 锚点不稳定；review 无法按职责切分。建议按「粒子/背景/隔离/spec 纯函数」拆 4 个模块（L，分 4 个 PR） |
| P0-10 | **`settings-section.tsx` 1499 行 + 10 个模块级可变槽构成隐式事件总线** | `settings-section.tsx:312-1499`（1,188 行单函数）；`:66-197` 的 12 个注册导出 + 8 个 `let handler = null` + 2 个 `new Set()` | HMR 重挂载时旧模块实例的槽全丢；任何一处漏挂/漏清 = 「面板按钮点了没反应」，且无编译期/门禁信号。建议把注册槽搬到 `panel-bridge.ts`（M） |
| P0-11 | **host 路由契约在 client 散落 35 处 / 14 模块，无任何门禁** | host 13 条路由单点注册（`routes.ts:318`），client 35 处字面量（`scene-assets.ts` 8、`three-renderer.ts` 7…）；`src/shared/` 无路由常量；`verify-arch` 不查跨端字符串契约 | 改一条路由名：`tsc` 绿、`verify:arch` 绿、单测绿（mock fetch），**只在真机/e2e 炸**。建议加 `src/shared/routes.ts` 构造器 + verify-arch 规则（S–M） |


## 2. P1 摘要（完整见各领域报告）

**渲染正确性**：① `applyLayerState` 对粒子写绝对 position ⇒ 双重平移、text 丢 `anchorOffset`（`layer-state.ts:137`）；② 畸形 `scene.json`（NaN 相机/0 scale）静默黑屏但 `render()` 返回 true、健康状态 ok、不触发降级；③ 缺纹理渲染成不透明白色 quad 且零日志；④ dpr 变化走 render 内 self-resize，绕过 `stage.onViewportResize` ⇒ 隔离 RT 停旧密度（整层糊）；⑤ 窗口每拖动一次 resize 都全量重挂链（`setPlan` 清纹理缓存 → no-store 重下载 + 重编译）。

**客户端运行时**：① web iframe resize 重建只 `attachPointerPost` 不 `detachPointerPost` ⇒ 每次重建永久残留一个 window `pointermove` 监听 + 旧 iframe 闭包（`background-layer.ts:212-226/396/439`）；② `localStorage` 直取未兜错（`settings.ts:115-116` 的 `getItem` 在 try 外、`wallpaper-properties.ts:37/48`）⇒ 隐私模式/禁用存储下面板崩溃或装配误判硬失败；③ 系统音频授权等待期无代号 ⇒ 授权中点停止后采集残留。

**Rust/wasm**：① `randomframe` 帧号硬编码 4、忽略实际精灵表帧数；② `maxcount` 缺失/为 0 时永不发射（注释承诺的 estimate 回退不存在）；③ `prewarm` 用 `dt=age` 单步跑算子，`oscillateposition` 产生永久位置偏移。

**测试质量**：① 全库唯一真实 WebGL 证据 = 1 个 e2e 脚本 / 1 个 fixture / 1 个 blend mode（2,196 项单测全在 mock/jsdom 下）；② puppet 防回退锚点（`boneInverses=MDLS 链`）在 CI 与 release 整块 `skipIf`；③ e2e 无「已知失败棘轮」⇒ hidpi/isolated-rt 长期红、事实上不构成门禁；④ `41d2fe1` 把 puppet RT 断言从 `toBe` 弱化为 `toBeGreaterThanOrEqual`，夹具里 `budgetScale=1` ⇒ **回退该修复仍绿**；⑤ 开机动画零 e2e，只有 jsdom；⑥ 门禁脚本自身 1/5 有测试（`check-release` 刚被改松过且无测试）。

**主机侧**：① **未配置 `wallpaperDir` 时 `/wallpapers/web` 以进程 cwd 为根**（`join('','.git')` 前缀校验仍通过）⇒ 可读 `.git/config`、`Desktop/` 等；② `/media/<id>/preview` 无 `isFile`/try ⇒ 目录条目触发 `EISDIR`；③ **`PkgReader` 全局缓存 32 个整包**（100–150MB/包 ⇒ RSS 可达 3–5GB），无字节预算/删除失效；④ `project.json`/`scene.json` 无大小上限、宿主同步整块 `readFileSync` ⇒ 恶意 1GB 文件 OOM；⑤ 无来源校验 + 昂贵同步路由（`/probe` 同步 `reg`、`/list?refresh=1` 全量扫描、`/now-playing` 懒启动 PowerShell）可被**任意网页 CSRF 触发**（无需读响应）。

**架构**：① `three-renderer.ts` 1598 行、直接依赖 39 个模块（全仓耦合中心）；② `index.ts` 的 `bootstrap` 437 行闭包手写 20+ 个捕获变量生命周期；③ host 唯一 import 环 `routes ↔ scene-media-probe`，`routes.ts` 36 处 `any`（占全仓 51%）；④ 设置契约三份副本（`ClientSettings`/`DEFAULTS`/`WallpaperSettingsSchema`），漏改 schema 静默丢设置；⑤ `sim.rs` 1905 行（含 602 行内联测试）；⑥ `scene-script-vm` 268 行字符串 prelude 承担脚本 ABI；⑦ 横切小件各自实现（warn-once×3、白纹理×3、PRNG×2、日志前缀×4、dispose×38）；⑧ `verify-arch` 不查环、不查跨端契约、只扫 `src/`。

## 3. P2 摘要（完整见各领域报告）

- **包/依赖**：sourcemap 含全部依赖源码（4.1MB = unpacked 51.4%）；`lib/client` 150 文件 / 1.29MB 是死发布内容；`schemastery` 范围与宿主不一致；无 `packageManager`；README 配置表漏 4 字段。
- **渲染**：mdl 的 NaN 蒙皮权重可过「权重和≈1」校验导致整只 puppet NaN 消失；每帧 `Vector4`/`Matrix4`/`flat()` 分配；`effect-runner` 异常分支不进失败缓存导致每帧 warn；`relaxGlsl3Strictness` 在 `main()` 花括号换行时插错位置（待真实素材确认）。
- **客户端**：3 处注释与实现矛盾；`setup-tip`/`wallpaper-properties` 的 localStorage 直取。
- **测试**：7 个 e2e 脚本依赖本机素材（`ci.yml` 注释只列了 3 个）；`verify-local` 的 `git reset -q` 会清用户暂存（`verify-local.mjs:38-44`）；`check-release` 失败只复原 `dist/` 留脏 `lib/`；`verify-arch` 只拦 `node:*` 不拦裸内置模块；106 条 CSS 正则断言脆弱；一条轴序判据是同义反复（`tests/threejs-player.test.ts:4019`，不经过生产代码）。
- **Rust**：解析层不做有限性校验（NaN/Inf 直接进模拟）；`update(dt)` 不校验 `dt`（负 dt 让粒子不死、NaN dt 永久污染）；每帧 2 次堆分配（10000 粒子 ≈ 38MB/s 垃圾）；`instanceoverride.color` 非法值变纯黑覆盖；`controlpoint.id` 的 `u64 as usize` 在 wasm32 截断；算子数无上限；无 `console_error_panic_hook`（panic 只剩 `unreachable`）；`WASM_BUILD.json` 缺 `wasm-bindgen` 版本；wasm 初始化失败完全静默；测试用全局 RNG 可偶发失败；`particle_count()` 文档写 10 浮点/粒子实际 16。

## 4. 已核对「不是问题」的项（避免下一轮重复审）

- 设置字段 host/client 33/33 一致；旧适配层删除彻底；产物与 src 同步；`npm audit` 0 漏洞。
- HMR 幂等与收尾（AGENT §5.43）核对通过；§5.48 指针 shim、§5.52 音频暂停基本一致。
- Glow RT 尺寸、y 镜像 + `flipGeometryUvY`、UV 窗口恒等、`readPixels` 同步读取 —— 渲染审查逐项核对**不是缺陷**。
- 安全校验（路径穿越/UNC/Host 头/NUL）的现有单测覆盖较强（5 种 UNC 变体、DNS-rebinding Host、`%2e%2e%2f`、`C:/` 绝对路径）—— 主机侧领域报告待补，但测试覆盖矩阵已确认这部分有直接用例。

## 4.5 主机侧安全（Lead 抽查 + host 详细报告）

> ⚠️ **更正**：Lead 先前抽查（路径穿越 / UNC / 回环 / PKGV 边界 / 子进程注入）得出的「未发现新增 P0」**只覆盖了字面量校验面**，漏掉了「同源 iframe / 跨站 `<video>` / 沙箱逃逸」三个面。host 详细报告发现 **3 个安全 P0（S1–S3）**，已升为全项目最高优先级（见 §1.0）。

**已核对无问题的正面项**（host 报告「已检查无问题」清单摘要）：

| 面 | 结论 |
|---|---|
| PKGV 解析边界 | nameLen 上下界、entryEnd 截断、负 offset、条目数上限、全局越界二次校验，全部显式 throw |
| TEXV 宿主探测 / MP4 moov 审计 | `entry.length` 预检 + box 边界校验，无 OOB/无限循环 |
| `..`/绝对路径/UNC（字面量） | `isSafeToken`/`isSafeAssetName`/`resolve` 前缀/scene-source/boot 白名单齐全 |
| URL 规范化 | `new URL` 折叠 dot-segment；`%2e2e%2f`、`%2F`、NUL、超长路径均被拒 |
| Range 单区间 | 各种边界（含负值/超 MAX_SAFE_INTEGER）有明确结果，416 带 `Content-Range` |
| 固定响应长度/错误体 | `Content-Length` 按实际 Buffer；错误响应不泄露路径/堆栈 |
| 子进程 / JSON 行协议 | PowerShell 脚本与 args 全常量；畸形行只计数不污染状态 |
| 媒体隐私 | 日志不含 title/artist/album；唯一路径泄露在 `index.ts:70` 数据目录错误日志（host P2-10） |
| XSS/反射 | 无 `innerHTML`；错误体不反射输入；shim 注入只拼接常量并转义 `</script` |

**仍待确认**：Cordis `webServer` 是否包裹同步 handler 异常（决定 host P1-2 是「500」还是「未捕获异常」）；S2 是否被浏览器 CSP `frame-src` 拦住。

## 5. 修复路线建议

| 批次 | 内容 | 成本 | 理由 |
|---|---|---|---|
| **1.0 前（安全，最高优先）** | S1 web 壁纸读任意本地视频（boot 路由加 GUI 专属凭据或独立 origin）、S2 sandbox 逃逸（壁纸内容独立端口/origin）、S3 LZ4 炸弹（按 `mw*mh*format` 精确校验 + 单纹理总预算 + host entry 上限） | M | 三条都是「第三方素材 → 用户本机」的攻击面；`SECURITY.md` 的承诺与实现不符。S3 与运行时 P0-2（maxcount）同属「素材声明值不可信」，可一批做 |
| **1.0 前（建议）** | Rust 解析层加固：`rem_euclid` 替换 while、`MAX_PARTICLES` 双重 clamp、`parse_particle_spec → Result` + 非有限值校验（P0-1/2/5） | S–M | 改动集中在 `particle/mod.rs` 与 `sim.rs` 的入口，不动渲染语义；可先用单测钉住非法素材 |
| **1.0 前（建议）** | 渲染：`render()` 加代际守卫（`renderGeneration` + 装配出口检查）、teardown 收编全部纹理所有权（P0-3/4） | M | 连点壁纸与轮播是日常操作，这两条直接决定用户是否遇到卡死/泄漏 |
| **1.0.1** | 测试门禁：测试数下限断言、`--update` 的 CI diff 守卫、`verify:local` 先删旧报告（P0-6/7/8） | S | 开发流程风险，改门禁脚本本身不碰产品代码 |
| **1.0.x** | P1 清单按领域排期（渲染 origin 双重平移、dpr 绕过、缺纹理白块；客户端 localStorage 兜错、iframe 监听；Rust randomframe/estimate 回退/prewarm 积分） | M | 各有明确用户可见后果，但触发条件较窄 |
| **1.x** | P2：包体治理（map/lib/client）、依赖对齐、每帧分配优化、panic hook、e2e 素材 fixture 化 | M–L | 长期质量投资 |
| **1.x** | 结构性重构（P0-9/10/11）：`threejs-player` 按职责拆 4 模块、面板注册槽搬 `panel-bridge.ts`、新增 `shared/routes.ts` + verify-arch 跨端契约规则 | L（可拆 6+ PR） | 不阻塞发布，但越晚成本越高；P0-11 建议优先（S–M，防「改路由名只在真机炸」） |

## 6. 报告索引

| 文件 | 领域 | 规模 |
|---|---|---|
| overview.md | Lead 高层 + 1.0 自审 | P1×1、P2×5、✅×5 |
| `host.md` | 主机侧正确性与安全 | host.md：**P0×3（安全）、P1×5、P2×18**（同源 iframe 读本地视频 / sandbox 逃逸 / LZ4 炸弹；逐路由来源校验矩阵 + 文档一致性核查） |
| client-runtime.md | 客户端运行时 | P0×1、P1×3、P2×17 |
| rendering-correctness.md | 渲染正确性 | P0×2、P1×5、P2×10、静默吞错 12 |
| rust-wasm.md | Rust / wasm | P0×3、P1×3、P2×11 |
| testing-gates.md | 测试质量与门禁 | P0×3、P1×10、P2×8 |
| `architecture.md` | 架构可维护性 | architecture.md：**P0×3、P1×9、P2×10**（God class / 面板隐式总线 / 跨端路由契约；含文档漂移抽查） |
