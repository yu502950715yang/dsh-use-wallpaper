# Agent Note: puppet 蒙皮动画对真实 .mdl 布局的支持（影之刃零1 无动画）

Status: implemented

## Problem

壁纸「影之刃零1」（workshop `3828798871`）在桌面 Wallpaper Engine 里两个人物有骨骼动画，在 DSH 插件里两个人物完全静止。素材侧事实：两个人物是 puppet 对象（`models/renwu {1,2}.json` → `models/renwu {1,2}_puppet.mdl`），`scene.json` 的 `animationlayers` 分别引用 MDLA 动画 id **80 / 104**；`.mdl` 为 `MDLV0023` + `MDLS0004`（5 骨）+ `MDLA0006`（60fps / 360 帧 / 5 轨）。

旧 `parseMdl` 对这两份文件得 `segments={mdls:'ok',mdla:'failed'}`、`animations=[]`，同时顶点蒙皮槽被判「引用骨表里没有的 bone id 2/4」⇒ 整份蒙皮退化为静态网格。于是 `tickPuppets` 没有动画可采样、网格也不随骨骼变形，用户看到的就是「两个人物完全不动」。根因是两处对真实字节布局的假设错误：

1. **MDLA 尾块位置错**：旧 `locateTracks` 把「轨数之后、轨表之前」的 35B 当成固定填充；真实 35B 全零尾块在**轨表之后**（每动画一份，实测 6/6 动画）⇒ 轨表定位失败 ⇒ 整个 MDLA 段判 failed。
2. **MDLS 骨记录字段误读**：旧实现把每骨记录里的 i32 临时值（真实素材恒 1）当成「骨骼文件 id」做 id 升序重排 + 顶点蒙皮 id 重映射；真实 MDLS 没有 fileId 字段，`blendIndices` 直接是骨表下标 ⇒ 伪 `idToIndex` 让父索引全成 -1、5 根骨映射到同一 id、引用下标 2/4 被判缺骨。

另外 36B 关键帧被按「pos3 + 四元数4 + scale2」读；真实布局是 **pos3 + 欧拉角3 + scale3**（f6..f8 恒≈1；按四元数解释模长最大偏 0.179）。

## Decision

`src/client/mdl-parser.ts` 按真实布局重写骨骼/动画解析（网格/stride 部分保持原实现）：

- **bounded section**：段头 = 9B stamp（`MDxx0000\0`）+ u32 段尾**绝对偏移**（独占）；只接受合法段头，无效头继续扫描。MDLS/MDLA 的边界一律取段头声明，不再全局 scan 猜位置。
- **MDLS0004**：u16 骨数 + u16 填充；每骨 = name cstr / i32（临时值，不使用）/ u32 父索引（`0xFFFFFFFF`=根，父必须 < 当前下标，否则按根处理防成环）/ u32 绑矩阵字节数（=64）/ f32[16] 列主序 / 仿真 JSON cstr。MDLS >1 的扩展块不解析，只按段尾保证不越界。
- **MDLA0006**：u32 动画数；每动画 = id（读前跳过 0 值占位）/ i32 / name cstr（空名再读一次兜底）/ mode cstr / f32 fps / i32 长度 / i32 / u32 轨数；每轨 = i32（恒 0，**不是骨 id** ⇒ 轨序即骨序）/ u32 字节数 / 36B 帧；轨表后跳过 **35B 全零尾块**（多动画必须整块跳，否则下一动画错位）；mdla < 3 的旧版本按 metadata 表读。关键帧 = `pos[3] + 欧拉角[3] + scale[3]`，全零/单位值的轨标 `authored=false`。动画名按 UTF-8 解码。
- **蒙皮口径**：删除「文件 id 升序重排」与 `MdlPuppet.boneIdMapping`；`blendIndices` 按骨表下标原样带出，只有权重 >0 的槽引用越界下标才整份退化静态网格并告警一次。
- `src/client/puppet.ts`：欧拉角按 **Rz·Ry·Rx**（= three `Euler` order `'ZYX'`）转四元数逐帧 slerp；scale 三分量写回；`authored=false` 轨跳过（WE 语义：保持绑定姿态，不清零）。

验证：

- 真实素材硬断言（`tests/mdl-real-library.test.ts`）：`3828798871` 两个人物 1209/509 顶点、5 骨父子、动画 80/104（60fps / 360 帧 / 5 轨）、`skinned=true`；`3812518176` 的 leon 13 骨、4 动画 id 47/49/51/59 不错位；静态族样本 `3303428996` 仍为段 absent。
- Node 侧（生产 `lib/client`）：`createPuppetMesh` 得 SkinnedMesh，`applyFrame(0)` vs `applyFrame(180)` 的 `skeleton.boneMatrices` 最大差 343.86（renwu1，3/5 骨动）/ 256.59（renwu2，2/5 骨动）。
- 浏览器 e2e（headless Edge + 生产 `lib/client` 装配真实 pkg，脚本留在本地 `research/pf0-verify/`、未入库）：隐藏背景/粒子后只显示 puppet 时，修复前两区域跨时间 `meanAbsDiff=0`、boneSignature=false，修复后 `meanAbsDiff` 4.52/5.67、changedFrac 6.6%/7.3%、boneSignature=true；console 的 `[mdl] ... 退化为静态网格` 告警消失，`puppetLayers=2`。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `bb5c269`

## Alternatives considered

**只修 MDLA 尾块、保留骨 id 重排。** 能让 `animations` 解析出来，但蒙皮仍会退化（静态网格不随骨骼变形），人物依然不动；而且重排的前提本身是对字节的误读，留着会继续坑其它多骨样本。

**按参考实现 we-layerd 只读 1B「分隔字节」。** 对单动画文件也能工作（读完后 seek 段尾），但 leon 这类多动画文件会错位；实测 6/6 动画的尾块都是 35B 全零。按 35B 跳过才能支持多动画续读。

**在 parser 里直接把欧拉角转成四元数（保持 `rot` 字段不变）。** 可以少改调用方，但解析层要么引入 three、要么自写四元数数学，破坏 `mdl-parser.ts` 零依赖/纯数据的定位；把「作者格式（欧拉角）」和「渲染格式（四元数）」分开更诚实，转换放在 `puppet.ts` 一处。

**保留 `boneIdMapping` 字段并继续解析文件 id。** 没有真实样本需要重排；保留字段只会让后来者以为存在第二套下标口径。

## Risks

- **35B 尾块内部结构未确证**（本地 4 个 `.mdl`、6/6 动画全零）：当前只按长度跳过。若遇到非零变体可能错位；届时应按段尾/下一动画 id 自洽校验而不是硬猜。
- **MDLS>1 扩展块、MDLE（世界绑定矩阵）不消费**：真实样本不需要；MDLV0021 的 world-anchored 语义（参考实现里的 `world_anchored_bones`）未实现。
- **puppet 的既有边界不变**：不参与对象级效果链/隔离 RT、多动画层的 `blend`/`additive` 不混合（只应用第一条可见层）、`colorBlendMode ≠ 0` 与自定义 shader 不回放、color/alignment 未接。
- **真机人眼验收待用户确认**（`TESTING.md` §2.11 P4/P5）：自动化已证明「隐藏背景后人物像素会动」，但生产 GUI 里的观感需用户亲自看一眼。
- **既有、本次未修**：`node scripts/check-known-type-errors.mjs` 会给出两条「已修复可从基线移除」的提示（`synthetic-library` / `verify-real-library` 的 TS2339），基线文件没同步清理，属历史漂移；不影响门禁结论（无新增错误）。

## Consequences

**收益：** 「影之刃零1」两个人物恢复与桌面 WE 同形的骨骼动画；本机另一份多动画 puppet（leon `3812518176`）现在也能解出 4 个动画。解析器对段边界与字段语义改为「按真实字节自证 + 段级诊断」，坏段会 fail-loud（`segments: failed`）而不是静默无动画。

**代价：** `MdlKeyframe`/`MdlTrack` 形状变更（`rot` → `angle` + scale 三分量、新增 `authored`），删除了 `MdlPuppet.boneIdMapping`；旧合成夹具全部重写。多了一层「35B 尾块」的长度推断（见 Risks）。每帧采样多一次欧拉角→四元数转换（5~13 骨，量级可忽略）。
