# 渲染能力缺口增量复核（面向 1.0.0）

> 基于 v0.13.1 / HEAD `6069b26`，增量于 2026-11-06 版（`rendering-gaps.md`，基准 v0.13.0 / `0056109`）。
> 复核方式：以**当前代码**为准重读实现与测试，不采信「已修」记录本身；素材侧以只读 Node 内联脚本重扫 `D:/Steam/steamapps/workshop/content/431960` 全部 **51 条目**的 `scene.pkg`（脚本未入库）；WE 语义基准仍用本机 WE 2.8.42 明文 shader。**未运行 vitest / build / e2e**（由另一 teammate 负责），故文中「e2e 实测」一律引自代码仓库内已归档的 `AGENT.md` / `TESTING.md` / `.agents/notes/` 记录，不视为本次复跑。
> 本文只写**变化点**；上一轮未变化的条目请对照旧报告，不重复旧表全文。

## 速答（给 1.0 决策）

1. **A10 / A11 已真修**（不是只改文档）：puppet 对象级效果链在贴图空间合成并接 v 约定；`.mdl` 按真实 MDLS/MDLA 布局解析、绑定姿势 = MDLS 链、真实动画样本可播。上一轮「两个整层缺失」只剩 **A16 util 无 effects（3 对象 / 3 张，影响仍未证实）**。
2. **P0 仍是 4 项，不是 3 项**：A9 自旋轴序、A18 copybackground 定性、文档口径同步、A21 性能/显存量化——四项**上一轮之后一项都没做**。旧 P0 的第 5 项（A10/A11「修或披露」二选一）因真修而关闭，所以 P0 由实质 5 项降为 4 项（若按旧报告「S+S+S+S」的口径算则一直是 4，没有进一步减少）。
3. **库从 50 增至 51 条目**：44 scene（43 `scene.pkg` + 1 `gifscene.pkg`）+ 4 web + 3 video；preset `3163840671` 已不在本机库，新增 `3828798871`「影之刃零1」与 `3830466015`「snow leopard mei mei (snowfall)」。计数变化：A4 link_mouse **6→7 张**、A5 worldspace **2→3 张**、A8 emitter 字段 **12→13 张**、A18 copybackground **23→22 张**（23 含已消失的 preset）；A1/A2/A3/A6/A7/A9 计数不变。
4. **新增边界**：`3830466015` 是首个 `hdr:true` 真实样本（上轮「hdr 全 false ⇒ 0 影响」失效）；两张新素材都带有效 `cameraparallax`（amount 0.34 / 0.40，上轮「唯一有效 3793620838 / 0.08」过时）；puppet 效果链 RT 不参与隔离预算，2 个 4K puppet ≈ **200MB** 显存（决策笔记自认、代码可复算），尚未纳入任何性能门槛。
5. **1.0 渲染门槛结论不变**（仍是「scene 主链路稳定 + 边界诚实公开」，不要求 WE 全特性对齐）；但门槛清单有「1 收窄 + 2 新增」：G4 的整层缺失由 3 类收窄到 1 类；G2 真机验收新增 `3828798871`（TESTING §2.11 P4/P5/P7 待补）、G3 量化新增 puppet RT 显存项。

---

## 0. 审计口径与库现状

- 版本：`package.json:3` = `0.13.1`；`git describe` = `v0.13.1-1-g6069b26`；`0056109..HEAD` 共 18 个提交、49 文件 / +2556 −804。
- **`wasm/src` 零改动**（`git diff --stat 0056109..HEAD -- wasm` 为空）——A1–A9 的粒子侧结论全部原样成立。
- 改动只落在 9 个 src 文件：`effect-runner.ts`、`mdl-parser.ts`、`puppet.ts`、`scene-json.ts`、`shader/effect-chain.ts`、`shader/shader-preprocessor.ts`、`three-renderer.ts`、`threejs-player.ts`、`shared/types.ts`（`git diff --name-only 0056109..HEAD -- src`）。**A12–A25 涉及的 `scene-script-vm.ts` / `scene-timeline.ts` / `scene-assets.ts` / `audio-input.ts` / `glow-stage.ts` / `background-layer.ts` 等一个都没动**，故这些条目是「未修」而非「未复核」。
- 库现状（重扫 51 条目）：**44 scene = 43 `scene.pkg` + 1 `gifscene.pkg`（3809943023）+ 4 web（3778198228/3789244610/3804412656 等）+ 3 video**。与上轮 50（43 scene 含 preset `3163840671`、42 个 scene.pkg）相比：preset `3163840671` 目录已不存在（`Test-Path` false），新增 `3828798871`、`3830466015` 两个 scene 包。
- 全库统计（本次只读扫描）：挂链对象 108 个、**效果引用 222 条**（上轮 206；+16 全部来自 `3828798871`：obj23×1 + obj348×2 + obj656×3 + obj27×6 + obj35×4）；粒子对象 199 个；puppet 对象 4 个 / 3 张（`3303428996` 1、`3812518176` 1、`3828798871` 2，全部挂链共 12 条）。

## ① 相比上一轮的变化摘要

| 条目 | 上一轮（v0.13.0） | 现在（v0.13.1 / HEAD） | 证据（path:line） |
|---|---|---|---|
| A10 puppet 对象级效果链 | 不挂链，2 张（3303428996 lightshafts、3812518176 waterwaves） | **已修**：puppet 走隔离表、效果在**贴图空间**合成、输出写回网格贴图；旧「puppet 对象不支持对象级效果链」告警已删除。实际覆盖面 = **3 张 / 4 对象 / 12 条链**（含新增 3828798871 的 10 条） | `src/client/three-renderer.ts:923-953`（puppet 入 isolate、RT 按源分辨率、排除预算）、`:986-1002`（puppet 标记/预算排除）；`src/client/threejs-player.ts:1653-1673`（setObjectOutput 写回 map + 采样处补一次垂直翻转）、`:2190-2212`（内容 = 贴图平面、**不** flipGeometryUvY）、`:2413-2414`（puppet 内容 RT `samples:0`）、`:2457`（`quadAttached=false`）；`git grep 'puppet 对象不支持' src` 无命中；`AGENT.md:264` |
| A11 `.mdl` MDLA 解析 failed | 唯一真实蒙皮样本 `3812518176` 的 `mdla:'failed'`、蒙皮退化静态 | **已修**：按真实 MDLS0004/MDLA0006 布局重写；`3828798871` 两人物 5 骨 / 动画 80·104 / 60fps·360 帧 / 5 轨 / `skinned=true`；绑定姿势 = MDLS 局部矩阵链（非 frame0）；loop/mirror/single 采样对齐 WE。真实 `.mdl` 样本 3 张（静态 `3303428996` + leon 13 骨 4 动画 + renwu×2） | `src/client/mdl-parser.ts:11`（36B 关键帧）、`:177-196`（bounded section）、`:421-458`（MDLS）、`:481-575`（MDLA + 35B 尾块）、`:599-631`（parseMdl）；`src/client/puppet.ts:29-35`（Rz·Ry·Rx→四元数）、`:70-90`（boneInverses = MDLS 链）；`tests/mdl-real-library.test.ts:12-14,66-116,119-148`；`AGENT.md:254-265`；`TESTING.md:243,252` |
| 旧 P0 第 5 项「A10/A11 修或披露二选一」 | 未决 | **关闭**（选「修」且已完成，非仅披露） | 同上；`AGENT.md:264-265` |
| A9 粒子自旋轴序 | 仍未修（P0，9 张） | **仍未修**，代码与注释自 v0.13.0 起逐字未变 | `src/client/threejs-player.ts:394-403`（x→y→z 的 `weObjectRotate`，`:416/:439/:443-444/:466-467` 用于粒子自旋）；WE `D:/Steam/steamapps/common/wallpaper_engine/assets/shaders/common_particles.h:26-35`（`mul(mul(Rz,Rx),Ry)`）；`AGENT.md:238` |
| A18 `copybackground` | 字段未解析；23 个 scene 条目命中 | **仍未解析**；命中 **22 张 / 94 个对象**（差 1 即已消失的 preset `3163840671`）；唯一真实消费点仍随对象链快照生效 | `src` 内仅 `src/client/effect-runner.ts:56` 一处注释提到；`src/client/three-renderer.ts:1389-1396`（对象链快照门控）；`src/client/object-effects.ts:25`（`ENABLE_CHAIN_FRAME_SNAPSHOT_CONSUMER = true`）；`AGENT.md:244` |
| 文档-实现漂移 3 项 | 3 项待修 | **0 项修复**，且发现同口径过时注释另有 3 处（上轮未列）：`object-effects.ts:68,244-245`、`effect-runner.ts:55-57`（均称对象链快照门控关闭，与 `object-effects.ts:25 = true` 矛盾）；`docs/technical-notes.md:78` 仍写 `_rt_FullFrameBuffer` 槽不绑；README「使用前请了解」仍未披露 puppet effects / MDLA / vortex / link_mouse / mapsequence | `docs/technical-notes.md:78`；`src/client/three-renderer.ts:1395-1396`；`src/client/object-effects.ts:68,244-245`；`src/client/effect-runner.ts:55-57`；`README.md:251-274`（全文无上述关键词） |
| A21 性能/显存量化 | 未量化 | **仍未量化**；无新增任何 FPS/显存数据；反而新增 puppet 链 RT 的显存义务（2 个 4K puppet ≈200MB，见 ③-R1） | `AGENT.md:243`（「性能门槛未做量化计时」）；`TESTING.md:355`（「量化 FPS 未记录」）；`git diff --name-only 0056109..HEAD -- docs` 只有 `.agents/notes` 的 bug-fix 笔记，无量化报告 |
| 库构成 / 影响面 | 50 条目（43 scene + 4 web + 3 video） | **51 条目**（44 scene + 4 web + 3 video）；preset 消失、2 个新 scene；A4/A5/A8/A18 计数随之变化（见 ③ 计数表） | 本次重扫；`README.md:273` 仍以 `3163840671` 为例（该条目本机已不存在，属轻微文档滞后） |
| 新素材能力命中 | — | `3830466015` 首个 **`hdr:true`** + `bloom:true`；`3828798871`/`3830466015` 均带有效 `cameraparallax`（0.34/0.40）与非默认 `parallaxDepth` | 本次重扫 `general`（`3830466015` 的 scene.json `general.hdr=true`）；视差见 ③-R8 |

## ② 仍成立的缺口（按旧编号；只写变化点）

**A1–A25 状态矩阵**（本轮复核结论；证据见后文分条与 ①/③）：

| 编号 | 上轮状态 | 现在 | 影响面（51 条目口径） |
|---|---|---|---|
| A1 children | 仍未修 | **仍未修** | 14 张（98 个粒子对象）不变 |
| A2 ropetrail/rope | 仍未修 | **仍未修**（sprite 兜底） | 5 张（9 对象）不变 |
| A3 vortex | 仍未修 | **仍未修**（Other 算子跳过） | 2 张不变 |
| A4 link_mouse | 仍未修 | **仍未修** | **6→7 张**（新增 3828798871） |
| A5 worldspace | 仍未修 | **仍未修** | **2→3 张**（新增 3828798871） |
| A6 mapsequence | 仍未修 | **仍未修**（wasm 全仓无该名字） | 1 张不变 |
| A7 boids/remapvalue | 不做/P1 | **仍未修** | 1 张（`3812518176`；boids 3 对象 / remapvalue 2 对象）不变 |
| A8 emitter 扩展字段 | 仍未修 | **仍未修** | **12→13 张**（新增 3828798871） |
| A9 自旋轴序 | **P0 未修** | **仍未修**（P0） | 9 张（10 对象）不变 |
| A10 puppet effects | **P0 未修** | **已修**（见 ①） | 修复覆盖 3 张 / 12 链 |
| A11 MDLA | **P0 未修** | **已修**（见 ①） | 3 张真实 `.mdl` 样本 |
| A12 脚本交互链 | 仍未修 | **仍未修** | 2 张（+1 张点击切帧属产品决策）不变 |
| A13 registerAudioBuffers | 仍未修 | **仍未修** | 5 张（3 直接 + 2 代建近似）不变 |
| A14 instanceoverride `{script}` | 仍未修 | **仍未修** | 1 张（2859263090）不变 |
| A15 general 时间线 | 仍未修 | **仍未修** | 1 张（3812518176）不变 |
| A16 util 无 effects | 待定性 | **仍未修（唯一剩余「整层缺失」类）** | 3 对象 / 3 张不变 |
| A17 image 自定义 shader | 仍未修（近似） | **仍未修** | 1 张（2937346640）不变 |
| A18 copybackground | P0 待定性 | **仍未解析**（P0） | **23→22 张** |
| A19 Glow 覆盖 video | 不做/产品范围 | **未变**（仍只覆盖 scene） | 7 条目（3 video + 4 web）不变 |
| A20 MSAA | 不做/P1 | **未变**（Glow/段渲染整帧无 MSAA） | 44 张 scene 全部 |
| A21 性能量化 | **P0** | **仍未做**（P0） | 44 张 scene 全部 |
| A22 web 用户属性/键鼠 | 不做 | **未变** | 3 张 web |
| A23 多文件声音 | 不做/P1 | **仍未修** | 2 张不变 |
| A24 个别 pass 编译失败 | 不做 | **未变**（chromatic_aberration 仍失败；本轮新修的 shimmer 属新增素材） | 1 张不变 |
| A25 text 边界 | 不做/P1 | **未变**（装配期尺寸冻结 / 动态 color 不应用） | text effects 9 张不变 |

**分条说明（只列变化/需要新证据的）：**

- **A9（P0，仍未修）**：`src/client/threejs-player.ts:394-403` 的 `weObjectRotate` 依次施加 x→y→z（矩阵写作 `Rz·Ry·Rx`）；WE 明文 `common_particles.h:26-35` 是 `mul(mul(Rz,Rx),Ry)`。`:394` 与 `:418` 的注释仍声称「官方 order 就是 Rz·Ry·Rx」，该断言没有 shader 依据（本机 WE shader 可见），本轮未改。9 张多轴自旋清单不变：1280029027、1429403119、2011060960、2851992662、2897292240、2911105183、3811798465、3812518176、3828359750（z-only 时逐像素等价）。
- **A18（P0，仍未解析）**：`src` 里没有 `copybackground` 字段解析（唯二命中是 `effect-runner.ts:56` 的注释）；本机 22 张 / 94 个对象的 `copybackground:true` 仍只由「对象链 `_rt_FullFrameBuffer` 快照」覆盖唯一真实消费点（2597392171 godrays）。A/B 定性仍未做。
- **A16（仍未修，且现在是唯一「整层缺失」类）**：`src/client/three-renderer.ts:918-922`（util 准入要求 `effectChains` 非空）、`:984-985`（无链早退）→ 3 个无 effects 的 util 层整层不渲染（1429403119 compose、2832263418 fullscreen 脚本载体、3797976859 4×4 cursor compose）。这三处上轮判「预计无可见差、待确认」，本轮未做定性。
- **A1–A8（粒子侧，仍未修）**：`wasm/src` 零改动，逐条现状与上轮一致：`wasm/src/particle/sim.rs:785-786`（明确不支持 children）；`mod.rs:430-447`（Rope/RopeTrail 解析但 sprite 兜底，`:431-432` 注释）；`mod.rs:411-427` + `spec_to_emitter.rs:223`（vortex 等归 Other 跳过）；`mod.rs:237-245,463-464` + `spec_to_emitter.rs:204-215`（link_mouse/worldspace 不生成算子，`:209-215` 注释明确「DSH 没有鼠标位置输入」）；`mod.rs:399-410`（initializer 只按 8 个名字取，`git grep mapsequence -- wasm` 无命中）；`mod.rs:469-481` + `sim.rs:790-791`（emitter 扩展字段忽略）。本轮只更新**计数**（见 ③ 计数表）。
- **A12–A15 / A17 / A19 / A22 / A23 / A25（仍未修/未变）**：相关模块均不在 `0056109..HEAD` 改动清单内，逐条证据行号沿用旧报告且本轮复核无变化：`scene-script-vm.ts:274-276`（getEffect 恒 `visible:true`）、`:299`、`:311-312`（getLayer 按 name 生成句柄）、`:669-674`（`keyOf` 只认 `id:<n>`，name/new 一律 -1 → 写入丢弃）、`:720/:773`（只派发 cursorClick）、`:1005-1007`；`three-renderer.ts:1245-1249`（canvas 点击，注释明说生产不可达）；`scene-script-vm.ts:339-344`（engine 只有 userProperties/registerAsset/frametime/timeOfDay，无 registerAudioBuffers）、`script-patterns.ts:19-22`（只识别 visualizer 模式）；`scene-json.ts:290-299`（`{script,value}` 只取 value、丢弃 script）；`scene-timeline.ts:25`（PROPERTY_CHANNELS 仅 alpha/origin/scale/angles/color）；`scene-assets.ts:60-99`（只取 `passes[0].textures[0]` + spritesheet）；`three-renderer.ts:1436-1442`（Glow 只在 scene 装配，`background-layer.ts` 无 glow 引用）；`three-renderer.ts:1021`（text 世界尺寸 = 装配期实测布局）+ `threejs-player.ts:2067,2111,3276`（text 动态 color 关闭）。
- **A20（未变）**：`glow-stage.ts:126-132` 的 RT 参数无 `samples`（baseRT/levelRT 同）；`frame-capture.ts:46-51` 段目标亦无 samples ⇒ Glow 开启/段渲染时整帧失去 MSAA 仍在。
- **A24（未变）**：`2832263418` 的 `chromatic_aberration` 仍编译失败（`AGENT.md:290` 仍记录）；v0.13.1 新修的是新增素材 `3828798871` 的 shimmer（`AGENT.md:218-220` §5.58/§5.59），不属于本机旧库的 A24 口径。
- **文档漂移（G1 项，0 修复 → 需在 1.0 前同步）**：见 ① 表格；补一条口径矛盾：`AGENT.md:238`（§7.3）与 `src/client/threejs-player.ts:394` 均把轴序写成「Rz·Ry·Rx = 官方」，与 `common_particles.h:26-35` 不符——A9 修复时应同时改这两处文字。
- **决策笔记自身的过时结论（引用时注意，不算缺口但会坑人）**：`.agents/notes/implemented/bug-fix/2026-11-06-puppet-object-effects.md:17` 写「不得再叠 `texture.repeat/offset` 做 v 翻转」，已被 2026-11-09 的 v 约定修复推翻（现实现正是 `threejs-player.ts:1660-1667` 叠翻转）；同笔记 `:32`「shimmer 未生效」当日已被 shimmer 笔记修复；`.agents/notes/implemented/bug-fix/2026-11-06-mdl-puppet-animation.md:30` 仍写「`applyFrame(0)` 后全部 `boneMatrices` = 单位阵」，已被绑定姿势回退推翻（`tests/mdl-real-library.test.ts:108` 起断言 frame0 蒙皮矩阵**非恒等**）。

## ③ 新增能力、新边界与新风险（v0.13.1）

### 3.1 新增能力（均为真实素材驱动）

| # | 能力 | 覆盖/验证 | 证据 |
|---|---|---|---|
| C1 | `.mdl` 真实布局解析（bounded section + MDLS0004 + MDLA0006 + 36B 欧拉角关键帧 + 蒙皮下标口径 + MDLS 链绑定姿势 + loop/mirror/single 采样） | 3 张真实 `.mdl`；`3828798871` 两个人物 5 骨 / 动画 80·104 / 60fps·360 帧 / 5 轨可播；Node 逐骨对拍 Δ=0；e2e 骨矩阵帧间有差异 | `src/client/mdl-parser.ts:177-196,421-458,481-575`；`src/client/puppet.ts:29-90`；`tests/mdl-real-library.test.ts:66-148`；`AGENT.md:254-262` |
| C2 | puppet 对象级效果链（贴图空间合成 + WE v 约定） | 3 张 / 12 条链；`3828798871` 效果链输出非恒等、屏幕贡献红人物 6~9% / 黑武者 8~17%；关闭链 A/B 与直渲零差异 | `three-renderer.ts:923-953`；`threejs-player.ts:1653-1673,2190-2212,2413-2414`；`AGENT.md:264`；`.agents/notes/implemented/bug-fix/2026-11-09-puppet-effect-v-convention.md` |
| C3 | puppet 链 RT 按源分辨率（不参与隔离预算）+ 内容 RT 关 MSAA | `3828798871` 人物区 Laplacian 5.60→7.32（WE 真机 7.16）；修复前被预算压到 2704×1521 | `three-renderer.ts:940-953,1001-1002`；`threejs-player.ts:2406-2414`；`AGENT.md:249`；`TESTING.md:258`（P10） |
| C4 | 效果 shader 方言两条补丁：HLSL 隐式向量截断、sampler `default` 注解 = 引擎默认资产 | 本机 294 个 effect shader 仅 1 个命中截断；默认槽资产命中 29 处；shimmer 可编译执行，但真实素材下最终画面贡献 <8bit | `src/client/shader/shader-preprocessor.ts:571,651`；`src/client/shader/effect-chain.ts:25-28,133-160`；`src/client/effect-runner.ts:227`；`AGENT.md:218-220,265` |
| C5 | `colorBlendMode≠0` 的**静态作者色**照常烘 tint（云/雾与 WE 对齐） | 全库 cb≠0 共 **7 对象 / 6 张**；其中静态非中性色 3 对象（2460786246#107、3828798871#348/#656）、`{user|script,value}` 绑定 2 对象（2832263418#250、3797976859#40，保留不 tint）、color 缺省 2 对象；云/雾有 WE 同相位对拍（亮度 55.3→45.4 vs WE 48.8） | `src/client/scene-json.ts:401-403`；`src/client/threejs-player.ts:2047-2052,3225`；`src/shared/types.ts`（colorUserBound）；`AGENT.md:291,293`（§7.42 ⑯/⑱） |

### 3.2 新边界与新风险

| # | 风险/边界 | 说明与量化 | 证据 |
|---|---|---|---|
| R1 | **puppet 链 RT 不参与隔离预算，显存单独承担** | 每个 puppet 内容 RT + 2 张 ping-pong ≈3× 源纹理 RGBA8；`3828798871` 两个 3840×2160 puppet ≈**200MB**（决策笔记自估），`3812518176`（1920×1080）≈25MB；`ISOLATED_RT_BUDGET_BYTES = 384MB` 的预算核算**不含** puppet。1.0 的性能门槛若只测旧素材会漏掉这张最重样本 | `src/client/three-renderer.ts:945-953,1001-1002`；`src/client/threejs-player.ts:2413-2414`；`src/client/effect-runner.ts:450-451`（rtA/rtB 同尺寸）；`src/client/object-range.ts:364-366`（预算常量/字节口径）；`.agents/notes/implemented/bug-fix/2026-11-09-puppet-rt-source-resolution.md:37` |
| R2 | **多可见动画层只应用第一条可见层** | `blend`/`additive` 不混合；`3812518176`（leon 4 层）命中，Console 只告警一次 | `src/client/threejs-player.ts:1005-1018`；`AGENT.md:254`；`TESTING.md:258`（P8 边界） |
| R3 | **MDLE 不消费；MDLS>1 扩展块不解析；MDLV0021 world-anchored 未实现** | 解析器只把 `MDLE` 当网格块扫描边界 marker，不读世界绑定矩阵；MDLS 只读第一块（骨数+骨记录） | `src/client/mdl-parser.ts:421-424,608-610`；`AGENT.md:265`；`.agents/notes/implemented/bug-fix/2026-11-06-mdl-puppet-animation.md:54` |
| R4 | **MDLA 轨后 35B 全零尾块结构未确证** | 本机 4 个 `.mdl` / 6 个动画全为零，按长度跳过；遇非零变体会错位（fail-loud 面为 `mdla:'failed'`） | `.agents/notes/implemented/bug-fix/2026-11-06-mdl-puppet-animation.md:53`；`src/client/mdl-parser.ts:531-575` |
| R5 | **shimmer 最终画面贡献 <8bit** | 强制白 mask/gradient 时 pass 输出变化巨大（changedPx≈66.7 万）证明管线正确，但真实素材下 8bit 量化后 A/B `maxAbs=0`；若桌面观感确有闪点需 WE 真机帧差继续查 | `AGENT.md:265` |
| R6 | **puppet 材质走 three 内建 `MeshBasicMaterial`**：`colorBlendMode≠0`、自定义 shader、puppet 的 color/alignment 均不复刻 | 复刻需预乘 ShaderMaterial，会失去「内建材质才注入蒙皮 shader」前提 | `src/client/puppet.ts:42-44`；`src/client/threejs-player.ts:2227`（puppet align 恒 `[0,0]`）；`AGENT.md:265` |
| R7 | **首个 `hdr:true` 真实样本出现**（`3830466015`，且 `bloom:true`/bloomstrength 0.28） | HDR 与 `bloomhdr*` 仍未实现 ⇒ 该张 bloom 的阈值/强度按 LDR 语义执行，可能与桌面观感不同。上一轮「hdr 字段存在者全为 false ⇒ 0 可见影响」的结论**不再成立**（影响面 1 张，未做 A/B） | 本次重扫其 scene.json `general.hdr=true`；`README.md:266`（已披露「`hdr` 未实现」）；`AGENT.md:243`（bloom 边界） |
| R8 | **两张新素材带有效视差，且带非默认 `parallaxDepth`** | `3828798871` amount 0.34（depth -0.34/-0.14/0.18/0.28）、`3830466015` amount 0.40（depth 0.5/0.65/0.8）；上轮「唯一有效 = 3793620838（0.08）」过时。视差通路已实现（2026-10-23 只验收过 3793620838），新参数未验收；**传播组/`disablepropagation` 仍未实现**，但两张新素材均无 `parent` 容器命中 ⇒ 当前风险低（若后续素材带父容器则升高） | 本次重扫 `general.cameraparallax*` 与对象 `parallaxDepth`；`src/client/three-renderer.ts:1446`（setParallax 装配）；`AGENT.md:252`（§7.39） |
| R9 | **真机人眼验收待补** | `3828798871` 的动画/披风 = `TESTING.md:258` 明写「P4/P5/P7 真机人眼验收**待补**」；`3303428996` 的 lightshafts 链（A10 修复覆盖）未见单独 A/B 归档 | `TESTING.md:243-258` |
| R10 | **旧决策笔记与现实现不一致**（引用陷阱） | 见 ② 末条三例（puppet effects 笔记「不得翻」、shimmer「未生效」、MDL 笔记「frame0=单位阵」） | `.agents/notes/implemented/bug-fix/2026-11-06-puppet-object-effects.md:17,32`；`.agents/notes/implemented/bug-fix/2026-11-06-mdl-puppet-animation.md:30`；`tests/mdl-real-library.test.ts:108-116` |
| R11 | **README 例子引用已不在库的 preset** | `README.md:273` 仍写「例：`3163840671` = 3118949804 的预设版」；该 workshop 条目本机已不存在（功能仍支持，属举例滞后） | `README.md:273`；`Test-Path D:/Steam/steamapps/workshop/content/431960/3163840671` = false |

### 3.3 受影响素材数重算（51 条目口径，只列有变化或需要引用的项）

| 条目 | 上轮 | 现在 | 说明 |
|---|---|---|---|
| scene 包总数 | 42 scene.pkg（+1 preset） | **44**（43 scene.pkg + 1 gifscene.pkg） | preset `3163840671` 消失；新增 3828798871、3830466015 |
| 效果引用 | 206 条 | **222 条**（+16 全在 3828798871） | 挂链对象 108 |
| A1 children | 14 张 | **14 张**（98 对象） | 不变 |
| A2 rope/ropetrail | 5 张 | **5 张**（9 对象） | 不变 |
| A3 vortex | 2 张 | **2 张** | 不变 |
| A4 link_mouse | 6 张 | **7 张**（18 对象） | +3828798871（Bird spec flags=1） |
| A5 worldspace | 2 张 | **3 张**（13 对象） | +3828798871 |
| A8 emitter 字段 | 12 张 | **13 张** | +3828798871；字段口径：sign 8 张、speedmax 7、speedmin 3、duration 3、audioprocessingbounds 3、instantaneous 2、flags 1 |
| A9 多轴自旋 | 9 张 | **9 张**（10 对象） | 不变（3828798871 未命中） |
| A10 puppet effects | 2 张 / 2 链 | **已修**；覆盖 3 张 / 4 对象 / 12 链 | 3303428996×1、3812518176×1、3828798871×10 |
| A11 真实 .mdl | 1 张 | **已修**；3 张真实样本 | +3828798871（两个 5 骨人物）、+3812518176（13 骨 4 动画） |
| A16 util 无 effects | 3 对象 / 3 张 | **3 对象 / 3 张** | 不变（唯一剩余整层缺失类） |
| A18 copybackground | 23 条目 | **22 张 / 94 对象** | 少掉的 1 是 preset 3163840671 |
| A25 text effects | 9 张 | **9 张**（text 对象共 43 个 / 13 张） | 不变 |
| 粒子对象 | 199 | **199** | 新增素材的粒子对象数与旧口径一致 |

## ④ 更新后的 P0 / P1 / 不做 分档

### P0（1.0.0 前置；**仍是 4 项**，不是 3 项）

1. **A9 粒子自旋轴序修正（S）**：仍未修。`weObjectRotate` 的 x→y→z 顺序与 WE `common_particles.h:26-35` 不一致；改法可保持对象角度路径不动、只给粒子自旋新增 WE 顺序函数，z-only 零回归；需一张多轴素材（如 2851992662）桌面 A/B。同时修正 `threejs-player.ts:394,418` 与 `AGENT.md:238` 的「官方 order」文字。
2. **文档-实现口径同步（S，范围比上轮扩大）**：① `docs/technical-notes.md:78` 的 `_rt_FullFrameBuffer`「槽不绑」过时；② 4 处代码注释仍称对象链快照门控关闭（`three-renderer.ts:1395-1396`、`object-effects.ts:68`、`object-effects.ts:244-245`、`effect-runner.ts:55-57`），与 `object-effects.ts:25 = true` 矛盾；③ README「使用前请了解」补 4 项披露：puppet 对象效果链已支持（含贴图空间/v 约定边界）、puppet 动画解析边界（MDLE/MDLS>1/多动画层只取第一条/动画层 `visible` 缺省口径）、vortex/link_mouse/mapsequence 鼠标互动粒子不支持、`getLayer(name)`/hover 交互不可用；④ `README.md:273` 的 preset 举例更新。
3. **A18 copybackground 定性 A/B（S）**：22 张命中、实现为 0；至少用 2597392171（godrays 已生效）+ 1429403119 在桌面 WE 下对照，判定「是否真需全量实现」；若需要 → 升 1.x 并写 README，若不需要 → 记边界关闭。
4. **A21 性能/显存量化（S，测量）**：参考机（RTX 3060）1080p、默认 Glow，记录最重场景（2911105183 / 1429403119 / 2597392171）FPS/提交耗时与显存峰值；**新增必测 `3828798871`**（puppet 链 RT 估算 ≈200MB，R1）。写进 TESTING/发布说明。

> 关闭项：旧 P0「A10/A11 修或披露二选一」——选择「修」并已完成，不再需要披露底线（但 README 仍应写清 puppet 能力边界，归入 P0-2 的第 ③ 项）。

### P1（1.0.x 可补）

- **A4 + A5 + A3 + A6 打包（7 / 3 / 2 / 1 张，M）**：鼠标/控制点互动基础设施共用；比上轮多 2 张新素材，优先级可维持「A4 第一」。
- **A1 children（14 张，L）**：影响面最大，1.x 首项候选。
- **A2 ropetrail（5 张，M）**。
- **A7 boids/remapvalue（1 张，M）**。
- **A8 emitter 扩展字段（13 张，S/M + 真机 A/B）**：多数取值 0/缺省，先 A/B 定性。
- **A12 脚本交互链（2 张，S/M）**。
- **A13/A14（5 / 1 张，M）**。
- **A15 general 时间线（1 张，S）**。
- **A17 image 自定义 shader（1 张，待确认）**。
- **A19 Glow 覆盖 video（7 条目，M，产品范围）**。
- **A23 多文件声音（2 张，S/M）**。
- **A16 util 无 effects（3 对象/3 张，S/M）**：先定性，再决定 1.0 记边界还是补直通合成。
- **新增 P1-a：cb≠0 静态 tint 变更对 `2460786246` 的回归核对（S）**：tint 规则改变影响 3 个静态对象，只有云/雾做了 WE 对照；`2460786246#107`（cb=31、作者色 0.816/0.749/0.749）未做 A/B，建议 1.0 前补一张对照。
- **新增 P1-b：puppet 链显存优化（M，视 G3 测量结果）**：内容 RT 已关 MSAA；若峰值不可接受，可评估 ping-pong 降精度/共享、或对无整帧快照引用的链减一张 RT。

### 不做（1.0 明确记边界）

- A24 效果 shader 语义层类型推断（G2/G3 单素材仍有 chromatic_aberration）。
- A20 MSAA（画质项，1.0.x 视性能余量）。
- A22 web 用户属性/键鼠合成/失败回退（跨源与产品范围）。
- A25 text 隔离尺寸冻结 / text 动态 color（已披露）。
- HDR / bloomhdr / bloomtint / colorBlendMode 其它模式 / 跨层 `_rt_imageLayerComposite_*` / 视差传播组 / `disablepropagation` / 默认 parallaxDepth / `clearenabled` / `mediaTimelineChanged`：本机无实害或已披露。**注意**：HDR 一项因新素材 `3830466015` 出现首个 `hdr:true` 而**不再是「0 影响」**——仍不做，但必须写进发布说明/README（见 R7）。
- puppet 的进一步 WE 对齐（MDLE、MDLS>1 扩展块、cb≠0/自定义 shader、多动画层 blend）：1.x 视素材增长再议。

## ⑤ 对 1.0 渲染门槛结论的修正

**结论：定位不变。** 上一轮的「1.0 = **scene 壁纸核心渲染稳定、可解释、边界诚实**，不要求 WE 全特性对齐」仍然成立，v0.13.1 也没有改变这个判断的论据结构；变化只在门槛**清单的收窄/新增义务**上。

逐条更新（旧 G1–G4，`rendering-gaps.md:146-157`）：

| 门槛 | 上轮 | 现在 | 结论 |
|---|---|---|---|
| **G1 文档-实现一致性** | 未达成 | **仍未达成**，且可核查的过时点更多（4 处代码注释 + technical-notes:78 + README 缺 4 项披露；另 A9 相关文字与 WE shader 不符） | 仍必须做（P0-2） |
| **G2 真实库回归/验收** | 需 9 张重点素材端到端归档，新增 3812518176 人眼验收 | **自动化证据增强**（mdl-real-library 三样本硬断言、P6 自动化、3828798871 的 P7/P9/P10 e2e 数据、全库解析零失败可复跑）；但 **P4/P5/P7 真机人眼仍待补**（`TESTING.md:258`），G2 的 9 张归档仍未建立，且 3303428996 的 lightshafts 链未单独 A/B；**新增 `3828798871`/`3830466015` 需纳入** | 部分达成；补齐后方可关闭 |
| **G3 性能与显存有数字** | 未做 | **仍未做**；且清单要加项：puppet 链 RT 显存（≈200MB@3828798871）与 4K 场景 | 仍必须做（P0-4，测量） |
| **G4 无未披露的整层缺失** | 3 类：puppet effects / puppet 动画 / util 无 effects，二选一（修/披露） | **大幅收窄**：puppet effects、puppet 动画均已真修并有 e2e/单测证据，不再需要「披露或实现」二选一；**仅剩 A16 util 无 effects（3 对象/3 张，上轮判「预计无可见差」）待定性** | 只剩 1 项小定性，1.0 前可关闭 |

**P0 数量的直接回答**：上一轮实质是 **5 项**（4 个代码/测量项 + 1 个「A10/A11 修或披露」二选一，旧报告 P0 第 5 条）。v0.13.1 用「修」关闭了第 5 条，因此 **P0 = 4 项，没有减到 3 项**——A9、A18 定性、文档同步、性能量化四项在 v0.13.1 里**一项都没动**。另外新增两项非代码义务：`3828798871` 真机人眼验收（P4/P5/P7）与 puppet 显存测量，建议并入 G2/G3 而非另开 P0。

**一句话**：v0.13.1 把仅有的两个「用户可感知整层缺失」补上了（puppet 效果链 + 角色动画，且是真实素材驱动的修复），1.0 的渲染门槛因此**更接近可达**，但门槛本身不变——要对外说「scene 主链路稳定、边界诚实」，仍差 4 项 P0 小活（自旋轴序、copybackground 定性、文档同步、性能/显存数字）+ `3828798871` 的一次真机人眼验收。
