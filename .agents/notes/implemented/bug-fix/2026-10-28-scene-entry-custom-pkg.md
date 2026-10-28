# Agent Note: 场景包与入口跟随 `project.json.file`

Status: implemented

## Problem

壁纸 `3809943023`（"Change sides on 5th"）在 DSH 里显示成一张被放大的方形封面。它是 WE 的 **GIF 模板**壁纸：`project.json` 的 `file` 是 `gifscene.json`，场景包是 `gifscene.pkg` —— `scene.pkg` / `scene.json` 根本不存在。插件把入口写死成标准名，于是链路层层落空：

- `scanner` 的 `hasScene` 只查 `scene.pkg` ⇒ false；
- `resolveBackground` 见 `hasScene=false` 走 preview 分支 ⇒ 200×200 的 `preview.gif` 被 `object-fit:cover` 铺满 16:9 屏幕（放大数倍、上下裁切）——用户报的「大小不正常」；
- 即使强行走 scene，host 场景路由与 client 也都写死 `scene.pkg` / `scene.json`，同样取不到。

顺带发现两个次生问题：`TEXS` 的 `frametime` 被丢弃（精灵表固定 1fps，GIF 实为 16.7fps）；`flags` bit0 `NoInterpolation` 未消费（`gif_pointfilter` 的像素画被线性插值糊掉）。

## Decision

- 新增 `src/host/scene-source.ts`：按 we-layerd `WeProjectSource.cpp::ResolveProjectSource` 的规则解析——pkg = `file` 的扩展名换成 `.pkg`（缺省 `scene.pkg`），入口 = `file` 原值（缺省 `scene.json`）；`file` 必须是包内安全相对路径（非绝对、无 `..`），非法或包不存在回退标准名；preset 取依赖目录、按依赖壁纸自己的 `file` 解析。scanner 与 routes 共用同一函数。
- `WallpaperInfo` 新增 `sceneEntry`（仅 `hasScene` 时下发）；`BackgroundPlan.scene` / `SceneRendererLike.render` 第 4 参透传入口名，client 不再写死 `scene.json`。
- 次生：`parseSpriteSection` 解析首帧 `frametime`（>0 才写入 `TexSpriteInfo`），`registerSpriteSheet` 的 fps = 1/frametime（clamp 0.1–240，缺省仍 1fps）；tex-loader 的 `applySampling` 对 flags bit0 用 `NearestFilter` / `NearestMipmapNearestFilter`（其余纹理保持线性 + mip）。
- e2e 的 `verify-hidpi-object-rt` 与 harness 同步支持自定义入口（页面 URL 带 `entry`、`render` 第 4 参），否则这类壁纸在验证工具里仍渲染失败。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `8c76ceb`

## Alternatives considered

**在 host 的 asset 路由里做隐式回退（找不到 `scene.json` 时改用入口名）。** client 一行不用改。不用它是因为契约会变隐晦（同一 URL 在不同 pkg 上含义不同），且无法区分「真的没有」与「回退入口」；显式下发 `sceneEntry` 可测。

**client 先请求一个 `/entry` 接口拿入口名。** 不用它：多一次网络往返，而 list 本来就要返回 `file`，把入口名放进 `WallpaperInfo` 是零成本。

**对 `gifscene` 做白名单特判。** 不用它：WE 模板不止一种（后续可能出别的自定义名），按 `file` 解析是参考实现的通用规则。

**逐帧解析 TEXS `frametime` 并按每帧时长推进。** 不用它：WE 的 GIF 素材每帧时长相同（本例 40 帧全 0.06s），逐帧表只增加状态；首帧值已足够，缺失时保持 1fps 旧行为。

**bit0 用 `NearestMipmapLinearFilter`（mip 内线性）。** 不用它：WE 的 `NoInterpolation` 是完全不插值，最近邻 mip 更贴近；缩小锯齿交给 mip 链而非插值缓解。

## Consequences

**收益：** GIF 模板壁纸按 scene 正确渲染（e2e 截图：像素风画面铺满、像素块清晰）；帧率与点过滤随素材声明生效；标准 `scene.pkg` 壁纸零回归（`file` 缺省路径完全不变）。

**代价：** `WallpaperInfo` 新增契约字段（`sceneEntry`，列表 JSON 略大）；host 每次 scene 请求多读一次 `project.json`（`sceneSourceOf` 内，未缓存）；`frametime` 缺失的老素材仍 1fps；点过滤只影响声明 bit0 的纹理（观感变化是正确方向，但属可见变化）。
