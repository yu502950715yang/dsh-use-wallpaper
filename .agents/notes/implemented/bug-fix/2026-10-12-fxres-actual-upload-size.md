# Agent Note: `g_TextureNResolution` 上报实际上传尺寸（比值恒为 1）

Status: implemented

## Problem

壁纸 shader 用 `g_TextureNResolution` 的 `.z/.x`（与 `.w/.y`）把对象 UV 映射到遮罩纹理的空间里，例如 `cropToMap`。在 WE 的语义里，这个比值是**内容尺寸 / 分配尺寸 ≤ 1** —— 因为 WE 按纹理头里的分配尺寸（含 padding）上传，图和分配空间不是同一块。

本插件**不按 `.tex` 头做 padding 分配**：解码出来多少像素就上传多少。于是同一个比值必须恒为 **1**。旧实现把 `.tex` 头里的**分配尺寸**填进了 `Resolution`，比值随即变成 ≈0.58–0.61 ⇒ 遮罩被压缩 **1.64–1.71×**，真机表现是「魔兽之门」的湖水波动跑到树线上。

## Decision

`g_TextureNResolution`（`tex.userData.fxRes`）由 `tex-loader.ts` 的 `withSprite` **唯一写入**，取**各分支实际上传的宽高**：

- 视频纹理：`videoWidth/videoHeight`（为 0 时回退到 mip0 记录）；
- 编码图像：解码后的尺寸；
- raw：裁剪后尺寸（`cropToMap` / `cropRowsToMap`）；
- DXT：`ceil4` 块对齐后的尺寸。

**四个分量一律同值** ⇒ `.z/.x === 1` 恒成立（这正是"没做 padding"应有的口径）。代价是**零额外请求**：材质 JSON 本来就在手上，只改填哪个数。判据是 `tests/` 的通道保真用例与 e2e 的「`z/x === 1` 且偏离必须为 0」。

## 涉及仓库

- `dsh-use-wallpaper` 分支 `master` commits `51a3b4f` `cdbdd56`

## Alternatives considered

**方案 B：真的按 `.tex` 头的分配尺寸做 padding 上传。** 理由：语义上最忠实 —— WE 就是这么干的，shader 里的 `.z/.x` 自然正确，一行 shader 都不用改。不用它是因为代价与刚做完的显存优化直接冲突：每张遮罩按分配尺寸上传约 **+24 MB**，超大背景可达 **+80~130 MB**。

**混合方案：只对「按 padding 语义使用 `.z/.x`」的纹理走 B。** 理由：精确到纹理，既不全局涨显存又能满足所有真实用法。不用它是因为库级 40 种用法里**未发现**这样的纹理 —— 也就是说，这条分支不会有消费者，纯增复杂度。

**只保证四分量同值，不取实际上传尺寸。** 理由：改动最小，`z/x === 1` 这条判据也满足。不用它是因为 B/C/D 类把 `.x/.y` / `.z/.w` 当尺寸用的写法仍会拿到偏 ≈1.6× 的 texel 步长；被本方案取代。

**顺带做 v 轴全量迁移。** 理由：既然在改纹理口径，不如一次把 v 轴约定也对齐 WE。不用它是因为那是跨 4–8 个显示采样点的改动，漏一处就是整图上下颠倒（`AGENT.md` §5.20 明确要求只做窄修）。

## Consequences

**收益：** 遮罩回到正确位置（真机目视：湖水波动回到湖面）；口径变成"可判定的不变量"——`z/x === 1` 可以在 e2e 里逐槽断言，偏离必须为 0。

**代价：** ① `fxRes` **无法表达「内容域偏移」**（WE 的语义其实是 `(内容宽, 内容高, 打包宽, 打包高)` 四元，本实现每分支只报一个 `(w,h)` 对）⇒ `cropToMap` 对 sprite 位**刻意不裁**是满足该不变量的唯一例外，这条差距留在代码注释里而不是被掩盖；② DXT 的 `ceil4` 块对齐会让 `fxRes` 比重内容宽高**多出至多 3 像素**（本机库 0 实例，只在单测 fixture 出现）；③ 本项目当前**数值影响为 0**：把 `.x/.y` / `.z/.w` 当尺寸用的用法逐条都落在 `g_Texture0`，而 slot 0 每帧被绑成 pass 输入 RT、走"无 `fxRes` ⇒ `{x:w,y:h,z:w,w:h}`"的回退；唯一 slot≥1 的尺寸用法（`3780477933` 的 `min(.w,.z)`）落在 POT 纹理上、比值本就为 1 ⇒ 这次修的是**口径**，不是当下可见的差异。

设计与实测见 [效果遮罩 UV NPOT 设计](../../../../docs/superpowers/specs/2026-10-12-mask-uv-npot-design.md) 与 [fxRes 实际上传尺寸设计](../../../../docs/superpowers/specs/2026-10-12-fxres-actual-upload-size-design.md)。
