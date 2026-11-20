# Agent Note: WE 纯效果对象（shape:"quad"）按短边正方形 + 实测偏移渲染

Status: implemented

## Problem

壁纸《Tokyo Sunset City Sky》（`3840341648`）在 Windows 桌面 Wallpaper Engine 上有从太阳洒下的光柱，DSH 里完全没有。解包 `scene.json`：光柱来自对象 `#64`（`name: "채광 - 모서리"`）的 `effects/lightshafts/effect.json`，该对象只有 `shape: "quad"` + `effects`，没有 `image`/`particle`/`text`。`parseSceneJson` 把它落进「空粒子兜底」（`kind:'particle'`, `particle:''`）⇒ 装配时 `particles.get()` 为空、跳过 ⇒ 没有隔离条目 ⇒ 效果链在 `render()` 的挂链循环里被丢弃，只留一条汇总告警（`1 条效果挂在未参与渲染的对象类型上`）。本机 51 张里命中 2 张：`3840341648`（1 个角向光轴）与 `3819697503`（径向 + 角向各 1 个）。

## Decision

- `src/client/scene-json.ts` 在空粒子兜底之前新增分支：`shape` 为 `quad`（大小写不敏感）且无 image/particle/text 的对象归 `kind:'util'`、`layerKind:'compose'`，并标记 `effectOnly: true`（`image` 取引擎内不存在的 `models/util/effectlayer.json`，util 分支不读它）。
- **视觉尺寸 = 场景短边正方形，中心再偏移 `SHAPE_QUAD_CENTER_SHIFT = (+0.030, −0.058) × 短边`**。短边正方形来自参考实现 `ResolveImplicitDirectDrawShapeVisualSize`；偏移量是 **WE 桌面实时帧的实测标定**（见下「基准」），不是从代码规范推导的——按参考实现的原值算，光柱源头比太阳偏左上（1600×900 下约 27px / 52px）。偏移**不随对象 scale 缩放**：用 `3819697503` 的 WE 帧验证，#25（`scale (1.66, 0.30)`）的径向光圆心与「不乘 scale」的 quad 中心吻合（误差 < 10px），乘 scale 会偏 17/32px。
- **lightshafts 控制点包围盒**：`g_Point0..3` 越界时，WE 用 **[0,0,1,1] 与四点的并集**当包围盒（不是四点的 min/max），按它偏移/缩放 quad（参考实现 `ResolveLightshaftsDirectDrawFinalTexCoordBounds` + `GenCardMeshWithTexCoordBounds`）；合成 quad 的 UV 也映射到包围盒（`background-assembly`：`u0 + u*(u1-u0)`，v 已 `flipGeometryUvY` 同向）。四点都在 0..1 内 ⇒ 不扩展（381 #25 即此形态）。
- `effectOnly` 的两处门控：`background-assembly.addBackground` 不登记 `registerUtilContent`、`three-renderer` 的 `utilContentIds` 不把它算作帧快照消费者（lightshafts 的 `DIRECTDRAW=1` 不读内容，登记只会无谓开启段渲染）。
- 合成混合改 `AdditiveBlending`（WE 的 DIRECTDRAW 输出是「生成贡献」，normal 会把光轴再乘一次 alpha）。
- 判据：`tests/scene-json-util.test.ts`（quad 尺寸/偏移/bounds 三种边界/effectOnly）；e2e 用生产 `lib/` 渲染并与 WE 桌面帧叠加比对，光柱源头落在太阳上。

## 基准（为什么这次才对）

WE 桌面壁纸渲染窗口是 `WPEDesktopDX11Window`（属于 `wallpaper64.exe`，挂在 `WorkerW` 下）。用 `PrintWindow(hwnd, hdc, 2)` 可截到与屏幕上完全一致的实时帧（1920×1080），这是唯一可靠的几何真值。之前的 N 轮都靠「第三方复刻实现 + headless 截图 + 肉眼」推断，所以每轮都只修到「接近」：

- `wallpaper-engine-renderer`（`.superpowers/we-layerd-src`）的 shape 尺寸/位置模型与真实 WE 不一致（短边正方形偏高 52px）。
- 光带形状随 `g_Time` 噪声滚动，不同时刻截图形状完全不同，容易把形状差异误读成位置差异；判断位置必须看**源头**是否落在太阳上。
- quad 尺寸、origin 偏移、UV 窗口三者互相抵消：单看渲染结果无法区分是哪一项错。

换壁纸采样时注意：`wallpaper64.exe -control openWallpaper -file <project.json>` 会重建渲染窗口，旧 `hwnd` 失效，要重新枚举 `WorkerW` 下的 `WPEDesktopDX11Window`。

## Alternatives considered

**新增 `kind:'effect'` 对象类型。** 类型上最诚实，但要把新 kind 接进 `SceneObject` 联合、scene-graph、visibility、装配的每个 `kind` 分支与既有测试的穷举；compose util 的现有语义逐条命中需求。

**按 `fullscreen` util 渲染。** `addBackground` 对 fullscreen 强制居中 + 铺满视口 ⇒ 丢掉 `origin`，光柱方向与桌面不符（第一版实测）。

**完全照参考实现（短边正方形 + bounds 中心）。** 位置偏左上（1600×900 下 27/52px），光柱源头不在太阳上——正是多轮返工的根源。

**把标定偏移搬去装配层。** 它与 image 的 `alignment` 同属「对象几何语义」，解析层已有先例；搬移要新增字段并重算 origin，风险大于收益，故只提成具名常量。

## Consequences

**收益：** 两张壁纸恢复光轴层；`3840341648` 的光柱源头与 WE 桌面帧重合（太阳，屏幕 1600×900 下约 (1040, 220)），quad 尺寸与参考实现的 bounds 一致（2276×2286 场景）；其它壁纸零回归（`npm test` 2305 通过 / 1 skip）。

**代价：** `(+0.030, −0.058)×短边` 是**单样本标定**（384 的 WE 帧），381 只验证了「不乘 scale」这一点、未逐像素校准；对象 RT 用包围盒尺寸（WE 是整屏 screen-bound），采样超出 0..1 的边缘会被 CLAMP（本机 1.5%–6%）；光带形状随 `g_Time` 变化，不能逐帧对比形状；shape 的 `color`/`alpha`/`brightness` 仍未解析（本机样本都没有）。
