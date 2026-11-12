# Agent Note: 媒体封面无系统封面时回退默认纹理（WE 占位图语义）

Status: implemented

## Problem

壁纸《Somewhere In Nowhere [4K]》（workshop `3819637149`）在 DSH GUI 右上角常驻一个灰色方块。实测：灰块 = scene 对象 `#171 Album Cover`（`instance.usertextures` 绑定 `$mediaThumbnail`，200×200 @ 场景 `(3665,1900)`），矩形内像素恒为 `RGB(178,178,178)` = 纯白 × 壁纸层 30% 黑色遮罩（`styles.ts` 的 `.wp-bg-overlay`）；用生产 `lib/` 在同视口重渲染时该矩形为纯白 96×96，矩形与对象屏幕位置逐像素重合。

根因两层：① 本机 SMTC 当前会话（`chrome.exe` 播放浏览器视频）只有标题、**没有封面**（`hasThumbnail:false`），`$mediaThumbnail` 没有可显示的图；② 插件把封面对象的 map 直接换成共享 1×1 白占位（`media-texture.ts`），并丢弃对象自己解析出的纹理；同时 `instance.textures` 覆盖逻辑只认名字含 `/` 的条目，本壁纸的根级 `wayside` 被忽略。WE 语义是「无系统封面时显示图层占位图」（官方 Album Cover Integration；[设计文档](../../../../docs/superpowers/specs/2026-10-30-media-integration-design.md) §9.2 也写明「初始 map = 材质原纹理」，此前实现按第一张样本 `util/white` 简化成了 1×1 白）。本壁纸作者预留的占位图是 `materials/wayside.tex`（512×512，曲目《Wayside》封面，包内自带同名音轨与标题脚本），桌面上显示的是它而不是白块。

## Decision

- `src/client/scene-assets.ts`：`instance.textures` 覆盖**一律按 `materials/<name>.tex` 根相对解析**（不再以含 `/` 为条件；材质槽名仍走原 `resolveTexPath`）。全库仅 3 个对象带 `instance.textures`，唯一无斜杠样本就是本壁纸的 `wayside`，包内确有 `materials/wayside.tex`。
- 新增 `src/client/media-cover.ts` 的 `mediaCoverSwitches()`：纯函数决定每个封面对象当前该采样哪张纹理——有系统封面 → 共享封面纹理；无封面/共享源缺失 → 对象默认纹理；无默认图的目标跳过（其 map 恒为共享源、随 `setImage` 自动更新，保持 `3797976859` 旧行为）。
- `src/client/threejs-player.ts` 新增 `setBackgroundTexture(objectId, texture)`：按 scene 对象 id 替换背景采样纹理；**隔离对象换的是内容 mesh（进对象 RT）的 map**，合成 quad 仍采样对象 RT；两个纹理互换不重编 program，有↔无纹理才 `needsUpdate`（USE_MAP 宏变化）。
- `src/client/three-renderer.ts`：装配期封面对象用默认纹理上屏并记录 `mediaCoverTargets`；`syncMediaCover(has)` 在「封面到达 / 解码失败 / 快照无封面」三处切换。原「被封面替代的纹理」二次释放表已删除（默认纹理现在进 `backgroundTextures`，由既有 teardown 释放）。
- 入库产物同步重建：`lib/client/*`、`dist/client.js(+map)`；新增回归用例 `tests/media-cover.test.ts`，并补强 `tests/{scene-assets,threejs-player,three-renderer}.test.ts`。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `0bfbf60`

## Alternatives considered

**无封面时隐藏封面对象。** 一行改动（`visible=false`）立刻看不到白块。不用它：WE 语义是「常显占位图」，该壁纸的媒体区（封面框/日期/歌名）作者设计为常驻；隐藏会连 200×200 的蓝色封面框一起消失，与桌面观感不符。

**把默认纹理转成 RGBA 塞进共享 `THREE.Texture` 的 image。** 可以完全不碰 player/材质。不用它：WE `.tex` 默认图可能是 DXT5 压缩纹理（本壁纸就是），`Texture.image` 不能直接接收 `CompressedTexture`；要么在 JS 里解 DXT（与 tex-loader 并行的第二条解码路径），要么把共享源改成能采样压缩纹理的特殊对象，复杂度高于「换 map」且易回归。

**让 `media-texture.ts` 创建时就带默认图、继续共享一张纹理。** 看似最小。不用它：默认图是**逐对象**的（同一场景可能多张封面对象、占位图各不相同），共享一张纹理无法表达；同一张纹理在「压缩默认图 ↔ 未压缩封面」间切换还会踩 three 的压缩/非压缩上传路径差异。

**`instance.textures` 解析同时保留「无斜杠 = 材质同目录」旧猜测。** 兼容两种写法更保守。不用它：WE 语义与全库样本都表明实例纹理名相对 `materials/` 根；保留猜测会让 `wayside` 继续解析到不存在的 `materials/util/wayside.tex`，等于没修。

## Consequences

**收益：** 无系统封面的媒体会话（浏览器页面、无封面播放器等）下封面图层显示作者预留的占位图，与 Wallpaper Engine 桌面观感一致；本壁纸右上角白/灰块消失。有封面时行为不变（切歌仍换 image、淡入与主色联动）；`3797976859`（默认纹理 `util/white`）外观不变。回归：`npm test` 2255 通过、`e2e:media` 13/13、`e2e:media --regression` 22/22。

**代价：** 封面对象的隔离 RT 按默认纹理源尺寸计算（本壁纸升到 512×512，`28 B/px` 预算口径约占 7 MB，单对象、384 MB 预算内）；新增一层 `media-cover.ts` 策略模块，其中「无默认图目标跳过」分支只在旧样本形态（`util/white` 默认图）下生效——真实库只有 2 张壁纸绑定 `$mediaThumbnail`，覆盖面有限；`$mediaPreviousThumbnail`（blendgradient 第二槽）仍未实现，切歌过渡缺「上一张」，属既有边界（AGENT §7.44），本次未动。
