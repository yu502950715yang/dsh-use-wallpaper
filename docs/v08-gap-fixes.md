# v0.8.1 / v0.8.2 缺口修复：实现细节与实测数据

`AGENT.md` §7.42 的明细。那里只留**边界结论**（哪些不支持、哪些有偏差、判据在哪），机制细节与实测数字放这里。

> 归属：本文件是**当前实现的事实**，不是历史归档。改对应代码时同步这里。设计文档见 `docs/superpowers/specs/2026-10-20-v0.8.1-gap-fixes-design.md` 与 `docs/superpowers/specs/2026-10-22-v0.8.2-visible-fixes-design.md`。

## ① text effects 的隔离尺寸

- `groupEffectsByObject` 不再跳过 text；隔离 RT / 合成 quad 取装配期实测布局 × `|scale|`。
- **源分辨率下限 = 布局 canvas 像素**（热修 2026-10-20）：此前 RT 只按屏占位 ⇒ 小字号 text 在效果链里先被降采样，`blurprecise` 1.3px 相对笔画过强、文字糊成一片。实测 `3660373677` 的 Date/Clock：布局 917×214 / 489×214，屏占位仅 97×22 / 46×20。现与 image 同口径：`isolatedRtSize(world, density, source = 布局尺寸)`，text 仍不进显存预算。
- `threejs-player.update_background` 的 origin 位移落在合成 quad（`parallaxNode`）而非 RT 内容 mesh。

## ② 精灵表帧 UV

- 启动链：材质 `passes[0].combos.spritesheet` + TEXS 帧网格 ⇒ 行优先当前帧 UV，`resizeBackground` 后重写。
- 属性脚本 `update(value)`：传入当前值 Vec3、返回 Vec3-like 写回；`angles/origin/scale` 经 `applyLayerState` 生效（angles 脚本单位是**度**，落 three 转弧度）。
- `color` 自 2026-10-30 起应用到 tint / `MeshBasicMaterial.color`（见 AGENT.md §5.54）。
- canvas 上的 click 监听只服务 e2e/harness —— 生产 GUI 里 canvas 在 `pointer-events:none` 的背景层内，按 2026-10-20 产品决策不做 window 级点击转发。

## ③ bloom 的资源代价

- `bloom-stage.ts` 薄封装 GlowStage，缺省 `strength=2` / `threshold=0.65`；`bloomRT` 是 8-bit RGBA 且带 depthBuffer（`WebGLRenderTarget` 缺省建法，未按需关闭）。
- 每条 bloom 管线 = 一整套 GlowStage（7 张 HalfFloat RT：base 画布缓冲 + 三级 ping-pong ≈ 0.66× base 面积）＋ 每帧 10 个全屏 pass（另加主场景自渲 1 次）。
- bloom + Glow 同开时下游 Glow 读 `bloomRT`、不再自渲，合计约 20 个 pass/帧。
- 亮部口径镜像：`glow-math.ts` ↔ `glow-stage.ts` 的 GLSL 逐式对齐 —— `clamp(max(r,g,b) − t, 0, 1)` + 软膝 `max(base, shoulder(base + glow·strength))`（knee 0.9）。
- 实测 `3817739578`（太阳在左上）：左上 1/4 纯白 21.4% → 9.8%（桌面 WE 同帧 10.1%），全图 6.6% → 2.4%（桌面 2.4%）。
- e2e 只判 `2454403969`（默认 Glow 下 bloom on/off A/B）；`3790775478` / `2937346640` 按 TESTING.md §2.14 V1 人眼验收通过。

## ④ 音频播放

- 曾因依赖 `content-length`（桌面版 GUI 的 `/app/...` 前缀链路下该头不可靠）回退 132MB 整块解码而无声 —— 现统一走 `<audio>` 流式，不看该头。
- `PkgReader` 仍整包常驻内存（147MB 级 pkg）；v0.9 改按需读取。

## ⑤ starttime 预推进成本

- 按 effect 秒前滚，步长 `1/60/rate`，900 步 = 15 effect-s。
- 实测 `2897292240`（maxcount=10000、starttime=10，两个同 spec 对象）：单对象构造中位数约 **155ms**，两个合计约 **0.3s**。

## ⑧ util 层的尺寸口径

- 四类判定在 `scene-json.ts` 的 `utilLayerKind`（按 `image` 文件名；未知 util → fullscreen 降级）。
- project/fullscreen 的居中分支在 `threejs-player.ts` 的 `addBackground`；RT = world × 屏幕密度 = **屏占位、与 world 等比，不是画布缓冲** —— cover 裁切 / 竖构图会拉伸效果 mask，实测 `2597392171` 竖构图 RT = 1920×3000 > 画布 1080。
- compose/solid 的 world = `size × |scale|`（`object-range.ts` 的 `utilWorldSize`）。
- 均**不参与** `fitIsolatedBudget`：挂载期与 resize 期口径一致（resize 只用 `budgeted = image` 条目）。
- 无链 solid 走 `loadSceneToThree` 的 `addBackground(util)` + `createUtilLayerMaterial` 纯色材质，本机唯一命中 `3819637149#200` 的 3px 基线（WE 桌面可见）。
- `passthrough` 内容为白色占位（opacity 0），对象 alpha 落合成 quad（`createLayerMaterial`）；本机 util 全白 / 1，故 color/brightness 只有 solid 有可见差。
- renderOrder = objects 下标穿插；solid 的 `0 < alpha < 1` 存在 alpha²（T3 遗留）。

## ⑨ 段渲染的实际成本

- 2911105183 有 5 个消费者 ⇒ **6 段/帧**，frameRT 无 MSAA。
- headless 1080p 强制 SwiftShader（**非真机**）：291 / 213 / 259 = 404 / 222 / 2578 ms/帧 ≈ 2.5 / 4.5 / 0.4 fps。
- 默认 headless 在本机落 D3D11 RTX 3060 时 60fps 封顶，render 2.0 / 1.0 / 1.2 ms ⇒ 真机 ≥30fps 已按 TESTING.md §2.15 V10 人眼验收通过（量化 FPS 未记录）。

## ⑩ text 字段的 e2e 证据

- alpha 落内容材质的验证：291 changed 1107px / 246 changed 34366px；内容 opacity 0.93 / 0 / 0.82，合成 quad 恒 1（避免了 a²）。
- brightness 的实现位置：`src/client/text-object.ts:312-320`（canvas LDR 近似，clamp ≤4）。
- anchor 语义按 TESTING.md §2.15 V7 人眼验收通过（样本 `1922570576` / `2937346640`）。
- limitwidth/maxwidth 的单位按 §2.15 人眼验收通过、未量化；实现在 `src/client/text-object.ts:130-139`。

## ⑫ 全局 uniform 的推导依据

- `g_PointerPosition` 归一化 [0,1]、y 向下：按 `3780477933` 的 shader 实测（写入点 `src/client/effect-runner.ts` 的 `applyGlobalUniforms`）。
- 该样本原样素材**无可见差**（作者常量把效果关成 no-op），像素链路由服务端 defaults 变体证明（Default Circle Size=0.3 + opacitymask=util/white）。
- `g_ParallaxPosition` 的公式（`src/client/parallax.ts` 的 `effectPointerUniforms`）是**有据假设**：`cameraparallax={user,value:true}` 已被解析（`scene-json.ts` + `user-bindings.ts`），`3118949804` 的 `parralax` 默认 true ⇒ 可用来量化校准（目前只做过人眼验收，TESTING.md §2.15 V11）。
- 该壁纸有行为变化：binder 旧默认 `[0,0]` → 新 `[0.5,0.5]`（旧值被 shader 当 −1 偏移）。

## ⑭ 静态隐藏对象的样本

- 全库静态布尔 `visible:false` 的 image 仅 `2832263418` 的 `all_fg_still`。
- `1922570576#55` 等是 script 绑定 false，按 §5.38 不在装载期跳过（保持可点亮）。

## ⑮ 音频竖条的样本

- 验证样本 `2832263418`（EVA 卡农）：`u_BarColor` 的显示颜色见 ⑯（`BLENDMODE=0` 映射后为内容色）。
- `copybackground` 仍缺；`chromatic_aberration` pass 仍编译失败被跳过（不影响 bars）。

## ⑯ 着色分叉的影响面

- 本机 43 张 scene.pkg 扫描：`cb≠0` 且 color 非中性共 **5 对象 / 4 壁纸**。
- 其中 2 个是 `{user}` 绑定（`2832263418` audio_rainbow、`3797976859` Album Cover Frame），3 个静态（`3828798871` 云 2 + `2460786246` Clock）。
- `2911105183` 的 music bar 与 ⑮ 同效果。

## ⑰ visualizer 的实现要点

- 64 条 bar：宽 = `barWidth × 图宽`、底部对齐 `origin.y`；贴图 = 对象自身 image 的白色 4×4 纹理；频谱 64 bins，无音频 → 高度 0。
- `pixel-bars` 家族的 props：`visualizerResolution` / `visualizerBarPath` / `minBarHeight`；本机样本 `3118949804` 的 `3007895627` 脚本。
- 系统音频：独立 AudioContext → analyser → 静音 gain（不重复出声），频谱**优先于**包内 sound 驱动 visualizer 与效果 uniform；停止共享即清理。

## ⑱ 云雾 tint 的量化

- `3828798871` 的 Clouds Front 两层：object 348 / 656，`colorBlendMode=7`，作者静态深红 / 浅褐 color。
- 把作者静态色烘进内容后：前景雾带亮度 **55.3 → 45.4**（WE 真机同相位 **48.8**）、`(r−g)` **17.0 → 21.5**（WE **21.7**）；左下雾 24.9 → 20.5（WE 20.3）。
