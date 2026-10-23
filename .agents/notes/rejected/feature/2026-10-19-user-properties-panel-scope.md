# Agent Note: 用户属性面板全类型范围

Status: rejected — 全库净新增仅 7 条 / 4 张，收益不足而成本跨 host、渲染与面板三层，暂缓

## Problem

v0.8 只把 `project.json general.properties` 中 `type=bool`、且被 `scene.json` 的 `visible.user` 引用的属性暴露成开关（见 [v0.8 产品化笔记](../../implemented/architecture/2026-10-19-v08-degradation-rotation-and-properties.md)），slider / color / combo / text 留待 v0.9。本轮核对确认：scene.json 里 `{user}` 绑定共 53 处、12 类路径，而解析层只认字符串 `user`、只消费 `visible`——2911105183 的三个 Clock 分支（对象形态 `user:{name,condition}`）因此全部通过可见性判定、三态叠加；3118949804 的 `general.cameraparallax.user` 被 `=== true` 判成关闭。要不要把「全类型面板 + 全绑定消费」一次补齐，需要重新评估收益。

## Proposal

（冻结提案，未实施）

1. host：`collectVisibleBoolProperties` 扩为全类型聚合（bool / slider / color / combo，带 `min` / `max` / `step` / `precision` / `fraction` / `options` / `condition`），只返回被当前 scene 实际引用的属性。
2. client：`WallpaperUserProperty` 改为判别联合；新增通用 `{user,value}` 绑定解析（字符串与 `{name,condition}` 对象两种形态），按参考实现语义求值——条件匹配用作者 `value`，不匹配写中性零值。
3. 消费点：`objects[].visible` / `color` / `alpha` / `general.cameraparallax` / `effects[].visible` / `effects[].passes[].constantshadervalues` / `text.scriptproperties` / 脚本 `engine.userProperties`。
4. 面板：四类控件 + `condition` 联动 + 恢复默认；继续写 per-wallpaper localStorage。
5. 生效：首版重装配（debounce），同时预留 `applyUserProperty` 就地更新接口。
6. 验证：条件语义单测 + 2911105183 / 2937346640 / 3118949804 / 2832263418 真机清单。

## 范围事实（决策依据）

- 本机 45 张壁纸（审计快照 43），`general.properties` 共 95 条：color 46（其中 `schemecolor` 44）、bool 31、slider 15、combo 3、text 0。
- scene.json 真正引用 29 条 / 8 张；现有 bool 面板已覆盖 14 条 / 6 张；全类型净新增 **7 条 / 4 张**（2911105183、2937346640、3118949804、2832263418）。
- 22 条只在 3 张 web 壁纸的 `wallpaperPropertyListener` 里消费，属 web 属性下发另一条未启动的通道；44 条 `schemecolor` 是 WE 主题色，38 个 scene.pkg 内 0 引用。
- 未解析绑定里只有 2911105183 的 Clock 叠加是当前可见错误；其余（effect visible 8 条、alpha / color / shader 常量、scriptproperties）要么无真机样本、要么属已登记边界。

## Affected repositories

- `dsh-use-wallpaper` 不涉及

## Alternatives considered

**整体暂缓，等有明确用户需求再重开。** 它最强的地方：不触碰 host 聚合、共享类型、scene 解析与 5 类消费点，风险与工作量都最小；而净新增只覆盖 4 张壁纸。最终选它，是因为收益集中在 7 条属性，却要对全库解析路径做通用化改造，且 `text` 类型本机 0 样本、无真机验收素材。

**只做面板 UI、不接渲染消费。** 优点是能看到全部属性控件；但 44 条 `schemecolor` 与未引用属性会变成「调了没反应」的假控件，违背「展示即有效」的产品原则，否决。

**照搬参考实现的全量语义（含 `condition` 表达式解析器与材质级 `usershadervalues`）。** 语义最完整、最接近桌面；但投入从「7 条属性」跃升到整个表达式求值器与材质动态绑定，本机素材又不覆盖，超出收益，否决。

## Acceptance criteria

（当时的验收约定，冻结）

- 面板按 `order` 显示被引用的非 bool 属性，每个控件改动后重装配生效且可见 / 可听变化。
- 2911105183 的 Clock 三态叠加消失；2980088441 的 12/24h 可切换。
- 单测覆盖对象形态 `user:{name,condition}` 的条件语义；4 张真机清单通过。

## Risks

- 条件绑定语义易错：不匹配时必须写中性零值而不是回退作者 `value`，否则会点亮作者显式关闭的分支（当前 `parseVisible` 正犯此错）。
- 默认值必须取 `project.json` 的 `value`，不是 scene 的 `value`——本机存在不一致（3118949804 `speed`：project 2 / scene 3.1300001）。
- 重装配会重建 wasm 粒子 / 脚本 VM / 纹理，slider 拖动需防抖；effect 参数、text 纹理、脚本 `userProperties` 均无运行时入口。
- 暂缓的代价：2911105183 的 Clock 叠加继续存在（用户可见错误），直到重开此功能或单独修；该单点修复的前置（host 下发被引用属性默认值）正是本提案的一半。
