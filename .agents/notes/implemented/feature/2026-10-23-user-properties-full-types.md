# Agent Note: 用户属性面板全类型与装配前统一 resolve

Status: implemented

## Problem

v0.8 的属性面板只暴露 `bool`、只消费 `visible.user` 的字符串形态。本机热门壁纸 `3812518176`（Leon）因此出现两套时钟同时渲染的文字重影：`visible` 是对象形态 `{name:"clock",condition:"1"}`，解析层只认字符串 `user`、直接丢掉 condition；子对象（Date/Clock）自身没有 `visible` 绑定，父对象的可见性也没有沿父链继承。`2911105183` 的三个独立 Clock 分支（condition 0/1/2）同样三态叠加。与此同时，slider / color / combo 的值，以及 `general.bloom` / `cameraparallax`、effect visible、`instanceoverride`、`scriptproperties` 里的 `{user}` 都还停在作者静态值——面板就算给出控件也调不动。

## Decision

1. **解析保留引用、装配前统一 resolve**：`scene-json.ts` 解析时把 `{user}` 引用保留下来（对象字段 → `userRefs`，general → `bloomUser` / `parallaxUser`，effects / instanceoverride / scriptproperties 保留 `{user,value}` 节点），静态值照旧解析作兜底；装配入口 `three-renderer` 调一次 `resolveSceneUserBindings(desc, userProps)`，返回**新** desc，把引用统一换成用户值。下游（`threejs-player` / `effect-runner` / `uniform-binder` / `SceneScriptHost`）继续只读静态值，无需改动。
2. **值来源**：`userProps[key] = localStorage 覆盖值 ?? project.json 默认值`；未知键不注入。
3. **条件语义**：对象形态 `user:{name,condition}` 与字符串同等解析；绑定侧 condition **匹配即可见、不匹配即隐藏**（bool 的 `"0"`=开、`"1"`=关，we-layerd 语义），**不回退作者 value**——否则 `3812518176` 的 227（`value:false` 且 condition `"2"`）在 clock=2 时永远不可见。属性级 condition（`audiobar.value==true` 等最小表达式）失败开放：面板不禁用，渲染侧回退作者值。
4. **可见性 = 自身 && 父链**：`computeEffectiveVisibility` 按 `id → parent` 建表缓存，装配期各过滤点（image / particle / text / 效果链 / 隔离）统一查同一张 effective 表；script 绑定不在装载期定论（沿用旧规则，否则脚本永远点不亮自己）。
5. **只返回被引用属性**：`collectUserProperties` 只返回 `usedBy` 非空的 bool / slider / color / combo 属性，默认值取 **project.json 的 `value`**；`group` / `text` / 未被引用的 `schemecolor` 不返回。面板因此没有「调了没反应」的假控件。
6. **提交口径**：bool / combo 立即，slider / color 防抖 300ms 或 `pointerup` / `blur` 后提交一次（spec §6/§9 优先于本计划 Task 7 初稿的「color 立即」，见第 24 轮 ruling）。

父链继承的影响面（2026-10-23 全库扫描快照：39 张 scene / 358 对象）：有 `parent` 的对象 15 个 / 4 张，parent 缺失 0、容器父 0、父链含 script 0；修复后可见性只变化 **2 张 / 5 个对象**——`2911105183` 的 144/148（condition 归因），`3812518176` 的 227（condition）与 234/245（父链）；其余 43 张零变化。condition 修独立 Clock 分支、父链修父子结构，两个修复覆盖不同壁纸，缺一不可。

相关：[设计文档](../../../../docs/superpowers/specs/2026-10-23-user-properties-full-types-design.md)、[实施计划](../../../../docs/superpowers/plans/2026-10-23-user-properties-full-types.md)、[被翻转的暂缓提案](../../rejected/feature/2026-10-19-user-properties-panel-scope.md)、[v0.8 属性范围](../../implemented/architecture/2026-10-19-v08-degradation-rotation-and-properties.md)；契约见 `AGENT.md` §7.41 ①，真机清单见 `TESTING.md` §2.16。

## Affected repositories

- `dsh-use-wallpaper` 不涉及

## Alternatives considered

**全链路 `Bound<T>` 扩散（spec §2 初稿）。** 最强理由：类型上不留「未 resolve」的中间态，绑定语义只有一处定义，将来要做 `applyUserProperty` 的就地更新（每帧或每次变更 resolve）时天然支持。不用它是因为消费点太多：`origin/scale/angles/alpha/brightness/color` 要贯穿 `threejs-player` 的变换、隔离合成、脚本写回与全部效果链参数，每处都得把 `T` 改成 `Bound<T>` 并显式解包，等于把一次功能改动摊成跨十几个文件的类型迁移；而首版每次改属性都整壁纸重装配，运行期根本不需要再 resolve。统一 resolve 的代价是 effects / instanceoverride / scriptproperties 仍是 `unknown` 结构，只能按「作者 value 的类型」推断 hint，漏一条路径会静默保留作者值（与改动前同效），类型系统兜不住。

**只修可见性、不做全类型面板。** 最强理由：文字重影是唯一确认的可见 bug（rejected 笔记的原始结论），只碰 `visibility.ts` 成本最小、回归面最窄。不用它是因为叠字的两个成因（对象形态 condition、父链）与 slider/color/combo 的绑定消费（effect 参数、instanceoverride、scriptproperties）共用同一套解析内核；分开做会把同一处解析写两遍，而且 `3812518176` 的 `clockcolor` / `_24h` / `leavedspeed` 仍然没有入口。

**服务端返回全部属性（含未被引用的）。** 最强理由：实现最简单，面板能列出作者提供的所有旋钮，与桌面 WE 的编辑器面板更像。不用它是因为 44 条 `schemecolor` 与 22 条 web-only 属性会变成调了没反应的假控件，违背「展示即有效」；`group` 折叠又不在本期，全量平铺只会更乱。

**color 也「立即提交」（计划 Task 7 初稿）。** 最强理由：`input[type=color]` 在多数浏览器只在选择器收起时触发一次 `change`，逐事件重装配的担忧偏保守。不用它是因为 spec §6/§9 明确要求 slider/color 防抖 + `pointerup`/`blur`，且部分浏览器/输入方式会连续发 `input/change`；一次重装配要重建 wasm 粒子、纹理与脚本 VM，4K 下代价不可忽略。按「spec 优先于计划」的 ruling 统一为防抖。

## Consequences

**收益：** `3812518176` 的文字重影消失（两套时钟只剩一套），`2911105183` 的三档 Clock 不再叠加；bool/slider/color/combo 四类属性真正驱动可见性、对象字段、效果参数、粒子实例覆盖与文本脚本属性；面板只出现当前壁纸真正引用的属性，没有假控件。

**代价：** 每次属性提交都是整壁纸重装配（4K 可能闪黑，属已知边界；`applyUserProperty` 就地更新只有接口预留、未实现）；effects / instanceoverride / scriptproperties 的绑定靠结构 + 作者 value 类型推断，类型系统不保证覆盖全部路径，漏掉时静默回退作者值；`text` 类型没有 UI、`group` 不返回；color 的 0-1 值按 sRGB 直映射，`clockcolor` 与桌面 WE 的色彩空间仍待真机对照；父链可见性只覆盖 plain/user，script 绑定保持装载期不剔除。
