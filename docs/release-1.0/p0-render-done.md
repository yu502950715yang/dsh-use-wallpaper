# 1.0.0 P0 渲染收口完成报告（A9 / 文档口径 / A18 定性）

> 2026-11-10，task-6 产出。工作基线 = HEAD `6069b26`（v0.13.1）+ 本轮未提交改动；本机壁纸库 51 条目（44 个 scene 包）。
> 只读扫描脚本用 Node 内联执行、未入库；WE 语义依据 = 本机 WE 2.8.42 assets + 参考引擎 `.superpowers/we-layerd-src/third_party/wallpaper-engine-renderer`。
> 本任务**未跑 build / build-client**（Lead 统一重建）、未 commit。`lib/` 是构建产物，本轮的 shader 改动要等 Lead 重建后才进产物。

## 1. A9 粒子自旋轴序修正（代码）

**依据**：WE 明文 `common_particles.h:26-35` 的 `ComputeParticleTangents` = `mul(mul(Rz,Rx),Ry)`；项目旧实现 `weObjectRotate` 依次 x→y→z（= `Rz·Ry·Rx`），自旋与对象角度共用同一函数。

**改动**（只改自旋路径，对象角度零回归）：

| 位置 | 改动 |
|---|---|
| `src/client/threejs-player.ts:404-413` | 新增 `weParticleSpinRotate`：依次施加 Ry→Rx→Rz（列向量约定下等价矩阵 `Rz·Rx·Ry`）；z-only 时与旧函数逐像素等价 |
| `:453` | sprite 角点自旋 `weObjectRotate(..., particleRot)` → `weParticleSpinRotate(...)` |
| `:475-476` | REFRACT 切线基：内层自旋换 `weParticleSpinRotate`，外层对象角度仍 `weObjectRotate` |
| `:426 / :449 / :454` | 对象角度调用点**未动**；`weObjectRotate` 本体（`:394-403`）未动 |
| `:394-395`、`:426-428`、`:471-474` | 注释修正：不再声称「官方 order 就是 Rz·Ry·Rx」；写明对象角度 = `Rz·Ry·Rx`（OWE ParticleRuntime）、粒子自旋 = `Rz·Rx·Ry`（WE `common_particles.h`） |

**测试**（`tests/threejs-player.test.ts:3965-4030`，新增 `describe('ThreeScenePlayer 粒子自旋轴序（A9）')`）：

1. shader 契约：`weParticleSpinRotate` 存在；两个自旋调用点用新函数、三个对象角度调用点仍用旧函数；从 shader 函数体抽取的轴序 = `['y','x','z']`（新自旋）与 `['x','y','z']`（对象角度，防对象路径被顺手改掉）。
2. 轴序数值判据：按抽取轴序组装矩阵，验证 = `Rz·Rx·Ry` 与 `Rz·Ry·Rx`；多轴样本 `(0.3,0.5,0.7)` 两序 `maxDiff > 0.1`（不同），z-only `(0,0,0.7)` 两序逐分量相等（零回归）。
3. 既有 REFRACT 文本契约断言（`:3813`）同步改为 `weParticleSpinRotate`。

**验证结果**：

- `npx vitest run tests/threejs-player.test.ts tests/three-renderer.test.ts` → **2 files / 393 tests passed**。
- `npx vitest run tests/object-effects.test.ts tests/effect-runner.test.ts` → **2 files / 132 tests passed**（§2 只改注释，作回归确认）。
- `npm run typecheck:tests` → 495 条 / 33 键（= 基线），**无新增类型错误** ✅。

**未做 / 待补**：多轴自旋影响面 9 张 / 10 对象（delta 口径）**尚未与桌面 WE 逐像素对照**，属 G2 真机验收项（AGENT.md §7.3 已如实标注）。

## 2. 文档-实现口径同步（文档）

已改 6 处（均指向同一事实：对象链 `_rt_FullFrameBuffer` 消费门控自 2026-10-28 起**已开启**）：

| 位置 | 原口径 → 现口径 |
|---|---|
| `docs/technical-notes.md:78` | 「`_rt_FullFrameBuffer` 该槽不绑（保持默认）+ 告警一次」→ 已绑定（对象链快照，`ENABLE_CHAIN_FRAME_SNAPSHOT_CONSUMER = true`，映射 `object-range.effectScreenMatrix`） |
| `src/client/three-renderer.ts:1395-1396` | 「对象链门控保持关闭」→ 已开启；util 内容层仍经 `allowFrameSnapshot` 显式放行 |
| `src/client/object-effects.ts:68` | 「本轮该结论不接线（= false）」→ 已接线（= true，2026-10-28） |
| `src/client/object-effects.ts:244-245` | 「本轮仍关闭」→ 已开启并说明 util 另行登记 |
| `src/client/effect-runner.ts:55-57` | 「该消费路径当前门控关闭」→ 已开启（= true，2026-10-28） |
| `AGENT.md:238`（§7.3） | 「粒子自旋的轴序偏差（本项目用 Rz·Ry·Rx…）」→ 改为**已对齐 WE 的记录**（自旋 `Rz·Rx·Ry`、对象角度 `Rz·Ry·Rx`、z-only 等价、判据测试位置、仍欠真机逐像素） |
| `AGENT.md:244`（§7.31） | `copybackground` 结论段按 §3 定性重写（原「唯一真消费点」表述被修正） |

**剩余漂移（超出 task-6 写域，需 Lead / 其它任务同步）**：`TESTING.md:126` 仍写「`_rt_FullFrameBuffer` 消费者按 R6 降级、门控关闭（`ENABLE_CHAIN_FRAME_SNAPSHOT_CONSUMER = false`）⇒ 该槽仍留空 + 每槽去重告警」，与现状矛盾。历史文档（`docs/fixes/**`；plans 目录已于 2026-11-10 清理）里的「门控关闭」是当时记录，保留原样；`docs/fixes/library-feature-gap-audit-2026-10-20.md` 的 F6 结论已被 §7.31 新定性取代（历史审计，未改）。

## 3. A18 copybackground 定性（只读分析，**未实现**）

### 3.1 方法与 WE 语义依据

扫描 51 条目 / 44 scene 包（`project.json.file` → `.pkg`，含 gifscene）/ 395 个对象，逐对象解析 `scene.json` 效果链 → effect.json → material → shader，检索 `COPYBG`、`_rt_*`、`compose`（只读 Node 内联脚本，未入库）。

WE 语义（参考引擎 + WE assets）：

- **字段语义**：`copybackground:true` 的对象，其**全部 effect material** 被置 `COPYBG=1`（`WPSceneParser.cpp:5185-5189`；text 同口径 `:5634-5640`）。该 combo 只是「是否让 shader 走背景合成分支」的开关，shader 里没有 COPYBG 分支时字段无效果。
- **真读帧缓冲的两个 shader 面**：① `godrays_combine` / `shine_combine` 的 `#if COPYBG` 分支（`albedo.rgb = mix(bg.rgb, albedo.rgb, albedo.a)`；`g_Texture2` 注解 `default:"_rt_FullFrameBuffer"`）；② effect preset 里的 compose pass `materials/util/effectcomposebackground.json`（`shaders/effectcomposebackground.frag` 同样做 `mix(bg, result, result.a)`，读 `_rt_FullFrameBuffer`）。
- 本机库**无** `solidlayer` 对象命中 copybackground ⇒ solid 源 helper（`composelayer_clearalpha`）路径 0 样本。

### 3.2 命中与真消费

- 命中：**22 张 / 94 对象**（image 76 / text 18；51 个挂 effects：image 47 / text 4；其余 43 无 effects）。
- **真消费 3 张 / 3 对象**：

| 壁纸 / 对象 | 机制 | 现状 |
|---|---|---|
| `2597392171#50` 柯西（image） | `effects/godrays/effect.json` 第 4 pass（godrays_combine）：scene 显式 `combos.COPYBG=1` + `textures[2]="_rt_FullFrameBuffer"` | **已覆盖**：对象链段边界快照生效（`object-effects.ts:248-254` 引用即登记消费者） |
| `2937346640#44` 111（image） | 同 godrays_combine，但 scene **未显式**给 combo/槽 | **未覆盖**：我方 combo=0 ⇒ `#if COPYBG` 分支编译掉；WE 由字段传播置 `COPYBG=1` 并绑 shader 默认 `_rt_FullFrameBuffer` |
| `2911105183#304` CP_ads_02（image） | `effects/refraction/effect.json` 第 0 pass = `materials/util/effectcomposebackground.json`（compose） | **未覆盖**：`effect-chain.ts:72-74` 跳过全部 `materials/util/*` pass ⇒ 该合成步骤整条缺失 |

- 反例 / 其余：`3660373677#17` 的链含 shine_combine COPYBG 分支，但对象 `copybackground=false` ⇒ WE 不置 combo，不算消费；其余 19 张 / 91 对象既无 `_rt_` 槽、无 compose pass、链内 shader 也无 COPYBG 分支。
- 结论修正：上一轮 delta「唯一真实消费点 = 2597392171 godrays」**不准确**——实际 3 个真消费对象（1 个已覆盖、2 个未覆盖）。

### 3.3 结论与决策建议

**结论 = 1.0 记边界（不实现）、1.x 再补**，但**不能写「0 影响」**：

- 真实未覆盖 = 2 对象 / 2 张（2937346640、2911105183）。按 shader 语义，差异只在「背景副本参与合成」的像素：godrays 只在 rays 覆盖且层 alpha<1 处不同；refraction compose 只在需要背景参与折射处不同。**幅度未量化、未做桌面 A/B**（delta 要求的 WE 对照尚未执行）。
- 不实现理由：成本 L，且跨 4 个模块（`scene-json.ts` 字段解析 → `effect-chain.ts` 的 COPYBG 传播与 `_rt_*` 默认槽保留 → `effect-runner.ts`/`object-effects.ts` 快照绑定 → compose pass 合成），其中前两个不在 task-6 写域；本机仅 2 对象，1.0 不值得为此冒回归风险。
- 1.x 实现清单（按序）：① `scene-json` 解析 `copybackground` 并随 effects 上下文下发；② `effect-chain` 对该对象全部 pass 注入 `COPYBG=1`，并把 shader `default:"_rt_*"` 注解保留为「帧快照槽」；③ `object-effects`/`effect-runner` 让这类槽登记段边界消费者并绑快照；④ 把 `materials/util/effectcomposebackground` 实现为内置合成 pass。

## 4. README 待补披露清单（交 Lead；本任务未改 README）

位置：`README.md`「使用前请了解」→「画面表现」（当前 :270-287）。建议新增以下条目（可直接粘贴），并在 :286 替换 preset 举例：

1. **puppet（人物骨骼模型）效果链已支持，但有边界**：披风/衣摆类效果在**贴图空间**合成后写回人物贴图（不是把人物整体渲进对象 RT）；人物材质仍用 three 内建材质 ⇒ `colorBlendMode≠0`、自定义 shader、人物 color/alignment 未复刻。
2. **puppet 动画解析边界**：动画层 `visible` 缺省按可见处理；多条可见动画层只应用**第一条**（blend/additive 不混合）；个别模型文件结构（MDLE 世界绑定、MDLS 扩展块）不解析，人物可能静止或位置略偏；`.mdl` 解析失败会退化为静态贴图（不白屏）。
3. **依赖鼠标/控制点的粒子不支持**：`vortex`（旋涡）、`link_mouse` / `worldspace`（鼠标位置控制点）、`mapsequencearoundcontrolpoint` 这几个算子不会产生鼠标跟随 / 旋涡运动 —— 对应粒子层按普通运动绘制或跳过该算子，与桌面 WE 观感会有差异。
4. **场景脚本的部分写入/交互不可用**：脚本用 `getLayer('<名字>')` 按名字取层后写入不生效（只认对象 id 方式）；`cursorEnter/Leave/Down/Up` 等 hover 交互事件不派发（生产 GUI 背景层不吃点击，点击切帧同属已知边界）。
5. **（A18）极少数依赖「背景副本」的效果未实现**：`copybackground` 字段不解析 —— 把背景当作效果输入的壁纸，其相关层效果可能与桌面不同（例：`2937346640` 的光轴合成、`2911105183` 的广告牌折射）；`2597392171` 的光轴背景合成已生效。
6. **preset 举例替换**（当前 `README.md:286`）：`3163840671` 本机已不存在，且当前无其它 preset 样本可用 ⇒ 建议**删掉具体 id 举例**，改为通用描述（「这类项在面板中标 PRESET，选中后按依赖的主壁纸渲染并套用预设参数」），不要编造新 id。

另需同步（不在 README，但属同类口径漂移）：`TESTING.md:126` 的「快照门控关闭 / 槽留空 + 告警」段落（见 §2 末）。

## 5. 改动文件清单

- 代码：`src/client/threejs-player.ts`（A9 新增函数 + 2 处自旋调用 + 注释）、`src/client/three-renderer.ts`、`src/client/object-effects.ts`、`src/client/effect-runner.ts`（仅注释口径）。
- 测试：`tests/threejs-player.test.ts`（新增 A9 describe + 既有 REFRACT 断言同步）。
- 文档：`docs/technical-notes.md`、`AGENT.md`（§7.3 / §7.31）、本文件。
- **未改**：README.md、package.json、index.json、`lib/`、`dist/`（等 Lead 统一重建）；未 commit。
