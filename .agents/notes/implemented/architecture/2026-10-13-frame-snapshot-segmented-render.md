# Agent Note: 段渲染 + 帧内快照实现 `_rt_FullFrameBuffer`

Status: implemented

## Problem

WE 的效果与粒子能**读「到这一刻为止本帧已经画了什么」**：这是场景 FBO 本身（`_rt_FullFrameBuffer`）。lwe 的实现是按 `m_objectsByRenderOrder` **逐个对象 `render()`**，粒子的 REFRACT 分支在画该层**之前**把场景 FBO blit 到副本再采样（`CParticle.cpp`）—— 于是「玻璃水滴」是折射背景的结果。

本仓库的渲染是**一次性整场景 `renderer.render()`**：这个中间态根本不存在。后果是引用了该槽的内容全部静默失效，且**退化成可见的错误**而不是缺失 —— 壁纸 `2897292240` 的雨层在 DSH 里被画成满屏不透明白方块/白竖条，而 WE 里是几乎看不见的雨痕。同一批受影响的还有效果链消费点（`2597392171` 的 `godrays`，半透明区被压黑）。

## Decision

把「一次性整场景 render」改成**按 WE 对象序切段渲染 + 消费者段边界拍帧内快照**：

- **`renderOrder` 唯一化**：每个可渲染对象按其 `scene.json` objects 下标分配**全局唯一** `renderOrder`，取代原先 `image=0` / `particle=1` 的硬编码二分 —— three 的提交顺序由此等于 WE 的对象序（全库 34/34 与 `objects` 数组序一致）。
- **段骨架**：段数 = 消费者数 + 1；仅首段之前对帧目标清屏一次，其余段在 `try/finally` 里临时关 `autoClear` 累积；末段把帧目标全屏合成回默认 framebuffer（Glow 开启时改为交给 `glowStage.apply`）。帧目标用**画布缓冲尺寸**、UnsignedByte，与默认 fb 同色彩域（不标 sRGB）。
- **快照**：`frame-capture.ts` 用 `THREE.FramebufferTexture` + `renderer.copyFramebufferToTexture()`，在消费者**被绘制之前**拍一张「到这一刻为止已画进帧目标的内容」。`capture()` 逐个消费者调用、逐帧覆盖；快照语义 = WE 的场景 FBO。
- **惰性即零回归**：无消费者（无 REFRACT 粒子、无引用该槽的 util 内容层）时**完全走原路径** —— 不建帧目标、不切段、不合成，调用序列与改动前逐字节一致（单测钉住）。
- **粒子 REFRACT**：判据只认 WE 权威 combo `passes[0].combos.REFRACT === 1`（全库只有 `2897292240` 的一支材质命中），槽 1 当法线遮罩，片元照 `genericparticle.frag` 逐行采样快照做位移。槽 1 缺失或加载失败时**该层不可见**，绝不回退成白方块。
- **对象链消费点门控关闭**：`object-effects.ts` 的 `ENABLE_CHAIN_FRAME_SNAPSHOT_CONSUMER = false`（v0.8.2 起 util 内容层经 `allowFrameSnapshot` 可绑定该槽，对象链仍关闭）。原因是该路径从未真机验收，且结构上明确反向 —— 对象链的贴屏 quad UV 覆盖**对象窗口**，快照却是**整画布**（v 约定还反向一次），直采会错位。能力（`resolveBuiltinTexture(path, frameTexture?)`、`planSamplesFrameSnapshot`、`onSegmentBoundary` 宿主契约）与单测全部保留，等 UV 口径验证后再开。

**成本量级必须说清**：段渲染是「**每段一次全场景 `render`**，靠 `visible` 排除其它段」⇒ **O(段数 × 场景)**，**不是**「每对象只光栅化一次」。实测 `2897292240` 每帧 3 次全场景 render + 2 次 blit + 1 次 composite（改动前 1 次）。

## Affected repositories

- `dsh-use-wallpaper` 分支 `master` commits `7a5185d` `4f13857`

## Alternatives considered

**用 `camera.layers` 分层渲进各自的 RT。** 理由：three 原生能力，切段不用自己维护 `visible` 开关。不用它是因为会污染隔离路径的 `localCamera`（对象 RT 变空白），而隔离体系是不能动的既有契约。

**用多个 `THREE.Scene` 表示各段。** 理由：段之间天然隔离，不必反复切 `visible`。不用它是因为会破坏 `player.scene` 作为统一 parent 的契约 —— 现有很多逻辑（puppet、视差、粒子）按「所有显示对象都在同一 scene 里」遍历。

**每段渲进自己的一张 RT（per-segment RT）。** 理由：读写天然分离，省掉 `copyFramebufferToTexture` 的反馈顾虑。不用它是因为贵一档（每段一张画布尺寸 RT），而 r170 的 `FramebufferTexture` 路径可用；这条保留为**退化方案** —— 若目标 GPU 上该路径不可用就切过来。

**先上「临时近似版」：拿槽 1（`halo_50_1` 的法线纹理）当形状画出来。** 理由：改动最小，立刻能看见水滴。不用它是因为会**画出 WE 里没有的内容** —— WE 的可见部分来自折射背景，不是那根细丝遮罩；宁可不画，也不能画错。

**段划分改成「消费者独占一段（前后各切一刀）」。** 执行中期真按这个做过，理由是「相邻消费者时后一个的快照会缺前一个已画的内容」。它在评审时被推翻：那种切法的实际段数是 **2N+1**（不是当时记的 N+1），而且**支撑理由不成立** —— 正确的对齐点是「快照拍在该消费者段 `render()` **之前**」，这一点在 N+1 切法下同样成立。

## Consequences

**收益：** `2897292240` 的雨层白块/白竖条消失、出现水滴/雨痕（真机目视确认，GLSL 真机编译通过）；渲染色序从此与 WE 对象序一致，顺带修正了原先 `image=0/particle=1` 二分造成的层序偏差；无消费者路径结构性零回归（单测钉住调用序列）。

**代价：** ① 段渲染成本随消费者数**线性增长且每段遍历整个场景**（`visible` 只省光栅化，不省遍历与提交），"半分辨率帧目标"这个优化项因此**不能凭感觉做**，得先有真机帧时数据（本轮无数据）；② `renderOrder` 唯一化让 9 个「粒子在前、image 在后」的 pkg 叠加次序变化 —— 这是**对齐 WE 的可见变更，验收时不得当回归**；③ 效果链消费点仍关闭，`2597392171` 维持改动前行为；④ **零回归当前只有单测证据**：本轮**没有执行**真机逐像素对拍（判据已订正为「同一张壁纸注入/不注入 `frameCapture` 两配置对拍」，因为原来选的 `3793620838` 本身就在次序会变的那 9 个 pkg 里，原理上不可能通过）；⑤ 快照只有一张，多消费者会同帧别名到同一张（本轮只有 1 个消费者；v0.8.2 起 util 内容层也会注册消费者，单帧可多个，`2911105183` 最多 5 个 ⇒ 6 段/帧）；`resize` 与异步 `update` 的竞争只是**收窄**、未清零。

设计的 Ruling 清单、逐项偏差与未做项见 [帧内快照与粒子 REFRACT 设计](../../../../docs/superpowers/specs/2026-10-13-frame-capture-refract-design.md)；它建立在 [three.js 是 scene 的唯一渲染路径](2026-09-08-threejs-single-render-path.md) 这条前提上。
