# 测试质量与门禁审查

> 基准 HEAD `d5ff886`（v0.13.1 + 8 提交）。只读审查，未运行任何测试。
> 规模：`tests/**` 107 个测试文件 / 约 2,169 个 `it`（node + jsdom 双环境）；`e2e/**` 12 个 verify 脚本 / 4 个 harness；门禁脚本 5 个。
> **不重复** AGENT §3.3（验证手段清单）、§7.11（基线口径）、§7.12（e2e 与真 GPU 边界）已记录内容；下列每条都是这三节之外的新发现，或在已记录口径上「规模/后果」与宣称不符的部分。

## P0（测试假绿导致真实回归放行 / 门禁可绕过）

### P0-1 三道门禁都只判「红」，不判「测试消失」——删测试/删断言在 CI 上是隐形操作

- 证据：`scripts/check-known-failures.mjs:30-53` 只遍历 `assertionResults[].status === 'failed'`；`numTotalTests` 在 `:48-50` 被读出来**只用于打印**，从不做下限断言；`:71-77` 在「无新增失败 + 无套件级错误」时无条件打印 `无新增失败 ✅` 并 exit 0。
- 证据：`tests/check-known-failures.test.ts:38-96` 固定了 5 种报告形状（全绿 / 新增失败 / 收集期失败 / 套件级错误 / unhandledErrors），**没有一种覆盖 `testResults: []` 或零用例报告**。
- 为什么危险：把 `tests/dom/settings-section.dom.test.tsx`（AGENT §5.39 声称是 58 个 `.wss-*` 契约的**唯一权威**）整文件删除，或把某个 `it` 内的 `expect` 删到只剩 `expect(true).toBe(true)`，三道门禁**全部保持绿**：vitest 报告里没有 failed 断言 ⇒ 基线检查绿；`tsc` 没东西可报 ⇒ 类型棘轮绿；e2e 与本改动无关。同理，`vitest.config.ts:6` 的 `include` 一旦写错（如 `tests/**/*.spec.ts`），整库 2169 项消失后仍是绿（只要报告文件被写出）。这是当前唯一能「合法」抹掉回归证据的通道，且不需要 `--update`。
- 建议：① 基线检查加下限：测试文件数 ≥ `git ls-files 'tests/**/*.test.ts*'` 的条数（或维护一个 `minTests` 字段），缺文件/`testResults` 为空判红；② vitest 步骤不要 `continue-on-error` 后完全丢弃退出码——至少在报告缺失或件数与 git 不符时红。

### P0-2 类型棘轮的放宽通道无技术阻力：同一 PR 可同时提交回归与放宽后的基线

- 证据：`scripts/check-known-type-errors.mjs:95-107` —— `--update` 分支无条件 `writeFileSync` 基线并 `exit 0`，除此之外**没有任何**「基线文件不得变大」的守卫。
- 证据：`.github/workflows/ci.yml` 全 159 行中没有任何一步 diff `scripts/known-type-errors.json` / `scripts/known-failures.json`；`node scripts/check-known-type-errors.mjs --update` 也没挂 npm script（只能手敲），但这不是屏障。
- 为什么危险：§7.11 把它写成「确认要放宽才 `--update`」，保护依赖人自律。实际路径是：改代码引入 20 个新 TS2339 → 跑 `--update`（`scripts/check-known-type-errors.mjs:103-105` 只打印 `+20  tests/xxx.ts` 一行）→ 与代码一起提交 → CI 三道门禁全绿、PR diff 里基线那 20 个键淹没在 JSON 里。`known-failures.json` 同理：没有 `--update`，但手写一条 `{file,name}` 与跑 update 等价。
- 建议：CI 增加 `git diff --exit-code origin/${{ github.base_ref }} -- scripts/known-type-errors.json scripts/known-failures.json`，基线增长时红并要求 PR 显式带 label/审批（与 npm 发布的 environment 审批同思路）。

### P0-3 本地验收门禁会读上一轮的 `.vitest-report.json` —— 本地绿而 CI 红

- 证据：`scripts/verify-local.mjs:66-71`：先 `pnpm exec vitest run ... --outputFile=.vitest-report.json`（`:67`），再 `node scripts/check-known-failures.mjs .vitest-report.json`（`:68`），**运行前不删除旧报告**，`vitest` 的 `r.status` 只在 `detail` 里打印（`:70`）。
- 为什么危险：`verify-local` 是脚本头注自称的「可直接当验收命令」、AGENT §3.3 的「本地综合验收」，也是发布前人工口径。若本次 vitest 崩溃/被 Ctrl-C/被 timeout 杀掉而没有写出新报告，读到的仍是**上一轮全绿**的报告 ⇒ 门禁 2 打印 PASS。CI 每次全新 checkout 没这个路径，所以这正是「本地绿 ≠ CI 绿」的典型。
- 建议：`:67` 之前 `rmSync('.vitest-report.json')`；并用报告 `mtime`（< 本次启动时刻即判红）或 `numTotalTests` 下限二次确认。

## P1（显著覆盖盲区 / 脆弱测试）

### P1-1 全库唯一的真实 WebGL 证据是 1 个 e2e 脚本、1 个 fixture、1 个 blend mode

- 证据：`vitest.config.ts:5-7` 只有 node/jsdom 两个环境；`tests/threejs-player.test.ts:1-2` 明写「WebGLRenderer 无法在 node/jsdom（无 WebGL）环境构造，测试按契约『可 mock renderer』注入 mock」；CI 的 e2e job 只跑 `node e2e/verify/verify-colorblend.mjs`（`.github/workflows/ci.yml:147-148`），release 同样只跑这一条（`.github/workflows/release.yml:91-92`）。
- 为什么危险：2,169 项单测里没有任何一项真正编译 GLSL、真正建过 RenderTarget、真正跑过段渲染/帧捕获；这些路径的正确性只由 mock 的调用序断言保护。真实渲染的自动化窗口 = `e2e/fixtures/clouds-dxt1.png` + 800×420 + `mode=7|0`（`e2e/verify/verify-colorblend.mjs:86` 的 `--window-size=800,420`）。即 `colorBlendMode` 6/31、shader 链接失败、RT 清屏 alpha、快照时序这些 §5 里反复踩过的东西，CI 上没有任何一条像素证据。
- 建议：把 `verify-v081-gaps` / `verify-v082` 依赖的素材抽成入库 fixture（clouds 已经是这个模式），至少再上 CI 2 条：① 效果链最小链（`materials/util/*` + shader 编译失败必须红）② 段渲染 + `_rt_FullFrameBuffer` 快照的像素对照。

### P1-2 puppet 蒙皮/动画的「防回退锚点」在 CI 和 release 上整块跳过

- 证据：`tests/mdl-real-library.test.ts:12-14` 写死 `D:/Steam/steamapps/workshop/content/431960/...`，`:50`、`:65`、`:133` 三处 `describe.skipIf(!existsSync(...))`；该文件共 4 个 `it`，其中 3 个（静态族 / 影之刃零1 / leon）永远依赖本机库。
- 证据：AGENT §7.40 明确把这条防线指给该文件：「`tests/mdl-real-library.test.ts` 现在断言 `boneInverses` == MDLS 父链的逆，真实素材回归可抓住再次改错」。
- 为什么危险：那次「bind=frame0」事故（`74e4d4e`，全部骨姿势系统性偏移）的唯一自动防线，在 CI/发布门禁里**不存在**。同样的硬断言（1209/509 顶点、5 骨父子、动画 80/104、360 帧、UTF-8 名）完全可以用几 KB 的入库二进制夹具表达，却选择了本机绝对路径。
- 建议：把 `3828798871` 的 `scene.pkg` 里 `models/*_puppet.mdl` + `scene.json` 抽成 `tests/fixtures/`（仓库已有 `tests/fixtures/eva/`、`make-pkg.ts` 的先例），把 3 个 skipIf 用例搬成不依赖本机的确定性用例。

### P1-3 e2e 没有等价于 vitest 的「已知失败棘轮」——结果无法机器判定，事实上不构成门禁

- 证据：`TESTING.md:327`（§2.15「零回归口径」）与 `TESTING.md:498`（§2.15「e2e 复跑（2026-10-30 final fix wave）」）自己写着：`verify-hidpi-object-rt` 的挂载期 RT 尺寸断言**基线即 FAIL**、`verify-isolated-rt-sharpness` **3/8 未过**、`verify-turn-trigger-card` 因本机 asar 缺 CSS 无法运行。
- 证据：仓库里只有 `scripts/known-failures.json`（vitest 断言）与 `scripts/known-type-errors.json`（tsc），`e2e/` 下无任何已知失败清单或判定器（`e2e/verify/*.mjs` 一律 `process.exitCode = 1`）。
- 为什么危险：脚本以非零码退出 + 已知红 ⇒ 它既不能进 CI（会一直红），也拿不到「相对上次有没有变坏」的信息；每次只能人肉读 `[FAIL]` 行并回忆上次是否也红。`e2e:compare` 是唯一差分手段，但它要同一个 tag 对（见 P1-8）。这在效果链/RT 这类最易回归的区域等于没有回归门禁。
- 建议：照 vitest 的口径做一个 `e2e/known-failures.json`（`脚本 + 判据 id`），判定器只对新增红判红、对已修复项告警，然后把 hidpi/v081/v082 里「素材零依赖 + 只需本机 WE 库」的脚本挂到 nightly（`schedule`）而不是 PR。

### P1-4 puppet RT 清晰度修复的回退用例在同口径下不成立（测试向实现让步）

- 证据：`tests/three-renderer.test.ts:3918-3919` 原为 `expect(p.rtWidth).toBe(i.rtWidth)`，在 `41d2fe1` 中改成 `toBeGreaterThanOrEqual`，同处注释自承：「本夹具像素量远低于预算 ⇒ budgetScale=1，两者相等；但 puppet 至少不应小于 image」。
- 为什么危险：把 `41d2fe1` 的修复整体回退（puppet 重新参与预算），这条用例**仍然绿**——因为夹具里预算从未被撑爆。真正约束只剩 `:3888` 的 `worldSpy` 第 5 实参 `budgeted=false`：它只证明「标志位传对了」，不证明「分辨率真的没降」。而 AGENT §7.36② 把「puppet RT 恒按源分辨率」写成不变量，本机 e2e（`verify-isolated-rt-sharpness`，P1-3 里是已知红/不在 CI）是唯一证据。
- 建议：构造 budgetScale<1 的夹具（多放几个 image 隔离对象把 `ISOLATED_RT_BUDGET_BYTES` 撑爆，或直接传更小的预算），断言 `puppet.rtWidth === 源纹理宽` 且 `image.rtWidth < 源纹理宽`；这条断言在回退时会红。

### P1-5 tests 侧类型棘轮对最大的两个测试文件事实上是关闭的（规模未记录）

- 证据：`scripts/known-type-errors.json:22-26` 把 `tests/three-renderer.test.ts` 的 `TS2339 ×216`、`TS2345 ×101`、`TS2722 ×93`、`TS2349 ×3`、`TS7006 ×5` 全量收进基线；同文件 `:27-34` 还有 `threejs-player.test.ts` 的 9 组。
- 证据：`tests/three-renderer.test.ts` 有 456 个 `vi.fn()`、563 个 `expect`；`tests/threejs-player.test.ts` 297 KB / 5,433 行。
- 为什么危险：§3.3 只承认「`vi.fn()` / `Mock<any>` 的实参不受接口约束」这一**机制**盲区，没记**规模**：这两个文件是渲染路径的主要断言载体，而它们的类型检查事实上被基线豁免了（216 个 TS2339 = 属性访问全不校验）。可以在这里写 `mockReturnValue({ 任意字段 })`、改坏 `SceneAssets`/`PassPlan` 接口而不红。
- 建议：给 `vi.fn` 桩加类型化 helper（`vi.fn<(a: PassPlan) => void>()`）逐文件清零 TS2339/TS2722，并在基线里对每个文件设「只降不升」的上限；或对这两个文件单独开 `strict` 子项目、先允许 `any` 但要求 `noImplicitAny` 覆盖。

### P1-6 `no-unhandled` 守卫只在 `afterAll` 断言，且钩子按文件累积 —— 收尾期异常被静默记录

- 证据：`tests/setup/no-unhandled.ts:9` 只注册 `afterAll(() => guard.assertEmpty())`；`tests/setup/unhandled-guard.ts:14-17` 的 `assertEmpty` 用 `splice` **清空**队列；`:31-39` 的 `hooked` 是模块级 `WeakSet`，而 `setupFiles` 是**每个测试文件执行一次**、每文件有全新模块注册表 ⇒ 每个文件都往 `process` 上加一对 `unhandledRejection`/`uncaughtException` 监听器。
- 为什么危险：① 文件 A 的 `afterAll` 跑完之后（异步 teardown、遗留 `setTimeout`/`fetch` 回调落地）出现的 rejection 会记进 A 的 guard，但 A 的 `assertEmpty` 已经消费过队列 ⇒ **永远不会被断言**，只留在内存里；② 旧 guard 的监听器不摘除，等于每文件泄漏 2 个监听器（107 文件 / worker 复用时 `MaxListenersExceededWarning`）。
- 建议：把 guard 挂到 `globalThis` 做 worker 级单例；在 `afterEach` 也断言一次（或在 `assertEmpty` 之后再记录的项直接 `process.exitCode = 1`）；`hooked` 改用 `Symbol.for` 挂在 target 上而非模块级 WeakSet。

### P1-7 模块级「只告警一次」标志与用例执行顺序耦合

- 证据：`src/client/three-renderer.ts:84` `let subscriberWarned = false;`，`:358-359` 置位，**全文件无重置出口**；`tests/three-renderer.test.ts:3284` 断言 `subWarn` 里含「订阅者」的调用**恰好 1 条**。
- 为什么危险：这条断言的正确性依赖「本文件里没有任何更早的用例触发订阅者异常」。新增一条这样的用例（或将来开启 `sequence.shuffle`）⇒ 该断言变 0 条，表现为**假红**且原因极难定位；反过来若调换顺序，后续任何想再断言告警的用例都恒 0 ⇒ **假绿**。对比：`src/client/effect-runner.ts:97` 的 `frameSnapshotWarned` 同样是模块级 once，但它对应的用例 `tests/effect-runner.test.ts:116` 用 `vi.resetModules()` + 动态 import 取全新模块实例（正确做法）。
- 建议：把 once 状态移进实例（`createThreeSceneRenderer` 闭包内），或导出仅测试用的重置函数并在这条用例里前置调用。

### P1-8 没有任何 golden image 入库，「零回归对拍」不可复现、可被陈旧基线骗过

- 证据：`.gitignore:17` 忽略 `e2e/.out/`；`e2e/verify/compare-shots.mjs:45` 判据 = `maxAbs <= 1 && changedPx === 0`，文件名只由 `--tag-a/--tag-b/--dprs` 拼出（`:18-19`），**不绑定 commit、时间或运行号**。
- 为什么危险：AGENT §3.3 把 `e2e:compare` 当「零回归证据」的推荐手段，但两张图的来源完全靠人记。`e2e/.out/` 会跨会话留存（本机现存多次运行的 PNG 与整份 Edge profile），拿三天前的 `baseline-dpr1.png` 与今天的 `after-dpr1.png` 比也会「PASS」——它们之间可能跨了 10 个 commit。跨机/换驱动则必然假红（阈值 1 个色阶）。
- 建议：对「判据型」截图（确定性 harness + 固定视口）入库或在 CI 同一次 run 内生成 A/B；`compare-shots` 至少把两图的 `mtime` 与 `git rev-parse HEAD` 打进日志，并拒绝 baseline 超过 N 分钟。

### P1-9 开机动画（1.0 前最大的新特性）零 e2e 证据

- 证据：`e2e/**` 对 `bootAnimation` 的引用数 = **0**（harness 只有 colorblend / media / object-effects / text-clock 四个入口）；开机动画的全部自动化证据是 4 个 jsdom 文件（`tests/dom/boot-overlay.dom.test.ts`、`boot-player.test.ts`、`boot-settings-section.dom.test.tsx`、`boot-asset.test.ts`）。
- 为什么危险：jsdom 无视频解码、无合成、无 CSS 动画帧；而该特性的核心承诺恰好是「接管 DSH 启动页 → 主界面挂载后淡出、30s 硬上限、四种 fit」（AGENT §7.45）。唯一的兜底是 `TESTING.md` §2.18 的 B1–B9 人工勾选——`d5ff886` 把它们一次性勾成 `[x]`（`TESTING.md` 里 B/M/P 系列同时由 `[ ]` 改 `[x]`），但**没有任何截图、artifact 或可复跑脚本留存**，勾选不可复核。
- 建议：图片素材路径不依赖视频解码，完全可以做一个 headless harness（挂 `[data-dsh-boot]` 桩 → 断言覆盖层存在 → 移除桩 → 断言淡出与卸载）；同时给人工验收补一条「截图存 `docs/` 或 CI artifact」的约定。

### P1-10 门禁脚本自身几乎无测试，只有 1/5 被证明过

- 证据：`tests/check-known-failures.test.ts` 是唯一测门禁脚本的文件（通过 `execFileSync` 跑真脚本，`tests/check-known-failures.test.ts:15-30`）。`scripts/check-release.mjs`（233 行、4 项断言）、`scripts/verify-local.mjs`、`scripts/build-client.mjs`、`scripts/gen-wasm-manifest.mjs` **在 `tests/**` 里零引用**（grep `scripts/(check-release|verify-local|verify-arch|build-client|gen-wasm)` 无命中）。
- 证据：`git log --oneline v0.13.1..HEAD` 的 8 个提交里，代码类只有 3 个：`093a9b7`（带测试）、`41d2fe1`（带测试）、`91fdc79`（`check-release.mjs` +13 行 WARN 分支，**无测试**）；更早的 `278cc6a` 一次加了 220 行 `check-release.mjs` + 112 行 `gen-wasm-manifest.mjs`，同样无测试。
- 为什么危险：`check-release` 是发布前最后一道门禁（release.yml:96-97），它在 1.0 收尾时刚被改松过一次（`major < 1` 时把 engines 不一致降级为 WARN，`scripts/check-release.mjs:187-203`）。一个没有测试的「降级分支」是最容易悄悄放宽到任意版本的地方。
- 建议：给 `check-release` 的 4 项各写一个合成夹具（临时目录 + 假 package.json/index.json + 假 WASM_BUILD.json），尤其覆盖 `major < 1` 与 `major >= 1` 两个分支。

## P2（可维护性建议）

### P2-1 e2e 的路径口径分裂

- `e2e/config.mjs:54,57` 定义 `WE_WORKSHOP` / `WE_ASSETS` 并头注「所有脚本都应 import 本模块，不要各自再写一份默认值」；但 `e2e/verify/verify-web-pointer-parallax.mjs:30` 自己又写了一份 `D:/Steam/steamapps/workshop/content/431960/1184182304`（用 `WE_WALLPAPER` 覆盖）。
- `e2e/lib/png-stats.mjs:1-2` 头注仍写「research 临时脚本，不入库」，实际已入库并被 7 个脚本 import（`compare-shots` / `verify-isolated-rt-sharpness` / `verify-media-layer` / `verify-text-clock-layer` / `verify-v081-gaps` / `verify-web-pointer-parallax` / `e2e/lib/hidpi-metrics.mjs`）——首行注释会让人以为它可以随时删。

### P2-2 `ci.yml` 的 e2e 注释与实际排除面不符

- `.github/workflows/ci.yml:144-146` 只列了 3 个「不可上 CI」的脚本（turn-trigger / hidpi / text-clock），而实际依赖本机素材的是 7 个：`verify-v081-gaps` / `verify-v082` / `verify-isolated-rt-sharpness` / `verify-media-layer` / `verify-pointer-uniform` / `verify-hidpi-object-rt` / `verify-text-clock-layer`（均 grep 到 `WE_WORKSHOP`/`WE_ASSETS`）。按注释办会误以为其余都已上 CI。

### P2-3 `verify-local` 的 1b 门禁会清掉用户已暂存的改动

- `scripts/verify-local.mjs:38-44`：`git add -A -- lib/` 后 `git reset -q`（清的是**整个**索引，不只 `lib/`）。用户若已 `git add` 了别处改动，跑一次本地验收就被取消暂存。CI 无此问题（`ci.yml:55-58` 不 reset）。

### P2-4 `check-release` 失败路径只复原 `dist/`，留下脏 `lib/`

- `scripts/check-release.mjs:66-90`：`lib/` 不一致时直接 `throw`，不复原（tsc 已经把 `lib/` 重写）；`dist/client.js(.map)` 只在 `:84` 复原。随后 `verify-local.mjs:88-93` 的「工作树卫生」门禁会把这件事二次报成「有未提交改动」，把定位引向错误方向。

### P2-5 `verify-arch` 的浏览器侧规则漏裸内置模块

- `scripts/verify-arch.mjs:105` `NODE_BUILTIN_RE = /^node:/`，`:123-126` 只拦 `node:*`。`src/client/**` 里 `import fs from 'fs'` 或 `import { Buffer } from 'buffer'` 不会被拦，而 esbuild 打包后才在浏览器炸。规则说明（`:14`）也只承诺 `node:*`，所以算是**规则覆盖 vs 意图**的缺口。

### P2-6 样式契约靠 106 条正则文本匹配

- `tests/styles.test.ts` 有 106 处 `toMatch(/…/)`（CSS 文本级别）；`tests/dom/settings-section.dom.test.tsx` 有 24 处 `toBeTruthy()`（`querySelector(...)` 存在性）。AGENT §5.39 已把它们定为契约权威，所以不能删；但**重排 CSS 属性顺序/换行即红**，而真正的风险（`:where()` 具体度、深浅分支覆盖）不是文本匹配能表达的。
- 建议：拆成两段——「类名/选择器清单」（正则宽松到只匹配选择器）+「关键 token 覆盖」（`--dsw-*` 出现在哪个分支），发布前再用真机/截图复核具体度。

### P2-7 一条同义反复的「轴序判据」用例

- `tests/threejs-player.test.ts:4019-4029`：`composeByApplyOrder` + `rotMat` 都是用例自己实现的矩阵，断言的是「我算的 Rz·Rx·Ry ≠ 我算的 Rz·Ry·Rx」——**不经过任何生产代码**，永远不会因为实现回归而红。真正的约束在 `:4004-4016`（顶点 shader 源码里 `sin(a.x/y/z)` 的出现顺序）。建议：把 `:4019` 的标题改成「判据自检（非生产断言）」或删掉，避免被当成数值验证的证据。

### P2-8 1.0 新模块的口径缺口

- `src/client/diagnostics.ts` 的 `copyText` 降级分支（`textarea` + `execCommand`）没有任何测试覆盖：jsdom 里 `document.execCommand` 不存在 ⇒ `:72` 恒走 `false`，`tests/dom/settings-section.dom.test.tsx:1667-1691` 只测到 Clipboard API 成功路径与失败提示。**非安全上下文（局域网/隧道访问，AGENT §7.33 的常见路径）走的正是未测的那条分支。**
- `src/client/version.ts` 的 `__PLUGIN_VERSION__`（构建期 define，`scripts/build-client.mjs:51`）无测试：`PLUGIN_VERSION` 在 vitest 里恒为 `'0.0.0-dev'`，而面板断言只要求含 `v`（`tests/dom/settings-section.dom.test.tsx:1637`）⇒ define 丢失时测试全绿、用户报告里版本号变成 `0.0.0-dev`。建议加一个读 `package.json` + `dist/client.js` 的元数据测试（`tests/package-meta.test.ts` 已有类似形态）。
- `src/host/scene-source.ts` 无直接用例（`isSafeEntry` / `isSafeDependencyId` 两条安全判定只能经 `scanner.test.ts:112-113`、`routes.test.ts:1208+` 间接覆盖）；`src/client/pointer-post.ts`、`src/shared/user-refs.ts` 同样只被间接覆盖。

## skip/skipIf 清单

全部 10 处 `describe.skipIf`（全仓无 `it.skip` / `describe.skip` / `todo` / 条件 `return` 形式的静默跳过；grep 到的第 11 条 `tests/verify-real-library.test.ts:321` 是注释而非跳过）：

| # | 位置 | 跳过条件 | CI 上 | 丢掉的东西 |
|---|---|---|---|---|
| 1 | `tests/verify-real-library.test.ts:99` | `!existsSync('D:/Steam/.../431960')` | 跳过 | 全库 scene.pkg 零失败回归（9 个 `it` 中的主用例） |
| 2 | `tests/verify-real-library.test.ts:295` | 无库或无 REFRACT 素材 | 跳过 | 粒子 REFRACT 真库对照 |
| 3 | `tests/verify-real-library.test.ts:372` | 无库或无 `F21_PKG` | 跳过 | `instanceoverride` 包装解包真库回归 |
| 4 | `tests/object-effects.test.ts:79` | 同 #1 | 跳过 | 全库效果链分类（38 个 `it` 中的分类块） |
| 5 | `tests/effect-graph.test.ts:189` | 同 #1 | 跳过 | 全库 RT 图链形态（已改为「只断言非空」，见 `:226`） |
| 6 | `tests/mdl-real-library.test.ts:50` | 无 `3303428996/scene.pkg` | 跳过 | 静态族 puppet 硬断言 |
| 7 | `tests/mdl-real-library.test.ts:65` | 无 `3828798871/scene.pkg` | 跳过 | **蒙皮+动画硬断言（boneInverses=MDLS 链）** |
| 8 | `tests/mdl-real-library.test.ts:133` | 无 `3812518176/scene.pkg` | 跳过 | leon 13 骨 / 4 动画 id 不错位 |
| 9 | `tests/pointer-shim.test.ts:183` | 无 `1184182304/js` | 跳过 | 真实 jquery.parallax 壁纸的 shim |
| 10 | `tests/web-route-shim.test.ts:38` | 无该壁纸目录 | 跳过 | `/wallpapers/web` 真素材注入 |

补充：
- 这 10 处占 `it` 总量约 1%，但它们覆盖的正是「真实素材语义」这一类__mock 造不出的事故__（puppet 蒙皮、效果链真库形态、全库解析）。
- 条件跳过的判断全部发生在**测试文件加载期**（`existsSync`），报告里表现为 `skipped`，`check-known-failures.mjs` 不会看 `skipped`（`:34` 只认 `failed`）⇒ **跳过数量在生产 CI 里没有任何可见性**（只在日志里 `describe.skipIf` 的标题消失）。
- 反例（做得对的）：`tests/verify-real-library.test.ts:212` 用 `expect(okEffect).toBeGreaterThan(0)` 防「空集合恒真」；`tests/effect-graph.test.ts:226` 同样只断言非空。这套「只断言非空」的口径应在所有 skipIf 块内统一。

## 关键路径覆盖矩阵

判定 = 「有测试」：有直接针对该模块的用例且**不依赖本机素材**（CI 会跑）。「间接」= 只经上游模块或 mock 覆盖。

| 模块 | 有/无 | 代表用例（path:line） | 备注 |
|---|---|---|---|
| host 路由（list/scene/asset/range/media/frame/properties/now-playing/static/web） | 有（强） | `tests/routes.test.ts:113-1375`（60 个 describe/it）、`tests/host-apply.test.ts:88-107`（13 条路由全量断言） | 覆盖 pkg 入口名、Range 206/416、ETag/304、流式阈值、引擎目录回退、preset |
| 安全校验（穿越/UNC/Host 头/NUL） | 有（强） | `tests/boot-asset.test.ts:9-15,61-131`、`tests/routes.test.ts:371-385,631-700,877-925`、`tests/scanner.test.ts:112-113` | 5 种 UNC 变体、DNS-rebinding 的 Host 头、`%2e%2e%2f`、`C:/` 绝对路径都钉住了 |
| pkg 解析（PKGV/PkgReader） | 有 | `tests/pkg-reader.test.ts`、`tests/routes.test.ts:564-595`（mtime 缓存） | — |
| scene 解析（scene.json） | 有（强） | `tests/scene-json.test.ts`（207 断言）、`tests/scene-json-util/-parallax/-text-fields/-animation/-object-script` | 全库真库验证只在本地（#1） |
| 效果链（resolve/plan/runner/shader） | 有（单元强，像素弱） | `tests/effect-chain.test.ts`、`tests/effect-graph.test.ts`、`tests/effect-runner.test.ts`（74 KB）、`tests/shader/effect-chain.test.ts`（26 KB） | 全库形态与 `_rt_*` 真样本依赖本机（#4/#5）；像素证据 0 |
| puppet（MDL/骨骼/动画） | 合成有、真实无（CI） | `tests/mdl-parser.test.ts`（24 KB）、`tests/puppet.test.ts`、`tests/three-renderer.test.ts:3693-3926` | 真实蒙皮/动画 3 个块在 CI 全跳（#6-#8，见 P1-2） |
| 媒体（SMTC/时间线/封面/色板） | 有 | `tests/media-session.test.ts`、`media-input`、`media-orchestration`、`media-health`、`media-texture`、`media-palette`、`tests/routes.test.ts:1298-1385` | e2e 有 13 条判据但需本机素材，不在 CI |
| 开机动画 | 有（jsdom） | `tests/dom/boot-overlay.dom.test.ts`、`tests/boot-player.test.ts`、`tests/dom/boot-settings-section.dom.test.tsx`、`tests/boot-asset.test.ts` | **零 e2e / 零像素**（P1-9） |
| 降级链（scene→video→frame→preview→none） | 有（强） | `tests/scene-fallback.test.ts:31-186`（13 个 it，含并发去重、异常穿透） | 只有单测，无 e2e |
| 视频健康/降级（HEVC/超时） | 有 | `tests/video-health.test.ts`、`tests/tex-loader-video.dom.test.ts` | — |
| 设置面板（契约/DOM/样式） | 有（强、脆） | `tests/dom/settings-section.dom.test.tsx`（342 断言）、`tests/styles.test.ts`（106 条 CSS 正则） | 见 P0-1、P2-6 |
| 诊断/版本（1.0 新增） | 无直接 | 仅 `tests/dom/settings-section.dom.test.tsx:1628-1691` | 见 P2-8 |
| 发布门禁脚本（check-release/verify-local/build-client/gen-wasm-manifest） | 无 | — | 见 P1-10 |
| 全库真库回归 | 无（CI） | `tests/verify-real-library.test.ts:100` | skipIf #1 |

## 门禁口径差异表（本地 vs CI vs release）

| 门禁 | `verify:local`（本地） | `ci.yml`（PR/push） | `release.yml`（tag） | 差异风险 |
|---|---|---|---|---|
| 架构边界 | 有（`verify-local.mjs:25-28`） | 有（`ci.yml:49-50`） | 有（`release.yml:43-44`） | 一致；本地 `verify-arch.mjs` 默认跑自检 |
| tsc strict | 有（`:31-34`） | 有（`ci.yml:51-52`） | 有（`:46-47`） | 一致 |
| `lib/` 产物新鲜度 | 有（`:37-44`），含 `git reset`（会清用户暂存，P2-3） | 有（`ci.yml:53-58`），不 reset | 有（`:50-55`） | 一致 |
| `dist/client.js` 新鲜度 | 有（`:47-57`），失败会 `git checkout` 复原 | 有（`ci.yml:60-68`），`|| true` 吞构建失败只认 diff | 有（`:57-62`） | 一致（都以「删掉重建 + diff」为口径）；**`.map` 三处都不比** |
| tests 类型棘轮 | 有（`:60-63`） | 有（`ci.yml:69-72`） | 有（`:64-65`） | 一致；但放宽通道无守卫（P0-2） |
| vitest + 已知失败基线 | 有（`:66-71`）；**可能读陈旧报告**（P0-3） | 有（`ci.yml:87-91`），vitest 步骤 `continue-on-error`（`:89`） | **不同口径**：`pnpm test` 全绿（`release.yml:68-69`），不走 JSON 报告与基线 | 本地/CI 允许基线内失败，release 不允许 ⇒ release 更严；但 release 也不产出报告，失败时无 artifact |
| 测试数下限 | 无 | **无**（P0-1） | 无 | 三处都能被「删测试」绕过 |
| 渲染 e2e | 仅 colorblend（`:74-77`） | 仅 colorblend（`ci.yml:147-148`） | 仅 colorblend（`:91-92`） | 12 个 verify 脚本里 11 个不在任何自动门禁；7 个因本机素材无法上 CI |
| e2e 已知失败棘轮 | 无 | 无 | 无 | 见 P1-3 |
| 发布前检查（check-release） | 有（`:81-85`） | **无** | 有（`:96-97`） | PR 阶段完全不校验 npm pack 内容/体积、wasm 溯源、engines 一致性 ⇒ 只有打 tag 才发现（1.0 收尾时已因此改松过一次：`91fdc79`） |
| 工作树卫生 | 有（`:88-93`） | — | tag 必须干净（隐含在 1b/1c） | 本地在 `check-release` 之后跑 ⇒ 后者失败会连带误报（P2-4） |
| `E2E_TIMEOUT_MS` | 未设（默认 30 000，`e2e/config.mjs:70`） | 90 000（`ci.yml:106`） | 90 000（`release.yml:94`） | 慢机本地 e2e 假红 |
| 环境冻结 | 用户本机 node/pnpm（pnpm 大版本与 CI 不同，见 `overview.md` §2） | `pnpm install --frozen-lockfile`、node 22、pnpm 9 | 同 CI | 依赖/工具链漂移本地测不出 |
| Rust（cargo test） | 无 | 无 | 无 | 与 `overview.md` 的结论一致（不在本次范围） |
