# 用户属性面板全类型设计（v0.9）

> 日期：2026-10-23 ｜ 基线：`master` @ `8790cfe`（v0.8.2 + 文档回填）
> 上游：本机 45 张壁纸审计 F5/F20；新样本 `3812518176`「Leon (Resident Evil; Adjustable) MX」的文字重影诊断（对象形态 `user:{name,condition}` 未识别 + 父可见性未继承）
> 提案沿革：2026-10-23 曾评估暂缓（[rejected 笔记](../../../.agents/notes/rejected/feature/2026-10-19-user-properties-panel-scope.md)），同日因 Leon 样本确认「这是可见 bug 而非锦上添花」而重启

## 1. 目标与非目标

**目标**：把 `project.json general.properties` 的 bool / slider / color / combo 暴露为面板控件，并让属性值在 scene 渲染中真正生效（可见性、对象字段、效果开关、脚本读值），使 Adjustable 类热门壁纸不再出现「分支对象全部可见/属性调了没反应」。

**不做**（明确排除）：

- `text` 类型 UI（本机 0 样本，数据模型保留、面板不渲染）；
- 系统音频 / web 属性下发（`.agents/notes` 与其他缺口分开推进）；
- 就地实时生效（首版重装配；仅预留 `applyUserProperty` 接口）；
- 材质级 `usershadervalues`、完整 condition 表达式解析器（只做 §4 的最小表达式子集）；
- 属性分组（`type:"group"`）的折叠 UI（首版平铺，group 不返回）。

## 2. 数据模型（`src/shared/types.ts`）

`WallpaperUserProperty` 由单一 bool 改为判别联合：`type` ∈ `bool | slider | color | combo`。

```ts
export type UserPropertyValue = boolean | number | string;
interface UserPropertyBase {
  key: string;
  label: string;            // project.json text（去 HTML；空则 key）
  order: number;
  usedBy: string[];         // 被哪些路径引用（如 "objects[].visible" / "objects[].color"）
  condition?: string;       // 属性级 condition（依赖其它属性，见 §4.3）
}
// bool/slider/color/combo 各自 value 与类型专属字段：
// slider: min/max/step?/precision?/fraction?
// color:  value = "r g b"（0-1 空格分隔字符串，原样透传）
// combo:  value = string；options: { label: string; value: string }[]
```

另新增**绑定包装**类型（scene 解析产物，渲染期 resolve）：

```ts
export interface UserBindingRef { name: string; condition?: string }
export interface Bound<T> { value: T; user?: UserBindingRef }
```

## 3. host 聚合（`src/host/user-props.ts`）

`collectVisibleBoolProperties` → `collectUserProperties(project, scene)`：

1. 读 `project.json general.properties`，过滤 `editable !== false` 与 type ∈ {bool,slider,color,combo}；`group`/未知 type 丢弃。
2. 递归扫 scene.json 收集 `{user}` 引用键：`objects[].visible`、`objects[].{color,alpha,brightness,origin,scale,angles}`、`objects[].effects[].visible`、`objects[].effects[].passes[].constantshadervalues`、`objects[].text.scriptproperties`、`objects[].visible.scriptproperties`、`objects[].instanceoverride`、`general.*`。只返回**被引用**的属性（`usedBy` 非空；schemecolor 等噪音不返回）。
3. 默认值取 **project.json 的 `value`**（不是 scene 的 value；两者可能不一致）。
4. 排序 `order` 升序、同序按 key；坏 JSON/缺字段返回 `[]`（现状）。
5. 路由 `/wallpapers/properties?id=` 返回增强后的数组（每请求重读，保持现状）。

## 4. client 绑定解析（新增 `src/client/user-bindings.ts`，纯逻辑可测）

### 4.1 通用 resolve

`resolveValue<T>(node, userProps, hint)`：node 为 `{user: string|{name,condition}, value}` 或静态值。

- 读取用户值（localStorage override ?? host 给的默认值）；
- 属性级 condition 不满足 ⇒ 该属性视为不可用（回退作者 value）；
- 绑定侧 condition（`user.condition`）不满足 ⇒ **写中性零值**（false / 0 / "" / 零向量，we-layerd `WPUserSetting.cpp:183-216` 语义），**不是**回退 value；
- bool 属性：`condition "0"` = 开、`"1"` = 关（`WPUserProperties.hpp:79-85`）。

### 4.2 可见性

`parseVisible`（`src/client/visibility.ts:24-43`）扩展：`user` 支持字符串与 `{name,condition}` 对象。

**父链继承**（新增，WE 语义见 `SceneNode.h:105`、`Scene.cpp:55`）：`effectiveVisible(obj) = own && parentChain.every(...)`，在 `three-renderer` 装配前按 `id → parent` 建映射计算；若自身或祖先为 `script` 绑定则**不静态剔除**（沿用现有规则 `visibility.ts:45-50`），运行时按 value 视为可见。

**全库影响面（2026-10-23 扫描：39 张 scene / 358 对象）**：有 `parent` 的对象 **15 个 / 4 张**（`3765967112`、`3789452668`、`3812518176`、`3814332254`）；parent 缺失 **0**、容器父 **0**、父链含 `script` **0**。修复后可见性**只变化 2 张 / 5 个对象**：`2911105183` 的 144/148（condition 归因）、`3812518176` 的 227（condition）、234/245（父链）——全部是当前叠字 bug 的组成部分；其余 43 张零变化。结论：这是**修可见 bug**，不是新增行为，且两个修复各自覆盖不同壁纸（condition 修独立 Clock 分支、父链修父子结构），缺一不可。

### 4.3 属性级 condition（最小表达式）

支持 `==` / `!=` 比较与 `&&` / `||` 组合，操作数：`<key>.value` / 字面量（true/false/数字/字符串）。例：`audiobar.value==true`（`2832263418`）。不做括号与 `<`/`>`。表达式失败 ⇒ 视为满足（失败开放，不隐藏属性）。

### 4.4 用户属性表构建（装配期）

`userProps` 从「所有被引用的属性键」构建：值 = `localStorage` override ?? host 默认值。不再只扫 `visible.user`（`three-renderer.ts:528-546` 改造）。

## 5. 消费点接入

| # | 消费点 | 当前 | 改造 |
|---|---|---|---|
| 1 | `objects[].visible` | 字符串 user only（`visibility.ts:30`） | 对象形态 + condition + 父链（§4.2） |
| 2 | `objects[].color/alpha/brightness` | `scene-json.ts` 的 `optColor/optAlpha/optNumber` 只取静态 value | 保留绑定（`Bound<T>`），装配期 resolve |
| 3 | `objects[].origin/scale/angles` | 解析静态值 | 同上（含 `{script,value}` 现状不变） |
| 4 | `general.bloom` / `general.cameraparallax` | 解析为值 | 保留绑定，装配期 resolve（`general.bloom:{user}` = `3812518176`） |
| 5 | `effects[].visible` | 只认 `=== false`（`three-renderer.ts:165`） | resolve 绑定（bool 属性 + condition） |
| 6 | `effects[].passes[].constantshadervalues` | 装配期解包取 value（`uniform-binder.ts:42-52`） | 用 §4.1 取用户值 |
| 7 | `text/visible.scriptproperties` | 解包 `{user,value}` 只取 value（`script-patterns.ts`） | 保留 user 引用；注入脚本时用用户值（`scene-script-host.ts`） |
| 8 | `instanceoverride` | 解包取 value（`scene-json.ts:210-233`） | 同上（`leavedspeed` slider） |
| 9 | 脚本 `engine.userProperties` | 只注入 visible 键（`three-renderer.ts:985`） | 注入全部可引用属性（默认值 + override） |

## 6. 面板 UI（`src/client/settings-section.tsx:520-544`）

- 按类型渲染：bool→checkbox（现有）；slider→`input[type=range]` + 数值（step/precision/fraction）；color→`input[type=color]`（WE `"r g b"` 0-1 ↔ hex 转换，色彩空间需真机对照）；combo→`select`（options label/value）；`text` 不渲染。
- 只渲染 `usedBy` 非空属性（无假控件）；`condition` 不满足时禁用并标灰。
- 每项/整组「恢复默认」（写回默认值 = 删除 localStorage 覆盖键）。
- 值提交：bool/combo 立即；slider/color 防抖 300ms 或 `pointerup/blur` 后触发一次 `onReselect`（重装配）。
- 面板仅当前选中 scene 壁纸；保持现有 localStorage 键 `we:userprop:<wallpaperId>:<key>`。

## 7. 生效与预留接口

- 首版：所有属性变更走现有 `onReselect` → `wallpaper-controller` 重建（`settings-section.tsx:53-73` → `wallpaper-controller.ts:147-228`）。
- 预留 `applyUserProperty(key, value)`：渲染器侧定义接口与调用点（`three-renderer` 暴露），首版实现为「更新内部 userProps 表 + 重装配入口」，后续可替换为就地更新（对象已装配时走 `layer-state.ts`/`threejs-player.ts:1498-1501` 的每帧通道）。

## 8. 测试与验收

**单测**（新增/扩展）：

- `user-bindings.test.ts`：对象形态解析、绑定侧 condition（bool "0"/"1"、字符串、数值、不匹配零值）、属性级 condition 最小表达式；
- `visibility.test.ts`：对象形态 + 父链继承（含「祖先 script 不剔除」）；
- `user-props.test.ts`：四类型聚合、usedBy、group 过滤、默认值取 project、坏 JSON；
- `wallpaper-properties.test.ts`：四类型读写、per-wallpaper 隔离、旧全局键回退；
- `scene-json.test.ts`：`color/alpha/origin/scale/angles/general/instanceoverride/scriptproperties` 的绑定保留；
- `dom/settings-section.dom.test.tsx`：四类控件渲染、防抖提交、condition 禁用、恢复默认。

**真机验收**（`TESTING.md` 新增 §2.16）：

- `3812518176`：`clock` 三个分支只显示 1 个（默认 1 → Garet 样式）；切 2 → kust 样式；切 3 off → 时钟全隐藏；`clockcolor` 改色生效；`_24h` 切 12h；`leavedspeed` 滑块改落叶速度；`ember`/`rain` 等 bool 开关生效。
- `2911105183`：Clock combo 三态不再叠加、musiccolor 生效；
- `2937346640`：slider 眼动速度生效；
- `3118949804`：slider 与 cameraparallax 生效；
- `2832263418`：color + condition（audio bar 关闭时不可用）。

**回归**：现有 vitest 全绿；`e2e:verify-v081` / `e2e:verify-v082` / `e2e:compare` / `e2e:hidpi` 既有结果不变；4K 性能不显著变差。

## 9. 风险与边界

- **颜色空间**：WE color 值 0-1 的语义（线性 vs sRGB）需真机对照 `clockcolor`；首版按 sRGB 直接映射，标注待验。
- **重装配开销**：每次改属性重建 wasm/纹理，4K 可能有闪黑；防抖 + 仅在提交时触发。
- **script 绑定父链**：不能静态剔除，否则脚本永远点不亮（现有规则）；父链继承只覆盖 plain/user。
- **默认值来源**：必须 project.json 的 value（`3118949804 speed`：project 2 / scene 3.1300001）。
- **同名不同类型**：`newproperty1` 在 2832263418 是 bool、2937346640 是 slider ⇒ 存储继续带壁纸 id，类型按当前壁纸 schema。
- **group 类型**：Leon 壁纸有 `character`/`weather` 两个 group；首版不返回，面板平铺（后续可加折叠）。
- **HDR bloom**：Leon 的 `bloomhdr*` 仍不支持（属另一条缺口，不在本设计内）。

## 10. 交付面（预估）

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts` | 判别联合 + `Bound<T>` |
| `src/host/user-props.ts` | 全类型聚合 + usedBy + condition |
| `src/client/user-bindings.ts` | 新增：resolve + condition 表达式 |
| `src/client/visibility.ts` | 对象形态 + 父链 |
| `src/client/scene-json.ts` | 绑定保留（7 类字段/路径） |
| `src/client/three-renderer.ts` | userProps 构建、effect visible、父链、脚本注入 |
| `src/client/threejs-player.ts` | 绑定字段装配期 resolve |
| `src/client/shader/uniform-binder.ts` | constantshadervalues resolve |
| `src/client/script-patterns.ts` / `scene-script-host.ts` | scriptproperties 保留 user |
| `src/client/wallpaper-properties.ts` / `settings.ts` | 四类型读写 |
| `src/client/settings-section.tsx` + `styles.ts` | 四类控件 + 防抖 + 恢复默认 |
| `src/host/routes.ts` | 返回增强数组 |
| `tests/*`、`TESTING.md` | 单测 + §2.16 真机清单 |
